import { ExactAuthorization } from "./application/authorization.ts";
import { DriverSelection, type DriverFor } from "./application/driver-selection.ts";
export * from "./runtime-authority/service-trust.ts";
export * from "./runtime-authority/service-trust-schema.ts";
export * from "./runtime-authority/service.ts";
export * from "./runtime-authority/repository.ts";
import { ChannelBindingService } from "./channel-bindings.ts";
export * from "./channel-bindings.ts";
export {
  TurnJournalStore,
  type TurnJournalClock,
  type TurnJournalInitiationAuthority,
  type TurnJournalStoreOptions,
} from "./turn-journal/store.ts";
export {
  createPostgresTurnJournal,
  type PostgresTurnJournalContext,
  type PostgresTurnJournalOptions,
  type PostgresTurnJournalProvenance,
} from "./turn-journal/postgres.ts";
export {
  CompletedContextJournalService,
  type CompletedContextJournalOptions,
  type ExactCheckpointPublication,
  type PrepareCheckpointPublication,
  type ReconcileCheckpointPublication,
  type CompletedContextPublicationResult,
} from "./turn-journal/completed-context.ts";
import { MutationRunner } from "./application/mutation-runner.ts";
import { selectRepositories } from "./application/mutation-context.ts";
import {
  AGENT_REPOSITORIES,
  type ActiveAgentRevisionSelection,
  type AgentServicePort,
  type CreateAgentInput,
  type UpdateAgentInput,
} from "./services/agent/port.ts";
import { AgentService } from "./services/agent/service.ts";
import {
  DEPLOYMENT_REPOSITORIES,
  DEPLOYMENT_RECOVERY_REPOSITORIES,
  type DeployAgentAdmissionContext,
  type DeployAgentInput,
  type DeploymentServicePort,
  type HarnessResolver,
} from "./services/deployment/port.ts";
import { DeploymentService } from "./services/deployment/service.ts";
export type {
  ActiveAgentRevisionSelection,
  AgentCommands,
  AgentQueries,
  AgentServicePort,
  CreateAgentInput,
  UpdateAgentInput,
} from "./services/agent/port.ts";
export type {
  DeployAgentAdmissionContext,
  DeployAgentInput,
  DeploymentCommands,
  DeploymentQueries,
  DeploymentServicePort,
  HarnessResolver,
} from "./services/deployment/port.ts";
export { resolveConfiguredHarnessId } from "./services/deployment/configuration.ts";
import {
  NAMESPACE_REPOSITORIES,
  type CreateNamespaceInput,
  type NamespaceServicePort,
} from "./services/namespace/port.ts";
import { NamespaceService } from "./services/namespace/service.ts";
export type {
  CreateNamespaceInput,
  NamespaceCommands,
  NamespaceQueries,
  NamespaceLifecycle,
  NamespaceServicePort,
} from "./services/namespace/port.ts";
import {
  SECRET_REPOSITORIES,
  type SecretServicePort,
  type CreateSecretInput,
  type UpdateSecretInput,
} from "./services/secret/port.ts";
import { SecretService } from "./services/secret/service.ts";
import {
  SERVICE_ACCOUNT_REPOSITORIES,
  type ServiceAccountServicePort,
  type CreateServiceAccountInput,
} from "./services/service-account/port.ts";
import { ServiceAccountService } from "./services/service-account/service.ts";
export type {
  SecretCommands,
  SecretQueries,
  SecretServicePort,
  CreateSecretInput,
  UpdateSecretInput,
} from "./services/secret/port.ts";
export type {
  ServiceAccountCommands,
  ServiceAccountQueries,
  ServiceAccountServicePort,
  CreateServiceAccountInput,
} from "./services/service-account/port.ts";
import {
  CONFIGURATION_REPOSITORIES,
  type ConfigurationServicePort,
  type CreateConfigurationInput,
  type UpdateConfigurationInput,
} from "./services/configuration/port.ts";
import {
  ConfigurationService,
  authorizeConfigurationBindings,
  configurationBindings,
  exactConfiguration,
} from "./services/configuration/service.ts";
export type {
  ConfigurationCommands,
  ConfigurationQueries,
  ConfigurationServicePort,
  CreateConfigurationInput,
  UpdateConfigurationInput,
} from "./services/configuration/port.ts";
import type {
  Agent,
  AgentRevision,
  AuditEvent,
  AuthorizationDecision,
  AuthorizationRequest,
  ComputeDriver,
  Configuration,
  ConfigurationDriver,
  Driver,
  DriverCapability,
  IAMDriver,
  Installation,
  Namespace,
  LoggingLevel,
  ProviderDefinition,
  ProviderRef,
  ResourceKind,
  ResourceRef,
  SandboxDriver,
  Secret,
  SecretBindings,
  SecretDriver,
  SecretMetadata,
  ServiceAccount,
  ServiceAccountCredential,
  ServiceAccountDriver,
  ServiceAccountRevision,
} from "@openclaw-enterprise/contracts";
import { normalizeLoggingLevel } from "@openclaw-enterprise/contracts";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  ResourceConflictError,
  ScopeViolationError,
} from "./errors.ts";
import {
  assertConfiguredProvider,
  providerDefinitionMap,
  validateProviderDefinitions,
  validateServiceAccountProviderBinding,
} from "./providers.ts";
import {
  InMemoryPlatformState,
  isRuntimeAdmissionAudit,
  type RuntimeScope,
  type RuntimeIntentAttribution,
  type RuntimeIntent,
  type RuntimeProfileRefs,
  type RuntimeAllocation,
  type RuntimeAllocationLocator,
  type RuntimeAssignmentReadRepository,
  type RuntimeAssignmentRepository,
  type RevisionRuntimeAdmission,
  type RuntimeAdmissionReadRepository,
  type RuntimeAdmissionRepository,
  type PlatformReadView,
  type PlatformOperation,
  type PlatformStateStore,
  type PlatformUnitOfWork,
} from "./state/platform-state.ts";
export { PostgresCommitOutcomeUnknownError } from "./ports/transaction-errors.ts";

