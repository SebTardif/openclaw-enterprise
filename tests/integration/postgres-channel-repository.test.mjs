import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { createPostgresChannelBindingRepository } from "../../packages/occ/src/state/postgres/channel-bindings.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import {
  channelRecords,
  seedChannelOwner,
} from "../conformance/channel-binding-store.contract.mjs";
import {
  assertChannelRepositoryClosed,
  verifyChannelRepositoryBootstrap,
  verifyChannelRepositoryLifetime,
  verifyChannelRepositoryAtomicity,
  verifyChannelRepositoryDeletingNamespaceTarget,
} from "../conformance/channel-repository.contract.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const options = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL for actual PostgreSQL channel repository coverage.",
  timeout: 60000,
};

test("PostgreSQL channel factory construction does not query or resolve Installation scope", () => {
  // This checks the construction contract only. Persistence proof below uses
  // the actual limited-role database and a real checked-out client.
  const unexpected = () => assert.fail("factory construction performed backend access");
  const repository = createPostgresChannelBindingRepository({
    transaction: { assertActive: unexpected },
    query: { query: unexpected },
    currentInstallation: unexpected,
    get scope() {
      return unexpected();
    },
  });
  assert.equal(typeof repository.createChannelInstallation, "function");
});

test(
  "PostgreSQL channel factory shares the owner's real client and rollback boundary",
  options,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    const owner = await seedChannelOwner(store);
    const records = channelRecords(owner);
    const client = await pool.connect();
    const transaction = new RepositoryTransactionLifetime();
    try {
      await client.query("BEGIN");
      const context = {
        transaction,
        scope: Object.freeze({ installationId: owner.installation.id }),
        query: client,
        currentInstallation: async () => {
          const { rows } = await client.query("SELECT id, name, created_at FROM occ.installation");
          assert.equal(rows.length, 1);
          return Object.freeze({
            id: rows[0].id,
            name: rows[0].name,
            createdAt: rows[0].created_at.toISOString(),
          });
        },
      };
      const repository = createPostgresChannelBindingRepository(context);
      const sibling = createPostgresChannelBindingRepository(context);
      await repository.createChannelInstallation(records.app);
      await repository.createHumanBinding(records.human);
      await repository.createAgentBinding(records.route);
      // A separate pool query cannot see these uncommitted writes. A factory
      // using a fresh client or committing independently would fail this proof.
      assert.equal(
        (await pool.query("SELECT id FROM occ.channel_installations WHERE id=$1", [records.app.id]))
          .rowCount,
        0,
      );
      assert.deepEqual(await sibling.findChannelInstallation(records.app.id), records.app);
      assert.deepEqual(
        await sibling.findHumanBinding(records.app.id, records.human.id),
        records.human,
      );
      assert.deepEqual(
        await sibling.findAgentBinding(records.app.id, records.route.id),
        records.route,
      );
      const foreignScope = createPostgresChannelBindingRepository({
        ...context,
        scope: { installationId: "foreign" },
      });
      await assert.rejects(
        foreignScope.findChannelInstallation(records.app.id),
        ScopeViolationError,
      );
      await transaction.finish();
      await assertChannelRepositoryClosed(repository, records);
      await assertChannelRepositoryClosed(sibling, records);
      // Releasing the repository lifetime never commits or releases the owner's client.
      assert.equal(
        (
          await client.query("SELECT id FROM occ.channel_agent_bindings WHERE id=$1", [
            records.route.id,
          ])
        ).rowCount,
        1,
      );
      await client.query("ROLLBACK");
      await store.read(async (s) => {
        assert.equal(await s.channelBindings.findChannelInstallation(records.app.id), undefined);
        assert.equal(
          await s.channelBindings.findHumanBinding(records.app.id, records.human.id),
          undefined,
        );
        assert.equal(
          await s.channelBindings.findAgentBinding(records.app.id, records.route.id),
          undefined,
        );
      });
    } finally {
      transaction.close();
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
  },
);

for (const [name, verify] of [
  ["drains queued channel calls and closes every escaped method", verifyChannelRepositoryLifetime],
  [
    "commits and rolls back channel records, resources, audit and work together",
    verifyChannelRepositoryAtomicity,
  ],
  [
    "rejects a route targeting an empty deleting Namespace",
    verifyChannelRepositoryDeletingNamespaceTarget,
  ],
]) {
  test(`PostgreSQL aggregate ${name}`, options, async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    t.after(() => pool.end());
    await verify(new PostgresPlatformState(pool));
  });
}

const bootstrapUrl = process.env.OCC_PRODUCTION_WIREUP_DATABASE_URL;
test(
  "PostgreSQL aggregate sees same-unit Installation bootstrap and rolls back to an empty database",
  {
    skip: bootstrapUrl
      ? false
      : "Set OCC_PRODUCTION_WIREUP_DATABASE_URL to an independently migrated empty disposable database.",
    timeout: 60000,
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: bootstrapUrl, max: 2 });
    t.after(() => pool.end());
    await verifyChannelRepositoryBootstrap(new PostgresPlatformState(pool));
  },
);
