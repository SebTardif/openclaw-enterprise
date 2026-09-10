import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const requiresPostgres = {
  skip: process.env.OCC_TEST_DATABASE_URL
    ? false
    : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
  timeout: 30_000,
};

export async function waitFor(description, read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

export async function setup(context, { leaseDurationMs = 30_000 } = {}) {
  const [
    { Pool },
    { createControllerWorker },
    { PostgresPlatformState },
    { PostgresWorkQueue },
    { DEVELOPMENT_HARNESS_DESCRIPTOR },
    { ensureInstallation, authorizedPrincipal },
  ] = await Promise.all([
    import("pg"),
    import("../../../apps/controller/src/worker.ts"),
    import("../../../packages/occ/src/state/postgres-state.ts"),
    import("../../../packages/occ/src/state/postgres-work-queue.ts"),
    import("../../../apps/controller/src/composition/production-harness.ts"),
    import("../../helpers/postgres-provider-state.mjs"),
  ]);
  const observerPool = new Pool({ connectionString: process.env.OCC_TEST_DATABASE_URL, max: 4 });
  const applicationName = `worker-reconciliation-${randomUUID()}`;
  const workerPool = new Pool({
    connectionString: process.env.OCC_TEST_DATABASE_URL,
    application_name: applicationName,
    max: 1,
    connectionTimeoutMillis: 250,
  });
  const state = new PostgresPlatformState(observerPool);
  const events = [];
  const namespaceIds = [];
  const releases = [];
  let worker;
  let stopping;
  const stop = () => {
    stopping ??= worker === undefined ? workerPool.end() : worker.stop();
    return stopping;
  };
  context.after(async () => {
    for (const release of releases) await release();
    try {
      await stop();
      // Leave no queued work for the next file in the selected disposable database.
      await observerPool.query(
        `UPDATE occ.controller_work SET state = 'failed_permanent',
         completed_at = clock_timestamp(), claim_token = NULL, lease_expires_at = NULL
         WHERE namespace_id = ANY($1::text[]) AND state IN ('queued', 'claimed')`,
        [namespaceIds],
      );
    } finally {
      await observerPool.end();
    }
  });
  const installation = await ensureInstallation(state, "worker-reconciliation");
  const actor = authorizedPrincipal(await state.loadNativeIAMState(), [
    ["deploy", "agent"],
    ["create", "namespace"],
  ]);
  assert.ok(actor, "the selected database must have an unrestricted worker test Principal");

  async function namespace(status = "provisioning") {
    const candidate = {
      id: `ns_${randomUUID()}`,
      name: `worker-reconciliation-${randomUUID()}`,
      status,
      createdAt: new Date().toISOString(),
    };
    await state.transact((unit) => unit.namespaces.createNamespace(candidate));
    namespaceIds.push(candidate.id);
    return candidate;
  }
  async function namespaceWork(candidate, target = "ready") {
    const idempotencyKey = `namespace:${candidate.id}:reconcile:${target}`;
    await state.transactWithQueue((_unit, queue) =>
      queue.enqueue({
        idempotencyKey,
        namespaceId: candidate.id,
        namespaceTarget: target,
        actorId: actor.id,
        availableAt: new Date(0),
      }),
    );
    return { ...candidate, idempotencyKey };
  }
  async function agent(owner) {
    return state.transact(async (unit) => {
      const configuration = await unit.configurations.createConfiguration({
        id: `cfg_${randomUUID()}`,
        namespaceId: owner.id,
        kind: "agent",
        generation: 1,
        createdAt: new Date().toISOString(),
      });
      const id = `agt_${randomUUID()}`;
      return unit.agents.createAgent({
        id,
        namespaceId: owner.id,
        name: `worker-agent-${randomUUID()}`,
        configurationId: configuration.id,
        providerId: null,
        executionMode: "embedded",
        maximumExecutionMs: null,
        servicePrincipalId: `service-agent-${id}`,
        createdAt: new Date().toISOString(),
      });
    });
  }
  async function revision(owner, number, compute, { enqueue = true } = {}) {
    const candidate = {
      id: `rev_${randomUUID()}`,
      namespaceId: owner.namespaceId,
      agentId: owner.id,
      revision: number,
      maximumExecutionMs: null,
      providerId: null,
      configuration: { revision: String(number) },
      configurationId: owner.configurationId,
      configurationKind: "agent",
      configurationGeneration: 1,
      harness: { ...DEVELOPMENT_HARNESS_DESCRIPTOR, mode: "embedded" },
      compute: { id: compute.id, implementation: compute.implementation },
      servicePrincipalId: owner.servicePrincipalId,
      createdAt: new Date().toISOString(),
    };
    const idempotencyKey = `agent_revision:${candidate.id}:reconcile`;
    await state.transactWithQueue(async (unit, queue) => {
      await unit.revisions.createRevision(candidate);
      if (enqueue)
        await queue.enqueue({
          idempotencyKey,
          namespaceId: owner.namespaceId,
          agentId: owner.id,
          revisionId: candidate.id,
          actorId: actor.id,
          availableAt: new Date(0),
        });
    });
    return { ...candidate, idempotencyKey };
  }
  async function work(candidate, expected) {
    return waitFor(`work ${candidate.idempotencyKey} to become ${expected}`, async () => {
      const result = await observerPool.query(
        "SELECT * FROM occ.controller_work WHERE idempotency_key = $1",
        [candidate.idempotencyKey],
      );
      return result.rows[0]?.state === expected ? result.rows[0] : undefined;
    });
  }
  async function audits(candidate) {
    const result = await observerPool.query(
      "SELECT actor_id, namespace_id, resource_id, action, outcome, details FROM occ.audit_events WHERE resource_id = $1 ORDER BY occurred_at, id",
      [candidate.id],
    );
    return result.rows;
  }
  async function start(computeDriver, pool = workerPool) {
    worker = createControllerWorker({
      pool,
      computeDriver,
      pollIntervalMs: 20,
      leaseDurationMs,
      maxAttempts: 5,
      emit: (event) => events.push(event),
    });
    await worker.start();
  }
  return {
    observerPool,
    workerPool,
    applicationName,
    state,
    installation,
    actor,
    events,
    releases,
    namespace,
    namespaceWork,
    agent,
    revision,
    work,
    audits,
    start,
    stop,
    recoveryQueue: new PostgresWorkQueue(observerPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      random: () => 0,
    }),
  };
}

// Inject one real PostgreSQL error into the worker's own transaction immediately
// before the scoped lifecycle audit. All application SQL and results remain real.
export function poolWithAuditFailure(pool, resourceId) {
  const failures = [];
  let armed = true;
  return {
    failures,
    pool: {
      query: (text, values) => pool.query(text, values),
      end: () => pool.end(),
      async connect() {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          async query(text, values) {
            if (
              armed &&
              /^\s*INSERT INTO occ\.audit_events\s/i.test(text) &&
              values?.[7] === resourceId
            ) {
              armed = false;
              try {
                await client.query("SELECT 1 / 0");
              } catch (error) {
                failures.push(error.code);
                throw error;
              }
            }
            return client.query(text, values);
          },
        };
      },
    },
  };
}
