import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import {
  prepareDevelopmentRuntime,
  renderConfiguration,
  validateManifest,
} from "../../scripts/gvisor-development-setup.mjs";

const executeFile = promisify(execFile);
const executableNames = ["runsc", "containerd-shim-runsc-v1"];
const sidecarNames = [
  "gvisor-bin/checkpointgofer",
  "gvisor-bin/gvisor-sentry-prewarmer",
  "gvisor-bin/gvisor_sentry",
  "gvisor-bin/runsc-metric-server",
];
const names = [...executableNames, ...sidecarNames];

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "oce-offline-helper-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o755);
  await mkdir(join(directory, "gvisor-bin"));
  const artifacts = {};
  for (const name of names) {
    // These benign shell programs exercise verified-copy/probe/wrapper semantics only.
    // They are not gVisor and provide no container, sandbox, or runtime proof.
    const versionOutput = `${name} setup-fixture-1.0.0`;
    const bytes = `#!/bin/sh
if [ "$#" = 1 ] && [ "$1" = --version ]; then
  printf '%s\\n' '${versionOutput}'
else
  printf '%s\\n' "$@"
fi
`;
    const path = join(directory, name);
    await writeFile(path, bytes, { mode: 0o600 });
    artifacts[name] = {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...(executableNames.includes(name)
        ? { version: "setup-fixture-1.0.0", versionFlag: "--version", versionOutput }
        : {}),
    };
  }
  const manifest = { schemaVersion: 2, releaseVersion: "setup-fixture-1.0.0", artifacts };
  const manifestPath = join(directory, "manifest.json");
  const prefix = join(directory, "prefix");
  async function saveManifest() {
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  }
  await saveManifest();
  return { directory, manifest, manifestPath, prefix, saveManifest };
}

