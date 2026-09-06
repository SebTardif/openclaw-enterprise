import { types as nodeTypes } from "node:util";
import { Type, type Static, type TProperties } from "typebox";
import { Check } from "typebox/value";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { KubernetesNamespaceName } from "./api/common.ts";
import type { SecretDriver } from "./drivers/secret.ts";
import type { AccountVersionVectorV1 } from "./account-authority-v1.ts";
import { SECURITY_EVENT_POLICY } from "./security-events.ts";
import {
  CREDENTIAL_STORAGE_LIMITS_V1,
  CredentialCachePartitionSchemaV1,
  CredentialSecretBindingSchemaV1,
  CredentialStorageBackendRequirementsSchemaV1,
  parseCredentialStorageV1,
  type CredentialCachePartitionV1,
  type CredentialSecretBindingV1,
  type CredentialStorageBackendRequirementsV1,
  type CredentialStorageDependenciesV1,
  type OutstandingTokenInventoryPortV1,
  type ProtectedCredentialPortV1,
  type ProtectedModelBindingV1,
} from "./credential-storage-v1.ts";

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const versionedRef = CredentialSecretBindingSchemaV1.properties.account;
const ref = CredentialSecretBindingSchemaV1.properties.bindingRef;
const limits = CREDENTIAL_STORAGE_LIMITS_V1;

/** Mapping representation limits are smaller than the storage request allowance.
 * The complete storage bounds remain unchanged, including audit/retention policy.
 */
export const CREDENTIAL_BACKEND_PROFILE_LIMITS_V1 = Object.freeze({
  maxProfileBytes: 16_384,
  maxNodes: 2048,
  maxObjectKeys: 64,
  maxStringCharacters: 1024,
  maxJsonDepth: limits.maxJsonDepth,
});
export const CredentialBackendBoundsSchemaV1 = object({
  maxRequestBytes: Type.Literal(limits.maxRequestBytes),
  maxResponseBytes: Type.Literal(limits.maxResponseBytes),
  maxJsonDepth: Type.Literal(limits.maxJsonDepth),
  maxMaterialBytes: Type.Literal(limits.maxMaterialBytes),
  maxTokenBytes: Type.Literal(limits.maxTokenBytes),
  maxMaterialCacheEntries: Type.Literal(limits.maxMaterialCacheEntries),
  maxMaterialCacheBytes: Type.Literal(limits.maxMaterialCacheBytes),
  materialCacheMaxAgeMs: Type.Literal(limits.materialCacheMaxAgeMs),
  maxInventoryPageItems: Type.Literal(limits.maxInventoryPageItems),
  maxRepositoryIds: Type.Literal(limits.maxRepositoryIds),
  maxPermissions: Type.Literal(limits.maxPermissions),
  maxCursorBytes: Type.Literal(limits.maxCursorBytes),
  maxOutstandingPerAgent: Type.Literal(limits.maxOutstandingPerAgent),
  maxOutstandingPerInstallation: Type.Literal(limits.maxOutstandingPerInstallation),
  maxConcurrentIssuancePerScope: Type.Literal(limits.maxConcurrentIssuancePerScope),
  maxCallMs: Type.Literal(limits.maxCallMs),
  revocationClaimLeaseMs: Type.Literal(limits.revocationClaimLeaseMs),
  revokeAttemptDeadlineMs: Type.Literal(limits.revokeAttemptDeadlineMs),
  revokeAttemptsPerBurst: Type.Literal(limits.revokeAttemptsPerBurst),
  revokeBackoffMs: Type.Tuple(limits.revokeBackoffMs.map((value) => Type.Literal(value))),
  revokeLaterRetryMinIntervalMs: Type.Literal(limits.revokeLaterRetryMinIntervalMs),
  maxClockUncertaintyMs: Type.Literal(limits.maxClockUncertaintyMs),
  githubRefreshMarginMs: Type.Literal(limits.githubRefreshMarginMs),
  expirySafetyMarginMs: Type.Literal(limits.expirySafetyMarginMs),
  auditAppendDeadlineMs: Type.Literal(SECURITY_EVENT_POLICY.appendDeadlineMs),
  terminalRetentionMs: Type.Literal(limits.terminalRetentionMs),
  snapshotMaxAgeMs: Type.Literal(limits.snapshotMaxAgeMs),
});

