import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  DependencyUnavailableError,
  OpenClawController,
  PostgresCommitOutcomeUnknownError,
  PostgresPlatformState,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { MutationRunner } from "../../packages/occ/src/application/mutation-runner.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";
import { createRuntimeAdmissionContext } from "../fixtures/runtime-admission-context.mjs";
import { createTestAuthPrincipal } from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { cleanupNamespaces, ensureInstallation } from "../helpers/postgres-provider-state.mjs";

// Real PostgreSQL and Native IAM exercise the coordinator and its controller
// consumer. Configuration uses existing passive test storage, not a live provider.
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const options = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL for isolated migrated PostgreSQL mutation coverage.",
  timeout: 60_000,
};
const id = (kind) => `${kind}_${randomUUID()}`;
const namespace = () => ({
  id: id("ns"),
  name: `mutation-${randomUUID()}`,
  status: "provisioning",
  createdAt: new Date().toISOString(),
});

async function fixture(t) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const namespaces = [];
  t.after(async () => {
    try {
      await cleanupNamespaces(pool, namespaces);
    } finally {
      await pool.end();
    }
  });
  const state = new PostgresPlatformState(pool);
  const installation = await ensureInstallation(state, "mutation-coordinator");
  return {
    pool,
    state,
    installation,
    runner: new MutationRunner(installation, state),
    track(candidate) {
      namespaces.push(candidate.id);
      return candidate;
    },
  };
}

async function bundleCounts(pool, namespaceId) {
  return (
    await pool.query(
      `SELECT
         (SELECT count(*)::int FROM occ.namespaces WHERE id=$1) AS resources,
         (SELECT count(*)::int FROM occ.controller_work WHERE namespace_id=$1) AS work,
         (SELECT count(*)::int FROM occ.audit_events WHERE namespace_id=$1) AS audit`,
      [namespaceId],
    )
  ).rows[0];
}

async function appendBundle(unit, installation, candidate) {
  await unit.namespaces.createNamespace(candidate);
  await unit.operations.append({
    kind: "namespace",
    action: "reconcile",
    target: "ready",
    namespaceId: candidate.id,
    resourceId: candidate.id,
    actorId: "mutation-test-actor",
  });
  await unit.audit.append({
    id: id("aud"),
    installationId: installation.id,
    namespaceId: candidate.id,
    occurredAt: candidate.createdAt,
    kind: "mutation",
    actorId: "mutation-test-actor",
    action: "create",
    resource: { kind: "namespace", id: candidate.id, namespaceId: candidate.id },
    outcome: "success",
  });
}

test(
  "PostgreSQL runner joins nested resource, work and audit repositories until outer commit",
  options,
  async (t) => {
    const f = await fixture(t);
    const candidate = f.track(namespace());
    const repositories = f.runner.forRepositories({
      read: { namespaces: ["findNamespace"], audit: ["list"], operations: ["list"] },
      mutate: { namespaces: ["createNamespace"], audit: ["append"], operations: ["append"] },
    });
    let retained;
    let retainedProjection;
    await f.runner.transact(async (outer) => {
      retained = outer;
      assert.equal(f.runner.hasActiveTransaction(), true);
      const original = await f.state.queryInTransaction(
        outer,
        "SELECT pg_backend_pid() AS pid, txid_current()::text AS transaction",
      );
      await f.runner.transact(async (inner) => {
        assert.equal(inner, outer);
        const joined = await f.state.queryInTransaction(
          inner,
          "SELECT pg_backend_pid() AS pid, txid_current()::text AS transaction",
        );
        assert.deepEqual(joined.rows, original.rows);
        await repositories.mutate(async (selected) => {
          assert.deepEqual(Object.keys(selected).sort(), ["audit", "namespaces", "operations"]);
          assert.deepEqual(Object.keys(selected.namespaces), ["createNamespace"]);
          assert.deepEqual(Object.keys(selected.audit), ["append"]);
          assert.deepEqual(Object.keys(selected.operations), ["append"]);
          await appendBundle(selected, f.installation, candidate);
        });
      });
      await f.runner.read(async (view) => assert.equal(view, outer));
      await repositories.read(async (view) => {
        retainedProjection = view;
        // The read projection remains restricted even while it joins a mutable unit.
        assert.deepEqual(Object.keys(view.namespaces), ["findNamespace"]);
        assert.deepEqual(Object.keys(view.audit), ["list"]);
        assert.deepEqual(Object.keys(view.operations), ["list"]);
        assert.deepEqual(await view.namespaces.findNamespace(candidate.id), candidate);
        assert.equal(
          (await view.operations.list()).filter((row) => row.namespaceId === candidate.id).length,
          1,
        );
        assert.equal(
          (await view.audit.list()).filter((row) => row.namespaceId === candidate.id).length,
          1,
        );
      });
      // A separate backend sees none of the nested writes before the owner commits.
      assert.deepEqual(await bundleCounts(f.pool, candidate.id), {
        resources: 0,
        work: 0,
        audit: 0,
      });
    });
    assert.equal(f.runner.hasActiveTransaction(), false);
    assert.deepEqual(await bundleCounts(f.pool, candidate.id), { resources: 1, work: 1, audit: 1 });
    await assert.rejects(retained.namespaces.findNamespace(candidate.id), ScopeViolationError);
    await assert.rejects(
      retainedProjection.namespaces.findNamespace(candidate.id),
      ScopeViolationError,
    );
  },
);

