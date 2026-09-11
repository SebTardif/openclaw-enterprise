import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createControllerApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  PostgresWorkQueue,
  WorkClaimLostError,
} from "../../packages/occ/src/state/postgres-work-queue.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createDevelopmentIAMState } from "../helpers/development-iam-state.mjs";
import { cleanupNamespaces, databaseUrl, waitFor } from "../helpers/postgres-provider-state.mjs";

const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
};

const pluginId = "codex-plugin:google-calendar@openai-curated-remote";
const pluginIdentity = Object.freeze({ driverId: "occ-plugin", pluginId });

async function setup(context, options = {}) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const namespaceIds = new Set();
  context.after(async () => {
    try {
      await cleanupNamespaces(pool, [...namespaceIds]);
    } finally {
      await pool.end();
    }
  });
  const state = new PostgresPlatformState(pool);
  let installation = await state.loadInstallation();
  const installationId = installation?.id ?? `ins_${randomUUID()}`;
  const authFixture = await createTestAuthPrincipal({ installationId });
  const iamState = createDevelopmentIAMState(authFixture.seed);
  if (installation === undefined) {
    installation = {
      id: installationId,
      name: "Deployment status API integration",
      createdAt: new Date().toISOString(),
    };
    state.setBootstrapNativeIAM(iamState);
    await state.transact((unit) => unit.installations.createInstallation(installation));
  } else {
    await state.seedNativeIAM(iamState);
  }

  const iamDriver = new NativeIAMDriver(state, { id: `iam-status-${randomUUID()}` });
  const computeDriver = createDevelopmentComputeDriver();
  const configurationDriver = createTestConfigurationDriver({
    id: `configuration-status-${randomUUID()}`,
  });
  const controller = new OpenClawController(installation, { state });
  for (const driver of [iamDriver, computeDriver, configurationDriver]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  if (options.plugins === true) {
    const pluginDriver = new OCCPluginDriver();
    controller.registerDriver(pluginDriver);
    controller.selectDriver("plugin", pluginDriver.id);
  }
  const app = createControllerApp({
    controller,
    iamDriver,
    computeDriver,
    configurationDriver,
    resolveHarness: resolveApprovedDevelopmentHarness,
    auditSink: new InMemoryAuditSink(),
    development: { enabled: true, installationId: installation.id },
    auth: authFixture.auth,
  });
  const session = await signInToControllerApp(app, {
    email: authFixture.email,
    password: authFixture.password,
  });
  return {
    app,
    controller,
    pool,
    queue: new PostgresWorkQueue(pool, { random: () => 0 }),
    session,
    principalId: authFixture.seed.principal.id,
    trackNamespace(namespaceId) {
      namespaceIds.add(namespaceId);
    },
  };
}

async function request(app, session, method, path, body) {
  const response = await app.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: {
        ...authenticatedHeaders(session),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const payload = await response.json();
  assert.match(payload.meta?.requestId ?? "", /^req_/);
  return { status: response.status, body: payload, data: payload.data };
}

async function claimExact(pool, idempotencyKey) {
  const claimToken = randomUUID();
  const claimed = await pool.query(
    `UPDATE occ.controller_work
     SET state = 'claimed',
         attempt_count = attempt_count + 1,
         claim_token = $2::uuid,
         lease_expires_at = clock_timestamp() + interval '1 minute',
         updated_at = clock_timestamp()
     WHERE idempotency_key = $1
       AND state = 'queued'
     RETURNING idempotency_key, claim_token`,
    [idempotencyKey, claimToken],
  );
  assert.equal(
    claimed.rowCount,
    1,
    `Expected exactly one queued deployment work row for ${idempotencyKey}.`,
  );
  return { idempotencyKey, claimToken };
}

async function claimThroughQueue(queue, idempotencyKey) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const claim = await queue.claim();
    assert.ok(claim, `Expected queued deployment work ${idempotencyKey}.`);
    if (claim.idempotencyKey === idempotencyKey) return claim;
    await queue.complete(claim);
  }
  assert.fail(`Expected deployment work ${idempotencyKey} within 200 claims.`);
}

async function createReadyAgent(fixture, label, agentBody = {}) {
  const namespace = await request(fixture.app, fixture.session, "POST", "/namespaces", {
    name: `${label}-${randomUUID()}`,
  });
  assert.equal(namespace.status, 201, JSON.stringify(namespace.body));
  fixture.trackNamespace(namespace.data.id);
  await fixture.controller.handleNamespaceLifecycle(
    fixture.principalId,
    namespace.data.id,
    "ready",
  );
  const configuration = await request(
    fixture.app,
    fixture.session,
    "POST",
    `/namespaces/${namespace.data.id}/configurations`,
    { kind: "agent", values: { model: label } },
  );
  assert.equal(configuration.status, 201, JSON.stringify(configuration.body));
  const agent = await request(
    fixture.app,
    fixture.session,
    "POST",
    `/namespaces/${namespace.data.id}/agents`,
    {
      name: `${label}-agent-${randomUUID()}`,
      configurationId: configuration.data.id,
      ...agentBody,
    },
  );
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  return { namespace: namespace.data, configuration: configuration.data, agent: agent.data };
}

async function deploy(app, session, namespaceId, agentId) {
  const response = await request(
    app,
    session,
    "POST",
    `/namespaces/${namespaceId}/agents/${agentId}/deploy`,
  );
  assert.equal(response.status, 202, JSON.stringify(response.body));
  assert.equal(response.data.deploymentId, response.data.revision.id);
  return response.data;
}

