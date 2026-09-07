import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  createComputeDriver,
  selectedComputeWorkloadProfileCapability,
} from "../../apps/controller/src/composition/driver-factories/compute.ts";
import { fixedWorkloadDeployment } from "../../apps/controller/src/drivers/compute/kubernetes/resources/fixed-workload-renderer.ts";
import { deployment as historicalDeployment } from "../../apps/controller/src/drivers/compute/kubernetes/resources/harness.ts";
import { privateStateInitContainer } from "../../apps/controller/src/drivers/compute/kubernetes/resources/storage.ts";
import { deriveWorkloadProfileManifestV2 } from "@openclaw-enterprise/occ/workload-profiles/projections";
import { WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2 } from "../../packages/occ/src/workload-profiles/manifest.ts";
import { workloadProfileManifestFixture } from "../fixtures/workload-profile.mjs";
import {
  builderEnvelope,
  driverValues,
} from "../fixtures/kubernetes-resource-plan/driver-values.mjs";

// Controlled original source/operation peers only. Real renderer, Driver,
// factory and canonical resource/manifest functions execute without SDK calls.
// These fixtures grant no installed executable, native, identity or profile fit.
const digest = (n) => `sha256:${n.repeat(64)}`;
const definition = (ref) => ({ ref, version: 1, contentDigest: digest("1") });
const turn = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  let reject;
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
    executable: { path: `/app/${name}`, contentDigest: digest("3") },
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

function fixture(change = () => {}) {
  const v = values();
  change(v);
  const events = [];
  const unit = Object.freeze({ originalUnit: true });
  const definitionUnit = Object.freeze({ kind: "profile-definition", originalUnit: true });
  const definitionRequest = {
    scope: {
      installationId: v.request.installationId,
      namespaceId: v.request.namespaceId,
      component: "gateway-harness-pair",
    },
    selection: v.request.selection,
    manifest: v.derived,
  };
  let active = true;
  let live = true;
  let driver;
  let definitionSeen;
  let extraAssertion = () => undefined;
  let extraAcquisition = async () => undefined;
  let extraRelease = () => undefined;
  const io = {
    assertActive() {
      if (!active) throw new Error("closed operation");
    },
    poison(error) {
      events.push(["poison", error]);
    },
  };
  const source = {
    async acquireDefinition(selected, installed, request, ownedUnit, ownedIO) {
      events.push(["enroll-definition"]);
      assert.equal(selected, driver);
      assert.equal(ownedUnit, definitionUnit);
      assert.equal(ownedIO, io);
      assert.deepEqual(Object.keys(request).sort(), ["manifest", "scope", "selection"]);
      assert.deepEqual(request.scope, definitionRequest.scope);
      assert.deepEqual(request.selection, definitionRequest.selection);
      assert.deepEqual(request.manifest.canonicalBytes, v.derived.canonicalBytes);
      definitionSeen = installed;
      const view = request.manifest.canonicalBytes;
      view[0] = 0;
      assert.notEqual(
        request.manifest.canonicalBytes[0],
        0,
        "canonical bytes are detached on each read",
      );
      await extraAcquisition();
      return {
        get accounting() {
          events.push(["accounting"]);
          return v.mapping;
        },
        get release() {
          events.push(["capture-release"]);
          return async () => {
            events.push(["release"]);
            live = false;
            extraRelease();
          };
        },
        assertCurrent() {
          events.push(["fence"]);
          if (!live) throw new Error("source revoked");
          return extraAssertion();
        },
      };
    },
    async acquireRevision(selected, installed, request, manifest, use, ownedUnit, ownedIO) {
      events.push(["enroll"]);
      assert.equal(selected, driver, "only the original factory-selected object enrolls");
      assert.equal(ownedUnit, unit);
      assert.equal(ownedIO, io);
      assert.ok(isDeepStrictEqual(request, v.request));
      assert.ok(isDeepStrictEqual(use, v.use));
      // Canonical decoding uses null-prototype objects; the immutable owned
      // snapshot preserves their fields in structured-clone object records.
      assert.deepEqual(manifest, structuredClone(v.manifest));
      assert.notEqual(manifest, v.manifest);
      assert.equal(Object.isFrozen(manifest), true);
      definitionSeen = installed;
      await extraAcquisition();
      return {
        get accounting() {
          events.push(["accounting"]);
          return v.mapping;
        },
        get release() {
          events.push(["capture-release"]);
          return async () => {
            events.push(["release"]);
            live = false;
            extraRelease();
          };
        },
        assertCurrent() {
          events.push(["fence"]);
          if (!live) throw new Error("source revoked");
          return extraAssertion();
        },
      };
    },
  };
  driver = createComputeDriver(
    { id: "selected-compute", implementation: "occ/kubernetes-gvisor", configuration: v.options },
    { id: "configuration", capability: "configuration", implementation: "controlled" },
    undefined,
    undefined,
    source,
  );
  const partial = selectedComputeWorkloadProfileCapability(driver);
  const acquire = () =>
    partial.verifyRevisionRendererLocked(v.request, v.manifest, v.use, unit, io);
  return {
    ...v,
    driver,
    partial,
    source,
    events,
    unit,
    io,
    acquire,
    definitionUnit,
    definitionRequest,
    acquireDefinition: () =>
      partial.verifyRendererDefinitionLocked(definitionRequest, definitionUnit, io),
    definition: () => definitionSeen,
    revoke() {
      live = false;
    },
    endOperation() {
      active = false;
    },
    assertion(fn) {
      extraAssertion = fn;
    },
    acquisition(fn) {
      extraAcquisition = fn;
    },
    releasing(fn) {
      extraRelease = fn;
    },
  };
}

