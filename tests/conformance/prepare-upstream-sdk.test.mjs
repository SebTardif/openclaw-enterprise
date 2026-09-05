import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { prepareUpstreamSdk } from "../../scripts/prepare-upstream-sdk.mjs";

const helper = fileURLToPath(new URL("../../scripts/prepare-upstream-sdk.mjs", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const destinations = {
  openclaw: "openclaw",
  "@openclaw/ai": "openclaw/node_modules/@openclaw/ai",
  "@types/ws": "node_modules/@types/ws",
};

// Small real tar archives keep these setup fixtures realistic. The helper pins
// archive hashes and copied files independently; it does not unpack the archives.
function tarBytes(files) {
  const blocks = [];
  for (const { path, content, mode } of files) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    assert.ok(Buffer.byteLength(path) < 100);
    header.write(path, 0, 100);
    header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8);
    header.write("0000000\0", 108, 8);
    header.write("0000000\0", 116, 8);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    header.write("00000000000\0", 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156, 1);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

async function writeInput(fixture, path, content, mode = 0o644) {
  const bytes = Buffer.from(content);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  await chmod(path, mode);
  fixture.inputs.set(path, { bytes, mode });
  return { path, bytes: bytes.length, mode, sha256: hash(bytes) };
}

async function saveManifest(fixture) {
  const bytes = jsonBytes(fixture.manifest);
  await writeInput(fixture, fixture.manifestPath, bytes);
  fixture.manifestSha256 = hash(bytes);
}

async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "oce-upstream-sdk-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = {
    directory,
    output: join(directory, "workspace", ".build", "upstream-sdk"),
    manifestPath: join(directory, "layout.json"),
    inputs: new Map(),
    marker: join(directory, "sdk-executed"),
  };
  await mkdir(dirname(fixture.output), { recursive: true });
  // Importing a payload entry or executing its lifecycle script would create the
  // marker and fail. Setup must only read, verify, copy, and link these packages.
  const sentinel = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(fixture.marker)}, "executed");\nthrow new Error("SDK payload must not execute during setup.");\n`;
  fixture.manifest = {
    schema: "oce.upstream-sdk-layout/v1",
    provenance: { fixture: "filesystem setup conformance; no SDK runtime qualification" },
    packages: [],
    links: [],
  };
  for (const [name, destination] of Object.entries(destinations)) {
    const source = join(directory, "source", destination);
    const version = name === "@types/ws" ? "8.18.1" : "2026.8.1";
    const packageJson = {
      name,
      version,
      type: "module",
      ...(name === "@types/ws"
        ? { types: "index.d.ts" }
        : { main: "index.mjs", scripts: { postinstall: "node index.mjs" } }),
      ...(name === "openclaw"
        ? {
            exports: {
              "./plugin-sdk/channel-inbound": {
                types: "./dist/plugin-sdk/channel-inbound.d.ts",
                default: "./index.mjs",
              },
            },
          }
        : {}),
    };
    const files = [
      { path: "package.json", content: jsonBytes(packageJson), mode: 0o644 },
      name === "@types/ws"
        ? { path: "index.d.ts", content: "export interface WebSocket {}\n", mode: 0o644 }
        : { path: "index.mjs", content: sentinel, mode: 0o644 },
    ];
    if (name === "openclaw")
      files.push(
        {
          path: "dist/plugin-sdk/channel-inbound.d.ts",
          content: "export interface SetupFixtureEnvelope { readonly id: string }\n",
          mode: 0o640,
        },
        { path: "bin/sdk-fixture.mjs", content: `#!/usr/bin/env node\n${sentinel}`, mode: 0o751 },
      );
    const entry = { name, version, source, files: [] };
    for (const file of files) {
      const record = await writeInput(fixture, join(source, file.path), file.content, file.mode);
      entry.files.push({ ...record, path: file.path });
    }
    if (name !== "@types/ws")
      entry.archive = await writeInput(
        fixture,
        join(directory, "archives", `${name === "openclaw" ? "openclaw" : "ai"}.tgz`),
        tarBytes(files),
      );
    fixture.manifest.packages.push(entry);
  }
  const dependencies = new Map();
  for (const [name, version] of [
    ["ws", "8.18.0"],
    ["zod", "4.0.0"],
    ["@types/node", "24.0.0"],
  ]) {
    const target = join(directory, "external-dependencies", name);
    const record = await writeInput(
      fixture,
      join(target, "package.json"),
      jsonBytes({
        name,
        version,
        type: "module",
        main: "index.mjs",
        scripts: { postinstall: "node index.mjs" },
      }),
    );
    await writeInput(fixture, join(target, "index.mjs"), sentinel);
    await writeInput(
      fixture,
      join(target, "external-payload.txt"),
      `${name} stays in its external dependency directory.\n`,
    );
    dependencies.set(name, { name, version, target, manifestSha256: record.sha256 });
  }
  for (const [name, path] of [
    ["ws", "node_modules/ws"],
    ["@types/node", "node_modules/@types/node"],
    ["zod", "openclaw/node_modules/zod"],
    ["zod", "openclaw/node_modules/@openclaw/ai/node_modules/zod"],
  ])
    fixture.manifest.links.push({ ...dependencies.get(name), path });
  await writeInput(
    fixture,
    join(directory, "source", "openclaw", "node_modules", "not-selected", "index.mjs"),
    sentinel,
  );
  await saveManifest(fixture);
  return fixture;
}

