import { Type } from "typebox";
import { Check } from "typebox/value";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  AgentId,
  InstallationId,
  NamespaceId,
  ProviderId,
  RequestId,
  Timestamp,
} from "./api/common.ts";
import { AccountVersionVectorSchemaV1 } from "./account-authority-v1.ts";
import type { AccountOperationV1, AuthenticatedRequestHandleV1 } from "./account-authority-v1.ts";

/** Representation limits; none of these constants establishes provider completeness. */
export const AUDIENCE_OBSERVATION_LIMITS_V1 = Object.freeze({
  maxHumans: 100,
  maxCallMs: 5000,
  maxConsumedAgeMs: 5000,
  maxRequestBytes: 16 * 1024,
  maxObservationBytes: 256 * 1024,
  maxDiagnosticNodes: 16384,
});

type ReadonlyValue<T> = T extends object ? { readonly [K in keyof T]: ReadonlyValue<T[K]> } : T;
const Closed = { additionalProperties: false } as const;
const Ref = Type.String({ minLength: 1, maxLength: 1024, pattern: "^[^\\u0000-\\u0020\\u007f]+$" });
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
// Match account-authority conversation/common-grant references; native references remain opaque.
const AccountRef = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
});
const Milliseconds = Type.Integer({ minimum: 0, maximum: 5000 });
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const CommonScope = {
  installationId: InstallationId,
  channelInstallationRef: Ref,
  providerTenantRef: Ref,
  recipientAppRef: Ref,
  channelRef: Ref,
  rootThreadRef: Ref,
};

/** Opaque native references are compared whole; tenant, team and Namespace are distinct. */
export const AudienceScopeSchemaV1 = Type.Union([
  Type.Object({ ...CommonScope, profile: Type.Literal("slack-private-mentioned-v1") }, Closed),
  Type.Object(
    {
      ...CommonScope,
      profile: Type.Literal("teams-standard-mentioned-v1"),
      cloud: Type.Literal("microsoft-public"),
      teamRef: Ref,
    },
    Closed,
  ),
]);
export type AudienceScopeV1 = ReadonlyValue<Type.Static<typeof AudienceScopeSchemaV1>>;

export const AudienceTargetSchemaV1 = Type.Object(
  {
    namespaceId: NamespaceId,
    agentId: AgentId,
    conversationRef: AccountRef,
    commonGrantRef: AccountRef,
    targetVersion: Version,
    approvedBoundaryDigest: Digest,
    sourceMessageRef: Ref,
    immutableMessageDigest: Digest,
  },
  Closed,
);
const OutputKind = Type.Enum(["result", "status", "cancel-ack"]);
export const AudienceStageSchemaV1 = Type.Union([
  Type.Object({ kind: Type.Enum(["ingress-admission", "dispatch", "native-consumption"]) }, Closed),
  Type.Object({ kind: Type.Literal("protected-create"), outputKind: OutputKind }, Closed),
  Type.Object(
    {
      kind: Type.Literal("no-effect-retry"),
      outputKind: OutputKind,
      previousObservationRef: Ref,
    },
    Closed,
  ),
  // The selected profile permits only the known-ID status reconciliation update.
  Type.Object(
    {
      kind: Type.Literal("known-id-update"),
      outputKind: Type.Literal("status"),
      nativeMessageRef: Ref,
    },
    Closed,
  ),
]);
export type AudienceStageV1 = ReadonlyValue<Type.Static<typeof AudienceStageSchemaV1>>;
export const AudienceObservationRequestSchemaV1 = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    requestId: RequestId,
    scope: AudienceScopeSchemaV1,
    target: AudienceTargetSchemaV1,
    stage: AudienceStageSchemaV1,
    startedAt: Timestamp,
    deadline: Timestamp,
  },
  Closed,
);
export type AudienceObservationRequestV1 = ReadonlyValue<
  Type.Static<typeof AudienceObservationRequestSchemaV1>
>;

const Enumeration = Type.Object({ snapshotVersion: Ref, allPagesRead: Type.Literal(true) }, Closed);
const Mechanism = {
  mechanismProfileRef: Ref,
  sourceCapabilityRef: Ref,
  scopeClassificationVersion: Ref,
  readerSetVersion: Ref,
  changeDetectionVersion: Ref,
  configuredDeliveryBotRef: Ref,
};
/**
 * Diagnostic claims about an owner-qualified mechanism. Page exhaustion alone is
 * insufficient: the producer must verify classification, access-policy coverage,
 * stable membership and change detection for all actual readers, including silent
 * readers. These references cannot enroll or qualify such a mechanism.
 */
