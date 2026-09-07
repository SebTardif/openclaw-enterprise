import { sql } from "drizzle-orm";
import { check, foreignKey, text, unique } from "drizzle-orm/pg-core";
import { serviceAccounts } from "./service-account.ts";
import { occSchema } from "./shared.ts";

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
