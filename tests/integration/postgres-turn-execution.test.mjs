import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { SelectedExecutionController } from "../../packages/occ/src/turn-journal/selected-execution.ts";
import { parseTurnJournalV1 } from "../../packages/contracts/src/turn-journal-v1.ts";
import {
  journalHarness,
  storageProvenance,
  seedJournalOwner,
  journalValues,
  ref,
  digest,
} from "../fixtures/turn-journal-storage/values.mjs";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const same = (a, b) =>
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
const committed = (r) => {
  assert.equal(r.kind, "committed");
  return r.value;
};
// Controlled external evidence for real PostgreSQL/storage tests. These handles
// do not qualify a production native connection, human grant or protected clock.
function provenance() {
  const p = storageProvenance();
  const bind = p.options.bind;
  p.options.bind = (context) => {
    const ports = bind(context);
    return {
      ...ports,
      evidence: {
        ...ports.evidence,
        inspectExecutionStart: ports.evidence.inspectConsumption,
        inspectExecutionInterruption: ports.evidence.inspectConsumption,
      },
    };
  };
  return p;
}
async function fixture(pool, existing) {
  const p = existing?.p ?? provenance();
  const h = existing?.h ?? journalHarness(pool, { provenance: p });
  const v = journalValues(await seedJournalOwner(h.state));
  assert.equal(
    committed(await h.write((j) => j.admit(h.issue("admission", v.observation), h.call))).kind,
    "recorded",
  );
  assert.equal(
    committed(await h.write((j) => j.recordDispatchIntent(h.issue("dispatch", v.binding), h.call)))
      .kind,
    "recorded",
  );
  const execution = {
    attempt: v.attempt,
    dispatchOperationRef: v.binding.dispatchOperationRef,
    consumption: v.consumption,
    executionRef: ref("execution"),
    recipientRef: ref("native-recipient"),
  };
  const intent = {
    execution,
    operationRef: ref("intent"),
    operationDigest: digest(),
    executionLimitRef: ref("limit"),
    executionLimitVersion: 1,
    maximumExecutionMs: 900000,
    dispatchClock: {
      clockSourceRef: ref("clock"),
      clockEpochRef: ref("epoch"),
      committedAtMs: 100,
      deadlineAtMs: 900100,
    },
  };
  const start = {
    intent,
    operationRef: ref("start"),
    operationDigest: digest(),
    nativeExecutionRef: ref("native-execution"),
    nativeIncarnationRef: ref("incarnation"),
    nativeReservationRef: ref("native-reservation"),
    nativeSessionRef: ref("session"),
    nativeTurnRef: ref("turn"),
    acceptanceEvidenceRef: ref("acceptance"),
    clockSourceRef: intent.dispatchClock.clockSourceRef,
    clockEpochRef: intent.dispatchClock.clockEpochRef,
    startedAtMs: 1100,
    deadlineAtMs: 900100,
    dispatchDeadlineAtMs: 900100,
    clockCorrespondenceEvidenceRef: ref("clock-correspondence"),
  };
  const interruption = {
    start,
    operationRef: ref("interrupt"),
    operationDigest: digest(),
    responsibilityRef: ref("responsibility"),
    responsibilityVersion: 1,
  };
  const consume = () =>
    h.issue("consumption", {
      operation: v.consumption,
      binding: v.binding,
      executionIntent: intent,
    });
  const retain = () =>
    h.write((j) => j.retainExecutionStart(h.issue("consumption", start), h.call));
  return { h, p, v, execution, intent, start, interruption, consume, retain };
}
const columns =
  "installation_id,namespace_id,agent_id,conversation_ref,turn_ref,attempt_ref,reservation_ref,operation_kind,operation_ref,request,record";
