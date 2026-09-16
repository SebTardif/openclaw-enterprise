import { Type, type Static, type TProperties } from "typebox";
import { AgentId, InstallationId, NamespaceId, RevisionId } from "../api/common.ts";
import type { RuntimeAllocation, RuntimeIntent, RuntimeScope } from "../runtime-assignment.ts";

/** Limits for the initial execution-binding contract; validation does not establish trust. */
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

const observedClock = {
  sourceObservedAt: timestamp,
  receivedAt: timestamp,
  validUntil: timestamp,
  uncertaintyMs: Type.Integer({
    minimum: 0,
    maximum: RUNTIME_AUTHORITY_LIMITS_V1.clockUncertaintyMaxMs,
  }),
};
const image = object({ name: ref, digest });
// Binding: one exact provider instance, including its execution/restart identity.
const instanceCommon = {
  schemaVersion: version,
  bindingVersion: version,
  clusterRef: ref,
  kubernetesNamespaceUid: ref,
  podUid: ref,
  deploymentUid: ref,
  replicaSetUid: ref,
  imageDigests: Type.Array(image, {
    minItems: 1,
    maxItems: RUNTIME_AUTHORITY_LIMITS_V1.maxImageEntries,
  }),
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
/** No OpenShell fallback: a later provider requires its own closed admitted variant. */
export const RuntimeBindingSchemaV1 = gvisorBinding;
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
    state: enumeration(["allocated", "bound"]),
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

// Refusal reasons carried by the original acceptance and readback boundary.
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
// Initial binding uses exact expected allocation and responsibility versions.
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
  expectedBindingVersion: Type.Null(),
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
export const RuntimeMutationSchemaV1 = BindRuntimeSchemaV1;
export type RuntimeMutationV1 = Static<typeof RuntimeMutationSchemaV1>;

// Receipts: retained outcomes and exact operation locators for replay/readback.
const operationKey = {
  schemaVersion: version,
  ...scope,
  operationRef: uuid,
  operationKind: Type.Literal("bind"),
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
  outcome: object({ kind: Type.Literal("bind"), binding: RuntimeBindingSchemaV1 }),
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

export const RuntimeAuthoritySchemasV1 = Object.freeze({
  assignmentRecord: RuntimeAssignmentRecordSchemaV1,
  binding: RuntimeBindingSchemaV1,
  bind: BindRuntimeSchemaV1,
  mutation: RuntimeMutationSchemaV1,
  mutationResult: RuntimeMutationResultSchemaV1,
  exactOperation: ExactAuthorityOperationSchemaV1,
  operationState: AuthorityOperationStateSchemaV1,
});
export type RuntimeAuthoritySchemaNameV1 = keyof typeof RuntimeAuthoritySchemasV1;
export type RuntimeAuthorityValueV1<K extends RuntimeAuthoritySchemaNameV1> = Static<
  (typeof RuntimeAuthoritySchemasV1)[K]
>;
