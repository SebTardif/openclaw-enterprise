import { createHash } from "node:crypto";
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { ChannelInstallationId, KubernetesNamespaceName } from "./api/common.ts";
import { ContextKeySchemaV1 } from "./completed-context-v1.ts";
import { StoreBindingRefSchemaV1 } from "./completed-state-v1.ts";

/** Value codecs for an extension of the existing retirement barrier. Decoding
 * establishes neither current authorization nor permission to delete an object.
 */
export const RETIREMENT_PURGE_LIMITS_V1 = Object.freeze({
  maxJsonBytes: 262_144,
  maxDepth: 16,
  maxNodes: 16_384,
  maxStores: 64,
  maxRetiredIdentities: 256,
  maxReceiptReferences: 64,
});

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const reference = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:/-]+$" });
const digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const schemaVersion = Type.Literal(1);
const scope = StoreBindingRefSchemaV1.properties.scope;

/** The locator is a projection of the immutable admitted binding. Names are
 * diagnostic selectors; every destructive precondition includes the actual UID
 * or backend object version. A similarly named successor is a different object.
 */
export const PurgeStorePreconditionSchemaV1 = Type.Union([
  object({
    schemaVersion,
    kind: Type.Literal("kubernetes-volume"),
    deleteTarget: Type.Literal("persistent-volume-claim"),
    binding: StoreBindingRefSchemaV1,
    role: Type.Enum(["gateway-private", "workspace"]),
    clusterRef: reference,
    namespaceName: KubernetesNamespaceName,
    namespaceUid: reference,
    claimName: reference,
    claimUid: reference,
    volumeName: reference,
    volumeUid: reference,
    storageProfileRef: reference,
    storageProfileDigest: digest,
    mountPolicyDigest: digest,
    ownership: Type.Literal("exclusive-agent"),
  }),
  object({
    schemaVersion,
    kind: Type.Literal("configuration-object"),
    binding: StoreBindingRefSchemaV1,
    role: Type.Literal("configuration"),
    backendRef: reference,
    objectRef: reference,
    objectVersion: reference,
    contentDigest: digest,
    ownership: Type.Literal("exclusive-agent-materialization"),
  }),
]);
export type PurgeStorePreconditionV1 = Immutable<Static<typeof PurgeStorePreconditionSchemaV1>>;

/** Exact identities retired by the sole existing barrier. These values do not
 * create a new watermark or decide whether an incoming message is recent enough.
 */
export const PurgeRetiredIdentitySchemaV1 = Type.Union([
  object({
    kind: Type.Literal("route"),
    routeRef: reference,
    routeVersion: version,
    activationGeneration: version,
  }),
  object({
    kind: Type.Literal("context"),
    context: ContextKeySchemaV1,
    creationRef: reference,
    activationGeneration: version,
  }),
  object({
    kind: Type.Literal("channel-installation"),
    channelInstallationRef: ChannelInstallationId,
    installationGeneration: version,
    activationGeneration: version,
  }),
]);
export type PurgeRetiredIdentityV1 = Immutable<Static<typeof PurgeRetiredIdentitySchemaV1>>;

/** Retention exclusions are explicit. Completion concerns the named live
 * objects only, never physical erasure of backups, audit or provider messages.
 */
export const PurgeRetentionExclusionsSchemaV1 = object({
  permanentRetirementBarrier: Type.Literal("retain-installation-lifetime"),
  audit: Type.Literal("separate-retention"),
  providerMessages: Type.Literal("outside-purge"),
  backupsAndSnapshots: Type.Literal("separate-disposal"),
  sharedSecretsAndConfigurations: Type.Literal("excluded"),
  retainedBackingVolumes: Type.Literal("separate-disposal"),
});

export const PurgeStoreEntrySchemaV1 = object({
  /** Preallocated before the original destructive request; never replaced after
   * a timeout or lost response. This reference is correlation, not authority.
   */
  deletionOperationRef: reference,
  store: PurgeStorePreconditionSchemaV1,
});
export type PurgeStoreEntryV1 = Immutable<Static<typeof PurgeStoreEntrySchemaV1>>;

export const PurgeManifestBodySchemaV1 = object({
  schemaVersion,
  scope,
  purgeOperationRef: reference,
  requestRef: reference,
  manifestVersion: version,
  retiredIdentities: Type.Array(PurgeRetiredIdentitySchemaV1, {
    minItems: 1,
    maxItems: RETIREMENT_PURGE_LIMITS_V1.maxRetiredIdentities,
  }),
  stores: Type.Array(PurgeStoreEntrySchemaV1, {
    minItems: 1,
    maxItems: RETIREMENT_PURGE_LIMITS_V1.maxStores,
  }),
  retention: PurgeRetentionExclusionsSchemaV1,
});
export type PurgeManifestBodyV1 = Immutable<Static<typeof PurgeManifestBodySchemaV1>>;

