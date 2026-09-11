import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { mock } from "node:test";
import { immutableCopy } from "../../packages/utils/src/objects.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import {
  createComputeDriver,
  selectedComputeRendererOwner,
} from "../../apps/controller/src/composition/driver-factories/compute.ts";
import { createSelectedKubernetesRendererSource } from "../../apps/controller/src/drivers/compute/kubernetes/renderer-source.ts";
import { deriveWorkloadProfileManifestV2 } from "@openclaw-enterprise/occ/workload-profiles/projections";
import { WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2 } from "../../packages/occ/src/workload-profiles/manifest.ts";
import { workloadProfileManifestFixture } from "../fixtures/workload-profile.mjs";
import {
  builderEnvelope,
  driverValues,
} from "../fixtures/kubernetes-resource-plan/driver-values.mjs";

// Component contract mocks are explicitly confined to this test module. The
// separate artifact suite owns real OCI/file proofs. Actual Compute factory,
// private renderer association, dispatcher, launch accessor and constructors
// run here; neither the mocked State enrollment nor suppliers grant production
// behavior, material, native, cluster or admission authority.
class ContractArtifactStore {
  #peer;
  constructor(peer) {
    this.#peer = peer;
  }
  async acquire(signal) {
    this.#peer.events.push("artifact-acquire");
    this.#peer.signal = signal;
    return this.#peer.artifactLease();
  }
}
const artifactModule = new URL(
  "../../apps/controller/src/drivers/compute/kubernetes/installed-artifact-store.ts",
  import.meta.url,
);
mock.module(artifactModule.href, {
  namedExports: { ProtectedInstalledArtifactStore: ContractArtifactStore },
});
const { InstalledKubernetesRendererDefinitionOwner } =
  await import("../../apps/controller/src/drivers/compute/kubernetes/installed-renderer-definition.ts");
const digest = (n) => `sha256:${n.repeat(64)}`;
const definition = (ref) => ({ ref, version: 1, contentDigest: digest("1") });
const executableBytes = new TextEncoder().encode(
  "controlled executable bytes, not an installed runtime",
);
const executableDigest = `sha256:${createHash("sha256").update(executableBytes).digest("hex")}`;
const turn = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function values() {
  const { envelope, mapping } = builderEnvelope();
  for (const component of ["gateway", "harness"])
    envelope.observations[component] = {
      status: "unavailable",
      ownerRef: "controlled-observer",
      reason: "producer-port-unavailable",
    };
  const image = (name) => ({
    reference: `example.invalid/${name}@${digest("2")}`,
    platformDigest: digest("2"),
    executable: { path: `/app/${name}`, contentDigest: executableDigest },
  });
  const process = (name) => ({
    argv: [
      { kind: "literal", value: `/app/${name}` },
      { kind: "binding", name: "configuration-path" },
    ],
    environmentDefinition: definition(`${name}-environment`),
    runtimeClass: "selected-agent-runsc",
    protocolVersion: 1,
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    mounts: ["state", "home", "tmp"].map((kind) => ({
      name: `${name}-${kind}`,
      path: `/${kind}`,
      store: definition(`${name}-${kind}`),
      access: "read-write",
    })),
  });
  const manifest = {
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
        definition: definition(kind),
        artifactDigest: digest("4"),
      })),
      placement: { cluster: definition("cluster"), namespaceAllocation: definition("namespace") },
      runtime: {
        implementation: definition("fixed-renderer"),
        handler: "selected-agent-runsc",
        platform: "systrap",
      },
      resourceEnvelope: { podAndRuntimeAccounting: { status: "selected", envelope } },
      credentials: {
        deliveryMode: "installation-channel-material-v1",
        materialSelection: definition("materials"),
        pathCustody: definition("paths"),
        harnessPlatformCredentials: "forbidden",
      },
    },
    containment: {
      definition: definition("containment"),
      kvmRequired: false,
      privileged: false,
      gatewayPrivateStateInHarness: "forbidden",
      supportedRunnableTuple: "requires-current-owner-validation",
    },
    endpoints: {
      identity: definition("identity"),
      modelMediator: definition("model"),
      repositoryIssuer: definition("issuer"),
      harnessTransport: definition("transport"),
    },
    evidenceRequirements: {
      bootstrap: "independent-installation-service",
      physicalCreator: "original-compute-createOriginal",
      context: "initialize-new-or-resume-retained",
      replacement: "exact-replaced-and-retained-participants",
      capabilities: WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2.map((id) => ({
        id,
        implementation: definition(id),
      })),
    },
  };
  const derived = deriveWorkloadProfileManifestV2(
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  const selection = {
    manifestRef: "manifest",
    manifestDigest: derived.digests.manifestDigest,
    admissionRef: "admission",
    admissionVersion: 1,
  };
  const subject = {
    kind: "agent-gateway",
    installationId: "installation-fixture",
    namespaceRef: "attribution-namespace",
    agentRef: "attribution-agent",
  };
  const request = {
    schemaVersion: 2,
    installationId: subject.installationId,
    namespaceId: subject.namespaceRef,
    agentId: subject.agentRef,
    revisionId: "admitted-revision",
    configurationRef: "configuration",
    configurationVersion: 2,
    selection,
  };
  const use = {
    schemaVersion: 2,
    component: "gateway-harness-pair",
    installationId: subject.installationId,
    namespaceId: subject.namespaceRef,
    canonicalFormat: "oce.workload-profile.canonical-json.v1",
    ...selection,
    profileRefs: Object.fromEntries(
      Object.entries(derived.roleDigests).map(([role, contentDigest]) => [
        role,
        { ref: `${role}-profile`, version: 1, contentDigest },
      ]),
    ),
    admittedConfigurationDigest: digest("5"),
  };
  const original = driverValues();
  const options = structuredClone(original.options);
  delete options.runtime;
  options.isolationProfile = "gvisor-systrap";
  options.servicePrincipalCredentials = { mode: "disabled" };
  options.images = {
    gateway: manifest.artifactSet.gateway.reference,
    agent: manifest.artifactSet.harness.reference,
    requireImmutableDigest: true,
  };
  return { ...original, options, derived, manifest: derived.content, request, use, mapping };
}

