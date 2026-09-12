import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import {
  CONFIGURATION_KINDS,
  DRIVER_CAPABILITIES,
  LOGGING_LEVELS,
  admitLoggingConfiguration,
  admittedLoggingLevel,
  HARNESS_EXECUTION_MODES,
  RESOURCE_KINDS,
  SANDBOX_FACETS,
  freezeAgentRevision,
  isDriverCapability,
  isResourceKind,
  isSandboxFacet,
  normalizeLoggingLevel,
  normalizePluginDesiredState,
  validPluginRevisionState,
  SecretReference,
  SecretBinding,
} from "../../packages/contracts/src/index.ts";

const contractsRequire = createRequire(
  new URL("../../packages/contracts/package.json", import.meta.url),
);
const { Check } = contractsRequire("typebox/value");

test("the Driver contract exposes IAM, Compute, Configuration, ServiceAccount, Secret, Sandbox, and Plugin capabilities", () => {
  assert.deepEqual(DRIVER_CAPABILITIES, [
    "iam",
    "compute",
    "configuration",
    "service_account",
    "secret",
    "sandbox",
    "plugin",
  ]);
  assert.equal(Object.isFrozen(DRIVER_CAPABILITIES), true);

  for (const capability of DRIVER_CAPABILITIES) assert.equal(isDriverCapability(capability), true);
  for (const unsupported of ["gateway", "secrets", "providers", "legacy", "", undefined]) {
    assert.equal(isDriverCapability(unsupported), false);
  }
});

test("Configuration consumer kinds contain only the explicitly supported Agent kind", () => {
  assert.deepEqual(CONFIGURATION_KINDS, ["agent"]);
  assert.equal(Object.isFrozen(CONFIGURATION_KINDS), true);
});

test("Harness execution supports only explicit embedded and dedicated placement", () => {
  assert.deepEqual(HARNESS_EXECUTION_MODES, ["embedded", "dedicated"]);
  assert.equal(Object.isFrozen(HARNESS_EXECUTION_MODES), true);
});

test("Sandbox facets expose only the initial containment surfaces", () => {
  assert.deepEqual(SANDBOX_FACETS, ["networking", "filesystem", "process"]);
  assert.equal(Object.isFrozen(SANDBOX_FACETS), true);

  for (const facet of SANDBOX_FACETS) assert.equal(isSandboxFacet(facet), true);
  for (const unsupported of ["exec", "tool", "workspace", "network", "", undefined]) {
    assert.equal(isSandboxFacet(unsupported), false);
  }
});

test("logging helpers admit one platform-owned native JSON policy", () => {
  assert.deepEqual(LOGGING_LEVELS, ["debug", "info", "warn", "error"]);
  assert.equal(normalizeLoggingLevel(undefined), "info");
  assert.equal(normalizeLoggingLevel("debug"), "debug");
  for (const value of ["trace", "INFO", "", null]) {
    assert.throws(() => normalizeLoggingLevel(value), /debug, info, warn, or error/);
  }

  const draft = {
    logging: {
      level: "debug",
      consoleLevel: "error",
      consoleStyle: "pretty",
      redactSensitive: "off",
      keep: true,
    },
    diagnostics: { otel: { logs: true, traces: true }, retain: "diagnostics" },
    feature: "preserved",
  };
  const admitted = admitLoggingConfiguration(draft, "warn");
  assert.deepEqual(admitted, {
    logging: {
      level: "warn",
      consoleLevel: "warn",
      consoleStyle: "json",
      keep: true,
    },
    diagnostics: { otel: { logs: false, traces: true }, retain: "diagnostics" },
    feature: "preserved",
  });
  assert.deepEqual(draft.logging, {
    level: "debug",
    consoleLevel: "error",
    consoleStyle: "pretty",
    redactSensitive: "off",
    keep: true,
  });
  assert.equal(admittedLoggingLevel(admitted), "warn");

  for (const configuration of [
    {},
    {
      logging: {
        level: "info",
        consoleLevel: "debug",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
    },
    {
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "pretty",
      },
      diagnostics: { otel: { logs: false } },
    },
    {
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: true } },
    },
    {
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
        redactSensitive: "off",
      },
      diagnostics: { otel: { logs: false } },
    },
    {
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
        redactSensitive: "tools",
      },
      diagnostics: { otel: { logs: false } },
    },
  ]) {
    assert.throws(() => admittedLoggingLevel(configuration), /admitted|Admitted/);
  }
});

test("the singleton platform resource model keeps Namespace ownership explicit", () => {
  assert.deepEqual(RESOURCE_KINDS, [
    "installation",
    "namespace",
    "configuration",
    "service_account",
    "secret",
    "agent",
    "agent_revision",
  ]);
  assert.equal(Object.isFrozen(RESOURCE_KINDS), true);

  for (const kind of RESOURCE_KINDS) assert.equal(isResourceKind(kind), true);
  for (const unsupported of ["provider", "driver", "plugin", "gateway", "claw", "", undefined]) {
    assert.equal(isResourceKind(unsupported), false);
  }
});

