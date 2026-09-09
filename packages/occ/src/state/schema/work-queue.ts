import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn, PgTableExtraConfigValue } from "drizzle-orm/pg-core";

type CanonicalOccSchema = typeof import("./shared.ts").occSchema;
type WorkSchemaParents = Readonly<{
  namespaces: Readonly<{ id: AnyPgColumn }>;
  agents: Readonly<{ namespaceId: AnyPgColumn; id: AnyPgColumn }>;
  agentRevisions: Readonly<{ namespaceId: AnyPgColumn; agentId: AnyPgColumn; id: AnyPgColumn }>;
}>;
type RuntimeAdmissionReferences = Readonly<{
  agentRevisionRuntimeAdmissions: Readonly<{
    namespaceId: AnyPgColumn;
    agentId: AnyPgColumn;
    revisionId: AnyPgColumn;
    runtimeTransitionRef: AnyPgColumn;
    lifecycleGeneration: AnyPgColumn;
  }>;
  runtimeReferencePattern: string;
}>;
type LifecycleAdmissionColumns = Readonly<{
  namespaceId: AnyPgColumn;
  agentId: AnyPgColumn;
  lifecycleGeneration: AnyPgColumn;
  operationRef: AnyPgColumn;
}>;

export function createControllerWorkTable(
  occSchema: CanonicalOccSchema,
  parents: WorkSchemaParents,
  readRuntimeAdmissionReferences: () => RuntimeAdmissionReferences,
  readLifecycleAdmissions: () => LifecycleAdmissionColumns,
) {
  const { namespaces, agents, agentRevisions } = parents;

  const controllerWork = occSchema.table(
    "controller_work",
    {
      idempotencyKey: text("idempotency_key").primaryKey(),
      namespaceId: text("namespace_id")
        .notNull()
        .references(() => namespaces.id, { onDelete: "restrict", onUpdate: "restrict" }),
      agentId: text("agent_id"),
      revisionId: text("revision_id"),
      actorId: text("actor_id").notNull(),
      namespaceTarget: text("namespace_target"),
      runtimeTransitionRef: text("runtime_transition_ref"),
      lifecycleGeneration: bigint("lifecycle_generation", { mode: "number" }),
      workSchemaVersion: smallint("work_schema_version")
        .$type<0 | 1 | 2 | 3>()
        .notNull()
        .default(0),
      handler: text("handler").$type<
        "ReconcileAgentLifecycleV1" | "ReconcileRuntimeFaultV1" | "ReconcileRuntimeProfileV1"
      >(),
      profileWork: jsonb("profile_work"),
      faultWork: jsonb("fault_work"),
      legacyRuntimeTransitionRef: text("legacy_runtime_transition_ref").generatedAlwaysAs(
        sql`CASE WHEN work_schema_version = 0 THEN runtime_transition_ref ELSE NULL END`,
      ),
      lifecycleOperationRef: text("lifecycle_operation_ref").generatedAlwaysAs(
        sql`CASE WHEN work_schema_version = 1 THEN runtime_transition_ref ELSE NULL END`,
      ),
      state: text("state").notNull().default("queued"),
      availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
      attemptCount: integer("attempt_count").notNull().default(0),
      claimToken: uuid("claim_token"),
      leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
      completedAt: timestamp("completed_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    },
    (table): PgTableExtraConfigValue[] => {
      // Both admission tables are constructed later in the canonical aggregate.
      const { agentRevisionRuntimeAdmissions, runtimeReferencePattern } =
        readRuntimeAdmissionReferences();
      const agentLifecycleAdmissions = readLifecycleAdmissions();
      return [
        foreignKey({
          name: "controller_work_agent_owner",
          columns: [table.namespaceId, table.agentId],
          foreignColumns: [agents.namespaceId, agents.id],
        })
          .onUpdate("restrict")
          .onDelete("restrict"),
        foreignKey({
          name: "controller_work_runtime_admission_owner",
          columns: [
            table.namespaceId,
            table.agentId,
            table.revisionId,
            table.legacyRuntimeTransitionRef,
            table.lifecycleGeneration,
          ],
          foreignColumns: [
            agentRevisionRuntimeAdmissions.namespaceId,
            agentRevisionRuntimeAdmissions.agentId,
            agentRevisionRuntimeAdmissions.revisionId,
            agentRevisionRuntimeAdmissions.runtimeTransitionRef,
            agentRevisionRuntimeAdmissions.lifecycleGeneration,
          ],
        })
          .onUpdate("restrict")
          .onDelete("restrict"),
        foreignKey({
          name: "controller_work_lifecycle_admission_owner",
          columns: [
            table.namespaceId,
            table.agentId,
            table.lifecycleGeneration,
            table.lifecycleOperationRef,
          ],
          foreignColumns: [
            agentLifecycleAdmissions.namespaceId,
            agentLifecycleAdmissions.agentId,
            agentLifecycleAdmissions.lifecycleGeneration,
            agentLifecycleAdmissions.operationRef,
          ],
        })
          .onUpdate("restrict")
          .onDelete("restrict"),
        check(
          "controller_work_runtime_pair_valid",
          sql`(${table.workSchemaVersion} = 0 AND ${table.handler} IS NULL AND ${table.faultWork} IS NULL AND ${table.profileWork} IS NULL AND (
          (${table.runtimeTransitionRef} IS NULL AND ${table.lifecycleGeneration} IS NULL)
          OR (${table.runtimeTransitionRef} IS NOT NULL AND ${table.lifecycleGeneration} IS NOT NULL
            AND ${table.agentId} IS NOT NULL AND ${table.revisionId} IS NOT NULL
            AND ${table.namespaceTarget} IS NULL
            AND ${table.runtimeTransitionRef} ~ ${runtimeReferencePattern}
            AND ${table.lifecycleGeneration} BETWEEN 1 AND 9007199254740991)))
        OR (${table.workSchemaVersion} IN (1,2,3) AND ${table.handler} IS NOT NULL
          AND ((${table.workSchemaVersion}=1 AND ${table.handler}='ReconcileAgentLifecycleV1' AND ${table.faultWork} IS NULL AND ${table.profileWork} IS NULL)
            OR (${table.workSchemaVersion}=2 AND ${table.handler}='ReconcileRuntimeFaultV1' AND ${table.faultWork} IS NOT NULL AND ${table.profileWork} IS NULL)
            OR (${table.workSchemaVersion}=3 AND ${table.handler}='ReconcileRuntimeProfileV1' AND ${table.faultWork} IS NULL AND ${table.profileWork} IS NOT NULL))
          AND ${table.runtimeTransitionRef} IS NOT NULL AND ${table.lifecycleGeneration} IS NOT NULL
          AND ${table.agentId} IS NOT NULL
          AND ${table.namespaceTarget} IS NULL
          AND ${table.runtimeTransitionRef} ~ ${runtimeReferencePattern}
          AND ${table.lifecycleGeneration} BETWEEN 1 AND 9007199254740991)`,
        ),
        foreignKey({
          name: "controller_work_revision_owner",
          columns: [table.namespaceId, table.agentId, table.revisionId],
          foreignColumns: [agentRevisions.namespaceId, agentRevisions.agentId, agentRevisions.id],
        })
          .onUpdate("restrict")
          .onDelete("restrict"),
        check(
          "controller_work_idempotency_key_length",
          sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 512`,
        ),
        check(
          "controller_work_state_valid",
          sql`${table.state} IN ('queued', 'claimed', 'succeeded', 'failed_permanent')`,
        ),
        check("controller_work_attempt_count_valid", sql`${table.attemptCount} >= 0`),
        check(
          "controller_work_revision_requires_agent",
          sql`${table.revisionId} IS NULL OR ${table.agentId} IS NOT NULL`,
        ),
        check(
          "controller_work_namespace_target_valid",
          sql`(${table.workSchemaVersion} = 0 AND ${table.handler} IS NULL AND ${table.faultWork} IS NULL AND ${table.profileWork} IS NULL AND (
          (${table.agentId} IS NULL AND ${table.revisionId} IS NULL
            AND ${table.namespaceTarget} IS NOT NULL
            AND ${table.namespaceTarget} IN ('ready', 'deleted'))
          OR (${table.agentId} IS NOT NULL AND ${table.revisionId} IS NOT NULL
            AND ${table.namespaceTarget} IS NULL)))
        OR (${table.workSchemaVersion} IN (1,2,3) AND ${table.handler} IS NOT NULL
          AND ((${table.workSchemaVersion}=1 AND ${table.handler}='ReconcileAgentLifecycleV1' AND ${table.faultWork} IS NULL AND ${table.profileWork} IS NULL)
            OR (${table.workSchemaVersion}=2 AND ${table.handler}='ReconcileRuntimeFaultV1' AND ${table.faultWork} IS NOT NULL AND ${table.profileWork} IS NULL)
            OR (${table.workSchemaVersion}=3 AND ${table.handler}='ReconcileRuntimeProfileV1' AND ${table.faultWork} IS NULL AND ${table.profileWork} IS NOT NULL))
          AND ${table.agentId} IS NOT NULL AND ${table.namespaceTarget} IS NULL)`,
        ),
        check(
          "controller_work_claim_state",
          sql`(
        (${table.state} = 'claimed'
          AND ${table.claimToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
        OR (${table.state} <> 'claimed'
          AND ${table.claimToken} IS NULL AND ${table.leaseExpiresAt} IS NULL)
      )`,
        ),
        check(
          "controller_work_completion_state",
          sql`(
        (${table.state} IN ('succeeded', 'failed_permanent')
          AND ${table.completedAt} IS NOT NULL)
        OR (${table.state} NOT IN ('succeeded', 'failed_permanent')
          AND ${table.completedAt} IS NULL)
      )`,
        ),
        index("controller_work_ready")
          .on(table.availableAt, table.createdAt, table.idempotencyKey)
          .where(sql`${table.state} = 'queued'`),
        index("controller_work_expired")
          .on(table.leaseExpiresAt, table.idempotencyKey)
          .where(sql`${table.state} = 'claimed'`),
        uniqueIndex("controller_work_one_claim_per_resource")
          .on(sql`COALESCE(${table.agentId}, ${table.namespaceId})`)
          .where(sql`${table.state} = 'claimed'`),
      ];
    },
  );

  return controllerWork;
}
