import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertLocalGraph,
  captureReadNativeArtifact,
  normalizeRuntimeManifest,
  verifyContext,
  verifyReadNativeStaging,
} from "../../deploy/runtime/prepare-local-packages.mjs";

import {
  archiveBytes,
  digest,
  graphFixture,
  integrity,
  jsonBytes,
  names,
  packageMembers,
  preparedFixture,
  temporaryDirectory,
  version,
} from "../helpers/runtime-package-preparation.mjs";

const preparer = fileURLToPath(
  new URL("../../deploy/runtime/prepare-local-packages.mjs", import.meta.url),
);
const toolingPath = process.env.OCC_TEST_RUNTIME_PACKAGE_TOOLS;
const toolingSha256 = process.env.OCC_TEST_RUNTIME_PACKAGE_TOOLS_SHA256;
const tarOptions =
  toolingPath === undefined
    ? {
        skip: "Set OCC_TEST_RUNTIME_PACKAGE_TOOLS and OCC_TEST_RUNTIME_PACKAGE_TOOLS_SHA256 to a self-contained package-tools.mjs bundle for real tar validation.",
      }
    : {};
let cliDirectory;
let isolatedNode;

before(async () => {
  cliDirectory = await mkdtemp(join(tmpdir(), "oce-package-preparation-node-"));
  isolatedNode = join(cliDirectory, basename(process.execPath));
  // The preparer also searches beside process.execPath for npm. An actual Node
  // copy in a private directory keeps even an unexpected CLI progression offline.
  await copyFile(process.execPath, isolatedNode, constants.COPYFILE_FICLONE);
  await chmod(isolatedNode, 0o755);
});
after(async () => {
  if (cliDirectory !== undefined) await rm(cliDirectory, { recursive: true, force: true });
});

async function saveReceipt(fixture) {
  await writeFile(join(fixture.context, "preparation.json"), jsonBytes(fixture.receipt));
}

async function inputFixture(t, useActualTooling = false) {
  const directory = await temporaryDirectory(t);
  const inputDirectory = join(directory, "inputs");
  await mkdir(inputDirectory);
  const saveInput = async (filename, bytes) => {
    const path = join(inputDirectory, filename);
    await writeFile(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  // The prevalidation cases must reject before evaluating any tooling. Tar cases
  // instead select the same real, hash-bound bundle accepted by the preparer.
  let tools = Buffer.from(
    'throw new Error("Tooling was loaded before input/output prevalidation completed.");\n',
  );
  if (useActualTooling) {
    assert.match(
      toolingSha256 ?? "",
      /^[a-f0-9]{64}$/,
      "A selected tooling bundle requires its expected SHA-256.",
    );
    tools = await readFile(toolingPath);
    assert.equal(digest(tools), toolingSha256, "Selected tooling bundle digest mismatch.");
  }
  const input = {
    schema: "oce.runtime-package-inputs/v1",
    platform: "linux/amd64",
    nativeCodexVersion: "0.153.0",
    tooling: await saveInput("package-tools.mjs", tools),
    policy: {
      lockfile: await saveInput("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"),
      workspace: await saveInput("pnpm-workspace.yaml", "{}\n"),
    },
    packages: [],
  };
  for (const [index, name] of names.entries()) {
    const members = packageMembers(name);
    const inventory = members.map(({ path, content }) => ({
      path,
      bytes: Buffer.byteLength(content),
      sha256: digest(content),
    }));
    input.packages.push({
      name,
      version,
      ...(await saveInput(`package-${index}.tgz`, archiveBytes(members))),
      inventory: await saveInput(`inventory-${index}.json`, jsonBytes(inventory)),
    });
  }
  const inputPath = join(directory, "inputs.json");
  const output = join(directory, "prepared");
  return { directory, input, inputPath, output };
}

async function runPreparation(fixture) {
  await writeFile(fixture.inputPath, jsonBytes(fixture.input));
  // No inherited credentials or package manager executable are available. Every
  // CLI case must fail before npm; unexpected progression cannot use the network.
  return spawnSync(
    isolatedNode,
    [preparer, "--inputs", fixture.inputPath, "--output", fixture.output],
    {
      env: { PATH: cliDirectory, LANG: "C.UTF-8" },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1_000_000,
    },
  );
}

function assertPreparationFailure(result, expected) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, expected);
  assert.doesNotMatch(result.stdout, /Runtime package context verified/);
}

test("runtime manifest normalization preserves payload metadata and never mutates the source", () => {
  const source = {
    name: "openclaw",
    version,
    files: ["dist"],
    exports: { ".": "./dist/index.js" },
    scripts: {
      start: "node scripts/crabbox-wrapper.mjs",
      test: "node scripts/crabbox-wrapper.mjs test --run",
      similar: "node scripts/crabbox-wrapper.mjs-other",
      unchanged: "node dist/index.js",
    },
    dependencies: { "@openclaw/ai": "workspace:*", zod: "^4.0.0" },
    optionalDependencies: { "@openclaw/slack": "workspace:^" },
    peerDependencies: { "@openclaw/codex": "workspace:2026.8.1" },
    devDependencies: { "@openclaw/test-utils": "workspace:*", prettier: "3.9.4" },
  };
  const original = structuredClone(source);
  const normalized = normalizeRuntimeManifest(
    source,
    Object.fromEntries(names.map((name) => [name, version])),
  );
  assert.deepEqual(source, original);
  assert.equal(normalized.dependencies["@openclaw/ai"], version);
  assert.equal(normalized.optionalDependencies["@openclaw/slack"], version);
  assert.equal(normalized.peerDependencies["@openclaw/codex"], version);
  assert.equal(normalized.dependencies.zod, "^4.0.0");
  assert.deepEqual(normalized.devDependencies, { prettier: "3.9.4" });
  assert.deepEqual(normalized.scripts, {
    start: "node dist/crabbox-wrapper.js",
    test: "node dist/crabbox-wrapper.js test --run",
    similar: source.scripts.similar,
    unchanged: source.scripts.unchanged,
  });
  assert.deepEqual(normalized.files, source.files);
  assert.deepEqual(normalized.exports, source.exports);
});

