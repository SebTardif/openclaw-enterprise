import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { types } from "node:util";
import {
  AgentId,
  AgentParams,
  AuditId,
  InstallationId,
  NamespaceId,
  RequestId,
  RevisionId,
  Timestamp,
} from "./api/common.ts";
import type { AuditEvent } from "./identity/audit.ts";
import type { RuntimeIntent, RuntimeScope } from "./runtime-assignment.ts";

/** Local data contracts only. Decoding establishes neither admission nor authority. */
export const LIFECYCLE_ADMISSION_LIMITS_V1 = Object.freeze({
  maxJsonBytes: 65_536,
  maxDepth: 20,
  maxNodes: 4_096,
  maxContainerEntries: 128,
  maxWorkIdCharacters: 512,
});

const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const version = Type.Literal(1);
const generation = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const expectedGeneration = Type.Union([Type.Null(), generation]);
// These imported primitive schemas are copied before freezing our registry so
// publishing this module cannot freeze another module's exported objects.
const namespaceId = { ...NamespaceId };
const agentId = { ...AgentId };
const installationId = { ...InstallationId };
const revisionId = { ...RevisionId };
const auditId = { ...AuditId };
const requestId = { ...RequestId };
const timestamp = { ...Timestamp };
const operationRef = Type.String({
  minLength: 36,
  maxLength: 36,
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const actorId = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:/-]+$" });
const workId = Type.String({
  minLength: 1,
  maxLength: LIFECYCLE_ADMISSION_LIMITS_V1.maxWorkIdCharacters,
  pattern: "^\\S(?:[^\\u0000-\\u001f\\u007f-\\u009f]*\\S)?$",
});
const revisionSource = Type.Union([Type.Literal("retained"), Type.Literal("saved-draft")]);

export const LifecycleScopeSchemaV1 = object({
  namespaceId: { ...AgentParams.properties.namespaceId },
  agentId: { ...AgentParams.properties.agentId },
});
export type LifecycleScopeV1 = Readonly<RuntimeScope>;

/** The HTTP generation body has no actor, Installation, locator or implied default. */
export const LifecycleGenerationBodySchemaV1 = object({
  expectedLifecycleGeneration: expectedGeneration,
});
export type LifecycleGenerationBodyV1 = Readonly<Static<typeof LifecycleGenerationBodySchemaV1>>;
export const LifecycleResumeBodySchemaV1 = object({
  expectedLifecycleGeneration: expectedGeneration,
  revisionSource,
});
export type LifecycleResumeBodyV1 = Readonly<Static<typeof LifecycleResumeBodySchemaV1>>;

const requestProperties = {
  schemaVersion: version,
  namespaceId,
  agentId,
  expectedLifecycleGeneration: expectedGeneration,
};
/** In-process route selection plus untrusted scoped body data, never a trusted call. */
export const LifecycleMutationRequestSchemaV1 = Type.Union([
  object({ ...requestProperties, kind: Type.Literal("deploy") }),
  object({ ...requestProperties, kind: Type.Literal("disable") }),
  object({ ...requestProperties, kind: Type.Literal("stop") }),
  object({ ...requestProperties, kind: Type.Literal("resume"), revisionSource }),
]);
export type LifecycleMutationRequestV1 = Readonly<Static<typeof LifecycleMutationRequestSchemaV1>>;

const intentProperties = {
  installationId,
  namespaceId,
  agentId,
  transitionRef: operationRef,
  generation,
  actorId,
  requestId,
  createdAt: timestamp,
};
export const LifecycleIntentSchemaV1 = Type.Union([
  object({ ...intentProperties, desiredMode: Type.Literal("running"), revisionId }),
  object({
    ...intentProperties,
    desiredMode: Type.Union([Type.Literal("disabled"), Type.Literal("stopped")]),
    revisionId: Type.Union([revisionId, Type.Null()]),
  }),
]);
/** The canonical intent. Only retained history establishes unselected null lineage. */
export type LifecycleIntentV1 = RuntimeIntent;

const headProperties = { operationRef, lifecycleGeneration: generation };
/** Nonnull head subdocument only. The enclosing read port represents no head as
 * null; an observed runtime state never supplies these canonical intent fields. */
export const LifecycleIntentHeadProjectionSchemaV1 = Type.Union([
  object({
    ...headProperties,
    desiredMode: Type.Literal("running"),
    requestedRevisionId: revisionId,
  }),
  object({
    ...headProperties,
    desiredMode: Type.Union([Type.Literal("disabled"), Type.Literal("stopped")]),
    requestedRevisionId: Type.Union([revisionId, Type.Null()]),
  }),
]);
export type LifecycleIntentHeadProjectionV1 = Readonly<
  Static<typeof LifecycleIntentHeadProjectionSchemaV1>
>;

export const LifecycleAdmissionAssociationSchemaV1 = object({
  schemaVersion: version,
  request: LifecycleMutationRequestSchemaV1,
  intent: LifecycleIntentSchemaV1,
  auditEventId: auditId,
  workId,
});
/** Immutable association data, not independent evidence that its rows committed.
 * workId is the original durable work idempotency identity, not a transition ID.
 * Fresh storage must verify the exact original audit/work/revision association,
 * predecessor-mode legality and retained revision. Required predecessor-cleanup
 * responsibility still belongs to that same authority transaction. */
export interface LifecycleAdmissionAssociationV1 {
  readonly schemaVersion: 1;
  readonly request: LifecycleMutationRequestV1;
  readonly intent: LifecycleIntentV1;
  readonly auditEventId: AuditEvent["id"];
  readonly workId: string;
}

const operationProperties = {
  operationRef,
  lifecycleGeneration: generation,
  acceptedAt: timestamp,
};
const operationVariants = [
  {
    ...operationProperties,
    kind: Type.Literal("deploy"),
    revisionSource: Type.Literal("saved-draft"),
    desiredMode: Type.Literal("running"),
  },
  {
    ...operationProperties,
    kind: Type.Literal("disable"),
    revisionSource: Type.Null(),
    desiredMode: Type.Literal("disabled"),
  },
  {
    ...operationProperties,
    kind: Type.Literal("stop"),
    revisionSource: Type.Null(),
    desiredMode: Type.Literal("stopped"),
  },
  {
    ...operationProperties,
    kind: Type.Literal("resume"),
    revisionSource,
    desiredMode: Type.Literal("running"),
    lifecycleGeneration: Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER }),
  },
] as const;
export const LifecycleAcceptedOperationSchemaV1 = Type.Union([
  object(operationVariants[0]),
  object(operationVariants[1]),
  object(operationVariants[2]),
  object(operationVariants[3]),
]);
export type LifecycleAcceptedOperationV1 = Readonly<
  Static<typeof LifecycleAcceptedOperationSchemaV1>
