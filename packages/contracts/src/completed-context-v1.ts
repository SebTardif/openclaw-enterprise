import { createHash } from "node:crypto";
import { Type, type Static as TypeboxStatic, type TProperties } from "typebox";
import { Check } from "typebox/value";
import { RevisionId } from "./api/common.ts";
import { StoreBindingRefSchemaV1 } from "./completed-state-v1.ts";
import {
  WorkspaceAttemptRefSchemaV1,
  WorkspaceReservationRefSchemaV1,
} from "./workspace-reservation-v1.ts";
import {
  BindRuntimeSchemaV1,
  RUNTIME_AUTHORITY_LIMITS_V1,
  ResolveAssignmentRequestSchemaV1,
  ResolveAssignmentResultSchemaV1,
  parseRuntimeAuthorityV1,
} from "./runtime-authority-v1.ts";

/** Value and callable contracts only. Schemas establish shape, never authenticated
 * provenance, current permission, completed persistence, quiet import or a live guard.
 * Canonical context remains gateway-owned; the journal owns completion publication.
 */
export const COMPLETED_CONTEXT_FORMAT_V1 = "completed-context-text-v1" as const;
export const COMPLETED_CONTEXT_RESTORE_PURPOSE_V1 = "completed-context-restore" as const;
export const COMPLETED_CONTEXT_RESTORE_CONTRACT_V1 = "completed-context-restore-v1" as const;
export const COMPLETED_CONTEXT_LIMITS_V1 = Object.freeze({
  maxSnapshotBytes: 8 * 1024 * 1024,
  maxItems: 16_384,
  maxItemBytes: 256 * 1024,
  maxJsonDepth: 8,
  restoreDeadlineMs: 30_000,
  maxNativeImportBytes: 32 * 1024 * 1024,
  maxMetadataBytes: RUNTIME_AUTHORITY_LIMITS_V1.maxJsonBytes,
  maxMetadataDepth: RUNTIME_AUTHORITY_LIMITS_V1.maxDepth,
});

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const schemaVersion = Type.Literal(1);
const reference = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:/-]+$" });
const digest = Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" });
const commit = Type.String({ minLength: 40, maxLength: 40, pattern: "^[0-9a-f]{40}$" });
const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positiveSequence = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const optionalParent = Type.Union([reference, Type.Null()]);
const canonicalScope = StoreBindingRefSchemaV1.properties.scope.properties;
const workspaceAttempt = WorkspaceAttemptRefSchemaV1.properties;
const assignmentId = BindRuntimeSchemaV1.properties.target.properties.assignmentRef.properties.id;
const storeBindingReference = StoreBindingRefSchemaV1.properties.bindingRef;

/** These Ref fields project the same OCC identities as the imported Id fields.
 * Resolution compares each field exactly; it does not infer ownership from labels.
 */
export const AgentKeySchemaV1 = object({
  installationRef: canonicalScope.installationId,
  namespaceRef: canonicalScope.namespaceId,
  agentRef: canonicalScope.agentId,
});
export type AgentKeyV1 = Immutable<TypeboxStatic<typeof AgentKeySchemaV1>>;

export const ContextKeySchemaV1 = object({
  ...AgentKeySchemaV1.properties,
  conversationRef: workspaceAttempt.conversationRef,
});
export type ContextKeyV1 = Immutable<TypeboxStatic<typeof ContextKeySchemaV1>>;

/** Projection of the existing workspace attempt and reservation records. The
 * reservation version and exact owner must be independently resolved before use.
 */
export const ExactAttemptSchemaV1 = object({
  ...ContextKeySchemaV1.properties,
  turnRef: workspaceAttempt.turnRef,
  attemptRef: workspaceAttempt.attemptRef,
  reservationRef: WorkspaceReservationRefSchemaV1.properties.reservationRef,
});
export type ExactAttemptV1 = Immutable<TypeboxStatic<typeof ExactAttemptSchemaV1>>;

/** A ledger reference resolves the reviewed artifact digests and resulting schema
 * tuple. The baseline native release does not itself implement quiet restoration.
 * Source commits are caller-independent admitted provenance, not permission.
 */
