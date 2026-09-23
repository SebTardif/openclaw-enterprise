import type { AgentOAuthAttempt, AgentOAuthPhase } from "@openclaw-enterprise/contracts";

export interface AgentOAuthReadRepository {
  latest(namespaceId: string, agentId: string): Promise<Readonly<AgentOAuthAttempt> | undefined>;
  find(
    namespaceId: string,
    agentId: string,
    generation: number,
  ): Promise<Readonly<AgentOAuthAttempt> | undefined>;
  list(namespaceId: string, agentId: string): Promise<readonly Readonly<AgentOAuthAttempt>[]>;
}

export interface AgentOAuthRepository extends AgentOAuthReadRepository {
  /** Caller holds the Agent lock while allocating and publishing the next generation. */
  create(attempt: AgentOAuthAttempt): Promise<Readonly<AgentOAuthAttempt>>;
  /** Latest-generation authority belongs to the enclosing Agent-locked transaction. */
  update(
    input: Pick<
      AgentOAuthAttempt,
      "namespaceId" | "agentId" | "generation" | "phase" | "updatedAt"
    > & {
      readonly expectedPhase: AgentOAuthPhase;
      readonly stagedSecret?: AgentOAuthAttempt["stagedSecret"];
      readonly storageUid?: AgentOAuthAttempt["storageUid"];
      readonly failureCode?: AgentOAuthAttempt["failureCode"];
    },
  ): Promise<Readonly<AgentOAuthAttempt> | undefined>;
  /** Final Agent teardown only, after external custody cleanup has completed. */
  delete(namespaceId: string, agentId: string): Promise<void>;
}
