import type { AuthorityCallV1 } from "./runtime-authority-v1.ts";
import type { JournalCommitResultV1 } from "./turn-journal-v1.ts";
import {
  parseRetirementPurgeV1,
  encodeRetirementPurgeV1,
  purgeManifestLocatorV1,
  type PurgeManifestV1,
  type PurgeProgressV1,
  type PurgeStoreObservationV1,
} from "./retirement-purge-manifest-v1.ts";

/** Closed retirement metadata and complete outer command definitions. The sole
 * journal owner supplies actual atomicity and provenance; codecs supply neither. */
export type PurgeRetirementBindingV1 = Readonly<{
  schemaVersion: 1;
  scope: PurgeManifestV1["scope"];
  originalTransactionRef: string;
  expectedStoppedTransitionRef: string;
  expectedLifecycleGeneration: number;
  barrierRef: string;
  barrierVersion: number;
  activationReplayLineageRef: string;
  activationReplayLineageVersion: number;
  manifest: ReturnType<typeof purgeManifestLocatorV1>;
}>;
export type PurgeRetirementRecordV1 = Readonly<{
  schemaVersion: 1;
  binding: PurgeRetirementBindingV1;
  progress: PurgeProgressV1;
  auditIntentRef: string;
  durableProgressResponsibilityRef: string;
}>;

declare const retirementInput: unique symbol;
declare const observationInput: unique symbol;
export interface VerifiedPurgeRetirementInputV1 {
  readonly [retirementInput]: true;
}
export interface VerifiedPurgeObservationInputV1 {
  readonly [observationInput]: true;
}
export type PurgeAccessFailureV1 = Readonly<{ kind: "denied" | "unavailable" }>;

export type PurgeRetirementInputObservationV1 = Readonly<{
  binding: PurgeRetirementBindingV1;
  manifest: PurgeManifestV1;
  auditIntentRef: string;
  durableProgressResponsibilityRef: string;
}>;
export type PurgeObservationInputObservationV1 = Readonly<{
  originalTransactionRef: string;
  binding: PurgeRetirementBindingV1;
  observation: PurgeStoreObservationV1;
  expectedRecordVersion: number;
}>;
/** First receipt identity is immutable, even when current progress moves on.
 * This is historical metadata, not provider proof or a deletion permission. */
export type PurgeObservationReceiptV1 = Readonly<{
  schemaVersion: 1;
  binding: PurgeRetirementBindingV1;
  originalTransactionRef: string;
  observation: PurgeStoreObservationV1;
  recordedAtRecordVersion: number;
}>;
export type PurgeHistoryQueryV1 = Readonly<{
  binding: PurgeRetirementBindingV1;
  manifest: PurgeManifestV1;
  auditIntentRef: string;
  durableProgressResponsibilityRef: string;
}> &
  (
    | Readonly<{ kind: "retirement" }>
    | Readonly<{
        kind: "observation";
        originalTransactionRef: string;
        observation: PurgeStoreObservationV1;
      }>
  );
export type PurgePublicationResultV1 =
  | Readonly<{ kind: "published"; record: PurgeRetirementRecordV1 }>
  | Readonly<{ kind: "conflict" | "denied" | "unavailable" }>;
export type PurgeObservationResultV1 =
  | Readonly<{
      kind: "recorded" | "existing";
      record: PurgeRetirementRecordV1;
      receipt: PurgeObservationReceiptV1;
    }>
  | Readonly<{ kind: "conflict" | "denied" | "unavailable" }>;
export type PurgeRetirementReadResultV1 =
  | Readonly<{
      kind: "found";
      record: PurgeRetirementRecordV1;
      observationReceipt: PurgeObservationReceiptV1 | null;
    }>
  | Readonly<{ kind: "not-found" | "conflict" | "denied" | "unavailable" }>;

