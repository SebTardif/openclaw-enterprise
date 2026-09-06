import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { types } from "node:util";
import { RevisionId, Timestamp } from "./api/common.ts";
import {
  LifecycleAcceptedOperationSchemaV1,
  LifecycleIntentHeadProjectionSchemaV1,
  LifecycleOperationReadProjectionSchemaV1,
  LifecycleScopeSchemaV1,
  ReconcileAgentLifecycleSchemaV1,
  parseLifecycleAdmissionV1,
  type LifecycleScopeV1,
  type LifecycleOperationReadRequestV1,
  type ReconcileAgentLifecycleV1,
} from "./lifecycle-admission-v1.ts";
import {
  ExactAuthorityOperationSchemaV1,
  RUNTIME_AUTHORITY_LIMITS_V1,
  parseRuntimeAuthorityV1,
} from "./runtime-authority-v1.ts";
import {
  ExactEffectLocatorSchemaV1,
  RuntimeFenceRequestSchemaV1,
  RuntimeEffectsSchemasV1,
  RUNTIME_EFFECT_LIMITS_V1,
  parseRuntimeEffectsV1,
} from "./runtime-effects-v1.ts";

// The same canonical identities are available through this focused subpath.
export { parseRuntimeEffectsV1 };
export type {
  AuthorityCallV1,
  ExactAuthorityOperationV1,
  RuntimeAssignmentTargetV1,
} from "./runtime-authority-v1.ts";
export type {
  RuntimeEffectsV1,
  RuntimeEffectAdmissionV1,
  WorkspaceHandoffEvidenceV1,
  ExactEffectLocatorV1,
  RuntimeEffectResultV1,
  RuntimeEffectStateV1,
  ExactCleanupV1,
  RuntimeSealV1,
  RuntimeFenceRequestV1,
  RuntimeFenceStateV1,
  ExactHandoffV1,
  PriorWriterResultV1,
  DurableCleanupRequestStateV1,
  RuntimePreparedChildV1,
  RuntimeEvidenceProvenanceV1,
  RuntimeGateGuardV1,
  RuntimeEffectClockV1,
  ExactRuntimeFaultOperationV1,
} from "./runtime-effects-v1.ts";

/** In-process data only: no source provenance, current authority or runtime proof.
 * Bounds accommodate an existing closed fence's 256 children; they do not expand
 * the imported effect/authority contracts' own bounds. */
export const LIFECYCLE_OBSERVATION_LIMITS_V1 = Object.freeze({
  maxJsonBytes: RUNTIME_EFFECT_LIMITS_V1.maxJsonBytes + 8_192,
  maxDepth: RUNTIME_EFFECT_LIMITS_V1.maxDepth + 4,
  maxNodes: 32_768,
  maxContainerEntries: 256,
  maxPageSize: 100,
});
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const version = Type.Literal(1);
const generation = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const nullableGeneration = Type.Union([generation, Type.Null()]);
const attempt = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const timestamp = { ...Timestamp };
const nullableTime = Type.Union([timestamp, Type.Null()]);
const revision = Type.Union([{ ...RevisionId }, Type.Null()]);
// Copy imported schemas before freezing this registry, preserving the original
// modules' object ownership and their exact schema identities/constraints.
function closedSchemaCopy<T extends TSchema>(schema: T): T {
  const copy = structuredClone(schema);
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    // Some imported Type.Pick scopes have no additionalProperties keyword.
    // This boundary closes its own copy without changing the shared source.
    if ("type" in node && node.type === "object")
      Object.assign(node, { additionalProperties: false });
    for (const child of Object.values(node)) visit(child);
  };
  visit(copy);
  return copy;
}
const scope = closedSchemaCopy(LifecycleScopeSchemaV1);
const head = closedSchemaCopy(LifecycleIntentHeadProjectionSchemaV1);
const operation = closedSchemaCopy(LifecycleOperationReadProjectionSchemaV1);
const minimalOperation = closedSchemaCopy(LifecycleAcceptedOperationSchemaV1);
const work = closedSchemaCopy(ReconcileAgentLifecycleSchemaV1);
const effect = closedSchemaCopy(ExactEffectLocatorSchemaV1);
const authorityOperation = closedSchemaCopy(ExactAuthorityOperationSchemaV1);
const fence = closedSchemaCopy(RuntimeFenceRequestSchemaV1);
const cleanupOperation = closedSchemaCopy(RuntimeEffectsSchemasV1.faultOperation);