function fixture() {
  const v = values();
  const events = [];
  let hooks = 0;
  const configurationOperations = { create: 0, read: 0, update: 0, delete: 0, validate: 0 };
  const configurationDriver = {
    id: "component-configuration",
    capability: "configuration",
    implementation: "controlled",
    create() {
      configurationOperations.create++;
      throw new Error("Unexpected configuration create");
    },
    read() {
      configurationOperations.read++;
      throw new Error("Unexpected configuration read");
    },
    update() {
      configurationOperations.update++;
      throw new Error("Unexpected configuration update");
    },
    delete() {
      configurationOperations.delete++;
      throw new Error("Unexpected configuration delete");
    },
    validate() {
      configurationOperations.validate++;
      throw new Error("Unexpected configuration validate");
    },
    computeLifecycleHooks: {
      async beforeWorkloadStart(_revision, launch) {
        hooks++;
        launch.environment.TEST_REFERENCE = "opaque-component-reference";
      },
    },
  };
  const driver = createComputeDriver(
    {
      id: "installed-component-compute",
      implementation: "occ/kubernetes-gvisor",
      configuration: v.options,
    },
    configurationDriver,
  );
  const owner = selectedComputeRendererOwner(driver);
  const original = owner.definition();
  const selection = new DriverSelection();
  selection.registerDriver(configurationDriver);
  selection.selectDriver("configuration", configurationDriver.id);
  selection.registerDriver(driver);
  selection.selectDriver("compute", driver.id);
  const abort = new AbortController();
  const unit = {
    kind: "profile-definition",
    installationId: v.request.installationId,
    namespaceId: v.request.namespaceId,
    operationRef: "component-definition",
    account: {},
    signal: abort.signal,
    retain() {
      throw new Error("outer enrollment owns retention");
    },
  };
  const revisionUnit = {
    kind: "deployment",
    installationId: v.request.installationId,
    namespaceId: v.request.namespaceId,
    agentId: v.request.agentId,
    operationRef: "component-revision",
    platform: {},
    signal: abort.signal,
    retain() {
      throw new Error("outer enrollment owns retention");
    },
  };
  let ioActive = true;
  const io = {
    assertActive() {
      if (!ioActive) throw new Error("original operation closed");
    },
    poison() {},
  };
  const request = {
    scope: {
      installationId: v.request.installationId,
      namespaceId: v.request.namespaceId,
      component: "gateway-harness-pair",
    },
    selection: v.request.selection,
    manifest: v.derived,
  };
  const projection = {
    artifactSet: v.manifest.artifactSet,
    launchConfiguration: v.manifest.launchConfiguration,
  };
  const definitionBytes = new TextEncoder().encode(JSON.stringify(projection));
  const releaseCounts = { artifact: 0, behavior: 0, revision: 0 };
  const controls = {};
  let lastArtifacts, lastBehavior, lastOperands;
  function lease(kind, fields) {
    let released = false;
    let closing;
    return {
      ...fields,
      assertCurrent() {
        if (released || abort.signal.aborted) throw new Error(`${kind} closed`);
        return controls[`${kind}Check`]?.();
      },
      get release() {
        events.push(`${kind}-capture-release`);
        return () => {
          if (closing) return closing;
          released = true;
          closing = Promise.resolve().then(async () => {
            events.push(`${kind}-release`);
            releaseCounts[kind]++;
            await controls[`${kind}Release`]?.();
          });
          return closing;
        };
      },
    };
  }
  const peer = {
    events,
    artifactLease() {
      lastArtifacts = lease("artifact", {
        images: Object.fromEntries(
          ["gateway", "harness"].map((role) => [
            role,
            {
              reference: v.manifest.artifactSet[role].reference,
              descriptor: {
                digest: v.manifest.artifactSet[role].platformDigest,
                mediaType: "application/vnd.oci.image.manifest.v1+json",
                size: 1,
              },
              configuration: Object.freeze({}),
              readFile(path) {
                events.push(`read-${role}`);
                assert.equal(path, v.manifest.artifactSet[role].executable.path);
                return {
                  mode: 0o755,
                  uid: 0,
                  gid: 0,
                  digest: controls.executableDigest ?? executableDigest,
                  bytes: executableBytes.slice(),
                };
              },
            },
          ]),
        ),
        definition: {
          mediaType: "application/vnd.openclaw.installed-renderer-definition.v1+json",
          digest: digest("6"),
          size: definitionBytes.length,
        },
        readDefinition() {
          events.push("definition-bytes");
          return definitionBytes.slice();
        },
        readBlob() {
          throw new Error("no unselected blob");
        },
        borrow() {
          throw new Error("this consumer must retain its own lease");
        },
      });
      return lastArtifacts;
    },
  };
  const store = new ContractArtifactStore(peer);
  const suppliers = {
    async acquireBehavior(input) {
      events.push("behavior-acquire");
      assert.equal(input.artifacts, lastArtifacts);
      assert.equal(input.selected, driver);
      assert.equal(input.definition, original);
      assert.equal(input.io, io);
      assert.deepEqual(input.artifacts.readDefinition(), definitionBytes);
      await controls.behaviorAcquire?.(input);
      lastBehavior = lease("behavior", {
        projection: controls.projection ?? projection,
        accounting: controls.accounting ?? v.mapping,
      });
      return lastBehavior;
    },
    async acquireRevisionOperands(input) {
      events.push("revision-acquire");
      assert.equal(input.artifacts, lastArtifacts);
      assert.equal(input.behavior, lastBehavior);
      assert.equal(input.original[0], driver);
      assert.equal(input.original[1], original);
      assert.equal(input.original[2], v.request);
      assert.equal(input.original[3], v.manifest);
      assert.equal(input.original[4], v.use);
      assert.equal(input.original[5], revisionUnit);
      assert.equal(input.original[6], io);
      assert.ok(Object.isFrozen(input.original));
      await controls.revisionAcquire?.(input);
      lastOperands = lease("revision", { ...f.operands, ...controls.operands });
      return lastOperands;
    },
  };
  // Separate fixed supplier entrypoints; both use the same declared test owner.
  suppliers.acquirePreparedRevisionOperands = suppliers.acquireRevisionOperands;
  const consumer = new InstalledKubernetesRendererDefinitionOwner(store, suppliers);
  const args = () => [driver, original, request, unit, io];
  const revisionArgs = () => [driver, original, v.request, v.manifest, v.use, revisionUnit, io];
  const f = {
    v,
    driver,
    owner,
    original,
    selection,
    events,
    abort,
    unit,
    revisionUnit,
    io,
    controls,
    store,
    suppliers,
    consumer,
    releaseCounts,
    peer,
    args,
    revisionArgs,
    hooks: () => {
      assert.deepEqual(configurationOperations, {
        create: 0,
        read: 0,
        update: 0,
        delete: 0,
        validate: 0,
      });
      return hooks;
    },
    closeIO() {
      ioActive = false;
    },
    definition: () => consumer.acquireDefinition(...args()),
    revision: () => consumer.acquirePreparedRevision(...revisionArgs()),
    staticRevision: () => consumer.acquireRevision(...revisionArgs()),
    get lastArtifacts() {
      return lastArtifacts;
    },
    get lastBehavior() {
      return lastBehavior;
    },
    get lastOperands() {
      return lastOperands;
    },
  };
  return f;
}