export const ProducerTupleSchemaV1 = object({
  enterpriseCommit: commit,
  upstreamCommit: commit,
  codexCommit: commit,
  codexVersion: Type.Literal("0.153.0"),
  gatewayProtocol: Type.Literal(4),
  nativeStateSchema: Type.Literal(15),
  nativeAgentSchema: Type.Literal(19),
  adapterSchema: schemaVersion,
  contextFormat: Type.Literal(COMPLETED_CONTEXT_FORMAT_V1),
  nativeImportContract: schemaVersion,
  nativeImportAdapterDigest: digest,
  artifactLedgerRef: reference,
});
export type ProducerTupleV1 = Immutable<TypeboxStatic<typeof ProducerTupleSchemaV1>>;

export const CompletedItemSchemaV1 = object({
  ordinal: sequence,
  sourceEventRef: reference,
  turnRef: workspaceAttempt.turnRef,
  attemptRef: workspaceAttempt.attemptRef,
  kind: Type.Enum(["user-text", "assistant-text", "tool-observation"]),
  actorRef: reference,
  // UTF-8 byte length and well-formed Unicode also require the bounded decoder.
  text: Type.String({ maxLength: COMPLETED_CONTEXT_LIMITS_V1.maxItemBytes }),
});
export type CompletedItemV1 = Immutable<TypeboxStatic<typeof CompletedItemSchemaV1>>;

export const CanonicalSnapshotSchemaV1 = object({
  ...ContextKeySchemaV1.properties,
  format: Type.Literal(COMPLETED_CONTEXT_FORMAT_V1),
  items: Type.Array(CompletedItemSchemaV1, { maxItems: COMPLETED_CONTEXT_LIMITS_V1.maxItems }),
  parentCheckpointId: optionalParent,
  canonicalGeneration: reference,
  canonicalThroughSequence: sequence,
  transcriptRootDigest: digest,
  attachmentRefs: Type.Array(Type.Never(), { maxItems: 0 }),
});
export type CanonicalSnapshotV1 = Immutable<TypeboxStatic<typeof CanonicalSnapshotSchemaV1>>;

/** This complete immutable projection must match the gateway-owned manifest.
 * Store references resolve the imported StoreBindingRefV1/StoreBindingV1 records,
 * including exact ownership, binding version, claim UID and approved mount policy.
 * Producing assignments are historical provenance and never restored authority.
 */
export const CheckpointRefSchemaV1 = object({
  ...ExactAttemptSchemaV1.properties,
  schemaVersion,
  checkpointId: reference,
  completionSequence: positiveSequence,
  parentCheckpointId: optionalParent,
  contentDigest: digest,
  byteLength: Type.Integer({ minimum: 1, maximum: COMPLETED_CONTEXT_LIMITS_V1.maxSnapshotBytes }),
  itemCount: Type.Integer({ minimum: 0, maximum: COMPLETED_CONTEXT_LIMITS_V1.maxItems }),
  revisionRef: RevisionId,
  admittedConfigurationDigest: digest,
  revisionLineageRef: reference,
  producingGatewayAssignmentRef: assignmentId,
  producingHarnessAssignmentRef: assignmentId,
  producerTuple: ProducerTupleSchemaV1,
  gatewayStoreBindingRef: storeBindingReference,
  workspaceBindingRef: storeBindingReference,
  workspaceCompletionRef: reference,
});
export type CheckpointRefV1 = Immutable<TypeboxStatic<typeof CheckpointRefSchemaV1>>;

export const ContextUnavailableSchemaV1 = object({
  kind: Type.Literal("unavailable"),
  reasonCode: Type.Enum([
    "store-unavailable",
    "missing-creation-proof",
    "checkpoint-missing",
    "checkpoint-corrupt",
    "checkpoint-incompatible",
    "ownership-mismatch",
    "sequence-conflict",
    "writer-unresolved",
    "capacity-exceeded",
    "authority-unavailable",
    "retired",
    "recovery-required",
  ]),
});
export type ContextUnavailableV1 = Immutable<TypeboxStatic<typeof ContextUnavailableSchemaV1>>;

/** Missing state cannot establish new context. The trusted adapter must positively
 * verify creation or the exact current completed head, ownership and sequence.
 */
export const ContextStateSchemaV1 = Type.Union([
  object({
    kind: Type.Literal("new-context"),
    expectedCompletionSequence: Type.Literal(0),
    creationRef: reference,
    lookupVersion: reference,
  }),
  object({
    kind: Type.Literal("ready"),
    expectedCompletionSequence: positiveSequence,
    checkpointRef: CheckpointRefSchemaV1,
    lookupVersion: reference,
  }),
  ContextUnavailableSchemaV1,
]);
export type ContextStateV1 = Immutable<TypeboxStatic<typeof ContextStateSchemaV1>>;

