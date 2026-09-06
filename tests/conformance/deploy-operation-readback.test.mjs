import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  InMemoryPlatformState,
  OpenClawController,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createRuntimeAdmissionContext } from "../fixtures/runtime-admission-context.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";

async function fixture() {
  const installation = {
    id: `ins_${randomUUID()}`,
    name: "Deploy readback",
    createdAt: new Date().toISOString(),
  };
  const actorId = "deploy-author";
  const readerId = "deploy-reader";
  const state = new InMemoryPlatformState();
  const iamState = {
    identities: [actorId, readerId].map((id) => ({
      id,
      kind: "principal",
      issuer: "deploy-readback",
      subject: id,
    })),
    groups: [],
    memberships: [],
    restrictions: [],
    roles: [
      {
        id: "author-role",
        permissions: [
          ["create", "namespace"],
          ["create", "configuration"],
          ["read", "configuration"],
          ["update", "configuration"],
          ["create", "agent"],
          ["deploy", "agent"],
        ].map(([action, resourceKind]) => ({ action, resourceKind })),
      },
      { id: "reader-role", permissions: [{ action: "read", resourceKind: "agent" }] },
    ],
    bindings: [
      { id: "author-binding", subjectKind: "identity", subjectId: actorId, roleId: "author-role" },
    ],
  };
  let beforeIAMRead;
  const iam = new NativeIAMDriver({
    loadNativeIAMState: async () => {
      await beforeIAMRead?.();
      return structuredClone(iamState);
    },
  });
  const configurationDriver = createTestConfigurationDriver();
  const compute = createDevelopmentComputeDriver();
  function controllerFor(store = state) {
    const controller = new OpenClawController(installation, {
      state: store,
      recordOperations: false,
    });
    for (const driver of [iam, configurationDriver, compute]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    return controller;
  }
  const controller = controllerFor();
  const namespace = await controller.createNamespace(actorId, { name: "Readback tenant" });
  const configuration = await controller.createConfiguration(actorId, {
    namespaceId: namespace.id,
    kind: "agent",
    values: { model: "first-model" },
  });
  const agent = await controller.createAgent(actorId, {
    namespaceId: namespace.id,
    name: "Readback Agent",
    configurationId: configuration.id,
  });
  await state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const scope = { namespaceId: namespace.id, agentId: agent.id };
  iamState.bindings.push({
    id: "reader-binding",
    subjectKind: "identity",
    subjectId: readerId,
    roleId: "reader-role",
    namespaceId: namespace.id,
    resourceKind: "agent",
    resourceId: agent.id,
  });
  const context = () => createRuntimeAdmissionContext(installation.id, actorId);
  const deploy = (expectedLifecycleGeneration, admission = context()) =>
    controller.deployment.deployAgent(
      actorId,
      { ...scope, expectedLifecycleGeneration },
      resolveApprovedHarness,
      admission,
    );
  const read = (operationRef, principalId = readerId, target = controller) =>
    target.deployment.getAcceptedDeployOperation(principalId, { ...scope, operationRef });
  const snapshot = () =>
    state.read(async (view) => ({
      revisions: await view.revisions.listRevisions(scope.namespaceId, scope.agentId),
      head: await view.runtimeAssignments.findRuntimeIntentHead(scope),
      operations: await view.operations.list(),
      audit: await view.audit.list(),
    }));
  return {
    installation,
    actorId,
    readerId,
    state,
    controller,
    controllerFor,
    configuration,
    scope,
    context,
    deploy,
    read,
    snapshot,
    revoke: (bindingId) => {
      iamState.bindings = iamState.bindings.filter((binding) => binding.id !== bindingId);
    },
    beforeIAMRead: (hook) => {
      beforeIAMRead = hook;
    },
  };
}

function observeReads(state, afterRead) {
  return new Proxy(state, {
    get(target, property) {
      if (property === "read")
        return async (...args) => {
          // The hook runs after the real store has produced its result, never in place of it.
          const result = await target.read(...args);
          await afterRead();
          return result;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("accepted deploy readback preserves A after edit/B/restriction and reveals only seven immutable fields", async () => {
  const f = await fixture();
  const admission = f.context();
  const a = await f.deploy(null, admission);
  const intent = (await f.snapshot()).head;
  await f.controller.updateConfiguration(f.actorId, {
    namespaceId: f.scope.namespaceId,
    configurationId: f.configuration.id,
    values: { model: "second-model" },
  });
  const b = await f.deploy(1);
  await f.state.transact((unit) =>
    unit.runtimeAssignments.advanceRuntimeIntent(
      f.scope,
      2,
      { desiredMode: "stopped", revisionId: b.id },
      randomUUID(),
      { actorId: f.actorId, requestId: "retained-stop" },
    ),
  );
  const before = await f.snapshot();
  // Only the current reader's exact read grant matters; original attribution remains evidence.
  f.revoke("author-binding");
  const result = await f.read(admission.transitionRef);
  assert.deepEqual(result, {
    operationRef: admission.transitionRef,
    kind: "deploy",
    revisionSource: "saved-draft",
    lifecycleGeneration: 1,
    desiredMode: "running",
    acceptedAt: intent.createdAt,
    requestedRevisionId: a.id,
  });
  assert.equal(Reflect.ownKeys(result).length, 7);
  assert.ok(Object.isFrozen(result));
  assert.throws(() => {
    result.requestedRevisionId = b.id;
  }, TypeError);
  assert.deepEqual(await f.read(admission.transitionRef), result);
  assert.deepEqual(await f.snapshot(), before);
  await assert.rejects(
    f.controller.getRevision(f.readerId, f.scope.namespaceId, f.scope.agentId, a.id),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    f.controller.deployment.deployAgent(
      f.readerId,
      { ...f.scope, expectedLifecycleGeneration: 3 },
      resolveApprovedHarness,
      f.context(),
    ),
    AuthorizationDeniedError,
  );
});

test("deploy permission and possession of the locator do not grant a read or reach private storage", async () => {
  const f = await fixture();
  const admission = f.context();
  await f.deploy(null, admission);
  let reads = 0;
  const reader = f.controllerFor(
    observeReads(f.state, () => {
      reads++;
    }),
  );
  await assert.rejects(
    f.read(admission.transitionRef, f.actorId, reader),
    AuthorizationDeniedError,
  );
  await assert.rejects(f.read(randomUUID(), f.actorId, reader), AuthorizationDeniedError);
  assert.equal(reads, 0);
});

test("revocation after the real snapshot denies both found and absent readback results", async () => {
  for (const found of [true, false]) {
    const f = await fixture();
    const admission = f.context();
    await f.deploy(null, admission);
    let reads = 0;
    const reader = f.controllerFor(
      observeReads(f.state, () => {
        reads++;
        f.revoke("reader-binding");
      }),
    );
    await assert.rejects(
      f.read(found ? admission.transitionRef : randomUUID(), f.readerId, reader),
      AuthorizationDeniedError,
    );
    assert.equal(reads, 1);
  }
});

test("selected IAM lookup failure is unavailable and releases no stored result", async () => {
  const f = await fixture();
  const admission = f.context();
  await f.deploy(null, admission);
  let calls = 0;
  f.beforeIAMRead(() => {
    if (++calls === 2) throw new Error("private-iam-diagnostic");
  });
  await assert.rejects(f.read(admission.transitionRef), (error) => {
    assert.ok(error instanceof DependencyUnavailableError);
    assert.doesNotMatch(error.message, /private-iam-diagnostic/);
    return true;
  });
  assert.equal(calls, 2);
});

test("caller mutations during authorization cannot change the captured owner or locator", async () => {
  const f = await fixture();
  const admission = f.context();
  const revision = await f.deploy(null, admission);
  const input = { ...f.scope, operationRef: admission.transitionRef };
  f.beforeIAMRead(() => {
    input.namespaceId = "foreign";
    input.agentId = "foreign";
    input.operationRef = randomUUID();
  });
  const result = await f.controller.deployment.getAcceptedDeployOperation(f.readerId, input);
  assert.equal(result.operationRef, admission.transitionRef);
  assert.equal(result.requestedRevisionId, revision.id);
});

test("unknown and unpaired running intents cannot become accepted deploy operations", async () => {
  const f = await fixture();
  const revision = await f.deploy(null);
  const unpaired = randomUUID();
  // Actual intent storage can retain a transition without the original deploy admission tuple.
  await f.state.transact((unit) =>
    unit.runtimeAssignments.advanceRuntimeIntent(
      f.scope,
      1,
      { desiredMode: "running", revisionId: revision.id },
      unpaired,
      { actorId: f.actorId, requestId: "unpaired-transition" },
    ),
  );
  const before = await f.snapshot();
  for (const locator of [randomUUID(), unpaired])
    await assert.rejects(f.read(locator), {
      name: "ScopeViolationError",
      message: "The accepted deployment does not belong to the exact Agent.",
    });
  assert.deepEqual(await f.snapshot(), before);
});

test("a real foreign Agent's admission stays hidden behind the exact owner and read grant", async () => {
  const f = await fixture();
  const foreign = await f.controller.createAgent(f.actorId, {
    namespaceId: f.scope.namespaceId,
    name: "Other Agent",
    configurationId: f.configuration.id,
  });
  const admission = f.context();
  await f.controller.deployment.deployAgent(
    f.actorId,
    { namespaceId: f.scope.namespaceId, agentId: foreign.id, expectedLifecycleGeneration: null },
    resolveApprovedHarness,
    admission,
  );
  // A valid foreign locator under the authorized owner reveals no foreign tuple.
  await assert.rejects(f.read(admission.transitionRef), {
    name: "ScopeViolationError",
    message: "The accepted deployment does not belong to the exact Agent.",
  });
  await assert.rejects(
    f.controller.deployment.getAcceptedDeployOperation(f.readerId, {
      namespaceId: f.scope.namespaceId,
      agentId: foreign.id,
      operationRef: admission.transitionRef,
    }),
    AuthorizationDeniedError,
  );
});

test("malformed locators fail before IAM and active mutations cannot expose pending acceptance", async () => {
  const f = await fixture();
  let checks = 0;
  f.beforeIAMRead(() => {
    checks++;
  });
  for (const operationRef of [
    undefined,
    "",
    "not-a-locator",
    randomUUID().toUpperCase(),
    "11111111-1111-5111-8111-111111111111",
  ]) {
    await assert.rejects(f.read(operationRef), ScopeViolationError);
  }
  assert.equal(checks, 0);
  const admission = f.context();
  await assert.rejects(
    f.controller.transact(async () => {
      await f.deploy(null, admission);
      await f.read(admission.transitionRef);
    }),
    {
      name: "DependencyUnavailableError",
      message: "Deployment operation readback requires a fresh read transaction.",
    },
  );
  await assert.rejects(f.read(admission.transitionRef), ScopeViolationError);
  assert.equal((await f.snapshot()).revisions.length, 0);
});

test("store failure is sanitized as unavailable and never a committed projection", async () => {
  const f = await fixture();
  const admission = f.context();
  await f.deploy(null, admission);
  const reader = f.controllerFor(
    observeReads(f.state, () => {
      throw new Error("private-store-diagnostic");
    }),
  );
  await assert.rejects(f.read(admission.transitionRef, f.readerId, reader), {
    name: "DependencyUnavailableError",
    message: "The deployment operation could not be verified.",
  });
});
