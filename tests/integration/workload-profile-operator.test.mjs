import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import { workloadProfileApiRoutes } from "../../packages/contracts/src/api/workload-profile/routes.ts";
import { createWorkloadProfileService } from "../../packages/occ/src/services/workload-profile/service.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import {
  createWorkloadProfileOperationHandlers,
  installWorkloadProfileJsonParser,
} from "../../apps/controller/src/routes/workload-profile.ts";
import { canonicalFailure, requestFailure } from "../../apps/controller/src/http/errors.ts";
import { inertProfileRequest } from "../fixtures/workload-profile.mjs";

const Fastify = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "fastify",
);

/** Real handler/service/error mapping, locally injected without listening. There
 * is deliberately no valid authentication producer or positive admission fixture. */
async function appFixture(service = createWorkloadProfileService()) {
  const app = Fastify({
    logger: false,
    bodyLimit: 65_536,
    genReqId: () => `req_${randomUUID()}`,
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.addSchema(ErrorResponse);
  app.setErrorHandler((error, _request, reply) => canonicalFailure(reply, requestFailure(error)));
  const handlers = createWorkloadProfileOperationHandlers({
    service,
    invocation: async () => Object.freeze({ forged: "no real request custody" }),
    signal: () => new AbortController().signal,
  });
  await app.register(async (routes) => {
    installWorkloadProfileJsonParser(routes);
    for (const route of workloadProfileApiRoutes)
      routes.route({
        method: route.method,
        url: `/api${route.path}`,
        schema: route.schema,
        handler: handlers[route.operationId],
      });
  });
  await app.ready();
  return app;
}

test("every service operation rejects forged authority while the real producer is absent", async () => {
  const service = createWorkloadProfileService();
  const signal = new AbortController().signal;
  for (const invocation of [
    undefined,
    null,
    {},
    { allowed: true, principalId: "admin", role: "installation-administrator" },
  ]) {
    for (const execute of [
      () => service.prepare(invocation, inertProfileRequest(), signal),
      () => service.accept(invocation, randomUUID(), signal),
      () => service.withdraw(invocation, randomUUID(), {}, signal),
      () => service.readOperation(invocation, randomUUID(), signal),
      () => service.readProfile(invocation, randomUUID(), signal),
    ])
      await assert.rejects(execute, DependencyUnavailableError);
  }
});

test("raw operator parser rejects duplicate keys and unsafe numeric lexemes before schema coercion", async (t) => {
  const app = await appFixture();
  t.after(() => app.close());
  const input = inertProfileRequest();
  const canonical = JSON.stringify(input);
  for (const payload of [
    canonical.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    canonical.replace('"schemaVersion":1', '"schemaVersion":1e0'),
    canonical.replace('"schemaVersion":1', '"schemaVersion":1.0'),
    canonical.replace('"schemaVersion":1', '"schemaVersion":"1"'),
    canonical.replace('"component":"harness"', '"component":"harness","component":"harness"'),
    Buffer.from([0x7b, 0x22, 0xc0, 0xaf, 0x22, 0x3a, 0x31, 0x7d]),
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/workload-profile-operations",
      headers: { "content-type": "application/json" },
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "INVALID_REQUEST");
  }
});
test("valid operator wire requests have no successful path through missing authority", async (t) => {
  const app = await appFixture();
  t.after(() => app.close());
  const prepare = inertProfileRequest();
  const admissionRef = randomUUID();
  const expectedAdmission = {
    admissionRef,
    admissionVersion: 1,
    manifestRef: randomUUID(),
    manifestDigest: prepare.manifest.manifestDigest,
  };
  for (const input of [
    { method: "POST", url: "/api/workload-profile-operations", payload: prepare },
    { method: "POST", url: `/api/workload-profile-operations/${prepare.operationRef}/accept` },
    {
      method: "POST",
      url: `/api/workload-profiles/${admissionRef}/withdraw`,
      payload: { schemaVersion: 1, operationRef: randomUUID(), expectedAdmission },
    },
    { method: "GET", url: `/api/workload-profile-operations/${prepare.operationRef}` },
    { method: "GET", url: `/api/workload-profiles/${admissionRef}` },
  ]) {
    const response = await app.inject(input);
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(Object.hasOwn(response.json(), "data"), false);
    assert.equal(response.body.includes("unqualified"), false);
    assert.equal(response.body.includes(prepare.operationRef), false);
  }
});
test("operator contract rejects supplied actor/session/Installation authority fields", async (t) => {
  const app = await appFixture();
  t.after(() => app.close());
  for (const extra of [
    { actor: "admin" },
    { sessionId: "private-session" },
    { installationId: `ins_${randomUUID()}` },
    { approved: true },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/workload-profile-operations",
      payload: { ...inertProfileRequest(), ...extra },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "INVALID_REQUEST");
    assert.equal(response.body.includes("private-session"), false);
  }
});
test("accept remains bodyless including a purported authority override", async (t) => {
  const app = await appFixture();
  t.after(() => app.close());
  for (const payload of [{}, { approved: true }, null]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/workload-profile-operations/${randomUUID()}/accept`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
    assert.equal(response.statusCode, 400);
  }
});
test("corrupt mutation result cannot expose retained content under acknowledgement authority", async (t) => {
  // Fault injection only: an invalid service response must never be serialized.
  const service = {
    ...createWorkloadProfileService(),
    prepare: async () => ({
      kind: "acknowledged",
      operationRef: randomUUID(),
      action: "admit",
      scope: {
        installationId: `ins_${randomUUID()}`,
        namespaceId: `ns_${randomUUID()}`,
        component: "harness",
      },
      accountRef: "private-account-sentinel",
      canonicalClientIntent: "private-manifest-sentinel",
    }),
  };
  const app = await appFixture(service);
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/workload-profile-operations",
    payload: inertProfileRequest(),
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes("private-account-sentinel"), false);
  assert.equal(response.body.includes("private-manifest-sentinel"), false);
});
test("read response rejects internal account and grant fields instead of exposing them", async (t) => {
  const service = {
    ...createWorkloadProfileService(),
    readOperation: async () => ({
      kind: "inert-preparation",
      operationRef: randomUUID(),
      action: "admit",
      scope: {
        installationId: `ins_${randomUUID()}`,
        namespaceId: `ns_${randomUUID()}`,
        component: "harness",
      },
      manifest: inertProfileRequest().manifest,
      preparedAt: "2026-09-06T00:00:00.000Z",
      grantRef: "private-grant-sentinel",
    }),
  };
  const app = await appFixture(service);
  t.after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: `/api/workload-profile-operations/${randomUUID()}`,
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes("private-grant-sentinel"), false);
});
