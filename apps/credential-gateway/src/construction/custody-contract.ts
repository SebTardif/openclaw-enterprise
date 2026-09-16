import type { TokenIssuerV1, TokenRevokerV1 } from "@openclaw-enterprise/contracts";
import type {
  createOriginalGitHubIssuedMaterialOwnerV1,
  createSqlEnvelopeOwnerV1,
  createGitHubAppTokenIssuerV1,
  createGitHubAppTokenRevokerV1,
  prepareProtectedGitHubCredentials,
  OriginalGitHubIssuedMaterialOwnerV1,
  SqlEnvelopeDependenciesV1,
  GitHubAppMaterialV1,
  GitHubAppSelectionV1,
  GitHubAppTokenCustodyV1,
  GitHubAppTokenIssuerOptionsV1,
  GitHubAppTokenRevokerOptionsV1,
  ProtectedGitHubCredentialSelection,
} from "@openclaw-enterprise/controller/internal/credential-custody-construction-v1";
import type {
  ProtectedGitHubCryptoV1,
  ProtectedGitHubKeySelectionV1,
} from "@openclaw-enterprise/occ";
import type {
  OriginalIssuedMaterialCustodyV1,
  SqlEnvelopeOwnerV1,
} from "@openclaw-enterprise/occ/internal/credential-material-v1";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type MaterialOwner = ReturnType<typeof createOriginalGitHubIssuedMaterialOwnerV1>;
type IssuerOptions = Parameters<typeof createGitHubAppTokenIssuerV1>[0];
type RevokerOptions = Parameters<typeof createGitHubAppTokenRevokerV1>[0];
type PreparationOptions = Parameters<typeof prepareProtectedGitHubCredentials>[0];
type Prepared = Awaited<ReturnType<typeof prepareProtectedGitHubCredentials>>;

/** Inert normal-package consumer. All checks disappear from emitted JavaScript;
 * no constructor runs and no fixture object manufactures positive authority.
 * Executable construction awaits the original capture/open and envelope bodies. */
export interface CustodyConstructionCorrespondenceV1 {
  readonly materialOwner: Assert<Equal<MaterialOwner, OriginalGitHubIssuedMaterialOwnerV1>>;
  readonly materialProjection: Assert<
    Equal<MaterialOwner["material"], OriginalIssuedMaterialCustodyV1>
  >;
  readonly providerProjection: Assert<Equal<MaterialOwner["provider"], GitHubAppTokenCustodyV1>>;
  readonly issuerOptions: Assert<Equal<IssuerOptions, GitHubAppTokenIssuerOptionsV1>>;
  readonly issuerCustody: Assert<Equal<MaterialOwner["provider"], IssuerOptions["custody"]>>;
  readonly revokerOptions: Assert<Equal<RevokerOptions, GitHubAppTokenRevokerOptionsV1>>;
  readonly revokerCustody: Assert<
    Equal<Pick<MaterialOwner["provider"], "withRevocationToken">, RevokerOptions["custody"]>
  >;
  readonly envelopeDependencies: Assert<
    Equal<Parameters<typeof createSqlEnvelopeOwnerV1>[0], SqlEnvelopeDependenciesV1>
  >;
  readonly envelopeCustody: Assert<
    Equal<MaterialOwner["material"], SqlEnvelopeDependenciesV1["custody"]>
  >;
  readonly envelopes: Assert<
    Equal<ReturnType<typeof createSqlEnvelopeOwnerV1>, SqlEnvelopeOwnerV1>
  >;
  readonly issuer: Assert<Equal<ReturnType<typeof createGitHubAppTokenIssuerV1>, TokenIssuerV1>>;
  readonly revoker: Assert<Equal<ReturnType<typeof createGitHubAppTokenRevokerV1>, TokenRevokerV1>>;
  readonly preparationSelection: Assert<
    Equal<PreparationOptions["selection"], ProtectedGitHubCredentialSelection>
  >;
  readonly preparationMaterial: Assert<Equal<Prepared["material"], GitHubAppMaterialV1>>;
  readonly issuerMaterial: Assert<Equal<Prepared["material"], IssuerOptions["material"]>>;
  readonly preparationCrypto: Assert<Equal<Prepared["crypto"], ProtectedGitHubCryptoV1>>;
  readonly envelopeCrypto: Assert<Equal<Prepared["crypto"], SqlEnvelopeDependenciesV1["crypto"]>>;
  readonly preparationKey: Assert<
    Equal<ProtectedGitHubCredentialSelection["masterKey"], ProtectedGitHubKeySelectionV1>
  >;
  readonly retainedKeys: Assert<
    Equal<
      SqlEnvelopeDependenciesV1["retainedKeys"],
      ReadonlyMap<string, ProtectedGitHubKeySelectionV1>
    >
  >;
  readonly preparedKey: Assert<Equal<Prepared["key"], GitHubAppSelectionV1["key"]>>;
  readonly preparedRepository: Assert<
    Equal<Prepared["repositoryId"], GitHubAppSelectionV1["repositories"][0]["id"]>
  >;
  readonly preparedInstallation: Assert<
    Equal<Prepared["installationId"], GitHubAppSelectionV1["installationId"]>
  >;
}
