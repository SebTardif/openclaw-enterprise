import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
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
import { gzipSync } from "node:zlib";
import {
  assertLocalGraph,
  normalizeRuntimeManifest,
  verifyContext,
} from "../../deploy/runtime/prepare-local-packages.mjs";

const preparer = fileURLToPath(
  new URL("../../deploy/runtime/prepare-local-packages.mjs", import.meta.url),
);
const names = [
  "openclaw",
  "@openclaw/ai",
  "@openclaw/slack",
  "@openclaw/msteams",
  "@openclaw/codex",
];
const version = "2026.8.1";
const toolingPath = process.env.OCC_TEST_RUNTIME_PACKAGE_TOOLS;
const toolingSha256 = process.env.OCC_TEST_RUNTIME_PACKAGE_TOOLS_SHA256;
const tarOptions =
  toolingPath === undefined
    ? {
        skip: "Set OCC_TEST_RUNTIME_PACKAGE_TOOLS and OCC_TEST_RUNTIME_PACKAGE_TOOLS_SHA256 to a self-contained package-tools.mjs bundle for real tar validation.",
      }
    : {};
const digest = (content, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(content).digest(encoding);
const integrity = (content) => `sha512-${digest(content, "sha512", "base64")}`;
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
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

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "oce-package-preparation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// These are real small USTAR archives used as package-preparation inputs. They do
// not contain an OpenClaw runtime and do not establish image qualification.
function archiveBytes(members) {
  const blocks = [];
  for (const { path, content = "", type = "0", link = "" } of members) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    assert.ok(Buffer.byteLength(path) < 100 && Buffer.byteLength(link) < 100);
    header.write(path, 0, 100);
    header.write("0000644\0", 100, 8);
    header.write("0000000\0", 108, 8);
    header.write("0000000\0", 116, 8);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    header.write("00000000000\0", 136, 12);
    header.fill(32, 148, 156);
    header.write(type, 156, 1);
    header.write(link, 157, 100);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function packageMembers(name) {
  return [
    { path: "package.json", content: jsonBytes({ name, version, type: "module" }) },
    { path: "index.js", content: "export const packagePreparationFixture = true;\n" },
  ];
}

function graphFixture(registry = "https://registry.npmjs.org/") {
  const manifest = {
    name: "oce-local-runtime",
    version: "0.0.0",
    private: true,
    dependencies: { "@openai/codex": "0.153.0" },
  };
  const lock = {
    lockfileVersion: 3,
    packages: {
      "node_modules/@openai/codex": {
        version: "0.153.0",
        resolved: new URL("@openai/codex/-/codex-0.153.0.tgz", registry).href,
        integrity: integrity("native lock metadata fixture"),
      },
    },
  };
  const archives = new Map();
  const packages = names.map((name) => {
    const archive = `artifacts/${name.replace(/^@/, "").replaceAll("/", "-")}.tgz`;
    const bytes = archiveBytes(packageMembers(name));
    archives.set(archive, bytes);
    const entry = { name, version, archive, integrity: integrity(bytes) };
    manifest.dependencies[name] = `file:./${archive}`;
    lock.packages[`node_modules/${name}`] = {
      name,
      version,
      resolved: `file:${archive}`,
      integrity: entry.integrity,
    };
    return entry;
  });
  lock.packages[""] = structuredClone(manifest);
  return { manifest, lock, packages, archives };
}

async function preparedFixture(t, registry) {
  const directory = await temporaryDirectory(t);
  const context = join(directory, "context");
  const graph = graphFixture(registry);
  const contents = new Map([
    ...graph.archives,
    ["package.json", jsonBytes(graph.manifest)],
    ["package-lock.json", jsonBytes(graph.lock)],
    [
      "lifecycle.json",
      jsonBytes({
        packages: [],
        execution: "No lifecycle scripts in this receipt-verification fixture.",
      }),
    ],
    ["package-inventories.json", jsonBytes([])],
    ["inputs.json", jsonBytes({ fixture: "receipt verification only" })],
    [".dockerignore", Buffer.from(".work\nnode_modules\n*.log\n")],
    ["empty.npmrc", Buffer.alloc(0)],
    ["empty-global.npmrc", Buffer.alloc(0)],
    ["policy/pnpm-lock.yaml", Buffer.from("lockfileVersion: '9.0'\n")],
    ["policy/pnpm-workspace.yaml", Buffer.from("{}\n")],
    ["cache/receipt-fixture", Buffer.from("Cache receipt verification fixture.\n")],
  ]);
  for (const [path, bytes] of contents) {
    await mkdir(dirname(join(context, path)), { recursive: true });
    await writeFile(join(context, path), bytes);
  }
  const receipt = {
    schema: "oce.runtime-packages/v1",
    status: "prepared",
    platform: "linux/amd64",
    nativeCodexVersion: "0.153.0",
    ...(registry === undefined ? {} : { registry }),
    packages: graph.packages,
    files: [...contents].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: digest(bytes),
    })),
    lifecycleActionsExecuted: [],
    registryPolicyViolations: [],
    applicablePatches: [],
  };
  await writeFile(join(context, "preparation.json"), jsonBytes(receipt));
  return { directory, context, receipt, contents };
}

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
