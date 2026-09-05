import assert from "node:assert/strict";
import test from "node:test";

import * as contracts from "../../packages/contracts/src/index.ts";
import * as configurationErrors from "../../packages/contracts/src/configuration-errors.ts";
import * as kubernetesConfiguration from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

test("extracted HTTP admission preserves real sessions, exact IAM, and mutation boundaries", async (t) => {
  // This fixture runs the actual Fastify listener, Better Auth, native IAM and
  // memory state. Its Driver substrates do not establish live runtime readiness.
  const fixture = await createConsoleAppFixture(t, { providers: [] });
  const installation = await fixture.bootstrap("HTTP admission integration");
  const namespace = await fixture.createNamespace("HTTP admission namespace");
  const agent = await fixture.createAgent(namespace.id, "HTTP admission agent");
  const initialNamespaces = (await fixture.request("GET", "/namespaces")).data;
  const installationRead = await fixture.request("GET", "/installation");
  assert.equal(installationRead.status, 200);
  assert.equal(installationRead.data.id, installation.id);

  const anonymous = await fixture.request("GET", "/installation", { session: null });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error.code, "UNAUTHENTICATED");

  // An account can hold a genuine session without a provisioned native IAM identity.
  // Removing only its policy record must not turn authentication into authorization.
  const unprovisioned = await fixture.createAccountWithPolicy("unprovisioned", () => {});
  const session = await fixture.signIn(unprovisioned.credentials);
  fixture.policy.identities.splice(
    fixture.policy.identities.findIndex(({ id }) => id === unprovisioned.principal.id),
    1,
  );
  const denied = await fixture.request("GET", `/namespaces/${namespace.id}`, { session });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");

  for (const [label, method, path, options, status, code] of [
    [
      "forwarded identity",
      "POST",
      "/namespaces",
      { body: { name: "forwarded" }, headers: { "x-forwarded-host": "127.0.0.1" } },
      403,
      "FORBIDDEN",
    ],
    [
      "browser intent",
      "POST",
      "/namespaces",
      { body: { name: "cross-origin" }, headers: { origin: "https://foreign.example.invalid" } },
      403,
      "FORBIDDEN",
    ],
    [
      "server-owned Installation scope",
      "POST",
      "/namespaces",
      { body: { name: "scope-override", installationId: installation.id } },
      400,
      "INVALID_REQUEST",
    ],
    ["strict field types", "POST", "/namespaces", { body: { name: 42 } }, 400, "INVALID_REQUEST"],
    [
      "bodyless operation",
      "POST",
      `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
      { body: {} },
      400,
      "INVALID_REQUEST",
    ],
    [
      "singleton query scope",
      "GET",
      `/installation?installationId=${installation.id}`,
      {},
      400,
      "INVALID_REQUEST",
    ],
  ]) {
    const result = await fixture.request(method, path, options);
    assert.equal(result.status, status, label);
    assert.equal(result.body.error.code, code, label);
  }

  assert.deepEqual((await fixture.request("GET", "/namespaces")).data, initialNamespaces);
  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.data, []);
});

test("configuration errors retain one constructor identity across contract and Driver exports", () => {
  for (const name of ["ConfigurationValidationError", "ConfigurationOwnershipError"]) {
    const canonical = configurationErrors[name];
    assert.equal(contracts[name], canonical, `${name} contract export`);
    assert.equal(kubernetesConfiguration[name], canonical, `${name} Driver export`);
    const error = new kubernetesConfiguration[name]("configuration identity probe");
    assert.ok(error instanceof contracts[name]);
    assert.ok(error instanceof canonical);
  }
});
