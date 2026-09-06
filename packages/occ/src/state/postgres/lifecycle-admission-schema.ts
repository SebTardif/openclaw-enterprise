import type { LifecycleMutationRequestV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import { LIFECYCLE_ADMISSION_LIMITS_V1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  type AnyPgColumn,
  type PgSchema,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";

/** The composition root supplies the original schema and parent table objects.
 * Scope follows the existing singleton Installation and canonical intent. */
export interface LifecycleAdmissionSchemaParents {
  installation: { id: AnyPgColumn };
  namespaces: { id: AnyPgColumn };
  agents: { namespaceId: AnyPgColumn; id: AnyPgColumn };
  agentRuntimeIntents: {
    namespaceId: AnyPgColumn;
    agentId: AnyPgColumn;
    generation: AnyPgColumn;
    transitionRef: AnyPgColumn;
  };
  controllerWork: { idempotencyKey: AnyPgColumn };
  auditEvents: { id: AnyPgColumn };
  runtimeAssignmentAllocations: {
    installationId: AnyPgColumn;
    namespaceId: AnyPgColumn;
    agentId: AnyPgColumn;
    assignmentRef: AnyPgColumn;
  };
}

const referencePattern = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/** These retained records create no worker, exporter, cleanup or cutover authority. */
export function createLifecycleAdmissionTables(
  schema: PgSchema,
  parents: LifecycleAdmissionSchemaParents,
) {
  const agentLifecycleAdmissions = schema.table(
    "agent_lifecycle_admissions",
    {
      operationRef: text("operation_ref").primaryKey(),
      installationId: text("installation_id").notNull(),
      namespaceId: text("namespace_id").notNull(),
      agentId: text("agent_id").notNull(),
      lifecycleGeneration: bigint("lifecycle_generation", { mode: "number" }).notNull(),
      kind: text("kind").$type<"disable" | "stop">().notNull(),
      expectedGeneration: bigint("expected_generation", { mode: "number" }),
      canonicalRequest: jsonb("canonical_request")
        .$type<Extract<LifecycleMutationRequestV1, { kind: "disable" | "stop" }>>()
        .notNull(),
      auditEventId: text("audit_event_id").notNull(),
      workId: text("work_id").notNull(),
      responsibilityRef: text("responsibility_ref").notNull(),
      responsibilityVersion: bigint("responsibility_version", { mode: "number" })
        .$type<1>()
        .notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      unique("lifecycle_admissions_intent_identity_unique").on(
        table.namespaceId,
        table.agentId,
        table.lifecycleGeneration,
        table.operationRef,
      ),
      unique("lifecycle_admissions_audit_unique").on(table.auditEventId),
      unique("lifecycle_admissions_work_unique").on(table.workId),
      unique("lifecycle_admissions_responsibility_unique").on(
        table.responsibilityRef,
        table.responsibilityVersion,
      ),
      foreignKey({
        name: "lifecycle_admissions_intent_owner",
        columns: [table.namespaceId, table.agentId, table.lifecycleGeneration, table.operationRef],
        foreignColumns: [
          parents.agentRuntimeIntents.namespaceId,
          parents.agentRuntimeIntents.agentId,
          parents.agentRuntimeIntents.generation,
          parents.agentRuntimeIntents.transitionRef,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      foreignKey({
        name: "lifecycle_admissions_installation_owner",
        columns: [table.installationId],
        foreignColumns: [parents.installation.id],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      foreignKey({
        name: "lifecycle_admissions_audit_owner",
        columns: [table.auditEventId],
        foreignColumns: [parents.auditEvents.id],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      // Drizzle has no deferrability setting. The migration declares these three
      // cyclic correspondence FKs DEFERRABLE INITIALLY DEFERRED.
      foreignKey({
        name: "lifecycle_admissions_work_owner",
        columns: [table.workId],
        foreignColumns: [parents.controllerWork.idempotencyKey],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      foreignKey({
        name: "lifecycle_admissions_responsibility_owner",
        columns: [table.responsibilityRef, table.responsibilityVersion],
        foreignColumns: [
          runtimeCleanupResponsibilities.responsibilityRef,
          runtimeCleanupResponsibilities.responsibilityVersion,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      foreignKey({
        name: "lifecycle_admissions_export_owner",
        columns: [table.auditEventId],
        foreignColumns: [auditExportOutbox.auditEventId],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      check("lifecycle_admissions_operation_ref", sql`${table.operationRef} ~ ${referencePattern}`),
      check(
        "lifecycle_admissions_generation",
        sql`${table.lifecycleGeneration} BETWEEN 1 AND 9007199254740991`,
      ),
      check("lifecycle_admissions_kind", sql`${table.kind} IN ('disable', 'stop')`),
      check(
        "lifecycle_admissions_expected_generation",
        sql`${table.expectedGeneration} IS NULL OR ${table.expectedGeneration} BETWEEN 1 AND 9007199254740991`,
      ),
      check(
        "lifecycle_admissions_request",
        sql`(${table.canonicalRequest} = jsonb_build_object(
          'schemaVersion', 1,
          'kind', ${table.kind},
          'namespaceId', ${table.namespaceId},
          'agentId', ${table.agentId},
          'expectedLifecycleGeneration', ${table.expectedGeneration})
          AND octet_length(${table.canonicalRequest}::text) BETWEEN 1 AND ${LIFECYCLE_ADMISSION_LIMITS_V1.maxJsonBytes}
        ) IS TRUE`,
      ),
      check(
        "lifecycle_admissions_work_id",
        sql`char_length(${table.workId}) BETWEEN 1 AND ${LIFECYCLE_ADMISSION_LIMITS_V1.maxWorkIdCharacters}
          AND btrim(${table.workId}, U&'\\0009\\000a\\000b\\000c\\000d\\0020\\00a0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200a\\2028\\2029\\202f\\205f\\3000\\feff') = ${table.workId}
          AND ${table.workId} !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
      ),
      check(
        "lifecycle_admissions_responsibility_ref",
        sql`${table.responsibilityRef} ~ ${referencePattern}`,
      ),
      check("lifecycle_admissions_responsibility_version", sql`${table.responsibilityVersion} = 1`),
    ],
  );

  const runtimeCleanupResponsibilities = schema.table(
    "runtime_cleanup_responsibilities",
    {
      responsibilityRef: text("responsibility_ref").notNull(),
      responsibilityVersion: bigint("responsibility_version", { mode: "number" })
        .$type<1>()
        .notNull(),
      originKind: text("origin_kind").$type<"lifecycle-protective-v1">().notNull(),
      originOperationRef: text("origin_operation_ref").notNull(),
      installationId: text("installation_id").notNull(),
      namespaceId: text("namespace_id").notNull(),
      agentId: text("agent_id").notNull(),
      lifecycleGeneration: bigint("lifecycle_generation", { mode: "number" }).notNull(),
      kind: text("kind").$type<"protective-fence" | "retained-stop">().notNull(),
      predecessorRef: text("predecessor_ref"),
      predecessorGeneration: bigint("predecessor_generation", { mode: "number" }),
      inventoryStatus: text("inventory_status")
        .$type<"unresolved">()
        .notNull()
        .default("unresolved"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "runtime_cleanup_responsibilities_pk",
        columns: [table.responsibilityRef, table.responsibilityVersion],
      }),
      unique("runtime_cleanup_responsibilities_origin_unique").on(
        table.originKind,
        table.originOperationRef,
        table.responsibilityVersion,
      ),
      unique("runtime_cleanup_responsibilities_owner_unique").on(
        table.installationId,
        table.namespaceId,
        table.agentId,
        table.responsibilityRef,
        table.responsibilityVersion,
      ),
      foreignKey({
        name: "runtime_cleanup_responsibilities_intent_owner",
        columns: [
          table.namespaceId,
          table.agentId,
          table.lifecycleGeneration,
          table.originOperationRef,
        ],
        foreignColumns: [
          parents.agentRuntimeIntents.namespaceId,
          parents.agentRuntimeIntents.agentId,
          parents.agentRuntimeIntents.generation,
          parents.agentRuntimeIntents.transitionRef,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      foreignKey({
        name: "runtime_cleanup_responsibilities_predecessor_owner",
        columns: [
          table.namespaceId,
          table.agentId,
          table.predecessorGeneration,
          table.predecessorRef,
        ],
        foreignColumns: [
          parents.agentRuntimeIntents.namespaceId,
          parents.agentRuntimeIntents.agentId,
          parents.agentRuntimeIntents.generation,
          parents.agentRuntimeIntents.transitionRef,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      foreignKey({
        name: "runtime_cleanup_responsibilities_installation_owner",
        columns: [table.installationId],
        foreignColumns: [parents.installation.id],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      // The migration makes this fourth cyclic FK DEFERRABLE INITIALLY DEFERRED.
      foreignKey({
        name: "runtime_cleanup_responsibilities_admission_owner",
        columns: [table.originOperationRef],
        foreignColumns: [agentLifecycleAdmissions.operationRef],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      check(
        "runtime_cleanup_responsibilities_ref",
        sql`${table.responsibilityRef} ~ ${referencePattern}`,
      ),
      check("runtime_cleanup_responsibilities_version", sql`${table.responsibilityVersion} = 1`),
      check(
        "runtime_cleanup_responsibilities_origin",
        sql`${table.originKind} = 'lifecycle-protective-v1' AND ${table.originOperationRef} ~ ${referencePattern}`,
      ),
      check(
        "runtime_cleanup_responsibilities_generation",
        sql`${table.lifecycleGeneration} BETWEEN 1 AND 9007199254740991`,
      ),
      check(
        "runtime_cleanup_responsibilities_kind",
        sql`${table.kind} IN ('protective-fence', 'retained-stop')`,
      ),
      check(
        "runtime_cleanup_responsibilities_predecessor",
        sql`((${table.predecessorRef} IS NULL AND ${table.predecessorGeneration} IS NULL)
          OR (${table.predecessorRef} IS NOT NULL AND ${table.predecessorGeneration} IS NOT NULL
            AND ${table.predecessorRef} ~ ${referencePattern}
            AND ${table.predecessorGeneration} BETWEEN 1 AND 9007199254740991)) IS TRUE`,
      ),
      check(
        "runtime_cleanup_responsibilities_inventory",
        sql`${table.inventoryStatus} = 'unresolved'`,
      ),
      check("runtime_cleanup_responsibilities_created_at", sql`isfinite(${table.createdAt})`),
    ],
  );

  const runtimeCleanupResponsibilityAllocations = schema.table(
    "runtime_cleanup_responsibility_allocations",
    {
      responsibilityRef: text("responsibility_ref").notNull(),
      responsibilityVersion: bigint("responsibility_version", { mode: "number" })
        .$type<1>()
        .notNull(),
      installationId: text("installation_id").notNull(),
      namespaceId: text("namespace_id").notNull(),
      agentId: text("agent_id").notNull(),
      assignmentRef: text("assignment_ref").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "runtime_cleanup_responsibility_allocations_pk",
        columns: [table.responsibilityRef, table.responsibilityVersion, table.assignmentRef],
      }),
      foreignKey({
        name: "runtime_cleanup_allocations_responsibility_owner",
        columns: [
          table.installationId,
          table.namespaceId,
          table.agentId,
          table.responsibilityRef,
          table.responsibilityVersion,
        ],
        foreignColumns: [
          runtimeCleanupResponsibilities.installationId,
          runtimeCleanupResponsibilities.namespaceId,
          runtimeCleanupResponsibilities.agentId,
          runtimeCleanupResponsibilities.responsibilityRef,
          runtimeCleanupResponsibilities.responsibilityVersion,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      foreignKey({
        name: "runtime_cleanup_allocations_assignment_owner",
        columns: [table.installationId, table.namespaceId, table.agentId, table.assignmentRef],
        foreignColumns: [
          parents.runtimeAssignmentAllocations.installationId,
          parents.runtimeAssignmentAllocations.namespaceId,
          parents.runtimeAssignmentAllocations.agentId,
          parents.runtimeAssignmentAllocations.assignmentRef,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      check(
        "runtime_cleanup_allocations_references",
        sql`${table.responsibilityRef} ~ ${referencePattern} AND ${table.assignmentRef} ~ ${referencePattern}`,
      ),
      check("runtime_cleanup_allocations_version", sql`${table.responsibilityVersion} = 1`),
    ],
  );

  const auditExportOutbox = schema.table(
    "audit_export_outbox",
    {
      auditEventId: text("audit_event_id").primaryKey(),
      installationId: text("installation_id").notNull(),
      namespaceId: text("namespace_id").notNull(),
      originKind: text("origin_kind").$type<"lifecycle-protective-v1">().notNull(),
      originOperationRef: text("origin_operation_ref").notNull(),
      state: text("state").$type<"pending">().notNull().default("pending"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      unique("audit_export_outbox_origin_unique").on(table.originKind, table.originOperationRef),
      foreignKey({
        name: "audit_export_outbox_audit_owner",
        columns: [table.auditEventId],
        foreignColumns: [parents.auditEvents.id],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      foreignKey({
        name: "audit_export_outbox_installation_owner",
        columns: [table.installationId],
        foreignColumns: [parents.installation.id],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      foreignKey({
        name: "audit_export_outbox_intent_owner",
        columns: [table.originOperationRef],
        foreignColumns: [parents.agentRuntimeIntents.transitionRef],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      check(
        "audit_export_outbox_origin",
        sql`${table.originKind} = 'lifecycle-protective-v1' AND ${table.originOperationRef} ~ ${referencePattern}`,
      ),
      check("audit_export_outbox_state", sql`${table.state} = 'pending'`),
      check("audit_export_outbox_created_at", sql`isfinite(${table.createdAt})`),
    ],
  );

  const lifecycleCapabilities = schema.table(
    "lifecycle_capabilities",
    {
      installationId: text("installation_id").primaryKey(),
      schemaVersion: smallint("schema_version").$type<1>().notNull().default(1),
      protocol: text("protocol")
        .$type<"lifecycle-control-v1">()
        .notNull()
        .default("lifecycle-control-v1"),
      stage: text("stage").$type<"legacy" | "drain" | "live">().notNull().default("legacy"),
      capabilityVersion: bigint("capability_version", { mode: "number" }).notNull().default(1),
      apiVersion: smallint("api_version").$type<1>(),
      workerVersion: smallint("worker_version").$type<1>(),
      maintenanceVersion: smallint("maintenance_version").$type<1>(),
      receivingVersion: smallint("receiving_version").$type<1>(),
    },
    (table): PgTableExtraConfigValue[] => [
      foreignKey({
        name: "lifecycle_capabilities_installation_owner",
        columns: [table.installationId],
        foreignColumns: [parents.installation.id],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      check("lifecycle_capabilities_schema_version", sql`${table.schemaVersion} = 1`),
      check("lifecycle_capabilities_protocol", sql`${table.protocol} = 'lifecycle-control-v1'`),
      check("lifecycle_capabilities_stage", sql`${table.stage} IN ('legacy', 'drain', 'live')`),
      check(
        "lifecycle_capabilities_version",
        sql`${table.capabilityVersion} BETWEEN 1 AND 9007199254740991`,
      ),
      check(
        "lifecycle_capabilities_consumer_versions",
        sql`(${table.apiVersion} IS NULL OR ${table.apiVersion} = 1)
          AND (${table.workerVersion} IS NULL OR ${table.workerVersion} = 1)
          AND (${table.maintenanceVersion} IS NULL OR ${table.maintenanceVersion} = 1)
          AND (${table.receivingVersion} IS NULL OR ${table.receivingVersion} = 1)`,
      ),
      check(
        "lifecycle_capabilities_stage_consumers",
        sql`((${table.stage} = 'legacy'
          OR (${table.apiVersion} = 1 AND ${table.workerVersion} = 1 AND ${table.receivingVersion} = 1))
          AND (${table.stage} <> 'live' OR ${table.maintenanceVersion} = 1)) IS TRUE`,
      ),
    ],
  );

  // The companion migration enforces immutable history, exact correspondence,
  // pristine work, lineage and the serialized capability barrier with triggers.
  return {
    agentLifecycleAdmissions,
    runtimeCleanupResponsibilities,
    runtimeCleanupResponsibilityAllocations,
    auditExportOutbox,
    lifecycleCapabilities,
  };
}

export type LifecycleAdmissionTables = ReturnType<typeof createLifecycleAdmissionTables>;