async function status(app, session, namespaceId, agentId, deploymentId) {
  const response = await request(
    app,
    session,
    "GET",
    `/namespaces/${namespaceId}/agents/${agentId}/deployments/${deploymentId}`,
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.data;
}

test(
  "PostgreSQL Fastify deployment status polls the original reconcile work row",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const { namespace, agent } = await createReadyAgent(fixture, "status-api");
    const otherAgent = await request(
      fixture.app,
      fixture.session,
      "POST",
      `/namespaces/${namespace.id}/agents`,
      { name: `status-other-${randomUUID()}`, configurationId: agent.configurationId },
    );
    assert.equal(otherAgent.status, 201, JSON.stringify(otherAgent.body));

    const first = await deploy(fixture.app, fixture.session, namespace.id, agent.id);
    const firstKey = `agent_revision:${first.deploymentId}:reconcile`;
    assert.equal(
      (await status(fixture.app, fixture.session, namespace.id, agent.id, first.deploymentId))
        .status,
      "queued",
    );
    const firstClaim = await claimExact(fixture.pool, firstKey);
    assert.equal(
      (await status(fixture.app, fixture.session, namespace.id, agent.id, first.deploymentId))
        .status,
      "running",
    );
    await fixture.queue.retry(firstClaim, { code: "transient_dependency" });
    assert.equal(
      (await status(fixture.app, fixture.session, namespace.id, agent.id, first.deploymentId))
        .status,
      "queued",
    );
    await fixture.pool.query(
      `UPDATE occ.controller_work
       SET available_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = $1`,
      [firstKey],
    );
    await fixture.queue.complete(await claimExact(fixture.pool, firstKey));
    assert.deepEqual(
      await status(fixture.app, fixture.session, namespace.id, agent.id, first.deploymentId),
      {
        deploymentId: first.deploymentId,
        namespaceId: namespace.id,
        agentId: agent.id,
        status: "succeeded",
        pluginErrors: [],
        error: null,
      },
    );

    const failed = await deploy(fixture.app, fixture.session, namespace.id, agent.id);
    const failedKey = `agent_revision:${failed.deploymentId}:reconcile`;
    await fixture.queue.fail(await claimExact(fixture.pool, failedKey), {
      code: "provider_broken",
    });
    assert.deepEqual(
      await status(fixture.app, fixture.session, namespace.id, agent.id, failed.deploymentId),
      {
        deploymentId: failed.deploymentId,
        namespaceId: namespace.id,
        agentId: agent.id,
        status: "failed",
        pluginErrors: [],
        error: { code: "PROVIDER_BROKEN", message: "Deployment failed." },
      },
    );

    const wrongTuple = await request(
      fixture.app,
      fixture.session,
      "GET",
      `/namespaces/${namespace.id}/agents/${otherAgent.data.id}/deployments/${failed.deploymentId}`,
    );
    assert.equal(wrongTuple.status, 404);

    const lost = await deploy(fixture.app, fixture.session, namespace.id, agent.id);
    const lostKey = `agent_revision:${lost.deploymentId}:reconcile`;
    const lostClaim = await claimExact(fixture.pool, lostKey);
    await fixture.pool.query(
      `UPDATE occ.controller_work
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = $1 AND claim_token = $2::uuid`,
      [lostKey, lostClaim.claimToken],
    );
    await assert.rejects(fixture.queue.complete(lostClaim), WorkClaimLostError);
    assert.equal(
      (await status(fixture.app, fixture.session, namespace.id, agent.id, lost.deploymentId))
        .status,
      "queued",
    );

    await waitFor("the lost deployment row to remain owned by its original revision", async () => {
      const row = await fixture.pool.query(
        `SELECT agent_id, revision_id FROM occ.controller_work WHERE idempotency_key = $1`,
        [lostKey],
      );
      return row.rows[0]?.revision_id === lost.deploymentId ? row.rows[0] : undefined;
    });
  },
);

test(
  "PostgreSQL Fastify deployment status serializes persisted plugin install failures",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { plugins: true });
    const { namespace, agent } = await createReadyAgent(fixture, "status-api-plugin", {
      plugins: { [pluginId]: { enabled: true, approvalMode: "always" } },
    });

    const deployment = await deploy(fixture.app, fixture.session, namespace.id, agent.id);
    assert.deepEqual(deployment.revision.plugins, {
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      plugins: { [pluginId]: { enabled: true, approvalMode: "always" } },
    });
    const claim = await claimThroughQueue(
      fixture.queue,
      `agent_revision:${deployment.deploymentId}:reconcile`,
    );
    const pluginErrors = await fixture.queue.reportPluginInstallFailure(claim, pluginIdentity, [
      pluginIdentity,
    ]);
    assert.deepEqual(pluginErrors, [
      {
        ...pluginIdentity,
        code: "PLUGIN_INSTALL_FAILED",
        message: "Plugin installation failed.",
      },
    ]);
    await fixture.queue.fail(claim, { code: "PLUGIN_INSTALL_FAILED" });

    assert.deepEqual(
      await status(fixture.app, fixture.session, namespace.id, agent.id, deployment.deploymentId),
      {
        deploymentId: deployment.deploymentId,
        namespaceId: namespace.id,
        agentId: agent.id,
        status: "failed",
        pluginErrors,
        error: { code: "PLUGIN_INSTALL_FAILED", message: "Plugin installation failed." },
      },
    );
  },
);
