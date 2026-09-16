import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
};

async function waitFor(description, read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

async function setup(context, computeDriver) {
  const [
    { Pool },
    { createControllerWorker },
    { createDevelopmentComputeDriver },
    { createAuthPrincipalSeed, NativeIAMDriver },
    { DEVELOPMENT_HARNESS_DESCRIPTOR, PRODUCTION_HARNESS_DESCRIPTOR },
    { PostgresPlatformState },
    { PostgresWorkQueue },
    { createTestConfigurationDriver },
    { createHarnessConfiguration },
    { createInstallationDriverConfiguration },
    { createTestSecretDriver },
    { createDevelopmentIAMState },
    { admitLoggingConfiguration },
  ] = await Promise.all([
    import("pg"),
    import("../../apps/controller/src/worker.ts"),
    import("./development.mjs"),
    import("../../packages/iam/src/index.ts"),
    import("../../apps/controller/src/composition/production-harness.ts"),
    import("../../packages/occ/src/state/postgres-state.ts"),
    import("../../packages/occ/src/state/postgres-work-queue.ts"),
    import("./configuration-driver.mjs"),
    import("./harness-configuration.mjs"),
    import("./installation-driver-configuration.mjs"),
    import("./secret-driver.mjs"),
    import("./development-iam-state.mjs"),
    import("../../packages/contracts/src/index.ts"),
  ]);

  const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
  const state = new PostgresPlatformState(observerPool);
  let worker;

  async function stop() {
    const current = worker;
    worker = undefined;
    if (current !== undefined) await current.stop();
  }

  context.after(async () => {
    await stop();
    await observerPool.end();
  });

  let installation = await state.loadInstallation();
  if (installation === undefined) {
    installation = {
      id: `ins_${randomUUID()}`,
      name: "Before-commit Compute Driver integration",
      createdAt: new Date().toISOString(),
    };
    state.setBootstrapNativeIAM(
      createDevelopmentIAMState(
        createAuthPrincipalSeed(installation.id, "before-commit-worker-integration", {
          id: `account-before-commit-${randomUUID()}`,
        }),
      ),
    );
    await state.transact((unit) => unit.installations.createInstallation(installation));
  }

  const iam = await state.loadNativeIAMState();
  const deployRoles = new Set(
    iam.roles
      .filter(({ permissions }) =>
        permissions.some(
          ({ action, resourceKind }) => action === "deploy" && resourceKind === "agent",
        ),
      )
      .map(({ id }) => id),
  );
  const actor = iam.identities.find(
    ({ id, kind }) =>
      kind === "principal" &&
      iam.bindings.some(
        (binding) =>
          binding.subjectKind === "identity" &&
          binding.subjectId === id &&
          binding.namespaceId === undefined &&
          binding.resourceKind === undefined &&
          deployRoles.has(binding.roleId),
      ),
  );
  assert.ok(actor, "persisted IAM must contain an unrestricted Agent-deploy Principal");

  const namespace = {
    id: `ns_${randomUUID()}`,
    name: `before-commit-worker-${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  await state.transact((unit) => unit.namespaces.createNamespace(namespace));
  const compute = computeDriver ?? createDevelopmentComputeDriver();

  async function agent(executionMode = "dedicated") {
    const id = `agt_${randomUUID()}`;
    const configurationId = `cfg_${randomUUID()}`;
    const harnessId = executionMode === "dedicated" ? "codex" : "openclaw";
    return state.transact(async (unit) => {
      await unit.configurations.createConfiguration({
        id: configurationId,
        namespaceId: namespace.id,
        kind: "agent",
        generation: 1,
        values: createHarnessConfiguration(harnessId, "gpt-4.1"),
        createdAt: new Date().toISOString(),
      });
      return unit.agents.createAgent({
        id,
        namespaceId: namespace.id,
        name: `singleton-runtime-${randomUUID()}`,
        configurationId,
        providerId: null,
        executionMode,
        servicePrincipalId: `service-agent-${id}`,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async function revision(owner, number) {
    const harness =
      owner.executionMode === "dedicated"
        ? { ...PRODUCTION_HARNESS_DESCRIPTOR, mode: "dedicated" }
        : { ...DEVELOPMENT_HARNESS_DESCRIPTOR, mode: "embedded" };
    const candidate = {
      id: `rev_${randomUUID()}`,
      namespaceId: namespace.id,
      agentId: owner.id,
      revision: number,
      configuration: admitLoggingConfiguration(
        createHarnessConfiguration(harness.id, "gpt-4.1"),
        "info",
      ),
      configurationId: owner.configurationId,
      configurationKind: "agent",
      configurationGeneration: 1,
      providerId: null,
      harness,
      compute: { id: compute.id, implementation: compute.implementation },
      servicePrincipalId: owner.servicePrincipalId,
      createdAt: new Date().toISOString(),
    };
    const idempotencyKey = `agent_revision:${candidate.id}:reconcile`;
    await state.transactWithQueue(async (unit, queue) => {
      await unit.revisions.createRevision(candidate);
      await queue.enqueue({
        idempotencyKey,
        namespaceId: namespace.id,
        agentId: owner.id,
        revisionId: candidate.id,
        actorId: actor.id,
        availableAt: new Date(0),
      });
    });
    return { ...candidate, idempotencyKey };
  }

  async function activeRevision(owner) {
    const current = await observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [namespace.id, owner.id],
    );
    assert.equal(current.rowCount, 1);
    return current.rows[0].active_revision_id;
  }

  async function work(candidate, expected = "succeeded", timeoutMs = 10_000) {
    return waitFor(
      `revision ${candidate.id} to become ${expected}`,
      async () => {
        const current = await observerPool.query(
          `SELECT state, attempt_count, cutover_started_at,
                cutover_expected_active_revision_id
         FROM occ.controller_work WHERE idempotency_key = $1`,
          [candidate.idempotencyKey],
        );
        return current.rows[0]?.state === expected ? current.rows[0] : undefined;
      },
      timeoutMs,
    );
  }

  function createWorker(
    computeDriver,
    leaseDurationMs = 30_000,
    convergenceTimeoutMs = 900_000,
    mode = "production",
  ) {
    const configuration = createInstallationDriverConfiguration();
    const workerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    configuration.drivers.compute.id = computeDriver.id;
    return createControllerWorker({
      pool: workerPool,
      mode,
      drivers: {
        installation: configuration,
        computeDriver,
        configurationDriver: createTestConfigurationDriver({
          id: configuration.drivers.configuration.id,
        }),
        secretDriver: createTestSecretDriver({
          id: configuration.drivers.secret.id,
        }),
        createIAMDriver(platformState) {
          return new NativeIAMDriver(platformState, {
            id: configuration.drivers.iam.id,
            implementation: "native",
          });
        },
      },
      pollIntervalMs: 15,
      leaseDurationMs,
      convergenceTimeoutMs,
      maxAttempts: 5,
      emit() {},
    });
  }

  function start(
    computeDriver,
    leaseDurationMs = 30_000,
    convergenceTimeoutMs = 900_000,
    mode = "production",
  ) {
    assert.equal(worker, undefined, "the previous worker must be stopped before restart");
    worker = createWorker(computeDriver, leaseDurationMs, convergenceTimeoutMs, mode);
    return worker.start();
  }

  return {
    observerPool,
    namespace,
    actor,
    PostgresWorkQueue,
    compute,
    agent,
    revision,
    activeRevision,
    work,
    createWorker,
    start,
    stop,
  };
}

export { requiresPostgres, setup, waitFor };
