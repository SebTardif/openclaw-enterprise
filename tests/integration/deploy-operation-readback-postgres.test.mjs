import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  OpenClawController,
  PostgresCommitOutcomeUnknownError,
  PostgresPlatformState,
  PostgresWorkQueue,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";
import { createRuntimeAdmissionContext } from "../fixtures/runtime-admission-context.mjs";
import { createTestAuthPrincipal } from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { cleanupNamespaces, ensureInstallation } from "../helpers/postgres-provider-state.mjs";

// Actual OCC admission, PostgreSQL and Native IAM supply every record and decision.
// The passive Configuration Driver supplies draft bytes; no worker or provider runs.
// This proves the internal accepted-deploy reader, not an HTTP lifecycle protocol,
// account-epoch serialization, runtime status, or live deployment effects.
const databaseUrl = process.env.OCC_DEPLOY_READBACK_TEST_DATABASE_URL;
const options = {
  skip: databaseUrl
    ? false
    : "Set OCC_DEPLOY_READBACK_TEST_DATABASE_URL for dedicated PostgreSQL readback coverage.",
  timeout: 120_000,
};
if (databaseUrl) {
  const target = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  assert.match(target.pathname, /^\/oce_deploy_readback_[a-z0-9_]+$/);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createPool(connectionString = databaseUrl, max = 8) {
  return new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
  });
}

