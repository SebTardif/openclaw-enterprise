import { Type, type Static, type TProperties } from "typebox";
import { BindRuntimeSchemaV1, RUNTIME_AUTHORITY_LIMITS_V1 } from "./runtime-authority-v1.ts";

/** Selected preparation ceilings. These declarations establish no provider guarantees. */
export const RUNTIME_EFFECT_LIMITS_V1 = Object.freeze({
  maxJsonBytes: 262_144,
  maxDepth: 32,
  providerRequestMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.providerRequestMaxMs,
  authorityReadMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.lookupMaxMs,
  observationMaxAgeMs: RUNTIME_AUTHORITY_LIMITS_V1.observationMaxAgeMs,
  uncertaintyMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.clockUncertaintyMaxMs,
});

const closed = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const positiveVersion = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const reference = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:/-]+$" });
const digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const target = BindRuntimeSchemaV1.properties.target;
const uuid = target.properties.createEffectRef;
// Reclose picked DATA dictionaries; the original identity and clock constraints survive.
const scope = closed(Type.Pick(target, ["installationId", "namespaceId", "agentId"]).properties);
const clock = closed(
  Type.Pick(BindRuntimeSchemaV1.properties.observation, [
    "sourceObservedAt",
    "receivedAt",
    "validUntil",
    "uncertaintyMs",
  ]).properties,
);
const responsibility = closed({
  responsibilityRef: uuid,
  responsibilityVersion: positiveVersion,
  kind: Type.Enum(["preparation", "protective-fence", "retained-stop"]),
});

/** Exact effect correspondence for retained readback; DATA confers no effect authority. */
export const ExactEffectLocatorSchemaV1 = closed({
  schemaVersion: Type.Literal(1),
  target,
  effectRef: uuid,
  effectKind: Type.Enum([
    "reserve-inert",
    "materialize",
    "route-active",
    "route-inactive",
    "seal",
    "remove-exact",
  ]),
  responsibility,
  requestDigest: digest,
});
export type ExactEffectLocatorV1 = Static<typeof ExactEffectLocatorSchemaV1>;

/** Expected canonical values compared together by OCC's accepting unit, not a permit. */
export const RuntimeGateGuardSchemaV1 = closed({
  schemaVersion: Type.Literal(1),
  scope,
  intentRef: uuid,
  mode: Type.Enum(["running", "stopped", "disabled"]),
  lifecycleGeneration: positiveVersion,
  requestedFenceEpoch: positiveVersion,
  responsibility,
  gateVersion: positiveVersion,
  planRef: reference,
  planVersion: positiveVersion,
  planDigest: digest,
  admittedChildCutoff: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export type RuntimeGateGuardV1 = Static<typeof RuntimeGateGuardSchemaV1>;

/** Independent source times are retained in projections; parsing supplies no trust. */
export const RuntimeEvidenceProvenanceSchemaV1 = closed({
  producerRef: reference,
  producerServiceVersion: positiveVersion,
  producerProfileRef: reference,
  producerProfileDigest: digest,
  acceptedPortRef: reference,
  evidenceRef: reference,
  evidenceVersion: positiveVersion,
  clock,
});
export type RuntimeEvidenceProvenanceV1 = Static<typeof RuntimeEvidenceProvenanceSchemaV1>;
