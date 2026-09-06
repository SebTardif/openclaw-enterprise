import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixturePath = "tests/fixtures/runtime-authority-v1";
const projects = ["producer", "credential-consumer", "run-consumer", "type-negatives"];
const compiler = join(root, "node_modules/typescript/bin/tsc");

async function projectSet(directory) {
  const fixtures = join(directory, fixturePath);
  await mkdir(fixtures, { recursive: true });
  await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
  for (const project of projects) {
    const config = JSON.parse(
      await readFile(join(root, fixturePath, `tsconfig.${project}.json`), "utf8"),
    );
    // This small declaration boundary tests the cache policy from each real
    // configuration; the documented full fixtures own SDK and application coverage.
    config.compilerOptions.types = [];
    config.compilerOptions.lib = ["ES2022"];
    await writeFile(join(fixtures, `tsconfig.${project}.json`), JSON.stringify(config));
    const source =
      project === "type-negatives"
        ? 'import type { Value } from "./contract.js";\n// @ts-expect-error A string is outside the current declaration.\nconst rejected: Value = "invalid";\nvoid rejected;\n'
        : 'import type { Value } from "./contract.js";\nconst accepted: Value = 1;\nvoid accepted;\n';
    await writeFile(join(fixtures, `${project}.ts`), source);
  }
  const declaration = join(fixtures, "contract.d.ts");
  await writeFile(declaration, "export type Value = number;\n");
  return { directory, fixtures, declaration };
}

function compile(state, project, expected = 0) {
  const result = spawnSync(
    process.execPath,
    [compiler, "--project", join(state.fixtures, `tsconfig.${project}.json`), "--pretty", "false"],
    { cwd: state.directory, encoding: "utf8", timeout: 30_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  if (expected === "type-error") {
    // TypeScript returns 2 when it writes build information with diagnostics,
    // and 1 when a warm failed check has no new output to write.
    assert.ok([1, 2].includes(result.status), result.stdout + result.stderr);
  } else {
    assert.equal(result.status, expected, result.stdout + result.stderr);
  }
  return result.stdout + result.stderr;
}

async function cachePaths(state) {
  return Promise.all(
    projects.map(async (project) => {
      const config = JSON.parse(
        await readFile(join(state.fixtures, `tsconfig.${project}.json`), "utf8"),
      );
      return realpath(resolve(state.fixtures, config.compilerOptions.tsBuildInfoFile));
    }),
  );
}

test("runtime authority incremental projects invalidate declaration consumers and keep caches separate", async () => {
  const build = join(root, ".build");
  await mkdir(build, { recursive: true });
  const owned = await mkdtemp(join(build, "runtime-authority-incremental-test-"));
  try {
    const first = await projectSet(join(owned, "first"));
    const second = await projectSet(join(owned, "second"));
    for (const state of [first, second]) {
      for (const project of projects) compile(state, project);
    }
    const firstCaches = await cachePaths(first);
    const secondCaches = await cachePaths(second);
    assert.equal(new Set([...firstCaches, ...secondCaches]).size, projects.length * 2);
    for (const [state, paths] of [
      [first, firstCaches],
      [second, secondCaches],
    ]) {
      for (const path of paths) assert.ok(path.startsWith(join(state.directory, ".build") + sep));
    }
    const otherBytes = await Promise.all(secondCaches.map((path) => readFile(path)));
    for (const project of projects) compile(first, project);

    const leaf = join(first.fixtures, "producer.ts");
    const originalLeaf = await readFile(leaf, "utf8");
    await writeFile(leaf, originalLeaf.replace("= 1;", "= false;"));
    assert.match(compile(first, "producer", "type-error"), /error TS2322/);
    await writeFile(leaf, originalLeaf);
    compile(first, "producer");

    const producerConfig = join(first.fixtures, "tsconfig.producer.json");
    const originalConfig = await readFile(producerConfig, "utf8");
    const permissiveConfig = JSON.parse(originalConfig);
    permissiveConfig.compilerOptions.noUncheckedIndexedAccess = false;
    await writeFile(producerConfig, JSON.stringify(permissiveConfig));
    await writeFile(leaf, "const selected: number = [1][0];\nvoid selected;\n");
    compile(first, "producer");
    // Changing the configuration must invalidate a cached result even when
    // neither the source nor its declaration input changes.
    await writeFile(producerConfig, originalConfig);
    assert.match(compile(first, "producer", "type-error"), /error TS2322/);
    await writeFile(leaf, originalLeaf);
    compile(first, "producer");

    // Every positive declaration consumer must fail after a formerly accepted
    // public type changes. A cached successful result cannot hide the edit.
    await writeFile(first.declaration, "export type Value = boolean;\n");
    for (const project of projects.filter((value) => value !== "type-negatives")) {
      assert.match(compile(first, project, "type-error"), /error TS2322/);
      assert.match(compile(first, project, "type-error"), /error TS2322/);
    }

    // Widening the declaration invalidates the expected-negative fixture too:
    // an assertion that no longer rejects must become an unused-directive error.
    await writeFile(first.declaration, "export type Value = number | string;\n");
    assert.match(compile(first, "type-negatives", "type-error"), /error TS2578/);
    await writeFile(first.declaration, "export type Value = number;\n");
    for (const project of projects) compile(first, project);
    for (let index = 0; index < secondCaches.length; index++) {
      assert.deepEqual(await readFile(secondCaches[index]), otherBytes[index]);
    }
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
});
