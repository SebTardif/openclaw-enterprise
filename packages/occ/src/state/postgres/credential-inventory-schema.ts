import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  primaryKey,
  text,
  unique,
  type AnyPgColumn,
  type PgSchema,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";

/** The existing OCC schema and parent tables are supplied by their owner.
 * This factory creates no connection, migration number, role or material store. */
export interface CredentialInventorySchemaParentsV1 {
  readonly installation: { readonly id: AnyPgColumn };
  readonly agents: { readonly namespaceId: AnyPgColumn; readonly id: AnyPgColumn };
}
export function createCredentialInventoryTablesV1(
  schema: PgSchema,
  parents: CredentialInventorySchemaParentsV1,
) {
  const scope = () => ({
    installationId: text("installation_id")
      .notNull()
      .references(() => parents.installation.id, { onUpdate: "restrict", onDelete: "restrict" }),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
  });
  type ScopeColumns = {
    installationId: AnyPgColumn;
    namespaceId: AnyPgColumn;
    agentId: AnyPgColumn;
  };
  const columns = (table: ScopeColumns) =>
    [table.installationId, table.namespaceId, table.agentId] as const;
  const agentOwner = (name: string, table: ScopeColumns) =>
    foreignKey({
      name,
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [parents.agents.namespaceId, parents.agents.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict");
  const bounded = (name: string, column: AnyPgColumn) =>
    check(
      name,
      sql`jsonb_typeof(${column}) = 'object' AND octet_length(${column}::text) BETWEEN 1 AND 131072`,
    );
  const safeVersion = (name: string, column: AnyPgColumn) =>
    check(name, sql`${column} BETWEEN 1 AND 9007199254740991`);
  const records = schema.table(
    "credential_inventory_records",
    {
      ...scope(),
      recordRef: text("record_ref").notNull(),
      inventoryVersion: bigint("inventory_version", { mode: "number" }).notNull(),
      bindingRef: text("binding_ref").notNull(),
      live: boolean("live").notNull(),
      unresolved: boolean("unresolved").notNull(),
      document: jsonb("document").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "credential_inventory_records_pk",
        columns: [...columns(table), table.recordRef],
      }),
      agentOwner("credential_inventory_records_agent", table),
      bounded("credential_inventory_records_document", table.document),
      safeVersion("credential_inventory_records_version", table.inventoryVersion),
      index("credential_inventory_records_live")
        .on(table.installationId, table.namespaceId, table.agentId, table.bindingRef)
        .where(sql`${table.live}`),
      check(
        "credential_inventory_records_identity",
        sql`(
      ${table.document}#>>'{issuance,scope,installationId}' = ${table.installationId}
      AND ${table.document}#>>'{issuance,scope,namespaceId}' = ${table.namespaceId}
      AND ${table.document}#>>'{issuance,scope,agentId}' = ${table.agentId}
      AND ${table.document}#>>'{target,recordRef}' = ${table.recordRef}
      AND (${table.document}->>'inventoryVersion')::numeric = ${table.inventoryVersion}
      AND ${table.document}#>>'{issuance,binding,bindingRef}' = ${table.bindingRef}
      AND ${table.document}->>'state' IN ('reserved','mint-unknown','not-issued','outstanding','resolved-without-token')
      AND ${table.unresolved} = (${table.document}->>'state' IN ('reserved','mint-unknown'))
      AND ${table.live} = (${table.document}->>'state' IN ('reserved','mint-unknown') OR
        (${table.document}->>'state' = 'outstanding' AND ${table.document}#>>'{revocation,state}' NOT IN ('confirmed','expired')))
    ) IS TRUE`,
      ),
    ],
  );
  const recordOwner = (name: string, table: ScopeColumns & { recordRef: AnyPgColumn }) =>
    foreignKey({
      name,
      columns: [...columns(table), table.recordRef],
      foreignColumns: [...columns(records), records.recordRef],
    })
      .onUpdate("restrict")
      .onDelete("restrict");
  const operations = schema.table(
    "credential_inventory_operations",
    {
      ...scope(),
      operationRef: text("operation_ref").notNull(),
      recordRef: text("record_ref").notNull(),
      document: jsonb("document").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "credential_inventory_operations_pk",
        columns: [table.installationId, table.operationRef],
      }),
      recordOwner("credential_inventory_operations_record", table),
      bounded("credential_inventory_operations_document", table.document),
      check(
        "credential_inventory_operations_identity",
        sql`(
      ${table.document}#>>'{input,operationRef}' = ${table.operationRef}
      AND ${table.document}#>>'{input,scope,installationId}' = ${table.installationId}
      AND ${table.document}#>>'{input,scope,namespaceId}' = ${table.namespaceId}
      AND ${table.document}#>>'{input,scope,agentId}' = ${table.agentId}
      AND ${table.document}#>>'{record,target,recordRef}' = ${table.recordRef}
      AND ${table.document}->>'digest' ~ '^sha256:[0-9a-f]{64}$'
      AND ${table.document}->>'state' IN ('intent-recorded','effect-pending','effect-unknown','completed')
      AND NOT (${table.document} ? 'originalReceipt')
    ) IS TRUE`,
      ),
    ],
  );
  const mintClaims = schema.table(
    "credential_inventory_mint_claims",
    {
      ...scope(),
      recordRef: text("record_ref").notNull(),
      useOperationRef: text("use_operation_ref").notNull(),
      providerAttemptRef: text("provider_attempt_ref").notNull(),
      document: jsonb("document").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "credential_inventory_mint_claims_pk",
        columns: [...columns(table), table.recordRef],
      }),
      recordOwner("credential_inventory_mint_claims_record", table),
      unique("credential_inventory_mint_claims_use").on(
        table.installationId,
        table.useOperationRef,
      ),
      unique("credential_inventory_mint_claims_attempt").on(
        table.installationId,
        table.providerAttemptRef,
      ),
      bounded("credential_inventory_mint_claims_document", table.document),
      check(
        "credential_inventory_mint_claims_identity",
        sql`(
      ${table.document}->>'recordRef' = ${table.recordRef}
      AND ${table.document}->>'useOperationRef' = ${table.useOperationRef}
      AND ${table.document}->>'providerAttemptRef' = ${table.providerAttemptRef}
      AND ${table.document}->>'issuanceIntentDigest' ~ '^sha256:[0-9a-f]{64}$'
      AND ${table.document}->>'useIntentDigest' ~ '^sha256:[0-9a-f]{64}$'
      AND (${table.document}->>'inventoryVersion')::numeric BETWEEN 1 AND 9007199254740991
    ) IS TRUE`,
      ),
    ],
  );
  const revocationClaims = schema.table(
    "credential_inventory_revocation_claims",
    {
      ...scope(),
      claimRef: text("claim_ref").notNull(),
      claimVersion: bigint("claim_version", { mode: "number" }).notNull(),
      recordRef: text("record_ref").notNull(),
      document: jsonb("document").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "credential_inventory_revocation_claims_pk",
        columns: [...columns(table), table.claimRef],
      }),
      recordOwner("credential_inventory_revocation_claims_record", table),
      unique("credential_inventory_revocation_claims_version").on(
        ...columns(table),
        table.recordRef,
        table.claimVersion,
      ),
      safeVersion("credential_inventory_revocation_claims_version_bound", table.claimVersion),
      bounded("credential_inventory_revocation_claims_document", table.document),
      check(
        "credential_inventory_revocation_claims_identity",
        sql`(
      ${table.document}->>'claimRef' = ${table.claimRef}
      AND (${table.document}->>'claimVersion')::numeric = ${table.claimVersion}
      AND ${table.document}#>>'{input,target,recordRef}' = ${table.recordRef}
      AND ${table.document}#>>'{input,scope,installationId}' = ${table.installationId}
      AND ${table.document}#>>'{input,scope,namespaceId}' = ${table.namespaceId}
      AND ${table.document}#>>'{input,scope,agentId}' = ${table.agentId}
    ) IS TRUE`,
      ),
    ],
  );
  const snapshots = schema.table(
    "credential_inventory_snapshots",
    {
      ...scope(),
      snapshotRef: text("snapshot_ref").notNull(),
      snapshotVersion: bigint("snapshot_version", { mode: "number" }).notNull(),
      document: jsonb("document").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "credential_inventory_snapshots_pk",
        columns: [...columns(table), table.snapshotRef],
      }),
      agentOwner("credential_inventory_snapshots_agent", table),
      safeVersion("credential_inventory_snapshots_version", table.snapshotVersion),
      bounded("credential_inventory_snapshots_document", table.document),
      check(
        "credential_inventory_snapshots_identity",
        sql`(
      ${table.document}->>'snapshotRef' = ${table.snapshotRef}
      AND (${table.document}->>'snapshotVersion')::numeric = ${table.snapshotVersion}
      AND ${table.document}#>>'{filter,scope,installationId}' = ${table.installationId}
      AND ${table.document}#>>'{filter,scope,namespaceId}' = ${table.namespaceId}
      AND ${table.document}#>>'{filter,scope,agentId}' = ${table.agentId}
      AND ${table.document}->>'filterDigest' ~ '^sha256:[0-9a-f]{64}$'
      AND jsonb_typeof(${table.document}->'records') = 'array'
      AND jsonb_array_length(${table.document}->'records') BETWEEN 0 AND 4
    ) IS TRUE`,
      ),
    ],
  );
  return {
    credentialInventoryRecords: records,
    credentialInventoryOperations: operations,
    credentialInventoryMintClaims: mintClaims,
    credentialInventoryRevocationClaims: revocationClaims,
    credentialInventorySnapshots: snapshots,
  };
}
