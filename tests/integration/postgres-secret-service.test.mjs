import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { ResourceConflictError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { SecretService } from "../../packages/occ/src/services/secret/service.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const databaseUrl = process.env.OCC_SECRET_SERVICE_DATABASE_URL;
const id = (kind) => `${kind}_${randomUUID()}`;
const now = () => new Date().toISOString();

// Real PostgreSQL and actual services share their production transaction owner.
// Passive Secret storage proves compensation and ordering, not Kubernetes execution.
// This suite adds only uniquely owned resources and accepts an existing Installation.
test(
  "SecretService preserves PostgreSQL transaction, Namespace lock and binding boundaries",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_SECRET_SERVICE_DATABASE_URL to a migrated disposable PostgreSQL database.",
    timeout: 60_000,
  },
  async (t) => {
    const applicationName = `secret-service-${randomUUID()}`;
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      application_name: applicationName,
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
      id: id("ins"),
      name: "Secret service PostgreSQL",
      createdAt: now(),
    };
    const actor = `secret-service-actor-${randomUUID()}`;
    const iam = new NativeIAMDriver({
      loadNativeIAMState: async () => ({
        identities: [
          { kind: "principal", id: actor, issuer: "secret-service-test", subject: actor },
        ],
        groups: [],
        memberships: [],
        restrictions: [],
        roles: [
          {
            id: "secret-service-role",
            permissions: [
              ...["create", "read", "update", "delete", "operate"].map((action) => ({
                action,
                resourceKind: "secret",
              })),
              ...["create", "read", "delete"].map((action) => ({
                action,
                resourceKind: "configuration",
              })),
            ],
          },
        ],
        bindings: [
          {
            id: "secret-service-binding",
            subjectKind: "identity",
            subjectId: actor,
            roleId: "secret-service-role",
          },
        ],
      }),
    });
    const secretDriver = createTestSecretDriver();
    const configurationDriver = createTestConfigurationDriver();
    const controller = new OpenClawController(installation, { state, recordOperations: false });
    for (const driver of [iam, secretDriver, configurationDriver]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    assert.ok(controller.secret instanceof SecretService);
    const namespace = {
      id: id("ns"),
      name: `Secret service ${randomUUID()}`,
      status: "ready",
      createdAt: now(),
    };
    const foreign = { ...namespace, id: id("ns"), name: `Foreign Secret service ${randomUUID()}` };
    await controller.transact(async (unit) => {
      await unit.namespaces.createNamespace(namespace);
      await unit.namespaces.createNamespace(foreign);
    });
    const create = (name = `Token ${randomUUID()}`) =>
      controller.secret.createSecret(actor, {
        namespaceId: namespace.id,
        name,
        value: "synthetic-postgres-value",
      });
    const metadata = (secret) =>
      state.read((view) => view.secrets.findSecret(namespace.id, secret.id));
    const secret = await create();

    await t.test(
      "metadata remains exact and shared Configuration references block deletion",
      async () => {
        const stored = await metadata(secret);
        assert.equal(stored.driverId, secretDriver.id);
        assert.equal(stored.name, secret.name);
        assert.equal(Object.hasOwn(stored, "value"), false);
        assert.deepEqual(
          await controller.secret.readSecret(actor, namespace.id, secret.id),
          secret,
        );
        await assert.rejects(
          controller.secret.readSecret(actor, foreign.id, secret.id),
          ScopeViolationError,
        );
        const configuration = await controller.configuration.createConfiguration(actor, {
          namespaceId: namespace.id,
          kind: "agent",
          values: {},
          secretBindings: { APP_TOKEN: { source: secret.ref } },
        });
        await assert.rejects(
          controller.secret.deleteSecret(actor, namespace.id, secret.id),
          ResourceConflictError,
        );
        assert.equal(secretDriver.has(secret), true);
        await controller.configuration.deleteConfiguration(actor, namespace.id, configuration.id);
        assert.deepEqual(await metadata(secret), stored);
      },
    );

    await t.test(
      "known failed enclosing transaction rolls back metadata and audit and compensates creation",
      async () => {
        const audit = new AuditEventFactory();
        let rejected;
        let rejectedEvent;
        const failure = new Error("enclosing transaction failed");
        await assert.rejects(
          controller.transact(async (unit) => {
            rejected = await create();
            rejectedEvent = audit.create({
              installationId: installation.id,
              namespaceId: namespace.id,
              actorId: actor,
              action: "openclaw.secrets.create",
              resource: { kind: "secret", namespaceId: namespace.id, id: rejected.id },
            });
            await unit.audit.append(rejectedEvent);
            throw failure;
          }),
          (error) => error === failure,
        );
        assert.equal(await metadata(rejected), undefined);
        assert.equal(secretDriver.has(rejected), false);
        assert.equal(
          await state.read(async (view) =>
            (await view.audit.list()).some((event) => event.id === rejectedEvent.id),
          ),
          false,
        );
        assert.deepEqual(
          secretDriver.calls.slice(-2).map((call) => call.operation),
          ["create", "delete"],
        );
      },
    );

    await t.test(
      "the real Namespace row lock delays Driver mutation until the transaction is released",
      async () => {
        const client = await pool.connect();
        let pending;
        let released = false;
        const writesBefore = secretDriver.calls.filter(
          (call) => call.operation === "update",
        ).length;
        try {
          await client.query("BEGIN");
          const blocker = await client.query("SELECT pg_backend_pid() AS pid");
          await client.query("SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE", [
            namespace.id,
          ]);
          pending = controller.secret.updateSecret(actor, {
            namespaceId: namespace.id,
            secretId: secret.id,
            value: "synthetic-postgres-replacement",
          });
          // Observe PostgreSQL's actual lock wait; timing alone is not evidence of serialization.
          const deadline = Date.now() + 5_000;
          let blocked = false;
          while (Date.now() < deadline) {
            const waiting = await pool.query(
              "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND $2 = ANY(pg_blocking_pids(pid))",
              [applicationName, blocker.rows[0].pid],
            );
            if (waiting.rowCount > 0) {
              blocked = true;
              break;
            }
            await delay(20);
          }
          assert.equal(blocked, true, "Secret update must wait on the actual Namespace lock.");
          assert.equal(
            secretDriver.calls.filter((call) => call.operation === "update").length,
            writesBefore,
          );
          assert.equal(secretDriver.valueFor(secret), "synthetic-postgres-value");
          await client.query("COMMIT");
          released = true;
          assert.deepEqual(await pending, secret);
          assert.equal(secretDriver.valueFor(secret), "synthetic-postgres-replacement");
        } finally {
          if (!released) await client.query("ROLLBACK");
          client.release();
          if (pending) await pending.catch(() => {});
        }
      },
    );

    await controller.secret.deleteSecret(actor, namespace.id, secret.id);
    assert.equal(await metadata(secret), undefined);
    assert.equal(secretDriver.has(secret), false);
  },
);
