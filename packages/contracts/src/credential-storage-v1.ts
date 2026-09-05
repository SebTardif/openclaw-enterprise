import { types as nodeTypes } from "node:util";
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { immutableCopy, sha256Hex } from "@openclaw-enterprise/utils";
import type { SecretDriver } from "./drivers/secret.ts";
import { AuditId, ConfigurationGeneration, RequestId, SecretId, Timestamp } from "./api/common.ts";
import { SECURITY_EVENT_POLICY, type SecurityEventV1 } from "./security-events.ts";
import {
  CredentialAuthorityObservationSchemaV1,
  CredentialProfileSchemaV1,
  OriginalCredentialBindingSchemaV1,
  type CurrentCredentialAuthorityV1,
  type CredentialManagementHandleV1,
  type CredentialMitigationHandleV1,
  type CredentialReadHandleV1,
} from "./credential-authority-v1.ts";

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

/** Selected interface ceilings, not measured backend guarantees. Outstanding or
 * unresolved rows are never evicted for capacity or age; terminal inventory retention
 * is a minimum, not permission to forget an unresolved provider outcome.
 */
export const CREDENTIAL_STORAGE_LIMITS_V1 = Object.freeze({
  maxRequestBytes: 65_536,
  maxResponseBytes: 262_144,
  maxJsonDepth: 32,
  maxMaterialBytes: 32_768,
  maxTokenBytes: 16_384,
  maxMaterialCacheEntries: 128,
  maxMaterialCacheBytes: 4_194_304,
  materialCacheMaxAgeMs: 60_000,
  maxInventoryPageItems: 20,
  maxRepositoryIds: 20,
  maxPermissions: 8,
  maxCursorBytes: 256,
  maxOutstandingPerAgent: 4,
  maxOutstandingPerInstallation: 128,
  maxConcurrentIssuancePerScope: 1,
  maxCallMs: 5_000,
  revocationClaimLeaseMs: 5_000,
  revokeAttemptDeadlineMs: 5_000,
  revokeAttemptsPerBurst: 5,
  revokeBackoffMs: Object.freeze([1000, 2000, 4000, 8000]),
  revokeLaterRetryMinIntervalMs: 60_000,
  maxClockUncertaintyMs: 2_000,
  githubRefreshMarginMs: 300_000,
  expirySafetyMarginMs: 5_000,
  auditAppendDeadlineMs: SECURITY_EVENT_POLICY.appendDeadlineMs,
  terminalRetentionMs: SECURITY_EVENT_POLICY.retentionDays * 86_400_000,
  snapshotMaxAgeMs: 60_000,
});
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const ref = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
});
const digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const version = ConfigurationGeneration;
const scope = OriginalCredentialBindingSchemaV1.properties.scope;
const versionedRef = Type.Object({ ref, version, digest }, { additionalProperties: false });
const enumOf = <T extends string>(values: readonly T[]) => Type.Enum(values);
const expiryUnknown = object({ kind: Type.Literal("expiry-unproven") });
const returnedScope = object({
  status: enumOf(["matches-request", "mismatch", "unproved"]),
  evidenceRef: ref,
});
const evidencedExpiry = object({
  kind: Type.Literal("provider-expiry"),
  expiresAt: Timestamp,
  observedAt: Timestamp,
  evidenceRef: ref,
});
export const CredentialExpirySchemaV1 = Type.Union([expiryUnknown, evidencedExpiry]);
export type CredentialExpiryV1 = Immutable<Static<typeof CredentialExpirySchemaV1>>;

export const CredentialSecretBindingSchemaV1 = object({
  schemaVersion: Type.Literal(1),
  scope,
  bindingRef: ref,
  bindingVersion: version,
  secretId: SecretId,
  secretVersion: version,
  providerId: CredentialProfileSchemaV1.anyOf[0].properties.providerId,
  account: versionedRef,
  driverId: ref,
  backendBindingRef: ref,
});
export type CredentialSecretBindingV1 = Immutable<Static<typeof CredentialSecretBindingSchemaV1>>;

/** Safe references into the existing account link and protected credential
 * lifecycle, never another registry or a serialized login/refresh/header value.
 */
export const ProtectedModelBindingSchemaV1 = object({
  schemaVersion: Type.Literal(1),
  scope,
  profile: CredentialProfileSchemaV1.anyOf[0],
  binding: CredentialSecretBindingSchemaV1,
  accountLink: versionedRef,
  upstreamWorkspaceRef: ref,
  invocationProfile: versionedRef,
  custody: Type.Literal("external-protected-owner"),
  setup: Type.Union([
    object({
      kind: Type.Literal("api-key-import"),
      invocationMaterial: Type.Literal("api-key"),
      rotationOwnerRef: ref,
      lifecycleProfile: versionedRef,
    }),
    object({
      kind: enumOf(["trusted-login", "workload-federation"]),
      invocationMaterial: Type.Literal("access-token-and-account-context"),
      refreshOwnerRef: ref,
      lifecycleProfile: versionedRef,
    }),
  ]),
});
export type ProtectedModelBindingV1 = Immutable<Static<typeof ProtectedModelBindingSchemaV1>>;

export const CredentialRepositoryGrantSchemaV1 = object({
  providerInstallationRef: ref,
  repositoryIds: Type.Array(Type.String({ pattern: "^[1-9][0-9]{0,19}$" }), {
    minItems: 1,
    maxItems: 20,
    uniqueItems: true,
  }),
  permissions: Type.Array(
    object({
      name: enumOf(["metadata", "contents", "issues", "pull_requests"]),
      access: enumOf(["read", "write"]),
    }),
    { minItems: 1, maxItems: 8, uniqueItems: true },
  ),
  permissionProfile: versionedRef,
});
export type CredentialRepositoryGrantV1 = Immutable<
  Static<typeof CredentialRepositoryGrantSchemaV1>
>;

