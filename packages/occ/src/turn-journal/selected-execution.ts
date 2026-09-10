import {
  parseTurnJournalV1,
  type AuthorizedDispatchV1,
  type ExactExecutionInterruptionV1,
  type ExactSelectedExecutionV1,
  type JournalExecutionStartV1,
  type JournalDeadlineControlV1,
  type JournalInitiationGuardV1,
  type VerifiedConsumptionV1,
  type VerifiedExecutionInterruptionV1,
  type VerifiedExecutionStartV1,
} from "@openclaw-enterprise/contracts/turn-journal-v1";
import type { ExactAttemptV1 } from "@openclaw-enterprise/contracts/completed-context-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import { DependencyUnavailableError } from "../errors.ts";
import { sameJournalValue } from "./rows.ts";
import {
  sampleDispatchClock,
  takeDispatchClockForExecution,
  transferDispatchDeadline,
  type RetainedDispatchDeadline,
} from "./dispatcher-clock.ts";
import { TurnJournalStore } from "./store.ts";

/** An observation returned by the actual native owner. That owner must retain
 * its original connection, irrevocably ready Session/task/drain and exact host
 * deadline association independently of this JS object's lifetime. start is data,
 * not authority.
 */
export interface NativeReadyExecution {
  readonly start: JournalExecutionStartV1;
  readonly evidence: VerifiedExecutionStartV1;
}

/** Supplied only by the actual pending native construction's cancellation owner.
 * The original committed admission grants its exact mandatory cleanup during
 * transfer; this target projection cannot create admission or stop authority. */
export interface NativeDeadlineStopOwner {
  readonly target: Readonly<{ nativeIncarnationRef: string; nativeConstructionRef: string }>;
  /** Direct retained stop lane: no continuing grant, serial tail or new database
   * write at expiry. ACK is not proof that construction/child/drain joins ended. */
  interrupt(control: JournalDeadlineControlV1): Promise<void>;
}
/** Implemented at the original authenticated native connection. No default
 * implementation exists. The actual owner verifies original membership on each
 * call; serialized receipts, connection IDs and evidence references cannot pass.
 */
export interface NativeSelectedExecutionOwner {
  /** Consume only this original callback. Reserve the actual pending construction
   * and await retainDeadline before polling any effectful constructor. Recheck
   * guard before ready commitment and after waits. Retain the entire task/drain
   * and transfer ongoing control before returning; the model/tool gate stays
   * closed until confirmRetainedStart succeeds. No automatic retry or second
   * executable acceptance is permitted.
   */
  accept(
    guard: JournalInitiationGuardV1,
    call: AuthorityCallV1,
    retainDeadline: (pending: NativeDeadlineStopOwner) => Promise<JournalDeadlineControlV1>,
  ): Promise<NativeReadyExecution>;
  /** Independent whole-execution authority, not the expired consumed predicate.
   * Recheck current original human/common/Agent grants, purpose/recipient,
   * assignment/incarnation, original clock and deadline after every native wait.
   * Interrupt instead requires its current stop responsibility; expired or
   * revoked execution authority must not prevent an independently authorized stop.
   * Own revocation while idle/blocked and retain uncertain task/child closure.
   */
  assertCurrent(
    owned: NativeReadyExecution,
    purpose: "continue" | "interrupt",
    call: AuthorityCallV1,
  ): Promise<void>;
  /** Open only the already committed ready execution's single gate. This owner
   * performs its own final currentness/deadline check at the actual gate.
   */
  confirmRetainedStart(
    owned: NativeReadyExecution,
    start: JournalExecutionStartV1,
    call: AuthorityCallV1,
  ): Promise<void>;
  inspectInterruption(
    owned: NativeReadyExecution,
    operation: ExactExecutionInterruptionV1,
    call: AuthorityCallV1,
  ): Promise<VerifiedExecutionInterruptionV1>;
  /** Exact original control request; return does not establish all-mutator stop. */
  interrupt(
    owned: NativeReadyExecution,
    operation: ExactExecutionInterruptionV1,
    call: AuthorityCallV1,
  ): Promise<void>;
}
interface OwnedExecution {
  readonly deadline: RetainedDispatchDeadline;
  readonly native: NativeReadyExecution;
  readonly start: JournalExecutionStartV1;
  tail: Promise<void>;
  confirmationAttempted: boolean;
  interruption: ExactExecutionInterruptionV1 | undefined;
  interruptionAttempted: boolean;
}
const unavailable = () => new DependencyUnavailableError("Selected execution is unavailable.");
const key = (execution: ExactSelectedExecutionV1) =>
  JSON.stringify([execution.attempt.installationRef, execution.executionRef]);

/** Connects the original committed journal callback to its retained native owner.
 * This controller owns orchestration only. It creates no authentication context,
 * provenance handle, selected intent, native receipt, clock or current grant.
 */
