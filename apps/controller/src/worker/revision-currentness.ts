import type { RuntimeIntent } from "@openclaw-enterprise/contracts/runtime-assignment";
import {
  WorkClaimLostError,
  type ClaimedWork,
  type PlatformReadView,
} from "@openclaw-enterprise/occ";
import type { PlatformReadOptions } from "@openclaw-enterprise/occ/ports/transaction";
import type { WorkerClaimContext } from "./leased-effect.ts";

export interface RevisionCurrentnessView {
  readonly runtimeAdmissions: Pick<PlatformReadView["runtimeAdmissions"], "findRevisionAdmission">;
  readonly runtimeAssignments: Pick<
    PlatformReadView["runtimeAssignments"],
    "findRuntimeIntent" | "findRuntimeIntentHead"
  >;
}

export type RevisionCurrentnessRead = <T>(
  action: (view: RevisionCurrentnessView) => Promise<T>,
  options: PlatformReadOptions,
) => Promise<T>;

/** A stale intent is distinct from loss of the original queue claim. */
export class WorkerRevisionCurrentnessLostError extends Error {
  readonly code = "RUNTIME_INTENT_CHANGED";
  constructor() {
    super("The original revision's running intent is no longer current.");
    this.name = "WorkerRevisionCurrentnessLostError";
  }
}

function sameIntent(original: Readonly<RuntimeIntent>, current: Readonly<RuntimeIntent>): boolean {
  return (
    current.installationId === original.installationId &&
    current.namespaceId === original.namespaceId &&
    current.agentId === original.agentId &&
    current.transitionRef === original.transitionRef &&
    current.generation === original.generation &&
    current.revisionId === original.revisionId &&
    current.desiredMode === "running" &&
    current.actorId === original.actorId &&
    current.requestId === original.requestId &&
    current.createdAt === original.createdAt
  );
}

/** Necessary current-state comparison, never account or external-effect authority.
 * The finalizer calls this on its own locked unit; running effects use fresh reads.
 */
export async function assertRevisionCurrentness(
  view: RevisionCurrentnessView,
  installationId: string,
  claim: Readonly<ClaimedWork>,
): Promise<void> {
  if (!installationId || !claim.agentId || !claim.revisionId || claim.namespaceTarget !== undefined)
    throw new WorkerRevisionCurrentnessLostError();
  const scope = { namespaceId: claim.namespaceId, agentId: claim.agentId };
  const admission = await view.runtimeAdmissions.findRevisionAdmission(scope, claim.revisionId);
  const original =
    admission === undefined
      ? undefined
      : await view.runtimeAssignments.findRuntimeIntent(scope, admission.runtimeTransitionRef);
  // Read the head last. An absent original admission must not bypass a later lineage.
  const current = await view.runtimeAssignments.findRuntimeIntentHead(scope);
  if (admission === undefined) {
    if (
      claim.runtimeTransitionRef !== undefined ||
      claim.lifecycleGeneration !== undefined ||
      current !== undefined
    )
      throw new WorkerRevisionCurrentnessLostError();
    return;
  }
  if (
    original === undefined ||
    current === undefined ||
    original.desiredMode !== "running" ||
    original.installationId !== installationId ||
    original.namespaceId !== scope.namespaceId ||
    original.agentId !== scope.agentId ||
    original.revisionId !== claim.revisionId ||
    original.actorId !== claim.actorId ||
    admission.namespaceId !== scope.namespaceId ||
    admission.agentId !== scope.agentId ||
    admission.revisionId !== claim.revisionId ||
    admission.runtimeTransitionRef !== original.transitionRef ||
    admission.lifecycleGeneration !== original.generation ||
    claim.runtimeTransitionRef !== original.transitionRef ||
    claim.lifecycleGeneration !== original.generation ||
    !sameIntent(original, current)
  )
    throw new WorkerRevisionCurrentnessLostError();
}

/** One original worker execution, read afresh around each wait. Nothing is cached
 * as a positive permit, and no lock is held over a Compute call. Provider fencing
 * and durable exact cleanup before candidate terminality remain separate inputs.
 */
export class WorkerRevisionCurrentness {
  private readonly read: RevisionCurrentnessRead;
  private readonly installationId: string;
  private readonly execution: WorkerClaimContext;

  constructor(
    read: RevisionCurrentnessRead,
    installationId: string,
    execution: WorkerClaimContext,
  ) {
    this.read = read;
    this.installationId = installationId;
    this.execution = Object.freeze({
      signal: execution.signal,
      claim: Object.freeze({ ...execution.claim }),
    });
  }

  async assertCurrent(): Promise<void> {
    if (this.execution.signal.aborted) throw new WorkClaimLostError();
    try {
      await this.read(
        (view) => assertRevisionCurrentness(view, this.installationId, this.execution.claim),
        { signal: this.execution.signal, timeoutMs: 3_000 },
      );
    } catch (error) {
      if (this.execution.signal.aborted && !(error instanceof WorkClaimLostError))
        throw new WorkClaimLostError();
      throw error;
    }
    if (this.execution.signal.aborted) throw new WorkClaimLostError();
  }
}
