import { createWorkloadProfileService } from "../../packages/occ/src/services/workload-profile/service.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { WorkloadProfileTransactionGuard } from "../../packages/occ/src/workload-profiles/repository.ts";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/ports/transaction-errors.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkloadProfileUseResolverV2,
  createWorkloadProfileCapabilityAggregatorV2,
} from "../../packages/occ/src/workload-profiles/admitted-use.ts";
import { createAdmittedWorkloadProfileSelectorV2 } from "../../packages/occ/src/workload-profiles/selection.ts";
import {
  createWorkloadProfileAdmittedHeadV2,
  withdrawWorkloadProfileAdmissionV2,
} from "../../packages/occ/src/workload-profiles/admission-record.ts";
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

// The actual codecs, first-use orchestration and retained-row selector execute.
// Controlled producer seams model custody/failure only; no deployed account,
// SQL/current admission, Driver or native capability is qualified by these cases.
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
function setup() {
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
  let active = true;
  let current = true;
  let inserted;
  const signal = new AbortController();
  const unit = {
    kind: "deployment",
    installationId: I,
    namespaceId: N,
    agentId: A,
    operationRef: uuid(300),
    platform: {},
    signal: signal.signal,
    retain(lease) {
      events.push(["retain", lease]);
    },
  };
  const io = {
    assertActive() {
      if (!active) throw new Error("io-ended");
    },
    poison(e) {
      events.push(["poison", e]);
    },
  };
  const lease = (name) => ({
    assertCurrent() {
      if (!current) throw new Error("withdrawn");
    },
    async release() {
      events.push(name + "-release");
    },
  });
  const activeSource = {
    async readLocked(r, u, x) {
      assert.equal(u, unit);
      assert.equal(x, io);
      assert.equal(Object.keys(r).length, 4);
      events.push("head");
      return { ...lease("head"), head };
    },
  };
  const candidateSource = {
    async resolveLocked(r, c, h, u, x) {
      assert.equal(u, unit);
      assert.equal(x, io);
      assert.equal(c.id, candidate.id);
      events.push("candidate");
      return { ...lease("candidate"), projection };
    },
  };
  const capabilities = {
    async acquire(r, m, use, u, x) {
      assert.equal(u, unit);
      events.push("capability");
      return lease("capability");
    },
  };
  const storage = {
    async enroll(r, u, x) {
      assert.equal(u, unit);
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
          if (!inserted) throw new Error("not-inserted");
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
              configurationVersion: 3,
            },
            configuration: {
              ref: request.configurationRef,
              version: 3,
              admittedConfigurationDigest: inserted.admittedConfigurationDigest,
            },
          };
        },
      };
    },
  };
  const selector = createAdmittedWorkloadProfileSelectorV2(storage, capabilities);
  const resolver = createWorkloadProfileUseResolverV2(
    activeSource,
    candidateSource,
    capabilities,
    selector,
  );
  return {
    request,
    candidate,
    unit,
    io,
    events,
    resolver,
    activeSource,
    candidateSource,
    capabilities,
    selector,
    lease,
    derived,
    projection,
    head,
    actor,
    setHead(v) {
      head = v;
    },
    setProjection(v) {
      projection = v;
    },
    insert(use) {
      inserted = use;
    },
    endIO() {
      active = false;
    },
    revoke() {
      current = false;
    },
    signal,
  };
}

test("before first INSERT prepares exact H; same real selector verifies own inserted Use", async () => {
  const f = setup();
  const prepared = await f.resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io);
  assert.equal(
    prepared.use.admittedConfigurationDigest,
    deriveAdmittedConfigurationV1(f.projection).admittedConfigurationDigest,
  );
  assert.equal(f.events.includes("selector"), false);
  f.unit.retain(prepared);
  f.insert(prepared.use);
  const selected = await prepared.verifyInserted(f.io);
  f.unit.retain(selected);
  assert.equal(selected.use.admissionRef, prepared.use.admissionRef);
  f.endIO();
  assert.equal(prepared.assertCurrent(), undefined);
  assert.equal(selected.assertCurrent(), undefined);
  await selected.release();
  await prepared.release();
  assert.deepEqual(
    f.events.filter((e) => typeof e === "string" && e.endsWith("-release")),
    [
      "capability-release",
      "selector-release",
      "capability-release",
      "candidate-release",
      "head-release",
    ],
  );
  await assert.rejects(prepared.verifyInserted(f.io));
});
test("post-insert verification refuses an absent row and drains only its own acquisitions", async () => {
  const f = setup();
  const p = await f.resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io);
  await assert.rejects(p.verifyInserted(f.io), /not-inserted/);
  assert.equal(f.events.includes("selector-release"), true);
  assert.equal(f.events.includes("head-release"), false);
  await p.release();
});
for (const field of [
  "revisionId",
  "agentId",
  "namespaceId",
  "configurationRef",
  "configurationVersion",
])
  test(`candidate correlation refuses changed ${field}`, async () => {
    const f = setup();
    const r = { ...f.request, [field]: field === "configurationVersion" ? 4 : "foreign" };
    await assert.rejects(f.resolver.prepareUseLocked(r, f.candidate, f.unit, f.io));
    assert.equal(f.events.includes("candidate"), false);
  });
