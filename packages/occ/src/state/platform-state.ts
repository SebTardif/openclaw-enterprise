import { createMemoryWorkloadProfileAdmissionBackendV2 } from "./memory/workload-profile-admission.ts";
import {
  createMemoryTurnJournal,
  createMemoryTurnJournalSnapshot,
  cloneMemoryTurnJournalSnapshot,
  retainMemoryTurnJournalOptions,
  assertMemoryTurnJournalSnapshot,
  MemoryTurnJournalParticipant,
  type MemoryTurnJournalOptions,
  type MemoryTurnJournalSnapshot,
} from "./memory/turn-journal.ts";
import {
  createWorkloadProfileAdmissionRepositoryV2,
  decodeWorkloadProfileAdmissionHistoryV2,
  type WorkloadProfileAdmissionAttributionV2,
  type WorkloadProfileAdmissionHeadV2,
  type WorkloadProfileAdmissionHistoryV2,
  type WorkloadProfileInvalidationV2,
} from "../workload-profiles/admission-record.ts";
import {
  canonicalLifecycleDeployCommandV2,
  parseLifecycleDeployV2,
  type LifecycleDeployCommandV2,
} from "@openclaw-enterprise/contracts/lifecycle-deploy-v2";
import { decodeWorkloadProfileSelectionV1 } from "@openclaw-enterprise/contracts/workload-profile-v1";
import { createMemoryRevisionRepository } from "./memory/revisions.ts";
import { LifecycleAdmissionUnitPhase } from "../lifecycle/protective-admission-unit.ts";
import { legacyOperations } from "../lifecycle/protective-admission-v1.ts";
import { createMemoryLifecycleAdmission } from "./memory/lifecycle-admission.ts";
import type { LifecycleAdmissionAssociationV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type {
  StoredPlatformWork,
  RuntimeCleanupResponsibilityV1,
  PendingAuditExportV1,
} from "../ports/repositories/lifecycle-admission.ts";
import { createMemoryWorkloadProfile } from "./memory/workload-profile.ts";
import type { StoredProfilePreparation, ProfileCapacity } from "../workload-profiles/types.ts";
import { WorkloadProfileUnitPhase } from "../ports/platform-unit-of-work.ts";
import { createMemoryRuntimePreparation } from "./memory/runtime-preparation.ts";
import type { StoredRuntimePreparationOperation } from "../runtime-preparation/types.ts";
import { RepositoryTransactionLifetime, type RepositoryTransaction } from "../ports/transaction.ts";
import { createMemoryChannelBindingRepository } from "./memory/channel-bindings.ts";
import { createMemoryNamespaceRepository } from "./memory/namespaces.ts";
import { createMemoryConfigurationRepository } from "./memory/configurations.ts";
import { createMemorySecretRepository } from "./memory/secrets.ts";
import { createMemoryServiceAccountRepository } from "./memory/service-accounts.ts";
export { validateChannelBindingList } from "./channel-binding-validation.ts";
import { createPlatformReadView } from "../ports/platform-read-view.ts";
import { bindPlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
import type {
  InstallationReadRepository,
  InstallationRepository,
} from "../ports/repositories/installation.ts";
export type {
  InstallationReadRepository,
  InstallationRepository,
} from "../ports/repositories/installation.ts";
import type {
  NamespaceReadRepository,
  PersistedNamespace,
  NamespaceRepository,
} from "../ports/repositories/namespace.ts";
export type {
  NamespaceReadRepository,
  PersistedNamespace,
  NamespaceRepository,
} from "../ports/repositories/namespace.ts";
import type { AgentReadRepository, AgentRepository } from "../ports/repositories/agent.ts";
export type { AgentReadRepository, AgentRepository } from "../ports/repositories/agent.ts";
import type { AgentRevisionReadRepository } from "../ports/repositories/revision.ts";
export type {
  AgentRevisionReadRepository,
  AgentRevisionRepository,
} from "../ports/repositories/revision.ts";
import type {
  ConfigurationOwnership,
  ConfigurationReadRepository,
} from "../ports/repositories/configuration.ts";
export type {
  ConfigurationOwnership,
  ConfigurationReadRepository,
  ConfigurationRepository,
} from "../ports/repositories/configuration.ts";
import type { SecretReadRepository } from "../ports/repositories/secret.ts";
export type { SecretReadRepository, SecretRepository } from "../ports/repositories/secret.ts";
import type { ServiceAccountReadRepository } from "../ports/repositories/service-account.ts";
export type {
  ServiceAccountReadRepository,
  ServiceAccountRepository,
} from "../ports/repositories/service-account.ts";
import type {
  PlatformAuditRepository,
  TransactionalAuditWriter,
  PlatformAuditSink,
} from "../ports/repositories/audit.ts";
export type {
  PlatformAuditRepository,
  TransactionalAuditWriter,
  PlatformAuditSink,
} from "../ports/repositories/audit.ts";
import type { PlatformOperation, PlatformOperationRepository } from "../ports/repositories/work.ts";
export type { PlatformOperation, PlatformOperationRepository } from "../ports/repositories/work.ts";
import type {
  ChannelBindingListOptions,
  ChannelBindingReadRepository,
  ChannelBindingRepository,
} from "../ports/repositories/channel-bindings.ts";
export type {
  ChannelBindingListOptions,
  ChannelBindingReadRepository,
  ChannelBindingRepository,
} from "../ports/repositories/channel-bindings.ts";
import type {
  RevisionRuntimeAdmission,
  RuntimeAdmissionReadRepository,
  RuntimeAdmissionRepository,
} from "../ports/repositories/runtime-admission.ts";
export type {
  RevisionRuntimeAdmission,
  RuntimeAdmissionReadRepository,
  RuntimeAdmissionRepository,
} from "../ports/repositories/runtime-admission.ts";
import type {
  RuntimeAssignmentReadRepository,
  RuntimeAssignmentRepository,
} from "../ports/repositories/runtime-assignment.ts";
export type {
  RuntimeAssignmentReadRepository,
  RuntimeAssignmentRepository,
} from "../ports/repositories/runtime-assignment.ts";
import type { PlatformReadView } from "../ports/platform-read-view.ts";
export type { PlatformReadView } from "../ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
export type { PlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
import type { PlatformReadOptions, PlatformStateStore } from "../ports/transaction.ts";
export type { PlatformReadOptions, PlatformStateStore } from "../ports/transaction.ts";
import {
  createRuntimeServiceTrustRepository,
  runtimeServiceTrustAuditMatches,
  type RuntimeServiceTrustReadRepository,
  type RuntimeServiceTrustRepository,
} from "../runtime-authority/service-trust.ts";
import {
  parseRuntimeServiceTrustRecord,
  type RuntimeServiceTrustRecord,
} from "../runtime-authority/service-trust-schema.ts";
import {
  createRuntimeAuthorityRepository,
  RuntimeAuthorityTransactionGuard,
  type RuntimeAuthorityReadRepository,
  type RuntimeAuthorityRepository,
  type StoredRuntimeAuthorityOperation,
} from "../runtime-authority/repository.ts";
import type {
  RuntimeScope,
  RuntimeIntentAttribution,
  RuntimeIntent,
  RuntimeProfileRefs,
  RuntimeAllocation,
  RuntimeAllocationLocator,
} from "@openclaw-enterprise/contracts";
export type {
  RuntimeScope,
  RuntimeIntentAttribution,
  RuntimeIntent,
  RuntimeProfileRefs,
  RuntimeAllocation,
  RuntimeAllocationLocator,
} from "@openclaw-enterprise/contracts";

import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentRevision,
  ChannelInstallation,
  ChannelHumanBinding,
  ChannelAgentBinding,
  AuditEvent,
  HarnessExecutionMode,
  Installation,
  Namespace,
  NamespaceStatus,
  Secret,
  SecretBindings,
  ServiceAccount,
  ServiceAccountCredential,
} from "@openclaw-enterprise/contracts";
import { normalizeSecretBindings } from "@openclaw-enterprise/contracts";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../errors.ts";

const serviceAccountIdentifier =
  /^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const secretName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;
const secretKey = /^[-._a-zA-Z0-9]+$/;
const providerIdentifier = /^(?!\s)(?!.*\s$)(?!.*[\x00-\x1f\x7f]).{1,200}$/;

function validCredential(credential: unknown): credential is ServiceAccountCredential {
  if (
    credential === null ||
    typeof credential !== "object" ||
    Array.isArray(credential) ||
    Object.keys(credential).length !== 2 ||
    !("kind" in credential) ||
    !("secretRef" in credential) ||
    (credential.kind !== "api_key" &&
      credential.kind !== "oauth_access_token" &&
      credential.kind !== "access_token") ||
    credential.secretRef === null ||
    typeof credential.secretRef !== "object" ||
    Array.isArray(credential.secretRef) ||
    Object.keys(credential.secretRef).length !== 2 ||
    !("name" in credential.secretRef) ||
    !("key" in credential.secretRef)
  ) {
    return false;
  }
  const { name, key } = credential.secretRef;
  return (
    typeof name === "string" &&
    name.length <= 253 &&
    secretName.test(name) &&
    typeof key === "string" &&
    key.length <= 253 &&
    secretKey.test(key) &&
    key !== "." &&
    key !== ".."
  );
}

function assertMaximumExecutionMs(value: unknown): void {
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0))
    throw new ScopeViolationError(
      "The Agent execution limit must be null or a positive safe integer.",
    );
}

