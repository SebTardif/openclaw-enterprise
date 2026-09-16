import { Type, type Static, type TProperties } from "typebox";
import {
  PreparationCheckoutReceiptSchemaV1,
  PreparationCheckoutRequestSchemaV1,
  RepositoryPreparationSubjectSchemaV1,
} from "./repository-preparation-v1.ts";
import type {
  AuthorityCallV1,
  RepositoryPreparationReceiptPortV1,
} from "./repository-preparation-v1.js";
import {
  RUNTIME_EFFECT_LIMITS_V1,
  RuntimeEvidenceProvenanceSchemaV1,
  RuntimeGateGuardSchemaV1,
} from "./runtime-effects-v1.ts";
import { StoreBindingRefSchemaV1 } from "./completed-state-v1.ts";

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
const closed = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const subjectFields = RepositoryPreparationSubjectSchemaV1.properties;
const reference = subjectFields.incarnationRef;
const effect = subjectFields.preparationRef;
const digest = subjectFields.revisionDigest;
const generation = subjectFields.authorizationGeneration;
const time = subjectFields.createdAt;
const schemaVersion = Type.Literal(1);
const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const purpose = Type.Literal("candidate-repository-preparation");
const kubernetesName = Type.String({
  minLength: 1,
  maxLength: 63,
  pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$",
});
const provenance = closed({
  ...RuntimeEvidenceProvenanceSchemaV1.properties,
  clock: closed(RuntimeEvidenceProvenanceSchemaV1.properties.clock.properties),
});
const domainKind = Type.Enum(["job-controller", "node-runtime", "staging-writers"]);

/** Published ceilings; encoded size, elapsed time and authenticated freshness
 * remain checks of the original codec and accepting owners. */
export const PREPARATION_JOB_LIMITS_V1 = Object.freeze({
  maxJsonBytes: RUNTIME_EFFECT_LIMITS_V1.maxJsonBytes,
  maxDepth: RUNTIME_EFFECT_LIMITS_V1.maxDepth,
  maxChildren: 64,
  maxExecutions: 128,
  maxProducerDomains: 16,
  callMaxMs: RUNTIME_EFFECT_LIMITS_V1.providerRequestMaxMs,
  readMaxMs: RUNTIME_EFFECT_LIMITS_V1.authorityReadMaxMs,
  observationMaxAgeMs: RUNTIME_EFFECT_LIMITS_V1.observationMaxAgeMs,
  uncertaintyMaxMs: RUNTIME_EFFECT_LIMITS_V1.uncertaintyMaxMs,
});

/** DATA names a permanently retained inert Job reservation; it grants no admission. */
export const PreparationJobTargetSchemaV1 = closed({
  schemaVersion,
  purpose,
  preparation: RepositoryPreparationSubjectSchemaV1,
  clusterRef: reference,
  kubernetesNamespace: kubernetesName,
  kubernetesNamespaceUid: reference,
  apiVersion: Type.Literal("batch/v1"),
  apiKind: Type.Literal("Job"),
  name: kubernetesName,
  reservationRef: effect,
  retention: Type.Literal("permanent-inert-reservation"),
});
export type PreparationJobTargetV1 = Immutable<Static<typeof PreparationJobTargetSchemaV1>>;

export const PreparationJobPlanSchemaV1 = closed({
  schemaVersion,
  planRef: reference,
  planVersion: generation,
  planDigest: digest,
  target: PreparationJobTargetSchemaV1,
  jobSpecDigest: digest,
  podTemplateDigest: digest,
  profile: closed({
    initialSuspend: Type.Literal(true),
    parallelism: Type.Literal(1),
    completions: Type.Literal(1),
    completionMode: Type.Literal("NonIndexed"),
    backoffLimit: Type.Literal(0),
    restartPolicy: Type.Literal("Never"),
    automaticRootDeletion: Type.Literal(false),
    runtimeHandler: Type.Literal("runsc"),
    platform: Type.Literal("systrap"),
    isolationPolicy: Type.Literal("STRICT"),
    runscExecutableDigest: digest,
    runtimeProfileDigest: digest,
    containmentProfileDigest: digest,
    mountPolicyDigest: digest,
    resourceEnvelopeDigest: digest,
    identityProfileRef: reference,
    identityProfileDigest: digest,
    admittedExecutionNotAfter: time,
  }),
  producerDomains: Type.Array(
    closed({
      domainRef: reference,
      kind: domainKind,
      requiredProducerRef: reference,
      requiredCapabilityRef: reference,
      profileDigest: digest,
    }),
    { minItems: 3, maxItems: 3 },
  ),
  reservationRetention: Type.Literal("permanent"),
});
export type PreparationJobPlanV1 = Immutable<Static<typeof PreparationJobPlanSchemaV1>>;

