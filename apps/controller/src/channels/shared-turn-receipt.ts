import { createHash } from "node:crypto";
import { types } from "node:util";

const referenceFields = [
  "installationRef",
  "channelInstallationRef",
  "providerTenantRef",
  "recipientAppRef",
  "normalizationProfileRef",
  "providerEventRef",
  "providerMessageRef",
  "providerSubjectRef",
  "channelRef",
  "rootThreadRef",
] as const;
const inputFields = [
  "schemaVersion",
  "platform",
  ...referenceFields,
  "eventDigest",
  "contentDigest",
] as const;
const identityFields = [...inputFields, "eventKey", "logicalMessageKey"] as const;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

export type ReceiptIdentityV1 = Readonly<
  Record<(typeof referenceFields)[number], string> & {
    schemaVersion: 1;
    platform: "slack" | "msteams";
    eventDigest: string;
    contentDigest: string;
    eventKey: string;
    logicalMessageKey: string;
  }
>;
export type InvalidReceipt = Readonly<{
  kind: "invalid";
  reason: "identity" | "snapshot" | "snapshot-key";
}>;
export type ReceiptSnapshotV1 = Readonly<
  {
    identity: ReceiptIdentityV1;
    ownerReceiptRef: string;
  } & (
    | { disposition: "accepted"; turnRef: string }
    | { disposition: "pending" | "busy" | "denied" | "ignored" }
  )
>;
export type ReceiptClassificationV1 =
  | InvalidReceipt
  | Readonly<{ kind: "new-candidate" }>
  | Readonly<{ kind: "existing-pending"; ownerReceiptRef: string }>
  | Readonly<
      { kind: "duplicate"; ownerReceiptRef: string } & (
        | { disposition: "accepted"; turnRef: string }
        | { disposition: "busy" | "denied" | "ignored" }
      )
    >
  | Readonly<{
      kind: "conflict";
      reason: "event-binding" | "logical-binding" | "owner" | "decision";
    }>;

function invalid(reason: InvalidReceipt["reason"]): InvalidReceipt {
  return Object.freeze({ kind: "invalid", reason });
}

