import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { ExactAuthorization } from "../../packages/occ/src/application/authorization.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { selectRepositories } from "../../packages/occ/src/application/mutation-context.ts";
import { MutationRunner } from "../../packages/occ/src/application/mutation-runner.ts";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/errors.ts";
import { AGENT_REPOSITORIES } from "../../packages/occ/src/services/agent/port.ts";
import { AgentService } from "../../packages/occ/src/services/agent/service.ts";
import { CONFIGURATION_REPOSITORIES } from "../../packages/occ/src/services/configuration/port.ts";
import { ConfigurationService } from "../../packages/occ/src/services/configuration/service.ts";
import {
  DEPLOYMENT_REPOSITORIES,
  DEPLOYMENT_RECOVERY_REPOSITORIES,
} from "../../packages/occ/src/services/deployment/port.ts";
import { DeploymentService } from "../../packages/occ/src/services/deployment/service.ts";
import { isRuntimeAdmissionAudit } from "../../packages/occ/src/state/platform-state.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createRuntimeAdmissionContext } from "../fixtures/runtime-admission-context.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";

import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/ports/transaction-errors.ts";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";
import { createTestAuthPrincipal } from "../helpers/auth-session.mjs";

const id = (kind) => `${kind}_${randomUUID()}`;
const now = () => new Date().toISOString();
const databaseUrl = process.env.OCC_DEPLOYMENT_SERVICE_DATABASE_URL;

