import type {
  AgentRevision,
  ComputeDriver,
  ComputeRevisionContext,
  HarnessDescriptor,
  HarnessExecutionMode,
  Installation,
} from "@openclaw-enterprise/contracts";
import { WorkClaimLostError, type PlatformReadView } from "@openclaw-enterprise/occ";
import type { WorkerRevisionCleanup } from "./cleanup.ts";
import type { WorkerFinalization } from "./finalization.ts";
import type { LeasedEffects, WorkerClaimContext } from "./leased-effect.ts";
import {
  WorkerRevisionCurrentness,
  WorkerRevisionCurrentnessLostError,
} from "./revision-currentness.ts";
import type { PlatformReadOptions } from "@openclaw-enterprise/occ/ports/transaction";
import { validRevisionObservation, type WorkerRevisionInputs } from "./revision-inputs.ts";
import type { RevisionDispatchResult } from "./runner.ts";

export interface RevisionReconcilerView {
  readonly namespaces: Pick<PlatformReadView["namespaces"], "findNamespace">;
  readonly agents: Pick<PlatformReadView["agents"], "findAgent">;
  readonly revisions: Pick<PlatformReadView["revisions"], "findRevision">;
  readonly runtimeAdmissions: Pick<PlatformReadView["runtimeAdmissions"], "findRevisionAdmission">;
  readonly runtimeAssignments: Pick<
    PlatformReadView["runtimeAssignments"],
    "findRuntimeIntent" | "findRuntimeIntentHead"
  >;
}

export interface RevisionReconcilerOptions {
  readonly read: <T>(
    action: (view: RevisionReconcilerView) => Promise<T>,
    options?: PlatformReadOptions,
  ) => Promise<T>;
  readonly installation: () => Readonly<Installation> | undefined;
  readonly compute: Pick<
    ComputeDriver,
    "id" | "implementation" | "bindAgent" | "prepareRevision" | "activationOrder"
  >;
  readonly resolveApprovedHarness: (
    id: string,
    mode: HarnessExecutionMode,
  ) => HarnessDescriptor | undefined;
  readonly mode: "development" | "production";
  readonly inputs: Pick<
    WorkerRevisionInputs,
    "authorizeRevision" | "resolveRevisionProvider" | "resolveRevisionSecretContext"
  >;
  readonly cleanup: Pick<WorkerRevisionCleanup, "stage" | "reconcileActive">;
  readonly finalization: Pick<
    WorkerFinalization,
    "finalizeRevision" | "completeActivatedRevision" | "finalizeActiveRevision"
  >;
  readonly effects: Pick<LeasedEffects, "runRevision" | "renewRevision">;
}

/** Revalidates admitted revision work before invoking the selected leased effects. */
export class RevisionReconciler {
  private readonly options: RevisionReconcilerOptions;

  constructor(options: RevisionReconcilerOptions) {
    this.options = options;
  }

