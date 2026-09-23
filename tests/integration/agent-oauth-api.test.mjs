import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { credential, envelope, method } from "../helpers/agent-oauth-custody.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

async function setup(t) {
  const audit = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink: audit });
  const storage = createTestSecretDriver();
  const references = new Map();
  const secretDriver = {
    ...storage,
    async stage(identity, value) {
      const reference = await storage.create(identity, value);
      references.set(identity.id, reference);
      return reference;
    },
    async findStaged(identity) {
      return references.get(identity.id);
    },
  };
  const f = await createConsoleAppFixture(t, {
    state,
    secretDriver,
    providers: [],
    publicOrigin: true,
  });
  await f.bootstrap();
  const namespace = await f.createNamespace("OAuth API", { ready: true });
  const selected = await f.request("POST", `/namespaces/${namespace.id}/provider-connections`, {
    body: { name: "OpenAI OAuth", providerId: "openai", authMethodId: "device-code" },
  });
  assert.equal(selected.status, 201);
  const agent = await f.createAgent(
    namespace.id,
    "OAuth Agent",
    {},
    {
      harnessAuth: { method: "provider_connection", connectionId: selected.data.id },
    },
  );
  const actorId = f.policy.identities[0].id;
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/oauth`;
  const begin = (generation = 0) =>
    f.controller.agentOAuth.begin(
      actorId,
      namespace.id,
      agent.id,
      method,
      generation,
      selected.data.id,
    );
  const latest = () => state.read((view) => view.agentOAuth.latest(namespace.id, agent.id));
  const cancel = (attempt, options = {}) =>
    f.request("POST", `${path}/attempts/${attempt.attemptId}/cancel`, {
      headers: { origin: f.origin },
      body: { connectionId: attempt.connectionId, generation: attempt.generation },
      ...options,
    });
  return { ...f, state, audit, namespace, agent, actorId, path, begin, latest, cancel };
}

test("OAuth HTTP status and cancellation expose only redacted custody metadata", async (t) => {
  const f = await setup(t);
  const empty = await f.request("GET", f.path);
  assert.equal(empty.status, 200);
  assert.equal(empty.data, null);
  const attempt = await f.begin();
  const acquisition = await f.controller.agentOAuth.acquisition(
    f.actorId,
    f.namespace.id,
    f.agent.id,
    attempt,
  );
  const authenticated = await acquisition.stage(envelope(attempt));
  const status = await f.request("GET", f.path);
  assert.equal(status.status, 200);
  assert.deepEqual(status.data, authenticated);
  assert.deepEqual(Object.keys(status.data).sort(), [
    "attemptId",
    "connectionId",
    "deadlineAt",
    "failureCode",
    "generation",
    "methodId",
    "phase",
    "profileId",
    "providerConnectionId",
    "providerId",
  ]);
  const cancelled = await f.cancel(attempt);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.phase, "cancelled");
  assert.deepEqual((await f.cancel(attempt)).data, cancelled.data);
  assert.ok((await f.latest()).stagedSecret, "cancellation retains cleanup ownership");
  const mutations = f.audit.events.filter(
    (event) => event.action === "openclaw.agents.oauth.cancel",
  );
  assert.equal(mutations.length, 2);
  assert.equal(mutations[0].resource.id, f.agent.id);
  const publicText = JSON.stringify([status.body, cancelled.body, f.audit.events]);
  assert.doesNotMatch(
    publicText,
    /backendRef|secretIdentity|stagedSecret|secretDriverId|storageUid/,
  );
  for (const secret of [
    credential.access,
    credential.refresh,
    credential.idToken,
    credential.accountId,
  ]) {
    assert.equal(publicText.includes(secret), false);
  }
});

test("OAuth cancellation binds actor, Namespace, Agent, connection, attempt, and generation", async (t) => {
  const f = await setup(t);
  const attempt = await f.begin();
  const other = await f.createAccountWithPolicy("oauth-admin", (principal) => {
    f.policy.bindings.push({
      id: `other-admin-${randomUUID()}`,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: f.policy.roles[0].id,
    });
  });
  const session = await f.signIn(other.credentials);
  assert.equal((await f.request("GET", f.path, { session })).status, 200);
  assert.equal((await f.cancel(attempt, { session })).status, 409);
  const foreign = await f.createNamespace("Foreign OAuth", { ready: true });
  assert.equal(
    (await f.request("GET", `/namespaces/${foreign.id}/agents/${f.agent.id}/oauth`)).status,
    404,
  );
  assert.equal(
    (
      await f.request(
        "POST",
        `/namespaces/${foreign.id}/agents/${f.agent.id}/oauth/attempts/${attempt.attemptId}/cancel`,
        {
          headers: { origin: f.origin },
          body: { connectionId: attempt.connectionId, generation: attempt.generation },
        },
      )
    ).status,
    404,
  );
  const sibling = await f.createAgent(
    f.namespace.id,
    "Sibling OAuth Agent",
    {},
    { harnessAuth: null },
  );
  assert.equal(
    (
      await f.request(
        "POST",
        `/namespaces/${f.namespace.id}/agents/${sibling.id}/oauth/attempts/${attempt.attemptId}/cancel`,
        {
          headers: { origin: f.origin },
          body: { connectionId: attempt.connectionId, generation: attempt.generation },
        },
      )
    ).status,
    409,
  );
  for (const body of [
    { connectionId: `aoc_${randomUUID()}`, generation: attempt.generation },
    { connectionId: attempt.connectionId, generation: attempt.generation + 1 },
  ]) {
    assert.equal((await f.cancel(attempt, { body })).status, 409);
  }
  assert.equal((await f.cancel({ ...attempt, attemptId: randomUUID() })).status, 409);
  assert.equal((await f.latest()).phase, "authorizing");
  assert.equal((await f.cancel(attempt)).status, 200);
  const replacement = await f.begin(attempt.generation);
  assert.equal((await f.cancel(attempt)).status, 409);
  assert.deepEqual((await f.request("GET", f.path)).data, replacement);
});

test("OAuth HTTP routes enforce sessions, Agent permission, CSRF, and closed request bodies", async (t) => {
  const f = await setup(t);
  const attempt = await f.begin();
  assert.equal((await f.request("GET", f.path, { session: null })).status, 401);
  assert.equal((await f.cancel(attempt, { session: null })).status, 401);
  assert.equal((await f.cancel(attempt, { headers: {} })).status, 403);
  assert.equal(
    (await f.cancel(attempt, { headers: { origin: f.origin, "sec-fetch-site": "cross-site" } }))
      .status,
    403,
  );
  for (const body of [
    { connectionId: attempt.connectionId, generation: 0 },
    {
      connectionId: attempt.connectionId,
      generation: attempt.generation,
      refreshToken: credential.refresh,
    },
  ]) {
    const rejected = await f.cancel(attempt, { body });
    assert.equal(rejected.status, 400);
    assert.equal(JSON.stringify(rejected.body).includes(credential.refresh), false);
  }
  f.policy.roles[0].permissions = f.policy.roles[0].permissions.filter(
    (permission) => !(permission.action === "administer" && permission.resourceKind === "agent"),
  );
  assert.equal((await f.request("GET", f.path)).status, 403);
  assert.equal((await f.cancel(attempt)).status, 403);
  assert.equal((await f.latest()).phase, "authorizing");
});

test("OAuth cancellation rolls back and redacts unexpected audit failures", async (t) => {
  const f = await setup(t);
  const attempt = await f.begin();
  const append = f.audit.append.bind(f.audit);
  f.audit.append = async (event) => {
    if (event.action === "openclaw.agents.oauth.cancel") {
      throw new Error(credential.refresh);
    }
    await append(event);
  };
  const rejected = await f.cancel(attempt);
  assert.equal(rejected.status, 503);
  assert.equal(rejected.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(JSON.stringify([rejected.body, f.audit.events]).includes(credential.refresh), false);
  assert.deepEqual((await f.request("GET", f.path)).data, attempt);
  f.audit.append = append;
  assert.equal((await f.cancel(attempt)).status, 200);
});
