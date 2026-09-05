import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { AgentId, InstallationId, NamespaceId, RevisionId } from "./api/common.ts";
import type { RuntimeAllocation, RuntimeIntent, RuntimeScope } from "./runtime-assignment.ts";

/** Local interface only. Parsers establish shape, never provenance or permission. */
export const RUNTIME_AUTHORITY_LIMITS_V1 = Object.freeze({
  maxJsonBytes: 65_536,
  maxDepth: 32,
  maxImageEntries: 16,
  observationMaxAgeMs: 15_000,
  clockUncertaintyMaxMs: 2_000,
  lookupMaxMs: 3_000,
  activeRecheckMaxMs: 5_000,
  preparationMaxMs: 900_000,
  providerRequestMaxMs: 10_000,
  gracefulStopMaxMs: 30_000,
  terminationObservationMaxMs: 120_000,
  // Selected ceilings, not measured guarantees; stricter operation policies prevail.
  reconcileBackoffMs: Object.freeze([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]),
});

const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const enumeration = <T extends string>(values: readonly T[]) => Type.Enum(values);
const version = Type.Literal(1);
const counter = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const ref = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:/-]+$" });
const digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const timestamp = Type.String({
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
});
const component = enumeration(["gateway", "harness"]);
const assignmentRef = object({ schemaVersion: version, id: uuid });
const scope = { installationId: InstallationId, namespaceId: NamespaceId, agentId: AgentId };
const profiles = {
  providerProfileRef: ref,
  runtimeProfileRef: ref,
  identityProfileRef: ref,
};
const profileDigests = object({ provider: digest, runtime: digest, identity: digest });
const target = object({
  ...scope,
  assignmentRef,
  revisionId: RevisionId,
  component,
  lifecycleGeneration: counter,
  runtimeGeneration: counter,
  createEffectRef: uuid,
});

export const RUNTIME_AUTHORITY_PURPOSES_V1 = Object.freeze([
  "identity-registration",
  "readiness-probe",
  "runtime-peer",
  "model-call",
  "repository-issuance",
  "cleanup",
  "completed-context-restore",
] as const);
export type RuntimeAuthorityPurposeV1 = (typeof RUNTIME_AUTHORITY_PURPOSES_V1)[number];
export const RUNTIME_AUTHORITY_SERVICE_ROLES_V1 = Object.freeze([
  "compute-observer",
  "identity-verifier",
  "registrar",
  "lifecycle-authority",
  "readiness-prober",
  "runtime-transport",
  "model-mediator",
  "repository-issuer",
  "cleanup",
  "restore-preparer",
  "restore-receiver",
] as const);
export type RuntimeAuthorityServiceRoleV1 = (typeof RUNTIME_AUTHORITY_SERVICE_ROLES_V1)[number];

export type RuntimeAuthorityMutationPermissionV1 =
  "bind" | "record-evidence:runtime" | "record-evidence:identity" | "retire";
export interface RuntimeAuthorityRolePolicyV1 {
  readonly mutations: readonly RuntimeAuthorityMutationPermissionV1[];
  readonly purposes: readonly RuntimeAuthorityPurposeV1[];
  readonly restoreSuboperations: readonly ("importCompletedContext" | "readImportedContext")[];
  readonly operationRead: "original-service" | "accepted-cleanup-responsibility" | "none";
}
/** Normative maximum role permissions, not an authorization decision. Everything unlisted
 * denies. The actual service/role/scope/profile comes from the injected verifier and current
 * registry, never these labels in a request. OCC remains the sole writer for every mutation.
 * bind always validates independent Compute provenance, even for the lifecycle caller.
 * Evidence submission never substitutes the caller for its required observation producer.
 * Exact original-service readback also checks scope, method, payload and original attribution;
 * cleanup readback requires retained exact ownership and discloses only necessary old targets.
 * restore-receiver is deliberately not restore-preparer: its separate native claim/report
 * interface cannot grant canonical context read/import, runtime selection or resolver rights.
 */
export const RUNTIME_AUTHORITY_ROLE_POLICY_V1 = freeze({
  "compute-observer": {
    mutations: ["bind", "record-evidence:runtime"],
    purposes: [],
    restoreSuboperations: [],
    operationRead: "original-service",
  },
  "identity-verifier": {
    mutations: ["record-evidence:identity"],
    purposes: [],
    restoreSuboperations: [],
    operationRead: "original-service",
  },
  registrar: {
    mutations: [],
    purposes: ["identity-registration"],
    restoreSuboperations: [],
    operationRead: "none",
  },
  "lifecycle-authority": {
    mutations: ["bind", "retire"],
    purposes: [],
    restoreSuboperations: [],
    operationRead: "original-service",
  },
  "readiness-prober": {
    mutations: [],
    purposes: ["readiness-probe"],
    restoreSuboperations: [],
    operationRead: "none",
  },
  "runtime-transport": {
    mutations: [],
    purposes: ["readiness-probe", "runtime-peer"],
    restoreSuboperations: [],
    operationRead: "none",
  },
  "model-mediator": {
    mutations: [],
    purposes: ["model-call"],
    restoreSuboperations: [],
    operationRead: "none",
  },
  "repository-issuer": {
    mutations: [],
    purposes: ["repository-issuance"],
    restoreSuboperations: [],
    operationRead: "none",
  },
  cleanup: {
    mutations: [],
    purposes: ["cleanup"],
    restoreSuboperations: [],
    operationRead: "accepted-cleanup-responsibility",
  },
  "restore-preparer": {
    mutations: [],
    purposes: ["completed-context-restore"],
    restoreSuboperations: ["importCompletedContext", "readImportedContext"],
    operationRead: "none",
  },
  "restore-receiver": {
    mutations: [],
    purposes: [],
    restoreSuboperations: [],
    operationRead: "none",
  },
} as const satisfies Record<RuntimeAuthorityServiceRoleV1, RuntimeAuthorityRolePolicyV1>);

