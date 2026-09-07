import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { channelEnvelopeSchemaV1 } from "openclaw/plugin-sdk/channel-inbound";
import {
  changedIncoming,
  commonAttemptRecord,
  copy,
  deferred,
  digest,
  eventLookup,
  incomingLookup,
  journalHarness,
  journalScopeCompatibilityCases,
  journalValues,
  logicalLookup,
  ref,
  seedJournalOwner,
} from "../fixtures/turn-journal-storage/values.mjs";
import {
  parseRejectedAdmissionV1,
  parseTurnJournalResultV1,
  parseTurnJournalV1,
} from "../../packages/contracts/src/turn-journal-v1.ts";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const options = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL for migrated limited-role PostgreSQL turn journal storage integration.",
  timeout: 120_000,
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const same = (actual, expected) => assert.deepEqual(plain(actual), plain(expected));
const valueOf = (result) => {
  assert.equal(result.kind, "committed");
  return result.value;
};
const admit = (h, v) =>
  h.write((j) => j.admit(h.issue("admission", v.observation), h.call)).then(valueOf);
const dispatch = (h, v) =>
  h.write((j) => j.recordDispatchIntent(h.issue("dispatch", v.binding), h.call)).then(valueOf);
const consume = (h, v) =>
  h
    .write((j) =>
      j.consumeAttempt(
        h.issue("consumption", { operation: v.consumption, binding: v.binding }),
        h.call,
      ),
    )
    .then(valueOf);

