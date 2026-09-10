import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";

export interface InstalledLayerLimits {
  readonly uncompressedBytes: number;
  readonly entries: number;
  readonly pathBytes: number;
  readonly linkDepth: number;
}
export interface InstalledLayerInput {
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly diffId: string;
}
type Entry =
  | {
      readonly kind: "file";
      readonly mode: number;
      readonly uid: number;
      readonly gid: number;
      readonly data: Buffer;
    }
  | {
      readonly kind: "directory";
      readonly mode: number;
      readonly uid: number;
      readonly gid: number;
    }
  | {
      readonly kind: "symlink";
      readonly mode: number;
      readonly uid: number;
      readonly gid: number;
      readonly target: string;
    };
type Change = Readonly<{
  path: string;
  entry?: Entry;
  hardlink?: Readonly<{ target: string; mode: number; uid: number; gid: number }>;
  whiteout?: Readonly<{ kind: "opaque" } | { kind: "remove"; name: string }>;
}>;
const tarType = "application/vnd.oci.image.layer.v1.tar";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const throwIfAborted = AbortSignal.prototype.throwIfAborted;
function invalid(): never {
  throw new Error("Installed image layer is unavailable or unsupported.");
}
function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function field(bytes: Buffer, start: number, length: number): string {
  const region = bytes.subarray(start, start + length);
  const zero = region.indexOf(0);
  if (zero >= 0 && region.subarray(zero).some((byte) => byte !== 0)) invalid();
  return text(zero < 0 ? region : region.subarray(0, zero));
}
function octal(bytes: Buffer, start: number, length: number): number {
  // POSIX permits a checksum's trailing NUL followed by a space. Name fields
  // deliberately use the stricter field() parser instead.
  const raw = text(bytes.subarray(start, start + length)).replace(/^[\x00 ]+|[\x00 ]+$/g, "");
  if (!/^[0-7]*$/.test(raw)) invalid();
  const n = raw ? Number.parseInt(raw, 8) : 0;
  if (!Number.isSafeInteger(n) || n < 0) invalid();
  return n;
}
function pathName(value: string, limits: InstalledLayerLimits, directory = false): string {
  if (value.startsWith("./")) value = value.slice(2);
  if (directory && value.endsWith("/")) value = value.slice(0, -1);
  if (directory && (value === "" || value === ".")) return "";
  if (
    !value ||
    Buffer.byteLength(value) > limits.pathBytes ||
    value.split("/").length > 64 ||
    /[\\\x00-\x1f\x7f]/.test(value) ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    invalid();
  return value;
}
function linkName(value: string, parent: string, limits: InstalledLayerLimits): string {
  if (!value || Buffer.byteLength(value) > limits.pathBytes || /[\\\x00-\x1f\x7f]/.test(value))
    invalid();
  const result = value.startsWith("/") ? [] : parent.split("/").filter(Boolean);
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!result.length) invalid();
      result.pop();
    } else result.push(part);
  }
  const resolved = result.join("/");
  if (Buffer.byteLength(resolved) > limits.pathBytes || result.length > 64) invalid();
  // This lexical check refuses obvious escapes, but must not rewrite the
  // target. Intermediate symlinks are followed before any subsequent '..'.
  return value;
}
function pax(data: Buffer): Readonly<Record<string, string>> {
  const values: Record<string, string> = Object.create(null);
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(32, offset);
    if (space < 0 || space - offset > 12) invalid();
    const lengthText = data.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) invalid();
    const length = Number(lengthText),
      end = offset + length;
    if (
      !Number.isSafeInteger(length) ||
      end > data.length ||
      end <= space + 2 ||
      data[end - 1] !== 10
    )
      invalid();
    const item = text(data.subarray(space + 1, end - 1)),
      equals = item.indexOf("=");
    if (equals < 1) invalid();
    const key = item.slice(0, equals),
      value = item.slice(equals + 1);
    if (
      !["path", "linkpath", "size", "uid", "gid", "mtime", "atime", "ctime"].includes(key) ||
      Object.hasOwn(values, key)
    )
      invalid();
    if (
      ["size", "uid", "gid"].includes(key) &&
      (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    )
      invalid();
    if (["mtime", "atime", "ctime"].includes(key) && !/^[0-9]+(?:\.[0-9]+)?$/.test(value))
      invalid();
    values[key] = value;
    offset = end;
  }
  return values;
}
function parseTar(
  data: Buffer,
  limits: InstalledLayerLimits,
  signal: AbortSignal,
  remaining: number,
): { changes: Change[]; entries: number } {
  if (data.length < 1024 || data.length % 512 !== 0) invalid();
  const changes: Change[] = [],
    seen = new Set<string>();
  let next: Readonly<Record<string, string>> | undefined,
    ended = false,
    count = 0;
  for (let offset = 0; offset < data.length;) {
    throwIfAborted.call(signal);
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (next || offset + 1024 > data.length || data.subarray(offset).some((byte) => byte !== 0))
        invalid();
      ended = true;
      break;
    }
    if (++count > remaining) invalid();
    const checksum = octal(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (sum !== checksum || field(header, 257, 6) !== "ustar" || field(header, 263, 2) !== "00")
      invalid();
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    const extended = type === "x";
    if (!["0", "1", "2", "5", "x"].includes(type) || (extended && next)) invalid();
    const extra = extended ? undefined : next;
    const size = extra?.size === undefined ? octal(header, 124, 12) : Number(extra.size);
    const end = offset + 512 + size,
      padded = Math.ceil(end / 512) * 512;
    if (
      !Number.isSafeInteger(end) ||
      padded > data.length ||
      data.subarray(end, padded).some((byte) => byte !== 0)
    )
      invalid();
    const payload = data.subarray(offset + 512, end);
    offset = padded;
    if (extended) {
      if (size > limits.pathBytes * 4) invalid();
      next = pax(payload);
      continue;
    }
    next = undefined;
    const prefix = field(header, 345, 155),
      name = field(header, 0, 100);
    const path = pathName(
      extra?.path ?? (prefix ? `${prefix}/${name}` : name),
      limits,
      type === "5",
    );
    if (seen.has(path)) invalid();
    seen.add(path);
    const mode = octal(header, 100, 8),
      uid = extra?.uid === undefined ? octal(header, 108, 8) : Number(extra.uid),
      gid = extra?.gid === undefined ? octal(header, 116, 8) : Number(extra.gid);
    octal(header, 136, 12);
    // Numeric identities are authoritative for the virtual view; device nodes
    // and extended header tails are outside this selected regular-file subset.
    field(header, 265, 32);
    field(header, 297, 32);
    if (
      octal(header, 329, 8) !== 0 ||
      octal(header, 337, 8) !== 0 ||
      header.subarray(500).some((byte) => byte !== 0) ||
      mode > 0o7777 ||
      uid > 0xffffffff ||
      gid > 0xffffffff ||
      (type !== "0" && size !== 0)
    )
      invalid();
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
      base = path.slice(parent ? parent.length + 1 : 0);
    if (base.startsWith(".wh.")) {
      if (
        type !== "0" ||
        size !== 0 ||
        field(header, 157, 100) !== "" ||
        extra?.linkpath !== undefined
      )
        invalid();
      const whiteout =
        base === ".wh..wh..opq"
          ? { kind: "opaque" as const }
          : { kind: "remove" as const, name: pathName(base.slice(4), limits) };
      changes.push({ path: parent, whiteout });
      continue;
    }
    if (path.split("/").some((part) => part.startsWith(".wh."))) invalid();
    if (type === "1") {
      changes.push({
        path,
        hardlink: {
          target: pathName(extra?.linkpath ?? field(header, 157, 100), limits),
          mode,
          uid,
          gid,
        },
      });
    } else if (type === "2") {
      const target = linkName(extra?.linkpath ?? field(header, 157, 100), parent, limits);
      changes.push({ path, entry: { kind: "symlink", mode, uid, gid, target } });
    } else {
      if (field(header, 157, 100) !== "" || extra?.linkpath !== undefined) invalid();
      changes.push({
        path,
        entry:
          type === "5"
            ? { kind: "directory", mode, uid, gid }
            : { kind: "file", mode, uid, gid, data: payload },
      });
    }
  }
  if (!ended) invalid();
  const additions = new Map(
    changes
      .filter((change) => change.whiteout === undefined)
      .map((change) => [change.path, change]),
  );
  for (const change of additions.values()) {
    const parts = change.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = additions.get(parts.slice(0, i).join("/"));
      if (parent && parent.entry?.kind !== "directory") invalid();
    }
  }
  return { changes, entries: count };
}

