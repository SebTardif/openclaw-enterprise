import type { DriverSelection } from "../../application/driver-selection.ts";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  RepositoryWorkScopeV2,
  RepositoryWorkTransactionContextV2,
} from "../../ports/repository-work-v2.ts";
import type { RepositoryWorkBackendV2, RepositoryWorkExecutionV2 } from "./repository-work-v2.ts";
import type { RepositoryWorkSelectedExecutionBackendV2 } from "./repository-work-selected-execution-v2.ts";
import { ScopeViolationError } from "../../errors.ts";
import type { WorkOriginalOperationV2 } from "../../lifecycle/work-authority-ports-v2.ts";

export interface RepositoryWorkSelectedExecutionBackendLeaseV2 {
  readonly backend: RepositoryWorkSelectedExecutionBackendV2;
  release(): Promise<void>;
}
export interface RepositoryWorkSelectedExecutionBorrowV2 extends RepositoryWorkSelectedExecutionBackendLeaseV2 {
  readonly kind: "selector" | "work";
  readonly execution: RepositoryWorkExecutionV2;
  readonly retired: Promise<void>;
  requestRetirement(): void;
  armHandoff(prepare: () => void): void;
  armWorkCompletion(complete: () => Promise<void>): void;
}
export interface RepositoryWorkSelectedExecutionUseHostV2 {
  acquire(
    context: RepositoryWorkTransactionContextV2,
    scope: RepositoryWorkScopeV2,
    call: AuthorityCallV1,
  ): RepositoryWorkSelectedExecutionBorrowV2;
}
const fail: () => never = () => {
  throw new ScopeViolationError("The original selected-use transaction is unavailable.");
};
function sameScope(a: RepositoryWorkScopeV2, b: RepositoryWorkScopeV2) {
  return (
    a.installationId === b.installationId &&
    a.namespaceId === b.namespaceId &&
    a.agentId === b.agentId &&
    a.revisionRef === b.revisionRef
  );
}
type Backend = {
  scope: RepositoryWorkScopeV2;
  execution: RepositoryWorkExecutionV2;
  active: boolean;
  select(selection: DriverSelection): RepositoryWorkSelectedExecutionBackendLeaseV2;
};
type Context = {
  backend: Backend;
  call: AuthorityCallV1;
  fixedCall: Pick<
    AuthorityCallV1,
    "context" | "requestRef" | "recipientRef" | "deadline" | "signal"
  >;
  active: boolean;
  borrowed: boolean;
  retired: Promise<void>;
  requestRetirement(): void;
  kind: "selector" | "work";
  prepareHandoff?: (() => void) | undefined;
  original?: WorkOriginalOperationV2;
  assertPreparing?: (() => void) | undefined;
  workTransfer?: Transfer | undefined;
  prefixReady?: boolean;
  completionStarted?: boolean;
  complete?: (() => Promise<void>) | undefined;
};
type Transfer = {
  source: Context;
  originals: readonly object[];
  call: AuthorityCallV1;
  active: boolean;
  consumed: boolean;
  acquire(context: RepositoryWorkTransactionContextV2): Promise<void>;
};
/** Private instance held by ONE PostgresPlatformState. Only its original enter
 * registers a backend; its original selector and Work constructors register
 * their own contexts. Exposed
 * public context fields, A/data copies and another registry cannot enroll here. */
