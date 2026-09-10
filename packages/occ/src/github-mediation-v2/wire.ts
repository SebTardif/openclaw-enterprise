import { createHash } from "node:crypto";
import { types } from "node:util";

export const GITHUB_MEDIATION_ALPN = "oce-github-mediation-v2";
export const GITHUB_GIT_READ_ALPN = "oce-github-git-read-v3";
export const GITHUB_GIT_REQUEST_LIMIT = 4_194_304;
export type GitHubMediationVersion = 2 | 3;
export const EMPTY_BODY_SHA256 =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const METADATA_LIMIT = 16_384;
export const TOKEN_LIMIT = 16_384;

export type GitHubMediationCorrelation<V extends GitHubMediationVersion = 2> = Readonly<{
  version: V;
  sequence: number;
  request_ref: string;
}>;
export type GitHubMediationBinding<V extends GitHubMediationVersion = 2> =
  GitHubMediationCorrelation<V> &
    Readonly<{
      session_ref: string;
      effect_ref: string;
      work_binding_sha256: string;
      request_sha256: string;
    }>;
export type GitHubMediationTimes = Readonly<{
  server_time_ms: number;
  valid_until_ms: number;
  operation_until_ms: number;
}>;
type OpenReadBase<V extends GitHubMediationVersion> = GitHubMediationCorrelation<V> &
  Readonly<{
    method: "open-read";
    attachment_ref: string;
    repository_owner: string;
    repository_name: string;
    request_sha256: string;
  }>;
export type GitReadOperation = "discovery" | "upload-pack";
export type OpenRead<V extends GitHubMediationVersion = 2> = V extends 3
  ? OpenReadBase<3> &
      Readonly<{
        git_operation: GitReadOperation;
        git_protocol: "version=2";
        body_bytes: number;
        body_sha256: string;
      }>
  : OpenReadBase<2>;
type DnsBinding = Readonly<{ dns_binding_ref: string; upstream_ipv4: string }>;
export type DispatchRead<V extends GitHubMediationVersion = 2> = GitHubMediationBinding<V> &
  DnsBinding &
  Readonly<{
    method: "dispatch-read";
    peer_certificate_sha256: string;
  }>;
export type CheckRead<V extends GitHubMediationVersion = 2> = GitHubMediationBinding<V> &
  Readonly<{
    method: "check-read";
    release_ref: string;
  }>;
export type CompleteRead<V extends GitHubMediationVersion = 2> = GitHubMediationBinding<V> &
  Readonly<{
    method: "complete-read";
    release_ref: string | null;
    outcome: "not-dispatched" | "completed" | "unknown";
  }>;
export type Opened<V extends GitHubMediationVersion = 2> = GitHubMediationBinding<V> &
  GitHubMediationTimes &
  DnsBinding &
  Readonly<{
    ok: true;
    phase: "opened";
  }>;
export type DispatchOnce<V extends GitHubMediationVersion = 2> = GitHubMediationBinding<V> &
  GitHubMediationTimes &
  DnsBinding &
  Readonly<{
    ok: true;
    phase: "dispatch-once";
    peer_certificate_sha256: string;
    release_ref: string;
  }>;
export type Current<V extends GitHubMediationVersion = 2> = GitHubMediationBinding<V> &
  GitHubMediationTimes &
  Readonly<{
    ok: true;
    phase: "current";
    release_ref: string;
  }>;
export type CompletedReceipt<V extends GitHubMediationVersion = 2> = GitHubMediationBinding<V> &
  Readonly<{
    ok: true;
    phase: "recorded";
    release_ref: string | null;
  }>;
export type Refused<V extends GitHubMediationVersion = 2> = GitHubMediationCorrelation<V> &
  Readonly<{
    ok: false;
    code: "denied" | "unavailable" | "expired" | "invalid";
  }>;
export type GitHubMediationRequest<V extends GitHubMediationVersion = 2> =
  OpenRead<V> | DispatchRead<V> | CheckRead<V> | CompleteRead<V>;
export type GitHubMediationReply<V extends GitHubMediationVersion = 2> =
  Opened<V> | DispatchOnce<V> | Current<V> | CompletedReceipt<V> | Refused<V>;

type FlatObject = Record<string, string | number | boolean | null>;
const C = ["version", "sequence", "request_ref"] as const;
const B = [...C, "session_ref", "effect_ref", "work_binding_sha256", "request_sha256"] as const;
const T = ["server_time_ms", "valid_until_ms", "operation_until_ms"] as const;
const DNS = ["dns_binding_ref", "upstream_ipv4"] as const;
const TIME_LIMIT = 253_402_300_799_999;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;

