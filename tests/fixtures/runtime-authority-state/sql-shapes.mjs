import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RuntimeAuthoritySchemasV1 } from "../../../packages/contracts/src/runtime-authority-v1.ts";

// This persisted-shape check binds the SQL snapshots to the imported, accepted schemas.
// PostgreSQL independently executes the validator in the limited-role integration suite.
export async function verifySqlShapes() {
  const sql = await readFile(
    new URL("../../../migrations/0019_runtime_authority.sql", import.meta.url),
    "utf8",
  );
  for (const [name, schema] of [
    ["mutation", RuntimeAuthoritySchemasV1.mutation],
    ["operationState", RuntimeAuthoritySchemasV1.operationState],
  ]) {
    const token = `$runtime_${name}$`;
    const parts = sql.split(token);
    assert.equal(parts.length, 3, `one exact ${name} SQL snapshot`);
    assert.deepEqual(JSON.parse(parts[1]), JSON.parse(JSON.stringify(schema)));
  }
}
