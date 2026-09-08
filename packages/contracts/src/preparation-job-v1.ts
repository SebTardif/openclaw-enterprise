import { Type, type Static, type TProperties } from "typebox";
import {
  RepositoryPreparationSubjectSchemaV1,
  PreparationCheckoutRequestSchemaV1,
  PreparationCheckoutReceiptSchemaV1,
  type RepositoryPreparationReceiptPortV1,
} from "./repository-preparation-v1.ts";
import {
  RuntimeGateGuardSchemaV1,
  RuntimeEvidenceProvenanceSchemaV1,
  RUNTIME_EFFECT_LIMITS_V1,
} from "./runtime-effects-v1.ts";
import { type AuthorityCallV1 } from "./runtime-authority-v1.ts";
import { StoreBindingRefSchemaV1 } from "./completed-state-v1.ts";

// Preparation is a distinct applicability profile. These declarations do not
// authenticate a caller, issue a credential or implement a Kubernetes provider.
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const subject = RepositoryPreparationSubjectSchemaV1;
const ref = subject.properties.incarnationRef;
const uuid = subject.properties.preparationRef;
const digest = subject.properties.revisionDigest;
const generation = subject.properties.authorizationGeneration;
const timestamp = subject.properties.createdAt;
const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const version = Type.Literal(1);

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

