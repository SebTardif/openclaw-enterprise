import { createHash } from "node:crypto";
import {
  parseRuntimeAuthorityV1,
  RuntimeServiceTrustConfigurationSchemaV1,
  type RuntimeServiceTrustConfigurationV1,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ScopeViolationError } from "../errors.ts";

export const RUNTIME_SERVICE_NATIVE_LIMITS = Object.freeze({
  handshakeTimeoutMs: 3000,
  recheckIntervalMs: 1000,
  maxConnectionAgeMs: 30000,
  maxConnections: 1,
  requestTimeoutMs: 3000,
} as const);

/** Protected deployment input. This technical configuration grants no service identity. */
export type RuntimeServiceOperationPolicy = "read-operation-only-v1" | "initial-harness-bind-v1";
export interface RuntimeAuthoritySource {
  readonly schemaVersion: 1;
  readonly sourceRef: string;
  readonly workloadApiSocketPath: string;
  readonly ownSPIFFEId: string;
  readonly recipientRef: string;
  readonly recipientSPIFFEId: string;
  readonly trustDomain: string;
  readonly trustRootsRef: string;
  readonly trustBundleSha256: string;
  readonly verifierProfileRef: string;
  readonly nativeExecutableSha256: string;
  readonly transportProfileRef:
    "owned-child-stdio-readback-v1" | "owned-child-stdio-initial-harness-bind-v1";
  readonly limits: typeof RUNTIME_SERVICE_NATIVE_LIMITS;
}
export type RuntimeServiceNativeProfile = RuntimeAuthoritySource & {
  readonly sourceConfigurationDigest: string;
  readonly peerSPIFFEId: string;
} & (
    | {
        readonly transportProfileRef: "owned-child-stdio-readback-v1";
        readonly operationPolicy: "read-operation-only-v1";
      }
    | {
        readonly transportProfileRef: "owned-child-stdio-initial-harness-bind-v1";
        readonly operationPolicy: "initial-harness-bind-v1";
      }
  );

interface RuntimeServiceTrustRequestBase {
  readonly schemaVersion: 1;
  readonly operationRef: string;
  readonly expectedVersion: number | null;
}
export type RuntimeServiceTrustRequest = RuntimeServiceTrustRequestBase &
  (
    | { readonly kind: "source-admit"; readonly sourceRef: string }
    | { readonly kind: "source-withdraw"; readonly sourceRef: string }
    | {
        readonly kind: "service-admit";
        /** null only for a first admission; the server allocates its immutable identity. */
        readonly serviceIdentityRef: string | null;
        readonly sourceRef: string;
        readonly namespaceId: string;
        readonly agentId: string;
        readonly peerSPIFFEId: string;
        /** Absent only for the original closed readback admission. */
        readonly operationPolicy?: "initial-harness-bind-v1";
      }
    | { readonly kind: "service-withdraw"; readonly serviceIdentityRef: string }
  );
export type RuntimeServiceTrustSubjectKind = "source" | "service";
interface RuntimeServiceTrustRecordBase {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly operationRef: string;
  readonly subjectRef: string;
  readonly recordVersion: number;
  readonly canonicalRequest: string;
  readonly requestDigest: string;
  readonly actorId: string;
  readonly auditId: string;
  readonly committedAt: string;
}
export type RuntimeServiceTrustRecord = RuntimeServiceTrustRecordBase &
  (
    | {
        readonly kind: "source-admit";
        readonly subjectKind: "source";
        readonly source: Readonly<RuntimeAuthoritySource>;
        readonly sourceConfigurationDigest: string;
      }
    | { readonly kind: "source-withdraw"; readonly subjectKind: "source" }
    | {
        readonly kind: "service-admit";
        readonly subjectKind: "service";
        readonly sourceOperationRef: string;
        readonly sourceRecordVersion: number;
        readonly profile: Readonly<RuntimeServiceNativeProfile>;
        readonly configuration: Readonly<RuntimeServiceTrustConfigurationV1>;
      }
    | { readonly kind: "service-withdraw"; readonly subjectKind: "service" }
  );
export type RuntimeServiceTrustAdmission = Extract<
  RuntimeServiceTrustRecord,
  { kind: "service-admit" }
>;
export interface CurrentRuntimeServiceTrust {
  readonly admission: Readonly<RuntimeServiceTrustAdmission>;
  readonly sourceAdmission: Readonly<Extract<RuntimeServiceTrustRecord, { kind: "source-admit" }>>;
}
export type RuntimeServiceTrustWriteResult =
  | {
      readonly result: "applied" | "exact-replay";
      readonly record: Readonly<RuntimeServiceTrustRecord>;
    }
  | {
      readonly result: "commit-unknown";
      readonly operationRef: string;
      readonly nextAction: "exact-readback-only";
    };