/** A decoded receipt remains data. Only the trusted canonical adapter can verify
 * its provenance and exact checkpoint; the journal then separately publishes it.
 */
export const VerifiedCheckpointSchemaV1 = object({
  kind: Type.Literal("verified"),
  checkpointRef: CheckpointRefSchemaV1,
  verificationReceiptRef: reference,
});
export type VerifiedCheckpointV1 = Immutable<TypeboxStatic<typeof VerifiedCheckpointSchemaV1>>;

export const PrepareCompletedInputSchemaV1 = object({
  ...ExactAttemptSchemaV1.properties,
  expectedCompletionSequence: sequence,
  checkpointId: reference,
  nativeTerminalEvidenceRef: reference,
  workspaceCompletionRef: reference,
});
export type PrepareCompletedInputV1 = Immutable<
  TypeboxStatic<typeof PrepareCompletedInputSchemaV1>
>;

export const RestoreCompletedInputSchemaV1 = object({
  ...ContextKeySchemaV1.properties,
  restoreRef: reference,
  checkpointRef: CheckpointRefSchemaV1,
  currentGatewayAssignmentRef: assignmentId,
  currentHarnessAssignmentRef: assignmentId,
  priorWriterEvidenceRef: reference,
});
export type RestoreCompletedInputV1 = Immutable<
  TypeboxStatic<typeof RestoreCompletedInputSchemaV1>
>;

export const RestoredContextSchemaV1 = object({
  kind: Type.Literal("restored"),
  restoreRef: reference,
  checkpointId: reference,
  contentDigest: digest,
  newRuntimeThreadRef: reference,
  currentGatewayAssignmentRef: assignmentId,
  currentHarnessAssignmentRef: assignmentId,
});
export const RestoreResultSchemaV1 = Type.Union([
  RestoredContextSchemaV1,
  ContextUnavailableSchemaV1,
]);
export type RestoreResultV1 = Immutable<TypeboxStatic<typeof RestoreResultSchemaV1>>;

export const NativeImportReceiptSchemaV1 = object({
  schemaVersion,
  restoreRef: reference,
  checkpointId: reference,
  nativeThreadRef: reference,
  nativeContextSegmentRef: reference,
  contextDigest: digest,
  itemCount: Type.Integer({ minimum: 0, maximum: COMPLETED_CONTEXT_LIMITS_V1.maxItems }),
  currentHarnessAssignmentRef: assignmentId,
  quietRestoreGeneration: reference,
});
export type NativeImportReceiptV1 = Immutable<TypeboxStatic<typeof NativeImportReceiptSchemaV1>>;

export const NativeImportInputSchemaV1 = object({
  restoreRef: reference,
  checkpointRef: CheckpointRefSchemaV1,
  snapshot: CanonicalSnapshotSchemaV1,
  currentHarnessAssignmentRef: assignmentId,
  currentAdmittedConfigurationRef: reference,
});
export type NativeImportInputV1 = Immutable<TypeboxStatic<typeof NativeImportInputSchemaV1>>;
export const NativeImportResultSchemaV1 = Type.Union([
  NativeImportReceiptSchemaV1,
  ContextUnavailableSchemaV1,
]);
export type NativeImportResultV1 = Immutable<TypeboxStatic<typeof NativeImportResultSchemaV1>>;

/** Select the existing runtime-authority port's exact restore branch. This module
 * defines no parallel resolver, issuer, serving permit or authorization carrier.
 */
export const RestorePurposeRequestSchemaV1 = object({
  ...Type.Extract(
    ResolveAssignmentRequestSchemaV1,
    Type.Object({ purposeContract: Type.Literal(COMPLETED_CONTEXT_RESTORE_CONTRACT_V1) }),
  ).properties,
});
export type RestorePurposeRequestV1 = Immutable<
  TypeboxStatic<typeof RestorePurposeRequestSchemaV1>
>;
export type RestoreSuboperationV1 = RestorePurposeRequestV1["requestedSuboperation"];

