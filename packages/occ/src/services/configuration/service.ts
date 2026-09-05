import type {
  Configuration,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts/resources/configuration";
import type { Namespace } from "@openclaw-enterprise/contracts/resources/namespace";
import type { Secret, SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";
import { normalizeSecretBindings } from "@openclaw-enterprise/contracts/secret-bindings";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import type { ExactAuthorization } from "../../application/authorization.ts";
import type {
  NamespaceReadRepository,
  NamespaceRepository,
} from "../../ports/repositories/namespace.ts";
import type { SecretRepository } from "../../ports/repositories/secret.ts";
import {
  DependencyUnavailableError,
  NamespaceNotReadyError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../errors.ts";
import type {
  ConfigurationServiceOptions,
  ConfigurationServicePort,
  CreateConfigurationInput,
  UpdateConfigurationInput,
} from "./port.ts";

export function configurationValues(value: unknown): Readonly<OpenClawConfigurationDocument> {
  const ancestors = new Set<object>();
  function isJson(input: unknown): boolean {
    if (input === null || typeof input === "boolean" || typeof input === "string") return true;
    if (typeof input === "number") return Number.isFinite(input);
    if (typeof input !== "object" || ancestors.has(input)) return false;
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      return false;
    const keys = Reflect.ownKeys(input);
    if (array && keys.length !== input.length + 1) return false;
    ancestors.add(input);
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") return false;
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !("value" in descriptor) || !isJson(descriptor.value))
        return false;
    }
    ancestors.delete(input);
    return true;
  }
  try {
    // Validate before cloning so accessors and non-JSON values cannot be coerced or dropped.
    if (value && typeof value === "object" && !Array.isArray(value) && isJson(value))
      return immutableCopy(value as OpenClawConfigurationDocument);
  } catch {
    // Inspection and cloning failures have the same input-error identity as invalid JSON.
  }
  throw new ScopeViolationError("Configuration values must be a JSON object.");
}

export function configurationBindings(input: unknown): SecretBindings {
  try {
    return normalizeSecretBindings(input);
  } catch {
    throw new ScopeViolationError(
      "Secret bindings require supported exact sources and non-reserved environment destinations.",
    );
  }
}

/** Called under the Namespace lock shared by deletion and assignment. */
export async function authorizeConfigurationBindings(
  state: { readonly secrets: Pick<SecretRepository, "lockSecret"> },
  principalId: string,
  namespaceId: string,
  bindings: SecretBindings,
  authorization: Pick<ExactAuthorization, "authorize">,
  assertSecretDriverOwner: (expectedId: string) => void,
): Promise<readonly Secret[]> {
  const secrets = new Map<string, Secret>();
  for (const { source } of Object.values(bindings)) {
    if (source.namespaceId !== namespaceId)
      throw new ScopeViolationError("Secret references cannot cross Namespaces.");
    await authorization.authorize(principalId, "operate", source);
    const secret = await state.secrets.lockSecret(namespaceId, source.id);
    if (!secret)
      throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
    assertSecretDriverOwner(secret.driverId);
    secrets.set(secret.id, secret);
  }
  return Object.freeze([...secrets.values()]);
}

export function exactConfiguration(
  configuration: Configuration,
  expected: Pick<
    Configuration,
    "id" | "namespaceId" | "kind" | "generation" | "createdAt" | "secretBindings"
  >,
): Readonly<Configuration> {
  if (
    !configuration ||
    configuration.id !== expected.id ||
    configuration.namespaceId !== expected.namespaceId ||
    configuration.kind !== expected.kind ||
    configuration.generation !== expected.generation ||
    configuration.createdAt !== expected.createdAt
  )
    throw new DependencyUnavailableError(
      "The Configuration Driver returned a resource outside its exact ownership scope.",
    );
  return Object.freeze({
    id: expected.id,
    namespaceId: expected.namespaceId,
    kind: expected.kind,
    generation: expected.generation,
    values: configurationValues(configuration.values),
    ...(expected.secretBindings === undefined
      ? {}
      : { secretBindings: configurationBindings(expected.secretBindings) }),
    createdAt: expected.createdAt,
  });
}

async function configurationDriverOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof DependencyUnavailableError ||
      error instanceof ScopeViolationError ||
      error instanceof ResourceConflictError
    )
      throw error;
    throw new DependencyUnavailableError("The selected Configuration Driver is unavailable.");
  }
}

/** Configuration policy shares the composition owner's transaction and selected authority. */
export class ConfigurationService implements ConfigurationServicePort {
  private readonly options: ConfigurationServiceOptions;

  constructor(options: ConfigurationServiceOptions) {
    this.options = options;
  }