const observedClock = {
  sourceObservedAt: timestamp,
  receivedAt: timestamp,
  validUntil: timestamp,
  uncertaintyMs: Type.Integer({ minimum: 0, maximum: 2_000 }),
};
const image = object({ name: ref, digest });
const instanceCommon = {
  schemaVersion: version,
  bindingVersion: version,
  clusterRef: ref,
  kubernetesNamespaceUid: ref,
  podUid: ref,
  deploymentUid: ref,
  replicaSetUid: ref,
  imageDigests: Type.Array(image, { minItems: 1, maxItems: 16 }),
  policyRevision: ref,
  admittedConfigurationDigest: digest,
  profileDigests,
};
const gvisorBinding = object({
  ...instanceCommon,
  provider: Type.Literal("occ/kubernetes-gvisor"),
  component: Type.Literal("harness"),
  runtimeClass: Type.Literal("oce-gvisor-systrap"),
  runtimeHandler: Type.Literal("oce-gvisor-systrap"),
  runtimeType: Type.Literal("io.containerd.runsc.v1"),
  platform: Type.Literal("systrap"),
  isolation: Type.Literal("STRICT"),
  runscSandboxId: ref,
  runtimeInstanceRef: ref,
  // Same-Pod execution/container restart changes these and requires a new assignment.
  protectedRestartDiscriminator: ref,
  runtimeBinaryDigest: digest,
  runtimeDistributionDigest: digest,
  runtimeFlagsDigest: digest,
});
const gatewayBinding = object({
  ...instanceCommon,
  provider: Type.Literal("occ/kubernetes-gateway"),
  component: Type.Literal("gateway"),
  runtimeInstanceRef: ref,
  protectedRestartDiscriminator: ref,
  scheduling: Type.Union([
    object({ mode: Type.Literal("default"), profileRef: ref }),
    object({ mode: Type.Literal("runtime-class"), runtimeClass: ref, profileRef: ref }),
  ]),
});
/** No OpenShell fallback: a later provider requires its own closed admitted variant. */
export const RuntimeBindingSchemaV1 = Type.Union([gvisorBinding, gatewayBinding]);
export type RuntimeBindingV1 = Static<typeof RuntimeBindingSchemaV1>;
export type RuntimeAssignmentTargetV1 = Static<typeof target>;
export type AssignmentRefV1 = Static<typeof assignmentRef>;
export type RuntimeAuthorityScopeV1 = RuntimeScope & { readonly installationId: string };

const allocation = object({
  ...scope,
  ...profiles,
  assignmentRef: uuid,
  createEffectRef: uuid,
  revisionId: RevisionId,
  servicePrincipalId: ref,
  lifecycleGeneration: counter,
  component,
  runtimeGeneration: counter,
  bindingCondition: Type.Literal("unbound"),
  createdAt: timestamp,
});
export const RuntimeAssignmentRecordSchemaV1 = object({
  schemaVersion: version,
  allocation,
  binding: Type.Union([
    object({ status: Type.Literal("unbound") }),
    object({ status: Type.Literal("bound"), instance: RuntimeBindingSchemaV1 }),
  ]),
  authority: object({
    state: enumeration([
      "allocated",
      "bound",
      "identity-ready",
      "active",
      "retiring",
      "retired",
      "abandoned",
    ]),
    assignmentRecordVersion: counter,
  }),
});
/** Existing inert storage ownership is reused, not replaced by the binding projection. */
export type RuntimeAssignmentRecordV1 = Omit<
  Static<typeof RuntimeAssignmentRecordSchemaV1>,
  "allocation"
> & {
  readonly allocation: Readonly<RuntimeAllocation>;
};
export type RuntimeAuthorityIntentRecordV1 = Readonly<RuntimeIntent>;

const negativeReasons = [
  "evidence-stale",
  "observation-invalid",
  "agent-disabled",
  "agent-stopped",
  "assignment-replaced",
  "assignment-retired",
  "binding-mismatch",
  "peer-mismatch",
  "component-denied",
  "peer-invalid",
  "peer-untrusted",
  "peer-expired",
  "candidate-only",
  "operation-denied",
  "profile-authority-denied",
  "profile-reference-invalid",
  "profile-invalid",
  "profile-unresolved",
  "version-unsupported",
  "capability-missing",
  "bundle-invalid",
  "bundle-rollback",
  "provider-permission-denied",
  "provider-outcome-unknown",
] as const;
const evidenceResult = Type.Union([
  object({ result: Type.Literal("satisfied"), reasonCode: Type.Literal("conditions-satisfied") }),
  object({ result: Type.Literal("unsatisfied"), reasonCode: enumeration(negativeReasons) }),
  object({
    result: Type.Literal("unknown"),
    reasonCode: enumeration([
      "evidence-incomplete",
      "lookup-unavailable",
      "provider-outcome-unknown",
    ]),
  }),
]);
const evidenceCommon = {
  schemaVersion: version,
  target,
  bindingVersion: version,
  evidenceVersion: counter,
};
const runtimeEvidence = object({
  ...evidenceCommon,
  kind: Type.Literal("runtime"),
  observationRef: ref,
  providerObservedAt: timestamp,
  receivedAt: timestamp,
  validUntil: timestamp,
  uncertaintyMs: Type.Integer({ minimum: 0, maximum: 2_000 }),
  binding: RuntimeBindingSchemaV1,
  outcome: evidenceResult,
  // Old policy/readiness sources cannot be freshened by a newer envelope timestamp.
  policyObservedAt: timestamp,
  readinessObservedAt: timestamp,
});
const identityEvidence = object({
  ...evidenceCommon,
  kind: Type.Literal("identity"),
  verifierEvidenceRef: ref,
  registrationId: ref,
  registrationVersion: counter,
  identityProfileRef: ref,
  verifiedAt: timestamp,
  receivedAt: timestamp,
  expiresAt: timestamp,
  uncertaintyMs: Type.Integer({ minimum: 0, maximum: 2_000 }),
  outcome: Type.Union([
    object({ result: Type.Literal("verified"), reasonCode: Type.Literal("peer-verified") }),
    object({ result: Type.Literal("rejected"), reasonCode: enumeration(negativeReasons) }),
    object({
      result: Type.Literal("unknown"),
      reasonCode: enumeration(["evidence-incomplete", "lookup-unavailable"]),
    }),
  ]),
});
export const RuntimeEvidenceSchemaV1 = Type.Union([runtimeEvidence, identityEvidence]);
export type RuntimeEvidenceV1 = Static<typeof RuntimeEvidenceSchemaV1>;

