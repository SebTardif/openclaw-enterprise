import type {
  EphemeralTokenHandleV1,
  TokenIssuerAttemptV1,
  TokenMintResultV1,
  TokenRevokeResultV1,
} from "@openclaw-enterprise/contracts";
import { assertBounds, assertSynchronous, GitHubAppTokenIssuerErrorV1 } from "./guards.ts";
import type { OwnerRunner } from "./lifecycle.ts";
import { inspectMintResponse, notDispatched, unknownOutcome } from "./protocol.ts";
import type { MintedTokenObservation } from "./protocol.ts";
import type { GitHubExchange } from "./transport.ts";
import type {
  GitHubAppMaterialV1,
  GitHubAppSelectionV1,
  GitHubRepositoryWriteSelectionV1,
  GitHubAppTokenCustodyV1,
} from "./types.ts";

interface MintDependencies {
  readonly selection: GitHubAppSelectionV1 | GitHubRepositoryWriteSelectionV1;
  readonly material: GitHubAppMaterialV1;
  readonly capture: GitHubAppTokenCustodyV1["capture"];
  readonly exchange: GitHubExchange;
  readonly clock: () => number;
  readonly assertDispatchCurrent: (call: Readonly<TokenIssuerAttemptV1>) => void;
}

interface MintExecution {
  readonly jwt: string;
  readonly assertMaterialCurrent: () => void;
  readonly onDispatch: () => void;
  readonly capture: GitHubAppTokenCustodyV1["capture"];
}

interface RevokeDependencies {
  readonly exchange: GitHubExchange;
  readonly withRevocationToken: GitHubAppTokenCustodyV1["withRevocationToken"];
}

function captureMintToken(
  observed: MintedTokenObservation,
  call: TokenIssuerAttemptV1,
  capture: GitHubAppTokenCustodyV1["capture"],
  clock: () => number,
) {
  const expiry = observed.expiresAt;
  const validExpiry = Number.isFinite(expiry) && expiry > clock() && expiry <= clock() + 3600000;
  const scopeAccepted = observed.scopeMatches && validExpiry;
  const bytes = Buffer.from(observed.token);
  try {
    // Scope refusal cannot discard a live token's cleanup obligation.
    const material = capture(
      bytes,
      Object.freeze({
        providerAttemptRef: call.providerAttemptRef,
        expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : undefined,
        scopeAccepted,
        returnedPermissions: observed.returnedPermissions,
      }),
    );
    return { material, scopeAccepted };
  } finally {
    bytes.fill(0);
  }
}

async function mintWithJwt(
  dependencies: MintDependencies,
  call: TokenIssuerAttemptV1,
  execution: MintExecution,
): Promise<TokenMintResultV1> {
  const { selection, exchange, clock, assertDispatchCurrent } = dependencies;
  const { jwt, assertMaterialCurrent, onDispatch, capture } = execution;
  if (typeof assertMaterialCurrent !== "function") throw new GitHubAppTokenIssuerErrorV1();
  const response = await exchange(
    {
      method: "POST",
      path: `/app/installations/${selection.installationId}/access_tokens`,
      authorization: jwt,
      body: JSON.stringify({
        repository_ids: [selection.repositories[0].id],
        permissions: selection.permissions,
      }),
    },
    call,
    { onDispatch, assertMaterialCurrent },
  );
  try {
    if ([401, 403, 404, 422].includes(response.status))
      return {
        kind: "rejected",
        providerAttemptRef: call.providerAttemptRef,
        status: response.status,
      };
    if (response.status !== 201) return unknownOutcome(call.providerAttemptRef);
    const observed = inspectMintResponse(response.body, selection);
    if (observed === undefined) return unknownOutcome(call.providerAttemptRef);
    const { material, scopeAccepted } = captureMintToken(observed, call, capture, clock);
    if (!scopeAccepted) return unknownOutcome(call.providerAttemptRef, material);
    assertBounds(call.bounds, clock());
    assertSynchronous(() => assertDispatchCurrent(call));
    assertSynchronous(assertMaterialCurrent);
    assertBounds(call.bounds, clock());
    return {
      kind: "minted",
      providerAttemptRef: call.providerAttemptRef,
      material,
      expiresAt: new Date(observed.expiresAt).toISOString(),
    };
  } finally {
    response.body.fill(0);
  }
}

export async function mintToken(
  dependencies: MintDependencies,
  call: TokenIssuerAttemptV1,
  withOwner: OwnerRunner,
): Promise<TokenMintResultV1> {
  let dispatched = false;
  let capturedMaterial: EphemeralTokenHandleV1 | undefined;
  try {
    return await withOwner(
      (consume) => dependencies.material.withJwt(dependencies.selection.key, call.bounds, consume),
      (jwt: string, assertMaterialCurrent: () => void) =>
        mintWithJwt(dependencies, call, {
          jwt,
          assertMaterialCurrent,
          onDispatch: () => {
            dispatched = true;
          },
          capture: (bytes, observation) => {
            capturedMaterial = dependencies.capture(bytes, observation);
            return capturedMaterial;
          },
        }),
    );
  } catch {
    return dispatched
      ? unknownOutcome(call.providerAttemptRef, capturedMaterial)
      : notDispatched(call.providerAttemptRef);
  }
}

async function revokeWithToken(
  exchange: GitHubExchange,
  call: TokenIssuerAttemptV1,
  bytes: Uint8Array,
  onDispatch: () => void,
): Promise<TokenRevokeResultV1> {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 16384)
    throw new GitHubAppTokenIssuerErrorV1();
  // Custody retains its original bytes. This copy belongs to this request only.
  const token = Buffer.from(bytes);
  try {
    if (token.some((byte) => byte < 0x21 || byte > 0x7e)) throw new GitHubAppTokenIssuerErrorV1();
    const response = await exchange(
      {
        method: "DELETE",
        path: "/installation/token",
        authorization: token.toString("utf8"),
        body: "",
      },
      call,
      { onDispatch },
    );
    response.body.fill(0);
    return response.status === 204
      ? { kind: "confirmed", providerAttemptRef: call.providerAttemptRef }
      : unknownOutcome(call.providerAttemptRef);
  } finally {
    token.fill(0);
  }
}

export async function revokeToken(
  dependencies: RevokeDependencies,
  call: TokenIssuerAttemptV1,
  handle: EphemeralTokenHandleV1,
  withOwner: OwnerRunner,
): Promise<TokenRevokeResultV1> {
  let dispatched = false;
  try {
    return await withOwner(
      (consume) => dependencies.withRevocationToken(handle, call.bounds, consume),
      (bytes: Uint8Array) =>
        revokeWithToken(dependencies.exchange, call, bytes, () => {
          dispatched = true;
        }),
    );
  } catch {
    return dispatched
      ? unknownOutcome(call.providerAttemptRef)
      : notDispatched(call.providerAttemptRef);
  }
}
