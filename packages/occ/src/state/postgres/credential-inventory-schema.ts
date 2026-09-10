import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
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
  // Immutable metadata only; a lease row does not grant execution authority.
  const accessLeases = schema.table(
    "credential_inventory_access_leases",
    {
      ...scope(),
      accessLeaseRef: text("access_lease_ref").notNull(),
      stableTargetDigest: text("stable_target_digest").notNull(),
      document: jsonb("document").notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        name: "credential_inventory_access_leases_pk",
        columns: [table.installationId, table.accessLeaseRef],
      }),
      agentOwner("credential_inventory_access_leases_agent", table),
      unique("credential_inventory_access_leases_identity_tuple").on(
        ...columns(table),
        table.accessLeaseRef,
        table.stableTargetDigest,
      ),
      bounded("credential_inventory_access_leases_document", table.document),
      check(
        "credential_inventory_access_leases_identity",
        sql`(
          ${table.document}->>'schemaVersion' = '2'
          AND ${table.document}->>'accessLeaseRef' = ${table.accessLeaseRef}
          AND ${table.document}#>>'{original,scope,installationRef}' = ${table.installationId}
          AND ${table.document}#>>'{original,scope,namespaceRef}' = ${table.namespaceId}
          AND ${table.document}#>>'{original,scope,agentRef}' = ${table.agentId}
          AND length(${table.document}#>>'{original,scope,revisionRef}') > 0
          AND ${table.document}#>>'{target,installationId}' = ${table.installationId}
          AND ${table.document}#>>'{target,githubHost}' = 'github.com'
          AND ${table.document}#>>'{target,installationId}' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
          AND ${table.document}#>>'{target,appId}' ~ '^[1-9][0-9]{0,19}$'
          AND ${table.document}#>>'{target,githubInstallationId}' ~ '^[1-9][0-9]{0,19}$'
          AND ${table.document}#>>'{target,repositoryId}' ~ '^[1-9][0-9]{0,19}$'
          AND jsonb_typeof(${table.document}->'work') = 'object'
          AND jsonb_typeof(${table.document}->'execution') = 'object'
          AND length(${table.document}->>'createdAt') > 0
          AND length(${table.document}->>'notAfter') > 0
          AND ${table.stableTargetDigest} ~ '^sha256:[0-9a-f]{64}$'
          AND ${table.stableTargetDigest} = 'sha256:' || encode(sha256(convert_to(
            (${table.document}#>>'{target,installationId}') || E'\\n' ||
            (${table.document}#>>'{target,githubHost}') || E'\\n' ||
            (${table.document}#>>'{target,appId}') || E'\\n' ||
            (${table.document}#>>'{target,githubInstallationId}') || E'\\n' ||
            (${table.document}#>>'{target,repositoryId}'), 'UTF8')), 'hex')
        ) IS TRUE`,
      ),
    ],
  );
  const records = schema.table(
    "credential_inventory_records",
    {
      ...scope(),
      recordRef: text("record_ref").notNull(),
      schemaVersion: integer("schema_version").notNull().default(1),
      stableTargetDigest: text("stable_target_digest"),
      accessLeaseRef: text("access_lease_ref"),
      liveSlot: smallint("live_slot"),
      mintActive: boolean("mint_active").notNull().default(false),
      targetHeld: boolean("target_held").notNull().default(false),
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
      foreignKey({
        name: "credential_inventory_records_access_lease",
        columns: [...columns(table), table.accessLeaseRef, table.stableTargetDigest],
        foreignColumns: [
          ...columns(accessLeases),
          accessLeases.accessLeaseRef,
          accessLeases.stableTargetDigest,
        ],
      })
        .onUpdate("restrict")
        .onDelete("restrict"),
      uniqueIndex("credential_inventory_records_lease_live_slot")
        .on(table.installationId, table.accessLeaseRef, table.liveSlot)
        .where(sql`${table.schemaVersion} = 2 AND ${table.live}`),
      uniqueIndex("credential_inventory_records_lease_active_mint")
        .on(table.installationId, table.accessLeaseRef)
        .where(sql`${table.schemaVersion} = 2 AND ${table.mintActive}`),
      index("credential_inventory_records_target_hold")
        .on(table.installationId, table.stableTargetDigest)
        .where(sql`${table.schemaVersion} = 2 AND ${table.targetHeld} AND ${table.live}`),
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
      AND (
        (${table.schemaVersion} = 1
          AND ${table.document}->>'schemaVersion' = '1'
          AND ${table.document}#>>'{issuance,binding,bindingRef}' = ${table.bindingRef}
          AND ${table.stableTargetDigest} IS NULL AND ${table.accessLeaseRef} IS NULL
          AND ${table.liveSlot} IS NULL AND NOT ${table.mintActive} AND NOT ${table.targetHeld})
        OR (${table.schemaVersion} = 2
          AND ${table.document}->>'schemaVersion' = '2'
          AND ${table.document}#>>'{issuance,bindingRef}' = ${table.bindingRef}
          AND ${table.document}#>>'{issuance,lease,accessLeaseRef}' = ${table.accessLeaseRef}
          AND ${table.accessLeaseRef} IS NOT NULL
          AND ${table.stableTargetDigest} ~ '^sha256:[0-9a-f]{64}$'
          AND ((${table.live} AND ${table.liveSlot} IN (1, 2))
            OR (NOT ${table.live} AND ${table.liveSlot} IS NULL))
          AND ${table.mintActive} = (${table.document}->>'state' IN ('reserved','mint-unknown'))
          AND ${table.targetHeld} = (${table.document}->>'state' = 'mint-unknown'
            OR (${table.document}->>'state' = 'outstanding'
              AND ${table.document}->>'disposition' = 'mitigation-only')))
      )
      AND ${table.document}->>'state' IN ('reserved','mint-unknown','not-issued','outstanding','resolved-without-token')
      AND ${table.unresolved} = (${table.document}->>'state' IN ('reserved','mint-unknown'))
      AND ${table.live} = (${table.document}->>'state' IN ('reserved','mint-unknown') OR
        (${table.document}->>'state' = 'outstanding' AND (
          ${table.schemaVersion} = 2 OR (${table.schemaVersion} = 1
            AND ${table.document}#>>'{revocation,state}' NOT IN ('confirmed','expired')))))
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
    credentialInventoryAccessLeases: accessLeases,
    credentialInventoryRecords: records,
    credentialInventoryOperations: operations,
    credentialInventoryMintClaims: mintClaims,
    credentialInventoryRevocationClaims: revocationClaims,
    credentialInventorySnapshots: snapshots,
  };
}
