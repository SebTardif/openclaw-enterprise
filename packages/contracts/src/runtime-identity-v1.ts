import { Type, type Static, type TProperties } from "typebox";
import { Check } from "typebox/value";
import {
  RUNTIME_AUTHORITY_LIMITS_V1,
  RuntimeAssignmentRecordSchemaV1,
  type AuthorityCallV1,
  type ResolveAssignmentRequestV1,
  type ResolveAssignmentResultV1,
  type RuntimeAssignmentRecordV1,
  type RuntimeAssignmentTargetV1,
  type RuntimeAuthorityCallBoundsV1,
} from "./runtime-authority-v1.ts";

/** Local definitions and diagnostic decoding only; there is no authority issuer here. */
export const RUNTIME_IDENTITY_DECODING_LIMITS_V1 = Object.freeze({
  maxBytes: 4_096,
  maxDepth: 8,
  maxNodes: 256,
  maxStringBytes: 2_048,
});

type ReadonlyValue<T> = T extends readonly (infer V)[]
  ? readonly ReadonlyValue<V>[]
  : T extends object
    ? { readonly [K in keyof T]: ReadonlyValue<T[K]> }
    : T;
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const ref = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:/-]+$" });
const timestamp = Type.String({
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
});
const assignmentRef = object({
  schemaVersion: Type.Literal(1),
  id: RuntimeAssignmentRecordSchemaV1.properties.allocation.properties.assignmentRef,
});

/** A bounded diagnostic projection, including nontransferable correlation labels.
 * Subject syntax is not X.509/SPIFFE verification or trusted registration resolution.
 * Only the maintained native verifier and admitted exact registration can establish that.
 */
export const RuntimeWorkloadDiagnosticSchemaV1 = object({
  schemaVersion: Type.Literal(1),
  spiffeId: Type.String({ minLength: 1, maxLength: 2_048 }),
  component: RuntimeAssignmentRecordSchemaV1.properties.allocation.properties.component,
  assignmentRef,
  bindingVersion: Type.Literal(1),
  identityProfileRef: ref,
  registrationId: ref,
  registrationVersion: positive,
  bundleSetVersion: positive,
  verifiedAt: timestamp,
  expiresAt: timestamp,
  peerEvidenceRef: ref,
  recipientRef: ref,
  connectionRef: ref,
});
export type RuntimeWorkloadDiagnosticV1 = ReadonlyValue<
  Static<typeof RuntimeWorkloadDiagnosticSchemaV1>
>;

/** Resolved, operator-admitted local limits; all fields are required, with no defaults.
 * Parsing fixture values does not admit a profile or measure a revocation guarantee.
 * The current native servicepeer/bridge keep their separately selected stricter bounds.
 */
