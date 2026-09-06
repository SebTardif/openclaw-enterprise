import { createHash } from "node:crypto";
import {
  parseCompletedContextV1,
  type CheckpointRefV1,
  type ContextKeyV1,
  type ExactAttemptV1,
} from "@openclaw-enterprise/contracts/completed-context-v1";
import {
  parseNonTurnReceiptV1,
  parseRejectedAdmissionV1,
  parseTurnJournalResultV1,
  parseTurnJournalV1,
  type AdmissionRecordV1,
  type AttemptRecordV1,
  type CompletionRecordV1,
  type ExactCancellationOperationV1,
  type ExactCheckpointAllocationV1,
  type ExactCompletionOperationV1,
  type ExactDeliveryOperationV1,
  type ExactDeliveryOutcomeV1,
  type ExactOutcomeOperationV1,
  type ExpectedCompletionHeadV1,
  type IncomingAdmissionLinkV1,
  type JournalReleaseObservationV1,
  type NonTurnReceiptV1,
  type RejectedAdmissionRecordV1,
} from "@openclaw-enterprise/contracts/turn-journal-v1";

export type TurnJournalRow = Readonly<Record<string, unknown>>;

/** A corrupt stored value is unavailable; its contents never enter an error. */
export class TurnJournalRowError extends Error {
  constructor() {
    super("The stored turn journal value is invalid.");
    this.name = "TurnJournalRowError";
  }
}
function invalid(): never {
  throw new TurnJournalRowError();
}
function text(row: TurnJournalRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") invalid();
  return value;
}
function integer(row: TurnJournalRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" && (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)))
    invalid();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || Object.is(result, -0)) invalid();
  return result;
}
function read<T>(decode: () => T): T {
  try {
    return decode();
  } catch {
    return invalid();
  }
}

/** Equality encoding for already decoded journal values. This is not a codec,
 * authority assertion, content digest or replacement checkpoint serialization. */
export function canonicalJournalValue(value: unknown): string {
  const encode = (input: unknown, depth: number): string => {
    if (depth > 16) invalid();
    if (input === null || typeof input === "boolean") return JSON.stringify(input);
    if (typeof input === "number") {
      if (!Number.isSafeInteger(input) || input < 0 || Object.is(input, -0)) invalid();
      return JSON.stringify(input);
    }
    if (typeof input === "string") {
      if (/[\ud800-\udfff]/u.test(input)) invalid();
      return JSON.stringify(input);
    }
    if (typeof input !== "object") invalid();
    if (Array.isArray(input)) {
      if (
        Object.getPrototypeOf(input) !== Array.prototype ||
        input.length > 128 ||
        Reflect.ownKeys(input).length !== input.length + 1
      )
        invalid();
      return `[${Array.from({ length: input.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
        return encode(descriptor.value, depth + 1);
      }).join(",")}]`;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== "string")) invalid();
    return `{${(keys as string[])
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (
          !descriptor ||
          !("value" in descriptor) ||
          !descriptor.enumerable ||
          ["__proto__", "prototype", "constructor"].includes(key)
        )
          invalid();
        return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
      })
      .join(",")}}`;
  };
  const result = encode(value, 0);
  if (Buffer.byteLength(result, "utf8") > 65_536) invalid();
  return result;
}
export function sameJournalValue(left: unknown, right: unknown): boolean {
  return canonicalJournalValue(left) === canonicalJournalValue(right);
}
function assertContext(row: TurnJournalRow, context: ContextKeyV1): void {
  if (
    text(row, "installation_id") !== context.installationRef ||
    text(row, "namespace_id") !== context.namespaceRef ||
    text(row, "agent_id") !== context.agentRef ||
    text(row, "conversation_ref") !== context.conversationRef
  )
    invalid();
}
function assertAttempt(row: TurnJournalRow, attempt: ExactAttemptV1): void {
  assertContext(row, attempt);
  if (
    text(row, "turn_ref") !== attempt.turnRef ||
    text(row, "attempt_ref") !== attempt.attemptRef ||
    text(row, "reservation_ref") !== attempt.reservationRef
  )
    invalid();
}
function assertChannel(
  row: TurnJournalRow,
  scope: { installationRef: string; channelInstallationRef: string },
): void {
  if (
    text(row, "installation_id") !== scope.installationRef ||
    text(row, "channel_installation_id") !== scope.channelInstallationRef
  )
    invalid();
}

export type TurnJournalOwnerRow =
  | Readonly<{ ownerKind: "admission"; record: AdmissionRecordV1 }>
  | Readonly<{ ownerKind: "rejected"; record: RejectedAdmissionRecordV1 }>
  | Readonly<{ ownerKind: "non-turn"; record: NonTurnReceiptV1 }>;