for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  test(`runtime manifest normalization rejects external source dependencies in ${field}`, () => {
    for (const spec of [
      "workspace:*",
      "file:../outside.tgz",
      "link:../source",
      "git+https://example.invalid/repo.git",
      "git+ssh://example.invalid/repo.git",
      "https://example.invalid/package.tgz",
      "http://example.invalid/package.tgz",
      "./source",
      "../source",
      "/source",
    ]) {
      assert.throws(
        () => normalizeRuntimeManifest({ [field]: { outside: spec } }, {}),
        /Unsupported package dependency: outside/,
        spec,
      );
    }
  });
}

test("local package graph accepts five archive bindings and a locked native Codex", () => {
  const graph = graphFixture();
  assert.doesNotThrow(() => assertLocalGraph(graph.manifest, graph.lock, graph.packages));
});

const customRegistry = "https://packages.example.invalid/npm/";

test("configured registry graph accepts its HTTPS tarballs and the five local archives", () => {
  const graph = graphFixture(customRegistry);
  assert.doesNotThrow(() =>
    assertLocalGraph(graph.manifest, graph.lock, graph.packages, customRegistry),
  );
});

for (const [name, registry] of [
  ["another registry", "https://registry.npmjs.org/"],
  ["a lookalike registry host", "https://packages.example.invalid.evil.invalid/npm/"],
  ["a lookalike registry path", "https://packages.example.invalid/npm-other/"],
  ["embedded credentials", "https://fixture:fixture@packages.example.invalid/npm/"],
  ["non-HTTPS transport", "http://packages.example.invalid/npm/"],
]) {
  test(`configured registry graph rejects a locked tarball with ${name}`, () => {
    const graph = graphFixture(customRegistry);
    graph.lock.packages["node_modules/@openai/codex"].resolved = new URL(
      "@openai/codex/-/codex-0.153.0.tgz",
      registry,
    ).href;
    assert.throws(
      () => assertLocalGraph(graph.manifest, graph.lock, graph.packages, customRegistry),
      /Only the configured registry's locked tarballs/,
    );
  });
}

const invalidRegistrySettings = [
  ["embedded credentials", "https://fixture:fixture@packages.example.invalid/npm/"],
  ["non-HTTPS transport", "http://packages.example.invalid/npm/"],
  // A trailing slash in a query or fragment must not make it a registry directory.
  ["a query string", "https://packages.example.invalid/npm/?scope=/"],
  ["a fragment", "https://packages.example.invalid/npm/#section/"],
];
for (const [name, registry] of invalidRegistrySettings) {
  test(`configured registry graph rejects a registry setting with ${name}`, () => {
    const graph = graphFixture(customRegistry);
    assert.throws(
      () => assertLocalGraph(graph.manifest, graph.lock, graph.packages, registry),
      /A configured HTTPS registry is required/,
    );
  });
}

test("configured registry context verifies the receipt's custom registry against its lock URLs", async (t) => {
  const fixture = await preparedFixture(t, customRegistry);
  assert.deepEqual(await verifyContext(fixture.context), fixture.receipt);

  // Changing only the registry policy keeps every file digest valid. Rejection
  // must therefore come from enforcing that policy against the existing lock.
  fixture.receipt.registry = "https://registry.npmjs.org/";
  await saveReceipt(fixture);
  await assert.rejects(
    verifyContext(fixture.context),
    /Only the configured registry's locked tarballs/,
  );
});

for (const [name, registry] of invalidRegistrySettings) {
  test(`configured registry context rejects a receipt with ${name}`, async (t) => {
    const fixture = await preparedFixture(t, customRegistry);
    fixture.receipt.registry = registry;
    await saveReceipt(fixture);
    await assert.rejects(verifyContext(fixture.context), /A configured HTTPS registry is required/);
  });
}

const graphMutations = [
  ["missing local package", (g) => g.packages.pop()],
  ["duplicate local package", (g) => g.packages.push(g.packages[0])],
  [
    "registry root dependency",
    (g) => {
      g.manifest.dependencies.openclaw = version;
    },
  ],
  [
    "registry replacement of local archive",
    (g) => {
      g.lock.packages["node_modules/openclaw"].resolved =
        "https://registry.npmjs.org/openclaw/-/openclaw.tgz";
    },
  ],
  [
    "changed local version",
    (g) => {
      g.lock.packages["node_modules/openclaw"].version = "2026.8.2";
    },
  ],
  [
    "changed local integrity",
    (g) => {
      g.lock.packages["node_modules/openclaw"].integrity = integrity("changed");
    },
  ],
  [
    "unsafe local archive path",
    (g) => {
      g.packages[0].archive = "artifacts/../outside.tgz";
    },
  ],
  [
    "wrong native version",
    (g) => {
      g.lock.packages["node_modules/@openai/codex"].version = "0.154.0";
    },
  ],
  [
    "workspace link",
    (g) => {
      g.lock.packages["node_modules/outside"] = { link: true, resolved: "../source" };
    },
  ],
  [
    "third-party local archive",
    (g) => {
      g.lock.packages["node_modules/outside"] = {
        version: "1.0.0",
        resolved: "file:../outside.tgz",
      };
    },
  ],
  [
    "lookalike registry host",
    (g) => {
      g.lock.packages["node_modules/outside"] = {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org.evil.invalid/outside.tgz",
      };
    },
  ],
  [
    "nested unscoped SDK package",
    (g) => {
      g.lock.packages["node_modules/parent/node_modules/openclaw"] = {
        ...g.lock.packages["node_modules/openclaw"],
      };
    },
  ],
  [
    "nested scoped SDK package",
    (g) => {
      g.lock.packages["node_modules/parent/node_modules/@openclaw/codex"] = {
        ...g.lock.packages["node_modules/@openclaw/codex"],
      };
    },
  ],
  [
    "local SDK installed under an alias",
    (g) => {
      g.lock.packages["node_modules/alias"] = { ...g.lock.packages["node_modules/openclaw"] };
    },
  ],
  [
    "nested SDK path hidden by another package name",
    (g) => {
      g.lock.packages["node_modules/parent/node_modules/openclaw"] = {
        name: "unrelated",
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/unrelated/-/unrelated-1.0.0.tgz",
      };
    },
  ],
];
for (const [name, mutate] of graphMutations) {
  test(`local package graph rejects ${name}`, () => {
    const graph = graphFixture();
    mutate(graph);
    assert.throws(() => assertLocalGraph(graph.manifest, graph.lock, graph.packages), {
      code: "ERR_ASSERTION",
    });
  });
}

