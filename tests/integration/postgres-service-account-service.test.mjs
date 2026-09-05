import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  OpenClawController,
  PostgresPlatformState,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { ServiceAccountService } from "../../packages/occ/src/services/service-account/service.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";

// This suite owns unique tenant resources in the selected migrated database and
// reuses its Installation. It neither resets shared state nor contacts a Provider.
const databaseUrl = process.env.OCC_SERVICE_ACCOUNT_SERVICE_DATABASE_URL;
const id = (kind) => `${kind}_${randomUUID()}`;
const credential = { kind: "api_key", secretRef: { name: "postgres-account", key: "token" } };

async function waitForAccountLock(pool, applicationName, blockerPid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      "SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name = $1 AND pid <> $2",
      [applicationName, blockerPid],
    );
    if (result.rows.some((row) => row.blockers.includes(blockerPid))) return;
    await delay(20);
  }
  assert.fail("The competing credential update never reached the PostgreSQL account lock.");
}

test(
  "ServiceAccountService preserves PostgreSQL scope, account locks and owner rollback",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_SERVICE_ACCOUNT_SERVICE_DATABASE_URL to a migrated disposable PostgreSQL database.",
    timeout: 60_000,
  },
  async (t) => {
    const applicationName = `service-account-service-${randomUUID()}`;
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      application_name: applicationName,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      query_timeout: 12_000,
      max: 8,
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
      id: id("ins"),
      name: "ServiceAccount PostgreSQL",
      createdAt: new Date().toISOString(),
    };
    const actor = id("principal");
    const iam = new NativeIAMDriver({
      loadNativeIAMState: async () => ({
        identities: [
          { kind: "principal", id: actor, issuer: "postgres-service-account", subject: actor },
        ],
        groups: [],
        memberships: [],
        restrictions: [],
        roles: [
          {
            id: "service-account-postgres-role",
            permissions: Object.entries({
              namespace: ["create", "read"],
              service_account: ["create", "read", "update", "delete"],
              configuration: ["create", "read"],
              agent: ["create", "read"],
            }).flatMap(([resourceKind, actions]) =>
              actions.map((action) => ({ action, resourceKind })),
            ),
          },
        ],
        bindings: [
          {
            id: "service-account-postgres-binding",
            subjectKind: "identity",
            subjectId: actor,
            roleId: "service-account-postgres-role",
          },
        ],
      }),
    });
    const controller = new OpenClawController(installation, { state, recordOperations: false });
    for (const driver of [iam, createTestConfigurationDriver()]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    assert.ok(controller.serviceAccount instanceof ServiceAccountService);
    const service = controller.serviceAccount;
    const namespace = await controller.createNamespace(actor, {
      name: `service-account-${randomUUID()}`,
    });
    const foreign = await controller.createNamespace(actor, {
      name: `service-account-foreign-${randomUUID()}`,
    });
    const create = (name) =>
      service.createServiceAccount(actor, { namespaceId: namespace.id, name });

    await t.test("manual credentials persist only in the exact Namespace", async () => {
      const account = await create("manual");
      const updated = await service.updateServiceAccountCredential(
        actor,
        namespace.id,
        account.id,
        credential,
      );
      assert.deepEqual(updated.credential, credential);
      assert.deepEqual(await service.getServiceAccount(actor, namespace.id, account.id), updated);
      for (const operation of [
        () => service.getServiceAccount(actor, foreign.id, account.id),
        () => service.updateServiceAccountCredential(actor, foreign.id, account.id, credential),
        () => service.deleteServiceAccount(actor, foreign.id, account.id),
      ])
        await assert.rejects(operation, ScopeViolationError);
      await service.deleteServiceAccount(actor, namespace.id, account.id);
      await assert.rejects(
        service.getServiceAccount(actor, namespace.id, account.id),
        ScopeViolationError,
      );
    });

    await t.test("credential mutation waits on the real account row lock", async () => {
      const account = await create("locked");
      const client = await pool.connect();
      let pending;
      try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
        await client.query(
          "SELECT id FROM occ.service_accounts WHERE namespace_id = $1 AND id = $2 FOR UPDATE",
          [namespace.id, account.id],
        );
        pending = service.updateServiceAccountCredential(
          actor,
          namespace.id,
          account.id,
          credential,
        );
        // Observe the database lock, rather than infer serialization from elapsed time.
        await waitForAccountLock(pool, applicationName, rows[0].pid);
        await client.query("COMMIT");
        assert.deepEqual((await pending).credential, credential);
      } finally {
        await client.query("ROLLBACK");
        client.release();
        if (pending) await pending.catch(() => {});
      }
      await service.deleteServiceAccount(actor, namespace.id, account.id);
    });

    await t.test(
      "outer mutation failure restores persisted credential and account state",
      async () => {
        const account = await create("retained");
        let aborted;
        await assert.rejects(
          controller.transact(async () => {
            await service.updateServiceAccountCredential(
              actor,
              namespace.id,
              account.id,
              credential,
            );
            aborted = await create("aborted");
            throw new Error("Required outer mutation failed.");
          }),
          /Required outer mutation failed/,
        );
        assert.deepEqual(await service.getServiceAccount(actor, namespace.id, account.id), account);
        await assert.rejects(
          service.getServiceAccount(actor, namespace.id, aborted.id),
          ScopeViolationError,
        );
        await service.deleteServiceAccount(actor, namespace.id, account.id);
      },
    );

    await t.test("an actual Agent assignment blocks ServiceAccount deletion", async () => {
      const account = await create("assigned");
      const configuration = await controller.createConfiguration(actor, {
        namespaceId: namespace.id,
        kind: "agent",
        values: {},
      });
      const agent = await controller.createAgent(actor, {
        namespaceId: namespace.id,
        name: "account-consumer",
        configurationId: configuration.id,
        serviceAccountId: account.id,
      });
      assert.equal(agent.serviceAccountId, account.id);
      await assert.rejects(
        service.deleteServiceAccount(actor, namespace.id, account.id),
        ResourceConflictError,
      );
      assert.deepEqual(await service.getServiceAccount(actor, namespace.id, account.id), account);
    });
  },
);
