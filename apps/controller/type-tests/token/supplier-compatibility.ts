import type {
  TokenIssuerAttemptV1,
  TokenIssuerCallBoundsV1,
  TokenIssuerV1,
  TokenRevokerV1,
  TokenMintResultV1,
  TokenRevokeResultV1,
  EphemeralTokenHandleV1,
} from "@openclaw-enterprise/contracts";
import {
  createGitHubAppTokenIssuerV1,
  createGitHubAppTokenRevokerV1,
  createGitHubAppMaterialV1,
} from "../../src/providers/token/github/index.ts";
import type {
  GitHubAppSelectionV1,
  GitHubRepositoryWriteSelectionV1,
  GitHubAppMaterialV1,
  GitHubAppKeyIdentityV1,
  GitHubAppTokenCustodyV1,
  GitHubAppTokenObservationV1,
  GitHubAppTokenIssuerOptionsV1,
  GitHubAppTokenRevokerOptionsV1,
} from "../../src/providers/token/github/index.ts";

// Compile-only correspondence against the controller-owned provider and contracts.
// Operands come from their real owners; this inert function constructs no authority.
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
