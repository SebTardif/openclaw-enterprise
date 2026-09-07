import type {
  AgentRevision,
  HarnessDescriptor,
  HarnessExecutionMode,
} from "@openclaw-enterprise/contracts/resources/agent";
import type { AuditEvent } from "@openclaw-enterprise/contracts/identity/audit";
import type { ProviderDefinition } from "@openclaw-enterprise/contracts/drivers/provider";
import type { LoggingLevel } from "@openclaw-enterprise/contracts/logging";
import type { ExactAuthorization } from "../../application/authorization.ts";
import type { DriverSelection, SelectedDriver } from "../../application/driver-selection.ts";
import type {
  MutationRepositoryOperations,
  SelectedRepositories,
} from "../../application/mutation-context.ts";
import type { RuntimeIntent } from "@openclaw-enterprise/contracts/runtime-assignment";
import type { CredentialWorkloadSelectionV1 } from "@openclaw-enterprise/contracts/credential-workload-selection-v1";
import type { AdmittedStorePolicyBindingV1 } from "../../workload-profiles/admitted-configuration.ts";
import type { PlatformReadView } from "../../ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "../../ports/platform-unit-of-work.ts";

export const DEPLOYMENT_REPOSITORIES = {
  read: {},
  mutate: {
    namespaces: ["lockNamespace"],
    agents: ["findAgent", "lockAgent"],
    runtimeAssignments: [
      "findRuntimeIntentHead",
      "initializeRuntimeIntent",
      "advanceRuntimeIntent",
    ],
    serviceAccounts: ["lockServiceAccount", "findServiceAccountProviderBinding"],
    configurations: ["lockConfiguration"],
    secrets: ["lockSecret"],
    revisions: ["listRevisions", "createRevision"],
    audit: ["append"],
    runtimeAdmissions: ["recordAdmission"],
    operations: ["append"],
  },
} as const;

export type DeploymentRepositories = MutationRepositoryOperations<
  typeof DEPLOYMENT_REPOSITORIES.read,
  typeof DEPLOYMENT_REPOSITORIES.mutate
>;

/** Fresh storage reads only; recovery must never join the failed ambient unit. */
export const DEPLOYMENT_RECOVERY_REPOSITORIES = {
  installations: ["getInstallation"],
  agents: ["findAgent"],
  runtimeAssignments: ["findRuntimeIntent"],
  runtimeAdmissions: ["findCommittedAdmission"],
} as const;

export type DeploymentRecoveryReadView = SelectedRepositories<
  PlatformReadView,
  typeof DEPLOYMENT_RECOVERY_REPOSITORIES
>;

export type HarnessResolver = (
  harnessId: string,
  executionMode: HarnessExecutionMode,
) => HarnessDescriptor | undefined;

export interface DeployAgentInput {
  readonly namespaceId: string;
  readonly agentId: string;
  /** Internal admission CAS; omission preserves the staged bodyless bridge. */
  readonly expectedLifecycleGeneration?: number | null;
}

/** Trusted caller retains this locator before opening its outer transaction. */
export interface DeployAgentAdmissionContext {
  readonly transitionRef: string;
  readonly requestId: string;
  readonly createAuditEvent: (revision: Readonly<AgentRevision>) => AuditEvent;
  /** Trusted selected-path requirement; no HTTP/bodyless inference or authority. */
  readonly requireCredentialSelection?: true;
}

export interface DeploymentCredentialSelectionContext {
  readonly installationId: string;
  readonly principalId: string;
  readonly transitionRef: string;
  readonly requestId: string;
  /** Actual normalized and Driver-validated candidate with its original revision ID. */
  readonly revision: Readonly<AgentRevision>;
  readonly repositories: SelectedRepositories<
    PlatformUnitOfWork,
    typeof DEPLOYMENT_REPOSITORIES.mutate
  >;
}

