import { createHash } from "node:crypto";
import {
  canonicalCredentialStorageRequestV1,
  credentialAffectedFilterDigestV1,
} from "../../../packages/contracts/src/index.ts";

// Synthetic public examples: references do not resolve credentials or authority.
export const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const digest = `sha256:${"a".repeat(64)}`;
export const now = "2026-01-01T00:00:00.000Z";
export const at = (ms) => new Date(Date.parse(now) + ms).toISOString();
export const scope = Object.freeze({
  installationId: `ins_${id(1)}`,
  namespaceId: `ns_${id(2)}`,
  agentId: `agt_${id(3)}`,
});
export const ref = (name) => ({ ref: `${name}/example`, version: 1, digest });
export const hash = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
export const intentDigest = (kind, value) => hash(canonicalCredentialStorageRequestV1(kind, value));

export function profile(kind = "repository", mode = "native", credentialClass = "api-key") {
  const common = {
    schemaVersion: 1,
    scope: { ...scope },
    profile: ref("profile"),
    providerId: "provider/example",
    account: ref("account"),
    transport: ref("transport"),
  };
  return kind === "model"
    ? { ...common, kind, mode: "mediated", modelProfile: ref("model"), credentialClass }
    : {
        ...common,
        kind,
        mode,
        providerInstallationRef: "provider-installation/example",
        permissionProfile: ref("permissions"),
        credentialClass: "installation-token",
      };
}

export function originalBinding() {
  return {
    schemaVersion: 1,
    scope: { ...scope },
    assignmentRef: { schemaVersion: 1, id: id(4) },
    revisionId: `rev_${id(5)}`,
    lifecycleGeneration: 1,
    runtimeGeneration: 1,
    turnRef: "turn/example",
    attemptRef: "attempt/example",
    reservationRef: "reservation/example",
    intentDigest: digest,
    conversationRef: "conversation/example",
    workspaceRef: "workspace/example",
    originalPrincipalRef: "principal/example",
    externalIdentity: ref("identity"),
    receiptRef: "receipt/example",
    logicalMessageRef: "message/example",
    messageContentDigest: digest,
    commonGrant: ref("grant"),
    route: ref("route"),
    audience: ref("audience"),
    policy: ref("policy"),
    canonicalBindingDigest: digest,
    committedDispatchAt: now,
    turnNotAfter: at(900_000),
  };
}

export function secretBinding() {
  return {
    schemaVersion: 1,
    scope: { ...scope },
    bindingRef: "binding/example",
    bindingVersion: 1,
    secretId: `sec_${id(6)}`,
    secretVersion: 1,
    providerId: "provider/example",
    account: ref("account"),
    driverId: "driver/example",
    backendBindingRef: "backend/example",
  };
}

export function modelBinding(credentialClass = "api-key") {
  return {
    schemaVersion: 1,
    scope: { ...scope },
    profile: profile("model", "mediated", credentialClass),
    binding: secretBinding(),
    accountLink: ref("account-link"),
    upstreamWorkspaceRef: "upstream-workspace/example",
    invocationProfile: ref("invocation"),
    custody: "external-protected-owner",
    setup:
      credentialClass === "api-key"
        ? {
            kind: "api-key-import",
            invocationMaterial: "api-key",
            rotationOwnerRef: "owner/rotation",
            lifecycleProfile: ref("credential-lifecycle"),
          }
        : {
            kind: credentialClass,
            invocationMaterial: "access-token-and-account-context",
            refreshOwnerRef: "owner/refresh",
            lifecycleProfile: ref("credential-lifecycle"),
          },
  };
}

export function repositoryGrant() {
  return {
    providerInstallationRef: "provider-installation/example",
    repositoryIds: ["101", "202"],
    permissions: [
      { name: "contents", access: "read" },
      { name: "metadata", access: "read" },
    ],
    permissionProfile: ref("permissions"),
  };
}

export function cachePartition(kind = "repository", credentialClass = "api-key") {
  return {
    schemaVersion: 1,
    purpose: kind === "model" ? "model-use" : "repository-mint",
    scope: { ...scope },
    profile: profile(kind, "native", credentialClass),
    binding: secretBinding(),
    ...(kind === "repository"
      ? { grant: repositoryGrant() }
      : { modelBinding: modelBinding(credentialClass) }),
  };
}

