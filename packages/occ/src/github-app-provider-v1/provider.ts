import { request as httpsRequest } from "node:https";
import type {
  EphemeralTokenHandleV1,
  TokenIssuerAttemptV1,
  TokenIssuerCallBoundsV1,
  TokenIssuerV1,
  TokenMintResultV1,
  TokenRevokeResultV1,
  TokenRevokerV1,
} from "@openclaw-enterprise/contracts";
import {
  GitHubAppTokenIssuerErrorV1,
  assertGitHubAppBoundsV1,
  assertGitHubAppSynchronousV1,
  snapshotGitHubAppKeyIdentityV1,
} from "./material.ts";
import type {
  GitHubAppReturnedPermissionsV1,
  GitHubAppSelectionV1,
  GitHubAppTokenIssuerOptionsV1,
  GitHubAppTokenRevokerOptionsV1,
} from "./types.ts";

function snapshotGitHubAppReturnedPermissionsV1(value: unknown): GitHubAppReturnedPermissionsV1 {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries = Object.entries(descriptors);
    if (
      entries.length <= 64 &&
      entries.every(
        ([name, descriptor]) =>
          /^[a-z][a-z0-9_]{0,63}(?![\s\S])/.test(name) &&
          "value" in descriptor &&
          ["read", "write", "admin"].includes(descriptor.value),
      )
    )
      return Object.freeze(
        Object.fromEntries(entries.map(([name, descriptor]) => [name, descriptor.value])),
      );
  }
  return Object.freeze({ kind: "unavailable" });
}
function freezeSelection(input: GitHubAppSelectionV1): GitHubAppSelectionV1 {
  const key = snapshotGitHubAppKeyIdentityV1(input.key);
  if (
    !Number.isSafeInteger(input.installationId) ||
    input.installationId < 1 ||
    !Array.isArray(input.repositories) ||
    input.repositories.length !== 1
  )
    throw new GitHubAppTokenIssuerErrorV1();
  const repository = input.repositories[0];
  if (
    !Number.isSafeInteger(repository.id) ||
    repository.id < 1 ||
    typeof repository.fullName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository.fullName)
  )
    throw new GitHubAppTokenIssuerErrorV1();
  const permissions = Object.freeze({ ...input.permissions });
  if (
    permissions.metadata !== "read" ||
    Object.entries(permissions).some(
      ([name, value]) => !["metadata", "contents"].includes(name) || value !== "read",
    )
  )
    throw new GitHubAppTokenIssuerErrorV1();
  return Object.freeze({
    key,
    installationId: input.installationId,
    repositories: Object.freeze([
      Object.freeze({ id: repository.id, fullName: repository.fullName }),
    ] as const),
    permissions,
  });
}
function scopeMatches(value: Record<string, unknown>, selected: GitHubAppSelectionV1): boolean {
  const permissions = value.permissions;
  const repositories = value.repositories;
  if (
    !permissions ||
    typeof permissions !== "object" ||
    Array.isArray(permissions) ||
    !Array.isArray(repositories) ||
    repositories.length !== 1
  )
    return false;
  const entries = Object.entries(permissions);
  const expectedPermissions = Object.entries(selected.permissions);
  if (
    entries.length !== expectedPermissions.length ||
    entries.some(
      ([name, access]) =>
        !expectedPermissions.some(
          ([expectedName, expectedAccess]) => name === expectedName && access === expectedAccess,
        ),
    )
  )
    return false;
  const observed = repositories[0];
  const expected = selected.repositories[0];
  return (
    observed !== null &&
    typeof observed === "object" &&
    observed.id === expected.id &&
    typeof observed.full_name === "string" &&
    observed.full_name.toLowerCase() === expected.fullName.toLowerCase()
  );
}
function safeAttemptRef(input: TokenIssuerAttemptV1): string {
  try {
    const value = input.providerAttemptRef;
    return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,200}$/.test(value)
      ? value
      : "invalid-attempt";
  } catch {
    return "invalid-attempt";
  }
}
function tokenBytes(value: unknown): Buffer | undefined {
  return typeof value === "string" && /^[\x21-\x7e]{1,16384}$/.test(value)
    ? Buffer.from(value)
    : undefined;
}
async function settleOwner<T>(
  work: Promise<T>,
  bounds: TokenIssuerCallBoundsV1,
  clock: () => number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new GitHubAppTokenIssuerErrorV1());
    timer = setTimeout(abort, Math.max(1, bounds.deadline - clock()));
    bounds.signal.addEventListener("abort", abort, { once: true });
    if (bounds.signal.aborted) abort();
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    clearTimeout(timer);
    if (abort) bounds.signal.removeEventListener("abort", abort);
  }
}
// TODO(repository read integration): wire the selected issuer through production
// Work construction and the regular Agent read before landing this capability.
export function createGitHubAppTokenIssuerV1(
  options: GitHubAppTokenIssuerOptionsV1,
): TokenIssuerV1 {
  const provider = createGitHubAppTokenIssuerCoreV1(options);
  return Object.freeze({
    mint: provider.mint,
    revoke: provider.revoke,
    settleAttempt: provider.settleAttempt,
  });
}

