import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  jsonb,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";

/** Construct once using the original canonical parents. The global record retains
 * the manifest and role definitions; revision-local Use/H remains in agent_revisions. */
export function createWorkloadProfileAdmissionTablesV2(
  schema: PgSchema,
  parents: Readonly<{
    installation: Readonly<{ id: AnyPgColumn }>;
    namespaces: Readonly<{ id: AnyPgColumn }>;
  }>,
) {
  const workloadProfileAdmissions = schema.table(
    "workload_profile_admissions",
    {
      installationId: text("installation_id")
        .notNull()
        .references(() => parents.installation.id, { onUpdate: "restrict", onDelete: "restrict" }),
      namespaceId: text("namespace_id")
        .notNull()
        .references(() => parents.namespaces.id, { onUpdate: "restrict", onDelete: "restrict" }),
      admissionRef: text("admission_ref").notNull(),
      admissionVersion: bigint("admission_version", { mode: "number" }).notNull(),
      state: text("state").notNull(),
      manifestRef: text("manifest_ref").notNull(),
      manifestDigest: text("manifest_digest").notNull(),
      record: jsonb("record").notNull(),
    },
    (table) => [
      primaryKey({
        name: "workload_profile_admissions_pk",
        columns: [table.installationId, table.admissionRef],
      }),
      unique("workload_profile_admissions_owner").on(
        table.installationId,
        table.namespaceId,
        table.admissionRef,
        table.manifestRef,
        table.manifestDigest,
      ),
      check(
        "workload_profile_admissions_version",
        sql`${table.admissionVersion} BETWEEN 1 AND 9007199254740991`,
      ),
      check("workload_profile_admissions_state", sql`${table.state} IN ('admitted','withdrawn')`),
      check(
        "workload_profile_admissions_selection",
        sql`occ.workload_profile_selection_valid_v1(jsonb_build_object(
      'manifestRef',${table.manifestRef},'manifestDigest',${table.manifestDigest},
      'admissionRef',${table.admissionRef},'admissionVersion',${table.admissionVersion}))`,
      ),
      check(
        "workload_profile_admissions_record",
        sql`occ.workload_profile_head_valid_v2(${table.record},${table.installationId},${table.namespaceId},${table.admissionRef},${table.admissionVersion},${table.state},${table.manifestRef},${table.manifestDigest})`,
      ),
    ],
  );
  const workloadProfileAdmissionHistory = schema.table(
    "workload_profile_admission_history",
    {
      installationId: text("installation_id").notNull(),
      namespaceId: text("namespace_id").notNull(),
      admissionRef: text("admission_ref").notNull(),
      admissionVersion: bigint("admission_version", { mode: "number" }).notNull(),
      manifestRef: text("manifest_ref").notNull(),
      manifestDigest: text("manifest_digest").notNull(),
      historyRef: text("history_ref").notNull(),
      record: jsonb("record").notNull(),
    },
    (table) => [
      primaryKey({
        name: "workload_profile_admission_history_pk",
        columns: [table.installationId, table.admissionRef, table.admissionVersion],
      }),
      unique("workload_profile_admission_history_ref").on(table.installationId, table.historyRef),
      foreignKey({
        name: "workload_profile_history_owner",
        columns: [
          table.installationId,
          table.namespaceId,
          table.admissionRef,
          table.manifestRef,
          table.manifestDigest,
        ],
        foreignColumns: [
          workloadProfileAdmissions.installationId,
          workloadProfileAdmissions.namespaceId,
          workloadProfileAdmissions.admissionRef,
          workloadProfileAdmissions.manifestRef,
          workloadProfileAdmissions.manifestDigest,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      check(
        "workload_profile_history_version",
        sql`${table.admissionVersion} BETWEEN 1 AND 9007199254740991`,
      ),
      check(
        "workload_profile_history_record",
        sql`(${table.record}=jsonb_build_object('schemaVersion',2,'historyRef',${table.historyRef},'head',${table.record}->'head')
      AND ${table.historyRef}=(CASE ${table.record}#>>'{head,state}' WHEN 'admitted' THEN ${table.record}#>>'{head,acceptance,historyRef}' ELSE ${table.record}#>>'{head,terminal,historyRef}' END)
      AND occ.workload_profile_head_valid_v2(${table.record}->'head',${table.installationId},${table.namespaceId},${table.admissionRef},${table.admissionVersion},${table.record}#>>'{head,state}',${table.manifestRef},${table.manifestDigest})) IS TRUE`,
      ),
      uniqueIndex("workload_profile_primary_command")
        .on(
          table.installationId,
          sql`(CASE ${table.record}#>>'{head,state}' WHEN 'admitted' THEN ${table.record}#>>'{head,acceptance,actor,principalRef}' ELSE ${table.record}#>>'{head,withdrawal,actor,principalRef}' END)`,
          sql`(CASE ${table.record}#>>'{head,state}' WHEN 'admitted' THEN ${table.record}#>>'{head,acceptance,operationRef}' ELSE ${table.record}#>>'{head,withdrawal,operationRef}' END)`,
        )
        .where(
          sql`${table.record}#>>'{head,state}'='admitted' OR ${table.record}#>>'{head,withdrawal,reason}'='withdrawn'`,
        ),
    ],
  );
  const workloadProfileInvalidations = schema.table(
    "workload_profile_invalidations",
    {
      installationId: text("installation_id").notNull(),
      namespaceId: text("namespace_id").notNull(),
      admissionRef: text("admission_ref").notNull(),
      admissionVersion: bigint("admission_version", { mode: "number" }).notNull(),
      manifestRef: text("manifest_ref").notNull(),
      manifestDigest: text("manifest_digest").notNull(),
      invalidationRef: text("invalidation_ref").notNull(),
      record: jsonb("record").notNull(),
    },
    (table) => [
      primaryKey({
        name: "workload_profile_invalidations_pk",
        columns: [table.installationId, table.invalidationRef],
      }),
      unique("workload_profile_invalidations_version").on(
        table.installationId,
        table.admissionRef,
        table.admissionVersion,
      ),
      foreignKey({
        name: "workload_profile_invalidation_owner",
        columns: [
          table.installationId,
          table.namespaceId,
          table.admissionRef,
          table.manifestRef,
          table.manifestDigest,
        ],
        foreignColumns: [
          workloadProfileAdmissions.installationId,
          workloadProfileAdmissions.namespaceId,
          workloadProfileAdmissions.admissionRef,
          workloadProfileAdmissions.manifestRef,
          workloadProfileAdmissions.manifestDigest,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      foreignKey({
        name: "workload_profile_invalidation_history",
        columns: [table.installationId, table.admissionRef, table.admissionVersion],
        foreignColumns: [
          workloadProfileAdmissionHistory.installationId,
          workloadProfileAdmissionHistory.admissionRef,
          workloadProfileAdmissionHistory.admissionVersion,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      check(
        "workload_profile_invalidation_version",
        sql`${table.admissionVersion} BETWEEN 2 AND 9007199254740991`,
      ),
      check(
        "workload_profile_invalidation_record",
        sql`(${table.record}=jsonb_build_object('schemaVersion',2,'kind','profile-admission-invalidated',
      'requestRef',${table.invalidationRef},'operationRef',${table.record}->>'operationRef','installationId',${table.installationId},'namespaceId',${table.namespaceId},
      'component','gateway-harness-pair','manifestRef',${table.manifestRef},'manifestDigest',${table.manifestDigest},'admissionRef',${table.admissionRef},
      'previousVersion',${table.admissionVersion}-1,'currentVersion',${table.admissionVersion},'reason',${table.record}->>'reason','acceptedAt',${table.record}->>'acceptedAt')
      AND ${table.record}->>'operationRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND ${table.record}->>'reason' IN ('withdrawn','replaced') AND occ.workload_profile_timestamp_valid_v2(${table.record}->>'acceptedAt')) IS TRUE`,
      ),
    ],
  );
  return {
    workloadProfileAdmissions,
    workloadProfileAdmissionHistory,
    workloadProfileInvalidations,
  };
}
