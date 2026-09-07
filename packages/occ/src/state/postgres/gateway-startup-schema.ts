import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  jsonb,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";

/** Original canonical parent objects are borrowed, never copied or reconstructed. */
export interface GatewayStartupSchemaParentsV1 {
  installation: { id: AnyPgColumn };
  auditEvents: { id: AnyPgColumn };
}

/** Database transition/append-only/deferred history guards are supplied by the matching forward migration. */
export function createGatewayStartupTablesV1(
  schema: PgSchema,
  parents: GatewayStartupSchemaParentsV1,
) {
  const gatewayStartupOperations = schema.table(
    "gateway_startup_operations",
    {
      installationId: text("installation_id")
        .notNull()
        .references(() => parents.installation.id, { onDelete: "restrict", onUpdate: "restrict" }),
      operationRef: text("operation_ref").primaryKey(),
      operationDigest: text("operation_digest").notNull(),
      canonicalCommand: text("canonical_command").notNull(),
      kind: text("kind").notNull(),
      startupOperationRef: text("startup_operation_ref").notNull(),
      startupOperationDigest: text("startup_operation_digest").notNull(),
      processRef: text("process_ref").notNull(),
      processGeneration: bigint("process_generation", { mode: "number" }).notNull(),
      createEffectRef: text("create_effect_ref").notNull(),
      beforeHeadVersion: bigint("before_head_version", { mode: "number" }).notNull(),
      afterHeadVersion: bigint("after_head_version", { mode: "number" }).notNull(),
      beforeRecordVersion: bigint("before_record_version", { mode: "number" }).notNull(),
      afterRecordVersion: bigint("after_record_version", { mode: "number" }).notNull(),
      previousOperationRef: text("previous_operation_ref"),
      auditEventId: text("audit_event_id")
        .notNull()
        .references(() => parents.auditEvents.id, { onDelete: "restrict", onUpdate: "restrict" }),
      record: jsonb("record").notNull(),
    },
    (table) => [
      check(
        "gateway_startup_operation_bounds",
        sql.raw(
          "(kind IN ('accept-startup','submit-create','consume-startup','withdraw')\n AND operation_digest ~ '^[0-9a-f]{64}$' AND startup_operation_digest ~ '^[0-9a-f]{64}$'\n AND process_generation BETWEEN 1 AND 9007199254740991\n AND before_head_version BETWEEN 0 AND 9007199254740990 AND after_head_version=before_head_version+1\n AND (previous_operation_ref IS NULL)=(before_head_version=0)\n AND ((kind='accept-startup' AND before_record_version=0 AND after_record_version=1)\n OR (kind='submit-create' AND before_record_version=1 AND after_record_version=2)\n OR (kind='consume-startup' AND before_record_version=2 AND after_record_version=3)\n OR (kind='withdraw' AND before_record_version BETWEEN 1 AND 3 AND after_record_version=before_record_version+1))\n AND octet_length(canonical_command) BETWEEN 1 AND 262144\n AND octet_length(record::text) BETWEEN 1 AND 524288) IS TRUE",
        ),
      ),
      check(
        "gateway_startup_refs",
        sql.raw(
          "((char_length(operation_ref) BETWEEN 1 AND 512 AND octet_length(operation_ref)<=2048 AND operation_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (char_length(startup_operation_ref) BETWEEN 1 AND 512 AND octet_length(startup_operation_ref)<=2048 AND startup_operation_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (char_length(process_ref) BETWEEN 1 AND 512 AND octet_length(process_ref)<=2048 AND process_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (char_length(create_effect_ref) BETWEEN 1 AND 512 AND octet_length(create_effect_ref)<=2048 AND create_effect_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (previous_operation_ref IS NULL OR (char_length(previous_operation_ref) BETWEEN 1 AND 512 AND octet_length(previous_operation_ref)<=2048))) IS TRUE",
        ),
      ),
      check(
        "gateway_startup_command_digest",
        sql.raw(
          "(operation_digest=encode(sha256(convert_to('{\"command\":'||canonical_command||',\"domain\":\"oce.installation-gateway.startup-operation.v1\"}', 'UTF8')), 'hex')) IS TRUE",
        ),
      ),
      check(
        "gateway_startup_record_core",
        sql.raw(
          "(record=jsonb_build_object('kind',kind,'command',jsonb_build_object('installationId',installation_id,'operationRef',operation_ref,'operationDigest',operation_digest,'startup',CASE WHEN kind='accept-startup' THEN 'null'::jsonb ELSE jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest) END),'canonicalCommand',canonical_command,'beforeHeadVersion',before_head_version,'afterHeadVersion',after_head_version,'beforeRecordVersion',before_record_version,'afterRecordVersion',after_record_version,'previousOperationRef',previous_operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'createEffectRef',create_effect_ref,'acceptance',record->'acceptance','submissionInput',record->'submissionInput','recipient',record->'recipient','withdrawalReason',record->'withdrawalReason','auditEventId',audit_event_id)) IS TRUE",
        ),
      ),
      check(
        "gateway_startup_command_core",
        sql.raw(
          "(CASE kind\n WHEN 'accept-startup' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'expectedHead',(canonical_command::jsonb)->'expectedHead','selectedDefinition',(canonical_command::jsonb)->'selectedDefinition','predecessorDisposition',(canonical_command::jsonb)->'predecessorDisposition')\n WHEN 'submit-create' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',(canonical_command::jsonb)->'expectedHead','input',record->'submissionInput')\n WHEN 'consume-startup' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',(canonical_command::jsonb)->'expectedHead','recipient',record->'recipient')\n WHEN 'withdraw' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',(canonical_command::jsonb)->'expectedHead','reason',record->'withdrawalReason') ELSE false END) IS TRUE",
        ),
      ),
      check(
        "gateway_startup_variant",
        sql.raw(
          "(CASE kind\n WHEN 'accept-startup' THEN startup_operation_ref=operation_ref AND startup_operation_digest=operation_digest\n AND record->'acceptance'=jsonb_build_object('binding',record#>'{acceptance,binding}','predecessor',record#>'{acceptance,predecessor}','auditEventId',audit_event_id)\n AND record#>'{acceptance,binding,startup}'=jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest)\n AND record#>'{acceptance,binding,createEffectRef}'=to_jsonb(create_effect_ref)\n AND record#>'{acceptance,binding,selection}'=(canonical_command::jsonb)->'selectedDefinition'\n AND record#>'{acceptance,predecessor,disposition}'=(canonical_command::jsonb)->'predecessorDisposition'\n AND record#>'{acceptance,predecessor}'=jsonb_build_object('disposition',record#>'{acceptance,predecessor,disposition}','previousStartup',record#>'{acceptance,predecessor,previousStartup}','processOwner',record#>'{acceptance,predecessor,processOwner}','settlement',record#>'{acceptance,predecessor,settlement}')\n AND record->'submissionInput'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb\n WHEN 'submit-create' THEN record->'acceptance'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb\n AND record->'submissionInput'=jsonb_build_object('binding',record#>'{submissionInput,binding}','target',record#>'{submissionInput,target}','launchPlan',record#>'{submissionInput,launchPlan}')\n AND record#>'{submissionInput,binding,startup}'=jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest) AND record#>'{submissionInput,binding,createEffectRef}'=to_jsonb(create_effect_ref)\n WHEN 'consume-startup' THEN record->'acceptance'='null'::jsonb AND record->'submissionInput'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb AND jsonb_typeof(record->'recipient')='object'\n WHEN 'withdraw' THEN record->'acceptance'='null'::jsonb AND record->'submissionInput'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->>'withdrawalReason' IN ('administrative','selection-withdrawn','recipient-revoked')\n ELSE false END) IS TRUE",
        ),
      ),
      unique("gateway_startup_operation_scope").on(table.installationId, table.operationRef),
      unique("gateway_startup_operation_version").on(
        table.installationId,
        table.operationRef,
        table.afterHeadVersion,
      ),
      unique("gateway_startup_head_version_unique").on(
        table.installationId,
        table.afterHeadVersion,
      ),
      unique("gateway_startup_audit_unique").on(table.auditEventId),
      uniqueIndex("gateway_startup_generation_unique")
        .on(table.installationId, table.processGeneration)
        .where(sql`${table.kind}='accept-startup'`),
      uniqueIndex("gateway_startup_process_unique")
        .on(table.processRef)
        .where(sql`${table.kind}='accept-startup'`),
      uniqueIndex("gateway_startup_effect_unique")
        .on(table.createEffectRef)
        .where(sql`${table.kind}='accept-startup'`),
      uniqueIndex("gateway_startup_submission_unique")
        .on(table.installationId, table.startupOperationRef)
        .where(sql`${table.kind}='submit-create'`),
      uniqueIndex("gateway_startup_consume_unique")
        .on(table.installationId, table.startupOperationRef)
        .where(sql`${table.kind}='consume-startup'`),
      uniqueIndex("gateway_startup_withdraw_unique")
        .on(table.installationId, table.startupOperationRef)
        .where(sql`${table.kind}='withdraw'`),
    ],
  );
  const gatewayStartupHeads = schema.table(
    "gateway_startup_heads",
    {
      installationId: text("installation_id")
        .primaryKey()
        .references(() => parents.installation.id, { onDelete: "restrict", onUpdate: "restrict" }),
      headVersion: bigint("head_version", { mode: "number" }).notNull(),
      processGeneration: bigint("process_generation", { mode: "number" }).notNull(),
      latestOperationRef: text("latest_operation_ref"),
      startupOperationRef: text("startup_operation_ref"),
      recordVersion: bigint("record_version", { mode: "number" }).notNull(),
      state: text("state").notNull(),
    },
    () => [
      check(
        "gateway_startup_head_shape",
        sql.raw(
          "((state='empty' AND head_version=0 AND process_generation=0 AND latest_operation_ref IS NULL AND startup_operation_ref IS NULL AND record_version=0)\n OR (head_version BETWEEN 1 AND 9007199254740991 AND process_generation BETWEEN 1 AND 9007199254740991 AND latest_operation_ref IS NOT NULL AND startup_operation_ref IS NOT NULL AND ((state='accepted' AND record_version=1) OR (state='create-submitted' AND record_version=2) OR (state='consumed' AND record_version=3) OR (state='withdrawn' AND record_version BETWEEN 2 AND 4)))) IS TRUE",
        ),
      ),
    ],
  );
  // Drizzle does not express these deferred cyclic FKs. The fixed migration
  // supplies them together with immutable event and final head/history guards.
  return { gatewayStartupHeads, gatewayStartupOperations };
}
