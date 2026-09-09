import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import { workloadProfileApiRoutes } from "../../packages/contracts/src/api/workload-profile/routes.ts";
import { createWorkloadProfileService } from "../../packages/occ/src/services/workload-profile/service.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import { createWorkloadProfileCapabilityAggregatorV2 } from "../../packages/occ/src/workload-profiles/admitted-use.ts";
import { WorkloadProfileSelectionError } from "../../packages/occ/src/workload-profiles/selection.ts";
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
    withInvocation: (_request, _binding, work) => work(),
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
      payload: { schemaVersion: 2, operationRef: randomUUID(), expectedAdmission },
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
// Negative error-boundary injection only: the actual unqualified aggregator
// produces the error, while this fixture supplies no positive request authority.
for (const method of ["verifyDefinitionLocked", "acquire"])
  test(`missing workload-profile contributors in ${method} return a redacted dependency response`, async (t) => {
    const definitions = createWorkloadProfileCapabilityAggregatorV2();
    const service = {
      ...createWorkloadProfileService(),
      accept: async () => definitions[method](),
    };
    const app = await appFixture(service);
    t.after(() => app.close());
    const response = await app.inject({
      method: "POST",
      url: `/api/workload-profile-operations/${randomUUID()}/accept`,
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json().error, {
      code: "DEPENDENCY_UNAVAILABLE",
      message: "A required platform dependency is unavailable.",
    });
    assert.equal(Object.hasOwn(response.json(), "data"), false);
    assert.equal(response.body.includes("prerequisites"), false);
    for (const name of ["renderer", "runtime", "identity", "credentials", "storage"])
      assert.equal(response.body.includes(name), false);
  });

test("unrelated selection and generic failures retain the redacted internal-error response", async (t) => {
  for (const error of [
    new WorkloadProfileSelectionError("selection-mismatch"),
    Object.assign(new Error("private-error-sentinel"), {
      name: "WorkloadProfilePrerequisiteErrorV2",
      code: "unavailable",
      prerequisites: ["private-prerequisite-sentinel"],
    }),
  ]) {
    const app = await appFixture({
      ...createWorkloadProfileService(),
      accept: async () => {
        throw error;
      },
    });
    t.after(() => app.close());
    const response = await app.inject({
      method: "POST",
      url: `/api/workload-profile-operations/${randomUUID()}/accept`,
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json().error, {
      code: "INTERNAL_ERROR",
      message: "The platform request could not be completed.",
    });
    assert.equal(Object.hasOwn(response.json(), "data"), false);
    assert.equal(response.body.includes("private-"), false);
    assert.equal(response.body.includes("selection-mismatch"), false);
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

// Real BetterAuth sign-in and Native IAM lookup through the production HTTP
// registration. Memory storage intentionally supplies no accepting account unit.
test("registered operator routes require real human admission and refuse missing account storage", { timeout: 30000 }, async (t) => {
  const { createFastifyApp } = await import("../../apps/controller/src/index.ts");
  const { NativeIAMDriver } = await import("../../packages/iam/src/index.ts");
  const { InMemoryPlatformState, OpenClawController } = await import("../../packages/occ/src/index.ts");
  const { InMemoryAuditSink } = await import("../../packages/audit/src/index.ts");
  const { createTestAuthPrincipal, signInToControllerApp, authenticatedHeaders } =
    await import("../helpers/auth-session.mjs");
  const credentials = await createTestAuthPrincipal();
  const { installationId, seed, auth } = credentials;
  const iam = new NativeIAMDriver({ async loadNativeIAMState() { return {
    identities: [seed.principal], roles: seed.roles, bindings: seed.bindings,
    groups: [], memberships: [], restrictions: [],
  }; } }, { id: "operator-route-iam" });
  const auditSink = new InMemoryAuditSink();
  const controller = new OpenClawController({ id: installationId, name: "Operator route fixture",
    createdAt: new Date().toISOString() }, { state: new InMemoryPlatformState({ auditSink }) });
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  const custody = auth.admissionVerifier.createWorkloadProfileRequestCustodyV1({ maxRequestLifetimeMs: 30000 });
  const app = createFastifyApp({ controller, iamDriver: iam, auditSink, auth,
    workloadProfileRequests: custody, publicOrigin: "http://127.0.0.1",
    development: { enabled: true, installationId },
    resolveHarness: () => { throw new Error("No harness requested by operator routes"); },
  });
  t.after(() => app.close());
  const session = await signInToControllerApp(app, credentials);
  const prepare = inertProfileRequest();
  const admissionRef = randomUUID();
  const operations = [
    { method: "POST", url: "/workload-profile-operations", payload: prepare },
    { method: "POST", url: `/workload-profile-operations/${prepare.operationRef}/accept` },
    { method: "GET", url: `/workload-profile-operations/${prepare.operationRef}` },
    { method: "GET", url: `/workload-profiles/${admissionRef}` },
    { method: "POST", url: `/workload-profiles/${admissionRef}/withdraw`, payload: {
      schemaVersion: 2, operationRef: randomUUID(), expectedAdmission: {
        admissionRef, admissionVersion: 1, manifestRef: randomUUID(), manifestDigest: prepare.manifest.manifestDigest,
      },
    } },
  ];
  for (const operation of operations) {
    const unauthenticated = await app.inject({ ...operation, headers: { host: "127.0.0.1" } });
    assert.equal(unauthenticated.statusCode, 401);
    const response = await app.inject({ ...operation,
      headers: { ...authenticatedHeaders(session), host: "127.0.0.1" } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(Object.hasOwn(response.json(), "data"), false);
  }
  const noOrigin = await app.inject({ ...operations[1], headers: { cookie: session.cookie, host: "127.0.0.1" } });
  assert.equal(noOrigin.statusCode, 403);
});

test("registered handler schema accepts the closed V2 envelope without supplying admission authority", async (t) => {
  const { workloadProfilePairManifestFixture } = await import("../fixtures/workload-profile-admission-v2.mjs");
  const { deriveWorkloadProfileManifestV2 } = await import("../../packages/occ/src/workload-profiles/projections.ts");
  const derived = deriveWorkloadProfileManifestV2(new TextEncoder().encode(JSON.stringify(workloadProfilePairManifestFixture())));
  const input = { schemaVersion: 2, component: "gateway-harness-pair", action: "admit",
    namespaceId: `ns_${randomUUID()}`, operationRef: randomUUID(), expectedAdmission: null,
    manifest: { format: "oce.workload-profile.canonical-json.v1", canonicalUtf8: new TextDecoder().decode(derived.canonicalBytes),
      manifestDigest: derived.digests.manifestDigest },
  };
  const app = await appFixture();
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/workload-profile-operations", payload: input });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "DEPENDENCY_UNAVAILABLE");
  const duplicate = await app.inject({ method: "POST", url: "/api/workload-profile-operations",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(input).replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2'),
  });
  assert.equal(duplicate.statusCode, 400);
});

test("V1 withdrawal is rejected before invocation or service admission", async (t) => {
  let calls = 0;
  const app = await appFixture({ ...createWorkloadProfileService(), withdraw: async () => {
    calls += 1;
    assert.fail("unsupported V1 withdrawal reached the service");
  } });
  t.after(() => app.close());
  const admissionRef = randomUUID();
  const input = { schemaVersion: 1, operationRef: randomUUID(), expectedAdmission: {
    admissionRef, admissionVersion: 1, manifestRef: randomUUID(),
    manifestDigest: inertProfileRequest().manifest.manifestDigest,
  } };
  const response = await app.inject({ method: "POST", url: `/api/workload-profiles/${admissionRef}/withdraw`, payload: input });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "INVALID_REQUEST");
  assert.equal(calls, 0);
  const { workloadProfileOperatorBinding } = await import("../../packages/occ/src/services/workload-profile/service.ts");
  assert.throws(() => workloadProfileOperatorBinding.withdraw(admissionRef, input));
});
