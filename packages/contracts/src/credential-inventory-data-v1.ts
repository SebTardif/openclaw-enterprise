import { types as nodeTypes } from "node:util";
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { immutableCopy, sha256Hex } from "@openclaw-enterprise/utils";
import {
  AgentId,
  InstallationId,
  NamespaceId,
  ProviderId,
  RevisionId,
  AuditId,
  ConfigurationGeneration,
  RequestId,
  SecretId,
  Timestamp,
} from "./api/common.ts";
/** Persisted credential inventory observations only. Parsing never grants authority. */
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export const CREDENTIAL_STORAGE_LIMITS_V1 = Object.freeze({
  maxRequestBytes: 65_536,
  maxResponseBytes: 262_144,
  maxJsonDepth: 32,
  maxOutstandingPerAgent: 4,
  maxOutstandingPerInstallation: 128,
  maxConcurrentIssuancePerScope: 1,
  maxCallMs: 5_000,
  revocationClaimLeaseMs: 5_000,
});
const closed = { additionalProperties: false } as const;
const ref = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
});
const digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const version = ConfigurationGeneration;
const versionedRef = Type.Object({ ref, version, digest }, closed);
const scope = Type.Object(
  { installationId: InstallationId, namespaceId: NamespaceId, agentId: AgentId },
  closed,
);

export const CredentialProfileSchemaV1 = Type.Union([
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      scope,
      profile: versionedRef,
      providerId: ProviderId,
      account: versionedRef,
      transport: versionedRef,
      kind: Type.Literal("model"),
      mode: Type.Literal("mediated"),
      modelProfile: versionedRef,
      credentialClass: Type.Enum(["workload-federation", "trusted-login", "api-key"]),
    },
    closed,
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      scope,
      profile: versionedRef,
      providerId: ProviderId,
      account: versionedRef,
      transport: versionedRef,
      kind: Type.Literal("repository"),
      mode: Type.Enum(["native", "mediated", "history-isolated"]),
      providerInstallationRef: ref,
      permissionProfile: versionedRef,
      credentialClass: Type.Literal("installation-token"),
    },
    closed,
  ),
]);
export type CredentialProfileV1 = Immutable<Static<typeof CredentialProfileSchemaV1>>;

/** A projection of the sole canonical journal's original binding, never caller authority. */
export const OriginalCredentialBindingSchemaV1 = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    scope,
    assignmentRef: Type.Object(
      {
        schemaVersion: Type.Literal(1),
        id: Type.String({
          pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        }),
      },
      closed,
    ),
    revisionId: RevisionId,
    lifecycleGeneration: version,
    runtimeGeneration: version,
    turnRef: ref,
    attemptRef: ref,
    reservationRef: ref,
    intentDigest: digest,
    conversationRef: ref,
    workspaceRef: ref,
    originalPrincipalRef: ref,
    externalIdentity: versionedRef,
    receiptRef: ref,
    logicalMessageRef: ref,
    messageContentDigest: digest,
    commonGrant: versionedRef,
    route: versionedRef,
    audience: versionedRef,
    policy: versionedRef,
    canonicalBindingDigest: digest,
    committedDispatchAt: Timestamp,
    // Explicit null means no execution-duration cap, never perpetual authority.
    // Credential leases and each current operation retain their finite bounds.
    turnNotAfter: Type.Union([Timestamp, Type.Null()]),
  },
  closed,
);
export type OriginalCredentialBindingV1 = Immutable<
  Static<typeof OriginalCredentialBindingSchemaV1>
>;
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const enumOf = <T extends string>(values: readonly T[]) => Type.Enum(values);
const expiryUnknown = object({ kind: Type.Literal("expiry-unproven") });
const returnedScope = object({
  status: enumOf(["matches-request", "mismatch", "unproved"]),
  evidenceRef: ref,
});
const evidencedExpiry = object({
  kind: Type.Literal("provider-expiry"),
  expiresAt: Timestamp,
  observedAt: Timestamp,
  evidenceRef: ref,
});
export const CredentialExpirySchemaV1 = Type.Union([expiryUnknown, evidencedExpiry]);
export type CredentialExpiryV1 = Immutable<Static<typeof CredentialExpirySchemaV1>>;

