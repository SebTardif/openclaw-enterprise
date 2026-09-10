import { Check } from "typebox/value";
import {
  parseCredentialStorageV1,
  OutstandingTokenRecordSchemaV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type {
  CredentialAuditEvidenceV1,
  OutstandingTokenRecordV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type {
  QueryRepositoryFactoryContext,
  TransactionQueryResult,
} from "../ports/repository-factory.ts";
import type {
  CredentialInventoryTransactionV1,
  InventoryMutationV1,
  InventoryOperationV1,
  InventoryScopeV1,
  InventorySnapshotV1,
  ProviderMintClaimV1,
  RetainedRevocationClaimV1,
} from "./ports.ts";
import {
  canonicalInventoryValueV1,
  inventoryIntentDigestV1,
  isLiveInventoryRecordV1,
  INVENTORY_LIMITS_V1,
} from "./transactions.ts";
import { bindRepositoryLeaseInventoryV2 } from "./repository-lease-postgres-v2.ts";
import type {
  RepositoryAccessLeaseV2,
  RepositoryTokenRecordV2,
  RepositoryInventoryOperationV2,
  RepositoryLeaseInventoryTransactionV2,
  RepositoryMintClaimV2,
  RepositoryRevocationClaimV2,
} from "./repository-lease-v2.ts";

/** The original owner admits and drains the WHOLE credential transition, including
 * accepting authority, audit, custody and final currentness. This assertion is
 * not an authority issuer. Its poison latch must be checked before outer commit. */
export interface PostgresCredentialInventoryPhaseV1 {
  /** Only the genuine accepting wrapper opens preparation, before acceptance. */
  assertPreparing(stage: "scope" | "keys"): void;
  /** Accepted exact invocation and original owner active-operation permission. */
  assertActive(): void;
  /** Writer mode with completed ordered scope/key preparation. */
  assertWriting(): void;
  poison(error: unknown): void;
  /** Original owner retains these private completion facts and checks the whole
   * accepted transition before commit. This is not an audit or second journal. */
  recordEffect(effect: PostgresCredentialInventoryEffectV1): void;
}
export type PostgresCredentialInventoryEffectV1 =
  | { readonly kind: "repository-lease-inserted"; readonly lease: RepositoryAccessLeaseV2 }
  | { readonly kind: "repository-record-inserted"; readonly record: RepositoryTokenRecordV2 }
  | {
      readonly kind: "repository-record-replaced";
      readonly expectedVersion: number;
      readonly record: RepositoryTokenRecordV2;
    }
  | {
      readonly kind: "repository-operation-appended";
      readonly operation: RepositoryInventoryOperationV2;
    }
  | { readonly kind: "record-inserted"; readonly record: OutstandingTokenRecordV1 }
  | {
      readonly kind: "record-replaced";
      readonly expectedVersion: number;
      readonly record: OutstandingTokenRecordV1;
    }
  | { readonly kind: "operation-appended"; readonly operation: InventoryOperationV1 }
  | { readonly kind: "mint-claim-inserted"; readonly claim: ProviderMintClaimV1 }
  | { readonly kind: "repository-mint-claim-inserted"; readonly claim: RepositoryMintClaimV2 }
  | {
      readonly kind: "repository-revocation-claim-appended";
      readonly claim: RepositoryRevocationClaimV2;
    }
  | { readonly kind: "revocation-claim-appended"; readonly claim: RetainedRevocationClaimV1 }
  | { readonly kind: "snapshot-inserted"; readonly snapshot: InventorySnapshotV1 }
  | {
      readonly kind: "custody-retained";
      readonly input: Extract<InventoryMutationV1, { outcome: "accepted" }>;
    }
  | {
      readonly kind: "revocation-token-loaded";
      readonly record: Extract<OutstandingTokenRecordV1, { state: "outstanding" }>;
    }
  | {
      readonly kind: "audit-appended";
      readonly input: InventoryMutationV1;
      readonly mitigation: boolean;
      readonly evidence: CredentialAuditEvidenceV1;
    };
export interface PostgresCredentialInventoryContextV1 extends QueryRepositoryFactoryContext {
  readonly inventoryScope: InventoryScopeV1;
  readonly commitRef: string;
  readonly phase: PostgresCredentialInventoryPhaseV1;
}
/** Actual owners bind these to the identical original client/phase. Missing
 * producers remain unavailable; metadata cannot mint custody or audit evidence. */
export interface PostgresCredentialInventoryDependenciesV1 {
  readonly custody?: Pick<CredentialInventoryTransactionV1, "retainToken" | "loadRevocationToken">;
  readonly audit?: Pick<CredentialInventoryTransactionV1, "appendAudit">;
}

const MAX_DOCUMENT_BYTES = 131072;
const scopeWhere = "installation_id=$1 AND namespace_id=$2 AND agent_id=$3";
const tables = {
  operations: "occ.credential_inventory_operations",
  records: "occ.credential_inventory_records",
  mintClaims: "occ.credential_inventory_mint_claims",
  revokeClaims: "occ.credential_inventory_revocation_claims",
  snapshots: "occ.credential_inventory_snapshots",
} as const;
const fail = (message: string): never => {
  throw new Error(message);
};
const same = (a: unknown, b: unknown) =>
  canonicalInventoryValueV1(a) === canonicalInventoryValueV1(b);
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return fail("Invalid inventory row shape.");
  return value as Record<string, unknown>;
}
function reference(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:/-]{1,200}$/.test(value))
    return fail("Invalid inventory reference.");
  return value;
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    return fail("Invalid inventory version.");
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value))
    return fail("Invalid inventory digest.");
  return value;
}
/** Copy only the producer's exact own data properties. An audit projection has
 * scalar fields, so this frozen snapshot has no mutable producer alias. */
