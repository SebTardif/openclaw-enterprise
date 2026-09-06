import type { Agent } from "@openclaw-enterprise/contracts/resources/agent";
import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type {
  ServiceAccount,
  ServiceAccountCredential,
} from "@openclaw-enterprise/contracts/resources/service-account";
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
import type { ServiceAccountRepository } from "../../ports/repositories/service-account.ts";

/** Live owner collections; only ServiceAccount metadata is writable. */
export interface MemoryServiceAccountSnapshot {
  readonly installation: Readonly<Installation> | undefined;
  readonly serviceAccounts: Map<string, Readonly<ServiceAccount>>;
  readonly namespaces: ReadonlyMap<string, Readonly<Pick<PersistedNamespace, "deletedAt">>>;
  readonly agents: ReadonlyMap<string, Readonly<Pick<Agent, "namespaceId" | "serviceAccountId">>>;
}

export interface MemoryServiceAccountRepositoryContext extends MemoryRepositoryFactoryContext<MemoryServiceAccountSnapshot> {
  readonly namespaces: Pick<NamespaceRepository, "lockNamespace">;
  resourceKey(namespaceId: string, resourceId: string): string;
  isServiceAccountIdentifier(value: string): boolean;
  validCredential(value: unknown): value is ServiceAccountCredential;
}

/** Borrows the owner's snapshot, canonical validators and transaction lifetime. */
export const createMemoryServiceAccountRepository: RepositoryFactory<
  MemoryServiceAccountRepositoryContext,
  ServiceAccountRepository
> = (context) => {
  const {
    snapshot,
    transaction,
    namespaces,
    resourceKey: agentKey,
    isServiceAccountIdentifier,
    validCredential,
  } = context;
  function assertInitialized(snapshot: MemoryServiceAccountSnapshot): void {
    if (!snapshot.installation)
      throw new ScopeViolationError("The server-owned Installation has not been initialized.");
    if (context.scope.installationId !== snapshot.installation.id)
      throw new ScopeViolationError(
        "The resource does not belong to the server-owned Installation.",
      );
  }

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
        !isServiceAccountIdentifier(account.id) ||
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

  for (const key of Object.keys(serviceAccounts) as (keyof ServiceAccountRepository)[]) {
    const method = serviceAccounts[key];
    Object.defineProperty(serviceAccounts, key, {
      value: async (...args: unknown[]) => {
        transaction.assertActive();
        const result = await Reflect.apply(method, serviceAccounts, args);
        transaction.assertActive();
        return result;
      },
    });
  }
  return Object.freeze(serviceAccounts);
};
