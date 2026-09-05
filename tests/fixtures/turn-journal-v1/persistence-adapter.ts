import type { CompletedStateAdapterV1 } from "@openclaw-enterprise/contracts";
import type {
  TurnJournalStoreV1,
  JournalEvidenceProvenanceV1,
  ExactCheckpointAllocationV1,
  ExactCompletionOperationV1,
  JournalCommitResultV1,
  CompletionPublicationResultV1,
} from "@openclaw-enterprise/contracts";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts";

/** Independently compiling persistence consumer. Gateway owns canonical bytes;
 * the same journal allocates before writes and publishes one expected-head CAS.
 */
export async function prepareAndPublish(
  journal: TurnJournalStoreV1,
  canonical: CompletedStateAdapterV1,
  provenance: JournalEvidenceProvenanceV1,
  allocation: ExactCheckpointAllocationV1,
  operation: ExactCompletionOperationV1,
  evidence: Readonly<{ nativeTerminalEvidenceRef: string; workspaceCompletionRef: string }>,
  call: AuthorityCallV1,
): Promise<JournalCommitResultV1<CompletionPublicationResultV1>> {
  const allocated = await journal.transact(
    allocation.operationRef,
    (unit) => unit.allocateCheckpoint(allocation, call),
    call,
  );
  if (allocated.kind !== "committed") return allocated;
  if (allocated.value.kind !== "allocated" && allocated.value.kind !== "existing")
    return { kind: "unavailable" };
  const prepared = await canonical.prepareCompleted({
    ...allocation.attempt,
    checkpointId: allocation.checkpointId,
    expectedCompletionSequence: allocation.expectedHead.completionSequence,
    ...evidence,
  });
  if (prepared.kind !== "verified") return { kind: "unavailable" };
  // Provenance owner re-resolves the complete exact canonical manifest and trusted
  // native/workspace evidence; prepared.kind alone cannot create its handle.
  const handle = await provenance.verifyCompletion(operation, call);
  if ("kind" in handle) return { kind: "unavailable" };
  return journal.transact(
    operation.operationRef,
    (unit) => unit.publishCompleted(handle, call),
    call,
  );
}
