import { hostedLaunchV2 } from "../fixtures/hosted-launch-v2/values.mjs";
import { canonicalGatewayStartupValueV1 } from "../../packages/occ/src/gateway-startup-v1/owner.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { KubernetesRendererOwner } from "../../apps/controller/src/drivers/compute/kubernetes/renderer-owner.ts";
import {
  createComputeDriver,
  selectedComputeRendererOwner,
  selectedComputeWorkloadProfileCapability,
} from "../../apps/controller/src/composition/driver-factories/compute.ts";
import {
  FixedWorkloadRenderer,
  fixedWorkloadDeployment,
} from "../../apps/controller/src/drivers/compute/kubernetes/resources/fixed-workload-renderer.ts";
import { GVISOR_RUNTIME_CLASS } from "../../apps/controller/src/drivers/compute/kubernetes/resources/identity.ts";
import { SHARED_WORKSPACE_CATEGORIES } from "../../apps/controller/src/drivers/compute/kubernetes/resources/storage.ts";
import { driverValues } from "../fixtures/kubernetes-resource-plan/driver-values.mjs";
import {
  gatewayMainPath,
  gatewayLaunchPath,
  gatewayLaunchMaxBytes,
  gatewayReadinessPath,
} from "../../packages/contracts/src/hosted-gateway-launch-v1.ts";

// Actual factory, DriverSelection and fixed constructors. Targets and resource
// plans are controlled construction operands, not admission or live cluster proof.
function fixture(id = "renderer-owner-compute", change = () => {}) {
  const values = driverValues();
  const options = structuredClone(values.options);
  delete options.runtime;
  options.isolationProfile = "gvisor-systrap";
  options.servicePrincipalCredentials = { mode: "disabled" };
  options.images = {
    gateway: `example.invalid/gateway@sha256:${"1".repeat(64)}`,
    agent: `example.invalid/harness@sha256:${"2".repeat(64)}`,
    requireImmutableDigest: true,
  };
  change(options);
  const driver = createComputeDriver(
    { id, implementation: "occ/kubernetes-gvisor", configuration: options },
    { id: "configuration-fixture", capability: "configuration", implementation: "controlled" },
  );
  const selection = new DriverSelection();
  selection.registerDriver(driver);
  selection.selectDriver("compute", driver.id);
  return { values, options, driver, selection, owner: selectedComputeRendererOwner(driver) };
}

function templateInput(f, role) {
  return {
    name: `renderer-${role}`,
    ownership: f.values.agentOwnership,
    namespace: f.values.namespace,
    serviceAccountName: `renderer-${role}-sa`,
    environment: {},
    loggingLevel: "info",
    resourcePlan: f.values.plan[role === "gateway" ? "gateway" : "harness"],
  };
}

test("factory renderer owner retains actual source and rejects copied enrollment", () => {
  const f = fixture();
  const definition = f.owner.definition();
  assert.equal(f.owner, f.driver.getRendererOwner());
  assert.equal(definition.workload.construct, fixedWorkloadDeployment);
  assert.ok(Object.isFrozen(definition));
  assert.ok(Object.isFrozen(definition.workload.options));
  assert.equal(selectedComputeRendererOwner({ ...f.driver }), undefined);
  assert.equal(selectedComputeRendererOwner(new KubernetesComputeDriver(f.options)), undefined);
  assert.throws(
    () => new KubernetesRendererOwner(f.driver, { ...f.driver.workloadRenderer }, () => {}),
  );
  f.options.images.gateway = "caller-changed-image";
  assert.equal(f.owner.definition(), definition);
  assert.match(definition.workload.images.gateway, /@sha256:1{64}$/);
  assert.equal(f.driver.apiClients, undefined);
});

test("held original renderer constructs dedicated gateway and harness with selected images", () => {
  const f = fixture();
  const lease = f.owner.acquire(f.selection);
  try {
    const gateway = lease.gatewayTemplate(templateInput(f, "gateway"), "selected-gateway-runsc");
    const harness = lease.harnessTemplate(templateInput(f, "harness"));
    for (const [role, deployment] of [
      ["gateway", gateway],
      ["harness", harness],
    ]) {
      const pod = deployment.spec.template.spec;
      assert.equal(deployment.metadata.namespace, f.values.namespace);
      assert.equal(deployment.spec.replicas, 1);
      assert.equal(pod.containers.length, 1);
      assert.equal(pod.initContainers.length, 1);
      assert.equal(pod.automountServiceAccountToken, false);
      assert.equal(pod.containers[0].image, lease.definition.workload.images[role]);
      assert.equal(pod.initContainers[0].image, lease.definition.workload.images[role]);
      assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
      assert.equal(pod.containers[0].securityContext.allowPrivilegeEscalation, false);
      assert.deepEqual(pod.containers[0].securityContext.capabilities.drop, ["ALL"]);
      assert.equal(
        pod.volumes.some((v) => v.name === "openclaw-service-principal"),
        false,
      );
      assert.equal(
        pod.containers[0].env?.some((e) => e.name === "APP_SERVER_TOKEN") ?? false,
        false,
      );
      assert.deepEqual(pod.containers[0].resources, f.values.plan[role].application);
    }
    assert.equal(gateway.spec.template.spec.runtimeClassName, "selected-gateway-runsc");
    assert.equal(harness.spec.template.spec.runtimeClassName, GVISOR_RUNTIME_CLASS);
    assert.equal(lease.assertCurrent(), undefined);
    assert.equal(f.driver.apiClients, undefined);
  } finally {
    lease.release();
  }
});

