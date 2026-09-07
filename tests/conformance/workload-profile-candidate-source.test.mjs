import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkloadProfileCandidateSourceV2,
  createWorkloadProfileUseResolverV2,
  createWorkloadProfileCapabilityAggregatorV2,
} from "../../packages/occ/src/workload-profiles/admitted-use.ts";
import { createAdmittedWorkloadProfileSelectorV2 } from "../../packages/occ/src/workload-profiles/selection.ts";
import { createWorkloadProfileAdmittedHeadV2 } from "../../packages/occ/src/workload-profiles/admission-record.ts";
import {
  PROFILE_ALLOCATION_KINDS,
  createProfilePreparationV2,
  normalizeProfilePreparationV2,
} from "../../packages/occ/src/workload-profiles/types.ts";
import { deriveAdmittedConfigurationV1 } from "../../packages/occ/src/workload-profiles/admitted-configuration.ts";
import { WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2 } from "../../packages/occ/src/workload-profiles/manifest.ts";
import { deriveWorkloadProfileManifestV2 } from "../../packages/occ/src/workload-profiles/projections.ts";
import { workloadProfileManifestFixture } from "../fixtures/workload-profile.mjs";
import { envelope } from "../fixtures/runtime-resource-accounting-v1/values.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { frozenValues } from "../../packages/occ/src/services/deployment/configuration.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/logging.ts";

// Real candidate adapter -> prepareUse -> retained-row selector/codec execution.
// Every context/binding/capability/storage producer below is controlled. These
// fixtures prove orchestration and custody behavior, never central enrollment,
// native/Driver validation, admission/storage authenticity, or a real INSERT.
const copy = (value) => structuredClone(value);
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value));
const digest = (n) => `sha256:${n.repeat(64)}`;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ref = (name) => ({ ref: name, version: 1, contentDigest: digest("1") });
function manifest() {
  const accounting = envelope();
  for (const component of ["gateway", "harness"])
    accounting.observations[component] = {
      status: "unavailable",
      ownerRef: "synthetic-observer",
      reason: "producer-port-unavailable",
    };
  const image = (name) => ({
    reference: `example.invalid/${name}@${digest("2")}`,
    platformDigest: digest("2"),
    executable: { path: `/app/${name}`, contentDigest: digest("3") },
  });
  const process = (name) => ({
    argv: [
      { kind: "literal", value: `/app/${name}` },
      { kind: "binding", name: "configuration-path" },
    ],
    environmentDefinition: ref(`${name}-environment`),
    runtimeClass: "selected-runsc",
    protocolVersion: 1,
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    mounts: [
      {
        name: `${name}-state`,
        path: `/state/${name}`,
        store: ref(`${name}-store`),
        access: "read-write",
      },
    ],
  });
  return {
    schemaVersion: 2,
    target: {
      component: "gateway-harness-pair",
      provider: "occ/kubernetes-gvisor",
      architecture: "linux/amd64",
      placement: "dedicated",
      fallback: "none",
      subject: "installation-namespace-agent",
    },
    profileRefs: workloadProfileManifestFixture().profileRefs,
    artifactSet: { gateway: image("gateway"), harness: image("harness") },
    launchConfiguration: {
      gateway: process("gateway"),
      harness: process("harness"),
      modules: ["identity", "channel", "harness", "persistence"].map((kind) => ({
        id: kind,
        kind,
        definition: ref(kind),
        artifactDigest: digest("4"),
      })),
      placement: { cluster: ref("cluster"), namespaceAllocation: ref("allocation") },
      runtime: { implementation: ref("runsc"), handler: "selected-runsc", platform: "systrap" },
      resourceEnvelope: { podAndRuntimeAccounting: { status: "selected", envelope: accounting } },
      credentials: {
        deliveryMode: "installation-channel-material-v1",
        materialSelection: ref("materials"),
        pathCustody: ref("paths"),
        harnessPlatformCredentials: "forbidden",
      },
    },
    containment: {
      definition: ref("containment"),
      kvmRequired: false,
      privileged: false,
      gatewayPrivateStateInHarness: "forbidden",
      supportedRunnableTuple: "requires-current-owner-validation",
    },
    endpoints: {
      identity: ref("identity"),
      modelMediator: ref("mediator"),
      repositoryIssuer: ref("issuer"),
      harnessTransport: ref("transport"),
    },
    evidenceRequirements: {
      bootstrap: "independent-installation-service",
      physicalCreator: "original-compute-createOriginal",
      context: "initialize-new-or-resume-retained",
      replacement: "exact-replaced-and-retained-participants",
      capabilities: WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2.map((id) => ({
        id,
        implementation: ref(id),
      })),
    },
  };
}

