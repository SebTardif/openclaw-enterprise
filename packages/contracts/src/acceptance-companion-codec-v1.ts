import { createHash } from "node:crypto";
import { types } from "node:util";
import { Check } from "typebox/value";
import {
  ACCEPTANCE_DEMOS_V1,
  ACCEPTANCE_HANDOFFS_V1,
  ACCEPTANCE_LEAVES_V1,
  ACCEPTANCE_LIMITS_V1,
  ACCEPTANCE_VECTORS_V1,
  AcceptanceDigestDomainsV1,
  AssertionCompanionSchemaV1,
  ProducerReceiptSchemaV1,
  type AcceptanceDigestDomainV1,
  type AcceptanceDigestV1,
  type AssertionCompanionV1,
  type ProducerReceiptV1,
} from "./acceptance-companion-v1.ts";

export type AcceptanceDecodeErrorV1 =
  | "invalid-input"
  | "too-large"
  | "invalid-utf8"
  | "invalid-json"
  | "duplicate-key"
  | "limit-exceeded"
  | "unsupported-version"
  | "schema-mismatch"
  | "invalid-shape"
  | "metadata-mismatch"
  | "inconsistent-receipt"
  | "binding-mismatch";
export type AcceptanceDecodeFailureV1 = Readonly<{ ok: false; code: AcceptanceDecodeErrorV1 }>;
export type AcceptanceReadonlyV1<T> = T extends object
  ? { readonly [P in keyof T]: AcceptanceReadonlyV1<T[P]> }
  : T;
export type AcceptanceDecodedV1<T, D extends "companion" | "receipt"> = Readonly<{
  ok: true;
  value: AcceptanceReadonlyV1<T>;
  identity: AcceptanceDigestV1<D>;
  authentication: "unverified";
  /** Returns an independent copy of the retained input; never a reserialization. */
  originalBytes: () => Uint8Array;
}>;
export type AcceptanceDecodeResultV1<T, D extends "companion" | "receipt"> =
  AcceptanceDecodedV1<T, D> | AcceptanceDecodeFailureV1;

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
/** Schema identity includes the closed catalog and handoff meanings, in this fixed order. */
const catalog = {
  leaves: ACCEPTANCE_LEAVES_V1,
  demonstrations: ACCEPTANCE_DEMOS_V1,
  vectors: ACCEPTANCE_VECTORS_V1,
  handoffs: ACCEPTANCE_HANDOFFS_V1,
};
export const ACCEPTANCE_SCHEMA_DIGESTS_V1 = Object.freeze({
  companion: hash(JSON.stringify({ schema: AssertionCompanionSchemaV1, catalog })),
  receipt: hash(JSON.stringify({ schema: ProducerReceiptSchemaV1, catalog })),
});

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
function snapshot(input: unknown, limit: number): Uint8Array {
  if (!types.isUint8Array(input) || types.isProxy(input)) throw "invalid-input";
  const length = byteLengthGetter.call(input) as number;
  if (length > limit) throw "too-large";
  if (length === 0) throw "invalid-input";
  const buffer = bufferGetter.call(input) as ArrayBuffer;
  if (types.isSharedArrayBuffer(buffer)) throw "invalid-input";
  const offset = byteOffsetGetter.call(input) as number;
  // Read internal typed-array slots, never caller-defined iterators/accessors/species.
  return new Uint8Array(new Uint8Array(buffer, offset, length));
}

/** SHA-256 of original bytes. Domains are mandatory labels, never inferred or interchanged. */
export function digestAcceptanceBytesV1<D extends AcceptanceDigestDomainV1>(
  domain: D,
  input: Uint8Array,
): AcceptanceDigestV1<D> {
  if (!AcceptanceDigestDomainsV1.includes(domain)) throw new TypeError("invalid-digest-domain");
  const bytes = snapshot(input, ACCEPTANCE_LIMITS_V1.maxReferencedArtifactBytes);
  return Object.freeze({ domain, sha256: hash(bytes), byteLength: bytes.byteLength });
}