test("prepared context verification checks real files without modifying the context", async (t) => {
  const fixture = await preparedFixture(t);
  const receiptBytes = await readFile(join(fixture.context, "preparation.json"));
  assert.deepEqual(await verifyContext(fixture.context), fixture.receipt);
  assert.deepEqual(await readFile(join(fixture.context, "preparation.json")), receiptBytes);
  for (const [path, bytes] of fixture.contents)
    assert.deepEqual(await readFile(join(fixture.context, path)), bytes);
});

for (const [name, mutate, expected] of [
  [
    "same-length tampered archive",
    async (f) => {
      const path = join(f.context, f.receipt.packages[0].archive);
      const bytes = await readFile(path);
      bytes[10] ^= 1;
      await writeFile(path, bytes);
    },
    /Prepared file digest mismatch/,
  ],
  [
    "truncated archive",
    async (f) => {
      await writeFile(join(f.context, f.receipt.packages[0].archive), "truncated");
    },
    /Prepared file length mismatch/,
  ],
  [
    "missing archive",
    async (f) => {
      await rm(join(f.context, f.receipt.packages[0].archive));
    },
    /ENOENT/,
  ],
  [
    "changed archive SRI",
    async (f) => {
      f.receipt.packages[0].integrity = integrity("different");
      await saveReceipt(f);
    },
    /Expected values to be strictly equal/,
  ],
  [
    "duplicate file record",
    async (f) => {
      f.receipt.files.push(f.receipt.files[0]);
      await saveReceipt(f);
    },
    /Duplicate prepared file/,
  ],
  [
    "omitted required archive record",
    async (f) => {
      f.receipt.files = f.receipt.files.filter(
        (entry) => entry.path !== f.receipt.packages[0].archive,
      );
      await saveReceipt(f);
    },
    /Missing prepared file/,
  ],
  [
    "parent traversal in receipt",
    async (f) => {
      f.receipt.files[0].path = "../outside";
      await saveReceipt(f);
    },
    /Unsafe package path/,
  ],
  [
    "symlinked listed file",
    async (f) => {
      const path = join(f.context, f.receipt.packages[0].archive);
      const target = join(f.directory, "archive.tgz");
      await rename(path, target);
      await symlink(target, path);
    },
    /Expected a regular file/,
  ],
  [
    "symlinked file ancestor",
    async (f) => {
      const path = join(f.context, "artifacts");
      const target = join(f.directory, "artifacts");
      await rename(path, target);
      await symlink(target, path);
    },
    /must not traverse symlinks/,
  ],
  [
    "symlinked receipt",
    async (f) => {
      const path = join(f.context, "preparation.json");
      const target = join(f.directory, "receipt.json");
      await rename(path, target);
      await symlink(target, path);
    },
    /Expected a regular file/,
  ],
  [
    "unlisted artifact",
    async (f) => {
      await writeFile(join(f.context, "artifacts", "extra.tgz"), "unlisted");
    },
    /Unlisted context file/,
  ],
  [
    "unlisted symlink",
    async (f) => {
      await symlink(join(f.context, "package.json"), join(f.context, "extra"));
    },
    /Unexpected context symlink/,
  ],
  [
    "omitted policy inventory record",
    async (f) => {
      f.receipt.files = f.receipt.files.filter(
        (entry) => entry.path !== "policy/pnpm-workspace.yaml",
      );
      await saveReceipt(f);
    },
    /Unlisted context file/,
  ],
]) {
  test(`prepared context verification rejects ${name}`, async (t) => {
    const fixture = await preparedFixture(t);
    await mutate(fixture);
    await assert.rejects(verifyContext(fixture.context), expected);
  });
}

test("prepared context verification rejects a symlinked context root", async (t) => {
  const fixture = await preparedFixture(t);
  const alias = join(fixture.directory, "context-alias");
  await symlink(fixture.context, alias);
  await assert.rejects(verifyContext(alias), /Prepared context must not be a symlink/);
});

for (const [name, mutate, expected] of [
  [
    "missing archive",
    async (f) => {
      await rm(f.input.packages[4].path);
    },
    /ENOENT/,
  ],
  [
    "wrong archive hash",
    async (f) => {
      f.input.packages[4].sha256 = "0".repeat(64);
    },
    /Input digest mismatch/,
  ],
  [
    "wrong inventory hash",
    async (f) => {
      f.input.packages[4].inventory.sha256 = "0".repeat(64);
    },
    /Input digest mismatch/,
  ],
  [
    "symlinked archive",
    async (f) => {
      const path = f.input.packages[4].path;
      const target = join(f.directory, "archive.tgz");
      await rename(path, target);
      await symlink(target, path);
    },
    /Expected an immutable regular input file/,
  ],
]) {
  test(`preparation CLI rejects ${name} before creating output`, async (t) => {
    const fixture = await inputFixture(t);
    await mutate(fixture);
    assertPreparationFailure(await runPreparation(fixture), expected);
    await assert.rejects(lstat(fixture.output), { code: "ENOENT" });
  });
}

test("preparation CLI preserves an existing output directory and its contents", async (t) => {
  const fixture = await inputFixture(t);
  await mkdir(fixture.output);
  const sentinel = join(fixture.output, "keep.txt");
  await writeFile(sentinel, "Existing preparation must remain untouched.\n");
  const sourceHashes = await Promise.all(
    fixture.input.packages.map(async (entry) => digest(await readFile(entry.path))),
  );
  assertPreparationFailure(await runPreparation(fixture), /EEXIST/);
  assert.deepEqual(await readdir(fixture.output), ["keep.txt"]);
  assert.equal(await readFile(sentinel, "utf8"), "Existing preparation must remain untouched.\n");
  assert.deepEqual(
    await Promise.all(
      fixture.input.packages.map(async (entry) => digest(await readFile(entry.path))),
    ),
    sourceHashes,
  );
});