/** manifestDigest hashes the complete body, including original operation and
 * request identities. There is no mutable inventory under the same operation.
 */
export const PurgeManifestSchemaV1 = object({
  ...PurgeManifestBodySchemaV1.properties,
  manifestDigest: digest,
});
export type PurgeManifestV1 = Immutable<Static<typeof PurgeManifestSchemaV1>>;

export const PurgeManifestLocatorSchemaV1 = object({
  schemaVersion,
  scope,
  purgeOperationRef: reference,
  requestRef: reference,
  manifestVersion: version,
  manifestDigest: digest,
});
export type PurgeManifestLocatorV1 = Immutable<Static<typeof PurgeManifestLocatorSchemaV1>>;

const instant = Type.String({
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
});

/** Metadata from an actual protected object observer, not a delete response.
 * Absence is scoped to the complete immutable precondition. An unknown provider
 * result, a missing list entry, or an object with a different UID is not absence.
 */
export const PurgeStoreObservationSchemaV1 = object({
  schemaVersion,
  manifest: PurgeManifestLocatorSchemaV1,
  deletionOperationRef: reference,
  store: PurgeStorePreconditionSchemaV1,
  observationRef: reference,
  observationSequence: version,
  observedAt: instant,
  evidenceRef: reference,
  outcome: Type.Enum(["observed-present", "observed-absent", "unknown"]),
});
export type PurgeStoreObservationV1 = Immutable<Static<typeof PurgeStoreObservationSchemaV1>>;

export const PurgeStoreProgressSchemaV1 = object({
  entry: PurgeStoreEntrySchemaV1,
  state: Type.Union([
    object({ kind: Type.Literal("pending"), observationSequence: Type.Literal(0) }),
    object({
      kind: Type.Enum(["observed-present", "observed-absent", "unknown"]),
      observation: PurgeStoreObservationSchemaV1,
    }),
  ]),
});
export type PurgeStoreProgressV1 = Immutable<Static<typeof PurgeStoreProgressSchemaV1>>;

/** The manifest version and digest never change as recordVersion advances.
 * Progress carries only retained facts; no read result grants deletion/release.
 */
export const PurgeProgressSchemaV1 = object({
  schemaVersion,
  manifest: PurgeManifestSchemaV1,
  recordVersion: version,
  stores: Type.Array(PurgeStoreProgressSchemaV1, {
    minItems: 1,
    maxItems: RETIREMENT_PURGE_LIMITS_V1.maxStores,
  }),
  state: Type.Enum(["purge-incomplete", "live-objects-absent"]),
});
export type PurgeProgressV1 = Immutable<Static<typeof PurgeProgressSchemaV1>>;

const schemas = {
  store: PurgeStorePreconditionSchemaV1,
  retiredIdentity: PurgeRetiredIdentitySchemaV1,
  manifestBody: PurgeManifestBodySchemaV1,
  manifest: PurgeManifestSchemaV1,
  locator: PurgeManifestLocatorSchemaV1,
  observation: PurgeStoreObservationSchemaV1,
  progress: PurgeProgressSchemaV1,
} as const;
export type RetirementPurgeKindV1 = keyof typeof schemas;
export type RetirementPurgeValueV1<K extends RetirementPurgeKindV1> = Immutable<
  Static<(typeof schemas)[K]>
>;

function invalid(): never {
  throw new TypeError("Invalid retirement purge value.");
}

/** Copy bounded own data properties before schema evaluation. Accessors, exotic
 * objects, cycles, undefined, symbols and unsafe numbers are rejected. A proxy
 * may throw during inspection; errors remain sanitized and yield no permission.
 */
