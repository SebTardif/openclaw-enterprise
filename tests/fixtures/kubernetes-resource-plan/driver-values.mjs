import { KubernetesComputeDriver } from "../../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { normalizeKubernetesResourcePlan } from "../../../apps/controller/src/drivers/compute/kubernetes/resources/revision-resource-plan.ts";
import { scenarios } from "../kubernetes-resource-builders/scenarios.mjs";
import { resourceEnvelope, supplied } from "./normalization-values.mjs";

// Synthetic complete accounting for the actual one-init selected template.
// It is not an authenticated revision/envelope association or admission record.
export function builderEnvelope() {
  const envelope = resourceEnvelope();
  const mapping = {};
  for (const component of ["gateway", "harness"]) {
    const workload = envelope[component].value;
    workload.contributions = workload.contributions.slice(0, 2);
    mapping[component] = {
      application: `${component}/app`,
      privateStateInit: `${component}/init-a`,
    };
    workload.phases = supplied([
      { phaseRef: `${component}/init`, kind: "initialization", active: [`${component}/init-a`] },
      { phaseRef: `${component}/steady`, kind: "steady", active: [`${component}/app`] },
    ]);
    workload.storage.value.find((item) => item.kind === "temporary").medium = "disk-ephemeral";
  }
  return { envelope, mapping };
}

export function driverValues(policy = { mode: "configured" }) {
  const scenario = scenarios().find((value) => value.name === "runtime-dedicated-routed-channels");
  const source = builderEnvelope();
  const plan = normalizeKubernetesResourcePlan(source.envelope, source.mapping);
  const options = structuredClone(scenario.options);
  options.resources.gateway = structuredClone(plan.gateway.application);
  options.resources.agent = structuredClone(plan.harness.application);
  options.resources.namespace.quota = {
    pods: "10",
    "requests.cpu": "10",
    "limits.cpu": "20",
    "requests.memory": "1Mi",
    "limits.memory": "2Mi",
    "requests.ephemeral-storage": "1Mi",
    "limits.ephemeral-storage": "2Mi",
  };
  const driver = new KubernetesComputeDriver(options, { resourcePolicy: policy });
  return { ...scenario, options, driver, plan, source };
}

export function renderPlanned(values, component = "harness") {
  const role = component === "harness" ? "agent" : "gateway";
  return values.driver.deployment(
    `resource-${role}`,
    values.agentOwnership,
    values.namespace,
    values.options.images[role],
    `resource-${role}-sa`,
    role,
    {},
    "info",
    undefined,
    false,
    undefined,
    undefined,
    [],
    [],
    values.plan[component],
  );
}
