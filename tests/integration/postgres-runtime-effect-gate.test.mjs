import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeFaultWorker } from "../../apps/controller/src/worker/runtime-fault.ts";
import pg from "pg";
import { canonicalRuntimeFaultRequestV1 } from "@openclaw-enterprise/contracts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/ports/transaction-errors.ts";
import { PostgresWorkQueue } from "../../packages/occ/src/state/postgres-work-queue.ts";
import { runtimePreparationDigest } from "../../packages/occ/src/runtime-preparation/types.ts";
import { seedPreparation } from "../fixtures/runtime-preparation.mjs";
import { fault as faultShape } from "../fixtures/runtime-effects-v1/vectors.mjs";
import {
  protectiveWrite,
  verifyProtectiveAdmissionStore,
} from "../fixtures/lifecycle-protective-admission/shared-cases.mjs";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";

const url = process.env.OCC_RUNTIME_GATE_DATABASE_URL;
const selected = url === undefined ? undefined : new URL(url);
if (selected) {
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(selected.hostname));
  assert.match(selected.pathname, /^\/openclaw_runtime_gate_[a-z0-9_]+$/);
}
const skip =
  url === undefined
    ? "Select a dedicated migrated loopback runtime-gate database with the limited application role."
    : false;

async function fixture(t) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 6,
    connectionTimeoutMillis: 1000,
    query_timeout: 10000,
  });
  t.after(() => pool.end());
  pool.on("error", () => {});
  const identity = (
    await pool.query(
      "SELECT current_user,rolsuper,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  assert.deepEqual(identity, {
    current_user: "occ_app",
    rolsuper: false,
    rolcreaterole: false,
    rolbypassrls: false,
  });
  const state = new PostgresPlatformState(pool);
  const owner = await seedPreparation(state);
  await owner.append(owner.plan);
  const initialized = await state.transact((unit) =>
    unit.runtimeEffectAdmission.retainClosedGate(owner.scope, owner.plan.operationRef),
  );
  assert.equal(initialized.kind, "provisional");
  const readGate = () => state.read((view) => view.runtimeEffectAdmission.findGate(owner.scope));
  return { pool, state, owner, gate: initialized.gate, readGate };
}

// Representation inputs exercise the trusted internal repository, not a live
// authenticated fault producer or public RuntimeEffectAdmissionV1 acceptance.
function storageFault(owner, gate) {
  const fault = faultShape();
  fault.operation = { ...fault.operation, scope: owner.scope, operationRef: randomUUID() };
  fault.target = owner.target;
  fault.guard = gate.guard;
  fault.cleanupResponsibility = {
    responsibilityRef: randomUUID(),
    responsibilityVersion: 1,
    kind: "protective-fence",
  };
  fault.operation.requestDigest = runtimePreparationDigest(canonicalRuntimeFaultRequestV1(fault));
  const audit = {
    id: `aud_${randomUUID()}`,
    installationId: owner.scope.installationId,
    namespaceId: owner.scope.namespaceId,
    occurredAt: new Date().toISOString(),
    kind: "mutation",
    actorId: "test/runtime-fault-storage-writer",
    action: "runtime.fault.request",
    resource: { kind: "agent", id: owner.scope.agentId, namespaceId: owner.scope.namespaceId },
    outcome: "success",
  };
  return { fault, workId: `runtime-fault:${randomUUID()}`, audit };
}
const retain = (state, input) =>
  state.transact((unit) => unit.runtimeEffectAdmission.retainFaultRequest(input));

