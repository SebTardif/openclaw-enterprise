import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { ExactAuthorization } from "../../packages/occ/src/application/authorization.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { MutationRunner } from "../../packages/occ/src/application/mutation-runner.ts";
import { ResourceConflictError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { CONFIGURATION_REPOSITORIES } from "../../packages/occ/src/services/configuration/port.ts";
import { ConfigurationService } from "../../packages/occ/src/services/configuration/service.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  createAuthenticatedControllerRequest,
  createTestAuthPrincipal,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

// Run first against an explicitly selected fresh database: the initial case proves
// construction and rejected operations do not eagerly persist an Installation.
// PostgreSQL, Native IAM, the service and Fastify are real; the existing passive
// Configuration storage fixture does not establish live Kubernetes Driver proof.
const databaseUrl = process.env.OCC_CONFIGURATION_SERVICE_DATABASE_URL;
const identifier = (kind) => `${kind}_${randomUUID()}`;
const timestamp = () => new Date().toISOString();

function namespace() {
  return {
    id: identifier("ns"),
    name: `Configuration service ${randomUUID()}`,
    status: "ready",
    createdAt: timestamp(),
  };
}

function binding(secret) {
  return {
    OPENAI_API_KEY: {
      source: { kind: "secret", namespaceId: secret.namespaceId, id: secret.id },
      delivery: { type: "env" },
    },
  };
}

function document(model) {
  return {
    models: {
      providers: {
        openai: {
          apiKey: { source: "store", provider: "team", id: "OPENAI_API_KEY" },
          models: [{ id: model, name: model }],
        },
      },
    },
    plugins: { entries: { knowledge: { config: { thresholds: [0, 1.25, null] } } } },
  };
}

function serviceFor(runner, drivers) {
  return new ConfigurationService({
    repositories: runner.forRepositories(CONFIGURATION_REPOSITORIES),
    authorization: new ExactAuthorization(() => drivers.selectedDriver("iam")),
    configurationDriver: () => drivers.configurationDriver(),
    assertSecretDriverOwner: (id) => {
      drivers.secretDriver(id);
    },
    createId: () => identifier("cfg"),
    now: timestamp,
  });
}

async function waitForBlockedClient(pool, applicationName, blockerPid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
       WHERE application_name = $1 AND pid <> $2`,
      [applicationName, blockerPid],
    );
    const blocked = result.rows.find((row) => row.blockers.includes(blockerPid));
    if (blocked !== undefined) return blocked.pid;
    await delay(20);
  }
  assert.fail("The competing service update never reached the actual PostgreSQL lock wait.");
}

test(
  "ConfigurationService and Fastify preserve PostgreSQL ownership, generations and audit atomicity",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_CONFIGURATION_SERVICE_DATABASE_URL to a fresh migrated disposable PostgreSQL database.",
    timeout: 90_000,
  },
  async (t) => {
    const applicationName = `configuration-service-${randomUUID()}`;
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
    assert.equal(
      await state.loadInstallation(),
      undefined,
      "Select a fresh database; this suite must not replace an existing Installation.",
    );
    const installation = {
      id: identifier("ins"),
      name: "Configuration service PostgreSQL",
      createdAt: timestamp(),
    };
    const auth = await createTestAuthPrincipal({ installationId: installation.id });
    const actor = auth.seed.principal.id;
    // The supported bootstrap seed supplies the pre-Installation authority and
    // is persisted by the same transaction that first creates the Installation.
    state.setBootstrapNativeIAM({
      identities: [auth.seed.principal],
      groups: [],
      memberships: [],
      roles: auth.seed.roles,
      bindings: auth.seed.bindings,
      restrictions: [],
    });
    const iam = new NativeIAMDriver(state);
    const configurationStorage = createTestConfigurationDriver();
    const configurationWrites = [];
    const configurationDriver = {
      ...configurationStorage,
      // Observe calls to the existing passive storage fixture without changing
      // its results or any service, repository, authorization or audit method.
      async update(configuration) {
        configurationWrites.push(structuredClone(configuration));
        return configurationStorage.update(configuration);
      },
    };
    const writesFor = (configuration) =>
      configurationWrites.filter((write) => write.id === configuration.id);
    const secretDriver = createTestSecretDriver();
    const drivers = new DriverSelection();
    for (const driver of [iam, configurationDriver, secretDriver]) {
      drivers.registerDriver(driver);
      drivers.selectDriver(driver.capability, driver.id);
    }
    const runner = new MutationRunner(installation, state);
    const service = serviceFor(runner, drivers);
    const audits = new AuditEventFactory();
    const auditFor = (configuration, action) =>
      audits.create({
        installationId: installation.id,
        namespaceId: configuration.namespaceId,
        actorId: actor,
        action: `openclaw.configurations.${action}`,
        resource: {
          kind: "configuration",
          id: configuration.id,
          namespaceId: configuration.namespaceId,
        },
      });
    const metadata = (configuration) =>
      state.read((view) =>
        view.configurations.findConfiguration(configuration.namespaceId, configuration.id),
      );
    const auditEvents = (configuration) =>
      state.read(async (view) =>
        (await view.audit.list()).filter((event) => event.resource.id === configuration.id),
      );
    const create = (namespaceId, options = {}) =>
      service.createConfiguration(actor, {
        namespaceId,
        kind: "agent",
        values: document("initial"),
        ...options,
      });

    await t.test(
      "an absent Installation stays absent until a successful owning mutation",
      async () => {
        assert.equal(await state.loadInstallation(), undefined);
        await assert.rejects(
          service.getConfiguration(actor, identifier("ns"), identifier("cfg")),
          ScopeViolationError,
        );
        // The runner may stage its lazy Installation, but a missing Namespace rolls
        // the complete mutation back before any Configuration can be admitted.
        await assert.rejects(create(identifier("ns")), ScopeViolationError);
        assert.equal(await state.loadInstallation(), undefined);
        assert.deepEqual(await state.read((view) => view.audit.list()), []);
        assert.equal(
          (await pool.query("SELECT count(*)::int AS count FROM occ.iam_identities")).rows[0].count,
          0,
        );
      },
    );

    const owner = namespace();
    const foreign = namespace();
    await runner.transact(async (unit) => {
      await unit.namespaces.createNamespace(owner);
      await unit.namespaces.createNamespace(foreign);
    });
    assert.deepEqual(await state.loadInstallation(), installation);
    assert.equal(
      (await state.loadNativeIAMState()).identities.some((identity) => identity.id === actor),
      true,
    );
    const secrets = [];
    for (const namespaceId of [owner.id, owner.id, foreign.id]) {
      const identity = { id: identifier("sec"), namespaceId, name: `model-${randomUUID()}` };
      const secret = {
        ...identity,
        driverId: secretDriver.id,
        backendRef: await secretDriver.create(identity, "disposable-configuration-fixture-value"),
        createdAt: timestamp(),
      };
      await runner.transact((unit) => unit.secrets.createSecret(secret));
      secrets.push(secret);
    }
    const [initialSecret, nextSecret, foreignSecret] = secrets;

    await t.test(
      "the extracted service enforces exact ownership and persisted Secret references",
      async () => {
        const configuration = await create(owner.id, { secretBindings: binding(initialSecret) });
        assert.equal(configuration.generation, 1);
        assert.deepEqual(configuration.secretBindings, binding(initialSecret));
        assert.deepEqual((await metadata(configuration)).secretBindings, binding(initialSecret));
        assert.deepEqual(
          await service.getConfiguration(actor, owner.id, configuration.id),
          configuration,
        );
        for (const operation of [
          () => service.getConfiguration(actor, foreign.id, configuration.id),
          () =>
            service.updateConfiguration(actor, {
              namespaceId: foreign.id,
              configurationId: configuration.id,
              values: {},
            }),
          () => service.deleteConfiguration(actor, foreign.id, configuration.id),
          () =>
            service.updateConfiguration(actor, {
              namespaceId: owner.id,
              configurationId: configuration.id,
              values: {},
              secretBindings: binding(foreignSecret),
            }),
        ])
          await assert.rejects(operation(), ScopeViolationError);
        assert.deepEqual(
          await service.getConfiguration(actor, owner.id, configuration.id),
          configuration,
        );
        assert.equal(
          await state.read((view) =>
            view.configurations.findConfiguration(foreign.id, configuration.id),
          ),
          undefined,
        );
        assert.equal(
          await runner.transact((unit) => unit.secrets.hasReferences(owner.id, initialSecret.id)),
          true,
        );
        await assert.rejects(
          runner.transact((unit) => unit.secrets.deleteSecret(owner.id, initialSecret.id)),
          ScopeViolationError,
        );
        const cleared = await service.updateConfiguration(actor, {
          namespaceId: owner.id,
          configurationId: configuration.id,
          values: document("cleared"),
          secretBindings: {},
        });
        assert.equal(cleared.generation, 2);
        assert.equal(Object.hasOwn(await metadata(cleared), "secretBindings"), false);
        assert.equal(
          await runner.transact((unit) => unit.secrets.hasReferences(owner.id, initialSecret.id)),
          false,
        );
        await service.deleteConfiguration(actor, owner.id, configuration.id);
        assert.equal(await metadata(configuration), undefined);
        await assert.rejects(configurationDriver.read(configuration), /does not exist/);
      },
    );

    await t.test(
      "repository generation CAS rejects a stale expected generation without changing bindings",
      async () => {
        const configuration = await create(owner.id, { secretBindings: binding(initialSecret) });
        const advanced = await service.updateConfiguration(actor, {
          namespaceId: owner.id,
          configurationId: configuration.id,
          values: document("advanced"),
          secretBindings: binding(nextSecret),
        });
        const before = await metadata(configuration);
        const rejected = await runner.transact((unit) =>
          unit.configurations.advanceConfigurationGeneration(
            owner.id,
            configuration.id,
            configuration.generation,
            binding(initialSecret),
          ),
        );
        assert.equal(rejected, undefined);
        assert.deepEqual(await metadata(configuration), before);
        assert.deepEqual(
          await service.getConfiguration(actor, owner.id, configuration.id),
          advanced,
        );
      },
    );

    for (const action of ["create", "update", "delete"]) {
      await t.test(
        `a duplicate PostgreSQL audit rolls back ${action} metadata and compensates Driver storage`,
        async () => {
          const previous =
            action === "create"
              ? undefined
              : await create(owner.id, { secretBindings: binding(initialSecret) });
          let mutated;
          let event;
          await assert.rejects(
            runner.transact(async (unit) => {
              if (action === "create")
                mutated = await create(owner.id, { secretBindings: binding(nextSecret) });
              else if (action === "update")
                mutated = await service.updateConfiguration(actor, {
                  namespaceId: owner.id,
                  configurationId: previous.id,
                  values: document("must-roll-back"),
                  secretBindings: binding(nextSecret),
                });
              else {
                await service.deleteConfiguration(actor, owner.id, previous.id);
                mutated = previous;
              }
              event = auditFor(mutated, action);
              await unit.audit.append(event);
              // An actual primary-key violation occurs after the real service and
              // Driver mutation; neither persistence nor compensation is patched.
              await unit.audit.append(event);
            }),
            ResourceConflictError,
          );
          assert.ok(mutated);
          assert.deepEqual(await auditEvents(mutated), []);
          assert.equal(
            (await pool.query("SELECT id FROM occ.audit_events WHERE id = $1", [event.id]))
              .rowCount,
            0,
          );
          if (previous === undefined) {
            assert.equal(await metadata(mutated), undefined);
            await assert.rejects(configurationDriver.read(mutated), /does not exist/);
          } else {
            assert.deepEqual(
              await service.getConfiguration(actor, owner.id, previous.id),
              previous,
            );
            const { values: _values, ...expectedMetadata } = previous;
            assert.deepEqual(await metadata(previous), expectedMetadata);
          }
        },
      );
    }

    await t.test(
      "independent services serialize unversioned updates and retain newly committed Secret references",
      async () => {
        const configuration = await create(owner.id, { secretBindings: binding(initialSecret) });
        const secondRunner = new MutationRunner(installation, state);
        const secondService = serviceFor(secondRunner, drivers);
        const ready = Promise.withResolvers();
        const release = Promise.withResolvers();
        let second;
        const first = runner.transact(async (unit) => {
          const updated = await service.updateConfiguration(actor, {
            namespaceId: owner.id,
            configurationId: configuration.id,
            values: document("first"),
            secretBindings: binding(nextSecret),
          });
          const backend = await state.queryInTransaction(unit, "SELECT pg_backend_pid() AS pid");
          ready.resolve(backend.rows[0].pid);
          await release.promise;
          await unit.audit.append(auditFor(updated, "update"));
          return updated;
        });
        first.catch(ready.reject);
        try {
          const firstPid = await ready.promise;
          second = secondRunner.transact(async (unit) => {
            const updated = await secondService.updateConfiguration(actor, {
              namespaceId: owner.id,
              configurationId: configuration.id,
              values: document("second"),
            });
            await unit.audit.append(auditFor(updated, "update"));
            return updated;
          });
          // Observe the real contender blocked by the first unit before releasing
          // the winner. Omitted bindings must read that winner's committed state.
          second.catch(() => {});
          const secondPid = await waitForBlockedClient(pool, applicationName, firstPid);
          assert.notEqual(secondPid, firstPid);
          release.resolve();
          const results = await Promise.all([first, second]);
          assert.deepEqual(
            results.map((value) => value.generation),
            [2, 3],
          );
          assert.deepEqual(results[1].secretBindings, binding(nextSecret));
          assert.deepEqual(
            await service.getConfiguration(actor, owner.id, configuration.id),
            results[1],
          );
          assert.deepEqual((await metadata(configuration)).secretBindings, binding(nextSecret));
          assert.equal((await auditEvents(configuration)).length, 2);
        } finally {
          release.resolve();
          await Promise.allSettled([first, ...(second === undefined ? [] : [second])]);
        }
      },
    );

    await t.test(
      "independent services admit only one update with the same expected generation",
      async () => {
        const configuration = await create(owner.id, { secretBindings: binding(initialSecret) });
        const contenders = [
          { values: document("expected-first"), secretBindings: binding(nextSecret) },
          { values: document("expected-second"), secretBindings: {} },
        ];
        const results = await Promise.allSettled(
          contenders.map(async (change) => {
            const contenderRunner = new MutationRunner(installation, state);
            const contenderService = serviceFor(contenderRunner, drivers);
            return contenderRunner.transact(async (unit) => {
              const updated = await contenderService.updateConfiguration(actor, {
                namespaceId: owner.id,
                configurationId: configuration.id,
                expectedGeneration: configuration.generation,
                ...change,
              });
              await unit.audit.append(auditFor(updated, "update"));
              return updated;
            });
          }),
        );
        const accepted = results.filter((result) => result.status === "fulfilled");
        const rejected = results.filter((result) => result.status === "rejected");
        assert.equal(accepted.length, 1);
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].reason.constructor, ResourceConflictError);
        const committed = accepted[0].value;
        const winningChange =
          contenders[results.findIndex((result) => result.status === "fulfilled")];
        assert.equal(committed.generation, 2);
        assert.deepEqual(committed.values, winningChange.values);
        assert.deepEqual(
          committed.secretBindings,
          Object.keys(winningChange.secretBindings).length === 0
            ? undefined
            : winningChange.secretBindings,
        );
        assert.equal(
          writesFor(configuration).length,
          1,
          "the stale contender must not write the Driver",
        );
        assert.deepEqual(
          await service.getConfiguration(actor, owner.id, configuration.id),
          committed,
        );
        const { values: _values, ...expectedMetadata } = committed;
        assert.deepEqual(await metadata(configuration), expectedMetadata);
        const events = await auditEvents(configuration);
        assert.equal(events.length, 1, "the rejected contender must not append a success audit");
        assert.equal(events[0].action, "openclaw.configurations.update");

        // Retrying the original precondition cannot erase the winner's document
        // or Secret bindings, even after the racing transactions have completed.
        await assert.rejects(
          service.updateConfiguration(actor, {
            namespaceId: owner.id,
            configurationId: configuration.id,
            expectedGeneration: configuration.generation,
            values: document("stale-retry"),
            secretBindings: {},
          }),
          ResourceConflictError,
        );
        assert.deepEqual(
          await service.getConfiguration(actor, owner.id, configuration.id),
          committed,
        );
        assert.deepEqual(await auditEvents(configuration), events);
        assert.equal(writesFor(configuration).length, 1);
      },
    );

    async function api(auditEventFactory) {
      // Each Fastify app owns its admission verifier and controller composition;
      // both instances still use the same persisted ownership and Driver storage.
      const controller = new OpenClawController(installation, { state, recordOperations: false });
      for (const driver of [iam, configurationDriver, secretDriver]) {
        controller.registerDriver(driver);
        controller.selectDriver(driver.capability, driver.id);
      }
      const app = createFastifyApp({
        controller,
        iamDriver: iam,
        configurationDriver,
        secretDriver,
        resolveHarness: resolveApprovedHarness,
        auditSink: state.auditSink,
        development: {
          enabled: true,
          issuer: auth.seed.principal.issuer,
          subject: auth.seed.principal.subject,
          principalId: actor,
          installationId: installation.id,
        },
        publicOrigin: "http://127.0.0.1",
        auth: auth.auth,
        ...(auditEventFactory === undefined ? {} : { auditEventFactory }),
      });
      t.after(() => app.close());
      return createAuthenticatedControllerRequest(app, auth);
    }
    const request = await api();

    await t.test(
      "actual Fastify CRUD consumes the extracted service and commits exact PostgreSQL audit events",
      async () => {
        const collection = `/namespaces/${owner.id}/configurations`;
        const created = await request("POST", collection, {
          kind: "agent",
          values: document("http-original"),
          secretBindings: binding(initialSecret),
        });
        assert.equal(created.status, 201, JSON.stringify(created));
        const configuration = created.data;
        const path = `${collection}/${configuration.id}`;
        assert.deepEqual((await request("GET", path)).data, configuration);
        const foreignRead = await request(
          "GET",
          `/namespaces/${foreign.id}/configurations/${configuration.id}`,
        );
        assert.equal(foreignRead.status, 404, JSON.stringify(foreignRead));
        const updated = await request("PATCH", path, { values: document("http-updated") });
        assert.equal(updated.status, 200, JSON.stringify(updated));
        assert.equal(updated.data.generation, 2);
        assert.deepEqual(updated.data.secretBindings, binding(initialSecret));
        assert.deepEqual(
          await service.getConfiguration(actor, owner.id, configuration.id),
          updated.data,
        );
        const deleted = await request("DELETE", path);
        assert.equal(deleted.status, 204, JSON.stringify(deleted));
        assert.equal((await request("GET", path)).status, 404);
        assert.equal(await metadata(configuration), undefined);
        const events = await auditEvents(configuration);
        assert.deepEqual(
          events.map((event) => event.action),
          [
            "openclaw.configurations.create",
            "openclaw.configurations.update",
            "openclaw.configurations.delete",
          ],
        );
        for (const event of events) {
          assert.equal(event.actorId, actor);
          assert.equal(event.installationId, installation.id);
          assert.equal(event.namespaceId, owner.id);
          assert.equal(event.outcome, "success");
          assert.deepEqual(event.resource, {
            kind: "configuration",
            id: configuration.id,
            namespaceId: owner.id,
          });
        }
      },
    );

    await t.test(
      "actual Fastify audit conflict restores both the previous generation and Driver document",
      async () => {
        const collection = `/namespaces/${owner.id}/configurations`;
        const created = await request("POST", collection, {
          kind: "agent",
          values: document("retained"),
          secretBindings: binding(initialSecret),
        });
        assert.equal(created.status, 201, JSON.stringify(created));
        const configuration = created.data;
        const committedAudits = await auditEvents(configuration);
        assert.equal(committedAudits.length, 1);
        const duplicate = new AuditEventFactory({ idGenerator: () => committedAudits[0].id });
        const conflictingRequest = await api(duplicate);
        const rejected = await conflictingRequest("PATCH", `${collection}/${configuration.id}`, {
          values: document("uncommitted"),
          secretBindings: binding(nextSecret),
        });
        assert.equal(rejected.status, 409, JSON.stringify(rejected));
        assert.equal(rejected.error.code, "RESOURCE_CONFLICT");
        assert.deepEqual(
          await service.getConfiguration(actor, owner.id, configuration.id),
          configuration,
        );
        assert.deepEqual(await auditEvents(configuration), committedAudits);
        const { values: _values, ...expectedMetadata } = configuration;
        assert.deepEqual(await metadata(configuration), expectedMetadata);
      },
    );

    await t.test(
      "actual Fastify conditional PATCH commits one generation and one update audit",
      async () => {
        const collection = `/namespaces/${owner.id}/configurations`;
        const created = await request("POST", collection, {
          kind: "agent",
          values: document("http-conditional"),
          secretBindings: binding(initialSecret),
        });
        assert.equal(created.status, 201, JSON.stringify(created));
        const configuration = created.data;
        const path = `${collection}/${configuration.id}`;
        const changes = [
          { values: document("http-first"), secretBindings: binding(nextSecret) },
          { values: document("http-second"), secretBindings: {} },
        ];
        const responses = await Promise.all(
          changes.map((change) => request("PATCH", path, { expectedGeneration: 1, ...change })),
        );
        assert.deepEqual(
          responses.map((response) => response.status).sort(),
          [200, 409],
          JSON.stringify(responses),
        );
        const winner = responses.find((response) => response.status === 200).data;
        const loser = responses.find((response) => response.status === 409);
        const winningChange = changes[responses.findIndex((response) => response.status === 200)];
        assert.equal(loser.error.code, "RESOURCE_CONFLICT");
        assert.equal(winner.generation, 2);
        assert.deepEqual(winner.values, winningChange.values);
        assert.deepEqual(
          winner.secretBindings,
          Object.keys(winningChange.secretBindings).length === 0
            ? undefined
            : winningChange.secretBindings,
        );
        assert.equal(writesFor(configuration).length, 1);
        assert.deepEqual((await request("GET", path)).data, winner);
        assert.deepEqual(await service.getConfiguration(actor, owner.id, configuration.id), winner);
        const { values: _values, ...expectedMetadata } = winner;
        assert.deepEqual(await metadata(configuration), expectedMetadata);
        const events = await auditEvents(configuration);
        assert.deepEqual(
          events.map((event) => event.action),
          ["openclaw.configurations.create", "openclaw.configurations.update"],
        );
        const stale = await request("PATCH", path, {
          expectedGeneration: 1,
          values: document("http-stale"),
          secretBindings: {},
        });
        assert.equal(stale.status, 409, JSON.stringify(stale));
        assert.equal(stale.error.code, "RESOURCE_CONFLICT");
        assert.deepEqual((await request("GET", path)).data, winner);
        assert.deepEqual(await auditEvents(configuration), events);
        assert.equal(
          writesFor(configuration).length,
          1,
          "a stale HTTP retry must not write the Driver",
        );
      },
    );
  },
);
