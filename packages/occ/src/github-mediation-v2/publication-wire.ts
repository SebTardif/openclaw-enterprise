import { createHash } from "node:crypto";
import {
  parsePublicationCandidateV1,
  parsePublicationEffectV1,
  parsePublicationEffectOutcomeV1,
  publicationCanonicalV1,
  publicationObjectV1,
  publicationReferenceV1,
  publicationRefuseV1,
  publicationSha256V1,
  publicationSnapshotV1,
  type PublicationCandidateV1,
  type PublicationEffectV1,
  type PublicationEffectOutcomeV1,
} from "../repository-publication-v1/contract.ts";

export const GITHUB_PUBLICATION_ALPN = "oce-github-publication-v1";
export const PUBLICATION_METADATA_BYTES = 262144;
export const PUBLICATION_PACK_BYTES = 83886080;
export const PUBLICATION_TOKEN_BYTES = 16384;
export const PUBLICATION_RESPONSE_BYTES = 1048576;

type C = Readonly<{ version: 1; sequence: number; session_ref: string }>;
type B = Readonly<{ call_ref: string; effect: PublicationEffectV1; action_digest: string }>;
type R = Readonly<{
  repository_owner: string;
  repository_name: string;
  dns_binding_ref: string;
  upstream_ipv4: string;
}>;
type P = Readonly<{
  request_sha256: string;
  body_sha256: string;
  body_bytes: number;
  peer_certificate_sha256: string;
}>;
type T = Readonly<{ server_time_ms: number; valid_until_ms: number; operation_until_ms: number }>;
export type GitHubPublicationRequestV1 =
  | (C & Readonly<{ method: "open-publication" }>)
  | (C & B & R & P & Readonly<{ method: "prepared-publication" }>)
  | (C & B & R & P & Readonly<{ method: "check-publication"; release_ref: string }>)
  | (C &
      B &
      Readonly<{
        method: "result-publication";
        release_ref: string | null;
        outcome: PublicationEffectOutcomeV1;
      }>);
export type GitHubPublicationReplyV1 =
  | (C & B & R & T & Readonly<{ ok: true; phase: "opened"; candidate: PublicationCandidateV1 }>)
  | (C &
      B &
      R &
      P &
      T &
      Readonly<{ ok: true; phase: "committed" | "current"; release_ref: string }>)
  | (C & B & Readonly<{ ok: true; phase: "recorded"; release_ref: string | null }>)
  | (C & Readonly<{ ok: false; code: "denied" | "cancelled" }>);
const CK = ["version", "sequence", "session_ref"];
const BK = ["call_ref", "effect", "action_digest"];
const RK = ["repository_owner", "repository_name", "dns_binding_ref", "upstream_ipv4"];
const PK = ["request_sha256", "body_sha256", "body_bytes", "peer_certificate_sha256"];
const TK = ["server_time_ms", "valid_until_ms", "operation_until_ms"];
const integer = (v: unknown, maximum: number, minimum = 0): v is number =>
  Number.isSafeInteger(v) && Number(v) >= minimum && Number(v) <= maximum;
function component(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= 255 &&
    /^[A-Za-z0-9_.-]+(?![\s\S])/.test(v) &&
    v !== "." &&
    v !== ".."
  );
}
function publicIpv4(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}(?![\s\S])/.test(value)
  )
    return false;
  const [a, b, c, d] = value.split(".").map(Number);
  if ([a, b, c, d].some((x) => x! > 255)) return false;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a! >= 224 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}
