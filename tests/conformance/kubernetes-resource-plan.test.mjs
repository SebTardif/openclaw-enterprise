import assert from "node:assert/strict";
import test from "node:test";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { normalizeKubernetesResourcePlan } from "../../apps/controller/src/drivers/compute/kubernetes/resources/revision-resource-plan.ts";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import {
  builderEnvelope,
  driverValues,
  renderPlanned,
} from "../fixtures/kubernetes-resource-plan/driver-values.mjs";
import { unavailableDiagnosticInput } from "../fixtures/kubernetes-resource-plan/diagnostic-values.mjs";

for (const component of ["gateway", "harness"]) {
  test(`real Compute builder applies separate ${component} application/init selection`, () => {
    const values = driverValues();
    const object = renderPlanned(values, component);
    const pod = object.spec.template.spec;
    const plan = values.plan[component];
    assert.deepEqual(pod.containers[0].resources, plan.application);
    assert.deepEqual(pod.initContainers[0].resources, plan.privateStateInit);
    assert.notDeepEqual(plan.application, plan.privateStateInit);
    assert.equal(pod.initContainers[0].name, "prepare-private-state");
    assert.equal(
      pod.volumes.find((item) => item.name === "runtime-state").emptyDir.sizeLimit,
      String(plan.runtimeHomeBytes),
    );
    assert.equal(
      pod.volumes.find((item) => item.name === "runtime-temporary").emptyDir.sizeLimit,
      String(plan.temporaryBytes),
    );
    assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
    assert.equal(pod.initContainers[0].securityContext.allowPrivilegeEscalation, false);
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(values.driver.apiClients, undefined);
  });
}

test("selected plan is a snapshot of all accounting values", () => {
  const values = driverValues();
  const before = renderPlanned(values);
  values.source.envelope.harness.value.contributions[0].resources.cpuMilli.value.limit = 999999;
  values.source.mapping.harness.application = "another-application";
  values.options.resources.agent.limits.cpu = "999m";
  assert.deepEqual(renderPlanned(values), before);
  assert.ok(Object.isFrozen(values.plan.envelope.harness.value.contributions));
});

for (const [name, mutate] of [
  [
    "missing init ephemeral storage",
    ({ envelope }) => {
      envelope.harness.value.contributions[1].resources.ephemeralStorageBytes = {
        status: "unavailable",
        ownerRef: "init-owner",
        reason: "owner-input-missing",
      };
    },
  ],
  [
    "wrong contribution mapping",
    ({ mapping }) => {
      mapping.harness.application = "gateway/app";
    },
  ],
  [
    "extra helper",
    ({ envelope }) => {
      envelope.harness.value.contributions.push({
        ...structuredClone(envelope.harness.value.contributions[0]),
        accountingId: "harness/helper",
        kind: "helper",
      });
      envelope.harness.value.phases.value[1].active.push("harness/helper");
    },
  ],
  [
    "unsupported concurrent init",
    ({ envelope }) => {
      envelope.harness.value.phases.value[0].active.push("harness/app");
    },
  ],
  [
    "memory-backed temporary storage",
    ({ envelope }) => {
      envelope.harness.value.storage.value.find((item) => item.kind === "temporary").medium =
        "memory";
    },
  ],
  [
    "conflicting selected default",
    ({ envelope }) => {
      envelope.harness.value.alternatives.value.push({
        source: "limitrange-default",
        accountingId: "harness/app",
        resources: {
          cpuMilli: { request: 1, limit: 2 },
          memoryBytes: { request: 1, limit: 2 },
          ephemeralStorageBytes: { request: 1, limit: 2 },
        },
      });
    },
  ],
]) {
  test(`real selected topology refuses ${name}`, () => {
    const input = builderEnvelope();
    mutate(input);
    assert.throws(
      () => normalizeKubernetesResourcePlan(input.envelope, input.mapping),
      /resource selection is invalid/,
    );
  });
}

test("actual builder rejects conflicting configured comparison and malformed supplied plan", () => {
  const values = driverValues();
  const changed = structuredClone(values.options);
  changed.resources.agent.limits.cpu = "1000m";
  const driver = new KubernetesComputeDriver(changed);
  assert.throws(() => renderPlanned({ ...values, driver }), /resource selection is invalid/);
  const plan = { ...values.plan, harness: { ...values.plan.harness, privateStateInit: undefined } };
  assert.throws(() => renderPlanned({ ...values, plan }), /resource selection is invalid/);
});

test("actual renderer revalidates derived fields against their retained accounting", () => {
  const values = driverValues();
  const plan = structuredClone(values.plan);
  assert.deepEqual(renderPlanned({ ...values, plan }), renderPlanned(values));
  plan.harness.privateStateInit.limits.cpu = "999999m";
  assert.throws(() => renderPlanned({ ...values, plan }), /resource selection is invalid/);
});