function snapshot(value: unknown): unknown {
  const active = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  const visit = (input: unknown, depth: number): unknown => {
    if (
      ++nodes > RETIREMENT_PURGE_LIMITS_V1.maxNodes ||
      depth > RETIREMENT_PURGE_LIMITS_V1.maxDepth
    )
      invalid();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      if (/[\ud800-\udfff]/u.test(input)) invalid();
      bytes += Buffer.byteLength(input, "utf8");
      if (bytes > RETIREMENT_PURGE_LIMITS_V1.maxJsonBytes) invalid();
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isSafeInteger(input) || Object.is(input, -0)) invalid();
      return input;
    }
    if (typeof input !== "object" || active.has(input)) invalid();
    active.add(input);
    const array = Array.isArray(input);
    const proto = Object.getPrototypeOf(input);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > RETIREMENT_PURGE_LIMITS_V1.maxNodes - nodes + 1) invalid();
    if (array) {
      const length = descriptors.length;
      if (!length || !("value" in length) || !Number.isSafeInteger(length.value)) invalid();
      if (length.value > RETIREMENT_PURGE_LIMITS_V1.maxNodes || keys.length !== length.value + 1)
        invalid();
      const result: unknown[] = [];
      for (let i = 0; i < length.value; i++) {
        const d = descriptors[String(i)];
        if (!d || !("value" in d) || !d.enumerable) invalid();
        result.push(visit(d.value, depth + 1));
      }
      active.delete(input);
      return Object.freeze(result);
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string" || /[\ud800-\udfff]/u.test(key)) invalid();
      bytes += Buffer.byteLength(key, "utf8");
      if (bytes > RETIREMENT_PURGE_LIMITS_V1.maxJsonBytes) invalid();
      const d = descriptors[key];
      if (!d || !("value" in d) || !d.enumerable) invalid();
      result[key] = visit(d.value, depth + 1);
    }
    active.delete(input);
    return Object.freeze(result);
  };
  try {
    const result = visit(value, 0);
    if (Buffer.byteLength(canonical(result), "utf8") > RETIREMENT_PURGE_LIMITS_V1.maxJsonBytes)
      invalid();
    return result;
  } catch {
    return invalid();
  }
}

/** All admitted keys and reference values are ASCII; ordered arrays retain their
 * exact order. This is the sole encoding used for this manifest's digest input.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function bodyOf(manifest: PurgeManifestV1): PurgeManifestBodyV1 {
  const { manifestDigest: _digest, ...body } = manifest;
  return body;
}

function digestBody(body: PurgeManifestBodyV1): string {
  return `sha256:${createHash("sha256").update("retirement-purge-manifest-v1\n").update(canonical(body), "utf8").digest("hex")}`;
}

function locatorOf(manifest: PurgeManifestV1): PurgeManifestLocatorV1 {
  return {
    schemaVersion: 1,
    scope: manifest.scope,
    purgeOperationRef: manifest.purgeOperationRef,
    requestRef: manifest.requestRef,
    manifestVersion: manifest.manifestVersion,
    manifestDigest: manifest.manifestDigest,
  };
}

function intrinsic(kind: RetirementPurgeKindV1, value: unknown): void {
  if (kind === "manifestBody" || kind === "manifest") {
    const manifest = value as PurgeManifestV1;
    const stores = new Set<string>();
    const objects = new Set<string>();
    const operations = new Set<string>();
    for (const entry of manifest.stores) {
      if (!same(entry.store.binding.scope, manifest.scope)) invalid();
      const key = entry.store.binding.logicalStoreRef;
      const s = entry.store;
      const objectKey =
        s.kind === "kubernetes-volume"
          ? canonical([s.clusterRef, s.namespaceUid, s.claimUid])
          : canonical([s.backendRef, s.objectRef]);
      if (stores.has(key) || objects.has(objectKey) || operations.has(entry.deletionOperationRef))
        invalid();
      stores.add(key);
      objects.add(objectKey);
      operations.add(entry.deletionOperationRef);
    }
    const retired = new Set<string>();
    for (const identity of manifest.retiredIdentities) {
      let key: string;
      if (identity.kind === "context") {
        const c = identity.context;
        if (
          c.installationRef !== manifest.scope.installationId ||
          c.namespaceRef !== manifest.scope.namespaceId ||
          c.agentRef !== manifest.scope.agentId
        )
          invalid();
        key = `context:${c.conversationRef}`;
      } else
        key =
          identity.kind === "route"
            ? `route:${identity.routeRef}`
            : `channel:${identity.channelInstallationRef}`;
      if (retired.has(key)) invalid();
      retired.add(key);
    }
    if (kind === "manifest" && manifest.manifestDigest !== digestBody(bodyOf(manifest))) invalid();
  }
  if (kind === "observation") {
    const observation = value as PurgeStoreObservationV1;
    if (!same(observation.store.binding.scope, observation.manifest.scope)) invalid();
    const time = Date.parse(observation.observedAt);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== observation.observedAt)
      invalid();
  }
  if (kind === "progress") {
    const progress = value as PurgeProgressV1;
    intrinsic("manifest", progress.manifest);
    if (progress.stores.length !== progress.manifest.stores.length) invalid();
    for (let i = 0; i < progress.stores.length; i++) {
      const row = progress.stores[i];
      if (!row) invalid();
      if (!same(row.entry, progress.manifest.stores[i])) invalid();
      if (row.state.kind !== "pending") {
        const observation = row.state.observation;
        intrinsic("observation", observation);
        if (
          row.state.kind !== observation.outcome ||
          !same(observation.manifest, locatorOf(progress.manifest)) ||
          !same(observation.store, row.entry.store) ||
          observation.deletionOperationRef !== row.entry.deletionOperationRef
        )
          invalid();
      }
    }
    const absent = progress.stores.every((row) => row.state.kind === "observed-absent");
    if ((progress.state === "live-objects-absent") !== absent) invalid();
  }
}

export function parseRetirementPurgeV1<K extends RetirementPurgeKindV1>(
  kind: K,
  value: unknown,
): RetirementPurgeValueV1<K> {
  try {
    if (!Object.hasOwn(schemas, kind)) invalid();
    const schema: TSchema | undefined = schemas[kind];
    if (!schema) invalid();
    const copy = snapshot(value);
    if (!Check(schema, copy)) invalid();
    intrinsic(kind, copy);
    return copy as RetirementPurgeValueV1<K>;
  } catch {
    return invalid();
  }
}

/** The wire format is exactly the canonical encoding, without insignificant
 * whitespace, alternate escapes or duplicate keys. Bound bytes before parsing.
 */
