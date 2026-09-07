import { types as nodeTypes, isDeepStrictEqual } from "node:util";
import { Buffer } from "node:buffer";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  WorkloadProfileSelectionSchemaV1,
  WorkloadProfileRolesSchemaV1,
  WorkloadProfileDigestSchemaV1,
  WORKLOAD_PROFILE_LIMITS_V1,
} from "./workload-profile-v1.ts";
import {
  CredentialProfileSchemaV1,
  OriginalCredentialBindingSchemaV1,
  type CredentialProfileV1,
} from "./credential-authority-v1.ts";
import {
  CredentialSecretBindingSchemaV1,
  ProtectedModelBindingSchemaV1,
  CredentialRepositoryGrantSchemaV1,
  CREDENTIAL_STORAGE_LIMITS_V1,
  parseCredentialStorageV1,
} from "./credential-storage-v1.ts";
import { RevisionId } from "./api/common.ts";

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
const closed = { additionalProperties: false } as const;
const ref = CredentialSecretBindingSchemaV1.properties.bindingRef;
const version = CredentialSecretBindingSchemaV1.properties.secretVersion;
const scope = OriginalCredentialBindingSchemaV1.properties.scope;
const logicalCredential = Type.Object({ ref, version }, closed);
const recordVersion = Type.Object({ recordRef: ref, recordVersion: version }, closed);

/** This subsection consumes the whole manifest's existing byte allowance. */
export const CREDENTIAL_WORKLOAD_SELECTION_LIMITS_V1 = Object.freeze({
  maxEncodedBytes: Math.min(
    WORKLOAD_PROFILE_LIMITS_V1.canonicalBytes,
    CREDENTIAL_STORAGE_LIMITS_V1.maxRequestBytes,
  ),
  maxDepth: CREDENTIAL_STORAGE_LIMITS_V1.maxJsonDepth,
  maxNodes: 4096,
  maxObjectKeys: 64,
  maxChannels: 2,
});

/** Immutable admission correspondence, never current authority or a selector. */
export const CredentialWorkloadAssociationSchemaV1 = Type.Object(
  {
    selection: WorkloadProfileSelectionSchemaV1,
    profileRefs: WorkloadProfileRolesSchemaV1,
    admittedConfigurationDigest: WorkloadProfileDigestSchemaV1,
  },
  closed,
);
export type CredentialWorkloadAssociationV1 = Immutable<
  Static<typeof CredentialWorkloadAssociationSchemaV1>
>;
export type CredentialWorkloadModelProfileV1 = Extract<CredentialProfileV1, { kind: "model" }>;
export type CredentialWorkloadRepositoryProfileV1 = Extract<
  CredentialProfileV1,
  { kind: "repository" }
>;

export const CredentialWorkloadChannelSchemaV1 = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("slack"),
      moduleId: ref,
      profileRef: ref,
      bot: logicalCredential,
      app: logicalCredential,
    },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal("teams"),
      moduleId: ref,
      profileRef: ref,
      credential: logicalCredential,
    },
    closed,
  ),
]);
export type CredentialWorkloadChannelV1 = Immutable<
  Static<typeof CredentialWorkloadChannelSchemaV1>
>;

export const CredentialWorkloadSelectionSchemaV1 = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    scope,
    revisionId: RevisionId,
    association: CredentialWorkloadAssociationSchemaV1,
    model: ProtectedModelBindingSchemaV1,
    repository: Type.Object(
      {
        profile: CredentialProfileSchemaV1.anyOf[1],
        binding: CredentialSecretBindingSchemaV1,
        grant: CredentialRepositoryGrantSchemaV1,
      },
      closed,
    ),
    materialSelection: recordVersion,
    channels: Type.Array(CredentialWorkloadChannelSchemaV1, {
      minItems: 1,
      maxItems: CREDENTIAL_WORKLOAD_SELECTION_LIMITS_V1.maxChannels,
    }),
  },
  closed,
);
export type CredentialWorkloadSelectionV1 = Immutable<
  Static<typeof CredentialWorkloadSelectionSchemaV1>
>;
export type CredentialWorkloadSelectionDecodeV1 =
  Readonly<{ kind: "valid"; value: CredentialWorkloadSelectionV1 }> | Readonly<{ kind: "invalid" }>;

/** No JSON parser, getters, proxy traps, custom prototypes or caller callbacks run here. */
function plainData(input: unknown): boolean {
  const limits = CREDENTIAL_WORKLOAD_SELECTION_LIMITS_V1;
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const string = (value: string): boolean => {
    if (value.length > limits.maxEncodedBytes) return false;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    bytes += Buffer.byteLength(value, "utf8");
    return bytes <= limits.maxEncodedBytes;
  };
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "string") return string(value);
    if (typeof value === "number")
      return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
    if (typeof value !== "object" || nodeTypes.isProxy(value) || seen.has(value)) return false;
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length > limits.maxObjectKeys || (array && keys.length !== value.length + 1))
      return false;
    seen.add(value);
    for (const key of keys) {
      if (typeof key !== "string") return false;
      if (array && key === "length") continue;
      if (
        !string(key) ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
      )
        return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
      if (!visit(descriptor.value, depth + 1)) return false;
    }
    return true;
  };
  return visit(input, 0);
}

function same(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}

function relations(value: CredentialWorkloadSelectionV1): boolean {
  const roles = Object.values(value.association.profileRefs);
  if (new Set(roles.map((role) => role.ref)).size !== roles.length) return false;
  parseCredentialStorageV1("modelBinding", value.model);
  parseCredentialStorageV1("profile", value.repository.profile);
  parseCredentialStorageV1("secretBinding", value.repository.binding);
  parseCredentialStorageV1("repositoryGrant", value.repository.grant);
  const { profile, binding, grant } = value.repository;
  if (
    !same(value.scope, value.model.scope) ||
    !same(value.scope, profile.scope) ||
    !same(value.scope, binding.scope) ||
    profile.providerId !== binding.providerId ||
    !same(profile.account, binding.account) ||
    profile.providerInstallationRef !== grant.providerInstallationRef ||
    !same(profile.permissionProfile, grant.permissionProfile)
  )
    return false;
  const kinds = new Set<string>();
  const modules = new Set<string>();
  for (const channel of value.channels) {
    if (kinds.has(channel.kind) || modules.has(channel.moduleId)) return false;
    kinds.add(channel.kind);
    modules.add(channel.moduleId);
    if (channel.kind === "slack" && channel.bot.ref === channel.app.ref) return false;
  }
  // Channel order is canonical, not an alternate admission identity.
  return value.channels.length < 2 || value.channels[0]?.kind === "slack";
}

/** Closed, detached nonsecret values only. A valid result grants no use or readiness. */
export function decodeCredentialWorkloadSelectionV1(
  input: unknown,
): CredentialWorkloadSelectionDecodeV1 {
  try {
    if (!plainData(input) || !Check(CredentialWorkloadSelectionSchemaV1, input))
      return Object.freeze({ kind: "invalid" });
    const encoded = JSON.stringify(input);
    if (
      Buffer.byteLength(encoded, "utf8") > CREDENTIAL_WORKLOAD_SELECTION_LIMITS_V1.maxEncodedBytes
    )
      return Object.freeze({ kind: "invalid" });
    // Normalize permitted null-prototype records before exact correspondence checks.
    const value = immutableCopy(JSON.parse(encoded)) as CredentialWorkloadSelectionV1;
    if (!relations(value)) return Object.freeze({ kind: "invalid" });
    return Object.freeze({ kind: "valid", value });
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
}