export const RestoreCandidateEligibleSchemaV1 = object({
  ...Type.Extract(
    ResolveAssignmentResultSchemaV1,
    Type.Object({
      purpose: Type.Literal(COMPLETED_CONTEXT_RESTORE_PURPOSE_V1),
      result: Type.Literal("candidate-eligible"),
    }),
  ).properties,
});
export type RestoreCandidateEligibleV1 = Immutable<
  TypeboxStatic<typeof RestoreCandidateEligibleSchemaV1>
>;
export const RestorePurposeBindingSchemaV1 = RestoreCandidateEligibleSchemaV1.properties.binding;
export type RestorePurposeBindingV1 = Immutable<
  TypeboxStatic<typeof RestorePurposeBindingSchemaV1>
>;

const restorePending = object({
  ...Type.Extract(ResolveAssignmentResultSchemaV1, Type.Object({ result: Type.Literal("pending") }))
    .properties,
  purpose: Type.Literal(COMPLETED_CONTEXT_RESTORE_PURPOSE_V1),
});
const restoreNotCurrent = object({
  ...Type.Extract(
    ResolveAssignmentResultSchemaV1,
    Type.Object({ result: Type.Literal("not-current") }),
  ).properties,
  purpose: Type.Literal(COMPLETED_CONTEXT_RESTORE_PURPOSE_V1),
});
export const RestorePurposeResultSchemaV1 = Type.Union([
  RestoreCandidateEligibleSchemaV1,
  restorePending,
  restoreNotCurrent,
  Type.Extract(
    ResolveAssignmentResultSchemaV1,
    Type.Object({ result: Type.Literal("not-visible") }),
  ),
  Type.Extract(
    ResolveAssignmentResultSchemaV1,
    Type.Object({ result: Type.Literal("unavailable") }),
  ),
]);
export type RestorePurposeResultV1 = Immutable<TypeboxStatic<typeof RestorePurposeResultSchemaV1>>;

/** The trusted journal authenticates and authorizes every invocation. Evidence
 * references and returned values are not bearer authority. Implementations must
 * resolve exact identities and reject unavailable, stale, foreign or conflicting
 * state; they cannot switch to an empty context or replay historical execution.
 *
 * For restore, current*AssignmentRef names the fresh or exactly retained pair
 * eligible for preparation. It does not require a serving `current` result.
 * Current restore-service/context/store policy governs import and receiver readback;
 * historical human grants remain provenance. Each native suboperation requires
 * its own fresh authenticated receiver guard and unchanged responsibility/fence.
 */
export interface CompletedStateAdapterV1 {
  lookup(key: ContextKeyV1): Promise<ContextStateV1>;
  prepareCompleted(
    input: PrepareCompletedInputV1,
  ): Promise<VerifiedCheckpointV1 | ContextUnavailableV1>;
  verify(
    key: ContextKeyV1,
    ref: CheckpointRefV1,
  ): Promise<VerifiedCheckpointV1 | ContextUnavailableV1>;
  restore(input: RestoreCompletedInputV1): Promise<RestoreResultV1>;
}

/** Required quiet native adapter. Import allocates one exclusively held fresh
 * thread and owned segment; exact currently authorized repeats return its original
 * verified receipt without reinsertion. Readback can neither allocate nor insert.
 *
 * Both operations use fresh exact `completed-context-restore` authority at the
 * real authenticated receiver. The receiver serializes operations/invalidation,
 * verifies the actual complete owned segment and computes its digest/count.
 * No model, tool, MCP, prewarm, hook, contributor, goal, steer, ordinary credentials,
 * native resume, arbitrary history, activation or completed-head mutation is allowed.
 * Unknown acknowledgement retains exact restore ownership and permits only newly
 * authorized exact readback. Native IDs bind once; no blind reinsertion/retarget.
 */
export interface NativeCompletedContextImporterV1 {
  importCompletedContext(input: NativeImportInputV1): Promise<NativeImportResultV1>;
  readImportedContext(restoreRef: string): Promise<NativeImportResultV1>;
}

