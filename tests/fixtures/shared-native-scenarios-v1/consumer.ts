/** Compile-only consumer of current public declarations. Imports erase completely. */
import type {
  HostedChannelAttemptV1,
  HostedChannelEnvelopeV1,
  HostedChannelNativeEventV1,
  HostedChannelOutputV1,
  hostedAttemptSchemaV1,
  hostedEnvelopeSchemaV1,
  hostedOutputSchemaV1,
} from "openclaw/plugin-sdk/channel-inbound";
import type { SlackHostedInputV1 } from "openclaw/plugin-sdk/slack-hosted";
import type { MSTeamsHostedInputV1 } from "openclaw/plugin-sdk/msteams-hosted";
import type {
  HostedHarnessObservation,
  HostedHarnessPurpose,
  HostedHarnessWireTypes,
} from "openclaw/plugin-sdk/codex-hosted-harness";
import type { Binding } from "./checker.ts";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type PublicContractAssertions = [
  Assert<Equal<HostedHarnessPurpose, "candidate-probe" | "serving">>,
  Assert<Equal<HostedHarnessObservation["checkpoint"], "unverified">>,
  Assert<Equal<SlackHostedInputV1["source"], "message" | "app_mention">>,
  Assert<Equal<MSTeamsHostedInputV1["configuredAppId"], string>>,
  Assert<
    ReturnType<typeof hostedAttemptSchemaV1.parse> extends HostedChannelAttemptV1 ? true : false
  >,
  Assert<
    ReturnType<typeof hostedEnvelopeSchemaV1.parse> extends HostedChannelEnvelopeV1 ? true : false
  >,
  Assert<
    ReturnType<typeof hostedOutputSchemaV1.parse> extends HostedChannelOutputV1 ? true : false
  >,
];
export type RetainedOriginalWireTypes = HostedHarnessWireTypes;

/** Already-decoded public values stay observations. No decoder, API or callback runs. */
export function observePublicTurn(
  envelope: HostedChannelEnvelopeV1,
  attempt: HostedChannelAttemptV1,
  nativeEvent: HostedChannelNativeEventV1,
  output: HostedChannelOutputV1,
  harness: HostedHarnessObservation,
) {
  const binding: Binding = {
    receiptRef: attempt.receiptRef,
    turnRef: attempt.turnRef,
    attemptRef: attempt.attemptRef,
    principalRef: attempt.principalRef,
    namespaceRef: attempt.namespaceRef,
    agentRef: attempt.agentRef,
    conversationRef: attempt.conversationRef,
    admittedRevisionRef: attempt.admittedRevisionRef,
    assignmentRef: attempt.assignmentRef,
    runtimeGeneration: attempt.runtimeGeneration,
    replyBindingRef: attempt.replyBindingRef,
    replyBindingVersion: attempt.replyBindingVersion,
    bindingVersion: attempt.bindingVersion,
    policyVersion: attempt.policyVersion,
    expectedCompletionSequence: attempt.expectedCompletionSequence,
  };
  return {
    evidenceKind: "public-data-observation" as const,
    evidenceAuthenticated: false as const,
    runtimeQualified: false as const,
    binding,
    envelope: {
      platform: envelope.platform,
      adapterProfileRef: envelope.adapterProfileRef,
      installationRef: envelope.installationRef,
      channelInstallationRef: envelope.channelInstallationRef,
      providerTenantRef: envelope.providerTenantRef,
      recipientAppRef: envelope.recipientAppRef,
      providerSubjectRef: envelope.sender.providerSubjectRef,
      providerEventRef: envelope.event.providerEventRef,
      eventKind: envelope.event.eventKind,
      eventDigest: envelope.event.eventDigest,
      contentDigest: envelope.message.contentDigest,
      logicalMessageKey: envelope.message.logicalMessageKey,
      channelRef: envelope.nativeConversation.channelRef,
      rootThreadRef: envelope.nativeConversation.rootThreadRef,
      occurredAt: envelope.event.occurredAt,
      receivedAt: envelope.receivedAt,
      verifiedAt: envelope.verifiedAt,
    },
    nativeEvent: {
      nativeSessionRef: nativeEvent.nativeSessionRef,
      nativeTurnRef: nativeEvent.nativeTurnRef,
      sequence: nativeEvent.sequence,
      event: nativeEvent.event,
    },
    output: {
      receiptRef: output.receiptRef,
      turnRef: output.turnRef,
      conversationRef: output.conversationRef,
      replyDestinationRef: output.replyDestinationRef,
      replyBindingVersion: output.replyBindingVersion,
      deliveryAttemptRef: output.deliveryAttemptRef,
      slot: output.slot,
      operation: output.operation,
    },
    harness: {
      requestRef: harness.requestRef,
      conversationRef: harness.conversationRef,
      attemptRef: harness.attemptRef,
      assignmentRef: harness.assignmentRef,
      runtimeGeneration: harness.runtimeGeneration,
      state: harness.state,
      cancellation: harness.cancellation,
      checkpoint: harness.checkpoint,
    },
    occCheckpoint: null,
    physicalWriterTermination: "unmeasured" as const,
  };
}

// These compile-time negatives protect the accepted public data boundary.
// @ts-expect-error Completed-context restore is not a public Harness purpose.
const unsupportedPurpose: HostedHarnessPurpose = "completed-context-restore";
// @ts-expect-error Native completion does not supply a verified OCC checkpoint.
const unsupportedCheckpoint: HostedHarnessObservation["checkpoint"] = "verified";
void unsupportedPurpose;
void unsupportedCheckpoint;