export const LifecycleStepSchemaV1 = Type.Enum([
  "observe",
  "deny-predecessor",
  "terminate-predecessor",
  "prepare",
  "activate",
  "publish",
  "cleanup",
]);
export type LifecycleStepV1 = Static<typeof LifecycleStepSchemaV1>;
export const LifecyclePhaseSchemaV1 = Type.Enum([
  "pending",
  "reconciling",
  "blocked",
  "converged",
  "superseded",
]);
export type LifecyclePhaseV1 = Static<typeof LifecyclePhaseSchemaV1>;
export const LifecycleReasonCodeSchemaV1 = Type.Enum([
  "NONE",
  "LIFECYCLE_UNINITIALIZED",
  "NOT_OBSERVED",
  "NOT_REQUESTED",
  "AUTHORITY_DENIED",
  "DEPENDENCY_UNAVAILABLE",
  "PROFILE_UNAVAILABLE",
  "PREDECESSOR_UNRESOLVED",
  "CREATE_OUTCOME_UNKNOWN",
  "AMBIGUOUS_PROVIDER_INSTANCE",
  "ROUTE_OUTCOME_UNKNOWN",
  "TERMINATION_UNKNOWN",
  "CREDENTIAL_OUTCOME_UNKNOWN",
  "STATE_UNAVAILABLE",
  "RESTORE_OUTCOME_UNKNOWN",
  "SUPERSEDED",
  "RECONCILIATION_EXHAUSTED",
]);
export type LifecycleReasonCodeV1 = Static<typeof LifecycleReasonCodeSchemaV1>;
const progress = {
  phase: LifecyclePhaseSchemaV1,
  attempt,
  step: LifecycleStepSchemaV1,
  reasonCode: LifecycleReasonCodeSchemaV1,
  retryAt: nullableTime,
};
export const LifecycleObservationSchemaV1 = object({
  ...progress,
  observedAt: nullableTime,
  recordedAt: nullableTime,
});
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type LifecycleObservationV1 = DeepReadonly<Static<typeof LifecycleObservationSchemaV1>>;
export const LifecycleConditionSchemaV1 = object({
  status: Type.Enum(["confirmed", "pending", "unknown", "not-requested"]),
  observedAt: nullableTime,
  recordedAt: nullableTime,
  reasonCode: LifecycleReasonCodeSchemaV1,
});
export type LifecycleConditionV1 = DeepReadonly<Static<typeof LifecycleConditionSchemaV1>>;
export const LifecycleStatusSchemaV1 = object({
  ...scope.properties,
  head: Type.Union([head, Type.Null()]),
  requestedRevisionId: revision,
  selectedRevisionId: revision,
  servingRevisionId: revision,
  observedLifecycleGeneration: nullableGeneration,
  ...progress,
  conditions: object({
    accessDenied: LifecycleConditionSchemaV1,
    routeRemoved: LifecycleConditionSchemaV1,
    executionTerminated: LifecycleConditionSchemaV1,
    credentialRevocation: LifecycleConditionSchemaV1,
    stateRetention: LifecycleConditionSchemaV1,
  }),
  serving: Type.Boolean(),
  stopComplete: Type.Boolean(),
  retention: Type.Enum(["retained", "verification-pending", "unknown"]),
});
export type LifecycleStatusV1 = DeepReadonly<Static<typeof LifecycleStatusSchemaV1>>;
export const LifecycleOperationStatusSchemaV1 = object({
  operation,
  observation: LifecycleObservationSchemaV1,
});
export type LifecycleOperationStatusV1 = DeepReadonly<
  Static<typeof LifecycleOperationStatusSchemaV1>