const sqlInsert = (client, attempt, kind, record) =>
  client.query(
    `INSERT INTO occ.turn_journal_operations (${columns}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
    [
      attempt.installationRef,
      attempt.namespaceRef,
      attempt.agentRef,
      attempt.conversationRef,
      attempt.turnRef,
      attempt.attemptRef,
      attempt.reservationRef,
      kind,
      record.operationRef,
      JSON.stringify(record),
    ],
  );

test(
  "selected execution uses the original PostgreSQL journal",
  { skip: !databaseUrl, timeout: 120000 },
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 6,
      connectionTimeoutMillis: 250,
    });
    try {
      await t.test(
        "same committed consumption carries one selected intent into the original callback",
        async () => {
          const f = await fixture(pool);
          let callbacks = 0;
          const result = await f.h.store.consumeAndInitiate(
            f.consume(),
            async (attempt, guard) => {
              callbacks++;
              same(attempt, f.v.attempt);
              same(guard.executionIntent, f.intent);
              await guard.assertCurrent();
            },
            f.h.call,
          );
          assert.equal(result.kind, "initiated");
          assert.equal(callbacks, 1);
          assert.equal(
            (
              await f.h.store.consumeAndInitiate(
                f.consume(),
                async () => {
                  callbacks++;
                },
                f.h.call,
              )
            ).kind,
            "already-consumed",
          );
          assert.equal(callbacks, 1);
          same(await f.h.read((j) => j.findExecution(f.execution, f.h.call)), {
            kind: "intent-only",
            intent: f.intent,
          });
        },
      );
      await t.test(
        "rollback and orphan or late direct intent cannot retain selected ownership",
        async () => {
          const f = await fixture(pool);
          assert.equal(
            (
              await f.h.write(async (j) => {
                await j.consumeAttempt(f.consume(), f.h.call);
                throw new Error("rollback");
              })
            ).kind,
            "unavailable",
          );
          assert.equal(
            (await f.h.read((j) => j.findExecution(f.execution, f.h.call))).kind,
            "absent",
          );
          assert.equal(
            (await f.h.read((j) => j.findAttempt(f.v.attempt, f.h.call))).record.consumption,
            null,
          );
          await assert.rejects(sqlInsert(pool, f.v.attempt, "execution-intent", f.intent), {
            code: "23514",
          });
          committed(
            await f.h.write((j) =>
              j.consumeAttempt(
                f.h.issue("consumption", { operation: f.v.consumption, binding: f.v.binding }),
                f.h.call,
              ),
            ),
          );
          await assert.rejects(sqlInsert(pool, f.v.attempt, "execution-intent", f.intent), {
            code: "23514",
          });
        },
      );
      await t.test(
        "same-unit concurrent retention is exact; changed start or clock cannot overwrite",
        async () => {
          const f = await fixture(pool);
          committed(await f.h.write((j) => j.consumeAttempt(f.consume(), f.h.call)));
          const handle = f.h.issue("consumption", f.start);
          const result = committed(
            await f.h.write((j) =>
              Promise.all([
                j.retainExecutionStart(handle, f.h.call),
                j.retainExecutionStart(handle, f.h.call),
              ]),
            ),
          );
          assert.deepEqual(
            result.map((x) => x.kind),
            ["recorded", "existing"],
          );
          const changed = { ...f.start, nativeTurnRef: ref("different") };
          assert.equal(
            committed(
              await f.h.write((j) =>
                j.retainExecutionStart(f.h.issue("consumption", changed), f.h.call),
              ),
            ).kind,
            "conflict",
          );
          same(await f.h.read((j) => j.findExecution(f.execution, f.h.call)), {
            kind: "started",
            start: f.start,
          });
          await assert.rejects(
            pool.query("UPDATE occ.turn_journal_operations SET record=$1 WHERE operation_ref=$2", [
              JSON.stringify(changed),
              f.start.operationRef,
            ]),
          );
          assert.throws(() =>
            parseTurnJournalV1("executionStart", { ...f.start, deadlineAtMs: 901100 }),
          );
          assert.throws(() =>
            parseTurnJournalV1("executionStart", {
              ...f.start,
              startedAtMs: Number.MAX_SAFE_INTEGER,
              deadlineAtMs: Number.MAX_SAFE_INTEGER,
            }),
          );
        },
      );
      await t.test(
        "database validates exact native record and refuses earlier dispatch deadline renewal",
        async () => {
          const f = await fixture(pool);
          committed(await f.h.write((j) => j.consumeAttempt(f.consume(), f.h.call)));
          for (const change of [
            { startedAtMs: 99, deadlineAtMs: 900099 },
            { deadlineAtMs: 901100 },
            { dispatchDeadlineAtMs: 901100, deadlineAtMs: 901100 },
            { annotation: "not-closed" },
            {
              intent: {
                ...f.intent,
                execution: {
                  ...f.execution,
                  consumption: { ...f.v.consumption, claimantRef: ref("other") },
                },
              },
            },
          ]) {
            await assert.rejects(
              sqlInsert(pool, f.v.attempt, "execution-start", { ...f.start, ...change }),
              { code: "23514" },
            );
          }
          const client = await pool.connect();
          try {
            await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
            await assert.rejects(sqlInsert(client, f.v.attempt, "execution-start", f.start), {
              code: "25001",
            });
          } finally {
            await client.query("ROLLBACK");
            client.release();
          }
          assert.equal(committed(await f.retain()).kind, "recorded");
        },
      );
      await t.test("one native turn cannot acquire a second canonical execution", async () => {
        const f = await fixture(pool);
        committed(await f.h.write((j) => j.consumeAttempt(f.consume(), f.h.call)));
        committed(await f.retain());
        const other = await fixture(pool, f);
        committed(await other.h.write((j) => j.consumeAttempt(other.consume(), other.h.call)));
        const alias = {
          ...other.start,
          nativeIncarnationRef: f.start.nativeIncarnationRef,
          nativeSessionRef: f.start.nativeSessionRef,
          nativeTurnRef: f.start.nativeTurnRef,
        };
        await assert.rejects(sqlInsert(pool, other.v.attempt, "execution-start", alias), {
          code: "23505",
        });
        assert.equal(
          (await other.h.read((j) => j.findExecution(other.execution, other.h.call))).kind,
          "intent-only",
        );
        const changed = { ...f.intent, executionLimitVersion: 2 };
        const handle = f.h.issue("consumption", {
          operation: f.v.consumption,
          binding: f.v.binding,
          executionIntent: changed,
        });
        assert.equal(
          committed(await f.h.write((j) => j.consumeAttempt(handle, f.h.call))).kind,
          "conflict",
        );
      });
      await t.test(
        "native provenance revoked while waiting for Agent lock cannot retain start",
        async () => {
          const f = await fixture(pool);
          committed(await f.h.write((j) => j.consumeAttempt(f.consume(), f.h.call)));
          const locker = await pool.connect();
          await locker.query("BEGIN");
          await locker.query("SELECT id FROM occ.agents WHERE id=$1 FOR UPDATE", [
            f.v.attempt.agentRef,
          ]);
          const handle = f.h.issue("consumption", f.start);
          const before = f.p.inspections.length;
          const work = f.h.write((j) => j.retainExecutionStart(handle, f.h.call));
          try {
            for (let i = 0; i < 100 && f.p.inspections.length === before; i++)
              await new Promise((r) => setTimeout(r, 5));
            assert.ok(f.p.inspections.length > before);
            f.p.revoke(handle);
          } finally {
            await locker.query("ROLLBACK");
            locker.release();
          }
          assert.equal(committed(await work).kind, "denied");
          assert.equal(
            (await f.h.read((j) => j.findExecution(f.execution, f.h.call))).kind,
            "intent-only",
          );
        },
      );
      await t.test(
        "lost consumption COMMIT acknowledgment leaves intent without a callback or fresh claimant",
        async () => {
          const f = await fixture(pool);
          const proxy = await runtimeCommitAckProxy(databaseUrl);
          const faultPool = new pg.Pool({
            connectionString: proxy.url,
            max: 2,
            connectionTimeoutMillis: 250,
          });
          faultPool.on("error", () => {});
          let callbacks = 0;
          try {
            const h = journalHarness(faultPool, { provenance: f.p });
            proxy.arm();
            assert.equal(
              (
                await h.store.consumeAndInitiate(
                  f.consume(),
                  async () => {
                    callbacks++;
                  },
                  h.call,
                )
              ).kind,
              "commit-unknown",
            );
            assert.equal(proxy.observedCommit, true);
          } finally {
            await faultPool.end();
            await proxy.close();
          }
          assert.equal(callbacks, 0);
          assert.equal(
            (await f.h.read((j) => j.findExecution(f.execution, f.h.call))).kind,
            "intent-only",
          );
          assert.equal(
            (
              await f.h.store.consumeAndInitiate(
                f.consume(),
                async () => {
                  callbacks++;
                },
                f.h.call,
              )
            ).kind,
            "already-consumed",
          );
          assert.equal(callbacks, 0);
        },
      );
      await t.test(
        "lost start COMMIT acknowledgment permits exact immutable readback only",
        async () => {
          const f = await fixture(pool);
          committed(await f.h.write((j) => j.consumeAttempt(f.consume(), f.h.call)));
          const proxy = await runtimeCommitAckProxy(databaseUrl);
          const faultPool = new pg.Pool({
            connectionString: proxy.url,
            max: 2,
            connectionTimeoutMillis: 250,
          });
          faultPool.on("error", () => {});
          try {
            const h = journalHarness(faultPool, { provenance: f.p });
            proxy.arm();
            assert.equal(
              (
                await h.write((j) =>
                  j.retainExecutionStart(h.issue("consumption", f.start), h.call),
                )
              ).kind,
              "commit-unknown",
            );
            assert.equal(proxy.observedCommit, true);
          } finally {
            await faultPool.end();
            await proxy.close();
          }
          same(await f.h.read((j) => j.findExecution(f.execution, f.h.call)), {
            kind: "started",
            start: f.start,
          });
          const rows = await pool.query(
            "SELECT count(*)::int AS n FROM occ.turn_journal_operations WHERE attempt_ref=$1 AND operation_kind='execution-start'",
            [f.v.attempt.attemptRef],
          );
          assert.equal(rows.rows[0].n, 1);
        },
      );
      await t.test(
        "interruption retains exact original start and never releases an unknown reservation",
        async () => {
          const f = await fixture(pool);
          committed(await f.h.write((j) => j.consumeAttempt(f.consume(), f.h.call)));
          committed(await f.retain());
          const handle = f.h.issue("consumption", f.interruption);
          assert.equal(
            committed(await f.h.write((j) => j.retainExecutionInterruption(handle, f.h.call))).kind,
            "recorded",
          );
          assert.equal(
            committed(await f.h.write((j) => j.retainExecutionInterruption(handle, f.h.call))).kind,
            "existing",
          );
          same(await f.h.read((j) => j.findExecutionInterruption(f.interruption, f.h.call)), {
            kind: "found",
            interruption: f.interruption,
          });
          const changed = {
            ...f.interruption,
            start: { ...f.start, nativeIncarnationRef: ref("restarted") },
          };
          assert.equal(
            committed(
              await f.h.write((j) =>
                j.retainExecutionInterruption(f.h.issue("consumption", changed), f.h.call),
              ),
            ).kind,
            "conflict",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM occ.turn_journal_reservations WHERE attempt_ref=$1",
                [f.v.attempt.attemptRef],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        "owned controller recovers one original gated execution after actual retention ACK loss",
        async () => {
          const f = await fixture(pool);
          const proxy = await runtimeCommitAckProxy(databaseUrl);
          const faultPool = new pg.Pool({
            connectionString: proxy.url,
            max: 2,
            connectionTimeoutMillis: 250,
          });
          faultPool.on("error", () => {});
          const originalBind = f.p.options.bind;
          let armed = false;
          f.p.options.bind = (context) => {
            const ports = originalBind(context);
            return {
              ...ports,
              evidence: {
                ...ports.evidence,
                async inspectExecutionStart(...args) {
                  const observed = await ports.evidence.inspectExecutionStart(...args);
                  if (!armed) {
                    armed = true;
                    proxy.arm();
                  }
                  return observed;
                },
              },
            };
          };
          const h = journalHarness(faultPool, { provenance: f.p });
          let accepts = 0,
            gates = 0,
            interrupts = 0;
          const receipt = { start: f.start, evidence: f.h.issue("consumption", f.start) };
          const observedPurposes = [];
          // External native-owner fixture: the assertions observe the real canonical
          // journal and original callback, not a simulated SQL or COMMIT decision.
          const native = {
            async accept(guard) {
              accepts++;
              await guard.assertCurrent();
              same(guard.executionIntent, f.intent);
              return receipt;
            },
            async assertCurrent(owned, purpose) {
              assert.equal(owned, receipt);
              observedPurposes.push(purpose);
            },
            async confirmRetainedStart(owned, start) {
              assert.equal(owned, receipt);
              same(start, f.start);
              same(await f.h.read((j) => j.findExecution(f.execution, f.h.call)), {
                kind: "started",
                start: f.start,
              });
              gates++;
            },
            async inspectInterruption(owned, operation) {
              assert.equal(owned, receipt);
              same(operation, f.interruption);
              return f.h.issue("consumption", operation);
            },
            async interrupt() {
              interrupts++;
              throw new Error("Native acknowledgment lost after submission");
            },
          };
          const controller = new SelectedExecutionController(h.store, native, 10);
          try {
            assert.equal((await controller.consume(f.consume(), h.call)).kind, "execution-unknown");
            assert.equal(proxy.observedCommit, true);
            assert.equal(accepts, 1);
            assert.equal(gates, 0);
            const readCall = f.p.call();
            await controller.resolveStart(f.execution, readCall);
            assert.equal(gates, 1);
            assert.equal(accepts, 1);
            await assert.rejects(controller.resolveStart(f.execution, f.p.call()));
            assert.equal(gates, 1);
            const restarted = new SelectedExecutionController(h.store, native, 10);
            await assert.rejects(restarted.resolveStart(f.execution, f.p.call()));
            assert.equal(accepts, 1);
            await assert.rejects(controller.interrupt(f.interruption, f.p.call()));
            assert.equal(interrupts, 1);
            await assert.rejects(controller.resolveInterruption(f.interruption, f.p.call()));
            assert.equal(interrupts, 1);
            assert.ok(observedPurposes.includes("continue"));
            assert.ok(observedPurposes.includes("interrupt"));
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::int AS n FROM occ.turn_journal_reservations WHERE attempt_ref=$1",
                  [f.v.attempt.attemptRef],
                )
              ).rows[0].n,
              1,
            );
          } finally {
            await faultPool.end();
            await proxy.close();
          }
        },
      );
      await t.test(
        "owned controller resolves one exact interruption retention ACK before one submit",
        async () => {
          const f = await fixture(pool);
          const proxy = await runtimeCommitAckProxy(databaseUrl);
          const faultPool = new pg.Pool({
            connectionString: proxy.url,
            max: 2,
            connectionTimeoutMillis: 250,
          });
          faultPool.on("error", () => {});
          const originalBind = f.p.options.bind;
          let armed = false;
          f.p.options.bind = (context) => {
            const ports = originalBind(context);
            return {
              ...ports,
              evidence: {
                ...ports.evidence,
                async inspectExecutionInterruption(...args) {
                  const observed = await ports.evidence.inspectExecutionInterruption(...args);
                  if (!armed) {
                    armed = true;
                    proxy.arm();
                  }
                  return observed;
                },
              },
            };
          };
          const h = journalHarness(faultPool, { provenance: f.p });
          const receipt = { start: f.start, evidence: f.h.issue("consumption", f.start) };
          let accepts = 0,
            submits = 0;
          const native = {
            async accept(guard) {
              await guard.assertCurrent();
              accepts++;
              return receipt;
            },
            async assertCurrent(owned) {
              assert.equal(owned, receipt);
            },
            async confirmRetainedStart(owned, start) {
              assert.equal(owned, receipt);
              same(start, f.start);
            },
            async inspectInterruption(owned, operation) {
              assert.equal(owned, receipt);
              return f.h.issue("consumption", operation);
            },
            async interrupt(owned, operation) {
              assert.equal(owned, receipt);
              same(operation, f.interruption);
              submits++;
            },
          };
          const controller = new SelectedExecutionController(h.store, native, 1);
          try {
            assert.equal((await controller.consume(f.consume(), h.call)).kind, "initiated");
            await assert.rejects(controller.interrupt(f.interruption, f.p.call()));
            assert.equal(proxy.observedCommit, true);
            assert.equal(submits, 0);
            await controller.resolveInterruption(f.interruption, f.p.call());
            assert.equal(submits, 1);
            await assert.rejects(controller.resolveInterruption(f.interruption, f.p.call()));
            assert.equal(submits, 1);
            assert.equal(accepts, 1);
            same(await f.h.read((j) => j.findExecutionInterruption(f.interruption, f.h.call)), {
              kind: "found",
              interruption: f.interruption,
            });
          } finally {
            await faultPool.end();
            await proxy.close();
          }
        },
      );
      await t.test(
        "controller reserves bounded native ownership before concurrent awaits",
        async () => {
          const f = await fixture(pool);
          const second = await fixture(pool, f);
          let accepts = 0,
            entered,
            release;
          const started = new Promise((resolve) => {
            entered = resolve;
          });
          const waiting = new Promise((resolve) => {
            release = resolve;
          });
          const native = {
            async accept() {
              accepts++;
              entered();
              await waiting;
              throw new Error("unknown native acceptance");
            },
          };
          const controller = new SelectedExecutionController(f.h.store, native, 1);
          const first = controller.consume(f.consume(), f.h.call);
          await started;
          assert.equal(
            (await controller.consume(second.consume(), f.p.call())).kind,
            "execution-unknown",
          );
          release();
          assert.equal((await first).kind, "execution-unknown");
          assert.equal(accepts, 1);
        },
      );
      await t.test("cancelled selected consumption retains no intent or native start", async () => {
        const f = await fixture(pool);
        const cancellation = { ...f.v.cancellation, expectedAttemptVersion: 2 };
        assert.equal(
          committed(
            await f.h.write((j) =>
              j.commitCancellation(f.h.issue("cancellation", cancellation), f.h.call),
            ),
          ).kind,
          "recorded",
        );
        assert.equal(
          committed(await f.h.write((j) => j.consumeAttempt(f.consume(), f.h.call))).kind,
          "denied",
        );
        assert.equal(
          (await f.h.read((j) => j.findExecution(f.execution, f.h.call))).kind,
          "absent",
        );
      });
    } finally {
      await pool.end();
    }
  },
);
