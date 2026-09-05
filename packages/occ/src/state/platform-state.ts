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
  ChannelBindingMetadata,
  ChannelBindingStatus,
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
import { isChannelBindingReference, normalizeSecretBindings } from "@openclaw-enterprise/contracts";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../errors.ts";

export interface InstallationReadRepository {
  findInstallation(installationId: string): Promise<Readonly<Installation> | undefined>;
  getInstallation(): Promise<Readonly<Installation> | undefined>;
}

export interface InstallationRepository extends InstallationReadRepository {
  createInstallation(installation: Installation): Promise<Readonly<Installation>>;
}

export interface NamespaceReadRepository {
  findNamespace(namespaceId: string): Promise<Readonly<Namespace> | undefined>;
  listNamespaces(): Promise<readonly Readonly<Namespace>[]>;
}

export interface PersistedNamespace extends Namespace {
  readonly deletedAt?: string;
}

export interface NamespaceRepository extends NamespaceReadRepository {
  createNamespace(namespace: Namespace): Promise<Readonly<Namespace>>;
  lockNamespace(
    namespaceId: string,
    options?: { readonly includeDeleted?: boolean },
  ): Promise<Readonly<PersistedNamespace> | undefined>;
  hasAgents(namespaceId: string): Promise<boolean>;
  hasConfigurations(namespaceId: string): Promise<boolean>;
  hasServiceAccounts(namespaceId: string): Promise<boolean>;
  hasSecrets(namespaceId: string): Promise<boolean>;
  transitionNamespaceStatus(
    namespaceId: string,
    expected: NamespaceStatus | readonly NamespaceStatus[],
    next: NamespaceStatus,
  ): Promise<Readonly<PersistedNamespace> | undefined>;
  markNamespaceDeleted(
    namespaceId: string,
    deletedAt: string,
  ): Promise<Readonly<PersistedNamespace> | undefined>;
}

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
  ): Promise<Readonly<Agent> | undefined>;
  compareAndSetActiveRevision(
    namespaceId: string,
    agentId: string,
    expectedRevisionId: string | undefined,
    candidateRevisionId: string,
  ): Promise<Readonly<Agent> | undefined>;
}

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

export interface ConfigurationOwnership {
  readonly id: string;
  readonly namespaceId: string;
  readonly kind: "agent";
  readonly generation: number;
  readonly secretBindings?: SecretBindings;
  readonly createdAt: string;
}

