import type {
  ReserveIssuanceV1,
  NamedCredentialUseV1,
  OutstandingTokenRecordV1,
  MintOutcomeV1,
  ClaimRevocationV1,
  RevocationOutcomeV1,
  AffectedTokenQueryV1,
  ExactCredentialOperationV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import { inventoryIntentDigestV1 } from "../../../packages/occ/src/credential-inventory-v1/transactions.ts";
const id = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const hash = "sha256:" + "a".repeat(64);
const versioned = (ref: string) => ({ ref, version: 1, digest: hash });
export const start = Date.parse("2026-01-01T00:00:00.000Z");
export function reserve(operationRef = "reserve/example", now = start): ReserveIssuanceV1 {
  const scope = {
    installationId: "ins_" + id(1),
    namespaceId: "ns_" + id(2),
    agentId: "agt_" + id(3),
  };
  const profile = {
    schemaVersion: 1 as const,
    scope,
    profile: versioned("profile/example"),
    providerId: "provider/example",
    account: versioned("account/example"),
    transport: versioned("transport/example"),
    kind: "repository" as const,
    mode: "native" as const,
    providerInstallationRef: "installation/example",
    permissionProfile: versioned("permission/example"),
    credentialClass: "installation-token" as const,
  };
  return {
    schemaVersion: 1,
    method: "reserveIssuance",
    operationRef,
    requestId: "req_" + id(7),
    callerServiceRef: "service/example",
    scope,
    profile,
    originalAuditRef: "aud_" + id(8),
    createdAt: new Date(now).toISOString(),
    deadline: new Date(now + 5000).toISOString(),
    original: {
      schemaVersion: 1,
      scope,
      assignmentRef: { schemaVersion: 1, id: id(4) },
      revisionId: "rev_" + id(5),
      lifecycleGeneration: 1,
      runtimeGeneration: 1,
      turnRef: "turn/example",
      attemptRef: "attempt/example",
      reservationRef: "reservation/example",
      intentDigest: hash,
      conversationRef: "conversation/example",
      workspaceRef: "workspace/example",
      originalPrincipalRef: "principal/example",
      externalIdentity: versioned("identity/example"),
      receiptRef: "receipt/example",
      logicalMessageRef: "message/example",
      messageContentDigest: hash,
      commonGrant: versioned("grant/example"),
      route: versioned("route/example"),
      audience: versioned("audience/example"),
      policy: versioned("policy/example"),
      canonicalBindingDigest: hash,
      committedDispatchAt: new Date(start).toISOString(),
      turnNotAfter: new Date(start + 900000).toISOString(),
    },
    binding: {
      schemaVersion: 1,
      scope,
      bindingRef: "binding/example",
      bindingVersion: 1,
      secretId: "sec_" + id(6),
      secretVersion: 1,
      providerId: profile.providerId,
      account: profile.account,
      driverId: "driver/example",
      backendBindingRef: "backend/example",
    },
    grant: {
      providerInstallationRef: profile.providerInstallationRef,
      repositoryIds: ["101"],
      permissions: [
        { name: "contents", access: "read" },
        { name: "metadata", access: "read" },
      ],
      permissionProfile: profile.permissionProfile,
    },
    authorityVersion: 1,
    invalidationVersion: 1,
  };
}
export function base(row: OutstandingTokenRecordV1, operationRef: string, now = start) {
  const r = reserve(operationRef, now);
  return {
    schemaVersion: 1 as const,
    operationRef,
    requestId: r.requestId,
    callerServiceRef: r.callerServiceRef,
    scope: row.issuance.scope,
    profile: row.issuance.profile,
    originalAuditRef: r.originalAuditRef,
    createdAt: r.createdAt,
    deadline: r.deadline,
  };
}
export function mintClaim(
  row: OutstandingTokenRecordV1,
  operationRef = "mint-use/example",
  now = start,
): Extract<NamedCredentialUseV1, { purpose: "repository-mint" }> {
  return {
    ...base(row, operationRef, now),
    method: "withNamedCredential",
    purpose: "repository-mint",
    original: row.issuance.original,
    binding: row.issuance.binding,
    grant: row.issuance.grant,
    issuance: row.target,
    providerAttemptRef: operationRef + "/attempt",
    expectedInventoryVersion: row.inventoryVersion,
  };
}
export function accepted(
  row: OutstandingTokenRecordV1,
  providerAttemptRef: string,
  operationRef = "mint-outcome/example",
  now = start,
): Extract<MintOutcomeV1, { outcome: "accepted" }> {
  return {
    ...base(row, operationRef, now),
    method: "recordMintOutcome",
    target: row.target,
    expectedInventoryVersion: row.inventoryVersion,
    observedAt: new Date(now).toISOString(),
    providerAttemptRef,
    outcome: "accepted",
    tokenRef: operationRef + "/token",
    protectedRevocationRef: operationRef + "/revoke",
    expiry: {
      kind: "provider-expiry",
      expiresAt: new Date(start + 3600000).toISOString(),
      observedAt: new Date(now).toISOString(),
      evidenceRef: "expiry/example",
    },
    returnedScope: { status: "matches-request", evidenceRef: "scope/example" },
    providerEvidenceRef: "provider/example",
  };
}
export function claimRevoke(
  row: Extract<OutstandingTokenRecordV1, { state: "outstanding" }>,
  operationRef = "claim/example",
  now = start,
): ClaimRevocationV1 {
  return {
    ...base(row, operationRef, now),
    method: "claimRevocation",
    target: row.target,
    expectedInventoryVersion: row.inventoryVersion,
    tokenRef: row.tokenRef,
    revocationOperationRef: "revoke/example",
    expectedRevocationVersion: row.revocation.version,
    responsibilityRef: "responsibility/example",
    previousAttempt: { kind: "none" },
  };
}
export function confirmed(
  row: Extract<OutstandingTokenRecordV1, { state: "outstanding" }>,
  operationRef = "outcome/example",
  now = start,
): Extract<RevocationOutcomeV1, { outcome: "confirmed" }> {
  if (row.revocation.state !== "claimed") throw new Error("Synthetic claim required.");
  return {
    ...base(row, operationRef, now),
    method: "recordRevocation",
    target: row.target,
    expectedInventoryVersion: row.inventoryVersion,
    tokenRef: row.tokenRef,
    revocationOperationRef: row.revocation.revocationOperationRef,
    claimRef: row.revocation.claimRef,
    claimVersion: row.revocation.version,
    providerAttemptRef: row.revocation.attemptRef,
    observedAt: new Date(now).toISOString(),
    outcome: "confirmed",
    confirmationEvidenceRef: "confirmation/example",
  };
}
export function query(
  row: OutstandingTokenRecordV1,
  operationRef = "scan/example",
  now = start,
): AffectedTokenQueryV1 {
  return {
    ...base(row, operationRef, now),
    method: "listAffected",
    filter: {
      scope: row.issuance.scope,
      bindingRef: row.issuance.binding.bindingRef,
      cause: "recovery",
      invalidationOperationRef: "invalidation/example",
      invalidationVersion: 1,
    },
    limit: 1,
  };
}
export function read(
  input: Parameters<typeof inventoryIntentDigestV1>[0],
  now = start,
): ExactCredentialOperationV1 {
  const r = reserve("read/example", now);
  return {
    schemaVersion: 1,
    method: "readOperation",
    operationRef: r.operationRef,
    requestId: r.requestId,
    callerServiceRef: input.callerServiceRef,
    scope: input.scope,
    profile: input.profile,
    originalAuditRef: input.originalAuditRef,
    createdAt: r.createdAt,
    deadline: r.deadline,
    originalOperationRef: input.operationRef,
    originalMethod: input.method,
    originalIntentDigest: inventoryIntentDigestV1(input),
  };
}