>;
export const LifecycleOperationPageRequestSchemaV1 = object({
  schemaVersion: version,
  ...scope.properties,
  afterGeneration: nullableGeneration,
  limit: Type.Integer({ minimum: 1, maximum: LIFECYCLE_OBSERVATION_LIMITS_V1.maxPageSize }),
});
export type LifecycleOperationPageRequestV1 = DeepReadonly<
  Static<typeof LifecycleOperationPageRequestSchemaV1>
>;
export const LifecycleOperationPageSchemaV1 = object({
  operations: Type.Array(minimalOperation, {
    maxItems: LIFECYCLE_OBSERVATION_LIMITS_V1.maxPageSize,
  }),
  nextAfterGeneration: nullableGeneration,
});
export type LifecycleOperationPageV1 = DeepReadonly<Static<typeof LifecycleOperationPageSchemaV1>>;
const consumerVersion = Type.Union([version, Type.Null()]);
/** A server-owned capability projection. Version declarations alone cannot
 * establish rollout, old-writer exclusion or permission to mutate. */
export const LifecycleCapabilitySchemaV1 = object({
  schemaVersion: version,
  protocol: Type.Literal("lifecycle-control-v1"),
  stage: Type.Enum(["legacy", "drain", "live"]),
  capabilityVersion: generation,
  supportedConsumerVersions: object({
    api: consumerVersion,
    worker: consumerVersion,
    maintenance: consumerVersion,
    receiving: consumerVersion,
  }),
});
export type LifecycleCapabilityV1 = DeepReadonly<Static<typeof LifecycleCapabilitySchemaV1>>;
const unknownRequest = {
  schemaVersion: version,
  work,
  step: LifecycleStepSchemaV1,
  phase: Type.Enum(["admission-commit", "submission", "provider-response", "readback"]),
  selectedRequestStartedAt: timestamp,
  selectedRequestDeadlineAt: timestamp,
  recordedAt: timestamp,
  reasonCode: LifecycleReasonCodeSchemaV1,
};
/** Exact retained identities survive lost acknowledgement and cancellation.
 * The clocks describe one selected request, never the entire preparation or
 * termination episode. An unknown result contains no fabricated absence. */
export const LifecycleHandlerResultSchemaV1 = Type.Union([
  object({
    schemaVersion: version,
    kind: Type.Literal("observed"),
    work,
    observation: LifecycleObservationSchemaV1,
    status: LifecycleStatusSchemaV1,
  }),
  object({ ...unknownRequest, kind: Type.Literal("effect-unknown"), effect }),
  object({
    ...unknownRequest,
    kind: Type.Literal("authority-unknown"),
    operation: authorityOperation,
  }),
  object({ ...unknownRequest, kind: Type.Literal("fence-unknown"), fence }),
  object({ ...unknownRequest, kind: Type.Literal("cleanup-unknown"), operation: cleanupOperation }),
  object({
    schemaVersion: version,
    kind: Type.Literal("unavailable"),
    work,
    reasonCode: LifecycleReasonCodeSchemaV1,
  }),
  object({
    schemaVersion: version,
    kind: Type.Literal("conflict"),
    work,
    reasonCode: LifecycleReasonCodeSchemaV1,
  }),
  object({
    schemaVersion: version,
    kind: Type.Literal("rejected"),
    work,
    reasonCode: LifecycleReasonCodeSchemaV1,
  }),
]);
export type LifecycleHandlerResultV1 = DeepReadonly<Static<typeof LifecycleHandlerResultSchemaV1>>;
export type ReconcileAgentLifecycleResultV1 = LifecycleHandlerResultV1;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const LifecycleObservationSchemasV1 = freeze({
  observation: LifecycleObservationSchemaV1,
  condition: LifecycleConditionSchemaV1,
  status: LifecycleStatusSchemaV1,
  operationStatus: LifecycleOperationStatusSchemaV1,
  pageRequest: LifecycleOperationPageRequestSchemaV1,
  page: LifecycleOperationPageSchemaV1,
  capability: LifecycleCapabilitySchemaV1,
  handlerResult: LifecycleHandlerResultSchemaV1,
});
export interface LifecycleObservationSchemaTypesV1 {
  readonly observation: LifecycleObservationV1;
  readonly condition: LifecycleConditionV1;
  readonly status: LifecycleStatusV1;
  readonly operationStatus: LifecycleOperationStatusV1;
  readonly pageRequest: LifecycleOperationPageRequestV1;
  readonly page: LifecycleOperationPageV1;
  readonly capability: LifecycleCapabilityV1;
  readonly handlerResult: LifecycleHandlerResultV1;
}
export type LifecycleObservationSchemaNameV1 = keyof LifecycleObservationSchemaTypesV1;
export type LifecycleObservationSchemaValueV1<K extends LifecycleObservationSchemaNameV1> =
  LifecycleObservationSchemaTypesV1[K];
