import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/errors.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { initializeServiceAccountDriver } from "../../apps/controller/src/composition/driver-factories/service-account.ts";
import { createChatGPTServiceAccountDriverFactory } from "../../apps/controller/src/drivers/service-account/chatgpt.ts";

const databaseUrl = process.env.OCC_PROVIDER_ACCOUNT_LINKS_DATABASE_URL;
const identifier = (kind) => `${kind}_${randomUUID()}`;

// The database, transaction owner and ChatGPT Driver are real. Passive external
// account/credential storage below records effects; it proves no provider HTTP,
// credential issuer, Kubernetes or model-runtime behavior.
test(
  "ProviderAccountLinks retains PostgreSQL scope, transactions, constraints and Driver compensation",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_PROVIDER_ACCOUNT_LINKS_DATABASE_URL to a dedicated migrated PostgreSQL database.",
    timeout: 60_000,
  },
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      application_name: "provider-account-links-test",
      max: 8,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      query_timeout: 12_000,
    });
    t.after(() => pool.end());
    const role = await pool.query(
      "SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    assert.deepEqual(role.rows[0], {
      name: "occ_app",
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
    });
    const state = new PostgresPlatformState(pool);
    const installation = (await state.loadInstallation()) ?? {
      id: identifier("ins"),
      name: "Provider account links PostgreSQL",
      createdAt: new Date().toISOString(),
    };
    const externalAccounts = new Set();
    const externalCredentials = new Set();
    const credentialStorage = new Map();
    const effects = [];
    const provider = {
      id: identifier("provider"),
      type: "chatgpt",
      configuration: {
        workspaceId: randomUUID(),
        apiKeyPath: "/unused-provider-links-fixture-admin-key",
        credentialTtlSeconds: 3600,
      },
      drivers: { service_account: identifier("driver") },
    };
    const client = {
      workspaceId: provider.configuration.workspaceId,
      async createServiceAccount() {
        const id = identifier("external-account");
        externalAccounts.add(id);
        effects.push("create-account");
        return { id };
      },
      async deleteServiceAccount(id) {
        assert.equal(externalAccounts.delete(id), true);
        effects.push("delete-account");
      },
      async createCredential({ accountId }) {
        assert.equal(externalAccounts.has(accountId), true);
        const id = identifier("external-credential");
        externalCredentials.add(id);
        effects.push("create-credential");
        return { id, accessToken: "provider-links-test-credential-canary" };
      },
      async deleteCredential({ credentialId }) {
        assert.equal(externalCredentials.delete(credentialId), true);
        effects.push("delete-credential");
      },
    };
    const compute = {
      async storeServiceAccountCredential({ serviceAccountId, accessToken }) {
        assert.equal(accessToken, "provider-links-test-credential-canary");
        const ref = {
          name: `service-${serviceAccountId.replaceAll("_", "-")}`,
          key: "access-token",
        };
        credentialStorage.set(serviceAccountId, ref);
        effects.push("store-credential");
        return ref;
      },
      async deleteServiceAccountCredential({ serviceAccountId, secretRef }) {
        assert.deepEqual(credentialStorage.get(serviceAccountId), secretRef);
        credentialStorage.delete(serviceAccountId);
        effects.push("delete-stored-credential");
      },
    };
    const controller = new OpenClawController(installation, { state, providers: [provider] });
    initializeServiceAccountDriver(
      createChatGPTServiceAccountDriverFactory({ ...provider, client }, compute),
      controller,
      state,
    );
    const driver = controller.selectedDriver("service_account");
    const namespace = {
      id: identifier("ns"),
      name: `Provider links ${randomUUID()}`,
      status: "provisioning",
      createdAt: new Date().toISOString(),
    };
    const otherNamespace = { ...namespace, id: identifier("ns"), name: `Other ${randomUUID()}` };
    await controller.transact(async (unit) => {
      await unit.namespaces.createNamespace(namespace);
      await unit.namespaces.createNamespace(otherNamespace);
    });
    const account = () => ({
      id: identifier("sa"),
      namespaceId: namespace.id,
      name: `Provider account ${randomUUID()}`,
    });
    const key = (value) => ({
      namespaceId: value.namespaceId,
      serviceAccountId: value.id,
      providerId: provider.id,
      driverId: driver.id,
      workspaceId: client.workspaceId,
    });
    const linksIn = (unit) => state.providerAccountLinksInTransaction(unit);
    const find = (value) => controller.transact((unit) => linksIn(unit).find(key(value)));

    await t.test(
      "opaque links preserve exact Provider, Driver, workspace and Namespace ownership",
      async () => {
        const value = account();
        await controller.transact(async (unit) => {
          await unit.serviceAccounts.createServiceAccount(value);
          await driver.create(value);
        });
        const linked = await find(value);
        assert.equal(Object.isFrozen(linked), true);
        assert.equal(externalAccounts.has(linked.externalAccountId), true);
        assert.equal(linked.externalCredentialId, null);
        assert.deepEqual(Object.keys(linked).sort(), [
          "driverId",
          "externalAccountId",
          "externalCredentialId",
          "providerId",
          "workspaceId",
        ]);
        assert.equal(JSON.stringify(linked).includes("credential-canary"), false);
        for (const [field, message] of [
          ["providerId", "The service-account Provider does not match."],
          ["driverId", "The service-account provider Driver does not match."],
          ["workspaceId", "The service-account provider workspace does not match."],
        ]) {
          await assert.rejects(
            controller.transact((unit) =>
              linksIn(unit).find({ ...key(value), [field]: "foreign" }),
            ),
            { name: "DependencyUnavailableError", message },
          );
        }
        assert.equal(
          await controller.transact((unit) =>
            linksIn(unit).find({ ...key(value), namespaceId: otherNamespace.id }),
          ),
          undefined,
        );
        await controller.transact(async (unit) => {
          const locked = await unit.serviceAccounts.lockServiceAccount(namespace.id, value.id);
          const credential = await driver.createCredential(locked);
          await unit.serviceAccounts.updateCredential(namespace.id, value.id, credential);
        });
        const credentialLink = await find(value);
        assert.equal(JSON.stringify(credentialLink).includes("credential-canary"), false);
        assert.deepEqual(Object.keys(credentialLink).sort(), Object.keys(linked).sort());
        assert.equal(externalCredentials.has(credentialLink.externalCredentialId), true);
        await assert.rejects(
          controller.transact(async (unit) => {
            const locked = await unit.serviceAccounts.lockServiceAccount(namespace.id, value.id);
            await driver.createCredential(locked);
          }),
          ResourceConflictError,
        );
        // Driver cleanup still precedes account deletion; the existing database FK
        // removes the link. No new unlink lifecycle is needed at this boundary.
        await controller.transact(async (unit) => {
          const locked = await unit.serviceAccounts.lockServiceAccount(namespace.id, value.id);
          await driver.delete(locked);
          assert.equal(
            await unit.serviceAccounts.deleteServiceAccount(namespace.id, value.id),
            true,
          );
        });
        assert.equal(await find(value), undefined);
        assert.equal(externalAccounts.has(linked.externalAccountId), false);
        assert.equal(externalCredentials.has(credentialLink.externalCredentialId), false);
        assert.equal(credentialStorage.has(value.id), false);
      },
    );

    await t.test(
      "database constraints reject foreign account ownership and duplicate external accounts",
      async () => {
        const first = account();
        const second = account();
        const externalAccountId = identifier("external");
        await controller.transact(async (unit) => {
          await unit.serviceAccounts.createServiceAccount(first);
          await unit.serviceAccounts.createServiceAccount(second);
          await linksIn(unit).create(key(first), externalAccountId);
        });
        await assert.rejects(
          controller.transact((unit) => linksIn(unit).create(key(second), externalAccountId)),
          ResourceConflictError,
        );
        assert.equal(await find(second), undefined);
        await assert.rejects(
          controller.transact((unit) =>
            linksIn(unit).create(
              { ...key(second), namespaceId: otherNamespace.id },
              identifier("external"),
            ),
          ),
          ScopeViolationError,
        );
        assert.equal(await find(second), undefined);
        await assert.rejects(
          controller.transact((unit) =>
            linksIn(unit).recordCredential(key(second), identifier("credential")),
          ),
          {
            name: "DependencyUnavailableError",
            message: "The exact service-account Driver binding is missing.",
          },
        );
      },
    );

    await t.test(
      "known transaction failure rolls back the link and compensates external account creation",
      async () => {
        const value = account();
        const before = new Set(externalAccounts);
        const rollback = new Error("known transaction failure");
        await assert.rejects(
          controller.transact(async (unit) => {
            await unit.serviceAccounts.createServiceAccount(value);
            await driver.create(value);
            assert.notEqual(await linksIn(unit).find(key(value)), undefined);
            throw rollback;
          }),
          (error) => error === rollback,
        );
        assert.deepEqual(externalAccounts, before);
        assert.equal(await find(value), undefined);
        assert.equal(
          await controller.transact((unit) =>
            unit.serviceAccounts.findServiceAccount(namespace.id, value.id),
          ),
          undefined,
        );
      },
    );

    await t.test(
      "credential effects compensate in reverse order while committed account link survives",
      async () => {
        const value = account();
        await controller.transact(async (unit) => {
          await unit.serviceAccounts.createServiceAccount(value);
          await driver.create(value);
        });
        const before = await find(value);
        const start = effects.length;
        await assert.rejects(
          controller.transact(async (unit) => {
            const locked = await unit.serviceAccounts.lockServiceAccount(namespace.id, value.id);
            const credential = await driver.createCredential(locked);
            await unit.serviceAccounts.updateCredential(namespace.id, value.id, credential);
            throw new Error("credential transaction failure");
          }),
          /credential transaction failure/,
        );
        assert.deepEqual(effects.slice(start), [
          "create-credential",
          "store-credential",
          "delete-stored-credential",
          "delete-credential",
        ]);
        assert.deepEqual(await find(value), before);
        assert.equal(credentialStorage.has(value.id), false);
        assert.equal(
          (
            await controller.transact((unit) =>
              unit.serviceAccounts.findServiceAccount(namespace.id, value.id),
            )
          ).credential,
          undefined,
        );
      },
    );

    await t.test(
      "accepted adapter operations drain before commit and closed admissions reject late calls",
      async () => {
        const value = account();
        const externalCredentialId = identifier("credential");
        await controller.transact(async (unit) => {
          await unit.serviceAccounts.createServiceAccount(value);
          await linksIn(unit).create(key(value), identifier("external"));
        });
        const blocker = await pool.connect();
        let committed = false;
        let pending;
        let transaction;
        try {
          await blocker.query("BEGIN");
          const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          await blocker.query(
            "SELECT service_account_id FROM occ.service_account_driver_bindings WHERE service_account_id = $1 FOR UPDATE",
            [value.id],
          );
          let retained;
          transaction = controller.transact(async (unit) => {
            await unit.serviceAccounts.lockServiceAccount(namespace.id, value.id);
            retained = linksIn(unit);
            await retained.find(key(value));
            // Deliberately leave this accepted repository call unawaited. The actual
            // transaction lifetime must retain it after the owner callback returns.
            pending = retained.recordCredential(key(value), externalCredentialId);
            void pending.catch(() => {});
          });
          void transaction.then(
            () => {
              committed = true;
            },
            () => {},
          );
          const deadline = Date.now() + 5_000;
          let blocked = false;
          while (Date.now() < deadline) {
            const result = await pool.query(
              "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
              [blockerPid],
            );
            if (result.rows.length !== 0) {
              blocked = true;
              break;
            }
            await delay(20);
          }
          assert.equal(
            blocked,
            true,
            "The real binding UPDATE must wait on the separate PostgreSQL transaction.",
          );
          assert.equal(committed, false);
          await assert.rejects(retained.find(key(value)), ScopeViolationError);
          await blocker.query("COMMIT");
          await pending;
          await transaction;
          assert.equal((await find(value)).externalCredentialId, externalCredentialId);
        } finally {
          await blocker.query("ROLLBACK").catch(() => {});
          blocker.release();
          await Promise.allSettled([pending, transaction]);
        }
      },
    );

    await t.test(
      "borrowed adapter handles reject after transaction close and reject another store's unit",
      async () => {
        const value = account();
        const retained = await controller.transact((unit) => linksIn(unit));
        await assert.rejects(retained.find(key(value)), ScopeViolationError);
        await assert.rejects(
          retained.create(key(value), identifier("external")),
          ScopeViolationError,
        );
        await assert.rejects(
          retained.recordCredential(key(value), identifier("credential")),
          ScopeViolationError,
        );
        const otherStore = new PostgresPlatformState(pool);
        await controller.transact(async (unit) => {
          assert.throws(
            () => otherStore.providerAccountLinksInTransaction(unit),
            DependencyUnavailableError,
          );
        });
      },
    );
  },
);
