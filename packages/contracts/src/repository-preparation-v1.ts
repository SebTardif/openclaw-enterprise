import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { ConfigurationGeneration, RequestId, RevisionId, Timestamp } from "./api/common.ts";
import {
  CredentialProfileSchemaV1,
  OriginalCredentialBindingSchemaV1,
  CredentialAuthorityObservationSchemaV1,
  type CurrentCredentialAuthorityV1,
  type CurrentCredentialAuthorityHandleV1,
  type CredentialMitigationHandleV1,
  type CredentialReadHandleV1,
} from "./credential-authority-v1.ts";
import {
  CREDENTIAL_STORAGE_LIMITS_V1,
  CredentialRepositoryGrantSchemaV1,
  CredentialSecretBindingSchemaV1,
  ReserveIssuanceSchemaV1,
  NamedCredentialUseSchemaV1,
  MintOutcomeSchemaV1,
  RecordedTokenDeliverySchemaV1,
  AffectedTokenQuerySchemaV1,
  ClaimRevocationSchemaV1,
  RevocationOutcomeSchemaV1,
  ExactCredentialOperationSchemaV1,
  OutstandingTokenRecordSchemaV1,
  IssuanceReservationResultSchemaV1,
  InventoryWriteResultSchemaV1,
  AffectedTokenPageSchemaV1,
  RevocationClaimResultSchemaV1,
  CredentialOperationResultSchemaV1,
  CredentialUseDiagnosticSchemaV1,
  TokenDeliveryDiagnosticSchemaV1,
  type CredentialMaterialHandleV1,
  type EphemeralTokenHandleV1,
  type CredentialStorageCallBoundsV1,
  type CredentialUseResultV1,
  type TokenDeliveryResultV1,
  type CredentialStorageFailureV1,
} from "./credential-storage-v1.ts";
import { AccountVersionVectorSchemaV1 } from "./account-authority-v1.ts";
import { RUNTIME_AUTHORITY_LIMITS_V1, type AuthorityCallV1 } from "./runtime-authority-v1.ts";
import {
  RuntimeGateGuardSchemaV1,
  RuntimeEvidenceProvenanceSchemaV1,
  ExactEffectLocatorSchemaV1,
} from "./runtime-effects-v1.ts";
import { StoreBindingRefSchemaV1 } from "./completed-state-v1.ts";

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const version = Type.Literal(1);
const counter = ConfigurationGeneration;
const scope = OriginalCredentialBindingSchemaV1.properties.scope;
const ref = OriginalCredentialBindingSchemaV1.properties.turnRef;
const digest = OriginalCredentialBindingSchemaV1.properties.intentDigest;
const versionedRef = OriginalCredentialBindingSchemaV1.properties.commonGrant;
const uuid = ExactEffectLocatorSchemaV1.properties.effectRef;
const preparationPurpose = Type.Literal("candidate-repository-preparation");

/** Definitions and selected ceilings only; no issuer, currentness or Compute implementation. */
export const REPOSITORY_PREPARATION_LIMITS_V1 = Object.freeze({
  maxRequestBytes: CREDENTIAL_STORAGE_LIMITS_V1.maxRequestBytes,
  maxResponseBytes: CREDENTIAL_STORAGE_LIMITS_V1.maxResponseBytes,
  maxJsonDepth: CREDENTIAL_STORAGE_LIMITS_V1.maxJsonDepth,
  preparationMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.preparationMaxMs,
  authorityReadMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.lookupMaxMs,
  activeRecheckMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.activeRecheckMaxMs,
  observationMaxAgeMs: RUNTIME_AUTHORITY_LIMITS_V1.observationMaxAgeMs,
  uncertaintyMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.clockUncertaintyMaxMs,
  storageCallMaxMs: CREDENTIAL_STORAGE_LIMITS_V1.maxCallMs,
});

/** Exact native checkout profile. Other Git object formats require an admitted variant. */
export const PreparationCommitSchemaV1 = object({
  algorithm: Type.Literal("sha1"),
  oid: Type.String({ pattern: "^[0-9a-f]{40}$" }),
});
export const PreparationRepositoryProfileSchemaV1 = object({
  ...CredentialProfileSchemaV1.anyOf[1].properties,
  mode: Type.Literal("native"),
});
/** A credential-facing lifecycle locator, not a Job, assignment, identity or effect permit.
 * The sole lifecycle owner admits it. Runtime supplies the separately qualified concrete
 * incarnation/Job/Pod/execution/storage mapping; a parsed string proves none of those facts.
 */