/** Exact retained-token mitigation does not require the App signing key. This
 * construction has no mint method and reuses the same bounded DELETE protocol. */
export function createGitHubAppTokenRevokerV1(
  options: GitHubAppTokenRevokerOptionsV1,
): TokenRevokerV1 {
  const provider = createGitHubAppTokenIssuerCoreV1({
    custody: options.custody,
    clock: options.clock,
    endpoint: options.endpoint,
    assertDispatchCurrent: options.assertDispatchCurrent,
  });
  return Object.freeze({ revoke: provider.revoke, settleAttempt: provider.settleAttempt });
}

function createGitHubAppTokenIssuerCoreV1(
  options: GitHubAppTokenIssuerOptionsV1 | GitHubAppTokenRevokerOptionsV1,
) {
  const issuance =
    "selection" in options
      ? {
          selected: freezeSelection(options.selection),
          material: options.material,
          capture: options.custody.capture.bind(options.custody),
        }
      : undefined;
  const custody =
    "custody" in options
      ? Object.freeze({
          withRevocationToken: options.custody.withRevocationToken.bind(options.custody),
        })
      : undefined;
  const assertDispatchCurrent = options.assertDispatchCurrent;
  const clock = options.clock;
  let origin = new URL("https://api.github.com");
  let ca: string | undefined;
  if (options.endpoint.kind === "local-protocol-test") {
    origin = new URL(options.endpoint.origin);
    ca = options.endpoint.ca;
    if (
      origin.protocol !== "https:" ||
      origin.hostname !== "127.0.0.1" ||
      origin.pathname !== "/" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      !origin.port ||
      typeof ca !== "string" ||
      ca.length > 32768 ||
      !ca.includes("BEGIN CERTIFICATE")
    )
      throw new GitHubAppTokenIssuerErrorV1();
  } else if (options.endpoint.kind !== "github") throw new GitHubAppTokenIssuerErrorV1();
  let active = false;
  const settlements = new WeakMap<object, Promise<void>>();
  type Invocation = { drained: Promise<void> };
  const invoke = async <R extends TokenMintResultV1 | TokenRevokeResultV1>(
    operation: (invocation: Invocation) => Promise<R>,
  ): Promise<R> => {
    // An invalid or busy call owns only its own no-work result. It cannot use a
    // diagnostic reference to join or take over whichever invocation is active.
    const invocation: Invocation = { drained: Promise.resolve() };
    const result = Object.freeze(await operation(invocation));
    settlements.set(result, invocation.drained);
    return result;
  };
  function attempt(input: TokenIssuerAttemptV1): Readonly<TokenIssuerAttemptV1> {
    if (
      typeof input.providerAttemptRef !== "string" ||
      !/^[A-Za-z0-9._:/-]{1,200}$/.test(input.providerAttemptRef)
    )
      throw new GitHubAppTokenIssuerErrorV1();
    const now = clock();
    assertGitHubAppBoundsV1(input.bounds, now);
    if (input.bounds.deadline - now > 30000) throw new GitHubAppTokenIssuerErrorV1();
    return Object.freeze({
      providerAttemptRef: input.providerAttemptRef,
      bounds: Object.freeze({ signal: input.bounds.signal, deadline: input.bounds.deadline }),
    });
  }
  function exchange(
    method: "POST" | "DELETE",
    path: string,
    authorization: string,
    body: string,
    call: TokenIssuerAttemptV1,
    dispatched: () => void,
    assertMaterialCurrent?: () => void,
  ): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const remaining = call.bounds.deadline - clock();
      try {
        assertGitHubAppBoundsV1(call.bounds, clock());
        assertGitHubAppSynchronousV1(() => assertDispatchCurrent(call));
        if (assertMaterialCurrent) assertGitHubAppSynchronousV1(assertMaterialCurrent);
        assertGitHubAppBoundsV1(call.bounds, clock());
      } catch {
        reject(new GitHubAppTokenIssuerErrorV1());
        return;
      }
      // Fresh nonpooled HTTPS connection; no redirect, transport retry or ambient proxy.
      const request = httpsRequest(new URL(path, origin), {
        method,
        agent: false,
        rejectUnauthorized: true,
        ...(ca === undefined ? {} : { ca }),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${authorization}`,
          "User-Agent": "openclaw-enterprise-github-app",
          "X-GitHub-Api-Version": "2026-03-10",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Connection: "close",
        },
      });
      let settled = false;
      const chunks: Buffer[] = [];
      let length = 0;
      const discardChunks = () => {
        for (const chunk of chunks) chunk.fill(0);
        chunks.length = 0;
        length = 0;
      };
      const cleanup = () => {
        clearTimeout(timer);
        call.bounds.signal.removeEventListener("abort", cancel);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        discardChunks();
        request.destroy();
        reject(new GitHubAppTokenIssuerErrorV1());
      };
      const cancel = () => fail();
      const timer = setTimeout(fail, Math.max(1, remaining));
      call.bounds.signal.addEventListener("abort", cancel, { once: true });
      request.on("error", fail);
      request.on("response", (response) => {
        response.on("error", fail);
        response.on("aborted", fail);
        response.on("data", (chunk: Buffer) => {
          if (settled) {
            chunk.fill(0);
            return;
          }
          length += chunk.length;
          if (length > 256 * 1024) {
            chunk.fill(0);
            response.destroy();
            fail();
          } else chunks.push(chunk);
        });
        response.on("end", () => {
          if (settled) return;
          let body: Buffer;
          try {
            body = Buffer.concat(chunks);
          } catch {
            fail();
            return;
          } finally {
            discardChunks();
          }
          settled = true;
          cleanup();
          resolve({ status: response.statusCode ?? 0, body });
        });
      });
      if (call.bounds.signal.aborted) {
        fail();
        return;
      }
      // Conservatively latch before handing bytes to Node. A transport error may
      // have followed provider execution; absence of a response never permits replay.
      dispatched();
      try {
        request.end(body);
      } catch {
        fail();
      }
    });
  }
  const operations = {
    async mint(input: TokenIssuerAttemptV1, invocation: Invocation): Promise<TokenMintResultV1> {
      if (issuance === undefined)
        return { kind: "not-dispatched", providerAttemptRef: safeAttemptRef(input) };
      const { selected, material, capture } = issuance;
      let call: TokenIssuerAttemptV1;
      try {
        call = attempt(input);
      } catch {
        return { kind: "not-dispatched", providerAttemptRef: safeAttemptRef(input) };
      }
      if (active) return { kind: "not-dispatched", providerAttemptRef: call.providerAttemptRef };
      active = true;
      let sent = false;
      let staged: EphemeralTokenHandleV1 | undefined;
      const unknown = (): TokenMintResultV1 => ({
        kind: "unknown",
        providerAttemptRef: call.providerAttemptRef,
        nextAction: "reconcile-only",
        ...(staged === undefined ? {} : { material: staged }),
      });
      let entered = false;
      let ownerStarted = false;
      let ownerClosed = false;
      let callbackWork: Promise<TokenMintResultV1> | undefined;
      let callbackResult: TokenMintResultV1 | undefined;
      const perform = async (
        jwt: string,
        assertMaterialCurrent: () => void,
      ): Promise<TokenMintResultV1> => {
        if (typeof assertMaterialCurrent !== "function") throw new GitHubAppTokenIssuerErrorV1();
        const response = await exchange(
          "POST",
          `/app/installations/${selected.installationId}/access_tokens`,
          jwt,
          JSON.stringify({
            repository_ids: [selected.repositories[0].id],
            permissions: selected.permissions,
          }),
          call,
          () => {
            sent = true;
          },
          assertMaterialCurrent,
        );
        try {
          if ([401, 403, 404, 422].includes(response.status))
            return {
              kind: "rejected",
              providerAttemptRef: call.providerAttemptRef,
              status: response.status,
            } as const;
          if (response.status !== 201) return unknown();
          const value: unknown = JSON.parse(response.body.toString("utf8"));
          if (!value || typeof value !== "object" || Array.isArray(value)) return unknown();
          const packet = value as Record<string, unknown>;
          const bytes = tokenBytes(packet.token);
          if (bytes === undefined) return unknown();
          const expiry =
            typeof packet.expires_at === "string" ? Date.parse(packet.expires_at) : NaN;
          const validExpiry =
            Number.isFinite(expiry) && expiry > clock() && expiry <= clock() + 3600000;
          const scopeAccepted = scopeMatches(packet, selected) && validExpiry;
          try {
            // Even a scope-invalid response can contain a live token. Retain it
            // for exact mitigation; never return it as an accepted scoped mint.
            staged = capture(
              bytes,
              Object.freeze({
                providerAttemptRef: call.providerAttemptRef,
                expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : undefined,
                scopeAccepted,
                returnedPermissions: snapshotGitHubAppReturnedPermissionsV1(packet.permissions),
              }),
            );
          } finally {
            bytes.fill(0);
          }
          if (!scopeAccepted) return unknown();
          assertGitHubAppBoundsV1(call.bounds, clock());
          assertGitHubAppSynchronousV1(() => assertDispatchCurrent(call));
          assertGitHubAppSynchronousV1(assertMaterialCurrent);
          assertGitHubAppBoundsV1(call.bounds, clock());
          return {
            kind: "minted",
            providerAttemptRef: call.providerAttemptRef,
            material: staged,
            expiresAt: new Date(expiry).toISOString(),
          } as const;
        } finally {
          response.body.fill(0);
        }
      };
      try {
        const work = material
          .withJwt(selected.key, call.bounds, (jwt, assertMaterialCurrent) => {
            if (entered || ownerClosed) throw new GitHubAppTokenIssuerErrorV1();
            entered = true;
            callbackWork = perform(jwt, assertMaterialCurrent).then((result) => {
              callbackResult = Object.freeze(result);
              return callbackResult;
            });
            void callbackWork.catch(() => {});
            return callbackWork;
          })
          .finally(async () => {
            ownerClosed = true;
            await callbackWork?.catch(() => {});
            active = false;
          });
        invocation.drained = work.then(
          () => undefined,
          () => undefined,
        );
        ownerStarted = true;
        const result = await settleOwner(work, call.bounds, clock);
        if (!entered || callbackResult === undefined || result !== callbackResult)
          throw new GitHubAppTokenIssuerErrorV1();
        return callbackResult;
      } catch {
        if (!ownerStarted) {
          ownerClosed = true;
          await callbackWork?.catch(() => {});
        }
        return sent
          ? unknown()
          : { kind: "not-dispatched", providerAttemptRef: call.providerAttemptRef };
      } finally {
        if (!ownerStarted) {
          ownerClosed = true;
          await callbackWork?.catch(() => {});
          active = false;
        }
      }
    },
    async revoke(
      input: TokenIssuerAttemptV1,
      handle: EphemeralTokenHandleV1,
      invocation: Invocation,
    ): Promise<TokenRevokeResultV1> {
      if (!custody) return { kind: "not-dispatched", providerAttemptRef: safeAttemptRef(input) };
      let call: TokenIssuerAttemptV1;
      try {
        call = attempt(input);
      } catch {
        return { kind: "not-dispatched", providerAttemptRef: safeAttemptRef(input) };
      }
      if (active) return { kind: "not-dispatched", providerAttemptRef: call.providerAttemptRef };
      active = true;
      let sent = false;
      let entered = false;
      let callbackResult: TokenRevokeResultV1 | undefined;
      let ownerStarted = false;
      let ownerClosed = false;
      let callbackWork: Promise<TokenRevokeResultV1> | undefined;
      try {
        const work = custody
          .withRevocationToken(handle, call.bounds, (bytes) => {
            if (entered || ownerClosed) throw new GitHubAppTokenIssuerErrorV1();
            entered = true;
            callbackWork = (async (): Promise<TokenRevokeResultV1> => {
              if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 16384)
                throw new GitHubAppTokenIssuerErrorV1();
              // Own one bounded copy. Validate inside its cleanup lifetime so
              // malformed material is wiped too; custody retains its own bytes.
              const token = Buffer.from(bytes);
              try {
                if (token.some((byte) => byte < 0x21 || byte > 0x7e))
                  throw new GitHubAppTokenIssuerErrorV1();
                const response = await exchange(
                  "DELETE",
                  "/installation/token",
                  token.toString("utf8"),
                  "",
                  call,
                  () => {
                    sent = true;
                  },
                );
                response.body.fill(0);
                callbackResult = Object.freeze(
                  response.status === 204
                    ? { kind: "confirmed", providerAttemptRef: call.providerAttemptRef }
                    : {
                        kind: "unknown",
                        providerAttemptRef: call.providerAttemptRef,
                        nextAction: "reconcile-only",
                      },
                );
                return callbackResult;
              } finally {
                token.fill(0);
              }
            })();
            // Even an owner that drops this promise cannot release the provider's
            // pending-work charge before the actual HTTP callback settles.
            void callbackWork.catch(() => {});
            return callbackWork;
          })
          .finally(async () => {
            ownerClosed = true;
            await callbackWork?.catch(() => {});
            active = false;
          });
        invocation.drained = work.then(
          () => undefined,
          () => undefined,
        );
        ownerStarted = true;
        const result = await settleOwner(work, call.bounds, clock);
        if (!entered || callbackResult === undefined || result !== callbackResult)
          throw new GitHubAppTokenIssuerErrorV1();
        return callbackResult;
      } catch {
        return sent
          ? {
              kind: "unknown",
              providerAttemptRef: call.providerAttemptRef,
              nextAction: "reconcile-only",
            }
          : { kind: "not-dispatched", providerAttemptRef: call.providerAttemptRef };
      } finally {
        // A noncooperating custody owner retains the single pending-call charge
        // until its real settlement. Timeout cannot open another issuance slot.
        if (!ownerStarted) {
          ownerClosed = true;
          await callbackWork?.catch(() => {});
          active = false;
        }
      }
    },
  };
  return Object.freeze({
    mint(input: TokenIssuerAttemptV1): Promise<TokenMintResultV1> {
      return invoke((invocation) => operations.mint(input, invocation));
    },
    revoke(
      input: TokenIssuerAttemptV1,
      handle: EphemeralTokenHandleV1,
    ): Promise<TokenRevokeResultV1> {
      return invoke((invocation) => operations.revoke(input, handle, invocation));
    },
    /** Joins this exact returned result's original owner/callback finalizer.
     * An outward timeout does not settle late capture or material postchecks.
     * This carries no bytes, new provider action or evidence of nonexecution. */
    async settleAttempt(originalResult: TokenMintResultV1 | TokenRevokeResultV1): Promise<void> {
      if (!originalResult || typeof originalResult !== "object")
        throw new GitHubAppTokenIssuerErrorV1();
      const drained = settlements.get(originalResult);
      if (drained === undefined) throw new GitHubAppTokenIssuerErrorV1();
      await drained;
    },
  });
}