function assertAdmittedAgentRevision(revision: AgentRevision): void {
  assertMaximumExecutionMs(revision.maximumExecutionMs);
  if (
    (revision.providerId !== null &&
      (typeof revision.providerId !== "string" || !providerIdentifier.test(revision.providerId))) ||
    !/^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      revision.configurationId,
    ) ||
    revision.configurationKind !== "agent" ||
    !Number.isSafeInteger(revision.configurationGeneration) ||
    revision.configurationGeneration <= 0 ||
    typeof revision.configuration !== "object" ||
    revision.configuration === null ||
    Array.isArray(revision.configuration) ||
    typeof revision.harness !== "object" ||
    revision.harness === null ||
    Array.isArray(revision.harness) ||
    Object.keys(revision.harness).length !== 3 ||
    !Object.hasOwn(revision.harness, "id") ||
    !Object.hasOwn(revision.harness, "version") ||
    !Object.hasOwn(revision.harness, "mode") ||
    !isNonEmptyString(revision.harness.id) ||
    !isNonEmptyString(revision.harness.version) ||
    (revision.harness.mode !== "embedded" && revision.harness.mode !== "dedicated") ||
    typeof revision.compute !== "object" ||
    revision.compute === null ||
    Array.isArray(revision.compute) ||
    Object.keys(revision.compute).length !== 2 ||
    !Object.hasOwn(revision.compute, "id") ||
    !Object.hasOwn(revision.compute, "implementation") ||
    !isNonEmptyString(revision.compute.id) ||
    !isNonEmptyString(revision.compute.implementation) ||
    (revision.sandboxDriverId !== undefined && !isNonEmptyString(revision.sandboxDriverId)) ||
    (revision.secretDriverId !== undefined && !isNonEmptyString(revision.secretDriverId)) ||
    (revision.serviceAccount !== undefined &&
      (revision.serviceAccount === null ||
        typeof revision.serviceAccount !== "object" ||
        Array.isArray(revision.serviceAccount) ||
        Object.keys(revision.serviceAccount).length !== 2 ||
        !serviceAccountIdentifier.test(revision.serviceAccount.id) ||
        !validCredential(revision.serviceAccount.credential) ||
        (revision.serviceAccount.credential.kind !== "api_key" &&
          revision.serviceAccount.credential.kind !== "access_token")))
  ) {
    throw new ScopeViolationError(
      "An AgentRevision requires valid Configuration metadata, a native document, and pinned Harness and Compute descriptors.",
    );
  }
}

