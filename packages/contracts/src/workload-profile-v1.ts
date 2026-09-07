import { Type, type Static, type TSchema } from "typebox";
import { types } from "node:util";
import { Check } from "typebox/value";
import { immutableCopy } from "@openclaw-enterprise/utils";

export const WORKLOAD_PROFILE_LIMITS_V1 = Object.freeze({
  canonicalBytes: 65_536,
  pendingOrdinaryOperations: 32,
  operationAndTerminalSlots: 4_096,
  lookupMs: 3_000,
});

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID = Type.String({ pattern: `^${uuidPattern}$`, minLength: 36, maxLength: 36 });
const Digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$", minLength: 71, maxLength: 71 });
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const WorkloadProfileIdSchemaV1 = UUID;
export const WorkloadProfileDigestSchemaV1 = Digest;
export const WorkloadProfileVersionSchemaV1 = Version;

export const WorkloadProfileScopeSchemaV1 = object({
  installationId: Type.String({
    pattern: `^ins_${uuidPattern}$`,
    minLength: 40,
    maxLength: 40,
  }),
  namespaceId: Type.String({ pattern: `^ns_${uuidPattern}$`, minLength: 39, maxLength: 39 }),
  component: Type.Literal("harness"),
});
export type WorkloadProfileScopeV1 = Static<typeof WorkloadProfileScopeSchemaV1>;

/** A saved selection identifies intended bytes. It carries no current authority. */
export const WorkloadProfileSelectionSchemaV1 = object({
  manifestRef: UUID,
  manifestDigest: Digest,
  admissionRef: UUID,
  admissionVersion: Version,
});
export type WorkloadProfileSelectionV1 = Static<typeof WorkloadProfileSelectionSchemaV1>;

export const ImmutableWorkloadProfileRoleSchemaV1 = object({
  ref: UUID,
  version: Version,
  contentDigest: Digest,
});
export type ImmutableWorkloadProfileRoleV1 = Static<typeof ImmutableWorkloadProfileRoleSchemaV1>;

export const WorkloadProfileRolesSchemaV1 = object({
  provider: ImmutableWorkloadProfileRoleSchemaV1,
  runtime: ImmutableWorkloadProfileRoleSchemaV1,
  identity: ImmutableWorkloadProfileRoleSchemaV1,
  containment: ImmutableWorkloadProfileRoleSchemaV1,
  storage: ImmutableWorkloadProfileRoleSchemaV1,
});
export type WorkloadProfileRolesV1 = Static<typeof WorkloadProfileRolesSchemaV1>;

export const WorkloadProfileUseSchemaV1 = object({
  schemaVersion: Type.Literal(1),
  ...WorkloadProfileScopeSchemaV1.properties,
  ...WorkloadProfileSelectionSchemaV1.properties,
  canonicalFormat: Type.Literal("oce.workload-profile.canonical-json.v1"),
  profileRefs: WorkloadProfileRolesSchemaV1,
  admittedConfigurationDigest: Digest,
});
export type WorkloadProfileUseV1 = Static<typeof WorkloadProfileUseSchemaV1>;

/** Pair-wide retained data. Validity does not establish a current admission. */
export const WorkloadProfileUseSchemaV2 = object({
  ...WorkloadProfileUseSchemaV1.properties,
  schemaVersion: Type.Literal(2),
  component: Type.Literal("gateway-harness-pair"),
});
export type WorkloadProfileUseV2 = Readonly<Static<typeof WorkloadProfileUseSchemaV2>>;

/** Transport envelope only. Its bytes still require the selected closed content decoder. */
export const WorkloadProfileContentEnvelopeSchemaV1 = object({
  format: Type.Literal("oce.workload-profile.canonical-json.v1"),
  canonicalUtf8: Type.String({
    minLength: 1,
    maxLength: WORKLOAD_PROFILE_LIMITS_V1.canonicalBytes,
  }),
  manifestDigest: Digest,
});
export type WorkloadProfileContentEnvelopeV1 = Static<
  typeof WorkloadProfileContentEnvelopeSchemaV1
>;

const preparationProperties = {
  schemaVersion: Type.Literal(1),
  operationRef: UUID,
  namespaceId: WorkloadProfileScopeSchemaV1.properties.namespaceId,
  component: Type.Literal("harness"),
  manifest: WorkloadProfileContentEnvelopeSchemaV1,
};

/** Server Installation and acting account are deliberately absent from the body. */
export const WorkloadProfilePrepareSchemaV1 = Type.Union([
  object({
    ...preparationProperties,
    action: Type.Literal("admit"),
    expectedAdmission: Type.Null(),
  }),
  object({
    ...preparationProperties,
    action: Type.Literal("replace"),
    expectedAdmission: WorkloadProfileSelectionSchemaV1,
  }),
]);
export type WorkloadProfilePrepareV1 = Static<typeof WorkloadProfilePrepareSchemaV1>;

