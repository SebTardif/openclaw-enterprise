import type { AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import type { LifecycleDeployCommandV2 } from "@openclaw-enterprise/contracts/lifecycle-deploy-v2";
import type {
  RuntimeScope,
  RuntimeIntentAttribution,
} from "@openclaw-enterprise/contracts/runtime-assignment";

export interface RevisionRuntimeAdmission extends RuntimeScope {
  readonly revisionId: string;
  readonly runtimeTransitionRef: string;
  readonly lifecycleGeneration: number;
  readonly auditEventId: string;
}

export interface RuntimeAdmissionReadRepository {
  /** Caller must authorize the original command operands before disclosing replay.
   * This read retains the original request attribution; it accepts no new request ID. */
  findCommittedDeployCommand(
    scope: RuntimeScope,
    command: LifecycleDeployCommandV2,
    actorId: string,
  ): Promise<Readonly<AgentRevision> | undefined>;
  findRevisionAdmission(
    scope: RuntimeScope,
    revisionId: string,
  ): Promise<Readonly<RevisionRuntimeAdmission> | undefined>;
  findCommittedAdmission(
    scope: RuntimeScope,
    transitionRef: string,
    attribution: RuntimeIntentAttribution,
  ): Promise<Readonly<AgentRevision> | undefined>;
}

export interface RuntimeAdmissionRepository extends RuntimeAdmissionReadRepository {
  /** Acquire before draft/head lookup. The same owner retains the lock until terminal cleanup. */
  lockDeployCommand(scope: RuntimeScope, operationRef: string): Promise<void>;
  recordAdmission(
    admission: RevisionRuntimeAdmission,
    deploy?: Readonly<{ command: LifecycleDeployCommandV2; actorId: string }>,
  ): Promise<void>;
}
