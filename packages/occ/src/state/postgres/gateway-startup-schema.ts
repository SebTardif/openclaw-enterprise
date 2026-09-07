import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  jsonb,
  primaryKey,
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

/** V2 borrows the original agents_namespace_id_id_unique parent columns. */
export interface GatewayStartupSchemaParentsV2 extends GatewayStartupSchemaParentsV1 {
  agents: { namespaceId: AnyPgColumn; id: AnyPgColumn };
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

/** Matching private forward SQL installs these two versioned tables instead of
 * the V1 factory. Never register both factories. Checks enforce stored identity;
 * genuine selection, physical disposition and current authority remain owner work. */
const gatewayStartupChecksV2 = {
  gateway_startup_operation_bounds:
    "(kind IN ('accept-startup','submit-create','consume-startup','withdraw')\n AND operation_digest ~ '^[0-9a-f]{64}$' AND startup_operation_digest ~ '^[0-9a-f]{64}$'\n AND process_generation BETWEEN 1 AND 9007199254740991\n AND before_head_version BETWEEN 0 AND 9007199254740990 AND after_head_version=before_head_version+1\n AND (previous_operation_ref IS NULL)=(before_head_version=0)\n AND ((kind='accept-startup' AND before_record_version=0 AND after_record_version=1)\n OR (kind='submit-create' AND before_record_version=1 AND after_record_version=2)\n OR (kind='consume-startup' AND before_record_version=2 AND after_record_version=3)\n OR (kind='withdraw' AND before_record_version BETWEEN 1 AND 3 AND after_record_version=before_record_version+1))\n AND octet_length(canonical_command) BETWEEN 1 AND 262144\n AND octet_length(record::text) BETWEEN 1 AND 524288) IS TRUE",
  gateway_startup_refs:
    "((char_length(operation_ref) BETWEEN 1 AND 512 AND octet_length(operation_ref)<=2048 AND operation_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (char_length(startup_operation_ref) BETWEEN 1 AND 512 AND octet_length(startup_operation_ref)<=2048 AND startup_operation_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (char_length(process_ref) BETWEEN 1 AND 512 AND octet_length(process_ref)<=2048 AND process_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (char_length(create_effect_ref) BETWEEN 1 AND 512 AND octet_length(create_effect_ref)<=2048 AND create_effect_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (previous_operation_ref IS NULL OR (char_length(previous_operation_ref) BETWEEN 1 AND 512 AND octet_length(previous_operation_ref)<=2048))) IS TRUE",
  gateway_startup_command_digest:
    "(CASE subject_version WHEN 1 THEN ((operation_digest=encode(sha256(convert_to('{\"command\":'||canonical_command||',\"domain\":\"oce.installation-gateway.startup-operation.v1\"}', 'UTF8')), 'hex')) IS TRUE) WHEN 2 THEN ((operation_digest=encode(sha256(convert_to('{\"command\":'||canonical_command||',\"domain\":\"oce.agent-gateway.startup-operation.v2\"}', 'UTF8')), 'hex')) IS TRUE) ELSE false END) IS TRUE",
  gateway_startup_record_core:
    "(CASE subject_version WHEN 1 THEN ((record=jsonb_build_object('kind',kind,'command',jsonb_build_object('installationId',installation_id,'operationRef',operation_ref,'operationDigest',operation_digest,'startup',CASE WHEN kind='accept-startup' THEN 'null'::jsonb ELSE jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest) END),'canonicalCommand',canonical_command,'beforeHeadVersion',before_head_version,'afterHeadVersion',after_head_version,'beforeRecordVersion',before_record_version,'afterRecordVersion',after_record_version,'previousOperationRef',previous_operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'createEffectRef',create_effect_ref,'acceptance',record->'acceptance','submissionInput',record->'submissionInput','recipient',record->'recipient','withdrawalReason',record->'withdrawalReason','auditEventId',audit_event_id)) IS TRUE) WHEN 2 THEN ((record=jsonb_build_object('schemaVersion',2,'kind',kind,'command',jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'operationRef',operation_ref,'operationDigest',operation_digest,'startup',CASE WHEN kind='accept-startup' THEN 'null'::jsonb ELSE jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest) END),'canonicalCommand',canonical_command,'beforeHeadVersion',before_head_version,'afterHeadVersion',after_head_version,'beforeRecordVersion',before_record_version,'afterRecordVersion',after_record_version,'previousOperationRef',previous_operation_ref,'startup',jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'createEffectRef',create_effect_ref,'acceptance',record->'acceptance','submissionInput',record->'submissionInput','recipient',record->'recipient','withdrawalReason',record->'withdrawalReason','auditEventId',audit_event_id))) ELSE false END) IS TRUE",
  gateway_startup_command_core:
    "(CASE subject_version WHEN 1 THEN ((CASE kind\n WHEN 'accept-startup' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'expectedHead',(canonical_command::jsonb)->'expectedHead','selectedDefinition',(canonical_command::jsonb)->'selectedDefinition','predecessorDisposition',(canonical_command::jsonb)->'predecessorDisposition')\n WHEN 'submit-create' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',(canonical_command::jsonb)->'expectedHead','input',record->'submissionInput')\n WHEN 'consume-startup' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',(canonical_command::jsonb)->'expectedHead','recipient',record->'recipient')\n WHEN 'withdraw' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',(canonical_command::jsonb)->'expectedHead','reason',record->'withdrawalReason') ELSE false END) IS TRUE) WHEN 2 THEN ((CASE kind\n WHEN 'accept-startup' THEN canonical_command::jsonb=jsonb_build_object('schemaVersion',2,'kind',kind,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'operationRef',operation_ref,'expectedHead',canonical_command::jsonb->'expectedHead','selectedDefinition',canonical_command::jsonb->'selectedDefinition','predecessorDisposition',canonical_command::jsonb->'predecessorDisposition')\n WHEN 'submit-create' THEN canonical_command::jsonb=jsonb_build_object('schemaVersion',2,'kind',kind,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'operationRef',operation_ref,'startup',jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',canonical_command::jsonb->'expectedHead','input',record->'submissionInput')\n WHEN 'consume-startup' THEN canonical_command::jsonb=jsonb_build_object('schemaVersion',2,'kind',kind,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'operationRef',operation_ref,'startup',jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',canonical_command::jsonb->'expectedHead','recipient',record->'recipient')\n WHEN 'withdraw' THEN canonical_command::jsonb=jsonb_build_object('schemaVersion',2,'kind',kind,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'operationRef',operation_ref,'startup',jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',canonical_command::jsonb->'expectedHead','reason',record->'withdrawalReason')\n ELSE false END)) ELSE false END) IS TRUE",
  gateway_startup_variant:
    "(CASE subject_version WHEN 1 THEN ((CASE kind\n WHEN 'accept-startup' THEN startup_operation_ref=operation_ref AND startup_operation_digest=operation_digest\n AND record->'acceptance'=jsonb_build_object('binding',record#>'{acceptance,binding}','predecessor',record#>'{acceptance,predecessor}','auditEventId',audit_event_id)\n AND record#>'{acceptance,binding,startup}'=jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest)\n AND record#>'{acceptance,binding,createEffectRef}'=to_jsonb(create_effect_ref)\n AND record#>'{acceptance,binding,selection}'=(canonical_command::jsonb)->'selectedDefinition'\n AND record#>'{acceptance,predecessor,disposition}'=(canonical_command::jsonb)->'predecessorDisposition'\n AND record#>'{acceptance,predecessor}'=jsonb_build_object('disposition',record#>'{acceptance,predecessor,disposition}','previousStartup',record#>'{acceptance,predecessor,previousStartup}','processOwner',record#>'{acceptance,predecessor,processOwner}','settlement',record#>'{acceptance,predecessor,settlement}')\n AND record->'submissionInput'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb\n WHEN 'submit-create' THEN record->'acceptance'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb\n AND record->'submissionInput'=jsonb_build_object('binding',record#>'{submissionInput,binding}','target',record#>'{submissionInput,target}','launchPlan',record#>'{submissionInput,launchPlan}')\n AND record#>'{submissionInput,binding,startup}'=jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest) AND record#>'{submissionInput,binding,createEffectRef}'=to_jsonb(create_effect_ref)\n WHEN 'consume-startup' THEN record->'acceptance'='null'::jsonb AND record->'submissionInput'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb AND jsonb_typeof(record->'recipient')='object'\n WHEN 'withdraw' THEN record->'acceptance'='null'::jsonb AND record->'submissionInput'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->>'withdrawalReason' IN ('administrative','selection-withdrawn','recipient-revoked')\n ELSE false END) IS TRUE) WHEN 2 THEN ((CASE kind\n WHEN 'accept-startup' THEN startup_operation_ref=operation_ref AND startup_operation_digest=operation_digest\n AND record->'acceptance'=jsonb_build_object('binding',record#>'{acceptance,binding}','predecessor',(record#>'{acceptance,predecessor}'),'auditEventId',audit_event_id)\n AND ((record#>'{acceptance,binding}')=jsonb_build_object('schemaVersion',2,'startup',jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'createEffectRef',create_effect_ref,'namespaceRef',namespace_ref,'agentRef',agent_ref,'configurationRef',(record#>'{acceptance,binding}')->'configurationRef','configurationVersion',(record#>'{acceptance,binding}')->'configurationVersion','profileRef',(record#>'{acceptance,binding}')->'profileRef','profileVersion',(record#>'{acceptance,binding}')->'profileVersion','admittedRevisionRef',(record#>'{acceptance,binding}')->'admittedRevisionRef','gatewayAssignmentRef',(record#>'{acceptance,binding}')->'gatewayAssignmentRef','hostRuntimeGeneration',(record#>'{acceptance,binding}')->'hostRuntimeGeneration','nativeConfigRef',(record#>'{acceptance,binding}')->'nativeConfigRef','configDigest',(record#>'{acceptance,binding}')->'configDigest','stateOwnership',(record#>'{acceptance,binding}')->'stateOwnership','stateSchemaVersion',(record#>'{acceptance,binding}')->'stateSchemaVersion','agentSchemaVersion',(record#>'{acceptance,binding}')->'agentSchemaVersion','protocolVersion',(record#>'{acceptance,binding}')->'protocolVersion','modules',(record#>'{acceptance,binding}')->'modules','startupDeadlineMs',(record#>'{acceptance,binding}')->'startupDeadlineMs','shutdownDeadlineMs',(record#>'{acceptance,binding}')->'shutdownDeadlineMs','selection',(record#>'{acceptance,binding}')->'selection','profileRefs',(record#>'{acceptance,binding}')->'profileRefs','admittedConfigurationDigest',(record#>'{acceptance,binding}')->'admittedConfigurationDigest') AND (((record#>'{acceptance,binding}')->'selection')=jsonb_build_object('manifestRef',((record#>'{acceptance,binding}')->'selection')->'manifestRef','manifestDigest',((record#>'{acceptance,binding}')->'selection')->'manifestDigest','admissionRef',((record#>'{acceptance,binding}')->'selection')->'admissionRef','admissionVersion',((record#>'{acceptance,binding}')->'selection')->'admissionVersion') AND (jsonb_typeof((((record#>'{acceptance,binding}')->'selection')->'manifestRef'))='string' AND char_length((((record#>'{acceptance,binding}')->'selection')->'manifestRef')#>>'{}') BETWEEN 1 AND 512 AND octet_length((((record#>'{acceptance,binding}')->'selection')->'manifestRef')#>>'{}')<=2048 AND ((((record#>'{acceptance,binding}')->'selection')->'manifestRef')#>>'{}') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (jsonb_typeof((((record#>'{acceptance,binding}')->'selection')->'admissionRef'))='string' AND char_length((((record#>'{acceptance,binding}')->'selection')->'admissionRef')#>>'{}') BETWEEN 1 AND 512 AND octet_length((((record#>'{acceptance,binding}')->'selection')->'admissionRef')#>>'{}')<=2048 AND ((((record#>'{acceptance,binding}')->'selection')->'admissionRef')#>>'{}') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND jsonb_typeof(((record#>'{acceptance,binding}')->'selection')->'manifestDigest')='string' AND (((record#>'{acceptance,binding}')->'selection')->>'manifestDigest') ~ '^sha256:[0-9a-f]{64}$' AND jsonb_typeof(((record#>'{acceptance,binding}')->'selection')->'admissionVersion')='number' AND (((record#>'{acceptance,binding}')->'selection')->>'admissionVersion')::numeric BETWEEN 1 AND 9007199254740991 AND mod((((record#>'{acceptance,binding}')->'selection')->>'admissionVersion')::numeric,1)=0) AND jsonb_typeof((record#>'{acceptance,binding}')->'profileRefs')='object' AND (record#>'{acceptance,binding}')->'profileRefs'=jsonb_build_object('provider',(record#>'{acceptance,binding}')#>'{profileRefs,provider}','runtime',(record#>'{acceptance,binding}')#>'{profileRefs,runtime}','identity',(record#>'{acceptance,binding}')#>'{profileRefs,identity}','containment',(record#>'{acceptance,binding}')#>'{profileRefs,containment}','storage',(record#>'{acceptance,binding}')#>'{profileRefs,storage}') AND jsonb_typeof((record#>'{acceptance,binding}')#>'{profileRefs,provider}')='object' AND jsonb_typeof((record#>'{acceptance,binding}')#>'{profileRefs,runtime}')='object' AND jsonb_typeof((record#>'{acceptance,binding}')#>'{profileRefs,identity}')='object' AND jsonb_typeof((record#>'{acceptance,binding}')#>'{profileRefs,containment}')='object' AND jsonb_typeof((record#>'{acceptance,binding}')#>'{profileRefs,storage}')='object' AND jsonb_typeof((record#>'{acceptance,binding}')->'admittedConfigurationDigest')='string' AND ((record#>'{acceptance,binding}')->>'admittedConfigurationDigest') ~ '^sha256:[0-9a-f]{64}$')\n AND record#>'{acceptance,binding,selection}'=canonical_command::jsonb->'selectedDefinition'\n AND (record#>'{acceptance,predecessor}')->'disposition'=canonical_command::jsonb->'predecessorDisposition'\n AND ((((record#>'{acceptance,predecessor}')->'disposition')=jsonb_build_object('recordRef',((record#>'{acceptance,predecessor}')->'disposition')->'recordRef','recordVersion',((record#>'{acceptance,predecessor}')->'disposition')->'recordVersion') AND (jsonb_typeof((((record#>'{acceptance,predecessor}')->'disposition')->'recordRef'))='string' AND char_length((((record#>'{acceptance,predecessor}')->'disposition')->'recordRef')#>>'{}') BETWEEN 1 AND 512 AND octet_length((((record#>'{acceptance,predecessor}')->'disposition')->'recordRef')#>>'{}')<=2048 AND ((((record#>'{acceptance,predecessor}')->'disposition')->'recordRef')#>>'{}') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND jsonb_typeof(((record#>'{acceptance,predecessor}')->'disposition')->'recordVersion')='number' AND (((record#>'{acceptance,predecessor}')->'disposition')->>'recordVersion')::numeric BETWEEN 1 AND 9007199254740991 AND mod((((record#>'{acceptance,predecessor}')->'disposition')->>'recordVersion')::numeric,1)=0) AND (((record#>'{acceptance,predecessor}')->'processOwner')=jsonb_build_object('recordRef',((record#>'{acceptance,predecessor}')->'processOwner')->'recordRef','recordVersion',((record#>'{acceptance,predecessor}')->'processOwner')->'recordVersion') AND (jsonb_typeof((((record#>'{acceptance,predecessor}')->'processOwner')->'recordRef'))='string' AND char_length((((record#>'{acceptance,predecessor}')->'processOwner')->'recordRef')#>>'{}') BETWEEN 1 AND 512 AND octet_length((((record#>'{acceptance,predecessor}')->'processOwner')->'recordRef')#>>'{}')<=2048 AND ((((record#>'{acceptance,predecessor}')->'processOwner')->'recordRef')#>>'{}') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND jsonb_typeof(((record#>'{acceptance,predecessor}')->'processOwner')->'recordVersion')='number' AND (((record#>'{acceptance,predecessor}')->'processOwner')->>'recordVersion')::numeric BETWEEN 1 AND 9007199254740991 AND mod((((record#>'{acceptance,predecessor}')->'processOwner')->>'recordVersion')::numeric,1)=0) AND (((record#>'{acceptance,predecessor}')->'settlement')=jsonb_build_object('recordRef',((record#>'{acceptance,predecessor}')->'settlement')->'recordRef','recordVersion',((record#>'{acceptance,predecessor}')->'settlement')->'recordVersion') AND (jsonb_typeof((((record#>'{acceptance,predecessor}')->'settlement')->'recordRef'))='string' AND char_length((((record#>'{acceptance,predecessor}')->'settlement')->'recordRef')#>>'{}') BETWEEN 1 AND 512 AND octet_length((((record#>'{acceptance,predecessor}')->'settlement')->'recordRef')#>>'{}')<=2048 AND ((((record#>'{acceptance,predecessor}')->'settlement')->'recordRef')#>>'{}') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND jsonb_typeof(((record#>'{acceptance,predecessor}')->'settlement')->'recordVersion')='number' AND (((record#>'{acceptance,predecessor}')->'settlement')->>'recordVersion')::numeric BETWEEN 1 AND 9007199254740991 AND mod((((record#>'{acceptance,predecessor}')->'settlement')->>'recordVersion')::numeric,1)=0) AND CASE (record#>'{acceptance,predecessor}')->>'kind'\n WHEN 'complete-initial' THEN (record#>'{acceptance,predecessor}')=jsonb_build_object('kind','complete-initial','disposition',(record#>'{acceptance,predecessor}')->'disposition','previousStartup','null'::jsonb,'processOwner',(record#>'{acceptance,predecessor}')->'processOwner','settlement',(record#>'{acceptance,predecessor}')->'settlement')\n WHEN 'retired-agent' THEN (record#>'{acceptance,predecessor}')=jsonb_build_object('kind','retired-agent','disposition',(record#>'{acceptance,predecessor}')->'disposition','previousStartup',(canonical_command::jsonb)#>'{expectedHead,startup}','processOwner',(record#>'{acceptance,predecessor}')->'processOwner','settlement',(record#>'{acceptance,predecessor}')->'settlement') AND jsonb_typeof((record#>'{acceptance,predecessor}')->'previousStartup')='object'\n WHEN 'retired-installation' THEN (record#>'{acceptance,predecessor}')=jsonb_build_object('kind','retired-installation','disposition',(record#>'{acceptance,predecessor}')->'disposition','previousStartup',(record#>'{acceptance,predecessor}')->'previousStartup','historicalWithdrawal',(record#>'{acceptance,predecessor}')->'historicalWithdrawal','processOwner',(record#>'{acceptance,predecessor}')->'processOwner','settlement',(record#>'{acceptance,predecessor}')->'settlement')\n AND (record#>'{acceptance,predecessor}')->'historicalWithdrawal'=jsonb_build_object('installationId',installation_id,'operationRef',(record#>'{acceptance,predecessor}')#>'{historicalWithdrawal,operationRef}','operationDigest',(record#>'{acceptance,predecessor}')#>'{historicalWithdrawal,operationDigest}','startup',(record#>'{acceptance,predecessor}')->'previousStartup')\n AND jsonb_typeof((record#>'{acceptance,predecessor}')->'previousStartup')='object'\n ELSE false END)\n AND record->'submissionInput'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb\n WHEN 'submit-create' THEN record->'acceptance'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb\n AND record->'submissionInput'=jsonb_build_object('binding',record#>'{submissionInput,binding}','target',record#>'{submissionInput,target}','launchPlan',record#>'{submissionInput,launchPlan}')\n AND ((record#>'{submissionInput,binding}')=jsonb_build_object('schemaVersion',2,'startup',jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'createEffectRef',create_effect_ref,'namespaceRef',namespace_ref,'agentRef',agent_ref,'configurationRef',(record#>'{submissionInput,binding}')->'configurationRef','configurationVersion',(record#>'{submissionInput,binding}')->'configurationVersion','profileRef',(record#>'{submissionInput,binding}')->'profileRef','profileVersion',(record#>'{submissionInput,binding}')->'profileVersion','admittedRevisionRef',(record#>'{submissionInput,binding}')->'admittedRevisionRef','gatewayAssignmentRef',(record#>'{submissionInput,binding}')->'gatewayAssignmentRef','hostRuntimeGeneration',(record#>'{submissionInput,binding}')->'hostRuntimeGeneration','nativeConfigRef',(record#>'{submissionInput,binding}')->'nativeConfigRef','configDigest',(record#>'{submissionInput,binding}')->'configDigest','stateOwnership',(record#>'{submissionInput,binding}')->'stateOwnership','stateSchemaVersion',(record#>'{submissionInput,binding}')->'stateSchemaVersion','agentSchemaVersion',(record#>'{submissionInput,binding}')->'agentSchemaVersion','protocolVersion',(record#>'{submissionInput,binding}')->'protocolVersion','modules',(record#>'{submissionInput,binding}')->'modules','startupDeadlineMs',(record#>'{submissionInput,binding}')->'startupDeadlineMs','shutdownDeadlineMs',(record#>'{submissionInput,binding}')->'shutdownDeadlineMs','selection',(record#>'{submissionInput,binding}')->'selection','profileRefs',(record#>'{submissionInput,binding}')->'profileRefs','admittedConfigurationDigest',(record#>'{submissionInput,binding}')->'admittedConfigurationDigest') AND (((record#>'{submissionInput,binding}')->'selection')=jsonb_build_object('manifestRef',((record#>'{submissionInput,binding}')->'selection')->'manifestRef','manifestDigest',((record#>'{submissionInput,binding}')->'selection')->'manifestDigest','admissionRef',((record#>'{submissionInput,binding}')->'selection')->'admissionRef','admissionVersion',((record#>'{submissionInput,binding}')->'selection')->'admissionVersion') AND (jsonb_typeof((((record#>'{submissionInput,binding}')->'selection')->'manifestRef'))='string' AND char_length((((record#>'{submissionInput,binding}')->'selection')->'manifestRef')#>>'{}') BETWEEN 1 AND 512 AND octet_length((((record#>'{submissionInput,binding}')->'selection')->'manifestRef')#>>'{}')<=2048 AND ((((record#>'{submissionInput,binding}')->'selection')->'manifestRef')#>>'{}') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (jsonb_typeof((((record#>'{submissionInput,binding}')->'selection')->'admissionRef'))='string' AND char_length((((record#>'{submissionInput,binding}')->'selection')->'admissionRef')#>>'{}') BETWEEN 1 AND 512 AND octet_length((((record#>'{submissionInput,binding}')->'selection')->'admissionRef')#>>'{}')<=2048 AND ((((record#>'{submissionInput,binding}')->'selection')->'admissionRef')#>>'{}') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND jsonb_typeof(((record#>'{submissionInput,binding}')->'selection')->'manifestDigest')='string' AND (((record#>'{submissionInput,binding}')->'selection')->>'manifestDigest') ~ '^sha256:[0-9a-f]{64}$' AND jsonb_typeof(((record#>'{submissionInput,binding}')->'selection')->'admissionVersion')='number' AND (((record#>'{submissionInput,binding}')->'selection')->>'admissionVersion')::numeric BETWEEN 1 AND 9007199254740991 AND mod((((record#>'{submissionInput,binding}')->'selection')->>'admissionVersion')::numeric,1)=0) AND jsonb_typeof((record#>'{submissionInput,binding}')->'profileRefs')='object' AND (record#>'{submissionInput,binding}')->'profileRefs'=jsonb_build_object('provider',(record#>'{submissionInput,binding}')#>'{profileRefs,provider}','runtime',(record#>'{submissionInput,binding}')#>'{profileRefs,runtime}','identity',(record#>'{submissionInput,binding}')#>'{profileRefs,identity}','containment',(record#>'{submissionInput,binding}')#>'{profileRefs,containment}','storage',(record#>'{submissionInput,binding}')#>'{profileRefs,storage}') AND jsonb_typeof((record#>'{submissionInput,binding}')#>'{profileRefs,provider}')='object' AND jsonb_typeof((record#>'{submissionInput,binding}')#>'{profileRefs,runtime}')='object' AND jsonb_typeof((record#>'{submissionInput,binding}')#>'{profileRefs,identity}')='object' AND jsonb_typeof((record#>'{submissionInput,binding}')#>'{profileRefs,containment}')='object' AND jsonb_typeof((record#>'{submissionInput,binding}')#>'{profileRefs,storage}')='object' AND jsonb_typeof((record#>'{submissionInput,binding}')->'admittedConfigurationDigest')='string' AND ((record#>'{submissionInput,binding}')->>'admittedConfigurationDigest') ~ '^sha256:[0-9a-f]{64}$')\n WHEN 'consume-startup' THEN record->'acceptance'='null'::jsonb AND record->'submissionInput'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb AND jsonb_typeof(record->'recipient')='object'\n WHEN 'withdraw' THEN record->'acceptance'='null'::jsonb AND record->'submissionInput'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->>'withdrawalReason' IN ('administrative','selection-withdrawn','recipient-revoked')\n ELSE false END)) ELSE false END) IS TRUE",
  gateway_startup_head_shape:
    "((state='empty' AND head_version=0 AND process_generation=0 AND latest_operation_ref IS NULL AND startup_operation_ref IS NULL AND record_version=0)\n OR (head_version BETWEEN 1 AND 9007199254740991 AND process_generation BETWEEN 1 AND 9007199254740991 AND latest_operation_ref IS NOT NULL AND startup_operation_ref IS NOT NULL AND ((state='accepted' AND record_version=1) OR (state='create-submitted' AND record_version=2) OR (state='consumed' AND record_version=3) OR (state='withdrawn' AND record_version BETWEEN 2 AND 4)))) IS TRUE",
  gateway_startup_operation_subject:
    "((subject_version=1 AND subject_key='installation-v1' AND namespace_ref IS NULL AND agent_ref IS NULL)\n OR (subject_version=2 AND subject_key='agent-v2:'||agent_ref\n AND char_length(namespace_ref) BETWEEN 1 AND 512 AND octet_length(namespace_ref)<=2048\n AND char_length(agent_ref) BETWEEN 1 AND 512 AND octet_length(agent_ref)<=2048\n AND namespace_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')\n AND agent_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']'))) IS TRUE",
  gateway_startup_head_subject:
    "((subject_version=1 AND subject_key='installation-v1' AND namespace_ref IS NULL AND agent_ref IS NULL)\n OR (subject_version=2 AND subject_key='agent-v2:'||agent_ref\n AND char_length(namespace_ref) BETWEEN 1 AND 512 AND octet_length(namespace_ref)<=2048\n AND char_length(agent_ref) BETWEEN 1 AND 512 AND octet_length(agent_ref)<=2048\n AND namespace_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')\n AND agent_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']'))) IS TRUE",
} as const;

export function createGatewayStartupTablesV2(
  schema: PgSchema,
  parents: GatewayStartupSchemaParentsV2,
) {
  if (!parents.agents?.namespaceId || !parents.agents.id) {
    throw new Error("Gateway startup Agent parent unavailable");
  }
  const gatewayStartupOperations = schema.table(
    "gateway_startup_operations",
    {
      installationId: text("installation_id")
        .notNull()
        .references(() => parents.installation.id, { onDelete: "restrict", onUpdate: "restrict" }),
      subjectVersion: integer("subject_version").notNull().default(1),
      subjectKey: text("subject_key").notNull().default("installation-v1"),
      namespaceRef: text("namespace_ref"),
      agentRef: text("agent_ref"),
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
        sql.raw(gatewayStartupChecksV2.gateway_startup_operation_bounds),
      ),
      check("gateway_startup_refs", sql.raw(gatewayStartupChecksV2.gateway_startup_refs)),
      check(
        "gateway_startup_command_digest",
        sql.raw(gatewayStartupChecksV2.gateway_startup_command_digest),
      ),
      check(
        "gateway_startup_record_core",
        sql.raw(gatewayStartupChecksV2.gateway_startup_record_core),
      ),
      check(
        "gateway_startup_command_core",
        sql.raw(gatewayStartupChecksV2.gateway_startup_command_core),
      ),
      check("gateway_startup_variant", sql.raw(gatewayStartupChecksV2.gateway_startup_variant)),
      check(
        "gateway_startup_operation_subject",
        sql.raw(gatewayStartupChecksV2.gateway_startup_operation_subject),
      ),
      foreignKey({
        name: "gateway_startup_operations_agent_owner",
        columns: [table.namespaceRef, table.agentRef],
        foreignColumns: [parents.agents.namespaceId, parents.agents.id],
      })
        .onDelete("restrict")
        .onUpdate("restrict"),
      unique("gateway_startup_operation_scope").on(
        table.installationId,
        table.subjectKey,
        table.operationRef,
      ),
      unique("gateway_startup_operation_version").on(
        table.installationId,
        table.subjectKey,
        table.operationRef,
        table.afterHeadVersion,
      ),
      unique("gateway_startup_head_version_unique").on(
        table.installationId,
        table.subjectKey,
        table.afterHeadVersion,
      ),
      unique("gateway_startup_audit_unique").on(table.auditEventId),
      uniqueIndex("gateway_startup_generation_unique")
        .on(table.installationId, table.subjectKey, table.processGeneration)
        .where(sql.raw("kind='accept-startup'")),
      uniqueIndex("gateway_startup_process_unique")
        .on(table.processRef)
        .where(sql.raw("kind='accept-startup'")),
      uniqueIndex("gateway_startup_effect_unique")
        .on(table.createEffectRef)
        .where(sql.raw("kind='accept-startup'")),
      uniqueIndex("gateway_startup_submission_unique")
        .on(table.installationId, table.subjectKey, table.startupOperationRef)
        .where(sql.raw("kind='submit-create'")),
      uniqueIndex("gateway_startup_consume_unique")
        .on(table.installationId, table.subjectKey, table.startupOperationRef)
        .where(sql.raw("kind='consume-startup'")),
      uniqueIndex("gateway_startup_withdraw_unique")
        .on(table.installationId, table.subjectKey, table.startupOperationRef)
        .where(sql.raw("kind='withdraw'")),
    ],
  );
  const gatewayStartupHeads = schema.table(
    "gateway_startup_heads",
    {
      installationId: text("installation_id")
        .notNull()
        .references(() => parents.installation.id, { onDelete: "restrict", onUpdate: "restrict" }),
      subjectVersion: integer("subject_version").notNull().default(1),
      subjectKey: text("subject_key").notNull().default("installation-v1"),
      namespaceRef: text("namespace_ref"),
      agentRef: text("agent_ref"),
      headVersion: bigint("head_version", { mode: "number" }).notNull(),
      processGeneration: bigint("process_generation", { mode: "number" }).notNull(),
      latestOperationRef: text("latest_operation_ref"),
      startupOperationRef: text("startup_operation_ref"),
      recordVersion: bigint("record_version", { mode: "number" }).notNull(),
      state: text("state").notNull(),
    },
    (table) => [
      primaryKey({
        name: "gateway_startup_heads_pkey",
        columns: [table.installationId, table.subjectKey],
      }),
      check(
        "gateway_startup_head_shape",
        sql.raw(gatewayStartupChecksV2.gateway_startup_head_shape),
      ),
      check(
        "gateway_startup_head_subject",
        sql.raw(gatewayStartupChecksV2.gateway_startup_head_subject),
      ),
      foreignKey({
        name: "gateway_startup_heads_agent_owner",
        columns: [table.namespaceRef, table.agentRef],
        foreignColumns: [parents.agents.namespaceId, parents.agents.id],
      })
        .onDelete("restrict")
        .onUpdate("restrict"),
    ],
  );
  // The matching forward SQL owns all four deferred cyclic FKs and the
  // append-only/transition/final-state triggers, including the historical bridge.
  return { gatewayStartupHeads, gatewayStartupOperations };
}
