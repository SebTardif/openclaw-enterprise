import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import pg from "pg";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";
import {
  changedIncoming,
  commonAttemptRecord,
  deferred,
  eventLookup,
  incomingLookup,
  journalHarness,
  journalValues,
  ref,
  seedJournalOwner,
} from "../fixtures/turn-journal-storage/values.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const options = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL for real PostgreSQL turn journal commit, transport-fault and process-reopen integration.",
  timeout: 120_000,
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const valueOf = (result) => {
  assert.equal(result.kind, "committed");
  return result.value;
};
const admit = (h, v) =>
  h.write((j) => j.admit(h.issue("admission", v.observation), h.call)).then(valueOf);
const dispatch = (h, v) =>
  h.write((j) => j.recordDispatchIntent(h.issue("dispatch", v.binding), h.call)).then(valueOf);

function separateProcess(action, values) {
  const fixtureUrl = new URL("../fixtures/turn-journal-storage/values.mjs", import.meta.url).href;
  const source = `
    import pg from "pg";
    import { journalHarness, incomingLookup } from ${JSON.stringify(fixtureUrl)};
    let text = ""; for await (const chunk of process.stdin) text += chunk;
    const input = JSON.parse(text);
    const pool = new pg.Pool({ connectionString: process.env.OCC_TEST_DATABASE_URL, max: 2, connectionTimeoutMillis: 250 });
    try {
      const h = journalHarness(pool);
      const result = input.action === "admit"
        ? await h.write(j => j.admit(h.issue("admission", input.values.observation), h.call))
        : await h.read(async j => ({
            incoming: await j.findIncomingLink(incomingLookup(input.values.identity), h.call),
            attempt: await j.findAttempt(input.values.attempt, h.call),
            allocation: await j.findCheckpointAllocation(input.values.allocation, h.call),
          }));
      process.stdout.write(JSON.stringify(result));
    } finally { await pool.end(); }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Turn journal process test timed out."));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Turn journal child exited ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({ action, values }));
  });
}

test(
  "PostgreSQL turn journal owns commit visibility and recovered locators",
  options,
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 8,
      connectionTimeoutMillis: 250,
    });
    t.after(() => pool.end());

    await t.test(
      "the original outer transaction owns journal, resource, work and audit visibility",
      async (t) => {
        const h = journalHarness(pool);
        const owner = await seedJournalOwner(h.state);
        const v = journalValues(owner);
        const entered = deferred(),
          release = deferred();
        const auditId = `aud_${crypto.randomUUID()}`;
        const resource = {
          id: `ns_${crypto.randomUUID()}`,
          name: ref("atomic-namespace"),
          status: "ready",
          createdAt: new Date().toISOString(),
        };
        let retained;
        const failure = new Error("roll back whole outer transaction");
        const pending = h.state.transact(async (unit) => {
          retained = unit.turnJournal;
          const result = await unit.turnJournal.admit(h.issue("admission", v.observation), h.call);
          assert.equal(result.record.decision.kind, "accepted");
          await unit.namespaces.createNamespace(resource);
          await unit.operations.append({
            kind: "namespace",
            action: "reconcile",
            target: "ready",
            namespaceId: resource.id,
            resourceId: resource.id,
            actorId: "storage-test",
          });
          await unit.audit.append({
            id: auditId,
            installationId: owner.installation.id,
            namespaceId: resource.id,
            occurredAt: new Date().toISOString(),
            kind: "mutation",
            actorId: "storage-test",
            action: "create",
            resource: {
              kind: "namespace",
              id: resource.id,
              namespaceId: resource.id,
            },
            outcome: "success",
          });
          const common = await unit.turnJournal.findAttempt(v.attempt, h.call);
          assert.equal(common.kind, "found");
          assert.deepEqual(plain(common.record), commonAttemptRecord(v));
          // Common readback exists inside the original transaction; another
          // client must still see no ownership before the real outer COMMIT.
          const canonical = await h.state.queryInTransaction(
            unit,
            "SELECT count(*)::int AS count FROM occ.turn_journal_attempts WHERE agent_id=$1",
            [v.context.agentRef],
          );
          assert.equal(canonical.rows[0].count, 1);
          entered.resolve();
          await release.promise;
          throw failure;
        });
        pending.catch((error) => {
          entered.reject(error);
        });
        t.after(async () => {
          release.resolve();
          await pending.catch(() => {});
        });
        await entered.promise;
        assert.equal((await h.read((j) => j.findAdmission(eventLookup(v), h.call))).kind, "absent");
        const invisible = await pool.query(
          "SELECT (SELECT count(*) FROM occ.turn_journal_attempts WHERE agent_id=$1)::int AS attempts, (SELECT count(*) FROM occ.turn_journal_reservations WHERE agent_id=$1)::int AS reservations, (SELECT count(*) FROM occ.audit_events WHERE id=$2)::int AS audits, (SELECT count(*) FROM occ.controller_work WHERE namespace_id=$3)::int AS work, (SELECT count(*) FROM occ.namespaces WHERE id=$3)::int AS resources",
          [owner.agent.id, auditId, resource.id],
        );
        assert.deepEqual(invisible.rows[0], {
          attempts: 0,
          reservations: 0,
          audits: 0,
          work: 0,
          resources: 0,
        });
        release.resolve();
        await assert.rejects(pending, (error) => error === failure);
        assert.equal(
          (await h.read((j) => j.findIncomingLink(incomingLookup(v.identity), h.call))).kind,
          "absent",
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM occ.controller_work WHERE namespace_id=$1",
              [resource.id],
            )
          ).rows[0].count,
          0,
        );
        assert.equal(
          await h.state.read((view) => view.namespaces.findNamespace(resource.id)),
          undefined,
        );
        await assert.rejects(retained.admit(h.issue("admission", v.observation), h.call));
      },
    );

    await t.test(
      "caught mutation rejection rolls back prior admission, incoming link and reservation",
      async () => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        let observed = false;
        const result = await h.write(async (j) => {
          assert.equal(
            (await j.admit(h.issue("admission", v.observation), h.call)).kind,
            "recorded",
          );
          try {
            await j.allocateCheckpoint(
              { ...v.allocation, checkpointId: "invalid\ncheckpoint" },
              h.call,
            );
          } catch {
            observed = true;
          }
          return "callback caught the failed mutation";
        });
        assert.equal(observed, true);
        assert.equal(result.kind, "unavailable");
        assert.equal((await h.read((j) => j.findAdmission(eventLookup(v), h.call))).kind, "absent");
        assert.equal((await h.read((j) => j.findAttempt(v.attempt, h.call))).kind, "absent");
      },
    );

    await t.test(
      "the outer owner drains an admitted unawaited mutation and closes escaped projections",
      async (t) => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        const blocked = deferred();
        h.provenance.hold("admission", blocked.promise);
        let accepted, retained;
        const pending = h.write(async (j) => {
          retained = j;
          accepted = j.admit(h.issue("admission", v.observation), h.call);
        });
        t.after(async () => {
          blocked.resolve();
          await pending.catch(() => {});
        });
        let committed = false;
        pending.then(() => {
          committed = true;
        });
        // Holding the real injected observation keeps the actual repository mutation
        // pending after callback return; outer COMMIT must wait for that accepted work.
        while (h.provenance.inspections.length === 0) {
          assert.equal(committed, false, "outer unit finished before the accepted observation");
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(committed, false);
        blocked.resolve();
        valueOf(await pending);
        assert.equal((await accepted).record.decision.kind, "accepted");
        assert.equal((await h.read((j) => j.findAdmission(eventLookup(v), h.call))).kind, "found");
        await assert.rejects(retained.findAttempt(v.attempt, h.call));
        await assert.rejects(retained.admit(h.issue("admission", v.observation), h.call));
      },
    );

    await t.test(
      "only the newly committed consumption invokes a callback visible from another client",
      async (t) => {
        const h = journalHarness(pool);
        const peerPool = new pg.Pool({
          connectionString: databaseUrl,
          max: 3,
          connectionTimeoutMillis: 250,
        });
        t.after(() => peerPool.end());
        const peer = journalHarness(peerPool, { provenance: h.provenance });
        const v = journalValues(await seedJournalOwner(h.state));
        await admit(h, v);
        let prematureStarts = 0;
        const refused = await h.store.consumeAndInitiate(
          h.issue("consumption", { operation: v.consumption, binding: v.binding }),
          async () => {
            prematureStarts++;
          },
          h.call,
        );
        assert.deepEqual(refused, { kind: "denied" });
        assert.equal(prematureStarts, 0);
        assert.deepEqual(
          plain((await h.read((j) => j.findAttempt(v.attempt, h.call))).record),
          commonAttemptRecord(v),
        );
        await dispatch(h, v);
        const handle = h.issue("consumption", { operation: v.consumption, binding: v.binding });
        let starts = 0;
        const initiate = async (attempt, guard) => {
          assert.deepEqual(plain(attempt), v.attempt);
          const durable = await peer.read((j) => j.findAttempt(attempt, peer.call));
          assert.equal(
            durable.record.consumption.operation.operationRef,
            v.consumption.operationRef,
          );
          await guard.assertCurrent();
          starts++;
        };
        const results = await Promise.all([
          h.store.consumeAndInitiate(handle, initiate, h.call),
          peer.store.consumeAndInitiate(handle, initiate, peer.call),
        ]);
        assert.deepEqual(results.map((result) => result.kind).sort(), [
          "already-consumed",
          "initiated",
        ]);
        assert.equal(starts, 1);
        assert.deepEqual(await h.store.consumeAndInitiate(handle, initiate, h.call), {
          kind: "already-consumed",
        });
        assert.equal(starts, 1);
      },
    );

    await t.test(
      "callback failure and postcommit authority loss never create a second initiation",
      async () => {
        for (const loseAuthority of [false, true]) {
          const h = journalHarness(
            pool,
            loseAuthority
              ? {
                  initiation: {
                    assertCurrent: async () => {
                      throw new Error("current authority withdrawn");
                    },
                  },
                }
              : {},
          );
          const v = journalValues(await seedJournalOwner(h.state));
          await admit(h, v);
          await dispatch(h, v);
          let starts = 0;
          const handle = h.issue("consumption", { operation: v.consumption, binding: v.binding });
          const initiate = async () => {
            starts++;
            throw new Error("native acknowledgement missing");
          };
          assert.deepEqual(await h.store.consumeAndInitiate(handle, initiate, h.call), {
            kind: "execution-unknown",
          });
          assert.equal(starts, loseAuthority ? 0 : 1);
          assert.deepEqual(await h.store.consumeAndInitiate(handle, initiate, h.call), {
            kind: "already-consumed",
          });
          assert.equal(starts, loseAuthority ? 0 : 1);
        }
      },
    );

    await t.test(
      "expired proof and a backward wall clock suppress initiation effects",
      async () => {
        const delayed = journalHarness(pool, {
          initiation: {
            async assertCurrent(_view, _record, _operation, call) {
              const expiresAt = new Date(Date.now() + 30).toISOString();
              await new Promise((resolve) => setTimeout(resolve, 60));
              return { expiresAt, signal: call.signal };
            },
          },
        });
        const v = journalValues(await seedJournalOwner(delayed.state));
        await admit(delayed, v);
        await dispatch(delayed, v);
        let callbacks = 0;
        const result = await delayed.store.consumeAndInitiate(
          delayed.issue("consumption", { operation: v.consumption, binding: v.binding }),
          async () => {
            callbacks++;
          },
          delayed.call,
        );
        assert.deepEqual(result, { kind: "execution-unknown" });
        assert.equal(callbacks, 0);

        let wallOffset = 0;
        let originalExpiry;
        const h = journalHarness(pool, {
          now: () => Date.now() + wallOffset,
          initiation: {
            async assertCurrent(_view, _record, _operation, call) {
              originalExpiry ??= new Date(Date.now() + 500).toISOString();
              return { expiresAt: originalExpiry, signal: call.signal };
            },
          },
        });
        const rollback = journalValues(await seedJournalOwner(h.state));
        await admit(h, rollback);
        await dispatch(h, rollback);
        let effects = 0;
        let callbackEntered = false;
        const callbackFinished = deferred();
        const rolledBack = await h.store.consumeAndInitiate(
          h.issue("consumption", { operation: rollback.consumption, binding: rollback.binding }),
          async (_attempt, guard) => {
            callbackEntered = true;
            try {
              wallOffset -= 1_000;
              await new Promise((resolve) => setTimeout(resolve, 600));
              await guard.assertCurrent();
              effects++;
            } finally {
              callbackFinished.resolve();
            }
          },
          h.call,
        );
        assert.deepEqual(rolledBack, { kind: "execution-unknown" });
        assert.equal(callbackEntered, true);
        await callbackFinished.promise;
        assert.equal(effects, 0);
      },
    );

    await t.test(
      "cancelled common publication and separate release roll back with their original owner",
      async () => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        await admit(h, v);
        const release = { ...v.release, expectedAttemptVersion: 2 };
        const rolledBack = await h.write(async (j) => {
          assert.equal(
            (await j.commitCancellation(h.issue("cancellation", v.cancellation), h.call)).outcome,
            "cancelled-before-dispatch",
          );
          assert.equal((await j.findAttempt(v.attempt, h.call)).record.version, 2);
          assert.equal(
            (await j.releaseReservation(h.issue("release", release), h.call)).kind,
            "released",
          );
          throw new Error("abort cancellation and its separate release");
        });
        assert.equal(rolledBack.kind, "unavailable");
        assert.deepEqual(
          plain((await h.read((j) => j.findAttempt(v.attempt, h.call))).record),
          commonAttemptRecord(v),
        );
        assert.equal(
          (await h.read((j) => j.findCancellation(v.cancellation, h.call))).kind,
          "absent",
        );
        assert.equal((await h.read((j) => j.findRelease(release, h.call))).kind, "absent");
        assert.deepEqual(
          (
            await pool.query(
              "SELECT reservation_ref FROM occ.turn_journal_reservations WHERE agent_id=$1",
              [v.context.agentRef],
            )
          ).rows.map((row) => row.reservation_ref),
          [v.attempt.reservationRef],
        );

        for (const unawaited of [false, true]) {
          let cancellation;
          const result = await h.write(async (j) => {
            cancellation = j.commitCancellation(h.issue("cancellation", v.cancellation), h.call);
            if (!unawaited) assert.equal((await cancellation).kind, "recorded");
            void cancellation.catch(() => {});
            // The original guard must drain the accepted cancellation and retain
            // a subsequent rejection even when callback code observes it.
            const rejected = j.allocateCheckpoint(
              { ...v.allocation, checkpointId: "invalid\ncheckpoint" },
              h.call,
            );
            if (unawaited) void rejected.catch(() => {});
            else await rejected.catch(() => {});
          });
          assert.equal(result.kind, "unavailable");
          await cancellation.catch(() => {});
          assert.deepEqual(
            plain((await h.read((j) => j.findAttempt(v.attempt, h.call))).record),
            commonAttemptRecord(v),
          );
          assert.equal(
            (await h.read((j) => j.findCancellation(v.cancellation, h.call))).kind,
            "absent",
          );
        }
      },
    );

    await t.test(
      "lost cancellation and release acknowledgements recover exact common state without initiation",
      async () => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        await admit(h, v);
        const release = { ...v.release, expectedAttemptVersion: 2 };
        for (const kind of ["cancellation", "release"]) {
          const proxy = await runtimeCommitAckProxy(databaseUrl);
          const faultPool = new pg.Pool({
            connectionString: proxy.url,
            max: 2,
            connectionTimeoutMillis: 250,
          });
          faultPool.on("error", () => {});
          try {
            const fault = journalHarness(faultPool, { provenance: h.provenance });
            const transactionRef = ref(`${kind}-unknown`);
            proxy.arm();
            const result = await fault.store.transact(
              transactionRef,
              (j) =>
                kind === "cancellation"
                  ? j.commitCancellation(fault.issue("cancellation", v.cancellation), fault.call)
                  : j.releaseReservation(fault.issue("release", release), fault.call),
              fault.call,
            );
            assert.deepEqual(result, { kind: "commit-unknown", transactionRef });
            assert.equal(proxy.observedCommit, true);
          } finally {
            await faultPool.end();
            await proxy.close();
          }
          // Read only after the original unknown command settled and unwound.
          const current = (await h.read((j) => j.findAttempt(v.attempt, h.call))).record;
          assert.deepEqual(plain(current), {
            ...commonAttemptRecord(v),
            version: 2,
            outcome: {
              kind: "cancelled",
              stage: "before-dispatch",
              evidenceRef: v.cancellation.operationRef,
            },
          });
          const cancellation = await h.read((j) => j.findCancellation(v.cancellation, h.call));
          assert.equal(cancellation.kind, "found");
          assert.deepEqual(plain(cancellation.operation), v.cancellation);
          const held = (
            await pool.query(
              "SELECT count(*)::int AS count FROM occ.turn_journal_reservations WHERE agent_id=$1",
              [v.context.agentRef],
            )
          ).rows[0].count;
          assert.equal(held, kind === "cancellation" ? 1 : 0);
          if (kind === "release")
            assert.equal((await h.read((j) => j.findRelease(release, h.call))).kind, "released");
        }
        let starts = 0;
        assert.deepEqual(
          await h.store.consumeAndInitiate(
            h.issue("consumption", { operation: v.consumption, binding: v.binding }),
            async () => {
              starts++;
            },
            h.call,
          ),
          { kind: "denied" },
        );
        assert.equal(starts, 0);
        assert.equal(
          valueOf(
            await h.write((j) =>
              j.commitCancellation(h.issue("cancellation", v.cancellation), h.call),
            ),
          ).kind,
          "existing",
        );
        assert.equal(
          valueOf(await h.write((j) => j.releaseReservation(h.issue("release", release), h.call)))
            .kind,
          "existing",
        );
        assert.equal((await h.read((j) => j.findAttempt(v.attempt, h.call))).record.version, 2);
      },
    );

    await t.test(
      "real lost COMMIT acknowledgement retains admission link and suppresses consumption initiation",
      async () => {
        const h = journalHarness(pool);
        const v = journalValues(await seedJournalOwner(h.state));
        const admissionProxy = await runtimeCommitAckProxy(databaseUrl);
        const faultPool = new pg.Pool({
          connectionString: admissionProxy.url,
          max: 2,
          connectionTimeoutMillis: 250,
        });
        faultPool.on("error", () => {});
        try {
          const fault = journalHarness(faultPool, { provenance: h.provenance });
          const transactionRef = ref("admission-unknown");
          admissionProxy.arm();
          assert.deepEqual(
            await fault.store.transact(
              transactionRef,
              (j) => j.admit(fault.issue("admission", v.observation), fault.call),
              fault.call,
            ),
            { kind: "commit-unknown", transactionRef },
          );
          assert.equal(admissionProxy.observedCommit, true);
          assert.equal(
            (await h.read((j) => j.findIncomingLink(incomingLookup(v.identity), h.call))).kind,
            "found",
          );
          const recoveredCommon = await h.read((j) => j.findAttempt(v.attempt, h.call));
          assert.equal(recoveredCommon.kind, "found");
          assert.deepEqual(plain(recoveredCommon.record), commonAttemptRecord(v));
        } finally {
          await faultPool.end();
          await admissionProxy.close();
        }
        await dispatch(h, v);
        const consumptionProxy = await runtimeCommitAckProxy(databaseUrl);
        const consumePool = new pg.Pool({
          connectionString: consumptionProxy.url,
          max: 2,
          connectionTimeoutMillis: 250,
        });
        consumePool.on("error", () => {});
        let starts = 0;
        try {
          const fault = journalHarness(consumePool, { provenance: h.provenance });
          consumptionProxy.arm();
          const result = await fault.store.consumeAndInitiate(
            fault.issue("consumption", { operation: v.consumption, binding: v.binding }),
            async () => {
              starts++;
            },
            fault.call,
          );
          assert.deepEqual(result, { kind: "commit-unknown" });
          assert.equal(consumptionProxy.observedCommit, true);
          assert.equal(starts, 0);
        } finally {
          await consumePool.end();
          await consumptionProxy.close();
        }
        const recovered = await h.read((j) => j.findAttempt(v.attempt, h.call));
        assert.equal(
          recovered.record.consumption.operation.operationRef,
          v.consumption.operationRef,
        );
        assert.deepEqual(
          await h.store.consumeAndInitiate(
            h.issue("consumption", { operation: v.consumption, binding: v.binding }),
            async () => {
              starts++;
            },
            h.call,
          ),
          { kind: "already-consumed" },
        );
        assert.equal(starts, 0);
      },
    );

    await t.test(
      "independent processes race duplicate admission then reopen exact status without a permit",
      async () => {
        for (const distinctEvent of [false, true]) {
          const h = journalHarness(pool);
          let v = journalValues(await seedJournalOwner(h.state));
          const arrivals = [
            v,
            distinctEvent
              ? changedIncoming(v, (incoming) => {
                  incoming.envelope.event.providerEventRef = ref("process-event-twin");
                })
              : v,
          ];
          const results = (
            await Promise.all(arrivals.map((incoming) => separateProcess("admit", incoming)))
          ).map(valueOf);
          assert.equal(
            results.filter((result) => result.duplicate === false).length,
            distinctEvent ? 1 : 2,
          );
          assert.equal(
            results.filter((result) => result.duplicate === true).length,
            distinctEvent ? 1 : 0,
          );
          if (!distinctEvent) assert.deepEqual(results[0].incomingLink, results[1].incomingLink);
          assert.equal(
            results[0].record.decision.attempt.attemptRef,
            results[1].record.decision.attempt.attemptRef,
          );
          v = arrivals[results.findIndex((result) => result.duplicate === false)];
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS count FROM occ.turn_journal_attempts WHERE agent_id=$1",
                [v.context.agentRef],
              )
            ).rows[0].count,
            1,
          );
          await dispatch(h, v);
          valueOf(
            await h.write((j) =>
              j.consumeAttempt(
                h.issue("consumption", { operation: v.consumption, binding: v.binding }),
                h.call,
              ),
            ),
          );
          valueOf(await h.write((j) => j.allocateCheckpoint(v.allocation, h.call)));
          const reopened = await separateProcess("read", v);
          assert.equal(reopened.incoming.kind, "found");
          assert.equal(
            reopened.attempt.record.consumption.operation.operationRef,
            v.consumption.operationRef,
          );
          assert.equal(reopened.allocation.allocation.checkpointId, v.allocation.checkpointId);
          assert.equal(Object.hasOwn(reopened.attempt.record, "claim"), false);
          assert.equal(Object.hasOwn(reopened.attempt.record, "initiate"), false);
        }
      },
    );
  },
);
