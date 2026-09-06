import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import {
  CommandFailure,
  executionOrder,
  goBuildCacheScope,
  runCommand,
  verifyFile,
} from "../../scripts/build-mvp.mjs";

const script = fileURLToPath(new URL("../../scripts/build-mvp.mjs", import.meta.url));
const moduleUrl = new URL("../../scripts/build-mvp.mjs", import.meta.url).href;

// These tests exercise the actual orchestration and filesystem checks. They do
// not replace Cargo, Docker, a compiler, or a runtime with simulated successes.
test("the build plan excludes image and live targets and shares native prerequisites", async () => {
  const output = await runCommand(process.execPath, [script, "--plan", "build"], {
    cwd: tmpdir(),
    capture: true,
  });
  const plan = JSON.parse(output);
  assert.deepEqual(
    plan.map(({ target }) => target),
    ["check-types", "check-native", "native-dns", "native-tls", "native", "build"],
  );
  assert.deepEqual(executionOrder("images"), [
    "runtime-image",
    "check-types",
    "image-controller",
    "check-native",
    "native-dns",
    "native-tls",
    "native",
    "egress-packages",
    "image-egress",
    "images",
  ]);
  assert.throws(() => executionOrder("install"), /Unknown build target/);
});

test("the runner passes literal argv without shell interpretation", async () => {
  const args = ["space separated", "$(must-not-run)", "; exit 27", "`must-not-run`"];
  const result = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args],
    { capture: true },
  );
  assert.deepEqual(JSON.parse(result), args);
});

