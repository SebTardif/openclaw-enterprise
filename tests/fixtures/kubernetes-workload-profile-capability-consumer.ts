import type { ComputeDriver, ConfigurationDriver } from "@openclaw-enterprise/contracts";
import type { WorkloadProfileCapabilitySourceV2 } from "@openclaw-enterprise/occ/workload-profiles/selection";
import type { GatewayStartupOwnerLeaseV1 } from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import {
  createComputeDriver,
  selectedComputeWorkloadProfileCapability,
} from "../../apps/controller/src/composition/driver-factories/compute.ts";
import type { KubernetesComputeDriverOptions } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type {
  KubernetesRendererSource,
  KubernetesWorkloadProfileCapability,
  SelectedKubernetesRendererDefinition,
} from "../../apps/controller/src/drivers/compute/kubernetes/workload-profile-capability.ts";

import type {
  WorkloadProfileRendererContributionV2,
  WorkloadProfileDefinitionSourceV2,
  WorkloadProfileDefinitionRequestV2,
  WorkloadProfileDefinitionUnitV2,
  WorkloadProfileOwnedOperationV2,
} from "@openclaw-enterprise/occ/workload-profiles/admitted-use";

type RevisionArguments = Parameters<
  WorkloadProfileRendererContributionV2["verifyRevisionRendererLocked"]
>;

export function composeSelected(
  selection: Parameters<typeof createComputeDriver>[0],
  configuration: ConfigurationDriver,
  originalSource: KubernetesRendererSource,
): Readonly<{ driver: ComputeDriver; partial: KubernetesWorkloadProfileCapability | undefined }> {
  const driver = createComputeDriver(
    selection,
    configuration,
    undefined,
    undefined,
    originalSource,
  );
  return { driver, partial: selectedComputeWorkloadProfileCapability(driver) };
}

export async function consumeRevision(
  partial: KubernetesWorkloadProfileCapability,
  input: RevisionArguments,
): Promise<GatewayStartupOwnerLeaseV1> {
  return partial.verifyRevisionRendererLocked(...input);
}

export function completeInstalledInputs(definition: SelectedKubernetesRendererDefinition): void {
  const selectedImage: string = definition.workload.images.harness;
  const credentials: KubernetesComputeDriverOptions["servicePrincipalCredentials"] =
    definition.workload.options.servicePrincipalCredentials;
  const construct = definition.workload.construct;
  const helper = definition.workload.privateStateInit;
  const gateway = definition.admittedDeployment;
  void [selectedImage, credentials, construct, helper, gateway];
}

export function partialIsNotAuthority(
  partial: KubernetesWorkloadProfileCapability,
  definition: SelectedKubernetesRendererDefinition,
  original: KubernetesRendererSource,
  selected: ComputeDriver,
  input: RevisionArguments,
): void {
  // @ts-expect-error a renderer contribution lacks whole source acquisition
  const whole: WorkloadProfileCapabilitySourceV2 = partial;
  // @ts-expect-error copied options/constructor data are not a current lease
  const current: GatewayStartupOwnerLeaseV1 = definition;
  // @ts-expect-error an id string cannot stand in for the selected Driver object
  void original.acquireRevision(selected.id, definition, ...input);
  // @ts-expect-error a request/configuration projection cannot replace original unit/IO
  void partial.verifyRevisionRendererLocked(input[0], input[1], input[2], input[0], input[0]);
  void [whole, current];
}

export async function consumeDefinition(
  partial: KubernetesWorkloadProfileCapability,
  request: WorkloadProfileDefinitionRequestV2,
  unit: WorkloadProfileDefinitionUnitV2,
  io: WorkloadProfileOwnedOperationV2,
): Promise<GatewayStartupOwnerLeaseV1> {
  const contribution: WorkloadProfileRendererContributionV2 = partial;
  return contribution.verifyRendererDefinitionLocked(request, unit, io);
}

export function definitionHasNoRevision(
  partial: KubernetesWorkloadProfileCapability,
  definition: WorkloadProfileDefinitionRequestV2,
  unit: WorkloadProfileDefinitionUnitV2,
  io: WorkloadProfileOwnedOperationV2,
  revision: RevisionArguments,
): void {
  // @ts-expect-error partial renderer does not acquire the complete definition
  const whole: WorkloadProfileDefinitionSourceV2 = partial;
  // @ts-expect-error profile definition has no revision Use operand
  void partial.verifyRendererDefinitionLocked({ ...definition, use: revision[2] }, unit, io);
  // @ts-expect-error original revision unit cannot become a profile owner unit
  void partial.verifyRendererDefinitionLocked(definition, revision[3], io);
  // @ts-expect-error definition has no per-revision Configuration/use correspondence
  void partial.verifyRevisionRendererLocked(definition, revision[1], revision[2], unit, io);
  void whole;
}