>;
export const LifecycleAcceptedReceiptSchemaV1 = object({
  disposition: Type.Literal("accepted"),
  operation: LifecycleAcceptedOperationSchemaV1,
});
export type LifecycleAcceptedReceiptV1 = {
  readonly disposition: "accepted";
  readonly operation: LifecycleAcceptedOperationV1;
};
export const LifecycleUnchangedReceiptSchemaV1 = object({
  disposition: Type.Literal("unchanged"),
  lifecycleGeneration: generation,
  desiredMode: Type.Union([Type.Literal("disabled"), Type.Literal("stopped")]),
});
export type LifecycleUnchangedReceiptV1 = Readonly<
  Static<typeof LifecycleUnchangedReceiptSchemaV1>
>;
export const LifecycleMutationReceiptSchemaV1 = Type.Union([
  LifecycleAcceptedReceiptSchemaV1,
  LifecycleUnchangedReceiptSchemaV1,
]);
export type LifecycleMutationReceiptV1 = LifecycleAcceptedReceiptV1 | LifecycleUnchangedReceiptV1;

/** Only safe outcome classes cross this boundary. The future admission owner
 * retains an unknown-COMMIT locator before its transaction, outside this result.
 * A conflict never includes the actual generation or read-protected state. */
export const LifecycleMutationResultSchemaV1 = Type.Union([
  object({ kind: Type.Literal("accepted"), receipt: LifecycleAcceptedReceiptSchemaV1 }),
  object({ kind: Type.Literal("unchanged"), receipt: LifecycleUnchangedReceiptSchemaV1 }),
  object({ kind: Type.Literal("conflict") }),
  object({ kind: Type.Literal("unavailable") }),
  object({ kind: Type.Literal("commit-unknown") }),
  object({
    kind: Type.Literal("rejected"),
    code: Type.Enum([
      "INVALID_REQUEST",
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "NOT_FOUND",
      "NAMESPACE_NOT_READY",
      "INTERNAL_ERROR",
    ]),
  }),
]);
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type LifecycleMutationResultV1 = DeepReadonly<
  Static<typeof LifecycleMutationResultSchemaV1>