// Inspect descriptors, never property values through getters. Reject proxies before
// introspection so even hostile getPrototypeOf/ownKeys traps cannot execute.
function dataRecord(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || types.isProxy(input)) return undefined;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(input);
  if (keys.length > allowed.length) return undefined;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function reference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    Buffer.byteLength(value, "utf8") <= 1024
  );
}
function digest(value: unknown): value is string {
  return typeof value === "string" && value.length === 71 && digestPattern.test(value);
}
function key(parts: readonly string[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex")}`;
}

/** Validates normalized data, not provider authentication or payload digests. */
export function parseReceiptIdentityV1(input: unknown): ReceiptIdentityV1 | InvalidReceipt {
  const record = dataRecord(input, inputFields);
  if (
    !record ||
    Object.keys(record).length !== inputFields.length ||
    record.schemaVersion !== 1 ||
    (record.platform !== "slack" && record.platform !== "msteams") ||
    !digest(record.eventDigest) ||
    !digest(record.contentDigest) ||
    !referenceFields.every((field) => reference(record[field]))
  )
    return invalid("identity");
  const refs = Object.fromEntries(referenceFields.map((field) => [field, record[field]])) as Record<
    (typeof referenceFields)[number],
    string
  >;
  const scope = [
    refs.installationRef,
    refs.channelInstallationRef,
    record.platform,
    refs.providerTenantRef,
    refs.recipientAppRef,
  ];
  return Object.freeze({
    schemaVersion: 1,
    ...refs,
    platform: record.platform,
    eventDigest: record.eventDigest,
    contentDigest: record.contentDigest,
    eventKey: key(["oce.shared-turn.event.v1", ...scope, refs.providerEventRef]),
    logicalMessageKey: key([
      "oce.shared-turn.message.v1",
      ...scope,
      refs.channelRef,
      refs.providerMessageRef,
    ]),
  });
}

function normalizedIdentity(input: unknown): ReceiptIdentityV1 | undefined {
  const record = dataRecord(input, identityFields);
  if (!record || Object.keys(record).length !== identityFields.length) return undefined;
  const parsed = parseReceiptIdentityV1(
    Object.fromEntries(inputFields.map((field) => [field, record[field]])),
  );
  if (
    "kind" in parsed ||
    parsed.eventKey !== record.eventKey ||
    parsed.logicalMessageKey !== record.logicalMessageKey
  )
    return undefined;
  return parsed;
}

function snapshot(input: unknown): ReceiptSnapshotV1 | undefined {
  const record = dataRecord(input, ["identity", "ownerReceiptRef", "disposition", "turnRef"]);
  if (!record || !reference(record.ownerReceiptRef)) return undefined;
  const identity = normalizedIdentity(record.identity);
  if (!identity) return undefined;
  if (record.disposition === "accepted") {
    if (Object.keys(record).length !== 4 || !reference(record.turnRef)) return undefined;
    return Object.freeze({
      identity,
      ownerReceiptRef: record.ownerReceiptRef,
      disposition: "accepted",
      turnRef: record.turnRef,
    });
  }
  if (
    Object.keys(record).length !== 3 ||
    (record.disposition !== "pending" &&
      record.disposition !== "busy" &&
      record.disposition !== "denied" &&
      record.disposition !== "ignored")
  )
    return undefined;
  return Object.freeze({
    identity,
    ownerReceiptRef: record.ownerReceiptRef,
    disposition: record.disposition,
  });
}

function sameBinding(left: ReceiptIdentityV1, right: ReceiptIdentityV1): boolean {
  return (
    left.logicalMessageKey === right.logicalMessageKey &&
    left.normalizationProfileRef === right.normalizationProfileRef &&
    left.providerSubjectRef === right.providerSubjectRef &&
    left.channelRef === right.channelRef &&
    left.rootThreadRef === right.rootThreadRef &&
    left.contentDigest === right.contentDigest
  );
}
function conflict(
  reason: Extract<ReceiptClassificationV1, { kind: "conflict" }>["reason"],
): ReceiptClassificationV1 {
  return Object.freeze({ kind: "conflict", reason });
}

/** Classifies caller-supplied exact-key history; does not reserve or authorize work. */
export function classifyReceiptV1(
  incoming: unknown,
  eventSnapshot?: unknown,
  logicalSnapshot?: unknown,
): ReceiptClassificationV1 {
  const identity = normalizedIdentity(incoming);
  if (!identity) return invalid("identity");
  const event = eventSnapshot === undefined ? undefined : snapshot(eventSnapshot);
  const logical = logicalSnapshot === undefined ? undefined : snapshot(logicalSnapshot);
  if ((eventSnapshot !== undefined && !event) || (logicalSnapshot !== undefined && !logical))
    return invalid("snapshot");
  if (
    (event && event.identity.eventKey !== identity.eventKey) ||
    (logical && logical.identity.logicalMessageKey !== identity.logicalMessageKey)
  )
    return invalid("snapshot-key");
  if (
    event &&
    (!sameBinding(identity, event.identity) || identity.eventDigest !== event.identity.eventDigest)
  )
    return conflict("event-binding");
  if (logical && !sameBinding(identity, logical.identity)) return conflict("logical-binding");
  // A logical lookup can itself carry this exact event, whose digest must agree.
  if (
    logical &&
    logical.identity.eventKey === identity.eventKey &&
    logical.identity.eventDigest !== identity.eventDigest
  )
    return conflict("event-binding");
  if (event && logical) {
    if (event.ownerReceiptRef !== logical.ownerReceiptRef) return conflict("owner");
    if (
      event.disposition !== logical.disposition ||
      (event.disposition === "accepted" &&
        logical.disposition === "accepted" &&
        event.turnRef !== logical.turnRef)
    )
      return conflict("decision");
  }
  const existing = event ?? logical;
  if (!existing) return Object.freeze({ kind: "new-candidate" });
  if (existing.disposition === "pending")
    return Object.freeze({ kind: "existing-pending", ownerReceiptRef: existing.ownerReceiptRef });
  if (existing.disposition === "accepted")
    return Object.freeze({
      kind: "duplicate",
      ownerReceiptRef: existing.ownerReceiptRef,
      disposition: "accepted",
      turnRef: existing.turnRef,
    });
  return Object.freeze({
    kind: "duplicate",
    ownerReceiptRef: existing.ownerReceiptRef,
    disposition: existing.disposition,
  });
}
