import type { Agent, AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type { Secret, SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ResourceConflictError, ScopeViolationError } from "../../errors.ts";
import type {
  MemoryRepositoryFactoryContext,
  RepositoryFactory,
} from "../../ports/repository-factory.ts";
import type { ConfigurationOwnership } from "../../ports/repositories/configuration.ts";
import type {
  NamespaceRepository,
  PersistedNamespace,
} from "../../ports/repositories/namespace.ts";
import type { SecretRepository } from "../../ports/repositories/secret.ts";
import type { PlatformOperation } from "../../ports/repositories/work.ts";

/** Live owner collections; only Secret metadata is writable through this projection. */
export interface MemorySecretSnapshot {
  readonly installation: Readonly<Installation> | undefined;
  readonly secrets: Map<string, Readonly<Secret>>;
  readonly namespaces: ReadonlyMap<string, Readonly<Pick<PersistedNamespace, "deletedAt">>>;
  readonly configurations: ReadonlyMap<
    string,
    Readonly<Pick<ConfigurationOwnership, "namespaceId" | "secretBindings">>
  >;
  readonly agents: ReadonlyMap<
    string,
    Readonly<Pick<Agent, "id" | "namespaceId" | "activeRevisionId">>
  >;
  readonly revisions: ReadonlyMap<
    string,
    readonly Readonly<Pick<AgentRevision, "id" | "namespaceId" | "secretBindings">>[]
  >;
  readonly operations: readonly Readonly<
    Pick<PlatformOperation, "kind" | "namespaceId" | "resourceId">
  >[];
}

export interface MemorySecretRepositoryContext extends MemoryRepositoryFactoryContext<MemorySecretSnapshot> {
  readonly namespaces: Pick<NamespaceRepository, "lockNamespace">;
  resourceKey(namespaceId: string, resourceId: string): string;
  assertSecret(secret: Secret): void;
  secretBindingsReference(
    bindings: SecretBindings | undefined,
    namespaceId: string,
    secretId: string,
  ): boolean;
}

/** The owner retains canonical validation, outward admission and its single working snapshot. */
export const createMemorySecretRepository: RepositoryFactory<
  MemorySecretRepositoryContext,
  SecretRepository
> = (context) => {
  const {
    snapshot,
    transaction,
    namespaces,
    resourceKey: agentKey,
    assertSecret,
    secretBindingsReference,
  } = context;

  function assertInitialized(snapshot: MemorySecretSnapshot): void {
    if (!snapshot.installation)
      throw new ScopeViolationError("The server-owned Installation has not been initialized.");
    if (context.scope.installationId !== snapshot.installation.id)
      throw new ScopeViolationError(
        "The resource does not belong to the server-owned Installation.",
      );
  }

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

  for (const key of Object.keys(secrets) as (keyof SecretRepository)[]) {
    const method = secrets[key];
    Object.defineProperty(secrets, key, {
      value: async (...args: unknown[]) => {
        transaction.assertActive();
        const result = await Reflect.apply(method, secrets, args);
        transaction.assertActive();
        return result;
      },
    });
  }
  return Object.freeze(secrets);
};
