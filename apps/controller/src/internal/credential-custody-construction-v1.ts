/** Curated trusted construction surface. Reexports perform no construction.
 * The two new factories remain declaration-only until their original source
 * implementations land; importing this facade is not runtime qualification. */
export { createOriginalGitHubIssuedMaterialOwnerV1 } from "../providers/token/github/issued-material-custody.ts";
export type { OriginalGitHubIssuedMaterialOwnerV1 } from "../providers/token/github/issued-material-custody.ts";
export { createSqlEnvelopeOwnerV1 } from "../providers/token/github/sql-envelope.ts";
export type { SqlEnvelopeDependenciesV1 } from "../providers/token/github/sql-envelope.ts";
export {
  createGitHubAppTokenIssuerV1,
  createGitHubAppTokenRevokerV1,
} from "../providers/token/github/index.ts";
export type {
  GitHubAppEndpointV1,
  GitHubAppKeyIdentityV1,
  GitHubAppMaterialV1,
  GitHubAppReturnedPermissionsV1,
  GitHubAppSelectionV1,
  GitHubAppTokenCustodyV1,
  GitHubAppTokenIssuerOptionsV1,
  GitHubAppTokenObservationV1,
  GitHubAppTokenRevokerOptionsV1,
} from "../providers/token/github/index.ts";
export { prepareProtectedGitHubCredentials } from "../composition/protected-github-credentials.ts";
export type { ProtectedGitHubCredentialSelection } from "../composition/protected-github-credentials.ts";
