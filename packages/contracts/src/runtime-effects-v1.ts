import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { sha256Hex } from "@openclaw-enterprise/utils";
import {
  BindRuntimeSchemaV1,
  RuntimeBindingSchemaV1,
  RuntimeEvidenceSchemaV1,
  RUNTIME_AUTHORITY_LIMITS_V1,
  parseRuntimeAuthorityV1,
  type AuthorityCallV1,
  type AssignmentRefV1,
  type RuntimeAssignmentTargetV1,
  type RuntimeBindingV1,
  type RuntimeAuthorityScopeV1,
  type BindRuntimeV1,
} from "./runtime-authority-v1.ts";
import {
  StoreBindingRefSchemaV1,
  StoreBindingSchemaV1,
  storeBindingPolicyConsistentV1,
} from "./completed-state-v1.ts";
import {
  WorkspaceReservationRefSchemaV1,
  WorkspaceAttemptRefSchemaV1,
} from "./workspace-reservation-v1.ts";

/** Versioned declarations and value validation. No provider, authority, journal or
 * transport implementation is supplied. Parsed evidence is data, never permission. */
export const RUNTIME_EFFECT_LIMITS_V1 = Object.freeze({
  maxJsonBytes: 262_144,
  maxDepth: 32,
  maxTargets: 32,
  maxProducerDomains: 16,
  maxChildren: 256,
  maxStores: 16,
  maxWriters: 64,
  maxCanonicalRequestBytes: 65_536,
  providerRequestMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.providerRequestMaxMs,
  authorityReadMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.lookupMaxMs,
  observationMaxAgeMs: RUNTIME_AUTHORITY_LIMITS_V1.observationMaxAgeMs,
  uncertaintyMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.clockUncertaintyMaxMs,
  gracefulStopMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.gracefulStopMaxMs,
  stopObservationMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.terminationObservationMaxMs,
  denialTargetMs: 60_000, // Unmeasured target; neither deadline nor denial proves termination.
});
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const enumOf = <T extends string>(values: readonly T[]) => Type.Enum(values);
const v1 = Type.Literal(1);
const counter = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const ref = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:/-]+$" });
const digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const timestamp = Type.String({
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
});
const target = BindRuntimeSchemaV1.properties.target;
const assignmentRef = target.properties.assignmentRef;
const uuid = target.properties.createEffectRef;
const scope = Type.Pick(target, ["installationId", "namespaceId", "agentId"]);
const clock = Type.Pick(BindRuntimeSchemaV1.properties.observation, [
  "sourceObservedAt",
  "receivedAt",
  "validUntil",
  "uncertaintyMs",
]);
export type RuntimeEffectTargetV1 = RuntimeAssignmentTargetV1;
export type RuntimeEffectAssignmentRefV1 = AssignmentRefV1;
export type RuntimeEffectScopeV1 = RuntimeAuthorityScopeV1;
export type RuntimeEffectClockV1 = Pick<
  BindRuntimeV1["observation"],
  "sourceObservedAt" | "receivedAt" | "validUntil" | "uncertaintyMs"
>;
export type RuntimeEffectBindingV1 = RuntimeBindingV1;

const responsibility = object({
  responsibilityRef: uuid,
  responsibilityVersion: counter,
  kind: enumOf(["preparation", "protective-fence", "retained-stop"]),
});
const effectKind = enumOf([
  "reserve-inert",
  "materialize",
  "route-active",
  "route-inactive",
  "seal",
  "remove-exact",
]);
export const ExactEffectLocatorSchemaV1 = object({
  schemaVersion: v1,
  target,
  effectRef: uuid,
  effectKind,
  responsibility,
  requestDigest: digest,
});
export type ExactEffectLocatorV1 = Static<typeof ExactEffectLocatorSchemaV1>;
/** Opaque resourceVersion is compared by the provider, never incremented locally. */
export const RuntimeProviderTargetSchemaV1 = object({
  targetRef: ref,
  clusterRef: ref,
  kubernetesNamespaceUid: ref,
  apiKind: enumOf(["Deployment", "Service", "HTTPRoute", "EndpointSlice"]),
  name: Type.String({ minLength: 1, maxLength: 253, pattern: "^[a-z0-9][a-z0-9.-]*$" }),
  ownerAssignmentRef: assignmentRef,
  ownerCreateEffectRef: uuid,
});
export type RuntimeProviderTargetV1 = Static<typeof RuntimeProviderTargetSchemaV1>;
const providerObject = object({
  target: RuntimeProviderTargetSchemaV1,
  uid: ref,
  resourceVersion: ref,
  fenceEpoch: counter,
});
const predicate = Type.Union([
  object({
    kind: Type.Literal("expected-absent"),
    retention: Type.Literal("permanent-inert-reservation"),
  }),
  object({
    kind: Type.Literal("expected-object"),
    uid: ref,
    resourceVersion: ref,
    fenceEpoch: counter,
    ownerAssignmentRef: assignmentRef,
    ownerCreateEffectRef: uuid,
  }),
]);
const producerDomain = object({
  domainRef: ref,
  kind: enumOf([
    "deployment-descendants",
    "node-start-restart",
    "gateway-helpers",
    "store-maintenance",
  ]),
  targetRefs: Type.Array(ref, { minItems: 1, maxItems: 32 }),
  requiredProducerRef: ref,
  requiredCapabilityRef: ref,
});
export const RuntimeClosedPlanSchemaV1 = object({
  schemaVersion: v1,
  scope,
  planRef: ref,
  planVersion: counter,
  planDigest: digest,
  targets: Type.Array(
    object({
      target: RuntimeProviderTargetSchemaV1,
      desiredSpecDigest: digest,
      allowedMutations: Type.Array(effectKind, { minItems: 1, maxItems: 6 }),
    }),
    { minItems: 1, maxItems: 32 },
  ),
  producerDomains: Type.Array(producerDomain, { minItems: 1, maxItems: 16 }),
  reservationRetention: Type.Literal("permanent"),
  capacityPolicyRef: ref,
});
export type RuntimeClosedPlanV1 = Static<typeof RuntimeClosedPlanSchemaV1>;
/** These are expected canonical values, not an admission token. One OCC acceptance
 * unit compares ALL of them for child admission, plan changes and fence completion. */