function auditProjection(
  value: unknown,
  input: InventoryMutationV1,
  commitRef: string,
  mitigation: boolean,
): CredentialAuditEvidenceV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string")
  )
    fail("Invalid credential audit projection.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || !("value" in descriptor),
    )
  )
    fail("Invalid credential audit projection.");
  const evidence = Object.freeze(
    Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    ),
  );
  if (!Check(OutstandingTokenRecordSchemaV1.anyOf[0].properties.audit, evidence))
    fail("Invalid credential audit projection.");
  if (
    evidence.eventRef !== input.originalAuditRef ||
    ("commitRef" in evidence && evidence.commitRef !== commitRef)
  )
    fail("Credential audit correlation mismatch.");
  if (!mitigation && evidence.state !== "accepted") fail("Credential audit evidence is required.");
  return evidence as CredentialAuditEvidenceV1;
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    return fail("Invalid inventory timestamp.");
  return value;
}
function document(value: unknown): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_DOCUMENT_BYTES)
    return fail("Inventory document exceeds its bound.");
  return JSON.parse(text) as unknown;
}
function mutation(value: unknown): InventoryMutationV1 {
  const kind = (value as { method?: unknown } | null)?.method;
  switch (kind) {
    case "reserveIssuance":
      return parseCredentialStorageV1("reserve", value);
    case "withNamedCredential": {
      const input = parseCredentialStorageV1("namedUse", value);
      if (input.purpose !== "repository-mint") return fail("Invalid inventory mutation.");
      return input;
    }
    case "recordMintOutcome":
      return parseCredentialStorageV1("mintOutcome", value);
    case "claimRevocation":
      return parseCredentialStorageV1("claimRevocation", value);
    case "recordRevocation":
      return parseCredentialStorageV1("revocationOutcome", value);
    default:
      return fail("Invalid inventory mutation.");
  }
}
function operation(value: unknown): InventoryOperationV1 {
  const row = object(document(value), [
    "input",
    "digest",
    "state",
    "record",
    "commitRef",
    "recordedAt",
  ]);
  const input = mutation(row.input);
  const record = parseCredentialStorageV1("record", row.record);
  const locatorMatches =
    input.method === "reserveIssuance"
      ? same(input, record.issuance)
      : same(input.method === "withNamedCredential" ? input.issuance : input.target, record.target);
  if (
    digest(row.digest) !== inventoryIntentDigestV1(input) ||
    !same(input.scope, record.issuance.scope) ||
    !same(input.profile, record.issuance.profile) ||
    input.callerServiceRef !== record.issuance.callerServiceRef ||
    !locatorMatches ||
    !["intent-recorded", "effect-pending", "effect-unknown", "completed"].includes(
      String(row.state),
    )
  )
    return fail("Invalid immutable inventory operation.");
  return {
    input,
    digest: row.digest as string,
    state: row.state as InventoryOperationV1["state"],
    record,
    commitRef: reference(row.commitRef),
    recordedAt: instant(row.recordedAt),
  };
}
function mintClaim(value: unknown): ProviderMintClaimV1 {
  const row = object(document(value), [
    "issuanceOperationRef",
    "recordRef",
    "issuanceIntentDigest",
    "useOperationRef",
    "useIntentDigest",
    "providerAttemptRef",
    "inventoryVersion",
  ]);
  return {
    issuanceOperationRef: reference(row.issuanceOperationRef),
    recordRef: reference(row.recordRef),
    issuanceIntentDigest: digest(row.issuanceIntentDigest),
    useOperationRef: reference(row.useOperationRef),
    useIntentDigest: digest(row.useIntentDigest),
    providerAttemptRef: reference(row.providerAttemptRef),
    inventoryVersion: version(row.inventoryVersion),
  };
}
function revocationClaim(value: unknown): RetainedRevocationClaimV1 {
  const row = object(document(value), [
    "input",
    "claimRef",
    "claimVersion",
    "providerAttemptRef",
    "claimedAt",
    "claimNotAfter",
  ]);
  const input = parseCredentialStorageV1("claimRevocation", row.input);
  const claimedAt = instant(row.claimedAt),
    claimNotAfter = instant(row.claimNotAfter);
  if (
    Date.parse(claimNotAfter) <= Date.parse(claimedAt) ||
    Date.parse(claimNotAfter) - Date.parse(claimedAt) > INVENTORY_LIMITS_V1.claimMs
  )
    return fail("Invalid retained claim lease.");
  return {
    input,
    claimRef: reference(row.claimRef),
    claimVersion: version(row.claimVersion),
    providerAttemptRef: reference(row.providerAttemptRef),
    claimedAt,
    claimNotAfter,
  };
}