/** Also serialize mutations sharing a single transaction callback and SQL connection. */
export function serializeChannelBindingMutations(
  repository: ChannelBindingRepository,
): ChannelBindingRepository {
  let pending: Promise<void> = Promise.resolve();
  function mutate<T>(work: () => Promise<T>): Promise<T> {
    const result = pending.then(work);
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  return {
    ...repository,
    createChannelInstallation: (...args) =>
      mutate(() => repository.createChannelInstallation(...args)),
    createHumanBinding: (...args) => mutate(() => repository.createHumanBinding(...args)),
    createAgentBinding: (...args) => mutate(() => repository.createAgentBinding(...args)),
    setChannelInstallationStatus: (...args) =>
      mutate(() => repository.setChannelInstallationStatus(...args)),
    setHumanBindingStatus: (...args) => mutate(() => repository.setHumanBindingStatus(...args)),
    setAgentBindingStatus: (...args) => mutate(() => repository.setAgentBindingStatus(...args)),
  };
}

/** Immutable admission identity, retained independently of work state and the intent head. */
/** A success event must attest the exact canonical deploy admission. */
export function isRuntimeAdmissionAudit(event: AuditEvent, intent: RuntimeIntent): boolean {
  return (
    event.installationId === intent.installationId &&
    event.namespaceId === intent.namespaceId &&
    event.kind === "mutation" &&
    event.outcome === "success" &&
    event.action === "openclaw.agents.deploy" &&
    event.actorId === intent.actorId &&
    (event.actor?.principalId === undefined || event.actor.principalId === intent.actorId) &&
    (event.actor?.id === undefined || event.actor.id === intent.actorId) &&
    event.actor?.unresolved !== true &&
    event.requestId === intent.requestId &&
    event.resource.kind === "agent_revision" &&
    event.resource.id === intent.revisionId &&
    event.resource.namespaceId === intent.namespaceId &&
    (event.authorization === undefined ||
      (event.authorization.principalId === intent.actorId &&
        event.authorization.action === "deploy" &&
        event.authorization.resource.kind === "agent" &&
        event.authorization.resource.id === intent.agentId &&
        event.authorization.resource.namespaceId === intent.namespaceId))
  );
}
/** Serialize runtime mutations inside one unit of work, in addition to store/SQL locks. */
export function serializeRuntimeAssignmentMutations(
  repository: RuntimeAssignmentRepository,
): RuntimeAssignmentRepository {
  let pending: Promise<void> = Promise.resolve();
  function mutate<T>(work: () => Promise<T>): Promise<T> {
    const result = pending.then(work);
    // A rejected CAS remains the caller's error; it must not prevent subsequent
    // independently awaited operations from examining the current stored state.
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  return {
    ...repository,
    initializeRuntimeIntent: (...args) => mutate(() => repository.initializeRuntimeIntent(...args)),
    advanceRuntimeIntent: (...args) => mutate(() => repository.advanceRuntimeIntent(...args)),
    allocateUnboundRuntime: (...args) => mutate(() => repository.allocateUnboundRuntime(...args)),
  };
}

export interface InMemoryPlatformStateOptions {
  /** Explicit original provenance owners; absent configuration stays unavailable. */
  readonly turnJournal?: MemoryTurnJournalOptions;
  readonly auditSink?: PlatformAuditSink;
}

interface PlatformSnapshot {
  readonly turnJournal: MemoryTurnJournalSnapshot;
  readonly lifecycleAdmissions: Map<string, Readonly<LifecycleAdmissionAssociationV1>>;
  readonly cleanupResponsibilities: Map<string, Readonly<RuntimeCleanupResponsibilityV1>>;
  readonly auditExports: Map<string, Readonly<PendingAuditExportV1>>;
  readonly workloadProfileOperations: Map<string, StoredProfilePreparation>;
  readonly workloadProfileCapacities: Map<string, ProfileCapacity>;
  readonly workloadProfileAdmissions: Map<string, WorkloadProfileAdmissionHeadV2>;
  readonly workloadProfileHistory: Map<string, WorkloadProfileAdmissionHistoryV2>;
  readonly workloadProfileInvalidations: Map<string, WorkloadProfileInvalidationV2>;
  readonly channelInstallations: Map<string, Readonly<ChannelInstallation>>;
  readonly channelHumans: Map<string, Readonly<ChannelHumanBinding>>;
  readonly channelAgents: Map<string, Readonly<ChannelAgentBinding>>;
  readonly runtimeIntents: Map<string, Readonly<RuntimeIntent>>;
  readonly runtimeHeads: Map<string, string>;
  readonly runtimeAllocations: Map<string, Readonly<RuntimeAllocation>>;
  readonly runtimeAdmissions: Map<
    string,
    Readonly<
      RevisionRuntimeAdmission & {
        readonly deploy?: Readonly<{
          command: LifecycleDeployCommandV2;
          actorId: string;
          canonical: string;
        }>;
      }
    >
  >;
  readonly runtimeAuthorityOperations: Map<string, StoredRuntimeAuthorityOperation>;
  readonly runtimePreparationOperations: Map<string, StoredRuntimePreparationOperation>;
  readonly runtimeServiceTrustRecords: Map<string, Readonly<RuntimeServiceTrustRecord>>;
  installation: Readonly<Installation> | undefined;
  readonly namespaces: Map<string, Readonly<PersistedNamespace>>;
  readonly configurations: Map<string, Readonly<ConfigurationOwnership>>;
  readonly secrets: Map<string, Readonly<Secret>>;
  readonly serviceAccounts: Map<string, Readonly<ServiceAccount>>;
  readonly agents: Map<string, Readonly<Agent>>;
  readonly revisions: Map<string, readonly Readonly<AgentRevision>[]>;
  readonly audit: Readonly<AuditEvent>[];
  readonly operations: StoredPlatformWork[];
}

function agentKey(namespaceId: string, agentId: string): string {
  return `${namespaceId}\u0000${agentId}`;
}

function cloneSnapshot(snapshot: PlatformSnapshot): PlatformSnapshot {
  return {
    turnJournal: cloneMemoryTurnJournalSnapshot(snapshot.turnJournal),
    lifecycleAdmissions: new Map(snapshot.lifecycleAdmissions),
    cleanupResponsibilities: new Map(snapshot.cleanupResponsibilities),
    auditExports: new Map(snapshot.auditExports),
    channelInstallations: new Map(snapshot.channelInstallations),
    channelHumans: new Map(snapshot.channelHumans),
    channelAgents: new Map(snapshot.channelAgents),
    runtimeIntents: new Map(snapshot.runtimeIntents),
    runtimeHeads: new Map(snapshot.runtimeHeads),
    runtimeAllocations: new Map(snapshot.runtimeAllocations),
    runtimeAdmissions: new Map(snapshot.runtimeAdmissions),
    runtimeAuthorityOperations: new Map(snapshot.runtimeAuthorityOperations),
    runtimePreparationOperations: new Map(snapshot.runtimePreparationOperations),
    workloadProfileOperations: new Map(snapshot.workloadProfileOperations),
    workloadProfileCapacities: new Map(snapshot.workloadProfileCapacities),
    workloadProfileAdmissions: new Map(snapshot.workloadProfileAdmissions),
    workloadProfileHistory: new Map(snapshot.workloadProfileHistory),
    workloadProfileInvalidations: new Map(snapshot.workloadProfileInvalidations),
    runtimeServiceTrustRecords: new Map(snapshot.runtimeServiceTrustRecords),
    installation:
      snapshot.installation === undefined ? undefined : immutableCopy(snapshot.installation),
    namespaces: new Map(
      Array.from(snapshot.namespaces, ([key, namespace]) => [key, immutableCopy(namespace)]),
    ),
    configurations: new Map(
      Array.from(snapshot.configurations, ([key, configuration]) => [
        key,
        immutableCopy(configuration),
      ]),
    ),
    secrets: new Map(Array.from(snapshot.secrets, ([key, secret]) => [key, immutableCopy(secret)])),
    serviceAccounts: new Map(
      Array.from(snapshot.serviceAccounts, ([key, account]) => [key, immutableCopy(account)]),
    ),
    agents: new Map(Array.from(snapshot.agents, ([key, agent]) => [key, immutableCopy(agent)])),
    revisions: new Map(
      Array.from(snapshot.revisions, ([key, revisions]) => [
        key,
        Object.freeze(revisions.map((revision) => immutableCopy(revision))),
      ]),
    ),
    audit: snapshot.audit.map((event) => immutableCopy(event)),
    operations: snapshot.operations.map((operation) => immutableCopy(operation)),
  };
}

function assertInitialized(snapshot: PlatformSnapshot): void {
  if (!snapshot.installation)
    throw new ScopeViolationError("The server-owned Installation has not been initialized.");
}

const secretIdentifier =
  /^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const namespaceIdentifier =
  /^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const kubernetesNamespaceName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

function normalizedSecretBindings(bindings?: SecretBindings): SecretBindings | undefined {
  if (bindings === undefined) return undefined;
  try {
    const normalized = normalizeSecretBindings(bindings);
    for (const { source } of Object.values(normalized)) {
      if (!namespaceIdentifier.test(source.namespaceId) || !secretIdentifier.test(source.id))
        throw new ScopeViolationError("Secret bindings must reference exact Secrets.");
    }
    return Object.keys(normalized).length === 0 ? undefined : immutableCopy(normalized);
  } catch (error) {
    if (error instanceof ScopeViolationError) throw error;
    throw new ScopeViolationError("Secret bindings are invalid.");
  }
}

function secretBindingRefs(
  bindings?: SecretBindings,
): readonly { namespaceId: string; id: string }[] {
  const normalized = normalizedSecretBindings(bindings);
  if (normalized === undefined) return [];
  return Object.freeze(
    Object.values(normalized).map(({ source }) => ({
      namespaceId: source.namespaceId,
      id: source.id,
    })),
  );
}

function secretBindingsReference(
  bindings: SecretBindings | undefined,
  namespaceId: string,
  secretId: string,
): boolean {
  return secretBindingRefs(bindings).some(
    (source) => source.namespaceId === namespaceId && source.id === secretId,
  );
}

async function assertSecretBindingsAvailable(
  secrets: SecretReadRepository,
  namespaceId: string,
  bindings: SecretBindings | undefined,
): Promise<void> {
  for (const source of secretBindingRefs(bindings)) {
    if (source.namespaceId !== namespaceId)
      throw new ScopeViolationError("Secret bindings cannot cross Namespace boundaries.");
    const secret = await secrets.findSecret(namespaceId, source.id);
    if (secret === undefined)
      throw new ScopeViolationError("Secret bindings reference unavailable Secret metadata.");
  }
}

async function assertConfigurationUsableByAgent(
  configurations: ConfigurationReadRepository,
  secrets: SecretReadRepository,
  namespaceId: string,
  configurationId: string,
): Promise<void> {
  const configuration = await configurations.findConfiguration(namespaceId, configurationId);
  if (configuration === undefined)
    throw new ScopeViolationError("The Agent references an unavailable Configuration.");
  await assertSecretBindingsAvailable(secrets, namespaceId, configuration.secretBindings);
}

function assertSecret(secret: Secret): void {
  if (
    !secretIdentifier.test(secret.id) ||
    !namespaceIdentifier.test(secret.namespaceId) ||
    typeof secret.name !== "string" ||
    secret.name.length < 1 ||
    secret.name.length > 200 ||
    secret.name !== secret.name.trim() ||
    /[\x00-\x1f\x7f]/.test(secret.name) ||
    typeof secret.driverId !== "string" ||
    secret.driverId.length < 1 ||
    secret.driverId.length > 200 ||
    secret.driverId !== secret.driverId.trim() ||
    /[\x00-\x1f\x7f]/.test(secret.driverId) ||
    secret.backendRef === null ||
    typeof secret.backendRef !== "object" ||
    Array.isArray(secret.backendRef) ||
    Object.keys(secret.backendRef).length !== 4 ||
    typeof secret.backendRef.namespaceName !== "string" ||
    secret.backendRef.namespaceName.length < 1 ||
    secret.backendRef.namespaceName.length > 63 ||
    !kubernetesNamespaceName.test(secret.backendRef.namespaceName) ||
    typeof secret.backendRef.name !== "string" ||
    secret.backendRef.name.length < 1 ||
    secret.backendRef.name.length > 253 ||
    !secretName.test(secret.backendRef.name) ||
    typeof secret.backendRef.key !== "string" ||
    secret.backendRef.key.length < 1 ||
    secret.backendRef.key.length > 253 ||
    !secretKey.test(secret.backendRef.key) ||
    secret.backendRef.key === "." ||
    secret.backendRef.key === ".." ||
    typeof secret.backendRef.uid !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(secret.backendRef.uid)
  )
    throw new ScopeViolationError("The Secret or backend reference is invalid.");
}

const runtimeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validRuntimeReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,200}$/.test(value);
}