test("a failed subprocess retains its status and stops subsequent work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oce-build-failure-"));
  try {
    const marker = join(directory, "unexpected-output");
    await assert.rejects(
      async () => {
        await runCommand(process.execPath, ["-e", "process.exit(23)"]);
        await writeFile(marker, "must not run");
      },
      (error) => error instanceof CommandFailure && error.exitCode === 23 && error.signal === null,
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("spawn failures identify the missing tool", async () => {
  await assert.rejects(
    runCommand("/nonexistent/oce-build-tool", []),
    (error) =>
      error instanceof CommandFailure &&
      error.exitCode === 1 &&
      /Cannot run.*oce-build-tool.*ENOENT/.test(error.message),
  );
});

test("a successful subprocess must still produce its declared output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oce-build-output-"));
  try {
    await runCommand(process.execPath, ["-e", "process.exit(0)"]);
    const artifact = join(directory, "artifact");
    await assert.rejects(verifyFile(artifact), /Required build file is missing/);
    await writeFile(artifact, "");
    await assert.rejects(verifyFile(artifact), /nonempty regular file/);
    await writeFile(artifact, "built output");
    await verifyFile(artifact);
    await assert.rejects(verifyFile(directory), /nonempty regular file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "a child killed by a signal cannot report a successful build",
  { skip: process.platform === "win32" },
  async () => {
    await assert.rejects(
      runCommand(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"]),
      (error) => error instanceof CommandFailure && error.signal === "SIGTERM",
    );
  },
);

test(
  "interrupting the runner terminates descendants and prevents dependent work",
  { skip: process.platform !== "linux", timeout: 15_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-build-signal-"));
    const marker = join(directory, "terminated");
    const next = join(directory, "unexpected-next-command");
    const descendantPidFile = join(directory, "descendant-pid");
    let descendantPid;
    // The direct child cooperates, but its real descendant ignores SIGTERM.
    // Readiness follows both handlers, so this proves group cleanup after the
    // direct tool exits rather than relying on process-start timing.
    const descendantSource = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
    const childSource = `const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'terminated'); process.exit(0); }); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'inherit' });`;
    const parentSource = `import { runCommand } from ${JSON.stringify(moduleUrl)};
    try { await runCommand(process.execPath, ['-e', ${JSON.stringify(childSource)}]); await runCommand(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(next)}, 'unexpected')`)}]); }
    catch (error) { process.stdout.write('observed:' + error.signal + '\\n'); process.exitCode = 128 + 15; }`;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", parentSource], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    context.after(async () => {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      if (descendantPid !== undefined) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      await rm(directory, { recursive: true, force: true });
    });
    let output = "";
    let errors = "";
    const completion = new Promise((resolve, reject) => {
      parent.once("error", reject);
      parent.once("close", (code, signal) => resolve({ code, signal }));
    });
    parent.stderr.setEncoding("utf8").on("data", (chunk) => {
      errors += chunk;
    });
    const ready = new Promise((resolveReady) => {
      parent.stdout.setEncoding("utf8").on("data", (chunk) => {
        output += chunk;
        if (output.includes("ready\n")) resolveReady();
      });
    });
    await Promise.race([
      ready,
      completion.then(() => {
        throw new Error(`Runner exited before readiness: ${errors}`);
      }),
    ]);
    descendantPid = Number(await readFile(descendantPidFile, "utf8"));
    parent.kill("SIGTERM");
    assert.deepEqual(await completion, { code: 143, signal: null });
    assert.match(output, /observed:SIGTERM/);
    assert.equal(await readFile(marker, "utf8"), "terminated");
    await assert.rejects(readFile(next), { code: "ENOENT" });
    // A killed orphan can briefly remain a zombie until the host reaps it;
    // either absence or zombie state establishes that it cannot keep working.
    const deadline = Date.now() + 2_000;
    while (true) {
      const state = await readFile(`/proc/${descendantPid}/stat`, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (state === null || /\) [ZX] /.test(state)) break;
      assert.ok(Date.now() < deadline, "The build descendant survived cancellation.");
      await setTimeout(10);
    }
    descendantPid = undefined;
  },
);

test("the CLI rejects unsupported targets without invoking build tools", async () => {
  await assert.rejects(
    runCommand(process.execPath, [script, "install"]),
    (error) => error instanceof CommandFailure && error.exitCode === 1,
  );
});

async function captureCli(target, environment) {
  const child = spawn(process.execPath, [script, target], {
    env: { ...process.env, PATH: "", ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    errors += chunk;
  });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  return { status, output, errors };
}

test("invalid image inputs fail before prerequisite commands run", async () => {
  // With no tools on PATH, configuration must still be the first diagnostic;
  // this invokes the actual CLI without providing a simulated Docker command.
  const result = await captureCli("image-egress", {
    OCC_BUILD_EGRESS_TAG: "example:latest",
    OCC_BUILD_EGRESS_BASE_IMAGE: "",
  });
  assert.equal(result.status, 1);
  assert.equal(result.output, "");
  assert.match(result.errors, /OCC_BUILD_EGRESS_TAG must select a tag other than latest/);
});

test("controller images require a pinned Go build input before any prerequisite runs", async () => {
  const nodeImage = `node:24@sha256:${"a".repeat(64)}`;
  for (const goImage of ["", "golang:1.26", `golang:1.26@sha256:${"B".repeat(64)}`]) {
    const result = await captureCli("image-controller", {
      OCC_BUILD_CONTROLLER_TAG: "controller:local",
      OCC_BUILD_NODE_BASE_IMAGE: nodeImage,
      OCC_BUILD_GO_BASE_IMAGE: goImage,
    });
    assert.equal(result.status, 1);
    assert.equal(result.output, "");
    assert.match(result.errors, /OCC_BUILD_GO_BASE_IMAGE must be a digest-pinned Go build image/);
  }
});

test("Go compiler cache namespaces follow canonical worktree directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oce-build-cache-scope-"));
  try {
    const first = join(directory, "first worktree");
    const second = join(directory, "second worktree");
    await mkdir(first);
    await mkdir(second);
    const scope = goBuildCacheScope(first);
    assert.match(scope, /^[a-f0-9]{64}$/);
    assert.equal(goBuildCacheScope(join(first, ".")), scope);
    assert.notEqual(goBuildCacheScope(second), scope);
    if (process.platform !== "win32") {
      const alias = join(directory, "worktree alias");
      await symlink(first, alias, "dir");
      assert.equal(goBuildCacheScope(alias), scope);
    }
    // An absent checkout cannot silently inherit some other directory's cache.
    assert.throws(() => goBuildCacheScope(join(directory, "missing")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the image command preserves both controller base digests and isolates egress inputs", async () => {
  const nodeImage = `node:24@sha256:${"a".repeat(64)}`;
  const goImage = `golang:1.26@sha256:${"b".repeat(64)}`;
  const egressImage = `debian:trixie@sha256:${"c".repeat(64)}`;
  // Inspect the actual command builder used by buildImage. This verifies argv
  // construction without substituting a Docker executable or claiming an image build.
  const inspect = async (kind, environment) =>
    JSON.parse(
      await runCommand(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { imageBuildArguments } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(imageBuildArguments(${JSON.stringify(kind)}, "output.image-id")));`,
        ],
        { cwd: tmpdir(), capture: true, env: { ...process.env, PATH: "", ...environment } },
      ),
    );
  const controller = await inspect("controller", {
    OCC_BUILD_CONTROLLER_TAG: "controller:local",
    OCC_BUILD_NODE_BASE_IMAGE: nodeImage,
    OCC_BUILD_GO_BASE_IMAGE: goImage,
    GO_BUILD_CACHE_SCOPE: "ambient-scope-must-not-select-another-worktrees-cache",
  });
  const buildArguments = (args) =>
    args.filter((_, index) => index > 0 && args[index - 1] === "--build-arg");
  assert.deepEqual(buildArguments(controller), [
    `NODE_BASE_IMAGE=${nodeImage}`,
    `GO_BASE_IMAGE=${goImage}`,
    `GO_BUILD_CACHE_SCOPE=${goBuildCacheScope()}`,
  ]);
  assert.equal(controller[controller.indexOf("--target") + 1], "runtime");
  const egress = await inspect("egress", {
    OCC_BUILD_EGRESS_TAG: "egress:local",
    OCC_BUILD_EGRESS_BASE_IMAGE: egressImage,
    OCC_BUILD_GO_BASE_IMAGE: "",
    OCC_BUILD_NODE_BASE_IMAGE: "",
  });
  assert.deepEqual(buildArguments(egress), [`EGRESS_BASE_IMAGE=${egressImage}`]);
  assert.ok(egress.includes("--network=none"));
  assert.ok(!egress.includes("--target"));
});
