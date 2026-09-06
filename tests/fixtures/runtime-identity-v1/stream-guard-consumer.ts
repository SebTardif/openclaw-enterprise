import {
  decodeRuntimeIdentityV1,
  type RuntimeIdentityPurposeGuardV1,
  type RuntimeIdentityStreamV1,
  type RuntimeWorkloadDiagnosticV1,
  type VerifiedWorkloadV1,
} from "@openclaw-enterprise/contracts/runtime-identity-v1";
import {
  RUNTIME_AUTHORITY_PURPOSES_V1,
  parseRuntimeAuthorityV1,
  type AuthorityCallV1,
  type ResolveAssignmentRequestV1,
  type ResolveAssignmentResultV1,
  type RuntimeAssignmentAuthorityV1,
  type RuntimeAuthorityPurposeV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";

// Independently authored consumer expectations; changing the canonical purpose/result
// union requires this consumer to be revised explicitly. These labels are not permissions.
export const consumerPurposeDisposition = {
  "identity-registration": "independent registrar; no target SVID bootstrap requirement",
  "readiness-probe": "exact candidate pairing and admitted probe only",
  "runtime-peer": "serving peer observation; operation authorization remains separate",
  "model-call": "exact harness plus separate original turn/model authorization",
  "repository-issuance": "exact caller plus separate common resource authorization",
  cleanup: "independent preaccepted responsibility; no target SVID or original actor liveness",
  "completed-context-restore": "exact existing purpose/suboperation; no historical grant replay",
} satisfies Record<RuntimeAuthorityPurposeV1, string>;

export const consumerResultDisposition = {
  current: "observation requiring separate operation authorization and effect guard",
  "candidate-eligible": "only the exact existing preparation purpose",
  "cleanup-eligible": "only the exact preaccepted predecessor effect",
  pending: "no effect while required evidence is incomplete",
  "not-current": "deny the requested operation",
  "not-visible": "conceal unknown or foreign scoped state",
  unavailable: "no cached result or executable retry",
} satisfies Record<ResolveAssignmentResultV1["result"], string>;

/** No dispatcher/delivery callback is invoked. The consumer receives an observation that
 * still needs its actual current human/turn/resource authorization and effect fence.
 */
export async function inspectRuntimeOperation(
  guard: RuntimeIdentityPurposeGuardV1,
  proof: VerifiedWorkloadV1,
  request: ResolveAssignmentRequestV1,
  call: AuthorityCallV1,
) {
  return guard.check(proof, request, call);
}

/** A registrar or cleanup service uses its own actual existing context. A target workload
 * proof is deliberately absent from this independent-service call signature.
 */
export async function inspectIndependentResponsibility(
  authority: RuntimeAssignmentAuthorityV1,
  request: Extract<ResolveAssignmentRequestV1, { purpose: "identity-registration" | "cleanup" }>,
  call: AuthorityCallV1,
) {
  return authority.resolve(request, call);
}

/** Bounded close behavior belongs to the provider. This consumer preserves terminal abort
 * before awaiting cleanup, and returns unjoined cleanup rather than reporting stop.
 */
export async function abandonStream(stream: RuntimeIdentityStreamV1) {
  stream.invalidate("watch-lost");
  return stream.close();
}

export const fixturePurposeRequests = RUNTIME_AUTHORITY_PURPOSES_V1.map((purpose) => {
  const base = {
    schemaVersion: 1,
    installationId: "ins_11111111-1111-4111-8111-111111111111",
    namespaceId: "ns_22222222-2222-4222-8222-222222222222",
    agentId: "agt_33333333-3333-4333-8333-333333333333",
    assignmentRef: { schemaVersion: 1, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    requestRef: "request/example",
    purpose,
  };
  if (purpose === "runtime-peer" || purpose === "model-call" || purpose === "repository-issuance")
    return base;
  const operation = {
    ...base,
    operationRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    expectedResponsibilityVersion: 1,
  };
  if (purpose === "cleanup") return { ...operation, requestedOperation: "retire-registration" };
  if (purpose === "completed-context-restore")
    return {
      ...operation,
      purposeContract: "completed-context-restore-v1",
      requestedSuboperation: "readImportedContext",
    };
  return operation;
});

export function validatePurposeExample(value: unknown): ResolveAssignmentRequestV1 {
  return parseRuntimeAuthorityV1("resolveRequest", value);
}

export function rejectConsumerShortcuts(
  guard: RuntimeIdentityPurposeGuardV1,
  diagnostic: RuntimeWorkloadDiagnosticV1,
  request: ResolveAssignmentRequestV1,
  call: AuthorityCallV1,
) {
  // @ts-expect-error Parsing diagnostics cannot authenticate this consumer's connection.
  void guard.check(diagnostic, request, call);
  // @ts-expect-error An ordinary object cannot construct a stream handle.
  const stream: RuntimeIdentityStreamV1 = { signal: call.signal };
  // @ts-expect-error This decoder has no schema for authority proof.
  decodeRuntimeIdentityV1("verifiedWorkload", diagnostic);
  // @ts-expect-error Signal and real current service context are required call custody.
  const missingCustody: AuthorityCallV1 = { requestRef: "r", recipientRef: "s", deadline: "d" };
  // @ts-expect-error The existing current result cannot represent a readiness-only purpose.
  const readinessAsServing: Extract<ResolveAssignmentResultV1, { result: "current" }>["purpose"] =
    "readiness-probe";
  return [stream, missingCustody, readinessAsServing];
}

// TODO(native transport declaration input): add the exact authorized
// openclaw/plugin-sdk/codex-hosted-harness type composition after its original producer
// supplies the immutable declaration. This example does not invent native method/event shapes.
