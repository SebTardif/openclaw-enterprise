import type * as Gateway from "openclaw/plugin-sdk/gateway-host";
import type * as Inbound from "openclaw/plugin-sdk/channel-inbound";
import type * as Slack from "openclaw/plugin-sdk/slack-hosted";
import type * as Teams from "openclaw/plugin-sdk/msteams-hosted";
import type * as Harness from "openclaw/plugin-sdk/codex-hosted-harness";
import type * as Completed from "openclaw/plugin-sdk/completed-state";

// Compile-only correspondence to actual selected declarations. No SDK code loads.
export type SelectedDeclarations = Readonly<{
  gateway: Parameters<typeof Gateway.startGatewayHostV1>;
  inbound: Parameters<typeof Inbound.createHostedChannelAdmissionV1>;
  slack: Parameters<typeof Slack.createSlackHostedAdapterV1>;
  teams: Parameters<typeof Teams.createMSTeamsHostedIngress>;
  harness: ReturnType<typeof Harness.getHostedHarnessProfileV1>;
  completed: ReturnType<typeof Completed.verifyCompletedSnapshot>;
  producer: ReturnType<typeof Completed.completedProducerTupleSchema.parse>;
}>;

export const supportedPurposes: readonly Harness.HostedHarnessPurpose[] = [
  "candidate-probe",
  "serving",
];
export const actualRestoreCapability: SelectedDeclarations["harness"]["completedContextRestore"] =
  "unavailable";

// These negatives assert the actual current public boundary; no invented receiver.
// @ts-expect-error Existing start/resume purposes do not include quiet restoration.
export const unsupportedRestorePurpose: Harness.HostedHarnessPurpose = "completed-context-restore";
// @ts-expect-error Current public profile explicitly leaves completed restoration unavailable.
export const unsupportedRestoreCapability: SelectedDeclarations["harness"]["completedContextRestore"] =
  "supported";

export function retainDeclarations(value: SelectedDeclarations): SelectedDeclarations {
  return value;
}