export const RuntimeIdentityLimitsSchemaV1 = object({
  schemaVersion: Type.Literal(1),
  limitsProfileRef: ref,
  svidLifetimeMs: positive,
  renewBeforeExpiryMs: positive,
  renewalRetryBudgetMs: positive,
  runtimeEvidenceMaxAgeMs: Type.Integer({
    minimum: 1,
    maximum: RUNTIME_AUTHORITY_LIMITS_V1.observationMaxAgeMs,
  }),
  policyEvidenceMaxAgeMs: Type.Integer({
    minimum: 1,
    maximum: RUNTIME_AUTHORITY_LIMITS_V1.observationMaxAgeMs,
  }),
  identityEvidenceMaxAgeMs: Type.Integer({
    minimum: 1,
    maximum: RUNTIME_AUTHORITY_LIMITS_V1.observationMaxAgeMs,
  }),
  identityHealthMaxAgeMs: positive,
  identityHealthPollMs: positive,
  assignmentDeadlineMs: Type.Integer({
    minimum: 1,
    maximum: RUNTIME_AUTHORITY_LIMITS_V1.lookupMaxMs,
  }),
  policyDeadlineMs: Type.Integer({ minimum: 1, maximum: RUNTIME_AUTHORITY_LIMITS_V1.lookupMaxMs }),
  clockSkewAllowanceMs: Type.Integer({
    minimum: 0,
    maximum: RUNTIME_AUTHORITY_LIMITS_V1.clockUncertaintyMaxMs,
  }),
  connectionMaxAgeMs: positive,
  streamRecheckMs: Type.Integer({
    minimum: 1,
    maximum: RUNTIME_AUTHORITY_LIMITS_V1.activeRecheckMaxMs,
  }),
  streamCloseDeadlineMs: positive,
  bundleUpdateMaxAgeMs: positive,
  bundleOverlapMs: positive,
  bundleRollbackPolicyRef: ref,
  disableBudgetMs: positive,
  invalidationProtocolRef: ref,
  effectFenceProfileRef: ref,
  requestBoundsRef: ref,
  connectionBoundsRef: ref,
  registrationChurnBoundsRef: ref,
  maxFrameBytes: positive,
  maxBufferedBytes: positive,
  maxBufferedMessages: positive,
  maxConnections: positive,
  maxStreamsPerConnection: positive,
  maxPendingChecks: positive,
});
export type RuntimeIdentityLimitsV1 = ReadonlyValue<Static<typeof RuntimeIdentityLimitsSchemaV1>>;

export const RUNTIME_IDENTITY_VERIFICATION_FAILURES_V1 = Object.freeze([
  "peer-invalid",
  "peer-untrusted",
  "peer-expired",
  "peer-mismatch",
  "binding-mismatch",
  "component-denied",
  "evidence-stale",
  "observation-invalid",
  "profile-authority-denied",
  "profile-reference-invalid",
  "profile-invalid",
  "profile-unresolved",
  "version-unsupported",
  "capability-missing",
  "bundle-invalid",
  "bundle-rollback",
  "lookup-unavailable",
] as const);
export const RUNTIME_IDENTITY_TRANSPORT_FAILURES_V1 = Object.freeze([
  "cancelled",
  "deadline-exceeded",
  "connection-closed",
  "transport-unavailable",
  "protocol-invalid",
  "buffer-exhausted",
  "cleanup-unsettled",
] as const);
/** Internal fixed-code observations. Unauthenticated recipients receive generic failure,
 * not this internal reason selection or scoped registration/peer diagnostics.
 */
export const RuntimeIdentityFailureSchemaV1 = Type.Union([
  object({
    schemaVersion: Type.Literal(1),
    kind: Type.Literal("verification-failure"),
    reasonCode: Type.Enum(RUNTIME_IDENTITY_VERIFICATION_FAILURES_V1),
    requestRef: ref,
  }),
  object({
    schemaVersion: Type.Literal(1),
    kind: Type.Literal("transport-failure"),
    reasonCode: Type.Enum(RUNTIME_IDENTITY_TRANSPORT_FAILURES_V1),
    requestRef: ref,
  }),
]);
export type RuntimeIdentityFailureV1 = ReadonlyValue<Static<typeof RuntimeIdentityFailureSchemaV1>>;

declare const verifiedWorkload: unique symbol;
declare const workloadTransport: unique symbol;
declare const identityStream: unique symbol;

/** Process-local verifier product. No exported constructor, brand symbol or JSON codec.
 * Runtime ownership checks, not a structural brand check, reject copies/foreign handles.
 * This is neither a service identity nor current purpose/human/turn/resource permission.
 */
export interface VerifiedWorkloadV1 extends RuntimeWorkloadDiagnosticV1 {
  readonly [verifiedWorkload]: true;
  readonly transportBinding: RuntimeWorkloadTransportBindingV1;
}
export interface RuntimeWorkloadTransportBindingV1 {
  readonly [workloadTransport]: true;
}

