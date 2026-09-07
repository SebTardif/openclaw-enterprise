import { sql } from "drizzle-orm";
import { check, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { collatedText, identifierPatterns, occSchema } from "./shared.ts";

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
