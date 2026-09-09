import {
  parseTurnJournalV1,
  type ExactConsumptionOperationV1,
  type JournalAttemptBindingV1,
  type JournalExecutionSelectionV1,
  type PreCommitDispatchClockV1,
  type JournalInitiationGuardV1,
  type ExactSelectedExecutionV1,
  TURN_JOURNAL_LIMITS_V1,
  type JournalExecutionIntentV1,
  type PendingInitiationClaimV1,
} from "@openclaw-enterprise/contracts/turn-journal-v1";
import { sameJournalValue } from "./rows.ts";
import { randomUUID } from "node:crypto";
import { hrtime } from "node:process";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import { DependencyUnavailableError } from "../errors.ts";
import { ScopeViolationError } from "../errors.ts";
import type { PlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";

interface ClaimState {
  readonly owner: TurnJournalTransactionGuard;
  readonly operation: ExactConsumptionOperationV1;
  readonly expiresAt: string;
  readonly executionIntent?: JournalExecutionIntentV1;
  readonly dispatchClock?: PreCommitDispatchClockV1;
  taken: boolean;
  clockBound: boolean;
}

const transactionOwners = new WeakMap<PlatformUnitOfWork, TurnJournalTransactionGuard>();
const claims = new WeakMap<PendingInitiationClaimV1, ClaimState>();

/** The original PostgreSQL or memory transaction owner alone binds and confirms this internal guard.
 * Returned business decisions may commit; a thrown mutation failure poisons the
 * whole transaction, even when the outer callback catches the rejection.
 */
export class TurnJournalTransactionGuard {
  private readonly dispatches: Array<{
    binding: JournalAttemptBindingV1;
    clock: PreCommitDispatchClockV1;
    claimed: boolean;
  }> = [];
  private accepting = true;
  private active = true;
  private executing = false;
  private failed = false;
  private failure: unknown;
  private finished = false;
  private committed = false;
  private unit: PlatformUnitOfWork | undefined;
  private pending: Promise<void> = Promise.resolve();

  bind(unit: PlatformUnitOfWork): void {
    this.assertActive();
    if (this.unit !== undefined || transactionOwners.has(unit))
      throw new ScopeViolationError("The turn journal transaction is already bound.");
    this.unit = unit;
    transactionOwners.set(unit, this);
  }

  assertActive(): void {
    if (!this.active) throw new ScopeViolationError("The turn journal transaction is closed.");
  }

  mutate<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new ScopeViolationError("The turn journal transaction is closed."));
    const result = this.pending.then(async () => {
      this.assertCommittable();
      try {
        this.assertActive();
        this.executing = true;
        const value = await work();
        this.assertActive();
        return value;
      } catch (error) {
        this.failed = true;
        this.failure = error;
        throw error;
      } finally {
        this.executing = false;
      }
    });
    // Observe every accepted operation, including one the callback never awaits.
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Capture only inside the original serialized new-dispatch mutation, directly
   * before its UPDATE. Existing/replayed dispatches never call this method. */
  captureDispatch(binding: JournalAttemptBindingV1): void {
    this.assertActive();
    this.assertCommittable();
    if (
      !this.executing ||
      !this.unit ||
      this.dispatches.some((entry) => sameJournalValue(entry.binding.attempt, binding.attempt))
    )
      throw new ScopeViolationError("The original dispatch clock is unavailable.");
    const exact = parseTurnJournalV1("attemptBinding", binding);
    const clock = captureDispatchClock();
    this.dispatches.push({ binding: exact, clock, claimed: false });
  }

  executionIntent(
    selection: JournalExecutionSelectionV1,
    binding: JournalAttemptBindingV1,
  ): JournalExecutionIntentV1 {
    this.assertActive();
    this.assertCommittable();
    const entry = this.dispatches.find((item) => sameJournalValue(item.binding, binding));
    if (
      !this.executing ||
      !entry ||
      entry.claimed ||
      !sameJournalValue(selection.execution.attempt, binding.attempt) ||
      selection.execution.dispatchOperationRef !== binding.dispatchOperationRef
    )
      throw new ScopeViolationError("The original dispatch clock is unavailable.");
    return parseTurnJournalV1("executionIntent", { ...selection, dispatchClock: entry.clock });
  }

  /** Called only after inserting a new immutable consumption in this transaction.
   * This opaque local identity carries no authority until the real owner confirms
   * its commit boundary. Readback and copied/serialized values cannot manufacture membership.
   */
  createClaim(
    operation: ExactConsumptionOperationV1,
    expiresAt: string,
    executionIntent?: JournalExecutionIntentV1,
  ): PendingInitiationClaimV1 {
    this.assertActive();
    this.assertCommittable();
    if (!this.executing || this.unit === undefined || !Number.isFinite(Date.parse(expiresAt)))
      throw new ScopeViolationError("The turn journal consumption claim is unavailable.");
    const exact = parseTurnJournalV1("consumption", operation);
    const claim = Object.freeze({ operation: exact }) as PendingInitiationClaimV1;
    let dispatchClock: PreCommitDispatchClockV1 | undefined;
    if (executionIntent !== undefined) {
      const entry = this.dispatches.find(
        (item) =>
          sameJournalValue(item.binding.attempt, exact.attempt) &&
          item.binding.dispatchOperationRef === executionIntent.execution.dispatchOperationRef,
      );
      if (
        !entry ||
        entry.claimed ||
        !sameJournalValue(entry.clock, executionIntent.dispatchClock) ||
        !sameJournalValue(exact, executionIntent.execution.consumption)
      )
        throw new ScopeViolationError("The original dispatch clock is unavailable.");
      entry.claimed = true;
      dispatchClock = entry.clock;
    }
    claims.set(claim, {
      owner: this,
      operation: exact,
      expiresAt,
      taken: false,
      clockBound: false,
      ...(dispatchClock === undefined ? {} : { dispatchClock }),
      ...(executionIntent === undefined
        ? {}
        : { executionIntent: parseTurnJournalV1("executionIntent", executionIntent) }),
    });
    return claim;
  }

  async finish(): Promise<void> {
    // Close admissions before the first await. Accepted work retains backend access
    // while draining; no later mutation can join the transaction before COMMIT.
    this.accepting = false;
    await this.pending;
    this.assertCommittable();
    this.finished = true;
  }

  /** Pure local marker after verified PostgreSQL COMMIT or memory snapshot publication.
   * Invalid lifecycle state withholds claims without throwing after publication.
   */
  confirmCommitted(): void {
    if (this.active && this.finished && !this.failed && this.unit !== undefined)
      this.committed = true;
  }

  close(): void {
    this.accepting = false;
    this.active = false;
  }

  private assertCommittable(): void {
    if (this.failed) throw this.failure;
  }

  /** Internal inspection additionally requires the original transaction unit. */
  ownsCommitted(unit: PlatformUnitOfWork): boolean {
    return this.committed && this.unit === unit && transactionOwners.get(unit) === this;
  }
}

