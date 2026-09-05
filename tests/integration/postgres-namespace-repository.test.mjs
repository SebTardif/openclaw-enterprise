import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createPostgresNamespaceRepository } from "../../packages/occ/src/state/postgres/namespaces.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { seedChannelOwner } from "../conformance/channel-binding-store.contract.mjs";
import {
  namespaceRecord,
  namespaceChildren,
  assertNamespaceRepositoryClosed,
  verifyNamespaceRepositoryBootstrap,
  verifyNamespaceRepositoryLifecycle,
  verifyNamespaceRepositoryChildren,
  verifyNamespaceRepositoryLifetime,
  verifyNamespaceRepositoryAtomicity,
} from "../conformance/namespace-repository.contract.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const options = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL for actual PostgreSQL Namespace coverage.",
  timeout: 60000,
};

function borrowedContext(client, transaction, installationId) {
  let initializationReads = 0;
  return {
    get initializationReads() {
      return initializationReads;
    },
    context: {
      query: client,
      transaction,
      scope: { installationId },
      async requireInitialized() {
        initializationReads++;
        const { rows } = await client.query("SELECT id, name, created_at FROM occ.installation");
        if (rows.length === 0)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        assert.equal(rows.length, 1);
        return Object.freeze({
          id: rows[0].id,
          name: rows[0].name,
          createdAt: rows[0].created_at.toISOString(),
        });
      },
    },
  };
}

test("PostgreSQL Namespace factory construction performs no backend or scope access", () => {
  // This sentinel proves construction only. Every persistence case below uses
  // the actual limited-role database and a real checked-out client.
  const unexpected = () => assert.fail("factory construction performed backend access");
  const repository = createPostgresNamespaceRepository({
    transaction: { assertActive: unexpected },
    query: { query: unexpected },
    requireInitialized: unexpected,
    get scope() {
      return unexpected();
    },
  });
  assert.equal(typeof repository.createNamespace, "function");
});

test(
  "PostgreSQL Namespace factory uses the owner's client and mutation-only initialization hook",
  options,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    const owner = await seedChannelOwner(store);
    const namespace = namespaceRecord();
    const client = await pool.connect();
    const transaction = new RepositoryTransactionLifetime();
    try {
      await client.query("BEGIN");
      const borrowed = borrowedContext(client, transaction, owner.installation.id);
      const repository = createPostgresNamespaceRepository(borrowed.context);
      const sibling = createPostgresNamespaceRepository(borrowed.context);
      assert.equal(borrowed.initializationReads, 0);
      assert.equal(await repository.findNamespace(namespace.id), undefined);
      await repository.listNamespaces();
      assert.equal(await repository.lockNamespace(namespace.id), undefined);
      for (const method of ["hasAgents", "hasConfigurations", "hasServiceAccounts", "hasSecrets"])
        assert.equal(await repository[method](namespace.id), false);
      assert.equal(
        borrowed.initializationReads,
        0,
        "reads, locks and presence checks do not resolve Installation",
      );
      assert.deepEqual(await repository.createNamespace(namespace), namespace);
      assert.equal(borrowed.initializationReads, 1);
      // A separate connection cannot observe uncommitted factory writes; another
      // repository on the owner's exact client can observe them immediately.
      assert.equal(
        (await pool.query("SELECT id FROM occ.namespaces WHERE id=$1", [namespace.id])).rowCount,
        0,
      );
      assert.deepEqual(await sibling.findNamespace(namespace.id), namespace);
      assert.equal(
        (await sibling.transitionNamespaceStatus(namespace.id, "provisioning", "deleting")).status,
        "deleting",
      );
      assert.equal(borrowed.initializationReads, 2);
      const tombstone = await repository.markNamespaceDeleted(
        namespace.id,
        new Date().toISOString(),
      );
      assert.equal(borrowed.initializationReads, 3);
      assert.deepEqual(
        await sibling.lockNamespace(namespace.id, { includeDeleted: true }),
        tombstone,
      );
      assert.ok(Object.isFrozen(tombstone));
      await transaction.finish();
      await assertNamespaceRepositoryClosed(repository, namespace);
      await assertNamespaceRepositoryClosed(sibling, namespace);
      // The borrowed repository lifetime does not commit or release its owner.
      assert.equal(
        (await client.query("SELECT id FROM occ.namespaces WHERE id=$1", [namespace.id])).rowCount,
        1,
      );
      await client.query("ROLLBACK");
      assert.equal(await store.read((s) => s.namespaces.findNamespace(namespace.id)), undefined);
      assert.equal(
        (await pool.query("SELECT id FROM occ.namespaces WHERE id=$1", [namespace.id])).rowCount,
        0,
      );
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

test("PostgreSQL Namespace list orders by creation time then ID", options, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  t.after(() => pool.end());
  const store = new PostgresPlatformState(pool);
  await seedChannelOwner(store);
  const later = namespaceRecord({ createdAt: "2025-02-02T00:00:00.000Z" });
  const [firstId, secondId] = [namespaceRecord().id, namespaceRecord().id].sort();
  const first = namespaceRecord({ id: firstId, createdAt: "2025-01-01T00:00:00.000Z" });
  const second = namespaceRecord({ id: secondId, createdAt: first.createdAt });
  await store.transact(async (s) => {
    for (const namespace of [later, second, first]) await s.namespaces.createNamespace(namespace);
  });
  const listed = await store.read((s) => s.namespaces.listNamespaces());
  assert.deepEqual(
    listed.filter((n) => [later.id, first.id, second.id].includes(n.id)),
    [first, second, later],
  );
  assert.ok(Object.isFrozen(listed));
  assert.ok(listed.every(Object.isFrozen));
});

test(
  "PostgreSQL Namespace lock orders concurrent child creation after empty deletion",
  options,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    const owner = await seedChannelOwner(store);
    const namespace = namespaceRecord({ status: "ready" });
    const { configuration } = namespaceChildren(namespace);
    await store.transact((s) => s.namespaces.createNamespace(namespace));
    const client = await pool.connect();
    const transaction = new RepositoryTransactionLifetime();
    let contender;
    let admitted;
    try {
      await client.query("BEGIN");
      const repository = createPostgresNamespaceRepository(
        borrowedContext(client, transaction, owner.installation.id).context,
      );
      assert.deepEqual(await repository.lockNamespace(namespace.id), namespace);
      for (const method of ["hasAgents", "hasConfigurations", "hasServiceAccounts", "hasSecrets"])
        assert.equal(await repository[method](namespace.id), false);
      const {
        rows: [{ pid }],
      } = await client.query("SELECT pg_backend_pid() AS pid");
      // The outward callback returns with child creation accepted. The owner's
      // real Namespace row lock keeps that operation pending inside its parent lock.
      contender = store.transact(async (s) => {
        admitted = Promise.allSettled([s.configurations.createConfiguration(configuration)]);
      });
      const deadline = Date.now() + 10000;
      let blocked = false;
      while (Date.now() < deadline) {
        const { rows } = await pool.query(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked",
          [pid],
        );
        if (rows[0].blocked) {
          blocked = true;
          break;
        }
        await delay(20);
      }
      assert.equal(blocked, true, "the actual child transaction must wait on the Namespace lock");
      await repository.transitionNamespaceStatus(namespace.id, "ready", "deleting");
      await transaction.finish();
      await client.query("COMMIT");
      await contender;
      const results = await admitted;
      assert.equal(results[0].status, "rejected");
      assert.ok(results[0].reason instanceof ScopeViolationError);
      await store.read(async (s) => {
        assert.equal((await s.namespaces.findNamespace(namespace.id)).status, "deleting");
        assert.equal(
          await s.configurations.findConfiguration(namespace.id, configuration.id),
          undefined,
        );
      });
      await store.transact(async (s) => {
        assert.equal(await s.namespaces.hasConfigurations(namespace.id), false);
        assert.ok(await s.namespaces.markNamespaceDeleted(namespace.id, new Date().toISOString()));
      });
    } finally {
      transaction.close();
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      if (contender) await contender;
    }
  },
);

