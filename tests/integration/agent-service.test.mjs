import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { ExactAuthorization } from "../../packages/occ/src/application/authorization.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { MutationRunner } from "../../packages/occ/src/application/mutation-runner.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  ScopeViolationError,
} from "../../packages/occ/src/errors.ts";
import { AGENT_REPOSITORIES } from "../../packages/occ/src/services/agent/port.ts";
import { AgentService } from "../../packages/occ/src/services/agent/service.ts";
import { selectRepositories } from "../../packages/occ/src/application/mutation-context.ts";
import { CONFIGURATION_REPOSITORIES } from "../../packages/occ/src/services/configuration/port.ts";
import { ConfigurationService } from "../../packages/occ/src/services/configuration/service.ts";
import {
  DEPLOYMENT_REPOSITORIES,
  DEPLOYMENT_RECOVERY_REPOSITORIES,
} from "../../packages/occ/src/services/deployment/port.ts";
import { DeploymentService } from "../../packages/occ/src/services/deployment/service.ts";
import { createRuntimeAdmissionContext } from "../fixtures/runtime-admission-context.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import {
  InMemoryPlatformState,
  isRuntimeAdmissionAudit,
} from "../../packages/occ/src/state/platform-state.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const id = (kind) => `${kind}_${randomUUID()}`;
const now = () => new Date().toISOString();