/** Single-use inspection for the store's newly completed outer transaction.
 * The unit is retained from that exact callback; a reopened read has no membership.
 */
export function takeCommittedTurnJournalClaim(
  unit: PlatformUnitOfWork,
  claim: PendingInitiationClaimV1,
):
  | Readonly<{
      operation: ExactConsumptionOperationV1;
      expiresAt: string;
      executionIntent?: JournalExecutionIntentV1;
      dispatchClock?: PreCommitDispatchClockV1;
    }>
  | undefined {
  const state = claims.get(claim);
  if (state === undefined || state.taken || !state.owner.ownsCommitted(unit)) return undefined;
  state.taken = true;
  return Object.freeze({
    operation: state.operation,
    expiresAt: state.expiresAt,
    ...(state.dispatchClock === undefined ? {} : { dispatchClock: state.dispatchClock }),
    ...(state.executionIntent === undefined ? {} : { executionIntent: state.executionIntent }),
  });
}

// This process owns the epoch. These labels correlate observations; they do not
// authenticate a remote peer or qualify the relative rate of another clock.
const origin = hrtime.bigint();
const clockSourceRef = `node-hrtime:${randomUUID()}`;
const clockEpochRef = `process-epoch:${randomUUID()}`;
let previous = origin;
const unavailable = () => new DependencyUnavailableError("The dispatch clock is unavailable.");
function elapsed(roundUp: boolean): number {
  const now = hrtime.bigint();
  if (now < previous || now < origin) throw unavailable();
  previous = now;
  const delta = now - origin;
  const value = Number((delta + (roundUp ? 999_999n : 0n)) / 1_000_000n);
  if (!Number.isSafeInteger(value) || value < 0) throw unavailable();
  return value;
}

/** Internal original-writer capture. This data becomes transferable only through
 * its transaction guard's known-COMMIT claim. No caller clock is accepted. */