function prepare(fixture) {
  return prepareUpstreamSdk({
    manifestPath: fixture.manifestPath,
    manifestSha256: fixture.manifestSha256,
    output: fixture.output,
  });
}

async function replacePackageJson(fixture, name, mutate) {
  const entry = fixture.manifest.packages.find((item) => item.name === name);
  const record = entry.files.find((file) => file.path === "package.json");
  const path = join(entry.source, record.path);
  const value = JSON.parse(await readFile(path, "utf8"));
  mutate(value);
  const replacement = await writeInput(fixture, path, jsonBytes(value), record.mode);
  Object.assign(record, replacement, { path: "package.json" });
}

async function outputEntries(root) {
  const files = [];
  const links = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) links.push(name);
      else if (entry.isDirectory()) await walk(path);
      else files.push(name);
    }
  }
  await walk(root);
  return { files: files.sort(), links: links.sort() };
}

async function assertPrepared(fixture, receipt) {
  const expectedFiles = ["preparation.json"];
  for (const entry of fixture.manifest.packages) {
    assert.equal((await lstat(join(fixture.output, destinations[entry.name]))).isDirectory(), true);
    for (const file of entry.files) {
      const destination = join(destinations[entry.name], file.path);
      expectedFiles.push(destination);
      const target = join(fixture.output, destination);
      assert.equal((await lstat(target)).isFile(), true);
      assert.deepEqual(await readFile(target), await readFile(join(entry.source, file.path)));
      assert.equal((await lstat(target)).mode & 0o777, file.mode);
    }
  }
  for (const link of fixture.manifest.links) {
    const path = join(fixture.output, link.path);
    assert.equal((await lstat(path)).isSymbolicLink(), true);
    assert.equal(await readlink(path), link.target);
    assert.equal(await realpath(path), link.target);
    assert.deepEqual(
      await readFile(join(path, "external-payload.txt")),
      await readFile(join(link.target, "external-payload.txt")),
    );
  }
  assert.deepEqual(await outputEntries(fixture.output), {
    files: expectedFiles.sort(),
    links: fixture.manifest.links.map((entry) => entry.path).sort(),
  });
  assert.equal(receipt.schema, "oce.upstream-sdk-preparation/v1");
  assert.equal(receipt.status, "prepared");
  assert.equal(receipt.manifestSha256, fixture.manifestSha256);
  assert.equal(receipt.fileCount, expectedFiles.length - 1);
  assert.equal(receipt.linkCount, fixture.manifest.links.length);
  assert.deepEqual(receipt.links, fixture.manifest.links);
  assert.deepEqual(receipt.provenance, fixture.manifest.provenance);
  assert.deepEqual(
    receipt.packages,
    fixture.manifest.packages.map((entry) => ({
      name: entry.name,
      version: entry.version,
      destination: destinations[entry.name],
      files: entry.files.length,
      ...(entry.archive ? { archiveSha256: entry.archive.sha256 } : {}),
    })),
  );
  assert.match(receipt.dependencyBoundary, /do not verify their complete contents/);
  assert.deepEqual(
    JSON.parse(await readFile(join(fixture.output, "preparation.json"), "utf8")),
    receipt,
  );
  for (const [path, original] of fixture.inputs) {
    assert.deepEqual(await readFile(path), original.bytes);
    assert.equal((await lstat(path)).mode & 0o777, original.mode);
  }
  await assert.rejects(lstat(fixture.marker), { code: "ENOENT" });
}

function runCli(fixture) {
  return spawnSync(
    process.execPath,
    [
      helper,
      "--manifest",
      fixture.manifestPath,
      "--sha256",
      fixture.manifestSha256,
      "--output",
      fixture.output,
    ],
    { env: { PATH: "", LANG: "C.UTF-8" }, encoding: "utf8", timeout: 10_000, maxBuffer: 1_000_000 },
  );
}

test("upstream SDK setup copies complete packages, preserves modes, and links external dependencies without execution", async (t) => {
  const fixture = await createFixture(t);
  const receipt = await prepare(fixture);
  // The returned receipt may contain an undefined optional archive key; the
  // persisted JSON is the contract shared with external consumers.
  await assertPrepared(fixture, JSON.parse(JSON.stringify(receipt)));
});