export const CredentialSecretBindingSchemaV1 = object({
  schemaVersion: Type.Literal(1),
  scope,
  bindingRef: ref,
  bindingVersion: version,
  secretId: SecretId,
  secretVersion: version,
  providerId: CredentialProfileSchemaV1.anyOf[0].properties.providerId,
  account: versionedRef,
  driverId: ref,
  backendBindingRef: ref,
});
export type CredentialSecretBindingV1 = Immutable<Static<typeof CredentialSecretBindingSchemaV1>>;
export const CredentialRepositoryGrantSchemaV1 = object({
  providerInstallationRef: ref,
  repositoryIds: Type.Array(Type.String({ pattern: "^[1-9][0-9]{0,19}$" }), {
    minItems: 1,
    maxItems: 20,
    uniqueItems: true,
  }),
  permissions: Type.Array(
    object({
      name: enumOf(["metadata", "contents", "issues", "pull_requests"]),
      access: enumOf(["read", "write"]),
    }),
    { minItems: 1, maxItems: 8, uniqueItems: true },
  ),
  permissionProfile: versionedRef,
});
export type CredentialRepositoryGrantV1 = Immutable<
  Static<typeof CredentialRepositoryGrantSchemaV1>
>;

const base = {
  schemaVersion: Type.Literal(1),
  operationRef: ref,
  requestId: RequestId,
  callerServiceRef: ref,
  scope,
  profile: CredentialProfileSchemaV1,
  originalAuditRef: AuditId,
  createdAt: Timestamp,
  deadline: Timestamp,
};
const locator = object({ issuanceOperationRef: ref, recordRef: ref, intentDigest: digest });
const existing = { ...base, target: locator, expectedInventoryVersion: version };
export const NamedCredentialUseSchemaV1 = object({
  ...base,
  method: Type.Literal("withNamedCredential"),
  purpose: Type.Literal("repository-mint"),
  original: OriginalCredentialBindingSchemaV1,
  binding: CredentialSecretBindingSchemaV1,
  issuance: locator,
  providerAttemptRef: ref,
  expectedInventoryVersion: version,
  grant: CredentialRepositoryGrantSchemaV1,
});
export type NamedCredentialUseV1 = Immutable<Static<typeof NamedCredentialUseSchemaV1>>;
export const ReserveIssuanceSchemaV1 = object({
  ...base,
  method: Type.Literal("reserveIssuance"),
  original: OriginalCredentialBindingSchemaV1,
  binding: CredentialSecretBindingSchemaV1,
  grant: CredentialRepositoryGrantSchemaV1,
  authorityVersion: version,
  invalidationVersion: version,
});
export type ReserveIssuanceV1 = Immutable<Static<typeof ReserveIssuanceSchemaV1>>;

