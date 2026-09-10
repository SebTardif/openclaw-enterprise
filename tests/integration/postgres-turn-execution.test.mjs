import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { bindCommittedTurnJournalClock } from "../../packages/occ/src/turn-journal/transaction-guard.ts";
import {
  sampleDispatchClock,
  takeDispatchClockForExecution,
  transferDispatchDeadline,
} from "../../packages/occ/src/turn-journal/dispatcher-clock.ts";
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
      kind: "pre-commit-monotonic-v2",
      anchorAtMs: 100,
    },
  };
  const control = {
    kind: "host-stop-v2",
    intent,
    operationRef: ref("deadline"),
    operationDigest: digest(),
    nativeIncarnationRef: ref("incarnation"),
    nativeConstructionRef: ref("construction"),
    responsibilityRef: ref("cleanup"),
    responsibilityVersion: 1,
    deadlineAtMs: 900100,
  };
  const start = {
    kind: "host-controlled-v2",
    intent,
    operationRef: ref("start"),
    operationDigest: digest(),
    nativeExecutionRef: ref("native-execution"),
    nativeIncarnationRef: control.nativeIncarnationRef,
    nativeReservationRef: ref("native-reservation"),
    nativeSessionRef: ref("session"),
    nativeTurnRef: ref("turn"),
    acceptanceEvidenceRef: ref("acceptance"),
    deadlineControl: control,
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
      executionSelection: (({ dispatchClock: _clock, ...selection }) => selection)(intent),
    });
  const dispatch = () => h.issue("dispatch", v.binding);
  const bindIntent = (retained) => {
    Object.assign(intent, retained);
    control.deadlineAtMs =
      retained.maximumExecutionMs === null
        ? null
        : retained.dispatchClock.anchorAtMs + retained.maximumExecutionMs;
  };
  const consumeIn = async (j) => {
    const dispatched = await j.recordDispatchIntent(dispatch(), h.call);
    if (dispatched.kind !== "recorded") return dispatched;
    const result = await j.consumeAttempt(consume(), h.call);
    if (result.kind === "claim-pending") {
      const retained = await j.findExecution(execution, h.call);
      assert.equal(retained.kind, "intent-only");
      bindIntent(retained.intent);
    }
    return result;
  };
  const retain = () =>
    h.write((j) => j.retainExecutionStart(h.issue("consumption", start), h.call));
  return {
    h,
    p,
    v,
    execution,
    intent,
    start,
    interruption,
    consume,
    retain,
    dispatch,
    bindIntent,
    consumeIn,
    control,
    // SQL-only storage fixtures deliberately bypass provenance. Production
    // control evidence is tested separately through the real original claim.
    seedControl: () => sqlInsert(pool, v.attempt, "deadline-control", control),
    async arm(guard, retainDeadline, stop = async () => {}) {
      bindIntent(guard.executionIntent);
      const pending = {
        target: {
          nativeIncarnationRef: start.nativeIncarnationRef,
          nativeConstructionRef: control.nativeConstructionRef,
        },
        interrupt: stop,
      };
      const retention = retainDeadline(pending);
      assert.equal(Object.isFrozen(pending), true);
      assert.equal(Object.isFrozen(pending.target), true);
      assert.throws(() => {
        pending.target.nativeConstructionRef = ref("replaced");
      }, TypeError);
      assert.throws(() => {
        pending.interrupt = async () => assert.fail("replaced stop owner");
      }, TypeError);
      const issued = await retention;
      Object.assign(control, issued);
      start.deadlineControl = control;
    },
  };
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
          let originalGuard;
          const before = process.hrtime.bigint();
          const result = await f.h.store.dispatchAndConsumeAndInitiate(
            f.dispatch(),
            f.consume(),
            async (attempt, guard) => {
              callbacks++;
              originalGuard = guard;
              assert.equal(Object.isFrozen(guard), true);
              assert.throws(() => {
                guard.assertCurrent = async () => {};
              }, TypeError);
              f.bindIntent(guard.executionIntent);
              const sample = await sampleDispatchClock(guard, ref("challenge"));
              same(sample.dispatchClock, f.intent.dispatchClock);
              assert.equal(sample.dispatchClock.kind, "pre-commit-monotonic-v2");
              assert.equal(Object.hasOwn(sample.dispatchClock, "deadlineAtMs"), false);
              assert.ok(sample.sampledAtMs >= sample.dispatchClock.anchorAtMs);
              assert.ok(
                sample.sampledAtMs - sample.dispatchClock.anchorAtMs <=
                  Number(process.hrtime.bigint() - before) / 1e6 + 2,
              );
              await assert.rejects(sampleDispatchClock({ ...guard }, ref("copied")));
              assert.throws(() =>
                bindCommittedTurnJournalClock(
                  {},
                  { operation: f.v.consumption },
                  { ...guard },
                  f.h.call,
                ),
              );
              same(attempt, f.v.attempt);
              same(guard.executionIntent, f.intent);
              await guard.assertCurrent();
            },
            f.h.call,
          );
          assert.equal(result.kind, "initiated");
          assert.equal(callbacks, 1);
          await assert.rejects(sampleDispatchClock(originalGuard, ref("closed")));
          const originalClock = structuredClone(f.intent.dispatchClock);
          assert.equal(
            (
              await f.h.store.dispatchAndConsumeAndInitiate(
                f.dispatch(),
                f.consume(),
                async () => {
                  callbacks++;
                },
                f.h.call,
              )
            ).kind,
            "unavailable",
          );
          same(
            (await f.h.read((j) => j.findExecution(f.execution, f.h.call))).intent.dispatchClock,
            originalClock,
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
          assert.equal(callbacks, 1);
          same(await f.h.read((j) => j.findExecution(f.execution, f.h.call)), {
            kind: "intent-only",
            intent: f.intent,
          });
        },
      );
      await t.test(
        "paired consumption denial rolls back dispatch and cannot export a clock",
        async () => {
          const f = await fixture(pool);
          const invalid = f.h.issue("consumption", {
            operation: f.v.consumption,
            binding: { ...f.v.binding, authorityDecisionRef: ref("changed") },
            executionSelection: (({ dispatchClock, ...selection }) => selection)(f.intent),
          });
          let callbacks = 0;
          assert.equal(
            (
              await f.h.store.dispatchAndConsumeAndInitiate(
                f.dispatch(),
                invalid,
                async () => {
                  callbacks++;
                },
                f.h.call,
              )
            ).kind,
            "unavailable",
          );
          const record = (await f.h.read((j) => j.findAttempt(f.v.attempt, f.h.call))).record;
          assert.equal(record.outcome.kind, "accepted-undispatched");
          assert.equal(
            (await f.h.read((j) => j.findExecution(f.execution, f.h.call))).kind,
            "absent",
          );
          assert.equal(callbacks, 0);
        },
      );
      await t.test(
        "dispatch A and unselected consumption B cannot commit as a paired initiation",
        async () => {
          const a = await fixture(pool);
          const b = await fixture(pool, a);
          assert.equal(
            committed(await b.h.write((j) => j.recordDispatchIntent(b.dispatch(), b.h.call))).kind,
            "recorded",
          );
          let callbacks = 0;
          const unselected = b.h.issue("consumption", {
            operation: b.v.consumption,
            binding: b.v.binding,
          });
          const result = await a.h.store.dispatchAndConsumeAndInitiate(
            a.dispatch(),
            unselected,
            async () => {
              callbacks++;
            },
            a.h.call,
          );
          assert.equal(result.kind, "unavailable");
          assert.equal(callbacks, 0);
          const afterA = (await a.h.read((j) => j.findAttempt(a.v.attempt, a.h.call))).record;
          const afterB = (await b.h.read((j) => j.findAttempt(b.v.attempt, b.h.call))).record;
          assert.equal(afterA.outcome.kind, "accepted-undispatched");
          assert.equal(afterA.consumption, null);
          assert.equal(afterB.outcome.kind, "dispatch-intent");
          assert.equal(afterB.consumption, null);
        },
      );
      await t.test(
        "a separately committed dispatch cannot renew its clock during consumption",
        async () => {
          const f = await fixture(pool);
          assert.equal(
            committed(await f.h.write((j) => j.recordDispatchIntent(f.dispatch(), f.h.call))).kind,
            "recorded",
          );
          let callbacks = 0;
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
            "unavailable",
          );
          const record = (await f.h.read((j) => j.findAttempt(f.v.attempt, f.h.call))).record;
          assert.equal(record.outcome.kind, "dispatch-intent");
          assert.equal(record.consumption, null);
          assert.equal(callbacks, 0);
        },
      );
      await t.test(
        "rollback and orphan or late direct intent cannot retain selected ownership",
        async () => {
          const f = await fixture(pool);
          assert.equal(
            (
              await f.h.write(async (j) => {
                await f.consumeIn(j);
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
            await f.h.write(async (j) => {
              await j.recordDispatchIntent(f.dispatch(), f.h.call);
              return j.consumeAttempt(
                f.h.issue("consumption", { operation: f.v.consumption, binding: f.v.binding }),
                f.h.call,
              );
            }),
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
          committed(await f.h.write((j) => f.consumeIn(j)));
          await f.seedControl();
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
        "SQL and codec enforce explicit capped and uncapped policy identically",
        async () => {
          const f = await fixture(pool);
          for (const maximumExecutionMs of [null, 1, 900001, 86_400_000]) {
            const intent = { ...f.intent, maximumExecutionMs };
            const deadlineAtMs = maximumExecutionMs === null ? null : 100 + maximumExecutionMs;
            const control = { ...f.control, intent, deadlineAtMs };
            for (const [kind, value] of [
              ["executionIntent", intent],
              ["deadlineControl", control],
            ]) {
              parseTurnJournalV1(kind, value);
              assert.equal(
                (
                  await pool.query("SELECT occ.turn_journal_execution_valid($1,$2::jsonb) valid", [
                    kind,
                    JSON.stringify(value),
                  ])
                ).rows[0].valid,
                true,
              );
            }
            // Duration mode cannot be omitted, exchanged, or renewed in a retained control.
            for (const changed of [
              { ...control, deadlineAtMs: deadlineAtMs === null ? 1100 : null },
              { ...control, deadlineAtMs: undefined },
              { ...control, intent: { ...intent, maximumExecutionMs: undefined } },
              { ...control, intent: { ...intent, maximumExecutionMs: 0 } },
              {
                ...control,
                intent: {
                  ...intent,
                  dispatchClock: { ...intent.dispatchClock, deadlineAtMs: 900100 },
                },
              },
            ]) {
              assert.throws(() => parseTurnJournalV1("deadlineControl", changed));
              assert.equal(
                (
                  await pool.query(
                    "SELECT occ.turn_journal_execution_valid('deadlineControl',$1::jsonb) valid",
                    [JSON.stringify(changed)],
                  )
                ).rows[0].valid,
                false,
              );
            }
          }
        },
      );
      await t.test(
        "database validates exact native record and refuses earlier dispatch deadline renewal",
        async () => {
          const f = await fixture(pool);
          committed(await f.h.write((j) => f.consumeIn(j)));
          await f.seedControl();
          for (const change of [
            { deadlineControl: { ...f.control, deadlineAtMs: f.control.deadlineAtMs + 1 } },
            { deadlineControl: { ...f.control, nativeConstructionRef: ref("foreign") } },
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
        committed(await f.h.write((j) => f.consumeIn(j)));
        await f.seedControl();
        committed(await f.retain());
        const other = await fixture(pool, f);
        committed(await other.h.write((j) => other.consumeIn(j)));
        other.control.nativeIncarnationRef = f.start.nativeIncarnationRef;
        other.start.nativeIncarnationRef = f.start.nativeIncarnationRef;
        await other.seedControl();
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
        const { dispatchClock: _clock, ...selected } = f.intent;
        const changed = { ...selected, executionLimitVersion: 2 };
        const handle = f.h.issue("consumption", {
          operation: f.v.consumption,
          binding: f.v.binding,
          executionSelection: changed,
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
          committed(await f.h.write((j) => f.consumeIn(j)));
          await f.seedControl();
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
                await h.store.dispatchAndConsumeAndInitiate(
                  f.dispatch(),
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
          committed(await f.h.write((j) => f.consumeIn(j)));
          await f.seedControl();
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
          committed(await f.h.write((j) => f.consumeIn(j)));
          await f.seedControl();
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
            start: { ...f.start, nativeTurnRef: ref("other-turn") },
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
            async accept(guard, _call, retainDeadline) {
              accepts++;
              await guard.assertCurrent();
              await f.arm(guard, retainDeadline);
              receipt.evidence = f.h.issue("consumption", f.start);
              const otherController = new SelectedExecutionController(h.store, native, 10);
              await assert.rejects(otherController.acceptInitiation(f.v.attempt, guard, h.call));
              await assert.rejects(
                otherController.acceptInitiation(f.v.attempt, { ...guard }, h.call),
              );
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
            assert.equal(
              (await controller.dispatchAndConsume(f.dispatch(), f.consume(), h.call)).kind,
              "execution-unknown",
            );
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
          f.intent.maximumExecutionMs = null;
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
            async accept(guard, _call, retainDeadline) {
              await guard.assertCurrent();
              await f.arm(guard, retainDeadline);
              receipt.evidence = f.h.issue("consumption", f.start);
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
            assert.equal(
              (
                await h.store.dispatchAndConsumeAndInitiate(
                  f.dispatch(),
                  f.consume(),
                  async (attempt, guard) => {
                    await assert.rejects(controller.acceptInitiation(attempt, guard, f.p.call()));
                    await controller.acceptInitiation(attempt, guard, h.call);
                  },
                  h.call,
                )
              ).kind,
              "initiated",
            );
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
          const first = controller.dispatchAndConsume(f.dispatch(), f.consume(), f.h.call);
          await Promise.race([
            started,
            first.then((result) => assert.fail(`Native owner was not entered: ${result.kind}`)),
          ]);
          assert.equal(
            (await controller.dispatchAndConsume(second.dispatch(), second.consume(), f.p.call()))
              .kind,
            "execution-unknown",
          );
          release();
          assert.equal((await first).kind, "execution-unknown");
          assert.equal(accepts, 1);
        },
      );
      await t.test(
        "uncapped execution retains original stop control and cannot replay after callback closure",
        async () => {
          const f = await fixture(pool);
          f.intent.maximumExecutionMs = null;
          let owner,
            stopped = 0;
          const result = await f.h.store.dispatchAndConsumeAndInitiate(
            f.dispatch(),
            f.consume(),
            async (_attempt, guard) => {
              f.bindIntent(guard.executionIntent);
              takeDispatchClockForExecution(guard, f.h.call);
              owner = transferDispatchDeadline(
                guard,
                f.h.call,
                {
                  nativeIncarnationRef: f.start.nativeIncarnationRef,
                  nativeConstructionRef: f.control.nativeConstructionRef,
                },
                async () => {
                  stopped++;
                },
              );
              assert.equal(owner.control.deadlineAtMs, null);
              assert.equal(owner.control.intent.maximumExecutionMs, null);
              assert.equal(
                committed(await f.h.write((j) => j.retainDeadlineControl(owner.evidence, f.h.call)))
                  .kind,
                "recorded",
              );
              owner.assertBeforeEffect();
            },
            f.h.call,
          );
          assert.equal(result.kind, "initiated");
          owner.assertBeforeEffect();
          assert.equal(stopped, 0);
          // A fresh authority call does not renew/reconstruct consumed ownership.
          assert.equal(
            (
              await f.h.store.dispatchAndConsumeAndInitiate(
                f.dispatch(),
                f.consume(),
                async () => assert.fail("replay"),
                f.p.call(),
              )
            ).kind,
            "unavailable",
          );
          assert.equal(
            (await f.h.read((j) => j.findDeadlineControl(f.execution, f.h.call))).control
              .deadlineAtMs,
            null,
          );
          f.p.setAllowed(false);
          await Promise.all([owner.requestStop(), owner.requestStop()]);
          assert.equal(stopped, 1);
          assert.throws(() => owner.assertBeforeEffect());
          const reservations = await pool.query(
            "SELECT count(*)::int n FROM occ.turn_journal_reservations WHERE attempt_ref=$1",
            [f.v.attempt.attemptRef],
          );
          assert.equal(reservations.rows[0].n, 1);
        },
      );
      await t.test(
        "controller schedules a cap beyond Node timer range without early expiry or renewal",
        async () => {
          const f = await fixture(pool);
          // The extra minute exceeds the entire bounded initiation window, so
          // the first remaining delay must exceed Node's signed 32-bit timer limit.
          f.intent.maximumExecutionMs = 2_147_483_647 + 60_000;
          let receipt,
            stops = 0,
            confirmations = 0,
            interruptions = 0;
          const native = {
            async accept(guard, _call, retainDeadline) {
              await f.arm(guard, retainDeadline, async () => {
                stops++;
              });
              receipt = { start: f.start, evidence: f.h.issue("consumption", f.start) };
              return receipt;
            },
            async assertCurrent(owned) {
              assert.equal(owned, receipt);
            },
            async confirmRetainedStart(owned, start) {
              assert.equal(owned, receipt);
              same(start, f.start);
              confirmations++;
            },
            async inspectInterruption(owned, operation) {
              assert.equal(owned, receipt);
              return f.h.issue("consumption", operation);
            },
            async interrupt(owned, operation) {
              assert.equal(owned, receipt);
              same(operation, f.interruption);
              interruptions++;
            },
          };
          const controller = new SelectedExecutionController(f.h.store, native, 1);
          assert.equal(
            (await controller.dispatchAndConsume(f.dispatch(), f.consume(), f.h.call)).kind,
            "initiated",
          );
          const originalDeadline = f.intent.dispatchClock.anchorAtMs + f.intent.maximumExecutionMs;
          assert.equal(f.control.deadlineAtMs, originalDeadline);
          // Observe actual timers beyond the overflow-to-1ms window. This proves
          // scheduling at the boundary, not passage of the full 25-day duration.
          await new Promise((resolve) => setTimeout(resolve, 75));
          assert.equal(stops, 0);
          assert.equal(confirmations, 1);
          const call = f.p.call();
          const retained = await f.h.read((j) => j.findExecution(f.execution, call), call);
          assert.equal(retained.kind, "started");
          assert.equal(retained.start.deadlineControl.deadlineAtMs, originalDeadline);
          await controller.interrupt(f.interruption, f.p.call());
          assert.equal(interruptions, 1);
          assert.equal(stops, 0);
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
        "uncapped failed construction requests retained cleanup and keeps capacity",
        async () => {
          const f = await fixture(pool);
          f.intent.maximumExecutionMs = null;
          let stops = 0,
            accepts = 0;
          const native = {
            async accept(guard, _call, retainDeadline) {
              accepts++;
              await f.arm(guard, retainDeadline, async () => {
                stops++;
              });
              throw new Error("Unknown construction outcome");
            },
          };
          const controller = new SelectedExecutionController(f.h.store, native, 1);
          assert.equal(
            (await controller.dispatchAndConsume(f.dispatch(), f.consume(), f.h.call)).kind,
            "execution-unknown",
          );
          assert.equal(stops, 1);
          const second = await fixture(pool, f);
          second.intent.maximumExecutionMs = null;
          assert.equal(
            (await controller.dispatchAndConsume(second.dispatch(), second.consume(), f.p.call()))
              .kind,
            "execution-unknown",
          );
          assert.equal(accepts, 1);
          assert.equal(stops, 1);
          assert.equal(
            (await f.h.read((j) => j.findExecution(f.execution, f.h.call))).kind,
            "intent-only",
          );
        },
      );
      await t.test(
        "original cleanup transfer survives callback closure and rejects copied evidence",
        async () => {
          const f = await fixture(pool);
          f.intent.maximumExecutionMs = 1500;
          let originalGuard,
            stopped = 0,
            gates = 0,
            exactControl;
          const native = {
            async accept(guard, _call, retainDeadline) {
              originalGuard = guard;
              await f.arm(guard, retainDeadline, async (control) => {
                stopped++;
                exactControl = control;
              });
              return { start: f.start, evidence: f.h.issue("consumption", f.start) };
            },
            async assertCurrent() {},
            async confirmRetainedStart() {
              gates++;
            },
          };
          const controller = new SelectedExecutionController(f.h.store, native, 1);
          assert.equal(
            (await controller.dispatchAndConsume(f.dispatch(), f.consume(), f.h.call)).kind,
            "initiated",
          );
          assert.equal(gates, 1);
          await assert.rejects(sampleDispatchClock(originalGuard, ref("closed")));
          assert.throws(() =>
            transferDispatchDeadline(
              originalGuard,
              f.h.call,
              {
                nativeIncarnationRef: f.start.nativeIncarnationRef,
                nativeConstructionRef: ref("late"),
              },
              async () => {},
            ),
          );
          assert.equal(
            committed(await f.h.write((j) => j.retainDeadlineControl({}, f.h.call))).kind,
            "unavailable",
          );
          same(
            (await f.h.read((j) => j.findDeadlineControl(f.execution, f.h.call))).control,
            f.control,
          );
          // Revoking continuing authority cannot revoke the cleanup already
          // admitted for this exact construction.
          f.p.setAllowed(false);
          await new Promise((resolve) => setTimeout(resolve, 1550));
          assert.equal(stopped, 1);
          same(exactControl, f.control);
          await assert.rejects(controller.resolveStart(f.execution, f.p.call()));
          assert.equal(stopped, 1);
          const reservations = await pool.query(
            "SELECT count(*)::int n FROM occ.turn_journal_reservations WHERE attempt_ref=$1",
            [f.v.attempt.attemptRef],
          );
          assert.equal(reservations.rows[0].n, 1);
        },
      );
      await t.test("deadline stop bypasses blocked pre-start PostgreSQL retention", async () => {
        const f = await fixture(pool);
        f.intent.maximumExecutionMs = 1200;
        let stopped = 0,
          constructors = 0,
          notified;
        const stopReceived = new Promise((resolve) => {
          notified = resolve;
        });
        const locker = await pool.connect();
        let locked = false;
        const native = {
          async accept(guard, _call, retainDeadline) {
            await locker.query("BEGIN");
            locked = true;
            await locker.query("SELECT id FROM occ.agents WHERE id=$1 FOR UPDATE", [
              f.v.attempt.agentRef,
            ]);
            await f.arm(guard, retainDeadline, async () => {
              stopped++;
              notified();
            });
            constructors++;
            throw new Error("Construction must stay gated");
          },
        };
        const controller = new SelectedExecutionController(f.h.store, native, 1);
        const running = controller.dispatchAndConsume(f.dispatch(), f.consume(), f.h.call);
        try {
          await Promise.race([
            stopReceived,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Stop waited behind PostgreSQL")), 4000),
            ),
          ]);
          assert.equal(stopped, 1);
          assert.equal(constructors, 0);
        } finally {
          if (locked) await locker.query("ROLLBACK");
          locker.release();
        }
        assert.equal((await running).kind, "execution-unknown");
        assert.equal(constructors, 0);
        assert.equal(stopped, 1);
        assert.equal(
          (await f.h.read((j) => j.findExecution(f.execution, f.h.call))).kind,
          "intent-only",
        );
        assert.equal(
          (await f.h.read((j) => j.findDeadlineControl(f.execution, f.h.call))).kind,
          "absent",
        );
      });
      await t.test(
        "unknown conditional-control COMMIT never starts construction or mints a replay",
        async () => {
          const f = await fixture(pool);
          f.intent.maximumExecutionMs = 2500;
          const proxy = await runtimeCommitAckProxy(databaseUrl);
          const faultPool = new pg.Pool({
            connectionString: proxy.url,
            max: 2,
            connectionTimeoutMillis: 250,
          });
          faultPool.on("error", () => {});
          let constructors = 0,
            stops = 0;
          try {
            const bind = f.p.options.bind;
            f.p.options.bind = (context) => {
              const ports = bind(context);
              const query = context.query.query.bind(context.query);
              context.query.query = async (statement, parameters) => {
                const result = await query(statement, parameters);
                // Arm after the actual INSERT: currentness-read COMMITs must
                // not consume the conditional-control acknowledgment fault.
                if (
                  statement.startsWith("INSERT INTO occ.turn_journal_operations") &&
                  parameters?.[7] === "deadline-control"
                )
                  proxy.arm();
                return result;
              };
              return ports;
            };
            const h = journalHarness(faultPool, { provenance: f.p });
            const native = {
              async accept(guard, _call, retainDeadline) {
                await f.arm(guard, retainDeadline, async () => {
                  stops++;
                  throw new Error("Unknown native stop ACK");
                });
                constructors++;
                throw new Error("Unknown control cannot start construction");
              },
            };
            const controller = new SelectedExecutionController(h.store, native, 1);
            assert.equal(
              (await controller.dispatchAndConsume(f.dispatch(), f.consume(), h.call)).kind,
              "execution-unknown",
            );
            assert.equal(proxy.observedCommit, true);
            assert.equal(constructors, 0);
            assert.equal(
              (await f.h.read((j) => j.findDeadlineControl(f.execution, f.h.call))).kind,
              "found",
            );
            await new Promise((resolve) => setTimeout(resolve, 2550));
            assert.equal(stops, 1);
            assert.equal(
              (await controller.dispatchAndConsume(f.dispatch(), f.consume(), f.p.call())).kind,
              "unavailable",
            );
            assert.equal(stops, 1);
            assert.equal(constructors, 0);
          } finally {
            await faultPool.end();
            await proxy.close();
          }
        },
      );
      await t.test("cancelled selected consumption retains no intent or native start", async () => {
        const f = await fixture(pool);
        committed(await f.h.write((j) => j.recordDispatchIntent(f.dispatch(), f.h.call)));
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