function common(o: Record<string, unknown>): void {
  if (
    o.version !== 1 ||
    !integer(o.sequence, 0xffffffff, 1) ||
    typeof o.session_ref !== "string" ||
    !/^[0-9a-f]{32}(?![\s\S])/.test(o.session_ref)
  )
    publicationRefuseV1();
}
function binding(o: Record<string, unknown>): void {
  const effect = parsePublicationEffectV1(o.effect);
  if (
    !publicationReferenceV1(o.call_ref) ||
    !publicationSha256V1(o.action_digest) ||
    o.action_digest !== effect.actionDigest
  )
    publicationRefuseV1();
}
// Native DNS/release references match the existing Rust broker predicate.
// Publication candidate/effect/call references keep their independent grammar.
function nativeReference(v: unknown): boolean {
  return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}(?![\s\S])/.test(v);
}
function route(o: Record<string, unknown>): void {
  if (
    !component(o.repository_owner) ||
    !component(o.repository_name) ||
    !nativeReference(o.dns_binding_ref) ||
    !publicIpv4(o.upstream_ipv4)
  )
    publicationRefuseV1();
}
function prepared(o: Record<string, unknown>): void {
  if (
    ![o.request_sha256, o.body_sha256, o.peer_certificate_sha256].every(publicationSha256V1) ||
    !integer(o.body_bytes, PUBLICATION_PACK_BYTES + 1024, 1)
  )
    publicationRefuseV1();
}
function times(o: Record<string, unknown>): void {
  if (
    ![o.server_time_ms, o.valid_until_ms, o.operation_until_ms].every((v) =>
      integer(v, 253402300799999),
    ) ||
    Number(o.server_time_ms) >= Number(o.valid_until_ms) ||
    Number(o.valid_until_ms) > Number(o.operation_until_ms)
  )
    publicationRefuseV1();
}
function release(v: unknown, nullable: boolean): void {
  if (!(nullable && v === null) && !nativeReference(v)) publicationRefuseV1();
}

/** Bounded duplicate-aware JSON decoder. JSON.parse alone loses duplicate key
 * evidence; the scanner also refuses noninteger number syntax and trailing data.
 * Nested original contract objects are revalidated separately after this scan. */
function json(bytes: Uint8Array): unknown {
  if (bytes.byteLength < 1 || bytes.byteLength > PUBLICATION_METADATA_BYTES) publicationRefuseV1();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return publicationRefuseV1();
  }
  let i = 0,
    nodes = 0;
  const white = () => {
    while (i < text.length && /[\x20\t\r\n]/.test(text[i]!)) i++;
  };
  const string = (): string => {
    if (text[i++] !== '"') publicationRefuseV1();
    const start = i - 1;
    let escaped = false;
    while (i < text.length) {
      const c = text[i++]!;
      if (!escaped && c === '"') {
        let value: string;
        try {
          value = JSON.parse(text.slice(start, i));
        } catch {
          return publicationRefuseV1();
        }
        for (let j = 0; j < value.length; j++) {
          const unit = value.charCodeAt(j);
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(++j);
            if (!(next >= 0xdc00 && next <= 0xdfff)) publicationRefuseV1();
          } else if (unit >= 0xdc00 && unit <= 0xdfff) publicationRefuseV1();
        }
        return value;
      }
      if (c.charCodeAt(0) < 0x20) publicationRefuseV1();
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
    }
    return publicationRefuseV1();
  };
  const value = (depth: number): unknown => {
    if (++nodes > 20000 || depth > 32) publicationRefuseV1();
    white();
    if (text[i] === '"') return string();
    if (text[i] === "{") {
      i++;
      white();
      const object: Record<string, unknown> = Object.create(null);
      if (text[i] === "}") {
        i++;
        return object;
      }
      while (true) {
        white();
        const key = string();
        white();
        if (key.length > 256 || Object.hasOwn(object, key) || text[i++] !== ":")
          publicationRefuseV1();
        object[key] = value(depth + 1);
        white();
        const next = text[i++];
        if (next === "}") return object;
        if (next !== ",") publicationRefuseV1();
      }
    }
    if (text[i] === "[") {
      i++;
      white();
      const array: unknown[] = [];
      if (text[i] === "]") {
        i++;
        return array;
      }
      while (true) {
        if (array.length >= 8192) publicationRefuseV1();
        array.push(value(depth + 1));
        white();
        const next = text[i++];
        if (next === "]") return array;
        if (next !== ",") publicationRefuseV1();
      }
    }
    for (const [literal, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return result;
      }
    }
    const matched = /^-?(?:0|[1-9][0-9]*)/.exec(text.slice(i));
    if (!matched) publicationRefuseV1();
    i += matched[0].length;
    const number = Number(matched[0]);
    if (!Number.isSafeInteger(number) || Object.is(number, -0)) publicationRefuseV1();
    return number;
  };
  const result = value(0);
  white();
  if (i !== text.length) publicationRefuseV1();
  return publicationSnapshotV1(result);
}