export const CompletedContextSchemasV1 = Object.freeze({
  agentKey: AgentKeySchemaV1,
  contextKey: ContextKeySchemaV1,
  exactAttempt: ExactAttemptSchemaV1,
  producerTuple: ProducerTupleSchemaV1,
  completedItem: CompletedItemSchemaV1,
  canonicalSnapshot: CanonicalSnapshotSchemaV1,
  checkpointRef: CheckpointRefSchemaV1,
  contextUnavailable: ContextUnavailableSchemaV1,
  contextState: ContextStateSchemaV1,
  verifiedCheckpoint: VerifiedCheckpointSchemaV1,
  prepareCompletedInput: PrepareCompletedInputSchemaV1,
  restoreCompletedInput: RestoreCompletedInputSchemaV1,
  restoreResult: RestoreResultSchemaV1,
  nativeImportInput: NativeImportInputSchemaV1,
  nativeImportReceipt: NativeImportReceiptSchemaV1,
  nativeImportResult: NativeImportResultSchemaV1,
  restorePurposeRequest: RestorePurposeRequestSchemaV1,
  restoreCandidateEligible: RestoreCandidateEligibleSchemaV1,
  restorePurposeResult: RestorePurposeResultSchemaV1,
});
export type CompletedContextSchemaNameV1 = keyof typeof CompletedContextSchemasV1;
export type CompletedContextValueV1<K extends CompletedContextSchemaNameV1> = Immutable<
  TypeboxStatic<(typeof CompletedContextSchemasV1)[K]>
>;

/** Constant error text: malformed data never includes source text or foreign IDs. */
export class CompletedContextValueErrorV1 extends Error {
  constructor() {
    super("Invalid completed context V1 value.");
    this.name = "CompletedContextValueErrorV1";
  }
}

function reject(): never {
  throw new CompletedContextValueErrorV1();
}
const utf8 = new TextEncoder();
function wellFormed(value: string): boolean {
  // With Unicode mode, valid surrogate pairs are code points outside this range.
  return !/[\ud800-\udfff]/u.test(value);
}
function bytes(value: string): number {
  return utf8.encode(value).byteLength;
}
function limitFor(name: CompletedContextSchemaNameV1): number {
  if (name === "nativeImportInput") return COMPLETED_CONTEXT_LIMITS_V1.maxNativeImportBytes;
  if (name === "canonicalSnapshot") return COMPLETED_CONTEXT_LIMITS_V1.maxSnapshotBytes;
  if (name === "completedItem") return COMPLETED_CONTEXT_LIMITS_V1.maxItemBytes;
  return COMPLETED_CONTEXT_LIMITS_V1.maxMetadataBytes;
}
function depthFor(name: CompletedContextSchemaNameV1): number {
  return name === "canonicalSnapshot" || name === "completedItem"
    ? COMPLETED_CONTEXT_LIMITS_V1.maxJsonDepth
    : COMPLETED_CONTEXT_LIMITS_V1.maxMetadataDepth;
}

/** RFC 8785 canonical JSON for this contract's safe-integer data subset. Sorting
 * uses UTF-16 code units. No getters, toJSON, inherited fields or native payloads
 * are evaluated; object/array descriptors are checked before accessing values.
 */
function canonical(
  value: unknown,
  byteLimit: number,
  maxDepth: number = COMPLETED_CONTEXT_LIMITS_V1.maxMetadataDepth,
): string {
  let used = 0;
  const active = new Set<object>();
  function emit(text: string): string {
    used += bytes(text);
    if (used > byteLimit) reject();
    return text;
  }
  function encode(input: unknown, depth: number): string {
    if (depth > maxDepth) reject();
    if (input === null) return emit("null");
    if (typeof input === "boolean") return emit(input ? "true" : "false");
    if (typeof input === "number") {
      if (!Number.isSafeInteger(input) || Object.is(input, -0)) reject();
      return emit(JSON.stringify(input));
    }
    if (typeof input === "string") {
      if (!wellFormed(input) || input.length > byteLimit) reject();
      return emit(JSON.stringify(input));
    }
    if (typeof input !== "object" || active.has(input)) reject();
    active.add(input);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Object.getOwnPropertySymbols(input).length !== 0) reject();
      if (Array.isArray(input)) {
        if (
          Object.getPrototypeOf(input) !== Array.prototype ||
          input.length > COMPLETED_CONTEXT_LIMITS_V1.maxItems
        )
          reject();
        if (Object.keys(descriptors).length !== input.length + 1) reject();
        const parts = [emit("[")];
        for (let index = 0; index < input.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) reject();
          if (index !== 0) parts.push(emit(","));
          parts.push(encode(descriptor.value, depth + 1));
        }
        parts.push(emit("]"));
        return parts.join("");
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) reject();
      const keys = Object.keys(descriptors).sort();
      if (keys.length > 128) reject();
      const parts = [emit("{")];
      for (const [index, key] of keys.entries()) {
        const descriptor = descriptors[key];
        if (
          key.length > byteLimit ||
          !wellFormed(key) ||
          !descriptor ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        )
          reject();
        if (index !== 0) parts.push(emit(","));
        parts.push(emit(JSON.stringify(key)), emit(":"), encode(descriptor.value, depth + 1));
      }
      parts.push(emit("}"));
      return parts.join("");
    } finally {
      active.delete(input);
    }
  }
  return encode(value, 0);
}

