import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const O_PATH = 0x200000;
const definitionType = "application/vnd.openclaw.installed-renderer-definition.v1+json";
const sourceType = "application/vnd.openclaw.installed-source.v1+octet-stream";
const roles = [
  "interpreter",
  "entrypoint",
  "readiness",
  "environment",
  "resource-accounting",
  "module",
  "helper",
];
const requiredRoles = roles.slice(0, 5);
const idPattern = /^[a-z][a-zA-Z0-9-]{0,63}$/;
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const refuse = () => {
  throw new Error("Invalid installed renderer payload binding.");
};
const current = (signal) => {
  if (signal?.aborted) throw signal.reason ?? new Error("Payload binding cancelled.");
};
const descriptor = (bytes, mediaType) => ({ mediaType, digest: digest(bytes), size: bytes.length });
function keys(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    refuse();
}
function pathParts(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path === "/" ||
    path.endsWith("/") ||
    Buffer.byteLength(path) > 4096 ||
    /[\\\x00-\x1f]/.test(path)
  )
    refuse();
  const parts = path.slice(1).split("/");
  if (parts.length > 32) refuse();
  return parts;
}
function selection(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 65536) refuse();
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) refuse();
  const value = JSON.parse(text);
  // One unambiguous JSON encoding excludes duplicate keys and extra spelling.
  if (JSON.stringify(value) !== text) refuse();
  keys(value, ["schemaVersion", "kind", "implementation", "platform", "files"]);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "openclaw.renderer-payload-input.v1" ||
    typeof value.implementation !== "string" ||
    !idPattern.test(value.implementation)
  )
    refuse();
  keys(value.platform, ["os", "architecture"]);
  if (
    value.platform.os !== "linux" ||
    !["amd64", "arm64"].includes(value.platform.architecture) ||
    !Array.isArray(value.files) ||
    value.files.length < 10 ||
    value.files.length > 32
  )
    refuse();
  const ids = new Set(),
    names = new Set();
  for (const file of value.files) {
    keys(file, ["id", "component", "role", "path"]);
    if (
      !idPattern.test(file.id) ||
      typeof file.id !== "string" ||
      ids.has(file.id) ||
      !["gateway", "harness"].includes(file.component) ||
      !roles.includes(file.role)
    )
      refuse();
    pathParts(file.path);
    const name = `${file.component}:${file.path}`;
    if (names.has(name)) refuse();
    ids.add(file.id);
    names.add(name);
  }
  for (const component of ["gateway", "harness"])
    for (const role of requiredRoles)
      if (
        value.files.filter((file) => file.component === component && file.role === role).length !==
        1
      )
        refuse();
  value.files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return value;
}
function same(a, b) {
  return ["dev", "ino", "mode", "uid", "gid", "size", "nlink", "mtimeNs", "ctimeNs"].every(
    (key) => a[key] === b[key],
  );
}

/** Build-owned byte provenance only. The selected fixed implementation's
 * semantic producer must independently qualify these bytes, launch/environment
 * definitions and resource roles. This operation emits no supported flag,
 * admission lease, image-set identity or final image descriptor. */
