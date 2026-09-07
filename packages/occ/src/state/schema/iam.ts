import type { ChannelAdministrationMappingV1 } from "@openclaw-enterprise/contracts";
import { sql } from "drizzle-orm";
import { check, foreignKey, jsonb, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { collatedText } from "./shared.ts";

export function createIamTables(
  occSchema: typeof import("./shared.ts").occSchema,
  parents: Readonly<{
    namespaces: { id: AnyPgColumn };
    agents: { namespaceId: AnyPgColumn; id: AnyPgColumn };
  }>,
) {
  const { namespaces, agents } = parents;

  const iamIdentities = occSchema.table(
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

  const iamRoles = occSchema.table(
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

  const iamGroups = occSchema.table(
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
      unique("iam_groups_namespace_id_id_unique")
        .on(table.namespaceId, table.id)
        .nullsNotDistinct(),
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

  const iamGroupMemberships = occSchema.table(
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

  const iamAccessBindings = occSchema.table(
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
      channelAdministration:
        jsonb("channel_administration").$type<ChannelAdministrationMappingV1>(),
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
      check(
        "iam_access_bindings_channel_administration_valid",
        sql`${table.channelAdministration} IS NULL OR occ.channel_administration_mapping_valid(${table.channelAdministration})`,
      ),
    ],
  );

  const iamRestrictions = occSchema.table(
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

  return {
    iamIdentities,
    iamRoles,
    iamGroups,
    iamGroupMemberships,
    iamAccessBindings,
    iamRestrictions,
  };
}
