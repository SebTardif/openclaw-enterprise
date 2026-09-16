import type { TokenIssuerCallBoundsV1 } from "@openclaw-enterprise/contracts";
import type { GitHubAppKeyIdentityV1 } from "./types.ts";

export class GitHubAppTokenIssuerErrorV1 extends Error {
  constructor() {
    super("GitHub App token issuer unavailable.");
    this.name = "GitHubAppTokenIssuerErrorV1";
  }
}

export function assertSynchronous(check: () => void): void {
  const result: unknown = check();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new GitHubAppTokenIssuerErrorV1();
  }
}

export function assertBounds(bounds: TokenIssuerCallBoundsV1, now: number): void {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(bounds.deadline) ||
    bounds.signal.aborted ||
    now >= bounds.deadline
  )
    throw new GitHubAppTokenIssuerErrorV1();
}

export function snapshotKeyIdentity(identity: GitHubAppKeyIdentityV1): GitHubAppKeyIdentityV1 {
  if (
    typeof identity.clientId !== "string" ||
    typeof identity.bindingRef !== "string" ||
    typeof identity.immutableVersion !== "string" ||
    !/^[A-Za-z0-9._-]{1,200}$/.test(identity.clientId) ||
    !/^[A-Za-z0-9._:/-]{1,200}$/.test(identity.bindingRef) ||
    !/^[A-Za-z0-9._:/-]{1,200}$/.test(identity.immutableVersion)
  )
    throw new GitHubAppTokenIssuerErrorV1();
  return Object.freeze({
    clientId: identity.clientId,
    bindingRef: identity.bindingRef,
    immutableVersion: identity.immutableVersion,
  });
}
