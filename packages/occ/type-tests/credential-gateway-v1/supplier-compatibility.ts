import type {
  AuthorizationDecision,
  AuthorizationRequest,
  IAMDriver,
  Secret,
  SecretBackendRef,
  SecretDriver,
  ServiceAccount,
  ServiceAccountCredential,
  ServiceAccountDriver,
  PluginDriver,
  PluginDriverContext,
  PluginCatalogEntry,
  Provider,
  OriginalCredentialBindingV1,
  CredentialProfileV1,
  CredentialRepositoryGrantV1,
  TokenIssuerAttemptV1,
  TokenIssuerCallBoundsV1,
  TokenIssuerV1,
  TokenRevokerV1,
  TokenMintResultV1,
  TokenRevokeResultV1,
  EphemeralTokenHandleV1,
} from "@openclaw-enterprise/contracts";
import {
  RepositoryTransactionLifetime,
  createGitHubAppTokenIssuerV1,
  createGitHubAppTokenRevokerV1,
  createGitHubAppMaterialV1,
} from "@openclaw-enterprise/occ";
import type {
  CredentialInventoryTransactionV1,
  PlatformReadView,
  PlatformUnitOfWork,
  PlatformStateStore,
  GitHubAppSelectionV1,
  GitHubRepositoryWriteSelectionV1,
  GitHubAppMaterialV1,
  GitHubAppKeyIdentityV1,
  GitHubAppTokenCustodyV1,
  GitHubAppTokenObservationV1,
  GitHubAppTokenIssuerOptionsV1,
  GitHubAppTokenRevokerOptionsV1,
} from "@openclaw-enterprise/occ";
import { transactCredentialInventoryMetadataV1 } from "../../src/credential-inventory-v1/owner.ts";

// Compile-only correspondence against actual suppliers. Every operand/callback
// is supplied by its real owner; these inert functions construct no authority.
export async function driverCorrespondence(
  iam: IAMDriver,
  request: AuthorizationRequest,
  secrets: SecretDriver,
  secret: Secret,
  accounts: ServiceAccountDriver,
  account: ServiceAccount,
  plugins: PluginDriver,
  context: PluginDriverContext,
  provider: Provider,
): Promise<void> {
  const decision: AuthorizationDecision = await iam.authorize(request);
  const reference: SecretBackendRef = await secrets.resolve(secret);
  const credential: ServiceAccountCredential = await accounts.createCredential(account);
  const catalog: readonly PluginCatalogEntry[] = await plugins.listCatalog(context);
  const providerId: string = provider.id;
  const client: unknown = provider.client;
  const drivers: Provider["drivers"] = provider.drivers;
  // @ts-expect-error Secret metadata has no plaintext-reading method.
  secret.read();
  // @ts-expect-error The selected Secret Driver exposes resolve, not read.
  secrets.read(secret);
  // @ts-expect-error Resolve returns a safe backend reference, never plaintext.
  const plaintext: Promise<string> = secrets.resolve(secret);
  void [decision, reference, credential, catalog, providerId, client, drivers, plaintext];
}

export async function stateCorrespondence(
  store: PlatformStateStore,
  read: (view: PlatformReadView) => Promise<PlatformReadView>,
  transact: (unit: PlatformUnitOfWork) => Promise<PlatformUnitOfWork>,
  lifetime: RepositoryTransactionLifetime,
  operation: () => Promise<OriginalCredentialBindingV1>,
  lookalike: Pick<RepositoryTransactionLifetime, "assertActive" | "run" | "finish" | "close">,
): Promise<void> {
  const view: PlatformReadView = await store.read(read);
  const unit: PlatformUnitOfWork = await store.transact(transact);
  lifetime.assertActive();
  const original: OriginalCredentialBindingV1 = await lifetime.run(operation);
  await lifetime.finish();
  lifetime.close();
  // @ts-expect-error A copied public shape cannot supply the real private lifetime identity.
  const foreignLifetime: RepositoryTransactionLifetime = lookalike;
  void [view, unit, original, foreignLifetime];
}