/** Bounded JSON reader. Decoded object keys are checked before insertion, so
 * escaped duplicate names cannot be erased by JSON.parse. Depth and collection
 * limits apply during reading, before constructing an unbounded parse tree.
 */
function readJson(
  text: string,
  byteLimit: number,
  maxDepth: number = COMPLETED_CONTEXT_LIMITS_V1.maxMetadataDepth,
): unknown {
  if (
    typeof text !== "string" ||
    text.length > byteLimit ||
    !wellFormed(text) ||
    bytes(text) > byteLimit
  )
    reject();
  let cursor = 0;
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  function whitespace(): void {
    while (cursor < text.length && /[\x20\t\r\n]/.test(text[cursor]!)) cursor++;
  }
  function string(): string {
    if (text[cursor] !== '"') reject();
    const start = cursor++;
    while (cursor < text.length) {
      const character = text[cursor++];
      if (character === "\\") {
        cursor++;
      } else if (character === '"') {
        const value: unknown = JSON.parse(text.slice(start, cursor));
        if (typeof value !== "string" || !wellFormed(value)) reject();
        return value;
      }
    }
    return reject();
  }
  function value(depth: number): unknown {
    if (depth > maxDepth) reject();
    whitespace();
    const character = text[cursor];
    if (character === '"') return string();
    if (character === "{") {
      cursor++;
      whitespace();
      const result: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      if (text[cursor] === "}") {
        cursor++;
        return result;
      }
      while (cursor < text.length) {
        const key = string();
        if (keys.has(key) || keys.size >= 128) reject();
        keys.add(key);
        whitespace();
        if (text[cursor++] !== ":") reject();
        result[key] = value(depth + 1);
        whitespace();
        if (text[cursor] === "}") {
          cursor++;
          return result;
        }
        if (text[cursor++] !== ",") reject();
        whitespace();
      }
      return reject();
    }
    if (character === "[") {
      cursor++;
      whitespace();
      const result: unknown[] = [];
      if (text[cursor] === "]") {
        cursor++;
        return result;
      }
      while (cursor < text.length) {
        if (result.length >= COMPLETED_CONTEXT_LIMITS_V1.maxItems) reject();
        result.push(value(depth + 1));
        whitespace();
        if (text[cursor] === "]") {
          cursor++;
          return result;
        }
        if (text[cursor++] !== ",") reject();
      }
      return reject();
    }
    for (const [literal, result] of [
      ["null", null],
      ["true", true],
      ["false", false],
    ] as const) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length;
        return result;
      }
    }
    number.lastIndex = cursor;
    const match = number.exec(text);
    if (!match) reject();
    cursor = number.lastIndex;
    const result = Number(match[0]);
    // Every numeric field uses the canonical safe-integer subset. Reject decimal
    // and exponent spellings before Number can round a fractional source token.
    if (!Number.isSafeInteger(result) || Object.is(result, -0) || String(result) !== match[0])
      reject();
    return result;
  }
  const result = value(0);
  whitespace();
  if (cursor !== text.length) reject();
  return result;
}