export const AudienceCompletenessSchemaV1 = Type.Union([
  Type.Object(
    {
      ...Mechanism,
      profile: Type.Literal("slack-private-mentioned-v1"),
      channelMembers: Enumeration,
      userClassificationVersion: Ref,
      channelAccessPolicyVersion: Ref,
    },
    Closed,
  ),
  Type.Object(
    {
      ...Mechanism,
      profile: Type.Literal("teams-standard-mentioned-v1"),
      teamReaders: Enumeration,
      channelReaders: Enumeration,
      userClassificationVersion: Ref,
      tenantAccessPolicyVersion: Ref,
      tenantReaders: Type.Union([
        Type.Object({ kind: Type.Literal("included"), enumeration: Enumeration }, Closed),
        Type.Object({ kind: Type.Literal("not-applicable"), determinationVersion: Ref }, Closed),
      ]),
    },
    Closed,
  ),
]);
export const AudienceReaderSchemaV1 = Type.Object(
  {
    readerRef: Ref,
    providerSubjectRef: Ref,
    kind: Type.Literal("human"),
    accessPaths: Type.Array(Type.Enum(["channel", "team", "tenant"]), {
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
    }),
  },
  Closed,
);
export const AudienceObservationSchemaV1 = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    observationRef: Ref,
    request: AudienceObservationRequestSchemaV1,
    observedAt: Timestamp,
    validUntil: Timestamp,
    clockUncertaintyMs: Milliseconds,
    totalHumanReaders: Type.Integer({ minimum: 1, maximum: 100 }),
    readers: Type.Array(AudienceReaderSchemaV1, { minItems: 1, maxItems: 100 }),
    completeness: AudienceCompletenessSchemaV1,
  },
  Closed,
);
export type AudienceObservationV1 = ReadonlyValue<Type.Static<typeof AudienceObservationSchemaV1>>;
export type AudienceReaderV1 = ReadonlyValue<Type.Static<typeof AudienceReaderSchemaV1>>;

/** Internal diagnostics only. Public denial content itself requires safe disclosure. */
export const AudienceFailureSchemaV1 = Type.Union([
  Type.Object({ kind: Type.Literal("denied") }, Closed),
  Type.Object({ kind: Type.Literal("not-visible") }, Closed),
  Type.Object(
    {
      kind: Type.Literal("unavailable"),
      reason: Type.Enum([
        "missing-native-producer",
        "missing-reader-account-producer",
        "missing-effect-composition",
        "incomplete-readers",
        "unsupported-reader",
        "unsupported-scope",
        "overflow",
        "clock-unknown",
        "deadline",
        "cancelled",
        "dependency-unavailable",
      ]),
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Literal("invalidated"),
      reason: Type.Enum([
        "stale",
        "scope-changed",
        "readers-changed",
        "account-changed",
        "superseded",
      ]),
    },
    Closed,
  ),
  // No attempt/effect identity is invented here. Reconciliation needs its canonical carrier.
  Type.Object({ kind: Type.Literal("reconciliation-required") }, Closed),
]);
export type AudienceFailureV1 = ReadonlyValue<Type.Static<typeof AudienceFailureSchemaV1>>;
export const AudienceDiagnosticSchemaV1 = Type.Union([
  Type.Object({ kind: Type.Literal("observed"), observation: AudienceObservationSchemaV1 }, Closed),
  AudienceFailureSchemaV1,
]);
export type AudienceDiagnosticV1 = ReadonlyValue<Type.Static<typeof AudienceDiagnosticSchemaV1>>;