export {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  DriverSelectionError,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  ResourceConflictError,
  ScopeViolationError,
} from "./errors.ts";
export {
  providerDefinitionMap,
  validateProviderDefinitions,
  validateSelectedProviderDrivers,
  validateServiceAccountProviderBinding,
} from "./providers.ts";
export {
  InMemoryPlatformState,
  type RevisionRuntimeAdmission,
  type RuntimeAdmissionReadRepository,
  type RuntimeAdmissionRepository,
  type AgentReadRepository,
  type AgentRepository,
  type AgentRevisionReadRepository,
  type AgentRevisionRepository,
  type InMemoryPlatformStateOptions,
  type InstallationReadRepository,
  type InstallationRepository,
  type NamespaceReadRepository,
  type NamespaceRepository,
  type PlatformAuditRepository,
  type PlatformAuditSink,
  type PlatformOperation,
  type PlatformOperationRepository,
  type PlatformReadView,
  type PlatformStateStore,
  type PlatformUnitOfWork,
  type ServiceAccountReadRepository,
  type ServiceAccountRepository,
  type TransactionalAuditWriter,
} from "./state/platform-state.ts";
export {
  PostgresPlatformState,
  PostgresPlatformStateStore,
  type PersistedNativeIAMState,
  type PostgresClient,
  type PostgresPlatformStateOptions,
  type PostgresPool,
} from "./state/postgres-state.ts";
export {
  PostgresWorkQueue,
  WorkClaimLostError,
  type ClaimedWork,
  type ClaimRequest,
  type ControllerWork,
  type ControllerWorkState,
  type EnqueueWork,
  type PermanentFailure,
  type PostgresQueryClient,
  type PostgresWorkQueueOptions,
  type RecoveryRequest,
  type RecoverySummary,
  type RetryableFailure,
  type WorkClaim,
  type WorkResult,
} from "./state/postgres-work-queue.ts";

export const BOOTSTRAP_DEFAULT_NAMESPACE_NAME = "default";

export interface ControllerOptions {
  readonly authorize?: (
    request: AuthorizationRequest,
  ) => AuthorizationDecision | Promise<AuthorizationDecision>;
  readonly now?: () => Date;
  readonly createId?: (kind: ResourceKind) => string;
  readonly state?: PlatformStateStore;
  readonly recordOperations?: boolean;
  readonly providers?: readonly ProviderDefinition[];
  readonly loggingLevel?: LoggingLevel;
}

export type ReconciliationOperation = PlatformOperation;

function validName(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= 200;
}

