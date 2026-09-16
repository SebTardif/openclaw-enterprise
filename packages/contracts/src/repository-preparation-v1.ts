import { Type, type Static, type TProperties } from "typebox";
import { ConfigurationGeneration, RequestId, RevisionId, Timestamp } from "./api/common.ts";
import { AccountVersionVectorSchemaV1 } from "./account-authority-v1.ts";
import {
  CredentialAuthorityObservationSchemaV1,
  CredentialProfileSchemaV1,
  OriginalCredentialBindingSchemaV1,
  type CurrentCredentialAuthorityHandleV1,
  type CurrentCredentialAuthorityV1,
} from "./credential-authority-v1.ts";
import {
  CredentialRepositoryGrantSchemaV1,
  CredentialSecretBindingSchemaV1,
} from "./credential-storage-v1.ts";
import { StoreBindingRefSchemaV1 } from "./completed-state-v1.ts";
import {
  ExactEffectLocatorSchemaV1,
  RuntimeEvidenceProvenanceSchemaV1,
  RuntimeGateGuardSchemaV1,
} from "./runtime-effects-v1.ts";
import type { AuthorityCallV1 } from "./runtime-authority-v1.ts";

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
const closed = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const reference = OriginalCredentialBindingSchemaV1.properties.turnRef;
const digest = OriginalCredentialBindingSchemaV1.properties.intentDigest;
const versionedReference = OriginalCredentialBindingSchemaV1.properties.commonGrant;
const uuid = ExactEffectLocatorSchemaV1.properties.effectRef;
const purpose = Type.Literal("candidate-repository-preparation");

/** The selected checkout accepts only a full lowercase SHA1 object identity. */
export const PreparationCommitSchemaV1 = closed({
  algorithm: Type.Literal("sha1"),
  oid: Type.String({ pattern: "^[0-9a-f]{40}$" }),
});
export type PreparationCommitV1 = Immutable<Static<typeof PreparationCommitSchemaV1>>;
export const PreparationRepositoryProfileSchemaV1 = closed({
  ...CredentialProfileSchemaV1.anyOf[1].properties,
  mode: Type.Literal("native"),
});
export type PreparationRepositoryProfileV1 = Immutable<
  Static<typeof PreparationRepositoryProfileSchemaV1>
>;

/** Original candidate lifecycle locator. The real lifecycle and Runtime owners must
 * authenticate admission, incarnation, gate and storage; this DATA is no effect permit. */
export const RepositoryPreparationSubjectSchemaV1 = closed({
  schemaVersion: Type.Literal(1),
  purpose,
  scope: OriginalCredentialBindingSchemaV1.properties.scope,
  preparationRef: uuid,
  incarnationRef: reference,
  revisionId: RevisionId,
  revisionDigest: digest,
  gate: RuntimeGateGuardSchemaV1,
  authorizationGeneration: ConfigurationGeneration,
  admission: closed({
    operationRef: reference,
    requestDigest: digest,
    actorRef: reference,
    requestId: RequestId,
  }),
  grant: versionedReference,
  profile: PreparationRepositoryProfileSchemaV1,
  repositoryId: CredentialRepositoryGrantSchemaV1.properties.repositoryIds.items,
  commit: PreparationCommitSchemaV1,
  originProfile: versionedReference,
  staging: StoreBindingRefSchemaV1,
  createdAt: Timestamp,
  notAfter: Timestamp,
});
export type RepositoryPreparationSubjectV1 = Immutable<
  Static<typeof RepositoryPreparationSubjectSchemaV1>
>;

export const PreparationCredentialAuthorityObservationSchemaV1 = closed({
  schemaVersion: Type.Literal(1),
  preparation: RepositoryPreparationSubjectSchemaV1,
  binding: CredentialSecretBindingSchemaV1,
  accountVersions: AccountVersionVectorSchemaV1,
  leaseRef: reference,
  leaseVersion: ConfigurationGeneration,
  leaseNotAfter: Timestamp,
  authorityVersion: ConfigurationGeneration,
  invalidationVersion: ConfigurationGeneration,
  decisionRef: reference,
  comparedAt: Timestamp,
  startNotAfter: Timestamp,
  requestId: RequestId,
  effect: Type.Enum(["reserve-issuance", "mint-token", "deliver-token"]),
});
export type PreparationCredentialAuthorityObservationV1 = Immutable<
  Static<typeof PreparationCredentialAuthorityObservationSchemaV1>