>;

export const LifecycleOperationReadRequestSchemaV1 = object({
  schemaVersion: version,
  namespaceId,
  agentId,
  operationRef,
});
export type LifecycleOperationReadRequestV1 = Readonly<
  Static<typeof LifecycleOperationReadRequestSchemaV1>
>;
/** The read-authorized immutable operation subdocument only; observations and
 * HTTP status/discovery envelopes belong to the lifecycle observation contract. */
export const LifecycleOperationReadProjectionSchemaV1 = Type.Union([
  object({ ...operationVariants[0], requestedRevisionId: revisionId }),
  object({ ...operationVariants[1], requestedRevisionId: Type.Union([revisionId, Type.Null()]) }),
  object({ ...operationVariants[2], requestedRevisionId: Type.Union([revisionId, Type.Null()]) }),
  object({ ...operationVariants[3], requestedRevisionId: revisionId }),
]);
export type LifecycleOperationReadProjectionV1 = Readonly<
  Static<typeof LifecycleOperationReadProjectionSchemaV1>
>;

/** Inert worker input definition. It does not install a queue kind or dispatcher
 * and cannot be submitted to the existing revision-only work port by a cast. */
export const ReconcileAgentLifecycleSchemaV1 = object({
  schemaVersion: version,
  handler: Type.Literal("ReconcileAgentLifecycleV1"),
  namespaceId,
  agentId,
  operationRef,
  lifecycleGeneration: generation,
  workId,
});
export type ReconcileAgentLifecycleV1 = Readonly<Static<typeof ReconcileAgentLifecycleSchemaV1>>;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const LifecycleAdmissionSchemasV1 = freeze({
  scope: LifecycleScopeSchemaV1,
  generationBody: LifecycleGenerationBodySchemaV1,
  resumeBody: LifecycleResumeBodySchemaV1,
  mutationRequest: LifecycleMutationRequestSchemaV1,
  intent: LifecycleIntentSchemaV1,
  intentHeadProjection: LifecycleIntentHeadProjectionSchemaV1,
  association: LifecycleAdmissionAssociationSchemaV1,
  mutationReceipt: LifecycleMutationReceiptSchemaV1,
  mutationResult: LifecycleMutationResultSchemaV1,
  operationReadRequest: LifecycleOperationReadRequestSchemaV1,
  operationReadProjection: LifecycleOperationReadProjectionSchemaV1,
  workInput: ReconcileAgentLifecycleSchemaV1,
});
export interface LifecycleAdmissionSchemaTypesV1 {
  readonly scope: LifecycleScopeV1;
  readonly generationBody: LifecycleGenerationBodyV1;
  readonly resumeBody: LifecycleResumeBodyV1;
  readonly mutationRequest: LifecycleMutationRequestV1;
  readonly intent: LifecycleIntentV1;
  readonly intentHeadProjection: LifecycleIntentHeadProjectionV1;
  readonly association: LifecycleAdmissionAssociationV1;
  readonly mutationReceipt: LifecycleMutationReceiptV1;
  readonly mutationResult: LifecycleMutationResultV1;
  readonly operationReadRequest: LifecycleOperationReadRequestV1;
  readonly operationReadProjection: LifecycleOperationReadProjectionV1;
  readonly workInput: ReconcileAgentLifecycleV1;
}
export type LifecycleAdmissionSchemaNameV1 = keyof LifecycleAdmissionSchemaTypesV1;
export type LifecycleAdmissionSchemaValueV1<K extends LifecycleAdmissionSchemaNameV1> =
  LifecycleAdmissionSchemaTypesV1[K];

export class LifecycleAdmissionErrorV1 extends Error {
  readonly code = "INVALID_REQUEST" as const;
  constructor() {
    super("Invalid lifecycle admission data.");
    this.name = "LifecycleAdmissionErrorV1";
  }
}
function reject(): never {
  throw new LifecycleAdmissionErrorV1();
}