export const RepositoryPreparationSubjectSchemaV1 = object({
  schemaVersion: version,
  purpose: preparationPurpose,
  scope,
  preparationRef: uuid,
  incarnationRef: ref,
  revisionId: RevisionId,
  revisionDigest: digest,
  gate: RuntimeGateGuardSchemaV1,
  authorizationGeneration: counter,
  admission: object({
    operationRef: ref,
    requestDigest: digest,
    actorRef: ref,
    requestId: RequestId,
  }),
  grant: versionedRef,
  profile: PreparationRepositoryProfileSchemaV1,
  repositoryId: CredentialRepositoryGrantSchemaV1.properties.repositoryIds.items,
  commit: PreparationCommitSchemaV1,
  originProfile: versionedRef,
  staging: StoreBindingRefSchemaV1,
  createdAt: Timestamp,
  notAfter: Timestamp,
});
export type RepositoryPreparationSubjectV1 = Immutable<
  Static<typeof RepositoryPreparationSubjectSchemaV1>
>;
export const RepositoryCredentialSubjectSchemaV1 = Type.Union([
  object({
    purpose: Type.Literal("original-turn-runtime"),
    original: OriginalCredentialBindingSchemaV1,
  }),
  object({ purpose: preparationPurpose, preparation: RepositoryPreparationSubjectSchemaV1 }),
]);
export type RepositoryCredentialSubjectV1 = Immutable<
  Static<typeof RepositoryCredentialSubjectSchemaV1>
>;

export const PreparationCredentialAuthorityObservationSchemaV1 = object({
  schemaVersion: version,
  preparation: RepositoryPreparationSubjectSchemaV1,
  binding: CredentialSecretBindingSchemaV1,
  accountVersions: AccountVersionVectorSchemaV1,
  leaseRef: ref,
  leaseVersion: counter,
  leaseNotAfter: Timestamp,
  authorityVersion: counter,
  invalidationVersion: counter,
  decisionRef: ref,
  comparedAt: Timestamp,
  startNotAfter: Timestamp,
  requestId: RequestId,
  effect: Type.Enum(["reserve-issuance", "mint-token", "deliver-token"]),
});
export type PreparationCredentialAuthorityObservationV1 = Immutable<
  Static<typeof PreparationCredentialAuthorityObservationSchemaV1>
>;
/** Same accepting owner's handle identity; the NEW observation cannot satisfy an old
 * CurrentCredentialAuthorityV1. The owner must compare purpose/effect at each use.
 * Neither this interface nor its parser creates a handle or authenticates a caller.
 */
export interface CurrentPreparationCredentialAuthorityV1 {
  readonly handle: CurrentCredentialAuthorityHandleV1;
  readonly observation: PreparationCredentialAuthorityObservationV1;
}
export type RepositoryCredentialAuthorityV1 =
  | { readonly purpose: "original-turn-runtime"; readonly authority: CurrentCredentialAuthorityV1 }
  | {
      readonly purpose: "candidate-repository-preparation";
      readonly authority: CurrentPreparationCredentialAuthorityV1;
    };
export const RepositoryCredentialAuthorityObservationSchemaV1 = Type.Union([
  object({
    purpose: Type.Literal("original-turn-runtime"),
    observation: CredentialAuthorityObservationSchemaV1,
  }),
  object({
    purpose: preparationPurpose,
    observation: PreparationCredentialAuthorityObservationSchemaV1,
  }),
]);

/** Reuse exact existing schema fragments while adding a separate preparation domain.
 * Original schemas and canonical bytes are never changed or populated with fake turns.
 */
const preparationFields = {
  credentialPurpose: preparationPurpose,
  preparation: RepositoryPreparationSubjectSchemaV1,
  profile: PreparationRepositoryProfileSchemaV1,
};
const preparationObject = <P extends TProperties>(properties: P) =>
  object({ ...properties, ...preparationFields });
export const PreparationReserveIssuanceSchemaV1 = preparationObject(
  Type.Omit(ReserveIssuanceSchemaV1, ["original"]).properties,
);
export type PreparationReserveIssuanceV1 = Immutable<
  Static<typeof PreparationReserveIssuanceSchemaV1>
