import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseLifecycleAdmissionV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import {
  parseRuntimeAuthorityV1,
  type AuthorityCallV1,
  type ResolveAssignmentRequestV1,
  type RuntimeAssignmentAuthorityV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import {
  canonicalRuntimeEffectRequestV1,
  parseRuntimeEffectExchangeV1,
  parseRuntimeEffectsResponseV1,
  parseRuntimeEffectsV1,
  runtimeEffectEvidenceFreshV1,
  type ExactCleanupV1,
  type ExactEffectLocatorV1,
  type RuntimeEffectAdmissionV1,
  type RuntimeEffectRequestV1,
  type RuntimeEffectResultV1,
  type RuntimeEffectStateV1,
  type RuntimeEffectsV1,
  type RuntimeEvidenceProvenanceV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import type { LifecycleWorkerReadPortV1 } from "@openclaw-enterprise/occ/lifecycle/ports-v1";
import {
  lifecycleAssociationsEqualV1,
  lifecycleWorkSnapshotPreflightV1,
  parseControllerWorkV1,
  parsePlatformOperationV1,
  parseReconcileAgentLifecycleV1,
  parseWorkClaimV1,
  type ClaimedWork,
  type LifecycleAdmissionAssociationV1,
  type PlatformOperation,
  type ReconcileAgentLifecycleV1,
  type WorkClaim,
} from "@openclaw-enterprise/occ/lifecycle/work-v1";

export interface LifecycleWorkerGuardContext {
  readonly input: ReconcileAgentLifecycleV1;
  readonly original: LifecycleAdmissionAssociationV1;
  readonly operation: PlatformOperation;
  readonly work: ClaimedWork;
  readonly installationId: string;
  readonly signal: AbortSignal;
  readonly call: AuthorityCallV1;
}

type Reason =
  | "association-mismatch"
  | "head-mismatch"
  | "unsupported-transition"
  | "capability-unavailable"
  | "gate-unavailable"
  | "authority-unavailable"
  | "invalid-input"
  | "cancelled"
  | "deadline-exceeded"
  | "claim-lost"
  | "dependency-unavailable"
  | "read-original"
  | "identity-conflict"
  | "attempt-limit";

export interface LifecycleEffectObservation {
  readonly kind: "observed" | "blocked" | "unresolved";
  readonly effect: ExactEffectLocatorV1;
  readonly reason?: Reason;
  readonly observation?: RuntimeEffectStateV1;
}

export interface LifecycleEffectGuardOptions {
  readonly lifecycle: LifecycleWorkerReadPortV1;
  readonly heartbeat: (claim: WorkClaim) => Promise<ClaimedWork | undefined>;
  /** Inject the original OCC constructor; callers classify this exact identity. */
  readonly WorkClaimLostError: new () => Error;
  readonly admission?: Pick<RuntimeEffectAdmissionV1, "readGate">;
  readonly assignments?: Pick<RuntimeAssignmentAuthorityV1, "resolve">;
  readonly effects?: Pick<
    RuntimeEffectsV1,
    "create" | "setRoute" | "stopRetainingState" | "readEffect"
  >;
  readonly now: () => Date;
  /** May tighten the existing ten-second provider ceiling, never extend it. */
  readonly maxWaitMs?: number;
}

class Refused extends Error {
  readonly reason: Reason;

  constructor(reason: Reason) {
    super(reason);
    this.reason = reason;
  }
}

const lostEffects = new WeakMap<Error, LifecycleEffectObservation>();

/** Preserve possible effects without replacing the original claim-loss error. */
export function lifecycleEffectAfterClaimLoss(
  error: unknown,
): LifecycleEffectObservation | undefined {
  return error instanceof Error ? lostEffects.get(error) : undefined;
}

/**
 * One worker-run collaborator. It never completes work or persists terminality.
 * Supplied ports retain actual authority, durable effect admission and UID fences.
 * Local attempt memory prevents blind resubmission only for this instance;
 * restart recovery still reads the canonical retained effect before any new work.
 */
export class LifecycleEffectGuard {
  private readonly options: LifecycleEffectGuardOptions;
  private readonly attempted = new Map<string, string>();
  private readonly maxWaitMs: number;

  constructor(options: LifecycleEffectGuardOptions) {
    this.options = options;
    this.maxWaitMs = options.maxWaitMs ?? 10_000;
    if (!Number.isSafeInteger(this.maxWaitMs) || this.maxWaitMs < 1 || this.maxWaitMs > 10_000)
      throw new TypeError("Invalid lifecycle guard wait bound.");
  }

  private now(): Date {
    const now = this.options.now();
    if (!Number.isFinite(now.getTime())) throw new Refused("invalid-input");
    return now;
  }

  private check(call: AuthorityCallV1, signal?: AbortSignal): void {
    if (signal?.aborted) throw new this.options.WorkClaimLostError();
    if (call.signal.aborted) throw new Refused("cancelled");
    const deadline = Date.parse(call.deadline);
    if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== call.deadline)
      throw new Refused("invalid-input");
    if (deadline <= this.now().getTime()) throw new Refused("deadline-exceeded");
  }

  private async wait<T>(
    call: AuthorityCallV1,
    signal: AbortSignal | undefined,
    maximumMs: number,
    operation: (bounded: AuthorityCallV1) => Promise<T>,
  ): Promise<T> {
    this.check(call, signal);
    const startedAt = this.now().getTime();
    const deadline = Math.min(
      Date.parse(call.deadline),
      startedAt + maximumMs,
      startedAt + this.maxWaitMs,
    );
    const duration = deadline - startedAt;
    if (duration <= 0) throw new Refused("deadline-exceeded");
    const controller = new AbortController();
    // The authenticated exchange binds the original deadline exactly. Local
    // timers and checks tighten our wait without changing that authenticated boundary.
    const bounded = {
      ...call,
      signal: controller.signal,
    };
    let rejectAbort: (error: Error) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abort = (error: Error) => {
      controller.abort(error);
      rejectAbort(error);
    };
    const lost = () => abort(new this.options.WorkClaimLostError());
    const cancelled = () => abort(new Refused("cancelled"));
    signal?.addEventListener("abort", lost, { once: true });
    call.signal.addEventListener("abort", cancelled, { once: true });
    const timer = setTimeout(() => abort(new Refused("deadline-exceeded")), duration);
    try {
      this.check(call, signal);
      // Race bounds only our wait. A peer may still finish; its original effect
      // remains unresolved and no timer/abort proves provider cancellation.
      const value = await Promise.race([
        Promise.resolve().then(() => {
          this.check(call, signal);
          if (this.now().getTime() >= deadline) throw new Refused("deadline-exceeded");
          if (controller.signal.aborted) throw controller.signal.reason;
          return operation(bounded);
        }),
        aborted,
      ]);
      this.check(call, signal);
      if (this.now().getTime() >= deadline) throw new Refused("deadline-exceeded");
      return value;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", lost);
      call.signal.removeEventListener("abort", cancelled);
    }
  }

  private request(input: RuntimeEffectRequestV1): RuntimeEffectRequestV1 {
    const request = parseRuntimeEffectsV1("effectRequest", input);
    const digest = `sha256:${createHash("sha256").update(canonicalRuntimeEffectRequestV1(request)).digest("hex")}`;
    if (request.effect.requestDigest !== digest) throw new Refused("invalid-input");
    return request;
  }

  private targetMatches(
    request: RuntimeEffectRequestV1,
    original: LifecycleAdmissionAssociationV1,
  ): boolean {
    const target = request.effect.target;
    const intent = original.intent;
    return (
      target.installationId === intent.installationId &&
      target.namespaceId === intent.namespaceId &&
      target.agentId === intent.agentId &&
      target.revisionId === intent.revisionId &&
      target.lifecycleGeneration === intent.generation
    );
  }

  private attempt(request: RuntimeEffectRequestV1): void {
    const target = request.effect.target;
    const key = JSON.stringify([
      target.installationId,
      target.namespaceId,
      target.agentId,
      request.effect.effectRef,
    ]);
    const bytes = canonicalRuntimeEffectRequestV1(request);
    const previous = this.attempted.get(key);
    if (previous !== undefined)
      throw new Refused(previous === bytes ? "read-original" : "identity-conflict");
    if (this.attempted.size >= 256) throw new Refused("attempt-limit");
    this.attempted.set(key, bytes);
  }

  private async gate(
    request: RuntimeEffectRequestV1,
    call: AuthorityCallV1,
    signal?: AbortSignal,
  ): Promise<RuntimeEvidenceProvenanceV1> {
    const admission = this.options.admission;
    if (!admission) throw new Refused("capability-unavailable");
    const gate = parseRuntimeEffectsV1(
      "gateState",
      await this.wait(call, signal, 3_000, (bounded) => admission.readGate(request.gate, bounded)),
    );
    if (
      gate.status !== "observed" ||
      gate.authority !== "current" ||
      !isDeepStrictEqual(gate.guard, request.gate) ||
      !isDeepStrictEqual(gate.plan, request.plan) ||
      !runtimeEffectEvidenceFreshV1(gate.evidence, this.now().toISOString(), null) ||
      (request.effect.responsibility.kind === "preparation"
        ? gate.ordinaryAdmission
        : gate.sealerAdmission) !== "open"
    )
      throw new Refused("gate-unavailable");
    return gate.evidence;
  }

  private checkGateEvidence(evidence: RuntimeEvidenceProvenanceV1): void {
    if (!runtimeEffectEvidenceFreshV1(evidence, this.now().toISOString(), null))
      throw new Refused("gate-unavailable");
  }

  /** Running checks deliberately do not apply to the separate cleanup method. */
  async run(
    context: LifecycleWorkerGuardContext,
    input: RuntimeEffectRequestV1,
  ): Promise<LifecycleEffectObservation> {
    const request = this.request(input);
    let submitted = false;
    let observation: RuntimeEffectResultV1 | undefined;
    try {
      this.check(context.call, context.signal);
      const original = parseLifecycleAdmissionV1("association", context.original);
      const workInput = parseReconcileAgentLifecycleV1(context.input);
      const operation = parsePlatformOperationV1(context.operation);
      const claim = parseWorkClaimV1({
        idempotencyKey: context.work.idempotencyKey,
        claimToken: context.work.claimToken,
      });
      let work = parseControllerWorkV1(context.work);
      if (
        !this.targetMatches(request, original) ||
        request.gate.intentRef !== original.intent.transitionRef ||
        request.gate.lifecycleGeneration !== original.intent.generation
      )
        throw new Refused("association-mismatch");
      if (
        original.request.kind !== "deploy" ||
        original.intent.desiredMode !== "running" ||
        request.gate.mode !== "running" ||
        request.effect.responsibility.kind !== "preparation" ||
        (request.kind !== "create" &&
          (request.kind !== "set-route" || request.desiredRoute.kind !== "active"))
      )
        throw new Refused("unsupported-transition");
      const read = async () => {
        const retained = await this.wait(context.call, context.signal, 3_000, (bounded) =>
          this.options.lifecycle.readAdmittedWork(workInput, bounded),
        );
        if (retained.kind !== "read") throw new Refused("dependency-unavailable");
        if (!lifecycleAssociationsEqualV1(original, retained.association))
          throw new Refused("association-mismatch");
        const verdict = lifecycleWorkSnapshotPreflightV1(
          workInput,
          retained.association,
          operation,
          work,
          retained.currentIntent,
          claim,
          context.installationId,
          this.now(),
        );
        if (verdict === "claim-mismatch") throw new this.options.WorkClaimLostError();
        if (verdict !== "snapshot-matches") throw new Refused(verdict);
      };
      const checkpoint = async () => {
        await read();
        this.check(context.call, context.signal);
        const renewed = await this.wait(context.call, context.signal, 3_000, () =>
          this.options.heartbeat(claim),
        );
        if (!renewed) throw new this.options.WorkClaimLostError();
        work = parseControllerWorkV1(renewed);
        if (
          work.state !== "claimed" ||
          work.idempotencyKey !== claim.idempotencyKey ||
          work.claimToken !== claim.claimToken
        )
          throw new this.options.WorkClaimLostError();
        await read();
      };
      await checkpoint();
      const gateEvidence = await this.gate(request, context.call, context.signal);
      await read();
      const effects = this.options.effects;
      if (!effects) throw new Refused("capability-unavailable");
      const result = await this.wait(context.call, context.signal, 10_000, (bounded) => {
        this.checkGateEvidence(gateEvidence);
        this.attempt(request);
        submitted = true;
        return request.kind === "create"
          ? effects.create(request, bounded)
          : effects.setRoute(request, bounded);
      });
      observation = parseRuntimeEffectExchangeV1(request, result);
      await checkpoint();
      const finalGateEvidence = await this.gate(request, context.call, context.signal);
      await read();
      this.checkGateEvidence(finalGateEvidence);
      return this.result(request.effect, observation);
    } catch (error) {
      return this.failure(error, request.effect, submitted, observation);
    }
  }

  /** Exact retained cleanup has its own service context and deadline, independent
   * of old worker cancellation and human grants. No unbound-object cleanup or
   * candidate terminality is invented here; their original owners retain them.
   */
  async cleanup(
    originalInput: LifecycleAdmissionAssociationV1,
    input: ExactCleanupV1,
    authorityInput: Extract<ResolveAssignmentRequestV1, { purpose: "cleanup" }>,
    call: AuthorityCallV1,
  ): Promise<LifecycleEffectObservation> {
    const request = this.request(input);
    let submitted = false;
    let observation: RuntimeEffectResultV1 | undefined;
    try {
      const original = parseLifecycleAdmissionV1("association", originalInput);
      const authority = parseRuntimeAuthorityV1("resolveRequest", authorityInput);
      if (
        request.kind !== "stop-retaining-state" ||
        authority.purpose !== "cleanup" ||
        !this.targetMatches(request, original) ||
        authority.installationId !== original.intent.installationId ||
        authority.namespaceId !== original.intent.namespaceId ||
        authority.agentId !== original.intent.agentId ||
        !isDeepStrictEqual(authority.assignmentRef, request.effect.target.assignmentRef) ||
        authority.operationRef !== request.effect.responsibility.responsibilityRef ||
        authority.expectedResponsibilityVersion !==
          request.effect.responsibility.responsibilityVersion ||
        authority.requestedOperation !==
          (request.providerTarget.apiKind === "Deployment" ? "terminate-instance" : "remove-route")
      )
        throw new Refused("association-mismatch");
      const assignments = this.options.assignments;
      const effects = this.options.effects;
      if (!assignments || !effects) throw new Refused("capability-unavailable");
      const authorize = async () => {
        const value = parseRuntimeAuthorityV1(
          "resolveResult",
          await this.wait(call, undefined, 3_000, (bounded) =>
            assignments.resolve(authority, bounded),
          ),
        );
        if (
          value.result !== "cleanup-eligible" ||
          !("snapshot" in value) ||
          value.requestRef !== authority.requestRef ||
          value.operationRef !== authority.operationRef ||
          value.responsibilityVersion !== authority.expectedResponsibilityVersion ||
          value.allowedOperation !== authority.requestedOperation ||
          !isDeepStrictEqual(value.snapshot.target, request.effect.target) ||
          !isDeepStrictEqual(value.snapshot.binding, request.binding) ||
          Date.parse(value.validUntil) <= this.now().getTime() ||
          Date.parse(value.evaluatedAt) > this.now().getTime() + 2_000
        )
          throw new Refused("authority-unavailable");
        return Date.parse(value.validUntil);
      };
      await this.gate(request, call);
      const authorityUntil = await authorize();
      const gateEvidence = await this.gate(request, call);
      const result = await this.wait(call, undefined, 10_000, (bounded) => {
        if (this.now().getTime() >= authorityUntil) throw new Refused("authority-unavailable");
        this.checkGateEvidence(gateEvidence);
        this.attempt(request);
        submitted = true;
        return effects.stopRetainingState(request, bounded);
      });
      observation = parseRuntimeEffectExchangeV1(request, result);
      const finalAuthorityUntil = await authorize();
      const finalGateEvidence = await this.gate(request, call);
      if (this.now().getTime() >= finalAuthorityUntil) throw new Refused("authority-unavailable");
      this.checkGateEvidence(finalGateEvidence);
      return this.result(request.effect, observation);
    } catch (error) {
      return this.failure(error, request.effect, submitted, observation);
    }
  }

  /** Read-only recovery retains the complete original locator after head/claim loss. */
  async readOriginal(
    input: ExactEffectLocatorV1,
    call: AuthorityCallV1,
  ): Promise<LifecycleEffectObservation> {
    const effect = parseRuntimeEffectsV1("effectLocator", input);
    try {
      const effects = this.options.effects;
      if (!effects) throw new Refused("capability-unavailable");
      const result = parseRuntimeEffectsResponseV1(
        "readEffect",
        effect,
        await this.wait(call, undefined, 3_000, (bounded) => effects.readEffect(effect, bounded)),
      );
      return this.result(effect, result);
    } catch (error) {
      return this.failure(error, effect, true);
    }
  }

  private result(
    effect: ExactEffectLocatorV1,
    observation: RuntimeEffectStateV1,
  ): LifecycleEffectObservation {
    if (observation.status === "unknown" || observation.status === "not-found")
      return Object.freeze({ kind: "unresolved", effect, observation });
    if (observation.status === "unsupported")
      return Object.freeze({ kind: "blocked", effect, observation });
    return Object.freeze({ kind: "observed", effect, observation });
  }

  private failure(
    error: unknown,
    effect: ExactEffectLocatorV1,
    submitted: boolean,
    observation?: RuntimeEffectStateV1,
  ): LifecycleEffectObservation {
    let reason: Reason = "dependency-unavailable";
    if (error instanceof this.options.WorkClaimLostError) reason = "claim-lost";
    else if (error instanceof Refused) reason = error.reason;
    const outcome: LifecycleEffectObservation = Object.freeze({
      kind: submitted || reason === "read-original" ? "unresolved" : "blocked",
      effect,
      reason,
      ...(observation === undefined ? {} : { observation }),
    });
    if (error instanceof this.options.WorkClaimLostError) {
      if (submitted) lostEffects.set(error, outcome);
      throw error;
    }
    return outcome;
  }
}