/** Preflight JSON before materializing its object graph, including duplicate decoded keys. */
function parseBounded(text: string): unknown {
  let cursor = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[cursor] ?? "!")) cursor++;
  };
  function string(): string {
    const start = cursor++;
    for (;;) {
      const char = text[cursor++];
      if (char === undefined) throw "invalid-json";
      if (char === "\\") {
        if (text[cursor++] === undefined) throw "invalid-json";
      } else if (char === '"') {
        try {
          return JSON.parse(text.slice(start, cursor)) as string;
        } catch {
          throw "invalid-json";
        }
      }
    }
  }
  function value(depth: number): void {
    if (depth > ACCEPTANCE_LIMITS_V1.maxDepth || ++nodes > ACCEPTANCE_LIMITS_V1.maxNodes)
      throw "limit-exceeded";
    whitespace();
    const char = text[cursor];
    if (char === '"') {
      string();
      return;
    }
    if (char === "{" || char === "[") {
      cursor++;
      const close = char === "{" ? "}" : "]";
      const seen = new Set<string>();
      let count = 0;
      whitespace();
      if (text[cursor] === close) {
        cursor++;
        return;
      }
      for (;;) {
        if (++count > ACCEPTANCE_LIMITS_V1.maxContainerEntries) throw "limit-exceeded";
        if (char === "{") {
          whitespace();
          if (text[cursor] !== '"') throw "invalid-json";
          const key = string();
          if (seen.has(key)) throw "duplicate-key";
          seen.add(key);
          whitespace();
          if (text[cursor++] !== ":") throw "invalid-json";
        }
        value(depth + 1);
        whitespace();
        const delimiter = text[cursor++];
        if (delimiter === close) return;
        if (delimiter !== ",") throw "invalid-json";
      }
    }
    const token = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
    token.lastIndex = cursor;
    const match = token.exec(text);
    if (match === null) throw "invalid-json";
    cursor = token.lastIndex;
    if (!Number.isFinite(Number(match[0])) && !["true", "false", "null"].includes(match[0]))
      throw "invalid-json";
  }
  value(1);
  whitespace();
  if (cursor !== text.length) throw "invalid-json";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw "invalid-json";
  }
}
function freeze<T>(value: T): AcceptanceReadonlyV1<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as AcceptanceReadonlyV1<T>;
}
const equalSet = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length &&
  new Set(actual).size === actual.length &&
  actual.every((id) => expected.includes(id));
const equalDigest = (a: AcceptanceDigestV1, b: AcceptanceDigestV1) =>
  a.domain === b.domain && a.sha256 === b.sha256 && a.byteLength === b.byteLength;
const time = (value: string): number => {
  const number = Date.parse(value);
  if (!Number.isFinite(number) || new Date(number).toISOString() !== value)
    throw "inconsistent-receipt";
  return number;
};

function companionMetadata(value: AssertionCompanionV1): void {
  const leaf = ACCEPTANCE_LEAVES_V1[value.leaf.id];
  if (
    value.leaf.parentCaseId !== leaf.parentCaseId ||
    value.leaf.parentAssertionId !== leaf.parentAssertionId ||
    value.leaf.primaryProducer !== leaf.producer ||
    value.leaf.channel !== leaf.channel ||
    value.leaf.required !== leaf.required
  )
    throw "metadata-mismatch";
  if (
    !equalSet(
      value.demoApplicability.map((demo) => demo.demoCaseId),
      Object.keys(ACCEPTANCE_DEMOS_V1),
    )
  )
    throw "metadata-mismatch";
  for (const demo of value.demoApplicability) {
    if (
      demo.applicability !== ACCEPTANCE_DEMOS_V1[demo.demoCaseId].applicability ||
      (demo.applicability === "not_applicable" && demo.review === null)
    )
      throw "metadata-mismatch";
  }
  if (
    !equalSet(
      value.demonstrations.map((demo) => demo.demoCaseId),
      leaf.demoCaseIds,
    )
  )
    throw "metadata-mismatch";
  const expectedVectors = Object.entries(ACCEPTANCE_VECTORS_V1)
    .filter(([, vector]) => (vector.assertionIds as readonly string[]).includes(value.leaf.id))
    .map(([id]) => id);
  if (
    !equalSet(
      value.vectors.map((vector) => vector.vectorId),
      expectedVectors,
    )
  )
    throw "metadata-mismatch";
  for (const demo of value.demonstrations) {
    if (demo.applicability !== ACCEPTANCE_DEMOS_V1[demo.demoCaseId].applicability)
      throw "metadata-mismatch";
    if (demo.applicability === "required" && demo.substeps.length === 0) throw "metadata-mismatch";
    if (
      demo.applicability === "not_applicable" &&
      (demo.applicabilityEvidence === null || demo.substeps.length !== 0)
    )
      throw "metadata-mismatch";
    if (
      new Set(demo.substeps.map((step) => step.substepId)).size !== demo.substeps.length ||
      demo.substeps.some((step, index) => step.order !== index + 1)
    )
      throw "metadata-mismatch";
  }
  for (const vector of value.vectors) {
    const expected = ACCEPTANCE_VECTORS_V1[vector.vectorId];
    if (
      vector.contract !== expected.contract ||
      !equalSet(vector.requiredByGates, expected.requiredByGates)
    )
      throw "metadata-mismatch";
    if (
      new Set(vector.subchecks.map((check) => check.subcheckId)).size !== vector.subchecks.length ||
      !["stimulus", "requiredResult", "sourceProofLane"].every((slot) =>
        vector.subchecks.some((check) => check.slot === slot),
      )
    )
      throw "metadata-mismatch";
  }
}