export function parseOwnerRow(row: TurnJournalRow): TurnJournalOwnerRow {
  return read(() => {
    switch (row.owner_kind) {
      case "admission": {
        const record = parseTurnJournalV1("admission", row.record);
        assertChannel(row, record.identity.locator);
        if (text(row, "receipt_ref") !== record.identity.receipt.receiptRef) invalid();
        return Object.freeze({ ownerKind: "admission", record });
      }
      case "rejected": {
        const record = parseRejectedAdmissionV1(row.record);
        assertChannel(row, record.envelope);
        if (text(row, "receipt_ref") !== record.receipt.receiptRef) invalid();
        return Object.freeze({ ownerKind: "rejected", record });
      }
      case "non-turn": {
        const record = parseNonTurnReceiptV1(row.record);
        assertChannel(row, record.intake);
        if (text(row, "receipt_ref") !== record.receiptRef) invalid();
        return Object.freeze({ ownerKind: "non-turn", record });
      }
      default:
        return invalid();
    }
  });
}

export function parseIncomingLinkRow(
  row: TurnJournalRow,
): IncomingAdmissionLinkV1 | NonTurnReceiptV1 {
  return read(() => {
    if (row.link_kind === "admission") {
      const record = parseTurnJournalV1("incomingLink", row.record);
      assertChannel(row, record.locator);
      if (
        text(row, "incoming_link_ref") !== record.incomingLinkRef ||
        text(row, "event_key") !== record.locator.eventKey ||
        text(row, "incoming_identity_digest") !== record.incomingIdentityDigest ||
        text(row, "incoming_event_digest") !== record.incomingEventDigest ||
        text(row, "incoming_content_digest") !== record.incomingContentDigest
      )
        invalid();
      return record;
    }
    if (row.link_kind === "non-turn") {
      const record = parseNonTurnReceiptV1(row.record);
      assertChannel(row, record.intake);
      if (
        text(row, "incoming_link_ref") !== record.incomingLinkRef ||
        text(row, "event_key") !== record.intake.eventKey ||
        text(row, "incoming_event_digest") !== record.intake.eventDigest ||
        text(row, "incoming_identity_digest") !==
          createHash("sha256").update(canonicalJournalValue(record.intake)).digest("hex") ||
        row.incoming_content_digest !== null
      )
        invalid();
      return record;
    }
    return invalid();
  });
}

/** Decode the canonical common/full record without reconstructing dispatch.
 * Historical NULL conversion belongs exclusively to the reviewed migration. */
export function parseAttemptRow(row: TurnJournalRow): AttemptRecordV1 {
  return read(() => {
    parseAttemptFirstReceivedAt(row);
    const record = parseTurnJournalV1("attempt", row.record);
    assertAttempt(row, record.binding.attempt);
    assertChannel(row, record.binding.identity.locator);
    if (
      integer(row, "version") !== record.version ||
      text(row, "admission_receipt_ref") !== record.binding.identity.receipt.receiptRef ||
      !sameJournalValue(row.reservation, record.binding.reservation)
    )
      invalid();
    return record;
  });
}

/** This retained intake time is internal metadata from the verified envelope.
 * It never supplies dispatch provenance or an attempt expiration. */
export function parseAttemptFirstReceivedAt(row: TurnJournalRow): string {
  return read(() => {
    const value = row.first_received_at;
    if (!(value instanceof Date) && typeof value !== "string") invalid();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) invalid();
    const result = date.toISOString();
    if (typeof value === "string" && value !== result) invalid();
    return result;
  });
}

export function parseHeadRow(
  row: TurnJournalRow,
): Readonly<{ head: ExpectedCompletionHeadV1; checkpoint: CheckpointRefV1 | null }> {
  return read(() => {
    const head = parseTurnJournalV1("head", row.record);
    assertContext(row, head.context);
    const checkpoint =
      row.checkpoint === null ? null : parseCompletedContextV1("checkpointRef", row.checkpoint);
    if (checkpoint === null) {
      if (head.completionSequence !== 0 || head.checkpointId !== null) invalid();
    } else {
      assertContext(row, checkpoint);
      if (
        head.checkpointId !== checkpoint.checkpointId ||
        head.completionSequence !== checkpoint.completionSequence
      )
        invalid();
    }
    return Object.freeze({ head, checkpoint });
  });
}

export type TurnJournalOperationRow =
  | Readonly<{
      operationKind: "checkpoint-allocation";
      request: ExactCheckpointAllocationV1;
      record: ExactCheckpointAllocationV1;
    }>
  | Readonly<{
      operationKind: "completion";
      request: ExactCompletionOperationV1;
      record: CompletionRecordV1;
    }>
  | Readonly<{
      operationKind: "outcome";
      request: ExactOutcomeOperationV1;
      record: AttemptRecordV1;
    }>
  | Readonly<{
      operationKind: "cancellation";
      request: ExactCancellationOperationV1;
      record: Readonly<{
        operation: ExactCancellationOperationV1;
        outcome: "requested" | "cancelled-before-dispatch";
      }>;
    }>
  | Readonly<{
      operationKind: "release";
      request: JournalReleaseObservationV1;
      record: JournalReleaseObservationV1;
    }>;

