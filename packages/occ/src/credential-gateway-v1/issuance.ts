import type {
  EphemeralTokenHandleV1,
  OriginalCredentialBindingV1,
  OutstandingTokenRecordV1,
  TokenIssuerAttemptV1,
  TokenIssuerV1,
  TokenMintResultV1,
  TokenRevokeResultV1,
  TokenRevokerV1,
} from "@openclaw-enterprise/contracts";
import type { CredentialInventoryTransactionV1 } from "../credential-inventory-v1/ports.ts";
import type {
  GitHubAppMaterialV1,
  GitHubAppTokenCustodyV1,
} from "../github-app-provider-v1/types.ts";
import type { RepositoryTransactionLifetime } from "../ports/transaction.ts";
import type {
  PlatformReadView,
  PlatformStateStore,
  PlatformUnitOfWork,
} from "../state/platform-state.ts";
import type {
  CredentialAccessGrant,
  CredentialObservation,
  CredentialProfileRef,
  CredentialTarget,
} from "./connection.ts";
import type { TokenProfile } from "./github-operations.ts";
import type {
  AdmittedCredentialSelection,
  Bounds,
  LocalHandle,
  ProtectedCredentialSource,
  RetainedCredential,
} from "./handles.ts";
import type { DefinitionRef, SchemaRef } from "./schema.ts";

/** Original protected source owner. Release drains original issuer settlement and
 * late finalizers, including failed construction; it never destroys a shared source.
 * Closing material or releasing this lease proves neither revocation nor COMMIT. */
export interface ProtectedSourceLease {
  readonly material: GitHubAppMaterialV1;
  release(): Promise<void>;
}

/** Trusted source owner supplies actual material, identity, clock and currentness.
 * This is an internal dependency, never an Agent/API Secret-reading callback. */
export interface ProtectedSourceLoader {
  load(source: ProtectedCredentialSource, bounds: Bounds): Promise<ProtectedSourceLease>;
}

/** Declaration of the existing revocable issuance specialization. Registration
 * must authenticate an implemented bridge; this shape does not install one. */
export interface IssuedMechanismFactory {
  readonly definition: DefinitionRef;
  readonly lifecycleContract: "token-issuer-v1";
  readonly acquisitionMode: "issued";
  readonly invalidation: "per-credential";
  readonly profileSchemas: readonly SchemaRef[];
  createIssuer(
    selection: AdmittedCredentialSelection,
    source: ProtectedCredentialSource,
    bounds: Bounds,
  ): Promise<TokenIssuerV1>;
  /** Keyless cleanup uses the original retained custody owner. */
  createRevoker(selection: AdmittedCredentialSelection, bounds: Bounds): Promise<TokenRevokerV1>;
}

export interface GitHubIssuedMechanismDependencies {
  readonly protectedSources: ProtectedSourceLoader;
  readonly custody: GitHubAppTokenCustodyV1;
}

/** Protected envelope data. The crypto owner authenticates all identity/profile
 * context, versions and digests and verifies immutable exact readback. Ciphertext
 * never goes through nonsecret schema codecs or an Agent-facing broker response. */
export interface SealedMaterial {
  readonly materialId: string;
  readonly attemptId: string;
  readonly accessId: string;
  readonly leaseId: string;
  readonly definition: DefinitionRef;
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly target: CredentialTarget;
  readonly profile: CredentialProfileRef;
  readonly observation: CredentialObservation;
  readonly keyId: string;
  readonly keyDigest: string;
  readonly contextDigest: string;
  readonly ciphertextDigest: string;
  readonly ciphertext: Uint8Array;
}

/** Borrowed repository bound to the SAME existing State transaction and lifetime.
 * Immutable exact retries reject conflicting bytes. Completion is staging only;
 * no autocommit, second transaction or independent audit/custody write is allowed. */
export interface EncryptedMaterialStore {
  retainExact(material: SealedMaterial, bounds: Bounds): Promise<void>;
  readExact(materialId: string, bounds: Bounds): Promise<SealedMaterial | undefined>;
}