export class LifecycleObservationErrorV1 extends Error {
  readonly code = "INVALID_REQUEST" as const;
  constructor() {
    super("Invalid lifecycle observation data.");
    this.name = "LifecycleObservationErrorV1";
  }
}
function reject(): never {
  throw new LifecycleObservationErrorV1();
}
type Data = null | boolean | number | string | Data[] | { [key: string]: Data };
function copyData(
  input: unknown,
  seen: Set<object>,
  budget: { nodes: number; bytes: number },
  depth = 0,
): Data {
  if (depth > LIFECYCLE_OBSERVATION_LIMITS_V1.maxDepth || --budget.nodes < 0) reject();
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
  if (keys.length > LIFECYCLE_OBSERVATION_LIMITS_V1.maxContainerEntries + (array ? 1 : 0)) reject();
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
function checkTimes(value: Data): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("At") && typeof child === "string") {
      const time = Date.parse(child);
      if (!Number.isFinite(time) || new Date(time).toISOString() !== child) reject();
    }
    checkTimes(child);
  }
}
function checkObservation(value: LifecycleObservationV1): void {
  checkSourceTimes(value);
  if ((value.phase === "superseded") !== (value.reasonCode === "SUPERSEDED")) reject();
  if (value.phase === "converged" && value.reasonCode !== "NONE") reject();
  if ((value.phase === "converged" || value.phase === "superseded") && value.retryAt !== null)
    reject();
}
function checkSourceTimes(value: {
  readonly observedAt: string | null;
  readonly recordedAt: string | null;
}): void {
  if (value.observedAt !== null) {
    if (
      value.recordedAt === null ||
      Date.parse(value.observedAt) >
        Date.parse(value.recordedAt) + RUNTIME_AUTHORITY_LIMITS_V1.clockUncertaintyMaxMs
    )
      reject();
  }
  // Historical source timestamps remain readable. A receiver must not refresh
  // them to make stale evidence usable; this parser has no authoritative clock.
}
function checkCondition(value: LifecycleConditionV1): void {
  checkSourceTimes(value);
  // Local authority observations can have an OCC receipt without a provider
  // timestamp. Closed reason codes remain informative, never evidence by themselves.
  if (value.status === "confirmed" && value.recordedAt === null) reject();
  if (value.status === "not-requested" && value.reasonCode !== "NOT_REQUESTED") reject();
  if (value.status !== "not-requested" && value.reasonCode === "NOT_REQUESTED") reject();
}
function checkStatus(value: LifecycleStatusV1): void {
  for (const condition of Object.values(value.conditions)) checkCondition(condition);
  if (value.head !== null) {
    parseLifecycleAdmissionV1("intentHeadProjection", value.head);
    if (
      value.requestedRevisionId !== value.head.requestedRevisionId ||
      (value.observedLifecycleGeneration !== null &&
        value.observedLifecycleGeneration > value.head.lifecycleGeneration)
    )
      reject();
  } else if (
    value.requestedRevisionId !== null ||
    value.observedLifecycleGeneration !== null ||
    value.serving ||
    value.stopComplete ||
    value.phase === "converged"
  )
    reject();
  if ((value.phase === "superseded") !== (value.reasonCode === "SUPERSEDED")) reject();
  if (
    value.phase === "superseded" &&
    (value.head === null ||
      value.observedLifecycleGeneration === null ||
      value.observedLifecycleGeneration >= value.head.lifecycleGeneration ||
      value.serving ||
      value.stopComplete ||
      value.retryAt !== null)
  )
    reject();
  // A prior observed serving ID remains informative when current serving proof
  // is absent. Only a true current-serving claim requires revision equality.
  const current =
    value.head !== null && value.observedLifecycleGeneration === value.head.lifecycleGeneration;
  if (
    value.serving &&
    (!current ||
      value.head?.desiredMode !== "running" ||
      value.servingRevisionId !== value.head.requestedRevisionId ||
      value.selectedRevisionId !== value.servingRevisionId ||
      value.conditions.accessDenied.status === "confirmed" ||
      value.conditions.routeRemoved.status === "confirmed" ||
      value.conditions.executionTerminated.status === "confirmed")
  )
    reject();
  if (
    value.stopComplete &&
    (!current ||
      value.head?.desiredMode !== "stopped" ||
      value.serving ||
      value.conditions.accessDenied.status !== "confirmed" ||
      value.conditions.routeRemoved.status !== "confirmed" ||
      value.conditions.executionTerminated.status !== "confirmed")
  )
    reject();
  if (value.phase === "converged") {
    if (!current || value.reasonCode !== "NONE" || value.retryAt !== null) reject();
    if (value.head?.desiredMode === "running" && !value.serving) reject();
    if (value.head?.desiredMode === "stopped" && !value.stopComplete) reject();
    if (
      value.head?.desiredMode === "disabled" &&
      (value.conditions.accessDenied.status !== "confirmed" ||
        value.conditions.routeRemoved.status !== "confirmed" ||
        value.serving)
    )
      reject();
  }
  if (value.retention === "retained" && value.conditions.stateRetention.status !== "confirmed")
    reject();
  // These are necessary correlations only. Disabled convergence also needs a
  // durable cancellation request; stopComplete additionally needs exhaustive
  // every-create/runtime resolution from the authoritative producer. Neither
  // fact is established by a supplied aggregate condition or writer release.
}
function checkPage(value: LifecycleOperationPageV1): void {
  let previous = 0;
  const refs = new Set<string>();
  for (const entry of value.operations) {
    parseLifecycleAdmissionV1("mutationReceipt", { disposition: "accepted", operation: entry });
    if (entry.lifecycleGeneration <= previous || refs.has(entry.operationRef)) reject();
    previous = entry.lifecycleGeneration;
    refs.add(entry.operationRef);
  }
  if (
    value.nextAfterGeneration !== null &&
    (value.operations.length === 0 || value.nextAfterGeneration !== previous)
  )
    reject();
}
function sameScope(left: LifecycleScopeV1, right: LifecycleScopeV1): void {
  if (left.namespaceId !== right.namespaceId || left.agentId !== right.agentId) reject();
}
function sameWork(left: ReconcileAgentLifecycleV1, right: ReconcileAgentLifecycleV1): void {
  sameScope(left, right);
  if (
    left.operationRef !== right.operationRef ||
    left.lifecycleGeneration !== right.lifecycleGeneration ||
    left.workId !== right.workId
  )
    reject();
}
function checkHandler(value: LifecycleHandlerResultV1): void {
  parseLifecycleAdmissionV1("workInput", value.work);
  if (value.kind === "observed") {
    checkStatus(value.status);
    checkObservation(value.observation);
    sameScope(value.work, value.status);
    const current = value.status.head;
    if (current === null || current.lifecycleGeneration < value.work.lifecycleGeneration) reject();
    if (current.lifecycleGeneration === value.work.lifecycleGeneration) {
      if (
        current.operationRef !== value.work.operationRef ||
        value.observation.phase === "superseded"
      )
        reject();
      for (const key of ["phase", "attempt", "step", "reasonCode", "retryAt"] as const) {
        if (value.observation[key] !== value.status[key]) reject();
      }
    } else if (
      current.operationRef === value.work.operationRef ||
      (value.observation.phase !== "superseded" && value.observation.phase !== "converged")
    )
      reject();
    // Historical terminal observations do not relabel themselves when the head
    // advances, and do not supply serving/stop proof for that newer head.
    return;
  }
  if (
    value.reasonCode === "NONE" ||
    value.reasonCode === "NOT_REQUESTED" ||
    value.reasonCode === "LIFECYCLE_UNINITIALIZED"
  )
    reject();
  if (value.kind === "unavailable" || value.kind === "conflict" || value.kind === "rejected")
    return;
  if (value.reasonCode === "SUPERSEDED" || value.reasonCode === "NOT_OBSERVED") reject();
  const started = Date.parse(value.selectedRequestStartedAt);
  const deadline = Date.parse(value.selectedRequestDeadlineAt);
  if (deadline <= started || Date.parse(value.recordedAt) < started) reject();
  if (
    value.kind === "effect-unknown" &&
    deadline - started > RUNTIME_AUTHORITY_LIMITS_V1.providerRequestMaxMs
  )
    reject();
  // The 3-second authority lookup ceiling is not a mutation/fence deadline.
  // Those owners retain their exact finite selected interval and enforce the
  // enclosing preparation/termination budget and each individual call's cap.
  if (value.kind === "effect-unknown") {
    parseRuntimeEffectsV1("effectLocator", value.effect);
    sameScope(value.work, value.effect.target);
    if (value.effect.target.lifecycleGeneration > value.work.lifecycleGeneration) reject();
  }
  if (value.kind === "authority-unknown") {
    parseRuntimeAuthorityV1("exactOperation", value.operation);
    sameScope(value.work, value.operation);
  }
  if (value.kind === "fence-unknown") {
    parseRuntimeEffectsV1("fenceRequest", value.fence);
    sameScope(value.work, value.fence.guard.scope);
    if (
      value.fence.guard.lifecycleGeneration > value.work.lifecycleGeneration ||
      (value.fence.guard.lifecycleGeneration === value.work.lifecycleGeneration) !==
        (value.fence.guard.intentRef === value.work.operationRef)
    )
      reject();
  }
  if (value.kind === "cleanup-unknown") {
    parseRuntimeEffectsV1("faultOperation", value.operation);
    sameScope(value.work, value.operation.scope);
  }
}

