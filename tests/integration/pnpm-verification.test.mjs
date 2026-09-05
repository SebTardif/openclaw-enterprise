import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const repositoryManifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url)));
const workspacePolicy = readFileSync(new URL("../../pnpm-workspace.yaml", import.meta.url), "utf8");

test("pnpm run and exec reject stale preparation without installing or running lifecycle hooks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "oce-pnpm-verification-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
  };
  // pnpm scripts pass verifyDepsBeforeRun=false to children. Clear inherited
  // package-manager overrides so this fixture exercises the repository policy.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:npm|pnpm)_config_/i.test(name)),
  );
  Object.assign(env, {
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    npm_config_manage_package_manager_versions: "false",
    pnpm_config_offline: "true",
    pnpm_config_store_dir: join(root, ".store"),
    NPM_CONFIG_USERCONFIG: join(root, ".npmrc"),
    XDG_CONFIG_HOME: join(root, ".config"),
    XDG_DATA_HOME: join(root, ".data"),
    XDG_CACHE_HOME: join(root, ".cache"),
  });
  const run = (args) =>
    spawnSync("pnpm", args, { cwd: root, env, encoding: "utf8", timeout: 20000 });
  const version = run(["--version"]);
  const expectedVersion = repositoryManifest.packageManager.split("@")[1].split("+")[0];
  if (version.error?.code === "ENOENT") {
    t.skip("Pinned pnpm is unavailable; this integration requires the real package manager.");
    return;
  }
  assert.equal(version.status, 0, version.stderr);
  assert.equal(
    version.stdout.trim(),
    expectedVersion,
    "Prepare the repository's pinned pnpm separately.",
  );

  const manifest = {
    name: "oce-pnpm-verification-fixture",
    version: "1.0.0",
    private: true,
    packageManager: repositoryManifest.packageManager,
    scripts: { prepare: "node prepare.cjs", probe: "node probe.cjs" },
  };
  put("package.json", manifest);
  put("pnpm-workspace.yaml", workspacePolicy);
  put("packages/utils/package.json", {
    name: "oce-fixture-dependency",
    version: "1.0.0",
    private: true,
  });
  put(
    "prepare.cjs",
    "require('node:fs').writeFileSync('prepare-ran', 'unexpected preparation');\n",
  );
  put("probe.cjs", "require('node:fs').appendFileSync('probe.log', 'probe\\n');\n");

  const setup = () => {
    // Setup is explicit, offline, and confined to this disposable workspace.
    // Its only dependency is the local fixture package; no registry is needed.
    const result = run(["install", "--offline", "--ignore-scripts"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(join(root, "prepare-ran")), false);
  };
  const commands = [
    ["run", "probe"],
    ["exec", "node", "probe.cjs"],
  ];
  const assertRuns = () => {
    for (const args of commands) {
      const before = existsSync(join(root, "probe.log"))
        ? readFileSync(join(root, "probe.log"), "utf8")
        : "";
      const result = run(args);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(readFileSync(join(root, "probe.log"), "utf8"), `${before}probe\n`);
      assert.equal(existsSync(join(root, "prepare-ran")), false);
    }
  };
  const assertRejectsWithoutRepair = () => {
    const lock = readFileSync(join(root, "pnpm-lock.yaml"));
    const before = readFileSync(join(root, "probe.log"));
    for (const args of commands) {
      const result = run(args);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /ERR_PNPM_VERIFY_DEPS_BEFORE_RUN/);
      assert.deepEqual(readFileSync(join(root, "pnpm-lock.yaml")), lock);
      assert.deepEqual(readFileSync(join(root, "probe.log")), before);
      assert.equal(existsSync(join(root, "prepare-ran")), false);
    }
  };

  setup();
  assertRuns();
  // Editing a script leaves the dependency graph valid and must remain cheap.
  manifest.scripts.another = "node probe.cjs";
  put("package.json", manifest);
  assertRuns();

  // A real dependency change requires explicit preparation before either
  // command can execute; pnpm must not repair the graph or invoke prepare.
  manifest.dependencies = { "oce-fixture-dependency": "workspace:*" };
  put("package.json", manifest);
  assertRejectsWithoutRepair();
  assert.equal(existsSync(join(root, "node_modules/oce-fixture-dependency")), false);
  setup();
  assertRuns();
  rmSync(join(root, "node_modules/.pnpm-workspace-state-v1.json"));
  assertRejectsWithoutRepair();
  assert.equal(existsSync(join(root, "node_modules/.pnpm-workspace-state-v1.json")), false);
});