const mutationCommon = {
  schemaVersion: version,
  operationRef: uuid,
  requestRef: ref,
  target,
  expectedLifecycleGeneration: counter,
  expectedAssignmentRecordVersion: counter,
};
export const BindRuntimeSchemaV1 = object({
  ...mutationCommon,
  kind: Type.Literal("bind"),
  binding: RuntimeBindingSchemaV1,
  expectedBindingVersion: Type.Union([Type.Null(), version]),
  observation: object({
    observationRef: ref,
    ownerChainEvidenceRef: ref,
    createEffectCorrelationRef: ref,
    instanceEvidenceRef: ref,
    ...observedClock,
  }),
  // Retained current preparation responsibility, independently checked by OCC.
  responsibilityRef: uuid,
  expectedResponsibilityVersion: counter,
});
export type BindRuntimeV1 = Static<typeof BindRuntimeSchemaV1>;
export const RuntimeEvidenceInputSchemaV1 = object({
  ...mutationCommon,
  kind: Type.Literal("record-evidence"),
  evidence: RuntimeEvidenceSchemaV1,
  expectedEvidenceVersion: Type.Union([Type.Null(), counter]),
});
export type RuntimeEvidenceInputV1 = Static<typeof RuntimeEvidenceInputSchemaV1>;
const cleanupOperation = enumeration([
  "cancel-execution",
  "remove-route",
  "terminate-instance",
  "retire-registration",
  "remove-provider-object",
]);
export const RetireAssignmentSchemaV1 = object({
  ...mutationCommon,
  kind: Type.Literal("retire"),
  bindingVersion: Type.Union([Type.Null(), version]),
  expectedCurrentSelection: Type.Union([
    Type.Null(),
    object({ assignmentRef, selectionVersion: counter }),
  ]),
  responsibilityRef: uuid,
  expectedResponsibilityVersion: counter,
  reasonCode: enumeration([
    "agent-disabled",
    "agent-stopped",
    "assignment-replaced",
    "binding-mismatch",
    "operation-denied",
  ]),
});
export type RetireAssignmentV1 = Static<typeof RetireAssignmentSchemaV1>;
export const RuntimeMutationSchemaV1 = Type.Union([
  BindRuntimeSchemaV1,
  RuntimeEvidenceInputSchemaV1,
  RetireAssignmentSchemaV1,
]);
export type RuntimeMutationV1 = Static<typeof RuntimeMutationSchemaV1>;

const resolveBase = { schemaVersion: version, ...scope, assignmentRef, requestRef: ref };
const operationRequest = { operationRef: uuid, expectedResponsibilityVersion: counter };
const servingPurpose = enumeration(["runtime-peer", "model-call", "repository-issuance"]);
const restoreOperation = enumeration(["importCompletedContext", "readImportedContext"]);
export const ResolveAssignmentRequestSchemaV1 = Type.Union([
  object({ ...resolveBase, purpose: servingPurpose }),
  object({ ...resolveBase, ...operationRequest, purpose: Type.Literal("identity-registration") }),
  object({ ...resolveBase, ...operationRequest, purpose: Type.Literal("readiness-probe") }),
  object({
    ...resolveBase,
    ...operationRequest,
    purpose: Type.Literal("cleanup"),
    requestedOperation: cleanupOperation,
  }),
  object({
    ...resolveBase,
    ...operationRequest,
    purpose: Type.Literal("completed-context-restore"),
    purposeContract: Type.Literal("completed-context-restore-v1"),
    requestedSuboperation: restoreOperation,
  }),
]);
export type ResolveAssignmentRequestV1 = Static<typeof ResolveAssignmentRequestSchemaV1>;

