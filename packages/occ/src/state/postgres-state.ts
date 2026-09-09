import { readRuntimePreparationSubmissionV1 } from "./postgres/runtime-preparation-submission.ts";
import { createPostgresDelegationRepository } from "../delegation/postgres.ts";
import type { DelegationRepository, DelegationTransactionHost } from "../delegation/repository.ts";
import type {
  PreparedReservedChannelInstallationV1,
  ReservedChannelInstallationCurrentnessV1,
  ReservedChannelInstallationLocatorV1,
  ReservedChannelInstallationProvisionalV1,
} from "../ports/repositories/channel-bindings.ts";
import type { ChannelInstallation } from "@openclaw-enterprise/contracts/channel-bindings";
import { consumeReservedChannelInstallationAttemptV1 } from "../channel-bindings.ts";
import { createPostgresTurnJournalReplayParticipant } from "./postgres/turn-journal-replay.ts";
import {
  parseReplayReservationTargetV1,
  replayReservationTargetsMatchV1,
} from "../turn-journal/replay-barrier.ts";
import type {
  DeploymentCandidateNormalizerV2,
  DeploymentCandidateOriginalOperationsV2,
  WorkloadProfileCandidateContinuationV2,
} from "../ports/workload-profile-candidate.ts";
import {
  makeTrackedCandidateOperations,
  sameCandidateDataV2,
} from "./postgres/workload-profile-candidate.ts";
import {
  decodeWorkloadProfileSelectionRequestV2,
  type WorkloadProfileSelectionStorageV2,
} from "../workload-profiles/selection.ts";
import type {
  WorkloadProfileSourceEnrollmentV2,
  WorkloadProfileMutationEnrollmentV2,
  WorkloadProfileMutationAccountParticipantV2,
  WorkloadProfileDeploymentUnitV2,
  WorkloadProfileDraftUnitV2,
  WorkloadProfileRecoveryUnitV2,
  WorkloadProfileOwnedOperationV2,
  WorkloadProfileActiveReaderV2,
  WorkloadProfileCandidateContextReaderV2,
  WorkloadProfileCandidateRecordsReaderV2,
  WorkloadProfileCandidateRecordsV2,
} from "../workload-profiles/admitted-use.ts";
import type { DeployAgentCommandInput } from "../services/deployment/port.ts";
import type { UpdateAgentInput } from "../services/agent/port.ts";
import type { WorkloadProfileAccountUnit } from "../services/workload-profile/port.ts";
import type { WorkloadProfileSessionSecurityReaderV1 } from "../ports/workload-profile-session-security.ts";
import { readPostgresWorkloadProfileSessionV1 } from "./postgres/workload-profile-session-security.ts";
import type { AuthenticatedRequestHandleV1 } from "@openclaw-enterprise/contracts/account-authority-v1";
import {
  createWorkloadProfileAdmissionRepositoryV2,
  decodeWorkloadProfileAdmissionHeadV2,
  type WorkloadProfileAdmissionHeadV2,
} from "../workload-profiles/admission-record.ts";
import { createPostgresWorkloadProfileAdmissionBackendV2 } from "./postgres/workload-profile-admission.ts";
import {
  canonicalLifecycleDeployCommandV2,
  parseLifecycleDeployV2,
} from "@openclaw-enterprise/contracts/lifecycle-deploy-v2";
import type { NativeIAMTransactionView } from "@openclaw-enterprise/iam";
import {
  decodeWorkloadProfileSelectionV1,
  decodeWorkloadProfileUseV2,
} from "@openclaw-enterprise/contracts/workload-profile-v1";
import type { GuardedDriverSelection } from "../application/driver-selection.ts";
import {
  TurnCommandScopeV1,
  type TurnCommandAcceptedOperationV1,
  type TurnCommandBoundsV1,
  type TurnCommandIdentityV1,
  type TurnCommandTerminalV1,
} from "./postgres/turn-command-scope.ts";
import {
  createTurnCommandAccountUnitV1,
  type TurnCommandAccountSourceV1,
  type TurnCommandAccountUnitV1,
} from "./postgres/turn-command-owner.ts";
import {
  GatewayStartupOwnerPhaseV1,
  parseGatewayStartupSubjectV2,
  type GatewayStartupCommandV2,
  type GatewayStartupCompletionV2,
  type GatewayStartupOwnerParticipantsV2,
  type GatewayStartupOwnerUnitV2,
  type GatewayStartupTransactionOwnerV2,
  type GatewayStartupTransactionResultV2,
  type GatewayStartupAcceptedOperationV1,
  type GatewayStartupAuthorityLeaseV1,
  type GatewayStartupCommandBoundsV1,
  type GatewayStartupCommandV1,
  type GatewayStartupCompletionV1,
  type GatewayStartupOwnerParticipantsV1,
  type GatewayStartupOwnerUnitV1,
  type GatewayStartupTransactionOwnerV1,
  type GatewayStartupTransactionResultV1,
} from "../gateway-startup-v1/owner.ts";
import {
  createPostgresGatewayStartupV1,
  createPostgresGatewayStartupV2,
} from "../gateway-startup-v1/postgres.ts";
import { createPostgresRevisionRepository } from "./postgres/revisions.ts";
import { createPostgresRevisionCredentialReaderV1 } from "./postgres/credential-record.ts";
import type { RuntimeCredentialSelectionResolverV2 } from "../workload-profiles/credential-record.ts";
import { LifecycleAdmissionUnitPhase } from "../lifecycle/protective-admission-unit.ts";
import { createPostgresLifecycleAdmission } from "./postgres/lifecycle-admission.ts";
import { readPostgresLifecycleStatusV1 } from "./postgres/lifecycle-status.ts";
import type {
  LifecycleStatusReadMethodV1,
  LifecycleStatusReadRequestV1,
  LifecycleStatusReadValueV1,
} from "../lifecycle/status-projector-v1.ts";
import { bindNativeIAMTransaction } from "@openclaw-enterprise/iam";
import { DriverSelection } from "../application/driver-selection.ts";
import { createGuardedWorkloadProfileUnit } from "./postgres/workload-profile-guard.ts";
import type { GuardedWorkloadProfileUnit } from "../services/workload-profile/port.ts";
import { createPostgresWorkloadProfile } from "./postgres/workload-profile.ts";
import { InvalidProfileOperationError, profileUuid } from "../workload-profiles/types.ts";
import {
  CredentialInventoryOwnerPhaseV1,
  WorkloadProfileUnitPhase,
} from "../ports/platform-unit-of-work.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Namespace } from "@openclaw-enterprise/contracts/resources/namespace";
import type { QueryRepositoryFactoryContext } from "../ports/repository-factory.ts";
import type {
  CredentialInventoryTransactionV1,
  CredentialInventoryTransactionOwnerV1,
  CredentialInventoryAcceptingOwnerV1,
  InventoryScopeV1,
  InventoryMutationV1,
  InventoryReadV1,
  InventoryCommitV1,
} from "../credential-inventory-v1/ports.ts";
import type { CredentialStorageCallBoundsV1 } from "@openclaw-enterprise/contracts/credential-storage-v1";
import { createPostgresRuntimePreparation } from "./postgres/runtime-preparation.ts";
import { createPostgresRuntimeEffectAdmission } from "./postgres/runtime-effect-admission.ts";
import { retainRuntimePreparationOriginV1 } from "./postgres/runtime-preparation-origin.ts";
import { parseRuntimePreparationSessionOriginV1 } from "../runtime-preparation/origin.ts";
import type {
  RuntimePreparationCurrentUseRequestV1,
  RuntimePreparationCurrentUseLeaseV1,
} from "../runtime-preparation/current-use.ts";
import {
  canonicalRuntimePreparation,
  requirePreparation,
  samePreparationValue,
} from "../runtime-preparation/types.ts";
import {
  decodeRuntimePreparationOperation,
  projectRuntimePreparation,
} from "../runtime-preparation/repository.ts";
import type { WorkloadProfileAdmissionRecordV2 } from "../workload-profiles/selection.ts";
import type { WorkloadProfileCapabilitySourceV2 } from "../workload-profiles/selection.ts";
import { deriveWorkloadProfileManifestV2 } from "../workload-profiles/projections.ts";
import type { RuntimePreparationSubmissionResultV1 } from "../runtime-preparation/submission.ts";
import { RepositoryTransactionLifetime } from "../ports/transaction.ts";
import { bindRepository } from "../ports/repository-factory.ts";
import type { ProviderAccountLinks } from "../ports/provider-account-links.ts";
import { createPostgresProviderAccountLinks } from "./postgres/provider-account-links.ts";
import { createPostgresNamespaceRepository } from "./postgres/namespaces.ts";
import { createPostgresConfigurationRepository } from "./postgres/configurations.ts";
import { createPostgresSecretRepository } from "./postgres/secrets.ts";
import { createPostgresServiceAccountRepository } from "./postgres/service-accounts.ts";
import { createPostgresChannelBindingRepository } from "./postgres/channel-bindings.ts";
import { createPlatformReadView } from "../ports/platform-read-view.ts";
import { bindPlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
import { PostgresCommitOutcomeUnknownError } from "../ports/transaction-errors.ts";
import {
  createPostgresTurnJournal,
  type PostgresTurnJournalOptions,
} from "../turn-journal/postgres.ts";
import { TurnJournalTransactionGuard } from "../turn-journal/transaction-guard.ts";
import { createRuntimeServiceTrustRepository } from "../runtime-authority/service-trust.ts";
import { parseRuntimeServiceTrustRecord } from "../runtime-authority/service-trust-schema.ts";
import {
  createRuntimeAuthorityRepository,
  RuntimeAuthorityTransactionGuard,
  type StoredRuntimeAuthorityOperation,
} from "../runtime-authority/repository.ts";
import { parseRuntimeAuthorityV1 } from "@openclaw-enterprise/contracts";
import { randomUUID } from "node:crypto";
import type {
  AccessBinding,
  Agent,
  AgentRevision,
  AuditEvent,
  Group,
  GroupMembership,
  Identity,
  Installation,
  Permission,
  Principal,
  Restriction,
  Role,
  SecretBindings,
} from "@openclaw-enterprise/contracts";
import {
  decodeChannelAdministrationMappingV1,
  normalizeSecretBindings,
  RESOURCE_KINDS as PLATFORM_RESOURCE_KINDS,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../errors.ts";
import {
  serializeChannelBindingMutations,
  serializeRuntimeAssignmentMutations,
  isRuntimeAdmissionAudit,
  workloadProfileAdmissionAuditV2,
} from "./platform-state.ts";
import type {
  RuntimeAssignmentRepository,
  RuntimeAdmissionRepository,
  RevisionRuntimeAdmission,
  RuntimeIntent,
  RuntimeAllocation,
  RuntimeScope,
  RuntimeIntentAttribution,
  AgentRepository,
  InstallationRepository,
  PlatformAuditSink,
  PlatformOperation,
  PlatformReadView,
  PlatformAuditRepository,
  PlatformStateStore,
  PlatformReadOptions,
  PlatformUnitOfWork,
} from "./platform-state.ts";
import {
  PostgresWorkQueue,
  type PostgresQueryClient,
  type PostgresWorkQueueOptions,
} from "./postgres-work-queue.ts";

type PostgresRow = Record<string, unknown>;

export interface PostgresClient extends PostgresQueryClient {
  on?(event: "error", listener: (error: Error) => void): unknown;
  removeListener?(event: "error", listener: (error: Error) => void): unknown;
  release(destroy?: boolean): void;
}

export interface PostgresPool {
  readonly options?: {
    readonly connectionTimeoutMillis?: number | undefined;
    readonly max?: number | undefined;
    readonly pipeline?: boolean;
    readonly onConnect?: unknown;
    readonly verify?: unknown;
    readonly Client?: unknown;
  };
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
}

export interface PersistedNativeIAMState {
  readonly identities: readonly Identity[];
  readonly groups: readonly Group[];
  readonly memberships: readonly GroupMembership[];
  readonly roles: readonly Role[];
  readonly bindings: readonly AccessBinding[];
  readonly restrictions: readonly Restriction[];
}

declare const freshInstallationReservation: unique symbol;
/** Issued only after this exact store has acknowledged its original fresh INSERT.
 * Runtime recognition is private object identity, never the public Installation. */
export interface FreshInstallationReservationV1 {
  readonly [freshInstallationReservation]: true;
  readonly installation: Readonly<Installation>;
}
interface FreshInstallationRecordV1 {
  readonly installation: Readonly<Installation>;
  readonly rowVersion: string;
}
export interface FreshBootstrapFailureReceiptV1 {
  readonly schema: "fresh-bootstrap-failure-v1";
  readonly stage:
    | "preflight"
    | "checkout"
    | "begin"
    | "installation-lock"
    | "installation-match"
    | "iam-writer-lock"
    | "iam-empty-read"
    | "iam-empty-check"
    | "iam-seed-write"
    | "bootstrap-callback"
    | "completion-check"
    | "commit"
    | "transport"
    | "terminal-cleanup"
    | "unknown";
  readonly sqlstate:
    | "42501"
    | "55P03"
    | "57014"
    | "40P01"
    | "40001"
    | "23001"
    | "23505"
    | "23503"
    | "23514"
    | "23502"
    | "55000"
    | "25P02"
    | "25006"
    | "42P01"
    | "42883"
    | "08003"
    | "08006"
    | "57P01"
    | null;
  readonly commitDisposition: "not-sent" | "sent" | "acknowledged";
  readonly establishedNoCommit: boolean;
}
type FreshBootstrapFailureStageV1 = FreshBootstrapFailureReceiptV1["stage"];
interface FreshBootstrapExecutionV1 {
  readonly kind: "reserve" | "finalize";
  readonly installation: Readonly<Installation>;
  readonly rowVersion?: string;
  readonly seed?: PersistedNativeIAMState;
  readonly pending: Set<Promise<unknown>>;
  readonly namespaceIds: Set<string>;
  readonly workNamespaceIds: Set<string>;
  readonly auditNamespaceIds: Set<string>;
  active: boolean;
  accepting: boolean;
  started: boolean;
  failed: boolean;
  failure?: unknown;
  diagnostic?: Readonly<
    Pick<FreshBootstrapFailureReceiptV1, "stage" | "sqlstate"> & {
      failure: unknown;
    }
  >;
  context?: TransactionContext;
  transaction?: Promise<unknown>;
  disposition: "not-sent" | "sent" | "acknowledged";
  establishedNoCommit: boolean;
}

export interface PostgresPlatformStateOptions {
  readonly bootstrapNativeIAM?: PersistedNativeIAMState;
  readonly turnJournal?: PostgresTurnJournalOptions;
}

export interface PersistedNativeIAMPrincipalSeed {
  readonly principal: Principal;
  readonly roles: readonly Role[];
  readonly bindings: readonly AccessBinding[];
}

export { PostgresCommitOutcomeUnknownError } from "../ports/transaction-errors.ts";

type ProfileDeploymentBindingV2 = readonly [principalId: string, input: DeployAgentCommandInput];
type ProfileDraftBindingV2 = readonly [principalId: string, input: UpdateAgentInput];
interface ProfileCandidateSlotV2 {
  accepting: boolean;
  completed: boolean;
  headStarted: boolean;
  head?: WorkloadProfileAdmissionHeadV2;
  readonly sourceIdentity: object;
  observations?: Pick<
    WorkloadProfileCandidateRecordsV2,
    "agent" | "serviceAccount" | "providerBinding" | "secrets"
  >;
  snapshot?: Readonly<AgentRevision>;
  configuration?: Awaited<
    ReturnType<WorkloadProfileCandidateContextReaderV2["readLocked"]>
  >["configuration"];
  failed: boolean;
  first?: unknown;
  readonly pending: Set<Promise<void>>;
  assertCurrent(): undefined;
}
interface ProfileSelectedEnrollmentV2 {
  readonly context: TransactionContext;
  readonly io: WorkloadProfileOwnedOperationV2;
  readonly selection: DriverSelection;
  readonly profileToken: object;
  readonly profileOwner: ReturnType<typeof createGuardedWorkloadProfileUnit>;
  readonly platform: PlatformUnitOfWork;
  readonly deploymentBinding?: ProfileDeploymentBindingV2;
  active: boolean;
  candidate?: ProfileCandidateSlotV2;
}
interface ChannelFirstCreateExecutionV1 {
  readonly prepared: PreparedReservedChannelInstallationV1;
  readonly locator: ReservedChannelInstallationLocatorV1;
  readonly currentness: ReservedChannelInstallationCurrentnessV1;
  readonly assertSelectedIAM: ReservedChannelInstallationCurrentnessV1["assertSelectedIAM"];
  checking: boolean;
  failed: boolean;
  failure?: unknown;
  reserved: boolean;
  inserted: boolean;
  audited: boolean;
  completed: boolean;
  noEffect: boolean;
}
interface TransactionContext {
  channelFirstCreate?: ChannelFirstCreateExecutionV1;
  readonly channelCreateQuery: PostgresClient["query"];
  readonly fresh?: FreshBootstrapExecutionV1;
  readonly turn?: TurnCommandExecutionV1;
  readonly turnQuery: PostgresClient["query"];
  readonly gateway?: GatewayStartupExecution;
  readonly gatewayQuery: PostgresClient["query"];
  readonly credential?: CredentialInventoryExecutionV1;
  readonly credentialQuery: PostgresClient["query"];
  profilePolicyLocked?: boolean;
  profileToken?: object;
  profileMutation?: boolean;
  protectedProfile?: ReturnType<typeof createGuardedWorkloadProfileUnit>;
  readView?: PlatformReadView;
  readonly lifetime: RepositoryTransactionLifetime;
  readonly assertOwnerActive: () => void;
  readonly readOnly: boolean;
  readonly profileSignal: AbortSignal;
  readonly abortProfile: () => void;
  dataQueryStarted: boolean;
  readonly profileEnrollments: Set<Promise<unknown>>;
  profileEnrollmentClosed: boolean;
  readonly authorityGuard: RuntimeAuthorityTransactionGuard;
  readonly journalGuard: TurnJournalTransactionGuard;
  readonly lifecyclePhase: LifecycleAdmissionUnitPhase;
  readonly lifecycleQuery: PostgresClient["query"];
  readonly profilePhase: WorkloadProfileUnitPhase;
  readonly profileQuery: PostgresClient["query"];
  readonly client: PostgresClient;
  installation: Readonly<Installation> | undefined;
  installationLoaded: boolean;
}

interface TurnCommandExecutionV1 {
  readonly identity: TurnCommandIdentityV1;
  readonly bounds: TurnCommandBoundsV1;
  phase?: TurnCommandScopeV1;
  sent?: boolean;
  acknowledged?: boolean;
  close(): void;
}

interface TurnCommandIOV1 {
  readonly record: TurnCommandEnrollmentV1;
  readonly pending: Set<Promise<unknown>>;
  readonly operation?: TurnCommandAcceptedOperationV1;
  accepting: boolean;
  active: boolean;
}

interface TurnCommandEnrollmentV1 {
  readonly context: TransactionContext;
  readonly execution: TurnCommandExecutionV1;
  readonly phase: TurnCommandScopeV1;
  readonly selected: GuardedDriverSelection<"iam">;
  readonly nativeIAM: NativeIAMTransactionView;
  policyState: "unlocked" | "locking" | "locked";
  parentsLocked: boolean;
  active: boolean;
}

/** Private accepting composition only. Shape is not authentication. No public
 * options/registration accepts arbitrary positive account callbacks. */
interface TurnCommandCentralSourceV1 {
  readonly driverSelection: DriverSelection;
  readonly account: TurnCommandAccountSourceV1;
}

type CredentialAcceptanceModeV1 = keyof CredentialInventoryAcceptingOwnerV1;
type CredentialAcceptanceInputV1 = InventoryMutationV1 | InventoryReadV1;
type CredentialAcceptanceAuthorityV1 = Parameters<
  CredentialInventoryAcceptingOwnerV1[CredentialAcceptanceModeV1]
>[1];

/** Private obligations of the genuine producers. No positive implementation or
 * public configuration entry is supplied while their correspondence is absent. */
interface CredentialInventoryOwnerParticipantsV1 {
  /** This owner context is not directly PostgresCredentialInventoryContextV1.
   * Genuine composition also supplies assertPreparing(stage), assertWriting and
   * recordEffect on the same tracked query/lifetime and authentic invocation.
   * The backend scope helper is an alternative to the owner's preparation,
   * never a second upstream-lock pass; a structural cast supplies none of these. */
  bind(
    context: QueryRepositoryFactoryContext & {
      readonly inventoryScope: InventoryScopeV1;
      readonly commitRef: string;
      readonly phase: { assertActive(): void; poison(error: unknown): void };
    },
  ): CredentialInventoryBoundParticipantV1;
  acknowledgedAt(): string;
}

interface CredentialInventoryBoundParticipantV1 {
  readonly repository: CredentialInventoryTransactionV1;
  readonly acceptingOwner: CredentialInventoryAcceptingOwnerV1;
  /** Authenticate/enroll using the genuine upstream account/policy order. This
   * does not complete acceptance; the accepting owner rechecks after our locks. */
  enroll(
    mode: CredentialAcceptanceModeV1,
    input: CredentialAcceptanceInputV1,
    authority: CredentialAcceptanceAuthorityV1,
  ): Promise<void>;
  prepareCommit(): Promise<void>;
  assertCommitReady(): void;
  close(): void;
  /** Separate participant leases outlive query teardown and outcome settlement. */
  release(): void;
}

interface CredentialInventoryExecutionV1 {
  readonly phase: CredentialInventoryOwnerPhaseV1;
  readonly prepareCommit: () => Promise<void>;
  readonly assertCommitReady: () => void;
  readonly observeAcknowledgment: () => void;
  readonly close: () => void;
  disposition: "not-sent" | "sent" | "acknowledged";
  establishedNoCommit: boolean;
}

interface CredentialInventoryOwnerBindingV1 {
  readonly transactions: CredentialInventoryTransactionOwnerV1;
  readonly acceptingOwner: CredentialInventoryAcceptingOwnerV1;
}

interface CredentialInventoryEnrollmentV1 {
  readonly phase: CredentialInventoryOwnerPhaseV1;
  readonly context: TransactionContext;
  readonly scope: InventoryScopeV1;
  readonly participant: CredentialInventoryBoundParticipantV1;
  transaction?: CredentialInventoryTransactionV1;
  accepted?: {
    readonly mode: CredentialAcceptanceModeV1;
    readonly input: CredentialAcceptanceInputV1;
  };
  active: boolean;
}

/** Private central-to-execute bridge. execute owns phase construction/finalization
 * and terminal disposition; the binding owns only its token correspondence. */
interface GatewayStartupExecutionV1 {
  readonly version?: 1;
  phase?: GatewayStartupOwnerPhaseV1;
  finalized?: GatewayStartupCompletionV1;
  disposition: "not-sent" | "sent" | "acknowledged";
  establishedNoCommit: boolean;
  close(): void;
}

interface GatewayStartupExecutionV2 extends Omit<
  GatewayStartupExecutionV1,
  "version" | "phase" | "finalized"
> {
  readonly version: 2;
  phase?: GatewayStartupOwnerPhaseV1<GatewayStartupCompletionV2>;
  finalized?: GatewayStartupCompletionV2;
}
type GatewayStartupExecution = GatewayStartupExecutionV1 | GatewayStartupExecutionV2;

/** Borrowed only during the actual authority.consume operation. Holding this
 * facade supplies neither invocation authentication nor a permission decision. */
interface GatewayStartupPrivatePolicyV1 {
  lockPolicy(): Promise<void>;
  readonly iam: NativeIAMTransactionView;
}

type GatewayStartupRuntimeConsumeV1 = GatewayStartupOwnerParticipantsV1["authority"]["consume"];

/** TODO: Supply the genuine authority/selected-definition/process/audit producer
 * join when its same-client policy contract is implemented and reviewed. The
 * extra private policy argument is a new required join, not a released producer. */
interface GatewayStartupCentralParticipantsV1 extends Omit<
  GatewayStartupOwnerParticipantsV1,
  "authority"
> {
  readonly driverSelection: DriverSelection;
  readonly authority: {
    consume(
      ...args: [
        ...Parameters<GatewayStartupRuntimeConsumeV1>,
        policy: GatewayStartupPrivatePolicyV1,
      ]
    ): ReturnType<GatewayStartupRuntimeConsumeV1>;
  };
}

interface GatewayStartupOwnerBindingV1 {
  readonly transaction: GatewayStartupTransactionOwnerV1;
  readonly participants?: GatewayStartupOwnerParticipantsV1;
}

interface GatewayStartupEnrollmentV1 {
  readonly version: 1;
  readonly installationId: string;
  readonly context: TransactionContext;
  readonly phase: GatewayStartupOwnerPhaseV1;
  readonly execution: GatewayStartupExecutionV1;
  readonly command: GatewayStartupCommandV1;
  readonly bounds: GatewayStartupCommandBoundsV1;
  readonly unit: GatewayStartupOwnerUnitV1;
  readonly policy: object;
  readonly token: object;
  readonly selected: GuardedDriverSelection<"iam">;
  readonly nativeIAM: NativeIAMTransactionView;
  authorityIO?: GatewayStartupAcceptedOperationV1 | undefined;
  authorityStarted: boolean;
  policyState: "unlocked" | "locking" | "locked";
  active: boolean;
}

type GatewayStartupRuntimeConsumeV2 = GatewayStartupOwnerParticipantsV2["authority"]["consume"];
interface GatewayStartupCentralParticipantsV2 extends Omit<
  GatewayStartupOwnerParticipantsV2,
  "authority" | "selection"
> {
  readonly selection: RuntimeCredentialSelectionResolverV2;
  readonly driverSelection: DriverSelection;
  readonly authority: {
    consume(
      ...args: [
        ...Parameters<GatewayStartupRuntimeConsumeV2>,
        policy: GatewayStartupPrivatePolicyV1,
      ]
    ): ReturnType<GatewayStartupRuntimeConsumeV2>;
  };
}
interface GatewayStartupOwnerBindingV2 {
  readonly transaction: GatewayStartupTransactionOwnerV2;
  readonly participants?: GatewayStartupOwnerParticipantsV2;
}
interface GatewayStartupEnrollmentV2 extends Omit<
  GatewayStartupEnrollmentV1,
  "version" | "phase" | "execution" | "command" | "unit"
> {
  readonly version: 2;
  readonly phase: GatewayStartupOwnerPhaseV1<GatewayStartupCompletionV2>;
  readonly execution: GatewayStartupExecutionV2;
  readonly command: GatewayStartupCommandV2;
  readonly unit: GatewayStartupOwnerUnitV2;
  selectionIO?: GatewayStartupAcceptedOperationV1;
}
type GatewayStartupEnrollment = GatewayStartupEnrollmentV1 | GatewayStartupEnrollmentV2;
interface GatewayStartupRunV1 {
  readonly version: 1;
  readonly args: Parameters<GatewayStartupTransactionOwnerV1["run"]>;
  readonly selection: DriverSelection | undefined;
  readonly participants: GatewayStartupOwnerParticipantsV1 | undefined;
}
interface GatewayStartupRunV2 {
  readonly version: 2;
  readonly args: Parameters<GatewayStartupTransactionOwnerV2["run"]>;
  readonly selection: DriverSelection | undefined;
  readonly participants: GatewayStartupOwnerParticipantsV2 | undefined;
}

const PERMISSION_ACTIONS = new Set([
  "create",
  "read",
  "update",
  "delete",
  "deploy",
  "operate",
  "administer",
]);
const RESOURCE_KINDS = new Set<string>(PLATFORM_RESOURCE_KINDS);
const AUDIT_METADATA_KEY = "__occAuditMetadata";
const SECRET_IDENTIFIER =
  /^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAMESPACE_IDENTIFIER =
  /^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function runtimeGeneration(row: PostgresRow, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new DependencyUnavailableError("The stored runtime generation is invalid.");
  return value;
}
function runtimeIntentFromRow(row: PostgresRow): Readonly<RuntimeIntent> {
  const desiredMode = text(row, "desired_mode");
  if (desiredMode !== "running" && desiredMode !== "disabled" && desiredMode !== "stopped")
    throw new DependencyUnavailableError("The stored runtime intent mode is invalid.");
  const revisionId = optionalText(row, "revision_id") ?? null;
  if (
    (desiredMode === "running" || Number(row.admission_version ?? 0) === 0) &&
    revisionId === null
  )
    throw new DependencyUnavailableError("The stored runtime revision is missing.");
  const identity = {
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
    installationId: text(row, "installation_id"),
    transitionRef: text(row, "transition_ref"),
    generation: runtimeGeneration(row, "generation"),
    actorId: text(row, "actor_id"),
    requestId: text(row, "request_id"),
    createdAt: timestamp(row, "created_at"),
  };
  return desiredMode === "running"
    ? immutableCopy({ ...identity, desiredMode, revisionId: text(row, "revision_id") })
    : immutableCopy({ ...identity, desiredMode, revisionId });
}
function revisionAdmissionFromRow(row: PostgresRow): Readonly<RevisionRuntimeAdmission> {
  return immutableCopy({
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
    revisionId: text(row, "revision_id"),
    runtimeTransitionRef: text(row, "runtime_transition_ref"),
    lifecycleGeneration: runtimeGeneration(row, "lifecycle_generation"),
    auditEventId: text(row, "audit_event_id"),
  });
}
function runtimeAllocationFromRow(row: PostgresRow): Readonly<RuntimeAllocation> {
  const component = text(row, "component");
  if (
    (component !== "gateway" && component !== "harness") ||
    text(row, "binding_condition") !== "unbound"
  )
    throw new DependencyUnavailableError("The stored runtime allocation is invalid.");
  return immutableCopy({
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
    installationId: text(row, "installation_id"),
    assignmentRef: text(row, "assignment_ref"),
    createEffectRef: text(row, "create_effect_ref"),
    revisionId: text(row, "revision_id"),
    servicePrincipalId: text(row, "service_principal_id"),
    lifecycleGeneration: runtimeGeneration(row, "lifecycle_generation"),
    component,
    runtimeGeneration: runtimeGeneration(row, "runtime_generation"),
    providerProfileRef: text(row, "provider_profile_ref"),
    runtimeProfileRef: text(row, "runtime_profile_ref"),
    identityProfileRef: text(row, "identity_profile_ref"),
    bindingCondition: "unbound",
    createdAt: timestamp(row, "created_at"),
  });
}

function rows(value: unknown[]): PostgresRow[] {
  return value.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row))
      throw new DependencyUnavailableError("The persistence repository returned invalid data.");
    return row as PostgresRow;
  });
}

function text(row: PostgresRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0)
    throw new DependencyUnavailableError("Persisted platform state is invalid or incomplete.");
  return value;
}

function optionalText(row: PostgresRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  return text(row, key);
}

function timestamp(row: PostgresRow, key: string): string {
  const value = row[key];
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime()))
    throw new DependencyUnavailableError("Persisted platform state has an invalid timestamp.");
  return date.toISOString();
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new DependencyUnavailableError("Persisted platform state contains invalid JSON.");
  return parsed as Record<string, unknown>;
}

function installationFromRow(row: PostgresRow): Readonly<Installation> {
  return immutableCopy({
    id: text(row, "id"),
    name: text(row, "name"),
    createdAt: timestamp(row, "created_at"),
  });
}