const operationFields = {
  schemaVersion,
  effectRef: effect,
  requestDigest: digest,
  requestId: PreparationCheckoutRequestSchemaV1.properties.requestId,
  createdAt: time,
  deadline: time,
};
/** Reserve and the preallocated checkout RELEASE have distinct original identities.
 * Unknown outcomes retain both messages; refreshed calls never replay an old effect. */
export const PreparationJobReserveSchemaV1 = closed({
  ...operationFields,
  method: Type.Literal("reserve-job"),
  target: PreparationJobTargetSchemaV1,
  plan: PreparationJobPlanSchemaV1,
  checkout: PreparationCheckoutRequestSchemaV1,
  releaseEffectRef: effect,
  gate: RuntimeGateGuardSchemaV1,
  predicate: closed({
    kind: Type.Literal("expected-absent"),
    retention: Type.Literal("permanent-inert-reservation"),
  }),
});
export type PreparationJobReserveV1 = Immutable<Static<typeof PreparationJobReserveSchemaV1>>;

const jobPredicate = closed({
  kind: Type.Literal("expected-job"),
  jobUid: reference,
  resourceVersion: reference,
  namespaceUid: reference,
  ownerPreparationRef: effect,
  ownerIncarnationRef: reference,
  ownerReserveEffectRef: effect,
  fenceEpoch: generation,
});
export const PreparationJobReleaseSchemaV1 = closed({
  ...operationFields,
  method: Type.Literal("release-job"),
  original: PreparationJobReserveSchemaV1,
  gate: RuntimeGateGuardSchemaV1,
  predicate: jobPredicate,
});
export type PreparationJobReleaseV1 = Immutable<Static<typeof PreparationJobReleaseSchemaV1>>;

const cleanupBinding = closed({
  reserveEffectRef: effect,
  reserveRequestDigest: digest,
  targetPlanRef: reference,
  targetPlanVersion: generation,
  targetPlanDigest: digest,
  responsibility: RuntimeGateGuardSchemaV1.properties.responsibility,
});
const cleanupFields = {
  ...operationFields,
  original: PreparationJobReserveSchemaV1,
  // A later cleanup guard may advance without rewriting the immutable subject.
  gate: RuntimeGateGuardSchemaV1,
  cleanupBinding,
};
export const PreparationJobSealSchemaV1 = closed({
  ...cleanupFields,
  method: Type.Literal("seal-job"),
  predicate: jobPredicate,
  closeAdmittedChildCutoff: sequence,
});
export type PreparationJobSealV1 = Immutable<Static<typeof PreparationJobSealSchemaV1>>;

const pod = closed({
  namespaceUid: reference,
  jobUid: reference,
  controllerKind: Type.Literal("Job"),
  controllerUid: reference,
  podUid: reference,
  resourceVersion: reference,
});
const execution = closed({
  executionRef: reference,
  executionGeneration: generation,
  podUid: reference,
  nodeUid: reference,
  sandboxId: reference,
  containerName: reference,
  containerKind: Type.Enum(["init", "main"]),
  runtimeHandler: Type.Literal("runsc"),
  platform: Type.Literal("systrap"),
  isolationPolicy: Type.Literal("STRICT"),
  runscExecutableDigest: digest,
  runtimeProfileDigest: digest,
  identityProfileRef: reference,
  identityProfileDigest: digest,
});
/** Pod labels, serialized service identities and PIDs cannot authenticate this lineage. */
export const PreparationJobIdentitySchemaV1 = closed({
  schemaVersion,
  purpose,
  target: PreparationJobTargetSchemaV1,
  reserveEffectRef: effect,
  reserveRequestDigest: digest,
  releaseEffectRef: effect,
  authorizationGeneration: generation,
  lifecycleGeneration: generation,
  fenceEpoch: generation,
  pod,
  execution,
  controlPlane: provenance,
  runtime: provenance,
});
export type PreparationJobIdentityV1 = Immutable<Static<typeof PreparationJobIdentitySchemaV1>>;

export const PreparationJobTerminateSchemaV1 = closed({
  ...cleanupFields,
  method: Type.Literal("terminate-exact"),
  predicate: jobPredicate,
  terminationTarget: Type.Union([
    closed({ kind: Type.Literal("pod"), pod }),
    closed({ kind: Type.Literal("runtime-execution"), pod, execution }),
  ]),
});
export type PreparationJobTerminateV1 = Immutable<Static<typeof PreparationJobTerminateSchemaV1>>;
export const PreparationJobMutationSchemaV1 = Type.Union([
  PreparationJobReserveSchemaV1,
  PreparationJobReleaseSchemaV1,
  PreparationJobSealSchemaV1,
  PreparationJobTerminateSchemaV1,
]);
export type PreparationJobMutationV1 = Immutable<Static<typeof PreparationJobMutationSchemaV1>>;

