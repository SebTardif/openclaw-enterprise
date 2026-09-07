import type { AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import type { LifecycleDeployCommandV2 } from "@openclaw-enterprise/contracts/lifecycle-deploy-v2";
import type { ConfigurationDriver } from "@openclaw-enterprise/contracts/drivers/configuration";
import type { SecretDriver } from "@openclaw-enterprise/contracts/drivers/secret";
import type { SandboxDriver } from "@openclaw-enterprise/contracts/drivers/sandbox";
import type { PlatformUnitOfWork } from "./platform-unit-of-work.ts";
import type {
  WorkloadProfileDeploymentUnitV2,
  WorkloadProfileOwnedOperationV2,
} from "../workload-profiles/admitted-use.ts";
import type {
  DeployAgentInput,
  DeploymentServiceOptions,
  HarnessResolver,
} from "../services/deployment/port.ts";

/** Narrow operations over the original unit; this projection is not authority. */
export interface DeploymentCandidateOperationsV2 {
  readonly repositories: {
    readonly namespaces: Pick<PlatformUnitOfWork["namespaces"], "lockNamespace">;
    readonly agents: Pick<PlatformUnitOfWork["agents"], "findAgent" | "lockAgent">;
    readonly runtimeAssignments: Pick<
      PlatformUnitOfWork["runtimeAssignments"],
      "findRuntimeIntentHead"
    >;
    readonly serviceAccounts: Pick<
      PlatformUnitOfWork["serviceAccounts"],
      "lockServiceAccount" | "findServiceAccountProviderBinding"
    >;
    readonly configurations: Pick<PlatformUnitOfWork["configurations"], "lockConfiguration">;
    readonly secrets: Pick<PlatformUnitOfWork["secrets"], "lockSecret">;
    readonly revisions: Pick<PlatformUnitOfWork["revisions"], "listRevisions">;
  };
  readonly drivers: {
    compute(): Readonly<{ id: string; implementation: string }>;
    sandbox():
      Readonly<{ id: string; configureAgent?: SandboxDriver["configureAgent"] }> | undefined;
    secret(expectedId?: string): Readonly<{ id: string; resolve: SecretDriver["resolve"] }>;
    configuration(): Pick<ConfigurationDriver, "read" | "validate">;
  };
  readonly nextRevisionId: DeploymentServiceOptions["createId"];
  readonly now: DeploymentServiceOptions["now"];
}

export type DeploymentCandidateOriginalOperationsV2 = Pick<
  DeploymentServiceOptions,
  "createId" | "now"
>;
export type DeploymentCandidateOperandsV2 = readonly [
  principalId: string,
  input: DeployAgentInput,
  command?: LifecycleDeployCommandV2,
];
export interface DeploymentCandidateResultV2 {
  readonly candidate: Readonly<AgentRevision>;
  readonly namespace: NonNullable<
    Awaited<ReturnType<PlatformUnitOfWork["namespaces"]["lockNamespace"]>>
  >;
  readonly lockedAgent: NonNullable<Awaited<ReturnType<PlatformUnitOfWork["agents"]["lockAgent"]>>>;
  readonly head: Awaited<
    ReturnType<PlatformUnitOfWork["runtimeAssignments"]["findRuntimeIntentHead"]>
  >;
  readonly providerId: AgentRevision["providerId"];
}

/** Constructed once from the original Deployment dependencies. A result is
 * inert data; only observed original owner operations can publish a context. */
export type DeploymentCandidateNormalizerV2 = (
  operands: DeploymentCandidateOperandsV2,
  resolveHarness: HarnessResolver,
  operations: DeploymentCandidateOperationsV2,
) => Promise<DeploymentCandidateResultV2>;

export interface WorkloadProfileCandidateContinuationV2 {
  withCandidate<Value>(
    unit: WorkloadProfileDeploymentUnitV2,
    io: WorkloadProfileOwnedOperationV2,
    resolveHarness: HarnessResolver,
    work: (result: DeploymentCandidateResultV2) => Promise<Value>,
  ): Promise<Value>;
}