export async function writeInstalledRendererBehaviorBinding({
  roots,
  selectionBytes,
  output,
  signal,
}) {
  current(signal);
  keys(roots, ["gateway", "harness"]);
  for (const root of Object.values(roots)) pathParts(root);
  pathParts(output);
  const input = selection(selectionBytes);
  const handles = [],
    anchors = [],
    contents = new Map(),
    files = [];
  let totalBytes = 0;
  let result,
    failure,
    failed = false;
  async function own(path, flags) {
    // Actual opening is always awaited and retained before any subsequent fence.
    const handle = await open(path, flags);
    handles.push(handle);
    current(signal);
    return handle;
  }
  try {
    const directories = new Map();
    for (const component of ["gateway", "harness"]) {
      const handle = await own(
        roots[component],
        O_PATH | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );
      const info = await handle.stat({ bigint: true });
      if (!info.isDirectory()) refuse();
      directories.set(`${component}:/`, handle);
      anchors.push({ handle, info, path: roots[component] });
    }
    for (const file of input.files) {
      current(signal);
      const parts = pathParts(file.path);
      let parent = directories.get(`${file.component}:/`),
        logical = "";
      for (const part of parts.slice(0, -1)) {
        logical += `/${part}`;
        const key = `${file.component}:${logical}`;
        if (!directories.has(key)) {
          const path = `/proc/self/fd/${parent.fd}/${part}`;
          const handle = await own(path, O_PATH | constants.O_NOFOLLOW | constants.O_DIRECTORY);
          const info = await handle.stat({ bigint: true });
          if (!info.isDirectory()) refuse();
          directories.set(key, handle);
          anchors.push({ handle, info, path });
        }
        parent = directories.get(key);
      }
      const path = `/proc/self/fd/${parent.fd}/${parts.at(-1)}`;
      // O_PATH never opens a FIFO/socket/device endpoint. Content-open follows
      // only after this held inode has been confirmed as a bounded regular file.
      const inode = await own(path, O_PATH | constants.O_NOFOLLOW);
      const before = await inode.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.size < 1n ||
        before.size > 268435456n ||
        before.nlink !== 1n ||
        (before.mode & 0o222n) !== 0n ||
        before.uid !== BigInt(process.getuid()) ||
        (file.role === "interpreter" && (before.mode & 0o111n) === 0n)
      )
        refuse();
      totalBytes += Number(before.size);
      if (totalBytes > 536870912) refuse();
      const content = await own(
        `/proc/self/fd/${inode.fd}`,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      if (!same(before, await content.stat({ bigint: true }))) refuse();
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      try {
        while (offset < bytes.length) {
          current(signal);
          const read = await content.read(
            bytes,
            offset,
            Math.min(65536, bytes.length - offset),
            offset,
          );
          if (!read.bytesRead) refuse();
          offset += read.bytesRead;
        }
        current(signal);
        if (!same(before, await content.stat({ bigint: true }))) refuse();
        const source = descriptor(bytes, sourceType);
        if (contents.has(source.digest)) bytes.fill(0);
        else contents.set(source.digest, bytes);
        files.push({
          ...file,
          mode: Number(before.mode & 0o777n),
          uid: Number(before.uid),
          gid: Number(before.gid),
          descriptor: source,
        });
        anchors.push({ handle: inode, info: before, path });
      } catch (error) {
        bytes.fill(0);
        throw error;
      }
    }
    // Names must still refer to the retained files/directories. No changed
    // inode, symlink or replacement is silently adopted after capture.
    for (const anchor of anchors) {
      current(signal);
      const observed = await own(anchor.path, O_PATH | constants.O_NOFOLLOW);
      if (
        !same(anchor.info, await observed.stat({ bigint: true })) ||
        !same(anchor.info, await anchor.handle.stat({ bigint: true }))
      )
        refuse();
    }
    const definition = {
      schemaVersion: 1,
      kind: "openclaw.installed-renderer-payload.v1",
      qualification: "unqualified-byte-provenance",
      implementation: input.implementation,
      platform: input.platform,
      files,
      sourceBlobs: files.map((file) => ({ id: file.id, descriptor: file.descriptor })),
    };
    const definitionBytes = Buffer.from(JSON.stringify(definition));
    if (definitionBytes.length > 65536) refuse();
    const selectedDefinition = descriptor(definitionBytes, definitionType);
    contents.set(selectedDefinition.digest, definitionBytes);
    current(signal);
    // A failed/partial build never replaces a prior binding or selected layout.
    await mkdir(output, { mode: 0o700 });
    await mkdir(`${output}/blobs`, { mode: 0o700 });
    await mkdir(`${output}/blobs/sha256`, { mode: 0o700 });
    for (const [hash, bytes] of contents) {
      current(signal);
      const written = await own(
        `${output}/blobs/sha256/${hash.slice(7)}`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      );
      await written.writeFile(bytes);
      await written.chmod(0o444);
    }
    current(signal);
    result = Object.freeze({
      definition: Object.freeze(selectedDefinition),
      qualification: definition.qualification,
    });
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    const cleanup = [];
    for (const handle of handles.reverse()) {
      try {
        await handle.close();
      } catch (error) {
        cleanup.push(error);
      }
    }
    for (const bytes of contents.values()) bytes.fill(0);
    if (cleanup.length) {
      failure = new AggregateError(
        [...(failed ? [failure] : []), ...cleanup],
        "Payload capture cleanup failed.",
      );
      failed = true;
    }
  }
  if (failed) throw failure;
  current(signal);
  return result;
}

// Explicit build operation: roots and canonical selection are fixed by the
// selected original packaging invocation. It is never a runtime admission API.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 6)
    throw new Error(
      "Expected Gateway root, Harness root, canonical selection file, and new output directory.",
    );
  const [gateway, harness, selected, output] = process.argv.slice(2);
  const selectionHandles = [];
  let selectionBytes,
    selectedBuffer,
    selectionFailure,
    selectionFailed = false;
  try {
    // An O_PATH anchor cannot content-open a device, FIFO or socket. The
    // declared regular inode is retained before reopening it for bounded reads.
    const anchor = await open(selected, O_PATH | constants.O_NOFOLLOW);
    selectionHandles.push(anchor);
    const before = await anchor.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 65536n) refuse();
    const input = await open(
      "/proc/self/fd/" + anchor.fd,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    selectionHandles.push(input);
    if (!same(before, await input.stat({ bigint: true }))) refuse();
    const declared = Number(before.size);
    selectedBuffer = Buffer.alloc(declared + 1);
    let offset = 0;
    while (offset < selectedBuffer.length) {
      const read = await input.read(
        selectedBuffer,
        offset,
        Math.min(4096, selectedBuffer.length - offset),
        offset,
      );
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (
      offset !== declared ||
      !same(before, await input.stat({ bigint: true })) ||
      !same(before, await anchor.stat({ bigint: true }))
    )
      refuse();
    // Reopening the selected name only as O_PATH detects replacement without
    // content-opening the replacement or adopting a different inode.
    const named = await open(selected, O_PATH | constants.O_NOFOLLOW);
    selectionHandles.push(named);
    if (!same(before, await named.stat({ bigint: true }))) refuse();
    selectionBytes = selectedBuffer.subarray(0, declared);
  } catch (error) {
    selectionFailed = true;
    selectionFailure = error;
  } finally {
    const cleanup = [];
    for (const handle of selectionHandles.reverse()) {
      try {
        await handle.close();
      } catch (error) {
        cleanup.push(error);
      }
    }
    if (cleanup.length) {
      selectionFailure = new AggregateError(
        [...(selectionFailed ? [selectionFailure] : []), ...cleanup],
        "Selection capture cleanup failed.",
      );
      selectionFailed = true;
    }
    if (selectionFailed) selectedBuffer?.fill(0);
  }
  if (selectionFailed) throw selectionFailure;
  const result = await writeInstalledRendererBehaviorBinding({
    roots: { gateway, harness },
    selectionBytes,
    output,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