/** Existing account/IAM version components, deliberately excluding caller credentials. */
export const AudienceReaderVersionsSchemaV1 = Type.Object(
  {
    installation: AccountVersionVectorSchemaV1.properties.installation,
    account: AccountVersionVectorSchemaV1.properties.account,
    grants: AccountVersionVectorSchemaV1.properties.grants,
    iamPolicy: AccountVersionVectorSchemaV1.properties.iamPolicy,
    semanticMapping: AccountVersionVectorSchemaV1.properties.semanticMapping,
    driverSelection: AccountVersionVectorSchemaV1.properties.driverSelection,
  },
  Closed,
);
export const AudienceReaderAccountsObservationSchemaV1 = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    nativeObservationRef: Ref,
    request: AudienceObservationRequestSchemaV1,
    evaluatedAt: Timestamp,
    validUntil: Timestamp,
    clockUncertaintyMs: Milliseconds,
    selectedIAM: Type.Object({ driverId: ProviderId, revision: Version }, Closed),
    operation: Type.Object(
      {
        kind: Type.Literal("conversation.read"),
        target: Type.Object(
          {
            namespaceId: NamespaceId,
            agentId: AgentId,
            conversationRef: AccountRef,
            commonGrantRef: AccountRef,
          },
          Closed,
        ),
      },
      Closed,
    ),
    readers: Type.Array(
      Type.Object(
        {
          readerRef: Ref,
          providerSubjectRef: Ref,
          principalId: AccountRef,
          accountId: AccountRef,
          accountState: Type.Literal("active"),
          humanBindingId: AccountRef,
          humanBindingVersion: Version,
          versions: AudienceReaderVersionsSchemaV1,
          decisionRef: AccountRef,
          roleIds: Type.Array(AccountRef, { minItems: 1, maxItems: 64, uniqueItems: true }),
          accessBindingIds: Type.Array(AccountRef, {
            minItems: 1,
            maxItems: 64,
            uniqueItems: true,
          }),
        },
        Closed,
      ),
      { minItems: 1, maxItems: 100 },
    ),
  },
  Closed,
);
export type AudienceReaderAccountsObservationV1 = ReadonlyValue<
  Type.Static<typeof AudienceReaderAccountsObservationSchemaV1>
>;
export const AudienceReaderAccountsDiagnosticSchemaV1 = Type.Union([
  Type.Object(
    { kind: Type.Literal("checked"), observation: AudienceReaderAccountsObservationSchemaV1 },
    Closed,
  ),
  AudienceFailureSchemaV1,
]);
export type AudienceReaderAccountsDiagnosticV1 = ReadonlyValue<
  Type.Static<typeof AudienceReaderAccountsDiagnosticSchemaV1>
>;
export type AudienceDecodeResultV1<T> =
  { readonly kind: "valid"; readonly value: T } | { readonly kind: "invalid" };

declare const invocationBrand: unique symbol;
declare const observationBrand: unique symbol;
declare const readerAccountsBrand: unique symbol;
/** Native owner-created, recipient-bound, process-local; never an external identity DTO. */
export interface AudienceInvocationHandleV1 {
  readonly [invocationBrand]: true;
}
/** Native owner-created custody of the exact request, snapshot and every reader. */
export interface AudienceObservationHandleV1 {
  readonly [observationBrand]: true;
}
/** Account owner's process-local observation custody; no login or session is represented. */
export interface AudienceReaderAccountsHandleV1 {
  readonly [readerAccountsBrand]: true;
}
export type AudienceReaderAccountsResultV1 =
  | {
      readonly kind: "checked";
      readonly observation: AudienceReaderAccountsObservationV1;
      readonly custody: AudienceReaderAccountsHandleV1;
    }
  | AudienceFailureV1;
export type AudienceObservationResultV1 =
  | {
      readonly kind: "observed";
      readonly observation: AudienceObservationV1;
      readonly custody: AudienceObservationHandleV1;
    }
  | AudienceFailureV1;

/** Interface only. Actual authenticated transport/recipient custody must create the handle. */
export interface AudienceInvocationSourceV1 {
  forCurrentInvocationV1(signal: AbortSignal): Promise<AudienceInvocationHandleV1>;
}

/**
 * Actual implementations keep private handle identity and immutable request copies,
 * including installation/tenant/app/channel/thread/target/message/stage. Reject foreign,
 * serialized, expired, released or replayed handles. An observation is never an allow.
 *
 * Each observe starts fresh for this message/stage, under the original <=5s monotonic
 * deadline. No positive cache or automatic allow retry. Superseding evaluation invalidates
 * an earlier unconsumed response; possible consumption requires canonical reconciliation.
 * inspect performs fresh native source/change/clock checks of this exact observation;
 * it does not extend its deadline, refresh it into another grant or consume an effect.
 * Unknown clock uncertainty denies. The stricter policy/deadline always applies.
 *
 * Signals propagate to all provider work. Every call owns and joins losing/cancelled work
 * and retains its capacity until settlement. release joins remaining observation work;
 * it neither releases journal ownership nor cancels an already possible native effect.
 * A remote handle transport needs a separate accepted mapping; JSON is not that mapping.
 */
