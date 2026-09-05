import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import {
  CommandFailure,
  executionOrder,
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

test("invalid image inputs fail before prerequisite commands run", async () => {
  // With no tools on PATH, configuration must still be the first diagnostic;
  // this invokes the actual CLI without providing a simulated Docker command.
  const child = spawn(process.execPath, [script, "image-egress"], {
    env: {
      ...process.env,
      PATH: "",
      OCC_BUILD_EGRESS_TAG: "example:latest",
      OCC_BUILD_EGRESS_BASE_IMAGE: "",
    },
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
  assert.equal(status, 1);
  assert.equal(output, "");
  assert.match(errors, /OCC_BUILD_EGRESS_TAG must select a tag other than latest/);
});