const instant = "2026-09-07T00:00:00.000Z";
const later = "2026-09-07T00:00:01.000Z";
const nextTurn = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function setup(options = {}) {
  const derived = deriveWorkloadProfileManifestV2(bytes(manifest()));
  const I = `ins_${uuid(3)}`,
    N = `ns_${uuid(4)}`,
    A = `agt_${uuid(5)}`;
  const actor = { accountRef: "actual-fixture-account", principalRef: "actual-fixture-principal" };
  const prep = createProfilePreparationV2(
    I,
    actor,
    normalizeProfilePreparationV2({
      schemaVersion: 2,
      operationRef: uuid(100),
      namespaceId: N,
      component: "gateway-harness-pair",
      action: "admit",
      expectedAdmission: null,
      manifest: {
        format: "oce.workload-profile.canonical-json.v1",
        canonicalUtf8: new TextDecoder().decode(derived.canonicalBytes),
        manifestDigest: derived.digests.manifestDigest,
      },
    }),
    Object.fromEntries(PROFILE_ALLOCATION_KINDS.map((k, i) => [k, uuid(200 + i)])),
    instant,
  );
  const attribution = {
    actor,
    operationRef: prep.operationRef,
    requestRef: "original-request",
    decisionRef: "original-decision",
  };
  let head = createWorkloadProfileAdmittedHeadV2(prep, attribution, later);
  const request = {
    schemaVersion: 2,
    installationId: I,
    namespaceId: N,
    agentId: A,
    revisionId: `rev_${uuid(6)}`,
    configurationRef: `cfg_${uuid(7)}`,
    configurationVersion: 3,
    selection: head.selection,
  };
  const candidate = {
    installationId: I,
    namespaceId: N,
    agentId: A,
    id: request.revisionId,
    revision: 1,
    providerId: "codex",
    configurationId: request.configurationRef,
    configurationGeneration: 3,
    configurationKind: "agent",
    configuration: frozenValues(
      admitLoggingConfiguration(
        frozenValues(createHarnessConfiguration("codex", "gpt-4.1")),
        "info",
      ),
    ),
    secretBindings: {},
    servicePrincipalId: `prn_${uuid(8)}`,
    serviceAccount: {
      id: `sa_${uuid(9)}`,
      credential: { kind: "api_key", secretRef: { name: "model-credential", key: "api-key" } },
    },
    harness: { id: "codex", version: "1", mode: "dedicated" },
    compute: { id: "kubernetes", implementation: "selected" },
    createdAt: instant,
  };
  let projection = {
    manifestDigest: head.selection.manifestDigest,
    configurationRef: request.configurationRef,
    configurationGeneration: 3,
    immutableConfigurationContent: {
      kind: "agent",
      values: candidate.configuration,
      secretBindings: candidate.secretBindings,
    },
    resolvedProfileBindingParameters: {
      installationId: I,
      namespaceId: N,
      agentId: A,
      serviceAccountAssociation: {
        servicePrincipalId: candidate.servicePrincipalId,
        serviceAccount: candidate.serviceAccount,
      },
      storePolicyBindings: ["gateway", "harness"].flatMap((component) =>
        derived.content.launchConfiguration[component].mounts.map((m) => ({ component, ...m })),
      ),
      roleBindings: head.profileRefs,
    },
  };
  projection = deriveAdmittedConfigurationV1(projection).projection;
  const events = [];
  const supplierAttempts = { context: 0, bindings: 0 };
  const retained = [];
  const revoked = new Set();
  const abort = new AbortController();
  let ioActive = true;
  let inserted;
  let insertCount = 0;
  const unit = {
    kind: "deployment",
    installationId: I,
    namespaceId: N,
    agentId: A,
    operationRef: uuid(300),
    platform: {},
    signal: abort.signal,
    retain(held) {
      retained.push(held);
    },
  };
  const io = {
    assertActive() {
      if (!ioActive) throw new Error("acquisition-io-closed");
    },
    poison(error) {
      events.push(["poison", error]);
      options.poison?.(error);
    },
  };
  function lease(name) {
    return {
      assertCurrent() {
        if (revoked.has(name)) throw new Error(`${name}-revoked`);
      },
      async release() {
        events.push(`${name}-release`);
        await options.release?.(name);
      },
    };
  }
  function recognize(u, x) {
    if (u !== unit || x !== io) throw new Error("controlled-slot-unavailable");
    io.assertActive();
  }
  const configuration = {
    configurationRef: projection.configurationRef,
    configurationGeneration: projection.configurationGeneration,
    immutableConfigurationContent: copy(projection.immutableConfigurationContent),
  };
  const resolvedBindings = copy(projection.resolvedProfileBindingParameters);
  const contexts = {
    async readLocked(r, c, u, x) {
      supplierAttempts.context++;
      recognize(u, x);
      assert.notEqual(c, candidate);
      assert.deepEqual(copy(c), copy(candidate));
      assert.equal(r.revisionId, request.revisionId);
      events.push("context");
      const result = { ...lease("context"), configuration };
      return options.context ? await options.context(result, c) : result;
    },
  };
  const sources = {
    async resolveLocked(r, c, m, u, x) {
      supplierAttempts.bindings++;
      recognize(u, x);
      assert.equal(r.configurationVersion, candidate.configurationGeneration);
      assert.equal(m.target.component, "gateway-harness-pair");
      events.push("bindings");
      const result = { ...lease("bindings"), bindings: resolvedBindings };
      return options.bindings ? await options.bindings(result, c) : result;
    },
  };
  const adapter = createWorkloadProfileCandidateSourceV2(contexts, sources);
  const active = {
    async readLocked(r, u, x) {
      recognize(u, x);
      events.push("head");
      return { ...lease("head"), head };
    },
  };
  const contribution = (name) => ({
    async acquire(r, m, use, u, x) {
      recognize(u, x);
      assert.equal(
        use.admittedConfigurationDigest,
        deriveAdmittedConfigurationV1(projection).admittedConfigurationDigest,
      );
      events.push(name);
      return lease(name);
    },
    async verifyDefinitionLocked() {
      throw new Error("no definition admission in this test");
    },
  });
  const renderer = contribution("renderer");
  const capabilities = createWorkloadProfileCapabilityAggregatorV2({
    renderer: {
      verifyRevisionRendererLocked: renderer.acquire,
      verifyRendererDefinitionLocked: renderer.verifyDefinitionLocked,
    },
    runtime: contribution("runtime"),
    identity: contribution("identity"),
    credentials: contribution("credentials"),
    storage: contribution("storage-capability"),
  });
  const selectionStorage = {
    async enroll(r, u, x) {
      recognize(u, x);
      events.push("selector");
      return {
        ...lease("selector"),
        async lockNamespace() {
          return { namespaceId: N };
        },
        async lockAgent() {
          return { namespaceId: N, agentId: A };
        },
        async readAdmission() {
          if (!inserted) throw new Error("no inserted revision");
          return {
            schemaVersion: 2,
            state: "admitted",
            use: inserted,
            canonicalManifest: head.canonicalManifest,
            revision: {
              id: request.revisionId,
              agentId: A,
              namespaceId: N,
              workloadProfileUse: inserted,
              configurationRef: request.configurationRef,
              configurationVersion: request.configurationVersion,
            },
            configuration: {
              ref: request.configurationRef,
              version: request.configurationVersion,
              admittedConfigurationDigest: inserted.admittedConfigurationDigest,
            },
          };
        },
      };
    },
  };
  const selector = createAdmittedWorkloadProfileSelectorV2(selectionStorage, capabilities);
  const resolver = createWorkloadProfileUseResolverV2(active, adapter, capabilities, selector);
  return {
    request,
    candidate,
    head,
    unit,
    io,
    adapter,
    resolver,
    events,
    supplierAttempts,
    retained,
    projection,
    configuration,
    resolvedBindings,
    revoked,
    abort,
    active,
    capabilities,
    selector,
    insert(use) {
      assert.equal(insertCount, 0);
      insertCount++;
      events.push("insert");
      inserted = copy(use);
    },
    insertCount: () => insertCount,
    endIO() {
      ioActive = false;
    },
    releases(name) {
      return events.filter((event) => event === `${name}-release`).length;
    },
  };
}
function nullPrototype(value) {
  if (Array.isArray(value)) return value.map(nullPrototype);
  if (value && typeof value === "object")
    return Object.assign(
      Object.create(null),
      Object.fromEntries(Object.entries(value).map(([k, v]) => [k, nullPrototype(v)])),
    );
  return value;
}
function outcome(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

for (const nullObjects of [false, true]) {
  test(`real adapter prepares H and actual selector verifies one controlled row (null prototypes=${nullObjects})`, async () => {
    const f = setup();
    const c = nullObjects ? nullPrototype(f.candidate) : copy(f.candidate);
    const r = nullObjects ? nullPrototype(f.request) : copy(f.request);
    const prepared = await f.resolver.prepareUseLocked(r, c, f.unit, f.io);
    assert.equal(
      prepared.use.admittedConfigurationDigest,
      deriveAdmittedConfigurationV1(f.projection).admittedConfigurationDigest,
    );
    assert.equal(f.events.includes("selector"), false);
    assert.deepEqual(f.events.slice(0, 3), ["head", "context", "bindings"]);
    assert.deepEqual(Object.entries(f.projection.immutableConfigurationContent.secretBindings), []);
    f.unit.retain(prepared);
    f.insert(prepared.use);
    const selected = await prepared.verifyInserted(f.io);
    f.unit.retain(selected);
    assert.equal(f.insertCount(), 1);
    assert.equal(f.retained.length, 2);
    assert.equal(
      selected.use.admittedConfigurationDigest,
      prepared.use.admittedConfigurationDigest,
    );
    f.endIO();
    assert.equal(prepared.assertCurrent(), undefined);
    assert.equal(selected.assertCurrent(), undefined);
    await selected.release();
    const release = prepared.release();
    assert.equal(prepared.release(), release);
    await release;
    assert.equal(f.releases("context"), 1);
    assert.equal(f.releases("bindings"), 1);
    assert.equal(f.releases("head"), 1);
    assert.equal(f.releases("runtime"), 2);
    await assert.rejects(prepared.verifyInserted(f.io));
  });
}

test("matching expected manifest fields do not replace a refusing native binding supplier", async () => {
  const unavailable = new Error("native-definitions-unavailable");
  const f = setup({
    bindings: async () => {
      throw unavailable;
    },
  });
  const result = await outcome(f.resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io));
  assert.equal(result.reason, unavailable);
  assert.equal(f.events.includes("renderer"), false);
  assert.equal(f.releases("context"), 1);
  assert.equal(f.releases("head"), 1);
  assert.equal(f.insertCount(), 0);
});

