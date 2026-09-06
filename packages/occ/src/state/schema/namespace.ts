import { sql } from "drizzle-orm";
import { check, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { collatedText, identifierPatterns, occSchema } from "./shared.ts";

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
