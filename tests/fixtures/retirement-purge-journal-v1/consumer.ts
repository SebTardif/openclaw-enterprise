import type { AuthorityCallV1 } from "../../../packages/contracts/src/runtime-authority-v1.ts";
import type {
  VerifiedPurgeRetirementInputV1,
  VerifiedPurgeObservationInputV1,
} from "../../../packages/contracts/src/retirement-purge-journal-v1.ts";
import {
  parsePurgeCallableV1,
  purgeHistoryMatchesV1,
  reconcileUnknownPurgeV1,
  type PurgeHistoryQueryV1,
  type PurgeRetirementRecordV1,
  type RetirementPurgeJournalV1,
} from "../../../packages/contracts/src/retirement-purge-journal-v1.ts";

/** Independently compiled consumer. The configured original owner supplies the
 * genuine handle; this consumer neither constructs it nor treats data as proof.
 * Current purge permission, stopped head, complete inventory and internal
 * transaction phase are receiving-owner obligations, not caller booleans. */
export async function publishAndReport(
  journal: RetirementPurgeJournalV1,
  expectedInput: PurgeHistoryQueryV1,
  originalInput: VerifiedPurgeRetirementInputV1,
  mutationCall: AuthorityCallV1,
  obtainFreshReadCall: () => Promise<AuthorityCallV1>,
) {
  const expected = parsePurgeCallableV1("query", expectedInput);
  if (expected.kind !== "retirement") return { kind: "unavailable" } as const;
  const result = parsePurgeCallableV1(
    "publicationCommit",
    await journal.publishRetirementManifest(
      expected.binding.originalTransactionRef,
      originalInput,
      mutationCall,
    ),
  );
  if (
    result.kind === "committed" &&
    result.value.kind === "published" &&
    !purgeHistoryMatchesV1(expected, {
      kind: "found",
      record: result.value.record,
      observationReceipt: null,
    })
  )
    return { kind: "conflict" } as const;
  if (result.kind !== "commit-unknown") return result;
  // Command completion guarantees original owner has unwound its unit. An
  // independent current read is requested; the mutation is never resubmitted.
  return reconcileUnknownPurgeV1(journal, expected, result, await obtainFreshReadCall());
}

export async function recordObservationAndReport(
  journal: RetirementPurgeJournalV1,
  expectedInput: PurgeHistoryQueryV1,
  originalInput: VerifiedPurgeObservationInputV1,
  mutationCall: AuthorityCallV1,
  obtainFreshReadCall: () => Promise<AuthorityCallV1>,
) {
  const expected = parsePurgeCallableV1("query", expectedInput);
  if (expected.kind !== "observation") return { kind: "unavailable" } as const;
  const result = parsePurgeCallableV1(
    "observationCommit",
    await journal.recordRetiredStoreObservation(
      expected.originalTransactionRef,
      originalInput,
      mutationCall,
    ),
  );
  if (
    result.kind === "committed" &&
    (result.value.kind === "recorded" || result.value.kind === "existing") &&
    !purgeHistoryMatchesV1(expected, {
      kind: "found",
      record: result.value.record,
      observationReceipt: result.value.receipt,
    })
  )
    return { kind: "conflict" } as const;
  if (result.kind !== "commit-unknown") return result;
  return reconcileUnknownPurgeV1(journal, expected, result, await obtainFreshReadCall());
}

// This function is never executed. Negative checks are real strict compilation.
function typeBoundaries(
  record: PurgeRetirementRecordV1,
  journal: RetirementPurgeJournalV1,
  call: AuthorityCallV1,
) {
  // @ts-expect-error A historical record is not a genuine owner-issued input.
  const fabricated: VerifiedPurgeRetirementInputV1 = record;
  // @ts-expect-error Read data has no deletion method or recovered action permit.
  record.delete();
  // @ts-expect-error An explicit pre-invocation transaction reference is required.
  journal.publishRetirementManifest(fabricated, call);
  // @ts-expect-error Removed unsupported independent epoch is not canonical.
  record.binding.retirementGeneration;
  // @ts-expect-error No caller-composable transaction/phase method is exported.
  journal.applyProtective();
  void fabricated;
}
void typeBoundaries;