export interface IssuanceRetentionTransaction {
  readonly state: PlatformUnitOfWork;
  readonly lifetime: RepositoryTransactionLifetime;
  readonly inventory: CredentialInventoryTransactionV1;
  readonly envelopes: EncryptedMaterialStore;
  readonly leaseClaims: IssuedLeaseClaimRepository;
}

/** Actual State owner dependencies; no substitute transact/commit implementation.
 * The retention participant must borrow that owner's transaction, locks, poison
 * and READ COMMITTED semantics. read/transact callback completion is not a commit
 * receipt and does not supply current Work/IAM acquisition authority. */
export interface IssuanceStateDependencies {
  readonly state: PlatformStateStore;
  bindTransaction(
    state: PlatformUnitOfWork,
    lifetime: RepositoryTransactionLifetime,
  ): IssuanceRetentionTransaction;
  bindReadView(state: PlatformReadView): Pick<EncryptedMaterialStore, "readExact">;
}

/** Runtime-authenticated by the existing outer State owner after known COMMIT.
 * A preallocated inventory.commitRef, capture, callback return or lifetime.finish
 * cannot manufacture this evidence. The nominal type alone cannot prove COMMIT. */
export interface KnownIssuanceCommit extends LocalHandle<"known-issuance-commit"> {
  readonly commitRef: string;
}

export type IssuanceCommitOutcome =
  | { readonly kind: "committed"; readonly evidence: KnownIssuanceCommit }
  | { readonly kind: "not-committed"; readonly evidenceRef: string }
  | {
      readonly kind: "unknown";
      readonly evidenceRef: string;
      readonly nextAction: "reconcile-only";
    };

/** Retain these exact objects and their original instances through cancellation,
 * timeout and late capture. settleAttempt receives originalResult on originalOwner;
 * copies, other-instance results and settlement-based outcome upgrades are denied.
 * A cleanup-only revoker may be retained without an App key. */
export type OriginalIssuedSettlement =
  | {
      readonly kind: "mint";
      readonly originalOwner: TokenIssuerV1;
      readonly originalResult: TokenMintResultV1;
      readonly sourceLease: ProtectedSourceLease;
    }
  | {
      readonly kind: "revoke";
      readonly originalOwner: TokenRevokerV1;
      readonly originalResult: TokenRevokeResultV1;
    };

/** Safe references accompany protected handles; none establishes durable retention.
 * Unknown provider results, possible submission and unknown outer COMMIT keep this
 * original obligation, even when cancellation has already returned to the caller. */
export interface IssuanceRetentionObligation {
  readonly lease: IssuedLeaseIdentity;
  readonly originalAttempt: TokenIssuerAttemptV1;
  readonly settlement: OriginalIssuedSettlement;
  readonly inventoryRecord: OutstandingTokenRecordV1;
  readonly material: EphemeralTokenHandleV1 | undefined;
  readonly envelope: SealedMaterial | undefined;
  readonly cleanup: TokenRevokerV1;
}

/** Successful retention keeps protected material/envelope and the original minted
 * settlement together. Missing or unknown material stays an unresolved obligation. */
export interface RetainedIssuedMaterialObligation extends IssuanceRetentionObligation {
  readonly material: EphemeralTokenHandleV1;
  readonly envelope: SealedMaterial;
  readonly settlement: Extract<OriginalIssuedSettlement, { kind: "mint" }> & {
    readonly originalResult: Extract<TokenMintResultV1, { kind: "minted" }>;
  };
}

/** Only minted material with known matching inventory+envelope outer COMMIT may
 * become usable. Owners authenticate original object/handle identity, matching
 * scope/expiry/profile and all retained context before constructing this handle. */
export type IssuanceRetentionOutcome =
  | {
      readonly kind: "retained";
      readonly originalResult: Extract<TokenMintResultV1, { kind: "minted" }>;
      readonly commit: KnownIssuanceCommit;
      readonly credential: RetainedCredential;
      readonly obligation: RetainedIssuedMaterialObligation;
    }
  | {
      readonly kind: "unusable";
      readonly commit: IssuanceCommitOutcome;
      readonly obligation: IssuanceRetentionObligation;
    };

