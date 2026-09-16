import type {
  Bounds,
  ProtectedCredentialSource,
} from "../../../../../../packages/occ/src/credential-gateway-v1/handles.ts";
import type { ProtectedSourceLease } from "../../../../../../packages/occ/src/credential-gateway-v1/issuance.ts";
import type { GitHubAppMaterialV1, GitHubAppTokenCustodyV1 } from "./types.ts";

/** GitHub construction retains the actual material owner while OCC settlement
 * retains only the source-release obligation. Release drains original settlement
 * and late finalizers; it proves neither revocation nor durable retention. */
export interface GitHubProtectedSourceLease extends ProtectedSourceLease {
  readonly material: GitHubAppMaterialV1;
}

/** Trusted source owner supplies actual material, identity, clock and currentness.
 * This is an internal dependency, never an Agent/API Secret-reading callback. */
export interface ProtectedSourceLoader {
  load(source: ProtectedCredentialSource, bounds: Bounds): Promise<GitHubProtectedSourceLease>;
}

export interface GitHubIssuedMechanismDependencies {
  readonly protectedSources: ProtectedSourceLoader;
  readonly custody: GitHubAppTokenCustodyV1;
}