export function parseOperationRow(row: TurnJournalRow): TurnJournalOperationRow {
  return read(() => {
    switch (row.operation_kind) {
      case "checkpoint-allocation": {
        const request = parseTurnJournalV1("checkpointAllocation", row.request);
        const record = parseTurnJournalV1("checkpointAllocation", row.record);
        assertAttempt(row, request.attempt);
        if (
          text(row, "operation_ref") !== request.operationRef ||
          !sameJournalValue(request, record)
        )
          invalid();
        return Object.freeze({ operationKind: "checkpoint-allocation", request, record });
      }
      case "completion": {
        const request = parseTurnJournalV1("completionOperation", row.request);
        const record = parseTurnJournalV1("completion", row.record);
        assertAttempt(row, request.attempt);
        if (
          text(row, "operation_ref") !== request.operationRef ||
          !sameJournalValue(request, record.operation)
        )
          invalid();
        return Object.freeze({ operationKind: "completion", request, record });
      }
      case "outcome": {
        const request = parseTurnJournalV1("outcomeOperation", row.request);
        const record = parseTurnJournalV1("attempt", row.record);
        assertAttempt(row, request.attempt);
        if (
          text(row, "operation_ref") !== request.operationRef ||
          !sameJournalValue(request.attempt, record.binding.attempt) ||
          !sameJournalValue(request.outcome, record.outcome) ||
          record.version !== request.expectedAttemptVersion + 1
        )
          invalid();
        return Object.freeze({ operationKind: "outcome", request, record });
      }
      case "cancellation": {
        const request = parseTurnJournalV1("cancellation", row.request);
        const value = row.record;
        if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
        const record = value as Record<string, unknown>;
        if (Reflect.ownKeys(record).length !== 2) invalid();
        const operationField = Object.getOwnPropertyDescriptor(record, "operation");
        const outcomeField = Object.getOwnPropertyDescriptor(record, "outcome");
        if (
          !operationField ||
          !("value" in operationField) ||
          !operationField.enumerable ||
          !outcomeField ||
          !("value" in outcomeField) ||
          !outcomeField.enumerable
        )
          invalid();
        const state = parseTurnJournalResultV1("cancellationState", {
          kind: "found",
          operation: operationField.value,
          outcome: outcomeField.value,
        });
        if (state.kind !== "found") invalid();
        assertAttempt(row, request.attempt);
        if (
          text(row, "operation_ref") !== request.operationRef ||
          !sameJournalValue(request, state.operation)
        )
          invalid();
        return Object.freeze({
          operationKind: "cancellation",
          request,
          record: Object.freeze({ operation: state.operation, outcome: state.outcome }),
        });
      }
      case "release": {
        const request = parseTurnJournalV1("releaseObservation", row.request);
        const record = parseTurnJournalV1("releaseObservation", row.record);
        assertAttempt(row, request.attempt);
        if (
          text(row, "operation_ref") !== request.releaseOperationRef ||
          !sameJournalValue(request, record)
        )
          invalid();
        return Object.freeze({ operationKind: "release", request, record });
      }
      default:
        return invalid();
    }
  });
}

export type TurnJournalDeliveryRow = Readonly<{
  operation: ExactDeliveryOperationV1;
  outcome: ExactDeliveryOutcomeV1 | null;
  deliveryAttemptRef: string | null;
  attemptNumber: number;
  episodeStartedAt: string | null;
}>;

/** Parses either current slots or retained native-attempt history. */
export function parseDeliveryRow(row: TurnJournalRow): TurnJournalDeliveryRow {
  return read(() => {
    const operation = parseTurnJournalV1("deliveryOperation", row.operation);
    assertAttempt(row, operation.attempt);
    if (
      text(row, "slot") !== operation.slot ||
      text(row, "operation_ref") !== operation.operationRef
    )
      invalid();
    const outcome = row.outcome === null ? null : parseTurnJournalV1("delivery", row.outcome);
    const deliveryAttemptRef =
      row.delivery_attempt_ref === null ? null : text(row, "delivery_attempt_ref");
    const attemptNumber = integer(row, "attempt_number");
    let episodeStartedAt: string | null = null;
    if (row.episode_started_at !== null) {
      const value = row.episode_started_at;
      if (!(value instanceof Date) && typeof value !== "string") invalid();
      const date = value instanceof Date ? value : new Date(value);
      if (!Number.isFinite(date.getTime())) invalid();
      episodeStartedAt = date.toISOString();
    }
    if (
      attemptNumber > 3 ||
      (attemptNumber === 0 &&
        (deliveryAttemptRef !== null || episodeStartedAt !== null || outcome !== null)) ||
      (attemptNumber > 0 && (deliveryAttemptRef === null || episodeStartedAt === null))
    )
      invalid();
    if (
      outcome !== null &&
      (!sameJournalValue(outcome.operation, operation) ||
        outcome.deliveryAttemptRef !== deliveryAttemptRef)
    )
      invalid();
    return Object.freeze({
      operation,
      outcome,
      deliveryAttemptRef,
      attemptNumber,
      episodeStartedAt,
    });
  });
}
