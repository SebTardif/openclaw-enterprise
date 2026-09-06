import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createPostgresSecretRepository } from "../../packages/occ/src/state/postgres/secrets.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { configurationBindings } from "../conformance/configuration-repository.contract.mjs";
import {
  secretResources,
  seedSecretInstallation,
  secretRevision,
  secretRevisionWork,
  verifySecretBootstrap,
  secretStoreCases,
} from "../conformance/secret-repository.contract.mjs";

// This suite requires its own fresh database. It intentionally has no general
// or production-bootstrap selector fallback and never resets or drains work.
const databaseUrl = process.env.OCC_SECRET_REPOSITORY_TEST_DATABASE_URL;

test("PostgreSQL Secret construction does not access backend, helpers or scope", () => {
  const unexpected = () => assert.fail("Secret factory construction accessed its backend");
  const repository = createPostgresSecretRepository({
    transaction: { assertActive: unexpected },
    query: { query: unexpected },
    namespaces: { lockNamespace: unexpected },
    requireInitialized: unexpected,
    rows: unexpected,
    text: unexpected,
    timestamp: unexpected,
    get scope() {
      return unexpected();
    },
  });
  assert.deepEqual(Object.keys(repository).sort(), [
    "createSecret",
    "deleteSecret",
    "findSecret",
    "hasReferences",
    "lockSecret",
  ]);
});

