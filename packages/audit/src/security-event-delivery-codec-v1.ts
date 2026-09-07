import { createHash } from "node:crypto";
import { serializeSecurityEvent } from "@openclaw-enterprise/contracts/security-events";

export const SECURITY_DELIVERY_LIMITS_V1 = Object.freeze({
  requestBytes: 16384,
  responseBytes: 1024,
  eventBytes: 8192,
  globalInFlight: 64,
  ownerInFlight: 8,
  inFlightBytes: 1048576,
  deadlineMs: 2000,
  recoveryRounds: 5,
  recoveryDelaysMs: Object.freeze([1000, 2000, 4000, 8000]),
});
export interface SecurityEventKeyV1 {
  readonly installationId: string;
  readonly eventId: string;
}
export interface SecurityEventAppendV1 {
  readonly version: 1;
  readonly key: SecurityEventKeyV1;
  readonly producerInstanceRef: string;
  readonly producerSequence: number;
  readonly obligationRef: string;
  readonly canonicalEventUtf8: string;
  readonly eventDigest: string;
}
export const SECURITY_DELIVERY_REFUSALS_V1 = [
  "InvalidRecord",
  "WrongProducerScope",
  "Capacity",
  "Conflict",
  "RetiredProducer",
  "UnavailableBeforeCommit",
] as const;
export const SECURITY_DELIVERY_UNKNOWNS_V1 = [
  "Deadline",
  "TransportLost",
  "StorageUnknown",
  "Interrupted",
  "ReadbackUnavailable",
] as const;
export type SecurityDeliveryRefusalV1 = (typeof SECURITY_DELIVERY_REFUSALS_V1)[number];
export type SecurityDeliveryUnknownV1 = (typeof SECURITY_DELIVERY_UNKNOWNS_V1)[number];
export interface SecurityEventCommittedV1 {
  readonly kind: "Committed";
  readonly key: SecurityEventKeyV1;
  readonly eventDigest: string;
  readonly commitReceiptRef: string;
}
export type SecurityEventAppendResultV1 =
  | SecurityEventCommittedV1
  | {
      readonly kind: "RefusedBeforeCommit";
      readonly key: SecurityEventKeyV1;
      readonly code: SecurityDeliveryRefusalV1;
    }
  | {
      readonly kind: "CommitUnknown";
      readonly key: SecurityEventKeyV1;
      readonly code: SecurityDeliveryUnknownV1;
    };
export type SecurityEventLookupResultV1 =
  | SecurityEventCommittedV1
  | {
      readonly kind: "AbsentFenced";
      readonly key: SecurityEventKeyV1;
      readonly fencedAttemptRef: string;
    }
  | { readonly kind: "Conflict"; readonly key: SecurityEventKeyV1 }
  | {
      readonly kind: "Unknown";
      readonly key: SecurityEventKeyV1;
      readonly code: SecurityDeliveryUnknownV1;
    };

export class SecurityDeliveryContractErrorV1 extends Error {
  readonly code = "SECURITY_DELIVERY_REJECTED";
  constructor() {
    super("Security event delivery record rejected.");
    this.name = "SecurityDeliveryContractErrorV1";
  }
}
function reject(): never {
  throw new SecurityDeliveryContractErrorV1();
}
// Exact bounded reference predicate from the existing SecurityEventV1 codec.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function securityDeliveryReferenceV1(value: unknown): string {
  return typeof value === "string" && uuid.test(value) ? value : reject();
}
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return reject();
  const names = Object.keys(input);
  if (names.length !== keys.length || names.some((key) => !keys.includes(key))) return reject();
  return input as Record<string, unknown>;
}
function key(input: unknown): SecurityEventKeyV1 {
  const value = object(input, ["installationId", "eventId"]);
  return Object.freeze({
    installationId: securityDeliveryReferenceV1(value.installationId),
    eventId: securityDeliveryReferenceV1(value.eventId),
  });
}
export function securityEventDigestV1(canonicalEventUtf8: string): string {
  return `sha256:${createHash("sha256").update(canonicalEventUtf8, "utf8").digest("hex")}`;
}

/** Bounded JSON with decoded-key duplicate rejection, before object construction. */
function strictJson(input: unknown, maxBytes: number, maxDepth: number): unknown {
  if (
    typeof input !== "string" ||
    input.length > maxBytes ||
    Buffer.byteLength(input, "utf8") > maxBytes
  )
    return reject();
  const text = input;
  let at = 0;
  const space = () => {
    while (/[\x20\t\r\n]/.test(text[at] ?? "!")) at++;
  };
  function string(): string {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === "\\") {
        at++;
        continue;
      }
      if (char === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    return reject();
  }
  function value(depth: number): void {
    if (depth > maxDepth) return reject();
    space();
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === "{") {
      at++;
      space();
      const seen = new Set<string>();
      if (text[at] === "}") {
        at++;
        return;
      }
      while (at < text.length) {
        if (text[at] !== '"') return reject();
        const name = string();
        if (seen.has(name)) return reject();
        seen.add(name);
        space();
        if (text[at++] !== ":") return reject();
        value(depth + 1);
        space();
        const separator = text[at++];
        if (separator === "}") return;
        if (separator !== ",") return reject();
        space();
      }
      return reject();
    }
    if (text[at] === "[") {
      at++;
      space();
      if (text[at] === "]") {
        at++;
        return;
      }
      while (at < text.length) {
        value(depth + 1);
        space();
        const separator = text[at++];
        if (separator === "]") return;
        if (separator !== ",") return reject();
      }
      return reject();
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      text.slice(at),
    );
    if (!token) return reject();
    at += token[0].length;
  }
  try {
    value(1);
    space();
    if (at !== text.length) return reject();
    return JSON.parse(text);
  } catch {
    return reject();
  }
}

