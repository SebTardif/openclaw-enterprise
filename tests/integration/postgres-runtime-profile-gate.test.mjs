import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/ports/transaction-errors.ts";
import { PostgresWorkQueue } from "../../packages/occ/src/state/postgres-work-queue.ts";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";
import { seedProfileGate, profileState } from "../fixtures/runtime-profile-gate.mjs";
const url = process.env.OCC_RUNTIME_GATE_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname));
  assert.match(parsed.pathname, /^\/openclaw_profile_withdrawal_[a-z0-9_]+$/);
}
const skip =
  url === undefined ? "Select the exclusive migrated profile-withdrawal gate database." : false;
async function poolFor(t, connectionString = url) {
  const pool = new pg.Pool({
    connectionString,
    max: 6,
    connectionTimeoutMillis: 250,
    query_timeout: 10000,
  });
  pool.on("error", () => {});
  t.after(() => pool.end());
  return pool;
}

test(
  "original profile withdrawal retains exact same-generation cleanup and original work",
  { skip },
  async (t) => {
    const pool = await poolFor(t),
      f = await seedProfileGate(pool);
    const before = await f.read();
    const withdrawn = await f.withdraw();
    const gate = await f.read(),
      closure = await f.closure();
    assert.equal(withdrawn.head.state, "withdrawn");
    assert.equal(gate.guard.intentRef, before.guard.intentRef);
    assert.equal(gate.guard.lifecycleGeneration, before.guard.lifecycleGeneration);
    assert.equal(gate.guard.gateVersion, before.guard.gateVersion + 1);
    assert.equal(gate.guard.requestedFenceEpoch, before.guard.requestedFenceEpoch + 1);
    assert.equal(gate.guard.admittedChildCutoff, 0);
    assert.equal(gate.ordinaryAdmission, "closed");
    assert.equal(gate.sealerAdmission, "closed");
    assert.deepEqual(closure.priorGuard, before.guard);
    assert.deepEqual(closure.closedGuard, gate.guard);
    assert.equal(closure.work.invalidationRef, f.head.terminal.invalidationRef);
    assert.equal(closure.work.schemaVersion, 3);
    const work = (
      await pool.query("SELECT * FROM occ.controller_work WHERE idempotency_key=$1", [
        closure.work.workId,
      ])
    ).rows[0];
    assert.equal(work.state, "queued");
    assert.equal(work.actor_id, f.actor.principalRef);
    assert.equal(work.lifecycle_operation_ref, null);
    assert.equal(work.legacy_runtime_transition_ref, null);
    assert.equal(work.revision_id, f.owner.target.revisionId);
    assert.deepEqual(work.profile_work, closure.work);
    const membership = await pool.query(
      "SELECT assignment_ref FROM occ.runtime_cleanup_responsibility_allocations WHERE responsibility_ref=$1",
      [closure.work.responsibilityRef],
    );
    assert.deepEqual(
      membership.rows.map((x) => x.assignment_ref),
      [f.owner.target.assignmentRef.id],
    );
    await pool.query("SELECT occ.close_runtime_gates_for_profile_v1($1,$2)", [
      f.owner.scope.installationId,
      f.head.terminal.invalidationRef,
    ]);
    assert.deepEqual(await f.closure(), closure);
    assert.deepEqual(await f.read(), gate);
    const queue = new PostgresWorkQueue(pool);
    assert.equal(await queue.claimRuntimeProfile(), undefined);
    assert.equal(await queue.recoverRuntimeProfile(), 0);
  },
);

test(
  "withdrawal rollback preserves original profile and gate without orphan cleanup",
  { skip },
  async (t) => {
    const pool = await poolFor(t),
      f = await seedProfileGate(pool),
      before = await f.read();
    await assert.rejects(
      f.withdraw(f.attribution(), async () => {
        throw new Error("rollback-profile-unit");
      }),
    );
    assert.deepEqual(await f.read(), before);
    assert.equal(await f.closure(), undefined);
    const profile = (
      await pool.query("SELECT state FROM occ.workload_profile_admissions WHERE admission_ref=$1", [
        f.head.selection.admissionRef,
      ])
    ).rows[0];
    assert.equal(profile.state, "admitted");
    await f.withdraw();
    assert.ok(await f.closure());
  },
);