export function backendRequirements() {
  return {
    schemaVersion: 1,
    externalCustody: true,
    authenticatedExactNamedAccess: true,
    versionedReadAndRotation: true,
    protectedEncryptionAndKeyCustody: true,
    durableCompareAndSet: true,
    durableIntentBeforeMint: true,
    inventoryAndDeliveryIntentBeforeRelease: true,
    restartCompleteAffectedSnapshots: true,
    exactUnknownOperationReadback: true,
    auditCoupling: "durable-outbox",
    independentPreauthorizedMitigation: true,
  };
}

export function base(operationRef = "operation/example", selectedProfile = profile()) {
  return {
    schemaVersion: 1,
    operationRef,
    requestId: `req_${id(7)}`,
    callerServiceRef: "service/broker",
    scope: { ...scope },
    profile: selectedProfile,
    originalAuditRef: `aud_${id(8)}`,
    createdAt: now,
    deadline: at(5_000),
  };
}

export function reserve() {
  return {
    ...base("operation/reserve"),
    method: "reserveIssuance",
    original: originalBinding(),
    binding: secretBinding(),
    grant: repositoryGrant(),
    authorityVersion: 1,
    invalidationVersion: 1,
  };
}

export function locator(issuance = reserve()) {
  return {
    issuanceOperationRef: issuance.operationRef,
    recordRef: "record/example",
    intentDigest: intentDigest("reserve", issuance),
  };
}

export function namedUse(kind = "repository", credentialClass = "api-key") {
  const common = {
    ...base("operation/use", profile(kind, "native", credentialClass)),
    method: "withNamedCredential",
    original: originalBinding(),
    binding: secretBinding(),
  };
  return kind === "model"
    ? { ...common, purpose: "model-use", modelBinding: modelBinding(credentialClass) }
    : {
        ...common,
        purpose: "repository-mint",
        issuance: locator(),
        providerAttemptRef: "provider-attempt/mint",
        expectedInventoryVersion: 1,
        grant: repositoryGrant(),
      };
}

export function authorityObservation(effect = "mint-token") {
  return {
    schemaVersion: 1,
    original: originalBinding(),
    profile: profile(effect === "model-use" ? "model" : "repository"),
    secretId: secretBinding().secretId,
    secretVersion: 1,
    leaseRef: "lease/example",
    leaseVersion: 1,
    leaseNotAfter: at(60_000),
    accountVersions: {
      installation: 1,
      account: 1,
      credential: 1,
      grants: 1,
      iamPolicy: 1,
      semanticMapping: 1,
      driverSelection: 1,
    },
    decisionRef: "decision/example",
    authorityVersion: 1,
    invalidationVersion: 1,
    dispatchFenceRef: "fence/example",
    comparedAt: now,
    startNotAfter: at(5_000),
    requestId: `req_${id(7)}`,
    effect,
  };
}

export function rotate() {
  return {
    ...base("operation/rotate"),
    method: "rotateBinding",
    expectedBinding: secretBinding(),
    replacement: { ...secretBinding(), bindingVersion: 2, secretVersion: 2 },
    expectedInvalidationVersion: 1,
    invalidationOperationRef: "invalidation/rotation",
  };
}

export function expiry() {
  return {
    kind: "provider-expiry",
    expiresAt: at(3_600_000),
    observedAt: now,
    evidenceRef: "evidence/expiry",
  };
}

export function mintOutcome(outcome = "accepted") {
  const common = {
    ...base("operation/mint-outcome"),
    target: locator(),
    expectedInventoryVersion: 1,
    method: "recordMintOutcome",
    observedAt: now,
    providerAttemptRef: "provider-attempt/mint",
  };
  if (outcome === "definitely-rejected")
    return { ...common, outcome, noIssuanceEvidenceRef: "evidence/no-issuance" };
  if (outcome === "unknown")
    return {
      ...common,
      outcome,
      expiry: { kind: "expiry-unproven" },
      uncertaintyEvidenceRef: "evidence/mint-unknown",
    };
  if (outcome === "unknown-expiry-established") return { ...common, outcome, expiry: expiry() };
  if (outcome === "unknown-expired")
    return {
      ...common,
      outcome,
      createdAt: at(3_602_000),
      deadline: at(3_607_000),
      observedAt: at(3_602_000),
      expiry: expiry(),
      clockEvidenceRef: "evidence/clock",
      uncertaintyMs: 2_000,
    };
  if (outcome === "unknown-broader-revocation-confirmed")
    return { ...common, outcome, broaderRevocation: broaderRevocation() };
  return {
    ...common,
    outcome,
    tokenRef: "token/example",
    protectedRevocationRef: "revocation-material/example",
    expiry: expiry(),
    returnedScope: { status: "matches-request", evidenceRef: "evidence/scope" },
    providerEvidenceRef: "evidence/mint",
  };
}