export async function inventoryCorrespondence(
  repository: CredentialInventoryTransactionV1,
  operationRef: string,
  recordRef: string,
  bindingRef: string,
  claimRef: string,
  operation: Parameters<CredentialInventoryTransactionV1["appendOperation"]>[0],
  record: Parameters<CredentialInventoryTransactionV1["insertRecord"]>[0],
  mintClaim: Parameters<CredentialInventoryTransactionV1["insertMintClaim"]>[0],
  revocationClaim: Parameters<CredentialInventoryTransactionV1["appendRevocationClaim"]>[0],
  profile: CredentialProfileV1,
  grant: CredentialRepositoryGrantV1,
  owner: Parameters<typeof transactCredentialInventoryMetadataV1>[0],
  scope: Parameters<typeof transactCredentialInventoryMetadataV1>[1],
  work: (repository: CredentialInventoryTransactionV1) => Promise<OriginalCredentialBindingV1>,
  options: Parameters<typeof transactCredentialInventoryMetadataV1>[3],
): Promise<void> {
  const commitRef: string = repository.commitRef;
  const existingOperation: typeof operation | undefined =
    await repository.findOperation(operationRef);
  await repository.appendOperation(operation);
  const existingRecord: typeof record | undefined = await repository.findRecord(recordRef);
  await repository.insertRecord(record);
  await repository.replaceRecord(record.inventoryVersion, record);
  const counts: {
    readonly installation: number;
    readonly agent: number;
    readonly unresolved: number;
  } = await repository.liveCounts();
  const live: readonly (typeof record)[] = await repository.listLive(bindingRef);
  const existingMint: typeof mintClaim | undefined = await repository.findMintClaim(recordRef);
  await repository.insertMintClaim(mintClaim);
  const existingRevocation: typeof revocationClaim | undefined =
    await repository.findRevocationClaim(claimRef);
  await repository.appendRevocationClaim(revocationClaim);
  const original: OriginalCredentialBindingV1 = await transactCredentialInventoryMetadataV1(
    owner,
    scope,
    work,
    options,
  );
  const repositoryId: string | undefined = grant.repositoryIds[0];
  // @ts-expect-error Inventory repository IDs retain canonical string representation.
  const numericRepositoryId: number | undefined = grant.repositoryIds[0];
  // @ts-expect-error Opaque installation references are not numeric GitHub IDs.
  const numericInstallationId: number = grant.providerInstallationRef;
  const { findOperation: omittedfindOperation, ...withoutfindOperation } = repository;
  // @ts-expect-error The actual inventory port requires findOperation.
  const missingfindOperation: CredentialInventoryTransactionV1 = withoutfindOperation;
  const { appendOperation: omittedappendOperation, ...withoutappendOperation } = repository;
  // @ts-expect-error The actual inventory port requires appendOperation.
  const missingappendOperation: CredentialInventoryTransactionV1 = withoutappendOperation;
  const { findRecord: omittedfindRecord, ...withoutfindRecord } = repository;
  // @ts-expect-error The actual inventory port requires findRecord.
  const missingfindRecord: CredentialInventoryTransactionV1 = withoutfindRecord;
  const { insertRecord: omittedinsertRecord, ...withoutinsertRecord } = repository;
  // @ts-expect-error The actual inventory port requires insertRecord.
  const missinginsertRecord: CredentialInventoryTransactionV1 = withoutinsertRecord;
  const { replaceRecord: omittedreplaceRecord, ...withoutreplaceRecord } = repository;
  // @ts-expect-error The actual inventory port requires replaceRecord.
  const missingreplaceRecord: CredentialInventoryTransactionV1 = withoutreplaceRecord;
  const { liveCounts: omittedliveCounts, ...withoutliveCounts } = repository;
  // @ts-expect-error The actual inventory port requires liveCounts.
  const missingliveCounts: CredentialInventoryTransactionV1 = withoutliveCounts;
  const { listLive: omittedlistLive, ...withoutlistLive } = repository;
  // @ts-expect-error The actual inventory port requires listLive.
  const missinglistLive: CredentialInventoryTransactionV1 = withoutlistLive;
  const { findMintClaim: omittedfindMintClaim, ...withoutfindMintClaim } = repository;
  // @ts-expect-error The actual inventory port requires findMintClaim.
  const missingfindMintClaim: CredentialInventoryTransactionV1 = withoutfindMintClaim;
  const { insertMintClaim: omittedinsertMintClaim, ...withoutinsertMintClaim } = repository;
  // @ts-expect-error The actual inventory port requires insertMintClaim.
  const missinginsertMintClaim: CredentialInventoryTransactionV1 = withoutinsertMintClaim;
  const { findRevocationClaim: omittedfindRevocationClaim, ...withoutfindRevocationClaim } =
    repository;
  // @ts-expect-error The actual inventory port requires findRevocationClaim.
  const missingfindRevocationClaim: CredentialInventoryTransactionV1 = withoutfindRevocationClaim;
  const { appendRevocationClaim: omittedappendRevocationClaim, ...withoutappendRevocationClaim } =
    repository;
  // @ts-expect-error The actual inventory port requires appendRevocationClaim.
  const missingappendRevocationClaim: CredentialInventoryTransactionV1 =
    withoutappendRevocationClaim;
  void [
    commitRef,
    existingOperation,
    existingRecord,
    counts,
    live,
    existingMint,
    existingRevocation,
    original,
    profile,
    repositoryId,
    numericRepositoryId,
    numericInstallationId,
  ];
}

