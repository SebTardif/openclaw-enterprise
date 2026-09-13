import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const compiler = fileURLToPath(
  new URL("./bin/tsc", import.meta.resolve("typescript/package.json")),
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

test("Secret contract types emit declarations without root-first traversal or prior output", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "enterprise-contract-declarations-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const configuration = join(fixture, "tsconfig.json");

  // Checking the root first can hide a schema re-export colliding with a local type.
  // Emit the owning module independently, using the real source and compiler settings.
  await writeFile(
    configuration,
    JSON.stringify({
      extends: join(root, "tsconfig.base.json"),
      compilerOptions: {
        composite: false,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: root,
        outDir: join(fixture, "dist"),
        typeRoots: [join(root, "node_modules/@types")],
      },
      files: [join(root, "packages/contracts/src/resources/secret.ts")],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [compiler, "--project", configuration, "--pretty", "false"],
    { cwd: root, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
