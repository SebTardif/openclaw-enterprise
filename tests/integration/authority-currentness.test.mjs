import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";

// This store controls dependency timing only. NativeIAMDriver performs every
// identity lookup, policy evaluation, and evidence construction in these cases.
class PolicyStore {
  constructor(state) {
    this.state = state;
    this.pending = undefined;
    this.failure = undefined;
  }

  pauseAfter(loads) {
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    this.pending = { loads, entered, released };
    return { entered: entered.promise, release: () => released.resolve() };
  }

  async loadNativeIAMState() {
    const pending = this.pending;
    if (pending && --pending.loads === 0) {
      this.pending = undefined;
      pending.entered.resolve();
      await pending.released.promise;
    }
    if (this.failure) throw this.failure;
    return this.state;
  }
}

async function fixture(t) {
  const installationId = `ins_${randomUUID()}`;
  const credentials = await createTestAuthPrincipal({ installationId });
  const principal = credentials.seed.principal;
  const policy = {
    identities: [principal],
    groups: [],
    memberships: [],
    roles: [...credentials.seed.roles],
    bindings: [...credentials.seed.bindings],
    restrictions: [],
  };
  const store = new PolicyStore(policy);
  const iam = new NativeIAMDriver(store, { id: "iam-currentness" });
  const audit = new InMemoryAuditSink();
  const controller = new OpenClawController(
    { id: installationId, name: "Authority currentness", createdAt: new Date().toISOString() },
    { state: new InMemoryPlatformState({ auditSink: audit }) },
  );
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  // Normal controller admission creates provisioning Namespaces. Reads do not
  // require a Compute backend or invent a ready runtime lifecycle.
  const namespaceA = await controller.createNamespace(principal.id, { name: "Tenant A" });
  const namespaceB = await controller.createNamespace(principal.id, { name: "Tenant B" });
  const app = createFastifyApp({
    controller,
    iamDriver: iam,
    auditSink: audit,
    resolveHarness: resolveApprovedHarness,
    development: { enabled: true, installationId },
    publicOrigin: "http://127.0.0.1",
    auth: credentials.auth,
  });
  t.after(() => app.close());
  const session = await signInToControllerApp(app, credentials);
  async function get(path) {
    const response = await app.inject({
      method: "GET",
      url: path,
      headers: { ...authenticatedHeaders(session), host: "127.0.0.1" },
      remoteAddress: "127.0.0.1",
    });
    const body = response.json();
    assert.match(body.meta.requestId, /^req_/);
    assert.equal(response.headers["x-request-id"], body.meta.requestId);
    return { response, body };
  }
  return { controller, principal, iam, store, policy, audit, namespaceA, namespaceB, get };
}

function dependencyFailure(result) {
  assert.equal(result.response.statusCode, 503);
  assert.deepEqual(result.body.error, {
    code: "DEPENDENCY_UNAVAILABLE",
    message: "A required platform dependency is unavailable.",
  });
  assert.equal(Object.hasOwn(result.body, "data"), false);
}

test("Fastify uses native exact Namespace grants and attributes cross-Namespace denial", async (t) => {
  const f = await fixture(t);
  f.policy.roles = [
    {
      id: "role-exact-namespace",
      namespaceId: f.namespaceA.id,
      permissions: [{ action: "read", resourceKind: "namespace" }],
    },
  ];
  f.policy.bindings = [
    {
      id: "binding-exact-namespace",
      namespaceId: f.namespaceA.id,
      subjectKind: "identity",
      subjectId: f.principal.id,
      roleId: "role-exact-namespace",
      resourceKind: "namespace",
      resourceId: f.namespaceA.id,
    },
  ];
  const allowed = await f.get(`/namespaces/${f.namespaceA.id}`);
  assert.equal(allowed.response.statusCode, 200);
  assert.deepEqual(allowed.body.data, f.namespaceA);
  const denied = await f.get(`/namespaces/${f.namespaceB.id}`);
  assert.equal(denied.response.statusCode, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");
  const event = f.audit.events.at(-1);
  assert.equal(event.kind, "authorization_denial");
  assert.equal(event.outcome, "denied");
  assert.equal(event.requestId, denied.body.meta.requestId);
  assert.equal(event.iamDriverId, f.iam.id);
  assert.equal(event.actor.principalId, f.principal.id);
  assert.deepEqual(event.authorization, {
    principalId: f.principal.id,
    action: "read",
    resource: { kind: "namespace", id: f.namespaceB.id, namespaceId: f.namespaceB.id },
  });
  assert.equal(event.details.iamEvidence.identityId, f.principal.id);
  assert.deepEqual(event.details.iamEvidence.bindingIds, []);
  const listed = await f.get("/namespaces");
  assert.equal(listed.response.statusCode, 200);
  assert.deepEqual(listed.body.data, [f.namespaceA]);
});

test("Fastify sanitizes a native policy-store outage during authorization", async (t) => {
  const f = await fixture(t);
  // The first load resolves the authenticated identity; the second is the
  // controller's native authorization, whose dependency becomes unavailable.
  const pause = f.store.pauseAfter(2);
  const request = f.get(`/namespaces/${f.namespaceA.id}`);
  await pause.entered;
  f.store.failure = new Error("private-native-policy-store-connection-detail");
  pause.release();
  dependencyFailure(await request);
  assert.equal(JSON.stringify(f.audit.events).includes(f.store.failure.message), false);
  f.store.failure = undefined;
  assert.equal((await f.get(`/namespaces/${f.namespaceA.id}`)).response.statusCode, 200);
});

for (const change of ["replace selected object", "mutate selected identity"]) {
  test(`Fastify rejects stale native authorization after ${change} during policy await`, async (t) => {
    const f = await fixture(t);
    const pause = f.store.pauseAfter(2);
    const operationCount = f.controller.pendingOperations().length;
    const auditCount = f.audit.events.length;
    const request = f.get(`/namespaces/${f.namespaceA.id}`);
    await pause.entered;
    if (change === "replace selected object") {
      const replacement = new NativeIAMDriver(f.store, { id: "iam-replacement" });
      f.controller.registerDriver(replacement);
      f.controller.selectDriver("iam", replacement.id);
    } else {
      // Driver identity is a third-party object property at runtime. Registry
      // snapshots must reject its drift even if native IAM returns the new ID.
      f.iam.id = "iam-mutated-during-policy-read";
    }
    pause.release();
    dependencyFailure(await request);
    assert.equal(f.controller.pendingOperations().length, operationCount);
    assert.equal(f.audit.events.length, auditCount);
  });
}