// Actual PostgreSQL, Native IAM and extracted services execute all admission
// decisions. The passive Configuration Driver does not establish live runtime proof.
test(
  "DeploymentService PostgreSQL admission and retained COMMIT acknowledgement recovery",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_DEPLOYMENT_SERVICE_DATABASE_URL to an exclusive fresh migrated disposable PostgreSQL database.",
    timeout: 120_000,
  },
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 6,
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
      "Select a fresh database; this suite never replaces an existing Installation.",
    );
    const installation = { id: id("ins"), name: "Deployment service PostgreSQL", createdAt: now() };
    const auth = await createTestAuthPrincipal({ installationId: installation.id });
    const actor = auth.seed.principal.id;
    state.setBootstrapNativeIAM({
      identities: [auth.seed.principal],
      groups: [],
      memberships: [],
      roles: auth.seed.roles,
      bindings: auth.seed.bindings,
      restrictions: [],
    });
    const runner = new MutationRunner(installation, state);
    const drivers = new DriverSelection();
    for (const driver of [
      new NativeIAMDriver(state),
      createTestConfigurationDriver(),
      createDevelopmentComputeDriver(),
    ]) {
      drivers.registerDriver(driver);
      drivers.selectDriver(driver.capability, driver.id);
    }
    const common = {
      authorization: new ExactAuthorization(() => drivers.selectedDriver("iam")),
      providers: new Map(),
      assertSecretDriverOwner: (expectedId) => {
        drivers.secretDriver(expectedId);
      },
      now,
    };
    const configurations = new ConfigurationService({
      ...common,
      repositories: runner.forRepositories(CONFIGURATION_REPOSITORIES),
      configurationDriver: () => drivers.configurationDriver(),
      createId: () => id("cfg"),
    });
    const agents = new AgentService({
      ...common,
      repositories: runner.forRepositories(AGENT_REPOSITORIES),
      createId: () => id("agt"),
    });
    function serviceFor(owner = runner, recoveryState = state) {
      return new DeploymentService({
        installationId: installation.id,
        isRuntimeAdmissionAudit,
        repositories: owner.forRepositories(DEPLOYMENT_REPOSITORIES),
        recoveryRead: (work) =>
          recoveryState.read((view) =>
            work(selectRepositories(view, DEPLOYMENT_RECOVERY_REPOSITORIES)),
          ),
        hasActiveTransaction: () => owner.hasActiveTransaction(),
        poisonAdmission: (error) => owner.poisonAdmission(error),
        authorization: common.authorization,
        providers: common.providers,
        computeDriver: () => drivers.selectedDriver("compute"),
        configurationDriver: () => drivers.configurationDriver(),
        secretDriver: (expectedId) => drivers.secretDriver(expectedId),
        sandboxDriver: () => drivers.sandboxDriver(),
        // No error behavior is invented: successful operations run the real selected
        // Driver directly. This suite does not assert composition error sanitization.
        configurationOperation: (operation) => operation(),
        secretOperation: (operation) => operation(),
        loggingLevel: "info",
        createId: () => id("rev"),
        now,
      });
    }
    const service = serviceFor();
    const context = () => createRuntimeAdmissionContext(installation.id, actor);
    async function fixture() {
      const namespace = { id: id("ns"), name: id("tenant"), status: "ready", createdAt: now() };
      await runner.transact((unit) => unit.namespaces.createNamespace(namespace));
      const configuration = await configurations.createConfiguration(actor, {
        namespaceId: namespace.id,
        kind: "agent",
        values: { model: "original" },
      });
      const agent = await agents.createAgent(actor, {
        namespaceId: namespace.id,
        name: "Deployment Agent",
        configurationId: configuration.id,
      });
      const scope = { namespaceId: namespace.id, agentId: agent.id };
      const deploy = (expectedLifecycleGeneration, admission = context(), target = service) =>
        target.deployAgent(
          actor,
          { ...scope, expectedLifecycleGeneration },
          resolveApprovedHarness,
          admission,
        );
      const snapshot = () =>
        state.read(async (view) => ({
          revisions: await view.revisions.listRevisions(namespace.id, agent.id),
          head: await view.runtimeAssignments.findRuntimeIntentHead(scope),
          operations: (await view.operations.list()).filter(
            (operation) => operation.namespaceId === namespace.id,
          ),
          audit: (await view.audit.list()).filter((event) => event.namespaceId === namespace.id),
        }));
      return { namespace, configuration, agent, scope, deploy, snapshot };
    }

    await t.test(
      "explicit null and current CAS admit immutable revisions with exact original work",
      async () => {
        const f = await fixture();
        const retained = context();
        const first = await f.deploy(null, retained);
        const before = await f.snapshot();
        await configurations.updateConfiguration(actor, {
          namespaceId: f.namespace.id,
          configurationId: f.configuration.id,
          values: { model: "edited" },
        });
        assert.deepEqual(await f.snapshot(), before);
        const second = await f.deploy(1);
        const saved = await f.snapshot();
        assert.equal(first.configuration.model, "original");
        assert.equal(second.configuration.model, "edited");
        assert.equal(second.configurationGeneration, 2);
        assert.deepEqual(saved.revisions, [first, second]);
        assert.equal(saved.head.generation, 2);
        assert.equal(saved.operations.length, 2);
        assert.equal(saved.audit.length, 2);
        assert.deepEqual(
          saved.operations.map((operation) => operation.resourceId).sort(),
          [first.id, second.id].sort(),
        );
        const work = saved.operations.find((operation) => operation.resourceId === first.id);
        assert.equal(work.runtimeTransitionRef, retained.transitionRef);
        assert.equal(work.actorId, actor);
        assert.equal(work.lifecycleGeneration, 1);
        for (const expected of [null, 1, 3])
          await assert.rejects(f.deploy(expected), ResourceConflictError);
        assert.deepEqual(await f.snapshot(), saved);
      },
    );

    await t.test(
      "independent services admit one concurrent successor without loser residue",
      async () => {
        const f = await fixture();
        const other = serviceFor(new MutationRunner(installation, state));
        for (const expected of [null, 1]) {
          const results = await Promise.allSettled([
            f.deploy(expected),
            f.deploy(expected, context(), other),
          ]);
          assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
          assert.ok(
            results.find((result) => result.status === "rejected").reason instanceof
              ResourceConflictError,
          );
          const saved = await f.snapshot();
          const count = expected === null ? 1 : 2;
          assert.equal(saved.head.generation, count);
          assert.equal(saved.revisions.length, count);
          assert.equal(saved.operations.length, count);
          assert.equal(saved.audit.length, count);
        }
      },
    );

    await t.test(
      "caught audit mismatch poisons prior Configuration and admission writes",
      async () => {
        const f = await fixture();
        const before = await f.snapshot();
        const wrongActor = createRuntimeAdmissionContext(installation.id, "another-actor");
        await assert.rejects(
          runner.transact(async () => {
            await configurations.updateConfiguration(actor, {
              namespaceId: f.namespace.id,
              configurationId: f.configuration.id,
              values: { model: "must-roll-back" },
            });
            await assert.rejects(f.deploy(null, wrongActor), ScopeViolationError);
          }),
          ScopeViolationError,
        );
        assert.deepEqual(await f.snapshot(), before);
        assert.deepEqual(
          await configurations.getConfiguration(actor, f.namespace.id, f.configuration.id),
          f.configuration,
        );
        await assert.rejects(
          runner.transact(async () => {
            await f.deploy(null);
            await assert.rejects(f.deploy(undefined), ScopeViolationError);
          }),
          ScopeViolationError,
        );
        assert.deepEqual(await f.snapshot(), before);
      },
    );

    await t.test(
      "real lost COMMIT ACK recovers only the retained exact original admission after a successor",
      async () => {
        const f = await fixture();
        const proxy = await runtimeCommitAckProxy(databaseUrl);
        const faultPool = new pg.Pool({
          connectionString: proxy.url,
          max: 1,
          connectionTimeoutMillis: 5_000,
          statement_timeout: 10_000,
          query_timeout: 12_000,
        });
        faultPool.on("error", () => {});
        try {
          // Native IAM continues reading from the ordinary pool. Only the actual
          // service admission connection loses its server COMMIT acknowledgement.
          const faultState = new PostgresPlatformState(faultPool);
          const faultRunner = new MutationRunner(installation, faultState);
          const faultService = serviceFor(faultRunner, faultState);
          const retained = context();
          proxy.arm();
          await assert.rejects(
            f.deploy(null, retained, faultService),
            PostgresCommitOutcomeUnknownError,
          );
          assert.equal(proxy.observedCommit, true);
          const committed = await f.snapshot();
          assert.equal(committed.head.transitionRef, retained.transitionRef);
          assert.equal(committed.revisions.length, 1);
          assert.equal(committed.operations.length, 1);
          await f.deploy(1);
          const beforeRecovery = await f.snapshot();
          const recovered = await faultService.recoverDeployAgent(actor, f.scope, retained);
          assert.deepEqual(recovered, committed.revisions[0]);
          assert.equal(beforeRecovery.head.generation, 2);
          for (const [who, locator] of [
            ["another-actor", retained],
            [actor, { ...retained, requestId: "another-request" }],
            [actor, { ...retained, transitionRef: randomUUID() }],
          ])
            await assert.rejects(
              faultService.recoverDeployAgent(who, f.scope, locator),
              DependencyUnavailableError,
            );
          await faultRunner.transact(async () => {
            await assert.rejects(
              faultService.recoverDeployAgent(actor, f.scope, retained),
              DependencyUnavailableError,
            );
          });
          assert.deepEqual(await f.snapshot(), beforeRecovery);
        } finally {
          await faultPool.end();
          await proxy.close();
        }
      },
    );
  },
);
