import type {
  EphemeralTokenHandleV1,
  TokenIssuerAttemptV1,
  TokenIssuerV1,
  TokenMintResultV1,
  TokenRevokerV1,
} from "@openclaw-enterprise/contracts";
import {
  createGitHubAppTokenIssuerV1,
  createGitHubAppWriteTokenIssuerV1,
  createGitHubAppTokenRevokerV1,
  RepositoryTransactionLifetime,
} from "@openclaw-enterprise/occ";
import type {
  AdmittedCredentialSelection,
  Bounds,
  ChargedIssuedSlot,
  EncryptedMaterialStore,
  GitHubAppMaterialV1,
  GitHubAppTokenCustodyV1,
  GitHubAppTokenIssuerOptionsV1,
  GitHubAppTokenRevokerOptionsV1,
  GitHubIssuedMechanismDependencies,
  GitHubRepositoryWriteSelectionV1,
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
  RetainedCredential,
  PlatformReadView,
  PlatformStateStore,
  PlatformUnitOfWork,
  ProtectedCredentialSource,
  ProtectedSourceLease,
  ProtectedSourceLoader,
  SealedMaterial,
  CredentialInventoryTransactionV1,
} from "@openclaw-enterprise/occ";

// Public construction uses the actual read/write/revoker suppliers and actual
// material/custody contracts. This fixture provides no authority or fake runtime.
export function supplierConstructors(
  read: GitHubAppTokenIssuerOptionsV1,
  write: GitHubRepositoryWriteSelectionV1,
  cleanup: GitHubAppTokenRevokerOptionsV1,
): void {
  const readIssuer: TokenIssuerV1 = createGitHubAppTokenIssuerV1(read);
  const writeIssuer: TokenIssuerV1 = createGitHubAppWriteTokenIssuerV1({
    ...read,
    selection: write,
  });
  const keyless: TokenRevokerV1 = createGitHubAppTokenRevokerV1(cleanup);
  // @ts-expect-error The read supplier still rejects write selection.
  createGitHubAppTokenIssuerV1({ ...read, selection: write });
  // @ts-expect-error A keyless cleanup-only supplier cannot mint.
  keyless.mint;
  void [readIssuer, writeIssuer, keyless];
}

export async function publicSourceAndSettlement(
  loader: ProtectedSourceLoader,
  source: ProtectedCredentialSource,
  bounds: Bounds,
  custody: GitHubAppTokenCustodyV1,
  settlement: OriginalIssuedSettlement,
  handle: EphemeralTokenHandleV1,
): Promise<void> {
  const lease: ProtectedSourceLease = await loader.load(source, bounds);
  const actualMaterial: GitHubAppMaterialV1 = lease.material;
  const dependencies: GitHubIssuedMechanismDependencies = { protectedSources: loader, custody };
  if (settlement.kind === "mint") {
    await settlement.originalOwner.settleAttempt(settlement.originalResult);
    await settlement.sourceLease.release();
  } else {
    await settlement.originalOwner.settleAttempt(settlement.originalResult);
  }
  await dependencies.custody.withRevocationToken(handle, bounds, async (bytes) => {
    void bytes;
  });
  actualMaterial.close();
  await lease.release();
  // @ts-expect-error Actual material requires withJwt as well as close.
  const incompleteMaterial: GitHubAppMaterialV1 = { close() {} };
  const callbackMaterial: ProtectedSourceLease = {
    // @ts-expect-error A bare callback is not actual protected material.
    material: async () => {},
    release: async () => {},
  };
  void [incompleteMaterial, callbackMaterial];
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
  const transaction: IssuanceRetentionTransaction = dependencies.bindTransaction(state, lifetime);
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
