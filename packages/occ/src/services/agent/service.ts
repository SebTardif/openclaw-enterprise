import type { Agent, AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import type { Namespace } from "@openclaw-enterprise/contracts/resources/namespace";
import type { Secret, SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";
import type { ServiceAccount } from "@openclaw-enterprise/contracts/resources/service-account";
import type { ProviderRef } from "@openclaw-enterprise/contracts/drivers/provider";
import type { PermissionAction } from "@openclaw-enterprise/contracts/identity/authorization";
import type { ResourceRef } from "@openclaw-enterprise/contracts/resources/scope";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../errors.ts";
import type {
  NamespaceReadRepository,
  NamespaceRepository,
} from "../../ports/repositories/namespace.ts";
import type { SecretRepository } from "../../ports/repositories/secret.ts";
import type { ServiceAccountReadRepository } from "../../ports/repositories/service-account.ts";
import { assertConfiguredProvider } from "../../providers.ts";
import { authorizeConfigurationBindings, configurationBindings } from "../configuration/service.ts";
import { validExecutionMode, validateModelBinding } from "./model-binding.ts";
import type {
  ActiveAgentRevisionSelection,
  AgentServiceOptions,
  AgentServicePort,
  CreateAgentInput,
  UpdateAgentInput,
} from "./port.ts";

function validName(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= 200;
}

/** Agent drafts and reads share the composition owner's transaction and selected authority. */
export class AgentService implements AgentServicePort {
  private readonly options: AgentServiceOptions;

  constructor(options: AgentServiceOptions) {
    this.options = options;
  }

  private async getNamespace(
    principalId: string,
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    await this.options.authorization.authorize(principalId, "read", {
      kind: "namespace",
      id: namespaceId,
      namespaceId,
    });
    return this.options.repositories.read(async (state) => this.exactNamespace(state, namespaceId));
  }

  async listAgents(principalId: string, namespaceId: string): Promise<readonly Readonly<Agent>[]> {
    const namespace = await this.getNamespace(principalId, namespaceId);
    return this.options.repositories.read(async (state) => {
      const readable: Readonly<Agent>[] = [];
      for (const agent of await state.agents.listAgents(namespace.id)) {
        if (
          await this.options.authorization.canRead(principalId, {
            kind: "agent",
            id: agent.id,
            namespaceId: namespace.id,
          })
        )
          readable.push(agent);
      }
      return Object.freeze(readable);
    });
  }

  async getAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (!isNonEmptyString(agentId))
      throw new ScopeViolationError("The exact Agent identity is missing.");
    await this.options.authorization.authorize(principalId, "read", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    return this.options.repositories.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (!agent)
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      return agent;
    });
  }

  async listRevisions(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<readonly Readonly<AgentRevision>[]> {
    const agent = await this.getAgent(principalId, namespaceId, agentId);
    return this.options.repositories.read(async (state) => {
      const readable: Readonly<AgentRevision>[] = [];
      for (const revision of await state.revisions.listRevisions(agent.namespaceId, agent.id)) {
        if (
          await this.options.authorization.canRead(principalId, {
            kind: "agent_revision",
            id: revision.id,
            namespaceId: agent.namespaceId,
          })
        )
          readable.push(revision);
      }
      return Object.freeze(readable);
    });
  }

  async getRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevision>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (!isNonEmptyString(agentId))
      throw new ScopeViolationError("The exact Agent identity is missing.");
    if (!isNonEmptyString(revisionId))
      throw new ScopeViolationError("The exact AgentRevision identity is missing.");
    await this.options.authorization.authorize(principalId, "read", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    return this.options.repositories.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (!agent)
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      await this.options.authorization.authorize(principalId, "read", {
        kind: "agent_revision",
        id: revisionId,
        namespaceId: namespace.id,
      });
      const revision = await state.revisions.findRevision(namespace.id, agent.id, revisionId);
      if (!revision)
        throw new ScopeViolationError(
          "The AgentRevision does not belong to the exact Agent and Namespace.",
        );
      return revision;
    });
  }

  async getReadableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection> {
    return this.getAuthorizedActiveAgentRevision(principalId, namespaceId, agentId, "read");
  }

  async getOperableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection> {
    return this.getAuthorizedActiveAgentRevision(principalId, namespaceId, agentId, "operate");
  }

  private async getAuthorizedActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
    action: PermissionAction,
  ): Promise<ActiveAgentRevisionSelection> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (!isNonEmptyString(agentId))
      throw new ScopeViolationError("The exact Agent identity is missing.");
    await this.options.authorization.authorize(principalId, action, {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    return this.options.repositories.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (!agent)
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      if (!isNonEmptyString(agent.activeRevisionId))
        throw new DependencyUnavailableError("The Agent has no active gateway revision.");
      const revision = await state.revisions.findRevision(
        namespace.id,
        agent.id,
        agent.activeRevisionId,
      );
      if (!revision)
        throw new DependencyUnavailableError("The active Agent revision is unavailable.");
      return Object.freeze({ agent, revision });
    });
  }

  async createAgent(principalId: string, input: CreateAgentInput): Promise<Readonly<Agent>> {
    if (!validName(input.name)) throw new ScopeViolationError("The Agent name is invalid.");
    if (!isNonEmptyString(input.configurationId))
      throw new ScopeViolationError("The exact Agent Configuration identity is missing.");
    if (input.serviceAccountId !== undefined && !isNonEmptyString(input.serviceAccountId))
      throw new ScopeViolationError("The exact Agent ServiceAccount identity is missing.");
    const executionMode = input.executionMode ?? "embedded";
    if (!validExecutionMode(executionMode))
      throw new ScopeViolationError("The Agent Harness execution mode is invalid.");
    const providerId = this.providerId(input.providerId);
    return this.options.repositories.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      if (namespace.status !== "provisioning" && namespace.status !== "ready")
        throw new ResourceConflictError("The Namespace does not accept new Agents.");
      const target: ResourceRef = {
        kind: "agent",
        id: namespace.id,
        namespaceId: namespace.id,
      };
      await this.options.authorization.authorize(principalId, "create", target);
      await this.options.authorization.authorize(principalId, "read", {
        kind: "configuration",
        id: input.configurationId,
        namespaceId: namespace.id,
      });
      const configuration = await state.configurations.findConfiguration(
        namespace.id,
        input.configurationId,
      );
      if (!configuration || configuration.kind !== "agent")
        throw new ScopeViolationError(
          "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
        );
      if (input.serviceAccountId !== undefined) {
        await this.options.authorization.authorize(principalId, "read", {
          kind: "service_account",
          id: input.serviceAccountId,
          namespaceId: namespace.id,
        });
        await this.exactServiceAccount(state, namespace.id, input.serviceAccountId);
      }
      const agentId = this.options.createId();
      await this.authorizeBindings(
        state,
        principalId,
        namespace.id,
        configurationBindings(configuration.secretBindings),
      );

      const agent = await state.agents.createAgent({
        id: agentId,
        namespaceId: namespace.id,
        name: input.name,
        configurationId: input.configurationId,
        providerId,
        ...(input.serviceAccountId === undefined
          ? {}
          : { serviceAccountId: input.serviceAccountId }),
        executionMode,
        servicePrincipalId: `service-agent-${agentId}`,
        createdAt: this.options.now(),
      });
      return agent;
    });
  }

  async updateAgent(principalId: string, input: UpdateAgentInput): Promise<Readonly<Agent>> {
    if (!isNonEmptyString(input.agentId))
      throw new ScopeViolationError("The exact Agent identity is missing.");
    if (!isNonEmptyString(input.configurationId))
      throw new ScopeViolationError("The exact Agent Configuration identity is missing.");
    if (
      input.serviceAccountId !== undefined &&
      input.serviceAccountId !== null &&
      !isNonEmptyString(input.serviceAccountId)
    )
      throw new ScopeViolationError("The exact Agent ServiceAccount identity is missing.");
    if (input.executionMode !== undefined && !validExecutionMode(input.executionMode))
      throw new ScopeViolationError("The Agent Harness execution mode is invalid.");
    return this.options.repositories.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      const agent = await state.agents.lockAgent(namespace.id, input.agentId);
      if (!agent)
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      await this.options.authorization.authorize(principalId, "update", {
        kind: "agent",
        id: agent.id,
        namespaceId: namespace.id,
      });
      await this.options.authorization.authorize(principalId, "read", {
        kind: "configuration",
        id: input.configurationId,
        namespaceId: namespace.id,
      });
      const configuration = await state.configurations.findConfiguration(
        namespace.id,
        input.configurationId,
      );
      if (!configuration || configuration.kind !== "agent")
        throw new ScopeViolationError(
          "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
        );
      if (agent.serviceAccountId !== undefined) {
        await this.options.authorization.authorize(principalId, "read", {
          kind: "service_account",
          id: agent.serviceAccountId,
          namespaceId: namespace.id,
        });
        await this.exactServiceAccount(state, namespace.id, agent.serviceAccountId);
      }
      if (
        input.serviceAccountId !== undefined &&
        input.serviceAccountId !== null &&
        input.serviceAccountId !== agent.serviceAccountId
      ) {
        await this.options.authorization.authorize(principalId, "read", {
          kind: "service_account",
          id: input.serviceAccountId,
          namespaceId: namespace.id,
        });
        await this.exactServiceAccount(state, namespace.id, input.serviceAccountId);
      }
      const secretBindings = configurationBindings(configuration.secretBindings);
      await this.authorizeBindings(state, principalId, namespace.id, secretBindings);
      const providerId = this.providerId(input.providerId, agent.providerId);
      validateModelBinding(
        secretBindings,
        input.executionMode ?? agent.executionMode,
        input.serviceAccountId === null
          ? undefined
          : (input.serviceAccountId ?? agent.serviceAccountId),
      );
      const updated = await state.agents.updateConfiguration(
        namespace.id,
        agent.id,
        input.configurationId,
        input.executionMode,
        input.serviceAccountId,
        input.providerId === undefined ? undefined : providerId,
      );
      if (!updated)
        throw new ResourceConflictError("The Agent Configuration changed during its update.");
      return updated;
    });
  }

  private async exactNamespace(
    state: { readonly namespaces: Pick<NamespaceReadRepository, "findNamespace"> },
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
        this.options.assertSecretDriverOwner(expectedId);
      },
    );
  }

  private async exactServiceAccount(
    state: { readonly serviceAccounts: Pick<ServiceAccountReadRepository, "findServiceAccount"> },
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    const account = await state.serviceAccounts.findServiceAccount(namespaceId, serviceAccountId);
    if (account === undefined)
      throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
    return account;
  }

  private providerId(value: ProviderRef | undefined, preserve?: ProviderRef): ProviderRef {
    const providerId = value === undefined ? (preserve ?? null) : value;
    assertConfiguredProvider(this.options.providers, providerId, "Provider");
    return providerId;
  }
}
