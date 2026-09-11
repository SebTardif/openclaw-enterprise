import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { AgentService } from "../../packages/occ/src/services/agent/service.ts";
import { DeploymentService } from "../../packages/occ/src/services/deployment/service.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

async function fixture(t) {
  const auth = await createTestAuthPrincipal({ name: "Agent service HTTP Administrator" });
  const principal = auth.seed.principal;
  const role = {
    id: "agent-service-http-role",
    permissions: auth.seed.roles[0].permissions.map((permission) => ({ ...permission })),
  };
  const policy = {
    identities: [principal],
    groups: [],
    memberships: [],
    roles: [role],
    bindings: [
      {
        id: "agent-service-http-binding",
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: role.id,
      },
    ],
    restrictions: [],
  };
  const iamDriver = new NativeIAMDriver({ loadNativeIAMState: async () => policy });
  const auditSink = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink });
  let controller;
  // Injection uses the production Fastify registration, Better Auth admission, Native IAM,
  // and OCC mutation runner. Existing passive adapters provide no external workload proof.
  const app = createFastifyApp({
    createController(installation) {
      controller = new OpenClawController(installation, { state, recordOperations: false });
      return controller;
    },
    iamDriver,
    auditSink,
    configurationDriver: createTestConfigurationDriver(),
    computeDriver: createDevelopmentComputeDriver(),
    secretDriver: createTestSecretDriver(),
    resolveHarness: resolveApprovedHarness,
    development: { enabled: true, installationId: auth.installationId },
    publicOrigin: "http://127.0.0.1",
    auth: auth.auth,
  });
  t.after(() => app.close());
  const session = await signInToControllerApp(app, auth);

  async function request(method, url, { body, authenticated = true } = {}) {
    const response = await app.inject({
      method,
      url,
      remoteAddress: "127.0.0.1",
      headers: {
        host: "127.0.0.1",
        ...(authenticated ? authenticatedHeaders(session) : {}),
      },
      ...(body === undefined ? {} : { payload: body }),
    });
    const payload = response.json();
    assert.match(payload.meta.requestId, /^req_[0-9a-f-]+$/);
    assert.equal(response.headers["x-request-id"], payload.meta.requestId);
    assert.equal(response.headers["cache-control"], "no-store");
    return { status: response.statusCode, body: payload, data: payload.data };
  }

  async function bootstrap() {
    const response = await request("POST", "/installation/bootstrap", {
      body: { name: "Agent service HTTP installation" },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    // Refuse to report extraction coverage when only the old controller facade is wired.
    assert.ok(controller.agent instanceof AgentService);
    assert.ok(controller.deployment instanceof DeploymentService);
  }

  async function namespace(name) {
    const response = await request("POST", "/namespaces", { body: { name } });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    // The real lifecycle transition makes this a ready tenant before admitting revisions;
    // no worker, listener, cloud resource, or runtime process is started by this fixture.
    const ready = await controller.handleNamespaceLifecycle(
      principal.id,
      response.data.id,
      "ready",
    );
    assert.equal(ready.status, "ready");
    return ready;
  }

  async function configuration(namespaceId, values = {}) {
    const response = await request("POST", `/namespaces/${namespaceId}/configurations`, {
      body: { kind: "agent", values },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.data;
  }

  return { request, bootstrap, namespace, configuration, state, auditSink, principal, role };
}

function assertFailure(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
}

function assertPublicResource(resource) {
  assert.equal(Object.hasOwn(resource, "servicePrincipalId"), false);
  assert.equal(Object.hasOwn(resource, "sandboxDriverId"), false);
}

async function createAgent(f, namespaceId, configurationId, name = "HTTP Agent") {
  const response = await f.request("POST", `/namespaces/${namespaceId}/agents`, {
    body: { name, configurationId },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response;
}

async function historicalRevision(f, agent, configuration) {
  // Seed a retained historical snapshot through the real repository. It has no
  // workload profile, runtime admission, or lifecycle head; this is revision-read
  // coverage and does not represent a successful current HTTP deployment.
  const compute = createDevelopmentComputeDriver();
  return f.state.transact(async (unit) => {
    const owner = await unit.agents.findAgent(agent.namespaceId, agent.id);
    assert.ok(owner);
    return unit.revisions.createRevision({
      id: `rev_${randomUUID()}`,
      namespaceId: agent.namespaceId,
      agentId: agent.id,
      revision: 1,
      maximumExecutionMs: owner.maximumExecutionMs,
      providerId: owner.providerId,
      configurationId: configuration.id,
      configurationKind: configuration.kind,
      configurationGeneration: configuration.generation,
      configuration: configuration.values,
      harness: { ...resolveApprovedHarness("openclaw", "embedded"), mode: "embedded" },
      compute: { id: compute.id, implementation: compute.implementation },
      servicePrincipalId: owner.servicePrincipalId,
      createdAt: new Date().toISOString(),
    });
  });
}

// TODO: Add admitted-revision and deploy-IAM coverage when this Fastify fixture has
// genuine request custody, a saved admitted workload profile, and its required owners.
// An invented selection cannot turn this passive fixture into V2 admission proof.
test("Agent service HTTP preserves audited drafts and historical revision reads without lifecycle admission", async (t) => {
  const f = await fixture(t);
  const absent = `/namespaces/ns_${randomUUID()}/agents/agt_${randomUUID()}`;
  assertFailure(await f.request("GET", absent, { authenticated: false }), 401, "UNAUTHENTICATED");
  assertFailure(await f.request("GET", absent), 404, "NOT_FOUND");
  await f.bootstrap();
  const tenant = await f.namespace("Agent service tenant");
  const draft = await f.configuration(tenant.id, {
    plugins: { entries: { knowledge: { enabled: true } } },
  });
  const created = await createAgent(f, tenant.id, draft.id);
  const path = `/namespaces/${tenant.id}/agents/${created.data.id}`;
  assert.equal(created.data.configurationId, draft.id);
  assert.equal(created.data.providerId, null);
  assertPublicResource(created.data);
  assertFailure(await f.request("GET", path, { authenticated: false }), 401, "UNAUTHENTICATED");

  const listed = await f.request("GET", `/namespaces/${tenant.id}/agents`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data, [created.data]);
  const read = await f.request("GET", path);
  assert.equal(read.status, 200);
  assert.deepEqual(read.data, created.data);

  // No selected profile or admission owner exists in this composition. The route
  // rejects the retired bodyless request without creating a revision or intent.
  assertFailure(await f.request("POST", `${path}/deploy`), 400, "INVALID_REQUEST");
  const emptyHistory = await f.request("GET", `${path}/revisions`);
  assert.equal(emptyHistory.status, 200);
  assert.deepEqual(emptyHistory.data, []);
  assertFailure(await f.request("GET", `${path}/revisions/rev_${randomUUID()}`), 404, "NOT_FOUND");
  assertFailure(await f.request("GET", `${path}/lifecycle`), 503, "DEPENDENCY_UNAVAILABLE");

  const historical = await historicalRevision(f, created.data, draft);
  const revisionPath = `${path}/revisions/${historical.id}`;
  const historicalRead = await f.request("GET", revisionPath);
  assert.equal(historicalRead.status, 200);
  assert.equal(historicalRead.data.id, historical.id);
  assert.deepEqual(historicalRead.data.configuration, draft.values);
  assertPublicResource(historicalRead.data);

  // Editing the Configuration and replacing the draft cannot rewrite the
  // historical snapshot. Neither mutation creates a new revision or intent.
  const changed = await f.request("PATCH", `/namespaces/${tenant.id}/configurations/${draft.id}`, {
    body: { values: { plugins: { entries: { knowledge: { enabled: false } } } } },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.data.generation, 2);
  const replacement = await f.configuration(tenant.id, { model: "replacement-model" });
  const updated = await f.request("PATCH", path, {
    body: { configurationId: replacement.id, providerId: null, serviceAccountId: null },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.data.configurationId, replacement.id);
  assert.equal(Object.hasOwn(updated.data, "serviceAccountId"), false);
  assertPublicResource(updated.data);
  const updatedRead = await f.request("GET", path);
  assert.equal(updatedRead.status, 200);
  assert.deepEqual(updatedRead.data, updated.data);
  assertFailure(await f.request("POST", `${path}/deploy`), 400, "INVALID_REQUEST");
  const revisions = await f.request("GET", `${path}/revisions`);
  assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.data, [historicalRead.data]);
  const retained = await f.request("GET", revisionPath);
  assert.equal(retained.status, 200);
  assert.deepEqual(retained.data, historicalRead.data);

  const events = f.auditSink.events.filter(
    (event) =>
      event.kind === "mutation" && ["agent", "agent_revision"].includes(event.resource.kind),
  );
  assert.deepEqual(
    events.map((event) => event.action),
    ["openclaw.agents.create", "openclaw.agents.update"],
  );
  for (const [index, response] of [created, updated].entries()) {
    assert.equal(events[index].actorId, f.principal.id);
    assert.equal(events[index].requestId, response.body.meta.requestId);
    assert.equal(events[index].outcome, "success");
    assert.deepEqual(events[index].resource, {
      kind: "agent",
      namespaceId: tenant.id,
      id: response.data.id,
    });
  }
  const persisted = await f.state.read(async (view) => ({
    revisions: await view.revisions.listRevisions(tenant.id, created.data.id),
    head: await view.runtimeAssignments.findRuntimeIntentHead({
      namespaceId: tenant.id,
      agentId: created.data.id,
    }),
  }));
  assert.deepEqual(persisted.revisions, [historical]);
  assert.equal(persisted.head, undefined);
});

test("Agent service HTTP rejects invalid drafts, deploy bodies, and foreign resource ownership", async (t) => {
  const f = await fixture(t);
  await f.bootstrap();
  const tenant = await f.namespace("Owned tenant");
  const foreign = await f.namespace("Foreign tenant");
  const draft = await f.configuration(tenant.id);
  const foreignDraft = await f.configuration(foreign.id);
  const created = await createAgent(f, tenant.id, draft.id);
  const sibling = await createAgent(f, tenant.id, draft.id, "Sibling Agent");
  const path = `/namespaces/${tenant.id}/agents/${created.data.id}`;
  const historical = await historicalRevision(f, created.data, draft);
  const snapshot = () =>
    f.state.read(async (view) => ({
      agents: await view.agents.listAgents(tenant.id),
      revisions: await view.revisions.listRevisions(tenant.id, created.data.id),
      head: await view.runtimeAssignments.findRuntimeIntentHead({
        namespaceId: tenant.id,
        agentId: created.data.id,
      }),
    }));
  const before = await snapshot();
  for (const body of [
    { configurationId: draft.id, executionMode: "invalid" },
    { configurationId: draft.id, activeRevisionId: historical.id },
    { configurationId: draft.id, servicePrincipalId: "caller-selected" },
    {},
  ]) {
    assertFailure(await f.request("PATCH", path, { body }), 400, "INVALID_REQUEST");
  }
  for (const body of [
    {},
    { expectedLifecycleGeneration: null },
    { expectedLifecycleGeneration: 1 },
  ]) {
    assertFailure(await f.request("POST", `${path}/deploy`, { body }), 400, "INVALID_REQUEST");
  }
  assertFailure(
    await f.request("PATCH", path, { body: { configurationId: foreignDraft.id } }),
    404,
    "NOT_FOUND",
  );
  assertFailure(
    await f.request("GET", `/namespaces/${foreign.id}/agents/${created.data.id}`),
    404,
    "NOT_FOUND",
  );
  assertFailure(
    await f.request(
      "GET",
      `/namespaces/${tenant.id}/agents/${sibling.data.id}/revisions/${historical.id}`,
    ),
    404,
    "NOT_FOUND",
  );
  assertFailure(
    await f.request("GET", `${path}/revisions?unexpected=true`),
    400,
    "INVALID_REQUEST",
  );
  assert.deepEqual(await snapshot(), before);
});

test("Agent service HTTP rechecks current Native IAM authority and audits denied mutations", async (t) => {
  const f = await fixture(t);
  await f.bootstrap();
  const tenant = await f.namespace("Permission tenant");
  const draft = await f.configuration(tenant.id);
  const created = await createAgent(f, tenant.id, draft.id);
  const path = `/namespaces/${tenant.id}/agents/${created.data.id}`;
  const before = await f.state.read((view) => view.agents.findAgent(tenant.id, created.data.id));
  // Revoking the real policy binding's permissions leaves the authenticated principal
  // valid, so subsequent requests must fail authorization rather than authentication.
  f.role.permissions = [];
  for (const [method, url, body, action] of [
    ["GET", path, undefined, "read"],
    ["PATCH", path, { configurationId: draft.id }, "update"],
  ]) {
    const denied = await f.request(method, url, { body });
    assertFailure(denied, 403, "FORBIDDEN");
    const event = f.auditSink.events.at(-1);
    assert.equal(event.kind, "authorization_denial");
    assert.equal(event.actorId, f.principal.id);
    assert.equal(event.authorization.action, action);
    assert.equal(event.requestId, denied.body.meta.requestId);
    assert.deepEqual(event.resource, {
      kind: "agent",
      namespaceId: tenant.id,
      id: created.data.id,
    });
  }
  // Invalid deploy syntax is rejected before Agent authorization; this does not
  // establish deploy-IAM denial without a genuine saved profile and V2 command.
  const auditCount = f.auditSink.events.length;
  assertFailure(await f.request("POST", `${path}/deploy`), 400, "INVALID_REQUEST");
  assert.equal(f.auditSink.events.length, auditCount);
  assert.deepEqual(
    await f.state.read((view) => view.agents.findAgent(tenant.id, created.data.id)),
    before,
  );
  assert.deepEqual(
    await f.state.read((view) => view.revisions.listRevisions(tenant.id, created.data.id)),
    [],
  );
});

test("Agent execution limit HTTP defaults, preserves, clears and rejects invalid values", async (t) => {
  const f = await fixture(t);
  await f.bootstrap();
  const tenant = await f.namespace("Execution limits");
  const cfg = await f.configuration(tenant.id, { model: "retained" });
  const created = await createAgent(f, tenant.id, cfg.id);
  assert.equal(created.data.maximumExecutionMs, null);
  const path = `/namespaces/${tenant.id}/agents/${created.data.id}`;
  // A finite cap larger than the former fifteen-minute ceiling is valid.
  const capped = await f.request("PATCH", path, {
    body: { configurationId: cfg.id, maximumExecutionMs: 7_200_000 },
  });
  assert.equal(capped.status, 200, JSON.stringify(capped.body));
  assert.equal(capped.data.maximumExecutionMs, 7_200_000);
  const preserved = await f.request("PATCH", path, { body: { configurationId: cfg.id } });
  assert.equal(preserved.data.maximumExecutionMs, 7_200_000);
  assert.equal((await f.request("GET", path)).data.maximumExecutionMs, 7_200_000);
  assert.equal(
    (await f.request("GET", `/namespaces/${tenant.id}/agents`)).data[0].maximumExecutionMs,
    7_200_000,
  );
  for (const maximumExecutionMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1000", false]) {
    assertFailure(
      await f.request("PATCH", path, {
        body: { configurationId: cfg.id, maximumExecutionMs },
      }),
      400,
      "INVALID_REQUEST",
    );
    assertFailure(
      await f.request("POST", `/namespaces/${tenant.id}/agents`, {
        body: { name: "Invalid cap", configurationId: cfg.id, maximumExecutionMs },
      }),
      400,
      "INVALID_REQUEST",
    );
  }
  const cleared = await f.request("PATCH", path, {
    body: { configurationId: cfg.id, maximumExecutionMs: null },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.data.maximumExecutionMs, null);
  for (const maximumExecutionMs of [1, Number.MAX_SAFE_INTEGER, null]) {
    const response = await f.request("POST", `/namespaces/${tenant.id}/agents`, {
      body: {
        name: `Accepted cap ${maximumExecutionMs}`,
        configurationId: cfg.id,
        maximumExecutionMs,
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.data.maximumExecutionMs, maximumExecutionMs);
  }
});