const boundSnapshot = object({
  target,
  binding: RuntimeBindingSchemaV1,
  assignmentRecordVersion: counter,
  ...profiles,
  profileDigests,
});
const sourceEvidence = object({
  reference: ref,
  version: counter,
  ...observedClock,
});
const registrationEvidence = object({
  registrationId: ref,
  registrationVersion: counter,
  bundleSetVersion: counter,
  identityProfileRef: ref,
  evidence: sourceEvidence,
});
const positiveBase = {
  schemaVersion: version,
  evaluatedAt: timestamp,
  validUntil: timestamp,
  requestRef: ref,
};
const purposeVersions = {
  snapshot: boundSnapshot,
  runtimeEvidence: sourceEvidence,
  policyEvidence: sourceEvidence,
};
const responsibility = {
  operationRef: uuid,
  responsibilityVersion: counter,
};
const restoreBinding = object({
  ...scope,
  conversationRef: ref,
  preparationRef: uuid,
  restoreRef: uuid,
  responsibilityVersion: counter,
  lifecycleGeneration: counter,
  gatewayAssignmentRef: assignmentRef,
  harnessAssignmentRef: assignmentRef,
  gatewayBindingVersion: version,
  harnessBindingVersion: version,
  pairingRecordRef: ref,
  pairingRecordVersion: counter,
  checkpointId: ref,
  checkpointHeadVersion: counter,
  completionSequence: counter,
  contextDigest: digest,
  gatewayStoreBindingRef: ref,
  workspaceStoreBindingRef: ref,
  admittedRevisionRef: RevisionId,
  admittedConfigurationDigest: digest,
  producerTupleRef: ref,
  currentPolicyEvidenceRef: ref,
  restoreFenceEpoch: counter,
  nativeEffectRef: uuid,
});
export const ResolveAssignmentResultSchemaV1 = Type.Union([
  object({
    ...positiveBase,
    result: Type.Literal("current"),
    purpose: servingPurpose,
    reasonCode: Type.Literal("conditions-satisfied"),
    ...purposeVersions,
    lifecycleGeneration: counter,
    selectionVersion: counter,
    identityEvidence: registrationEvidence,
    servingEvidence: sourceEvidence,
    mutationEligibilityEvidence: sourceEvidence,
  }),
  object({
    ...positiveBase,
    result: Type.Literal("candidate-eligible"),
    purpose: Type.Literal("identity-registration"),
    reasonCode: Type.Literal("registration-allowed"),
    ...purposeVersions,
    ...responsibility,
    allowedOperation: enumeration(["register", "maintain-registration"]),
    registrationTemplateRef: ref,
    parentBindingRef: ref,
    selectorEvidenceRef: ref,
  }),
  object({
    ...positiveBase,
    result: Type.Literal("candidate-eligible"),
    purpose: Type.Literal("readiness-probe"),
    reasonCode: Type.Literal("probe-allowed"),
    ...purposeVersions,
    ...responsibility,
    allowedOperation: Type.Literal("readiness-probe"),
    peerPairingRef: ref,
    peerPairingVersion: counter,
    permittedEndpointRef: ref,
    peer: boundSnapshot,
    identityEvidence: registrationEvidence,
    peerIdentityEvidence: registrationEvidence,
  }),
  object({
    ...positiveBase,
    result: Type.Literal("candidate-eligible"),
    purpose: Type.Literal("completed-context-restore"),
    reasonCode: Type.Literal("restore-operation-eligible"),
    purposeContract: Type.Literal("completed-context-restore-v1"),
    allowedSuboperation: restoreOperation,
    binding: restoreBinding,
    // Protected references resolve full checkpoint, store UID/subpath, tuple and peer evidence.
    currentPolicyEvidence: sourceEvidence,
    pairingEvidence: sourceEvidence,
  }),
  object({
    ...positiveBase,
    result: Type.Literal("cleanup-eligible"),
    purpose: Type.Literal("cleanup"),
    reasonCode: Type.Literal("cleanup-allowed"),
    ...responsibility,
    snapshot: boundSnapshot,
    allowedOperation: cleanupOperation,
    successorExclusionEvidence: sourceEvidence,
    effectPreconditionEvidence: sourceEvidence,
    // Neither target liveness/SVID nor original-human grants are cleanup prerequisites.
    cleanupPolicyEvidence: sourceEvidence,
  }),
  object({
    ...positiveBase,
    result: Type.Literal("cleanup-eligible"),
    purpose: Type.Literal("cleanup"),
    reasonCode: Type.Literal("cleanup-allowed"),
    ...responsibility,
    targetKind: Type.Literal("owned-provider-object"),
    target,
    assignmentRecordVersion: counter,
    ...profiles,
    profileDigests,
    providerObject: Type.Union([
      object({
        provider: Type.Literal("occ/kubernetes-gvisor"),
        component: Type.Literal("harness"),
        clusterRef: ref,
        kubernetesNamespaceUid: ref,
        deploymentUid: ref,
      }),
      object({
        provider: Type.Literal("occ/kubernetes-gateway"),
        component: Type.Literal("gateway"),
        clusterRef: ref,
        kubernetesNamespaceUid: ref,
        deploymentUid: ref,
      }),
    ]),
    // A known owned object may need teardown before any Pod or execution binding exists.
    // This evidence proves exact retained create-effect correlation; names/labels cannot.
    ownershipEvidence: sourceEvidence,
    allowedOperation: Type.Literal("remove-provider-object"),
    successorExclusionEvidence: sourceEvidence,
    effectPreconditionEvidence: sourceEvidence,
    cleanupPolicyEvidence: sourceEvidence,
  }),
  object({
    schemaVersion: version,
    result: Type.Literal("pending"),
    purpose: enumeration(RUNTIME_AUTHORITY_PURPOSES_V1),
    reasonCode: Type.Literal("evidence-incomplete"),
    evaluatedAt: timestamp,
    requestRef: ref,
  }),
  object({
    schemaVersion: version,
    result: Type.Literal("not-current"),
    purpose: enumeration(RUNTIME_AUTHORITY_PURPOSES_V1),
    reasonCode: enumeration(negativeReasons),
    evaluatedAt: timestamp,
    requestRef: ref,
  }),
  object({
    schemaVersion: version,
    result: Type.Literal("not-visible"),
    reasonCode: Type.Literal("scope-hidden"),
    evaluatedAt: timestamp,
    requestRef: ref,
  }),
  object({
    schemaVersion: version,
    result: Type.Literal("unavailable"),
    reasonCode: Type.Literal("lookup-unavailable"),
    evaluatedAt: timestamp,
    requestRef: ref,
  }),
]);
export type ResolveAssignmentResultV1 = Static<typeof ResolveAssignmentResultSchemaV1>;