export const RuntimeGateGuardSchemaV1 = object({
  schemaVersion: v1,
  scope,
  intentRef: uuid,
  mode: enumOf(["running", "stopped", "disabled"]),
  lifecycleGeneration: counter,
  requestedFenceEpoch: counter,
  responsibility,
  gateVersion: counter,
  planRef: ref,
  planVersion: counter,
  planDigest: digest,
  admittedChildCutoff: sequence,
});
export type RuntimeGateGuardV1 = Static<typeof RuntimeGateGuardSchemaV1>;
const provenance = object({
  producerRef: ref,
  producerServiceVersion: counter,
  producerProfileRef: ref,
  producerProfileDigest: digest,
  acceptedPortRef: ref,
  evidenceRef: ref,
  evidenceVersion: counter,
  clock,
});
export const RuntimeEvidenceProvenanceSchemaV1 = provenance;
export type RuntimeEvidenceProvenanceV1 = Static<typeof provenance>;
const reason = enumOf([
  "denied",
  "unavailable",
  "conflict",
  "capability-unsupported",
  "authority-unavailable",
  "authority-lost",
  "capacity-exhausted",
  "ownership-mismatch",
  "evidence-stale",
  "evidence-incomplete",
  "provider-outcome-unknown",
  "writer-unresolved",
  "source-time-invalid",
  "cancelled",
  "deadline-exceeded",
  "precondition-failed",
  "gate-changed",
  "sealer-closed",
  "domain-invalid",
  "store-mismatch",
]);
const unavailable = object({ status: Type.Literal("unavailable"), reasonCode: reason });
const admittedRuntime = object({
  provider: enumOf(["occ/kubernetes-gvisor", "occ/kubernetes-gateway"]),
  imageSetDigest: digest,
  configurationDigest: digest,
  runtimeProfileRef: ref,
  runtimeProfileDigest: digest,
  containmentProfileDigest: digest,
  mountPolicyDigest: digest,
  resourceEnvelopeDigest: digest,
});
const storeRefs = Type.Array(StoreBindingRefSchemaV1, { minItems: 1, maxItems: 16 });
export const PriorWriterEvidenceRefSchemaV1 = object({
  evidenceRef: ref,
  evidenceVersion: counter,
  reservation: WorkspaceReservationRefSchemaV1,
  workspaceStore: StoreBindingRefSchemaV1,
  stores: storeRefs,
  closedPlanDigest: digest,
  admittedChildCutoff: sequence,
});
const preparation = Type.Union([
  object({
    kind: Type.Literal("nonmutating"),
    preparationRef: uuid,
    preparationVersion: counter,
    admittedProfileDigest: digest,
    retainedStoreAccess: Type.Literal("none"),
  }),
  object({
    kind: Type.Literal("writable"),
    preparationRef: uuid,
    preparationVersion: counter,
    admittedProfileDigest: digest,
    priorWriterEvidence: PriorWriterEvidenceRefSchemaV1,
  }),
]);
const effectInput = {
  schemaVersion: v1,
  effect: ExactEffectLocatorSchemaV1,
  gate: RuntimeGateGuardSchemaV1,
  plan: RuntimeClosedPlanSchemaV1,
  providerTarget: RuntimeProviderTargetSchemaV1,
  predicate,
};
export const RuntimeCreateSchemaV1 = object({
  ...effectInput,
  kind: Type.Literal("create"),
  action: enumOf(["reserve-inert", "materialize"]),
  admittedRuntime,
  preparation,
});
export type RuntimeCreateV1 = Static<typeof RuntimeCreateSchemaV1>;
const routeChoice = Type.Union([
  object({ kind: Type.Literal("inactive"), reservedUnmatchableRouteRef: ref }),
  object({
    kind: Type.Literal("active"),
    selectedTarget: target,
    binding: RuntimeBindingSchemaV1,
    selectionRef: uuid,
    selectionVersion: counter,
    priorWriterEvidence: PriorWriterEvidenceRefSchemaV1,
  }),
]);
export const ConditionalRouteSchemaV1 = object({
  ...effectInput,
  kind: Type.Literal("set-route"),
  desiredRoute: routeChoice,
});
export type ConditionalRouteV1 = Static<typeof ConditionalRouteSchemaV1>;
export const ExactCleanupSchemaV1 = object({
  ...effectInput,
  kind: Type.Literal("stop-retaining-state"),
  binding: RuntimeBindingSchemaV1,
  action: enumOf(["seal", "remove-exact"]),
  retainedStores: storeRefs,
  retainState: Type.Literal(true),
  gracefulStopMs: Type.Integer({ minimum: 0, maximum: 30_000 }),
  observeForMs: Type.Integer({ minimum: 1, maximum: 120_000 }),
});
export type ExactCleanupV1 = Static<typeof ExactCleanupSchemaV1>;
/** Protective sealing of a reserved object does not require a runtime binding that
 * may never have existed. This child is prepared by advanceFence under its exact
 * independent protective responsibility; it cannot materialize or activate a target.
 */
export const RuntimeSealSchemaV1 = object({
  ...effectInput,
  kind: Type.Literal("seal-target"),
  action: Type.Literal("seal"),
  retainState: Type.Literal(true),
  safeState: Type.Union([
    object({ kind: Type.Literal("replicas-zero"), replicas: Type.Literal(0) }),
    object({ kind: Type.Literal("inactive-route"), reservedUnmatchableRouteRef: ref }),
  ]),
});
export type RuntimeSealV1 = Static<typeof RuntimeSealSchemaV1>;
export const RuntimeEffectRequestSchemaV1 = Type.Union([
  RuntimeCreateSchemaV1,
  ConditionalRouteSchemaV1,
  ExactCleanupSchemaV1,
  RuntimeSealSchemaV1,
]);
export type RuntimeEffectRequestV1 = Static<typeof RuntimeEffectRequestSchemaV1>;

/** A provider object's successful patch is distinct from effective routing. */
const routeEvidence = Type.Union([
  object({
    status: Type.Literal("observed"),
    route: routeChoice,
    controlObject: providerObject,
    dataPlaneEvidence: provenance,
  }),
  object({ status: enumOf(["pending", "unknown"]), reasonCode: reason }),
]);
const execution = object({ target, binding: RuntimeBindingSchemaV1 });
const termination = Type.Union([
  object({ status: Type.Literal("terminated"), execution, terminationEvidence: provenance }),
  object({ status: enumOf(["running", "unknown"]), execution, reasonCode: reason }),
]);
const effectResultCommon = { schemaVersion: v1, effect: ExactEffectLocatorSchemaV1 };
export const RuntimeEffectResultSchemaV1 = Type.Union([
  object({
    ...effectResultCommon,
    status: Type.Literal("not-submitted"),
    boundary: Type.Literal("before-any-possible-submission"),
    reasonCode: reason,
    durableNonSubmissionEvidence: provenance,
  }),
  object({
    ...effectResultCommon,
    status: Type.Literal("applied"),
    object: providerObject,
    providerReceipt: provenance,
    route: Type.Optional(routeEvidence),
    termination: Type.Optional(termination),
  }),
  object({
    ...effectResultCommon,
    status: Type.Literal("rejected"),
    reasonCode: reason,
    providerRejectionEvidence: provenance,
  }),
  object({
    ...effectResultCommon,
    status: Type.Literal("unknown"),
    phase: enumOf(["admission-commit", "submission", "provider-response", "readback"]),
    reasonCode: reason,
  }),
  object({
    ...effectResultCommon,
    status: Type.Literal("unsupported"),
    capabilityRef: ref,
    reasonCode: Type.Literal("capability-unsupported"),
  }),
]);
export type RuntimeEffectResultV1 = Static<typeof RuntimeEffectResultSchemaV1>;
export const RuntimeEffectStateSchemaV1 = Type.Union([
  RuntimeEffectResultSchemaV1,
  object({
    ...effectResultCommon,
    status: Type.Literal("not-found"),
    outcome: Type.Literal("unknown"),
  }),
]);
export type RuntimeEffectStateV1 = Static<typeof RuntimeEffectStateSchemaV1>;
export const ExactCreateEffectSchemaV1 = object({
  schemaVersion: v1,
  effect: ExactEffectLocatorSchemaV1,
  providerTarget: RuntimeProviderTargetSchemaV1,
  expectedObject: Type.Union([Type.Null(), providerObject]),
});
export type ExactCreateEffectV1 = Static<typeof ExactCreateEffectSchemaV1>;
export const DiscoveryResultSchemaV1 = Type.Union([
  object({
    schemaVersion: v1,
    status: Type.Literal("exact"),
    input: ExactCreateEffectSchemaV1,
    object: providerObject,
    correlationEvidence: provenance,
  }),
  object({
    schemaVersion: v1,
    status: enumOf(["incomplete", "ambiguous", "unknown", "conflict"]),
    input: ExactCreateEffectSchemaV1,
    reasonCode: reason,
  }),
]);
export type DiscoveryResultV1 = Static<typeof DiscoveryResultSchemaV1>;

const observationCommon = {
  schemaVersion: v1,
  target,
  expectedEvidenceVersion: Type.Union([Type.Null(), counter]),
};
export const RuntimeObservationInputSchemaV1 = Type.Union([
  object({
    ...observationCommon,
    kind: Type.Literal("bound-instance"),
    binding: RuntimeBindingSchemaV1,
  }),
  object({
    ...observationCommon,
    kind: Type.Literal("preallocated-candidate"),
    createEffect: ExactCreateEffectSchemaV1,
    responsibility,
    preparation,
  }),
]);
export type RuntimeObservationInputV1 = Static<typeof RuntimeObservationInputSchemaV1>;
const policyObservation = object({
  desired: object({ profileRef: ref, version: counter, digest }),
  delivered: object({ profileRef: ref, version: counter, digest, evidence: provenance }),
  effective: object({ profileRef: ref, version: counter, digest, evidence: provenance }),
});
export const RuntimeObservationResultSchemaV1 = Type.Union([
  object({
    schemaVersion: v1,
    status: Type.Literal("complete"),
    input: RuntimeObservationInputSchemaV1,
    object: providerObject,
    binding: RuntimeBindingSchemaV1,
    observation: provenance,
    ownerChainEvidence: provenance,
    executionCorrespondenceEvidence: provenance,
    profile: policyObservation,
    identityEvidence: Type.Union([RuntimeEvidenceSchemaV1, Type.Null()]),
    // Candidate observation can precede target SVID/bind/restore; null never asserts identity-ready.
    eligibility: Type.Literal("observation-only"),
  }),
  object({
    schemaVersion: v1,
    status: enumOf(["incomplete", "ambiguous", "unknown"]),
    input: RuntimeObservationInputSchemaV1,
    reasonCode: reason,
  }),
]);
export type RuntimeObservationResultV1 = Static<typeof RuntimeObservationResultSchemaV1>;

