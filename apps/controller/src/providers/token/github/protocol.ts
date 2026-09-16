import { types } from "node:util";
import type { EphemeralTokenHandleV1, TokenMintResultV1 } from "@openclaw-enterprise/contracts";
import { GitHubAppTokenIssuerErrorV1, snapshotKeyIdentity } from "./guards.ts";
import type {
  GitHubAppReturnedPermissionsV1,
  GitHubAppSelectionV1,
  GitHubAppKeyIdentityV1,
  GitHubRepositoryWriteSelectionV1,
} from "./types.ts";

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

/** Snapshot only own data, without evaluating accessors or proxy traps. */
function ownDataRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value))
    throw new GitHubAppTokenIssuerErrorV1();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new GitHubAppTokenIssuerErrorV1();
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
    fields.some((field) => !descriptors[field] || !("value" in descriptors[field]))
  )
    throw new GitHubAppTokenIssuerErrorV1();
  return Object.fromEntries(fields.map((field) => [field, descriptors[field]!.value]));
}
export function snapshotWriteSelection(
  input: GitHubRepositoryWriteSelectionV1,
): GitHubRepositoryWriteSelectionV1 {
  const selection = ownDataRecord(input, ["key", "installationId", "repositories", "permissions"]);
  const keyData = ownDataRecord(selection.key, ["clientId", "bindingRef", "immutableVersion"]);
  const key = snapshotKeyIdentity(keyData as unknown as GitHubAppKeyIdentityV1);
  if (Object.values(key).some((value) => /[\r\n\u2028\u2029]/.test(value)))
    throw new GitHubAppTokenIssuerErrorV1();
  const repositories = selection.repositories;
  if (
    !Number.isSafeInteger(selection.installationId) ||
    (selection.installationId as number) < 1 ||
    !repositories ||
    typeof repositories !== "object" ||
    types.isProxy(repositories) ||
    !Array.isArray(repositories) ||
    Object.getPrototypeOf(repositories) !== Array.prototype
  )
    throw new GitHubAppTokenIssuerErrorV1();
  const arrayKeys = Reflect.ownKeys(repositories);
  const arrayData = Object.getOwnPropertyDescriptors(repositories) as unknown as Record<
    string,
    PropertyDescriptor
  >;
  if (
    arrayKeys.length !== 2 ||
    !arrayKeys.includes("0") ||
    !arrayKeys.includes("length") ||
    arrayData.length?.value !== 1 ||
    !arrayData["0"] ||
    !("value" in arrayData["0"])
  )
    throw new GitHubAppTokenIssuerErrorV1();
  const repository = ownDataRecord(arrayData["0"].value, ["id", "fullName"]);
  if (
    !Number.isSafeInteger(repository.id) ||
    (repository.id as number) < 1 ||
    typeof repository.fullName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*(?![\s\S])/.test(repository.fullName)
  )
    throw new GitHubAppTokenIssuerErrorV1();
  const permissions = ownDataRecord(selection.permissions, [
    "metadata",
    "contents",
    "pull_requests",
  ]);
  if (
    permissions.metadata !== "read" ||
    permissions.contents !== "write" ||
    permissions.pull_requests !== "write"
  )
    throw new GitHubAppTokenIssuerErrorV1();
  return Object.freeze({
    key,
    installationId: selection.installationId as number,
    repositories: Object.freeze([
      Object.freeze({ id: repository.id as number, fullName: repository.fullName }),
    ] as const),
    permissions: Object.freeze({ metadata: "read", contents: "write", pull_requests: "write" }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matchesScope(
  packet: Record<string, unknown>,
  selected: GitHubAppSelectionV1 | GitHubRepositoryWriteSelectionV1,
): boolean {
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
  selected: GitHubAppSelectionV1 | GitHubRepositoryWriteSelectionV1,
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