for (const field of ["installationId", "namespaceId", "agentId"])
  test(`same selected key cannot cross ${field}`, async () => {
    const f = setup();
    f.unit[field] = "foreign";
    await assert.rejects(f.resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io));
    assert.equal(f.events.includes("head"), false);
  });
test("draft validation needs no revision and never calls native configuration/capability", async () => {
  const f = setup();
  f.unit.kind = "agent-selection";
  const { installationId, namespaceId, agentId, selection } = f.request;
  const held = await f.resolver.validateSelectionLocked(
    { installationId, namespaceId, agentId, selection },
    f.unit,
    f.io,
  );
  assert.deepEqual(f.events, ["head"]);
  await held.release();
});
test("withdrawn head cannot prepare or validate a fresh use", async () => {
  const f = setup();
  f.setHead(
    withdrawWorkloadProfileAdmissionV2(
      f.head,
      {
        actor: f.actor,
        operationRef: uuid(400),
        requestRef: "withdraw-request",
        decisionRef: "withdraw-decision",
      },
      "withdrawn",
      later,
    ),
  );
  await assert.rejects(f.resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io));
  assert.equal(f.events.includes("candidate"), false);
  assert.equal(f.events.includes("head-release"), true);
});
for (const mutate of [
  (p) => (p.resolvedProfileBindingParameters.agentId = `agt_${uuid(700)}`),
  (p) => p.resolvedProfileBindingParameters.roleBindings.runtime.version++,
  (p) => p.resolvedProfileBindingParameters.storePolicyBindings[0].store.version++,
  (p) => (p.immutableConfigurationContent.values.logging.level = "error"),
])
  test("copied selection digest cannot qualify changed real projection operands", async () => {
    const f = setup();
    const p = copy(f.projection);
    mutate(p);
    f.setProjection(p);
    await assert.rejects(f.resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io));
    assert.equal(f.events.includes("capability"), false);
    assert.equal(f.events.includes("candidate-release"), true);
  });
