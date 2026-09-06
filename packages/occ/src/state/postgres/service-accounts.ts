import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type {
  ServiceAccount,
  ServiceAccountCredential,
} from "@openclaw-enterprise/contracts/resources/service-account";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ScopeViolationError } from "../../errors.ts";
import type {
  QueryRepositoryFactoryContext,
  RepositoryFactory,
} from "../../ports/repository-factory.ts";
import type { NamespaceRepository } from "../../ports/repositories/namespace.ts";
import type { ServiceAccountRepository } from "../../ports/repositories/service-account.ts";

type PostgresRow = Record<string, unknown>;
export interface PostgresServiceAccountRepositoryContext extends QueryRepositoryFactoryContext {
  requireInitialized(): Promise<Readonly<Installation>>;
  readonly namespaces: Pick<NamespaceRepository, "lockNamespace">;
  rows(value: unknown[]): PostgresRow[];
  text(row: PostgresRow, key: string): string;
  readonly findServiceAccountProviderBinding: ServiceAccountRepository["findServiceAccountProviderBinding"];
}

/** Borrows the existing guarded client and the owner's private binding projection. */
export const createPostgresServiceAccountRepository: RepositoryFactory<
  PostgresServiceAccountRepositoryContext,
  ServiceAccountRepository
> = (context) => {
  const client = context.query;
  const { namespaces, rows, text } = context;
  async function withinTransaction<T>(work: () => Promise<T>): Promise<T> {
    context.transaction.assertActive();
    const result = await work();
    context.transaction.assertActive();
    return result;
  }
  async function requireInitialized(): Promise<Readonly<Installation>> {
    context.transaction.assertActive();
    const installation = await context.requireInitialized();
    context.transaction.assertActive();
    if (context.scope.installationId !== installation.id)
      throw new ScopeViolationError(
        "The resource does not belong to the server-owned Installation.",
      );
    return installation;
  }

  function serviceAccountFromRow(row: PostgresRow): Readonly<ServiceAccount> {
    const credential = row.credential as ServiceAccountCredential | null;
    return immutableCopy({
      id: text(row, "id"),
      namespaceId: text(row, "namespace_id"),
      name: text(row, "name"),
      ...(credential === null ? {} : { credential }),
    });
  }

  const findServiceAccount = async (
    namespaceId: string,
    serviceAccountId: string,
    lock = false,
  ): Promise<Readonly<ServiceAccount> | undefined> => {
    const found = rows(
      (
        await client.query(
          `SELECT s.id, s.namespace_id, s.name, s.credential
             FROM occ.service_accounts AS s
             JOIN occ.namespaces AS n ON n.id = s.namespace_id AND n.deleted_at IS NULL
             WHERE s.namespace_id = $1 AND s.id = $2${lock ? " FOR UPDATE OF s" : ""}`,
          [namespaceId, serviceAccountId],
        )
      ).rows,
    )[0];
    return found === undefined ? undefined : serviceAccountFromRow(found);
  };

  const serviceAccounts: ServiceAccountRepository = {
    findServiceAccount,
    listServiceAccounts: async (namespaceId) =>
      Object.freeze(
        rows(
          (
            await client.query(
              `SELECT s.id, s.namespace_id, s.name, s.credential
                 FROM occ.service_accounts AS s
                 JOIN occ.namespaces AS n ON n.id = s.namespace_id AND n.deleted_at IS NULL
                 WHERE s.namespace_id = $1
                 ORDER BY s.name, s.id`,
              [namespaceId],
            )
          ).rows,
        ).map(serviceAccountFromRow),
      ),
    findServiceAccountProviderBinding: context.findServiceAccountProviderBinding,
    lockServiceAccount: async (namespaceId, serviceAccountId) =>
      findServiceAccount(namespaceId, serviceAccountId, true),
    createServiceAccount: async (account) => {
      await requireInitialized();
      const namespace = await namespaces.lockNamespace(account.namespaceId);
      if (
        namespace === undefined ||
        (namespace.status !== "provisioning" && namespace.status !== "ready")
      )
        throw new ScopeViolationError("The ServiceAccount belongs to an unavailable Namespace.");
      await client.query(
        `INSERT INTO occ.service_accounts
           (id, namespace_id, name, credential)
           VALUES ($1, $2, $3, $4::jsonb)`,
        [
          account.id,
          account.namespaceId,
          account.name,
          account.credential === undefined ? null : JSON.stringify(account.credential),
        ],
      );
      return immutableCopy(account);
    },
    updateCredential: async (namespaceId, serviceAccountId, credential) => {
      const updated = rows(
        (
          await client.query(
            `UPDATE occ.service_accounts AS s
               SET credential = $3::jsonb
               FROM occ.namespaces AS n
               WHERE s.namespace_id = $1 AND s.id = $2
                 AND n.id = s.namespace_id AND n.deleted_at IS NULL
               RETURNING s.id, s.namespace_id, s.name, s.credential`,
            [namespaceId, serviceAccountId, JSON.stringify(credential)],
          )
        ).rows,
      )[0];
      return updated === undefined ? undefined : serviceAccountFromRow(updated);
    },
    deleteServiceAccount: async (namespaceId, serviceAccountId) => {
      const deleted = await client.query(
        `DELETE FROM occ.service_accounts AS s USING occ.namespaces AS n
           WHERE s.namespace_id = $1 AND s.id = $2
             AND n.id = s.namespace_id AND n.deleted_at IS NULL`,
        [namespaceId, serviceAccountId],
      );
      return deleted.rowCount === 1;
    },
  };

  // Internal collaborators retain activity while the outer owner drains accepted calls.
  return Object.freeze<ServiceAccountRepository>({
    findServiceAccount: (namespaceId, accountId) =>
      withinTransaction(() => serviceAccounts.findServiceAccount(namespaceId, accountId)),
    listServiceAccounts: (namespaceId) =>
      withinTransaction(() => serviceAccounts.listServiceAccounts(namespaceId)),
    findServiceAccountProviderBinding: (namespaceId, accountId) =>
      withinTransaction(() =>
        serviceAccounts.findServiceAccountProviderBinding(namespaceId, accountId),
      ),
    lockServiceAccount: (namespaceId, accountId) =>
      withinTransaction(() => serviceAccounts.lockServiceAccount(namespaceId, accountId)),
    createServiceAccount: (account) =>
      withinTransaction(() => serviceAccounts.createServiceAccount(account)),
    updateCredential: (namespaceId, accountId, credential) =>
      withinTransaction(() => serviceAccounts.updateCredential(namespaceId, accountId, credential)),
    deleteServiceAccount: (namespaceId, accountId) =>
      withinTransaction(() => serviceAccounts.deleteServiceAccount(namespaceId, accountId)),
  });
};