const count = (f, kind) => f.events.filter(([event]) => event === kind).length;

test("historical export is the exact fixed constructor", () => {
  assert.equal(historicalDeployment, fixedWorkloadDeployment);
});

test("factory retains exactly one built-in contribution and rejects lookalikes", () => {
  const f = fixture();
  assert.equal(f.partial, f.driver.getWorkloadProfileCapability());
  assert.equal(selectedComputeWorkloadProfileCapability({ ...f.driver }), undefined);
  assert.equal(
    selectedComputeWorkloadProfileCapability(new KubernetesComputeDriver(f.options)),
    undefined,
  );
  assert.equal(
    f.partial.acquire,
    undefined,
    "a renderer sublease is not the whole canonical source",
  );
  assert.equal(f.driver.apiClients, undefined);
});

test("missing authentic source cannot qualify copied profile values", async () => {
  const f = fixture();
  const unbound = new KubernetesComputeDriver(f.options);
  await assert.rejects(
    () =>
      unbound
        .getWorkloadProfileCapability()
        .verifyRevisionRendererLocked(f.request, f.manifest, f.use, f.unit, f.io),
    { code: "unavailable" },
  );
  assert.equal(count(f, "enroll"), 0);
  assert.equal(unbound.apiClients, undefined);
});

test("partial lease captures real complete constructor before current accounting read", async () => {
  const f = fixture();
  const held = await f.acquire();
  const installed = f.definition();
  assert.equal(installed.workload.construct, historicalDeployment);
  assert.equal(installed.workload.privateStateInit, privateStateInitContainer);
  assert.ok(Object.isFrozen(installed.workload.options));
  assert.ok(Object.isFrozen(installed.workload.images));
  assert.equal("target" in installed, false);
  assert.equal("use" in installed, false);
  assert.equal("template" in installed, false);
  assert.ok(
    f.events.findIndex(([event]) => event === "capture-release") <
      f.events.findIndex(([event]) => event === "accounting"),
  );
  f.endOperation();
  assert.equal(held.assertCurrent(), undefined, "retained owner fence outlives acquisition IO");
  await Promise.all([held.release(), held.release()]);
  assert.equal(count(f, "release"), 1);
  assert.throws(() => held.assertCurrent());
  assert.equal(f.driver.apiClients, undefined);
});

