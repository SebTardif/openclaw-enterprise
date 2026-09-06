import { sql } from "drizzle-orm";
import { check, text, timestamp, unique } from "drizzle-orm/pg-core";
import type { PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { namespaces } from "./namespace.ts";
import { collatedText, identifierPatterns, occSchema } from "./shared.ts";

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