test(
  "PostgreSQL Secret repository on a fresh dedicated database",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_SECRET_REPOSITORY_TEST_DATABASE_URL to a fresh migrated dedicated database.",
    timeout: 60000,
  },
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 250,
    });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    const {
      rows: [role],
    } = await pool.query(
      "SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    assert.deepEqual(role, {
      name: "occ_app",
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
    });
    const assertEmpty = async () => {
      assert.equal(
        await store.read((s) => s.installations.getInstallation()),
        undefined,
        "Secret repository database must start without an Installation; no automatic reset is permitted",
      );
      assert.equal(
        (await pool.query("SELECT count(*)::integer AS count FROM occ.controller_work")).rows[0]
          .count,
        0,
        "Secret repository database must start without controller work",
      );
    };
    await assertEmpty();
    // Explicit awaited sequencing is part of the isolation contract: bootstrap
    // rolls back before initialization, and all queue claims precede other work.
    let bootstrapVerified = false;
    await t.test("same-unit bootstrap rolls back to the empty dedicated database", async () => {
      await verifySecretBootstrap(store);
      await assertEmpty();
      bootstrapVerified = true;
    });
    assert.equal(
      bootstrapVerified,
      true,
      "failed bootstrap verification must halt before database initialization",
    );
    await seedSecretInstallation(store);
    let queueVerified = false;
    await t.test(
      "queued and claimed revision work blocks deletion until actual completion or failure",
      async () => {
        for (const terminal of ["succeeded", "failed_permanent"]) {
          const resources = secretResources();
          const { namespace, configuration, agent, secret } = resources;
          const revision = secretRevision(resources);
          const operation = secretRevisionWork(revision);
          const idempotencyKey = `agent_revision:${revision.id}:reconcile`;
          await store.transact(async (s) => {
            await s.namespaces.createNamespace(namespace);
            await s.secrets.createSecret(secret);
            await s.configurations.createConfiguration(configuration);
            await s.agents.createAgent(agent);
            await s.revisions.createRevision(revision);
            assert.equal(await s.secrets.hasReferences(namespace.id, secret.id), false);
            await s.operations.append(operation);
            assert.equal(await s.secrets.hasReferences(namespace.id, secret.id), true);
          });
          await assert.rejects(
            store.transact((s) => s.secrets.deleteSecret(namespace.id, secret.id)),
            { name: "ScopeViolationError" },
          );
          const claim = await store.transactWithQueue(async (s, queue) => {
            const claimed = await queue.claim();
            assert.equal(
              claimed?.idempotencyKey,
              idempotencyKey,
              "claim must select this suite's exact work; unexpected work is never drained",
            );
            assert.equal(claimed.state, "claimed");
            assert.equal(await s.secrets.hasReferences(namespace.id, secret.id), true);
            return claimed;
          });
          // The claim is committed, so a distinct transaction observes its reference.
          await assert.rejects(
            store.transact((s) => s.secrets.deleteSecret(namespace.id, secret.id)),
            { name: "ScopeViolationError" },
          );
          await store.transactWithQueue(async (s, queue) => {
            if (terminal === "succeeded") await queue.complete(claim);
            else await queue.fail(claim, { code: "SECRET_REPOSITORY_TEST_FAILURE" });
            assert.equal(await s.secrets.hasReferences(namespace.id, secret.id), false);
            assert.deepEqual(
              await s.revisions.findRevision(namespace.id, agent.id, revision.id),
              revision,
            );
            assert.equal(await s.secrets.deleteSecret(namespace.id, secret.id), true);
          });
          const {
            rows: [completed],
          } = await pool.query(
            "SELECT state, claim_token, lease_expires_at, completed_at FROM occ.controller_work WHERE idempotency_key=$1",
            [idempotencyKey],
          );
          assert.equal(completed.state, terminal);
          assert.equal(completed.claim_token, null);
          assert.equal(completed.lease_expires_at, null);
          assert.ok(completed.completed_at instanceof Date);
        }
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::integer AS count FROM occ.controller_work WHERE state IN ('queued','claimed')",
            )
          ).rows[0].count,
          0,
        );
        queueVerified = true;
      },
    );
    assert.equal(
      queueVerified,
      true,
      "failed queue verification must halt before other cases append work",
    );

    await t.test(
      "Secret and Configuration writes use one uncommitted transaction client",
      async () => {
        const { namespace, configuration, secret } = secretResources();
        const rollback = new Error("rollback same-client Secret writes");
        await assert.rejects(
          store.transact(async (s) => {
            await s.namespaces.createNamespace(namespace);
            await s.secrets.createSecret(secret);
            await s.configurations.createConfiguration({
              ...configuration,
              secretBindings: configurationBindings(secret),
            });
            assert.deepEqual(await s.secrets.lockSecret(namespace.id, secret.id), secret);
            assert.equal(await s.secrets.hasReferences(namespace.id, secret.id), true);
            for (const [table, id] of [
              ["namespaces", namespace.id],
              ["secrets", secret.id],
              ["configurations", configuration.id],
            ])
              assert.equal(
                (await pool.query(`SELECT id FROM occ.${table} WHERE id=$1`, [id])).rowCount,
                0,
              );
            throw rollback;
          }),
          (error) => error === rollback,
        );
        assert.equal(
          await store.read((s) => s.secrets.findSecret(namespace.id, secret.id)),
          undefined,
        );
      },
    );

    await t.test("lockSecret holds the real row while an independent deletion waits", async (t) => {
      const ownerPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      t.after(() => ownerPool.end());
      const ownerStore = new PostgresPlatformState(ownerPool);
      const { namespace, secret } = secretResources();
      await store.transact(async (s) => {
        await s.namespaces.createNamespace(namespace);
        await s.secrets.createSecret(secret);
      });
      const {
        rows: [{ pid }],
      } = await ownerPool.query("SELECT pg_backend_pid() AS pid");
      const locked = Promise.withResolvers();
      const release = Promise.withResolvers();
      let contender;
      const owner = ownerStore.transact(async (s) => {
        assert.deepEqual(await s.secrets.lockSecret(namespace.id, secret.id), secret);
        locked.resolve();
        await release.promise;
      });
      owner.catch((error) => locked.reject(error));
      try {
        await locked.promise;
        contender = store.transact((s) => s.secrets.deleteSecret(namespace.id, secret.id));
        contender.catch(() => {});
        let blocked = false;
        const deadline = Date.now() + 10000;
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
        assert.equal(blocked, true, "actual deletion must wait for lockSecret's row lock");
        release.resolve();
        await owner;
        assert.equal(await contender, true);
        assert.equal(
          await store.read((s) => s.secrets.findSecret(namespace.id, secret.id)),
          undefined,
        );
      } finally {
        release.resolve();
        await Promise.allSettled([owner, ...(contender ? [contender] : [])]);
      }
    });

    // These cases may retain their own pending revision work. No queue claim runs
    // after this point, and the dedicated database may finish with an Installation.
    for (const [name, verify] of secretStoreCases) await t.test(name, async () => verify(store));
  },
);