export function decodeSecurityEventAppendV1(input: string): Readonly<SecurityEventAppendV1> {
  try {
    const value = object(strictJson(input, SECURITY_DELIVERY_LIMITS_V1.requestBytes, 8), [
      "version",
      "key",
      "producerInstanceRef",
      "producerSequence",
      "obligationRef",
      "canonicalEventUtf8",
      "eventDigest",
    ]);
    const eventKey = key(value.key);
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.producerSequence) ||
      (value.producerSequence as number) < 1 ||
      typeof value.canonicalEventUtf8 !== "string"
    )
      return reject();
    const event = strictJson(value.canonicalEventUtf8, SECURITY_DELIVERY_LIMITS_V1.eventBytes, 6);
    const canonical = serializeSecurityEvent(event);
    const eventFields = event as Record<string, unknown>;
    if (
      canonical !== value.canonicalEventUtf8 ||
      eventFields.id !== eventKey.eventId ||
      eventFields.installationId !== eventKey.installationId ||
      securityEventDigestV1(canonical) !== value.eventDigest
    )
      return reject();
    return Object.freeze({
      version: 1,
      key: eventKey,
      producerInstanceRef: securityDeliveryReferenceV1(value.producerInstanceRef),
      producerSequence: value.producerSequence as number,
      obligationRef: securityDeliveryReferenceV1(value.obligationRef),
      canonicalEventUtf8: canonical,
      eventDigest: value.eventDigest as string,
    });
  } catch {
    return reject();
  }
}

/** This takes already bounded in-process values; untrusted wire input uses decode. */
export function encodeSecurityEventAppendV1(input: SecurityEventAppendV1): string {
  return JSON.stringify(decodeSecurityEventAppendV1(JSON.stringify(input)));
}

function result(
  input: string,
  lookup: boolean,
): SecurityEventAppendResultV1 | SecurityEventLookupResultV1 {
  const value = strictJson(input, SECURITY_DELIVERY_LIMITS_V1.responseBytes, 3);
  if (!value || typeof value !== "object") return reject();
  const tag = (value as Record<string, unknown>).kind;
  const fields =
    tag === "Committed"
      ? ["kind", "key", "eventDigest", "commitReceiptRef"]
      : tag === "AbsentFenced"
        ? ["kind", "key", "fencedAttemptRef"]
        : tag === "Conflict"
          ? ["kind", "key"]
          : ["kind", "key", "code"];
  const item = object(value, fields);
  const eventKey = key(item.key);
  if (tag === "Committed") {
    if (typeof item.eventDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item.eventDigest))
      return reject();
    return Object.freeze({
      kind: tag,
      key: eventKey,
      eventDigest: item.eventDigest,
      commitReceiptRef: securityDeliveryReferenceV1(item.commitReceiptRef),
    });
  }
  if (lookup && tag === "AbsentFenced")
    return Object.freeze({
      kind: tag,
      key: eventKey,
      fencedAttemptRef: securityDeliveryReferenceV1(item.fencedAttemptRef),
    });
  if (lookup && tag === "Conflict") return Object.freeze({ kind: tag, key: eventKey });
  if (
    !lookup &&
    tag === "RefusedBeforeCommit" &&
    SECURITY_DELIVERY_REFUSALS_V1.some((code) => code === item.code)
  )
    return Object.freeze({
      kind: tag,
      key: eventKey,
      code: item.code as SecurityDeliveryRefusalV1,
    });
  if (
    ((lookup && tag === "Unknown") || (!lookup && tag === "CommitUnknown")) &&
    SECURITY_DELIVERY_UNKNOWNS_V1.some((code) => code === item.code)
  )
    return Object.freeze({
      kind: tag as "Unknown" | "CommitUnknown",
      key: eventKey,
      code: item.code as SecurityDeliveryUnknownV1,
    });
  return reject();
}
export function decodeSecurityEventAppendResultV1(input: string): SecurityEventAppendResultV1 {
  return result(input, false) as SecurityEventAppendResultV1;
}
export function decodeSecurityEventLookupResultV1(input: string): SecurityEventLookupResultV1 {
  return result(input, true) as SecurityEventLookupResultV1;
}
