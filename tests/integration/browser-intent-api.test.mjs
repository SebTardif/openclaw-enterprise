import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { signInToControllerApp } from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";

// Real Fastify admission, Better Auth sessions/keys, native IAM and memory state.
// Development=false exercises the production admission branch, not production
// composition, browser cookie delivery, PostgreSQL, ingress or a running workload.
const origin = "http://127.0.0.1";

async function fixture(t, developmentEnabled) {
  const installationId = `ins_${randomUUID()}`;
  const memoryDatabase = { user: [], account: [], session: [], verification: [], apikey: [] };
  const auth = createControllerAuth({
    installationId,
    mode: "development",
    baseURL: origin,
    secret: `test-secret-${randomUUID()}-${randomUUID()}`,
    secureCookies: false,
    memoryDatabase,
  });
  const email = `intent-${randomUUID()}@example.invalid`;
  const password = `test-password-${randomUUID()}`;
  const account = await auth.createAccount({ email, password });
  const seed = auth.principalSeed(account);
  const credentials = { auth, email, password, seed };
  const policy = {
    identities: [seed.principal],
    roles: [...seed.roles],
    bindings: [...seed.bindings],
    groups: [],
    memberships: [],
    restrictions: [],
  };
  const auditSink = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink });
  let controller;
  const options = {
    auth: credentials.auth,
    publicOrigin: origin,
    iamDriver: new NativeIAMDriver({ loadNativeIAMState: async () => policy }),
    auditSink,
    development: { enabled: developmentEnabled, installationId },
    configurationDriver: createTestConfigurationDriver(),
    computeDriver: createDevelopmentComputeDriver(),
    resolveHarness: resolveApprovedHarness,
    createController(installation) {
      controller = new OpenClawController(installation, { state });
      return controller;
    },
  };
  const app = createFastifyApp(options);
  t.after(() => app.close());
  const session = await signInToControllerApp(app, credentials);
  async function request(method, url, headers = { cookie: session.cookie, origin }, payload) {
    return app.inject({
      method,
      url,
      headers: { host: "127.0.0.1", ...headers },
      ...(payload === undefined ? {} : { payload }),
    });
  }
  async function create(url, payload) {
    const response = await request("POST", url, undefined, payload);
    assert.equal(response.statusCode, 201, response.body);
    return response.json().data;
  }
  await create("/installation/bootstrap", { name: "Browser intent test" });
  const namespace = await create("/namespaces", { name: "intent-test" });
  // Only admission is under test. Seed the supported ready Namespace state;
  // no fixture readiness response is claimed as real infrastructure evidence.
  await state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const configuration = await create(`/namespaces/${namespace.id}/configurations`, {
    kind: "agent",
    values: {},
  });
  const agent = await create(`/namespaces/${namespace.id}/agents`, {
    name: "intent-test",
    configurationId: configuration.id,
  });
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const principal = {
    kind: "service_principal",
    id: `sp_${randomUUID()}`,
    namespaceId: namespace.id,
  };
  policy.identities.push(principal);
  policy.roles.push({
    id: "deploy-automation",
    namespaceId: namespace.id,
    permissions: [
      { action: "deploy", resourceKind: "agent" },
      { action: "read", resourceKind: "configuration" },
      { action: "read", resourceKind: "agent" },
    ],
  });
  policy.bindings.push({
    id: "deploy-automation",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: principal.id,
    roleId: "deploy-automation",
  });
  const key = await credentials.auth.createServiceKey({ principal, name: "deploy-test" });
  async function recorded() {
    return {
      accounts: memoryDatabase.user.length,
      keys: memoryDatabase.apikey.length,
      revisions: await state.read((unit) => unit.revisions.listRevisions(namespace.id, agent.id)),
      operations: controller.pendingOperations(),
      successAudit: auditSink.events.filter((event) => event.outcome === "success"),
    };
  }
  return {
    app,
    request,
    session,
    path,
    key,
    recorded,
    state,
    policy,
    namespace,
    credentials,
    options,
    get controller() {
      return controller;
    },
  };
}