function repositories(
  snapshot: PlatformSnapshot,
  transaction: RepositoryTransaction,
  authorityGuard = new RuntimeAuthorityTransactionGuard(),
  profilePhase = new WorkloadProfileUnitPhase(),
  lifecyclePhase = new LifecycleAdmissionUnitPhase(),
  journal?: Readonly<{
    options: MemoryTurnJournalOptions;
    participant: MemoryTurnJournalParticipant;
  }>,
): PlatformUnitOfWork {
  const installations: InstallationRepository = {
    findInstallation: async (installationId) =>
      snapshot.installation?.id === installationId
        ? immutableCopy(snapshot.installation)
        : undefined,
    getInstallation: async () =>
      snapshot.installation === undefined ? undefined : immutableCopy(snapshot.installation),
    createInstallation: async (installation) => {
      if (snapshot.installation !== undefined)
        throw new ResourceConflictError("An Installation has already been bootstrapped.");
      const saved = immutableCopy(installation);
      snapshot.installation = saved;
      return immutableCopy(saved);
    },
  };

  const namespaces = createMemoryNamespaceRepository({
    transaction,
    get scope() {
      if (!snapshot.installation)
        throw new ScopeViolationError("The server-owned Installation has not been initialized.");
      return { installationId: snapshot.installation.id };
    },
    snapshot: {
      get installation() {
        return snapshot.installation;
      },
      namespaces: snapshot.namespaces,
      agents: snapshot.agents,
      configurations: snapshot.configurations,
      serviceAccounts: snapshot.serviceAccounts,
      secrets: snapshot.secrets,
    },
  });

  const configurations = createMemoryConfigurationRepository({
    transaction,
    get scope() {
      if (!snapshot.installation)
        throw new ScopeViolationError("The server-owned Installation has not been initialized.");
      return { installationId: snapshot.installation.id };
    },
    snapshot: {
      get installation() {
        return snapshot.installation;
      },
      configurations: snapshot.configurations,
      namespaces: snapshot.namespaces,
      agents: snapshot.agents,
    },
    namespaces,
    configurationKey: agentKey,
    normalizedSecretBindings,
    assertCreateSecretBindingsAvailable: (namespaceId, bindings) =>
      assertSecretBindingsAvailable(
        {
          findSecret: async (namespaceId, secretId) => {
            const secret = snapshot.secrets.get(agentKey(namespaceId, secretId));
            return secret === undefined ? undefined : immutableCopy(secret);
          },
        },
        namespaceId,
        bindings,
      ),
    assertSecretBindingsAvailable: (namespaceId, bindings) =>
      assertSecretBindingsAvailable(secrets, namespaceId, bindings),
  });

  const secrets = createMemorySecretRepository({
    transaction,
    get scope() {
      if (!snapshot.installation)
        throw new ScopeViolationError("The server-owned Installation has not been initialized.");
      return { installationId: snapshot.installation.id };
    },
    snapshot: {
      get installation() {
        return snapshot.installation;
      },
      secrets: snapshot.secrets,
      namespaces: snapshot.namespaces,
      configurations: snapshot.configurations,
      agents: snapshot.agents,
      revisions: snapshot.revisions,
      get operations() {
        return legacyOperations(snapshot.operations);
      },
    },
    namespaces,
    resourceKey: agentKey,
    assertSecret,
    secretBindingsReference,
  });

  const serviceAccounts = createMemoryServiceAccountRepository({
    transaction,
    get scope() {
      if (!snapshot.installation)
        throw new ScopeViolationError("The server-owned Installation has not been initialized.");
      return { installationId: snapshot.installation.id };
    },
    snapshot: {
      get installation() {
        return snapshot.installation;
      },
      serviceAccounts: snapshot.serviceAccounts,
      namespaces: snapshot.namespaces,
      agents: snapshot.agents,
    },
    namespaces,
    resourceKey: agentKey,
    isServiceAccountIdentifier: (value) => serviceAccountIdentifier.test(value),
    validCredential,
  });

  const agents: AgentRepository = {
    findAgent: async (namespaceId, agentId) => {
      const namespace = snapshot.namespaces.get(namespaceId);
      if (namespace?.deletedAt !== undefined) return undefined;
      const agent = snapshot.agents.get(agentKey(namespaceId, agentId));
      return agent?.namespaceId === namespaceId ? immutableCopy(agent) : undefined;
    },
    listAgents: async (namespaceId) =>
      Object.freeze(
        snapshot.namespaces.get(namespaceId)?.deletedAt === undefined
          ? Array.from(snapshot.agents.values())
              .filter((agent) => agent.namespaceId === namespaceId)
              .map((agent) => immutableCopy(agent))
          : [],
      ),
    createAgent: async (agent) => {
      agent = immutableCopy(agent);
      assertMaximumExecutionMs(agent.maximumExecutionMs);
      const selection =
        agent.workloadProfileSelection === undefined
          ? undefined
          : decodeWorkloadProfileSelectionV1(agent.workloadProfileSelection);
      if (selection?.kind === "invalid")
        throw new ScopeViolationError("The Agent workload selection is invalid.");
      assertInitialized(snapshot);
      if (agent.executionMode !== "embedded" && agent.executionMode !== "dedicated")
        throw new ScopeViolationError("The Agent execution mode is invalid.");
      if (
        agent.providerId !== null &&
        (typeof agent.providerId !== "string" || !providerIdentifier.test(agent.providerId))
      )
        throw new ScopeViolationError("The Agent Provider identity is invalid.");
      const namespace = await namespaces.lockNamespace(agent.namespaceId);
      if (
        namespace === undefined ||
        (namespace.status !== "provisioning" && namespace.status !== "ready")
      )
        throw new ScopeViolationError("The Agent belongs to an unavailable Namespace.");
      await assertConfigurationUsableByAgent(
        configurations,
        secrets,
        agent.namespaceId,
        agent.configurationId,
      );
      if (
        agent.serviceAccountId !== undefined &&
        (await serviceAccounts.findServiceAccount(agent.namespaceId, agent.serviceAccountId)) ===
          undefined
      )
        throw new ScopeViolationError("The Agent references an unavailable ServiceAccount.");
      const key = agentKey(agent.namespaceId, agent.id);
      if (snapshot.agents.has(key))
        throw new ResourceConflictError("The server generated an existing Agent identity.");
      if (
        Array.from(snapshot.agents.values()).some(
          (existing) => existing.namespaceId === agent.namespaceId && existing.name === agent.name,
        )
      )
        throw new ResourceConflictError("An Agent with this name already exists in the Namespace.");
      if (
        Array.from(snapshot.agents.values()).some(
          (existing) => existing.servicePrincipalId === agent.servicePrincipalId,
        )
      )
        throw new ResourceConflictError(
          "An Agent service principal already belongs to another Agent.",
        );
      const saved = immutableCopy(agent);
      snapshot.agents.set(key, saved);
      return immutableCopy(saved);
    },
    lockAgent: async (namespaceId, agentId) => agents.findAgent(namespaceId, agentId),
    updateConfiguration: async (
      namespaceId,
      agentId,
      configurationId,
      executionMode,
      serviceAccountId,
      providerId,
      workloadProfileSelection,
      maximumExecutionMs,
    ) => {
      if (maximumExecutionMs !== undefined) assertMaximumExecutionMs(maximumExecutionMs);
      const selection =
        workloadProfileSelection === undefined
          ? undefined
          : decodeWorkloadProfileSelectionV1(workloadProfileSelection);
      if (selection?.kind === "invalid")
        throw new ScopeViolationError("The Agent workload selection is invalid.");
      const current = await agents.findAgent(namespaceId, agentId);
      if (!current) return undefined;
      if (providerId !== undefined && providerId !== null && !providerIdentifier.test(providerId))
        throw new ScopeViolationError("The Agent Provider identity is invalid.");
      if (
        executionMode !== undefined &&
        executionMode !== "embedded" &&
        executionMode !== "dedicated"
      )
        throw new ScopeViolationError("The Agent execution mode is invalid.");
      if ((await configurations.findConfiguration(namespaceId, configurationId)) === undefined)
        throw new ScopeViolationError("The Agent references an unavailable Configuration.");
      await assertConfigurationUsableByAgent(configurations, secrets, namespaceId, configurationId);
      if (
        serviceAccountId !== undefined &&
        serviceAccountId !== null &&
        (await serviceAccounts.findServiceAccount(namespaceId, serviceAccountId)) === undefined
      )
        throw new ScopeViolationError("The Agent references an unavailable ServiceAccount.");
      const { serviceAccountId: previousAssociation, ...withoutAssociation } = current;
      const association =
        serviceAccountId === null ? undefined : (serviceAccountId ?? previousAssociation);
      const nextProviderId = providerId === undefined ? current.providerId : providerId;
      const updated = immutableCopy({
        ...withoutAssociation,
        configurationId,
        providerId: nextProviderId,
        executionMode: executionMode ?? current.executionMode,
        maximumExecutionMs:
          maximumExecutionMs === undefined ? current.maximumExecutionMs : maximumExecutionMs,
        ...(selection === undefined ? {} : { workloadProfileSelection: selection.value }),
        ...(association === undefined ? {} : { serviceAccountId: association }),
      });
      snapshot.agents.set(agentKey(namespaceId, agentId), updated);
      return immutableCopy(updated);
    },
    compareAndSetActiveRevision: async (
      namespaceId,
      agentId,
      expectedRevisionId,
      candidateRevisionId,
    ) => {
      const current = await agents.findAgent(namespaceId, agentId);
      if (!current || current.activeRevisionId !== expectedRevisionId) return undefined;
      const candidate = await revisions.findRevision(namespaceId, agentId, candidateRevisionId);
      if (!candidate)
        throw new ScopeViolationError("The active AgentRevision belongs to another Agent.");
      const updated = immutableCopy({ ...current, activeRevisionId: candidateRevisionId });
      snapshot.agents.set(agentKey(namespaceId, agentId), updated);
      return immutableCopy(updated);
    },
  };

  const revisions = createMemoryRevisionRepository({
    transaction,
    get scope() {
      if (!snapshot.installation)
        throw new ScopeViolationError("The server-owned Installation has not been initialized.");
      return { installationId: snapshot.installation.id };
    },
    snapshot: {
      get installation() {
        return snapshot.installation;
      },
      namespaces: snapshot.namespaces,
      revisions: snapshot.revisions,
      workloadProfileAdmissions: snapshot.workloadProfileAdmissions,
    },
    agents,
    revisionKey: agentKey,
    assertInitialized: () => assertInitialized(snapshot),
    assertAdmittedAgentRevision,
    normalizedSecretBindings,
    assertSecretBindingsAvailable: (namespaceId, bindings) =>
      assertSecretBindingsAvailable(secrets, namespaceId, bindings),
  });

  const runtimeOwner = async (scope: RuntimeScope, writing = false) => {
    const namespace = await namespaces.findNamespace(scope.namespaceId);
    const agent = await agents.findAgent(scope.namespaceId, scope.agentId);
    if (
      snapshot.installation === undefined ||
      namespace === undefined ||
      agent === undefined ||
      (writing && namespace.status !== "ready")
    )
      return undefined;
    return agent;
  };
  const channelBindings = createMemoryChannelBindingRepository({
    transaction,
    get scope() {
      if (!snapshot.installation)
        throw new ScopeViolationError("The server-owned Installation has not been initialized.");
      return { installationId: snapshot.installation.id };
    },
    snapshot: {
      get installation() {
        return snapshot.installation;
      },
      channelInstallations: snapshot.channelInstallations,
      channelHumans: snapshot.channelHumans,
      channelAgents: snapshot.channelAgents,
      namespaces: snapshot.namespaces,
      agents: snapshot.agents,
    },
  });

  const runtimeAssignments: RuntimeAssignmentRepository = {
    findRuntimeIntent: async (scope, transitionRef) => {
      if (!(await runtimeOwner(scope))) return undefined;
      const intent = snapshot.runtimeIntents.get(transitionRef);
      return intent?.namespaceId === scope.namespaceId && intent.agentId === scope.agentId
        ? immutableCopy(intent)
        : undefined;
    },
    findRuntimeIntentHead: async (scope) => {
      const ref = snapshot.runtimeHeads.get(agentKey(scope.namespaceId, scope.agentId));
      return ref === undefined ? undefined : runtimeAssignments.findRuntimeIntent(scope, ref);
    },
    findRuntimeAllocation: async (scope, locator) => {
      if (!(await runtimeOwner(scope))) return undefined;
      const allocation =
        locator.assignmentRef !== undefined
          ? snapshot.runtimeAllocations.get(locator.assignmentRef)
          : Array.from(snapshot.runtimeAllocations.values()).find(
              (item) => item.createEffectRef === locator.createEffectRef,
            );
      return allocation?.namespaceId === scope.namespaceId && allocation.agentId === scope.agentId
        ? immutableCopy(allocation)
        : undefined;
    },
    initializeRuntimeIntent: async (scope, revisionId, transitionRef, attribution) =>
      saveIntent(scope, 0, { desiredMode: "running", revisionId }, transitionRef, attribution),
    advanceRuntimeIntent: async (scope, expectedGeneration, next, transitionRef, attribution) => {
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
        throw new ResourceConflictError("The runtime intent generation is invalid.");
      return saveIntent(scope, expectedGeneration, next, transitionRef, attribution);
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
      const agent = await runtimeOwner(scope, true);
      if (agent === undefined) throw new ScopeViolationError("The runtime owner is unavailable.");
      const existing = Array.from(snapshot.runtimeAllocations.values()).find(
        (item) => item.createEffectRef === createEffectRef,
      );
      if (existing !== undefined) {
        if (
          existing.namespaceId !== scope.namespaceId ||
          existing.agentId !== scope.agentId ||
          existing.lifecycleGeneration !== expectedLifecycleGeneration ||
          existing.component !== component ||
          existing.runtimeGeneration !== expectedRuntimeGeneration + 1 ||
          existing.providerProfileRef !== profileRefs.providerProfileRef ||
          existing.runtimeProfileRef !== profileRefs.runtimeProfileRef ||
          existing.identityProfileRef !== profileRefs.identityProfileRef
        )
          throw new ResourceConflictError(
            "The runtime create effect conflicts with its stored allocation.",
          );
        return immutableCopy(existing);
      }
      const head = await runtimeAssignments.findRuntimeIntentHead(scope);
      if (
        head === undefined ||
        head.generation !== expectedLifecycleGeneration ||
        head.desiredMode !== "running"
      )
        throw new ResourceConflictError("The running runtime intent does not match.");
      const prior = Array.from(snapshot.runtimeAllocations.values())
        .filter(
          (item) =>
            item.namespaceId === scope.namespaceId &&
            item.agentId === scope.agentId &&
            item.component === component,
        )
        .reduce((value, item) => Math.max(value, item.runtimeGeneration), 0);
      if (prior !== expectedRuntimeGeneration || !Number.isSafeInteger(prior + 1))
        throw new ResourceConflictError("The runtime allocation generation does not match.");
      if (
        !runtimeUuid.test(createEffectRef) ||
        !["gateway", "harness"].includes(component) ||
        !Object.values(profileRefs).every(validRuntimeReference) ||
        Object.keys(profileRefs).sort().join(",") !==
          "identityProfileRef,providerProfileRef,runtimeProfileRef"
      )
        throw new ScopeViolationError("The runtime allocation references are invalid.");
      const allocation: RuntimeAllocation = immutableCopy({
        namespaceId: scope.namespaceId,
        agentId: scope.agentId,
        ...profileRefs,
        assignmentRef: randomUUID(),
        createEffectRef,
        installationId: snapshot.installation!.id,
        revisionId: head.revisionId,
        servicePrincipalId: agent.servicePrincipalId,
        lifecycleGeneration: head.generation,
        component,
        runtimeGeneration: prior + 1,
        bindingCondition: "unbound",
        createdAt: new Date().toISOString(),
      });
      snapshot.runtimeAllocations.set(allocation.assignmentRef, allocation);
      return immutableCopy(allocation);
    },
  };
  async function saveIntent(
    scope: RuntimeScope,
    expected: number,
    next: { readonly desiredMode: "running" | "disabled" | "stopped"; readonly revisionId: string },
    transitionRef: string,
    attribution: RuntimeIntentAttribution,
  ): Promise<Readonly<RuntimeIntent>> {
    if (
      !(await runtimeOwner(scope, true)) ||
      !(await revisions.findRevision(scope.namespaceId, scope.agentId, next.revisionId))
    )
      throw new ScopeViolationError("The runtime owner or revision is unavailable.");
    const key = agentKey(scope.namespaceId, scope.agentId);
    const head = await runtimeAssignments.findRuntimeIntentHead(scope);
    if (head !== undefined && snapshot.lifecycleAdmissions.has(head.transitionRef))
      throw new ResourceConflictError("Legacy intent cannot supersede a protective admission.");
    if (
      (head?.generation ?? 0) !== expected ||
      !Number.isSafeInteger(expected + 1) ||
      snapshot.runtimeIntents.has(transitionRef)
    )
      throw new ResourceConflictError("The runtime intent transition conflicts.");
    if (
      !runtimeUuid.test(transitionRef) ||
      !["running", "disabled", "stopped"].includes(next.desiredMode) ||
      !validRuntimeReference(attribution.actorId) ||
      !validRuntimeReference(attribution.requestId)
    )
      throw new ScopeViolationError("The runtime intent references are invalid.");
    const intent: RuntimeIntent = immutableCopy({
      namespaceId: scope.namespaceId,
      agentId: scope.agentId,
      installationId: snapshot.installation!.id,
      transitionRef,
      generation: expected + 1,
      desiredMode: next.desiredMode,
      revisionId: next.revisionId,
      actorId: attribution.actorId,
      requestId: attribution.requestId,
      createdAt: new Date().toISOString(),
    });
    snapshot.runtimeIntents.set(transitionRef, intent);
    snapshot.runtimeHeads.set(key, transitionRef);
    return immutableCopy(intent);
  }

  const deployCommandLocks = new Map<string, string>();
  const deployScopeKey = (scope: RuntimeScope) =>
    JSON.stringify([scope.namespaceId, scope.agentId]);
  const runtimeAdmissions: RuntimeAdmissionRepository = {
    lockDeployCommand: async (scopeInput, operationRef) => {
      const scope = immutableCopy(scopeInput);
      assertInitialized(snapshot);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationRef)
      )
        throw new ScopeViolationError("The deployment operation identity is invalid.");
      const prior = deployCommandLocks.get(operationRef);
      if (prior !== undefined && prior !== deployScopeKey(scope))
        throw new ResourceConflictError("The deployment operation belongs to different operands.");
      // The original memory owner serializes whole working-snapshot transactions.
      deployCommandLocks.set(operationRef, deployScopeKey(scope));
    },
    findCommittedDeployCommand: async (scopeInput, commandInput, actorId) => {
      const scope = immutableCopy(scopeInput);
      const command = parseLifecycleDeployV2("command", commandInput);
      assertInitialized(snapshot);
      const installation = snapshot.installation!;
      if (typeof actorId !== "string" || !/^[A-Za-z0-9._:/-]{1,200}$/.test(actorId))
        throw new ScopeViolationError("The deployment actor is invalid.");
      const canonical = canonicalLifecycleDeployCommandV2(
        { installationId: installation.id, namespaceId: scope.namespaceId, agentId: scope.agentId },
        command,
      );
      const intent = snapshot.runtimeIntents.get(command.operationRef);
      const original = [...snapshot.runtimeAdmissions.values()].find(
        (item) => item.runtimeTransitionRef === command.operationRef,
      );
      if (intent === undefined && original === undefined) return undefined;
      if (
        original?.deploy === undefined ||
        intent === undefined ||
        intent.actorId !== actorId ||
        original.deploy.actorId !== actorId ||
        original.deploy.canonical !== canonical ||
        canonicalLifecycleDeployCommandV2(
          {
            installationId: installation.id,
            namespaceId: scope.namespaceId,
            agentId: scope.agentId,
          },
          original.deploy.command,
        ) !== canonical
      )
        throw new ResourceConflictError("The deployment operation conflicts with retained state.");
      const revision = await runtimeAdmissions.findCommittedAdmission(scope, command.operationRef, {
        actorId,
        requestId: intent.requestId,
      });
      if (revision === undefined)
        throw new DependencyUnavailableError("The original deployment admission is incomplete.");
      return revision;
    },
    findRevisionAdmission: async (scope, revisionId) => {
      if (!(await runtimeOwner(scope))) return undefined;
      const admission = snapshot.runtimeAdmissions.get(revisionId);
      return admission?.namespaceId === scope.namespaceId && admission.agentId === scope.agentId
        ? immutableCopy({
            namespaceId: admission.namespaceId,
            agentId: admission.agentId,
            revisionId: admission.revisionId,
            runtimeTransitionRef: admission.runtimeTransitionRef,
            lifecycleGeneration: admission.lifecycleGeneration,
            auditEventId: admission.auditEventId,
          })
        : undefined;
    },
    findCommittedAdmission: async (scope, transitionRef, attribution) => {
      const intent = await runtimeAssignments.findRuntimeIntent(scope, transitionRef);
      if (
        intent === undefined ||
        intent.desiredMode !== "running" ||
        intent.actorId !== attribution.actorId ||
        intent.requestId !== attribution.requestId
      )
        return undefined;
      const admission = await runtimeAdmissions.findRevisionAdmission(scope, intent.revisionId);
      if (
        admission === undefined ||
        admission.runtimeTransitionRef !== transitionRef ||
        admission.lifecycleGeneration !== intent.generation
      )
        return undefined;
      const revision = await revisions.findRevision(
        scope.namespaceId,
        scope.agentId,
        intent.revisionId,
      );
      const agent = await agents.findAgent(scope.namespaceId, scope.agentId);
      const operation = legacyOperations(snapshot.operations).find(
        (item) =>
          item.kind === "agent_revision" &&
          item.resourceId === intent.revisionId &&
          item.action === "reconcile",
      );
      const audit = snapshot.audit.find((item) => item.id === admission.auditEventId);
      if (
        revision === undefined ||
        agent === undefined ||
        revision.servicePrincipalId !== agent.servicePrincipalId ||
        operation?.namespaceId !== scope.namespaceId ||
        operation.actorId !== intent.actorId ||
        operation.runtimeTransitionRef !== transitionRef ||
        operation.lifecycleGeneration !== intent.generation ||
        audit === undefined ||
        !isRuntimeAdmissionAudit(audit, intent)
      )
        return undefined;
      return immutableCopy(revision);
    },
    recordAdmission: async (admissionInput, deployInput) => {
      const admission = immutableCopy(admissionInput);
      const deploy = deployInput === undefined ? undefined : immutableCopy(deployInput);
      const command =
        deploy === undefined ? undefined : parseLifecycleDeployV2("command", deploy.command);
      assertInitialized(snapshot);
      const installation = snapshot.installation!;
      if (
        deploy !== undefined &&
        (command!.operationRef !== admission.runtimeTransitionRef ||
          deployCommandLocks.get(command!.operationRef) !== deployScopeKey(admission) ||
          typeof deploy.actorId !== "string" ||
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
      const intent = await runtimeAssignments.findRuntimeIntent(
        admission,
        admission.runtimeTransitionRef,
      );
      const audit = snapshot.audit.find((event) => event.id === admission.auditEventId);
      if (
        intent === undefined ||
        intent.desiredMode !== "running" ||
        (deploy !== undefined && deploy.actorId !== intent.actorId) ||
        intent.revisionId !== admission.revisionId ||
        intent.generation !== admission.lifecycleGeneration ||
        audit === undefined ||
        !isRuntimeAdmissionAudit(audit, intent)
      )
        throw new ScopeViolationError(
          "The revision admission does not match its exact intent and audit.",
        );
      if (command !== undefined) {
        const revision = await revisions.findRevision(
          admission.namespaceId,
          admission.agentId,
          admission.revisionId,
        );
        const use = revision?.workloadProfileUse;
        if (
          revision === undefined ||
          use === undefined ||
          revision.maximumExecutionMs === undefined
        )
          throw new ScopeViolationError(
            "The deployment command requires its original admitted workload Use.",
          );
        const expected = canonicalLifecycleDeployCommandV2(
          {
            installationId: installation.id,
            namespaceId: admission.namespaceId,
            agentId: admission.agentId,
          },
          {
            ...command,
            expectedLifecycleGeneration: intent.generation === 1 ? null : intent.generation - 1,
            expectedDraft: {
              configurationId: revision.configurationId,
              configurationGeneration: revision.configurationGeneration,
              providerId: revision.providerId,
              executionMode: revision.harness.mode,
              maximumExecutionMs: revision.maximumExecutionMs,
              serviceAccountId: revision.serviceAccount?.id ?? null,
              workloadProfileSelection: {
                manifestRef: use.manifestRef,
                manifestDigest: use.manifestDigest,
                admissionRef: use.admissionRef,
                admissionVersion: use.admissionVersion,
              },
            },
          },
        );
        if (canonical !== expected)
          throw new ScopeViolationError(
            "The deployment command does not match its exact revision and intent.",
          );
      }
      if (
        snapshot.runtimeAdmissions.has(admission.revisionId) ||
        [...snapshot.runtimeAdmissions.values()].some(
          (item) =>
            item.runtimeTransitionRef === admission.runtimeTransitionRef ||
            item.auditEventId === admission.auditEventId,
        )
      )
        throw new ResourceConflictError("The revision runtime admission is immutable.");
      snapshot.runtimeAdmissions.set(
        admission.revisionId,
        immutableCopy({
          ...admission,
          ...(deploy === undefined
            ? {}
            : { deploy: { command: command!, actorId: deploy.actorId, canonical: canonical! } }),
        }),
      );
    },
  };

  const runtimeAuthority = createRuntimeAuthorityRepository(
    {
      lockOperation: async () => {}, // Existing memory transaction already serializes all writers.
      allocation: async (scope, assignmentRef) => {
        if (snapshot.installation?.id !== scope.installationId) return undefined;
        const allocation = snapshot.runtimeAllocations.get(assignmentRef);
        return allocation?.namespaceId === scope.namespaceId && allocation.agentId === scope.agentId
          ? allocation
          : undefined;
      },
      operations: async (scope, assignmentRef) =>
        [...snapshot.runtimeAuthorityOperations.values()]
          .filter(
            ({ receipt }) =>
              receipt.installationId === scope.installationId &&
              receipt.namespaceId === scope.namespaceId &&
              receipt.agentId === scope.agentId &&
              receipt.assignmentRef.id === assignmentRef,
          )
          .sort((a, b) => a.receipt.assignmentRecordVersion - b.receipt.assignmentRecordVersion),
      operation: async (operationRef) => snapshot.runtimeAuthorityOperations.get(operationRef),
      insert: async (operation) => {
        if (snapshot.runtimeAuthorityOperations.has(operation.receipt.operationRef))
          throw new ResourceConflictError("The runtime authority operation already exists.");
        snapshot.runtimeAuthorityOperations.set(
          operation.receipt.operationRef,
          immutableCopy(operation),
        );
      },
    },
    runtimeAssignments,
    authorityGuard,
  );
  const profileContext = {
    transaction,
    get scope() {
      if (!snapshot.installation)
        throw new ScopeViolationError("The server-owned Installation has not been initialized.");
      return { installationId: snapshot.installation.id };
    },
    snapshot: {
      operations: snapshot.workloadProfileOperations,
      capacities: snapshot.workloadProfileCapacities,
      namespaces: snapshot.namespaces,
      admissions: snapshot.workloadProfileAdmissions,
      history: snapshot.workloadProfileHistory,
      invalidations: snapshot.workloadProfileInvalidations,
    },
  };
  const workloadProfiles = Object.freeze({
    ...createMemoryWorkloadProfile(profileContext, profilePhase.guard),
    ...createWorkloadProfileAdmissionRepositoryV2(
      createMemoryWorkloadProfileAdmissionBackendV2(
        profileContext,
        async (attribution, history) => {
          await audit.append(workloadProfileAdmissionAuditV2(attribution, history));
        },
      ),
      profilePhase.guard,
    ),
  });
  const runtimePreparation = createMemoryRuntimePreparation(
    {
      transaction,
      get scope() {
        if (!snapshot.installation)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: snapshot.installation.id };
      },
      snapshot: {
        operations: snapshot.runtimePreparationOperations,
        allocations: snapshot.runtimeAllocations,
      },
    },
    runtimeAssignments,
    runtimeAdmissions,
    runtimeAuthority,
    authorityGuard,
  );
  const audit: PlatformAuditRepository = {
    async append(event) {
      if (event.installationId !== snapshot.installation?.id)
        throw new ScopeViolationError("The audit event belongs to another Installation.");
      if (event.resource.namespaceId !== event.namespaceId)
        throw new ScopeViolationError("The audit event belongs to another Namespace.");
      if (snapshot.audit.some((existing) => existing.id === event.id))
        throw new ResourceConflictError("The audit event identity already exists.");
      snapshot.audit.push(immutableCopy(event));
    },
    list: async () => Object.freeze(snapshot.audit.map((event) => immutableCopy(event))),
  };
  const runtimeServiceTrust = createRuntimeServiceTrustRepository(
    {
      lockOperation: async () => {},
      lockSubject: async () => {},
      operation: async (operationRef) => snapshot.runtimeServiceTrustRecords.get(operationRef),
      latest: async (installationId, kind, subjectRef) =>
        [...snapshot.runtimeServiceTrustRecords.values()]
          .filter(
            (record) =>
              record.installationId === installationId &&
              record.subjectKind === kind &&
              record.subjectRef === subjectRef,
          )
          .sort((a, b) => b.recordVersion - a.recordVersion)[0],
      insert: async (value, event) => {
        const record = parseRuntimeServiceTrustRecord(value);
        if (
          snapshot.runtimeServiceTrustRecords.has(record.operationRef) ||
          !runtimeServiceTrustAuditMatches(record, event)
        )
          throw new ResourceConflictError("The service trust admission conflicts.");
        await audit.append(event);
        snapshot.runtimeServiceTrustRecords.set(record.operationRef, immutableCopy(record));
      },
    },
    { installations, agents, namespaces },
    authorityGuard,
  );

  const lifecycleAdmissions = createMemoryLifecycleAdmission({
    transaction,
    phase: lifecyclePhase,
    snapshot,
    get scope() {
      if (!snapshot.installation)
        throw new ScopeViolationError("The server-owned Installation has not been initialized.");
      return { installationId: snapshot.installation.id };
    },
    resourceKey: agentKey,
    appendAudit: (event) => audit.append(event),
  });
  const turnJournal =
    journal === undefined
      ? undefined
      : createMemoryTurnJournal(
          {
            snapshot: snapshot.turnJournal,
            participant: journal.participant,
            transaction,
            get scope() {
              transaction.assertActive();
              if (!snapshot.installation)
                throw new ScopeViolationError(
                  "The server-owned Installation has not been initialized.",
                );
              return { installationId: snapshot.installation.id };
            },
            currentInstallation: async () => {
              transaction.assertActive();
              const installation = await installations.getInstallation();
              transaction.assertActive();
              return installation;
            },
            agentExists: async (key) => {
              transaction.assertActive();
              return (
                snapshot.installation?.id === key.installationRef &&
                snapshot.agents.has(agentKey(key.namespaceRef, key.agentRef))
              );
            },
            channelExists: async (installation, channel) => {
              transaction.assertActive();
              return (
                snapshot.installation?.id === installation &&
                snapshot.channelInstallations.get(channel)?.installationId === installation
              );
            },
          },
          journal.options,
        );
  return {
    ...(turnJournal === undefined ? {} : { turnJournal }),
    lifecycleAdmissions,
    workloadProfiles,
    runtimePreparation,
    runtimeServiceTrust,
    runtimeAuthority,
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
        assertInitialized(snapshot);
        if (operation.kind !== "namespace" && operation.kind !== "agent_revision")
          throw new ScopeViolationError("The platform operation has an unsupported resource kind.");
        const hasTransition = operation.runtimeTransitionRef !== undefined;
        const hasGeneration = operation.lifecycleGeneration !== undefined;
        if (
          hasTransition !== hasGeneration ||
          (hasTransition &&
            (!runtimeUuid.test(operation.runtimeTransitionRef!) ||
              !Number.isSafeInteger(operation.lifecycleGeneration) ||
              operation.lifecycleGeneration! < 1)) ||
          (operation.kind === "namespace" && hasTransition)
        )
          throw new ScopeViolationError(
            "Controller work requires an exact paired runtime admission.",
          );
        if (
          operation.kind === "namespace" &&
          (operation.namespaceId !== operation.resourceId ||
            (operation.target !== "ready" && operation.target !== "deleted"))
        )
          throw new ScopeViolationError(
            "Namespace work does not match its exact lifecycle target.",
          );
        const duplicate = legacyOperations(snapshot.operations).find(
          (existing) =>
            existing.kind === operation.kind &&
            existing.resourceId === operation.resourceId &&
            existing.action === operation.action &&
            (existing.kind !== "namespace" ||
              (operation.kind === "namespace" && existing.target === operation.target)),
        );
        if (duplicate !== undefined) {
          if (
            duplicate.actorId !== operation.actorId ||
            duplicate.namespaceId !== operation.namespaceId ||
            duplicate.runtimeTransitionRef !== operation.runtimeTransitionRef ||
            duplicate.lifecycleGeneration !== operation.lifecycleGeneration
          )
            throw new ResourceConflictError(
              "The platform operation already belongs to another owner or actor.",
            );
          return;
        }
        if (operation.kind === "agent_revision") {
          const admission = snapshot.runtimeAdmissions.get(operation.resourceId);
          if (hasTransition || admission !== undefined) {
            const intent =
              admission === undefined
                ? undefined
                : snapshot.runtimeIntents.get(admission.runtimeTransitionRef);
            if (
              admission === undefined ||
              admission.namespaceId !== operation.namespaceId ||
              admission.runtimeTransitionRef !== operation.runtimeTransitionRef ||
              admission.lifecycleGeneration !== operation.lifecycleGeneration ||
              intent?.actorId !== operation.actorId
            )
              throw new ScopeViolationError(
                "Controller work does not match its exact revision admission.",
              );
          }
        }
        const workId = `${operation.kind}:${operation.resourceId}:${operation.action}${operation.kind === "namespace" ? `:${operation.target}` : ""}`;
        if (
          snapshot.operations.some(
            (entry) => entry.version === 1 && entry.work.input.workId === workId,
          )
        )
          throw new ResourceConflictError("Controller work already belongs to another protocol.");
        snapshot.operations.push(immutableCopy({ version: 0, operation }));
      },
      list: async () =>
        Object.freeze(
          legacyOperations(snapshot.operations).map((operation) => immutableCopy(operation)),
        ),
    },
  };
}