/** Borrowed by this service; the enrolled original owner retains it until terminal cleanup. */
export interface DeploymentCredentialSelectionGuard {
  assertCurrent(): undefined;
  release(): Promise<void>;
}

export interface PreparedDeploymentCredentialSelection extends DeploymentCredentialSelectionGuard {
  readonly record: CredentialWorkloadSelectionV1;
  readonly storePolicyBindings: readonly AdmittedStorePolicyBindingV1[];
  /** Read the actual own inserted revision/use/credential rows and compare to the
   * original protected owner expectations. Self-comparison is not qualification. */
  verifyInserted(): Promise<void>;
}

/** Installed by the original accepting owner only. Neither structural inputs nor
 * matching values authenticate an implementation. No default producer exists.
 * prepare must authenticate/enroll the exact ambient deployment unit, retain
 * current account/reference/material/profile participants, and own failed
 * acquisition cleanup. It must not cast a Platform unit into a Gateway unit.
 * retain synchronously registers the exact guard with that EXISTING owner for
 * final pre-COMMIT checks and release after COMMIT/rollback/connection cleanup;
 * callback return or acquisition-IO expiry must not release retained fences.
 * Enrollment transfers custody only on a synchronous undefined return; a
 * refused/throwing enrollment must not leave a registered participant. */
export interface DeploymentCredentialSelectionProducer {
  prepare(
    context: DeploymentCredentialSelectionContext,
  ): Promise<PreparedDeploymentCredentialSelection>;
  retain(
    context: DeploymentCredentialSelectionContext,
    guard: DeploymentCredentialSelectionGuard,
  ): undefined;
}

export interface DeploymentCommands {
  deployAgent(
    principalId: string,
    input: DeployAgentInput,
    resolveHarness: HarnessResolver,
    admission: DeployAgentAdmissionContext,
  ): Promise<Readonly<AgentRevision>>;
}

export interface DeploymentQueries {
  /** Compatible reader for the original deploy-admission format, not live runtime status. */
  getAcceptedDeployOperation(
    principalId: string,
    input: AcceptedDeployOperationInput,
  ): Promise<Readonly<AcceptedDeployOperation>>;
  recoverDeployAgent(
    principalId: string,
    input: DeployAgentInput,
    admission: Pick<DeployAgentAdmissionContext, "transitionRef" | "requestId">,
  ): Promise<Readonly<AgentRevision>>;
}

export interface AcceptedDeployOperationInput {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly operationRef: string;
}

/** The immutable fields permitted after an exact Agent read check. */
export interface AcceptedDeployOperation {
  readonly operationRef: string;
  readonly kind: "deploy";
  readonly revisionSource: "saved-draft";
  readonly lifecycleGeneration: number;
  readonly desiredMode: "running";
  readonly acceptedAt: string;
  readonly requestedRevisionId: string;
}

export interface DeploymentServicePort extends DeploymentCommands, DeploymentQueries {}

export interface DeploymentServiceOptions {
  readonly installationId: string;
  readonly isRuntimeAdmissionAudit: (event: AuditEvent, intent: RuntimeIntent) => boolean;
  readonly repositories: DeploymentRepositories;
  readonly recoveryRead: <T>(work: (state: DeploymentRecoveryReadView) => Promise<T>) => Promise<T>;
  readonly hasActiveTransaction: () => boolean;
  readonly poisonAdmission: (error: unknown) => void;
  readonly authorization: Pick<ExactAuthorization, "authorize">;
  readonly computeDriver: SelectedDriver<"compute">;
  readonly configurationDriver: DriverSelection["configurationDriver"];
  readonly secretDriver: DriverSelection["secretDriver"];
  readonly sandboxDriver: DriverSelection["sandboxDriver"];
  readonly configurationOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly secretOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly providers: ReadonlyMap<string, ProviderDefinition>;
  readonly loggingLevel: LoggingLevel;
  readonly createId: () => string;
  readonly now: () => string;
  readonly credentialSelection?: DeploymentCredentialSelectionProducer;
}