function constructionOperands(f, prepared = true) {
  const held = f.owner.acquire(f.selection);
  const templateInput = (role) => ({
    name: `renderer-${role}`,
    ownership: f.v.agentOwnership,
    namespace: f.v.namespace,
    serviceAccountName: `renderer-${role}-sa`,
    environment: {},
    loggingLevel: "info",
    resourcePlan: f.v.plan[role],
  });
  try {
    const gateway = templateInput("gateway");
    const harness = templateInput("harness");
    if (!prepared) {
      const inputs = {
        gateway: [gateway, f.v.manifest.launchConfiguration.gateway.runtimeClass],
        harness,
      };
      return {
        inputs,
        outputs: {
          gateway: held.gatewayTemplate(...inputs.gateway),
          harness: held.harnessTemplate(harness),
        },
      };
    }
    const pod = held.gatewayTemplate(gateway, "selected-gateway-runsc").spec.template.spec;
    const stores = f.v.plan.gateway.values.envelope.gateway.value.storage.value;
    const plan = {
      target: {
        clusterRef: "component-cluster",
        namespace: {
          name: gateway.namespace,
          uid: "component-namespace-uid",
          resourceVersion: "1",
        },
        deploymentName: gateway.name,
      },
      argv: ["/usr/bin/node", "/app/apps/gateway/src/main.mjs"],
      runtimeClassName: "selected-gateway-runsc",
      environment: [],
      volumes: pod.volumes,
      mounts: pod.containers[0].volumeMounts,
      resources: f.v.plan.gateway,
      storage: {
        runtimeHome: {
          accountingId: stores.find((s) => s.kind === "runtime-home").accountingId,
          volumeName: "runtime-state",
        },
        temporary: {
          accountingId: stores.find((s) => s.kind === "temporary").accountingId,
          volumeName: "runtime-temporary",
        },
      },
    };
    const inputs = { gateway: [gateway, plan], harness };
    const outputs = {
      gateway: held.gatewayDeployment(...inputs.gateway),
      harness: held.harnessTemplate(harness),
    };
    return { inputs, outputs };
  } finally {
    held.release();
  }
}