/** Virtual image only: no archive path ever reaches a host filesystem call. */
export class InstalledImageFiles {
  readonly #entries = new Map<string, Entry>();
  readonly #buffers: Buffer[] = [];
  readonly #limits: InstalledLayerLimits;
  #usage: Readonly<{ uncompressedBytes: number; entries: number }> = Object.freeze({
    uncompressedBytes: 0,
    entries: 0,
  });
  #closed = false;
  private constructor(limits: InstalledLayerLimits) {
    for (const [name, cap] of Object.entries({
      uncompressedBytes: 4294967295,
      entries: 1000000,
      pathBytes: 4096,
      linkDepth: 64,
    })) {
      const value = limits[name as keyof InstalledLayerLimits];
      if (!Number.isSafeInteger(value) || value < 1 || value > cap) invalid();
    }
    this.#limits = Object.freeze({ ...limits });
  }
  get usage(): Readonly<{ uncompressedBytes: number; entries: number }> {
    return this.#usage;
  }
  static async acquire(
    layers: readonly InstalledLayerInput[],
    limits: InstalledLayerLimits,
    signal: AbortSignal,
  ): Promise<InstalledImageFiles> {
    const result = new InstalledImageFiles(limits);
    let used = 0,
      count = 0;
    try {
      for (const layer of layers) {
        throwIfAborted.call(signal);
        if (
          !digestPattern.test(layer.diffId) ||
          ![tarType, `${tarType}+gzip`].includes(layer.mediaType)
        )
          invalid();
        const remaining = limits.uncompressedBytes - used;
        if (remaining < 1024) invalid();
        if (layer.mediaType === tarType && layer.bytes.byteLength > remaining) invalid();
        const compressed = Buffer.from(layer.bytes);
        let bytes: Buffer;
        try {
          // The actual zlib callback is awaited, never raced or abandoned on abort.
          bytes =
            layer.mediaType === tarType
              ? Buffer.from(compressed)
              : await new Promise<Buffer>((resolve, reject) => {
                  gunzip(compressed, { maxOutputLength: remaining }, (error, output) =>
                    error ? reject(error) : resolve(output),
                  );
                });
        } finally {
          compressed.fill(0);
        }
        result.#buffers.push(bytes);
        throwIfAborted.call(signal);
        used += bytes.length;
        if (used > limits.uncompressedBytes || digest(bytes) !== layer.diffId) invalid();
        const parsed = parseTar(bytes, limits, signal, limits.entries - count);
        const changes = parsed.changes;
        count += parsed.entries;
        // Whiteouts hide lower layers only, regardless of their archive order.
        for (const change of changes)
          if (change.whiteout !== undefined) {
            const target =
              change.whiteout.kind === "opaque"
                ? change.path
                : [change.path, change.whiteout.name].filter(Boolean).join("/");
            for (const key of result.#entries.keys())
              if (
                (change.whiteout.kind === "remove" && key === target) ||
                key.startsWith(target ? `${target}/` : "")
              )
                result.#entries.delete(key);
          }
        for (const change of changes)
          if (change.whiteout === undefined) {
            const parts = change.path.split("/");
            for (let i = 1; i < parts.length; i++) {
              const parent = result.#entries.get(parts.slice(0, i).join("/"));
              // Never apply archive writes through a lower-layer symbolic link.
              if (parent !== undefined && parent.kind !== "directory") invalid();
            }
            let entry = change.entry;
            if (change.hardlink !== undefined) {
              entry = result.#resolve(change.hardlink.target);
              // Forward and directory hardlinks are outside this explicit subset.
              if (
                entry?.kind !== "file" ||
                entry.mode !== change.hardlink.mode ||
                entry.uid !== change.hardlink.uid ||
                entry.gid !== change.hardlink.gid
              )
                invalid();
            }
            if (!entry) invalid();
            // Missing explicit directory metadata does not mean its descendants
            // are absent. Adding that metadata preserves an implicit directory.
            if (entry.kind !== "directory") {
              for (const key of result.#entries.keys())
                if (key === change.path || key.startsWith(`${change.path}/`))
                  result.#entries.delete(key);
            }
            result.#entries.set(change.path, entry);
          }
      }
      result.#usage = Object.freeze({ uncompressedBytes: used, entries: count });
      throwIfAborted.call(signal);
      Object.freeze(result);
      return result;
    } catch (error) {
      result.close();
      throw error;
    }
  }
  #resolve(path: string): Entry | undefined {
    let pending = path.split("/"),
      resolved: string[] = [],
      followed = 0;
    while (pending.length) {
      if (
        this.#closed ||
        Buffer.byteLength([...resolved, ...pending].join("/")) > this.#limits.pathBytes ||
        resolved.length + pending.length > 64
      )
        invalid();
      const part = pending.shift()!;
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (!resolved.length) invalid();
        resolved.pop();
        continue;
      }
      const name = [...resolved, part].join("/"),
        entry = this.#entries.get(name);
      if (entry?.kind === "symlink") {
        if (++followed > this.#limits.linkDepth) invalid();
        if (entry.target.startsWith("/")) resolved = [];
        pending = [...entry.target.split("/"), ...pending];
        continue;
      }
      if (pending.length) {
        if (entry !== undefined && entry.kind !== "directory") invalid();
        if (entry === undefined) {
          let implicitDirectory = false;
          for (const key of this.#entries.keys())
            if (key.startsWith(`${name}/`)) {
              implicitDirectory = true;
              break;
            }
          if (!implicitDirectory) return undefined;
        }
      }
      resolved.push(part);
    }
    if (this.#closed) invalid();
    return this.#entries.get(resolved.join("/"));
  }
  read(path: string) {
    if (!path.startsWith("/")) invalid();
    const entry = this.#resolve(pathName(path.slice(1), this.#limits));
    if (entry?.kind !== "file") invalid();
    return Object.freeze({
      mode: entry.mode,
      uid: entry.uid,
      gid: entry.gid,
      digest: digest(entry.data),
      bytes: new Uint8Array(entry.data),
    });
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#entries.clear();
    for (const buffer of this.#buffers) buffer.fill(0);
    this.#buffers.length = 0;
  }
}
