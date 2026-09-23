import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

test("provider setup persists safe references, admits API keys, and keeps OAuth configuration non-deployable", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provider setup", { ready: true });
  const base = `/namespaces/${namespace.id}/provider-connections`;
  const catalog = await fixture.request("GET", "/provider-catalog");
  assert.equal(catalog.status, 200);
  const openai = catalog.data.find((item) => item.id === "openai");
  assert.equal(
    openai.authMethods.find((item) => item.id === "api-key").deploymentAuthMethod,
    "api_key",
  );
  assert.equal(openai.authMethods.find((item) => item.id === "token-sharing").nativeVersion, null);

  const secret = await fixture.createSecret(namespace.id, "Model key", "synthetic-provider-key");
  const created = await fixture.request("POST", base, {
    body: {
      name: "Team OpenAI",
      providerId: "openai",
      authMethodId: "api-key",
      source: secret.ref,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.data.source, secret.ref);
  assert.doesNotMatch(JSON.stringify(created.body), /synthetic-provider-key|backendRef/);
  const binding = { method: "provider_connection", connectionId: created.data.id };
  const agent = await fixture.createAgent(
    namespace.id,
    "Connected Agent",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
    { harnessAuth: binding },
  );

  // Connection visibility does not authorize consumption. The Agent needs both
  // the connection grant and its underlying Secret grant before admission.
  const deployPath = `/namespaces/${namespace.id}/agents/${agent.id}/deploy`;
  assert.equal((await fixture.request("POST", deployPath)).status, 403);
  fixture.policy.identities.push({
    id: agent.servicePrincipalId,
    kind: "service_principal",
    namespaceId: namespace.id,
    agentId: agent.id,
  });
  fixture.policy.roles.push({
    id: "provider-consumer",
    namespaceId: namespace.id,
    permissions: [
      { action: "operate", resourceKind: "provider_connection" },
      { action: "operate", resourceKind: "secret" },
    ],
  });
  for (const [resourceKind, resourceId] of [
    ["provider_connection", created.data.id],
    ["secret", secret.id],
  ]) {
    fixture.policy.bindings.push({
      id: `consume-${resourceKind}`,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: "provider-consumer",
      resourceKind,
      resourceId,
    });
  }
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  assert.deepEqual(revision.harnessAuth, binding);
  assert.equal((await fixture.request("DELETE", `${base}/${created.data.id}`)).status, 409);
  assert.equal(
    (await fixture.request("DELETE", `/namespaces/${namespace.id}/secrets/${secret.id}`)).status,
    409,
  );

  const oauth = await fixture.request("POST", base, {
    body: { name: "Future OAuth", providerId: "openai", authMethodId: "oauth" },
  });
  assert.equal(oauth.status, 201);
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: { method: "provider_connection", connectionId: oauth.data.id },
  });
  fixture.policy.bindings.push({
    id: "consume-oauth",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: "provider-consumer",
    resourceKind: "provider_connection",
    resourceId: oauth.data.id,
  });
  const blocked = await fixture.request("POST", deployPath);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  const historical = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${revision.id}`,
  );
  assert.deepEqual(historical.data.harnessAuth, binding);

  // Configuration APIs never accept token bytes or arbitrary native auth methods.
  for (const body of [
    { name: "Unknown", providerId: "openai", authMethodId: "arbitrary-command" },
    {
      name: "Injected token",
      providerId: "openai",
      authMethodId: "oauth",
      accessToken: "synthetic-token",
    },
    { name: "Wrong source", providerId: "openai", authMethodId: "oauth", source: secret.ref },
  ]) {
    assert.equal(
      (await fixture.request("POST", base, { body })).status,
      Object.hasOwn(body, "accessToken") ? 400 : 404,
    );
  }
  const local = await fixture.request("POST", base, {
    body: {
      name: "Local server",
      providerId: "ollama",
      authMethodId: "local",
      baseUrl: "http://models.example.test:11434",
    },
  });
  assert.equal(local.status, 201);
  assert.equal((await fixture.request("DELETE", `${base}/${local.data.id}`)).status, 204);
  assert.equal((await fixture.request("GET", base)).data.length, 2);
});

test("provider connection lookup, source selection, and consumption cannot cross Namespaces", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const alpha = await fixture.createNamespace("Alpha connections", { ready: true });
  const beta = await fixture.createNamespace("Beta connections", { ready: true });
  const secret = await fixture.createSecret(alpha.id, "Alpha key", "synthetic-alpha-key");
  const body = {
    name: "Alpha provider",
    providerId: "openai",
    authMethodId: "api-key",
    source: secret.ref,
  };
  const base = `/namespaces/${alpha.id}/provider-connections`;
  const created = await fixture.request("POST", base, { body });
  assert.equal(created.status, 201);
  assert.equal(
    (await fixture.request("POST", `/namespaces/${beta.id}/provider-connections`, { body })).status,
    404,
  );
  assert.equal(
    (await fixture.request("GET", `/namespaces/${beta.id}/provider-connections/${created.data.id}`))
      .status,
    404,
  );

  const limited = await fixture.createAccountWithPolicy("connection-no-permissions", () => {});
  const session = await fixture.signIn(limited.credentials);
  assert.deepEqual((await fixture.request("GET", base, { session })).data, []);
  assert.equal(
    (await fixture.request("GET", `${base}/${created.data.id}`, { session })).status,
    403,
  );
  assert.equal((await fixture.request("POST", base, { body, session })).status, 403);
  assert.equal(
    (await fixture.request("DELETE", `${base}/${created.data.id}`, { session })).status,
    403,
  );
});