/** Cache partitions bind material identity and scope only; never cache permission. */
export const CredentialCachePartitionSchemaV1 = Type.Union([
  object({
    schemaVersion: Type.Literal(1),
    purpose: Type.Literal("model-use"),
    scope,
    profile: CredentialProfileSchemaV1,
    binding: CredentialSecretBindingSchemaV1,
    modelBinding: ProtectedModelBindingSchemaV1,
  }),
  object({
    schemaVersion: Type.Literal(1),
    purpose: Type.Literal("repository-mint"),
    scope,
    profile: CredentialProfileSchemaV1,
    binding: CredentialSecretBindingSchemaV1,
    grant: CredentialRepositoryGrantSchemaV1,
  }),
]);
export type CredentialCachePartitionV1 = Immutable<Static<typeof CredentialCachePartitionSchemaV1>>;
/** Required capabilities, not a backend attestation or admitted configuration. */
export const CredentialStorageBackendRequirementsSchemaV1 = object({
  schemaVersion: Type.Literal(1),
  externalCustody: Type.Literal(true),
  authenticatedExactNamedAccess: Type.Literal(true),
  versionedReadAndRotation: Type.Literal(true),
  protectedEncryptionAndKeyCustody: Type.Literal(true),
  durableCompareAndSet: Type.Literal(true),
  durableIntentBeforeMint: Type.Literal(true),
  inventoryAndDeliveryIntentBeforeRelease: Type.Literal(true),
  restartCompleteAffectedSnapshots: Type.Literal(true),
  exactUnknownOperationReadback: Type.Literal(true),
  auditCoupling: enumOf(["same-transaction", "durable-outbox"]),
  independentPreauthorizedMitigation: Type.Literal(true),
});
export type CredentialStorageBackendRequirementsV1 = Immutable<
  Static<typeof CredentialStorageBackendRequirementsSchemaV1>
>;

const base = {
  schemaVersion: Type.Literal(1),
  operationRef: ref,
  requestId: RequestId,
  callerServiceRef: ref,
  scope,
  profile: CredentialProfileSchemaV1,
  originalAuditRef: AuditId,
  createdAt: Timestamp,
  deadline: Timestamp,
};
const locator = object({ issuanceOperationRef: ref, recordRef: ref, intentDigest: digest });
const existing = { ...base, target: locator, expectedInventoryVersion: version };
export const NamedCredentialUseSchemaV1 = Type.Union([
  object({
    ...base,
    method: Type.Literal("withNamedCredential"),
    purpose: Type.Literal("model-use"),
    original: OriginalCredentialBindingSchemaV1,
    binding: CredentialSecretBindingSchemaV1,
    modelBinding: ProtectedModelBindingSchemaV1,
  }),
  object({
    ...base,
    method: Type.Literal("withNamedCredential"),
    purpose: Type.Literal("repository-mint"),
    original: OriginalCredentialBindingSchemaV1,
    binding: CredentialSecretBindingSchemaV1,
    issuance: locator,
    providerAttemptRef: ref,
    expectedInventoryVersion: version,
    grant: CredentialRepositoryGrantSchemaV1,
  }),
]);
export type NamedCredentialUseV1 = Immutable<Static<typeof NamedCredentialUseSchemaV1>>;
export const RotateCredentialBindingSchemaV1 = object({
  ...base,
  method: Type.Literal("rotateBinding"),
  expectedBinding: CredentialSecretBindingSchemaV1,
  replacement: CredentialSecretBindingSchemaV1,
  expectedInvalidationVersion: version,
  invalidationOperationRef: ref,
});
export type RotateCredentialBindingV1 = Immutable<Static<typeof RotateCredentialBindingSchemaV1>>;
export const ReserveIssuanceSchemaV1 = object({
  ...base,
  method: Type.Literal("reserveIssuance"),
  original: OriginalCredentialBindingSchemaV1,
  binding: CredentialSecretBindingSchemaV1,
  grant: CredentialRepositoryGrantSchemaV1,
  authorityVersion: version,
  invalidationVersion: version,
});
export type ReserveIssuanceV1 = Immutable<Static<typeof ReserveIssuanceSchemaV1>>;

const broaderRevocation = object({
  operationRef: ref,
  responsibilityRef: ref,
  scopeEvidenceRef: ref,
  confirmationEvidenceRef: ref,
});
const mintCommon = {
  ...existing,
  method: Type.Literal("recordMintOutcome"),
  observedAt: Timestamp,
  providerAttemptRef: ref,
};
export const MintOutcomeSchemaV1 = Type.Union([
  object({
    ...mintCommon,
    outcome: Type.Literal("accepted"),
    tokenRef: ref,
    protectedRevocationRef: ref,
    expiry: CredentialExpirySchemaV1,
    returnedScope,
    providerEvidenceRef: ref,
  }),
  object({
    ...mintCommon,
    outcome: Type.Literal("definitely-rejected"),
    noIssuanceEvidenceRef: ref,
  }),
  object({
    ...mintCommon,
    outcome: Type.Literal("unknown"),
    expiry: expiryUnknown,
    uncertaintyEvidenceRef: ref,
  }),
  object({
    ...mintCommon,
    outcome: Type.Literal("unknown-expiry-established"),
    expiry: evidencedExpiry,
  }),
  object({
    ...mintCommon,
    outcome: Type.Literal("unknown-expired"),
    expiry: evidencedExpiry,
    clockEvidenceRef: ref,
    uncertaintyMs: Type.Integer({ minimum: 0, maximum: 2000 }),
  }),
  object({
    ...mintCommon,
    outcome: Type.Literal("unknown-broader-revocation-confirmed"),
    broaderRevocation,
  }),
]);
export type MintOutcomeV1 = Immutable<Static<typeof MintOutcomeSchemaV1>>;
export const RecordedTokenDeliverySchemaV1 = object({
  ...existing,
  method: Type.Literal("deliverRecordedToken"),
  tokenRef: ref,
  original: OriginalCredentialBindingSchemaV1,
  binding: CredentialSecretBindingSchemaV1,
  grant: CredentialRepositoryGrantSchemaV1,
  deliveryRef: ref,
});
export type RecordedTokenDeliveryV1 = Immutable<Static<typeof RecordedTokenDeliverySchemaV1>>;