for (const [name, members, expected] of [
  [
    "parent traversal",
    () => [{ path: "../../escape.txt", content: "outside" }],
    /Unsafe package path/,
  ],
  [
    "absolute member",
    (f) => [{ path: join(f.directory, "escape.txt"), content: "outside" }],
    /assert\.ok|assertion/i,
  ],
  [
    "symbolic link",
    () => [{ path: "linked", type: "2", link: "../../escape.txt" }],
    /Archive links and special entries are forbidden/,
  ],
  [
    "hard link",
    () => [{ path: "linked", type: "1", link: "package.json" }],
    /Archive links and special entries are forbidden/,
  ],
  [
    "duplicate member",
    () => [
      { path: "duplicate", content: "first" },
      { path: "duplicate", content: "second" },
    ],
    /Duplicate archive member/,
  ],
]) {
  test(
    `preparation CLI rejects an actual tar archive with ${name} before extraction`,
    tarOptions,
    async (t) => {
      const fixture = await inputFixture(t, true);
      const entry = fixture.input.packages[0];
      const bytes = archiveBytes(members(fixture));
      await writeFile(entry.path, bytes);
      entry.sha256 = digest(bytes);
      assertPreparationFailure(await runPreparation(fixture), expected);
      assert.deepEqual(await readdir(join(fixture.output, ".work", "openclaw")), []);
      await assert.rejects(lstat(join(fixture.directory, "escape.txt")), { code: "ENOENT" });
      await assert.rejects(lstat(join(fixture.output, "escape.txt")), { code: "ENOENT" });
      assert.equal(digest(await readFile(entry.path)), entry.sha256);
    },
  );
}

test(
  "preparation CLI extracts a real safe archive and rejects a mismatching inventory before npm",
  tarOptions,
  async (t) => {
    const fixture = await inputFixture(t, true);
    const entry = fixture.input.packages[0];
    const inventory = JSON.parse(await readFile(entry.inventory.path, "utf8"));
    inventory[1].sha256 = "0".repeat(64);
    const bytes = jsonBytes(inventory);
    await writeFile(entry.inventory.path, bytes);
    entry.inventory.sha256 = digest(bytes);
    assertPreparationFailure(await runPreparation(fixture), /Archive inventory mismatch: openclaw/);
    assert.deepEqual(
      await readFile(join(fixture.output, ".work", "openclaw", "package.json")),
      packageMembers("openclaw")[0].content,
    );
    await assert.rejects(lstat(join(fixture.output, "package.json")), { code: "ENOENT" });
  },
);

