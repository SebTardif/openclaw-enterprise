#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LOCAL_PACKAGES = [
  "openclaw",
  "@openclaw/ai",
  "@openclaw/slack",
  "@openclaw/msteams",
  "@openclaw/codex",
];
const SCHEMA = "oce.runtime-packages/v1";
const NATIVE_VERSION = "0.153.0";
const hash = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

const READ_BINARY = "oce-github-read";
const READ_MANIFEST = "read-native-build.json";
const READ_RECEIPT = "read-installation.json";
const READ_INSTALL = "/usr/local/bin/oce-github-read";
const READ_MANIFEST_INSTALL = "/usr/local/share/openclaw/read-native-build.json";
const READ_MAX_BYTES = 256 * 1024 * 1024;
// Match the unchanged protected artifact consumer's effective JSON ceiling.
const READ_MAX_MANIFEST = 65536;
const O_PATH = 0x200000;
const identityKeys = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"];
const directoryIdentityKeys = ["dev", "ino", "mode", "uid", "gid"];
const identity = (stat) => Object.fromEntries(identityKeys.map((key) => [key, String(stat[key])]));
const sameIdentity = (left, right, keys = identityKeys) =>
  keys.every((key) => left[key] === right[key]);
const active = (signal) => signal?.throwIfAborted();
const safeOwner = (stat) => stat.uid === 0n || stat.uid === BigInt(process.getuid());

