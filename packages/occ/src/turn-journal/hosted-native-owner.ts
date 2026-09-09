import {
  connectSelectedHarnessV1,
  type HostedSelectedConnectInputV1,
  type HostedSelectedHarnessV1,
  type HostedSelectedOriginalTurnV1,
  type HostedNativeReadyV1,
} from "openclaw/plugin-sdk/codex-hosted-harness";
import {
  parseTurnJournalV1,
  type AuthorizedDispatchV1,
  type ExactExecutionInterruptionV1,
  type ExactSelectedExecutionV1,
  type JournalEvidenceProvenanceV1,
  type JournalExecutionStartV1,
  type JournalDeadlineControlV1,
  type JournalInitiationGuardV1,
  type VerifiedConsumptionV1,
  type VerifiedExecutionInterruptionV1,
  type VerifiedExecutionStartV1,
} from "@openclaw-enterprise/contracts/turn-journal-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import { DependencyUnavailableError } from "../errors.ts";
import { sampleDispatchClock } from "./dispatcher-clock.ts";
import { sameJournalValue } from "./rows.ts";
import {
  SelectedExecutionController,
  type NativeReadyExecution,
  type NativeDeadlineStopOwner,
  type NativeSelectedExecutionOwner,
} from "./selected-execution.ts";
import type { TurnJournalStore } from "./store.ts";

/** Independently authenticated, currently authorized control exchanges. The actual
 * human/Agent/assignment and stop-responsibility producer must implement this port.
 * A selected TLS peer alone never manufactures an AuthorityCall or human grant.
 */
export interface HostedNativeControlSource {
  readonly signal: AbortSignal;
  acquire(
    execution: ExactSelectedExecutionV1,
    start: JournalExecutionStartV1,
    purpose: "continue" | "interrupt",
    signal: AbortSignal,
  ): Promise<AuthorityCallV1>;
  assertCurrent(
    execution: ExactSelectedExecutionV1,
    start: JournalExecutionStartV1,
    purpose: "continue" | "interrupt",
    call: AuthorityCallV1,
  ): Promise<void>;
}
interface RetainedNative {
  readonly ready: HostedNativeReadyV1;
  readonly receipt: NativeReadyExecution;
  readonly execution: ExactSelectedExecutionV1;
}
const unavailable = () => new DependencyUnavailableError("Selected native owner is unavailable.");

/** Original Node hosted harness, actual socket custody and canonical journal join.
 * connect is the only constructor; no production constructor accepts peer labels,
 * a generic service context, or a ready DTO as a substitute for an acquired socket.
 */
export class HostedNativeOwner implements NativeSelectedExecutionOwner {
  readonly evidence: Pick<
    JournalEvidenceProvenanceV1,
    "inspectExecutionStart" | "inspectExecutionInterruption"
  >;
  private journal?: TurnJournalStore;
  private controller?: SelectedExecutionController;
  private readonly claimedTurns = new WeakMap<
    JournalInitiationGuardV1,
    HostedSelectedOriginalTurnV1
  >();
  private readonly receipts = new WeakMap<NativeReadyExecution, RetainedNative>();
  private readonly starts = new WeakMap<VerifiedExecutionStartV1, RetainedNative>();
  private readonly interruptions = new WeakMap<
    VerifiedExecutionInterruptionV1,
    { retained: RetainedNative; operation: ExactExecutionInterruptionV1 }
  >();
  private submitted = false;
  private readonly harness: HostedSelectedHarnessV1;
  private readonly control: HostedNativeControlSource;

  private constructor(harness: HostedSelectedHarnessV1, control: HostedNativeControlSource) {
    this.harness = harness;
    this.control = control;
    this.evidence = Object.freeze({
      inspectExecutionStart: async (handle: VerifiedExecutionStartV1, call: AuthorityCallV1) => {
        const retained = this.starts.get(handle);
        if (!retained) return { kind: "denied" } as const;
        await this.assertCurrent(retained.receipt, "continue", call);
        return retained.receipt.start;
      },
      inspectExecutionInterruption: async (
        handle: VerifiedExecutionInterruptionV1,
        call: AuthorityCallV1,
      ) => {
        const retained = this.interruptions.get(handle);
        if (!retained) return { kind: "denied" } as const;
        await this.assertCurrent(retained.retained.receipt, "interrupt", call);
        return retained.operation;
      },
    });
  }

