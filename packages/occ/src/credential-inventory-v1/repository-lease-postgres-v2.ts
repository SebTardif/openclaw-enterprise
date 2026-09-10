import type { PostgresCredentialInventoryContextV1 } from "./postgres.ts";
import type { TransactionQueryResult } from "../ports/repository-factory.ts";
import {
  canonicalRepositoryInventoryV2,
  parseRepositoryAccessLeaseV2,
  parseRepositoryInventoryOperationV2,
  parseRepositoryMintClaimV2,
  parseRepositoryRevocationClaimV2,
  parseRepositoryTokenRecordV2,
  repositoryLeaseScopeV2,
  repositoryRecordHeldV2,
  repositoryRecordLiveV2,
  repositoryTargetDigestV2,
  type RepositoryLeaseInventoryTransactionV2,
  type RepositoryTokenRecordV2,
} from "./repository-lease-v2.ts";
import type { CredentialInventoryTransactionV1 } from "./ports.ts";

/** Internal leaf installed only by createPostgresCredentialInventoryV1. It uses
 * that exact repository's guarded queries and phase; no connection, transaction,
 * owner, journal, capability, audit acceptance or custody factory lives here. */
export function bindRepositoryLeaseInventoryV2(
  context: PostgresCredentialInventoryContextV1,
  original: Pick<CredentialInventoryTransactionV1, "assertActive" | "commitRef">,
  run: <T>(work: () => Promise<T>, writing?: boolean) => Promise<T>,
  query: (statement: string, parameters: readonly unknown[]) => Promise<TransactionQueryResult>,
): RepositoryLeaseInventoryTransactionV2 {
  const scope = Object.freeze({ ...context.inventoryScope });
  const values = [scope.installationId, scope.namespaceId, scope.agentId];
  const where = "installation_id=$1 AND namespace_id=$2 AND agent_id=$3";
  function fail(): never {
    throw new Error("Repository inventory storage is unavailable.");
  }
  const ref = (v: unknown): string => {
    if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(v)) return fail();
    return v;
  };
  const same = (a: unknown, b: unknown) =>
    canonicalRepositoryInventoryV2(a) === canonicalRepositoryInventoryV2(b);
  const scoped = (s: unknown) => {
    if (!same(s, scope)) fail();
  };
  const raw = (result: TransactionQueryResult): unknown | undefined => {
    if (result.rows.length > 1) fail();
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    if (Object.keys(row).length !== 1 || !Object.hasOwn(row, "document")) fail();
    return row.document;
  };
  const changed = async (statement: string, parameters: readonly unknown[]) => {
    if ((await query(statement, parameters)).rowCount !== 1) fail();
  };
  const recordValues = (record: RepositoryTokenRecordV2) => [
    record.target.recordRef,
    record.inventoryVersion,
    record.issuance.bindingRef,
    repositoryRecordLiveV2(record),
    record.state === "reserved" || record.state === "mint-unknown",
    JSON.stringify(record),
    repositoryRecordHeldV2(record),
  ];
  const repository: RepositoryLeaseInventoryTransactionV2 = {
    assertActive: original.assertActive,
    commitRef: original.commitRef,
    findLease: (accessLeaseRef) =>
      run(async () => {
        const value = raw(
          await query(
            "SELECT document FROM occ.credential_inventory_access_leases WHERE installation_id=$1 AND access_lease_ref=$2",
            [scope.installationId, ref(accessLeaseRef)],
          ),
        );
        if (value === undefined) return undefined;
        const lease = parseRepositoryAccessLeaseV2(value);
        scoped(repositoryLeaseScopeV2(lease));
        if (lease.accessLeaseRef !== accessLeaseRef) fail();
        return lease;
      }),
    insertLease: (input) =>
      run(async () => {
        const lease = parseRepositoryAccessLeaseV2(input);
        scoped(repositoryLeaseScopeV2(lease));
        await changed(
          "INSERT INTO occ.credential_inventory_access_leases (installation_id,namespace_id,agent_id,access_lease_ref,stable_target_digest,document) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING access_lease_ref",
          [
            ...values,
            lease.accessLeaseRef,
            repositoryTargetDigestV2(lease.target),
            JSON.stringify(lease),
          ],
        );
        context.phase.recordEffect({ kind: "repository-lease-inserted", lease });
      }, true),
    findRecord: (recordRef) =>
      run(async () => {
        const value = raw(
          await query(
            `SELECT document FROM occ.credential_inventory_records WHERE ${where} AND record_ref=$4`,
            [...values, ref(recordRef)],
          ),
        );
        if (value === undefined) return undefined;
        const record = parseRepositoryTokenRecordV2(value);
        scoped(record.issuance.scope);
        if (record.target.recordRef !== recordRef) fail();
        return record;
      }),
    findOperation: (operationRef) =>
      run(async () => {
        const value = raw(
          await query(
            `SELECT document FROM occ.credential_inventory_operations WHERE ${where} AND operation_ref=$4`,
            [...values, ref(operationRef)],
          ),
        );
        if (value === undefined) return undefined;
        const operation = parseRepositoryInventoryOperationV2(value);
        scoped(operation.input.scope);
        if (operation.input.operationRef !== operationRef) fail();
        return operation;
      }),
    // Only potentially live responsibilities are enumerated. Terminal history is
    // retained and remains addressable through exact record/operation readback.
    listLeaseRecords: (accessLeaseRef) =>
      run(async () => {
        const lease = await repository.findLease(accessLeaseRef);
        if (!lease) return [];
        const result = await query(
          `SELECT document FROM occ.credential_inventory_records WHERE ${where} AND access_lease_ref=$4 AND schema_version=2 AND live ORDER BY record_ref COLLATE "C" LIMIT 3`,
          [...values, ref(accessLeaseRef)],
        );
        if (result.rows.length > 2) fail();
        return result.rows.map((v) => {
          const record = parseRepositoryTokenRecordV2((v as { document: unknown }).document);
          scoped(record.issuance.scope);
          if (!same(record.issuance.lease, lease) || !repositoryRecordLiveV2(record)) fail();
          return record;
        });
      }),
    capacity: (target, accessLeaseRef) =>
      run(async () => {
        if (target.installationId !== scope.installationId) fail();
        const result = await query(
          `SELECT count(*)::int AS installation_live,count(*) FILTER (WHERE access_lease_ref=$3)::int AS lease_live,coalesce(bool_or(mint_active) FILTER (WHERE access_lease_ref=$3),false) AS mint_active,coalesce(bool_or(target_held) FILTER (WHERE stable_target_digest=$2),false) AS target_held,coalesce(bool_or(live_slot=1) FILTER (WHERE access_lease_ref=$3),false) AS slot_one,coalesce(bool_or(live_slot=2) FILTER (WHERE access_lease_ref=$3),false) AS slot_two FROM occ.credential_inventory_records WHERE installation_id=$1 AND live`,
          [scope.installationId, repositoryTargetDigestV2(target), ref(accessLeaseRef)],
        );
        const r = result.rows[0] as Record<string, unknown>;
        if (
          !r ||
          Object.keys(r).length !== 6 ||
          ![r.installation_live, r.lease_live].every(
            (v) => Number.isSafeInteger(v) && Number(v) >= 0,
          ) ||
          ![r.mint_active, r.target_held, r.slot_one, r.slot_two].every(
            (v) => typeof v === "boolean",
          )
        )
          fail();
        let freeSlot: 1 | 2 | undefined;
        if (!r.slot_one) freeSlot = 1;
        else if (!r.slot_two) freeSlot = 2;
        return {
          installationLive: r.installation_live as number,
          leaseLive: r.lease_live as number,
          mintActive: r.mint_active as boolean,
          targetHeld: r.target_held as boolean,
          freeSlot,
        };
      }),
    insertRecord: (input, liveSlot) =>
      run(async () => {
        const record = parseRepositoryTokenRecordV2(input);
        scoped(record.issuance.scope);
        if (
          record.state !== "reserved" ||
          record.inventoryVersion !== 1 ||
          (liveSlot !== 1 && liveSlot !== 2)
        )
          fail();
        await changed(
          "INSERT INTO occ.credential_inventory_records (installation_id,namespace_id,agent_id,record_ref,inventory_version,binding_ref,live,unresolved,document,target_held,schema_version,stable_target_digest,access_lease_ref,live_slot,mint_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,2,$11,$12,$13,$8) RETURNING record_ref",
          [
            ...values,
            ...recordValues(record),
            repositoryTargetDigestV2(record.issuance.lease.target),
            record.issuance.lease.accessLeaseRef,
            liveSlot,
          ],
        );
        context.phase.recordEffect({ kind: "repository-record-inserted", record });
      }, true),
    replaceRecord: (expectedVersion, input) =>
      run(async () => {
        const record = parseRepositoryTokenRecordV2(input);
        scoped(record.issuance.scope);
        if (
          !Number.isSafeInteger(expectedVersion) ||
          expectedVersion < 1 ||
          expectedVersion === Number.MAX_SAFE_INTEGER ||
          record.inventoryVersion !== expectedVersion + 1
        )
          fail();
        await changed(
          `UPDATE occ.credential_inventory_records SET inventory_version=$5,binding_ref=$6,live=$7,unresolved=$8,document=$9::jsonb,target_held=$10,mint_active=$8,live_slot=CASE WHEN $7 THEN live_slot ELSE NULL END WHERE ${where} AND record_ref=$4 AND schema_version=2 AND inventory_version=$11 AND document->'issuance'=$12::jsonb AND document->'target'=$13::jsonb RETURNING record_ref`,
          [
            ...values,
            ...recordValues(record),
            expectedVersion,
            JSON.stringify(record.issuance),
            JSON.stringify(record.target),
          ],
        );
        context.phase.recordEffect({ kind: "repository-record-replaced", expectedVersion, record });
      }, true),
    appendOperation: (input) =>
      run(async () => {
        const operation = parseRepositoryInventoryOperationV2(input);
        scoped(operation.input.scope);
        if (operation.commitRef !== original.commitRef) fail();
        await changed(
          "INSERT INTO occ.credential_inventory_operations (installation_id,namespace_id,agent_id,operation_ref,record_ref,document) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING operation_ref",
          [
            ...values,
            operation.input.operationRef,
            operation.record.target.recordRef,
            JSON.stringify(operation),
          ],
        );
        context.phase.recordEffect({ kind: "repository-operation-appended", operation });
      }, true),
    findMintClaim: (recordRef) =>
      run(async () => {
        const value = raw(
          await query(
            `SELECT document FROM occ.credential_inventory_mint_claims WHERE ${where} AND record_ref=$4`,
            [...values, ref(recordRef)],
          ),
        );
        if (value === undefined) return undefined;
        const claim = parseRepositoryMintClaimV2(value);
        scoped(repositoryLeaseScopeV2(claim.custodyIdentity.lease));
        const record = await repository.findRecord(recordRef);
        if (
          !record ||
          claim.recordRef !== recordRef ||
          claim.issuanceOperationRef !== record.target.issuanceOperationRef ||
          claim.issuanceIntentDigest !== record.target.intentDigest ||
          !same(claim.custodyIdentity.lease, record.issuance.lease) ||
          claim.custodyIdentity.key.bindingRef !== record.issuance.bindingRef
        )
          fail();
        return claim;
      }),
    insertMintClaim: (input) =>
      run(async () => {
        const claim = parseRepositoryMintClaimV2(input);
        // The same immutable claim table/journal keys enforce exactly one original
        // attempt. Readback cannot create a new use operation after uncertain mint.
        const record = await repository.findRecord(claim.recordRef);
        if (
          !record ||
          record.state !== "reserved" ||
          record.target.issuanceOperationRef !== claim.issuanceOperationRef ||
          record.target.intentDigest !== claim.issuanceIntentDigest ||
          !same(claim.custodyIdentity.lease, record.issuance.lease) ||
          claim.custodyIdentity.key.bindingRef !== record.issuance.bindingRef ||
          claim.inventoryVersion !== record.inventoryVersion + 1 ||
          !/^sha256:[0-9a-f]{64}$/.test(claim.useIntentDigest)
        )
          fail();
        ref(claim.providerAttemptRef);
        ref(claim.useOperationRef);
        await changed(
          "INSERT INTO occ.credential_inventory_mint_claims (installation_id,namespace_id,agent_id,record_ref,use_operation_ref,provider_attempt_ref,document) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING record_ref",
          [
            ...values,
            claim.recordRef,
            claim.useOperationRef,
            claim.providerAttemptRef,
            JSON.stringify(claim),
          ],
        );
        context.phase.recordEffect({ kind: "repository-mint-claim-inserted", claim });
      }, true),
    findRevocationClaim: (claimRef) =>
      run(async () => {
        const value = raw(
          await query(
            `SELECT document FROM occ.credential_inventory_revocation_claims WHERE ${where} AND claim_ref=$4`,
            [...values, ref(claimRef)],
          ),
        );
        if (value === undefined) return undefined;
        const claim = parseRepositoryRevocationClaimV2(value);
        scoped(claim.input.scope);
        if (claim.claimRef !== claimRef) fail();
        const record = await repository.findRecord(claim.input.target.recordRef);
        if (!record || !same(record.target, claim.input.target)) fail();
        const mint = await repository.findMintClaim(claim.input.target.recordRef);
        if (
          !mint ||
          mint.custodyIdentity.tokenRef !== claim.input.tokenRef ||
          mint.custodyIdentity.protectedRevocationRef !== claim.input.protectedRevocationRef
        )
          fail();
        return claim;
      }),
    appendRevocationClaim: (input) =>
      run(async () => {
        const claim = parseRepositoryRevocationClaimV2(input);
        scoped(claim.input.scope);
        const record = await repository.findRecord(claim.input.target.recordRef);
        if (
          !record ||
          record.state !== "outstanding" ||
          !same(record.target, claim.input.target) ||
          record.inventoryVersion !== claim.input.expectedInventoryVersion ||
          (record.revocation?.version ?? 0) !== claim.input.expectedRevocationVersion ||
          record.tokenRef !== claim.input.tokenRef ||
          record.protectedRevocationRef !== claim.input.protectedRevocationRef
        )
          fail();
        const mint = await repository.findMintClaim(record.target.recordRef);
        if (
          !mint ||
          mint.custodyIdentity.tokenRef !== claim.input.tokenRef ||
          mint.custodyIdentity.protectedRevocationRef !== claim.input.protectedRevocationRef
        )
          fail();
        await changed(
          "INSERT INTO occ.credential_inventory_revocation_claims (installation_id,namespace_id,agent_id,claim_ref,claim_version,record_ref,document) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING claim_ref",
          [
            ...values,
            claim.claimRef,
            claim.claimVersion,
            record.target.recordRef,
            JSON.stringify(claim),
          ],
        );
        context.phase.recordEffect({ kind: "repository-revocation-claim-appended", claim });
      }, true),
  };
  return Object.freeze(repository);
}
