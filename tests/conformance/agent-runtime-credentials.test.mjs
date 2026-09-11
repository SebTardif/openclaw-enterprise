import assert from "node:assert/strict";
import test from "node:test";
import { MutationRunner } from "../../packages/occ/src/application/mutation-runner.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { AGENT_REPOSITORIES } from "../../packages/occ/src/services/agent/port.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import {
  DependencyUnavailableError,
  DriverSelectionError,
  ResourceConflictError,
} from "../../packages/occ/src/errors.ts";
import { AgentService } from "../../packages/occ/src/services/agent/service.ts";

const status = Object.freeze({
  transportConfigured: true,
  modelConfigured: true,
  slackConfigured: false,
});

// The real state and mutation projections enforce the stored draft boundary.
// Driver and authorization stubs provide no profile admission or production authority.
async function fixture({
  agent: agentFields = {},
  metadata = () => status,
  callback = true,
  historicalRevision = false,
} = {}) {
  const now = "2026-09-11T00:00:00.000Z";
  const installation = { id: "installation", name: "Credential test", createdAt: now };
  const namespace = {
    id: "namespace",
    name: "Credential namespace",
    status: "ready",
    createdAt: now,
  };
  const agent = {
    id: "agent",
    name: "Credential agent",
    namespaceId: namespace.id,
    configurationId: "cfg_00000000-0000-4000-8000-000000000005",
    executionMode: "embedded",
    providerId: null,
    maximumExecutionMs: null,
    servicePrincipalId: "agent-principal",
    createdAt: now,
    ...agentFields,
  };
  const configuration = {
    id: "cfg_00000000-0000-4000-8000-000000000005",
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    values: {},
    driverId: "configuration",
    createdAt: now,
  };
  const state = new InMemoryPlatformState();
  const runner = new MutationRunner(installation, state);
  await runner.transact(async (unit) => {
    await unit.namespaces.createNamespace(namespace);
    await unit.configurations.createConfiguration(configuration);
    await unit.agents.createAgent(agent);
    if (historicalRevision) {
      await unit.revisions.createRevision(
        Object.freeze({
          id: "revision",
          namespaceId: namespace.id,
          agentId: agent.id,
          revision: 1,
          maximumExecutionMs: null,
          providerId: null,
          configurationId: configuration.id,
          configurationKind: "agent",
          configurationGeneration: configuration.generation,
          configuration: {},
          harness: Object.freeze({ id: "fixture", version: "1", mode: "embedded" }),
          compute: Object.freeze({ id: "fixture", implementation: "credential-fixture" }),
          servicePrincipalId: agent.servicePrincipalId,
          createdAt: now,
        }),
      );
    }
  });
  const authorizations = [];
  const calls = [];
  const driver = {
    async getAgentRuntimeCredentialStatus(binding) {
      calls.push({ operation: "status", binding });
      return metadata();
    },
    async provisionAgentRuntimeCredentials(binding, input) {
      calls.push({ operation: "provision", binding, input });
      return metadata();
    },
  };
  let selections = 0;
  const service = new AgentService({
    repositories: runner.forRepositories(AGENT_REPOSITORIES),
    providers: new Map(),
    assertSecretDriverOwner: () => {},
    createId: () => "unused-agent",
    now: () => now,
    authorization: {
      authorize: async (principalId, action, resource) => {
        authorizations.push({ principalId, action, resource });
      },
    },
    ...(callback
      ? {
          runtimeCredentialComputeDriver: () => {
            selections += 1;
            return driver;
          },
        }
      : {}),
  });
  return { service, calls, authorizations, selections: () => selections };
}

test("legacy credential provisioning rejects a selected workload profile before Driver access", async () => {
  const f = await fixture({
    agent: {
      workloadProfileSelection: {
        manifestRef: "00000000-0000-4000-8000-000000000020",
        manifestDigest: `sha256:${"a".repeat(64)}`,
        admissionRef: "00000000-0000-4000-8000-000000000021",
        admissionVersion: 1,
      },
    },
  });
  await assert.rejects(
    f.service.provisionAgentRuntimeCredentials("actor", "namespace", "agent", {}),
    (error) =>
      error instanceof ResourceConflictError && /workload profile selection/.test(error.message),
  );
  assert.equal(f.selections(), 0);
  assert.deepEqual(f.calls, []);
});

test("legacy credentials retain exact authorization and return frozen allowlisted metadata", async () => {
  const f = await fixture({ metadata: () => ({ ...status, modelApiKey: "must-not-return" }) });
  const result = await f.service.provisionAgentRuntimeCredentials("actor", "namespace", "agent", {
    modelApiKey: "model-key",
    slack: { appToken: "app-token", botToken: "bot-token" },
  });
  assert.deepEqual(result, status);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(
    f.authorizations,
    ["read", "operate"].map((action) => ({
      principalId: "actor",
      action,
      resource: { kind: "agent", id: "agent", namespaceId: "namespace" },
    })),
  );
  assert.equal(Object.isFrozen(f.calls[0].input), true);
  assert.equal(Object.isFrozen(f.calls[0].input.slack), true);
});

test("credential status sanitizes null, malformed metadata, and throwing Driver getters", async () => {
  for (const metadata of [
    () => null,
    () => ({ ...status, modelConfigured: "secret-value" }),
    () => ({
      get transportConfigured() {
        throw new Error("secret-value");
      },
    }),
  ]) {
    const f = await fixture({ metadata });
    for (const operation of [
      () => f.service.getAgentRuntimeCredentialStatus("actor", "namespace", "agent"),
      () => f.service.provisionAgentRuntimeCredentials("actor", "namespace", "agent", {}),
    ]) {
      await assert.rejects(operation(), (error) => {
        assert.ok(error instanceof DependencyUnavailableError);
        assert.equal(error.message.includes("secret-value"), false);
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  }
});

test("AgentService without credential selection fails closed for both credential operations", async () => {
  const f = await fixture({ callback: false });
  await assert.rejects(
    f.service.getAgentRuntimeCredentialStatus("actor", "namespace", "agent"),
    DependencyUnavailableError,
  );
  await assert.rejects(
    f.service.provisionAgentRuntimeCredentials("actor", "namespace", "agent", {}),
    DependencyUnavailableError,
  );
  assert.deepEqual(f.calls, []);
});

test("compute registration accepts absent credential hooks and rejects non-callable hooks", () => {
  const compute = () => ({
    id: "compute",
    capability: "compute",
    implementation: "credential-fixture",
    async ensureNamespace() {},
    async deleteNamespace() {},
    async prepareRevision() {},
    async retireRevision() {},
  });
  assert.doesNotThrow(() => new DriverSelection().registerDriver(compute()));
  for (const method of ["getAgentRuntimeCredentialStatus", "provisionAgentRuntimeCredentials"]) {
    assert.throws(
      () => new DriverSelection().registerDriver({ ...compute(), [method]: true }),
      DriverSelectionError,
    );
  }
});

// A retained historical row is sufficient; no deployment/admission handle is invented.
test("legacy provisioning rejects genuine retained revision history before Driver access", async () => {
  const f = await fixture({ historicalRevision: true });
  await assert.rejects(
    f.service.provisionAgentRuntimeCredentials("actor", "namespace", "agent", {}),
    (error) => error instanceof ResourceConflictError && /historical revisions/.test(error.message),
  );
  assert.equal(f.selections(), 0);
  assert.deepEqual(f.calls, []);
});