for (const field of ["serviceAccount", "secretBindings"]) {
  test(`selected candidate refuses missing ${field} before suppliers or capabilities`, async () => {
    const f = setup();
    const candidate = copy(f.candidate);
    delete candidate[field];
    await assert.rejects(f.resolver.prepareUseLocked(f.request, candidate, f.unit, f.io));
    assert.equal(f.events.includes("context"), false);
    assert.equal(f.events.includes("renderer"), false);
    assert.equal(f.releases("head"), 1);
  });
}

for (const [name, change] of [
  [
    "configuration generation",
    (f) => {
      f.configuration.configurationGeneration++;
    },
  ],
  [
    "normalized native content",
    (f) => {
      f.configuration.immutableConfigurationContent.values.logging.level = "debug";
    },
  ],
  [
    "ServiceAccount association",
    (f) => {
      f.resolvedBindings.serviceAccountAssociation.serviceAccount.id = `sa_${uuid(99)}`;
    },
  ],
  [
    "five-role identity",
    (f) => {
      f.resolvedBindings.roleBindings.identity.contentDigest = digest("8");
    },
  ],
  [
    "logical store member",
    (f) => {
      f.resolvedBindings.storePolicyBindings[0].store.contentDigest = digest("9");
    },
  ],
  [
    "mount access",
    (f) => {
      f.resolvedBindings.storePolicyBindings[0].access = "read-only";
    },
  ],
]) {
  test(`independent supplier mismatch rejects ${name} without constructing Use`, async () => {
    const f = setup();
    change(f);
    await assert.rejects(f.resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io));
    assert.equal(f.events.includes("renderer"), false);
    assert.equal(f.releases("context"), 1);
    assert.equal(f.releases("head"), 1);
    assert.equal(f.insertCount(), 0);
  });
}