test(
  "PostgreSQL runner rolls back a nested bundle and compensates in reverse registration order",
  options,
  async (t) => {
    const f = await fixture(t);
    const candidate = f.track(namespace());
    const failure = new Error("owning mutation rejected");
    const compensated = [];
    let retained;
    await assert.rejects(
      f.runner.transact(async (outer) => {
        retained = outer;
        f.runner.registerRollback(async () => compensated.push("outer"));
        await f.runner.mutate(async (inner) => {
          assert.equal(inner, outer);
          await appendBundle(inner, f.installation, candidate);
          f.runner.registerRollback(async () => compensated.push("inner"));
        });
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.deepEqual(compensated, ["inner", "outer"]);
    assert.deepEqual(await bundleCounts(f.pool, candidate.id), { resources: 0, work: 0, audit: 0 });
    await assert.rejects(retained.audit.list(), ScopeViolationError);
    assert.equal(f.runner.hasActiveTransaction(), false);
  },
);

test(
  "PostgreSQL runner drains accepted SQL and repository writes and revokes retained handles",
  options,
  async (t) => {
    const f = await fixture(t);
    const candidate = f.track(namespace());
    let retained;
    let acceptedQuery;
    let acceptedWrite;
    let queryFinished = false;
    let writeFinished = false;
    await f.runner.transact(async (unit) => {
      retained = unit;
      // Both calls are admitted before callback completion. The real slow query
      // keeps the SQL connection busy while the accepted repository write queues.
      acceptedQuery = f.state
        .queryInTransaction(unit, "SELECT pg_sleep(0.05), 7 AS value")
        .then((result) => {
          queryFinished = true;
          return result;
        });
      acceptedWrite = unit.namespaces.createNamespace(candidate).then((result) => {
        writeFinished = true;
        return result;
      });
    });
    assert.equal(queryFinished, true);
    assert.equal(writeFinished, true);
    assert.equal((await acceptedQuery).rows[0].value, 7);
    assert.deepEqual(await acceptedWrite, candidate);
    assert.deepEqual(
      await f.runner.read((view) => view.namespaces.findNamespace(candidate.id)),
      candidate,
    );
    await assert.rejects(retained.installations.getInstallation(), ScopeViolationError);
    await assert.rejects(retained.operations.list(), ScopeViolationError);
    await assert.rejects(retained.namespaces.createNamespace(namespace()), ScopeViolationError);
    assert.throws(
      () => f.state.queryInTransaction(retained, "SELECT 1"),
      DependencyUnavailableError,
    );
    assert.equal((await f.pool.query("SELECT 1 AS available")).rows[0].available, 1);
  },
);

async function controllerFixture(t) {
  const f = await fixture(t);
  const credentials = await createTestAuthPrincipal({ installationId: f.installation.id });
  const actor = credentials.seed.principal;
  const roleId = id("rol");
  await f.state.seedNativeIAM({
    identities: [actor],
    groups: [],
    memberships: [],
    restrictions: [],
    roles: [
      {
        id: roleId,
        permissions: [
          ["create", "namespace"],
          ["create", "configuration"],
          ["read", "configuration"],
          ["update", "configuration"],
          ["create", "agent"],
          ["deploy", "agent"],
        ].map(([action, resourceKind]) => ({ action, resourceKind })),
      },
    ],
    bindings: [{ id: id("bnd"), subjectKind: "identity", subjectId: actor.id, roleId }],
  });
  const configuration = createTestConfigurationDriver();
  function controllerFor(state = f.state) {
    const controller = new OpenClawController(f.installation, { state, recordOperations: false });
    // Native IAM reads use the normal pool, so a COMMIT fault affects only the
    // resource mutation whose admission locator the caller retained.
    for (const driver of [
      new NativeIAMDriver(f.state),
      configuration,
      createDevelopmentComputeDriver(),
    ]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    return controller;
  }
  const controller = controllerFor();
  const owner = f.track(
    await controller.createNamespace(actor.id, { name: `mutation-${randomUUID()}` }),
  );
  const draft = await controller.createConfiguration(actor.id, {
    namespaceId: owner.id,
    kind: "agent",
    values: { model: "original" },
  });
  const agent = await controller.createAgent(actor.id, {
    namespaceId: owner.id,
    name: "Mutation Agent",
    configurationId: draft.id,
  });
  await f.state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(owner.id, "provisioning", "ready"),
  );
  const scope = { namespaceId: owner.id, agentId: agent.id };
  const context = () => createRuntimeAdmissionContext(f.installation.id, actor.id);
  const deploy = (admission, selected = controller, expectedLifecycleGeneration = null) =>
    selected.deployAgent(
      actor.id,
      { ...scope, expectedLifecycleGeneration },
      resolveApprovedHarness,
      admission,
    );
  const update = (model, selected = controller) =>
    selected.updateConfiguration(actor.id, {
      namespaceId: owner.id,
      configurationId: draft.id,
      values: { model },
    });
  async function snapshot() {
    const counts = (
      await f.pool.query(
        `SELECT
         (SELECT generation::int FROM occ.configurations WHERE namespace_id=$1 AND id=$2) AS configuration_generation,
         (SELECT count(*)::int FROM occ.agent_revisions WHERE namespace_id=$1) AS revisions,
         (SELECT count(*)::int FROM occ.agent_runtime_intents WHERE namespace_id=$1) AS intents,
         (SELECT count(*)::int FROM occ.agent_revision_runtime_admissions WHERE namespace_id=$1) AS admissions,
         (SELECT count(*)::int FROM occ.controller_work WHERE namespace_id=$1) AS work,
         (SELECT count(*)::int FROM occ.audit_events WHERE namespace_id=$1) AS audit`,
        [owner.id, draft.id],
      )
    ).rows[0];
    const head = await f.state.read((view) => view.runtimeAssignments.findRuntimeIntentHead(scope));
    return { ...counts, head };
  }
  return {
    ...f,
    actor,
    configuration,
    controller,
    controllerFor,
    draft,
    scope,
    context,
    deploy,
    update,
    snapshot,
  };
}

test(
  "PostgreSQL controller nested mutations roll back deployment, audit and Configuration Driver updates together",
  options,
  async (t) => {
    const f = await controllerFixture(t);
    const before = await f.snapshot();
    const failure = new Error("enclosing controller mutation rejected");
    const admission = f.context();
    let retained;
    await assert.rejects(
      f.controller.transact(async (outer) => {
        retained = outer;
        await f.update("intermediate");
        await f.controller.transact(async (inner) => {
          assert.equal(inner, outer);
          await f.update("candidate");
          const revision = await f.deploy(admission);
          assert.equal(
            (await inner.revisions.findRevision(f.scope.namespaceId, f.scope.agentId, revision.id))
              .id,
            revision.id,
          );
          assert.equal(
            (await inner.runtimeAssignments.findRuntimeIntentHead(f.scope)).transitionRef,
            admission.transitionRef,
          );
          assert.ok((await inner.operations.list()).some((row) => row.resourceId === revision.id));
          assert.ok((await inner.audit.list()).some((row) => row.resource.id === revision.id));
        });
        assert.deepEqual(await f.snapshot(), before);
        assert.equal((await f.configuration.read(f.draft)).values.model, "candidate");
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.deepEqual(await f.snapshot(), before);
    // Two real Driver updates require reverse compensation to restore the original.
    assert.deepEqual(await f.configuration.read(f.draft), f.draft);
    assert.equal(
      await f.state.read((view) =>
        view.runtimeAssignments.findRuntimeIntent(f.scope, admission.transitionRef),
      ),
      undefined,
    );
    await assert.rejects(
      retained.revisions.listRevisions(f.scope.namespaceId, f.scope.agentId),
      ScopeViolationError,
    );
  },
);

test(
  "PostgreSQL controller catches admission validation but poisons the enclosing mutation and compensates its Driver",
  options,
  async (t) => {
    const f = await controllerFixture(t);
    const before = await f.snapshot();
    const admission = f.context();
    await assert.rejects(
      f.controller.transact(async () => {
        await f.update("rejected");
        await f.deploy(admission);
        // The second call fails before issuing SQL; only the coordinator's admission
        // poison prevents the caught validation from committing the first deployment.
        await assert.rejects(
          f.controller.deployAgent(
            f.actor.id,
            { ...f.scope, expectedLifecycleGeneration: undefined },
            resolveApprovedHarness,
            f.context(),
          ),
          ScopeViolationError,
        );
      }),
      ScopeViolationError,
    );
    assert.deepEqual(await f.snapshot(), before);
    assert.deepEqual(await f.configuration.read(f.draft), f.draft);
    assert.equal(
      await f.state.read((view) =>
        view.runtimeAssignments.findRuntimeIntent(f.scope, admission.transitionRef),
      ),
      undefined,
    );
  },
);

test(
  "PostgreSQL controller COMMIT acknowledgement loss retains the original admission without compensation or replay",
  options,
  async (t) => {
    const f = await controllerFixture(t);
    const before = await f.snapshot();
    const proxy = await runtimeCommitAckProxy(databaseUrl);
    const faultPool = new pg.Pool({
      connectionString: proxy.url,
      max: 1,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
    });
    faultPool.on("error", () => {});
    try {
      const controller = f.controllerFor(new PostgresPlatformState(faultPool));
      const admission = f.context();
      let callbackCount = 0;
      let compensationCount = 0;
      let retained;
      let originalRevision;
      proxy.arm();
      await assert.rejects(
        controller.transact(async (outer) => {
          callbackCount++;
          retained = outer;
          controller.registerRollback(async () => {
            compensationCount++;
          });
          await f.update("committed", controller);
          originalRevision = await controller.transact(async (inner) => {
            assert.equal(inner, outer);
            return f.deploy(admission, controller);
          });
        }),
        PostgresCommitOutcomeUnknownError,
      );
      assert.equal(proxy.observedCommit, true);
      assert.equal(callbackCount, 1);
      assert.equal(compensationCount, 0);
      assert.equal((await f.configuration.read(f.draft)).values.model, "committed");
      const committed = await f.snapshot();
      for (const key of ["revisions", "intents", "admissions", "work", "audit"])
        assert.equal(committed[key], before[key] + 1, key);
      assert.equal(committed.configuration_generation, before.configuration_generation + 1);
      assert.equal(committed.head.transitionRef, admission.transitionRef);
      assert.equal(committed.head.revisionId, originalRevision.id);
      await assert.rejects(retained.installations.getInstallation(), ScopeViolationError);

      // A later committed head makes head-only recovery incorrect. The retained
      // locator must still select the original revision and perform no new writes.
      await f.deploy(f.context(), f.controller, 1);
      const beforeReadback = await f.snapshot();
      const recovered = await controller.recoverDeployAgent(
        f.actor.id,
        { ...f.scope, expectedLifecycleGeneration: null },
        admission,
      );
      assert.equal(recovered.id, originalRevision.id);
      assert.equal(recovered.revision, 1);
      assert.equal(beforeReadback.head.generation, 2);
      assert.deepEqual(await f.snapshot(), beforeReadback);
      assert.equal(callbackCount, 1);
      assert.equal(compensationCount, 0);
      assert.equal((await f.configuration.read(f.draft)).values.model, "committed");
    } finally {
      await faultPool.end();
      await proxy.close();
    }
  },
);