async function fixture() {
  const installation = { id: id("ins"), name: "Agent service", createdAt: now() };
  const state = new InMemoryPlatformState();
  const runner = new MutationRunner(installation, state);
  // Native IAM evaluates these persisted-shape grants; the fixture supplies no
  // authorization decisions or replacement repository implementations.
  const iamState = {
    identities: ["admin", "reader", "revision-reader", "editor"].map((principal) => ({
      kind: "principal",
      id: principal,
      issuer: "agent-service-test",
      subject: principal,
    })),
    groups: [],
    memberships: [],
    restrictions: [],
    roles: [
      {
        id: "admin-role",
        permissions: [
          ...["namespace", "agent", "agent_revision", "configuration", "service_account"].map(
            (resourceKind) => ({ action: "read", resourceKind }),
          ),
          ...["create", "update", "operate", "deploy"].map((action) => ({
            action,
            resourceKind: "agent",
          })),
          { action: "operate", resourceKind: "secret" },
          { action: "create", resourceKind: "configuration" },
        ],
      },
    ],
    bindings: [
      { id: "admin-binding", subjectKind: "identity", subjectId: "admin", roleId: "admin-role" },
    ],
  };
  function grant(principal, action, kind, resourceId, namespaceId) {
    const roleId = id("role");
    iamState.roles.push({ id: roleId, permissions: [{ action, resourceKind: kind }] });
    iamState.bindings.push({
      id: id("binding"),
      roleId,
      subjectKind: "identity",
      subjectId: principal,
      ...(resourceId === undefined ? {} : { namespaceId, resourceKind: kind, resourceId }),
    });
  }
  const drivers = new DriverSelection();
  const secretDriver = createTestSecretDriver();
  for (const driver of [
    new NativeIAMDriver({ loadNativeIAMState: async () => iamState }),
    secretDriver,
    createTestConfigurationDriver(),
    createDevelopmentComputeDriver(),
  ]) {
    drivers.registerDriver(driver);
    drivers.selectDriver(driver.capability, driver.id);
  }
  const service = new AgentService({
    repositories: runner.forRepositories(AGENT_REPOSITORIES),
    authorization: new ExactAuthorization(() => drivers.selectedDriver("iam")),
    providers: new Map(),
    assertSecretDriverOwner: (expectedId) => {
      drivers.secretDriver(expectedId);
    },
    createId: () => id("agt"),
    now,
  });
  const namespace = { id: id("ns"), name: id("owner"), status: "ready", createdAt: now() };
  const foreign = { ...namespace, id: id("ns"), name: id("foreign") };
  await runner.transact(async (unit) => {
    await unit.namespaces.createNamespace(namespace);
    await unit.namespaces.createNamespace(foreign);
  });
  const configurations = new ConfigurationService({
    repositories: runner.forRepositories(CONFIGURATION_REPOSITORIES),
    authorization: new ExactAuthorization(() => drivers.selectedDriver("iam")),
    configurationDriver: () => drivers.configurationDriver(),
    assertSecretDriverOwner: (expectedId) => {
      drivers.secretDriver(expectedId);
    },
    createId: () => id("cfg"),
    now,
  });
  const configuration = async (namespaceId = namespace.id, secretBindings) =>
    configurations.createConfiguration("admin", {
      namespaceId,
      kind: "agent",
      values: { model: "retained", nested: { enabled: true } },
      ...(secretBindings === undefined ? {} : { secretBindings }),
    });
  const account = async (namespaceId = namespace.id) =>
    runner.transact((unit) =>
      unit.serviceAccounts.createServiceAccount({ id: id("sa"), namespaceId, name: id("account") }),
    );
  const create = async (configurationId, options = {}) =>
    service.createAgent("admin", {
      namespaceId: namespace.id,
      name: id("agent"),
      configurationId,
      ...options,
    });
  const deployments = new DeploymentService({
    installationId: installation.id,
    isRuntimeAdmissionAudit,
    repositories: runner.forRepositories(DEPLOYMENT_REPOSITORIES),
    recoveryRead: (work) =>
      state.read((view) => work(selectRepositories(view, DEPLOYMENT_RECOVERY_REPOSITORIES))),
    hasActiveTransaction: () => runner.hasActiveTransaction(),
    poisonAdmission: (error) => runner.poisonAdmission(error),
    authorization: new ExactAuthorization(() => drivers.selectedDriver("iam")),
    providers: new Map(),
    computeDriver: () => drivers.selectedDriver("compute"),
    configurationDriver: () => drivers.configurationDriver(),
    secretDriver: (expectedId) => drivers.secretDriver(expectedId),
    sandboxDriver: () => drivers.sandboxDriver(),
    configurationOperation: (operation) => operation(),
    secretOperation: (operation) => operation(),
    loggingLevel: "info",
    createId: () => id("rev"),
    now,
  });
  // Admit every revision through the real service so the snapshot has its exact
  // lifecycle intent, audit, admission record and original reconciliation work.
  // Reader permissions are added only after this administrator admission.
  const revision = async (agent, number = 1) =>
    deployments.deployAgent(
      "admin",
      {
        namespaceId: agent.namespaceId,
        agentId: agent.id,
        expectedLifecycleGeneration: number === 1 ? null : number - 1,
      },
      resolveApprovedHarness,
      createRuntimeAdmissionContext(installation.id, "admin"),
    );
  return {
    state,
    runner,
    service,
    drivers,
    secretDriver,
    namespace,
    foreign,
    configuration,
    account,
    create,
    revision,
    grant,
  };
}

test("Agent drafts validate exact Configuration, ServiceAccount and Agent ownership", async () => {
  const f = await fixture();
  const cfg = await f.configuration();
  const foreignCfg = await f.configuration(f.foreign.id);
  const ownAccount = await f.account();
  const foreignAccount = await f.account(f.foreign.id);
  await assert.rejects(f.create(foreignCfg.id), ScopeViolationError);
  await assert.rejects(
    f.create(cfg.id, { serviceAccountId: foreignAccount.id }),
    ScopeViolationError,
  );
  const agent = await f.create(cfg.id, { serviceAccountId: ownAccount.id });
  for (const change of [
    { configurationId: foreignCfg.id },
    { serviceAccountId: foreignAccount.id },
    { namespaceId: f.foreign.id },
  ])
    await assert.rejects(
      f.service.updateAgent("admin", {
        namespaceId: f.namespace.id,
        agentId: agent.id,
        configurationId: cfg.id,
        ...change,
      }),
      ScopeViolationError,
    );
  await assert.rejects(f.service.getAgent("admin", f.foreign.id, agent.id), ScopeViolationError);
  assert.deepEqual(await f.service.getAgent("admin", f.namespace.id, agent.id), agent);
  const cleared = await f.service.updateAgent("admin", {
    namespaceId: f.namespace.id,
    agentId: agent.id,
    configurationId: cfg.id,
    serviceAccountId: null,
  });
  assert.equal(cleared.serviceAccountId, undefined);
});

