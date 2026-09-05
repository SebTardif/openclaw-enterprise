import { Type, type Static, type TProperties } from "typebox";
import { BindRuntimeSchemaV1, type RuntimeAuthorityScopeV1 } from "./runtime-authority-v1.ts";

const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const ref = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:/-]+$" });
const digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const name = Type.String({ minLength: 1, maxLength: 253, pattern: "^[a-z0-9][a-z0-9.-]*$" });
const scope = Type.Pick(BindRuntimeSchemaV1.properties.target, [
  "installationId",
  "namespaceId",
  "agentId",
]);

/** Immutable OCC store locator. Parsing it grants neither mount nor purge authority.
 * The IDs are the same canonical OCC identities used by runtime authority, not new aliases.
 */
export const StoreBindingRefSchemaV1 = object({
  schemaVersion: Type.Literal(1),
  scope,
  logicalStoreRef: ref,
  bindingRef: ref,
  bindingVersion: version,
});
export type StoreBindingRefV1 = Static<typeof StoreBindingRefSchemaV1>;
export type StoreOwnerScopeV1 = RuntimeAuthorityScopeV1;

const subpath = object({
  category: Type.Enum([
    "workspace",
    "state",
    "agent",
    "media",
    "sessions",
    "generated-images",
    "bundled-skills",
    "plugin-skills",
  ]),
  relativePath: Type.String({
    minLength: 1,
    maxLength: 512,
    pattern: "^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)[A-Za-z0-9._/-]+(?<!/)$",
  }),
  readOnly: Type.Boolean(),
  component: Type.Enum(["gateway", "harness"]),
});

/** Admitted storage policy, not a live mount observation or a durability certificate.
 * Runtime replacement does not rewrite this binding. Actual mount identity belongs in
 * separately authenticated evidence for the exact target/execution and binding version.
 * The local ext4/RWO profile is closed; another filesystem requires a new admitted variant.
 */
export const StoreBindingSchemaV1 = Type.Union([
  object({
    schemaVersion: Type.Literal(1),
    kind: Type.Literal("kubernetes-volume"),
    ref: StoreBindingRefSchemaV1,
    role: Type.Enum(["gateway-private", "workspace"]),
    clusterRef: ref,
    namespaceName: name,
    namespaceUid: ref,
    claimName: name,
    claimUid: ref,
    volumeName: name,
    volumeUid: ref,
    storageProfileRef: ref,
    storageProfileDigest: digest,
    filesystem: Type.Literal("ext4"),
    accessMode: Type.Literal("ReadWriteOnce"),
    volumeMode: Type.Literal("Filesystem"),
    nodeIdentity: object({ nodeRef: ref, nodeUid: ref, affinityProfileDigest: digest }),
    mountPolicyDigest: digest,
    approvedSubpaths: Type.Array(subpath, { minItems: 1, maxItems: 16 }),
    ownership: object({
      uid: Type.Literal(1000),
      gid: Type.Literal(1000),
      fsGroup: Type.Literal(1000),
    }),
  }),
  object({
    schemaVersion: Type.Literal(1),
    kind: Type.Literal("configuration-object"),
    ref: StoreBindingRefSchemaV1,
    role: Type.Literal("configuration"),
    backendRef: ref,
    objectRef: ref,
    objectVersion: ref,
    contentDigest: digest,
    storageProfileRef: ref,
    storageProfileDigest: digest,
  }),
]);
export type StoreBindingV1 = Static<typeof StoreBindingSchemaV1>;

/** Intrinsic policy consistency for values AFTER a strict StoreBindingSchemaV1
 * decode. Shared consumers call this after their bounded plain-data/schema checks;
 * it does not inspect an untrusted object safely by itself or prove actual mounts.
 */
export function storeBindingPolicyConsistentV1(value: StoreBindingV1): boolean {
  if (value.kind === "configuration-object") return true;
  const entries = value.approvedSubpaths;
  const keys = entries.map((entry) => `${entry.category}:${entry.component}`);
  if (new Set(keys).size !== keys.length) return false;
  if (value.role === "gateway-private" && entries.some((entry) => entry.component === "harness"))
    return false;
  return value.role !== "workspace" || entries.some((entry) => entry.category === "workspace");
}
