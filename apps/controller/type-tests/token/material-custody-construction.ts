import type {
  EphemeralTokenHandleV1,
  TokenIssuerV1,
  TokenRevokerV1,
} from "@openclaw-enterprise/contracts";
import type {
  ProtectedGitHubCryptoV1,
  ProtectedGitHubKeySelectionV1,
} from "@openclaw-enterprise/occ";
import type {
  Bounds,
  IssuedMaterialContextV1,
  OriginalIssuedMaterialCustodyV1,
  SealedMaterial,
  SqlEnvelopeOwnerV1,
} from "@openclaw-enterprise/occ/internal/credential-material-v1";
import type {
  createOriginalGitHubIssuedMaterialOwnerV1,
  createSqlEnvelopeOwnerV1,
  createGitHubAppTokenIssuerV1,
  createGitHubAppTokenRevokerV1,
  prepareProtectedGitHubCredentials,
  OriginalGitHubIssuedMaterialOwnerV1,
  SqlEnvelopeDependenciesV1,
  GitHubAppTokenCustodyV1,
  GitHubAppTokenIssuerOptionsV1,
  GitHubAppTokenRevokerOptionsV1,
  ProtectedGitHubCredentialSelection,
} from "@openclaw-enterprise/controller/internal/credential-custody-construction-v1";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type OwnerOptions = Assert<
  Equal<
    Parameters<typeof createOriginalGitHubIssuedMaterialOwnerV1>[0],
    {
      readonly clock: () => number;
      readonly maxHandles: number;
      readonly maxRetainedBytes: number;
    }
  >
>;
export type OwnerResult = Assert<
  Equal<
    ReturnType<typeof createOriginalGitHubIssuedMaterialOwnerV1>,
    OriginalGitHubIssuedMaterialOwnerV1
  >
>;
export type OwnerClose = Assert<
  Equal<OriginalGitHubIssuedMaterialOwnerV1["close"], (bounds: Bounds) => Promise<void>>
>;
export type OwnerMaterial = Assert<
  Equal<OriginalGitHubIssuedMaterialOwnerV1["material"], OriginalIssuedMaterialCustodyV1>
>;
export type OwnerProvider = Assert<
  Equal<OriginalGitHubIssuedMaterialOwnerV1["provider"], GitHubAppTokenCustodyV1>
>;
export type EnvelopeOptions = Assert<
  Equal<Parameters<typeof createSqlEnvelopeOwnerV1>[0], SqlEnvelopeDependenciesV1>
>;
export type EnvelopeResult = Assert<
  Equal<ReturnType<typeof createSqlEnvelopeOwnerV1>, SqlEnvelopeOwnerV1>
>;
export type EnvelopeCrypto = Assert<
  Equal<SqlEnvelopeDependenciesV1["crypto"], ProtectedGitHubCryptoV1>
>;
export type RetainedKeys = Assert<
  Equal<
    SqlEnvelopeDependenciesV1["retainedKeys"],
    ReadonlyMap<string, ProtectedGitHubKeySelectionV1>
  >
>;
export type IssuerOptions = Assert<
  Equal<Parameters<typeof createGitHubAppTokenIssuerV1>[0], GitHubAppTokenIssuerOptionsV1>
>;
export type IssuerResult = Assert<
  Equal<ReturnType<typeof createGitHubAppTokenIssuerV1>, TokenIssuerV1>
>;
export type RevokerOptions = Assert<
  Equal<Parameters<typeof createGitHubAppTokenRevokerV1>[0], GitHubAppTokenRevokerOptionsV1>
>;
export type RevokerResult = Assert<
  Equal<ReturnType<typeof createGitHubAppTokenRevokerV1>, TokenRevokerV1>
>;
export type PreparationSelection = Assert<
  Equal<
    Parameters<typeof prepareProtectedGitHubCredentials>[0]["selection"],
    ProtectedGitHubCredentialSelection
  >
>;

declare const foreignBrand: unique symbol;
type ForeignToken = { readonly [foreignBrand]: true };

// Declared constructor operands are checked without invoking any factory. These
// checks exercise actual supplier projections, never fixture authority.
export async function producerProjectionCorrespondence(
  owner: OriginalGitHubIssuedMaterialOwnerV1,
  dependencies: SqlEnvelopeDependenciesV1,
  issuer: GitHubAppTokenIssuerOptionsV1,
  revoker: GitHubAppTokenRevokerOptionsV1,
  context: IssuedMaterialContextV1,
  envelopes: SqlEnvelopeOwnerV1,
  bounds: Bounds,
  original: EphemeralTokenHandleV1,
  foreign: ForeignToken,
): Promise<void> {
  ({ ...issuer, custody: owner.provider }) satisfies GitHubAppTokenIssuerOptionsV1;
  ({ ...revoker, custody: owner.provider }) satisfies GitHubAppTokenRevokerOptionsV1;
  ({ ...dependencies, custody: owner.material }) satisfies SqlEnvelopeDependenciesV1;
  const seal: SealedMaterial = await envelopes.sealIssuedMaterialV1(context, original, bounds);
  (await envelopes.withIssuedMaterialV1(context, seal, bounds, (material) =>
    owner.material.withCaptured(material, bounds, async (bytes) => bytes.byteLength),
  )) satisfies number;
  // @ts-expect-error Revocation-only provider access is not serialization custody.
  ({ ...dependencies, custody: owner.provider }) satisfies SqlEnvelopeDependenciesV1;
  // @ts-expect-error Serialization access is not provider capture/revocation.
  ({ ...issuer, custody: owner.material }) satisfies GitHubAppTokenIssuerOptionsV1;
  // @ts-expect-error Original custody does not accept a foreign nominal handle.
  owner.material.withCaptured(foreign, bounds, async (bytes) => bytes.byteLength);
  // @ts-expect-error Close requires the original bounded lifecycle operand.
  owner.close();
  ({
    ...dependencies,
    // @ts-expect-error A serialized key digest is not an original key selection.
    retainedKeys: new Map([[context.keyId, context.keyDigest]]),
  }) satisfies SqlEnvelopeDependenciesV1;
}