/** Genuine original journal binding and admitted grant are supplied by their
 * owners. IDs/profile data are not Work/IAM authority. A lease retains one exact
 * target and grant profile for replacement tokens, metadata, fetch, push and PR.
 * Preparation has a separate read-only grant/lease and cannot borrow this identity. */
export interface IssuedLeaseIdentity {
  readonly leaseId: string;
  readonly grant: CredentialAccessGrant;
  readonly original: OriginalCredentialBindingV1;
  readonly target: CredentialTarget;
  readonly profile: CredentialProfileRef;
  readonly tokenProfile: TokenProfile;
}

/** Every reservation, unknown attempt and provider-valid retired token stays
 * charged across replicas, closure, eviction and configuration/lease replacement.
 * Unknown may lack a handle; retired material retains keyless cleanup custody. */
export interface ChargedIssuedSlot {
  readonly record: OutstandingTokenRecordV1;
  readonly state: "reserved" | "unknown" | "usable" | "retired";
  readonly material: EphemeralTokenHandleV1 | undefined;
  readonly cleanup: TokenRevokerV1;
}

export interface IssuedLeaseClaims {
  readonly version: number;
  readonly lease: IssuedLeaseIdentity;
  readonly maxInFlightMints: 1;
  readonly maxChargedSlots: 2;
  readonly inFlightMint: TokenIssuerAttemptV1 | undefined;
  /** Two aggregate slots per lease, including unknown and retired cleanup. */
  readonly chargedSlots: readonly [ChargedIssuedSlot | undefined, ChargedIssuedSlot | undefined];
}

/** Release evidence is validated by the original inventory/cleanup owner. Timeouts,
 * settlement, source release, authority closure and local eviction never free a slot.
 * Existing per-Agent and Installation inventory limits remain independently enforced. */
export type IssuedSlotReleaseEvidence =
  | { readonly kind: "definite-no-issuance"; readonly evidenceRef: string }
  | {
      readonly kind: "confirmed-revocation";
      readonly originalResult: Extract<TokenRevokeResultV1, { kind: "confirmed" }>;
      readonly evidenceRef: string;
    }
  | {
      readonly kind: "evidenced-expiry";
      readonly evidenceRef: string;
      readonly expiresAt: number;
      readonly clockEvidenceRef: string;
    };

/** Metadata participant borrowing the same State transaction/lifetime. The owner
 * locks canonical target and lease capacity in fixed inventory order, compares
 * versions and exact profile/attempt identity, and poisons failed writes. Known
 * outer COMMIT is required before dispatch; these returned snapshots confer no
 * authority. Unknown COMMIT cannot authorize replay/remint. Original holds and
 * cleanup survive lease/configuration replacement and remain in retained history. */
export interface IssuedLeaseClaimRepository {
  findLease(leaseId: string, bounds: Bounds): Promise<IssuedLeaseClaims | undefined>;
  claimMint(
    expectedVersion: number,
    lease: IssuedLeaseIdentity,
    originalAttempt: TokenIssuerAttemptV1,
    bounds: Bounds,
  ): Promise<IssuedLeaseClaims>;
  /** Record the exact original outcome and retain unknown/retired charged slots
   * before clearing the in-flight marker. Settlement alone cannot free capacity. */
  recordMintResult(
    expectedVersion: number,
    obligation: IssuanceRetentionObligation & {
      readonly settlement: Extract<OriginalIssuedSettlement, { kind: "mint" }>;
    },
    bounds: Bounds,
  ): Promise<IssuedLeaseClaims>;
  releaseSlot(
    expectedVersion: number,
    lease: IssuedLeaseIdentity,
    recordRef: string,
    evidence: IssuedSlotReleaseEvidence,
    bounds: Bounds,
  ): Promise<IssuedLeaseClaims>;
}
