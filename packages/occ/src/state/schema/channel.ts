import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  text,
  timestamp,
  unique,
  type AnyPgColumn,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { collatedText } from "./shared.ts";

type CanonicalOccSchema = typeof import("./shared.ts").occSchema;

export interface ChannelSchemaParents {
  readonly installation: { readonly id: AnyPgColumn };
  readonly agents: { readonly namespaceId: AnyPgColumn; readonly id: AnyPgColumn };
}

/** The aggregate supplies the original schema and canonical parent columns. */
export function createChannelTables(
  occSchema: CanonicalOccSchema,
  { installation, agents }: ChannelSchemaParents,
) {
  // Migration triggers preserve binding identities and enforce status versions and parent locking.
  const channelInstallations = occSchema.table(
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

  const channelHumanBindings = occSchema.table(
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

  const channelAgentBindings = occSchema.table(
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

  return { channelInstallations, channelHumanBindings, channelAgentBindings };
}
