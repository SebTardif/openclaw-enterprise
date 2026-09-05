import type { Agent, AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import type { HarnessExecutionMode } from "@openclaw-enterprise/contracts/resources/agent";
import type { ProviderDefinition } from "@openclaw-enterprise/contracts/drivers/provider";
import type { ExactAuthorization } from "../../application/authorization.ts";
import type { MutationRepositoryOperations } from "../../application/mutation-context.ts";

/** Only repositories and methods needed by Agent draft commands and queries. */
export const AGENT_REPOSITORIES = {
  read: {
    namespaces: ["findNamespace"],
    agents: ["listAgents", "findAgent"],
    revisions: ["listRevisions", "findRevision"],
  },
  mutate: {
    namespaces: ["lockNamespace"],
    agents: ["createAgent", "lockAgent", "updateConfiguration"],
    configurations: ["findConfiguration"],
    serviceAccounts: ["findServiceAccount"],
    secrets: ["lockSecret"],
  },
} as const;

export type AgentRepositories = MutationRepositoryOperations<
  typeof AGENT_REPOSITORIES.read,
  typeof AGENT_REPOSITORIES.mutate
>;

export interface CreateAgentInput {
  readonly namespaceId: string;
  readonly name: string;
  readonly configurationId: string;
  readonly providerId?: string | null;
  readonly serviceAccountId?: string;
  readonly executionMode?: HarnessExecutionMode;
}

export interface UpdateAgentInput {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly configurationId: string;
  readonly providerId?: string | null;
  readonly serviceAccountId?: string | null;
  readonly executionMode?: HarnessExecutionMode;
}

export interface ActiveAgentRevisionSelection {
  readonly agent: Readonly<Agent>;
  readonly revision: Readonly<AgentRevision>;
}

export interface AgentCommands {
  createAgent(principalId: string, input: CreateAgentInput): Promise<Readonly<Agent>>;
  updateAgent(principalId: string, input: UpdateAgentInput): Promise<Readonly<Agent>>;
}

export interface AgentQueries {
  listAgents(principalId: string, namespaceId: string): Promise<readonly Readonly<Agent>[]>;
  getAgent(principalId: string, namespaceId: string, agentId: string): Promise<Readonly<Agent>>;
  listRevisions(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<readonly Readonly<AgentRevision>[]>;
  getRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevision>>;
  getReadableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection>;
  getOperableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection>;
}

export interface AgentServicePort extends AgentCommands, AgentQueries {}

export interface AgentServiceOptions {
  readonly repositories: AgentRepositories;
  readonly authorization: Pick<ExactAuthorization, "authorize" | "canRead">;
  readonly providers: ReadonlyMap<string, ProviderDefinition>;
  readonly assertSecretDriverOwner: (expectedId: string) => void;
  readonly createId: () => string;
  readonly now: () => string;
}
