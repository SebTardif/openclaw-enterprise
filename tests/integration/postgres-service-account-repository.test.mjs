import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createPostgresServiceAccountRepository } from "../../packages/occ/src/state/postgres/service-accounts.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import {
  accountCredential,
  serviceAccountResources,
  seedServiceAccountInstallation,
  assertServiceAccountClosed,
  verifyServiceAccountBootstrap,
  serviceAccountStoreCases,
} from "../conformance/service-account-repository.contract.mjs";

// Run first on its explicitly allocated fresh database. There is no fallback,
// reset, queue draining or claim; later regression files reuse its Installation.
const databaseUrl = process.env.OCC_SERVICE_ACCOUNT_REPOSITORY_TEST_DATABASE_URL;
test("PostgreSQL ServiceAccount factory construction does not access backend or scope", () => {
  const unexpected = () => assert.fail("constructor accessed an owner capability");
  const repository = createPostgresServiceAccountRepository({
    transaction: { assertActive: unexpected },
    query: { query: unexpected },
    namespaces: { lockNamespace: unexpected },
    requireInitialized: unexpected,
    rows: unexpected,
    text: unexpected,
    findServiceAccountProviderBinding: unexpected,
    get scope() {
      return unexpected();
    },
  });
  assert.deepEqual(Object.keys(repository).sort(), [
    "createServiceAccount",
    "deleteServiceAccount",
    "findServiceAccount",
    "findServiceAccountProviderBinding",
    "listServiceAccounts",
    "lockServiceAccount",
    "updateCredential",
  ]);
});

