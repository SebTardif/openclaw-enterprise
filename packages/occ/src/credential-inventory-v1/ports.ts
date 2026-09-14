import type {
  ClaimRevocationV1,
  MintOutcomeV1,
  NamedCredentialUseV1,
  OutstandingTokenRecordV1,
  ReserveIssuanceV1,
  RevocationOutcomeV1,
} from "@openclaw-enterprise/contracts";
export type InventoryScopeV1 = ReserveIssuanceV1["scope"];
export type MintClaimInputV1 = Extract<NamedCredentialUseV1, { purpose: "repository-mint" }>;
export type InventoryMutationV1 =
  ReserveIssuanceV1 | MintClaimInputV1 | MintOutcomeV1 | ClaimRevocationV1 | RevocationOutcomeV1;

/** Immutable history in the SAME protected inventory operation journal.
 * No capabilities, bytes or alternative canonical turn authority. */
export interface InventoryOperationV1 {
  readonly input: InventoryMutationV1;
  readonly digest: string;
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
/** Existing borrowed client, lifetime and poisoning rules. Every write, audit
 * and custody reference shares ONE outer commit. No autocommit/second transaction.
 * Failures poison the transaction even when caught by a caller. Lock installation
 * capacity before scope/operation/record work in the existing owner's fixed order.
 * Operation uniqueness is installation-wide; all record/claim reads are scoped.
 */
export interface CredentialInventoryTransactionV1 {
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
}