export interface ConfigurationReadRepository {
  findConfiguration(
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<ConfigurationOwnership> | undefined>;
}

export interface ConfigurationRepository extends ConfigurationReadRepository {
  createConfiguration(
    configuration: ConfigurationOwnership,
  ): Promise<Readonly<ConfigurationOwnership>>;
  lockConfiguration(
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<ConfigurationOwnership> | undefined>;
  advanceConfigurationGeneration(
    namespaceId: string,
    configurationId: string,
    expectedGeneration: number,
    secretBindings?: SecretBindings,
  ): Promise<Readonly<ConfigurationOwnership> | undefined>;
  deleteConfiguration(namespaceId: string, configurationId: string): Promise<boolean>;
}

export interface SecretReadRepository {
  findSecret(namespaceId: string, secretId: string): Promise<Readonly<Secret> | undefined>;
}

export interface SecretRepository extends SecretReadRepository {
  lockSecret(namespaceId: string, secretId: string): Promise<Readonly<Secret> | undefined>;
  createSecret(secret: Secret): Promise<Readonly<Secret>>;
  deleteSecret(namespaceId: string, secretId: string): Promise<boolean>;
  hasReferences(namespaceId: string, secretId: string): Promise<boolean>;
}

export interface ServiceAccountReadRepository {
  findServiceAccount(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount> | undefined>;
  listServiceAccounts(namespaceId: string): Promise<readonly Readonly<ServiceAccount>[]>;
  findServiceAccountProviderBinding(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<
    | Readonly<{
        readonly providerId: string;
        readonly driverId: string;
        readonly workspaceId: string;
        readonly credentialIssued: boolean;
      }>
    | undefined
  >;
}

export interface ServiceAccountRepository extends ServiceAccountReadRepository {
  createServiceAccount(account: ServiceAccount): Promise<Readonly<ServiceAccount>>;
  lockServiceAccount(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount> | undefined>;
  updateCredential(
    namespaceId: string,
    serviceAccountId: string,
    credential: ServiceAccountCredential,
  ): Promise<Readonly<ServiceAccount> | undefined>;
  deleteServiceAccount(namespaceId: string, serviceAccountId: string): Promise<boolean>;
}

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

function assertAdmittedAgentRevision(revision: AgentRevision): void {
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

export interface PlatformAuditRepository {
  append(event: AuditEvent): Promise<void>;
  list(): Promise<readonly Readonly<AuditEvent>[]>;
}

interface PlatformOperationBase {
  readonly action: "reconcile";
  readonly namespaceId: string;
  readonly resourceId: string;
  readonly actorId: string;
  readonly runtimeTransitionRef?: string;
  readonly lifecycleGeneration?: number;
}

export type PlatformOperation =
  | (PlatformOperationBase & {
      readonly kind: "namespace";
      readonly target: "ready" | "deleted";
    })
  | (PlatformOperationBase & {
      readonly kind: "agent_revision";
      readonly target?: never;
    });

export interface PlatformOperationRepository {
  append(operation: PlatformOperation): Promise<void>;
  list(): Promise<readonly Readonly<PlatformOperation>[]>;
}

export interface ChannelBindingListOptions {
  readonly afterId?: string;
  readonly limit: number;
}
export interface ChannelBindingReadRepository {
  findChannelInstallation(id: string): Promise<Readonly<ChannelInstallation> | undefined>;
  listChannelInstallations(
    options: ChannelBindingListOptions,
  ): Promise<readonly Readonly<ChannelInstallation>[]>;
  findHumanBinding(
    parentId: string,
    id: string,
  ): Promise<Readonly<ChannelHumanBinding> | undefined>;
  findHumanBindingBySubject(
    parentId: string,
    subject: string,
  ): Promise<Readonly<ChannelHumanBinding> | undefined>;
  listHumanBindings(
    parentId: string,
    options: ChannelBindingListOptions,
  ): Promise<readonly Readonly<ChannelHumanBinding>[]>;
  findAgentBinding(
    parentId: string,
    id: string,
  ): Promise<Readonly<ChannelAgentBinding> | undefined>;
  findAgentBindingByChannel(
    parentId: string,
    channelRef: string,
  ): Promise<Readonly<ChannelAgentBinding> | undefined>;
  listAgentBindings(
    parentId: string,
    options: ChannelBindingListOptions,
  ): Promise<readonly Readonly<ChannelAgentBinding>[]>;
}
export interface ChannelBindingRepository extends ChannelBindingReadRepository {
  createChannelInstallation(record: ChannelInstallation): Promise<Readonly<ChannelInstallation>>;
  createHumanBinding(record: ChannelHumanBinding): Promise<Readonly<ChannelHumanBinding>>;
  createAgentBinding(record: ChannelAgentBinding): Promise<Readonly<ChannelAgentBinding>>;
  setChannelInstallationStatus(
    id: string,
    expectedVersion: number,
    status: ChannelBindingStatus,
    actorId: string,
    updatedAt: string,
  ): Promise<Readonly<ChannelInstallation> | undefined>;
  setHumanBindingStatus(
    parentId: string,
    id: string,
    expectedVersion: number,
    status: ChannelBindingStatus,
    actorId: string,
    updatedAt: string,
  ): Promise<Readonly<ChannelHumanBinding> | undefined>;
  setAgentBindingStatus(
    parentId: string,
    id: string,
    expectedVersion: number,
    status: ChannelBindingStatus,
    actorId: string,
    updatedAt: string,
  ): Promise<Readonly<ChannelAgentBinding> | undefined>;
}
export function validateChannelBindingList(options: ChannelBindingListOptions): void {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 101 ||
    (options.afterId !== undefined && !/^(chi|chh|cha)_[0-9a-f-]{36}$/.test(options.afterId))
  )
    throw new ResourceConflictError("The channel binding list bounds are invalid.");
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
export interface RevisionRuntimeAdmission extends RuntimeScope {
  readonly revisionId: string;
  readonly runtimeTransitionRef: string;
  readonly lifecycleGeneration: number;
  readonly auditEventId: string;
}
export interface RuntimeAdmissionReadRepository {
  findRevisionAdmission(
    scope: RuntimeScope,
    revisionId: string,
  ): Promise<Readonly<RevisionRuntimeAdmission> | undefined>;
  findCommittedAdmission(
    scope: RuntimeScope,
    transitionRef: string,
    attribution: RuntimeIntentAttribution,
  ): Promise<Readonly<AgentRevision> | undefined>;
}
export interface RuntimeAdmissionRepository extends RuntimeAdmissionReadRepository {
  recordAdmission(admission: RevisionRuntimeAdmission): Promise<void>;
}

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
export interface RuntimeAssignmentReadRepository {
  findRuntimeIntent(
    scope: RuntimeScope,
    transitionRef: string,
  ): Promise<Readonly<RuntimeIntent> | undefined>;
  findRuntimeIntentHead(scope: RuntimeScope): Promise<Readonly<RuntimeIntent> | undefined>;
  findRuntimeAllocation(
    scope: RuntimeScope,
    locator: RuntimeAllocationLocator,
  ): Promise<Readonly<RuntimeAllocation> | undefined>;
}
export interface RuntimeAssignmentRepository extends RuntimeAssignmentReadRepository {
  initializeRuntimeIntent(
    scope: RuntimeScope,
    revisionId: string,
    transitionRef: string,
    attribution: RuntimeIntentAttribution,
  ): Promise<Readonly<RuntimeIntent>>;
  advanceRuntimeIntent(
    scope: RuntimeScope,
    expectedGeneration: number,
    next: Pick<RuntimeIntent, "desiredMode" | "revisionId">,
    transitionRef: string,
    attribution: RuntimeIntentAttribution,
  ): Promise<Readonly<RuntimeIntent>>;
  allocateUnboundRuntime(
    scope: RuntimeScope,
    expectedLifecycleGeneration: number,
    component: RuntimeAllocation["component"],
    expectedRuntimeGeneration: number,
    createEffectRef: string,
    profileRefs: RuntimeProfileRefs,
  ): Promise<Readonly<RuntimeAllocation>>;
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

export interface PlatformReadView {
  readonly channelBindings: ChannelBindingReadRepository;
  readonly runtimeAssignments: RuntimeAssignmentReadRepository;
  readonly runtimeAdmissions: RuntimeAdmissionReadRepository;
  readonly installations: InstallationReadRepository;
  readonly namespaces: NamespaceReadRepository;
  readonly configurations: ConfigurationReadRepository;
  readonly secrets: SecretReadRepository;
  readonly serviceAccounts: ServiceAccountReadRepository;
  readonly agents: AgentReadRepository;
  readonly revisions: AgentRevisionReadRepository;
}

export interface PlatformUnitOfWork extends PlatformReadView {
  readonly channelBindings: ChannelBindingRepository;
  readonly runtimeAssignments: RuntimeAssignmentRepository;
  readonly runtimeAdmissions: RuntimeAdmissionRepository;
  readonly installations: InstallationRepository;
  readonly namespaces: NamespaceRepository;
  readonly configurations: ConfigurationRepository;
  readonly secrets: SecretRepository;
  readonly serviceAccounts: ServiceAccountRepository;
  readonly agents: AgentRepository;
  readonly revisions: AgentRevisionRepository;
  readonly audit: PlatformAuditRepository;
  readonly operations: PlatformOperationRepository;
}

export interface PlatformStateStore {
  read<T>(work: (state: PlatformReadView) => Promise<T>): Promise<T>;
  transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T>;
}

export interface TransactionalAuditWriter {
  append(event: AuditEvent): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface PlatformAuditSink {
  append(event: AuditEvent): Promise<void>;
  beginTransaction?(): TransactionalAuditWriter;
  checkpoint?(): number;
  restore?(checkpoint: number): void;
}

export interface InMemoryPlatformStateOptions {
  readonly auditSink?: PlatformAuditSink;
}

interface PlatformSnapshot {
  readonly channelInstallations: Map<string, Readonly<ChannelInstallation>>;
  readonly channelHumans: Map<string, Readonly<ChannelHumanBinding>>;
  readonly channelAgents: Map<string, Readonly<ChannelAgentBinding>>;
  readonly runtimeIntents: Map<string, Readonly<RuntimeIntent>>;
  readonly runtimeHeads: Map<string, string>;
  readonly runtimeAllocations: Map<string, Readonly<RuntimeAllocation>>;
  readonly runtimeAdmissions: Map<string, Readonly<RevisionRuntimeAdmission>>;
  installation: Readonly<Installation> | undefined;
  readonly namespaces: Map<string, Readonly<PersistedNamespace>>;
  readonly configurations: Map<string, Readonly<ConfigurationOwnership>>;
  readonly secrets: Map<string, Readonly<Secret>>;
  readonly serviceAccounts: Map<string, Readonly<ServiceAccount>>;
  readonly agents: Map<string, Readonly<Agent>>;
  readonly revisions: Map<string, readonly Readonly<AgentRevision>[]>;
  readonly audit: Readonly<AuditEvent>[];
  readonly operations: Readonly<PlatformOperation>[];
}

function agentKey(namespaceId: string, agentId: string): string {
  return `${namespaceId}\u0000${agentId}`;
}

function cloneSnapshot(snapshot: PlatformSnapshot): PlatformSnapshot {
  return {
    channelInstallations: new Map(snapshot.channelInstallations),
    channelHumans: new Map(snapshot.channelHumans),
    channelAgents: new Map(snapshot.channelAgents),
    runtimeIntents: new Map(snapshot.runtimeIntents),
    runtimeHeads: new Map(snapshot.runtimeHeads),
    runtimeAllocations: new Map(snapshot.runtimeAllocations),
    runtimeAdmissions: new Map(snapshot.runtimeAdmissions),
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

function repositories(snapshot: PlatformSnapshot): PlatformUnitOfWork {
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

  const namespaces: NamespaceRepository = {
    findNamespace: async (namespaceId) => {
      const namespace = snapshot.namespaces.get(namespaceId);
      return namespace !== undefined && namespace.deletedAt === undefined
        ? immutableCopy(namespace)
        : undefined;
    },
    listNamespaces: async () =>
      Object.freeze(
        Array.from(snapshot.namespaces.values())
          .filter((namespace) => namespace.deletedAt === undefined)
          .map((namespace) => immutableCopy(namespace)),
      ),
    createNamespace: async (namespace) => {
      assertInitialized(snapshot);
      const key = namespace.id;
      if (
        namespace.existingNamespace !== undefined &&
        (namespace.existingNamespace.length > 63 ||
          !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(namespace.existingNamespace))
      )
        throw new ScopeViolationError("The existing Kubernetes namespace name is invalid.");
      if (snapshot.namespaces.has(key))
        throw new ResourceConflictError("The server generated an existing Namespace identity.");
      if (
        Array.from(snapshot.namespaces.values()).some(
          (existing) => existing.name === namespace.name,
        )
      )
        throw new ResourceConflictError(
          "A Namespace with this name already exists in the Installation.",
        );
      if (
        namespace.existingNamespace !== undefined &&
        Array.from(snapshot.namespaces.values()).some(
          (existing) =>
            existing.deletedAt === undefined &&
            existing.existingNamespace === namespace.existingNamespace,
        )
      )
        throw new ResourceConflictError(
          "The existing Kubernetes namespace is already assigned to a Namespace.",
        );
      const saved = immutableCopy(namespace);
      snapshot.namespaces.set(key, saved);
      return immutableCopy(saved);
    },
    lockNamespace: async (namespaceId, options = {}) => {
      const namespace = snapshot.namespaces.get(namespaceId);
      if (
        namespace === undefined ||
        (namespace.deletedAt !== undefined && options.includeDeleted !== true)
      )
        return undefined;
      return immutableCopy(namespace);
    },
    hasAgents: async (namespaceId) =>
      Array.from(snapshot.agents.values()).some((agent) => agent.namespaceId === namespaceId),
    hasConfigurations: async (namespaceId) =>
      Array.from(snapshot.configurations.values()).some(
        (configuration) => configuration.namespaceId === namespaceId,
      ),
    hasServiceAccounts: async (namespaceId) =>
      Array.from(snapshot.serviceAccounts.values()).some(
        (account) => account.namespaceId === namespaceId,
      ),
    hasSecrets: async (namespaceId) =>
      Array.from(snapshot.secrets.values()).some((secret) => secret.namespaceId === namespaceId),
    transitionNamespaceStatus: async (namespaceId, expected, next) => {
      const key = namespaceId;
      const namespace = snapshot.namespaces.get(key);
      const expectedStatuses = Array.isArray(expected) ? expected : [expected];
      if (
        namespace === undefined ||
        namespace.deletedAt !== undefined ||
        !expectedStatuses.includes(namespace.status)
      )
        return undefined;
      const allowed =
        namespace.status === next ||
        (namespace.status === "provisioning" &&
          (next === "ready" || next === "failed" || next === "deleting")) ||
        ((namespace.status === "ready" || namespace.status === "failed") && next === "deleting");
      if (!allowed) throw new ScopeViolationError("The Namespace lifecycle transition is invalid.");
      const saved = immutableCopy({ ...namespace, status: next });
      snapshot.namespaces.set(key, saved);
      return immutableCopy(saved);
    },
    markNamespaceDeleted: async (namespaceId, deletedAt) => {
      const key = namespaceId;
      const namespace = snapshot.namespaces.get(key);
      if (namespace === undefined || namespace.status !== "deleting") return undefined;
      if (namespace.deletedAt !== undefined) return immutableCopy(namespace);
      if (
        Array.from(snapshot.agents.values()).some((agent) => agent.namespaceId === namespaceId) ||
        Array.from(snapshot.configurations.values()).some(
          (configuration) => configuration.namespaceId === namespaceId,
        ) ||
        Array.from(snapshot.serviceAccounts.values()).some(
          (account) => account.namespaceId === namespaceId,
        ) ||
        Array.from(snapshot.secrets.values()).some((secret) => secret.namespaceId === namespaceId)
      )
        throw new ScopeViolationError("A nonempty Namespace cannot be tombstoned.");
      const deletedTime = new Date(deletedAt).getTime();
      const createdTime = new Date(namespace.createdAt).getTime();
      if (Number.isNaN(deletedTime) || Number.isNaN(createdTime) || deletedTime < createdTime)
        throw new ScopeViolationError("The Namespace tombstone timestamp is invalid.");
      const saved = immutableCopy({ ...namespace, deletedAt });
      snapshot.namespaces.set(key, saved);
      return immutableCopy(saved);
    },
  };

  const configurations: ConfigurationRepository = {
    findConfiguration: async (namespaceId, configurationId) => {
      if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) return undefined;
      const configuration = snapshot.configurations.get(agentKey(namespaceId, configurationId));
      return configuration === undefined ? undefined : immutableCopy(configuration);
    },
    createConfiguration: async (configuration) => {
      assertInitialized(snapshot);
      if (
        configuration.kind !== "agent" ||
        !Number.isSafeInteger(configuration.generation) ||
        configuration.generation <= 0
      )
        throw new ScopeViolationError("The Configuration kind or generation is invalid.");
      const namespace = await namespaces.lockNamespace(configuration.namespaceId);
      if (
        namespace === undefined ||
        (namespace.status !== "provisioning" && namespace.status !== "ready")
      )
        throw new ScopeViolationError("The Configuration belongs to an unavailable Namespace.");
      const key = agentKey(configuration.namespaceId, configuration.id);
      if (
        snapshot.configurations.has(key) ||
        Array.from(snapshot.configurations.values()).some(
          (existing) => existing.id === configuration.id,
        )
      )
        throw new ResourceConflictError("The server generated an existing Configuration identity.");
      const secretBindings = normalizedSecretBindings(configuration.secretBindings);
      await assertSecretBindingsAvailable(
        {
          findSecret: async (namespaceId, secretId) => {
            const secret = snapshot.secrets.get(agentKey(namespaceId, secretId));
            return secret === undefined ? undefined : immutableCopy(secret);
          },
        },
        configuration.namespaceId,
        secretBindings,
      );
      const { secretBindings: _providedSecretBindings, ...withoutSecretBindings } = configuration;
      const saved = immutableCopy({
        ...withoutSecretBindings,
        ...(secretBindings === undefined ? {} : { secretBindings }),
      });
      snapshot.configurations.set(key, saved);
      return immutableCopy(saved);
    },
    lockConfiguration: async (namespaceId, configurationId) =>
      configurations.findConfiguration(namespaceId, configurationId),
    advanceConfigurationGeneration: async (
      namespaceId,
      configurationId,
      expectedGeneration,
      nextSecretBindings,
    ) => {
      const current = await configurations.findConfiguration(namespaceId, configurationId);
      if (current === undefined || current.generation !== expectedGeneration) return undefined;
      if (current.generation === Number.MAX_SAFE_INTEGER)
        throw new ScopeViolationError("The Configuration generation exceeds its supported range.");
      const secretBindings =
        nextSecretBindings === undefined
          ? current.secretBindings
          : normalizedSecretBindings(nextSecretBindings);
      await assertSecretBindingsAvailable(secrets, namespaceId, secretBindings);
      const { secretBindings: _currentSecretBindings, ...withoutSecretBindings } = current;
      const updated = immutableCopy({
        ...withoutSecretBindings,
        generation: current.generation + 1,
        ...(secretBindings === undefined ? {} : { secretBindings }),
      });
      snapshot.configurations.set(agentKey(namespaceId, configurationId), updated);
      return immutableCopy(updated);
    },
    deleteConfiguration: async (namespaceId, configurationId) => {
      const existing = await configurations.findConfiguration(namespaceId, configurationId);
      if (existing === undefined) return false;
      if (
        Array.from(snapshot.agents.values()).some(
          (agent) => agent.namespaceId === namespaceId && agent.configurationId === configurationId,
        )
      )
        throw new ScopeViolationError("The Configuration is referenced by an Agent.");
      snapshot.configurations.delete(agentKey(namespaceId, configurationId));
      return true;
    },
  };

  const secrets: SecretRepository = {
    findSecret: async (namespaceId, secretId) => {
      if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) return undefined;
      const secret = snapshot.secrets.get(agentKey(namespaceId, secretId));
      return secret === undefined ? undefined : immutableCopy(secret);
    },
    lockSecret: async (namespaceId, secretId) => secrets.findSecret(namespaceId, secretId),
    createSecret: async (secret) => {
      assertInitialized(snapshot);
      assertSecret(secret);
      const namespace = await namespaces.lockNamespace(secret.namespaceId);
      if (
        namespace === undefined ||
        (namespace.status !== "provisioning" && namespace.status !== "ready")
      )
        throw new ScopeViolationError("The Secret belongs to an unavailable Namespace.");
      const key = agentKey(secret.namespaceId, secret.id);
      if (
        snapshot.secrets.has(key) ||
        Array.from(snapshot.secrets.values()).some((existing) => existing.id === secret.id)
      )
        throw new ResourceConflictError("The server generated an existing Secret identity.");
      if (
        Array.from(snapshot.secrets.values()).some(
          (existing) =>
            existing.namespaceId === secret.namespaceId && existing.name === secret.name,
        )
      )
        throw new ResourceConflictError("A Secret with this name already exists in the Namespace.");
      const saved = immutableCopy(secret);
      snapshot.secrets.set(key, saved);
      return immutableCopy(saved);
    },
    hasReferences: async (namespaceId, secretId) => {
      if ((await secrets.findSecret(namespaceId, secretId)) === undefined) return false;
      return (
        Array.from(snapshot.configurations.values()).some(
          (configuration) =>
            configuration.namespaceId === namespaceId &&
            secretBindingsReference(configuration.secretBindings, namespaceId, secretId),
        ) ||
        Array.from(snapshot.agents.values()).some((agent) => {
          const activeRevision = (
            snapshot.revisions.get(agentKey(namespaceId, agent.id)) ?? []
          ).find((revision) => revision.id === agent.activeRevisionId);
          return (
            agent.namespaceId === namespaceId &&
            activeRevision !== undefined &&
            secretBindingsReference(activeRevision.secretBindings, namespaceId, secretId)
          );
        }) ||
        snapshot.operations.some((operation) => {
          if (operation.kind !== "agent_revision" || operation.namespaceId !== namespaceId)
            return false;
          const revision = Array.from(snapshot.revisions.values())
            .flat()
            .find(
              (candidate) =>
                candidate.namespaceId === namespaceId && candidate.id === operation.resourceId,
            );
          return secretBindingsReference(revision?.secretBindings, namespaceId, secretId);
        })
      );
    },
    deleteSecret: async (namespaceId, secretId) => {
      if ((await secrets.findSecret(namespaceId, secretId)) === undefined) return false;
      if (await secrets.hasReferences(namespaceId, secretId))
        throw new ScopeViolationError("The Secret is referenced by active platform state.");
      snapshot.secrets.delete(agentKey(namespaceId, secretId));
      return true;
    },
  };

  const serviceAccounts: ServiceAccountRepository = {
    findServiceAccount: async (namespaceId, serviceAccountId) => {
      if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) return undefined;
      const account = snapshot.serviceAccounts.get(agentKey(namespaceId, serviceAccountId));
      return account === undefined ? undefined : immutableCopy(account);
    },
    listServiceAccounts: async (namespaceId) => {
      if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) return Object.freeze([]);
      return Object.freeze(
        Array.from(snapshot.serviceAccounts.values())
          .filter((account) => account.namespaceId === namespaceId)
          .sort(
            (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
          )
          .map((account) => immutableCopy(account)),
      );
    },
    findServiceAccountProviderBinding: async () => undefined,
    createServiceAccount: async (account) => {
      assertInitialized(snapshot);
      if (
        !serviceAccountIdentifier.test(account.id) ||
        typeof account.name !== "string" ||
        account.name.length < 1 ||
        account.name.length > 200 ||
        account.name !== account.name.trim() ||
        /[\x00-\x1f\x7f]/.test(account.name) ||
        (account.credential !== undefined && !validCredential(account.credential))
      )
        throw new ScopeViolationError("The ServiceAccount or its credential reference is invalid.");
      const namespace = await namespaces.lockNamespace(account.namespaceId);
      if (
        namespace === undefined ||
        (namespace.status !== "provisioning" && namespace.status !== "ready")
      )
        throw new ScopeViolationError("The ServiceAccount belongs to an unavailable Namespace.");
      const key = agentKey(account.namespaceId, account.id);
      if (
        snapshot.serviceAccounts.has(key) ||
        Array.from(snapshot.serviceAccounts.values()).some(
          (existing) =>
            existing.id === account.id ||
            (existing.namespaceId === account.namespaceId && existing.name === account.name),
        )
      )
        throw new ResourceConflictError(
          "A ServiceAccount with this identity or name already exists.",
        );
      const saved = immutableCopy(account);
      snapshot.serviceAccounts.set(key, saved);
      return immutableCopy(saved);
    },
    lockServiceAccount: async (namespaceId, serviceAccountId) =>
      serviceAccounts.findServiceAccount(namespaceId, serviceAccountId),
    updateCredential: async (namespaceId, serviceAccountId, credential) => {
      if (!validCredential(credential))
        throw new ScopeViolationError("The ServiceAccount credential reference is invalid.");
      const current = await serviceAccounts.findServiceAccount(namespaceId, serviceAccountId);
      if (current === undefined) return undefined;
      const updated = immutableCopy({ ...current, credential });
      snapshot.serviceAccounts.set(agentKey(namespaceId, serviceAccountId), updated);
      return immutableCopy(updated);
    },
    deleteServiceAccount: async (namespaceId, serviceAccountId) => {
      if ((await serviceAccounts.findServiceAccount(namespaceId, serviceAccountId)) === undefined)
        return false;
      if (
        Array.from(snapshot.agents.values()).some(
          (agent) =>
            agent.namespaceId === namespaceId && agent.serviceAccountId === serviceAccountId,
        )
      )
        throw new ScopeViolationError("The ServiceAccount is referenced by an Agent.");
      snapshot.serviceAccounts.delete(agentKey(namespaceId, serviceAccountId));
      return true;
    },
  };

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
    ) => {
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

  const revisions: AgentRevisionRepository = {
    findRevision: async (namespaceId, agentId, revisionId) => {
      if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) return undefined;
      const candidate = snapshot.revisions
        .get(agentKey(namespaceId, agentId))
        ?.find((revision) => revision.id === revisionId);
      return candidate?.namespaceId === namespaceId && candidate.agentId === agentId
        ? immutableCopy(candidate)
        : undefined;
    },
    listRevisions: async (namespaceId, agentId) =>
      Object.freeze(
        snapshot.namespaces.get(namespaceId)?.deletedAt === undefined
          ? (snapshot.revisions.get(agentKey(namespaceId, agentId)) ?? [])
              .filter(
                (revision) => revision.namespaceId === namespaceId && revision.agentId === agentId,
              )
              .map((revision) => immutableCopy(revision))
          : [],
      ),
    createRevision: async (revision) => {
      assertInitialized(snapshot);
      assertAdmittedAgentRevision(revision);
      const owner = await agents.findAgent(revision.namespaceId, revision.agentId);
      if (
        owner === undefined ||
        owner.servicePrincipalId !== revision.servicePrincipalId ||
        owner.providerId !== revision.providerId ||
        revision.serviceAccount?.id !== owner.serviceAccountId
      )
        throw new ScopeViolationError("The AgentRevision belongs to an unavailable Agent.");
      const secretBindings = normalizedSecretBindings(revision.secretBindings);
      await assertSecretBindingsAvailable(secrets, revision.namespaceId, secretBindings);
      const key = agentKey(revision.namespaceId, revision.agentId);
      const previous = snapshot.revisions.get(key) ?? [];
      if (previous.some((existing) => existing.id === revision.id))
        throw new ResourceConflictError("The server generated an existing AgentRevision identity.");
      const { secretBindings: _providedSecretBindings, ...withoutSecretBindings } = revision;
      const saved = immutableCopy({
        ...withoutSecretBindings,
        ...(secretBindings === undefined ? {} : { secretBindings }),
      });
      snapshot.revisions.set(key, Object.freeze([...previous, saved]));
      return immutableCopy(saved);
    },
  };

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
  function channelConflict(): never {
    throw new ResourceConflictError(
      "The channel binding conflicts with retained identity, ownership or state.",
    );
  }
  function validateChannelMetadata(record: ChannelBindingMetadata, prefix: string): void {
    const pattern = new RegExp(
      `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    );
    if (
      !snapshot.installation ||
      record.installationId !== snapshot.installation.id ||
      !pattern.test(record.id) ||
      record.version !== 1 ||
      record.status !== "enabled" ||
      !isChannelBindingReference(record.createdBy) ||
      !isChannelBindingReference(record.updatedBy) ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      !Number.isFinite(Date.parse(record.updatedAt)) ||
      record.updatedAt !== record.createdAt ||
      record.updatedBy !== record.createdBy
    )
      channelConflict();
  }
  function channelParent(parentId: string): Readonly<ChannelInstallation> | undefined {
    const parent = snapshot.channelInstallations.get(parentId);
    return parent?.installationId === snapshot.installation?.id ? parent : undefined;
  }
  function childFind<T extends ChannelBindingMetadata & { channelInstallationId: string }>(
    map: Map<string, Readonly<T>>,
    parentId: string,
    id: string,
  ): Readonly<T> | undefined {
    const record = map.get(id);
    return channelParent(parentId) && record?.channelInstallationId === parentId
      ? immutableCopy(record)
      : undefined;
  }
  function channelList<T extends ChannelBindingMetadata>(
    values: Iterable<Readonly<T>>,
    options: ChannelBindingListOptions,
  ): readonly Readonly<T>[] {
    validateChannelBindingList(options);
    return Object.freeze(
      [...values]
        .filter(
          (r) =>
            r.installationId === snapshot.installation?.id &&
            (options.afterId === undefined || r.id > options.afterId),
        )
        .sort((a, b) => {
          if (a.id === b.id) return 0;
          return a.id < b.id ? -1 : 1;
        })
        .slice(0, options.limit)
        .map((r) => immutableCopy(r)),
    );
  }
  function requireChannelParent(
    record: ChannelHumanBinding | ChannelAgentBinding,
  ): Readonly<ChannelInstallation> {
    const parent = channelParent(record.channelInstallationId);
    if (!parent || parent.status !== "enabled" || parent.installationId !== record.installationId)
      channelConflict();
    return parent;
  }
  function requireChannelAgent(record: ChannelAgentBinding, parent: ChannelInstallation): void {
    const namespace = snapshot.namespaces.get(record.namespaceId);
    const agent = snapshot.agents.get(agentKey(record.namespaceId, record.agentId));
    if (
      !namespace ||
      namespace.status !== "ready" ||
      namespace.deletedAt !== undefined ||
      !agent ||
      (parent.platform === "slack"
        ? record.scopeKind !== "slack-private-channel"
        : record.scopeKind !== "msteams-standard-channel")
    )
      channelConflict();
  }
  function changeChannelStatus<T extends ChannelBindingMetadata>(
    map: Map<string, Readonly<T>>,
    record: Readonly<T> | undefined,
    expectedVersion: number,
    status: ChannelBindingStatus,
    actorId: string,
    updatedAt: string,
  ): Readonly<T> | undefined {
    if (!record) return undefined;
    if (
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1 ||
      record.version !== expectedVersion ||
      (status !== "enabled" && status !== "disabled") ||
      !isChannelBindingReference(actorId) ||
      !Number.isFinite(Date.parse(updatedAt)) ||
      Date.parse(updatedAt) < Date.parse(record.createdAt)
    )
      channelConflict();
    if (record.status === status) return immutableCopy(record);
    if (record.version === Number.MAX_SAFE_INTEGER) channelConflict();
    const updated = immutableCopy({
      ...record,
      status,
      version: record.version + 1,
      updatedBy: actorId,
      updatedAt,
    });
    map.set(record.id, updated);
    return immutableCopy(updated);
  }
  const channelBindings: ChannelBindingRepository = {
    findChannelInstallation: async (id) => {
      const parent = channelParent(id);
      return parent && immutableCopy(parent);
    },
    listChannelInstallations: async (options) =>
      channelList(snapshot.channelInstallations.values(), options),
    findHumanBinding: async (parentId, id) => childFind(snapshot.channelHumans, parentId, id),
    findHumanBindingBySubject: async (parentId, subject) => {
      const found = [...snapshot.channelHumans.values()].find(
        (r) => r.channelInstallationId === parentId && r.providerSubjectRef === subject,
      );
      return found && childFind(snapshot.channelHumans, parentId, found.id);
    },
    listHumanBindings: async (parentId, options) =>
      channelList(
        [...snapshot.channelHumans.values()].filter(
          (r) => !!channelParent(parentId) && r.channelInstallationId === parentId,
        ),
        options,
      ),
    findAgentBinding: async (parentId, id) => childFind(snapshot.channelAgents, parentId, id),
    findAgentBindingByChannel: async (parentId, channelRef) => {
      const found = [...snapshot.channelAgents.values()].find(
        (r) => r.channelInstallationId === parentId && r.channelRef === channelRef,
      );
      return found && childFind(snapshot.channelAgents, parentId, found.id);
    },
    listAgentBindings: async (parentId, options) =>
      channelList(
        [...snapshot.channelAgents.values()].filter(
          (r) => !!channelParent(parentId) && r.channelInstallationId === parentId,
        ),
        options,
      ),
    createChannelInstallation: async (record) => {
      validateChannelMetadata(record, "chi");
      if (
        (record.platform !== "slack" && record.platform !== "msteams") ||
        !isChannelBindingReference(record.providerTenantRef) ||
        !isChannelBindingReference(record.recipientAppRef) ||
        snapshot.channelInstallations.has(record.id) ||
        [...snapshot.channelInstallations.values()].some(
          (r) =>
            r.installationId === record.installationId &&
            r.platform === record.platform &&
            r.providerTenantRef === record.providerTenantRef &&
            r.recipientAppRef === record.recipientAppRef,
        )
      )
        channelConflict();
      snapshot.channelInstallations.set(record.id, immutableCopy(record));
      return immutableCopy(record);
    },
    createHumanBinding: async (record) => {
      validateChannelMetadata(record, "chh");
      requireChannelParent(record);
      if (
        ![
          record.providerSubjectRef,
          record.iamDriverId,
          record.principalId,
          record.principalIssuer,
          record.principalSubject,
        ].every(isChannelBindingReference) ||
        snapshot.channelHumans.has(record.id) ||
        [...snapshot.channelHumans.values()].some(
          (r) =>
            r.channelInstallationId === record.channelInstallationId &&
            r.providerSubjectRef === record.providerSubjectRef,
        )
      )
        channelConflict();
      snapshot.channelHumans.set(record.id, immutableCopy(record));
      return immutableCopy(record);
    },
    createAgentBinding: async (record) => {
      validateChannelMetadata(record, "cha");
      const parent = requireChannelParent(record);
      requireChannelAgent(record, parent);
      if (
        !isChannelBindingReference(record.channelRef) ||
        snapshot.channelAgents.has(record.id) ||
        [...snapshot.channelAgents.values()].some(
          (r) =>
            r.channelInstallationId === record.channelInstallationId &&
            r.channelRef === record.channelRef,
        )
      )
        channelConflict();
      snapshot.channelAgents.set(record.id, immutableCopy(record));
      return immutableCopy(record);
    },
    setChannelInstallationStatus: async (id, version, status, actor, at) =>
      changeChannelStatus(
        snapshot.channelInstallations,
        channelParent(id),
        version,
        status,
        actor,
        at,
      ),
    setHumanBindingStatus: async (parentId, id, version, status, actor, at) => {
      const record = childFind(snapshot.channelHumans, parentId, id);
      if (record && status === "enabled" && record.status !== status) requireChannelParent(record);
      return changeChannelStatus(snapshot.channelHumans, record, version, status, actor, at);
    },
    setAgentBindingStatus: async (parentId, id, version, status, actor, at) => {
      const record = childFind(snapshot.channelAgents, parentId, id);
      if (record && status === "enabled" && record.status !== status)
        requireChannelAgent(record, requireChannelParent(record));
      return changeChannelStatus(snapshot.channelAgents, record, version, status, actor, at);
    },
  };

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
    next: Pick<RuntimeIntent, "desiredMode" | "revisionId">,
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

  const runtimeAdmissions: RuntimeAdmissionRepository = {
    findRevisionAdmission: async (scope, revisionId) => {
      if (!(await runtimeOwner(scope))) return undefined;
      const admission = snapshot.runtimeAdmissions.get(revisionId);
      return admission?.namespaceId === scope.namespaceId && admission.agentId === scope.agentId
        ? immutableCopy(admission)
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
      const operation = snapshot.operations.find(
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
    recordAdmission: async (admission) => {
      const intent = await runtimeAssignments.findRuntimeIntent(
        admission,
        admission.runtimeTransitionRef,
      );
      const audit = snapshot.audit.find((event) => event.id === admission.auditEventId);
      if (
        intent === undefined ||
        intent.desiredMode !== "running" ||
        intent.revisionId !== admission.revisionId ||
        intent.generation !== admission.lifecycleGeneration ||
        audit === undefined ||
        !isRuntimeAdmissionAudit(audit, intent)
      )
        throw new ScopeViolationError(
          "The revision admission does not match its exact intent and audit.",
        );
      if (
        snapshot.runtimeAdmissions.has(admission.revisionId) ||
        [...snapshot.runtimeAdmissions.values()].some(
          (item) =>
            item.runtimeTransitionRef === admission.runtimeTransitionRef ||
            item.auditEventId === admission.auditEventId,
        )
      )
        throw new ResourceConflictError("The revision runtime admission is immutable.");
      snapshot.runtimeAdmissions.set(admission.revisionId, immutableCopy(admission));
    },
  };

  return {
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
    audit: {
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
    },
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
        const duplicate = snapshot.operations.find(
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
        snapshot.operations.push(immutableCopy(operation));
      },
      list: async () =>
        Object.freeze(snapshot.operations.map((operation) => immutableCopy(operation))),
    },
  };
}

/** Process-local, single-writer state. No restart or multi-process durability. */
export class InMemoryPlatformState implements PlatformStateStore {
  private snapshot: PlatformSnapshot = {
    channelInstallations: new Map(),
    channelHumans: new Map(),
    channelAgents: new Map(),
    runtimeIntents: new Map(),
    runtimeHeads: new Map(),
    runtimeAllocations: new Map(),
    runtimeAdmissions: new Map(),
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

  constructor(options: InMemoryPlatformStateOptions = {}) {
    this.auditSink = options.auditSink;
  }

  pendingOperations(): readonly Readonly<PlatformOperation>[] {
    return Object.freeze(this.snapshot.operations.map((operation) => immutableCopy(operation)));
  }

  async read<T>(work: (state: PlatformReadView) => Promise<T>): Promise<T> {
    await this.pending;
    return work(repositories(cloneSnapshot(this.snapshot)));
  }

  async transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release: (() => void) | undefined;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      const working = cloneSnapshot(this.snapshot);
      const committedAuditCount = working.audit.length;
      const result = await work(repositories(working));
      await this.publishAudit(working.audit.slice(committedAuditCount));
      this.snapshot = working;
      return result;
    } finally {
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