export interface PurgeRetirementProvenanceV1 {
  inspectRetirement(
    input: VerifiedPurgeRetirementInputV1,
    call: AuthorityCallV1,
  ): Promise<PurgeRetirementInputObservationV1 | PurgeAccessFailureV1>;
  inspectObservation(
    input: VerifiedPurgeObservationInputV1,
    call: AuthorityCallV1,
  ): Promise<PurgeObservationInputObservationV1 | PurgeAccessFailureV1>;
}
/** Complete outer commands, original owner internally composes one transaction.
 * Both explicit transaction locators must match genuine protected inspection.
 * There is no generic outward unit, pre-lock, applyProtective composition or
 * JSON-to-handle constructor. Read accepts exact history, never a new permit. */
export interface RetirementPurgeJournalV1 {
  publishRetirementManifest(
    originalTransactionRef: string,
    input: VerifiedPurgeRetirementInputV1,
    call: AuthorityCallV1,
  ): Promise<JournalCommitResultV1<PurgePublicationResultV1>>;
  recordRetiredStoreObservation(
    originalTransactionRef: string,
    input: VerifiedPurgeObservationInputV1,
    call: AuthorityCallV1,
  ): Promise<JournalCommitResultV1<PurgeObservationResultV1>>;
  findRetirementManifest(
    query: PurgeHistoryQueryV1,
    call: AuthorityCallV1,
  ): Promise<PurgeRetirementReadResultV1>;
}