const operationKey = {
  schemaVersion: version,
  ...scope,
  operationRef: uuid,
  operationKind: enumeration(["bind", "record-evidence", "retire"]),
  canonicalPayloadDigest: digest,
};
export const ExactAuthorityOperationSchemaV1 = object({ ...operationKey, requestRef: ref });
export type ExactAuthorityOperationV1 = Static<typeof ExactAuthorityOperationSchemaV1>;
const committedReceipt = object({
  ...operationKey,
  assignmentRef,
  acceptedServiceIdentityRef: ref,
  committedAt: timestamp,
  assignmentRecordVersion: counter,
  outcome: Type.Union([
    object({ kind: Type.Literal("bind"), binding: RuntimeBindingSchemaV1 }),
    object({ kind: Type.Literal("record-evidence"), evidence: RuntimeEvidenceSchemaV1 }),
    object({
      kind: Type.Literal("retire"),
      authority: Type.Literal("retired"),
      responsibilityRef: uuid,
      responsibilityVersion: counter,
      // Authority withdrawal is distinct from physical termination/provider token outcomes.
      termination: Type.Literal("not-asserted"),
      providerCredentialRevocation: Type.Literal("not-asserted"),
    }),
  ]),
});
const mutationResult = Type.Union([
  object({ schemaVersion: version, result: Type.Literal("applied"), receipt: committedReceipt }),
  object({
    schemaVersion: version,
    result: Type.Literal("exact-replay"),
    receipt: committedReceipt,
  }),
  object({
    schemaVersion: version,
    result: Type.Literal("rejected-before-effect"),
    reasonCode: enumeration(["scope-hidden", "lookup-unavailable", ...negativeReasons]),
  }),
  object({
    schemaVersion: version,
    result: Type.Literal("conflict"),
    reasonCode: enumeration([
      "operation-payload-mismatch",
      "generation-mismatch",
      "record-version-mismatch",
      "binding-mismatch",
    ]),
  }),
  object({
    schemaVersion: version,
    result: Type.Literal("commit-unknown"),
    operation: ExactAuthorityOperationSchemaV1,
    nextAction: Type.Literal("exact-readback-only"),
  }),
]);
export const RuntimeMutationResultSchemaV1 = mutationResult;
export type RuntimeMutationResultV1 = Static<typeof mutationResult>;
type ReceiptV1 = Static<typeof committedReceipt>;
type ResultFor<K extends ReceiptV1["operationKind"]> =
  | Exclude<RuntimeMutationResultV1, { receipt: unknown } | { result: "commit-unknown" }>
  | {
      readonly schemaVersion: 1;
      readonly result: "commit-unknown";
      readonly operation: Omit<ExactAuthorityOperationV1, "operationKind"> & {
        readonly operationKind: K;
      };
      readonly nextAction: "exact-readback-only";
    }
  | {
      readonly schemaVersion: 1;
      readonly result: "applied" | "exact-replay";
      readonly receipt: Omit<ReceiptV1, "operationKind" | "outcome"> & {
        readonly operationKind: K;
        readonly outcome: Extract<ReceiptV1["outcome"], { kind: K }>;
      };
    };
export type BindingResultV1 = ResultFor<"bind">;
export type EvidenceResultV1 = ResultFor<"record-evidence">;
export type RetirementResultV1 = ResultFor<"retire">;
export const AuthorityOperationStateSchemaV1 = Type.Union([
  object({ schemaVersion: version, result: Type.Literal("committed"), receipt: committedReceipt }),
  object({
    schemaVersion: version,
    result: Type.Literal("not-found"),
    nextAction: Type.Literal("exact-readback-only"),
  }),
  object({
    schemaVersion: version,
    result: Type.Literal("unavailable"),
    nextAction: Type.Literal("exact-readback-only"),
  }),
  object({
    schemaVersion: version,
    result: Type.Literal("not-visible"),
    reasonCode: Type.Literal("scope-hidden"),
  }),
  object({
    schemaVersion: version,
    result: Type.Literal("conflict"),
    reasonCode: Type.Literal("operation-payload-mismatch"),
  }),
]);
export type AuthorityOperationStateV1 = Static<typeof AuthorityOperationStateSchemaV1>;

export const RuntimeServiceTrustConfigurationSchemaV1 = object({
  schemaVersion: version,
  installationId: InstallationId,
  configurationVersion: counter,
  serviceIdentityRef: ref,
  serviceTrustProfileRef: ref,
  serviceTrustProfileDigest: digest,
  trustRootsRef: ref,
  verifierProfileRef: ref,
  permittedRecipientRef: ref,
  role: enumeration(RUNTIME_AUTHORITY_SERVICE_ROLES_V1),
  // Exact existing registry grants; no wildcard role or client-supplied principal.
  allowedScope: Type.Union([
    object({ kind: Type.Literal("installation"), installationId: InstallationId }),
    object({ kind: Type.Literal("agent"), ...scope }),
  ]),
});
export type RuntimeServiceTrustConfigurationV1 = Static<
  typeof RuntimeServiceTrustConfigurationSchemaV1
>;