test("default resolver and incomplete aggregator are unavailable before producer calls", async () => {
  const f = setup();
  await assert.rejects(
    createWorkloadProfileUseResolverV2().prepareUseLocked(f.request, f.candidate, f.unit, f.io),
  );
  await assert.rejects(
    createWorkloadProfileCapabilityAggregatorV2().verifyDefinitionLocked({}, {}, f.io),
  );
  assert.equal(f.events.length, 0);
});
test("deferred invalid source assertion retains cleanup until settlement", async () => {
  const f = setup(),
    d = deferred();
  f.activeSource.readLocked = async () => ({
    ...f.lease("head"),
    head: f.head,
    assertCurrent() {
      return d.promise;
    },
  });
  const resolver = createWorkloadProfileUseResolverV2(
    f.activeSource,
    f.candidateSource,
    f.capabilities,
    f.selector,
  );
  const result = resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io);
  void result.catch(() => {});
  await nextTurn();
  assert.equal(f.events.includes("head-release"), false);
  d.resolve();
  await assert.rejects(result);
  assert.equal(f.events.includes("head-release"), true);
});
test("cleanup memoizes before a producer reenters; rejection undefined is retained", async () => {
  const f = setup();
  let p,
    calls = 0,
    reentrant;
  f.activeSource.readLocked = async () => ({
    ...f.lease("head"),
    head: f.head,
    release() {
      calls++;
      reentrant = p.release();
      return Promise.reject(undefined);
    },
  });
  const r = createWorkloadProfileUseResolverV2(
    f.activeSource,
    f.candidateSource,
    f.capabilities,
    f.selector,
  );
  p = await r.prepareUseLocked(f.request, f.candidate, f.unit, f.io);
  const terminal = p.release();
  const result = await Promise.allSettled([terminal]);
  assert.equal(result[0].status, "rejected");
  assert.equal(result[0].reason, undefined);
  assert.equal(reentrant, terminal);
  assert.equal(calls, 1);
  assert.equal(p.release(), terminal);
});
test("revocation after selection remains terminal despite earlier successful projection", async () => {
  const f = setup();
  const p = await f.resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io);
  f.revoke();
  assert.throws(p.assertCurrent, /withdrawn/);
  await p.release();
});
test("fixed complete aggregation joins every real owner contribution and releases in reverse", async () => {
  const f = setup();
  const seen = [];
  const contribution = (name) => ({
    async verifyDefinitionLocked(request) {
      assert.equal("use" in request, false);
      seen.push(name);
      return {
        assertCurrent() {},
        async release() {
          seen.push("close-" + name);
        },
      };
    },
    async acquire() {
      throw new Error("wrong-stage");
    },
  });
  const renderer = {
    async verifyRendererDefinitionLocked(request, unit, io) {
      return contribution("renderer").verifyDefinitionLocked(request, unit, io);
    },
    async verifyRevisionRendererLocked() {
      throw new Error("wrong-stage");
    },
  };
  const agg = createWorkloadProfileCapabilityAggregatorV2({
    renderer,
    runtime: contribution("runtime"),
    identity: contribution("identity"),
    credentials: contribution("credentials"),
    storage: contribution("storage"),
  });
  const held = await agg.verifyDefinitionLocked(
    { scope: f.head.scope, selection: f.head.selection, manifest: f.derived },
    {
      kind: "profile-definition",
      installationId: f.request.installationId,
      namespaceId: f.request.namespaceId,
      operationRef: uuid(800),
      account: {},
      signal: f.signal.signal,
      retain() {},
    },
    f.io,
  );
  await held.release();
  assert.deepEqual(seen, [
    "renderer",
    "runtime",
    "identity",
    "credentials",
    "storage",
    "close-storage",
    "close-credentials",
    "close-identity",
    "close-runtime",
    "close-renderer",
  ]);
});

test("one guarded service accept returns original replacement action without readOperation", async () => {
  const f = setup(),
    events = [];
  const lease = {
    principal: { id: "original-principal" },
    accountRef: "account",
    requestId: "request",
    admissionDecisionId: "decision",
    assertCurrent() {},
    release() {
      events.push("release");
    },
  };
  const unit = {
    account: {},
    retainCurrentness() {},
    async accept(op, actor) {
      assert.equal(actor, lease);
      events.push("accept");
      return { history: { head: f.head }, action: "replace" };
    },
    async readOperation() {
      throw new Error("second guarded operation forbidden");
    },
  };
  const service = createWorkloadProfileService({
    selection: new DriverSelection(),
    account: {
      async consume(_i, request) {
        assert.equal(request.method, "accept");
        return lease;
      },
    },
    state: {
      async workloadProfileTransaction(_s, work) {
        try {
          return await work(unit);
        } finally {
          events.push("owner-cleanup");
        }
      },
    },
  });
  const result = await service.accept({}, uuid(100), f.signal.signal);
  assert.equal(result.action, "replace");
  assert.deepEqual(events, ["accept", "owner-cleanup", "release"]);
});
for (const original of [new Error("original"), undefined])
  for (const cleanup of [new Error("cleanup"), undefined])
    test("original service failure remains primary after arbitrary cleanup rejection", async () => {
      const f = setup();
      const service = createWorkloadProfileService({
        selection: new DriverSelection(),
        account: {
          async consume() {
            return {
              assertCurrent() {},
              release() {
                throw cleanup;
              },
            };
          },
        },
        state: {
          async workloadProfileTransaction(_s, work) {
            return work({
              account: {},
              retainCurrentness() {},
              async accept() {
                throw original;
              },
            });
          },
        },
      });
      const result = await Promise.allSettled([service.accept({}, uuid(100), f.signal.signal)]);
      assert.equal(result[0].status, "rejected");
      assert.equal(result[0].reason, original);
    });
