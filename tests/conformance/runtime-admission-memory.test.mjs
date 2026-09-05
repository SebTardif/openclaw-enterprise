import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  DependencyUnavailableError,
  InMemoryPlatformState,
  OpenClawController,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createRuntimeAdmissionContext } from "../fixtures/runtime-admission-context.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";

async function fixture() {
  const installation = {
    id: `installation-${randomUUID()}`,
    name: "Runtime admission",
    createdAt: new Date().toISOString(),
  };
  const actorId = "runtime-admission-administrator";
  const state = new InMemoryPlatformState();
  const controller = new OpenClawController(installation, { state, recordOperations: false });
  const iam = new NativeIAMDriver(
    {
      loadNativeIAMState: async () => ({
        identities: [
          { id: actorId, kind: "principal", issuer: "runtime-admission", subject: actorId },
        ],
        groups: [],
        memberships: [],
        restrictions: [],
        roles: [
          {
            id: "admission-role",
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
        bindings: [
          {
            id: "admission-binding",
            subjectKind: "identity",
            subjectId: actorId,
            roleId: "admission-role",
          },
        ],
      }),
    },
    { id: "admission-iam" },
  );
  for (const driver of [iam, createTestConfigurationDriver(), createDevelopmentComputeDriver()]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  const namespace = await controller.createNamespace(actorId, { name: "Admission tenant" });
  const configuration = await controller.createConfiguration(actorId, {
    namespaceId: namespace.id,
    kind: "agent",
    values: { model: "gpt-test" },
  });
  const agent = await controller.createAgent(actorId, {
    namespaceId: namespace.id,
    name: "Admission Agent",
    configurationId: configuration.id,
  });
  await state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const scope = { namespaceId: namespace.id, agentId: agent.id };
  const context = (options) => createRuntimeAdmissionContext(installation.id, actorId, options);
  const deploy = (admission) =>
    controller.deployAgent(actorId, scope, resolveApprovedHarness, admission);
  const snapshot = () =>
    state.transact(async (unit) => ({
      revisions: await unit.revisions.listRevisions(namespace.id, agent.id),
      head: await unit.runtimeAssignments.findRuntimeIntentHead(scope),
      operations: await unit.operations.list(),
      audit: await unit.audit.list(),
    }));
  return {
    installation,
    actorId,
    state,
    controller,
    configuration,
    scope,
    context,
    deploy,
    snapshot,
  };
}

test("canonical memory deploy requires caller correlation and records exact work and one audit even with recording disabled", async () => {
  const f = await fixture();
  await assert.rejects(
    f.controller.deployAgent(f.actorId, f.scope, resolveApprovedHarness),
    ScopeViolationError,
  );
  assert.equal((await f.snapshot()).revisions.length, 0);
  const context = f.context();
  // The caller retains the locator before entering its explicit outer transaction.
  const revision = await f.controller.transact(() => f.deploy(context));
  const saved = await f.snapshot();
  assert.equal(saved.revisions.length, 1);
  assert.equal(saved.head.generation, 1);
  assert.equal(saved.head.transitionRef, context.transitionRef);
  assert.equal(saved.head.revisionId, revision.id);
  assert.deepEqual(saved.operations, [
    {
      kind: "agent_revision",
      action: "reconcile",
      namespaceId: f.scope.namespaceId,
      resourceId: revision.id,
      actorId: f.actorId,
      runtimeTransitionRef: context.transitionRef,
      lifecycleGeneration: 1,
    },
  ]);
  const audit = saved.audit.filter((event) => event.action === "openclaw.agents.deploy");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].resource.id, revision.id);
  assert.equal(audit[0].requestId, context.requestId);
  assert.deepEqual(await f.controller.recoverDeployAgent(f.actorId, f.scope, context), revision);
});

test("A/edit/B retains both immutable admissions and exact older recovery after head advancement", async () => {
  const f = await fixture();
  const aContext = f.context();
  const a = await f.deploy(aContext);
  await f.controller.updateConfiguration(f.actorId, {
    namespaceId: f.scope.namespaceId,
    configurationId: f.configuration.id,
    values: { model: "gpt-edited" },
  });
  const bContext = f.context();
  const b = await f.deploy(bContext);
  const saved = await f.snapshot();
  assert.equal(saved.head.generation, 2);
  assert.equal(saved.head.revisionId, b.id);
  assert.equal(a.configuration.model, "gpt-test");
  assert.equal(b.configuration.model, "gpt-edited");
  assert.deepEqual(saved.revisions, [a, b]);
  assert.deepEqual(
    saved.operations.map((item) => [
      item.resourceId,
      item.runtimeTransitionRef,
      item.lifecycleGeneration,
    ]),
    [
      [a.id, aContext.transitionRef, 1],
      [b.id, bContext.transitionRef, 2],
    ],
  );
  assert.deepEqual(await f.controller.recoverDeployAgent(f.actorId, f.scope, aContext), a);
  await assert.rejects(
    f.controller.recoverDeployAgent("foreign-actor", f.scope, aContext),
    DependencyUnavailableError,
  );
  await assert.rejects(
    f.controller.recoverDeployAgent(f.actorId, f.scope, {
      ...aContext,
      requestId: "foreign-request",
    }),
    DependencyUnavailableError,
  );
  await assert.rejects(
    f.controller.recoverDeployAgent(f.actorId, { ...f.scope, agentId: "foreign-agent" }, aContext),
    DependencyUnavailableError,
  );
});

test("duplicate audit identity rolls back revision, intent head, original work, and retained admission", async () => {
  const f = await fixture();
  const factory = new AuditEventFactory({ idGenerator: () => "duplicate-admission-audit" });
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
  await assert.rejects(
    f.controller.recoverDeployAgent(f.actorId, f.scope, rejected),
    DependencyUnavailableError,
  );
});

for (const desiredMode of ["disabled", "stopped"]) {
  test(`deploy rejects stored ${desiredMode} intent without implicitly resuming or partially admitting`, async () => {
    const f = await fixture();
    const revision = await f.deploy(f.context());
    await f.state.transact((unit) =>
      unit.runtimeAssignments.advanceRuntimeIntent(
        f.scope,
        1,
        { desiredMode, revisionId: revision.id },
        randomUUID(),
        { actorId: f.actorId, requestId: `seed-${desiredMode}` },
      ),
    );
    const before = await f.snapshot();
    await assert.rejects(f.deploy(f.context()), ResourceConflictError);
    assert.deepEqual(await f.snapshot(), before);
  });
}

test("memory original-work replay preserves its exact immutable pair and rejects removal or reassignment", async () => {
  const f = await fixture();
  await f.deploy(f.context());
  const before = await f.snapshot();
  const operation = before.operations[0];
  await f.state.transact((unit) => unit.operations.append(operation));
  for (const changed of [
    { ...operation, runtimeTransitionRef: undefined, lifecycleGeneration: undefined },
    { ...operation, runtimeTransitionRef: randomUUID() },
    { ...operation, lifecycleGeneration: 2 },
    { ...operation, actorId: "another-actor" },
  ])
    await assert.rejects(
      f.state.transact((unit) => unit.operations.append(changed)),
      ResourceConflictError,
    );
  assert.deepEqual(await f.snapshot(), before);
});

test("memory admission refuses an audit attributed to another actor and leaves no accepted revision", async () => {
  const f = await fixture();
  const before = await f.snapshot();
  const foreign = createRuntimeAdmissionContext(f.installation.id, "foreign-actor");
  await assert.rejects(f.deploy(foreign), ScopeViolationError);
  assert.deepEqual(await f.snapshot(), before);
});

test("fresh exact admission recovery rejects another controller Installation over the same store", async () => {
  const f = await fixture();
  const context = f.context();
  await f.deploy(context);
  const foreign = new OpenClawController(
    { ...f.installation, id: `installation-${randomUUID()}` },
    { state: f.state },
  );
  await assert.rejects(
    foreign.recoverDeployAgent(f.actorId, f.scope, context),
    DependencyUnavailableError,
  );
});

test("caught attribution, audit uniqueness, and transition failures roll back the outer memory transaction", async () => {
  const f = await fixture();
  const factory = new AuditEventFactory({ idGenerator: () => "caught-admission-audit" });
  await f.deploy(f.context({ factory }));
  const before = await f.snapshot();
  for (const context of [
    createRuntimeAdmissionContext(f.installation.id, "wrong-actor"),
    f.context({ factory }),
    f.context({ transitionRef: before.head.transitionRef }),
  ]) {
    // Catching a real validation, uniqueness, or transition failure must not
    // convert a rejected deployment into a partial revision/head commit.
    await assert.rejects(
      f.controller.transact(async () => {
        await assert.rejects(f.deploy(context));
        return "the caller caught the rejection";
      }),
    );
    assert.deepEqual(await f.snapshot(), before);
  }
});
