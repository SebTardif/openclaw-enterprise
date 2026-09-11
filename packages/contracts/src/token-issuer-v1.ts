import type { EphemeralTokenHandleV1 } from "./credential-storage-v1.ts";

export interface TokenIssuerCallBoundsV1 {
  readonly signal: AbortSignal;
  readonly deadline: number;
}

export interface TokenIssuerAttemptV1 {
  readonly providerAttemptRef: string;
  readonly bounds: TokenIssuerCallBoundsV1;
}

export type TokenMintResultV1 =
  | {
      readonly kind: "minted";
      readonly providerAttemptRef: string;
      readonly material: EphemeralTokenHandleV1;
      readonly expiresAt: string;
    }
  | { readonly kind: "not-dispatched"; readonly providerAttemptRef: string }
  | { readonly kind: "rejected"; readonly providerAttemptRef: string; readonly status: number }
  | {
      readonly kind: "unknown";
      readonly providerAttemptRef: string;
      readonly nextAction: "reconcile-only";
      readonly material?: EphemeralTokenHandleV1;
    };

export type TokenRevokeResultV1 =
  | { readonly kind: "confirmed"; readonly providerAttemptRef: string }
  | { readonly kind: "not-dispatched"; readonly providerAttemptRef: string }
  | {
      readonly kind: "unknown";
      readonly providerAttemptRef: string;
      readonly nextAction: "reconcile-only";
    };

/** Cleanup authenticates an original custody handle and does not need signing
 * material. Unknown effects retain the original cleanup obligation; do not replay. */
export interface TokenRevokerV1 {
  revoke(
    attempt: TokenIssuerAttemptV1,
    material: EphemeralTokenHandleV1,
  ): Promise<TokenRevokeResultV1>;
  settleAttempt(originalResult: TokenRevokeResultV1): Promise<void>;
}

/** Trusted construction fixes provider identity, scope, material and custody.
 * Requests carry only their original attempt and finite bounds, never raw keys,
 * token bytes or caller-selected permissions. The owner durably claims each
 * attempt and retains every result before permitting downstream use. */
export interface TokenIssuerV1 extends TokenRevokerV1 {
  mint(attempt: TokenIssuerAttemptV1): Promise<TokenMintResultV1>;
  /** Join the exact result's original material/custody finalizer before releasing
   * its authority use. A timeout can return while that finalizer remains pending.
   * Copies and results from another instance must be rejected. Settlement neither
   * performs another provider action nor upgrades an unknown outcome. */
  settleAttempt(originalResult: TokenMintResultV1 | TokenRevokeResultV1): Promise<void>;
}
