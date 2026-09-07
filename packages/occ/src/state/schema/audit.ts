import { sql } from "drizzle-orm";
import { check, jsonb, text, timestamp } from "drizzle-orm/pg-core";
import { identifierPatterns, occSchema } from "./shared.ts";

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
