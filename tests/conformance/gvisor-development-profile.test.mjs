import assert from "node:assert/strict";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import {
  GVISOR_IMPLEMENTATION,
  GVISOR_RUNTIME_CLASS,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";

// These offline tests exercise the real parser, manifests, and revision preparation.
// SDK transport responses do not establish live RuntimeClass or kernel isolation.
const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const namespace = kubernetesNamespaceName(namespaceId);
const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);

function options(overrides = {}) {
  const configured = createInstallationDriverConfiguration().drivers.compute.configuration;
  delete configured.runtime;
  return {
    ...configured,
    isolationProfile: "gvisor-systrap",
    authentication: {
      mode: "kubeconfig",
      kubeconfigPath: "/tmp/oce-gvisor-offline-conformance/not-a-live-kubeconfig",
      context: "k3d-oce-gvisor-conformance",
    },
    ...overrides,
  };
}

function revisionFor(driver, overrides = {}) {
  return {
    id: "rev_00000000-0000-4000-8000-000000000001",
    namespaceId,
    agentId: "agt_00000000-0000-4000-8000-000000000001",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: admitLoggingConfiguration(
      { gateway: { controlUi: { enabled: false } } },
      "info",
    ),
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "sp_00000000-0000-4000-8000-000000000001",
    createdAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

async function installationPath(t, configuration) {
  const directory = await mkdtemp(join(tmpdir(), "oce-gvisor-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "installation.yaml");
  // JSON is YAML syntax and goes through the application's actual YAML/schema parser.
  await writeFile(path, JSON.stringify(configuration), "utf8");
  return path;
}

async function load(t, configuration, mode = "development") {
  return loadInstallationConfiguration({
    mode,
    environment: { OCC_CONFIG_PATH: await installationPath(t, configuration) },
  });
}

function installation() {
  const configured = createInstallationDriverConfiguration();
  configured.occ.cluster = "gvisor-offline-conformance";
  configured.drivers.compute.configuration = options();
  configured.drivers.configuration.configuration.authentication = options().authentication;
  configured.drivers.secret.configuration.authentication = options().authentication;
  return configured;
}

function fixture({
  driver = new KubernetesComputeDriver(options()),
  revision,
  mutateAgent,
  active = false,
} = {}) {
  revision ??= revisionFor(driver);
  const gatewayName = `gateway-${hash(revision.agentId)}`;
  const agentName = `agent-${hash(revision.agentId)}`;
  const revisionName = `${agentName}-rev-${hash(revision.id)}`;
  const gatewayOwnership = { namespaceId, agentId: revision.agentId };
  const agentOwnership = { ...gatewayOwnership, servicePrincipalId: revision.servicePrincipalId };
  const objects = new Map();
  const key = (kind, name) => `${kind}:${name}`;
  const save = (object) => {
    object.metadata.uid = `uid-${object.metadata.name}`;
    object.metadata.resourceVersion = "17";
    objects.set(key(object.kind, object.metadata.name), object);
  };
  const observedNamespace = {
    ...driver.manifest("v1", "Namespace", namespace, { namespaceId }),
    status: { phase: "Active" },
  };
  save(observedNamespace);
  for (const policy of driver.networkPolicies({ namespaceId }, namespace)) save(policy);
  const gateway = driver.deployment(
    gatewayName,
    gatewayOwnership,
    namespace,
    options().images.gateway,
    gatewayName,
    "gateway",
    {},
    driver.gatewayConfiguration(revision).loggingLevel,
    driver.gatewayConfiguration(revision),
  );
  const agent = driver.deployment(
    revisionName,
    { ...agentOwnership, revisionId: revision.id },
    namespace,
    options().images.agent,
    agentName,
    "agent",
    {},
    driver.gatewayConfiguration(revision).loggingLevel,
  );
  // Readiness is explicit observation data, never inferred from an accepted patch.
  for (const deployment of [gateway, agent]) {
    deployment.metadata.generation = 2;
    deployment.status = { observedGeneration: 2, readyReplicas: 1 };
    save(deployment);
  }
  mutateAgent?.(agent);
  const gatewayService = driver.service(gatewayName, gatewayOwnership, namespace, {
    "app.kubernetes.io/name": gatewayName,
  });
  save(gatewayService);
  const agentService = driver.service(
    agentName,
    agentOwnership,
    namespace,
    active
      ? {
          "openclaw.dev/agent": revision.agentId,
          "openclaw.dev/revision": revision.id,
          "openclaw.dev/workload-role": "agent",
          "app.kubernetes.io/name": revisionName,
        }
      : { "app.kubernetes.io/name": `${agentName}-inactive` },
  );
  save(agentService);
  const writes = [];
  const podRequests = [];
  const containment = [];
  let observation = { items: [] };
  let patchError;
  let routePatchError;
  let deleteError;
  let runtimeClassError;
  let podError;
  let runtimeClass = {
    apiVersion: "node.k8s.io/v1",
    kind: "RuntimeClass",
    metadata: { name: GVISOR_RUNTIME_CLASS },
    handler: GVISOR_RUNTIME_CLASS,
  };
  const runtimeClassRequests = [];
  const clients = {
    core: {
      async listNamespace({ labelSelector }) {
        assert.equal(labelSelector, `openclaw.dev/namespace=${namespaceId}`);
        return { items: [structuredClone(observedNamespace)] };
      },
      async readNamespace({ name }) {
        assert.equal(name, namespace);
        return structuredClone(observedNamespace);
      },
      async listNamespacedPod(request) {
        podRequests.push(structuredClone(request));
        assert.equal(request.namespace, namespace);
        assert.equal(
          request.labelSelector,
          `openclaw.dev/agent=${revision.agentId},openclaw.dev/revision=${revision.id},openclaw.dev/workload-role=agent`,
        );
        if (podError) throw podError;
        return structuredClone(observation);
      },
    },
    objects: {
      async read(request) {
        runtimeClassRequests.push(structuredClone(request));
        assert.deepEqual(request, {
          apiVersion: "node.k8s.io/v1",
          kind: "RuntimeClass",
          metadata: { name: GVISOR_RUNTIME_CLASS },
        });
        if (runtimeClassError) throw runtimeClassError;
        if (runtimeClass === undefined)
          throw Object.assign(new Error("RuntimeClass not found"), { statusCode: 404 });
        return structuredClone(runtimeClass);
      },
    },
    apps: {
      async deleteNamespacedDeployment(request) {
        containment.push({ kind: "Deployment", request: structuredClone(request) });
        if (deleteError) throw deleteError;
      },
    },
    networking: {},
    discovery: {
      async listNamespacedEndpointSlice({ namespace: requestedNamespace, labelSelector }) {
        assert.equal(requestedNamespace, namespace);
        assert.equal(labelSelector, `kubernetes.io/service-name=${gatewayName}`);
        return {
          items: [
            {
              metadata: {
                labels: { "kubernetes.io/service-name": gatewayName },
                ownerReferences: [
                  { kind: "Service", name: gatewayName, uid: gatewayService.metadata.uid },
                ],
              },
              endpoints: [{ conditions: { ready: true } }],
            },
          ],
        };
      },
    },
  };
  for (const [api, kinds] of [
    [clients.core, ["ConfigMap", "Service", "ServiceAccount", "PersistentVolumeClaim"]],
    [clients.apps, ["Deployment"]],
    [clients.networking, ["NetworkPolicy"]],
  ]) {
    for (const kind of kinds) {
      api[`readNamespaced${kind}`] = async ({ name, namespace: requestedNamespace }) => {
        assert.equal(requestedNamespace, namespace);
        const object = objects.get(key(kind, name));
        if (object === undefined) throw Object.assign(new Error("not found"), { statusCode: 404 });
        return structuredClone(object);
      };
      api[`patchNamespaced${kind}`] = async (request) => {
        const { body, namespace: requestedNamespace } = request;
        assert.equal(requestedNamespace, namespace);
        if (Array.isArray(body)) {
          assert.equal(kind, "Service");
          containment.push({ kind, request: structuredClone(request) });
          if (routePatchError) throw routePatchError;
          return;
        }
        writes.push(structuredClone(body));
        if (body.kind === "Deployment" && body.metadata.name === revisionName && patchError)
          throw patchError;
      };
    }
  }
  driver.apiClients = Promise.resolve(clients);
  return {
    driver,
    revision,
    gateway,
    agent,
    agentService,
    writes,
    containment,
    podRequests,
    runtimeClassRequests,
    setRuntimeClass(value) {
      runtimeClass = value;
    },
    setObservation(value) {
      observation = value;
    },
    setPatchError(value) {
      patchError = value;
    },
    setRoutePatchError(value) {
      routePatchError = value;
    },
    setDeleteError(value) {
      deleteError = value;
    },
    setRuntimeClassError(value) {
      runtimeClassError = value;
    },
    setPodError(value) {
      podError = value;
    },
    pod(name = "gvisor-harness-ready") {
      return {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name, namespace, labels: structuredClone(agent.spec.template.metadata.labels) },
        spec: { runtimeClassName: GVISOR_RUNTIME_CLASS },
        status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
      };
    },
    prepare() {
      return driver.prepareRevision(revision);
    },
    activate() {
      return driver.activateRevision(revision);
    },
  };
}

test("gVisor startup selects a distinct implementation and preserves ordinary Kubernetes selection", async (t) => {
  assert.equal(GVISOR_RUNTIME_CLASS, "oce-gvisor-systrap");
  assert.equal(GVISOR_IMPLEMENTATION, "occ/kubernetes-gvisor");
  const loaded = await load(t, installation());
  assert.ok(loaded.computeDriver instanceof KubernetesComputeDriver);
  assert.equal(loaded.computeDriver.implementation, GVISOR_IMPLEMENTATION);
  assert.equal(loaded.installation.drivers.compute.implementation, GVISOR_IMPLEMENTATION);
  assert.equal(
    loaded.installation.drivers.compute.configuration.isolationProfile,
    "gvisor-systrap",
  );
  const ordinary = installation();
  delete ordinary.drivers.compute.configuration.isolationProfile;
  assert.equal((await load(t, ordinary)).computeDriver.implementation, "occ/kubernetes");
  const production = createInstallationDriverConfiguration();
  production.drivers.compute.configuration.isolationProfile = "gvisor-systrap";
  const productionLoaded = await load(t, production, "production");
  assert.equal(productionLoaded.computeDriver.implementation, GVISOR_IMPLEMENTATION);
  assert.deepEqual(
    productionLoaded.installation.drivers.compute.configuration.runtime,
    production.drivers.compute.configuration.runtime,
  );
  assert.equal(
    productionLoaded.installation.drivers.compute.configuration.authentication.mode,
    "inCluster",
  );
});

test("gVisor startup and constructor reject unsupported schema and ambiguous implementation selection", async (t) => {
  for (const [overrides, expected] of [
    [{ isolationProfile: "runc" }, /schema/],
    [{ runtimeClassName: "arbitrary-runtime" }, /schema/],
    [
      { authentication: { mode: "kubeconfig", kubeconfigPath: "relative", context: "k3d-test" } },
      /absolute/,
    ],
    [{ authentication: { mode: "kubeconfig", kubeconfigPath: "/tmp/explicit" } }, /context/i],
  ]) {
    const configured = installation();
    configured.drivers.compute.configuration = options(overrides);
    await assert.rejects(load(t, configured), expected);
    assert.throws(
      () => new KubernetesComputeDriver(options(overrides)),
      /isolation|unsupported|absolute|context/i,
    );
  }
  assert.throws(
    () => new KubernetesComputeDriver(options(), { implementation: "occ/kubernetes" }),
    /distinct Compute implementation/,
  );
  const ordinary = options();
  delete ordinary.isolationProfile;
  assert.throws(
    () => new KubernetesComputeDriver(ordinary, { implementation: GVISOR_IMPLEMENTATION }),
    /distinct Compute implementation/,
  );
});

test("gVisor startup rejects an otherwise valid bundled OpenShell selection", async (t) => {
  const configured = installation();
  configured.drivers.sandbox = {
    id: "openshell-sandbox",
    configuration: {
      gateway: { serviceName: "openshell-gateway", port: 50051 },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        serviceAccount: { mode: "driverConfig" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          { name: "model-egress", endpoints: [{ host: "api.openai.com", ports: [443] }] },
        ],
      },
    },
  };
  await assert.rejects(load(t, configured), /cannot be combined with drivers.sandbox/);
});

test("gVisor revision admission rejects combined topology and stale compute identities before transport access", async () => {
  const driver = new KubernetesComputeDriver(options());
  let transportAccesses = 0;
  driver.apiClients = Promise.resolve(
    new Proxy(
      {},
      {
        get(target, name) {
          if (name === "then") return undefined;
          transportAccesses += 1;
          throw new Error("unexpected Kubernetes transport access");
        },
      },
    ),
  );
  const revision = revisionFor(driver);
  for (const compute of [
    { id: driver.id, implementation: "occ/kubernetes" },
    { id: driver.id, implementation: "kubernetes-local" },
    { id: driver.id, implementation: "occ/kubernetes-gvisor-development" },
    { id: "another-compute", implementation: driver.implementation },
  ]) {
    assert.deepEqual(await driver.prepareRevision({ ...revision, compute }), {
      namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
      ready: false,
    });
    await assert.rejects(
      driver.activateRevision({ ...revision, compute }),
      /pinned to another Compute implementation/,
    );
  }
  for (const overrides of [
    { harness: { id: "openclaw", version: "1.0.0", mode: "embedded" } },
    { sandboxDriverId: "openshell-sandbox" },
  ]) {
    await assert.rejects(
      driver.prepareRevision({ ...revision, ...overrides }),
      /dedicated Harness without a SandboxDriver/,
    );
    await assert.rejects(
      driver.activateRevision({ ...revision, ...overrides }),
      /dedicated Harness without a SandboxDriver/,
    );
  }
  assert.equal(transportAccesses, 0);
});

test("gVisor Agent manifests preserve projected identity, mounts, resource limits, and an unchanged gateway", async () => {
  const current = fixture();
  current.setObservation({ items: [current.pod()] });
  assert.equal((await current.prepare()).ready, true);
  const submitted = current.writes.filter(({ kind }) => kind === "Deployment");
  const agent = submitted.find(({ metadata }) => metadata.name === current.agent.metadata.name);
  const gateway = submitted.find(({ metadata }) => metadata.name === current.gateway.metadata.name);
  const pod = agent.spec.template.spec;
  assert.equal(pod.runtimeClassName, GVISOR_RUNTIME_CLASS);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(
    agent.spec.template.metadata.labels["openclaw.dev/service-principal"],
    current.revision.servicePrincipalId,
  );
  assert.equal(agent.spec.template.metadata.labels["openclaw.dev/revision"], current.revision.id);
  assert.deepEqual(pod.containers[0].resources, options().resources.agent);
  assert.deepEqual(
    pod.volumes.find(({ name }) => name === "openclaw-service-principal"),
    {
      name: "openclaw-service-principal",
      projected: {
        sources: [
          {
            serviceAccountToken: {
              audience: "openclaw-enterprise",
              expirationSeconds: 900,
              path: "token",
            },
          },
        ],
      },
    },
  );
  assert.deepEqual(
    pod.containers[0].volumeMounts.find(({ name }) => name === "openclaw-service-principal"),
    {
      name: "openclaw-service-principal",
      mountPath: "/var/run/secrets/openclaw/service-principal",
      readOnly: true,
    },
  );
  assert.deepEqual(pod.containers[0].env, [
    { name: "LOG_FORMAT", value: "json" },
    { name: "RUST_LOG", value: "info,codex_otel=off" },
  ]);
  assert.deepEqual(pod.securityContext, {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    seccompProfile: { type: "RuntimeDefault" },
  });
  assert.deepEqual(pod.containers[0].securityContext, {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  });
  // The same real generator provides the ordinary profile baseline; only the Agent RuntimeClass changes.
  const ordinaryOptions = options();
  delete ordinaryOptions.isolationProfile;
  const ordinary = fixture({ driver: new KubernetesComputeDriver(ordinaryOptions) });
  const expectedAgent = structuredClone(ordinary.agent);
  delete expectedAgent.metadata.generation;
  delete expectedAgent.metadata.uid;
  delete expectedAgent.metadata.resourceVersion;
  delete expectedAgent.status;
  expectedAgent.spec.template.spec.runtimeClassName = GVISOR_RUNTIME_CLASS;
  assert.deepEqual(agent, expectedAgent);
  const expectedGateway = structuredClone(ordinary.gateway);
  delete expectedGateway.metadata.generation;
  delete expectedGateway.metadata.uid;
  delete expectedGateway.metadata.resourceVersion;
  delete expectedGateway.status;
  assert.deepEqual(gateway, expectedGateway);
  assert.equal(gateway.spec.template.spec.runtimeClassName, undefined);
});

test("gVisor preparation requires one Running Ready Pod and current Deployment readiness", async () => {
  const current = fixture();
  const pending = current.pod("pending");
  pending.status.phase = "Pending";
  const unready = current.pod("unready");
  unready.status.conditions[0].status = "False";
  const deleting = current.pod("deleting");
  deleting.metadata.deletionTimestamp = "2026-09-04T00:00:00.000Z";
  for (const [items, ready] of [
    [[], false],
    [[pending], false],
    [[unready], false],
    [[deleting], false],
    [[current.pod(), current.pod("duplicate")], false],
    [[current.pod(), deleting], true],
    [[current.pod()], true],
  ]) {
    current.setObservation({ items });
    assert.deepEqual(await current.prepare(), {
      namespaceId,
      agentId: current.revision.agentId,
      revisionId: current.revision.id,
      ready,
    });
  }
  const calls = current.podRequests.length;
  current.agent.status.observedGeneration = 1;
  assert.equal((await current.prepare()).ready, false);
  current.agent.status.observedGeneration = 2;
  current.agent.status.readyReplicas = 0;
  assert.equal((await current.prepare()).ready, false);
  assert.equal(
    current.podRequests.length,
    calls + 2,
    "an unready Deployment still requires observation of potentially unsafe live Pods",
  );
});

test("gVisor preparation refuses missing or changed Deployment and Pod RuntimeClass without fallback", async () => {
  for (const runtimeClassName of [undefined, "runc", "another-gvisor-class"]) {
    const current = fixture();
    const pod = current.pod();
    pod.spec.runtimeClassName = runtimeClassName;
    current.setObservation({ items: [pod] });
    await assert.rejects(current.prepare(), /required RuntimeClass; refusing fallback/);
    for (const write of current.writes.filter(
      ({ kind, spec }) =>
        kind === "Deployment" &&
        spec.template.metadata.labels["openclaw.dev/workload-role"] === "agent",
    )) {
      assert.equal(write.spec.template.spec.runtimeClassName, GVISOR_RUNTIME_CLASS);
    }
    current.agent.spec.template.spec.runtimeClassName = runtimeClassName;
    await assert.rejects(current.prepare(), /workload lost its required RuntimeClass/);
  }
  const rejected = fixture();
  const unavailable = Object.assign(new Error('RuntimeClass "oce-gvisor-systrap" not found'), {
    statusCode: 403,
  });
  rejected.setPatchError(unavailable);
  await assert.rejects(rejected.prepare(), (error) => error === unavailable);
  const agentWrites = rejected.writes.filter(
    ({ metadata }) => metadata.name === rejected.agent.metadata.name,
  );
  assert.equal(
    agentWrites.length,
    1,
    "admission rejection must not retry with the default runtime",
  );
  assert.equal(agentWrites[0].spec.template.spec.runtimeClassName, GVISOR_RUNTIME_CLASS);
  assert.equal(rejected.podRequests.length, 0);
});

test("gVisor preparation rejects malformed, incomplete, and incorrectly owned observations", async () => {
  const current = fixture();
  for (const observation of [
    {},
    { items: [current.pod(), null] },
    { items: [current.pod()], metadata: { continue: "more-pods" } },
    { items: [current.pod()], metadata: { _continue: "more-pods" } },
    { items: [current.pod()], metadata: { remainingItemCount: 1 } },
  ]) {
    current.setObservation(observation);
    await assert.rejects(current.prepare(), /invalid or incomplete/);
  }
  for (const label of [
    "openclaw.dev/service-principal",
    "openclaw.dev/namespace",
    "app.kubernetes.io/name",
  ]) {
    const pod = current.pod();
    pod.metadata.labels[label] = "another-owner";
    current.setObservation({ items: [pod] });
    await assert.rejects(current.prepare(), /invalid or incomplete/);
  }
  for (const mutate of [
    (pod) => {
      pod.metadata.namespace = "another-namespace";
    },
    (pod) => {
      pod.metadata.labels["openclaw.dev/revision"] = "another-revision";
    },
    (pod) => {
      pod.metadata.labels["openclaw.dev/agent"] = "another-agent";
    },
  ]) {
    const pod = current.pod();
    mutate(pod);
    current.setObservation({ items: [pod] });
    assert.equal(
      (await current.prepare()).ready,
      false,
      "another workload cannot establish readiness",
    );
  }
  const invalidTemplate = fixture({
    mutateAgent(agent) {
      delete agent.spec.template.metadata.labels["openclaw.dev/service-principal"];
    },
  });
  await assert.rejects(invalidTemplate.prepare(), /labels do not match its ownership/);
  const foreign = fixture({
    mutateAgent(agent) {
      agent.metadata.annotations["openclaw.dev/revision-id"] = "another-revision";
    },
  });
  await assert.rejects(foreign.prepare(), /Refusing unowned Kubernetes Deployment/);
  assert.equal(
    foreign.writes.some(({ metadata }) => metadata.name === foreign.agent.metadata.name),
    false,
  );
});

test("gVisor preparation preserves lifecycle environment on its dedicated Harness", async () => {
  const driver = new KubernetesComputeDriver(options(), {
    lifecycleDrivers: [
      {
        id: "configuration-fixture",
        capability: "configuration",
        implementation: "conformance-fixture",
        computeLifecycleHooks: {
          async beforeWorkloadStart(revision, launch) {
            launch.environment.OCE_FIXTURE_SETTING = "opaque-fixture-value";
          },
        },
      },
    ],
  });
  const current = fixture({ driver });
  current.setObservation({ items: [current.pod()] });
  assert.equal((await current.prepare()).ready, true);
  const agent = current.writes.find(
    ({ metadata }) => metadata.name === current.agent.metadata.name,
  );
  assert.deepEqual(agent.spec.template.spec.containers[0].env, [
    { name: "OCE_FIXTURE_SETTING", value: "opaque-fixture-value" },
    { name: "LOG_FORMAT", value: "json" },
    { name: "RUST_LOG", value: "info,codex_otel=off" },
  ]);
  assert.equal(agent.spec.template.spec.runtimeClassName, GVISOR_RUNTIME_CLASS);
});

test("gVisor preparation verifies the exact RuntimeClass handler before workload writes", async () => {
  for (const runtimeClass of [
    undefined,
    {
      apiVersion: "node.k8s.io/v1",
      kind: "RuntimeClass",
      metadata: { name: GVISOR_RUNTIME_CLASS },
      handler: "runc",
    },
    {
      apiVersion: "node.k8s.io/v1",
      kind: "RuntimeClass",
      metadata: { name: "another-runtime-class" },
      handler: GVISOR_RUNTIME_CLASS,
    },
    {
      apiVersion: "node.k8s.io/v1",
      kind: "RuntimeClass",
      metadata: { name: GVISOR_RUNTIME_CLASS, namespace },
      handler: GVISOR_RUNTIME_CLASS,
    },
    {
      apiVersion: "node.k8s.io/v1",
      kind: "RuntimeClass",
      metadata: { name: GVISOR_RUNTIME_CLASS, deletionTimestamp: "2026-09-04T00:00:00.000Z" },
      handler: GVISOR_RUNTIME_CLASS,
    },
  ]) {
    const current = fixture();
    current.setRuntimeClass(runtimeClass);
    await assert.rejects(current.prepare(), /RuntimeClass/);
    assert.equal(current.writes.length, 0);
    assert.equal(current.runtimeClassRequests.length, 1);
    assert.equal(current.podRequests.length, 0);
    assert.deepEqual(current.containment, [deploymentDeletion(current)]);
  }
  const current = fixture();
  current.setObservation({ items: [current.pod()] });
  assert.equal((await current.prepare()).ready, true);
  assert.equal(
    current.runtimeClassRequests.length,
    2,
    "preparation and readiness each verify the selected RuntimeClass",
  );
});

function runtimeFixture({ isolationProfile = true, lifecycleDrivers = [], ...overrides } = {}) {
  const configured = options({
    runtime: createInstallationDriverConfiguration().drivers.compute.configuration.runtime,
  });
  if (!isolationProfile) delete configured.isolationProfile;
  return fixture({
    driver: new KubernetesComputeDriver(configured, { lifecycleDrivers }),
    active: true,
    ...overrides,
  });
}

function deploymentDeletion(current) {
  return {
    kind: "Deployment",
    request: {
      name: current.agent.metadata.name,
      namespace,
      body: {
        preconditions: { uid: current.agent.metadata.uid },
        propagationPolicy: "Foreground",
      },
    },
  };
}

function expectedContainment(current) {
  const service = current.agentService;
  return [
    {
      kind: "Service",
      request: {
        name: service.metadata.name,
        namespace,
        body: [
          { op: "test", path: "/metadata/uid", value: service.metadata.uid },
          {
            op: "test",
            path: "/metadata/resourceVersion",
            value: service.metadata.resourceVersion,
          },
          { op: "test", path: "/spec/selector", value: service.spec.selector },
          {
            op: "replace",
            path: "/spec/selector",
            value: { "app.kubernetes.io/name": `${service.metadata.name}-inactive` },
          },
        ],
      },
    },
    deploymentDeletion(current),
  ];
}

function errorLeaves(error) {
  return error instanceof AggregateError ? error.errors.flatMap(errorLeaves) : [error];
}

test("gVisor contains a Running Pod using another or missing runtime during preparation and activation", async () => {
  for (const operation of ["prepare", "activate"]) {
    for (const runtimeClassName of ["runc", undefined]) {
      for (const deploymentReady of [true, false]) {
        const current = runtimeFixture();
        if (!deploymentReady) current.agent.status.readyReplicas = 0;
        const pod = current.pod();
        pod.spec.runtimeClassName = runtimeClassName;
        current.setObservation({ items: [pod] });
        // The production-runtime path sees an already active selector and an observed Running Pod.
        // A successful delete response records only a termination request, never a stopped result.
        await assert.rejects(current[operation](), /required RuntimeClass; refusing fallback/);
        assert.deepEqual(current.containment, expectedContainment(current));
        if (operation === "activate") assert.equal(current.writes.length, 0);
      }
    }
  }
});

test("gVisor contains a deleting unsafe Running Pod alongside a safe Ready Pod in either list order", async () => {
  for (const operation of ["prepare", "activate"]) {
    for (const runtimeClassName of ["runc", undefined]) {
      for (const deletionTimestamp of [
        "2026-09-04T00:00:00.000Z",
        new Date("2026-09-04T00:00:00.000Z"),
      ]) {
        for (const deletingPodFirst of [true, false]) {
          const current = runtimeFixture();
          const ready = current.pod("safe-ready");
          const deleting = current.pod("unsafe-deleting");
          deleting.metadata.deletionTimestamp = deletionTimestamp;
          if (runtimeClassName === undefined) delete deleting.spec.runtimeClassName;
          else deleting.spec.runtimeClassName = runtimeClassName;
          current.setObservation({
            items: deletingPodFirst ? [deleting, ready] : [ready, deleting],
          });

          // Kubernetes can report a Running, Ready Pod after deletion is requested.
          // A safe replacement cannot hide that still-running Pod's isolation violation.
          await assert.rejects(current[operation](), /required RuntimeClass; refusing fallback/);
          assert.deepEqual(current.containment, expectedContainment(current));
          if (operation === "activate") assert.equal(current.writes.length, 0);
        }
      }
    }
  }
});

test("gVisor contains deleting unsafe Pods whose phase does not establish termination", async () => {
  for (const operation of ["prepare", "activate"]) {
    for (const phase of [undefined, "Unknown", "Pending"]) {
      for (const runtimeClassName of ["runc", undefined]) {
        const current = runtimeFixture();
        const deleting = current.pod("unsafe-deleting-without-terminal-phase");
        deleting.metadata.deletionTimestamp = "2026-09-04T00:00:00.000Z";
        deleting.status.conditions = [];
        if (phase === undefined) delete deleting.status.phase;
        else deleting.status.phase = phase;
        if (runtimeClassName === undefined) delete deleting.spec.runtimeClassName;
        else deleting.spec.runtimeClassName = runtimeClassName;
        current.setObservation({ items: [current.pod("safe-ready"), deleting] });

        // Absent or inconclusive lifecycle observations cannot prove the unsafe Pod stopped.
        await assert.rejects(current[operation](), /required RuntimeClass; refusing fallback/);
        assert.deepEqual(current.containment, expectedContainment(current));
        if (operation === "activate") assert.equal(current.writes.length, 0);
      }
    }
  }
});

test("gVisor excludes safe deleting Pods from readiness and does not contain them", async () => {
  for (const operation of ["prepare", "activate"]) {
    for (const deletionTimestamp of [
      "2026-09-04T00:00:00.000Z",
      new Date("2026-09-04T00:00:00.000Z"),
    ]) {
      const current = runtimeFixture();
      const deleting = current.pod("safe-deleting");
      deleting.metadata.deletionTimestamp = deletionTimestamp;
      current.setObservation({ items: [deleting] });

      // A safe deleting Pod cannot itself satisfy readiness, despite its stale Ready condition.
      if (operation === "prepare") assert.equal((await current.prepare()).ready, false);
      else await assert.rejects(current.activate(), /workload is not ready/);
      assert.deepEqual(current.containment, []);

      const ready = current.pod("safe-ready");
      for (const items of [
        [ready, deleting],
        [deleting, ready],
      ]) {
        current.setObservation({ items });
        // The terminating Pod must not count as a second live readiness candidate either.
        if (operation === "prepare") assert.equal((await current.prepare()).ready, true);
        else await current.activate();
        assert.deepEqual(current.containment, []);
      }
    }
  }
});

test("gVisor ignores deleting unsafe Pods only after a terminal phase is observed", async () => {
  for (const operation of ["prepare", "activate"]) {
    for (const phase of ["Succeeded", "Failed"]) {
      for (const runtimeClassName of ["runc", undefined]) {
        const current = runtimeFixture();
        const terminal = current.pod("terminated-deleting");
        terminal.metadata.deletionTimestamp = "2026-09-04T00:00:00.000Z";
        terminal.status = { phase, conditions: [{ type: "Ready", status: "False" }] };
        if (runtimeClassName === undefined) delete terminal.spec.runtimeClassName;
        else terminal.spec.runtimeClassName = runtimeClassName;
        const ready = current.pod("safe-ready");

        // Succeeded and Failed establish termination, so this Pod neither violates current
        // execution isolation nor competes with the replacement's readiness observation.
        for (const items of [
          [ready, terminal],
          [terminal, ready],
        ]) {
          current.setObservation({ items });
          if (operation === "prepare") assert.equal((await current.prepare()).ready, true);
          else await current.activate();
          assert.deepEqual(current.containment, []);
        }
      }
    }
  }
});

test("gVisor does not contain deleting unsafe Pods outside the exact revision identity", async () => {
  for (const operation of ["prepare", "activate"]) {
    for (const foreignField of [
      "namespace",
      "openclaw.dev/agent",
      "openclaw.dev/revision",
      "openclaw.dev/workload-role",
    ]) {
      const current = runtimeFixture();
      const foreign = current.pod("foreign-unsafe-deleting");
      foreign.metadata.deletionTimestamp = "2026-09-04T00:00:00.000Z";
      foreign.spec.runtimeClassName = "runc";
      if (foreignField === "namespace") foreign.metadata.namespace = "another-namespace";
      else foreign.metadata.labels[foreignField] = "another-identity";
      const ready = current.pod("safe-ready");

      // Unexpected transport results cannot extend containment to another workload identity.
      for (const items of [
        [ready, foreign],
        [foreign, ready],
      ]) {
        current.setObservation({ items });
        if (operation === "prepare") assert.equal((await current.prepare()).ready, true);
        else await current.activate();
        assert.deepEqual(current.containment, []);
      }
    }
  }
});

test("gVisor contains a matching unsafe Pod even when its service-principal label is missing or contradictory", async () => {
  for (const operation of ["prepare", "activate"]) {
    for (const runtimeClassName of ["runc", undefined, GVISOR_RUNTIME_CLASS]) {
      for (const servicePrincipalId of [undefined, "another-service-principal"]) {
        const current = runtimeFixture();
        const pod = current.pod();
        if (runtimeClassName === undefined) delete pod.spec.runtimeClassName;
        else pod.spec.runtimeClassName = runtimeClassName;
        if (servicePrincipalId === undefined)
          delete pod.metadata.labels["openclaw.dev/service-principal"];
        else pod.metadata.labels["openclaw.dev/service-principal"] = servicePrincipalId;
        current.setObservation({ items: [pod] });

        // Exact namespace, Agent, revision, role, and app labels still match the active route.
        // An additional ownership-label error must not hide a confirmed runtime violation.
        if (runtimeClassName === GVISOR_RUNTIME_CLASS) {
          await assert.rejects(current[operation](), /invalid or incomplete/);
          assert.deepEqual(current.containment, []);
        } else {
          await assert.rejects(current[operation](), /required RuntimeClass; refusing fallback/);
          assert.deepEqual(current.containment, expectedContainment(current));
        }
        if (operation === "activate") assert.equal(current.writes.length, 0);
      }
    }
  }
});

test("gVisor observes runtime violations across multiple Pods before rejecting extra ownership labels", async () => {
  for (const operation of ["prepare", "activate"]) {
    for (const runtimeClassName of ["runc", undefined, GVISOR_RUNTIME_CLASS]) {
      for (const servicePrincipalId of [undefined, "another-service-principal"]) {
        for (const conflictingPodFirst of [true, false]) {
          const current = runtimeFixture();
          const conflicting = current.pod("correct-runtime-label-conflict");
          if (servicePrincipalId === undefined)
            delete conflicting.metadata.labels["openclaw.dev/service-principal"];
          else conflicting.metadata.labels["openclaw.dev/service-principal"] = servicePrincipalId;
          const owned = current.pod("exactly-owned-runtime-observation");
          if (runtimeClassName === undefined) delete owned.spec.runtimeClassName;
          else owned.spec.runtimeClassName = runtimeClassName;
          current.setObservation({
            items: conflictingPodFirst ? [conflicting, owned] : [owned, conflicting],
          });

          // Both Pods are structurally valid and match the active revision's route.
          // List ordering must not let a generic label conflict hide a runtime violation.
          if (runtimeClassName === GVISOR_RUNTIME_CLASS) {
            await assert.rejects(current[operation](), /invalid or incomplete/);
            assert.deepEqual(current.containment, []);
          } else {
            await assert.rejects(current[operation](), /required RuntimeClass; refusing fallback/);
            assert.deepEqual(current.containment, expectedContainment(current));
          }
          if (operation === "activate") assert.equal(current.writes.length, 0);
        }
      }
    }
  }
});

test("gVisor contains an active revision when its selected RuntimeClass disappears or loses its handler", async () => {
  for (const operation of ["prepare", "activate"]) {
    for (const runtimeClass of [
      undefined,
      {
        apiVersion: "node.k8s.io/v1",
        kind: "RuntimeClass",
        metadata: { name: GVISOR_RUNTIME_CLASS },
        handler: "runc",
      },
      {
        apiVersion: "node.k8s.io/v1",
        kind: "RuntimeClass",
        metadata: { name: GVISOR_RUNTIME_CLASS, deletionTimestamp: "2026-09-04T00:00:00.000Z" },
        handler: GVISOR_RUNTIME_CLASS,
      },
    ]) {
      const current = runtimeFixture();
      current.setRuntimeClass(runtimeClass);
      await assert.rejects(current[operation](), /RuntimeClass/);
      assert.deepEqual(current.containment, expectedContainment(current));
      assert.equal(
        current.writes.length,
        0,
        "containment cannot first recreate or update the workload",
      );
    }
  }
});

test("gVisor containment preserves another active revision and refuses foreign Deployment ownership", async () => {
  for (const operation of ["prepare", "activate"]) {
    const current = runtimeFixture();
    current.agentService.spec.selector["openclaw.dev/revision"] = "another-active-revision";
    current.setRuntimeClass(undefined);
    await assert.rejects(current[operation](), /RuntimeClass/);
    assert.deepEqual(current.containment, [deploymentDeletion(current)]);
    assert.equal(current.writes.length, 0);

    const foreign = runtimeFixture({
      mutateAgent(agent) {
        agent.metadata.annotations["openclaw.dev/revision-id"] = "another-revision";
      },
    });
    foreign.setRuntimeClass(undefined);
    if (operation === "activate") {
      // Activation checks Deployment ownership before observing isolation. It cannot claim
      // an isolation violation or delete that foreign workload from its name alone.
      await assert.rejects(foreign.activate(), /Refusing unowned Kubernetes Deployment/);
      assert.deepEqual(foreign.containment, []);
      continue;
    }
    await assert.rejects(foreign[operation](), (error) => {
      assert.match(error.message, /containment could not be confirmed/);
      assert.ok(errorLeaves(error).some((leaf) => /RuntimeClass/.test(leaf.message)));
      assert.ok(
        errorLeaves(error).some((leaf) =>
          /Refusing unowned Kubernetes Deployment/.test(leaf.message),
        ),
      );
      return true;
    });
    assert.deepEqual(foreign.containment, [expectedContainment(foreign)[0]]);
  }
});

test("gVisor containment attempts exact Deployment deletion after guarded route failure and reports cleanup failures", async () => {
  for (const operation of ["prepare", "activate"]) {
    const current = runtimeFixture();
    current.setRuntimeClass(undefined);
    const routeConflict = Object.assign(new Error("Service resourceVersion test failed"), {
      statusCode: 409,
    });
    const deleteDenied = Object.assign(new Error("Deployment deletion denied"), {
      statusCode: 403,
    });
    current.setRoutePatchError(routeConflict);
    current.setDeleteError(deleteDenied);
    await assert.rejects(current[operation](), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /containment could not be confirmed/);
      const failures = errorLeaves(error);
      assert.ok(failures.some((leaf) => /RuntimeClass/.test(leaf.message)));
      assert.ok(failures.includes(routeConflict));
      assert.ok(failures.includes(deleteDenied));
      return true;
    });
    assert.deepEqual(current.containment, expectedContainment(current));
    assert.equal(current.writes.length, 0);
  }
});

