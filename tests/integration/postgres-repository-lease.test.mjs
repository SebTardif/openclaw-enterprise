import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { CredentialInventoryOwnerPhaseV1 } from "../../packages/occ/src/ports/platform-unit-of-work.ts";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/ports/transaction-errors.ts";
import {
  createPostgresCredentialInventoryV1,
  preparePostgresCredentialInventoryKeysV1,
  preparePostgresCredentialInventoryScopeV1,
} from "../../packages/occ/src/credential-inventory-v1/postgres.ts";
import { transitionRepositoryInventoryV2 } from "../../packages/occ/src/credential-inventory-v1/repository-lease-transactions-v2.ts";
import {
  parseRepositoryTokenMutationV2,
  parseRepositoryTokenRecordV2,
  repositoryInventoryDigestV2,
  repositoryTargetDigestV2,
} from "../../packages/occ/src/credential-inventory-v1/repository-lease-v2.ts";
import { seedRuntimeOwner } from "../conformance/runtime-assignment-store.contract.mjs";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";
import * as cases from "../fixtures/repository-lease-v2/cases.mjs";

// Real PostgreSQL storage-component coverage only. Resource/revision metadata is
// seeded without admission, Work authority, audit acceptance, custody or provider
// calls. A staged result proves metadata persisted after the outer COMMIT only;
// it grants no current authority and does not establish token delivery.
const databaseUrl = process.env.OCC_REPOSITORY_LEASE_TEST_DATABASE_URL;
const clock = { read: () => ({ now: Date.now(), uncertaintyMs: 0 }) };
const keysFor = (input) => ({
  operations: [input.operationRef],
  records: input.target ? [input.target.recordRef] : [],
  mintClaims: input.target ? [input.target.recordRef] : [],
  revocationClaims: input.claimRef ? [input.claimRef] : [],
  snapshots: [],
});
const emptyKeys = () => ({
  operations: [],
  records: [],
  mintClaims: [],
  revocationClaims: [],
  snapshots: [],
});

// As in the original inventory suite, this phase schedules storage work only.
// Returning true below is not an accepting-authority participant or audit fact.
async function storage(
  store,
  scope,
  work,
  { keys = emptyKeys(), commitRef = cases.ref("commit"), afterQuery, effects } = {},
) {
  return store.transact(async (unit) => {
    const phase = new CredentialInventoryOwnerPhaseV1();
    let preparation = "scope";
    const context = {
      scope: { installationId: scope.installationId, namespaceId: scope.namespaceId },
      inventoryScope: scope,
      commitRef,
      transaction: { assertActive: () => phase.assertOperationActive() },
      query: {
        async query(statement, parameters) {
          const result = await store.queryInTransaction(unit, statement, parameters);
          afterQuery?.(statement);
          return result;
        },
      },
      phase: {
        assertActive() {
          phase.assertOperationActive();
          assert.equal(preparation, "complete");
        },
        assertWriting() {
          this.assertActive();
        },
        assertPreparing(stage) {
          phase.assertOperationActive();
          assert.equal(preparation, stage);
        },
        poison: (error) => phase.poison(error),
        recordEffect(effect) {
          phase.assertOperationActive();
          effects?.push(effect);
        },
      },
    };
    const repository = createPostgresCredentialInventoryV1(context, {}).repositoryLeaseV2;
    try {
      const result = await phase.runTransition(async () => {
        await phase.runAcceptance(async () => {
          await preparePostgresCredentialInventoryScopeV1(context);
          preparation = "keys";
          await preparePostgresCredentialInventoryKeysV1(context, keys);
          preparation = "complete";
          return true;
        });
        return phase.runOperation(() => work(repository));
      });
      await phase.drainAccepted();
      await phase.runFinalization(async () => phase.assertOperationActive());
      await phase.drainAccepted();
      phase.assertCommitReady();
      return result;
    } finally {
      phase.close();
    }
  });
}

const transition = (store, input, options = {}) =>
  storage(
    store,
    input.scope,
    (tx) => transitionRepositoryInventoryV2(tx, input, options.clock ?? clock),
    { ...options, keys: keysFor(input) },
  );
async function staged(store, input, options) {
  const result = await transition(store, input, options);
  assert.equal(result.kind, "staged");
  return result.operation.record;
}
async function subject(store, options) {
  const owner = await seedRuntimeOwner(store);
  const input = cases.reserve(owner, options);
  return { owner, input, record: await staged(store, input) };
}
async function outstanding(store, record, fields) {
  return staged(store, cases.accepted(await staged(store, cases.claim(record)), fields));
}

