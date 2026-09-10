import { Type, type Static } from "typebox";
import {
  AgentId,
  ConfigurationGeneration,
  InstallationId,
  NamespaceId,
  ProviderId,
  RequestId,
  RevisionId,
  SecretId,
  Timestamp,
} from "./api/common.ts";
import { BindRuntimeSchemaV1 } from "./runtime-authority-v1.ts";
import type { AssignmentRefV1, RuntimeAuthorityScopeV1 } from "./runtime-authority-v1.ts";
import { AccountVersionVectorSchemaV1 } from "./account-authority-v1.ts";

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

/** Canonical credential values only: no issuer, authorizer, registry or handle factory. */
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
    assignmentRef: BindRuntimeSchemaV1.properties.target.properties.assignmentRef,
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
// Reuse the existing identity/runtime reference representation, not a parallel codec.
type AssignmentMatches = OriginalCredentialBindingV1["assignmentRef"] extends AssignmentRefV1
  ? true
  : false;
type ScopeMatches = OriginalCredentialBindingV1["scope"] extends RuntimeAuthorityScopeV1
  ? true
  : false;
const referencesMatch: readonly [AssignmentMatches, ScopeMatches] = [true, true];
void referencesMatch;

export const CredentialAuthorityObservationSchemaV1 = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    original: OriginalCredentialBindingSchemaV1,
    profile: CredentialProfileSchemaV1,
    secretId: SecretId,
    secretVersion: version,
    leaseRef: ref,
    leaseVersion: version,
    leaseNotAfter: Timestamp,
    accountVersions: AccountVersionVectorSchemaV1,
    decisionRef: ref,
    authorityVersion: version,
    invalidationVersion: version,
    dispatchFenceRef: ref,
    comparedAt: Timestamp,
    startNotAfter: Timestamp,
    requestId: RequestId,
    effect: Type.Enum(["model-use", "reserve-issuance", "mint-token", "deliver-token"]),
  },
  closed,
);
export type CredentialAuthorityObservationV1 = Immutable<
  Static<typeof CredentialAuthorityObservationSchemaV1>
>;

/** Opaque, process-local and invocation-bound. No schema, constructor or serialization.
 * The real accepting owner must reject forged/foreign/replayed handles and compare
 * immutable scope/effect against authoritative state immediately before effect.
 * Brands and the diagnostic values above are not runtime authenticity checks.
 */
declare const authorityBrand: unique symbol;
declare const mitigationBrand: unique symbol;
declare const managementBrand: unique symbol;
declare const readBrand: unique symbol;
export interface CurrentCredentialAuthorityHandleV1 {
  readonly [authorityBrand]: true;
}
/** Independently preauthorized exact attenuation/revoke responsibility; no new work. */
export interface CredentialMitigationHandleV1 {
  readonly [mitigationBrand]: true;
}
/** Authenticated exact credential-management operation, separate from human turn use. */
export interface CredentialManagementHandleV1 {
  readonly [managementBrand]: true;
}
/** Authenticated exact original-service read/filter scope; cannot mint or deliver. */
export interface CredentialReadHandleV1 {
  readonly [readBrand]: true;
}

/** A current authority producer supplies these together. Callers cannot promote
 * parsed observations or successful readback into a current effect capability.
 * The accepting implementation validates correspondence on every invocation.
 */
export interface CurrentCredentialAuthorityV1 {
  readonly handle: CurrentCredentialAuthorityHandleV1;
  readonly observation: CredentialAuthorityObservationV1;
}