async function prepareRevision(f) {
  const revision = {
    ...structuredClone(f.v.revision),
    id: f.v.request.revisionId,
    agentId: f.v.request.agentId,
    namespaceId: f.v.request.namespaceId,
    configurationId: f.v.request.configurationRef,
    configurationGeneration: f.v.request.configurationVersion,
    compute: { ...f.v.revision.compute, id: f.driver.id, implementation: f.driver.implementation },
  };
  // The actual dispatcher already owned by this actual factory-created Driver
  // prepares this unit fixture. No replacement method, map enrollment or provider
  // response creates the launch. Production calls it through original lifecycle.
  const launch = await f.driver.lifecycle.beforeWorkloadStart(revision);
  assert.equal(f.hooks(), 1);
  assert.equal(launch.environment.TEST_REFERENCE, "opaque-component-reference");
  const harnessOperands = Object.freeze({ launch, imageSetDigest: digest("7") });
  f.operands = { revision, harnessOperands, ...constructionOperands(f) };
  return f.operands;
}

function outerSource(f) {
  const enroll = (kind) => {
    f.events.push(`enroll-${kind}`);
    let released = false;
    return {
      assertCurrent() {
        if (released) throw new Error("contract enrollment released");
      },
      async release() {
        released = true;
        f.events.push("enrollment-release");
      },
    };
  };
  // Explicit original-boundary contract mock; no actual State membership claimed.
  return createSelectedKubernetesRendererSource(
    f.driver,
    f.owner,
    f.selection,
    {
      definition(unit, io) {
        assert.equal(unit, f.unit);
        assert.equal(io, f.io);
        return enroll("definition");
      },
      revision(request, unit, io) {
        assert.equal(request, f.v.request);
        assert.equal(unit, f.revisionUnit);
        assert.equal(io, f.io);
        return enroll("revision");
      },
    },
    f.consumer,
  );
}

// All cases below are authored component checks. No test or mock is installed
// in production and no live behavior/profile qualification is asserted.
test("store-only construction is inert; absent definition/revision suppliers refuse before artifact or hooks", async () => {
  const f = fixture();
  const empty = new InstalledKubernetesRendererDefinitionOwner(f.store);
  await assert.rejects(empty.acquireDefinition(...f.args()));
  await assert.rejects(empty.acquireRevision(...f.revisionArgs()));
  const definitionOnly = new InstalledKubernetesRendererDefinitionOwner(f.store, {
    acquireBehavior: f.suppliers.acquireBehavior,
  });
  await assert.rejects(definitionOnly.acquireRevision(...f.revisionArgs()));
  assert.equal(f.events.length, 0);
  assert.equal(f.hooks(), 0);
  assert.equal(f.driver.apiClients, undefined);
});