const affectedFilter = object({
  scope,
  bindingRef: ref,
  cause: enumOf([
    "rotation",
    "disable",
    "principal-narrowed",
    "grant-narrowed",
    "mode-changed",
    "assignment-retired",
    "policy-withdrawn",
    "recovery",
  ]),
  invalidationOperationRef: ref,
  invalidationVersion: version,
});
const cursor = object({
  snapshotRef: ref,
  snapshotVersion: version,
  filterDigest: digest,
  afterRecordRef: ref,
  continuation: Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" }),
});
export const AffectedTokenQuerySchemaV1 = object({
  ...base,
  method: Type.Literal("listAffected"),
  filter: affectedFilter,
  limit: Type.Integer({ minimum: 1, maximum: 20 }),
  cursor: Type.Optional(cursor),
});
export type AffectedTokenQueryV1 = Immutable<Static<typeof AffectedTokenQuerySchemaV1>>;
export const ClaimRevocationSchemaV1 = object({
  ...existing,
  method: Type.Literal("claimRevocation"),
  tokenRef: ref,
  revocationOperationRef: ref,
  expectedRevocationVersion: version,
  responsibilityRef: ref,
  previousAttempt: Type.Union([
    object({ kind: Type.Literal("none") }),
    object({
      kind: Type.Literal("reconcile"),
      attemptRef: ref,
      providerOutcome: enumOf(["pending", "unknown", "failed-terminal"]),
    }),
  ]),
});
export type ClaimRevocationV1 = Immutable<Static<typeof ClaimRevocationSchemaV1>>;
const revokeCommon = {
  ...existing,
  method: Type.Literal("recordRevocation"),
  tokenRef: ref,
  revocationOperationRef: ref,
  claimRef: ref,
  claimVersion: version,
  providerAttemptRef: ref,
  observedAt: Timestamp,
};
export const RevocationOutcomeSchemaV1 = Type.Union([
  object({ ...revokeCommon, outcome: Type.Literal("confirmed"), confirmationEvidenceRef: ref }),
  object({
    ...revokeCommon,
    outcome: enumOf(["pending", "unknown", "failed-terminal"]),
    outcomeEvidenceRef: ref,
  }),
  object({
    ...revokeCommon,
    outcome: Type.Literal("expired"),
    expiry: evidencedExpiry,
    clockEvidenceRef: ref,
    uncertaintyMs: Type.Integer({ minimum: 0, maximum: 2000 }),
  }),
]);
export type RevocationOutcomeV1 = Immutable<Static<typeof RevocationOutcomeSchemaV1>>;
export const ExactCredentialOperationSchemaV1 = object({
  ...base,
  method: Type.Literal("readOperation"),
  originalOperationRef: ref,
  originalMethod: enumOf([
    "withNamedCredential",
    "rotateBinding",
    "reserveIssuance",
    "recordMintOutcome",
    "deliverRecordedToken",
    "claimRevocation",
    "recordRevocation",
  ]),
  originalIntentDigest: digest,
});
export type ExactCredentialOperationV1 = Immutable<Static<typeof ExactCredentialOperationSchemaV1>>;

/** Audit facts are projections of the mandatory security-event contract. Commit
 * acceptance and durable outbox obligation differ from eventual sink delivery.
 * This schema carries no raw provider/store messages or credential material.
 */
const auditAccepted = object({
  state: Type.Literal("accepted"),
  eventRef: AuditId,
  commitRef: ref,
  source: Type.Literal("credential"),
  category: Type.Literal("credential"),
});
const mitigationAudit = Type.Union([
  auditAccepted,
  object({
    state: Type.Literal("obligation-recorded"),
    eventRef: AuditId,
    obligationRef: ref,
    commitRef: ref,
  }),
  object({ state: Type.Literal("evidence-missing"), eventRef: AuditId, incidentRef: ref }),
]);
export type CredentialAuditEvidenceV1 = Immutable<Static<typeof mitigationAudit>>;
type AuditProjectionMatches =
  Static<typeof auditAccepted> extends Pick<SecurityEventV1, "source" | "category"> ? true : false;
