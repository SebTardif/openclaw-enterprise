import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createCompletedStateStore } from "openclaw/plugin-sdk/completed-state";
import {
  parseCompletedContextV1,
  requireMatchingCompletedCheckpointV1,
} from "../../../packages/contracts/src/completed-context-v1.ts";
import {
  parseTurnJournalResultV1,
  parseTurnJournalV1,
  type JournalEvidenceProvenanceV1,
} from "../../../packages/contracts/src/turn-journal-v1.ts";
import type { AuthorityCallV1 } from "../../../packages/contracts/src/runtime-authority-v1.ts";
import {
  CompletedContextJournalService,
  type PrepareCheckpointPublication,
} from "../../../packages/occ/src/turn-journal/completed-context.ts";
import { TurnJournalStore } from "../../../packages/occ/src/turn-journal/store.ts";

export type CheckpointCompositionSelectionV1 =
  Readonly<{ kind: "unselected" }> | Readonly<{ kind: "selected"; moduleUrl: string }>;

/** Explicit local fixture selection, never an authority or provider factory.
 * Only absence is unselected: an empty, malformed or unavailable selection fails.
 * The execution owner separately binds the module and its actual dependencies. */
export function selectCheckpointCompositionV1(
  value: string | undefined,
): CheckpointCompositionSelectionV1 {
  if (value === undefined) return Object.freeze({ kind: "unselected" });
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Select an absolute local checkpoint composition module.");
  const url = value.startsWith("file:")
    ? new URL(value)
    : isAbsolute(value)
      ? pathToFileURL(value)
      : undefined;
  if (!url || url.protocol !== "file:" || url.hostname || url.search || url.hash)
    throw new Error("Select an absolute local checkpoint composition module.");
  return Object.freeze({ kind: "selected", moduleUrl: url.href });
}

/** Inputs must come from the original accepting constructors. The type is a
 * fixture assembly contract, not proof that an arbitrary object owns a native
 * terminal, canonical database, PostgreSQL unit, or current authority.
 *
 * The opener retains the complete original publication identity and any possible
 * writer through uncertainty. A rejected/partially acquired open must settle its
 * own resources; after it yields a lease, this runner owns joining settle(). */
export interface CheckpointCompositionLeaseV1 {
  readonly canonical: Parameters<typeof createCompletedStateStore>[0];
  readonly store: TurnJournalStore;
  readonly evidence: JournalEvidenceProvenanceV1;
  readonly publication: PrepareCheckpointPublication;
  readonly call: AuthorityCallV1;
  /** Actual current preparation/publication/read authority. The opener binds the
   * incoming signal to that original lifetime; this callback cannot issue it. */
  assertCurrent(): Promise<void>;
  /** Join every accepted/late preparation, evidence and transaction operation
   * before closing only this fixture's resources. Timeout is not settlement or
   * physical no-mutator proof. Never release a journal reservation by inference. */
  settle(): Promise<void>;
}

export type OpenCheckpointCompositionV1 = (
  signal: AbortSignal,
) => Promise<CheckpointCompositionLeaseV1>;

/** Loading a selected local module never grants its contents authority. The
 * original operator must select the authentic receiving construction module.
 * No default composition, internal handle issuer or database enrollment exists
 * here. In particular, a database URL alone is not a complete selection. */
export async function loadCheckpointCompositionV1(
  selection: Readonly<{ kind: "selected"; moduleUrl: string }>,
): Promise<OpenCheckpointCompositionV1> {
  const exact = selectCheckpointCompositionV1(selection.moduleUrl);
  if (selection.kind !== "selected" || exact.kind !== "selected")
    throw new Error("A checkpoint composition module must be selected.");
  const loaded: unknown = await import(exact.moduleUrl);
  if (
    loaded === null ||
    typeof loaded !== "object" ||
    !("openCheckpointCompositionV1" in loaded) ||
    typeof loaded.openCheckpointCompositionV1 !== "function"
  )
    throw new Error("The selected module does not supply openCheckpointCompositionV1.");
  return loaded.openCheckpointCompositionV1.bind(loaded) as OpenCheckpointCompositionV1;
}

function sameData(actual: unknown, expected: unknown, message: string): void {
  // Product codecs return null-prototype records. That representation does not
  // alter their decoded immutable wire values.
  assert.deepStrictEqual(structuredClone(actual), structuredClone(expected), message);
}

function live(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal) || signal.aborted)
    throw new Error("The selected checkpoint composition invocation ended.");
}

/** The named real integration uses this runner, never serviceProbe or a fake
 * adapter factory. Component tests of refusals and cleanup remain explicitly
 * controlled; only an original supplied PostgreSQL/native/workspace composition
 * can satisfy the positive integration obligation.
 *
 * This is a fresh publication case. Existing/unknown allocation never authorizes
 * another prepare; uncertainty is retained by the original opener for separately
 * authorized exact readback. The runner makes no automatic mutation retry. */
