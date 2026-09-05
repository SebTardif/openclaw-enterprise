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
import {
  InMemoryPlatformState,
  isRuntimeAdmissionAudit,
} from "../../packages/occ/src/state/platform-state.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createRuntimeAdmissionContext } from "../fixtures/runtime-admission-context.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";

const id = (kind) => `${kind}_${randomUUID()}`;
const now = () => new Date().toISOString();

async function fixture() {
  const installation = { id: id("ins"), name: "Deployment service", createdAt: now() };
  const actor = "deployment-administrator";
  const state = new InMemoryPlatformState();
  const runner = new MutationRunner(installation, state);
  const drivers = new DriverSelection();
  const iam = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities: [
        { id: actor, kind: "principal", issuer: "deployment-service-test", subject: actor },
      ],
      groups: [],
      memberships: [],
      restrictions: [],
      roles: [
        {
          id: "administrator-role",
          permissions: [
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
          id: "administrator-binding",
          subjectKind: "identity",
          subjectId: actor,
          roleId: "administrator-role",
        },
      ],
    }),
  });
  for (const driver of [iam, createTestConfigurationDriver(), createDevelopmentComputeDriver()]) {
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
  function serviceFor(owner = runner) {
    return new DeploymentService({
      installationId: installation.id,
      isRuntimeAdmissionAudit,
      repositories: owner.forRepositories(DEPLOYMENT_REPOSITORIES),
      recoveryRead: (work) =>
        state.read((view) => work(selectRepositories(view, DEPLOYMENT_RECOVERY_REPOSITORIES))),
      hasActiveTransaction: () => owner.hasActiveTransaction(),
      poisonAdmission: (error) => owner.poisonAdmission(error),
      authorization: common.authorization,
      providers: common.providers,
      computeDriver: () => drivers.selectedDriver("compute"),
      configurationDriver: () => drivers.configurationDriver(),
      secretDriver: (expectedId) => drivers.secretDriver(expectedId),
      sandboxDriver: () => drivers.sandboxDriver(),
      // Transparent execution exercises the selected storage Driver. Error
      // sanitization is a composition concern and is not asserted by this suite.
      configurationOperation: (operation) => operation(),
      secretOperation: (operation) => operation(),
      loggingLevel: "info",
      createId: () => id("rev"),
      now,
    });
  }
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
  const service = serviceFor();
  const scope = { namespaceId: namespace.id, agentId: agent.id };
  const context = () => createRuntimeAdmissionContext(installation.id, actor);
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
      operations: await view.operations.list(),
      audit: await view.audit.list(),
    }));
  return {
    installation,
    actor,
    state,
    runner,
    service,
    serviceFor,
    configurations,
    configuration,
    scope,
    context,
    deploy,
    snapshot,
  };
}

// These calls exercise the extracted domain service itself with real Native IAM,
// repositories and mutation ownership; no HTTP route or live runtime is claimed.
test("Deployment service admits immutable revisions and original reconciliation work", async () => {
  const f = await fixture();
  const retained = f.context();
  const first = await f.deploy(null, retained);
  const admitted = await f.snapshot();
  assert.equal(admitted.head.generation, 1);
  assert.equal(
    admitted.operations.length,
    1,
    "direct service admission always appends original reconciliation work",
  );
  assert.equal(admitted.operations[0].resourceId, first.id);
  assert.equal(admitted.operations[0].runtimeTransitionRef, retained.transitionRef);
  await f.configurations.updateConfiguration(f.actor, {
    namespaceId: f.scope.namespaceId,
    configurationId: f.configuration.id,
    values: { model: "edited" },
  });
  assert.deepEqual(await f.snapshot(), admitted);
  const second = await f.deploy(1);
  const saved = await f.snapshot();
  assert.equal(first.configuration.model, "original");
  assert.equal(first.configurationGeneration, 1);
  assert.equal(second.configuration.model, "edited");
  assert.equal(second.configurationGeneration, 2);
  assert.deepEqual(saved.revisions, [first, second]);
  assert.equal(saved.head.generation, 2);
  assert.equal(saved.operations.length, 2);
  assert.deepEqual(await f.service.recoverDeployAgent(f.actor, f.scope, retained), first);
});

test("Deployment service CAS admits one concurrent successor and rejects stale or invalid expectations", async () => {
  const f = await fixture();
  const other = f.serviceFor(new MutationRunner(f.installation, f.state));
  for (const expected of [null, 1]) {
    const results = await Promise.allSettled([
      f.deploy(expected),
      f.deploy(expected, f.context(), other),
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
  const before = await f.snapshot();
  for (const expected of [null, 1, 3])
    await assert.rejects(f.deploy(expected), ResourceConflictError);
  for (const expected of [undefined, 0, -1, 1.5, "2"])
    await assert.rejects(f.deploy(expected), ScopeViolationError);
  assert.deepEqual(await f.snapshot(), before);
});

test("Caught mismatched audit poisons the outer transaction including earlier Configuration writes", async () => {
  const f = await fixture();
  const before = await f.snapshot();
  const wrongActor = createRuntimeAdmissionContext(f.installation.id, "another-actor");
  await assert.rejects(
    f.runner.transact(async () => {
      await f.configurations.updateConfiguration(f.actor, {
        namespaceId: f.scope.namespaceId,
        configurationId: f.configuration.id,
        values: { model: "must-roll-back" },
      });
      await assert.rejects(f.deploy(null, wrongActor), ScopeViolationError);
    }),
    ScopeViolationError,
  );
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(
    await f.configurations.getConfiguration(f.actor, f.scope.namespaceId, f.configuration.id),
    f.configuration,
  );
  // A caught validation failure after an otherwise accepted admission cannot
  // allow that earlier revision, intent, audit or work to escape the failed unit.
  await assert.rejects(
    f.runner.transact(async () => {
      await f.deploy(null);
      await assert.rejects(f.deploy(undefined), ScopeViolationError);
    }),
    ScopeViolationError,
  );
  assert.deepEqual(await f.snapshot(), before);
});

test("Recovery requires the retained exact actor, request and transition in a fresh transaction", async () => {
  const f = await fixture();
  const retained = f.context();
  const revision = await f.deploy(null, retained);
  for (const [actor, locator] of [
    ["another-actor", retained],
    [f.actor, { ...retained, requestId: "another-request" }],
    [f.actor, { ...retained, transitionRef: randomUUID() }],
  ])
    await assert.rejects(
      f.service.recoverDeployAgent(actor, f.scope, locator),
      DependencyUnavailableError,
    );
  await f.runner.transact(async () => {
    await assert.rejects(
      f.service.recoverDeployAgent(f.actor, f.scope, retained),
      DependencyUnavailableError,
    );
  });
  assert.deepEqual(await f.service.recoverDeployAgent(f.actor, f.scope, retained), revision);
});