const childCoverage = Type.Union([
  object({
    effect: ExactEffectLocatorSchemaV1,
    status: Type.Literal("settled"),
    outcome: enumOf(["not-submitted", "applied", "rejected"]),
    evidence: provenance,
  }),
  object({
    effect: ExactEffectLocatorSchemaV1,
    status: Type.Literal("sealed"),
    historicalOutcome: enumOf(["unknown", "applied", "rejected"]),
    seal: providerObject,
    retainedPredicate: predicate,
    evidence: provenance,
  }),
  object({
    effect: ExactEffectLocatorSchemaV1,
    status: Type.Literal("unknown"),
    reasonCode: reason,
  }),
]);
export const RuntimeFenceRequestSchemaV1 = object({
  schemaVersion: v1,
  fenceRef: uuid,
  requestDigest: digest,
  guard: RuntimeGateGuardSchemaV1,
  plan: RuntimeClosedPlanSchemaV1,
  children: Type.Array(ExactEffectLocatorSchemaV1, { maxItems: 256 }),
});
export type RuntimeFenceRequestV1 = Static<typeof RuntimeFenceRequestSchemaV1>;
const fenceTarget = Type.Union([
  object({
    target: RuntimeProviderTargetSchemaV1,
    status: Type.Literal("sealed"),
    object: providerObject,
    evidence: provenance,
  }),
  object({
    target: RuntimeProviderTargetSchemaV1,
    status: Type.Literal("settled"),
    evidence: provenance,
  }),
  object({
    target: RuntimeProviderTargetSchemaV1,
    status: Type.Literal("unknown"),
    reasonCode: reason,
  }),
]);
export const RuntimeFenceCompletionProposalSchemaV1 = object({
  schemaVersion: v1,
  kind: Type.Literal("complete-fence"),
  request: RuntimeFenceRequestSchemaV1,
  targets: Type.Array(fenceTarget, { minItems: 1, maxItems: 32 }),
  children: Type.Array(childCoverage, { maxItems: 256 }),
});
export type RuntimeFenceCompletionProposalV1 = Static<
  typeof RuntimeFenceCompletionProposalSchemaV1
>;
export const RuntimeFenceStateSchemaV1 = Type.Union([
  object({
    schemaVersion: v1,
    status: Type.Literal("established"),
    request: RuntimeFenceRequestSchemaV1,
    targets: Type.Array(fenceTarget, { minItems: 1, maxItems: 32 }),
    children: Type.Array(childCoverage, { maxItems: 256 }),
    completion: object({
      comparedGuard: RuntimeGateGuardSchemaV1,
      committedGateVersion: counter,
      sealerAdmission: Type.Literal("closed"),
      successorAdmission: Type.Literal("current-matching-only"),
      evidence: provenance,
    }),
    guarantee: Type.Literal("explicit-provider-submission-fence-only"),
  }),
  object({
    schemaVersion: v1,
    status: Type.Literal("pending"),
    request: RuntimeFenceRequestSchemaV1,
    targets: Type.Array(fenceTarget, { maxItems: 32 }),
    children: Type.Array(childCoverage, { maxItems: 256 }),
  }),
  object({
    schemaVersion: v1,
    status: enumOf(["conflict", "unavailable", "commit-unknown"]),
    request: RuntimeFenceRequestSchemaV1,
    reasonCode: reason,
  }),
]);
export type RuntimeFenceStateV1 = Static<typeof RuntimeFenceStateSchemaV1>;

const possibleWriter = Type.Union([
  object({ kind: Type.Literal("execution"), ownerRef: ref, execution }),
  object({ kind: Type.Literal("create"), ownerRef: ref, effect: ExactEffectLocatorSchemaV1 }),
  object({ kind: Type.Literal("restore"), ownerRef: ref, restoreRef: ref, target, responsibility }),
  object({
    kind: Type.Literal("attempt"),
    ownerRef: ref,
    attempt: WorkspaceAttemptRefSchemaV1,
    target,
  }),
]);
export const ExactHandoffSchemaV1 = object({
  schemaVersion: v1,
  guard: RuntimeGateGuardSchemaV1,
  plan: RuntimeClosedPlanSchemaV1,
  successor: target,
  reservation: WorkspaceReservationRefSchemaV1,
  workspaceStore: StoreBindingRefSchemaV1,
  stores: storeRefs,
  possibleWriters: Type.Array(possibleWriter, { maxItems: 64 }),
});
export type ExactHandoffV1 = Static<typeof ExactHandoffSchemaV1>;
const resolvedWriter = Type.Union([
  object({
    owner: possibleWriter,
    status: Type.Literal("terminated"),
    execution,
    terminationEvidence: provenance,
  }),
  object({
    owner: possibleWriter,
    status: Type.Literal("never-executed"),
    nonExecutionEvidence: provenance,
    resolution: enumOf(["never-submitted", "never-materialized"]),
  }),
]);
const domainClosure = object({
  domain: producerDomain,
  mechanism: enumOf(["protected-start-termination-boundary", "complete-controller-drain"]),
  closureEvidence: provenance,
});
export const PriorWriterResultSchemaV1 = Type.Union([
  object({
    schemaVersion: v1,
    status: Type.Literal("released"),
    input: ExactHandoffSchemaV1,
    canonicalOwnerSnapshot: provenance,
    journalWorkspaceBindingEvidence: provenance,
    writers: Type.Array(resolvedWriter, { maxItems: 64 }),
    producerDomains: Type.Array(domainClosure, { minItems: 1, maxItems: 16 }),
    observedStoreBindings: Type.Array(StoreBindingSchemaV1, { minItems: 1, maxItems: 16 }),
    journalAttempt: Type.Union([
      object({ status: Type.Literal("no-attempt-confirmed"), evidence: provenance }),
      object({
        status: Type.Literal("attempt"),
        attempt: WorkspaceAttemptRefSchemaV1,
        historicalOutcome: enumOf(["completed", "failed", "interrupted", "unknown"]),
      }),
    ]),
    release: Type.Literal("prior-writer-barrier-only"),
  }),
  object({
    schemaVersion: v1,
    status: enumOf(["held", "unknown", "unavailable"]),
    input: ExactHandoffSchemaV1,
    reasonCode: reason,
  }),
]);
export type PriorWriterResultV1 = Static<typeof PriorWriterResultSchemaV1>;
export const ExactStoreBindingSchemaV1 = object({
  schemaVersion: v1,
  store: StoreBindingRefSchemaV1,
  target,
  binding: RuntimeBindingSchemaV1,
});
export type ExactStoreBindingV1 = Static<typeof ExactStoreBindingSchemaV1>;
export const StoreBindingResultSchemaV1 = Type.Union([
  object({
    schemaVersion: v1,
    status: Type.Literal("verified"),
    input: ExactStoreBindingSchemaV1,
    store: StoreBindingSchemaV1,
    mount: object({
      mountIdentityRef: ref,
      filesystemIdentityRef: ref,
      namespaceUid: ref,
      claimUid: ref,
      volumeUid: ref,
      nodeUid: ref,
      effectiveMountPolicyDigest: digest,
      effectiveFilesystem: Type.Literal("ext4"),
      effectiveAccessMode: Type.Literal("ReadWriteOnce"),
      effectiveUid: Type.Literal(1000),
      effectiveGid: Type.Literal(1000),
      effectiveFsGroup: Type.Literal(1000),
      subpaths: Type.Array(
        object({
          category: ref,
          relativePath:
            StoreBindingSchemaV1.anyOf[0].properties.approvedSubpaths.items.properties.relativePath,
          readOnly: Type.Boolean(),
          mountIdentityRef: ref,
        }),
        { minItems: 1, maxItems: 16 },
      ),
    }),
    evidence: provenance,
    guarantee: Type.Literal("exact-mount-binding-only"),
  }),
  object({
    schemaVersion: v1,
    status: enumOf(["mismatch", "unknown", "unavailable"]),
    input: ExactStoreBindingSchemaV1,
    reasonCode: reason,
  }),
]);
export type StoreBindingResultV1 = Static<typeof StoreBindingResultSchemaV1>;

/** Faults target the same canonical OCC writer. They never call the initiating
 * human's authority or create a second cleanup journal. Same-generation loss is explicit. */
