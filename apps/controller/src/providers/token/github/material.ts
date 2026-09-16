import type { TokenIssuerCallBoundsV1 } from "@openclaw-enterprise/contracts";
import { KeyObject, constants, sign } from "node:crypto";
import type { GitHubAppKeyIdentityV1, GitHubAppMaterialV1 } from "./types.ts";
import {
  assertBounds,
  assertSynchronous,
  snapshotKeyIdentity,
  GitHubAppTokenIssuerErrorV1,
} from "./guards.ts";

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
  const identity = snapshotKeyIdentity(options.identity);
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
      const fixed = snapshotKeyIdentity(expected);
      if (
        identity.clientId !== fixed.clientId ||
        identity.bindingRef !== fixed.bindingRef ||
        identity.immutableVersion !== fixed.immutableVersion
      )
        throw new GitHubAppTokenIssuerErrorV1();
      const assertMaterialCurrent = () => {
        assertBounds(bounds, clock());
        assertSynchronous(assertCurrent);
        if (key === undefined) throw new GitHubAppTokenIssuerErrorV1();
        assertBounds(bounds, clock());
      };
      busy = true;
      try {
        assertMaterialCurrent();
        const now = Math.floor(clock() / 1000);
        const expiry = Math.min(now + 300, Math.floor(bounds.deadline / 1000));
        if (expiry <= now || key === undefined) throw new GitHubAppTokenIssuerErrorV1();
        const jwt = signGitHubAppJwt(key, identity.clientId, now, expiry);
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
