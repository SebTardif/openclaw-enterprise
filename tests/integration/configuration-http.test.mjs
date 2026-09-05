import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createControllerApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";

async function fixture({ permissions, auditSink = new InMemoryAuditSink() } = {}) {
  const auth = await createTestAuthPrincipal({ name: "Configuration HTTP Administrator" });
  const principal = auth.seed.principal;
  const role = {
    id: "role-configuration-http",
    permissions: permissions ?? auth.seed.roles[0].permissions,
  };
  const iamDriver = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities: [principal],
      groups: [],
      memberships: [],
      roles: [role],
      bindings: [
        {
          id: "binding-configuration-http",
          subjectKind: "identity",
          subjectId: principal.id,
          roleId: role.id,
        },
      ],
      restrictions: [],
    }),
  });
  const configurationDriver = createTestConfigurationDriver();
  let controller;
  // createControllerApp dispatches Fetch requests through the genuine Fastify.inject adapter.
  // Only external storage is passive; session admission, IAM, OCC, and transactions are real.
  const app = createControllerApp({
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: new InMemoryPlatformState({ auditSink }),
        recordOperations: false,
      });
      return controller;
    },
    iamDriver,
    configurationDriver,
    resolveHarness: resolveApprovedHarness,
    auditSink,
    development: {
      enabled: true,
      issuer: principal.issuer,
      subject: principal.subject,
      principalId: principal.id,
      installationId: auth.installationId,
    },
    publicOrigin: "http://127.0.0.1",
    auth: auth.auth,
  });
  const session = await signInToControllerApp(app, auth);
  return {
    principal,
    auditSink,
    configurationDriver,
    get controller() {
      return controller;
    },
    async request(method, pathname, { body, authenticated = true } = {}) {
      const headers = authenticated ? authenticatedHeaders(session) : {};
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await app.fetch(
        new Request(`http://127.0.0.1${pathname}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      return {
        status: response.status,
        headers: response.headers,
        body: response.status === 204 ? undefined : await response.json(),
      };
    },
  };
}

async function bootstrap(context) {
  const installed = await context.request("POST", "/installation/bootstrap", {
    body: { name: "Configuration HTTP installation" },
  });
  assert.equal(installed.status, 201, JSON.stringify(installed.body));
  const namespace = await context.request("POST", "/namespaces", {
    body: { name: "Configuration HTTP tenant" },
  });
  assert.equal(namespace.status, 201, JSON.stringify(namespace.body));
  return `/namespaces/${namespace.body.data.id}/configurations`;
}

function assertFailure(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
}

test("Configuration HTTP admits sessions before lazily resolving the bootstrapped controller", async () => {
  const context = await fixture();
  const pathname = `/namespaces/ns_${randomUUID()}/configurations/cfg_${randomUUID()}`;
  assertFailure(
    await context.request("GET", pathname, { authenticated: false }),
    401,
    "UNAUTHENTICATED",
  );
  assertFailure(await context.request("GET", pathname), 404, "NOT_FOUND");
  assert.equal(context.controller, undefined);

  // Registering Configuration handlers before bootstrap must not capture an absent controller.
  const collection = await bootstrap(context);
  const created = await context.request("POST", collection, {
    body: { kind: "agent", values: {} },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(context.controller);
  assertFailure(
    await context.request("GET", `${collection}/${created.body.data.id}`, {
      authenticated: false,
    }),
    401,
    "UNAUTHENTICATED",
  );
});

test("Configuration HTTP CRUD replaces native documents and emits attributable mutation audits", async () => {
  const context = await fixture();
  const collection = await bootstrap(context);
  const values = {
    models: {
      providers: {
        openai: {
          apiKey: { source: "store", provider: "teamstore", id: "OPENAI_API_KEY" },
        },
      },
    },
    plugins: { entries: { knowledge: { enabled: true, config: { thresholds: [0, 1.25, null] } } } },
  };
  const created = await context.request("POST", collection, { body: { kind: "agent", values } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const configuration = created.body.data;
  assert.match(configuration.id, /^cfg_[0-9a-f-]{36}$/);
  assert.equal(configuration.generation, 1);
  assert.equal(configuration.kind, "agent");
  assert.deepEqual(configuration.values, values);
  const pathname = `${collection}/${configuration.id}`;
  const read = await context.request("GET", pathname);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.data, configuration);

  // PATCH replaces the entire document; omitted model and plugin sections cannot survive.
  const replacement = { agents: { defaults: { sandbox: { mode: "off" } } } };
  const updated = await context.request("PATCH", pathname, { body: { values: replacement } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body.data, { ...configuration, generation: 2, values: replacement });
  assert.deepEqual(await context.configurationDriver.read(configuration), updated.body.data);
  const deleted = await context.request("DELETE", pathname);
  assert.equal(deleted.status, 204);
  assert.equal(deleted.body, undefined);
  assertFailure(await context.request("GET", pathname), 404, "NOT_FOUND");
  await assert.rejects(context.configurationDriver.read(configuration));

  const events = context.auditSink.events.filter(
    (event) => event.resource.kind === "configuration",
  );
  assert.deepEqual(
    events.map((event) => event.action),
    [
      "openclaw.configurations.create",
      "openclaw.configurations.update",
      "openclaw.configurations.delete",
    ],
  );
  for (const [index, response] of [created, updated, deleted].entries()) {
    const event = events[index];
    assert.equal(event.kind, "mutation");
    assert.equal(event.outcome, "success");
    assert.equal(event.actorId, context.principal.id);
    assert.equal(event.requestId, response.headers.get("x-request-id"));
    assert.deepEqual(event.resource, {
      kind: "configuration",
      id: configuration.id,
      namespaceId: configuration.namespaceId,
    });
  }
});

test("Configuration HTTP rejects strict body violations and foreign Namespace ownership", async () => {
  const context = await fixture();
  const collection = await bootstrap(context);
  // The HTTP boundary rejects unsafe keys and excessive nesting inside otherwise valid JSON.
  let deeplyNested = {};
  for (let depth = 0; depth < 25; depth++) deeplyNested = { child: deeplyNested };
  for (const body of [
    { values: {} },
    { kind: "gateway", values: {} },
    { kind: "agent", generation: 1, values: {} },
    { kind: "agent", values: { prototype: {} } },
    { kind: "agent", values: deeplyNested },
    ...[null, [], "document", 42].map((values) => ({ kind: "agent", values })),
  ]) {
    assertFailure(await context.request("POST", collection, { body }), 400, "INVALID_REQUEST");
  }
  const created = await context.request("POST", collection, {
    body: { kind: "agent", values: { model: "stable" } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pathname = `${collection}/${created.body.data.id}`;
  for (const body of [
    {},
    { kind: "agent", values: {} },
    { generation: 4, values: {} },
    { values: [] },
  ]) {
    assertFailure(await context.request("PATCH", pathname, { body }), 400, "INVALID_REQUEST");
  }
  const foreign = await context.request("POST", "/namespaces", {
    body: { name: "Foreign tenant" },
  });
  assert.equal(foreign.status, 201, JSON.stringify(foreign.body));
  // A real second Namespace exists, so rejection proves exact Configuration ownership.
  const foreignPath = `/namespaces/${foreign.body.data.id}/configurations/${created.body.data.id}`;
  for (const method of ["GET", "PATCH", "DELETE"]) {
    assertFailure(
      await context.request(
        method,
        foreignPath,
        method === "PATCH" ? { body: { values: {} } } : {},
      ),
      404,
      "NOT_FOUND",
    );
  }
  const unchanged = await context.request("GET", pathname);
  assert.equal(unchanged.status, 200);
  assert.deepEqual(unchanged.body.data, created.body.data);
  assert.equal(
    context.auditSink.events.filter(
      (event) => event.resource.kind === "configuration" && event.kind === "mutation",
    ).length,
    1,
  );
});

test("Configuration HTTP authorizes each exact resource operation with native IAM", async () => {
  const context = await fixture({
    permissions: [
      { action: "administer", resourceKind: "installation" },
      { action: "create", resourceKind: "namespace" },
      { action: "create", resourceKind: "configuration" },
    ],
  });
  const collection = await bootstrap(context);
  const created = await context.request("POST", collection, {
    body: { kind: "agent", values: {} },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const configuration = created.body.data;
  // Collection create authority grants no read, update, or delete authority on the created resource.
  for (const [method, action] of [
    ["GET", "read"],
    ["PATCH", "update"],
    ["DELETE", "delete"],
  ]) {
    const denied = await context.request(
      method,
      `${collection}/${configuration.id}`,
      method === "PATCH" ? { body: { values: {} } } : {},
    );
    assertFailure(denied, 403, "FORBIDDEN");
    const event = context.auditSink.events.at(-1);
    assert.equal(event.kind, "authorization_denial");
    assert.equal(event.actorId, context.principal.id);
    assert.equal(event.authorization.action, action);
    assert.equal(event.requestId, denied.headers.get("x-request-id"));
    assert.deepEqual(event.resource, {
      kind: "configuration",
      id: configuration.id,
      namespaceId: configuration.namespaceId,
    });
  }
  assert.deepEqual(await context.configurationDriver.read(configuration), configuration);
});

test("Configuration HTTP rolls back metadata and external storage when required auditing fails", async () => {
  class FailingAuditSink extends InMemoryAuditSink {
    rejectedAction;
    rejectedResource;
    async append(event) {
      if (event.action === this.rejectedAction) {
        this.rejectedResource = event.resource;
        throw new Error("Required mutation audit is unavailable.");
      }
      return super.append(event);
    }
  }
  const auditSink = new FailingAuditSink();
  const context = await fixture({ auditSink });
  const collection = await bootstrap(context);
  auditSink.rejectedAction = "openclaw.configurations.create";
  assertFailure(
    await context.request("POST", collection, { body: { kind: "agent", values: {} } }),
    503,
    "DEPENDENCY_UNAVAILABLE",
  );
  const rejected = auditSink.rejectedResource;
  await assert.rejects(context.configurationDriver.read(rejected));
  assertFailure(await context.request("GET", `${collection}/${rejected.id}`), 404, "NOT_FOUND");

  auditSink.rejectedAction = undefined;
  const created = await context.request("POST", collection, {
    body: { kind: "agent", values: { model: "original" } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const configuration = created.body.data;
  // The sink fails after the real external write; OCC must compensate and retain generation 1.
  for (const [method, action] of [
    ["PATCH", "update"],
    ["DELETE", "delete"],
  ]) {
    auditSink.rejectedAction = `openclaw.configurations.${action}`;
    const response = await context.request(
      method,
      `${collection}/${configuration.id}`,
      method === "PATCH" ? { body: { values: { model: "rejected" } } } : {},
    );
    assertFailure(response, 503, "DEPENDENCY_UNAVAILABLE");
    assert.deepEqual(await context.configurationDriver.read(configuration), configuration);
    const restored = await context.request("GET", `${collection}/${configuration.id}`);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual(restored.body.data, configuration);
  }
  assert.deepEqual(
    auditSink.events
      .filter((event) => event.resource.kind === "configuration")
      .map((event) => event.action),
    ["openclaw.configurations.create"],
  );
});

test("Configuration HTTP applies an optional generation precondition and rejects stale writes", async () => {
  const context = await fixture();
  const collection = await bootstrap(context);
  const created = await context.request("POST", collection, {
    body: { kind: "agent", values: { model: "original" } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const configuration = created.body.data;
  assert.equal(configuration.generation, 1);
  const pathname = `${collection}/${configuration.id}`;
  const successfulUpdates = () =>
    context.auditSink.events.filter(
      (event) =>
        event.resource.kind === "configuration" &&
        event.resource.id === configuration.id &&
        event.kind === "mutation" &&
        event.outcome === "success" &&
        event.action === "openclaw.configurations.update",
    );

  for (const expectedGeneration of [null, "1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assertFailure(
      await context.request("PATCH", pathname, {
        body: { expectedGeneration, values: { model: "invalid-precondition" } },
      }),
      400,
      "INVALID_REQUEST",
    );
  }
  // The upper endpoint is schema-valid but cannot match this newly created resource.
  assertFailure(
    await context.request("PATCH", pathname, {
      body: { expectedGeneration: Number.MAX_SAFE_INTEGER, values: { model: "stale-upper-bound" } },
    }),
    409,
    "RESOURCE_CONFLICT",
  );
  assert.deepEqual(await context.configurationDriver.read(configuration), configuration);
  assert.equal(successfulUpdates().length, 0);

  const candidates = [
    { agents: { defaults: { sandbox: { mode: "off" } } } },
    {
      plugins: {
        entries: { knowledge: { enabled: true, config: { thresholds: [0, 1.25, null] } } },
      },
    },
  ];
  // Overlapping requests use the real in-memory transaction manager; either request may win.
  // This proves HTTP preconditions without claiming PostgreSQL concurrency coverage.
  const responses = await Promise.all(
    candidates.map((values) =>
      context.request("PATCH", pathname, {
        body: { expectedGeneration: 1, values },
      }),
    ),
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const winnerIndex = responses.findIndex((response) => response.status === 200);
  const winner = responses[winnerIndex];
  assertFailure(responses[1 - winnerIndex], 409, "RESOURCE_CONFLICT");
  assert.deepEqual(winner.body.data, {
    ...configuration,
    generation: 2,
    values: candidates[winnerIndex],
  });
  const read = await context.request("GET", pathname);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.data, winner.body.data);
  assert.deepEqual(await context.configurationDriver.read(configuration), winner.body.data);
  const updates = successfulUpdates();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].requestId, winner.headers.get("x-request-id"));
  assert.equal(updates[0].actorId, context.principal.id);

  // Replaying the stale generation cannot replace the winner or emit another successful audit.
  assertFailure(
    await context.request("PATCH", pathname, {
      body: { expectedGeneration: 1, values: { model: "stale-replay" } },
    }),
    409,
    "RESOURCE_CONFLICT",
  );
  const unchanged = await context.request("GET", pathname);
  assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
  assert.deepEqual(unchanged.body.data, winner.body.data);
  assert.deepEqual(await context.configurationDriver.read(configuration), winner.body.data);
  assert.deepEqual(successfulUpdates(), updates);
});
