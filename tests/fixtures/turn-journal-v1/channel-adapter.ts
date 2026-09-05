import type {
  HostedChannelAdmissionDecisionV1,
  HostedChannelAdmissionDependenciesV1,
} from "@openclaw-enterprise/contracts";
import type {
  AdmissionRecordV1,
  JournalAdmissionProvenanceV1,
  TurnJournalStoreV1,
} from "@openclaw-enterprise/contracts";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts";

/** Independently compiling channel consumer. The configured actual verifier and
 * repository are required dependencies; this example creates no journal or permit.
 */
export function channelJournalAdapter<Native>(
  store: TurnJournalStoreV1,
  provenance: JournalAdmissionProvenanceV1<Native>,
  call: AuthorityCallV1,
): Readonly<{
  verify: HostedChannelAdmissionDependenciesV1<Native>["verify"];
  admitNative(native: Native): Promise<HostedChannelAdmissionDecisionV1>;
}> {
  return {
    verify: provenance.verify,
    async admitNative(native) {
      const handle = await provenance.authenticate(native, call);
      if ("kind" in handle) {
        if (handle.kind === "unavailable")
          return { kind: "not-responsible", reason: "unavailable" };
        const rejected = await provenance.authenticateRejected(native, call);
        if ("kind" in rejected) return { kind: "not-responsible", reason: "unavailable" };
        const saved = await store.transact(
          call.requestRef,
          (unit) => unit.admitRejected(rejected, call),
          call,
        );
        if (saved.kind === "commit-unknown") return { kind: "commit-unknown" };
        if (saved.kind !== "committed" || saved.value.kind === "unavailable")
          return { kind: "not-responsible", reason: "unavailable" };
        if (saved.value.kind === "non-turn-owned")
          return { kind: "not-responsible", reason: "unavailable" };
        if (saved.value.kind === "resolved-existing")
          return {
            kind: "committed",
            receipt: saved.value.record.identity.receipt,
            decision: {
              kind: "duplicate",
              receiptRef: saved.value.record.identity.receipt.receiptRef,
            },
          };
        if (saved.value.kind === "conflict")
          return {
            kind: "committed",
            receipt: saved.value.originalReceipt,
            decision: { kind: "denied", reason: "conflict" },
          };
        return {
          kind: "committed",
          receipt: saved.value.record.receipt,
          decision: saved.value.record.decision,
        };
      }
      const committed = await store.transact(
        call.requestRef,
        (unit) => unit.admit(handle, call),
        call,
      );
      if (committed.kind === "commit-unknown") return { kind: "commit-unknown" };
      if (committed.kind === "unavailable")
        return { kind: "not-responsible", reason: "unavailable" };
      const result = committed.value;
      // Non-turn ownership uses the host's separate native invocation-correlated
      // responsibility port; the human-only SDK receipt cannot represent it.
      if (result.kind === "non-turn-owned")
        return { kind: "not-responsible", reason: "unavailable" };
      if (result.kind === "rejected-existing")
        return {
          kind: "committed",
          receipt: result.record.receipt,
          decision: { kind: "duplicate", receiptRef: result.record.receipt.receiptRef },
        };
      if (result.kind === "conflict")
        return {
          kind: "committed",
          receipt: result.originalReceipt,
          decision: { kind: "denied", reason: "conflict" },
        };
      if (result.kind !== "recorded") return { kind: "not-responsible", reason: "unavailable" };
      if (result.duplicate)
        return {
          kind: "committed",
          receipt: result.record.identity.receipt,
          decision: { kind: "duplicate", receiptRef: result.record.identity.receipt.receiptRef },
        };
      return projectCommittedAdmission(result.record);
    },
  };
}
function projectCommittedAdmission(record: AdmissionRecordV1): HostedChannelAdmissionDecisionV1 {
  const identity = record.identity;
  if (record.decision.kind !== "accepted")
    return { kind: "committed", receipt: identity.receipt, decision: record.decision };
  const attempt = record.decision.attempt;
  return {
    kind: "committed",
    receipt: identity.receipt,
    decision: {
      kind: "accepted",
      attempt: {
        schemaVersion: 1,
        receiptRef: identity.receipt.receiptRef,
        turnRef: attempt.turnRef,
        attemptRef: attempt.attemptRef,
        principalRef: identity.principalRef,
        namespaceRef: attempt.namespaceRef,
        agentRef: attempt.agentRef,
        conversationRef: attempt.conversationRef,
        admittedRevisionRef: identity.admittedRevisionRef,
        assignmentRef: identity.harnessAssignment.id,
        runtimeGeneration: identity.harnessRuntimeGeneration,
        replyBindingRef: identity.replyDestinationRef,
        replyBindingVersion: identity.replyBindingVersion,
        bindingVersion: identity.conversationBindingVersion,
        policyVersion: identity.routingPolicyVersion,
        expectedCompletionSequence: record.expectedHead.completionSequence,
      },
    },
  };
}