function ref(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?![\s\S])/.test(value)
  );
}
function nonce(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{32}(?![\s\S])/.test(value);
}
function digest(value: unknown): boolean {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}(?![\s\S])/.test(value);
}
function component(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*(?![\s\S])/.test(value)
  );
}
function integer(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= min &&
    value <= max
  );
}
function exact(value: FlatObject, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
function correlation(value: FlatObject): boolean {
  return (
    (value.version === 2 || value.version === 3) &&
    integer(value.sequence, 1, 0xffff_ffff) &&
    nonce(value.request_ref)
  );
}
function binding(value: FlatObject): boolean {
  return (
    correlation(value) &&
    nonce(value.session_ref) &&
    ref(value.effect_ref) &&
    digest(value.work_binding_sha256) &&
    digest(value.request_sha256)
  );
}
function times(value: FlatObject): boolean {
  return (
    integer(value.server_time_ms, 0, TIME_LIMIT) &&
    integer(value.valid_until_ms, 0, TIME_LIMIT) &&
    integer(value.operation_until_ms, 0, TIME_LIMIT) &&
    value.server_time_ms < value.valid_until_ms &&
    value.valid_until_ms <= value.operation_until_ms
  );
}
function publicIpv4(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}(?![\s\S])/.test(value)
  )
    return false;
  const octets = value.split(".").map(Number);
  if (octets.some((part) => part > 255)) return false;
  const [a, b, c] = octets as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
function dns(value: FlatObject): boolean {
  return ref(value.dns_binding_ref) && publicIpv4(value.upstream_ipv4);
}

/** Exact semantic request digest; caller names still confer no repository authority. */
export function githubMetadataDigest(owner: string, name: string): string | undefined {
  if (!component(owner) || !component(name)) return undefined;
  const canonical = [
    "oce.github.metadata.v2",
    "GET",
    "https",
    "api.github.com",
    "443",
    `/repos/${owner}/${name}`,
    "accept:application/vnd.github+json",
    "accept-encoding:identity",
    "user-agent:oce-github-mediation",
    "connection:close",
    "body-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "",
  ].join("\n");
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** Git read has a separate domain, fixed origin/paths and retained-body binding.
 * It describes request bytes only; original authority comes from the owner. */
export function githubGitReadDigest(
  owner: string,
  name: string,
  operation: GitReadOperation,
  bodyBytes: number,
  bodySha256: string,
): string | undefined {
  if (
    !component(owner) ||
    !component(name) ||
    !["discovery", "upload-pack"].includes(operation) ||
    !integer(bodyBytes, 0, GITHUB_GIT_REQUEST_LIMIT) ||
    !digest(bodySha256)
  )
    return undefined;
  const discovery = operation === "discovery";
  if (discovery ? bodyBytes !== 0 || bodySha256 !== EMPTY_BODY_SHA256 : bodyBytes === 0)
    return undefined;
  const canonical = [
    "oce.github.git-read.v3",
    operation,
    discovery ? "GET" : "POST",
    "https",
    "github.com",
    "443",
    `/${owner}/${name}.git/${discovery ? "info/refs?service=git-upload-pack" : "git-upload-pack"}`,
    `accept:application/x-git-upload-pack-${discovery ? "advertisement" : "result"}`,
    "accept-encoding:identity",
    `content-type:${discovery ? "" : "application/x-git-upload-pack-request"}`,
    "git-protocol:version=2",
    "user-agent:oce-github-git-read",
    "connection:close",
    `body-bytes:${bodyBytes}`,
    `body-sha256:${bodySha256.slice(7)}`,
    "",
  ].join("\n");
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

// This protocol contains only flat objects of primitives. Reject all nesting,
// duplicate decoded keys, noninteger number syntax and trailing JSON before use.
function parseFlatJson(text: string): FlatObject | undefined {
  let offset = 0;
  const whitespace = () => {
    while (/[\t\r\n ]/.test(text[offset] ?? "x")) offset++;
  };
  const string = (): string | undefined => {
    if (text[offset] !== '"') return undefined;
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === "\\") {
        offset++;
        continue;
      }
      if (character === '"') return JSON.parse(text.slice(start, offset)) as string;
    }
    return undefined;
  };
  whitespace();
  if (text[offset++] !== "{") return undefined;
  const result = Object.create(null) as FlatObject;
  whitespace();
  if (text[offset] === "}") {
    offset++;
    whitespace();
    return offset === text.length ? result : undefined;
  }
  while (offset < text.length) {
    const key = string();
    if (key === undefined || Object.hasOwn(result, key)) return undefined;
    whitespace();
    if (text[offset++] !== ":") return undefined;
    whitespace();
    let value: FlatObject[string];
    if (text[offset] === '"') {
      const parsed = string();
      if (parsed === undefined) return undefined;
      value = parsed;
    } else {
      const start = offset;
      while (offset < text.length && !/[\t\r\n ,}]/.test(text[offset]!)) offset++;
      const literal = text.slice(start, offset);
      if (!/^(?:true|false|null|-?(?:0|[1-9][0-9]*))$/.test(literal)) return undefined;
      value = JSON.parse(literal) as FlatObject[string];
      if (typeof value === "number" && !Number.isSafeInteger(value)) return undefined;
    }
    result[key] = value;
    whitespace();
    if (text[offset] === "}") {
      offset++;
      whitespace();
      return offset === text.length ? result : undefined;
    }
    if (text[offset++] !== ",") return undefined;
    whitespace();
  }
  return undefined;
}

