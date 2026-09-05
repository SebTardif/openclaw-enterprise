import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
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
  let revoked = false;
  const iam = new NativeIAMDriver(
    {
      loadNativeIAMState: async () => ({
        identities: revoked
          ? []
          : [{ id: actorId, kind: "principal", issuer: "runtime-admission", subject: actorId }],
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
  const deploy = (expectedLifecycleGeneration, admission = context()) =>
    controller.deployAgent(
      actorId,
      { ...scope, expectedLifecycleGeneration },
      resolveApprovedHarness,
      admission,
    );
  const snapshot = () =>
    state.transact(async (unit) => ({
      revisions: await unit.revisions.listRevisions(namespace.id, agent.id),
      head: await unit.runtimeAssignments.findRuntimeIntentHead(scope),
      operations: await unit.operations.list(),
      audit: await unit.audit.list(),
    }));
  return {
    revoke: () => {
      revoked = true;
    },
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

// This exercises trusted-domain admission CAS under the existing IAM checks.
// It does not establish account-epoch or semantic lifecycle-role authorization.
test("explicit null admits first revision; A/edit/B preserves immutable snapshots and old recovery", async () => {
  const f = await fixture();
  const aContext = f.context();
  const a = await f.deploy(null, aContext);
  const first = await f.snapshot();
  await f.controller.updateConfiguration(f.actorId, {
    namespaceId: f.scope.namespaceId,
    configurationId: f.configuration.id,
    values: { model: "gpt-edited" },
  });
  assert.deepEqual(await f.snapshot(), first);
  const b = await f.deploy(1);
  const saved = await f.snapshot();
  assert.equal(saved.head.generation, 2);
  assert.equal(a.configuration.model, "gpt-test");
  assert.equal(b.configuration.model, "gpt-edited");
  assert.equal(a.configurationGeneration, 1);
  assert.equal(b.configurationGeneration, 2);
  assert.deepEqual(saved.revisions, [a, b]);
  assert.deepEqual(
    await f.controller.recoverDeployAgent(
      f.actorId,
      { ...f.scope, expectedLifecycleGeneration: null },
      aContext,
    ),
    a,
  );
});

test("same expected generation admits one contender and leaves no loser residue", async () => {
  const f = await fixture();
  for (const expected of [null, 1]) {
    const results = await Promise.allSettled([f.deploy(expected), f.deploy(expected)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected.reason instanceof ResourceConflictError);
    assert.equal(rejected.reason.message, "The lifecycle generation does not match.");
    const saved = await f.snapshot();
    const generation = expected === null ? 1 : expected + 1;
    assert.equal(saved.revisions.length, generation);
    assert.equal(saved.head.generation, generation);
    assert.equal(saved.operations.length, generation);
    assert.equal(
      saved.audit.filter((event) => event.action === "openclaw.agents.deploy").length,
      generation,
    );
  }
});

test("omission preserves the trusted bodyless bridge but explicit undefined and invalid values reject", async () => {
  const f = await fixture();
  for (const expected of [undefined, 0, -1, 0.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.deploy(expected), ScopeViolationError);
    assert.equal((await f.snapshot()).revisions.length, 0);
  }
  await f.controller.deployAgent(f.actorId, f.scope, resolveApprovedHarness, f.context());
  await f.controller.deployAgent(f.actorId, f.scope, resolveApprovedHarness, f.context());
  assert.equal((await f.snapshot()).head.generation, 2);
  for (const expected of [null, 1, 3]) {
    const before = await f.snapshot();
    await assert.rejects(f.deploy(expected), {
      name: "ResourceConflictError",
      message: "The lifecycle generation does not match.",
    });
    assert.deepEqual(await f.snapshot(), before);
  }
});

for (const desiredMode of ["disabled", "stopped"]) {
  test(`matching CAS cannot implicitly resume ${desiredMode}; stale expectation reveals no generation`, async () => {
    const f = await fixture();
    const revision = await f.deploy(null);
    await f.state.transact((unit) =>
      unit.runtimeAssignments.advanceRuntimeIntent(
        f.scope,
        1,
        { desiredMode, revisionId: revision.id },
        randomUUID(),
        { actorId: f.actorId, requestId: `restrict-${desiredMode}` },
      ),
    );
    const before = await f.snapshot();
    await assert.rejects(f.deploy(2), {
      name: "ResourceConflictError",
      message: "Deploy cannot resume a disabled or stopped Agent.",
    });
    await assert.rejects(f.deploy(1), {
      name: "ResourceConflictError",
      message: "The lifecycle generation does not match.",
    });
    assert.deepEqual(await f.snapshot(), before);
  });
}

test("current native IAM revocation denies before lifecycle state comparison", async () => {
  const f = await fixture();
  await f.deploy(null);
  const before = await f.snapshot();
  f.revoke();
  // Revocation removes the real principal from native IAM; no fake decision
  // callback supplies the denial. The deliberately stale value stays private.
  await assert.rejects(f.deploy(null), AuthorizationDeniedError);
  assert.deepEqual(await f.snapshot(), before);
});

test("audit collision rolls back CAS admission and preserves exact retry expectation", async () => {
  const f = await fixture();
  const factory = new AuditEventFactory({ idGenerator: () => "cas-audit-collision" });
  await f.deploy(null, f.context({ factory }));
  const before = await f.snapshot();
  const rejected = f.context({ factory });
  await assert.rejects(f.deploy(1, rejected), ResourceConflictError);
  assert.deepEqual(await f.snapshot(), before);
  await assert.rejects(
    f.controller.recoverDeployAgent(f.actorId, f.scope, rejected),
    DependencyUnavailableError,
  );
  await f.deploy(1);
  assert.equal((await f.snapshot()).head.generation, 2);
});

test("caller catching stale CAS inside an outer transaction cannot commit earlier admission", async () => {
  const f = await fixture();
  const before = await f.snapshot();
  await assert.rejects(
    f.controller.transact(async () => {
      await f.deploy(null);
      await assert.rejects(f.deploy(null), ResourceConflictError);
    }),
    ResourceConflictError,
  );
  assert.deepEqual(await f.snapshot(), before);
});

test("caller catching invalid generation inside an outer transaction cannot commit earlier admission", async () => {
  const f = await fixture();
  const before = await f.snapshot();
  for (const invalid of [undefined, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      f.controller.transact(async () => {
        await f.deploy(null);
        await assert.rejects(f.deploy(invalid), ScopeViolationError);
      }),
      ScopeViolationError,
    );
    assert.deepEqual(await f.snapshot(), before);
  }
});
