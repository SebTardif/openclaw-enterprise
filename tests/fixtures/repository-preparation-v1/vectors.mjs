import { createHash } from "node:crypto";
import {
  canonicalRepositoryPreparationRequestV1,
  preparationAffectedFilterDigestV1,
  preparationCheckoutRequestDigestV1,
} from "@openclaw-enterprise/contracts/repository-preparation-codec-v1";

// Synthetic references only. No value resolves a protected record or grants authority.
export const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const digest = `sha256:${"a".repeat(64)}`;
export const now = "2026-01-01T00:00:00.000Z";
export const at = (ms) => new Date(Date.parse(now) + ms).toISOString();
export const scope = Object.freeze({
  installationId: `ins_${id(1)}`,
  namespaceId: `ns_${id(2)}`,
  agentId: `agt_${id(3)}`,
});
export const versionedRef = (name) => ({ ref: `${name}/example`, version: 1, digest });

export function credentialProfile() {
  return {
    schemaVersion: 1,
    scope: { ...scope },
    profile: versionedRef("profile"),
    providerId: "provider/example",
    account: versionedRef("account"),
    transport: versionedRef("transport"),
    kind: "repository",
    mode: "native",
    providerInstallationRef: "provider-installation/example",
    permissionProfile: versionedRef("permissions"),
    credentialClass: "installation-token",
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
    account: versionedRef("account"),
    driverId: "driver/example",
    backendBindingRef: "backend/example",
  };
}

export function legacyOriginalBinding() {
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
    externalIdentity: versionedRef("identity"),
    receiptRef: "receipt/example",
    logicalMessageRef: "message/example",
    messageContentDigest: digest,
    commonGrant: versionedRef("grant"),
    route: versionedRef("route"),
    audience: versionedRef("audience"),
    policy: versionedRef("policy"),
    canonicalBindingDigest: digest,
    committedDispatchAt: now,
    turnNotAfter: at(900_000),
  };
}

export function legacyRepositoryGrant() {
  return {
    providerInstallationRef: "provider-installation/example",
    repositoryIds: ["101", "202"],
    permissions: [
      { name: "contents", access: "read" },
      { name: "metadata", access: "read" },
    ],
    permissionProfile: versionedRef("permissions"),
  };
}

export function legacyReserve() {
  return {
    schemaVersion: 1,
    operationRef: "operation/reserve",
    requestId: `req_${id(7)}`,
    callerServiceRef: "service/broker",
    scope: { ...scope },
    profile: credentialProfile(),
    originalAuditRef: `aud_${id(8)}`,
    createdAt: now,
    deadline: at(5_000),
    method: "reserveIssuance",
    original: legacyOriginalBinding(),
    binding: secretBinding(),
    grant: legacyRepositoryGrant(),
    authorityVersion: 1,
    invalidationVersion: 1,
  };
}

// Fixed compatibility expectation derived from the unchanged original-turn
// semantic request (3924 UTF-8 bytes); it must not be recomputed by the new codec.
export const LEGACY_RESERVE_DIGEST =
  "sha256:bafe4757173ce2baf501b453f6ecf1d6eda987c58589030b95cace6743d10f2b";

export function legacyReadOperation() {
  return {
    schemaVersion: 1,
    operationRef: "operation/read",
    requestId: `req_${id(7)}`,
    callerServiceRef: "service/broker",
    scope: { ...scope },
    profile: credentialProfile(),
    originalAuditRef: `aud_${id(8)}`,
    createdAt: now,
    deadline: at(5_000),
    method: "readOperation",
    originalOperationRef: "operation/reserve",
    originalMethod: "reserveIssuance",
    originalIntentDigest: LEGACY_RESERVE_DIGEST,
  };
}

export function legacyReservedRecord() {
  return {
    schemaVersion: 1,
    target: {
      issuanceOperationRef: "operation/reserve",
      recordRef: "record/example",
      intentDigest: LEGACY_RESERVE_DIGEST,
    },
    inventoryVersion: 1,
    issuance: legacyReserve(),
    invalidationVersion: 1,
    audit: {
      state: "accepted",
      eventRef: `aud_${id(8)}`,
      commitRef: "commit/audit",
      source: "credential",
      category: "credential",
    },
    updatedAt: now,
    state: "reserved",
    expiry: { kind: "expiry-unproven" },
    disposition: "scope-held",
  };
}

export function legacyReadback() {
  return {
    kind: "found",
    operationRef: "operation/reserve",
    intentDigest: LEGACY_RESERVE_DIGEST,
    originalMethod: "reserveIssuance",
    state: "intent-recorded",
    record: legacyReservedRecord(),
    nextAction: "observation-only",
  };
}