test(
  "PostgreSQL ServiceAccount repository on one fresh owned database",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_SERVICE_ACCOUNT_REPOSITORY_TEST_DATABASE_URL to a fresh migrated database.",
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
    const assertEmpty = async () => {
      assert.equal(
        await store.read((s) => s.installations.getInstallation()),
        undefined,
        "fresh repository database must not contain Installation",
      );
      assert.equal(
        (await pool.query("SELECT count(*)::integer AS count FROM occ.controller_work")).rows[0]
          .count,
        0,
        "fresh repository database must not contain work",
      );
    };
    await assertEmpty();
    let bootstrapped = false;
    await t.test("same-unit account bootstrap rolls back all new ownership", async () => {
      await verifyServiceAccountBootstrap(store);
      await assertEmpty();
      bootstrapped = true;
    });
    assert.equal(bootstrapped, true, "halt if the fresh bootstrap prerequisite failed");
    await seedServiceAccountInstallation(store);

    await t.test("account and Agent creation borrow one uncommitted client", async () => {
      const r = serviceAccountResources();
      const rollback = new Error("uncommitted account rollback");
      await assert.rejects(
        store.transact(async (s) => {
          await s.namespaces.createNamespace(r.namespace);
          await s.serviceAccounts.createServiceAccount(r.account);
          await s.configurations.createConfiguration(r.configuration);
          await s.agents.createAgent(r.agent);
          assert.deepEqual(
            await s.serviceAccounts.lockServiceAccount(r.namespace.id, r.account.id),
            r.account,
          );
          // Independent pool checkout cannot observe any of the owner client's writes.
          for (const [table, id] of [
            ["namespaces", r.namespace.id],
            ["service_accounts", r.account.id],
            ["configurations", r.configuration.id],
            ["agents", r.agent.id],
          ])
            assert.equal(
              (
                await pool.query(
                  `SELECT count(*)::integer AS count FROM occ.${table} WHERE id=$1`,
                  [id],
                )
              ).rows[0].count,
              0,
            );
          throw rollback;
        }),
        (error) => error === rollback,
      );
      assert.equal(
        await store.read((s) => s.serviceAccounts.findServiceAccount(r.namespace.id, r.account.id)),
        undefined,
      );
    });

    await t.test(
      "lockServiceAccount blocks an identified competing credential writer",
      async () => {
        const r = serviceAccountResources();
        await store.transact(async (s) => {
          await s.namespaces.createNamespace(r.namespace);
          await s.serviceAccounts.createServiceAccount(r.account);
        });
        const ownerName = `account-owner-${randomUUID()}`;
        const writerName = `account-writer-${randomUUID()}`;
        const ownerPool = new pg.Pool({
          connectionString: databaseUrl,
          max: 1,
          application_name: ownerName,
          connectionTimeoutMillis: 250,
        });
        const writerPool = new pg.Pool({
          connectionString: databaseUrl,
          max: 1,
          application_name: writerName,
          connectionTimeoutMillis: 250,
        });
        const ready = Promise.withResolvers();
        const release = Promise.withResolvers();
        const owner = new PostgresPlatformState(ownerPool);
        const contender = new PostgresPlatformState(writerPool);
        let update;
        const held = owner.transact(async (s) => {
          await s.serviceAccounts.lockServiceAccount(r.namespace.id, r.account.id);
          ready.resolve();
          await release.promise;
        });
        held.catch(ready.reject);
        try {
          await ready.promise;
          update = contender.transact((s) =>
            s.serviceAccounts.updateCredential(
              r.namespace.id,
              r.account.id,
              accountCredential("access_token"),
            ),
          );
          const deadline = Date.now() + 5000;
          let blocked = false;
          while (Date.now() < deadline) {
            const observed = await pool.query(
              "SELECT w.pid FROM pg_stat_activity w JOIN pg_stat_activity o ON o.application_name=$1 WHERE w.application_name=$2 AND o.pid=ANY(pg_blocking_pids(w.pid))",
              [ownerName, writerName],
            );
            if (observed.rows.length === 1) {
              blocked = true;
              break;
            }
            await delay(20);
          }
          assert.equal(
            blocked,
            true,
            "observe exact named owner and contender instead of timing alone",
          );
          release.resolve();
          await held;
          assert.deepEqual((await update).credential, accountCredential("access_token"));
        } finally {
          release.resolve();
          await Promise.allSettled([held, ...(update ? [update] : [])]);
          await ownerPool.end();
          await writerPool.end();
        }
      },
    );

    await t.test(
      "retained central binding projection uses the same account transaction",
      async () => {
        const r = serviceAccountResources();
        delete r.account.credential;
        await store.transact(async (s) => {
          await s.namespaces.createNamespace(r.namespace);
          await s.serviceAccounts.createServiceAccount(r.account);
          const found = await s.serviceAccounts.findServiceAccount(r.namespace.id, r.account.id);
          assert.deepEqual(found, r.account);
          assert.equal(Object.hasOwn(found, "credential"), false);
        });
        const key = {
          namespaceId: r.namespace.id,
          serviceAccountId: r.account.id,
          providerId: "provider-fixture",
          driverId: "driver-fixture",
          workspaceId: "workspace-fixture",
        };
        const expected = {
          providerId: key.providerId,
          driverId: key.driverId,
          workspaceId: key.workspaceId,
          credentialIssued: false,
        };
        const rollback = new Error("binding projection rollback");
        let retained;
        await assert.rejects(
          store.transact(async (s) => {
            // The private link collaborator borrows the initialized owner scope.
            assert.ok(await s.installations.getInstallation());
            retained = s.serviceAccounts;
            await retained.lockServiceAccount(r.namespace.id, r.account.id);
            // The unchanged scoped collaborator supplies opaque fixture metadata only.
            // This checks the existing read projection, not provider effects or policy.
            const links = store.providerAccountLinksInTransaction(s);
            await links.create(key, "external-account-fixture");
            assert.deepEqual(
              await retained.findServiceAccountProviderBinding(r.namespace.id, r.account.id),
              expected,
            );
            assert.equal(
              await retained.findServiceAccountProviderBinding(`ns_${randomUUID()}`, r.account.id),
              undefined,
            );
            assert.equal((await links.find(key)).externalCredentialId, null);
            await links.recordCredential(key, "external-credential-fixture");
            assert.deepEqual(
              await retained.updateCredential(
                r.namespace.id,
                r.account.id,
                accountCredential("access_token"),
              ),
              { ...r.account, credential: accountCredential("access_token") },
            );
            const issued = await retained.findServiceAccountProviderBinding(
              r.namespace.id,
              r.account.id,
            );
            assert.deepEqual(issued, { ...expected, credentialIssued: true });
            assert.ok(Object.isFrozen(issued));
            assert.deepEqual(Object.keys(issued).sort(), [
              "credentialIssued",
              "driverId",
              "providerId",
              "workspaceId",
            ]);
            throw rollback;
          }),
          (error) => error === rollback,
        );
        assert.equal(
          await store.read((s) =>
            s.serviceAccounts.findServiceAccountProviderBinding(r.namespace.id, r.account.id),
          ),
          undefined,
        );
        assert.deepEqual(
          await store.read((s) =>
            s.serviceAccounts.findServiceAccount(r.namespace.id, r.account.id),
          ),
          r.account,
        );
        await assertServiceAccountClosed(retained, r.account);
        await store.transact(async (s) => {
          assert.ok(await s.installations.getInstallation());
          await s.serviceAccounts.lockServiceAccount(r.namespace.id, r.account.id);
          const links = store.providerAccountLinksInTransaction(s);
          await links.create(key, "external-account-fixture");
          assert.ok(await links.find(key));
          assert.deepEqual(
            await s.serviceAccounts.findServiceAccountProviderBinding(r.namespace.id, r.account.id),
            expected,
          );
        });
        await store.transact(async (s) => {
          assert.ok(await s.installations.getInstallation());
          await s.serviceAccounts.lockServiceAccount(r.namespace.id, r.account.id);
          const links = store.providerAccountLinksInTransaction(s);
          assert.equal(
            await s.serviceAccounts.deleteServiceAccount(r.namespace.id, r.account.id),
            true,
          );
          assert.equal(await links.find(key), undefined);
          assert.equal(
            await s.serviceAccounts.findServiceAccountProviderBinding(r.namespace.id, r.account.id),
            undefined,
          );
        });
        assert.equal(
          await store.read((s) =>
            s.serviceAccounts.findServiceAccount(r.namespace.id, r.account.id),
          ),
          undefined,
        );
      },
    );

    await t.test("existing PostgreSQL C-collated names retain byte ordering", async () => {
      const r = serviceAccountResources();
      const records = ["é", "z", "a", "e\u0301"].map((name) => ({
        ...r.account,
        id: `sa_${randomUUID()}`,
        name,
      }));
      await store.transact(async (s) => {
        await s.namespaces.createNamespace(r.namespace);
        for (const record of records) await s.serviceAccounts.createServiceAccount(record);
      });
      assert.deepEqual(
        await store.read((s) => s.serviceAccounts.listServiceAccounts(r.namespace.id)),
        [...records].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))),
      );
    });
    for (const [name, verify] of serviceAccountStoreCases)
      await t.test(name, () => verify(store, { backend: "postgres" }));
  },
);
