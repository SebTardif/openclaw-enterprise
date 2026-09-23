import type { AgentOAuthAttempt, AgentOAuthPhase } from "@openclaw-enterprise/contracts";

export const agentOAuthTransitions: Readonly<Record<AgentOAuthPhase, readonly AgentOAuthPhase[]>> =
  {
    authorizing: ["staging", "reconnect_required", "cancelled", "superseded"],
    staging: ["authenticated", "reconnect_required", "cancelled", "superseded"],
    authenticated: ["handoff_pending", "reconnect_required", "cancelled", "superseded"],
    handoff_pending: ["ready", "reconnect_required", "cancelled", "superseded"],
    ready: ["reconnect_required", "cancelled", "superseded"],
    reconnect_required: ["cancelled", "superseded"],
    cancelled: [],
    superseded: [],
  };

const failures = new Set([
  "OAUTH_FAILED",
  "OAUTH_EXPIRED",
  "OAUTH_CANCELLED",
  "CREDENTIAL_STAGING_FAILED",
  "NATIVE_STORE_MISSING",
  "NATIVE_IMPORT_FAILED",
  "MODEL_ACCESS_DENIED",
  "RUNTIME_UNSUPPORTED",
]);
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const connectionId = new RegExp(`^aoc_${uuid}$`);
const secretId = new RegExp(`^sec_${uuid}$`);
const providerConnectionId = new RegExp(`^pco_${uuid}$`);
const bounded = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  // eslint-disable-next-line no-control-regex -- Private metadata must exclude control bytes.
  !/[\x00-\x1f\x7f]/u.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/** Mirrors PostgreSQL's closed metadata shape; unknown fields must never retain secret material. */
export function validAgentOAuthAttempt(value: unknown): value is AgentOAuthAttempt {
  if (
    !exact(value, [
      "namespaceId",
      "agentId",
      "providerConnectionId",
      "connectionId",
      "generation",
      "attemptId",
      "actorId",
      "providerId",
      "methodId",
      "profileId",
      "phase",
      "deadlineAt",
      "secretDriverId",
      "secretIdentity",
      "stagedSecret",
      "storageUid",
      "failureCode",
      "createdAt",
      "updatedAt",
    ])
  ) {
    return false;
  }
  if (
    ![
      value.namespaceId,
      value.agentId,
      value.attemptId,
      value.actorId,
      value.providerId,
      value.methodId,
      value.profileId,
      value.secretDriverId,
    ].every(bounded) ||
    typeof value.connectionId !== "string" ||
    !connectionId.test(value.connectionId) ||
    typeof value.providerConnectionId !== "string" ||
    !providerConnectionId.test(value.providerConnectionId) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    typeof value.phase !== "string" ||
    !Object.hasOwn(agentOAuthTransitions, value.phase) ||
    ![value.deadlineAt, value.createdAt, value.updatedAt].every(timestamp)
  ) {
    return false;
  }
  if (
    Date.parse(value.deadlineAt as string) <= Date.parse(value.createdAt as string) ||
    Date.parse(value.updatedAt as string) < Date.parse(value.createdAt as string)
  ) {
    return false;
  }
  const identity = value.secretIdentity;
  if (
    !exact(identity, ["id", "namespaceId", "name"]) ||
    typeof identity.id !== "string" ||
    !secretId.test(identity.id) ||
    identity.namespaceId !== value.namespaceId ||
    !bounded(identity.name)
  ) {
    return false;
  }
  const secret = value.stagedSecret;
  if (
    secret !== null &&
    (!exact(secret, ["id", "namespaceId", "name", "driverId", "backendRef", "createdAt"]) ||
      secret.id !== identity.id ||
      secret.namespaceId !== identity.namespaceId ||
      secret.name !== identity.name ||
      secret.driverId !== value.secretDriverId ||
      !timestamp(secret.createdAt) ||
      !exact(secret.backendRef, ["namespaceName", "name", "key", "uid"]) ||
      !Object.values(secret.backendRef).every(bounded))
  ) {
    return false;
  }
  return (
    (value.storageUid === null || bounded(value.storageUid)) &&
    (value.failureCode === null || failures.has(value.failureCode as string)) &&
    (!["authenticated", "handoff_pending"].includes(value.phase) || secret !== null) &&
    (!["handoff_pending", "ready"].includes(value.phase) || value.storageUid !== null)
  );
}