test("admitted gateway overlay uses the owned template and exact later target correspondence", () => {
  const f = fixture();
  const lease = f.owner.acquire(f.selection);
  try {
    const input = templateInput(f, "gateway");
    const template = lease.gatewayTemplate(input, "selected-gateway-runsc");
    const pod = template.spec.template.spec;
    const stores = f.values.plan.gateway.values.envelope.gateway.value.storage.value;
    const plan = {
      target: {
        clusterRef: "controlled-selected-cluster",
        namespace: { name: input.namespace, uid: "controlled-namespace-uid", resourceVersion: "1" },
        deploymentName: input.name,
      },
      argv: ["/usr/bin/node", "/app/apps/gateway/src/main.mjs"],
      runtimeClassName: "selected-gateway-runsc",
      environment: [],
      volumes: pod.volumes,
      mounts: pod.containers[0].volumeMounts,
      resources: f.values.plan.gateway,
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
    // Runtime JS callers cannot inject an alternate image or Pod template.
    const rendered = lease.gatewayDeployment(input, {
      ...plan,
      image: "caller-image",
      template: { spec: { template: { spec: { hostNetwork: true } } } },
      applicationName: "caller-container",
    });
    assert.equal(rendered.spec.template.spec.containers[0].image, f.options.images.gateway);
    assert.equal(rendered.spec.template.spec.hostNetwork, undefined);
    assert.equal(rendered.spec.template.spec.containers[0].name, "gateway");
    assert.deepEqual(rendered.spec.template.spec.containers[0].command, ["/usr/bin/node"]);
    assert.deepEqual(rendered.spec.template.spec.containers[0].args, [
      "/app/apps/gateway/src/main.mjs",
    ]);
    assert.throws(() =>
      lease.gatewayDeployment(input, {
        ...plan,
        target: { ...plan.target, deploymentName: "different-target" },
      }),
    );
  } finally {
    lease.release();
  }
});

test("original selection is held until idempotent release and cannot be forged", () => {
  const f = fixture(),
    other = fixture("other-renderer");
  f.selection.registerDriver(other.driver);
  assert.throws(() =>
    f.owner.acquire({
      acquireGuardedSelection() {
        assert.fail("forged selection used");
      },
    }),
  );
  const lease = f.owner.acquire(f.selection);
  assert.throws(() => f.selection.selectDriver("compute", other.driver.id));
  lease.release();
  lease.release();
  assert.throws(() => lease.assertCurrent(), { code: "unavailable" });
  assert.throws(() => lease.gatewayTemplate(templateInput(f, "gateway"), "selected-gateway-runsc"));
  assert.throws(() => lease.harnessTemplate(templateInput(f, "harness")));
  f.selection.selectDriver("compute", other.driver.id);
  assert.throws(() => f.owner.acquire(f.selection));
});

test("selected definition replacement remains invalid after restoration and releases its hold", () => {
  const f = fixture(),
    other = fixture("replacement-renderer");
  f.selection.registerDriver(other.driver);
  const lease = f.owner.acquire(f.selection);
  const original = f.driver.options;
  try {
    f.driver.options = { ...original };
    assert.throws(() => lease.assertCurrent());
    f.driver.options = original;
    assert.throws(() => lease.assertCurrent(), { code: "unavailable" });
  } finally {
    f.driver.options = original;
    lease.release();
  }
  f.selection.selectDriver("compute", other.driver.id);
});

test("installed constructor replacement and mutable mount output cannot retain currentness", () => {
  for (const replace of ["constructor", "mount"]) {
    const f = fixture();
    const lease = f.owner.acquire(f.selection);
    const deployment = FixedWorkloadRenderer.prototype.deployment;
    const mount = SHARED_WORKSPACE_CATEGORIES[0][1];
    try {
      if (replace === "constructor")
        FixedWorkloadRenderer.prototype.deployment = () => {
          assert.fail("replacement invoked");
        };
      else SHARED_WORKSPACE_CATEGORIES[0][1] = "/changed-source-mount";
      assert.throws(() => lease.assertCurrent(), { code: "unavailable" });
      FixedWorkloadRenderer.prototype.deployment = deployment;
      SHARED_WORKSPACE_CATEGORIES[0][1] = mount;
      assert.throws(() => lease.assertCurrent(), { code: "unavailable" });
    } finally {
      FixedWorkloadRenderer.prototype.deployment = deployment;
      SHARED_WORKSPACE_CATEGORIES[0][1] = mount;
      lease.release();
    }
  }
});

test("legacy runtime and projected-token branches stay unsupported and no full source is installed", () => {
  for (const change of [
    (options) => {
      options.runtime = driverValues().options.runtime;
    },
    (options) => {
      options.servicePrincipalCredentials = driverValues().options.servicePrincipalCredentials;
    },
  ]) {
    const f = fixture("unsupported-renderer", change);
    const held = f.owner.acquire(f.selection);
    try {
      // Generic selected construction is distinct from protected V2 compatibility.
      assert.equal(held.definition.workload.options.isolationProfile, "gvisor-systrap");
      const values = hostedValues(f);
      assert.throws(() => held.gatewayTemplate(templateInput(f, "gateway"), "selected-runsc"), {
        code: "unsupported-capability",
      });
      assert.throws(() => held.hostedGatewayDeployment(values.input, values.plan, values.file), {
        code: "unsupported-capability",
      });
    } finally {
      held.release();
    }
    assert.equal(f.owner.acquireDefinition, undefined);
    assert.equal(f.owner.acquireRevision, undefined);
    assert.equal(selectedComputeWorkloadProfileCapability(f.driver).acquire, undefined);
    assert.equal(f.driver.apiClients, undefined);
  }
});

function hostedValues(f) {
  const input = templateInput(f, "gateway");
  delete input.environment;
  const stores = f.values.plan.gateway.values.envelope.gateway.value.storage.value;
  return {
    input,
    plan: {
      target: {
        clusterRef: "controlled-selected-cluster",
        namespace: { name: input.namespace, uid: "controlled-namespace-uid", resourceVersion: "1" },
        deploymentName: input.name,
      },
      runtimeClassName: "selected-gateway-runsc",
      resources: f.values.plan.gateway,
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
    },
    file: {
      apiVersion: "v1",
      kind: "ConfigMap",
      immutable: true,
      metadata: {
        namespace: input.namespace,
        name: "original-hosted-launch",
        uid: "original-configmap-uid",
        resourceVersion: "11",
      },
      // Controlled constructor bytes only: the original reader must separately
      // verify its closed native/profile/association grammar and actual owners.
      data: { "launch.json": '{"schemaVersion":1}' },
    },
  };
}

test("held hosted constructor fixes launcher, regular-file mount and actual exec readiness shape", () => {
  const f = fixture();
  const lease = f.owner.acquire(f.selection);
  try {
    const { input, plan, file } = hostedValues(f);
    const { deployment, launchFile } = lease.hostedGatewayDeployment(
      {
        ...input,
        configuration: {
          name: "caller-configuration",
          revision: 1,
          revisionId: "caller-revision",
          usesTrustedProxyAuth: false,
          annotations: {},
          loggingLevel: "info",
        },
        serviceAccount: {
          id: "caller-service-account",
          credential: { kind: "api_key", secretRef: { name: "caller-model-key", key: "value" } },
        },
        environment: { OPENAI_API_KEY: "must-not-project" },
        secretEnvironment: [
          { name: "OPENAI_API_KEY", backendRef: { name: "forbidden", key: "value" } },
        ],
      },
      {
        ...plan,
        argv: ["/caller-program"],
        environment: [{ name: "CALLER", value: "no" }],
        volumes: [],
      },
      file,
    );
    const pod = deployment.spec.template.spec,
      app = pod.containers[0];
    assert.equal(pod.containers.length, 1);
    assert.equal(pod.initContainers.length, 1);
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(
      pod.volumes.some((v) => v.name === "openclaw-configuration"),
      false,
    );
    assert.equal(
      app.env.some((e) => e.valueFrom?.secretKeyRef?.name === "caller-model-key"),
      false,
    );
    assert.deepEqual(app.command, ["/usr/local/bin/node"]);
    assert.deepEqual(app.args, [gatewayMainPath]);
    assert.deepEqual(app.readinessProbe, {
      exec: { command: ["node", gatewayReadinessPath] },
      timeoutSeconds: 1,
      periodSeconds: 2,
      failureThreshold: 1,
    });
    assert.equal(
      app.env.some(
        (e) => e.name === "OPENAI_API_KEY" || e.name === "CALLER" || e.name === "APP_SERVER_TOKEN",
      ),
      false,
    );
    const volume = pod.volumes.find((v) => v.name === "hosted-gateway-launch");
    assert.deepEqual(volume, {
      name: "hosted-gateway-launch",
      configMap: {
        name: file.metadata.name,
        optional: false,
        defaultMode: 0o440,
        items: [{ key: "launch.json", path: "launch.json", mode: 0o440 }],
      },
    });
    assert.deepEqual(
      app.volumeMounts.find((m) => m.name === volume.name),
      {
        name: volume.name,
        mountPath: gatewayLaunchPath,
        subPath: "launch.json",
        readOnly: true,
      },
    );
    assert.deepEqual(launchFile, {
      namespace: input.namespace,
      name: file.metadata.name,
      uid: file.metadata.uid,
      resourceVersion: "11",
    });
    file.metadata.uid = "caller-mutated";
    assert.equal(launchFile.uid, "original-configmap-uid");
    assert.ok(Object.isFrozen(deployment));
    assert.equal(f.driver.apiClients, undefined);
  } finally {
    lease.release();
  }
});

test("hosted construction refuses mutable, unbound, oversized or noncompact descriptor operands", () => {
  const f = fixture();
  const lease = f.owner.acquire(f.selection);
  try {
    for (const change of [
      (v) => {
        v.immutable = false;
      },
      (v) => {
        delete v.metadata.uid;
      },
      (v) => {
        v.metadata.namespace = "another-namespace";
      },
      (v) => {
        v.metadata.resourceVersion = "";
      },
      (v) => {
        v.metadata.deletionTimestamp = "2026-09-09T00:00:00Z";
      },
      (v) => {
        v.data.extra = "unexpected";
      },
      (v) => {
        v.data["launch.json"] += "\n";
      },
      (v) => {
        v.data["launch.json"] = "not-json";
      },
      (v) => {
        v.data["launch.json"] = JSON.stringify({
          schemaVersion: 1,
          text: "x".repeat(gatewayLaunchMaxBytes),
        });
      },
    ]) {
      const { input, plan, file } = hostedValues(f);
      change(file);
      assert.throws(() => lease.hostedGatewayDeployment(input, plan, file), {
        code: "unavailable",
      });
    }
    const { input, plan, file } = hostedValues(f);
    assert.throws(() =>
      lease.hostedGatewayDeployment(
        input,
        { ...plan, target: { ...plan.target, deploymentName: "other-deployment" } },
        file,
      ),
    );
  } finally {
    lease.release();
  }
  const { input, plan, file } = hostedValues(f);
  assert.throws(() => lease.hostedGatewayDeployment(input, plan, file), { code: "unavailable" });
});

test("hosted V2 constructor binds the original subject and physical target while preserving native version independence", () => {
  const f = fixture(),
    lease = f.owner.acquire(f.selection);
  try {
    const { input, plan, file } = hostedValues(f);
    input.ownership = {
      namespaceId: "ns_00000000-0000-4000-8000-000000000004",
      agentId: "agt_00000000-0000-4000-8000-000000000005",
      revisionId: "revision-fixture",
    };
    const v = hostedLaunchV2(plan.target, input.ownership);
    plan.original = v.original;
    file.data["launch.json"] = v.document;
    assert.notEqual(v.value.configurationVersion, v.value.binding.configurationVersion);
    const result = lease.hostedGatewayDeployment(input, plan, file);
    assert.equal(result.deployment.metadata.name, plan.target.deploymentName);
    assert.equal(result.deployment.spec.template.spec.containers[0].args[0], gatewayMainPath);
    for (const change of [
      (p) => {
        delete p.original;
      },
      (p) => {
        p.original.target.namespace.uid = "different-namespace";
      },
      (p) => {
        p.original.binding.agentRef = "agt_00000000-0000-4000-8000-000000000099";
      },
      (_p, value) => {
        value.consumeCommand.expectedHead.startup.processRef = "different-process";
      },
    ]) {
      const candidatePlan = structuredClone(plan),
        value = JSON.parse(v.document),
        candidateFile = structuredClone(file);
      change(candidatePlan, value);
      candidateFile.data["launch.json"] = canonicalGatewayStartupValueV1(value);
      assert.throws(() => lease.hostedGatewayDeployment(input, candidatePlan, candidateFile), {
        code: "unavailable",
      });
    }
  } finally {
    lease.release();
  }
});