function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  // The recursively frozen input has no mutable descendants after this traversal.
  return value as Immutable<T>;
}
function sameContext(a: ContextKeyV1, b: ContextKeyV1): boolean {
  return (
    a.installationRef === b.installationRef &&
    a.namespaceRef === b.namespaceRef &&
    a.agentRef === b.agentRef &&
    a.conversationRef === b.conversationRef
  );
}
function checkpointIntrinsic(checkpoint: CheckpointRefV1): void {
  if ((checkpoint.completionSequence === 1) !== (checkpoint.parentCheckpointId === null)) reject();
  if (checkpoint.parentCheckpointId === checkpoint.checkpointId) reject();
  if (checkpoint.itemCount === 0) reject();
  if (checkpoint.producingGatewayAssignmentRef === checkpoint.producingHarnessAssignmentRef)
    reject();
  if (checkpoint.gatewayStoreBindingRef === checkpoint.workspaceBindingRef) reject();
}
function snapshotIntrinsic(snapshot: CanonicalSnapshotV1): string {
  for (const [index, item] of snapshot.items.entries()) {
    if (item.ordinal !== index) reject();
    canonical(
      item,
      COMPLETED_CONTEXT_LIMITS_V1.maxItemBytes,
      COMPLETED_CONTEXT_LIMITS_V1.maxJsonDepth,
    );
  }
  return canonical(
    snapshot,
    COMPLETED_CONTEXT_LIMITS_V1.maxSnapshotBytes,
    COMPLETED_CONTEXT_LIMITS_V1.maxJsonDepth,
  );
}
function checkpointSnapshotIntrinsic(
  checkpoint: CheckpointRefV1,
  snapshot: CanonicalSnapshotV1,
): string {
  checkpointIntrinsic(checkpoint);
  const encoded = snapshotIntrinsic(snapshot);
  if (
    !sameContext(checkpoint, snapshot) ||
    checkpoint.parentCheckpointId !== snapshot.parentCheckpointId ||
    checkpoint.itemCount !== snapshot.items.length ||
    checkpoint.byteLength !== bytes(encoded) ||
    checkpoint.contentDigest !== createHash("sha256").update(encoded, "utf8").digest("hex")
  )
    reject();
  const last = snapshot.items.at(-1);
  if (!last || last.turnRef !== checkpoint.turnRef || last.attemptRef !== checkpoint.attemptRef)
    reject();
  return encoded;
}

function intrinsic(name: CompletedContextSchemaNameV1, input: unknown): void {
  // Every branch follows Check against the named closed schema; these casts retain
  // that established shape while selecting relational checks absent from JSON Schema.
  switch (name) {
    case "completedItem":
      canonical(input, COMPLETED_CONTEXT_LIMITS_V1.maxItemBytes);
      break;
    case "canonicalSnapshot":
      snapshotIntrinsic(input as CanonicalSnapshotV1);
      break;
    case "checkpointRef":
      checkpointIntrinsic(input as CheckpointRefV1);
      break;
    case "verifiedCheckpoint":
      checkpointIntrinsic((input as VerifiedCheckpointV1).checkpointRef);
      break;
    case "contextState": {
      const state = input as ContextStateV1;
      if (state.kind === "ready") {
        checkpointIntrinsic(state.checkpointRef);
        if (state.expectedCompletionSequence !== state.checkpointRef.completionSequence) reject();
      }
      break;
    }
    case "prepareCompletedInput": {
      if ((input as PrepareCompletedInputV1).expectedCompletionSequence === Number.MAX_SAFE_INTEGER)
        reject();
      break;
    }
    case "restoreCompletedInput": {
      const restore = input as RestoreCompletedInputV1;
      checkpointIntrinsic(restore.checkpointRef);
      if (
        !sameContext(restore, restore.checkpointRef) ||
        restore.currentGatewayAssignmentRef === restore.currentHarnessAssignmentRef
      )
        reject();
      break;
    }
    case "nativeImportInput": {
      const imported = input as NativeImportInputV1;
      checkpointSnapshotIntrinsic(imported.checkpointRef, imported.snapshot);
      break;
    }
    case "restorePurposeRequest": {
      parseRuntimeAuthorityV1("resolveRequest", input);
      break;
    }
    case "restoreCandidateEligible":
    case "restorePurposeResult": {
      // Preserve the existing authority owner's timestamp, source freshness,
      // expiry and exact-binding intrinsics instead of widening its 15-second
      // evidence window to the longer overall restore-operation deadline.
      const result = parseRuntimeAuthorityV1("resolveResult", input);
      if (
        result.result === "candidate-eligible" &&
        result.purpose === "completed-context-restore"
      ) {
        if (result.binding.gatewayStoreBindingRef === result.binding.workspaceStoreBindingRef)
          reject();
      }
      break;
    }
  }
}

/** Decode owned data only. This cannot establish provenance, currentness,
 * authenticity of a verification receipt, canonical-store ownership or durability.
 */
