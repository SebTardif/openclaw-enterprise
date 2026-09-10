import {
  canonicalRepositoryInventoryV2,
  parseRepositoryAccessLeaseV2,
  parseRepositoryMintClaimV2,
  parseRepositoryRevocationClaimV2,
  parseRepositoryTokenRecordV2,
  repositoryRecordLiveV2,
  type RepositoryLeaseInventoryTransactionV2,
} from "../../credential-inventory-v1/repository-lease-v2.ts";
import type {
  RepositoryWorkScopeV2,
  RepositoryWorkInventoryTargetV2,
  RepositoryWorkInventoryCurrentV2,
} from "../../ports/repository-work-v2.ts";
import { ScopeViolationError } from "../../errors.ts";

const same = (left: unknown, right: unknown) =>
  canonicalRepositoryInventoryV2(left) === canonicalRepositoryInventoryV2(right);
function fail(): never {
  throw new ScopeViolationError("The exact original repository inventory tuple is unavailable.");
}
function target(value: RepositoryWorkInventoryTargetV2): RepositoryWorkInventoryTargetV2 {
  const fixed = JSON.parse(canonicalRepositoryInventoryV2(value));
  if (
    fixed === null ||
    typeof fixed !== "object" ||
    Array.isArray(fixed) ||
    Object.keys(fixed).sort().join(",") !== "intentDigest,issuanceOperationRef,recordRef" ||
    ![fixed.issuanceOperationRef, fixed.recordRef].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}(?![\s\S])/.test(v),
    ) ||
    typeof fixed.intentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}(?![\s\S])/.test(fixed.intentDigest)
  )
    fail();
  return Object.freeze({
    issuanceOperationRef: fixed.issuanceOperationRef,
    recordRef: fixed.recordRef,
    intentDigest: fixed.intentDigest,
  });
}

/** Internal exact read using the original State's already locked inventory unit.
 * No pool, new transaction, latest-record selector, observation issuer, Work
 * enrollment or use/cleanup claim is created here. The enclosing original State
 * operation qualifies this exact result with BOTH captured observation owners
 * before it can leave the unit. Reads also work for closed Work and terminal rows.
 */
export async function readRepositoryWorkInventoryCurrentV2(
  original: RepositoryLeaseInventoryTransactionV2,
  originalScope: RepositoryWorkScopeV2,
  input: RepositoryWorkInventoryTargetV2,
): Promise<RepositoryWorkInventoryCurrentV2> {
  const selected = target(input);
  const scope = Object.freeze({
    installationId: originalScope.installationId,
    namespaceId: originalScope.namespaceId,
    agentId: originalScope.agentId,
  });
  // Observe each original read method/receiver once. The supplied transaction
  // enforces its own actual scope/phase, query lifetime and ordered parent holds.
  const active = original.assertActive.bind(original);
  const findRecord = original.findRecord.bind(original);
  const findLease = original.findLease.bind(original);
  const findMint = original.findMintClaim.bind(original);
  const findRevocation = original.findRevocationClaim.bind(original);
  const listLive = original.listLeaseRecords.bind(original);
  active();
  const raw = await findRecord(selected.recordRef);
  active();
  if (raw === undefined) return Object.freeze({ kind: "absent", target: selected });
  const record = parseRepositoryTokenRecordV2(raw);
  if (!same(record.target, selected) || !same(record.issuance.scope, scope)) fail();
  const rawLease = await findLease(record.issuance.lease.accessLeaseRef);
  active();
  if (!rawLease) fail();
  const lease = parseRepositoryAccessLeaseV2(rawLease);
  if (!same(lease, record.issuance.lease)) fail();
  const rawMint = await findMint(selected.recordRef);
  active();
  const mintClaim = rawMint === undefined ? undefined : parseRepositoryMintClaimV2(rawMint);
  if (mintClaim) {
    if (
      record.state === "reserved" ||
      mintClaim.recordRef !== selected.recordRef ||
      mintClaim.issuanceOperationRef !== selected.issuanceOperationRef ||
      mintClaim.issuanceIntentDigest !== selected.intentDigest ||
      mintClaim.inventoryVersion > record.inventoryVersion ||
      !same(mintClaim.custodyIdentity.lease, lease) ||
      mintClaim.custodyIdentity.key.bindingRef !== record.issuance.bindingRef ||
      record.providerAttemptRef !== mintClaim.providerAttemptRef ||
      (record.state === "outstanding" &&
        (record.tokenRef !== mintClaim.custodyIdentity.tokenRef ||
          record.protectedRevocationRef !== mintClaim.custodyIdentity.protectedRevocationRef))
    )
      fail();
  } else if (record.state !== "reserved" && record.providerAttemptRef !== null) fail();
  const cleanup = record.revocation;
  const rawCleanup = cleanup === undefined ? undefined : await findRevocation(cleanup.claimRef);
  active();
  const revocationClaim =
    rawCleanup === undefined ? undefined : parseRepositoryRevocationClaimV2(rawCleanup);
  if (cleanup) {
    if (
      !revocationClaim ||
      !mintClaim ||
      !same(revocationClaim.input.target, selected) ||
      !same(revocationClaim.input.scope, scope) ||
      revocationClaim.input.expectedInventoryVersion >= record.inventoryVersion ||
      revocationClaim.input.revocationOperationRef !== cleanup.revocationOperationRef ||
      revocationClaim.input.tokenRef !== mintClaim.custodyIdentity.tokenRef ||
      revocationClaim.input.protectedRevocationRef !==
        mintClaim.custodyIdentity.protectedRevocationRef ||
      revocationClaim.claimRef !== cleanup.claimRef ||
      revocationClaim.claimVersion !== cleanup.claimVersion ||
      // Recorded outcomes advance the current version, retaining the exact claim version.
      revocationClaim.claimVersion > cleanup.version ||
      revocationClaim.providerAttemptRef !== cleanup.providerAttemptRef ||
      revocationClaim.claimedAt !== cleanup.claimedAt ||
      revocationClaim.claimNotAfter !== cleanup.claimNotAfter
    )
      fail();
  }
  const liveRecords = Object.freeze(
    (await listLive(lease.accessLeaseRef)).map(parseRepositoryTokenRecordV2),
  );
  active();
  if (
    liveRecords.length > 2 ||
    new Set(liveRecords.map((v) => v.target.recordRef)).size !== liveRecords.length ||
    liveRecords.some(
      (v) =>
        !same(v.issuance.scope, scope) ||
        !same(v.issuance.lease, lease) ||
        !repositoryRecordLiveV2(v),
    )
  )
    fail();
  const selectedLive = liveRecords.find((v) => v.target.recordRef === selected.recordRef);
  if (
    repositoryRecordLiveV2(record)
      ? !selectedLive || !same(selectedLive, record)
      : selectedLive !== undefined
  )
    fail();
  return Object.freeze({
    kind: "current",
    target: selected,
    record,
    lease,
    mintClaim,
    revocationClaim,
    liveRecords,
  });
}

export { same as sameRepositoryWorkInventoryV2, fail as repositoryWorkInventoryUnavailableV2 };
