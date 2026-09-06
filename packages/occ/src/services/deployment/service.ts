import type { AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import type { Namespace } from "@openclaw-enterprise/contracts/resources/namespace";
import type { Secret, SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";
import type { ServiceAccountRevision } from "@openclaw-enterprise/contracts/resources/service-account";
import type { ComputeDriver } from "@openclaw-enterprise/contracts/drivers/compute";
import type { ProviderRef } from "@openclaw-enterprise/contracts/drivers/provider";
import { admitLoggingConfiguration } from "@openclaw-enterprise/contracts/logging";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  DependencyUnavailableError,
  NamespaceNotReadyError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../errors.ts";
import type { NamespaceRepository } from "../../ports/repositories/namespace.ts";
import type { SecretRepository } from "../../ports/repositories/secret.ts";
import {
  assertConfiguredProvider,
  validateServiceAccountProviderBinding,
} from "../../providers.ts";
import {
  authorizeConfigurationBindings,
  configurationBindings,
  exactConfiguration,
} from "../configuration/service.ts";
import { validExecutionMode, validateModelBinding } from "../agent/model-binding.ts";
import { frozenRevision, frozenValues, resolveConfiguredHarnessId } from "./configuration.ts";
import type {
  DeploymentServiceOptions,
  DeploymentServicePort,
  DeployAgentInput,
  DeployAgentAdmissionContext,
  HarnessResolver,
  AcceptedDeployOperation,
  AcceptedDeployOperationInput,
} from "./port.ts";

function isDeploymentOperationRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function validateDeployLocator(
  context: Pick<DeployAgentAdmissionContext, "transitionRef" | "requestId">,
): void {
  if (
    context === undefined ||
    context === null ||
    !isDeploymentOperationRef(context.transitionRef) ||
    typeof context.requestId !== "string" ||
    context.requestId.length < 1 ||
    context.requestId.length > 200 ||
    !/^[A-Za-z0-9._:/-]+$/.test(context.requestId)
  )
    throw new ScopeViolationError(
      "Deployment requires a retained trusted admission locator and sanitized request ID.",
    );
}

/** Admission uses one shared mutation unit, with explicit retained-locator recovery. */
export class DeploymentService implements DeploymentServicePort {
  private readonly options: DeploymentServiceOptions;

  constructor(options: DeploymentServiceOptions) {
    this.options = options;
  }

  async deployAgent(
    principalId: string,
    input: DeployAgentInput,
    resolveHarness: HarnessResolver,
    admission: DeployAgentAdmissionContext,
  ): Promise<Readonly<AgentRevision>> {
    validateDeployLocator(admission);
    if (typeof admission.createAuditEvent !== "function")
      throw new ScopeViolationError("Deployment requires a trusted admission audit factory.");
    if (!isNonEmptyString(input.agentId))
      throw new ScopeViolationError("The exact Agent identity is missing.");
    const compareGeneration = Object.hasOwn(input, "expectedLifecycleGeneration");
    const expectedGeneration = input.expectedLifecycleGeneration;
    return this.options.repositories
      .mutate(async (state) => {
        if (
          compareGeneration &&
          expectedGeneration !== null &&
          (!Number.isSafeInteger(expectedGeneration) || (expectedGeneration ?? 0) < 1)
        )
          throw new ScopeViolationError(
            "The expected lifecycle generation must be null or a positive safe integer.",
          );
        const namespace = await this.lockNamespace(state, input.namespaceId);
        const agent = await state.agents.findAgent(namespace.id, input.agentId);
        if (!agent)
          throw new ScopeViolationError(
            "The Agent does not belong to the exact Installation and Namespace.",
          );
        await this.options.authorization.authorize(principalId, "deploy", {
          kind: "agent",
          id: agent.id,
          namespaceId: namespace.id,
        });
        if (namespace.status !== "ready") throw new NamespaceNotReadyError();
        if (typeof resolveHarness !== "function")
          throw new DependencyUnavailableError("The selected Harness descriptor is unavailable.");

        let compute: ComputeDriver;
        try {
          compute = this.options.computeDriver();
        } catch {
          throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
        }
        const sandbox = this.options.sandboxDriver();

        const lockedAgent = await state.agents.lockAgent(namespace.id, agent.id);
        if (!lockedAgent || !isNonEmptyString(lockedAgent.servicePrincipalId))
          throw new ScopeViolationError(
            "The Agent or its service principal does not belong to the exact Namespace.",
          );
        const scope = { namespaceId: namespace.id, agentId: lockedAgent.id };
        const head = await state.runtimeAssignments.findRuntimeIntentHead(scope);
        if (compareGeneration && expectedGeneration !== (head?.generation ?? null))
          throw new ResourceConflictError("The lifecycle generation does not match.");
        if (head !== undefined && head.desiredMode !== "running")
          throw new ResourceConflictError("Deploy cannot resume a disabled or stopped Agent.");
        if (head?.generation === Number.MAX_SAFE_INTEGER)
          throw new ResourceConflictError("The lifecycle generation is exhausted.");
        const providerId = this.providerId(lockedAgent.providerId);
        if (sandbox !== undefined && lockedAgent.executionMode !== "dedicated")
          throw new ScopeViolationError(
            "The selected Sandbox Driver supports only dedicated Harness execution.",
          );
        let serviceAccount: ServiceAccountRevision | undefined;
        if (lockedAgent.serviceAccountId !== undefined) {
          await this.options.authorization.authorize(principalId, "read", {
            kind: "service_account",
            id: lockedAgent.serviceAccountId,
            namespaceId: namespace.id,
          });
          const account = await state.serviceAccounts.lockServiceAccount(
            namespace.id,
            lockedAgent.serviceAccountId,
          );
          if (account === undefined)
            throw new ScopeViolationError(
              "The ServiceAccount does not belong to the exact Namespace.",
            );
          const credential = account.credential;
          if (credential === undefined)
            throw new ResourceConflictError("The associated ServiceAccount has no credential.");
          if (credential.kind !== "api_key" && credential.kind !== "access_token")
            throw new ResourceConflictError(
              "OAuth ServiceAccount credentials are not supported for deployment.",
            );
          if (credential.kind === "access_token") {
            validateServiceAccountProviderBinding(
              this.options.providers,
              providerId,
              await state.serviceAccounts.findServiceAccountProviderBinding(
                namespace.id,
                account.id,
              ),
            );
          }
          serviceAccount = immutableCopy({
            id: account.id,
            credential: { kind: credential.kind, secretRef: credential.secretRef },
          });
        }
        await this.options.authorization.authorize(principalId, "read", {
          kind: "configuration",
          id: lockedAgent.configurationId,
          namespaceId: namespace.id,
        });
        const metadata = await state.configurations.lockConfiguration(
          namespace.id,
          lockedAgent.configurationId,
        );
        if (!metadata || metadata.kind !== "agent")
          throw new ScopeViolationError(
            "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
          );
        const secretBindings = configurationBindings(metadata.secretBindings);
        const sources = await this.authorizeBindings(
          state,
          principalId,
          namespace.id,
          secretBindings,
        );
        validateModelBinding(
          secretBindings,
          lockedAgent.executionMode,
          lockedAgent.serviceAccountId,
        );
        const secretDriver =
          Object.keys(secretBindings).length === 0 ? undefined : this.options.secretDriver();
        for (const secret of sources) {
          await this.options.authorization.authorize(lockedAgent.servicePrincipalId, "operate", {
            kind: "secret",
            id: secret.id,
            namespaceId: namespace.id,
          });
          const resolved = await this.options.secretOperation(() => secretDriver!.resolve(secret));
          if (
            Object.keys(secret.backendRef).some(
              (key) =>
                resolved[key as keyof typeof resolved] !==
                secret.backendRef[key as keyof typeof secret.backendRef],
            )
          )
            throw new DependencyUnavailableError("The Secret backend identity changed.");
        }
        const configurationDriver = this.options.configurationDriver();
        const configuration = exactConfiguration(
          await this.options.configurationOperation(() =>
            configurationDriver.read({ id: metadata.id, namespaceId: namespace.id }),
          ),
          metadata,
        );
        const sandboxConfiguration =
          sandbox?.configureAgent !== undefined
            ? frozenValues(sandbox.configureAgent(frozenValues(configuration.values)))
            : configuration.values;
        const admittedConfiguration = frozenValues(
          admitLoggingConfiguration(sandboxConfiguration, this.options.loggingLevel),
        );
        await configurationDriver.validate({ ...configuration, values: admittedConfiguration });
        if (!validExecutionMode(lockedAgent.executionMode))
          throw new ScopeViolationError("The persisted Agent Harness execution mode is invalid.");
        const configuredHarnessId = resolveConfiguredHarnessId(admittedConfiguration);
        const approvedHarness = resolveHarness(configuredHarnessId, lockedAgent.executionMode);
        if (
          approvedHarness === undefined ||
          !isNonEmptyString(approvedHarness.id) ||
          !isNonEmptyString(approvedHarness.version)
        ) {
          throw new DependencyUnavailableError("The selected Harness runtime is not approved.");
        }
        if (approvedHarness.id !== configuredHarnessId)
          throw new ScopeViolationError("The approved Harness does not match the native runtime.");
        if (
          (approvedHarness.id === "openclaw" && lockedAgent.executionMode !== "embedded") ||
          (approvedHarness.id === "codex" && lockedAgent.executionMode !== "dedicated") ||
          (approvedHarness.id !== "openclaw" && approvedHarness.id !== "codex")
        ) {
          throw new ScopeViolationError(
            "The selected Harness does not support this execution mode.",
          );
        }
        if (
          serviceAccount?.credential.kind === "access_token" &&
          (approvedHarness.id !== "codex" || lockedAgent.executionMode !== "dedicated")
        ) {
          throw new ResourceConflictError(
            "ServiceAccount access-token credentials require the dedicated Codex Harness.",
          );
        }
        const previous = await state.revisions.listRevisions(namespace.id, lockedAgent.id);
        const revision = await state.revisions.createRevision(
          frozenRevision({
            id: this.options.createId(),
            namespaceId: namespace.id,
            agentId: lockedAgent.id,
            revision: previous.length + 1,
            providerId,
            configurationId: configuration.id,
            configurationKind: configuration.kind,
            configurationGeneration: configuration.generation,
            configuration: admittedConfiguration,
            harness: {
              id: approvedHarness.id,
              version: approvedHarness.version,
              mode: lockedAgent.executionMode,
            },
            compute: { id: compute.id, implementation: compute.implementation },
            ...(sandbox === undefined ? {} : { sandboxDriverId: sandbox.id }),
            ...(secretDriver === undefined
              ? {}
              : { secretDriverId: secretDriver.id, secretBindings }),
            ...(serviceAccount === undefined ? {} : { serviceAccount }),
            servicePrincipalId: lockedAgent.servicePrincipalId,
            createdAt: this.options.now(),
          }),
        );
        // The synchronous trusted factory runs before the intent write. No Driver
        // calls intervene in the intent, exact audit, admission identity, and work unit.
        const audit = immutableCopy(admission.createAuditEvent(revision));
        const attribution = { actorId: principalId, requestId: admission.requestId };
        const intent =
          head === undefined
            ? await state.runtimeAssignments.initializeRuntimeIntent(
                scope,
                revision.id,
                admission.transitionRef,
                attribution,
              )
            : await state.runtimeAssignments.advanceRuntimeIntent(
                scope,
                head.generation,
                { desiredMode: "running", revisionId: revision.id },
                admission.transitionRef,
                attribution,
              );
        if (!this.options.isRuntimeAdmissionAudit(audit, intent))
          throw new ScopeViolationError(
            "The deploy audit does not match its exact admitted revision and actor.",
          );
        await state.audit.append(audit);
        await state.runtimeAdmissions.recordAdmission({
          ...scope,
          revisionId: revision.id,
          runtimeTransitionRef: intent.transitionRef,
          lifecycleGeneration: intent.generation,
          auditEventId: audit.id,
        });
        // Accepted deployments always require original reconciliation, including
        // direct domain callers and controllers suppressing unrelated operations.
        await state.operations.append({
          kind: "agent_revision",
          action: "reconcile",
          namespaceId: namespace.id,
          resourceId: revision.id,
          actorId: principalId,
          runtimeTransitionRef: intent.transitionRef,
          lifecycleGeneration: intent.generation,
        });
        return revision;
      })
      .catch((error: unknown) => {
        // A caller may catch a domain rejection inside its outer transaction. The
        // entire admission unit must still roll back, including memory mutations
        // and errors that did not abort the PostgreSQL transaction themselves.
        this.options.poisonAdmission(error);
        throw error;
      });
  }

  /** Read only an original committed deploy, independently of its current head or work outcome. */
  async getAcceptedDeployOperation(
    principalId: string,
    input: AcceptedDeployOperationInput,
  ): Promise<Readonly<AcceptedDeployOperation>> {
    // Retain the same exact primitives through both authorization checks and storage reads.
    const { namespaceId, agentId, operationRef } = input;
    if (
      !isNonEmptyString(namespaceId) ||
      !isNonEmptyString(agentId) ||
      !isDeploymentOperationRef(operationRef)
    )
      throw new ScopeViolationError("The exact deployment operation locator is invalid.");
    if (this.options.hasActiveTransaction())
      throw new DependencyUnavailableError(
        "Deployment operation readback requires a fresh read transaction.",
      );
    const resource = { kind: "agent" as const, id: agentId, namespaceId };
    await this.options.authorization.authorize(principalId, "read", resource);
    let operation: Readonly<AcceptedDeployOperation> | undefined;
    try {
      operation = await this.options.recoveryRead(async (view) => {
        if ((await view.installations.getInstallation())?.id !== this.options.installationId)
          return undefined;
        if ((await view.agents.findAgent(namespaceId, agentId)) === undefined) return undefined;
        const scope = { namespaceId, agentId };
        const intent = await view.runtimeAssignments.findRuntimeIntent(scope, operationRef);
        if (intent === undefined || intent.desiredMode !== "running") return undefined;
        // Stored attribution proves original acceptance; it does not authorize this reader.
        const revision = await view.runtimeAdmissions.findCommittedAdmission(scope, operationRef, {
          actorId: intent.actorId,
          requestId: intent.requestId,
        });
        if (revision === undefined || revision.id !== intent.revisionId) return undefined;
        // The original admission proof requires the deploy audit and original reconcile work.
        // This format's sole deploy writer admits saved draft, never retained-revision resume.
        return immutableCopy({
          operationRef,
          kind: "deploy" as const,
          revisionSource: "saved-draft" as const,
          lifecycleGeneration: intent.generation,
          desiredMode: "running" as const,
          acceptedAt: intent.createdAt,
          requestedRevisionId: revision.id,
        });
      });
    } catch {
      throw new DependencyUnavailableError("The deployment operation could not be verified.");
    }
    await this.options.authorization.authorize(principalId, "read", resource);
    if (operation === undefined)
      throw new ScopeViolationError("The accepted deployment does not belong to the exact Agent.");
    return operation;
  }

  /** Resolve only this retained admission after its failed transaction has unwound. */
  async recoverDeployAgent(
    principalId: string,
    input: DeployAgentInput,
    admission: Pick<DeployAgentAdmissionContext, "transitionRef" | "requestId">,
  ): Promise<Readonly<AgentRevision>> {
    validateDeployLocator(admission);
    if (this.options.hasActiveTransaction())
      throw new DependencyUnavailableError(
        "Deployment acknowledgement recovery requires a fresh read transaction.",
      );
    try {
      const revision = await this.options.recoveryRead(async (view) => {
        const installation = await view.installations.getInstallation();
        if (installation?.id !== this.options.installationId) return undefined;
        return view.runtimeAdmissions.findCommittedAdmission(input, admission.transitionRef, {
          actorId: principalId,
          requestId: admission.requestId,
        });
      });
      if (revision !== undefined) return revision;
    } catch {
      // A failed or unavailable proof does not establish rollback or authorize a retry.
    }
    throw new DependencyUnavailableError("The deployment acknowledgement could not be verified.");
  }

  private async lockNamespace(
    state: { readonly namespaces: Pick<NamespaceRepository, "lockNamespace"> },
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

  private async authorizeBindings(
    state: { readonly secrets: Pick<SecretRepository, "lockSecret"> },
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
        authorize: (actorId, action, resource) =>
          this.options.authorization.authorize(actorId, action, resource),
      },
      (expectedId) => {
        this.options.secretDriver(expectedId);
      },
    );
  }

  private providerId(value: ProviderRef | undefined, preserve?: ProviderRef): ProviderRef {
    const providerId = value === undefined ? (preserve ?? null) : value;
    assertConfiguredProvider(this.options.providers, providerId, "Provider");
    return providerId;
  }
}