type Values = {
  binding: PurgeRetirementBindingV1;
  record: PurgeRetirementRecordV1;
  retirementInputObservation: PurgeRetirementInputObservationV1;
  observationInputObservation: PurgeObservationInputObservationV1;
  receipt: PurgeObservationReceiptV1;
  query: PurgeHistoryQueryV1;
  publicationResult: PurgePublicationResultV1;
  observationResult: PurgeObservationResultV1;
  readResult: PurgeRetirementReadResultV1;
  publicationCommit: JournalCommitResultV1<PurgePublicationResultV1>;
  observationCommit: JournalCommitResultV1<PurgeObservationResultV1>;
};
export type PurgeCallableKindV1 = keyof Values;
export const PURGE_CALLABLE_LIMITS_V1 = Object.freeze({
  maxJsonBytes: 786432,
  maxDepth: 24,
  maxNodes: 49152,
  maxArrayLength: 256,
});
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
function invalid(): never {
  throw new TypeError("Invalid retirement callable value.");
}
function canon(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(value[k]!)}`)
    .join(",")}}`;
}
function equal(a: unknown, b: unknown): boolean {
  return canon(a as Json) === canon(b as Json);
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
/** New envelope snapshot only. Nested canonical values are subsequently decoded
 * by their original parser. No getter is called; proxy traps remain a JS runtime
 * limitation, so actual owner ingress uses bounded serialized input. */
function snapshot(input: unknown): Json {
  let nodes = 0;
  let stringBytes = 0;
  const active = new Set<object>();
  function visit(value: unknown, depth: number): Json {
    if (++nodes > PURGE_CALLABLE_LIMITS_V1.maxNodes || depth > PURGE_CALLABLE_LIMITS_V1.maxDepth)
      invalid();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (/[\ud800-\udfff]/u.test(value)) invalid();
      stringBytes += Buffer.byteLength(value);
      if (stringBytes > PURGE_CALLABLE_LIMITS_V1.maxJsonBytes) invalid();
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid();
      return value;
    }
    if (typeof value !== "object" || active.has(value)) invalid();
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) invalid();
    let result: Json;
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > PURGE_CALLABLE_LIMITS_V1.maxArrayLength ||
        keys.length !== value.length + 1
      )
        invalid();
      const array: Json[] = [];
      for (let i = 0; i < value.length; i++) {
        const d = descriptors[String(i)];
        if (!d || !("value" in d) || !d.enumerable) invalid();
        array.push(visit(d.value, depth + 1));
      }
      result = array;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) invalid();
      if (keys.length > 128) invalid();
      const object: ObjectValue = Object.create(null);
      for (const key of keys as string[]) {
        const d = descriptors[key]!;
        if (!("value" in d) || !d.enumerable || /[\ud800-\udfff]/u.test(key)) invalid();
        stringBytes += Buffer.byteLength(key);
        if (stringBytes > PURGE_CALLABLE_LIMITS_V1.maxJsonBytes) invalid();
        object[key] = visit(d.value, depth + 1);
      }
      result = object;
    }
    active.delete(value);
    return result;
  }
  const result = visit(input, 0);
  if (Buffer.byteLength(canon(result)) > PURGE_CALLABLE_LIMITS_V1.maxJsonBytes) invalid();
  return result;
}
function obj(value: Json, keys: readonly string[]): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const actual = Object.keys(value).sort();
  if (!equal(actual, [...keys].sort())) invalid();
  return value;
}
function kindOf(value: Json): string {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.kind !== "string"
  )
    invalid();
  return value.kind;
}
function ref(value: Json | undefined): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._:/-]{1,200}$/.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
  )
    invalid();
}
function version(value: Json | undefined, minimum = 1): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid();
}
function v1(value: Json | undefined): void {
  if (value !== 1) invalid();
}
function binding(value: Json): void {
  const o = obj(value, [
    "schemaVersion",
    "scope",
    "originalTransactionRef",
    "expectedStoppedTransitionRef",
    "expectedLifecycleGeneration",
    "barrierRef",
    "barrierVersion",
    "activationReplayLineageRef",
    "activationReplayLineageVersion",
    "manifest",
  ]);
  v1(o.schemaVersion);
  ref(o.originalTransactionRef);
  if (
    typeof o.expectedStoppedTransitionRef !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      o.expectedStoppedTransitionRef,
    )
  )
    invalid();
  version(o.expectedLifecycleGeneration);
  ref(o.barrierRef);
  version(o.barrierVersion);
  ref(o.activationReplayLineageRef);
  version(o.activationReplayLineageVersion);
  const locator = parseRetirementPurgeV1("locator", o.manifest);
  if (!equal(o.scope, locator.scope)) invalid();
}
function matchManifest(b: Json, manifest: Json): void {
  binding(b);
  const full = parseRetirementPurgeV1("manifest", manifest);
  if (!equal((b as ObjectValue).manifest, purgeManifestLocatorV1(full))) invalid();
}
function record(value: Json): void {
  const o = obj(value, [
    "schemaVersion",
    "binding",
    "progress",
    "auditIntentRef",
    "durableProgressResponsibilityRef",
  ]);
  v1(o.schemaVersion);
  binding(o.binding!);
  const progress = parseRetirementPurgeV1("progress", o.progress);
  matchManifest(o.binding!, progress.manifest as unknown as Json);
  ref(o.auditIntentRef);
  ref(o.durableProgressResponsibilityRef);
}
function boundObservation(b: Json, observation: Json): PurgeStoreObservationV1 {
  binding(b);
  const obs = parseRetirementPurgeV1("observation", observation);
  if (!equal((b as ObjectValue).manifest, obs.manifest)) invalid();
  return obs;
}
function receipt(value: Json): void {
  const o = obj(value, [
    "schemaVersion",
    "binding",
    "originalTransactionRef",
    "observation",
    "recordedAtRecordVersion",
  ]);
  v1(o.schemaVersion);
  ref(o.originalTransactionRef);
  version(o.recordedAtRecordVersion, 2);
  boundObservation(o.binding!, o.observation!);
}
function receiptMatchesRecord(r: Json, p: Json, current: boolean): void {
  record(r);
  receipt(p);
  const result = r as unknown as PurgeRetirementRecordV1;
  const proof = p as unknown as PurgeObservationReceiptV1;
  if (
    !equal(result.binding, proof.binding) ||
    proof.recordedAtRecordVersion > result.progress.recordVersion
  )
    invalid();
  const row = result.progress.stores.find(
    (entry) => entry.entry.deletionOperationRef === proof.observation.deletionOperationRef,
  );
  if (!row || !equal(row.entry.store, proof.observation.store) || row.state.kind === "pending")
    invalid();
  if (row.state.observation.observationSequence < proof.observation.observationSequence) invalid();
  const sequenceDistance =
    row.state.observation.observationSequence - proof.observation.observationSequence;
  const versionDistance = result.progress.recordVersion - proof.recordedAtRecordVersion;
  if (sequenceDistance > versionDistance) invalid();
  if (
    sequenceDistance > 0 &&
    (proof.observation.outcome === "observed-absent" ||
      row.state.observation.observationRef === proof.observation.observationRef ||
      Date.parse(row.state.observation.observedAt) < Date.parse(proof.observation.observedAt))
  )
    invalid();
  if (
    row.state.observation.observationSequence === proof.observation.observationSequence &&
    !equal(row.state.observation, proof.observation)
  )
    invalid();
  if (
    current &&
    (proof.recordedAtRecordVersion !== result.progress.recordVersion ||
      !equal(row.state.observation, proof.observation))
  )
    invalid();
}
function query(value: Json): void {
  const k = kindOf(value);
  const o = obj(
    value,
    k === "retirement"
      ? ["kind", "binding", "manifest", "auditIntentRef", "durableProgressResponsibilityRef"]
      : [
          "kind",
          "binding",
          "manifest",
          "auditIntentRef",
          "durableProgressResponsibilityRef",
          "originalTransactionRef",
          "observation",
        ],
  );
  if (k !== "retirement" && k !== "observation") invalid();
  matchManifest(o.binding!, o.manifest!);
  ref(o.auditIntentRef);
  ref(o.durableProgressResponsibilityRef);
  if (k === "observation") {
    ref(o.originalTransactionRef);
    const observation = boundObservation(o.binding!, o.observation!);
    const manifest = o.manifest as unknown as PurgeManifestV1;
    if (
      !manifest.stores.some(
        (entry) =>
          entry.deletionOperationRef === observation.deletionOperationRef &&
          equal(entry.store, observation.store),
      )
    )
      invalid();
  }
}
function result(value: Json, kind: "publicationResult" | "observationResult" | "readResult"): void {
  const k = kindOf(value);
  if (
    ["conflict", "denied", "unavailable"].includes(k) ||
    (kind === "readResult" && k === "not-found")
  ) {
    obj(value, ["kind"]);
    return;
  }
  if (kind === "publicationResult" && k === "published") {
    const o = obj(value, ["kind", "record"]);
    record(o.record!);
    const progress = (o.record as unknown as PurgeRetirementRecordV1).progress;
    if (
      progress.recordVersion !== 1 ||
      progress.stores.some((entry) => entry.state.kind !== "pending")
    )
      invalid();
    return;
  }
  if (kind === "observationResult" && (k === "recorded" || k === "existing")) {
    const o = obj(value, ["kind", "record", "receipt"]);
    receiptMatchesRecord(o.record!, o.receipt!, k === "recorded");
    return;
  }
  if (kind === "readResult" && k === "found") {
    const o = obj(value, ["kind", "record", "observationReceipt"]);
    record(o.record!);
    if (o.observationReceipt !== null)
      receiptMatchesRecord(o.record!, o.observationReceipt!, false);
    return;
  }
  invalid();
}
function check(kind: PurgeCallableKindV1, value: Json): void {
  switch (kind) {
    case "binding":
      binding(value);
      return;
    case "record":
      record(value);
      return;
    case "receipt":
      receipt(value);
      return;
    case "query":
      query(value);
      return;
    case "retirementInputObservation": {
      const o = obj(value, [
        "binding",
        "manifest",
        "auditIntentRef",
        "durableProgressResponsibilityRef",
      ]);
      matchManifest(o.binding!, o.manifest!);
      ref(o.auditIntentRef);
      ref(o.durableProgressResponsibilityRef);
      return;
    }
    case "observationInputObservation": {
      const o = obj(value, [
        "originalTransactionRef",
        "binding",
        "observation",
        "expectedRecordVersion",
      ]);
      ref(o.originalTransactionRef);
      version(o.expectedRecordVersion);
      boundObservation(o.binding!, o.observation!);
      return;
    }
    case "publicationResult":
    case "observationResult":
    case "readResult":
      result(value, kind);
      return;
    case "publicationCommit":
    case "observationCommit": {
      const k = kindOf(value);
      if (k === "unavailable") {
        obj(value, ["kind"]);
        return;
      }
      if (k === "commit-unknown") {
        const o = obj(value, ["kind", "transactionRef"]);
        ref(o.transactionRef);
        return;
      }
      if (k === "committed") {
        const o = obj(value, ["kind", "value"]);
        result(o.value!, kind === "publicationCommit" ? "publicationResult" : "observationResult");
        return;
      }
      invalid();
    }
    default:
      invalid();
  }
}
export function parsePurgeCallableV1<K extends PurgeCallableKindV1>(
  kind: K,
  input: unknown,
): Values[K] {
  try {
    const value = snapshot(input);
    check(kind, value);
    return frozen(value) as Values[K];
  } catch {
    return invalid();
  }
}
/** Strict canonical JSON: no duplicate keys, insignificant whitespace or alternate
 * number/escape spelling. Use encode before crossing this wire boundary. */