const faultOperation = object({
  schemaVersion: v1,
  scope,
  operationRef: uuid,
  operationKind: Type.Literal("fault-and-fence"),
  requestDigest: digest,
});
export const ExactRuntimeFaultSchemaV1 = object({
  schemaVersion: v1,
  operation: faultOperation,
  target,
  guard: RuntimeGateGuardSchemaV1,
  cleanupResponsibility: responsibility,
  reasonCode: reason,
  cause: Type.Union([
    object({ kind: Type.Literal("runtime-evidence"), evidence: RuntimeEvidenceSchemaV1 }),
    object({
      kind: Type.Literal("authority-loss"),
      source: enumOf(["service", "profile", "responsibility", "authoritative-lease"]),
      authorityRef: ref,
      previousVersion: counter,
      currentVersion: counter,
      currentnessEvidence: provenance,
      recoveryResponsibilityRef: uuid,
    }),
  ]),
});
export type ExactRuntimeFaultV1 = Static<typeof ExactRuntimeFaultSchemaV1>;
export type ExactRuntimeFaultOperationV1 = Static<typeof faultOperation>;
const cleanupAccepted = object({
  schemaVersion: v1,
  operation: faultOperation,
  fault: ExactRuntimeFaultSchemaV1,
  denialRecordRef: uuid,
  denialRecordVersion: counter,
  cleanupResponsibility: responsibility,
  fence: RuntimeFenceRequestSchemaV1,
  admission: Type.Literal("durably-closed"),
  downstreamStop: Type.Literal("not-proved"),
  evidence: provenance,
});
export const DurableCleanupRequestStateSchemaV1 = Type.Union([
  object({ status: enumOf(["accepted", "exact-replay"]), receipt: cleanupAccepted }),
  object({
    status: enumOf(["conflict", "unavailable", "commit-unknown", "not-found"]),
    operation: faultOperation,
    reasonCode: reason,
  }),
]);
export type DurableCleanupRequestStateV1 = Static<typeof DurableCleanupRequestStateSchemaV1>;
export type DurableCleanupRequestResultV1 = DurableCleanupRequestStateV1;

/** The caller supplies no raw Kubernetes client. The canonical admission writer
 * resolves exact current responsibility, scope, service/profile and retained bytes.
 * No serializable receipt is a grant. Already admitted requests retain identity
 * after loss, crash or unknown COMMIT; recovery must read the original operation.
 */
export const RuntimePreparedChildSchemaV1 = object({
  schemaVersion: v1,
  effect: ExactEffectLocatorSchemaV1,
  guard: RuntimeGateGuardSchemaV1,
  providerTarget: RuntimeProviderTargetSchemaV1,
  predicate,
  request: RuntimeEffectRequestSchemaV1,
  canonicalRequestJson: Type.String({ minLength: 2, maxLength: 65_536 }),
  requestBytesDigest: digest,
  providerWire: object({
    requestRef: ref,
    bytesDigest: digest,
    byteLength: Type.Integer({ minimum: 1, maximum: 65_536 }),
    rendererProfileRef: ref,
    rendererProfileDigest: digest,
  }),
});
export type RuntimePreparedChildV1 = Static<typeof RuntimePreparedChildSchemaV1>;
export const RuntimeGateStateSchemaV1 = Type.Union([
  object({
    status: Type.Literal("observed"),
    guard: RuntimeGateGuardSchemaV1,
    ordinaryAdmission: enumOf(["open", "closed"]),
    sealerAdmission: enumOf(["open", "closed"]),
    plan: RuntimeClosedPlanSchemaV1,
    children: Type.Array(RuntimePreparedChildSchemaV1, { maxItems: 256 }),
    authority: enumOf(["current", "lost", "unknown"]),
    evidence: provenance,
  }),
  unavailable,
]);
export type RuntimeGateStateV1 = Static<typeof RuntimeGateStateSchemaV1>;
export const RuntimeChildAdmissionResultSchemaV1 = Type.Union([
  object({
    status: enumOf(["admitted", "exact-replay"]),
    child: RuntimePreparedChildSchemaV1,
    evidence: provenance,
  }),
  object({
    status: enumOf(["conflict", "unavailable", "commit-unknown"]),
    effect: ExactEffectLocatorSchemaV1,
  }),
]);
export type RuntimeChildAdmissionResultV1 = Static<typeof RuntimeChildAdmissionResultSchemaV1>;

export interface RuntimeReadCallV1 extends AuthorityCallV1 {}
export interface RuntimeEffectCallV1 extends AuthorityCallV1 {}
/** Implementations MUST enforce the complete admission/fence protocol documented
 * in runtime-effects.md. Provider RPC <= min(remaining deadline,10s), required
 * current authority <=3s; Abort before possible admission/submission issues no
 * mutation, after possible submission remains unknown. Never blind-retry creates.
 * Retained stop preserves stores and permanent execution-root reservations.
 * No method confers purge, successor adoption, serving or model/repository authority.
 */
export interface RuntimeEffectsV1 {
  create(input: RuntimeCreateV1, call: RuntimeEffectCallV1): Promise<RuntimeEffectResultV1>;
  discover(input: ExactCreateEffectV1, call: RuntimeReadCallV1): Promise<DiscoveryResultV1>;
  observe(
    input: RuntimeObservationInputV1,
    call: RuntimeReadCallV1,
  ): Promise<RuntimeObservationResultV1>;
  setRoute(input: ConditionalRouteV1, call: RuntimeEffectCallV1): Promise<RuntimeEffectResultV1>;
  stopRetainingState(
    input: ExactCleanupV1,
    call: RuntimeEffectCallV1,
  ): Promise<RuntimeEffectResultV1>;
  readEffect(input: ExactEffectLocatorV1, call: RuntimeReadCallV1): Promise<RuntimeEffectStateV1>;
  advanceFence(
    input: RuntimeFenceRequestV1,
    call: RuntimeEffectCallV1,
  ): Promise<RuntimeFenceStateV1>;
  readFence(input: RuntimeFenceRequestV1, call: RuntimeReadCallV1): Promise<RuntimeFenceStateV1>;
}
export interface WorkspaceHandoffEvidenceV1 {
  observePriorWriters(input: ExactHandoffV1, call: RuntimeReadCallV1): Promise<PriorWriterResultV1>;
  verifyStoreBinding(
    input: ExactStoreBindingV1,
    call: RuntimeReadCallV1,
  ): Promise<StoreBindingResultV1>;
}
export interface RuntimeFaultSinkV1 {
  recordFaultAndRequestStop(
    input: ExactRuntimeFaultV1,
    call: AuthorityCallV1,
  ): Promise<DurableCleanupRequestResultV1>;
  readRequest(
    input: ExactRuntimeFaultOperationV1,
    call: AuthorityCallV1,
  ): Promise<DurableCleanupRequestStateV1>;
}
/** Sole canonical OCC preparation/effect gate, not a new persistence implementation.
 * admitChild, plan change, completion and supersession compare the SAME exact gate.
 * completeFence atomically closes old sealer admission before matching successor
 * admission. A closed/superseded sealer can only read retained bytes, never rebase.
 * recordFaultAndRequestStop supplies independent currentness/recovery on restart
 * and service/profile/responsibility/authoritative-lease loss in the SAME generation.
 */
export interface RuntimeEffectAdmissionV1 extends RuntimeFaultSinkV1 {
  readGate(input: RuntimeGateGuardV1, call: AuthorityCallV1): Promise<RuntimeGateStateV1>;
  admitChild(
    input: RuntimePreparedChildV1,
    call: AuthorityCallV1,
  ): Promise<RuntimeChildAdmissionResultV1>;
  completeFence(
    input: RuntimeFenceCompletionProposalV1,
    call: AuthorityCallV1,
  ): Promise<RuntimeFenceStateV1>;
}

export const RuntimeEffectsSchemasV1 = Object.freeze({
  effectLocator: ExactEffectLocatorSchemaV1,
  providerTarget: RuntimeProviderTargetSchemaV1,
  closedPlan: RuntimeClosedPlanSchemaV1,
  gateGuard: RuntimeGateGuardSchemaV1,
  provenance,
  create: RuntimeCreateSchemaV1,
  setRoute: ConditionalRouteSchemaV1,
  stopRetainingState: ExactCleanupSchemaV1,
  sealTarget: RuntimeSealSchemaV1,
  effectRequest: RuntimeEffectRequestSchemaV1,
  effectResult: RuntimeEffectResultSchemaV1,
  effectState: RuntimeEffectStateSchemaV1,
  exactCreate: ExactCreateEffectSchemaV1,
  discoveryResult: DiscoveryResultSchemaV1,
  observationInput: RuntimeObservationInputSchemaV1,
  observationResult: RuntimeObservationResultSchemaV1,
  fenceRequest: RuntimeFenceRequestSchemaV1,
  fenceState: RuntimeFenceStateSchemaV1,
  fenceCompletion: RuntimeFenceCompletionProposalSchemaV1,
  exactHandoff: ExactHandoffSchemaV1,
  priorWriterResult: PriorWriterResultSchemaV1,
  exactStore: ExactStoreBindingSchemaV1,
  storeResult: StoreBindingResultSchemaV1,
  storeBinding: StoreBindingSchemaV1,
  storeBindingRef: StoreBindingRefSchemaV1,
  reservation: WorkspaceReservationRefSchemaV1,
  attempt: WorkspaceAttemptRefSchemaV1,
  fault: ExactRuntimeFaultSchemaV1,
  faultOperation,
  faultState: DurableCleanupRequestStateSchemaV1,
  preparedChild: RuntimePreparedChildSchemaV1,
  childAdmissionResult: RuntimeChildAdmissionResultSchemaV1,
  gateState: RuntimeGateStateSchemaV1,
  priorWriterEvidenceRef: PriorWriterEvidenceRefSchemaV1,
});
export type RuntimeEffectsSchemaNameV1 = keyof typeof RuntimeEffectsSchemasV1;
export type RuntimeEffectsValueV1<K extends RuntimeEffectsSchemaNameV1> = Static<
  (typeof RuntimeEffectsSchemasV1)[K]
