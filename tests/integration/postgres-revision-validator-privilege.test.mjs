import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { exampleCredentialWorkloadSelectionV1 } from "../fixtures/credential-workload-selection-v1/producer.ts";
import {
  revisionResources,
  revisionRecord,
  writeRevisionOwner,
} from "../conformance/revision-repository.contract.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const validator = "occ.revision_credential_selection_valid_v1(jsonb,text,text,text)";

function credentialRecord(revision, installationId) {
  // Synthetic nonsecret metadata exercises storage validation only; it supplies
  // no account, material, provider, or current-authority participant.
  const record = exampleCredentialWorkloadSelectionV1();
  const scope = { installationId, namespaceId: revision.namespaceId, agentId: revision.agentId };
  function bind(value) {
    if (value === null || typeof value !== "object") return;
    if (Object.hasOwn(value, "scope")) value.scope = { ...scope };
    for (const child of Object.values(value)) bind(child);
  }
  bind(record);
  record.revisionId = revision.id;
  return record;
}

test(
  "PostgreSQL revision validator permits limited-role inserts and preserves CHECK enforcement",
  {
    skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to a migrated disposable database.",
    timeout: 30_000,
  },
  async (t) => {
    const target = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
    assert.equal(target.username, "occ_app");
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 250,
    });
    t.after(() => pool.end());
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

    // Check the actual function ACL and execution identity, not migration text.
    // The exact grant must not expose PUBLIC execution or immutable-row writes.
    const privilege = (
      await pool.query(
        `SELECT p.prosecdef, p.provolatile, p.proconfig,
                has_function_privilege(current_user, p.oid, 'EXECUTE') AS executable,
                EXISTS (
                  SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE a.grantee=0 AND a.privilege_type='EXECUTE'
                ) AS public_execute,
                EXISTS (
                  SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname=current_user)
                    AND a.privilege_type='EXECUTE' AND a.is_grantable
                ) AS can_grant,
                has_any_column_privilege(current_user, 'occ.agent_revisions', 'UPDATE') AS can_update,
                has_table_privilege(current_user, 'occ.agent_revisions', 'DELETE') AS can_delete
           FROM pg_proc p WHERE p.oid=$1::regprocedure`,
        [validator],
      )
    ).rows[0];
    assert.deepEqual(privilege, {
      prosecdef: false,
      provolatile: "s",
      proconfig: ["search_path=pg_catalog, pg_temp"],
      executable: true,
      public_execute: false,
      can_grant: false,
      can_update: false,
      can_delete: false,
    });

    const state = new PostgresPlatformState(pool);
    const resources = revisionResources();
    const withoutSelection = revisionRecord(resources);
    const withSelection = revisionRecord(resources, 2);
    const rollback = new Error("Rollback validator privilege fixtures.");
    await assert.rejects(
      state.transact(async (unit) => {
        const installation =
          (await unit.installations.getInstallation()) ??
          (await unit.installations.createInstallation({
            id: `ins_${randomUUID()}`,
            name: "Revision validator privilege fixture",
            createdAt: resources.namespace.createdAt,
          }));
        await writeRevisionOwner(unit, resources);
        const record = credentialRecord(withSelection, installation.id);

        // Both ordinary and credential-bearing revisions use the real INSERT.
        // PostgreSQL checks function privileges even on an optional CHECK branch.
        assert.deepEqual(await unit.revisions.createRevision(withoutSelection), withoutSelection);
        assert.deepEqual(await unit.revisions.createRevision(withSelection, record), withSelection);
        for (const revision of [withoutSelection, withSelection])
          assert.deepEqual(
            await unit.revisions.findRevision(revision.namespaceId, revision.agentId, revision.id),
            revision,
          );

        // Bypass only application decoding to exercise the installed database
        // CHECK with malformed and wrong-scope metadata. Savepoints contain each
        // expected SQL error; every fixture is rolled back by the outer owner.
        for (const kind of ["malformed", "wrong-scope"]) {
          const id = `rev_${randomUUID()}`;
          const invalid =
            kind === "malformed" ? {} : credentialRecord({ ...withSelection, id }, installation.id);
          if (kind === "wrong-scope") invalid.scope.namespaceId = `ns_${randomUUID()}`;
          await state.queryInTransaction(unit, "SAVEPOINT invalid_credential_selection");
          await assert.rejects(
            state.queryInTransaction(
              unit,
              `INSERT INTO occ.agent_revisions
                 (id, namespace_id, agent_id, revision_number, provider_id, admitted_spec, admitted_at)
               SELECT $1, namespace_id, agent_id, 3, provider_id,
                      jsonb_set(admitted_spec, '{credential_workload_selection}', $2::jsonb), admitted_at
                 FROM occ.agent_revisions WHERE id=$3`,
              [id, JSON.stringify(invalid), withSelection.id],
            ),
            { code: "23514", constraint: "agent_revisions_credential_selection" },
          );
          await state.queryInTransaction(
            unit,
            "ROLLBACK TO SAVEPOINT invalid_credential_selection",
          );
          await state.queryInTransaction(unit, "RELEASE SAVEPOINT invalid_credential_selection");
        }
        throw rollback;
      }),
      (error) => error === rollback,
    );
    assert.equal(
      (
        await pool.query("SELECT count(*)::integer AS count FROM occ.namespaces WHERE id=$1", [
          resources.namespace.id,
        ])
      ).rows[0].count,
      0,
    );
  },
);