>;
export const PreparationNamedCredentialUseSchemaV1 = preparationObject(
  Type.Omit(NamedCredentialUseSchemaV1.anyOf[1], ["original"]).properties,
);
export type PreparationNamedCredentialUseV1 = Immutable<
  Static<typeof PreparationNamedCredentialUseSchemaV1>
>;
export const PreparationTokenDeliverySchemaV1 = preparationObject(
  Type.Omit(RecordedTokenDeliverySchemaV1, ["original"]).properties,
);
export type PreparationTokenDeliveryV1 = Immutable<Static<typeof PreparationTokenDeliverySchemaV1>>;
export const PreparationMintOutcomeSchemaV1 = Type.Union([
  preparationObject(MintOutcomeSchemaV1.anyOf[0].properties),
  preparationObject(MintOutcomeSchemaV1.anyOf[1].properties),
  preparationObject(MintOutcomeSchemaV1.anyOf[2].properties),
  preparationObject(MintOutcomeSchemaV1.anyOf[3].properties),
  preparationObject(MintOutcomeSchemaV1.anyOf[4].properties),
  preparationObject(MintOutcomeSchemaV1.anyOf[5].properties),
]);
export type PreparationMintOutcomeV1 = Immutable<Static<typeof PreparationMintOutcomeSchemaV1>>;
export const PreparationClaimRevocationSchemaV1 = preparationObject(
  ClaimRevocationSchemaV1.properties,
);
export type PreparationClaimRevocationV1 = Immutable<
  Static<typeof PreparationClaimRevocationSchemaV1>
>;
export const PreparationRevocationOutcomeSchemaV1 = Type.Union([
  preparationObject(RevocationOutcomeSchemaV1.anyOf[0].properties),
  preparationObject(RevocationOutcomeSchemaV1.anyOf[1].properties),
  preparationObject(RevocationOutcomeSchemaV1.anyOf[2].properties),
]);
export type PreparationRevocationOutcomeV1 = Immutable<
  Static<typeof PreparationRevocationOutcomeSchemaV1>
>;

const preparationCause = Type.Enum([
  "completed",
  "cancelled",
  "replaced",
  "deadline",
  "authority-lost",
  "rotation",
  "recovery",
]);
const preparationFilter = object({
  ...AffectedTokenQuerySchemaV1.properties.filter.properties,
  cause: preparationCause,
  preparation: RepositoryPreparationSubjectSchemaV1,
});
export const PreparationAffectedTokenQuerySchemaV1 = preparationObject({
  ...AffectedTokenQuerySchemaV1.properties,
  filter: preparationFilter,
});
export type PreparationAffectedTokenQueryV1 = Immutable<
  Static<typeof PreparationAffectedTokenQuerySchemaV1>
>;
export const PreparationReadOperationSchemaV1 = preparationObject({
  ...ExactCredentialOperationSchemaV1.properties,
  originalMethod: Type.Enum([
    "withNamedCredential",
    "reserveIssuance",
    "recordMintOutcome",
    "deliverRecordedToken",
    "claimRevocation",
    "recordRevocation",
    "fencePreparation",
  ]),
});
export type PreparationReadOperationV1 = Immutable<Static<typeof PreparationReadOperationSchemaV1>>;
export const PreparationFenceSchemaV1 = preparationObject({
  ...Type.Omit(PreparationReserveIssuanceSchemaV1, ["binding", "grant", "authorityVersion"])
    .properties,
  method: Type.Literal("fencePreparation"),
  cause: preparationCause,
  expectedGrantVersion: counter,
  expectedInvalidationVersion: counter,
  responsibilityRef: ref,
});
export type PreparationFenceV1 = Immutable<Static<typeof PreparationFenceSchemaV1>>;

const row = <P extends TProperties>(properties: P) =>
  object({
    ...properties,
    credentialPurpose: preparationPurpose,
    issuance: PreparationReserveIssuanceSchemaV1,
  });
