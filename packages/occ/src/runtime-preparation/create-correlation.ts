import {
  parseRuntimeAuthorityV1,
  parseRuntimeEffectsResponseV1,
  parseRuntimeEffectsV1,
  runtimeEffectEvidenceFreshV1,
  RUNTIME_EFFECT_LIMITS_V1,
  type DiscoveryResultV1,
  type ExactCreateEffectV1,
  type RuntimeAuthorityContextFactoryV1,
  type RuntimeAuthorityScopeV1,
  type RuntimeEvidenceProvenanceV1,
  type RuntimeReadCallV1,
  type RuntimeServiceTrustConfigurationV1,
} from "@openclaw-enterprise/contracts";
import { immutableCopy, sha256Hex } from "@openclaw-enterprise/utils";
import type { TransactionQuery } from "../ports/repository-factory.ts";
import {
  parseRuntimePreparationCreateLocatorV1,
  resolveRuntimePreparationCreateReferenceV1,
  type RuntimePreparationCreateCorrelationReadV1,
  type RuntimePreparationCreateCorrelationRetainedV1,
  type RuntimePreparationCreateLocatorV1,
} from "./create-reference.ts";

/** An untouched original native operation instance. There is deliberately no
 * exported constructor or structural brand test. Only the original native
 * source can recognize its own operation and the State enrollment consuming it. */
export type RuntimeCreateCorrelationOperationV1 = object;

/** Detached expected data returned AFTER original source acquisition. None of
 * these fields, including the operation UUID, authenticates an operation. */
export interface RuntimeCreateCorrelationRequestV1 {
  readonly operationRef: string;
  readonly requestRef: string;
  readonly scope: RuntimeAuthorityScopeV1;
  readonly locator: RuntimePreparationCreateLocatorV1;
  readonly input: ExactCreateEffectV1;
  readonly expectedVersion: number | null;
}
export interface RuntimeCreateCorrelationReferenceV1 {
  readonly recordRef: string;
  readonly recordVersion: number;
}
export type RuntimeCreateCorrelationProducerV1 = Pick<
  RuntimeEvidenceProvenanceV1,
  | "producerRef"
  | "producerServiceVersion"
  | "producerProfileRef"
  | "producerProfileDigest"
  | "acceptedPortRef"
>;
export interface RuntimeCreateCorrelationAuthorityV1 {
  readonly sourceRef: string;
  readonly configuration: RuntimeServiceTrustConfigurationV1;
  readonly producer: RuntimeCreateCorrelationProducerV1;
}
export interface RuntimeCreateCorrelationObservationV1 {
  readonly namespace: string;
  readonly object: Extract<DiscoveryResultV1, { status: "exact" }>["object"];
  readonly evidence: RuntimeEvidenceProvenanceV1;
}
export interface RuntimeCreateCorrelationRecordV1
  extends RuntimeCreateCorrelationReferenceV1, RuntimeCreateCorrelationObservationV1 {
  readonly input: ExactCreateEffectV1;
}
export interface RuntimeCreateCorrelationCurrentRecordV1 extends RuntimeCreateCorrelationReferenceV1 {
  readonly kind: "create-correlation";
  readonly recordDigest: string;
  readonly configuration: RuntimeServiceTrustConfigurationV1;
  readonly producer: RuntimeCreateCorrelationProducerV1;
}

/** Original State transaction observation; it never becomes the independently
 * owned native source exchange used after COMMIT. Checks are synchronous and
 * query-free. Original owner drains prepareCommit before its final sync fence. */
