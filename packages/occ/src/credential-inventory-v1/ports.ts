import type {
  AffectedTokenQueryV1,
  ClaimRevocationV1,
  CredentialAuditEvidenceV1,
  CredentialStorageCallBoundsV1,
  EphemeralTokenHandleV1,
  ExactCredentialOperationV1,
  MintOutcomeV1,
  NamedCredentialUseV1,
  OutstandingTokenRecordV1,
  ReserveIssuanceV1,
  RevocationOutcomeV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type {
  CurrentCredentialAuthorityV1,
  CredentialMitigationHandleV1,
  CredentialReadHandleV1,
} from "@openclaw-enterprise/contracts/credential-authority-v1";

export type InventoryScopeV1 = ReserveIssuanceV1["scope"];
export type MintClaimInputV1 = Extract<NamedCredentialUseV1, { purpose: "repository-mint" }>;
export type InventoryMutationV1 =
  ReserveIssuanceV1 | MintClaimInputV1 | MintOutcomeV1 | ClaimRevocationV1 | RevocationOutcomeV1;
export type InventoryReadV1 = AffectedTokenQueryV1 | ExactCredentialOperationV1;

/** Immutable history in the SAME protected inventory operation journal.
 * No capabilities, bytes or alternative canonical turn authority. */
export interface InventoryOperationV1 {
  readonly input: InventoryMutationV1;
  readonly digest: string;
  /** Optional original owner receipt projection; absent means unavailable, never guessed. */
  readonly originalReceipt?: {
    readonly schemaVersion: 1;
    readonly operationRef: string;
    readonly intentDigest: string;
    readonly commitRef: string;
    readonly inventoryVersion: number;
    readonly committedAt: string;
  };
  readonly state: "intent-recorded" | "effect-pending" | "effect-unknown" | "completed";
  readonly record: OutstandingTokenRecordV1;
  readonly commitRef: string;
  /** Transaction ordering timestamp, not an actual database COMMIT event. */
  readonly recordedAt: string;
}
export interface ProviderMintClaimV1 {
  readonly issuanceOperationRef: string;
  readonly recordRef: string;
  readonly issuanceIntentDigest: string;
  readonly useOperationRef: string;
  readonly useIntentDigest: string;
  readonly providerAttemptRef: string;
  readonly inventoryVersion: number;
}
export interface RetainedRevocationClaimV1 {
  readonly input: ClaimRevocationV1;
  readonly claimRef: string;
  readonly claimVersion: number;
  readonly providerAttemptRef: string;
  readonly claimedAt: string;
  readonly claimNotAfter: string;
}
/** Bounded snapshot includes unresolved issuance and known live tokens.
 * Terminal history remains retained separately in inventory and journal. */
export interface InventorySnapshotV1 {
  readonly snapshotRef: string;
  readonly snapshotVersion: number;
  readonly callerServiceRef: string;
  readonly filter: AffectedTokenQueryV1["filter"];
  readonly profile: AffectedTokenQueryV1["profile"];
  readonly filterDigest: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly records: readonly OutstandingTokenRecordV1[];
  readonly continuation: string;
}

/** Existing borrowed client, lifetime and poisoning rules. Every write, audit
 * and custody reference shares ONE outer commit. No autocommit/second transaction.
 * Failures poison the transaction even when caught by a caller. Lock installation
 * capacity before scope/operation/record work in the existing owner's fixed order.
 * Operation uniqueness is installation-wide; all record/claim reads are scoped.
 */
export interface CredentialInventoryTransactionV1 {
  assertActive(): void;
  /** Preallocated correlation only, not proof of commit. */
  readonly commitRef: string;
  findOperation(operationRef: string): Promise<InventoryOperationV1 | undefined>;
  appendOperation(operation: InventoryOperationV1): Promise<void>;
  findRecord(recordRef: string): Promise<OutstandingTokenRecordV1 | undefined>;
  insertRecord(record: OutstandingTokenRecordV1): Promise<void>;
  replaceRecord(expectedVersion: number, record: OutstandingTokenRecordV1): Promise<void>;
  liveCounts(): Promise<{
    readonly installation: number;
    readonly agent: number;
    readonly unresolved: number;
  }>;
  listLive(bindingRef: string): Promise<readonly OutstandingTokenRecordV1[]>;
  findMintClaim(recordRef: string): Promise<ProviderMintClaimV1 | undefined>;
  insertMintClaim(claim: ProviderMintClaimV1): Promise<void>;
  findRevocationClaim(claimRef: string): Promise<RetainedRevocationClaimV1 | undefined>;
  appendRevocationClaim(claim: RetainedRevocationClaimV1): Promise<void>;
  findSnapshot(snapshotRef: string): Promise<InventorySnapshotV1 | undefined>;
  insertSnapshot(snapshot: InventorySnapshotV1): Promise<void>;
  /** Verify exact provenance/token/revoke binding and durably retain custody
   * before returning. Preserve staged material across rollback/unknown commit
   * for preauthorized cleanup. There is no plaintext fallback. */
  retainToken(
    input: Extract<MintOutcomeV1, { outcome: "accepted" }>,
    token: EphemeralTokenHandleV1,
  ): Promise<void>;
  loadRevocationToken(
    record: Extract<OutstandingTokenRecordV1, { state: "outstanding" }>,
  ): Promise<EphemeralTokenHandleV1>;
  /** New authority requires accepted. Exact mitigation may record an obligation
   * or explicit incident without vetoing independently accepted cleanup. */
  appendAudit(input: InventoryMutationV1, mitigation: boolean): Promise<CredentialAuditEvidenceV1>;
}
export type InventoryCommitV1<T> =
  | { readonly kind: "committed"; readonly value: T; readonly acknowledgedAt: string }
  | { readonly kind: "commit-unknown" }
  | { readonly kind: "unavailable" };
/** Only the existing owner supplies this. committed means the OUTERMOST commit
 * is known, never a provisional ambient return. acknowledgedAt is the trusted
 * owner time at known commit acknowledgment. unavailable or rejection MUST mean
 * established no commit; every possibly committed failure is commit-unknown.
 * not-found readback never establishes safe replay. No automatic retry. */
export interface CredentialInventoryTransactionOwnerV1 {
  run<T>(
    scope: InventoryScopeV1,
    bounds: CredentialStorageCallBoundsV1,
    work: (transaction: CredentialInventoryTransactionV1) => Promise<T>,
  ): Promise<InventoryCommitV1<T>>;
}
/** Actual accepting owner authenticates nominal handles and exact invocation,
 * scope/service/payload, then checks current canonical authority in this unit.
 * No issuer, handle factory or observation-to-authority promotion lives here. */
export interface CredentialInventoryAcceptingOwnerV1 {
  acceptCurrent(
    input: ReserveIssuanceV1 | MintClaimInputV1,
    authority: CurrentCredentialAuthorityV1,
    transaction: CredentialInventoryTransactionV1,
  ): Promise<boolean>;
  acceptMitigation(
    input: MintOutcomeV1 | ClaimRevocationV1 | RevocationOutcomeV1,
    authority: CredentialMitigationHandleV1,
    transaction: CredentialInventoryTransactionV1,
  ): Promise<boolean>;
  acceptRead(
    input: InventoryReadV1,
    authority: CredentialReadHandleV1,
    transaction: CredentialInventoryTransactionV1,
  ): Promise<boolean>;
}
/** No material or provider permission. Named use must consume fresh authority at
 * its fixed callback boundary AFTER this helper reports known outer commit. */
export type MintClaimResultV1 =
  | { readonly kind: "claimed"; readonly claim: ProviderMintClaimV1 }
  | { readonly kind: "existing"; readonly nextAction: "reconcile-only" }
  | {
      readonly kind: "commit-unknown";
      readonly operationRef: string;
      readonly intentDigest: string;
      readonly nextAction: "exact-readback-only";
    }
  | { readonly kind: "denied"; readonly reason: "invalid-input" | "authority-denied" | "expired" }
  | { readonly kind: "conflict"; readonly reason: "operation-conflict" | "version-conflict" }
  | {
      readonly kind: "unavailable";
      readonly reason: "inventory-unavailable" | "audit-unavailable";
    };
export interface CredentialInventoryMintClaimPortV1 {
  claimProviderMintV1(
    input: MintClaimInputV1,
    authority: CurrentCredentialAuthorityV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<MintClaimResultV1>;
}
