import type {
  HarnessExecutionMode,
  SecretBindings,
  ServiceAccountCredential,
} from "@openclaw-enterprise/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { PgTableExtraConfigValue } from "drizzle-orm/pg-core";

export const occSchema = pgSchema("occ");

const collatedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text COLLATE "C"';
  },
});

const identifierPatterns = {
  installation: "^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  namespace: "^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  configuration: "^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  serviceAccount: "^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  agent: "^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  revision: "^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  secret: "^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  audit: "^aud_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
} as const;

export const installation = occSchema.table(
  "installation",
  {
    id: text("id").primaryKey(),
    name: collatedText("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("installation_id_format", sql`${table.id} ~ ${identifierPatterns.installation}`),
    check("installation_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check(
      "installation_name_normalized",
      sql`${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
    ),
    uniqueIndex("installation_one_row").on(sql`true`),
  ],
);

export const namespaces = occSchema.table(
  "namespaces",
  {
    id: text("id").primaryKey(),
    name: collatedText("name").notNull().unique(),
    existingNamespace: text("existing_namespace"),
    status: text("status").notNull().default("provisioning"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("namespaces_existing_namespace_unique")
      .on(table.existingNamespace)
      .where(sql`${table.existingNamespace} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    check("namespaces_id_format", sql`${table.id} ~ ${identifierPatterns.namespace}`),
    check(
      "namespaces_status_valid",
      sql`${table.status} IN ('provisioning', 'ready', 'failed', 'deleting')`,
    ),
    check("namespaces_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check(
      "namespaces_existing_namespace_valid",
      sql`${table.existingNamespace} IS NULL OR (
        char_length(${table.existingNamespace}) BETWEEN 1 AND 63
        AND ${table.existingNamespace} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
      )`,
    ),
    check(
      "namespaces_name_normalized",
      sql`${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
    ),
    check(
      "namespaces_tombstone_valid",
      sql`${table.deletedAt} IS NULL OR (${table.status} = 'deleting' AND ${table.deletedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const configurations = occSchema.table(
  "configurations",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict", onUpdate: "restrict" }),
    kind: text("kind").$type<"agent">().notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    secretBindings: jsonb("secret_bindings").$type<SecretBindings>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("configurations_namespace_id_id_unique").on(table.namespaceId, table.id),
    check("configurations_id_format", sql`${table.id} ~ ${identifierPatterns.configuration}`),
    check("configurations_kind_valid", sql`${table.kind} = 'agent'`),
    check(
      "configurations_generation_valid",
      sql`${table.generation} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "configurations_secret_bindings_valid",
      sql`${table.secretBindings} IS NULL OR occ.secret_bindings_are_valid(${table.secretBindings}, ${table.namespaceId})`,
    ),
  ],
);

export const serviceAccounts = occSchema.table(
  "service_accounts",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict", onUpdate: "restrict" }),
    name: collatedText("name").notNull(),
    credential: jsonb("credential").$type<ServiceAccountCredential>(),
  },
  (table) => [
    unique("service_accounts_namespace_id_id_unique").on(table.namespaceId, table.id),
    unique("service_accounts_namespace_id_name_unique").on(table.namespaceId, table.name),
    check("service_accounts_id_format", sql`${table.id} ~ ${identifierPatterns.serviceAccount}`),
    check("service_accounts_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check(
      "service_accounts_name_normalized",
      sql`${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
    ),
    check(
      "service_accounts_credential_valid",
      sql`${table.credential} IS NULL OR (
        jsonb_typeof(${table.credential}) = 'object'
        AND (${table.credential} ?& ARRAY['kind', 'secretRef'])
        AND (${table.credential} - 'kind' - 'secretRef') = '{}'::jsonb
        AND jsonb_typeof(${table.credential}->'kind') = 'string'
        AND (${table.credential}->>'kind') IN ('api_key', 'oauth_access_token', 'access_token')
        AND jsonb_typeof(${table.credential}->'secretRef') = 'object'
        AND ((${table.credential}->'secretRef') ?& ARRAY['name', 'key'])
        AND ((${table.credential}->'secretRef') - 'name' - 'key') = '{}'::jsonb
        AND jsonb_typeof(${table.credential} #> '{secretRef,name}') = 'string'
        AND char_length(${table.credential} #>> '{secretRef,name}') BETWEEN 1 AND 253
        AND (${table.credential} #>> '{secretRef,name}') ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
        AND jsonb_typeof(${table.credential} #> '{secretRef,key}') = 'string'
        AND char_length(${table.credential} #>> '{secretRef,key}') BETWEEN 1 AND 253
        AND (${table.credential} #>> '{secretRef,key}') ~ '^[-._a-zA-Z0-9]+$'
        AND (${table.credential} #>> '{secretRef,key}') NOT IN ('.', '..')
      )`,
    ),
  ],
);

export const serviceAccountDriverBindings = occSchema.table(
  "service_account_driver_bindings",
  {
    serviceAccountId: text("service_account_id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    providerId: text("provider_id").notNull(),
    driverId: text("driver_id").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    externalCredentialId: text("external_credential_id"),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    foreignKey({
      name: "service_account_driver_bindings_account_owner",
      columns: [table.namespaceId, table.serviceAccountId],
      foreignColumns: [serviceAccounts.namespaceId, serviceAccounts.id],
    })
      .onUpdate("restrict")
      .onDelete("cascade"),
    unique("service_account_driver_bindings_external_account_unique").on(
      table.driverId,
      table.workspaceId,
      table.externalAccountId,
    ),
    check(
      "service_account_driver_bindings_provider_id_valid",
      sql`char_length(${table.providerId}) BETWEEN 1 AND 200 AND ${table.providerId} = btrim(${table.providerId})`,
    ),
    check(
      "service_account_driver_bindings_driver_id_valid",
      sql`char_length(${table.driverId}) BETWEEN 1 AND 200 AND ${table.driverId} = btrim(${table.driverId})`,
    ),
    check(
      "service_account_driver_bindings_external_account_id_valid",
      sql`char_length(${table.externalAccountId}) BETWEEN 1 AND 200 AND ${table.externalAccountId} = btrim(${table.externalAccountId})`,
    ),
    check(
      "service_account_driver_bindings_external_credential_id_valid",
      sql`${table.externalCredentialId} IS NULL OR (char_length(${table.externalCredentialId}) BETWEEN 1 AND 200 AND ${table.externalCredentialId} = btrim(${table.externalCredentialId}))`,
    ),
    check(
      "service_account_driver_bindings_workspace_id_valid",
      sql`char_length(${table.workspaceId}) BETWEEN 1 AND 200 AND ${table.workspaceId} = btrim(${table.workspaceId})`,
    ),
  ],
);

export const agents = occSchema.table(
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("agents_namespace_id_id_unique").on(table.namespaceId, table.id),
    unique("agents_namespace_id_name_unique").on(table.namespaceId, table.name),
    unique("agents_namespace_id_id_service_principal_id_unique").on(
      table.namespaceId,
      table.id,
      table.servicePrincipalId,
    ),
    check("agents_id_format", sql`${table.id} ~ ${identifierPatterns.agent}`),
    check("agents_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check("agents_execution_mode_valid", sql`${table.executionMode} IN ('embedded', 'dedicated')`),
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
  ],
);

export const secrets = occSchema.table(
  "secrets",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict", onUpdate: "restrict" }),
    name: collatedText("name").notNull(),
    driverId: text("driver_id").notNull(),
    backendNamespaceName: text("backend_namespace_name").notNull(),
    backendName: text("backend_name").notNull(),
    backendKey: text("backend_key").notNull(),
    backendUid: text("backend_uid").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("secrets_namespace_id_id_unique").on(table.namespaceId, table.id),
    unique("secrets_namespace_id_name_unique").on(table.namespaceId, table.name),
    check("secrets_id_format", sql`${table.id} ~ ${identifierPatterns.secret}`),
    check("secrets_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check(
      "secrets_name_normalized",
      sql`${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
    ),
    check(
      "secrets_driver_id_valid",
      sql`char_length(${table.driverId}) BETWEEN 1 AND 200 AND ${table.driverId} = btrim(${table.driverId})`,
    ),
    check(
      "secrets_backend_namespace_name_valid",
      sql`char_length(${table.backendNamespaceName}) BETWEEN 1 AND 63
        AND ${table.backendNamespaceName} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'`,
    ),
    check(
      "secrets_backend_name_valid",
      sql`char_length(${table.backendName}) BETWEEN 1 AND 253
        AND ${table.backendName} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'`,
    ),
    check(
      "secrets_backend_key_valid",
      sql`char_length(${table.backendKey}) BETWEEN 1 AND 253
        AND ${table.backendKey} ~ '^[-._a-zA-Z0-9]+$'
        AND ${table.backendKey} NOT IN ('.', '..')`,
    ),
    check(
      "secrets_backend_uid_valid",
      sql`${table.backendUid} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
  ],
);

export const agentRevisions = occSchema.table(
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
      "agent_revisions_admitted_snapshot",
      sql`(${table.admittedSpec} ?& ARRAY[
          'configuration_id', 'configuration_kind', 'configuration_generation',
          'draft_spec', 'harness', 'compute'
        ])
        AND (${table.admittedSpec}
          - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
          - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id'
          - 'secret_driver_id' - 'secret_bindings' - 'service_account') = '{}'::jsonb
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

export const iamIdentities = occSchema.table(
  "iam_identities",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").references(() => namespaces.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    agentId: text("agent_id"),
    kind: text("kind").notNull(),
    issuer: text("issuer"),
    subject: text("subject"),
  },
  (table) => [
    unique("iam_identities_namespace_id_agent_id_id_unique")
      .on(table.namespaceId, table.agentId, table.id)
      .nullsNotDistinct(),
    foreignKey({
      name: "iam_identities_agent_owner",
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [agents.namespaceId, agents.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    check("iam_identities_kind_valid", sql`${table.kind} IN ('principal', 'service_principal')`),
    check(
      "iam_identities_kind_ownership",
      sql`(
        (${table.kind} = 'principal'
          AND ${table.namespaceId} IS NULL AND ${table.agentId} IS NULL
          AND ${table.issuer} IS NOT NULL AND ${table.subject} IS NOT NULL)
        OR (${table.kind} = 'service_principal'
          AND (${table.agentId} IS NULL OR ${table.namespaceId} IS NOT NULL)
          AND ${table.issuer} IS NULL AND ${table.subject} IS NULL)
      )`,
    ),
    uniqueIndex("iam_principal_external_subject")
      .on(table.issuer, table.subject)
      .where(sql`${table.kind} = 'principal'`),
    uniqueIndex("iam_one_service_principal_per_agent")
      .on(table.namespaceId, table.agentId)
      .where(sql`${table.kind} = 'service_principal' AND ${table.agentId} IS NOT NULL`),
  ],
);

export const iamRoles = occSchema.table(
  "iam_roles",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").references(() => namespaces.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    name: collatedText("name"),
    permissions: jsonb("permissions").$type<readonly Record<string, unknown>[]>().notNull(),
  },
  (table) => [
    unique("iam_roles_namespace_id_id_unique").on(table.namespaceId, table.id).nullsNotDistinct(),
    check("iam_roles_permissions_array", sql`jsonb_typeof(${table.permissions}) = 'array'`),
  ],
);

export const iamGroups = occSchema.table(
  "iam_groups",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").references(() => namespaces.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    name: collatedText("name").notNull(),
  },
  (table) => [
    unique("iam_groups_namespace_id_id_unique").on(table.namespaceId, table.id).nullsNotDistinct(),
    unique("iam_groups_namespace_id_name_unique")
      .on(table.namespaceId, table.name)
      .nullsNotDistinct(),
    check("iam_groups_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check(
      "iam_groups_name_normalized",
      sql`${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
    ),
  ],
);

export const iamGroupMemberships = occSchema.table(
  "iam_group_memberships",
  {
    namespaceId: text("namespace_id").references(() => namespaces.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    groupId: text("group_id")
      .notNull()
      .references(() => iamGroups.id, { onDelete: "restrict", onUpdate: "restrict" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => iamIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }),
  },
  (table) => [
    unique("iam_group_memberships_group_principal_unique").on(table.groupId, table.principalId),
  ],
);

export const iamAccessBindings = occSchema.table(
  "iam_access_bindings",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").references(() => namespaces.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    identitySubjectId: text("identity_subject_id").references(() => iamIdentities.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    groupSubjectId: text("group_subject_id").references(() => iamGroups.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    roleId: text("role_id")
      .notNull()
      .references(() => iamRoles.id, { onDelete: "restrict", onUpdate: "restrict" }),
    resourceKind: text("resource_kind"),
    resourceId: text("resource_id"),
  },
  (table) => [
    check(
      "iam_access_bindings_one_subject",
      sql`num_nonnulls(${table.identitySubjectId}, ${table.groupSubjectId}) = 1`,
    ),
    check(
      "iam_access_bindings_resource_pair",
      sql`(${table.resourceKind} IS NULL) = (${table.resourceId} IS NULL)`,
    ),
  ],
);

export const iamRestrictions = occSchema.table(
  "iam_restrictions",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").references(() => namespaces.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    action: text("action").notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceId: text("resource_id"),
    effect: text("effect").notNull().default("deny"),
  },
  (table) => [
    check(
      "iam_restrictions_action_valid",
      sql`${table.action} IN ('create', 'read', 'update', 'delete', 'deploy', 'operate', 'administer')`,
    ),
    check(
      "iam_restrictions_resource_kind_valid",
      sql`${table.resourceKind} IN ('installation', 'namespace', 'configuration', 'service_account', 'secret', 'agent', 'agent_revision')`,
    ),
    check("iam_restrictions_effect_deny", sql`${table.effect} = 'deny'`),
    check(
      "iam_restrictions_resource_id_normalized",
      sql`${table.resourceId} IS NULL OR (${table.resourceId} = btrim(${table.resourceId}) AND char_length(${table.resourceId}) BETWEEN 1 AND 200)`,
    ),
  ],
);

export const auditEvents = occSchema.table(
  "audit_events",
  {
    id: text("id").primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    namespaceId: text("namespace_id"),
    resourceKind: text("resource_kind").notNull(),
    resourceId: text("resource_id").notNull(),
    outcome: text("outcome").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (table) => [
    check("audit_events_id_format", sql`${table.id} ~ ${identifierPatterns.audit}`),
    check("audit_events_outcome_valid", sql`${table.outcome} IN ('success', 'denied', 'failure')`),
    check(
      "audit_events_details_object",
      sql`${table.details} IS NULL OR jsonb_typeof(${table.details}) = 'object'`,
    ),
  ],
);

export const controllerWork = occSchema.table(
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
    state: text("state").notNull().default("queued"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: "controller_work_agent_owner",
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [agents.namespaceId, agents.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
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
      sql`(
        (${table.agentId} IS NULL AND ${table.revisionId} IS NULL
          AND ${table.namespaceTarget} IS NOT NULL
          AND ${table.namespaceTarget} IN ('ready', 'deleted'))
        OR (${table.agentId} IS NOT NULL AND ${table.revisionId} IS NOT NULL
          AND ${table.namespaceTarget} IS NULL)
      )`,
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
  ],
);

export const user = occSchema.table(
  "user",
  {
    id: text("id").primaryKey(),
    name: collatedText("name").notNull(),
    email: collatedText("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("auth_user_id_length", sql`char_length(${table.id}) BETWEEN 1 AND 200`),
    check("auth_user_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check("auth_user_email_length", sql`char_length(${table.email}) BETWEEN 3 AND 320`),
    check(
      "auth_user_email_normalized",
      sql`${table.email} = lower(btrim(${table.email})) AND ${table.email} LIKE '%@%'`,
    ),
    check("auth_user_timestamp_order", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const session = occSchema.table(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade", onUpdate: "restrict" }),
  },
  (table) => [
    index("session_user_id_idx").on(table.userId),
    check("auth_session_id_length", sql`char_length(${table.id}) BETWEEN 1 AND 200`),
    check("auth_session_token_length", sql`char_length(${table.token}) BETWEEN 1 AND 512`),
    check("auth_session_timestamp_order", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const account = occSchema.table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade", onUpdate: "restrict" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    uniqueIndex("account_provider_account_unique").on(table.providerId, table.accountId),
    check("auth_account_id_length", sql`char_length(${table.id}) BETWEEN 1 AND 200`),
    check("auth_account_provider_length", sql`char_length(${table.providerId}) BETWEEN 1 AND 200`),
    check(
      "auth_account_external_id_length",
      sql`char_length(${table.accountId}) BETWEEN 1 AND 512`,
    ),
    check("auth_account_timestamp_order", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const verification = occSchema.table(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("verification_identifier_idx").on(table.identifier),
    check("auth_verification_id_length", sql`char_length(${table.id}) BETWEEN 1 AND 200`),
    check(
      "auth_verification_identifier_length",
      sql`char_length(${table.identifier}) BETWEEN 1 AND 512`,
    ),
    check("auth_verification_value_length", sql`char_length(${table.value}) BETWEEN 1 AND 4096`),
    check("auth_verification_timestamp_order", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

// Better Auth owns this schema and hashed key lifecycle. referenceId resolves
// through the selected IAM Driver, which need not store identities in OCC.
export const apikey = occSchema.table(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").notNull(),
    name: text("name"),
    start: text("start"),
    referenceId: text("reference_id").notNull(),
    prefix: text("prefix"),
    key: text("key").notNull().unique(),
    refillInterval: bigint("refill_interval", { mode: "number" }),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at", { withTimezone: true }),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(false),
    rateLimitTimeWindow: bigint("rate_limit_time_window", { mode: "number" }),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    index("apikey_config_id_idx").on(table.configId),
    index("apikey_reference_id_idx").on(table.referenceId),
  ],
);

const runtimeReferencePattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export const agentRuntimeIntents = occSchema.table(
  "agent_runtime_intents",
  {
    transitionRef: text("transition_ref").primaryKey(),
    installationId: text("installation_id")
      .notNull()
      .references(() => installation.id, { onDelete: "restrict", onUpdate: "restrict" }),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    desiredMode: text("desired_mode").$type<"running" | "disabled" | "stopped">().notNull(),
    revisionId: text("revision_id").notNull(),
    actorId: text("actor_id").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("runtime_intents_agent_generation_unique").on(
      table.namespaceId,
      table.agentId,
      table.generation,
    ),
    unique("runtime_intents_head_identity_unique").on(
      table.namespaceId,
      table.agentId,
      table.generation,
      table.transitionRef,
    ),
    unique("runtime_intents_allocation_identity_unique").on(
      table.installationId,
      table.namespaceId,
      table.agentId,
      table.generation,
      table.revisionId,
    ),
    foreignKey({
      name: "runtime_intents_agent_owner",
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [agents.namespaceId, agents.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    foreignKey({
      name: "runtime_intents_revision_owner",
      columns: [table.namespaceId, table.agentId, table.revisionId],
      foreignColumns: [agentRevisions.namespaceId, agentRevisions.agentId, agentRevisions.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    check(
      "runtime_intents_transition_ref_format",
      sql`${table.transitionRef} ~ ${runtimeReferencePattern}`,
    ),
    check(
      "runtime_intents_generation_valid",
      sql`${table.generation} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "runtime_intents_mode_valid",
      sql`${table.desiredMode} IN ('running', 'disabled', 'stopped')`,
    ),
    check(
      "runtime_intents_actor_id_valid",
      sql`char_length(${table.actorId}) BETWEEN 1 AND 200 AND ${table.actorId} ~ '^[A-Za-z0-9._:/-]+$'`,
    ),
    check(
      "runtime_intents_request_id_valid",
      sql`char_length(${table.requestId}) BETWEEN 1 AND 200 AND ${table.requestId} ~ '^[A-Za-z0-9._:/-]+$'`,
    ),
    check("runtime_intents_created_at_finite", sql`isfinite(${table.createdAt})`),
  ],
);

// Migration triggers additionally enforce initial generation one and exact head increments.
export const agentRuntimeIntentHeads = occSchema.table(
  "agent_runtime_intent_heads",
  {
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    transitionRef: text("transition_ref").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("runtime_intent_heads_agent_unique").on(table.namespaceId, table.agentId),
    foreignKey({
      name: "runtime_intent_heads_history_owner",
      columns: [table.namespaceId, table.agentId, table.generation, table.transitionRef],
      foreignColumns: [
        agentRuntimeIntents.namespaceId,
        agentRuntimeIntents.agentId,
        agentRuntimeIntents.generation,
        agentRuntimeIntents.transitionRef,
      ],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    check(
      "runtime_intent_heads_generation_valid",
      sql`${table.generation} BETWEEN 1 AND 9007199254740991`,
    ),
  ],
);

// Migration triggers lock the owner and head, require the current running intent,
// and enforce exact component increments; immutable rows retain historical identity.
export const runtimeAssignmentAllocations = occSchema.table(
  "runtime_assignment_allocations",
  {
    assignmentRef: text("assignment_ref").primaryKey(),
    createEffectRef: text("create_effect_ref").notNull(),
    installationId: text("installation_id").notNull(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    revisionId: text("revision_id").notNull(),
    servicePrincipalId: text("service_principal_id").notNull(),
    lifecycleGeneration: bigint("lifecycle_generation", { mode: "number" }).notNull(),
    component: text("component").$type<"gateway" | "harness">().notNull(),
    runtimeGeneration: bigint("runtime_generation", { mode: "number" }).notNull(),
    providerProfileRef: text("provider_profile_ref").notNull(),
    runtimeProfileRef: text("runtime_profile_ref").notNull(),
    identityProfileRef: text("identity_profile_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    bindingCondition: text("binding_condition").$type<"unbound">().notNull().default("unbound"),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("runtime_allocations_create_effect_unique").on(table.createEffectRef),
    unique("runtime_allocations_component_generation_unique").on(
      table.namespaceId,
      table.agentId,
      table.component,
      table.runtimeGeneration,
    ),
    foreignKey({
      name: "runtime_allocations_intent_owner",
      columns: [
        table.installationId,
        table.namespaceId,
        table.agentId,
        table.lifecycleGeneration,
        table.revisionId,
      ],
      foreignColumns: [
        agentRuntimeIntents.installationId,
        agentRuntimeIntents.namespaceId,
        agentRuntimeIntents.agentId,
        agentRuntimeIntents.generation,
        agentRuntimeIntents.revisionId,
      ],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    foreignKey({
      name: "runtime_allocations_agent_principal_owner",
      columns: [table.namespaceId, table.agentId, table.servicePrincipalId],
      foreignColumns: [agents.namespaceId, agents.id, agents.servicePrincipalId],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    check(
      "runtime_allocations_assignment_ref_format",
      sql`${table.assignmentRef} ~ ${runtimeReferencePattern}`,
    ),
    check(
      "runtime_allocations_create_effect_ref_format",
      sql`${table.createEffectRef} ~ ${runtimeReferencePattern}`,
    ),
    check(
      "runtime_allocations_lifecycle_generation_valid",
      sql`${table.lifecycleGeneration} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "runtime_allocations_runtime_generation_valid",
      sql`${table.runtimeGeneration} BETWEEN 1 AND 9007199254740991`,
    ),
    check("runtime_allocations_component_valid", sql`${table.component} IN ('gateway', 'harness')`),
    check(
      "runtime_allocations_binding_condition_valid",
      sql`${table.bindingCondition} = 'unbound'`,
    ),
    check(
      "runtime_allocations_provider_profile_ref_valid",
      sql`char_length(${table.providerProfileRef}) BETWEEN 1 AND 200 AND ${table.providerProfileRef} ~ '^[A-Za-z0-9._:/-]+$'`,
    ),
    check(
      "runtime_allocations_runtime_profile_ref_valid",
      sql`char_length(${table.runtimeProfileRef}) BETWEEN 1 AND 200 AND ${table.runtimeProfileRef} ~ '^[A-Za-z0-9._:/-]+$'`,
    ),
    check(
      "runtime_allocations_identity_profile_ref_valid",
      sql`char_length(${table.identityProfileRef}) BETWEEN 1 AND 200 AND ${table.identityProfileRef} ~ '^[A-Za-z0-9._:/-]+$'`,
    ),
    check("runtime_allocations_created_at_finite", sql`isfinite(${table.createdAt})`),
  ],
);

// Migration triggers preserve binding identities and enforce status versions and parent locking.
export const channelInstallations = occSchema.table(
  "channel_installations",
  {
    id: text("id").primaryKey(),
    installationId: text("installation_id")
      .notNull()
      .references(() => installation.id, { onUpdate: "restrict", onDelete: "restrict" }),
    version: bigint("version", { mode: "number" }).notNull(),
    status: text("status").$type<"enabled" | "disabled">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    createdBy: collatedText("created_by").notNull(),
    updatedBy: collatedText("updated_by").notNull(),
    platform: text("platform").$type<"slack" | "msteams">().notNull(),
    providerTenantRef: collatedText("provider_tenant_ref").notNull(),
    recipientAppRef: collatedText("recipient_app_ref").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "channel_installations_id_format",
      sql`${table.id} ~ '^chi_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "channel_installations_version_valid",
      sql`${table.version} BETWEEN 1 AND 9007199254740991`,
    ),
    check("channel_installations_status_valid", sql`${table.status} IN ('enabled', 'disabled')`),
    check(
      "channel_installations_timestamps_valid",
      sql`isfinite(${table.createdAt}) AND isfinite(${table.updatedAt}) AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      "channel_installations_created_by_valid",
      sql`octet_length(${table.createdBy}) BETWEEN 1 AND 1024 AND ${table.createdBy} COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
    ),
    check(
      "channel_installations_updated_by_valid",
      sql`octet_length(${table.updatedBy}) BETWEEN 1 AND 1024 AND ${table.updatedBy} COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
    ),
    check(
      "channel_installations_provider_tenant_ref_valid",
      sql`octet_length(${table.providerTenantRef}) BETWEEN 1 AND 1024 AND ${table.providerTenantRef} COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
    ),
    check(
      "channel_installations_recipient_app_ref_valid",
      sql`octet_length(${table.recipientAppRef}) BETWEEN 1 AND 1024 AND ${table.recipientAppRef} COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
    ),
    unique("channel_installations_owner_id_unique").on(table.installationId, table.id),
    unique("channel_installations_retained_tuple_unique").on(
      table.platform,
      table.providerTenantRef,
      table.recipientAppRef,
    ),
    check("channel_installations_platform_valid", sql`${table.platform} IN ('slack', 'msteams')`),
  ],
);

export const channelHumanBindings = occSchema.table(
  "channel_human_bindings",
  {
    id: text("id").primaryKey(),
    installationId: text("installation_id")
      .notNull()
      .references(() => installation.id, { onUpdate: "restrict", onDelete: "restrict" }),
    version: bigint("version", { mode: "number" }).notNull(),
    status: text("status").$type<"enabled" | "disabled">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    createdBy: collatedText("created_by").notNull(),
    updatedBy: collatedText("updated_by").notNull(),
    channelInstallationId: text("channel_installation_id").notNull(),
    providerSubjectRef: collatedText("provider_subject_ref").notNull(),
    iamDriverId: collatedText("iam_driver_id").notNull(),
    principalId: collatedText("principal_id").notNull(),
    principalIssuer: collatedText("principal_issuer").notNull(),
    principalSubject: collatedText("principal_subject").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "channel_human_bindings_id_format",
      sql`${table.id} ~ '^chh_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "channel_human_bindings_version_valid",
      sql`${table.version} BETWEEN 1 AND 9007199254740991`,
    ),
    check("channel_human_bindings_status_valid", sql`${table.status} IN ('enabled', 'disabled')`),
    check(
      "channel_human_bindings_timestamps_valid",
      sql`isfinite(${table.createdAt}) AND isfinite(${table.updatedAt}) AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      "channel_human_bindings_created_by_valid",
      sql`octet_length(${table.createdBy}) BETWEEN 1 AND 1024 AND ${table.createdBy} COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
    ),
    check(
      "channel_human_bindings_updated_by_valid",
      sql`octet_length(${table.updatedBy}) BETWEEN 1 AND 1024 AND ${table.updatedBy} COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
    ),
    check(
      "channel_human_bindings_provider_subject_ref_valid",
      sql`octet_length(${table.providerSubjectRef}) BETWEEN 1 AND 1024 AND ${table.providerSubjectRef} COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
    ),
    check(
      "channel_human_bindings_iam_driver_id_valid",
      sql`octet_length(${table.iamDriverId}) BETWEEN 1 AND 1024 AND ${table.iamDriverId} COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
    ),
    check(
      "channel_human_bindings_principal_id_valid",
      sql`octet_length(${table.principalId}) BETWEEN 1 AND 1024 AND ${table.principalId} COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
    ),
    check(
      "channel_human_bindings_principal_issuer_valid",
      sql`octet_length(${table.principalIssuer}) BETWEEN 1 AND 1024 AND ${table.principalIssuer} COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
    ),
    check(
      "channel_human_bindings_principal_subject_valid",
      sql`octet_length(${table.principalSubject}) BETWEEN 1 AND 1024 AND ${table.principalSubject} COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
    ),
    foreignKey({
      name: "channel_human_bindings_parent_owner",
      columns: [table.installationId, table.channelInstallationId],
      foreignColumns: [channelInstallations.installationId, channelInstallations.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    unique("channel_human_bindings_retained_tuple_unique").on(
      table.channelInstallationId,
      table.providerSubjectRef,
    ),
  ],
);

export const channelAgentBindings = occSchema.table(
  "channel_agent_bindings",
  {
    id: text("id").primaryKey(),
    installationId: text("installation_id")
      .notNull()
      .references(() => installation.id, { onUpdate: "restrict", onDelete: "restrict" }),
    version: bigint("version", { mode: "number" }).notNull(),
    status: text("status").$type<"enabled" | "disabled">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    createdBy: collatedText("created_by").notNull(),
    updatedBy: collatedText("updated_by").notNull(),
    channelInstallationId: text("channel_installation_id").notNull(),
    channelRef: collatedText("channel_ref").notNull(),
    scopeKind: text("scope_kind")
      .$type<"slack-private-channel" | "msteams-standard-channel">()
      .notNull(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "channel_agent_bindings_id_format",
      sql`${table.id} ~ '^cha_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "channel_agent_bindings_version_valid",
      sql`${table.version} BETWEEN 1 AND 9007199254740991`,
    ),
    check("channel_agent_bindings_status_valid", sql`${table.status} IN ('enabled', 'disabled')`),
    check(
      "channel_agent_bindings_timestamps_valid",
      sql`isfinite(${table.createdAt}) AND isfinite(${table.updatedAt}) AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      "channel_agent_bindings_created_by_valid",
      sql`octet_length(${table.createdBy}) BETWEEN 1 AND 1024 AND ${table.createdBy} COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
    ),
    check(
      "channel_agent_bindings_updated_by_valid",
      sql`octet_length(${table.updatedBy}) BETWEEN 1 AND 1024 AND ${table.updatedBy} COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
    ),
    check(
      "channel_agent_bindings_channel_ref_valid",
      sql`octet_length(${table.channelRef}) BETWEEN 1 AND 1024 AND ${table.channelRef} COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')`,
    ),
    foreignKey({
      name: "channel_agent_bindings_parent_owner",
      columns: [table.installationId, table.channelInstallationId],
      foreignColumns: [channelInstallations.installationId, channelInstallations.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    unique("channel_agent_bindings_retained_tuple_unique").on(
      table.channelInstallationId,
      table.channelRef,
    ),
    foreignKey({
      name: "channel_agent_bindings_agent_owner",
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [agents.namespaceId, agents.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    check(
      "channel_agent_bindings_scope_kind_valid",
      sql`${table.scopeKind} IN ('slack-private-channel', 'msteams-standard-channel')`,
    ),
  ],
);

export const signInQuotaSlots = occSchema.table(
  "sign_in_quota_slots",
  {
    slot: integer("slot").primaryKey(),
    nextAtMs: bigint("next_at_ms", { mode: "number" }).notNull(),
  },
  (table) => [
    check("sign_in_quota_slot_bounded", sql`${table.slot} >= 0 AND ${table.slot} < 20480`),
    check("sign_in_quota_timestamp_valid", sql`${table.nextAtMs} BETWEEN 0 AND 9007199254740991`),
  ],
);
