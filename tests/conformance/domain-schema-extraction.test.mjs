import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { importOrders } from "../fixtures/domain-schema-extraction/import-orders.mjs";

for (const [orderIndex, order] of importOrders.entries()) {
  test(`schema domain extraction preserves metadata and identity when importing ${order.join(" then ")}`, (t) => {
    // Each fresh process exercises the real aggregate and leaves. Drizzle resolves
    // from its owning package; the fixture receives those exact dependency exports.
    const result = spawnSync(
      process.execPath,
      ["--max-old-space-size=1536", "--input-type=module"],
      {
        cwd: fileURLToPath(new URL("../../packages/occ/", import.meta.url)),
        encoding: "utf8",
        timeout: 60_000,
        input: `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getTableColumns, is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { inspectImportOrder } from "../../tests/fixtures/domain-schema-extraction/import-orders.mjs";
const actual = await inspectImportOrder(${orderIndex}, {
  getTableColumns, is, SQL, getTableConfig, PgDialect, PgTable,
});
const expected = JSON.parse(readFileSync(new URL(
  "../../tests/fixtures/domain-schema-extraction/expected-schema-metadata.json", import.meta.url,
), "utf8"));
assert.deepEqual(actual.snapshot, expected);
console.log(JSON.stringify({
  tables: expected.tableCount,
  movedTables: Object.keys(expected.tables).length,
  checkedForeignKeys: actual.checkedForeignKeys,
  order: actual.order,
}));
`,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, `Schema inspection terminated: ${result.signal}`);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    t.diagnostic(result.stdout.trim());
  });
}
