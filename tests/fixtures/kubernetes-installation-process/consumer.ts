import type {
  GatewayProcessParticipantV1,
  GatewayProcessCallV1,
  GatewayProcessCreateInputV1,
  GatewayProcessObservationInputV1,
  GatewayProcessRetirementInputV1,
  GatewayStartupOperationLocatorV1,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";
import { KubernetesComputeDriver } from "../../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { KubernetesInstallationProcessDependencies } from "../../../apps/controller/src/drivers/compute/kubernetes/installation-process.ts";

export function compose(
  options: ConstructorParameters<typeof KubernetesComputeDriver>[0],
  dependencies: KubernetesInstallationProcessDependencies,
): GatewayProcessParticipantV1 {
  return new KubernetesComputeDriver(options, {
    installationProcessDependencies: dependencies,
  }).getInstallationProcessParticipant();
}

export async function consume(
  participant: GatewayProcessParticipantV1,
  call: GatewayProcessCallV1,
  create: GatewayProcessCreateInputV1,
  observation: GatewayProcessObservationInputV1,
  retirement: GatewayProcessRetirementInputV1,
  locator: GatewayStartupOperationLocatorV1,
): Promise<void> {
  const created = await participant.createOriginal(create, call);
  if (created.kind === "accepted-object") {
    const processGeneration: number = created.original.binding.startup.processGeneration;
    const hostGeneration: number = created.original.binding.hostRuntimeGeneration;
    void [processGeneration, hostGeneration];
  }
  await participant.discoverOriginal(locator, call);
  await participant.observeExact(observation, call);
  await participant.requestRetirement(retirement, call);
  await participant.recoverOriginal(locator, call);
  const disposition = await participant.readReplacementDisposition(locator, call);
  if (disposition.kind === "verified-disposition") {
    const originalReceipt: number = disposition.receipt.recordVersion;
    void originalReceipt;
  }
  // A serializable lookup and a raw authority call cannot mint recipient enrollment.
  // @ts-expect-error a process call retains the original private enrollment identity
  const fabricatedCall: GatewayProcessCallV1 = { authorityCall: call.authorityCall };
  void fabricatedCall;
  // @ts-expect-error create requires the original protected plan reference and binding
  await participant.createOriginal({ target: create.target }, call);
}