/** Supplied by the accepting service from trusted configuration, not request destination data. */
export interface RuntimeWorkloadExpectationV1 {
  readonly target: ReadonlyValue<RuntimeAssignmentTargetV1>;
  readonly expectedPeerSPIFFEId: string;
  readonly recipientRef: string;
  readonly identityProfileRef: string;
  readonly limits: RuntimeIdentityLimitsV1;
}

/** Trusted registration reader output is an observation in the installed producer's custody.
 * Parsing/replaying this structural record cannot create VerifiedWorkloadV1.
 * The full authoritative bound assignment is reused; no alternate assignment store is added.
 */
export interface RuntimeRegistrationObservationV1 {
  readonly assignment: ReadonlyValue<RuntimeAssignmentRecordV1>;
  readonly spiffeId: string;
  readonly registrationId: string;
  readonly registrationVersion: number;
  readonly identityProfileRef: string;
  readonly bundleSetVersion: number;
  readonly sourceEvidenceRef: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export type RuntimeRegistrationResultV1 =
  | { readonly kind: "observed"; readonly observation: RuntimeRegistrationObservationV1 }
  | RuntimeIdentityFailureV1;

/** Required actual dependency. Resolve only from the same owned, freshly authenticated
 * connection and current trusted registration/assignment records. A subject/header/Peer
 * diagnostic alone is insufficient. Deny ambiguity, withdrawal, rollback and stale sources.
 * Identity registration and runtime binding producers must supply this reader before live use.
 */
export interface TrustedRuntimeRegistrationReaderV1<OwnedConnection> {
  resolve(
    connection: OwnedConnection,
    expected: RuntimeWorkloadExpectationV1,
    call: RuntimeAuthorityCallBoundsV1,
  ): Promise<RuntimeRegistrationResultV1>;
}
export type RuntimeWorkloadVerificationResultV1 =
  { readonly kind: "verified"; readonly proof: VerifiedWorkloadV1 } | RuntimeIdentityFailureV1;

/** Required adapter, not an implementation. verify creates local proof only after maintained
 * X.509-SVID verification AND exact trusted registration/immutable bound-instance checks.
 * inspect returns the same owned proof only after freshly checking recipient/connection incarnation, certificate/source/trust,
 * registration/profile/bundle currentness and original expiry; it never renews proof by delivery.
 * A retired assignment can still authenticate; current-purpose checks decide its permitted use.
 * Existing servicepeer owns native TLS, source rechecks and closure. Do not add a TLS supervisor.
 */
export interface RuntimeWorkloadVerifierV1<OwnedConnection> {
  verify(
    connection: OwnedConnection,
    expected: RuntimeWorkloadExpectationV1,
    call: RuntimeAuthorityCallBoundsV1,
  ): Promise<RuntimeWorkloadVerificationResultV1>;
  inspect(
    proof: VerifiedWorkloadV1,
    call: RuntimeAuthorityCallBoundsV1,
  ): Promise<RuntimeWorkloadVerificationResultV1>;
}

/** A fresh, purpose-bound observation, never an effect permit. The seven existing authority
 * variants remain intact, including scope-hidden and lookup-unavailable. No DTO copy/alias
 * converts a readiness result to serving or restores saved grants from a restore observation.
 */
export type RuntimeIdentityCheckResultV1 =
  | { readonly kind: "resolved"; readonly observation: ResolveAssignmentResultV1 }
  | RuntimeIdentityFailureV1;
export const RUNTIME_IDENTITY_INVALIDATIONS_V1 = Object.freeze([
  "authority-changed",
  "identity-changed",
  "watch-lost",
  "watch-gap",
  "evidence-stale",
  "deadline-exceeded",
  "cancelled",
  "buffer-exhausted",
  "connection-closed",
] as const);
export type RuntimeIdentityInvalidationV1 = (typeof RUNTIME_IDENTITY_INVALIDATIONS_V1)[number];
export type RuntimeIdentityCloseResultV1 =
  { readonly kind: "closed" } | Extract<RuntimeIdentityFailureV1, { kind: "transport-failure" }>;

/** Provider-created stream binding, not a wire message or callback supplied by a client.
 * It captures the original exact purpose/request/recipient/attempt and connection incarnation.
 * check awaits fresh verifier and authority observations within the original monotonic budget;
 * every privileged dispatch and authority-sensitive delivery needs its own current check.
 * A full/paused data queue cannot delay invalidation. Buffered data cannot be emitted following
 * invalidation. Reject late positives after an await, cancellation, reconnect or epoch change.
 */
export interface RuntimeIdentityStreamV1 {
  readonly [identityStream]: true;
  readonly signal: AbortSignal;
  check(call: AuthorityCallV1): Promise<RuntimeIdentityCheckResultV1>;
  /** Synchronously deny/abort before awaited cleanup. Terminal; refresh cannot reopen it. */
  invalidate(reason: RuntimeIdentityInvalidationV1): void;
  /** close itself synchronously denies/aborts before its first await; no preceding invalidate
   * is required. Idempotently join owned requests/subscriptions within streamCloseDeadlineMs.
   * Return fixed cleanup-unsettled on unjoined work and stay terminal. Retain ownership and
   * capacity for unfinished work until actual settlement; a timeout never releases its slot.
   * Release only settled owned stream bindings. Borrowed Source/connection closure stays with
   * its actual owner. No effect rollback or physical-stop claim.
   */
  close(): Promise<RuntimeIdentityCloseResultV1>;
}
export type RuntimeIdentityOpenStreamResultV1 =
  | { readonly kind: "opened"; readonly stream: RuntimeIdentityStreamV1 }
  | { readonly kind: "not-opened"; readonly observation: ResolveAssignmentResultV1 }
  | RuntimeIdentityFailureV1;

/** Required current-purpose adapter, not an evaluator supplied by this module.
 * Compose actual verifier + RuntimeAssignmentAuthorityV1.resolve, never a cached allow.
 * Retain the entire original request and actual call context, recipient and transport custody;
 * reusing a proof/context with another operation must not lend the first operation's authority.
 * The 3s lookup ceiling and any stricter original/profile deadline are not renewed after awaits.
 * Human/session/common audience/resource/turn/attempt checks and an actual effect fence remain
 * separate at each consumer. An observed current result alone never executes an operation.
 * Independent registration/cleanup/preparation services use the existing authority with their
 * own real service contexts; they do NOT require the target's SVID/proof or a live original actor.
 */
export interface RuntimeIdentityPurposeGuardV1 {
  check(
    proof: VerifiedWorkloadV1,
    request: ResolveAssignmentRequestV1,
    call: AuthorityCallV1,
  ): Promise<RuntimeIdentityCheckResultV1>;
  /** Bind only an exact independently authorized stream. Opening is not an execution permit;
   * even its first dispatch/delivery needs a fresh check and separate operation authorization.
   */
  openStream(
    proof: VerifiedWorkloadV1,
    request: ResolveAssignmentRequestV1,
    call: AuthorityCallV1,
    limits: RuntimeIdentityLimitsV1,
  ): Promise<RuntimeIdentityOpenStreamResultV1>;
}

export const RuntimeIdentitySchemasV1 = Object.freeze({
  workloadDiagnostic: RuntimeWorkloadDiagnosticSchemaV1,
  limits: RuntimeIdentityLimitsSchemaV1,
  failure: RuntimeIdentityFailureSchemaV1,
});
export type RuntimeIdentitySchemaNameV1 = keyof typeof RuntimeIdentitySchemasV1;
export type RuntimeIdentityValueV1<K extends RuntimeIdentitySchemaNameV1> = ReadonlyValue<
  Static<(typeof RuntimeIdentitySchemasV1)[K]>
>;
export type RuntimeIdentityDecodeResultV1<T> =
  { readonly kind: "valid"; readonly value: T } | { readonly kind: "invalid" };

function plainJson(
  value: unknown,
  active = new Set<object>(),
  depth = 0,
  budget = { nodes: 0 },
): boolean {
  if (
    depth > RUNTIME_IDENTITY_DECODING_LIMITS_V1.maxDepth ||
    ++budget.nodes > RUNTIME_IDENTITY_DECODING_LIMITS_V1.maxNodes
  )
    return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    if (
      value.length > RUNTIME_IDENTITY_DECODING_LIMITS_V1.maxStringBytes ||
      new TextEncoder().encode(value).byteLength >
        RUNTIME_IDENTITY_DECODING_LIMITS_V1.maxStringBytes ||
      /[\u0000-\u001f\u007f]/u.test(value)
    )
      return false;
    for (const scalar of value) {
      const code = scalar.charCodeAt(0);
      if (scalar.length === 1 && code >= 0xd800 && code <= 0xdfff) return false;
    }
    return true;
  }
  if (typeof value !== "object" || active.has(value)) return false;
  const array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64 || (array && (value.length > 63 || keys.length !== value.length + 1)))
    return false;
  active.add(value);
  for (const key of keys) {
    if (typeof key !== "string") return false;
    if (array) {
      if (key === "length") continue;
      const index = Number(key);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= value.length ||
        String(index) !== key
      )
        return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      !plainJson(descriptor.value, active, depth + 1, budget)
    )
      return false;
  }
  active.delete(value);
  return true;
}
function canonicalTime(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validDiagnostic(value: RuntimeWorkloadDiagnosticV1): boolean {
  return (
    canonicalTime(value.verifiedAt) &&
    canonicalTime(value.expiresAt) &&
    value.verifiedAt < value.expiresAt
  );
}
function validLimits(value: RuntimeIdentityLimitsV1): boolean {
  return (
    value.renewBeforeExpiryMs < value.svidLifetimeMs &&
    value.renewalRetryBudgetMs <= value.renewBeforeExpiryMs &&
    value.identityHealthPollMs <= value.identityHealthMaxAgeMs &&
    value.streamRecheckMs <= value.connectionMaxAgeMs &&
    value.maxFrameBytes <= value.maxBufferedBytes &&
    Number.isSafeInteger(value.maxConnections * value.maxStreamsPerConnection) &&
    Number.isSafeInteger(
      value.maxBufferedBytes * value.maxConnections * value.maxStreamsPerConnection,
    )
  );
}
function immutableCopy(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy));
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableCopy(item)])),
  );
}
/** Decode only closed observations/configuration. No proof/connection/stream schema exists.
 * Freshness against a real clock, trust, admission and operation authority are not decoded.
 */
export function decodeRuntimeIdentityV1<K extends RuntimeIdentitySchemaNameV1>(
  schemaName: K,
  input: unknown,
): RuntimeIdentityDecodeResultV1<RuntimeIdentityValueV1<K>> {
  try {
    if (
      !Object.hasOwn(RuntimeIdentitySchemasV1, schemaName) ||
      !plainJson(input) ||
      new TextEncoder().encode(JSON.stringify(input)).byteLength >
        RUNTIME_IDENTITY_DECODING_LIMITS_V1.maxBytes
    )
      return { kind: "invalid" };
    const schema = RuntimeIdentitySchemasV1[schemaName];
    if (!Check(schema, input)) return { kind: "invalid" };
    if (
      schemaName === "workloadDiagnostic" &&
      !validDiagnostic(input as RuntimeWorkloadDiagnosticV1)
    )
      return { kind: "invalid" };
    if (schemaName === "limits" && !validLimits(input as RuntimeIdentityLimitsV1))
      return { kind: "invalid" };
    // Check established this closed diagnostic/configuration type, never an authority handle.
    return { kind: "valid", value: immutableCopy(input) as RuntimeIdentityValueV1<K> };
  } catch {
    return { kind: "invalid" };
  }
}