export function parseRetirementPurgeJsonV1<K extends RetirementPurgeKindV1>(
  kind: K,
  json: string,
): RetirementPurgeValueV1<K> {
  try {
    if (
      typeof json !== "string" ||
      /[\ud800-\udfff]/u.test(json) ||
      Buffer.byteLength(json, "utf8") > RETIREMENT_PURGE_LIMITS_V1.maxJsonBytes
    )
      invalid();
    const result = parseRetirementPurgeV1(kind, JSON.parse(json));
    if (canonical(result) !== json) invalid();
    return result;
  } catch {
    return invalid();
  }
}

export function encodeRetirementPurgeV1<K extends RetirementPurgeKindV1>(
  kind: K,
  value: RetirementPurgeValueV1<K>,
): string {
  return canonical(parseRetirementPurgeV1(kind, value));
}

export function createPurgeManifestV1(body: PurgeManifestBodyV1): PurgeManifestV1 {
  const parsed = parseRetirementPurgeV1("manifestBody", body);
  return parseRetirementPurgeV1("manifest", { ...parsed, manifestDigest: digestBody(parsed) });
}

export function purgeManifestLocatorV1(manifest: PurgeManifestV1): PurgeManifestLocatorV1 {
  return parseRetirementPurgeV1("locator", locatorOf(parseRetirementPurgeV1("manifest", manifest)));
}

export function initialPurgeProgressV1(manifest: PurgeManifestV1): PurgeProgressV1 {
  const parsed = parseRetirementPurgeV1("manifest", manifest);
  return parseRetirementPurgeV1("progress", {
    schemaVersion: 1,
    manifest: parsed,
    recordVersion: 1,
    stores: parsed.stores.map((entry) => ({
      entry,
      state: { kind: "pending", observationSequence: 0 },
    })),
    state: "purge-incomplete",
  });
}

export type PurgeProgressComparisonV1 = Readonly<{
  kind: "advance" | "existing" | "conflict";
}>;

/** Pure consistency comparison only. Actual provenance inspection and CAS belong
 * to the original lifecycle transaction; this function mutates no durable state.
 */
export function comparePurgeProgressV1(
  previous: PurgeProgressV1,
  candidate: PurgeProgressV1,
  expectedRecordVersion: number,
): PurgeProgressComparisonV1 {
  const before = parseRetirementPurgeV1("progress", previous);
  const after = parseRetirementPurgeV1("progress", candidate);
  if (!same(before.manifest, after.manifest)) return { kind: "conflict" };
  if (same(before, after)) return { kind: "existing" };
  if (
    before.recordVersion !== expectedRecordVersion ||
    before.recordVersion === Number.MAX_SAFE_INTEGER ||
    after.recordVersion !== before.recordVersion + 1
  )
    return { kind: "conflict" };
  let changed = 0;
  for (let i = 0; i < before.stores.length; i++) {
    const beforeRow = before.stores[i];
    const afterRow = after.stores[i];
    if (!beforeRow || !afterRow) return { kind: "conflict" };
    const a = beforeRow.state;
    const b = afterRow.state;
    if (same(a, b)) continue;
    changed++;
    if (a.kind === "observed-absent" || b.kind === "pending") return { kind: "conflict" };
    const oldSequence = a.kind === "pending" ? 0 : a.observation.observationSequence;
    if (
      oldSequence === Number.MAX_SAFE_INTEGER ||
      b.observation.observationSequence !== oldSequence + 1
    )
      return { kind: "conflict" };
    if (
      a.kind !== "pending" &&
      (a.observation.observationRef === b.observation.observationRef ||
        Date.parse(b.observation.observedAt) < Date.parse(a.observation.observedAt))
    )
      return { kind: "conflict" };
  }
  return { kind: changed === 1 ? "advance" : "conflict" };
}
