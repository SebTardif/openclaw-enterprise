import { createHash } from "node:crypto";
import {
  canonicalCredentialStorageRequestV1,
  credentialAffectedFilterDigestV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import { binding, digest, grant, id, profile, ref, scope } from "./vectors.mjs";

// Normative correspondence only. These are explicit request/data examples for
// owner review; no fake storage machine executes the happens-before statements.
const now = "2026-01-01T00:00:00.000Z";
const at = (ms) => new Date(Date.parse(now) + ms).toISOString();
const hash = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const original = () => ({
  schemaVersion: 1,
  scope: scope(),
  assignmentRef: { schemaVersion: 1, id: id(5) },
  revisionId: `rev_${id(6)}`,
  lifecycleGeneration: 1,
  runtimeGeneration: 1,
  turnRef: "turn/example",
  attemptRef: "turn-attempt/example",
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
  turnNotAfter: at(900000),
});
const base = (method, operationRef) => ({
  schemaVersion: 1,
  operationRef,
  requestId: `req_${id(7)}`,
  callerServiceRef: "service/example",
  scope: scope(),
  profile: profile(),
  originalAuditRef: `aud_${id(8)}`,
  createdAt: now,
  deadline: at(5000),
  method,
});
export const reserve = () => ({
  ...base("reserveIssuance", "issuance/example"),
  original: original(),
  binding: binding(),
  grant: grant(),
  authorityVersion: 1,
  invalidationVersion: 1,
});
export const locator = () => ({
  issuanceOperationRef: "issuance/example",
  recordRef: "record/example",
  intentDigest: hash(canonicalCredentialStorageRequestV1("reserve", reserve())),
});
const existing = (method, operationRef, cas = 2) => ({
  ...base(method, operationRef),
  target: locator(),
  expectedInventoryVersion: cas,
});
export const namedMint = () => ({
  ...base("withNamedCredential", "named-use/example"),
  purpose: "repository-mint",
  original: original(),
  binding: binding(),
  issuance: locator(),
  providerAttemptRef: "mint-attempt/example",
  expectedInventoryVersion: 1,
  grant: grant(),
});
export const mint = () => ({
  ...existing("recordMintOutcome", "mint-outcome/example"),
  observedAt: now,
  providerAttemptRef: "mint-attempt/example",
  outcome: "accepted",
  tokenRef: "token/example",
  protectedRevocationRef: "protected-revoke/example",
  expiry: {
    kind: "provider-expiry",
    expiresAt: at(3600000),
    observedAt: now,
    evidenceRef: "provider-expiry/example",
  },
  returnedScope: { status: "matches-request", evidenceRef: "provider-scope/example" },
  providerEvidenceRef: "provider-result/example",
});
export const unknownMint = () => ({
  ...existing("recordMintOutcome", "unknown-mint/example"),
  observedAt: now,
  providerAttemptRef: "mint-attempt/example",
  outcome: "unknown",
  expiry: { kind: "expiry-unproven" },
  uncertaintyEvidenceRef: "provider-uncertainty/example",
});
export const delivery = () => ({
  ...existing("deliverRecordedToken", "delivery/example", 3),
  tokenRef: "token/example",
  original: original(),
  binding: binding(),
  grant: grant(),
  deliveryRef: "delivery-ref/example",
});
export const readback = (kind, request) => ({
  ...base("readOperation", "readback/example"),
  originalOperationRef: request.operationRef,
  originalMethod: request.method,
  originalIntentDigest: hash(canonicalCredentialStorageRequestV1(kind, request)),
});
export const claim = () => ({
  ...existing("claimRevocation", "claim/example", 4),
  tokenRef: "token/example",
  revocationOperationRef: "revoke/example",
  expectedRevocationVersion: 1,
  responsibilityRef: "responsibility/example",
  previousAttempt: {
    kind: "reconcile",
    attemptRef: "revoke-attempt/example",
    providerOutcome: "unknown",
  },
});
export const revoke = () => ({
  ...existing("recordRevocation", "revoke-outcome/example", 5),
  tokenRef: "token/example",
  revocationOperationRef: "revoke/example",
  claimRef: "old-claim/example",
  claimVersion: 1,
  providerAttemptRef: "revoke-attempt/example",
  observedAt: now,
  outcome: "confirmed",
  confirmationEvidenceRef: "provider-revocation/example",
});
export const affectedQuery = () => ({
  ...base("listAffected", "scan/example"),
  filter: {
    scope: scope(),
    bindingRef: "binding/example",
    cause: "rotation",
    invalidationOperationRef: "invalidation/example",
    invalidationVersion: 2,
  },
  limit: 20,
});
export const emptyFinalPage = () => {
  const query = affectedQuery();
  return {
    kind: "page",
    snapshotRef: "snapshot/example",
    snapshotVersion: 1,
    filter: query.filter,
    filterDigest: credentialAffectedFilterDigestV1(query),
    createdAt: now,
    expiresAt: at(60000),
    records: [],
    next: null,
    outstandingCount: 1,
    unresolvedIssuanceCount: 1,
    coverage: "persisted-snapshot-only",
  };
};
export const mintUnknownRecord = () => ({
  schemaVersion: 1,
  target: locator(),
  inventoryVersion: 3,
  issuance: reserve(),
  invalidationVersion: 1,
  audit: {
    state: "accepted",
    eventRef: `aud_${id(8)}`,
    commitRef: "commit/example",
    source: "credential",
    category: "credential",
  },
  updatedAt: now,
  state: "mint-unknown",
  expiry: mint().expiry,
  providerAttemptRef: "mint-attempt/example",
  disposition: "scope-held",
});
const sample = (kind, value) => ({ kind, value });
export const traces = [
  {
    name: "before-mint-and-before-delivery",
    order: [
      "known-outer-commit-immutable-intent",
      "known-outer-commit-unique-provider-attempt-claim",
      "possible-provider-effect",
      "durable-protected-token-and-revocation-custody",
      "known-outer-commit-inventory-and-delivery-intent",
      "current-original-authority-release",
    ],
    obligation:
      "No callback inside an open outer transaction; no release from a method-local provisional write.",
    samples: [
      sample("reserve", reserve()),
      sample("namedUse", namedMint()),
      sample("mintOutcome", mint()),
      sample("deliver", delivery()),
    ],
  },
  {
    name: "commit-ack-loss",
    order: ["possible-original-commit", "original-exact-readback"],
    obligation:
      "Neither not-found, unavailable, existing, a new use operation nor fresh authority permits a second mint.",
    samples: [
      sample("readOperation", readback("reserve", reserve())),
      sample("reservationResult", {
        kind: "commit-unknown",
        operationRef: reserve().operationRef,
        intentDigest: locator().intentDigest,
        nextAction: "exact-readback-only",
      }),
      sample("operationResult", { kind: "not-found", nextAction: "exact-readback-only" }),
    ],
  },
  {
    name: "rotation-narrowing-late-mint",
    order: [
      "old-attempt-claimed",
      "binding-cas-invalidation-scan",
      "late-old-attempt-evidence",
      "track-mitigation-only",
    ],
    obligation:
      "Rotation/narrowing fences delivery, retaining old secret version and immutable issuance/attempt attribution.",
    samples: [sample("mintOutcome", mint()), sample("affectedQuery", affectedQuery())],
  },
  {
    name: "late-evidence-after-definite-cas-conflict",
    order: [
      "definite-cas-conflict",
      "fresh-authorized-reconciliation-current-cas",
      "retain-original-effect-digest-cas-history-attempt",
    ],
    obligation:
      "Fresh reconciliation can record authenticated late evidence, never change an old digest or remint; unknown commit first reads its unchanged original write.",
    samples: [
      sample("writeResult", { kind: "conflict", reason: "version-conflict" }),
      sample("mintOutcome", {
        ...mint(),
        operationRef: "late-reconciliation/example",
        expectedInventoryVersion: 8,
      }),
      sample("readOperation", readback("mintOutcome", mint())),
    ],
  },
  {
    name: "unknown-expiry",
    order: ["possible-mint", "retain-expiry-unproven"],
    obligation:
      "Clock passage, capacity or cache age cannot resolve unknown issuance without provider expiry/effect evidence.",
    samples: [sample("mintOutcome", unknownMint())],
  },
  {
    name: "future-expiry-established-still-unknown",
    order: ["unknown-mint", "provider-expiry-established", "retain-mint-unknown-scope-held"],
    obligation:
      "A future evidenced expiry does not establish absence, token custody or permission to deliver.",
    samples: [
      sample("mintOutcome", {
        ...existing("recordMintOutcome", "expiry-established/example", 3),
        observedAt: now,
        providerAttemptRef: "mint-attempt/example",
        outcome: "unknown-expiry-established",
        expiry: mint().expiry,
      }),
      sample("record", mintUnknownRecord()),
    ],
  },
  {
    name: "revoke-claim-takeover-and-late-evidence",
    order: [
      "possible-revoke-effect",
      "claim-lease-expires",
      "reconcile-original-attempt",
      "fresh-cas-retains-original-claim-and-attempt",
    ],
    obligation:
      "Lease expiry never proves provider cessation; late confirmation retains the old claim history and cannot authorize another effect.",
    samples: [
      sample("claimRevocation", claim()),
      sample("revocationOutcome", {
        ...revoke(),
        operationRef: "late-revoke-reconciliation/example",
        expectedInventoryVersion: 9,
      }),
      sample("readOperation", readback("revocationOutcome", revoke())),
    ],
  },
  {
    name: "audit-outage-exact-mitigation",
    order: [
      "deny-new-authority",
      "independently-preauthorized-exact-mitigation",
      "durable-obligation-or-missing-evidence",
    ],
    obligation:
      "Audit loss cannot suppress exact mitigation or manufacture emergency authority/provider confirmation.",
    samples: [
      sample("reservationResult", { kind: "unavailable", reason: "audit-unavailable" }),
      sample("writeResult", {
        kind: "evidence-missing",
        operationRef: "revoke-outcome/example",
        incidentRef: "missing-evidence/example",
        providerOutcome: "unknown",
        nextAction: "retain-unknown-and-exact-mitigation",
      }),
      sample("claimRevocation", claim()),
    ],
  },
  {
    name: "restart-snapshot-empty-final-page",
    order: [
      "persist-exact-filter-version-and-cursor",
      "restart-read-same-snapshot",
      "page-exhaustion-is-snapshot-only",
      "reconcile-later-outcomes",
    ],
    obligation:
      "Reserved/unknown/late rows inside the cut remain covered; later outcomes require invalidation reconciliation, not a retroactively mutable snapshot or global closure.",
    samples: [sample("affectedQuery", affectedQuery()), sample("affectedPage", emptyFinalPage())],
  },
  {
    name: "delivery-response-loss",
    order: [
      "durable-custody-inventory-and-delivery-intent",
      "possible-release",
      "exact-original-readback",
    ],
    obligation: "Callback/ACK loss cannot roll back delivery or permit blind retry.",
    samples: [
      sample("deliveryResult", {
        kind: "delivery-unknown",
        operationRef: delivery().operationRef,
        deliveryRef: delivery().deliveryRef,
        nextAction: "exact-readback-only",
      }),
      sample("readOperation", readback("deliver", delivery())),
    ],
  },
];
