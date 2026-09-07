import assert from "node:assert/strict";
import { domainTableNames, createDomainMetadataTools } from "./metadata.mjs";

const schemaRoot = new URL("../../../packages/occ/src/state/", import.meta.url);
const modules = {
  aggregate: new URL("postgres-schema.ts", schemaRoot).href,
  audit: new URL("schema/audit.ts", schemaRoot).href,
  provider: new URL("schema/provider-account-bindings.ts", schemaRoot).href,
  channel: new URL("schema/channel.ts", schemaRoot).href,
  agent: new URL("schema/agent.ts", schemaRoot).href,
  iam: new URL("schema/iam.ts", schemaRoot).href,
  work: new URL("schema/work-queue.ts", schemaRoot).href,
};

export const importOrders = [
  ["aggregate", "audit", "provider", "channel", "agent", "iam", "work"],
  ["iam", "agent", "work", "audit", "provider", "channel", "aggregate"],
  ["work", "channel", "provider", "aggregate", "iam", "agent", "audit"],
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
  assert.equal(typeof loaded.agent.createAgentTables, "function");
  assert.equal(typeof loaded.iam.createIamTables, "function");
  assert.equal(typeof loaded.work.createControllerWorkTable, "function");
  for (const helper of [
    "createChannelTables",
    "createAgentTables",
    "createIamTables",
    "createControllerWorkTable",
    "collatedText",
    "identifierPatterns",
  ]) {
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

export async function inspectLateIamConstruction({ getTableConfig }) {
  const { occSchema } = await import(new URL("schema/shared.ts", schemaRoot).href);
  const { namespaces } = await import(new URL("schema/namespace.ts", schemaRoot).href);
  const { configurations } = await import(new URL("schema/configuration.ts", schemaRoot).href);
  const { serviceAccounts } = await import(new URL("schema/service-account.ts", schemaRoot).href);
  const { createAgentTables } = await import(modules.agent);
  const { createIamTables } = await import(modules.iam);

  // Assemble the real cycle once in this separate process. Reading it prematurely
  // must fail rather than invent an identity or eagerly construct another table.
  const { agents, agentRevisions } = createAgentTables(
    occSchema,
    { namespaces, configurations, serviceAccounts },
    () => iamIdentities,
  );
  assert.throws(() => getTableConfig(agents), ReferenceError);
  const { iamIdentities } = createIamTables(occSchema, { namespaces, agents });
  for (const [source, constraint, target] of [
    [agents, "agent_service_principal_owner", iamIdentities],
    [agents, "agent_active_revision_owner", agentRevisions],
    [iamIdentities, "iam_identities_agent_owner", agents],
  ]) {
    const key = getTableConfig(source).foreignKeys.find((entry) => entry.getName() === constraint);
    assert.ok(key, constraint);
    assert.strictEqual(key.reference().foreignTable, target, constraint);
    for (const column of key.reference().foreignColumns) assert.strictEqual(column.table, target);
  }
  return { prematureRead: "rejected", originalCycleReferences: 3 };
}