const auditProjectionMatches: AuditProjectionMatches = true;
void auditProjectionMatches;
const receipt = object({
  schemaVersion: Type.Literal(1),
  operationRef: ref,
  intentDigest: digest,
  commitRef: ref,
  inventoryVersion: version,
  committedAt: Timestamp,
});
const delivery = Type.Union([
  object({ state: Type.Literal("not-delivered") }),
  object({
    state: enumOf(["intent-recorded", "delivered", "unknown"]),
    deliveryRef: ref,
    deliveryOperationRef: ref,
    observedAt: Timestamp,
  }),
]);
const revocation = Type.Union([
  object({ state: Type.Literal("unrequested"), version }),
  object({
    state: enumOf(["pending", "unknown", "failed-terminal"]),
    version,
    revocationOperationRef: ref,
    attemptRef: ref,
    observedAt: Timestamp,
  }),
  object({
    state: Type.Literal("claimed"),
    version,
    revocationOperationRef: ref,
    attemptRef: ref,
    claimRef: ref,
    claimedAt: Timestamp,
    claimNotAfter: Timestamp,
    priorOutcome: enumOf(["none", "pending", "unknown", "failed-terminal"]),
  }),
  object({
    state: Type.Literal("confirmed"),
    version,
    revocationOperationRef: ref,
    attemptRef: ref,
    observedAt: Timestamp,
    confirmationEvidenceRef: ref,
  }),
  object({
    state: Type.Literal("expired"),
    version,
    observedAt: Timestamp,
    expiry: evidencedExpiry,
    clockEvidenceRef: ref,
    uncertaintyMs: Type.Integer({ minimum: 0, maximum: 2000 }),
  }),
]);
const rowBase = {
  schemaVersion: Type.Literal(1),
  target: locator,
  inventoryVersion: version,
  issuance: ReserveIssuanceSchemaV1,
  invalidationVersion: version,
  audit: mitigationAudit,
  updatedAt: Timestamp,
};
export const OutstandingTokenRecordSchemaV1 = Type.Union([
  object({
    ...rowBase,
    state: Type.Literal("reserved"),
    expiry: expiryUnknown,
    disposition: Type.Literal("scope-held"),
  }),
  object({
    ...rowBase,
    state: Type.Literal("mint-unknown"),
    expiry: CredentialExpirySchemaV1,
    providerAttemptRef: ref,
    disposition: Type.Literal("scope-held"),
  }),
  object({
    ...rowBase,
    state: Type.Literal("not-issued"),
    noIssuanceEvidenceRef: ref,
    disposition: Type.Literal("no-effect"),
  }),
  object({
    ...rowBase,
    state: Type.Literal("resolved-without-token"),
    disposition: Type.Literal("resolved-no-live-token"),
    resolution: Type.Union([
      object({
        kind: Type.Literal("expired"),
        observedAt: Timestamp,
        expiry: evidencedExpiry,
        clockEvidenceRef: ref,
        uncertaintyMs: Type.Integer({ minimum: 0, maximum: 2000 }),
      }),
      object({
        kind: Type.Literal("broader-revocation-confirmed"),
        observedAt: Timestamp,
        broaderRevocation,
      }),
    ]),
  }),
  object({
    ...rowBase,
    state: Type.Literal("outstanding"),
    tokenRef: ref,
    protectedRevocationRef: ref,
    expiry: CredentialExpirySchemaV1,
    returnedScope,
    delivery,
    revocation,
    disposition: enumOf(["current-check-required", "mitigation-only"]),
  }),
]);
export type OutstandingTokenRecordV1 = Immutable<Static<typeof OutstandingTokenRecordSchemaV1>>;
const failure = Type.Union([
  object({
    kind: Type.Literal("denied"),
    reason: enumOf([
      "invalid-input",
      "scope-hidden",
      "authority-denied",
      "provider-denied",
      "expired",
    ]),
  }),
  object({
    kind: Type.Literal("conflict"),
    reason: enumOf(["version-conflict", "operation-conflict"]),
  }),
  object({
    kind: Type.Literal("unavailable"),
    reason: enumOf([
      "authority-unavailable",
      "secret-unavailable",
      "inventory-unavailable",
      "audit-unavailable",
    ]),
  }),
  object({ kind: Type.Literal("capacity-exhausted"), reason: Type.Literal("capacity-exhausted") }),
]);
export type CredentialStorageFailureV1 = Immutable<Static<typeof failure>>;
const unknownWrite = object({
  kind: Type.Literal("commit-unknown"),
  operationRef: ref,
  intentDigest: digest,
  nextAction: Type.Literal("exact-readback-only"),
});
export const IssuanceReservationResultSchemaV1 = Type.Union([
  object({
    kind: Type.Literal("reserved"),
    receipt,
    record: OutstandingTokenRecordSchemaV1.anyOf[0],
    audit: auditAccepted,
  }),
  object({
    kind: Type.Literal("existing"),
    record: OutstandingTokenRecordSchemaV1,
    nextAction: Type.Literal("reconcile-only"),
  }),
  unknownWrite,
  failure,
]);
export type IssuanceReservationResultV1 = Immutable<
  Static<typeof IssuanceReservationResultSchemaV1>
>;
export const InventoryWriteResultSchemaV1 = Type.Union([
  object({ kind: Type.Literal("recorded"), receipt, record: OutstandingTokenRecordSchemaV1 }),
  unknownWrite,
  object({
    kind: Type.Literal("evidence-missing"),
    operationRef: ref,
    incidentRef: ref,
    providerOutcome: enumOf([
      "accepted",
      "definitely-rejected",
      "unknown",
      "unknown-expiry-established",
      "unknown-expired",
      "unknown-broader-revocation-confirmed",
      "pending",
      "confirmed",
      "failed-terminal",
      "expired",
    ]),
    nextAction: Type.Literal("retain-unknown-and-exact-mitigation"),
  }),
  failure,
]);
export type InventoryWriteResultV1 = Immutable<Static<typeof InventoryWriteResultSchemaV1>>;
export const BindingMutationResultSchemaV1 = Type.Union([
  object({
    kind: Type.Literal("rotated"),
    receipt,
    binding: CredentialSecretBindingSchemaV1,
    invalidationVersion: version,
    affectedScanRef: ref,
    audit: auditAccepted,
  }),
  unknownWrite,
  failure,
]);
export type BindingMutationResultV1 = Immutable<Static<typeof BindingMutationResultSchemaV1>>;
export const AffectedTokenPageSchemaV1 = Type.Union([
  object({
    kind: Type.Literal("page"),
    snapshotRef: ref,
    snapshotVersion: version,
    filter: affectedFilter,
    filterDigest: digest,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    records: Type.Array(OutstandingTokenRecordSchemaV1, { maxItems: 20 }),
    next: Type.Union([cursor, Type.Null()]),
    outstandingCount: Type.Integer({ minimum: 0, maximum: 128 }),
    unresolvedIssuanceCount: Type.Integer({ minimum: 0, maximum: 128 }),
    coverage: Type.Literal("persisted-snapshot-only"),
  }),
  object({
    kind: Type.Literal("snapshot-invalid"),
    nextAction: Type.Literal("restart-exact-filter"),
  }),
  failure,
]);
export type AffectedTokenPageV1 = Immutable<Static<typeof AffectedTokenPageSchemaV1>>;
export const RevocationClaimResultSchemaV1 = Type.Union([
  object({
    kind: Type.Literal("claimed"),
    receipt,
    record: OutstandingTokenRecordSchemaV1,
    claimRef: ref,
    claimVersion: version,
    claimNotAfter: Timestamp,
    audit: mitigationAudit,
    nextAction: enumOf(["attempt-exact-revocation", "reconcile-previous-attempt"]),
  }),
  object({
    kind: Type.Literal("busy"),
    revocationOperationRef: ref,
    nextAction: Type.Literal("reconcile-only"),
  }),
  unknownWrite,
  failure,
]);
export type RevocationClaimDiagnosticV1 = Immutable<Static<typeof RevocationClaimResultSchemaV1>>;
export type RevocationClaimResultV1 =
  | Exclude<RevocationClaimDiagnosticV1, { kind: "claimed" }>
  | (Extract<RevocationClaimDiagnosticV1, { kind: "claimed" }> & {
      readonly token: EphemeralTokenHandleV1;
    });
