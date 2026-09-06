import { types } from "node:util";
import { parseLifecycleAdmissionV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import {
  LIFECYCLE_OBSERVATION_LIMITS_V1,
  LifecycleObservationErrorV1,
  parseLifecycleObservationV1,
  parseLifecycleObservationResponseV1,
  type LifecycleObservationResponseRequestTypesV1,
  type LifecycleObservationResponseTypesV1,
} from "@openclaw-enterprise/contracts/lifecycle-observation-v1";
import type { LifecycleReadResultV1 } from "./ports-v1.ts";

export type LifecycleStatusReadMethodV1 = keyof Pick<
  LifecycleObservationResponseTypesV1,
  "readStatus" | "readOperation" | "listOperations" | "readCapability"
>;
export type LifecycleStatusReadRequestV1<K extends LifecycleStatusReadMethodV1> =
  LifecycleObservationResponseRequestTypesV1[K];
export type LifecycleStatusReadValueV1<K extends LifecycleStatusReadMethodV1> =
  LifecycleObservationResponseTypesV1[K];
export type LifecycleStatusReadResultV1<K extends LifecycleStatusReadMethodV1> =
  LifecycleReadResultV1<LifecycleStatusReadValueV1<K>>;

/** Bounds apply to the selected public tree. Dropped backend fields are never
 * enumerated or traversed, even when they contain large or cyclic private data. */
export const LIFECYCLE_STATUS_PROJECTION_LIMITS_V1 = Object.freeze({
  maxJsonBytes: LIFECYCLE_OBSERVATION_LIMITS_V1.maxJsonBytes,
  maxDepth: 16,
  maxNodes: 4_096,
  maxPageSize: LIFECYCLE_OBSERVATION_LIMITS_V1.maxPageSize,
});
type Layout =
  | "scalar"
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, Layout>> }
  | { readonly kind: "array"; readonly item: Layout }
  | { readonly kind: "nullable"; readonly value: Layout };
const object = (fields: Readonly<Record<string, Layout>>): Layout => ({ kind: "object", fields });
const scalar = "scalar";
const progress = {
  phase: scalar,
  attempt: scalar,
  step: scalar,
  reasonCode: scalar,
  retryAt: scalar,
} as const;
const condition = object({
  status: scalar,
  observedAt: scalar,
  recordedAt: scalar,
  reasonCode: scalar,
});
const observation = object({ ...progress, observedAt: scalar, recordedAt: scalar });
const minimalOperation = {
  operationRef: scalar,
  kind: scalar,
  revisionSource: scalar,
  lifecycleGeneration: scalar,
  desiredMode: scalar,
  acceptedAt: scalar,
} as const;
// These finite layouts select existing public fields only. They do not validate
// values or supply a competing schema; the original canonical parsers do that.
const layouts: Readonly<Record<LifecycleStatusReadMethodV1, Layout>> = {
  readStatus: object({
    namespaceId: scalar,
    agentId: scalar,
    head: {
      kind: "nullable",
      value: object({
        operationRef: scalar,
        lifecycleGeneration: scalar,
        desiredMode: scalar,
        requestedRevisionId: scalar,
      }),
    },
    requestedRevisionId: scalar,
    selectedRevisionId: scalar,
    servingRevisionId: scalar,
    observedLifecycleGeneration: scalar,
    ...progress,
    conditions: object({
      accessDenied: condition,
      routeRemoved: condition,
      executionTerminated: condition,
      credentialRevocation: condition,
      stateRetention: condition,
    }),
    serving: scalar,
    stopComplete: scalar,
    retention: scalar,
  }),
  readOperation: object({
    operation: object({ ...minimalOperation, requestedRevisionId: scalar }),
    observation,
  }),
  listOperations: object({
    operations: { kind: "array", item: object(minimalOperation) },
    nextAfterGeneration: scalar,
  }),
  readCapability: object({
    schemaVersion: scalar,
    protocol: scalar,
    stage: scalar,
    capabilityVersion: scalar,
    supportedConsumerVersions: object({
      api: scalar,
      worker: scalar,
      maintenance: scalar,
      receiving: scalar,
    }),
  }),
};
const unavailable = Object.freeze({ kind: "unavailable" as const });
function invalid(): never {
  throw new LifecycleObservationErrorV1();
}
function checkMethod(method: unknown): asserts method is LifecycleStatusReadMethodV1 {
  if (typeof method !== "string" || !Object.hasOwn(layouts, method)) invalid();
}
function plainObject(value: unknown): asserts value is object {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
    invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
}
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
  return descriptor.value;
}
type Data = null | boolean | number | string | Data[] | { [key: string]: Data };
interface Budget {
  nodes: number;
  bytes: number;
}
function select(
  layout: Layout,
  input: unknown,
  budget: Budget,
  active: Set<object>,
  depth = 0,
): Data {
  if (depth > LIFECYCLE_STATUS_PROJECTION_LIMITS_V1.maxDepth || --budget.nodes < 0) invalid();
  if (layout === "scalar") {
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input !== "string" || input.length > budget.bytes) invalid();
    budget.bytes -= Buffer.byteLength(input, "utf8");
    if (budget.bytes < 0) invalid();
    return input;
  }
  if (layout.kind === "nullable")
    return input === null ? null : select(layout.value, input, budget, active, depth + 1);
  if (input === null || typeof input !== "object" || types.isProxy(input) || active.has(input))
    invalid();
  active.add(input);
  try {
    if (layout.kind === "array") {
      if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(input, "length");
      if (!descriptor || !("value" in descriptor)) invalid();
      const length: unknown = descriptor.value;
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > LIFECYCLE_STATUS_PROJECTION_LIMITS_V1.maxPageSize
      )
        invalid();
      const output: Data[] = [];
      for (let index = 0; index < length; index++)
        output.push(select(layout.item, ownData(input, String(index)), budget, active, depth + 1));
      return output;
    }
    plainObject(input);
    const output: { [key: string]: Data } = Object.create(null);
    for (const [key, child] of Object.entries(layout.fields)) {
      budget.bytes -= key.length;
      if (budget.bytes < 0) invalid();
      output[key] = select(child, ownData(input, key), budget, active, depth + 1);
    }
    return output;
  } finally {
    active.delete(input);
  }
}

