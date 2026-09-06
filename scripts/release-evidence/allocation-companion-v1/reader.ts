import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import { Type, type Static, type TProperties } from "typebox";
import { Check } from "typebox/value";
import {
  ACCEPTANCE_LEAVES_V1,
  ACCEPTANCE_LIMITS_V1,
  AssertionCompanionSchemaV1,
  ProducerReceiptSchemaV1,
  type AcceptanceDigestV1,
  type AssertionCompanionV1,
  type ProducerReceiptV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-v1";
import {
  bindProducerReceiptV1,
  decodeAssertionCompanionV1,
  decodeProducerReceiptV1,
  digestAcceptanceBytesV1,
  type AcceptanceDecodedV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-codec-v1";

/** This consumer only reads declarations. Importing it performs no capture or execution. */
export const ALLOCATION_RUN_LIMITS_V1 = Object.freeze({
  maxSelectionBytes: 524_288,
  maxRecords: 2_048,
  maxAttempts: 2_048,
  maxArtifacts: 4_096,
  maxArtifactBytes: 1_048_576,
  maxAggregateBytes: 33_554_432,
  maxOutputBytes: 67_108_864,
});

const closed = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const opaque = Type.String({ minLength: 1, maxLength: 96, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" });
const nullable = <T extends ReturnType<typeof Type.Object>>(schema: T) =>
  Type.Union([Type.Null(), schema]);
const companionFields = AssertionCompanionSchemaV1.properties;
const receiptFields = ProducerReceiptSchemaV1.properties;

/** Exact selections supplied by the assembler, never inferred from imported claims. */
export const SelectedAllocationRunSchemaV1 = closed({
  schemaVersion: Type.Literal("selected-allocation-run/v1"),
  runId: opaque,
  source: Type.Enum(["synthetic", "source", "live-declared"]),
  inputManifest: companionFields.inputManifest,
  demonstrationInputs: companionFields.demonstrationInputs,
  limits: companionFields.limits,
  tuple: companionFields.tuple,
  handoffs: companionFields.handoffs,
  plans: Type.Array(
    closed({
      leafId: companionFields.leaf.properties.id,
      companion: nullable(receiptFields.companion),
      procedure: nullable(companionFields.procedure),
      procedureReview: nullable(
        Type.Object(
          {
            domain: Type.Literal("review"),
            sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
            byteLength: Type.Integer({
              minimum: 1,
              maximum: ACCEPTANCE_LIMITS_V1.maxReferencedArtifactBytes,
            }),
          },
          { additionalProperties: false },
        ),
      ),
    }),
    { maxItems: 324 },
  ),
});
export type SelectedAllocationRunV1 = Static<typeof SelectedAllocationRunSchemaV1>;

/** A declared invocation is independent of receipt updates and observation reuse. */
export const AllocationAttemptSchemaV1 = closed({
  schemaVersion: Type.Literal("allocation-attempt/v1"),
  attemptId: opaque,
  originalAttemptId: Type.Union([Type.Null(), opaque]),
  runId: opaque,
  inputManifest: companionFields.inputManifest,
  execution: receiptFields.execution,
  receiptIds: Type.Array(opaque, { maxItems: 256, uniqueItems: true }),
});
export type AllocationAttemptV1 = Static<typeof AllocationAttemptSchemaV1>;
export const ALLOCATION_READER_SCHEMA_DIGESTS_V1 = Object.freeze({
  selection: createHash("sha256")
    .update(JSON.stringify(SelectedAllocationRunSchemaV1))
    .digest("hex"),
  attempt: createHash("sha256").update(JSON.stringify(AllocationAttemptSchemaV1)).digest("hex"),
});
export type AllocationIssueV1 = Readonly<{ code: string; subject: string }>;
export type SuppliedArtifactV1 = Readonly<{ identity: AcceptanceDigestV1; bytes: Uint8Array }>;
export type AllocationRunInputV1 = Readonly<{
  selection: Uint8Array;
  companions: readonly Uint8Array[];
  receipts: readonly Uint8Array[];
  attempts: readonly Uint8Array[];
  artifacts: readonly SuppliedArtifactV1[];
}>;
export type ReadAllocationRunV1 = {
  selection: SelectedAllocationRunV1 | null;
  selectionIdentity: AcceptanceDigestV1<"input"> | null;
  structuralIssues: AllocationIssueV1[];
  completenessIssues: AllocationIssueV1[];
  companions: AcceptanceDecodedV1<AssertionCompanionV1, "companion">[];
  receipts: AcceptanceDecodedV1<ProducerReceiptV1, "receipt">[];
  attempts: Array<{ identity: AcceptanceDigestV1<"evidence">; value: AllocationAttemptV1 }>;
  artifacts: AcceptanceDigestV1[];
  receiptAttempts: Map<string, string>;
  supplied: {
    companions: number;
    receipts: number;
    attempts: number;
    artifacts: number;
    bytes: number;
  };
};

export const digestKeyV1 = (digest: AcceptanceDigestV1): string =>
  `${digest.domain}:${digest.sha256}:${digest.byteLength}`;

/** Bounded JSON scanner for the two consumer-local records and the CLI file list.
 * Companion and receipt bytes always go through the separately exported codecs.
 */
export function parseAllocationJsonV1(input: Uint8Array, limit: number): unknown {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ALLOCATION_RUN_LIMITS_V1.maxSelectionBytes
  )
    throw new Error("invalid-limit");
  if (!types.isUint8Array(input) || types.isProxy(input)) throw new Error("invalid-input");
  const proto = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const slot = (name: string): unknown =>
    Object.getOwnPropertyDescriptor(proto, name)!.get!.call(input);
  const length = slot("byteLength") as number;
  const buffer = slot("buffer") as ArrayBuffer;
  if (length === 0 || length > limit || types.isSharedArrayBuffer(buffer))
    throw new Error("input-size");
  const bytes = new Uint8Array(new Uint8Array(buffer, slot("byteOffset") as number, length));
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let cursor = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/^[\x20\t\r\n]$/.test(text[cursor] ?? "!")) cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    while (cursor <= text.length) {
      const char = text[cursor++];
      if (char === "\\") cursor++;
      else if (char === '"') return JSON.parse(text.slice(start, cursor)) as string;
    }
    throw new Error("invalid-json");
  };
  function value(depth: number): void {
    if (depth > 16 || ++nodes > 65_536) throw new Error("json-limit");
    whitespace();
    const char = text[cursor];
    if (char === '"') {
      string();
      return;
    }
    if (char === "{" || char === "[") {
      cursor++;
      const close = char === "{" ? "}" : "]";
      const keys = new Set<string>();
      let count = 0;
      whitespace();
      if (text[cursor] === close) {
        cursor++;
        return;
      }
      for (;;) {
        if (++count > 8_192) throw new Error("json-limit");
        if (char === "{") {
          whitespace();
          if (text[cursor] !== '"') throw new Error("invalid-json");
          const key = string();
          if (keys.has(key)) throw new Error("duplicate-key");
          keys.add(key);
          whitespace();
          if (text[cursor++] !== ":") throw new Error("invalid-json");
        }
        value(depth + 1);
        whitespace();
        const separator = text[cursor++];
        if (separator === close) return;
        if (separator !== ",") throw new Error("invalid-json");
      }
    }
    const token = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
    token.lastIndex = cursor;
    const found = token.exec(text);
    if (
      found === null ||
      (!Number.isFinite(Number(found[0])) && !["true", "false", "null"].includes(found[0]))
    )
      throw new Error("invalid-json");
    cursor = token.lastIndex;
  }
  value(1);
  whitespace();
  if (cursor !== text.length) throw new Error("invalid-json");
  return JSON.parse(text) as unknown;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const same = isDeepStrictEqual;
const executionIdentity = (execution: ProducerReceiptV1["execution"]) => {
  if (execution.state === "unrun") return execution;
  return {
    executionClass: execution.executionClass,
    executorRef: execution.executorRef,
    tool: execution.tool,
    started: execution.started,
    capture: execution.capture,
  };
};

function validateAttemptClock(execution: AllocationAttemptV1["execution"]): void {
  if (execution.state === "unrun") throw new Error("attempt-input-conflict");
  const timestamp = (value: string) => {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
      throw new Error("attempt-clock-invalid");
    return parsed;
  };
  const start = timestamp(execution.started.observedAt);
  if (execution.state === "observed") {
    const end = timestamp(execution.ended.observedAt);
    if (
      execution.started.clockRef === execution.ended.clockRef &&
      end + execution.ended.uncertaintyMs < start - execution.started.uncertaintyMs
    )
      throw new Error("attempt-clock-order");
  }
}

/** Read a finite supplied inventory. No missing capture can prove absent outside activity. */
export function readAllocationRunV1(input: AllocationRunInputV1): ReadAllocationRunV1 {
  const result: ReadAllocationRunV1 = {
    selection: null,
    selectionIdentity: null,
    structuralIssues: [],
    completenessIssues: [],
    companions: [],
    receipts: [],
    attempts: [],
    artifacts: [],
    receiptAttempts: new Map(),
    supplied: { companions: 0, receipts: 0, attempts: 0, artifacts: 0, bytes: 0 },
  };
  const invalid = (code: string, subject: string) =>
    result.structuralIssues.push({ code, subject });
  const missing = (code: string, subject: string) =>
    result.completenessIssues.push({ code, subject });
  try {
    // Validate every length before copying, parsing, hashing or accumulating any record.
    const lists = [input.companions, input.receipts, input.attempts, input.artifacts];
    const limits = [
      324,
      ALLOCATION_RUN_LIMITS_V1.maxRecords,
      ALLOCATION_RUN_LIMITS_V1.maxAttempts,
      ALLOCATION_RUN_LIMITS_V1.maxArtifacts,
    ];
    if (lists.some((list, i) => !Array.isArray(list) || list.length > limits[i]!))
      throw new Error("record-limit");
    result.supplied = {
      companions: input.companions.length,
      receipts: input.receipts.length,
      attempts: input.attempts.length,
      artifacts: input.artifacts.length,
      bytes: 0,
    };
    const charge = (bytes: Uint8Array, limit: number) => {
      if (!types.isUint8Array(bytes) || types.isProxy(bytes)) throw new Error("invalid-input");
      const proto = Object.getPrototypeOf(Uint8Array.prototype) as object;
      const length = Object.getOwnPropertyDescriptor(proto, "byteLength")!.get!.call(
        bytes,
      ) as number;
      const buffer = Object.getOwnPropertyDescriptor(proto, "buffer")!.get!.call(
        bytes,
      ) as ArrayBuffer;
      if (types.isSharedArrayBuffer(buffer) || length === 0 || length > limit)
        throw new Error("input-size");
      if (length > ALLOCATION_RUN_LIMITS_V1.maxAggregateBytes - result.supplied.bytes)
        throw new Error("aggregate-limit");
      result.supplied.bytes += length;
    };
    charge(input.selection, ALLOCATION_RUN_LIMITS_V1.maxSelectionBytes);
    for (const bytes of [...input.companions, ...input.receipts, ...input.attempts])
      charge(bytes, ACCEPTANCE_LIMITS_V1.maxJsonBytes);
    for (const artifact of input.artifacts)
      charge(artifact.bytes, ALLOCATION_RUN_LIMITS_V1.maxArtifactBytes);
    const selection = parseAllocationJsonV1(
      input.selection,
      ALLOCATION_RUN_LIMITS_V1.maxSelectionBytes,
    );
    if (!Check(SelectedAllocationRunSchemaV1, selection)) throw new Error("invalid-selection");
    result.selection = freeze(selection);
    result.selectionIdentity = digestAcceptanceBytesV1("input", input.selection);
  } catch (error) {
    invalid(
      error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : "invalid-input",
      "run",
    );
    return result;
  }
  const selected = result.selection;
  const plans = new Map<string, SelectedAllocationRunV1["plans"][number]>();
  for (const plan of selected.plans) {
    if (plans.has(plan.leafId)) invalid("duplicate-plan", plan.leafId);
    else plans.set(plan.leafId, plan);
  }
  const companions = new Map<string, AcceptanceDecodedV1<AssertionCompanionV1, "companion">>();
  const companionIds = new Set<string>();
  const companionLeafIds = new Set<string>();
  for (const [index, bytes] of input.companions.entries()) {
    const decoded = decodeAssertionCompanionV1(bytes);
    if (!decoded.ok) {
      invalid(decoded.code, `companion-${index}`);
      continue;
    }
    const value = decoded.value;
    if (companionLeafIds.has(value.leaf.id) || companionIds.has(value.companionId)) {
      invalid("duplicate-companion", value.leaf.id);
      continue;
    }
    companionIds.add(value.companionId);
    companionLeafIds.add(value.leaf.id);
    const plan = plans.get(value.leaf.id);
    if (
      !plan ||
      plan.companion === null ||
      plan.procedure === null ||
      plan.procedureReview === null
    ) {
      missing("reviewed-procedure-selection-missing", value.leaf.id);
      continue;
    }
    if (
      !same(plan.companion, decoded.identity) ||
      !same(plan.procedure, value.procedure) ||
      value.runId !== selected.runId ||
      !same(value.inputManifest, selected.inputManifest) ||
      !same(value.demonstrationInputs, selected.demonstrationInputs) ||
      !same(value.limits, selected.limits) ||
      !same(value.tuple, selected.tuple) ||
      !same(value.handoffs, selected.handoffs)
    ) {
      invalid("selected-input-mismatch", value.leaf.id);
      continue;
    }
    companions.set(value.leaf.id, decoded);
    result.companions.push(decoded);
  }
  const receipts = new Map<string, AcceptanceDecodedV1<ProducerReceiptV1, "receipt">>();
  const receiptsByDigest = new Map<string, AcceptanceDecodedV1<ProducerReceiptV1, "receipt">>();
  for (const [index, bytes] of input.receipts.entries()) {
    const decoded = decodeProducerReceiptV1(bytes);
    if (!decoded.ok) {
      invalid(decoded.code, `receipt-${index}`);
      continue;
    }
    const value = decoded.value;
    if (receipts.has(value.receiptId)) {
      invalid("duplicate-receipt", value.receiptId);
      continue;
    }
    receipts.set(value.receiptId, decoded);
    receiptsByDigest.set(digestKeyV1(decoded.identity), decoded);
    result.receipts.push(decoded);
    if (value.runId !== selected.runId || !same(value.inputManifest, selected.inputManifest))
      invalid("receipt-input-mismatch", value.receiptId);
    const companion = companions.get(value.leafId);
    if (!companion) missing("receipt-companion-unavailable", value.receiptId);
    else {
      const bound = bindProducerReceiptV1(companion.originalBytes(), bytes);
      if (!bound.ok) invalid(bound.code, value.receiptId);
    }
  }
  for (const decoded of result.receipts) {
    const value = decoded.value;
    for (const [kind, reference] of [
      ["previous", value.previousReceipt],
      ["reuse", value.reuse?.originalReceipt ?? null],
    ] as const) {
      if (reference === null) continue;
      const prior = receiptsByDigest.get(digestKeyV1(reference));
      if (!prior) {
        missing(`${kind}-receipt-unavailable`, value.receiptId);
        continue;
      }
      if (
        prior === decoded ||
        prior.value.receivedAt > value.receivedAt ||
        prior.value.runId !== value.runId ||
        !same(prior.value.inputManifest, value.inputManifest) ||
        (kind === "previous" &&
          (prior.value.leafId !== value.leafId ||
            prior.value.role !== value.role ||
            prior.value.producer !== value.producer))
      )
        invalid(`${kind}-receipt-conflict`, value.receiptId);
      if (
        kind === "reuse" &&
        (prior.value.execution.state === "unrun" ||
          value.execution.state === "unrun" ||
          !same(executionIdentity(prior.value.execution), executionIdentity(value.execution)) ||
          value.reuse?.originalObservedAt !== prior.value.execution.started.observedAt)
      )
        invalid("reuse-execution-conflict", value.receiptId);
    }
    const visited = new Set<string>();
    let cursor: typeof decoded | undefined = decoded;
    while (cursor && cursor.value.previousReceipt !== null) {
      if (visited.has(cursor.value.receiptId)) {
        invalid("receipt-history-cycle", value.receiptId);
        break;
      }
      visited.add(cursor.value.receiptId);
      cursor = receiptsByDigest.get(digestKeyV1(cursor.value.previousReceipt));
    }
  }
  const attempts = new Map<string, AllocationAttemptV1>();
  const attemptIds = new Set<string>();
  const captureAttempts = new Map<string, string>();
  for (const [index, bytes] of input.attempts.entries()) {
    try {
      const attempt = parseAllocationJsonV1(bytes, ACCEPTANCE_LIMITS_V1.maxJsonBytes);
      if (!Check(AllocationAttemptSchemaV1, attempt)) throw new Error("invalid-attempt");
      if (attemptIds.has(attempt.attemptId)) throw new Error("duplicate-attempt");
      attemptIds.add(attempt.attemptId);
      if (
        attempt.runId !== selected.runId ||
        !same(attempt.inputManifest, selected.inputManifest) ||
        attempt.execution.state === "unrun"
      )
        throw new Error("attempt-input-conflict");
      validateAttemptClock(attempt.execution);
      attempts.set(attempt.attemptId, attempt);
      result.attempts.push({
        identity: digestAcceptanceBytesV1("evidence", bytes),
        value: freeze(attempt),
      });
      if (attempt.execution.capture.state === "claimed") {
        const key = digestKeyV1(attempt.execution.capture.sourceAttemptBinding);
        if (captureAttempts.has(key)) invalid("duplicate-capture-attempt", attempt.attemptId);
        else captureAttempts.set(key, attempt.attemptId);
      }
      for (const id of attempt.receiptIds) {
        if (result.receiptAttempts.has(id)) {
          invalid("receipt-attempt-collision", id);
          continue;
        }
        result.receiptAttempts.set(id, attempt.attemptId);
        const receipt = receipts.get(id);
        if (!receipt) {
          missing("attempt-receipt-unavailable", id);
          continue;
        }
        if (
          receipt.value.execution.state === "unrun" ||
          !same(executionIdentity(receipt.value.execution), executionIdentity(attempt.execution)) ||
          (receipt.value.execution.state === "observed" &&
            !same(receipt.value.execution, attempt.execution))
        )
          invalid("attempt-execution-conflict", id);
      }
    } catch (error) {
      invalid(
        error instanceof Error && /^[a-z-]+$/.test(error.message)
          ? error.message
          : "invalid-attempt",
        `attempt-${index}`,
      );
    }
  }
  for (const attempt of attempts.values()) {
    if (attempt.originalAttemptId !== null && !attempts.has(attempt.originalAttemptId))
      missing("original-attempt-unavailable", attempt.attemptId);
    const visited = new Set<string>();
    let cursor: AllocationAttemptV1 | undefined = attempt;
    while (cursor) {
      if (visited.has(cursor.attemptId)) {
        invalid("attempt-history-cycle", attempt.attemptId);
        break;
      }
      visited.add(cursor.attemptId);
      cursor =
        cursor.originalAttemptId === null ? undefined : attempts.get(cursor.originalAttemptId);
    }
  }
  for (const receipt of result.receipts) {
    if (
      receipt.value.execution.state !== "unrun" &&
      !result.receiptAttempts.has(receipt.value.receiptId)
    )
      missing("declared-attempt-missing", receipt.value.receiptId);
    if (receipt.value.reuse !== null) {
      const prior = receiptsByDigest.get(digestKeyV1(receipt.value.reuse.originalReceipt));
      if (
        prior &&
        result.receiptAttempts.get(prior.value.receiptId) !==
          result.receiptAttempts.get(receipt.value.receiptId)
      )
        invalid("reuse-adds-attempt", receipt.value.receiptId);
    }
  }
  const artifactKeys = new Set<string>();
  for (const [index, artifact] of input.artifacts.entries()) {
    try {
      const identity = digestAcceptanceBytesV1(artifact.identity.domain, artifact.bytes);
      if (!same(identity, artifact.identity)) {
        invalid("artifact-integrity-mismatch", `artifact-${index}`);
        continue;
      }
      const key = digestKeyV1(identity);
      if (artifactKeys.has(key)) invalid("duplicate-artifact", `artifact-${index}`);
      else {
        artifactKeys.add(key);
        result.artifacts.push(identity);
      }
    } catch {
      invalid("invalid-artifact", `artifact-${index}`);
    }
  }
  for (const id of Object.keys(ACCEPTANCE_LEAVES_V1)) {
    if (!plans.has(id)) missing("selected-plan-missing", id);
    if (!companions.has(id)) missing("companion-missing", id);
    if (!result.receipts.some(({ value }) => value.leafId === id && value.role === "primary"))
      missing("primary-receipt-missing", id);
  }
  return result;
}

freeze(SelectedAllocationRunSchemaV1);
freeze(AllocationAttemptSchemaV1);