test(
  "PostgreSQL repository leases: metadata transitions, constraints and uncertain commit",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_REPOSITORY_LEASE_TEST_DATABASE_URL to an empty migrated dedicated database.",
    timeout: 90_000,
  },
  async (t) => {
    const selected = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(selected.hostname));
    assert.match(selected.pathname, /^\/openclaw_inventory_[a-zA-Z0-9_]+$/);
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 6,
      connectionTimeoutMillis: 1000,
    });
    const store = new PostgresPlatformState(pool);
    t.after(() => pool.end());
    const role = await pool.query(
      "SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    assert.deepEqual(role.rows[0], {
      name: "occ_app",
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
    });
    assert.equal(
      await store.read((unit) => unit.installations.getInstallation()),
      undefined,
      "Requires an empty dedicated database; this suite never migrates or resets state.",
    );
    for (const suffix of [
      "access_leases",
      "records",
      "operations",
      "mint_claims",
      "revocation_claims",
      "snapshots",
    ]) {
      const count = await pool.query(
        `SELECT count(*)::int AS count FROM occ.credential_inventory_${suffix}`,
      );
      assert.equal(count.rows[0].count, 0);
    }

    await t.test(
      "concurrent identical reservations and mint claims retain one original attempt",
      async () => {
        const owner = await seedRuntimeOwner(store);
        const input = cases.reserve(owner);
        const reservations = await Promise.all([
          transition(store, input),
          transition(store, input),
        ]);
        assert.deepEqual(reservations.map((r) => r.kind).sort(), ["existing", "staged"]);
        assert.deepEqual(reservations[0].operation, reservations[1].operation);
        const record = reservations[0].operation.record;
        const claim = cases.claim(record);
        const claims = await Promise.all([transition(store, claim), transition(store, claim)]);
        assert.deepEqual(claims.map((r) => r.kind).sort(), ["existing", "staged"]);
        assert.deepEqual(claims[0].operation, claims[1].operation);
        assert.equal(claims.find((r) => r.kind === "existing").nextAction, "reconcile-only");
        assert.equal((await transition(store, cases.claim(record))).kind, "conflict");
        assert.equal(
          (await transition(store, { ...input, bindingRef: cases.ref("changed-alias") })).kind,
          "conflict",
        );
        const count = await pool.query(
          "SELECT count(*)::int AS count FROM occ.credential_inventory_mint_claims WHERE record_ref=$1",
          [record.target.recordRef],
        );
        assert.equal(count.rows[0].count, 1);
        await storage(store, input.scope, async (tx) => {
          assert.equal(
            (await tx.findMintClaim(record.target.recordRef)).providerAttemptRef,
            claim.providerAttemptRef,
          );
          assert.equal((await tx.findRecord(record.target.recordRef)).state, "mint-unknown");
        });
      },
    );

    await t.test(
      "one active mint and two potentially live credentials per access lease",
      async () => {
        const s = await subject(store);
        const second = cases.reserve(s.owner, { lease: s.input.lease });
        assert.equal(
          (await transition(store, second)).kind,
          "capacity",
          "A reserved operation occupies the active mint slot.",
        );
        const first = await outstanding(store, s.record);
        assert.equal(first.disposition, "current-check-required");
        // Two independent callers compete for the second live slot after the first
        // accepted metadata observation frees the active mint slot.
        const competitor = cases.reserve(s.owner, { lease: s.input.lease });
        const raced = await Promise.all([transition(store, second), transition(store, competitor)]);
        assert.deepEqual(raced.map((r) => r.kind).sort(), ["capacity", "staged"]);
        const secondRecord = await outstanding(
          store,
          raced.find((r) => r.kind === "staged").operation.record,
        );
        assert.equal(
          (await transition(store, cases.reserve(s.owner, { lease: s.input.lease }))).kind,
          "capacity",
        );
        await storage(store, s.input.scope, async (tx) => {
          assert.equal((await tx.listLeaseRecords(s.input.lease.accessLeaseRef)).length, 2);
          const capacity = await tx.capacity(s.input.lease.target, s.input.lease.accessLeaseRef);
          assert.equal(capacity.leaseLive, 2);
          assert.equal(capacity.mintActive, false);
        });
        await staged(store, cases.resolve(first));
        await staged(store, cases.reserve(s.owner, { lease: s.input.lease }));
        assert.equal((await transition(store, cases.claim(secondRecord))).kind, "conflict");
      },
    );

    await t.test(
      "stable target holds survive aliases, namespaces, profiles, leases and fresh pools",
      async () => {
        const s = await subject(store);
        let record = await staged(store, cases.claim(s.record));
        const foreignOwner = await seedRuntimeOwner(store);
        const candidates = [
          cases.reserve(s.owner, { target: s.input.lease.target }),
          cases.reserve(foreignOwner, { target: s.input.lease.target }),
        ];
        candidates[0].bindingRef = cases.ref("renamed-alias");
        candidates[0].permissionProfile = { ref: "repository/new-profile", revision: "2" };
        candidates[0].lease.execution.executionGeneration = "2";
        const freshPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
        try {
          const restarted = new PostgresPlatformState(freshPool);
          await storage(restarted, s.input.scope, async (tx) => {
            assert.deepEqual(await tx.findLease(s.input.lease.accessLeaseRef), s.input.lease);
            assert.deepEqual(await tx.findRecord(record.target.recordRef), record);
          });
          for (const candidate of candidates)
            assert.equal((await transition(restarted, candidate)).kind, "target-held");
          record = await staged(restarted, cases.accepted(record));
          record = await staged(
            restarted,
            cases.existing(record, "retireRepositoryToken", {
              evidenceRef: cases.ref("retirement"),
            }),
          );
          assert.equal(record.disposition, "mitigation-only");
          for (const candidate of candidates)
            assert.equal((await transition(restarted, candidate)).kind, "target-held");
          const terminal = await staged(restarted, cases.resolve(record));
          assert.deepEqual(terminal.issuance, s.input);
          await staged(restarted, candidates[1]);
        } finally {
          await freshPool.end();
        }
      },
    );

    await t.test(
      "concurrent namespaces serialize claims against the same stable target",
      async () => {
        const first = await subject(store);
        const second = await subject(store, { target: first.input.lease.target });
        const claims = await Promise.all([
          transition(store, cases.claim(first.record)),
          transition(store, cases.claim(second.record)),
        ]);
        assert.deepEqual(claims.map((result) => result.kind).sort(), ["staged", "target-held"]);
        const mintCount = await pool.query(
          "SELECT count(*)::int AS count FROM occ.credential_inventory_mint_claims WHERE record_ref=ANY($1::text[])",
          [[first.record.target.recordRef, second.record.target.recordRef]],
        );
        assert.equal(mintCount.rows[0].count, 1);

        const claimSubject = await subject(store);
        const foreignOwner = await seedRuntimeOwner(store);
        const reserve = cases.reserve(foreignOwner, { target: claimSubject.input.lease.target });
        const [claimResult, reserveResult] = await Promise.all([
          transition(store, cases.claim(claimSubject.record)),
          transition(store, reserve),
        ]);
        assert.equal(claimResult.kind, "staged");
        // Either reservation serializes before the claim, or observes its hold.
        // In both valid serial orders the second namespace cannot claim a mint.
        assert.ok(["staged", "target-held"].includes(reserveResult.kind));
        if (reserveResult.kind === "staged") {
          assert.equal(
            (await transition(store, cases.claim(reserveResult.operation.record))).kind,
            "target-held",
          );
        }
      },
    );

    await t.test("original lease ownership, Work, receiver and target are immutable", async () => {
      const s = await subject(store);
      for (const change of [
        (lease) => {
          lease.work.revision += 1;
        },
        (lease) => {
          lease.execution.receiverRef = cases.ref("other-receiver");
        },
        (lease) => {
          lease.target.repositoryId = "99999999999999999999";
        },
        (lease) => {
          lease.original.operationRef = cases.ref("other-original");
        },
      ]) {
        const lease = structuredClone(s.input.lease);
        change(lease);
        assert.equal((await transition(store, cases.reserve(s.owner, { lease }))).kind, "conflict");
      }
      await storage(store, s.input.scope, async (tx) =>
        assert.deepEqual(await tx.findLease(s.input.lease.accessLeaseRef), s.input.lease),
      );
    });

    await t.test(
      "late or broader accepted observations retain cleanup metadata and hold the target",
      async () => {
        for (const mode of ["late", "broader"]) {
          const s = await subject(store);
          const claimed = await staged(store, cases.claim(s.record));
          const input = cases.accepted(
            claimed,
            mode === "broader"
              ? {
                  returnedPermissions: {
                    metadata: "read",
                    contents: "read",
                    administration: "admin",
                  },
                }
              : {},
          );
          const observationClock =
            mode === "late"
              ? {
                  read: () => ({ now: Date.parse(s.input.deadline) + 1, uncertaintyMs: 0 }),
                }
              : clock;
          const record = await staged(store, input, { clock: observationClock });
          assert.equal(record.disposition, "mitigation-only");
          assert.equal(record.tokenRef, input.tokenRef);
          assert.equal(record.protectedRevocationRef, input.protectedRevocationRef);
          assert.deepEqual(record.returnedPermissions, input.returnedPermissions);
          assert.equal(
            (await transition(store, cases.reserve(s.owner, { target: s.input.lease.target })))
              .kind,
            "target-held",
          );
        }
      },
    );

    await t.test(
      "unavailable returned permissions persist distinctly from an empty map and remain cleanup-only",
      async () => {
        const observations = [];
        for (const returnedPermissions of [{ kind: "unavailable" }, {}]) {
          const s = await subject(store);
          const claimed = await staged(store, cases.claim(s.record));
          // This is an accepted-material metadata observation with a fixed custody
          // identity. A positive scope flag cannot fill in absent permission data.
          const input = cases.accepted(claimed, { returnedPermissions, scopeAccepted: true });
          const record = await staged(store, input);
          assert.equal(record.state, "outstanding");
          assert.equal(record.disposition, "mitigation-only");
          assert.equal(record.tokenRef, input.tokenRef);
          assert.equal(record.protectedRevocationRef, input.protectedRevocationRef);
          assert.deepEqual(record.returnedPermissions, returnedPermissions);
          observations.push(record.returnedPermissions);

          // Exercise both strict codecs: malformed sentinels must not be read as
          // an unavailable observation or quietly coerced into a permissions map.
          for (const malformed of [
            { kind: "unavailable", metadata: "read" },
            { kind: "unknown" },
          ]) {
            assert.throws(() =>
              parseRepositoryTokenMutationV2({ ...input, returnedPermissions: malformed }),
            );
            assert.throws(() =>
              parseRepositoryTokenRecordV2({ ...record, returnedPermissions: malformed }),
            );
          }

          const freshPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
          try {
            const restarted = new PostgresPlatformState(freshPool);
            await storage(restarted, s.input.scope, async (tx) => {
              assert.deepEqual(await tx.findRecord(record.target.recordRef), record);
              assert.deepEqual(
                (await tx.findOperation(input.operationRef)).input.returnedPermissions,
                returnedPermissions,
              );
              const capacity = await tx.capacity(
                s.input.lease.target,
                s.input.lease.accessLeaseRef,
              );
              assert.equal(capacity.targetHeld, true);
              assert.equal(capacity.leaseLive, 1);
            });
            assert.equal(
              (
                await transition(
                  restarted,
                  cases.reserve(s.owner, { target: s.input.lease.target }),
                )
              ).kind,
              "target-held",
            );
            const cleanup = await staged(restarted, cases.claimRevocation(record));
            assert.deepEqual(cleanup.returnedPermissions, returnedPermissions);
            const resolved = await staged(restarted, cases.recordRevocation(cleanup, "confirmed"));
            assert.equal(resolved.state, "resolved-without-token");
            await storage(restarted, s.input.scope, async (tx) => {
              const capacity = await tx.capacity(
                s.input.lease.target,
                s.input.lease.accessLeaseRef,
              );
              assert.equal(capacity.targetHeld, false);
              assert.equal(capacity.leaseLive, 0);
              // Terminal cleanup does not erase the original permission observation.
              assert.deepEqual(
                (await tx.findOperation(input.operationRef)).record.returnedPermissions,
                returnedPermissions,
              );
            });
          } finally {
            await freshPool.end();
          }
        }
        assert.notDeepEqual(observations[0], observations[1]);
      },
    );

    await t.test(
      "contradictory expiry preserves known cleanup references without freeing a hold",
      async () => {
        const s = await subject(store);
        const claimed = await staged(store, cases.claim(s.record));
        const evidencedExpiry = cases.expiry();
        const unknownInput = cases.existing(claimed, "recordRepositoryMint", {
          providerAttemptRef: claimed.providerAttemptRef,
          evidenceRef: cases.ref("unknown-observation"),
          outcome: "unknown",
          expiry: evidencedExpiry,
        });
        const unknown = await staged(store, unknownInput);
        for (const expiry of [
          { kind: "expiry-unproven" },
          cases.expiry(Date.parse(evidencedExpiry.expiresAt) - 1000),
        ]) {
          const changed = cases.existing(unknown, "recordRepositoryMint", {
            providerAttemptRef: unknown.providerAttemptRef,
            evidenceRef: cases.ref("changed-unknown"),
            outcome: "unknown",
            expiry,
          });
          assert.equal((await transition(store, changed)).kind, "conflict");
        }
        const accepted = cases.accepted(unknown, {
          expiry: cases.expiry(Date.parse(evidencedExpiry.expiresAt) - 1000),
        });
        const record = await staged(store, accepted);
        assert.equal(record.disposition, "mitigation-only");
        assert.deepEqual(record.expiry, { kind: "expiry-unproven" });
        assert.equal(record.tokenRef, accepted.tokenRef);
        assert.equal(record.protectedRevocationRef, accepted.protectedRevocationRef);
        await storage(store, s.input.scope, async (tx) => {
          assert.deepEqual(
            (await tx.findOperation(unknownInput.operationRef)).record.expiry,
            evidencedExpiry,
          );
          assert.deepEqual(
            (await tx.findOperation(accepted.operationRef)).input.expiry,
            accepted.expiry,
          );
          assert.equal(
            (await tx.capacity(s.input.lease.target, s.input.lease.accessLeaseRef)).targetHeld,
            true,
          );
        });
      },
    );

    await t.test(
      "resolution requires original evidenced expiry and conservative uncertainty",
      async () => {
        const s = await subject(store);
        const record = await outstanding(store, s.record);
        const resolved = cases.resolve(record, {
          outcome: "expired",
          expiry: record.expiry,
          uncertaintyMs: 2000,
        });
        assert.equal((await transition(store, resolved)).kind, "conflict");
        const afterExpiry = {
          read: () => ({ now: Date.parse(record.expiry.expiresAt) + 1999, uncertaintyMs: 0 }),
        };
        assert.equal((await transition(store, resolved, { clock: afterExpiry })).kind, "conflict");
        const safe = {
          read: () => ({ now: Date.parse(record.expiry.expiresAt) + 2000, uncertaintyMs: 0 }),
        };
        const invented = {
          ...resolved,
          expiry: { ...record.expiry, evidenceRef: cases.ref("different-expiry") },
        };
        assert.equal((await transition(store, invented, { clock: safe })).kind, "conflict");
        const terminal = await staged(store, resolved, { clock: safe });
        assert.equal(terminal.state, "resolved-without-token");
        await storage(store, s.input.scope, async (tx) => {
          assert.equal(
            (await tx.capacity(s.input.lease.target, s.input.lease.accessLeaseRef)).leaseLive,
            0,
          );
          assert.deepEqual((await tx.findRecord(record.target.recordRef)).expiry, record.expiry);
        });
        await staged(store, cases.reserve(s.owner, { lease: s.input.lease }));
        const unknown = await subject(store);
        const unproven = await staged(store, cases.claim(unknown.record));
        assert.equal(
          (
            await transition(
              store,
              cases.resolve(unproven, {
                outcome: "expired",
                expiry: cases.expiry(Date.now() - 10_000),
                uncertaintyMs: 0,
              }),
            )
          ).kind,
          "conflict",
        );
      },
    );

    await t.test(
      "expired reservation can be resolved without inventing a provider attempt",
      async () => {
        const s = await subject(store);
        const afterDeadline = {
          read: () => ({ now: Date.parse(s.input.deadline), uncertaintyMs: 0 }),
        };
        assert.equal(
          (await transition(store, cases.claim(s.record), { clock: afterDeadline })).kind,
          "expired",
        );
        const terminal = await staged(
          store,
          cases.resolve(s.record, { outcome: "definitely-not-dispatched" }),
        );
        assert.equal(terminal.providerAttemptRef, null);
        assert.equal(terminal.state, "not-issued");
        await storage(store, s.input.scope, async (tx) =>
          assert.equal(await tx.findMintClaim(s.record.target.recordRef), undefined),
        );
        await staged(store, cases.reserve(s.owner, { lease: s.input.lease }));
        const claimed = await subject(store);
        const unknown = await staged(store, cases.claim(claimed.record));
        assert.equal(
          (
            await transition(
              store,
              cases.resolve(unknown, { outcome: "definitely-not-dispatched" }),
            )
          ).kind,
          "conflict",
        );
      },
    );

    await t.test(
      "enriched mint claim retains exact immutable custody identity after pool restart",
      async () => {
        const s = await subject(store);
        const input = cases.claim(s.record);
        const claimed = await staged(store, input);
        const expected = {
          schemaVersion: 2,
          custodyIdentity: input.custodyIdentity,
          issuanceOperationRef: s.record.target.issuanceOperationRef,
          recordRef: s.record.target.recordRef,
          issuanceIntentDigest: s.record.target.intentDigest,
          useOperationRef: input.operationRef,
          useIntentDigest: repositoryInventoryDigestV2(input),
          providerAttemptRef: input.providerAttemptRef,
          inventoryVersion: claimed.inventoryVersion,
        };
        const freshPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
        try {
          const restarted = new PostgresPlatformState(freshPool);
          await storage(restarted, s.input.scope, async (tx) => {
            assert.deepEqual(await tx.findMintClaim(s.record.target.recordRef), expected);
            assert.deepEqual((await tx.findOperation(input.operationRef)).input, input);
          });
          const replay = await transition(restarted, input);
          assert.equal(replay.kind, "existing");
          assert.equal(replay.nextAction, "reconcile-only");
          const result = await staged(restarted, cases.accepted(claimed));
          assert.equal(result.tokenRef, expected.custodyIdentity.tokenRef);
          assert.equal(
            result.protectedRevocationRef,
            expected.custodyIdentity.protectedRevocationRef,
          );
        } finally {
          await freshPool.end();
        }
      },
    );

    await t.test(
      "mint identity rejects another lease, key binding or accepted token reference",
      async () => {
        const s = await subject(store);
        for (const mutate of [
          (identity) => {
            identity.lease.work.revision += 1;
          },
          (identity) => {
            identity.key.bindingRef = cases.ref("foreign-key-binding");
          },
        ]) {
          const input = structuredClone(cases.claim(s.record));
          mutate(input.custodyIdentity);
          assert.equal((await transition(store, input)).kind, "conflict");
        }
        await storage(store, s.input.scope, async (tx) =>
          assert.equal(await tx.findMintClaim(s.record.target.recordRef), undefined),
        );
        const claim = cases.claim(s.record);
        const claimed = await staged(store, claim);
        for (const fields of [
          { tokenRef: cases.ref("foreign-token") },
          { protectedRevocationRef: cases.ref("foreign-revocation") },
        ]) {
          assert.equal((await transition(store, cases.accepted(claimed, fields))).kind, "conflict");
        }
        await storage(store, s.input.scope, async (tx) =>
          assert.deepEqual(await tx.findRecord(s.record.target.recordRef), claimed),
        );
        await staged(store, cases.accepted(claimed));
      },
    );

    await t.test(
      "post-claim definitely-not-dispatched outcome requires the original attempt and CAS",
      async () => {
        const s = await subject(store);
        const claim = cases.claim(s.record);
        const claimed = await staged(store, claim);
        const outcome = cases.existing(claimed, "recordRepositoryMint", {
          providerAttemptRef: claim.providerAttemptRef,
          evidenceRef: cases.ref("not-dispatched-observation"),
          outcome: "definitely-not-dispatched",
        });
        assert.equal(
          (await transition(store, { ...outcome, providerAttemptRef: cases.ref("other-attempt") }))
            .kind,
          "conflict",
        );
        assert.equal(
          (
            await transition(store, {
              ...outcome,
              expectedInventoryVersion: s.record.inventoryVersion,
            })
          ).kind,
          "conflict",
        );
        const terminal = await staged(store, outcome);
        assert.equal(terminal.state, "not-issued");
        assert.equal(terminal.providerAttemptRef, claim.providerAttemptRef);
        assert.equal(terminal.disposition, "resolved-no-live-token");
        await storage(store, s.input.scope, async (tx) => {
          assert.deepEqual(
            (await tx.findMintClaim(s.record.target.recordRef)).custodyIdentity,
            claim.custodyIdentity,
          );
          assert.equal(
            (await tx.capacity(s.input.lease.target, s.input.lease.accessLeaseRef)).leaseLive,
            0,
          );
        });
        await staged(store, cases.reserve(s.owner, { lease: s.input.lease }));
        assert.equal(
          (await transition(store, { ...outcome, operationRef: cases.ref("second-terminal") }))
            .kind,
          "conflict",
        );
      },
    );

    await t.test(
      "V2 claim reader refuses legacy seven-field metadata without guessing custody",
      async () => {
        const s = await subject(store);
        const input = cases.claim(s.record);
        const legacy = {
          issuanceOperationRef: s.record.target.issuanceOperationRef,
          recordRef: s.record.target.recordRef,
          issuanceIntentDigest: s.record.target.intentDigest,
          useOperationRef: input.operationRef,
          useIntentDigest: repositoryInventoryDigestV2(input),
          providerAttemptRef: input.providerAttemptRef,
          inventoryVersion: s.record.inventoryVersion + 1,
        };
        await assert.rejects(storage(store, s.input.scope, (tx) => tx.insertMintClaim(legacy)));
        await storage(store, s.input.scope, async (tx) =>
          assert.equal(await tx.findMintClaim(s.record.target.recordRef), undefined),
        );
        // The shared journal permits V1 documents. Place one against a V2 record
        // deliberately to exercise the V2 reader's refusal of missing identity.
        await pool.query(
          "INSERT INTO occ.credential_inventory_mint_claims (installation_id,namespace_id,agent_id,record_ref,use_operation_ref,provider_attempt_ref,document) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
          [
            s.input.scope.installationId,
            s.input.scope.namespaceId,
            s.input.scope.agentId,
            legacy.recordRef,
            legacy.useOperationRef,
            legacy.providerAttemptRef,
            JSON.stringify(legacy),
          ],
        );
        await assert.rejects(
          storage(store, s.input.scope, (tx) => tx.findMintClaim(s.record.target.recordRef)),
        );
        await assert.rejects(transition(store, input));
        const raw = await pool.query(
          "SELECT document FROM occ.credential_inventory_mint_claims WHERE record_ref=$1",
          [legacy.recordRef],
        );
        assert.deepEqual(raw.rows[0].document, legacy);
        await storage(store, s.input.scope, async (tx) => {
          assert.deepEqual(await tx.findRecord(s.record.target.recordRef), s.record);
          assert.equal(await tx.findOperation(input.operationRef), undefined);
        });
      },
    );

    await t.test(
      "concurrent cleanup claims keep one attempt; restart and unknown retain the target hold",
      async () => {
        const s = await subject(store);
        const record = await outstanding(store, s.record);
        const firstInput = cases.claimRevocation(record);
        const competitor = cases.claimRevocation(record);
        const results = await Promise.all([
          transition(store, firstInput),
          transition(store, competitor),
        ]);
        assert.deepEqual(results.map((result) => result.kind).sort(), ["conflict", "staged"]);
        const winner = results.find((result) => result.kind === "staged").operation;
        const claimed = winner.record;
        assert.equal(claimed.revocation.state, "claimed");
        assert.equal(claimed.revocation.version, 1);
        assert.equal(
          Date.parse(claimed.revocation.claimNotAfter) - Date.parse(claimed.revocation.claimedAt),
          5000,
        );
        assert.equal(claimed.disposition, "mitigation-only");
        const count = await pool.query(
          "SELECT count(*)::int AS count FROM occ.credential_inventory_revocation_claims WHERE record_ref=$1",
          [record.target.recordRef],
        );
        assert.equal(count.rows[0].count, 1);
        const freshPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
        try {
          const restarted = new PostgresPlatformState(freshPool);
          await storage(restarted, s.input.scope, async (tx) => {
            const claim = await tx.findRevocationClaim(claimed.revocation.claimRef);
            assert.deepEqual(claim, {
              schemaVersion: 2,
              input: winner.input,
              claimRef: claimed.revocation.claimRef,
              claimVersion: claimed.revocation.claimVersion,
              providerAttemptRef: claimed.revocation.providerAttemptRef,
              claimedAt: claimed.revocation.claimedAt,
              claimNotAfter: claimed.revocation.claimNotAfter,
            });
          });
          const replay = await transition(restarted, winner.input);
          assert.equal(replay.kind, "existing");
          assert.equal(replay.nextAction, "reconcile-only");
          const unknown = await staged(restarted, cases.recordRevocation(claimed, "unknown"));
          assert.equal(unknown.state, "outstanding");
          assert.equal(unknown.revocation.version, 2);
          assert.equal(unknown.disposition, "mitigation-only");
          assert.equal(
            (await transition(restarted, cases.reserve(s.owner, { target: s.input.lease.target })))
              .kind,
            "target-held",
          );
          // Retry records cleanup responsibility for the same provider attempt.
          const retry = await staged(restarted, cases.claimRevocation(unknown));
          assert.equal(retry.revocation.version, 3);
          assert.equal(retry.revocation.providerAttemptRef, claimed.revocation.providerAttemptRef);
          const confirmed = await staged(restarted, cases.recordRevocation(retry));
          assert.equal(confirmed.state, "resolved-without-token");
          assert.equal(confirmed.revocation.state, "confirmed");
          assert.equal(confirmed.revocation.version, 4);
          await storage(restarted, s.input.scope, async (tx) => {
            const capacity = await tx.capacity(s.input.lease.target, s.input.lease.accessLeaseRef);
            assert.equal(capacity.leaseLive, 0);
            assert.equal(capacity.targetHeld, false);
          });
          await staged(restarted, cases.reserve(s.owner, { target: s.input.lease.target }));
        } finally {
          await freshPool.end();
        }
      },
    );

    await t.test(
      "expired cleanup claim takeover keeps its attempt and accepts an exact older confirmation",
      async () => {
        const s = await subject(store);
        const record = await outstanding(store, s.record);
        const claimed = await staged(store, cases.claimRevocation(record));
        const retryInput = cases.claimRevocation(claimed);
        const before = {
          read: () => ({ now: Date.parse(claimed.revocation.claimNotAfter) - 1, uncertaintyMs: 0 }),
        };
        assert.equal((await transition(store, retryInput, { clock: before })).kind, "conflict");
        const uncertain = {
          read: () => ({
            now: Date.parse(claimed.revocation.claimNotAfter) + 1000,
            uncertaintyMs: 1001,
          }),
        };
        assert.equal((await transition(store, retryInput, { clock: uncertain })).kind, "conflict");
        const expired = {
          read: () => ({ now: Date.parse(claimed.revocation.claimNotAfter), uncertaintyMs: 0 }),
        };
        const retry = await staged(store, retryInput, { clock: expired });
        assert.notEqual(retry.revocation.claimRef, claimed.revocation.claimRef);
        assert.equal(retry.revocation.providerAttemptRef, claimed.revocation.providerAttemptRef);
        assert.equal(retry.revocation.version, claimed.revocation.version + 1);
        assert.equal(retry.revocation.claimVersion, retry.revocation.version);
        for (const outcome of ["unknown", "not-dispatched"]) {
          const staleOutcome = cases.recordRevocation(claimed, outcome, {
            expectedInventoryVersion: retry.inventoryVersion,
          });
          assert.equal(
            (await transition(store, staleOutcome, { clock: expired })).kind,
            "conflict",
          );
        }
        // A delayed result for the original claim cannot overwrite newer state
        // without current record CAS. Exact confirmation still resolves its same attempt.
        assert.equal((await transition(store, cases.recordRevocation(claimed))).kind, "conflict");
        const oldConfirmation = cases.recordRevocation(claimed, "confirmed", {
          expectedInventoryVersion: retry.inventoryVersion,
        });
        const confirmed = await staged(store, oldConfirmation, { clock: expired });
        assert.equal(confirmed.state, "resolved-without-token");
        assert.equal(
          confirmed.revocation.providerAttemptRef,
          claimed.revocation.providerAttemptRef,
        );
        await storage(store, s.input.scope, async (tx) => {
          assert.equal(
            (await tx.findRevocationClaim(claimed.revocation.claimRef)).providerAttemptRef,
            claimed.revocation.providerAttemptRef,
          );
          assert.equal(
            (await tx.findRevocationClaim(retry.revocation.claimRef)).providerAttemptRef,
            claimed.revocation.providerAttemptRef,
          );
        });
      },
    );

    await t.test(
      "cleanup rejects wrong record, material, claim, attempt and version without releasing holds",
      async () => {
        const s = await subject(store);
        const record = await outstanding(store, s.record);
        for (const fields of [
          { tokenRef: cases.ref("other-token") },
          { protectedRevocationRef: cases.ref("other-revocation") },
          { expectedRevocationVersion: 1 },
        ]) {
          assert.equal(
            (await transition(store, cases.claimRevocation(record, fields))).kind,
            "conflict",
          );
        }
        const claimed = await staged(store, cases.claimRevocation(record));
        const other = await subject(store);
        const otherRecord = await outstanding(store, other.record);
        for (const fields of [
          { target: otherRecord.target },
          { tokenRef: cases.ref("other-token") },
          { protectedRevocationRef: cases.ref("other-revocation") },
          { revocationOperationRef: cases.ref("other-revocation-operation") },
          { claimRef: cases.ref("other-claim") },
          { claimVersion: claimed.revocation.claimVersion + 1 },
          { providerAttemptRef: cases.ref("other-provider-attempt") },
          { expectedInventoryVersion: record.inventoryVersion },
        ]) {
          assert.equal(
            (await transition(store, cases.recordRevocation(claimed, "confirmed", fields))).kind,
            "conflict",
          );
        }
        const notDispatched = await staged(
          store,
          cases.recordRevocation(claimed, "not-dispatched"),
        );
        assert.equal(notDispatched.state, "outstanding");
        assert.equal(notDispatched.disposition, "mitigation-only");
        assert.equal(notDispatched.revocation.state, "not-dispatched");
        const wrongAttempt = cases.claimRevocation(notDispatched, {
          previousAttempt: {
            kind: "reconcile",
            providerAttemptRef: cases.ref("different-attempt"),
            providerOutcome: "not-dispatched",
          },
        });
        assert.equal((await transition(store, wrongAttempt)).kind, "conflict");
        const retried = await staged(store, cases.claimRevocation(notDispatched));
        assert.equal(retried.revocation.providerAttemptRef, claimed.revocation.providerAttemptRef);
        assert.equal(retried.revocation.priorOutcome, "not-dispatched");
        await storage(store, s.input.scope, async (tx) => {
          assert.equal(
            (await tx.capacity(s.input.lease.target, s.input.lease.accessLeaseRef)).targetHeld,
            true,
          );
          assert.deepEqual(await tx.findRecord(record.target.recordRef), retried);
        });
      },
    );

    await t.test(
      "caught malformed cleanup claim poisons the phase and rolls back claim and projection",
      async () => {
        const s = await subject(store);
        const record = await outstanding(store, s.record);
        const input = cases.claimRevocation(record);
        let claimRef;
        const effects = [];
        await assert.rejects(
          storage(
            store,
            s.input.scope,
            async (tx) => {
              const result = await transitionRepositoryInventoryV2(tx, input, clock);
              assert.equal(result.kind, "staged");
              claimRef = result.operation.record.revocation.claimRef;
              const claim = await tx.findRevocationClaim(claimRef);
              await assert.rejects(tx.appendRevocationClaim({ ...claim, claimVersion: 0 }));
            },
            { keys: keysFor(input), effects },
          ),
        );
        assert.ok(effects.some((effect) => effect.kind === "repository-revocation-claim-appended"));
        await storage(store, s.input.scope, async (tx) => {
          assert.equal(await tx.findRevocationClaim(claimRef), undefined);
          assert.equal(await tx.findOperation(input.operationRef), undefined);
          assert.deepEqual(await tx.findRecord(record.target.recordRef), record);
        });
      },
    );

    await t.test(
      "claim caller mutation during a real awaited SELECT cannot rewrite its snapshot",
      async () => {
        const s = await subject(store);
        const input = cases.claim(s.record);
        const claim = {
          schemaVersion: 2,
          custodyIdentity: structuredClone(input.custodyIdentity),
          issuanceOperationRef: s.record.target.issuanceOperationRef,
          recordRef: s.record.target.recordRef,
          issuanceIntentDigest: s.record.target.intentDigest,
          useOperationRef: input.operationRef,
          useIntentDigest: repositoryInventoryDigestV2(input),
          providerAttemptRef: input.providerAttemptRef,
          inventoryVersion: s.record.inventoryVersion + 1,
        };
        const original = structuredClone(claim);
        const effects = [];
        let mutated = false;
        await storage(store, s.input.scope, (tx) => tx.insertMintClaim(claim), {
          keys: keysFor(input),
          effects,
          afterQuery(statement) {
            // Only caller-owned data changes after the real SELECT completes.
            // Its real rows and all subsequent database queries remain untouched.
            if (
              !mutated &&
              statement.startsWith("SELECT document FROM occ.credential_inventory_records")
            ) {
              mutated = true;
              claim.providerAttemptRef = cases.ref("mutated-attempt");
              claim.useOperationRef = cases.ref("mutated-operation");
              claim.useIntentDigest = `sha256:${"b".repeat(64)}`;
              claim.custodyIdentity.key.immutableVersion = "key/mutated";
              claim.custodyIdentity.tokenRef = cases.ref("mutated-token");
            }
          },
        });
        assert.equal(mutated, true);
        assert.notDeepEqual(claim, original);
        await storage(store, s.input.scope, async (tx) =>
          assert.deepEqual(await tx.findMintClaim(s.record.target.recordRef), original),
        );
        assert.deepEqual(effects, [{ kind: "repository-mint-claim-inserted", claim: original }]);
      },
    );

    await t.test(
      "caught stale CAS rolls back an earlier replacement in the same phase",
      async () => {
        const s = await subject(store);
        const first = await outstanding(store, s.record);
        await assert.rejects(
          storage(
            store,
            s.input.scope,
            async (tx) => {
              const retired = await transitionRepositoryInventoryV2(
                tx,
                cases.existing(first, "retireRepositoryToken", {
                  evidenceRef: cases.ref("retire"),
                }),
                clock,
              );
              assert.equal(retired.kind, "staged");
              await assert.rejects(
                tx.replaceRecord(first.inventoryVersion, retired.operation.record),
              );
            },
            { keys: { ...emptyKeys(), records: [first.target.recordRef] } },
          ),
        );
        await storage(store, s.input.scope, async (tx) =>
          assert.deepEqual(await tx.findRecord(first.target.recordRef), first),
        );
      },
    );

    await t.test(
      "caught malformed post-write data poisons the actual owner phase and rolls back",
      async () => {
        const owner = await seedRuntimeOwner(store);
        const input = cases.reserve(owner);
        let stagedRecord;
        await assert.rejects(
          storage(
            store,
            input.scope,
            async (tx) => {
              const result = await transitionRepositoryInventoryV2(tx, input, clock);
              assert.equal(result.kind, "staged");
              stagedRecord = result.operation.record;
              // Failure occurs in the real repository parser after prior writes. Catching
              // the rejection cannot make the poisoned owner commit those earlier rows.
              await assert.rejects(tx.appendOperation({ ...result.operation, digest: "invalid" }));
            },
            { keys: keysFor(input) },
          ),
        );
        await storage(store, input.scope, async (tx) => {
          assert.equal(await tx.findLease(input.lease.accessLeaseRef), undefined);
          assert.equal(await tx.findRecord(stagedRecord.target.recordRef), undefined);
          assert.equal(await tx.findOperation(input.operationRef), undefined);
        });
      },
    );

    await t.test(
      "20-digit target IDs stay exact and SQL rejects noncanonical numeric IDs",
      async () => {
        const owner = await seedRuntimeOwner(store);
        const target = {
          installationId: owner.installation.id,
          githubHost: "github.com",
          appId: "12345678901234567890",
          githubInstallationId: "23456789012345678901",
          repositoryId: "34567890123456789012",
        };
        const input = cases.reserve(owner, { target });
        await staged(store, input);
        const row = await pool.query(
          "SELECT stable_target_digest,document FROM occ.credential_inventory_access_leases WHERE installation_id=$1 AND access_lease_ref=$2",
          [owner.installation.id, input.lease.accessLeaseRef],
        );
        assert.equal(row.rows[0].stable_target_digest, repositoryTargetDigestV2(target));
        assert.deepEqual(row.rows[0].document.target, target);
        // Compute the digest in PostgreSQL even for intentionally invalid IDs so
        // rejection proves the canonical-ID constraint, rather than a stale hash.
        for (const field of ["appId", "githubInstallationId", "repositoryId"]) {
          for (const invalid of ["0123", "12x"]) {
            const lease = structuredClone(input.lease);
            lease.accessLeaseRef = cases.ref("invalid-lease");
            lease.target[field] = invalid;
            const encoded = [
              lease.target.installationId,
              lease.target.githubHost,
              lease.target.appId,
              lease.target.githubInstallationId,
              lease.target.repositoryId,
            ].join("\n");
            await assert.rejects(
              pool.query(
                "INSERT INTO occ.credential_inventory_access_leases (installation_id,namespace_id,agent_id,access_lease_ref,stable_target_digest,document) VALUES ($1,$2,$3,$4,'sha256:' || encode(sha256(convert_to($5,'UTF8')),'hex'),$6::jsonb)",
                [
                  input.scope.installationId,
                  input.scope.namespaceId,
                  input.scope.agentId,
                  lease.accessLeaseRef,
                  encoded,
                  JSON.stringify(lease),
                ],
              ),
              { code: "23514", constraint: "credential_inventory_access_leases_identity" },
            );
          }
        }
      },
    );

    await t.test(
      "database enforces live slots, active mint, lease correspondence and application grants",
      async () => {
        const s = await subject(store);
        // Direct INSERT probes bypass the transition intentionally: constraints must
        // defend persisted metadata even when a writer omits an application check.
        const insertRecord = (input, liveSlot, leaseRef = input.lease.accessLeaseRef) => {
          const record = {
            ...s.record,
            issuance: input,
            target: {
              issuanceOperationRef: input.operationRef,
              recordRef: cases.ref("sql-record"),
              intentDigest: repositoryInventoryDigestV2(input),
            },
          };
          return pool.query(
            "INSERT INTO occ.credential_inventory_records (installation_id,namespace_id,agent_id,record_ref,inventory_version,binding_ref,live,unresolved,document,target_held,schema_version,stable_target_digest,access_lease_ref,live_slot,mint_active) VALUES ($1,$2,$3,$4,1,$5,true,true,$6::jsonb,false,2,$7,$8,$9,true)",
            [
              input.scope.installationId,
              input.scope.namespaceId,
              input.scope.agentId,
              record.target.recordRef,
              input.bindingRef,
              JSON.stringify(record),
              repositoryTargetDigestV2(input.lease.target),
              leaseRef,
              liveSlot,
            ],
          );
        };
        // The first credential no longer has an active mint, isolating the live
        // slot constraint from the separate active-mint uniqueness constraint.
        await outstanding(store, s.record);
        await assert.rejects(insertRecord(cases.reserve(s.owner, { lease: s.input.lease }), 1), {
          code: "23505",
          constraint: "credential_inventory_records_lease_live_slot",
        });
        const active = await subject(store);
        await assert.rejects(
          insertRecord(cases.reserve(active.owner, { lease: active.input.lease }), 2),
          { code: "23505", constraint: "credential_inventory_records_lease_active_mint" },
        );
        for (const invalidSlot of [3, null]) {
          await assert.rejects(
            insertRecord(cases.reserve(s.owner, { lease: s.input.lease }), invalidSlot),
            {
              code: "23514",
              constraint: "credential_inventory_records_identity",
            },
          );
        }
        const changed = structuredClone(s.input.lease);
        changed.work.revision = 2;
        await assert.rejects(insertRecord(cases.reserve(s.owner, { lease: changed }), 2), {
          code: "23514",
        });
        await assert.rejects(
          insertRecord(cases.reserve(s.owner), 2, s.input.lease.accessLeaseRef),
          { code: "23514" },
        );
        for (const table of ["access_leases", "records", "operations", "mint_claims"]) {
          const name = `occ.credential_inventory_${table}`;
          const grants = await pool.query(
            "SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT') AS insert,has_table_privilege(current_user,$1,'UPDATE') AS broad_update,has_table_privilege(current_user,$1,'DELETE') AS delete",
            [name],
          );
          assert.deepEqual(grants.rows[0], {
            read: true,
            insert: true,
            broad_update: false,
            delete: false,
          });
          await assert.rejects(pool.query(`DELETE FROM ${name}`), { code: "42501" });
        }
        await assert.rejects(
          pool.query(
            "UPDATE occ.credential_inventory_access_leases SET access_lease_ref=access_lease_ref WHERE access_lease_ref=$1",
            [s.input.lease.accessLeaseRef],
          ),
          { code: "55000" },
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.credential_inventory_access_leases SET document=document WHERE access_lease_ref=$1",
            [s.input.lease.accessLeaseRef],
          ),
          { code: "42501" },
        );
        await storage(store, s.input.scope, async (tx) => {
          assert.deepEqual(await tx.findLease(s.input.lease.accessLeaseRef), s.input.lease);
          assert.equal((await tx.listLeaseRecords(s.input.lease.accessLeaseRef)).length, 1);
        });
      },
    );

    await t.test(
      "lost real COMMIT acknowledgment retains original claim and blocks replacement mint",
      async () => {
        const s = await subject(store);
        const claim = cases.claim(s.record);
        const commitRef = cases.ref("uncertain-commit");
        const proxy = await runtimeCommitAckProxy(databaseUrl);
        const faultPool = new pg.Pool({
          connectionString: proxy.url,
          max: 1,
          connectionTimeoutMillis: 1000,
          query_timeout: 5000,
        });
        faultPool.on("error", () => {});
        try {
          proxy.arm();
          await assert.rejects(
            transition(new PostgresPlatformState(faultPool), claim, { commitRef }),
            PostgresCommitOutcomeUnknownError,
          );
          assert.equal(
            proxy.observedCommit,
            true,
            "The actual PostgreSQL server committed; its acknowledgment was lost in transport.",
          );
          const freshPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
          try {
            const restarted = new PostgresPlatformState(freshPool);
            const replay = await transition(restarted, claim);
            assert.equal(replay.kind, "existing");
            assert.equal(replay.nextAction, "reconcile-only");
            assert.equal(replay.operation.commitRef, commitRef);
            assert.deepEqual(replay.operation.input, claim);
            assert.deepEqual(replay.operation.record.issuance, s.input);
            assert.equal(Object.hasOwn(replay.operation, "originalReceipt"), false);
            await storage(restarted, s.input.scope, async (tx) => {
              assert.deepEqual(
                await tx.findRecord(s.record.target.recordRef),
                replay.operation.record,
              );
              assert.equal(
                (await tx.findMintClaim(s.record.target.recordRef)).providerAttemptRef,
                claim.providerAttemptRef,
              );
            });
            assert.equal(
              (await transition(restarted, cases.claim(replay.operation.record))).kind,
              "conflict",
            );
            assert.equal(
              (
                await transition(
                  restarted,
                  cases.reserve(s.owner, { target: s.input.lease.target }),
                )
              ).kind,
              "target-held",
            );
          } finally {
            await freshPool.end();
          }
          const count = await pool.query(
            "SELECT count(*)::int AS count FROM occ.credential_inventory_mint_claims WHERE record_ref=$1",
            [s.record.target.recordRef],
          );
          assert.equal(count.rows[0].count, 1);
        } finally {
          await faultPool.end();
          await proxy.close();
        }
      },
    );
  },
);