test("a structural copy of the unit cannot acquire the controlled private candidate slot", async () => {
  const f = setup();
  await assert.rejects(
    f.adapter.resolveLocked(f.request, f.candidate, f.head, { ...f.unit }, f.io),
    /controlled-slot-unavailable/,
  );
  assert.equal(f.events.includes("context"), false);
  assert.equal(f.events.includes("bindings"), false);
});

for (const kind of ["agent-selection", "deployment-recovery"]) {
  test(`candidate adapter rejects ${kind} without supplier reads`, async () => {
    const f = setup();
    await assert.rejects(
      f.adapter.resolveLocked(f.request, f.candidate, f.head, { ...f.unit, kind }, f.io),
    );
    assert.equal(f.events.includes("context"), false);
  });
}

test("native values are detached while a binding supplier is pending", async () => {
  const entered = deferred();
  const wait = deferred();
  const f = setup({
    bindings: async (result) => {
      entered.resolve();
      await wait.promise;
      return result;
    },
  });
  const callerCandidate = copy(f.candidate);
  const pending = f.resolver.prepareUseLocked(f.request, callerCandidate, f.unit, f.io);
  await entered.promise;
  callerCandidate.configuration.logging.level = "debug";
  wait.resolve();
  const prepared = await pending;
  assert.equal(
    prepared.use.admittedConfigurationDigest,
    deriveAdmittedConfigurationV1(f.projection).admittedConfigurationDigest,
  );
  await prepared.release();
});

