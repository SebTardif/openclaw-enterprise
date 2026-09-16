import type {
  EphemeralTokenHandleV1,
  TokenIssuerV1,
  TokenRevokerV1,
} from "@openclaw-enterprise/contracts";
import {
  createGitHubAppTokenIssuerV1,
  createGitHubAppWriteTokenIssuerV1,
  createGitHubAppTokenRevokerV1,
} from "../../src/providers/token/github/index.ts";
import type {
  GitHubAppMaterialV1,
  GitHubAppTokenCustodyV1,
  GitHubAppTokenIssuerOptionsV1,
  GitHubAppTokenRevokerOptionsV1,
  GitHubRepositoryWriteSelectionV1,
} from "../../src/providers/token/github/index.ts";
import type {
  GitHubIssuedMechanismDependencies,
  GitHubProtectedSourceLease,
  ProtectedSourceLoader,
} from "../../src/providers/token/github/issuance.ts";
import type {
  Bounds,
  ProtectedCredentialSource,
} from "../../../../packages/occ/src/credential-gateway-v1/handles.ts";
import type { ProtectedSourceLease } from "../../../../packages/occ/src/credential-gateway-v1/issuance.ts";

// Controller construction uses the actual read/write/revoker suppliers and actual
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

export async function protectedSourceCorrespondence(
  loader: ProtectedSourceLoader,
  source: ProtectedCredentialSource,
  bounds: Bounds,
  custody: GitHubAppTokenCustodyV1,
  handle: EphemeralTokenHandleV1,
): Promise<void> {
  const lease: GitHubProtectedSourceLease = await loader.load(source, bounds);
  const actualMaterial: GitHubAppMaterialV1 = lease.material;
  const dependencies: GitHubIssuedMechanismDependencies = { protectedSources: loader, custody };
  const obligation: ProtectedSourceLease = lease;
  // @ts-expect-error OCC settlement cannot borrow GitHub signing material.
  obligation.material;
  await dependencies.custody.withRevocationToken(handle, bounds, async (bytes) => {
    void bytes;
  });
  actualMaterial.close();
  await lease.release();
  // @ts-expect-error Actual material requires withJwt as well as close.
  const incompleteMaterial: GitHubAppMaterialV1 = { close() {} };
  const callbackMaterial: GitHubProtectedSourceLease = {
    // @ts-expect-error A bare callback is not actual protected material.
    material: async () => {},
    release: async () => {},
  };
  void [incompleteMaterial, callbackMaterial];
}