function checkKey(
  subject: AcceptanceReadonlyV1<ProducerReceiptV1["checks"][number]["subject"]>,
): string {
  if (subject.kind === "leaf") return `leaf:${subject.leafId}`;
  if (subject.kind === "demo-substep") return `demo:${subject.demoCaseId}:${subject.substepId}`;
  return `vector:${subject.vectorId}:${subject.subcheckId}`;
}

function receiptConsistency(value: ProducerReceiptV1): void {
  const leaf = ACCEPTANCE_LEAVES_V1[value.leafId];
  if (value.role === "primary" && value.producer !== leaf.producer) throw "metadata-mismatch";
  if (value.role === "supporting" && value.producer !== "P-AUD" && value.producer !== "P-UPS")
    throw "metadata-mismatch";
  const received = time(value.receivedAt);
  if (time(value.custody.retainedUntil) < received) throw "inconsistent-receipt";
  if (
    value.collection === "missing" &&
    (value.outcome !== null ||
      value.result.state !== "missing" ||
      value.execution.state !== "unrun" ||
      value.checks.length !== 0 ||
      value.observations.length !== 0 ||
      value.review.state !== "missing")
  )
    throw "inconsistent-receipt";
  if (value.collection !== "missing" && value.outcome === null) throw "inconsistent-receipt";
  // A missing result is not an omitted outcome or a claimed successful execution.
  if (
    (value.outcome === "pass" || value.outcome === "fail") &&
    (value.result.state !== "present" || value.execution.state !== "observed")
  )
    throw "inconsistent-receipt";
  if (
    (value.outcome === "unrun" || value.outcome === "skipped") &&
    value.execution.state !== "unrun"
  )
    throw "inconsistent-receipt";
  if (
    value.execution.state === "end-unavailable" &&
    value.outcome !== "unknown" &&
    value.outcome !== "blocked"
  )
    throw "inconsistent-receipt";
  if (value.outcome === "not_applicable" && leaf.required) throw "metadata-mismatch";
  if (value.execution.state !== "unrun") {
    if (value.procedure.state !== "frozen") throw "inconsistent-receipt";
    const start = time(value.execution.started.observedAt);
    if (value.execution.state === "observed") {
      const end = time(value.execution.ended.observedAt);
      // Different clocks retain uncertainty; their wall values cannot establish ordering.
      if (
        value.execution.started.clockRef === value.execution.ended.clockRef &&
        end + value.execution.ended.uncertaintyMs < start - value.execution.started.uncertaintyMs
      )
        throw "inconsistent-receipt";
    }
  }
  const subjects = new Set<string>();
  for (const check of value.checks) {
    const key = checkKey(check.subject);
    if (subjects.has(key)) throw "inconsistent-receipt";
    subjects.add(key);
    if (check.subject.kind === "leaf" && check.subject.leafId !== value.leafId)
      throw "metadata-mismatch";
    if (
      check.subject.kind === "demo-substep" &&
      !(leaf.demoCaseIds as readonly string[]).includes(check.subject.demoCaseId)
    )
      throw "metadata-mismatch";
    if (
      check.subject.kind === "vector-subcheck" &&
      !(ACCEPTANCE_VECTORS_V1[check.subject.vectorId].assertionIds as readonly string[]).includes(
        value.leafId,
      )
    )
      throw "metadata-mismatch";
    if (check.outcome === "not_applicable") throw "metadata-mismatch";
    if ((check.outcome === "pass" || check.outcome === "fail") && check.evidence === null)
      throw "inconsistent-receipt";
  }
  for (const observation of value.observations) {
    time(observation.clock.observedAt);
    if (
      (observation.state === "confirmed" || observation.state === "denied") &&
      observation.evidence === null
    )
      throw "inconsistent-receipt";
  }
  if (value.review.state === "recorded") {
    if (
      value.result.state !== "present" ||
      !equalDigest(value.review.inputManifest, value.inputManifest) ||
      !equalDigest(value.review.result, value.result.digest)
    )
      throw "inconsistent-receipt";
    if (
      value.execution.state !== "unrun" &&
      value.review.reviewerRef === value.execution.executorRef
    )
      throw "inconsistent-receipt";
    if (value.review.disposition === "accepted" && value.review.unresolvedFindings.length !== 0)
      throw "inconsistent-receipt";
  }
  if (value.custody.redaction === "complete" && value.custody.redactionEvidence === null)
    throw "inconsistent-receipt";
  if (
    value.invalidation.state === "invalidated" &&
    equalDigest(value.invalidation.replacementInput, value.inputManifest)
  )
    throw "inconsistent-receipt";
  if (value.reuse !== null) time(value.reuse.originalObservedAt);
}