export const purpose = "candidate-repository-preparation";
export const hash = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
export const intentDigest = (kind, value) =>
  hash(canonicalRepositoryPreparationRequestV1(kind, value));

export function gate() {
  return {
    schemaVersion: 1,
    scope: { ...scope },
    intentRef: id(10),
    mode: "running",
    lifecycleGeneration: 1,
    requestedFenceEpoch: 1,
    responsibility: { responsibilityRef: id(11), responsibilityVersion: 1, kind: "preparation" },
    gateVersion: 1,
    planRef: "plan/example",
    planVersion: 1,
    planDigest: digest,
    admittedChildCutoff: 0,
  };
}

export function staging() {
  return {
    schemaVersion: 1,
    scope: { ...scope },
    logicalStoreRef: "store/candidate",
    bindingRef: "store-binding/candidate",
    bindingVersion: 1,
  };
}

export function commit() {
  return { algorithm: "sha1", oid: "a".repeat(40) };
}

export function subject() {
  return {
    schemaVersion: 1,
    purpose,
    scope: { ...scope },
    preparationRef: id(9),
    incarnationRef: "incarnation/candidate-1",
    revisionId: `rev_${id(5)}`,
    revisionDigest: digest,
    gate: gate(),
    authorizationGeneration: 1,
    admission: {
      operationRef: "operation/admit",
      requestDigest: digest,
      actorRef: "actor/operator",
      requestId: `req_${id(7)}`,
    },
    grant: versionedRef("preparation-grant"),
    profile: credentialProfile(),
    repositoryId: "101",
    commit: commit(),
    originProfile: versionedRef("origin"),
    staging: staging(),
    createdAt: now,
    notAfter: at(900_000),
  };
}

export function authority() {
  return {
    schemaVersion: 1,
    preparation: subject(),
    binding: secretBinding(),
    accountVersions: {
      installation: 1,
      account: 1,
      credential: 1,
      grants: 1,
      iamPolicy: 1,
      semanticMapping: 1,
      driverSelection: 1,
    },
    leaseRef: "lease/preparation",
    leaseVersion: 1,
    leaseNotAfter: at(5_000),
    authorityVersion: 1,
    invalidationVersion: 1,
    decisionRef: "decision/preparation",
    comparedAt: now,
    startNotAfter: at(1_000),
    requestId: `req_${id(7)}`,
    effect: "mint-token",
  };
}

export function grant() {
  return { ...legacyRepositoryGrant(), repositoryIds: ["101"] };
}

export function base(operationRef) {
  return {
    schemaVersion: 1,
    operationRef,
    requestId: `req_${id(7)}`,
    callerServiceRef: "service/broker",
    scope: { ...scope },
    profile: credentialProfile(),
    originalAuditRef: `aud_${id(8)}`,
    createdAt: now,
    deadline: at(5_000),
    credentialPurpose: purpose,
    preparation: subject(),
  };
}

export function reserve() {
  return {
    ...base("operation/prepare-reserve"),
    method: "reserveIssuance",
    binding: secretBinding(),
    grant: grant(),
    authorityVersion: 1,
    invalidationVersion: 1,
  };
}

export function locator(issuance = reserve()) {
  return {
    issuanceOperationRef: issuance.operationRef,
    recordRef: "record/candidate",
    intentDigest: intentDigest("reserve", issuance),
  };
}

export function namedUse() {
  return {
    ...base("operation/prepare-use"),
    method: "withNamedCredential",
    purpose: "repository-mint",
    binding: secretBinding(),
    issuance: locator(),
    providerAttemptRef: "provider-attempt/candidate",
    expectedInventoryVersion: 1,
    grant: grant(),
  };
}

export function expiry() {
  return {
    kind: "provider-expiry",
    expiresAt: at(3_600_000),
    observedAt: now,
    evidenceRef: "evidence/provider-expiry",
  };
}

export function mintOutcome(outcome = "accepted") {
  const common = {
    ...base("operation/prepare-mint-outcome"),
    method: "recordMintOutcome",
    target: locator(),
    expectedInventoryVersion: 1,
    observedAt: now,
    providerAttemptRef: "provider-attempt/candidate",
  };
  if (outcome === "unknown")
    return {
      ...common,
      outcome,
      expiry: { kind: "expiry-unproven" },
      uncertaintyEvidenceRef: "evidence/provider-unknown",
    };
  if (outcome === "definitely-rejected")
    return { ...common, outcome, noIssuanceEvidenceRef: "evidence/no-issuance" };
  if (outcome === "unknown-expiry-established") return { ...common, outcome, expiry: expiry() };
  if (outcome === "unknown-expired")
    return {
      ...common,
      outcome,
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
    tokenRef: "token/candidate",
    protectedRevocationRef: "revoke-material/candidate",
    expiry: expiry(),
    returnedScope: { status: "matches-request", evidenceRef: "evidence/returned-scope" },
    providerEvidenceRef: "evidence/provider-accepted",
  };
}

