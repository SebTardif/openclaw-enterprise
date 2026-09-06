import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { createPostgresRevisionRepository } from "../../packages/occ/src/state/postgres/revisions.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import {
  revisionResources,
  revisionRecord,
  seedRevisionInstallation,
  writeRevisionOwner,
  verifyRevisionBootstrap,
  assertRevisionClosed,
  revisionStoreCases,
} from "../conformance/revision-repository.contract.mjs";

const databaseUrl = process.env.OCC_REVISION_REPOSITORY_TEST_DATABASE_URL;
test("PostgreSQL revision factory construction performs no I/O or scope access", () => {
  const unexpected = () => assert.fail("factory eagerly accessed owner");
  const repository = createPostgresRevisionRepository({
    transaction: { assertActive: unexpected },
    query: { query: unexpected },
    agents: { findAgent: unexpected },
    requireInitialized: unexpected,
    rows: unexpected,
    revisionFromRow: unexpected,
    secretBindingsFromState: unexpected,
    validateSecretBindingsAvailable: unexpected,
    get scope() {
      return unexpected();
    },
  });
  assert.deepEqual(Object.keys(repository).sort(), [
    "createRevision",
    "findRevision",
    "listRevisions",
  ]);
});
test(
  "PostgreSQL revision repository on one fresh owned database",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_REVISION_REPOSITORY_TEST_DATABASE_URL to a fresh migrated database.",
    timeout: 90000,
  },
  async (t) => {
    const target = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 250,
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
      await store.loadInstallation(),
      undefined,
      "dedicated database must begin without Installation",
    );
    let bootstrapPassed = false;
    await t.test(
      "pre-bootstrap repository sees same-unit creation then complete rollback",
      async () => {
        await verifyRevisionBootstrap(store);
        assert.equal(await store.loadInstallation(), undefined);
        bootstrapPassed = true;
      },
    );
    assert.equal(bootstrapPassed, true, "halt before persistent fixtures when bootstrap failed");
    const installation = await seedRevisionInstallation(store);
    await t.test("direct factory borrows the exact uncommitted owner client", async () => {
      const resources = revisionResources();
      const withBindings = revisionRecord(resources);
      const { secretBindings: _bindings, ...revision } = withBindings;
      const rollback = new Error("borrowed revision rollback");
      const transaction = new RepositoryTransactionLifetime();
      let repository;
      try {
        await assert.rejects(
          store.transact(async (unit) => {
            await writeRevisionOwner(unit, resources);
            // The factory issues its real INSERT using the ambient store's client.
            // Shared decoding is unnecessary for this create-only borrowing proof;
            // every read/mapper case below uses the fully wired aggregate.
            repository = createPostgresRevisionRepository({
              transaction,
              query: {
                query: (sql, parameters) => store.queryInTransaction(unit, sql, parameters),
              },
              agents: unit.agents,
              requireInitialized: () => unit.installations.getInstallation(),
              rows: () => assert.fail("create does not decode rows"),
              revisionFromRow: () => assert.fail("create does not decode revision"),
              secretBindingsFromState: () => assert.fail("bindings omitted"),
              validateSecretBindingsAvailable: async (_namespaceId, bindings) =>
                assert.equal(bindings, undefined),
              scope: { installationId: installation.id },
            });
            assert.deepEqual(await repository.createRevision(revision), revision);
            assert.deepEqual(
              await unit.revisions.findRevision(
                revision.namespaceId,
                revision.agentId,
                revision.id,
              ),
              revision,
            );
            // A separate connection cannot see the owner transaction's revision.
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::integer AS count FROM occ.agent_revisions WHERE id=$1",
                  [revision.id],
                )
              ).rows[0].count,
              0,
            );
            throw rollback;
          }),
          (error) => error === rollback,
        );
      } finally {
        transaction.close();
      }
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::integer AS count FROM occ.agent_revisions WHERE id=$1",
            [revision.id],
          )
        ).rows[0].count,
        0,
      );
      await assertRevisionClosed(repository, revision);
    });
    for (const [name, verify] of revisionStoreCases) await t.test(name, async () => verify(store));
  },
);