for (const [name, verify] of [
  [
    "preserves empty lifecycle, tombstones, name reservation and external placement reuse",
    verifyNamespaceRepositoryLifecycle,
  ],
  [
    "observes actual Agents, Configurations, service accounts and Secrets",
    verifyNamespaceRepositoryChildren,
  ],
  [
    "drains cross-domain calls and closes all escaped Namespace methods",
    verifyNamespaceRepositoryLifetime,
  ],
  [
    "commits and rolls back Namespace, children, channel, audit and work together",
    verifyNamespaceRepositoryAtomicity,
  ],
])
  test(`PostgreSQL aggregate ${name}`, options, async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    t.after(() => pool.end());
    await verify(new PostgresPlatformState(pool));
  });

const bootstrapUrl = process.env.OCC_PRODUCTION_WIREUP_DATABASE_URL;
test(
  "PostgreSQL Namespace bootstrap uses the same unit and rolls back to an empty database",
  {
    skip: bootstrapUrl
      ? false
      : "Set OCC_PRODUCTION_WIREUP_DATABASE_URL to an independently migrated empty disposable database.",
    timeout: 60000,
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: bootstrapUrl, max: 2 });
    t.after(() => pool.end());
    // Unlike memory, the original PostgreSQL adapter requires Installation even
    // for a transition/tombstone targeting a missing row.
    const client = await pool.connect();
    const lifetime = new RepositoryTransactionLifetime();
    try {
      let scopeReads = 0;
      const repository = createPostgresNamespaceRepository({
        query: client,
        transaction: lifetime,
        get scope() {
          scopeReads++;
          throw new ScopeViolationError("Installation scope is unavailable before bootstrap.");
        },
        async requireInitialized() {
          const { rows } = await client.query("SELECT id FROM occ.installation");
          assert.equal(rows.length, 0, "the bootstrap database must be empty");
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        },
      });
      await assert.rejects(
        repository.transitionNamespaceStatus("absent", "provisioning", "ready"),
        ScopeViolationError,
      );
      await assert.rejects(
        repository.markNamespaceDeleted("absent", new Date().toISOString()),
        ScopeViolationError,
      );
      assert.equal(scopeReads, 0, "missing Installation is rejected before resolving scope");
    } finally {
      lifetime.close();
      client.release();
    }
    await verifyNamespaceRepositoryBootstrap(new PostgresPlatformState(pool));
  },
);
