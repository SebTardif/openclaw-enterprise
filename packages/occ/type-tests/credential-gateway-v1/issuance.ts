import type {
  TokenIssuerAttemptV1,
  TokenIssuerV1,
  TokenMintResultV1,
  TokenRevokerV1,
} from "@openclaw-enterprise/contracts";
import type {
  Bounds,
  PlatformReadView,
  PlatformStateStore,
  PlatformUnitOfWork,
} from "@openclaw-enterprise/occ";

import type {
  AdmittedCredentialSelection,
  RetainedCredential,
  ProtectedCredentialSource,
} from "../../src/credential-gateway-v1/handles.ts";

import type {
  ChargedIssuedSlot,
  EncryptedMaterialStore,
  IssuedLeaseClaims,
  IssuedLeaseIdentity,
  IssuedMechanismFactory,
  IssuanceCommitOutcome,
  IssuanceRetentionObligation,
  RetainedIssuedMaterialObligation,
  IssuanceRetentionOutcome,
  IssuanceRetentionTransaction,
  IssuanceStateDependencies,
  KnownIssuanceCommit,
  OriginalIssuedSettlement,
  ProtectedSourceLease,
  SealedMaterial,
} from "../../src/credential-gateway-v1/issuance.ts";
import type { CredentialInventoryTransactionV1 } from "../../src/credential-inventory-v1/ports.ts";
import type { RepositoryTransactionLifetime } from "../../src/ports/transaction.ts";

// @ts-expect-error GitHub source loading belongs to controller composition, not the OCC root.
import type { ProtectedSourceLoader as PublicProtectedSourceLoader } from "@openclaw-enterprise/occ";

// OCC owns original result settlement and source release, without borrowing
// signing material or custody callbacks from the concrete provider.
export async function originalSettlement(settlement: OriginalIssuedSettlement): Promise<void> {
  if (settlement.kind === "mint") {
    await settlement.originalOwner.settleAttempt(settlement.originalResult);
    const lease: ProtectedSourceLease = settlement.sourceLease;
    await lease.release();
  } else {
    await settlement.originalOwner.settleAttempt(settlement.originalResult);
  }
}

export async function realStateCorrespondence(
  dependencies: IssuanceStateDependencies,
  state: PlatformUnitOfWork,
  read: PlatformReadView,
  lifetime: RepositoryTransactionLifetime,
  material: SealedMaterial,
  bounds: Bounds,
): Promise<void> {
  const actualState: PlatformStateStore = dependencies.state;
  const transaction: IssuanceRetentionTransaction = dependencies.bindTransaction(state);
  void (transaction.state satisfies PlatformUnitOfWork);
  const actualInventory: CredentialInventoryTransactionV1 = transaction.inventory;
  const envelopes: EncryptedMaterialStore = transaction.envelopes;
  await envelopes.retainExact(material, bounds);
  const staged: SealedMaterial | undefined = await envelopes.readExact(material.materialId, bounds);
  const immutableRead: SealedMaterial | undefined = await dependencies
    .bindReadView(read)
    .readExact(material.materialId, bounds);
  const leaseClaims: IssuedLeaseClaims | undefined = await transaction.leaseClaims.findLease(
    material.leaseId,
    bounds,
  );
  void leaseClaims;
  const preallocated: string = actualInventory.commitRef;
  // @ts-expect-error Preallocated commitRef is not known outer COMMIT evidence.
  const forgedCommit: KnownIssuanceCommit = preallocated;
  // @ts-expect-error Callback/lifetime drain completion is not known COMMIT.
  const finishedCommit: KnownIssuanceCommit = await lifetime.finish();
  // @ts-expect-error Only the original State may finish accepted transaction work.
  await transaction.lifetime.finish();
  // @ts-expect-error Retention borrowers cannot close the original transaction.
  transaction.lifetime.close();
  // @ts-expect-error The real read view is not a mutable UnitOfWork.
  const readAsWrite: PlatformUnitOfWork = read;
  void [actualState, staged, immutableRead, forgedCommit, finishedCommit, readAsWrite];
}

export function chargedCapacity(
  lease: IssuedLeaseIdentity,
  mint: TokenIssuerAttemptV1,
  unknown: ChargedIssuedSlot,
  retired: ChargedIssuedSlot,
): IssuedLeaseClaims {
  const claims: IssuedLeaseClaims = {
    lease,
    version: 1,
    maxInFlightMints: 1,
    maxChargedSlots: 2,
    inFlightMint: mint,
    chargedSlots: [unknown, retired],
  };
  // @ts-expect-error A lease has only one in-flight mint.
  const multipleMints: IssuedLeaseClaims = { ...claims, inFlightMint: [mint, mint] };
  // @ts-expect-error Aggregate capacity includes unknown and retired cleanup.
  const threeSlots: IssuedLeaseClaims = { ...claims, chargedSlots: [unknown, retired, unknown] };
  // @ts-expect-error The lease capacity is fixed at two.
  const widenedLimit: IssuedLeaseClaims = { ...claims, maxChargedSlots: 4 };
  void [multipleMints, threeSlots, widenedLimit];
  return claims;
}

export function commitAndOutcomeSeparation(
  unknownProvider: Extract<TokenMintResultV1, { kind: "unknown" }>,
  commit: KnownIssuanceCommit,
  credential: RetainedCredential,
  obligation: IssuanceRetentionObligation,
  retainedObligation: RetainedIssuedMaterialObligation,
  outcome: IssuanceRetentionOutcome,
): void {
  const unknownCommit: IssuanceCommitOutcome = {
    kind: "unknown",
    evidenceRef: "commit-evidence",
    nextAction: "reconcile-only",
  };
  const unusable: IssuanceRetentionOutcome = {
    kind: "unusable",
    commit: unknownCommit,
    obligation,
  };
  if (outcome.kind === "retained") {
    const originalMinted: Extract<TokenMintResultV1, { kind: "minted" }> = outcome.originalResult;
    void originalMinted;
  } else {
    // @ts-expect-error Unknown/failed retention cannot supply a usable credential.
    outcome.credential;
  }
  const upgraded: Extract<IssuanceRetentionOutcome, { kind: "retained" }> = {
    kind: "retained",
    // @ts-expect-error Provider unknown cannot be upgraded to a retained minted result.
    originalResult: unknownProvider,
    commit,
    credential,
    obligation: retainedObligation,
  };
  // @ts-expect-error Unresolved/missing envelope material is not successful retention.
  const missingEnvelope: RetainedIssuedMaterialObligation = obligation;
  void [unusable, upgraded, missingEnvelope];
}

export async function admittedFactoryShape(
  factory: IssuedMechanismFactory,
  selection: AdmittedCredentialSelection,
  source: ProtectedCredentialSource,
  bounds: Bounds,
): Promise<void> {
  const issuer: TokenIssuerV1 = await factory.createIssuer(selection, source, bounds);
  const cleanup: TokenRevokerV1 = await factory.createRevoker(selection, bounds);
  // @ts-expect-error Caller IDs cannot substitute for admitted selection.
  factory.createRevoker("selection-id", bounds);
  void [issuer, cleanup];
}
