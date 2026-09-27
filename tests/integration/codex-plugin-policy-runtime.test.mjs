import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const executable = process.env.OCC_TEST_CODEX_APP_SERVER_BIN;
const nativeOptions = {
  skip: executable === undefined && "Set OCC_TEST_CODEX_APP_SERVER_BIN to a compatible app-server.",
  timeout: 30_000,
};

async function nativeRuntime(t, overrides = []) {
  const directory = await mkdtemp(join(tmpdir(), "oce-codex-policy-"));
  let child;
  let closed;
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const configPath = join(home, "config.toml");
  await writeFile(
    configPath,
    `[features]
apps = false
plugins = false
remote_plugin = false
[apps.stale]
enabled = true
[plugins."stale@fixture"]
enabled = true
`,
  );
  const token = randomBytes(24).toString("hex");
  child = spawn(
    executable,
    [
      ...overrides.flatMap((override) => ["-c", override]),
      "--listen",
      "ws://127.0.0.1:0",
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      createHash("sha256").update(token).digest("hex"),
    ],
    {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: home,
        CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  closed = new Promise((resolve) => child.once("close", resolve));
  let output = "";
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`App-server startup timed out: ${output}`)),
      10_000,
    );
    const finish = (error, value) => {
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(new Error(`App-server exited (${code}): ${output}`)));
    child.stderr.on("data", (chunk) => {
      output = (output + chunk).slice(-16_384);
      const match = output.match(/listening on: ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        finish(undefined, match[1]);
      }
    });
  });
  // Reuse the controller's existing real WebSocket dependency without adding a
  // production dependency or replacing the native transport/policy implementation.
  const controllerRequire = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  );
  const runtimeRequire = createRequire(controllerRequire.resolve("@kubernetes/client-node"));
  const context = vm.createContext({
    require: runtimeRequire,
    Buffer,
    setTimeout,
    clearTimeout,
    process: { env: { APP_SERVER_PORT: port, APP_SERVER_TOKEN: token, CODEX_HOME: home } },
  });
  vm.runInContext(PLUGIN_RUNTIME_HELPERS, context);
  return {
    run: (expression) => vm.runInContext(expression, context),
    read: () =>
      vm.runInContext(
        'codexAppServerRequest("config/read", {}).then((value) => value.config)',
        context,
      ),
    configPath,
  };
}

test(
  "Codex empty selection replaces stale native grants and reloads defaults",
  nativeOptions,
  async (t) => {
    const runtime = await nativeRuntime(t);
    const before = await runtime.read();
    assert.equal(before.apps.stale.enabled, true);
    assert.equal(before.plugins["stale@fixture"].enabled, true);

    await runtime.run("installCodexSelectionSet({})");

    const effective = await runtime.read();
    assert.equal(effective.apps._default?.enabled, false);
    assert.equal(effective.plugins._default?.enabled, false);
    assert.equal(effective.apps.stale, undefined);
    assert.equal(effective.plugins["stale@fixture"], undefined);
    for (const feature of ["apps", "plugins", "remote_plugin"]) {
      assert.equal(effective.features[feature], false);
    }
    assert.doesNotMatch(await readFile(runtime.configPath, "utf8"), /stale/);
  },
);

for (const table of ["apps", "plugins"]) {
  test(`Codex startup rejects an inherited unselected ${table} grant`, nativeOptions, async (t) => {
    const id = table === "apps" ? "inherited" : "inherited@fixture";
    const runtime = await nativeRuntime(t, [`${table}.${id}.enabled=true`]);
    const before = await runtime.read();
    assert.equal(before[table][id].enabled, true);

    await assert.rejects(
      runtime.run("installCodexSelectionSet({})"),
      new RegExp(`effective ${table} configuration enables an unselected entry`),
    );
    const effective = await runtime.read();
    assert.equal(effective[table]._default.enabled, false);
    assert.equal(effective[table][id].enabled, true);
  });
}
