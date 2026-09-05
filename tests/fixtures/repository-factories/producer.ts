import type {
  MemoryRepositoryFactoryContext,
  QueryRepositoryFactoryContext,
  RepositoryFactory,
} from "@openclaw-enterprise/occ/ports/repository-factory";
import type {
  ConfigurationOwnership,
  ConfigurationReadRepository,
} from "@openclaw-enterprise/occ/ports/repositories/configuration";

interface ConfigurationScope {
  readonly installationId: string;
  readonly namespaceId: string;
}
interface ConfigurationSnapshot {
  readonly configurations: ReadonlyMap<string, Readonly<ConfigurationOwnership>>;
}

export const memoryConfigurationReader: RepositoryFactory<
  MemoryRepositoryFactoryContext<ConfigurationSnapshot, ConfigurationScope>,
  ConfigurationReadRepository
> = ({ snapshot, scope, transaction }) => ({
  async findConfiguration(namespaceId, configurationId) {
    transaction.assertActive();
    if (namespaceId !== scope.namespaceId) return undefined;
    const row = snapshot.configurations.get(configurationId);
    return row?.namespaceId === namespaceId ? Object.freeze({ ...row }) : undefined;
  },
});

export const queryConfigurationReader: RepositoryFactory<
  QueryRepositoryFactoryContext<ConfigurationScope>,
  ConfigurationReadRepository
> = ({ query, scope, transaction }) => ({
  async findConfiguration(namespaceId, configurationId) {
    transaction.assertActive();
    if (namespaceId !== scope.namespaceId) return undefined;
    const result = await query.query(
      "SELECT c.id, c.namespace_id, c.generation, c.created_at FROM occ.configurations c JOIN occ.installation i ON i.id=$1 WHERE c.namespace_id=$2 AND c.id=$3",
      [scope.installationId, namespaceId, configurationId],
    );
    transaction.assertActive();
    const row = result.rows[0];
    if (row === undefined) return undefined;
    if (
      row === null ||
      typeof row !== "object" ||
      !("id" in row) ||
      row.id !== configurationId ||
      !("namespace_id" in row) ||
      row.namespace_id !== namespaceId ||
      !("generation" in row) ||
      typeof row.generation !== "number" ||
      !Number.isSafeInteger(row.generation) ||
      row.generation < 1 ||
      !("created_at" in row) ||
      !(row.created_at instanceof Date)
    )
      throw new Error("The fixture row is invalid.");
    return Object.freeze({
      id: configurationId,
      namespaceId,
      kind: "agent" as const,
      generation: row.generation,
      createdAt: row.created_at.toISOString(),
    });
  },
});
