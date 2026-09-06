import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  jsonb,
  primaryKey,
  text,
  unique,
  type AnyPgColumn,
  type PgSchema,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";

/** Parents are supplied by the original OCC composition root. */
export interface TurnJournalReplaySchemaParents {
  installation: { id: AnyPgColumn };
  namespaces: { id: AnyPgColumn };
  agents: { namespaceId: AnyPgColumn; id: AnyPgColumn };
  channelInstallations: { installationId: AnyPgColumn; id: AnyPgColumn };
}

/** Permanent reservations are never reclaimed by retirement or purge. */
export const TURN_JOURNAL_REPLAY_CAPACITY = 10_000;

/** This factory registers no repository, authority issuer, or transaction owner.
 * The accompanying DDL owns transition/deferred graph guards and privileges.
 * TODO: supply the original activation/clock validator and owner composition
 * before enabling active lineage insertion or retirement publication.
 */
export function createTurnJournalReplayTables(
  schema: PgSchema,
  parents: TurnJournalReplaySchemaParents,
) {
  const scope = () => ({
    installationId: text("installation_id").notNull(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
  });
  type Scope = { installationId: AnyPgColumn; namespaceId: AnyPgColumn; agentId: AnyPgColumn };
  const scopeColumns = (table: Scope) =>
    [table.installationId, table.namespaceId, table.agentId] as const;
  const owner = (name: string, table: Scope) => [
    foreignKey({
      name: `${name}_installation`,
      columns: [table.installationId],
      foreignColumns: [parents.installation.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    foreignKey({
      name: `${name}_namespace`,
      columns: [table.namespaceId],
      foreignColumns: [parents.namespaces.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    foreignKey({
      name,
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [parents.agents.namespaceId, parents.agents.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
  ];
  const safeVersion = (name: string, column: AnyPgColumn, minimum = 1) =>
    check(name, sql`${column} BETWEEN ${minimum} AND 9007199254740991`);
  const validator = (name: string, ...args: (AnyPgColumn | SQL)[]) =>
    sql`${sql.identifier(schema.schemaName)}.${sql.identifier(name)}(${sql.join(args, sql`, `)}) IS TRUE`;
  const reference = (name: string, column: AnyPgColumn) =>
    check(name, validator("turn_journal_replay_reference_valid", sql`to_jsonb(${column})`));

  const turnJournalReplayLineage = schema.table(
    "turn_journal_replay_lineage",
    {
      ...scope(),
      lineageRef: text("lineage_ref").notNull(),
      lineageVersion: bigint("lineage_version", { mode: "number" }).notNull(),
      activationOperationRef: text("activation_operation_ref").notNull(),
      activationTransactionRef: text("activation_transaction_ref").notNull(),
      record: jsonb("record").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "turn_journal_replay_lineage_pk",
        columns: [table.installationId, table.lineageRef, table.lineageVersion],
      }),
      unique("turn_journal_replay_lineage_owner_unique").on(
        ...scopeColumns(table),
        table.lineageRef,
        table.lineageVersion,
      ),
      unique("turn_journal_replay_lineage_operation_unique").on(
        table.installationId,
        table.activationOperationRef,
      ),
      ...owner("turn_journal_replay_lineage_agent", table),
      reference("turn_journal_replay_lineage_ref", table.lineageRef),
      reference("turn_journal_replay_lineage_operation", table.activationOperationRef),
      reference("turn_journal_replay_lineage_transaction", table.activationTransactionRef),
      safeVersion("turn_journal_replay_lineage_version", table.lineageVersion),
      // A bounded object alone cannot supply the missing original clock schema.
      check(
        "turn_journal_replay_lineage_value",
        validator("turn_journal_replay_lineage_valid", table.record),
      ),
    ],
  );

  const turnJournalReplayHeads = schema.table(
    "turn_journal_replay_heads",
    {
      ...scope(),
      namespaceId: text("namespace_id"),
      agentId: text("agent_id"),
      channelInstallationId: text("channel_installation_id").notNull(),
      targetKey: text("target_key").notNull(),
      target: jsonb("target").notNull(),
      activatedTarget: jsonb("activated_target"),
      activatedTargetKey: text("activated_target_key"),
      capacitySlot: bigint("capacity_slot", { mode: "number" }).notNull(),
      reservationRef: text("reservation_ref").notNull(),
      reservationTransactionRef: text("reservation_transaction_ref").notNull(),
      state: text("state").$type<"reserved" | "active" | "retired">().notNull(),
      recordVersion: bigint("record_version", { mode: "number" }).notNull(),
      lineageRef: text("lineage_ref"),
      lineageVersion: bigint("lineage_version", { mode: "number" }),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "turn_journal_replay_heads_pk",
        columns: [table.installationId, table.targetKey],
      }),
      unique("turn_journal_replay_heads_activation_unique").on(
        table.installationId,
        table.activatedTargetKey,
      ),
      unique("turn_journal_replay_heads_slot_unique").on(table.installationId, table.capacitySlot),
      unique("turn_journal_replay_heads_reservation_unique").on(
        table.installationId,
        table.reservationRef,
      ),
      unique("turn_journal_replay_heads_owner_unique").on(...scopeColumns(table), table.targetKey),
      ...owner("turn_journal_replay_heads_agent", table),
      // The DDL defers this FK so the same owner can reserve a new channel
      // obligation before inserting its exact parent within the transaction.
      foreignKey({
        name: "turn_journal_replay_heads_channel",
        columns: [table.installationId, table.channelInstallationId],
        foreignColumns: [
          parents.channelInstallations.installationId,
          parents.channelInstallations.id,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      foreignKey({
        name: "turn_journal_replay_heads_lineage",
        columns: [...scopeColumns(table), table.lineageRef, table.lineageVersion],
        foreignColumns: [
          ...scopeColumns(turnJournalReplayLineage),
          turnJournalReplayLineage.lineageRef,
          turnJournalReplayLineage.lineageVersion,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      check(
        "turn_journal_replay_heads_capacity",
        sql`${table.capacitySlot} BETWEEN 1 AND ${TURN_JOURNAL_REPLAY_CAPACITY}`,
      ),
      reference("turn_journal_replay_heads_reservation", table.reservationRef),
      reference("turn_journal_replay_heads_transaction", table.reservationTransactionRef),
      safeVersion("turn_journal_replay_heads_version", table.recordVersion),
      check(
        "turn_journal_replay_heads_target",
        validator(
          "turn_journal_replay_reservation_valid",
          table.target,
          ...scopeColumns(table),
          table.channelInstallationId,
        ),
      ),
      check(
        "turn_journal_replay_heads_key",
        sql`${table.targetKey} ~ '^[0-9a-f]{64}$' AND ${table.targetKey} = ${sql.identifier(schema.schemaName)}.turn_journal_replay_digest(${table.target})`,
      ),
      check(
        "turn_journal_replay_heads_reserved_owner",
        sql`(${table.namespaceId} IS NULL) = (${table.agentId} IS NULL) AND (${table.state} <> 'reserved' OR CASE WHEN ${table.target}#>>'{subject,kind}' = 'channel-installation' THEN ${table.namespaceId} IS NULL AND ${table.agentId} IS NULL ELSE ${table.namespaceId} IS NOT NULL AND ${table.agentId} IS NOT NULL END)`,
      ),
      check(
        "turn_journal_replay_heads_activation_pair",
        sql`${table.activatedTarget} IS NULL OR (${validator("turn_journal_replay_activation_pair_valid", table.target, table.activatedTarget)} AND ${table.activatedTargetKey} = ${sql.identifier(schema.schemaName)}.turn_journal_replay_digest(${table.activatedTarget}) AND ${table.activatedTarget}->'scope' = jsonb_build_object('installationId',${table.installationId},'namespaceId',${table.namespaceId},'agentId',${table.agentId}))`,
      ),
      check(
        "turn_journal_replay_heads_state",
        sql`(${table.state} = 'reserved' AND ${table.lineageRef} IS NULL AND ${table.lineageVersion} IS NULL AND ${table.activatedTarget} IS NULL AND ${table.activatedTargetKey} IS NULL) OR (${table.state} IN ('active', 'retired') AND ${table.namespaceId} IS NOT NULL AND ${table.agentId} IS NOT NULL AND ${table.activatedTarget} IS NOT NULL AND ${table.activatedTargetKey} IS NOT NULL AND ${table.lineageRef} IS NOT NULL AND ${table.lineageVersion} IS NOT NULL AND ${table.lineageVersion} BETWEEN 1 AND 9007199254740991)`,
      ),
    ],
  );

  const turnJournalRetirementPublications = schema.table(
    "turn_journal_retirement_publications",
    {
      ...scope(),
      purgeOperationRef: text("purge_operation_ref").notNull(),
      originalTransactionRef: text("original_transaction_ref").notNull(),
      barrierRef: text("barrier_ref").notNull(),
      barrierVersion: bigint("barrier_version", { mode: "number" }).notNull(),
      lineageRef: text("lineage_ref").notNull(),
      lineageVersion: bigint("lineage_version", { mode: "number" }).notNull(),
      auditIntentRef: text("audit_intent_ref").notNull(),
      durableProgressResponsibilityRef: text("durable_progress_responsibility_ref").notNull(),
      recordVersion: bigint("record_version", { mode: "number" }).notNull(),
      record: jsonb("record").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "turn_journal_retirement_publications_pk",
        columns: [table.installationId, table.purgeOperationRef],
      }),
      unique("turn_journal_retirement_publications_barrier_unique").on(
        table.installationId,
        table.barrierRef,
        table.barrierVersion,
      ),
      unique("turn_journal_retirement_publications_transaction_unique").on(
        table.installationId,
        table.originalTransactionRef,
      ),
      unique("turn_journal_retirement_publications_owner_unique").on(
        ...scopeColumns(table),
        table.purgeOperationRef,
        table.barrierRef,
        table.barrierVersion,
        table.lineageRef,
        table.lineageVersion,
      ),
      ...owner("turn_journal_retirement_publications_agent", table),
      foreignKey({
        name: "turn_journal_retirement_publications_lineage",
        columns: [...scopeColumns(table), table.lineageRef, table.lineageVersion],
        foreignColumns: [
          ...scopeColumns(turnJournalReplayLineage),
          turnJournalReplayLineage.lineageRef,
          turnJournalReplayLineage.lineageVersion,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      safeVersion("turn_journal_retirement_publications_version", table.recordVersion),
      safeVersion("turn_journal_retirement_publications_barrier_version", table.barrierVersion),
      safeVersion("turn_journal_retirement_publications_lineage_version", table.lineageVersion),
      check(
        "turn_journal_retirement_publications_record",
        validator("turn_journal_retirement_record_valid", table.record),
      ),
      check(
        "turn_journal_retirement_publications_projection",
        sql`(${table.record}#>'{binding,scope}' = jsonb_build_object('installationId',${table.installationId},'namespaceId',${table.namespaceId},'agentId',${table.agentId}) AND ${table.record}#>>'{binding,manifest,purgeOperationRef}' = ${table.purgeOperationRef} AND ${table.record}#>>'{binding,originalTransactionRef}' = ${table.originalTransactionRef} AND ${table.record}#>>'{binding,barrierRef}' = ${table.barrierRef} AND ${table.record}#>'{binding,barrierVersion}' = to_jsonb(${table.barrierVersion}) AND ${table.record}#>>'{binding,activationReplayLineageRef}' = ${table.lineageRef} AND ${table.record}#>'{binding,activationReplayLineageVersion}' = to_jsonb(${table.lineageVersion}) AND ${table.record}->>'auditIntentRef' = ${table.auditIntentRef} AND ${table.record}->>'durableProgressResponsibilityRef' = ${table.durableProgressResponsibilityRef} AND ${table.record}#>'{progress,recordVersion}' = to_jsonb(${table.recordVersion})) IS TRUE`,
      ),
    ],
  );

  const publicationColumns = (
    table: Scope & {
      purgeOperationRef: AnyPgColumn;
      barrierRef: AnyPgColumn;
      barrierVersion: AnyPgColumn;
      lineageRef: AnyPgColumn;
      lineageVersion: AnyPgColumn;
    },
  ) =>
    [
      ...scopeColumns(table),
      table.purgeOperationRef,
      table.barrierRef,
      table.barrierVersion,
      table.lineageRef,
      table.lineageVersion,
    ] as const;
  const publicationScope = () => ({
    ...scope(),
    purgeOperationRef: text("purge_operation_ref").notNull(),
    barrierRef: text("barrier_ref").notNull(),
    barrierVersion: bigint("barrier_version", { mode: "number" }).notNull(),
    lineageRef: text("lineage_ref").notNull(),
    lineageVersion: bigint("lineage_version", { mode: "number" }).notNull(),
  });

  const turnJournalRetiredIdentities = schema.table(
    "turn_journal_retired_identities",
    {
      ...publicationScope(),
      identityKey: text("identity_key").notNull(),
      identity: jsonb("identity").notNull(),
      targetKey: text("target_key").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "turn_journal_retired_identities_pk",
        columns: [table.installationId, table.identityKey],
      }),
      unique("turn_journal_retired_identities_target_unique").on(
        table.installationId,
        table.targetKey,
      ),
      foreignKey({
        name: "turn_journal_retired_identities_head",
        columns: [...scopeColumns(table), table.targetKey],
        foreignColumns: [...scopeColumns(turnJournalReplayHeads), turnJournalReplayHeads.targetKey],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      foreignKey({
        name: "turn_journal_retired_identities_publication",
        columns: [...publicationColumns(table)],
        foreignColumns: [...publicationColumns(turnJournalRetirementPublications)],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      check(
        "turn_journal_retired_identities_value",
        validator(
          "turn_journal_replay_identity_valid",
          table.identity,
          sql`jsonb_build_object('installationId',${table.installationId},'namespaceId',${table.namespaceId},'agentId',${table.agentId})`,
        ),
      ),
      check(
        "turn_journal_retired_identities_key",
        sql`${table.identityKey} = ${sql.identifier(schema.schemaName)}.turn_journal_replay_digest(jsonb_build_object('scope',jsonb_build_object('installationId',${table.installationId},'namespaceId',${table.namespaceId},'agentId',${table.agentId}),'identity',${table.identity}))`,
      ),
    ],
  );

  const turnJournalRetirementObservations = schema.table(
    "turn_journal_retirement_observations",
    {
      ...publicationScope(),
      observationRef: text("observation_ref").notNull(),
      deletionOperationRef: text("deletion_operation_ref").notNull(),
      observationSequence: bigint("observation_sequence", { mode: "number" }).notNull(),
      originalTransactionRef: text("original_transaction_ref").notNull(),
      recordedAtRecordVersion: bigint("recorded_at_record_version", { mode: "number" }).notNull(),
      receipt: jsonb("receipt").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "turn_journal_retirement_observations_pk",
        columns: [table.installationId, table.purgeOperationRef, table.observationRef],
      }),
      unique("turn_journal_retirement_observations_sequence_unique").on(
        table.installationId,
        table.purgeOperationRef,
        table.deletionOperationRef,
        table.observationSequence,
      ),
      unique("turn_journal_retirement_observations_version_unique").on(
        table.installationId,
        table.purgeOperationRef,
        table.recordedAtRecordVersion,
      ),
      unique("turn_journal_retirement_observations_transaction_unique").on(
        table.installationId,
        table.originalTransactionRef,
      ),
      foreignKey({
        name: "turn_journal_retirement_observations_publication",
        columns: [...publicationColumns(table)],
        foreignColumns: [...publicationColumns(turnJournalRetirementPublications)],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      safeVersion("turn_journal_retirement_observations_sequence", table.observationSequence),
      safeVersion("turn_journal_retirement_observations_version", table.recordedAtRecordVersion, 2),
      check(
        "turn_journal_retirement_observations_receipt",
        validator("turn_journal_retirement_receipt_valid", table.receipt),
      ),
      check(
        "turn_journal_retirement_observations_projection",
        sql`(${table.receipt}#>'{binding,scope}' = jsonb_build_object('installationId',${table.installationId},'namespaceId',${table.namespaceId},'agentId',${table.agentId}) AND ${table.receipt}#>>'{binding,manifest,purgeOperationRef}' = ${table.purgeOperationRef} AND ${table.receipt}#>>'{binding,barrierRef}' = ${table.barrierRef} AND ${table.receipt}#>'{binding,barrierVersion}' = to_jsonb(${table.barrierVersion}) AND ${table.receipt}#>>'{binding,activationReplayLineageRef}' = ${table.lineageRef} AND ${table.receipt}#>'{binding,activationReplayLineageVersion}' = to_jsonb(${table.lineageVersion}) AND ${table.receipt}->>'originalTransactionRef' = ${table.originalTransactionRef} AND ${table.receipt}#>'{recordedAtRecordVersion}' = to_jsonb(${table.recordedAtRecordVersion}) AND ${table.receipt}#>>'{observation,observationRef}' = ${table.observationRef} AND ${table.receipt}#>>'{observation,deletionOperationRef}' = ${table.deletionOperationRef} AND ${table.receipt}#>'{observation,observationSequence}' = to_jsonb(${table.observationSequence})) IS TRUE`,
      ),
    ],
  );

  return {
    turnJournalReplayHeads,
    turnJournalReplayLineage,
    turnJournalRetiredIdentities,
    turnJournalRetirementPublications,
    turnJournalRetirementObservations,
  };
}
