import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MutationRunner } from "../../packages/occ/src/application/mutation-runner.ts";
import {
  DependencyUnavailableError,
  InMemoryPlatformState,
  OpenClawController,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createRuntimeAdmissionContext } from "../fixtures/runtime-admission-context.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const identifier = (kind) => `${kind}_${randomUUID()}`;
const installation = () => ({
  id: identifier("ins"),
  name: "Mutation coordinator",
  createdAt: new Date().toISOString(),
});
const namespace = () => ({
  id: identifier("ns"),
  name: `Mutation tenant ${randomUUID()}`,
  status: "provisioning",
  createdAt: new Date().toISOString(),
});
const operation = (tenant) => ({
  kind: "namespace",
  action: "reconcile",
  target: "ready",
  namespaceId: tenant.id,
  resourceId: tenant.id,
  actorId: "actor",
});
const audit = (owner, tenant) => ({
  id: identifier("aud"),
  installationId: owner.id,
  namespaceId: tenant.id,
  occurredAt: tenant.createdAt,
  kind: "mutation",
  actorId: "actor",
  action: "create",
  resource: { kind: "namespace", id: tenant.id, namespaceId: tenant.id },
  outcome: "success",
});

function fixture(options) {
  const owner = installation();
  const store = new InMemoryPlatformState(options);
  return { owner, store, runner: new MutationRunner(owner, store) };
}

test("nested mutation and read callbacks share one actual unit and narrow repository view", async () => {
  const { owner, store, runner } = fixture();
  const tenant = namespace();
  const event = audit(owner, tenant);
  const selection = {
    read: { namespaces: ["findNamespace"] },
    mutate: {
      namespaces: ["createNamespace"],
      operations: ["append"],
      audit: ["append"],
    },
  };
  const service = runner.forRepositories(selection);
  // A service cannot widen its admitted repository set by mutating its selection later.
  selection.mutate.secrets = ["createSecret"];
  selection.read.namespaces.push("listNamespaces");
  let retained;
  assert.equal(await runner.read((view) => view.installations.getInstallation()), undefined);
  await runner.transact(async (outer) => {
    assert.equal(runner.hasActiveTransaction(), true);
    assert.deepEqual(await outer.installations.getInstallation(), owner);
    await runner.transact(async (inner) => assert.equal(inner, outer));
    await runner.mutate(async (inner) => assert.equal(inner, outer));
    await service.mutate(async (view) => {
      retained = view;
      assert.deepEqual(Object.keys(view), ["namespaces", "operations", "audit"]);
      assert.ok(Object.isFrozen(view));
      assert.deepEqual(Object.keys(view.namespaces), ["createNamespace"]);
      assert.ok(Object.isFrozen(view.namespaces));
      await view.namespaces.createNamespace(tenant);
      await view.operations.append(operation(tenant));
      await view.audit.append(event);
    });
    await service.read(async (view) => {
      assert.deepEqual(Object.keys(view), ["namespaces"]);
      assert.deepEqual(Object.keys(view.namespaces), ["findNamespace"]);
      assert.equal(view.namespaces.createNamespace, undefined);
      assert.deepEqual(await view.namespaces.findNamespace(tenant.id), tenant);
    });
  });
  assert.equal(runner.hasActiveTransaction(), false);
  assert.deepEqual(await store.read((view) => view.namespaces.findNamespace(tenant.id)), tenant);
  assert.deepEqual(await store.read((view) => view.audit.list()), [event]);
  assert.deepEqual(store.pendingOperations(), [operation(tenant)]);
  await assert.rejects(retained.namespaces.createNamespace(namespace()), ScopeViolationError);
  await service.read(async (view) => {
    assert.deepEqual(Object.keys(view.namespaces), ["findNamespace"]);
  });
});

