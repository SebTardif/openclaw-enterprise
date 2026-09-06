import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type { Secret } from "@openclaw-enterprise/contracts/resources/secret";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ScopeViolationError } from "../../errors.ts";
import type { NamespaceRepository } from "../../ports/repositories/namespace.ts";
import type { SecretRepository } from "../../ports/repositories/secret.ts";
import type {
  QueryRepositoryFactoryContext,
  RepositoryFactory,
} from "../../ports/repository-factory.ts";

type PostgresRow = Record<string, unknown>;

export interface PostgresSecretRepositoryContext extends QueryRepositoryFactoryContext {
  requireInitialized(): Promise<Readonly<Installation>>;
  readonly namespaces: Pick<NamespaceRepository, "lockNamespace">;
  rows(value: unknown[]): PostgresRow[];
  text(row: PostgresRow, key: string): string;
  timestamp(row: PostgresRow, key: string): string;
}

/** Borrows the owner's guarded query, lifetime, Namespace lock, and row decoders. */
export const createPostgresSecretRepository: RepositoryFactory<
  PostgresSecretRepositoryContext,
  SecretRepository
> = (context) => {
  const client = context.query;
  const { namespaces, rows, text, timestamp } = context;

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

  function secretFromRow(row: PostgresRow): Readonly<Secret> {
    return immutableCopy({
      id: text(row, "id"),
      namespaceId: text(row, "namespace_id"),
      name: text(row, "name"),
      driverId: text(row, "driver_id"),
      backendRef: {
        namespaceName: text(row, "backend_namespace_name"),
        name: text(row, "backend_name"),
        key: text(row, "backend_key"),
        uid: text(row, "backend_uid"),
      },
      createdAt: timestamp(row, "created_at"),
    });
  }

  const findSecret = async (
    namespaceId: string,
    secretId: string,
    lock = false,
  ): Promise<Readonly<Secret> | undefined> => {
    const found = rows(
      (
        await client.query(
          `SELECT s.id, s.namespace_id, s.name, s.driver_id,
                    s.backend_namespace_name, s.backend_name, s.backend_key, s.backend_uid,
                    s.created_at
             FROM occ.secrets AS s
             JOIN occ.namespaces AS n ON n.id = s.namespace_id AND n.deleted_at IS NULL
             WHERE s.namespace_id = $1 AND s.id = $2${lock ? " FOR UPDATE OF s" : ""}`,
          [namespaceId, secretId],
        )
      ).rows,
    )[0];
    return found === undefined ? undefined : secretFromRow(found);
  };

  const secrets: SecretRepository = {
    findSecret,
    lockSecret: async (namespaceId, secretId) => findSecret(namespaceId, secretId, true),
    createSecret: async (secret) => {
      await requireInitialized();
      const namespace = await namespaces.lockNamespace(secret.namespaceId);
      if (
        namespace === undefined ||
        (namespace.status !== "provisioning" && namespace.status !== "ready")
      )
        throw new ScopeViolationError("The Secret belongs to an unavailable Namespace.");
      await client.query(
        `INSERT INTO occ.secrets
           (id, namespace_id, name, driver_id, backend_namespace_name, backend_name,
            backend_key, backend_uid, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          secret.id,
          secret.namespaceId,
          secret.name,
          secret.driverId,
          secret.backendRef.namespaceName,
          secret.backendRef.name,
          secret.backendRef.key,
          secret.backendRef.uid,
          secret.createdAt,
        ],
      );
      return immutableCopy(secret);
    },
    hasReferences: async (namespaceId, secretId) => {
      if ((await findSecret(namespaceId, secretId)) === undefined) return false;
      const found = rows(
        (
          await client.query(
            `SELECT EXISTS (
                 SELECT 1
                 FROM occ.configurations AS c,
                      jsonb_each(COALESCE(c.secret_bindings, '{}'::jsonb)) AS binding(env, value)
                 WHERE c.namespace_id = $1
                   AND binding.value #>> '{source,kind}' = 'secret'
                   AND binding.value #>> '{source,namespaceId}' = $1
                   AND binding.value #>> '{source,id}' = $2
               ) OR EXISTS (
                 SELECT 1
                 FROM occ.agents AS a
                 JOIN occ.agent_revisions AS r
                   ON r.namespace_id = a.namespace_id
                  AND r.agent_id = a.id
                  AND r.id = a.active_revision_id,
                      jsonb_each(COALESCE(r.admitted_spec->'secret_bindings', '{}'::jsonb))
                        AS binding(env, value)
                 WHERE a.namespace_id = $1
                   AND binding.value #>> '{source,kind}' = 'secret'
                   AND binding.value #>> '{source,namespaceId}' = $1
                   AND binding.value #>> '{source,id}' = $2
               ) OR EXISTS (
                 SELECT 1
                 FROM occ.controller_work AS w
                 JOIN occ.agent_revisions AS r
                   ON r.namespace_id = w.namespace_id
                  AND r.agent_id = w.agent_id
                  AND r.id = w.revision_id,
                      jsonb_each(COALESCE(r.admitted_spec->'secret_bindings', '{}'::jsonb))
                        AS binding(env, value)
                 WHERE w.namespace_id = $1
                   AND w.state IN ('queued', 'claimed')
                   AND binding.value #>> '{source,kind}' = 'secret'
                   AND binding.value #>> '{source,namespaceId}' = $1
                   AND binding.value #>> '{source,id}' = $2
               ) AS present`,
            [namespaceId, secretId],
          )
        ).rows,
      )[0];
      return found?.present === true;
    },
    deleteSecret: async (namespaceId, secretId) => {
      if ((await findSecret(namespaceId, secretId)) === undefined) return false;
      if (await secrets.hasReferences(namespaceId, secretId))
        throw new ScopeViolationError("The Secret is referenced by active platform state.");
      const deleted = await client.query(
        `DELETE FROM occ.secrets AS s USING occ.namespaces AS n
           WHERE s.namespace_id = $1 AND s.id = $2
             AND n.id = s.namespace_id AND n.deleted_at IS NULL`,
        [namespaceId, secretId],
      );
      return deleted.rowCount === 1;
    },
  };

  // Internal collaborators borrow activity without reentering outward admission while draining.
  return {
    findSecret: (namespaceId, secretId) =>
      withinTransaction(() => secrets.findSecret(namespaceId, secretId)),
    lockSecret: (namespaceId, secretId) =>
      withinTransaction(() => secrets.lockSecret(namespaceId, secretId)),
    createSecret: (secret) => withinTransaction(() => secrets.createSecret(secret)),
    deleteSecret: (namespaceId, secretId) =>
      withinTransaction(() => secrets.deleteSecret(namespaceId, secretId)),
    hasReferences: (namespaceId, secretId) =>
      withinTransaction(() => secrets.hasReferences(namespaceId, secretId)),
  };
};