/** Process-local, single-writer state. No restart or multi-process durability. */
export class InMemoryPlatformState implements PlatformStateStore {
  private snapshot: PlatformSnapshot = {
    turnJournal: createMemoryTurnJournalSnapshot(),
    lifecycleAdmissions: new Map(),
    cleanupResponsibilities: new Map(),
    auditExports: new Map(),
    channelInstallations: new Map(),
    channelHumans: new Map(),
    channelAgents: new Map(),
    runtimeIntents: new Map(),
    runtimeHeads: new Map(),
    runtimeAllocations: new Map(),
    runtimeAdmissions: new Map(),
    runtimeAuthorityOperations: new Map(),
    runtimePreparationOperations: new Map(),
    workloadProfileOperations: new Map(),
    workloadProfileCapacities: new Map(),
    workloadProfileAdmissions: new Map(),
    workloadProfileHistory: new Map(),
    workloadProfileInvalidations: new Map(),
    runtimeServiceTrustRecords: new Map(),
    installation: undefined,
    namespaces: new Map(),
    configurations: new Map(),
    secrets: new Map(),
    serviceAccounts: new Map(),
    agents: new Map(),
    revisions: new Map(),
    audit: [],
    operations: [],
  };
  private pending: Promise<void> = Promise.resolve();
  private readonly auditSink: PlatformAuditSink | undefined;
  private readonly turnJournal: MemoryTurnJournalOptions | undefined;

