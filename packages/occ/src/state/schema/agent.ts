import type { HarnessExecutionMode } from "@openclaw-enterprise/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn, PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { collatedText, identifierPatterns } from "./shared.ts";

type CanonicalOccSchema = typeof import("./shared.ts").occSchema;
type AgentSchemaParents = Readonly<{
  namespaces: Readonly<{ id: AnyPgColumn }>;
  configurations: Readonly<{ namespaceId: AnyPgColumn; id: AnyPgColumn }>;
  serviceAccounts: Readonly<{ namespaceId: AnyPgColumn; id: AnyPgColumn }>;
}>;
type IamIdentityColumns = Readonly<{
  namespaceId: AnyPgColumn;
  agentId: AnyPgColumn;
  id: AnyPgColumn;
}>;

export function createAgentTables(
  occSchema: CanonicalOccSchema,
  parents: AgentSchemaParents,
  readIamIdentities: () => IamIdentityColumns,
) {
  const { namespaces, configurations, serviceAccounts } = parents;

  const agents = occSchema.table(
    "agents",
    {
      id: text("id").primaryKey(),
      namespaceId: text("namespace_id")
        .notNull()
        .references(() => namespaces.id, { onDelete: "restrict", onUpdate: "restrict" }),
      name: collatedText("name").notNull(),
      configurationId: text("configuration_id").notNull(),
      providerId: text("provider_id"),
      executionMode: text("execution_mode").$type<HarnessExecutionMode>().notNull(),
      servicePrincipalId: text("service_principal_id").notNull(),
      serviceAccountId: text("service_account_id"),
      activeRevisionId: text("active_revision_id"),
      workloadProfileSelection: jsonb("workload_profile_selection"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    },
    (table): PgTableExtraConfigValue[] => {
      // Resolve the completed canonical IAM table only when Drizzle reads extra config.
      const iamIdentities = readIamIdentities();
      return [
        unique("agents_namespace_id_id_unique").on(table.namespaceId, table.id),
        unique("agents_namespace_id_name_unique").on(table.namespaceId, table.name),
        unique("agents_namespace_id_id_service_principal_id_unique").on(
          table.namespaceId,
          table.id,
          table.servicePrincipalId,
        ),
        check("agents_id_format", sql`${table.id} ~ ${identifierPatterns.agent}`),
        check("agents_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
        check(
          "agents_workload_profile_selection",
          sql`${table.workloadProfileSelection} IS NULL OR occ.workload_profile_selection_valid_v1(${table.workloadProfileSelection})`,
        ),
        check(
          "agents_execution_mode_valid",
          sql`${table.executionMode} IN ('embedded', 'dedicated')`,
        ),
        check(
          "agents_provider_id_valid",
          sql`${table.providerId} IS NULL OR (char_length(${table.providerId}) BETWEEN 1 AND 200 AND ${table.providerId} = btrim(${table.providerId}) AND ${table.providerId} !~ '[[:cntrl:]]')`,
        ),
        check(
          "agents_name_normalized",
          sql`${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
        ),
        foreignKey({
          name: "agents_configuration_owner",
          columns: [table.namespaceId, table.configurationId],
          foreignColumns: [configurations.namespaceId, configurations.id],
        })
          .onUpdate("restrict")
          .onDelete("restrict"),
        foreignKey({
          name: "agents_service_account_owner",
          columns: [table.namespaceId, table.serviceAccountId],
          foreignColumns: [serviceAccounts.namespaceId, serviceAccounts.id],
        })
          .onUpdate("restrict")
          .onDelete("restrict"),
        foreignKey({
          name: "agent_active_revision_owner",
          columns: [table.namespaceId, table.id, table.activeRevisionId],
          foreignColumns: [agentRevisions.namespaceId, agentRevisions.agentId, agentRevisions.id],
        })
          .onUpdate("restrict")
          .onDelete("restrict"),
        // The checked-in migration makes both Agent ownership cycle edges
        // DEFERRABLE INITIALLY DEFERRED; Drizzle does not model FK deferral.
        foreignKey({
          name: "agent_service_principal_owner",
          columns: [table.namespaceId, table.id, table.servicePrincipalId],
          foreignColumns: [iamIdentities.namespaceId, iamIdentities.agentId, iamIdentities.id],
        })
          .onUpdate("restrict")
          .onDelete("restrict"),
      ];
    },
  );

  const agentRevisions = occSchema.table(
    "agent_revisions",
    {
      id: text("id").primaryKey(),
      namespaceId: text("namespace_id").notNull(),
      agentId: text("agent_id").notNull(),
      revisionNumber: bigint("revision_number", { mode: "number" }).notNull(),
      providerId: text("provider_id"),
      admittedSpec: jsonb("admitted_spec").$type<Record<string, unknown>>().notNull(),
      admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      index("runtime_revision_profile_use")
        .on(table.namespaceId, sql`(${table.admittedSpec}#>>'{workload_profile_use,admissionRef}')`)
        .where(sql`${table.admittedSpec}->'workload_profile_use' IS NOT NULL`),
      unique("agent_revisions_namespace_id_agent_id_id_unique").on(
        table.namespaceId,
        table.agentId,
        table.id,
      ),
      unique("agent_revisions_namespace_id_agent_id_revision_number_unique").on(
        table.namespaceId,
        table.agentId,
        table.revisionNumber,
      ),
      foreignKey({
        name: "agent_revisions_agent_owner",
        columns: [table.namespaceId, table.agentId],
        foreignColumns: [agents.namespaceId, agents.id],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      check("agent_revisions_id_format", sql`${table.id} ~ ${identifierPatterns.revision}`),
      check("agent_revisions_revision_positive", sql`${table.revisionNumber} > 0`),
      check(
        "agent_revisions_provider_id_valid",
        sql`${table.providerId} IS NULL OR (char_length(${table.providerId}) BETWEEN 1 AND 200 AND ${table.providerId} = btrim(${table.providerId}) AND ${table.providerId} !~ '[[:cntrl:]]')`,
      ),
      check("agent_revisions_spec_object", sql`jsonb_typeof(${table.admittedSpec}) = 'object'`),
      check(
        "agent_revisions_workload_profile_use",
        sql`NOT (${table.admittedSpec} ? 'workload_profile_use') OR occ.revision_workload_profile_use_valid_v2(${table.admittedSpec}->'workload_profile_use',${table.namespaceId})`,
      ),
      check(
        "agent_revisions_credential_selection",
        sql`NOT (${table.admittedSpec} ? 'credential_workload_selection') OR occ.revision_credential_selection_valid_v1(${table.admittedSpec}->'credential_workload_selection',${table.namespaceId},${table.agentId},${table.id})`,
      ),
      check(
        "agent_revisions_admitted_snapshot",
        sql`(${table.admittedSpec} ?& ARRAY[
          'configuration_id', 'configuration_kind', 'configuration_generation',
          'draft_spec', 'harness', 'compute'
        ])
        AND (${table.admittedSpec}
          - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
          - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id'
          - 'secret_driver_id' - 'secret_bindings' - 'service_account' - 'credential_workload_selection' - 'workload_profile_use') = '{}'::jsonb
        AND jsonb_typeof(${table.admittedSpec}->'configuration_id') = 'string'
        AND (${table.admittedSpec}->>'configuration_id') ~ ${identifierPatterns.configuration}
        AND jsonb_typeof(${table.admittedSpec}->'configuration_kind') = 'string'
        AND (${table.admittedSpec}->>'configuration_kind') = 'agent'
        AND jsonb_typeof(${table.admittedSpec}->'configuration_generation') = 'number'
        AND (${table.admittedSpec}->>'configuration_generation')::numeric
          BETWEEN 1 AND 9007199254740991
        AND mod((${table.admittedSpec}->>'configuration_generation')::numeric, 1) = 0
        AND jsonb_typeof(${table.admittedSpec}->'draft_spec') = 'object'
        AND jsonb_typeof(${table.admittedSpec}->'harness') = 'object'
        AND ((${table.admittedSpec}->'harness') ?& ARRAY['id', 'version', 'mode'])
        AND ((${table.admittedSpec}->'harness') - 'id' - 'version' - 'mode') = '{}'::jsonb
        AND jsonb_typeof(${table.admittedSpec} #> '{harness,id}') = 'string'
        AND COALESCE(btrim(${table.admittedSpec} #>> '{harness,id}'), '') <> ''
        AND jsonb_typeof(${table.admittedSpec} #> '{harness,version}') = 'string'
        AND COALESCE(btrim(${table.admittedSpec} #>> '{harness,version}'), '') <> ''
        AND jsonb_typeof(${table.admittedSpec} #> '{harness,mode}') = 'string'
        AND (${table.admittedSpec} #>> '{harness,mode}') IN ('embedded', 'dedicated')
        AND jsonb_typeof(${table.admittedSpec}->'compute') = 'object'
        AND ((${table.admittedSpec}->'compute') ?& ARRAY['id', 'implementation'])
        AND ((${table.admittedSpec}->'compute') - 'id' - 'implementation') = '{}'::jsonb
        AND jsonb_typeof(${table.admittedSpec} #> '{compute,id}') = 'string'
        AND COALESCE(btrim(${table.admittedSpec} #>> '{compute,id}'), '') <> ''
        AND jsonb_typeof(${table.admittedSpec} #> '{compute,implementation}') = 'string'
        AND COALESCE(btrim(${table.admittedSpec} #>> '{compute,implementation}'), '') <> ''
        AND (
          NOT (${table.admittedSpec} ? 'sandbox_driver_id')
          OR (
            jsonb_typeof(${table.admittedSpec}->'sandbox_driver_id') = 'string'
            AND COALESCE(btrim(${table.admittedSpec}->>'sandbox_driver_id'), '') <> ''
          )
        )
        AND (
          NOT (${table.admittedSpec} ? 'secret_driver_id')
          OR (
            jsonb_typeof(${table.admittedSpec}->'secret_driver_id') = 'string'
            AND COALESCE(btrim(${table.admittedSpec}->>'secret_driver_id'), '') <> ''
          )
        )
        AND (
          NOT (${table.admittedSpec} ? 'secret_bindings')
          OR occ.secret_bindings_are_valid(${table.admittedSpec}->'secret_bindings', ${table.namespaceId})
        )
        AND (
          NOT (${table.admittedSpec} ? 'service_account')
          OR (
            jsonb_typeof(${table.admittedSpec}->'service_account') = 'object'
            AND ((${table.admittedSpec}->'service_account') ?& ARRAY['id', 'credential'])
            AND ((${table.admittedSpec}->'service_account') - 'id' - 'credential') = '{}'::jsonb
            AND jsonb_typeof(${table.admittedSpec} #> '{service_account,id}') = 'string'
            AND (${table.admittedSpec} #>> '{service_account,id}') ~ ${identifierPatterns.serviceAccount}
            AND jsonb_typeof(${table.admittedSpec} #> '{service_account,credential}') = 'object'
            AND ((${table.admittedSpec} #> '{service_account,credential}') ?& ARRAY['kind', 'secretRef'])
            AND ((${table.admittedSpec} #> '{service_account,credential}') - 'kind' - 'secretRef') = '{}'::jsonb
            AND jsonb_typeof(${table.admittedSpec} #> '{service_account,credential,kind}') = 'string'
            AND (${table.admittedSpec} #>> '{service_account,credential,kind}')
              IN ('api_key', 'access_token')
            AND jsonb_typeof(${table.admittedSpec} #> '{service_account,credential,secretRef}') = 'object'
            AND ((${table.admittedSpec} #> '{service_account,credential,secretRef}') ?& ARRAY['name', 'key'])
            AND ((${table.admittedSpec} #> '{service_account,credential,secretRef}') - 'name' - 'key') = '{}'::jsonb
            AND jsonb_typeof(${table.admittedSpec} #> '{service_account,credential,secretRef,name}') = 'string'
            AND char_length(${table.admittedSpec} #>> '{service_account,credential,secretRef,name}') BETWEEN 1 AND 253
            AND (${table.admittedSpec} #>> '{service_account,credential,secretRef,name}') ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
            AND jsonb_typeof(${table.admittedSpec} #> '{service_account,credential,secretRef,key}') = 'string'
            AND char_length(${table.admittedSpec} #>> '{service_account,credential,secretRef,key}') BETWEEN 1 AND 253
            AND (${table.admittedSpec} #>> '{service_account,credential,secretRef,key}') ~ '^[-._a-zA-Z0-9]+$'
            AND (${table.admittedSpec} #>> '{service_account,credential,secretRef,key}') NOT IN ('.', '..')
          )
        )`,
      ),
    ],
  );

  return { agents, agentRevisions };
}