const readFields = {
  schemaVersion,
  original: PreparationJobMutationSchemaV1,
  gate: RuntimeGateGuardSchemaV1,
  requestId: PreparationCheckoutRequestSchemaV1.properties.requestId,
  createdAt: time,
  deadline: time,
};
const admittedMember = closed({
  attemptRef: reference,
  effectRef: effect,
  requestDigest: digest,
  domainRef: reference,
  admittedSequence: sequence,
});
/** Exact retained membership comes from the existing canonical admission owner.
 * Cardinality and digest shape cannot prove authentic completeness or currentness. */
export const PreparationJobAdmissionSnapshotSchemaV1 = closed({
  schemaVersion,
  snapshotRef: reference,
  snapshotVersion: generation,
  original: PreparationJobReserveSchemaV1,
  gate: RuntimeGateGuardSchemaV1,
  closedChildCutoff: sequence,
  admissionSealVersion: generation,
  targetPlanDigest: digest,
  admission: Type.Literal("closed"),
  members: Type.Array(admittedMember, {
    minItems: 1,
    maxItems: PREPARATION_JOB_LIMITS_V1.maxExecutions,
  }),
  manifestDigest: digest,
  provenance,
});
export type PreparationJobAdmissionSnapshotV1 = Immutable<
  Static<typeof PreparationJobAdmissionSnapshotSchemaV1>
>;
export const PreparationJobAdmissionReadSchemaV1 = closed({
  ...readFields,
  method: Type.Literal("read-admission"),
});
export type PreparationJobAdmissionReadV1 = Immutable<
  Static<typeof PreparationJobAdmissionReadSchemaV1>
>;
export const PreparationJobReadSchemaV1 = Type.Union([
  closed({
    ...readFields,
    method: Type.Enum(["discover-job", "observe-job", "read-original-effect"]),
  }),
  closed({
    ...readFields,
    method: Type.Literal("read-closure"),
    admission: PreparationJobAdmissionSnapshotSchemaV1,
  }),
]);
export type PreparationJobReadV1 = Immutable<Static<typeof PreparationJobReadSchemaV1>>;

const observedJob = closed({
  ...Type.Omit(jobPredicate, ["kind", "jobUid"]).properties,
  uid: reference,
  suspended: Type.Boolean(),
});
export const PreparationJobObservationSchemaV1 = closed({
  schemaVersion,
  original: PreparationJobReserveSchemaV1,
  gate: RuntimeGateGuardSchemaV1,
  job: observedJob,
  pods: Type.Array(pod, { maxItems: PREPARATION_JOB_LIMITS_V1.maxChildren }),
  executions: Type.Array(execution, { maxItems: PREPARATION_JOB_LIMITS_V1.maxExecutions }),
  collection: closed({
    state: Type.Enum(["complete", "incomplete"]),
    snapshotRef: reference,
    sourceResourceVersion: reference,
    observedChildCutoff: sequence,
  }),
  controlPlane: provenance,
  runtime: provenance,
});
export type PreparationJobObservationV1 = Immutable<
  Static<typeof PreparationJobObservationSchemaV1>
>;

const resolvedFields = { ...admittedMember.properties, resolutionEvidenceRef: reference };
const resolvedAttempt = Type.Union([
  closed({
    ...resolvedFields,
    outcome: Type.Literal("executions-excluded"),
    originalEffectOutcome: Type.Enum(["applied", "unknown"]),
  }),
  closed({
    ...resolvedFields,
    outcome: Type.Literal("inert-root"),
    rootUid: reference,
    rootResourceVersion: reference,
  }),
  closed({
    ...resolvedFields,
    outcome: Type.Literal("prevented"),
    prevention: Type.Enum(["before-provider-acceptance", "sealed-admission"]),
  }),
  closed({
    ...resolvedFields,
    outcome: Type.Literal("terminated"),
    pod,
    execution,
    finalState: Type.Literal("execution-terminated"),
  }),
]);
/** Only protected complete closure from the existing fence/store owners can supply
 * no-writer evidence. Zero counters in DATA do not close future starts or late Pods. */
