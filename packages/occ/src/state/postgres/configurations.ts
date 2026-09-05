import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type { SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ScopeViolationError } from "../../errors.ts";
import type {
  ConfigurationOwnership,
  ConfigurationRepository,
} from "../../ports/repositories/configuration.ts";
import type { NamespaceRepository } from "../../ports/repositories/namespace.ts";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";

type PostgresRow = Record<string, unknown>;

export interface PostgresConfigurationRepositoryContext extends QueryRepositoryFactoryContext {
  requireInitialized(): Promise<Readonly<Installation>>;
  readonly namespaces: Pick<NamespaceRepository, "lockNamespace">;
  serializeSecretBindings(namespaceId: string, bindings: SecretBindings | undefined): string | null;
  validateSecretBindingsAvailable(
    namespaceId: string,
    bindings: SecretBindings | undefined,
  ): Promise<void>;
  secretBindingsFromJson(value: unknown, namespaceId: string): SecretBindings | undefined;
  rows(value: unknown[]): PostgresRow[];
  text(row: PostgresRow, key: string): string;
  timestamp(row: PostgresRow, key: string): string;
}

/** Borrows the owner's query, lifetime, and shared Secret decoding and availability helpers. */
export function createPostgresConfigurationRepository(
  context: PostgresConfigurationRepositoryContext,
): ConfigurationRepository {
  const client = context.query;
  const {
    namespaces,
    serializeSecretBindings,
    validateSecretBindingsAvailable,
    secretBindingsFromJson,
    rows,
    text,
    timestamp,
  } = context;

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

  function configurationFromRow(row: PostgresRow): Readonly<ConfigurationOwnership> {
    const secretBindings =
      row.secret_bindings === null || row.secret_bindings === undefined
        ? undefined
        : secretBindingsFromJson(row.secret_bindings, text(row, "namespace_id"));
    return immutableCopy({
      id: text(row, "id"),
      namespaceId: text(row, "namespace_id"),
      kind: text(row, "kind") as ConfigurationOwnership["kind"],
      generation: Number(row.generation),
      ...(secretBindings === undefined ? {} : { secretBindings }),
      createdAt: timestamp(row, "created_at"),
    });
  }

  const findConfiguration = async (
    namespaceId: string,
    configurationId: string,
    lock = false,
  ): Promise<Readonly<ConfigurationOwnership> | undefined> => {
    const found = rows(
      (
        await client.query(
          `SELECT c.id, c.namespace_id, c.kind, c.generation, c.created_at
                  , c.secret_bindings
             FROM occ.configurations AS c
             JOIN occ.namespaces AS n ON n.id = c.namespace_id AND n.deleted_at IS NULL
             WHERE c.namespace_id = $1 AND c.id = $2${lock ? " FOR UPDATE OF c" : ""}`,
          [namespaceId, configurationId],
        )
      ).rows,
    )[0];
    return found === undefined ? undefined : configurationFromRow(found);
  };

  const configurations: ConfigurationRepository = {
    findConfiguration,
    createConfiguration: async (configuration) => {
      await requireInitialized();
      const namespace = await namespaces.lockNamespace(configuration.namespaceId);
      if (
        namespace === undefined ||
        (namespace.status !== "provisioning" && namespace.status !== "ready")
      )
        throw new ScopeViolationError("The Configuration belongs to an unavailable Namespace.");
      const serializedSecretBindings = serializeSecretBindings(
        configuration.namespaceId,
        configuration.secretBindings,
      );
      await validateSecretBindingsAvailable(
        configuration.namespaceId,
        configuration.secretBindings,
      );
      await client.query(
        `INSERT INTO occ.configurations
           (id, namespace_id, kind, generation, secret_bindings, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          configuration.id,
          configuration.namespaceId,
          configuration.kind,
          configuration.generation,
          serializedSecretBindings,
          configuration.createdAt,
        ],
      );
      const { secretBindings: _providedSecretBindings, ...withoutSecretBindings } = configuration;
      const storedSecretBindings =
        serializedSecretBindings === null
          ? undefined
          : secretBindingsFromJson(serializedSecretBindings, configuration.namespaceId);
      const saved: ConfigurationOwnership =
        storedSecretBindings === undefined
          ? withoutSecretBindings
          : { ...withoutSecretBindings, secretBindings: storedSecretBindings };
      return immutableCopy({
        ...saved,
      });
    },
    lockConfiguration: async (namespaceId, configurationId) =>
      findConfiguration(namespaceId, configurationId, true),
    advanceConfigurationGeneration: async (
      namespaceId,
      configurationId,
      expectedGeneration,
      nextSecretBindings,
    ) => {
      const current = await findConfiguration(namespaceId, configurationId, true);
      if (current === undefined || current.generation !== expectedGeneration) return undefined;
      const secretBindings =
        nextSecretBindings === undefined ? current.secretBindings : nextSecretBindings;
      await validateSecretBindingsAvailable(namespaceId, secretBindings);
      const serializedSecretBindings = serializeSecretBindings(namespaceId, secretBindings);
      const updated = rows(
        (
          await client.query(
            `UPDATE occ.configurations AS c
               SET generation = c.generation + 1, secret_bindings = $4::jsonb
               FROM occ.namespaces AS n
               WHERE c.namespace_id = $1 AND c.id = $2 AND c.generation = $3
                 AND n.id = c.namespace_id AND n.deleted_at IS NULL
               RETURNING c.id, c.namespace_id, c.kind, c.generation, c.secret_bindings,
                         c.created_at`,
            [namespaceId, configurationId, expectedGeneration, serializedSecretBindings],
          )
        ).rows,
      )[0];
      return updated === undefined ? undefined : configurationFromRow(updated);
    },
    deleteConfiguration: async (namespaceId, configurationId) => {
      const deleted = await client.query(
        `DELETE FROM occ.configurations AS c USING occ.namespaces AS n
           WHERE c.namespace_id = $1 AND c.id = $2
             AND n.id = c.namespace_id AND n.deleted_at IS NULL`,
        [namespaceId, configurationId],
      );
      return deleted.rowCount === 1;
    },
  };

  // Internal collaborators borrow activity without reentering outward admission while draining.
  return {
    findConfiguration: (namespaceId, configurationId) =>
      withinTransaction(() => configurations.findConfiguration(namespaceId, configurationId)),
    createConfiguration: (configuration) =>
      withinTransaction(() => configurations.createConfiguration(configuration)),
    lockConfiguration: (namespaceId, configurationId) =>
      withinTransaction(() => configurations.lockConfiguration(namespaceId, configurationId)),
    advanceConfigurationGeneration: (
      namespaceId,
      configurationId,
      expectedGeneration,
      secretBindings,
    ) =>
      withinTransaction(() =>
        configurations.advanceConfigurationGeneration(
          namespaceId,
          configurationId,
          expectedGeneration,
          secretBindings,
        ),
      ),
    deleteConfiguration: (namespaceId, configurationId) =>
      withinTransaction(() => configurations.deleteConfiguration(namespaceId, configurationId)),
  };
}
