import { KubernetesComputeDriver } from "../../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  deployment,
  type WorkloadOptions,
} from "../../../apps/controller/src/drivers/compute/kubernetes/resources/harness.ts";
import {
  normalizeKubernetesResourcePlan,
  type KubernetesResourceContributionMap,
} from "../../../apps/controller/src/drivers/compute/kubernetes/resources/revision-resource-plan.ts";
import type { RuntimeResourceAccountingEnvelopeV1 } from "@openclaw-enterprise/contracts/runtime-resource-accounting-v1";
import type { RuntimeResourceDiagnosticInput } from "../../../apps/controller/src/drivers/compute/kubernetes/resource-diagnostics.ts";

export function consumeBuilder(
  envelope: RuntimeResourceAccountingEnvelopeV1,
  mapping: Readonly<Record<"gateway" | "harness", KubernetesResourceContributionMap>>,
  options: WorkloadOptions,
) {
  const selected = normalizeKubernetesResourcePlan(envelope, mapping);
  return deployment(
    { ...options, resourcePlan: selected.harness },
    "selected-harness",
    { namespaceId: "namespace", agentId: "agent" },
    "kubernetes-namespace",
    "image@sha256:digest",
    "service-account",
    "agent",
    {},
    "info",
  );
}

export function consumeDiagnostics(
  driver: KubernetesComputeDriver,
  input: RuntimeResourceDiagnosticInput,
) {
  const projected = driver.resourceDiagnostics(input);
  const unavailable: "unavailable" = projected.effectiveResources;
  return unavailable;
}
