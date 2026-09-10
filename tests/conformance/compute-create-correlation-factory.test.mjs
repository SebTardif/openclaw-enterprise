import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import {
  GVISOR_IMPLEMENTATION,
  KubernetesComputeDriver,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  composeSelectedComputeRendererContribution,
  createComputeDriver,
  createSelectedComputeCorrelationObservationOwner,
  selectedComputeRendererOwner,
  selectedComputeWorkloadProfileCapability,
} from "../../apps/controller/src/composition/driver-factories/compute.ts";
import { fixedWorkloadDeployment } from "../../apps/controller/src/drivers/compute/kubernetes/resources/fixed-workload-renderer.ts";

const { options: originalOptions } = JSON.parse(
  readFileSync(
    new URL("../fixtures/kubernetes-lifecycle-collaborators/inputs.json", import.meta.url),
    "utf8",
  ),
);

// Actual factory, Kubernetes constructor and DriverSelection. The controlled
// cluster operand exercises forwarding and local custody only. It supplies no
// authenticated producer, native purpose, protected writer or physical evidence.
test("factory correlation owner preserves original construction, association and held selection", async (t) => {
  const options = structuredClone(originalOptions);
  delete options.runtime;
  options.isolationProfile = "gvisor-systrap";
  options.servicePrincipalCredentials = { mode: "disabled" };
  options.images = {
    gateway: `example.invalid/gateway@sha256:${"1".repeat(64)}`,
    agent: `example.invalid/harness@sha256:${"2".repeat(64)}`,
    requireImmutableDigest: true,
  };
  const configuration = {
    id: "controlled-configuration",
    capability: "configuration",
    implementation: "controlled",
  };
  const rendererSource = Object.freeze({
    acquireDefinition() {
      assert.fail("correlation construction must not acquire a renderer definition");
    },
    acquireRevision() {
      assert.fail("correlation construction must not acquire a renderer revision");
    },
  });
  let clusterReads = 0;
  const dependencies = Object.freeze({
    // Intentionally only this operation's physical comparison operand, as in
    // the original observer cases; this is not complete production dependencies.
    get clusterRef() {
      clusterReads += 1;
      return "controlled-cluster";
    },
  });
  const driver = createComputeDriver(
    { id: "factory-correlation", implementation: GVISOR_IMPLEMENTATION, configuration: options },
    configuration,
    undefined,
    undefined,
    rendererSource,
    dependencies,
  );
  assert.equal(Object.getPrototypeOf(driver), KubernetesComputeDriver.prototype);
  assert.equal(
    clusterReads,
    0,
    "factory forwards the original operand without copying its getters",
  );
  const capability = selectedComputeWorkloadProfileCapability(driver);
  const renderer = selectedComputeRendererOwner(driver);
  assert.equal(capability, driver.getWorkloadProfileCapability());
  assert.equal(renderer, driver.getRendererOwner());
  const definition = renderer.definition();
  assert.equal(definition.workload.construct, fixedWorkloadDeployment);
  assert.equal(capability.withSource, undefined);

  const selection = new DriverSelection();
  selection.registerDriver(driver);
  selection.selectDriver("compute", driver.id);
  const replacement = new KubernetesComputeDriver(options, { id: "replacement-compute" });
  selection.registerDriver(replacement);
  const wrongSelection = new DriverSelection();
  wrongSelection.registerDriver(replacement);
  wrongSelection.selectDriver("compute", replacement.id);
  assert.throws(() => createSelectedComputeCorrelationObservationOwner(driver, wrongSelection), {
    message: "The expected Driver is not the current selection.",
  });
  assert.equal(clusterReads, 0, "wrong selection refuses before reading the dependency operand");

  // A late replacement is a failure sentinel, not a substitute positive owner.
  // The accessor must still run the actual method captured by the real factory.
  let lateMethodReads = 0;
  Object.defineProperty(driver, "createCorrelationObservationOwner", {
    configurable: true,
    get() {
      lateMethodReads += 1;
      throw new Error("late replaceable Driver method was read");
    },
  });
  const owner = createSelectedComputeCorrelationObservationOwner(driver, selection);
  t.after(async () => {
    await owner.close();
  });
  assert.equal(lateMethodReads, 0);
  assert.equal(clusterReads, 1);
  assert.equal(driver.apiClients, undefined, "owner construction performs no provider acquisition");
  assert.throws(() => selection.selectDriver("compute", replacement.id));
  assert.equal(selection.selectedDriver("compute"), driver);

  const unavailable = { message: "The selected Compute has no bundled gVisor runtime observer." };
  assert.throws(
    () => createSelectedComputeCorrelationObservationOwner({ ...driver }, selection),
    unavailable,
  );
  assert.throws(
    () => createSelectedComputeCorrelationObservationOwner(replacement, wrongSelection),
    unavailable,
  );
  const copiedSelection = Object.freeze({ selectedDriver: () => driver });
  assert.throws(() => createSelectedComputeCorrelationObservationOwner(driver, copiedSelection));
  assert.equal(clusterReads, 1);

  // The source installed in argument five still occupies the original one-time
  // receiver after argument six and the physical owner have been captured.
  assert.throws(
    () =>
      composeSelectedComputeRendererContribution(driver, selection, {
        definition() {
          assert.fail("replacement definition was enrolled");
        },
        revision() {
          assert.fail("replacement revision was enrolled");
        },
      }),
    { code: "unavailable" },
  );
  assert.equal(selectedComputeWorkloadProfileCapability(driver), capability);
  assert.equal(driver.getWorkloadProfileCapability(), capability);
  assert.equal(selectedComputeRendererOwner(driver), renderer);
  assert.equal(renderer.definition(), definition);

  let externalMethodReads = 0;
  const external = {
    id: "external-correlation",
    implementation: GVISOR_IMPLEMENTATION,
    capability: "compute",
    async ensureNamespace() {},
    async deleteNamespace() {},
    async prepareRevision() {},
    async retireRevision() {},
    get createCorrelationObservationOwner() {
      externalMethodReads += 1;
      throw new Error("external method cannot enroll bundled observation");
    },
  };
  const externalDriver = createComputeDriver(
    { id: external.id, implementation: external.implementation, configuration: {} },
    configuration,
    undefined,
    { module: { createDriver: () => external } },
    rendererSource,
    dependencies,
  );
  assert.equal(externalDriver, external);
  assert.throws(
    () => createSelectedComputeCorrelationObservationOwner(externalDriver, selection),
    unavailable,
  );
  assert.equal(externalMethodReads, 0);
  assert.equal(selectedComputeWorkloadProfileCapability(externalDriver), undefined);
  assert.equal(clusterReads, 1, "external construction never consumes bundled dependencies");

  const missing = createComputeDriver(
    { id: "missing-dependencies", implementation: GVISOR_IMPLEMENTATION, configuration: options },
    configuration,
  );
  const missingSelection = new DriverSelection();
  missingSelection.registerDriver(missing);
  missingSelection.registerDriver(replacement);
  missingSelection.selectDriver("compute", missing.id);
  assert.throws(() => createSelectedComputeCorrelationObservationOwner(missing, missingSelection));
  assert.equal(missing.apiClients, undefined);
  assert.equal(
    missingSelection.selectDriver("compute", replacement.id),
    replacement,
    "failed owner construction releases its original selection hold",
  );

  const ordinaryOptions = structuredClone(options);
  delete ordinaryOptions.isolationProfile;
  const ordinary = createComputeDriver(
    { id: "ordinary-compute", implementation: "occ/kubernetes", configuration: ordinaryOptions },
    configuration,
    undefined,
    undefined,
    undefined,
    dependencies,
  );
  const ordinarySelection = new DriverSelection();
  ordinarySelection.registerDriver(ordinary);
  ordinarySelection.selectDriver("compute", ordinary.id);
  assert.throws(
    () => createSelectedComputeCorrelationObservationOwner(ordinary, ordinarySelection),
    unavailable,
  );
  assert.equal(clusterReads, 1, "the non-gVisor branch cannot consume the physical source");

  const closing = owner.close();
  assert.equal(owner.close(), closing, "owner cleanup retains the original single join");
  await closing;
  assert.equal(selection.selectDriver("compute", replacement.id), replacement);
  assert.throws(() => owner.begin(Object.freeze({}), {}, {}), "closed custody stays closed");
  assert.equal(driver.apiClients, undefined);
  assert.equal(lateMethodReads, 0);
  assert.equal(clusterReads, 1);
});