/** Strict request parsing is intentionally separate from backend redaction.
 * Caller-supplied actor, Installation, locators or other request extras cannot
 * disappear into a permitted request. This validates data, not caller authority. */
export function parseLifecycleStatusReadRequestV1<K extends LifecycleStatusReadMethodV1>(
  method: K,
  input: unknown,
): LifecycleStatusReadRequestV1<K> {
  try {
    checkMethod(method);
    if (method === "readOperation")
      return parseLifecycleAdmissionV1(
        "operationReadRequest",
        input,
      ) as LifecycleStatusReadRequestV1<K>;
    if (method === "listOperations")
      return parseLifecycleObservationV1("pageRequest", input) as LifecycleStatusReadRequestV1<K>;
    return parseLifecycleAdmissionV1("scope", input) as LifecycleStatusReadRequestV1<K>;
  } catch {
    throw new LifecycleObservationErrorV1();
  }
}

/** Project an existing authorized-reader result into its original public type.
 * Incidental private fields are omitted without reading their descriptors or
 * values. A selected accessor, proxy, malformed public field or unsupported
 * result fails closed. No authority, observation, freshness or runtime fact is
 * created here; the actual reader still owns authorization at disclosure. */
export function projectLifecycleStatusReadV1<K extends LifecycleStatusReadMethodV1>(
  method: K,
  requestInput: unknown,
  resultInput: unknown,
): LifecycleStatusReadResultV1<K> {
  try {
    const request = parseLifecycleStatusReadRequestV1(method, requestInput);
    plainObject(resultInput);
    const kind = ownData(resultInput, "kind");
    if (kind === "unavailable") return unavailable;
    if (kind === "rejected") {
      const failure = parseLifecycleAdmissionV1("mutationResult", {
        kind,
        code: ownData(resultInput, "code"),
      });
      if (failure.kind !== "rejected") invalid();
      return failure;
    }
    if (kind !== "read") invalid();
    const value = select(
      layouts[method],
      ownData(resultInput, "value"),
      {
        nodes: LIFECYCLE_STATUS_PROJECTION_LIMITS_V1.maxNodes,
        bytes: LIFECYCLE_STATUS_PROJECTION_LIMITS_V1.maxJsonBytes,
      },
      new Set(),
    );
    if (
      Buffer.byteLength(JSON.stringify(value), "utf8") >
      LIFECYCLE_STATUS_PROJECTION_LIMITS_V1.maxJsonBytes
    )
      invalid();
    const checked = parseLifecycleObservationResponseV1(method, request, value);
    return Object.freeze({ kind: "read", value: checked });
  } catch {
    return unavailable;
  }
}