export const CredentialOperationResultSchemaV1 = Type.Union([
  object({
    kind: Type.Literal("found"),
    operationRef: ref,
    intentDigest: digest,
    originalMethod: ExactCredentialOperationSchemaV1.properties.originalMethod,
    state: enumOf(["intent-recorded", "effect-pending", "effect-unknown", "completed", "denied"]),
    record: Type.Optional(OutstandingTokenRecordSchemaV1),
    nextAction: Type.Literal("observation-only"),
  }),
  object({
    kind: enumOf(["not-found", "unavailable"]),
    nextAction: Type.Literal("exact-readback-only"),
  }),
  object({ kind: Type.Literal("not-visible") }),
]);
export type CredentialOperationResultV1 = Immutable<
  Static<typeof CredentialOperationResultSchemaV1>
>;

/** Custody handles deliberately have no byte accessor or ordinary diagnostic form. */
declare const materialBrand: unique symbol;
declare const tokenBrand: unique symbol;
export interface CredentialMaterialHandleV1 {
  readonly [materialBrand]: true;
}
export interface EphemeralTokenHandleV1 {
  readonly [tokenBrand]: true;
}
export interface CredentialStorageCallBoundsV1 {
  readonly signal: AbortSignal;
}
/** Closed, serializable observations exclude the fixed adapter's local result. */
export const CredentialUseDiagnosticSchemaV1 = Type.Union([
  object({ kind: Type.Literal("used"), operationRef: ref, audit: auditAccepted }),
  object({
    kind: Type.Literal("effect-unknown"),
    reason: Type.Literal("provider-outcome-unknown"),
    operationRef: ref,
    nextAction: Type.Literal("exact-readback-only"),
  }),
  failure,
]);
export type CredentialUseDiagnosticV1 = Immutable<Static<typeof CredentialUseDiagnosticSchemaV1>>;
export type CredentialUseResultV1<T> =
  | Exclude<CredentialUseDiagnosticV1, { kind: "used" }>
  | (Extract<CredentialUseDiagnosticV1, { kind: "used" }> & { readonly value: T });
export const TokenDeliveryDiagnosticSchemaV1 = Type.Union([
  object({ kind: Type.Literal("delivered"), receipt, deliveryRef: ref, audit: auditAccepted }),
  object({
    kind: Type.Literal("delivery-unknown"),
    operationRef: ref,
    deliveryRef: ref,
    nextAction: Type.Literal("exact-readback-only"),
  }),
  failure,
]);
export type TokenDeliveryDiagnosticV1 = Immutable<Static<typeof TokenDeliveryDiagnosticSchemaV1>>;
export type TokenDeliveryResultV1<T> =
  | Exclude<TokenDeliveryDiagnosticV1, { kind: "delivered" }>
  | (Extract<TokenDeliveryDiagnosticV1, { kind: "delivered" }> & { readonly value: T });

/** Existing named-backend lifecycle is reused. A SecretDriver does not thereby
 * meet protected version/custody or durable inventory requirements.
 */