export async function providerCorrespondence(
  issuerOptions: GitHubAppTokenIssuerOptionsV1,
  revokerOptions: GitHubAppTokenRevokerOptionsV1,
  materialOptions: Parameters<typeof createGitHubAppMaterialV1>[0],
  write: GitHubRepositoryWriteSelectionV1,
  attempt: TokenIssuerAttemptV1,
  bounds: TokenIssuerCallBoundsV1,
  handle: EphemeralTokenHandleV1,
  identity: GitHubAppKeyIdentityV1,
  custody: GitHubAppTokenCustodyV1,
  bytes: Uint8Array,
  observation: GitHubAppTokenObservationV1,
  consumeJwt: (jwt: string, assertMaterialCurrent: () => void) => Promise<void>,
  consumeToken: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  const issuer: TokenIssuerV1 = createGitHubAppTokenIssuerV1(issuerOptions);
  const revoker: TokenRevokerV1 = createGitHubAppTokenRevokerV1(revokerOptions);
  const material: GitHubAppMaterialV1 = createGitHubAppMaterialV1(materialOptions);
  const minted: TokenMintResultV1 = await issuer.mint(attempt);
  await issuer.settleAttempt(minted);
  const revoked: TokenRevokeResultV1 = await issuer.revoke(attempt, handle);
  await issuer.settleAttempt(revoked);
  const mitigation: TokenRevokeResultV1 = await revoker.revoke(attempt, handle);
  await revoker.settleAttempt(mitigation);
  await material.withJwt(identity, bounds, consumeJwt);
  material.close();
  const captured: EphemeralTokenHandleV1 = custody.capture(bytes, observation);
  await custody.withRevocationToken(captured, bounds, consumeToken);
  // @ts-expect-error The old issuer constructor remains read-only.
  createGitHubAppTokenIssuerV1({ ...issuerOptions, selection: write });
  // @ts-expect-error A write selection cannot widen the actual read supplier DTO.
  const widened: GitHubAppSelectionV1 = write;
  const stringInstallation: GitHubAppSelectionV1 = {
    ...issuerOptions.selection,
    // @ts-expect-error The actual provider selection uses numeric installation IDs.
    installationId: "202",
  };
  const stringRepository: GitHubAppSelectionV1 = {
    ...issuerOptions.selection,
    // @ts-expect-error The actual provider repository ID is numeric.
    repositories: [{ ...issuerOptions.selection.repositories[0], id: "303" }],
  };
  // @ts-expect-error Cleanup-only construction cannot mint.
  revoker.mint(attempt);
  void [widened, stringInstallation, stringRepository];
}