>;

function invalid(): never {
  throw new Error("Invalid runtime effects V1 value.");
}
function snapshot(
  input: unknown,
  depth = 0,
  budget = { left: RUNTIME_EFFECT_LIMITS_V1.maxJsonBytes },
): unknown {
  if (depth > 32 || --budget.left < 0) invalid();
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input) || input < 0 || Object.is(input, -0)) invalid();
    return input;
  }
  if (typeof input === "string") {
    if (/[\ud800-\udfff]/u.test(input)) invalid();
    budget.left -= new TextEncoder().encode(input).byteLength;
    if (budget.left < 0) invalid();
    return input;
  }
  if (typeof input !== "object") invalid();
  if (Array.isArray(input)) {
    if (
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > 1024 ||
      Reflect.ownKeys(input).length !== input.length + 1
    )
      invalid();
    return Array.from({ length: input.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(input, String(i));
      if (!d || !("value" in d) || !d.enumerable) invalid();
      return snapshot(d.value, depth + 1, budget);
    });
  }
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    invalid();
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key))
      invalid();
    snapshot(key, depth + 1, budget);
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d || !("value" in d) || !d.enumerable) invalid();
    output[key] = snapshot(d.value, depth + 1, budget);
  }
  return output;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function canonical(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
  return `{${Object.entries(input)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
    .join(",")}}`;
}
function equal(a: unknown, b: unknown): void {
  if (canonical(a) !== canonical(b)) invalid();
}
function unique<T>(values: readonly T[], key: (value: T) => unknown = (value) => value): void {
  if (new Set(values.map((v) => canonical(key(v)))).size !== values.length) invalid();
}
function sameSet<T>(
  actual: readonly T[],
  expected: readonly T[],
  key: (value: T) => unknown = (value) => value,
): void {
  unique(actual, key);
  unique(expected, key);
  equal(actual.map((v) => canonical(key(v))).sort(), expected.map((v) => canonical(key(v))).sort());
}
function scopeOf(t: RuntimeAssignmentTargetV1): RuntimeAuthorityScopeV1 {
  return { installationId: t.installationId, namespaceId: t.namespaceId, agentId: t.agentId };
}
function exactProvider(t: RuntimeProviderTargetV1, a: RuntimeAssignmentTargetV1): void {
  equal(t.ownerAssignmentRef, a.assignmentRef);
  equal(t.ownerCreateEffectRef, a.createEffectRef);
}
function guardPlan(guard: RuntimeGateGuardV1, plan: RuntimeClosedPlanV1): void {
  equal(guard.scope, plan.scope);
  equal(
    [guard.planRef, guard.planVersion, guard.planDigest],
    [plan.planRef, plan.planVersion, plan.planDigest],
  );
}
function checkWriterRefScope(
  value: Static<typeof PriorWriterEvidenceRefSchemaV1>,
  expectedScope: RuntimeAuthorityScopeV1,
): void {
  equal(value.reservation.scope, expectedScope);
  equal(value.workspaceStore.scope, expectedScope);
  unique(value.stores, (store) => store.bindingRef);
  if (!value.stores.some((store) => canonical(store) === canonical(value.workspaceStore)))
    invalid();
  for (const store of value.stores) equal(store.scope, expectedScope);
}
function checkWriterRef(
  value: Static<typeof PriorWriterEvidenceRefSchemaV1>,
  input: RuntimeEffectRequestV1,
): void {
  checkWriterRefScope(value, input.gate.scope);
  equal(value.closedPlanDigest, input.gate.planDigest);
  equal(value.admittedChildCutoff, input.gate.admittedChildCutoff);
}
function checkEffectInput(input: RuntimeEffectRequestV1): void {
  guardPlan(input.gate, input.plan);
  equal(input.gate.scope, scopeOf(input.effect.target));
  equal(input.effect.responsibility, input.gate.responsibility);
  exactProvider(input.providerTarget, input.effect.target);
  const planned = input.plan.targets.find(
    (entry) => entry.target.targetRef === input.providerTarget.targetRef,
  );
  if (!planned) invalid();
  equal(planned.target, input.providerTarget);
  if (!planned.allowedMutations.includes(input.effect.effectKind)) invalid();
  if (input.predicate.kind === "expected-object") {
    equal(input.predicate.ownerAssignmentRef, input.providerTarget.ownerAssignmentRef);
    equal(input.predicate.ownerCreateEffectRef, input.providerTarget.ownerCreateEffectRef);
    if (input.predicate.fenceEpoch > input.gate.requestedFenceEpoch) invalid();
  }
  if (input.kind === "create") {
    equal(input.action, input.effect.effectKind);
    if (
      input.action === "reserve-inert" &&
      (input.providerTarget.apiKind !== "Deployment" ||
        input.predicate.kind !== "expected-absent" ||
        input.preparation.kind !== "nonmutating")
    )
      invalid();
    if (
      input.action === "materialize" &&
      (input.providerTarget.apiKind !== "Deployment" || input.predicate.kind !== "expected-object")
    )
      invalid();
    if (input.effect.responsibility.kind === "preparation") {
      if (
        input.gate.mode !== "running" ||
        input.effect.target.lifecycleGeneration !== input.gate.lifecycleGeneration
      )
        invalid();
    } else if (
      input.action !== "reserve-inert" ||
      input.effect.target.lifecycleGeneration > input.gate.lifecycleGeneration
    ) {
      invalid();
    }
    if (input.preparation.kind === "writable")
      checkWriterRef(input.preparation.priorWriterEvidence, input);
    equal(
      input.admittedRuntime.provider,
      input.effect.target.component === "harness"
        ? "occ/kubernetes-gvisor"
        : "occ/kubernetes-gateway",
    );
  }
  if (input.kind === "set-route") {
    if (
      !["Service", "HTTPRoute", "EndpointSlice"].includes(input.providerTarget.apiKind) ||
      input.predicate.kind !== "expected-object"
    )
      invalid();
    equal(
      input.effect.effectKind,
      input.desiredRoute.kind === "active" ? "route-active" : "route-inactive",
    );
    if (input.desiredRoute.kind === "active") {
      if (input.gate.mode !== "running" || input.effect.responsibility.kind !== "preparation")
        invalid();
      equal(input.desiredRoute.selectedTarget, input.effect.target);
      checkWriterRef(input.desiredRoute.priorWriterEvidence, input);
      equal(input.desiredRoute.binding.component, input.effect.target.component);
      if (input.effect.target.lifecycleGeneration !== input.gate.lifecycleGeneration) invalid();
    }
  }
  if (input.kind === "seal-target") {
    if (
      input.effect.responsibility.kind === "preparation" ||
      input.predicate.kind !== "expected-object" ||
      input.effect.effectKind !== "seal" ||
      input.effect.target.lifecycleGeneration > input.gate.lifecycleGeneration
    )
      invalid();
    if (
      (input.providerTarget.apiKind === "Deployment") !==
      (input.safeState.kind === "replicas-zero")
    )
      invalid();
  }
  if (input.kind === "stop-retaining-state") {
    equal(input.effect.effectKind, input.action);
    if (
      input.effect.responsibility.kind === "preparation" ||
      input.predicate.kind !== "expected-object"
    )
      invalid();
    equal(input.binding.clusterRef, input.providerTarget.clusterRef);
    equal(input.binding.kubernetesNamespaceUid, input.providerTarget.kubernetesNamespaceUid);
    // Routing object UIDs identify the route, not the execution's Deployment.
    if (input.providerTarget.apiKind === "Deployment")
      equal(input.binding.deploymentUid, input.predicate.uid);
    // Permanent execution-root reservations must survive arbitrarily delayed initial POSTs.
    if (input.action === "remove-exact" && input.providerTarget.apiKind === "Deployment") invalid();
    for (const store of input.retainedStores) equal(store.scope, scopeOf(input.effect.target));
  }
}
function checkFenceRequest(request: RuntimeFenceRequestV1): void {
  guardPlan(request.guard, request.plan);
  if (request.guard.responsibility.kind === "preparation") invalid();
  unique(request.children, (child) => child.effectRef);
  for (const child of request.children) {
    equal(scopeOf(child.target), request.guard.scope);
    if (child.target.lifecycleGeneration > request.guard.lifecycleGeneration) invalid();
    if (
      !request.plan.targets.some(
        (entry) =>
          canonical(entry.target.ownerAssignmentRef) === canonical(child.target.assignmentRef) &&
          entry.target.ownerCreateEffectRef === child.target.createEffectRef,
      )
    )
      invalid();
  }
}
function checkFence(value: RuntimeFenceStateV1 | RuntimeFenceCompletionProposalV1): void {
  checkFenceRequest(value.request);
  const completing = "kind" in value || value.status === "established";
  if ("status" in value && value.status !== "pending" && value.status !== "established") return;
  unique(value.targets, (entry) => entry.target.targetRef);
  unique(value.children, (entry) => entry.effect.effectRef);
  for (const covered of value.targets) {
    const expected = value.request.plan.targets.find(
      (entry) => entry.target.targetRef === covered.target.targetRef,
    );
    if (!expected) invalid();
    equal(covered.target, expected.target);
    if (covered.status === "sealed") {
      equal(covered.object.target, covered.target);
      if (covered.object.fenceEpoch < value.request.guard.requestedFenceEpoch) invalid();
    }
  }
  for (const covered of value.children) {
    const expected = value.request.children.find(
      (entry) => entry.effectRef === covered.effect.effectRef,
    );
    if (!expected) invalid();
    equal(covered.effect, expected);
    if (covered.status === "sealed") {
      exactProvider(covered.seal.target, covered.effect.target);
      if (covered.seal.fenceEpoch < value.request.guard.requestedFenceEpoch) invalid();
      if (covered.retainedPredicate.kind === "expected-object") {
        equal(covered.retainedPredicate.uid, covered.seal.uid);
        if (covered.retainedPredicate.resourceVersion === covered.seal.resourceVersion) invalid();
      } else if (covered.seal.target.apiKind !== "Deployment") invalid();
    }
  }
  if (completing) {
    if ("completion" in value) {
      equal(value.completion.comparedGuard, value.request.guard);
      if (value.completion.committedGateVersion <= value.request.guard.gateVersion) invalid();
    }
    sameSet(
      value.targets.map((entry) => entry.target),
      value.request.plan.targets.map((entry) => entry.target),
    );
    sameSet(
      value.children.map((entry) => entry.effect),
      value.request.children,
    );
    if (
      value.targets.some((entry) => entry.status === "unknown") ||
      value.children.some((entry) => entry.status === "unknown")
    )
      invalid();
  }
}
function checkHandoff(input: ExactHandoffV1): void {
  guardPlan(input.guard, input.plan);
  equal(input.guard.scope, scopeOf(input.successor));
  equal(input.reservation.scope, input.guard.scope);
  equal(input.workspaceStore.scope, input.guard.scope);
  unique(input.stores, (store) => store.bindingRef);
  unique(input.possibleWriters, (owner) => owner.ownerRef);
  if (!input.stores.some((store) => canonical(store) === canonical(input.workspaceStore)))
    invalid();
  for (const store of input.stores) equal(store.scope, input.guard.scope);
  for (const owner of input.possibleWriters) {
    const t =
      owner.kind === "execution"
        ? owner.execution.target
        : owner.kind === "create"
          ? owner.effect.target
          : owner.target;
    equal(scopeOf(t), input.guard.scope);
    if (
      !input.plan.targets.some(
        (entry) =>
          canonical(entry.target.ownerAssignmentRef) === canonical(t.assignmentRef) &&
          entry.target.ownerCreateEffectRef === t.createEffectRef,
      )
    )
      invalid();
    if (owner.kind === "attempt") equal(owner.attempt.reservation, input.reservation);
  }
}
/** Only intrinsic consistency. Producers/current accepting boundaries still establish
 * actual authenticity, complete canonical coverage, clocks and current authority. */
