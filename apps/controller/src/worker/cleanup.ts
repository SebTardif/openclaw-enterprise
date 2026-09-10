import type {
  AgentRevision,
  ComputeDriver,
  ComputeRevisionContext,
} from "@openclaw-enterprise/contracts";
import type { LeasedEffects, WorkerClaimContext } from "./leased-effect.ts";
import type { WorkerRevisionCurrentness } from "./revision-currentness.ts";
import type { RevisionDispatchResult } from "./runner.ts";
import { isDeepStrictEqual } from "node:util";
import { parseLifecycleAdmissionV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type {
  AuthorityCallV1,
  ResolveAssignmentRequestV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import {
  parseRuntimeEffectsV1,
  type ExactCleanupV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import type { PlatformReadView, PostgresWorkQueue } from "@openclaw-enterprise/occ";
import type { LifecycleAdmissionAssociationV1 } from "@openclaw-enterprise/occ/lifecycle/work-v1";
import {
  lifecycleEffectAfterClaimLoss,
  type LifecycleEffectGuard,
  type LifecycleEffectObservation,
} from "./lifecycle-effect-guard.ts";

export interface WorkerRevisionCleanupOptions {
  readonly compute: Pick<
    ComputeDriver,
    | "activateRevision"
    | "deactivateRevision"
    | "activationOrder"
    | "prepareRevision"
    | "retireRevision"
  >;
  readonly effects: Pick<LeasedEffects, "run" | "runRevision">;
  readonly mode: "development" | "production";
  readonly maintenanceIntervalMs: number | undefined;
  readonly listRevisions: (
    namespaceId: string,
    agentId: string,
  ) => Promise<readonly Readonly<AgentRevision>[]>;
  readonly validObservation: (value: unknown, revision: Readonly<AgentRevision>) => boolean;
}

/** Performs the existing staged effects; queue and publication remain with finalization. */
export class WorkerRevisionCleanup {
  private readonly options: WorkerRevisionCleanupOptions;

  constructor(options: WorkerRevisionCleanupOptions) {
    this.options = options;
  }

  /** Called inside the caller's existing leased effect scope. */
  async stage(
    operation: "activateRevision" | "deactivateRevision",
    revision: Readonly<AgentRevision>,
    context?: ComputeRevisionContext,
  ): Promise<void> {
    const compute = this.options.compute;
    const stage = compute[operation];
    if (typeof stage !== "function") {
      throw new Error(`The selected production Compute Driver requires ${operation}.`);
    }
    await stage.call(compute, revision, context);
  }

  async afterActivation(
    execution: WorkerClaimContext,
    activated: Readonly<AgentRevision>,
    result: RevisionDispatchResult,
    currentness: WorkerRevisionCurrentness,
  ): Promise<void> {
    const { compute, effects, mode } = this.options;
    if (mode === "production" && compute.activationOrder !== "beforeCommit") {
      await effects.runRevision(execution, currentness, () =>
        this.stage("activateRevision", activated, result.context),
      );
    }
    if (result.previous !== undefined) {
      await effects.run(execution, () => compute.retireRevision(result.previous!));
    }
  }

  async reconcileActive(
    execution: WorkerClaimContext,
    revision: Readonly<AgentRevision>,
    context: ComputeRevisionContext,
    currentness: WorkerRevisionCurrentness,
  ): Promise<RevisionDispatchResult | undefined> {
    const { compute, effects, mode } = this.options;
    if (this.options.maintenanceIntervalMs !== undefined) {
      const observation = await effects.runRevision(execution, currentness, () =>
        compute.prepareRevision(revision, context),
      );
      if (!this.options.validObservation(observation, revision)) {
        return { outcome: "permanent", code: "INVALID_DRIVER_OBSERVATION" };
      }
      if (!observation.ready) {
        return { outcome: "pending", code: "REVISION_INCOMPLETE" };
      }
    }
    if (mode === "production") {
      await effects.runRevision(execution, currentness, () =>
        this.stage("activateRevision", revision, context),
      );
    }
    const earlier = (
      await this.options.listRevisions(revision.namespaceId, revision.agentId)
    ).filter((candidate) => candidate.revision < revision.revision);
    for (const previous of earlier) {
      await effects.run(execution, () => compute.retireRevision(previous));
    }
    return undefined;
  }
}

type RuntimeCleanupRead = NonNullable<PlatformReadView["runtimeEffectAdmission"]>;

export type RuntimeCleanupWorkerInput = (
  | {
      readonly kind: "profile";
      readonly claimed: NonNullable<Awaited<ReturnType<PostgresWorkQueue["claimRuntimeProfile"]>>>;
      readonly retained: NonNullable<Awaited<ReturnType<RuntimeCleanupRead["findProfileClosure"]>>>;
    }
  | {
      readonly kind: "fault";
      readonly claimed: NonNullable<Awaited<ReturnType<PostgresWorkQueue["claimRuntimeFault"]>>>;
      readonly retained: NonNullable<Awaited<ReturnType<RuntimeCleanupRead["findFaultRequest"]>>>;
    }
) & { readonly signal: AbortSignal };

/** Operands supplied inside the original service/State cleanup owner. These
 * values name retained work; their shape is never a permission or a new issuer.
 * The source selects exact readback after uncertain submission or restart. A
 * not-found/unknown read cannot be converted into another submission here. */
export interface RuntimeCleanupWorkerInvocation {
  readonly mode: "stop-original" | "read-original";
  readonly original: LifecycleAdmissionAssociationV1;
  readonly request: ExactCleanupV1;
  readonly authority: Extract<ResolveAssignmentRequestV1, { purpose: "cleanup" }>;
  readonly call: AuthorityCallV1;
}

/** Integration requirement for the original accepting owner, not an authority
 * implementation. It must authenticate the exact live claim and independent
 * cleanup responsibility, retain the original provider operands before any
 * possible effect, and keep the callback/current service context alive until
 * the callback settles. Human revoke does not discard that responsibility.
 *
 * This source owns fresh service calls, bounded source waits, durable outcome
 * retention and current-generation publication. It must retain every possible
 * child/create/native task and drain across cancellation/restart; the single
 * selected effect below cannot establish complete physical settlement. Any
 * callback attempted after return is refused without invoking the guard.
 * No production implementation or registration is supplied by this interface. */
export interface RuntimeCleanupWorkerSource {
  withCleanup(
    input: RuntimeCleanupWorkerInput,
    consume: (invocation: RuntimeCleanupWorkerInvocation) => Promise<LifecycleEffectObservation>,
  ): Promise<void>;
}

/** One original cleanup effect per claim. This collaborator never issues
 * authority, prepares an effect, advances/completes a fence, or completes work.
 * Existing RuntimeEffects/CTL-42 guard owners still accept every real operation.
 * An observed API effect is not a native task/child/drain termination claim. */
export class RuntimeCleanupWorker {
  private readonly source: RuntimeCleanupWorkerSource;
  private readonly guard: Pick<LifecycleEffectGuard, "cleanup" | "readOriginal">;

  constructor(options: {
    readonly source: RuntimeCleanupWorkerSource;
    readonly guard: Pick<LifecycleEffectGuard, "cleanup" | "readOriginal">;
  }) {
    this.source = options.source;
    this.guard = options.guard;
  }

  async run(input: RuntimeCleanupWorkerInput): Promise<LifecycleEffectObservation | undefined> {
    const work = input.claimed.work;
    const expiresAt = input.claimed.leaseExpiresAt.getTime();
    // These local refusal checks do not renew or authenticate a queue lease.
    const eligible = () =>
      !input.signal.aborted && Number.isFinite(expiresAt) && Date.now() < expiresAt;
    if (!eligible() || !isDeepStrictEqual(input.retained.work, work)) return undefined;
    const state: {
      active: boolean;
      called: boolean;
      failed: boolean;
      pending?: Promise<LifecycleEffectObservation>;
      observation?: LifecycleEffectObservation;
      effect?: ExactCleanupV1["effect"];
    } = { active: true, called: false, failed: false };
    const refuse = (): never => {
      state.failed = true;
      throw new Error("The original runtime cleanup invocation is unavailable.");
    };
    try {
      await this.source.withCleanup(input, (invocation) => {
        if (!state.active || state.called || !eligible()) return refuse();
        state.called = true;
        const original = parseLifecycleAdmissionV1("association", invocation.original);
        const request = parseRuntimeEffectsV1("stopRetainingState", invocation.request);
        const closed = parseRuntimeEffectsV1("gateGuard", input.retained.closedGuard);
        const intent = original.intent;
        const { mode, call, authority } = invocation;
        if (
          (mode !== "stop-original" && mode !== "read-original") ||
          intent.installationId !== work.installationId ||
          intent.namespaceId !== work.namespaceId ||
          intent.agentId !== work.agentId ||
          intent.transitionRef !== work.intentRef ||
          intent.generation !== work.lifecycleGeneration ||
          !isDeepStrictEqual(request.gate, closed) ||
          request.gate.intentRef !== work.intentRef ||
          request.gate.lifecycleGeneration !== work.lifecycleGeneration ||
          request.gate.gateVersion !== work.gateVersion ||
          request.gate.requestedFenceEpoch !== work.requestedFenceEpoch ||
          request.effect.target.installationId !== work.installationId ||
          request.effect.target.namespaceId !== work.namespaceId ||
          request.effect.target.agentId !== work.agentId ||
          request.effect.target.revisionId !== intent.revisionId ||
          request.effect.target.lifecycleGeneration !== work.lifecycleGeneration ||
          request.effect.responsibility.kind === "preparation" ||
          request.effect.responsibility.responsibilityRef !== work.responsibilityRef ||
          request.effect.responsibility.responsibilityVersion !== work.responsibilityVersion
        )
          return refuse();
        state.effect = request.effect;
        const pending = (async () => {
          if (!state.active || !eligible()) return refuse();
          // Preserve the actual call/context object. No new deadline, human
          // authorization, copied service context or worker-derived permit.
          let observation: LifecycleEffectObservation;
          try {
            observation =
              mode === "read-original"
                ? await this.guard.readOriginal(request.effect, call)
                : await this.guard.cleanup(original, request, authority, call);
          } catch (error) {
            // The original guard can throw claim loss after retaining an
            // observed receipt. Preserve that exact effect without replacing
            // the error delivered to its original source or resubmitting it.
            const retained = lifecycleEffectAfterClaimLoss(error);
            if (retained !== undefined && isDeepStrictEqual(retained.effect, request.effect))
              state.observation = retained;
            throw error;
          }
          state.observation = observation;
          if (!state.active || !eligible()) return refuse();
          return observation;
        })();
        state.pending = pending;
        // Retain/observe even when a broken source fails to await its callback.
        // The original guard/provider keeps possible submissions independently.
        void pending.catch(() => undefined);
        return pending;
      });
    } catch {
      state.failed = true;
    } finally {
      state.active = false;
      if (state.pending !== undefined) {
        try {
          await state.pending;
        } catch {
          state.failed = true;
        }
      }
    }
    if (!state.failed && eligible()) return state.observation;
    if (state.effect === undefined) return undefined;
    // A closed source, lost claim or failed retention after possible submission
    // never upgrades an earlier observation into current completion.
    return Object.freeze({
      kind: "unresolved",
      reason: state.observation?.reason === "claim-lost" ? "claim-lost" : "dependency-unavailable",
      effect: state.effect,
      ...(state.observation?.observation === undefined
        ? {}
        : { observation: state.observation.observation }),
    });
  }
}