test("an admitted AgentRevision is a detached and deeply immutable deployment snapshot", () => {
  const mutableRevision = {
    id: "revision-a-1",
    namespaceId: "namespace-a",
    agentId: "agent-a",
    revision: 1,
    providerId: null,
    configurationId: "configuration-a",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: { model: "gpt-test", temperature: "0", tool: "lookup" },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    compute: { id: "compute-test", implementation: "deterministic-fake" },
    sandboxDriverId: "sandbox-test",
    secretBindings: {
      MODEL_KEY: { source: { kind: "secret", id: "secret-a", namespaceId: "namespace-a" } },
    },
    plugins: {
      driver: { id: "plugins", implementation: "occ/plugins" },
      plugins: {
        calendar: { enabled: true, approvalMode: "prompt", tools: { read: { enabled: true } } },
      },
    },
    servicePrincipalId: "service-principal-agent-a",
    createdAt: "2026-08-15T00:00:00.000Z",
  };

  const admitted = freezeAgentRevision(mutableRevision);
  assert.notEqual(admitted, mutableRevision);
  assert.equal(Object.isFrozen(admitted), true);
  assert.equal(Object.isFrozen(admitted.configuration), true);
  assert.equal(Object.isFrozen(admitted.harness), true);
  assert.equal(Object.isFrozen(admitted.compute), true);
  assert.equal(Object.isFrozen(admitted.secretBindings.MODEL_KEY.source), true);
  assert.equal(Object.isFrozen(admitted.plugins.driver), true);
  assert.equal(Object.isFrozen(admitted.plugins.plugins.calendar.tools.read), true);
  assert.equal(admitted.sandboxDriverId, "sandbox-test");
  assert.equal(admitted.configurationId, "configuration-a");
  assert.equal(admitted.configurationKind, "agent");
  assert.equal(admitted.configurationGeneration, 1);

  mutableRevision.configuration.model = "modified-after-admission";
  mutableRevision.configuration.temperature = "1";
  mutableRevision.configuration.tool = "mutated-tool";
  mutableRevision.harness.version = "changed-after-admission";
  mutableRevision.harness.mode = "embedded";
  mutableRevision.compute.implementation = "changed-after-admission";
  mutableRevision.sandboxDriverId = "changed-after-admission";
  mutableRevision.secretBindings.MODEL_KEY.source.id = "changed-after-admission";
  mutableRevision.plugins.plugins.calendar.tools.read.enabled = false;

  assert.equal(admitted.secretBindings.MODEL_KEY.source.id, "secret-a");
  assert.equal(admitted.plugins.plugins.calendar.tools.read.enabled, true);
  assert.deepEqual(admitted.configuration, {
    model: "gpt-test",
    temperature: "0",
    tool: "lookup",
  });
  assert.deepEqual(admitted.harness, { id: "codex", version: "1.0.0", mode: "dedicated" });
  assert.deepEqual(admitted.compute, {
    id: "compute-test",
    implementation: "deterministic-fake",
  });
  assert.equal(admitted.sandboxDriverId, "sandbox-test");
  assert.throws(() => {
    admitted.configuration.model = "unauthorized-revision-mutation";
  }, TypeError);
  assert.throws(() => {
    admitted.configurationGeneration = 2;
  }, TypeError);
  assert.throws(() => {
    admitted.harness.version = "unauthorized-harness-mutation";
  }, TypeError);
  assert.throws(() => {
    admitted.harness.mode = "embedded";
  }, TypeError);
  assert.throws(() => {
    admitted.compute.implementation = "unauthorized-compute-mutation";
  }, TypeError);
  assert.throws(() => {
    admitted.sandboxDriverId = "unauthorized-sandbox-mutation";
  }, TypeError);
});

test("Secret schemas require exact references and supported delivery shapes", () => {
  const uuid = "12345678-1234-4234-8234-123456789abc";
  const reference = { kind: "secret", id: `sec_${uuid}`, namespaceId: `ns_${uuid}` };
  assert.equal(Check(SecretReference, reference), true);
  assert.equal(Check(SecretReference, { ...reference, value: "unrecognized-field" }), false);
  assert.equal(Check(SecretReference, { kind: "secret", id: reference.id }), false);
  assert.equal(Check(SecretReference, { ...reference, kind: "configuration" }), false);
  assert.equal(Check(SecretBinding, { source: reference, delivery: { type: "env" } }), true);
  assert.equal(Check(SecretBinding, { source: reference, delivery: { type: "file" } }), false);
  assert.equal(Check(SecretBinding, { source: reference, extra: true }), false);
});

test("plugin helpers validate selections and return detached immutable policy", () => {
  const desired = {
    calendar: { enabled: true, approvalMode: "prompt", tools: { read: { enabled: true } } },
  };
  const fail = (message) => {
    throw new Error(message);
  };
  const normalized = normalizePluginDesiredState(desired, fail);
  assert.deepEqual(normalized, desired);
  assert.notStrictEqual(normalized, desired);
  assert.equal(Object.isFrozen(normalized.calendar.tools.read), true);
  desired.calendar.tools.read.enabled = false;
  assert.equal(normalized.calendar.tools.read.enabled, true);
  assert.throws(
    () =>
      normalizePluginDesiredState(
        { calendar: { ...desired.calendar, approvalMode: "invalid" } },
        fail,
      ),
    /invalid/,
  );
  assert.equal(normalizePluginDesiredState(undefined, fail), undefined);
  const state = { driver: { id: "plugins", implementation: "occ/plugins" }, plugins: desired };
  assert.equal(validPluginRevisionState(state), true);
  assert.equal(validPluginRevisionState({ ...state, unexpected: true }), false);
  assert.equal(
    validPluginRevisionState({ ...state, driver: { id: "", implementation: "occ/plugins" } }),
    false,
  );
  assert.equal(validPluginRevisionState(undefined), true);
});