function intrinsic(input: unknown): void {
  if (!input || typeof input !== "object") return;
  if (Array.isArray(input)) {
    for (const child of input) intrinsic(child);
    return;
  }
  // The snapshot and schema have already established plain own-data records.
  const r = input as Record<string, unknown>;
  for (const [key, value] of Object.entries(r)) {
    if (typeof value === "string" && /(?:At|Until)$/.test(key)) {
      const ms = Date.parse(value);
      if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) invalid();
    }
    intrinsic(value);
  }
  if ("sourceObservedAt" in r && "receivedAt" in r && "validUntil" in r) {
    const c = r as RuntimeEffectClockV1;
    const source = Date.parse(c.sourceObservedAt),
      received = Date.parse(c.receivedAt),
      until = Date.parse(c.validUntil);
    if (source > received + c.uncertaintyMs || until < source || until > source + 15_000) invalid();
  }
  if ("bindingVersion" in r && "provider" in r) parseRuntimeAuthorityV1("binding", r);
  if ((r.kind === "runtime" || r.kind === "identity") && "evidenceVersion" in r)
    parseRuntimeAuthorityV1("evidence", r);
  if (r.target && r.binding && "component" in (r.target as object)) {
    equal(
      (r.target as RuntimeAssignmentTargetV1).component,
      (r.binding as RuntimeBindingV1).component,
    );
  }
  if (r.kind === "kubernetes-volume") {
    const s = r as Extract<Static<typeof StoreBindingSchemaV1>, { kind: "kubernetes-volume" }>;
    if (!storeBindingPolicyConsistentV1(s)) invalid();
  }
  if ("targets" in r && "producerDomains" in r && "planDigest" in r) {
    const p = r as RuntimeClosedPlanV1;
    unique(p.targets, (entry) => entry.target.targetRef);
    unique(p.targets, (entry) => [
      entry.target.clusterRef,
      entry.target.kubernetesNamespaceUid,
      entry.target.apiKind,
      entry.target.name,
    ]);
    unique(p.producerDomains, (entry) => entry.domainRef);
    for (const entry of p.targets) unique(entry.allowedMutations);
    for (const domain of p.producerDomains) {
      unique(domain.targetRefs);
      if (domain.targetRefs.some((t) => !p.targets.some((entry) => entry.target.targetRef === t)))
        invalid();
    }
    for (const entry of p.targets.filter((e) => e.target.apiKind === "Deployment")) {
      for (const kind of ["deployment-descendants", "node-start-restart"] as const)
        if (
          !p.producerDomains.some(
            (d) => d.kind === kind && d.targetRefs.includes(entry.target.targetRef),
          )
        )
          invalid();
    }
  }
  if (
    ["create", "set-route", "stop-retaining-state", "seal-target"].includes(String(r.kind)) &&
    "providerTarget" in r
  )
    checkEffectInput(r as RuntimeEffectRequestV1);
  if ("fenceRef" in r && "guard" in r && "children" in r)
    checkFenceRequest(r as RuntimeFenceRequestV1);
  if (
    "request" in r &&
    "guard" in (r.request as object) &&
    ("status" in r || r.kind === "complete-fence")
  )
    checkFence(r as RuntimeFenceStateV1 | RuntimeFenceCompletionProposalV1);
  if ("possibleWriters" in r && "successor" in r) checkHandoff(r as ExactHandoffV1);
  if (r.status === "released" && "writers" in r) {
    const result = r as Extract<PriorWriterResultV1, { status: "released" }>;
    sameSet(
      result.writers.map((entry) => entry.owner),
      result.input.possibleWriters,
    );
    sameSet(
      result.producerDomains.map((entry) => entry.domain),
      result.input.plan.producerDomains,
    );
    sameSet(
      result.observedStoreBindings.map((entry) => entry.ref),
      result.input.stores,
    );
    const workspace = result.observedStoreBindings.find(
      (s) => canonical(s.ref) === canonical(result.input.workspaceStore),
    );
    if (workspace?.kind !== "kubernetes-volume" || workspace.role !== "workspace") invalid();
    for (const writer of result.writers) {
      if (writer.status === "never-executed" && writer.owner.kind === "execution") invalid();
      if (writer.status === "terminated") {
        const expected =
          writer.owner.kind === "execution"
            ? writer.owner.execution.target
            : writer.owner.kind === "create"
              ? writer.owner.effect.target
              : writer.owner.target;
        equal(writer.execution.target, expected);
        if (writer.owner.kind === "execution") equal(writer.execution, writer.owner.execution);
      }
    }
    for (const closure of result.producerDomains) {
      equal(closure.closureEvidence.producerRef, closure.domain.requiredProducerRef);
      equal(closure.closureEvidence.acceptedPortRef, closure.domain.requiredCapabilityRef);
    }
    if (result.journalAttempt.status === "attempt") {
      equal(result.journalAttempt.attempt.reservation, result.input.reservation);
      for (const owner of result.input.possibleWriters)
        if (owner.kind === "attempt") equal(owner.attempt, result.journalAttempt.attempt);
    } else if (result.input.possibleWriters.some((owner) => owner.kind === "attempt")) invalid();
  }
  if (r.status === "verified" && "mount" in r) {
    const result = r as Extract<StoreBindingResultV1, { status: "verified" }>;
    if (result.store.kind !== "kubernetes-volume") invalid();
    equal(result.store.ref, result.input.store);
    equal(result.input.store.scope, scopeOf(result.input.target));
    equal(
      [
        result.mount.namespaceUid,
        result.mount.claimUid,
        result.mount.volumeUid,
        result.mount.nodeUid,
        result.mount.effectiveMountPolicyDigest,
      ],
      [
        result.store.namespaceUid,
        result.store.claimUid,
        result.store.volumeUid,
        result.store.nodeIdentity.nodeUid,
        result.store.mountPolicyDigest,
      ],
    );
    equal(result.input.binding.kubernetesNamespaceUid, result.store.namespaceUid);
    equal(result.input.binding.clusterRef, result.store.clusterRef);
    const admitted = result.store.approvedSubpaths.filter(
      (entry) => entry.component === result.input.target.component,
    );
    sameSet(
      result.mount.subpaths.map(({ mountIdentityRef: _ref, ...entry }) => entry),
      admitted.map(({ component: _component, ...entry }) => entry),
    );
    unique(result.mount.subpaths, (entry) => entry.mountIdentityRef);
  }
  if ("expectedObject" in r && "effect" in r && "providerTarget" in r) {
    const exact = r as ExactCreateEffectV1;
    if (
      !["reserve-inert", "materialize"].includes(exact.effect.effectKind) ||
      exact.providerTarget.apiKind !== "Deployment"
    )
      invalid();
    exactProvider(exact.providerTarget, exact.effect.target);
    if (exact.expectedObject) equal(exact.expectedObject.target, exact.providerTarget);
  }
  if (r.status === "exact" && "correlationEvidence" in r) {
    const result = r as Extract<DiscoveryResultV1, { status: "exact" }>;
    equal(result.object.target, result.input.providerTarget);
    exactProvider(result.object.target, result.input.effect.target);
    if (result.input.expectedObject) equal(result.object.uid, result.input.expectedObject.uid);
  }
  if (r.status === "complete" && "eligibility" in r) {
    const result = r as Extract<RuntimeObservationResultV1, { status: "complete" }>;
    exactProvider(result.object.target, result.input.target);
    equal(result.binding.component, result.input.target.component);
    equal(result.binding.clusterRef, result.object.target.clusterRef);
    equal(result.binding.kubernetesNamespaceUid, result.object.target.kubernetesNamespaceUid);
    equal(result.binding.deploymentUid, result.object.uid);
    if (result.object.target.apiKind !== "Deployment") invalid();
    if (result.input.kind === "bound-instance") equal(result.binding, result.input.binding);
    else {
      equal(result.input.createEffect.providerTarget, result.object.target);
      if (result.input.createEffect.expectedObject)
        equal(result.input.createEffect.expectedObject.uid, result.object.uid);
    }
    if (
      result.input.expectedEvidenceVersion !== null &&
      result.observation.evidenceVersion <= result.input.expectedEvidenceVersion
    )
      invalid();
    if (result.identityEvidence) {
      if (result.identityEvidence.kind !== "identity") invalid();
      equal(result.identityEvidence.target, result.input.target);
    }
  }
  if (r.kind === "preallocated-candidate") {
    const value = r as Extract<RuntimeObservationInputV1, { kind: "preallocated-candidate" }>;
    equal(value.target, value.createEffect.effect.target);
    equal(value.responsibility, value.createEffect.effect.responsibility);
    if (value.responsibility.kind !== "preparation") invalid();
    exactProvider(value.createEffect.providerTarget, value.target);
    if (value.preparation.kind === "writable")
      checkWriterRefScope(value.preparation.priorWriterEvidence, scopeOf(value.target));
  }
  if ("canonicalRequestJson" in r) {
    const child = r as RuntimePreparedChildV1;
    const parsed = snapshot(parseJson(child.canonicalRequestJson));
    if (new TextEncoder().encode(child.canonicalRequestJson).byteLength > 65_536) invalid();
    equal(child.canonicalRequestJson, canonical(parsed));
    equal(child.requestBytesDigest, `sha256:${sha256Hex(child.canonicalRequestJson)}`);
    equal(child.canonicalRequestJson, canonicalRuntimeEffectRequestV1(child.request));
    equal(child.effect, child.request.effect);
    equal(child.effect.requestDigest, child.requestBytesDigest);
    equal(child.guard, child.request.gate);
    equal(child.providerTarget, child.request.providerTarget);
    equal(child.predicate, child.request.predicate);
    equal(scopeOf(child.effect.target), child.guard.scope);
    equal(child.effect.responsibility, child.guard.responsibility);
    exactProvider(child.providerTarget, child.effect.target);
  }
  if (r.status === "observed" && "ordinaryAdmission" in r) {
    const state = r as Extract<RuntimeGateStateV1, { status: "observed" }>;
    guardPlan(state.guard, state.plan);
    unique(state.children, (child) => child.effect.effectRef);
    if (state.authority !== "current" && state.ordinaryAdmission !== "closed") invalid();
    if (state.guard.mode !== "running" && state.ordinaryAdmission !== "closed") invalid();
  }
  if ("denialRecordRef" in r && "fence" in r) {
    const receipt = r as Static<typeof cleanupAccepted>;
    equal(receipt.operation.scope, receipt.fence.guard.scope);
    equal(receipt.operation, receipt.fault.operation);
    equal(receipt.cleanupResponsibility, receipt.fault.cleanupResponsibility);
    if (receipt.cleanupResponsibility.kind === "preparation") invalid();
  }
  if ("cause" in r && "cleanupResponsibility" in r) {
    const fault = r as ExactRuntimeFaultV1;
    equal(fault.operation.scope, scopeOf(fault.target));
    equal(fault.operation.scope, fault.guard.scope);
    if (fault.cleanupResponsibility.kind === "preparation") invalid();
    if (fault.cause.kind === "runtime-evidence") equal(fault.cause.evidence.target, fault.target);
    else if (fault.cause.currentVersion <= fault.cause.previousVersion) invalid();
  }
}
function parseJson(input: string): unknown {
  if (
    typeof input !== "string" ||
    input.length > 262_144 ||
    new TextEncoder().encode(input).byteLength > 262_144
  )
    invalid();
  let at = 0;
  const ws = () => {
    while (/[\x20\x09\x0a\x0d]/.test(input[at] ?? "!")) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < input.length) {
      const c = input[at++];
      if (c === "\\") {
        at++;
        continue;
      }
      if (c === '"') return JSON.parse(input.slice(start, at));
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    if (depth > 32) invalid();
    ws();
    if (input[at] === '"') return string();
    if (input[at] === "{") {
      at++;
      ws();
      const out: Record<string, unknown> = Object.create(null);
      if (input[at] === "}") {
        at++;
        return out;
      }
      for (;;) {
        ws();
        if (input[at] !== '"') invalid();
        const key = string();
        if (Object.hasOwn(out, key)) invalid();
        ws();
        if (input[at++] !== ":") invalid();
        out[key] = value(depth + 1);
        ws();
        const next = input[at++];
        if (next === "}") return out;
        if (next !== ",") invalid();
      }
    }
    if (input[at] === "[") {
      at++;
      ws();
      const out: unknown[] = [];
      if (input[at] === "]") {
        at++;
        return out;
      }
      for (;;) {
        if (out.length >= 1024) invalid();
        out.push(value(depth + 1));
        ws();
        const next = input[at++];
        if (next === "]") return out;
        if (next !== ",") invalid();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      input.slice(at),
    );
    if (!token) invalid();
    at += token[0].length;
    const out: unknown = JSON.parse(token[0]);
    if (
      typeof out === "number" &&
      (!/^(?:0|[1-9][0-9]*)$/.test(token[0]) || !Number.isSafeInteger(out))
    )
      invalid();
    return out;
  };
  const out = value(0);
  ws();
  if (at !== input.length) invalid();
  return out;
}
export function parseRuntimeEffectsV1<K extends RuntimeEffectsSchemaNameV1>(
  kind: K,
  input: unknown,
): RuntimeEffectsValueV1<K> {
  try {
    if (!Object.hasOwn(RuntimeEffectsSchemasV1, kind)) invalid();
    const value = snapshot(input);
    if (
      new TextEncoder().encode(canonical(value)).byteLength > RUNTIME_EFFECT_LIMITS_V1.maxJsonBytes
    )
      invalid();
    if (!Check(RuntimeEffectsSchemasV1[kind] as TSchema, value)) invalid();
    intrinsic(value);
    return freeze(value) as RuntimeEffectsValueV1<K>;
  } catch {
    return invalid();
  }
}
export function parseRuntimeEffectsJsonV1<K extends RuntimeEffectsSchemaNameV1>(
  kind: K,
  input: string,
): RuntimeEffectsValueV1<K> {
  try {
    return parseRuntimeEffectsV1(kind, parseJson(input));
  } catch {
    return invalid();
  }
}
/** Exact request bytes exclude only their own digest slot. Retries retain every
 * remaining field, including expected gate/UID/resourceVersion and effect identity.
 * The trusted journal hashes these UTF-8 bytes with SHA-256; equality is not authority.
 */
export function canonicalRuntimeEffectRequestV1(input: RuntimeEffectRequestV1): string {
  const parsed = parseRuntimeEffectsV1("effectRequest", input);
  const { requestDigest: _digest, ...effect } = parsed.effect;
  return canonical({ ...parsed, effect });
}
/** Correlate a result with its original retained request. This never retries it. */
export function parseRuntimeEffectExchangeV1(
  request: RuntimeEffectRequestV1,
  input: unknown,
): RuntimeEffectResultV1 {
  const expected = parseRuntimeEffectsV1("effectRequest", request);
  const result = parseRuntimeEffectsV1("effectResult", input);
  equal(result.effect, expected.effect);
  equal(
    expected.effect.requestDigest,
    `sha256:${sha256Hex(canonicalRuntimeEffectRequestV1(expected))}`,
  );
  if (result.status === "applied") {
    equal(result.object.target, expected.providerTarget);
    if (expected.predicate.kind === "expected-object")
      equal(result.object.uid, expected.predicate.uid);
    if (result.object.fenceEpoch < expected.gate.requestedFenceEpoch) invalid();
    if (expected.kind === "set-route") {
      if (!result.route) invalid();
      if (result.route.status === "observed") {
        equal(result.route.route, expected.desiredRoute);
        equal(result.route.controlObject, result.object);
      }
    } else if (result.route) invalid();
    if (expected.kind === "stop-retaining-state") {
      if (!result.termination) invalid();
      equal(result.termination.execution, {
        target: expected.effect.target,
        binding: expected.binding,
      });
    } else if (result.termination) invalid();
  }
  return result;
}
/** Intrinsic C1 completion check against the exact current canonical gate snapshot.
 * Real implementation performs this comparison AND closing sealer admission in one
 * canonical transaction, not by invoking this helper before an unconditional write.
 */
export function parseRuntimeFenceCompletionV1(
  current: RuntimeGateStateV1,
  input: unknown,
): RuntimeFenceCompletionProposalV1 {
  const gate = parseRuntimeEffectsV1("gateState", current);
  const result = parseRuntimeEffectsV1("fenceCompletion", input);
  if (
    gate.status !== "observed" ||
    gate.sealerAdmission !== "open" ||
    gate.ordinaryAdmission !== "closed" ||
    gate.authority !== "current"
  )
    invalid();
  equal(
    result.request.requestDigest,
    `sha256:${sha256Hex(canonicalRuntimeFenceRequestV1(result.request))}`,
  );
  equal(gate.guard, result.request.guard);
  equal(gate.plan, result.request.plan);
  sameSet(
    gate.children.map((child) => child.effect),
    result.request.children,
  );
  for (const covered of result.children) {
    const child = gate.children.find(
      (entry) => entry.effect.effectRef === covered.effect.effectRef,
    );
    if (!child) invalid();
    if (covered.status === "sealed") {
      equal(covered.retainedPredicate, child.predicate);
      equal(covered.seal.target, child.providerTarget);
    }
  }
  return result;
}

/** A current trusted clock and protected monotonic source version are injected by
 * the consumer. Receipt time cannot freshen evidence. Stricter purpose limits win.
 * This checks time/version only, not producer authenticity or accepting authority.
 */
export function runtimeEffectEvidenceFreshV1(
  input: RuntimeEvidenceProvenanceV1,
  now: string,
  previousVersion: number | null,
  maxAgeMs = 15_000,
): boolean {
  try {
    const value = parseRuntimeEffectsV1("provenance", input);
    const t = Date.parse(now);
    if (
      !Number.isFinite(t) ||
      new Date(t).toISOString() !== now ||
      !Number.isSafeInteger(maxAgeMs) ||
      maxAgeMs < 0 ||
      maxAgeMs > 15_000
    )
      return false;
    if (
      previousVersion !== null &&
      (!Number.isSafeInteger(previousVersion) ||
        previousVersion < 1 ||
        value.evidenceVersion <= previousVersion)
    )
      return false;
    const source = Date.parse(value.clock.sourceObservedAt),
      until = Date.parse(value.clock.validUntil);
    return (
      source <= t + value.clock.uncertaintyMs &&
      t - source + value.clock.uncertaintyMs <= maxAgeMs &&
      t + value.clock.uncertaintyMs <= until
    );
  } catch {
    return false;
  }
}

const responseContracts = Object.freeze({
  discover: ["exactCreate", "discoveryResult"],
  observe: ["observationInput", "observationResult"],
  readEffect: ["effectLocator", "effectState"],
  advanceFence: ["fenceRequest", "fenceState"],
  readFence: ["fenceRequest", "fenceState"],
  observePriorWriters: ["exactHandoff", "priorWriterResult"],
  verifyStoreBinding: ["exactStore", "storeResult"],
  recordFaultAndRequestStop: ["fault", "faultState"],
  readRequest: ["faultOperation", "faultState"],
  admitChild: ["preparedChild", "childAdmissionResult"],
} as const);
export type RuntimeEffectsResponseMethodV1 = keyof typeof responseContracts;
/** Method-specific request/readback correlation. Historical lookup after later
 * versions still names the original request; it supplies no new submission grant.
 */
export function parseRuntimeEffectsResponseV1<K extends RuntimeEffectsResponseMethodV1>(
  method: K,
  expected: unknown,
  input: unknown,
): RuntimeEffectsValueV1<(typeof responseContracts)[K][1]> {
  try {
    if (!Object.hasOwn(responseContracts, method)) invalid();
    const [requestSchema, resultSchema] = responseContracts[method];
    const request = parseRuntimeEffectsV1(requestSchema, expected);
    const result = parseRuntimeEffectsV1(resultSchema, input);
    if (method === "readEffect") equal((result as RuntimeEffectStateV1).effect, request);
    else if (method === "advanceFence" || method === "readFence") {
      const fence = request as RuntimeFenceRequestV1;
      equal(fence.requestDigest, `sha256:${sha256Hex(canonicalRuntimeFenceRequestV1(fence))}`);
      equal((result as RuntimeFenceStateV1).request, request);
    } else if (method === "recordFaultAndRequestStop" || method === "readRequest") {
      const state = result as DurableCleanupRequestStateV1;
      if (method === "recordFaultAndRequestStop") {
        const fault = request as ExactRuntimeFaultV1;
        equal(
          fault.operation.requestDigest,
          `sha256:${sha256Hex(canonicalRuntimeFaultRequestV1(fault))}`,
        );
      }
      const operation =
        method === "recordFaultAndRequestStop"
          ? (request as ExactRuntimeFaultV1).operation
          : request;
      if ("receipt" in state) {
        equal(state.receipt.operation, operation);
        if (method === "recordFaultAndRequestStop") equal(state.receipt.fault, request);
      } else equal(state.operation, operation);
    } else if (method === "admitChild") {
      const state = result as RuntimeChildAdmissionResultV1;
      if ("child" in state) equal(state.child, request);
      else equal(state.effect, (request as RuntimePreparedChildV1).effect);
    } else equal((result as { input: unknown }).input, request);
    return result as RuntimeEffectsValueV1<(typeof responseContracts)[K][1]>;
  } catch {
    return invalid();
  }
}

export function canonicalRuntimeFenceRequestV1(input: RuntimeFenceRequestV1): string {
  const { requestDigest: _digest, ...request } = parseRuntimeEffectsV1("fenceRequest", input);
  return canonical(request);
}
export function canonicalRuntimeFaultRequestV1(input: ExactRuntimeFaultV1): string {
  const request = parseRuntimeEffectsV1("fault", input);
  const { requestDigest: _digest, ...operation } = request.operation;
  return canonical({ ...request, operation });
}