  async reconcile(execution: WorkerClaimContext): Promise<void> {
    const { claim } = execution;
    let result: RevisionDispatchResult;
    try {
      if (
        claim.agentId === undefined ||
        claim.revisionId === undefined ||
        claim.namespaceTarget !== undefined
      ) {
        await this.options.finalization.finalizeRevision(execution, {
          outcome: "permanent",
          code: "INVALID_TARGET",
        });
        return;
      }
      const resources = await this.options.read(async (view) => {
        const namespace = await view.namespaces.findNamespace(claim.namespaceId);
        const agent = await view.agents.findAgent(claim.namespaceId, claim.agentId!);
        const revision = await view.revisions.findRevision(
          claim.namespaceId,
          claim.agentId!,
          claim.revisionId!,
        );
        const scope = { namespaceId: claim.namespaceId, agentId: claim.agentId! };
        // Both-null claim fields do not establish historical admission. Consult
        // the immutable original association, never the current intent head.
        const admission = await view.runtimeAdmissions.findRevisionAdmission(
          scope,
          claim.revisionId!,
        );
        const intent =
          admission === undefined
            ? undefined
            : await view.runtimeAssignments.findRuntimeIntent(
                scope,
                admission.runtimeTransitionRef,
              );
        const previous =
          agent?.activeRevisionId === undefined
            ? undefined
            : await view.revisions.findRevision(
                claim.namespaceId,
                claim.agentId!,
                agent.activeRevisionId,
              );
        return { namespace, agent, revision, previous, admission, intent };
      });
      const { namespace, agent, revision, previous, admission, intent } = resources;
      if (namespace === undefined || agent === undefined || revision === undefined) {
        await this.options.finalization.finalizeRevision(execution, {
          outcome: "permanent",
          code: "INVALID_REVISION_OWNER",
        });
        return;
      }
      if (namespace.status !== "ready") {
        await this.options.finalization.finalizeRevision(execution, {
          outcome: "permanent",
          code: "NAMESPACE_NOT_READY",
        });
        return;
      }
      if (
        revision.namespaceId !== namespace.id ||
        revision.agentId !== agent.id ||
        revision.servicePrincipalId !== agent.servicePrincipalId
      ) {
        await this.options.finalization.finalizeRevision(execution, {
          outcome: "permanent",
          code: "INVALID_ADMITTED_REVISION",
        });
        return;
      }
      if (
        admission === undefined
          ? claim.runtimeTransitionRef !== undefined || claim.lifecycleGeneration !== undefined
          : intent === undefined ||
            intent.desiredMode !== "running" ||
            intent.installationId !== this.options.installation()?.id ||
            intent.namespaceId !== namespace.id ||
            intent.agentId !== agent.id ||
            intent.revisionId !== revision.id ||
            intent.actorId !== claim.actorId ||
            admission.namespaceId !== namespace.id ||
            admission.agentId !== agent.id ||
            admission.revisionId !== revision.id ||
            admission.runtimeTransitionRef !== intent.transitionRef ||
            admission.lifecycleGeneration !== intent.generation ||
            claim.runtimeTransitionRef !== admission.runtimeTransitionRef ||
            claim.lifecycleGeneration !== admission.lifecycleGeneration
      ) {
        await this.options.finalization.finalizeRevision(execution, {
          outcome: "permanent",
          code: "INVALID_RUNTIME_ADMISSION",
        });
        return;
      }
      const currentness = new WorkerRevisionCurrentness(
        (action, options) => this.options.read(action, options),
        this.options.installation()?.id ?? "",
        execution,
      );
      await currentness.assertCurrent();
      const approvedHarness = this.options.resolveApprovedHarness(
        revision.harness.id,
        revision.harness.mode,
      );
      if (approvedHarness === undefined || revision.harness.version !== approvedHarness.version) {
        await this.options.finalization.finalizeRevision(execution, {
          outcome: "permanent",
          code: "HARNESS_DESCRIPTOR_MISMATCH",
        });
        return;
      }
      if (
        revision.compute.id !== this.options.compute.id ||
        revision.compute.implementation !== this.options.compute.implementation
      ) {
        await this.options.finalization.finalizeRevision(execution, {
          outcome: "permanent",
          code: "COMPUTE_DRIVER_MISMATCH",
        });
        return;
      }
      if (agent.activeRevisionId !== undefined && previous === undefined) {
        await this.options.finalization.finalizeRevision(execution, {
          outcome: "permanent",
          code: "INVALID_ACTIVE_REVISION",
        });
        return;
      }
      const denied = await this.options.inputs.authorizeRevision(claim, agent, revision);
      if (denied !== undefined) {
        await this.options.finalization.finalizeRevision(execution, denied);
        return;
      }
      const provider = await this.options.inputs.resolveRevisionProvider(revision);
      if (provider !== undefined) {
        await this.options.finalization.finalizeRevision(execution, provider);
        return;
      }
      if (this.options.compute.bindAgent !== undefined) {
        await this.options.effects.runRevision(execution, currentness, async () => {
          await this.options.compute.bindAgent!({ namespace, agent });
        });
      }
      const secretContext = await this.options.inputs.resolveRevisionSecretContext(revision);
      if ("result" in secretContext) {
        if (agent.activeRevisionId === revision.id) {
          await this.options.finalization.finalizeActiveRevision(
            execution,
            revision,
            secretContext.result.code,
          );
        } else {
          await this.options.finalization.finalizeRevision(execution, secretContext.result);
        }
        return;
      }
      if (agent.activeRevisionId === revision.id) {
        try {
          const incomplete = await this.options.cleanup.reconcileActive(
            execution,
            revision,
            secretContext.context,
            currentness,
          );
          if (incomplete !== undefined) {
            if (incomplete.outcome === "permanent") {
              await this.options.finalization.finalizeRevision(execution, incomplete);
            } else {
              await this.options.finalization.finalizeActiveRevision(
                execution,
                revision,
                incomplete.code,
              );
            }
            return;
          }
        } catch (error) {
          if (
            error instanceof WorkClaimLostError ||
            error instanceof WorkerRevisionCurrentnessLostError
          )
            throw error;
          await this.options.finalization.finalizeActiveRevision(
            execution,
            revision,
            "REVISION_FINALIZATION_INCOMPLETE",
          );
          return;
        }
        await this.options.finalization.completeActivatedRevision(execution, {
          outcome: "success",
          code: "REVISION_ALREADY_ACTIVE",
          revision,
        });
        return;
      }
      if (previous !== undefined && previous.revision >= revision.revision) {
        await this.options.finalization.finalizeRevision(execution, {
          outcome: "success",
          code: "REVISION_SUPERSEDED",
          supersededBy: previous,
        });
        return;
      }
      await this.options.effects.renewRevision(execution, currentness);
      result = await this.observeRevision(
        execution,
        revision,
        previous,
        agent.activeRevisionId,
        secretContext.context,
        currentness,
      );
    } catch (error) {
      if (
        error instanceof WorkClaimLostError ||
        error instanceof WorkerRevisionCurrentnessLostError
      )
        throw error;
      result = { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" };
    }
    await this.options.finalization.finalizeRevision(execution, result);
  }

  private async observeRevision(
    execution: WorkerClaimContext,
    revision: Readonly<AgentRevision>,
    previous: Readonly<AgentRevision> | undefined,
    expectedActiveRevisionId: string | undefined,
    context: ComputeRevisionContext,
    currentness: WorkerRevisionCurrentness,
  ): Promise<RevisionDispatchResult> {
    return this.options.effects.runRevision(execution, currentness, async (assertCurrent) => {
      const observation = await this.options.compute.prepareRevision(revision, context);
      if (!validRevisionObservation(observation, revision))
        return { outcome: "permanent", code: "INVALID_DRIVER_OBSERVATION" };
      if (!observation.ready) return { outcome: "pending", code: "REVISION_INCOMPLETE" };
      if (this.options.compute.activationOrder === "beforeCommit") {
        await assertCurrent();
        await this.options.cleanup.stage("activateRevision", revision, context);
        await assertCurrent();
      } else if (
        this.options.mode === "production" &&
        revision.harness.mode === "dedicated" &&
        expectedActiveRevisionId === undefined
      ) {
        await assertCurrent();
        await this.options.cleanup.stage("deactivateRevision", revision);
        await assertCurrent();
      }
      return {
        outcome: "success",
        code: "REVISION_ACTIVATED",
        revision,
        context,
        ...(previous === undefined ? {} : { previous }),
        ...(expectedActiveRevisionId === undefined ? {} : { expectedActiveRevisionId }),
      };
    });
  }
}
