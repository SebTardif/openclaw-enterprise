import type { SecretBindings } from "@openclaw-enterprise/contracts";
import { sql } from "drizzle-orm";
import { bigint, check, jsonb, text, timestamp, unique } from "drizzle-orm/pg-core";
import { namespaces } from "./namespace.ts";
import { identifierPatterns, occSchema } from "./shared.ts";

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