/** Owner-internal scope preparation, before the accepting wrapper returns true.
 * The genuine owner enforces READ COMMITTED, upstream participant order and one
 * preparing phase. This helper does not authorize anything or open repository
 * access. Revalidate canonical currentness and prepare the complete bounded key
 * set in the original owner after these waits. No J/barrier lock belongs here. */
export async function preparePostgresCredentialInventoryScopeV1(
  context: PostgresCredentialInventoryContextV1,
): Promise<void> {
  const scope = Object.freeze({ ...context.inventoryScope });
  const active = () => {
    context.transaction.assertActive();
    context.phase.assertPreparing("scope");
    if (
      context.scope.installationId !== scope.installationId ||
      (context.scope.namespaceId !== undefined &&
        context.scope.namespaceId !== scope.namespaceId) ||
      !same(context.inventoryScope, scope)
    )
      fail("Inventory preparation scope mismatch.");
  };
  const lock = async (statement: string, values: readonly string[], expected: string) => {
    active();
    const result = await context.query.query(statement, values);
    active();
    if (
      result.rowCount !== 1 ||
      result.rows.length !== 1 ||
      object(result.rows[0], ["id"]).id !== expected
    )
      fail("Inventory scope parent unavailable.");
  };
  try {
    await lock(
      "SELECT id FROM occ.installation WHERE id = $1 FOR NO KEY UPDATE",
      [scope.installationId],
      scope.installationId,
    );
    await lock(
      "SELECT id FROM occ.namespaces WHERE id = $1 FOR NO KEY UPDATE",
      [scope.namespaceId],
      scope.namespaceId,
    );
    await lock(
      "SELECT id FROM occ.agents WHERE namespace_id = $1 AND id = $2 FOR NO KEY UPDATE",
      [scope.namespaceId, scope.agentId],
      scope.agentId,
    );
  } catch (error) {
    context.phase.poison(error);
    throw error;
  }
}

/** The accepting owner derives and validates the complete bounded exact key set
 * after scope preparation, before canonical acceptance completes. An extra earlier
 * key discovered later aborts that owner's phase rather than reopening this helper. */
