import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type { Namespace } from "@openclaw-enterprise/contracts/resources/namespace";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { DependencyUnavailableError, ScopeViolationError } from "../../errors.ts";
import type {
  NamespaceRepository,
  PersistedNamespace,
} from "../../ports/repositories/namespace.ts";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";

type PostgresRow = Record<string, unknown>;

function rows(value: unknown[]): PostgresRow[] {
  return value.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row))
      throw new DependencyUnavailableError("The persistence repository returned invalid data.");
    return row as PostgresRow;
  });
}

function text(row: PostgresRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0)
    throw new DependencyUnavailableError("Persisted platform state is invalid or incomplete.");
  return value;
}

function optionalText(row: PostgresRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  return text(row, key);
}

function timestamp(row: PostgresRow, key: string): string {
  const value = row[key];
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime()))
    throw new DependencyUnavailableError("Persisted platform state has an invalid timestamp.");
  return date.toISOString();
}

function namespaceFromRow(row: PostgresRow): Readonly<PersistedNamespace> {
  const status = text(row, "status");
  if (!["provisioning", "ready", "failed", "deleting"].includes(status))
    throw new DependencyUnavailableError("Persisted Namespace status is invalid.");
  const deletedAt =
    row.deleted_at === null || row.deleted_at === undefined
      ? undefined
      : timestamp(row, "deleted_at");
  const existingNamespace = optionalText(row, "existing_namespace");
  return immutableCopy({
    id: text(row, "id"),
    name: text(row, "name"),
    ...(existingNamespace === undefined ? {} : { existingNamespace }),
    status: status as Namespace["status"],
    createdAt: timestamp(row, "created_at"),
    ...(deletedAt === undefined ? {} : { deletedAt }),
  });
}

export interface PostgresNamespaceRepositoryContext extends QueryRepositoryFactoryContext {
  requireInitialized(): Promise<Readonly<Installation>>;
}

/** Borrows the owner's query and lifetime; Installation lookup remains mutation-only. */
export function createPostgresNamespaceRepository(
  context: PostgresNamespaceRepositoryContext,
): NamespaceRepository {
  const client = context.query;

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
    // Resolve scope only after the owner's original mutation-time Installation lookup.
    if (context.scope.installationId !== installation.id)
      throw new ScopeViolationError(
        "The resource does not belong to the server-owned Installation.",
      );
    return installation;
  }

  const namespaces: NamespaceRepository = {
    findNamespace: async (namespaceId) => {
      const found = rows(
        (
          await client.query(
            `SELECT id, name, existing_namespace, status, created_at, deleted_at
               FROM occ.namespaces WHERE id = $1 AND deleted_at IS NULL`,
            [namespaceId],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : namespaceFromRow(found);
    },
    listNamespaces: async () => {
      const found = rows(
        (
          await client.query(
            `SELECT id, name, existing_namespace, status, created_at, deleted_at
               FROM occ.namespaces WHERE deleted_at IS NULL ORDER BY created_at, id`,
          )
        ).rows,
      );
      return Object.freeze(found.map((row) => namespaceFromRow(row)));
    },
    createNamespace: async (namespace) => {
      await requireInitialized();
      await client.query(
        `INSERT INTO occ.namespaces (id, name, existing_namespace, status, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
        [
          namespace.id,
          namespace.name,
          namespace.existingNamespace ?? null,
          namespace.status,
          namespace.createdAt,
        ],
      );
      return immutableCopy(namespace);
    },
    lockNamespace: async (namespaceId, options = {}) => {
      const found = rows(
        (
          await client.query(
            `SELECT id, name, existing_namespace, status, created_at, deleted_at
               FROM occ.namespaces
               WHERE id = $1${options.includeDeleted === true ? "" : " AND deleted_at IS NULL"}
               FOR UPDATE`,
            [namespaceId],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : namespaceFromRow(found);
    },
    hasAgents: async (namespaceId) => {
      const found = rows(
        (
          await client.query(
            "SELECT EXISTS (SELECT 1 FROM occ.agents WHERE namespace_id = $1) AS present",
            [namespaceId],
          )
        ).rows,
      )[0];
      return found?.present === true;
    },
    hasConfigurations: async (namespaceId) => {
      const found = rows(
        (
          await client.query(
            "SELECT EXISTS (SELECT 1 FROM occ.configurations WHERE namespace_id = $1) AS present",
            [namespaceId],
          )
        ).rows,
      )[0];
      return found?.present === true;
    },
    hasServiceAccounts: async (namespaceId) => {
      const found = rows(
        (
          await client.query(
            "SELECT EXISTS (SELECT 1 FROM occ.service_accounts WHERE namespace_id = $1) AS present",
            [namespaceId],
          )
        ).rows,
      )[0];
      return found?.present === true;
    },
    hasSecrets: async (namespaceId) => {
      const found = rows(
        (
          await client.query(
            "SELECT EXISTS (SELECT 1 FROM occ.secrets WHERE namespace_id = $1) AS present",
            [namespaceId],
          )
        ).rows,
      )[0];
      return found?.present === true;
    },
    transitionNamespaceStatus: async (namespaceId, expected, next) => {
      await requireInitialized();
      const expectedStatuses = Array.isArray(expected) ? expected : [expected];
      const found = rows(
        (
          await client.query(
            `UPDATE occ.namespaces SET status = $3
               WHERE id = $1 AND status = ANY($2::text[]) AND deleted_at IS NULL
               RETURNING id, name, existing_namespace, status, created_at, deleted_at`,
            [namespaceId, expectedStatuses, next],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : namespaceFromRow(found);
    },
    markNamespaceDeleted: async (namespaceId, deletedAt) => {
      await requireInitialized();
      const updated = rows(
        (
          await client.query(
            `UPDATE occ.namespaces SET deleted_at = $2
               WHERE id = $1 AND status = 'deleting' AND deleted_at IS NULL
               RETURNING id, name, existing_namespace, status, created_at, deleted_at`,
            [namespaceId, deletedAt],
          )
        ).rows,
      )[0];
      if (updated !== undefined) return namespaceFromRow(updated);
      const existing = rows(
        (
          await client.query(
            `SELECT id, name, existing_namespace, status, created_at, deleted_at
               FROM occ.namespaces WHERE id = $1 AND status = 'deleting' FOR UPDATE`,
            [namespaceId],
          )
        ).rows,
      )[0];
      return existing === undefined ? undefined : namespaceFromRow(existing);
    },
  };

  // Internal collaborators borrow activity without reentering outward admission while draining.
  return {
    findNamespace: (id) => withinTransaction(() => namespaces.findNamespace(id)),
    listNamespaces: () => withinTransaction(() => namespaces.listNamespaces()),
    createNamespace: (namespace) => withinTransaction(() => namespaces.createNamespace(namespace)),
    lockNamespace: (id, options) => withinTransaction(() => namespaces.lockNamespace(id, options)),
    hasAgents: (id) => withinTransaction(() => namespaces.hasAgents(id)),
    hasConfigurations: (id) => withinTransaction(() => namespaces.hasConfigurations(id)),
    hasServiceAccounts: (id) => withinTransaction(() => namespaces.hasServiceAccounts(id)),
    hasSecrets: (id) => withinTransaction(() => namespaces.hasSecrets(id)),
    transitionNamespaceStatus: (id, expected, next) =>
      withinTransaction(() => namespaces.transitionNamespaceStatus(id, expected, next)),
    markNamespaceDeleted: (id, deletedAt) =>
      withinTransaction(() => namespaces.markNamespaceDeleted(id, deletedAt)),
  };
}