// READ tests exercise actual filesystem capture/copy/verification with inert
// bytes and explicit schema-2 component records. They never execute the bytes,
// a compiler, npm, Docker, native listener, or credential source.
async function readArtifactFixture(t) {
  const directory = await temporaryDirectory(t);
  const input = join(directory, "read-input");
  const output = join(directory, "read-output");
  await mkdir(input, { mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  for (const [label, path] of [
    ["input", input],
    ["output", output],
  ]) {
    const stat = await lstat(path);
    assert.equal(stat.isDirectory(), true, `READ fixture ${label} must be a directory.`);
    assert.equal(stat.uid, process.getuid(), `READ fixture ${label} must have the current owner.`);
    assert.equal(stat.mode & 0o7777, 0o700, `READ fixture ${label} must have private mode 0700.`);
  }
  const artifactPath = join(input, "oce-github-read");
  const manifestPath = join(input, "native-products.json");
  const bytes = Buffer.from("Inert READ artifact bytes; no executable behavior asserted.\n");
  await writeFile(artifactPath, bytes, { mode: 0o555 });
  const source = Buffer.from("Original component source bytes.\n");
  const cargoManifest = Buffer.from('[package]\nname="oce-native-egress"\nversion="0.0.0"\n');
  const sourceFiles = [
    {
      path: "dataplane/services/oce-native-egress/Cargo.toml",
      size: cargoManifest.length,
      sha256: digest(cargoManifest),
    },
    {
      path: "dataplane/services/oce-native-egress/src/bin/oce-github-read.rs",
      size: source.length,
      sha256: digest(source),
    },
  ];
  const compiler = {
    schemaVersion: 2,
    rustToolchain: "1.88.0",
    rustTarget: "x86_64-unknown-linux-gnu",
    imagePlatform: "linux/amd64",
    hostGlibcVersion: "component-only",
    sourceInputs: { sha256: digest(JSON.stringify(sourceFiles)), files: sourceFiles },
    tools: {
      rustc: { size: 1, sha256: digest("component-rustc"), version: "component rustc" },
      cargo: { size: 1, sha256: digest("component-cargo"), version: "component cargo" },
    },
    products: [
      {
        package: "oce-native-egress",
        binary: "oce-github-read",
        path: ".build/mvp/native/oce-github-read",
        staged: {
          sha256: digest(bytes),
          size: bytes.length,
          uid: process.getuid(),
          gid: process.getgid(),
          mode: "0555",
        },
        compilerArtifact: {
          buildTarget: "native-read",
          packageVersion: "0.0.0",
          manifestPath: sourceFiles[0].path,
          manifestSha256: sourceFiles[0].sha256,
          sourcePath: sourceFiles[1].path,
          sourceSha256: sourceFiles[1].sha256,
          rustTarget: "x86_64-unknown-linux-gnu",
          kind: ["bin"],
          crateTypes: ["bin"],
          test: false,
          fresh: false,
          buildFinished: true,
          messagesSha256: digest("Component Cargo message bytes; not a compiler run."),
          executablePath: "dataplane/target/x86_64-unknown-linux-gnu/release/oce-github-read",
          artifact: {
            sha256: digest(bytes),
            size: bytes.length,
            uid: process.getuid(),
            gid: process.getgid(),
            mode: "0755",
          },
        },
        dependencies: [],
        installationRequirements: {
          path: "/usr/local/bin/oce-github-read",
          uid: 0,
          gid: 0,
          mode: "0555",
        },
      },
    ],
  };
  const manifest = jsonBytes(compiler);
  await writeFile(manifestPath, manifest, { mode: 0o444 });
  const selection = {
    schemaVersion: 1,
    binary: "oce-github-read",
    package: "oce-native-egress",
    rustToolchain: compiler.rustToolchain,
    rustTarget: compiler.rustTarget,
    imagePlatform: compiler.imagePlatform,
    compilerManifest: { path: manifestPath, sha256: digest(manifest), size: manifest.length },
    artifact: { path: artifactPath, sha256: digest(bytes), size: bytes.length },
  };
  return { directory, input, output, artifactPath, manifestPath, bytes, compiler, selection };
}

async function changeReadCompiler(fixture, mutate) {
  mutate(fixture.compiler);
  const bytes = jsonBytes(fixture.compiler);
  await chmod(fixture.manifestPath, 0o644);
  await writeFile(fixture.manifestPath, bytes);
  await chmod(fixture.manifestPath, 0o444);
  fixture.selection.compilerManifest = {
    path: fixture.manifestPath,
    sha256: digest(bytes),
    size: bytes.length,
  };
}

test("READ captures actual retained files, stages exact bytes and verifies modes without execution", async (t) => {
  const f = await readArtifactFixture(t);
  const originalManifest = await readFile(f.manifestPath);
  const captured = await captureReadNativeArtifact(f.selection);
  try {
    await captured.assertCurrent();
    const stage = await captured.stage(f.output);
    assert.deepEqual(await readFile(join(f.output, "oce-github-read")), f.bytes);
    assert.deepEqual(await readFile(join(f.output, "read-native-build.json")), originalManifest);
    assert.equal((await lstat(join(f.output, "oce-github-read"))).mode & 0o7777, 0o555);
    assert.equal((await lstat(join(f.output, "read-native-build.json"))).mode & 0o7777, 0o444);
    assert.equal(stage.receipt.originalCapture.artifact.uid, process.getuid());
    assert.deepEqual(stage.receipt.installationRequirements, {
      path: "/usr/local/bin/oce-github-read",
      uid: 0,
      gid: 0,
      mode: "0555",
      compilerManifestPath: "/usr/local/share/openclaw/read-native-build.json",
      compilerManifestMode: "0444",
    });
    assert.equal(stage.receipt.qualification.installation, "declared-not-executed");
    assert.equal(stage.receipt.qualification.finalImage, null);
    assert.deepEqual(await verifyReadNativeStaging(f.output), stage.receipt);
    assert.throws(() => captured.stage(f.output), /staged once/);
  } finally {
    await captured.close();
  }
  await assert.rejects(captured.assertCurrent(), /closed/);
  await captured.close();
  assert.deepEqual(await readFile(f.artifactPath), f.bytes);
  assert.deepEqual(await readFile(f.manifestPath), originalManifest);
});

for (const [name, mutate] of [
  [
    "wrong product",
    (f) => {
      f.compiler.products[0].binary = "oce-github-mediation";
    },
  ],
  [
    "duplicate product",
    (f) => {
      f.compiler.products.push(structuredClone(f.compiler.products[0]));
    },
  ],
  [
    "wrong package",
    (f) => {
      f.compiler.products[0].package = "other-package";
    },
  ],
  [
    "wrong platform",
    (f) => {
      f.compiler.imagePlatform = "linux/arm64";
    },
  ],
  [
    "wrong target",
    (f) => {
      f.compiler.rustTarget = "aarch64-unknown-linux-gnu";
    },
  ],
  [
    "wrong source inventory hash",
    (f) => {
      f.compiler.sourceInputs.sha256 = "0".repeat(64);
    },
  ],
  [
    "missing original tool record",
    (f) => {
      delete f.compiler.tools.rustc;
    },
  ],
  [
    "mismatched staged digest",
    (f) => {
      f.compiler.products[0].staged.sha256 = "0".repeat(64);
    },
  ],
  [
    "mismatched staged size",
    (f) => {
      f.compiler.products[0].staged.size += 1;
    },
  ],
  [
    "wrong declared install mode",
    (f) => {
      f.compiler.products[0].installationRequirements.mode = "0777";
    },
  ],
  [
    "oversized immutable-consumer record",
    (f) => {
      f.compiler.padding = "x".repeat(65536);
    },
  ],
  [
    "oversized immutable-consumer container",
    (f) => {
      f.compiler.extra = Array(1025).fill(0);
    },
  ],
  [
    "missing compiler-artifact association",
    (f) => {
      delete f.compiler.products[0].compilerArtifact;
    },
  ],
  [
    "test-profile compiler artifact",
    (f) => {
      f.compiler.products[0].compilerArtifact.test = true;
    },
  ],
  [
    "nonexclusive bin target kind",
    (f) => {
      f.compiler.products[0].compilerArtifact.kind.push("example");
    },
  ],
  [
    "unbound compiler entrypoint",
    (f) => {
      f.compiler.products[0].compilerArtifact.sourceSha256 = "0".repeat(64);
    },
  ],
  [
    "invalid compiler messages digest",
    (f) => {
      f.compiler.products[0].compilerArtifact.messagesSha256 = "invalid";
    },
  ],
  [
    "unsuccessful build-finished record",
    (f) => {
      f.compiler.products[0].compilerArtifact.buildFinished = false;
    },
  ],
  [
    "nonboolean freshness",
    (f) => {
      f.compiler.products[0].compilerArtifact.fresh = "fresh";
    },
  ],
  [
    "different compiler output bytes",
    (f) => {
      f.compiler.products[0].compilerArtifact.artifact.sha256 = "0".repeat(64);
    },
  ],
  [
    "unbound local dependency",
    (f) => {
      f.compiler.products[0].dependencies.push({
        package: "fixture-dependency",
        version: "0.0.0",
        source: null,
        manifestPath: "dataplane/crates/fixture-dependency/Cargo.toml",
        manifestSha256: "0".repeat(64),
      });
    },
  ],
  [
    "own-package dependency substitute",
    (f) => {
      f.compiler.products[0].dependencies.push({
        package: "oce-native-egress",
        version: "0.0.0",
        source: "registry+https://example.invalid/index",
      });
    },
  ],
  [
    "host-path dependency source",
    (f) => {
      f.compiler.products[0].dependencies.push({
        package: "fixture-dependency",
        version: "0.0.0",
        source: "/private/local/source",
      });
    },
  ],
]) {
  test(`READ refuses ${name} from exact captured compiler records before staging`, async (t) => {
    const f = await readArtifactFixture(t);
    await changeReadCompiler(f, () => mutate(f));
    await assert.rejects(captureReadNativeArtifact(f.selection));
    assert.deepEqual(await readdir(f.output), []);
    assert.deepEqual(await readFile(f.artifactPath), f.bytes);
  });
}

for (const [name, mutate, expected] of [
  [
    "wrong manifest digest",
    async (f) => {
      f.selection.compilerManifest.sha256 = "0".repeat(64);
    },
    /digest mismatch/,
  ],
  [
    "wrong executable digest",
    async (f) => {
      f.selection.artifact.sha256 = "0".repeat(64);
    },
    /equal|mismatch/,
  ],
  [
    "writable executable",
    async (f) => {
      await chmod(f.artifactPath, 0o755);
    },
    /mode must be 0555/,
  ],
  [
    "special mode bits",
    async (f) => {
      await chmod(f.artifactPath, 0o4555);
    },
    /Unsafe READ input owner or mode/,
  ],
  [
    "nonregular executable",
    async (f) => {
      await rm(f.artifactPath);
      await mkdir(f.artifactPath);
    },
    /regular inode/,
  ],
  [
    "symlink executable",
    async (f) => {
      const original = join(f.directory, "original-read");
      await rename(f.artifactPath, original);
      await symlink(original, f.artifactPath);
    },
    /regular inode/,
  ],
  [
    "symlink ancestor",
    async (f) => {
      const original = join(f.directory, "original-input");
      await rename(f.input, original);
      await symlink(original, f.input);
    },
    /ENOTDIR|ELOOP/,
  ],
]) {
  test(`READ refuses ${name} without opening or running an unsupported endpoint`, async (t) => {
    const f = await readArtifactFixture(t);
    await mutate(f);
    await assert.rejects(captureReadNativeArtifact(f.selection), expected);
    assert.deepEqual(await readdir(f.output), []);
  });
}

test(
  "READ refuses a foreign executable owner when the test has real chown permission",
  {
    skip:
      process.getuid() !== 0
        ? "Actual foreign-owner inode case requires root chown; no ownership mock."
        : false,
  },
  async (t) => {
    const f = await readArtifactFixture(t);
    await chown(f.artifactPath, 65534, 65534);
    await assert.rejects(captureReadNativeArtifact(f.selection), /Unsafe READ input owner or mode/);
    assert.deepEqual(await readdir(f.output), []);
  },
);

for (const [name, mutate] of [
  [
    "same-byte inode replacement",
    async (f) => {
      await rename(f.artifactPath, join(f.input, "held-original"));
      await writeFile(f.artifactPath, f.bytes, { mode: 0o555 });
    },
  ],
  [
    "growth after capture",
    async (f) => {
      await chmod(f.artifactPath, 0o755);
      await writeFile(f.artifactPath, Buffer.concat([f.bytes, Buffer.from("growth")]));
      await chmod(f.artifactPath, 0o555);
    },
  ],
]) {
  test(`READ refuses ${name} against the still-held original file before copy`, async (t) => {
    const f = await readArtifactFixture(t);
    const captured = await captureReadNativeArtifact(f.selection);
    try {
      await captured.assertCurrent();
      await mutate(f);
      await assert.rejects(captured.stage(f.output), /identity changed/);
      assert.deepEqual(await readdir(f.output), []);
    } finally {
      await captured.close();
    }
  });
}

test("READ staging never overwrites an existing output inode", async (t) => {
  const f = await readArtifactFixture(t);
  const output = join(f.output, "oce-github-read");
  await writeFile(output, "existing unrelated file");
  const captured = await captureReadNativeArtifact(f.selection);
  try {
    await assert.rejects(captured.stage(f.output), { code: "EEXIST" });
  } finally {
    await captured.close();
  }
  assert.equal(await readFile(output, "utf8"), "existing unrelated file");
});

test("READ pre-entry cancellation preserves refusal and creates no staged files", async (t) => {
  const f = await readArtifactFixture(t);
  const controller = new AbortController();
  const failure = new Error("Selected READ capture cancelled.");
  controller.abort(failure);
  await assert.rejects(
    captureReadNativeArtifact(f.selection, { signal: controller.signal }),
    (error) => error === failure,
  );
  assert.deepEqual(await readdir(f.output), []);
});

test("READ close joins a queued staging operation and prevents its file entry", async (t) => {
  const f = await readArtifactFixture(t);
  const captured = await captureReadNativeArtifact(f.selection);
  const stage = captured.stage(f.output);
  const close = captured.close();
  const result = await Promise.allSettled([stage, close]);
  assert.equal(result[0].status, "rejected");
  assert.equal(result[1].status, "fulfilled");
  assert.deepEqual(await readdir(f.output), []);
  await assert.rejects(captured.assertCurrent(), /closed/);
});

for (const [name, mutate, expected] of [
  [
    "staged mode change",
    async (f) => {
      await chmod(join(f.output, "oce-github-read"), 0o755);
    },
    /mode must be 0555/,
  ],
  [
    "staged byte change",
    async (f) => {
      const path = join(f.output, "oce-github-read");
      const bytes = Buffer.from(f.bytes);
      bytes[0] ^= 1;
      await chmod(path, 0o755);
      await writeFile(path, bytes);
      await chmod(path, 0o555);
    },
    /digest mismatch/,
  ],
  [
    "staged symlink",
    async (f) => {
      const path = join(f.output, "oce-github-read");
      await rm(path);
      await symlink(f.artifactPath, path);
    },
    /regular inode/,
  ],
]) {
  test(`READ verification refuses ${name} after original staging has closed`, async (t) => {
    const f = await readArtifactFixture(t);
    const captured = await captureReadNativeArtifact(f.selection);
    try {
      await captured.stage(f.output);
    } finally {
      await captured.close();
    }
    await mutate(f);
    await assert.rejects(verifyReadNativeStaging(f.output), expected);
  });
}

test("READ selected context verifies native records, exact input selection and modes", async (t) => {
  const f = await readArtifactFixture(t);
  const context = await preparedFixture(t, undefined, { privateReadContext: true });
  const nativeDirectory = join(context.context, "native");
  await mkdir(nativeDirectory, { mode: 0o700 });
  const nativeStat = await lstat(nativeDirectory);
  assert.equal(nativeStat.isDirectory(), true, "READ fixture native staging must be a directory.");
  assert.equal(
    nativeStat.uid,
    process.getuid(),
    "READ fixture native staging must have the current owner.",
  );
  assert.equal(
    nativeStat.mode & 0o7777,
    0o700,
    "READ fixture native staging must have private mode 0700.",
  );
  const captured = await captureReadNativeArtifact(f.selection);
  let stage;
  try {
    stage = await captured.stage(nativeDirectory);
  } finally {
    await captured.close();
  }
  const inputBytes = jsonBytes({ readNative: f.selection });
  await writeFile(join(context.context, "inputs.json"), inputBytes);
  Object.assign(
    context.receipt.files.find((entry) => entry.path === "inputs.json"),
    {
      bytes: inputBytes.length,
      sha256: digest(inputBytes),
    },
  );
  context.receipt.readNative = stage.receipt;
  context.receipt.files.push(
    ...stage.files.map((entry) => ({ ...entry, path: `native/${entry.path}` })),
  );
  await saveReceipt(context);
  assert.deepEqual(await verifyContext(context.context), context.receipt);
  delete context.receipt.readNative;
  await saveReceipt(context);
  await assert.rejects(verifyContext(context.context), /Unselected READ artifact/);
});

test("READ selected preparation refuses missing compiler record before tooling or output", async (t) => {
  const f = await inputFixture(t);
  const read = await readArtifactFixture(t);
  f.input.readNative = read.selection;
  await rm(read.manifestPath);
  assertPreparationFailure(await runPreparation(f), /ENOENT/);
  await assert.rejects(lstat(f.output), { code: "ENOENT" });
});

test("READ Docker recipe installs exact root-owned paths before USER without a READ command", async () => {
  const recipe = await readFile(
    new URL("../../deploy/runtime/Dockerfile", import.meta.url),
    "utf8",
  );
  const install = recipe.indexOf(
    "install -o 0 -g 0 -m 0555 /opt/openclaw-read-staging/oce-github-read /usr/local/bin/oce-github-read",
  );
  const verify = recipe.indexOf("--verify-read-installed /opt/openclaw-read-staging");
  assert.ok(install > 0 && verify > install && recipe.indexOf("USER node") > verify);
  assert.match(recipe, /install -D -o 0 -g 0 -m 0444 .*read-native-build\.json/);
  assert.match(recipe, /npm ci --offline --omit=dev --ignore-scripts/);
  assert.doesNotMatch(
    recipe,
    /(?:CMD|ENTRYPOINT).*oce-github-read|oce-github-read --version|serve-git-read-v3/,
  );
});

// RPK-01: replace the actual immutable input bytes AND their selected size/hash.
// This avoids mistaking a digest mismatch for a received-JSON grammar refusal.
async function replaceReadCompilerBytes(fixture, bytes) {
  await chmod(fixture.manifestPath, 0o644);
  await writeFile(fixture.manifestPath, bytes);
  await chmod(fixture.manifestPath, 0o444);
  fixture.selection.compilerManifest = {
    path: fixture.manifestPath,
    sha256: digest(bytes),
    size: bytes.length,
  };
}
const compilerMember = (text, member) => `{${member},${text.slice(1)}`;
const compilerExtra = (text, raw) => compilerMember(text, `"extra":${raw}`);

for (const [name, received, code] of [
  ["duplicate raw ASCII key", (text) => compilerMember(text, '"schemaVersion":2'), "duplicate-key"],
  [
    "duplicate escape-equivalent ASCII key",
    (text) => compilerMember(text, '"\\u0073chemaVersion":2'),
    "duplicate-key",
  ],
  [
    "overlong invalid UTF-8",
    (text) =>
      Buffer.concat([
        Buffer.from('{"extra":"'),
        Buffer.from([0xc0, 0xaf]),
        Buffer.from(`",${text.slice(1)}`),
      ]),
    "invalid-utf8",
  ],
  [
    "incomplete UTF-8 scalar",
    (text) =>
      Buffer.concat([
        Buffer.from('{"extra":"'),
        Buffer.from([0xe2, 0x82]),
        Buffer.from(`",${text.slice(1)}`),
      ]),
    "invalid-utf8",
  ],
  [
    "preserved leading UTF-8 BOM",
    (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    "invalid-json",
  ],
  ["lone high surrogate escape", (text) => compilerExtra(text, '"\\ud800"'), "invalid-unicode"],
  ["lone low surrogate escape", (text) => compilerExtra(text, '"\\udfff"'), "invalid-unicode"],
  ["literal non-ASCII key", (text) => compilerMember(text, '"é":0'), "non-ascii-key"],
  ["escaped non-ASCII key", (text) => compilerMember(text, '"\\u00e9":0'), "non-ascii-key"],
  ["negative zero lexeme", (text) => compilerExtra(text, "-0"), "invalid-number"],
  ["negative integer lexeme", (text) => compilerExtra(text, "-1"), "invalid-number"],
  ["integral fraction lexeme", (text) => compilerExtra(text, "1.0"), "invalid-number"],
  ["lowercase exponent lexeme", (text) => compilerExtra(text, "1e0"), "invalid-number"],
  ["uppercase exponent lexeme", (text) => compilerExtra(text, "1E0"), "invalid-number"],
  ["unsafe integer lexeme", (text) => compilerExtra(text, "9007199254740992"), "invalid-number"],
  ["leading-zero integer lexeme", (text) => compilerExtra(text, "01"), "invalid-number"],
  ["positive-sign integer lexeme", (text) => compilerExtra(text, "+1"), "invalid-number"],
  ["trailing non-whitespace token", (text) => `${text} true`, "invalid-json"],
  ["unescaped string control", (text) => compilerExtra(text, '"\u0001"'), "invalid-json"],
  [
    "empty array at container depth 33",
    (text) => compilerExtra(text, "[".repeat(32) + "]".repeat(32)),
    "depth-limit",
  ],
  [
    "empty object at container depth 33",
    (text) => compilerExtra(text, '{"x":'.repeat(31) + "{}" + "}".repeat(31)),
    "depth-limit",
  ],
  [
    "more than 8192 value nodes with individually bounded containers",
    (text) =>
      compilerExtra(text, JSON.stringify(Array.from({ length: 8 }, () => Array(1024).fill(0)))),
    "node-limit",
  ],
  [
    "1025 array entries",
    (text) => compilerExtra(text, JSON.stringify(Array(1025).fill(0))),
    "container-limit",
  ],
  [
    "1025 object entries",
    (text) =>
      compilerExtra(
        text,
        JSON.stringify(
          Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`k${index}`, 0])),
        ),
      ),
    "container-limit",
  ],
]) {
  test(`READ raw compiler boundary refuses ${name} before binding or staging`, async (t) => {
    const f = await readArtifactFixture(t);
    const bytes = Buffer.from(received(JSON.stringify(f.compiler)));
    assert.ok(bytes.length < 65536, "This case isolates grammar/structure, not the byte ceiling.");
    await replaceReadCompilerBytes(f, bytes);
    assert.equal(f.selection.compilerManifest.size, bytes.length);
    assert.equal(f.selection.compilerManifest.sha256, digest(bytes));
    await assert.rejects(captureReadNativeArtifact(f.selection), {
      message: `Invalid READ compiler JSON: ${code}`,
    });
    // These observations run outside the rejected operation and its matcher.
    assert.deepEqual(await readdir(f.output), []);
    assert.deepEqual(await readFile(f.manifestPath), bytes);
    assert.equal((await lstat(f.manifestPath)).mode & 0o7777, 0o444);
    assert.deepEqual(await readFile(f.artifactPath), f.bytes);
  });
}

