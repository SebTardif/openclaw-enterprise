import {
  decodeAudienceDiagnosticV1,
  decodeAudienceObservationRequestV1,
  audienceObservationMatchesRequestV1,
  type AudienceDiagnosticV1,
  type AudienceInvocationHandleV1,
  type AudienceObservationPortV1,
  type AudienceObservationRequestV1,
  type AudienceObservationResultV1,
} from "@openclaw-enterprise/contracts/audience-observation-v1";

/** Synthetic representation example only. It cannot implement a native producer. */
export const syntheticSlackDiagnostic = {
  kind: "observed",
  observation: {
    schemaVersion: 1,
    observationRef: "synthetic-observation-1",
    request: {
      schemaVersion: 1,
      requestId: "req_12345678-1234-4234-8234-123456789abc",
      scope: {
        profile: "slack-private-mentioned-v1",
        installationId: "ins_12345678-1234-4234-8234-123456789abc",
        channelInstallationRef: "synthetic-installation",
        providerTenantRef: "synthetic-workspace",
        recipientAppRef: "synthetic-app",
        channelRef: "synthetic-channel",
        rootThreadRef: "synthetic-thread",
      },
      target: {
        namespaceId: "ns_12345678-1234-4234-8234-123456789abc",
        agentId: "agt_12345678-1234-4234-8234-123456789abc",
        conversationRef: "synthetic-conversation",
        commonGrantRef: "synthetic-common-grant",
        targetVersion: 1,
        approvedBoundaryDigest: "a".repeat(64),
        sourceMessageRef: "synthetic-message",
        immutableMessageDigest: "b".repeat(64),
      },
      stage: { kind: "ingress-admission" },
      startedAt: "2026-01-01T00:00:00.000Z",
      deadline: "2026-01-01T00:00:05.000Z",
    },
    observedAt: "2026-01-01T00:00:00.100Z",
    validUntil: "2026-01-01T00:00:04.900Z",
    clockUncertaintyMs: 20,
    totalHumanReaders: 2,
    readers: [
      {
        readerRef: "synthetic-reader-a",
        providerSubjectRef: "synthetic-user-a",
        kind: "human",
        accessPaths: ["channel"],
      },
      {
        readerRef: "synthetic-reader-b",
        providerSubjectRef: "synthetic-user-b",
        kind: "human",
        accessPaths: ["channel"],
      },
    ],
    completeness: {
      profile: "slack-private-mentioned-v1",
      mechanismProfileRef: "synthetic-mechanism",
      sourceCapabilityRef: "synthetic-capability",
      scopeClassificationVersion: "synthetic-classification-1",
      readerSetVersion: "synthetic-reader-set-1",
      changeDetectionVersion: "synthetic-change-detection-1",
      configuredDeliveryBotRef: "synthetic-delivery-bot",
      channelMembers: { snapshotVersion: "synthetic-snapshot-1", allPagesRead: true },
      userClassificationVersion: "synthetic-users-1",
      channelAccessPolicyVersion: "synthetic-access-1",
    },
  },
} satisfies AudienceDiagnosticV1;

/**
 * Real implementation example: caller supplies the native owner's actual port and
 * invocation handle. This example does not construct either one. The owner must
 * implement complete retrieval/change checks and join its own losing provider work.
 */
export async function collectNativeObservation(
  port: AudienceObservationPortV1 | undefined,
  invocation: AudienceInvocationHandleV1,
  input: AudienceObservationRequestV1,
  signal: AbortSignal,
): Promise<AudienceObservationResultV1> {
  if (signal.aborted) return { kind: "unavailable", reason: "cancelled" };
  if (!port) return { kind: "unavailable", reason: "missing-native-producer" };
  const parsed = decodeAudienceObservationRequestV1(input);
  if (parsed.kind === "invalid") return { kind: "denied" };
  const result = await port.observeV1(invocation, parsed.value, signal);
  if (result.kind !== "observed") return result;
  // Validate only diagnostic data. The custody object is retained separately.
  const diagnostic = decodeAudienceDiagnosticV1({
    kind: result.kind,
    observation: result.observation,
  });
  if (
    signal.aborted ||
    diagnostic.kind === "invalid" ||
    !audienceObservationMatchesRequestV1(result.observation, parsed.value)
  ) {
    await port.releaseV1(invocation, result.custody);
    return signal.aborted ? { kind: "unavailable", reason: "cancelled" } : { kind: "denied" };
  }
  return result;
}

// A serialized success cannot be assigned the process-local custody required by a port.
// @ts-expect-error Diagnostic objects cannot mint native observation handles.
const noNativeAuthority: AudienceObservationResultV1 = syntheticSlackDiagnostic;
void noNativeAuthority;
