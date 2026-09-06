import { isDeepStrictEqual } from "node:util";
import type { AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import type {
  RuntimeResourceAccountingEnvelopeV1,
  RuntimeResourceVectorV1,
  RuntimeWorkloadAccountingV1,
} from "@openclaw-enterprise/contracts/runtime-resource-accounting-v1";
import { ConfigurationFailure } from "./identity.ts";
import {
  compareResourceRequirements,
  normalizeResourceAccountingEnvelope,
  normalizeResourceRequirements,
  normalizeResourceQuantity,
  resourceRequirementsFromVector,
  type NormalizedResourceRequirements,
} from "./resource-normalization.ts";
import { projectRuntimeResourceDiagnostics } from "../resource-diagnostics.ts";

export interface KubernetesResourceContributionMap {
  readonly application: string;
  readonly privateStateInit: string;
}

export interface KubernetesWorkloadResourcePlan {
  readonly component: "gateway" | "harness";
  readonly values: {
    readonly envelope: RuntimeResourceAccountingEnvelopeV1;
    readonly mapping: Readonly<Record<"gateway" | "harness", KubernetesResourceContributionMap>>;
  };
  readonly application: NormalizedResourceRequirements;
  readonly privateStateInit: NormalizedResourceRequirements;
  readonly podBudget: RuntimeResourceVectorV1;
  readonly runtimeHomeBytes: number;
  readonly temporaryBytes: number;
}

export interface KubernetesNormalizedResourcePlan {
  readonly envelope: RuntimeResourceAccountingEnvelopeV1;
  readonly gateway: KubernetesWorkloadResourcePlan;
  readonly harness: KubernetesWorkloadResourcePlan;
}

/** Construction policy is independent of whether a protected producer is available. */
export type KubernetesResourcePolicy =
  { readonly mode: "configured" } | { readonly mode: "admitted" };

export function assertKubernetesResourcePolicyAvailable(policy: KubernetesResourcePolicy): void {
  if (policy.mode === "configured") return;
  if (policy.mode !== "admitted") invalid();
  // TODO(protected resource-envelope association): consume the original admission
  // owner's accepted immutable byte/digest/revision association before enabling
  // this path. Pure accounting values cannot provide that authority.
  throw new ConfigurationFailure("The protected resource-envelope association is unavailable.");
}

export function snapshotKubernetesWorkloadResourcePlan(
  plan: KubernetesWorkloadResourcePlan,
): KubernetesWorkloadResourcePlan {
  if (plan.component !== "gateway" && plan.component !== "harness") invalid();
  const rebuilt = normalizeKubernetesResourcePlan(plan.values.envelope, plan.values.mapping)[
    plan.component
  ];
  for (const field of ["application", "privateStateInit"] as const) {
    assertKubernetesResourceComparison(rebuilt[field], plan[field]);
  }
  assertKubernetesResourceComparison(
    resourceRequirementsFromVector(rebuilt.podBudget),
    resourceRequirementsFromVector(plan.podBudget),
  );
  if (
    plan.runtimeHomeBytes !== rebuilt.runtimeHomeBytes ||
    plan.temporaryBytes !== rebuilt.temporaryBytes
  )
    invalid();
  return rebuilt;
}

function invalid(): never {
  throw new ConfigurationFailure("The immutable Kubernetes resource selection is invalid.");
}

function contributionResources(
  contribution: RuntimeWorkloadAccountingV1["contributions"][number],
): RuntimeResourceVectorV1 {
  const { cpuMilli, memoryBytes, ephemeralStorageBytes } = contribution.resources;
  if (
    cpuMilli.status !== "supplied" ||
    memoryBytes.status !== "supplied" ||
    ephemeralStorageBytes.status !== "supplied"
  )
    invalid();
  return {
    cpuMilli: cpuMilli.value,
    memoryBytes: memoryBytes.value,
    ephemeralStorageBytes: ephemeralStorageBytes.value,
  };
}

function workloadPlan(
  workload: RuntimeWorkloadAccountingV1,
  mapping: KubernetesResourceContributionMap,
  component: "gateway" | "harness",
  values: KubernetesWorkloadResourcePlan["values"],
): KubernetesWorkloadResourcePlan {
  if (
    mapping.application === mapping.privateStateInit ||
    workload.contributions.length !== 2 ||
    workload.phases.status !== "supplied" ||
    workload.podBudget.status !== "supplied" ||
    workload.storage.status !== "supplied"
  )
    invalid();
  const application = workload.contributions.find(
    (item) => item.accountingId === mapping.application && item.kind === "application",
  );
  const init = workload.contributions.find(
    (item) => item.accountingId === mapping.privateStateInit && item.kind === "init",
  );
  if (application === undefined || init === undefined) invalid();
  for (const contribution of [application, init]) {
    const resources = contributionResources(contribution);
    if (
      resources.cpuMilli.limit <= 0 ||
      resources.memoryBytes.limit <= 0 ||
      resources.ephemeralStorageBytes.limit <= 0
    )
      invalid();
  }
  // This selected builder creates one ordinary init, followed by one application.
  // Broader accounting topologies do not authorize unrendered helper containers.
  const phases = workload.phases.value;
  if (
    phases.length !== 2 ||
    phases.filter(
      (phase) =>
        phase.kind === "initialization" &&
        isDeepStrictEqual(phase.active, [mapping.privateStateInit]),
    ).length !== 1 ||
    phases.filter(
      (phase) => phase.kind === "steady" && isDeepStrictEqual(phase.active, [mapping.application]),
    ).length !== 1
  )
    invalid();
  const home = workload.storage.value.filter((store) => store.kind === "runtime-home");
  const temporary = workload.storage.value.filter((store) => store.kind === "temporary");
  if (
    home.length !== 1 ||
    temporary.length !== 1 ||
    home[0]?.medium !== "disk-ephemeral" ||
    temporary[0]?.medium !== "disk-ephemeral"
  )
    invalid();
  return Object.freeze({
    component,
    values,
    application: resourceRequirementsFromVector(contributionResources(application)),
    privateStateInit: resourceRequirementsFromVector(contributionResources(init)),
    podBudget: workload.podBudget.value,
    runtimeHomeBytes: home[0].capacityBytes,
    temporaryBytes: temporary[0].capacityBytes,
  });
}

/** Pure supplied-value preparation. This function grants no admission or effect rights. */
export function normalizeKubernetesResourcePlan(
  input: unknown,
  mapping: Readonly<Record<"gateway" | "harness", KubernetesResourceContributionMap>>,
): KubernetesNormalizedResourcePlan {
  const normalized = normalizeResourceAccountingEnvelope(input);
  if (normalized.status !== "accounted") invalid();
  const envelope = normalized.envelope;
  if (envelope.gateway.status !== "supplied" || envelope.harness.status !== "supplied") invalid();
  const copiedMapping = Object.freeze({
    gateway: Object.freeze({
      application: mapping.gateway.application,
      privateStateInit: mapping.gateway.privateStateInit,
    }),
    harness: Object.freeze({
      application: mapping.harness.application,
      privateStateInit: mapping.harness.privateStateInit,
    }),
  });
  const values = Object.freeze({ envelope, mapping: copiedMapping });
  return Object.freeze({
    envelope,
    gateway: workloadPlan(envelope.gateway.value, copiedMapping.gateway, "gateway", values),
    harness: workloadPlan(envelope.harness.value, copiedMapping.harness, "harness", values),
  });
}

export interface KubernetesNamespaceResourceComparison {
  readonly quota: Readonly<Record<string, string>>;
  readonly containerDefaults: unknown;
}

/** A declared-demand comparison only. Current quota usage and admission are unavailable. */
export function assertKubernetesConfiguredQuota(
  plan: KubernetesWorkloadResourcePlan,
  configured: KubernetesNamespaceResourceComparison | undefined,
): void {
  if (
    configured === undefined ||
    normalizeResourceRequirements(configured.containerDefaults).status === "invalid"
  )
    invalid();
  // Both rendered containers have all explicit request/limit fields. Container
  // defaults therefore fill none of these values and need not equal each other.
  const envelope = plan.values.envelope;
  if (envelope.workloadConcurrency.status !== "supplied") invalid();
  const dimensions = [
    ["cpuMilli", "cpu"],
    ["memoryBytes", "memory"],
    ["ephemeralStorageBytes", "ephemeral-storage"],
  ] as const;
  let podDemand = 0;
  for (const group of envelope.workloadConcurrency.value) {
    let pods = 0;
    for (const name of group) {
      const workload = envelope[name];
      if (workload.status !== "supplied" || workload.value.execution.status !== "supplied")
        invalid();
      pods += workload.value.execution.value.maxConcurrentInstances;
    }
    podDemand = Math.max(podDemand, pods);
  }
  const podCap = configured.quota.pods;
  if (
    typeof podCap !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(podCap) ||
    !Number.isSafeInteger(Number(podCap)) ||
    podDemand > Number(podCap)
  )
    invalid();
  for (const [dimension, resource] of dimensions) {
    for (const pair of ["request", "limit"] as const) {
      let demand = 0;
      for (const group of envelope.workloadConcurrency.value) {
        let simultaneous = 0;
        for (const name of group) {
          const input = envelope[name];
          if (
            input.status !== "supplied" ||
            input.value.podBudget.status !== "supplied" ||
            input.value.execution.status !== "supplied"
          )
            invalid();
          const addition =
            input.value.podBudget.value[dimension][pair] *
            input.value.execution.value.maxConcurrentInstances;
          simultaneous += addition;
          if (!Number.isSafeInteger(simultaneous)) invalid();
        }
        demand = Math.max(demand, simultaneous);
      }
      const prefix = pair === "request" ? "requests" : "limits";
      const value = configured.quota[`${prefix}.${resource}`];
      let hard: number;
      try {
        hard = normalizeResourceQuantity(resource, value);
      } catch {
        return invalid();
      }
      if (demand > hard) invalid();
    }
  }
}

/** Compare selected values without turning a configured alternative into a default. */
export function assertKubernetesResourceComparison(
  selected: NormalizedResourceRequirements,
  candidate: unknown,
): void {
  const normalized = normalizeResourceRequirements(selected);
  if (
    normalized.status !== "normalized" ||
    compareResourceRequirements(normalized.vector, candidate).status !== "match"
  )
    invalid();
}

export function projectKubernetesResourceDiagnostics(
  input: Parameters<typeof projectRuntimeResourceDiagnostics>[0],
): ReturnType<typeof projectRuntimeResourceDiagnostics> {
  return projectRuntimeResourceDiagnostics(input);
}

export type KubernetesResourceRevision = Readonly<AgentRevision>;