for (const [name, received] of [
  [
    "null, scalar Unicode, escaped ASCII keys and maximum safe integer",
    (text) =>
      compilerMember(
        text,
        '"nullable":null,"unicode":"é😀\\ud83d\\ude00","\\u0065scaped":true,"maximum":9007199254740991',
      ),
  ],
  [
    "empty array at container depth 32",
    (text) => compilerExtra(text, "[".repeat(31) + "]".repeat(31)),
  ],
  [
    "empty object at container depth 32",
    (text) => compilerExtra(text, '{"x":'.repeat(30) + "{}" + "}".repeat(30)),
  ],
  ["1024 array entries", (text) => compilerExtra(text, JSON.stringify(Array(1024).fill(0)))],
  [
    "1024 object entries",
    (text) =>
      compilerExtra(
        text,
        JSON.stringify(
          Object.fromEntries(Array.from({ length: 1024 }, (_, index) => [`k${index}`, 0])),
        ),
      ),
  ],
  [
    "seven 1024-entry arrays within the value-node bound",
    (text) =>
      compilerExtra(text, JSON.stringify(Array.from({ length: 7 }, () => Array(1024).fill(0)))),
  ],
  [
    "exactly 65536 received bytes including the final newline",
    (text) => text + " ".repeat(65535 - Buffer.byteLength(text, "utf8")),
  ],
]) {
  test(`READ raw compiler boundary preserves ${name} and exact selected file bytes`, async (t) => {
    const f = await readArtifactFixture(t);
    // Final LF is part of the original builder selection, never a self-digest
    // or a canonicalized substitute for the immutable received file.
    const bytes = Buffer.from(`${received(JSON.stringify(f.compiler))}\n`);
    assert.ok(bytes.length <= 65536);
    assert.equal(bytes.at(-1), 0x0a);
    assert.notEqual(digest(bytes), digest(bytes.subarray(0, bytes.length - 1)));
    await replaceReadCompilerBytes(f, bytes);
    const captured = await captureReadNativeArtifact(f.selection);
    try {
      await captured.assertCurrent();
      const stage = await captured.stage(f.output);
      const staged = await readFile(join(f.output, "read-native-build.json"));
      assert.deepEqual(staged, bytes);
      assert.equal(digest(staged), f.selection.compilerManifest.sha256);
      assert.equal(stage.receipt.selection.compilerManifest.size, bytes.length);
      assert.equal(stage.receipt.selection.compilerManifest.sha256, digest(bytes));
      assert.deepEqual(await verifyReadNativeStaging(f.output), stage.receipt);
    } finally {
      await captured.close();
    }
    await assert.rejects(captured.assertCurrent(), /closed/);
    assert.deepEqual(await readFile(f.manifestPath), bytes);
    assert.deepEqual(await readFile(f.artifactPath), f.bytes);
  });
}

