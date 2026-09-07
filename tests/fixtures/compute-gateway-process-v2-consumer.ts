import type {
  GatewayProcessParticipantV1,
  GatewayProcessParticipantV2,
  GatewayProcessCallV1,
  GatewayProcessCallV2,
  GatewayProcessCreateInputV1,
  GatewayProcessCreateInputV2,
  GatewayProcessObservationInputV2,
  GatewayProcessRetirementInputV2,
  GatewayStartupOperationLocatorV2,
  GatewayProcessSubmissionV1,
  GatewayProcessSubmissionOwnerV2,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { KubernetesAgentGatewayDependencies } from "../../apps/controller/src/drivers/compute/kubernetes/installation-process.ts";
import {
  renderAdmittedGatewayLaunch,
  type AdmittedGatewayLaunchSource,
} from "../../apps/controller/src/drivers/compute/kubernetes/admitted-launch-plan.ts";

export function compose(
  options: ConstructorParameters<typeof KubernetesComputeDriver>[0],
  dependencies: KubernetesAgentGatewayDependencies,
): { current: GatewayProcessParticipantV2; historical: GatewayProcessParticipantV1 } {
  const driver = new KubernetesComputeDriver(options, { agentGatewayDependencies: dependencies });
  return {
    current: driver.getAgentGatewayProcessParticipant(),
    historical: driver.getInstallationProcessParticipant(),
  };
}

export async function consume(
  participant: GatewayProcessParticipantV2,
  call: GatewayProcessCallV2,
  create: GatewayProcessCreateInputV2,
  observation: GatewayProcessObservationInputV2,
  retirement: GatewayProcessRetirementInputV2,
  locator: GatewayStartupOperationLocatorV2,
  plans: AdmittedGatewayLaunchSource,
): Promise<void> {
  const created = await participant.createOriginal(create, call);
  if (created.kind === "accepted-object") {
    const subject: "agent-gateway" = created.original.binding.startup.subject.kind;
    const hostGeneration: number = created.original.binding.hostRuntimeGeneration;
    const processGeneration: number = created.original.binding.startup.processGeneration;
    void [subject, hostGeneration, processGeneration];
  }
  await participant.discoverOriginal(locator, call);
  await participant.observeExact(observation, call);
  await participant.requestRetirement(retirement, call);
  await participant.recoverOriginal(locator, call);
  await participant.readReplacementDisposition(locator, call);
  const selected = await plans.read(create, call);
  if (selected) {
    const deployment = renderAdmittedGatewayLaunch(create, selected.record).deployment;
    const containers: number = deployment.spec!.template.spec!.containers.length;
    void containers;
  }
}

export function distinctProtocols(
  participant: GatewayProcessParticipantV2,
  oldCall: GatewayProcessCallV1,
  oldCreate: GatewayProcessCreateInputV1,
  call: GatewayProcessCallV2,
  create: GatewayProcessCreateInputV2,
  oldTicket: GatewayProcessSubmissionV1,
  submission: GatewayProcessSubmissionOwnerV2,
): void {
  // @ts-expect-error original V1 calls cannot enroll V2 authority
  void participant.createOriginal(create, oldCall);
  // @ts-expect-error original Installation lookup cannot become an Agent subject
  void participant.createOriginal(oldCreate, call);
  // @ts-expect-error submission identity is specific to the original V2 owner
  submission.consumeSubmission(oldTicket, create, call);
  // @ts-expect-error matching authority values do not issue an enrolled call
  const fabricated: GatewayProcessCallV2 = { authorityCall: call.authorityCall };
  void fabricated;
}

export function invocationInput(
  owner: KubernetesAgentGatewayDependencies["invocations"],
  create: GatewayProcessCreateInputV2,
  call: GatewayProcessCallV2,
): void {
  owner.enrollInvocation("createOriginal", create, call, async () => undefined);
  // @ts-expect-error the method retains its exact complete argument type
  owner.enrollInvocation("observeExact", create, call, async () => undefined);
}
