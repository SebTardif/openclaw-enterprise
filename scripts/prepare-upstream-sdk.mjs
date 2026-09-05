#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const layout = {
  openclaw: "openclaw",
  "@openclaw/ai": "openclaw/node_modules/@openclaw/ai",
  "@types/ws": "node_modules/@types/ws",
};
const dependencyDirectories = [
  "node_modules",
  "openclaw/node_modules",
  "openclaw/node_modules/@openclaw/ai/node_modules",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validDigest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const contains = (parent, child) => parent === child || child.startsWith(`${parent}${sep}`);

function packagePath(value) {
  assert.ok(
    typeof value === "string" &&
      value &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !isAbsolute(value),
    "Expected a relative package path.",
  );
  assert.ok(
    value.split("/").every((part) => part && part !== "." && part !== ".."),
    "Unsafe package path.",
  );
  return value;
}

async function canonical(path, kind) {
  assert.ok(
    typeof path === "string" && isAbsolute(path) && resolve(path) === path,
    "Input paths must be absolute and canonical.",
  );
  const stat = await lstat(path);
  assert.ok(
    !stat.isSymbolicLink() && (kind === "directory" ? stat.isDirectory() : stat.isFile()),
    `Expected a regular ${kind}.`,
  );
  assert.equal(await realpath(path), path, "Input paths must not traverse symlinks.");
  return stat;
}

async function verifiedFile(record) {
  assert.ok(record && validDigest(record.sha256), "Expected a pinned file SHA-256.");
  const before = await canonical(record.path, "file");
  const bytes = await readFile(record.path);
  assert.equal(digest(bytes), record.sha256, `File digest mismatch: ${record.path}`);
  if (record.bytes !== undefined) assert.equal(bytes.length, record.bytes, "File length mismatch.");
  const after = await canonical(record.path, "file");
  assert.ok(
    before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs,
    "Input changed during verification.",
  );
  if (record.mode !== undefined)
    assert.equal(after.mode & 0o777, record.mode, "File mode mismatch.");
  return bytes;
}

async function payloadPaths(root) {
  const paths = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Third-party dependencies are explicit links, not copied package payload.
      if (directory === root && entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), "Package payload must not contain symlinks.");
      if (entry.isDirectory()) await walk(path);
      else {
        assert.ok(entry.isFile(), "Unsupported package payload entry.");
        paths.push(relative(root, path).split(sep).join("/"));
      }
    }
  }
  await walk(root);
  return paths.sort();
}

function disjointInput(output, input) {
  assert.ok(typeof input === "string", "An explicit input path is required.");
  assert.ok(
    !contains(output, input) && !contains(input, output),
    "Output must not overlap an input.",
  );
}

function exportTarget(manifest, files) {
  const target = manifest.exports?.["./plugin-sdk/channel-inbound"]?.types;
  assert.ok(
    typeof target === "string" && target.startsWith("./"),
    "The real channel-inbound type export is required.",
  );
  assert.ok(
    files.has(packagePath(target.slice(2))),
    "Channel-inbound declaration is missing from the complete package inventory.",
  );
}