  constructor(options: InMemoryPlatformStateOptions = {}) {
    this.auditSink = options.auditSink;
    this.turnJournal =
      options.turnJournal === undefined
        ? undefined
        : retainMemoryTurnJournalOptions(options.turnJournal);
  }

  private journalParticipant() {
    return this.turnJournal === undefined
      ? undefined
      : {
          options: this.turnJournal,
          participant: new MemoryTurnJournalParticipant(this.turnJournal.clock),
        };
  }

  pendingOperations(): readonly Readonly<PlatformOperation>[] {
    return Object.freeze(
      legacyOperations(this.snapshot.operations).map((operation) => immutableCopy(operation)),
    );
  }

  async read<T>(
    work: (state: PlatformReadView) => Promise<T>,
    options?: PlatformReadOptions,
  ): Promise<T> {
    const lifetime = new RepositoryTransactionLifetime();
    const journal = this.journalParticipant();
    let cancel: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    try {
      if (options === undefined) {
        await this.pending;
        return await work(
          createPlatformReadView(
            repositories(
              cloneSnapshot(this.snapshot),
              lifetime,
              undefined,
              undefined,
              undefined,
              journal,
            ),
            lifetime,
          ),
        );
      }
      if (
        options.signal.aborted ||
        !Number.isFinite(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        options.timeoutMs > 3000
      )
        throw new DependencyUnavailableError("The platform read expired.");
      signal = AbortSignal.any([options.signal, AbortSignal.timeout(Math.ceil(options.timeoutMs))]);
      const boundedSignal = signal;
      return await Promise.race([
        (async () => {
          await this.pending;
          if (boundedSignal.aborted) throw new DependencyUnavailableError();
          const result = await work(
            createPlatformReadView(
              repositories(
                cloneSnapshot(this.snapshot),
                lifetime,
                undefined,
                undefined,
                undefined,
                journal,
              ),
              lifetime,
            ),
          );
          if (boundedSignal.aborted) throw new DependencyUnavailableError();
          return result;
        })(),
        new Promise<never>((_resolve, reject) => {
          cancel = () => {
            lifetime.close();
            reject(new DependencyUnavailableError("The platform read expired."));
          };
          boundedSignal.addEventListener("abort", cancel, { once: true });
        }),
      ]);
    } finally {
      if (cancel) signal?.removeEventListener("abort", cancel);
      try {
        await lifetime.finish();
      } finally {
        journal?.participant.guard.close();
      }
    }
  }

  async transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release: (() => void) | undefined;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorityGuard = new RuntimeAuthorityTransactionGuard();
    const profilePhase = new WorkloadProfileUnitPhase();
    const lifecyclePhase = new LifecycleAdmissionUnitPhase();
    const lifetime = new RepositoryTransactionLifetime();
    const journal = this.journalParticipant();
    // Observe poison immediately while the existing lifetime drains all accepted
    // operations. A rejected unawaited mutation must never become an unhandled
    // rejection or allow publication.
    const finishJournal = () =>
      journal === undefined
        ? Promise.resolve({ ok: true as const })
        : journal.participant.guard.finish().then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
    try {
      await previous;
      const working = cloneSnapshot(this.snapshot);
      const committedAuditCount = working.audit.length;
      const unit = bindPlatformUnitOfWork(
        repositories(working, lifetime, authorityGuard, profilePhase, lifecyclePhase, journal),
        lifetime,
        profilePhase,
        lifecyclePhase,
      );
      journal?.participant.guard.bind(unit);
      const result = await work(unit);
      const journalFinished = finishJournal();
      lifecyclePhase.closeAdmissions();
      await lifetime.finish();
      const journalResult = await journalFinished;
      if (!journalResult.ok) throw journalResult.error;
      await lifecyclePhase.finish();
      await authorityGuard.finish();
      await profilePhase.guard.finish();
      await this.publishAudit(
        working.audit
          .slice(committedAuditCount)
          .filter((event) => !working.auditExports.has(event.id)),
      );
      profilePhase.guard.assertCurrent();
      journal?.participant.assertCurrent();
      if (journal)
        assertMemoryTurnJournalSnapshot(working.turnJournal, {
          installationId: working.installation?.id,
          hasAgent: (key) => working.agents.has(agentKey(key.namespaceRef, key.agentRef)),
          hasChannel: (channel) =>
            working.channelInstallations.get(channel)?.installationId === working.installation?.id,
        });
      this.snapshot = working;
      // Process-local publication and confirmation are one synchronous owner
      // step, with no user callback or fallible external operation in between.
      journal?.participant.guard.confirmCommitted();
      return result;
    } catch (error) {
      const journalFinished = finishJournal();
      lifecyclePhase.closeAdmissions();
      await lifetime.finish();
      await journalFinished;
      try {
        await lifecyclePhase.finish();
      } catch {
        /* Preserve the original failure. */
      }
      // Drain already-started authority writes before discarding the private snapshot.
      try {
        await authorityGuard.finish();
      } catch {
        /* Preserve the original failure. */
      }
      try {
        await profilePhase.guard.finish();
      } catch {
        /* Preserve the original failure. */
      }
      throw error;
    } finally {
      lifecyclePhase.closeAdmissions();
      lifetime.close();
      journal?.participant.guard.close();
      release?.();
    }
  }