/** Strict, bounded plain-data parsing. Not a raw UTF-8/JSON decoder and not an
 * evidence verifier. Unknown fields are rejected rather than silently redacted. */
export function parseLifecycleObservationV1<K extends LifecycleObservationSchemaNameV1>(
  kind: K,
  input: unknown,
): LifecycleObservationSchemaValueV1<K> {
  try {
    if (typeof kind !== "string" || !Object.hasOwn(LifecycleObservationSchemasV1, kind)) reject();
    const value = copyData(input, new Set(), {
      nodes: LIFECYCLE_OBSERVATION_LIMITS_V1.maxNodes,
      bytes: LIFECYCLE_OBSERVATION_LIMITS_V1.maxJsonBytes,
    });
    if (
      Buffer.byteLength(JSON.stringify(value), "utf8") >
      LIFECYCLE_OBSERVATION_LIMITS_V1.maxJsonBytes
    )
      reject();
    if (!Check(LifecycleObservationSchemasV1[kind] as TSchema, value)) reject();
    checkTimes(value);
    if (kind === "observation") checkObservation(value as LifecycleObservationV1);
    if (kind === "condition") checkCondition(value as LifecycleConditionV1);
    if (kind === "status") checkStatus(value as LifecycleStatusV1);
    if (kind === "operationStatus") {
      const result = value as LifecycleOperationStatusV1;
      parseLifecycleAdmissionV1("operationReadProjection", result.operation);
      checkObservation(result.observation);
    }
    if (kind === "page") checkPage(value as unknown as LifecycleOperationPageV1);
    if (kind === "capability") {
      const capability = value as LifecycleCapabilityV1;
      const versions = capability.supportedConsumerVersions;
      if (
        capability.stage !== "legacy" &&
        (versions.api !== 1 || versions.worker !== 1 || versions.receiving !== 1)
      )
        reject();
      if (capability.stage === "live" && versions.maintenance !== 1) reject();
    }
    if (kind === "handlerResult") checkHandler(value as LifecycleHandlerResultV1);
    return freeze(value) as unknown as LifecycleObservationSchemaValueV1<K>;
  } catch {
    throw new LifecycleObservationErrorV1();
  }
}
export type LifecycleObservationDecodeResultV1<T> =
  { readonly kind: "valid"; readonly value: T } | { readonly kind: "invalid" };