/** The status describes an owner-supplied implementation declaration. Even a
 * supported declaration and its evidence reference are not verified by this module.
 */
export const CredentialBackendCapabilitySchemaV1 = Type.Union([
  object({ status: Type.Literal("supported"), adapter: versionedRef, evidenceRef: ref }),
  object({
    status: Type.Enum(["unsupported", "unproved"]),
    reason: Type.Enum([
      "adapter-unprovided",
      "capability-unimplemented",
      "evidence-unprovided",
      "owner-integration-unproved",
    ]),
  }),
]);
export type CredentialBackendCapabilityV1 = Immutable<
  Static<typeof CredentialBackendCapabilitySchemaV1>
>;

/** Fixed capability-to-owner mapping. Metadata-only named resolution is only one
 * ingredient of authenticated protected access, not a supported claim for it.
 */
export const CREDENTIAL_BACKEND_CAPABILITY_OWNERS_V1 = Object.freeze({
  externalCustody: "custody",
  authenticatedExactNamedAccess: "namedSecret",
  versionedReadAndRotation: "namedSecret",
  protectedEncryptionAndKeyCustody: "custody",
  durableCompareAndSet: "inventory",
  durableIntentBeforeMint: "inventory",
  inventoryAndDeliveryIntentBeforeRelease: "inventory",
  restartCompleteAffectedSnapshots: "inventory",
  exactUnknownOperationReadback: "inventory",
  auditCoupling: "inventory",
  independentPreauthorizedMitigation: "inventory",
} as const satisfies Record<
  Exclude<keyof CredentialStorageBackendRequirementsV1, "schemaVersion">,
  string
>);
export type CredentialBackendCapabilityNameV1 =
  keyof typeof CREDENTIAL_BACKEND_CAPABILITY_OWNERS_V1;
const capabilityProperties = {
  externalCustody: CredentialBackendCapabilitySchemaV1,
  authenticatedExactNamedAccess: CredentialBackendCapabilitySchemaV1,
  versionedReadAndRotation: CredentialBackendCapabilitySchemaV1,
  protectedEncryptionAndKeyCustody: CredentialBackendCapabilitySchemaV1,
  durableCompareAndSet: CredentialBackendCapabilitySchemaV1,
  durableIntentBeforeMint: CredentialBackendCapabilitySchemaV1,
  inventoryAndDeliveryIntentBeforeRelease: CredentialBackendCapabilitySchemaV1,
  restartCompleteAffectedSnapshots: CredentialBackendCapabilitySchemaV1,
  exactUnknownOperationReadback: CredentialBackendCapabilitySchemaV1,
  auditCoupling: CredentialBackendCapabilitySchemaV1,
  independentPreauthorizedMitigation: CredentialBackendCapabilitySchemaV1,
} satisfies Record<CredentialBackendCapabilityNameV1, typeof CredentialBackendCapabilitySchemaV1>;

