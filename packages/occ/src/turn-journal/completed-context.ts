import { isDeepStrictEqual } from "node:util";
import {
  parseCompletedContextV1,
  parseTurnJournalResultV1,
  parseTurnJournalV1,
  requireMatchingCompletedCheckpointV1,
  type AuthorityCallV1,
  type CheckpointAllocationResultV1,
  type CheckpointAllocationStateV1,
  type CheckpointRefV1,
  type CompletedStateAdapterV1,
  type CompletionPublicationResultV1,
  type CompletionStateV1,
  type ContextUnavailableV1,
  type ExactCheckpointAllocationV1,
  type ExactCompletionOperationV1,
  type JournalCommitResultV1,
  type JournalEvidenceProvenanceV1,
  type PrepareCompletedInputV1,
  type TurnJournalStoreV1,
  type VerifiedCheckpointV1,
} from "@openclaw-enterprise/contracts";

export interface CompletedContextJournalOptions {
  readonly store: TurnJournalStoreV1;
  /** The selected gateway adapter owns canonical bytes and its authenticated
   * receiver. This service cannot supply an alternative writer or verifier. */
  readonly adapter: Pick<CompletedStateAdapterV1, "prepareCompleted" | "verify">;
  readonly evidence: JournalEvidenceProvenanceV1;
  readonly now?: () => Date;
}

export interface ExactCheckpointPublication {
  readonly allocation: ExactCheckpointAllocationV1;
  readonly operation: ExactCompletionOperationV1;
  readonly publicationTransactionRef: string;
}
export interface PrepareCheckpointPublication extends ExactCheckpointPublication {
  readonly allocationTransactionRef: string;
  readonly preparation: PrepareCompletedInputV1;
}
export interface ReconcileCheckpointPublication extends ExactCheckpointPublication {
  /** The complete original immutable manifest, never a replacement checkpoint ID. */
  readonly checkpoint: CheckpointRefV1;
}

type ExactPublicationIdentity = Readonly<{
  allocation: ExactCheckpointAllocationV1;
  operation: ExactCompletionOperationV1;
}>;
export type CompletedContextPublicationResult =
  | CompletionPublicationResultV1
  | ContextUnavailableV1
  | (ExactPublicationIdentity &
      Readonly<{
        kind: "commit-unknown";
        stage: "allocation" | "publication";
        transactionRef: string;
        nextAction: "exact-readback-only";
      }>)
  | (ExactPublicationIdentity &
      Readonly<{
        kind: "allocated-existing" | "checkpoint-unresolved";
        nextAction: "verify-existing-checkpoint-only";
      }>);

function sameData(left: unknown, right: unknown): boolean {
  // Contract decoders use null-prototype records; that representation does not
  // change the immutable wire identity when compared with provider-owned data.
  return isDeepStrictEqual(structuredClone(left), structuredClone(right));
}

function transactionRef(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:/-]{1,200}$/.test(value))
    throw new Error("Invalid checkpoint transaction reference.");
  return value;
}

function publicationIdentity(input: ExactCheckpointPublication): ExactCheckpointPublication {
  const allocation = parseTurnJournalV1("checkpointAllocation", input.allocation);
  const operation = parseTurnJournalV1("completionOperation", input.operation);
  if (
    !sameData(allocation.attempt, operation.attempt) ||
    allocation.checkpointId !== operation.checkpointId ||
    allocation.expectedHead.completionSequence !== operation.expectedCompletionSequence ||
    allocation.expectedHead.headVersion === Number.MAX_SAFE_INTEGER ||
    operation.expectedCompletionSequence === Number.MAX_SAFE_INTEGER ||
    operation.expectedAttemptVersion === Number.MAX_SAFE_INTEGER
  )
    throw new Error("Conflicting checkpoint publication identity.");
  return Object.freeze({
    allocation,
    operation,
    publicationTransactionRef: transactionRef(input.publicationTransactionRef),
  });
}