// These closed JSON schemas are shared by the HTTP validator and PostgreSQL constraint.
// The pure validator below also rejects prototypes/accessors before reading field values.
type JsonSchema = Readonly<{
  type?: "object" | "string" | "integer" | "number" | "null";
  const?: string | number;
  enum?: readonly (string | number)[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  required?: readonly string[];
  properties?: Readonly<Record<string, JsonSchema>>;
  additionalProperties?: false;
  anyOf?: readonly JsonSchema[];
}>;
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const uuid: JsonSchema = { type: "string", pattern: `^${uuidPattern}$` };
const ref: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9._:/-]+$",
};
const digest: JsonSchema = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" };
const version: JsonSchema = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const nullableVersion: JsonSchema = { anyOf: [version, { type: "null" }] };
const serviceRef: JsonSchema = { type: "string", pattern: `^runtime-service/${uuidPattern}$` };
const id = (prefix: string): JsonSchema => ({
  type: "string",
  pattern: `^${prefix}_${uuidPattern}$`,
});
const literal = (value: string | number): JsonSchema => ({
  type: typeof value === "string" ? "string" : "integer",
  const: value,
});
const object = (properties: Readonly<Record<string, JsonSchema>>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const spiffe: JsonSchema = {
  type: "string",
  minLength: 10,
  maxLength: 200,
  pattern: "^spiffe://[a-z0-9._-]+/[A-Za-z0-9._/-]+$",
};
const sourceProperties = {
  schemaVersion: literal(1),
  sourceRef: ref,
  workloadApiSocketPath: {
    type: "string",
    minLength: 2,
    maxLength: 103,
    pattern: "^/[A-Za-z0-9._/-]+$",
  } as JsonSchema,
  ownSPIFFEId: spiffe,
  recipientRef: ref,
  recipientSPIFFEId: spiffe,
  trustDomain: {
    type: "string",
    minLength: 1,
    maxLength: 128,
    pattern: "^[a-z0-9._-]+$",
  } as JsonSchema,
  trustRootsRef: ref,
  trustBundleSha256: digest,
  verifierProfileRef: ref,
  nativeExecutableSha256: digest,
  transportProfileRef: literal("owned-child-stdio-readback-v1"),
  limits: object(
    Object.fromEntries(
      Object.entries(RUNTIME_SERVICE_NATIVE_LIMITS).map(([key, value]) => [key, literal(value)]),
    ),
  ),
};
const bindSourceProperties = {
  ...sourceProperties,
  transportProfileRef: literal("owned-child-stdio-initial-harness-bind-v1"),
};
export const RuntimeAuthoritySourceSchema: JsonSchema = {
  anyOf: [object(sourceProperties), object(bindSourceProperties)],
};
export const RuntimeServiceNativeProfileSchema: JsonSchema = {
  anyOf: [
    object({
      ...sourceProperties,
      operationPolicy: literal("read-operation-only-v1"),
      sourceConfigurationDigest: digest,
      peerSPIFFEId: spiffe,
    }),
    object({
      ...bindSourceProperties,
      operationPolicy: literal("initial-harness-bind-v1"),
      sourceConfigurationDigest: digest,
      peerSPIFFEId: spiffe,
    }),
  ],
};
const requestBase = {
  schemaVersion: literal(1),
  operationRef: uuid,
  expectedVersion: nullableVersion,
};
export const RuntimeServiceTrustRequestSchema: JsonSchema = {
  anyOf: [
    object({ ...requestBase, kind: literal("source-admit"), sourceRef: ref }),
    object({ ...requestBase, kind: literal("source-withdraw"), sourceRef: ref }),
    object({
      ...requestBase,
      kind: literal("service-admit"),
      serviceIdentityRef: { anyOf: [serviceRef, { type: "null" }] },
      sourceRef: ref,
      namespaceId: id("ns"),
      agentId: id("agt"),
      peerSPIFFEId: spiffe,
    }),
    object({ ...requestBase, kind: literal("service-withdraw"), serviceIdentityRef: serviceRef }),
    object({
      ...requestBase,
      kind: literal("service-admit"),
      serviceIdentityRef: { anyOf: [serviceRef, { type: "null" }] },
      sourceRef: ref,
      namespaceId: id("ns"),
      agentId: id("agt"),
      peerSPIFFEId: spiffe,
      operationPolicy: literal("initial-harness-bind-v1"),
    }),
  ],
};

const recordCommon = {
  schemaVersion: literal(1),
  installationId: id("ins"),
  operationRef: uuid,
  recordVersion: version,
  canonicalRequest: { type: "string", minLength: 1, maxLength: 8192 } as JsonSchema,
  requestDigest: digest,
  actorId: ref,
  auditId: id("aud"),
  committedAt: {
    type: "string",
    pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
  } as JsonSchema,
};
export const RuntimeServiceTrustRecordSchema: JsonSchema = {
  anyOf: [
    object({
      ...recordCommon,
      kind: literal("source-admit"),
      subjectKind: literal("source"),
      subjectRef: ref,
      source: RuntimeAuthoritySourceSchema,
      sourceConfigurationDigest: digest,
    }),
    object({
      ...recordCommon,
      kind: literal("source-withdraw"),
      subjectKind: literal("source"),
      subjectRef: ref,
    }),
    object({
      ...recordCommon,
      kind: literal("service-admit"),
      subjectKind: literal("service"),
      subjectRef: serviceRef,
      sourceOperationRef: uuid,
      sourceRecordVersion: version,
      profile: RuntimeServiceNativeProfileSchema,
      configuration: RuntimeServiceTrustConfigurationSchemaV1 as JsonSchema,
    }),
    object({
      ...recordCommon,
      kind: literal("service-withdraw"),
      subjectKind: literal("service"),
      subjectRef: serviceRef,
    }),
  ],
};

function reject(): never {
  throw new ScopeViolationError("The runtime service trust record is invalid.");
}
function plain(value: unknown, depth = 0): void {
  if (depth > 12) reject();
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) reject();
    return;
  }
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    reject();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(fields).length) reject();
  for (const descriptor of Object.values(fields)) {
    if (!descriptor.enumerable || !("value" in descriptor)) reject();
    plain(descriptor.value, depth + 1);
  }
}
function matches(value: unknown, schema: JsonSchema): boolean {
  if (schema.anyOf) return schema.anyOf.some((choice) => matches(value, choice));
  if (Object.hasOwn(schema, "const")) return value === schema.const;
  if (schema.type === "null") return value === null;
  if (schema.type === "string")
    return (
      typeof value === "string" &&
      value.length >= (schema.minLength ?? 0) &&
      value.length <= (schema.maxLength ?? 4096) &&
      (schema.pattern === undefined || new RegExp(schema.pattern).exec(value)?.[0] === value)
    );
  if (schema.type === "integer")
    return (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= (schema.minimum ?? 0) &&
      value <= (schema.maximum ?? Number.MAX_SAFE_INTEGER)
    );
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const values = value as Record<string, unknown>;
    return (
      Object.keys(values).length === schema.required?.length &&
      (schema.required ?? []).every(
        (key) => Object.hasOwn(values, key) && matches(values[key], schema.properties![key]!),
      )
    );
  }
  return false;
}
function validate<T>(value: unknown, schema: JsonSchema): Readonly<T> {
  plain(value);
  if (!matches(value, schema)) reject();
  return immutableCopy(value) as Readonly<T>;
}
export function canonicalRuntimeServiceTrust(value: unknown): string {
  plain(value);
  const encode = (input: unknown): string =>
    input === null || typeof input !== "object"
      ? JSON.stringify(input)
      : `{${Object.entries(input)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => `${JSON.stringify(key)}:${encode(child)}`)
          .join(",")}}`;
  return encode(value);
}
export function runtimeServiceTrustDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalRuntimeServiceTrust(value), "utf8").digest("hex")}`;
}
export function parseRuntimeAuthoritySource(value: unknown): Readonly<RuntimeAuthoritySource> {
  const source = validate<RuntimeAuthoritySource>(value, RuntimeAuthoritySourceSchema);
  if (
    source.ownSPIFFEId !== source.recipientSPIFFEId ||
    !source.ownSPIFFEId.startsWith(`spiffe://${source.trustDomain}/`) ||
    source.workloadApiSocketPath.split("/").some((part) => part === "." || part === "..")
  )
    reject();
  return source;
}
export function parseRuntimeServiceNativeProfile(
  value: unknown,
): Readonly<RuntimeServiceNativeProfile> {
  const profile = validate<RuntimeServiceNativeProfile>(value, RuntimeServiceNativeProfileSchema);
  const { operationPolicy: _policy, peerSPIFFEId, sourceConfigurationDigest, ...source } = profile;
  parseRuntimeAuthoritySource(source);
  if (
    !peerSPIFFEId.startsWith(`spiffe://${source.trustDomain}/`) ||
    runtimeServiceTrustDigest(source) !== sourceConfigurationDigest
  )
    reject();
  return profile;
}
export function parseRuntimeServiceTrustRequest(
  value: unknown,
): Readonly<RuntimeServiceTrustRequest> {
  const request = validate<RuntimeServiceTrustRequest>(value, RuntimeServiceTrustRequestSchema);
  if (
    (request.kind.endsWith("withdraw") && request.expectedVersion === null) ||
    (request.kind === "service-admit" &&
      (request.serviceIdentityRef === null) !== (request.expectedVersion === null))
  )
    reject();
  return request;
}

