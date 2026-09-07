import { createHash, randomUUID } from "node:crypto";
import {
  isSecurityEventExpired,
  parseSecurityEvent,
  serializeSecurityEvent,
} from "@openclaw-enterprise/contracts/security-events";
import { DependencyUnavailableError, ScopeViolationError } from "../../errors.ts";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import type {
  SecurityEventDeliveryRepositoryV1,
  SecurityEventStorageInputV1,
  SecurityEventStorageRefusalV1,
  StagedSecurityEventV1,
} from "../../ports/repositories/security-event-delivery-v1.ts";

type Row = Record<string, unknown>;
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function unavailable(): never {
  throw new DependencyUnavailableError("Security event storage is unavailable.");
}
/** Preserve the actual PostgreSQL timestamp at millisecond precision. */
export function securityEventExpiredAtDatabaseTimeV1(
  event: SecurityEventStorageInputV1["event"],
  checkedAt: unknown,
): boolean {
  if (!(checkedAt instanceof Date)) return unavailable();
  let instant: number;
  try {
    instant = Date.prototype.getTime.call(checkedAt);
  } catch {
    return unavailable();
  }
  if (!Number.isFinite(instant)) return unavailable();
  return isSecurityEventExpired(parseSecurityEvent(event), new Date(instant).toISOString());
}
function text(row: Row, field: string): string {
  return typeof row[field] === "string" ? row[field] : unavailable();
}
function integer(row: Row, field: string): number {
  const raw = row[field];
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw)
        ? Number(raw)
        : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : unavailable();
}

/** Internal factory only: the original operation owner authenticates and selects
 * the producer/event mapping before calling stage, on its original guarded unit.
 * TODO: wire the owner's awaited outbox-stage callback and post-COMMIT boundary.
 * The factory never starts, commits, rolls back or acquires a transaction. */
