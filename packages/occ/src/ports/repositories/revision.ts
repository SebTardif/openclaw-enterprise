import type { CredentialWorkloadSelectionV1 } from "@openclaw-enterprise/contracts/credential-workload-selection-v1";
import type { AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";

export interface AgentRevisionReadRepository {
  findRevision(
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevision> | undefined>;
  listRevisions(namespaceId: string, agentId: string): Promise<readonly Readonly<AgentRevision>[]>;
}

export interface AgentRevisionRepository extends AgentRevisionReadRepository {
  createRevision(
    revision: AgentRevision,
    credentialWorkloadSelection?: CredentialWorkloadSelectionV1,
  ): Promise<Readonly<AgentRevision>>;
}