function requireCheckpoint(identity: ExactPublicationIdentity, checkpoint: CheckpointRefV1): void {
  const attempt = parseCompletedContextV1("exactAttempt", {
    installationRef: checkpoint.installationRef,
    namespaceRef: checkpoint.namespaceRef,
    agentRef: checkpoint.agentRef,
    conversationRef: checkpoint.conversationRef,
    turnRef: checkpoint.turnRef,
    attemptRef: checkpoint.attemptRef,
    reservationRef: checkpoint.reservationRef,
  });
  if (
    !sameData(attempt, identity.allocation.attempt) ||
    checkpoint.checkpointId !== identity.allocation.checkpointId ||
    checkpoint.completionSequence !== identity.operation.expectedCompletionSequence + 1 ||
    checkpoint.parentCheckpointId !== identity.allocation.expectedHead.checkpointId
  )
    throw new Error("Checkpoint does not match its allocation.");
}

/** Orchestrates the accepted allocation -> gateway preparation -> publication
 * ports. Value decoding only checks correlation. The selected adapter verifies
 * actual bytes; evidence verifies native/workspace/no-mutator provenance; the
 * accepting journal re-inspects current evidence and performs the publication CAS.
 * No provider is selected by default, and no native execution or restore occurs. */
export class CompletedContextJournalService {
  readonly #options: CompletedContextJournalOptions;

  constructor(options: CompletedContextJournalOptions) {
    this.#options = Object.freeze({ ...options });
  }

  #now(): number {
    return (this.#options.now?.() ?? new Date()).getTime();
  }