test("Agent create and update reuse Secret binding authorization and the current selected owner", async () => {
  const f = await fixture();
  const identity = { id: id("sec"), namespaceId: f.namespace.id, name: id("secret") };
  const secret = {
    ...identity,
    driverId: f.secretDriver.id,
    backendRef: await f.secretDriver.create(identity, "disposable-test-value"),
    createdAt: now(),
  };
  await f.runner.transact((unit) => unit.secrets.createSecret(secret));
  const bindings = {
    APP_TOKEN: {
      source: { kind: "secret", namespaceId: secret.namespaceId, id: secret.id },
      delivery: { type: "env" },
    },
  };
  const cfg = await f.configuration(f.namespace.id, bindings);
  const agent = await f.create(cfg.id);
  for (const [action, kind] of [
    ["create", "agent"],
    ["update", "agent"],
    ["read", "configuration"],
  ])
    f.grant("editor", action, kind);
  // Configuration read permission does not imply permission to reuse its Secret.
  for (const principal of ["editor"]) {
    await assert.rejects(
      f.service.createAgent(principal, {
        namespaceId: f.namespace.id,
        name: id("denied"),
        configurationId: cfg.id,
      }),
      AuthorizationDeniedError,
    );
    await assert.rejects(
      f.service.updateAgent(principal, {
        namespaceId: f.namespace.id,
        agentId: agent.id,
        configurationId: cfg.id,
      }),
      AuthorizationDeniedError,
    );
  }
  f.grant("editor", "operate", "secret", secret.id, f.namespace.id);
  await f.service.updateAgent("editor", {
    namespaceId: f.namespace.id,
    agentId: agent.id,
    configurationId: cfg.id,
  });
  const replacement = createTestSecretDriver({ id: "replacement-secret-driver" });
  f.drivers.registerDriver(replacement);
  f.drivers.selectDriver("secret", replacement.id);
  await assert.rejects(f.create(cfg.id), DependencyUnavailableError);
  await assert.rejects(
    f.service.updateAgent("admin", {
      namespaceId: f.namespace.id,
      agentId: agent.id,
      configurationId: cfg.id,
    }),
    DependencyUnavailableError,
  );
  assert.deepEqual(await f.service.getAgent("admin", f.namespace.id, agent.id), agent);
  assert.deepEqual(
    (await f.state.read((view) => view.configurations.findConfiguration(f.namespace.id, cfg.id)))
      .secretBindings,
    bindings,
  );
});

test("Agent queries filter exact grants and require Agent read before revision read", async () => {
  const f = await fixture();
  const cfg = await f.configuration();
  const agent = await f.create(cfg.id);
  const hidden = await f.create(cfg.id);
  const revision = await f.revision(agent);
  const hiddenRevision = await f.revision(agent, 2);
  f.grant("reader", "read", "namespace", f.namespace.id, f.namespace.id);
  f.grant("reader", "read", "agent", agent.id, f.namespace.id);
  f.grant("reader", "read", "agent_revision", revision.id, f.namespace.id);
  f.grant("revision-reader", "read", "agent_revision", revision.id, f.namespace.id);
  assert.deepEqual(
    (await f.service.listAgents("reader", f.namespace.id)).map((value) => value.id),
    [agent.id],
  );
  assert.deepEqual(
    (await f.service.listRevisions("reader", f.namespace.id, agent.id)).map((value) => value.id),
    [revision.id],
  );
  await assert.rejects(
    f.service.getAgent("reader", f.namespace.id, hidden.id),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    f.service.getRevision("reader", f.namespace.id, agent.id, hiddenRevision.id),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    f.service.getRevision("revision-reader", f.namespace.id, agent.id, revision.id),
    (error) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.equal(error.authorization.resource.kind, "agent");
      return true;
    },
  );
  await assert.rejects(
    f.service.listRevisions("revision-reader", f.namespace.id, agent.id),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    f.service.getRevision("admin", f.namespace.id, hidden.id, revision.id),
    ScopeViolationError,
  );
  assert.deepEqual(
    await f.service.getRevision("reader", f.namespace.id, agent.id, revision.id),
    revision,
  );
});

