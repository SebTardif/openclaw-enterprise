import type {
  ProtectedGitHubCryptoV1,
  ProtectedGitHubKeySelectionV1,
} from "@openclaw-enterprise/occ";
import type {
  OriginalIssuedMaterialCustodyV1,
  SqlEnvelopeOwnerV1,
} from "@openclaw-enterprise/occ/internal/credential-material-v1";

export interface SqlEnvelopeDependenciesV1 {
  readonly crypto: ProtectedGitHubCryptoV1;
  readonly retainedKeys: ReadonlyMap<string, ProtectedGitHubKeySelectionV1>;
  readonly custody: OriginalIssuedMaterialCustodyV1;
}

// TODO(original SQL envelope adapter): implement capture/seal/authenticated open
// with full canonical context, exact retained keys and original custody identity.
// Preserve github-installation-token-v1 purpose and OCEGH1 framing. A successful
// compiler check of this declaration proves no runtime crypto/custody behavior.
export declare function createSqlEnvelopeOwnerV1(
  dependencies: SqlEnvelopeDependenciesV1,
): SqlEnvelopeOwnerV1;