test("gVisor containment requires Service mutation preconditions and still requests owned Deployment deletion", async () => {
  for (const field of ["uid", "resourceVersion"]) {
    const current = runtimeFixture();
    delete current.agentService.metadata[field];
    current.setRuntimeClass(undefined);
    await assert.rejects(current.prepare(), (error) => {
      assert.match(error.message, /containment could not be confirmed/);
      assert.ok(
        errorLeaves(error).some((leaf) => /Isolation containment Service/.test(leaf.message)),
      );
      return true;
    });
    assert.deepEqual(current.containment, [deploymentDeletion(current)]);
  }
});

test("gVisor containment preserves foreign Service ownership while requesting exact owned Deployment deletion", async () => {
  for (const operation of ["prepare", "activate"]) {
    const current = runtimeFixture();
    current.agentService.metadata.labels["openclaw.dev/agent"] = "another-agent";
    current.setRuntimeClass(undefined);
    await assert.rejects(current[operation](), (error) => {
      assert.match(error.message, /containment could not be confirmed/);
      assert.ok(
        errorLeaves(error).some((leaf) => /Refusing unowned Kubernetes Service/.test(leaf.message)),
      );
      return true;
    });
    assert.deepEqual(current.containment, [deploymentDeletion(current)]);
    assert.equal(current.writes.length, 0);
  }
});

