import type { WorkloadProfileSelectionV1 } from "@openclaw-enterprise/contracts/workload-profile-v1";
import type { Agent, HarnessExecutionMode } from "@openclaw-enterprise/contracts/resources/agent";

export interface AgentReadRepository {
  findAgent(namespaceId: string, agentId: string): Promise<Readonly<Agent> | undefined>;
  listAgents(namespaceId: string): Promise<readonly Readonly<Agent>[]>;
}

export interface AgentRepository extends AgentReadRepository {
  createAgent(agent: Agent): Promise<Readonly<Agent>>;
  lockAgent(namespaceId: string, agentId: string): Promise<Readonly<Agent> | undefined>;
  updateConfiguration(
    namespaceId: string,
    agentId: string,
    configurationId: string,
    executionMode?: HarnessExecutionMode,
    serviceAccountId?: string | null,
    providerId?: string | null,
    workloadProfileSelection?: WorkloadProfileSelectionV1,
    maximumExecutionMs?: number | null,
  ): Promise<Readonly<Agent> | undefined>;
  compareAndSetActiveRevision(
    namespaceId: string,
    agentId: string,
    expectedRevisionId: string | undefined,
    candidateRevisionId: string,
  ): Promise<Readonly<Agent> | undefined>;
}