test("invalid asynchronous account cleanup is joined before service rejection", async () => {
  const f = setup(),
    d = deferred();
  let settled = false;
  const service = createWorkloadProfileService({
    selection: new DriverSelection(),
    account: {
      async consume() {
        return {
          assertCurrent() {},
          release() {
            return d.promise;
          },
        };
      },
    },
    state: {
      async workloadProfileTransaction(_s, work) {
        return work({
          account: {},
          retainCurrentness() {},
          async accept() {
            return { history: { head: f.head }, action: "admit" };
          },
        });
      },
    },
  });
  const result = service.accept({}, uuid(100), f.signal.signal).finally(() => {
    settled = true;
  });
  void result.catch(() => {});
  await nextTurn();
  assert.equal(settled, false);
  d.resolve();
  await assert.rejects(result, /cleanup was not synchronous/);
});
test("late repository entry latches before original final synchronous commit fence", async () => {
  const guard = new WorkloadProfileTransactionGuard();
  await guard.run(async () => {});
  await guard.finish();
  guard.assertCurrent();
  await assert.rejects(guard.run(async () => {}));
  assert.throws(() => guard.assertCurrent(), /closed/);
});

test("selector wrapper getter failure keeps acquired cleanup until actual settlement", async () => {
  const f = setup(),
    d = deferred(),
    original = new Error("selector-field");
  let closes = 0,
    settled = false;
  const selected = {
    request: f.request,
    use: undefined,
    assertCurrent() {},
    release() {
      closes++;
      return d.promise;
    },
  };
  Object.defineProperty(selected, "manifest", {
    enumerable: true,
    get() {
      throw original;
    },
  });
  const resolver = createWorkloadProfileUseResolverV2(
    f.activeSource,
    f.candidateSource,
    f.capabilities,
    {
      async resolveLocked() {
        return selected;
      },
    },
  );
  const prepared = await resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io);
  selected.use = prepared.use;
  const result = prepared.verifyInserted(f.io).finally(() => {
    settled = true;
  });
  void result.catch(() => {});
  await nextTurn();
  assert.equal(closes, 1);
  assert.equal(settled, false);
  assert.ok(f.events.some((e) => Array.isArray(e) && e[0] === "poison" && e[1] === original));
  d.resolve();
  const terminal = await Promise.allSettled([result]);
  assert.equal(terminal[0].status, "rejected");
  assert.equal(terminal[0].reason, original);
  await prepared.release();
  assert.equal(closes, 1);
});
test("throwing poison cannot skip retained cleanup or replace the original failure", async () => {
  const f = setup(),
    d = deferred(),
    original = new Error("source-currentness");
  let closes = 0,
    settled = false,
    poisons = 0;
  f.io.poison = () => {
    poisons++;
    throw new Error("poison failed");
  };
  f.activeSource.readLocked = async () => ({
    head: f.head,
    assertCurrent() {
      throw original;
    },
    release() {
      closes++;
      return d.promise;
    },
  });
  const resolver = createWorkloadProfileUseResolverV2(
    f.activeSource,
    f.candidateSource,
    f.capabilities,
    f.selector,
  );
  const result = resolver.prepareUseLocked(f.request, f.candidate, f.unit, f.io).finally(() => {
    settled = true;
  });
  void result.catch(() => {});
  await nextTurn();
  assert.equal(closes, 1);
  assert.equal(settled, false);
  d.reject(undefined);
  const terminal = await Promise.allSettled([result]);
  assert.equal(terminal[0].status, "rejected");
  assert.equal(terminal[0].reason, original);
  assert.equal(closes, 1);
  assert.equal(poisons, 2);
});
test("unknown original commit remains readback-only when account cleanup also fails", async () => {
  const f = setup(),
    original = new PostgresCommitOutcomeUnknownError();
  const service = createWorkloadProfileService({
    selection: new DriverSelection(),
    account: {
      async consume() {
        return {
          assertCurrent() {},
          release() {
            throw new Error("cleanup");
          },
        };
      },
    },
    state: {
      async workloadProfileTransaction(_s, work) {
        await work({
          account: {},
          retainCurrentness() {},
          async accept() {
            return { history: { head: f.head }, action: "admit" };
          },
        });
        throw original;
      },
    },
  });
  const result = await service.accept({}, uuid(100), f.signal.signal);
  assert.deepEqual(result, {
    kind: "commit-unknown",
    operationRef: uuid(100),
    recovery: "exact-readback-only",
  });
});