function agentFromRow(row: PostgresRow): Readonly<Agent> {
  const selection =
    row.workload_profile_selection == null
      ? undefined
      : decodeWorkloadProfileSelectionV1(row.workload_profile_selection);
  if (selection?.kind === "invalid")
    throw new DependencyUnavailableError("Persisted Agent workload selection is invalid.");
  const activeRevisionId = optionalText(row, "active_revision_id");
  const serviceAccountId = optionalText(row, "service_account_id");
  const providerId = row.provider_id === null ? null : text(row, "provider_id");
  return immutableCopy({
    id: text(row, "id"),
    namespaceId: text(row, "namespace_id"),
    name: text(row, "name"),
    configurationId: text(row, "configuration_id"),
    providerId,
    executionMode: text(row, "execution_mode") as Agent["executionMode"],
    ...(selection === undefined ? {} : { workloadProfileSelection: selection.value }),
    servicePrincipalId: text(row, "service_principal_id"),
    ...(serviceAccountId === undefined ? {} : { serviceAccountId }),
    ...(activeRevisionId === undefined ? {} : { activeRevisionId }),
    createdAt: timestamp(row, "created_at"),
  });
}

function revisionFromRow(row: PostgresRow): Readonly<AgentRevision> {
  const rawNumber = row.revision_number;
  const revision = typeof rawNumber === "string" ? Number(rawNumber) : rawNumber;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0)
    throw new DependencyUnavailableError("Persisted AgentRevision numbering is invalid.");
  const admitted = jsonObject(row.admitted_spec) as {
    configuration_id: AgentRevision["configurationId"];
    configuration_kind: AgentRevision["configurationKind"];
    configuration_generation: AgentRevision["configurationGeneration"];
    draft_spec: AgentRevision["configuration"];
    harness: AgentRevision["harness"];
    compute: AgentRevision["compute"];
    sandbox_driver_id?: AgentRevision["sandboxDriverId"];
    service_account?: AgentRevision["serviceAccount"];
    secret_driver_id?: AgentRevision["secretDriverId"];
    secret_bindings?: AgentRevision["secretBindings"];
    workload_profile_use?: AgentRevision["workloadProfileUse"];
  };
  const use =
    admitted.workload_profile_use === undefined
      ? undefined
      : decodeWorkloadProfileUseV2(admitted.workload_profile_use);
  if (
    use?.kind === "invalid" ||
    (use !== undefined && use.value.namespaceId !== text(row, "namespace_id"))
  )
    throw new DependencyUnavailableError("Persisted revision workload profile Use is invalid.");
  const secretBindings =
    admitted.secret_bindings === undefined
      ? undefined
      : secretBindingsFromJson(
          admitted.secret_bindings,
          text(row, "namespace_id"),
          use !== undefined,
        );
  return immutableCopy({
    id: text(row, "id"),
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
    revision,
    providerId: row.provider_id === null ? null : text(row, "provider_id"),
    configurationId: admitted.configuration_id,
    configurationKind: admitted.configuration_kind,
    configurationGeneration: admitted.configuration_generation,
    configuration: admitted.draft_spec,
    harness: admitted.harness,
    compute: admitted.compute,
    ...(use === undefined ? {} : { workloadProfileUse: use.value }),
    ...(admitted.sandbox_driver_id === undefined
      ? {}
      : { sandboxDriverId: admitted.sandbox_driver_id }),
    ...(admitted.secret_driver_id === undefined
      ? {}
      : { secretDriverId: admitted.secret_driver_id }),
    ...(secretBindings === undefined ? {} : { secretBindings }),
    ...(admitted.service_account === undefined ? {} : { serviceAccount: admitted.service_account }),
    servicePrincipalId: text(row, "service_principal_id"),
    createdAt: timestamp(row, "admitted_at"),
  });
}

function secretBindingsFromJson(
  value: unknown,
  namespaceId: string,
  preserveEmpty = false,
): SecretBindings | undefined {
  if (!NAMESPACE_IDENTIFIER.test(namespaceId))
    throw new DependencyUnavailableError("Persisted Secret bindings have an invalid Namespace.");
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  } catch {
    throw new DependencyUnavailableError("Persisted Secret bindings are invalid.");
  }
  let normalized: SecretBindings;
  try {
    normalized = normalizeSecretBindings(parsed);
  } catch {
    throw new DependencyUnavailableError("Persisted Secret bindings are invalid.");
  }
  for (const { source } of Object.values(normalized)) {
    if (source.namespaceId !== namespaceId || !SECRET_IDENTIFIER.test(source.id))
      throw new DependencyUnavailableError("Persisted Secret bindings reference invalid Secrets.");
  }
  return Object.keys(normalized).length === 0 && !preserveEmpty
    ? undefined
    : immutableCopy(normalized);
}

function secretBindingsFromState(
  value: SecretBindings,
  namespaceId: string,
  preserveEmpty = false,
): SecretBindings | undefined {
  try {
    return secretBindingsFromJson(value, namespaceId, preserveEmpty);
  } catch (error) {
    if (error instanceof DependencyUnavailableError)
      throw new ScopeViolationError("Secret bindings are invalid.");
    throw error;
  }
}

function serializeSecretBindings(
  namespaceId: string,
  bindings: SecretBindings | undefined,
): string | null {
  const normalized =
    bindings === undefined ? undefined : secretBindingsFromState(bindings, namespaceId);
  return normalized === undefined ? null : JSON.stringify(normalized);
}

function referencedSecretIds(
  namespaceId: string,
  bindings: SecretBindings | undefined,
): readonly string[] {
  const normalized =
    bindings === undefined ? undefined : secretBindingsFromState(bindings, namespaceId);
  if (normalized === undefined) return Object.freeze([]);
  return Object.freeze(
    Array.from(new Set(Object.values(normalized).map(({ source }) => source.id))),
  );
}

function databaseError(error: unknown): Error {
  if (
    error instanceof ScopeViolationError ||
    error instanceof DependencyUnavailableError ||
    !(error instanceof Error)
  )
    return error instanceof Error
      ? error
      : new DependencyUnavailableError("The platform persistence repository is unavailable.");

  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === "23505")
    return new ResourceConflictError(
      "A platform resource with this identity or name already exists.",
    );
  if (
    code === "23001" ||
    code === "23503" ||
    code === "23514" ||
    code === "23502" ||
    code === "55000"
  )
    return new ScopeViolationError("The resource violates its exact platform ownership or state.");
  if (
    code?.startsWith("08") ||
    code?.startsWith("53") ||
    code?.startsWith("57") ||
    code === "3D000" ||
    code === "3F000" ||
    code === "42P01" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT"
  )
    return new DependencyUnavailableError("The platform persistence repository is unavailable.");
  return error;
}

function commitRejectionEstablishesNoCommit(error: unknown): boolean {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  // Only explicit rollback or constraint rejection from the COMMIT request
  // establishes no commit. Other codes, including 40003, remain uncertain.
  return (
    code === "40001" ||
    code === "40P01" ||
    code === "23001" ||
    code === "23502" ||
    code === "23503" ||
    code === "23505" ||
    code === "23514" ||
    code === "23P01"
  );
}

function auditDetails(event: AuditEvent): Record<string, unknown> | undefined {
  const details: Record<string, unknown> = { ...(event.details ?? {}) };
  if (AUDIT_METADATA_KEY in details)
    throw new ScopeViolationError("The audit details contain reserved persistence metadata.");

  const metadata: Record<string, unknown> = {};
  for (const key of [
    "schemaVersion",
    "source",
    "requestId",
    "admissionDecisionId",
    "actor",
    "iamDriverId",
    "authorization",
    "decisionReason",
    "reasonCode",
  ] as const) {
    const value = event[key];
    if (value !== undefined) metadata[key] = value;
  }
  if (Object.keys(metadata).length > 0) details[AUDIT_METADATA_KEY] = metadata;
  return Object.keys(details).length > 0 ? details : undefined;
}

function auditFromRow(row: PostgresRow, installationId: string): Readonly<AuditEvent> {
  const namespaceId = optionalText(row, "namespace_id");
  const resourceKind = text(row, "resource_kind");
  const outcome = text(row, "outcome");
  const kind = text(row, "kind");
  if (
    !RESOURCE_KINDS.has(resourceKind) ||
    !["success", "denied", "failure"].includes(outcome) ||
    !["bootstrap", "mutation", "authorization_denial"].includes(kind)
  )
    throw new DependencyUnavailableError("Persisted audit evidence contains an invalid event.");

  const rawDetails = row.details === null ? undefined : jsonObject(row.details);
  const details = rawDetails === undefined ? undefined : { ...rawDetails };
  const rawMetadata = details?.[AUDIT_METADATA_KEY];
  if (details !== undefined) delete details[AUDIT_METADATA_KEY];
  const metadata = rawMetadata === undefined ? {} : jsonObject(rawMetadata);

  return immutableCopy({
    id: text(row, "id"),
    installationId,
    ...(namespaceId === undefined ? {} : { namespaceId }),
    occurredAt: timestamp(row, "occurred_at"),
    kind: kind as AuditEvent["kind"],
    actorId: text(row, "actor_id"),
    action: text(row, "action"),
    resource: {
      kind: resourceKind as AuditEvent["resource"]["kind"],
      id: text(row, "resource_id"),
      ...(namespaceId === undefined ? {} : { namespaceId }),
    },
    outcome: outcome as AuditEvent["outcome"],
    ...metadata,
    ...(details === undefined || Object.keys(details).length === 0 ? {} : { details }),
  });
}

function permissions(value: unknown): readonly Permission[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed))
    throw new DependencyUnavailableError("Persisted IAM permissions must be an array.");
  return Object.freeze(
    parsed.map((permission): Permission => {
      if (
        permission === null ||
        typeof permission !== "object" ||
        typeof permission.action !== "string" ||
        !PERMISSION_ACTIONS.has(permission.action) ||
        typeof permission.resourceKind !== "string" ||
        !RESOURCE_KINDS.has(permission.resourceKind)
      )
        throw new DependencyUnavailableError("Persisted IAM permissions are invalid.");
      return immutableCopy({
        action: permission.action as Permission["action"],
        resourceKind: permission.resourceKind as Permission["resourceKind"],
      });
    }),
  );
}