test("supplier currentness failure is retained beyond acquisition IO closure", async () => {
  const f = setup();
  const held = await f.adapter.resolveLocked(f.request, f.candidate, f.head, f.unit, f.io);
  f.endIO();
  assert.equal(held.assertCurrent(), undefined);
  f.revoked.add("bindings");
  assert.throws(held.assertCurrent, /bindings-revoked/);
  await held.release();
  assert.equal(f.releases("bindings"), 1);
  assert.equal(f.releases("context"), 1);
});

for (const supplier of ["context", "bindings"]) {
  test(`throwing ${supplier} data getter retains and joins acquired cleanup`, async () => {
    const original = new Error(`${supplier}-data-failed`);
    const cleanupStarted = deferred();
    const cleanup = deferred();
    const f = setup({
      [supplier]: (result) => {
        Object.defineProperty(result, supplier === "context" ? "configuration" : "bindings", {
          get() {
            throw original;
          },
        });
        return result;
      },
      release: async (name) => {
        if (name === supplier) {
          cleanupStarted.resolve();
          await cleanup.promise;
        }
      },
      poison() {
        throw new Error("reporting-failed");
      },
    });
    let settled = false;
    const pending = outcome(f.resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io)).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    await cleanupStarted.promise;
    await nextTurn();
    assert.equal(settled, false);
    assert.equal(f.releases("head"), 0);
    cleanup.resolve();
    const result = await pending;
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, original);
    assert.equal(f.releases(supplier), 1);
    assert.equal(f.releases("context"), 1);
    assert.equal(f.releases("head"), 1);
  });
}