export interface CredentialStorageDependenciesV1 {
  readonly secretDriver: SecretDriver;
}
export interface ProtectedCredentialPortV1 {
  /** Owner checks fresh authority, exact original/profile/version and mandatory
   * audit before one fixed-adapter callback. Model use resolves the protected
   * account-link/workspace/profile and refresh/rotation ownership. It passes
   * only the invocation's minimum key or access-token/account context handle;
   * login cache/refresh state stays with the external owner. Unavailable renewal
   * denies use, never switches credential class or admits direct runtime login.
   * Repository mint additionally loads
   * the exact durable reservation and atomically CAS-claims its single preknown
   * provider attempt in the same protected operation journal BEFORE callback.
   * The persisted issuance/use-operation/attempt relation survives ACK loss and
   * restart. New use IDs or fresh authority cannot create a second callback
   * after possible mint; exact readback/reconciliation is required. A locator
   * is not proof of reservation or claim.
   */
  withNamedCredentialV1<T>(
    input: NamedCredentialUseV1,
    authority: CurrentCredentialAuthorityV1,
    consume: (material: CredentialMaterialHandleV1) => Promise<T>,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<CredentialUseResultV1<T>>;
  /** Atomic replacement+invalidation+affected scan intent. Old in-flight results
   * remain attributable and tracked; new old-version selection must be fenced.
   */
  rotateBindingV1(
    input: RotateCredentialBindingV1,
    authority: CredentialManagementHandleV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<BindingMutationResultV1>;
}
export interface OutstandingTokenInventoryPortV1 {
  reserveIssuanceV1(
    input: ReserveIssuanceV1,
    authority: CurrentCredentialAuthorityV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<IssuanceReservationResultV1>;
  /** Preserve late old-version results even when new-effect authority is denied.
   * The original protected issuer's exact outcome responsibility is required.
   * An accepted outcome additionally carries token custody, never JSON bytes.
   * A definite CAS conflict can use a fresh reconciliation operation/current
   * CAS retaining the original issuance/provider attempt and authenticated
   * result. Never alter an old operation digest or overwrite stronger evidence;
   * an unknown commit always reads back its original operation first.
   */
  recordMintOutcomeV1(
    input: Extract<MintOutcomeV1, { outcome: "accepted" }>,
    responsibility: CredentialMitigationHandleV1,
    material: EphemeralTokenHandleV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<InventoryWriteResultV1>;
  recordMintOutcomeV1(
    input: Exclude<MintOutcomeV1, { outcome: "accepted" }>,
    responsibility: CredentialMitigationHandleV1,
    material: undefined,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<InventoryWriteResultV1>;
  /** Persist delivery intent before callback; recheck+consume exact current
   * original authority and all versions at the actual release boundary. Callback
   * or ACK loss may already have delivered: reconcile, never infer rollback.
   */
  deliverRecordedTokenV1<T>(
    input: RecordedTokenDeliveryV1,
    authority: CurrentCredentialAuthorityV1,
    deliver: (token: EphemeralTokenHandleV1) => Promise<T>,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<TokenDeliveryResultV1<T>>;
  listAffectedV1(
    input: AffectedTokenQueryV1,
    authority: CredentialReadHandleV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<AffectedTokenPageV1>;
  /** Audit loss cannot suppress independently preauthorized exact mitigation.
   * Lease expiry does not prove an earlier provider attempt ended. Takeover
   * reconciles that same attempt before any independently safe new attempt.
   */
  claimRevocationV1(
    input: ClaimRevocationV1,
    responsibility: CredentialMitigationHandleV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<RevocationClaimResultV1>;
  /** Late evidence may outlive the original claim. Compare its retained exact
   * attempt/claim; a fresh reconciliation operation/current inventory CAS may
   * record that history without reauthorizing provider work or erasing stronger
   * outcomes. ACK loss reconciles the unchanged original write operation.
   */
  recordRevocationV1(
    input: RevocationOutcomeV1,
    responsibility: CredentialMitigationHandleV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<InventoryWriteResultV1>;
  readOperationV1(
    input: ExactCredentialOperationV1,
    authority: CredentialReadHandleV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<CredentialOperationResultV1>;
}

export const CredentialStorageSchemasV1 = Object.freeze({
  backendRequirements: CredentialStorageBackendRequirementsSchemaV1,
  cachePartition: CredentialCachePartitionSchemaV1,
  modelBinding: ProtectedModelBindingSchemaV1,
  profile: CredentialProfileSchemaV1,
  originalBinding: OriginalCredentialBindingSchemaV1,
  authorityObservation: CredentialAuthorityObservationSchemaV1,
  secretBinding: CredentialSecretBindingSchemaV1,
  repositoryGrant: CredentialRepositoryGrantSchemaV1,
  namedUse: NamedCredentialUseSchemaV1,
  rotate: RotateCredentialBindingSchemaV1,
  reserve: ReserveIssuanceSchemaV1,
  mintOutcome: MintOutcomeSchemaV1,
  deliver: RecordedTokenDeliverySchemaV1,
  affectedQuery: AffectedTokenQuerySchemaV1,
  claimRevocation: ClaimRevocationSchemaV1,
  revocationOutcome: RevocationOutcomeSchemaV1,
  readOperation: ExactCredentialOperationSchemaV1,
  record: OutstandingTokenRecordSchemaV1,
  reservationResult: IssuanceReservationResultSchemaV1,
  writeResult: InventoryWriteResultSchemaV1,
  rotationResult: BindingMutationResultSchemaV1,
  affectedPage: AffectedTokenPageSchemaV1,
  claimResult: RevocationClaimResultSchemaV1,
  operationResult: CredentialOperationResultSchemaV1,
  useResult: CredentialUseDiagnosticSchemaV1,
  deliveryResult: TokenDeliveryDiagnosticSchemaV1,
});
export type CredentialStorageSchemaNameV1 = keyof typeof CredentialStorageSchemasV1;
export type CredentialStorageValueV1<K extends CredentialStorageSchemaNameV1> = Immutable<
  Static<(typeof CredentialStorageSchemasV1)[K]>
>;

function plainJson(
  value: unknown,
  stack = new Set<object>(),
  depth = 0,
  budget = { nodes: 0 },
): boolean {
  if (depth > CREDENTIAL_STORAGE_LIMITS_V1.maxJsonDepth || ++budget.nodes > 32_768) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 1024;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || nodeTypes.isProxy(value) || stack.has(value)) return false;
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
    return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256 || (array && (value.length > 128 || keys.length !== value.length + 1)))
    return false;
  stack.add(value);
  for (const key of keys) {
    if (typeof key !== "string") return false;
    if (array && key === "length") continue;
    if (
      array &&
      (!Number.isSafeInteger(Number(key)) ||
        Number(key) < 0 ||
        Number(key) >= value.length ||
        String(Number(key)) !== key)
    )
      return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      !plainJson(descriptor.value, stack, depth + 1, budget)
    )
      return false;
  }
  stack.delete(value);
  return true;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function equal(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function semanticBytes(input: Record<string, unknown>): string {
  // Only per-call correlation/bounds can change on exact read/reconciliation.
  // Original scope, audit, service, method, operation and every CAS remain bound.
  const { requestId: _request, createdAt: _created, deadline: _deadline, ...intent } = input;
  return canonical(intent);
}
function time(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}
function duration(start: unknown, end: unknown, max: number): boolean {
  const elapsed = time(end) - time(start);
  return elapsed > 0 && elapsed <= max;
}
function validTimes(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(validTimes);
  if (!record(value)) return true;
  for (const [key, item] of Object.entries(value)) {
    if (/(?:At|NotAfter)$/.test(key) || key === "deadline") {
      if (
        typeof item !== "string" ||
        !Number.isFinite(time(item)) ||
        new Date(item).toISOString() !== item
      )
        return false;
    } else if (!validTimes(item)) return false;
  }
  return true;
}
/** Checks representation and internal consistency only. Current record lookup,
 * authenticated provenance and guarded acceptance remain real owner duties.
 */
function relationships(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(relationships);
  if (!record(value)) return true;
  if (!Object.values(value).every(relationships)) return false;
  if (
    value.method !== undefined &&
    !duration(value.createdAt, value.deadline, CREDENTIAL_STORAGE_LIMITS_V1.maxCallMs)
  )
    return false;
  if (
    value.turnNotAfter !== undefined &&
    !duration(value.committedDispatchAt, value.turnNotAfter, 900_000)
  )
    return false;
  if (value.scope !== undefined) {
    for (const key of [
      "original",
      "profile",
      "binding",
      "expectedBinding",
      "replacement",
      "filter",
    ]) {
      const nested = value[key];
      if (record(nested) && nested.scope !== undefined && !equal(value.scope, nested.scope))
        return false;
    }
  }
  if (record(value.profile)) {
    for (const key of ["binding", "expectedBinding", "replacement"]) {
      const binding = value[key];
      if (
        record(binding) &&
        (binding.providerId !== value.profile.providerId ||
          !equal(binding.account, value.profile.account))
      )
        return false;
    }
    const grant = value.grant;
    if (
      record(grant) &&
      (value.profile.kind !== "repository" ||
        grant.providerInstallationRef !== value.profile.providerInstallationRef ||
        !equal(grant.permissionProfile, value.profile.permissionProfile))
    )
      return false;
  }
  if (record(value.modelBinding)) {
    if (
      !equal(value.scope, value.modelBinding.scope) ||
      !equal(value.profile, value.modelBinding.profile) ||
      !equal(value.binding, value.modelBinding.binding)
    )
      return false;
  }
  if (
    value.custody === "external-protected-owner" &&
    record(value.profile) &&
    record(value.setup)
  ) {
    const expectedClass = value.setup.kind === "api-key-import" ? "api-key" : value.setup.kind;
    if (value.profile.credentialClass !== expectedClass) return false;
  }
  if (value.repositoryIds !== undefined) {
    const ids = value.repositoryIds as string[];
    if (ids.some((id, i) => i > 0 && ids[i - 1]! >= id)) return false;
    const permissions = value.permissions as { name: string; access: string }[];
    if (
      permissions.some(
        (p, i) =>
          (p.name === "metadata" && p.access !== "read") ||
          (i > 0 && permissions[i - 1]!.name >= p.name),
      )
    )
      return false;
  }
  if (value.purpose !== undefined && record(value.profile)) {
    if ((value.purpose === "model-use") !== (value.profile.kind === "model")) return false;
  }
  if (
    value.method === "reserveIssuance" &&
    record(value.profile) &&
    value.profile.kind !== "repository"
  )
    return false;
  if (
    value.method === "deliverRecordedToken" &&
    record(value.profile) &&
    (value.profile.kind !== "repository" || value.profile.mode !== "native")
  )
    return false;
  if (
    value.method === "rotateBinding" &&
    record(value.expectedBinding) &&
    record(value.replacement)
  ) {
    const previous = value.expectedBinding;
    const replacement = value.replacement;
    if (
      previous.bindingRef !== replacement.bindingRef ||
      previous.secretId !== replacement.secretId ||
      previous.driverId !== replacement.driverId ||
      !equal(previous.scope, replacement.scope) ||
      replacement.bindingVersion !== Number(previous.bindingVersion) + 1 ||
      Number(replacement.secretVersion) <= Number(previous.secretVersion)
    )
      return false;
  }
  if (value.comparedAt !== undefined && record(value.original) && record(value.profile)) {
    if (
      !equal(value.original.scope, value.profile.scope) ||
      time(value.comparedAt) < time(value.original.committedDispatchAt) ||
      !duration(value.comparedAt, value.startNotAfter, 5000) ||
      time(value.startNotAfter) > time(value.leaseNotAfter) ||
      time(value.leaseNotAfter) > time(value.original.turnNotAfter)
    )
      return false;
    if ((value.effect === "model-use") !== (value.profile.kind === "model")) return false;
    if (value.effect === "deliver-token" && value.profile.mode !== "native") return false;
  }
  if (
    value.claimedAt !== undefined &&
    !duration(
      value.claimedAt,
      value.claimNotAfter,
      CREDENTIAL_STORAGE_LIMITS_V1.revocationClaimLeaseMs,
    )
  )
    return false;
  if (
    (value.outcome === "expired" ||
      value.outcome === "unknown-expired" ||
      value.state === "expired" ||
      value.kind === "expired") &&
    record(value.expiry)
  ) {
    if (
      value.expiry.kind !== "provider-expiry" ||
      time(value.observedAt) - Number(value.uncertaintyMs) < time(value.expiry.expiresAt)
    )
      return false;
  }
  if (
    value.observedAt !== undefined &&
    record(value.expiry) &&
    value.expiry.kind === "provider-expiry" &&
    time(value.expiry.observedAt) > time(value.observedAt)
  )
    return false;
  if (record(value.issuance) && record(value.target)) {
    if (
      value.target.issuanceOperationRef !== value.issuance.operationRef ||
      value.target.intentDigest !== `sha256:${sha256Hex(semanticBytes(value.issuance))}` ||
      Number(value.invalidationVersion) < Number(value.issuance.invalidationVersion)
    )
      return false;
    if (
      value.state === "outstanding" &&
      record(value.expiry) &&
      record(value.returnedScope) &&
      record(value.revocation) &&
      record(value.delivery)
    ) {
      if (
        (value.expiry.kind === "expiry-unproven" ||
          value.returnedScope.status !== "matches-request") &&
        value.disposition !== "mitigation-only"
      )
        return false;
      if (
        value.expiry.kind === "provider-expiry" &&
        value.revocation.state === "expired" &&
        record(value.revocation.expiry) &&
        value.expiry.expiresAt !== value.revocation.expiry.expiresAt
      )
        return false;
      if (value.revocation.state !== "unrequested" && value.disposition !== "mitigation-only")
        return false;
      if (
        Number(value.invalidationVersion) > Number(value.issuance.invalidationVersion) &&
        value.disposition !== "mitigation-only"
      )
        return false;
      if (
        value.delivery.state !== "not-delivered" &&
        value.issuance.profile !== undefined &&
        record(value.issuance.profile) &&
        value.issuance.profile.mode !== "native"
      )
        return false;
    }
  }
  if (record(value.receipt) && record(value.record)) {
    if (value.receipt.inventoryVersion !== value.record.inventoryVersion) return false;
    if (
      value.kind === "reserved" &&
      (!record(value.record.issuance) ||
        !record(value.record.target) ||
        value.receipt.operationRef !== value.record.issuance.operationRef ||
        value.receipt.intentDigest !== value.record.target.intentDigest)
    )
      return false;
  }
  if (value.kind === "claimed" && record(value.record)) {
    const revocationValue = value.record.revocation;
    if (
      value.record.state !== "outstanding" ||
      !record(revocationValue) ||
      revocationValue.state !== "claimed" ||
      revocationValue.claimRef !== value.claimRef ||
      revocationValue.version !== value.claimVersion ||
      revocationValue.claimNotAfter !== value.claimNotAfter ||
      value.record.disposition !== "mitigation-only"
    )
      return false;
    if (
      (revocationValue.priorOutcome === "none") !==
      (value.nextAction === "attempt-exact-revocation")
    )
      return false;
  }
  if (
    value.method === "listAffected" &&
    record(value.cursor) &&
    value.cursor.filterDigest !== `sha256:${sha256Hex(canonical(value.filter))}`
  )
    return false;
  if (value.kind === "page") {
    if (!duration(value.createdAt, value.expiresAt, CREDENTIAL_STORAGE_LIMITS_V1.snapshotMaxAgeMs))
      return false;
    if (value.filterDigest !== `sha256:${sha256Hex(canonical(value.filter))}`) return false;
    if (
      record(value.next) &&
      (value.next.snapshotRef !== value.snapshotRef ||
        value.next.snapshotVersion !== value.snapshotVersion ||
        value.next.filterDigest !== value.filterDigest)
    )
      return false;
    const rows = value.records as OutstandingTokenRecordV1[];
    if (new Set(rows.map((row) => row.target.recordRef)).size !== rows.length) return false;
    if (
      rows.some(
        (row) =>
          !record(value.filter) ||
          !equal(row.issuance.scope, value.filter.scope) ||
          row.issuance.binding.bindingRef !== value.filter.bindingRef,
      )
    )
      return false;
    const knownLive = rows.filter(
      (row) =>
        row.state === "outstanding" &&
        row.revocation.state !== "confirmed" &&
        row.revocation.state !== "expired",
    ).length;
    const unknownLive = rows.filter(
      (row) => row.state === "reserved" || row.state === "mint-unknown",
    ).length;
    if (
      Number(value.outstandingCount) < knownLive ||
      Number(value.unresolvedIssuanceCount) < unknownLive ||
      Number(value.outstandingCount) + Number(value.unresolvedIssuanceCount) >
        CREDENTIAL_STORAGE_LIMITS_V1.maxOutstandingPerAgent
    )
      return false;
    if (
      record(value.next) &&
      (rows.length === 0 || value.next.afterRecordRef !== rows[rows.length - 1]!.target.recordRef)
    )
      return false;
  }
  return true;
}

export class CredentialStorageContractErrorV1 extends Error {
  constructor() {
    super("Invalid credential storage V1 value.");
    this.name = "CredentialStorageContractErrorV1";
  }
}
export function parseCredentialStorageV1<K extends CredentialStorageSchemaNameV1>(
  kind: K,
  input: unknown,
): CredentialStorageValueV1<K> {
  try {
    if (typeof kind !== "string" || !Object.hasOwn(CredentialStorageSchemasV1, kind))
      throw new CredentialStorageContractErrorV1();
    const schema: TSchema | undefined = CredentialStorageSchemasV1[kind];
    const max =
      kind.endsWith("Result") || kind === "affectedPage" || kind === "record"
        ? CREDENTIAL_STORAGE_LIMITS_V1.maxResponseBytes
        : CREDENTIAL_STORAGE_LIMITS_V1.maxRequestBytes;
    if (
      !schema ||
      !plainJson(input) ||
      new TextEncoder().encode(JSON.stringify(input)).byteLength > max ||
      !Check(schema, input) ||
      !validTimes(input) ||
      !relationships(input)
    )
      throw new CredentialStorageContractErrorV1();
    return immutableCopy(input) as CredentialStorageValueV1<K>;
  } catch {
    throw new CredentialStorageContractErrorV1();
  }
}

/** JSON.parse validates grammar; the bounded second pass checks duplicate decoded
 * keys and exact nonnegative integer lexemes before accepting rounded values.
 * No caller getters/handles are read.
 */
function validateJsonLexemes(text: string): void {
  let at = 0;
  const space = () => {
    while (/\s/.test(text[at] ?? "") && at < text.length) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === "\\") at++;
      else if (c === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw new CredentialStorageContractErrorV1();
  };
  const visit = (depth: number): void => {
    if (depth > 32) throw new CredentialStorageContractErrorV1();
    space();
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === "{") {
      at++;
      space();
      const seen = new Set<string>();
      if (text[at] === "}") {
        at++;
        return;
      }
      for (;;) {
        space();
        const key = string();
        if (seen.has(key)) throw new CredentialStorageContractErrorV1();
        seen.add(key);
        space();
        at++;
        visit(depth + 1);
        space();
        if (text[at++] === "}") return;
      }
    }
    if (text[at] === "[") {
      at++;
      space();
      if (text[at] === "]") {
        at++;
        return;
      }
      for (;;) {
        visit(depth + 1);
        space();
        if (text[at++] === "]") return;
      }
    }
    const start = at;
    while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++;
    const token = text.slice(start, at);
    if (token === "true" || token === "false" || token === "null") return;
    // All numeric fields are nonnegative safe integers. Inspect original bytes:
    // JSON.parse can round fractional or oversized values before TypeBox sees them.
    if (!/^(?:0|[1-9][0-9]*)$/.test(token) || !Number.isSafeInteger(Number(token)))
      throw new CredentialStorageContractErrorV1();
  };
  visit(0);
}
export function parseCredentialStorageJsonV1<K extends CredentialStorageSchemaNameV1>(
  kind: K,
  text: string,
): CredentialStorageValueV1<K> {
  try {
    const max =
      kind.endsWith("Result") || kind === "affectedPage" || kind === "record"
        ? CREDENTIAL_STORAGE_LIMITS_V1.maxResponseBytes
        : CREDENTIAL_STORAGE_LIMITS_V1.maxRequestBytes;
    if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > max)
      throw new CredentialStorageContractErrorV1();
    const value: unknown = JSON.parse(text);
    validateJsonLexemes(text);
    return parseCredentialStorageV1(kind, value);
  } catch {
    throw new CredentialStorageContractErrorV1();
  }
}
export function canonicalCredentialStorageRequestV1<K extends CredentialStorageSchemaNameV1>(
  kind: K,
  input: CredentialStorageValueV1<K>,
): string {
  const value: unknown = parseCredentialStorageV1(kind, input);
  if (!record(value) || typeof value.method !== "string")
    throw new CredentialStorageContractErrorV1();
  return semanticBytes(value);
}
export function credentialAffectedFilterDigestV1(input: AffectedTokenQueryV1): string {
  const value = parseCredentialStorageV1("affectedQuery", input);
  return `sha256:${sha256Hex(canonical(value.filter))}`;
}
/** Constant unauthorized projection; protected reason vocabulary stays inside owner diagnostics. */
export function credentialStorageExternalDenialV1(): Readonly<{
  schemaVersion: 1;
  code: "not-visible";
}> {
  return Object.freeze({ schemaVersion: 1, code: "not-visible" });
}