export function broaderRevocation() {
  return {
    operationRef: "operation/broader-revoke",
    responsibilityRef: "responsibility/broader-revoke",
    scopeEvidenceRef: "evidence/broader-revoke-scope",
    confirmationEvidenceRef: "evidence/broader-revoke-confirmed",
  };
}

export function deliver() {
  return {
    ...base("operation/deliver"),
    method: "deliverRecordedToken",
    target: locator(),
    expectedInventoryVersion: 2,
    tokenRef: "token/example",
    original: originalBinding(),
    binding: secretBinding(),
    grant: repositoryGrant(),
    deliveryRef: "delivery/example",
  };
}

export function audit() {
  return {
    state: "accepted",
    eventRef: `aud_${id(8)}`,
    commitRef: "commit/audit",
    source: "credential",
    category: "credential",
  };
}

export function tokenRecord(state = "outstanding", issuance = reserve()) {
  const common = {
    schemaVersion: 1,
    target: locator(issuance),
    inventoryVersion: state === "reserved" ? 1 : 2,
    issuance,
    invalidationVersion: 1,
    audit: audit(),
    updatedAt: now,
  };
  if (state === "reserved")
    return { ...common, state, expiry: { kind: "expiry-unproven" }, disposition: "scope-held" };
  if (state === "mint-unknown")
    return {
      ...common,
      state,
      expiry: { kind: "expiry-unproven" },
      providerAttemptRef: "provider-attempt/mint",
      disposition: "scope-held",
    };
  if (state === "not-issued")
    return {
      ...common,
      state,
      noIssuanceEvidenceRef: "evidence/no-issuance",
      disposition: "no-effect",
    };
  if (state === "resolved-without-token")
    return {
      ...common,
      state,
      updatedAt: at(3_602_000),
      disposition: "resolved-no-live-token",
      resolution: {
        kind: "expired",
        observedAt: at(3_602_000),
        expiry: expiry(),
        clockEvidenceRef: "evidence/clock",
        uncertaintyMs: 2_000,
      },
    };
  return {
    ...common,
    state,
    tokenRef: "token/example",
    protectedRevocationRef: "revocation-material/example",
    expiry: expiry(),
    returnedScope: { status: "matches-request", evidenceRef: "evidence/scope" },
    delivery: { state: "not-delivered" },
    revocation: { state: "unrequested", version: 1 },
    disposition: "current-check-required",
  };
}

export function receipt(request = reserve(), inventoryVersion = 1) {
  const kind = {
    reserveIssuance: "reserve",
    recordMintOutcome: "mintOutcome",
    rotateBinding: "rotate",
    claimRevocation: "claimRevocation",
    deliverRecordedToken: "deliver",
  }[request.method];
  return {
    schemaVersion: 1,
    operationRef: request.operationRef,
    intentDigest: intentDigest(kind, request),
    commitRef: "commit/example",
    inventoryVersion,
    committedAt: now,
  };
}

export function reservationResult() {
  return { kind: "reserved", receipt: receipt(), record: tokenRecord("reserved"), audit: audit() };
}

export function writeResult(record = tokenRecord()) {
  return { kind: "recorded", receipt: receipt(mintOutcome(), record.inventoryVersion), record };
}

export function rotationResult() {
  return {
    kind: "rotated",
    receipt: receipt(rotate(), 2),
    binding: rotate().replacement,
    invalidationVersion: 2,
    affectedScanRef: "scan/example",
    audit: audit(),
  };
}

export function affectedQuery() {
  return {
    ...base("operation/affected"),
    method: "listAffected",
    filter: {
      scope: { ...scope },
      bindingRef: "binding/example",
      cause: "rotation",
      invalidationOperationRef: "invalidation/rotation",
      invalidationVersion: 2,
    },
    limit: 20,
  };
}