test(
  "withdrawal prevents late gate initialization and does not affect an unrelated profile",
  { skip },
  async (t) => {
    const pool = await poolFor(t),
      a = await seedProfileGate(pool, { initialize: false }),
      b = await seedProfileGate(pool),
      before = await b.read();
    await a.withdraw();
    await assert.rejects(a.initializeGate());
    await assert.rejects(
      pool.query(
        `INSERT INTO occ.runtime_effect_gates
      (installation_id,namespace_id,agent_id,preparation_ref,preparation_operation_ref,target,gate_guard,plan)
      SELECT installation_id,namespace_id,agent_id,preparation_ref,operation_ref,
        canonical_request::jsonb->'target',canonical_request::jsonb->'guard',canonical_request::jsonb->'plan'
      FROM occ.runtime_preparation_operations WHERE operation_ref=$1`,
        [a.owner.plan.operationRef],
      ),
      { code: "23514" },
    );
    assert.equal(await a.read(), undefined);
    assert.deepEqual(await b.read(), before);
    assert.equal(await b.closure(), undefined);
  },
);

test(
  "gate initialization serializes withdrawal under the original capacity prefix",
  { skip },
  async (t) => {
    const pool = await poolFor(t),
      f = await seedProfileGate(pool, { initialize: false });
    let release, entered;
    const held = new Promise((r) => {
        release = r;
      }),
      locked = new Promise((r) => {
        entered = r;
      });
    const owner = f.state.transact(async (unit) => {
      await unit.runtimeEffectAdmission.retainClosedGate(f.owner.scope, f.owner.plan.operationRef);
      entered();
      await held;
    });
    await locked;
    const other = profileState(pool);
    let settled = false;
    const withdraw = other
      .transactProfile(f.owner.scope.installationId, (r) =>
        r.withdraw(f.owner.scope.namespaceId, f.head.selection, f.attribution()),
      )
      .finally(() => {
        settled = true;
      });
    await delay(100);
    assert.equal(settled, false);
    release();
    await owner;
    await withdraw;
    assert.ok(await f.closure());
  },
);

test(
  "replacement closes the original profile gate while successor profile stays admitted",
  { skip },
  async (t) => {
    const pool = await poolFor(t),
      f = await seedProfileGate(pool),
      before = await f.read();
    const successor = await f.accept(f.head.selection);
    assert.equal(successor.state, "admitted");
    assert.notEqual(successor.selection.admissionRef, f.head.selection.admissionRef);
    assert.equal((await f.read()).guard.gateVersion, before.guard.gateVersion + 1);
    assert.ok(await f.closure());
    const state = (
      await pool.query("SELECT state FROM occ.workload_profile_admissions WHERE admission_ref=$1", [
        successor.selection.admissionRef,
      ])
    ).rows[0];
    assert.equal(state.state, "admitted");
  },
);

test(
  "lost withdrawal COMMIT is resolved through exact original invalidation readback",
  { skip },
  async (t) => {
    const pool = await poolFor(t),
      f = await seedProfileGate(pool);
    const proxy = await runtimeCommitAckProxy(url);
    t.after(() => proxy.close());
    const proxied = await poolFor(t, proxy.url),
      bound = profileState(proxied),
      attribution = f.attribution();
    proxy.arm();
    await assert.rejects(
      bound.transactProfile(f.owner.scope.installationId, (r) =>
        r.withdraw(f.owner.scope.namespaceId, f.head.selection, attribution),
      ),
      PostgresCommitOutcomeUnknownError,
    );
    assert.equal(proxy.observedCommit, true);
    const closure = await f.closure();
    assert.ok(closure);
    await f.withdraw(attribution);
    assert.deepEqual(await f.closure(), closure);
  },
);

