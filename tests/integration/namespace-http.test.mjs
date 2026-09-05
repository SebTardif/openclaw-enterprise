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
  const auth = await createTestAuthPrincipal({ name: "Namespace HTTP Administrator" });
  const principal = auth.seed.principal;
  const role = {
    id: "role-namespace-http",
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
          id: "binding-namespace-http",
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
        recordOperations: true,
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
  const response = await context.request("POST", "/installation/bootstrap", {
    body: { name: "Namespace HTTP installation" },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
}

async function createNamespace(context, name = "Namespace HTTP tenant") {
  const response = await context.request("POST", "/namespaces", { body: { name } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response;
}

function assertFailure(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
  assert.equal(response.body.meta.requestId, response.headers.get("x-request-id"));
}

function namespaceOperations(context, namespaceId) {
  return context.controller
    .pendingOperations()
    .filter((operation) => operation.kind === "namespace" && operation.resourceId === namespaceId);
}

test("Namespace HTTP admits sessions before lazily resolving the bootstrapped controller", async () => {
  const context = await fixture();
  const pathname = `/namespaces/ns_${randomUUID()}`;
  for (const [method, path, body] of [
    ["GET", "/namespaces"],
    ["GET", pathname],
    ["POST", "/namespaces", { name: "Before installation" }],
    ["DELETE", pathname],
  ]) {
    assertFailure(
      await context.request(method, path, { body, authenticated: false }),
      401,
      "UNAUTHENTICATED",
    );
    assertFailure(await context.request(method, path, { body }), 404, "NOT_FOUND");
    assert.equal(context.controller, undefined);
  }

  // Registration occurs before bootstrap; later requests must resolve the newly installed owner.
  await bootstrap(context);
  const created = await createNamespace(context);
  const read = await context.request("GET", `/namespaces/${created.body.data.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.data, created.body.data);
});

test("Namespace HTTP preserves envelopes, list order, asynchronous deletion, queue targets, and audits", async () => {
  const context = await fixture();
  await bootstrap(context);
  const baseline = await context.request("GET", "/namespaces");
  assert.equal(baseline.status, 200);
  const created = await createNamespace(context, "First HTTP tenant");
  const second = await createNamespace(context, "Second HTTP tenant");
  const namespace = created.body.data;
  assert.deepEqual(Object.keys(namespace), ["id", "name", "status", "createdAt"]);
  assert.match(namespace.id, /^ns_[0-9a-f-]{36}$/);
  assert.equal(namespace.status, "provisioning");
  assert.equal(created.body.meta.requestId, created.headers.get("x-request-id"));
  const listed = await context.request("GET", "/namespaces");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data, [...baseline.body.data, namespace, second.body.data]);
  const pathname = `/namespaces/${namespace.id}`;
  const read = await context.request("GET", pathname);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.data, namespace);

  const deleted = await context.request("DELETE", pathname);
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body.data, { ...namespace, status: "deleting" });
  const repeated = await context.request("DELETE", pathname);
  assert.equal(repeated.status, 202);
  assert.deepEqual(repeated.body.data, deleted.body.data);
  // Logical deletion remains visible until the worker completes, and a retry adds no queue item.
  const deletingRead = await context.request("GET", pathname);
  assert.equal(deletingRead.status, 200);
  assert.deepEqual(deletingRead.body.data, deleted.body.data);
  assert.deepEqual(
    namespaceOperations(context, namespace.id).map(({ action, target, namespaceId, actorId }) => ({
      action,
      target,
      namespaceId,
      actorId,
    })),
    ["ready", "deleted"].map((target) => ({
      action: "reconcile",
      target,
      namespaceId: namespace.id,
      actorId: context.principal.id,
    })),
  );

  const events = context.auditSink.events.filter(
    (event) => event.resource.kind === "namespace" && event.resource.id === namespace.id,
  );
  assert.deepEqual(
    events.map((event) => event.action),
    ["openclaw.namespaces.create", "openclaw.namespaces.delete", "openclaw.namespaces.delete"],
  );
  for (const [index, response] of [created, deleted, repeated].entries()) {
    const event = events[index];
    assert.equal(event.kind, "mutation");
    assert.equal(event.outcome, "success");
    assert.equal(event.actorId, context.principal.id);
    assert.equal(event.requestId, response.headers.get("x-request-id"));
    assert.deepEqual(event.resource, {
      kind: "namespace",
      id: namespace.id,
      namespaceId: namespace.id,
    });
  }
});

test("Namespace HTTP rejects strict requests, duplicate names, unavailable adoption, and absent identities", async () => {
  const context = await fixture();
  await bootstrap(context);
  for (const body of [
    {},
    { name: "" },
    { name: " trailing " },
    { name: "Tenant", installationId: `ins_${randomUUID()}` },
    { name: "Tenant", status: "ready" },
    { name: "Tenant", existingNamespace: "Invalid_Name" },
    { name: "Tenant", existingNamespace: "a".repeat(64) },
    null,
    [],
  ]) {
    assertFailure(await context.request("POST", "/namespaces", { body }), 400, "INVALID_REQUEST");
  }
  assertFailure(
    await context.request("GET", "/namespaces?installationId=caller-owned"),
    400,
    "INVALID_REQUEST",
  );
  assertFailure(await context.request("GET", "/namespaces/not-an-id"), 400, "INVALID_REQUEST");
  await createNamespace(context, "Unique tenant");
  assertFailure(
    await context.request("POST", "/namespaces", { body: { name: "Unique tenant" } }),
    409,
    "RESOURCE_CONFLICT",
  );
  // Adoption requires selected Kubernetes Compute; this fixture deliberately has no Compute driver.
  assertFailure(
    await context.request("POST", "/namespaces", {
      body: { name: "Existing tenant", existingNamespace: "operator-owned" },
    }),
    409,
    "RESOURCE_CONFLICT",
  );
  const absent = `/namespaces/ns_${randomUUID()}`;
  for (const method of ["GET", "DELETE"]) {
    assertFailure(await context.request(method, absent), 404, "NOT_FOUND");
  }
  assert.equal(
    context.auditSink.events.filter((event) => event.resource.kind === "namespace").length,
    1,
  );
});

test("Namespace HTTP filters unreadable candidates and audits exact IAM denials", async () => {
  const context = await fixture({
    permissions: [
      { action: "administer", resourceKind: "installation" },
      { action: "create", resourceKind: "namespace" },
    ],
  });
  await bootstrap(context);
  const created = await createNamespace(context);
  const namespace = created.body.data;
  // Collection create permission grants no read or delete permission on the created Namespace.
  const listed = await context.request("GET", "/namespaces");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data, []);
  for (const [method, action] of [
    ["GET", "read"],
    ["DELETE", "delete"],
  ]) {
    const denied = await context.request(method, `/namespaces/${namespace.id}`);
    assertFailure(denied, 403, "FORBIDDEN");
    const event = context.auditSink.events.at(-1);
    assert.equal(event.kind, "authorization_denial");
    assert.equal(event.actorId, context.principal.id);
    assert.equal(event.authorization.action, action);
    assert.equal(event.requestId, denied.headers.get("x-request-id"));
    assert.deepEqual(event.resource, {
      kind: "namespace",
      id: namespace.id,
      namespaceId: namespace.id,
    });
  }
  assert.deepEqual(
    namespaceOperations(context, namespace.id).map(({ target }) => target),
    ["ready"],
  );
});

test("Namespace HTTP refuses deletion while a real Configuration still belongs to the Namespace", async () => {
  const context = await fixture();
  await bootstrap(context);
  const created = await createNamespace(context);
  const namespace = created.body.data;
  const pathname = `/namespaces/${namespace.id}`;
  const configuration = await context.request("POST", `${pathname}/configurations`, {
    body: { kind: "agent", values: {} },
  });
  assert.equal(configuration.status, 201, JSON.stringify(configuration.body));
  assertFailure(await context.request("DELETE", pathname), 409, "NAMESPACE_NOT_EMPTY");
  const unchanged = await context.request("GET", pathname);
  assert.deepEqual(unchanged.body.data, namespace);
  assert.deepEqual(
    namespaceOperations(context, namespace.id).map(({ target }) => target),
    ["ready"],
  );
  const removed = await context.request(
    "DELETE",
    `${pathname}/configurations/${configuration.body.data.id}`,
  );
  assert.equal(removed.status, 204);
  const deleted = await context.request("DELETE", pathname);
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
});

test("Namespace HTTP rolls back metadata and queued work when required mutation auditing fails", async () => {
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
  await bootstrap(context);
  const baseline = context.controller.pendingOperations();
  auditSink.rejectedAction = "openclaw.namespaces.create";
  assertFailure(
    await context.request("POST", "/namespaces", { body: { name: "Rolled back tenant" } }),
    503,
    "DEPENDENCY_UNAVAILABLE",
  );
  assertFailure(
    await context.request("GET", `/namespaces/${auditSink.rejectedResource.id}`),
    404,
    "NOT_FOUND",
  );
  assert.deepEqual(context.controller.pendingOperations(), baseline);

  auditSink.rejectedAction = undefined;
  const created = await createNamespace(context, "Rolled back tenant");
  const namespace = created.body.data;
  const operations = context.controller.pendingOperations();
  // The external sink fails after the real mutation callback; the private transaction cannot publish.
  auditSink.rejectedAction = "openclaw.namespaces.delete";
  assertFailure(
    await context.request("DELETE", `/namespaces/${namespace.id}`),
    503,
    "DEPENDENCY_UNAVAILABLE",
  );
  const restored = await context.request("GET", `/namespaces/${namespace.id}`);
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.data, namespace);
  assert.deepEqual(context.controller.pendingOperations(), operations);
  assert.deepEqual(
    auditSink.events
      .filter((event) => event.resource.kind === "namespace")
      .map((event) => event.action),
    ["openclaw.namespaces.create"],
  );
});