export class OpenClawController {
  readonly channelBindings: ChannelBindingService;
  readonly configuration: ConfigurationServicePort;
  readonly agent: AgentServicePort;
  readonly deployment: DeploymentServicePort;
  readonly namespace: NamespaceServicePort;
  readonly secret: SecretServicePort;
  readonly serviceAccount: ServiceAccountServicePort;
  readonly installation: Readonly<Installation>;

  private readonly authorization: ExactAuthorization;
  private readonly clock: () => Date;
  private readonly identifier?: ControllerOptions["createId"];
  private readonly state: PlatformStateStore;
  private readonly mutations: MutationRunner;
  private readonly drivers = new DriverSelection();
  private readonly providers: readonly ProviderDefinition[];
  private readonly loggingLevel: LoggingLevel;
  private readonly providerMap: ReadonlyMap<string, ProviderDefinition>;

  constructor(installation: Installation, options: ControllerOptions = {}) {
    if (!isNonEmptyString(installation.id) || !validName(installation.name))
      throw new ScopeViolationError("The controller requires one valid server-owned Installation.");
    if (
      !isNonEmptyString(installation.createdAt) ||
      Number.isNaN(Date.parse(installation.createdAt))
    )
      throw new ScopeViolationError("The server-owned Installation has an invalid creation time.");
    this.installation = Object.freeze({
      id: installation.id,
      name: installation.name,
      createdAt: installation.createdAt,
    });
    this.authorization = new ExactAuthorization(
      () => this.selectedDriver("iam"),
      options.authorize,
    );
    this.clock = options.now ?? (() => new Date());
    this.identifier = options.createId;
    this.state = options.state ?? new InMemoryPlatformState();
    this.mutations = new MutationRunner(this.installation, this.state);
    this.configuration = new ConfigurationService({
      repositories: this.mutations.forRepositories(CONFIGURATION_REPOSITORIES),
      authorization: {
        authorize: (principalId, action, resource) => this.authorize(principalId, action, resource),
      },
      configurationDriver: () => this.configurationDriver(),
      assertSecretDriverOwner: (expectedId) => {
        this.secretDriver(expectedId);
      },
      createId: () => this.nextIdentifier("configuration"),
      now: () => this.timestamp(),
    });
    this.secret = new SecretService({
      repositories: this.mutations.forRepositories(SECRET_REPOSITORIES),
      authorization: {
        authorize: (principalId, action, resource) => this.authorize(principalId, action, resource),
      },
      secretOperation: (operation) => this.secretOperation(operation),
      secretDriver: (expectedId) => this.secretDriver(expectedId),
      createId: () => this.nextIdentifier("secret"),
      now: () => this.timestamp(),
    });
    this.serviceAccount = new ServiceAccountService({
      repositories: this.mutations.forRepositories(SERVICE_ACCOUNT_REPOSITORIES),
      authorization: {
        authorize: (principalId, action, resource) => this.authorize(principalId, action, resource),
        canRead: (principalId, resource) => this.canRead(principalId, resource),
      },
      exactServiceAccount: (state, namespaceId, serviceAccountId) =>
        this.exactServiceAccount(state, namespaceId, serviceAccountId),
      driverOperation: (operation) => this.driverOperation(operation, "ServiceAccount"),
      serviceAccountDriver: () => this.serviceAccountDriver(),
      getNamespace: (principalId, namespaceId) => this.getNamespace(principalId, namespaceId),
      createId: () => this.nextIdentifier("service_account"),
    });
    this.channelBindings = new ChannelBindingService({
      installationId: this.installation.id,
      state: this.state,
      iam: () => this.selectedDriver("iam"),
    });
    this.namespace = new NamespaceService({
      installationId: this.installation.id,
      repositories: this.mutations.forRepositories(NAMESPACE_REPOSITORIES),
      authorization: {
        authorize: (principalId, action, resource) => this.authorize(principalId, action, resource),
        canRead: (principalId, resource) => this.canRead(principalId, resource),
        authorizationAuthority: (principalId) => this.authorizationAuthority(principalId),
      },
      computeDriver: () => this.selectedDriver("compute"),
      iamDriverId: () => this.selectedDriver("iam").id,
      createId: () => this.nextIdentifier("namespace"),
      createAuditId: () => `aud_${crypto.randomUUID()}`,
      now: () => this.timestamp(),
      recordOperations: options.recordOperations ?? true,
    });
    this.providers = validateProviderDefinitions(options.providers ?? []);
    this.loggingLevel = normalizeLoggingLevel(options.loggingLevel);
    this.providerMap = providerDefinitionMap(this.providers);
    this.agent = new AgentService({
      repositories: this.mutations.forRepositories(AGENT_REPOSITORIES),
      authorization: {
        authorize: (principalId, action, resource) => this.authorize(principalId, action, resource),
        canRead: (principalId, resource) => this.canRead(principalId, resource),
      },
      providers: this.providerMap,
      assertSecretDriverOwner: (expectedId) => {
        this.secretDriver(expectedId);
      },
      createId: () => this.nextIdentifier("agent"),
      now: () => this.timestamp(),
    });
    this.deployment = new DeploymentService({
      installationId: this.installation.id,
      isRuntimeAdmissionAudit,
      repositories: this.mutations.forRepositories(DEPLOYMENT_REPOSITORIES),
      recoveryRead: (work) =>
        this.state.read((view) => work(selectRepositories(view, DEPLOYMENT_RECOVERY_REPOSITORIES))),
      hasActiveTransaction: () => this.mutations.hasActiveTransaction(),
      poisonAdmission: (error) => this.mutations.poisonAdmission(error),
      authorization: {
        authorize: (principalId, action, resource) => this.authorize(principalId, action, resource),
      },
      computeDriver: () => this.selectedDriver("compute"),
      configurationDriver: () => this.configurationDriver(),
      secretDriver: (expectedId) => this.secretDriver(expectedId),
      sandboxDriver: () => this.sandboxDriver(),
      configurationOperation: (operation) => this.driverOperation(operation),
      secretOperation: (operation) => this.secretOperation(operation),
      providers: this.providerMap,
      loggingLevel: this.loggingLevel,
      createId: () => this.nextIdentifier("agent_revision"),
      now: () => this.timestamp(),
    });
  }

