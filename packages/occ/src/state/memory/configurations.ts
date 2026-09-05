import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type { SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ResourceConflictError, ScopeViolationError } from "../../errors.ts";
import type {
  MemoryRepositoryFactoryContext,
  RepositoryFactory,
} from "../../ports/repository-factory.ts";
import type {
  ConfigurationOwnership,
  ConfigurationRepository,
} from "../../ports/repositories/configuration.ts";
import type {
  NamespaceRepository,
  PersistedNamespace,
} from "../../ports/repositories/namespace.ts";

interface ConfigurationAgentReference {
  readonly namespaceId: string;
  readonly configurationId: string;
}

/** Live projections of the owner's working maps; only Configuration records are writable here. */
export interface MemoryConfigurationSnapshot {
  readonly installation: Readonly<Installation> | undefined;
  readonly configurations: Map<string, Readonly<ConfigurationOwnership>>;
  readonly namespaces: ReadonlyMap<string, Readonly<Pick<PersistedNamespace, "deletedAt">>>;
  readonly agents: ReadonlyMap<string, ConfigurationAgentReference>;
}

export interface MemoryConfigurationRepositoryContext extends MemoryRepositoryFactoryContext<MemoryConfigurationSnapshot> {
  readonly namespaces: Pick<NamespaceRepository, "lockNamespace">;
  configurationKey(namespaceId: string, configurationId: string): string;
  normalizedSecretBindings(bindings?: SecretBindings): SecretBindings | undefined;
  assertCreateSecretBindingsAvailable(
    namespaceId: string,
    bindings: SecretBindings | undefined,
  ): Promise<void>;
  assertSecretBindingsAvailable(
    namespaceId: string,
    bindings: SecretBindings | undefined,
  ): Promise<void>;
}

/** The owner retains Secret helpers, outward admission, and the single working snapshot. */
export const createMemoryConfigurationRepository: RepositoryFactory<
  MemoryConfigurationRepositoryContext,
  ConfigurationRepository
> = (context) => {
  const {
    snapshot,
    transaction,
    namespaces,
    configurationKey: agentKey,
    normalizedSecretBindings,
    assertCreateSecretBindingsAvailable,
    assertSecretBindingsAvailable,
  } = context;

  function assertInitialized(snapshot: MemoryConfigurationSnapshot): void {
    if (!snapshot.installation)
      throw new ScopeViolationError("The server-owned Installation has not been initialized.");
    if (context.scope.installationId !== snapshot.installation.id)
      throw new ScopeViolationError(
        "The resource does not belong to the server-owned Installation.",
      );
  }

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
      await assertCreateSecretBindingsAvailable(configuration.namespaceId, secretBindings);
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
      await assertSecretBindingsAvailable(namespaceId, secretBindings);
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

  for (const key of Object.keys(configurations) as (keyof ConfigurationRepository)[]) {
    const method = configurations[key];
    Object.defineProperty(configurations, key, {
      value: async (...args: unknown[]) => {
        transaction.assertActive();
        const result = await Reflect.apply(method, configurations, args);
        transaction.assertActive();
        return result;
      },
    });
  }
  return Object.freeze(configurations);
};