async function assertAbsent(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

test("offline setup requires explicit local artifact paths, immutable versions, and SHA256 pins", async (context) => {
  const { manifest } = await fixture(context);
  assert.equal(validateManifest(manifest), manifest);
  const cases = [
    [
      "schemaVersion",
      (copy) => {
        copy.schemaVersion = 1;
      },
    ],
    [
      "exactly",
      (copy) => {
        copy.downloadUrl = "https://example.invalid/runsc";
      },
    ],
    [
      "exactly",
      (copy) => {
        delete copy.artifacts["containerd-shim-runsc-v1"];
      },
    ],
    [
      "exactly",
      (copy) => {
        delete copy.artifacts["gvisor-bin/gvisor_sentry"];
      },
    ],
    [
      "exactly",
      (copy) => {
        copy.artifacts["../gvisor_sentry"] = copy.artifacts["gvisor-bin/gvisor_sentry"];
      },
    ],
    [
      "releaseVersion",
      (copy) => {
        copy.releaseVersion = "unprobed-release-2.0";
      },
    ],
    [
      "absolute local path",
      (copy) => {
        copy.artifacts.runsc.path = "https://example.invalid/runsc";
      },
    ],
    [
      "absolute local path",
      (copy) => {
        copy.artifacts.runsc.path = "relative/runsc";
      },
    ],
    [
      "absolute local path",
      (copy) => {
        copy.artifacts.runsc.path = "/tmp/a/../runsc";
      },
    ],
    [
      "SHA256",
      (copy) => {
        copy.artifacts.runsc.sha256 = "replace-with-a-real-hash";
      },
    ],
    [
      "immutable version",
      (copy) => {
        copy.artifacts.runsc.version = "latest";
      },
    ],
    [
      "immutable version",
      (copy) => {
        copy.artifacts.runsc.version = "nightly-20260904";
      },
    ],
    [
      "exact pinned version",
      (copy) => {
        copy.artifacts.runsc.versionOutput = "runsc another-1.0.0";
      },
    ],
    [
      "versionFlag",
      (copy) => {
        copy.artifacts.runsc.versionFlag = "run";
      },
    ],
    [
      "distinct local artifacts",
      (copy) => {
        copy.artifacts["containerd-shim-runsc-v1"].path = copy.artifacts.runsc.path;
      },
    ],
  ];
  for (const [message, mutate] of cases) {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    assert.throws(() => validateManifest(candidate), new RegExp(message));
  }
});

test("offline setup verifies both hashes before it executes even a version probe", async (context) => {
  const input = await fixture(context);
  const marker = join(input.directory, "must-not-execute");
  const bytes = `#!/bin/sh\nprintf '%s' invoked > '${marker}'\n`;
  await writeFile(input.manifest.artifacts.runsc.path, bytes);
  input.manifest.artifacts.runsc.sha256 = createHash("sha256").update(bytes).digest("hex");
  input.manifest.artifacts["containerd-shim-runsc-v1"].sha256 = "0".repeat(64);
  await input.saveManifest();
  await assert.rejects(
    prepareDevelopmentRuntime(input),
    /containerd-shim-runsc-v1 SHA256 mismatch/u,
  );
  await assertAbsent(marker);
  await assertAbsent(input.prefix);
  assert.equal(
    (await readdir(input.directory)).some((name) => name.startsWith(".oce-gvisor-prepare-")),
    false,
  );
});

test("offline setup rejects first-artifact hash and version mismatches without publishing a prefix", async (context) => {
  const input = await fixture(context);
  const hash = input.manifest.artifacts.runsc.sha256;
  input.manifest.artifacts.runsc.sha256 = "f".repeat(64);
  await input.saveManifest();
  await assert.rejects(prepareDevelopmentRuntime(input), /runsc SHA256 mismatch/u);
  await assertAbsent(input.prefix);
  input.manifest.artifacts.runsc.sha256 = hash;
  input.manifest.artifacts.runsc.versionOutput = "runsc mismatch setup-fixture-1.0.0";
  await input.saveManifest();
  await assert.rejects(prepareDevelopmentRuntime(input), /runsc version output does not match/u);
  await assertAbsent(input.prefix);
});

test("offline setup rejects malformed JSON, nonregular files, and symlink inputs", async (context) => {
  const input = await fixture(context);
  await writeFile(input.manifestPath, "{");
  await assert.rejects(prepareDevelopmentRuntime(input), /valid JSON/u);
  await input.saveManifest();
  const artifactPath = input.manifest.artifacts.runsc.path;
  input.manifest.artifacts.runsc.path = input.directory;
  await input.saveManifest();
  await assert.rejects(prepareDevelopmentRuntime(input), /nonempty regular file/u);
  const artifactLink = join(input.directory, "runsc-link");
  await symlink(artifactPath, artifactLink);
  input.manifest.artifacts.runsc.path = artifactLink;
  await input.saveManifest();
  await assert.rejects(prepareDevelopmentRuntime(input), /Symbolic links are not accepted/u);
  input.manifest.artifacts.runsc.path = artifactPath;
  await input.saveManifest();
  const manifestLink = join(input.directory, "manifest-link.json");
  await symlink(input.manifestPath, manifestLink);
  await assert.rejects(
    prepareDevelopmentRuntime({ ...input, manifestPath: manifestLink }),
    /Symbolic links are not accepted/u,
  );
  await assertAbsent(input.prefix);
});

test("offline setup refuses existing prefixes and symbolic-link parent paths", async (context) => {
  const input = await fixture(context);
  await mkdir(input.prefix);
  const sentinel = join(input.prefix, "operator-owned.txt");
  await writeFile(sentinel, "preserve this file");
  await assert.rejects(prepareDevelopmentRuntime(input), /Prefix already exists/u);
  assert.equal(await readFile(sentinel, "utf8"), "preserve this file");
  const parentLink = join(input.directory, "linked-parent");
  await symlink(input.directory, parentLink);
  await assert.rejects(
    prepareDevelopmentRuntime({ ...input, prefix: join(parentLink, "new-prefix") }),
    /Symbolic links are not accepted/u,
  );
  const dangling = join(input.directory, "dangling-prefix");
  await symlink(join(input.directory, "absent"), dangling);
  await assert.rejects(
    prepareDevelopmentRuntime({ ...input, prefix: dangling }),
    /Prefix already exists/u,
  );
  await assert.rejects(
    prepareDevelopmentRuntime({ ...input, prefix: join(input.directory, "absent", "prefix") }),
    { code: "ENOENT" },
  );
});

test("offline setup stages the complete verified fixture distribution for dropped runtime identities and labels its result prepared-only", async (context) => {
  const input = await fixture(context);
  const receipt = await prepareDevelopmentRuntime(input);
  assert.equal(receipt.status, "prepared-only");
  assert.equal(receipt.runtimeVerified, false);
  assert.equal(receipt.runtimeHandlerConfigured, false);
  assert.equal(receipt.sidecarUsagePolicy, "STRICT");
  assert.equal(receipt.runtimeClassName, "oce-gvisor-systrap");
  assert.match(receipt.requiredOperatorStep, /preserving the existing runc default/u);
  for (const name of names) {
    assert.deepEqual(
      await readFile(join(input.prefix, "bin", name)),
      await readFile(input.manifest.artifacts[name].path),
    );
    assert.equal((await lstat(join(input.prefix, "bin", name))).mode & 0o777, 0o555);
    assert.equal((await lstat(input.manifest.artifacts[name].path)).mode & 0o777, 0o600);
  }
  assert.equal((await lstat(input.prefix)).mode & 0o777, 0o755);
  const saved = JSON.parse(await readFile(join(input.prefix, "verification.json"), "utf8"));
  assert.equal(saved.runtimeVerified, false);
  assert.equal(saved.releaseVersion, "setup-fixture-1.0.0");
  assert.deepEqual(saved.artifacts["gvisor-bin/gvisor_sentry"], {
    sha256: input.manifest.artifacts["gvisor-bin/gvisor_sentry"].sha256,
  });
  assert.equal((await lstat(join(input.prefix, "bin", "gvisor-bin"))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(input.prefix, "verification.json"))).mode & 0o777, 0o444);
  assert.deepEqual(await readdir(join(input.prefix, "config")), ["runtimeclass.yaml"]);
  assert.match(
    await readFile(join(input.prefix, "config", "runtimeclass.yaml"), "utf8"),
    /name: oce-gvisor-systrap\nhandler: oce-gvisor-systrap\n/u,
  );
  await assert.rejects(prepareDevelopmentRuntime(input), /Prefix already exists/u);
});

