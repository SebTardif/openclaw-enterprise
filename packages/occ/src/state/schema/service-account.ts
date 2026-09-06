import type { ServiceAccountCredential } from "@openclaw-enterprise/contracts";
import { sql } from "drizzle-orm";
import { check, jsonb, text, unique } from "drizzle-orm/pg-core";
import { namespaces } from "./namespace.ts";
import { collatedText, identifierPatterns, occSchema } from "./shared.ts";

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