  private async publishAudit(events: readonly Readonly<AuditEvent>[]): Promise<void> {
    if (!this.auditSink || events.length === 0) return;

    if (typeof this.auditSink.beginTransaction === "function") {
      let transaction: TransactionalAuditWriter | undefined;
      try {
        transaction = this.auditSink.beginTransaction();
        for (const event of events) await transaction.append(event);
        await transaction.commit();
      } catch {
        try {
          await transaction?.rollback();
        } catch {
          // The platform state still remains unpublished when rollback fails.
        }
        throw new DependencyUnavailableError("The platform audit repository is unavailable.");
      }
      return;
    }

    let checkpoint: number | undefined;
    try {
      checkpoint = this.auditSink.checkpoint?.();
      for (const event of events) await this.auditSink.append(event);
    } catch {
      try {
        if (checkpoint !== undefined) this.auditSink.restore?.(checkpoint);
      } catch {
        // An external sink failure still cannot publish the platform snapshot.
      }
      throw new DependencyUnavailableError("The platform audit repository is unavailable.");
    }
  }
}

/** Deterministic conversion of the original reserved audit UUID. Authentication
 * remains with the admitting owner; this serializer only preserves attribution. */
export function workloadProfileAdmissionAuditV2(
  attribution: WorkloadProfileAdmissionAttributionV2,
  input: WorkloadProfileAdmissionHistoryV2,
): AuditEvent {
  const history = decodeWorkloadProfileAdmissionHistoryV2(input);
  const head = history.head;
  const retained = head.state === "admitted" ? head.acceptance : head.withdrawal;
  if (
    attribution.actor.accountRef !== retained.actor.accountRef ||
    attribution.actor.principalRef !== retained.actor.principalRef ||
    attribution.operationRef !== retained.operationRef ||
    attribution.requestRef !== retained.requestRef ||
    attribution.decisionRef !== retained.decisionRef
  )
    throw new ScopeViolationError(
      "The profile audit attribution differs from its original history.",
    );
  return immutableCopy({
    id: `aud_${head.state === "admitted" ? head.acceptance.auditRef : head.terminal.auditRef}`,
    installationId: head.scope.installationId,
    namespaceId: head.scope.namespaceId,
    occurredAt: retained.acceptedAt,
    kind: "mutation",
    actorId: retained.actor.principalRef,
    schemaVersion: 1,
    source: "occ",
    requestId: retained.requestRef,
    admissionDecisionId: retained.decisionRef,
    action:
      head.state === "admitted"
        ? "openclaw.workload-profile.accept"
        : "openclaw.workload-profile.withdraw",
    resource: {
      kind: "namespace",
      id: head.scope.namespaceId,
      namespaceId: head.scope.namespaceId,
    },
    outcome: "success",
    details: {
      accountRef: retained.actor.accountRef,
      operationRef: retained.operationRef,
      historyRef: history.historyRef,
      admissionRef: head.selection.admissionRef,
      admissionVersion: head.selection.admissionVersion,
      manifestRef: head.selection.manifestRef,
      manifestDigest: head.selection.manifestDigest,
      ...(head.state === "withdrawn"
        ? { reason: head.withdrawal.reason, invalidationRef: head.terminal.invalidationRef }
        : {}),
    },
  });
}
