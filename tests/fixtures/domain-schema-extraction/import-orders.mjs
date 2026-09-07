import assert from "node:assert/strict";
import { domainTableNames, createDomainMetadataTools } from "./metadata.mjs";

const schemaRoot = new URL("../../../packages/occ/src/state/", import.meta.url);
const modules = {
  aggregate: new URL("postgres-schema.ts", schemaRoot).href,
  audit: new URL("schema/audit.ts", schemaRoot).href,
  provider: new URL("schema/provider-account-bindings.ts", schemaRoot).href,
  channel: new URL("schema/channel.ts", schemaRoot).href,
};

export const importOrders = [
  ["aggregate", "audit", "provider", "channel"],
  ["audit", "provider", "channel", "aggregate"],
  ["channel", "provider", "aggregate", "audit"],
];

export async function inspectImportOrder(orderIndex, dependencies) {
  assert.ok(Number.isSafeInteger(orderIndex) && importOrders[orderIndex]);
  const loaded = {};
  for (const name of importOrders[orderIndex]) loaded[name] = await import(modules[name]);
  const aggregate = loaded.aggregate;
  const { occSchema } = await import(new URL("schema/shared.ts", schemaRoot).href);
  assert.strictEqual(aggregate.occSchema, occSchema);
  assert.strictEqual(aggregate.auditEvents, loaded.audit.auditEvents);
  assert.strictEqual(
    aggregate.serviceAccountDriverBindings,
    loaded.provider.serviceAccountDriverBindings,
  );
  assert.equal(typeof loaded.channel.createChannelTables, "function");
  for (const helper of ["createChannelTables", "collatedText", "identifierPatterns"]) {
    assert.equal(Object.hasOwn(aggregate, helper), false, helper + " must stay private");
  }

  const { getTableColumns, getTableConfig, PgTable } = dependencies;
  const tools = createDomainMetadataTools(dependencies);
  const tables = tools.schemaTables(aggregate);
  const qualifiedName = (table) => {
    const { schema, name } = tools.tableIdentifier(table);
    return schema + "." + name;
  };
  const canonical = new Map(tables.map(([, table]) => [qualifiedName(table), table]));
  assert.equal(canonical.size, tables.length, "Each retained table has one canonical object");
  const moved = new Set(domainTableNames.map((name) => aggregate[name]));

  for (const name of domainTableNames) {
    const table = aggregate[name];
    assert.equal(table[PgTable.Symbol.Schema], occSchema.schemaName);
    for (const [property, column] of Object.entries(getTableColumns(table))) {
      assert.strictEqual(table[property], column, name + "." + property);
      assert.strictEqual(column.table, table, name + "." + property + " owner");
    }
  }

  let checkedForeignKeys = 0;
  for (const [sourceName, source] of tables) {
    for (const foreignKey of getTableConfig(source).foreignKeys) {
      const reference = foreignKey.reference();
      if (!moved.has(source) && !moved.has(reference.foreignTable)) continue;
      checkedForeignKeys += 1;
      const label = sourceName + ": " + foreignKey.getName();
      const target = canonical.get(qualifiedName(reference.foreignTable));
      assert.ok(target, label + " must reference a canonical table");
      assert.strictEqual(reference.foreignTable, target, label + " target");
      assert.strictEqual(foreignKey.table, source, label + " source");
      // Inline keys and extra-config keys use different actual local column objects.
      const inline = source[PgTable.Symbol.InlineForeignKeys].includes(foreignKey);
      const local = Object.values(
        inline ? getTableColumns(source) : source[PgTable.Symbol.ExtraConfigColumns],
      );
      for (const column of reference.columns) {
        assert.strictEqual(column.table, source, label + " local owner");
        assert.strictEqual(
          local.find((candidate) => candidate.name === column.name),
          column,
        );
      }
      const targetColumns = Object.values(getTableColumns(target));
      for (const column of reference.foreignColumns) {
        assert.strictEqual(column.table, target, label + " foreign owner");
        assert.strictEqual(
          targetColumns.find((candidate) => candidate.name === column.name),
          column,
        );
      }
    }
  }
  assert.ok(checkedForeignKeys > 0);
  const snapshot = tools.snapshot(aggregate);
  assert.equal(checkedForeignKeys, snapshot.relatedForeignKeys.length);
  return { snapshot, checkedForeignKeys, order: importOrders[orderIndex] };
}
