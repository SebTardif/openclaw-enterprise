import assert from "node:assert/strict";
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
    configuration: { gateway: { controlUi: { enabled: false } } },
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

function fixture({ driver = new KubernetesComputeDriver(options()), revision, mutateAgent } = {}) {
  revision ??= revisionFor(driver);
  const gatewayName = `gateway-${hash(revision.agentId)}`;
  const agentName = `agent-${hash(revision.agentId)}`;
  const revisionName = `${agentName}-rev-${hash(revision.id)}`;
  const gatewayOwnership = { namespaceId, agentId: revision.agentId };
  const agentOwnership = { ...gatewayOwnership, servicePrincipalId: revision.servicePrincipalId };
  const objects = new Map();
  const key = (kind, name) => `${kind}:${name}`;
  const save = (object) => objects.set(key(object.kind, object.metadata.name), object);
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
    driver.gatewayConfiguration(revision),
  );
  const agent = driver.deployment(
    revisionName,
    { ...agentOwnership, revisionId: revision.id },
    namespace,
    options().images.agent,
    agentName,
    "agent",
  );
  // Readiness is explicit observation data, never inferred from an accepted patch.
  for (const deployment of [gateway, agent]) {
    deployment.metadata.generation = 2;
    deployment.status = { observedGeneration: 2, readyReplicas: 1 };
    save(deployment);
  }
  mutateAgent?.(agent);
  save(
    driver.service(gatewayName, gatewayOwnership, namespace, {
      "app.kubernetes.io/name": gatewayName,
    }),
  );
  save(
    driver.service(agentName, agentOwnership, namespace, {
      "app.kubernetes.io/name": `${agentName}-inactive`,
    }),
  );
  const writes = [];
  const podRequests = [];
  let observation = { items: [] };
  let patchError;
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
        if (runtimeClass === undefined)
          throw Object.assign(new Error("RuntimeClass not found"), { statusCode: 404 });
        return structuredClone(runtimeClass);
      },
    },
    apps: {},
    networking: {},
    discovery: {
      async listNamespacedEndpointSlice({ namespace: requestedNamespace, labelSelector }) {
        assert.equal(requestedNamespace, namespace);
        assert.equal(labelSelector, `kubernetes.io/service-name=${gatewayName}`);
        return {
          items: [
            {
              metadata: { labels: { "kubernetes.io/service-name": gatewayName } },
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
      api[`patchNamespaced${kind}`] = async ({ body, namespace: requestedNamespace }) => {
        assert.equal(requestedNamespace, namespace);
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
    writes,
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
  assert.equal(pod.containers[0].env, undefined);
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
  delete expectedAgent.status;
  expectedAgent.spec.template.spec.runtimeClassName = GVISOR_RUNTIME_CLASS;
  assert.deepEqual(agent, expectedAgent);
  const expectedGateway = structuredClone(ordinary.gateway);
  delete expectedGateway.metadata.generation;
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
    calls,
    "Pod readiness cannot override an unready Deployment",
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
