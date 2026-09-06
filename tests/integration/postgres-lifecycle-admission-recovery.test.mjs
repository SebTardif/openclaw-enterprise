import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  apply,
  committed,
  protectiveWrite,
  seedRuntimeOwner,
} from "../fixtures/lifecycle-protective-admission/shared-cases.mjs";
import {
  databaseFixture,
  databaseSelection,
  familyCounts,
} from "../fixtures/lifecycle-protective-admission/database-fixture.mjs";

const selected = databaseSelection();
const execute = promisify(execFile);

// A fresh process reads the actual database with no adapter/snapshot retained
// from the admitting process. It does not replay admission or mint new IDs.
async function readInFreshProcess(databaseUrl, scope, operationRef) {
  const source = `
    import pg from "pg";
    import { PostgresPlatformState } from "./packages/occ/src/state/postgres-state.ts";
    const pool = new pg.Pool({ connectionString: process.env.OCC_LIFECYCLE_ADMISSION_DATABASE_URL, connectionTimeoutMillis: 1000, query_timeout: 10000 });
    try {
      const input = JSON.parse(process.env.OCC_LIFECYCLE_RECOVERY_INPUT);
      const state = new PostgresPlatformState(pool);
      const retained = await state.read(view => view.lifecycleAdmissions.findCommitted(input.scope,input.operationRef));
      process.stdout.write(JSON.stringify(retained ?? null));
    } finally { await pool.end(); }
  `;
  const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", source], {
    cwd: new URL("../../", import.meta.url),
    timeout: 20_000,
    maxBuffer: 1_048_576,
    env: {
      ...process.env,
      OCC_LIFECYCLE_ADMISSION_DATABASE_URL: databaseUrl,
      OCC_LIFECYCLE_RECOVERY_INPUT: JSON.stringify({ scope, operationRef }),
    },
  });
  return JSON.parse(stdout);
}

test(
  "PostgreSQL protective admission recovery preserves original committed correspondence",
  { skip: selected.skip, timeout: 90_000 },
  async (t) => {
    const fixture = await databaseFixture(t, selected);
    const { state, app, makePool, PostgresPlatformState, PostgresCommitOutcomeUnknownError } =
      fixture;

    await t.test(
      "fresh process recovers the complete original record after a later head",
      async () => {
        const owner = await seedRuntimeOwner(state);
        const original = protectiveWrite(owner);
        const result = await apply(state, original);
        await apply(state, protectiveWrite(owner, "stop", 1));
        const recovered = await readInFreshProcess(
          selected.app,
          owner.scope,
          original.transitionRef,
        );
        assert.deepEqual(recovered, JSON.parse(JSON.stringify(result.retained)));
        assert.deepEqual(await familyCounts(app, original), {
          intents: 1,
          admissions: 1,
          cleanup: 1,
          work: 1,
          audit: 1,
          export: 1,
        });
        const foreign = await seedRuntimeOwner(state);
        assert.equal(
          await readInFreshProcess(selected.app, foreign.scope, original.transitionRef),
          null,
        );
      },
    );

    await t.test(
      "a lost actual COMMIT acknowledgement recovers by original readback without replay",
      async () => {
        const { runtimeCommitAckProxy } =
          await import("../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs");
        const owner = await seedRuntimeOwner(state);
        const original = protectiveWrite(owner, "stop");
        // Existing protocol proxy consumes the server's real COMMIT completion;
        // no database client or transaction method is monkeypatched.
        const proxy = await runtimeCommitAckProxy(selected.app);
        const uncertainPool = makePool(proxy.url);
        const uncertain = new PostgresPlatformState(uncertainPool);
        let provisional;
        try {
          await uncertain.read((view) => view.installations.getInstallation());
          proxy.arm();
          await assert.rejects(
            uncertain.transact(async (unit) => {
              provisional = await unit.lifecycleAdmissions.applyProtective(original);
              assert.equal(provisional.kind, "provisional");
              return provisional;
            }),
            PostgresCommitOutcomeUnknownError,
          );
          assert.equal(proxy.observedCommit, true);
        } finally {
          await uncertainPool.end();
          await proxy.close();
        }
        assert.ok(provisional);
        const recovered = await readInFreshProcess(
          selected.app,
          owner.scope,
          original.transitionRef,
        );
        assert.deepEqual(recovered, JSON.parse(JSON.stringify(provisional.retained)));
        assert.equal(recovered.cleanup.inventoryStatus, "unresolved");
        assert.equal(recovered.export.state, "pending");
        const before = await familyCounts(app, original);
        await assert.rejects(apply(state, original));
        assert.deepEqual(await familyCounts(app, original), before);
        assert.deepEqual(await committed(state, owner, original), provisional.retained);
      },
    );
  },
);