const broaderRevocation = object({
  operationRef: ref,
  responsibilityRef: ref,
  scopeEvidenceRef: ref,
  confirmationEvidenceRef: ref,
});
const mintCommon = {
  ...existing,
  method: Type.Literal("recordMintOutcome"),
  observedAt: Timestamp,
  providerAttemptRef: ref,
};
export const MintOutcomeSchemaV1 = Type.Union([
  object({
    ...mintCommon,
    outcome: Type.Literal("accepted"),
    tokenRef: ref,
    protectedRevocationRef: ref,
    expiry: CredentialExpirySchemaV1,
    returnedScope,
    providerEvidenceRef: ref,
  }),
  object({
    ...mintCommon,
    outcome: Type.Literal("definitely-rejected"),
    noIssuanceEvidenceRef: ref,
  }),
  object({
    ...mintCommon,
    outcome: Type.Literal("unknown"),
    expiry: expiryUnknown,
    uncertaintyEvidenceRef: ref,
  }),
  object({
    ...mintCommon,
    outcome: Type.Literal("unknown-expiry-established"),
    expiry: evidencedExpiry,
  }),
  object({
    ...mintCommon,
    outcome: Type.Literal("unknown-expired"),
    expiry: evidencedExpiry,
    clockEvidenceRef: ref,
    uncertaintyMs: Type.Integer({ minimum: 0, maximum: 2000 }),
  }),
  object({
    ...mintCommon,
    outcome: Type.Literal("unknown-broader-revocation-confirmed"),
    broaderRevocation,
  }),
]);
export type MintOutcomeV1 = Immutable<Static<typeof MintOutcomeSchemaV1>>;
export const ClaimRevocationSchemaV1 = object({
  ...existing,
  method: Type.Literal("claimRevocation"),
  tokenRef: ref,
  revocationOperationRef: ref,
  expectedRevocationVersion: version,
  responsibilityRef: ref,
  previousAttempt: Type.Union([
    object({ kind: Type.Literal("none") }),
    object({
      kind: Type.Literal("reconcile"),
      attemptRef: ref,
      providerOutcome: enumOf(["pending", "unknown", "failed-terminal"]),
    }),
  ]),
});
export type ClaimRevocationV1 = Immutable<Static<typeof ClaimRevocationSchemaV1>>;
const revokeCommon = {
  ...existing,
  method: Type.Literal("recordRevocation"),
  tokenRef: ref,
  revocationOperationRef: ref,
  claimRef: ref,
  claimVersion: version,
  providerAttemptRef: ref,
  observedAt: Timestamp,
};
export const RevocationOutcomeSchemaV1 = Type.Union([
  object({ ...revokeCommon, outcome: Type.Literal("confirmed"), confirmationEvidenceRef: ref }),
  object({
    ...revokeCommon,
    outcome: enumOf(["pending", "unknown", "failed-terminal"]),
    outcomeEvidenceRef: ref,
  }),
  object({
    ...revokeCommon,
    outcome: Type.Literal("expired"),
    expiry: evidencedExpiry,
    clockEvidenceRef: ref,
    uncertaintyMs: Type.Integer({ minimum: 0, maximum: 2000 }),
  }),
]);
export type RevocationOutcomeV1 = Immutable<Static<typeof RevocationOutcomeSchemaV1>>;
const auditAccepted = object({
  state: Type.Literal("accepted"),
  eventRef: AuditId,
  commitRef: ref,
  source: Type.Literal("credential"),
  category: Type.Literal("credential"),
});
const mitigationAudit = Type.Union([
  auditAccepted,
  object({
    state: Type.Literal("obligation-recorded"),
    eventRef: AuditId,
    obligationRef: ref,
    commitRef: ref,
  }),
  object({ state: Type.Literal("evidence-missing"), eventRef: AuditId, incidentRef: ref }),
]);
export type CredentialAuditEvidenceV1 = Immutable<Static<typeof mitigationAudit>>;
const delivery = Type.Union([
  object({ state: Type.Literal("not-delivered") }),
  object({
    state: enumOf(["intent-recorded", "delivered", "unknown"]),
    deliveryRef: ref,
    deliveryOperationRef: ref,
    observedAt: Timestamp,
  }),
]);
const revocation = Type.Union([
  object({ state: Type.Literal("unrequested"), version }),
  object({
    state: enumOf(["pending", "unknown", "failed-terminal"]),
    version,
    revocationOperationRef: ref,
    attemptRef: ref,
    observedAt: Timestamp,
  }),
  object({
    state: Type.Literal("claimed"),
    version,
    revocationOperationRef: ref,
    attemptRef: ref,
    claimRef: ref,
    claimedAt: Timestamp,
    claimNotAfter: Timestamp,
    priorOutcome: enumOf(["none", "pending", "unknown", "failed-terminal"]),
  }),
  object({
    state: Type.Literal("confirmed"),
    version,
    revocationOperationRef: ref,
    attemptRef: ref,
    observedAt: Timestamp,
    confirmationEvidenceRef: ref,
  }),
  object({
    state: Type.Literal("expired"),
    version,
    observedAt: Timestamp,
    expiry: evidencedExpiry,
    clockEvidenceRef: ref,
    uncertaintyMs: Type.Integer({ minimum: 0, maximum: 2000 }),
  }),
]);
const rowBase = {
  schemaVersion: Type.Literal(1),
  target: locator,
  inventoryVersion: version,
  issuance: ReserveIssuanceSchemaV1,
  invalidationVersion: version,
  audit: mitigationAudit,
  updatedAt: Timestamp,
};
export const OutstandingTokenRecordSchemaV1 = Type.Union([
  object({
    ...rowBase,
    state: Type.Literal("reserved"),
    expiry: expiryUnknown,
    disposition: Type.Literal("scope-held"),
  }),
  object({
    ...rowBase,
    state: Type.Literal("mint-unknown"),
    expiry: CredentialExpirySchemaV1,
    providerAttemptRef: ref,
    disposition: Type.Literal("scope-held"),
  }),
  object({
    ...rowBase,
    state: Type.Literal("not-issued"),
    noIssuanceEvidenceRef: ref,
    disposition: Type.Literal("no-effect"),
  }),
  object({
    ...rowBase,
    state: Type.Literal("resolved-without-token"),
    disposition: Type.Literal("resolved-no-live-token"),
    resolution: Type.Union([
      object({
        kind: Type.Literal("expired"),
        observedAt: Timestamp,
        expiry: evidencedExpiry,
        clockEvidenceRef: ref,
        uncertaintyMs: Type.Integer({ minimum: 0, maximum: 2000 }),
      }),
      object({
        kind: Type.Literal("broader-revocation-confirmed"),
        observedAt: Timestamp,
        broaderRevocation,
      }),
    ]),
  }),
  object({
    ...rowBase,
    state: Type.Literal("outstanding"),
    tokenRef: ref,
    protectedRevocationRef: ref,
    expiry: CredentialExpirySchemaV1,
    returnedScope,
    delivery,
    revocation,
    disposition: enumOf(["current-check-required", "mitigation-only"]),
  }),
]);
export type OutstandingTokenRecordV1 = Immutable<Static<typeof OutstandingTokenRecordSchemaV1>>;
export const CredentialStorageSchemasV1 = Object.freeze({
  profile: CredentialProfileSchemaV1,
  namedUse: NamedCredentialUseSchemaV1,
  reserve: ReserveIssuanceSchemaV1,
  mintOutcome: MintOutcomeSchemaV1,
  claimRevocation: ClaimRevocationSchemaV1,
  revocationOutcome: RevocationOutcomeSchemaV1,
  record: OutstandingTokenRecordSchemaV1,
});
export type CredentialStorageSchemaNameV1 = keyof typeof CredentialStorageSchemasV1;
export type CredentialStorageValueV1<K extends CredentialStorageSchemaNameV1> = Immutable<
  Static<(typeof CredentialStorageSchemasV1)[K]>
