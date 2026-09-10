import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, link, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import {
  parsePublicationGraphV1,
  parsePublicationRequestV1,
  publicationCanonicalV1,
  publicationDigestV1,
  publicationObjectV1,
  publicationOidV1,
  publicationRefuseV1,
  publicationSnapshotV1,
  type GitObjectCaptureV1,
  type PublicationGraphV1,
  type PublicationRequestV1,
} from "./contract.ts";

export interface GitObjectInputV1 {
  readonly oid: string;
  readonly type: "commit" | "tree" | "blob";
  readonly bytes: Uint8Array;
}
export interface GitObjectLimitsV1 {
  readonly maxObjects: number;
  readonly maxObjectBytes: number;
  readonly maxRawBytes: number;
  readonly maxPackBytes: number;
  readonly maxTreeDepth: number;
  readonly maxPathBytes: number;
  readonly maxExpandedPaths: number;
  readonly captureTimeoutMs: number;
}
export interface GitObjectCustodyOptionsV1 {
  readonly directory: string;
  readonly ownerUid: number;
  readonly durability: "persistent-posix";
  /** Selected executable/build must use collision-detecting SHA-1. The hash pin
   * authenticates that selected binary; its version string alone proves no build. */
  readonly gitExecutable: Readonly<{ path: string; sha256: string; ownerUid: number }>;
  readonly limits: GitObjectLimitsV1;
}
type ObjectType = GitObjectInputV1["type"];
type RecordV1 = { oid: string; type: ObjectType; bytes: Buffer; sha256: string };
type TreeEntry = { name: string; rawName: Buffer; oid: string; tree: boolean };
type ParsedGraph = {
  parents: Map<string, readonly string[]>;
  trees: Map<string, readonly TreeEntry[]>;
};
type Captured = {
  graph: PublicationGraphV1;
  parents: Map<string, readonly string[]>;
  storageSha256: string;
};
const MAGIC = Buffer.from("OCEGIT01", "ascii");
const MAX_METADATA = 2 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const sha256 = (bytes: Uint8Array): string =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
function dataObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    publicationRefuseV1();
  const names = Reflect.ownKeys(value);
  if (names.some((k) => typeof k !== "string") || names.length !== keys.length)
    publicationRefuseV1();
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !("value" in d)) publicationRefuseV1();
    out[key] = d.value;
  }
  return out;
}
function checkLimits(value: GitObjectLimitsV1): GitObjectLimitsV1 {
  const o = publicationObjectV1(publicationSnapshotV1(value), [
    "maxObjects",
    "maxObjectBytes",
    "maxRawBytes",
    "maxPackBytes",
    "maxTreeDepth",
    "maxPathBytes",
    "maxExpandedPaths",
    "captureTimeoutMs",
  ]);
  const bounds: Record<string, number> = {
    maxObjects: 8192,
    maxObjectBytes: 8 * 1024 * 1024,
    maxRawBytes: 64 * 1024 * 1024,
    maxPackBytes: 80 * 1024 * 1024,
    maxTreeDepth: 128,
    maxPathBytes: 4096,
    maxExpandedPaths: 100000,
    captureTimeoutMs: 120000,
  };
  for (const key of Object.keys(bounds))
    if (!Number.isSafeInteger(o[key]) || Number(o[key]) < 1 || Number(o[key]) > bounds[key]!)
      publicationRefuseV1();
  if (Number(o.maxObjectBytes) > Number(o.maxRawBytes)) publicationRefuseV1();
  return o as unknown as GitObjectLimitsV1;
}
function copyObjects(value: readonly GitObjectInputV1[], limits: GitObjectLimitsV1): RecordV1[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > limits.maxObjects ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    publicationRefuseV1();
  const result: RecordV1[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !("value" in d)) publicationRefuseV1();
    const o = dataObject(d.value, ["oid", "type", "bytes"]);
    if (
      !publicationOidV1(o.oid) ||
      seen.has(o.oid) ||
      (o.type !== "commit" && o.type !== "tree" && o.type !== "blob")
    )
      publicationRefuseV1();
    const v = o.bytes;
    if (
      !v ||
      typeof v !== "object" ||
      types.isProxy(v) ||
      !types.isUint8Array(v) ||
      (Object.getPrototypeOf(v) !== Uint8Array.prototype &&
        Object.getPrototypeOf(v) !== Buffer.prototype)
    )
      publicationRefuseV1();
    // Own non-index properties could shadow the typed-array accessors.
    if (
      ["buffer", "byteOffset", "byteLength", "length"].some((k) => Object.hasOwn(v, k)) ||
      types.isSharedArrayBuffer(v.buffer)
    )
      publicationRefuseV1();
    const size = v.byteLength;
    total += size;
    if (size > limits.maxObjectBytes || total > limits.maxRawBytes) publicationRefuseV1();
    const bytes = Buffer.alloc(size);
    Uint8Array.prototype.set.call(bytes, v);
    const actual = createHash("sha1")
      .update(o.type + " " + size + "\0")
      .update(bytes)
      .digest("hex");
    if (actual !== o.oid) publicationRefuseV1();
    seen.add(o.oid);
    result.push({ oid: o.oid, type: o.type, bytes, sha256: sha256(bytes) });
  }
  return result.sort((a, b) => (a.oid < b.oid ? -1 : 1));
}
function text(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return publicationRefuseV1();
  }
}
function parseCommit(bytes: Buffer): { tree: string; parents: string[] } {
  if (bytes.length > 1024 * 1024 || bytes.includes(0)) publicationRefuseV1();
  const separator = bytes.indexOf("\n\n");
  if (separator < 0 || separator > 262144) publicationRefuseV1();
  const header = text(bytes.subarray(0, separator));
  const lines = header.split("\n");
  const treeLine = lines.shift();
  if (!treeLine?.startsWith("tree ") || !publicationOidV1(treeLine.slice(5))) publicationRefuseV1();
  const parents: string[] = [];
  while (lines[0]?.startsWith("parent ")) {
    const oid = lines.shift()!.slice(7);
    if (!publicationOidV1(oid) || parents.includes(oid) || parents.length >= 16)
      publicationRefuseV1();
    parents.push(oid);
  }
  const identity =
    /^(author|committer) [^<>\x00-\x1f\x7f]+ <[^<>\x00-\x20\x7f]+> [0-9]{1,12} [+-](?:0[0-9]|1[0-4])[0-5][0-9](?![\s\S])/;
  const author = lines.shift();
  const committer = lines.shift();
  if (
    !author?.startsWith("author ") ||
    !identity.test(author) ||
    !committer?.startsWith("committer ") ||
    !identity.test(committer)
  )
    publicationRefuseV1();
  const seen = new Set<string>();
  let continuation = false;
  for (const line of lines) {
    if (line.startsWith(" ")) {
      if (!continuation || /[\x00-\x08\x0b-\x1f\x7f]/.test(line)) publicationRefuseV1();
      continue;
    }
    const key = line.split(" ", 1)[0]!;
    if (seen.has(key)) publicationRefuseV1();
    seen.add(key);
    continuation = key === "gpgsig";
    if (key === "encoding") {
      if (line !== "encoding UTF-8") publicationRefuseV1();
    } else if (key === "gpgsig") {
      if (!/^gpgsig [\x20-\x7e]+(?![\s\S])/.test(line)) publicationRefuseV1();
    } else publicationRefuseV1();
  }
  text(bytes.subarray(separator + 2));
  return { tree: treeLine.slice(5), parents };
}
function parseTree(bytes: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  let previous: Buffer | undefined;
  const names = new Set<string>();
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const nul = bytes.indexOf(0, offset);
    if (space < offset || nul <= space || nul + 21 > bytes.length || space - offset > 6)
      publicationRefuseV1();
    const mode = bytes.subarray(offset, space).toString("ascii");
    if (mode !== "40000" && mode !== "100644" && mode !== "100755") publicationRefuseV1();
    const rawName = bytes.subarray(space + 1, nul);
    // Deliberately portable, ASCII-only first profile. Never materialized as paths.
    const name = rawName.toString("ascii");
    if (
      rawName.length < 1 ||
      rawName.length > 255 ||
      !rawName.equals(Buffer.from(name, "ascii")) ||
      !/^[\x20-\x7e]+(?![\s\S])/.test(name) ||
      /[\\/:*?"<>|]/.test(name) ||
      name === "." ||
      name === ".." ||
      /[. ](?![\s\S])/.test(name) ||
      /^(?:\.git|git~[0-9]+)(?:$|[. ])/i.test(name) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    )
      publicationRefuseV1();
    const folded = name.toLowerCase();
    if (names.has(folded)) publicationRefuseV1();
    names.add(folded);
    const tree = mode === "40000";
    const order = Buffer.concat([rawName, Buffer.from(tree ? "/" : "\0")]);
    if (previous && Buffer.compare(previous, order) >= 0) publicationRefuseV1();
    previous = order;
    const oid = bytes.subarray(nul + 1, nul + 21).toString("hex");
    if (!publicationOidV1(oid)) publicationRefuseV1();
    entries.push({ name, rawName, oid, tree });
    offset = nul + 21;
  }
  return entries;
}
function graph(
  records: readonly RecordV1[],
  request: PublicationRequestV1,
  limits: GitObjectLimitsV1,
): ParsedGraph {
  const byOid = new Map(records.map((r) => [r.oid, r]));
  const parents = new Map<string, readonly string[]>();
  const commitTrees = new Map<string, string>();
  const trees = new Map<string, readonly TreeEntry[]>();
  for (const r of records) {
    if (r.type === "commit") {
      const c = parseCommit(r.bytes);
      parents.set(r.oid, c.parents);
      commitTrees.set(r.oid, c.tree);
    }
    if (r.type === "tree") trees.set(r.oid, parseTree(r.bytes));
  }
  const reached = new Set<string>();
  const pending: { oid: string; type: ObjectType }[] = [
    { oid: request.proposedOid, type: "commit" },
    { oid: request.baseOid, type: "commit" },
  ];
  let steps = 0;
  while (pending.length) {
    if (++steps > limits.maxObjects * 32) publicationRefuseV1();
    const next = pending.pop()!;
    const r = byOid.get(next.oid);
    if (!r || r.type !== next.type) publicationRefuseV1();
    if (reached.has(next.oid)) continue;
    reached.add(next.oid);
    if (r.type === "commit") {
      pending.push({ oid: commitTrees.get(r.oid)!, type: "tree" });
      for (const p of parents.get(r.oid)!) pending.push({ oid: p, type: "commit" });
    } else if (r.type === "tree")
      for (const e of trees.get(r.oid)!)
        pending.push({ oid: e.oid, type: e.tree ? "tree" : "blob" });
  }
  if (reached.size !== records.length) publicationRefuseV1();
  // Expand each commit root independently; deduplication alone misses deeply
  // reused trees and exponentially many root paths through a small object DAG.
  const paths: { oid: string; depth: number; length: number }[] = [...commitTrees.values()].map(
    (oid) => ({ oid, depth: 0, length: 0 }),
  );
  let expanded = 0;
  while (paths.length) {
    const p = paths.pop()!;
    if (++expanded > limits.maxExpandedPaths || p.depth > limits.maxTreeDepth)
      publicationRefuseV1();
    for (const e of trees.get(p.oid)!) {
      if (++expanded > limits.maxExpandedPaths) publicationRefuseV1();
      const length = p.length + (p.depth ? 1 : 0) + e.rawName.length;
      if (length > limits.maxPathBytes) publicationRefuseV1();
      if (e.tree) paths.push({ oid: e.oid, depth: p.depth + 1, length });
    }
  }
  if (
    request.expectedTarget.kind === "existing" &&
    !ancestor(parents, request.expectedTarget.oid, request.proposedOid)
  )
    publicationRefuseV1();
  return { parents, trees };
}
function ancestor(
  parents: ReadonlyMap<string, readonly string[]>,
  oldOid: string,
  proposedOid: string,
): boolean {
  const pending = [proposedOid];
  const seen = new Set<string>();
  while (pending.length) {
    const oid = pending.pop()!;
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const p = parents.get(oid);
    if (!p) return false;
    pending.push(...p);
  }
  return false;
}
function pack(records: readonly RecordV1[], limit: number): Buffer {
  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(records.length, 8);
  const parts = [header];
  let total = 32;
  for (const r of records) {
    let size = r.bytes.length;
    const t = r.type === "commit" ? 1 : r.type === "tree" ? 2 : 3;
    const h: number[] = [(t << 4) | (size % 16)];
    size = Math.floor(size / 16);
    while (size) {
      h[h.length - 1] = h[h.length - 1]! | 128;
      h.push(size % 128);
      size = Math.floor(size / 128);
    }
    const encoded = deflateSync(r.bytes, { level: 6 });
    const prefix = Buffer.from(h);
    total += prefix.length + encoded.length;
    if (total > limit) publicationRefuseV1();
    parts.push(prefix, encoded);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}
function descriptor(
  records: readonly RecordV1[],
  request: PublicationRequestV1,
  packed: Buffer,
): PublicationGraphV1 {
  const manifest = {
    version: 1,
    objectFormat: "sha1",
    proposedOid: request.proposedOid,
    baseOid: request.baseOid,
    objects: records.map(({ oid, type, bytes, sha256: digest }) => ({
      oid,
      type,
      bytes: bytes.length,
      sha256: digest,
    })),
  };
  return Object.freeze({
    version: 1,
    objectFormat: "sha1",
    proposedOid: request.proposedOid,
    baseOid: request.baseOid,
    graphDigest: publicationDigestV1("object-graph", manifest),
    objectCount: records.length,
    rawBytes: records.reduce((n, r) => n + r.bytes.length, 0),
    packSha256: sha256(packed),
    packBytes: packed.length,
  });
}
function encode(records: readonly RecordV1[], fixed: PublicationGraphV1, packed: Buffer): Buffer {
  const metadata = Buffer.from(
    publicationCanonicalV1({
      version: 1,
      graph: fixed,
      objects: records.map(({ oid, type, bytes, sha256: digest }) => ({
        oid,
        type,
        bytes: bytes.length,
        sha256: digest,
      })),
    }),
  );
  if (metadata.length > MAX_METADATA) publicationRefuseV1();
  const header = Buffer.alloc(12);
  MAGIC.copy(header);
  header.writeUInt32BE(metadata.length, 8);
  return Buffer.concat([header, metadata, ...records.map((r) => r.bytes), packed]);
}
function decode(
  bytes: Buffer,
  limits: GitObjectLimitsV1,
): { records: RecordV1[]; fixed: PublicationGraphV1; packed: Buffer } {
  if (bytes.length < 12 || !bytes.subarray(0, 8).equals(MAGIC)) publicationRefuseV1();
  const size = bytes.readUInt32BE(8);
  if (size > MAX_METADATA || size + 12 > bytes.length) publicationRefuseV1();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(bytes.subarray(12, 12 + size)));
  } catch {
    publicationRefuseV1();
  }
  // Metadata has a separate finite 2MiB bound and exact per-entry checks.
  const m = publicationObjectV1(parsed, ["version", "graph", "objects"]);
  if (
    m.version !== 1 ||
    !Array.isArray(m.objects) ||
    m.objects.length < 1 ||
    m.objects.length > limits.maxObjects
  )
    publicationRefuseV1();
  const fixed = parsePublicationGraphV1(m.graph);
  let offset = 12 + size;
  let raw = 0;
  let previous = "";
  const records: RecordV1[] = [];
  for (const value of m.objects) {
    const o = publicationObjectV1(value, ["oid", "type", "bytes", "sha256"]);
    if (
      !publicationOidV1(o.oid) ||
      o.oid <= previous ||
      (o.type !== "commit" && o.type !== "tree" && o.type !== "blob") ||
      !Number.isSafeInteger(o.bytes) ||
      Number(o.bytes) < 0 ||
      Number(o.bytes) > limits.maxObjectBytes
    )
      publicationRefuseV1();
    const count = Number(o.bytes);
    raw += count;
    if (raw > limits.maxRawBytes || offset + count > bytes.length) publicationRefuseV1();
    const content = bytes.subarray(offset, offset + count);
    offset += count;
    if (
      sha256(content) !== o.sha256 ||
      createHash("sha1")
        .update(o.type + " " + count + "\0")
        .update(content)
        .digest("hex") !== o.oid
    )
      publicationRefuseV1();
    previous = o.oid;
    records.push({ oid: o.oid, type: o.type, bytes: content, sha256: o.sha256 as string });
  }
  const packed = bytes.subarray(offset);
  if (
    packed.length > limits.maxPackBytes ||
    fixed.objectCount !== records.length ||
    fixed.rawBytes !== raw ||
    fixed.packBytes !== packed.length ||
    fixed.packSha256 !== sha256(packed)
  )
    publicationRefuseV1();
  return { records, fixed, packed };
}
async function noSymlinkPath(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) publicationRefuseV1();
  const parts = path.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) publicationRefuseV1();
  }
}
function sameStat(
  a: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  b: typeof a,
): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

