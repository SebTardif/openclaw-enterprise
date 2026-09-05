import { RepositoryTransactionLifetime, type RepositoryTransaction } from "../ports/transaction.ts";
import { createMemoryChannelBindingRepository } from "./memory/channel-bindings.ts";
import { createMemoryNamespaceRepository } from "./memory/namespaces.ts";
import { createMemoryConfigurationRepository } from "./memory/configurations.ts";
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
import type {
  AgentRevisionReadRepository,
  AgentRevisionRepository,
} from "../ports/repositories/revision.ts";
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
import type { SecretReadRepository, SecretRepository } from "../ports/repositories/secret.ts";
export type { SecretReadRepository, SecretRepository } from "../ports/repositories/secret.ts";
import type {
  ServiceAccountReadRepository,
  ServiceAccountRepository,
} from "../ports/repositories/service-account.ts";
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
  readonly runtimeAuthorityOperations: Map<string, StoredRuntimeAuthorityOperation>;
  readonly runtimeServiceTrustRecords: Map<string, Readonly<RuntimeServiceTrustRecord>>;
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
    runtimeAuthorityOperations: new Map(snapshot.runtimeAuthorityOperations),
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

  return {
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
    runtimeAuthorityOperations: new Map(),
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

  constructor(options: InMemoryPlatformStateOptions = {}) {
    this.auditSink = options.auditSink;
  }

  pendingOperations(): readonly Readonly<PlatformOperation>[] {
    return Object.freeze(this.snapshot.operations.map((operation) => immutableCopy(operation)));
  }

  async read<T>(
    work: (state: PlatformReadView) => Promise<T>,
    options?: PlatformReadOptions,
  ): Promise<T> {
    const lifetime = new RepositoryTransactionLifetime();
    let cancel: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    try {
      if (options === undefined) {
        await this.pending;
        return await work(
          createPlatformReadView(repositories(cloneSnapshot(this.snapshot), lifetime), lifetime),
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
            createPlatformReadView(repositories(cloneSnapshot(this.snapshot), lifetime), lifetime),
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
      await lifetime.finish();
    }
  }

  async transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release: (() => void) | undefined;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorityGuard = new RuntimeAuthorityTransactionGuard();
    const lifetime = new RepositoryTransactionLifetime();
    try {
      await previous;
      const working = cloneSnapshot(this.snapshot);
      const committedAuditCount = working.audit.length;
      const result = await work(
        bindPlatformUnitOfWork(repositories(working, lifetime, authorityGuard), lifetime),
      );
      await lifetime.finish();
      await authorityGuard.finish();
      await this.publishAudit(working.audit.slice(committedAuditCount));
      this.snapshot = working;
      return result;
    } catch (error) {
      await lifetime.finish();
      // Drain already-started authority writes before discarding the private snapshot.
      try {
        await authorityGuard.finish();
      } catch {
        /* Preserve the original failure. */
      }
      throw error;
    } finally {
      lifetime.close();
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