export function parsePurgeCallableJsonV1<K extends PurgeCallableKindV1>(
  kind: K,
  input: string,
): Values[K] {
  try {
    if (
      typeof input !== "string" ||
      Buffer.byteLength(input) > PURGE_CALLABLE_LIMITS_V1.maxJsonBytes
    )
      invalid();
    const result = parsePurgeCallableV1(kind, JSON.parse(input));
    if (canon(result as Json) !== input) invalid();
    return result;
  } catch {
    return invalid();
  }
}
export function encodePurgeCallableV1<K extends PurgeCallableKindV1>(
  kind: K,
  input: Values[K],
): string {
  return canon(parsePurgeCallableV1(kind, input) as Json);
}
/** Pure comparison of decoded values. No identity, authority, currentness,
 * inventory completeness or barrier provenance follows from a true result. */
export function purgeHistoryMatchesV1(
  expected: PurgeHistoryQueryV1,
  found: PurgeRetirementReadResultV1,
): boolean {
  const q = parsePurgeCallableV1("query", expected);
  const r = parsePurgeCallableV1("readResult", found);
  if (
    r.kind !== "found" ||
    !equal(q.binding, r.record.binding) ||
    q.auditIntentRef !== r.record.auditIntentRef ||
    q.durableProgressResponsibilityRef !== r.record.durableProgressResponsibilityRef ||
    encodeRetirementPurgeV1("manifest", q.manifest) !==
      encodeRetirementPurgeV1("manifest", r.record.progress.manifest)
  )
    return false;
  if (q.kind === "retirement") return r.observationReceipt === null;
  return (
    r.observationReceipt !== null &&
    r.observationReceipt.originalTransactionRef === q.originalTransactionRef &&
    equal(r.observationReceipt.observation, q.observation)
  );
}
/** Only invoke after the original command promise settles and its owner has
 * unwound the unit. The receiving read owner validates a fresh AuthorityCall.
 * Even a matching found result is historical metadata, never action permission. */
export async function reconcileUnknownPurgeV1(
  reader: Pick<RetirementPurgeJournalV1, "findRetirementManifest">,
  expected: PurgeHistoryQueryV1,
  originalResult: unknown,
  freshReadCall: AuthorityCallV1,
): Promise<PurgeRetirementReadResultV1> {
  try {
    const q = parsePurgeCallableV1("query", expected);
    const result =
      q.kind === "retirement"
        ? parsePurgeCallableV1("publicationCommit", originalResult)
        : parsePurgeCallableV1("observationCommit", originalResult);
    const tx =
      q.kind === "retirement" ? q.binding.originalTransactionRef : q.originalTransactionRef;
    if (result.kind !== "commit-unknown" || result.transactionRef !== tx)
      return { kind: "unavailable" };
    const found = parsePurgeCallableV1(
      "readResult",
      await reader.findRetirementManifest(q, freshReadCall),
    );
    if (found.kind !== "found") return found;
    return purgeHistoryMatchesV1(q, found) ? found : { kind: "conflict" };
  } catch {
    return { kind: "unavailable" };
  }
}