// These protected-input shapes exercise the actual constructor only. The native
// paths are deliberately unavailable; no capture, provider read or enrollment is
// performed or inferred from successful construction.
test("factory forwards selected CNI input without replacing original ownership", async (t) => {
  const options = structuredClone(originalOptions);
  delete options.runtime;
  options.isolationProfile = "gvisor-systrap";
  options.servicePrincipalCredentials = { mode: "disabled" };
  options.images = {
    gateway: `example.invalid/gateway@sha256:${"1".repeat(64)}`,
    agent: `example.invalid/harness@sha256:${"2".repeat(64)}`,
    requireImmutableDigest: true,
  };
  const configuration = {
    id: "controlled-cni-configuration",
    capability: "configuration",
    implementation: "controlled",
  };
  const dependencies = Object.freeze({ clusterRef: "controlled-cluster" });
  const nodeNetwork = Object.freeze({
    client: Object.freeze({
      binaryPath: "/unavailable-node-observer/oce-node-observer",
      binaryDigest: `sha256:${"3".repeat(64)}`,
      clientConfiguration: Object.freeze({
        enrollment: Object.freeze({
          clusterRef: "controlled-cluster",
          namespace: "controlled-namespace",
          nodeName: "controlled-node",
          nodeUID: "controlled-node-uid",
        }),
        workloadSocket: "/unavailable-node-observer/workload.sock",
        enrollmentDigest: `sha256:${"4".repeat(64)}`,
      }),
    }),
    networkName: "pods",
    interfaceName: "eth0",
  });
  const construct = (id, observations, network) =>
    createComputeDriver(
      { id, implementation: GVISOR_IMPLEMENTATION, configuration: options },
      configuration,
      undefined,
      undefined,
      undefined,
      observations,
      network,
    );
  const driver = construct("factory-cni", dependencies, nodeNetwork);
  assert.equal(Object.getPrototypeOf(driver), KubernetesComputeDriver.prototype);
  assert.equal(
    selectedComputeWorkloadProfileCapability(driver),
    driver.getWorkloadProfileCapability(),
  );
  assert.equal(selectedComputeRendererOwner(driver), driver.getRendererOwner());
  assert.equal(driver.apiClients, undefined);

  // If the factory drops argument seven these original constructor refusals
  // would disappear. The node input cannot compensate for absent or mismatched
  // observation dependencies, nor bypass the selected interface grammar.
  const unavailable = { message: "The exact Kubernetes runtime observation is unavailable." };
  assert.throws(() => construct("cni-without-observations", undefined, nodeNetwork), unavailable);
  assert.throws(
    () => construct("cni-wrong-cluster", { clusterRef: "another-cluster" }, nodeNetwork),
    unavailable,
  );
  assert.throws(
    () =>
      construct("cni-wrong-interface", dependencies, {
        ...nodeNetwork,
        interfaceName: "eth0/other",
      }),
    unavailable,
  );

  // Omitting the optional CNI source retains the original observation-only
  // construction. Both instances still require their own original selection.
  const omitted = construct("factory-no-cni", dependencies, undefined);
  assert.equal(Object.getPrototypeOf(omitted), KubernetesComputeDriver.prototype);
  assert.equal(omitted.apiClients, undefined);
  const selection = new DriverSelection();
  selection.registerDriver(driver);
  selection.registerDriver(omitted);
  selection.selectDriver("compute", omitted.id);
  assert.throws(() => createSelectedComputeCorrelationObservationOwner(driver, selection), {
    message: "The expected Driver is not the current selection.",
  });
  const omittedOwner = createSelectedComputeCorrelationObservationOwner(omitted, selection);
  t.after(async () => {
    await omittedOwner.close();
  });
  assert.throws(() => selection.selectDriver("compute", driver.id));
  await omittedOwner.close();
  assert.equal(selection.selectDriver("compute", driver.id), driver);
  const owner = createSelectedComputeCorrelationObservationOwner(driver, selection);
  t.after(async () => {
    await owner.close();
  });
  assert.throws(() => selection.selectDriver("compute", omitted.id));
  await owner.close();
  assert.equal(selection.selectDriver("compute", omitted.id), omitted);
  assert.equal(driver.apiClients, undefined);
  assert.equal(omitted.apiClients, undefined);
});