  registerDriver(driver: Driver): Driver {
    return this.drivers.registerDriver(driver);
  }

  selectDriver<Capability extends DriverCapability>(
    selectedCapability: Capability,
    driverId: string,
  ): DriverFor<Capability> {
    return this.drivers.selectDriver(selectedCapability, driverId);
  }

  selectedDriver<Capability extends DriverCapability>(
    selectedCapability: Capability,
  ): DriverFor<Capability> {
    return this.drivers.selectedDriver(selectedCapability);
  }

  async validateProviderConfiguration(): Promise<void> {
    await this.drivers.validateProviderConfiguration(this.providers);
  }

  async getInstallation(principalId: string): Promise<Readonly<Installation>> {
    await this.authorize(principalId, "read", {
      kind: "installation",
      id: this.installation.id,
    });
    return this.installation;
  }

  // TODO: Remove Namespace facade forwarders once remaining callers use the service port.
  async listNamespaces(principalId: string): Promise<readonly Readonly<Namespace>[]> {
    return this.namespace.listNamespaces(principalId);
  }

  async getNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>> {
    return this.namespace.getNamespace(principalId, namespaceId);
  }

  async listAgents(principalId: string, namespaceId: string): Promise<readonly Readonly<Agent>[]> {
    return this.agent.listAgents(principalId, namespaceId);
  }

  async getAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>> {
    return this.agent.getAgent(principalId, namespaceId, agentId);
  }

  // TODO: Remove ServiceAccount facade forwarders once remaining callers use the service port.
  async getServiceAccount(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    return this.serviceAccount.getServiceAccount(principalId, namespaceId, serviceAccountId);
  }