test("definition captures original supplier methods once and is revision-free", async () => {
  const f = fixture();
  let replacements = 0;
  f.suppliers.acquireBehavior = async () => {
    replacements++;
    throw new Error("replaced behavior");
  };
  f.suppliers.acquireRevisionOperands = async () => {
    replacements++;
    throw new Error("replaced revision");
  };
  const held = await f.definition();
  try {
    assert.equal(held.definition, f.original);
    assert.deepEqual(
      held.projection,
      immutableCopy({
        artifactSet: f.v.manifest.artifactSet,
        launchConfiguration: f.v.manifest.launchConfiguration,
      }),
    );
    assert.deepEqual(held.accounting, immutableCopy(f.v.mapping));
    assert.equal(held.assertCurrent(), undefined);
    assert.equal(f.events.filter((v) => v === "definition-bytes").length, 1);
    assert.equal(f.events.filter((v) => v.startsWith("read-")).length, 2);
    assert.equal(f.events.includes("revision-acquire"), false);
    assert.equal(f.hooks(), 0);
    assert.equal(replacements, 0);
  } finally {
    await held.release();
  }
  assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 0 });
});

for (const wrong of ["copied-driver", "foreign-definition"])
  test(`definition rejects ${wrong} before supplier acquisition`, async () => {
    const f = fixture();
    const args = f.args();
    if (wrong === "copied-driver") args[0] = { ...f.driver };
    else args[1] = fixture().original;
    await assert.rejects(f.consumer.acquireDefinition(...args));
    assert.equal(f.events.length, 0);
    assert.equal(f.hooks(), 0);
  });

for (const wrong of ["projection", "executable", "accounting"])
  test(`definition rejects ${wrong} mismatch and joins both acquired leases`, async () => {
    const f = fixture();
    if (wrong === "projection")
      f.controls.projection = {
        artifactSet: f.v.manifest.artifactSet,
        launchConfiguration: {
          ...f.v.manifest.launchConfiguration,
          runtime: { ...f.v.manifest.launchConfiguration.runtime, handler: "different" },
        },
      };
    if (wrong === "executable") f.controls.executableDigest = digest("8");
    if (wrong === "accounting")
      f.controls.accounting = {
        ...f.v.mapping,
        gateway: { application: "not-a-contribution", privateStateInit: "not-an-init" },
      };
    await assert.rejects(f.definition());
    assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 0 });
    assert.equal(f.hooks(), 0);
  });

test("outer source enrolls before artifact and releases actual construction/source before enrollment", async () => {
  const f = fixture();
  const source = outerSource(f);
  const held = await source.acquireDefinition(...f.args());
  assert.ok(f.events.indexOf("enroll-definition") < f.events.indexOf("artifact-acquire"));
  assert.equal(held.assertCurrent(), undefined);
  await held.release();
  assert.ok(f.events.indexOf("artifact-release") < f.events.indexOf("enrollment-release"));
  assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 0 });
});

test("definition release is one joined reverse-order lifetime and does not retain expired transaction IO", async () => {
  const f = fixture();
  const held = await f.definition();
  f.closeIO();
  assert.equal(held.assertCurrent(), undefined, "retained source leases outlive original IO scope");
  const gate = deferred();
  f.controls.behaviorRelease = () => gate.promise;
  const closing = held.release();
  assert.equal(held.release(), closing);
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await turn();
  assert.equal(settled, false);
  assert.equal(f.releaseCounts.artifact, 0);
  assert.throws(() => held.assertCurrent());
  gate.resolve();
  await closing;
  assert.ok(f.events.indexOf("behavior-release") < f.events.indexOf("artifact-release"));
  assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 0 });
});

for (const outcome of ["late-success", "late-rejection"])
  test(`cancelled definition joins actual ${outcome} supplier and cleanup before refusal`, async () => {
    const f = fixture();
    const entered = deferred(),
      gate = deferred(),
      cleanup = deferred();
    f.controls.behaviorAcquire = async () => {
      entered.resolve();
      await gate.promise;
    };
    f.controls.artifactRelease = () => cleanup.promise;
    let settled = false;
    const pending = f.definition();
    const refusal = assert.rejects(pending);
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await entered.promise;
    f.abort.abort();
    await turn();
    assert.equal(settled, false);
    assert.equal(f.releaseCounts.artifact, 0);
    if (outcome === "late-success") gate.resolve();
    else gate.reject(new Error("original late failure"));
    await turn();
    assert.equal(settled, false, "actual artifact cleanup remains joined");
    cleanup.resolve();
    await refusal;
    assert.deepEqual(f.releaseCounts, {
      artifact: 1,
      behavior: outcome === "late-success" ? 1 : 0,
      revision: 0,
    });
    assert.equal(f.hooks(), 0);
  });

