import type { EphemeralTokenHandleV1, TokenMintResultV1 } from "@openclaw-enterprise/contracts";
import { GitHubAppTokenIssuerErrorV1, snapshotKeyIdentity } from "./guards.ts";
import type { GitHubAppReturnedPermissionsV1, GitHubAppSelectionV1 } from "./types.ts";

export interface MintedTokenObservation {
  readonly token: string;
  readonly expiresAt: number;
  readonly scopeMatches: boolean;
  readonly returnedPermissions: GitHubAppReturnedPermissionsV1;
}

export function snapshotSelection(input: GitHubAppSelectionV1): GitHubAppSelectionV1 {
  const key = snapshotKeyIdentity(input.key);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matchesScope(packet: Record<string, unknown>, selected: GitHubAppSelectionV1): boolean {
  if (
    !isRecord(packet.permissions) ||
    !Array.isArray(packet.repositories) ||
    packet.repositories.length !== 1
  )
    return false;
  const actualPermissions = Object.entries(packet.permissions);
  const expectedPermissions = Object.entries(selected.permissions);
  if (
    actualPermissions.length !== expectedPermissions.length ||
    actualPermissions.some(
      ([name, access]) =>
        !expectedPermissions.some(
          ([expectedName, expectedAccess]) => name === expectedName && access === expectedAccess,
        ),
    )
  )
    return false;
  const actual = packet.repositories[0];
  const expected = selected.repositories[0];
  return (
    isRecord(actual) &&
    actual.id === expected.id &&
    typeof actual.full_name === "string" &&
    actual.full_name.toLowerCase() === expected.fullName.toLowerCase()
  );
}

function readPermissions(value: unknown): GitHubAppReturnedPermissionsV1 {
  const unavailable = Object.freeze({ kind: "unavailable" } as const);
  if (!isRecord(value)) return unavailable;
  const entries = Object.entries(value);
  if (entries.length > 64) return unavailable;
  const permissions: Record<string, "read" | "write" | "admin"> = {};
  for (const [name, access] of entries) {
    if (
      !/^[a-z][a-z0-9_]{0,63}(?![\s\S])/.test(name) ||
      (access !== "read" && access !== "write" && access !== "admin")
    )
      return unavailable;
    permissions[name] = access;
  }
  return Object.freeze(permissions);
}

/** Decode observations, not authorization. A usable token must reach custody
 * even when the returned scope or expiry will be refused. */
export function inspectMintResponse(
  body: Buffer,
  selected: GitHubAppSelectionV1,
): MintedTokenObservation | undefined {
  const packet: unknown = JSON.parse(body.toString("utf8"));
  if (
    !isRecord(packet) ||
    typeof packet.token !== "string" ||
    !/^[\x21-\x7e]{1,16384}$/.test(packet.token)
  )
    return undefined;
  return {
    token: packet.token,
    expiresAt: typeof packet.expires_at === "string" ? Date.parse(packet.expires_at) : NaN,
    scopeMatches: matchesScope(packet, selected),
    returnedPermissions: readPermissions(packet.permissions),
  };
}

export function notDispatched(
  providerAttemptRef: string,
): Extract<TokenMintResultV1, { kind: "not-dispatched" }> {
  return { kind: "not-dispatched", providerAttemptRef };
}

export function unknownOutcome(
  providerAttemptRef: string,
  material?: EphemeralTokenHandleV1,
): Extract<TokenMintResultV1, { kind: "unknown" }> {
  return {
    kind: "unknown",
    providerAttemptRef,
    nextAction: "reconcile-only",
    ...(material === undefined ? {} : { material }),
  };
}