export class SelectedExecutionController {
  private readonly executions = new Map<string, OwnedExecution>();
  // Includes unknown pre-ready construction. ACK/rejection and deadline expiry
  // never discard the original cleanup owner or reclaim its admission slot.
  private readonly deadlines = new Map<string, RetainedDispatchDeadline>();
  private admittedOwners = 0;
  private readonly journal: TurnJournalStore;
  private readonly native: NativeSelectedExecutionOwner;
  private readonly maximumOwnedExecutions: number;
  constructor(
    journal: TurnJournalStore,
    native: NativeSelectedExecutionOwner,
    maximumOwnedExecutions: number,
  ) {
    this.journal = journal;
    this.native = native;
    this.maximumOwnedExecutions = maximumOwnedExecutions;
    if (
      !Number.isSafeInteger(maximumOwnedExecutions) ||
      maximumOwnedExecutions < 1 ||
      maximumOwnedExecutions > 100_000
    )
      throw unavailable();
  }

  consume(input: VerifiedConsumptionV1, call: AuthorityCallV1) {
    return this.initiate(input, call);
  }

  dispatchAndConsume(
    dispatch: AuthorizedDispatchV1,
    input: VerifiedConsumptionV1,
    call: AuthorityCallV1,
  ) {
    return this.initiate(input, call, dispatch);
  }

  private initiate(
    input: VerifiedConsumptionV1,
    call: AuthorityCallV1,
    dispatch?: AuthorizedDispatchV1,
  ) {
    const start =
      dispatch === undefined
        ? this.journal.consumeAndInitiate.bind(this.journal)
        : this.journal.dispatchAndConsumeAndInitiate.bind(this.journal, dispatch);
    return start(input, (attempt, guard) => this.acceptInitiation(attempt, guard, call), call);
  }

  /** Join an already claimed original callback without consuming again. The
   * actual store guard's private clock membership is spent once across controller
   * instances; copied/serialized guards and a reopened journal cannot enter. */
  async acceptInitiation(
    attempt: ExactAttemptV1,
    guard: JournalInitiationGuardV1,
    originalCall: AuthorityCallV1,
  ): Promise<void> {
    const call = Object.freeze({ ...originalCall });
    if (!sameJournalValue(attempt, guard.executionIntent?.execution.attempt)) throw unavailable();
    takeDispatchClockForExecution(guard, call);

    if (!guard.executionIntent || this.admittedOwners >= this.maximumOwnedExecutions)
      throw unavailable();
    // Reserve before the first await, including an unknown native acceptance.
    // Without complete closure there is no slot reclamation.
    this.admittedOwners++;
    // Only the original committed clock owner may reach native admission.
    // Native keeps its actual construction gated while the original host binds
    // the independently admitted stop duty and retains its conditional control.
    await sampleDispatchClock(guard, call.requestRef);
    let deadline: RetainedDispatchDeadline | undefined;
    let pendingSeen = false;
    let controlRetained = false;
    let readyRetained = false;
    try {
      const receipt = await this.native.accept(guard, call, async (pending) => {
        if (pendingSeen) throw unavailable();
        pendingSeen = true;
        // Capture the actual original pending owner before the first await. The
        // bridge authenticates this target; original claim membership authenticates
        // admission, not a native target copied into this interface.
        const target = Object.freeze({
          nativeIncarnationRef: pending.target.nativeIncarnationRef,
          nativeConstructionRef: pending.target.nativeConstructionRef,
        });
        const interrupt = pending.interrupt.bind(pending);
        Object.freeze(pending.target);
        Object.freeze(pending);
        await guard.assertCurrent();
        deadline = transferDispatchDeadline(guard, call, target, interrupt);
        const control = deadline.control;
        const locator = key(control.intent.execution);
        if (this.deadlines.has(locator)) throw unavailable();
        this.deadlines.set(locator, deadline);
        // Retain cleanup before waiting on PostgreSQL. Expiry can interrupt a
        // blocked retention independently; unknown COMMIT cannot open construction.
        deadline.assertBeforeEffect();
        const retained = await this.journal.transact(
          control.operationRef,
          (j) => j.retainDeadlineControl(deadline!.evidence, call),
          call,
        );
        if (
          retained.kind !== "committed" ||
          !["recorded", "existing"].includes(retained.value.kind) ||
          !("record" in retained.value) ||
          !sameJournalValue(retained.value.record, control)
        )
          throw unavailable();
        await guard.assertCurrent();
        deadline.assertBeforeEffect();
        controlRetained = true;
        return control;
      });
      const start = parseTurnJournalV1("executionStart", receipt.start);
      if (
        !deadline ||
        !controlRetained ||
        !("kind" in start) ||
        start.kind !== "host-controlled-v2" ||
        !sameJournalValue(start.intent, guard.executionIntent) ||
        !sameJournalValue(start.deadlineControl, deadline.control)
      )
        throw unavailable();
      deadline.assertBeforeEffect();
      const locator = key(start.intent.execution);
      if (this.executions.has(locator)) throw unavailable();
      const owned: OwnedExecution = {
        deadline,
        native: receipt,
        start,
        tail: Promise.resolve(),
        confirmationAttempted: false,
        interruption: undefined,
        interruptionAttempted: false,
      };
      // Retain original ownership before any following wait. Exceptions and lost
      // acknowledgments leave this same ready execution gated/unknown.
      this.executions.set(locator, owned);
      readyRetained = true;
      await this.serial(owned, async () => {
        await guard.assertCurrent();
        await this.native.assertCurrent(receipt, "continue", call);
        owned.deadline.assertBeforeEffect();
        await guard.assertCurrent();
        const retained = await this.journal.transact(
          start.operationRef,
          (j) => j.retainExecutionStart(receipt.evidence, call),
          call,
        );
        if (
          retained.kind !== "committed" ||
          !["recorded", "existing"].includes(retained.value.kind) ||
          !("record" in retained.value) ||
          !sameJournalValue(retained.value.record, start)
        )
          throw unavailable();
        await this.confirm(owned, call);
      });
    } catch (error) {
      // Unknown construction keeps ownership and admission reserved. Cleanup
      // remains necessary without duration expiry. A retained ready owner stays
      // gated and can still resolve its original start retention acknowledgment.
      if (deadline && !readyRetained) void deadline.requestStop().catch(() => {});
      throw error;
    }
  }