  #call(input: AuthorityCallV1): AuthorityCallV1 {
    if (
      !input ||
      !input.context ||
      !(input.signal instanceof AbortSignal) ||
      typeof input.requestRef !== "string" ||
      typeof input.recipientRef !== "string" ||
      typeof input.deadline !== "string" ||
      !Number.isFinite(Date.parse(input.deadline)) ||
      new Date(input.deadline).toISOString() !== input.deadline
    )
      throw new Error("A current authority call is required.");
    const call = Object.freeze({ ...input });
    this.#requireLive(call);
    return call;
  }

  #requireLive(call: AuthorityCallV1): void {
    const now = this.#now();
    if (!Number.isFinite(now) || call.signal.aborted || now >= Date.parse(call.deadline))
      throw new Error("Checkpoint authority call ended.");
  }

  /** A timed-out gateway write may finish, so callers retain the original
   * allocation and can only verify that checkpoint. Late results cannot publish. */
  async #bounded<T>(call: AuthorityCallV1, work: () => Promise<T>): Promise<T> {
    this.#requireLive(call);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    const ended = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Checkpoint authority call ended."));
      call.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, Math.min(Date.parse(call.deadline) - this.#now(), 2_147_483_647));
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          this.#requireLive(call);
          return work();
        }),
        ended,
      ]);
      this.#requireLive(call);
      return result;
    } finally {
      clearTimeout(timer);
      call.signal.removeEventListener("abort", abort);
    }
  }

  #unknown(
    identity: ExactPublicationIdentity,
    stage: "allocation" | "publication",
    ref: string,
  ): CompletedContextPublicationResult {
    return {
      kind: "commit-unknown",
      stage,
      transactionRef: ref,
      allocation: identity.allocation,
      operation: identity.operation,
      nextAction: "exact-readback-only",
    };
  }

  async findAllocation(
    input: ExactCheckpointAllocationV1,
    authority: AuthorityCallV1,
  ): Promise<CheckpointAllocationStateV1> {
    try {
      const call = this.#call(authority);
      const exact = parseTurnJournalV1("checkpointAllocation", input);
      const state = parseTurnJournalResultV1(
        "checkpointAllocationState",
        await this.#bounded(call, () =>
          this.#options.store.read((view) => view.findCheckpointAllocation(exact, call), call),
        ),
      );
      if (state.kind === "found" && !sameData(state.allocation, exact)) return { kind: "denied" };
      return state;
    } catch {
      return { kind: "unavailable" };
    }
  }

  async findPublication(
    input: ExactCompletionOperationV1,
    authority: AuthorityCallV1,
  ): Promise<CompletionStateV1> {
    try {
      const call = this.#call(authority);
      const exact = parseTurnJournalV1("completionOperation", input);
      const state = parseTurnJournalResultV1(
        "completionState",
        await this.#bounded(call, () =>
          this.#options.store.read((view) => view.findCompletion(exact, call), call),
        ),
      );
      if (state.kind === "published" && !sameData(state.record.operation, exact))
        return { kind: "conflict" };
      return state;
    } catch {
      return { kind: "unavailable" };
    }
  }

  async prepareAndPublish(
    input: PrepareCheckpointPublication,
    authority: AuthorityCallV1,
  ): Promise<CompletedContextPublicationResult> {
    let identity: ExactCheckpointPublication;
    let preparation: PrepareCompletedInputV1;
    let allocationRef: string;
    let call: AuthorityCallV1;
    try {
      call = this.#call(authority);
      identity = publicationIdentity(input);
      allocationRef = transactionRef(input.allocationTransactionRef);
      preparation = parseCompletedContextV1("prepareCompletedInput", input.preparation);
      const expected = {
        ...identity.allocation.attempt,
        checkpointId: identity.allocation.checkpointId,
        expectedCompletionSequence: identity.operation.expectedCompletionSequence,
        nativeTerminalEvidenceRef: preparation.nativeTerminalEvidenceRef,
        workspaceCompletionRef: preparation.workspaceCompletionRef,
      };
      if (!sameData(preparation, expected)) return { kind: "conflict" };
    } catch {
      return { kind: "denied" };
    }

    let committed: JournalCommitResultV1<CheckpointAllocationResultV1>;
    let allocated: CheckpointAllocationResultV1;
    try {
      committed = await this.#bounded(call, () =>
        this.#options.store.transact(
          allocationRef,
          (unit) => unit.allocateCheckpoint(identity.allocation, call),
          call,
        ),
      );
    } catch {
      return this.#unknown(identity, "allocation", allocationRef);
    }
    if (committed.kind === "commit-unknown")
      return this.#unknown(identity, "allocation", allocationRef);
    if (committed.kind === "unavailable") return committed;
    try {
      allocated = parseTurnJournalResultV1("checkpointAllocation", committed.value);
    } catch {
      return this.#unknown(identity, "allocation", allocationRef);
    }
    if (!("allocation" in allocated)) return allocated;
    if (!sameData(allocated.allocation, identity.allocation)) return { kind: "conflict" };
    // TODO(UPS05 recovery): preparation after allocation-only uncertainty needs
    // selected-owner proof that no prior write occurred or exact idempotent
    // preparation ownership. Positive allocation alone cannot establish either.
    if (allocated.kind === "existing")
      return {
        kind: "allocated-existing",
        allocation: identity.allocation,
        operation: identity.operation,
        nextAction: "verify-existing-checkpoint-only",
      };

    // Re-authenticate the exact allocation before entering the selected gateway
    // adapter. Its receiver still owns fresh canonical-write authorization.
    const retained = await this.findAllocation(identity.allocation, call);
    if (retained.kind !== "found")
      return retained.kind === "absent" ? { kind: "unavailable" } : retained;
    let canonical: VerifiedCheckpointV1;
    try {
      const result = await this.#bounded(call, () =>
        this.#options.adapter.prepareCompleted(preparation),
      );
      if (result.kind === "unavailable")
        return parseCompletedContextV1("contextUnavailable", result);
      canonical = parseCompletedContextV1("verifiedCheckpoint", result);
      requireCheckpoint(identity, canonical.checkpointRef);
      if (canonical.checkpointRef.workspaceCompletionRef !== preparation.workspaceCompletionRef)
        return { kind: "conflict" };
    } catch {
      return {
        kind: "checkpoint-unresolved",
        allocation: identity.allocation,
        operation: identity.operation,
        nextAction: "verify-existing-checkpoint-only",
      };
    }
    return this.#publish(identity, canonical, call, preparation);
  }

  async reconcileAndPublish(
    input: ReconcileCheckpointPublication,
    authority: AuthorityCallV1,
  ): Promise<CompletedContextPublicationResult> {
    try {
      const call = this.#call(authority);
      const identity = publicationIdentity(input);
      const checkpoint = parseCompletedContextV1("checkpointRef", input.checkpoint);
      requireCheckpoint(identity, checkpoint);
      const retained = await this.findAllocation(identity.allocation, call);
      if (retained.kind !== "found")
        return retained.kind === "absent" ? { kind: "unavailable" } : retained;
      const result = await this.#bounded(call, () =>
        this.#options.adapter.verify(identity.allocation.expectedHead.context, checkpoint),
      );
      if (result.kind === "unavailable")
        return parseCompletedContextV1("contextUnavailable", result);
      const canonical = parseCompletedContextV1("verifiedCheckpoint", result);
      requireMatchingCompletedCheckpointV1(checkpoint, canonical.checkpointRef);
      return await this.#publish(identity, canonical, call);
    } catch {
      return { kind: "unavailable" };
    }
  }

  async #publish(
    identity: ExactCheckpointPublication,
    canonical: VerifiedCheckpointV1,
    call: AuthorityCallV1,
    preparation?: PrepareCompletedInputV1,
  ): Promise<CompletedContextPublicationResult> {
    let committed: JournalCommitResultV1<CompletionPublicationResultV1>;
    try {
      const evidence = await this.#bounded(call, () =>
        this.#options.evidence.verifyCompletion(identity.operation, call),
      );
      if ("kind" in evidence) {
        if (evidence.kind === "denied") return { kind: "denied" };
        if (evidence.kind === "unavailable") return { kind: "unavailable" };
        throw new Error("Invalid completion provenance result.");
      }
      const observed = await this.#bounded(call, () =>
        this.#options.evidence.inspectCompletion(evidence, call),
      );
      if ("kind" in observed) {
        if (observed.kind === "denied") return { kind: "denied" };
        if (observed.kind === "unavailable") return { kind: "unavailable" };
        throw new Error("Invalid completion observation result.");
      }
      const observedOperation = parseTurnJournalV1("completionOperation", observed.operation);
      const observedAllocation = parseTurnJournalV1("checkpointAllocation", observed.allocation);
      const observedCanonical = parseCompletedContextV1("verifiedCheckpoint", observed.canonical);
      if (
        !sameData(observedOperation, identity.operation) ||
        !sameData(observedAllocation, identity.allocation) ||
        observed.workspaceCompletionRef !== canonical.checkpointRef.workspaceCompletionRef ||
        (preparation &&
          observed.nativeTerminalEvidenceRef !== preparation.nativeTerminalEvidenceRef)
      )
        return { kind: "conflict" };
      requireMatchingCompletedCheckpointV1(
        canonical.checkpointRef,
        observedCanonical.checkpointRef,
      );
      // This inspection correlates the adapter observation only. The repository
      // MUST inspect this handle again inside its accepting publication transaction.
      this.#requireLive(call);
      try {
        committed = await this.#bounded(call, () =>
          this.#options.store.transact(
            identity.publicationTransactionRef,
            (unit) => unit.publishCompleted(evidence, call),
            call,
          ),
        );
      } catch {
        return this.#unknown(identity, "publication", identity.publicationTransactionRef);
      }
    } catch {
      return { kind: "unavailable" };
    }
    if (committed.kind === "commit-unknown")
      return this.#unknown(identity, "publication", identity.publicationTransactionRef);
    if (committed.kind === "unavailable") return committed;
    try {
      const result = parseTurnJournalResultV1("completionPublication", committed.value);
      if (result.kind === "published" || result.kind === "existing") {
        if (!sameData(result.record.operation, identity.operation))
          return this.#unknown(identity, "publication", identity.publicationTransactionRef);
        requireMatchingCompletedCheckpointV1(canonical.checkpointRef, result.record.checkpoint);
      }
      return result;
    } catch {
      return this.#unknown(identity, "publication", identity.publicationTransactionRef);
    }
  }
}