/** Storage decoder checks intrinsic consistency, never external admission/provenance. */
export function parseRuntimeServiceTrustRecord(
  value: unknown,
): Readonly<RuntimeServiceTrustRecord> {
  plain(value);
  if (!value || typeof value !== "object") reject();
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const common = {
    schemaVersion: literal(1),
    installationId: id("ins"),
    operationRef: uuid,
    subjectRef: kind === "source-admit" || kind === "source-withdraw" ? ref : serviceRef,
    recordVersion: version,
    canonicalRequest: { type: "string", minLength: 1, maxLength: 8192 } as JsonSchema,
    requestDigest: digest,
    actorId: ref,
    auditId: id("aud"),
    committedAt: {
      type: "string",
      pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
    } as JsonSchema,
  };
  const source = kind === "source-admit";
  const service = kind === "service-admit";
  const keys = [
    ...Object.keys(common),
    "kind",
    "subjectKind",
    ...(source ? ["source", "sourceConfigurationDigest"] : []),
    ...(service ? ["sourceOperationRef", "sourceRecordVersion", "profile", "configuration"] : []),
  ];
  if (
    !["source-admit", "source-withdraw", "service-admit", "service-withdraw"].includes(
      String(kind),
    ) ||
    Object.keys(record).sort().join(",") !== keys.sort().join(",") ||
    !Object.entries(common).every(([key, schema]) => matches(record[key], schema))
  )
    reject();
  let request: Readonly<RuntimeServiceTrustRequest>;
  try {
    request = parseRuntimeServiceTrustRequest(JSON.parse(String(record.canonicalRequest)));
  } catch {
    return reject();
  }
  if (
    canonicalRuntimeServiceTrust(request) !== record.canonicalRequest ||
    runtimeServiceTrustDigest(request) !== record.requestDigest ||
    request.operationRef !== record.operationRef ||
    request.kind !== kind ||
    (request.expectedVersion ?? 0) + 1 !== record.recordVersion ||
    !Number.isFinite(Date.parse(String(record.committedAt))) ||
    new Date(String(record.committedAt)).toISOString() !== record.committedAt
  )
    reject();
  if (kind === "source-admit" || kind === "source-withdraw") {
    if (
      record.subjectKind !== "source" ||
      !("sourceRef" in request) ||
      request.sourceRef !== record.subjectRef
    )
      reject();
    if (source) {
      const input = parseRuntimeAuthoritySource(record.source);
      if (
        input.sourceRef !== record.subjectRef ||
        runtimeServiceTrustDigest(input) !== record.sourceConfigurationDigest
      )
        reject();
    }
  } else {
    if (
      record.subjectKind !== "service" ||
      !("serviceIdentityRef" in request) ||
      (request.serviceIdentityRef !== null && request.serviceIdentityRef !== record.subjectRef)
    )
      reject();
    if (service) {
      if (
        request.kind !== "service-admit" ||
        !matches(record.sourceOperationRef, uuid) ||
        !matches(record.sourceRecordVersion, version)
      )
        reject();
      const profile = parseRuntimeServiceNativeProfile(record.profile);
      const configuration = parseRuntimeAuthorityV1("serviceTrust", record.configuration);
      if (
        configuration.installationId !== record.installationId ||
        configuration.serviceIdentityRef !== record.subjectRef ||
        configuration.configurationVersion !== record.recordVersion ||
        configuration.role !== "lifecycle-authority" ||
        configuration.allowedScope.kind !== "agent" ||
        configuration.allowedScope.installationId !== record.installationId ||
        configuration.allowedScope.namespaceId !== request.namespaceId ||
        configuration.allowedScope.agentId !== request.agentId ||
        configuration.serviceTrustProfileDigest !== runtimeServiceTrustDigest(profile) ||
        configuration.trustRootsRef !== profile.trustRootsRef ||
        configuration.verifierProfileRef !== profile.verifierProfileRef ||
        configuration.permittedRecipientRef !== profile.recipientRef ||
        profile.sourceRef !== request.sourceRef ||
        profile.peerSPIFFEId !== request.peerSPIFFEId ||
        profile.operationPolicy !== (request.operationPolicy ?? "read-operation-only-v1")
      )
        reject();
    }
  }
  return immutableCopy(value) as Readonly<RuntimeServiceTrustRecord>;
}