  /** Exact readback can resolve only this controller's original pending native
   * record. A process restart or a DTO without that owner cannot reopen a gate.
   */
  async resolveStart(input: ExactSelectedExecutionV1, call: AuthorityCallV1): Promise<void> {
    const execution = parseTurnJournalV1("selectedExecution", input);
    const owned = this.owned(execution);
    await this.serial(owned, async () => {
      owned.deadline.assertBeforeEffect();
      await this.native.assertCurrent(owned.native, "continue", call);
      owned.deadline.assertBeforeEffect();
      const state = await this.journal.read((j) => j.findExecution(execution, call), call);
      if (state.kind !== "started" || !sameJournalValue(state.start, owned.start))
        throw unavailable();
      await this.confirm(owned, call);
    });
  }

  async interrupt(input: ExactExecutionInterruptionV1, call: AuthorityCallV1): Promise<void> {
    const operation = parseTurnJournalV1("executionInterruption", input);
    const owned = this.owned(operation.start.intent.execution);
    await this.serial(owned, async () => {
      if (!sameJournalValue(operation.start, owned.start) || owned.interruption !== undefined)
        throw unavailable();
      await this.native.assertCurrent(owned.native, "interrupt", call);
      const evidence = await this.native.inspectInterruption(owned.native, operation, call);
      await this.native.assertCurrent(owned.native, "interrupt", call);
      owned.interruption = operation;
      const retained = await this.journal.transact(
        operation.operationRef,
        (j) => j.retainExecutionInterruption(evidence, call),
        call,
      );
      if (
        retained.kind !== "committed" ||
        !["recorded", "existing"].includes(retained.value.kind) ||
        !("record" in retained.value) ||
        !sameJournalValue(retained.value.record, operation)
      )
        throw unavailable();
      await this.submitInterruption(owned, operation, call);
    });
  }

  /** Resolve an uncertain retention ACK for the same not-yet-submitted local
   * interruption. An uncertain native submission is never submitted again.
   */
  async resolveInterruption(
    input: ExactExecutionInterruptionV1,
    call: AuthorityCallV1,
  ): Promise<void> {
    const operation = parseTurnJournalV1("executionInterruption", input);
    const owned = this.owned(operation.start.intent.execution);
    await this.serial(owned, async () => {
      if (!owned.interruption || !sameJournalValue(owned.interruption, operation))
        throw unavailable();
      await this.native.assertCurrent(owned.native, "interrupt", call);
      const state = await this.journal.read(
        (j) => j.findExecutionInterruption(operation, call),
        call,
      );
      if (state.kind !== "found" || !sameJournalValue(state.interruption, operation))
        throw unavailable();
      await this.submitInterruption(owned, operation, call);
    });
  }

  private owned(execution: ExactSelectedExecutionV1): OwnedExecution {
    const owned = this.executions.get(key(execution));
    if (!owned || !sameJournalValue(owned.start.intent.execution, execution)) throw unavailable();
    return owned;
  }
  private async confirm(owned: OwnedExecution, call: AuthorityCallV1): Promise<void> {
    if (owned.confirmationAttempted || owned.interruption !== undefined) throw unavailable();
    owned.deadline.assertBeforeEffect();
    await this.native.assertCurrent(owned.native, "continue", call);
    owned.deadline.assertBeforeEffect();
    owned.confirmationAttempted = true;
    await this.native.confirmRetainedStart(owned.native, owned.start, call);
  }
  private async submitInterruption(
    owned: OwnedExecution,
    operation: ExactExecutionInterruptionV1,
    call: AuthorityCallV1,
  ): Promise<void> {
    if (owned.interruptionAttempted) throw unavailable();
    await this.native.assertCurrent(owned.native, "interrupt", call);
    owned.interruptionAttempted = true;
    await this.native.interrupt(owned.native, operation, call);
  }
  private serial(owned: OwnedExecution, work: () => Promise<void>): Promise<void> {
    const result = owned.tail.then(work);
    owned.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
