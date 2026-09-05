import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  DependencyUnavailableError,
  OpenClawController,
  PostgresCommitOutcomeUnknownError,
  PostgresPlatformState,
  PostgresWorkQueue,
  ResourceConflictError,
} from "../../packages/occ/src/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";
import { createRuntimeAdmissionContext } from "../fixtures/runtime-admission-context.mjs";
import { createTestAuthPrincipal, signInToControllerApp } from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import {
  cleanupNamespaces,
  ensureInstallation,
  waitFor,
} from "../helpers/postgres-provider-state.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const options = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL for real PostgreSQL admission integration.",
  timeout: 60000,
};
const migratorUrl = process.env.OCC_RUNTIME_ADMISSION_MIGRATOR_DATABASE_URL;
if (databaseUrl && migratorUrl) {
  const application = new URL(databaseUrl);
  const migrator = new URL(migratorUrl);
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(application.hostname),
    "admission fault fixtures require disposable loopback PostgreSQL",
  );
  assert.equal(migrator.hostname, application.hostname);
  assert.equal(migrator.port, application.port);
  assert.equal(
    migrator.pathname,
    application.pathname,
    "fault setup must target the same disposable test database",
  );
}

async function workState(pool, revisionId, expected) {
  return waitFor(`revision work ${expected}`, async () => {
    const result = await pool.query("SELECT * FROM occ.controller_work WHERE idempotency_key=$1", [
      `agent_revision:${revisionId}:reconcile`,
    ]);
    return result.rows[0]?.state === expected ? result.rows[0] : undefined;
  });
}

test(
  "a privileged paired-null corruption cannot make newly admitted work take the historical branch",
  options,
  async (t) => {
    if (!migratorUrl)
      return t.skip(
        "Set OCC_RUNTIME_ADMISSION_MIGRATOR_DATABASE_URL for privileged exact-row corruption coverage.",
      );
    const f = await fixture(t);
    const context = f.context();
    const revision = await f.deploy(context);
    const migrator = new pg.Pool({ connectionString: migratorUrl });
    const effects = [];
    const key = `agent_revision:${revision.id}:reconcile`;
    const worker = createControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl, max: 4 }),
      pollIntervalMs: 10,
      leaseDurationMs: 3000,
      computeDriver: {
        ...f.compute,
        async bindAgent() {
          effects.push("bindAgent");
        },
        async prepareRevision(candidate) {
          effects.push("prepareRevision");
          return f.compute.prepareRevision(candidate);
        },
      },
    });
    async function corruptOrRestore(dropPair) {
      const client = await migrator.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "ALTER TABLE occ.controller_work DISABLE TRIGGER controller_work_runtime_identity_is_immutable",
        );
        await client.query(
          "UPDATE occ.controller_work SET runtime_transition_ref=$2,lifecycle_generation=$3 WHERE idempotency_key=$1",
          [key, dropPair ? null : context.transitionRef, dropPair ? null : 1],
        );
        await client.query(
          "ALTER TABLE occ.controller_work ENABLE TRIGGER controller_work_runtime_identity_is_immutable",
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    try {
      // Neither application privileges nor ordinary owner SQL can rewrite the
      // retained admission or original work.
      await assert.rejects(
        migrator.query(
          "UPDATE occ.controller_work SET runtime_transition_ref=NULL,lifecycle_generation=NULL WHERE idempotency_key=$1",
          [key],
        ),
        { code: "55000" },
      );
      await assert.rejects(
        migrator.query("UPDATE occ.controller_work SET actor_id=$2 WHERE idempotency_key=$1", [
          key,
          "different-actor",
        ]),
        { code: "55000" },
      );
      await assert.rejects(
        migrator.query("DELETE FROM occ.controller_work WHERE idempotency_key=$1", [key]),
        { code: "55000" },
      );
      await assert.rejects(
        migrator.query(
          "UPDATE occ.agent_revision_runtime_admissions SET audit_event_id=audit_event_id WHERE revision_id=$1",
          [revision.id],
        ),
        { code: "55000" },
      );
      // Temporarily disabling only the pair trigger models privileged corruption
      // so the worker's independent admission check must still reject the row.
      await corruptOrRestore(true);
      await worker.start();
      await workState(f.pool, revision.id, "failed_permanent");
      assert.deepEqual(effects, []);
      const reason = await f.pool.query(
        "SELECT id FROM occ.audit_events WHERE resource_id=$1 AND details->>'reasonCode'='INVALID_RUNTIME_ADMISSION'",
        [revision.id],
      );
      assert.ok(reason.rowCount > 0);
    } finally {
      await worker.stop();
      await corruptOrRestore(false);
      await migrator.end();
    }
  },
);

