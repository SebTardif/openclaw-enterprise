import { normalizePluginDesiredState } from "@openclaw-enterprise/contracts";
import type {
  AgentRuntimeCredentialsInput,
  AgentRuntimeCredentialStatus,
  ComputeDriver,
} from "@openclaw-enterprise/contracts/drivers/compute";
import type { Agent, AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import type { Namespace } from "@openclaw-enterprise/contracts/resources/namespace";
import type { Secret, SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";
import type { ServiceAccount } from "@openclaw-enterprise/contracts/resources/service-account";
import type { ProviderRef } from "@openclaw-enterprise/contracts/drivers/provider";
import type { PermissionAction } from "@openclaw-enterprise/contracts/identity/authorization";
import type { ResourceRef } from "@openclaw-enterprise/contracts/resources/scope";
import { decodeWorkloadProfileSelectionV1 } from "@openclaw-enterprise/contracts/workload-profile-v1";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { selectRepositories } from "../../application/mutation-context.ts";
import type {
  WorkloadProfileDraftUnitV2,
  WorkloadProfileOwnedOperationV2,
  WorkloadProfileOwnedLeaseV2,
} from "../../workload-profiles/admitted-use.ts";
import { AGENT_REPOSITORIES } from "./port.ts";
import {
  DependencyUnavailableError,
  NamespaceNotReadyError,
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

function reportOwnedFailure(io: WorkloadProfileOwnedOperationV2, error: unknown): void {
  try {
    io.poison(error);
  } catch {
    // Reporting cannot replace the first failure or prevent known cleanup.
    // The original rejection still leaves this callback unsuccessful.
  }
}

/** Transfer one returned lease to its original owner before another wait. */
async function retainDraftSelection(
  source: WorkloadProfileOwnedLeaseV2,
  unit: WorkloadProfileDraftUnitV2,
  io: WorkloadProfileOwnedOperationV2,
): Promise<() => undefined> {
  const releaseSource = source.release;
  if (typeof releaseSource !== "function")
    throw new DependencyUnavailableError("Profile selection cleanup is unavailable.");
  let failed = false;
  let failure: unknown;
  let retained = false;
  let released = false;
  let releasePromise: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const poison = (error: unknown) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
    reportOwnedFailure(io, error);
  };
  const observe = (value: unknown) => {
    const task = Promise.resolve(value).then(
      () => undefined,
      () => undefined,
    );
    pending.add(task);
    void task.then(() => pending.delete(task));
  };
  const release = (): Promise<void> => {
    if (releasePromise === undefined) {
      released = true;
      releasePromise = Promise.resolve().then(async () => {
        while (pending.size !== 0) await Promise.all(pending);
        await releaseSource.call(source);
      });
    }
    return releasePromise;
  };
  try {
    const assertSource = source.assertCurrent;
    if (typeof assertSource !== "function" || typeof unit.retain !== "function")
      throw new DependencyUnavailableError("Profile selection participants are unavailable.");
    const check = (): undefined => {
      try {
        if (failed) throw failure;
        if (released || unit.signal.aborted)
          throw new DependencyUnavailableError("Profile selection custody has ended.");
        const result: unknown = assertSource.call(source);
        if (result !== undefined) {
          observe(result);
          throw new DependencyUnavailableError("Profile selection assertion is invalid.");
        }
        return undefined;
      } catch (error) {
        poison(error);
        throw error;
      }
    };
    check();
    const enrollment: unknown = unit.retain(Object.freeze({ assertCurrent: check, release }));
    if (enrollment !== undefined) {
      observe(enrollment);
      throw new DependencyUnavailableError("Profile selection enrollment is invalid.");
    }
    retained = true;
    check();
    return check;
  } catch (error) {
    poison(error);
    if (!retained) {
      try {
        await release();
      } catch (cleanupError) {
        poison(cleanupError);
      }
    }
    throw error;
  }
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

  async getAgentRuntimeCredentialStatus(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentRuntimeCredentialStatus>> {
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
      return this.runtimeCredentialOperation(async () => {
        const driver = this.runtimeCredentialComputeDriver("status");
        return this.runtimeCredentialStatus(
          await driver.getAgentRuntimeCredentialStatus!({ namespace, agent }),
        );
      });
    });
  }

  async provisionAgentRuntimeCredentials(
    principalId: string,
    namespaceId: string,
    agentId: string,
    input: AgentRuntimeCredentialsInput,
  ): Promise<Readonly<AgentRuntimeCredentialStatus>> {
    const credentials = this.runtimeCredentialsInput(input);
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (!isNonEmptyString(agentId))
      throw new ScopeViolationError("The exact Agent identity is missing.");
    return this.options.repositories.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, namespaceId);
      const agent = await state.agents.lockAgent(namespace.id, agentId);
      if (!agent)
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      await this.options.authorization.authorize(principalId, "read", {
        kind: "agent",
        id: agent.id,
        namespaceId: namespace.id,
      });
      await this.options.authorization.authorize(principalId, "operate", {
        kind: "agent",
        id: agent.id,
        namespaceId: namespace.id,
      });
      if (namespace.status !== "ready") throw new NamespaceNotReadyError();
      const configuration = await state.configurations.lockConfiguration(
        namespace.id,
        agent.configurationId,
      );
      if (!configuration || configuration.kind !== "agent")
        throw new ScopeViolationError(
          "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
        );
      if (agent.workloadProfileSelection !== undefined)
        throw new ResourceConflictError(
          "Legacy per-Agent runtime credential provisioning requires an Agent without a workload profile selection.",
        );
      if (agent.serviceAccountId !== undefined)
        throw new ResourceConflictError(
          "Legacy per-Agent runtime credential provisioning requires an Agent without a ServiceAccount.",
        );
      const secretBindings = configurationBindings(configuration.secretBindings);
      if (secretBindings.OPENAI_API_KEY !== undefined)
        throw new ResourceConflictError(
          "Legacy per-Agent runtime credential provisioning requires an Agent without a model Secret binding.",
        );
      if ((await state.revisions.listRevisions(namespace.id, agent.id)).length > 0)
        throw new ResourceConflictError(
          "Runtime credentials can be provisioned only before the Agent has historical revisions.",
        );
      return this.runtimeCredentialOperation(async () => {
        const driver = this.runtimeCredentialComputeDriver("provision");
        return this.runtimeCredentialStatus(
          await driver.provisionAgentRuntimeCredentials!({ namespace, agent }, credentials),
        );
      });
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
    const plugins = normalizePluginDesiredState(input.plugins, (message) => {
      throw new ScopeViolationError(message);
    });
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
        ...(plugins === undefined ? {} : { plugins }),
        maximumExecutionMs:
          input.maximumExecutionMs === undefined ? null : input.maximumExecutionMs,
        servicePrincipalId: `service-agent-${agentId}`,
        createdAt: this.options.now(),
      });
      return agent;
    });
  }

  async updateAgent(principalId: string, input: UpdateAgentInput): Promise<Readonly<Agent>> {
    const plugins = normalizePluginDesiredState(input.plugins, (message) => {
      throw new ScopeViolationError(message);
    });
    const selectingProfile = Object.hasOwn(input, "workloadProfileSelection");
    if (selectingProfile) {
      const selected = decodeWorkloadProfileSelectionV1(input.workloadProfileSelection);
      if (selected.kind !== "valid")
        throw new ScopeViolationError("The exact workload profile selection is invalid.");
      // The owner receives the same immutable operands used after every await.
      input = Object.freeze({
        namespaceId: input.namespaceId,
        agentId: input.agentId,
        configurationId: input.configurationId,
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        ...(input.serviceAccountId === undefined
          ? {}
          : { serviceAccountId: input.serviceAccountId }),
        ...(input.executionMode === undefined ? {} : { executionMode: input.executionMode }),
        ...(input.maximumExecutionMs === undefined
          ? {}
          : { maximumExecutionMs: input.maximumExecutionMs }),
        ...(plugins === undefined ? {} : { plugins }),
        workloadProfileSelection: selected.value,
      });
    }
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
    const profiles = this.options.workloadProfiles;
    return this.options.repositories.mutate(async (selectedState) => {
      const update = async (
        state: typeof selectedState,
        owned?: {
          readonly unit: WorkloadProfileDraftUnitV2;
          readonly io: WorkloadProfileOwnedOperationV2;
        },
      ): Promise<Readonly<Agent>> => {
        owned?.io.assertActive();
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
        let checkSelection: (() => undefined) | undefined;
        if (selectingProfile) {
          if (owned === undefined || profiles === undefined)
            throw new DependencyUnavailableError(
              "The original profile selection owner is unavailable.",
            );
          const { unit, io } = owned;
          io.assertActive();
          if (
            unit.kind !== "agent-selection" ||
            unit.namespaceId !== namespace.id ||
            unit.agentId !== agent.id ||
            unit.signal.aborted
          )
            throw new ScopeViolationError("The profile selection unit does not match the Agent.");
          checkSelection = await retainDraftSelection(
            await profiles.use.validateSelectionLocked(
              {
                installationId: unit.installationId,
                namespaceId: namespace.id,
                agentId: agent.id,
                selection: input.workloadProfileSelection!,
              },
              unit,
              io,
            ),
            unit,
            io,
          );
          io.assertActive();
          checkSelection();
        }
        const updated = await state.agents.updateConfiguration(
          namespace.id,
          agent.id,
          input.configurationId,
          input.executionMode,
          input.serviceAccountId,
          input.providerId === undefined ? undefined : providerId,
          selectingProfile ? input.workloadProfileSelection! : undefined,
          input.maximumExecutionMs,
          plugins,
        );
        owned?.io.assertActive();
        checkSelection?.();
        if (!updated)
          throw new ResourceConflictError("The Agent Configuration changed during its update.");
        if (selectingProfile) {
          const selected = decodeWorkloadProfileSelectionV1(updated.workloadProfileSelection);
          const expected = input.workloadProfileSelection!;
          if (
            selected.kind !== "valid" ||
            selected.value.manifestRef !== expected.manifestRef ||
            selected.value.manifestDigest !== expected.manifestDigest ||
            selected.value.admissionRef !== expected.admissionRef ||
            selected.value.admissionVersion !== expected.admissionVersion
          )
            throw new ResourceConflictError(
              "The stored workload profile selection differs from the update.",
            );
        }
        return updated;
      };
      if (!selectingProfile) return update(selectedState);
      if (profiles === undefined)
        throw new DependencyUnavailableError(
          "The original profile selection owner is unavailable.",
        );
      const invocation = await profiles.invocations.forCurrentInvocation();
      return profiles.enrollment.withDraft(
        invocation,
        Object.freeze([principalId, input] as const),
        async (unit, io) => {
          try {
            return await update(selectRepositories(unit.platform, AGENT_REPOSITORIES.mutate), {
              unit,
              io,
            });
          } catch (error) {
            reportOwnedFailure(io, error);
            throw error;
          }
        },
      );
    });
  }

  private validateRuntimeCredentialValue(value: unknown): asserts value is string {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\u0000") ||
      /[\uD800-\uDFFF]/u.test(value) ||
      Buffer.byteLength(value, "utf8") > 65_536
    )
      throw new ScopeViolationError(
        "Agent runtime credential values must be nonempty UTF-8, without NUL, and at most 65536 bytes.",
      );
  }

  private runtimeCredentialsInput(
    input: AgentRuntimeCredentialsInput,
  ): AgentRuntimeCredentialsInput {
    const candidate = asRecord(input);
    if (candidate === undefined)
      throw new ScopeViolationError("Agent runtime credentials must be a JSON object.");
    const keys = Object.keys(candidate);
    if (!keys.every((key) => key === "modelApiKey" || key === "slack"))
      throw new ScopeViolationError("Agent runtime credentials contain unsupported fields.");
    if (candidate.modelApiKey !== undefined)
      this.validateRuntimeCredentialValue(candidate.modelApiKey);
    let slack: AgentRuntimeCredentialsInput["slack"];
    if (candidate.slack !== undefined) {
      const slackCandidate = asRecord(candidate.slack);
      if (
        slackCandidate === undefined ||
        !["appToken", "botToken"].every((key) => Object.hasOwn(slackCandidate, key)) ||
        !Object.keys(slackCandidate).every((key) => key === "appToken" || key === "botToken")
      )
        throw new ScopeViolationError("Agent Slack runtime credentials are invalid.");
      this.validateRuntimeCredentialValue(slackCandidate.appToken);
      this.validateRuntimeCredentialValue(slackCandidate.botToken);
      slack = {
        appToken: slackCandidate.appToken,
        botToken: slackCandidate.botToken,
      };
    }
    return Object.freeze({
      ...(candidate.modelApiKey === undefined ? {} : { modelApiKey: candidate.modelApiKey }),
      ...(slack === undefined ? {} : { slack: Object.freeze(slack) }),
    });
  }

  private runtimeCredentialStatus(status: unknown): Readonly<AgentRuntimeCredentialStatus> {
    const candidate = asRecord(status);
    const transportConfigured = candidate?.transportConfigured;
    const modelConfigured = candidate?.modelConfigured;
    const slackConfigured = candidate?.slackConfigured;
    if (
      typeof transportConfigured !== "boolean" ||
      typeof modelConfigured !== "boolean" ||
      typeof slackConfigured !== "boolean"
    )
      throw new DependencyUnavailableError(
        "The selected compute Driver returned invalid runtime credential metadata.",
      );
    return Object.freeze({ transportConfigured, modelConfigured, slackConfigured });
  }

  private runtimeCredentialComputeDriver(operation: "status" | "provision"): ComputeDriver {
    const driver = this.options.runtimeCredentialComputeDriver?.(operation);
    const method =
      operation === "status"
        ? driver?.getAgentRuntimeCredentialStatus
        : driver?.provisionAgentRuntimeCredentials;
    if (driver === undefined || typeof method !== "function")
      throw new DependencyUnavailableError(
        "The selected compute Driver does not support Agent runtime credentials.",
      );
    return driver;
  }

  /** Runtime credential driver errors can contain secret bytes; never propagate them. */
  private async runtimeCredentialOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new DependencyUnavailableError(
        "The Agent runtime credential operation failed or its outcome is unknown.",
      );
    }
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
