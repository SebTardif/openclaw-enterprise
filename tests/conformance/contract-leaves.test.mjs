import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as contracts from "@openclaw-enterprise/contracts";
import { consumeRevision } from "../fixtures/contract-imports/consumer.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const contractsRequire = createRequire(import.meta.resolve("@openclaw-enterprise/contracts"));
const { Check } = contractsRequire("typebox/value");

const resourceLeaves = [
  "resources/scope",
  "resources/installation",
  "resources/namespace",
  "resources/configuration",
  "resources/agent",
  "resources/secret",
  "resources/service-account",
];
const identityLeaves = ["identity/identity", "identity/authorization", "identity/audit"];
const driverLeaves = [
  "drivers/base",
  "drivers/provider",
  "drivers/compute",
  "drivers/configuration",
  "drivers/secret",
  "drivers/iam",
  "drivers/sandbox",
  "drivers/service-account",
];
const canonicalModules = [
  "logging",
  "secret-bindings",
  "security-events",
  "account-authority-v1",
  "runtime-assignment",
  "runtime-authority-v1",
  "channel-bindings",
  "api/common",
  "api/resources",
  "api/routes",
  "api/channel-bindings",
];

test("supported contract subpaths resolve to canonical modules and existing root exports", async () => {
  for (const subpath of [
    ...resourceLeaves,
    ...identityLeaves,
    ...driverLeaves,
    ...canonicalModules,
  ]) {
    const leaf = await import(`@openclaw-enterprise/contracts/${subpath}`);
    const canonical = await import(
      new URL(`../../packages/contracts/src/${subpath}.ts`, import.meta.url)
    );
    assert.deepEqual(Object.keys(leaf), Object.keys(canonical));
    for (const [name, value] of Object.entries(leaf)) {
      assert.strictEqual(
        value,
        canonical[name],
        `${subpath} must share the canonical export ${name}`,
      );
      // Channel HTTP schemas have their own entrypoint and were never root exports.
      if (subpath !== "api/channel-bindings") {
        assert.strictEqual(contracts[name], value, `${subpath} must share the root export ${name}`);
      }
    }
  }
});

test("producer and consumer subpaths preserve immutable revision snapshots", () => {
  const uuid = "12345678-1234-4234-8234-123456789abc";
  const configuration = {
    id: `cfg_${uuid}`,
    namespaceId: `ns_${uuid}`,
    kind: "agent",
    generation: 1,
    values: { agents: { defaults: { model: "configured-model" } } },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const bindings = {
    MODEL_KEY: { source: { kind: "secret", id: `sec_${uuid}`, namespaceId: `ns_${uuid}` } },
  };
  const revision = consumeRevision(configuration, bindings);
  assert.equal(revision.configurationId, configuration.id);
  assert.equal(revision.configurationGeneration, 1);
  assert.deepEqual(revision.configuration, configuration.values);
  assert.deepEqual(revision.secretBindings, bindings);
  assert.equal(Object.isFrozen(revision), true);
  assert.equal(Object.isFrozen(revision.configuration.agents.defaults), true);
  assert.equal(Object.isFrozen(revision.secretBindings.MODEL_KEY.source), true);
  assert.throws(() => {
    revision.configuration.agents.defaults.model = "changed";
  }, TypeError);
  configuration.values.agents.defaults.model = "changed";
  bindings.MODEL_KEY.source.id = `sec_${"23456789-2345-4345-8345-23456789abcd"}`;
  assert.equal(revision.configuration.agents.defaults.model, "configured-model");
  assert.equal(revision.secretBindings.MODEL_KEY.source.id, `sec_${uuid}`);
  assert.equal(Object.hasOwn(consumeRevision(configuration), "secretBindings"), false);
});

test("canonical Secret schemas preserve exact shapes and reject unknown or missing scope", async () => {
  const common = await import("@openclaw-enterprise/contracts/api/common");
  const uuid = "12345678-1234-4234-8234-123456789abc";
  const reference = { kind: "secret", id: `sec_${uuid}`, namespaceId: `ns_${uuid}` };
  assert.strictEqual(contracts.SecretReference, common.SecretReference);
  assert.strictEqual(contracts.SecretBinding, common.SecretBinding);
  assert.strictEqual(contracts.SecretBindings, common.SecretBindings);
  assert.equal(Check(common.SecretReference, reference), true);
  assert.equal(Check(common.SecretReference, { ...reference, value: "unrecognized-field" }), false);
  assert.equal(Check(common.SecretReference, { kind: "secret", id: reference.id }), false);
  assert.equal(Check(common.SecretReference, { ...reference, kind: "configuration" }), false);
  assert.equal(Check(common.SecretBinding, { source: reference, delivery: { type: "env" } }), true);
  assert.equal(
    Check(common.SecretBinding, { source: reference, delivery: { type: "file" } }),
    false,
  );
  assert.equal(Check(common.SecretBinding, { source: reference, extra: true }), false);
});

test("security-event errors retain one constructor through root and subpath imports", async () => {
  const securityEvents = await import("@openclaw-enterprise/contracts/security-events");
  assert.strictEqual(
    contracts.SecurityEventContractError,
    securityEvents.SecurityEventContractError,
  );
  assert.throws(
    () => securityEvents.parseSecurityEvent({}),
    (error) =>
      error instanceof contracts.SecurityEventContractError &&
      error instanceof securityEvents.SecurityEventContractError,
  );
});

for (const fixture of ["producer", "consumer"]) {
  test(`independent ${fixture} compiles with supported NodeNext package entrypoints`, () => {
    const compiler = fileURLToPath(
      new URL("./bin/tsc", import.meta.resolve("typescript/package.json")),
    );
    const result = spawnSync(
      process.execPath,
      [
        compiler,
        "--project",
        `tests/fixtures/contract-imports/${fixture}.tsconfig.json`,
        "--pretty",
        "false",
      ],
      { cwd: root, encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