function validate(
  value: unknown,
  reply: boolean,
  payloadBytes: number,
): GitHubPublicationRequestV1 | GitHubPublicationReplyV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !integer(payloadBytes, PUBLICATION_PACK_BYTES)
  )
    publicationRefuseV1();
  const o = value as Record<string, unknown>;
  common(o);
  if (!reply) {
    if (payloadBytes !== 0) publicationRefuseV1();
    if (o.method === "open-publication") publicationObjectV1(o, [...CK, "method"]);
    else if (o.method === "prepared-publication" || o.method === "check-publication") {
      publicationObjectV1(o, [
        ...CK,
        "method",
        ...BK,
        ...RK,
        ...PK,
        ...(o.method === "check-publication" ? ["release_ref"] : []),
      ]);
      binding(o);
      route(o);
      prepared(o);
      if (o.method === "check-publication") release(o.release_ref, false);
    } else if (o.method === "result-publication") {
      publicationObjectV1(o, [...CK, "method", ...BK, "release_ref", "outcome"]);
      binding(o);
      release(o.release_ref, true);
      parsePublicationEffectOutcomeV1(o.outcome);
    } else publicationRefuseV1();
  } else if (o.ok === false) {
    publicationObjectV1(o, [...CK, "ok", "code"]);
    if (payloadBytes !== 0 || (o.code !== "denied" && o.code !== "cancelled"))
      publicationRefuseV1();
  } else {
    if (o.ok !== true) publicationRefuseV1();
    binding(o);
    if (o.phase === "opened") {
      publicationObjectV1(o, [...CK, "ok", "phase", ...BK, ...RK, ...TK, "candidate"]);
      route(o);
      times(o);
      const candidate = parsePublicationCandidateV1(o.candidate);
      const effect = parsePublicationEffectV1(o.effect);
      if (
        candidate.actionDigest !== o.action_digest ||
        candidate.graph.objectCount > 8192 ||
        candidate.graph.rawBytes > 67108864 ||
        candidate.graph.packBytes > PUBLICATION_PACK_BYTES ||
        (effect.kind === "push"
          ? payloadBytes !== candidate.graph.packBytes || payloadBytes < 32
          : payloadBytes !== 0)
      )
        publicationRefuseV1();
    } else if (o.phase === "committed" || o.phase === "current") {
      publicationObjectV1(o, [...CK, "ok", "phase", ...BK, ...RK, ...PK, ...TK, "release_ref"]);
      route(o);
      prepared(o);
      times(o);
      release(o.release_ref, false);
      if (
        o.phase === "committed"
          ? payloadBytes < 1 || payloadBytes > PUBLICATION_TOKEN_BYTES
          : payloadBytes !== 0
      )
        publicationRefuseV1();
    } else if (o.phase === "recorded") {
      publicationObjectV1(o, [...CK, "ok", "phase", ...BK, "release_ref"]);
      release(o.release_ref, true);
      if (payloadBytes !== 0) publicationRefuseV1();
    } else publicationRefuseV1();
  }
  return value as GitHubPublicationRequestV1 | GitHubPublicationReplyV1;
}
/** Validate both sizes before allocating a frame body. The receiver validates
 * the phase-specific suffix size again once its metadata has been decoded. */
