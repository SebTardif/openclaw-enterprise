import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { signInToControllerApp } from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";

// Actual Fastify injection, Better Auth sessions/keys, NativeIAMDriver and memory
// transactions. Ready resources and IAM grants are preprovisioned test policy;
// this does not claim runtime, live channel verification or grant administration.
test("channel binding administration uses authenticated exact-scope controller routes", async (t) => {
  const installationId = `ins_${randomUUID()}`;
  const memoryDatabase = { user: [], account: [], session: [], verification: [], apikey: [] };
  const auth = createControllerAuth({
    mode: "development",
    installationId,
    baseURL: "http://127.0.0.1",
    secret: `test-secret-${randomUUID()}`,
    secureCookies: false,
    memoryDatabase,
  });
  const credentials = {
    email: `admin-${randomUUID()}@example.invalid`,
    password: `test-password-${randomUUID()}`,
  };
  const account = await auth.createAccount(credentials);
  const seed = auth.principalSeed(account);
  const humanCredentials = {
    email: `human-${randomUUID()}@example.invalid`,
    password: `test-password-${randomUUID()}`,
  };
  const humanAccount = await auth.createAccount(humanCredentials);
  const human = auth.principalSeed(humanAccount).principal;
  const otherHuman = {
    kind: "principal",
    id: `prn_${randomUUID()}`,
    issuer: "test-directory",
    subject: "second-human",
  };
  const policy = {
    identities: [seed.principal, human, otherHuman],
    roles: [...seed.roles],
    bindings: [...seed.bindings],
    groups: [],
    memberships: [],
    restrictions: [],
  };
  const iamDriver = new NativeIAMDriver({ loadNativeIAMState: async () => policy });
  const auditSink = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink });
  let controller;
  const app = createFastifyApp({
    publicOrigin: "http://127.0.0.1",
    auth,
    iamDriver,
    auditSink,
    development: { enabled: true, installationId },
    configurationDriver: createTestConfigurationDriver(),
    createController(installation) {
      controller = new OpenClawController(installation, { state, recordOperations: false });
      return controller;
    },
  });
  t.after(() => app.close());
  await app.ready();
  const session = await signInToControllerApp(app, credentials);
  const humanSession = await signInToControllerApp(app, humanCredentials);
  const cookieHeaders = { cookie: session.cookie, origin: "http://127.0.0.1" };
  async function request(method, url, body, headers = cookieHeaders) {
    const res = await app.inject({
      method,
      url,
      headers: { host: "127.0.0.1", ...headers },
      ...(body === undefined ? {} : { payload: body }),
    });
    const result = res.body.length ? res.json() : {};
    assert.equal(res.headers["cache-control"], "no-store");
    assert.match(result.meta.requestId, /^req_/);
    return { status: res.statusCode, ...result };
  }
  const bootstrapped = await request("POST", "/installation/bootstrap", {
    name: "Channel bindings test",
  });
  assert.equal(bootstrapped.status, 201, JSON.stringify(bootstrapped));
  const namespaceId = `ns_${randomUUID()}`,
    agentId = `agt_${randomUUID()}`,
    configurationId = `cfg_${randomUUID()}`;
  // A ready tenant and undeployed saved Agent are valid existing targets. The
  // binding service requires ownership/permission, not a manufactured runtime.
  await state.transact(async (tx) => {
    const createdAt = new Date().toISOString();
    await tx.namespaces.createNamespace({
      id: namespaceId,
      name: "channel-tenant",
      status: "ready",
      createdAt,
    });
    await tx.configurations.createConfiguration({
      id: configurationId,
      namespaceId,
      kind: "agent",
      generation: 1,
      createdAt,
    });
    await tx.agents.createAgent({
      id: agentId,
      namespaceId,
      name: "channel-agent",
      configurationId,
      providerId: null,
      executionMode: "embedded",
      createdAt,
    });
  });
  const root = "/api/channel-installations";
  const appBody = { platform: "slack", providerTenantRef: "T α", recipientAppRef: "A/one" };
  let channelApp, binding, route;
  await t.test("closed creation, exact Unicode references and parent-scoped reads", async () => {
    const created = await request("POST", root, appBody);
    assert.equal(created.status, 201, JSON.stringify(created));
    channelApp = created.data;
    assert.equal(channelApp.version, 1);
    assert.equal(channelApp.status, "enabled");
    assert.equal(channelApp.installationId, installationId);
    assert.equal(channelApp.providerTenantRef, appBody.providerTenantRef);
    assert.equal(channelApp.createdBy, seed.principal.id);
    assert.equal((await request("POST", root, appBody)).status, 409);
    assert.deepEqual((await request("GET", `${root}/${channelApp.id}`)).data, channelApp);
    for (const principal of [human, otherHuman]) {
      const response = await request("POST", `${root}/${channelApp.id}/human-bindings`, {
        providerSubjectRef: principal.subject,
        principal: { issuer: principal.issuer, subject: principal.subject },
      });
      assert.equal(response.status, 201, JSON.stringify(response));
      assert.equal(response.data.principalId, principal.id);
      if (principal === human) binding = response.data;
    }
    assert.deepEqual(
      (await request("GET", `${root}/${channelApp.id}/human-bindings/${binding.id}`)).data,
      binding,
    );
    const createdRoute = await request("POST", `${root}/${channelApp.id}/agent-bindings`, {
      channelRef: "C exact",
      scopeKind: "slack-private-channel",
      namespaceId,
      agentId,
    });
    assert.equal(createdRoute.status, 201, JSON.stringify(createdRoute));
    route = createdRoute.data;
    assert.equal(
      (await request("GET", `${root}/${channelApp.id}/agent-bindings/${route.id}`)).data.agentId,
      agentId,
    );
    const other = await request("POST", root, { ...appBody, recipientAppRef: "A/two" });
    assert.equal(other.status, 201);
    assert.equal(
      (await request("GET", `${root}/${other.data.id}/human-bindings/${binding.id}`)).status,
      404,
    );
    assert.equal(
      (await request("GET", `${root}/${other.data.id}/agent-bindings/${route.id}`)).status,
      404,
    );
    const sameSubject = await request("POST", `${root}/${other.data.id}/human-bindings`, {
      providerSubjectRef: human.subject,
      principal: { issuer: human.issuer, subject: human.subject },
    });
    assert.equal(sameSubject.status, 201);
    assert.notEqual(sameSubject.data.id, binding.id);
  });
  await t.test("deterministic pagination and cursor query binding", async () => {
    const first = await request("GET", `${root}?limit=1`);
    assert.equal(first.status, 200);
    assert.equal(first.data.items.length, 1);
    assert.ok(first.data.nextCursor);
    const second = await request("GET", `${root}?limit=1&cursor=${first.data.nextCursor}`);
    assert.equal(second.status, 200);
    assert.equal(second.data.items.length, 1);
    assert.notEqual(second.data.items[0].id, first.data.items[0].id);
    assert.equal(
      (
        await request(
          "GET",
          `${root}/${channelApp.id}/human-bindings?cursor=${first.data.nextCursor}`,
        )
      ).status,
      400,
    );
    for (const query of [
      "limit=0",
      "limit=101",
      "limit=1.5",
      "limit=01",
      "cursor=bad!",
      "verified=true",
    ])
      assert.equal((await request("GET", `${root}?${query}`)).status, 400);
  });
  await t.test(
    "malformed, fabricated authority and immutable field changes fail closed",
    async () => {
      for (const extra of [
        { verified: true },
        { audience: ["all"] },
        { installationId },
        { id: `chi_${randomUUID()}` },
        { status: "enabled" },
      ])
        assert.equal((await request("POST", root, { ...appBody, ...extra })).status, 400);
      for (const ref of ["", "bad\nref", "bad\u0085ref", "\ud800", "é".repeat(513)])
        assert.equal(
          (await request("POST", root, { ...appBody, recipientAppRef: ref })).status,
          400,
        );
      for (const patch of [
        { expectedVersion: 1, status: "disabled", recipientAppRef: "replacement" },
        { expectedVersion: 0, status: "disabled" },
        { expectedVersion: Number.MAX_SAFE_INTEGER + 1, status: "disabled" },
      ])
        assert.equal((await request("PATCH", `${root}/${channelApp.id}`, patch)).status, 400);
      assert.equal(
        (
          await request("POST", `${root}/${channelApp.id}/human-bindings`, {
            providerSubjectRef: "unknown",
            principal: { issuer: "unknown", subject: "unknown" },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("POST", `${root}/${channelApp.id}/human-bindings`, {
            providerSubjectRef: "forged",
            principal: { issuer: human.issuer, subject: human.subject, id: human.id },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("POST", `${root}/${channelApp.id}/agent-bindings`, {
            channelRef: "cross-platform",
            scopeKind: "msteams-standard-channel",
            namespaceId,
            agentId,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("POST", `${root}/${channelApp.id}/agent-bindings`, {
            channelRef: "wrong-owner",
            scopeKind: "slack-private-channel",
            namespaceId: `ns_${randomUUID()}`,
            agentId,
          })
        ).status,
        404,
      );
    },
  );
  await t.test("session/key admission cannot fall back or widen fixed scope", async () => {
    for (const headers of [
      {},
      { cookie: "better-auth.session_token=expired" },
      { "x-principal-id": seed.principal.id },
      { authorization: "Bearer forged" },
      { "x-api-key": "forged", ...cookieHeaders },
    ])
      assert.equal((await request("GET", root, undefined, headers)).status, 401);
    assert.equal(
      (
        await request("GET", root, undefined, {
          ...cookieHeaders,
          "x-forwarded-for": "203.0.113.7",
        })
      ).status,
      403,
    );
    assert.equal(
      (await request("GET", root, undefined, { cookie: humanSession.cookie })).status,
      403,
    );
    assert.equal(
      (
        await request(
          "POST",
          root,
          { ...appBody, recipientAppRef: "bad-origin" },
          { ...cookieHeaders, origin: "https://untrusted.invalid" },
        )
      ).status,
      403,
    );
    const service = { kind: "service_principal", id: `sp_${randomUUID()}` };
    const scopedService = { kind: "service_principal", id: `sp_${randomUUID()}`, namespaceId };
    const agentService = {
      kind: "service_principal",
      id: `sp_${randomUUID()}`,
      namespaceId,
      agentId,
    };
    for (const identity of [service, scopedService, agentService]) {
      policy.identities.push(identity);
      policy.bindings.push({
        id: `binding-${randomUUID()}`,
        subjectKind: "identity",
        subjectId: identity.id,
        roleId: seed.roles[0].id,
        ...(identity.namespaceId ? { namespaceId } : {}),
      });
    }
    const issued = await request("POST", "/api/auth/service-keys", {
      servicePrincipalId: service.id,
      name: "installation automation",
    });
    assert.equal(issued.status, 201, JSON.stringify(issued));
    const keyHeaders = { "x-api-key": issued.data.key };
    assert.equal((await request("GET", root, undefined, keyHeaders)).status, 200);
    assert.equal(
      (await request("POST", root, { ...appBody, recipientAppRef: "service-key-app" }, keyHeaders))
        .status,
      201,
    );
    const scoped = await request("POST", "/api/auth/service-keys", {
      servicePrincipalId: scopedService.id,
      namespaceId,
      name: "namespace automation",
    });
    assert.equal(scoped.status, 201);
    assert.equal(
      (await request("GET", root, undefined, { "x-api-key": scoped.data.key })).status,
      403,
    );
    const agentKey = await request("POST", "/api/auth/service-keys", {
      servicePrincipalId: agentService.id,
      namespaceId,
      name: "agent automation",
    });
    assert.equal(agentKey.status, 400);
    assert.equal((await request("DELETE", `/api/auth/service-keys/${issued.data.id}`)).status, 200);
    assert.equal(
      (await request("GET", root, undefined, { ...cookieHeaders, ...keyHeaders })).status,
      401,
    );
  });
  await t.test("CAS status, disabled recovery and retained identities", async () => {
    const path = `${root}/${channelApp.id}`;
    const disabled = await request("PATCH", path, { expectedVersion: 1, status: "disabled" });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.data.version, 2);
    assert.equal(
      (await request("PATCH", path, { expectedVersion: 1, status: "enabled" })).status,
      409,
    );
    const eventCount = auditSink.events.length;
    assert.equal(
      (await request("PATCH", path, { expectedVersion: 2, status: "disabled" })).data.version,
      2,
    );
    assert.equal(auditSink.events.length, eventCount, "same-state status is not a second mutation");
    assert.equal((await request("POST", root, appBody)).status, 409);
    assert.equal(
      (
        await request("POST", `${path}/human-bindings`, {
          providerSubjectRef: "new",
          principal: { issuer: human.issuer, subject: human.subject },
        })
      ).status,
      409,
    );
    assert.equal((await request("GET", `${path}/human-bindings/${binding.id}`)).status, 200);
    assert.equal(
      (await request("PATCH", path, { expectedVersion: 2, status: "enabled" })).data.version,
      3,
    );
    // Disappearance of the external human must not block administrative disable.
    policy.identities.splice(policy.identities.indexOf(human), 1);
    assert.equal(
      (
        await request("PATCH", `${path}/human-bindings/${binding.id}`, {
          expectedVersion: 1,
          status: "disabled",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("PATCH", `${path}/human-bindings/${binding.id}`, {
          expectedVersion: 2,
          status: "enabled",
        })
      ).status,
      400,
    );
    policy.identities.push(human);
    assert.equal(
      (
        await request("PATCH", `${path}/human-bindings/${binding.id}`, {
          expectedVersion: 2,
          status: "enabled",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("PATCH", `${path}/agent-bindings/${route.id}`, {
          expectedVersion: 1,
          status: "disabled",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("PATCH", `${path}/agent-bindings/${route.id}`, {
          expectedVersion: 2,
          status: "enabled",
        })
      ).status,
      200,
    );
    assert.equal((await request("GET", `${path}/human-bindings`)).data.items.length, 2);
    assert.equal((await request("GET", `${path}/agent-bindings`)).data.items.length, 1);
  });
  await t.test(
    "current administrator Agent permissions are independent of Installation administration",
    async () => {
      const adminRole = policy.roles[0];
      const operate = adminRole.permissions.findIndex(
        (p) => p.action === "operate" && p.resourceKind === "agent",
      );
      const permission = adminRole.permissions.splice(operate, 1)[0];
      assert.equal((await request("GET", root)).status, 200);
      assert.equal(
        (
          await request("POST", `${root}/${channelApp.id}/agent-bindings`, {
            channelRef: "no-operate",
            scopeKind: "slack-private-channel",
            namespaceId,
            agentId,
          })
        ).status,
        403,
      );
      adminRole.permissions.push(permission);
      assert.equal(
        (
          await request("POST", `${root}/${channelApp.id}/agent-bindings`, {
            channelRef: "no-operate",
            scopeKind: "slack-private-channel",
            namespaceId,
            agentId,
          })
        ).status,
        201,
      );
      const evidence = JSON.stringify(auditSink.events);
      assert.ok(!evidence.includes(credentials.password));
      assert.ok(!evidence.includes(session.cookie));
      assert.ok(controller, "the actual controller owns the persisted records");
    },
  );
  await t.test("a genuinely expired stored session cannot enumerate binding metadata", async () => {
    // Expire the issued session through the actual Better Auth adapter. This
    // models stored expiry without replacing credential verification or IAM.
    const stored = memoryDatabase.session.find((entry) => entry.userId === account.id);
    assert.ok(stored);
    const authContext = await auth.auth.$context;
    await authContext.adapter.update({
      model: "session",
      where: [{ field: "id", value: stored.id }],
      update: { expiresAt: new Date(Date.now() - 1000) },
    });
    assert.equal((await request("GET", root)).status, 401);
  });
});