test("gVisor containment refuses missing Deployment UID and never retries a UID conflict without preconditions", async () => {
  for (const operation of ["prepare", "activate"]) {
    const missing = runtimeFixture();
    delete missing.agent.metadata.uid;
    missing.setRuntimeClass(undefined);
    await assert.rejects(missing[operation](), (error) => {
      assert.match(error.message, /containment could not be confirmed/);
      assert.ok(
        errorLeaves(error).some((leaf) =>
          /Isolation containment Deployment UID/.test(leaf.message),
        ),
      );
      return true;
    });
    assert.deepEqual(missing.containment, [expectedContainment(missing)[0]]);

    const conflict = runtimeFixture();
    conflict.setRuntimeClass(undefined);
    const uidConflict = Object.assign(new Error("Deployment UID precondition failed"), {
      statusCode: 409,
    });
    conflict.setDeleteError(uidConflict);
    await assert.rejects(conflict[operation](), (error) => {
      assert.match(error.message, /containment could not be confirmed/);
      assert.ok(errorLeaves(error).includes(uidConflict));
      return true;
    });
    assert.deepEqual(conflict.containment, expectedContainment(conflict));
    assert.equal(conflict.containment.filter(({ kind }) => kind === "Deployment").length, 1);
  }
});

test("gVisor containment runs lifecycle cleanup once and preserves hook failure alongside termination requests", async () => {
  for (const operation of ["prepare", "activate"]) {
    let stops = 0;
    const current = runtimeFixture({
      lifecycleDrivers: [
        {
          id: "configuration-cleanup",
          capability: "configuration",
          implementation: "conformance-fixture",
          computeLifecycleHooks: {
            async beforeWorkloadStop() {
              stops += 1;
              throw new Error("cleanup unavailable");
            },
          },
        },
      ],
    });
    const pod = current.pod();
    pod.spec.runtimeClassName = "runc";
    current.setObservation({ items: [pod] });
    await assert.rejects(current[operation](), (error) => {
      assert.match(error.message, /containment could not be confirmed/);
      assert.ok(errorLeaves(error).some((leaf) => /RuntimeClass/.test(leaf.message)));
      assert.ok(errorLeaves(error).some((leaf) => /beforeWorkloadStop/.test(leaf.message)));
      return true;
    });
    assert.equal(stops, 1);
    assert.deepEqual(current.containment, expectedContainment(current));
  }
});

