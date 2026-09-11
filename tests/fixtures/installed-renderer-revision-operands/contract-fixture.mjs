import assert from "node:assert/strict";
import { DriverSelection } from "../../../packages/occ/src/application/driver-selection.ts";
import { deriveWorkloadProfileManifestV2 } from "../../../packages/occ/src/workload-profiles/projections.ts";
import { workloadProfileDigest } from "../../../packages/occ/src/workload-profiles/canonical.ts";
import { WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2 } from "../../../packages/occ/src/workload-profiles/manifest.ts";
import {
  createComputeDriver,
  selectedComputeRendererOwner,
} from "../../../apps/controller/src/composition/driver-factories/compute.ts";
import { InstalledKubernetesRevisionOperandsSupplier } from "../../../apps/controller/src/drivers/compute/kubernetes/installed-renderer-revision-operands.ts";
import { normalizeKubernetesResourcePlan } from "../../../apps/controller/src/drivers/compute/kubernetes/resources/revision-resource-plan.ts";
import { workloadProfileManifestFixture } from "../workload-profile.mjs";
import { driverValues } from "../kubernetes-resource-plan/driver-values.mjs";

export const digest = (value) => `sha256:${value.repeat(64)}`;
export const turn = () => new Promise(setImmediate);
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function profile(values) {
  const definition = (ref) => ({ ref, version: 1, contentDigest: digest("1") });
  const image = (component) => ({
    reference: `example.invalid/${component}@${digest(component === "gateway" ? "2" : "3")}`,
    platformDigest: digest(component === "gateway" ? "2" : "3"),
    executable: { path: `/app/${component}`, contentDigest: digest("4") },
  });
  const process = (component) => ({
    argv: [
      { kind: "literal", value: `/app/${component}` },
      { kind: "binding", name: "configuration-path" },
    ],
    environmentDefinition: definition(`${component}-environment`),
    runtimeClass: component === "gateway" ? "selected-gateway-runsc" : "oce-gvisor-systrap",
    protocolVersion: 1,
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    mounts: ["state", "home", "tmp"].map((kind) => ({
      name: `${component}-${kind}`,
      path: `/${kind}`,
      store: definition(`${component}-${kind}`),
      access: "read-write",
    })),
  });
  const content = {
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
        handler: "oce-gvisor-systrap",
        platform: "systrap",
      },
      resourceEnvelope: {
        podAndRuntimeAccounting: { status: "selected", envelope: values.source.envelope },
      },
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
  return deriveWorkloadProfileManifestV2(new TextEncoder().encode(JSON.stringify(content)));
}

/** Contract-faithful State/candidate, artifact, behavior and material doubles
 * stop at this component boundary. Actual factory membership, DriverSelection,
 * renderer constructors, resource normalizer and lifecycle dispatcher execute.
 * This fixture cannot demonstrate PostgreSQL membership, material custody,
 * protected target creation, installed image semantics or full profile admission. */