export function broaderRevocation() {
  return {
    operationRef: "operation/broader-revoke",
    responsibilityRef: "responsibility/broader-revoke",
    scopeEvidenceRef: "evidence/broader-scope",
    confirmationEvidenceRef: "evidence/broader-confirmed",
  };
}

export function delivery() {
  return {
    ...base("operation/prepare-deliver"),
    method: "deliverRecordedToken",
    target: locator(),
    expectedInventoryVersion: 2,
    tokenRef: "token/candidate",
    binding: secretBinding(),
    grant: grant(),
    deliveryRef: "delivery/candidate",
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
    credentialPurpose: purpose,
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
      providerAttemptRef: "provider-attempt/candidate",
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
    tokenRef: "token/candidate",
    protectedRevocationRef: "revoke-material/candidate",
    expiry: expiry(),
    returnedScope: { status: "matches-request", evidenceRef: "evidence/returned-scope" },
    delivery: { state: "not-delivered" },
    revocation: { state: "unrequested", version: 1 },
    disposition: "current-check-required",
  };
}

export function receipt(kind = "reserve", request = reserve(), inventoryVersion = 1) {
  return {
    schemaVersion: 1,
    operationRef: request.operationRef,
    intentDigest: intentDigest(kind, request),
    commitRef: "commit/candidate",
    inventoryVersion,
    committedAt: now,
  };
}

export function reservationResult() {
  return { kind: "reserved", receipt: receipt(), record: tokenRecord("reserved"), audit: audit() };
}

export function writeResult(record = tokenRecord()) {
  return {
    kind: "recorded",
    receipt: receipt("mintOutcome", mintOutcome(), record.inventoryVersion),
    record,
  };
}

export function claim() {
  return {
    ...base("operation/prepare-claim"),
    method: "claimRevocation",
    target: locator(),
    expectedInventoryVersion: 2,
    tokenRef: "token/candidate",
    revocationOperationRef: "operation/prepare-revoke",
    expectedRevocationVersion: 1,
    responsibilityRef: "responsibility/candidate-revoke",
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
    revocationOperationRef: "operation/prepare-revoke",
    attemptRef: "provider-attempt/revoke",
    claimRef: "claim/candidate",
    claimedAt: now,
    claimNotAfter: at(5_000),
    priorOutcome,
  };
  return {
    kind: "claimed",
    receipt: receipt("claim", claim(), 3),
    record,
    claimRef: "claim/candidate",
    claimVersion: 2,
    claimNotAfter: at(5_000),
    audit: audit(),
    nextAction: priorOutcome === "none" ? "attempt-exact-revocation" : "reconcile-previous-attempt",
  };
}

export function revokeOutcome(outcome = "unknown") {
  const common = {
    ...base("operation/prepare-revoke-outcome"),
    method: "recordRevocation",
    target: locator(),
    expectedInventoryVersion: 3,
    tokenRef: "token/candidate",
    revocationOperationRef: "operation/prepare-revoke",
    claimRef: "claim/candidate",
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
      expiry: expiry(),
      clockEvidenceRef: "evidence/clock",
      uncertaintyMs: 2_000,
    };
  return { ...common, outcome, outcomeEvidenceRef: "evidence/revoke-outcome" };
}

export function affected() {
  return {
    ...base("operation/prepare-affected"),
    method: "listAffected",
    filter: {
      scope: { ...scope },
      bindingRef: "binding/example",
      cause: "recovery",
      invalidationOperationRef: "invalidation/candidate",
      invalidationVersion: 1,
      preparation: subject(),
    },
    limit: 20,
  };
}

export function page(records = [tokenRecord()]) {
  const input = affected();
  return {
    kind: "page",
    snapshotRef: "snapshot/candidate",
    snapshotVersion: 1,
    filter: input.filter,
    filterDigest: preparationAffectedFilterDigestV1(input),
    createdAt: now,
    expiresAt: at(60_000),
    records,
    next: null,
    outstandingCount: records.filter((value) => value.state === "outstanding").length,
    unresolvedIssuanceCount: records.filter((value) =>
      ["reserved", "mint-unknown"].includes(value.state),
    ).length,
    coverage: "persisted-snapshot-only",
  };
}

