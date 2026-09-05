import type { Driver } from "./base.ts";
import type { Agent, AgentRevision } from "../resources/agent.ts";
import type { Namespace } from "../resources/namespace.ts";
import type { Scope } from "../resources/scope.ts";
import type { SecretEnvironmentProjection } from "../resources/secret.ts";

export interface ComputeRevisionContext {
  readonly secretEnvironment: readonly SecretEnvironmentProjection[];
}

export interface WorkloadLaunchContext {
  environment: Record<string, string>;
}

export interface ComputeLifecycleHooks {
  afterNamespacePrepared?(namespace: Readonly<Namespace>, signal: AbortSignal): Promise<void>;
  beforeWorkloadStart?(
    revision: Readonly<AgentRevision>,
    launch: WorkloadLaunchContext,
    signal: AbortSignal,
  ): Promise<void>;
  beforeWorkloadStop?(revision: Readonly<AgentRevision>, signal: AbortSignal): Promise<void>;
  beforeNamespaceDelete?(namespace: Readonly<Namespace>, signal: AbortSignal): Promise<void>;
}

export type NamespaceLifecycleFailure = "retryable" | "permanent";

export interface NamespaceEnsureResult extends Scope {
  readonly namespaceId: string;
  readonly namespaceReady: boolean;
  readonly failure?: NamespaceLifecycleFailure;
}

export interface NamespaceDeleteResult extends Scope {
  readonly namespaceId: string;
  readonly namespaceDeleted: boolean;
  readonly failure?: NamespaceLifecycleFailure;
}

export interface ComputeReadiness extends Scope {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly ready: boolean;
}

/** Authorized, server-admitted resource identities for an Agent-owned runtime. */
export interface ComputeAgentBinding {
  readonly namespace: Readonly<Namespace>;
  readonly agent: Readonly<Agent>;
}

export interface ComputeDriver extends Driver {
  readonly capability: "compute";
  readonly activationOrder?: "beforeCommit" | "afterCommit";
  readonly maintenanceIntervalMs?: number;
  setLifecycleDrivers?(drivers: readonly Driver[]): void;
  bindAgent?(binding: ComputeAgentBinding): void | Promise<void>;
  getGatewayEndpoint?(revision: AgentRevision): string | undefined;
  ensureNamespace(namespace: Namespace): Promise<NamespaceEnsureResult>;
  deleteNamespace(namespace: Namespace): Promise<NamespaceDeleteResult>;
  prepareRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<ComputeReadiness>;
  activateRevision?(revision: AgentRevision, context?: ComputeRevisionContext): Promise<void>;
  deactivateRevision?(revision: AgentRevision): Promise<void>;
  retireRevision(revision: AgentRevision): Promise<void>;
}
