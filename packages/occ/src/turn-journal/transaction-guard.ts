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
  type JournalDeadlineControlV1,
  type VerifiedDeadlineControlV1,
  type PendingInitiationClaimV1,
} from "@openclaw-enterprise/contracts/turn-journal-v1";
import { sameJournalValue } from "./rows.ts";
import { randomUUID, createHash } from "node:crypto";
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
  const clock = Object.freeze({
    kind: "pre-commit-monotonic-v2" as const,
    clockSourceRef,
    clockEpochRef,
    anchorAtMs,
  });
  return clock;
}

interface InitiationClock {
  readonly clock: PreCommitDispatchClockV1;
  readonly execution: ExactSelectedExecutionV1;
  readonly call: AuthorityCallV1;
  active: boolean;
  admitted: boolean;
  transferred: boolean;
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
    guard.executionIntent.dispatchClock.kind !== "pre-commit-monotonic-v2" ||
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
    transferred: false,
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
 * and challenge. The host retains enforcement; this is an observation, not a
 * guest-clock deadline mapping. Ceil rounding shortens capped remaining duration. */
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
  if (
    sampledAtMs < state.clock.anchorAtMs ||
    (guard.executionIntent!.maximumExecutionMs !== null &&
      sampledAtMs >= state.clock.anchorAtMs + guard.executionIntent!.maximumExecutionMs)
  )
    throw unavailable();
  return Object.freeze({
    challengeRef,
    execution: state.execution,
    dispatchClock: Object.freeze({ ...state.clock }),
    sampledAtMs,
  });
}

/** Retained local stop lifetime, independent of the consumed initiation guard. It
 * carries no continuing grant and never establishes termination or release. */
export interface RetainedDispatchDeadline {
  readonly control: JournalDeadlineControlV1;
  readonly evidence: VerifiedDeadlineControlV1;
  readonly signal: AbortSignal;
  assertBeforeEffect(): void;
  requestStop(): Promise<void>;
}

/** Transfer only the actual, already admitted original known-COMMIT claim. The
 * caller is the selected controller binding the actual pre-admitted stop owner;
 * clocks, readback and new guards cannot create membership. No new epoch/sample
 * can replace the original bound. Stop bypasses every continuing-work queue. */
export function transferDispatchDeadline(
  guard: JournalInitiationGuardV1,
  call: AuthorityCallV1,
  target: Readonly<{ nativeIncarnationRef: string; nativeConstructionRef: string }>,
  stop: (control: JournalDeadlineControlV1) => Promise<void>,
): RetainedDispatchDeadline {
  const state = initiations.get(guard);
  if (
    !state?.active ||
    !state.admitted ||
    state.transferred ||
    guard.signal.aborted ||
    call.signal.aborted ||
    call.context !== state.call.context ||
    call.requestRef !== state.call.requestRef ||
    call.recipientRef !== state.call.recipientRef ||
    call.deadline !== state.call.deadline ||
    !guard.executionIntent ||
    !sameJournalValue(guard.executionIntent.dispatchClock, state.clock)
  )
    throw unavailable();
  const operationRef = `deadline-control:${randomUUID()}`;
  const responsibilityRef = `execution-cleanup:${randomUUID()}`;
  const payload = {
    kind: "host-stop-v2" as const,
    intent: guard.executionIntent,
    operationRef,
    nativeIncarnationRef: target.nativeIncarnationRef,
    nativeConstructionRef: target.nativeConstructionRef,
    responsibilityRef,
    responsibilityVersion: 1,
    deadlineAtMs:
      guard.executionIntent.maximumExecutionMs === null
        ? null
        : state.clock.anchorAtMs + guard.executionIntent.maximumExecutionMs,
  };
  const control = parseTurnJournalV1("deadlineControl", {
    ...payload,
    operationDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  });
  state.transferred = true;
  const cancellation = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;
  const requestStop = (): Promise<void> => {
    if (stopping) return stopping;
    // Publish the latch before invoking user/native code, including synchronous
    // reentry. Rejection/ACK remains unknown; this owner never frees a reservation.
    let complete!: () => void;
    let fail!: (reason: unknown) => void;
    stopping = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    void stopping.catch(() => {});
    if (timer !== undefined) clearTimeout(timer);
    cancellation.abort();
    try {
      Promise.resolve(stop(control)).then(complete, fail);
    } catch (error) {
      fail(error);
    }
    return stopping;
  };
  const assertBeforeEffect = (): void => {
    if (cancellation.signal.aborted) throw unavailable();
    try {
      const now = elapsed(true);
      if (
        now < state.clock.anchorAtMs ||
        (control.deadlineAtMs !== null && now >= control.deadlineAtMs)
      )
        throw unavailable();
    } catch (error) {
      void requestStop();
      throw error;
    }
  };
  const wake = (): void => {
    try {
      assertBeforeEffect();
      if (control.deadlineAtMs === null) return;
      const remaining = control.deadlineAtMs - elapsed(true);
      if (remaining <= 0) {
        void requestStop();
        return;
      }
      // A delayed or early wake cannot renew the original deadline. Process
      // lifetime is owned by the host; exit is unknown, never successful stop.
      timer = setTimeout(wake, Math.min(remaining, 2_147_483_647));
      timer.unref();
    } catch {
      void requestStop();
    }
  };
  const evidence = Object.freeze({}) as VerifiedDeadlineControlV1;
  const owner = Object.freeze({
    control,
    evidence,
    signal: cancellation.signal,
    assertBeforeEffect,
    requestStop,
  });
  deadlineControls.set(evidence, { guard, state, owner });
  wake();
  return owner;
}

const deadlineControls = new WeakMap<
  VerifiedDeadlineControlV1,
  {
    guard: JournalInitiationGuardV1;
    state: InitiationClock;
    owner: RetainedDispatchDeadline;
  }
>();
/** Original admission's own mandatory self-cleanup, not a new human cancellation
 * grant or an external positive inspector. New retention stays inside the real
 * initiation lifetime; its already retained stop duty outlives that lifetime. */
export async function inspectOriginalDeadlineControl(
  handle: VerifiedDeadlineControlV1,
  call: AuthorityCallV1,
): Promise<JournalDeadlineControlV1 | Readonly<{ kind: "unavailable" }>> {
  const bound = deadlineControls.get(handle);
  if (
    !bound ||
    !bound.state.active ||
    bound.guard.signal.aborted ||
    call.signal.aborted ||
    call.context !== bound.state.call.context ||
    call.requestRef !== bound.state.call.requestRef ||
    call.recipientRef !== bound.state.call.recipientRef ||
    call.deadline !== bound.state.call.deadline
  )
    return { kind: "unavailable" };
  await bound.guard.assertCurrent();
  if (!bound.state.active || bound.guard.signal.aborted || call.signal.aborted)
    return { kind: "unavailable" };
  bound.owner.assertBeforeEffect();
  return bound.owner.control;
}