export const PreparationJobClosureSchemaV1 = closed({
  schemaVersion,
  original: PreparationJobReserveSchemaV1,
  gate: RuntimeGateGuardSchemaV1,
  cleanupBinding,
  root: closed({ ...observedJob.properties, suspended: Type.Literal(true) }),
  admission: PreparationJobAdmissionSnapshotSchemaV1,
  targetPlanDigest: digest,
  closedChildCutoff: sequence,
  admissionSealVersion: generation,
  attemptManifestDigest: digest,
  attempts: Type.Array(resolvedAttempt, {
    minItems: 1,
    maxItems: PREPARATION_JOB_LIMITS_V1.maxExecutions,
  }),
  producerDomains: Type.Array(
    closed({
      domainRef: reference,
      kind: domainKind,
      capabilityRef: reference,
      originalReserveEffectRef: effect,
      targetPlanDigest: digest,
      closedChildCutoff: sequence,
      sealVersion: generation,
      futureStarts: Type.Literal("closed"),
      unresolvedAttempts: Type.Literal(0),
      unresolvedWriters: Type.Literal(0),
      provenance,
    }),
    { minItems: 3, maxItems: 3 },
  ),
  staging: StoreBindingRefSchemaV1,
  storeEvidence: closed({
    staging: StoreBindingRefSchemaV1,
    closedChildCutoff: sequence,
    targetPlanDigest: digest,
    writerState: Type.Literal("no-writers"),
    provenance,
  }),
  outcome: Type.Literal("original-writers-excluded"),
});
export type PreparationJobClosureV1 = Immutable<Static<typeof PreparationJobClosureSchemaV1>>;

const failure = closed({
  status: Type.Enum(["unsupported", "incomplete", "ambiguous", "unknown", "conflict", "denied"]),
  original: PreparationJobMutationSchemaV1,
  reason: Type.Enum([
    "authority-unavailable",
    "authority-lost",
    "capability-unavailable",
    "not-visible",
    "provider-outcome-unknown",
    "identity-mismatch",
    "precondition-failed",
    "gate-changed",
    "evidence-incomplete",
    "evidence-stale",
    "writer-unresolved",
    "cancelled",
    "deadline-exceeded",
  ]),
  nextAction: Type.Enum(["retain-original-and-readback", "retain-original-and-fence"]),
});
export const PreparationJobAdmissionResultSchemaV1 = Type.Union([
  closed({ status: Type.Literal("admitted"), snapshot: PreparationJobAdmissionSnapshotSchemaV1 }),
  failure,
]);
export type PreparationJobAdmissionResultV1 = Immutable<
  Static<typeof PreparationJobAdmissionResultSchemaV1>
>;
export const PreparationJobMutationResultSchemaV1 = Type.Union([
  closed({
    status: Type.Literal("acknowledged"),
    original: PreparationJobMutationSchemaV1,
    providerReceiptRef: reference,
    physicalOutcome: Type.Literal("unproven"),
    provenance,
  }),
  failure,
]);
export type PreparationJobMutationResultV1 = Immutable<
  Static<typeof PreparationJobMutationResultSchemaV1>
>;
export const PreparationJobReadResultSchemaV1 = Type.Union([
  closed({
    status: Type.Literal("observed"),
    original: PreparationJobMutationSchemaV1,
    observation: PreparationJobObservationSchemaV1,
  }),
  closed({
    status: Type.Literal("effect-record"),
    original: PreparationJobMutationSchemaV1,
    result: PreparationJobMutationResultSchemaV1,
    provenance,
  }),
  failure,
]);
export type PreparationJobReadResultV1 = Immutable<Static<typeof PreparationJobReadResultSchemaV1>>;
export const PreparationJobClosureResultSchemaV1 = Type.Union([
  closed({ status: Type.Literal("closed"), closure: PreparationJobClosureSchemaV1 }),
  failure,
]);
export type PreparationJobClosureResultV1 = Immutable<
  Static<typeof PreparationJobClosureResultSchemaV1>
>;
export const PreparationJobReceiptPairSchemaV1 = closed({
  schemaVersion,
  release: PreparationJobReleaseSchemaV1,
  identity: PreparationJobIdentitySchemaV1,
  receipt: PreparationCheckoutReceiptSchemaV1,
});
export type PreparationJobReceiptPairV1 = Immutable<
  Static<typeof PreparationJobReceiptPairSchemaV1>
>;

/** The original canonical owner reads retained membership and independently checks
 * the same snapshot after waits. Cached bytes keep their source time; reobservation
 * has independently owned evidence identity/version. Missing owners stay unavailable. */
