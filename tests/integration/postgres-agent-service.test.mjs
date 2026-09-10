import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { ExactAuthorization } from "../../packages/occ/src/application/authorization.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { MutationRunner } from "../../packages/occ/src/application/mutation-runner.ts";
import { ResourceConflictError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { AGENT_REPOSITORIES } from "../../packages/occ/src/services/agent/port.ts";
import { AgentService } from "../../packages/occ/src/services/agent/service.ts";
import { selectRepositories } from "../../packages/occ/src/application/mutation-context.ts";
import { CONFIGURATION_REPOSITORIES } from "../../packages/occ/src/services/configuration/port.ts";
import { ConfigurationService } from "../../packages/occ/src/services/configuration/service.ts";
import {
  DEPLOYMENT_REPOSITORIES,
  DEPLOYMENT_RECOVERY_REPOSITORIES,
} from "../../packages/occ/src/services/deployment/port.ts";
import { DeploymentService } from "../../packages/occ/src/services/deployment/service.ts";
import { createRuntimeAdmissionContext } from "../fixtures/runtime-admission-context.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { isRuntimeAdmissionAudit } from "../../packages/occ/src/state/platform-state.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { createTestAuthPrincipal } from "../helpers/auth-session.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const databaseUrl = process.env.OCC_AGENT_SERVICE_DATABASE_URL;
const id = (kind) => `${kind}_${randomUUID()}`;
const now = () => new Date().toISOString();

// Direct service/repository proof with PostgreSQL and Native IAM. Revision
// snapshots are admitted through DeploymentService; no live runtime is claimed.
test(
  "AgentService preserves PostgreSQL ownership, snapshot isolation and transaction serialization",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_AGENT_SERVICE_DATABASE_URL to a fresh migrated disposable PostgreSQL database.",
    timeout: 90_000,
  },
  async (t) => {
    const applicationName = `agent-service-${randomUUID()}`;
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
    assert.equal(
      await state.loadInstallation(),
      undefined,
      "This suite requires an exclusive fresh database and never replaces an existing Installation.",
    );
    const installation = { id: id("ins"), name: "Agent service PostgreSQL", createdAt: now() };
    const auth = await createTestAuthPrincipal({ installationId: installation.id });
    const actor = auth.seed.principal.id;
    // Supported bootstrap installs identity and authority with the first successful
    // owning transaction, preserving lazy Installation behavior on rejection.
    state.setBootstrapNativeIAM({
      identities: [auth.seed.principal],
      groups: [],
      memberships: [],
      roles: auth.seed.roles,
      bindings: auth.seed.bindings,
      restrictions: [],
    });
    const drivers = new DriverSelection();
    for (const driver of [
      new NativeIAMDriver(state),
      createTestSecretDriver(),
      createTestConfigurationDriver(),
      createDevelopmentComputeDriver(),
    ]) {
      drivers.registerDriver(driver);
      drivers.selectDriver(driver.capability, driver.id);
    }
    function serviceFor(runner) {
      return new AgentService({
        repositories: runner.forRepositories(AGENT_REPOSITORIES),
        authorization: new ExactAuthorization(() => drivers.selectedDriver("iam")),
        providers: new Map(),
        assertSecretDriverOwner: (expectedId) => {
          drivers.secretDriver(expectedId);
        },
        createId: () => id("agt"),
        now,
      });
    }
    const runner = new MutationRunner(installation, state);
    const service = serviceFor(runner);
    const configurations = new ConfigurationService({
      repositories: runner.forRepositories(CONFIGURATION_REPOSITORIES),
      authorization: new ExactAuthorization(() => drivers.selectedDriver("iam")),
      configurationDriver: () => drivers.configurationDriver(),
      assertSecretDriverOwner: (expectedId) => {
        drivers.secretDriver(expectedId);
      },
      createId: () => id("cfg"),
      now,
    });
    const deployments = new DeploymentService({
      installationId: installation.id,
      isRuntimeAdmissionAudit,
      repositories: runner.forRepositories(DEPLOYMENT_REPOSITORIES),
      recoveryRead: (work) =>
        state.read((view) => work(selectRepositories(view, DEPLOYMENT_RECOVERY_REPOSITORIES))),
      hasActiveTransaction: () => runner.hasActiveTransaction(),
      poisonAdmission: (error) => runner.poisonAdmission(error),
      authorization: new ExactAuthorization(() => drivers.selectedDriver("iam")),
      providers: new Map(),
      computeDriver: () => drivers.selectedDriver("compute"),
      configurationDriver: () => drivers.configurationDriver(),
      secretDriver: (expectedId) => drivers.secretDriver(expectedId),
      sandboxDriver: () => drivers.sandboxDriver(),
      configurationOperation: (operation) => operation(),
      secretOperation: (operation) => operation(),
      loggingLevel: "info",
      createId: () => id("rev"),
      now,
    });
    const create = (configurationId, options = {}) =>
      service.createAgent(actor, {
        namespaceId: owner.id,
        name: id("agent"),
        configurationId,
        ...options,
      });
    await assert.rejects(
      service.createAgent(actor, {
        namespaceId: id("ns"),
        name: "missing-owner",
        configurationId: id("cfg"),
      }),
      ScopeViolationError,
    );
    assert.equal(await state.loadInstallation(), undefined);
    const owner = { id: id("ns"), name: id("owner"), status: "ready", createdAt: now() };
    const foreign = { ...owner, id: id("ns"), name: id("foreign") };
    const configs = [];
    const account = { id: id("sa"), namespaceId: owner.id, name: id("account") };
    const foreignAccount = {
      ...account,
      id: id("sa"),
      namespaceId: foreign.id,
      name: id("foreign-account"),
    };
    await runner.transact(async (unit) => {
      await unit.namespaces.createNamespace(owner);
      await unit.namespaces.createNamespace(foreign);
      for (const namespaceId of [owner.id, owner.id, foreign.id])
        configs.push(
          await configurations.createConfiguration(actor, {
            namespaceId,
            kind: "agent",
            values: { model: "retained", nested: { enabled: true } },
          }),
        );
      await unit.serviceAccounts.createServiceAccount(account);
      await unit.serviceAccounts.createServiceAccount(foreignAccount);
    });
    const [original, next, foreignCfg] = configs;
    const audits = new AuditEventFactory();
    const auditFor = (agent) =>
      audits.create({
        installationId: installation.id,
        namespaceId: owner.id,
        actorId: actor,
        action: "openclaw.agents.update",
        resource: { kind: "agent", id: agent.id, namespaceId: owner.id },
      });

    await t.test(
      "execution limits persist and constraints reject missing or invalid new revision policy",
      async () => {
        const agent = await create(original.id);
        assert.equal(agent.maximumExecutionMs, null);
        const input = { namespaceId: owner.id, agentId: agent.id, configurationId: original.id };
        const capped = await service.updateAgent(actor, {
          ...input,
          maximumExecutionMs: 7_200_000,
        });
        assert.equal(capped.maximumExecutionMs, 7_200_000);
        assert.equal((await service.updateAgent(actor, input)).maximumExecutionMs, 7_200_000);
        assert.equal(
          (await service.getAgent(actor, owner.id, agent.id)).maximumExecutionMs,
          7_200_000,
        );
        const revision = await deployments.deployAgent(
          actor,
          {
            namespaceId: owner.id,
            agentId: agent.id,
            expectedLifecycleGeneration: null,
          },
          resolveApprovedHarness,
          createRuntimeAdmissionContext(installation.id, actor),
        );
        assert.equal(revision.maximumExecutionMs, 7_200_000);
        assert.equal(
          (await service.updateAgent(actor, { ...input, maximumExecutionMs: null }))
            .maximumExecutionMs,
          null,
        );
        assert.equal(
          (await service.getRevision(actor, owner.id, agent.id, revision.id)).maximumExecutionMs,
          7_200_000,
        );
        // Execute the actual CHECK through the application role; each rejected INSERT
        // is its own transaction and cannot affect the successfully admitted snapshot.
        const retained = (
          await pool.query("SELECT admitted_spec FROM occ.agent_revisions WHERE id=$1", [
            revision.id,
          ])
        ).rows[0].admitted_spec;
        for (const maximumExecutionMs of [
          undefined,
          0,
          -1,
          1.5,
          Number.MAX_SAFE_INTEGER + 1,
          "1000",
        ]) {
          const admitted = { ...retained, maximum_execution_ms: maximumExecutionMs };
          await assert.rejects(
            pool.query(
              `INSERT INTO occ.agent_revisions
          (id, namespace_id, agent_id, revision_number, provider_id, admitted_spec, admitted_at)
          VALUES ($1,$2,$3,2,NULL,$4::jsonb,now())`,
              [id("rev"), owner.id, agent.id, JSON.stringify(admitted)],
            ),
            (error) =>
              error.code === "23514" && error.constraint === "agent_revisions_execution_limit",
          );
        }
        for (const maximumExecutionMs of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
          await assert.rejects(
            pool.query("UPDATE occ.agents SET maximum_execution_ms=$1 WHERE id=$2", [
              maximumExecutionMs,
              agent.id,
            ]),
            (error) => error.code === "23514" && error.constraint === "agents_maximum_execution_ms",
          );
        }
        for (const maximumExecutionMs of [1, Number.MAX_SAFE_INTEGER, null]) {
          assert.equal(
            (await service.updateAgent(actor, { ...input, maximumExecutionMs })).maximumExecutionMs,
            maximumExecutionMs,
          );
        }
      },
    );

    await t.test("create and update retain exact foreign-key ownership", async () => {
      await assert.rejects(create(foreignCfg.id), ScopeViolationError);
      await assert.rejects(
        create(original.id, { serviceAccountId: foreignAccount.id }),
        ScopeViolationError,
      );
      const agent = await create(original.id, { serviceAccountId: account.id });
      for (const change of [
        { configurationId: foreignCfg.id },
        { serviceAccountId: foreignAccount.id },
        { namespaceId: foreign.id },
      ])
        await assert.rejects(
          service.updateAgent(actor, {
            namespaceId: owner.id,
            agentId: agent.id,
            configurationId: original.id,
            ...change,
          }),
          ScopeViolationError,
        );
      assert.deepEqual(await service.getAgent(actor, owner.id, agent.id), agent);
      await assert.rejects(service.getAgent(actor, foreign.id, agent.id), ScopeViolationError);
    });

    await t.test(
      "draft replacement leaves persisted admitted revision bytes unchanged",
      async () => {
        const agent = await create(original.id);
        // This real admission commits the revision together with its intent,
        // attributable audit, admission identity and original reconciliation work.
        const revision = await deployments.deployAgent(
          actor,
          {
            namespaceId: owner.id,
            agentId: agent.id,
            expectedLifecycleGeneration: null,
          },
          resolveApprovedHarness,
          createRuntimeAdmissionContext(installation.id, actor),
        );
        const before = await pool.query(
          "SELECT row_to_json(r)::text AS snapshot FROM occ.agent_revisions r WHERE id = $1",
          [revision.id],
        );
        const updated = await service.updateAgent(actor, {
          namespaceId: owner.id,
          agentId: agent.id,
          configurationId: next.id,
          executionMode: "dedicated",
        });
        assert.equal(updated.configurationId, next.id);
        assert.equal(updated.executionMode, "dedicated");
        assert.deepEqual(
          await service.getRevision(actor, owner.id, agent.id, revision.id),
          revision,
        );
        assert.deepEqual(
          (
            await pool.query(
              "SELECT row_to_json(r)::text AS snapshot FROM occ.agent_revisions r WHERE id = $1",
              [revision.id],
            )
          ).rows,
          before.rows,
        );
      },
    );

    await t.test(
      "a real audit primary-key conflict rolls back nested service create and update",
      async () => {
        const agent = await create(original.id);
        let transient;
        let event;
        await assert.rejects(
          runner.transact(async (unit) => {
            const updated = await service.updateAgent(actor, {
              namespaceId: owner.id,
              agentId: agent.id,
              configurationId: next.id,
            });
            transient = await create(next.id);
            event = auditFor(updated);
            await unit.audit.append(event);
            await unit.audit.append(event);
          }),
          ResourceConflictError,
        );
        assert.deepEqual(await service.getAgent(actor, owner.id, agent.id), agent);
        await assert.rejects(service.getAgent(actor, owner.id, transient.id), ScopeViolationError);
        assert.equal(
          (await pool.query("SELECT id FROM occ.audit_events WHERE id = $1", [event.id])).rowCount,
          0,
        );
      },
    );

    await t.test(
      "independent services serialize updates and preserve the first committed omitted fields",
      async () => {
        const agent = await create(original.id);
        const otherRunner = new MutationRunner(installation, state);
        const otherService = serviceFor(otherRunner);
        const ready = Promise.withResolvers();
        const release = Promise.withResolvers();
        let second;
        const first = runner.transact(async (unit) => {
          const updated = await service.updateAgent(actor, {
            namespaceId: owner.id,
            agentId: agent.id,
            configurationId: next.id,
            executionMode: "dedicated",
            serviceAccountId: account.id,
          });
          const backend = await state.queryInTransaction(unit, "SELECT pg_backend_pid() AS pid");
          ready.resolve(backend.rows[0].pid);
          await release.promise;
          await unit.audit.append(auditFor(updated));
          return updated;
        });
        first.catch(ready.reject);
        try {
          const firstPid = await ready.promise;
          second = otherRunner.transact(async (unit) => {
            const updated = await otherService.updateAgent(actor, {
              namespaceId: owner.id,
              agentId: agent.id,
              configurationId: original.id,
            });
            await unit.audit.append(auditFor(updated));
            return updated;
          });
          second.catch(() => {});
          // Observe PostgreSQL's actual blocking relationship before releasing the
          // winner; this proves contention rather than relying on scheduler timing.
          let blocked;
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const result = await pool.query(
              "SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name = $1 AND pid <> $2",
              [applicationName, firstPid],
            );
            blocked = result.rows.find((row) => row.blockers.includes(firstPid));
            if (blocked) break;
            await delay(20);
          }
          assert.ok(blocked, "The contender must reach a real PostgreSQL lock wait.");
          release.resolve();
          const [firstResult, secondResult] = await Promise.all([first, second]);
          assert.equal(firstResult.configurationId, next.id);
          assert.equal(secondResult.configurationId, original.id);
          assert.equal(secondResult.executionMode, "dedicated");
          assert.equal(secondResult.serviceAccountId, account.id);
          assert.deepEqual(await service.getAgent(actor, owner.id, agent.id), secondResult);
          assert.equal(
            (await state.read((view) => view.audit.list())).filter(
              (event) => event.resource.id === agent.id,
            ).length,
            2,
          );
        } finally {
          release.resolve();
          await Promise.allSettled([first, ...(second === undefined ? [] : [second])]);
        }
      },
    );
  },
);
