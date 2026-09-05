import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { verifyChannelStatusIdempotency } from "../conformance/channel-status-idempotency.contract.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const options = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL for real PostgreSQL channel status idempotency.",
  timeout: 60000,
};

for (const kind of ["app", "human", "route"]) {
  test(
    `PostgreSQL ${kind} status no-ops ignore earlier timestamps while preserving validation and CAS`,
    options,
    async (t) => {
      const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
      t.after(() => pool.end());
      await verifyChannelStatusIdempotency(new PostgresPlatformState(pool), kind);
    },
  );
}