>;
/** Shares the original authority owner's one handle declaration, with a separate
 * preparation observation. It cannot satisfy original runtime applicability. */
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
  closed({
    purpose: Type.Literal("original-turn-runtime"),
    observation: CredentialAuthorityObservationSchemaV1,
  }),
  closed({ purpose, observation: PreparationCredentialAuthorityObservationSchemaV1 }),
]);
export type RepositoryCredentialAuthorityObservationV1 = Immutable<
  Static<typeof RepositoryCredentialAuthorityObservationSchemaV1>
>;

/** Exact readback correspondence, never checkout submission or permission. */
export const PreparationCheckoutRequestSchemaV1 = closed({
  schemaVersion: Type.Literal(1),
  preparation: RepositoryPreparationSubjectSchemaV1,
  operationRef: reference,
  requestId: RequestId,
  effectRef: uuid,
  requestDigest: digest,
  createdAt: Timestamp,
  deadline: Timestamp,
});
export type PreparationCheckoutRequestV1 = Immutable<
  Static<typeof PreparationCheckoutRequestSchemaV1>
>;
export const PreparationCheckoutReceiptSchemaV1 = closed({
  schemaVersion: Type.Literal(1),
  request: PreparationCheckoutRequestSchemaV1,
  receiptRef: reference,
  receiptVersion: ConfigurationGeneration,
  effectRef: uuid,
  effectRequestDigest: digest,
  incarnationRef: reference,
  revisionId: RevisionId,
  actualCommit: PreparationCommitSchemaV1,
  staging: StoreBindingRefSchemaV1,
  provenance: closed({
    ...RuntimeEvidenceProvenanceSchemaV1.properties,
    clock: closed(RuntimeEvidenceProvenanceSchemaV1.properties.clock.properties),
  }),
  outcome: Type.Literal("checkout-complete"),
});
export type PreparationCheckoutReceiptV1 = Immutable<
  Static<typeof PreparationCheckoutReceiptSchemaV1>
>;
const reason = Type.Enum([
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
  closed({ status: Type.Literal("complete"), receipt: PreparationCheckoutReceiptSchemaV1 }),
  closed({
    status: Type.Enum(["incomplete", "unknown", "rejected", "cancelled", "stale", "conflict"]),
    request: PreparationCheckoutRequestSchemaV1,
    reason,
    nextAction: Type.Literal("exact-readback-or-scoped-cleanup"),
  }),
  closed({ status: Type.Literal("not-visible") }),
]);
export type PreparationReceiptDiagnosticV1 = Immutable<
  Static<typeof PreparationReceiptDiagnosticSchemaV1>
>;

declare const receiptHandleBrand: unique symbol;
/** Local producer-owned, invocation-bound identity; parsed DATA cannot create it. */
export interface ProtectedPreparationReceiptHandleV1 {
  readonly [receiptHandleBrand]: true;
}
export type PreparationReceiptResultV1 =
  | Exclude<PreparationReceiptDiagnosticV1, { status: "complete" }>
  | (Extract<PreparationReceiptDiagnosticV1, { status: "complete" }> & {
      readonly handle: ProtectedPreparationReceiptHandleV1;
    });
export interface RepositoryPreparationReceiptPortV1 {
  /** Authenticate exact scope and original effect; retain original source time.
   * A complete readback neither activates a candidate nor establishes readiness. */
  readReceiptV1(
    input: PreparationCheckoutRequestV1,
    call: AuthorityCallV1,
  ): Promise<PreparationReceiptResultV1>;
  /** Recheck current correspondence after awaits and reject foreign, expired,
   * closed or replayed handles. This assertion never creates readiness. */
  assertCurrentReceiptV1(
    input: PreparationCheckoutRequestV1,
    result: Extract<PreparationReceiptResultV1, { status: "complete" }>,
    call: AuthorityCallV1,
  ): Promise<PreparationReceiptDiagnosticV1>;
}
export type { AuthorityCallV1 } from "./runtime-authority-v1.ts";