for (const developmentEnabled of [false, true]) {
  test(`browser intent guards actual API mutations with development=${developmentEnabled}`, async (t) => {
    const f = await fixture(t, developmentEnabled);
    await t.test(
      "missing, foreign, opaque and same-site origins cannot admit a deployment",
      async () => {
        const before = await f.recorded();
        for (const headers of [
          {},
          { "sec-fetch-site": "same-site" },
          { "sec-fetch-site": "same-origin" },
          { origin: "http://127.0.0.1:4444", "sec-fetch-site": "same-site" },
          { origin: "http://localhost" },
          { origin: "null" },
          { origin: origin + "/" },
          { origin, "sec-fetch-site": "cross-site" },
        ]) {
          const result = await f.request("POST", `${f.path}/deploy`, {
            cookie: f.session.cookie,
            ...headers,
          });
          assert.equal(result.statusCode, 403, result.body);
          assert.equal(result.json().error.code, "FORBIDDEN");
          assert.deepEqual(await f.recorded(), before);
          assert.equal(result.headers["cache-control"], "no-store");
          assert.equal(result.body.includes(f.session.cookie), false);
        }
      },
    );
    await t.test(
      "exact-origin cookie deployment persists its revision, work and success audit",
      async () => {
        const before = await f.recorded();
        const result = await f.request("POST", `${f.path}/deploy`);
        assert.equal(result.statusCode, 202, result.body);
        const after = await f.recorded();
        assert.equal(after.revisions.length, before.revisions.length + 1);
        assert.equal(after.operations.length, before.operations.length + 1);
        assert.equal(after.operations.at(-1).resourceId, result.json().data.id);
        assert.equal(after.successAudit.length, before.successAudit.length + 1);
      },
    );
    await t.test(
      "verified scoped key works without Origin, while invalid explicit keys cannot use cookies",
      async () => {
        const keyHeaders = { "x-api-key": f.key.key };
        assert.equal((await f.request("POST", `${f.path}/deploy`, keyHeaders)).statusCode, 202);
        assert.equal(
          (
            await f.request("POST", `${f.path}/deploy`, {
              ...keyHeaders,
              cookie: f.session.cookie,
              origin: "http://localhost",
            })
          ).statusCode,
          202,
        );
        const before = await f.recorded();
        for (const key of ["", "invalid-key", f.key.key + "tampered"]) {
          for (const extra of [{}, { origin }]) {
            const result = await f.request("POST", `${f.path}/deploy`, {
              cookie: f.session.cookie,
              "x-api-key": key,
              ...extra,
            });
            assert.equal(result.statusCode, 401, result.body);
            assert.deepEqual(await f.recorded(), before);
          }
        }
        // Authentication does not expand the key's exact Namespace or IAM rights.
        assert.equal(
          (await f.request("POST", "/namespaces", keyHeaders, { name: "foreign" })).statusCode,
          403,
        );
        assert.equal(
          (
            await f.request("POST", "/api/auth/service-keys", keyHeaders, {
              servicePrincipalId: f.key.servicePrincipalId,
              namespaceId: f.namespace.id,
              name: "forbidden",
            })
          ).statusCode,
          403,
        );
        assert.deepEqual(await f.recorded(), before);
      },
    );
    await t.test(
      "account and key mutations reject cookie requests before their effects",
      async () => {
        const before = await f.recorded();
        const headers = { cookie: f.session.cookie };
        const accountBody = {
          email: `denied-${randomUUID()}@example.invalid`,
          password: `test-password-${randomUUID()}`,
          roleId: f.credentials.seed.roles[0].id,
        };
        for (const [method, url, body] of [
          ["POST", "/api/auth/accounts", accountBody],
          [
            "POST",
            "/api/auth/service-keys",
            {
              servicePrincipalId: f.key.servicePrincipalId,
              namespaceId: f.namespace.id,
              name: "denied",
            },
          ],
          ["DELETE", `/api/auth/service-keys/${f.key.id}`],
          ["PATCH", f.path, { name: "denied" }],
        ])
          assert.equal((await f.request(method, url, headers, body)).statusCode, 403);
        assert.deepEqual(await f.recorded(), before);
        assert.ok(
          await f.credentials.auth.getServiceKey(f.key.id),
          "denied revoke must retain the key",
        );
        assert.equal((await f.request("GET", f.path, headers)).json().data.name, "intent-test");
      },
    );
    await t.test("ordinary reads and existing credential/proxy guards remain intact", async () => {
      const headers = { cookie: f.session.cookie };
      assert.equal((await f.request("GET", f.path, headers)).statusCode, 200);
      assert.equal(
        (await f.request("GET", "/api/auth/session", headers)).json().data.authenticated,
        true,
      );
      assert.equal((await f.request("GET", f.path, {})).statusCode, 401);
      assert.equal(
        (
          await f.request("POST", `${f.path}/deploy`, {
            ...headers,
            origin,
            authorization: "Bearer invalid",
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await f.request("POST", `${f.path}/deploy`, {
            ...headers,
            origin,
            "x-forwarded-host": "127.0.0.1",
          })
        ).statusCode,
        403,
      );
      if (developmentEnabled)
        assert.equal(
          (
            await f.request("POST", `${f.path}/deploy`, {
              ...headers,
              origin,
              host: "untrusted.example.invalid",
            })
          ).statusCode,
          403,
        );
    });
    await t.test(
      "missing configured public origin fails closed for cookies but leaves reads available",
      async () => {
        const { publicOrigin: unused, createController: unusedFactory, ...rest } = f.options;
        const app = createFastifyApp({ ...rest, controller: f.controller });
        try {
          const before = await f.recorded();
          const result = await app.inject({
            method: "POST",
            url: `${f.path}/deploy`,
            headers: { cookie: f.session.cookie, origin },
          });
          assert.equal(result.statusCode, 503, result.body);
          assert.deepEqual(await f.recorded(), before);
          assert.equal(
            (
              await app.inject({
                method: "GET",
                url: f.path,
                headers: { cookie: f.session.cookie },
              })
            ).statusCode,
            200,
          );
        } finally {
          await app.close();
        }
      },
    );
  });
}
