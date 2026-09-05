import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { PostgresPlatformState } from "../../../packages/occ/src/state/postgres-state.ts";

// Called in a fresh Node process after an externally observed restart of the
// isolated real PostgreSQL container. Does not start/stop or modify the database.
const expected = JSON.parse(
  await readFile(process.env.OCC_RUNTIME_AUTHORITY_RESTART_RECEIPT, "utf8"),
);
const pool = new pg.Pool({ connectionString: process.env.OCC_TEST_DATABASE_URL });
try {
  const state = new PostgresPlatformState(pool);
  const actual = await state.read(async (unit) => ({
    original: await unit.runtimeAuthority.findOperation(expected.target, expected.operationRef),
    record: await unit.runtimeAuthority.findAssignment(
      expected.target,
      expected.target.assignmentRef.id,
    ),
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), {
    original: expected.original,
    record: expected.record,
  });
  const {
    rows: [server],
  } = await pool.query(
    "SELECT current_user, current_setting('server_version') AS version, pg_postmaster_start_time() AS started_at",
  );
  console.log(
    JSON.stringify({
      result: "exact-readback-after-real-server-restart",
      operationRef: expected.operationRef,
      server,
    }),
  );
} finally {
  await pool.end();
}