test("READ raw compiler byte ceiling refuses 65537 selected bytes without staging", async (t) => {
  const f = await readArtifactFixture(t);
  const text = JSON.stringify(f.compiler);
  const bytes = Buffer.from(`${text}${" ".repeat(65536 - Buffer.byteLength(text, "utf8"))}\n`);
  assert.equal(bytes.length, 65537);
  await replaceReadCompilerBytes(f, bytes);
  // The existing finite descriptor-capture bound refuses this before a content
  // read; do not mistake the later lexical decoder for the only size gate.
  await assert.rejects(captureReadNativeArtifact(f.selection), { code: "ERR_ASSERTION" });
  assert.deepEqual(await readdir(f.output), []);
  assert.deepEqual(await readFile(f.manifestPath), bytes);
  assert.deepEqual(await readFile(f.artifactPath), f.bytes);
});

// RPK-02: a non-READ context still checks the original canonical regular-file
// gate before its newly introduced inputs.json JSON read.
test("non-READ verification refuses inputs.json directory before content read", async (t) => {
  const f = await preparedFixture(t);
  const receiptBefore = await readFile(join(f.context, "preparation.json"));
  const inputs = join(f.context, "inputs.json");
  await rm(inputs);
  await mkdir(inputs);
  await assert.rejects(verifyContext(f.context), { message: "Expected a regular file." });
  assert.equal((await lstat(inputs)).isDirectory(), true);
  assert.deepEqual(await readdir(inputs), []);
  assert.deepEqual(await readFile(join(f.context, "preparation.json")), receiptBefore);
});

test("non-READ verification rejects inputs.json symlink before decoding its invalid target", async (t) => {
  const f = await preparedFixture(t);
  const receiptBefore = await readFile(join(f.context, "preparation.json"));
  const inputs = join(f.context, "inputs.json");
  const outside = join(f.directory, "unselected-not-json");
  const sentinel = Buffer.from("This must not be opened and decoded as inputs JSON.\n");
  await writeFile(outside, sentinel);
  await rm(inputs);
  await symlink(outside, inputs);
  // Reading before the gate produces a SyntaxError instead of this exact
  // original regular-file refusal; no caller-positive replacement is involved.
  await assert.rejects(verifyContext(f.context), { message: "Expected a regular file." });
  assert.equal((await lstat(inputs)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(outside), sentinel);
  assert.deepEqual(await readFile(join(f.context, "preparation.json")), receiptBefore);
});
