import {
  type RuntimeIdentityLimitsV1,
  type RuntimeWorkloadDiagnosticV1,
  type RuntimeWorkloadExpectationV1,
  type RuntimeWorkloadVerifierV1,
  type TrustedRuntimeRegistrationReaderV1,
  type VerifiedWorkloadV1,
  type RuntimeWorkloadTransportBindingV1,
} from "@openclaw-enterprise/contracts/runtime-identity-v1";
import type {
  RuntimeAuthorityCallBoundsV1,
  RuntimeAuthorityTrustedContextV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";

// Synthetic serialization examples. These values are not admitted profiles,
// authenticated peers, registration records or current purpose observations.
export const fixtureWorkloadDiagnostic = {
  schemaVersion: 1,
  spiffeId:
    "spiffe://example.org/installation/example/runtime/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/harness",
  component: "harness",
  assignmentRef: { schemaVersion: 1, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  bindingVersion: 1,
  identityProfileRef: "identity/example-v1",
  registrationId: "registration/example",
  registrationVersion: 1,
  bundleSetVersion: 1,
  verifiedAt: "2026-09-06T00:00:00.000Z",
  expiresAt: "2026-09-06T00:01:00.000Z",
  peerEvidenceRef: "evidence/example",
  recipientRef: "recipient/example",
  connectionRef: "connection/example",
} satisfies RuntimeWorkloadDiagnosticV1;

export const fixtureIdentityLimits = {
  schemaVersion: 1,
  limitsProfileRef: "limits/example-unqualified",
  svidLifetimeMs: 60_000,
  renewBeforeExpiryMs: 10_000,
  renewalRetryBudgetMs: 2_000,
  runtimeEvidenceMaxAgeMs: 1_000,
  policyEvidenceMaxAgeMs: 1_000,
  identityEvidenceMaxAgeMs: 1_000,
  identityHealthMaxAgeMs: 2_000,
  identityHealthPollMs: 1_000,
  assignmentDeadlineMs: 1_000,
  policyDeadlineMs: 1_000,
  clockSkewAllowanceMs: 100,
  connectionMaxAgeMs: 10_000,
  streamRecheckMs: 1_000,
  streamCloseDeadlineMs: 1_000,
  bundleUpdateMaxAgeMs: 2_000,
  bundleOverlapMs: 1_000,
  bundleRollbackPolicyRef: "bundle-rollback/example",
  disableBudgetMs: 5_000,
  invalidationProtocolRef: "invalidation/example",
  effectFenceProfileRef: "fence/example",
  requestBoundsRef: "request/example",
  connectionBoundsRef: "connection/example",
  registrationChurnBoundsRef: "registration-rate/example",
  maxFrameBytes: 1_024,
  maxBufferedBytes: 4_096,
  maxBufferedMessages: 4,
  maxConnections: 2,
  maxStreamsPerConnection: 2,
  maxPendingChecks: 2,
} satisfies RuntimeIdentityLimitsV1;

/** Compile-only producer composition. Actual dependencies must be installed by their owners.
 * The preliminary registration observation supplies no proof; verify must freshly perform
 * its entire connection/registration/assignment check, including changes during this await.
 */
export async function verifierProducerExample<OwnedConnection>(
  registration: TrustedRuntimeRegistrationReaderV1<OwnedConnection>,
  verifier: RuntimeWorkloadVerifierV1<OwnedConnection>,
  connection: OwnedConnection,
  expected: RuntimeWorkloadExpectationV1,
  call: RuntimeAuthorityCallBoundsV1,
) {
  const observation = await registration.resolve(connection, expected, call);
  if (observation.kind !== "observed") return observation;
  return verifier.verify(connection, expected, call);
}

// This uncalled function is checked by the strict compiler. Brands are accidental-use
// protection; an actual provider must additionally maintain private ownership at runtime.
export function rejectDiagnosticConstruction(
  diagnostic: RuntimeWorkloadDiagnosticV1,
  serviceContext: RuntimeAuthorityTrustedContextV1,
) {
  // @ts-expect-error A decoded diagnostic has no verifier/transport custody.
  const proof: VerifiedWorkloadV1 = diagnostic;
  // @ts-expect-error An independent service context is not an assigned workload.
  const serviceAsWorkload: VerifiedWorkloadV1 = serviceContext;
  // @ts-expect-error A correlation label is not an owned transport binding.
  const transport: RuntimeWorkloadTransportBindingV1 = diagnostic.connectionRef;
  return [proof, serviceAsWorkload, transport];
}