export interface PostgresCredentialInventoryKeySetV1 {
  readonly operations: readonly string[];
  readonly records: readonly string[];
  readonly mintClaims: readonly string[];
  readonly revocationClaims: readonly string[];
  readonly snapshots: readonly string[];
}
export async function preparePostgresCredentialInventoryKeysV1(
  context: PostgresCredentialInventoryContextV1,
  keys: PostgresCredentialInventoryKeySetV1,
): Promise<void> {
  const scope = Object.freeze({ ...context.inventoryScope });
  const active = () => {
    context.transaction.assertActive();
    context.phase.assertPreparing("keys");
    if (
      context.scope.installationId !== scope.installationId ||
      (context.scope.namespaceId !== undefined &&
        context.scope.namespaceId !== scope.namespaceId) ||
      !same(context.inventoryScope, scope)
    )
      fail("Inventory key preparation scope mismatch.");
  };
  const plan = [
    [tables.operations, "operation_ref", keys.operations],
    [tables.records, "record_ref", keys.records],
    [tables.mintClaims, "record_ref", keys.mintClaims],
    [tables.revokeClaims, "claim_ref", keys.revocationClaims],
    [tables.snapshots, "snapshot_ref", keys.snapshots],
  ] as const;
  try {
    active();
    const checked = plan.map(([table, key, refs]) => {
      if (!Array.isArray(refs) || refs.length > 20 || new Set(refs).size !== refs.length)
        fail("Inventory key set exceeds its exact bound.");
      return [table, key, refs.map(reference).sort()] as const;
    });
    for (const [table, key, refs] of checked) {
      if (!refs.length) continue;
      active();
      const result = await context.query.query(
        `SELECT ${key} AS key FROM ${table} WHERE ${scopeWhere} AND ${key}=ANY($4::text[]) ORDER BY ${key} COLLATE "C" FOR UPDATE`,
        [scope.installationId, scope.namespaceId, scope.agentId, refs],
      );
      active();
      if (
        !Number.isSafeInteger(result.rowCount) ||
        result.rowCount !== result.rows.length ||
        result.rows.length > refs.length
      )
        fail("Invalid inventory key lock acknowledgment.");
      const found = result.rows.map((row) => reference(object(row, ["key"]).key));
      if (
        new Set(found).size !== found.length ||
        found.some((key) => !refs.includes(key)) ||
        !same(found, [...found].sort())
      )
        fail("Inventory key lock mismatch.");
    }
  } catch (error) {
    context.phase.poison(error);
    throw error;
  }
}

/** Query-only PostgreSQL persistence. No pool, connection, transaction control,
 * retry, provider callback or outer-commit classification. The genuine owner has
 * already completed canonical acceptance and ordered scope/key preparation.
 * Repository calls must not reacquire upstream locks after Agent/currentness.
 * Ordinary accepted exact reads can use their separately admitted read mode. */
