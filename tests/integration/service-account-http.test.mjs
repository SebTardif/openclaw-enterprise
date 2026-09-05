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

async function fixture({ permissions, auditSink = new InMemoryAuditSink(), managed = false } = {}) {
  const auth = await createTestAuthPrincipal({ name: "ServiceAccount HTTP Administrator" });
  const principal = auth.seed.principal;
  const role = {
    id: "role-service-account-http",
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
          id: "binding-service-account-http",
          subjectKind: "identity",
          subjectId: principal.id,
          roleId: role.id,
        },
      ],
      restrictions: [],
    }),
  });
  const externalAccounts = new Set();
  const externalCredentials = new Set();
  let controller;
  // createControllerApp dispatches Fetch requests through the genuine Fastify.inject adapter.
  // Only external storage is passive; session admission, IAM, OCC, and transactions are real.
  const app = createControllerApp({
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: new InMemoryPlatformState({ auditSink }),
        recordOperations: false,
      });
      if (managed) {
        // The passive Driver owns only external effects; real OCC coordinates rollback.
        const driver = {
          id: "service-account-http",
          capability: "service_account",
          implementation: "passive-service-account-http",
          async create(account) {
            externalAccounts.add(account.id);
            controller.registerRollback(async () => {
              externalAccounts.delete(account.id);
            });
          },
          async createCredential(account) {
            externalCredentials.add(account.id);
            controller.registerRollback(async () => {
              externalCredentials.delete(account.id);
            });
            return { kind: "access_token", secretRef: { name: "managed-account", key: "token" } };
          },
          async delete(account) {
            externalAccounts.delete(account.id);
            externalCredentials.delete(account.id);
          },
        };
        controller.registerDriver(driver);
        controller.selectDriver(driver.capability, driver.id);
      }
      return controller;
    },
    iamDriver,
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
    externalAccounts,
    externalCredentials,
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
    body: { name: "ServiceAccount HTTP installation" },
  });
  assert.equal(installed.status, 201, JSON.stringify(installed.body));
  const namespace = await context.request("POST", "/namespaces", {
    body: { name: "ServiceAccount HTTP tenant" },
  });
  assert.equal(namespace.status, 201, JSON.stringify(namespace.body));
  return `/namespaces/${namespace.body.data.id}/service-accounts`;
}

function assertFailure(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
}

const manualCredential = { kind: "api_key", secretRef: { name: "manual-account", key: "token" } };