test("Draft edits preserve admitted immutable revisions and enclosing transaction rollback", async () => {
  const f = await fixture();
  const original = await f.configuration();
  const next = await f.configuration();
  const agent = await f.create(original.id);
  const revision = await f.revision(agent);
  await f.service.updateAgent("admin", {
    namespaceId: f.namespace.id,
    agentId: agent.id,
    configurationId: next.id,
    executionMode: "dedicated",
  });
  assert.deepEqual(
    await f.service.getRevision("admin", f.namespace.id, agent.id, revision.id),
    revision,
  );
  const before = await f.service.getAgent("admin", f.namespace.id, agent.id);
  const abort = new Error("enclosing operation failed after draft mutation");
  let transient;
  await assert.rejects(
    f.runner.transact(async () => {
      await f.service.updateAgent("admin", {
        namespaceId: f.namespace.id,
        agentId: agent.id,
        configurationId: original.id,
      });
      transient = await f.create(original.id);
      throw abort;
    }),
    (error) => error === abort,
  );
  assert.deepEqual(await f.service.getAgent("admin", f.namespace.id, agent.id), before);
  await assert.rejects(
    f.service.getAgent("admin", f.namespace.id, transient.id),
    ScopeViolationError,
  );
  assert.deepEqual(
    await f.service.getRevision("admin", f.namespace.id, agent.id, revision.id),
    revision,
  );
});

test("Agent execution limit admissions snapshot the draft and retain earlier selections", async () => {
  const f = await fixture();
  const cfg = await f.configuration();
  const agent = await f.create(cfg.id);
  assert.equal(agent.maximumExecutionMs, null);
  const uncapped = await f.revision(agent);
  assert.equal(uncapped.maximumExecutionMs, null);
  const input = { namespaceId: f.namespace.id, agentId: agent.id, configurationId: cfg.id };
  const capped = await f.service.updateAgent("admin", { ...input, maximumExecutionMs: 7_200_000 });
  assert.equal(capped.maximumExecutionMs, 7_200_000);
  const finite = await f.revision(capped, 2);
  assert.equal(finite.maximumExecutionMs, 7_200_000);
  const preserved = await f.service.updateAgent("admin", input);
  assert.equal(preserved.maximumExecutionMs, 7_200_000);
  const cleared = await f.service.updateAgent("admin", { ...input, maximumExecutionMs: null });
  assert.equal(cleared.maximumExecutionMs, null);
  const next = await f.revision(cleared, 3);
  assert.equal(next.maximumExecutionMs, null);
  assert.equal(
    (await f.service.getRevision("admin", f.namespace.id, agent.id, finite.id)).maximumExecutionMs,
    7_200_000,
  );
  assert.equal(
    (await f.service.getRevision("admin", f.namespace.id, agent.id, uncapped.id))
      .maximumExecutionMs,
    null,
  );
  // The memory adapter mirrors the database's new-write constraint.
  for (const maximumExecutionMs of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1000"]) {
    await assert.rejects(
      f.runner.transact((unit) =>
        unit.revisions.createRevision({
          ...next,
          id: id("rev"),
          revision: 4,
          maximumExecutionMs,
        }),
      ),
      ScopeViolationError,
    );
  }
});
