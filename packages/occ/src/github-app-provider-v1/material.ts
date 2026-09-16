import type { TokenIssuerCallBoundsV1 } from "@openclaw-enterprise/contracts";
import { KeyObject, constants, sign } from "node:crypto";
import type { GitHubAppKeyIdentityV1, GitHubAppMaterialV1 } from "./types.ts";

export class GitHubAppTokenIssuerErrorV1 extends Error {
  constructor() {
    super("GitHub App token issuer unavailable.");
    this.name = "GitHubAppTokenIssuerErrorV1";
  }
}
export function assertGitHubAppSynchronousV1(check: () => void): void {
  const result: unknown = check();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new GitHubAppTokenIssuerErrorV1();
  }
}
export function assertGitHubAppBoundsV1(bounds: TokenIssuerCallBoundsV1, now: number): void {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(bounds.deadline) ||
    bounds.signal.aborted ||
    now >= bounds.deadline
  )
    throw new GitHubAppTokenIssuerErrorV1();
}
export function snapshotGitHubAppKeyIdentityV1(
  identity: GitHubAppKeyIdentityV1,
): GitHubAppKeyIdentityV1 {
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

function signGitHubAppJwt(key: KeyObject, clientId: string, now: number, expiry: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: expiry, iss: clientId }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key,
    padding: constants.RSA_PKCS1_PADDING,
  }).toString("base64url");
  return `${unsigned}.${signature}`;
}

/** A single external owner's immutable key lease, not a Secret resolver, authority
 * issuer or material cache. The owner authenticates its exact immutable version
 * before construction and in assertCurrent; no request or runtime supplies it. */
export function createGitHubAppMaterialV1(options: {
  readonly privateKey: KeyObject;
  readonly identity: GitHubAppKeyIdentityV1;
  readonly assertCurrent: () => void;
  readonly clock: () => number;
}): GitHubAppMaterialV1 {
  const identity = snapshotGitHubAppKeyIdentityV1(options.identity);
  let key: KeyObject | undefined = options.privateKey;
  const assertCurrent = options.assertCurrent;
  const clock = options.clock;
  if (
    !(key instanceof KeyObject) ||
    key.type !== "private" ||
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) > 8192 ||
    typeof assertCurrent !== "function" ||
    typeof clock !== "function"
  )
    throw new GitHubAppTokenIssuerErrorV1();
  let busy = false;
  return Object.freeze({
    async withJwt<T>(
      expected: GitHubAppKeyIdentityV1,
      bounds: TokenIssuerCallBoundsV1,
      consume: (jwt: string, assertMaterialCurrent: () => void) => Promise<T>,
    ): Promise<T> {
      if (busy) throw new GitHubAppTokenIssuerErrorV1();
      const fixed = snapshotGitHubAppKeyIdentityV1(expected);
      if (
        identity.clientId !== fixed.clientId ||
        identity.bindingRef !== fixed.bindingRef ||
        identity.immutableVersion !== fixed.immutableVersion
      )
        throw new GitHubAppTokenIssuerErrorV1();
      const assertMaterialCurrent = () => {
        assertGitHubAppBoundsV1(bounds, clock());
        assertGitHubAppSynchronousV1(assertCurrent);
        if (key === undefined) throw new GitHubAppTokenIssuerErrorV1();
        assertGitHubAppBoundsV1(bounds, clock());
      };
      busy = true;
      try {
        assertMaterialCurrent();
        const now = Math.floor(clock() / 1000);
        const expiry = Math.min(now + 300, Math.floor(bounds.deadline / 1000));
        if (expiry <= now) throw new GitHubAppTokenIssuerErrorV1();
        const jwt = signGitHubAppJwt(key!, identity.clientId, now, expiry);
        assertMaterialCurrent();
        const result = await consume(jwt, assertMaterialCurrent);
        assertMaterialCurrent();
        return result;
      } catch {
        throw new GitHubAppTokenIssuerErrorV1();
      } finally {
        busy = false;
      }
    },
    close() {
      key = undefined;
    },
  });
}