// The real repository and database are under test. Controlled provenance ports
// supply storage observations only; this suite does not certify AUT/UPS owners.
test(
  "PostgreSQL turn journal preserves ownership, lifecycle and finite storage",
  options,
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 8,
      connectionTimeoutMillis: 250,
    });
    t.after(() => pool.end());

    await t.test(
      "accepted duplicates precede busy, logical twins get exact incoming links, and changed identities conflict",
      async () => {
        const h = journalHarness(pool);
        const owner = await seedJournalOwner(h.state);
        const v = journalValues(owner);
        const original = await admit(h, v);
        assert.equal(original.kind, "recorded");
        assert.equal(original.record.decision.kind, "accepted");
        assert.equal(original.duplicate, false);
        const common = await h.read((j) => j.findAttempt(v.attempt, h.call));
        assert.equal(common.kind, "found");
        same(common.record, commonAttemptRecord(v));
        const firstAttempt = (
          await pool.query(
            "SELECT version,record,first_received_at,reservation FROM occ.turn_journal_attempts WHERE agent_id=$1",
            [v.context.agentRef],
          )
        ).rows[0];
        assert.equal(firstAttempt.first_received_at.getTime(), Date.parse(v.envelope.receivedAt));
        same(
          (await h.read((j) => j.findAdmission(eventLookup(v), h.call))).record,
          original.record,
        );

        const duplicate = await admit(
          h,
          changedIncoming(v, () => {}),
        );
        assert.equal(duplicate.kind, "recorded");
        same(duplicate.incomingLink, original.incomingLink);
        same(duplicate.record, original.record);
        same((await h.read((j) => j.findAttempt(v.attempt, h.call))).record, common.record);
        same(
          (
            await pool.query(
              "SELECT version,record,first_received_at,reservation FROM occ.turn_journal_attempts WHERE agent_id=$1",
              [v.context.agentRef],
            )
          ).rows[0],
          firstAttempt,
        );
        const twin = changedIncoming(v, (incoming) => {
          incoming.envelope.event.providerEventRef = ref("event-twin");
        });
        assert.equal(
          (await h.read((j) => j.findIncomingLink(incomingLookup(twin.identity), h.call))).kind,
          "absent",
        );
        const duplicated = await admit(h, twin);
        assert.equal(duplicated.duplicate, true);
        assert.equal(duplicated.incomingLink.disposition, "duplicate");
        const linked = await h.read((j) =>
          j.findIncomingLink(incomingLookup(twin.identity), h.call),
        );
        assert.equal(linked.kind, "found");
        same(linked.original, original.record);
        const changedTwin = changedIncoming(twin, (incoming) => {
          incoming.envelope.message.providerMessageRef = ref("changed-twin-logical-message");
        });
        const changedTwinResult = await admit(h, changedTwin);
        assert.equal(changedTwinResult.kind, "conflict");
        assert.deepEqual(changedTwinResult.incomingLink.originalReceiptRefs, [
          original.record.identity.receipt.receiptRef,
        ]);
        same(
          (await h.read((j) => j.findAdmission(eventLookup(twin), h.call))).record,
          original.record,
        );

        for (const change of [
          (incoming) => {
            incoming.identity.principalRef = ref("changed-principal");
          },
          (incoming) => {
            incoming.envelope.message.contentDigest = digest();
          },
          (incoming) => {
            incoming.identity.replyDestinationRef = ref("changed-destination");
          },
        ]) {
          const changed = changedIncoming(v, change);
          const conflict = await admit(h, changed);
          assert.equal(conflict.kind, "conflict");
          assert.equal(conflict.incomingLink.disposition, "conflict");
          const exact = await h.read((j) =>
            j.findIncomingLink(incomingLookup(changed.identity), h.call),
          );
          assert.equal(exact.kind, "found");
          same(exact.original, original.record);
        }
        const independent = journalValues(owner);
        const busy = await admit(h, independent);
        assert.equal(busy.record.decision.kind, "busy");
        assert.equal((await admit(h, independent)).record.decision.kind, "busy");
        assert.equal(
          (await h.read((j) => j.findAttempt(independent.attempt, h.call))).kind,
          "absent",
        );
      },
    );

    await t.test("event and logical keys with different owners retain both originals", async () => {
      const h = journalHarness(pool);
      const owner = await seedJournalOwner(h.state);
      const first = journalValues(owner);
      const second = changedIncoming(first, (incoming) => {
        incoming.envelope.event.providerEventRef = ref("event-second");
        incoming.envelope.message.providerMessageRef = ref("message-second");
      });
      const a = await admit(h, first);
      const b = await admit(h, second);
      assert.equal(b.record.decision.kind, "busy");
      const bridge = changedIncoming(first, (incoming) => {
        incoming.envelope.message = copy(second.envelope.message);
      });
      const result = await admit(h, bridge);
      assert.equal(result.kind, "conflict");
      assert.deepEqual(
        new Set(result.incomingLink.originalReceiptRefs),
        new Set([a.record.identity.receipt.receiptRef, b.record.identity.receipt.receiptRef]),
      );
      same((await h.read((j) => j.findAdmission(eventLookup(first), h.call))).record, a.record);
      same((await h.read((j) => j.findAdmission(logicalLookup(second), h.call))).record, b.record);
      assert.equal(
        (await h.read((j) => j.findIncomingLink(incomingLookup(bridge.identity), h.call))).kind,
        "found",
      );
    });

    await t.test(
      "accepted scope extensions survive guarded admission, dispatch, consumption and terminal publication",
      async () => {
        const h = journalHarness(pool);
        const run = (work) => {
          const call = h.provenance.call();
          return h.write((journal) => work(journal, call), call).then(valueOf);
        };
        for (let index = 0; index < 5; index++) {
          const v = journalValues(await seedJournalOwner(h.state));
          const { name, extra } = journalScopeCompatibilityCases(v)[index];
          v.identity.workspace.scope = { ...v.identity.workspace.scope, extra: copy(extra) };
          v.reservation.scope = { ...v.reservation.scope, extra: copy(extra) };
          const before = copy(v);
          parseTurnJournalV1("attempt", commonAttemptRecord(v));
          if (name === "nested SDK rejection") {
            const normalized = channelEnvelopeSchemaV1.safeParse(extra.envelope);
            assert.equal(normalized.success, true);
            assert.equal(Object.hasOwn(normalized.data, "retryMetadata"), false);
            const retained = parseRejectedAdmissionV1(extra);
            assert.equal(Object.hasOwn(retained.envelope, "retryMetadata"), true);
            same(retained.envelope.retryMetadata, {});
          }
          const admission = await run((j, call) =>
            j.admit(h.issue("admission", v.observation), call),
          );
          assert.equal(admission.record.decision.kind, "accepted", name);
          const readCall = h.provenance.call();
          same(
            (await h.read((j) => j.findAttempt(v.attempt, readCall), readCall)).record,
            commonAttemptRecord(v),
          );
          const projection =
            "SELECT (record#>'{binding,identity,workspace,scope}')::text AS workspace_scope,(record#>'{binding,reservation,scope}')::text AS reservation_scope,reservation::text AS original_reservation FROM occ.turn_journal_attempts WHERE attempt_ref=$1";
          const originalScopes = (await pool.query(projection, [v.attempt.attemptRef])).rows;
          const intent = await run((j, call) =>
            j.recordDispatchIntent(h.issue("dispatch", v.binding), call),
          );
          assert.equal(intent.kind, "recorded");
          assert.equal(intent.record.version, 2);
          assert.equal(
            (await run((j, call) => j.recordDispatchIntent(h.issue("dispatch", v.binding), call)))
              .kind,
            "existing",
          );
          assert.equal(
            (
              await run((j, call) =>
                j.consumeAttempt(
                  h.issue("consumption", { operation: v.consumption, binding: v.binding }),
                  call,
                ),
              )
            ).kind,
            "claim-pending",
          );
          const terminal = await run((j, call) =>
            j.recordOutcome(h.issue("outcome", v.outcome), call),
          );
          assert.equal(terminal.kind, "recorded");
          assert.equal(terminal.record.version, 4);
          same(terminal.record.binding.identity.workspace.scope.extra, extra);
          same(terminal.record.binding.reservation.scope.extra, extra);
          assert.deepEqual(
            (await pool.query(projection, [v.attempt.attemptRef])).rows,
            originalScopes,
          );
          same(
            (await run((j, call) => j.admit(h.issue("admission", v.observation), call))).record,
            admission.record,
          );
          assert.equal(
            (await run((j, call) => j.releaseReservation(h.issue("release", v.release), call)))
              .kind,
            "released",
          );
          same(v, before);
        }
      },
    );

    await t.test(
      "actual SDK normalization leaves empty retry metadata retained in the rejected owner",
      async () => {
        const h = journalHarness(pool);
        const v = changedIncoming(journalValues(await seedJournalOwner(h.state)), (incoming) => {
          incoming.envelope.retryMetadata = {};
        });
        const original = copy(v.rejected);
        const normalized = channelEnvelopeSchemaV1.safeParse(v.rejected.envelope);
        assert.equal(normalized.success, true);
        assert.equal(Object.hasOwn(normalized.data, "retryMetadata"), false);
        same(parseRejectedAdmissionV1(v.rejected).envelope.retryMetadata, {});
        const recorded = valueOf(
          await h.write((j) => j.admitRejected(h.issue("rejected", v.rejected), h.call)),
        );
        assert.equal(recorded.kind, "recorded");
        assert.equal(recorded.incomingLink.disposition, "original");
        assert.deepEqual(recorded.incomingLink.originalReceiptRefs, [original.receipt.receiptRef]);
        same(recorded.record, original);
        same(parseTurnJournalResultV1("rejectedAdmissionResult", recorded), recorded);
        const ownership = async () => {
          const scope = [v.locator.installationRef, v.locator.channelInstallationRef];
          return {
            owners: (
              await pool.query(
                "SELECT * FROM occ.turn_journal_owners WHERE installation_id=$1 AND channel_installation_id=$2 ORDER BY receipt_ref",
                scope,
              )
            ).rows,
            keys: (
              await pool.query(
                "SELECT * FROM occ.turn_journal_keys WHERE installation_id=$1 AND channel_installation_id=$2 ORDER BY key_kind,key_digest",
                scope,
              )
            ).rows,
            links: (
              await pool.query(
                "SELECT * FROM occ.turn_journal_incoming_links WHERE installation_id=$1 AND channel_installation_id=$2 ORDER BY incoming_link_ref",
                scope,
              )
            ).rows,
            attempts: (
              await pool.query(
                "SELECT * FROM occ.turn_journal_attempts WHERE installation_id=$1 AND channel_installation_id=$2 ORDER BY attempt_ref",
                scope,
              )
            ).rows,
          };
        };
        const readExactLink = async (link) => {
          // Use the original rejected result's own exact tuple; an accepted
          // identity digest would describe a different incoming observation.
          const state = await h.read((j) =>
            j.findIncomingLink(
              {
                locator: link.locator,
                incomingIdentityDigest: link.incomingIdentityDigest,
                incomingEventDigest: link.incomingEventDigest,
                incomingContentDigest: link.incomingContentDigest,
              },
              h.call,
            ),
          );
          assert.equal(state.kind, "found-rejected");
          same(state.link, link);
          same(state.original, original);
          same(parseTurnJournalResultV1("incomingLink", state), state);
        };
        const firstRows = await ownership();
        assert.equal(firstRows.owners.length, 1);
        assert.equal(firstRows.keys.length, 2);
        assert.equal(firstRows.links.length, 1);
        assert.equal(firstRows.attempts.length, 0);
        await readExactLink(recorded.incomingLink);
        const existing = valueOf(
          await h.write((j) => j.admitRejected(h.issue("rejected", v.rejected), h.call)),
        );
        assert.equal(existing.kind, "existing");
        same(existing.record, original);
        same(existing.incomingLink, recorded.incomingLink);
        assert.equal(existing.incomingLink.disposition, "original");
        same(parseTurnJournalResultV1("rejectedAdmissionResult", existing), existing);
        await readExactLink(existing.incomingLink);
        same(await ownership(), firstRows);

        const twin = changedIncoming(v, (incoming) => {
          incoming.envelope.event.providerEventRef = ref("rejected-event-twin");
        });
        assert.notEqual(twin.rejected.receipt.eventKey, original.receipt.eventKey);
        assert.equal(twin.rejected.receipt.logicalMessageKey, original.receipt.logicalMessageKey);
        same(twin.rejected.envelope.retryMetadata, {});
        const duplicate = valueOf(
          await h.write((j) => j.admitRejected(h.issue("rejected", twin.rejected), h.call)),
        );
        assert.equal(duplicate.kind, "existing");
        assert.equal(duplicate.incomingLink.disposition, "duplicate");
        assert.notEqual(
          duplicate.incomingLink.incomingLinkRef,
          recorded.incomingLink.incomingLinkRef,
        );
        assert.equal(duplicate.incomingLink.locator.eventKey, twin.rejected.receipt.eventKey);
        assert.deepEqual(duplicate.incomingLink.originalReceiptRefs, [original.receipt.receiptRef]);
        same(duplicate.record, original);
        same(parseTurnJournalResultV1("rejectedAdmissionResult", duplicate), duplicate);
        await readExactLink(duplicate.incomingLink);
        await readExactLink(recorded.incomingLink);
        const twinRows = await ownership();
        same(twinRows.owners, firstRows.owners);
        same(twinRows.keys, firstRows.keys);
        same(twinRows.attempts, firstRows.attempts);
        assert.equal(twinRows.links.length, 2);
        same(
          twinRows.links.find(
            (row) => row.incoming_link_ref === recorded.incomingLink.incomingLinkRef,
          ),
          firstRows.links[0],
        );
        const repeatedTwin = valueOf(
          await h.write((j) => j.admitRejected(h.issue("rejected", twin.rejected), h.call)),
        );
        same(repeatedTwin, duplicate);
        same(parseTurnJournalResultV1("rejectedAdmissionResult", repeatedTwin), repeatedTwin);
        same(await ownership(), twinRows);
        await readExactLink(repeatedTwin.incomingLink);
        for (const lookup of [eventLookup(twin), logicalLookup(twin)]) {
          const owner = await h.read((j) => j.findRejectedAdmission(lookup, h.call));
          assert.equal(owner.kind, "found");
          same(owner.record, original);
          same(parseTurnJournalResultV1("rejectedAdmissionState", owner), owner);
        }
        same(
          (await h.read((j) => j.findRejectedAdmission(eventLookup(v), h.call))).record,
          original,
        );
        assert.equal((await h.read((j) => j.findAttempt(v.attempt, h.call))).kind, "absent");
        same(v.rejected, original);
      },
    );

    await t.test(
      "actual backend codecs refuse malformed nested consumption before publishing ownership",
      async () => {
        const h = journalHarness(pool);
        for (const consumption of [1, true]) {
          const v = journalValues(await seedJournalOwner(h.state));
          const extra = { binding: {}, outcome: {}, consumption };
          v.identity.workspace.scope = { ...v.identity.workspace.scope, extra: copy(extra) };
          v.reservation.scope = { ...v.reservation.scope, extra: copy(extra) };
          assert.throws(() => parseTurnJournalV1("attempt", commonAttemptRecord(v)));
          assert.equal(
            (await h.write((j) => j.admit(h.issue("admission", v.observation), h.call))).kind,
            "unavailable",
          );
          assert.equal((await h.read((j) => j.findAttempt(v.attempt, h.call))).kind, "absent");
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS count FROM occ.turn_journal_owners WHERE installation_id=$1 AND channel_installation_id=$2 AND receipt_ref=$3",
                [v.context.installationRef, v.locator.channelInstallationRef, v.receipt.receiptRef],
              )
            ).rows[0].count,
            0,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS count FROM occ.turn_journal_reservations WHERE agent_id=$1",
                [v.context.agentRef],
              )
            ).rows[0].count,
            0,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS count FROM occ.turn_journal_operations WHERE agent_id=$1",
                [v.context.agentRef],
              )
            ).rows[0].count,
            0,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS count FROM occ.turn_journal_incoming_links WHERE installation_id=$1 AND channel_installation_id=$2 AND event_key=$3",
                [v.context.installationRef, v.locator.channelInstallationRef, v.locator.eventKey],
              )
            ).rows[0].count,
            0,
          );
        }
      },
    );

    await t.test(
      "rejected and non-turn originals remain negative and related events never seize parent ownership",
      async () => {
        const h = journalHarness(pool);
        const owner = await seedJournalOwner(h.state);
        const denied = journalValues(owner);
        const rejected = valueOf(
          await h.write((j) => j.admitRejected(h.issue("rejected", denied.rejected), h.call)),
        );
        assert.equal(rejected.kind, "recorded");
        assert.equal(Object.hasOwn(rejected.record, "identity"), false);
        assert.equal((await admit(h, denied)).kind, "rejected-existing");
        assert.equal(
          (await h.read((j) => j.findRejectedAdmission(eventLookup(denied), h.call))).kind,
          "found",
        );
        assert.equal((await h.read((j) => j.findAttempt(denied.attempt, h.call))).kind, "absent");
        const rerouted = changedIncoming(denied, (incoming) => {
          incoming.envelope.nativeConversation.rootThreadRef = ref("changed-root-thread");
        });
        const reroutedResult = valueOf(
          await h.write((j) => j.admitRejected(h.issue("rejected", rerouted.rejected), h.call)),
        );
        assert.equal(reroutedResult.kind, "conflict");
        assert.equal(reroutedResult.incomingLink.disposition, "conflict");
        same(
          (await h.read((j) => j.findRejectedAdmission(eventLookup(denied), h.call))).record,
          rejected.record,
        );

        const nonTurn = journalValues(owner);
        const intake = {
          ...nonTurn.nonTurn,
          eventKey: nonTurn.locator.eventKey,
          eventDigest: nonTurn.receipt.eventDigest,
          classification: "unaddressed-original",
          logicalMessage: {
            kind: "equivalent-original",
            logicalMessageKey: nonTurn.locator.logicalMessageKey,
          },
        };
        const ignored = valueOf(
          await h.write((j) => j.admitNonTurn(h.issue("nonTurn", intake), h.call)),
        );
        assert.equal(ignored.kind, "recorded");
        assert.equal((await admit(h, nonTurn)).kind, "non-turn-owned");
        assert.equal(
          valueOf(
            await h.write((j) => j.admitRejected(h.issue("rejected", nonTurn.rejected), h.call)),
          ).kind,
          "non-turn-owned",
        );
        assert.equal(
          (await h.read((j) => j.findAdmission(logicalLookup(nonTurn), h.call))).kind,
          "found-non-turn",
        );
        assert.equal((await h.read((j) => j.findNonTurnIntake(intake, h.call))).kind, "found");
        assert.equal(
          (await h.read((j) => j.findNonTurnIntake({ ...intake, eventDigest: digest() }, h.call)))
            .kind,
          "not-found",
        );
        const related = {
          ...nonTurn.nonTurn,
          eventKey: digest(),
          classification: "reaction",
          logicalMessage: {
            kind: "related-only",
            logicalMessageKey: denied.locator.logicalMessageKey,
          },
        };
        const relatedResult = valueOf(
          await h.write((j) => j.admitNonTurn(h.issue("nonTurn", related), h.call)),
        );
        assert.equal(relatedResult.receipt.disposition, "ignored");
        assert.notEqual(relatedResult.receipt.receiptRef, rejected.record.receipt.receiptRef);
        const typing = {
          ...related,
          eventKey: digest(),
          classification: "typing-control",
          logicalMessage: { kind: "not-applicable" },
        };
        assert.equal(
          valueOf(await h.write((j) => j.admitNonTurn(h.issue("nonTurn", typing), h.call))).kind,
          "recorded",
        );
        assert.equal(
          valueOf(await h.write((j) => j.admitNonTurn({}, h.call))).kind,
          "not-responsible",
        );
        same(
          (await h.read((j) => j.findAdmission(logicalLookup(denied), h.call))).record,
          rejected.record,
        );
        const counts = await pool.query(
          "SELECT (SELECT count(*) FROM occ.turn_journal_attempts WHERE agent_id=$1)::int AS attempts, (SELECT count(*) FROM occ.turn_journal_reservations WHERE agent_id=$1)::int AS reservations",
          [owner.agent.id],
        );
        assert.deepEqual(counts.rows[0], { attempts: 0, reservations: 0 });
      },
    );

    await t.test(
      "independent clients race one Agent reservation and one canonical consumption",
      async () => {
        const h = journalHarness(pool);
        const owner = await seedJournalOwner(h.state);
        const values = [journalValues(owner), journalValues(owner)];
        const otherPool = new pg.Pool({
          connectionString: databaseUrl,
          max: 3,
          connectionTimeoutMillis: 250,
        });
        try {
          const contender = journalHarness(otherPool, { provenance: h.provenance });
          const results = await Promise.all([admit(h, values[0]), admit(contender, values[1])]);
          assert.deepEqual(results.map((result) => result.record.decision.kind).sort(), [
            "accepted",
            "busy",
          ]);
          const winner =
            values[results.findIndex((result) => result.record.decision.kind === "accepted")];
          const intent = parseTurnJournalResultV1("dispatchIntent", await dispatch(h, winner));
          assert.equal(intent.kind, "recorded");
          assert.equal(intent.record.version, 2);
          assert.equal(intent.record.consumption, null);
          assert.equal(intent.record.outcome.kind, "dispatch-intent");
          assert.equal(Object.hasOwn(intent.record, "phase"), false);
          const repeatedIntent = parseTurnJournalResultV1(
            "dispatchIntent",
            await dispatch(h, winner),
          );
          assert.equal(repeatedIntent.kind, "existing");
          same(repeatedIntent.record, intent.record);
          const alternate = {
            ...winner,
            consumption: {
              ...winner.consumption,
              operationRef: ref("consume-racer"),
              claimantRef: ref("claimant-racer"),
            },
          };
          const consumption = await Promise.all([
            consume(h, winner),
            consume(contender, alternate),
          ]);
          assert.equal(consumption.filter((result) => result.kind === "claim-pending").length, 1);
          assert.equal(
            consumption.filter((result) => ["already-consumed", "conflict"].includes(result.kind))
              .length,
            1,
          );
          const stored = await h.read((j) => j.findAttempt(winner.attempt, h.call));
          assert.equal(stored.record.version, 3);
          assert.ok(
            [winner.consumption.operationRef, alternate.consumption.operationRef].includes(
              stored.record.consumption.operation.operationRef,
            ),
          );
          for (const invalidConsumption of [1, true]) {
            await assert.rejects(
              pool.query(
                "UPDATE occ.turn_journal_attempts SET record=$2,version=4 WHERE agent_id=$1",
                [
                  winner.context.agentRef,
                  { ...plain(stored.record), version: 4, consumption: invalidConsumption },
                ],
              ),
              { code: "23514" },
            );
          }
          const stripped = {
            ...plain(stored.record),
            version: 4,
            consumption: null,
            outcome: {
              kind: "failed",
              stage: "execution",
              evidenceRef: ref("stripped-consumption"),
            },
          };
          await assert.rejects(
            pool.query(
              "UPDATE occ.turn_journal_attempts SET record=$2,version=4 WHERE agent_id=$1",
              [winner.context.agentRef, stripped],
            ),
            { code: "23514" },
          );
          const demoted = {
            ...commonAttemptRecord(winner),
            version: 4,
            outcome: {
              kind: "outcome-unknown",
              stage: "before-dispatch",
              evidenceRef: ref("demoted-common-phase"),
            },
          };
          await assert.rejects(
            pool.query(
              "UPDATE occ.turn_journal_attempts SET record=$2,version=4 WHERE agent_id=$1",
              [winner.context.agentRef, demoted],
            ),
            { code: "23514" },
          );
          same((await h.read((j) => j.findAttempt(winner.attempt, h.call))).record, stored.record);
          const otherOwner = await seedJournalOwner(h.state);
          assert.equal(
            (await admit(contender, journalValues(otherOwner))).record.decision.kind,
            "accepted",
          );
        } finally {
          await otherPool.end();
        }
      },
    );

    await t.test(
      "completion publishes one head and pending delivery while release remains separate",
      async () => {
        const h = journalHarness(pool);
        const owner = await seedJournalOwner(h.state);
        const v = journalValues(owner);
        await admit(h, v);
        await dispatch(h, v);
        await consume(h, v);
        const duringDispatch = journalValues(owner, {
          conversationRef: v.context.conversationRef,
          head: v.head,
        });
        const duringBusy = await admit(h, duringDispatch);
        assert.equal(duringBusy.record.decision.kind, "busy");
        assert.equal(
          valueOf(await h.write((j) => j.allocateCheckpoint(v.allocation, h.call))).kind,
          "allocated",
        );
        // The allocation predates publication. Rollback after the real pointer
        // mutation retains that exact allocation and publishes no partial result.
        const rolledBack = await h.write(async (j) => {
          assert.equal(
            (await j.publishCompleted(h.issue("completion", v.completion), h.call)).kind,
            "published",
          );
          throw new Error("publication transaction rolled back");
        });
        assert.equal(rolledBack.kind, "unavailable");
        assert.equal(
          (await h.read((j) => j.findCompletion(v.completionOperation, h.call))).kind,
          "absent",
        );
        assert.equal(
          (await h.read((j) => j.findCheckpointAllocation(v.allocation, h.call))).kind,
          "found",
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM occ.turn_journal_deliveries WHERE agent_id=$1",
              [v.context.agentRef],
            )
          ).rows[0].count,
          0,
        );
        const completed = valueOf(
          await h.write((j) => j.publishCompleted(h.issue("completion", v.completion), h.call)),
        );
        assert.equal(completed.kind, "published");
        assert.equal(completed.record.head.completionSequence, 1);
        assert.equal(completed.record.head.headVersion, 2);
        same(completed.record.checkpoint, v.checkpoint);
        assert.equal(
          (await h.read((j) => j.findCompletion(v.completionOperation, h.call))).kind,
          "published",
        );
        same(await h.read((j) => j.readHead(v.context, h.call)), {
          kind: "unavailable",
          reason: "unresolved-work",
        });
        assert.equal((await h.read((j) => j.findDelivery(v.delivery, h.call))).kind, "pending");
        assert.equal(
          valueOf(
            await h.write((j) => j.publishCompleted(h.issue("completion", v.completion), h.call)),
          ).kind,
          "existing",
        );
        const stale = {
          ...v.completion,
          operation: {
            ...v.completionOperation,
            operationRef: ref("stale-completion"),
            requestDigest: digest(),
          },
        };
        assert.equal(
          valueOf(await h.write((j) => j.publishCompleted(h.issue("completion", stale), h.call)))
            .kind,
          "conflict",
        );
        assert.equal((await admit(h, journalValues(owner))).record.decision.kind, "busy");
        const released = valueOf(
          await h.write((j) => j.releaseReservation(h.issue("release", v.release), h.call)),
        );
        assert.equal(released.kind, "released");
        assert.equal((await h.read((j) => j.readHead(v.context, h.call))).kind, "completed");
        const sticky = await admit(h, duringDispatch);
        assert.equal(sticky.incomingLink.disposition, duringBusy.incomingLink.disposition);
        same(sticky.record, duringBusy.record);
        assert.equal(sticky.record.decision.kind, "busy");
        assert.equal(
          (await h.read((j) => j.findAttempt(duringDispatch.attempt, h.call))).kind,
          "absent",
        );
        assert.equal((await h.read((j) => j.findRelease(v.release, h.call))).kind, "released");
        assert.equal(
          valueOf(await h.write((j) => j.releaseReservation(h.issue("release", v.release), h.call)))
            .kind,
          "existing",
        );
        assert.equal((await admit(h, journalValues(owner))).record.decision.kind, "accepted");
      },
    );

    await t.test(
      "unknown outcomes retain consumption and cannot release on an expired dispatch deadline",
      async () => {
        const h = journalHarness(pool);
        const owner = await seedJournalOwner(h.state);
        const v = journalValues(owner);
        await admit(h, v);
        v.binding.expiresAt = new Date(Date.now() + 1_000).toISOString();
        await dispatch(h, v);
        await consume(h, v);
        const unknown = {
          ...v.outcome,
          outcome: {
            kind: "outcome-unknown",
            stage: "execution",
            evidenceRef: ref("unknown-native-result"),
          },
        };
        const result = valueOf(
          await h.write((j) => j.recordOutcome(h.issue("outcome", unknown), h.call)),
        );
        assert.equal(result.kind, "recorded");
        same(result.record.consumption.operation, v.consumption);
        // Storage retains the unresolved old attempt's reservation. Let its actual
        // dispatch proof expire; this does not supply affirmative no-mutator proof.
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, Date.parse(v.binding.expiresAt) - Date.now() + 25)),
        );
        assert.ok(Date.now() >= Date.parse(v.binding.expiresAt));
        const successor = journalValues(owner);
        const afterExpiry = valueOf(
          await h.store.transact(
            ref("expiry-test"),
            (j) => j.admit(h.issue("admission", successor.observation), h.call),
            h.call,
          ),
        );
        assert.equal(afterExpiry.record.decision.kind, "busy");
        const record = await h.store.read((j) => j.findAttempt(v.attempt, h.call), h.call);
        same(record.record.consumption.operation, v.consumption);
      },
    );

    await t.test(
      "an exact prepared checkpoint reconciles unknown success but never rewrites failed terminals",
      async () => {
        for (const kind of ["outcome-unknown", "failed", "interrupted", "cancelled"]) {
          const h = journalHarness(pool);
          const v = journalValues(await seedJournalOwner(h.state));
          await admit(h, v);
          await dispatch(h, v);
          await consume(h, v);
          assert.equal(
            valueOf(await h.write((j) => j.allocateCheckpoint(v.allocation, h.call))).kind,
            "allocated",
          );
          const terminal = {
            ...v.outcome,
            outcome: { kind, stage: "execution", evidenceRef: ref("terminal-observation") },
          };
          assert.equal(
            valueOf(await h.write((j) => j.recordOutcome(h.issue("outcome", terminal), h.call)))
              .kind,
            "recorded",
          );
          const observation = copy(v.completion);
          observation.operation.expectedAttemptVersion = 4;
          observation.pendingDelivery.outcomeVersion = 5;
          const result = valueOf(
            await h.write((j) => j.publishCompleted(h.issue("completion", observation), h.call)),
          );
          if (kind === "outcome-unknown") {
            assert.equal(result.kind, "published");
            assert.equal(result.record.checkpoint.checkpointId, v.allocation.checkpointId);
            assert.equal(result.record.outcomeVersion, 5);
          } else {
            assert.equal(result.kind, "conflict");
            assert.equal(
              (await h.read((j) => j.findCompletion(observation.operation, h.call))).kind,
              "absent",
            );
            assert.equal(
              (
                await pool.query(
                  "SELECT record->>'completionSequence' AS sequence FROM occ.turn_journal_heads WHERE agent_id=$1",
                  [v.context.agentRef],
                )
              ).rows[0].sequence,
              "0",
            );
          }
          same(
            (await h.read((j) => j.findAttempt(v.attempt, h.call))).record.consumption.operation,
            v.consumption,
          );
        }
      },
    );

    await t.test(
      "released failed first execution cannot reset its used context to a fresh empty head",
      async () => {
        const h = journalHarness(pool);
        const owner = await seedJournalOwner(h.state);
        const v = journalValues(owner);
        await admit(h, v);
        await dispatch(h, v);
        await consume(h, v);
        assert.equal(
          valueOf(await h.write((j) => j.recordOutcome(h.issue("outcome", v.outcome), h.call)))
            .kind,
          "recorded",
        );
        assert.equal(
          valueOf(await h.write((j) => j.releaseReservation(h.issue("release", v.release), h.call)))
            .kind,
          "released",
        );
        assert.equal((await h.read((j) => j.readHead(v.context, h.call))).kind, "unavailable");
        const successor = journalValues(owner, {
          conversationRef: v.context.conversationRef,
          head: v.head,
        });
        const result = await admit(h, successor);
        assert.equal(
          result.kind === "recorded" ? result.record.decision.kind : result.kind,
          "denied",
        );
        assert.equal(
          (await h.read((j) => j.findAttempt(successor.attempt, h.call))).kind,
          "absent",
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM occ.turn_journal_attempts WHERE agent_id=$1",
              [v.context.agentRef],
            )
          ).rows[0].count,
          1,
        );
      },
    );

    await t.test(
      "dispatch deadline remains anchored to the first authenticated receive time",
      async () => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state), { now: Date.now() - 29_000 });
        // Current dispatch proof does not refresh the already spent intake budget.
        v.binding.expiresAt = new Date(Date.now() + 60_000).toISOString();
        assert.equal((await admit(h, v)).record.decision.kind, "accepted");
        const received = Date.parse(v.envelope.receivedAt);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, received + 30_025 - Date.now())),
        );
        assert.equal((await dispatch(h, v)).kind, "denied");
        const stored = (
          await pool.query(
            "SELECT record, first_received_at FROM occ.turn_journal_attempts WHERE agent_id=$1",
            [v.context.agentRef],
          )
        ).rows[0];
        same(stored.record, commonAttemptRecord(v));
        assert.equal(stored.first_received_at.getTime(), received);
      },
    );

    await t.test(
      "delivery retries require definitive no-effect and stop at the bounded slot limit",
      async () => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        await admit(h, v);
        await dispatch(h, v);
        await consume(h, v);
        await h.write((j) => j.allocateCheckpoint(v.allocation, h.call));
        await h.write((j) => j.publishCompleted(h.issue("completion", v.completion), h.call));
        for (let number = 1; number <= 3; number++) {
          const reserved = valueOf(
            await h.write((j) => j.reserveDelivery(h.issue("delivery", v.delivery), h.call)),
          );
          assert.equal(reserved.kind, "reserved");
          assert.equal(reserved.attemptNumber, number);
          const outcome = {
            operation: v.delivery,
            deliveryAttemptRef: reserved.deliveryAttemptRef,
            outcome: { kind: "definitive-no-effect", retryClass: "transient" },
          };
          assert.equal(
            valueOf(await h.write((j) => j.recordDelivery(outcome, h.call))).kind,
            "recorded",
          );
        }
        assert.notEqual(
          valueOf(await h.write((j) => j.reserveDelivery(h.issue("delivery", v.delivery), h.call)))
            .kind,
          "reserved",
        );
        const failed = journalValues(await seedJournalOwner(h.state));
        await admit(h, failed);
        await dispatch(h, failed);
        await consume(h, failed);
        assert.equal(
          valueOf(await h.write((j) => j.recordOutcome(h.issue("outcome", failed.outcome), h.call)))
            .kind,
          "recorded",
        );
        const unknownDelivery = {
          ...failed.delivery,
          operationRef: ref("status"),
          slot: "outcome-status",
        };
        const reserved = valueOf(
          await h.write((j) => j.reserveDelivery(h.issue("delivery", unknownDelivery), h.call)),
        );
        assert.equal(reserved.kind, "reserved");
        await h.write((j) =>
          j.recordDelivery(
            {
              operation: unknownDelivery,
              deliveryAttemptRef: reserved.deliveryAttemptRef,
              outcome: { kind: "delivery-unknown" },
            },
            h.call,
          ),
        );
        const retry = valueOf(
          await h.write((j) => j.reserveDelivery(h.issue("delivery", unknownDelivery), h.call)),
        );
        assert.notEqual(retry.kind, "reserved");
        assert.equal(
          (await h.read((j) => j.findDelivery(unknownDelivery, h.call))).record.outcome.kind,
          "delivery-unknown",
        );
      },
    );

    await t.test(
      "cancellation retains requester attribution and competes with dispatch under one version",
      async () => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        await admit(h, v);
        const results = await Promise.all([
          h
            .write((j) => j.commitCancellation(h.issue("cancellation", v.cancellation), h.call))
            .then(valueOf),
          dispatch(h, v),
        ]);
        assert.equal(results.filter((result) => result.kind === "recorded").length, 1);
        if (results[0].kind === "recorded") {
          assert.equal(results[0].outcome, "cancelled-before-dispatch");
          const readback = await h.read((j) => j.findCancellation(v.cancellation, h.call));
          assert.equal(readback.kind, "found");
          assert.equal(
            readback.operation.requesterPrincipalRef,
            v.cancellation.requesterPrincipalRef,
          );
          assert.notEqual(
            readback.operation.requesterPrincipalRef,
            readback.operation.originalPrincipalRef,
          );
          assert.equal((await dispatch(h, v)).kind, "conflict");
          const cancelled = (await h.read((j) => j.findAttempt(v.attempt, h.call))).record;
          same(cancelled, {
            ...commonAttemptRecord(v),
            version: 2,
            outcome: {
              kind: "cancelled",
              stage: "before-dispatch",
              evidenceRef: v.cancellation.operationRef,
            },
          });
          const published = (
            await pool.query(
              "SELECT (SELECT count(*) FROM occ.turn_journal_operations WHERE agent_id=$1 AND operation_kind='cancellation')::int AS cancellations,(SELECT count(*) FROM occ.turn_journal_operations WHERE agent_id=$1 AND operation_kind='outcome')::int AS outcomes,(SELECT count(*) FROM occ.turn_journal_reservations WHERE agent_id=$1)::int AS held",
              [v.context.agentRef],
            )
          ).rows[0];
          assert.deepEqual(published, { cancellations: 1, outcomes: 0, held: 1 });
        } else {
          const stored = await h.read((j) => j.findAttempt(v.attempt, h.call));
          assert.equal(stored.record.outcome.kind, "dispatch-intent");
          assert.equal(stored.record.version, 2);
        }
        assert.equal((await admit(h, journalValues(v.owner))).record.decision.kind, "busy");
      },
    );

    await t.test(
      "predispatch cancellation publishes version two and releases only through its exact separate observation",
      async () => {
        const h = journalHarness(pool);
        const owner = await seedJournalOwner(h.state);
        const v = journalValues(owner);
        await admit(h, v);
        const stale = { ...v.cancellation, expectedAttemptVersion: 2 };
        assert.equal(
          valueOf(
            await h.write((j) => j.commitCancellation(h.issue("cancellation", stale), h.call)),
          ).kind,
          "conflict",
        );
        const wrongPrincipal = {
          ...v.cancellation,
          originalPrincipalRef: ref("foreign-principal"),
        };
        assert.equal(
          valueOf(
            await h.write((j) =>
              j.commitCancellation(h.issue("cancellation", wrongPrincipal), h.call),
            ),
          ).kind,
          "denied",
        );
        const cancelled = valueOf(
          await h.write((j) =>
            j.commitCancellation(h.issue("cancellation", v.cancellation), h.call),
          ),
        );
        assert.equal(cancelled.outcome, "cancelled-before-dispatch");
        const current = (await h.read((j) => j.findAttempt(v.attempt, h.call))).record;
        same(current, {
          ...commonAttemptRecord(v),
          version: 2,
          outcome: {
            kind: "cancelled",
            stage: "before-dispatch",
            evidenceRef: v.cancellation.operationRef,
          },
        });
        const repeated = valueOf(
          await h.write((j) =>
            j.commitCancellation(h.issue("cancellation", v.cancellation), h.call),
          ),
        );
        assert.equal(repeated.kind, "existing");
        same(repeated.operation, v.cancellation);
        same((await h.read((j) => j.findAttempt(v.attempt, h.call))).record, current);
        assert.equal((await admit(h, journalValues(owner))).record.decision.kind, "busy");
        assert.equal(
          valueOf(await h.write((j) => j.releaseReservation({}, h.call))).kind,
          "denied",
        );
        assert.equal((await h.read((j) => j.findRelease(v.release, h.call))).kind, "absent");
        const release = { ...v.release, expectedAttemptVersion: 2 };
        assert.equal(
          valueOf(
            await h.write((j) =>
              j.releaseReservation(
                h.issue("release", { ...release, expectedAttemptVersion: 1 }),
                h.call,
              ),
            ),
          ).kind,
          "conflict",
        );
        assert.equal(
          valueOf(await h.write((j) => j.releaseReservation(h.issue("release", release), h.call)))
            .kind,
          "released",
        );
        // A never-dispatched context retains its original empty head/creationRef.
        const head = await h.read((j) => j.readHead(v.context, h.call));
        assert.equal(head.kind, "new-context");
        same(head.head, v.head);
        const successor = journalValues(owner, {
          conversationRef: v.context.conversationRef,
          head: v.head,
        });
        assert.equal((await admit(h, successor)).record.decision.kind, "accepted");
        assert.equal(
          valueOf(await h.write((j) => j.releaseReservation(h.issue("release", release), h.call)))
            .kind,
          "existing",
        );
        const held = (
          await pool.query(
            "SELECT reservation_ref FROM occ.turn_journal_reservations WHERE agent_id=$1",
            [v.context.agentRef],
          )
        ).rows;
        assert.deepEqual(
          held.map((row) => row.reservation_ref),
          [successor.attempt.reservationRef],
        );
      },
    );

    await t.test(
      "common uncertainty uses version CAS, stays undispatched and holds ownership until separate release",
      async () => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        await admit(h, v);
        const unknown = {
          ...v.outcome,
          expectedAttemptVersion: 1,
          outcome: {
            kind: "outcome-unknown",
            stage: "before-dispatch",
            evidenceRef: ref("unknown-before-dispatch"),
          },
        };
        const recorded = valueOf(
          await h.write((j) => j.recordOutcome(h.issue("outcome", unknown), h.call)),
        );
        assert.equal(recorded.kind, "recorded");
        assert.equal(recorded.record.phase, "admitted-undispatched");
        assert.equal(recorded.record.version, 2);
        assert.equal(recorded.record.consumption, null);
        assert.equal((await dispatch(h, v)).kind, "conflict");
        assert.equal((await consume(h, v)).kind, "conflict");
        assert.equal(
          valueOf(
            await h.write((j) =>
              j.commitCancellation(
                h.issue("cancellation", { ...v.cancellation, expectedAttemptVersion: 2 }),
                h.call,
              ),
            ),
          ).kind,
          "conflict",
        );
        assert.equal(
          valueOf(
            await h.write((j) =>
              j.recordOutcome(
                h.issue("outcome", { ...v.outcome, expectedAttemptVersion: 2 }),
                h.call,
              ),
            ),
          ).kind,
          "conflict",
        );
        const terminal = {
          ...unknown,
          operationRef: ref("resolve-before-dispatch"),
          requestDigest: digest(),
          expectedAttemptVersion: 2,
          outcome: {
            kind: "failed",
            stage: "before-dispatch",
            evidenceRef: ref("resolved-before-dispatch"),
          },
        };
        const competitor = {
          ...terminal,
          operationRef: ref("competing-resolution"),
          requestDigest: digest(),
        };
        const results = await Promise.all(
          [terminal, competitor].map((operation) =>
            h.write((j) => j.recordOutcome(h.issue("outcome", operation), h.call)).then(valueOf),
          ),
        );
        assert.deepEqual(results.map((result) => result.kind).sort(), ["conflict", "recorded"]);
        const final = (await h.read((j) => j.findAttempt(v.attempt, h.call))).record;
        assert.equal(final.version, 3);
        assert.equal(final.phase, "admitted-undispatched");
        assert.equal(final.consumption, null);
        assert.equal((await admit(h, journalValues(v.owner))).record.decision.kind, "busy");
        // Exact old operation replay returns its original version-two observation.
        const replay = valueOf(
          await h.write((j) => j.recordOutcome(h.issue("outcome", unknown), h.call)),
        );
        assert.equal(replay.kind, "existing");
        same(replay.record, recorded.record);
        same((await h.read((j) => j.findAttempt(v.attempt, h.call))).record, final);
        assert.equal(
          valueOf(
            await h.write((j) =>
              j.releaseReservation(
                h.issue("release", { ...v.release, expectedAttemptVersion: 3 }),
                h.call,
              ),
            ),
          ).kind,
          "released",
        );
      },
    );

    await t.test(
      "retained dispatch intent marks a context used even without consumption and after release",
      async () => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        await admit(h, v);
        await dispatch(h, v);
        const operation = {
          ...v.outcome,
          expectedAttemptVersion: 2,
          outcome: { kind: "failed", stage: "dispatch", evidenceRef: ref("dispatch-failure") },
        };
        const terminal = valueOf(
          await h.write((j) => j.recordOutcome(h.issue("outcome", operation), h.call)),
        );
        assert.equal(terminal.record.consumption, null);
        assert.equal(Object.hasOwn(terminal.record, "phase"), false);
        assert.equal(
          valueOf(
            await h.write((j) =>
              j.releaseReservation(
                h.issue("release", { ...v.release, expectedAttemptVersion: 3 }),
                h.call,
              ),
            ),
          ).kind,
          "released",
        );
        assert.equal((await h.read((j) => j.readHead(v.context, h.call))).kind, "unavailable");
        const successor = journalValues(v.owner, {
          conversationRef: v.context.conversationRef,
          head: v.head,
        });
        const denied = await admit(h, successor);
        assert.equal(
          denied.kind === "recorded" ? denied.record.decision.kind : denied.kind,
          "denied",
        );
        assert.equal(
          (await h.read((j) => j.findAttempt(successor.attempt, h.call))).kind,
          "absent",
        );
      },
    );

    await t.test("an exact known-message status update is attempted only once", async () => {
      const h = journalHarness(pool);
      const v = journalValues(await seedJournalOwner(h.state));
      await admit(h, v);
      await dispatch(h, v);
      await consume(h, v);
      assert.equal(
        valueOf(await h.write((j) => j.recordOutcome(h.issue("outcome", v.outcome), h.call))).kind,
        "recorded",
      );
      const status = { ...v.delivery, operationRef: ref("status-create"), slot: "outcome-status" };
      const initial = valueOf(
        await h.write((j) => j.reserveDelivery(h.issue("delivery", status), h.call)),
      );
      assert.equal(initial.kind, "reserved");
      const providerMessageRef = ref("known-provider-message");
      assert.equal(
        valueOf(
          await h.write((j) =>
            j.recordDelivery(
              {
                operation: status,
                deliveryAttemptRef: initial.deliveryAttemptRef,
                outcome: { kind: "delivered", providerMessageRef },
              },
              h.call,
            ),
          ),
        ).kind,
        "recorded",
      );
      const update = {
        ...status,
        operationRef: ref("status-update"),
        operation: { kind: "update", providerMessageRef },
      };
      const updated = valueOf(
        await h.write((j) => j.reserveDelivery(h.issue("delivery", update), h.call)),
      );
      assert.equal(updated.kind, "reserved");
      assert.equal(updated.attemptNumber, 1);
      await h.write((j) =>
        j.recordDelivery(
          {
            operation: update,
            deliveryAttemptRef: updated.deliveryAttemptRef,
            outcome: { kind: "definitive-no-effect", retryClass: "transient" },
          },
          h.call,
        ),
      );
      assert.notEqual(
        valueOf(await h.write((j) => j.reserveDelivery(h.issue("delivery", update), h.call))).kind,
        "reserved",
      );
      const second = { ...update, operationRef: ref("second-status-update") };
      assert.notEqual(
        valueOf(await h.write((j) => j.reserveDelivery(h.issue("delivery", second), h.call))).kind,
        "reserved",
      );
    });

    await t.test(
      "consumed cancellation and completion compete under the same attempt version",
      async () => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        await admit(h, v);
        await dispatch(h, v);
        await consume(h, v);
        assert.equal(
          valueOf(await h.write((j) => j.allocateCheckpoint(v.allocation, h.call))).kind,
          "allocated",
        );
        const cancellation = { ...v.cancellation, expectedAttemptVersion: 3 };
        const [cancelled, completed] = await Promise.all([
          h
            .write((j) => j.commitCancellation(h.issue("cancellation", cancellation), h.call))
            .then(valueOf),
          h
            .write((j) => j.publishCompleted(h.issue("completion", v.completion), h.call))
            .then(valueOf),
        ]);
        assert.equal(
          [cancelled, completed].filter((result) => ["recorded", "published"].includes(result.kind))
            .length,
          1,
        );
        const current = await h.read((j) => j.findAttempt(v.attempt, h.call));
        assert.equal(current.record.version, 4);
        same(current.record.consumption.operation, v.consumption);
        if (cancelled.kind === "recorded") {
          assert.equal(cancelled.outcome, "requested");
          assert.equal(completed.kind, "conflict");
          assert.equal(current.record.outcome.kind, "consumed");
        } else {
          assert.equal(completed.kind, "published");
          assert.ok(["too-late", "conflict"].includes(cancelled.kind));
        }

        const other = journalValues(await seedJournalOwner(h.state));
        await admit(h, other);
        await dispatch(h, other);
        await consume(h, other);
        const first = { ...other.cancellation, expectedAttemptVersion: 3 };
        assert.equal(
          valueOf(
            await h.write((j) => j.commitCancellation(h.issue("cancellation", first), h.call)),
          ).kind,
          "recorded",
        );
        const stale = {
          ...first,
          operationRef: ref("another-cancellation"),
          requestDigest: digest(),
        };
        assert.equal(
          valueOf(
            await h.write((j) => j.commitCancellation(h.issue("cancellation", stale), h.call)),
          ).kind,
          "conflict",
        );
        assert.equal((await h.read((j) => j.findCancellation(stale, h.call))).kind, "absent");
        const currentVersion = { ...stale, expectedAttemptVersion: 4 };
        assert.equal(
          valueOf(
            await h.write((j) =>
              j.commitCancellation(h.issue("cancellation", currentVersion), h.call),
            ),
          ).kind,
          "conflict",
        );
        assert.equal(
          (await h.read((j) => j.findCancellation(currentVersion, h.call))).kind,
          "absent",
        );
        assert.equal(
          valueOf(
            await h.write((j) => j.commitCancellation(h.issue("cancellation", first), h.call)),
          ).kind,
          "existing",
        );
      },
    );

    await t.test(
      "a requested cancellation preserves later exact terminal and completion reconciliation",
      async () => {
        for (const complete of [false, true]) {
          const h = journalHarness(pool);
          const v = journalValues(await seedJournalOwner(h.state));
          await admit(h, v);
          await dispatch(h, v);
          await consume(h, v);
          if (complete)
            assert.equal(
              valueOf(await h.write((j) => j.allocateCheckpoint(v.allocation, h.call))).kind,
              "allocated",
            );
          const cancellation = { ...v.cancellation, expectedAttemptVersion: 3 };
          const requested = valueOf(
            await h.write((j) =>
              j.commitCancellation(h.issue("cancellation", cancellation), h.call),
            ),
          );
          assert.equal(requested.kind, "recorded");
          assert.equal(requested.outcome, "requested");
          if (complete) {
            const completion = copy(v.completion);
            completion.operation.expectedAttemptVersion = 4;
            completion.pendingDelivery.outcomeVersion = 5;
            assert.equal(
              valueOf(
                await h.write((j) => j.publishCompleted(h.issue("completion", completion), h.call)),
              ).kind,
              "published",
            );
          } else {
            const terminal = { ...v.outcome, expectedAttemptVersion: 4 };
            assert.equal(
              valueOf(await h.write((j) => j.recordOutcome(h.issue("outcome", terminal), h.call)))
                .kind,
              "recorded",
            );
          }
          const current = (await h.read((j) => j.findAttempt(v.attempt, h.call))).record;
          assert.equal(current.version, 5);
          assert.equal(current.outcome.kind, complete ? "completed" : v.outcome.outcome.kind);
          same(current.consumption.operation, v.consumption);
          assert.equal(
            (await h.read((j) => j.findCancellation(cancellation, h.call))).kind,
            "found",
          );
        }
      },
    );

    await t.test(
      "exhausting nonfinal observation capacity preserves room for one terminal outcome",
      async () => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        await admit(h, v);
        await dispatch(h, v);
        await consume(h, v);
        for (let index = 0; index < 32; index++) {
          const observation = {
            ...v.outcome,
            operationRef: ref("nonfinal-observation"),
            requestDigest: digest(),
            expectedAttemptVersion: 3 + index,
            outcome: {
              kind: "outcome-unknown",
              stage: "execution",
              evidenceRef: ref("unknown-evidence"),
            },
          };
          assert.equal(
            valueOf(await h.write((j) => j.recordOutcome(h.issue("outcome", observation), h.call)))
              .kind,
            "recorded",
          );
        }
        const overflow = {
          ...v.outcome,
          operationRef: ref("overflow-observation"),
          requestDigest: digest(),
          expectedAttemptVersion: 35,
          outcome: {
            kind: "outcome-unknown",
            stage: "execution",
            evidenceRef: ref("overflow-evidence"),
          },
        };
        assert.equal(
          (await h.write((j) => j.recordOutcome(h.issue("outcome", overflow), h.call))).kind,
          "unavailable",
        );
        assert.equal((await h.read((j) => j.findAttempt(v.attempt, h.call))).record.version, 35);
        const terminal = { ...v.outcome, expectedAttemptVersion: 35 };
        assert.equal(
          valueOf(await h.write((j) => j.recordOutcome(h.issue("outcome", terminal), h.call))).kind,
          "recorded",
        );
        const current = (await h.read((j) => j.findAttempt(v.attempt, h.call))).record;
        assert.equal(current.version, 36);
        assert.equal(current.outcome.kind, v.outcome.outcome.kind);
        same(current.consumption.operation, v.consumption);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM occ.turn_journal_operations WHERE agent_id=$1 AND operation_kind='outcome'",
              [v.context.agentRef],
            )
          ).rows[0].count,
          33,
        );
      },
    );

    await t.test(
      "copied, foreign, revoked and wrong-recipient handles cannot mutate historical owners",
      async () => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        const valid = h.issue("admission", v.observation);
        const foreign = journalHarness(pool).issue("admission", v.observation);
        for (const handle of [{}, structuredClone(valid), foreign]) {
          assert.equal(valueOf(await h.write((j) => j.admit(handle, h.call))).kind, "denied");
        }
        const wrong = h.provenance.call({ recipientRef: "different-recipient" });
        assert.equal(valueOf(await h.write((j) => j.admit(valid, wrong), wrong)).kind, "denied");
        h.provenance.revoke(valid);
        assert.equal(valueOf(await h.write((j) => j.admit(valid, h.call))).kind, "denied");
        assert.equal((await h.read((j) => j.findAdmission(eventLookup(v), h.call))).kind, "absent");
        const accepted = await admit(h, v);
        const otherOwner = await seedJournalOwner(h.state);
        const foreignScope = {
          ...v.attempt,
          namespaceRef: otherOwner.namespace.id,
          agentRef: otherOwner.agent.id,
        };
        assert.equal((await h.read((j) => j.findAttempt(foreignScope, h.call))).kind, "absent");
        assert.equal(
          (
            await h.read((j) =>
              j.findAdmission(
                { ...eventLookup(v), channelInstallationRef: otherOwner.channelInstallation.id },
                h.call,
              ),
            )
          ).kind,
          "absent",
        );
        h.provenance.setAllowed(false);
        assert.equal((await h.read((j) => j.findAdmission(eventLookup(v), h.call))).kind, "denied");
        h.provenance.setAllowed(true);
        same(
          (await h.read((j) => j.findAdmission(eventLookup(v), h.call))).record,
          accepted.record,
        );
      },
    );

    await t.test(
      "revocation while waiting on the real admission lock cannot commit a stale incoming link",
      async (t) => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        const original = await admit(h, v);
        const twin = changedIncoming(v, (incoming) => {
          incoming.envelope.event.providerEventRef = ref("blocked-twin");
        });
        const handle = h.issue("admission", twin.observation);
        const locker = await pool.connect();
        let pending;
        t.after(async () => {
          await locker.query("ROLLBACK");
          locker.release();
          await pending?.catch(() => {});
        });
        await locker.query("BEGIN");
        const pid = (await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `turn-journal-admission:${v.context.installationRef}`,
        ]);
        const pendingBackend = deferred();
        pending = h.state.transact(async (unit) => {
          const backend = await h.state.queryInTransaction(unit, "SELECT pg_backend_pid() AS pid");
          pendingBackend.resolve(backend.rows[0].pid);
          return unit.turnJournal.admit(handle, h.call);
        });
        pending.catch((error) => pendingBackend.reject(error));
        const pendingPid = await pendingBackend.promise;
        const deadline = Date.now() + 5_000;
        let blocked = false;
        while (Date.now() < deadline) {
          blocked = (
            await pool.query("SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked", [pid, pendingPid])
          ).rows[0].blocked;
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(
          blocked,
          true,
          "the real journal transaction must be waiting on the held admission lock",
        );
        h.provenance.revoke(handle);
        await locker.query("ROLLBACK");
        assert.equal((await pending).kind, "denied");
        assert.equal(
          (await h.read((j) => j.findIncomingLink(incomingLookup(twin.identity), h.call))).kind,
          "absent",
        );
        assert.equal(
          (await h.read((j) => j.findAdmission(eventLookup(twin), h.call))).kind,
          "absent",
        );
        same(
          (await h.read((j) => j.findAdmission(eventLookup(v), h.call))).record,
          original.record,
        );
      },
    );

    await t.test(
      "capacity refuses a new owner without evicting an active attempt or its incoming link",
      async () => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        await admit(h, v);
        const counts = (
          await pool.query(
            "SELECT (SELECT count(*) FROM occ.turn_journal_owners WHERE installation_id=$1)::int AS owners, (SELECT count(*) FROM occ.turn_journal_incoming_links WHERE installation_id=$1)::int AS links, (SELECT count(*) FROM occ.turn_journal_attempts WHERE installation_id=$1)::int AS attempts",
            [v.context.installationRef],
          )
        ).rows[0];
        const bounded = journalHarness(pool, {
          capacity: {
            maxOwnersPerInstallation: counts.owners,
            maxIncomingLinksPerInstallation: counts.links + 1,
            maxAttemptsPerInstallation: counts.attempts + 1,
          },
        });
        const candidate = journalValues(await seedJournalOwner(h.state));
        const refused = await bounded.write((j) =>
          j.admit(bounded.issue("admission", candidate.observation), bounded.call),
        );
        assert.equal(
          refused.kind === "committed" ? refused.value.kind : refused.kind,
          "unavailable",
        );
        assert.equal(
          (await h.read((j) => j.findAdmission(eventLookup(candidate), h.call))).kind,
          "absent",
        );
        assert.equal(
          (await h.read((j) => j.findIncomingLink(incomingLookup(v.identity), h.call))).kind,
          "found",
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM occ.turn_journal_attempts WHERE agent_id=$1",
              [v.context.agentRef],
            )
          ).rows[0].count,
          1,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM occ.turn_journal_owners WHERE installation_id=$1",
              [v.context.installationRef],
            )
          ).rows[0].count,
          counts.owners,
        );
      },
    );

    await t.test(
      "unknown and terminal common attempts count toward pending capacity until their own reservation is released",
      async () => {
        const h = journalHarness(pool);
        const firstOwner = await seedJournalOwner(h.state);
        const installation = firstOwner.installation.id;
        const pendingSql =
          "SELECT count(*)::int AS count FROM occ.turn_journal_attempts a JOIN occ.turn_journal_reservations r USING (installation_id,namespace_id,agent_id,conversation_ref,turn_ref,attempt_ref,reservation_ref) WHERE a.installation_id=$1 AND a.record->>'phase'='admitted-undispatched'";
        const baseline = (await pool.query(pendingSql, [installation])).rows[0].count;
        assert.ok(
          baseline < 32,
          "allocated test database must have room for at least one owned pending fixture",
        );
        const tracked = [];
        const run = (work) => {
          const call = h.provenance.call();
          return h.write((j) => work(j, call), call).then(valueOf);
        };
        try {
          for (let index = baseline; index < 32; index++) {
            const owner = index === baseline ? firstOwner : await seedJournalOwner(h.state);
            const v = journalValues(owner);
            assert.equal(
              (await run((j, call) => j.admit(h.issue("admission", v.observation), call))).record
                .decision.kind,
              "accepted",
            );
            tracked.push({ values: v, version: 1, released: false });
            const operation = {
              ...v.outcome,
              expectedAttemptVersion: 1,
              outcome: {
                kind: index % 2 ? "outcome-unknown" : "failed",
                stage: "before-dispatch",
                evidenceRef: ref("held-common-observation"),
              },
            };
            const observed = await run((j, call) =>
              j.recordOutcome(h.issue("outcome", operation), call),
            );
            assert.equal(observed.kind, "recorded");
            tracked[tracked.length - 1].version = 2;
          }
          assert.equal((await pool.query(pendingSql, [installation])).rows[0].count, 32);
          const candidate = journalValues(await seedJournalOwner(h.state));
          const refusedCall = h.provenance.call();
          const refused = await h.write(
            (j) => j.admit(h.issue("admission", candidate.observation), refusedCall),
            refusedCall,
          );
          assert.equal(
            refused.kind === "committed" ? refused.value.kind : refused.kind,
            "unavailable",
          );
          const readCall = h.provenance.call();
          assert.equal(
            (await h.read((j) => j.findAttempt(candidate.attempt, readCall), readCall)).kind,
            "absent",
          );
          const held = tracked[0];
          const release = { ...held.values.release, expectedAttemptVersion: held.version };
          assert.equal(
            (await run((j, call) => j.releaseReservation(h.issue("release", release), call))).kind,
            "released",
          );
          held.released = true;
          assert.equal((await pool.query(pendingSql, [installation])).rows[0].count, 31);
          assert.equal(
            (await run((j, call) => j.admit(h.issue("admission", candidate.observation), call)))
              .record.decision.kind,
            "accepted",
          );
          tracked.push({ values: candidate, version: 1, released: false });
          assert.equal((await pool.query(pendingSql, [installation])).rows[0].count, 32);
        } finally {
          // Release only this case's exact synthetic storage responsibilities;
          // unknown/terminal labels never remove a reservation by themselves.
          for (const entry of tracked.filter((entry) => !entry.released)) {
            if (entry.version === 1) {
              const operation = {
                ...entry.values.outcome,
                expectedAttemptVersion: 1,
                outcome: {
                  kind: "failed",
                  stage: "before-dispatch",
                  evidenceRef: ref("capacity-fixture-close"),
                },
              };
              assert.equal(
                (await run((j, call) => j.recordOutcome(h.issue("outcome", operation), call))).kind,
                "recorded",
              );
              entry.version = 2;
            }
            const release = { ...entry.values.release, expectedAttemptVersion: entry.version };
            assert.equal(
              (await run((j, call) => j.releaseReservation(h.issue("release", release), call)))
                .kind,
              "released",
            );
          }
        }
        assert.equal((await pool.query(pendingSql, [installation])).rows[0].count, baseline);
      },
    );

    await t.test(
      "limited application role and direct SQL constraints protect owner identity and immutable links",
      async () => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        const accepted = await admit(h, v);
        const role = (
          await pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user")
        ).rows[0];
        assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
        const functionPrivileges = (
          await pool.query(
            "SELECT has_function_privilege(current_user,'occ.turn_journal_attempt_guard()','EXECUTE') AS trigger_function, has_function_privilege(current_user,'occ.turn_journal_delivery_value_matches(jsonb)','EXECUTE') AS value_helper",
          )
        ).rows[0];
        assert.deepEqual(functionPrivileges, { trigger_function: false, value_helper: true });
        for (const table of [
          "turn_journal_owners",
          "turn_journal_keys",
          "turn_journal_incoming_links",
          "turn_journal_operations",
        ]) {
          const grants = (
            await pool.query(
              "SELECT has_table_privilege(current_user,$1,'SELECT') AS read, has_table_privilege(current_user,$1,'INSERT') AS insert, has_table_privilege(current_user,$1,'UPDATE') AS update, has_table_privilege(current_user,$1,'DELETE') AS delete, has_table_privilege(current_user,$1,'TRUNCATE') AS truncate",
              [`occ.${table}`],
            )
          ).rows[0];
          assert.deepEqual(grants, {
            read: true,
            insert: true,
            update: false,
            delete: false,
            truncate: false,
          });
          await assert.rejects(
            pool.query(`DELETE FROM occ.${table} WHERE installation_id=$1`, [
              v.context.installationRef,
            ]),
            { code: "42501" },
          );
        }
        for (const table of [
          "turn_journal_attempts",
          "turn_journal_heads",
          "turn_journal_deliveries",
          "turn_journal_delivery_attempts",
        ]) {
          const grants = (
            await pool.query(
              "SELECT has_table_privilege(current_user,$1,'SELECT') AS read, has_table_privilege(current_user,$1,'INSERT') AS insert, has_table_privilege(current_user,$1,'UPDATE') AS update, has_table_privilege(current_user,$1,'DELETE') AS delete, has_table_privilege(current_user,$1,'TRUNCATE') AS truncate",
              [`occ.${table}`],
            )
          ).rows[0];
          assert.deepEqual(grants, {
            read: true,
            insert: true,
            update: true,
            delete: false,
            truncate: false,
          });
        }
        const beforeIdentityMutation = (
          await pool.query(
            "SELECT to_jsonb(t) AS record FROM occ.turn_journal_attempts t WHERE agent_id=$1",
            [v.context.agentRef],
          )
        ).rows[0].record;
        const nonnull = (
          await pool.query(
            "SELECT attnotnull FROM pg_attribute WHERE attrelid='occ.turn_journal_attempts'::regclass AND attname='record'",
            [],
          )
        ).rows[0];
        assert.equal(nonnull.attnotnull, true);
        await assert.rejects(
          pool.query("UPDATE occ.turn_journal_attempts SET record=NULL WHERE agent_id=$1", [
            v.context.agentRef,
          ]),
          (error) => ["23502", "23514"].includes(error.code),
        );
        const unpairedCancellation = {
          ...commonAttemptRecord(v),
          version: 2,
          outcome: {
            kind: "cancelled",
            stage: "before-dispatch",
            evidenceRef: ref("absent-cancellation-operation"),
          },
        };
        await assert.rejects(
          pool.query("UPDATE occ.turn_journal_attempts SET record=$2,version=2 WHERE agent_id=$1", [
            v.context.agentRef,
            unpairedCancellation,
          ]),
          { code: "23514" },
        );
        const wrongCommon = commonAttemptRecord(v);
        wrongCommon.binding.expectedHead.creationRef = ref("replacement-original-creation");
        await assert.rejects(
          pool.query("UPDATE occ.turn_journal_attempts SET record=$2,version=2 WHERE agent_id=$1", [
            v.context.agentRef,
            { ...wrongCommon, version: 2 },
          ]),
          { code: "23514" },
        );
        await assert.rejects(
          pool.query("UPDATE occ.turn_journal_attempts SET attempt_ref=$2 WHERE agent_id=$1", [
            v.context.agentRef,
            ref("replacement-attempt"),
          ]),
          { code: "23514" },
        );
        await assert.rejects(
          pool.query("UPDATE occ.turn_journal_attempts SET agent_id=$2 WHERE agent_id=$1", [
            v.context.agentRef,
            ref("replacement-agent"),
          ]),
          { code: "23514" },
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.turn_journal_attempts SET first_received_at=first_received_at+interval '1 millisecond' WHERE agent_id=$1",
            [v.context.agentRef],
          ),
          { code: "23514" },
        );
        assert.deepEqual(
          (
            await pool.query(
              "SELECT to_jsonb(t) AS record FROM occ.turn_journal_attempts t WHERE agent_id=$1",
              [v.context.agentRef],
            )
          ).rows[0].record,
          beforeIdentityMutation,
        );
        const owner = (
          await pool.query(
            "SELECT * FROM occ.turn_journal_owners WHERE installation_id=$1 AND channel_installation_id=$2 AND receipt_ref=$3",
            [
              v.context.installationRef,
              v.locator.channelInstallationRef,
              accepted.record.identity.receipt.receiptRef,
            ],
          )
        ).rows[0];
        const insertOwner = (row) =>
          pool.query(
            "INSERT INTO occ.turn_journal_owners (installation_id,channel_installation_id,receipt_ref,owner_kind,record) VALUES ($1,$2,$3,$4,$5)",
            [
              row.installation_id,
              row.channel_installation_id,
              row.receipt_ref,
              row.owner_kind,
              row.record,
            ],
          );
        await assert.rejects(insertOwner(owner), { code: "23505" });
        for (const patch of [
          { receipt_ref: ref("mismatch") },
          { owner_kind: "unrecognized" },
          { record: [] },
          { record: { ...owner.record, unexpected: "x".repeat(65_536) } },
          { channel_installation_id: ref("foreign-channel") },
        ]) {
          await assert.rejects(insertOwner({ ...owner, ...patch }), (error) =>
            ["23503", "23514"].includes(error.code),
          );
        }
        await assert.rejects(
          pool.query(
            "INSERT INTO occ.turn_journal_keys (installation_id,channel_installation_id,key_kind,key_digest,receipt_ref) VALUES ($1,$2,'event','invalid-digest',$3)",
            [v.context.installationRef, v.locator.channelInstallationRef, v.receipt.receiptRef],
          ),
          (error) => error.code === "23514",
        );
        await assert.rejects(
          pool.query(
            "INSERT INTO occ.turn_journal_keys (installation_id,channel_installation_id,key_kind,key_digest,receipt_ref) VALUES ($1,$2,'event',$3,$4)",
            [
              v.context.installationRef,
              v.locator.channelInstallationRef,
              digest(),
              ref("absent-owner"),
            ],
          ),
          (error) => ["23503", "23514"].includes(error.code),
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.turn_journal_attempts SET version=9007199254740992 WHERE agent_id=$1",
            [v.context.agentRef],
          ),
          (error) => error.code === "23514",
        );
        same(
          (await h.read((j) => j.findAdmission(eventLookup(v), h.call))).record,
          accepted.record,
        );
      },
    );
  },
);