export const PreparationTokenRecordSchemaV1 = Type.Union([
  row(OutstandingTokenRecordSchemaV1.anyOf[0].properties),
  row(OutstandingTokenRecordSchemaV1.anyOf[1].properties),
  row(OutstandingTokenRecordSchemaV1.anyOf[2].properties),
  row(OutstandingTokenRecordSchemaV1.anyOf[3].properties),
  row(OutstandingTokenRecordSchemaV1.anyOf[4].properties),
]);
export type PreparationTokenRecordV1 = Immutable<Static<typeof PreparationTokenRecordSchemaV1>>;
export const RepositoryCredentialInventoryRecordSchemaV1 = Type.Union([
  object({
    purpose: Type.Literal("original-turn-runtime"),
    record: OutstandingTokenRecordSchemaV1,
  }),
  object({ purpose: preparationPurpose, record: PreparationTokenRecordSchemaV1 }),
]);
export type RepositoryCredentialInventoryRecordV1 = Immutable<
  Static<typeof RepositoryCredentialInventoryRecordSchemaV1>
>;
export const PreparationReservationResultSchemaV1 = Type.Union([
  object({
    ...IssuanceReservationResultSchemaV1.anyOf[0].properties,
    record: PreparationTokenRecordSchemaV1.anyOf[0],
  }),
  object({
    ...IssuanceReservationResultSchemaV1.anyOf[1].properties,
    record: PreparationTokenRecordSchemaV1,
  }),
  IssuanceReservationResultSchemaV1.anyOf[2],
  IssuanceReservationResultSchemaV1.anyOf[3],
]);
export type PreparationReservationResultV1 = Immutable<
  Static<typeof PreparationReservationResultSchemaV1>
>;
export const PreparationInventoryWriteResultSchemaV1 = Type.Union([
  object({
    ...InventoryWriteResultSchemaV1.anyOf[0].properties,
    record: PreparationTokenRecordSchemaV1,
  }),
  InventoryWriteResultSchemaV1.anyOf[1],
  InventoryWriteResultSchemaV1.anyOf[2],
  InventoryWriteResultSchemaV1.anyOf[3],
]);
export type PreparationInventoryWriteResultV1 = Immutable<
  Static<typeof PreparationInventoryWriteResultSchemaV1>
>;
export const PreparationAffectedTokenPageSchemaV1 = Type.Union([
  object({
    ...AffectedTokenPageSchemaV1.anyOf[0].properties,
    filter: preparationFilter,
    records: Type.Array(PreparationTokenRecordSchemaV1, {
      maxItems: CREDENTIAL_STORAGE_LIMITS_V1.maxInventoryPageItems,
    }),
  }),
  AffectedTokenPageSchemaV1.anyOf[1],
  AffectedTokenPageSchemaV1.anyOf[2],
]);
export type PreparationAffectedTokenPageV1 = Immutable<
  Static<typeof PreparationAffectedTokenPageSchemaV1>
>;
export const PreparationRevocationClaimResultSchemaV1 = Type.Union([
  object({
    ...RevocationClaimResultSchemaV1.anyOf[0].properties,
    record: PreparationTokenRecordSchemaV1,
  }),
  RevocationClaimResultSchemaV1.anyOf[1],
  RevocationClaimResultSchemaV1.anyOf[2],
  RevocationClaimResultSchemaV1.anyOf[3],
]);
export type PreparationRevocationClaimDiagnosticV1 = Immutable<
  Static<typeof PreparationRevocationClaimResultSchemaV1>
>;
export type PreparationRevocationClaimResultV1 =
  | Exclude<PreparationRevocationClaimDiagnosticV1, { kind: "claimed" }>
  | (Extract<PreparationRevocationClaimDiagnosticV1, { kind: "claimed" }> & {
      readonly token: EphemeralTokenHandleV1;
    });
export const PreparationOperationResultSchemaV1 = Type.Union([
  object({
    ...CredentialOperationResultSchemaV1.anyOf[0].properties,
    originalMethod: PreparationReadOperationSchemaV1.properties.originalMethod,
    record: Type.Optional(PreparationTokenRecordSchemaV1),
  }),
  CredentialOperationResultSchemaV1.anyOf[1],
  CredentialOperationResultSchemaV1.anyOf[2],
]);
export type PreparationOperationResultV1 = Immutable<
  Static<typeof PreparationOperationResultSchemaV1>
