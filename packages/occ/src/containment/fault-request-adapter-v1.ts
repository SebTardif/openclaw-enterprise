import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import {
  canonicalRuntimeFaultRequestV1,
  parseRuntimeEffectsResponseV1,
  parseRuntimeEffectsV1,
  RUNTIME_EFFECT_LIMITS_V1,
  type DurableCleanupRequestStateV1,
  type ExactRuntimeFaultV1,
  type RuntimeFaultSinkV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import { sha256Hex } from "@openclaw-enterprise/utils";

/** Trusted local scheduling dependency, not a clock taken from evidence. The
 * scheduler returns an idempotent cancellation function and must fire by delayMs.
 */
export interface ContainmentFaultClockV1 {
  readonly wallNowMs: () => number;
  readonly monotonicNowMs: () => number;
  readonly schedule: (delayMs: number, callback: () => void) => () => void;
}

export interface ContainmentFaultRequestAdapterOptionsV1 {
  readonly sink: RuntimeFaultSinkV1;
  readonly clock: ContainmentFaultClockV1;
  readonly maxSubmitMs?: number;
  readonly maxReadbackMs?: number;
}

/** Resolved by the original accepting owner. In particular cause is original
 * Runtime evidence (including its execution binding), or original authority loss;
 * a containment finding cannot be converted into either. Equality authenticates
 * nothing; the sink must independently verify current authority and ownership.
 */
export type ContainmentFaultExpectedV1 = Pick<
  ExactRuntimeFaultV1,
  "target" | "guard" | "cleanupResponsibility" | "cause"
>;

export interface ContainmentFaultContinuationV1 {
  readonly scope: "fault-request-adapter-only";
  readonly fault: ExactRuntimeFaultV1;
  readonly canonicalRequestJson: string;
  readonly phase: "submit-allowed" | "readback-only" | "resolved";
}

type LocalReason =
  | "invalid-input"
  | "fault-input-unavailable"
  | "readback-required"
  | "already-resolved"
  | "cancelled"
  | "deadline-exceeded"
  | "clock-unavailable"
  | "dependency-unavailable"
  | "response-mismatch";

interface Denied {
  readonly scope: "fault-request-adapter-only";
  readonly admission: "denied";
  readonly downstreamStop: "not-proved";
}

export type ContainmentFaultPreparationV1 =
  | (Denied & {
      readonly status: "prepared";
      readonly continuation: ContainmentFaultContinuationV1;
    })
  | (Denied & { readonly status: "rejected"; readonly reason: LocalReason });

export type ContainmentFaultAttemptV1 = Denied &
  (
    | { readonly status: "rejected"; readonly reason: LocalReason }
    | {
        readonly status: "not-invoked" | "commit-unknown";
        readonly reason: LocalReason;
        readonly continuation: ContainmentFaultContinuationV1;
      }
    | {
        readonly status: DurableCleanupRequestStateV1["status"];
        readonly result: DurableCleanupRequestStateV1;
        readonly continuation: ContainmentFaultContinuationV1;
      }
  );

const denied = {
  scope: "fault-request-adapter-only",
  admission: "denied",
  downstreamStop: "not-proved",
} as const;

class LocalFailure extends Error {
  readonly reason: LocalReason;
  constructor(reason: LocalReason) {
    super(reason);
    this.reason = reason;
  }
}

function exactFault(input: unknown) {
  const fault = parseRuntimeEffectsV1("fault", input);
  const canonicalRequestJson = canonicalRuntimeFaultRequestV1(fault);
  if (
    new TextEncoder().encode(canonicalRequestJson).byteLength >
      RUNTIME_EFFECT_LIMITS_V1.maxCanonicalRequestBytes ||
    fault.operation.requestDigest !== `sha256:${sha256Hex(canonicalRequestJson)}`
  )
    throw new LocalFailure("invalid-input");
  return { fault, canonicalRequestJson };
}

function retain(
  exact: ReturnType<typeof exactFault>,
  phase: ContainmentFaultContinuationV1["phase"],
): ContainmentFaultContinuationV1 {
  return Object.freeze({ scope: denied.scope, ...exact, phase });
}

/** Finite forwarding adapter: no journal, authority, IDs, retries or physical
 * effects of its own. The owner must serialize attempts and retain the latest
 * continuation under its existing protected responsibility. Replaying an older
 * continuation is not a submission grant; this value is not a durable authority.
 * Every invocation makes at most one call to the original sink. A cancellation
 * after invocation cannot establish that the remote mutation did not commit.
 */
export class ContainmentFaultRequestAdapterV1 {
  private readonly sink: RuntimeFaultSinkV1;
  private readonly clock: ContainmentFaultClockV1;
  private readonly maxSubmitMs: number;
  private readonly maxReadbackMs: number;

  constructor(options: ContainmentFaultRequestAdapterOptionsV1) {
    this.sink = options.sink;
    this.clock = Object.freeze({ ...options.clock });
    this.maxSubmitMs = options.maxSubmitMs ?? RUNTIME_EFFECT_LIMITS_V1.providerRequestMaxMs;
    this.maxReadbackMs = options.maxReadbackMs ?? RUNTIME_EFFECT_LIMITS_V1.authorityReadMaxMs;
    for (const [value, ceiling] of [
      [this.maxSubmitMs, RUNTIME_EFFECT_LIMITS_V1.providerRequestMaxMs],
      [this.maxReadbackMs, RUNTIME_EFFECT_LIMITS_V1.authorityReadMaxMs],
    ])
      if (!Number.isSafeInteger(value) || value! < 1 || value! > ceiling!)
        throw new TypeError("Invalid containment fault wait bound.");
  }

  prepare(input: unknown, expected: ContainmentFaultExpectedV1): ContainmentFaultPreparationV1 {
    if (input === null || input === undefined)
      return Object.freeze({ ...denied, status: "rejected", reason: "fault-input-unavailable" });
    try {
      const exact = exactFault(input);
      const comparison = parseRuntimeEffectsV1("fault", {
        ...exact.fault,
        target: expected.target,
        guard: expected.guard,
        cleanupResponsibility: expected.cleanupResponsibility,
        cause: expected.cause,
      });
      if (canonicalRuntimeFaultRequestV1(comparison) !== exact.canonicalRequestJson)
        throw new LocalFailure("invalid-input");
      return Object.freeze({
        ...denied,
        status: "prepared",
        continuation: retain(exact, "submit-allowed"),
      });
    } catch {
      return Object.freeze({ ...denied, status: "rejected", reason: "invalid-input" });
    }
  }

  submit(
    continuation: ContainmentFaultContinuationV1,
    call: AuthorityCallV1,
  ): Promise<ContainmentFaultAttemptV1> {
    return this.attempt("submit", continuation, call);
  }

  readback(
    continuation: ContainmentFaultContinuationV1,
    call: AuthorityCallV1,
  ): Promise<ContainmentFaultAttemptV1> {
    return this.attempt("readback", continuation, call);
  }

  private sample() {
    const wall = this.clock.wallNowMs();
    const monotonic = this.clock.monotonicNowMs();
    if (!Number.isFinite(wall) || !Number.isFinite(monotonic) || wall < 0 || monotonic < 0)
      throw new LocalFailure("clock-unavailable");
    return { wall, monotonic };
  }

  private async attempt(
    method: "submit" | "readback",
    input: ContainmentFaultContinuationV1,
    originalCall: AuthorityCallV1,
  ): Promise<ContainmentFaultAttemptV1> {
    let continuation: ContainmentFaultContinuationV1;
    try {
      const exact = exactFault(input.fault);
      if (
        input.scope !== denied.scope ||
        exact.canonicalRequestJson !== input.canonicalRequestJson ||
        !["submit-allowed", "readback-only", "resolved"].includes(input.phase)
      )
        throw new LocalFailure("invalid-input");
      continuation = retain(exact, input.phase);
      if (continuation.phase === "resolved") throw new LocalFailure("already-resolved");
      if (method === "submit" && continuation.phase !== "submit-allowed")
        throw new LocalFailure("readback-required");
    } catch (error) {
      return Object.freeze({
        ...denied,
        status: "rejected",
        reason: error instanceof LocalFailure ? error.reason : "invalid-input",
      });
    }

    let invoked = false;
    let cancelTimer = () => {};
    let removeListener = () => {};
    const controller = new AbortController();
    try {
      // Snapshot only the original exchange fields; never mint context or rewrite
      // its authenticated deadline to the shorter local wait.
      const call: AuthorityCallV1 = Object.freeze({
        context: originalCall.context,
        requestRef: originalCall.requestRef,
        recipientRef: originalCall.recipientRef,
        deadline: originalCall.deadline,
        signal: originalCall.signal,
      });
      const deadline = Date.parse(call.deadline);
      if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== call.deadline)
        throw new LocalFailure("invalid-input");
      const start = this.sample();
      const ceiling = method === "submit" ? this.maxSubmitMs : this.maxReadbackMs;
      const duration = Math.min(ceiling, deadline - start.wall);
      let previous = start;
      const check = () => {
        if (call.signal.aborted) throw new LocalFailure("cancelled");
        const current = this.sample();
        if (current.wall < previous.wall || current.monotonic < previous.monotonic)
          throw new LocalFailure("clock-unavailable");
        previous = current;
        if (
          current.wall >= deadline ||
          current.wall - start.wall >= duration ||
          current.monotonic - start.monotonic >= duration ||
          controller.signal.aborted
        )
          throw new LocalFailure("deadline-exceeded");
      };
      check();
      const bounded: AuthorityCallV1 = Object.freeze({ ...call, signal: controller.signal });
      let stop = (_reason: LocalReason) => {};
      const stopped = new Promise<never>((_resolve, reject) => {
        stop = (reason) => {
          controller.abort();
          reject(new LocalFailure(reason));
        };
      });
      const onAbort = () => stop("cancelled");
      call.signal.addEventListener("abort", onAbort, { once: true });
      removeListener = () => call.signal.removeEventListener("abort", onAbort);
      // Arm the race before invoking the scheduler, including immediate callbacks.
      const pending = Promise.resolve().then(() => {
        check();
        invoked = true;
        if (method === "submit")
          return this.sink.recordFaultAndRequestStop(continuation.fault, bounded);
        return this.sink.readRequest(continuation.fault.operation, bounded);
      });
      const raced = Promise.race([pending, stopped]);
      try {
        cancelTimer = this.clock.schedule(duration, () => stop("deadline-exceeded"));
      } catch {
        stop("dependency-unavailable");
      }
      const response = await raced;
      check();
      let result: DurableCleanupRequestStateV1;
      try {
        result = parseRuntimeEffectsResponseV1(
          method === "submit" ? "recordFaultAndRequestStop" : "readRequest",
          method === "submit" ? continuation.fault : continuation.fault.operation,
          response,
        );
        // readRequest's original locator check alone does not bind receipt.fault.
        // Apply the original full-request comparison as well, including its digest.
        if ("receipt" in result) {
          parseRuntimeEffectsResponseV1("recordFaultAndRequestStop", continuation.fault, result);
          if (
            canonicalRuntimeFaultRequestV1(result.receipt.fault) !==
            continuation.canonicalRequestJson
          )
            throw new LocalFailure("response-mismatch");
        }
      } catch {
        throw new LocalFailure("response-mismatch");
      }
      check();
      const resolved =
        result.status === "accepted" ||
        result.status === "exact-replay" ||
        result.status === "conflict";
      return Object.freeze({
        ...denied,
        status: result.status,
        result,
        continuation: retain(continuation, resolved ? "resolved" : "readback-only"),
      });
    } catch (error) {
      return Object.freeze({
        ...denied,
        status:
          invoked || continuation.phase === "readback-only" ? "commit-unknown" : "not-invoked",
        reason: error instanceof LocalFailure ? error.reason : "dependency-unavailable",
        continuation: retain(continuation, invoked ? "readback-only" : continuation.phase),
      });
    } finally {
      // Ending a local wait is not evidence of remote rollback or downstream stop.
      controller.abort();
      try {
        cancelTimer();
      } catch {
        /* Best-effort disposal cannot change commit truth. */
      }
      try {
        removeListener();
      } catch {
        /* The original trusted signal owns its listener. */
      }
    }
  }
}
