import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { NativeIAMDriver, createAuthPrincipalSeed } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  NamespaceNotEmptyError,
  OpenClawController,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { namespaceChildren } from "./namespace-repository.contract.mjs";

// Direct OCC calls exercise the same accepted facade before and after extraction.
// Compute is the existing deterministic conformance fixture, not a live runtime.
const id = (kind) => `${kind}_${randomUUID()}`;
function fixture() {
  const installation = {
    id: id("ins"),
    name: "Namespace service",
    createdAt: new Date().toISOString(),
  };
  const state = new InMemoryPlatformState();
  const seed = createAuthPrincipalSeed(installation.id, "namespace-service", { id: id("account") });
  const iamState = {
    identities: [seed.principal],
    roles: [...seed.roles],
    bindings: [...seed.bindings],
    groups: [],
    memberships: [],
    restrictions: [],
  };
  const controller = new OpenClawController(installation, { state });
  const select = (driver) => {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  };
  select(new NativeIAMDriver({ loadNativeIAMState: async () => iamState }));
  const create = (name = `Namespace ${randomUUID()}`) =>
    controller.createNamespace(seed.principal.id, { name });
  const snapshot = () =>
    state.read(async (view) => ({
      installation: await view.installations.getInstallation(),
      namespaces: await view.namespaces.listNamespaces(),
      operations: await view.operations.list(),
      audit: await view.audit.list(),
    }));
  return {
    controller,
    state,
    installation,
    actor: seed.principal.id,
    iamState,
    select,
    create,
    snapshot,
  };
}

test("Namespace facade reads and rejected mutations preserve lazy Installation bootstrap", async () => {
  const f = fixture();
  assert.deepEqual(await f.controller.listNamespaces(f.actor), []);
  await assert.rejects(f.controller.getNamespace(f.actor, id("ns")), ScopeViolationError);
  await assert.rejects(f.controller.createNamespace(f.actor, { name: "" }), ScopeViolationError);
  await assert.rejects(
    f.controller.createNamespace("unknown", { name: "Denied" }),
    AuthorizationDeniedError,
  );
  await assert.rejects(f.controller.deleteNamespace(f.actor, id("ns")), ScopeViolationError);
  assert.deepEqual(await f.snapshot(), {
    installation: undefined,
    namespaces: [],
    operations: [],
    audit: [],
  });
  const created = await f.create();
  assert.deepEqual((await f.snapshot()).installation, f.installation);
  assert.equal(created.status, "provisioning");
  assert.deepEqual(await f.controller.getNamespace(f.actor, created.id), created);
  assert.ok(Object.isFrozen(created));
  assert.deepEqual((await f.snapshot()).operations, [
    {
      kind: "namespace",
      action: "reconcile",
      target: "ready",
      namespaceId: created.id,
      resourceId: created.id,
      actorId: f.actor,
    },
  ]);
});

test("Namespace list and exact reads enforce current Native IAM tenant scope and selection", async () => {
  const f = fixture();
  const owner = await f.create();
  const foreign = await f.create();
  const reader = {
    kind: "principal",
    id: id("reader"),
    issuer: "namespace-service",
    subject: "reader",
  };
  const role = {
    id: id("role"),
    namespaceId: owner.id,
    permissions: [{ action: "read", resourceKind: "namespace" }],
  };
  f.iamState.identities.push(reader);
  f.iamState.roles.push(role);
  f.iamState.bindings.push({
    id: id("binding"),
    namespaceId: owner.id,
    subjectKind: "identity",
    subjectId: reader.id,
    roleId: role.id,
    resourceKind: "namespace",
    resourceId: owner.id,
  });
  const listed = await f.controller.listNamespaces(reader.id);
  assert.deepEqual(listed, [owner]);
  assert.ok(Object.isFrozen(listed));
  assert.deepEqual(await f.controller.getNamespace(reader.id, owner.id), owner);
  await assert.rejects(f.controller.getNamespace(reader.id, foreign.id), AuthorizationDeniedError);
  await assert.rejects(f.controller.deleteNamespace(reader.id, owner.id), AuthorizationDeniedError);
  f.select(
    new NativeIAMDriver(
      { loadNativeIAMState: async () => ({ ...f.iamState, bindings: [] }) },
      { id: "native-denying" },
    ),
  );
  assert.deepEqual(await f.controller.listNamespaces(f.actor), []);
  await assert.rejects(f.controller.getNamespace(f.actor, owner.id), AuthorizationDeniedError);
  await assert.rejects(f.create(), AuthorizationDeniedError);
  await assert.rejects(f.controller.deleteNamespace(f.actor, owner.id), AuthorizationDeniedError);
  assert.deepEqual((await f.snapshot()).namespaces, [owner, foreign]);
});

