import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const upstreamCommit = "daf5cfeeee98dbc6cdaa89361fba73a50efdb68c";
const enabled = process.env.OCC_TEST_UPSTREAM_HEADLESS === "1";
const fixture = fileURLToPath(
  new URL("../fixtures/upstream-headless-consumption/probe.mts", import.meta.url),
);

test(
  "pinned real upstream headless kernel lifecycle and request consumption",
  {
    skip:
      !enabled && "Set OCC_TEST_UPSTREAM_HEADLESS=1 and OCC_TEST_UPSTREAM_SOURCE_DIR to opt in.",
    timeout: 150_000,
  },
  async (t) => {
    const source = process.env.OCC_TEST_UPSTREAM_SOURCE_DIR;
    assert.ok(source && isAbsolute(source), "An absolute prepared upstream checkout is required.");
    const checkout = await realpath(source);
    const git = async (args) =>
      (
        await run("git", ["-C", checkout, ...args], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout.trim();
    assert.equal(await git(["rev-parse", "HEAD"]), upstreamCommit, "Unsupported upstream commit.");
    const dependencies = await realpath(process.env.OCC_TEST_UPSTREAM_DEPENDENCIES_DIR ?? checkout);
    const modules = await realpath(join(dependencies, "node_modules"));
    const directory = await mkdtemp(join(homedir(), ".oce-upstream-consumption-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const snapshot = join(directory, "source");
    const state = join(directory, "state");
    await mkdir(snapshot);
    await mkdir(state);
    // Archive committed bytes so unrelated local edits cannot silently change the probe.
    const archive = join(directory, "source.tar");
    await git(["archive", "--format=tar", `--output=${archive}`, upstreamCommit]);
    await run("tar", ["-xf", archive, "-C", snapshot], { timeout: 30_000 });
    await symlink(modules, join(snapshot, "node_modules"), "dir");
    // Upstream workspace packages have their own external dependency links. Reuse
    // those prepared links while the loader resolves upstream source in the archive.
    for (const area of ["packages", "extensions"]) {
      for (const entry of await readdir(join(snapshot, area), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const prepared = join(dependencies, area, entry.name, "node_modules");
        try {
          await access(prepared);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        await symlink(prepared, join(snapshot, area, entry.name, "node_modules"), "dir");
      }
    }
    const manifest = JSON.parse(await readFile(join(snapshot, "package.json"), "utf8"));
    assert.equal(manifest.version, "2026.8.1");
    assert.deepEqual(manifest.openclaw.schemaVersions, { state: 15, agent: 19 });
    const configPath = join(state, "openclaw.json");
    await writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          mode: "local",
          port: 19789,
          bind: "loopback",
          auth: { mode: "token", token: "synthetic-headless-probe-token" },
          controlUi: { enabled: false },
          tailscale: { mode: "off" },
          reload: { mode: "off" },
        },
        agents: { defaults: { workspace: join(directory, "workspace") } },
        plugins: { enabled: false },
        channels: {},
        browser: { enabled: false },
        cron: { enabled: false },
        discovery: { mdns: { mode: "off" } },
        update: { checkOnStart: false },
        logging: { level: "silent", consoleLevel: "silent", file: join(state, "gateway.log") },
      }),
      { mode: 0o600 },
    );
    // Pass only basic process settings; never inherit provider credentials, channel
    // credentials, personal OpenClaw settings, NODE_OPTIONS, or an ambient proxy.
    const env = Object.fromEntries(
      ["HOME", "PATH", "USER", "LOGNAME", "LANG", "SYSTEMROOT", "WINDIR"]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    );
    Object.assign(env, {
      OCC_TEST_UPSTREAM_SNAPSHOT: snapshot,
      OPENCLAW_HOME: directory,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_OAUTH_DIR: join(state, "credentials"),
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      TSX_TSCONFIG_PATH: join(snapshot, "tsconfig.json"),
      TSX_DISABLE_CACHE: "1",
    });
    // Use the already prepared upstream loader; the test never installs dependencies.
    const loader = join(snapshot, "node_modules/tsx/dist/esm/index.mjs");
    const result = await run(process.execPath, ["--import", loader, fixture], {
      cwd: snapshot,
      env,
      timeout: 90_000,
      killSignal: "SIGKILL",
      maxBuffer: 2 * 1024 * 1024,
    });
    const records = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("OCC_UPSTREAM_PROBE_RESULT "));
    assert.equal(records.length, 1, "Expected one completed real-kernel result.");
    const report = JSON.parse(records[0].slice("OCC_UPSTREAM_PROBE_RESULT ".length));
    assert.equal(report.protocol, 4);
    assert.deepEqual(report.observations, [
      "deferred startup is not ready",
      "chat.send is denied by the real startup gate",
      "host publishes readiness",
      "health uses the real request router and handler",
      "unscoped internal client is denied",
      "close drains readiness and fences retained lifecycle authority",
    ]);
    t.diagnostic(
      JSON.stringify({
        upstreamCommit,
        version: manifest.version,
        schemas: manifest.openclaw.schemaVersions,
        ...report,
      }),
    );
  },
);