for (const supplier of ["context", "bindings"]) {
  test(`invalid deferred ${supplier} assertion must settle before releasing its source`, async () => {
    const assertion = deferred();
    const entered = deferred();
    const f = setup({
      [supplier]: (result) => {
        result.assertCurrent = () => {
          entered.resolve();
          return assertion.promise;
        };
        return result;
      },
    });
    let settled = false;
    const pending = outcome(f.resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io)).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    await entered.promise;
    await nextTurn();
    assert.equal(settled, false);
    assert.equal(f.releases(supplier), 0);
    assertion.resolve();
    assert.equal((await pending).status, "rejected");
    assert.equal(f.releases(supplier), 1);
    assert.equal(f.releases("context"), 1);
    assert.equal(f.releases("head"), 1);
  });
}

test("abort during acquisition still retains the late returned binding lease", async () => {
  const entered = deferred();
  const wait = deferred();
  const f = setup({
    bindings: async (result) => {
      entered.resolve();
      await wait.promise;
      return result;
    },
  });
  const pending = outcome(f.resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io));
  await entered.promise;
  f.abort.abort();
  assert.equal(f.releases("context"), 0);
  wait.resolve();
  assert.equal((await pending).status, "rejected");
  assert.equal(f.releases("bindings"), 1);
  assert.equal(f.releases("context"), 1);
  assert.equal(f.releases("head"), 1);
});

test("cleanup reentry observes the same terminal promise and releases each supplier once", async () => {
  let held;
  let observed;
  const f = setup({
    release(name) {
      if (name === "bindings") observed = held.release();
    },
  });
  held = await f.adapter.resolveLocked(f.request, f.candidate, f.head, f.unit, f.io);
  const release = held.release();
  await release;
  assert.equal(observed, release);
  assert.equal(held.release(), release);
  assert.equal(f.releases("bindings"), 1);
  assert.equal(f.releases("context"), 1);
});

test("undefined cleanup rejection remains a failure while remaining sources are joined", async () => {
  const f = setup({
    release(name) {
      if (name === "bindings") return Promise.reject(undefined);
    },
  });
  const held = await f.adapter.resolveLocked(f.request, f.candidate, f.head, f.unit, f.io);
  const result = await outcome(held.release());
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, undefined);
  assert.equal(f.releases("bindings"), 1);
  assert.equal(f.releases("context"), 1);
});

test("successful candidate projection does not stand in for the missing whole capability source", async () => {
  const f = setup();
  const incomplete = createWorkloadProfileCapabilityAggregatorV2();
  const resolver = createWorkloadProfileUseResolverV2(f.active, f.adapter, incomplete, f.selector);
  await assert.rejects(resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io));
  assert.equal(f.events.includes("bindings"), true);
  assert.equal(f.events.includes("selector"), false);
  assert.equal(f.releases("bindings"), 1);
  assert.equal(f.releases("context"), 1);
  assert.equal(f.insertCount(), 0);
});

test("previously prepared Use refuses a new candidate before fresh suppliers or INSERT", async () => {
  const f = setup();
  const prepared = await f.resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io);
  f.unit.retain(prepared);
  try {
    const attempts = copy(f.supplierAttempts);
    const request = { ...f.request, revisionId: `rev_${uuid(88)}` };
    const candidate = {
      ...copy(f.candidate),
      id: request.revisionId,
      workloadProfileUse: copy(prepared.use),
    };
    await assert.rejects(
      f.resolver.prepareUseLocked(request, candidate, f.unit, f.io),
      (error) => error.code === "selection-mismatch",
    );
    // Count method entry before fixture identity assertions: a missing adapter
    // predicate must not pass this test by failing a later controlled reader.
    assert.deepEqual(f.supplierAttempts, attempts);
    assert.equal(f.events.filter((event) => event === "renderer").length, 1);
    assert.equal(f.insertCount(), 0);
    assert.equal(f.releases("context"), 0);
    assert.equal(f.releases("bindings"), 0);
  } finally {
    await prepared.release();
  }
  assert.equal(f.releases("context"), 1);
  assert.equal(f.releases("bindings"), 1);
});