export interface RuntimeCreateCorrelationLeaseV1 {
  assertCurrent(): undefined;
  prepareCommit(): Promise<void>;
  release(): Promise<void>;
}
export interface RuntimeCreateCorrelationSourceContextV1 {
  readonly installationId: string;
  readonly query: TransactionQuery;
  assertActive(): undefined;
  retain(lease: RuntimeCreateCorrelationLeaseV1): undefined;
}
export interface RuntimeCreateCorrelationAcceptLeaseV1 extends RuntimeCreateCorrelationLeaseV1 {
  readonly request: RuntimeCreateCorrelationRequestV1;
  readonly authority: RuntimeCreateCorrelationAuthorityV1;
  /** Native owns this exchange separately, through the consumer's rechecks.
   * Releasing this State observation lease must not destroy a published exchange.
   * It cannot borrow the temporary Compute read() cancellation lifetime. */
  readonly sourceCall: RuntimeReadCallV1;
  /** Recognize this exact original State read and original provider observation
   * membership; verify retained response/history against actual current object,
   * fence and original provenance. A parsed response or matching UID is no proof. */
  qualifyRetained(
    retained: RuntimePreparationCreateCorrelationRetainedV1,
  ): Promise<RuntimeCreateCorrelationObservationV1>;
}
export interface RuntimeCreateCorrelationReadLeaseV1 extends RuntimeCreateCorrelationLeaseV1 {
  /** Original exchange's privately bound accepting operation identity. State
   * compares it with the immutable record row, not with a caller-supplied claim. */
  readonly operationRef: string;
  readonly authority: RuntimeCreateCorrelationAuthorityV1;
}
/** REQUIRED, STILL UNIMPLEMENTED native supplier. No positive implementation is
 * provided here. Both methods recognize the actual State context and original
 * native exchange, purpose and request. Acquire cleanup must be registered with
 * context.retain before later getters/awaits can lose it; owner also retains a
 * returned lease before reading its members. Source SHARE then service SHARE
 * protects actual current registry on this context; top-level nested reads are
 * not a substitute. The original native query-free fence remains through ACK.
 * readCurrent allows shorter combined signals while preserving original context,
 * requestRef, recipientRef and deadline; exact whole-call identity is incorrect. */
export interface RuntimeCreateCorrelationNativeSourceV1 {
  readonly contextFactory: Pick<RuntimeAuthorityContextFactoryV1<unknown>, "inspect">;
  acquireAccept(
    context: RuntimeCreateCorrelationSourceContextV1,
    originalOperation: RuntimeCreateCorrelationOperationV1,
    originalCall: RuntimeReadCallV1,
  ): Promise<RuntimeCreateCorrelationAcceptLeaseV1>;
  acquireReadCurrent(
    context: RuntimeCreateCorrelationSourceContextV1,
    originalRef: RuntimeCreateCorrelationReferenceV1,
    originalSourceCall: RuntimeReadCallV1,
  ): Promise<RuntimeCreateCorrelationReadLeaseV1>;
}
export type RuntimeCreateCorrelationAcceptResultV1 =
  | Readonly<{
      status: "accepted" | "exact-replay";
      record: RuntimeCreateCorrelationRecordV1;
      sourceCall: RuntimeReadCallV1;
    }>
  | Readonly<{ status: "unavailable" | "unknown" }>;
/** Fixed original State accepting operation, never a free work/candidate callback.
 * Missing source refuses before checkout. Immutable record/head/operation writes
 * use the original transaction/finalizer. Unknown never exposes a record or call.
 * Exact replay cannot refresh evidence or reactivate a superseded head. */
export interface RuntimeCreateCorrelationOwnerV1 {
  accept(
    originalOperation: RuntimeCreateCorrelationOperationV1,
    originalCall: RuntimeReadCallV1,
  ): Promise<RuntimeCreateCorrelationAcceptResultV1>;
  readCurrent(
    originalRef: RuntimeCreateCorrelationReferenceV1,
    originalSourceCall: RuntimeReadCallV1,
  ): Promise<RuntimeCreateCorrelationCurrentRecordV1 | undefined>;
}

/** Original durable envelope, separate from the exact Compute record digest.
 * State allocates recordRef/version; native owns evidenceRef/version/source time.
 * Existing preparation/submission versions are never used for either identity. */
export interface StoredRuntimeCreateCorrelationV1 {
  readonly request: RuntimeCreateCorrelationRequestV1;
  readonly canonicalRequest: string;
  readonly requestDigest: string;
  readonly authority: RuntimeCreateCorrelationAuthorityV1;
  readonly record: RuntimeCreateCorrelationRecordV1;
  readonly canonicalRecord: string;
  readonly recordDigest: string;
}

function requireCorrelation(value: unknown): asserts value {
  if (!value) throw new Error("The original runtime create correlation is unavailable.");
}
function data(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  requireCorrelation(value !== null && typeof value === "object" && !Array.isArray(value));
  requireCorrelation(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  requireCorrelation(
    keys.length === fields.length &&
      keys.every((key) => typeof key === "string" && fields.includes(key)),
  );
  for (const field of fields) {
    const descriptor = descriptors[field];
    requireCorrelation(descriptor && descriptor.enumerable && "value" in descriptor);
  }
}
function reference(value: unknown): asserts value is string {
  requireCorrelation(typeof value === "string" && /^[A-Za-z0-9._:/-]{1,200}$/.test(value));
}
function counter(value: unknown): asserts value is number {
  requireCorrelation(Number.isSafeInteger(value) && Number(value) > 0);
}
function uuid(value: unknown): asserts value is string {
  requireCorrelation(
    typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
  );
}
function digest(value: unknown): asserts value is string {
  requireCorrelation(typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value));
}

