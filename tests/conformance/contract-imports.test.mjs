import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { freezeAgentRevision } from "../../packages/contracts/src/resources/agent.ts";
import {
  normalizePluginDesiredState,
  validPluginRevisionState,
} from "../../packages/contracts/src/resources/plugin.ts";
import { normalizeSecretBindings } from "../../packages/contracts/src/secret-bindings.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/logging.ts";
import {
  SecretReference,
  SecretBinding,
  SecretBindings,
} from "../../packages/contracts/src/api/common.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const contractsRequire = createRequire(
  new URL("../../packages/contracts/package.json", import.meta.url),
);

test("the package root preserves canonical runtime helpers and Secret schemas", async () => {
  const contracts = await import(contractsRequire.resolve("@openclaw-enterprise/contracts"));
  for (const [name, value] of Object.entries({
    freezeAgentRevision,
    normalizePluginDesiredState,
    validPluginRevisionState,
    normalizeSecretBindings,
    admitLoggingConfiguration,
    SecretReference,
    SecretBinding,
    SecretBindings,
  })) {
    assert.strictEqual(contracts[name], value, `The root must preserve ${name} identity`);
  }
});

test("root consumers and real Drivers compile with positive and negative NodeNext contracts", () => {
  const compiler = fileURLToPath(
    new URL("./bin/tsc", import.meta.resolve("typescript/package.json")),
  );
  const result = spawnSync(
    process.execPath,
    [
      compiler,
      "--project",
      "packages/contracts/test-fixtures/imports/consumer.tsconfig.json",
      "--pretty",
      "false",
    ],
    { cwd: root, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
