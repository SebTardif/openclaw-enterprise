import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  primaryKey,
  text,
  unique,
  type AnyPgColumn,
  type PgSchema,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";

export interface SecurityEventDeliveryParentsV1 {
  readonly installation: { readonly id: AnyPgColumn };
  readonly auditExportOutbox: { readonly auditEventId: AnyPgColumn };
}
/** New table definitions only. The original owner supplies its SAME outbox table.
 * TODO: compose these tables and least-privilege grants through the original schema owner.
 * No new outbox, migration number, exporter or operation authority is defined here. */
export function createSecurityEventDeliveryTablesV1(
  schema: PgSchema,
  parents: SecurityEventDeliveryParentsV1,
) {
  const capacity = schema.table(
    "security_event_capacity_v1",
    {
      installationId: text("installation_id").primaryKey(),
      maxPendingEvents: bigint("max_pending_events", { mode: "number" }).notNull(),
      maxPendingBytes: bigint("max_pending_bytes", { mode: "number" }).notNull(),
      maxRetainedBytes: bigint("max_retained_bytes", { mode: "number" }).notNull(),
      recordOverheadBytes: bigint("record_overhead_bytes", { mode: "number" }).notNull(),
      pendingEvents: bigint("pending_events", { mode: "number" }).notNull().default(0),
      pendingBytes: bigint("pending_bytes", { mode: "number" }).notNull().default(0),
      retainedBytes: bigint("retained_bytes", { mode: "number" }).notNull().default(0),
    },
    (table) => [
      foreignKey({ columns: [table.installationId], foreignColumns: [parents.installation.id] })
        .onDelete("restrict")
        .onUpdate("restrict"),
      check(
        "security_event_capacity_v1_bounds",
        sql`${table.maxPendingEvents} BETWEEN 1 AND 10000 AND ${table.maxPendingBytes} BETWEEN 1 AND 67108864 AND ${table.maxRetainedBytes} BETWEEN 1 AND 9007199254740991 AND ${table.recordOverheadBytes} BETWEEN 1 AND 9007199254740991 AND ${table.pendingEvents} BETWEEN 0 AND ${table.maxPendingEvents} AND ${table.pendingBytes} BETWEEN 0 AND ${table.maxPendingBytes} AND ${table.retainedBytes} BETWEEN ${table.pendingBytes} AND ${table.maxRetainedBytes}`,
      ),
    ],
  );
  const records = schema.table(
    "security_event_records_v1",
    {
      installationId: text("installation_id").notNull(),
      eventId: text("event_id").notNull(),
      namespaceId: text("namespace_id").notNull(),
      securityInstallationId: text("security_installation_id").notNull(),
      securityNamespaceId: text("security_namespace_id").notNull(),
      auditEventId: text("audit_event_id").notNull(),
      originalOperationRef: text("original_operation_ref").notNull(),
      producerInstanceRef: text("producer_instance_ref").notNull(),
      producerSequence: bigint("producer_sequence", { mode: "number" }).notNull(),
      obligationRef: text("obligation_ref").notNull(),
      eventDigest: text("event_digest").notNull(),
      canonicalEventUtf8: text("canonical_event_utf8").notNull(),
      receivedAt: text("received_at").notNull(),
      commitReceiptRef: text("commit_receipt_ref").notNull(),
      envelopeBytes: bigint("envelope_bytes", { mode: "number" }).notNull(),
      chargedBytes: bigint("charged_bytes", { mode: "number" }).notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({ columns: [table.installationId, table.eventId] }),
      unique("security_event_records_v1_event_key").on(table.securityInstallationId, table.eventId),
      unique("security_event_records_v1_sequence").on(
        table.securityInstallationId,
        table.producerInstanceRef,
        table.producerSequence,
      ),
      unique("security_event_records_v1_obligation").on(
        table.securityInstallationId,
        table.obligationRef,
      ),
      unique("security_event_records_v1_outbox").on(table.auditEventId),
      unique("security_event_records_v1_receipt").on(table.commitReceiptRef),
      foreignKey({ columns: [table.installationId], foreignColumns: [parents.installation.id] })
        .onDelete("restrict")
        .onUpdate("restrict"),
      // Existing outbox has only this single-column key. Full owner correspondence
      // is resolved under the original guarded unit; no nonexistent composite FK.
      foreignKey({
        columns: [table.auditEventId],
        foreignColumns: [parents.auditExportOutbox.auditEventId],
      })
        .onDelete("restrict")
        .onUpdate("restrict"),
      check(
        "security_event_records_v1_refs",
        sql`${table.eventId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ${table.producerInstanceRef} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ${table.obligationRef} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ${table.commitReceiptRef} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
      ),
      check(
        "security_event_records_v1_bounds",
        sql`${table.producerSequence} BETWEEN 1 AND 9007199254740991 AND octet_length(${table.canonicalEventUtf8}) BETWEEN 1 AND 8192 AND ${table.envelopeBytes} BETWEEN 1 AND 16384 AND ${table.chargedBytes} BETWEEN ${table.envelopeBytes} AND 9007199254740991`,
      ),
      check(
        "security_event_records_v1_digest",
        sql`${table.eventDigest} = 'sha256:' || encode(sha256(convert_to(${table.canonicalEventUtf8}, 'UTF8')), 'hex')`,
      ),
      check(
        "security_event_records_v1_correspondence",
        sql`coalesce((jsonb_typeof(${table.canonicalEventUtf8}::jsonb) = 'object' AND ${table.canonicalEventUtf8}::jsonb->>'schema' = 'openclaw.security-event/v1' AND ${table.canonicalEventUtf8}::jsonb->>'id' = ${table.eventId} AND ${table.canonicalEventUtf8}::jsonb->>'installationId' = ${table.securityInstallationId} AND ${table.canonicalEventUtf8}::jsonb->>'namespaceId' = ${table.securityNamespaceId} AND ${table.canonicalEventUtf8}::jsonb->>'receivedAt' = ${table.receivedAt}), false)`,
      ),
    ],
  );
  return Object.freeze({ capacity, records });
}