test("a mismatched Installation fails before mutation while failed bootstrap rolls back", async () => {
  const { owner, store, runner } = fixture();
  const failure = new Error("bootstrap transaction failed");
  await assert.rejects(
    runner.transact(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(await store.read((view) => view.installations.getInstallation()), undefined);
  await runner.transact(async () => {});
  const other = new MutationRunner(installation(), store);
  let entered = false;
  await assert.rejects(
    other.mutate(async () => {
      entered = true;
    }),
    ScopeViolationError,
  );
  assert.equal(entered, false);
  assert.deepEqual(await store.read((view) => view.installations.getInstallation()), owner);
});

test("known outer rollback compensates nested effects in reverse order and removes all state", async () => {
  const { owner, store, runner } = fixture();
  const tenant = namespace();
  const failure = new Error("outer transaction failed");
  const effects = [];
  let retained;
  await assert.rejects(
    runner.transact(async (unit) => {
      retained = unit;
      await unit.namespaces.createNamespace(tenant);
      await unit.audit.append(audit(owner, tenant));
      await unit.operations.append(operation(tenant));
      runner.registerRollback(async () => effects.push("outer"));
      await runner.transact(async () => {
        runner.registerRollback(async () => effects.push("inner"));
      });
      assert.deepEqual(effects, []);
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(effects, ["inner", "outer"]);
  assert.equal(await store.read((view) => view.installations.getInstallation()), undefined);
  assert.equal(await store.read((view) => view.namespaces.findNamespace(tenant.id)), undefined);
  assert.deepEqual(await store.read((view) => view.audit.list()), []);
  assert.deepEqual(store.pendingOperations(), []);
  await assert.rejects(retained.operations.list(), ScopeViolationError);
  assert.throws(() => runner.registerRollback(async () => {}), DependencyUnavailableError);
});

test("a failed compensation still drains earlier compensations and reports the Driver failure", async () => {
  const { runner } = fixture();
  const called = [];
  await assert.rejects(
    runner.transact(async () => {
      runner.registerRollback(async () => called.push("first"));
      runner.registerRollback(async () => {
        called.push("second");
        throw new Error("Driver rollback failed");
      });
      runner.registerRollback(async () => called.push("third"));
      throw new Error("resource failed");
    }),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "A Driver could not roll back a failed resource mutation.",
  );
  assert.deepEqual(called, ["third", "second", "first"]);
});

test("concurrent callers keep compensation stacks separate and successful work is retained", async () => {
  const { runner, store } = fixture();
  const rolledBack = [];
  const rejected = namespace();
  const committed = namespace();
  const failure = new Error("first caller failed");
  const results = await Promise.allSettled([
    runner.transact(async (unit) => {
      await unit.namespaces.createNamespace(rejected);
      runner.registerRollback(async () => rolledBack.push(rejected.id));
      throw failure;
    }),
    runner.transact(async (unit) => {
      await unit.namespaces.createNamespace(committed);
      runner.registerRollback(async () => rolledBack.push(committed.id));
    }),
  ]);
  assert.equal(results[0].reason, failure);
  assert.equal(results[1].status, "fulfilled");
  assert.deepEqual(rolledBack, [rejected.id]);
  assert.equal(await store.read((view) => view.namespaces.findNamespace(rejected.id)), undefined);
  assert.deepEqual(
    await store.read((view) => view.namespaces.findNamespace(committed.id)),
    committed,
  );
});

test("caught ordinary repository conflicts preserve the transaction without admission poison", async () => {
  const { runner, store } = fixture();
  const tenant = namespace();
  await runner.transact(async (unit) => {
    await unit.namespaces.createNamespace(tenant);
    await assert.rejects(
      runner.mutate((joined) => joined.namespaces.createNamespace(tenant)),
      ResourceConflictError,
    );
  });
  assert.deepEqual(await store.read((view) => view.namespaces.findNamespace(tenant.id)), tenant);
});

test("caught admission failure retains even an undefined rejection and rolls back the unit", async () => {
  const { runner, store } = fixture();
  const tenant = namespace();
  // Presence of poison is separate from the error value; JavaScript permits rejecting undefined.
  const result = await Promise.allSettled([
    runner.transact(async (unit) => {
      await unit.namespaces.createNamespace(tenant);
      runner.poisonAdmission(undefined);
      return "caught";
    }),
  ]);
  assert.equal(result[0].status, "rejected");
  assert.equal(result[0].reason, undefined);
  assert.equal(await store.read((view) => view.namespaces.findNamespace(tenant.id)), undefined);
  await runner.transact(async () => {});
});

test("accepted serialized repository operations drain before the coordinator commits", async () => {
  const { owner, runner, store } = fixture();
  const channel = {
    id: identifier("chi"),
    installationId: owner.id,
    version: 1,
    status: "enabled",
    createdAt: owner.createdAt,
    updatedAt: owner.createdAt,
    createdBy: "actor",
    updatedBy: "actor",
    platform: "slack",
    providerTenantRef: "tenant",
    recipientAppRef: "app",
  };
  let accepted;
  let retained;
  await runner.mutate(async (unit) => {
    retained = unit.channelBindings;
    accepted = unit.channelBindings.createChannelInstallation(channel);
  });
  assert.deepEqual(await accepted, channel);
  assert.deepEqual(
    await store.read((view) => view.channelBindings.findChannelInstallation(channel.id)),
    channel,
  );
  await assert.rejects(retained.findChannelInstallation(channel.id), ScopeViolationError);
});

async function controllerFixture() {
  const { owner, store } = fixture();
  const actorId = "mutation-administrator";
  const controller = new OpenClawController(owner, { state: store, recordOperations: false });
  const iam = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities: [{ id: actorId, kind: "principal", issuer: "mutation", subject: actorId }],
      groups: [],
      memberships: [],
      restrictions: [],
      roles: [
        {
          id: "mutation-role",
          permissions: [
            ["create", "namespace"],
            ["create", "configuration"],
            ["read", "configuration"],
            ["create", "agent"],
            ["deploy", "agent"],
            ["create", "secret"],
          ].map(([action, resourceKind]) => ({ action, resourceKind })),
        },
      ],
      bindings: [
        {
          id: "mutation-binding",
          subjectKind: "identity",
          subjectId: actorId,
          roleId: "mutation-role",
        },
      ],
    }),
  });
  const secret = createTestSecretDriver();
  for (const driver of [
    iam,
    createTestConfigurationDriver(),
    createDevelopmentComputeDriver(),
    secret,
  ]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  const tenant = await controller.createNamespace(actorId, { name: "Mutation tenant" });
  const configuration = await controller.createConfiguration(actorId, {
    namespaceId: tenant.id,
    kind: "agent",
    values: { model: "gpt-test" },
  });
  const agent = await controller.createAgent(actorId, {
    namespaceId: tenant.id,
    name: "Mutation Agent",
    configurationId: configuration.id,
  });
  await store.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(tenant.id, "provisioning", "ready"),
  );
  return { owner, store, actorId, controller, tenant, agent, secret };
}

test("controller services join the extracted runner and compensate a real Secret mutation on rollback", async () => {
  const f = await controllerFixture();
  const failure = new Error("resource transaction rejected");
  let created;
  await assert.rejects(
    f.controller.transact(async (outer) => {
      await f.controller.transact(async (inner) => assert.equal(inner, outer));
      created = await f.controller.createSecret(f.actorId, {
        namespaceId: f.tenant.id,
        name: "Transient secret",
        value: "test-value",
      });
      assert.equal(f.secret.has(created), true);
      assert.ok(await outer.secrets.findSecret(f.tenant.id, created.id));
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(f.secret.has(created), false);
  assert.equal(
    await f.store.read((view) => view.secrets.findSecret(f.tenant.id, created.id)),
    undefined,
  );
  assert.deepEqual(
    f.secret.calls.map((call) => call.operation),
    ["create", "delete"],
  );
});

test("a caught second deployment poisons the real controller unit including its first accepted admission", async () => {
  const f = await controllerFixture();
  const scope = { namespaceId: f.tenant.id, agentId: f.agent.id };
  const input = { ...scope, expectedLifecycleGeneration: null };
  const admission = createRuntimeAdmissionContext(f.owner.id, f.actorId);
  const before = await f.store.read(async (view) => ({
    audit: await view.audit.list(),
    operations: await view.operations.list(),
  }));
  let caught;
  await assert.rejects(
    f.controller.transact(async () => {
      await f.controller.deployAgent(f.actorId, input, resolveApprovedHarness, admission);
      // Generation null is stale after the first admission. Catching it must not
      // publish that earlier revision, its CAS head, work, or attributable audit.
      try {
        await f.controller.deployAgent(
          f.actorId,
          input,
          resolveApprovedHarness,
          createRuntimeAdmissionContext(f.owner.id, f.actorId),
        );
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof ResourceConflictError);
      await assert.rejects(
        f.controller.recoverDeployAgent(f.actorId, input, admission),
        DependencyUnavailableError,
      );
    }),
    (error) => error === caught,
  );
  await f.store.read(async (view) => {
    assert.deepEqual(await view.revisions.listRevisions(scope.namespaceId, scope.agentId), []);
    assert.equal(await view.runtimeAssignments.findRuntimeIntentHead(scope), undefined);
    assert.equal(
      await view.runtimeAdmissions.findCommittedAdmission(input, admission.transitionRef, {
        actorId: f.actorId,
        requestId: admission.requestId,
      }),
      undefined,
    );
    assert.deepEqual(await view.audit.list(), before.audit);
    assert.deepEqual(await view.operations.list(), before.operations);
  });
});