  async createConfiguration(
    principalId: string,
    input: CreateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    if (input.kind !== "agent")
      throw new ScopeViolationError("The Configuration kind must identify an Agent.");
    const values = configurationValues(input.values);
    return this.options.repositories.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      if (namespace.status !== "provisioning" && namespace.status !== "ready")
        throw new ResourceConflictError("The Namespace does not accept new Configurations.");
      await this.options.authorization.authorize(principalId, "create", {
        kind: "configuration",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      if (namespace.existingNamespace !== undefined && namespace.status !== "ready")
        throw new NamespaceNotReadyError();
      const secretBindings = configurationBindings(input.secretBindings);
      await this.authorizeBindings(state, principalId, namespace.id, secretBindings);
      const driver = this.options.configurationDriver();
      const configuration: Configuration = Object.freeze({
        id: this.options.createId(),
        namespaceId: namespace.id,
        kind: input.kind,
        generation: 1,
        values,
        createdAt: this.options.now(),
      });
      await driver.validate(configuration);
      const metadata = await state.configurations.createConfiguration({
        id: configuration.id,
        namespaceId: namespace.id,
        kind: configuration.kind,
        generation: configuration.generation,
        ...(Object.keys(secretBindings).length === 0 ? {} : { secretBindings }),
        createdAt: configuration.createdAt,
      });
      const result = await configurationDriverOperation(() => driver.create(configuration));
      this.options.repositories.registerRollback(async () =>
        driver.delete({ id: configuration.id, namespaceId: configuration.namespaceId }),
      );
      return exactConfiguration(result, metadata);
    });
  }

  async getConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<Configuration>> {
    this.configurationIdentity(namespaceId, configurationId);
    await this.options.authorization.authorize(principalId, "read", {
      kind: "configuration",
      id: configurationId,
      namespaceId,
    });
    const driver = this.options.configurationDriver();
    return this.options.repositories.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      const metadata = await state.configurations.findConfiguration(namespace.id, configurationId);
      if (!metadata)
        throw new ScopeViolationError("The Configuration does not belong to the exact Namespace.");
      const configuration = await configurationDriverOperation(() =>
        driver.read({ id: metadata.id, namespaceId: namespace.id }),
      );
      return exactConfiguration(configuration, metadata);
    });
  }

  async updateConfiguration(
    principalId: string,
    input: UpdateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    this.configurationIdentity(input.namespaceId, input.configurationId);
    if (Object.hasOwn(input, "kind"))
      throw new ScopeViolationError("The Configuration kind cannot be changed.");
    if (
      input.expectedGeneration !== undefined &&
      (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1)
    )
      throw new ScopeViolationError(
        "The expected Configuration generation must be a positive safe integer.",
      );
    const values = configurationValues(input.values);
    return this.options.repositories.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      await this.options.authorization.authorize(principalId, "update", {
        kind: "configuration",
        id: input.configurationId,
        namespaceId: namespace.id,
      });
      const driver = this.options.configurationDriver();
      const metadata = await state.configurations.lockConfiguration(
        namespace.id,
        input.configurationId,
      );
      if (!metadata)
        throw new ScopeViolationError("The Configuration does not belong to the exact Namespace.");
      // Check the caller's editing precondition while the Namespace and Configuration
      // remain locked, before touching Driver storage or advancing persisted state.
      if (
        input.expectedGeneration !== undefined &&
        input.expectedGeneration !== metadata.generation
      )
        throw new ResourceConflictError("The Configuration generation changed before its update.");
      const previous = exactConfiguration(
        await configurationDriverOperation(() =>
          driver.read({ id: metadata.id, namespaceId: namespace.id }),
        ),
        metadata,
      );
      const secretBindings = configurationBindings(
        input.secretBindings === undefined ? metadata.secretBindings : input.secretBindings,
      );
      await this.authorizeBindings(state, principalId, namespace.id, secretBindings);
      const advanced = await state.configurations.advanceConfigurationGeneration(
        namespace.id,
        metadata.id,
        metadata.generation,
        secretBindings,
      );
      if (!advanced)
        throw new ResourceConflictError("The Configuration generation changed during its update.");
      const configuration: Configuration = Object.freeze({
        id: advanced.id,
        namespaceId: advanced.namespaceId,
        kind: advanced.kind,
        generation: advanced.generation,
        values,
        createdAt: advanced.createdAt,
      });
      await driver.validate(configuration);
      const updated = await configurationDriverOperation(() => driver.update(configuration));
      this.options.repositories.registerRollback(async () => {
        await driver.update(previous);
      });
      return exactConfiguration(updated, advanced);
    });
  }

  async deleteConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<void> {
    this.configurationIdentity(namespaceId, configurationId);
    return this.options.repositories.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, namespaceId);
      await this.options.authorization.authorize(principalId, "delete", {
        kind: "configuration",
        id: configurationId,
        namespaceId: namespace.id,
      });
      const driver = this.options.configurationDriver();
      const configuration = await state.configurations.lockConfiguration(
        namespace.id,
        configurationId,
      );
      if (!configuration)
        throw new ScopeViolationError("The Configuration does not belong to the exact Namespace.");
      const agents = await state.agents.listAgents(namespace.id);
      if (agents.some((agent) => agent.configurationId === configuration.id))
        throw new ResourceConflictError("An Agent still references the exact Configuration.");
      const previous = exactConfiguration(
        await configurationDriverOperation(() =>
          driver.read({ id: configuration.id, namespaceId: namespace.id }),
        ),
        configuration,
      );
      await configurationDriverOperation(() =>
        driver.delete({ id: configuration.id, namespaceId: namespace.id }),
      );
      this.options.repositories.registerRollback(async () => {
        await driver.create(previous);
      });
      if (!(await state.configurations.deleteConfiguration(namespace.id, configuration.id)))
        throw new ResourceConflictError("The Configuration changed during deletion.");
    });
  }

  private configurationIdentity(namespaceId: string, configurationId: string): void {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (!isNonEmptyString(configurationId))
      throw new ScopeViolationError("The exact Configuration identity is missing.");
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
      this.options.authorization,
      this.options.assertSecretDriverOwner,
    );
  }
}