type Data = null | boolean | number | string | readonly Data[] | { readonly [key: string]: Data };
function copyData(
  input: unknown,
  seen: Set<object>,
  budget: { nodes: number; bytes: number },
  depth = 0,
): Data {
  if (depth > LIFECYCLE_ADMISSION_LIMITS_V1.maxDepth || --budget.nodes < 0) reject();
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input) || input < 0 || Object.is(input, -0)) reject();
    return input;
  }
  if (typeof input === "string") {
    if (input.length > budget.bytes || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(input))
      reject();
    budget.bytes -= Buffer.byteLength(input, "utf8");
    if (budget.bytes < 0) reject();
    return input;
  }
  if (typeof input !== "object" || types.isProxy(input) || seen.has(input)) reject();
  const array = Array.isArray(input);
  const prototype = Object.getPrototypeOf(input);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    reject();
  const keys = Reflect.ownKeys(input);
  if (keys.length > LIFECYCLE_ADMISSION_LIMITS_V1.maxContainerEntries + (array ? 1 : 0)) reject();
  seen.add(input);
  if (array) {
    if (keys.length !== input.length + 1) reject();
    const output: Data[] = [];
    for (let index = 0; index < input.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) reject();
      output.push(copyData(descriptor.value, seen, budget, depth + 1));
    }
    return output;
  }
  const output: { [key: string]: Data } = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) reject();
    budget.bytes -= key.length;
    if (budget.bytes < 0) reject();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) reject();
    output[key] = copyData(descriptor.value, seen, budget, depth + 1);
  }
  return output;
}

function intrinsic(input: Data): void {
  if (input === null || typeof input !== "object") return;
  for (const [key, value] of Object.entries(input)) {
    if ((key === "createdAt" || key === "acceptedAt") && typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) reject();
    }
    intrinsic(value);
  }
}
function checkAssociation(value: LifecycleAdmissionAssociationV1): void {
  const { request, intent } = value;
  const expected = request.expectedLifecycleGeneration;
  if (
    request.namespaceId !== intent.namespaceId ||
    request.agentId !== intent.agentId ||
    expected === Number.MAX_SAFE_INTEGER ||
    intent.generation !== (expected ?? 0) + 1
  )
    reject();
  if (request.kind === "disable") {
    if (intent.desiredMode !== "disabled" || (expected === null && intent.revisionId !== null))
      reject();
  } else if (request.kind === "stop") {
    if (intent.desiredMode !== "stopped" || (expected === null && intent.revisionId !== null))
      reject();
  } else {
    if (intent.desiredMode !== "running" || (request.kind === "resume" && expected === null))
      reject();
  }
}

/** Accept plain in-process data only. This is not a raw JSON/UTF-8 transport
 * parser, an authorization verifier, or a storage readback confirmation. */
export function parseLifecycleAdmissionV1<K extends LifecycleAdmissionSchemaNameV1>(
  kind: K,
  input: unknown,
): LifecycleAdmissionSchemaValueV1<K> {
  try {
    if (typeof kind !== "string" || !Object.hasOwn(LifecycleAdmissionSchemasV1, kind)) reject();
    const value = copyData(input, new Set(), {
      nodes: LIFECYCLE_ADMISSION_LIMITS_V1.maxNodes,
      bytes: LIFECYCLE_ADMISSION_LIMITS_V1.maxJsonBytes,
    });
    if (
      Buffer.byteLength(JSON.stringify(value), "utf8") > LIFECYCLE_ADMISSION_LIMITS_V1.maxJsonBytes
    )
      reject();
    const schema: TSchema = LifecycleAdmissionSchemasV1[kind];
    if (!Check(schema, value)) reject();
    intrinsic(value);
    if (kind === "association")
      checkAssociation(value as unknown as LifecycleAdmissionAssociationV1);
    if (kind === "intent") {
      const intent = value as unknown as LifecycleIntentV1;
      if (intent.generation === 1 && intent.desiredMode !== "running" && intent.revisionId !== null)
        reject();
    }
    if (kind === "operationReadProjection" || kind === "intentHeadProjection") {
      const operation = value as unknown as LifecycleIntentHeadProjectionV1;
      if (
        operation.lifecycleGeneration === 1 &&
        operation.desiredMode !== "running" &&
        operation.requestedRevisionId !== null
      )
        reject();
    }
    return freeze(value) as unknown as LifecycleAdmissionSchemaValueV1<K>;
  } catch {
    throw new LifecycleAdmissionErrorV1();
  }
}
export type LifecycleAdmissionDecodeResultV1<T> =
  { readonly kind: "valid"; readonly value: T } | { readonly kind: "invalid" };