async function fixture(t) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const state = new PostgresPlatformState(pool);
  const installation = await ensureInstallation(state, "runtime-admission");
  const credentials = await createTestAuthPrincipal({ installationId: installation.id });
  const actor = credentials.seed.principal;
  const roleId = `rol_${randomUUID()}`;
  await state.seedNativeIAM({
    identities: [actor],
    groups: [],
    memberships: [],
    restrictions: [],
    roles: [
      {
        id: roleId,
        permissions: [
          ["create", "namespace"],
          ["read", "namespace"],
          ["create", "configuration"],
          ["read", "configuration"],
          ["update", "configuration"],
          ["create", "agent"],
          ["deploy", "agent"],
        ].map(([action, resourceKind]) => ({ action, resourceKind })),
      },
    ],
    bindings: [{ id: `bnd_${randomUUID()}`, subjectKind: "identity", subjectId: actor.id, roleId }],
  });
  const configurationDriver = createTestConfigurationDriver();
  const compute = createDevelopmentComputeDriver();
  function controllerFor(store = state) {
    const controller = new OpenClawController(installation, {
      state: store,
      recordOperations: false,
    });
    // IAM uses the normal independent pool so transport faults target admission COMMIT.
    const iam = new NativeIAMDriver(state);
    for (const driver of [iam, configurationDriver, compute]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    return { controller, iam };
  }
  const { controller, iam } = controllerFor();
  const namespace = await controller.createNamespace(actor.id, {
    name: `admission-${randomUUID()}`,
  });
  const configuration = await controller.createConfiguration(actor.id, {
    namespaceId: namespace.id,
    kind: "agent",
    values: { model: "gpt-test" },
  });
  const agent = await controller.createAgent(actor.id, {
    namespaceId: namespace.id,
    name: "Admitted Agent",
    configurationId: configuration.id,
  });
  await state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const scope = { namespaceId: namespace.id, agentId: agent.id };
  const context = (settings) => createRuntimeAdmissionContext(installation.id, actor.id, settings);
  const deploy = (admission) =>
    controller.deployAgent(actor.id, scope, resolveApprovedHarness, admission);
  const apps = [];
  async function openApp(store = state, auditEventFactory) {
    const selected = store === state ? { controller, iam } : controllerFor(store);
    const app = createFastifyApp({
      controller: selected.controller,
      iamDriver: selected.iam,
      auth: credentials.auth,
      auditSink: state.auditSink,
      publicOrigin: "http://127.0.0.1",
      resolveHarness: resolveApprovedHarness,
      development: { enabled: true, installationId: installation.id },
      ...(auditEventFactory === undefined ? {} : { auditEventFactory }),
    });
    apps.push(app);
    await app.ready();
    const session = await signInToControllerApp(app, credentials);
    const request = async (body) =>
      app.inject({
        method: "POST",
        url: `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
        headers: { host: "127.0.0.1", origin: "http://127.0.0.1", cookie: session.cookie },
        ...(body === undefined ? {} : { payload: body }),
      });
    return { app, request };
  }
  async function snapshot() {
    const result = await pool.query(
      `SELECT
      (SELECT count(*)::int FROM occ.agent_revisions WHERE namespace_id=$1) AS revisions,
      (SELECT count(*)::int FROM occ.agent_runtime_intents WHERE namespace_id=$1) AS intents,
      (SELECT count(*)::int FROM occ.agent_revision_runtime_admissions WHERE namespace_id=$1) AS admissions,
      (SELECT count(*)::int FROM occ.controller_work WHERE namespace_id=$1) AS work,
      (SELECT count(*)::int FROM occ.audit_events WHERE namespace_id=$1 AND action='openclaw.agents.deploy' AND outcome='success') AS audits`,
      [namespace.id],
    );
    return result.rows[0];
  }
  t.after(async () => {
    for (const app of apps) await app.close();
    await cleanupNamespaces(pool, [namespace.id]);
    await pool.end();
  });
  return {
    pool,
    state,
    installation,
    actor,
    credentials,
    controller,
    controllerFor,
    compute,
    configuration,
    scope,
    namespace,
    agent,
    context,
    deploy,
    openApp,
    snapshot,
  };
}

test(
  "actual authenticated deploy with exact Agent permission but no Configuration read leaves no admission",
  options,
  async (t) => {
    const f = await fixture(t);
    const api = await f.openApp();
    const credentials = {
      email: `restricted-${randomUUID()}@example.invalid`,
      password: `password-${randomUUID()}`,
    };
    const account = await f.credentials.auth.createAccount(credentials);
    const principal = f.credentials.auth.principalSeed(account).principal;
    const roleId = `rol_${randomUUID()}`;
    await f.state.seedNativeIAM({
      identities: [principal],
      groups: [],
      memberships: [],
      restrictions: [],
      roles: [
        {
          id: roleId,
          namespaceId: f.namespace.id,
          permissions: [{ action: "deploy", resourceKind: "agent" }],
        },
      ],
      bindings: [
        {
          id: `bnd_${randomUUID()}`,
          subjectKind: "identity",
          subjectId: principal.id,
          roleId,
          namespaceId: f.namespace.id,
          resourceKind: "agent",
          resourceId: f.agent.id,
        },
      ],
    });
    const session = await signInToControllerApp(api.app, credentials);
    const before = await f.snapshot();
    const denied = await api.app.inject({
      method: "POST",
      url: `/namespaces/${f.namespace.id}/agents/${f.agent.id}/deploy`,
      headers: { host: "127.0.0.1", origin: "http://127.0.0.1", cookie: session.cookie },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(
      (await api.request()).statusCode,
      202,
      "the same ready owner has a valid authorized positive control",
    );
  },
);

test(
  "caught canonical validation errors cannot commit a partial PostgreSQL admission",
  options,
  async (t) => {
    const f = await fixture(t);
    await f.deploy(f.context());
    const before = await f.snapshot();
    const admission = createRuntimeAdmissionContext(f.installation.id, "foreign-actor");
    await assert.rejects(
      f.controller.transact(async () => {
        await assert.rejects(f.deploy(admission));
        return "caught";
      }),
    );
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(
      await f.state.read((view) =>
        view.runtimeAssignments.findRuntimeIntent(f.scope, admission.transitionRef),
      ),
      undefined,
    );
    const foreign = new OpenClawController(
      { ...f.installation, id: `ins_${randomUUID()}` },
      { state: f.state },
    );
    const retained = await f.state.read((view) =>
      view.runtimeAssignments.findRuntimeIntentHead(f.scope),
    );
    await assert.rejects(
      foreign.recoverDeployAgent(f.actor.id, f.scope, {
        transitionRef: retained.transitionRef,
        requestId: retained.requestId,
      }),
      DependencyUnavailableError,
    );
  },
);

test(
  "PostgreSQL composite association constraints reject same-Agent wrong-revision, wrong-owner, malformed and namespace work",
  options,
  async (t) => {
    const f = await fixture(t);
    const aContext = f.context();
    const a = await f.deploy(aContext);
    const bContext = f.context();
    const b = await f.deploy(bContext);
    const queue = new PostgresWorkQueue(f.pool);
    const base = {
      namespaceId: f.namespace.id,
      agentId: f.agent.id,
      revisionId: a.id,
      actorId: f.actor.id,
      runtimeTransitionRef: aContext.transitionRef,
      lifecycleGeneration: 1,
    };
    for (const patch of [
      { revisionId: b.id },
      { agentId: "foreign-agent" },
      { namespaceId: "foreign-namespace" },
      { runtimeTransitionRef: bContext.transitionRef },
      { lifecycleGeneration: 2 },
      { lifecycleGeneration: 0 },
      { lifecycleGeneration: "9007199254740992" },
      { runtimeTransitionRef: undefined },
      { actorId: "foreign-actor" },
    ])
      await assert.rejects(
        queue.enqueue({ ...base, idempotencyKey: `association-invalid:${randomUUID()}`, ...patch }),
      );
    await assert.rejects(
      queue.enqueue({
        idempotencyKey: `namespace-invalid:${randomUUID()}`,
        namespaceId: f.namespace.id,
        namespaceTarget: "ready",
        actorId: f.actor.id,
        runtimeTransitionRef: aContext.transitionRef,
        lifecycleGeneration: 1,
      }),
    );
    assert.deepEqual(await f.snapshot(), {
      revisions: 2,
      intents: 2,
      admissions: 2,
      work: 2,
      audits: 2,
    });
  },
);

test(
  "an unavailable real admission lookup retries the worker before bindAgent or preparation",
  options,
  async (t) => {
    if (!migratorUrl)
      return t.skip(
        "Set OCC_RUNTIME_ADMISSION_MIGRATOR_DATABASE_URL for a scoped real lookup permission fault.",
      );
    const f = await fixture(t);
    const revision = await f.deploy(f.context());
    const effects = [];
    const migrator = new pg.Pool({ connectionString: migratorUrl });
    const workerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const worker = createControllerWorker({
      pool: workerPool,
      pollIntervalMs: 10,
      leaseDurationMs: 3000,
      computeDriver: {
        ...f.compute,
        async bindAgent() {
          effects.push("bindAgent");
        },
        async prepareRevision(candidate) {
          effects.push("prepareRevision");
          return f.compute.prepareRevision(candidate);
        },
      },
    });
    try {
      // This disposable database loses the actual required read permission. Restore
      // it after observing retry so the positive control can execute normally.
      await migrator.query("REVOKE SELECT ON occ.agent_revision_runtime_admissions FROM occ_app");
      await worker.start();
      await waitFor("required admission lookup retry", async () => {
        const rows = await f.pool.query(
          "SELECT state,attempt_count FROM occ.controller_work WHERE revision_id=$1",
          [revision.id],
        );
        return rows.rows[0]?.attempt_count > 0 && rows.rows[0].state === "queued"
          ? true
          : undefined;
      });
      assert.deepEqual(effects, []);
      await migrator.query("GRANT SELECT ON occ.agent_revision_runtime_admissions TO occ_app");
      await f.pool.query(
        "UPDATE occ.controller_work SET available_at=clock_timestamp() WHERE revision_id=$1",
        [revision.id],
      );
      await waitFor("lookup recovery positive control", async () => {
        const rows = await f.pool.query(
          "SELECT state FROM occ.controller_work WHERE revision_id=$1",
          [revision.id],
        );
        return rows.rows[0]?.state === "succeeded" ? true : undefined;
      });
      assert.ok(effects.includes("bindAgent"));
    } finally {
      await migrator.query("GRANT SELECT ON occ.agent_revision_runtime_admissions TO occ_app");
      await worker.stop();
      await migrator.end();
    }
  },
);

test(
  "retained admission with inaccessible exact intent history fails before any Compute call",
  options,
  async (t) => {
    if (!migratorUrl)
      return t.skip(
        "Set OCC_RUNTIME_ADMISSION_MIGRATOR_DATABASE_URL for a scoped real history-visibility fault.",
      );
    const f = await fixture(t);
    const context = f.context();
    const revision = await f.deploy(context);
    const migrator = new pg.Pool({ connectionString: migratorUrl });
    const effects = [];
    const worker = createControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl, max: 4 }),
      pollIntervalMs: 10,
      leaseDurationMs: 3000,
      computeDriver: {
        ...f.compute,
        async bindAgent() {
          effects.push("bindAgent");
        },
        async prepareRevision(candidate) {
          effects.push("prepareRevision");
          return f.compute.prepareRevision(candidate);
        },
      },
    });
    const policy = `admission_history_fault_${randomUUID().replaceAll("-", "")}`;
    try {
      // Preserve immutable rows and foreign keys. A disposable database policy
      // hides this exact retained history row from the limited application role.
      const flags = await migrator.query(
        "SELECT relrowsecurity FROM pg_class WHERE oid='occ.agent_runtime_intents'::regclass",
      );
      assert.equal(flags.rows[0].relrowsecurity, false);
      await migrator.query(
        `CREATE POLICY ${policy} ON occ.agent_runtime_intents USING (transition_ref <> '${context.transitionRef}')`,
      );
      await migrator.query("ALTER TABLE occ.agent_runtime_intents ENABLE ROW LEVEL SECURITY");
      await worker.start();
      await workState(f.pool, revision.id, "failed_permanent");
      assert.deepEqual(effects, []);
      const reason = await f.pool.query(
        "SELECT details FROM occ.audit_events WHERE resource_id=$1 AND details->>'reasonCode'='INVALID_RUNTIME_ADMISSION'",
        [revision.id],
      );
      assert.ok(reason.rowCount > 0);
    } finally {
      await worker.stop();
      await migrator.query("ALTER TABLE occ.agent_runtime_intents DISABLE ROW LEVEL SECURITY");
      await migrator.query(`DROP POLICY IF EXISTS ${policy} ON occ.agent_runtime_intents`);
      await migrator.end();
    }
  },
);

test(
  "genuinely historical revision and maintenance retain both-null work without synthesizing intent",
  options,
  async (t) => {
    const f = await fixture(t);
    // Repository seeding models a historical immutable revision from before runtime
    // admission associations existed. New deployments elsewhere use canonical OCC.
    const revision = {
      id: `rev_${randomUUID()}`,
      namespaceId: f.namespace.id,
      agentId: f.agent.id,
      revision: 1,
      providerId: null,
      configurationId: f.configuration.id,
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: admitLoggingConfiguration(f.configuration.values, "info"),
      harness: { ...resolveApprovedHarness("openclaw", "embedded"), mode: "embedded" },
      compute: { id: f.compute.id, implementation: f.compute.implementation },
      servicePrincipalId: f.agent.servicePrincipalId,
      createdAt: new Date().toISOString(),
    };
    const original = {
      idempotencyKey: `agent_revision:${revision.id}:reconcile`,
      namespaceId: f.namespace.id,
      agentId: f.agent.id,
      revisionId: revision.id,
      actorId: f.actor.id,
    };
    await f.state.transactWithQueue(async (unit, queue) => {
      await unit.revisions.createRevision(revision);
      await queue.enqueue(original);
    });
    const worker = createControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl, max: 4 }),
      computeDriver: { ...f.compute, maintenanceIntervalMs: 60 },
      pollIntervalMs: 10,
      leaseDurationMs: 3000,
    });
    try {
      await worker.start();
      await workState(f.pool, revision.id, "succeeded");
      await waitFor("historical maintenance success", async () => {
        const found = await f.pool.query(
          "SELECT idempotency_key FROM occ.controller_work WHERE revision_id=$1 AND idempotency_key LIKE '%:maintenance:%' AND state='succeeded'",
          [revision.id],
        );
        return found.rowCount > 0 ? true : undefined;
      });
    } finally {
      await worker.stop();
    }
    const records = await f.pool.query(
      "SELECT runtime_transition_ref,lifecycle_generation FROM occ.controller_work WHERE revision_id=$1",
      [revision.id],
    );
    assert.ok(records.rowCount > 1);
    assert.ok(
      records.rows.every(
        (row) => row.runtime_transition_ref === null && row.lifecycle_generation === null,
      ),
    );
    const queue = new PostgresWorkQueue(f.pool);
    await assert.rejects(
      queue.enqueue({ ...original, runtimeTransitionRef: randomUUID(), lifecycleGeneration: 1 }),
    );
    assert.equal(
      await f.state.read((view) => view.runtimeAssignments.findRuntimeIntentHead(f.scope)),
      undefined,
    );
  },
);

test(
  "actual bodyless authenticated PostgreSQL deploy commits one exact admission and unchanged 202 envelope",
  options,
  async (t) => {
    const f = await fixture(t);
    const api = await f.openApp();
    const before = await f.snapshot();
    const body = await api.request({
      transitionRef: randomUUID(),
      lifecycleGeneration: 99,
      actorId: "foreign",
    });
    assert.equal(body.statusCode, 400);
    assert.deepEqual(await f.snapshot(), before);
    const response = await api.request();
    assert.equal(response.statusCode, 202, response.body);
    const payload = response.json();
    assert.deepEqual(Object.keys(payload).sort(), ["data", "meta"]);
    assert.match(payload.meta.requestId, /^req_/);
    assert.equal(Object.hasOwn(payload.data, "runtimeTransitionRef"), false);
    assert.equal(Object.hasOwn(payload.data, "lifecycleGeneration"), false);
    assert.deepEqual(await f.snapshot(), {
      revisions: 1,
      intents: 1,
      admissions: 1,
      work: 1,
      audits: 1,
    });
    const proof = await f.pool.query(
      `SELECT admission.*, intent.actor_id, intent.request_id, work.state
    FROM occ.agent_revision_runtime_admissions admission JOIN occ.agent_runtime_intents intent ON intent.transition_ref=admission.runtime_transition_ref
    JOIN occ.controller_work work ON work.idempotency_key='agent_revision:'||admission.revision_id||':reconcile'
    WHERE admission.namespace_id=$1 AND admission.agent_id=$2 AND admission.revision_id=$3`,
      [f.scope.namespaceId, f.scope.agentId, payload.data.id],
    );
    assert.equal(proof.rowCount, 1);
    assert.equal(proof.rows[0].request_id, payload.meta.requestId);
    assert.equal(proof.rows[0].actor_id, f.actor.id);
    assert.equal(proof.rows[0].state, "queued");
  },
);

test(
  "real deploy transactions serialize, preserve A/edit/B, and recover retained original work after terminal outcomes and restart",
  options,
  async (t) => {
    const f = await fixture(t);
    const contexts = [f.context(), f.context()];
    const started = performance.now();
    const revisions = await Promise.all(contexts.map(f.deploy));
    t.diagnostic(
      JSON.stringify({
        scenario: "two-concurrent-deploys",
        wallMs: performance.now() - started,
        historyBefore: 0,
      }),
    );
    assert.equal(new Set(revisions.map((revision) => revision.id)).size, 2);
    const history = await f.state.read((view) =>
      view.revisions.listRevisions(f.scope.namespaceId, f.scope.agentId),
    );
    assert.deepEqual(
      history.map((revision) => revision.revision),
      [1, 2],
    );
    const a = history[0];
    await f.controller.updateConfiguration(f.actor.id, {
      namespaceId: f.scope.namespaceId,
      configurationId: f.configuration.id,
      values: { model: "gpt-edited" },
    });
    const b = await f.deploy(f.context());
    assert.equal(a.configuration.model, "gpt-test");
    assert.equal(b.configuration.model, "gpt-edited");
    const queue = new PostgresWorkQueue(f.pool);
    for (const outcome of ["succeeded", "failed_permanent", "succeeded"]) {
      const claim = await queue.claim();
      assert.ok(claim);
      assert.equal(claim.namespaceId, f.scope.namespaceId);
      assert.equal(claim.idempotencyKey, `agent_revision:${claim.revisionId}:reconcile`);
      assert.ok([...revisions, b].some((revision) => revision.id === claim.revisionId));
      if (outcome === "succeeded") await queue.complete(claim);
      else await queue.fail(claim, { code: "INJECTED_TERMINAL_TEST" });
    }
    const restartedPool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const recovered = f.controllerFor(new PostgresPlatformState(restartedPool)).controller;
      for (let i = 0; i < contexts.length; i++) {
        assert.deepEqual(
          await recovered.recoverDeployAgent(f.actor.id, f.scope, contexts[i]),
          revisions[i],
        );
      }
      await assert.rejects(
        recovered.recoverDeployAgent("foreign-actor", f.scope, contexts[0]),
        DependencyUnavailableError,
      );
      await assert.rejects(
        recovered.recoverDeployAgent(f.actor.id, f.scope, {
          ...contexts[0],
          requestId: "wrong-request",
        }),
        DependencyUnavailableError,
      );
    } finally {
      await restartedPool.end();
    }
    assert.deepEqual(await f.snapshot(), {
      revisions: 3,
      intents: 3,
      admissions: 3,
      work: 3,
      audits: 3,
    });
  },
);

for (const desiredMode of ["disabled", "stopped"])
  test(`PostgreSQL deploy refuses ${desiredMode} without partial admission`, options, async (t) => {
    const f = await fixture(t);
    const first = await f.deploy(f.context());
    await f.state.transact((unit) =>
      unit.runtimeAssignments.advanceRuntimeIntent(
        f.scope,
        1,
        { desiredMode, revisionId: first.id },
        randomUUID(),
        { actorId: f.actor.id, requestId: `seed-${desiredMode}` },
      ),
    );
    const before = await f.snapshot();
    await assert.rejects(f.deploy(f.context()), ResourceConflictError);
    assert.deepEqual(await f.snapshot(), before);
  });

test("real audit uniqueness failure rolls back the complete admission unit", options, async (t) => {
  const f = await fixture(t);
  const auditId = `aud_${randomUUID()}`;
  const factory = new AuditEventFactory({ idGenerator: () => auditId });
  await f.deploy(f.context({ factory }));
  const before = await f.snapshot();
  const rejected = f.context({ factory });
  await assert.rejects(f.deploy(rejected), ResourceConflictError);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(
    await f.state.read((view) =>
      view.runtimeAssignments.findRuntimeIntent(f.scope, rejected.transitionRef),
    ),
    undefined,
  );
});

test(
  "real original-work constraint failure rolls back revision, head, intent, and successful audit",
  options,
  async (t) => {
    if (!migratorUrl)
      return t.skip(
        "Set OCC_RUNTIME_ADMISSION_MIGRATOR_DATABASE_URL for the scoped queue-insert fault.",
      );
    const f = await fixture(t);
    const admission = f.context();
    const before = await f.snapshot();
    const migrator = new pg.Pool({ connectionString: migratorUrl });
    const constraint = `admission_fault_${randomUUID().replaceAll("-", "")}`;
    try {
      // A scoped real database constraint fails this exact enqueue; no OCC callback is replaced.
      await migrator.query(
        `ALTER TABLE occ.controller_work ADD CONSTRAINT ${constraint} CHECK (runtime_transition_ref IS DISTINCT FROM '${admission.transitionRef}')`,
      );
      await assert.rejects(f.deploy(admission));
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(
        await f.state.read((view) =>
          view.runtimeAssignments.findRuntimeIntent(f.scope, admission.transitionRef),
        ),
        undefined,
      );
    } finally {
      await migrator.query(
        `ALTER TABLE occ.controller_work DROP CONSTRAINT IF EXISTS ${constraint}`,
      );
      await migrator.end();
    }
  },
);

test(
  "exact paired queue identity survives retry, defer, stale recovery, terminal replay and fresh queue instances",
  options,
  async (t) => {
    const f = await fixture(t);
    const admission = f.context();
    const revision = await f.deploy(admission);
    const original = {
      idempotencyKey: `agent_revision:${revision.id}:reconcile`,
      namespaceId: f.scope.namespaceId,
      agentId: f.scope.agentId,
      revisionId: revision.id,
      actorId: f.actor.id,
      runtimeTransitionRef: admission.transitionRef,
      lifecycleGeneration: 1,
    };
    const queue = new PostgresWorkQueue(f.pool, { leaseDurationMs: 150, maxAttempts: 10 });
    const assertPair = (work) => {
      assert.equal(work.idempotencyKey, original.idempotencyKey);
      assert.equal(work.revisionId, revision.id);
      assert.equal(work.runtimeTransitionRef, admission.transitionRef);
      assert.equal(work.lifecycleGeneration, 1);
    };
    let claim = await queue.claim();
    assertPair(claim);
    assertPair(await queue.heartbeat(claim));
    await queue.defer(claim, { code: "WAIT" });
    await f.pool.query(
      "UPDATE occ.controller_work SET available_at=clock_timestamp() WHERE idempotency_key=$1",
      [original.idempotencyKey],
    );
    claim = await queue.claim();
    assertPair(claim);
    await queue.retry(claim, { code: "RETRY" });
    await f.pool.query(
      "UPDATE occ.controller_work SET available_at=clock_timestamp() WHERE idempotency_key=$1",
      [original.idempotencyKey],
    );
    claim = await queue.claim();
    assertPair(claim);
    await delay(180);
    await queue.recoverStale();
    await f.pool.query(
      "UPDATE occ.controller_work SET available_at=clock_timestamp() WHERE idempotency_key=$1",
      [original.idempotencyKey],
    );
    claim = await new PostgresWorkQueue(f.pool).claim();
    assertPair(claim);
    await queue.complete(claim);
    const replayed = await queue.enqueue(original);
    assertPair(replayed);
    assert.equal(replayed.state, "succeeded");
    for (const changed of [
      { ...original, runtimeTransitionRef: undefined, lifecycleGeneration: undefined },
      { ...original, runtimeTransitionRef: randomUUID() },
      { ...original, lifecycleGeneration: 2 },
    ])
      await assert.rejects(queue.enqueue(changed));
    const half = {
      ...original,
      idempotencyKey: `${original.idempotencyKey}:half`,
      lifecycleGeneration: undefined,
    };
    await assert.rejects(queue.enqueue(half));
    await assert.rejects(
      f.pool.query(
        "UPDATE occ.controller_work SET runtime_transition_ref=NULL,lifecycle_generation=NULL WHERE idempotency_key=$1",
        [original.idempotencyKey],
      ),
      { code: "42501" },
    );
    assert.deepEqual(
      await f.controller.recoverDeployAgent(f.actor.id, f.scope, admission),
      revision,
    );
  },
);

for (const terminal of ["succeeded", "failed_permanent"])
  test(
    `actual lost PostgreSQL COMMIT acknowledgement recovers after ${terminal} and later head advancement`,
    options,
    async (t) => {
      const f = await fixture(t);
      const proxy = await runtimeCommitAckProxy(databaseUrl);
      const faultPool = new pg.Pool({
        connectionString: proxy.url,
        max: 1,
        query_timeout: 5000,
        connectionTimeoutMillis: 5000,
      });
      faultPool.on("error", () => {});
      try {
        const controller = f.controllerFor(new PostgresPlatformState(faultPool)).controller;
        const admission = f.context();
        proxy.arm();
        await assert.rejects(
          controller.deployAgent(f.actor.id, f.scope, resolveApprovedHarness, admission),
          PostgresCommitOutcomeUnknownError,
        );
        assert.equal(proxy.observedCommit, true);
        const queue = new PostgresWorkQueue(f.pool);
        const claim = await queue.claim();
        assert.ok(claim);
        assert.equal(claim.namespaceId, f.namespace.id);
        assert.equal(claim.runtimeTransitionRef, admission.transitionRef);
        assert.equal(claim.idempotencyKey, `agent_revision:${claim.revisionId}:reconcile`);
        if (terminal === "succeeded") await queue.complete(claim);
        else await queue.fail(claim, { code: "TERMINAL_BEFORE_RECOVERY" });
        await f.deploy(f.context());
        const revision = await controller.recoverDeployAgent(f.actor.id, f.scope, admission);
        assert.equal(revision.id, claim.revisionId);
        assert.equal(revision.revision, 1);
        assert.deepEqual(await f.snapshot(), {
          revisions: 2,
          intents: 2,
          admissions: 2,
          work: 2,
          audits: 2,
        });
      } finally {
        await faultPool.end();
        await proxy.close();
      }
    },
  );

test(
  "actual authenticated API resolves a narrowly timed lost admission COMMIT and returns its original 202",
  options,
  async (t) => {
    const f = await fixture(t);
    const proxy = await runtimeCommitAckProxy(databaseUrl);
    const faultPool = new pg.Pool({
      connectionString: proxy.url,
      max: 1,
      query_timeout: 5000,
      connectionTimeoutMillis: 5000,
    });
    faultPool.on("error", () => {});
    try {
      const factory = new AuditEventFactory();
      const api = await f.openApp(new PostgresPlatformState(faultPool), {
        create(input) {
          const event = factory.create(input);
          // Fault injection is at the real transport boundary after this exact admission
          // has built its success event. Earlier auth/quota transactions remain ordinary.
          if (event.action === "openclaw.agents.deploy" && event.outcome === "success") proxy.arm();
          return event;
        },
      });
      const response = await api.request();
      assert.equal(proxy.observedCommit, true);
      assert.equal(response.statusCode, 202, response.body);
      assert.deepEqual(await f.snapshot(), {
        revisions: 1,
        intents: 1,
        admissions: 1,
        work: 1,
        audits: 1,
      });
      await api.app.close();
    } finally {
      await faultPool.end();
      await proxy.close();
    }
  },
);

test(
  "actual revision worker retains original association through successful and failed active maintenance",
  options,
  async (t) => {
    const f = await fixture(t);
    const admission = f.context();
    const revision = await f.deploy(admission);
    const calls = [];
    let unavailable = false;
    const compute = {
      ...f.compute,
      maintenanceIntervalMs: 60,
      async bindAgent(input) {
        calls.push(["bindAgent", input.agent.id]);
      },
      async prepareRevision(candidate) {
        calls.push(["prepareRevision", candidate.id]);
        if (unavailable) throw new Error("test driver observation unavailable");
        return f.compute.prepareRevision(candidate);
      },
    };
    const workerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const worker = createControllerWorker({
      pool: workerPool,
      computeDriver: compute,
      pollIntervalMs: 10,
      leaseDurationMs: 3000,
    });
    try {
      await worker.start();
      await waitFor("successful original work", async () => {
        const rows = await f.pool.query(
          "SELECT state FROM occ.controller_work WHERE idempotency_key=$1",
          [`agent_revision:${revision.id}:reconcile`],
        );
        return rows.rows[0]?.state === "succeeded" ? true : undefined;
      });
      await waitFor("successful active maintenance", async () => {
        const rows = await f.pool.query(
          "SELECT state FROM occ.controller_work WHERE revision_id=$1 AND idempotency_key LIKE '%:maintenance:%' AND state='succeeded'",
          [revision.id],
        );
        return rows.rowCount > 0 ? true : undefined;
      });
      unavailable = true;
      await waitFor("failed active maintenance replacement", async () => {
        const rows = await f.pool.query(
          "SELECT * FROM occ.controller_work WHERE revision_id=$1 AND idempotency_key LIKE '%:maintenance:%'",
          [revision.id],
        );
        return rows.rows.some((row) => row.state === "failed_permanent") && rows.rows.length >= 2
          ? rows.rows
          : undefined;
      });
    } finally {
      await worker.stop();
    }
    const work = await f.pool.query(
      "SELECT runtime_transition_ref,lifecycle_generation FROM occ.controller_work WHERE revision_id=$1",
      [revision.id],
    );
    assert.ok(work.rowCount >= 3);
    assert.ok(calls.some(([kind]) => kind === "bindAgent"));
    assert.ok(
      work.rows.every(
        (row) =>
          row.runtime_transition_ref === admission.transitionRef &&
          Number(row.lifecycle_generation) === 1,
      ),
    );
  },
);

test(
  "admission measurements disclose selected local drivers, history size, lock wait and exact proof read time",
  options,
  async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 20; i++) await f.deploy(f.context());
    const admission = f.context();
    const started = performance.now();
    let lockMs;
    let transactionMs;
    await f.controller.transact(async (unit) => {
      const txStarted = performance.now();
      await unit.namespaces.lockNamespace(f.scope.namespaceId);
      await unit.agents.lockAgent(f.scope.namespaceId, f.scope.agentId);
      lockMs = performance.now() - txStarted;
      await f.deploy(admission);
      transactionMs = performance.now() - txStarted;
    });
    const wallMs = performance.now() - started;
    const readStarted = performance.now();
    const revision = await f.controller.recoverDeployAgent(f.actor.id, f.scope, admission);
    assert.equal(revision.revision, 21);
    t.diagnostic(
      JSON.stringify({
        historyBefore: 20,
        historyAfter: 21,
        compute: f.compute.implementation,
        configuration: "test-memory-storage",
        wallMs,
        lockMs,
        transactionCallbackMs: transactionMs,
        exactRecoveryReadMs: performance.now() - readStarted,
        limitation:
          "Same-Namespace admission locks serialize; local persistence/control-flow timing, no live provider or fleet claim.",
      }),
    );
  },
);