>;

function plainJson(
  value: unknown,
  stack = new Set<object>(),
  depth = 0,
  budget = { nodes: 0 },
): boolean {
  if (depth > CREDENTIAL_STORAGE_LIMITS_V1.maxJsonDepth || ++budget.nodes > 32_768) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 1024;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || nodeTypes.isProxy(value) || stack.has(value)) return false;
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
    return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256 || (array && (value.length > 128 || keys.length !== value.length + 1)))
    return false;
  stack.add(value);
  for (const key of keys) {
    if (typeof key !== "string") return false;
    if (array && key === "length") continue;
    if (
      array &&
      (!Number.isSafeInteger(Number(key)) ||
        Number(key) < 0 ||
        Number(key) >= value.length ||
        String(Number(key)) !== key)
    )
      return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      !plainJson(descriptor.value, stack, depth + 1, budget)
    )
      return false;
  }
  stack.delete(value);
  return true;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function equal(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function semanticBytes(input: Record<string, unknown>): string {
  // Only per-call correlation/bounds can change on exact read/reconciliation.
  // Original scope, audit, service, method, operation and every CAS remain bound.
  const { requestId: _request, createdAt: _created, deadline: _deadline, ...intent } = input;
  return canonical(intent);
}
function time(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}
function duration(start: unknown, end: unknown, max: number): boolean {
  const elapsed = time(end) - time(start);
  return elapsed > 0 && elapsed <= max;
}
function validTimes(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(validTimes);
  if (!record(value)) return true;
  for (const [key, item] of Object.entries(value)) {
    if (key === "turnNotAfter" && item === null) continue;
    if (/(?:At|NotAfter)$/.test(key) || key === "deadline") {
      if (
        typeof item !== "string" ||
        !Number.isFinite(time(item)) ||
        new Date(item).toISOString() !== item
      )
        return false;
    } else if (!validTimes(item)) return false;
  }
  return true;
}
/** Checks representation and internal consistency only. Current record lookup,
 * authenticated provenance and guarded acceptance remain real owner duties.
 */
function relationships(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(relationships);
  if (!record(value)) return true;
  if (!Object.values(value).every(relationships)) return false;
  if (
    value.method !== undefined &&
    !duration(value.createdAt, value.deadline, CREDENTIAL_STORAGE_LIMITS_V1.maxCallMs)
  )
    return false;
  if (
    value.turnNotAfter !== undefined &&
    value.turnNotAfter !== null &&
    !duration(value.committedDispatchAt, value.turnNotAfter, Number.MAX_SAFE_INTEGER)
  )
    return false;
  if (value.scope !== undefined) {
    for (const key of ["original", "profile", "binding", "filter"]) {
      const nested = value[key];
      if (record(nested) && nested.scope !== undefined && !equal(value.scope, nested.scope))
        return false;
    }
  }
  if (record(value.profile)) {
    for (const key of ["binding"]) {
      const binding = value[key];
      if (
        record(binding) &&
        (binding.providerId !== value.profile.providerId ||
          !equal(binding.account, value.profile.account))
      )
        return false;
    }
    const grant = value.grant;
    if (
      record(grant) &&
      (value.profile.kind !== "repository" ||
        grant.providerInstallationRef !== value.profile.providerInstallationRef ||
        !equal(grant.permissionProfile, value.profile.permissionProfile))
    )
      return false;
  }
  if (value.repositoryIds !== undefined) {
    const ids = value.repositoryIds as string[];
    if (ids.some((id, i) => i > 0 && ids[i - 1]! >= id)) return false;
    const permissions = value.permissions as { name: string; access: string }[];
    if (
      permissions.some(
        (p, i) =>
          (p.name === "metadata" && p.access !== "read") ||
          (i > 0 && permissions[i - 1]!.name >= p.name),
      )
    )
      return false;
  }
  if (value.purpose !== undefined && record(value.profile)) {
    if ((value.purpose === "model-use") !== (value.profile.kind === "model")) return false;
  }
  if (
    value.method === "reserveIssuance" &&
    record(value.profile) &&
    value.profile.kind !== "repository"
  )
    return false;
  if (
    value.claimedAt !== undefined &&
    !duration(
      value.claimedAt,
      value.claimNotAfter,
      CREDENTIAL_STORAGE_LIMITS_V1.revocationClaimLeaseMs,
    )
  )
    return false;
  if (
    (value.outcome === "expired" ||
      value.outcome === "unknown-expired" ||
      value.state === "expired" ||
      value.kind === "expired") &&
    record(value.expiry)
  ) {
    if (
      value.expiry.kind !== "provider-expiry" ||
      time(value.observedAt) - Number(value.uncertaintyMs) < time(value.expiry.expiresAt)
    )
      return false;
  }
  if (
    value.observedAt !== undefined &&
    record(value.expiry) &&
    value.expiry.kind === "provider-expiry" &&
    time(value.expiry.observedAt) > time(value.observedAt)
  )
    return false;
  if (record(value.issuance) && record(value.target)) {
    if (
      value.target.issuanceOperationRef !== value.issuance.operationRef ||
      value.target.intentDigest !== `sha256:${sha256Hex(semanticBytes(value.issuance))}` ||
      Number(value.invalidationVersion) < Number(value.issuance.invalidationVersion)
    )
      return false;
    if (
      value.state === "outstanding" &&
      record(value.expiry) &&
      record(value.returnedScope) &&
      record(value.revocation) &&
      record(value.delivery)
    ) {
      if (
        (value.expiry.kind === "expiry-unproven" ||
          value.returnedScope.status !== "matches-request") &&
        value.disposition !== "mitigation-only"
      )
        return false;
      if (
        value.expiry.kind === "provider-expiry" &&
        value.revocation.state === "expired" &&
        record(value.revocation.expiry) &&
        value.expiry.expiresAt !== value.revocation.expiry.expiresAt
      )
        return false;
      if (value.revocation.state !== "unrequested" && value.disposition !== "mitigation-only")
        return false;
      if (
        Number(value.invalidationVersion) > Number(value.issuance.invalidationVersion) &&
        value.disposition !== "mitigation-only"
      )
        return false;
      if (
        value.delivery.state !== "not-delivered" &&
        value.issuance.profile !== undefined &&
        record(value.issuance.profile) &&
        value.issuance.profile.mode !== "native"
      )
        return false;
    }
  }
  return true;
}

export class CredentialStorageContractErrorV1 extends Error {
  constructor() {
    super("Invalid credential storage V1 value.");
    this.name = "CredentialStorageContractErrorV1";
  }
}
export function parseCredentialStorageV1<K extends CredentialStorageSchemaNameV1>(
  kind: K,
  input: unknown,
): CredentialStorageValueV1<K> {
  try {
    if (typeof kind !== "string" || !Object.hasOwn(CredentialStorageSchemasV1, kind))
      throw new CredentialStorageContractErrorV1();
    const schema: TSchema | undefined = CredentialStorageSchemasV1[kind];
    const max =
      kind === "record"
        ? CREDENTIAL_STORAGE_LIMITS_V1.maxResponseBytes
        : CREDENTIAL_STORAGE_LIMITS_V1.maxRequestBytes;
    if (
      !schema ||
      !plainJson(input) ||
      new TextEncoder().encode(JSON.stringify(input)).byteLength > max ||
      !Check(schema, input) ||
      !validTimes(input) ||
      !relationships(input)
    )
      throw new CredentialStorageContractErrorV1();
    return immutableCopy(input) as CredentialStorageValueV1<K>;
  } catch {
    throw new CredentialStorageContractErrorV1();
  }
}

export function canonicalCredentialStorageRequestV1<K extends CredentialStorageSchemaNameV1>(
  kind: K,
  input: CredentialStorageValueV1<K>,
): string {
  const value: unknown = parseCredentialStorageV1(kind, input);
  if (!record(value) || typeof value.method !== "string")
    throw new CredentialStorageContractErrorV1();
  return semanticBytes(value);
}