test(
  "direct profile gate source operations reject weaker isolation and forged association",
  { skip },
  async (t) => {
    const pool = await poolFor(t),
      f = await seedProfileGate(pool);
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await assert.rejects(
        client.query("SELECT occ.close_runtime_gates_for_profile_v1($1,$2)", [
          f.owner.scope.installationId,
          randomUUID(),
        ]),
        (e) => e.code === "23514",
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    await f.withdraw();
    const closure = await f.closure();
    await assert.rejects(
      pool.query(
        "UPDATE occ.runtime_cleanup_responsibilities SET profile_invalidation_ref=$1 WHERE responsibility_ref=$2",
        [randomUUID(), closure.work.responsibilityRef],
      ),
      (e) => e.code === "42501",
    );
  },
);

test(
  "one original invalidation closes each exact Agent and preserves the replacement's Agent",
  { skip },
  async (t) => {
    const pool = await poolFor(t),
      f = await seedProfileGate(pool),
      other = await f.anotherAgent();
    const before = [await f.read(), await other.read()];
    const successor = await f.accept(f.head.selection);
    const current = await f.anotherAgent(successor),
      currentBefore = await current.read();
    const closures = [await f.closure(), await other.closure()];
    assert.ok(closures.every(Boolean));
    assert.notEqual(closures[0].work.operationRef, closures[1].work.operationRef);
    for (let index = 0; index < 2; index++) {
      assert.deepEqual(closures[index].priorGuard, before[index].guard);
      assert.equal(closures[index].work.invalidationRef, f.head.terminal.invalidationRef);
    }
    await pool.query("SELECT occ.close_runtime_gates_for_profile_v1($1,$2)", [
      f.owner.scope.installationId,
      f.head.terminal.invalidationRef,
    ]);
    assert.deepEqual(await current.read(), currentBefore);
    assert.equal(await current.closure(), undefined);
    const count = await pool.query(
      "SELECT count(*)::int AS count FROM occ.runtime_cleanup_responsibilities WHERE origin_kind='runtime-profile-v1' AND profile_invalidation_ref=$1",
      [f.head.terminal.invalidationRef],
    );
    assert.equal(count.rows[0].count, 2);
  },
);

// The current-use side uses the real session, Native IAM, original queue claim
// and selected profile owner. No provider effect or fabricated authority enters.
test(
  "direct head DML settles after actual original current-use releases the shared source prefix",
  { skip, timeout: 30000 },
  async (t) => {
    const { invocationControllerRole, invocationSessionHelper, seedRuntimePreparationInvocation } =
      await import("../fixtures/runtime-preparation-invocation.mjs");
    const selectedUrl = process.env.OCC_WORKLOAD_PROFILE_RECEIVING_DATABASE_URL;
    assert.ok(selectedUrl);
    const appUrl = new URL(url),
      roleUrl = new URL(selectedUrl);
    for (const field of ["hostname", "port", "pathname"])
      assert.equal(roleUrl[field], appUrl[field]);
    const pool = await poolFor(t),
      selected = await poolFor(t, selectedUrl),
      catalog = await poolFor(t, process.env.OCC_MIGRATION_DATABASE_URL);
    const previous = (
      await catalog.query(
        "SELECT has_function_privilege($1,$2,'EXECUTE') AS execute,has_table_privilege($1,'occ.runtime_preparation_admission_origins','INSERT') AS insert",
        [invocationControllerRole, invocationSessionHelper],
      )
    ).rows[0];
    let fixture, claim;
    try {
      if (!previous.execute)
        await catalog.query(
          `GRANT EXECUTE ON FUNCTION ${invocationSessionHelper} TO ${invocationControllerRole}`,
        );
      if (!previous.insert)
        await catalog.query(
          `GRANT INSERT ON occ.runtime_preparation_admission_origins TO ${invocationControllerRole}`,
        );
      fixture = await seedRuntimePreparationInvocation(selected);
      claim = await fixture.claimOriginalWork();
      const scope = fixture.plan.guard.scope;
      await fixture.state.transact((unit) =>
        unit.runtimeEffectAdmission.retainClosedGate(scope, fixture.plan.operationRef),
      );
      const head = (
        await pool.query(
          "SELECT record FROM occ.workload_profile_admissions WHERE admission_ref=$1",
          [fixture.revision.workloadProfileUse.admissionRef],
        )
      ).rows[0].record;
      const captured = [];
      const recording = {
        options: pool.options,
        async connect() {
          const client = await pool.connect();
          return {
            on: client.on.bind(client),
            removeListener: client.removeListener.bind(client),
            release: client.release.bind(client),
            async query(statement, values) {
              const result = await client.query(statement, values);
              if (
                /^\s*(INSERT|UPDATE)\b/i.test(statement) &&
                !/INSERT INTO occ.workload_profile_capacity/i.test(statement)
              )
                captured.push([statement, values]);
              return result;
            },
          };
        },
      };
      const recordingState = profileState(recording);
      const attribution = {
        actor: head.acceptance.actor,
        operationRef: randomUUID(),
        requestRef: `direct/${randomUUID()}`,
        decisionRef: `decision/${randomUUID()}`,
      };
      await assert.rejects(
        recordingState.transactProfile(
          scope.installationId,
          (r) => r.withdraw(scope.namespaceId, head.selection, attribution),
          async () => {
            throw new Error("capture-and-rollback-original-source");
          },
        ),
      );
      assert.match(captured[0][0], /UPDATE occ.workload_profile_admissions/);
      let enter, release, currentPid;
      const entered = new Promise((r) => {
          enter = r;
        }),
        held = new Promise((r) => {
          release = r;
        });
      const current = fixture.state.withRuntimePreparationWorkerCurrentUseV1(
        fixture.drivers,
        claim,
        fixture.currentUseRequest,
        { signal: new AbortController().signal, timeoutMs: 3000 },
        async (lease, io) => {
          lease.assertCurrent();
          currentPid = (await io.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          enter();
          await held;
          lease.assertCurrent();
          return "original-current-use";
        },
      );
      await Promise.race([
        entered,
        current.then(() => {
          throw new Error("current owner returned before entering");
        }),
      ]);
      const writer = await pool.connect();
      const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      let settled = false;
      const direct = (async () => {
        try {
          await writer.query("BEGIN");
          for (const [statement, values] of captured) await writer.query(statement, values);
          await writer.query("COMMIT");
        } catch (error) {
          await writer.query("ROLLBACK");
          throw error;
        } finally {
          settled = true;
          writer.release();
        }
      })();
      try {
        let waits = [];
        for (let attempt = 0; attempt < 25; attempt++) {
          waits = (
            await pool.query(
              `SELECT w.mode AS waiting_mode,h.mode AS held_mode,
            w.classid=((hashtextextended('workload-profile-capacity:'||$3,0)>>32)&4294967295)::oid AS exact_high,
            w.objid=(hashtextextended('workload-profile-capacity:'||$3,0)&4294967295)::oid AS exact_low
            FROM pg_locks w JOIN pg_locks h USING(locktype,database,classid,objid,objsubid)
            WHERE w.pid=$1 AND h.pid=$2 AND w.locktype='advisory' AND w.objsubid=1
              AND NOT w.granted AND h.granted`,
              [writerPid, currentPid, scope.installationId],
            )
          ).rows;
          if (waits.length) break;
          await delay(10);
        }
        assert.deepEqual(waits, [
          {
            waiting_mode: "ExclusiveLock",
            held_mode: "ShareLock",
            exact_high: true,
            exact_low: true,
          },
        ]);
        assert.equal(settled, false);
      } finally {
        release();
      }
      assert.equal(await current, "original-current-use");
      await direct;
      assert.equal(settled, true);
      const retained = await fixture.state.read((view) =>
        view.runtimeEffectAdmission.findProfileClosure(scope, head.terminal.invalidationRef),
      );
      assert.ok(retained);
      assert.equal(retained.work.admissionRef, head.selection.admissionRef);
    } finally {
      try {
        if (fixture && claim) await fixture.releaseClaim(claim);
      } finally {
        const results = await Promise.allSettled([
          previous.insert
            ? Promise.resolve()
            : catalog.query(
                `REVOKE INSERT ON occ.runtime_preparation_admission_origins FROM ${invocationControllerRole}`,
              ),
          previous.execute
            ? Promise.resolve()
            : catalog.query(
                `REVOKE EXECUTE ON FUNCTION ${invocationSessionHelper} FROM ${invocationControllerRole}`,
              ),
        ]);
        for (const result of results) if (result.status === "rejected") throw result.reason;
      }
    }
  },
);

test(
  "original schema3 worker recovers after later lifecycle closure and preserves responsibility on withdrawal",
  { skip, timeout: 30000 },
  async (t) => {
    const { RuntimeProfileWorker } =
      await import("../../apps/controller/src/worker/runtime-profile.ts");
    const { PostgresPlatformState } =
      await import("../../packages/occ/src/state/postgres-state.ts");
    const { protectiveWrite } =
      await import("../fixtures/lifecycle-protective-admission/shared-cases.mjs");
    const { execFile } = await import("node:child_process"),
      { promisify } = await import("node:util");
    const workerUrl = process.env.OCC_RUNTIME_GATE_WORKER_DATABASE_URL;
    assert.ok(workerUrl, "The separately provisioned limited worker fixture is required.");
    const address = new URL(workerUrl),
      app = new URL(url);
    assert.equal(address.host, app.host);
    assert.equal(address.pathname, app.pathname);
    const pool = await poolFor(t),
      worker = await poolFor(t, workerUrl),
      operator = await poolFor(t, process.env.OCC_MIGRATION_DATABASE_URL),
      f = await seedProfileGate(pool);
    await f.withdraw();
    const retained = await f.closure(),
      workId = retained.work.workId,
      installationId = f.owner.scope.installationId;
    const rights = (
      await worker.query(
        "SELECT rolsuper,rolcreaterole,rolbypassrls,pg_has_role(current_user,to_regrole('occ_lifecycle_worker_v1'),'USAGE') AS marker,pg_has_role(current_user,'occ_app','MEMBER') AS app_member FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.deepEqual(rights, {
      rolsuper: false,
      rolcreaterole: false,
      rolbypassrls: false,
      marker: true,
      app_member: false,
    });
    assert.equal(
      (
        await operator.query(
          "SELECT count(*)::int AS n FROM occ.lifecycle_capabilities WHERE installation_id=$1",
          [installationId],
        )
      ).rows[0].n,
      0,
    );
    await operator.query(
      "INSERT INTO occ.lifecycle_capabilities(installation_id,stage,capability_version,api_version,worker_version,maintenance_version,receiving_version,runtime_profile_version) VALUES($1,'live',1,1,1,1,1,1)",
      [installationId],
    );
    try {
      const queue = new PostgresWorkQueue(worker, { leaseDurationMs: 100 });
      const prioritize = () =>
        worker.query(
          "UPDATE occ.controller_work SET available_at='1970-01-01T00:00:00Z' WHERE idempotency_key=$1",
          [workId],
        );
      await prioritize();
      const first = await queue.claimRuntimeProfile();
      assert.deepEqual(first.work, retained.work);
      await f.state.transact((unit) =>
        unit.lifecycleAdmissions.applyProtective(protectiveWrite(f.owner, "disable", 1)),
      );
      await delay(120);
      const script =
        "import pg from 'pg';import {PostgresWorkQueue} from './packages/occ/src/state/postgres-work-queue.ts';const p=new pg.Pool({connectionString:process.env.OCC_RUNTIME_GATE_WORKER_DATABASE_URL});try{console.log(await new PostgresWorkQueue(p).recoverRuntimeProfile());}finally{await p.end();}";
      const fresh = await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", script],
        { cwd: new URL("../../", import.meta.url), env: process.env, timeout: 15000 },
      );
      assert.equal(Number(fresh.stdout.trim()), 1);
      assert.deepEqual(await f.closure(), retained);
      await prioritize();
      const events = [],
        state = new PostgresPlatformState(worker);
      const dispatcher = new RuntimeProfileWorker({
        queue: new PostgresWorkQueue(worker),
        findProfile: (scope, ref) =>
          state.read((view) => view.runtimeEffectAdmission.findProfileClosure(scope, ref)),
        emit: (event) => events.push(event),
      });
      assert.equal(await dispatcher.runOne(new AbortController().signal), true);
      assert.deepEqual(events, [
        { event: "worker.runtime-profile", code: "PROVIDER_FENCE_UNAVAILABLE" },
      ]);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT state,claim_token,completed_at,available_at>clock_timestamp() AS deferred FROM occ.controller_work WHERE idempotency_key=$1",
            [workId],
          )
        ).rows[0],
        { state: "queued", claim_token: null, completed_at: null, deferred: true },
      );
      await assert.rejects(
        worker.query(
          "UPDATE occ.controller_work SET state='succeeded',completed_at=clock_timestamp() WHERE idempotency_key=$1",
          [workId],
        ),
        { code: "23514" },
      );
      const withdraw = () =>
        operator.query(
          "UPDATE occ.lifecycle_capabilities SET stage='legacy',capability_version=capability_version+1,runtime_profile_version=NULL WHERE installation_id=$1",
          [installationId],
        );
      const restore = () =>
        operator.query(
          "UPDATE occ.lifecycle_capabilities SET stage='live',capability_version=capability_version+1,runtime_profile_version=1 WHERE installation_id=$1",
          [installationId],
        );
      await prioritize();
      await withdraw();
      assert.equal(await queue.claimRuntimeProfile(), undefined);
      assert.equal(
        (
          await pool.query("SELECT state FROM occ.controller_work WHERE idempotency_key=$1", [
            workId,
          ])
        ).rows[0].state,
        "queued",
      );
      await restore();
      const expiring = await queue.claimRuntimeProfile();
      assert.deepEqual(expiring.work, retained.work);
      await delay(120);
      await withdraw();
      assert.equal(await queue.recoverRuntimeProfile(), 0);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT state,claim_token,lease_expires_at<=clock_timestamp() AS expired,completed_at FROM occ.controller_work WHERE idempotency_key=$1",
            [workId],
          )
        ).rows[0],
        {
          state: "claimed",
          claim_token: expiring.claim.claimToken,
          expired: true,
          completed_at: null,
        },
      );
      await restore();
      assert.equal(await queue.recoverRuntimeProfile(), 1);
      assert.deepEqual(await f.closure(), retained);
    } finally {
      await operator.query("DELETE FROM occ.lifecycle_capabilities WHERE installation_id=$1", [
        installationId,
      ]);
    }
  },
);