for (const name of ["application", "init"]) {
  test(`selected builder requires positive ${name} limits but permits zero requests`, () => {
    const input = builderEnvelope();
    const contribution = input.envelope.harness.value.contributions[name === "application" ? 0 : 1];
    contribution.resources.cpuMilli.value.request = 0;
    assert.doesNotThrow(() => normalizeKubernetesResourcePlan(input.envelope, input.mapping));
    contribution.resources.cpuMilli.value.limit = 0;
    assert.throws(
      () => normalizeKubernetesResourcePlan(input.envelope, input.mapping),
      /resource selection is invalid/,
    );
  });
}

for (const key of ["pods", "requests.cpu", "limits.memory", "requests.ephemeral-storage"]) {
  test(`actual renderer rejects an insufficient configured ${key} cap`, () => {
    const values = driverValues();
    const options = structuredClone(values.options);
    options.resources.namespace.quota[key] = "0";
    const driver = new KubernetesComputeDriver(options);
    assert.throws(() => renderPlanned({ ...values, driver }), /resource selection is invalid/);
  });
}

test("configured cap comparison requires explicit caps and does not apply unused defaults", () => {
  const values = driverValues();
  const missing = structuredClone(values.options);
  delete missing.resources.namespace.quota["limits.ephemeral-storage"];
  assert.throws(
    () => renderPlanned({ ...values, driver: new KubernetesComputeDriver(missing) }),
    /resource selection is invalid/,
  );
  // Both real containers supply every dimension; the global default is unused.
  assert.notDeepEqual(
    values.options.resources.namespace.containerDefaults,
    values.plan.harness.application,
  );
  assert.doesNotThrow(() => renderPlanned(values));
});

test("configured cap boundary includes full Pod reservations and concurrent preparation instances", () => {
  const values = driverValues();
  const input = builderEnvelope();
  input.envelope.repositoryPreparation.value.execution.value.maxConcurrentInstances = 3;
  const plan = normalizeKubernetesResourcePlan(input.envelope, input.mapping);
  const options = structuredClone(values.options);
  // Each declared Pod reserves 600/1200 millicpu. Gateway plus three preparation
  // instances therefore requires 2400/4800 and four Pods, exceeding the two-Pod
  // gateway/Harness group. Sequential maxAttempts is deliberately not counted.
  options.resources.namespace.quota["requests.cpu"] = "2400m";
  options.resources.namespace.quota["limits.cpu"] = "4800m";
  options.resources.namespace.quota.pods = "4";
  const render = (configured) =>
    renderPlanned({
      ...values,
      plan,
      driver: new KubernetesComputeDriver(configured),
    });
  assert.doesNotThrow(() => render(options));
  const belowCpu = structuredClone(options);
  belowCpu.resources.namespace.quota["requests.cpu"] = "2399m";
  assert.throws(() => render(belowCpu), /resource selection is invalid/);
  const belowPods = structuredClone(options);
  belowPods.resources.namespace.quota.pods = "3";
  assert.throws(() => render(belowPods), /resource selection is invalid/);
});

for (const runtime of [true, false]) {
  for (const operation of ["prepareRevision", "activateRevision"]) {
    test(`required association is unavailable before ${operation}, runtime=${runtime}`, async () => {
      const values = driverValues({ mode: "admitted" });
      const options = structuredClone(values.options);
      if (!runtime) delete options.runtime;
      const policy = { mode: "admitted" };
      const driver = new KubernetesComputeDriver(options, { resourcePolicy: policy });
      policy.mode = "configured";
      let hooks = 0;
      driver.setLifecycleDrivers([
        {
          id: "resource-fixture",
          capability: "configuration",
          implementation: "controlled-hook",
          computeLifecycleHooks: {
            beforeWorkloadStart: async () => {
              hooks++;
            },
            beforeWorkloadStop: async () => {
              hooks++;
            },
          },
        },
      ]);
      // No client or namespace resolver is injected: even constructing the real API
      // clients would violate this path's before-effects unavailable boundary.
      await assert.rejects(
        driver[operation](values.revision),
        /protected resource-envelope association is unavailable/,
      );
      assert.equal(driver.apiClients, undefined);
      assert.equal(hooks, 0);
    });
  }
}

test("existing Compute entry cancellation guard runs before required-mode preparation", async () => {
  const values = driverValues({ mode: "admitted" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    withComputeAbortSignal(controller.signal, () => values.driver.prepareRevision(values.revision)),
    /unavailable|abort|cancel/i,
  );
  assert.equal(values.driver.apiClients, undefined);
});

test("actual Compute diagnostic consumer retains unavailable effective-resource evidence", () => {
  const values = driverValues();
  const result = values.driver.resourceDiagnostics(unavailableDiagnosticInput());
  assert.equal(result.effectiveResources, "unavailable");
  assert.equal(result.authority, "none");
  assert.equal(values.driver.apiClients, undefined);
});

test("configured resource quantities now use the actual exact normalization leaf", () => {
  const values = driverValues();
  for (const cpu of ["0.0001", "NaN", "1garbage"]) {
    const options = structuredClone(values.options);
    options.resources.agent.requests.cpu = cpu;
    assert.throws(() => new KubernetesComputeDriver(options), /resource quantities are invalid/);
  }
  const options = structuredClone(values.options);
  options.resources.agent.requests.cpu = "0.1";
  assert.doesNotThrow(() => new KubernetesComputeDriver(options));
});