test("invalid asynchronous original fence is refused and its actual rejection is joined", async () => {
  const f = fixture();
  const entered = deferred(),
    gate = deferred();
  f.controls.behaviorCheck = () => {
    entered.resolve();
    return gate.promise;
  };
  let settled = false;
  const pending = f.definition();
  const refusal = assert.rejects(pending);
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  await turn();
  assert.equal(settled, false);
  assert.equal(f.releaseCounts.behavior, 0);
  gate.reject(new Error("late async currentness failure"));
  await refusal;
  assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 0 });
});

test("final selected-definition fence latches synchronous supplier invalidation permanently", async () => {
  const f = fixture();
  const held = await f.definition();
  const original = f.driver.options;
  let changes = 0;
  f.controls.behaviorCheck = () => {
    changes++;
    f.driver.options = { ...original };
  };
  try {
    assert.throws(() => held.assertCurrent());
    f.driver.options = original;
    delete f.controls.behaviorCheck;
    assert.throws(() => held.assertCurrent());
    assert.equal(changes, 1);
  } finally {
    f.driver.options = original;
    await held.release();
  }
});

test("failed cleanup rejects while still joining remaining source releases", async () => {
  const f = fixture();
  const held = await f.definition();
  const failure = new Error("original behavior cleanup failed");
  f.controls.behaviorRelease = () => {
    throw failure;
  };
  const closing = held.release();
  assert.equal(held.release(), closing);
  await assert.rejects(closing, (error) => error === failure);
  assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 0 });
  assert.throws(() => held.assertCurrent());
});

test("revision retains the exact original launch and supplied full image-set with no new hook or SDK call", async () => {
  const f = fixture();
  const operands = await prepareRevision(f);
  const held = await f.revision();
  try {
    assert.equal(held.harnessOperands, operands.harnessOperands);
    assert.equal(held.harnessOperands.launch, operands.harnessOperands.launch);
    assert.equal(held.harnessOperands.imageSetDigest, digest("7"));
    assert.deepEqual(held.inputs, immutableCopy(operands.inputs));
    assert.deepEqual(held.outputs, immutableCopy(operands.outputs));
    assert.equal(held.assertCurrent(), undefined);
    assert.equal(f.hooks(), 1);
    assert.equal(f.driver.apiClients, undefined);
  } finally {
    await held.release();
  }
  assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 1 });
  assert.throws(() => held.assertCurrent());
});

for (const wrong of ["no-launch", "copied-launch", "wrong-revision", "invalid-image-set"])
  test(`revision rejects ${wrong} and retains original supplier cleanup`, async () => {
    const f = fixture();
    const operands = await prepareRevision(f);
    if (wrong === "no-launch") f.driver.setLifecycleDrivers([]);
    if (wrong === "copied-launch")
      f.controls.operands = {
        harnessOperands: {
          ...operands.harnessOperands,
          launch: structuredClone(operands.harnessOperands.launch),
        },
      };
    if (wrong === "wrong-revision")
      f.controls.operands = { revision: { ...operands.revision, agentId: "different-agent" } };
    if (wrong === "invalid-image-set")
      f.controls.operands = {
        harnessOperands: { ...operands.harnessOperands, imageSetDigest: "not-a-digest" },
      };
    await assert.rejects(f.revision());
    assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 1 });
    assert.equal(f.hooks(), 1);
    assert.equal(f.driver.apiClients, undefined);
  });

for (const invalidate of ["dispatcher", "cleanup", "supplier"])
  test(`held revision is invalidated by original ${invalidate}`, async () => {
    const f = fixture();
    const operands = await prepareRevision(f);
    const held = await f.revision();
    try {
      if (invalidate === "dispatcher") f.driver.setLifecycleDrivers([]);
      if (invalidate === "cleanup") await f.driver.lifecycle.beforeWorkloadStop(operands.revision);
      if (invalidate === "supplier")
        f.controls.revisionCheck = () => {
          throw new Error("material owner revoked");
        };
      assert.throws(() => held.assertCurrent());
      delete f.controls.revisionCheck;
      assert.throws(() => held.assertCurrent());
      assert.equal(f.hooks(), 1);
      assert.equal(f.driver.apiClients, undefined);
    } finally {
      await held.release();
    }
  });

