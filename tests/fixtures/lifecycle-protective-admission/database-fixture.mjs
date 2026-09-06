import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export function databaseSelection() {
  const app = process.env.OCC_LIFECYCLE_ADMISSION_DATABASE_URL;
  const migrator = process.env.OCC_LIFECYCLE_ADMISSION_MIGRATOR_DATABASE_URL;
  const worker = process.env.OCC_LIFECYCLE_ADMISSION_WORKER_DATABASE_URL;
  const urls = [app, migrator, worker].filter(Boolean).map((value) => new URL(value));
  for (const url of urls) {
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.match(url.pathname, /^\/openclaw_lifecycle_admission_[a-z0-9_]+$/);
    assert.equal(url.hostname, urls[0].hostname);
    assert.equal(url.port, urls[0].port);
    assert.equal(url.pathname, urls[0].pathname);
  }
  return {
    app,
    migrator,
    worker,
    skip:
      app && migrator
        ? false
        : "Select and migrate a dedicated loopback lifecycle-admission database with application and migrator URLs; no database was selected.",
  };
}

export async function databaseFixture(t, selected = databaseSelection()) {
  assert.ok(selected.app && selected.migrator);
  // Imports occur only after selection. Missing prepared dependencies must fail
  // an explicitly selected run; an unselected suite remains an honest skip.
  const [{ default: pg }, stateModule, queueModule] = await Promise.all([
    import("pg"),
    import("../../../packages/occ/src/state/postgres-state.ts"),
    import("../../../packages/occ/src/state/postgres-work-queue.ts"),
  ]);
  const makePool = (connectionString) =>
    new pg.Pool({
      connectionString,
      max: 6,
      connectionTimeoutMillis: 1_000,
      query_timeout: 10_000,
    });
  const app = makePool(selected.app);
  const migrator = makePool(selected.migrator);
  const worker = selected.worker ? makePool(selected.worker) : undefined;
  for (const pool of [app, migrator, worker].filter(Boolean)) pool.on("error", () => {});
  t.after(async () => {
    await Promise.all([app.end(), migrator.end(), worker?.end()]);
  });
  const identity = (
    await app.query(
      "SELECT current_user AS name, rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  assert.deepEqual(identity, {
    name: "occ_app",
    rolsuper: false,
    rolcreaterole: false,
    rolbypassrls: false,
  });
  const operator = (
    await migrator.query(
      "SELECT current_user AS name, rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  assert.deepEqual(operator, {
    name: "occ_migrator",
    rolsuper: false,
    rolcreaterole: false,
    rolbypassrls: false,
  });
  assert.equal(
    (
      await app.query(
        "SELECT to_regclass('occ.agent_lifecycle_admissions') IS NOT NULL AS migrated",
      )
    ).rows[0].migrated,
    true,
  );
  return {
    selected,
    app,
    migrator,
    worker,
    makePool,
    ...stateModule,
    ...queueModule,
    state: new stateModule.PostgresPlatformState(app),
  };
}

export async function rollback(pool, work, isolation = "READ COMMITTED") {
  assert.ok(["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"].includes(isolation));
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    return await work(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

export async function familyCounts(pool, input) {
  return (
    await pool.query(
      `SELECT
    (SELECT count(*)::int FROM occ.agent_runtime_intents WHERE transition_ref=$1) intents,
    (SELECT count(*)::int FROM occ.agent_lifecycle_admissions WHERE operation_ref=$1) admissions,
    (SELECT count(*)::int FROM occ.runtime_cleanup_responsibilities WHERE responsibility_ref=$2) cleanup,
    (SELECT count(*)::int FROM occ.controller_work WHERE idempotency_key=$3) work,
    (SELECT count(*)::int FROM occ.audit_events WHERE id=$4) audit,
    (SELECT count(*)::int FROM occ.audit_export_outbox WHERE audit_event_id=$4) export`,
      [input.transitionRef, input.responsibilityRef, input.workId, input.audit.id],
    )
  ).rows[0];
}

export async function waitForBlock(pool, blockedPid, blockerPid) {
  const until = performance.now() + 3_000;
  do {
    if (
      (
        await pool.query("SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked", [
          blockedPid,
          blockerPid,
        ])
      ).rows[0].blocked
    )
      return;
    await delay(10);
  } while (performance.now() < until);
  assert.fail("The actual PostgreSQL statement did not wait for the expected transaction lock.");
}

// Operator-only rows in the separately selected disposable database. There is
// no role creation/grant, application capability setter or live-cutover claim.
export async function capability(client, installationId, stage) {
  assert.ok(["legacy", "live"].includes(stage));
  const version = stage === "live" ? 1 : null;
  await client.query(
    `INSERT INTO occ.lifecycle_capabilities
    (installation_id, stage, capability_version, api_version, worker_version, maintenance_version, receiving_version)
    VALUES($1,$2,1,$3,$3,$3,$3)
    ON CONFLICT (installation_id) DO UPDATE SET stage=EXCLUDED.stage,
      capability_version=occ.lifecycle_capabilities.capability_version+1,
      api_version=EXCLUDED.api_version,worker_version=EXCLUDED.worker_version,
      maintenance_version=EXCLUDED.maintenance_version,receiving_version=EXCLUDED.receiving_version`,
    [installationId, stage, version],
  );
}