export async function prepareUpstreamSdk({ manifestPath, manifestSha256, output }) {
  assert.ok(
    typeof output === "string" && isAbsolute(output) && resolve(output) === output,
    "Output must be an absolute canonical path.",
  );
  assert.ok(
    basename(output) === "upstream-sdk" && basename(dirname(output)) === ".build",
    "Output must end in .build/upstream-sdk.",
  );
  await canonical(dirname(output), "directory");
  let absent = false;
  try {
    await lstat(output);
  } catch (error) {
    if (error.code === "ENOENT") absent = true;
    else throw error;
  }
  assert.ok(absent, "Output is occupied; select a new prepared workspace.");
  disjointInput(output, manifestPath);
  const manifestBytes = await verifiedFile({ path: manifestPath, sha256: manifestSha256 });
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schema, "oce.upstream-sdk-layout/v1");
  assert.ok(Array.isArray(manifest.packages) && Array.isArray(manifest.links));
  assert.deepEqual(
    manifest.packages.map((entry) => entry.name).sort(),
    Object.keys(layout).sort(),
    "Exactly openclaw, nested @openclaw/ai and @types/ws are required.",
  );
  const prepared = [];
  const sources = [];
  for (const entry of manifest.packages) {
    await canonical(entry.source, "directory");
    disjointInput(output, entry.source);
    assert.ok(typeof entry.version === "string" && entry.version.length > 0);
    assert.ok(
      Array.isArray(entry.files) && entry.files.length > 0,
      "A complete package inventory is required.",
    );
    if (entry.name !== "@types/ws") {
      disjointInput(output, entry.archive?.path);
      await verifiedFile(entry.archive);
    }
    const names = new Set();
    const files = [];
    for (const file of entry.files) {
      const path = packagePath(file.path);
      assert.ok(
        !path.startsWith("node_modules/") && path !== "node_modules",
        "Package dependency trees must not be copied.",
      );
      assert.ok(!names.has(path), "Duplicate package inventory member.");
      names.add(path);
      assert.ok(
        Number.isSafeInteger(file.bytes) &&
          file.bytes >= 0 &&
          Number.isInteger(file.mode) &&
          file.mode >= 0 &&
          file.mode <= 0o777,
        "File size and mode must be explicit.",
      );
      const source = { ...file, path: join(entry.source, path) };
      await verifiedFile(source);
      files.push({ source, destination: join(layout[entry.name], path) });
    }
    assert.deepEqual(
      [...names].sort(),
      await payloadPaths(entry.source),
      "Package inventory is incomplete or contains missing files.",
    );
    assert.ok(names.has("package.json"), "Package manifest is missing.");
    const packageJson = JSON.parse(
      await verifiedFile(
        files.find((file) => file.source.path === join(entry.source, "package.json")).source,
      ),
    );
    assert.equal(packageJson.name, entry.name, "Package identity mismatch.");
    assert.equal(packageJson.version, entry.version, "Package version mismatch.");
    if (entry.name === "openclaw") exportTarget(packageJson, names);
    prepared.push({
      name: entry.name,
      version: entry.version,
      destination: layout[entry.name],
      files: files.length,
      archiveSha256: entry.archive?.sha256,
    });
    sources.push(...files);
  }
  assert.equal(
    prepared.find((entry) => entry.name === "openclaw").version,
    prepared.find((entry) => entry.name === "@openclaw/ai").version,
    "Root and nested AI versions must agree.",
  );
  const linkPaths = new Set();
  for (const entry of manifest.links) {
    packagePath(entry.path);
    assert.ok(
      typeof entry.name === "string" && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(entry.name),
      "Invalid dependency package name.",
    );
    assert.ok(!Object.hasOwn(layout, entry.name), "A link must not substitute a copied package.");
    assert.ok(
      dependencyDirectories.some((directory) => entry.path === `${directory}/${entry.name}`),
      "Dependency links must name a package in an explicit dependency directory.",
    );
    assert.ok(!linkPaths.has(entry.path), "Duplicate dependency link.");
    linkPaths.add(entry.path);
    await canonical(entry.target, "directory");
    disjointInput(output, entry.target);
    const packageJson = JSON.parse(
      await verifiedFile({
        path: join(entry.target, "package.json"),
        sha256: entry.manifestSha256,
      }),
    );
    assert.equal(packageJson.name, entry.name, "Dependency identity mismatch.");
    assert.equal(packageJson.version, entry.version, "Dependency version mismatch.");
  }
  // Publish a completion receipt only after copying and rechecking every file.
  // Failure leaves the new output for inspection; existing outputs are never removed.
  await mkdir(output);
  for (const file of sources) {
    const target = join(output, file.destination);
    await mkdir(dirname(target), { recursive: true });
    const bytes = await verifiedFile(file.source);
    await writeFile(target, bytes, { flag: "wx", mode: file.source.mode });
    await chmod(target, file.source.mode);
    assert.equal(digest(await readFile(target)), file.source.sha256);
  }
  for (const entry of manifest.links) {
    const target = join(output, entry.path);
    await verifiedFile({ path: join(entry.target, "package.json"), sha256: entry.manifestSha256 });
    await mkdir(dirname(target), { recursive: true });
    await symlink(entry.target, target, "dir");
    assert.equal(await realpath(target), entry.target);
  }
  await verifiedFile({ path: manifestPath, sha256: manifestSha256 });
  const receipt = {
    schema: "oce.upstream-sdk-preparation/v1",
    status: "prepared",
    manifestSha256,
    packages: prepared,
    fileCount: sources.length,
    linkCount: manifest.links.length,
    links: manifest.links,
    provenance: manifest.provenance,
    dependencyBoundary:
      "External dependencies remain local inputs; package-manifest identity checks do not verify their complete contents or establish a portable installation or complete declaration closure.",
  };
  await writeFile(join(output, "preparation.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
  });
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [manifestFlag, manifestPath, hashFlag, manifestSha256, outputFlag, output, ...extra] =
      process.argv.slice(2);
    assert.ok(
      manifestFlag === "--manifest" &&
        hashFlag === "--sha256" &&
        outputFlag === "--output" &&
        !extra.length,
      "Usage: node scripts/prepare-upstream-sdk.mjs --manifest <absolute-file> --sha256 <manifest-sha256> --output <absolute-workspace>/.build/upstream-sdk",
    );
    const receipt = await prepareUpstreamSdk({ manifestPath, manifestSha256, output });
    console.log(
      `Prepared ${receipt.fileCount} package files and ${receipt.linkCount} local dependency links.`,
    );
  } catch (error) {
    console.error(`Upstream SDK preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