test("upstream SDK setup CLI produces the same verified layout and completion receipt", async (t) => {
  const fixture = await createFixture(t);
  const result = runCli(fixture);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(await readFile(join(fixture.output, "preparation.json"), "utf8"));
  assert.equal(
    result.stdout,
    `Prepared ${receipt.fileCount} package files and ${receipt.linkCount} local dependency links.\n`,
  );
  await assertPrepared(fixture, receipt);
});

const rejections = [
  [
    "wrong archive digest",
    async (f) => {
      f.manifest.packages[0].archive.sha256 = "0".repeat(64);
    },
    /File digest mismatch/,
  ],
  [
    "missing archive",
    async (f) => {
      await rm(f.manifest.packages[0].archive.path);
    },
    /ENOENT/,
  ],
  [
    "wrong payload digest",
    async (f) => {
      const entry = f.manifest.packages[0];
      const file = entry.files[1];
      const path = join(entry.source, file.path);
      const bytes = await readFile(path);
      bytes[0] ^= 1;
      await writeFile(path, bytes);
    },
    /File digest mismatch/,
  ],
  [
    "wrong payload size",
    async (f) => {
      f.manifest.packages[0].files[0].bytes += 1;
    },
    /File length mismatch/,
  ],
  [
    "wrong payload mode",
    async (f) => {
      await chmod(join(f.manifest.packages[0].source, "bin/sdk-fixture.mjs"), 0o644);
    },
    /File mode mismatch/,
  ],
  [
    "missing payload",
    async (f) => {
      await rm(join(f.manifest.packages[0].source, "index.mjs"));
    },
    /ENOENT/,
  ],
  [
    "unlisted payload",
    async (f) => {
      await writeFile(join(f.manifest.packages[0].source, "extra.txt"), "unlisted");
    },
    /Package inventory is incomplete/,
  ],
  [
    "symlinked payload",
    async (f) => {
      const path = join(f.manifest.packages[0].source, "index.mjs");
      const target = join(f.directory, "payload.mjs");
      await rename(path, target);
      await symlink(target, path);
    },
    /Expected a regular file/,
  ],
  [
    "symlinked payload ancestor",
    async (f) => {
      const path = join(f.manifest.packages[0].source, "dist");
      const target = join(f.directory, "declarations");
      await rename(path, target);
      await symlink(target, path);
    },
    /must not traverse symlinks/,
  ],
  [
    "wrong copied package identity",
    async (f) => {
      await replacePackageJson(f, "openclaw", (value) => {
        value.name = "substitute";
      });
    },
    /Package identity mismatch/,
  ],
  [
    "wrong copied package version",
    async (f) => {
      await replacePackageJson(f, "openclaw", (value) => {
        value.version = "2026.8.2";
      });
    },
    /Package version mismatch/,
  ],
  [
    "mismatched root and AI versions",
    async (f) => {
      f.manifest.packages[1].version = "2026.8.2";
      await replacePackageJson(f, "@openclaw/ai", (value) => {
        value.version = "2026.8.2";
      });
    },
    /Root and nested AI versions must agree/,
  ],
  [
    "duplicate package member",
    async (f) => {
      f.manifest.packages[0].files.push(f.manifest.packages[0].files[0]);
    },
    /Duplicate package inventory member/,
  ],
  [
    "unsafe package member",
    async (f) => {
      f.manifest.packages[0].files[0].path = "../outside";
    },
    /Unsafe package path/,
  ],
  [
    "absolute package member",
    async (f) => {
      f.manifest.packages[0].files[0].path = join(f.directory, "outside");
    },
    /Expected a relative package path/,
  ],
  [
    "copied dependency tree",
    async (f) => {
      f.manifest.packages[0].files[0].path = "node_modules/zod/package.json";
    },
    /Package dependency trees must not be copied/,
  ],
  [
    "missing required type export",
    async (f) => {
      await replacePackageJson(f, "openclaw", (value) => {
        delete value.exports;
      });
    },
    /real channel-inbound type export is required/,
  ],
  [
    "unlisted type export target",
    async (f) => {
      await replacePackageJson(f, "openclaw", (value) => {
        value.exports["./plugin-sdk/channel-inbound"].types = "./dist/missing.d.ts";
      });
    },
    /declaration is missing from the complete package inventory/,
  ],
  [
    "duplicate physical package",
    async (f) => {
      f.manifest.packages.push(f.manifest.packages[0]);
    },
    /Exactly openclaw/,
  ],
  [
    "duplicate dependency link",
    async (f) => {
      f.manifest.links.push(f.manifest.links[0]);
    },
    /Duplicate dependency link/,
  ],
  [
    "link substituting a copied package",
    async (f) => {
      f.manifest.links[0].name = "@types/ws";
      f.manifest.links[0].path = "node_modules/@types/ws";
    },
    /must not substitute a copied package/,
  ],
  [
    "link outside declared dependency directories",
    async (f) => {
      f.manifest.links[0].path = "openclaw/dist/node_modules/ws";
    },
    /explicit dependency directory/,
  ],
  [
    "wrong dependency identity",
    async (f) => {
      Object.assign(f.manifest.links[0], {
        target: f.manifest.links[2].target,
        manifestSha256: f.manifest.links[2].manifestSha256,
      });
    },
    /Dependency identity mismatch/,
  ],
  [
    "wrong dependency version",
    async (f) => {
      f.manifest.links[0].version = "0.0.1";
    },
    /Dependency version mismatch/,
  ],
  [
    "wrong dependency manifest digest",
    async (f) => {
      f.manifest.links[0].manifestSha256 = "0".repeat(64);
    },
    /File digest mismatch/,
  ],
  [
    "symlinked dependency target",
    async (f) => {
      const target = f.manifest.links[0].target;
      const alias = join(f.directory, "linked-dependency");
      await symlink(target, alias);
      f.manifest.links[0].target = alias;
    },
    /Expected a regular directory/,
  ],
  [
    "symlinked archive ancestry",
    async (f) => {
      const original = dirname(f.manifest.packages[0].archive.path);
      const target = join(f.directory, "moved-archives");
      await rename(original, target);
      await symlink(target, original);
    },
    /must not traverse symlinks/,
  ],
];
for (const [name, mutate, expected] of rejections) {
  test(`upstream SDK setup rejects ${name} before creating output`, async (t) => {
    const fixture = await createFixture(t);
    await mutate(fixture);
    // Rebind the outer manifest so the intended inner validation is exercised.
    await saveManifest(fixture);
    await assert.rejects(prepare(fixture), expected);
    await assert.rejects(lstat(fixture.output), { code: "ENOENT" });
    await assert.rejects(lstat(fixture.marker), { code: "ENOENT" });
  });
}