async function fixture(t) {
  const pool = createPool();
  const namespaceIds = [];
  t.after(async () => {
    try {
      // Retain immutable admission/history evidence while retiring only this
      // fixture's queued work. The caller owns disposal of the dedicated database.
      await cleanupNamespaces(pool, namespaceIds);
    } finally {
      await pool.end();
    }
  });
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
  const installation = await ensureInstallation(state, "deploy-readback");
  const actor = (await createTestAuthPrincipal({ installationId: installation.id })).seed.principal;
  const reader = (await createTestAuthPrincipal({ installationId: installation.id })).seed
    .principal;
  const actorRoleId = `rol_${randomUUID()}`;
  const readerRoleId = `rol_${randomUUID()}`;
  const actorBindingId = `bnd_${randomUUID()}`;
  await state.seedNativeIAM({
    identities: [actor, reader],
    groups: [],
    memberships: [],
    restrictions: [],
    roles: [
      {
        id: actorRoleId,
        permissions: [
          ["create", "namespace"],
          ["create", "configuration"],
          ["read", "configuration"],
          ["update", "configuration"],
          ["create", "agent"],
          ["deploy", "agent"],
        ].map(([action, resourceKind]) => ({ action, resourceKind })),
      },
      { id: readerRoleId, permissions: [{ action: "read", resourceKind: "agent" }] },
    ],
    bindings: [
      {
        id: actorBindingId,
        subjectKind: "identity",
        subjectId: actor.id,
        roleId: actorRoleId,
      },
    ],
  });
  const configuration = createTestConfigurationDriver();
  function controllerFor(store = state, owner = installation) {
    const controller = new OpenClawController(owner, { state: store, recordOperations: false });
    // IAM uses normal database connections even when a deployment transaction's
    // transport is faulted. Every permission still comes from actual persisted IAM.
    for (const driver of [
      new NativeIAMDriver(state),
      configuration,
      createDevelopmentComputeDriver(),
    ]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    return controller;
  }
  const controller = controllerFor();
  async function createTarget() {
    const namespace = await controller.createNamespace(actor.id, {
      name: `deploy-readback-${randomUUID()}`,
    });
    namespaceIds.push(namespace.id);
    const draft = await controller.createConfiguration(actor.id, {
      namespaceId: namespace.id,
      kind: "agent",
      values: { model: "gpt-test" },
    });
    const agent = await controller.createAgent(actor.id, {
      namespaceId: namespace.id,
      name: "Readback Agent",
      configurationId: draft.id,
    });
    const readerBindingId = `bnd_${randomUUID()}`;
    await state.transact(async (unit) => {
      await unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready");
      // Provision an exact existing-resource grant; Native IAM, not this fixture,
      // evaluates whether the reader can inspect the accepted operation.
      await state.queryInTransaction(
        unit,
        "INSERT INTO occ.iam_access_bindings (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id) VALUES ($1, $2, $3, $4, 'agent', $5)",
        [readerBindingId, namespace.id, reader.id, readerRoleId, agent.id],
      );
    });
    return {
      scope: { namespaceId: namespace.id, agentId: agent.id },
      draft,
      readerBindingId,
    };
  }
  const target = await createTarget();
  const context = () => createRuntimeAdmissionContext(installation.id, actor.id);
  const deploy = (expectedLifecycleGeneration, admission = context(), selected = controller) =>
    selected.deployment.deployAgent(
      actor.id,
      { ...target.scope, expectedLifecycleGeneration },
      resolveApprovedHarness,
      admission,
    );
  const read = (
    operationRef,
    selected = controller,
    scope = target.scope,
    principalId = reader.id,
  ) => selected.deployment.getAcceptedDeployOperation(principalId, { ...scope, operationRef });
  const intent = (operationRef) =>
    state.read((view) => view.runtimeAssignments.findRuntimeIntent(target.scope, operationRef));
  async function counts() {
    const result = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM occ.agent_revisions WHERE namespace_id = $1) AS revisions,
        (SELECT count(*)::int FROM occ.agent_runtime_intents WHERE namespace_id = $1) AS intents,
        (SELECT count(*)::int FROM occ.agent_revision_runtime_admissions WHERE namespace_id = $1) AS admissions,
        (SELECT count(*)::int FROM occ.controller_work WHERE namespace_id = $1) AS work,
        (SELECT count(*)::int FROM occ.audit_events WHERE namespace_id = $1) AS audits`,
      [target.scope.namespaceId],
    );
    return result.rows[0];
  }
  return {
    pool,
    state,
    installation,
    actor,
    reader,
    actorBindingId,
    controller,
    controllerFor,
    createTarget,
    ...target,
    context,
    deploy,
    read,
    intent,
    counts,
  };
}

function assertOperation(operation, intent, revisionId) {
  assert.deepEqual(operation, {
    operationRef: intent.transitionRef,
    kind: "deploy",
    revisionSource: "saved-draft",
    lifecycleGeneration: intent.generation,
    desiredMode: "running",
    acceptedAt: intent.createdAt,
    requestedRevisionId: revisionId,
  });
  assert.equal(Object.isFrozen(operation), true);
  assert.throws(() => {
    operation.requestedRevisionId = "replacement";
  }, TypeError);
}

test("accepted deploy readback preserves A after draft edits and deploy B", options, async (t) => {
  const f = await fixture(t);
  const first = f.context();
  const revisionA = await f.deploy(null, first);
  const intentA = await f.intent(first.transitionRef);
  await f.controller.updateConfiguration(f.actor.id, {
    namespaceId: f.scope.namespaceId,
    configurationId: f.draft.id,
    values: { model: "gpt-test-after-edit" },
  });
  const second = f.context();
  const revisionB = await f.deploy(1, second);
  assert.notEqual(revisionA.id, revisionB.id);
  assert.notEqual(revisionA.configurationGeneration, revisionB.configurationGeneration);
  const before = await f.counts();
  assertOperation(await f.read(first.transitionRef), intentA, revisionA.id);
  assertOperation(await f.read(first.transitionRef), intentA, revisionA.id);
  assertOperation(
    await f.read(second.transitionRef),
    await f.intent(second.transitionRef),
    revisionB.id,
  );
  assert.deepEqual(await f.counts(), before, "reads create no revision, intent, audit or work");
});

test(
  "accepted deploy readback uses the current exact reader grant, not original actor authority",
  options,
  async (t) => {
    const f = await fixture(t);
    const admission = f.context();
    const revision = await f.deploy(null, admission);
    const iam = new NativeIAMDriver(f.state);
    for (const [action, resource] of [
      ["deploy", { kind: "agent", id: f.scope.agentId, namespaceId: f.scope.namespaceId }],
      ["read", { kind: "agent_revision", id: revision.id, namespaceId: f.scope.namespaceId }],
    ]) {
      assert.equal(
        (await iam.authorize({ principalId: f.reader.id, action, resource })).allowed,
        false,
      );
    }
    // The deployer deliberately has no Agent read grant. Original attribution does
    // not substitute for the reader's separate current permission.
    await assert.rejects(
      f.read(admission.transitionRef, f.controller, f.scope, f.actor.id),
      AuthorizationDeniedError,
    );
    const preservedIAM = await f.state.loadNativeIAMState();
    const resource = { kind: "agent", id: f.scope.agentId, namespaceId: f.scope.namespaceId };
    assert.equal(
      (await iam.authorize({ principalId: f.actor.id, action: "deploy", resource })).allowed,
      true,
    );
    // The application role can append exact deny restrictions, but cannot delete
    // IAM bindings. Revoke current deploy authority without erasing attribution
    // or changing the separate reader's permission.
    const deployRestrictionId = `rst_${randomUUID()}`;
    await f.pool.query(
      "INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id, effect) VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')",
      [deployRestrictionId, f.scope.namespaceId, f.scope.agentId],
    );
    const deployDecision = await iam.authorize({
      principalId: f.actor.id,
      action: "deploy",
      resource,
    });
    assert.equal(deployDecision.allowed, false);
    assert.ok(deployDecision.evidence.restrictionIds.includes(deployRestrictionId));
    assertOperation(
      await f.read(admission.transitionRef),
      await f.intent(admission.transitionRef),
      revision.id,
    );
    const readRestrictionId = `rst_${randomUUID()}`;
    await f.pool.query(
      "INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id, effect) VALUES ($1, $2, 'read', 'agent', $3, 'deny')",
      [readRestrictionId, f.scope.namespaceId, f.scope.agentId],
    );
    await assert.rejects(
      f.read(admission.transitionRef),
      (error) =>
        error instanceof AuthorizationDeniedError &&
        error.evidence?.restrictionIds.includes(readRestrictionId),
    );
    const currentIAM = await f.state.loadNativeIAMState();
    assert.deepEqual(currentIAM.identities, preservedIAM.identities);
    assert.deepEqual(currentIAM.roles, preservedIAM.roles);
    assert.deepEqual(currentIAM.bindings, preservedIAM.bindings);
  },
);

test(
  "accepted deploy readback hides unknown, foreign and unpaired lifecycle locators",
  options,
  async (t) => {
    const f = await fixture(t);
    const admission = f.context();
    const revision = await f.deploy(null, admission);
    const other = await f.createTarget();
    let hiddenMessage;
    await assert.rejects(f.read(randomUUID()), (error) => {
      assert.ok(error instanceof ScopeViolationError);
      hiddenMessage = error.message;
      return true;
    });
    const hidden = (error) =>
      error instanceof ScopeViolationError && error.message === hiddenMessage;
    // This reader is authorized for both Agents, so denial below is the actual
    // retained owner/operation association, not merely absence of a read grant.
    await assert.rejects(f.read(admission.transitionRef, f.controller, other.scope), hidden);
    const foreignController = f.controllerFor(f.state, {
      ...f.installation,
      id: `ins_${randomUUID()}`,
    });
    await assert.rejects(f.read(admission.transitionRef, foreignController), hidden);
    const unpaired = randomUUID();
    await f.state.transact((unit) =>
      unit.runtimeAssignments.advanceRuntimeIntent(
        f.scope,
        1,
        { desiredMode: "running", revisionId: revision.id },
        unpaired,
        { actorId: f.actor.id, requestId: `intent-${randomUUID()}` },
      ),
    );
    await assert.rejects(f.read(unpaired), hidden);
    const stopped = randomUUID();
    await f.state.transact((unit) =>
      unit.runtimeAssignments.advanceRuntimeIntent(
        f.scope,
        2,
        { desiredMode: "stopped", revisionId: revision.id },
        stopped,
        { actorId: f.actor.id, requestId: `intent-${randomUUID()}` },
      ),
    );
    await assert.rejects(f.read(stopped), hidden);
    assertOperation(
      await f.read(admission.transitionRef),
      await f.intent(admission.transitionRef),
      revision.id,
    );
  },
);

test(
  "accepted deploy readback survives succeeded and permanently failed original work",
  options,
  async (t) => {
    const f = await fixture(t);
    const queue = new PostgresWorkQueue(f.pool);
    const accepted = [];
    for (const outcome of ["succeeded", "failed_permanent"]) {
      const admission = f.context();
      const revision = await f.deploy(accepted.length === 0 ? null : accepted.length, admission);
      const claim = await queue.claim();
      assert.equal(claim?.namespaceId, f.scope.namespaceId);
      assert.equal(claim.idempotencyKey, `agent_revision:${revision.id}:reconcile`);
      assert.equal(claim.runtimeTransitionRef, admission.transitionRef);
      // Queue completion here proves only retention of admission evidence. No
      // worker, serving observation or successful runtime effect is asserted.
      if (outcome === "succeeded") await queue.complete(claim);
      else await queue.fail(claim, { code: "READBACK_TERMINAL_TEST" });
      assert.equal(
        (
          await f.pool.query("SELECT state FROM occ.controller_work WHERE idempotency_key = $1", [
            claim.idempotencyKey,
          ])
        ).rows[0].state,
        outcome,
      );
      accepted.push({ admission, revision, intent: await f.intent(admission.transitionRef) });
    }
    for (const entry of accepted) {
      assertOperation(await f.read(entry.admission.transitionRef), entry.intent, entry.revision.id);
    }
  },
);

test(
  "accepted deploy readback rejects ambient mutations and cannot see another uncommitted admission",
  options,
  async (t) => {
    const f = await fixture(t);
    const readerPool = createPool(databaseUrl, 3);
    const separateReader = f.controllerFor(new PostgresPlatformState(readerPool));
    const admission = f.context();
    const written = deferred();
    const release = deferred();
    const pending = f.controller.transact(async (unit) => {
      const revision = await f.deploy(null, admission);
      await assert.rejects(f.read(admission.transitionRef), DependencyUnavailableError);
      const visible = await f.state.queryInTransaction(
        unit,
        "SELECT count(*)::int AS count FROM occ.agent_revision_runtime_admissions WHERE namespace_id = $1 AND runtime_transition_ref = $2",
        [f.scope.namespaceId, admission.transitionRef],
      );
      assert.equal(visible.rows[0].count, 1, "the admitting transaction sees its actual writes");
      written.resolve(revision);
      await release.promise;
      return revision;
    });
    const settled = pending.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    let result;
    try {
      await Promise.race([
        written.promise,
        settled.then((outcome) => {
          if (outcome.status === "rejected") throw outcome.reason;
          assert.fail("The admitting transaction finished before releasing its commit gate.");
        }),
      ]);
      await assert.rejects(f.read(admission.transitionRef, separateReader), ScopeViolationError);
    } finally {
      release.resolve();
      result = await settled;
      await readerPool.end();
    }
    assert.equal(result.status, "fulfilled", result.reason?.message);
    assertOperation(
      await f.read(admission.transitionRef),
      await f.intent(admission.transitionRef),
      result.value.id,
    );
  },
);

test(
  "accepted deploy readback has no result for an admission rolled back by its outer transaction",
  options,
  async (t) => {
    const f = await fixture(t);
    const admission = f.context();
    const before = await f.counts();
    const rollback = new Error("READBACK_ROLLBACK_TEST");
    await assert.rejects(
      f.controller.transact(async () => {
        await f.deploy(null, admission);
        throw rollback;
      }),
      (error) => error === rollback,
    );
    await assert.rejects(f.read(admission.transitionRef), ScopeViolationError);
    assert.deepEqual(await f.counts(), before);
  },
);

test(
  "accepted deploy readback confirms real lost-COMMIT acknowledgement after later head advancement",
  options,
  async (t) => {
    const f = await fixture(t);
    const proxy = await runtimeCommitAckProxy(databaseUrl);
    const faultPool = createPool(proxy.url, 1);
    faultPool.on("error", () => {});
    try {
      const faultController = f.controllerFor(new PostgresPlatformState(faultPool));
      const admission = f.context();
      proxy.arm();
      await assert.rejects(
        f.deploy(null, admission, faultController),
        PostgresCommitOutcomeUnknownError,
      );
      assert.equal(
        proxy.observedCommit,
        true,
        "the proxy observed real PostgreSQL COMMIT completion",
      );
      const original = await f.intent(admission.transitionRef);
      assert.ok(original);
      await f.deploy(1);
      const before = await f.counts();
      assertOperation(await f.read(admission.transitionRef), original, original.revisionId);
      assert.deepEqual(await f.counts(), before);
    } finally {
      await faultPool.end();
      await proxy.close();
    }
  },
);