export interface AudienceObservationPortV1 {
  observeV1(
    invocation: AudienceInvocationHandleV1,
    request: AudienceObservationRequestV1,
    signal: AbortSignal,
  ): Promise<AudienceObservationResultV1>;
  inspectV1(
    invocation: AudienceInvocationHandleV1,
    custody: AudienceObservationHandleV1,
    exactRequest: AudienceObservationRequestV1,
    signal: AbortSignal,
  ): Promise<AudienceObservationResultV1>;
  releaseV1(
    invocation: AudienceInvocationHandleV1,
    custody: AudienceObservationHandleV1,
  ): Promise<void>;
}

/**
 * Missing account-owner composition, not an implementation of account-authority. The current-caller
 * account-authority port cannot impersonate passive readers. This provider must validate native
 * custody and resolve every exact external human against current authoritative bindings,
 * account state and selected IAM; no cookie/session/request handle may be manufactured.
 * Each result must be the current exact conversation.read check for that reader and the
 * unchanged approved common boundary. Passive readers need no active login. This result
 * therefore excludes account-authority's current-caller session/key and credential-version fields;
 * it reuses the existing account/grant/IAM version components, not new counters or stores.
 * The account owner privately validates its observation handle and native correspondence.
 * evaluatedAt is the earliest underlying account evaluation and validUntil is bounded by
 * the earliest current result, the native observation and the original request deadline.
 * Do not shrink the boundary to the intersection that happens to pass. Duplicate/missing
 * humans, disabled accounts, stale bindings/grants or absent provider deny the full set.
 * This is additional disclosure evidence, not a new issuer or a compare/consume service.
 * The same original deadline, cancellation and joined-work rules apply.
 */
export interface AudienceReaderAccountPortV1 {
  checkReadersV1(
    invocation: AudienceInvocationHandleV1,
    custody: AudienceObservationHandleV1,
    exactRequest: AudienceObservationRequestV1,
    signal: AbortSignal,
  ): Promise<AudienceReaderAccountsResultV1>;
  releaseV1(
    invocation: AudienceInvocationHandleV1,
    custody: AudienceReaderAccountsHandleV1,
  ): Promise<void>;
}

/** A real current caller handle is supplied independently; it is never a reader ID cast. */
export interface AudienceActingAccountV1 {
  readonly authenticated: AuthenticatedRequestHandleV1;
  readonly operation: AccountOperationV1;
}

/** Pure requirement selection. Read permission does not include append/tool/cancellation. */
export function audienceReaderOperationV1(
  request: AudienceObservationRequestV1,
): AccountOperationV1 {
  const r = decodeAudienceObservationRequestV1(request);
  if (r.kind !== "valid") throw new TypeError("Invalid audience request.");
  const { namespaceId, agentId, conversationRef, commonGrantRef } = r.value.target;
  return immutableCopy({
    kind: "conversation.read",
    target: { namespaceId, agentId, conversationRef, commonGrantRef },
  });
}

// TODO: integrate the exact owner-supplied effect carriers and sole OCC compare/consume
// declaration after that permitted input is available. There is deliberately no substitute
// attempt/slot/effect DTO, issuer, consume implementation or positive completion export.