test("same selected renderer constructs the protected template with explicit Gateway class", async () => {
  const f = fixture();
  const held = await f.acquire();
  const input = {
    name: "selected-gateway",
    namespace: f.namespace,
    ownership: f.agentOwnership,
    image: f.options.images.gateway,
    serviceAccountName: "selected-sa",
    environment: {},
    loggingLevel: "info",
    resourcePlan: f.plan.gateway,
  };
  const template = f.driver.renderAdmittedGatewayTemplate(input, "gateway-specific-runsc");
  assert.equal(template.spec.template.spec.runtimeClassName, "gateway-specific-runsc");
  assert.equal(template.spec.template.spec.initContainers.length, 1);
  assert.equal(template.spec.template.spec.initContainers[0].name, "prepare-private-state");
  assert.deepEqual(
    template.spec.template.spec.initContainers[0].resources,
    f.plan.gateway.privateStateInit,
  );
  assert.deepEqual(template.spec.template.spec.containers[0].resources, f.plan.gateway.application);
  assert.equal(
    template.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem,
    true,
  );
  assert.equal(template.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(template.metadata.uid, undefined);
  assert.equal(template.metadata.resourceVersion, undefined);
  assert.throws(() => f.driver.renderAdmittedGatewayTemplate(input, " "));
  assert.throws(
    () =>
      f.driver.renderAdmittedGatewayTemplate(
        { ...input, image: `example.invalid/other@${digest("2")}` },
        "gateway-specific-runsc",
      ),
    /image differs/,
  );
  f.options.network.gatewayPort = 19999;
  assert.equal(
    f.driver.renderAdmittedGatewayTemplate(input, "gateway-specific-runsc").spec.template.spec
      .containers[0].ports[0].containerPort,
    8080,
  );
  await held.release();
  assert.equal(f.driver.apiClients, undefined);
});

for (const [name, change] of [
  [
    "legacy runtime/token launcher",
    (v) => {
      v.options.runtime = {
        transportSecretPrefix: "transport",
        modelSecretPrefix: "model",
        gatewayStorageClassName: "storage",
      };
    },
  ],
  [
    "projected platform credential",
    (v) => {
      v.options.servicePrincipalCredentials = {
        mode: "projectedServiceAccountToken",
        audience: "controller",
        expirationSeconds: 900,
      };
    },
  ],
  [
    "different selected artifact",
    (v) => {
      v.options.images.agent = `example.invalid/other@${digest("2")}`;
    },
  ],
]) {
  test(`original source lease cannot promote ${name}`, async () => {
    const f = fixture(change);
    await assert.rejects(f.acquire, { code: "unsupported-capability" });
    assert.equal(count(f, "release"), 1);
    assert.ok(count(f, "poison") >= 1);
    assert.equal(f.driver.apiClients, undefined);
  });
}

test("exact one-init accounting mapping rejects a foreign contribution", async () => {
  const f = fixture();
  f.mapping.gateway.privateStateInit = "foreign/helper";
  await assert.rejects(f.acquire);
  assert.equal(count(f, "release"), 1);
  assert.ok(count(f, "poison") >= 1);
});

test("actual configuration/resource conflict closes original source lease", async () => {
  const f = fixture((v) => {
    v.options.resources.agent.limits.cpu = "999m";
  });
  await assert.rejects(f.acquire);
  assert.equal(count(f, "release"), 1);
});

test("foreign original unit refuses before installed definition acquisition", async () => {
  const f = fixture();
  await assert.rejects(() =>
    f.partial.verifyRevisionRendererLocked(f.request, f.manifest, f.use, {}, f.io),
  );
  assert.equal(f.definition(), undefined);
  assert.equal(count(f, "release"), 0);
});

test("revoked source remains failed even if a later assertion changes", async () => {
  const f = fixture();
  const held = await f.acquire();
  f.revoke();
  assert.throws(() => held.assertCurrent(), /source revoked/);
  assert.throws(() => held.assertCurrent(), /source revoked/);
  await held.release();
  assert.equal(count(f, "release"), 1);
});

test("invalid deferred assertion drains before acquired source is released", async () => {
  const f = fixture();
  const pending = deferred();
  f.assertion(() => pending.promise);
  let settled = false;
  const result = assert.rejects(f.acquire, { code: "unavailable" }).then(() => {
    settled = true;
  });
  await turn();
  assert.equal(settled, false);
  assert.equal(count(f, "release"), 0);
  pending.reject(new Error("late assertion failure"));
  await result;
  assert.equal(count(f, "release"), 1);
});

test("closed original IO after acquisition wait retains and releases late lease", async () => {
  const f = fixture();
  const pending = deferred();
  f.acquisition(() => pending.promise);
  const result = assert.rejects(f.acquire, /closed operation/);
  await turn();
  f.endOperation();
  pending.resolve();
  await result;
  assert.equal(count(f, "release"), 1);
  assert.equal(count(f, "accounting"), 0);
});

test("faulty original poison cannot strand an acquired source lease", async () => {
  const f = fixture((v) => {
    v.mapping.gateway.application = "unbound";
  });
  f.io.poison = () => {
    throw new Error("faulty original poison");
  };
  await assert.rejects(f.acquire);
  assert.equal(count(f, "release"), 1);
});

test("an actual external factory result receives no built-in contribution", () => {
  const external = {
    id: "external-compute",
    implementation: "external/controlled",
    capability: "compute",
    async ensureNamespace() {},
    async deleteNamespace() {},
    async prepareRevision() {},
    async retireRevision() {},
  };
  const driver = createComputeDriver(
    { id: external.id, implementation: external.implementation, configuration: {} },
    { id: "configuration", capability: "configuration", implementation: "controlled" },
    undefined,
    {
      module: {
        createDriver() {
          return external;
        },
      },
    },
    {
      acquireRevision() {
        throw new Error("external cannot enroll built-in source");
      },
    },
  );
  assert.equal(driver, external);
  assert.equal(selectedComputeWorkloadProfileCapability(driver), undefined);
});

test("accounting getter failure occurs after cleanup capture", async () => {
  const f = fixture();
  Object.defineProperty(f.mapping.gateway, "application", {
    get() {
      throw new Error("bad accounting getter");
    },
  });
  await assert.rejects(f.acquire, /bad accounting getter/);
  assert.equal(count(f, "release"), 1);
});

test("definition-only original enrollment requires no revision, Use or physical target", async () => {
  const f = fixture();
  const held = await f.acquireDefinition();
  assert.equal(count(f, "enroll-definition"), 1);
  assert.equal(count(f, "enroll"), 0);
  assert.equal(f.definition().workload.construct, fixedWorkloadDeployment);
  assert.equal(held.assertCurrent(), undefined);
  await held.release();
  assert.equal(count(f, "release"), 1);
  assert.equal(f.driver.apiClients, undefined);
});

for (const field of ["use", "revision", "target"]) {
  test(`definition qualification refuses an added ${field} operand`, async () => {
    const f = fixture();
    f.definitionRequest[field] = {};
    await assert.rejects(f.acquireDefinition, { code: "invalid-record" });
    assert.equal(count(f, "enroll-definition"), 0);
    assert.ok(count(f, "poison") >= 1);
  });
}

test("definition canonical bytes cannot be paired with copied divergent derived values", async () => {
  const f = fixture();
  f.definitionRequest.manifest = {
    ...f.derived,
    digests: { ...f.derived.digests, runtimeProfileDigest: digest("f") },
  };
  await assert.rejects(f.acquireDefinition, { code: "invalid-record" });
  assert.equal(count(f, "enroll-definition"), 0);
});

test("revision unit cannot substitute for original definition unit", async () => {
  const f = fixture();
  await assert.rejects(() =>
    f.partial.verifyRendererDefinitionLocked(f.definitionRequest, f.unit, f.io),
  );
  assert.equal(f.definition(), undefined);
});

test("definition source also drains invalid deferred original assertions", async () => {
  const f = fixture();
  const pending = deferred();
  f.assertion(() => pending.promise);
  let settled = false;
  const result = assert.rejects(f.acquireDefinition, { code: "unavailable" }).then(() => {
    settled = true;
  });
  await turn();
  assert.equal(settled, false);
  assert.equal(count(f, "release"), 0);
  pending.resolve();
  await result;
  assert.equal(count(f, "release"), 1);
});

test("reentrant original cleanup shares one published release promise", async () => {
  const f = fixture();
  const held = await f.acquire();
  let reentered;
  let calls = 0;
  f.releasing(() => {
    if (++calls === 1) reentered = held.release();
  });
  const first = held.release();
  await first;
  assert.equal(reentered, first);
  assert.equal(count(f, "release"), 1);
});
