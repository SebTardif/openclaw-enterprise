import type { AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
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
  recordAdmission(admission: RevisionRuntimeAdmission): Promise<void>;
}