export async function runCheckpointCompositionV1(
  open: OpenCheckpointCompositionV1,
  signal: AbortSignal,
): Promise<void> {
  live(signal);
  if (typeof open !== "function")
    throw new Error("The original checkpoint composition opener is required.");

  let settle: (() => Promise<void>) | undefined;
  let failed = false;
  let primary: unknown;
  try {
    // Do not race this acquisition against an outward timeout. A late lease still
    // belongs to this invocation and must reach its original settlement function.
    const lease = await open(signal);
    if (lease === null || typeof lease !== "object")
      throw new Error("The selected checkpoint composition has no owned settlement.");
    const originalSettle = lease.settle;
    if (typeof originalSettle !== "function")
      throw new Error("The selected checkpoint composition has no owned settlement.");
    settle = originalSettle.bind(lease);
    live(signal);

    // This is the actual SDK constructor, including its exact binding decoder and
    // original database-owner checks. Never sanitize a forged binding or replace
    // its storage/authority with a test-created positive adapter.
    const canonical = createCompletedStateStore(lease.canonical);
    const store = lease.store;
    if (!(store instanceof TurnJournalStore))
      throw new Error("The selected composition requires the original TurnJournalStore.");
    const evidence = lease.evidence;
    const originalAssertCurrent = lease.assertCurrent;
    if (
      typeof evidence?.verifyCompletion !== "function" ||
      typeof evidence.inspectCompletion !== "function" ||
      typeof originalAssertCurrent !== "function"
    )
      throw new Error("The selected composition lacks original completion authority.");
    const assertCurrent = originalAssertCurrent.bind(lease);
    const call = Object.freeze({ ...lease.call });
    const input = lease.publication;
    const publication: PrepareCheckpointPublication = Object.freeze({
      allocation: parseTurnJournalV1("checkpointAllocation", input.allocation),
      operation: parseTurnJournalV1("completionOperation", input.operation),
      preparation: parseCompletedContextV1("prepareCompletedInput", input.preparation),
      allocationTransactionRef: input.allocationTransactionRef,
      publicationTransactionRef: input.publicationTransactionRef,
    });
    assert.notEqual(
      publication.allocationTransactionRef,
      publication.publicationTransactionRef,
      "Allocation and publication retain distinct original outer transactions.",
    );
    const current = async () => {
      live(signal);
      live(call.signal);
      await assertCurrent();
      live(signal);
      live(call.signal);
    };
    const service = new CompletedContextJournalService({
      store,
      adapter: {
        prepareCompleted: canonical.prepareCompleted.bind(canonical),
        verify: canonical.verify.bind(canonical),
      },
      evidence,
    });

    await current();
    const before = await service.findAllocation(publication.allocation, call);
    await current();
    assert.equal(before.kind, "absent", "This case requires its original fresh allocation.");

    // The product service awaits the allocation outer COMMIT, then the actual
    // canonical adapter's durable preparation/verification, then publication CAS.
    // It reuses the preallocated ID and asks the accepting journal to re-inspect
    // the original completion handle inside that publication transaction.
    const result = await service.prepareAndPublish(publication, call);
    await current();
    assert.equal(
      result.kind,
      "published",
      "Fresh publication was not acknowledged; retain the original identity for exact readback.",
    );
    if (result.kind !== "published") throw new Error("Checkpoint publication is unresolved.");
    const record = parseTurnJournalV1("completion", result.record);
    sameData(record.operation, publication.operation, "Publication retains the exact operation.");
    assert.equal(record.checkpoint.checkpointId, publication.allocation.checkpointId);
    assert.equal(
      record.checkpoint.completionSequence,
      publication.operation.expectedCompletionSequence + 1,
    );
    assert.equal(
      record.checkpoint.parentCheckpointId,
      publication.allocation.expectedHead.checkpointId,
    );
    assert.equal(record.head.headVersion, publication.allocation.expectedHead.headVersion + 1);
    assert.equal(record.head.checkpointId, publication.allocation.checkpointId);
    assert.equal(record.outcomeVersion, publication.operation.expectedAttemptVersion + 1);

    // Verification uses the real canonical bytes at the same original manifest;
    // it cannot prepare another checkpoint or import/replay native history.
    const verified = parseCompletedContextV1(
      "verifiedCheckpoint",
      await canonical.verify(publication.allocation.expectedHead.context, record.checkpoint),
    );
    await current();
    requireMatchingCompletedCheckpointV1(record.checkpoint, verified.checkpointRef);
    const found = await service.findPublication(publication.operation, call);
    await current();
    assert.equal(
      found.kind,
      "published",
      "A fresh original read must find the committed publication.",
    );
    if (found.kind !== "published")
      throw new Error("Checkpoint publication readback is unresolved.");
    sameData(found.record, record, "Exact readback retains the complete original publication.");

    // Do not call public readHead while the attempt reservation is held. Inspect
    // the exact attempt and pending delivery through their original read ports.
    const retained = await store.read(
      async (reader) => ({
        attempt: await reader.findAttempt(publication.operation.attempt, call),
        delivery: await reader.findDelivery(record.pendingDelivery, call),
      }),
      call,
    );
    await current();
    const attempt = parseTurnJournalResultV1("attemptState", retained.attempt);
    assert.equal(attempt.kind, "found");
    if (attempt.kind !== "found") throw new Error("The completed attempt is unavailable.");
    assert.equal(attempt.record.version, record.outcomeVersion);
    assert.equal(attempt.record.outcome.kind, "completed");
    if (attempt.record.outcome.kind !== "completed")
      throw new Error("The attempt did not complete.");
    assert.equal(attempt.record.outcome.completionOperationRef, record.operation.operationRef);
    requireMatchingCompletedCheckpointV1(record.checkpoint, attempt.record.outcome.checkpoint);
    const delivery = parseTurnJournalResultV1("delivery", retained.delivery);
    assert.equal(
      delivery.kind,
      "pending",
      "Publication atomically retains the unsent completed-result slot.",
    );
    if (delivery.kind !== "pending")
      throw new Error("The pending publication slot is unavailable.");
    sameData(
      delivery.operation,
      record.pendingDelivery,
      "Pending output retains its exact operation.",
    );
  } catch (error) {
    failed = true;
    primary = error;
  }

  if (settle) {
    try {
      await settle();
    } catch (cleanup) {
      if (failed)
        throw new AggregateError(
          [primary, cleanup],
          "Checkpoint composition and owned settlement failed.",
          {
            cause: primary,
          },
        );
      throw cleanup;
    }
  }
  if (failed) throw primary;
}
