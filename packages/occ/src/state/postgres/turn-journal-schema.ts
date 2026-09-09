import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
  type PgSchema,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";

/** The original OCC schema supplies its parents. This module never creates a
 * second schema instance or imports the composition root back into the domain. */
export interface TurnJournalSchemaParents {
  installation: { id: AnyPgColumn };
  agents: { namespaceId: AnyPgColumn; id: AnyPgColumn };
  channelInstallations: { installationId: AnyPgColumn; id: AnyPgColumn };
}

export function createTurnJournalTables(schema: PgSchema, parents: TurnJournalSchemaParents) {
  const installationScope = () => ({
    installationId: text("installation_id")
      .notNull()
      .references(() => parents.installation.id, { onUpdate: "restrict", onDelete: "restrict" }),
  });
  const channelScope = () => ({
    ...installationScope(),
    channelInstallationId: text("channel_installation_id").notNull(),
  });
  const agentScope = () => ({
    ...installationScope(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
  });
  const contextScope = () => ({
    ...agentScope(),
    conversationRef: text("conversation_ref").notNull(),
  });
  const attemptScope = () => ({
    ...contextScope(),
    turnRef: text("turn_ref").notNull(),
    attemptRef: text("attempt_ref").notNull(),
    reservationRef: text("reservation_ref").notNull(),
  });
  type AgentColumns = {
    installationId: AnyPgColumn;
    namespaceId: AnyPgColumn;
    agentId: AnyPgColumn;
  };
  type ContextColumns = AgentColumns & { conversationRef: AnyPgColumn };
  type AttemptColumns = ContextColumns & {
    turnRef: AnyPgColumn;
    attemptRef: AnyPgColumn;
    reservationRef: AnyPgColumn;
  };
  const contextColumns = (table: ContextColumns) =>
    [table.installationId, table.namespaceId, table.agentId, table.conversationRef] as const;
  const attemptColumns = (table: AttemptColumns) =>
    [...contextColumns(table), table.turnRef, table.attemptRef, table.reservationRef] as const;
  const agentOwner = (name: string, table: AgentColumns) =>
    foreignKey({
      name,
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [parents.agents.namespaceId, parents.agents.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict");
  const channelOwner = (
    name: string,
    table: { installationId: AnyPgColumn; channelInstallationId: AnyPgColumn },
  ) =>
    foreignKey({
      name,
      columns: [table.installationId, table.channelInstallationId],
      foreignColumns: [
        parents.channelInstallations.installationId,
        parents.channelInstallations.id,
      ],
    })
      .onUpdate("restrict")
      .onDelete("restrict");
  const boundedObject = (name: string, column: AnyPgColumn) =>
    check(
      name,
      sql`jsonb_typeof(${column}) = 'object' AND octet_length(${column}::text) BETWEEN 1 AND 65536`,
    );

  const turnJournalOwners = schema.table(
    "turn_journal_owners",
    {
      ...channelScope(),
      receiptRef: text("receipt_ref").notNull(),
      ownerKind: text("owner_kind").$type<"admission" | "rejected" | "non-turn">().notNull(),
      record: jsonb("record").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "turn_journal_owners_pk",
        columns: [table.installationId, table.channelInstallationId, table.receiptRef],
      }),
      channelOwner("turn_journal_owners_channel", table),
      check(
        "turn_journal_owners_kind",
        sql`${table.ownerKind} IN ('admission', 'rejected', 'non-turn')`,
      ),
      boundedObject("turn_journal_owners_record", table.record),
      check(
        "turn_journal_owners_identity",
        sql`CASE ${table.ownerKind}
      WHEN 'admission' THEN (${table.record}#>>'{identity,receipt,receiptRef}' = ${table.receiptRef}
        AND ${table.record}#>>'{identity,locator,installationRef}' = ${table.installationId}
        AND ${table.record}#>>'{identity,locator,channelInstallationRef}' = ${table.channelInstallationId})
      WHEN 'rejected' THEN (${table.record}#>>'{receipt,receiptRef}' = ${table.receiptRef}
        AND ${table.record}#>>'{envelope,installationRef}' = ${table.installationId}
        AND ${table.record}#>>'{envelope,channelInstallationRef}' = ${table.channelInstallationId})
      ELSE (${table.record}->>'receiptRef' = ${table.receiptRef}
        AND ${table.record}#>>'{intake,installationRef}' = ${table.installationId}
        AND ${table.record}#>>'{intake,channelInstallationRef}' = ${table.channelInstallationId}) END IS TRUE`,
      ),
    ],
  );
  const turnJournalKeys = schema.table(
    "turn_journal_keys",
    {
      ...channelScope(),
      keyKind: text("key_kind").$type<"event" | "logical-message">().notNull(),
      keyDigest: text("key_digest").notNull(),
      receiptRef: text("receipt_ref").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "turn_journal_keys_pk",
        columns: [
          table.installationId,
          table.channelInstallationId,
          table.keyKind,
          table.keyDigest,
        ],
      }),
      foreignKey({
        name: "turn_journal_keys_owner",
        columns: [table.installationId, table.channelInstallationId, table.receiptRef],
        foreignColumns: [
          turnJournalOwners.installationId,
          turnJournalOwners.channelInstallationId,
          turnJournalOwners.receiptRef,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      check("turn_journal_keys_kind", sql`${table.keyKind} IN ('event', 'logical-message')`),
      check("turn_journal_keys_digest", sql`${table.keyDigest} ~ '^[0-9a-f]{64}$'`),
    ],
  );
  const turnJournalIncomingLinks = schema.table(
    "turn_journal_incoming_links",
    {
      ...channelScope(),
      incomingLinkRef: text("incoming_link_ref").notNull(),
      eventOwner: boolean("event_owner").notNull(),
      linkKind: text("link_kind").$type<"admission" | "non-turn">().notNull(),
      incomingIdentityDigest: text("incoming_identity_digest").notNull(),
      eventKey: text("event_key").notNull(),
      incomingEventDigest: text("incoming_event_digest").notNull(),
      incomingContentDigest: text("incoming_content_digest"),
      record: jsonb("record").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "turn_journal_incoming_links_pk",
        columns: [table.installationId, table.channelInstallationId, table.incomingLinkRef],
      }),
      channelOwner("turn_journal_links_channel", table),
      uniqueIndex("turn_journal_links_event_owner")
        .on(table.installationId, table.channelInstallationId, table.eventKey)
        .where(sql`${table.eventOwner}`),
      uniqueIndex("turn_journal_links_exact").on(
        table.installationId,
        table.channelInstallationId,
        table.eventKey,
        table.incomingEventDigest,
        sql`coalesce(${table.incomingContentDigest}, '')`,
        table.incomingIdentityDigest,
      ),
      check("turn_journal_links_kind", sql`${table.linkKind} IN ('admission', 'non-turn')`),
      check(
        "turn_journal_links_digests",
        sql`${table.incomingIdentityDigest} ~ '^[0-9a-f]{64}$'
      AND ${table.eventKey} ~ '^[0-9a-f]{64}$' AND ${table.incomingEventDigest} ~ '^[0-9a-f]{64}$'
      AND (${table.incomingContentDigest} IS NULL OR ${table.incomingContentDigest} ~ '^[0-9a-f]{64}$')`,
      ),
      boundedObject("turn_journal_links_record", table.record),
      check(
        "turn_journal_links_identity",
        sql`(${table.record}->>'incomingLinkRef' = ${table.incomingLinkRef}
      AND CASE ${table.linkKind} WHEN 'admission' THEN (
        ${table.record}#>>'{locator,installationRef}' = ${table.installationId}
        AND ${table.record}#>>'{locator,channelInstallationRef}' = ${table.channelInstallationId}
        AND ${table.record}#>>'{locator,eventKey}' = ${table.eventKey}
        AND ${table.record}->>'incomingIdentityDigest' = ${table.incomingIdentityDigest}
        AND ${table.record}->>'incomingEventDigest' = ${table.incomingEventDigest}
        AND ${table.record}->>'incomingContentDigest' = ${table.incomingContentDigest})
      ELSE (${table.record}#>>'{intake,installationRef}' = ${table.installationId}
        AND ${table.record}#>>'{intake,channelInstallationRef}' = ${table.channelInstallationId}
        AND ${table.record}#>>'{intake,eventKey}' = ${table.eventKey}
        AND ${table.record}#>>'{intake,eventDigest}' = ${table.incomingEventDigest}
        AND ${table.incomingContentDigest} IS NULL) END) IS TRUE`,
      ),
    ],
  );
  const turnJournalAttempts = schema.table(
    "turn_journal_attempts",
    {
      ...attemptScope(),
      channelInstallationId: text("channel_installation_id").notNull(),
      admissionReceiptRef: text("admission_receipt_ref").notNull(),
      firstReceivedAt: timestamp("first_received_at", { withTimezone: true }).notNull(),
      reservation: jsonb("reservation").notNull(),
      record: jsonb("record").notNull(),
      version: bigint("version", { mode: "number" }).notNull().default(1),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({ name: "turn_journal_attempts_pk", columns: [...attemptColumns(table)] }),
      agentOwner("turn_journal_attempts_agent", table),
      foreignKey({
        name: "turn_journal_attempts_admission",
        columns: [table.installationId, table.channelInstallationId, table.admissionReceiptRef],
        foreignColumns: [
          turnJournalOwners.installationId,
          turnJournalOwners.channelInstallationId,
          turnJournalOwners.receiptRef,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      unique("turn_journal_attempts_turn").on(...contextColumns(table), table.turnRef),
      unique("turn_journal_attempts_reservation").on(
        table.installationId,
        table.namespaceId,
        table.agentId,
        table.reservationRef,
      ),
      unique("turn_journal_attempts_admission_unique").on(
        table.installationId,
        table.channelInstallationId,
        table.admissionReceiptRef,
      ),
      check("turn_journal_attempts_version", sql`${table.version} BETWEEN 1 AND 9007199254740991`),
      check("turn_journal_attempts_first_received", sql`isfinite(${table.firstReceivedAt})`),
      boundedObject("turn_journal_attempts_reservation_value", table.reservation),
      check(
        "turn_journal_attempts_record",
        sql`(jsonb_typeof(${table.record}) = 'object'
      AND octet_length(${table.record}::text) BETWEEN 1 AND 65536
      AND ${table.record}->'version' = to_jsonb(${table.version})
      AND ${sql.identifier(schema.schemaName)}.turn_journal_phase_value_valid('attempt', ${table.record})) IS TRUE`,
      ),
      check(
        "turn_journal_attempts_reservation_identity",
        sql`(${table.reservation}->>'reservationRef' = ${table.reservationRef}
      AND ${table.reservation}#>>'{scope,installationId}' = ${table.installationId}
      AND ${table.reservation}#>>'{scope,namespaceId}' = ${table.namespaceId}
      AND ${table.reservation}#>>'{scope,agentId}' = ${table.agentId}) IS TRUE`,
      ),
    ],
  );
  const attemptOwner = (name: string, table: AttemptColumns) =>
    foreignKey({
      name,
      columns: [...attemptColumns(table)],
      foreignColumns: [...attemptColumns(turnJournalAttempts)],
    })
      .onUpdate("restrict")
      .onDelete("restrict");
  const turnJournalReservations = schema.table(
    "turn_journal_reservations",
    {
      ...attemptScope(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "turn_journal_reservations_pk",
        columns: [table.installationId, table.namespaceId, table.agentId],
      }),
      attemptOwner("turn_journal_reservations_attempt", table),
    ],
  );
  const turnJournalHeads = schema.table(
    "turn_journal_heads",
    {
      ...contextScope(),
      record: jsonb("record").notNull(),
      checkpoint: jsonb("checkpoint"),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({ name: "turn_journal_heads_pk", columns: [...contextColumns(table)] }),
      agentOwner("turn_journal_heads_agent", table),
      boundedObject("turn_journal_heads_record", table.record),
      check(
        "turn_journal_heads_checkpoint",
        sql`${table.checkpoint} IS NULL OR (jsonb_typeof(${table.checkpoint}) = 'object'
      AND octet_length(${table.checkpoint}::text) BETWEEN 1 AND 65536)`,
      ),
      check(
        "turn_journal_heads_identity",
        sql`(${table.record}#>>'{context,installationRef}' = ${table.installationId}
      AND ${table.record}#>>'{context,namespaceRef}' = ${table.namespaceId}
      AND ${table.record}#>>'{context,agentRef}' = ${table.agentId}
      AND ${table.record}#>>'{context,conversationRef}' = ${table.conversationRef}
      AND (${table.record}->>'headVersion')::numeric BETWEEN 1 AND 9007199254740991
      AND (${table.record}->>'completionSequence')::numeric BETWEEN 0 AND 9007199254740991
      AND CASE WHEN (${table.record}->>'completionSequence')::numeric = 0
        THEN ${table.record}->'checkpointId' = 'null'::jsonb AND ${table.checkpoint} IS NULL
        ELSE ${table.checkpoint}->>'checkpointId' = ${table.record}->>'checkpointId'
          AND ${table.checkpoint}->'completionSequence' = ${table.record}->'completionSequence' END) IS TRUE`,
      ),
    ],
  );
  const turnJournalOperations = schema.table(
    "turn_journal_operations",
    {
      ...attemptScope(),
      operationKind: text("operation_kind")
        .$type<
          | "checkpoint-allocation"
          | "completion"
          | "outcome"
          | "cancellation"
          | "release"
          | "execution-intent"
          | "execution-start"
          | "execution-interruption"
          | "deadline-control"
        >()
        .notNull(),
      operationRef: text("operation_ref").notNull(),
      request: jsonb("request").notNull(),
      record: jsonb("record").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "turn_journal_operations_pk",
        columns: [table.installationId, table.operationKind, table.operationRef],
      }),
      attemptOwner("turn_journal_operations_attempt", table),
      check(
        "turn_journal_operations_kind",
        sql`${table.operationKind} IN ('checkpoint-allocation','completion','outcome','cancellation','release','execution-intent','execution-start','execution-interruption','deadline-control')`,
      ),
      boundedObject("turn_journal_operations_request", table.request),
      boundedObject("turn_journal_operations_record", table.record),
      uniqueIndex("turn_journal_operations_once")
        .on(...attemptColumns(table), table.operationKind)
        .where(
          sql`${table.operationKind} IN ('checkpoint-allocation','completion','cancellation','release')`,
        ),
      uniqueIndex("turn_journal_execution_once")
        .on(...attemptColumns(table), table.operationKind)
        .where(
          sql`${table.operationKind} IN ('execution-intent','execution-start','execution-interruption','deadline-control')`,
        ),
      uniqueIndex("turn_journal_execution_lookup")
        .on(table.installationId, sql`(${table.request}#>>'{execution,executionRef}')`)
        .where(sql`${table.operationKind} = 'execution-intent'`),
      uniqueIndex("turn_journal_native_construction")
        .on(
          table.installationId,
          sql`(${table.request}->>'nativeIncarnationRef')`,
          sql`(${table.request}->>'nativeConstructionRef')`,
        )
        .where(sql`${table.operationKind} = 'deadline-control'`),
      uniqueIndex("turn_journal_native_execution")
        .on(
          table.installationId,
          sql`(${table.request}->>'nativeIncarnationRef')`,
          sql`(${table.request}->>'nativeExecutionRef')`,
        )
        .where(sql`${table.operationKind} = 'execution-start'`),
      uniqueIndex("turn_journal_native_turn")
        .on(
          table.installationId,
          sql`(${table.request}->>'nativeIncarnationRef')`,
          sql`(${table.request}->>'nativeSessionRef')`,
          sql`(${table.request}->>'nativeTurnRef')`,
        )
        .where(sql`${table.operationKind} = 'execution-start'`),
      uniqueIndex("turn_journal_checkpoint_allocation_id")
        .on(table.installationId, sql`(${table.request}->>'checkpointId')`)
        .where(sql`${table.operationKind} = 'checkpoint-allocation'`),
      uniqueIndex("turn_journal_completion_sequence")
        .on(...contextColumns(table), sql`(${table.record}#>>'{head,completionSequence}')`)
        .where(sql`${table.operationKind} = 'completion'`),
    ],
  );
  const deliveryScope = () => ({
    ...attemptScope(),
    slot: text("slot").$type<"completed-result" | "outcome-status" | "cancel-ack">().notNull(),
    operationRef: text("operation_ref").notNull(),
    operation: jsonb("operation").notNull(),
  });
  const turnJournalDeliveries = schema.table(
    "turn_journal_deliveries",
    {
      ...deliveryScope(),
      deliveryAttemptRef: text("delivery_attempt_ref"),
      attemptNumber: bigint("attempt_number", { mode: "number" }).notNull().default(0),
      episodeStartedAt: timestamp("episode_started_at", { withTimezone: true }),
      outcome: jsonb("outcome"),
      updateUsed: boolean("update_used").notNull().default(false),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "turn_journal_deliveries_pk",
        columns: [...attemptColumns(table), table.slot],
      }),
      attemptOwner("turn_journal_deliveries_attempt", table),
      unique("turn_journal_deliveries_operation").on(table.installationId, table.operationRef),
      check(
        "turn_journal_deliveries_slot",
        sql`${table.slot} IN ('completed-result','outcome-status','cancel-ack')`,
      ),
      boundedObject("turn_journal_deliveries_operation_value", table.operation),
      check(
        "turn_journal_deliveries_budget",
        sql`${table.attemptNumber} BETWEEN 0 AND 3
      AND ((${table.attemptNumber} = 0 AND ${table.deliveryAttemptRef} IS NULL AND ${table.episodeStartedAt} IS NULL AND ${table.outcome} IS NULL)
        OR (${table.attemptNumber} > 0 AND ${table.deliveryAttemptRef} IS NOT NULL AND ${table.episodeStartedAt} IS NOT NULL AND isfinite(${table.episodeStartedAt})))
      AND (NOT ${table.updateUsed} OR ${table.slot} = 'outcome-status')`,
      ),
      check(
        "turn_journal_deliveries_outcome",
        sql`${table.outcome} IS NULL OR (jsonb_typeof(${table.outcome}) = 'object' AND octet_length(${table.outcome}::text) <= 65536)`,
      ),
    ],
  );
  const turnJournalDeliveryAttempts = schema.table(
    "turn_journal_delivery_attempts",
    {
      ...deliveryScope(),
      installationId: text("installation_id").notNull(),
      deliveryAttemptRef: text("delivery_attempt_ref").notNull(),
      attemptNumber: bigint("attempt_number", { mode: "number" }).notNull(),
      episodeStartedAt: timestamp("episode_started_at", { withTimezone: true }).notNull(),
      outcome: jsonb("outcome"),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "turn_journal_delivery_attempts_pk",
        columns: [table.installationId, table.deliveryAttemptRef],
      }),
      attemptOwner("turn_journal_delivery_attempts_attempt", table),
      foreignKey({
        name: "turn_journal_delivery_history_installation",
        columns: [table.installationId],
        foreignColumns: [parents.installation.id],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      unique("turn_journal_delivery_attempts_number").on(
        table.installationId,
        table.operationRef,
        table.attemptNumber,
      ),
      check(
        "turn_journal_delivery_attempts_slot",
        sql`${table.slot} IN ('completed-result','outcome-status','cancel-ack')`,
      ),
      boundedObject("turn_journal_delivery_attempts_operation", table.operation),
      check(
        "turn_journal_delivery_attempts_budget",
        sql`${table.attemptNumber} BETWEEN 1 AND 3 AND isfinite(${table.episodeStartedAt})
      AND (${table.operation}#>>'{operation,kind}' = 'create'
        OR (${table.operation}#>>'{operation,kind}' = 'update' AND ${table.attemptNumber} = 1 AND ${table.slot} = 'outcome-status'))`,
      ),
      check(
        "turn_journal_delivery_attempts_outcome",
        sql`${table.outcome} IS NULL OR (jsonb_typeof(${table.outcome}) = 'object' AND octet_length(${table.outcome}::text) <= 65536)`,
      ),
    ],
  );

  // The companion migration adds append-only, cross-row correlation and exact
  // transition triggers, which Drizzle cannot express as table constraints.
  return {
    turnJournalOwners,
    turnJournalKeys,
    turnJournalIncomingLinks,
    turnJournalAttempts,
    turnJournalReservations,
    turnJournalHeads,
    turnJournalOperations,
    turnJournalDeliveries,
    turnJournalDeliveryAttempts,
  };
}

export type TurnJournalTables = ReturnType<typeof createTurnJournalTables>;