test("Namespace adoption requires Installation authority and the actual bundled Kubernetes selection", async () => {
  const f = fixture();
  const input = { name: "Adopted", existingNamespace: "existing-tenant" };
  await assert.rejects(f.controller.createNamespace(f.actor, input), ResourceConflictError);
  f.select(createDevelopmentComputeDriver());
  await assert.rejects(f.controller.createNamespace(f.actor, input), ResourceConflictError);
  // The bundled Driver is constructed without opening clients or contacting a cluster.
  f.select(createTestKubernetesComputeDriver("namespace-kubernetes"));
  const creator = {
    kind: "principal",
    id: id("creator"),
    issuer: "namespace-service",
    subject: "creator",
  };
  const role = { id: id("role"), permissions: [{ action: "create", resourceKind: "namespace" }] };
  f.iamState.identities.push(creator);
  f.iamState.roles.push(role);
  f.iamState.bindings.push({
    id: id("binding"),
    subjectKind: "identity",
    subjectId: creator.id,
    roleId: role.id,
  });
  await assert.rejects(f.controller.createNamespace(creator.id, input), AuthorizationDeniedError);
  assert.equal((await f.snapshot()).installation, undefined);
  const created = await f.controller.createNamespace(f.actor, input);
  assert.equal(created.existingNamespace, input.existingNamespace);
  assert.equal(created.status, "provisioning");
  await assert.rejects(
    f.controller.createNamespace(f.actor, { ...input, name: "Duplicate placement" }),
    ResourceConflictError,
  );
  await assert.rejects(
    f.controller.createNamespace(f.actor, {
      name: "Invalid placement",
      existingNamespace: "Invalid_Name",
    }),
    ScopeViolationError,
  );
});

test("Namespace deletion rejects each actual child kind and leaves other tenants independently deletable", async () => {
  const f = fixture();
  f.select(createDevelopmentComputeDriver());
  for (const kind of ["configuration", "agent", "secret", "account"]) {
    const owner = await f.create();
    await f.controller.handleNamespaceLifecycle(f.actor, owner.id, "ready");
    const children = namespaceChildren(owner);
    // Complete persisted children use the real aggregate repositories. Agents
    // require a Configuration; each remaining child is tested in isolation.
    await f.controller.transact(async (unit) => {
      if (kind === "configuration" || kind === "agent")
        await unit.configurations.createConfiguration(children.configuration);
      if (kind === "agent") await unit.agents.createAgent(children.agent);
      if (kind === "secret") await unit.secrets.createSecret(children.secret);
      if (kind === "account") await unit.serviceAccounts.createServiceAccount(children.account);
    });
    const before = await f.snapshot();
    await assert.rejects(f.controller.deleteNamespace(f.actor, owner.id), NamespaceNotEmptyError);
    assert.deepEqual(await f.snapshot(), before);
  }
  const empty = await f.create();
  const deleting = await f.controller.deleteNamespace(f.actor, empty.id);
  assert.equal(deleting.status, "deleting");
  const before = await f.snapshot();
  assert.deepEqual(await f.controller.deleteNamespace(f.actor, empty.id), deleting);
  assert.deepEqual(await f.snapshot(), before);
  const deleted = await f.controller.handleNamespaceLifecycle(f.actor, empty.id, "deleted");
  assert.ok(deleted.deletedAt);
  await assert.rejects(f.controller.getNamespace(f.actor, empty.id), ScopeViolationError);
  assert.equal(
    (await f.controller.listNamespaces(f.actor)).some((n) => n.id === empty.id),
    false,
  );
  assert.equal(
    await f.controller.handleNamespaceLifecycle(f.actor, empty.id, "deleted"),
    undefined,
  );
});