test("generated OCI wrapper fixes systrap, rejects platform overrides, and safely quotes paths", async (context) => {
  const input = await fixture(context);
  const prefix = join(input.directory, "prefix ' with spaces $shell");
  await prepareDevelopmentRuntime({ ...input, prefix });
  const wrapper = join(prefix, "bin", "runsc-systrap");
  // Executing the real generated shell wrapper against an argument-echo fixture proves
  // its quoting/flag behavior only. No container operation or gVisor execution occurs.
  const result = await executeFile(wrapper, ["--root=/tmp/example space", "state", "fixture-id"]);
  assert.equal(
    result.stdout,
    "--platform=systrap\n--sidecar-usage-policy=STRICT\n--root=/tmp/example space\nstate\nfixture-id\n",
  );
  for (const flags of [
    ["--platform=kvm"],
    ["--platform", "ptrace"],
    ["-platform=kvm"],
    ["-platform", "ptrace"],
  ]) {
    await assert.rejects(
      executeFile(wrapper, flags),
      (error) => error.code === 64 && /platform overrides are rejected/u.test(error.stderr),
    );
  }
  for (const flags of [
    ["--sidecar-usage-policy=DEFAULT"],
    ["--sidecar-usage-policy", "DEFAULT"],
    ["-sidecar-usage-policy=DEFAULT"],
    ["-sidecar-usage-policy", "DEFAULT"],
  ]) {
    await assert.rejects(
      executeFile(wrapper, flags),
      (error) => error.code === 64 && /sidecar policy overrides are rejected/u.test(error.stderr),
    );
  }
  assert.deepEqual(Object.keys(renderConfiguration(prefix)).sort(), [
    "runsc-systrap",
    "runtimeclass.yaml",
  ]);
});

test("offline setup rejects any unverified companion before executing runsc", async (context) => {
  const input = await fixture(context);
  const marker = join(input.directory, "must-not-execute");
  const bytes = `#!/bin/sh\nprintf '%s' invoked > '${marker}'\n`;
  await writeFile(input.manifest.artifacts.runsc.path, bytes);
  input.manifest.artifacts.runsc.sha256 = createHash("sha256").update(bytes).digest("hex");
  input.manifest.artifacts["gvisor-bin/runsc-metric-server"].sha256 = "0".repeat(64);
  await input.saveManifest();
  await assert.rejects(prepareDevelopmentRuntime(input), /runsc-metric-server SHA256 mismatch/u);
  await assertAbsent(marker);
  await assertAbsent(input.prefix);
});

