import { request as httpsRequest } from "node:https";
import type { EphemeralTokenHandleV1 } from "@openclaw-enterprise/contracts/credential-storage-v1";
import {
  GitHubAppProviderErrorV1,
  assertGitHubAppBoundsV1,
  assertGitHubAppSynchronousV1,
  snapshotGitHubAppKeyIdentityV1,
  type GitHubAppCallBoundsV1,
  type GitHubAppKeyIdentityV1,
  type GitHubAppMaterialV1,
} from "./material.ts";

export interface GitHubAppSelectionV1 {
  readonly key: GitHubAppKeyIdentityV1;
  readonly installationId: number;
  readonly repositories: readonly { readonly id: number; readonly fullName: string }[];
  readonly permissions: Readonly<Record<string, "read" | "write">>;
}
export interface GitHubAppProviderAttemptV1 {
  readonly providerAttemptRef: string;
  readonly bounds: GitHubAppCallBoundsV1;
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

export function snapshotGitHubAppReturnedPermissionsV1(
  value: unknown,
): GitHubAppReturnedPermissionsV1 {
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
/** The fixed external custody owner captures bytes synchronously into protected
 * material. This is staging only, never proof of durable inventory recording.
 * withRevocationToken authenticates handles from that owner; no JSON token input.
 */
export interface GitHubAppTokenCustodyV1 {
  capture(bytes: Uint8Array, observation: GitHubAppTokenObservationV1): EphemeralTokenHandleV1;
  withRevocationToken<T>(
    handle: EphemeralTokenHandleV1,
    bounds: GitHubAppCallBoundsV1,
    consume: (bytes: Uint8Array) => Promise<T>,
  ): Promise<T>;
}
export type GitHubAppMintResultV1 =
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
export type GitHubAppRevokeResultV1 =
  | { readonly kind: "confirmed"; readonly providerAttemptRef: string }
  | { readonly kind: "not-dispatched"; readonly providerAttemptRef: string }
  | {
      readonly kind: "unknown";
      readonly providerAttemptRef: string;
      readonly nextAction: "reconcile-only";
    };
export type GitHubAppEndpointV1 =
  | { readonly kind: "github" }
  | { readonly kind: "local-protocol-test"; readonly origin: string; readonly ca: string };

function freezeSelection(input: GitHubAppSelectionV1): GitHubAppSelectionV1 {
  const key = snapshotGitHubAppKeyIdentityV1(input.key);
  if (
    !Number.isSafeInteger(input.installationId) ||
    input.installationId < 1 ||
    !Array.isArray(input.repositories) ||
    input.repositories.length < 1 ||
    input.repositories.length > 100
  )
    throw new GitHubAppProviderErrorV1();
  const repositories = input.repositories
    .map((repository) => {
      if (
        !Number.isSafeInteger(repository.id) ||
        repository.id < 1 ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository.fullName)
      )
        throw new GitHubAppProviderErrorV1();
      return Object.freeze({ id: repository.id, fullName: repository.fullName });
    })
    .sort((a, b) => a.id - b.id);
  if (
    new Set(repositories.map((r) => r.id)).size !== repositories.length ||
    new Set(repositories.map((r) => r.fullName.toLowerCase())).size !== repositories.length
  )
    throw new GitHubAppProviderErrorV1();
  const permissions = Object.freeze({ ...input.permissions });
  const pullRequestOnly =
    Object.keys(permissions).length === 2 &&
    permissions.metadata === "read" &&
    permissions.pull_requests === "write";
  if (
    permissions.metadata !== "read" ||
    (permissions.contents === undefined
      ? Object.keys(permissions).length !== 1 && !pullRequestOnly
      : !["read", "write"].includes(permissions.contents)) ||
    Object.entries(permissions).some(
      ([name, value]) =>
        !["metadata", "contents", "issues", "pull_requests"].includes(name) ||
        !["read", "write"].includes(value) ||
        (name === "issues" && value !== "read"),
    )
  )
    throw new GitHubAppProviderErrorV1();
  return Object.freeze({
    key,
    installationId: input.installationId,
    repositories: Object.freeze(repositories),
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
    repositories.length !== selected.repositories.length
  )
    return false;
  const entries = Object.entries(permissions);
  if (
    entries.length !== Object.keys(selected.permissions).length ||
    entries.some(([name, access]) => access !== selected.permissions[name])
  )
    return false;
  const observed = repositories.map((r: unknown) =>
    r && typeof r === "object" ? (r as Record<string, unknown>) : {},
  );
  return (
    new Set(observed.map((r) => r.id)).size === observed.length &&
    selected.repositories.every((expected) =>
      observed.some(
        (r) =>
          r.id === expected.id &&
          typeof r.full_name === "string" &&
          r.full_name.toLowerCase() === expected.fullName.toLowerCase(),
      ),
    )
  );
}
function safeAttemptRef(input: GitHubAppProviderAttemptV1): string {
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
  bounds: GitHubAppCallBoundsV1,
  clock: () => number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new GitHubAppProviderErrorV1());
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
/** Provider protocol only. Trusted startup fixes selection, key/custody and the
 * original dispatch assertion. No authority constructor, API registration or
 * native delivery callback is supplied here. Caller must durably claim the exact
 * attempt before invocation and record every outcome before any runtime release.
 */
interface GitHubAppProviderCommonOptionsV1 {
  readonly assertDispatchCurrent: (attempt: Readonly<GitHubAppProviderAttemptV1>) => void;
  readonly clock: () => number;
  readonly endpoint: GitHubAppEndpointV1;
}
interface GitHubAppProviderOptionsV1 extends GitHubAppProviderCommonOptionsV1 {
  readonly selection: GitHubAppSelectionV1;
  readonly material: GitHubAppMaterialV1;
  readonly custody: GitHubAppTokenCustodyV1;
}
interface GitHubAppRevocationOptionsV1 extends GitHubAppProviderCommonOptionsV1 {
  readonly custody: Pick<GitHubAppTokenCustodyV1, "withRevocationToken">;
}
export function createGitHubAppProviderV1(options: GitHubAppProviderOptionsV1) {
  return createGitHubAppProviderCoreV1(options);
}

/** Exact retained-token mitigation does not require the App signing key. This
 * construction has no mint method and reuses the same bounded DELETE protocol. */
export function createGitHubAppRevocationProviderV1(options: GitHubAppRevocationOptionsV1) {
  const provider = createGitHubAppProviderCoreV1(options);
  return Object.freeze({ revoke: provider.revoke, settleAttempt: provider.settleAttempt });
}

function createGitHubAppProviderCoreV1(
  options: GitHubAppProviderOptionsV1 | GitHubAppRevocationOptionsV1,
) {
  const issuance =
    "selection" in options
      ? {
          selected: freezeSelection(options.selection),
          material: options.material,
          capture: options.custody.capture.bind(options.custody),
        }
      : undefined;
  const custody = Object.freeze({
    withRevocationToken: options.custody.withRevocationToken.bind(options.custody),
  });
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
      throw new GitHubAppProviderErrorV1();
  } else if (options.endpoint.kind !== "github") throw new GitHubAppProviderErrorV1();
  let active = false;
  const settlements = new WeakMap<object, Promise<void>>();
  type Invocation = { drained: Promise<void> };
  const invoke = async <R extends GitHubAppMintResultV1 | GitHubAppRevokeResultV1>(
    operation: (invocation: Invocation) => Promise<R>,
  ): Promise<R> => {
    // An invalid or busy call owns only its own no-work result. It cannot use a
    // diagnostic reference to join or take over whichever invocation is active.
    const invocation: Invocation = { drained: Promise.resolve() };
    const result = Object.freeze(await operation(invocation));
    settlements.set(result, invocation.drained);
    return result;
  };
  function attempt(input: GitHubAppProviderAttemptV1): Readonly<GitHubAppProviderAttemptV1> {
    if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(input.providerAttemptRef))
      throw new GitHubAppProviderErrorV1();
    const now = clock();
    assertGitHubAppBoundsV1(input.bounds, now);
    if (input.bounds.deadline - now > 30000) throw new GitHubAppProviderErrorV1();
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
    call: GitHubAppProviderAttemptV1,
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
        reject(new GitHubAppProviderErrorV1());
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
        reject(new GitHubAppProviderErrorV1());
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
    async mint(
      input: GitHubAppProviderAttemptV1,
      invocation: Invocation,
    ): Promise<GitHubAppMintResultV1> {
      if (issuance === undefined)
        return { kind: "not-dispatched", providerAttemptRef: safeAttemptRef(input) };
      const { selected, material, capture } = issuance;
      let call: GitHubAppProviderAttemptV1;
      try {
        call = attempt(input);
      } catch {
        return { kind: "not-dispatched", providerAttemptRef: safeAttemptRef(input) };
      }
      if (active) return { kind: "not-dispatched", providerAttemptRef: call.providerAttemptRef };
      active = true;
      let sent = false;
      let staged: EphemeralTokenHandleV1 | undefined;
      const unknown = (): GitHubAppMintResultV1 => ({
        kind: "unknown",
        providerAttemptRef: call.providerAttemptRef,
        nextAction: "reconcile-only",
        ...(staged === undefined ? {} : { material: staged }),
      });
      let entered = false;
      let ownerStarted = false;
      let ownerClosed = false;
      let callbackWork: Promise<GitHubAppMintResultV1> | undefined;
      let callbackResult: GitHubAppMintResultV1 | undefined;
      const perform = async (
        jwt: string,
        assertMaterialCurrent: () => void,
      ): Promise<GitHubAppMintResultV1> => {
        if (typeof assertMaterialCurrent !== "function") throw new GitHubAppProviderErrorV1();
        const response = await exchange(
          "POST",
          `/app/installations/${selected.installationId}/access_tokens`,
          jwt,
          JSON.stringify({
            repository_ids: selected.repositories.map((r) => r.id),
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
            if (entered || ownerClosed) throw new GitHubAppProviderErrorV1();
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
          throw new GitHubAppProviderErrorV1();
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
      input: GitHubAppProviderAttemptV1,
      handle: EphemeralTokenHandleV1,
      invocation: Invocation,
    ): Promise<GitHubAppRevokeResultV1> {
      let call: GitHubAppProviderAttemptV1;
      try {
        call = attempt(input);
      } catch {
        return { kind: "not-dispatched", providerAttemptRef: safeAttemptRef(input) };
      }
      if (active) return { kind: "not-dispatched", providerAttemptRef: call.providerAttemptRef };
      active = true;
      let sent = false;
      let entered = false;
      let callbackResult: GitHubAppRevokeResultV1 | undefined;
      let ownerStarted = false;
      let ownerClosed = false;
      let callbackWork: Promise<GitHubAppRevokeResultV1> | undefined;
      try {
        const work = custody
          .withRevocationToken(handle, call.bounds, (bytes) => {
            if (entered || ownerClosed) throw new GitHubAppProviderErrorV1();
            entered = true;
            callbackWork = (async (): Promise<GitHubAppRevokeResultV1> => {
              const token = tokenBytes(Buffer.from(bytes).toString("utf8"));
              if (token === undefined) throw new GitHubAppProviderErrorV1();
              try {
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
          throw new GitHubAppProviderErrorV1();
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
    mint(input: GitHubAppProviderAttemptV1): Promise<GitHubAppMintResultV1> {
      return invoke((invocation) => operations.mint(input, invocation));
    },
    revoke(
      input: GitHubAppProviderAttemptV1,
      handle: EphemeralTokenHandleV1,
    ): Promise<GitHubAppRevokeResultV1> {
      return invoke((invocation) => operations.revoke(input, handle, invocation));
    },
    /** Joins this exact returned result's original owner/callback finalizer.
     * An outward timeout does not settle late capture or material postchecks.
     * This carries no bytes, new provider action or evidence of nonexecution. */
    async settleAttempt(
      originalResult: GitHubAppMintResultV1 | GitHubAppRevokeResultV1,
    ): Promise<void> {
      if (!originalResult || typeof originalResult !== "object")
        throw new GitHubAppProviderErrorV1();
      const drained = settlements.get(originalResult);
      if (drained === undefined) throw new GitHubAppProviderErrorV1();
      await drained;
    },
  });
}