test("outer original constructors accept exact supplied outputs and reject a changed physical target", async () => {
  for (const changed of [false, true]) {
    const f = fixture();
    const operands = await prepareRevision(f);
    if (changed) {
      const outputs = structuredClone(operands.outputs);
      outputs.gateway.metadata.name = "different-target";
      f.controls.operands = { outputs };
    }
    const source = outerSource(f);
    if (changed) await assert.rejects(source.acquirePreparedRevision(...f.revisionArgs()));
    else {
      const held = await source.acquirePreparedRevision(...f.revisionArgs());
      assert.equal(held.harnessOperands.launch, operands.harnessOperands.launch);
      assert.equal(held.assertCurrent(), undefined);
      await held.release();
    }
    assert.ok(f.events.indexOf("enroll-revision") < f.events.indexOf("artifact-acquire"));
    assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 1 });
    assert.equal(f.hooks(), 1);
  }
});

test("revision supplier late return after original IO closes is owned and refused", async () => {
  const f = fixture();
  await prepareRevision(f);
  const entered = deferred(),
    gate = deferred();
  f.controls.revisionAcquire = async () => {
    entered.resolve();
    await gate.promise;
  };
  let settled = false;
  const pending = f.revision();
  const refusal = assert.rejects(pending);
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  f.closeIO();
  await turn();
  assert.equal(settled, false);
  gate.resolve();
  await refusal;
  assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 1 });
  assert.equal(f.hooks(), 1);
});

test("structural store replacement cannot invoke a caller-provided acquisition", async () => {
  const f = fixture();
  let entered = 0;
  const copied = {
    acquire: async () => {
      entered++;
      return f.peer.artifactLease();
    },
  };
  const consumer = new InstalledKubernetesRendererDefinitionOwner(copied, f.suppliers);
  await assert.rejects(consumer.acquireDefinition(...f.args()));
  assert.equal(entered, 0);
  assert.equal(f.events.length, 0);
});

test("trusted method getters are captured once at construction", async () => {
  const f = fixture();
  let behaviorGets = 0,
    revisionGets = 0;
  const methods = {
    get acquireBehavior() {
      behaviorGets++;
      return f.suppliers.acquireBehavior;
    },
    get acquireRevisionOperands() {
      revisionGets++;
      return f.suppliers.acquireRevisionOperands;
    },
  };
  const consumer = new InstalledKubernetesRendererDefinitionOwner(f.store, methods);
  assert.equal(behaviorGets, 1);
  assert.equal(revisionGets, 1);
  const held = await consumer.acquireDefinition(...f.args());
  await held.release();
  assert.equal(behaviorGets, 1);
  assert.equal(revisionGets, 1);
  assert.equal(f.events.includes("revision-acquire"), false);
});

test("reentrant release observes the same published closure join", async () => {
  const f = fixture();
  const held = await f.definition();
  let nested,
    calls = 0;
  f.controls.behaviorRelease = () => {
    calls++;
    nested = held.release();
  };
  const closing = held.release();
  await closing;
  assert.equal(nested, closing);
  assert.equal(calls, 1);
  assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 0 });
});

test("caught nested currentness failure still refuses the outer and all later fences", async () => {
  const f = fixture();
  const held = await f.definition();
  const original = f.driver.options;
  let nested = 0,
    refused = 0;
  f.controls.behaviorCheck = () => {
    nested++;
    f.driver.options = { ...original };
    try {
      held.assertCurrent();
    } catch {
      refused++;
    }
    f.driver.options = original;
  };
  try {
    assert.throws(() => held.assertCurrent());
    delete f.controls.behaviorCheck;
    assert.throws(() => held.assertCurrent());
    assert.equal(nested, 1);
    assert.equal(refused, 1);
  } finally {
    f.driver.options = original;
    await held.release();
  }
});

test("revision request mutation across original acquisition cannot rebase the held request", async () => {
  const f = fixture();
  await prepareRevision(f);
  const agent = f.v.request.agentId;
  let changed = 0;
  f.controls.revisionAcquire = () => {
    changed++;
    f.v.request.agentId = "different-current-request";
  };
  try {
    await assert.rejects(f.revision());
    assert.equal(changed, 1);
    assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 1 });
    assert.equal(f.hooks(), 1);
    assert.equal(f.driver.apiClients, undefined);
  } finally {
    f.v.request.agentId = agent;
  }
});

test("source release is captured before a throwing currentness getter", async () => {
  const f = fixture();
  let released = 0;
  const bad = {
    ...f.suppliers,
    async acquireBehavior() {
      return {
        get release() {
          return async () => {
            released++;
          };
        },
        get assertCurrent() {
          throw new Error("original currentness getter failed");
        },
      };
    },
  };
  const consumer = new InstalledKubernetesRendererDefinitionOwner(f.store, bad);
  await assert.rejects(consumer.acquireDefinition(...f.args()));
  assert.equal(released, 1);
  assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 0, revision: 0 });
});