export function decodeLifecycleObservationV1<K extends LifecycleObservationSchemaNameV1>(
  kind: K,
  input: unknown,
): LifecycleObservationDecodeResultV1<LifecycleObservationSchemaValueV1<K>> {
  try {
    return Object.freeze({ kind: "valid", value: parseLifecycleObservationV1(kind, input) });
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
}
export interface LifecycleObservationResponseTypesV1 {
  readonly readStatus: LifecycleStatusV1;
  readonly readOperation: LifecycleOperationStatusV1;
  readonly listOperations: LifecycleOperationPageV1;
  readonly readCapability: LifecycleCapabilityV1;
  readonly reconcile: LifecycleHandlerResultV1;
}
export interface LifecycleObservationResponseRequestTypesV1 {
  readonly readStatus: LifecycleScopeV1;
  readonly readOperation: LifecycleOperationReadRequestV1;
  readonly listOperations: LifecycleOperationPageRequestV1;
  readonly readCapability: LifecycleScopeV1;
  readonly reconcile: ReconcileAgentLifecycleV1;
}
export type LifecycleObservationResponseMethodV1 = keyof LifecycleObservationResponseTypesV1;
/** Validate successful read data or the complete handler result against the
 * supplied request. Operation/page/capability projections deliberately have no
 * owner field: their reader must independently enforce the authorized scope.
 * Matching values establish correspondence, never ownership or authority. */
export function parseLifecycleObservationResponseV1<K extends LifecycleObservationResponseMethodV1>(
  method: K,
  requestInput: unknown,
  input: unknown,
): LifecycleObservationResponseTypesV1[K] {
  try {
    if (method === "readStatus") {
      const request = parseLifecycleAdmissionV1("scope", requestInput);
      const result = parseLifecycleObservationV1("status", input);
      sameScope(request, result);
      return result as LifecycleObservationResponseTypesV1[K];
    }
    if (method === "readOperation") {
      const request = parseLifecycleAdmissionV1("operationReadRequest", requestInput);
      const result = parseLifecycleObservationV1("operationStatus", input);
      if (request.operationRef !== result.operation.operationRef) reject();
      return result as LifecycleObservationResponseTypesV1[K];
    }
    if (method === "listOperations") {
      const request = parseLifecycleObservationV1("pageRequest", requestInput);
      const result = parseLifecycleObservationV1("page", input);
      if (
        result.operations.length > request.limit ||
        result.operations.some(
          (entry) => entry.lifecycleGeneration <= (request.afterGeneration ?? 0),
        )
      )
        reject();
      return result as LifecycleObservationResponseTypesV1[K];
    }
    if (method === "readCapability") {
      parseLifecycleAdmissionV1("scope", requestInput);
      return parseLifecycleObservationV1(
        "capability",
        input,
      ) as LifecycleObservationResponseTypesV1[K];
    }
    if (method === "reconcile") {
      const request = parseLifecycleAdmissionV1("workInput", requestInput);
      const result = parseLifecycleObservationV1("handlerResult", input);
      sameWork(request, result.work);
      return result as LifecycleObservationResponseTypesV1[K];
    }
    reject();
  } catch {
    throw new LifecycleObservationErrorV1();
  }
}