/** Credential-free immutable object custody. The selected persistent directory
 * stores content only; candidate/approval/effect journals remain in State. */
export class GitObjectCustodyV1 {
  readonly #directory: string;
  readonly #uid: number;
  readonly #limits: GitObjectLimitsV1;
  readonly #root: FileHandle;
  readonly #git: FileHandle;
  readonly #rootIdentity: { dev: number; ino: number };
  readonly #gitDigest: string;
  readonly #gitPath: string;
  readonly #gitUid: number;
  readonly #captures = new WeakMap<GitObjectCaptureV1, Captured>();
  readonly #pending = new Set<Promise<unknown>>();
  #closing = false;
  #closed: Promise<void> | undefined;
  private constructor(
    options: GitObjectCustodyOptionsV1,
    root: FileHandle,
    git: FileHandle,
    rootIdentity: { dev: number; ino: number },
  ) {
    this.#directory = options.directory;
    this.#uid = options.ownerUid;
    this.#limits = options.limits;
    this.#root = root;
    this.#git = git;
    this.#rootIdentity = rootIdentity;
    this.#gitDigest = options.gitExecutable.sha256;
    this.#gitPath = options.gitExecutable.path;
    this.#gitUid = options.gitExecutable.ownerUid;
  }
  static async open(options: GitObjectCustodyOptionsV1): Promise<GitObjectCustodyV1> {
    const fixed = publicationObjectV1(publicationSnapshotV1(options), [
      "directory",
      "ownerUid",
      "durability",
      "gitExecutable",
      "limits",
    ]);
    const executable = publicationObjectV1(fixed.gitExecutable, ["path", "sha256", "ownerUid"]);
    if (
      process.platform !== "linux" ||
      fixed.durability !== "persistent-posix" ||
      typeof fixed.directory !== "string" ||
      !Number.isSafeInteger(fixed.ownerUid) ||
      Number(fixed.ownerUid) < 0 ||
      typeof executable.path !== "string" ||
      !Number.isSafeInteger(executable.ownerUid) ||
      Number(executable.ownerUid) < 0 ||
      typeof executable.sha256 !== "string" ||
      !/^[0-9a-f]{64}(?![\s\S])/.test(executable.sha256)
    )
      publicationRefuseV1();
    const limits = checkLimits(fixed.limits as GitObjectLimitsV1);
    await noSymlinkPath(fixed.directory);
    await noSymlinkPath(executable.path);
    const root = await open(
      fixed.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let git: FileHandle | undefined;
    try {
      const stat = await root.stat();
      if (!stat.isDirectory() || stat.uid !== fixed.ownerUid || (stat.mode & 0o777) !== 0o700)
        publicationRefuseV1();
      git = await open(executable.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const gs = await git.stat();
      if (
        !gs.isFile() ||
        gs.uid !== executable.ownerUid ||
        (gs.mode & 0o022) !== 0 ||
        (gs.mode & 0o111) === 0 ||
        gs.size < 1 ||
        gs.size > 32 * 1024 * 1024
      )
        publicationRefuseV1();
      const b = Buffer.alloc(gs.size);
      const got = await git.read(b, 0, b.length, 0);
      if (
        got.bytesRead !== b.length ||
        createHash("sha256").update(b).digest("hex") !== executable.sha256 ||
        !sameStat(gs, await git.stat())
      )
        publicationRefuseV1();
      const result = new GitObjectCustodyV1(
        {
          directory: fixed.directory,
          ownerUid: Number(fixed.ownerUid),
          durability: "persistent-posix",
          gitExecutable: {
            path: executable.path,
            sha256: executable.sha256,
            ownerUid: Number(executable.ownerUid),
          },
          limits,
        },
        root,
        git,
        stat,
      );
      await result.#assertRoot();
      return result;
    } catch (error) {
      await git?.close();
      await root.close();
      throw error;
    }
  }
  #run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new Error("Git object custody is closed"));
    const p = Promise.resolve().then(fn);
    this.#pending.add(p);
    void p.finally(() => this.#pending.delete(p)).catch(() => undefined);
    return p;
  }
  async #assertRoot(): Promise<void> {
    const held = await this.#root.stat();
    const named = await lstat(this.#directory);
    if (
      !held.isDirectory() ||
      !named.isDirectory() ||
      held.dev !== this.#rootIdentity.dev ||
      held.ino !== this.#rootIdentity.ino ||
      named.dev !== held.dev ||
      named.ino !== held.ino ||
      held.uid !== this.#uid ||
      (held.mode & 0o777) !== 0o700 ||
      named.isSymbolicLink()
    )
      publicationRefuseV1();
  }
  #filename(digest: string): string {
    if (!/^sha256:[0-9a-f]{64}(?![\s\S])/.test(digest)) publicationRefuseV1();
    return `/proc/self/fd/${this.#root.fd}/${digest.slice(7)}.objects`;
  }
  async #hashWithGit(record: RecordV1, signal: AbortSignal, deadline: number): Promise<void> {
    if (signal.aborted || performance.now() >= deadline) publicationRefuseV1();
    const before = await this.#git.stat();
    const named = await lstat(this.#gitPath);
    if (
      !before.isFile() ||
      before.uid !== this.#gitUid ||
      !sameStat(before, named) ||
      (before.mode & 0o022) !== 0 ||
      named.isSymbolicLink()
    )
      publicationRefuseV1();
    // Rehash the held executable before invocation. The child executes that same
    // inherited descriptor; it never selects a command, config, helper or path.
    const executable = Buffer.alloc(before.size);
    const read = await this.#git.read(executable, 0, executable.length, 0);
    if (
      read.bytesRead !== executable.length ||
      createHash("sha256").update(executable).digest("hex") !== this.#gitDigest ||
      !sameStat(before, await this.#git.stat())
    )
      publicationRefuseV1();
    const output = await new Promise<string>((resolveResult, reject) => {
      const child = spawn(
        "/proc/self/fd/3",
        [
          "--git-dir=/dev/null",
          "--no-replace-objects",
          "hash-object",
          "--no-filters",
          "--stdin",
          "-t",
          record.type,
        ],
        {
          cwd: "/",
          env: {
            PATH: "",
            HOME: "/nonexistent",
            XDG_CONFIG_HOME: "/nonexistent",
            LANG: "C",
            LC_ALL: "C",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_CEILING_DIRECTORIES: this.#directory,
            GIT_TERMINAL_PROMPT: "0",
          },
          stdio: ["pipe", "pipe", "pipe", this.#git.fd],
        },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      const abort = (): void => {
        failed = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(abort, Math.max(1, Math.min(5000, deadline - performance.now())));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.stdout!.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 128) abort();
        else chunks.push(Buffer.from(chunk));
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4096) abort();
      });
      child.stdin!.on("error", () => {
        failed = true;
      });
      child.on("error", () => {
        failed = true;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (failed || code !== 0) reject(new Error("Git object validation refused"));
        else resolveResult(Buffer.concat(chunks).toString("ascii"));
      });
      child.stdin!.end(record.bytes);
    });
    if (
      output !== record.oid + "\n" ||
      signal.aborted ||
      performance.now() >= deadline ||
      !sameStat(before, await this.#git.stat())
    )
      publicationRefuseV1();
  }
  async #read(digest: string): Promise<Buffer> {
    await this.#assertRoot();
    const file = await open(this.#filename(digest), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      const max = 12 + MAX_METADATA + this.#limits.maxRawBytes + this.#limits.maxPackBytes;
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.uid !== this.#uid ||
        (before.mode & 0o777) !== 0o600 ||
        before.size < 12 ||
        before.size > max
      )
        publicationRefuseV1();
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const r = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!r.bytesRead) publicationRefuseV1();
        offset += r.bytesRead;
      }
      if (!sameStat(before, await file.stat())) publicationRefuseV1();
      await this.#assertRoot();
      return bytes;
    } finally {
      await file.close();
    }
  }
  async #retain(digest: string, bytes: Buffer): Promise<void> {
    await this.#assertRoot();
    const temporary = `/proc/self/fd/${this.#root.fd}/.pending-${randomUUID()}`;
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let linked = false;
    try {
      await file.writeFile(bytes);
      await file.sync();
      try {
        await link(temporary, this.#filename(digest));
        linked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const old = await this.#read(digest);
        if (!old.equals(bytes)) publicationRefuseV1();
      }
      await this.#root.sync();
    } finally {
      await file.close();
      // A fully written pending file is content only, not an effect journal.
      // The final alias is never removed or overwritten on cancellation/failure.
      await unlink(temporary);
      await this.#root.sync();
    }
    await this.#assertRoot();
    if (linked && !(await this.#read(digest)).equals(bytes)) publicationRefuseV1();
  }
  #issue(
    fixed: PublicationGraphV1,
    parents: Map<string, readonly string[]>,
    bytes: Buffer,
  ): GitObjectCaptureV1 {
    const handle = Object.freeze({}) as GitObjectCaptureV1;
    this.#captures.set(handle, { graph: fixed, parents, storageSha256: sha256(bytes) });
    return handle;
  }
  capture(
    request: PublicationRequestV1,
    objects: readonly GitObjectInputV1[],
    signal: AbortSignal,
  ): Promise<GitObjectCaptureV1> {
    // Capture all hostile inputs synchronously before the first await.
    const fixed = parsePublicationRequestV1(request);
    const records = copyObjects(objects, this.#limits);
    return this.#run(async () => {
      const deadline = performance.now() + this.#limits.captureTimeoutMs;
      const parsed = graph(records, fixed, this.#limits);
      for (const record of records) await this.#hashWithGit(record, signal, deadline);
      const packed = pack(records, this.#limits.maxPackBytes);
      const described = descriptor(records, fixed, packed);
      const encoded = encode(records, described, packed);
      if (signal.aborted || performance.now() >= deadline) publicationRefuseV1();
      await this.#retain(described.graphDigest, encoded);
      if (signal.aborted || performance.now() >= deadline) publicationRefuseV1();
      return this.#issue(described, parsed.parents, encoded);
    });
  }
  inspect(original: GitObjectCaptureV1): PublicationGraphV1 {
    const held = this.#captures.get(original);
    if (!held || this.#closing) publicationRefuseV1();
    return held.graph;
  }
  assertRequest(original: GitObjectCaptureV1, request: PublicationRequestV1): undefined {
    const fixed = parsePublicationRequestV1(request);
    const held = this.#captures.get(original);
    if (
      !held ||
      this.#closing ||
      fixed.proposedOid !== held.graph.proposedOid ||
      fixed.baseOid !== held.graph.baseOid ||
      (fixed.expectedTarget.kind === "existing" &&
        !ancestor(held.parents, fixed.expectedTarget.oid, fixed.proposedOid))
    )
      publicationRefuseV1();
    return undefined;
  }
  readPack(original: GitObjectCaptureV1): Promise<Uint8Array> {
    const held = this.#captures.get(original);
    if (!held) publicationRefuseV1();
    return this.#run(async () => {
      const bytes = await this.#read(held.graph.graphDigest);
      if (sha256(bytes) !== held.storageSha256) publicationRefuseV1();
      const decoded = decode(bytes, this.#limits);
      return Buffer.from(decoded.packed);
    });
  }
  restore(
    graphValue: PublicationGraphV1,
    request: PublicationRequestV1,
    signal: AbortSignal,
  ): Promise<GitObjectCaptureV1> {
    const expected = parsePublicationGraphV1(graphValue);
    const fixed = parsePublicationRequestV1(request);
    return this.#run(async () => {
      const deadline = performance.now() + this.#limits.captureTimeoutMs;
      const bytes = await this.#read(expected.graphDigest);
      const decoded = decode(bytes, this.#limits);
      const parsed = graph(decoded.records, fixed, this.#limits);
      for (const record of decoded.records) await this.#hashWithGit(record, signal, deadline);
      const packed = pack(decoded.records, this.#limits.maxPackBytes);
      const actual = descriptor(decoded.records, fixed, packed);
      if (
        publicationCanonicalV1(actual) !== publicationCanonicalV1(expected) ||
        publicationCanonicalV1(decoded.fixed) !== publicationCanonicalV1(expected) ||
        !packed.equals(decoded.packed) ||
        signal.aborted ||
        performance.now() >= deadline
      )
        publicationRefuseV1();
      return this.#issue(actual, parsed.parents, bytes);
    });
  }
  close(): Promise<void> {
    if (this.#closed) return this.#closed;
    this.#closing = true;
    this.#closed = (async () => {
      await Promise.allSettled([...this.#pending]);
      await this.#git.close();
      await this.#root.close();
    })();
    return this.#closed;
  }
}
