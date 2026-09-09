import {
  parseTurnJournalV1,
  type ExactExecutionInterruptionV1,
  type ExactSelectedExecutionV1,
  type JournalExecutionStartV1,
  type JournalInitiationGuardV1,
  type VerifiedConsumptionV1,
  type VerifiedExecutionInterruptionV1,
  type VerifiedExecutionStartV1,
} from "@openclaw-enterprise/contracts/turn-journal-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import { DependencyUnavailableError } from "../errors.ts";
import { sameJournalValue } from "./rows.ts";
import { TurnJournalStore } from "./store.ts";

/** An observation returned by the actual native owner. That owner must retain
 * its original connection, irrevocably ready Session/task/drain and protected
 * clock independently of this JS object's lifetime. start is data, not authority.
 */
export interface NativeReadyExecution {
  readonly start: JournalExecutionStartV1;
  readonly evidence: VerifiedExecutionStartV1;
}

/** Implemented at the original authenticated native connection. No default
 * implementation exists. The actual owner verifies original membership on each
 * call; serialized receipts, connection IDs and evidence references cannot pass.
 */
export interface NativeSelectedExecutionOwner {
  /** Consume only this original callback. Recheck guard before ready commitment
   * and after waits. Retain the entire task/drain and transfer ongoing control
   * before returning; keep all effects gated until confirmRetainedStart succeeds.
   * No pending executable queue, automatic retry or second accept is permitted.
   */
  accept(guard: JournalInitiationGuardV1, call: AuthorityCallV1): Promise<NativeReadyExecution>;
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
    return this.journal.consumeAndInitiate(
      input,
      async (_attempt, guard) => {
        if (!guard.executionIntent || this.admittedOwners >= this.maximumOwnedExecutions)
          throw unavailable();
        // Reserve before the first await, including an unknown native acceptance.
        // Without complete closure there is no slot reclamation.
        this.admittedOwners++;
        await guard.assertCurrent();
        const receipt = await this.native.accept(guard, call);
        const start = parseTurnJournalV1("executionStart", receipt.start);
        if (!sameJournalValue(start.intent, guard.executionIntent)) throw unavailable();
        const locator = key(start.intent.execution);
        if (this.executions.has(locator)) throw unavailable();
        const owned: OwnedExecution = {
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
        await this.serial(owned, async () => {
          await guard.assertCurrent();
          await this.native.assertCurrent(receipt, "continue", call);
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
      },
      call,
    );
  }

  /** Exact readback can resolve only this controller's original pending native
   * record. A process restart or a DTO without that owner cannot reopen a gate.
   */
  async resolveStart(input: ExactSelectedExecutionV1, call: AuthorityCallV1): Promise<void> {
    const execution = parseTurnJournalV1("selectedExecution", input);
    const owned = this.owned(execution);
    await this.serial(owned, async () => {
      await this.native.assertCurrent(owned.native, "continue", call);
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
    await this.native.assertCurrent(owned.native, "continue", call);
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
