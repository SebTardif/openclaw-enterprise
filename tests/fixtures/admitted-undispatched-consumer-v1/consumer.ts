import {
  journalCancellationBeforeDispatchMatchesV1,
  parseTurnJournalV1,
  parseTurnJournalResultV1,
  type AdmittedUndispatchedAttemptRecordV1,
  type AttemptRecordV1,
  type ExactCancellationOperationV1,
  type JournalCommonAttemptBindingV1,
  type JournalAttemptBindingV1,
  type TurnJournalStoreV1,
  type VerifiedCancellationV1,
  type VerifiedConsumptionV1,
} from "../../../packages/contracts/src/turn-journal-v1.ts";
import type { AuthorityCallV1 } from "../../../packages/contracts/src/runtime-authority-v1.ts";

/** Compile a record from exactly the four common admission facts. This value
 * projection does not commit admission or produce a dispatch grant. */
export function admittedValue(
  input: JournalCommonAttemptBindingV1,
): AdmittedUndispatchedAttemptRecordV1 {
  const binding = parseTurnJournalV1("commonAttemptBinding", input);
  const value = parseTurnJournalV1("attempt", {
    phase: "admitted-undispatched",
    binding,
    version: 1,
    consumption: null,
    outcome: { kind: "accepted-undispatched" },
  });
  if (!("phase" in value)) throw new Error("Expected admitted record.");
  return value;
}
function common(record: AttemptRecordV1): JournalCommonAttemptBindingV1 {
  return parseTurnJournalV1("commonAttemptBinding", {
    attempt: record.binding.attempt,
    identity: record.binding.identity,
    reservation: record.binding.reservation,
    expectedHead: record.binding.expectedHead,
  });
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(o[key])}`)
    .join(",")}}`;
}
export type OwnedAttemptStatus =
  | Readonly<{
      kind: "found";
      record: AttemptRecordV1;
      binding: JournalCommonAttemptBindingV1;
      release: "unverified";
      initiation: "none";
    }>
  | Readonly<{ kind: "ownership-unresolved"; initiation: "none"; release: "unverified" }>;

/** Found common ownership remains visible. Absent/unavailable cannot discharge
 * previously known ownership or permit replay of execution. */
export function projectAttemptStatus(untrusted: unknown): OwnedAttemptStatus {
  const state = parseTurnJournalResultV1("attemptState", untrusted);
  return state.kind === "found"
    ? {
        kind: "found",
        record: state.record,
        binding: common(state.record),
        release: "unverified",
        initiation: "none",
      }
    : { kind: "ownership-unresolved", initiation: "none", release: "unverified" };
}

/** Independent adapter example. Genuine store and cancellation input come from
 * the installed owner. Results are reported only after the outer transaction;
 * unknown COMMIT performs exact fresh reads. Cancellation never releases. */
export async function cancelBeforeDispatchAndRead(
  store: TurnJournalStoreV1,
  originalTransactionRef: string,
  original: AttemptRecordV1,
  exactOperation: ExactCancellationOperationV1,
  verifiedInput: VerifiedCancellationV1,
  mutationCall: AuthorityCallV1,
  obtainFreshReadCall: () => Promise<AuthorityCallV1>,
) {
  const prior = parseTurnJournalV1("attempt", original);
  const operation = parseTurnJournalV1("cancellation", exactOperation);
  const unresolved = {
    kind: "unresolved",
    binding: common(prior),
    initiation: "none",
    release: "unverified",
    termination: "unverified",
  } as const;
  if (!journalCancellationBeforeDispatchMatchesV1(prior, operation)) return unresolved;
  const committed = await store.transact(
    originalTransactionRef,
    (unit) => unit.commitCancellation(verifiedInput, mutationCall),
    mutationCall,
  );
  if (committed.kind === "unavailable") return unresolved;
  if (committed.kind === "commit-unknown" && committed.transactionRef !== originalTransactionRef)
    return unresolved;
  if (committed.kind === "committed") {
    const result = parseTurnJournalResultV1("cancellation", committed.value);
    if (
      (result.kind !== "recorded" && result.kind !== "existing") ||
      result.outcome !== "cancelled-before-dispatch" ||
      canonical(result.operation) !== canonical(operation)
    )
      return unresolved;
  }
  const freshReadCall = await obtainFreshReadCall();
  return store.read(async (view) => {
    const cancellation = parseTurnJournalResultV1(
      "cancellationState",
      await view.findCancellation(operation, freshReadCall),
    );
    if (
      cancellation.kind !== "found" ||
      cancellation.outcome !== "cancelled-before-dispatch" ||
      canonical(cancellation.operation) !== canonical(operation)
    )
      return unresolved;
    const status = projectAttemptStatus(await view.findAttempt(operation.attempt, freshReadCall));
    if (
      status.kind !== "found" ||
      status.record.version !== prior.version + 1 ||
      status.record.consumption !== null ||
      status.record.outcome.kind !== "cancelled" ||
      status.record.outcome.stage !== "before-dispatch"
    )
      return unresolved;
    const binding = common(status.record);
    if (canonical(binding) !== canonical(common(prior))) return unresolved;
    return {
      kind: "cancelled-before-dispatch",
      binding,
      version: status.record.version,
      initiation: "none",
      release: "unverified",
      termination: "unverified",
    } as const;
  }, freshReadCall);
}

// Compile-only negative checks; no dispatcher/provenance can be fabricated.
function typeBoundaries(record: AdmittedUndispatchedAttemptRecordV1) {
  // @ts-expect-error Common facts are not complete dispatch evidence.
  const dispatch: JournalAttemptBindingV1 = record.binding;
  // @ts-expect-error A record is not a genuine consumption handle.
  const consumed: VerifiedConsumptionV1 = record;
  // @ts-expect-error No dispatch authority exists on the admitted branch.
  record.binding.authorityDecisionRef;
  const invalid: AdmittedUndispatchedAttemptRecordV1 = {
    ...record,
    // @ts-expect-error Common consumption is exactly null.
    consumption: { operation: {} },
  };
  const running: AdmittedUndispatchedAttemptRecordV1 = {
    ...record,
    // @ts-expect-error Before-dispatch cannot contain running state.
    outcome: { kind: "running", nativeSessionRef: "s", nativeTurnRef: "t" },
  };
  void dispatch;
  void consumed;
  void invalid;
  void running;
}
void typeBoundaries;