  static async connect(
    input: HostedSelectedConnectInputV1,
    control: HostedNativeControlSource,
  ): Promise<HostedNativeOwner> {
    if (
      !control?.signal ||
      typeof control.acquire !== "function" ||
      typeof control.assertCurrent !== "function" ||
      control.signal.aborted
    )
      throw unavailable();
    const captured = Object.freeze({
      signal: control.signal,
      acquire: control.acquire.bind(control),
      assertCurrent: control.assertCurrent.bind(control),
    });
    const harness = await connectSelectedHarnessV1(input);
    if (captured.signal.aborted) {
      harness.close();
      await harness.closed;
      throw unavailable();
    }
    return new HostedNativeOwner(harness, captured);
  }

  /** Bind the same original store whose evidence port resolves this owner's handles. */
  bindJournal(journal: TurnJournalStore): void {
    if (this.journal || this.controller) throw unavailable();
    this.journal = journal;
    this.controller = new SelectedExecutionController(journal, this, 1);
  }

  /** Exactly one canonical dispatch+consumption. Forward its original guard object
   * into the selected controller; acceptInitiation performs no second consumption.
   */
  async dispatchAndConsumeAndInitiate(
    dispatch: AuthorizedDispatchV1,
    consumption: VerifiedConsumptionV1,
    turnInput: HostedSelectedOriginalTurnV1,
    originalCall: AuthorityCallV1,
  ) {
    if (this.submitted || !this.journal || !this.controller || this.control.signal.aborted)
      throw unavailable();
    this.submitted = true;
    const turn = Object.freeze(structuredClone(turnInput));
    const call = Object.freeze({ ...originalCall });
    const controller = this.controller;
    return this.journal.dispatchAndConsumeAndInitiate(
      dispatch,
      consumption,
      async (attempt, guard) => {
        if (
          attempt.attemptRef !== turn.attemptRef ||
          attempt.conversationRef !== turn.conversationRef ||
          this.claimedTurns.has(guard)
        )
          throw unavailable();
        this.claimedTurns.set(guard, turn);
        try {
          await controller.acceptInitiation(attempt, guard, call);
        } finally {
          this.claimedTurns.delete(guard);
        }
      },
      call,
    );
  }

  async accept(
    guard: JournalInitiationGuardV1,
    call: AuthorityCallV1,
    retainDeadline: (pending: NativeDeadlineStopOwner) => Promise<JournalDeadlineControlV1>,
  ): Promise<NativeReadyExecution> {
    const turn = this.claimedTurns.get(guard);
    if (!turn || !guard.executionIntent || call.signal.aborted) throw unavailable();
    // Private original transaction membership, not structural guard inspection.
    await sampleDispatchClock(guard, call.requestRef);
    const intent = parseTurnJournalV1("executionIntent", guard.executionIntent);
    const execution = intent.execution;
    const ready = await this.harness.accept({
      intent,
      turn,
      initiation: {
        signal: guard.signal,
        assertCurrent: () => guard.assertCurrent(),
        retainDeadline: async (pending) => {
          // The canonical controller issues mandatory self-cleanup from this exact
          // original committed guard. Only the actual pending native target crosses
          // this boundary; the Node owner retains its concrete socket stop closure.
          await guard.assertCurrent();
          if (call.signal.aborted) throw unavailable();
          return retainDeadline(
            Object.freeze({
              target: pending.target,
              interrupt: (control: JournalDeadlineControlV1) => pending.interrupt(control),
            }),
          );
        },
      },
      control: {
        signal: this.control.signal,
        assertCurrent: async (purpose, rawStart, signal) => {
          const start = parseTurnJournalV1("executionStart", rawStart);
          if (!sameJournalValue(start.intent, intent) || signal.aborted) throw unavailable();
          const fresh = await this.control.acquire(execution, start, purpose, signal);
          if (signal.aborted || fresh.signal.aborted) throw unavailable();
          await this.control.assertCurrent(execution, start, purpose, fresh);
          if (signal.aborted || fresh.signal.aborted || this.control.signal.aborted)
            throw unavailable();
          const deadlineAtMs = Date.parse(fresh.deadline);
          const assertCurrent = () => {
            if (
              !Number.isFinite(deadlineAtMs) ||
              Date.now() >= deadlineAtMs ||
              signal.aborted ||
              fresh.signal.aborted ||
              this.control.signal.aborted
            )
              throw unavailable();
          };
          assertCurrent();
          return Object.freeze({ signal: fresh.signal, assertCurrent });
        },
      },
    });
    await guard.assertCurrent();
    if (call.signal.aborted) throw unavailable();
    const start = parseTurnJournalV1("executionStart", ready.start);
    if (!sameJournalValue(start.intent, intent)) throw unavailable();
    // Brand cast only wraps an actual retained socket receipt. Private map membership
    // is the provenance check; copied/serialized or foreign handles never resolve.
    const evidence = Object.freeze({}) as VerifiedExecutionStartV1;
    const receipt = Object.freeze({ start, evidence });
    const retained = Object.freeze({ ready, receipt, execution });
    this.receipts.set(receipt, retained);
    this.starts.set(evidence, retained);
    return receipt;
  }

