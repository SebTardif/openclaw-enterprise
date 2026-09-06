export const coreTableNames = [
  "installation",
  "namespaces",
  "configurations",
  "secrets",
  "serviceAccounts",
];

// Callers supply the actual Drizzle exports from their declared dependency context.
export function createSchemaMetadataTools({
  getTableConfig,
  getTableColumns,
  PgTable,
  PgDialect,
  is,
  SQL,
}) {
  const dialect = new PgDialect();

  function normalizeValue(value) {
    if (value === undefined) return null;
    if (is(value, SQL)) {
      const query = dialect.sqlToQuery(value);
      return { sql: query.sql, params: query.params.map(normalizeValue) };
    }
    if (typeof value === "bigint") return { bigint: value.toString() };
    if (typeof value === "function") return { function: value.toString() };
    if (value instanceof Date) return { date: value.toISOString() };
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (value !== null && typeof value === "object") {
      // Drizzle index reads may omit fields whose value was initially undefined.
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalizeValue(entry)]),
      );
    }
    return value;
  }

  function tableIdentifier(table) {
    return {
      schema: table[PgTable.Symbol.Schema] ?? null,
      name: table[PgTable.Symbol.Name],
    };
  }

  function schemaTables(schema) {
    return Object.entries(schema)
      .filter(([, value]) => is(value, PgTable))
      .sort(([left], [right]) => left.localeCompare(right));
  }

  function byName(entries) {
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }

  function normalizeForeignKey(foreignKey) {
    const reference = foreignKey.reference();
    return {
      name: foreignKey.getName(),
      table: tableIdentifier(foreignKey.table),
      columns: reference.columns.map((column) => column.name),
      foreignTable: tableIdentifier(reference.foreignTable),
      foreignColumns: reference.foreignColumns.map((column) => column.name),
      onUpdate: foreignKey.onUpdate ?? null,
      onDelete: foreignKey.onDelete ?? null,
    };
  }

  function normalizeTable(table) {
    const config = getTableConfig(table);
    const propertyNames = new Map(
      Object.entries(getTableColumns(table)).map(([property, column]) => [column, property]),
    );
    return {
      schema: config.schema ?? null,
      name: config.name,
      columns: config.columns.map((column) => ({
        property: propertyNames.get(column),
        name: column.name,
        sqlType: column.getSQLType(),
        dataType: column.dataType,
        columnType: column.columnType,
        notNull: column.notNull,
        primary: column.primary,
        hasDefault: column.hasDefault,
        default: normalizeValue(column.default),
        defaultFn: normalizeValue(column.defaultFn),
        onUpdateFn: normalizeValue(column.onUpdateFn),
        isUnique: column.isUnique,
        uniqueName: column.uniqueName ?? null,
        uniqueType: column.uniqueType ?? null,
        enumValues: normalizeValue(column.enumValues),
        generated: normalizeValue(column.generated),
        generatedIdentity: normalizeValue(column.generatedIdentity),
      })),
      primaryKeys: byName(
        config.primaryKeys.map((key) => ({
          name: key.getName(),
          columns: key.columns.map((column) => column.name),
        })),
      ),
      uniqueConstraints: byName(
        config.uniqueConstraints.map((key) => ({
          name: key.getName(),
          columns: key.columns.map((column) => column.name),
          nullsNotDistinct: key.nullsNotDistinct,
        })),
      ),
      checks: byName(
        config.checks.map((check) => ({ name: check.name, value: normalizeValue(check.value) })),
      ),
      indexes: byName(
        config.indexes.map(({ config: { table: _table, ...index } }) => normalizeValue(index)),
      ),
      foreignKeys: byName(config.foreignKeys.map(normalizeForeignKey)),
      policies: byName(
        config.policies.map((policy) => ({
          name: policy.name,
          as: policy.as ?? null,
          for: policy.for ?? null,
          to: normalizeValue(policy.to),
          using: normalizeValue(policy.using),
          withCheck: normalizeValue(policy.withCheck),
        })),
      ),
      enableRLS: config.enableRLS,
    };
  }

  function normalizeSchemaMetadata(schema) {
    return {
      exports: Object.keys(schema).sort(),
      schema: schema.occSchema.schemaName,
      tables: Object.fromEntries(
        schemaTables(schema).map(([name, table]) => [name, normalizeTable(table)]),
      ),
    };
  }

  function normalizeCoreMetadata(schema) {
    const complete = normalizeSchemaMetadata(schema);
    const tables = Object.fromEntries(coreTableNames.map((name) => [name, complete.tables[name]]));
    const targets = new Set(Object.values(tables).map((table) => `${table.schema}.${table.name}`));
    return {
      exports: complete.exports,
      schema: complete.schema,
      tables,
      inboundForeignKeys: Object.values(complete.tables)
        .flatMap((table) => table.foreignKeys)
        .filter((key) => targets.has(`${key.foreignTable.schema}.${key.foreignTable.name}`)),
    };
  }

  return { normalizeSchemaMetadata, normalizeCoreMetadata, schemaTables, tableIdentifier };
}
