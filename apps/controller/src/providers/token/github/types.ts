import type {
  EphemeralTokenHandleV1,
  TokenIssuerAttemptV1,
  TokenIssuerCallBoundsV1,
} from "@openclaw-enterprise/contracts";

export interface GitHubAppKeyIdentityV1 {
  readonly clientId: string;
  readonly bindingRef: string;
  readonly immutableVersion: string;
}

export interface GitHubAppMaterialV1 {
  withJwt<T>(
    identity: GitHubAppKeyIdentityV1,
    bounds: TokenIssuerCallBoundsV1,
    consume: (jwt: string, assertMaterialCurrent: () => void) => Promise<T>,
  ): Promise<T>;
  close(): void;
}

export interface GitHubAppSelectionV1 {
  readonly key: GitHubAppKeyIdentityV1;
  readonly installationId: number;
  readonly repositories: readonly [{ readonly id: number; readonly fullName: string }];
  readonly permissions: Readonly<{ readonly metadata: "read"; readonly contents?: "read" }>;
}
/** Exact write profile; existing read-only issuer selections remain unchanged. */
export interface GitHubRepositoryWriteSelectionV1 {
  readonly key: GitHubAppSelectionV1["key"];
  readonly installationId: GitHubAppSelectionV1["installationId"];
  readonly repositories: GitHubAppSelectionV1["repositories"];
  readonly permissions: Readonly<{
    metadata: "read";
    contents: "write";
    pull_requests: "write";
  }>;
}

export interface GitHubAppTokenObservationV1 {
  readonly providerAttemptRef: string;
  readonly expiresAt: string | undefined;
  readonly scopeAccepted: boolean;
  /** Exact bounded parsed response, including broader scope. Unavailable never
   * substitutes requested permissions for a malformed provider observation. */
  readonly returnedPermissions?: GitHubAppReturnedPermissionsV1;
}
export type GitHubAppReturnedPermissionsV1 =
  Readonly<Record<string, "read" | "write" | "admin">> | Readonly<{ kind: "unavailable" }>;

/** The fixed external custody owner captures bytes synchronously into protected
 * material. This is staging only, never proof of durable inventory recording.
 * withRevocationToken authenticates handles from that owner; no JSON token input.
 */
export interface GitHubAppTokenCustodyV1 {
  capture(bytes: Uint8Array, observation: GitHubAppTokenObservationV1): EphemeralTokenHandleV1;
  withRevocationToken<T>(
    handle: EphemeralTokenHandleV1,
    bounds: TokenIssuerCallBoundsV1,
    consume: (bytes: Uint8Array) => Promise<T>,
  ): Promise<T>;
}
export type GitHubAppEndpointV1 =
  | { readonly kind: "github" }
  | { readonly kind: "local-protocol-test"; readonly origin: string; readonly ca: string };

/** Provider protocol only. Trusted startup fixes selection, key/custody and the
 * original dispatch assertion. No authority constructor, API registration or
 * native delivery callback is supplied here. Caller must durably claim the exact
 * attempt before invocation and record every outcome before any runtime release.
 */
interface GitHubAppTokenIssuerCommonOptionsV1 {
  readonly assertDispatchCurrent: (attempt: Readonly<TokenIssuerAttemptV1>) => void;
  readonly clock: () => number;
  readonly endpoint: GitHubAppEndpointV1;
}
export interface GitHubAppTokenIssuerOptionsV1 extends GitHubAppTokenIssuerCommonOptionsV1 {
  readonly selection: GitHubAppSelectionV1;
  readonly material: GitHubAppMaterialV1;
  readonly custody: GitHubAppTokenCustodyV1;
}
export interface GitHubAppTokenRevokerOptionsV1 extends GitHubAppTokenIssuerCommonOptionsV1 {
  readonly custody: Pick<GitHubAppTokenCustodyV1, "withRevocationToken">;
}
