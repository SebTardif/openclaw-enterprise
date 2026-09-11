import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import {
  chmod,
  chown,
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
  captureCargoArtifact,
  captureNativeArtifact,
  executionOrder,
  goBuildCacheScope,
  runCommand,
  selectCargoArtifact,
  stageNativeArtifact,
  verifyFile,
  verifyStagedNativeArtifact,
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

test("the mediated READ product has an explicit optional build target", () => {
  assert.deepEqual(executionOrder("native-read"), ["check-native", "native-read"]);
  for (const target of ["native-dns", "native-tls", "native", "build", "images"])
    assert.ok(
      !executionOrder(target).includes("native-read"),
      `${target} must not select mediated READ`,
    );
});

function cargoArtifactRecords(directory) {
  const packageRoot = join(directory, "dataplane", "services", "oce-native-egress");
  const expected = {
    packageId: `path+file://${packageRoot}#0.0.0`,
    manifestPath: join(packageRoot, "Cargo.toml"),
    binary: "oce-github-read",
    sourcePath: join(packageRoot, "src", "bin", "oce-github-read.rs"),
    executable: join(
      directory,
      "dataplane",
      "target",
      "x86_64-unknown-linux-gnu",
      "release",
      "oce-github-read",
    ),
  };
  // These are Cargo-protocol inputs to the real parser, not a replacement
  // compiler or evidence that any native source was compiled successfully.
  const artifact = {
    reason: "compiler-artifact",
    package_id: expected.packageId,
    manifest_path: expected.manifestPath,
    target: {
      name: expected.binary,
      kind: ["bin"],
      crate_types: ["bin"],
      src_path: expected.sourcePath,
      edition: "2021",
      doc: true,
      doctest: false,
      test: true,
    },
    profile: {
      opt_level: "3",
      debuginfo: 0,
      debug_assertions: false,
      overflow_checks: false,
      test: false,
    },
    features: [],
    filenames: [expected.executable],
    executable: expected.executable,
    fresh: false,
  };
  return { expected, artifact, finished: { reason: "build-finished", success: true } };
}
const cargoMessages = (...records) =>
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

test("Cargo artifact selection binds the exact non-test binary and complete invocation", () => {
  const { expected, artifact, finished } = cargoArtifactRecords(
    join(tmpdir(), "cargo-parser-input"),
  );
  const dependency = {
    ...artifact,
    package_id: "registry+https://github.com/rust-lang/crates.io-index#example@1.0.0",
    executable: null,
    target: { ...artifact.target, name: "example", kind: ["lib"], crate_types: ["lib"] },
  };
  for (const fresh of [false, true]) {
    const messages = cargoMessages(dependency, { ...artifact, fresh }, finished);
    const selected = selectCargoArtifact(messages, expected);
    assert.equal(selected.executable, expected.executable);
    assert.equal(selected.fresh, fresh);
    assert.equal(selected.messagesSha256, createHash("sha256").update(messages).digest("hex"));
    assert.deepEqual(
      new Set(selected.reportedPackages),
      new Set([expected.packageId, dependency.package_id]),
    );
  }
  // target.test describes whether Cargo permits a test target; profile.test
  // identifies whether this compiler artifact was actually built with --test.
  assert.equal(artifact.target.test, true);
  assert.equal(artifact.profile.test, false);
});

test("Cargo artifact selection refuses wrong package, target, source, profile and executable association", () => {
  const { expected, artifact, finished } = cargoArtifactRecords(
    join(tmpdir(), "cargo-parser-refusal"),
  );
  const wrongArtifacts = [
    { ...artifact, package_id: "another-package" },
    { ...artifact, manifest_path: `${expected.manifestPath}.other` },
    { ...artifact, target: { ...artifact.target, name: "oce-egress" } },
    { ...artifact, target: { ...artifact.target, kind: ["example"] } },
    { ...artifact, target: { ...artifact.target, crate_types: ["lib"] } },
    { ...artifact, target: { ...artifact.target, src_path: join(tmpdir(), "other.rs") } },
    { ...artifact, profile: { ...artifact.profile, test: true } },
    {
      ...artifact,
      executable: expected.executable.replace(
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu",
      ),
    },
    { ...artifact, executable: null },
    { ...artifact, filenames: [] },
    { ...artifact, fresh: undefined },
  ];
  for (const wrong of wrongArtifacts)
    assert.throws(
      () => selectCargoArtifact(cargoMessages(wrong, finished), expected),
      /does not match/,
    );
});

test("Cargo artifact selection refuses duplicate, failed, incomplete and unbounded output", () => {
  const { expected, artifact, finished } = cargoArtifactRecords(
    join(tmpdir(), "cargo-parser-lifecycle"),
  );
  for (const messages of [
    "",
    cargoMessages(artifact),
    cargoMessages(finished),
    cargoMessages(artifact, { ...finished, success: false }),
    cargoMessages(artifact, artifact, finished),
    cargoMessages(artifact, finished, finished),
    cargoMessages(artifact, finished, { reason: "compiler-message" }),
    cargoMessages({ reason: "compiler-message", message: { level: "error" } }, artifact, finished),
    cargoMessages({ reason: "unsupported" }, artifact, finished),
    cargoMessages(null),
    '{"reason":',
    " ".repeat(4 * 1024 * 1024 + 1),
    `${cargoMessages({ reason: "build-script-executed" }).repeat(8193)}`,
  ])
    assert.throws(() => selectCargoArtifact(messages, expected), /Cargo/);
});

test(
  "Cargo-selected executable capture retains the same inode through staging and refuses replacement",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "oce-cargo-capture-"));
    try {
      const { expected, artifact, finished } = cargoArtifactRecords(directory);
      await mkdir(join(directory, "dataplane", "target", "x86_64-unknown-linux-gnu", "release"), {
        recursive: true,
      });
      const bytes = Buffer.from("inert compiler artifact payload\n");
      await writeFile(expected.executable, bytes, { mode: 0o755 });
      const messages = cargoMessages(artifact, finished);
      const captured = await captureCargoArtifact(messages, expected);
      const output = join(directory, "output");
      try {
        const staged = await captured.artifact.stage(output);
        assert.equal(captured.artifact.observation.sha256, staged.observation.sha256);
        assert.equal(captured.artifact.observation.size, bytes.length);
        assert.deepEqual(await readFile(output), bytes);
        assert.equal(staged.observation.mode, "0555");
        assert.throws(() => captured.artifact.stage(join(directory, "second-output")), /only once/);
      } finally {
        await captured.artifact.close();
      }
      await assert.rejects(lstat(join(directory, "second-output")), { code: "ENOENT" });

      const retained = await captureCargoArtifact(messages, expected);
      try {
        const replacement = join(directory, "replacement");
        await writeFile(replacement, bytes, { mode: 0o755 });
        await rename(replacement, expected.executable);
        await assert.rejects(
          retained.artifact.stage(join(directory, "replaced-output")),
          /changed/,
        );
        await assert.rejects(lstat(join(directory, "replaced-output")), { code: "ENOENT" });
      } finally {
        await retained.artifact.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "retained native captures reject changed source and close after failed staging",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "oce-retained-artifact-"));
    try {
      const source = join(directory, "source");
      const output = join(directory, "output");
      await writeFile(source, "first bytes", { mode: 0o755 });
      const before = (await readdir("/proc/self/fd")).length;
      const captured = await captureNativeArtifact(source);
      await writeFile(source, "other bytes");
      try {
        await assert.rejects(captured.stage(output), /changed/);
      } finally {
        await captured.close();
      }
      assert.throws(() => captured.stage(output), /only once/);
      assert.equal((await readdir("/proc/self/fd")).length, before);
      await assert.rejects(lstat(output), { code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "final native manifest verification refuses a changed staged executable",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "oce-staged-readback-"));
    try {
      const source = join(directory, "source");
      const output = join(directory, "output");
      await writeFile(source, "inert artifact bytes", { mode: 0o755 });
      const staged = await stageNativeArtifact(source, output);
      await verifyStagedNativeArtifact(output, staged);
      await chmod(output, 0o755);
      await writeFile(output, "other artifact bytes");
      await chmod(output, 0o555);
      await assert.rejects(
        verifyStagedNativeArtifact(output, staged),
        /does not match its staged observation/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
  "native staging rejects a real foreign owner",
  {
    skip:
      process.platform !== "linux" || process.getuid() !== 0
        ? "Requires privilege to create a genuinely foreign-owned file."
        : false,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "oce-native-owner-"));
    try {
      const source = join(directory, "source");
      await writeFile(source, "inert bytes", { mode: 0o755 });
      await chown(source, 65534, 65534);
      await assert.rejects(
        stageNativeArtifact(source, join(directory, "output")),
        /owned by root or the current user/,
      );
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

test("READ manifest publication preserves source inventory within the installed decoder bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oce-read-manifest-bounds-"));
  try {
    const path = join(directory, "native-manifest.json");
    // Writer-boundary controls only: these objects are not compiler receipts
    // and are never supplied to native compilation or package acceptance.
    const manifest = {
      schemaVersion: 2,
      products: [{ binary: "oce-github-read" }],
      sourceInputs: { files: [] },
    };
    await writeNativeManifest(path, manifest);
    assert.equal(await readFile(path, "utf8"), `${JSON.stringify(manifest)}\n`);
    let deep = {};
    for (let level = 0; level < 33; level++) deep = { child: deep };
    for (const oversized of [
      { ...manifest, note: "x".repeat(65536) },
      { ...manifest, sourceInputs: { files: Array(1025).fill({}) } },
      { ...manifest, nodes: Array.from({ length: 1024 }, () => Array(8).fill(0)) },
      { ...manifest, deep },
      { ...manifest, products: [...manifest.products, { binary: "oce-egress" }] },
    ]) {
      await assert.rejects(writeNativeManifest(path, oversized), /manifest/);
      await assert.rejects(lstat(path), { code: "ENOENT" });
    }
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

test("failed native and optional READ CLI invocations reset manifests without deleting old artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oce-native-cli-"));
  try {
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, ".build", "mvp", "native"), { recursive: true });
    const copiedScript = join(directory, "scripts", "build-mvp.mjs");
    const manifest = join(directory, ".build", "mvp", "native-manifest.json");
    await copyFile(script, copiedScript);
    const oldArtifact = join(directory, ".build", "mvp", "native", "oce-github-read");
    await writeFile(oldArtifact, "previous artifact");
    // The real entrypoint must refuse absent source prerequisites. No compiler
    // is installed or substituted in this disposable source export.
    for (const target of ["native", "native-read"]) {
      await writeFile(manifest, "previous success");
      await assert.rejects(
        runCommand(process.execPath, [copiedScript, target], {
          env: { ...process.env, PATH: "" },
          capture: true,
        }),
        (error) => error instanceof CommandFailure && error.exitCode === 1,
      );
      await assert.rejects(lstat(manifest), { code: "ENOENT" });
      assert.equal(await readFile(oldArtifact, "utf8"), "previous artifact");
    }
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
