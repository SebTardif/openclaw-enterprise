import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
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

test("the package root exports the canonical Secret schema objects", async () => {
  const contracts = await import(contractsRequire.resolve("@openclaw-enterprise/contracts"));
  for (const [name, schema] of Object.entries({ SecretReference, SecretBinding, SecretBindings })) {
    assert.strictEqual(contracts[name], schema, `The root must preserve ${name} identity`);
  }
});

test("root consumers can use each Secret name as both a type and schema value", () => {
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
