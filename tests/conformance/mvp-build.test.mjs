import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import {
  CommandFailure,
  assertBuildInputsUnchanged,
  captureBuildInputs,
  executionOrder,
  goBuildCacheScope,
  runCommand,
  stageNativeArtifact,
  verifyFile,
  writeNativeManifest,
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
  "native staging binds real bytes and observed ownership to a nonwritable executable",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "oce-native-stage-"));
    try {
      const source = join(directory, "source");
      const bytes = Buffer.from("inert artifact bytes\0with a second line\n");
      await writeFile(source, bytes);
      for (const mode of [0o755, 0o555]) {
        await chmod(source, mode);
        const output = join(directory, `staged-${mode}`);
        const { observation } = await stageNativeArtifact(source, output);
        const actual = await lstat(output);
        assert.deepEqual(await readFile(output), bytes);
        assert.deepEqual(observation, {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
          uid: actual.uid,
          gid: actual.gid,
          mode: "0555",
        });
        assert.equal(actual.mode & 0o7777, 0o555);
        assert.equal(actual.uid, process.getuid());
        assert.notEqual(actual.ino, (await lstat(source)).ino);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "native staging refuses missing, empty, nonregular, aliased, oversized and unsafe inputs",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "oce-native-refusal-"));
    try {
      const source = join(directory, "source");
      const output = join(directory, "output");
      await assert.rejects(stageNativeArtifact(source, output), { code: "ENOENT" });
      await writeFile(source, "", { mode: 0o755 });
      await assert.rejects(stageNativeArtifact(source, output), /nonempty regular build input/);
      await assert.rejects(stageNativeArtifact(directory, output), /regular build input/);
      await assert.rejects(stageNativeArtifact("/dev/null", output), /regular build input/);
      await writeFile(source, "artifact");
      for (const mode of [0o775, 0o777, 0o4755]) {
        await chmod(source, mode);
        await assert.rejects(stageNativeArtifact(source, output), /unsafe write or special mode/);
      }
      await chmod(source, 0o644);
      await assert.rejects(stageNativeArtifact(source, output), { code: "EACCES" });
      // Ordinary declarations remain valid without executable or artifact modes.
      await chmod(source, 0o666);
      await verifyFile(source);
      await chmod(source, 0o755);
      await symlink(source, join(directory, "alias"));
      await assert.rejects(stageNativeArtifact(join(directory, "alias"), output), /canonical/);
      await assert.rejects(stageNativeArtifact(`${directory}/./source`, output), /canonical/);
      await symlink(directory, join(directory, "parent-alias"));
      await assert.rejects(
        stageNativeArtifact(source, join(directory, "parent-alias", "output")),
        /canonical parent/,
      );
      await assert.rejects(stageNativeArtifact(source, output, { maxBytes: 3 }), /byte limit/);
      await assert.rejects(
        stageNativeArtifact(source, output, { maxBytes: Infinity }),
        /byte limit/,
      );
      await assert.rejects(lstat(output), { code: "ENOENT" });
      await writeFile(output, "existing destination");
      await assert.rejects(stageNativeArtifact(source, output), { code: "EEXIST" });
      assert.equal(await readFile(output, "utf8"), "existing destination");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "native staging detects source replacement, rewrites and permission changes during copying",
  { skip: process.platform !== "linux", timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "oce-native-race-"));
    try {
      for (const mutation of ["replace", "rewrite", "chmod"]) {
        const source = join(directory, "source");
        const replacement = join(directory, "replacement");
        const output = join(directory, "output");
        const bytes = Buffer.alloc(2 * 1024 * 1024, 42);
        await writeFile(source, bytes);
        await chmod(source, 0o755);
        await writeFile(replacement, bytes, { mode: 0o755 });
        let observer;
        // Creation of the real destination occurs after the source descriptor's
        // initial validation. Mutate the actual file while its bounded copy runs.
        const changed = new Promise((resolveChanged, reject) => {
          observer = watch(directory, (event, name) => {
            if (event !== "rename" || name !== "output") return;
            observer.close();
            const change =
              mutation === "replace"
                ? rename(replacement, source)
                : mutation === "rewrite"
                  ? writeFile(source, Buffer.alloc(bytes.length, 43))
                  : chmod(source, 0o775);
            change.then(resolveChanged, reject);
          });
          observer.once("error", reject);
        });
        try {
          const result = stageNativeArtifact(source, output).then(
            () => ({ error: null }),
            (error) => ({ error }),
          );
          await changed;
          assert.match(
            (await result).error?.message ?? "unexpected successful staging",
            /changed|truncated|grew/,
          );
          await assert.rejects(lstat(output), { code: "ENOENT" });
        } finally {
          observer.close();
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "native staging closes descriptors after validation and destination failures",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "oce-native-fds-"));
    try {
      const source = join(directory, "source");
      const output = join(directory, "output");
      await writeFile(source, "inert bytes", { mode: 0o755 });
      await writeFile(output, "existing");
      const before = (await readdir("/proc/self/fd")).length;
      for (let attempt = 0; attempt < 12; attempt++) {
        await assert.rejects(stageNativeArtifact(directory, output), /regular build input/);
        await assert.rejects(stageNativeArtifact(source, output), { code: "EEXIST" });
      }
      assert.equal((await readdir("/proc/self/fd")).length, before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("build input provenance captures local payloads and refuses changes even when bytes are restored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oce-native-inputs-"));
  try {
    await mkdir(join(directory, "package", "include"), { recursive: true });
    await writeFile(join(directory, "Cargo.lock"), "selected dependency bytes\n");
    await writeFile(join(directory, "package", "include", "local.h"), "local header bytes\n");
    const paths = ["package", "Cargo.lock"];
    const before = await captureBuildInputs(directory, paths);
    assert.deepEqual(
      before.manifest.files.map(({ path }) => path),
      ["Cargo.lock", "package/include/local.h"],
    );
    assertBuildInputsUnchanged(before, await captureBuildInputs(directory, paths));
    await writeFile(join(directory, "Cargo.lock"), "different dependency bytes\n");
    const changed = await captureBuildInputs(directory, paths);
    assert.notEqual(changed.manifest.sha256, before.manifest.sha256);
    assert.throws(() => assertBuildInputsUnchanged(before, changed), /inputs changed/);
    await writeFile(join(directory, "Cargo.lock"), "selected dependency bytes\n");
    const restored = await captureBuildInputs(directory, paths);
    assert.equal(restored.manifest.sha256, before.manifest.sha256);
    assert.throws(() => assertBuildInputsUnchanged(before, restored), /inputs changed/);
    // There is deliberately no Git repository: tracking state never filters
    // the actual package payload, including empty and previously absent files.
    await writeFile(join(directory, "package", "untracked.rs"), "");
    const added = await captureBuildInputs(directory, paths);
    assert.ok(
      added.manifest.files.some(({ path, size }) => path === "package/untracked.rs" && size === 0),
    );
    assert.notEqual(added.manifest.sha256, before.manifest.sha256);
    await symlink(join(directory, "Cargo.lock"), join(directory, "package", "alias"));
    await assert.rejects(captureBuildInputs(directory, paths), /regular build source/);
    await assert.rejects(captureBuildInputs(directory, ["../outside"]), /canonical relative paths/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manifest publication replaces complete JSON and removes stale output on serialization failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oce-native-manifest-"));
  try {
    const path = join(directory, "native-manifest.json");
    const manifest = {
      schemaVersion: 2,
      sourceInputs: { sha256: "a".repeat(64), files: [] },
      products: [],
    };
    await writeFile(path, "stale or partial output");
    await writeNativeManifest(path, manifest);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), manifest);
    const circular = {};
    circular.self = circular;
    await assert.rejects(writeNativeManifest(path, circular), /circular/i);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("build input capture has finite size and traversal limits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oce-native-input-limits-"));
  try {
    await writeFile(join(directory, "large.rs"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(captureBuildInputs(directory, ["large.rs"]), /byte limit/);
    const deep = join(directory, ...Array(34).fill("nested"));
    await mkdir(deep, { recursive: true });
    await assert.rejects(captureBuildInputs(directory, ["nested"]), /entry\/depth limit/);
    await assert.rejects(captureBuildInputs(directory, ["absent.rs"]), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed native CLI invocation removes its previous manifest before prerequisites", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oce-native-cli-"));
  try {
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, ".build", "mvp"), { recursive: true });
    const copiedScript = join(directory, "scripts", "build-mvp.mjs");
    const manifest = join(directory, ".build", "mvp", "native-manifest.json");
    await copyFile(script, copiedScript);
    await writeFile(manifest, "previous success");
    // The real entrypoint must refuse absent source prerequisites. No compiler
    // is installed or substituted in this disposable source export.
    await assert.rejects(
      runCommand(process.execPath, [copiedScript, "native"], {
        env: { ...process.env, PATH: "" },
        capture: true,
      }),
      (error) => error instanceof CommandFailure && error.exitCode === 1,
    );
    await assert.rejects(lstat(manifest), { code: "ENOENT" });
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
  const directory = await mkdtemp(join(tmpdir(), "oce-build-cli-"));
  try {
    await mkdir(join(directory, "scripts"));
    const isolatedScript = join(directory, "scripts", "build-mvp.mjs");
    // Negative CLI cases may remove an earlier manifest before refusing their
    // inputs. Keep that real behavior inside this test's disposable export.
    await copyFile(script, isolatedScript);
    const child = spawn(process.execPath, [isolatedScript, target], {
      env: {
        ...process.env,
        PATH: "",
        OCC_BUILD_UPSTREAM_SDK_CONTEXT: "",
        OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256: "",
        ...environment,
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
    return { status, output, errors };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("controller images reject missing or malformed SDK inputs before prerequisites run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oce-build-sdk-inputs "));
  try {
    // A real directory exercises path validation; these cases stop before any build.
    const sdkContext = await realpath(directory);
    const environment = {
      OCC_BUILD_CONTROLLER_TAG: "controller:local",
      OCC_BUILD_NODE_BASE_IMAGE: `node:24@sha256:${"a".repeat(64)}`,
      OCC_BUILD_GO_BASE_IMAGE: `golang:1.26@sha256:${"b".repeat(64)}`,
      OCC_BUILD_UPSTREAM_SDK_CONTEXT: sdkContext,
      OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256: "d".repeat(64),
    };
    for (const [overrides, diagnostic] of [
      [
        { OCC_BUILD_UPSTREAM_SDK_CONTEXT: "" },
        /OCC_BUILD_UPSTREAM_SDK_CONTEXT must be an absolute/,
      ],
      [
        { OCC_BUILD_UPSTREAM_SDK_CONTEXT: "relative/context" },
        /OCC_BUILD_UPSTREAM_SDK_CONTEXT must be an absolute/,
      ],
      [
        { OCC_BUILD_UPSTREAM_SDK_CONTEXT: `${sdkContext}/.` },
        /OCC_BUILD_UPSTREAM_SDK_CONTEXT must be canonical/,
      ],
      [
        { OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256: "" },
        /OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256 must be the reviewed/,
      ],
      [
        { OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256: "d".repeat(63) },
        /OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256 must be the reviewed/,
      ],
      [
        { OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256: "D".repeat(64) },
        /OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256 must be the reviewed/,
      ],
    ]) {
      const result = await captureCli("image-controller", { ...environment, ...overrides });
      assert.equal(result.status, 1);
      assert.equal(result.output, "");
      assert.match(result.errors, diagnostic);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("controller SDK contexts reject regular files before build prerequisites", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oce-build-sdk-file "));
  try {
    const regularFile = join(directory, "context");
    await writeFile(regularFile, "ordinary file");
    const environment = {
      OCC_BUILD_CONTROLLER_TAG: "controller:local",
      OCC_BUILD_NODE_BASE_IMAGE: `node:24@sha256:${"a".repeat(64)}`,
      OCC_BUILD_GO_BASE_IMAGE: `golang:1.26@sha256:${"b".repeat(64)}`,
      OCC_BUILD_UPSTREAM_SDK_CONTEXT: await realpath(regularFile),
      OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256: "d".repeat(64),
    };
    // Canonical path equality alone accepts this real file; neither entrypoint
    // may treat it as a context directory or proceed to build prerequisites.
    const result = await captureCli("image-controller", environment);
    assert.equal(result.status, 1);
    assert.equal(result.output, "");
    assert.match(result.errors, /OCC_BUILD_UPSTREAM_SDK_CONTEXT must be a directory/);
    const output = await runCommand(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from "node:assert/strict"; import { imageBuildArguments } from ${JSON.stringify(moduleUrl)}; assert.throws(() => imageBuildArguments("controller", "output.image-id"), /OCC_BUILD_UPSTREAM_SDK_CONTEXT must be a directory/);`,
      ],
      { cwd: tmpdir(), capture: true, env: { ...process.env, PATH: "", ...environment } },
    );
    assert.equal(output, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
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

test("the image command preserves controller digests and SDK inputs and isolates egress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oce-build-image-inputs "));
  try {
    const sdkContext = await realpath(directory);
    const sdkManifestSha256 = "d".repeat(64);
    const nodeImage = `node:24@sha256:${"a".repeat(64)}`;
    const goImage = `golang:1.26@sha256:${"b".repeat(64)}`;
    const egressImage = `debian:trixie@sha256:${"c".repeat(64)}`;
    // Inspect the actual command builder used by buildImage. The directory and
    // digest exercise argv construction without materializing an SDK or image.
    const inspect = async (kind, environment) =>
      JSON.parse(
        await runCommand(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { imageBuildArguments } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(imageBuildArguments(${JSON.stringify(kind)}, "output.image-id")));`,
          ],
          {
            cwd: tmpdir(),
            capture: true,
            env: {
              ...process.env,
              PATH: "",
              OCC_BUILD_UPSTREAM_SDK_CONTEXT: "",
              OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256: "",
              ...environment,
            },
          },
        ),
      );
    const controller = await inspect("controller", {
      OCC_BUILD_CONTROLLER_TAG: "controller:local",
      OCC_BUILD_NODE_BASE_IMAGE: nodeImage,
      OCC_BUILD_GO_BASE_IMAGE: goImage,
      OCC_BUILD_UPSTREAM_SDK_CONTEXT: sdkContext,
      OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256: sdkManifestSha256,
      GO_BUILD_CACHE_SCOPE: "ambient-scope-must-not-select-another-worktrees-cache",
    });
    const buildArguments = (args) =>
      args.filter((_, index) => index > 0 && args[index - 1] === "--build-arg");
    assert.deepEqual(buildArguments(controller), [
      `NODE_BASE_IMAGE=${nodeImage}`,
      `GO_BASE_IMAGE=${goImage}`,
      `GO_BUILD_CACHE_SCOPE=${goBuildCacheScope()}`,
      `OCE_UPSTREAM_SDK_MANIFEST_SHA256=${sdkManifestSha256}`,
    ]);
    assert.deepEqual(
      controller.filter((_, index) => index > 0 && controller[index - 1] === "--build-context"),
      [`oce-upstream-inputs=${sdkContext}`],
    );
    assert.equal(controller[controller.indexOf("--target") + 1], "runtime");
    for (const sdkEnvironment of [
      {},
      {
        OCC_BUILD_UPSTREAM_SDK_CONTEXT: "relative/context",
        OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256: "not-a-digest",
      },
    ]) {
      const egress = await inspect("egress", {
        OCC_BUILD_EGRESS_TAG: "egress:local",
        OCC_BUILD_EGRESS_BASE_IMAGE: egressImage,
        OCC_BUILD_GO_BASE_IMAGE: "",
        OCC_BUILD_NODE_BASE_IMAGE: "",
        ...sdkEnvironment,
      });
      assert.deepEqual(buildArguments(egress), [`EGRESS_BASE_IMAGE=${egressImage}`]);
      assert.ok(egress.includes("--network=none"));
      assert.ok(!egress.includes("--target"));
      assert.ok(!egress.includes("--build-context"));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