async function readFaultFresh(operation) {
  const script = `
    import pg from 'pg';
    import { PostgresPlatformState } from './packages/occ/src/state/postgres-state.ts';
    const pool=new pg.Pool({connectionString:process.env.OCC_RUNTIME_GATE_DATABASE_URL});
    try {
      const state=new PostgresPlatformState(pool);
      const result=await state.read(view=>view.runtimeEffectAdmission.findFaultRequest(JSON.parse(process.env.OCC_RUNTIME_GATE_RECOVERY_INPUT)));
      process.stdout.write(JSON.stringify(result));
    } finally {await pool.end();}
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: new URL("../../", import.meta.url),
      timeout: 20000,
      maxBuffer: 1048576,
      env: { ...process.env, OCC_RUNTIME_GATE_RECOVERY_INPUT: JSON.stringify(operation) },
    },
  );
  return JSON.parse(stdout);
}

test(
  "PostgreSQL canonical gate starts closed and never admits retained children",
  { skip, timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    await f.owner.append(f.owner.child);
    const gate = await f.readGate();
    assert.equal(gate.ordinaryAdmission, "closed");
    assert.equal(gate.sealerAdmission, "closed");
    assert.equal(gate.guard.admittedChildCutoff, 0);
    assert.equal((await f.owner.record()).retainedChildSequence, 1);
    await assert.rejects(
      f.pool.query(
        "UPDATE occ.runtime_effect_gates SET ordinary_admission='open' WHERE agent_id=$1",
        [f.owner.scope.agentId],
      ),
    );
    await assert.rejects(
      f.pool.query(
        "UPDATE occ.runtime_effect_gates SET gate_guard=jsonb_set(gate_guard,'{admittedChildCutoff}','1') WHERE agent_id=$1",
        [f.owner.scope.agentId],
      ),
    );
    assert.deepEqual(await f.readGate(), gate);
  },
);

test(
  "PostgreSQL same-generation fault retains original cleanup, work and immutable readback",
  { skip, timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const input = storageFault(f.owner, f.gate);
    const originalHead = await f.owner.head();
    const result = await retain(f.state, input);
    assert.equal(result.kind, "provisional");
    assert.deepEqual(await f.owner.head(), originalHead);
    assert.equal(result.retained.closedGuard.gateVersion, f.gate.guard.gateVersion + 1);
    assert.equal(
      result.retained.closedGuard.requestedFenceEpoch,
      f.gate.guard.requestedFenceEpoch + 1,
    );
    assert.equal(result.retained.closedGuard.admittedChildCutoff, 0);
    assert.deepEqual((await retain(f.state, input)).retained, result.retained);
    const work = (
      await f.pool.query(
        "SELECT work_schema_version,handler,fault_work,state,lifecycle_operation_ref,runtime_transition_ref FROM occ.controller_work WHERE idempotency_key=$1",
        [input.workId],
      )
    ).rows[0];
    assert.equal(work.work_schema_version, 2);
    assert.equal(work.handler, "ReconcileRuntimeFaultV1");
    assert.equal(work.lifecycle_operation_ref, null);
    assert.equal(work.runtime_transition_ref, originalHead.transitionRef);
    assert.equal(work.state, "queued");
    assert.deepEqual(work.fault_work, result.retained.work);
    const modified = structuredClone(input);
    modified.fault.cause.currentVersion++;
    modified.fault.operation.requestDigest = runtimePreparationDigest(
      canonicalRuntimeFaultRequestV1(modified.fault),
    );
    await assert.rejects(retain(f.state, modified));
    await assert.rejects(
      f.pool.query(
        "UPDATE occ.runtime_cleanup_responsibilities SET fault_writer_ref='other' WHERE origin_operation_ref=$1",
        [input.fault.operation.operationRef],
      ),
    );
    // No operator-installed fault capability exists in this storage-only database.
    const queue = new PostgresWorkQueue(f.pool);
    assert.equal(await queue.claimRuntimeFault(), undefined);
    assert.equal(await queue.recoverRuntimeFault(), 0);
    assert.equal(
      (
        await f.pool.query("SELECT state FROM occ.controller_work WHERE idempotency_key=$1", [
          input.workId,
        ])
      ).rows[0].state,
      "queued",
    );
    await f.state.transact((unit) =>
      unit.lifecycleAdmissions.applyProtective(protectiveWrite(f.owner, "disable", 1)),
    );
    const recovered = await readFaultFresh(input.fault.operation);
    assert.deepEqual(recovered, result.retained);
    assert.equal((await f.readGate()).guard.mode, "disabled");
  },
);

test(
  "PostgreSQL fault rollback and stale guard cannot advance intent or leave partial work",
  { skip, timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const input = storageFault(f.owner, f.gate);
    await assert.rejects(
      f.state.transact(async (unit) => {
        await unit.runtimeEffectAdmission.retainFaultRequest(input);
        throw new Error("abort storage unit");
      }),
      /abort storage unit/,
    );
    assert.deepEqual(await f.readGate(), f.gate);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM occ.controller_work WHERE idempotency_key=$1",
          [input.workId],
        )
      ).rows[0].n,
      0,
    );
    await f.state.transact((unit) =>
      unit.lifecycleAdmissions.applyProtective(protectiveWrite(f.owner, "stop", 1)),
    );
    const closed = await f.readGate();
    assert.equal(closed.guard.mode, "stopped");
    await assert.rejects(retain(f.state, input));
    assert.deepEqual(await f.readGate(), closed);
  },
);

test(
  "PostgreSQL concurrent fault requests compare the same full canonical gate",
  { skip, timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const first = storageFault(f.owner, f.gate);
    const second = storageFault(f.owner, f.gate);
    const results = await Promise.allSettled([retain(f.state, first), retain(f.state, second)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await f.readGate()).guard.gateVersion, f.gate.guard.gateVersion + 1);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM occ.runtime_cleanup_responsibilities WHERE origin_operation_ref=ANY($1::text[])",
          [[first.fault.operation.operationRef, second.fault.operation.operationRef]],
        )
      ).rows[0].n,
      1,
    );
  },
);

test(
  "PostgreSQL lost fault COMMIT acknowledgement resolves by original readback without resubmission",
  { skip, timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    const input = storageFault(f.owner, f.gate);
    const proxy = await runtimeCommitAckProxy(url);
    const pool = new pg.Pool({
      connectionString: proxy.url,
      max: 1,
      connectionTimeoutMillis: 1000,
      query_timeout: 10000,
    });
    pool.on("error", () => {});
    let provisional;
    try {
      const uncertain = new PostgresPlatformState(pool);
      await uncertain.read((view) => view.installations.getInstallation());
      proxy.arm();
      await assert.rejects(
        uncertain.transact(async (unit) => {
          provisional = await unit.runtimeEffectAdmission.retainFaultRequest(input);
          return provisional;
        }),
        PostgresCommitOutcomeUnknownError,
      );
      assert.equal(proxy.observedCommit, true);
    } finally {
      await pool.end();
      await proxy.close();
    }
    const recovered = await new PostgresPlatformState(f.pool).read((view) =>
      view.runtimeEffectAdmission.findFaultRequest(input.fault.operation),
    );
    assert.deepEqual(recovered, provisional.retained);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM occ.runtime_cleanup_responsibilities WHERE origin_operation_ref=$1",
          [input.fault.operation.operationRef],
        )
      ).rows[0].n,
      1,
    );
  },
);

test(
  "PostgreSQL direct gate writes reject retained isolation snapshots",
  { skip, timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const client = await f.pool.connect();
    try {
      for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"]) {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        try {
          await client.query("SELECT gate_guard FROM occ.runtime_effect_gates WHERE agent_id=$1", [
            f.owner.scope.agentId,
          ]);
          await assert.rejects(
            client.query(
              "UPDATE occ.runtime_effect_gates SET gate_guard=gate_guard WHERE agent_id=$1",
              [f.owner.scope.agentId],
            ),
            (error) => error.code === "23514" && /READ COMMITTED/.test(error.message),
          );
        } finally {
          await client.query("ROLLBACK");
        }
      }
    } finally {
      client.release();
    }
    assert.deepEqual(await f.readGate(), f.gate);
  },
);

test(
  "PostgreSQL original disable and same-generation fault serialize on the same gate",
  { skip, timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const input = storageFault(f.owner, f.gate);
    const disable = protectiveWrite(f.owner, "disable", 1);
    const [faultResult, disableResult] = await Promise.allSettled([
      retain(f.state, input),
      f.state.transact((unit) => unit.lifecycleAdmissions.applyProtective(disable)),
    ]);
    assert.equal(disableResult.status, "fulfilled");
    const gate = await f.readGate();
    assert.equal(gate.guard.intentRef, disable.transitionRef);
    assert.equal(gate.guard.mode, "disabled");
    assert.equal(gate.lastClosureOperationRef, disable.transitionRef);
    const retained = await f.state.read((view) =>
      view.runtimeEffectAdmission.findFaultRequest(input.fault.operation),
    );
    if (faultResult.status === "fulfilled") assert.deepEqual(retained, faultResult.value.retained);
    else assert.equal(retained, undefined);
    assert.equal(gate.guard.gateVersion, f.gate.guard.gateVersion + (retained ? 2 : 1));
    assert.equal(gate.guard.admittedChildCutoff, 0);
  },
);

test(
  "PostgreSQL original fault worker claims, defers and recovers its durable responsibility",
  {
    skip:
      skip ||
      (!process.env.OCC_RUNTIME_GATE_WORKER_DATABASE_URL &&
        "Select the separately provisioned limited runtime-gate worker fixture."),
    timeout: 60000,
  },
  async (t) => {
    const f = await fixture(t);
    const workerURL = new URL(process.env.OCC_RUNTIME_GATE_WORKER_DATABASE_URL);
    assert.equal(workerURL.host, selected.host);
    assert.equal(workerURL.pathname, selected.pathname);
    const worker = new pg.Pool({ connectionString: workerURL.href, max: 3 });
    const operator = new pg.Pool({
      connectionString: process.env.OCC_MIGRATION_DATABASE_URL,
      max: 1,
    });
    t.after(async () => {
      await worker.end();
      await operator.end();
    });
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
    const input = storageFault(f.owner, f.gate);
    const result = await retain(f.state, input);
    const installationId = f.owner.scope.installationId;
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
      `INSERT INTO occ.lifecycle_capabilities(installation_id,stage,capability_version,api_version,worker_version,maintenance_version,receiving_version,runtime_fault_version) VALUES($1,'live',1,1,1,1,1,1)`,
      [installationId],
    );
    try {
      const prioritize = () =>
        worker.query(
          "UPDATE occ.controller_work SET available_at='1970-01-01T00:00:00Z' WHERE idempotency_key=$1",
          [input.workId],
        );
      const queue = new PostgresWorkQueue(worker, { leaseDurationMs: 100 });
      await prioritize();
      const claimed = await queue.claimRuntimeFault();
      assert.deepEqual(claimed.work, result.retained.work);
      await f.state.transact((unit) =>
        unit.lifecycleAdmissions.applyProtective(protectiveWrite(f.owner, "disable", 1)),
      );
      await delay(120);
      const script = `import pg from 'pg';import { PostgresWorkQueue } from './packages/occ/src/state/postgres-work-queue.ts';const pool=new pg.Pool({connectionString:process.env.OCC_RUNTIME_GATE_WORKER_DATABASE_URL});try{process.stdout.write(JSON.stringify(await new PostgresWorkQueue(pool).recoverRuntimeFault()));}finally{await pool.end();}`;
      const recovery = await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", script],
        { cwd: new URL("../../", import.meta.url), timeout: 20000, env: process.env },
      );
      assert.equal(JSON.parse(recovery.stdout), 1);
      const pending = (
        await f.pool.query(
          "SELECT state,completed_at FROM occ.controller_work WHERE idempotency_key=$1",
          [input.workId],
        )
      ).rows[0];
      assert.deepEqual(pending, { state: "queued", completed_at: null });
      await prioritize();
      const events = [];
      const state = new PostgresPlatformState(worker);
      const runtimeWorker = new RuntimeFaultWorker({
        queue: new PostgresWorkQueue(worker),
        findFault: (operation) =>
          state.read((view) => view.runtimeEffectAdmission.findFaultRequest(operation)),
        emit: (event) => events.push(event),
      });
      assert.equal(await runtimeWorker.runOne(new AbortController().signal), true);
      assert.deepEqual(events, [
        { event: "worker.runtime-fault", code: "PROVIDER_FENCE_UNAVAILABLE" },
      ]);
      const deferred = (
        await f.pool.query(
          "SELECT state,completed_at,claim_token,available_at>clock_timestamp() AS deferred FROM occ.controller_work WHERE idempotency_key=$1",
          [input.workId],
        )
      ).rows[0];
      assert.deepEqual(deferred, {
        state: "queued",
        completed_at: null,
        claim_token: null,
        deferred: true,
      });
      assert.deepEqual(await readFaultFresh(input.fault.operation), result.retained);
      await assert.rejects(
        worker.query(
          "UPDATE occ.controller_work SET state='succeeded',completed_at=clock_timestamp() WHERE idempotency_key=$1",
          [input.workId],
        ),
        { code: "23514" },
      );
      const withdraw = () =>
        operator.query(
          "UPDATE occ.lifecycle_capabilities SET stage='legacy',capability_version=capability_version+1,runtime_fault_version=NULL WHERE installation_id=$1",
          [installationId],
        );
      // Make real work eligible before withdrawal so deferral cannot explain refusal.
      await prioritize();
      await withdraw();
      assert.equal(await queue.claimRuntimeFault(), undefined);
      assert.equal(
        (
          await f.pool.query("SELECT state FROM occ.controller_work WHERE idempotency_key=$1", [
            input.workId,
          ])
        ).rows[0].state,
        "queued",
      );
      await operator.query(
        "UPDATE occ.lifecycle_capabilities SET stage='live',capability_version=capability_version+1,runtime_fault_version=1 WHERE installation_id=$1",
        [installationId],
      );
      const beforeWithdrawal = await queue.claimRuntimeFault();
      assert.deepEqual(beforeWithdrawal.work, result.retained.work);
      await delay(120);
      await withdraw();
      assert.equal(await queue.recoverRuntimeFault(), 0);
      const stillClaimed = (
        await f.pool.query(
          "SELECT state,claim_token,lease_expires_at<=clock_timestamp() AS expired,completed_at FROM occ.controller_work WHERE idempotency_key=$1",
          [input.workId],
        )
      ).rows[0];
      assert.deepEqual(stillClaimed, {
        state: "claimed",
        claim_token: beforeWithdrawal.claim.claimToken,
        expired: true,
        completed_at: null,
      });
      await operator.query(
        "UPDATE occ.lifecycle_capabilities SET stage='live',capability_version=capability_version+1,runtime_fault_version=1 WHERE installation_id=$1",
        [installationId],
      );
      assert.equal(await queue.recoverRuntimeFault(), 1);
    } finally {
      await operator.query("DELETE FROM occ.lifecycle_capabilities WHERE installation_id=$1", [
        installationId,
      ]);
    }
  },
);

test(
  "PostgreSQL original protective admission contract remains intact beside the canonical gate",
  { skip, timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    await verifyProtectiveAdmissionStore(t, f.state);
  },
);