export class PostgresPlatformState implements PlatformStateStore {
  readonly auditSink: PlatformAuditSink;
  private readonly pool: PostgresPool;
  private readonly turnJournal: PostgresTurnJournalOptions | undefined;
  private bootstrapNativeIAM: PersistedNativeIAMState | undefined;
  private readonly contexts = new WeakMap<PlatformReadView, TransactionContext>();
  private readonly delegationRepositories = new WeakMap<PlatformUnitOfWork, DelegationRepository>();
  readonly #profileContexts = new WeakMap<object, TransactionContext>();
  readonly #channelCreationFailures = new WeakMap<
    object,
    Readonly<ReservedChannelInstallationLocatorV1> | null
  >();
  readonly #credentialExecution = new AsyncLocalStorage<CredentialInventoryEnrollmentV1>();
  readonly #gatewayExecution = new AsyncLocalStorage<GatewayStartupEnrollment>();
  readonly #gatewayContexts = new WeakMap<object, GatewayStartupEnrollment>();
  readonly #gatewaySourceSelections = new WeakMap<object, DriverSelection>();
  readonly #outerExecution = new AsyncLocalStorage<true>();
  readonly #profileAmbient = new AsyncLocalStorage<{
    context: TransactionContext;
    platform: PlatformUnitOfWork;
  }>();
  readonly #profileAccounts = new WeakMap<
    WorkloadProfileAccountUnit,
    ReturnType<typeof createGuardedWorkloadProfileUnit>
  >();
  readonly #profileSourceSelections = new WeakMap<WorkloadProfileAccountUnit, DriverSelection>();
  readonly #profileSelectedUnits = new WeakMap<object, ProfileSelectedEnrollmentV2>();
  readonly #freshReservations = new WeakMap<object, FreshInstallationRecordV1>();
  readonly #freshExecution = new AsyncLocalStorage<FreshBootstrapExecutionV1>();
  // Diagnostic associations never participate in reservation or transaction authority.
  readonly #freshFailureStages = new AsyncLocalStorage<{
    readonly record: FreshBootstrapExecutionV1;
    readonly stage: FreshBootstrapFailureStageV1;
  }>();
  readonly #freshFailureReceipts = new WeakMap<object, FreshBootstrapFailureReceiptV1 | null>();
  readonly #turnExecution = new AsyncLocalStorage<TurnCommandEnrollmentV1>();
  readonly #turnContexts = new WeakMap<object, TurnCommandEnrollmentV1>();
  readonly #turnIO = new AsyncLocalStorage<TurnCommandIOV1>();
  readonly #turnChild = new AsyncLocalStorage<{ readonly io: TurnCommandIOV1; active: boolean }>();

  constructor(pool: PostgresPool, options: PostgresPlatformStateOptions = {}) {
    this.pool = pool;
    this.turnJournal = options.turnJournal;
    this.bootstrapNativeIAM = options.bootstrapNativeIAM;
    this.auditSink = {
      append: async (event) => this.transact(async (state) => state.audit.append(event)),
    };
  }

  /** Diagnostic correlation for this state's exact failed command only. The
   * locator proves neither commit nor permission to retry or recover. */
  channelFirstCreateFailureLocatorV1(
    error: unknown,
  ): Readonly<ReservedChannelInstallationLocatorV1> | undefined {
    if ((typeof error !== "object" || error === null) && typeof error !== "function")
      return undefined;
    return this.#channelCreationFailures.get(error) ?? undefined;
  }

  private rememberChannelFailure(context: TransactionContext | undefined, error: unknown): void {
    const locator = context?.channelFirstCreate?.locator;
    if (!locator || ((typeof error !== "object" || error === null) && typeof error !== "function"))
      return;
    if (this.#channelCreationFailures.has(error)) this.#channelCreationFailures.set(error, null);
    else this.#channelCreationFailures.set(error, locator);
  }

  private recordChannelFirstCreateFailure(context: TransactionContext, error: unknown): unknown {
    context.lifecyclePhase.poisonChannelFirstCreate(error);
    try {
      context.lifecyclePhase.assertChannelOutcome();
    } catch (first) {
      error = first;
    }
    const execution = context.channelFirstCreate;
    if (execution) {
      execution.failed = true;
      execution.failure = error;
    }
    return error;
  }

  private rejectChannelFirstCreate(context: TransactionContext, error: unknown): never {
    throw this.recordChannelFirstCreateFailure(context, error);
  }

  private assertChannelFirstCreateOwner(context: TransactionContext): void {
    try {
      context.lifecyclePhase.assertChannelFirstCreateActive();
      context.lifetime.assertActive();
      context.assertOwnerActive();
      const ambient = this.#profileAmbient.getStore();
      if (
        !ambient ||
        ambient.context !== context ||
        this.contexts.get(ambient.platform) !== context ||
        context.readOnly ||
        context.credential ||
        context.gateway ||
        context.turn ||
        context.fresh ||
        context.profileToken ||
        context.profilePolicyLocked
      )
        throw new ScopeViolationError("The original channel first-create owner is unavailable.");
    } catch (error) {
      this.rejectChannelFirstCreate(context, error);
    }
  }

  private assertChannelFirstCreateCurrent(context: TransactionContext, final = false): undefined {
    const execution = context.channelFirstCreate;
    try {
      if (!execution || execution.checking)
        throw new ScopeViolationError("The channel first-create currentness is unavailable.");
      if (execution.failed) throw execution.failure;
      execution.checking = true;
      if (final) {
        context.assertOwnerActive();
        context.lifecyclePhase.assertChannelCommitReady();
      } else this.assertChannelFirstCreateOwner(context);
      if (execution.currentness.assertSelectedIAM !== execution.assertSelectedIAM)
        throw new ScopeViolationError("The original channel currentness method changed.");
      const current: unknown = execution.assertSelectedIAM.call(execution.currentness);
      if (current !== undefined) {
        const error = new ScopeViolationError(
          "Channel currentness must return undefined synchronously.",
        );
        const first = this.recordChannelFirstCreateFailure(context, error);
        // Invalid asynchronous return is never awaited as authorization. Observe
        // rejection safely, including thenables, without retaining an unbounded peer.
        void Promise.resolve(current).catch(() => {});
        throw first;
      }
      context.assertOwnerActive();
      if (execution.failed) throw execution.failure;
      if (final) context.lifecyclePhase.assertChannelCommitReady();
      else this.assertChannelFirstCreateOwner(context);
      return undefined;
    } catch (error) {
      return this.rejectChannelFirstCreate(context, error);
    } finally {
      if (execution) execution.checking = false;
    }
  }

  private async completeChannelFirstCreate(
    context: TransactionContext,
    prepared: () => PreparedReservedChannelInstallationV1,
    currentness: ReservedChannelInstallationCurrentnessV1,
    insertPrepared: () => Promise<Readonly<ChannelInstallation>>,
    originalPrepared: PreparedReservedChannelInstallationV1,
  ): Promise<ReservedChannelInstallationProvisionalV1> {
    try {
      this.assertChannelFirstCreateOwner(context);
      if (context.channelFirstCreate || context.dataQueryStarted)
        throw new ScopeViolationError(
          "Channel first creation requires its original unused transaction.",
        );
      if (!consumeReservedChannelInstallationAttemptV1(originalPrepared, this, currentness))
        return Object.freeze({
          kind: "recovery-required",
          reason: "original-association-unavailable",
        });
      const retained = prepared();
      const record = retained.record;
      const audit = retained.audit;
      const expectedFields = [
        "id",
        "installationId",
        "version",
        "status",
        "createdAt",
        "updatedAt",
        "createdBy",
        "updatedBy",
        "platform",
        "providerTenantRef",
        "recipientAppRef",
      ].sort();
      if (
        !record ||
        !audit ||
        Object.keys(record).sort().join("|") !== expectedFields.join("|") ||
        record.version !== 1 ||
        record.status !== "enabled" ||
        record.createdAt !== record.updatedAt ||
        record.createdBy !== record.updatedBy ||
        (record.platform !== "slack" && record.platform !== "msteams") ||
        !/^chi_[0-9a-f-]{36}$/.test(record.id) ||
        !Number.isFinite(Date.parse(record.createdAt)) ||
        audit.installationId !== record.installationId ||
        audit.namespaceId !== undefined ||
        audit.resource?.kind !== "installation" ||
        audit.resource.id !== record.installationId ||
        audit.resource.namespaceId !== undefined ||
        audit.kind !== "mutation" ||
        audit.outcome !== "success" ||
        audit.source !== "occ" ||
        audit.schemaVersion !== 1 ||
        audit.action !== "openclaw.channel-bindings.installation.create" ||
        audit.actorId !== record.createdBy ||
        audit.actor?.principalId !== record.createdBy ||
        typeof audit.requestId !== "string" ||
        !audit.requestId ||
        typeof audit.iamDriverId !== "string" ||
        !audit.iamDriverId ||
        audit.authorization?.principalId !== record.createdBy ||
        audit.authorization.action !== "administer" ||
        audit.authorization.resource.kind !== "installation" ||
        audit.authorization.resource.id !== record.installationId ||
        audit.details?.recordKind !== "installation" ||
        audit.details.recordId !== record.id ||
        audit.details.previous !== null ||
        !sameCandidateDataV2(audit.details.current, { status: "enabled", version: 1 }) ||
        !Array.isArray(audit.details.checks) ||
        audit.details.checks.length === 0 ||
        Object.hasOwn(audit.details, "reservedChannelCreation")
      )
        throw new ScopeViolationError("The prepared channel creation and audit do not correspond.");
      const target = parseReplayReservationTargetV1({
        schemaVersion: 1,
        scope: { installationId: record.installationId },
        channelInstallationRef: record.id,
        creationOperationRef: retained.creationOperationRef,
        subject: { kind: "channel-installation" },
      });
      const locator = Object.freeze({
        channelInstallationRef: record.id,
        creationOperationRef: retained.creationOperationRef,
        reservationRef: retained.reservationRef,
        originalTransactionRef: `channel-create-tx:${randomUUID()}`,
      });
      const execution: ChannelFirstCreateExecutionV1 = {
        prepared: retained,
        locator,
        currentness,
        assertSelectedIAM: currentness.assertSelectedIAM,
        checking: false,
        failed: false,
        reserved: false,
        inserted: false,
        audited: false,
        completed: false,
        noEffect: false,
      };
      context.channelFirstCreate = execution;
      if (typeof execution.assertSelectedIAM !== "function")
        throw new ScopeViolationError("The original selected IAM currentness is unavailable.");
      this.assertChannelFirstCreateCurrent(context);
      await this.requireInstallation(context, record.installationId, context.channelCreateQuery);
      this.assertChannelFirstCreateCurrent(context);
      const participant = createPostgresTurnJournalReplayParticipant({
        scope: { installationId: record.installationId },
        transaction: { assertActive: () => this.assertChannelFirstCreateOwner(context) },
        query: { query: context.channelCreateQuery },
        currentInstallation: () => this.currentInstallation(context, context.channelCreateQuery),
        guard: context.journalGuard,
      });
      const reservation = await participant.reserveCapacity({
        target,
        reservationRef: locator.reservationRef,
        originalTransactionRef: locator.originalTransactionRef,
      });
      this.assertChannelFirstCreateCurrent(context);
      if (reservation.kind !== "reserved") {
        execution.noEffect = true;
        execution.completed = true;
        if (reservation.kind === "existing")
          return Object.freeze({ kind: "recovery-required", reason: "existing-reservation" });
        if (reservation.kind === "unavailable")
          return Object.freeze({ kind: "recovery-required", reason: "reservation-unavailable" });
        if (reservation.kind === "conflict" || reservation.kind === "capacity-exhausted")
          return Object.freeze({ kind: reservation.kind });
        throw new ScopeViolationError("The reservation result is unavailable.");
      }
      const reserved = reservation.record;
      if (
        !replayReservationTargetsMatchV1(reserved.target, target) ||
        reserved.reservationRef !== locator.reservationRef ||
        reserved.originalTransactionRef !== locator.originalTransactionRef ||
        reserved.state !== "reserved" ||
        reserved.recordVersion !== 1 ||
        reserved.activatedTarget !== null ||
        reserved.lineage !== null
      )
        throw new ScopeViolationError(
          "The fresh channel reservation differs from the original command.",
        );
      execution.reserved = true;
      const saved = await insertPrepared();
      this.assertChannelFirstCreateCurrent(context);
      if (!sameCandidateDataV2(saved, record))
        throw new ScopeViolationError(
          "The inserted channel parent differs from the prepared record.",
        );
      execution.inserted = true;
      await this.appendAudit(
        context,
        immutableCopy({
          ...audit,
          details: { ...audit.details, reservedChannelCreation: { schemaVersion: 1, ...locator } },
        }),
        context.channelCreateQuery,
      );
      this.assertChannelFirstCreateCurrent(context);
      execution.audited = true;
      execution.completed = true;
      return Object.freeze({ kind: "created-provisional", record: saved, locator });
    } catch (error) {
      return this.rejectChannelFirstCreate(context, error);
    }
  }

  /** Only the exact outward failure from this state has a terminal diagnostic.
   * Foreign, primitive and ambiguously reused error objects remain unavailable. */
  freshBootstrapFailureReceiptV1(
    error: unknown,
  ): Readonly<FreshBootstrapFailureReceiptV1> | undefined {
    if ((typeof error !== "object" || error === null) && typeof error !== "function")
      return undefined;
    return this.#freshFailureReceipts.get(error) ?? undefined;
  }

  private captureFreshFailure(
    record: FreshBootstrapExecutionV1,
    error: unknown,
    stage: FreshBootstrapFailureStageV1,
    databaseRejection = false,
  ): void {
    if (record.failed && !Object.is(record.failure, error)) return;
    if (
      record.diagnostic !== undefined &&
      (!record.failed || Object.is(record.diagnostic.failure, error))
    )
      return;
    let sqlstate: FreshBootstrapFailureReceiptV1["sqlstate"] = null;
    if (databaseRejection) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(error, "code");
        if (descriptor !== undefined && "value" in descriptor) {
          switch (descriptor.value) {
            case "42501":
            case "55P03":
            case "57014":
            case "40P01":
            case "40001":
            case "23001":
            case "23505":
            case "23503":
            case "23514":
            case "23502":
            case "55000":
            case "25P02":
            case "25006":
            case "42P01":
            case "42883":
            case "08003":
            case "08006":
            case "57P01":
              sqlstate = descriptor.value;
          }
        }
      } catch {
        // A hostile descriptor must not mask or expand the original failure.
      }
    }
    // A Proxy descriptor trap can reenter the owner and latch another failure.
    // It must not let this earlier, still-unlatched observation overwrite that fact.
    if (record.failed && !Object.is(record.failure, error)) return;
    if (
      record.diagnostic !== undefined &&
      (!record.failed || Object.is(record.diagnostic.failure, error))
    )
      return;
    record.diagnostic = Object.freeze({ failure: error, stage, sqlstate });
  }

  private publishFreshFailure(record: FreshBootstrapExecutionV1, error: unknown): void {
    if ((typeof error !== "object" || error === null) && typeof error !== "function") return;
    if (this.#freshFailureReceipts.has(error)) {
      this.#freshFailureReceipts.set(error, null);
      return;
    }
    this.#freshFailureReceipts.set(
      error,
      Object.freeze({
        schema: "fresh-bootstrap-failure-v1",
        stage: record.diagnostic?.stage ?? "unknown",
        sqlstate: record.diagnostic?.sqlstate ?? null,
        commitDisposition: record.disposition,
        establishedNoCommit: record.establishedNoCommit,
      }),
    );
  }

  private rejectFresh(
    record: FreshBootstrapExecutionV1,
    error: unknown,
    databaseRejection = false,
  ): never {
    if (!record.failed) {
      record.failed = true;
      record.failure = error;
      const observed = this.#freshFailureStages.getStore();
      this.captureFreshFailure(
        record,
        error,
        observed?.record === record ? observed.stage : "unknown",
        databaseRejection,
      );
    }
    throw error;
  }

  private trackFresh<Value>(
    record: FreshBootstrapExecutionV1,
    work: () => Promise<Value>,
  ): Promise<Value> {
    let result: Promise<Value>;
    try {
      if (!record.active || !record.accepting || this.#freshExecution.getStore() !== record)
        throw new ScopeViolationError("The fresh bootstrap operation is closed.");
      record.context?.lifetime.assertActive();
      result = Promise.resolve().then(work);
    } catch (error) {
      result = Promise.reject(error);
    }
    const owned = result.catch((error: unknown) => this.rejectFresh(record, error));
    record.pending.add(owned);
    void owned.then(
      () => record.pending.delete(owned),
      () => record.pending.delete(owned),
    );
    return owned;
  }

  /** Definite reservation is independent of later BetterAuth transactions. No
   * handle is minted after collision, rollback or an uncertain COMMIT/cleanup. */
  async reserveFreshInstallationV1(
    installation: Installation,
  ): Promise<FreshInstallationReservationV1> {
    if (
      this.bootstrapNativeIAM !== undefined ||
      this.#freshExecution.getStore() !== undefined ||
      this.#outerExecution.getStore() !== undefined
    )
      throw new ScopeViolationError("A fresh Installation requires its original empty owner.");
    const selected = immutableCopy(installation);
    const record: FreshBootstrapExecutionV1 = {
      kind: "reserve",
      installation: selected,
      pending: new Set(),
      namespaceIds: new Set(),
      workNamespaceIds: new Set(),
      auditNamespaceIds: new Set(),
      active: true,
      accepting: false,
      started: true,
      failed: false,
      disposition: "not-sent",
      establishedNoCommit: false,
    };
    const rowVersion = await this.execute(
      false,
      async (unit, context) => {
        await unit.installations.createInstallation(selected);
        const found = rows(
          (
            await context.client.query(
              "SELECT xmin::text AS row_version FROM occ.installation WHERE id=$1",
              [selected.id],
            )
          ).rows,
        );
        if (found.length !== 1)
          throw new ScopeViolationError("The fresh Installation insert is unavailable.");
        return text(found[0]!, "row_version");
      },
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      record,
    );
    // Terminal transport events can be observed during a no-throw release after
    // the raw ACK. They must not turn an uncertain delivery into a fresh handle.
    if (record.failed) {
      if (!record.establishedNoCommit && record.disposition !== "not-sent")
        throw new PostgresCommitOutcomeUnknownError();
      throw record.failure;
    }
    const handle = Object.freeze({ installation: selected }) as FreshInstallationReservationV1;
    this.#freshReservations.set(handle, { installation: selected, rowVersion });
    return handle;
  }

  /** Select exactly the original Store.transact called by MutationRunner. This
   * callback wrapper never opens an ambient or independently committing unit. */
  async finalizeFreshInstallationV1<Value>(
    reservation: FreshInstallationReservationV1,
    seed: PersistedNativeIAMState,
    work: () => Promise<Value>,
  ): Promise<Value> {
    const reserved = this.#freshReservations.get(reservation);
    if (
      reserved === undefined ||
      this.#freshExecution.getStore() !== undefined ||
      this.#outerExecution.getStore() !== undefined
    )
      throw new ScopeViolationError("The original fresh Installation reservation is unavailable.");
    this.#freshReservations.delete(reservation);
    const selectedSeed = immutableCopy(seed);
    this.validateIAMState(selectedSeed, true);
    const principal = selectedSeed.identities.filter((identity) => identity.kind === "principal");
    const service = selectedSeed.identities.filter(
      (identity) => identity.kind === "service_principal",
    );
    if (
      typeof work !== "function" ||
      principal.length !== 1 ||
      service.length !== 1 ||
      selectedSeed.identities.length !== 2 ||
      selectedSeed.groups.length !== 0 ||
      selectedSeed.memberships.length !== 0 ||
      selectedSeed.restrictions.length !== 0 ||
      principal[0]!.issuer !== `occ:installation:${reserved.installation.id}:better-auth` ||
      !principal[0]!.subject ||
      service[0]!.namespaceId !== undefined ||
      service[0]!.agentId !== undefined ||
      selectedSeed.roles.some((role) => role.namespaceId !== undefined) ||
      selectedSeed.bindings.some(
        (binding) =>
          binding.namespaceId !== undefined ||
          binding.subjectKind !== "identity" ||
          (binding.resourceId !== undefined &&
            (binding.resourceKind !== "installation" ||
              binding.resourceId !== reserved.installation.id)),
      )
    )
      throw new ScopeViolationError("The original fresh bootstrap seed is unavailable.");
    const record: FreshBootstrapExecutionV1 = {
      kind: "finalize",
      installation: reserved.installation,
      rowVersion: reserved.rowVersion,
      seed: selectedSeed,
      pending: new Set(),
      namespaceIds: new Set(),
      workNamespaceIds: new Set(),
      auditNamespaceIds: new Set(),
      active: true,
      accepting: false,
      started: false,
      failed: false,
      disposition: "not-sent",
      establishedNoCommit: false,
    };
    return this.#freshExecution.run(record, async () => {
      try {
        const value = await this.#freshFailureStages.run(
          { record, stage: "bootstrap-callback" },
          work,
        );
        if (!record.started || record.transaction === undefined) {
          const error = new ScopeViolationError(
            "Fresh bootstrap requires its original transaction.",
          );
          this.captureFreshFailure(record, error, "completion-check");
          throw error;
        }
        await record.transaction;
        if (record.failed) throw record.failure;
        return value;
      } catch (error) {
        if (!record.failed) {
          record.failed = true;
          record.failure = error;
          // execute may already have classified a primary cleanup rejection before
          // translating its outward error. Keep that original diagnostic.
          if (record.diagnostic === undefined)
            this.captureFreshFailure(record, error, "bootstrap-callback");
        }
        if (record.transaction !== undefined) await Promise.allSettled([record.transaction]);
        const outward =
          !record.establishedNoCommit && record.disposition !== "not-sent"
            ? new PostgresCommitOutcomeUnknownError()
            : error;
        this.publishFreshFailure(record, outward);
        throw outward;
      } finally {
        record.accepting = false;
        record.active = false;
      }
    });
  }

  private bindFreshBootstrapUnit(
    unit: PlatformUnitOfWork,
    record: FreshBootstrapExecutionV1,
  ): PlatformUnitOfWork {
    const allowed: Readonly<Record<string, readonly string[]>> = {
      installations: ["findInstallation", "getInstallation"],
      namespaces: ["findNamespace", "listNamespaces", "createNamespace"],
      audit: ["append"],
      operations: ["append"],
    };
    const principal = record.seed!.identities.find((identity) => identity.kind === "principal")!;
    return Object.freeze(
      Object.fromEntries(
        Object.entries(unit).map(([name, repository]) => [
          name,
          Object.freeze(
            Object.fromEntries(
              Object.entries(repository).map(([method, invoke]) => [
                method,
                (...args: unknown[]) => {
                  let captured: readonly unknown[];
                  try {
                    captured = immutableCopy(args);
                  } catch (error) {
                    return this.trackFresh(record, async () => {
                      throw error;
                    });
                  }
                  return this.trackFresh(record, async () => {
                    if (!allowed[name]?.includes(method) || typeof invoke !== "function")
                      throw new ScopeViolationError("The operation is outside fresh bootstrap.");
                    const value: unknown = await Reflect.apply(invoke, repository, captured);
                    if (name === "namespaces" && method === "createNamespace") {
                      const namespace = value as Readonly<Namespace>;
                      if (!namespace || namespace.status !== "provisioning")
                        throw new ScopeViolationError(
                          "Fresh bootstrap requires its new Namespace.",
                        );
                      record.namespaceIds.add(namespace.id);
                    }
                    if (name === "operations") {
                      const operation = captured[0] as PlatformOperation;
                      if (
                        operation.kind !== "namespace" ||
                        operation.action !== "reconcile" ||
                        operation.target !== "ready" ||
                        operation.namespaceId !== operation.resourceId ||
                        operation.actorId !== principal.id ||
                        !record.namespaceIds.has(operation.namespaceId)
                      )
                        throw new ScopeViolationError(
                          "Fresh bootstrap work must name its original Namespace.",
                        );
                      record.workNamespaceIds.add(operation.namespaceId);
                    }
                    if (name === "audit") {
                      const event = captured[0] as AuditEvent;
                      if (event.kind === "bootstrap") {
                        const details = event.details;
                        if (
                          event.installationId !== record.installation.id ||
                          event.actorId !== principal.id ||
                          event.resource.kind !== "installation" ||
                          event.resource.id !== record.installation.id ||
                          event.outcome !== "success" ||
                          details?.kind !== "bootstrap" ||
                          typeof details.defaultNamespaceId !== "string" ||
                          !record.namespaceIds.has(details.defaultNamespaceId)
                        )
                          throw new ScopeViolationError(
                            "Fresh bootstrap audit must name its original admission.",
                          );
                        record.auditNamespaceIds.add(details.defaultNamespaceId);
                      }
                    }
                    return value;
                  });
                },
              ]),
            ),
          ),
        ]),
      ),
    ) as unknown as PlatformUnitOfWork;
  }

  private async prepareFreshBootstrap(
    record: FreshBootstrapExecutionV1,
    context: TransactionContext,
  ): Promise<void> {
    if (record.seed === undefined || record.rowVersion === undefined)
      throw new ScopeViolationError("The fresh bootstrap seed is unavailable.");
    const installationRows = await this.#freshFailureStages.run(
      { record, stage: "installation-lock" },
      () =>
        context.client.query(
          "SELECT id, name, created_at, xmin::text AS row_version FROM occ.installation WHERE id=$1 FOR SHARE",
          [record.installation.id],
        ),
    );
    try {
      const found = rows(installationRows.rows);
      if (
        found.length !== 1 ||
        text(found[0]!, "row_version") !== record.rowVersion ||
        text(found[0]!, "id") !== record.installation.id ||
        text(found[0]!, "name") !== record.installation.name ||
        timestamp(found[0]!, "created_at") !== record.installation.createdAt
      )
        throw new ScopeViolationError("The original fresh Installation row changed.");
    } catch (error) {
      this.captureFreshFailure(record, error, "installation-match");
      throw error;
    }
    context.installation = record.installation;
    context.installationLoaded = true;
    // Same original six-table writer barrier, before empty-state observation and
    // seed persistence. No NativeIAM policy projection or second evaluator.
    await this.#freshFailureStages.run({ record, stage: "iam-writer-lock" }, () =>
      context.client.query("SELECT occ.lock_fresh_bootstrap_iam_v1()"),
    );
    const countRows = await this.#freshFailureStages.run({ record, stage: "iam-empty-read" }, () =>
      context.client.query(`SELECT
      (SELECT count(*) FROM occ.iam_identities) + (SELECT count(*) FROM occ.iam_roles) +
      (SELECT count(*) FROM occ.iam_groups) + (SELECT count(*) FROM occ.iam_group_memberships) +
      (SELECT count(*) FROM occ.iam_access_bindings) + (SELECT count(*) FROM occ.iam_restrictions)
      AS retained_count`),
    );
    try {
      const counts = rows(countRows.rows);
      if (counts.length !== 1 || String(counts[0]!.retained_count) !== "0")
        throw new ScopeViolationError("Fresh bootstrap cannot adopt existing IAM state.");
    } catch (error) {
      this.captureFreshFailure(record, error, "iam-empty-check");
      throw error;
    }
    const seed = record.seed;
    await this.#freshFailureStages.run({ record, stage: "iam-seed-write" }, () =>
      this.insertIAMState(context, seed),
    );
  }

  setBootstrapNativeIAM(state: PersistedNativeIAMState): void {
    const fresh = this.#freshExecution.getStore();
    if (fresh !== undefined)
      this.rejectFresh(
        fresh,
        new ScopeViolationError("The fresh bootstrap seed is already selected."),
      );
    this.bootstrapNativeIAM = state;
  }

  async loadInstallation(): Promise<Readonly<Installation> | undefined> {
    return this.read(async (state) => state.installations.getInstallation());
  }

  async loadNativeIAMState(installationId?: string): Promise<PersistedNativeIAMState> {
    const fresh = this.#freshExecution.getStore();
    if (fresh !== undefined)
      return this.trackFresh(fresh, async () => {
        if (
          fresh.kind !== "finalize" ||
          fresh.context === undefined ||
          (installationId !== undefined && installationId !== fresh.installation.id)
        )
          throw new ScopeViolationError("The fresh bootstrap IAM reader is unavailable.");
        return this.nativeIAMState(
          fresh.context,
          fresh.context.client.query,
          fresh.installation.id,
        );
      });
    return this.execute(true, async (_state, context) =>
      this.nativeIAMState(context, context.client.query, installationId),
    );
  }

  /** Only a live token minted by the real guarded owner can read this projection.
   * Never accepts a state snapshot or a caller-supplied transaction/current flag. */
  async loadNativeIAMStateInTransaction(token: object): Promise<PersistedNativeIAMState> {
    const turn = this.#turnContexts.get(token);
    if (turn !== undefined) {
      return this.trackTurnIO(turn, async () => {
        if (turn.policyState !== "locked")
          throw new DependencyUnavailableError("The turn policy barrier is unavailable.");
        const state = await this.nativeIAMState(
          turn.context,
          (statement, parameters) => this.turnQuery(turn, statement, parameters),
          turn.phase.unit.installationId,
        );
        this.assertTurnIO(turn);
        return state;
      });
    }
    const ambientTurn = this.#turnExecution.getStore();
    if (ambientTurn !== undefined) {
      const error = new DependencyUnavailableError("The exact turn IAM token is unavailable.");
      ambientTurn.phase.poison(error);
      throw error;
    }
    const gateway = this.#gatewayContexts.get(token);
    if (gateway !== undefined) {
      try {
        const io = gateway.authorityIO;
        if (io === undefined || gateway.policyState !== "locked")
          throw new DependencyUnavailableError("The Gateway native IAM unit is unavailable.");
        this.assertGatewayAuthorityOperationV1(gateway, io);
        const state = await this.nativeIAMState(gateway.context, io.query, gateway.installationId);
        this.assertGatewayAuthorityOperationV1(gateway, io);
        return state;
      } catch (error) {
        gateway.phase.poison(error);
        throw error;
      }
    }
    const ambientGateway = this.#gatewayExecution.getStore();
    if (ambientGateway !== undefined) {
      const error = new DependencyUnavailableError("The Gateway native IAM unit is unavailable.");
      ambientGateway.phase.poison(error);
      throw error;
    }
    const context = this.#profileContexts.get(token);
    if (context === undefined || context.profilePolicyLocked !== true)
      throw new DependencyUnavailableError("The guarded native IAM unit is unavailable.");
    context.lifetime.assertActive();
    return this.nativeIAMState(context, context.profileQuery);
  }

  private async nativeIAMState(
    context: TransactionContext,
    query: PostgresClient["query"],
    installationId?: string,
  ): Promise<PersistedNativeIAMState> {
    const installation = await this.currentInstallation(context, query);
    if (installation === undefined) {
      if (this.bootstrapNativeIAM !== undefined) return this.bootstrapNativeIAM;
      throw new DependencyUnavailableError("The platform Installation has not been initialized.");
    }
    if (installationId !== undefined && installation.id !== installationId)
      throw new ScopeViolationError("IAM state belongs to another Installation.");

    const identityRows = rows(
      (
        await query(
          "SELECT id, namespace_id, agent_id, kind, issuer, subject FROM occ.iam_identities ORDER BY id",
        )
      ).rows,
    );
    const roleRows = rows(
      (await query("SELECT id, namespace_id, name, permissions FROM occ.iam_roles ORDER BY id"))
        .rows,
    );
    const groupRows = rows(
      (await query("SELECT id, namespace_id, name FROM occ.iam_groups ORDER BY id")).rows,
    );
    const membershipRows = rows(
      (
        await query(
          `SELECT namespace_id, group_id, principal_id
             FROM occ.iam_group_memberships ORDER BY group_id, principal_id`,
        )
      ).rows,
    );
    const bindingRows = rows(
      (
        await query(
          `SELECT id, namespace_id, identity_subject_id, group_subject_id, role_id,
                    resource_kind, resource_id, channel_administration
             FROM occ.iam_access_bindings ORDER BY id`,
        )
      ).rows,
    );
    const restrictionRows = rows(
      (
        await query(
          `SELECT id, namespace_id, action, resource_kind, resource_id, effect
             FROM occ.iam_restrictions ORDER BY id`,
        )
      ).rows,
    );

    const identities = identityRows.map((row): Identity => {
      const id = text(row, "id");
      const kind = text(row, "kind");
      const namespaceId = optionalText(row, "namespace_id");
      if (kind === "principal")
        return immutableCopy({
          id,
          kind,
          issuer: text(row, "issuer"),
          subject: text(row, "subject"),
        });
      if (kind === "service_principal") {
        const agentId = optionalText(row, "agent_id");
        if (agentId !== undefined && namespaceId === undefined)
          throw new DependencyUnavailableError("Persisted IAM identity has an invalid owner.");
        return immutableCopy({
          id,
          kind,
          ...(namespaceId === undefined ? {} : { namespaceId }),
          ...(agentId === undefined ? {} : { agentId }),
        });
      }
      throw new DependencyUnavailableError("Persisted IAM identity has an invalid owner.");
    });

    const roles = roleRows.map((row): Role => {
      const namespaceId = optionalText(row, "namespace_id");
      const name = optionalText(row, "name");
      return immutableCopy({
        id: text(row, "id"),
        ...(namespaceId === undefined ? {} : { namespaceId }),
        ...(name === undefined ? {} : { name }),
        permissions: permissions(row.permissions),
      });
    });

    const groups = groupRows.map((row): Group => {
      const namespaceId = optionalText(row, "namespace_id");
      return immutableCopy({
        id: text(row, "id"),
        ...(namespaceId === undefined ? {} : { namespaceId }),
        name: text(row, "name"),
      });
    });

    const memberships = membershipRows.map((row): GroupMembership => {
      const namespaceId = optionalText(row, "namespace_id");
      return immutableCopy({
        ...(namespaceId === undefined ? {} : { namespaceId }),
        groupId: text(row, "group_id"),
        principalId: text(row, "principal_id"),
      });
    });

    const bindings = bindingRows.map((row): AccessBinding => {
      const namespaceId = optionalText(row, "namespace_id");
      const resourceKind = optionalText(row, "resource_kind");
      const resourceId = optionalText(row, "resource_id");
      if (
        (resourceKind === undefined) !== (resourceId === undefined) ||
        (resourceKind !== undefined && !RESOURCE_KINDS.has(resourceKind))
      )
        throw new DependencyUnavailableError("Persisted IAM binding has an invalid resource.");
      const identitySubjectId = optionalText(row, "identity_subject_id");
      const groupSubjectId = optionalText(row, "group_subject_id");
      if ((identitySubjectId === undefined) === (groupSubjectId === undefined))
        throw new DependencyUnavailableError("Persisted IAM binding has an ambiguous subject.");
      const mapping =
        row.channel_administration === null || row.channel_administration === undefined
          ? undefined
          : decodeChannelAdministrationMappingV1(row.channel_administration);
      if (mapping?.kind === "invalid")
        throw new DependencyUnavailableError("Persisted IAM channel administration is invalid.");
      return immutableCopy({
        id: text(row, "id"),
        ...(namespaceId === undefined ? {} : { namespaceId }),
        subjectKind: identitySubjectId === undefined ? "group" : "identity",
        subjectId: identitySubjectId ?? groupSubjectId!,
        roleId: text(row, "role_id"),
        ...(resourceKind === undefined
          ? {}
          : { resourceKind: resourceKind as NonNullable<AccessBinding["resourceKind"]> }),
        ...(resourceId === undefined ? {} : { resourceId }),
        ...(mapping === undefined ? {} : { channelAdministration: mapping.value }),
      });
    });

    const restrictions = restrictionRows.map((row): Restriction => {
      const namespaceId = optionalText(row, "namespace_id");
      const action = text(row, "action");
      const resourceKind = text(row, "resource_kind");
      const resourceId = optionalText(row, "resource_id");
      if (
        !PERMISSION_ACTIONS.has(action) ||
        !RESOURCE_KINDS.has(resourceKind) ||
        text(row, "effect") !== "deny"
      )
        throw new DependencyUnavailableError("Persisted IAM restriction is invalid.");
      return immutableCopy({
        id: text(row, "id"),
        ...(namespaceId === undefined ? {} : { namespaceId }),
        action: action as Restriction["action"],
        resourceKind: resourceKind as Restriction["resourceKind"],
        ...(resourceId === undefined ? {} : { resourceId }),
        effect: "deny",
      });
    });

    const state = { identities, groups, memberships, roles, bindings, restrictions };
    this.validateIAMState(state, true);
    return immutableCopy(state);
  }

  async seedNativeIAM(state: PersistedNativeIAMState): Promise<void> {
    return this.transact(async (unit) => {
      const context = this.contexts.get(unit);
      if (context === undefined)
        throw new DependencyUnavailableError("The platform transaction is unavailable.");
      const installation = await this.currentInstallation(context);
      if (installation === undefined)
        throw new ScopeViolationError("IAM state requires an initialized Installation.");
      await this.insertIAMState(context, state);
    });
  }

  async appendNativeIAMPrincipal(
    seed: PersistedNativeIAMPrincipalSeed,
    auditEvent?: AuditEvent,
  ): Promise<PersistedNativeIAMState> {
    let installationId: string | undefined;
    await this.transact(async (unit) => {
      const context = this.contexts.get(unit);
      if (context === undefined)
        throw new DependencyUnavailableError("The platform transaction is unavailable.");
      const installation = await this.currentInstallation(context);
      if (installation === undefined)
        throw new ScopeViolationError("IAM state requires an initialized Installation.");
      installationId = installation.id;
      if (seed.roles.length > 0)
        throw new ScopeViolationError("Account provisioning must bind an existing IAM Role.");
      for (const binding of seed.bindings) {
        if (
          binding.subjectKind !== "identity" ||
          binding.subjectId !== seed.principal.id ||
          binding.resourceKind !== "installation" ||
          binding.resourceId !== installation.id ||
          binding.namespaceId !== undefined
        )
          throw new ScopeViolationError(
            "Account provisioning requires an exact Installation binding.",
          );
      }
      await context.client.query(
        `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          seed.principal.id,
          null,
          null,
          seed.principal.kind,
          seed.principal.issuer,
          seed.principal.subject,
        ],
      );
      for (const binding of seed.bindings) {
        const mapping =
          binding.channelAdministration === undefined
            ? undefined
            : decodeChannelAdministrationMappingV1(binding.channelAdministration);
        if (mapping?.kind === "invalid")
          throw new DependencyUnavailableError("IAM channel administration is invalid.");
        await context.client.query(
          `INSERT INTO occ.iam_access_bindings
           (id, namespace_id, identity_subject_id, group_subject_id, role_id,
            resource_kind, resource_id, channel_administration)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            binding.id,
            null,
            binding.subjectId,
            null,
            binding.roleId,
            binding.resourceKind,
            binding.resourceId,
            mapping === undefined ? null : JSON.stringify(mapping.value),
          ],
        );
      }
      if (auditEvent !== undefined) await unit.audit.append(auditEvent);
    });
    return this.loadNativeIAMState(installationId);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async read<T>(
    work: (state: PlatformReadView) => Promise<T>,
    options?: PlatformReadOptions,
  ): Promise<T> {
    return this.execute(
      true,
      async (state, context) => {
        const view = createPlatformReadView(state, context.lifetime);
        context.readView = view;
        this.contexts.set(view, context);
        return work(view);
      },
      options,
    );
  }

  /** Data only: the HTTP owner separately authenticates and authorizes every
   * exact Agent read before acquisition and immediately before disclosure. */
  async readLifecycleStatusV1<K extends LifecycleStatusReadMethodV1>(
    installationId: string,
    method: K,
    request: LifecycleStatusReadRequestV1<K>,
    options: PlatformReadOptions,
  ): Promise<LifecycleStatusReadValueV1<K> | undefined> {
    return this.execute(
      true,
      async (state, context) =>
        readPostgresLifecycleStatusV1(
          {
            installationId,
            state: createPlatformReadView(state, context.lifetime),
            query: async (statement, parameters) => {
              context.lifetime.assertActive();
              context.assertOwnerActive();
              const result = await context.client.query(statement, parameters);
              context.lifetime.assertActive();
              context.assertOwnerActive();
              return result;
            },
          },
          method,
          request,
        ),
      options,
    );
  }

  async transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    const fresh = this.#freshExecution.getStore();
    if (fresh === undefined) return this.execute(false, async (state) => work(state));
    if (!fresh.active || fresh.started || fresh.kind !== "finalize")
      return this.rejectFresh(
        fresh,
        new ScopeViolationError("Fresh bootstrap permits one original outer transaction."),
      );
    fresh.started = true;
    const transaction = this.execute(
      false,
      async (state, context) => {
        fresh.context = context;
        await this.prepareFreshBootstrap(fresh, context);
        fresh.accepting = true;
        try {
          return await work(state);
        } catch (error) {
          return this.rejectFresh(fresh, error);
        } finally {
          fresh.accepting = false;
        }
      },
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      fresh,
    );
    fresh.transaction = transaction;
    void transaction.catch((error: unknown) => {
      if (!fresh.failed) {
        fresh.failed = true;
        fresh.failure = error;
      }
    });
    return transaction;
  }

  private assertTurnIO(record: TurnCommandEnrollmentV1): TurnCommandIOV1 {
    try {
      const io = this.#turnIO.getStore();
      if (
        !record.active ||
        this.#turnExecution.getStore() !== record ||
        this.#turnContexts.get(record.phase.unit) !== record ||
        record.context.turn !== record.execution ||
        io?.record !== record ||
        !io.active
      )
        throw new ScopeViolationError("The turn participant IO is unavailable.");
      record.phase.assertOwned(record.phase.unit);
      record.context.lifetime.assertActive();
      record.selected.assertCurrent();
      record.nativeIAM.assertCurrent();
      io.operation?.assertActive();
      return io;
    } catch (error) {
      record.phase.poison(error);
      this.#turnExecution.getStore()?.phase.poison(error);
      throw error;
    }
  }

  private trackTurnIO<T>(record: TurnCommandEnrollmentV1, work: () => Promise<T>): Promise<T> {
    try {
      const io = this.assertTurnIO(record);
      const inherited = this.#turnChild.getStore();
      if (
        (inherited !== undefined && (inherited.io !== io || !inherited.active)) ||
        (!io.accepting && inherited === undefined)
      )
        throw new ScopeViolationError("The turn participant callback has closed.");
      const child = { io, active: true };
      const run = async () => {
        try {
          this.assertTurnIO(record);
          const value = await this.#turnChild.run(child, work);
          this.assertTurnIO(record);
          return value;
        } catch (error) {
          record.phase.poison(error);
          throw error;
        } finally {
          child.active = false;
        }
      };
      const result =
        io.operation === undefined ? record.context.lifetime.run(run) : io.operation.track(run);
      io.pending.add(result);
      void result.then(
        () => io.pending.delete(result),
        (error: unknown) => {
          record.phase.poison(error);
          io.pending.delete(result);
        },
      );
      return result;
    } catch (error) {
      record.phase.poison(error);
      return Promise.reject(error);
    }
  }

  private turnQuery(
    record: TurnCommandEnrollmentV1,
    statement: string,
    parameters?: readonly unknown[],
  ) {
    return this.trackTurnIO(record, () => record.context.turnQuery(statement, parameters));
  }

  private async withTurnIO<T>(
    record: TurnCommandEnrollmentV1,
    work: () => Promise<T>,
    operation?: TurnCommandAcceptedOperationV1,
  ): Promise<T> {
    if (this.#turnIO.getStore() !== undefined) {
      const error = new ScopeViolationError("Turn participant callbacks cannot nest.");
      record.phase.poison(error);
      throw error;
    }
    const io: TurnCommandIOV1 = {
      record,
      pending: new Set(),
      accepting: true,
      active: true,
      ...(operation === undefined ? {} : { operation }),
    };
    try {
      const value = await this.#turnIO.run(io, work);
      return value;
    } catch (error) {
      record.phase.poison(error);
      throw error;
    } finally {
      io.accepting = false;
      while (io.pending.size) await Promise.allSettled([...io.pending]);
      io.active = false;
      record.phase.assertOwned(record.phase.unit);
    }
  }

  /** Receiver-owned composition seam, not a public account-provider option.
   * TODO(turn accepting source): invoke this only with the original native-channel
   * participant and real account/security/SQL enrollment producers. Until those
   * are installed, absence fails before checkout; shape alone authenticates none.
   * The Store owns this adapter's OUTERMOST transact, never an ambient wrapper. */
  private bindTurnCommandStateV1(
    identity: TurnCommandIdentityV1,
    bounds: TurnCommandBoundsV1,
    source?: TurnCommandCentralSourceV1,
  ): PlatformStateStore {
    const unavailable = () =>
      new DependencyUnavailableError("The turn command source is unavailable.");
    const owner = this;
    const selection = source?.driverSelection;
    const consume = source?.account.consume.bind(source.account);
    let used = false;
    return Object.freeze({
      // TODO(turn fresh reader): the original journal owner must select a fresh
      // authenticated, scoped read producer. A completed command's source/token
      // cannot authorize ordinary full-state reads before or after its lifetime.
      read: <T>(
        _work: (view: PlatformReadView) => Promise<T>,
        _options?: PlatformReadOptions,
      ): Promise<T> => Promise.reject(unavailable()),
      transact: async <T>(work: (unit: PlatformUnitOfWork) => Promise<T>): Promise<T> => {
        const ambient = this.#turnExecution.getStore();
        if (ambient !== undefined) {
          ambient.phase.poison(unavailable());
          throw unavailable();
        }
        if (
          used ||
          selection === undefined ||
          consume === undefined ||
          this.turnJournal === undefined
        )
          throw unavailable();
        used = true;
        if (
          Object.getPrototypeOf(selection) !== DriverSelection.prototype ||
          selection.selectedDriver !== DriverSelection.prototype.selectedDriver ||
          selection.acquireGuardedSelection !== DriverSelection.prototype.acquireGuardedSelection
        )
          throw unavailable();
        const driver = selection.selectedDriver("iam");
        const selected = selection.acquireGuardedSelection("iam", driver);
        let record: TurnCommandEnrollmentV1 | undefined;
        let failed = false;
        let failure: unknown;
        let value!: T;
        const execution: TurnCommandExecutionV1 = {
          identity,
          bounds,
          close: () => {
            if (record !== undefined) {
              record.active = false;
              this.#turnContexts.delete(record.phase.unit);
            }
          },
        };
        try {
          const timeoutMs = Math.min(3000, Date.parse(bounds.deadline) - Date.now());
          value = await this.execute(
            false,
            async (unit, context) => {
              const phase = execution.phase;
              if (phase === undefined || context.turn !== execution) throw unavailable();
              const installation = await this.currentInstallation(context, context.turnQuery);
              if (installation?.id !== phase.unit.installationId) throw unavailable();
              const nativeIAM = bindNativeIAMTransaction(driver, this, phase.unit);
              const current: TurnCommandEnrollmentV1 = {
                context,
                execution,
                phase,
                selected,
                nativeIAM,
                active: true,
                policyState: "unlocked",
                parentsLocked: false,
              };
              record = current;
              this.#turnContexts.set(phase.unit, current);
              const iam: NativeIAMTransactionView = Object.freeze({
                assertCurrent: () => {
                  try {
                    this.assertTurnIO(current);
                    if (current.policyState !== "locked") throw unavailable();
                  } catch (error) {
                    phase.poison(error);
                    throw error;
                  }
                },
                lookupIdentity: (
                  input: Parameters<NativeIAMTransactionView["lookupIdentity"]>[0],
                ) => this.trackTurnIO(current, () => nativeIAM.lookupIdentity(input)),
                authorize: (request: Parameters<NativeIAMTransactionView["authorize"]>[0]) =>
                  this.trackTurnIO(current, () => nativeIAM.authorize(request)),
              });
              let securityCleanup: ((outcome: TurnCommandTerminalV1) => Promise<void>) | undefined;
              let sourceRelease: ((outcome: TurnCommandTerminalV1) => Promise<void>) | undefined;
              let sourcePrepare: ((unit: TurnCommandAccountUnitV1) => Promise<void>) | undefined;
              let sourceCurrent: (() => undefined) | undefined;
              const retainSecurityCleanup: TurnCommandAccountUnitV1["retainSecurityCleanup"] = (
                release,
              ) => {
                try {
                  this.assertTurnIO(current);
                  if (
                    securityCleanup !== undefined ||
                    current.policyState !== "unlocked" ||
                    typeof release !== "function"
                  )
                    throw unavailable();
                  securityCleanup = release;
                } catch (error) {
                  phase.poison(error);
                  throw error;
                }
              };
              const rawAccount = createTurnCommandAccountUnitV1({
                token: phase.unit,
                identity: phase.unit,
                bounds: Object.freeze({ ...bounds }),
                iam,
                retainSecurityCleanup,
                scope: { installationId: phase.unit.installationId },
                transaction: {
                  assertActive: () => {
                    this.assertTurnIO(current);
                  },
                },
                query: {
                  query: (statement, parameters) => this.turnQuery(current, statement, parameters),
                },
                currentInstallation: () =>
                  this.trackTurnIO(current, () =>
                    this.currentInstallation(context, (statement, parameters) =>
                      this.turnQuery(current, statement, parameters),
                    ),
                  ),
                lockPolicy: async () => {
                  this.assertTurnIO(current);
                  if (current.policyState !== "unlocked" || securityCleanup === undefined)
                    throw unavailable();
                  current.policyState = "locking";
                  await this.turnQuery(current, "SELECT occ.lock_workload_profile_iam()");
                  this.assertTurnIO(current);
                  current.policyState = "locked";
                },
                recordParentsLocked: () => {
                  this.assertTurnIO(current);
                  current.parentsLocked = true;
                },
              });
              const accountUnit: TurnCommandAccountUnitV1 = Object.freeze({
                token: rawAccount.token,
                identity: rawAccount.identity,
                bounds: rawAccount.bounds,
                iam,
                assertActive: rawAccount.assertActive,
                retainSecurityCleanup,
                locateChannel: (input: Parameters<TurnCommandAccountUnitV1["locateChannel"]>[0]) =>
                  this.trackTurnIO(current, () => rawAccount.locateChannel(input)),
                lockPolicy: () => this.trackTurnIO(current, () => rawAccount.lockPolicy()),
                lockParentsAndReload: () =>
                  this.trackTurnIO(current, () => rawAccount.lockParentsAndReload()),
                readLockedChannel: () =>
                  this.trackTurnIO(current, () => rawAccount.readLockedChannel()),
              });
              return this.#turnExecution.run(current, async () => {
                await phase.enroll({
                  consume: async () => {
                    // Transfer the single cleanup owner even when acquisition or a
                    // later getter fails. Poison retains the original failure; the
                    // scope captures this release before testing the failed fence.
                    try {
                      await this.withTurnIO(current, async () => {
                        const lease = await consume(accountUnit);
                        if (lease === undefined) throw unavailable();
                        sourceRelease = lease.release.bind(lease);
                        sourcePrepare = lease.prepareCommit.bind(lease);
                        sourceCurrent = lease.assertCurrent.bind(lease);
                      });
                    } catch (error) {
                      phase.poison(error);
                    }
                    return {
                      release: async (outcome) => {
                        let failed = false;
                        let failure: unknown;
                        for (const release of [sourceRelease, securityCleanup]) {
                          if (release === undefined) continue;
                          try {
                            await release(outcome);
                          } catch (error) {
                            if (!failed) {
                              failed = true;
                              failure = error;
                            }
                          }
                        }
                        if (failed) throw failure;
                      },
                      prepareCommit: () =>
                        owner.#turnExecution.run(current, () =>
                          owner.withTurnIO(current, async () => {
                            if (sourcePrepare === undefined) throw unavailable();
                            await sourcePrepare(accountUnit);
                          }),
                        ),
                      assertCurrent: () => {
                        selected.assertCurrent();
                        nativeIAM.assertCurrent();
                        if (
                          current.policyState !== "locked" ||
                          !current.parentsLocked ||
                          sourceCurrent === undefined
                        )
                          throw unavailable();
                        return sourceCurrent();
                      },
                    };
                  },
                });
                return work(unit);
              });
            },
            { signal: bounds.signal, timeoutMs },
            false,
            undefined,
            undefined,
            execution,
          );
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          try {
            selected.release();
          } catch (error) {
            if (!failed) {
              failed = true;
              failure =
                execution.acknowledged || execution.sent
                  ? new PostgresCommitOutcomeUnknownError()
                  : error;
            }
          }
        }
        if (failed) throw failure;
        return value;
      },
    });
  }

  /** Internal storage/policy unit. It does not authenticate an account; only the
   * service's genuine account participant may turn it into a protected request. */
  async workloadProfileTransaction<T>(
    selection: DriverSelection,
    work: (unit: GuardedWorkloadProfileUnit) => Promise<T>,
    options: PlatformReadOptions,
  ): Promise<T> {
    if (
      Object.getPrototypeOf(selection) !== DriverSelection.prototype ||
      selection.selectedDriver !== DriverSelection.prototype.selectedDriver ||
      selection.acquireGuardedSelection !== DriverSelection.prototype.acquireGuardedSelection
    )
      throw new DependencyUnavailableError("The actual guarded Driver selection is unavailable.");
    const driver = selection.selectedDriver("iam");
    const selected = selection.acquireGuardedSelection("iam", driver);
    try {
      return await this.execute(
        false,
        async (unit, context) => {
          const policy = context.profilePhase.claimGuardedPolicy();
          const installation = await this.requireInitialized(context);
          const token = Object.freeze({});
          context.profileToken = token;
          this.#profileContexts.set(token, context);
          const iam = bindNativeIAMTransaction(driver, this, token);
          const guarded = createGuardedWorkloadProfileUnit({
            installationId: installation.id,
            signal: options.signal,
            assertActive: () => context.lifetime.assertActive(),
            assertOwnerActive: context.assertOwnerActive,
            query: (statement, parameters) => context.profileQuery(statement, parameters),
            resolveNamespace: async (admissionRef) => {
              const result = rows(
                (
                  await context.profileQuery(
                    "SELECT namespace_id FROM occ.workload_profile_admissions WHERE installation_id=$1 AND admission_ref=$2",
                    [installation.id, admissionRef],
                  )
                ).rows,
              );
              if (result.length > 1)
                throw new DependencyUnavailableError("The profile admission owner is ambiguous.");
              return result[0] === undefined ? undefined : text(result[0], "namespace_id");
            },
            assertSelection: () => {
              selected.assertCurrent();
              iam.assertCurrent();
            },
            accountQuery: (statement, parameters) => {
              policy.assertPolicy();
              return context.profileQuery(statement, parameters);
            },
            lockPolicy: async () => {
              policy.assertPolicy();
              await context.profileQuery("SELECT occ.lock_workload_profile_iam()");
              context.lifetime.assertActive();
              context.profilePolicyLocked = true;
              policy.complete();
            },
            iam,
            profiles: unit.workloadProfiles,
            findAudit: async (id) => {
              const result = rows(
                (
                  await context.profileQuery(
                    "SELECT id, occurred_at, kind, actor_id, action, namespace_id, resource_kind, resource_id, outcome, details FROM occ.audit_events WHERE id=$1",
                    [id],
                  )
                ).rows,
              );
              if (result.length > 1)
                throw new DependencyUnavailableError("The profile audit is ambiguous.");
              return result[0] === undefined ? undefined : auditFromRow(result[0], installation.id);
            },
            appendAudit: (event) => this.appendAudit(context, event, context.profileQuery),
          });
          context.protectedProfile = guarded;
          this.#profileAccounts.set(guarded.unit.account, guarded);
          this.#profileSourceSelections.set(guarded.unit.account, selection);
          return work(guarded.unit);
        },
        options,
        true,
      );
    } finally {
      // execute has joined query cleanup and settled COMMIT/rollback before release.
      selected.release();
    }
  }

  /** Exact original Platform unit membership for partial capability owners.
   * No SQL, IAM decision, immutable definition or new admission is produced. */
  workloadProfileSourceEnrollmentV2(selection: DriverSelection): WorkloadProfileSourceEnrollmentV2 {
    const wrap = (check: () => void) => {
      let released = false;
      let failed = false;
      let failure: unknown;
      const assertCurrent = (): undefined => {
        if (released) throw new ScopeViolationError("The profile source lease is closed.");
        if (failed) throw failure;
        try {
          check();
        } catch (error) {
          failed = true;
          failure = error;
          throw error;
        }
        return undefined;
      };
      assertCurrent();
      return Object.freeze({
        assertCurrent,
        async release() {
          released = true;
        },
      });
    };
    return Object.freeze<WorkloadProfileSourceEnrollmentV2>({
      definition: (unit, io) => {
        const guarded = this.#profileAccounts.get(unit.account);
        if (!guarded || this.#profileSourceSelections.get(unit.account) !== selection)
          throw new ScopeViolationError(
            "The original profile definition selection is unavailable.",
          );
        const original = guarded.bindDefinitionSource(unit, io);
        return wrap(() => original.assertCurrent());
      },
      revision: (input, unit, io) => {
        const request = decodeWorkloadProfileSelectionRequestV2(input);
        const deployment = this.#profileSelectedUnits.get(unit);
        const gateway = this.#gatewayExecution.getStore();
        const context = deployment?.context ?? gateway?.context;
        const refuse = () =>
          new ScopeViolationError("The original renderer source unit is unavailable.");
        if (!deployment && (gateway?.version !== 2 || gateway.selectionIO !== io)) throw refuse();
        io.assertActive();
        return wrap(() => {
          if (!context) throw refuse();
          context.assertOwnerActive();
          if (deployment) {
            if (
              !deployment.active ||
              deployment.io !== io ||
              deployment.selection !== selection ||
              this.#profileContexts.get(deployment.profileToken) !== context ||
              !("kind" in unit) ||
              unit.kind !== "deployment" ||
              unit.signal.aborted ||
              unit.installationId !== request.installationId ||
              unit.namespaceId !== request.namespaceId ||
              unit.agentId !== request.agentId
            )
              throw refuse();
          } else {
            if (
              gateway?.version !== 2 ||
              !gateway.active ||
              gateway.unit !== unit ||
              this.#gatewayContexts.get(gateway.token) !== gateway ||
              context.gateway !== gateway.execution ||
              gateway.policyState !== "locked" ||
              gateway.installationId !== request.installationId ||
              gateway.unit.subject.namespaceRef !== request.namespaceId ||
              gateway.unit.subject.agentRef !== request.agentId ||
              gateway.bounds.signal.aborted ||
              this.#gatewaySourceSelections.get(gateway.unit) !== selection ||
              selection.selectedDriver("iam") !== gateway.selected.registration?.driver
            )
              throw refuse();
            gateway.selected.assertCurrent();
          }
        });
      },
    });
  }

  /** This source recognizes only account objects created by this exact active
   * owner. It carries no request registry or account/session authority. */
  workloadProfileAccountOwnerV1() {
    return Object.freeze({
      bind: (unit: WorkloadProfileAccountUnit, terminalCleanup: () => void) => {
        const owner = this.#profileAccounts.get(unit);
        if (!owner)
          throw new DependencyUnavailableError("The original profile account unit is unavailable.");
        return owner.bindAccountOwner(terminalCleanup);
      },
    });
  }

  /** Original asynchronous worker acquisition. A queue token locates current
   * work; the independently retained admission origin and fresh locked session,
   * NativeIAM, intent and profile provide the other necessary checks. This is
   * transaction-local preparation data, not a post-COMMIT execution permit. */
  async withRuntimePreparationWorkerCurrentUseV1<Value>(
    selection: DriverSelection,
    claim: import("../ports/repositories/work.ts").WorkClaim,
    input: RuntimePreparationCurrentUseRequestV1,
    options: PlatformReadOptions,
    work: (
      lease: RuntimePreparationCurrentUseLeaseV1,
      io: WorkloadProfileOwnedOperationV2,
    ) => Promise<Value>,
    capabilities?: WorkloadProfileCapabilitySourceV2,
  ): Promise<Value> {
    canonicalRuntimePreparation(input);
    const request = immutableCopy({
      ...input,
      selection: decodeWorkloadProfileSelectionRequestV2(input.selection),
    });
    const originalClaim = immutableCopy(claim);
    requirePreparation(Object.keys(originalClaim).sort().join(",") === "claimToken,idempotencyKey");
    requirePreparation(
      typeof originalClaim.idempotencyKey === "string" &&
        originalClaim.idempotencyKey.length <= 1024,
    );
    profileUuid(originalClaim.claimToken);
    profileUuid(request.preparationRef);
    profileUuid(request.effectRef);
    requirePreparation(
      Number.isSafeInteger(request.preparationVersion) && request.preparationVersion > 0,
    );
    if (options.timeoutMs > 3000)
      throw new ScopeViolationError("Preparation current use exceeds its bound.");
    return this.workloadProfileTransaction(
      selection,
      async (accountUnit) => {
        const ambient = this.#profileAmbient.getStore();
        const owner = this.#profileAccounts.get(accountUnit.account);
        if (!ambient || !owner || ambient.context.protectedProfile !== owner)
          throw new ScopeViolationError("The original preparation transaction is unavailable.");
        const { context, platform } = ambient;
        const scope = request.selection;
        // Historical origin is read before the current account lock. Its table is
        // immutable; this read neither authenticates a caller nor seals IAM.
        const origins = rows(
          (
            await accountUnit.account.query(
              `SELECT origin.*,revision.admitted_spec->'service_account'->>'id' AS service_account_id
          FROM occ.runtime_preparation_admission_origins origin
          JOIN occ.agent_revisions revision ON revision.namespace_id=origin.namespace_id
           AND revision.agent_id=origin.agent_id AND revision.id=origin.revision_id
          JOIN occ.controller_work work ON work.namespace_id=origin.namespace_id
           AND work.agent_id=origin.agent_id AND work.revision_id=origin.revision_id
           AND work.runtime_transition_ref=origin.intent_ref
           AND work.lifecycle_generation=origin.lifecycle_generation AND work.actor_id=origin.actor_id
         WHERE origin.installation_id=$1 AND origin.namespace_id=$2 AND origin.agent_id=$3
           AND origin.revision_id=$4 AND work.idempotency_key=$5 AND work.claim_token=$6::uuid
           AND work.state='claimed' AND work.lease_expires_at>clock_timestamp()`,
              [
                scope.installationId,
                scope.namespaceId,
                scope.agentId,
                scope.revisionId,
                originalClaim.idempotencyKey,
                originalClaim.claimToken,
              ],
            )
          ).rows,
        );
        requirePreparation(origins.length === 1);
        const originRow = origins[0]!;
        const origin = parseRuntimePreparationSessionOriginV1(originRow.session_origin);
        requirePreparation(origin.installationId === scope.installationId);
        const session = await this.workloadProfileSessionSecurityV1().lock(
          accountUnit.account,
          origin,
        );
        requirePreparation(
          session &&
            session.incarnation === origin.accountIncarnation &&
            session.accountVersion === origin.accountVersion,
        );
        const assertSession = () => session.assertCurrent();
        accountUnit.retainCurrentness(assertSession);
        const actor = {
          principal: {
            kind: "principal" as const,
            id: text(originRow, "actor_id"),
            issuer: origin.issuer,
            subject: origin.subject,
          },
          accountRef: origin.accountId,
          requestId: text(originRow, "request_id"),
          admissionDecisionId: text(originRow, "admission_decision_id"),
        };
        return owner.runMutation(
          actor,
          [
            {
              action: "deploy",
              resource: { kind: "agent", id: scope.agentId, namespaceId: scope.namespaceId },
            },
            {
              action: "read",
              resource: {
                kind: "configuration",
                id: scope.configurationRef,
                namespaceId: scope.namespaceId,
              },
            },
            ...(originRow.service_account_id == null
              ? []
              : [
                  {
                    action: "read" as const,
                    resource: {
                      kind: "service_account" as const,
                      id: text(originRow, "service_account_id"),
                      namespaceId: scope.namespaceId,
                    },
                  },
                ]),
          ],
          async (io, retain) => {
            // The original source writer takes this exclusive prefix before any
            // profile head row. Retain the shared prefix before Namespace/Agent
            // so supported direct withdrawal cannot invert their lock order.
            await io.query(
              "SELECT pg_advisory_xact_lock_shared(hashtextextended('workload-profile-capacity:'||$1,0))",
              [scope.installationId],
            );
            // Match the existing preparation writer's advisory-before-Agent order.
            await io.query(
              "SELECT pg_advisory_xact_lock_shared(hashtextextended('runtime-preparation:'||$1,0))",
              [`preparation:${request.preparationRef}`],
            );
            const unit: WorkloadProfileDeploymentUnitV2 = Object.freeze({
              kind: "deployment",
              installationId: scope.installationId,
              namespaceId: scope.namespaceId,
              agentId: scope.agentId,
              operationRef: text(originRow, "intent_ref"),
              signal: options.signal,
              platform,
              retain,
            });
            const record: ProfileSelectedEnrollmentV2 = {
              context,
              io,
              selection,
              profileToken: context.profileToken!,
              profileOwner: owner,
              platform,
              active: true,
            };
            this.#profileSelectedUnits.set(unit, record);
            retain({
              assertCurrent: () => {
                context.assertOwnerActive();
                requirePreparation(record.active);
                return undefined;
              },
              release: async () => {
                record.active = false;
                this.#profileSelectedUnits.delete(unit);
              },
            });
            const selected = await this.workloadProfileSelectionStorageV2().enroll(scope, unit, io);
            // Capture original cleanup immediately. The selected storage's final
            // no-pending fence is valid only after its three acquisition methods
            // settle; tracked IO uses the still-live original owner during them.
            let selectionAcquired = false;
            retain({
              assertCurrent: () => {
                context.assertOwnerActive();
                requirePreparation(record.active);
                if (selectionAcquired) selected.assertCurrent();
                return undefined;
              },
              release: () => selected.release(),
            });
            await selected.lockNamespace();
            await selected.lockAgent();
            const profile = (await selected.readAdmission()) as WorkloadProfileAdmissionRecordV2;
            selectionAcquired = true;
            selected.assertCurrent();
            // The profile phase requires its exact tracked IO, not an ordinary
            // repository call. Reuse the original revision decoder after locks.
            const revisionRows = rows(
              (
                await io.query(
                  `SELECT revision.*,
              agent.service_principal_id FROM occ.agent_revisions revision
              JOIN occ.agents agent ON agent.namespace_id=revision.namespace_id AND agent.id=revision.agent_id
              WHERE revision.namespace_id=$1 AND revision.agent_id=$2 AND revision.id=$3`,
                  [scope.namespaceId, scope.agentId, scope.revisionId],
                )
              ).rows,
            );
            requirePreparation(revisionRows.length === 1);
            const revision = revisionFromRow(revisionRows[0]!);
            requirePreparation(samePreparationValue(revision.workloadProfileUse, profile.use));
            if (capabilities) {
              const manifest = deriveWorkloadProfileManifestV2(
                new TextEncoder().encode(profile.canonicalManifest),
              );
              const qualified = await capabilities.acquire(
                scope,
                manifest.content,
                profile.use,
                unit,
                io,
              );
              retain(qualified);
            }
            const history = rows(
              (
                await io.query(
                  "SELECT record FROM occ.runtime_preparation_operations WHERE preparation_ref=$1 ORDER BY local_version",
                  [request.preparationRef],
                )
              ).rows,
            ).map((row) => decodeRuntimePreparationOperation(row.record));
            const preparation = projectRuntimePreparation(history);
            requirePreparation(
              preparation &&
                preparation.localState === "open" &&
                preparation.localVersion === request.preparationVersion &&
                samePreparationValue(preparation.guard, request.guard) &&
                preparation.target.installationId === scope.installationId &&
                preparation.target.namespaceId === scope.namespaceId &&
                preparation.target.agentId === scope.agentId &&
                preparation.target.revisionId === scope.revisionId,
            );
            const child = preparation.children.find(
              (entry) => entry.child.effect.effectRef === request.effectRef,
            );
            requirePreparation(
              child &&
                child.child.request.kind === "create" &&
                samePreparationValue(child.child.guard, request.guard),
            );
            requirePreparation(
              child.child.request.admittedRuntime.configurationDigest ===
                profile.use.admittedConfigurationDigest &&
                child.child.request.preparation.admittedProfileDigest ===
                  profile.use.manifestDigest,
            );
            const current = rows(
              (
                await io.query(
                  `SELECT intent.* FROM occ.agent_runtime_intents intent
          JOIN occ.agent_runtime_intent_heads head USING(namespace_id,agent_id,generation,transition_ref)
          WHERE head.namespace_id=$1 AND head.agent_id=$2 FOR SHARE OF head`,
                  [scope.namespaceId, scope.agentId],
                )
              ).rows,
            );
            requirePreparation(current.length === 1);
            const intent = runtimeIntentFromRow(current[0]!);
            requirePreparation(
              intent.installationId === scope.installationId &&
                intent.desiredMode === "running" &&
                intent.transitionRef === request.guard.intentRef &&
                intent.transitionRef === text(originRow, "intent_ref") &&
                intent.generation === request.guard.lifecycleGeneration &&
                intent.revisionId === scope.revisionId,
            );
            const began = performance.now();
            const claimed = rows(
              (
                await io.query(
                  `SELECT actor_id,runtime_transition_ref,revision_id,
          floor(extract(epoch FROM (lease_expires_at-clock_timestamp()))*1000)::text AS remaining_ms
          FROM occ.controller_work WHERE idempotency_key=$1 AND claim_token=$2::uuid AND state='claimed'
           AND namespace_id=$3 AND agent_id=$4 AND lease_expires_at>clock_timestamp() FOR SHARE`,
                  [
                    originalClaim.idempotencyKey,
                    originalClaim.claimToken,
                    scope.namespaceId,
                    scope.agentId,
                  ],
                )
              ).rows,
            );
            requirePreparation(
              claimed.length === 1 &&
                text(claimed[0]!, "actor_id") === actor.principal.id &&
                text(claimed[0]!, "runtime_transition_ref") === intent.transitionRef &&
                text(claimed[0]!, "revision_id") === scope.revisionId,
            );
            const until = began + Number(text(claimed[0]!, "remaining_ms"));
            requirePreparation(Number.isFinite(until) && performance.now() < until);
            const assertCurrent = (): undefined => {
              context.assertOwnerActive();
              assertSession();
              selected.assertCurrent();
              requirePreparation(
                record.active && !options.signal.aborted && performance.now() < until,
              );
              return undefined;
            };
            retain({ assertCurrent, release: async () => {} });
            assertCurrent();
            const value = await work(
              Object.freeze({
                request,
                profile,
                revision,
                unit,
                child: child.child,
                providerWireUtf8: child.providerWireUtf8,
                retain,
                assertCurrent,
                release: async () => {},
              }),
              io,
            );
            assertCurrent();
            return value;
          },
        );
      },
      options,
    );
  }

  /** Exact readback uses the original current worker/session/IAM scope, with no
   * renderer launch or SDK mutation. Missing/uncertain receipts never resubmit. */
  async readRuntimePreparationSubmissionV1(
    selection: DriverSelection,
    claim: import("../ports/repositories/work.ts").WorkClaim,
    request: RuntimePreparationCurrentUseRequestV1,
    options: PlatformReadOptions,
  ): Promise<RuntimePreparationSubmissionResultV1> {
    try {
      const retained = await this.withRuntimePreparationWorkerCurrentUseV1(
        selection,
        claim,
        request,
        options,
        (lease, io) => readRuntimePreparationSubmissionV1(lease, io),
      );
      return retained ?? Object.freeze({ status: "unknown", effectRef: request.effectRef });
    } catch {
      return Object.freeze({ status: "unavailable", effectRef: request.effectRef });
    }
  }

  workloadProfileSessionSecurityV1(): WorkloadProfileSessionSecurityReaderV1 {
    return Object.freeze<WorkloadProfileSessionSecurityReaderV1>({
      lock: (unit, lookup) => {
        const guarded = this.#profileAccounts.get(unit);
        if (!guarded)
          return Promise.reject(
            new DependencyUnavailableError("The original profile session owner is unavailable."),
          );
        let released = false;
        const release = () => {
          released = true;
        };
        // The original owner holds this cleanup before input getters or SQL wait.
        const control = guarded.bindAccountOwner(release);
        const pending = readPostgresWorkloadProfileSessionV1(
          {
            installationId: unit.installationId,
            signal: unit.signal,
            assertAcquiring: () => {
              control.assertAcquiring();
              if (released)
                throw new DependencyUnavailableError("The session observation is closed.");
            },
            assertCurrent: () => {
              control.assertCurrent();
              if (released)
                throw new DependencyUnavailableError("The session observation is closed.");
              return undefined;
            },
            query: (statement, parameters) => unit.query(statement, parameters),
            retainCurrentness: (check) => guarded.unit.retainCurrentness(check),
            poison: (error) => guarded.poison(error),
            release,
          },
          lookup,
        );
        control.retainAccepted(pending.then(() => {}));
        return pending;
      },
    });
  }

  /** Constructor-captured original normalizer and operations. These methods
   * recognize the existing deployment enrollment; data objects cannot enroll it. */
  workloadProfileCandidateContextV2(
    selection: DriverSelection,
    normalizer: DeploymentCandidateNormalizerV2,
    original: DeploymentCandidateOriginalOperationsV2,
  ): Readonly<{
    candidates: WorkloadProfileCandidateContinuationV2;
    contexts: WorkloadProfileCandidateContextReaderV2;
    records: WorkloadProfileCandidateRecordsReaderV2;
  }> {
    const fail = (record: ProfileSelectedEnrollmentV2, error: unknown): never => {
      const slot = record.candidate;
      if (slot && !slot.failed) {
        slot.failed = true;
        slot.first = error;
      }
      const first = slot?.failed ? slot.first : error;
      try {
        record.profileOwner.poison(first);
      } finally {
        throw first;
      }
    };
    const recognized = (
      unit: WorkloadProfileDeploymentUnitV2,
      io: WorkloadProfileOwnedOperationV2,
      acquiring: boolean,
    ): ProfileSelectedEnrollmentV2 => {
      const record = this.#profileSelectedUnits.get(unit);
      if (!record) throw new ScopeViolationError("The original candidate owner is unavailable.");
      try {
        const binding = record.deploymentBinding;
        if (
          !record.active ||
          unit.kind !== "deployment" ||
          !binding ||
          record.io !== io ||
          record.selection !== selection ||
          record.context.profileToken !== record.profileToken ||
          this.#profileContexts.get(record.profileToken) !== record.context ||
          record.context.protectedProfile !== record.profileOwner ||
          record.context.readOnly ||
          unit.platform !== record.platform ||
          unit.operationRef !== binding[1].command.operationRef ||
          unit.namespaceId !== binding[1].namespaceId ||
          unit.agentId !== binding[1].agentId ||
          unit.signal.aborted
        )
          throw new ScopeViolationError("The candidate does not belong to this deployment owner.");
        record.context.assertOwnerActive();
        if (acquiring) {
          io.assertActive();
          record.profileOwner.assertOperationActive();
        }
        if (record.candidate?.failed) throw record.candidate.first;
        return record;
      } catch (error) {
        return fail(record, error);
      }
    };
    const tracked = <Value>(
      record: ProfileSelectedEnrollmentV2,
      work: () => Promise<Value>,
    ): Promise<Value> => {
      const task = Promise.resolve()
        .then(work)
        .catch((error) => fail(record, error));
      const joined = task.then(
        () => {},
        () => {},
      );
      record.context.profileEnrollments.add(joined);
      record.candidate?.pending.add(joined);
      void joined.then(() => {
        record.context.profileEnrollments.delete(joined);
        record.candidate?.pending.delete(joined);
      });
      return task;
    };
    const observe = (
      ...[input, suppliedCandidate, unit, io]: Parameters<
        WorkloadProfileCandidateContextReaderV2["readLocked"]
      >
    ) => {
      const record = recognized(unit, io, true);
      try {
        const slot = record.candidate;
        if (
          !slot?.accepting ||
          !slot.completed ||
          !slot.head ||
          !slot.snapshot ||
          !slot.configuration ||
          !slot.observations
        )
          throw new ScopeViolationError(
            "No completed original candidate and profile head are captured.",
          );
        const request = decodeWorkloadProfileSelectionRequestV2(input);
        const candidate = immutableCopy(suppliedCandidate);
        const expected = record.deploymentBinding![1].command.expectedDraft;
        if (
          request.installationId !== unit.installationId ||
          request.namespaceId !== unit.namespaceId ||
          request.agentId !== unit.agentId ||
          request.revisionId !== slot.snapshot.id ||
          request.configurationRef !== slot.configuration.configurationRef ||
          request.configurationVersion !== slot.configuration.configurationGeneration ||
          !sameCandidateDataV2(request.selection, expected.workloadProfileSelection) ||
          !sameCandidateDataV2(request.selection, slot.head.selection) ||
          !sameCandidateDataV2(candidate, slot.snapshot)
        )
          throw new ScopeViolationError(
            "The copied candidate differs from original normalization.",
          );
        let released = false;
        const current = (): undefined => {
          recognized(unit, io, false);
          if (released || !slot.completed || record.candidate !== slot)
            return fail(record, new ScopeViolationError("The candidate observation expired."));
          slot.assertCurrent();
          return undefined;
        };
        current();
        return Object.freeze({
          configuration: slot.configuration,
          observations: slot.observations,
          head: slot.head,
          sourceIdentity: slot.sourceIdentity,
          assertCurrent: current,
          release: async () => {
            released = true;
          },
        });
      } catch (error) {
        return fail(record, error);
      }
    };
    const contexts = Object.freeze<WorkloadProfileCandidateContextReaderV2>({
      readLocked: async (...args) => {
        const observed = observe(...args);
        return Object.freeze({
          configuration: observed.configuration,
          assertCurrent: observed.assertCurrent,
          release: observed.release,
        });
      },
    });
    const records = Object.freeze<WorkloadProfileCandidateRecordsReaderV2>({
      readLocked: async (...args) => {
        const observed = observe(...args);
        return Object.freeze({
          sourceIdentity: observed.sourceIdentity,
          records: Object.freeze({
            configuration: observed.configuration,
            ...observed.observations,
            head: observed.head,
          }),
          assertCurrent: observed.assertCurrent,
          release: observed.release,
        });
      },
    });
    const candidates = Object.freeze<WorkloadProfileCandidateContinuationV2>({
      withCandidate: (unit, io, resolveHarness, work) => {
        const record = recognized(unit, io, true);
        if (record.candidate)
          return fail(
            record,
            new ScopeViolationError("This candidate attempt is already consumed."),
          );
        const [principalId, input] = record.deploymentBinding!;
        const command = input.command;
        // Builder construction is inert. Install the slot and cleanup before
        // it reads any repository/Driver or calls the original normalizer.
        const capture = makeTrackedCandidateOperations({
          unit,
          selection,
          original,
          operands: Object.freeze([
            principalId,
            Object.freeze({
              namespaceId: input.namespaceId,
              agentId: input.agentId,
              expectedLifecycleGeneration: command.expectedLifecycleGeneration,
            }),
            command,
          ]),
          assertAcquiring: () => {
            recognized(unit, io, true);
          },
          assertOwner: () => {
            recognized(unit, io, false);
          },
          track: (operation) => tracked(record, operation),
          poison: (error) => fail(record, error),
        });
        const slot: ProfileCandidateSlotV2 = {
          accepting: true,
          completed: false,
          headStarted: false,
          sourceIdentity: Object.freeze(Object.create(null)) as object,
          failed: false,
          pending: new Set(),
          assertCurrent: capture.assertCurrent,
        };
        record.candidate = slot;
        unit.retain({
          assertCurrent: () => {
            recognized(unit, io, false);
            capture.assertCurrent();
            return undefined;
          },
          release: async () => {
            slot.accepting = false;
            while (slot.pending.size > 0) await Promise.allSettled([...slot.pending]);
            await capture.release();
          },
        });
        return tracked(record, async () => {
          try {
            const result = await normalizer(
              Object.freeze([
                principalId,
                Object.freeze({
                  namespaceId: input.namespaceId,
                  agentId: input.agentId,
                  expectedLifecycleGeneration: command.expectedLifecycleGeneration,
                }),
                command,
              ]),
              resolveHarness,
              capture.operations,
            );
            recognized(unit, io, true);
            const observed = capture.finish(result);
            slot.snapshot = immutableCopy(result.candidate);
            slot.configuration = immutableCopy({
              configurationRef: observed.metadata.id,
              configurationGeneration: observed.metadata.generation,
              immutableConfigurationContent: {
                kind: "agent",
                values: observed.validated.values,
                secretBindings: observed.secretBindings,
              },
            });
            slot.observations = Object.freeze({
              agent: observed.agent,
              serviceAccount: observed.serviceAccount,
              providerBinding: observed.providerBinding,
              secrets: observed.secrets,
            });
            slot.completed = true;
            capture.assertCurrent();
            return await work(result);
          } catch (error) {
            return fail(record, error);
          } finally {
            slot.accepting = false;
          }
        });
      },
    });
    return Object.freeze({ candidates, contexts, records });
  }

  /** Server-owned composition over the original mutation/read callback. Missing
   * authentic account participation refuses before the protected callback. */
  workloadProfileMutationEnrollmentV2(
    selection: DriverSelection,
    account?: WorkloadProfileMutationAccountParticipantV2<
      ProfileDeploymentBindingV2,
      ProfileDraftBindingV2
    >,
  ): Readonly<{
    enrollment: WorkloadProfileMutationEnrollmentV2<
      ProfileDeploymentBindingV2,
      ProfileDraftBindingV2
    >;
    activeReader: WorkloadProfileActiveReaderV2;
  }> {
    const runOwned = async <Value>(
      kind: "deployment" | "agent-selection" | "deployment-recovery",
      invocation: AuthenticatedRequestHandleV1,
      original: ProfileDeploymentBindingV2 | ProfileDraftBindingV2,
      work: (
        unit:
          | WorkloadProfileDeploymentUnitV2
          | WorkloadProfileDraftUnitV2
          | WorkloadProfileRecoveryUnitV2,
        io: WorkloadProfileOwnedOperationV2,
      ) => Promise<Value>,
    ): Promise<Value> => {
      const ambient = this.#profileAmbient.getStore();
      if (
        !ambient ||
        !account ||
        Object.getPrototypeOf(selection) !== DriverSelection.prototype ||
        selection.selectedDriver !== DriverSelection.prototype.selectedDriver ||
        selection.acquireGuardedSelection !== DriverSelection.prototype.acquireGuardedSelection
      )
        throw new DependencyUnavailableError(
          "The genuine profile mutation enrollment is unavailable.",
        );
      const { context, platform } = ambient;
      const binding = immutableCopy(original);
      const [principalId, input] = binding;
      if (
        context.protectedProfile ||
        context.turn ||
        context.gateway ||
        context.credential ||
        context.fresh ||
        (kind === "deployment-recovery") !== context.readOnly ||
        !principalId ||
        !input.namespaceId ||
        !input.agentId
      )
        throw new ScopeViolationError("The profile mutation requires its original isolated owner.");
      const command =
        kind === "agent-selection"
          ? undefined
          : parseLifecycleDeployV2("command", (input as DeployAgentCommandInput).command);
      const operationRef = command?.operationRef;
      const policy = context.profilePhase.claimGuardedPolicy("mutation", () => {
        if (!context.protectedProfile)
          throw new ScopeViolationError("The original mutation operation is unavailable.");
        context.protectedProfile.assertOperationActive();
      });
      if (context.readOnly) {
        if (context.dataQueryStarted)
          throw new ScopeViolationError("Recovery enrollment must precede the first data read.");
        await context.profileQuery("SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE");
      }
      const installation = await this.requireInitialized(context);
      const driver = selection.selectedDriver("iam");
      const selected = selection.acquireGuardedSelection("iam", driver);
      let cleanupOwned = false;
      try {
        const token = Object.freeze({});
        context.profileToken = token;
        this.#profileContexts.set(token, context);
        const iam = bindNativeIAMTransaction(driver, this, token);
        const guarded = createGuardedWorkloadProfileUnit({
          installationId: installation.id,
          signal: context.profileSignal,
          assertActive: () => context.lifetime.assertActive(),
          assertOwnerActive: context.assertOwnerActive,
          assertSelection: () => {
            selected.assertCurrent();
            iam.assertCurrent();
          },
          query: (statement, parameters) => context.profileQuery(statement, parameters),
          accountQuery: (statement, parameters) => {
            policy.assertPolicy();
            return context.profileQuery(statement, parameters);
          },
          lockPolicy: async () => {
            policy.assertPolicy();
            await context.profileQuery("SELECT occ.lock_workload_profile_iam()");
            context.lifetime.assertActive();
            context.profilePolicyLocked = true;
            policy.complete();
          },
          iam,
          profiles: platform.workloadProfiles,
          resolveNamespace: async () => {
            throw new ScopeViolationError("Mutation enrollment cannot manage profile heads.");
          },
          findAudit: async () => {
            throw new ScopeViolationError("Mutation enrollment cannot prepare profiles.");
          },
          appendAudit: (event) => this.appendAudit(context, event, context.profileQuery),
        });
        context.protectedProfile = guarded;
        context.profileMutation = true;
        this.#profileAccounts.set(guarded.unit.account, guarded);
        this.#profileSourceSelections.set(guarded.unit.account, selection);
        guarded.unit.account.retainSecurityCleanup(() => selected.release());
        cleanupOwned = true;
        const timer = setTimeout(context.abortProfile, 3000);
        guarded.unit.account.retainSecurityCleanup(() => clearTimeout(timer));
        await context.profileQuery(
          "SELECT set_config('statement_timeout','3000ms',true),set_config('transaction_timeout','3000ms',true)",
        );
        const request =
          kind === "agent-selection"
            ? {
                purpose: "workload-profile-draft-selection" as const,
                binding: binding as ProfileDraftBindingV2,
              }
            : {
                purpose:
                  kind === "deployment"
                    ? ("workload-profile-deployment" as const)
                    : ("workload-profile-deployment-recovery" as const),
                binding: binding as ProfileDeploymentBindingV2,
              };
        const lease = await account.consume(invocation, request, guarded.unit.account);
        const release = lease.release;
        if (typeof release !== "function")
          throw new DependencyUnavailableError("The account cleanup is unavailable.");
        guarded.unit.account.retainSecurityCleanup(() => Reflect.apply(release, lease, []));
        const current = lease.assertCurrent;
        if (typeof current !== "function")
          throw new DependencyUnavailableError("The account currentness is unavailable.");
        guarded.unit.retainCurrentness(() => Reflect.apply(current, lease, []));
        const actor = immutableCopy({
          principal: lease.principal,
          accountRef: lease.accountRef,
          requestId: lease.requestId,
          admissionDecisionId: lease.admissionDecisionId,
        });
        if (actor.principal.id !== principalId)
          throw new ScopeViolationError("The original actor does not match the request.");
        const configurationId =
          kind === "agent-selection"
            ? (input as UpdateAgentInput).configurationId
            : (input as DeployAgentCommandInput).command.expectedDraft.configurationId;
        const serviceAccountId =
          kind === "agent-selection"
            ? (input as UpdateAgentInput).serviceAccountId
            : (input as DeployAgentCommandInput).command.expectedDraft.serviceAccountId;
        const targets: Array<
          Omit<import("@openclaw-enterprise/contracts").AuthorizationRequest, "principalId">
        > = [
          {
            action:
              kind === "deployment" ? "deploy" : kind === "agent-selection" ? "update" : "read",
            resource: { kind: "agent", id: input.agentId, namespaceId: input.namespaceId },
          },
          {
            action: "read",
            resource: {
              kind: "configuration",
              id: configurationId,
              namespaceId: input.namespaceId,
            },
          },
          ...(serviceAccountId == null
            ? []
            : [
                {
                  action: "read" as const,
                  resource: {
                    kind: "service_account" as const,
                    id: serviceAccountId,
                    namespaceId: input.namespaceId,
                  },
                },
              ]),
        ];
        return await guarded.runMutation(actor, targets, async (io, retain) => {
          // Original deployment/draft normalization can lock Namespace/Agent
          // before selecting a profile. Share the source writer's earlier prefix.
          await io.query(
            "SELECT pg_advisory_xact_lock_shared(hashtextextended('workload-profile-capacity:'||$1,0))",
            [installation.id],
          );
          const common = {
            installationId: installation.id,
            namespaceId: input.namespaceId,
            agentId: input.agentId,
            signal: context.profileSignal,
            retain,
          };
          const unit:
            | WorkloadProfileDeploymentUnitV2
            | WorkloadProfileDraftUnitV2
            | WorkloadProfileRecoveryUnitV2 =
            kind === "deployment-recovery"
              ? Object.freeze({
                  ...common,
                  kind,
                  operationRef: operationRef!,
                  read: context.readView!,
                })
              : kind === "deployment"
                ? Object.freeze({ ...common, kind, operationRef: operationRef!, platform })
                : Object.freeze({ ...common, kind, platform });
          const enrolled: ProfileSelectedEnrollmentV2 = {
            context,
            io,
            active: true,
            selection,
            profileToken: token,
            profileOwner: guarded,
            platform,
            ...(kind === "deployment"
              ? { deploymentBinding: binding as ProfileDeploymentBindingV2 }
              : {}),
          };
          this.#profileSelectedUnits.set(unit, enrolled);
          retain({
            assertCurrent: () => {
              context.assertOwnerActive();
              if (!enrolled.active) throw new ScopeViolationError("The profile unit expired.");
              return undefined;
            },
            release: async () => {
              enrolled.active = false;
              this.#profileSelectedUnits.delete(unit);
            },
          });
          const value = await work(unit, io);
          // First admission only: the completed original normalization slot is
          // absent on exact replay. Historical admissions are never backfilled
          // with a later caller's session. This write shares revision/intent/work
          // COMMIT and inherits the original account/session final fences.
          if (
            kind === "deployment" &&
            enrolled.candidate?.snapshot &&
            lease.preparationSessionOrigin
          ) {
            await retainRuntimePreparationOriginV1(io, {
              deployment: input as DeployAgentCommandInput,
              revisionId: enrolled.candidate.snapshot.id,
              principalId,
              accountRef: lease.accountRef,
              requestId: lease.requestId,
              admissionDecisionId: lease.admissionDecisionId,
              origin: lease.preparationSessionOrigin,
            });
          }
          return value;
        });
      } catch (error) {
        context.protectedProfile?.poison(error);
        if (!context.protectedProfile)
          void context.profilePhase.guard
            .run(async () => {
              throw error;
            })
            .catch(() => {});
        throw error;
      } finally {
        if (!cleanupOwned) selected.release();
      }
    };
    const run = <Value>(
      kind: "deployment" | "agent-selection" | "deployment-recovery",
      invocation: AuthenticatedRequestHandleV1,
      binding: ProfileDeploymentBindingV2 | ProfileDraftBindingV2,
      work: (
        unit:
          | WorkloadProfileDeploymentUnitV2
          | WorkloadProfileDraftUnitV2
          | WorkloadProfileRecoveryUnitV2,
        io: WorkloadProfileOwnedOperationV2,
      ) => Promise<Value>,
    ): Promise<Value> => {
      const ambient = this.#profileAmbient.getStore();
      if (!ambient)
        return Promise.reject(
          new DependencyUnavailableError("The original profile transaction is unavailable."),
        );
      const { context } = ambient;
      const reject = (error: unknown): never => {
        context.protectedProfile?.poison(error);
        void context.profilePhase.guard
          .run(async () => {
            throw error;
          })
          .catch(() => {});
        throw error;
      };
      let result: Promise<Value>;
      try {
        if (context.profileEnrollmentClosed)
          throw new ScopeViolationError("Profile enrollment admissions are closed.");
        result = context.lifetime
          .run(() => runOwned(kind, invocation, binding, work))
          .catch(reject);
      } catch (error) {
        result = Promise.reject(error).catch(reject);
      }
      const joined = result.then(
        () => {},
        () => {},
      );
      context.profileEnrollments.add(joined);
      void joined.then(() => context.profileEnrollments.delete(joined));
      return result;
    };
    const enrollment: WorkloadProfileMutationEnrollmentV2<
      ProfileDeploymentBindingV2,
      ProfileDraftBindingV2
    > = Object.freeze<
      WorkloadProfileMutationEnrollmentV2<ProfileDeploymentBindingV2, ProfileDraftBindingV2>
    >({
      withDeployment: (invocation, binding, work) =>
        run("deployment", invocation, binding, (unit, io) => {
          if (unit.kind !== "deployment")
            throw new ScopeViolationError("The deployment owner differs.");
          return work(unit, io);
        }),
      withDraft: (invocation, binding, work) =>
        run("agent-selection", invocation, binding, (unit, io) => {
          if (unit.kind !== "agent-selection")
            throw new ScopeViolationError("The draft owner differs.");
          return work(unit, io);
        }),
      withRecovery: (invocation, binding, work) =>
        run("deployment-recovery", invocation, binding, (unit, io) => {
          if (unit.kind !== "deployment-recovery")
            throw new ScopeViolationError("The recovery owner differs.");
          return work(unit, io);
        }),
    });
    const activeReader: WorkloadProfileActiveReaderV2 =
      Object.freeze<WorkloadProfileActiveReaderV2>({
        readLocked: async (requestInput, unit, io) => {
          const record = this.#profileSelectedUnits.get(unit);
          const request = immutableCopy(requestInput);
          if (
            !record?.active ||
            record.io !== io ||
            request.installationId !== unit.installationId ||
            request.namespaceId !== unit.namespaceId ||
            request.agentId !== unit.agentId
          )
            throw new ScopeViolationError("The exact selected profile read owner is unavailable.");
          io.assertActive();
          const slot = unit.kind === "deployment" ? record.candidate : undefined;
          if (unit.kind === "deployment") {
            if (!slot?.accepting || !slot.completed || slot.headStarted) {
              const error = new ScopeViolationError(
                "Original normalization must complete before the profile head.",
              );
              record.profileOwner.poison(error);
              throw error;
            }
            slot.headStarted = true;
          }
          const namespace = rows(
            (
              await io.query(
                "SELECT id FROM occ.namespaces WHERE id=$1 AND status='ready' AND deleted_at IS NULL FOR SHARE",
                [unit.namespaceId],
              )
            ).rows,
          );
          if (namespace.length !== 1)
            throw new ScopeViolationError("The selected Namespace is unavailable.");
          const agent = rows(
            (
              await io.query(
                "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR SHARE",
                [unit.namespaceId, unit.agentId],
              )
            ).rows,
          );
          if (agent.length !== 1)
            throw new ScopeViolationError("The selected Agent is unavailable.");
          const backend = createPostgresWorkloadProfileAdmissionBackendV2(
            {
              scope: { installationId: unit.installationId },
              transaction: { assertActive: () => io.assertActive() },
              query: { query: io.query },
            },
            async () => {
              throw new ScopeViolationError(
                "A selected-use reader cannot append an admission audit.",
              );
            },
          );
          await backend.lockHeads(unit.namespaceId, [request.selection.admissionRef], "share");
          const stored = await backend.head(unit.namespaceId, request.selection.admissionRef);
          const head = decodeWorkloadProfileAdmissionHeadV2(stored);
          if (
            head.state !== "admitted" ||
            head.selection.manifestRef !== request.selection.manifestRef ||
            head.selection.manifestDigest !== request.selection.manifestDigest ||
            head.selection.admissionVersion !== request.selection.admissionVersion
          )
            throw new ResourceConflictError("The selected profile admission changed.");
          io.assertActive();
          if (slot) slot.head = head;
          return Object.freeze({
            head,
            assertCurrent: () => {
              record.context.assertOwnerActive();
              if (!record.active)
                throw new ScopeViolationError("The selected profile owner expired.");
              return undefined;
            },
            release: async () => {},
          });
        },
      });
    return Object.freeze({ enrollment, activeReader });
  }

  /** Actual selected-use persistence on the original owner. This supplies no
   * native/capability/H qualifier and recognizes no caller-provided unit shape. */
  workloadProfileSelectionStorageV2(): WorkloadProfileSelectionStorageV2 {
    return Object.freeze<WorkloadProfileSelectionStorageV2>({
      enroll: async (input, unit, io) => {
        const request = decodeWorkloadProfileSelectionRequestV2(input);
        const deployment = this.#profileSelectedUnits.get(unit);
        const gateway = this.#gatewayExecution.getStore();
        const unavailable = () =>
          new ScopeViolationError("The original selected profile storage unit is unavailable.");
        const context = deployment?.context ?? gateway?.context;
        const ownerCurrent = () => {
          if (!context) throw unavailable();
          context.assertOwnerActive();
          if (deployment) {
            if (
              !deployment.active ||
              deployment.io !== io ||
              !("kind" in unit) ||
              unit.kind !== "deployment" ||
              unit.installationId !== request.installationId ||
              unit.namespaceId !== request.namespaceId ||
              unit.agentId !== request.agentId
            )
              throw unavailable();
          } else {
            if (
              gateway?.version !== 2 ||
              !gateway.active ||
              gateway.unit !== unit ||
              this.#gatewayContexts.get(gateway.token) !== gateway ||
              gateway.context.gateway !== gateway.execution ||
              gateway.policyState !== "locked" ||
              gateway.installationId !== request.installationId ||
              gateway.unit.subject.namespaceRef !== request.namespaceId ||
              gateway.unit.subject.agentRef !== request.agentId ||
              gateway.bounds.signal.aborted
            )
              throw unavailable();
            gateway.selected.assertCurrent();
          }
        };
        // The exact IO slot authenticates this acquisition only. Its original
        // resolver clears that slot before retained final fences execute.
        if (!deployment && (gateway?.version !== 2 || gateway.selectionIO !== io))
          throw unavailable();
        ownerCurrent();
        io.assertActive();
        const pending = new Set<Promise<unknown>>();
        let active = true,
          failed = false,
          failure: unknown,
          stage = 0;
        let terminal: Promise<void> | undefined;
        const poison = (error: unknown) => {
          if (!failed) {
            failed = true;
            failure = error;
          }
          try {
            io.poison(error);
          } catch {
            /* original failure remains primary */
          }
        };
        const current = (): undefined => {
          ownerCurrent();
          if (!active) throw unavailable();
          if (failed) throw failure;
          if (pending.size) throw unavailable();
          return undefined;
        };
        const operation = <Value>(expected: number, work: () => Promise<Value>): Promise<Value> => {
          let result: Promise<Value>;
          try {
            current();
            io.assertActive();
            if (stage !== expected) throw unavailable();
            stage++;
            result = (async () => {
              const value = await work();
              ownerCurrent();
              io.assertActive();
              return value;
            })();
          } catch (error) {
            result = Promise.reject(error);
          }
          pending.add(result);
          void result.then(
            () => pending.delete(result),
            (error) => {
              poison(error);
              pending.delete(result);
            },
          );
          return result;
        };
        const release = (): Promise<void> => {
          if (terminal) return terminal;
          active = false;
          terminal = Promise.resolve().then(async () => {
            while (pending.size) await Promise.allSettled([...pending]);
          });
          return terminal;
        };
        // SQL row/advisory locks remain owned by the outer transaction after the
        // short acquisition closes; the returned fence never uses that expired IO.
        return Object.freeze({
          assertCurrent: current,
          release,
          lockNamespace: () =>
            operation(0, async () => {
              const found = rows(
                (
                  await io.query(
                    "SELECT id FROM occ.namespaces WHERE id=$1 AND status='ready' AND deleted_at IS NULL FOR SHARE",
                    [request.namespaceId],
                  )
                ).rows,
              );
              if (found.length !== 1 || text(found[0]!, "id") !== request.namespaceId)
                throw unavailable();
              return Object.freeze({ namespaceId: request.namespaceId });
            }),
          lockAgent: () =>
            operation(1, async () => {
              const found = rows(
                (
                  await io.query(
                    "SELECT id,namespace_id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR SHARE",
                    [request.namespaceId, request.agentId],
                  )
                ).rows,
              );
              if (
                found.length !== 1 ||
                text(found[0]!, "id") !== request.agentId ||
                text(found[0]!, "namespace_id") !== request.namespaceId
              )
                throw unavailable();
              return Object.freeze({ namespaceId: request.namespaceId, agentId: request.agentId });
            }),
          readAdmission: () =>
            operation(2, async () => {
              const backend = createPostgresWorkloadProfileAdmissionBackendV2(
                {
                  scope: { installationId: request.installationId },
                  transaction: { assertActive: () => io.assertActive() },
                  query: { query: (statement, parameters) => io.query(statement, parameters) },
                },
                async () => {
                  throw unavailable();
                },
              );
              await backend.lockHeads(
                request.namespaceId,
                [request.selection.admissionRef],
                "share",
              );
              const head = decodeWorkloadProfileAdmissionHeadV2(
                await backend.head(request.namespaceId, request.selection.admissionRef),
              );
              // Revisions are immutable and the application has no UPDATE
              // privilege. Mutable Namespace, Agent and profile heads are held;
              // an immutable revision read must not require FOR SHARE privilege.
              const found = rows(
                (
                  await io.query(
                    `SELECT id,namespace_id,agent_id,admitted_spec FROM occ.agent_revisions
            WHERE namespace_id=$1 AND agent_id=$2 AND id=$3`,
                    [request.namespaceId, request.agentId, request.revisionId],
                  )
                ).rows,
              );
              if (found.length !== 1) throw unavailable();
              const revision = found[0]!;
              const spec = jsonObject(revision.admitted_spec);
              const decoded = decodeWorkloadProfileUseV2(spec.workload_profile_use);
              if (decoded.kind !== "valid") throw unavailable();
              const use = decoded.value;
              const configurationRef = spec.configuration_id,
                configurationVersion = spec.configuration_generation;
              if (
                head.state !== "admitted" ||
                head.scope.installationId !== request.installationId ||
                head.scope.namespaceId !== request.namespaceId ||
                head.selection.admissionRef !== use.admissionRef ||
                head.selection.admissionVersion !== use.admissionVersion ||
                head.selection.manifestRef !== use.manifestRef ||
                head.selection.manifestDigest !== use.manifestDigest ||
                use.installationId !== request.installationId ||
                use.namespaceId !== request.namespaceId ||
                use.admissionRef !== request.selection.admissionRef ||
                use.admissionVersion !== request.selection.admissionVersion ||
                use.manifestRef !== request.selection.manifestRef ||
                use.manifestDigest !== request.selection.manifestDigest ||
                configurationRef !== request.configurationRef ||
                configurationVersion !== request.configurationVersion ||
                Object.entries(use.profileRefs).some(([role, value]) => {
                  const original = head.profileRefs[role as keyof typeof head.profileRefs];
                  return (
                    value.ref !== original.ref ||
                    value.version !== original.version ||
                    value.contentDigest !== original.contentDigest
                  );
                })
              )
                throw unavailable();
              return immutableCopy({
                schemaVersion: 2,
                state: "admitted",
                use,
                canonicalManifest: head.canonicalManifest,
                revision: {
                  id: text(revision, "id"),
                  namespaceId: text(revision, "namespace_id"),
                  agentId: text(revision, "agent_id"),
                  workloadProfileUse: use,
                  configurationRef,
                  configurationVersion,
                },
                configuration: {
                  ref: configurationRef,
                  version: configurationVersion,
                  admittedConfigurationDigest: use.admittedConfigurationDigest,
                },
              });
            }),
        });
      },
    });
  }

  private assertGatewayAuthorityOperationV1(
    record: GatewayStartupEnrollment,
    io: GatewayStartupAcceptedOperationV1,
  ): void {
    try {
      if (
        !record.active ||
        this.#gatewayExecution.getStore() !== record ||
        this.#gatewayContexts.get(record.token) !== record ||
        record.authorityIO !== io ||
        record.unit.policy !== record.policy ||
        record.context.gateway !== record.execution ||
        record.execution.phase !== record.phase ||
        record.bounds.signal.aborted
      )
        throw new DependencyUnavailableError("The Gateway authority operation is unavailable.");
      if (record.version === 2) {
        const subject = parseGatewayStartupSubjectV2(record.command.subject);
        if (
          subject.installationId !== record.installationId ||
          subject.namespaceRef !== record.unit.subject.namespaceRef ||
          subject.agentRef !== record.unit.subject.agentRef
        )
          throw new DependencyUnavailableError(
            "The Gateway subject correspondence is unavailable.",
          );
      } else if (record.unit.installationId !== record.installationId) {
        throw new DependencyUnavailableError(
          "The Gateway Installation correspondence is unavailable.",
        );
      }
      io.assertActive();
      record.context.lifetime.assertActive();
      record.selected.assertCurrent();
      record.nativeIAM.assertCurrent();
    } catch (error) {
      this.#gatewayExecution.getStore()?.phase.poison(error);
      record.phase.poison(error);
      throw error;
    }
  }

  /** No public producer/configuration is created here. Only the original owner
   * can compose the genuine private participants with the released Runtime owner. */
  private bindGatewayAuthorityConsumerV1<
    Args extends [
      invocation: unknown,
      command: GatewayStartupCommandV1 | GatewayStartupCommandV2,
      bounds: GatewayStartupCommandBoundsV1,
      unit: GatewayStartupOwnerUnitV1 | GatewayStartupOwnerUnitV2,
      io: GatewayStartupAcceptedOperationV1,
    ],
  >(
    version: 1 | 2,
    consume: (
      ...args: [...Args, policy: GatewayStartupPrivatePolicyV1]
    ) => Promise<GatewayStartupAuthorityLeaseV1>,
  ): (...args: Args) => Promise<GatewayStartupAuthorityLeaseV1> {
    const unavailable = () =>
      new DependencyUnavailableError("The Gateway startup owner is unavailable.");
    return async (...args: Args) => {
      const [invocation, command, bounds, unit, io] = args;
      const record = this.#gatewayExecution.getStore();
      if (
        record === undefined ||
        !record.active ||
        record.version !== version ||
        record.unit !== unit ||
        record.command !== command ||
        record.bounds !== bounds ||
        record.policy !== unit.policy ||
        record.authorityStarted
      ) {
        const error = unavailable();
        record?.phase.poison(error);
        throw error;
      }
      record.authorityStarted = true;
      record.authorityIO = io;
      let lease: GatewayStartupAuthorityLeaseV1 | undefined;
      let transferred = false;
      let release: (() => Promise<void>) | undefined;
      try {
        this.assertGatewayAuthorityOperationV1(record, io);
        // These synchronous native/selection fences do not issue SQL and
        // remain usable after the authority operation/lifetime has ended.
        record.phase.retainCurrentness(() => {
          record.selected.assertCurrent();
          record.nativeIAM.assertCurrent();
          return undefined;
        });
        const assertLocked = () => {
          this.assertGatewayAuthorityOperationV1(record, io);
          if (record.policyState !== "locked") throw unavailable();
        };
        const iam: NativeIAMTransactionView = Object.freeze({
          assertCurrent: () => {
            try {
              assertLocked();
            } catch (error) {
              record.phase.poison(error);
              throw error;
            }
          },
          lookupIdentity: async (
            input: Parameters<NativeIAMTransactionView["lookupIdentity"]>[0],
          ) => {
            try {
              assertLocked();
              const result = await record.nativeIAM.lookupIdentity(input);
              assertLocked();
              return result;
            } catch (error) {
              record.phase.poison(error);
              throw error;
            }
          },
          authorize: async (request: Parameters<NativeIAMTransactionView["authorize"]>[0]) => {
            try {
              assertLocked();
              const result = await record.nativeIAM.authorize(request);
              assertLocked();
              return result;
            } catch (error) {
              record.phase.poison(error);
              throw error;
            }
          },
        });
        const policy: GatewayStartupPrivatePolicyV1 = Object.freeze({
          iam,
          lockPolicy: async () => {
            try {
              this.assertGatewayAuthorityOperationV1(record, io);
              if (record.policyState !== "unlocked") throw unavailable();
              record.policyState = "locking";
              // Genuine authority locks account/security/registration first.
              // This existing function holds the complete native IAM writer set.
              await io.query("SELECT occ.lock_workload_profile_iam()");
              this.assertGatewayAuthorityOperationV1(record, io);
              record.policyState = "locked";
            } catch (error) {
              record.phase.poison(error);
              throw error;
            }
          },
        });
        lease = await consume(...args, policy);
        release = lease.release.bind(lease);
        this.assertGatewayAuthorityOperationV1(record, io);
        if (record.policyState !== "locked") throw unavailable();
        if (record.version === 2) {
          const subject = record.unit.subject;
          // Genuine account/security and the complete IAM policy barrier precede
          // these protected parents. The consumed lease is already owned locally;
          // failed parent acquisition joins its cleanup before transfer to Runtime.
          const namespace = await io.query("SELECT id FROM occ.namespaces WHERE id=$1 FOR SHARE", [
            subject.namespaceRef,
          ]);
          this.assertGatewayAuthorityOperationV1(record, io);
          if (namespace.rowCount !== 1) throw unavailable();
          const agent = await io.query(
            "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR SHARE",
            [subject.namespaceRef, subject.agentRef],
          );
          this.assertGatewayAuthorityOperationV1(record, io);
          if (agent.rowCount !== 1) throw unavailable();
        }
        transferred = true;
        return lease;
      } catch (error) {
        record.phase.poison(error);
        // Runtime has not received this lease yet; keep its failed acquisition
        // release inside the accepted authority operation before rejecting.
        if (lease !== undefined && !transferred) {
          try {
            await release?.();
          } catch (cleanupError) {
            record.phase.poison(cleanupError);
          }
        }
        throw error;
      } finally {
        record.authorityIO = undefined;
      }
    };
  }

  private bindGatewayStartupOwnersV1(
    source?: GatewayStartupCentralParticipantsV1,
  ): GatewayStartupOwnerBindingV1 {
    const selection = source?.driverSelection;
    let participants: GatewayStartupOwnerParticipantsV1 | undefined;

    // Capture actual producer methods once, matching Runtime's own capture.
    if (
      source !== undefined &&
      typeof source.authority?.consume === "function" &&
      typeof source.selection?.resolveLocked === "function" &&
      typeof source.process?.requireDisposition === "function" &&
      typeof source.process?.requireCurrent === "function" &&
      typeof source.audit?.append === "function" &&
      typeof source.allocate === "function"
    ) {
      const consume = source.authority.consume.bind(source.authority);
      participants = Object.freeze({
        authority: Object.freeze({
          consume: this.bindGatewayAuthorityConsumerV1(1, consume),
        }),
        selection: Object.freeze({
          resolveLocked: source.selection.resolveLocked.bind(source.selection),
        }),
        process: Object.freeze({
          requireDisposition: source.process.requireDisposition.bind(source.process),
          requireCurrent: source.process.requireCurrent.bind(source.process),
        }),
        audit: Object.freeze({ append: source.audit.append.bind(source.audit) }),
        allocate: source.allocate.bind(source),
      });
    }

    const transaction: GatewayStartupTransactionOwnerV1 = Object.freeze({
      run: (...args: Parameters<GatewayStartupTransactionOwnerV1["run"]>) =>
        this.runGatewayStartupTransactionV1({ version: 1, args, selection, participants }),
    });
    return Object.freeze({ transaction, ...(participants === undefined ? {} : { participants }) });
  }

  private bindGatewayCredentialSelectionV2(
    resolve: RuntimeCredentialSelectionResolverV2["resolveLocked"],
  ): GatewayStartupOwnerParticipantsV2["selection"]["resolveLocked"] {
    return async (...args) => {
      const [command, _original, unit, io] = args;
      const record = this.#gatewayExecution.getStore();
      const unavailable = () =>
        new ScopeViolationError("The protected Gateway selection is unavailable.");
      const assertOperation = () => {
        if (
          record?.version !== 2 ||
          !record.active ||
          this.#gatewayExecution.getStore() !== record ||
          this.#gatewayContexts.get(record.token) !== record ||
          record.command !== command ||
          record.unit !== unit ||
          record.selectionIO !== io ||
          record.policyState !== "locked" ||
          record.context.gateway !== record.execution ||
          record.execution.phase !== record.phase ||
          record.bounds.signal.aborted
        )
          throw unavailable();
        io.assertActive();
        record.context.lifetime.assertActive();
        record.selected.assertCurrent();
        record.nativeIAM.assertCurrent();
      };
      const pending = new Set<Promise<unknown>>();
      let accepting = true;
      try {
        if (record?.version !== 2 || record.selectionIO !== undefined) throw unavailable();
        record.selectionIO = io;
        assertOperation();
        const backend = createPostgresRevisionCredentialReaderV1({
          scope: {
            installationId: record.installationId,
            namespaceId: record.unit.subject.namespaceRef,
          },
          query: { query: (statement, parameters) => io.query(statement, parameters) },
          assertEnrolled: (request, held, inputUnit, inputIO) => {
            assertOperation();
            // The privately selected resolver owns its original held selection.
            // These values check correspondence; they do not authenticate a lease.
            if (
              inputUnit !== unit ||
              inputIO !== io ||
              request !== held.request ||
              request.schemaVersion !== 2 ||
              request.installationId !== record.installationId ||
              request.namespaceId !== unit.subject.namespaceRef ||
              request.agentId !== unit.subject.agentRef
            )
              throw unavailable();
          },
          poison: (error) => record.phase.poison(error),
        });
        // Missing genuine selected-storage enrollment remains the original
        // resolver's unavailable path. This reader supplies only owner custody.
        const reader = Object.freeze({
          readLocked: (...input: Parameters<typeof backend.readLocked>) => {
            let work: Promise<unknown>;
            try {
              if (!accepting) throw unavailable();
              work = backend.readLocked(...input);
            } catch (error) {
              record.phase.poison(error);
              work = Promise.reject(error);
            }
            pending.add(work);
            void work.then(
              () => pending.delete(work),
              (error: unknown) => {
                record.phase.poison(error);
                pending.delete(work);
              },
            );
            return work;
          },
        });
        const acquired = await resolve(...args, reader);
        // Capture known cleanup before joining any ignored read or inspecting
        // further lease methods. The Runtime owner receives the same idempotent
        // closer and retains its original currentness fence after this returns.
        const close = acquired.release.bind(acquired);
        let closed: Promise<void> | undefined;
        const release = (): Promise<void> => (closed ??= Promise.resolve().then(close));
        try {
          record.phase.retainCleanup(release);
        } catch (error) {
          await release();
          throw error;
        }
        return Object.freeze({
          selected: acquired.selected,
          credentialWorkloadSelection: acquired.credentialWorkloadSelection,
          assertCurrent: acquired.assertCurrent.bind(acquired),
          release,
        });
      } catch (error) {
        record?.phase.poison(error);
        throw error;
      } finally {
        accepting = false;
        // Join complete decoded reads, not only their borrowed SQL promises.
        // A caught/unawaited failure has already poisoned the original phase.
        while (pending.size) await Promise.allSettled([...pending]);
        if (record?.version === 2 && record.selectionIO === io) delete record.selectionIO;
      }
    };
  }

  private bindGatewayStartupOwnersV2(
    source?: GatewayStartupCentralParticipantsV2,
  ): GatewayStartupOwnerBindingV2 {
    const selection = source?.driverSelection;
    let participants: GatewayStartupOwnerParticipantsV2 | undefined;

    // Capture actual producer methods once, matching Runtime's own capture.
    if (
      source !== undefined &&
      typeof source.authority?.consume === "function" &&
      typeof source.selection?.resolveLocked === "function" &&
      typeof source.process?.requireDisposition === "function" &&
      typeof source.process?.requireCurrent === "function" &&
      typeof source.audit?.append === "function" &&
      typeof source.allocate === "function"
    ) {
      const consume = source.authority.consume.bind(source.authority);
      participants = Object.freeze({
        authority: Object.freeze({
          consume: this.bindGatewayAuthorityConsumerV1(2, consume),
        }),
        selection: Object.freeze({
          resolveLocked: this.bindGatewayCredentialSelectionV2(
            source.selection.resolveLocked.bind(source.selection),
          ),
        }),
        process: Object.freeze({
          requireDisposition: source.process.requireDisposition.bind(source.process),
          requireCurrent: source.process.requireCurrent.bind(source.process),
        }),
        audit: Object.freeze({ append: source.audit.append.bind(source.audit) }),
        allocate: source.allocate.bind(source),
      });
    }

    const transaction: GatewayStartupTransactionOwnerV2 = Object.freeze({
      run: (...args: Parameters<GatewayStartupTransactionOwnerV2["run"]>) =>
        this.runGatewayStartupTransactionV1({ version: 2, args, selection, participants }),
    });
    return Object.freeze({ transaction, ...(participants === undefined ? {} : { participants }) });
  }

  private runGatewayStartupTransactionV1(
    request: GatewayStartupRunV1,
  ): Promise<GatewayStartupTransactionResultV1>;
  private runGatewayStartupTransactionV1(
    request: GatewayStartupRunV2,
  ): Promise<GatewayStartupTransactionResultV2>;
  private async runGatewayStartupTransactionV1(
    request: GatewayStartupRunV1 | GatewayStartupRunV2,
  ): Promise<GatewayStartupTransactionResultV1 | GatewayStartupTransactionResultV2> {
    const unavailable = () =>
      new DependencyUnavailableError("The Gateway startup owner is unavailable.");
    const noncommitUnavailable = () =>
      Object.freeze({
        kind: "rolled-back" as const,
        response: Object.freeze({ kind: "unavailable" as const }),
      });
    const [command, bounds] = request.args;
    const { selection, participants } = request;
    const ambientGateway = this.#gatewayExecution.getStore();
    const ambientCredential = this.#credentialExecution.getStore();
    if (ambientGateway !== undefined || ambientCredential !== undefined) {
      const error = unavailable();
      ambientGateway?.phase.poison(error);
      ambientCredential?.phase.poison(error);
      return noncommitUnavailable();
    }
    // No selected producer, fabricated unit, pool access or callback on this path.
    if (participants === undefined || selection === undefined) return noncommitUnavailable();
    const timeoutMs = Math.min(3000, Date.parse(bounds.deadline) - Date.now());
    if (
      !(bounds.signal instanceof AbortSignal) ||
      bounds.signal.aborted ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    )
      return noncommitUnavailable();

    let selected: GuardedDriverSelection<"iam"> | undefined;
    let record: GatewayStartupEnrollment | undefined;
    let failed = false;
    const close = () => {
      if (record !== undefined) {
        record.active = false;
        record.authorityIO = undefined;
        this.#gatewayContexts.delete(record.token);
      }
    };
    const execution: GatewayStartupExecution =
      request.version === 2
        ? { version: 2, disposition: "not-sent", establishedNoCommit: false, close }
        : { version: 1, disposition: "not-sent", establishedNoCommit: false, close };

    try {
      if (
        Object.getPrototypeOf(selection) !== DriverSelection.prototype ||
        selection.selectedDriver !== DriverSelection.prototype.selectedDriver ||
        selection.acquireGuardedSelection !== DriverSelection.prototype.acquireGuardedSelection
      )
        throw unavailable();
      const driver = selection.selectedDriver("iam");
      const held = selection.acquireGuardedSelection("iam", driver);
      selected = held;
      await this.execute(
        false,
        async (_unit, context) => {
          if (context.gateway !== execution) throw unavailable();
          const installation = await this.currentInstallation(context, context.gatewayQuery);
          if (installation === undefined) throw unavailable();
          const token = Object.freeze({});
          const policy = Object.freeze({});
          const nativeIAM = bindNativeIAMTransaction(driver, this, token);
          if (execution.version !== 2 && request.version === 1) {
            const phase = execution.phase;
            if (phase === undefined) throw unavailable();
            const unit: GatewayStartupOwnerUnitV1 = Object.freeze({
              installationId: installation.id,
              phase,
              backend: createPostgresGatewayStartupV1(installation.id),
              policy,
            });
            const enrolled: GatewayStartupEnrollmentV1 = {
              version: 1,
              installationId: installation.id,
              context,
              phase,
              execution,
              command: request.args[0],
              bounds,
              unit,
              policy,
              token,
              selected: held,
              nativeIAM,
              authorityStarted: false,
              policyState: "unlocked",
              active: true,
            };
            record = enrolled;
            this.#gatewayContexts.set(token, enrolled);
            // The original Runtime callback owns the sole phase.runCommand.
            return this.#gatewayExecution.run(enrolled, () => request.args[2](unit));
          }
          if (execution.version === 2 && request.version === 2) {
            const phase = execution.phase;
            if (phase === undefined) throw unavailable();
            const subject = parseGatewayStartupSubjectV2(request.args[0].subject);
            if (subject.installationId !== installation.id) throw unavailable();
            const unit: GatewayStartupOwnerUnitV2 = Object.freeze({
              subject,
              phase,
              backend: createPostgresGatewayStartupV2(subject),
              policy,
            });
            const enrolled: GatewayStartupEnrollmentV2 = {
              version: 2,
              installationId: installation.id,
              context,
              phase,
              execution,
              command: request.args[0],
              bounds,
              unit,
              policy,
              token,
              selected: held,
              nativeIAM,
              authorityStarted: false,
              policyState: "unlocked",
              active: true,
            };
            record = enrolled;
            this.#gatewaySourceSelections.set(unit, selection);
            this.#gatewayContexts.set(token, enrolled);
            // The original Runtime callback owns the sole phase.runCommand.
            return this.#gatewayExecution.run(enrolled, () => request.args[2](unit));
          }
          throw unavailable();
        },
        { signal: bounds.signal, timeoutMs },
        false,
        undefined,
        execution,
      );
    } catch {
      failed = true;
    } finally {
      // execute has finished raw query/client/context cleanup AND the phase's
      // one terminal release pass. Retain the actual driver through both.
      try {
        selected?.release();
      } catch {
        failed = true;
      }
    }
    const possibleCommit = execution.disposition !== "not-sent" && !execution.establishedNoCommit;
    if (failed || execution.finalized === undefined)
      return possibleCommit ? Object.freeze({ kind: "unknown" }) : noncommitUnavailable();
    if (execution.version === 2) {
      const finalized = execution.finalized;
      if (finalized.kind === "rollback")
        return possibleCommit
          ? Object.freeze({ kind: "unknown" })
          : Object.freeze({ kind: "rolled-back", response: finalized.response });
      if (execution.disposition === "acknowledged")
        return Object.freeze({ kind: "committed", response: finalized.provisional });
      return possibleCommit ? Object.freeze({ kind: "unknown" }) : noncommitUnavailable();
    }
    const finalized = execution.finalized;
    if (finalized.kind === "rollback")
      return possibleCommit
        ? Object.freeze({ kind: "unknown" })
        : Object.freeze({ kind: "rolled-back", response: finalized.response });
    if (execution.disposition === "acknowledged")
      return Object.freeze({ kind: "committed", response: finalized.provisional });
    return possibleCommit ? Object.freeze({ kind: "unknown" }) : noncommitUnavailable();
  }

  /** TODO: Connect the actual account, accepting-audit and protected-custody
   * participants after their same-client lock/completion handoff is available. */
  private bindCredentialInventoryOwnersV1(
    participants?: CredentialInventoryOwnerParticipantsV1,
  ): CredentialInventoryOwnerBindingV1 {
    const enrolled = new WeakMap<
      CredentialInventoryTransactionV1,
      CredentialInventoryEnrollmentV1
    >();
    const current = this.#credentialExecution;
    const unavailable = () =>
      new DependencyUnavailableError("The credential owner is unavailable.");
    const sameScope = (a: InventoryScopeV1, b: InventoryScopeV1) =>
      a.installationId === b.installationId &&
      a.namespaceId === b.namespaceId &&
      a.agentId === b.agentId;

    const accept = (
      mode: CredentialAcceptanceModeV1,
      input: CredentialAcceptanceInputV1,
      authority: CredentialAcceptanceAuthorityV1,
      transaction: CredentialInventoryTransactionV1,
    ): Promise<boolean> => {
      const origin = current.getStore();
      const record = enrolled.get(transaction);
      if (origin === undefined || record !== origin || !record.active) {
        const error = unavailable();
        origin?.phase.poison(error);
        const rejected = Promise.reject<boolean>(error);
        void rejected.catch(() => {});
        return rejected;
      }
      return record.phase.runAcceptance(async () => {
        const acceptedInput = immutableCopy(input);
        if (!sameScope(acceptedInput.scope, record.scope)) throw unavailable();
        // Original authority authenticates the invocation before capacity locks;
        // its final accepting call below rechecks canonical state after waits.
        await record.participant.enroll(mode, acceptedInput, authority);
        const query: PostgresClient["query"] = async (statement, parameters) => {
          record.phase.assertOperationActive();
          const result = await record.context.credentialQuery(statement, parameters);
          record.phase.assertOperationActive();
          return result;
        };
        const installation = rows(
          (
            await query("SELECT id FROM occ.installation WHERE id = $1 FOR NO KEY UPDATE", [
              record.scope.installationId,
            ])
          ).rows,
        );
        if (installation.length !== 1 || installation[0]?.id !== record.scope.installationId)
          throw unavailable();
        const namespace = rows(
          (
            await query("SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE", [
              record.scope.namespaceId,
            ])
          ).rows,
        );
        if (namespace.length !== 1 || namespace[0]?.id !== record.scope.namespaceId)
          throw unavailable();
        const agent = rows(
          (
            await query(
              "SELECT id FROM occ.agents WHERE namespace_id = $1 AND id = $2 FOR UPDATE",
              [record.scope.namespaceId, record.scope.agentId],
            )
          ).rows,
        );
        if (agent.length !== 1 || agent[0]?.id !== record.scope.agentId) throw unavailable();
        const method = record.participant.acceptingOwner[mode];
        const accepted: unknown = await Reflect.apply(method, record.participant.acceptingOwner, [
          acceptedInput,
          authority,
          transaction,
        ]);
        if (typeof accepted !== "boolean") throw unavailable();
        if (accepted) record.accepted = { mode, input: acceptedInput };
        return accepted;
      });
    };
    const acceptingOwner = Object.freeze<CredentialInventoryAcceptingOwnerV1>({
      acceptCurrent: (input, authority, transaction) =>
        accept("acceptCurrent", input, authority, transaction),
      acceptMitigation: (input, authority, transaction) =>
        accept("acceptMitigation", input, authority, transaction),
      acceptRead: (input, authority, transaction) =>
        accept("acceptRead", input, authority, transaction),
    });
    const readMethods = new Set<keyof CredentialInventoryTransactionV1>([
      "findOperation",
      "findRecord",
      "liveCounts",
      "listLive",
      "findMintClaim",
      "findRevocationClaim",
      "findSnapshot",
    ]);
    const methods = [
      ...readMethods,
      "appendOperation",
      "insertRecord",
      "replaceRecord",
      "insertMintClaim",
      "appendRevocationClaim",
      "insertSnapshot",
      "retainToken",
      "loadRevocationToken",
      "appendAudit",
    ] as const;
    const transactions: CredentialInventoryTransactionOwnerV1 = Object.freeze({
      run: async <T>(
        scope: InventoryScopeV1,
        bounds: CredentialStorageCallBoundsV1,
        work: (transaction: CredentialInventoryTransactionV1) => Promise<T>,
      ): Promise<InventoryCommitV1<T>> => {
        const ambient = current.getStore();
        if (ambient !== undefined) {
          ambient.phase.poison(unavailable());
          return { kind: "unavailable" };
        }
        // Missing genuine participants never enter a callback, pool or positive
        // phase. This is not a metadata-backed replacement for their authority.
        if (participants === undefined || bounds.signal.aborted) return { kind: "unavailable" };
        const phase = new CredentialInventoryOwnerPhaseV1();
        const fixedScope = Object.freeze({ ...scope });
        let record: CredentialInventoryEnrollmentV1 | undefined;
        let participant: CredentialInventoryBoundParticipantV1 | undefined;
        let acknowledgedAt: string | undefined;
        let value: T | undefined;
        let failed = false;
        const execution: CredentialInventoryExecutionV1 = {
          phase,
          disposition: "not-sent",
          establishedNoCommit: false,
          prepareCommit: async () => {
            if (participant === undefined) throw unavailable();
            await participant.prepareCommit();
          },
          assertCommitReady: () => {
            if (participant === undefined) throw unavailable();
            participant.assertCommitReady();
          },
          observeAcknowledgment: () => {
            const observed = participants.acknowledgedAt();
            if (
              !Number.isFinite(Date.parse(observed)) ||
              new Date(observed).toISOString() !== observed
            )
              throw unavailable();
            acknowledgedAt = observed;
          },
          close: () => {
            if (record !== undefined) {
              record.active = false;
              if (record.transaction !== undefined) enrolled.delete(record.transaction);
            }
            participant?.close();
          },
        };
        try {
          value = await this.execute(
            false,
            async (_unit, context) => {
              const installation = await this.currentInstallation(context, context.credentialQuery);
              if (installation === undefined || installation.id !== fixedScope.installationId)
                throw unavailable();
              const commitRef = randomUUID();
              const assertOperation = () => {
                context.lifetime.assertActive();
                phase.assertOperationActive();
              };
              participant = participants.bind({
                scope: { installationId: installation.id, namespaceId: fixedScope.namespaceId },
                inventoryScope: fixedScope,
                commitRef,
                transaction: { assertActive: assertOperation },
                phase: { assertActive: assertOperation, poison: (error) => phase.poison(error) },
                query: {
                  query: async (statement, parameters) => {
                    assertOperation();
                    const result = await context.credentialQuery(statement, parameters);
                    assertOperation();
                    return result;
                  },
                },
              });
              const bound: CredentialInventoryEnrollmentV1 = {
                phase,
                context,
                scope: fixedScope,
                participant,
                active: true,
              };
              record = bound;
              const projection: Record<string, unknown> = {
                commitRef,
                assertActive: function (this: CredentialInventoryTransactionV1) {
                  if (this !== bound.transaction || !bound.active || current.getStore() !== bound) {
                    const error = unavailable();
                    phase.poison(error);
                    throw error;
                  }
                  context.lifetime.assertActive();
                  phase.assertActive();
                },
              };
              for (const method of methods) {
                projection[method] = function (
                  this: CredentialInventoryTransactionV1,
                  ...args: unknown[]
                ) {
                  const origin = current.getStore();
                  if (this !== bound.transaction || origin !== bound || !bound.active) {
                    const error = unavailable();
                    origin?.phase.poison(error);
                    return phase.rejectOutward(error);
                  }
                  return phase.runOperation(async () => {
                    const accepted = bound.accepted;
                    if (accepted === undefined) throw unavailable();
                    if (
                      accepted.mode === "acceptRead" &&
                      !readMethods.has(method) &&
                      !(method === "insertSnapshot" && "filter" in accepted.input)
                    )
                      throw unavailable();
                    if (method === "loadRevocationToken" && accepted.mode !== "acceptMitigation")
                      throw unavailable();
                    const implementation = bound.participant.repository[method];
                    if (typeof implementation !== "function") throw unavailable();
                    return Reflect.apply(implementation, bound.participant.repository, args);
                  });
                };
              }
              const transaction = Object.freeze(
                projection,
              ) as unknown as CredentialInventoryTransactionV1;
              bound.transaction = transaction;
              enrolled.set(transaction, bound);
              return current.run(bound, () => phase.runTransition(() => work(transaction)));
            },
            { signal: bounds.signal, timeoutMs: 3000 },
            false,
            execution,
          );
        } catch {
          failed = true;
        } finally {
          // execute has joined its raw queries and revoked private capability
          // correspondence before these separate participant leases are released.
          try {
            participant?.release();
          } catch {
            failed = true;
          }
        }
        if (failed || acknowledgedAt === undefined) {
          return execution.disposition !== "not-sent" && !execution.establishedNoCommit
            ? { kind: "commit-unknown" }
            : { kind: "unavailable" };
        }
        return { kind: "committed", value: value as T, acknowledgedAt };
      },
    });
    return Object.freeze({ transactions, acceptingOwner });
  }

  queryInTransaction(
    unit: PlatformReadView,
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }> {
    const context = this.contexts.get(unit);
    if (context === undefined)
      throw new DependencyUnavailableError("The platform transaction is unavailable.");
    if (context.protectedProfile !== undefined) {
      const error = new ScopeViolationError(
        "Profile enrollment requires its original tracked owner query.",
      );
      context.protectedProfile.poison(error);
      throw error;
    }
    if (context.gateway !== undefined) {
      const error = new ScopeViolationError("Gateway startup requires its isolated owner query.");
      context.gateway.phase?.poison(error);
      throw error;
    }
    if (context.credential !== undefined)
      return context.credential.phase.rejectOutward(
        new ScopeViolationError("Credential inventory requires an isolated owner transaction."),
      );
    return context.lifetime.run(() => context.client.query(statement, parameters));
  }

  /** Borrows this exact platform unit; neither storage nor parsed inputs authenticate authority. */
  delegationInTransaction(unit: PlatformUnitOfWork): DelegationRepository {
    const context = this.contexts.get(unit);
    if (context === undefined)
      throw new DependencyUnavailableError("The platform transaction is unavailable.");
    context.lifetime.assertActive();
    if (
      context.readOnly ||
      context.protectedProfile ||
      context.gateway ||
      context.credential ||
      context.turn ||
      context.fresh
    )
      throw new ScopeViolationError(
        "Delegation storage requires an ordinary platform write transaction.",
      );
    const existing = this.delegationRepositories.get(unit);
    if (existing) return existing;
    const repository = createPostgresDelegationRepository({
      get scope() {
        context.lifetime.assertActive();
        if (!context.installation)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: context.lifetime,
      query: { query: (statement, parameters) => context.client.query(statement, parameters) },
    });
    const bound = bindRepository(repository, context.lifetime, [
      "findByContext",
      "findOperation",
      "insertRoot",
      "retireRoot",
      "acceptOperation",
      "dispatchOperation",
      "finishOperation",
    ]);
    this.delegationRepositories.set(unit, bound);
    return bound;
  }

  /** Results are provisional inside the callback; only the original outer COMMIT acknowledges them. */
  delegationTransactionHost(): DelegationTransactionHost {
    return Object.freeze({
      transact: <T>(work: (unit: PlatformUnitOfWork, grants: DelegationRepository) => Promise<T>) =>
        this.transact(async (unit) => {
          await unit.installations.getInstallation();
          return work(unit, this.delegationInTransaction(unit));
        }),
    });
  }

  providerAccountLinksInTransaction(unit: PlatformReadView): ProviderAccountLinks {
    const context = this.contexts.get(unit);
    if (context === undefined)
      throw new DependencyUnavailableError("The platform transaction is unavailable.");
    const links = createPostgresProviderAccountLinks({
      get scope() {
        context.lifetime.assertActive();
        if (context.installation === undefined)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: { assertActive: () => context.lifetime.assertActive() },
      query: { query: (statement, parameters) => context.client.query(statement, parameters) },
    });
    return bindRepository(links, context.lifetime, ["create", "find", "recordCredential"]);
  }

  async transactWithQueue<T>(
    work: (state: PlatformUnitOfWork, queue: PostgresWorkQueue) => Promise<T>,
    options: PostgresWorkQueueOptions = {},
  ): Promise<T> {
    // Final queue publication reads a fresh head after the original parent locks.
    return this.execute(
      false,
      async (state, context) =>
        work(
          state,
          new Proxy(new PostgresWorkQueue(context.client, options), {
            get(target, property, receiver) {
              const value = Reflect.get(target, property, receiver);
              return typeof value === "function"
                ? (...args: unknown[]) =>
                    context.lifetime.run(async () => Reflect.apply(value, target, args))
                : value;
            },
          }),
        ),
      undefined,
      true,
    );
  }

  private async execute<T>(
    readOnly: boolean,
    work: (state: PlatformUnitOfWork, context: TransactionContext) => Promise<T>,
    options?: PlatformReadOptions,
    profileReadCommitted = false,
    credential?: CredentialInventoryExecutionV1,
    gateway?: GatewayStartupExecution,
    turn?: TurnCommandExecutionV1,
    fresh?: FreshBootstrapExecutionV1,
  ): Promise<T> {
    const ambientFresh = this.#freshExecution.getStore();
    if (
      (ambientFresh !== undefined && ambientFresh !== fresh) ||
      (fresh !== undefined &&
        (readOnly ||
          credential !== undefined ||
          gateway !== undefined ||
          turn !== undefined ||
          this.#outerExecution.getStore() !== undefined ||
          (fresh.kind === "finalize" && ambientFresh !== fresh)))
    ) {
      const error = new ScopeViolationError(
        "Fresh bootstrap cannot nest or mix transaction owners.",
      );
      if (ambientFresh !== undefined) this.rejectFresh(ambientFresh, error);
      throw error;
    }
    if (turn !== undefined && this.#outerExecution.getStore() !== undefined)
      throw new ScopeViolationError("A turn command cannot nest in an existing owner callback.");
    const ambientTurn = this.#turnExecution.getStore();
    if (ambientTurn !== undefined) {
      const error = new ScopeViolationError(
        "Turn commands cannot open ambient or mixed transactions.",
      );
      ambientTurn.phase.poison(error);
      throw error;
    }
    if (
      turn !== undefined &&
      (readOnly || profileReadCommitted || credential !== undefined || gateway !== undefined)
    )
      throw new ScopeViolationError("A turn command requires its isolated outer transaction.");
    const ambientGateway = this.#gatewayExecution.getStore();
    if (ambientGateway !== undefined) {
      const error = new ScopeViolationError(
        "Gateway startup cannot open an ambient or mixed transaction.",
      );
      ambientGateway.phase.poison(error);
      throw error;
    }
    if (gateway !== undefined && credential !== undefined)
      throw new ScopeViolationError("Gateway startup requires its isolated owner transaction.");
    const ambientCredential = this.#credentialExecution.getStore();
    if (ambientCredential !== undefined)
      return ambientCredential.phase.rejectOutward(
        new ScopeViolationError(
          "Credential inventory cannot open an ambient or mixed transaction.",
        ),
      );
    // pg exposes no per-checkout cancellation. Its configured timeout actually removes
    // the waiter; join that bounded checkout before returning an interrupted read.
    const acquisitionTimeout = this.pool.options?.connectionTimeoutMillis;
    if (
      options !== undefined &&
      (options.signal.aborted ||
        !Number.isFinite(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        options.timeoutMs > 3000 ||
        acquisitionTimeout === undefined ||
        acquisitionTimeout <= 0 ||
        acquisitionTimeout > 250 ||
        !Number.isFinite(acquisitionTimeout) ||
        this.pool.options?.pipeline === true ||
        this.pool.options?.onConnect !== undefined ||
        this.pool.options?.verify !== undefined ||
        this.pool.options?.Client !== undefined)
    )
      throw new DependencyUnavailableError(
        "Bounded platform reads require a bounded PostgreSQL pool.",
      );
    const readBegan = performance.now();
    const profileAbort = new AbortController();
    const lifetime = new RepositoryTransactionLifetime();
    let expired = false;
    let closed = false;
    let released = false;
    let primaryFailure = false;
    let cleanupFailed = false;
    let cleanupFailure: unknown;
    const cleanup = (work: () => void) => {
      try {
        work();
      } catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true;
          cleanupFailure = error;
        }
      }
    };
    let raw: PostgresClient | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: ((error: Error) => void) | undefined;
    const pending = new Set<Promise<unknown>>();
    const abortFailure = () => new DependencyUnavailableError("The platform read expired.");
    const release = (destroy: boolean) => {
      if (raw !== undefined && !released) {
        released = true;
        raw.release(destroy);
      }
    };
    const abort = () => {
      profileAbort.abort();
      credential?.phase.poison(abortFailure());
      gateway?.phase?.poison(abortFailure());
      turn?.phase?.poison(options?.signal.reason ?? abortFailure());
      lifetime.close();
      expired = true;
      closed = true;
      cleanup(() => release(true));
      rejectAbort?.(abortFailure());
    };
    const cancelled =
      options === undefined
        ? undefined
        : new Promise<never>((_resolve, reject) => {
            rejectAbort = reject;
          });
    // Rejection can precede acquisition settlement; attach a handler immediately.
    void cancelled?.catch(() => {});
    if (options !== undefined) {
      options.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, Math.ceil(options.timeoutMs));
    }
    let client: PostgresClient | undefined;
    let started = false;
    let commitDisposition: "not-sent" | "sent" | "acknowledged" = "not-sent";
    let establishedNoCommit = false;
    let discardClient = false;
    let unit: PlatformUnitOfWork | undefined;
    let context: TransactionContext | undefined;
    let running: Promise<T> | undefined;
    const authorityGuard = new RuntimeAuthorityTransactionGuard();
    const journalGuard = new TurnJournalTransactionGuard();
    const profilePhase = new WorkloadProfileUnitPhase();
    const lifecyclePhase = new LifecycleAdmissionUnitPhase();
    let trackProfileOrder = false;
    const onTransportError = () => {
      discardClient = true;
      if (context?.channelFirstCreate) {
        const error = new DependencyUnavailableError("The channel transaction transport failed.");
        this.recordChannelFirstCreateFailure(context, error);
      }
      context?.protectedProfile?.poison(
        new DependencyUnavailableError("The profile transaction transport failed."),
      );
      if (fresh !== undefined && !fresh.failed) {
        fresh.failed = true;
        fresh.failure = new DependencyUnavailableError(
          "The bootstrap transaction transport failed.",
        );
        this.captureFreshFailure(fresh, fresh.failure, "transport");
      }
      turn?.phase?.poison(new DependencyUnavailableError("The turn transaction transport failed."));
      gateway?.phase?.poison(
        new DependencyUnavailableError("The Gateway transaction transport failed."),
      );
    };
    const rejectGatewayOutward = (error: unknown): never => {
      gateway?.phase?.poison(error);
      throw error;
    };
    try {
      try {
        raw = await this.pool.connect();
      } catch (error) {
        if (fresh !== undefined) this.captureFreshFailure(fresh, error, "checkout");
        throw error;
      }
      raw.on?.("error", onTransportError);
      if (expired || options?.signal.aborted) {
        release(true);
        throw abortFailure();
      }
      const underlying = raw;
      const query: PostgresClient["query"] = async (statement, parameters) => {
        lifetime.assertActive();
        if (context !== undefined && trackProfileOrder) context.dataQueryStarted = true;
        if (closed || options?.signal.aborted) throw abortFailure();
        let query: ReturnType<PostgresClient["query"]>;
        try {
          query = underlying.query(statement, parameters);
        } catch (error) {
          if (fresh !== undefined) {
            const observed = this.#freshFailureStages.getStore();
            this.captureFreshFailure(
              fresh,
              error,
              observed?.record === fresh ? observed.stage : "unknown",
              true,
            );
          }
          throw error;
        }
        pending.add(query);
        try {
          let result;
          try {
            result = await query;
          } catch (error) {
            if (fresh !== undefined) this.rejectFresh(fresh, error, true);
            throw error;
          }
          lifetime.assertActive();
          return result;
        } catch (error) {
          if (fresh !== undefined) this.rejectFresh(fresh, error);
          throw error;
        } finally {
          pending.delete(query);
        }
      };
      if (turn !== undefined) {
        if (turn.phase !== undefined)
          throw new ScopeViolationError("The turn scope cannot be reused.");
        // This outer assertion survives outward lifetime.finish(), but never
        // client release, cancellation or actual owner closure.
        turn.phase = new TurnCommandScopeV1(
          {
            assertActive: () => {
              if (closed || released || expired || options?.signal.aborted) throw abortFailure();
            },
          },
          turn.identity,
          turn.bounds,
        );
      }
      if (gateway !== undefined) {
        if (gateway.phase !== undefined)
          throw new ScopeViolationError("The Gateway transaction phase cannot be reused.");
        if (gateway.version === 2)
          gateway.phase = new GatewayStartupOwnerPhaseV1<GatewayStartupCompletionV2>(
            lifetime,
            query,
          );
        else gateway.phase = new GatewayStartupOwnerPhaseV1(lifetime, query);
      }
      client = {
        query: (statement, parameters) =>
          trackProfileOrder
            ? turn !== undefined
              ? (() => {
                  const error = new ScopeViolationError("Turn commands forbid outward SQL.");
                  turn.phase?.poison(error);
                  throw error;
                })()
              : gateway !== undefined
                ? rejectGatewayOutward(
                    new ScopeViolationError("Gateway startup requires its isolated owner query."),
                  )
                : credential !== undefined
                  ? credential.phase.rejectOutward(
                      new ScopeViolationError(
                        "Credential inventory requires an isolated owner transaction.",
                      ),
                    )
                  : lifecyclePhase.legacyQuery(() =>
                      profilePhase.other(() => {
                        if (context?.profileMutation)
                          context.protectedProfile!.assertOperationActive();
                        return query(statement, parameters);
                      }),
                    )
            : query(statement, parameters),
        release: (destroy) => release(destroy ?? false),
      };
      const beginStatement =
        profileReadCommitted ||
        credential !== undefined ||
        gateway !== undefined ||
        turn !== undefined
          ? "BEGIN ISOLATION LEVEL READ COMMITTED"
          : readOnly
            ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
            : "BEGIN";
      const originalClient = client;
      await (fresh === undefined
        ? originalClient.query(beginStatement)
        : this.#freshFailureStages.run({ record: fresh, stage: "begin" }, () =>
            originalClient.query(beginStatement),
          ));
      started = true;
      if (options !== undefined) {
        // PostgreSQL also detects a disappeared client during a blocked query. The
        // server statement limit independently bounds resource lifetime on transport loss.
        const remaining = Math.max(
          1,
          Math.floor(options.timeoutMs - (performance.now() - readBegan)),
        );
        await client.query(
          "SELECT set_config('statement_timeout',$1,true), set_config('transaction_timeout',$1,true), set_config('idle_in_transaction_session_timeout',$1,true)",
          [`${remaining}ms`],
        );
        await client.query("SET LOCAL client_connection_check_interval = '100ms'");
      }
      context = {
        ...(fresh === undefined ? {} : { fresh }),
        ...(turn === undefined ? {} : { turn }),
        channelCreateQuery: async (statement, parameters) => {
          try {
            this.assertChannelFirstCreateCurrent(context!);
            const result = await query(statement, parameters);
            this.assertChannelFirstCreateCurrent(context!);
            return result;
          } catch (error) {
            return this.rejectChannelFirstCreate(context!, error);
          }
        },
        turnQuery: query,
        ...(gateway === undefined ? {} : { gateway }),
        gatewayQuery: query,
        ...(credential === undefined ? {} : { credential }),
        credentialQuery: query,
        lifetime,
        readOnly,
        profileSignal: options?.signal ?? profileAbort.signal,
        abortProfile: abort,
        dataQueryStarted: false,
        profileEnrollments: new Set(),
        profileEnrollmentClosed: false,
        assertOwnerActive: () => {
          if (closed || released || expired || discardClient || options?.signal.aborted)
            throw abortFailure();
        },
        authorityGuard,
        journalGuard,
        profilePhase,
        lifecyclePhase,
        lifecycleQuery: query,
        profileQuery: query,
        client,
        installation: undefined,
        installationLoaded: false,
      };
      trackProfileOrder = true;
      unit = bindPlatformUnitOfWork(
        this.repositories(context),
        lifetime,
        profilePhase,
        lifecyclePhase,
        credential?.phase,
        gateway === undefined ? undefined : rejectGatewayOutward,
        turn === undefined
          ? undefined
          : {
              reject: (error: unknown): never => {
                turn.phase?.poison(error);
                throw error;
              },
              run: <Value>(repository: "turnJournal" | "audit", work: () => Promise<Value>) => {
                const record = this.#turnExecution.getStore();
                if (record === undefined || record.execution !== turn) {
                  const error = new ScopeViolationError("The exact turn operation is unavailable.");
                  turn.phase?.poison(error);
                  return Promise.reject(error);
                }
                return record.phase.runOperation(
                  repository === "audit" ? "mutation-audit" : "journal-mutation",
                  (operation) => this.withTurnIO(record, work, operation),
                );
              },
            },
      );
      if (fresh?.kind === "finalize") unit = this.bindFreshBootstrapUnit(unit, fresh);
      journalGuard.bind(unit);
      this.contexts.set(unit, context);
      const activeContext = context;
      running = Promise.resolve().then(() =>
        this.#outerExecution.run(true, () =>
          this.#profileAmbient.run({ context: activeContext, platform: unit! }, () =>
            work(unit!, activeContext),
          ),
        ),
      );
      const result = await (cancelled === undefined ? running : Promise.race([running, cancelled]));
      try {
        if (fresh !== undefined) {
          fresh.accepting = false;
          while (fresh.pending.size) await Promise.allSettled([...fresh.pending]);
          if (fresh.failed) throw fresh.failure;
          if (
            fresh.kind === "finalize" &&
            (fresh.namespaceIds.size !== 1 ||
              [...fresh.namespaceIds].some(
                (id) => !fresh.workNamespaceIds.has(id) || !fresh.auditNamespaceIds.has(id),
              ))
          )
            throw new ScopeViolationError(
              "Fresh bootstrap requires its Namespace, work and attributable audit.",
            );
        }
        if (turn !== undefined) await turn.phase!.prepareCommit();
        if (gateway !== undefined) {
          gateway.phase!.closeAdmissions();
          await gateway.phase!.drainAccepted();
        }
        if (credential !== undefined) {
          credential.phase.closeAdmissions();
          await credential.phase.drainAccepted();
          await credential.phase.runFinalization(credential.prepareCommit);
          await credential.phase.drainAccepted();
        }
        context.profileEnrollmentClosed = true;
        while (context.profileEnrollments.size)
          await Promise.allSettled([...context.profileEnrollments]);
        lifecyclePhase.closeAdmissions();
        await context?.protectedProfile?.finish();
        await lifetime.finish();
        await lifecyclePhase.finish();
        await authorityGuard.finish();
        await journalGuard.finish();
        await profilePhase.guard.finish();
        if (expired || options?.signal.aborted) throw abortFailure();
        context?.protectedProfile?.assertCurrent();
        profilePhase.guard.assertCurrent();
        if (gateway !== undefined) {
          if (gateway.version === 2) gateway.finalized = gateway.phase!.finalize();
          else gateway.finalized = gateway.phase!.finalize();
          if (gateway.finalized.kind === "rollback") {
            await raw.query("ROLLBACK");
            started = false;
            return result;
          }
        }
        if (context.channelFirstCreate) {
          this.assertChannelFirstCreateCurrent(context, true);
          const complete = context.channelFirstCreate;
          if (
            !complete.completed ||
            (complete.noEffect
              ? complete.reserved || complete.inserted || complete.audited
              : !complete.reserved || !complete.inserted || !complete.audited)
          )
            this.rejectChannelFirstCreate(
              context,
              new ScopeViolationError("The complete channel creation has not settled."),
            );
        }
        lifecyclePhase.assertChannelCommitReady();
        credential?.assertCommitReady();
        credential?.phase.assertCommitReady();
        // All asynchronous drains precede the final synchronous Gateway fence.
        // No awaited work may intervene between this marker and the raw COMMIT.
        gateway?.phase?.markCommitDispatched();
        turn?.phase?.markCommitDispatched();
        if (fresh?.failed) throw fresh.failure;
      } catch (error) {
        if (fresh !== undefined) this.captureFreshFailure(fresh, error, "completion-check");
        throw error;
      }
      lifecyclePhase.markChannelCommitDispatched();
      commitDisposition = "sent";
      if (fresh !== undefined) fresh.disposition = "sent";
      if (turn !== undefined) turn.sent = true;
      if (credential !== undefined) credential.disposition = "sent";
      if (gateway !== undefined) gateway.disposition = "sent";
      let acknowledgement;
      try {
        acknowledgement = await raw.query("COMMIT");
      } catch (error) {
        if (fresh !== undefined) this.captureFreshFailure(fresh, error, "commit", true);
        establishedNoCommit = commitRejectionEstablishesNoCommit(error);
        throw error;
      }
      // Capture the returned protocol fact once. A second accessor evaluation
      // must not prevent phase acknowledgement or retained terminal cleanup.
      const acknowledgedCommand =
        "command" in acknowledgement ? acknowledgement.command : undefined;
      if (acknowledgedCommand !== "COMMIT") {
        establishedNoCommit = acknowledgedCommand === "ROLLBACK";
        if (credential !== undefined) credential.establishedNoCommit = establishedNoCommit;
        if (establishedNoCommit) started = false;
        throw new DependencyUnavailableError("The database transaction did not commit.");
      }
      commitDisposition = "acknowledged";
      if (fresh !== undefined) fresh.disposition = "acknowledged";
      if (turn !== undefined) turn.acknowledged = true;
      turn?.phase?.observeCommitAcknowledgement(acknowledgedCommand);
      if (credential !== undefined) credential.disposition = "acknowledged";
      if (gateway !== undefined) gateway.disposition = "acknowledged";
      started = false;
      gateway?.phase?.observeCommitAcknowledgement(acknowledgedCommand);
      credential?.observeAcknowledgment();
      // Claims stay provisional through every nested callback and uncertain COMMIT.
      // This marker performs no external work; initiation waits for the outer return.
      if (!readOnly) journalGuard.confirmCommitted();
      lifecyclePhase.assertChannelOutcome();
      if (expired || options?.signal.aborted) throw abortFailure();
      return result;
    } catch (error) {
      primaryFailure = true;
      // An outer callback failure and accepted command failures share the same
      // first-error latch; a later catch/rethrow cannot replace its original cause.
      lifecyclePhase.poisonChannelFirstCreate(error);
      if (fresh !== undefined) {
        fresh.accepting = false;
        if (!fresh.failed) {
          fresh.failed = true;
          fresh.failure = error;
          this.captureFreshFailure(
            fresh,
            error,
            commitDisposition === "not-sent" ? "bootstrap-callback" : "commit",
          );
        }
        while (fresh.pending.size) await Promise.allSettled([...fresh.pending]);
      }
      if (turn !== undefined) {
        turn.phase?.closeAdmissions();
        turn.phase?.poison(error);
        await turn.phase?.drainAccepted();
        if (running !== undefined) await Promise.allSettled([running]);
        await turn.phase?.drainAccepted();
      }
      if (gateway !== undefined) {
        gateway.establishedNoCommit = establishedNoCommit;
        gateway.phase?.closeAdmissions();
        gateway.phase?.poison(error);
        // Cancellation may win while the direct owner callback is still settling.
        // Join it as well as accepted phase/query work before terminal cleanup.
        await gateway.phase?.drainAccepted();
        if (running !== undefined) await Promise.allSettled([running]);
        await gateway.phase?.drainAccepted();
      }
      if (credential !== undefined) {
        credential.establishedNoCommit = establishedNoCommit;
        credential.phase.closeAdmissions();
        credential.phase.poison(error);
        try {
          await credential.phase.drainAccepted();
        } catch (firstFailure) {
          error = firstFailure;
        }
      }
      lifecyclePhase.closeAdmissions();
      if (context !== undefined) {
        context.profileEnrollmentClosed = true;
        while (context.profileEnrollments.size)
          await Promise.allSettled([...context.profileEnrollments]);
      }
      try {
        await context?.protectedProfile?.finish();
      } catch {
        /* Preserve the original failure. */
      }
      try {
        await lifetime.finish();
      } catch {
        /* Preserve the original failure and continue drains. */
      }
      try {
        await lifecyclePhase.finish();
      } catch {
        /* Preserve the original failure. */
      }
      try {
        await authorityGuard.finish();
      } catch {
        /* Preserve the original failure. */
      }
      try {
        await journalGuard.finish();
      } catch {
        /* Preserve the original failure. */
      }
      try {
        await profilePhase.guard.finish();
      } catch {
        /* Preserve the original failure. */
      }
      try {
        lifecyclePhase.assertChannelOutcome();
      } catch (first) {
        error = first;
      }
      if (started && !released && raw !== undefined) {
        try {
          await raw.query("ROLLBACK");
        } catch {
          discardClient = true;
        }
      }
      const unknownCommit =
        !readOnly &&
        !establishedNoCommit &&
        (commitDisposition === "acknowledged" || commitDisposition === "sent");
      discardClient ||= unknownCommit || expired;
      const outward = unknownCommit
        ? new PostgresCommitOutcomeUnknownError()
        : databaseError(error);
      this.rememberChannelFailure(context, outward);
      throw outward;
    } finally {
      if (fresh !== undefined) {
        fresh.accepting = false;
        fresh.active = false;
        fresh.establishedNoCommit = establishedNoCommit;
      }
      cleanup(() => turn?.phase?.closeAdmissions());
      cleanup(() => turn?.close());
      cleanup(() => gateway?.phase?.closeAdmissions());
      cleanup(() => credential?.phase.closeAdmissions());
      cleanup(() => lifecyclePhase.closeAdmissions());
      cleanup(() => context?.protectedProfile?.close());
      if (context?.profileToken !== undefined) this.#profileContexts.delete(context.profileToken);
      if (context?.protectedProfile !== undefined)
        this.#profileAccounts.delete(context.protectedProfile.unit.account);
      cleanup(() => gateway?.close());
      cleanup(() => credential?.close());
      cleanup(() => credential?.phase.close());
      cleanup(() => journalGuard.close());
      cleanup(() => lifetime.close());
      closed = true;
      cleanup(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
      cleanup(() => options?.signal.removeEventListener("abort", abort));
      if (unit !== undefined) this.contexts.delete(unit);
      if (context?.readView !== undefined) this.contexts.delete(context.readView);
      cleanup(() => release(discardClient || expired));
      // Destroying an active pg client rejects active/queued queries. Join their rejection
      // before reporting cancellation, and forbid any later callback from reusing it.
      await Promise.allSettled([...pending]);
      cleanup(() => raw?.removeListener?.("error", onTransportError));
      if (gateway?.phase !== undefined) {
        // Retained participant leases outlive the original client/query/context.
        // Raw acknowledgement stays committed even when cleanup forces unknown.
        const terminal =
          commitDisposition === "acknowledged"
            ? "committed"
            : commitDisposition === "sent"
              ? establishedNoCommit
                ? "commit-rejected"
                : "commit-unknown"
              : "rolled-back";
        try {
          await gateway.phase.finishTerminal(terminal);
        } catch (error) {
          if (!cleanupFailed) {
            cleanupFailed = true;
            cleanupFailure = error;
          }
        }
      }
      if (turn?.phase !== undefined) {
        const terminal =
          commitDisposition === "acknowledged"
            ? "committed"
            : commitDisposition === "sent"
              ? establishedNoCommit
                ? "commit-rejected"
                : "commit-unknown"
              : "rolled-back";
        try {
          await turn.phase.finishTerminal(terminal);
        } catch (error) {
          if (!cleanupFailed) {
            cleanupFailed = true;
            cleanupFailure = error;
          }
        }
      }
      if (context?.protectedProfile !== undefined) {
        try {
          await context.protectedProfile.release();
          context.protectedProfile.assertSettled();
        } catch (error) {
          if (!cleanupFailed) {
            cleanupFailed = true;
            cleanupFailure = error;
          }
        }
      }
      cleanup(() => lifecyclePhase.assertChannelOutcome());
      cleanup(() => lifecyclePhase.closeChannelFirstCreate());
      if (cleanupFailed && !primaryFailure) {
        if (fresh !== undefined)
          this.captureFreshFailure(fresh, cleanupFailure, "terminal-cleanup");
        const possibleCommit =
          !readOnly && commitDisposition !== "not-sent" && !establishedNoCommit;
        const outward = possibleCommit
          ? new PostgresCommitOutcomeUnknownError()
          : databaseError(cleanupFailure);
        this.rememberChannelFailure(context, outward);
        throw outward;
      }
    }
  }

  private async currentInstallation(
    context: TransactionContext,
    query: PostgresClient["query"] = context.profileQuery,
  ): Promise<Readonly<Installation> | undefined> {
    if (!context.installationLoaded) {
      const candidates = rows(
        (await query("SELECT id, name, created_at FROM occ.installation ORDER BY id LIMIT 2")).rows,
      );
      if (candidates.length > 1)
        throw new DependencyUnavailableError("The platform Installation is ambiguous.");
      context.installation =
        candidates[0] === undefined ? undefined : installationFromRow(candidates[0]);
      context.installationLoaded = true;
    }
    return context.installation;
  }

  private async requireInitialized(
    context: TransactionContext,
    query: PostgresClient["query"] = context.profileQuery,
  ): Promise<Readonly<Installation>> {
    const installation = await this.currentInstallation(context, query);
    if (installation === undefined)
      throw new ScopeViolationError("The server-owned Installation has not been initialized.");
    return installation;
  }

  private async requireInstallation(
    context: TransactionContext,
    installationId: string,
    query: PostgresClient["query"] = context.profileQuery,
  ): Promise<Readonly<Installation>> {
    const installation = await this.requireInitialized(context, query);
    if (installation.id !== installationId)
      throw new ScopeViolationError(
        "The resource does not belong to the server-owned Installation.",
      );
    return installation;
  }

  private async appendAudit(
    context: TransactionContext,
    event: AuditEvent,
    query: PostgresClient["query"],
  ): Promise<void> {
    await this.requireInstallation(context, event.installationId, query);
    if (context.turn !== undefined) {
      const record = this.#turnExecution.getStore();
      if (record === undefined || record.context !== context)
        throw new ScopeViolationError("The turn audit unit is unavailable.");
      this.assertTurnIO(record);
      if (
        event.namespaceId !== record.phase.unit.namespaceId ||
        event.resource.namespaceId !== record.phase.unit.namespaceId
      )
        throw new ScopeViolationError("The turn audit belongs to another scope.");
      query = (statement, parameters) => this.turnQuery(record, statement, parameters);
    }
    if (event.resource.namespaceId !== event.namespaceId)
      throw new ScopeViolationError("The audit event and resource scopes do not match.");
    const details = auditDetails(event);
    await query(
      `INSERT INTO occ.audit_events
             (id, occurred_at, kind, actor_id, action, namespace_id, resource_kind, resource_id,
              outcome, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        event.id,
        event.occurredAt,
        event.kind,
        event.actorId,
        event.action,
        event.namespaceId ?? null,
        event.resource.kind,
        event.resource.id,
        event.outcome,
        details === undefined ? null : JSON.stringify(details),
      ],
    );
  }

  private repositories(context: TransactionContext): PlatformUnitOfWork {
    const { client } = context;
    const queue = new PostgresWorkQueue(client);

    const installations: InstallationRepository = {
      findInstallation: async (installationId) => {
        const installation = await this.currentInstallation(context);
        return installation?.id === installationId ? immutableCopy(installation) : undefined;
      },
      getInstallation: async () => {
        const installation = await this.currentInstallation(context);
        return installation === undefined ? undefined : immutableCopy(installation);
      },
      createInstallation: async (installation) => {
        if ((await this.currentInstallation(context)) !== undefined)
          throw new ResourceConflictError("An Installation has already been bootstrapped.");
        await client.query(
          "INSERT INTO occ.installation (id, name, created_at) VALUES ($1, $2, $3)",
          [installation.id, installation.name, installation.createdAt],
        );
        context.installation = immutableCopy(installation);
        context.installationLoaded = true;
        if (context.fresh === undefined && this.bootstrapNativeIAM !== undefined)
          await this.insertIAMState(context, this.bootstrapNativeIAM);
        return immutableCopy(installation);
      },
    };

    const namespaces = createPostgresNamespaceRepository({
      get scope() {
        context.lifetime.assertActive();
        if (context.installation === undefined)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: { assertActive: () => context.lifetime.assertActive() },
      query: { query: (statement, parameters) => client.query(statement, parameters) },
      requireInitialized: () => this.requireInitialized(context),
    });

    const validateSecretBindingsAvailable = async (
      namespaceId: string,
      bindings: SecretBindings | undefined,
    ): Promise<void> => {
      const secretIds = referencedSecretIds(namespaceId, bindings);
      if (secretIds.length === 0) return;
      const found = rows(
        (
          await client.query(
            `SELECT id FROM occ.secrets
             WHERE namespace_id = $1 AND id = ANY($2::text[])
             ORDER BY id`,
            [namespaceId, secretIds],
          )
        ).rows,
      );
      if (found.length !== secretIds.length)
        throw new ScopeViolationError("Secret bindings reference unavailable Secret metadata.");
    };

    const configurations = createPostgresConfigurationRepository({
      get scope() {
        context.lifetime.assertActive();
        if (context.installation === undefined)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: { assertActive: () => context.lifetime.assertActive() },
      query: { query: (statement, parameters) => client.query(statement, parameters) },
      requireInitialized: () => this.requireInitialized(context),
      namespaces,
      serializeSecretBindings,
      validateSecretBindingsAvailable,
      secretBindingsFromJson,
      rows,
      text,
      timestamp,
    });

    const secrets = createPostgresSecretRepository({
      get scope() {
        context.lifetime.assertActive();
        if (context.installation === undefined)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: { assertActive: () => context.lifetime.assertActive() },
      query: { query: (statement, parameters) => client.query(statement, parameters) },
      requireInitialized: () => this.requireInitialized(context),
      namespaces,
      rows,
      text,
      timestamp,
    });

    const serviceAccounts = createPostgresServiceAccountRepository({
      get scope() {
        context.lifetime.assertActive();
        if (context.installation === undefined)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: { assertActive: () => context.lifetime.assertActive() },
      query: { query: (statement, parameters) => client.query(statement, parameters) },
      requireInitialized: () => this.requireInitialized(context),
      namespaces,
      rows,
      text,
      findServiceAccountProviderBinding: async (namespaceId, serviceAccountId) => {
        const found = rows(
          (
            await client.query(
              `SELECT b.provider_id, b.driver_id, b.workspace_id,
                      b.external_credential_id IS NOT NULL AS credential_issued
               FROM occ.service_account_driver_bindings AS b
               JOIN occ.namespaces AS n ON n.id = b.namespace_id AND n.deleted_at IS NULL
               WHERE b.namespace_id = $1 AND b.service_account_id = $2`,
              [namespaceId, serviceAccountId],
            )
          ).rows,
        )[0];
        return found === undefined
          ? undefined
          : immutableCopy({
              providerId: text(found, "provider_id"),
              driverId: text(found, "driver_id"),
              workspaceId: text(found, "workspace_id"),
              credentialIssued: found.credential_issued === true,
            });
      },
    });

    const findAgent = async (
      namespaceId: string,
      agentId: string,
      lock = false,
    ): Promise<Readonly<Agent> | undefined> => {
      const found = rows(
        (
          await client.query(
            `SELECT a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                    a.provider_id, a.service_principal_id, a.service_account_id,
                    a.active_revision_id, a.created_at, a.workload_profile_selection
             FROM occ.agents AS a
             JOIN occ.namespaces AS n ON n.id = a.namespace_id AND n.deleted_at IS NULL
             WHERE a.namespace_id = $1 AND a.id = $2${lock ? " FOR UPDATE OF a" : ""}`,
            [namespaceId, agentId],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : agentFromRow(found);
    };

    const agents: AgentRepository = {
      findAgent,
      lockAgent: async (namespaceId, agentId) => findAgent(namespaceId, agentId, true),
      listAgents: async (namespaceId) => {
        const found = rows(
          (
            await client.query(
              `SELECT a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                      a.provider_id, a.service_principal_id, a.service_account_id,
                      a.active_revision_id, a.created_at, a.workload_profile_selection
               FROM occ.agents AS a
               JOIN occ.namespaces AS n ON n.id = a.namespace_id AND n.deleted_at IS NULL
               WHERE a.namespace_id = $1 ORDER BY a.created_at, a.id`,
              [namespaceId],
            )
          ).rows,
        );
        return Object.freeze(found.map((row) => agentFromRow(row)));
      },
      createAgent: async (agent) => {
        agent = immutableCopy(agent);
        const selection =
          agent.workloadProfileSelection === undefined
            ? undefined
            : decodeWorkloadProfileSelectionV1(agent.workloadProfileSelection);
        if (selection?.kind === "invalid")
          throw new ScopeViolationError("The Agent workload selection is invalid.");
        await this.requireInitialized(context);
        const namespace = await namespaces.lockNamespace(agent.namespaceId);
        if (
          namespace === undefined ||
          (namespace.status !== "provisioning" && namespace.status !== "ready")
        )
          throw new ScopeViolationError("The Agent belongs to an unavailable Namespace.");
        const configuration = await configurations.findConfiguration(
          agent.namespaceId,
          agent.configurationId,
        );
        if (configuration === undefined)
          throw new ScopeViolationError("The Agent references an unavailable Configuration.");
        await validateSecretBindingsAvailable(agent.namespaceId, configuration.secretBindings);
        await client.query(
          `INSERT INTO occ.agents
           (id, namespace_id, name, configuration_id, provider_id, execution_mode,
             service_principal_id, service_account_id, active_revision_id, created_at, workload_profile_selection)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
          [
            agent.id,
            agent.namespaceId,
            agent.name,
            agent.configurationId,
            agent.providerId,
            agent.executionMode,
            agent.servicePrincipalId,
            agent.serviceAccountId ?? null,
            agent.activeRevisionId ?? null,
            agent.createdAt,
            selection === undefined ? null : JSON.stringify(selection.value),
          ],
        );
        await client.query(
          `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
           VALUES ($1, $2, $3, 'service_principal', NULL, NULL)`,
          [agent.servicePrincipalId, agent.namespaceId, agent.id],
        );
        return immutableCopy(agent);
      },
      updateConfiguration: async (
        namespaceId,
        agentId,
        configurationId,
        executionMode,
        serviceAccountId,
        providerId,
        workloadProfileSelection,
      ) => {
        const selection =
          workloadProfileSelection === undefined
            ? undefined
            : decodeWorkloadProfileSelectionV1(workloadProfileSelection);
        if (selection?.kind === "invalid")
          throw new ScopeViolationError("The Agent workload selection is invalid.");
        const configuration = await configurations.findConfiguration(namespaceId, configurationId);
        if (configuration === undefined)
          throw new ScopeViolationError("The Agent references an unavailable Configuration.");
        await validateSecretBindingsAvailable(namespaceId, configuration.secretBindings);
        const updated = rows(
          (
            await client.query(
              `UPDATE occ.agents AS a
               SET configuration_id = $3, execution_mode = COALESCE($4::text, a.execution_mode),
                   service_account_id = CASE WHEN $5::boolean THEN $6::text ELSE a.service_account_id END,
                   provider_id = CASE WHEN $7::boolean THEN $8::text ELSE a.provider_id END,
                   workload_profile_selection = CASE WHEN $9::boolean THEN $10::jsonb ELSE a.workload_profile_selection END
               FROM occ.namespaces AS n
               WHERE a.namespace_id = $1 AND a.id = $2
                 AND n.id = a.namespace_id AND n.deleted_at IS NULL
                RETURNING a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                          a.provider_id, a.service_principal_id, a.service_account_id,
                          a.active_revision_id, a.created_at, a.workload_profile_selection`,
              [
                namespaceId,
                agentId,
                configurationId,
                executionMode ?? null,
                serviceAccountId !== undefined,
                serviceAccountId ?? null,
                providerId !== undefined,
                providerId ?? null,
                selection !== undefined,
                selection === undefined ? null : JSON.stringify(selection.value),
              ],
            )
          ).rows,
        )[0];
        return updated === undefined ? undefined : agentFromRow(updated);
      },
      compareAndSetActiveRevision: async (
        namespaceId,
        agentId,
        expectedRevisionId,
        candidateRevisionId,
      ) => {
        const updated = rows(
          (
            await client.query(
              `UPDATE occ.agents AS a SET active_revision_id = $4
               FROM occ.namespaces AS n
               WHERE a.namespace_id = $1 AND a.id = $2
                 AND a.active_revision_id IS NOT DISTINCT FROM $3::text
                 AND n.id = a.namespace_id AND n.deleted_at IS NULL
                RETURNING a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                          a.provider_id, a.service_principal_id, a.service_account_id,
                          a.active_revision_id, a.created_at, a.workload_profile_selection`,
              [namespaceId, agentId, expectedRevisionId ?? null, candidateRevisionId],
            )
          ).rows,
        )[0];
        return updated === undefined ? undefined : agentFromRow(updated);
      },
    };

    const revisions = createPostgresRevisionRepository({
      get scope() {
        context.lifetime.assertActive();
        if (context.installation === undefined)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: { assertActive: () => context.lifetime.assertActive() },
      query: { query: (statement, parameters) => client.query(statement, parameters) },
      requireInitialized: () => this.requireInitialized(context),
      agents,
      rows,
      revisionFromRow,
      // The repository invokes this only for a present revision field. Preserve
      // that explicit empty map in the initial row; omitted V1 fields stay omitted.
      secretBindingsFromState: (bindings, namespaceId) =>
        secretBindingsFromState(bindings, namespaceId, true),
      validateSecretBindingsAvailable,
    });

    const runtimeOwner = async (scope: RuntimeScope, writing = false) => {
      const installation = await this.currentInstallation(context);
      const namespace = writing
        ? await namespaces.lockNamespace(scope.namespaceId)
        : await namespaces.findNamespace(scope.namespaceId);
      const agent = writing
        ? await agents.lockAgent(scope.namespaceId, scope.agentId)
        : await agents.findAgent(scope.namespaceId, scope.agentId);
      if (
        installation === undefined ||
        namespace === undefined ||
        agent === undefined ||
        (writing && namespace.status !== "ready")
      )
        return undefined;
      return { installation, agent };
    };
    const channelBindings = createPostgresChannelBindingRepository({
      get scope() {
        context.lifetime.assertActive();
        if (context.installation === undefined)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: { assertActive: () => context.lifetime.assertActive() },
      query: { query: (statement, parameters) => client.query(statement, parameters) },
      currentInstallation: () => this.currentInstallation(context),
      reservedCreate: {
        query: { query: context.channelCreateQuery },
        currentInstallation: () => this.currentInstallation(context, context.channelCreateQuery),
        assertActive: () => this.assertChannelFirstCreateOwner(context),
        complete: (prepared, currentness, insertPrepared, originalPrepared) =>
          this.completeChannelFirstCreate(
            context,
            prepared,
            currentness,
            insertPrepared,
            originalPrepared,
          ),
      },
    });

    const runtimeAssignments: RuntimeAssignmentRepository = {
      findRuntimeIntent: async (scope, transitionRef) => {
        if (!(await runtimeOwner(scope))) return undefined;
        const found = rows(
          (
            await client.query(
              "SELECT * FROM occ.agent_runtime_intents WHERE namespace_id = $1 AND agent_id = $2 AND transition_ref = $3",
              [scope.namespaceId, scope.agentId, transitionRef],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : runtimeIntentFromRow(found);
      },
      findRuntimeIntentHead: async (scope) => {
        if (!(await runtimeOwner(scope))) return undefined;
        const found = rows(
          (
            await client.query(
              "SELECT intent.* FROM occ.agent_runtime_intents intent JOIN occ.agent_runtime_intent_heads head USING (namespace_id, agent_id, generation, transition_ref) WHERE head.namespace_id = $1 AND head.agent_id = $2",
              [scope.namespaceId, scope.agentId],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : runtimeIntentFromRow(found);
      },
      findRuntimeAllocation: async (scope, locator) => {
        if (!(await runtimeOwner(scope))) return undefined;
        const found = rows(
          (
            await client.query(
              `SELECT * FROM occ.runtime_assignment_allocations WHERE namespace_id = $1 AND agent_id = $2 AND ${locator.assignmentRef !== undefined ? "assignment_ref" : "create_effect_ref"} = $3`,
              [scope.namespaceId, scope.agentId, locator.assignmentRef ?? locator.createEffectRef],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : runtimeAllocationFromRow(found);
      },
      initializeRuntimeIntent: async (scope, revisionId, transitionRef, attribution) =>
        saveRuntimeIntent(
          scope,
          0,
          { desiredMode: "running", revisionId },
          transitionRef,
          attribution,
        ),
      advanceRuntimeIntent: async (scope, expectedGeneration, next, transitionRef, attribution) => {
        if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
          throw new ResourceConflictError("The runtime intent generation is invalid.");
        return saveRuntimeIntent(scope, expectedGeneration, next, transitionRef, attribution);
      },
      allocateUnboundRuntime: async (
        scope,
        expectedLifecycleGeneration,
        component,
        expectedRuntimeGeneration,
        createEffectRef,
        profileRefs,
      ) => {
        if (
          profileRefs === null ||
          typeof profileRefs !== "object" ||
          Object.keys(profileRefs).sort().join(",") !==
            "identityProfileRef,providerProfileRef,runtimeProfileRef"
        )
          throw new ScopeViolationError("The runtime profile reference shape is invalid.");
        const owner = await runtimeOwner(scope, true);
        if (owner === undefined) throw new ScopeViolationError("The runtime owner is unavailable.");
        const existing = rows(
          (
            await client.query(
              "SELECT * FROM occ.runtime_assignment_allocations WHERE create_effect_ref = $1",
              [createEffectRef],
            )
          ).rows,
        )[0];
        if (existing !== undefined) {
          const saved = runtimeAllocationFromRow(existing);
          if (
            saved.namespaceId !== scope.namespaceId ||
            saved.agentId !== scope.agentId ||
            saved.lifecycleGeneration !== expectedLifecycleGeneration ||
            saved.component !== component ||
            saved.runtimeGeneration !== expectedRuntimeGeneration + 1 ||
            saved.providerProfileRef !== profileRefs.providerProfileRef ||
            saved.runtimeProfileRef !== profileRefs.runtimeProfileRef ||
            saved.identityProfileRef !== profileRefs.identityProfileRef
          )
            throw new ResourceConflictError(
              "The runtime create effect conflicts with its stored allocation.",
            );
          return saved;
        }
        const head = await runtimeAssignments.findRuntimeIntentHead(scope);
        if (
          head === undefined ||
          head.generation !== expectedLifecycleGeneration ||
          head.desiredMode !== "running"
        )
          throw new ResourceConflictError("The running runtime intent does not match.");
        // Every allocator holds the same Agent lock before reading its component sequence.
        const latest = rows(
          (
            await client.query(
              "SELECT runtime_generation FROM occ.runtime_assignment_allocations WHERE namespace_id = $1 AND agent_id = $2 AND component = $3 ORDER BY runtime_generation DESC LIMIT 1",
              [scope.namespaceId, scope.agentId, component],
            )
          ).rows,
        )[0];
        const prior = latest === undefined ? 0 : runtimeGeneration(latest, "runtime_generation");
        if (prior !== expectedRuntimeGeneration || !Number.isSafeInteger(prior + 1))
          throw new ResourceConflictError("The runtime allocation generation does not match.");
        const found = rows(
          (
            await client.query(
              `INSERT INTO occ.runtime_assignment_allocations
          (assignment_ref, create_effect_ref, installation_id, namespace_id, agent_id, revision_id, service_principal_id, lifecycle_generation, component, runtime_generation, provider_profile_ref, runtime_profile_ref, identity_profile_ref, binding_condition, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'unbound',clock_timestamp()) RETURNING *`,
              [
                randomUUID(),
                createEffectRef,
                owner.installation.id,
                scope.namespaceId,
                scope.agentId,
                head.revisionId,
                owner.agent.servicePrincipalId,
                head.generation,
                component,
                prior + 1,
                profileRefs.providerProfileRef,
                profileRefs.runtimeProfileRef,
                profileRefs.identityProfileRef,
              ],
            )
          ).rows,
        )[0];
        return runtimeAllocationFromRow(found!);
      },
    };
    async function saveRuntimeIntent(
      scope: RuntimeScope,
      expected: number,
      next: {
        readonly desiredMode: "running" | "disabled" | "stopped";
        readonly revisionId: string;
      },
      transitionRef: string,
      attribution: RuntimeIntentAttribution,
    ): Promise<Readonly<RuntimeIntent>> {
      const owner = await runtimeOwner(scope, true);
      if (
        owner === undefined ||
        !(await revisions.findRevision(scope.namespaceId, scope.agentId, next.revisionId))
      )
        throw new ScopeViolationError("The runtime owner or revision is unavailable.");
      const head = await runtimeAssignments.findRuntimeIntentHead(scope);
      if ((head?.generation ?? 0) !== expected || !Number.isSafeInteger(expected + 1))
        throw new ResourceConflictError("The runtime intent transition conflicts.");
      const found = rows(
        (
          await client.query(
            `INSERT INTO occ.agent_runtime_intents
        (transition_ref,installation_id,namespace_id,agent_id,generation,desired_mode,revision_id,actor_id,request_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()) RETURNING *`,
            [
              transitionRef,
              owner.installation.id,
              scope.namespaceId,
              scope.agentId,
              expected + 1,
              next.desiredMode,
              next.revisionId,
              attribution.actorId,
              attribution.requestId,
            ],
          )
        ).rows,
      )[0];
      if (expected === 0) {
        await client.query(
          "INSERT INTO occ.agent_runtime_intent_heads (namespace_id,agent_id,generation,transition_ref) VALUES ($1,$2,1,$3)",
          [scope.namespaceId, scope.agentId, transitionRef],
        );
      } else {
        const updated = await client.query(
          "UPDATE occ.agent_runtime_intent_heads SET generation = $3, transition_ref = $4 WHERE namespace_id = $1 AND agent_id = $2 AND generation = $5 RETURNING agent_id",
          [scope.namespaceId, scope.agentId, expected + 1, transitionRef, expected],
        );
        if (updated.rows.length !== 1)
          throw new ResourceConflictError("The runtime intent transition conflicts.");
      }
      return runtimeIntentFromRow(found!);
    }

    const deployCommandLocks = new Map<string, string>();
    const deployScopeKey = (scope: RuntimeScope) =>
      JSON.stringify([scope.namespaceId, scope.agentId]);
    const runtimeAdmissions: RuntimeAdmissionRepository = {
      lockDeployCommand: async (scopeInput, operationRef) => {
        const scope = immutableCopy(scopeInput);
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            operationRef,
          )
        )
          throw new ScopeViolationError("The deployment operation identity is invalid.");
        const installation = await this.requireInitialized(context);
        const prior = deployCommandLocks.get(operationRef);
        if (prior !== undefined && prior !== deployScopeKey(scope))
          throw new ResourceConflictError(
            "The deployment operation belongs to different operands.",
          );
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('lifecycle-deploy-command:' || $1 || ':' || $2, 0))",
          [installation.id, operationRef],
        );
        deployCommandLocks.set(operationRef, deployScopeKey(scope));
      },
      findCommittedDeployCommand: async (scopeInput, commandInput, actorId) => {
        const scope = immutableCopy(scopeInput);
        const command = parseLifecycleDeployV2("command", commandInput);
        if (typeof actorId !== "string" || !/^[A-Za-z0-9._:/-]{1,200}$/.test(actorId))
          throw new ScopeViolationError("The deployment actor is invalid.");
        const installation = await this.requireInitialized(context);
        const canonical = canonicalLifecycleDeployCommandV2(
          {
            installationId: installation.id,
            namespaceId: scope.namespaceId,
            agentId: scope.agentId,
          },
          command,
        );
        // Resolve the original transition globally before touching today's draft/head.
        // A legacy or foreign owner conflicts; it is never hidden as an absent operation.
        const found = rows(
          (
            await client.query(
              `SELECT intent.actor_id AS intent_actor_id, intent.request_id,
                  admission.deploy_actor_id, admission.deploy_command, admission.deploy_canonical
           FROM occ.agent_runtime_intents intent
           LEFT JOIN occ.agent_revision_runtime_admissions admission
             ON admission.runtime_transition_ref=intent.transition_ref
           WHERE intent.transition_ref=$1`,
              [command.operationRef],
            )
          ).rows,
        )[0];
        if (found === undefined) return undefined;
        if (
          found.deploy_actor_id !== actorId ||
          found.intent_actor_id !== actorId ||
          found.deploy_canonical !== canonical ||
          canonicalLifecycleDeployCommandV2(
            {
              installationId: installation.id,
              namespaceId: scope.namespaceId,
              agentId: scope.agentId,
            },
            found.deploy_command,
          ) !== canonical
        )
          throw new ResourceConflictError(
            "The deployment operation conflicts with retained state.",
          );
        const revision = await runtimeAdmissions.findCommittedAdmission(
          scope,
          command.operationRef,
          {
            actorId,
            requestId: text(found, "request_id"),
          },
        );
        if (revision === undefined)
          throw new DependencyUnavailableError("The original deployment admission is incomplete.");
        return revision;
      },
      findRevisionAdmission: async (scope, revisionId) => {
        if (!(await runtimeOwner(scope))) return undefined;
        const found = rows(
          (
            await client.query(
              `SELECT * FROM occ.agent_revision_runtime_admissions
           WHERE namespace_id = $1 AND agent_id = $2 AND revision_id = $3`,
              [scope.namespaceId, scope.agentId, revisionId],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : revisionAdmissionFromRow(found);
      },
      findCommittedAdmission: async (scope, transitionRef, attribution) => {
        if (!(await runtimeOwner(scope))) return undefined;
        // Exact immutable admission and original work, independent of head advancement,
        // lease ownership, completion, and permanently failed reconciliation.
        const found = rows(
          (
            await client.query(
              `SELECT to_jsonb(intent) AS intent,
             to_jsonb(revision) || jsonb_build_object('service_principal_id', agent.service_principal_id) AS revision,
             to_jsonb(audit) AS audit
           FROM occ.agent_revision_runtime_admissions admission
           JOIN occ.agent_runtime_intents intent
             ON intent.namespace_id = admission.namespace_id AND intent.agent_id = admission.agent_id
            AND intent.revision_id = admission.revision_id AND intent.transition_ref = admission.runtime_transition_ref
            AND intent.generation = admission.lifecycle_generation
           JOIN occ.agent_revisions revision
             ON revision.namespace_id = admission.namespace_id AND revision.agent_id = admission.agent_id
            AND revision.id = admission.revision_id
           JOIN occ.agents agent ON agent.namespace_id = revision.namespace_id AND agent.id = revision.agent_id
           JOIN occ.controller_work work
             ON work.idempotency_key = 'agent_revision:' || admission.revision_id || ':reconcile'
            AND work.namespace_id = admission.namespace_id AND work.agent_id = admission.agent_id
            AND work.revision_id = admission.revision_id AND work.runtime_transition_ref = admission.runtime_transition_ref
            AND work.lifecycle_generation = admission.lifecycle_generation AND work.actor_id = intent.actor_id
            AND work.namespace_target IS NULL AND work.work_schema_version=0
           JOIN occ.audit_events audit ON audit.id = admission.audit_event_id
           WHERE admission.namespace_id = $1 AND admission.agent_id = $2
             AND admission.runtime_transition_ref = $3 AND intent.actor_id = $4 AND intent.request_id = $5
             AND intent.desired_mode = 'running'`,
              [
                scope.namespaceId,
                scope.agentId,
                transitionRef,
                attribution.actorId,
                attribution.requestId,
              ],
            )
          ).rows,
        )[0];
        if (found === undefined) return undefined;
        const intent = runtimeIntentFromRow(jsonObject(found.intent));
        const installation = await this.requireInitialized(context);
        if (
          intent.installationId !== installation.id ||
          !isRuntimeAdmissionAudit(auditFromRow(jsonObject(found.audit), installation.id), intent)
        )
          return undefined;
        return revisionFromRow(jsonObject(found.revision));
      },
      recordAdmission: async (admissionInput, deployInput) => {
        const admission = immutableCopy(admissionInput);
        const deploy = deployInput === undefined ? undefined : immutableCopy(deployInput);
        const command =
          deploy === undefined ? undefined : parseLifecycleDeployV2("command", deploy.command);
        const installation = await this.requireInitialized(context);
        if (
          deploy !== undefined &&
          (command!.operationRef !== admission.runtimeTransitionRef ||
            deployCommandLocks.get(command!.operationRef) !== deployScopeKey(admission) ||
            !/^[A-Za-z0-9._:/-]{1,200}$/.test(deploy.actorId))
        )
          throw new ScopeViolationError(
            "The deployment command is not bound to this locked operation.",
          );
        const canonical =
          command === undefined
            ? undefined
            : canonicalLifecycleDeployCommandV2(
                {
                  installationId: installation.id,
                  namespaceId: admission.namespaceId,
                  agentId: admission.agentId,
                },
                command,
              );
        await client.query(
          `INSERT INTO occ.agent_revision_runtime_admissions
           (namespace_id, agent_id, revision_id, runtime_transition_ref, lifecycle_generation, audit_event_id,
            deploy_actor_id, deploy_command, deploy_canonical)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
          [
            admission.namespaceId,
            admission.agentId,
            admission.revisionId,
            admission.runtimeTransitionRef,
            admission.lifecycleGeneration,
            admission.auditEventId,
            deploy?.actorId ?? null,
            command === undefined ? null : JSON.stringify(command),
            canonical ?? null,
          ],
        );
      },
    };

    function authorityOperation(row: PostgresRow): StoredRuntimeAuthorityOperation {
      const result = parseRuntimeAuthorityV1("operationState", {
        schemaVersion: 1,
        result: "committed",
        receipt: row.receipt,
      });
      if (!("receipt" in result) || typeof row.canonical_payload !== "string")
        throw new DependencyUnavailableError("The runtime authority record is invalid.");
      return immutableCopy({ canonicalPayload: row.canonical_payload, receipt: result.receipt });
    }
    const audit: PlatformAuditRepository = {
      append: async (event) => this.appendAudit(context, event, client.query),
      list: async () => {
        const installation = await this.currentInstallation(context);
        if (installation === undefined) return Object.freeze([]);
        const found = rows(
          (
            await client.query(
              `SELECT id, occurred_at, kind, actor_id, action, namespace_id, resource_kind,
                        resource_id, outcome, details
                 FROM occ.audit_events ORDER BY occurred_at, id`,
            )
          ).rows,
        );
        return Object.freeze(found.map((row) => auditFromRow(row, installation.id)));
      },
    };
    const runtimeServiceTrust = createRuntimeServiceTrustRepository(
      {
        lockOperation: async (operationRef) => {
          await client.query("SET LOCAL lock_timeout = '3000ms'");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('runtime-service-trust-operation:' || $1,0))",
            [operationRef],
          );
        },
        lockSubject: async (installationId, kind, subjectRef) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('runtime-service-trust-subject:' || $1 || ':' || $2 || ':' || $3,0))",
            [installationId, kind, subjectRef],
          );
        },
        operation: async (operationRef) => {
          const result = await client.query(
            "SELECT record FROM occ.runtime_service_trust_records WHERE operation_ref=$1",
            [operationRef],
          );
          const row = rows(result.rows)[0];
          return row === undefined ? undefined : parseRuntimeServiceTrustRecord(row.record);
        },
        latest: async (installationId, kind, subjectRef) => {
          const result = await client.query(
            "SELECT record FROM occ.runtime_service_trust_records WHERE installation_id=$1 AND subject_kind=$2 AND subject_ref=$3 ORDER BY record_version DESC LIMIT 1",
            [installationId, kind, subjectRef],
          );
          const row = rows(result.rows)[0];
          return row === undefined ? undefined : parseRuntimeServiceTrustRecord(row.record);
        },
        insert: async (record, event) => {
          await audit.append(event);
          await client.query(
            "INSERT INTO occ.runtime_service_trust_records (installation_id,subject_kind,subject_ref,record_version,operation_ref,actor_id,audit_id,canonical_request,request_digest,committed_at,record) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
            [
              record.installationId,
              record.subjectKind,
              record.subjectRef,
              record.recordVersion,
              record.operationRef,
              record.actorId,
              record.auditId,
              record.canonicalRequest,
              record.requestDigest,
              record.committedAt,
              JSON.stringify(record),
            ],
          );
        },
      },
      { installations, agents, namespaces },
      context.authorityGuard,
    );
    const runtimeAuthority = createRuntimeAuthorityRepository(
      {
        lockOperation: async (operationRef) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('runtime-authority-operation:' || $1, 0))",
            [operationRef],
          );
        },
        allocation: async (scope, assignmentRef, lock) => {
          const installation = await this.currentInstallation(context);
          if (installation?.id !== scope.installationId) return undefined;
          // Use the same Agent lock as intent/assignment writers before any head or version read.
          if (lock)
            await client.query(
              "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR UPDATE",
              [scope.namespaceId, scope.agentId],
            );
          const found = rows(
            (
              await client.query(
                "SELECT * FROM occ.runtime_assignment_allocations WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND assignment_ref=$4",
                [scope.installationId, scope.namespaceId, scope.agentId, assignmentRef],
              )
            ).rows,
          )[0];
          return found === undefined ? undefined : runtimeAllocationFromRow(found);
        },
        operations: async (scope, assignmentRef) =>
          rows(
            (
              await client.query(
                "SELECT canonical_payload, receipt FROM occ.runtime_authority_operations WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND assignment_ref=$4 ORDER BY assignment_record_version",
                [scope.installationId, scope.namespaceId, scope.agentId, assignmentRef],
              )
            ).rows,
          ).map(authorityOperation),
        operation: async (operationRef) => {
          const found = rows(
            (
              await client.query(
                "SELECT canonical_payload, receipt FROM occ.runtime_authority_operations WHERE operation_ref=$1",
                [operationRef],
              )
            ).rows,
          )[0];
          return found === undefined ? undefined : authorityOperation(found);
        },
        insert: async ({ canonicalPayload, receipt }) => {
          await client.query(
            `INSERT INTO occ.runtime_authority_operations
          (operation_ref, installation_id, namespace_id, agent_id, assignment_ref, assignment_record_version, operation_kind, canonical_payload, receipt)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
            [
              receipt.operationRef,
              receipt.installationId,
              receipt.namespaceId,
              receipt.agentId,
              receipt.assignmentRef.id,
              receipt.assignmentRecordVersion,
              receipt.operationKind,
              canonicalPayload,
              JSON.stringify(receipt),
            ],
          );
        },
      },
      runtimeAssignments,
      context.authorityGuard,
    );
    const profileContext = {
      get scope() {
        context.lifetime.assertActive();
        if (!context.installation)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: context.lifetime,
      query: {
        query: (statement: string, parameters?: readonly unknown[]) =>
          context.profileQuery(statement, parameters),
      },
    };
    const profileRepository = createPostgresWorkloadProfile(
      profileContext,
      context.profilePhase.guard,
    );
    const profileAdmissions = createWorkloadProfileAdmissionRepositoryV2(
      createPostgresWorkloadProfileAdmissionBackendV2(
        profileContext,
        async (attribution, history) => {
          if (!context.protectedProfile)
            throw new DependencyUnavailableError(
              "The original profile authority owner is unavailable.",
            );
          const event = context.protectedProfile.decorateAudit(
            workloadProfileAdmissionAuditV2(attribution, history),
          );
          await this.appendAudit(context, event, context.profileQuery);
        },
      ),
      context.profilePhase.guard,
    );
    const workloadProfiles = {
      ...profileAdmissions,
      readProfile: async (...args: Parameters<typeof profileAdmissions.readProfile>) => {
        if (!context.readOnly) {
          const installation = await this.requireInitialized(context);
          await context.profileQuery(
            "SELECT pg_advisory_xact_lock_shared(hashtextextended('workload-profile-capacity:'||$1,0))",
            [installation.id],
          );
          return profileAdmissions.readProfile(...args);
        }
        // Ordinary PlatformReadView observes data in its existing RR/RO snapshot.
        // It neither acquires a current-use lease nor upgrades that transaction.
        return context.profilePhase.guard.run(async () => {
          const [namespaceId, admissionRef] = args;
          if (typeof namespaceId !== "string" || !namespaceId.startsWith("ns_"))
            throw new InvalidProfileOperationError();
          profileUuid(namespaceId.slice(3));
          profileUuid(admissionRef);
          const installation = await this.requireInitialized(context);
          const found = rows(
            (
              await context.profileQuery(
                `SELECT a.record FROM occ.workload_profile_admissions AS a
             JOIN occ.namespaces AS n ON n.id=a.namespace_id
             WHERE a.installation_id=$1 AND a.namespace_id=$2 AND a.admission_ref=$3
               AND n.status='ready' AND n.deleted_at IS NULL`,
                [installation.id, namespaceId, admissionRef],
              )
            ).rows,
          );
          if (found.length > 1)
            throw new ScopeViolationError("The observed profile head is ambiguous.");
          if (found.length === 0) return undefined;
          const head = decodeWorkloadProfileAdmissionHeadV2(found[0]!.record);
          if (
            head.scope.installationId !== installation.id ||
            head.scope.namespaceId !== namespaceId ||
            head.selection.admissionRef !== admissionRef
          )
            throw new ScopeViolationError("The observed profile head belongs to another scope.");
          return head;
        });
      },
      findOperation: async (...args: Parameters<typeof profileRepository.findOperation>) => {
        await this.requireInitialized(context);
        return profileRepository.findOperation(...args);
      },
      prepareOperation: async (...args: Parameters<typeof profileRepository.prepareOperation>) => {
        try {
          await this.requireInitialized(context);
          return await profileRepository.prepareOperation(...args);
        } catch (error) {
          return context.profilePhase.guard.run(async () => {
            throw error;
          });
        }
      },
    };
    const runtimePreparation = createPostgresRuntimePreparation(
      {
        get scope() {
          context.lifetime.assertActive();
          if (context.installation === undefined)
            throw new ScopeViolationError(
              "The server-owned Installation has not been initialized.",
            );
          return { installationId: context.installation.id };
        },
        transaction: { assertActive: () => context.lifetime.assertActive() },
        query: { query: (statement, parameters) => client.query(statement, parameters) },
      },
      runtimeAssignments,
      runtimeAdmissions,
      runtimeAuthority,
      context.authorityGuard,
    );
    const turnJournal =
      this.turnJournal === undefined
        ? undefined
        : createPostgresTurnJournal(
            {
              get scope() {
                context.lifetime.assertActive();
                if (context.installation === undefined)
                  throw new ScopeViolationError(
                    "The server-owned Installation has not been initialized.",
                  );
                return { installationId: context.installation.id };
              },
              transaction: { assertActive: () => context.lifetime.assertActive() },
              query: {
                query: (statement, parameters) => {
                  if (context.turn === undefined) return client.query(statement, parameters);
                  const record = this.#turnExecution.getStore();
                  if (record === undefined || record.context !== context)
                    throw new ScopeViolationError("The turn journal unit is unavailable.");
                  return this.turnQuery(record, statement, parameters);
                },
              },
              currentInstallation: async () => {
                context.lifetime.assertActive();
                const installation = await this.currentInstallation(context);
                context.lifetime.assertActive();
                return installation;
              },
              guard: context.journalGuard,
            },
            this.turnJournal,
          );
    const runtimeEffectAdmission = createPostgresRuntimeEffectAdmission({
      get scope() {
        context.lifetime.assertActive();
        if (!context.installation)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: { assertActive: () => context.lifetime.assertActive() },
      query: { query: (statement, parameters) => context.lifecycleQuery(statement, parameters) },
      phase: context.lifecyclePhase,
      requireInitialized: () => this.requireInitialized(context),
      appendAudit: (event) => this.appendAudit(context, event, context.lifecycleQuery),
    });
    const lifecycleAdmissions = createPostgresLifecycleAdmission({
      get scope() {
        context.lifetime.assertActive();
        if (!context.installation)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: { assertActive: () => context.lifetime.assertActive() },
      query: { query: (statement, parameters) => context.lifecycleQuery(statement, parameters) },
      phase: context.lifecyclePhase,
      requireInitialized: () => this.requireInitialized(context),
      appendAudit: (event) => this.appendAudit(context, event, context.lifecycleQuery),
      intentFromRow: runtimeIntentFromRow,
      allocationFromRow: runtimeAllocationFromRow,
      auditFromRow,
    });
    return {
      lifecycleAdmissions,
      runtimeEffectAdmission,
      ...(turnJournal === undefined ? {} : { turnJournal }),
      workloadProfiles,
      runtimePreparation,
      runtimeAuthority,
      runtimeServiceTrust,
      channelBindings: serializeChannelBindingMutations(channelBindings),
      runtimeAssignments: serializeRuntimeAssignmentMutations(runtimeAssignments),
      runtimeAdmissions,
      installations,
      namespaces,
      configurations,
      secrets,
      serviceAccounts,
      agents,
      revisions,
      audit,
      operations: {
        append: async (operation) => {
          await this.requireInitialized(context);
          const namespaceId = operation.namespaceId;
          if (namespaceId === undefined)
            throw new ScopeViolationError("Controller work requires an exact Namespace owner.");

          let agentId: string | undefined;
          let revisionId: string | undefined;
          let namespaceTarget: "ready" | "deleted" | undefined;
          if (operation.kind === "namespace") {
            if (namespaceId !== operation.resourceId)
              throw new ScopeViolationError("Namespace work does not match its exact owner.");
            namespaceTarget = operation.target;
          } else if (operation.kind === "agent_revision") {
            revisionId = operation.resourceId;
            const owner = rows(
              (
                await client.query(
                  "SELECT agent_id FROM occ.agent_revisions WHERE namespace_id = $1 AND id = $2",
                  [namespaceId, revisionId],
                )
              ).rows,
            )[0];
            if (owner === undefined)
              throw new ScopeViolationError("AgentRevision work does not match its exact owner.");
            agentId = text(owner, "agent_id");
          } else {
            throw new ScopeViolationError("Unsupported controller work resource kind.");
          }

          await queue.enqueue({
            idempotencyKey: `${operation.kind}:${operation.resourceId}:${operation.action}${
              namespaceTarget === undefined ? "" : `:${namespaceTarget}`
            }`,
            namespaceId,
            ...(agentId === undefined ? {} : { agentId }),
            ...(revisionId === undefined ? {} : { revisionId }),
            ...(namespaceTarget === undefined ? {} : { namespaceTarget }),
            actorId: operation.actorId,
            ...(operation.runtimeTransitionRef === undefined
              ? {}
              : { runtimeTransitionRef: operation.runtimeTransitionRef }),
            ...(operation.lifecycleGeneration === undefined
              ? {}
              : { lifecycleGeneration: operation.lifecycleGeneration }),
          });
        },
        list: async () => {
          await this.requireInitialized(context);
          const found = rows(
            (
              await client.query(
                `SELECT namespace_id, agent_id, revision_id, actor_id, namespace_target,
                        runtime_transition_ref, lifecycle_generation
                 FROM occ.controller_work WHERE work_schema_version=0 ORDER BY created_at, idempotency_key`,
              )
            ).rows,
          );
          return Object.freeze(
            found.map((row): Readonly<PlatformOperation> => {
              const namespaceId = text(row, "namespace_id");
              const revisionId = optionalText(row, "revision_id");
              const base = {
                action: "reconcile" as const,
                namespaceId,
                resourceId: revisionId ?? namespaceId,
                actorId: text(row, "actor_id"),
              };
              if (revisionId === undefined) {
                const target = text(row, "namespace_target");
                if (target !== "ready" && target !== "deleted")
                  throw new DependencyUnavailableError(
                    "Persisted Namespace work has an invalid target.",
                  );
                return immutableCopy({ ...base, kind: "namespace", target });
              }
              const runtimeTransitionRef = optionalText(row, "runtime_transition_ref");
              return immutableCopy({
                ...base,
                kind: "agent_revision",
                ...(runtimeTransitionRef === undefined
                  ? {}
                  : {
                      runtimeTransitionRef,
                      lifecycleGeneration: runtimeGeneration(row, "lifecycle_generation"),
                    }),
              });
            }),
          );
        },
      },
    };
  }

  private validateIAMState(state: PersistedNativeIAMState, requireComplete: boolean): void {
    const identities = new Map<string, Identity>();
    const groups = new Map<string, Group>();
    const roles = new Map<string, Role>();
    const membershipKeys = new Set<string>();
    const bindingIds = new Set<string>();
    const restrictionIds = new Set<string>();
    for (const identity of state.identities) {
      if (identities.has(identity.id))
        throw new DependencyUnavailableError("Persisted IAM identities are invalid or ambiguous.");
      identities.set(identity.id, identity);
    }
    for (const group of state.groups) {
      if (groups.has(group.id))
        throw new DependencyUnavailableError("Persisted IAM groups are invalid or ambiguous.");
      groups.set(group.id, group);
    }
    for (const membership of state.memberships) {
      const group = groups.get(membership.groupId);
      const principal = identities.get(membership.principalId);
      const key = `${membership.groupId}\u0000${membership.principalId}`;
      if (
        group === undefined ||
        principal?.kind !== "principal" ||
        group.namespaceId !== membership.namespaceId ||
        membershipKeys.has(key)
      )
        throw new DependencyUnavailableError("Persisted IAM group memberships violate scope.");
      membershipKeys.add(key);
    }
    for (const role of state.roles) {
      if (roles.has(role.id))
        throw new DependencyUnavailableError("Persisted IAM roles are invalid or ambiguous.");
      permissions(role.permissions);
      roles.set(role.id, role);
    }
    for (const binding of state.bindings) {
      const identity =
        binding.subjectKind === "identity" ? identities.get(binding.subjectId) : undefined;
      const group = binding.subjectKind === "group" ? groups.get(binding.subjectId) : undefined;
      const role = roles.get(binding.roleId);
      if (
        bindingIds.has(binding.id) ||
        (binding.subjectKind === "identity" && identity === undefined) ||
        (binding.subjectKind === "group" && group === undefined) ||
        (binding.subjectKind !== "identity" && binding.subjectKind !== "group") ||
        role === undefined ||
        (identity?.namespaceId !== undefined && identity.namespaceId !== binding.namespaceId) ||
        (binding.subjectKind === "group" && group?.namespaceId !== binding.namespaceId) ||
        (role.namespaceId !== undefined && role.namespaceId !== binding.namespaceId) ||
        (binding.resourceKind === undefined) !== (binding.resourceId === undefined) ||
        (binding.resourceKind !== undefined && !RESOURCE_KINDS.has(binding.resourceKind)) ||
        (binding.namespaceId !== undefined && binding.resourceKind === "installation") ||
        (binding.namespaceId !== undefined &&
          binding.resourceKind === "namespace" &&
          binding.resourceId !== undefined &&
          binding.resourceId !== binding.namespaceId)
      )
        throw new DependencyUnavailableError("Persisted IAM access bindings violate exact scope.");
      bindingIds.add(binding.id);
    }
    for (const restriction of state.restrictions) {
      if (
        restrictionIds.has(restriction.id) ||
        restriction.effect !== "deny" ||
        !PERMISSION_ACTIONS.has(restriction.action) ||
        !RESOURCE_KINDS.has(restriction.resourceKind) ||
        (restriction.namespaceId !== undefined &&
          restriction.resourceKind === "namespace" &&
          restriction.resourceId !== undefined &&
          restriction.resourceId !== restriction.namespaceId) ||
        (restriction.namespaceId !== undefined && restriction.resourceKind === "installation")
      )
        throw new DependencyUnavailableError("Persisted IAM restrictions violate exact scope.");
      restrictionIds.add(restriction.id);
    }
    if (
      requireComplete &&
      (!state.identities.some((identity) => identity.kind === "principal") ||
        state.roles.length === 0 ||
        state.bindings.length === 0)
    )
      throw new DependencyUnavailableError("Persisted native IAM state is incomplete.");
  }

  private async insertIAMState(
    context: TransactionContext,
    state: PersistedNativeIAMState,
  ): Promise<void> {
    this.validateIAMState(state, true);
    for (const identity of state.identities) {
      await context.client.query(
        `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          identity.id,
          identity.namespaceId ?? null,
          identity.kind === "service_principal" ? (identity.agentId ?? null) : null,
          identity.kind,
          identity.kind === "principal" ? identity.issuer : null,
          identity.kind === "principal" ? identity.subject : null,
        ],
      );
    }
    for (const role of state.roles) {
      await context.client.query(
        "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, $2, $3, $4::jsonb)",
        [role.id, role.namespaceId ?? null, role.name ?? null, JSON.stringify(role.permissions)],
      );
    }
    for (const group of state.groups) {
      await context.client.query(
        "INSERT INTO occ.iam_groups (id, namespace_id, name) VALUES ($1, $2, $3)",
        [group.id, group.namespaceId ?? null, group.name],
      );
    }
    for (const membership of state.memberships) {
      await context.client.query(
        `INSERT INTO occ.iam_group_memberships (namespace_id, group_id, principal_id)
         VALUES ($1, $2, $3)`,
        [membership.namespaceId ?? null, membership.groupId, membership.principalId],
      );
    }
    for (const binding of state.bindings) {
      const mapping =
        binding.channelAdministration === undefined
          ? undefined
          : decodeChannelAdministrationMappingV1(binding.channelAdministration);
      if (mapping?.kind === "invalid")
        throw new DependencyUnavailableError("IAM channel administration is invalid.");
      await context.client.query(
        `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, group_subject_id, role_id,
          resource_kind, resource_id, channel_administration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          binding.id,
          binding.namespaceId ?? null,
          binding.subjectKind === "identity" ? binding.subjectId : null,
          binding.subjectKind === "group" ? binding.subjectId : null,
          binding.roleId,
          binding.resourceKind ?? null,
          binding.resourceId ?? null,
          mapping === undefined ? null : JSON.stringify(mapping.value),
        ],
      );
    }
    for (const restriction of state.restrictions) {
      await context.client.query(
        `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          restriction.id,
          restriction.namespaceId ?? null,
          restriction.action,
          restriction.resourceKind,
          restriction.resourceId ?? null,
          restriction.effect,
        ],
      );
    }
  }
}

export { PostgresPlatformState as PostgresPlatformStateStore };