test("gVisor ordinary unready states and transient observation errors do not request containment", async () => {
  for (const operation of ["prepare", "activate"]) {
    const unready = runtimeFixture();
    const pod = unready.pod();
    pod.status.conditions[0].status = "False";
    unready.setObservation({ items: [pod] });
    if (operation === "prepare") assert.equal((await unready.prepare()).ready, false);
    else await assert.rejects(unready.activate(), /workload is not ready/);
    assert.deepEqual(unready.containment, []);

    for (const source of ["setRuntimeClassError", "setPodError"]) {
      const current = runtimeFixture();
      const unavailable = Object.assign(
        new Error("Kubernetes observation temporarily unavailable"),
        { statusCode: 503 },
      );
      current[source](unavailable);
      await assert.rejects(current[operation](), (error) => error === unavailable);
      assert.deepEqual(current.containment, []);
    }
  }
});

test("ordinary Kubernetes never applies gVisor containment or requires its RuntimeClass", async () => {
  const current = runtimeFixture({ isolationProfile: false });
  current.setRuntimeClass(undefined);
  const pod = current.pod();
  pod.spec.runtimeClassName = "runc";
  current.setObservation({ items: [pod] });
  assert.equal((await current.prepare()).ready, true);
  await current.activate();
  assert.deepEqual(current.runtimeClassRequests, []);
  assert.deepEqual(current.podRequests, []);
  assert.deepEqual(current.containment, []);
});