test("Namespace enclosing transaction rolls back resource, work and lifecycle audit together", async () => {
  const f = fixture();
  f.select(createDevelopmentComputeDriver());
  const failure = new Error("abort enclosing mutation");
  let candidate;
  await assert.rejects(
    f.controller.transact(async () => {
      candidate = await f.create();
      await f.controller.handleNamespaceLifecycle(f.actor, candidate.id, "ready");
      await f.controller.deleteNamespace(f.actor, candidate.id);
      const staged = await f.controller.transact(async (unit) => ({
        operations: await unit.operations.list(),
        audit: await unit.audit.list(),
      }));
      assert.equal(staged.operations.length, 2);
      assert.equal(staged.audit.length, 1);
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(await f.snapshot(), {
    installation: undefined,
    namespaces: [],
    operations: [],
    audit: [],
  });
});

test("Namespace lifecycle rejects unavailable and foreign Compute evidence with attributable failure audit", async () => {
  const f = fixture();
  const owner = await f.create();
  await assert.rejects(
    f.controller.handleNamespaceLifecycle(f.actor, owner.id, "ready"),
    DependencyUnavailableError,
  );
  let events = (await f.snapshot()).audit;
  assert.equal(events.at(-1).details.failure, "compute_driver_unavailable");
  const compute = createDevelopmentComputeDriver();
  // Fault injection at the Driver boundary tests the controller's evidence
  // validation; no repository, IAM decision, or lifecycle method is replaced.
  f.select({
    ...compute,
    async ensureNamespace() {
      return { namespaceId: id("foreign"), namespaceReady: true };
    },
  });
  await assert.rejects(
    f.controller.handleNamespaceLifecycle(f.actor, owner.id, "ready"),
    DependencyUnavailableError,
  );
  events = (await f.snapshot()).audit;
  assert.equal(events.at(-1).details.failure, "invalid_driver_result");
  assert.equal(events.at(-1).outcome, "failure");
  assert.equal(events.at(-1).actorId, f.actor);
  assert.equal(events.at(-1).installationId, f.installation.id);
  assert.deepEqual(events.at(-1).resource, {
    kind: "namespace",
    id: owner.id,
    namespaceId: owner.id,
  });
  assert.equal((await f.controller.getNamespace(f.actor, owner.id)).status, "provisioning");
});

test("Namespace lifecycle preserves retryable failure and marks permanent failure without claiming readiness", async () => {
  const f = fixture();
  const owner = await f.create();
  const compute = createDevelopmentComputeDriver();
  for (const failure of ["retryable", "permanent"]) {
    f.select({
      ...compute,
      id: `compute-${failure}`,
      async ensureNamespace(namespace) {
        return { namespaceId: namespace.id, namespaceReady: false, failure };
      },
    });
    const result = await f.controller.handleNamespaceLifecycle(f.actor, owner.id, "ready");
    assert.equal(result.status, failure === "retryable" ? "provisioning" : "failed");
    assert.equal((await f.snapshot()).audit.at(-1).details.failure, failure);
  }
  assert.equal((await f.controller.deleteNamespace(f.actor, owner.id)).status, "deleting");
});

test("Namespace stale successful ensure cannot overwrite deletion or append success evidence", async () => {
  const f = fixture();
  const owner = await f.create();
  const compute = createDevelopmentComputeDriver();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.select({
    ...compute,
    async ensureNamespace(namespace) {
      entered.resolve();
      await release.promise;
      return compute.ensureNamespace(namespace);
    },
  });
  const pending = f.controller.handleNamespaceLifecycle(f.actor, owner.id, "ready");
  await entered.promise;
  try {
    const deleting = await f.controller.deleteNamespace(f.actor, owner.id);
    release.resolve();
    assert.deepEqual(await pending, deleting);
    assert.deepEqual((await f.snapshot()).audit, []);
    assert.equal((await f.controller.getNamespace(f.actor, owner.id)).status, "deleting");
  } finally {
    release.resolve();
  }
});