function captureDispatchClock(): PreCommitDispatchClockV1 {
  const anchorAtMs = elapsed(false);
  const deadlineAtMs = anchorAtMs + TURN_JOURNAL_LIMITS_V1.maximumTurnMs;
  if (!Number.isSafeInteger(deadlineAtMs)) throw unavailable();
  const clock = Object.freeze({
    kind: "pre-commit-monotonic-v1" as const,
    clockSourceRef,
    clockEpochRef,
    anchorAtMs,
    deadlineAtMs,
  });
  return clock;
}

interface InitiationClock {
  readonly clock: PreCommitDispatchClockV1;
  readonly execution: ExactSelectedExecutionV1;
  readonly call: AuthorityCallV1;
  active: boolean;
  admitted: boolean;
}
const initiations = new WeakMap<JournalInitiationGuardV1, InitiationClock>();

/** Called only by the original store after taking its newly committed claim.
 * The caller closes this separate initiation lifetime without reopening the DB
 * transaction. There is no import/readback constructor for a clock owner. */
export function bindCommittedTurnJournalClock(
  unit: PlatformUnitOfWork,
  claim: PendingInitiationClaimV1,
  guard: JournalInitiationGuardV1,
  call: AuthorityCallV1,
): () => void {
  const retained = claims.get(claim);
  const clock = retained?.dispatchClock;
  if (
    !retained ||
    !retained.taken ||
    retained.clockBound ||
    !retained.owner.ownsCommitted(unit) ||
    !clock ||
    initiations.has(guard) ||
    !guard.executionIntent ||
    !sameJournalValue(guard.executionIntent, retained.executionIntent) ||
    !("kind" in guard.executionIntent.dispatchClock) ||
    guard.executionIntent.dispatchClock.kind !== "pre-commit-monotonic-v1" ||
    clock.clockSourceRef !== clockSourceRef ||
    clock.clockEpochRef !== clockEpochRef ||
    !sameJournalValue(guard.executionIntent.dispatchClock, clock)
  )
    throw unavailable();
  retained.clockBound = true;
  Object.freeze(guard);
  const state = {
    clock,
    call: Object.freeze({ ...call }),
    execution: guard.executionIntent.execution,
    active: true,
    admitted: false,
  };
  initiations.set(guard, state);
  return () => {
    state.active = false;
  };
}

/** Spend the original initiation once across every controller instance. This is
 * an internal local ownership check, not a serialized execution credential. */
export function takeDispatchClockForExecution(
  guard: JournalInitiationGuardV1,
  call: AuthorityCallV1,
): void {
  const state = initiations.get(guard);
  if (
    !state?.active ||
    state.admitted ||
    guard.signal.aborted ||
    call.signal.aborted ||
    call.context !== state.call.context ||
    call.requestRef !== state.call.requestRef ||
    call.recipientRef !== state.call.recipientRef ||
    call.deadline !== state.call.deadline
  )
    throw unavailable();
  state.admitted = true;
}

/** Sample only the exact original initiation, after its currentness check. A
 * native transport must bind this response to its original authenticated socket
 * and challenge, and qualify cross-clock rate/error before mapping the ceiling.
 * Ceil rounding of the sample conservatively shortens remaining duration. */
export async function sampleDispatchClock(
  guard: JournalInitiationGuardV1,
  challengeRef: string,
): Promise<
  Readonly<{
    challengeRef: string;
    execution: ExactSelectedExecutionV1;
    dispatchClock: PreCommitDispatchClockV1;
    sampledAtMs: number;
  }>
> {
  const state = initiations.get(guard);
  if (
    !state?.active ||
    guard.signal.aborted ||
    typeof challengeRef !== "string" ||
    challengeRef.length === 0 ||
    challengeRef.length > TURN_JOURNAL_LIMITS_V1.referenceCharacters ||
    Buffer.byteLength(challengeRef, "utf8") > TURN_JOURNAL_LIMITS_V1.referenceBytes
  )
    throw unavailable();
  await guard.assertCurrent();
  if (!state.active || guard.signal.aborted || initiations.get(guard) !== state)
    throw unavailable();
  const sampledAtMs = elapsed(true);
  if (sampledAtMs < state.clock.anchorAtMs || sampledAtMs >= state.clock.deadlineAtMs)
    throw unavailable();
  return Object.freeze({
    challengeRef,
    execution: state.execution,
    dispatchClock: Object.freeze({ ...state.clock }),
    sampledAtMs,
  });
}