export function fixture() {
  const values = driverValues();
  for (const component of ["gateway", "harness"]) {
    values.source.envelope.observations[component] = {
      status: "unavailable",
      ownerRef: "controlled-observer",
      reason: "producer-port-unavailable",
    };
  }
  values.plan = normalizeKubernetesResourcePlan(values.source.envelope, values.source.mapping);
  const derived = profile(values);
  const manifest = derived.content;
  const options = structuredClone(values.options);
  delete options.runtime;
  options.isolationProfile = "gvisor-systrap";
  options.servicePrincipalCredentials = { mode: "disabled" };
  options.images = {
    gateway: manifest.artifactSet.gateway.reference,
    agent: manifest.artifactSet.harness.reference,
    requireImmutableDigest: true,
  };
  const events = [];
  const controls = {};
  const releases = {};
  const abort = new AbortController();
  let ioActive = true;
  let stateActive = true;
  let hooks = 0;
  const configurationOperations = { create: 0, read: 0, update: 0, delete: 0, validate: 0 };
  function assertNoConfigurationCalls() {
    assert.deepEqual(configurationOperations, {
      create: 0,
      read: 0,
      update: 0,
      delete: 0,
      validate: 0,
    });
  }
  const configuration = {
    id: "operand-configuration",
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
        launch.environment.ORIGINAL_MATERIAL = "opaque-owned-reference";
      },
    },
  };
  // Supplier construction deliberately precedes Compute construction. Original
  // source methods below resolve their unit state only when invoked later.
  const reader = {
    async readCapturedRevision(actualRequest, actualUse, actualUnit, actualIO) {
      events.push("candidate-acquire");
      assert.equal(actualRequest, request);
      assert.equal(actualUse, use);
      assert.equal(actualUnit, unit);
      assert.equal(actualIO, io);
      await controls.candidateWait?.();
      const lease = owned("candidate", { revision, sourceIdentity });
      lease.assertCurrent = () => {
        if (!stateActive || releases.candidate) throw new Error("original State scope expired");
        return controls.candidateCurrent?.();
      };
      controls.candidateLease = lease;
      return lease;
    },
  };
  function inspectOriginal(input) {
    assert.equal(input.candidate.revision, revision);
    assert.equal(input.candidate.sourceIdentity, sourceIdentity);
    assert.equal(input.original[0], driver);
    assert.equal(input.original[5], unit);
    controls.borrowedCandidate = input.candidate;
    input.candidate.assertCurrent();
  }
  const sources = {
    async acquireStaticMaterialPlacement(input) {
      events.push("static-material-acquire");
      inspectOriginal(input);
      await controls.materialWait?.();
      return owned("material", material, input.candidate);
    },
    async acquirePreparedMaterialPlacement(input) {
      events.push("prepared-material-acquire");
      inspectOriginal(input);
      assert.equal(input.launch, preparedLaunch);
      await controls.materialWait?.();
      return owned(
        "material",
        { ...material, ...preparedMaterial, ...controls.preparedOverride },
        input.candidate,
      );
    },
  };
  const supplier = new InstalledKubernetesRevisionOperandsSupplier(reader, sources);
  const selection = new DriverSelection();
  // Register/select the same configuration collaborator before Compute so the
  // original selection rebuild retains its actual lifecycle hook.
  selection.registerDriver(configuration);
  selection.selectDriver("configuration", configuration.id);
  const driver = createComputeDriver(
    { id: "operand-compute", implementation: "occ/kubernetes-gvisor", configuration: options },
    configuration,
  );
  const owner = selectedComputeRendererOwner(driver);
  selection.registerDriver(driver);
  selection.selectDriver("compute", driver.id);
  const construction = owner.acquire(selection);
  const revision = structuredClone(values.revision);
  revision.compute = { id: driver.id, implementation: driver.implementation };
  const sourceIdentity = Object.freeze({});
  const selectedProfile = {
    manifestRef: "operand-manifest",
    manifestDigest: derived.digests.manifestDigest,
    admissionRef: "operand-admission",
    admissionVersion: 1,
  };
  const request = {
    schemaVersion: 2,
    installationId: "operand-installation",
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
    configurationRef: revision.configurationId,
    configurationVersion: revision.configurationGeneration,
    selection: selectedProfile,
  };
  const use = {
    schemaVersion: 2,
    component: "gateway-harness-pair",
    installationId: request.installationId,
    namespaceId: request.namespaceId,
    canonicalFormat: "oce.workload-profile.canonical-json.v1",
    ...selectedProfile,
    profileRefs: Object.fromEntries(
      Object.entries(derived.roleDigests).map(([role, contentDigest]) => [
        role,
        { ref: `${role}-profile`, version: 1, contentDigest },
      ]),
    ),
    admittedConfigurationDigest: digest("5"),
  };
  const unit = {
    kind: "deployment",
    installationId: request.installationId,
    namespaceId: request.namespaceId,
    agentId: request.agentId,
    operationRef: "operand-operation",
    platform: {},
    signal: abort.signal,
    retain() {
      throw new Error("outer source owns retention");
    },
  };
  const io = {
    assertActive() {
      if (!ioActive) throw new Error("acquisition IO closed");
    },
    poison(error) {
      throw error;
    },
  };
  const artifacts = {
    images: Object.fromEntries(
      ["gateway", "harness"].map((role) => [
        role,
        {
          reference: manifest.artifactSet[role].reference,
          descriptor: {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: manifest.artifactSet[role].platformDigest,
            size: 123,
          },
        },
      ]),
    ),
    definition: {
      mediaType: "application/vnd.openclaw.installed-renderer-definition.v1+json",
      digest: digest("6"),
      size: 123,
    },
    assertCurrent() {
      return controls.artifactCurrent?.();
    },
    async release() {
      throw new Error("borrowed artifacts must not be released");
    },
  };
  const behavior = {
    projection: {
      artifactSet: manifest.artifactSet,
      launchConfiguration: manifest.launchConfiguration,
    },
    accounting: values.source.mapping,
    assertCurrent() {
      return controls.behaviorCurrent?.();
    },
    async release() {
      throw new Error("borrowed behavior must not be released");
    },
  };
  const material = {
    namespace: values.namespace,
    gateway: {
      name: "original-gateway-service",
      serviceAccountName: "original-gateway-service-sa",
      servicePrincipalId: "original-gateway-principal",
      environment: { GATEWAY_MATERIAL: "static-reference" },
      enabledChannels: [],
      secretEnvironment: [],
    },
    harness: { environment: { ORIGINAL_MATERIAL: "opaque-owned-reference" } },
  };
  let preparedLaunch;
  let preparedMaterial;
  function owned(name, value, upstreamCandidate) {
    const result = {
      ...value,
      assertCurrent() {
        if (releases[name]) throw new Error(`${name} released`);
        if (upstreamCandidate !== undefined) {
          controls.materialCandidateChecks = (controls.materialCandidateChecks ?? 0) + 1;
          upstreamCandidate.assertCurrent();
        }
        return controls[`${name}Current`]?.();
      },
      async release() {
        releases[name] = (releases[name] ?? 0) + 1;
        events.push(`${name}-release`);
        await controls[`${name}Release`]?.();
      },
    };
    if (name === "material") controls.materialLease = result;
    return result;
  }
  const input = () => ({
    artifacts,
    behavior,
    original: Object.freeze([driver, owner.definition(), request, manifest, use, unit, io]),
  });
  async function prepare() {
    // This is the real dispatcher action and is intentionally outside either
    // supplier read. The prepared fixture does not simulate a fake launch token.
    preparedLaunch = await driver.lifecycle.beforeWorkloadStart(revision);
    assert.equal(hooks, 1);
    assert.deepEqual(preparedLaunch.environment, { ORIGINAL_MATERIAL: "opaque-owned-reference" });
    assertNoConfigurationCalls();
    const staticLease = await supplier.acquireRevisionOperands(input());
    const gateway = staticLease.inputs.gateway[0];
    const pod = staticLease.outputs.gateway.spec.template.spec;
    const stores = values.plan.gateway.values.envelope.gateway.value.storage.value;
    const gatewayPlan = {
      target: {
        clusterRef: "controlled-original-cluster",
        namespace: {
          name: material.namespace,
          uid: "controlled-original-namespace-uid",
          resourceVersion: "1",
        },
        deploymentName: gateway.name,
      },
      argv: ["/usr/bin/node", "/app/apps/gateway/src/main.mjs"],
      runtimeClassName: manifest.launchConfiguration.gateway.runtimeClass,
      environment: pod.containers[0].env,
      volumes: pod.volumes,
      mounts: pod.containers[0].volumeMounts,
      resources: values.plan.gateway,
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
    const gatewayOutput = construction.gatewayDeployment(gateway, gatewayPlan);
    // Expected inventory is independently spelled out for the actual fixed
    // one-application/one-init constructors; it does not call the tested projector.
    const outputs = { gateway: gatewayOutput, harness: staticLease.outputs.harness };
    const containers = [];
    for (const component of ["gateway", "harness"]) {
      const shape = outputs[component].spec.template.spec;
      for (const [phase, container] of [
        ["application", shape.containers[0]],
        ["init", shape.initContainers[0]],
      ]) {
        containers.push({
          component,
          phase,
          name: container.name,
          reference: artifacts.images[component].reference,
          platformDigest: artifacts.images[component].descriptor.digest,
        });
      }
    }
    const imageSet = { schemaVersion: 1, sourceDefinition: artifacts.definition, containers };
    preparedMaterial = {
      gatewayPlan,
      imageSet,
      imageSetDigest: workloadProfileDigest("imageSetDigest", imageSet),
    };
    await staticLease.release();
    delete releases.candidate;
    delete releases.material;
    events.length = 0;
    return { launch: preparedLaunch, preparedMaterial };
  }
  return {
    supplier,
    reader,
    sources,
    input,
    driver,
    owner,
    selection,
    construction,
    revision,
    material,
    artifacts,
    behavior,
    request,
    use,
    unit,
    io,
    abort,
    events,
    releases,
    controls,
    prepare,
    hooks: () => hooks,
    closeIO() {
      ioActive = false;
    },
    closeState() {
      stateActive = false;
    },
    // Every test registers this outside expected-refusal callbacks. A forbidden
    // Configuration call cannot disappear inside an expected supplier failure.
    cleanup() {
      construction.release();
      assertNoConfigurationCalls();
    },
  };
}