declare const trustedRuntimeService: unique symbol;
declare const trustedRuntimeTransport: unique symbol;
/** Nominal prevention of accidental JSON use, not protection from malicious process code. */
export interface RuntimeAuthorityTrustedContextV1 {
  readonly [trustedRuntimeService]: true;
  readonly schemaVersion: 1;
}
export interface RuntimeAuthorityTransportBindingV1 {
  readonly [trustedRuntimeTransport]: true;
}
export interface RuntimeAuthorityVerifiedServiceV1 {
  readonly configuration: Readonly<RuntimeServiceTrustConfigurationV1>;
  readonly authenticatedAt: string;
  readonly expiresAt: string;
  readonly peerEvidenceRef: string;
  readonly transportBinding: RuntimeAuthorityTransportBindingV1;
}
/** Required dependency: supplied only by the selected actual transport-verification adapter.
 * No factory implementation or serializable context constructor is supplied here.
 * It authenticates an independent service, never requires the target Agent's SVID.
 * inspect must reject foreign, copied, expired, wrong-recipient and revoked handles;
 * a structural brand test alone is insufficient. The authority awaits it on every use
 * so a selected native adapter can recheck its live connection, bounded by call cancellation
 * and deadline, rather than returning a cached verification snapshot.
 */
export interface RuntimeAuthorityContextFactoryV1<Transport> {
  authenticate(
    transport: Transport,
    expected: Readonly<RuntimeServiceTrustConfigurationV1>,
    call: RuntimeAuthorityCallBoundsV1,
  ): Promise<RuntimeAuthorityTrustedContextV1>;
  inspect(
    context: RuntimeAuthorityTrustedContextV1,
    call: RuntimeAuthorityCallBoundsV1,
  ): Promise<Readonly<RuntimeAuthorityVerifiedServiceV1> | undefined>;
}
export interface RuntimeAuthorityCallBoundsV1 {
  readonly requestRef: string;
  readonly recipientRef: string;
  /** Absolute canonical UTC deadline. Provider applies its trusted monotonic clock too;
   * resolve must finish within min(remaining deadline, 3 seconds). Cancel/outage denies.
   */
  readonly deadline: string;
  readonly signal: AbortSignal;
}
export interface AuthorityCallV1 extends RuntimeAuthorityCallBoundsV1 {
  readonly context: RuntimeAuthorityTrustedContextV1;
}

/** OCC is the sole writer. New mutations require current exact lifecycle/record CAS.
 * Bind accepts only independently verified Compute observation under its exact preparation;
 * recordEvidence separates Compute and verifier roles, never creates a registration/selection.
 * Retirement withdraws authority and retains exact cleanup; it never proves physical stop.
 * Every same-ID retry first compares the full canonical payload against the retained receipt.
 * A historical exact replay/readback works after later heads or worker completion, with current
 * exact read scope and original authenticated service identity (or accepted cleanup ownership).
 * It confers no new effects/currentness. A mismatch conflicts, unknown permits exact readback
 * only, and neither unavailable nor not-found establishes that a prior effect cannot commit.
 * Implementations must roll back the whole admission unit even if a caller catches failure.
 * resolve is an evaluation-time observation, never a capability or positive cache. Each
 * privileged accepting operation rechecks under its real guard; active use rechecks at most
 * every 5 seconds and obeys any stricter policy. Future source times/clock uncertainty beyond
 * 2 seconds, age beyond 15 seconds, unknown required profiles/capabilities and unavailable
 * dependencies deny. Original source times survive every projection and receipt refresh.
 *
 * identity-registration requires an independent registrar and current running preparation
 * or exact active registration-maintenance responsibility, but no target SVID bootstrap loop.
 * readiness-probe requires current bound candidates and exact server-resolved peer/endpoint
 * proof, never active selection or serving; it permits no context/model/tool operation.
 * runtime-peer/model-call/repository-issuance require current running matching allocation,
 * active exact selection, verified component/caller/peer, fresh runtime/identity/policy and
 * observed serving plus mutation eligibility. Current human/turn/resource policy is separate.
 * cleanup instead requires an independent cleanup identity, retained exact responsibility,
 * immutable old UID/effect ownership, successor exclusion and its own fresh effect conditions.
 * It may survive stop/retirement/original actor revoke and target expiry, never creates,
 * resumes, purges or changes a successor. All unknown/forbidden scopes are non-disclosing.
 * completed-context-restore requires its exact current running responsibility, immutable
 * completed checkpoint/head/stores/configuration/tuple/pair and fresh service/context/store
 * policy. Both candidates are identity-ready, or the retained peer is current and quiesced.
 * Only guarded quiet import/readback qualifies; no serving/active selection prerequisite for
 * candidates, no historical grant replay. Revoke denies later import AND readback. Unknown
 * insertion retains exclusive ownership until actual containment/join; receipts cannot reopen
 * it. In direct gVisor, every writable successor (including init/restore/repair) first requires
 * actual predecessor termination and resolved possible creates; a generic fence is insufficient.
 */
export interface RuntimeAssignmentAuthorityV1 {
  bind(input: BindRuntimeV1, call: AuthorityCallV1): Promise<BindingResultV1>;
  recordEvidence(input: RuntimeEvidenceInputV1, call: AuthorityCallV1): Promise<EvidenceResultV1>;
  resolve(
    input: ResolveAssignmentRequestV1,
    call: AuthorityCallV1,
  ): Promise<ResolveAssignmentResultV1>;
  retire(input: RetireAssignmentV1, call: AuthorityCallV1): Promise<RetirementResultV1>;
  readOperation(
    input: ExactAuthorityOperationV1,
    call: AuthorityCallV1,
  ): Promise<AuthorityOperationStateV1>;
}

