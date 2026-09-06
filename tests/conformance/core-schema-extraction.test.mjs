import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("core schema extraction preserves actual metadata and canonical object identity", (t) => {
  // Run inside the dependency-owning package so the checks use its real Drizzle
  // modules without teaching consumers to resolve another package's dependencies.
  const result = spawnSync(process.execPath, ["--max-old-space-size=1536", "--input-type=module"], {
    cwd: fileURLToPath(new URL("../../packages/occ/", import.meta.url)),
    encoding: "utf8",
    timeout: 60_000,
    input: String.raw`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getTableColumns, is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { occSchema } from "./src/state/schema/shared.ts";
import { installation } from "./src/state/schema/installation.ts";
import { namespaces } from "./src/state/schema/namespace.ts";
import { configurations } from "./src/state/schema/configuration.ts";
import { secrets } from "./src/state/schema/secret.ts";
import { serviceAccounts } from "./src/state/schema/service-account.ts";
import * as aggregate from "./src/state/postgres-schema.ts";
import {
  coreTableNames,
  createSchemaMetadataTools,
} from "../../tests/fixtures/core-schema-extraction/metadata.mjs";

const { normalizeCoreMetadata, schemaTables, tableIdentifier } = createSchemaMetadataTools({
  getTableConfig,
  getTableColumns,
  PgTable,
  PgDialect,
  is,
  SQL,
});
const expected = JSON.parse(readFileSync(
  new URL("../../tests/fixtures/core-schema-extraction/expected-core-metadata.json", import.meta.url),
  "utf8",
));
const leaves = { installation, namespaces, configurations, secrets, serviceAccounts };

assert.strictEqual(aggregate.occSchema, occSchema, "The aggregate must expose the shared schema root");
assert.equal(Object.hasOwn(aggregate, "collatedText"), false, "Private helpers must not become aggregate exports");
assert.equal(Object.hasOwn(aggregate, "identifierPatterns"), false, "Private helpers must not become aggregate exports");

for (const name of coreTableNames) {
  const leaf = leaves[name];
  assert.strictEqual(aggregate[name], leaf, name + " must be the original leaf table");
  assert.equal(leaf[PgTable.Symbol.Schema], occSchema.schemaName);
  const columns = getTableColumns(leaf);
  const aggregateColumns = getTableColumns(aggregate[name]);
  assert.deepEqual(Object.keys(aggregateColumns), Object.keys(columns));
  for (const [property, column] of Object.entries(columns)) {
    assert.strictEqual(aggregateColumns[property], column, name + "." + property);
    assert.strictEqual(leaf[property], column, name + "." + property);
    assert.strictEqual(column.table, leaf, name + "." + property + " owner");
  }
}

// This fixture was captured from the original complete schema using the same
// actual metadata API. It includes all inbound core references, including those
// constructed by the unchanged domain factories.
assert.deepEqual(normalizeCoreMetadata(aggregate), expected);

const qualifiedName = (table) => {
  const identity = tableIdentifier(table);
  return identity.schema + "." + identity.name;
};
const coreTargets = new Map(Object.values(leaves).map((table) => [qualifiedName(table), table]));
let inboundCoreForeignKeys = 0;

for (const [sourceName, source] of schemaTables(aggregate)) {
  for (const foreignKey of getTableConfig(source).foreignKeys) {
    const reference = foreignKey.reference();
    const target = coreTargets.get(qualifiedName(reference.foreignTable));
    if (!target) continue;
    inboundCoreForeignKeys += 1;
    const label = sourceName + ": " + foreignKey.getName();
    assert.strictEqual(foreignKey.table, source, label + " source table");
    assert.strictEqual(reference.foreignTable, target, label + " target table");

    // Drizzle builds local extra-config columns separately from query columns.
    // Assert against the actual corresponding objects for each kind of key.
    const inline = source[PgTable.Symbol.InlineForeignKeys].includes(foreignKey);
    const localColumns = Object.values(inline
      ? getTableColumns(source)
      : source[PgTable.Symbol.ExtraConfigColumns]);
    for (const column of reference.columns) {
      assert.strictEqual(column.table, source, label + " local column owner");
      assert.strictEqual(localColumns.find((candidate) => candidate.name === column.name), column,
        label + " local column " + column.name);
    }

    const targetColumns = Object.values(getTableColumns(target));
    for (const column of reference.foreignColumns) {
      assert.strictEqual(column.table, target, label + " target column owner");
      assert.strictEqual(targetColumns.find((candidate) => candidate.name === column.name), column,
        label + " target column " + column.name);
    }
  }
}

assert.equal(inboundCoreForeignKeys, expected.inboundForeignKeys.length);
assert.ok(inboundCoreForeignKeys > 0, "The full schema must retain its inbound core references");
console.log(JSON.stringify({ coreTables: coreTableNames.length, inboundCoreForeignKeys }));
`,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Schema inspection terminated: ${result.signal}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  t.diagnostic(result.stdout.trim());
});