export const CredentialBackendProfileSchemaV1 = object({
  schemaVersion: Type.Literal(1),
  kind: Type.Literal("credential-backend-profile-v1"),
  profile: versionedRef,
  requirements: CredentialStorageBackendRequirementsSchemaV1,
  placement: object({
    kind: Type.Literal("local-typescript"),
    trustedServiceRef: ref,
    serviceIdentity: Type.String({
      minLength: 1,
      maxLength: 200,
      pattern: "^spiffe://[a-z0-9.-]+/[A-Za-z0-9._/-]+$",
    }),
    materialBoundary: Type.Literal("outside-agent-execution"),
    handleTransport: Type.Literal("in-process-only"),
  }),
  namedSecret: object({
    kind: Type.Literal("kubernetes-secret-driver"),
    adapter: versionedRef,
    binding: CredentialSecretBindingSchemaV1,
    clusterBindingRef: ref,
    namespaceName: KubernetesNamespaceName,
    name: Type.String({
      minLength: 1,
      maxLength: 253,
      pattern: "^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$",
    }),
    key: Type.String({ minLength: 1, maxLength: 253, pattern: "^[A-Za-z0-9._-]+$" }),
    uid: ref,
    resourceVersion: ref,
    immutableVersionRecord: versionedRef,
    versionPolicy: Type.Literal("immutable-protected-version"),
    rotation: Type.Literal("stage-version-then-binding-cas-invalidation-scan"),
  }),
  inventory: object({
    kind: Type.Literal("postgresql-ambient-owner"),
    adapter: versionedRef,
    installationId: CredentialSecretBindingSchemaV1.properties.scope.properties.installationId,
    databaseBindingRef: ref,
    journalBindingRef: ref,
    unitOfWorkBindingRef: ref,
    auditBindingRef: ref,
    transaction: Type.Literal("same-borrowed-client-lifetime-and-poisoning"),
    auditCoupling: Type.Literal("same-transaction"),
    callbackGate: Type.Literal("owner-known-outer-commit-before-callback"),
    uncertainty: Type.Literal("exact-original-readback-no-blind-retry"),
    capacity: Type.Literal("deny-new-work-retain-unresolved"),
    terminalRetention: Type.Literal("minimum-separate-from-audit-copy"),
  }),
  custody: Type.Union([
    object({ kind: Type.Literal("unprovided") }),
    object({
      kind: Type.Literal("external-protected-adapter"),
      adapter: versionedRef,
      materialBindingRef: ref,
      tokenBindingRef: ref,
      revocationBindingRef: ref,
      encryptionAndKeyCustodyProfile: versionedRef,
    }),
  ]),
  cachePartition: CredentialCachePartitionSchemaV1,
  bounds: CredentialBackendBoundsSchemaV1,
  capabilities: object(capabilityProperties),
});
export type CredentialBackendProfileV1 = Immutable<Static<typeof CredentialBackendProfileSchemaV1>>;

/** Actual local ports retain their owners' nominal handles, callbacks, CAS and
 * outcome types. This declaration creates no adapter, transaction or authority.
 * The existing owner must withhold callbacks until the outer commit is known;
 * an uncommitted ambient method return cannot satisfy that obligation.
 */
export interface CredentialBackendLocalBindingsV1 {
  readonly profile: CredentialBackendProfileV1;
  readonly dependencies: CredentialStorageDependenciesV1 & { readonly secretDriver: SecretDriver };
  readonly protectedCredentials: ProtectedCredentialPortV1;
  readonly inventory: OutstandingTokenInventoryPortV1;
}
/** Account versions remain the existing account owner's projection, never a
 * serialized authority handle or a currentness cache. Model binding is canonical.
 */
export interface CredentialBackendModelProjectionV1 {
  readonly accountVersions: AccountVersionVectorV1;
  readonly binding: CredentialSecretBindingV1;
  readonly modelBinding: ProtectedModelBindingV1;
  readonly cachePartition: Extract<CredentialCachePartitionV1, { purpose: "model-use" }>;
}

export class CredentialBackendProfileErrorV1 extends Error {
  constructor() {
    super("Invalid credential backend profile V1.");
    this.name = "CredentialBackendProfileErrorV1";
  }
}