export function cursor() {
  const value = page();
  return {
    snapshotRef: value.snapshotRef,
    snapshotVersion: value.snapshotVersion,
    filterDigest: value.filterDigest,
    afterRecordRef: "record/candidate",
    continuation: "continuation_candidate",
  };
}

export function readOperation() {
  return {
    ...base("operation/prepare-read"),
    method: "readOperation",
    originalOperationRef: reserve().operationRef,
    originalMethod: "reserveIssuance",
    originalIntentDigest: intentDigest("reserve", reserve()),
  };
}

export function operationResult() {
  return {
    kind: "found",
    operationRef: reserve().operationRef,
    intentDigest: intentDigest("reserve", reserve()),
    originalMethod: "reserveIssuance",
    state: "intent-recorded",
    record: tokenRecord("reserved"),
    nextAction: "observation-only",
  };
}

export function fence() {
  return {
    ...base("operation/prepare-fence"),
    method: "fencePreparation",
    invalidationVersion: 2,
    cause: "cancelled",
    expectedGrantVersion: 1,
    expectedInvalidationVersion: 1,
    responsibilityRef: "responsibility/candidate-fence",
  };
}

export function fenceResult() {
  return {
    kind: "fenced",
    preparation: subject(),
    receipt: receipt("fence", fence(), 3),
    grantVersion: 2,
    invalidationVersion: 2,
    responsibilityRef: "responsibility/candidate-fence",
    affectedScanRef: "scan/candidate",
    nextAction: "reconcile-inventory-and-exact-cleanup",
  };
}

export function useResult() {
  return { kind: "used", operationRef: namedUse().operationRef, audit: audit() };
}
export function deliveryResult() {
  return {
    kind: "delivered",
    receipt: receipt("delivery", delivery(), 3),
    deliveryRef: "delivery/candidate",
    audit: audit(),
  };
}

export function checkoutRequest() {
  const input = {
    schemaVersion: 1,
    preparation: subject(),
    operationRef: "operation/checkout",
    requestId: `req_${id(7)}`,
    effectRef: id(12),
    requestDigest: digest,
    createdAt: now,
    deadline: at(5_000),
  };
  return { ...input, requestDigest: preparationCheckoutRequestDigestV1(input) };
}

export function clock() {
  return { sourceObservedAt: now, receivedAt: now, validUntil: at(5_000), uncertaintyMs: 0 };
}

export function provenance() {
  return {
    producerRef: "producer/compute",
    producerServiceVersion: 1,
    producerProfileRef: "compute-profile/example",
    producerProfileDigest: digest,
    acceptedPortRef: "port/preparation-receipt",
    evidenceRef: "evidence/checkout",
    evidenceVersion: 1,
    clock: clock(),
  };
}

export function checkoutReceipt() {
  const request = checkoutRequest();
  return {
    schemaVersion: 1,
    request,
    receiptRef: "receipt/checkout",
    receiptVersion: 1,
    effectRef: request.effectRef,
    effectRequestDigest: request.requestDigest,
    incarnationRef: subject().incarnationRef,
    revisionId: subject().revisionId,
    actualCommit: commit(),
    staging: staging(),
    provenance: provenance(),
    outcome: "checkout-complete",
  };
}

export function receiptResult(
  status = "complete",
  reason = {
    incomplete: "evidence-incomplete",
    unknown: "provider-outcome-unknown",
    rejected: "authority-denied",
    cancelled: "cancelled",
    stale: "evidence-stale",
    conflict: "operation-conflict",
  }[status],
) {
  return status === "complete"
    ? { status, receipt: checkoutReceipt() }
    : {
        status,
        request: checkoutRequest(),
        reason,
        nextAction: "exact-readback-or-scoped-cleanup",
      };
}

export const samples = {
  subject,
  purpose: () => ({ purpose, preparation: subject() }),
  authority,
  requestUnion: () => ({ purpose, request: reserve() }),
  exchangeUnion: () => ({ purpose, request: reserve(), result: reservationResult() }),
  authorityUnion: () => ({ purpose, observation: authority() }),
  reserve,
  namedUse,
  delivery,
  mintOutcome,
  claim,
  revokeOutcome,
  affected,
  readOperation,
  fence,
  record: tokenRecord,
  inventoryUnion: () => ({ purpose, record: tokenRecord() }),
  reservationResult,
  writeResult,
  page,
  claimResult,
  operationResult,
  fenceResult,
  useResult,
  deliveryResult,
  checkoutRequest,
  checkoutReceipt,
  receiptResult,
};