/** Matches the existing Compute producer digest: UTF-16 sorted object keys,
 * unchanged array order, finite JSON numbers, no whitespace, original depth and
 * byte bounds. Reject accessors/holes/extra array keys instead of invoking them.
 * This is a data codec, never an authenticator. No aggregate history is passed in. */
export function canonicalRuntimeCreateCorrelationV1(value: unknown): string {
  const canonical = (entry: unknown, depth: number): string => {
    requireCorrelation(depth <= RUNTIME_EFFECT_LIMITS_V1.maxDepth);
    if (entry === null || typeof entry === "string" || typeof entry === "boolean")
      return JSON.stringify(entry);
    if (typeof entry === "number") {
      requireCorrelation(Number.isFinite(entry));
      return JSON.stringify(entry);
    }
    requireCorrelation(entry !== null && typeof entry === "object");
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    const keys = Reflect.ownKeys(entry);
    if (Array.isArray(entry)) {
      requireCorrelation(
        Object.getPrototypeOf(entry) === Array.prototype &&
          entry.length <= 1024 &&
          keys.length === entry.length + 1,
      );
      const parts: string[] = [];
      for (let index = 0; index < entry.length; index++) {
        const descriptor = descriptors[String(index)];
        requireCorrelation(descriptor && descriptor.enumerable && "value" in descriptor);
        parts.push(canonical(descriptor.value, depth + 1));
      }
      return `[${parts.join(",")}]`;
    }
    requireCorrelation(
      Object.getPrototypeOf(entry) === Object.prototype || Object.getPrototypeOf(entry) === null,
    );
    requireCorrelation(keys.length <= 1024 && keys.every((key) => typeof key === "string"));
    const names = keys as string[];
    names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${names
      .map((name) => {
        const descriptor = descriptors[name]!;
        requireCorrelation(descriptor.enumerable && "value" in descriptor);
        return `${JSON.stringify(name)}:${canonical(descriptor.value, depth + 1)}`;
      })
      .join(",")}}`;
  };
  const result = canonical(value, 0);
  requireCorrelation(Buffer.byteLength(result, "utf8") <= RUNTIME_EFFECT_LIMITS_V1.maxJsonBytes);
  return result;
}
function snapshot<T>(value: T): T {
  return immutableCopy(JSON.parse(canonicalRuntimeCreateCorrelationV1(value)) as T);
}
function same(left: unknown, right: unknown): boolean {
  return canonicalRuntimeCreateCorrelationV1(left) === canonicalRuntimeCreateCorrelationV1(right);
}
export function runtimeCreateCorrelationDigestV1(value: unknown): string {
  return `sha256:${sha256Hex(canonicalRuntimeCreateCorrelationV1(value))}`;
}
export function parseRuntimeCreateCorrelationReferenceV1(
  value: unknown,
): RuntimeCreateCorrelationReferenceV1 {
  data(value, ["recordRef", "recordVersion"]);
  reference(value.recordRef);
  counter(value.recordVersion);
  return Object.freeze({ recordRef: value.recordRef, recordVersion: value.recordVersion });
}
export function parseRuntimeCreateCorrelationProducerV1(
  value: unknown,
): RuntimeCreateCorrelationProducerV1 {
  data(value, [
    "producerRef",
    "producerServiceVersion",
    "producerProfileRef",
    "producerProfileDigest",
    "acceptedPortRef",
  ]);
  reference(value.producerRef);
  counter(value.producerServiceVersion);
  reference(value.producerProfileRef);
  digest(value.producerProfileDigest);
  reference(value.acceptedPortRef);
  return Object.freeze({
    producerRef: value.producerRef,
    producerServiceVersion: value.producerServiceVersion,
    producerProfileRef: value.producerProfileRef,
    producerProfileDigest: value.producerProfileDigest,
    acceptedPortRef: value.acceptedPortRef,
  });
}
export function parseRuntimeCreateCorrelationAuthorityV1(
  value: unknown,
): RuntimeCreateCorrelationAuthorityV1 {
  data(value, ["sourceRef", "configuration", "producer"]);
  reference(value.sourceRef);
  const configuration = parseRuntimeAuthorityV1("serviceTrust", snapshot(value.configuration));
  const producer = parseRuntimeCreateCorrelationProducerV1(value.producer);
  return immutableCopy({ sourceRef: value.sourceRef, configuration, producer });
}
export function parseRuntimeCreateCorrelationRequestV1(
  value: unknown,
): RuntimeCreateCorrelationRequestV1 {
  data(value, ["operationRef", "requestRef", "scope", "locator", "input", "expectedVersion"]);
  uuid(value.operationRef);
  reference(value.requestRef);
  data(value.scope, ["installationId", "namespaceId", "agentId"]);
  const input = parseRuntimeEffectsV1("exactCreate", snapshot(value.input));
  const target = input.effect.target;
  requireCorrelation(
    same(value.scope, {
      installationId: target.installationId,
      namespaceId: target.namespaceId,
      agentId: target.agentId,
    }),
  );
  const locator = parseRuntimePreparationCreateLocatorV1(
    snapshot(value.locator) as RuntimePreparationCreateLocatorV1,
  );
  if (locator.kind === "create-effect")
    requireCorrelation(locator.createEffectRef === input.effect.effectRef);
  let expectedVersion: number | null = null;
  if (value.expectedVersion !== null) {
    counter(value.expectedVersion);
    requireCorrelation(value.expectedVersion < Number.MAX_SAFE_INTEGER);
    expectedVersion = value.expectedVersion;
  }
  // The accepted original historical projection has expectedObject:null. A
  // supplied object would be a different query; never rewrite it into this one.
  requireCorrelation(input.expectedObject === null);
  const result = {
    operationRef: value.operationRef,
    requestRef: value.requestRef,
    scope: {
      installationId: target.installationId,
      namespaceId: target.namespaceId,
      agentId: target.agentId,
    },
    locator,
    input,
    expectedVersion,
  };
  return snapshot(result);
}
function producerOf(evidence: RuntimeEvidenceProvenanceV1): RuntimeCreateCorrelationProducerV1 {
  return {
    producerRef: evidence.producerRef,
    producerServiceVersion: evidence.producerServiceVersion,
    producerProfileRef: evidence.producerProfileRef,
    producerProfileDigest: evidence.producerProfileDigest,
    acceptedPortRef: evidence.acceptedPortRef,
  };
}
function scoped(
  authority: RuntimeCreateCorrelationAuthorityV1,
  scope: RuntimeAuthorityScopeV1,
): void {
  requireCorrelation(authority.configuration.installationId === scope.installationId);
  const allowed = authority.configuration.allowedScope;
  requireCorrelation(allowed.installationId === scope.installationId);
  if (allowed.kind === "agent")
    requireCorrelation(
      allowed.namespaceId === scope.namespaceId && allowed.agentId === scope.agentId,
    );
  // A matching configuration is only necessary data correspondence. Native must
  // independently qualify the actual role/purpose and current registry admission.
}
export function parseRuntimeCreateCorrelationRecordV1(
  value: unknown,
): RuntimeCreateCorrelationRecordV1 {
  data(value, ["recordRef", "recordVersion", "input", "namespace", "object", "evidence"]);
  const identity = parseRuntimeCreateCorrelationReferenceV1({
    recordRef: value.recordRef,
    recordVersion: value.recordVersion,
  });
  requireCorrelation(
    typeof value.namespace === "string" &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.namespace),
  );
  const input = parseRuntimeEffectsV1("exactCreate", snapshot(value.input));
  const parsed = parseRuntimeEffectsResponseV1("discover", input, {
    schemaVersion: 1,
    status: "exact",
    input,
    object: snapshot(value.object),
    correlationEvidence: snapshot(value.evidence),
  });
  requireCorrelation(parsed.status === "exact");
  return snapshot({
    ...identity,
    input,
    namespace: value.namespace,
    object: parsed.object,
    evidence: parsed.correlationEvidence,
  });
}

/** Pure fixed correspondence used by the original State accepting operation.
 * State must first acquire/retain its authentic native source, pass the ORIGINAL
 * read object to qualifyRetained, and retain independent currentness through ACK.
 * Calling this function with representation fixtures does not admit a record. */
export function prepareRuntimeCreateCorrelationV1(
  requestValue: RuntimeCreateCorrelationRequestV1,
  authorityValue: RuntimeCreateCorrelationAuthorityV1,
  originalRead: RuntimePreparationCreateCorrelationReadV1,
  observationValue: RuntimeCreateCorrelationObservationV1,
  referenceValue: RuntimeCreateCorrelationReferenceV1,
  now: string,
): StoredRuntimeCreateCorrelationV1 {
  const request = parseRuntimeCreateCorrelationRequestV1(requestValue);
  const authority = parseRuntimeCreateCorrelationAuthorityV1(authorityValue);
  const identity = parseRuntimeCreateCorrelationReferenceV1(referenceValue);
  scoped(authority, request.scope);
  requireCorrelation(
    identity.recordVersion === (request.expectedVersion === null ? 1 : request.expectedVersion + 1),
  );
  const located = resolveRuntimePreparationCreateReferenceV1(
    request.scope,
    request.locator,
    originalRead,
  );
  requireCorrelation(
    located.status === "located" && located.retained.submission && located.retained.response,
  );
  requireCorrelation(same(located.input, request.input));
  data(observationValue, ["namespace", "object", "evidence"]);
  const record = parseRuntimeCreateCorrelationRecordV1({
    ...identity,
    input: located.input,
    namespace: observationValue.namespace,
    object: observationValue.object,
    evidence: observationValue.evidence,
  });
  const response = located.retained.response;
  requireCorrelation(
    record.namespace === response.namespace &&
      record.object.target.name === response.name &&
      record.object.uid === response.uid,
  );
  // Current provider resourceVersion/fenceEpoch come from the authentic original
  // observation. An immutable create response may have an older resourceVersion.
  // Neither response time, preparation version nor requestedFenceEpoch fills them.
  requireCorrelation(same(producerOf(record.evidence), authority.producer));
  requireCorrelation(runtimeEffectEvidenceFreshV1(record.evidence, now, null));
  const canonicalRequest = canonicalRuntimeCreateCorrelationV1(request);
  const canonicalRecord = canonicalRuntimeCreateCorrelationV1(record);
  return immutableCopy({
    request,
    canonicalRequest,
    requestDigest: `sha256:${sha256Hex(canonicalRequest)}`,
    authority,
    record,
    canonicalRecord,
    recordDigest: `sha256:${sha256Hex(canonicalRecord)}`,
  });
}

/** Decode immutable durable representation without refreshing evidence time.
 * History is validated at acceptance with the original historical reader, not
 * stored as a second aggregate mutation or reselected from latest preparation. */
export function decodeStoredRuntimeCreateCorrelationV1(
  value: unknown,
): StoredRuntimeCreateCorrelationV1 {
  data(value, [
    "request",
    "canonicalRequest",
    "requestDigest",
    "authority",
    "record",
    "canonicalRecord",
    "recordDigest",
  ]);
  const request = parseRuntimeCreateCorrelationRequestV1(value.request);
  const authority = parseRuntimeCreateCorrelationAuthorityV1(value.authority);
  const record = parseRuntimeCreateCorrelationRecordV1(value.record);
  scoped(authority, request.scope);
  requireCorrelation(
    record.recordVersion === (request.expectedVersion === null ? 1 : request.expectedVersion + 1),
  );
  requireCorrelation(
    same(record.input, request.input) && same(producerOf(record.evidence), authority.producer),
  );
  const canonicalRequest = canonicalRuntimeCreateCorrelationV1(request);
  const canonicalRecord = canonicalRuntimeCreateCorrelationV1(record);
  requireCorrelation(
    value.canonicalRequest === canonicalRequest &&
      value.requestDigest === `sha256:${sha256Hex(canonicalRequest)}`,
  );
  requireCorrelation(
    value.canonicalRecord === canonicalRecord &&
      value.recordDigest === `sha256:${sha256Hex(canonicalRecord)}`,
  );
  return immutableCopy({
    request,
    canonicalRequest,
    requestDigest: value.requestDigest as string,
    authority,
    record,
    canonicalRecord,
    recordDigest: value.recordDigest as string,
  });
}

/** Necessary current-row projection only. State ALSO requires native original
 * read membership, exact operation association, current head/ref/version and its
 * retained registry/native fence. This helper cannot restore any of those rights. */
export function currentRuntimeCreateCorrelationV1(
  value: StoredRuntimeCreateCorrelationV1,
  authorityValue: RuntimeCreateCorrelationAuthorityV1,
  now: string,
): RuntimeCreateCorrelationCurrentRecordV1 {
  const stored = decodeStoredRuntimeCreateCorrelationV1(value);
  const authority = parseRuntimeCreateCorrelationAuthorityV1(authorityValue);
  requireCorrelation(same(stored.authority, authority));
  requireCorrelation(runtimeEffectEvidenceFreshV1(stored.record.evidence, now, null));
  return immutableCopy({
    kind: "create-correlation",
    recordRef: stored.record.recordRef,
    recordVersion: stored.record.recordVersion,
    recordDigest: stored.recordDigest,
    configuration: authority.configuration,
    producer: authority.producer,
  });
}
