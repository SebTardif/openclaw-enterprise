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
  createRevision(revision: AgentRevision): Promise<Readonly<AgentRevision>>;
}