export function decodeGitHubPublicationHeaderV1(header: Uint8Array): Readonly<{
  metadataBytes: number;
  payloadBytes: number;
}> {
  if (header.byteLength !== 8) publicationRefuseV1();
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const metadataBytes = view.getUint32(0),
    payloadBytes = view.getUint32(4);
  if (
    !integer(metadataBytes, PUBLICATION_METADATA_BYTES, 1) ||
    !integer(payloadBytes, PUBLICATION_PACK_BYTES)
  )
    publicationRefuseV1();
  return Object.freeze({ metadataBytes, payloadBytes });
}
export function decodeGitHubPublicationRequestV1(
  bytes: Uint8Array,
  payloadBytes = 0,
): GitHubPublicationRequestV1 {
  return validate(json(bytes), false, payloadBytes) as GitHubPublicationRequestV1;
}
export function decodeGitHubPublicationReplyV1(
  bytes: Uint8Array,
  payloadBytes: number,
): GitHubPublicationReplyV1 {
  return validate(json(bytes), true, payloadBytes) as GitHubPublicationReplyV1;
}
/** Encodes METADATA ONLY. The original native fixed writer owns any PACK/token
 * suffix and its lifetime. This function never accepts or returns credentials. */
export function encodeGitHubPublicationMetadataV1(
  value: GitHubPublicationRequestV1 | GitHubPublicationReplyV1,
  direction: "request" | "reply",
  payloadBytes = 0,
): Uint8Array {
  if (direction !== "request" && direction !== "reply") publicationRefuseV1();
  const fixed = publicationSnapshotV1(value);
  validate(fixed, direction === "reply", payloadBytes);
  const bytes = Buffer.from(publicationCanonicalV1(fixed), "utf8");
  if (bytes.length > PUBLICATION_METADATA_BYTES) publicationRefuseV1();
  // Match Rust's UTF-8/JSON Unicode restrictions also for escaped strings.
  json(bytes);
  return bytes;
}

/** Consumed by the dispatcher after ORIGINAL custodian recognition. Bytes and
 * hashes alone do not supply graph provenance or independent ancestry proof. */
export function verifyGitHubPublicationPackV1(
  candidate: PublicationCandidateV1,
  pack: Uint8Array,
): void {
  if (
    pack.byteLength < 32 ||
    pack.byteLength > PUBLICATION_PACK_BYTES ||
    pack.byteLength !== candidate.graph.packBytes ||
    candidate.graph.objectCount > 8192 ||
    candidate.graph.rawBytes > 67108864 ||
    "sha256:" + createHash("sha256").update(pack).digest("hex") !== candidate.graph.packSha256
  )
    publicationRefuseV1();
}

/** Pure comparison commitment for the native owner and paired Rust consumer.
 * owner/name must come from the original current registry, never caller URLs. */
export function githubPublicationRequestDigestV1(
  candidate: PublicationCandidateV1,
  effect: PublicationEffectV1,
  owner: string,
  name: string,
  bodySha256: string,
  bodyBytes: number,
): string {
  const c = parsePublicationCandidateV1(candidate),
    e = parsePublicationEffectV1(effect);
  if (
    c.actionDigest !== e.actionDigest ||
    !component(owner) ||
    !component(name) ||
    !publicationSha256V1(bodySha256) ||
    !integer(bodyBytes, PUBLICATION_PACK_BYTES + 1024, 1)
  )
    publicationRefuseV1();
  const push = e.kind === "push";
  const lines = [
    "oce.github.publication.v1",
    e.kind,
    "POST",
    "https",
    push ? "github.com" : "api.github.com",
    "443",
    push ? `/${owner}/${name}.git/git-receive-pack` : `/repos/${owner}/${name}/pulls`,
    "accept:" + (push ? "application/x-git-receive-pack-result" : "application/vnd.github+json"),
    "accept-encoding:identity",
    "content-type:" + (push ? "application/x-git-receive-pack-request" : "application/json"),
    "x-github-api-version:" + (push ? "" : "2022-11-28"),
    "user-agent:oce-github-publication",
    "connection:close",
    "body-bytes:" + bodyBytes,
    "body-sha256:" + bodySha256.slice(7),
  ];
  return (
    "sha256:" +
    createHash("sha256")
      .update(lines.join("\n") + "\n", "utf8")
      .digest("hex")
  );
}