>;
export const PreparationFenceResultSchemaV1 = Type.Union([
  object({
    kind: Type.Literal("fenced"),
    preparation: RepositoryPreparationSubjectSchemaV1,
    receipt: IssuanceReservationResultSchemaV1.anyOf[0].properties.receipt,
    grantVersion: counter,
    invalidationVersion: counter,
    responsibilityRef: ref,
    affectedScanRef: ref,
    nextAction: Type.Literal("reconcile-inventory-and-exact-cleanup"),
  }),
  InventoryWriteResultSchemaV1.anyOf[1],
  object({
    kind: Type.Literal("evidence-missing"),
    operationRef: ref,
    incidentRef: ref,
    nextAction: Type.Literal("retain-unknown-and-exact-mitigation"),
  }),
  InventoryWriteResultSchemaV1.anyOf[3],
]);
export type PreparationFenceResultV1 = Immutable<Static<typeof PreparationFenceResultSchemaV1>>;

/** Extends the same protected issuer/inventory, never an alternative implementation.
 * Every current-authority operation checks exact purpose/subject/profile/version both
 * before and after awaits, and compares/consumes at the actual release boundary.
 */
export interface RepositoryPreparationCredentialPortV1 {
  reserveIssuanceV1(
    input: PreparationReserveIssuanceV1,
    authority: CurrentPreparationCredentialAuthorityV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<PreparationReservationResultV1>;
  /** Durably CAS-claim the issuance's one preknown providerAttemptRef before callback.
   * Lost ACK/new operation IDs never authorize a second possible mint. */
  withNamedCredentialV1<T>(
    input: PreparationNamedCredentialUseV1,
    authority: CurrentPreparationCredentialAuthorityV1,
    consume: (material: CredentialMaterialHandleV1) => Promise<T>,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<CredentialUseResultV1<T>>;
  recordMintOutcomeV1(
    input: Extract<PreparationMintOutcomeV1, { outcome: "accepted" }>,
    responsibility: CredentialMitigationHandleV1,
    material: EphemeralTokenHandleV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<PreparationInventoryWriteResultV1>;
  recordMintOutcomeV1(
    input: Exclude<PreparationMintOutcomeV1, { outcome: "accepted" }>,
    responsibility: CredentialMitigationHandleV1,
    material: undefined,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<PreparationInventoryWriteResultV1>;
  /** Token/revoke custody and exact delivery intent are durable BEFORE this callback.
   * Callback/ACK loss retains possible delivery; no rollback or blind replay. */
  deliverRecordedTokenV1<T>(
    input: PreparationTokenDeliveryV1,
    authority: CurrentPreparationCredentialAuthorityV1,
    deliver: (token: EphemeralTokenHandleV1) => Promise<T>,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<TokenDeliveryResultV1<T>>;
  listAffectedV1(
    input: PreparationAffectedTokenQueryV1,
    authority: CredentialReadHandleV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<PreparationAffectedTokenPageV1>;
  claimRevocationV1(
    input: PreparationClaimRevocationV1,
    responsibility: CredentialMitigationHandleV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<PreparationRevocationClaimResultV1>;
  recordRevocationV1(
    input: PreparationRevocationOutcomeV1,
    responsibility: CredentialMitigationHandleV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<PreparationInventoryWriteResultV1>;
  readOperationV1(
    input: PreparationReadOperationV1,
    authority: CredentialReadHandleV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<PreparationOperationResultV1>;
  /** Atomically deny future candidate use and retain exact inventory/cleanup obligation.
   * This cannot stop a Job, certify revocation/expiry or mutate a serving grant. */
  fencePreparationV1(
    input: PreparationFenceV1,
    responsibility: CredentialMitigationHandleV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<PreparationFenceResultV1>;
}

/** A nonauthoritative correspondence key. Concrete provider effect/Job identity and
 * authenticated observations are owned by the Runtime producer's separate definition. */
export const PreparationCheckoutRequestSchemaV1 = object({
  schemaVersion: version,
  preparation: RepositoryPreparationSubjectSchemaV1,
  operationRef: ref,
  requestId: RequestId,
  effectRef: uuid,
  requestDigest: digest,
  createdAt: Timestamp,
  deadline: Timestamp,
});
export type PreparationCheckoutRequestV1 = Immutable<
  Static<typeof PreparationCheckoutRequestSchemaV1>
>;
export const PreparationCheckoutReceiptSchemaV1 = object({
  schemaVersion: version,
  request: PreparationCheckoutRequestSchemaV1,
  receiptRef: ref,
  receiptVersion: counter,
  effectRef: uuid,
  effectRequestDigest: digest,
  incarnationRef: ref,
  revisionId: RevisionId,
  actualCommit: PreparationCommitSchemaV1,
  staging: StoreBindingRefSchemaV1,
  provenance: object({
    ...RuntimeEvidenceProvenanceSchemaV1.properties,
    // Type.Pick in the original clock fragment does not retain dictionary closure.
    clock: object(RuntimeEvidenceProvenanceSchemaV1.properties.clock.properties),
  }),
  outcome: Type.Literal("checkout-complete"),
});
export type PreparationCheckoutReceiptV1 = Immutable<
  Static<typeof PreparationCheckoutReceiptSchemaV1>
>;
const checkoutReason = Type.Enum([
  "not-submitted",
  "provider-outcome-unknown",
  "cancelled",
  "deadline-exceeded",
  "replaced",
  "authority-unavailable",
  "authority-denied",
  "scope-mismatch",
  "commit-mismatch",
  "incarnation-mismatch",
  "storage-mismatch",
  "evidence-stale",
  "evidence-incomplete",
  "capability-unavailable",
  "operation-conflict",
]);
export const PreparationReceiptDiagnosticSchemaV1 = Type.Union([
  object({ status: Type.Literal("complete"), receipt: PreparationCheckoutReceiptSchemaV1 }),
  object({
    status: Type.Enum(["incomplete", "unknown", "rejected", "cancelled", "stale", "conflict"]),
    request: PreparationCheckoutRequestSchemaV1,
    reason: checkoutReason,
    nextAction: Type.Literal("exact-readback-or-scoped-cleanup"),
  }),
  object({ status: Type.Literal("not-visible") }),
]);
export type PreparationReceiptDiagnosticV1 = Immutable<
  Static<typeof PreparationReceiptDiagnosticSchemaV1>
>;
declare const receiptHandleBrand: unique symbol;
/** Producer-owned, local and invocation-bound; parsed receipt data never creates it. */
export interface ProtectedPreparationReceiptHandleV1 {
  readonly [receiptHandleBrand]: true;
}
export type PreparationReceiptResultV1 =
  | Exclude<PreparationReceiptDiagnosticV1, { status: "complete" }>
  | (Extract<PreparationReceiptDiagnosticV1, { status: "complete" }> & {
      readonly handle: ProtectedPreparationReceiptHandleV1;
    });
export interface RepositoryPreparationReceiptPortV1 {
  /** Actual producer authenticates exact read scope and original effect, reobserves or
   * reads protected retained evidence, and preserves original source time. Neither
   * this port nor a complete result performs readiness/activation or grants authority. */
  readReceiptV1(
    input: PreparationCheckoutRequestV1,
    call: AuthorityCallV1,
  ): Promise<PreparationReceiptResultV1>;
  /** Reject foreign/forged/expired/replayed handles; compare current candidate and exact
   * retained receipt after awaits. A brand/JSON comparison alone cannot implement this. */
  assertCurrentReceiptV1(
    input: PreparationCheckoutRequestV1,
    result: Extract<PreparationReceiptResultV1, { status: "complete" }>,
    call: AuthorityCallV1,
  ): Promise<PreparationReceiptDiagnosticV1>;
}

// The old standalone request types remain unchanged. Only this new discriminated
// boundary explicitly excludes preparation keys, including on structurally wider values.
const originalOnly = <S extends TSchema>(schema: S) =>
  Type.Intersect([
    schema,
    Type.Object({
      credentialPurpose: Type.Optional(Type.Never()),
      preparation: Type.Optional(Type.Never()),
    }),
  ]);
const originalRequests = Type.Union([
  ReserveIssuanceSchemaV1,
  NamedCredentialUseSchemaV1.anyOf[1],
  MintOutcomeSchemaV1,
  RecordedTokenDeliverySchemaV1,
  AffectedTokenQuerySchemaV1,
  ClaimRevocationSchemaV1,
  RevocationOutcomeSchemaV1,
  ExactCredentialOperationSchemaV1,
]);
const preparationRequests = Type.Union([
  PreparationReserveIssuanceSchemaV1,
  PreparationNamedCredentialUseSchemaV1,
  PreparationMintOutcomeSchemaV1,
  PreparationTokenDeliverySchemaV1,
  PreparationAffectedTokenQuerySchemaV1,
  PreparationClaimRevocationSchemaV1,
  PreparationRevocationOutcomeSchemaV1,
  PreparationReadOperationSchemaV1,
  PreparationFenceSchemaV1,
]);
export const RepositoryCredentialRequestSchemaV1 = Type.Union([
  object({
    purpose: Type.Literal("original-turn-runtime"),
    request: originalOnly(originalRequests),
  }),
  object({ purpose: preparationPurpose, request: preparationRequests }),
]);
export type RepositoryCredentialRequestV1 = Immutable<
  Static<typeof RepositoryCredentialRequestSchemaV1>
>;
/** Pair the actual request/result dictionaries. Successful parse checks exact operation
 * correspondence; neither a response nor its purpose tag supplies invocation authority. */
export const RepositoryCredentialExchangeSchemaV1 = Type.Union([
  object({
    purpose: Type.Literal("original-turn-runtime"),
    request: originalOnly(ReserveIssuanceSchemaV1),
    result: IssuanceReservationResultSchemaV1,
  }),
  object({
    purpose: Type.Literal("original-turn-runtime"),
    request: originalOnly(NamedCredentialUseSchemaV1.anyOf[1]),
    result: CredentialUseDiagnosticSchemaV1,
  }),
  object({
    purpose: Type.Literal("original-turn-runtime"),
    request: originalOnly(MintOutcomeSchemaV1),
    result: InventoryWriteResultSchemaV1,
  }),
  object({
    purpose: Type.Literal("original-turn-runtime"),
    request: originalOnly(RecordedTokenDeliverySchemaV1),
    result: TokenDeliveryDiagnosticSchemaV1,
  }),
  object({
    purpose: Type.Literal("original-turn-runtime"),
    request: originalOnly(AffectedTokenQuerySchemaV1),
    result: AffectedTokenPageSchemaV1,
  }),
  object({
    purpose: Type.Literal("original-turn-runtime"),
    request: originalOnly(ClaimRevocationSchemaV1),
    result: RevocationClaimResultSchemaV1,
  }),
  object({
    purpose: Type.Literal("original-turn-runtime"),
    request: originalOnly(RevocationOutcomeSchemaV1),
    result: InventoryWriteResultSchemaV1,
  }),
  object({
    purpose: Type.Literal("original-turn-runtime"),
    request: originalOnly(ExactCredentialOperationSchemaV1),
    result: CredentialOperationResultSchemaV1,
  }),
  object({
    purpose: preparationPurpose,
    request: PreparationReserveIssuanceSchemaV1,
    result: PreparationReservationResultSchemaV1,
  }),
  object({
    purpose: preparationPurpose,
    request: PreparationNamedCredentialUseSchemaV1,
    result: CredentialUseDiagnosticSchemaV1,
  }),
  object({
    purpose: preparationPurpose,
    request: PreparationMintOutcomeSchemaV1,
    result: PreparationInventoryWriteResultSchemaV1,
  }),
  object({
    purpose: preparationPurpose,
    request: PreparationTokenDeliverySchemaV1,
    result: TokenDeliveryDiagnosticSchemaV1,
  }),
  object({
    purpose: preparationPurpose,
    request: PreparationAffectedTokenQuerySchemaV1,
    result: PreparationAffectedTokenPageSchemaV1,
  }),
  object({
    purpose: preparationPurpose,
    request: PreparationClaimRevocationSchemaV1,
    result: PreparationRevocationClaimResultSchemaV1,
  }),
  object({
    purpose: preparationPurpose,
    request: PreparationRevocationOutcomeSchemaV1,
    result: PreparationInventoryWriteResultSchemaV1,
  }),
  object({
    purpose: preparationPurpose,
    request: PreparationReadOperationSchemaV1,
    result: PreparationOperationResultSchemaV1,
  }),
  object({
    purpose: preparationPurpose,
    request: PreparationFenceSchemaV1,
    result: PreparationFenceResultSchemaV1,
  }),
]);
export type RepositoryCredentialExchangeV1 = Immutable<
  Static<typeof RepositoryCredentialExchangeSchemaV1>
>;

export const RepositoryPreparationSchemasV1: Readonly<{
  subject: typeof RepositoryPreparationSubjectSchemaV1;
  purpose: typeof RepositoryCredentialSubjectSchemaV1;
  authority: typeof PreparationCredentialAuthorityObservationSchemaV1;
  authorityUnion: typeof RepositoryCredentialAuthorityObservationSchemaV1;
  requestUnion: typeof RepositoryCredentialRequestSchemaV1;
  exchangeUnion: typeof RepositoryCredentialExchangeSchemaV1;
  reserve: typeof PreparationReserveIssuanceSchemaV1;
  namedUse: typeof PreparationNamedCredentialUseSchemaV1;
  delivery: typeof PreparationTokenDeliverySchemaV1;
  mintOutcome: typeof PreparationMintOutcomeSchemaV1;
  claim: typeof PreparationClaimRevocationSchemaV1;
  revokeOutcome: typeof PreparationRevocationOutcomeSchemaV1;
  affected: typeof PreparationAffectedTokenQuerySchemaV1;
  readOperation: typeof PreparationReadOperationSchemaV1;
  fence: typeof PreparationFenceSchemaV1;
  record: typeof PreparationTokenRecordSchemaV1;
  inventoryUnion: typeof RepositoryCredentialInventoryRecordSchemaV1;
  reservationResult: typeof PreparationReservationResultSchemaV1;
  writeResult: typeof PreparationInventoryWriteResultSchemaV1;
  page: typeof PreparationAffectedTokenPageSchemaV1;
  claimResult: typeof PreparationRevocationClaimResultSchemaV1;
  operationResult: typeof PreparationOperationResultSchemaV1;
  fenceResult: typeof PreparationFenceResultSchemaV1;
  useResult: typeof CredentialUseDiagnosticSchemaV1;
  deliveryResult: typeof TokenDeliveryDiagnosticSchemaV1;
  checkoutRequest: typeof PreparationCheckoutRequestSchemaV1;
  checkoutReceipt: typeof PreparationCheckoutReceiptSchemaV1;
  receiptResult: typeof PreparationReceiptDiagnosticSchemaV1;
}> = Object.freeze({
  subject: RepositoryPreparationSubjectSchemaV1,
  purpose: RepositoryCredentialSubjectSchemaV1,
  authority: PreparationCredentialAuthorityObservationSchemaV1,
  authorityUnion: RepositoryCredentialAuthorityObservationSchemaV1,
  requestUnion: RepositoryCredentialRequestSchemaV1,
  exchangeUnion: RepositoryCredentialExchangeSchemaV1,
  reserve: PreparationReserveIssuanceSchemaV1,
  namedUse: PreparationNamedCredentialUseSchemaV1,
  delivery: PreparationTokenDeliverySchemaV1,
  mintOutcome: PreparationMintOutcomeSchemaV1,
  claim: PreparationClaimRevocationSchemaV1,
  revokeOutcome: PreparationRevocationOutcomeSchemaV1,
  affected: PreparationAffectedTokenQuerySchemaV1,
  readOperation: PreparationReadOperationSchemaV1,
  fence: PreparationFenceSchemaV1,
  record: PreparationTokenRecordSchemaV1,
  inventoryUnion: RepositoryCredentialInventoryRecordSchemaV1,
  reservationResult: PreparationReservationResultSchemaV1,
  writeResult: PreparationInventoryWriteResultSchemaV1,
  page: PreparationAffectedTokenPageSchemaV1,
  claimResult: PreparationRevocationClaimResultSchemaV1,
  operationResult: PreparationOperationResultSchemaV1,
  fenceResult: PreparationFenceResultSchemaV1,
  useResult: CredentialUseDiagnosticSchemaV1,
  deliveryResult: TokenDeliveryDiagnosticSchemaV1,
  checkoutRequest: PreparationCheckoutRequestSchemaV1,
  checkoutReceipt: PreparationCheckoutReceiptSchemaV1,
  receiptResult: PreparationReceiptDiagnosticSchemaV1,
});
export type RepositoryPreparationSchemaNameV1 = keyof typeof RepositoryPreparationSchemasV1;
export type RepositoryPreparationValueV1<K extends RepositoryPreparationSchemaNameV1> = Immutable<
  Static<(typeof RepositoryPreparationSchemasV1)[K]>
>;
export type { CredentialStorageFailureV1, AuthorityCallV1 };
export type {
  RuntimeGateGuardV1,
  RuntimeEvidenceProvenanceV1,
  RuntimeEffectClockV1,
} from "./runtime-effects-v1.ts";
export type { StoreBindingRefV1 } from "./completed-state-v1.ts";
