import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  primaryKey,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

type CanonicalOccSchema = typeof import("./shared.ts").occSchema;

export interface AccountSecuritySchemaParentsV1 {
  readonly installation: { readonly id: AnyPgColumn };
  readonly user: { readonly id: AnyPgColumn };
  readonly account: { readonly id: AnyPgColumn };
}

/** The original aggregate supplies the original account and user columns.
 * Live locator FKs are DEFERRABLE INITIALLY DEFERRED in the companion SQL;
 * immutable identity and its tombstone never cascade with a deleted user.
 * TODO: Register this factory and the reviewed forward SQL together through
 * the original account-security schema integration; no registration is implied. */
export function createAccountSecurityTablesV1(
  occSchema: CanonicalOccSchema,
  { installation, user, account }: AccountSecuritySchemaParentsV1,
) {
  if (!installation?.id || !user?.id || !account?.id)
    throw new Error(
      "Account security requires the original Installation, user and account parents.",
    );

  const accountSecurityRecords = occSchema.table(
    "account_security_records",
    {
      installationId: text("installation_id").notNull(),
      accountId: text("account_id").notNull(),
      issuer: text("issuer").notNull(),
      subject: text("subject").notNull(),
      incarnation: uuid("incarnation").notNull(),
      accountVersion: bigint("account_version", { mode: "number" }).notNull(),
      state: text("state").$type<"provisioning" | "active" | "deleted">().notNull(),
      currentUserId: text("current_user_id"),
      credentialAccountId: text("credential_account_id"),
    },
    (table) => [
      primaryKey({
        name: "account_security_records_pk",
        columns: [table.installationId, table.accountId],
      }),
      unique("account_security_records_incarnation_unique").on(table.incarnation),
      unique("account_security_records_current_user_unique").on(table.currentUserId),
      unique("account_security_records_credential_unique").on(table.credentialAccountId),
      foreignKey({
        name: "account_security_records_installation_fk",
        columns: [table.installationId],
        foreignColumns: [installation.id],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      foreignKey({
        name: "account_security_records_current_user_fk",
        columns: [table.currentUserId],
        foreignColumns: [user.id],
      })
        .onUpdate("no action")
        .onDelete("no action"),
      foreignKey({
        name: "account_security_records_credential_fk",
        columns: [table.credentialAccountId],
        foreignColumns: [account.id],
      })
        .onUpdate("no action")
        .onDelete("no action"),
      check(
        "account_security_records_account_id_valid",
        sql`char_length(${table.accountId}) BETWEEN 1 AND 200`,
      ),
      check(
        "account_security_records_issuer_exact",
        sql`${table.issuer} = 'occ:installation:' || ${table.installationId} || ':better-auth'`,
      ),
      check("account_security_records_subject_exact", sql`${table.subject} = ${table.accountId}`),
      check(
        "account_security_records_version_valid",
        sql`${table.accountVersion} BETWEEN 1 AND 9007199254740991`,
      ),
      check(
        "account_security_records_live_user_exact",
        sql`${table.currentUserId} IS NULL OR ${table.currentUserId} = ${table.accountId}`,
      ),
      check(
        "account_security_records_state_shape",
        sql`
        (${table.state} = 'provisioning' AND ${table.currentUserId} IS NOT NULL AND ${table.credentialAccountId} IS NULL)
        OR (${table.state} = 'active' AND ${table.currentUserId} IS NOT NULL AND ${table.credentialAccountId} IS NOT NULL)
        OR (${table.state} = 'deleted' AND ${table.currentUserId} IS NULL AND ${table.credentialAccountId} IS NULL)
      `,
      ),
    ],
  );
  return { accountSecurityRecords };
}
