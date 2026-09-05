import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createControllerApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { SecretService } from "../../packages/occ/src/services/secret/service.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

async function fixture({
  permissions,
  auditSink = new InMemoryAuditSink(),
  secretDriver = createTestSecretDriver(),
} = {}) {
  const auth = await createTestAuthPrincipal({ name: "Secret HTTP Administrator" });
  const principal = auth.seed.principal;
  const role = {
    id: "role-secret-http",
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
          id: "binding-secret-http",
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
    secretDriver,
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
    secretDriver,
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
    body: { name: "Secret HTTP installation" },
  });
  assert.equal(installed.status, 201, JSON.stringify(installed.body));
  assert.ok(context.controller.secret instanceof SecretService);
  const created = await context.request("POST", "/namespaces", {
    body: { name: "Secret HTTP tenant" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const namespace = created.body.data;
  // Seed the persisted result of successful Namespace provisioning. This suite
  // exercises Fastify, sessions, IAM and service transactions, not Compute execution.
  await context.controller.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  return { namespace, collection: `/namespaces/${namespace.id}/secrets` };
}

function assertFailure(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
}

test("Secret HTTP resolves the service after bootstrap and preserves metadata-only envelopes and audit attribution", async () => {
  const context = await fixture();
  const missing = `/namespaces/ns_${randomUUID()}/secrets/sec_${randomUUID()}`;
  assertFailure(
    await context.request("GET", missing, { authenticated: false }),
    401,
    "UNAUTHENTICATED",
  );
  assertFailure(await context.request("GET", missing), 404, "NOT_FOUND");
  assert.equal(context.controller, undefined);
  const { namespace, collection } = await bootstrap(context);
  const value = "synthetic-http-request-value";
  const created = await context.request("POST", collection, {
    body: { name: "Application token", value },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const secret = created.body.data;
  assert.deepEqual(secret, {
    id: secret.id,
    name: "Application token",
    namespaceId: namespace.id,
    ref: { kind: "secret", namespaceId: namespace.id, id: secret.id },
  });
  assert.equal(context.secretDriver.valueFor(secret), value);
  const pathname = `${collection}/${secret.id}`;
  const read = await context.request("GET", pathname);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.data, secret);
  const updated = await context.request("PATCH", pathname, {
    body: { value: "replacement-synthetic-value" },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body.data, secret);
  assert.equal(context.secretDriver.valueFor(secret), "replacement-synthetic-value");
  const deleted = await context.request("DELETE", pathname);
  assert.equal(deleted.status, 204);
  assert.equal(deleted.body, undefined);
  assert.equal(context.secretDriver.has(secret), false);
  assertFailure(await context.request("GET", pathname), 404, "NOT_FOUND");
  const events = context.auditSink.events.filter((event) => event.resource.kind === "secret");
  assert.deepEqual(
    events.map((event) => event.action),
    ["openclaw.secrets.create", "openclaw.secrets.update", "openclaw.secrets.delete"],
  );
  for (const [index, response] of [created, updated, deleted].entries()) {
    assert.equal(events[index].actorId, context.principal.id);
    assert.equal(events[index].requestId, response.headers.get("x-request-id"));
    assert.equal(events[index].kind, "mutation");
    assert.equal(events[index].outcome, "success");
    assert.deepEqual(events[index].resource, {
      kind: "secret",
      id: secret.id,
      namespaceId: namespace.id,
    });
  }
  assert.equal(
    JSON.stringify([created.body, read.body, updated.body, events]).includes(value),
    false,
  );
  assert.equal(
    JSON.stringify([created.body, read.body, updated.body, events]).includes(
      "replacement-synthetic-value",
    ),
    false,
  );
});

test("Secret HTTP keeps exact native IAM denial attribution and schema admission", async () => {
  const context = await fixture({
    permissions: [
      { action: "administer", resourceKind: "installation" },
      { action: "create", resourceKind: "namespace" },
      { action: "create", resourceKind: "secret" },
    ],
  });
  const { namespace, collection } = await bootstrap(context);
  for (const body of [
    { value: "synthetic" },
    { name: "Token", value: "synthetic", backendRef: {} },
    { name: "Token", value: "" },
    { name: "Token", value: "\0" },
  ]) {
    assertFailure(await context.request("POST", collection, { body }), 400, "INVALID_REQUEST");
  }
  assert.equal(context.secretDriver.calls.length, 0);
  const created = await context.request("POST", collection, {
    body: { name: "Token", value: "synthetic" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const secret = created.body.data;
  for (const [method, action] of [
    ["GET", "read"],
    ["PATCH", "update"],
    ["DELETE", "delete"],
  ]) {
    const denied = await context.request(
      method,
      `${collection}/${secret.id}`,
      method === "PATCH" ? { body: { value: "replacement" } } : {},
    );
    assertFailure(denied, 403, "FORBIDDEN");
    const event = context.auditSink.events.at(-1);
    assert.equal(event.kind, "authorization_denial");
    assert.equal(event.actorId, context.principal.id);
    assert.equal(event.requestId, denied.headers.get("x-request-id"));
    assert.equal(event.authorization.action, action);
    assert.deepEqual(event.resource, { kind: "secret", id: secret.id, namespaceId: namespace.id });
  }
  assert.equal(context.secretDriver.calls.length, 1);
});

test("Secret HTTP honors Configuration bindings and exact foreign Namespace scope", async () => {
  const context = await fixture();
  const { namespace, collection } = await bootstrap(context);
  const created = await context.request("POST", collection, {
    body: { name: "Token", value: "synthetic" },
  });
  assert.equal(created.status, 201);
  const secret = created.body.data;
  const configuration = await context.request(
    "POST",
    `/namespaces/${namespace.id}/configurations`,
    { body: { kind: "agent", values: {}, secretBindings: { APP_TOKEN: { source: secret.ref } } } },
  );
  assert.equal(configuration.status, 201, JSON.stringify(configuration.body));
  assertFailure(
    await context.request("DELETE", `${collection}/${secret.id}`),
    409,
    "RESOURCE_CONFLICT",
  );
  const foreign = await context.request("POST", "/namespaces", {
    body: { name: "Foreign Secret HTTP tenant" },
  });
  assert.equal(foreign.status, 201);
  await context.controller.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(foreign.body.data.id, "provisioning", "ready"),
  );
  for (const method of ["GET", "PATCH", "DELETE"]) {
    assertFailure(
      await context.request(
        method,
        `/namespaces/${foreign.body.data.id}/secrets/${secret.id}`,
        method === "PATCH" ? { body: { value: "wrong-tenant" } } : {},
      ),
      404,
      "NOT_FOUND",
    );
  }
  assert.equal(context.secretDriver.calls.length, 1);
  const deletedConfiguration = await context.request(
    "DELETE",
    `/namespaces/${namespace.id}/configurations/${configuration.body.data.id}`,
  );
  assert.equal(deletedConfiguration.status, 204);
  assert.equal((await context.request("DELETE", `${collection}/${secret.id}`)).status, 204);
});

test("Secret HTTP compensates known failed create auditing and does not retain a prior update value", async () => {
  class FailingAuditSink extends InMemoryAuditSink {
    rejectedAction;
    rejectedResource;
    async append(event) {
      if (event.action === this.rejectedAction) {
        this.rejectedResource = event.resource;
        throw new Error("Required audit is unavailable.");
      }
      return super.append(event);
    }
  }
  const auditSink = new FailingAuditSink();
  const context = await fixture({ auditSink });
  const { collection } = await bootstrap(context);
  auditSink.rejectedAction = "openclaw.secrets.create";
  assertFailure(
    await context.request("POST", collection, {
      body: { name: "Rejected", value: "synthetic-rejected" },
    }),
    503,
    "DEPENDENCY_UNAVAILABLE",
  );
  const rejected = auditSink.rejectedResource;
  assert.equal(context.secretDriver.has(rejected), false);
  assertFailure(await context.request("GET", `${collection}/${rejected.id}`), 404, "NOT_FOUND");
  auditSink.rejectedAction = undefined;
  const created = await context.request("POST", collection, {
    body: { name: "Token", value: "synthetic-original" },
  });
  assert.equal(created.status, 201);
  const secret = created.body.data;
  auditSink.rejectedAction = "openclaw.secrets.update";
  assertFailure(
    await context.request("PATCH", `${collection}/${secret.id}`, {
      body: { value: "synthetic-replacement" },
    }),
    503,
    "DEPENDENCY_UNAVAILABLE",
  );
  // The external write already completed. Secret policy intentionally retains
  // neither plaintext nor a rollback copy, even when its required audit fails.
  assert.equal(context.secretDriver.valueFor(secret), "synthetic-replacement");
  assert.deepEqual((await context.request("GET", `${collection}/${secret.id}`)).body.data, secret);
  assert.deepEqual(
    context.secretDriver.calls.map((call) => call.operation),
    ["create", "delete", "create", "update"],
  );
  assert.deepEqual(
    auditSink.events
      .filter((event) => event.resource.kind === "secret")
      .map((event) => event.action),
    ["openclaw.secrets.create"],
  );
});