test("ServiceAccount HTTP admits sessions before lazy service resolution and rejects strict body violations", async () => {
  const f = await fixture();
  const unknown = `/namespaces/ns_${randomUUID()}/service-accounts/sa_${randomUUID()}`;
  assertFailure(await f.request("GET", unknown, { authenticated: false }), 401, "UNAUTHENTICATED");
  assertFailure(await f.request("GET", unknown), 404, "NOT_FOUND");
  assert.equal(f.controller, undefined);
  const collection = await bootstrap(f);
  for (const body of [
    {},
    { name: "invalid", providerId: "caller-provider" },
    { name: "invalid", namespaceId: `ns_${randomUUID()}` },
  ]) {
    assertFailure(await f.request("POST", collection, { body }), 400, "INVALID_REQUEST");
  }
  const created = await f.request("POST", collection, { body: { name: "manual" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pathname = `${collection}/${created.body.data.id}`;
  for (const body of [
    { ...manualCredential, kind: "access_token" },
    { ...manualCredential, accessToken: "unexpected-value" },
    {},
  ]) {
    assertFailure(
      await f.request("PATCH", `${pathname}/credential`, { body }),
      400,
      "INVALID_REQUEST",
    );
  }
  assertFailure(
    await f.request("POST", `${pathname}/credentials`, { body: { providerId: "unexpected" } }),
    400,
    "INVALID_REQUEST",
  );
  assertFailure(await f.request("GET", pathname, { authenticated: false }), 401, "UNAUTHENTICATED");
});

test("ServiceAccount HTTP manual CRUD preserves exact DTOs and attributable audit envelopes", async () => {
  const f = await fixture();
  const collection = await bootstrap(f);
  const created = await f.request("POST", collection, { body: { name: "manual-account" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const account = created.body.data;
  assert.match(account.id, /^sa_[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(account).sort(), ["id", "name", "namespaceId"]);
  const pathname = `${collection}/${account.id}`;
  const updated = await f.request("PATCH", `${pathname}/credential`, { body: manualCredential });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body.data, { ...account, credential: manualCredential });
  assert.deepEqual((await f.request("GET", pathname)).body.data, updated.body.data);
  assert.deepEqual((await f.request("GET", collection)).body.data, [updated.body.data]);
  const deleted = await f.request("DELETE", pathname);
  assert.equal(deleted.status, 204);
  assert.equal(deleted.body, undefined);
  assertFailure(await f.request("GET", pathname), 404, "NOT_FOUND");
  const events = f.auditSink.events.filter((event) => event.resource.kind === "service_account");
  assert.deepEqual(
    events.map((event) => event.action),
    [
      "openclaw.service_accounts.create",
      "openclaw.service_accounts.update",
      "openclaw.service_accounts.delete",
    ],
  );
  for (const [index, response] of [created, updated, deleted].entries()) {
    assert.equal(events[index].kind, "mutation");
    assert.equal(events[index].outcome, "success");
    assert.equal(events[index].actorId, f.principal.id);
    assert.equal(events[index].requestId, response.headers.get("x-request-id"));
    assert.deepEqual(events[index].resource, {
      kind: "service_account",
      id: account.id,
      namespaceId: account.namespaceId,
    });
  }
});

test("ServiceAccount HTTP managed credential issuance preserves reference-only responses and conflicts", async () => {
  const f = await fixture({ managed: true });
  const collection = await bootstrap(f);
  const created = await f.request("POST", collection, { body: { name: "managed-account" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const account = created.body.data;
  const pathname = `${collection}/${account.id}`;
  const issued = await f.request("POST", `${pathname}/credentials`, { body: {} });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  assert.deepEqual(issued.body.data, {
    ...account,
    credential: { kind: "access_token", secretRef: { name: "managed-account", key: "token" } },
  });
  assert.deepEqual((await f.request("GET", pathname)).body.data, issued.body.data);
  assert.deepEqual((await f.request("GET", collection)).body.data, [issued.body.data]);
  assertFailure(
    await f.request("POST", `${pathname}/credentials`, { body: {} }),
    409,
    "RESOURCE_CONFLICT",
  );
  assertFailure(
    await f.request("PATCH", `${pathname}/credential`, { body: manualCredential }),
    409,
    "RESOURCE_CONFLICT",
  );
  assert.equal(f.externalCredentials.has(account.id), true);
  assert.equal((await f.request("DELETE", pathname)).status, 204);
  assert.equal(f.externalAccounts.has(account.id), false);
  assert.equal(f.externalCredentials.has(account.id), false);
  assert.deepEqual(
    f.auditSink.events
      .filter((event) => event.resource.kind === "service_account")
      .map((event) => event.action),
    [
      "openclaw.service_accounts.create",
      "openclaw.service_accounts.credentials.create",
      "openclaw.service_accounts.delete",
    ],
  );
});

test("ServiceAccount HTTP exact authorization denials are audited and foreign scope is rejected", async () => {
  const restricted = await fixture({
    permissions: [
      { action: "administer", resourceKind: "installation" },
      { action: "create", resourceKind: "namespace" },
      { action: "create", resourceKind: "service_account" },
    ],
  });
  const collection = await bootstrap(restricted);
  const created = await restricted.request("POST", collection, {
    body: { name: "restricted-account" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const account = created.body.data;
  for (const [method, suffix, body, action] of [
    ["GET", "", undefined, "read"],
    ["PATCH", "/credential", manualCredential, "update"],
    ["POST", "/credentials", {}, "update"],
    ["DELETE", "", undefined, "delete"],
  ]) {
    const denied = await restricted.request(method, `${collection}/${account.id}${suffix}`, {
      body,
    });
    assertFailure(denied, 403, "FORBIDDEN");
    const event = restricted.auditSink.events.at(-1);
    assert.equal(event.kind, "authorization_denial");
    assert.equal(event.actorId, restricted.principal.id);
    assert.equal(event.authorization.action, action);
    assert.equal(event.requestId, denied.headers.get("x-request-id"));
    assert.deepEqual(event.resource, {
      kind: "service_account",
      id: account.id,
      namespaceId: account.namespaceId,
    });
  }
  const f = await fixture();
  const original = await bootstrap(f);
  const own = await f.request("POST", original, { body: { name: "exact-account" } });
  const foreign = await f.request("POST", "/namespaces", { body: { name: "foreign-tenant" } });
  const foreignPath = `/namespaces/${foreign.body.data.id}/service-accounts/${own.body.data.id}`;
  // A second real Namespace exists, so these failures prove exact account ownership.
  for (const [method, suffix, body] of [
    ["GET", "", undefined],
    ["PATCH", "/credential", manualCredential],
    ["POST", "/credentials", {}],
    ["DELETE", "", undefined],
  ]) {
    assertFailure(await f.request(method, `${foreignPath}${suffix}`, { body }), 404, "NOT_FOUND");
  }
  assert.deepEqual(
    (await f.request("GET", `${original}/${own.body.data.id}`)).body.data,
    own.body.data,
  );
});

test("ServiceAccount HTTP required audit failure rolls back account and credential mutations", async () => {
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
  const f = await fixture({ auditSink, managed: true });
  const collection = await bootstrap(f);
  auditSink.rejectedAction = "openclaw.service_accounts.create";
  assertFailure(
    await f.request("POST", collection, { body: { name: "aborted-account" } }),
    503,
    "DEPENDENCY_UNAVAILABLE",
  );
  const rejected = auditSink.rejectedResource;
  assert.equal(f.externalAccounts.has(rejected.id), false);
  assertFailure(await f.request("GET", `${collection}/${rejected.id}`), 404, "NOT_FOUND");
  auditSink.rejectedAction = undefined;
  const created = await f.request("POST", collection, { body: { name: "retained-account" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const account = created.body.data;
  auditSink.rejectedAction = "openclaw.service_accounts.credentials.create";
  assertFailure(
    await f.request("POST", `${collection}/${account.id}/credentials`, { body: {} }),
    503,
    "DEPENDENCY_UNAVAILABLE",
  );
  assert.equal(f.externalAccounts.has(account.id), true);
  assert.equal(f.externalCredentials.has(account.id), false);
  assert.deepEqual((await f.request("GET", `${collection}/${account.id}`)).body.data, account);
});
