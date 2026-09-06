import { Type, type Static, type TProperties } from "typebox";
import {
  RUNTIME_EFFECT_LIMITS_V1,
  RuntimeEvidenceProvenanceSchemaV1,
  RuntimeObservationInputSchemaV1,
  RuntimeObservationResultSchemaV1,
  type RuntimeReadCallV1,
} from "./runtime-effects-v1.ts";

/** In-process value contract. Serialized producer/identity/proof fields are untrusted.
 * Only the original authenticated boundaries can establish their provenance. */
export const CONTAINMENT_CONTROLS_VERSION_V1 = Object.freeze({
  schema: 1,
  projection: 1,
} as const);
export const CONTAINMENT_CONTROLS_LIMITS_V1 = Object.freeze({
  maxInputBytes: RUNTIME_EFFECT_LIMITS_V1.maxJsonBytes,
  maxDepth: RUNTIME_EFFECT_LIMITS_V1.maxDepth,
  maxNodes: 16_384,
  maxContainerEntries: 256,
  maxControls: 8,
  observationMaxAgeMs: RUNTIME_EFFECT_LIMITS_V1.observationMaxAgeMs,
  uncertaintyMaxMs: RUNTIME_EFFECT_LIMITS_V1.uncertaintyMaxMs,
  providerRequestMaxMs: RUNTIME_EFFECT_LIMITS_V1.providerRequestMaxMs,
  authorityReadMaxMs: RUNTIME_EFFECT_LIMITS_V1.authorityReadMaxMs,
});
export const CONTAINMENT_CONTROL_KINDS_V1 = Object.freeze([
  "runtime-isolation",
  "process-restrictions",
  "mount-restrictions",
  "outer-network",
  "aggregate-network-policy",
  "protected-resolution",
  "authenticated-mediation",
  "credential-separation",
] as const);
export type ContainmentControlKindV1 = (typeof CONTAINMENT_CONTROL_KINDS_V1)[number];

const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const version = Type.Literal(1);
const counter = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const provenance = RuntimeEvidenceProvenanceSchemaV1;
const ref = provenance.properties.producerRef;
const complete = RuntimeObservationResultSchemaV1.anyOf[0];
const policy = complete.properties.profile.properties;
const boundInput = RuntimeObservationInputSchemaV1.anyOf[0];
const reason = RuntimeObservationResultSchemaV1.anyOf[1].properties.reasonCode;
const control = Type.Enum(CONTAINMENT_CONTROL_KINDS_V1);

/** Producer restart ordering, distinct from the execution restart discriminator in
 * the original Runtime binding. Epoch versions come from protected producer custody;
 * lexicographic ordering of epoch refs or receipt times is never meaningful. */
export const ContainmentControlCursorSchemaV1 = object({
  producerRef: ref,
  epochRef: ref,
  epochVersion: counter,
  evidenceVersion: counter,
  sourceObservedAt: provenance.properties.clock.properties.sourceObservedAt,
});
export type ContainmentControlCursorV1 = Static<typeof ContainmentControlCursorSchemaV1>;

export const ContainmentControlInputSchemaV1 = object({
  schemaVersion: version,
  projectionVersion: version,
  requestRef: boundInput.properties.target.properties.createEffectRef,
  runtime: boundInput,
  /** Exact admitted containment profile, independently supplied by its owner. */
  containmentProfile: policy.desired,
  requiredControls: Type.Array(object({ control, desired: policy.desired }), {
    minItems: 1,
    maxItems: CONTAINMENT_CONTROLS_LIMITS_V1.maxControls,
  }),
  /** Null means there is no retained cursor, not that replay protection is optional. */
  after: Type.Union([Type.Null(), ContainmentControlCursorSchemaV1]),
  maxAgeMs: Type.Integer({
    minimum: 0,
    maximum: CONTAINMENT_CONTROLS_LIMITS_V1.observationMaxAgeMs,
  }),
  maxUncertaintyMs: Type.Integer({
    minimum: 0,
    maximum: CONTAINMENT_CONTROLS_LIMITS_V1.uncertaintyMaxMs,
  }),
});
export type ContainmentControlInputV1 = Static<typeof ContainmentControlInputSchemaV1>;

/** Original stage schemas are projected without a second policy/provenance dialect.
 * Missing delivered/effective evidence is explicit. An effective claim requires both
 * stages to match desired; the codec does not authenticate or evaluate that claim. */
export const ContainmentControlRecordSchemaV1 = object({
  control,
  desired: policy.desired,
  delivered: Type.Union([Type.Null(), policy.delivered]),
  effective: Type.Union([Type.Null(), policy.effective]),
  outcome: Type.Enum(["effective", "ineffective", "unknown"]),
  reasonCode: Type.Union([Type.Null(), reason]),
  source: provenance,
  /** Applies to this original control producer, including its policy-stage records. */
  sourceEpoch: Type.Pick(ContainmentControlCursorSchemaV1, ["epochRef", "epochVersion"]),
});
export type ContainmentControlRecordV1 = Static<typeof ContainmentControlRecordSchemaV1>;

const resultCommon = {
  schemaVersion: version,
  projectionVersion: version,
  input: ContainmentControlInputSchemaV1,
  eligibility: Type.Literal("observation-only"),
};
export const ContainmentControlResultSchemaV1 = Type.Union([
  object({
    ...resultCommon,
    status: Type.Literal("observed"),
    runtimeObservation: RuntimeObservationResultSchemaV1,
    cursor: ContainmentControlCursorSchemaV1,
    observation: provenance,
    controls: Type.Array(ContainmentControlRecordSchemaV1, {
      minItems: 1,
      maxItems: CONTAINMENT_CONTROLS_LIMITS_V1.maxControls,
    }),
  }),
  object({
    ...resultCommon,
    status: Type.Enum(["unknown", "unavailable", "cancelled", "deadline-exceeded"]),
    reasonCode: reason,
  }),
]);
export type ContainmentControlResultV1 = Static<typeof ContainmentControlResultSchemaV1>;

export type ImmutableContainmentControlV1<T> = T extends readonly (infer U)[]
  ? readonly ImmutableContainmentControlV1<U>[]
  : T extends object
    ? { readonly [K in keyof T]: ImmutableContainmentControlV1<T[K]> }
    : T;
export type ContainmentControlDecodeV1<T> =
  | Readonly<{ kind: "valid"; value: ImmutableContainmentControlV1<T> }>
  | Readonly<{ kind: "invalid"; reasonCode: "invalid-input" }>;

/** One containment-owned projection over original Runtime and control producers.
 * Each call is one finite read, including exact readback after unknown/cancellation.
 * It uses the existing authenticated Runtime call/context and exact read authority.
 * Provider RPCs finish within min(remaining deadline, 10s), authority reads within
 * min(remaining deadline, 3s); a trusted monotonic deadline and AbortSignal bound
 * all waiting. Pre-abort starts no read. Cancellation/outage returns a closed result
 * and conveys neither revocation nor physical stop. No stream or retry loop is defined.
 */
export interface ContainmentControlObserverV1 {
  readControls(
    input: ImmutableContainmentControlV1<ContainmentControlInputV1>,
    call: RuntimeReadCallV1,
  ): Promise<ImmutableContainmentControlV1<ContainmentControlResultV1>>;
}