export interface PreparationJobAdmissionPortV1 {
  readAdmission(
    input: PreparationJobAdmissionReadV1,
    call: AuthorityCallV1,
  ): Promise<PreparationJobAdmissionResultV1>;
  assertCurrentAdmission(
    input: PreparationJobAdmissionReadV1,
    originalSnapshot: PreparationJobAdmissionSnapshotV1,
    call: AuthorityCallV1,
  ): Promise<PreparationJobAdmissionResultV1>;
}

/** Original Compute applicability, without provider or admission implementation.
 * Every accepting boundary authenticates current responsibility and conditionally
 * checks UID/resourceVersion/fence while retaining possible submissions atomically.
 * BEFORE any staging write (release, init or startup), the original storage and
 * lifecycle owners establish current candidate/incarnation/plan and exact staging
 * version, physical object/subpath and mount policy. They establish fresh exclusive
 * allocation without aliases/prior writers, or retained reservation and a barrier
 * resolving all possible predecessors; exclude competing admission and recheck
 * currentness after waits. Unknown producer coverage denies writes. DATA, a Job UID,
 * a receipt or later closure cannot replace this pre-write storage admission.
 * StoreBinding/WorkspaceHandoffEvidence ownership remains unchanged. Cancellation
 * retains the original. Fresh authorized reads/fences may resolve expired originals;
 * they never resubmit them with refreshed identities or deadlines. */
export interface PreparationJobEffectsV1 {
  reserve(
    input: PreparationJobReserveV1,
    call: AuthorityCallV1,
  ): Promise<PreparationJobMutationResultV1>;
  release(
    input: PreparationJobReleaseV1,
    call: AuthorityCallV1,
  ): Promise<PreparationJobMutationResultV1>;
  seal(input: PreparationJobSealV1, call: AuthorityCallV1): Promise<PreparationJobMutationResultV1>;
  terminate(
    input: PreparationJobTerminateV1,
    call: AuthorityCallV1,
  ): Promise<PreparationJobMutationResultV1>;
  discover(
    input: PreparationJobReadV1 & { readonly method: "discover-job" },
    call: AuthorityCallV1,
  ): Promise<PreparationJobReadResultV1>;
  observe(
    input: PreparationJobReadV1 & { readonly method: "observe-job" },
    call: AuthorityCallV1,
  ): Promise<PreparationJobReadResultV1>;
  readback(
    input: PreparationJobReadV1 & { readonly method: "read-original-effect" },
    call: AuthorityCallV1,
  ): Promise<PreparationJobReadResultV1>;
  /** The original fence owner rechecks cleanup binding before/after waits, closes
   * stale sealer admission and every admitted controller/Pod/node/staging domain,
   * including retries, delayed/replacement Pods, init and node restarts. Missing
   * protected producer evidence stays unavailable. Root/staging retention is permanent;
   * closure excludes original writers and grants no purge or successor admission. */
  readClosure(
    input: PreparationJobReadV1 & { readonly method: "read-closure" },
    call: AuthorityCallV1,
  ): Promise<PreparationJobClosureResultV1>;
}

/** Shares the original producer's protected receipt identity and post-await assertion. */
export interface PreparationJobReceiptConsumerV1 {
  readonly receipts: RepositoryPreparationReceiptPortV1;
  readonly effects: PreparationJobEffectsV1;
}
export const PreparationJobSchemasV1 = Object.freeze({
  target: PreparationJobTargetSchemaV1,
  plan: PreparationJobPlanSchemaV1,
  reserve: PreparationJobReserveSchemaV1,
  release: PreparationJobReleaseSchemaV1,
  seal: PreparationJobSealSchemaV1,
  terminate: PreparationJobTerminateSchemaV1,
  mutation: PreparationJobMutationSchemaV1,
  read: PreparationJobReadSchemaV1,
  identity: PreparationJobIdentitySchemaV1,
  observation: PreparationJobObservationSchemaV1,
  closure: PreparationJobClosureSchemaV1,
  mutationResult: PreparationJobMutationResultSchemaV1,
  readResult: PreparationJobReadResultSchemaV1,
  closureResult: PreparationJobClosureResultSchemaV1,
  receiptPair: PreparationJobReceiptPairSchemaV1,
  admissionSnapshot: PreparationJobAdmissionSnapshotSchemaV1,
  admissionRead: PreparationJobAdmissionReadSchemaV1,
  admissionResult: PreparationJobAdmissionResultSchemaV1,
});
export type PreparationJobSchemaNameV1 = keyof typeof PreparationJobSchemasV1;
export type PreparationJobValueV1<K extends PreparationJobSchemaNameV1> = Immutable<
  Static<(typeof PreparationJobSchemasV1)[K]>
>;
