import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import {
  createControllerAuth,
  createPostgresControllerAuth,
} from "../../apps/controller/src/auth/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  InMemoryPlatformState,
  OpenClawController,
  RuntimeServiceTrustService,
  parseRuntimeAuthoritySource,
  RUNTIME_SERVICE_NATIVE_LIMITS,
} from "../../packages/occ/src/index.ts";
import { seedAuthority } from "./runtime-authority-state/seed.mjs";
import { signInToControllerApp } from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";

export function signal() {
  return new AbortController().signal;
}
export function sourceRequest(sourceRef, expectedVersion = null) {
  return {
    schemaVersion: 1,
    kind: "source-admit",
    operationRef: randomUUID(),
    sourceRef,
    expectedVersion,
  };
}
export function serviceRequest(f, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "service-admit",
    operationRef: randomUUID(),
    expectedVersion: null,
    serviceIdentityRef: null,
    sourceRef: f.source.sourceRef,
    namespaceId: f.owner.namespace.id,
    agentId: f.owner.agent.id,
    peerSPIFFEId: `spiffe://${f.source.trustDomain}/independent-service`,
    ...overrides,
  };
}
export async function technicalSource(
  overrides = {},
  binaryPath = process.env.OCC_RUNTIME_AUTHORITY_TEST_BINARY,
) {
  const binaryDigest =
    binaryPath === undefined
      ? `sha256:${"0".repeat(64)}`
      : `sha256:${createHash("sha256")
          .update(await readFile(binaryPath))
          .digest("hex")}`;
  // These are protected deployment fixture values. They do not assert enrollment,
  // source liveness or possession; service admission still calls the actual native parser.
  return parseRuntimeAuthoritySource({
    schemaVersion: 1,
    sourceRef: `source/${randomUUID()}`,
    workloadApiSocketPath: "/servicepeer/test.sock",
    ownSPIFFEId: "spiffe://example.test/controller",
    recipientRef: "recipient/occ",
    recipientSPIFFEId: "spiffe://example.test/controller",
    trustDomain: "example.test",
    trustRootsRef: "roots/test",
    trustBundleSha256: `sha256:${"1".repeat(64)}`,
    verifierProfileRef: "verifier/test",
    nativeExecutableSha256: binaryDigest,
    transportProfileRef: "owned-child-stdio-readback-v1",
    limits: RUNTIME_SERVICE_NATIVE_LIMITS,
    ...overrides,
  });
}
export async function createRuntimeServiceTrustFixture({
  state = new InMemoryPlatformState(),
  pool,
  source,
  sourceOverrides = {},
  binaryPath = process.env.OCC_RUNTIME_AUTHORITY_TEST_BINARY,
  nativeSourceRoot = process.env.OCC_RUNTIME_SERVICE_NATIVE_SOURCE_ROOT,
} = {}) {
  const owner = await seedAuthority(state);
  const installationId = owner.installation.id;
  const authOptions = {
    mode: "development",
    installationId,
    baseURL: "http://127.0.0.1",
    secret: `runtime-service-trust-${randomUUID()}`,
    secureCookies: false,
  };
  const auth =
    pool === undefined
      ? createControllerAuth({
          ...authOptions,
          memoryDatabase: { user: [], account: [], session: [], verification: [], apikey: [] },
        })
      : await createPostgresControllerAuth({ ...authOptions, pool });
  const credentials = {
    email: `trust-${randomUUID()}@example.invalid`,
    password: `Trust-password-${randomUUID()}`,
  };
  const account = await auth.createAccount(credentials);
  const seed = auth.principalSeed(account);
  const policy = {
    identities: [seed.principal],
    roles: [...seed.roles],
    bindings: [...seed.bindings],
    groups: [],
    memberships: [],
    restrictions: [],
  };
  // This is explicit preprovisioned test IAM policy through the real store and engine.
  // The production registry writer never inserts or selects these roles itself.
  if (pool !== undefined) await state.seedNativeIAM(policy);
  const iam = new NativeIAMDriver(
    pool === undefined ? { loadNativeIAMState: async () => policy } : state,
  );
  const auditSink =
    pool === undefined
      ? { append: (event) => state.transact((unit) => unit.audit.append(event)) }
      : state.auditSink;
  const controller = new OpenClawController(owner.installation, { state, recordOperations: false });
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  const configurationDriver = createTestConfigurationDriver();
  controller.registerDriver(configurationDriver);
  controller.selectDriver("configuration", configurationDriver.id);
  const actualSource = source ?? (await technicalSource(sourceOverrides, binaryPath));
  const validateProfile = async (profile, requestSignal) => {
    if (!binaryPath)
      throw new Error("OCC_RUNTIME_AUTHORITY_TEST_BINARY must select the real native validator.");
    const path = nativeSourceRoot
      ? resolve(nativeSourceRoot, "apps/controller/src/admission/runtime-authority-profile.ts")
      : new URL(
          "../../apps/controller/src/admission/runtime-authority-profile.ts",
          import.meta.url,
        );
    const { validateNativeRuntimeServiceProfile } = await import(
      path instanceof URL ? path.href : pathToFileURL(path).href
    );
    await validateNativeRuntimeServiceProfile(binaryPath, profile, requestSignal);
  };
  const options = {
    installationId,
    state,
    iam: () => controller.selectedDriver("iam"),
    sources: [actualSource],
    validateProfile,
  };
  const trust = new RuntimeServiceTrustService(options);
  const appOptions = {
    controller,
    iamDriver: iam,
    configurationDriver,
    auth,
    auditSink,
    publicOrigin: "http://127.0.0.1",
    development: { enabled: true, installationId },
    runtimeServiceTrust: trust,
    resolveHarness: () => {
      throw new Error("No harness is resolved by these readback tests.");
    },
  };
  const app = createFastifyApp(appOptions);
  await app.ready();
  const session = await signInToControllerApp(app, credentials);
  const headers = { host: "127.0.0.1", cookie: session.cookie, origin: "http://127.0.0.1" };
  const admission = await auth.admissionVerifier.verify({
    requestedScope: { installationId },
    headers,
    requestId: `req_${randomUUID()}`,
  });
  assert.equal(admission.method, "session");
  const context = {
    actorId: seed.principal.id,
    issuer: admission.externalIdentity.issuer,
    subject: admission.externalIdentity.subject,
    admissionDecisionId: admission.decisionId,
    requestId: `req_${randomUUID()}`,
  };
  const request = async (method, url, body, customHeaders = headers) => {
    const response = await app.inject({
      method,
      url,
      headers: customHeaders,
      ...(body === undefined ? {} : { payload: body }),
    });
    return {
      status: response.statusCode,
      ...(response.body ? response.json() : {}),
      headers: response.headers,
    };
  };
  return {
    state,
    pool,
    owner,
    controller,
    iam,
    auth,
    credentials,
    seed,
    policy,
    trust,
    options,
    source: actualSource,
    app,
    appOptions,
    session,
    headers,
    context,
    request,
    close: () => app.close(),
  };
}