export const RuntimeAuthoritySchemasV1 = Object.freeze({
  assignmentRecord: RuntimeAssignmentRecordSchemaV1,
  binding: RuntimeBindingSchemaV1,
  evidence: RuntimeEvidenceSchemaV1,
  bind: BindRuntimeSchemaV1,
  recordEvidence: RuntimeEvidenceInputSchemaV1,
  retire: RetireAssignmentSchemaV1,
  mutation: RuntimeMutationSchemaV1,
  resolveRequest: ResolveAssignmentRequestSchemaV1,
  resolveResult: ResolveAssignmentResultSchemaV1,
  mutationResult: RuntimeMutationResultSchemaV1,
  exactOperation: ExactAuthorityOperationSchemaV1,
  operationState: AuthorityOperationStateSchemaV1,
  serviceTrust: RuntimeServiceTrustConfigurationSchemaV1,
});
export type RuntimeAuthoritySchemaNameV1 = keyof typeof RuntimeAuthoritySchemasV1;
export type RuntimeAuthorityValueV1<K extends RuntimeAuthoritySchemaNameV1> = Static<
  (typeof RuntimeAuthoritySchemasV1)[K]
>;

function reject(): never {
  throw new Error("Invalid runtime authority V1 value.");
}

/** Snapshot only plain, bounded JSON data; never invoke getters or toJSON hooks. */
function data(input: unknown, depth = 0, budget = { remaining: 65_536 }): unknown {
  if (depth > 32 || --budget.remaining < 0) reject();
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) reject();
    return input;
  }
  if (typeof input === "string") {
    if (/[\ud800-\udfff]/u.test(input)) reject();
    budget.remaining -= new TextEncoder().encode(input).byteLength;
    if (budget.remaining < 0) reject();
    return input;
  }
  if (typeof input !== "object") reject();
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype || input.length > 1024) reject();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== input.length + 1) reject();
    return Array.from({ length: input.length }, (_, index) => {
      const d = Object.getOwnPropertyDescriptor(input, String(index));
      if (!d || !("value" in d) || !d.enumerable) reject();
      return data(d.value, depth + 1, budget);
    });
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) reject();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key))
      reject();
    data(key, depth + 1, budget);
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d || !("value" in d) || !d.enumerable) reject();
    result[key] = data(d.value, depth + 1, budget);
  }
  return result;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Additional intrinsic invariants. Freshness/provenance need the actual authority clock/store. */
function intrinsic(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  if (Array.isArray(input)) {
    for (const value of input) intrinsic(value);
    return;
  }
  const v = input as Record<string, unknown>;
  for (const [key, value] of Object.entries(v)) {
    if (typeof value === "string" && /(?:At|Until)$/.test(key)) {
      const time = Date.parse(value);
      if (!Number.isFinite(time) || new Date(time).toISOString() !== value) reject();
    }
    intrinsic(value);
  }
  const time = (key: string) => (typeof v[key] === "string" ? Date.parse(v[key]) : undefined);
  const source = time("providerObservedAt") ?? time("verifiedAt") ?? time("sourceObservedAt");
  const received = time("receivedAt");
  const valid = time("validUntil") ?? time("expiresAt");
  const evaluated = time("evaluatedAt");
  if (source !== undefined && received !== undefined && source > received + 2_000) reject();
  if (source !== undefined && valid !== undefined && valid < source) reject();
  if (source !== undefined && valid !== undefined && valid > source + 15_000) reject();
  if (
    evaluated !== undefined &&
    valid !== undefined &&
    (valid < evaluated || valid > evaluated + 15_000)
  )
    reject();
  for (const field of ["policyObservedAt", "readinessObservedAt"]) {
    const observed = time(field);
    if (
      observed !== undefined &&
      source !== undefined &&
      (observed > source + 2_000 || (valid !== undefined && valid > observed + 15_000))
    )
      reject();
  }
  if (Array.isArray(v.imageDigests)) {
    const names = v.imageDigests.map((entry: { name: string }) => entry.name);
    if (new Set(names).size !== names.length) reject();
    if (names.some((name, index) => index > 0 && names[index - 1]! >= name)) reject();
  }
  if (v.target && typeof v.target === "object") {
    const t = v.target as Record<string, unknown>;
    if (v.binding && (v.binding as Record<string, unknown>).component !== t.component) reject();
    if (v.providerObject && (v.providerObject as Record<string, unknown>).component !== t.component)
      reject();
    if (v.kind === "bind" && v.expectedLifecycleGeneration !== t.lifecycleGeneration) reject();
    if (v.evidence && canonical((v.evidence as Record<string, unknown>).target) !== canonical(t))
      reject();
  }
  if (
    v.operationKind &&
    v.outcome &&
    (v.outcome as Record<string, unknown>).kind !== v.operationKind
  )
    reject();
  if (v.operationKind === "record-evidence" && v.outcome) {
    const outcome = v.outcome as { evidence: { target: Record<string, unknown> } };
    const evidenceTarget = outcome.evidence.target;
    for (const field of ["installationId", "namespaceId", "agentId", "assignmentRef"]) {
      if (canonical(v[field]) !== canonical(evidenceTarget[field])) reject();
    }
  }
  // A committed receipt outcome has the same kind but carries no request CAS fields.
  if (v.kind === "record-evidence" && Object.hasOwn(v, "expectedEvidenceVersion")) {
    const e = v.evidence as Record<string, unknown>;
    const expected = v.expectedEvidenceVersion;
    if (e.evidenceVersion !== (expected === null ? 1 : Number(expected) + 1)) reject();
  }
  if (v.purpose === "model-call" && v.result === "current") {
    const snapshot = v.snapshot as { target: { component: string } };
    if (snapshot.target.component !== "harness") reject();
  }
  if (v.result === "current") {
    const snapshot = v.snapshot as { target: { lifecycleGeneration: number } };
    if (snapshot.target.lifecycleGeneration !== v.lifecycleGeneration) reject();
  }
  if (
    v.binding &&
    v.profileDigests &&
    canonical(v.profileDigests) !== canonical((v.binding as Record<string, unknown>).profileDigests)
  )
    reject();
  if (evaluated !== undefined && valid !== undefined) {
    const checkEvidence = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.sourceObservedAt !== undefined) {
        const observed = Date.parse(record.sourceObservedAt as string);
        const expiry = Date.parse(record.validUntil as string);
        if (observed > evaluated + 2_000 || evaluated - observed > 15_000 || valid > expiry)
          reject();
      }
      for (const child of Object.values(record)) checkEvidence(child);
    };
    checkEvidence(v);
  }
  if (
    v.gatewayAssignmentRef &&
    canonical(v.gatewayAssignmentRef) === canonical(v.harnessAssignmentRef)
  )
    reject();
  if (
    v.configurationVersion &&
    v.allowedScope &&
    (v.allowedScope as Record<string, unknown>).installationId !== v.installationId
  )
    reject();
  if (v.allocation && v.authority && v.binding) {
    const a = v.allocation as { component: string };
    const b = v.binding as { status: string; instance?: { component: string } };
    const state = (v.authority as { state: string }).state;
    if (b.instance && b.instance.component !== a.component) reject();
    if (
      b.status === "unbound" &&
      !["allocated", "abandoned", "retiring", "retired"].includes(state)
    )
      reject();
    if (b.status === "bound" && ["allocated", "abandoned"].includes(state)) reject();
  }
}