function plainJson(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
  budget = { nodes: 0 },
): boolean {
  if (depth > 14 || ++budget.nodes > AUDIENCE_OBSERVATION_LIMITS_V1.maxDiagnosticNodes)
    return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") {
    if (
      value.length > 1024 ||
      new TextEncoder().encode(value).byteLength > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    )
      return false;
    for (const scalar of value) {
      const code = scalar.charCodeAt(0);
      if (scalar.length === 1 && code >= 0xd800 && code <= 0xdfff) return false;
    }
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 128 || (array && (value.length > 100 || keys.length !== value.length + 1)))
    return false;
  seen.add(value);
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
      !plainJson(descriptor.value, seen, depth + 1, budget)
    )
      return false;
  }
  seen.delete(value);
  return true;
}
function canonicalTimes(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  for (const [key, item] of Object.entries(value)) {
    if (["startedAt", "deadline", "observedAt", "evaluatedAt", "validUntil"].includes(key)) {
      if (
        typeof item !== "string" ||
        !Number.isFinite(Date.parse(item)) ||
        new Date(item).toISOString() !== item
      )
        return false;
    } else if (!canonicalTimes(item)) return false;
  }
  return true;
}
function decode<T extends Type.TSchema>(
  schema: T,
  input: unknown,
  maxBytes: number,
): AudienceDecodeResultV1<ReadonlyValue<Type.Static<T>>> {
  try {
    if (
      !plainJson(input) ||
      new TextEncoder().encode(JSON.stringify(input)).byteLength > maxBytes ||
      !Check(schema, input) ||
      !canonicalTimes(input)
    )
      return { kind: "invalid" };
    return { kind: "valid", value: immutableCopy(input) as ReadonlyValue<Type.Static<T>> };
  } catch {
    return { kind: "invalid" };
  }
}
function requestTimes(request: AudienceObservationRequestV1): boolean {
  const duration = Date.parse(request.deadline) - Date.parse(request.startedAt);
  return duration > 0 && duration <= AUDIENCE_OBSERVATION_LIMITS_V1.maxCallMs;
}
function observationRelations(observation: AudienceObservationV1): boolean {
  const { request, completeness, readers } = observation;
  const start = Date.parse(request.startedAt);
  const observed = Date.parse(observation.observedAt);
  const until = Date.parse(observation.validUntil);
  if (
    !requestTimes(request) ||
    observed < start ||
    until <= observed ||
    until > Date.parse(request.deadline) ||
    until - observed + observation.clockUncertaintyMs > 5000
  )
    return false;
  if (
    completeness.profile !== request.scope.profile ||
    readers.length !== observation.totalHumanReaders
  )
    return false;
  if (
    new Set(readers.map((r) => r.readerRef)).size !== readers.length ||
    new Set(readers.map((r) => r.providerSubjectRef)).size !== readers.length
  )
    return false;
  for (const reader of readers) {
    if (reader.providerSubjectRef === completeness.configuredDeliveryBotRef) return false;
    if (
      completeness.profile === "slack-private-mentioned-v1" &&
      (reader.accessPaths.length !== 1 || reader.accessPaths[0] !== "channel")
    )
      return false;
    if (
      completeness.profile === "teams-standard-mentioned-v1" &&
      completeness.tenantReaders.kind === "not-applicable" &&
      reader.accessPaths.includes("tenant")
    )
      return false;
  }
  return true;
}
export function decodeAudienceObservationRequestV1(
  input: unknown,
): AudienceDecodeResultV1<AudienceObservationRequestV1> {
  const result = decode(
    AudienceObservationRequestSchemaV1,
    input,
    AUDIENCE_OBSERVATION_LIMITS_V1.maxRequestBytes,
  );
  return result.kind === "valid" && !requestTimes(result.value) ? { kind: "invalid" } : result;
}
/** Shape/relational validation only: neither completeness nor account authority is proven. */
export function decodeAudienceDiagnosticV1(
  input: unknown,
): AudienceDecodeResultV1<AudienceDiagnosticV1> {
  const result = decode(
    AudienceDiagnosticSchemaV1,
    input,
    AUDIENCE_OBSERVATION_LIMITS_V1.maxObservationBytes,
  );
  return result.kind === "valid" &&
    result.value.kind === "observed" &&
    !observationRelations(result.value.observation)
    ? { kind: "invalid" }
    : result;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

/** Passive-reader representation only; no authenticated caller session is synthesized. */
export function decodeAudienceReaderAccountsDiagnosticV1(
  input: unknown,
): AudienceDecodeResultV1<AudienceReaderAccountsDiagnosticV1> {
  const result = decode(
    AudienceReaderAccountsDiagnosticSchemaV1,
    input,
    AUDIENCE_OBSERVATION_LIMITS_V1.maxObservationBytes,
  );
  if (result.kind !== "valid" || result.value.kind !== "checked") return result;
  const o = result.value.observation;
  const evaluated = Date.parse(o.evaluatedAt);
  const until = Date.parse(o.validUntil);
  if (
    !requestTimes(o.request) ||
    evaluated < Date.parse(o.request.startedAt) ||
    until <= evaluated ||
    until > Date.parse(o.request.deadline) ||
    until - evaluated + o.clockUncertaintyMs > 5000 ||
    canonical(o.operation) !== canonical(audienceReaderOperationV1(o.request))
  )
    return { kind: "invalid" };
  if (
    new Set(o.readers.map((reader) => reader.readerRef)).size !== o.readers.length ||
    new Set(o.readers.map((reader) => reader.providerSubjectRef)).size !== o.readers.length ||
    new Set(o.readers.map((reader) => reader.humanBindingId)).size !== o.readers.length
  )
    return { kind: "invalid" };
  const first = o.readers[0];
  if (!first) return { kind: "invalid" };
  for (const reader of o.readers) {
    for (const key of [
      "installation",
      "iamPolicy",
      "semanticMapping",
      "driverSelection",
    ] as const) {
      if (reader.versions[key] !== first.versions[key]) return { kind: "invalid" };
    }
  }
  return result;
}

/** Exact full-set data correspondence, never current account or native authority. */
export function audienceReaderAccountsMatchObservationV1(
  accounts: AudienceReaderAccountsObservationV1,
  native: AudienceObservationV1,
): boolean {
  const a = decodeAudienceReaderAccountsDiagnosticV1({ kind: "checked", observation: accounts });
  const n = decodeAudienceDiagnosticV1({ kind: "observed", observation: native });
  if (
    a.kind !== "valid" ||
    a.value.kind !== "checked" ||
    n.kind !== "valid" ||
    n.value.kind !== "observed"
  )
    return false;
  const checked = a.value.observation;
  const observed = n.value.observation;
  if (
    checked.nativeObservationRef !== observed.observationRef ||
    canonical(checked.request) !== canonical(observed.request) ||
    checked.readers.length !== observed.readers.length ||
    Date.parse(checked.validUntil) > Date.parse(observed.validUntil) ||
    Date.parse(checked.evaluatedAt) < Date.parse(observed.observedAt)
  )
    return false;
  const readers = new Map(
    observed.readers.map((reader) => [reader.readerRef, reader.providerSubjectRef]),
  );
  return (
    checked.readers.every(
      (reader) =>
        readers.get(reader.readerRef) === reader.providerSubjectRef &&
        readers.delete(reader.readerRef),
    ) && readers.size === 0
  );
}

/** Exact decoded-data correspondence only; a match does not validate native custody. */
export function audienceObservationMatchesRequestV1(
  observation: AudienceObservationV1,
  request: AudienceObservationRequestV1,
): boolean {
  const actual = decodeAudienceDiagnosticV1({ kind: "observed", observation });
  const expected = decodeAudienceObservationRequestV1(request);
  return (
    actual.kind === "valid" &&
    actual.value.kind === "observed" &&
    expected.kind === "valid" &&
    canonical(actual.value.observation.request) === canonical(expected.value)
  );
}

/** Pure rejection helper for owned local clocks. "within-bounds" is never an authority permit. */
export function audienceObservationTimingV1(
  observation: AudienceObservationV1,
  clock: {
    readonly now: string;
    readonly uncertaintyMs: number;
    readonly elapsedSinceRequestMs: number;
  },
): "within-bounds" | "invalid-or-expired" {
  const result = decodeAudienceDiagnosticV1({ kind: "observed", observation });
  if (result.kind !== "valid" || result.value.kind !== "observed") return "invalid-or-expired";
  const now = Date.parse(clock.now);
  if (
    !Number.isFinite(now) ||
    new Date(now).toISOString() !== clock.now ||
    !Number.isSafeInteger(clock.uncertaintyMs) ||
    clock.uncertaintyMs < 0 ||
    !Number.isFinite(clock.elapsedSinceRequestMs) ||
    clock.elapsedSinceRequestMs < 0
  )
    return "invalid-or-expired";
  const o = result.value.observation;
  const uncertainty = clock.uncertaintyMs + o.clockUncertaintyMs;
  const duration = Date.parse(o.request.deadline) - Date.parse(o.request.startedAt);
  return now + uncertainty < Date.parse(o.validUntil) &&
    now - uncertainty >= Date.parse(o.observedAt) &&
    now - Date.parse(o.observedAt) + uncertainty <= 5000 &&
    clock.elapsedSinceRequestMs + uncertainty < duration
    ? "within-bounds"
    : "invalid-or-expired";
}