export function affectedPage(records = [tokenRecord()], query = affectedQuery()) {
  return {
    kind: "page",
    snapshotRef: "snapshot/example",
    snapshotVersion: 1,
    filter: query.filter,
    filterDigest: credentialAffectedFilterDigestV1(query),
    createdAt: now,
    expiresAt: at(60_000),
    records,
    next: null,
    outstandingCount: records.filter((row) => row.state === "outstanding").length,
    unresolvedIssuanceCount: records.filter((row) =>
      ["reserved", "mint-unknown"].includes(row.state),
    ).length,
    coverage: "persisted-snapshot-only",
  };
}

export function cursor() {
  const page = affectedPage();
  return {
    snapshotRef: page.snapshotRef,
    snapshotVersion: page.snapshotVersion,
    filterDigest: page.filterDigest,
    afterRecordRef: "record/example",
    continuation: "continuation_example",
  };
}

export function claimRevocation() {
  return {
    ...base("operation/claim"),
    method: "claimRevocation",
    target: locator(),
    expectedInventoryVersion: 2,
    tokenRef: "token/example",
    revocationOperationRef: "operation/revoke",
    expectedRevocationVersion: 1,
    responsibilityRef: "responsibility/revoke",
    previousAttempt: { kind: "none" },
  };
}

export function claimResult(priorOutcome = "none") {
  const record = tokenRecord();
  record.inventoryVersion = 3;
  record.disposition = "mitigation-only";
  record.revocation = {
    state: "claimed",
    version: 2,
    revocationOperationRef: "operation/revoke",
    attemptRef: "provider-attempt/revoke",
    claimRef: "claim/example",
    claimedAt: now,
    claimNotAfter: at(5_000),
    priorOutcome,
  };
  return {
    kind: "claimed",
    receipt: receipt(claimRevocation(), 3),
    record,
    claimRef: "claim/example",
    claimVersion: 2,
    claimNotAfter: at(5_000),
    audit: audit(),
    nextAction: priorOutcome === "none" ? "attempt-exact-revocation" : "reconcile-previous-attempt",
  };
}

export function revocationOutcome(outcome = "unknown") {
  const common = {
    ...base("operation/revoke-outcome"),
    method: "recordRevocation",
    target: locator(),
    expectedInventoryVersion: 3,
    tokenRef: "token/example",
    revocationOperationRef: "operation/revoke",
    claimRef: "claim/example",
    claimVersion: 2,
    providerAttemptRef: "provider-attempt/revoke",
    observedAt: outcome === "expired" ? at(3_602_000) : now,
  };
  if (outcome === "confirmed")
    return { ...common, outcome, confirmationEvidenceRef: "evidence/revoke-confirmed" };
  if (outcome === "expired")
    return {
      ...common,
      outcome,
      createdAt: at(3_602_000),
      deadline: at(3_607_000),
      expiry: expiry(),
      clockEvidenceRef: "evidence/clock",
      uncertaintyMs: 2_000,
    };
  return { ...common, outcome, outcomeEvidenceRef: "evidence/revoke-outcome" };
}

export function readOperation(request = reserve(), kind = "reserve") {
  return {
    ...base("operation/read"),
    method: "readOperation",
    originalOperationRef: request.operationRef,
    originalMethod: request.method,
    originalIntentDigest: intentDigest(kind, request),
  };
}

export function operationResult(record = tokenRecord("reserved")) {
  return {
    kind: "found",
    operationRef: "operation/reserve",
    intentDigest: locator().intentDigest,
    originalMethod: "reserveIssuance",
    state: "intent-recorded",
    record,
    nextAction: "observation-only",
  };
}

export function useResult() {
  return { kind: "used", operationRef: "operation/use", audit: audit() };
}

export function deliveryResult() {
  return {
    kind: "delivered",
    receipt: receipt(deliver(), 3),
    deliveryRef: "delivery/example",
    audit: audit(),
  };
}

export const samples = {
  profile,
  originalBinding,
  authorityObservation,
  secretBinding,
  modelBinding,
  repositoryGrant,
  cachePartition,
  backendRequirements,
  namedUse,
  rotate,
  reserve,
  mintOutcome,
  deliver,
  affectedQuery,
  claimRevocation,
  revocationOutcome,
  readOperation,
  record: tokenRecord,
  reservationResult,
  writeResult,
  rotationResult,
  affectedPage,
  claimResult,
  operationResult,
  useResult,
  deliveryResult,
};