/** A concrete reserved Job name, never a Deployment or a Harness assignment. */
export const PreparationJobTargetSchemaV1 = object({
  schemaVersion: version,
  purpose: Type.Literal("candidate-repository-preparation"),
  preparation: subject,
  clusterRef: ref,
  kubernetesNamespace: Type.String({
    minLength: 1,
    maxLength: 63,
    pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$",
  }),
  kubernetesNamespaceUid: ref,
  apiVersion: Type.Literal("batch/v1"),
  apiKind: Type.Literal("Job"),
  name: Type.String({ minLength: 1, maxLength: 63, pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$" }),
  reservationRef: uuid,
  retention: Type.Literal("permanent-inert-reservation"),
});
export type PreparationJobTargetV1 = Immutable<Static<typeof PreparationJobTargetSchemaV1>>;

const provenance = object({
  ...RuntimeEvidenceProvenanceSchemaV1.properties,
  clock: object(RuntimeEvidenceProvenanceSchemaV1.properties.clock.properties),
});
const domainKind = Type.Enum(["job-controller", "node-runtime", "staging-writers"]);
const domain = object({
  domainRef: ref,
  kind: domainKind,
  requiredProducerRef: ref,
  requiredCapabilityRef: ref,
  profileDigest: digest,
});
/** A closed applicability profile for the existing admission owner. No parsed plan
 * grants admission. All template fields are present before the inert root exists. */
export const PreparationJobPlanSchemaV1 = object({
  schemaVersion: version,
  planRef: ref,
  planVersion: generation,
  planDigest: digest,
  target: PreparationJobTargetSchemaV1,
  jobSpecDigest: digest,
  podTemplateDigest: digest,
  profile: object({
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
    identityProfileRef: ref,
    identityProfileDigest: digest,
    admittedExecutionNotAfter: timestamp,
  }),
  producerDomains: Type.Array(domain, { minItems: 3, maxItems: 3 }),
  reservationRetention: Type.Literal("permanent"),
});
export type PreparationJobPlanV1 = Immutable<Static<typeof PreparationJobPlanSchemaV1>>;
const operation = {
  schemaVersion: version,
  effectRef: uuid,
  requestDigest: digest,
  requestId: PreparationCheckoutRequestSchemaV1.properties.requestId,
  createdAt: timestamp,
  deadline: timestamp,
};
/** Checkout effectRef names the preallocated RELEASE effect; reserve has its own
 * distinct digest and identity. Both original messages survive every unknown result. */
export const PreparationJobReserveSchemaV1 = object({
  ...operation,
  method: Type.Literal("reserve-job"),
  target: PreparationJobTargetSchemaV1,
  plan: PreparationJobPlanSchemaV1,
  checkout: PreparationCheckoutRequestSchemaV1,
  releaseEffectRef: uuid,
  gate: RuntimeGateGuardSchemaV1,
  predicate: object({
    kind: Type.Literal("expected-absent"),
    retention: Type.Literal("permanent-inert-reservation"),
  }),
});
export type PreparationJobReserveV1 = Immutable<Static<typeof PreparationJobReserveSchemaV1>>;
const jobPredicate = object({
  kind: Type.Literal("expected-job"),
  jobUid: ref,
  resourceVersion: ref,
  namespaceUid: ref,
  ownerPreparationRef: uuid,
  ownerIncarnationRef: ref,
  ownerReserveEffectRef: uuid,
  fenceEpoch: generation,
});
export const PreparationJobReleaseSchemaV1 = object({
  ...operation,
  method: Type.Literal("release-job"),
  original: PreparationJobReserveSchemaV1,
  gate: RuntimeGateGuardSchemaV1,
  predicate: jobPredicate,
});
export type PreparationJobReleaseV1 = Immutable<Static<typeof PreparationJobReleaseSchemaV1>>;
const cleanup = {
  ...operation,
  original: PreparationJobReserveSchemaV1,
  // The current guard may advance generation/responsibility without rewriting the
  // immutable original subject. Its real owner must authorize this exact old target.
  gate: RuntimeGateGuardSchemaV1,
  cleanupBinding: object({
    reserveEffectRef: uuid,
    reserveRequestDigest: digest,
    targetPlanRef: ref,
    targetPlanVersion: generation,
    targetPlanDigest: digest,
    responsibility: RuntimeGateGuardSchemaV1.properties.responsibility,
  }),
};
export const PreparationJobSealSchemaV1 = object({
  ...cleanup,
  method: Type.Literal("seal-job"),
  predicate: jobPredicate,
  closeAdmittedChildCutoff: sequence,
});
export type PreparationJobSealV1 = Immutable<Static<typeof PreparationJobSealSchemaV1>>;
const pod = object({
  namespaceUid: ref,
  jobUid: ref,
  controllerKind: Type.Literal("Job"),
  controllerUid: ref,
  podUid: ref,
  resourceVersion: ref,
});
const execution = object({
  executionRef: ref,
  executionGeneration: generation,
  podUid: ref,
  nodeUid: ref,
  sandboxId: ref,
  containerName: ref,
  containerKind: Type.Enum(["init", "main"]),
  runtimeHandler: Type.Literal("runsc"),
  platform: Type.Literal("systrap"),
  isolationPolicy: Type.Literal("STRICT"),
  runscExecutableDigest: digest,
  runtimeProfileDigest: digest,
  identityProfileRef: ref,
  identityProfileDigest: digest,
});
/** All fields need independently protected source evidence. An API label, process
 * PID, restartCount or serialized service identity is not such evidence. */
export const PreparationJobIdentitySchemaV1 = object({
  schemaVersion: version,
  purpose: Type.Literal("candidate-repository-preparation"),
  target: PreparationJobTargetSchemaV1,
  reserveEffectRef: uuid,
  reserveRequestDigest: digest,
  releaseEffectRef: uuid,
  authorizationGeneration: generation,
  lifecycleGeneration: generation,
  fenceEpoch: generation,
  pod,
  execution,
  controlPlane: provenance,
  runtime: provenance,
});
export type PreparationJobIdentityV1 = Immutable<Static<typeof PreparationJobIdentitySchemaV1>>;
export const PreparationJobTerminateSchemaV1 = object({
  ...cleanup,
  method: Type.Literal("terminate-exact"),
  predicate: jobPredicate,
  terminationTarget: Type.Union([
    object({ kind: Type.Literal("pod"), pod }),
    object({ kind: Type.Literal("runtime-execution"), pod, execution }),
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
  schemaVersion: version,
  original: PreparationJobMutationSchemaV1,
  gate: RuntimeGateGuardSchemaV1,
  requestId: PreparationCheckoutRequestSchemaV1.properties.requestId,
  createdAt: timestamp,
  deadline: timestamp,
};
const admittedMember = object({
  attemptRef: ref,
  effectRef: uuid,
  requestDigest: digest,
  domainRef: ref,
  admittedSequence: sequence,
});
/** Contribution from the SAME canonical admission owner: exact retained members
 * and the current closed admission cut. A parser cannot establish completeness. */
export const PreparationJobAdmissionSnapshotSchemaV1 = object({
  schemaVersion: version,
  snapshotRef: ref,
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
export const PreparationJobAdmissionReadSchemaV1 = object({
  ...readFields,
  method: Type.Literal("read-admission"),
});
export type PreparationJobAdmissionReadV1 = Immutable<
  Static<typeof PreparationJobAdmissionReadSchemaV1>
>;
export const PreparationJobReadSchemaV1 = Type.Union([
  object({
    ...readFields,
    method: Type.Enum(["discover-job", "observe-job", "read-original-effect"]),
  }),
  object({
    ...readFields,
    method: Type.Literal("read-closure"),
    admission: PreparationJobAdmissionSnapshotSchemaV1,
  }),
]);
export type PreparationJobReadV1 = Immutable<Static<typeof PreparationJobReadSchemaV1>>;
const job = object({
  ...Type.Omit(jobPredicate, ["kind", "jobUid"]).properties,
  uid: ref,
  suspended: Type.Boolean(),
});
export const PreparationJobObservationSchemaV1 = object({
  schemaVersion: version,
  original: PreparationJobReserveSchemaV1,
  gate: RuntimeGateGuardSchemaV1,
  job,
  pods: Type.Array(pod, { maxItems: PREPARATION_JOB_LIMITS_V1.maxChildren }),
  executions: Type.Array(execution, { maxItems: PREPARATION_JOB_LIMITS_V1.maxExecutions }),
  collection: object({
    state: Type.Enum(["complete", "incomplete"]),
    snapshotRef: ref,
    sourceResourceVersion: ref,
    observedChildCutoff: sequence,
  }),
  controlPlane: provenance,
  runtime: provenance,
});
export type PreparationJobObservationV1 = Immutable<
  Static<typeof PreparationJobObservationSchemaV1>
>;
const closedDomain = object({
  domainRef: ref,
  kind: domainKind,
  capabilityRef: ref,
  originalReserveEffectRef: uuid,
  targetPlanDigest: digest,
  closedChildCutoff: sequence,
  sealVersion: generation,
  futureStarts: Type.Literal("closed"),
  unresolvedAttempts: Type.Literal(0),
  unresolvedWriters: Type.Literal(0),
  provenance,
});
const attemptFields = { ...admittedMember.properties, resolutionEvidenceRef: ref };
const resolvedAttempt = Type.Union([
  object({
    ...attemptFields,
    outcome: Type.Literal("executions-excluded"),
    originalEffectOutcome: Type.Enum(["applied", "unknown"]),
  }),
  object({
    ...attemptFields,
    outcome: Type.Literal("inert-root"),
    rootUid: ref,
    rootResourceVersion: ref,
  }),
  object({
    ...attemptFields,
    outcome: Type.Literal("prevented"),
    prevention: Type.Enum(["before-provider-acceptance", "sealed-admission"]),
  }),
  object({
    ...attemptFields,
    outcome: Type.Literal("terminated"),
    pod,
    execution,
    finalState: Type.Literal("execution-terminated"),
  }),
]);
/** A diagnostic representation of protected fence/store facts. Only their existing
 * owners can establish current completeness; this schema is not a fence issuer. */
export const PreparationJobClosureSchemaV1 = object({
  schemaVersion: version,
  original: PreparationJobReserveSchemaV1,
  gate: RuntimeGateGuardSchemaV1,
  cleanupBinding: cleanup.cleanupBinding,
  root: object({ ...job.properties, suspended: Type.Literal(true) }),
  admission: PreparationJobAdmissionSnapshotSchemaV1,
  targetPlanDigest: digest,
  closedChildCutoff: sequence,
  admissionSealVersion: generation,
  attemptManifestDigest: digest,
  attempts: Type.Array(resolvedAttempt, {
    minItems: 1,
    maxItems: PREPARATION_JOB_LIMITS_V1.maxExecutions,
  }),
  producerDomains: Type.Array(closedDomain, { minItems: 3, maxItems: 3 }),
  staging: StoreBindingRefSchemaV1,
  storeEvidence: object({
    staging: StoreBindingRefSchemaV1,
    closedChildCutoff: sequence,
    targetPlanDigest: digest,
    writerState: Type.Literal("no-writers"),
    provenance,
  }),
  outcome: Type.Literal("original-writers-excluded"),
});
export type PreparationJobClosureV1 = Immutable<Static<typeof PreparationJobClosureSchemaV1>>;
const retained = Type.Enum(["retain-original-and-readback", "retain-original-and-fence"]);
const failure = object({
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
  nextAction: retained,
});
export const PreparationJobAdmissionResultSchemaV1 = Type.Union([
  object({ status: Type.Literal("admitted"), snapshot: PreparationJobAdmissionSnapshotSchemaV1 }),
  failure,
]);
export type PreparationJobAdmissionResultV1 = Immutable<
  Static<typeof PreparationJobAdmissionResultSchemaV1>
>;
/** Additional applicability on the existing canonical gate/responsibility owner.
 * Read and assert independently look up retained exact membership/identity and
 * current closed admission. Cached bytes preserve their original source time;
 * a fresh observation has its own evidence identity/version. No alternate journal.
 * Missing actual current owner inputs produce an unavailable closed result. */
export interface PreparationJobAdmissionPortV1 {
  readAdmission(
    input: PreparationJobAdmissionReadV1,
    call: AuthorityCallV1,
  ): Promise<PreparationJobAdmissionResultV1>;
  assertCurrentAdmission(
    input: PreparationJobAdmissionReadV1,
    snapshot: PreparationJobAdmissionSnapshotV1,
    call: AuthorityCallV1,
  ): Promise<PreparationJobAdmissionResultV1>;
}
export const PreparationJobMutationResultSchemaV1 = Type.Union([
  object({
    status: Type.Literal("acknowledged"),
    original: PreparationJobMutationSchemaV1,
    providerReceiptRef: ref,
    // Transport/provider acknowledgment is neither physical stop nor no writers.
    physicalOutcome: Type.Literal("unproven"),
    provenance,
  }),
  failure,
]);
export type PreparationJobMutationResultV1 = Immutable<
  Static<typeof PreparationJobMutationResultSchemaV1>
>;
export const PreparationJobReadResultSchemaV1 = Type.Union([
  object({
    status: Type.Literal("observed"),
    original: PreparationJobMutationSchemaV1,
    observation: PreparationJobObservationSchemaV1,
  }),
  object({
    status: Type.Literal("effect-record"),
    original: PreparationJobMutationSchemaV1,
    result: PreparationJobMutationResultSchemaV1,
    provenance,
  }),
  failure,
]);
export type PreparationJobReadResultV1 = Immutable<Static<typeof PreparationJobReadResultSchemaV1>>;
export const PreparationJobReceiptPairSchemaV1 = object({
  schemaVersion: version,
  release: PreparationJobReleaseSchemaV1,
  identity: PreparationJobIdentitySchemaV1,
  receipt: PreparationCheckoutReceiptSchemaV1,
});
export type PreparationJobReceiptPairV1 = Immutable<
  Static<typeof PreparationJobReceiptPairSchemaV1>
>;
export const PreparationJobClosureResultSchemaV1 = Type.Union([
  object({ status: Type.Literal("closed"), closure: PreparationJobClosureSchemaV1 }),
  failure,
]);
export type PreparationJobClosureResultV1 = Immutable<
  Static<typeof PreparationJobClosureResultSchemaV1>
>;

/** The original Compute owner implements this applicability; no new service/issuer.
 * Every effect authenticates call/current responsibility at the accepting boundary.
 * Canonical admission atomically checks owner/UID/RV/fence and retains possible
 * submissions before effects. Cancellation never abandons the retained original.
 * BEFORE any staging write, including release, init or startup, the original
 * persistence/store owner and canonical lifecycle accepting owner must establish
 * the exact current candidate/incarnation/plan, staging binding/version and physical
 * object/subpath/mount policy: either fresh candidate-exclusive allocation with no
 * serving/other-candidate alias or prior possible writer, or the applicable retained
 * store reservation and prior-writer barrier resolving every possible predecessor.
 * Competing writer admission is excluded and currentness is rechecked at the actual
 * accepting boundary after waits. Unknown/missing producer coverage denies writes;
 * a store reference, Job UID, receipt or later closure does not satisfy this rule.
 * Existing StoreBindingV1 / WorkspaceHandoffEvidenceV1 ownership and applicability
 * remain unchanged; see docs/reference/preparation-job.md#pre-write-staging-admission.
 * Reads require fresh authorized calls; an expired original effect may still be
 * read or fenced, but cannot be resubmitted with refreshed identity or deadline. */
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
  /** Existing canonical fence owner checks exact current cleanup binding before
   * and after waits, closes stale sealer admission, and resolves EVERY admitted
   * controller/Pod/node/writer domain. Unsupported producer inputs stay unavailable.
   * Root Job retention and staging retention are permanent; this grants no purge. */
  readClosure(
    input: PreparationJobReadV1 & { readonly method: "read-closure" },
    call: AuthorityCallV1,
  ): Promise<PreparationJobClosureResultV1>;
}
/** Composition names the existing credential receipt port, never a replacement. */
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
} as const);
export type PreparationJobSchemaNameV1 = keyof typeof PreparationJobSchemasV1;
export type PreparationJobValueV1<K extends PreparationJobSchemaNameV1> = Immutable<
  Static<(typeof PreparationJobSchemasV1)[K]>
>;