  async listServiceAccounts(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ServiceAccount>[]> {
    return this.serviceAccount.listServiceAccounts(principalId, namespaceId);
  }

  async listRevisions(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<readonly Readonly<AgentRevision>[]> {
    return this.agent.listRevisions(principalId, namespaceId, agentId);
  }

  async getRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevision>> {
    return this.agent.getRevision(principalId, namespaceId, agentId, revisionId);
  }

  async getReadableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection> {
    return this.agent.getReadableActiveAgentRevision(principalId, namespaceId, agentId);
  }

  async getOperableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection> {
    return this.agent.getOperableActiveAgentRevision(principalId, namespaceId, agentId);
  }

  async createNamespace(
    principalId: string,
    input: CreateNamespaceInput,
  ): Promise<Readonly<Namespace>> {
    return this.namespace.createNamespace(principalId, input);
  }

  // TODO: Remove Secret facade forwarders once remaining callers use the service port.
  async createSecret(
    principalId: string,
    input: CreateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    return this.secret.createSecret(principalId, input);
  }

  async readSecret(
    principalId: string,
    namespaceId: string,
    secretId: string,
  ): Promise<Readonly<SecretMetadata>> {
    return this.secret.readSecret(principalId, namespaceId, secretId);
  }

  async updateSecret(
    principalId: string,
    input: UpdateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    return this.secret.updateSecret(principalId, input);
  }

  async deleteSecret(principalId: string, namespaceId: string, secretId: string): Promise<void> {
    return this.secret.deleteSecret(principalId, namespaceId, secretId);
  }

  // TODO: Remove Configuration facade forwarders once remaining callers use the service port.
  async createConfiguration(
    principalId: string,
    input: CreateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    return this.configuration.createConfiguration(principalId, input);
  }

  async createServiceAccount(
    principalId: string,
    input: CreateServiceAccountInput,
  ): Promise<Readonly<ServiceAccount>> {
    return this.serviceAccount.createServiceAccount(principalId, input);
  }

  async createServiceAccountCredential(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    return this.serviceAccount.createServiceAccountCredential(
      principalId,
      namespaceId,
      serviceAccountId,
    );
  }

  async updateServiceAccountCredential(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
    credential: ServiceAccountCredential,
  ): Promise<Readonly<ServiceAccount>> {
    return this.serviceAccount.updateServiceAccountCredential(
      principalId,
      namespaceId,
      serviceAccountId,
      credential,
    );
  }

  async deleteServiceAccount(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<void> {
    return this.serviceAccount.deleteServiceAccount(principalId, namespaceId, serviceAccountId);
  }

  async getConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<Configuration>> {
    return this.configuration.getConfiguration(principalId, namespaceId, configurationId);
  }

  async updateConfiguration(
    principalId: string,
    input: UpdateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    return this.configuration.updateConfiguration(principalId, input);
  }

  async deleteConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<void> {
    return this.configuration.deleteConfiguration(principalId, namespaceId, configurationId);
  }

  async createAgent(principalId: string, input: CreateAgentInput): Promise<Readonly<Agent>> {
    return this.agent.createAgent(principalId, input);
  }

  async updateAgent(principalId: string, input: UpdateAgentInput): Promise<Readonly<Agent>> {
    return this.agent.updateAgent(principalId, input);
  }

  async deployAgent(
    principalId: string,
    input: DeployAgentInput,
    resolveHarness: HarnessResolver,
    admission: DeployAgentAdmissionContext,
  ): Promise<Readonly<AgentRevision>> {
    return this.deployment.deployAgent(principalId, input, resolveHarness, admission);
  }

  /** Resolve only this retained admission after its failed transaction has unwound. */
  async recoverDeployAgent(
    principalId: string,
    input: DeployAgentInput,
    admission: Pick<DeployAgentAdmissionContext, "transitionRef" | "requestId">,
  ): Promise<Readonly<AgentRevision>> {
    return this.deployment.recoverDeployAgent(principalId, input, admission);
  }

  /**
   * Begin logical deletion of one exact, authorized, empty Namespace.
   * Driver effects remain deferred to handleNamespaceLifecycle().
   */
  async deleteNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>> {
    return this.namespace.deleteNamespace(principalId, namespaceId);
  }

  /**
   * Execute one deterministic Namespace lifecycle attempt for a claimed work item.
   * This is a reusable conformance harness, not a polling production worker.
   */
  async handleNamespaceLifecycle(
    actorId: string,
    namespaceId: string,
    target: "ready" | "deleted",
  ): Promise<Readonly<Namespace> | undefined> {
    return this.namespace.handleNamespaceLifecycle(actorId, namespaceId, target);
  }

  /** Stage resources, reconciliation intents, and audit evidence as one unit. */
  async transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    return this.mutations.transact(work);
  }

  /** Compensate a Driver side effect if the owning resource transaction fails. */
  registerRollback(rollback: () => Promise<void>): void {
    this.mutations.registerRollback(rollback);
  }

  pendingOperations(): readonly Readonly<ReconciliationOperation>[] {
    if (this.state instanceof InMemoryPlatformState) return this.state.pendingOperations();
    return Object.freeze([]);
  }

  private async authorize(
    principalId: string,
    action: AuthorizationRequest["action"],
    resource: ResourceRef,
  ): Promise<void> {
    await this.authorization.authorize(principalId, action, resource);
  }

  private async canRead(principalId: string, resource: ResourceRef): Promise<boolean> {
    return this.authorization.canRead(principalId, resource);
  }

  private authorizationAuthority(principalId: string): IAMDriver {
    return this.authorization.authorizationAuthority(principalId);
  }

  private async exactNamespace(
    state: PlatformReadView,
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    const namespace = await state.namespaces.findNamespace(namespaceId);
    if (!namespace)
      throw new ScopeViolationError(
        "The Namespace does not belong to the server-owned Installation.",
      );
    return namespace;
  }

  private async lockNamespace(
    state: PlatformUnitOfWork,
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    const namespace = await state.namespaces.lockNamespace(namespaceId);
    if (!namespace)
      throw new ScopeViolationError(
        "The Namespace does not belong to the server-owned Installation.",
      );
    return namespace;
  }

  private bindings(input: unknown): SecretBindings {
    return configurationBindings(input);
  }

  /** Called under the Namespace lock, also taken by deletion and assignment. */
  private async authorizeBindings(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    bindings: SecretBindings,
  ): Promise<readonly Secret[]> {
    return authorizeConfigurationBindings(
      state,
      principalId,
      namespaceId,
      bindings,
      {
        authorize: (actorId, action, resource) => this.authorize(actorId, action, resource),
      },
      (expectedId) => {
        this.secretDriver(expectedId);
      },
    );
  }

  private secretDriver(expectedId?: string): SecretDriver {
    return this.drivers.secretDriver(expectedId);
  }

  /** Secret SDK error bodies can contain request bytes; never propagate their message or cause. */
  private async secretOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ResourceConflictError)
        throw new ResourceConflictError(
          "The Secret backend identity or concurrency precondition conflicts.",
        );
      if (error instanceof ScopeViolationError)
        throw new ScopeViolationError("The Secret backend ownership could not be verified.");
      throw new DependencyUnavailableError(
        "The Secret storage operation failed or its outcome is unknown.",
      );
    }
  }

  private async exactServiceAccount(
    state: {
      readonly serviceAccounts: Pick<PlatformReadView["serviceAccounts"], "findServiceAccount">;
    },
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    const account = await state.serviceAccounts.findServiceAccount(namespaceId, serviceAccountId);
    if (account === undefined)
      throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
    return account;
  }

  private configurationDriver(): ConfigurationDriver {
    return this.drivers.configurationDriver();
  }

  private serviceAccountDriver(): ServiceAccountDriver | undefined {
    return this.drivers.serviceAccountDriver();
  }

  private sandboxDriver(): SandboxDriver | undefined {
    return this.drivers.sandboxDriver();
  }

  private async driverOperation<T>(
    operation: () => Promise<T>,
    capability: "Configuration" | "ServiceAccount" = "Configuration",
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof DependencyUnavailableError ||
        error instanceof ScopeViolationError ||
        error instanceof ResourceConflictError
      )
        throw error;
      throw new DependencyUnavailableError(`The selected ${capability} Driver is unavailable.`);
    }
  }

  private exactConfiguration(
    configuration: Configuration,
    expected: Pick<
      Configuration,
      "id" | "namespaceId" | "kind" | "generation" | "createdAt" | "secretBindings"
    >,
  ): Readonly<Configuration> {
    return exactConfiguration(configuration, expected);
  }

  private nextIdentifier(kind: ResourceKind): string {
    const prefixes: Record<ResourceKind, string> = {
      installation: "ins",
      namespace: "ns",
      configuration: "cfg",
      service_account: "sa",
      secret: "sec",
      agent: "agt",
      agent_revision: "rev",
    };
    const result = this.identifier
      ? this.identifier(kind)
      : `${prefixes[kind]}_${crypto.randomUUID()}`;
    if (!isNonEmptyString(result))
      throw new ScopeViolationError("The server generated an invalid resource identity.");
    return result;
  }

  private timestamp(): string {
    const now = this.clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime()))
      throw new ScopeViolationError("The controller clock returned an invalid timestamp.");
    return now.toISOString();
  }

  private providerId(value: ProviderRef | undefined, preserve?: ProviderRef): ProviderRef {
    const providerId = value === undefined ? (preserve ?? null) : value;
    assertConfiguredProvider(this.providerMap, providerId, "Provider");
    return providerId;
  }

  private async read<T>(work: (state: PlatformReadView) => Promise<T>): Promise<T> {
    return this.mutations.read(work);
  }

  private async mutate<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    return this.mutations.mutate(work);
  }
}