function capturedStaticRevision(f) {
  f.operands = {
    revision: {
      ...structuredClone(f.v.revision),
      id: f.v.request.revisionId,
      agentId: f.v.request.agentId,
      namespaceId: f.v.request.namespaceId,
      configurationId: f.v.request.configurationRef,
      configurationGeneration: f.v.request.configurationVersion,
      compute: {
        ...f.v.revision.compute,
        id: f.driver.id,
        implementation: f.driver.implementation,
      },
    },
    ...constructionOperands(f, false),
  };
  return f.operands;
}

test("fresh captured revision uses logical templates before any launch or physical allocation", async () => {
  const f = fixture();
  const operands = capturedStaticRevision(f);
  assert.throws(() => f.driver.acquireCurrentLaunchOperands(operands.revision));
  const source = outerSource(f);
  const held = await source.acquireRevision(...f.revisionArgs());
  try {
    assert.equal(held.assertCurrent(), undefined);
    assert.equal(held.harnessOperands, undefined);
    assert.equal(typeof operands.inputs.gateway[1], "string");
    assert.equal(operands.outputs.gateway.metadata.uid, undefined);
    assert.equal(operands.outputs.gateway.metadata.resourceVersion, undefined);
    assert.equal(f.hooks(), 0);
    assert.equal(f.driver.apiClients, undefined);
    assert.equal(f.events.filter((e) => e === "revision-acquire").length, 1);
  } finally {
    await held.release();
  }
  assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 1 });
});

test("static candidate identity mismatch refuses without starting a hook", async () => {
  const f = fixture();
  const operands = capturedStaticRevision(f);
  f.controls.operands = { revision: { ...operands.revision, id: "different-captured-revision" } };
  await assert.rejects(f.staticRevision());
  assert.equal(f.hooks(), 0);
  assert.equal(f.driver.apiClients, undefined);
  assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 1 });
});

test("static logical output is compared completely by the actual held constructors", async () => {
  const f = fixture();
  const operands = capturedStaticRevision(f);
  const outputs = structuredClone(operands.outputs);
  outputs.harness.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation = true;
  f.controls.operands = { outputs };
  await assert.rejects(outerSource(f).acquireRevision(...f.revisionArgs()), {
    code: "unsupported-capability",
  });
  assert.equal(f.hooks(), 0);
  assert.equal(f.driver.apiClients, undefined);
  assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 1 });
});

test("missing prepared supplier does not obstruct static admission and never falls back to it", async () => {
  const f = fixture();
  capturedStaticRevision(f);
  let staticCalls = 0;
  const consumer = new InstalledKubernetesRendererDefinitionOwner(f.store, {
    acquireBehavior: f.suppliers.acquireBehavior,
    acquireRevisionOperands(input) {
      staticCalls++;
      return f.suppliers.acquireRevisionOperands(input);
    },
  });
  const held = await consumer.acquireRevision(...f.revisionArgs());
  await held.release();
  const before = [...f.events];
  await assert.rejects(consumer.acquirePreparedRevision(...f.revisionArgs()));
  assert.equal(staticCalls, 1);
  assert.deepEqual(f.events, before);
  assert.equal(f.hooks(), 0);
  assert.equal(f.driver.apiClients, undefined);
});

test("prepared entry before completed launch refuses without invoking lifecycle hooks", async () => {
  const f = fixture();
  capturedStaticRevision(f);
  await assert.rejects(f.revision());
  assert.equal(f.hooks(), 0);
  assert.equal(f.driver.apiClients, undefined);
  assert.deepEqual(f.releaseCounts, { artifact: 1, behavior: 1, revision: 1 });
});

test("prepared supplier is captured once and request phase data cannot invoke it", async () => {
  const f = fixture();
  capturedStaticRevision(f);
  let reads = 0,
    preparedCalls = 0;
  const suppliers = {
    acquireBehavior: f.suppliers.acquireBehavior,
    acquireRevisionOperands: f.suppliers.acquireRevisionOperands,
    get acquirePreparedRevisionOperands() {
      reads++;
      return async () => {
        preparedCalls++;
        throw new Error("prepared-only original supplier");
      };
    },
  };
  const consumer = new InstalledKubernetesRendererDefinitionOwner(f.store, suppliers);
  assert.equal(reads, 1);
  f.v.request.phase = "prepared";
  const held = await consumer.acquireRevision(...f.revisionArgs());
  await held.release();
  assert.equal(reads, 1);
  assert.equal(preparedCalls, 0);
  assert.equal(f.hooks(), 0);
  assert.equal(f.driver.apiClients, undefined);
});