function canonical(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
  return `{${Object.entries(input)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
    .join(",")}}`;
}

export function parseRuntimeAuthorityV1<K extends RuntimeAuthoritySchemaNameV1>(
  kind: K,
  input: unknown,
): RuntimeAuthorityValueV1<K> {
  try {
    if (!Object.hasOwn(RuntimeAuthoritySchemasV1, kind)) reject();
    const snapshot = data(input);
    if (!Check(RuntimeAuthoritySchemasV1[kind] as TSchema, snapshot)) reject();
    intrinsic(snapshot);
    return freeze(snapshot) as RuntimeAuthorityValueV1<K>;
  } catch {
    return reject();
  }
}

/** Bounded JSON scanner preserves duplicate-key detection, including escaped duplicate names. */
function json(input: string): unknown {
  if (
    typeof input !== "string" ||
    input.length > 65_536 ||
    new TextEncoder().encode(input).byteLength > 65_536
  )
    reject();
  let at = 0;
  const ws = () => {
    while (/[\x20\x09\x0a\x0d]/.test(input[at] ?? "!")) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < input.length) {
      const character = input[at++];
      if (character === "\\") {
        at++;
        continue;
      }
      if (character === '"') return JSON.parse(input.slice(start, at));
    }
    return reject();
  };
  const value = (depth: number): unknown => {
    if (depth > 32) reject();
    ws();
    if (input[at] === '"') return string();
    if (input[at] === "{") {
      at++;
      ws();
      const result: Record<string, unknown> = Object.create(null);
      if (input[at] === "}") {
        at++;
        return result;
      }
      for (;;) {
        ws();
        if (input[at] !== '"') reject();
        const key = string();
        if (Object.hasOwn(result, key)) reject();
        ws();
        if (input[at++] !== ":") reject();
        result[key] = value(depth + 1);
        ws();
        const next = input[at++];
        if (next === "}") return result;
        if (next !== ",") reject();
      }
    }
    if (input[at] === "[") {
      at++;
      ws();
      const result: unknown[] = [];
      if (input[at] === "]") {
        at++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        ws();
        const next = input[at++];
        if (next === "]") return result;
        if (next !== ",") reject();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      input.slice(at),
    );
    if (!token) reject();
    at += token[0].length;
    const parsed: unknown = JSON.parse(token[0]);
    // JSON.parse rounds before schema validation. Counters must have exact canonical
    // decimal integer lexemes, so neither fractional rounding nor exponent aliases pass.
    if (
      typeof parsed === "number" &&
      (!/^(?:0|[1-9][0-9]*)$/.test(token[0]) || !Number.isSafeInteger(parsed))
    )
      reject();
    return parsed;
  };
  const result = value(0);
  ws();
  if (at !== input.length) reject();
  return result;
}

export function parseRuntimeAuthorityJsonV1<K extends RuntimeAuthoritySchemaNameV1>(
  kind: K,
  input: string,
): RuntimeAuthorityValueV1<K> {
  try {
    return parseRuntimeAuthorityV1(kind, json(input));
  } catch {
    return reject();
  }
}

/** Method-specific decoding also rejects a well-formed receipt for another mutation method. */
export function parseRuntimeMutationResultV1<K extends ReceiptV1["operationKind"]>(
  method: K,
  input: unknown,
): ResultFor<K> {
  if (!["bind", "record-evidence", "retire"].includes(method)) reject();
  const result = parseRuntimeAuthorityV1("mutationResult", input);
  if ("receipt" in result && result.receipt.operationKind !== method) reject();
  if (result.result === "commit-unknown" && result.operation.operationKind !== method) reject();
  return result as ResultFor<K>;
}

/** The caller hashes these exact UTF-8 bytes with SHA-256 for retained operation identity.
 * Request correlation is deliberately excluded; operation ID, CAS and all effect data remain.
 * Equality assists replay comparison only; it never executes/retries or authorizes a mutation.
 */
export function canonicalRuntimeAuthorityMutationV1(input: RuntimeMutationV1): string {
  const { requestRef: _requestRef, ...payload } = parseRuntimeAuthorityV1("mutation", input);
  return canonical(payload);
}