export function createPostgresCredentialInventoryV1(
  context: PostgresCredentialInventoryContextV1,
  dependencies: PostgresCredentialInventoryDependenciesV1,
): CredentialInventoryTransactionV1 & {
  readonly repositoryLeaseV2: RepositoryLeaseInventoryTransactionV2;
} {
  const scope = Object.freeze({ ...context.inventoryScope });
  const commitRef = reference(context.commitRef);
  const values = [scope.installationId, scope.namespaceId, scope.agentId] as const;
  const active = () => {
    context.transaction.assertActive();
    context.phase.assertActive();
    if (
      context.scope.installationId !== scope.installationId ||
      (context.scope.namespaceId !== undefined &&
        context.scope.namespaceId !== scope.namespaceId) ||
      !same(context.inventoryScope, scope)
    )
      return fail("Inventory scope differs from its owning transaction.");
  };
  const query = async (
    statement: string,
    parameters: readonly unknown[],
  ): Promise<TransactionQueryResult> => {
    active();
    const result = await context.query.query(statement, parameters);
    active();
    if (
      !result ||
      !Array.isArray(result.rows) ||
      !Number.isSafeInteger(result.rowCount) ||
      result.rowCount! < 0 ||
      result.rowCount !== result.rows.length
    )
      return fail("Invalid inventory query acknowledgment.");
    return result;
  };
  const run = async <T>(work: () => Promise<T>, writing = false): Promise<T> => {
    try {
      active();
      if (writing) context.phase.assertWriting();
      const result = await work();
      active();
      return result;
    } catch (error) {
      context.phase.poison(error);
      throw error;
    }
  };
  const scoped = (candidate: InventoryScopeV1) => {
    if (!same(candidate, scope)) return fail("Cross-scope inventory operation.");
  };
  const one = async (table: string, key: string, value: string): Promise<unknown | undefined> => {
    const result = await query(
      `SELECT installation_id,namespace_id,agent_id,document FROM ${table} WHERE ${scopeWhere} AND ${key}=$4`,
      [...values, reference(value)],
    );
    if (result.rows.length > 1) return fail("Non-unique inventory key.");
    const first = result.rows[0];
    if (first === undefined) return undefined;
    const row = object(first, ["installation_id", "namespace_id", "agent_id", "document"]);
    if (
      row.installation_id !== values[0] ||
      row.namespace_id !== values[1] ||
      row.agent_id !== values[2]
    )
      return fail("Cross-scope inventory query result.");
    return row.document;
  };
  const changed = async (statement: string, parameters: readonly unknown[]) => {
    const result = await query(statement, parameters);
    if (result.rowCount !== 1) return fail("Inventory uniqueness or compare-and-swap conflict.");
  };
  const encoded = (value: unknown) => JSON.stringify(document(value));
  const readRecord = async (recordRef: string) => {
    const raw = await one(tables.records, "record_ref", recordRef);
    if (raw === undefined) return undefined;
    const row = parseCredentialStorageV1("record", document(raw));
    scoped(row.issuance.scope);
    if (row.target.recordRef !== recordRef) return fail("Inventory record key mismatch.");
    return row;
  };
  const recordValues = (row: OutstandingTokenRecordV1) => [
    row.target.recordRef,
    row.inventoryVersion,
    row.issuance.binding.bindingRef,
    isLiveInventoryRecordV1(row),
    row.state === "reserved" || row.state === "mint-unknown",
    encoded(row),
  ];
  const snapshot = (value: unknown): InventorySnapshotV1 => {
    const row = object(document(value), [
      "snapshotRef",
      "snapshotVersion",
      "callerServiceRef",
      "filter",
      "profile",
      "filterDigest",
      "createdAt",
      "expiresAt",
      "records",
      "continuation",
    ]);
    const filter = row.filter as InventorySnapshotV1["filter"];
    const profile = parseCredentialStorageV1("profile", row.profile);
    scoped(profile.scope);
    if (
      !filter ||
      !same(filter.scope, scope) ||
      !Array.isArray(row.records) ||
      row.records.length > INVENTORY_LIMITS_V1.perAgent
    )
      return fail("Invalid inventory snapshot scope or bound.");
    const createdAt = instant(row.createdAt),
      expiresAt = instant(row.expiresAt);
    if (Date.parse(expiresAt) - Date.parse(createdAt) !== INVENTORY_LIMITS_V1.snapshotMs)
      return fail("Invalid inventory snapshot lifetime.");
    const records = row.records.map((value) => {
      const record = parseCredentialStorageV1("record", value);
      scoped(record.issuance.scope);
      if (
        record.issuance.binding.bindingRef !== filter.bindingRef ||
        !isLiveInventoryRecordV1(record)
      )
        return fail("Invalid snapshot membership.");
      return record;
    });
    if (new Set(records.map((record) => record.target.recordRef)).size !== records.length)
      return fail("Duplicate snapshot membership.");
    const page = parseCredentialStorageV1("affectedPage", {
      kind: "page",
      snapshotRef: row.snapshotRef,
      snapshotVersion: row.snapshotVersion,
      filter,
      filterDigest: row.filterDigest,
      createdAt,
      expiresAt,
      records,
      next: null,
      outstandingCount: records.filter((record) => record.state === "outstanding").length,
      unresolvedIssuanceCount: records.filter(
        (record) => record.state === "reserved" || record.state === "mint-unknown",
      ).length,
      coverage: "persisted-snapshot-only",
    });
    if (page.kind !== "page") return fail("Invalid inventory snapshot.");
    return {
      snapshotRef: reference(row.snapshotRef),
      snapshotVersion: version(row.snapshotVersion),
      callerServiceRef: reference(row.callerServiceRef),
      filter,
      profile,
      filterDigest: digest(row.filterDigest),
      createdAt,
      expiresAt,
      records,
      continuation: reference(row.continuation),
    };
  };
  const repository: CredentialInventoryTransactionV1 = {
    assertActive: active,
    commitRef,
    findOperation: (operationRef: string) =>
      run(async () => {
        const raw = await one(tables.operations, "operation_ref", operationRef);
        if (raw === undefined) return undefined;
        const row = operation(raw);
        scoped(row.input.scope);
        if (row.input.operationRef !== operationRef)
          return fail("Inventory operation key mismatch.");
        // Original acknowledgment projection is intentionally unprovided. This
        // committed observation never manufactures an originalReceipt timestamp.
        return row;
      }),
    appendOperation: (input: InventoryOperationV1) =>
      run(async () => {
        const row = operation(input);
        scoped(row.input.scope);
        if (row.commitRef !== commitRef)
          return fail("Inventory operation commit correlation mismatch.");
        await changed(
          `INSERT INTO ${tables.operations} (installation_id,namespace_id,agent_id,operation_ref,record_ref,document) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING operation_ref`,
          [...values, row.input.operationRef, row.record.target.recordRef, encoded(row)],
        );
        context.phase.recordEffect({ kind: "operation-appended", operation: row });
      }, true),
    findRecord: (recordRef: string) => run(() => readRecord(recordRef)),
    insertRecord: (input: OutstandingTokenRecordV1) =>
      run(async () => {
        const row = parseCredentialStorageV1("record", input);
        scoped(row.issuance.scope);
        if (row.inventoryVersion !== 1 || row.state !== "reserved")
          return fail("An inventory record must start with a reserved intent.");
        await changed(
          `INSERT INTO ${tables.records} (installation_id,namespace_id,agent_id,record_ref,inventory_version,binding_ref,live,unresolved,document) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING record_ref`,
          [...values, ...recordValues(row)],
        );
        context.phase.recordEffect({ kind: "record-inserted", record: row });
      }, true),
    replaceRecord: (expectedVersion: number, input: OutstandingTokenRecordV1) =>
      run(async () => {
        const row = parseCredentialStorageV1("record", input);
        scoped(row.issuance.scope);
        version(expectedVersion);
        if (
          expectedVersion === Number.MAX_SAFE_INTEGER ||
          row.inventoryVersion !== expectedVersion + 1
        )
          return fail("Invalid inventory compare-and-swap increment.");
        await changed(
          `UPDATE ${tables.records} SET inventory_version=$5,binding_ref=$6,live=$7,unresolved=$8,document=$9::jsonb WHERE ${scopeWhere} AND record_ref=$4 AND inventory_version=$10 AND document->'issuance'=$11::jsonb AND document->'target'=$12::jsonb RETURNING record_ref`,
          [
            ...values,
            ...recordValues(row),
            expectedVersion,
            encoded(row.issuance),
            encoded(row.target),
          ],
        );
        context.phase.recordEffect({ kind: "record-replaced", expectedVersion, record: row });
      }, true),
    liveCounts: () =>
      run(async () => {
        const result = await query(
          `SELECT count(*)::text AS installation,count(*) FILTER (WHERE namespace_id=$2 AND agent_id=$3)::text AS agent,count(*) FILTER (WHERE namespace_id=$2 AND agent_id=$3 AND unresolved)::text AS unresolved FROM ${tables.records} WHERE installation_id=$1 AND live`,
          values,
        );
        const row = object(result.rows[0], ["installation", "agent", "unresolved"]);
        const count = (value: unknown) => {
          if (
            typeof value !== "string" ||
            !/^(0|[1-9][0-9]*)$/.test(value) ||
            !Number.isSafeInteger(Number(value))
          )
            return fail("Invalid inventory count.");
          return Number(value);
        };
        return {
          installation: count(row.installation),
          agent: count(row.agent),
          unresolved: count(row.unresolved),
        };
      }),
    listLive: (bindingRef: string) =>
      run(async () => {
        const result = await query(
          `SELECT document FROM ${tables.records} WHERE ${scopeWhere} AND binding_ref=$4 AND live AND document->>'schemaVersion'='1' ORDER BY record_ref COLLATE "C" LIMIT $5`,
          [...values, reference(bindingRef), INVENTORY_LIMITS_V1.perAgent + 1],
        );
        if (result.rows.length > INVENTORY_LIMITS_V1.perAgent)
          return fail("Inventory scope exceeds its capacity.");
        return result.rows.map((value) => {
          const row = parseCredentialStorageV1(
            "record",
            document(object(value, ["document"]).document),
          );
          scoped(row.issuance.scope);
          if (row.issuance.binding.bindingRef !== bindingRef || !isLiveInventoryRecordV1(row))
            return fail("Invalid live inventory query result.");
          return row;
        });
      }),
    findMintClaim: (recordRef: string) =>
      run(async () => {
        const raw = await one(tables.mintClaims, "record_ref", recordRef);
        if (raw === undefined) return undefined;
        const row = mintClaim(raw);
        if (row.recordRef !== recordRef) return fail("Mint claim key mismatch.");
        return row;
      }),
    insertMintClaim: (input: ProviderMintClaimV1) =>
      run(async () => {
        const row = mintClaim(input);
        const record = await readRecord(row.recordRef);
        if (
          !record ||
          record.state !== "reserved" ||
          record.target.issuanceOperationRef !== row.issuanceOperationRef ||
          record.target.intentDigest !== row.issuanceIntentDigest ||
          record.inventoryVersion + 1 !== row.inventoryVersion
        )
          return fail("Mint claim does not match its original issuance.");
        await changed(
          `INSERT INTO ${tables.mintClaims} (installation_id,namespace_id,agent_id,record_ref,use_operation_ref,provider_attempt_ref,document) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING record_ref`,
          [...values, row.recordRef, row.useOperationRef, row.providerAttemptRef, encoded(row)],
        );
        context.phase.recordEffect({ kind: "mint-claim-inserted", claim: row });
      }, true),
    findRevocationClaim: (claimRef: string) =>
      run(async () => {
        const raw = await one(tables.revokeClaims, "claim_ref", claimRef);
        if (raw === undefined) return undefined;
        const row = revocationClaim(raw);
        scoped(row.input.scope);
        if (row.claimRef !== claimRef) return fail("Historical revocation claim key mismatch.");
        return row;
      }),
    appendRevocationClaim: (input: RetainedRevocationClaimV1) =>
      run(async () => {
        const row = revocationClaim(input);
        scoped(row.input.scope);
        await changed(
          `INSERT INTO ${tables.revokeClaims} (installation_id,namespace_id,agent_id,claim_ref,claim_version,record_ref,document) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING claim_ref`,
          [...values, row.claimRef, row.claimVersion, row.input.target.recordRef, encoded(row)],
        );
        context.phase.recordEffect({ kind: "revocation-claim-appended", claim: row });
      }, true),
    findSnapshot: (snapshotRef: string) =>
      run(async () => {
        const raw = await one(tables.snapshots, "snapshot_ref", snapshotRef);
        if (raw === undefined) return undefined;
        const row = snapshot(raw);
        if (row.snapshotRef !== snapshotRef) return fail("Inventory snapshot key mismatch.");
        return row;
      }),
    insertSnapshot: (input: InventorySnapshotV1) =>
      run(async () => {
        const row = snapshot(input);
        await changed(
          `INSERT INTO ${tables.snapshots} (installation_id,namespace_id,agent_id,snapshot_ref,snapshot_version,document) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING snapshot_ref`,
          [...values, row.snapshotRef, row.snapshotVersion, encoded(row)],
        );
        context.phase.recordEffect({ kind: "snapshot-inserted", snapshot: row });
      }, true),
    retainToken: (input, token) =>
      run(async () => {
        const accepted = parseCredentialStorageV1("mintOutcome", input);
        scoped(accepted.scope);
        if (accepted.outcome !== "accepted" || !dependencies.custody)
          return fail("Protected inventory custody is unavailable.");
        await dependencies.custody.retainToken(accepted, token);
        active();
        context.phase.recordEffect({ kind: "custody-retained", input: accepted });
      }, true),
    loadRevocationToken: (record) =>
      run(async () => {
        const row = parseCredentialStorageV1("record", record);
        scoped(row.issuance.scope);
        if (row.state !== "outstanding" || !dependencies.custody)
          return fail("Protected inventory custody is unavailable.");
        const token = await dependencies.custody.loadRevocationToken(row);
        active();
        context.phase.recordEffect({ kind: "revocation-token-loaded", record: row });
        return token;
      }, true),
    appendAudit: (input, mitigation) =>
      run(async (): Promise<CredentialAuditEvidenceV1> => {
        const parsed = mutation(input);
        scoped(parsed.scope);
        if (!dependencies.audit) return fail("Mandatory credential audit producer is unavailable.");
        const returned = await dependencies.audit.appendAudit(parsed, mitigation);
        active();
        const evidence = auditProjection(returned, parsed, commitRef, mitigation);
        context.phase.recordEffect({ kind: "audit-appended", input: parsed, mitigation, evidence });
        return evidence;
      }, true),
  };
  return Object.freeze({
    ...repository,
    repositoryLeaseV2: bindRepositoryLeaseInventoryV2(context, repository, run, query),
  });
}