export function parseCompletedContextV1<K extends CompletedContextSchemaNameV1>(
  name: K,
  input: unknown,
): CompletedContextValueV1<K> {
  try {
    if (!Object.hasOwn(CompletedContextSchemasV1, name)) reject();
    const value = readJson(
      canonical(input, limitFor(name), depthFor(name)),
      limitFor(name),
      depthFor(name),
    );
    if (!Check(CompletedContextSchemasV1[name], value)) reject();
    intrinsic(name, value);
    // Check and intrinsic validation above establish this selected schema's value.
    return freeze(value) as CompletedContextValueV1<K>;
  } catch {
    return reject();
  }
}

/** Strict bounded JSON decoder; repeated escaped keys reject before overwriting.
 * Noncanonical JSON formatting is accepted, then copied and frozen. Canonical
 * checkpoint digests always use the separately specified canonical encoder.
 */
export function parseCompletedContextJsonV1<K extends CompletedContextSchemaNameV1>(
  name: K,
  json: string,
): CompletedContextValueV1<K> {
  try {
    if (!Object.hasOwn(CompletedContextSchemasV1, name)) reject();
    const value = readJson(json, limitFor(name), depthFor(name));
    if (!Check(CompletedContextSchemasV1[name], value)) reject();
    intrinsic(name, value);
    return freeze(value) as CompletedContextValueV1<K>;
  } catch {
    return reject();
  }
}

export function canonicalCompletedContextSnapshotV1(input: unknown): string {
  const snapshot = parseCompletedContextV1("canonicalSnapshot", input);
  return snapshotIntrinsic(snapshot);
}
export function digestCompletedContextSnapshotV1(input: unknown): string {
  return createHash("sha256")
    .update(canonicalCompletedContextSnapshotV1(input), "utf8")
    .digest("hex");
}

/** A restore binding is decoded only as part of the owner's complete eligible
 * result, preserving its source-evidence/freshness checks. No synthetic result
 * or invented observation is constructed to validate a standalone locator.
 */
export function parseRestorePurposeBindingV1(eligibleResult: unknown): RestorePurposeBindingV1 {
  return parseCompletedContextV1("restoreCandidateEligible", eligibleResult).binding;
}

/** Check all self-contained byte, identity, parent, count and final-attempt
 * correlations. Frozen source rows, root lineage, terminal/no-mutator evidence,
 * expected head and producer provenance still require their trusted owners.
 */
export function verifyCompletedCheckpointSnapshotV1(
  checkpointInput: unknown,
  snapshotInput: unknown,
): Readonly<{
  checkpointRef: CheckpointRefV1;
  snapshot: CanonicalSnapshotV1;
  canonicalJson: string;
}> {
  const checkpointRef = parseCompletedContextV1("checkpointRef", checkpointInput);
  const snapshot = parseCompletedContextV1("canonicalSnapshot", snapshotInput);
  const canonicalJson = checkpointSnapshotIntrinsic(checkpointRef, snapshot);
  return Object.freeze({ checkpointRef, snapshot, canonicalJson });
}

/** Compare the entire expected immutable manifest, including attempt, producer
 * tuple, stores/configuration, assignments and digest. Equal hashes alone do not
 * satisfy this comparison. Expected data must come from the trusted owning record.
 */
export function requireMatchingCompletedCheckpointV1(
  expectedInput: unknown,
  actualInput: unknown,
): CheckpointRefV1 {
  const expected = parseCompletedContextV1("checkpointRef", expectedInput);
  const actual = parseCompletedContextV1("checkpointRef", actualInput);
  if (
    canonical(expected, COMPLETED_CONTEXT_LIMITS_V1.maxMetadataBytes) !==
    canonical(actual, COMPLETED_CONTEXT_LIMITS_V1.maxMetadataBytes)
  )
    reject();
  return actual;
}

/** Receipt correlation only; receiving-peer authenticity and actual native-owned
 * segment readback remain mandatory at the trusted accepting adapter.
 */
export function requireMatchingNativeImportReceiptV1(
  inputValue: unknown,
  receiptValue: unknown,
): NativeImportReceiptV1 {
  const input = parseCompletedContextV1("nativeImportInput", inputValue);
  const receipt = parseCompletedContextV1("nativeImportReceipt", receiptValue);
  if (
    receipt.restoreRef !== input.restoreRef ||
    receipt.checkpointId !== input.checkpointRef.checkpointId ||
    receipt.contextDigest !== input.checkpointRef.contentDigest ||
    receipt.itemCount !== input.snapshot.items.length ||
    receipt.currentHarnessAssignmentRef !== input.currentHarnessAssignmentRef
  )
    reject();
  return receipt;
}