const errors = new Set<AcceptanceDecodeErrorV1>([
  "invalid-input",
  "too-large",
  "invalid-utf8",
  "invalid-json",
  "duplicate-key",
  "limit-exceeded",
  "unsupported-version",
  "schema-mismatch",
  "invalid-shape",
  "metadata-mismatch",
  "inconsistent-receipt",
  "binding-mismatch",
]);
function decode<
  T extends AssertionCompanionV1 | ProducerReceiptV1,
  D extends "companion" | "receipt",
>(
  input: unknown,
  domain: D,
  version: string,
  schema: typeof AssertionCompanionSchemaV1 | typeof ProducerReceiptSchemaV1,
  validate: (value: T) => void,
): AcceptanceDecodeResultV1<T, D> {
  try {
    const bytes = snapshot(input, ACCEPTANCE_LIMITS_V1.maxJsonBytes);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw "invalid-utf8";
    }
    const value = parseBounded(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw "invalid-shape";
    const record = value as Record<string, unknown>;
    if (!Object.hasOwn(record, "schemaVersion")) throw "invalid-shape";
    if (record.schemaVersion !== version) throw "unsupported-version";
    if (record.schemaDigest !== ACCEPTANCE_SCHEMA_DIGESTS_V1[domain]) throw "schema-mismatch";
    if (!Check(schema, value)) throw "invalid-shape";
    validate(value as T);
    return Object.freeze({
      ok: true,
      value: freeze(value as T),
      identity: Object.freeze({ domain, sha256: hash(bytes), byteLength: bytes.byteLength }),
      authentication: "unverified",
      originalBytes: () => bytes.slice(),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      code:
        typeof error === "string" && errors.has(error as AcceptanceDecodeErrorV1)
          ? (error as AcceptanceDecodeErrorV1)
          : "invalid-input",
    });
  }
}
export function decodeAssertionCompanionV1(
  input: unknown,
): AcceptanceDecodeResultV1<AssertionCompanionV1, "companion"> {
  return decode(
    input,
    "companion",
    "assertion-companion/v1",
    AssertionCompanionSchemaV1,
    companionMetadata,
  );
}
export function decodeProducerReceiptV1(
  input: unknown,
): AcceptanceDecodeResultV1<ProducerReceiptV1, "receipt"> {
  return decode(
    input,
    "receipt",
    "producer-receipt/v1",
    ProducerReceiptSchemaV1,
    receiptConsistency,
  );
}

/** Check one exact receipt/companion join. Does not aggregate a run or authenticate a claim. */
export function bindProducerReceiptV1(
  companionBytes: unknown,
  receiptBytes: unknown,
):
  | AcceptanceDecodeFailureV1
  | Readonly<{
      ok: true;
      companion: AcceptanceDecodedV1<AssertionCompanionV1, "companion">;
      receipt: AcceptanceDecodedV1<ProducerReceiptV1, "receipt">;
      authentication: "unverified";
    }> {
  const companion = decodeAssertionCompanionV1(companionBytes);
  if (!companion.ok) return companion;
  const receipt = decodeProducerReceiptV1(receiptBytes);
  if (!receipt.ok) return receipt;
  const spec = companion.value;
  const claim = receipt.value;
  const failure = Object.freeze({ ok: false, code: "binding-mismatch" } as const);
  if (
    claim.runId !== spec.runId ||
    claim.leafId !== spec.leaf.id ||
    !equalDigest(claim.companion, companion.identity) ||
    !equalDigest(claim.inputManifest, spec.inputManifest) ||
    (claim.procedure.state === "frozen" && !equalDigest(claim.procedure.digest, spec.procedure))
  )
    return failure;
  const expected = new Set<string>([`leaf:${spec.leaf.id}`]);
  for (const demo of spec.demonstrations)
    for (const step of demo.substeps) expected.add(`demo:${demo.demoCaseId}:${step.substepId}`);
  for (const vector of spec.vectors)
    for (const check of vector.subchecks)
      expected.add(`vector:${vector.vectorId}:${check.subcheckId}`);
  for (const check of claim.checks) {
    const key = checkKey(check.subject);
    if (!expected.has(key)) return failure;
    expected.delete(key);
  }
  if (
    claim.role === "primary" &&
    claim.outcome === "pass" &&
    (expected.size !== 0 || claim.checks.some((check) => check.outcome !== "pass"))
  )
    return failure;
  return Object.freeze({ ok: true, companion, receipt, authentication: "unverified" });
}