export function decodeLifecycleAdmissionV1<K extends LifecycleAdmissionSchemaNameV1>(
  kind: K,
  input: unknown,
): LifecycleAdmissionDecodeResultV1<LifecycleAdmissionSchemaValueV1<K>> {
  try {
    return Object.freeze({ kind: "valid", value: parseLifecycleAdmissionV1(kind, input) });
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
}

/** Pure redaction of a declared association, not proof that admission committed. */
export function projectLifecycleAcceptedReceiptV1(input: unknown): LifecycleAcceptedReceiptV1 {
  const { request, intent } = parseLifecycleAdmissionV1("association", input);
  let source: "retained" | "saved-draft" | null = null;
  if (request.kind === "deploy") source = "saved-draft";
  if (request.kind === "resume") source = request.revisionSource;
  return parseLifecycleAdmissionV1("mutationReceipt", {
    disposition: "accepted",
    operation: {
      operationRef: intent.transitionRef,
      kind: request.kind,
      revisionSource: source,
      lifecycleGeneration: intent.generation,
      desiredMode: intent.desiredMode,
      acceptedAt: intent.createdAt,
    },
  }) as LifecycleAcceptedReceiptV1;
}
/** Call only after separate current read authorization. This pure projection
 * grants no access and contains no runtime observation or protected audit data. */
export function projectLifecycleOperationReadV1(
  input: unknown,
): LifecycleOperationReadProjectionV1 {
  const association = parseLifecycleAdmissionV1("association", input);
  return parseLifecycleAdmissionV1("operationReadProjection", {
    ...projectLifecycleAcceptedReceiptV1(association).operation,
    requestedRevisionId: association.intent.revisionId,
  });
}

/** Check request/result correspondence only. A matching no-op still requires an
 * authoritative same-mode head/CAS check; this function has no storage or caller
 * authority and cannot determine whether a declared result actually occurred. */
export function parseLifecycleMutationResultForRequestV1(
  requestInput: unknown,
  resultInput: unknown,
): LifecycleMutationResultV1 {
  const request = parseLifecycleAdmissionV1("mutationRequest", requestInput);
  const result = parseLifecycleAdmissionV1("mutationResult", resultInput);
  if (result.kind === "unchanged") {
    if (
      (request.kind !== "disable" && request.kind !== "stop") ||
      request.expectedLifecycleGeneration === null ||
      result.receipt.lifecycleGeneration !== request.expectedLifecycleGeneration ||
      result.receipt.desiredMode !== (request.kind === "disable" ? "disabled" : "stopped")
    )
      reject();
  }
  if (result.kind === "accepted") {
    let source: "retained" | "saved-draft" | null = null;
    if (request.kind === "deploy") source = "saved-draft";
    if (request.kind === "resume") source = request.revisionSource;
    if (
      request.expectedLifecycleGeneration === Number.MAX_SAFE_INTEGER ||
      (request.kind === "resume" && request.expectedLifecycleGeneration === null) ||
      result.receipt.operation.kind !== request.kind ||
      result.receipt.operation.revisionSource !== source ||
      result.receipt.operation.lifecycleGeneration !==
        (request.expectedLifecycleGeneration ?? 0) + 1
    )
      reject();
  }
  return result;
}

/** Pure canonical-intent head projection; this establishes neither a current head
 * nor permission to read it. The read owner performs those independent checks. */
export function projectLifecycleIntentHeadV1(input: unknown): LifecycleIntentHeadProjectionV1 {
  const intent = parseLifecycleAdmissionV1("intent", input);
  return parseLifecycleAdmissionV1("intentHeadProjection", {
    operationRef: intent.transitionRef,
    lifecycleGeneration: intent.generation,
    desiredMode: intent.desiredMode,
    requestedRevisionId: intent.revisionId,
  });
}
