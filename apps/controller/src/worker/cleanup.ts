import type {
  AgentRevision,
  ComputeDriver,
  ComputeRevisionContext,
} from "@openclaw-enterprise/contracts";
import type { LeasedEffects, WorkerClaimContext } from "./leased-effect.ts";
import type { WorkerRevisionCurrentness } from "./revision-currentness.ts";
import type { RevisionDispatchResult } from "./runner.ts";

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