/** The server resolves the admission-owned terminal template in its guarded unit. */
export const WorkloadProfileWithdrawSchemaV1 = object({
  schemaVersion: Type.Literal(1),
  operationRef: UUID,
  expectedAdmission: WorkloadProfileSelectionSchemaV1,
});
export type WorkloadProfileWithdrawV1 = Static<typeof WorkloadProfileWithdrawSchemaV1>;

export const ProfileInvalidationRequestSchemaV1 = object({
  schemaVersion: Type.Literal(1),
  kind: Type.Literal("profile-admission-invalidated"),
  requestRef: UUID,
  operationRef: UUID,
  ...WorkloadProfileScopeSchemaV1.properties,
  manifestRef: UUID,
  manifestDigest: Digest,
  admissionRef: UUID,
  previousVersion: Version,
  currentVersion: Version,
  reason: Type.Union([Type.Literal("withdrawn"), Type.Literal("replaced")]),
  acceptedAt: Type.String({
    format: "date-time",
    pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$",
    minLength: 24,
    maxLength: 24,
  }),
});
export type ProfileInvalidationRequestV1 = Static<typeof ProfileInvalidationRequestSchemaV1>;

export type WorkloadProfileDecodeResultV1<T> =
  { readonly kind: "valid"; readonly value: Readonly<T> } | { readonly kind: "invalid" };

function scalarString(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Inspect descriptors before schema validation so accessors never supply data. */
function plainData(value: unknown, seen: Set<object>, depth = 0): boolean {
  if (depth > 20) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return scalarString(value);
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
  if (typeof value !== "object" || types.isProxy(value) || seen.has(value)) return false;
  const array = Array.isArray(value);
  if (
    array
      ? Object.getPrototypeOf(value) !== Array.prototype
      : Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
  )
    return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 128 || (array && keys.length !== value.length + 1)) return false;
  seen.add(value);
  for (const key of keys) {
    if (typeof key !== "string") return false;
    if (array && key === "length") continue;
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
    if (!plainData(descriptor.value, seen, depth + 1)) return false;
  }
  return true;
}

function decode<S extends TSchema>(
  schema: S,
  input: unknown,
): WorkloadProfileDecodeResultV1<Static<S>> {
  try {
    if (!plainData(input, new Set()) || !Check(schema, input)) return { kind: "invalid" };
    const value = immutableCopy(input);
    if (!plainData(value, new Set()) || !Check(schema, value)) return { kind: "invalid" };
    return { kind: "valid", value: value as Readonly<Static<S>> };
  } catch {
    return { kind: "invalid" };
  }
}

export function decodeWorkloadProfileSelectionV1(input: unknown) {
  return decode(WorkloadProfileSelectionSchemaV1, input);
}

export function decodeWorkloadProfileUseV1(input: unknown) {
  const result = decode(WorkloadProfileUseSchemaV1, input);
  if (result.kind === "invalid") return result;
  const refs = Object.values(result.value.profileRefs).map((role) => role.ref);
  return new Set(refs).size === refs.length ? result : ({ kind: "invalid" } as const);
}

export function decodeWorkloadProfileUseV2(input: unknown) {
  const result = decode(WorkloadProfileUseSchemaV2, input);
  if (result.kind === "invalid") return result;
  const refs = Object.values(result.value.profileRefs).map((role) => role.ref);
  return new Set(refs).size === refs.length ? result : ({ kind: "invalid" } as const);
}

export function decodeWorkloadProfilePrepareEnvelopeV1(input: unknown) {
  const result = decode(WorkloadProfilePrepareSchemaV1, input);
  if (
    result.kind === "valid" &&
    new TextEncoder().encode(result.value.manifest.canonicalUtf8).byteLength >
      WORKLOAD_PROFILE_LIMITS_V1.canonicalBytes
  )
    return { kind: "invalid" } as const;
  return result;
}

export function decodeWorkloadProfileWithdrawV1(input: unknown) {
  return decode(WorkloadProfileWithdrawSchemaV1, input);
}

export function decodeProfileInvalidationRequestV1(input: unknown) {
  const result = decode(ProfileInvalidationRequestSchemaV1, input);
  if (
    result.kind === "valid" &&
    (result.value.previousVersion === Number.MAX_SAFE_INTEGER ||
      result.value.currentVersion !== result.value.previousVersion + 1 ||
      !Number.isFinite(Date.parse(result.value.acceptedAt)) ||
      new Date(result.value.acceptedAt).toISOString() !== result.value.acceptedAt)
  )
    return { kind: "invalid" } as const;
  return result;
}
