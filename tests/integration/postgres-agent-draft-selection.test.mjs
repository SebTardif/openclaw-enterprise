import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import {
  serviceAccountResources,
  seedServiceAccountInstallation,
} from "../conformance/service-account-repository.contract.mjs";

// This suite owns a separately migrated, empty database. It exercises persisted
// draft data and SQL privileges; it creates no admitted profile or runtime.
const databaseUrl = process.env.OCC_AGENT_DRAFT_SELECTION_TEST_DATABASE_URL;
test(
  "PostgreSQL Agent draft selection retains exact column grants and constraints",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_AGENT_DRAFT_SELECTION_TEST_DATABASE_URL to a fresh migrated database.",
    timeout: 30000,
  },
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 1000,
    });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0],
      {
        name: "occ_app",
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolbypassrls: false,
      },
    );
    assert.equal(
      await store.read((unit) => unit.installations.getInstallation()),
      undefined,
      "the dedicated database must be empty",
    );
    assert.equal(
      (await pool.query("SELECT count(*)::integer AS count FROM occ.controller_work")).rows[0]
        .count,
      0,
      "the dedicated database must contain no work",
    );
    await seedServiceAccountInstallation(store);
    const granted = [
      "configuration_id",
      "execution_mode",
      "service_account_id",
      "provider_id",
      "workload_profile_selection",
    ];
    const protectedColumns = ["namespace_id", "id", "service_principal_id", "created_at"];
    const privileges = (
      await pool.query(
        `SELECT name, has_column_privilege(current_user, 'occ.agents', name, 'UPDATE') AS allowed
         FROM unnest($1::text[]) AS columns(name) ORDER BY name`,
        [[...granted, ...protectedColumns]],
      )
    ).rows;
    assert.deepEqual(
      privileges,
      [...granted, ...protectedColumns].sort().map((name) => ({
        name,
        allowed: granted.includes(name),
      })),
    );
    assert.equal(
      (
        await pool.query(
          "SELECT has_table_privilege(current_user, 'occ.agents', 'UPDATE') AS allowed",
        )
      ).rows[0].allowed,
      false,
    );
    const r = serviceAccountResources();
    await store.transact(async (unit) => {
      await unit.namespaces.createNamespace(r.namespace);
      await unit.serviceAccounts.createServiceAccount(r.account);
      await unit.configurations.createConfiguration(r.configuration);
      await unit.agents.createAgent(r.agent);
    });
    // Stored draft data and column privileges do not establish an admitted
    // head or authority to deploy this syntactically valid selection.
    const selection = {
      manifestRef: randomUUID(),
      manifestDigest: "sha256:" + "a".repeat(64),
      admissionRef: randomUUID(),
      admissionVersion: 1,
    };
    const selected = await store.transact((unit) =>
      unit.agents.updateConfiguration(
        r.namespace.id,
        r.agent.id,
        r.configuration.id,
        undefined,
        undefined,
        undefined,
        selection,
      ),
    );
    assert.deepEqual(selected.workloadProfileSelection, selection);
    const detached = await store.transact((unit) =>
      unit.agents.updateConfiguration(
        r.namespace.id,
        r.agent.id,
        r.configuration.id,
        undefined,
        null,
      ),
    );
    assert.equal(detached.serviceAccountId, undefined);
    assert.deepEqual(detached.workloadProfileSelection, selection);
    await assert.rejects(
      pool.query(
        "UPDATE occ.agents SET workload_profile_selection=$3::jsonb WHERE namespace_id=$1 AND id=$2",
        [r.namespace.id, r.agent.id, JSON.stringify({ ...selection, admissionVersion: 0 })],
      ),
      (error) => error.code === "23514" && error.constraint === "agents_workload_profile_selection",
    );
    for (const column of protectedColumns) {
      await assert.rejects(
        pool.query(`UPDATE occ.agents SET ${column}=${column} WHERE namespace_id=$1 AND id=$2`, [
          r.namespace.id,
          r.agent.id,
        ]),
        (error) => error.code === "42501",
      );
    }
    assert.deepEqual(
      await store.read((unit) => unit.agents.findAgent(r.namespace.id, r.agent.id)),
      detached,
    );
  },
);
