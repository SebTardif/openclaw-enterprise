import { types } from "node:util";
import { parseLifecycleAdmissionV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { LifecycleHandlerCallV1 } from "./handler-ports-v1.ts";
import type { LifecycleWorkerReadPortV1 } from "./ports-v1.ts";
import { decodeLifecycleWorkV1 } from "./work-codec-v1.ts";
import {
  lifecycleAssociationsEqualV1,
  lifecycleWorkMatchesAssociationV1,
  lifecycleWorkSnapshotPreflightV1,
  parseControllerWorkV1,
  parsePlatformOperationV1,
  parseWorkClaimV1,
  type ControllerWork,
  type LifecycleAdmissionAssociationV1,
  type PlatformOperation,
  type ReconcileAgentLifecycleV1,
} from "./work-v1.ts";

export interface LifecycleQueueSnapshotV1 {
  readonly operation: Readonly<PlatformOperation>;
  readonly work: Readonly<ControllerWork>;
}

export interface LifecycleWorkPreflightOptionsV1 {
  readonly lifecycle: LifecycleWorkerReadPortV1;
  /** Server-owned read of the exact original queue record and operation. It must
   * verify service custody and never heartbeat, claim, recover or enqueue work.
   * Missing rows are unresolved; a caller-provided snapshot is not this reader.
   */
  readonly readQueue: (
    input: ReconcileAgentLifecycleV1,
    call: AuthorityCallV1,
  ) => Promise<LifecycleQueueSnapshotV1 | null>;
  /** Resolve from the owning installation/store, never from the work payload. */
  readonly installationId: string;
  readonly now: () => Date;
  /** May tighten the canonical three-second lookup ceiling. */
  readonly maxLookupMs?: number;
}

type UnresolvedReason =
  | "head-mismatch"
  | "claim-mismatch"
  | "unsupported-transition"
  | "dependency-unavailable"
  | "cancelled"
  | "deadline-exceeded";

export type LifecycleWorkPreflightResultV1 =
  | {
      readonly kind: "snapshot-matches";
      readonly input: ReconcileAgentLifecycleV1;
      readonly association: LifecycleAdmissionAssociationV1;
    }
  | { readonly kind: "rejected"; readonly reason: "invalid-input" | "association-mismatch" }
  | {
      readonly kind: "unresolved";
      readonly reason: UnresolvedReason;
      readonly input: ReconcileAgentLifecycleV1;
      readonly association: LifecycleAdmissionAssociationV1;
    };

class Unresolved extends Error {
  readonly reason: UnresolvedReason;
  constructor(reason: UnresolvedReason) {
    super(reason);
    this.reason = reason;
  }
}

/** Fresh read-only preflight for original installed deploy work. No result is a
 * dispatch permit, effect lease, physical termination or writer-exclusion proof.
 * The worker must observe original uncertain effects before further work; every
 * receiving boundary independently checks current claim/intent/authority/fences.
 * Exact cleanup retains its separate original responsibility after supersession.
 */
export class LifecycleWorkPreflightV1 {
  private readonly options: LifecycleWorkPreflightOptionsV1;
  private readonly maxLookupMs: number;

  constructor(options: LifecycleWorkPreflightOptionsV1) {
    this.options = Object.freeze({ ...options });
    this.maxLookupMs = options.maxLookupMs ?? 3_000;
    if (!Number.isSafeInteger(this.maxLookupMs) || this.maxLookupMs < 1 || this.maxLookupMs > 3_000)
      throw new TypeError("Invalid lifecycle preflight lookup bound.");
  }

  private now(): number {
    const value = this.options.now();
    if (!types.isDate(value) || types.isProxy(value))
      throw new Unresolved("dependency-unavailable");
    const instant = Date.prototype.getTime.call(value);
    if (!Number.isFinite(instant)) throw new Unresolved("dependency-unavailable");
    return instant;
  }

  private check(call: AuthorityCallV1): number {
    if (call.signal.aborted) throw new Unresolved("cancelled");
    const deadline = Date.parse(call.deadline);
    if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== call.deadline)
      throw new Unresolved("dependency-unavailable");
    const now = this.now();
    if (deadline <= now) throw new Unresolved("deadline-exceeded");
    return Math.min(deadline, now + this.maxLookupMs);
  }

  private async read<T>(call: AuthorityCallV1, operation: (call: AuthorityCallV1) => Promise<T>) {
    const deadline = this.check(call);
    const controller = new AbortController();
    const bounded: AuthorityCallV1 = {
      context: call.context,
      requestRef: call.requestRef,
      recipientRef: call.recipientRef,
      // The authenticated context binds this original deadline. Tightening the
      // local wait must not rewrite the authenticated exchange's deadline.
      deadline: call.deadline,
      signal: controller.signal,
    };
    let refuse: (reason: UnresolvedReason) => void = () => {};
    const stop = new Promise<never>((_resolve, reject) => {
      refuse = (reason) => {
        controller.abort();
        reject(new Unresolved(reason));
      };
    });
    const cancelled = () => refuse("cancelled");
    const duration = Math.max(0, Math.min(this.maxLookupMs, deadline - this.now()));
    call.signal.addEventListener("abort", cancelled, { once: true });
    const timer = setTimeout(() => refuse("deadline-exceeded"), duration);
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          this.check(call);
          if (controller.signal.aborted || this.now() >= deadline)
            throw new Unresolved("deadline-exceeded");
          return operation(bounded);
        }),
        stop,
      ]);
      this.check(call);
      if (this.now() >= deadline) throw new Unresolved("deadline-exceeded");
      return result;
    } finally {
      clearTimeout(timer);
      call.signal.removeEventListener("abort", cancelled);
    }
  }

  async inspect(
    wire: string | Uint8Array,
    originalInput: unknown,
    callInput: LifecycleHandlerCallV1,
  ): Promise<LifecycleWorkPreflightResultV1> {
    let input: ReconcileAgentLifecycleV1;
    let original: LifecycleAdmissionAssociationV1;
    let call: LifecycleHandlerCallV1;
    try {
      input = decodeLifecycleWorkV1(wire);
      original = parseLifecycleAdmissionV1("association", originalInput);
      call = {
        context: callInput.context,
        requestRef: callInput.requestRef,
        recipientRef: callInput.recipientRef,
        deadline: callInput.deadline,
        signal: callInput.signal,
        claim: parseWorkClaimV1(callInput.claim),
      };
      if (
        !lifecycleWorkMatchesAssociationV1(input, original) ||
        original.intent.installationId !== this.options.installationId
      )
        return Object.freeze({ kind: "rejected", reason: "association-mismatch" });
    } catch {
      return Object.freeze({ kind: "rejected", reason: "invalid-input" });
    }
    try {
      const queue = await this.read(call, (bounded) => this.options.readQueue(input, bounded));
      if (queue === null) throw new Unresolved("dependency-unavailable");
      // Copy mutable Dates and validate records before the next await.
      const operation = parsePlatformOperationV1(queue.operation);
      const work = parseControllerWorkV1(queue.work);
      const retained = await this.read(call, (bounded) =>
        this.options.lifecycle.readAdmittedWork(input, bounded),
      );
      if (retained.kind !== "read") throw new Unresolved("dependency-unavailable");
      if (!lifecycleAssociationsEqualV1(original, retained.association))
        return Object.freeze({ kind: "rejected", reason: "association-mismatch" });
      const verdict = lifecycleWorkSnapshotPreflightV1(
        input,
        retained.association,
        operation,
        work,
        retained.currentIntent,
        call.claim,
        this.options.installationId,
        new Date(this.now()),
      );
      if (verdict === "association-mismatch")
        return Object.freeze({ kind: "rejected", reason: verdict });
      if (verdict !== "snapshot-matches") throw new Unresolved(verdict);
      this.check(call);
      return Object.freeze({ kind: "snapshot-matches", input, association: original });
    } catch (error) {
      return Object.freeze({
        kind: "unresolved",
        reason: error instanceof Unresolved ? error.reason : "dependency-unavailable",
        input,
        association: original,
      });
    }
  }
}