async function readExact(file, size, signal) {
  const bytes = Buffer.alloc(size + 1);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      active(signal);
      const result = await file.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
      active(signal);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    assert.equal(offset, size, "READ input grew or truncated during bounded capture.");
    return bytes.subarray(0, size);
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

/** Retain every ancestor and an O_PATH type anchor before opening content.
 * Reopening /proc/self/fd is intentionally confined to that verified inode;
 * no FIFO/device/symlink pathname is content-opened. This is source capture,
 * not a credential, compiler signature or installed-image authority. */
async function captureReadFile(
  path,
  expected,
  { executable = false, signal, observeDigest = false } = {},
) {
  assert.equal(process.platform, "linux", "READ artifact capture requires Linux.");
  assert.ok(isAbsolute(path) && resolve(path) === path && path !== "/" && !path.includes("\0"));
  assert.ok(
    Number.isSafeInteger(expected.size) &&
      expected.size > 0 &&
      expected.size <= (executable ? READ_MAX_BYTES : READ_MAX_MANIFEST),
  );
  if (!observeDigest || expected.sha256 !== undefined)
    assert.match(expected.sha256, /^[a-f0-9]{64}$/);
  const handles = [];
  const directories = [];
  let content;
  let bytes;
  let closing;
  const close = () =>
    (closing ??= (async () => {
      const failures = [];
      bytes?.fill(0);
      for (const handle of [...handles].reverse()) {
        try {
          await handle.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "READ capture handles did not close.");
    })());
  try {
    active(signal);
    let parent = await open("/", O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(parent);
    let cursor = "/";
    const root = await parent.stat({ bigint: true });
    directories.push({ path: cursor, handle: parent, stat: root });
    const pieces = path.slice(1).split("/");
    for (const name of pieces.slice(0, -1)) {
      active(signal);
      assert.ok(name && name !== "." && name !== "..");
      const handle = await open(
        `/proc/self/fd/${parent.fd}/${name}`,
        O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(handle);
      const stat = await handle.stat({ bigint: true });
      assert.ok(
        stat.isDirectory() &&
          safeOwner(stat) &&
          ((stat.mode & 0o022n) === 0n || (stat.uid === 0n && (stat.mode & 0o1000n) !== 0n)),
        "Unsafe READ input ancestor ownership or mode.",
      );
      cursor = join(cursor, name);
      directories.push({ path: cursor, handle, stat });
      parent = handle;
    }
    const anchor = await open(
      `/proc/self/fd/${parent.fd}/${pieces.at(-1)}`,
      O_PATH | constants.O_NOFOLLOW,
    );
    handles.push(anchor);
    const before = await anchor.stat({ bigint: true });
    assert.ok(before.isFile() && before.nlink === 1n, "READ input must be one regular inode.");
    assert.ok(
      safeOwner(before) && (before.mode & 0o7022n) === 0n,
      "Unsafe READ input owner or mode.",
    );
    if (executable)
      assert.equal(Number(before.mode & 0o7777n), 0o555, "READ executable mode must be 0555.");
    assert.equal(before.size, BigInt(expected.size), "READ input size mismatch.");
    content = await open(`/proc/self/fd/${anchor.fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
    handles.push(content);
    assert.ok(
      sameIdentity(before, await content.stat({ bigint: true })),
      "READ content inode changed.",
    );
    const current = async () => {
      active(signal);
      for (const entry of directories) {
        assert.ok(
          sameIdentity(
            entry.stat,
            await entry.handle.stat({ bigint: true }),
            directoryIdentityKeys,
          ) &&
            sameIdentity(
              entry.stat,
              await lstat(entry.path, { bigint: true }),
              directoryIdentityKeys,
            ),
          "READ input directory identity changed.",
        );
        active(signal);
      }
      assert.equal(await realpath(path), path, "READ input must remain canonical.");
      assert.ok(
        sameIdentity(before, await anchor.stat({ bigint: true })) &&
          sameIdentity(before, await content.stat({ bigint: true })) &&
          sameIdentity(before, await lstat(path, { bigint: true })),
        "READ input identity changed.",
      );
      active(signal);
    };
    await current();
    bytes = await readExact(content, expected.size, signal);
    const capturedDigest = hash(bytes);
    if (expected.sha256 !== undefined)
      assert.equal(capturedDigest, expected.sha256, "READ input digest mismatch.");
    await current();
    return {
      bytes,
      observation: Object.freeze({
        ...expected,
        sha256: capturedDigest,
        uid: Number(before.uid),
        gid: Number(before.gid),
        mode: (Number(before.mode) & 0o7777).toString(8).padStart(4, "0"),
        identity: identity(before),
      }),
      current,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "READ capture failed and cleanup failed.");
    }
    throw error;
  }
}

function readSelection(value) {
  const selected = structuredClone(value);
  assert.equal(selected?.schemaVersion, 1, "A selected READ compiler input is required.");
  assert.equal(selected.binary, READ_BINARY);
  assert.equal(selected.imagePlatform, "linux/amd64");
  assert.equal(selected.rustTarget, "x86_64-unknown-linux-gnu");
  assert.equal(selected.package, "oce-native-egress");
  assert.equal(typeof selected.rustToolchain, "string");
  assert.ok(selected.rustToolchain.length > 0 && selected.rustToolchain.length <= 256);
  for (const entry of [selected.compilerManifest, selected.artifact]) {
    assert.ok(entry && isAbsolute(entry.path));
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0);
  }
  return selected;
}

/** Standalone received-byte boundary corresponding to the original
 * packages/occ/src/workload-profiles/canonical.ts operator-envelope decoder
 * (b6c28733). The package verifier is copied into the image without the OCC
 * workspace, so it must enforce the lexical contract here before JSON.parse
 * loses duplicate names, encoding errors or numeric lexemes. Raw captured bytes
 * are neither rewritten nor replaced with this parser's value/canonical output. */
function readCompilerEnvelope(bytes) {
  const reject = (code) => {
    throw new Error(`Invalid READ compiler JSON: ${code}`);
  };
  if (bytes.byteLength > READ_MAX_MANIFEST) reject("byte-limit");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    reject("invalid-utf8");
  }
  let position = 0,
    nodes = 0;
  const whitespace = () => {
    while ([" ", "\t", "\n", "\r"].includes(text[position])) position += 1;
  };
  const digit = () =>
    text[position] !== undefined && text[position] >= "0" && text[position] <= "9";
  const container = (depth, entries) => {
    if (depth > 32) reject("depth-limit");
    if (entries > 1024) reject("container-limit");
  };
  const scalarString = (value) => {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = value.charCodeAt(index + 1);
        if (!(low >= 0xdc00 && low <= 0xdfff)) reject("invalid-unicode");
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) reject("invalid-unicode");
    }
  };
  const string = () => {
    position += 1;
    const chunks = [];
    while (position < text.length) {
      const character = text[position++];
      if (character === '"') {
        const result = chunks.join("");
        scalarString(result);
        return result;
      }
      if (character.charCodeAt(0) < 0x20) reject("invalid-json");
      if (character !== "\\") {
        chunks.push(character);
        continue;
      }
      const escape = text[position++];
      if (escape === '"' || escape === "\\" || escape === "/") chunks.push(escape);
      else if (escape === "b") chunks.push("\b");
      else if (escape === "f") chunks.push("\f");
      else if (escape === "n") chunks.push("\n");
      else if (escape === "r") chunks.push("\r");
      else if (escape === "t") chunks.push("\t");
      else if (escape === "u") {
        const hex = text.slice(position, position + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) reject("invalid-json");
        chunks.push(String.fromCharCode(Number.parseInt(hex, 16)));
        position += 4;
      } else reject("invalid-json");
    }
    reject("invalid-json");
  };
  const integer = () => {
    const start = position;
    if (text[position] === "0") position += 1;
    else while (digit()) position += 1;
    const next = text[position];
    if (digit() || next === "." || next === "e" || next === "E") reject("invalid-number");
    const lexeme = text.slice(start, position);
    if (lexeme.length > 16 || (lexeme.length === 16 && lexeme > "9007199254740991"))
      reject("invalid-number");
    return Number(lexeme);
  };
  const object = (depth) => {
    container(depth, 0);
    position += 1;
    const result = Object.create(null),
      seen = new Set();
    whitespace();
    if (text[position] === "}") {
      position += 1;
      return result;
    }
    while (true) {
      container(depth, seen.size + 1);
      if (text[position] !== '"') reject("invalid-json");
      const key = string();
      for (let index = 0; index < key.length; index += 1)
        if (key.charCodeAt(index) > 0x7f) reject("non-ascii-key");
      if (seen.has(key)) reject("duplicate-key");
      seen.add(key);
      whitespace();
      if (text[position++] !== ":") reject("invalid-json");
      result[key] = value(depth);
      whitespace();
      const separator = text[position++];
      if (separator === "}") return result;
      if (separator !== ",") reject("invalid-json");
      whitespace();
    }
  };
  const array = (depth) => {
    container(depth, 0);
    position += 1;
    const result = [];
    whitespace();
    if (text[position] === "]") {
      position += 1;
      return result;
    }
    while (true) {
      container(depth, result.length + 1);
      result.push(value(depth));
      whitespace();
      const separator = text[position++];
      if (separator === "]") return result;
      if (separator !== ",") reject("invalid-json");
    }
  };
  const value = (depth) => {
    if (++nodes > 8192) reject("node-limit");
    whitespace();
    const first = text[position];
    if (first === '"') return string();
    if (first === "{") return object(depth + 1);
    if (first === "[") return array(depth + 1);
    if (digit()) return integer();
    for (const [literal, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (text.startsWith(literal, position)) {
        position += literal.length;
        return result;
      }
    }
    if (first === "-" || first === "+" || first === ".") reject("invalid-number");
    reject("invalid-json");
  };
  const parsed = value(0);
  whitespace();
  if (position !== text.length) reject("invalid-json");
  // For lexically validated values, JSON.stringify emits the same string and
  // integer spellings as the original canonical writer. ASCII-key ordering
  // changes order only, never byte count. It is used solely to enforce size.
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > READ_MAX_MANIFEST) reject("byte-limit");
  // Preserve the binder's ordinary JSON object prototypes only AFTER the raw
  // lexical gate. This object is not staged; exact original bytes remain held.
  return JSON.parse(text);
}

function bindCompiler(manifestBytes, selection) {
  const compiler = readCompilerEnvelope(manifestBytes);
  assert.equal(compiler.schemaVersion, 2);
  assert.equal(compiler.rustToolchain, selection.rustToolchain);
  assert.equal(compiler.rustTarget, selection.rustTarget);
  assert.equal(compiler.imagePlatform, selection.imagePlatform);
  assert.ok(Array.isArray(compiler.sourceInputs?.files) && compiler.sourceInputs.files.length > 0);
  const sourceFiles = new Map();
  for (const input of compiler.sourceInputs.files) {
    safePath(input.path);
    assert.match(input.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(input.size) && input.size >= 0);
    assert.ok(!sourceFiles.has(input.path), "Duplicate READ source inventory path.");
    sourceFiles.set(input.path, input);
  }
  assert.equal(
    hash(Buffer.from(JSON.stringify(compiler.sourceInputs.files))),
    compiler.sourceInputs.sha256,
  );
  for (const name of ["rustc", "cargo"]) {
    const tool = compiler.tools?.[name];
    assert.match(tool?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.ok(
      Number.isSafeInteger(tool.size) &&
        tool.size > 0 &&
        typeof tool.version === "string" &&
        tool.version.length > 0,
    );
  }
  assert.ok(Array.isArray(compiler.products));
  assert.equal(
    compiler.products.length,
    1,
    "The selected native-read invocation must emit only READ.",
  );
  const products = compiler.products.filter((entry) => entry.binary === READ_BINARY);
  assert.equal(products.length, 1, "Exactly one READ compiler product is required.");
  const product = products[0];
  assert.equal(product.package, selection.package);
  assert.equal(product.path, ".build/mvp/native/oce-github-read");
  assert.deepEqual(product.installationRequirements, {
    path: READ_INSTALL,
    uid: 0,
    gid: 0,
    mode: "0555",
  });
  assert.equal(product.staged?.sha256, selection.artifact.sha256);
  assert.equal(product.staged?.size, selection.artifact.size);
  assert.equal(product.staged?.mode, "0555");
  assert.ok(
    Number.isSafeInteger(product.staged.uid) &&
      product.staged.uid >= 0 &&
      Number.isSafeInteger(product.staged.gid) &&
      product.staged.gid >= 0,
  );
  const compilation = product.compilerArtifact;
  assert.ok(
    compilation && typeof compilation === "object" && !Array.isArray(compilation),
    "Original READ compiler-artifact association is required.",
  );
  assert.deepEqual(
    Object.keys(compilation).sort(),
    [
      "buildTarget",
      "packageVersion",
      "manifestPath",
      "manifestSha256",
      "sourcePath",
      "sourceSha256",
      "rustTarget",
      "kind",
      "crateTypes",
      "test",
      "fresh",
      "buildFinished",
      "messagesSha256",
      "executablePath",
      "artifact",
    ].sort(),
  );
  assert.equal(compilation.buildTarget, "native-read");
  assert.equal(typeof compilation.packageVersion, "string");
  assert.ok(compilation.packageVersion.length > 0 && compilation.packageVersion.length <= 256);
  assert.equal(compilation.manifestPath, "dataplane/services/oce-native-egress/Cargo.toml");
  assert.equal(
    compilation.sourcePath,
    "dataplane/services/oce-native-egress/src/bin/oce-github-read.rs",
  );
  for (const [path, digest] of [
    [compilation.manifestPath, compilation.manifestSha256],
    [compilation.sourcePath, compilation.sourceSha256],
  ]) {
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(
      sourceFiles.get(path)?.sha256,
      digest,
      "READ compiler source association mismatch.",
    );
  }
  assert.equal(compilation.rustTarget, selection.rustTarget);
  assert.deepEqual(compilation.kind, ["bin"]);
  assert.deepEqual(compilation.crateTypes, ["bin"]);
  // The original builder derives this from profile.test, never target.test.
  assert.equal(compilation.test, false);
  assert.equal(typeof compilation.fresh, "boolean");
  assert.equal(compilation.buildFinished, true);
  assert.match(compilation.messagesSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    compilation.executablePath,
    `dataplane/target/${selection.rustTarget}/release/oce-github-read`,
  );
  const original = compilation.artifact;
  assert.ok(original && typeof original === "object");
  assert.deepEqual(Object.keys(original).sort(), ["sha256", "size", "uid", "gid", "mode"].sort());
  assert.equal(original.sha256, product.staged.sha256);
  assert.equal(original.size, product.staged.size);
  assert.ok(
    Number.isSafeInteger(original.uid) &&
      original.uid >= 0 &&
      Number.isSafeInteger(original.gid) &&
      original.gid >= 0,
  );
  assert.match(original.mode, /^[0-7]{4}$/);
  const originalMode = Number.parseInt(original.mode, 8);
  assert.ok(
    (originalMode & 0o7022) === 0 && (originalMode & 0o111) !== 0,
    "READ compiler artifact mode is not safely executable.",
  );
  // Original compiler-output and staged-copy owners may differ. Actual current
  // staging ownership is checked against product.staged by the FD capture below.
  assert.ok(Array.isArray(product.dependencies));
  const dependencies = new Set();
  for (const dependency of product.dependencies) {
    assert.ok(dependency && typeof dependency === "object" && !Array.isArray(dependency));
    assert.equal(typeof dependency.package, "string");
    assert.ok(dependency.package.length > 0 && dependency.package !== product.package);
    assert.equal(typeof dependency.version, "string");
    assert.ok(dependency.version.length > 0);
    if (dependency.source === null) {
      assert.deepEqual(
        Object.keys(dependency).sort(),
        ["package", "version", "source", "manifestPath", "manifestSha256"].sort(),
      );
      safePath(dependency.manifestPath);
      assert.match(dependency.manifestSha256, /^[a-f0-9]{64}$/);
      assert.equal(
        sourceFiles.get(dependency.manifestPath)?.sha256,
        dependency.manifestSha256,
        "READ local dependency manifest association mismatch.",
      );
    } else {
      assert.deepEqual(Object.keys(dependency).sort(), ["package", "version", "source"].sort());
      assert.equal(typeof dependency.source, "string");
      assert.match(dependency.source, /^(?:registry|git)\+[^\u0000-\u0020]+$/);
    }
    const key = JSON.stringify([dependency.package, dependency.version, dependency.source]);
    assert.ok(!dependencies.has(key), "Duplicate READ dependency identity.");
    dependencies.add(key);
  }
  return product;
}

async function writeCapturedRead(path, bytes, mode, signal) {
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  let failed = false,
    failure;
  try {
    active(signal);
    await file.writeFile(bytes);
    active(signal);
    await file.chmod(mode);
    await file.sync();
    const before = await file.stat({ bigint: true });
    assert.ok(before.isFile() && before.nlink === 1n && safeOwner(before));
    assert.equal(Number(before.mode & 0o7777n), mode);
    const readback = await readExact(file, bytes.length, signal);
    try {
      assert.equal(hash(readback), hash(bytes), "READ staged readback mismatch.");
    } finally {
      readback.fill(0);
    }
    assert.ok(
      sameIdentity(before, await file.stat({ bigint: true })) &&
        sameIdentity(before, await lstat(path, { bigint: true })),
      "READ staged identity changed.",
    );
    return {
      path: path.split(sep).at(-1),
      bytes: bytes.length,
      sha256: hash(bytes),
      uid: Number(before.uid),
      gid: Number(before.gid),
      mode: mode.toString(8).padStart(4, "0"),
      identity: identity(before),
    };
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      await file.close();
    } catch (error) {
      if (failed) throw new AggregateError([failure, error], "READ staged write and close failed.");
      throw error;
    }
  }
}

/** Component operation used by preparation before npm/tooling. It owns actual
 * file descriptors through source validation, output copy and readback. The
 * returned object is cleanup/copy custody only, never native runtime authority. */
export async function captureReadNativeArtifact(input, { signal } = {}) {
  const selection = readSelection(input);
  const held = [];
  const pending = new Set();
  const cancellation = new AbortController();
  const abort = () => cancellation.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const local = cancellation.signal;
  let closed = false,
    staged = false,
    closing;
  const close = () => {
    closed = true;
    cancellation.abort();
    return (closing ??= Promise.resolve().then(async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      const failures = [];
      for (const source of [...held].reverse()) {
        try {
          await source.close();
        } catch (error) {
          failures.push(error);
        }
      }
      signal?.removeEventListener("abort", abort);
      if (failures.length) throw new AggregateError(failures, "READ source release failed.");
    }));
  };
  const track = (operation) => {
    const work = Promise.resolve().then(operation);
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  };
  const current = () =>
    track(async () => {
      assert.ok(!closed, "READ capture is closed.");
      for (const source of held) await source.current();
      active(local);
      assert.ok(!closed, "READ capture is closed.");
    });
  try {
    const compiler = await captureReadFile(
      selection.compilerManifest.path,
      selection.compilerManifest,
      { signal: local },
    );
    held.push(compiler);
    const product = bindCompiler(compiler.bytes, selection);
    const artifact = await captureReadFile(selection.artifact.path, selection.artifact, {
      executable: true,
      signal: local,
    });
    held.push(artifact);
    assert.equal(
      artifact.observation.uid,
      product.staged.uid,
      "Original compiler artifact owner mismatch.",
    );
    assert.equal(
      artifact.observation.gid,
      product.staged.gid,
      "Original compiler artifact group mismatch.",
    );
    await current();
    active(local);
    assert.ok(!closed, "READ capture is closed.");
    return Object.freeze({
      assertCurrent: current,
      close,
      stage(directory) {
        assert.ok(!staged && !closed, "READ capture may be staged once.");
        staged = true;
        return track(async () => {
          assert.equal(await realpath(directory), directory);
          const destination = await open(
            directory,
            O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          let failed = false,
            failure;
          try {
            const parent = await destination.stat({ bigint: true });
            assert.ok(
              parent.isDirectory() && safeOwner(parent) && (parent.mode & 0o022n) === 0n,
              "Unsafe READ staging directory.",
            );
            assert.ok(
              sameIdentity(parent, await lstat(directory, { bigint: true }), directoryIdentityKeys),
            );
            await current();
            const target = `/proc/self/fd/${destination.fd}`;
            const executable = await writeCapturedRead(
              join(target, READ_BINARY),
              artifact.bytes,
              0o555,
              local,
            );
            const manifest = await writeCapturedRead(
              join(target, READ_MANIFEST),
              compiler.bytes,
              0o444,
              local,
            );
            await current();
            const receipt = {
              schemaVersion: 1,
              status: "staged",
              binary: READ_BINARY,
              selection,
              originalCapture: {
                compilerManifest: compiler.observation,
                artifact: artifact.observation,
              },
              executable,
              compilerManifest: manifest,
              protocol: {
                version: 3,
                operationPolicy: "github-git-read-rpc-v3",
                transportProfileRef: "owned-child-stdio-github-git-read-v3",
                alpn: "oce-github-git-read-v3",
              },
              installationRequirements: {
                path: READ_INSTALL,
                uid: 0,
                gid: 0,
                mode: "0555",
                compilerManifestPath: READ_MANIFEST_INSTALL,
                compilerManifestMode: "0444",
              },
              qualification: {
                compiler: "selected-original-schema2-record",
                staging: "captured-copy-readback",
                installation: "declared-not-executed",
                finalImage: null,
              },
            };
            const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
            const receiptFile = await writeCapturedRead(
              join(target, READ_RECEIPT),
              receiptBytes,
              0o444,
              local,
            );
            await current();
            assert.ok(
              sameIdentity(parent, await lstat(directory, { bigint: true }), directoryIdentityKeys),
              "READ staging directory identity changed.",
            );
            active(local);
            assert.ok(!closed, "READ capture is closed.");
            return Object.freeze({ receipt, files: [executable, manifest, receiptFile] });
          } catch (error) {
            failed = true;
            failure = error;
            throw error;
          } finally {
            try {
              await destination.close();
            } catch (error) {
              if (failed)
                throw new AggregateError(
                  [failure, error],
                  "READ staging and directory close failed.",
                );
              throw error;
            }
          }
        });
      },
    });
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "READ acquisition and release failed.");
    }
    throw error;
  }
}

/** COPY changes filesystem inode/ownership. Historical identity observations in
 * the receipt are data, not adopted current identities. Every verification owns
 * fresh regular-file anchors and checks current FD/path identity before/after. */
export async function verifyReadNativeStaging(
  directory,
  expectedReceipt,
  { installed = false } = {},
) {
  assert.equal(await realpath(directory), directory);
  const receiptPath = join(directory, READ_RECEIPT);
  const stat = await lstat(receiptPath);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= READ_MAX_MANIFEST,
  );
  const expected = expectedReceipt ?? { size: stat.size };
  const holds = [];
  let failed = false,
    failure;
  try {
    const captured = await captureReadFile(receiptPath, expected, {
      observeDigest: expectedReceipt === undefined,
    });
    holds.push(captured);
    assert.equal(captured.observation.mode, "0444");
    const receipt = JSON.parse(captured.bytes);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.status, "staged");
    const selection = readSelection(receipt.selection);
    const compiler = await captureReadFile(
      join(directory, READ_MANIFEST),
      selection.compilerManifest,
    );
    holds.push(compiler);
    assert.equal(compiler.observation.mode, "0444");
    bindCompiler(compiler.bytes, selection);
    const executable = await captureReadFile(join(directory, READ_BINARY), selection.artifact, {
      executable: true,
    });
    holds.push(executable);
    for (const [entry, observed, name] of [
      [receipt.compilerManifest, compiler.observation, READ_MANIFEST],
      [receipt.executable, executable.observation, READ_BINARY],
    ]) {
      assert.equal(entry.path, name);
      assert.equal(entry.bytes, observed.size);
      assert.equal(entry.sha256, observed.sha256);
      assert.equal(entry.mode, observed.mode);
    }
    assert.deepEqual(receipt.protocol, {
      version: 3,
      operationPolicy: "github-git-read-rpc-v3",
      transportProfileRef: "owned-child-stdio-github-git-read-v3",
      alpn: "oce-github-git-read-v3",
    });
    assert.deepEqual(receipt.installationRequirements, {
      path: READ_INSTALL,
      uid: 0,
      gid: 0,
      mode: "0555",
      compilerManifestPath: READ_MANIFEST_INSTALL,
      compilerManifestMode: "0444",
    });
    assert.deepEqual(
      (await readdir(directory)).sort(),
      [READ_BINARY, READ_MANIFEST, READ_RECEIPT].sort(),
    );
    if (installed) {
      for (const [path, descriptor, executableFile, mode] of [
        [READ_INSTALL, selection.artifact, true, "0555"],
        [READ_MANIFEST_INSTALL, selection.compilerManifest, false, "0444"],
      ]) {
        const file = await captureReadFile(path, descriptor, { executable: executableFile });
        holds.push(file);
        assert.equal(file.observation.uid, 0);
        assert.equal(file.observation.gid, 0);
        assert.equal(file.observation.mode, mode);
      }
    }
    for (const hold of holds) await hold.current();
    return receipt;
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    const results = await Promise.allSettled(holds.reverse().map((hold) => hold.close()));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        [...(failed ? [failure] : []), ...failures.map((result) => result.reason)],
        "READ verification release failed.",
      );
  }
}

function safePath(value) {
  assert.equal(typeof value, "string", "A relative package path is required.");
  assert.ok(value && !value.includes("\\") && !value.includes("\0") && !isAbsolute(value));
  assert.ok(
    value.split("/").every((part) => part && part !== "." && part !== ".."),
    "Unsafe package path.",
  );
  return value;
}

async function regularFile(root, name) {
  safePath(name);
  const target = join(root, name);
  const stat = await lstat(target);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Expected a regular file.");
  assert.equal(await realpath(target), target, "Package inputs must not traverse symlinks.");
  return target;
}

async function verifiedInput(record) {
  assert.ok(record && isAbsolute(record.path) && /^[a-f0-9]{64}$/.test(record.sha256));
  const stat = await lstat(record.path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Expected an immutable regular input file.");
  const bytes = await readFile(record.path);
  assert.equal(hash(bytes), record.sha256, `Input digest mismatch: ${record.path}`);
  return bytes;
}

async function inventory(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), "Prepared payloads must not contain symlinks.");
      if (entry.isDirectory()) await walk(path);
      else {
        assert.ok(entry.isFile(), "Unsupported prepared file type.");
        const bytes = await readFile(path);
        files.push({
          path: relative(root, path).split(sep).join("/"),
          bytes: bytes.length,
          sha256: hash(bytes),
          mode: (await lstat(path)).mode & 0o777,
        });
      }
    }
  }
  await walk(root);
  return files;
}

export function assertLocalGraph(
  manifest,
  lock,
  packages,
  registry = "https://registry.npmjs.org/",
) {
  const registryUrl = new URL(registry);
  assert.ok(
    registryUrl.protocol === "https:" &&
      !registryUrl.username &&
      !registryUrl.password &&
      !registryUrl.search &&
      !registryUrl.hash &&
      registryUrl.pathname.endsWith("/"),
    "A configured HTTPS registry is required.",
  );
  assert.deepEqual(
    packages.map((entry) => entry.name).sort(),
    [...LOCAL_PACKAGES].sort(),
    "Exactly five local SDK packages are required.",
  );
  assert.equal(manifest.dependencies?.["@openai/codex"], NATIVE_VERSION);
  assert.equal(lock.packages?.["node_modules/@openai/codex"]?.version, NATIVE_VERSION);
  for (const entry of packages) {
    safePath(entry.archive);
    assert.ok(entry.archive.startsWith("artifacts/") && entry.archive.endsWith(".tgz"));
    assert.equal(manifest.dependencies?.[entry.name], `file:./${entry.archive}`);
    const local = lock.packages?.[`node_modules/${entry.name}`];
    assert.ok(local && local.link !== true, "Local package must be installed from its archive.");
    assert.equal(local.name ?? entry.name, entry.name);
    assert.equal(local.version, entry.version);
    assert.equal(local.resolved, `file:${entry.archive}`);
    assert.equal(local.integrity, entry.integrity);
  }
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path) continue;
    safePath(path);
    assert.ok(path.startsWith("node_modules/"), "Unexpected installed package path.");
    assert.ok(entry.link !== true, "Source/workspace links are forbidden in the image lock.");
    const pathName = path.split("node_modules/").at(-1);
    const local = packages.find((item) => item.name === pathName || item.name === entry.name);
    if (local)
      assert.equal(
        path,
        `node_modules/${local.name}`,
        "Nested or registry SDK substitutions are forbidden.",
      );
    else
      assert.ok(
        typeof entry.resolved === "string" &&
          new URL(entry.resolved).href.startsWith(registryUrl.href),
        "Only the configured registry's locked tarballs and the five local artifacts are allowed.",
      );
  }
}

export async function verifyContext(directory) {
  assert.ok(isAbsolute(directory), "Prepared context must be an absolute path.");
  const root = await realpath(directory);
  assert.equal(root, directory, "Prepared context must not be a symlink.");
  const receipt = await json(await regularFile(root, "preparation.json"));
  assert.equal(receipt.schema, SCHEMA);
  assert.equal(receipt.status, "prepared");
  assert.equal(receipt.platform, "linux/amd64");
  assert.equal(receipt.nativeCodexVersion, NATIVE_VERSION);
  assert.ok(Array.isArray(receipt.files) && Array.isArray(receipt.packages));
  if (receipt.readNative !== undefined) {
    const selectedInput = await json(await regularFile(root, "inputs.json"));
    assert.deepEqual(
      receipt.readNative.selection,
      readSelection(selectedInput.readNative),
      "Prepared READ selection differs from its original input.",
    );
    const entry = receipt.files.find((file) => file.path === `native/${READ_RECEIPT}`);
    assert.ok(entry, "Selected READ context requires its staged receipt.");
    const native = await verifyReadNativeStaging(join(root, "native"), {
      size: entry.bytes,
      sha256: entry.sha256,
    });
    assert.deepEqual(native, receipt.readNative, "Prepared READ record mismatch.");
  } else {
    assert.ok(
      !receipt.files.some((entry) => entry.path.startsWith("native/")),
      "Unselected READ artifact is forbidden.",
    );
    const inputs = await json(await regularFile(root, "inputs.json"));
    assert.equal(
      inputs.readNative,
      undefined,
      "Selected READ input cannot omit its staged receipt.",
    );
  }
  const names = new Set();
  for (const entry of receipt.files) {
    assert.ok(!names.has(entry.path), "Duplicate prepared file.");
    names.add(entry.path);
    // Native files have already passed bounded, no-follow descriptor validation;
    // do not content-open the same pathname through the legacy generic reader.
    if (receipt.readNative !== undefined && entry.path.startsWith("native/")) {
      const nativeFile = await captureReadFile(
        join(root, safePath(entry.path)),
        { size: entry.bytes, sha256: entry.sha256 },
        { executable: entry.path === `native/${READ_BINARY}` },
      );
      try {
        assert.equal(nativeFile.observation.mode, entry.mode, "Prepared READ file mode mismatch.");
        await nativeFile.current();
      } finally {
        await nativeFile.close();
      }
      continue;
    }
    const bytes = await readFile(await regularFile(root, entry.path));
    assert.equal(bytes.length, entry.bytes, `Prepared file length mismatch: ${entry.path}`);
    assert.equal(hash(bytes), entry.sha256, `Prepared file digest mismatch: ${entry.path}`);
  }
  for (const name of [
    "package.json",
    "package-lock.json",
    ...receipt.packages.map((entry) => entry.archive),
  ])
    assert.ok(names.has(name), `Missing prepared file: ${name}`);
  async function checkUnlisted(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (
        directory === root &&
        (entry.name === ".work" ||
          entry.name === "node_modules" ||
          entry.name.endsWith(".log") ||
          entry.name === "preparation.json")
      )
        continue;
      assert.ok(!entry.isSymbolicLink(), "Unexpected context symlink.");
      if (entry.isDirectory()) await checkUnlisted(path);
      else assert.ok(entry.isFile() && names.has(name), `Unlisted context file: ${name}`);
    }
  }
  await checkUnlisted(root);
  for (const entry of receipt.packages) {
    assert.equal(
      `sha512-${hash(await readFile(join(root, entry.archive)), "sha512", "base64")}`,
      entry.integrity,
    );
  }
  assertLocalGraph(
    await json(join(root, "package.json")),
    await json(join(root, "package-lock.json")),
    receipt.packages,
    receipt.registry,
  );
  return receipt;
}

export function normalizeRuntimeManifest(original, localVersions) {
  const manifest = structuredClone(original);
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    const prefix = "node scripts/crabbox-wrapper.mjs";
    if (command === prefix || command.startsWith(`${prefix} `))
      manifest.scripts[name] = `node dist/crabbox-wrapper.js${command.slice(prefix.length)}`;
  }
  // Match upstream prepack sanitation without invoking source lifecycle scripts.
  if (manifest.devDependencies)
    manifest.devDependencies = Object.fromEntries(
      Object.entries(manifest.devDependencies).filter(([, spec]) => !spec.startsWith("workspace:")),
    );
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (spec.startsWith("workspace:") && localVersions[name])
        manifest[field][name] = localVersions[name];
      else
        assert.ok(
          !/^(?:workspace:|file:|link:|git|https?:|\.\/|\.\.\/|\/)/.test(spec),
          `Unsupported package dependency: ${name}`,
        );
    }
  }
  return manifest;
}

async function materializePackage(tools, input, output, versions) {
  const bytes = await verifiedInput(input);
  const expected = JSON.parse(await verifiedInput(input.inventory));
  const label = input.name.replace(/^@/, "").replaceAll("/", "-");
  const destination = join(output, ".work", label);
  await mkdir(destination, { recursive: true });
  const seen = new Set();
  await tools.tar.t({
    file: input.path,
    strict: true,
    onReadEntry(entry) {
      const path = entry.path.replace(/^\.\//, "").replace(/\/$/, "");
      if (!path && entry.type === "Directory") return;
      safePath(path);
      assert.ok(
        entry.type === "File" || entry.type === "Directory",
        "Archive links and special entries are forbidden.",
      );
      assert.ok(!seen.has(path), "Duplicate archive member.");
      seen.add(path);
    },
  });
  await tools.tar.x({ file: input.path, cwd: destination, strict: true, preservePaths: false });
  const before = await inventory(destination);
  const stripped = (items) =>
    items
      .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(
    stripped(before),
    stripped(expected),
    `Archive inventory mismatch: ${input.name}`,
  );
  const original = await json(join(destination, "package.json"));
  assert.equal(original.name, input.name);
  assert.equal(original.version, input.version);
  const manifest = normalizeRuntimeManifest(original, versions);
  await writeFile(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const entry of before)
    await chmod(join(destination, entry.path), entry.mode & 0o111 ? 0o755 : 0o644);
  const after = await inventory(destination);
  assert.deepEqual(
    before.map((entry) => entry.path),
    after.map((entry) => entry.path),
  );
  for (let i = 0; i < before.length; i++)
    if (before[i].path !== "package.json") assert.equal(before[i].sha256, after[i].sha256);
  const archive = `artifacts/${label}.tgz`;
  await tools.tar.c(
    {
      file: join(output, archive),
      cwd: destination,
      prefix: "package",
      gzip: true,
      portable: true,
      noMtime: true,
    },
    ["."],
  );
  const packed = await readFile(join(output, archive));
  return {
    name: input.name,
    version: input.version,
    archive,
    integrity: `sha512-${hash(packed, "sha512", "base64")}`,
    sourceArchiveSha256: hash(bytes),
    preparedArchiveSha256: hash(packed),
    before,
    after,
    originalManifest: original,
    preparedManifest: manifest,
  };
}

function npmEnvironment() {
  // Keep the existing package registry and transport configuration. Provider
  // credentials are not forwarded, and no host npm configuration is copied.
  const names = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "NODE_USE_ENV_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NPM_CONFIG_REGISTRY",
    "npm_config_registry",
    "NPM_CONFIG_PROXY",
    "npm_config_proxy",
    "NPM_CONFIG_HTTP_PROXY",
    "npm_config_http_proxy",
    "NPM_CONFIG_HTTPS_PROXY",
    "npm_config_https_proxy",
    "NPM_CONFIG_NOPROXY",
    "npm_config_noproxy",
    "NPM_CONFIG_USERCONFIG",
    "npm_config_userconfig",
  ];
  return {
    ...Object.fromEntries(
      names
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    ),
    PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    LANG: "C.UTF-8",
    NODE_ENV: "production",
    npm_config_update_notifier: "false",
  };
}

function configuredRegistry(cwd) {
  const result = spawnSync("npm", ["config", "get", "registry"], {
    cwd,
    env: npmEnvironment(),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, "Unable to read the existing npm registry setting.");
  const registry = new URL(result.stdout.trim());
  assert.ok(
    registry.protocol === "https:" &&
      !registry.username &&
      !registry.password &&
      !registry.search &&
      !registry.hash,
    "Configured registry must use HTTPS without embedded credentials.",
  );
  return registry.href.endsWith("/") ? registry.href : `${registry.href}/`;
}

function runNpm(args, cwd, cache, logPath) {
  const result = spawnSync("npm", [...args, "--cache", cache], {
    cwd,
    env: npmEnvironment(),
    encoding: "utf8",
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return writeFile(
    logPath,
    `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\nProcess error: ${result.error.code ?? "unknown"}\n` : ""}`,
  ).then(() => {
    assert.equal(result.status, 0, `npm ${args[0]} failed; inspect ${logPath}.`);
  });
}

export async function preparePackages(inputPath, directory) {
  assert.ok(isAbsolute(directory), "Output must be an absolute new directory.");
  const input = await json(inputPath);
  assert.equal(input.schema, "oce.runtime-package-inputs/v1");
  assert.equal(input.platform, "linux/amd64");
  assert.equal(input.nativeCodexVersion, NATIVE_VERSION);
  assert.deepEqual(input.packages.map((entry) => entry.name).sort(), [...LOCAL_PACKAGES].sort());
  // Verify every caller-selected immutable input before creating any preparation state.
  for (const item of [
    input.tooling,
    input.policy.lockfile,
    input.policy.workspace,
    ...input.packages,
    ...input.packages.map((entry) => entry.inventory),
  ])
    await verifiedInput(item);
  // READ is explicitly selected and fully captured before any tooling/npm entry.
  // Keep these original handles through staging; a receipt or provenance bag
  // cannot substitute for the selected compiler artifact's actual bytes.
  const readCapture =
    input.readNative === undefined ? undefined : await captureReadNativeArtifact(input.readNative);
  let readNative;
  try {
    await mkdir(directory, { recursive: false });
    assert.equal(await realpath(directory), directory);
    for (const child of ["artifacts", "policy", ".work", "cache", "native"])
      await mkdir(join(directory, child));
    if (readCapture) readNative = await readCapture.stage(join(directory, "native"));
  } finally {
    await readCapture?.close();
  }
  await writeFile(
    join(directory, "policy", "pnpm-lock.yaml"),
    await verifiedInput(input.policy.lockfile),
  );
  await writeFile(
    join(directory, "policy", "pnpm-workspace.yaml"),
    await verifiedInput(input.policy.workspace),
  );
  await writeFile(
    join(directory, ".work", "package-tools.mjs"),
    await verifiedInput(input.tooling),
  );
  process.env.OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT = join(directory, "policy");
  const tools = await import(pathToFileURL(join(directory, ".work", "package-tools.mjs")).href);
  const workspace = tools.parseYaml(
    await readFile(join(directory, "policy", "pnpm-workspace.yaml"), "utf8"),
  );
  const versions = Object.fromEntries(input.packages.map((entry) => [entry.name, entry.version]));
  const packages = [];
  for (const entry of input.packages)
    packages.push(await materializePackage(tools, entry, directory, versions));
  const artifacts = packages.map(({ name, version, archive, integrity }) => ({
    name,
    version,
    spec: `file:./${archive}`,
    integrity,
  }));
  const wrapper = {
    name: "oce-local-runtime",
    version: "0.0.0",
    private: true,
    dependencies: {
      ...Object.fromEntries(artifacts.map((entry) => [entry.name, entry.spec])),
      "@openai/codex": NATIVE_VERSION,
    },
  };
  const overrides = tools.readNpmLockOverrides();
  const manifest = tools.packageJsonForNpmLock(wrapper, overrides, artifacts);
  await save(join(directory, "package.json"), manifest);
  await writeFile(join(directory, "empty.npmrc"), "");
  await writeFile(join(directory, "empty-global.npmrc"), "");
  const registry = configuredRegistry(directory);
  await runNpm(
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    directory,
    join(directory, "cache"),
    join(directory, "lock-generation.log"),
  );
  const lock = tools.normalizeNpmVersionDrift(
    tools.applyPackageExtensionPeerMetadata(await json(join(directory, "package-lock.json"))),
  );
  assertLocalGraph(manifest, lock, packages, registry);
  // Local workspace packages are absent from pnpm's registry keys. Validate their
  // exact archive bindings above, then retain upstream validation for every registry entry.
  const registryLock = {
    ...lock,
    packages: Object.fromEntries(
      Object.entries(lock.packages).filter(
        ([path]) => !LOCAL_PACKAGES.some((name) => path === `node_modules/${name}`),
      ),
    ),
  };
  const violations = tools.collectPnpmLockViolations(registryLock);
  assert.deepEqual(
    violations,
    [],
    `Resolved registry dependencies violate frozen pnpm policy: ${JSON.stringify(violations.slice(0, 5))}`,
  );
  await writeFile(join(directory, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  const patchMatches = Object.entries(workspace.patchedDependencies ?? {}).filter(([key]) =>
    Object.entries(lock.packages).some(
      ([path, entry]) =>
        `${entry.name ?? path.split("node_modules/").at(-1)}@${entry.version}` === key,
    ),
  );
  assert.deepEqual(
    patchMatches,
    [],
    "This closure requires a frozen patch; supply an explicit supported patch preparation before building.",
  );
  await runNpm(
    ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    directory,
    join(directory, "cache"),
    join(directory, "cache-population.log"),
  );
  const lifecycle = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    let packageJson;
    try {
      packageJson = await json(join(directory, path, "package.json"));
    } catch (error) {
      if (error.code === "ENOENT" && entry.optional) continue;
      throw error;
    }
    const scripts = Object.fromEntries(
      Object.entries(packageJson.scripts ?? {}).filter(([name]) =>
        ["preinstall", "install", "postinstall"].includes(name),
      ),
    );
    if (Object.keys(scripts).length)
      lifecycle.push({
        path,
        name: packageJson.name,
        version: packageJson.version,
        scripts,
        approved: workspace.allowBuilds?.[packageJson.name] === true,
      });
  }
  await save(join(directory, "lifecycle.json"), {
    policy: input.policy.workspace,
    packages: lifecycle,
    execution:
      "Installation uses --ignore-scripts. Required approved lifecycle actions must be selected explicitly in the image recipe.",
  });
  await save(join(directory, "package-inventories.json"), packages);
  await save(join(directory, "inputs.json"), input);
  await copyFile(fileURLToPath(import.meta.url), join(directory, "verify-context.mjs"));
  await writeFile(join(directory, ".dockerignore"), ".work\nnode_modules\n*.log\n");
  const files = [];
  for (const name of [
    "package.json",
    "package-lock.json",
    "lifecycle.json",
    "package-inventories.json",
    "inputs.json",
    "verify-context.mjs",
    ".dockerignore",
    "empty.npmrc",
    "empty-global.npmrc",
    ...packages.map((entry) => entry.archive),
  ]) {
    const bytes = await readFile(join(directory, name));
    files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  for (const prefix of ["cache", "policy"])
    for (const entry of await inventory(join(directory, prefix)))
      files.push({ ...entry, path: `${prefix}/${entry.path}` });
  if (readNative)
    for (const entry of readNative.files) files.push({ ...entry, path: `native/${entry.path}` });
  const receipt = {
    schema: SCHEMA,
    status: "prepared",
    platform: input.platform,
    nativeCodexVersion: NATIVE_VERSION,
    registry,
    provenance: input.provenance,
    ...(readNative ? { readNative: readNative.receipt } : {}),
    packages: packages.map(({ name, version, archive, integrity }) => ({
      name,
      version,
      archive,
      integrity,
    })),
    files,
    lifecycleActionsExecuted: [],
    registryPolicyViolations: [],
    applicablePatches: [],
  };
  await save(join(directory, "preparation.json"), receipt);
  for (const entry of input.packages) await verifiedInput(entry);
  await verifyContext(directory);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === "--verify-context") await verifyContext(args[1]);
    else if (args.length === 2 && args[0] === "--verify-read-staging")
      await verifyReadNativeStaging(args[1]);
    else if (args.length === 2 && args[0] === "--verify-read-installed")
      await verifyReadNativeStaging(args[1], undefined, { installed: true });
    else if (args.length === 4 && args[0] === "--inputs" && args[2] === "--output")
      await preparePackages(resolve(args[1]), args[3]);
    else
      throw new Error(
        "Usage: node deploy/runtime/prepare-local-packages.mjs --inputs <inputs.json> --output <new-absolute-directory> | --verify-context <absolute-directory>",
      );
    console.log("Runtime package context verified.");
  } catch (error) {
    console.error(`Runtime package preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