export class RepositoryWorkSelectedExecutionContextsV2 {
  readonly #backends = new WeakMap<RepositoryWorkBackendV2, Backend>();
  readonly #contexts = new WeakMap<RepositoryWorkTransactionContextV2, Context>();
  readonly #transfers = new Set<Transfer>();
  registerBackend(
    backend: RepositoryWorkBackendV2,
    scope: RepositoryWorkScopeV2,
    execution: RepositoryWorkExecutionV2,
    select: (selection: DriverSelection) => RepositoryWorkSelectedExecutionBackendLeaseV2,
  ): () => void {
    if (this.#backends.has(backend)) fail();
    const entry: Backend = { scope: Object.freeze({ ...scope }), execution, select, active: true };
    this.#backends.set(backend, entry);
    return () => {
      entry.active = false;
      this.#backends.delete(backend);
    };
  }
  enrollContext(
    backend: RepositoryWorkBackendV2,
    execution: RepositoryWorkExecutionV2,
    context: RepositoryWorkTransactionContextV2,
    call: AuthorityCallV1,
    requestRetirement: () => void,
    retired: Promise<void>,
  ): () => void {
    const original = this.#backends.get(backend);
    if (!original?.active || original.execution !== execution || this.#contexts.has(context))
      fail();
    original.execution.phase.assertOperationActive();
    const entry: Context = {
      backend: original,
      call,
      fixedCall: Object.freeze({
        context: call.context,
        requestRef: call.requestRef,
        recipientRef: call.recipientRef,
        deadline: call.deadline,
        signal: call.signal,
      }),
      active: true,
      borrowed: false,
      requestRetirement,
      retired,
      kind: "selector",
    };
    this.#contexts.set(context, entry);
    return () => {
      entry.active = false;
      this.#contexts.delete(context);
    };
  }
  /** Called only at the actual Work constructor's source phase. A structural
   * context supplied to a public port has no entry in this private registry. */
  enrollWorkContext(
    backend: RepositoryWorkBackendV2,
    execution: RepositoryWorkExecutionV2,
    context: RepositoryWorkTransactionContextV2,
    original: WorkOriginalOperationV2,
    call: AuthorityCallV1,
    requestRetirement: () => void,
    retired: Promise<void>,
    assertPreparing: () => void,
  ): () => void {
    const dispose = this.enrollContext(
      backend,
      execution,
      context,
      call,
      requestRetirement,
      retired,
    );
    const entry = this.#contexts.get(context)!;
    entry.kind = "work";
    entry.original = original;
    entry.assertPreparing = assertPreparing;
    return dispose;
  }
  /** Retains lifetime only. The selected source invalidates outward currentness
   * before its old readset is stopped; absence of that readset never arms this. */
  prepareWorkTransfer(
    context: RepositoryWorkTransactionContextV2,
    call: AuthorityCallV1,
    originals: readonly object[],
    acquire: Transfer["acquire"],
  ): () => void {
    const source = this.#contexts.get(context);
    if (
      !source?.active ||
      !source.backend.active ||
      source.kind !== "selector" ||
      source.call !== call ||
      !source.borrowed ||
      !source.prepareHandoff ||
      originals.length === 0 ||
      originals.some((original) => !original || typeof original !== "object") ||
      [...this.#transfers].some((transfer) => transfer.source === source)
    )
      fail();
    source.backend.execution.phase.assertActive();
    source.prepareHandoff();
    const transfer: Transfer = {
      source,
      call,
      originals: Object.freeze([...originals]),
      active: true,
      consumed: false,
      acquire,
    };
    this.#transfers.add(transfer);
    return () => {
      transfer.active = false;
      this.#transfers.delete(transfer);
    };
  }
  async acquireWorkTransfer(
    context: RepositoryWorkTransactionContextV2,
    original: WorkOriginalOperationV2,
    call: AuthorityCallV1,
  ): Promise<void> {
    const entry = this.#contexts.get(context);
    if (
      !entry?.active ||
      !entry.backend.active ||
      entry.kind !== "work" ||
      entry.original !== original ||
      entry.call !== call
    )
      fail();
    entry.backend.execution.phase.assertOperationActive();
    const candidates = [...this.#transfers].filter((transfer) =>
      transfer.originals.includes(original),
    );
    if (candidates.length === 0) return;
    if (candidates.length !== 1) fail();
    const transfer = candidates[0]!;
    if (
      !transfer.active ||
      transfer.consumed ||
      transfer.call !== call ||
      !sameScope(transfer.source.backend.scope, entry.backend.scope) ||
      call.context !== transfer.source.fixedCall.context ||
      call.requestRef !== transfer.source.fixedCall.requestRef ||
      call.recipientRef !== transfer.source.fixedCall.recipientRef ||
      call.deadline !== transfer.source.fixedCall.deadline ||
      call.signal !== transfer.source.fixedCall.signal ||
      call.signal.aborted
    )
      fail();
    transfer.consumed = true;
    entry.workTransfer = transfer;
    // This early retained prefix cannot complete live A/policy/Work currentness.
    await transfer.acquire(context);
    entry.prefixReady = true;
  }
  /** Only the original Work constructor's captured prepareUse phase calls this,
   * after custody and its real parent locks on the same entered backend. */
  async completeWorkTransfer(
    context: RepositoryWorkTransactionContextV2,
    original: WorkOriginalOperationV2,
    call: AuthorityCallV1,
  ): Promise<void> {
    const entry = this.#contexts.get(context);
    if (
      !entry?.active ||
      !entry.backend.active ||
      entry.kind !== "work" ||
      entry.original !== original ||
      entry.call !== call ||
      call.context !== entry.fixedCall.context ||
      call.requestRef !== entry.fixedCall.requestRef ||
      call.recipientRef !== entry.fixedCall.recipientRef ||
      call.deadline !== entry.fixedCall.deadline ||
      call.signal !== entry.fixedCall.signal ||
      call.signal.aborted
    )
      fail();
    entry.backend.execution.phase.assertOperationActive();
    if (!entry.assertPreparing) fail();
    entry.assertPreparing();
    if (!entry.workTransfer) return;
    if (
      !entry.workTransfer.active ||
      !entry.prefixReady ||
      !entry.borrowed ||
      !entry.complete ||
      entry.completionStarted
    )
      fail();
    entry.completionStarted = true;
    await entry.complete();
  }
  forSelection(selection: DriverSelection): RepositoryWorkSelectedExecutionUseHostV2 {
    return Object.freeze({
      acquire: (
        context: RepositoryWorkTransactionContextV2,
        scope: RepositoryWorkScopeV2,
        call: AuthorityCallV1,
      ): RepositoryWorkSelectedExecutionBorrowV2 => {
        const entry = this.#contexts.get(context);
        if (
          !entry?.active ||
          !entry.backend.active ||
          entry.borrowed ||
          entry.call !== call ||
          !sameScope(entry.backend.scope, scope) ||
          call.context !== entry.fixedCall.context ||
          call.requestRef !== entry.fixedCall.requestRef ||
          call.recipientRef !== entry.fixedCall.recipientRef ||
          call.deadline !== entry.fixedCall.deadline ||
          call.signal !== entry.fixedCall.signal
        )
          fail();
        entry.backend.execution.phase.assertOperationActive();
        entry.borrowed = true;
        const held = entry.backend.select(selection);
        // The private State factory returns this lease synchronously. Capture its
        // cleanup before touching the backend, without exporting a query to callers.
        const release = held.release.bind(held);
        return Object.freeze({
          backend: held.backend,
          execution: entry.backend.execution,
          kind: entry.kind,
          retired: entry.retired,
          requestRetirement: entry.requestRetirement,
          release,
          armHandoff(prepare: () => void) {
            if (!entry.active || entry.kind !== "selector" || entry.prepareHandoff) fail();
            entry.prepareHandoff = prepare;
          },
          armWorkCompletion(complete: () => Promise<void>) {
            if (!entry.active || entry.kind !== "work" || !entry.workTransfer || entry.complete)
              fail();
            entry.complete = complete;
          },
        });
      },
    });
  }
}