export interface SecurityEventStorageContextV1 extends QueryRepositoryFactoryContext {
  /** Approved opaque IDs from the original trusted projection owner; never wire input.
   * Raw RepositoryScope remains the actual persisted OCC Installation/Namespace. */
  readonly securityScope: { readonly installationId: string; readonly namespaceId: string };
}
export function createPostgresSecurityEventDeliveryV1(
  context: SecurityEventStorageContextV1,
): SecurityEventDeliveryRepositoryV1 {
  context.transaction.assertActive();
  const scope = Object.freeze({ ...context.scope });
  const securityScope = Object.freeze({ ...context.securityScope });
  const query = async (statement: string, parameters: readonly unknown[] = []): Promise<Row[]> => {
    context.transaction.assertActive();
    const result = await context.query.query(statement, parameters);
    context.transaction.assertActive();
    return result.rows.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
      return value as Row;
    });
  };
  function snapshot(input: SecurityEventStorageInputV1): SecurityEventStorageInputV1 {
    return Object.freeze({
      event: parseSecurityEvent(input.event),
      producerInstanceRef: input.producerInstanceRef,
      producerSequence: input.producerSequence,
      obligationRef: input.obligationRef,
      origin: Object.freeze({
        auditEventId: input.origin.auditEventId,
        originalOperationRef: input.origin.originalOperationRef,
      }),
    });
  }
  function normalize(input: SecurityEventStorageInputV1) {
    const event = parseSecurityEvent(input.event);
    if (
      [input.producerInstanceRef, input.obligationRef, input.origin.originalOperationRef].some(
        (value) => typeof value !== "string" || !reference.test(value),
      ) ||
      !Number.isSafeInteger(input.producerSequence) ||
      input.producerSequence < 1
    )
      throw new ScopeViolationError("Security event storage input is invalid.");
    if (
      typeof input.origin.auditEventId !== "string" ||
      !input.origin.auditEventId.length ||
      Buffer.byteLength(input.origin.auditEventId, "utf8") > 256 ||
      /[\x00-\x1f\x7f]/.test(input.origin.auditEventId)
    )
      throw new ScopeViolationError("Security event origin is invalid.");
    const canonical = serializeSecurityEvent(event);
    const digest = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
    const key = Object.freeze({ installationId: event.installationId, eventId: event.id });
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify({
        version: 1,
        key,
        producerInstanceRef: input.producerInstanceRef,
        producerSequence: input.producerSequence,
        obligationRef: input.obligationRef,
        canonicalEventUtf8: canonical,
        eventDigest: digest,
      }),
      "utf8",
    );
    if (envelopeBytes > 16384)
      throw new ScopeViolationError("Security event storage input is invalid.");
    return { event, canonical, digest, key, envelopeBytes };
  }
  async function owner(input: SecurityEventStorageInputV1, lock: boolean): Promise<boolean> {
    const rows = await query(
      `SELECT installation_id,namespace_id,origin_operation_ref,origin_kind,state FROM occ.audit_export_outbox WHERE audit_event_id=$1${lock ? " FOR UPDATE" : ""}`,
      [input.origin.auditEventId],
    );
    const row = rows[0];
    return (
      rows.length === 1 &&
      row !== undefined &&
      row.installation_id === scope.installationId &&
      row.namespace_id === scope.namespaceId &&
      row.origin_operation_ref === input.origin.originalOperationRef &&
      row.origin_kind === "lifecycle-protective-v1" &&
      (!lock || row.state === "pending")
    );
  }
  function matches(
    row: Row,
    input: SecurityEventStorageInputV1,
    data: ReturnType<typeof normalize>,
  ): boolean {
    return (
      row.installation_id === scope.installationId &&
      row.security_installation_id === data.key.installationId &&
      row.event_id === data.key.eventId &&
      row.namespace_id === scope.namespaceId &&
      row.security_namespace_id === data.event.namespaceId &&
      row.audit_event_id === input.origin.auditEventId &&
      row.original_operation_ref === input.origin.originalOperationRef &&
      row.producer_instance_ref === input.producerInstanceRef &&
      integer(row, "producer_sequence") === input.producerSequence &&
      row.obligation_ref === input.obligationRef &&
      row.event_digest === data.digest &&
      row.canonical_event_utf8 === data.canonical &&
      row.received_at === data.event.receivedAt
    );
  }
  function receipt(row: Row, data: ReturnType<typeof normalize>): StagedSecurityEventV1 {
    const ref = text(row, "commit_receipt_ref");
    if (!reference.test(ref)) return unavailable();
    return Object.freeze({
      kind: "Staged",
      key: data.key,
      eventDigest: data.digest,
      commitReceiptRef: ref,
    });
  }
  function matchesScope(data: ReturnType<typeof normalize>): boolean {
    return (
      reference.test(securityScope.installationId) &&
      reference.test(securityScope.namespaceId) &&
      scope.namespaceId !== undefined &&
      data.key.installationId === securityScope.installationId &&
      data.event.namespaceId === securityScope.namespaceId
    );
  }
  return Object.freeze({
    stage: async (input: SecurityEventStorageInputV1) => {
      input = snapshot(input);
      const data = normalize(input);
      const refuse = (code: SecurityEventStorageRefusalV1["code"]): SecurityEventStorageRefusalV1 =>
        Object.freeze({ kind: "RefusedBeforeCommit", key: data.key, code });
      if (!matchesScope(data)) return refuse("WrongProducerScope");
      const mode = (
        await query(
          "SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation",
        )
      )[0];
      if (mode?.read_only !== "off" || mode.isolation !== "read committed")
        throw new ScopeViolationError(
          "Security event staging requires the original writable READ COMMITTED unit.",
        );
      // Resolve the real same-unit obligation, never trust a supplied pending object.
      if (!(await owner(input, true))) return refuse("WrongProducerScope");
      const budgets = await query(
        "SELECT * FROM occ.security_event_capacity_v1 WHERE installation_id=$1 FOR UPDATE",
        [scope.installationId],
      );
      // All insertion/sequence contenders serialize on the same Installation row.
      if (budgets.length !== 1) return refuse("Capacity");
      const found = await query(
        "SELECT * FROM occ.security_event_records_v1 WHERE installation_id=$1 AND (event_id=$2 OR (producer_instance_ref=$3 AND producer_sequence=$4) OR obligation_ref=$5 OR audit_event_id=$6)",
        [
          scope.installationId,
          data.key.eventId,
          input.producerInstanceRef,
          input.producerSequence,
          input.obligationRef,
          input.origin.auditEventId,
        ],
      );
      // Sample after lock waits and the exact lookup; pre-lock time can expire while waiting.
      const clock = (await query("SELECT clock_timestamp() AS checked_at"))[0];
      if (securityEventExpiredAtDatabaseTimeV1(data.event, clock?.checked_at))
        return refuse("InvalidRecord");
      if (found.length)
        return found.length === 1 && matches(found[0]!, input, data)
          ? receipt(found[0]!, data)
          : refuse("Conflict");
      const budget = budgets[0]!;
      const overhead = integer(budget, "record_overhead_bytes");
      const charged = data.envelopeBytes + overhead;
      if (overhead < 1 || !Number.isSafeInteger(charged)) return refuse("Capacity");
      const reserved = await query(
        `UPDATE occ.security_event_capacity_v1 SET pending_events=pending_events+1,pending_bytes=pending_bytes+$2,retained_bytes=retained_bytes+$3 WHERE installation_id=$1 AND pending_events<max_pending_events AND pending_bytes<=max_pending_bytes-$2 AND retained_bytes<=max_retained_bytes-$3 RETURNING installation_id`,
        [scope.installationId, data.envelopeBytes, charged],
      );
      if (reserved.length !== 1) return refuse("Capacity");
      const ref = randomUUID();
      // Reservation, exact event and the owner's obligation share one commit.
      const inserted = await query(
        `INSERT INTO occ.security_event_records_v1 (installation_id,event_id,namespace_id,audit_event_id,original_operation_ref,producer_instance_ref,producer_sequence,obligation_ref,event_digest,canonical_event_utf8,received_at,commit_receipt_ref,envelope_bytes,charged_bytes,security_installation_id,security_namespace_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [
          scope.installationId,
          data.key.eventId,
          scope.namespaceId,
          input.origin.auditEventId,
          input.origin.originalOperationRef,
          input.producerInstanceRef,
          input.producerSequence,
          input.obligationRef,
          data.digest,
          data.canonical,
          data.event.receivedAt,
          ref,
          data.envelopeBytes,
          charged,
          data.key.installationId,
          data.event.namespaceId,
        ],
      );
      if (inserted.length !== 1 || !matches(inserted[0]!, input, data)) return unavailable();
      return receipt(inserted[0]!, data);
    },
    readCommitted: async (input: SecurityEventStorageInputV1) => {
      input = snapshot(input);
      const data = normalize(input);
      const unknown = () =>
        Object.freeze({
          kind: "Unknown" as const,
          key: data.key,
          code: "ReadbackUnavailable" as const,
        });
      if (!matchesScope(data)) return unknown();
      const mode = (await query("SELECT current_setting('transaction_read_only') AS read_only"))[0];
      if (mode?.read_only !== "on")
        throw new ScopeViolationError("Security event readback requires a fresh read-only unit.");
      if (!(await owner(input, false))) return unknown();
      const found = await query(
        "SELECT * FROM occ.security_event_records_v1 WHERE installation_id=$1 AND namespace_id=$2 AND event_id=$3",
        [scope.installationId, scope.namespaceId, data.key.eventId],
      );
      const clock = (await query("SELECT clock_timestamp() AS checked_at"))[0];
      if (securityEventExpiredAtDatabaseTimeV1(data.event, clock?.checked_at)) return unknown();
      // No absent-at-this-instant assertion can fence a preceding append.
      if (found.length === 0) return unknown();
      if (found.length !== 1 || !matches(found[0]!, input, data))
        return Object.freeze({ kind: "Conflict", key: data.key });
      return Object.freeze({ ...receipt(found[0]!, data), kind: "Committed" });
    },
  });
}
