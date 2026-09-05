import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ResourceConflictError, ScopeViolationError } from "../../errors.ts";
import type {
  MemoryRepositoryFactoryContext,
  RepositoryFactory,
} from "../../ports/repository-factory.ts";
import type {
  NamespaceRepository,
  PersistedNamespace,
} from "../../ports/repositories/namespace.ts";

interface NamespaceOwnedResource {
  readonly namespaceId: string;
}

/** Same working Namespace map and read-only projections of the owner's resource maps. */
export interface MemoryNamespaceSnapshot {
  readonly installation: Readonly<Installation> | undefined;
  readonly namespaces: Map<string, Readonly<PersistedNamespace>>;
  readonly agents: ReadonlyMap<string, NamespaceOwnedResource>;
  readonly configurations: ReadonlyMap<string, NamespaceOwnedResource>;
  readonly serviceAccounts: ReadonlyMap<string, NamespaceOwnedResource>;
  readonly secrets: ReadonlyMap<string, NamespaceOwnedResource>;
}

export type MemoryNamespaceRepositoryContext =
  MemoryRepositoryFactoryContext<MemoryNamespaceSnapshot>;

/** The platform owner binds outward admission; internal collaborators only borrow active access. */
export const createMemoryNamespaceRepository: RepositoryFactory<
  MemoryNamespaceRepositoryContext,
  NamespaceRepository
> = (context) => {
  const { snapshot, transaction } = context;
  function assertInitialized(snapshot: MemoryNamespaceSnapshot): void {
    if (!snapshot.installation)
      throw new ScopeViolationError("The server-owned Installation has not been initialized.");
    if (context.scope.installationId !== snapshot.installation.id)
      throw new ScopeViolationError(
        "The resource does not belong to the server-owned Installation.",
      );
  }
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

  for (const key of Object.keys(namespaces) as (keyof NamespaceRepository)[]) {
    const method = namespaces[key];
    Object.defineProperty(namespaces, key, {
      value: async (...args: unknown[]) => {
        transaction.assertActive();
        const result = await Reflect.apply(method, namespaces, args);
        transaction.assertActive();
        return result;
      },
    });
  }
  return Object.freeze(namespaces);
};