  async assertCurrent(
    receipt: NativeReadyExecution,
    purpose: "continue" | "interrupt",
    call: AuthorityCallV1,
  ): Promise<void> {
    const retained = this.retained(receipt);
    if (call.signal.aborted || this.control.signal.aborted) throw unavailable();
    await this.control.assertCurrent(retained.execution, receipt.start, purpose, call);
    if (call.signal.aborted || this.control.signal.aborted) throw unavailable();
    await this.harness.assertCurrent(retained.ready, purpose);
    await this.control.assertCurrent(retained.execution, receipt.start, purpose, call);
    if (call.signal.aborted || this.control.signal.aborted) throw unavailable();
  }
  async confirmRetainedStart(
    receipt: NativeReadyExecution,
    start: JournalExecutionStartV1,
    call: AuthorityCallV1,
  ): Promise<void> {
    const retained = this.retained(receipt);
    if (!sameJournalValue(start, receipt.start)) throw unavailable();
    await this.assertCurrent(receipt, "continue", call);
    await this.harness.confirmRetainedStart(retained.ready, start);
    await this.assertCurrent(receipt, "continue", call);
  }
  async inspectInterruption(
    receipt: NativeReadyExecution,
    operation: ExactExecutionInterruptionV1,
    call: AuthorityCallV1,
  ): Promise<VerifiedExecutionInterruptionV1> {
    const retained = this.retained(receipt);
    const selected = parseTurnJournalV1("executionInterruption", operation);
    if (!sameJournalValue(selected.start, receipt.start)) throw unavailable();
    await this.assertCurrent(receipt, "interrupt", call);
    const observed = parseTurnJournalV1(
      "executionInterruption",
      await this.harness.inspectInterruption(retained.ready, selected),
    );
    await this.assertCurrent(receipt, "interrupt", call);
    if (!sameJournalValue(selected, observed)) throw unavailable();
    const handle = Object.freeze({}) as VerifiedExecutionInterruptionV1;
    this.interruptions.set(handle, { retained, operation: observed });
    return handle;
  }
  async interrupt(
    receipt: NativeReadyExecution,
    operation: ExactExecutionInterruptionV1,
    call: AuthorityCallV1,
  ): Promise<void> {
    const retained = this.retained(receipt);
    await this.assertCurrent(receipt, "interrupt", call);
    await this.harness.interrupt(
      retained.ready,
      parseTurnJournalV1("executionInterruption", operation),
    );
    await this.assertCurrent(receipt, "interrupt", call);
  }
  async resolveStart(execution: ExactSelectedExecutionV1, call: AuthorityCallV1): Promise<void> {
    if (!this.controller) throw unavailable();
    await this.controller.resolveStart(execution, call);
  }
  async requestInterruption(
    operation: ExactExecutionInterruptionV1,
    call: AuthorityCallV1,
  ): Promise<void> {
    if (!this.controller) throw unavailable();
    await this.controller.interrupt(operation, call);
  }
  async resolveInterruption(
    operation: ExactExecutionInterruptionV1,
    call: AuthorityCallV1,
  ): Promise<void> {
    if (!this.controller) throw unavailable();
    await this.controller.resolveInterruption(operation, call);
  }
  close(): void {
    this.harness.close();
  }
  get closed(): Promise<void> {
    return this.harness.closed;
  }
  private retained(receipt: NativeReadyExecution): RetainedNative {
    const retained = this.receipts.get(receipt);
    if (!retained) throw unavailable();
    return retained;
  }
}