test("offline setup rechecks unprobed companions after version probes", async (context) => {
  const input = await fixture(context);
  // A supplied executable can change another member despite initially matching its pin.
  // Such probe-time changes must never reach the published distribution.
  const bytes = `#!/bin/sh
chmod u+w gvisor-bin/gvisor_sentry
printf '%s' changed > gvisor-bin/gvisor_sentry
printf '%s\\n' 'runsc setup-fixture-1.0.0'
`;
  await writeFile(input.manifest.artifacts.runsc.path, bytes);
  input.manifest.artifacts.runsc.sha256 = createHash("sha256").update(bytes).digest("hex");
  await input.saveManifest();
  await assert.rejects(
    prepareDevelopmentRuntime(input),
    /gvisor_sentry changed during distribution version probes/u,
  );
  await assertAbsent(input.prefix);
});

test("offline setup rejects output ancestors inaccessible to dropped runtime identities", async (context) => {
  const input = await fixture(context);
  const inaccessible = join(input.directory, "inaccessible");
  await mkdir(inaccessible, { mode: 0o700 });
  const prefix = join(inaccessible, "prefix");
  await assert.rejects(
    prepareDevelopmentRuntime({ ...input, prefix }),
    /Prefix ancestors must be traversable/u,
  );
  await assertAbsent(prefix);
});

test("offline setup records the shim's actual distinct build version", async (context) => {
  const input = await fixture(context);
  // Upstream's shim prints its containerd build version, not the runsc release stamp.
  const shim = input.manifest.artifacts["containerd-shim-runsc-v1"];
  const bytes =
    "#!/bin/sh\nprintf '%s\\n' 'containerd-shim-runsc-v1:' '  Version:  2.1.5+unknown'\n";
  await writeFile(shim.path, bytes);
  Object.assign(shim, {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    version: "2.1.5+unknown",
    versionFlag: "-v",
    versionOutput: "containerd-shim-runsc-v1:\n  Version:  2.1.5+unknown",
  });
  await input.saveManifest();
  const receipt = await prepareDevelopmentRuntime(input);
  assert.equal(receipt.releaseVersion, "setup-fixture-1.0.0");
  assert.equal(receipt.artifacts["containerd-shim-runsc-v1"].version, "2.1.5+unknown");
});

test("offline setup preserves dropped-identity access under a restrictive operator umask", async (context) => {
  const input = await fixture(context);
  const oldMask = process.umask(0o077);
  try {
    await prepareDevelopmentRuntime(input);
  } finally {
    process.umask(oldMask);
  }
  for (const path of ["bin/runsc-systrap", ...names.map((name) => `bin/${name}`)]) {
    assert.equal((await lstat(join(input.prefix, path))).mode & 0o777, 0o555);
  }
  for (const path of ["verification.json", "config/runtimeclass.yaml"]) {
    assert.equal((await lstat(join(input.prefix, path))).mode & 0o777, 0o444);
  }
});

test("offline setup never executes a shim rewritten by the runsc probe", async (context) => {
  const input = await fixture(context);
  const marker = join(input.directory, "rewritten-shim-must-not-execute");
  // Initial hash verification is insufficient if the first probe rewrites the second.
  const bytes = `#!/bin/sh
chmod u+w containerd-shim-runsc-v1
cat > containerd-shim-runsc-v1 <<'SHIM'
#!/bin/sh
printf '%s' invoked > '${marker}'
printf '%s\\n' 'containerd-shim-runsc-v1 setup-fixture-1.0.0'
SHIM
printf '%s\\n' 'runsc setup-fixture-1.0.0'
`;
  await writeFile(input.manifest.artifacts.runsc.path, bytes);
  input.manifest.artifacts.runsc.sha256 = createHash("sha256").update(bytes).digest("hex");
  await input.saveManifest();
  await assert.rejects(
    prepareDevelopmentRuntime(input),
    /containerd-shim-runsc-v1 changed during distribution version probes/u,
  );
  await assertAbsent(marker);
  await assertAbsent(input.prefix);
});