test("upstream SDK setup CLI rejects an incorrect pinned manifest before output", async (t) => {
  const fixture = await createFixture(t);
  fixture.manifestSha256 = "0".repeat(64);
  const result = runCli(fixture);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Upstream SDK preparation failed: File digest mismatch/);
  await assert.rejects(lstat(fixture.output), { code: "ENOENT" });
});

test("upstream SDK setup rejects a manifest path through a symlinked parent", async (t) => {
  const fixture = await createFixture(t);
  const alias = join(fixture.directory, "input-alias");
  const target = join(fixture.directory, "manifest-input");
  await mkdir(target);
  await rename(fixture.manifestPath, join(target, "layout.json"));
  await symlink(target, alias);
  fixture.manifestPath = join(alias, "layout.json");
  await assert.rejects(prepare(fixture), /must not traverse symlinks/);
  await assert.rejects(lstat(fixture.output), { code: "ENOENT" });
});

test("upstream SDK setup preserves an occupied output directory when invoked through the CLI", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(fixture.output);
  const sentinel = join(fixture.output, "keep.txt");
  await writeFile(sentinel, "Existing workspace remains intact.\n");
  const result = runCli(fixture);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Output is occupied/);
  assert.deepEqual(await readdir(fixture.output), ["keep.txt"]);
  assert.equal(await readFile(sentinel, "utf8"), "Existing workspace remains intact.\n");
});

for (const kind of ["file", "dangling symlink"]) {
  test(`upstream SDK setup preserves an occupied output ${kind}`, async (t) => {
    const fixture = await createFixture(t);
    if (kind === "file") await writeFile(fixture.output, "Existing output file.\n");
    else await symlink(join(fixture.directory, "missing"), fixture.output);
    await assert.rejects(prepare(fixture), /Output is occupied/);
    if (kind === "file")
      assert.equal(await readFile(fixture.output, "utf8"), "Existing output file.\n");
    else assert.equal(await readlink(fixture.output), join(fixture.directory, "missing"));
  });
}

test("upstream SDK setup rejects a symlinked output parent", async (t) => {
  const fixture = await createFixture(t);
  const original = dirname(fixture.output);
  const target = join(fixture.directory, "actual-build");
  await rename(original, target);
  await symlink(target, original);
  await assert.rejects(prepare(fixture), /Expected a regular directory/);
  assert.deepEqual(await readdir(target), []);
});

test("upstream SDK setup rejects an output inside a package input", async (t) => {
  const fixture = await createFixture(t);
  fixture.output = join(fixture.manifest.packages[0].source, ".build", "upstream-sdk");
  await mkdir(dirname(fixture.output));
  await assert.rejects(prepare(fixture), /Output must not overlap an input/);
  await assert.rejects(lstat(fixture.output), { code: "ENOENT" });
});