function validRequest(value: FlatObject, version: GitHubMediationVersion): boolean {
  if (value.version !== version || !correlation(value)) return false;
  if (value.method === "open-read") {
    return (
      exact(value, [
        ...C,
        "method",
        "attachment_ref",
        "repository_owner",
        "repository_name",
        "request_sha256",
        ...(version === 3 ? ["git_operation", "git_protocol", "body_bytes", "body_sha256"] : []),
      ]) &&
      value.sequence === 1 &&
      ref(value.attachment_ref) &&
      component(value.repository_owner) &&
      component(value.repository_name) &&
      (version === 2
        ? value.request_sha256 ===
          githubMetadataDigest(value.repository_owner, value.repository_name)
        : value.git_protocol === "version=2" &&
          value.request_sha256 ===
            githubGitReadDigest(
              value.repository_owner,
              value.repository_name,
              value.git_operation as GitReadOperation,
              value.body_bytes as number,
              value.body_sha256 as string,
            ))
    );
  }
  if (!binding(value)) return false;
  if (value.method === "dispatch-read")
    return (
      exact(value, [...B, "method", ...DNS, "peer_certificate_sha256"]) &&
      value.sequence === 2 &&
      dns(value) &&
      digest(value.peer_certificate_sha256)
    );
  if (value.method === "check-read")
    return (
      exact(value, [...B, "method", "release_ref"]) &&
      (value.sequence as number) >= 3 &&
      ref(value.release_ref)
    );
  if (value.method === "complete-read")
    return (
      exact(value, [...B, "method", "release_ref", "outcome"]) &&
      (value.sequence as number) >= 2 &&
      (value.release_ref === null || ref(value.release_ref)) &&
      ["not-dispatched", "completed", "unknown"].includes(value.outcome as string)
    );
  return false;
}

/** Metadata only. The transport owns the eight-byte frame and zero request-secret rule. */
export function decodeGitHubMediationRequest(
  bytes: Uint8Array,
): GitHubMediationRequest<2> | undefined;
export function decodeGitHubMediationRequest<V extends GitHubMediationVersion>(
  bytes: Uint8Array,
  version: V,
): GitHubMediationRequest<V> | undefined;
export function decodeGitHubMediationRequest(
  bytes: Uint8Array,
  version: GitHubMediationVersion = 2,
): GitHubMediationRequest<GitHubMediationVersion> | undefined {
  try {
    if ((version !== 2 && version !== 3) || types.isProxy(bytes) || !types.isUint8Array(bytes))
      return undefined;
    const length = typedArrayByteLength.call(bytes) as number;
    if (length === 0 || length > METADATA_LIMIT) return undefined;
    const value = parseFlatJson(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    return value && validRequest(value, version)
      ? (Object.freeze(value) as unknown as GitHubMediationRequest<GitHubMediationVersion>)
      : undefined;
  } catch {
    return undefined;
  }
}

function validReply(value: FlatObject): boolean {
  if (!correlation(value)) return false;
  if (value.ok === false)
    return (
      exact(value, [...C, "ok", "code"]) &&
      ["denied", "unavailable", "expired", "invalid"].includes(value.code as string)
    );
  if (value.ok !== true || !binding(value)) return false;
  if (value.phase === "recorded")
    return (
      exact(value, [...B, "ok", "phase", "release_ref"]) &&
      (value.sequence as number) >= 2 &&
      (value.release_ref === null || ref(value.release_ref))
    );
  if (!times(value)) return false;
  if (value.phase === "opened")
    return exact(value, [...B, ...T, "ok", "phase", ...DNS]) && value.sequence === 1 && dns(value);
  if (value.phase === "dispatch-once")
    return (
      exact(value, [...B, ...T, "ok", "phase", ...DNS, "peer_certificate_sha256", "release_ref"]) &&
      value.sequence === 2 &&
      dns(value) &&
      digest(value.peer_certificate_sha256) &&
      ref(value.release_ref)
    );
  if (value.phase === "current")
    return (
      exact(value, [...B, ...T, "ok", "phase", "release_ref"]) &&
      (value.sequence as number) >= 3 &&
      ref(value.release_ref)
    );
  return false;
}

/** Copies only validated own primitive data; never calls getters or toJSON. */
export function encodeGitHubMediationMetadata<V extends GitHubMediationVersion = 2>(
  reply: GitHubMediationReply<V>,
): Uint8Array {
  try {
    if (reply === null || typeof reply !== "object" || types.isProxy(reply)) throw new Error();
    const prototype = Object.getPrototypeOf(reply);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(reply);
    if (keys.length > 20) throw new Error();
    const value = Object.create(null) as FlatObject;
    for (const key of keys) {
      if (typeof key !== "string") throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(reply, key)!;
      if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new Error();
      const field: unknown = descriptor.value;
      if (
        field !== null &&
        typeof field !== "string" &&
        typeof field !== "number" &&
        typeof field !== "boolean"
      )
        throw new Error();
      value[key] = field;
    }
    if (!validReply(value)) throw new Error();
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.byteLength === 0 || bytes.byteLength > METADATA_LIMIT) throw new Error();
    return bytes;
  } catch {
    throw new Error("Invalid GitHub mediation metadata");
  }
}
