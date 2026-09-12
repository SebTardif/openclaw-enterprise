import { createHash } from "node:crypto";
import { types } from "node:util";

/** Commit roots to retain and an optional fast-forward requirement. */
export type GitExpectedTarget =
  Readonly<{ kind: "create" }> | Readonly<{ kind: "existing"; oid: string }>;

export interface GitSnapshotRequest {
  readonly baseOid: string;
  readonly proposedOid: string;
  readonly expectedTarget: GitExpectedTarget;
}

/** Persisted description of a verified Git object snapshot. */
export interface GitSnapshotDescriptor {
  readonly version: 1;
  readonly objectFormat: "sha1";
  readonly proposedOid: string;
  readonly baseOid: string;
  readonly graphDigest: string;
  readonly objectCount: number;
  readonly rawBytes: number;
  readonly packSha256: string;
  readonly packBytes: number;
}

declare const captureBrand: unique symbol;
/** An in-process handle recognized by the store that captured these bytes. */
export interface GitSnapshot {
  readonly [captureBrand]: true;
}

export class GitObjectStoreError extends Error {
  constructor() {
    super("Git object snapshot input or storage is unavailable");
    this.name = "GitObjectStoreError";
  }
}
export function refuseGitSnapshot(): never {
  throw new GitObjectStoreError();
}

/** Copies only bounded plain own-data JSON. Proxies, accessors and prototypes
 * cannot execute while a snapshot is captured. */
export function snapshotData(value: unknown): unknown {
  let nodes = 0;
  let encodedBytes = 0;
  function charge(bytes: number): void {
    encodedBytes += bytes;
    if (encodedBytes > 262144) refuseGitSnapshot();
  }
  const seen = new Set<object>();
  function copy(v: unknown, depth: number): unknown {
    if (++nodes > 20000 || depth > 32) refuseGitSnapshot();
    if (v === null || typeof v === "boolean") {
      charge(v === false ? 5 : 4);
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) refuseGitSnapshot();
      charge(String(v).length);
      return v;
    }
    if (typeof v === "string") {
      if (Buffer.byteLength(v) > 131072) refuseGitSnapshot();
      charge(Buffer.byteLength(JSON.stringify(v)));
      return v;
    }
    if (!v || typeof v !== "object" || types.isProxy(v) || seen.has(v)) refuseGitSnapshot();
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (Object.getPrototypeOf(v) !== Array.prototype || v.length > 8192) refuseGitSnapshot();
        const keys = Reflect.ownKeys(v);
        if (keys.length !== v.length + 1) refuseGitSnapshot();
        const result: unknown[] = [];
        charge(2 + Math.max(0, v.length - 1));
        for (let i = 0; i < v.length; i++) {
          const d = Object.getOwnPropertyDescriptor(v, String(i));
          if (!d || !d.enumerable || !("value" in d)) refuseGitSnapshot();
          result.push(copy(d.value, depth + 1));
        }
        return Object.freeze(result);
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        refuseGitSnapshot();
      const result: Record<string, unknown> = Object.create(null);
      charge(2);
      let first = true;
      for (const k of Reflect.ownKeys(v)) {
        if (typeof k !== "string" || k.length > 256) refuseGitSnapshot();
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d || !d.enumerable || !("value" in d)) refuseGitSnapshot();
        charge(Buffer.byteLength(JSON.stringify(k)) + 1 + (first ? 0 : 1));
        first = false;
        result[k] = copy(d.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      seen.delete(v);
    }
  }
  const result = copy(value, 0);
  return result;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k]))
        .join(",") +
      "}"
    );
  }
  const result = JSON.stringify(value);
  if (result === undefined) refuseGitSnapshot();
  return result;
}
export function digestData(domain: string, value: unknown): string {
  return (
    "sha256:" +
    createHash("sha256")
      .update("oce/git-object-store/v1/" + domain + "\0")
      .update(canonicalJson(value))
      .digest("hex")
  );
}
export function expectObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuseGitSnapshot();
  const o = value as Record<string, unknown>;
  const actual = Object.keys(o).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i]))
    refuseGitSnapshot();
  return o;
}
export function isGitOid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{40}(?![\s\S])/.test(v) && v !== "0".repeat(40);
}
export function isSha256(v: unknown): v is string {
  return typeof v === "string" && /^sha256:[0-9a-f]{64}(?![\s\S])/.test(v);
}
export function parseGitSnapshotRequest(value: unknown): GitSnapshotRequest {
  const fixed = snapshotData(value);
  const o = expectObject(fixed, ["baseOid", "proposedOid", "expectedTarget"]);
  if (!isGitOid(o.baseOid) || !isGitOid(o.proposedOid)) refuseGitSnapshot();
  const expected = o.expectedTarget as Record<string, unknown>;
  expectObject(expected, expected?.kind === "create" ? ["kind"] : ["kind", "oid"]);
  if (expected.kind !== "create" && (expected.kind !== "existing" || !isGitOid(expected.oid)))
    refuseGitSnapshot();
  return fixed as GitSnapshotRequest;
}

export function parseGitSnapshotDescriptor(value: unknown): GitSnapshotDescriptor {
  const fixed = snapshotData(value);
  const o = expectObject(fixed, [
    "version",
    "objectFormat",
    "proposedOid",
    "baseOid",
    "graphDigest",
    "objectCount",
    "rawBytes",
    "packSha256",
    "packBytes",
  ]);
  if (
    o.version !== 1 ||
    o.objectFormat !== "sha1" ||
    !isGitOid(o.proposedOid) ||
    !isGitOid(o.baseOid) ||
    !isSha256(o.graphDigest) ||
    !isSha256(o.packSha256) ||
    [o.objectCount, o.rawBytes, o.packBytes].some((n) => !Number.isSafeInteger(n) || Number(n) < 1)
  )
    refuseGitSnapshot();
  return fixed as GitSnapshotDescriptor;
}