function plainJson(
  value: unknown,
  stack = new Set<object>(),
  depth = 0,
  budget = { nodes: 0 },
): boolean {
  const cap = CREDENTIAL_BACKEND_PROFILE_LIMITS_V1;
  if (depth > cap.maxJsonDepth || ++budget.nodes > cap.maxNodes) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= cap.maxStringCharacters;
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
  if (typeof value !== "object" || nodeTypes.isProxy(value) || stack.has(value)) return false;
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
    return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > cap.maxObjectKeys || (array && keys.length !== value.length + 1)) return false;
  stack.add(value);
  for (const key of keys) {
    if (typeof key !== "string" || key.length > cap.maxStringCharacters) return false;
    if (array && key === "length") continue;
    if (array && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) return false;
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
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function equal(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

/** Parse representation and cross-binding consistency only. No backend calls,
 * evidence resolution, positive authority, admission or runtime attestation.
 */
export function parseCredentialBackendProfileV1(input: unknown): CredentialBackendProfileV1 {
  try {
    if (
      !plainJson(input) ||
      new TextEncoder().encode(JSON.stringify(input)).byteLength >
        CREDENTIAL_BACKEND_PROFILE_LIMITS_V1.maxProfileBytes ||
      !Check(CredentialBackendProfileSchemaV1, input)
    )
      throw new CredentialBackendProfileErrorV1();
    const value = input as CredentialBackendProfileV1;
    const binding = parseCredentialStorageV1("secretBinding", value.namedSecret.binding);
    const partition = parseCredentialStorageV1("cachePartition", value.cachePartition);
    parseCredentialStorageV1("backendRequirements", value.requirements);
    if (
      !equal(binding, partition.binding) ||
      binding.scope.installationId !== value.inventory.installationId ||
      value.namedSecret.immutableVersionRecord.version !== binding.secretVersion ||
      value.requirements.auditCoupling !== value.inventory.auditCoupling ||
      !equal(value.bounds, limits)
    )
      throw new CredentialBackendProfileErrorV1();
    for (const name of Object.keys(
      CREDENTIAL_BACKEND_CAPABILITY_OWNERS_V1,
    ) as CredentialBackendCapabilityNameV1[]) {
      const capability = value.capabilities[name];
      if (capability.status !== "supported") continue;
      const owner = value[CREDENTIAL_BACKEND_CAPABILITY_OWNERS_V1[name]];
      if (!("adapter" in owner) || !equal(capability.adapter, owner.adapter))
        throw new CredentialBackendProfileErrorV1();
    }
    return immutableCopy(value);
  } catch {
    throw new CredentialBackendProfileErrorV1();
  }
}

/** JSON.parse checks grammar; this bounded pass prevents duplicate decoded keys
 * and numeric rounding from changing version/limit semantics before validation.
 */
function checkLexemes(text: string): void {
  let at = 0;
  const space = () => {
    while (at < text.length && /\s/.test(text[at]!)) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === "\\") at++;
      else if (c === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw new CredentialBackendProfileErrorV1();
  };
  const visit = (depth: number): void => {
    if (depth > CREDENTIAL_BACKEND_PROFILE_LIMITS_V1.maxJsonDepth)
      throw new CredentialBackendProfileErrorV1();
    space();
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === "{" || text[at] === "[") {
      const isObject = text[at++] === "{";
      const end = isObject ? "}" : "]";
      const keys = new Set<string>();
      space();
      if (text[at] === end) {
        at++;
        return;
      }
      for (;;) {
        if (isObject) {
          space();
          const key = string();
          if (keys.has(key)) throw new CredentialBackendProfileErrorV1();
          keys.add(key);
          space();
          at++;
        }
        visit(depth + 1);
        space();
        if (text[at++] === end) return;
      }
    }
    const start = at;
    while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++;
    const token = text.slice(start, at);
    if (token === "true" || token === "false" || token === "null") return;
    if (!/^(?:0|[1-9][0-9]*)$/.test(token) || !Number.isSafeInteger(Number(token)))
      throw new CredentialBackendProfileErrorV1();
  };
  visit(0);
}
export function parseCredentialBackendProfileJsonV1(text: string): CredentialBackendProfileV1 {
  try {
    const max = CREDENTIAL_BACKEND_PROFILE_LIMITS_V1.maxProfileBytes;
    if (
      typeof text !== "string" ||
      text.length > max ||
      new TextEncoder().encode(text).byteLength > max
    )
      throw new CredentialBackendProfileErrorV1();
    const input: unknown = JSON.parse(text);
    checkLexemes(text);
    return parseCredentialBackendProfileV1(input);
  } catch {
    throw new CredentialBackendProfileErrorV1();
  }
}

export type CredentialBackendAssessmentV1 = Readonly<{
  kind: "compatible-declaration" | "incomplete-declaration";
  missingCapabilities: readonly CredentialBackendCapabilityNameV1[];
  runtimeAttestation: "not-established";
  authority: "not-granted";
}>;
/** Supported claims can describe compatibility, never activation or proof. Every
 * required capability must name the exact selected adapter; absent custody stays
 * incomplete. Callers must obtain actual owner implementation/runtime acceptance.
 */
export function assessCredentialBackendProfileV1(input: unknown): CredentialBackendAssessmentV1 {
  const value = parseCredentialBackendProfileV1(input);
  const missing = (
    Object.keys(CREDENTIAL_BACKEND_CAPABILITY_OWNERS_V1) as CredentialBackendCapabilityNameV1[]
  ).filter((name) => value.capabilities[name].status !== "supported");
  return Object.freeze({
    kind: missing.length === 0 ? "compatible-declaration" : "incomplete-declaration",
    missingCapabilities: Object.freeze(missing),
    runtimeAttestation: "not-established",
    authority: "not-granted",
  });
}
