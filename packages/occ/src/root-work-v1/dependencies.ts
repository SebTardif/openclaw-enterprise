/** ROOT Work component owner ports.
 * These contracts do not imply provider implementations or runtime qualification.
 * Imports bind ROOT contracts and the current recipe DefinitionRef.
 */
import type {
  Agent,
  AgentRevision,
  RootDeploymentInvocationV1,
  RootWorkIdentityV1,
  RootWorkPolicyV1,
  RuntimeAllocation,
} from "@openclaw-enterprise/contracts";
import type { PlatformStateStore, PlatformUnitOfWork } from "../state/platform-state.ts";
import type {
  Bounds,
  CoreAuthenticationBinding,
  LocalHandle,
} from "../credential-gateway-v1/handles.ts";
import type { DefinitionRef } from "../credential-gateway-v1/schema.ts";
import type {
  AuthorityBinding,
  RootWorkOwnerV1,
  WorkAdmissionOwner,
  SelectedIamAdmissionOwner,
} from "./ports.ts";

export type RootDeploymentPolicyEvidenceV1 = LocalHandle<"root-deployment-policy-evidence-v1">;
export type RootInvocationRecognitionV1 = LocalHandle<"root-invocation-recognition-v1">;

/** Original ingress owner alone issues/recognizes these; all public DATA remains inert. */
export interface AuthenticatedRootInvocationV1 {
  readonly recognition: RootInvocationRecognitionV1;
  readonly invocation: RootDeploymentInvocationV1;
  readonly installationId: string;
  readonly preparedPolicy: RootDeploymentPolicyEvidenceV1;
}
export interface RootInvocationOwnerV1 {
  consumeIn(
    uow: PlatformUnitOfWork,
    invocation: RootDeploymentInvocationV1,
    bounds: Bounds,
  ): Promise<Readonly<AuthenticatedRootInvocationV1>>;
}

/** Preparation uses an authenticated ingress handle; no root or Core is an operand. */
export interface RootDeploymentPolicyRequestV1 {
  readonly invocation: RootInvocationRecognitionV1;
  readonly invocationData: RootDeploymentInvocationV1;
  readonly installationId: string;
  readonly expectedServicePrincipalId: string;
  readonly expectedAgentConfigurationId: string;
  readonly fullPolicy: RootWorkPolicyV1;
  readonly bounds: Bounds;
}
export interface RootPolicyFenceV1 {
  readonly installationId: string;
  readonly selectedIam: RootWorkIdentityV1["selectedIam"];
  readonly policyEpoch: string;
  readonly servicePrincipalId: string;
  readonly servicePolicyId: string;
  readonly servicePolicyVersion: string;
  readonly policyVersion: string;
  readonly immutableCeilingDigest: string;
  readonly validUntil: number;
}
export interface RootSelectedIamFenceV1 {
  readonly installationId: string;
  readonly selectedIam: RootWorkIdentityV1["selectedIam"];
  readonly policyEpoch: string;
}
export interface RootDeploymentPolicyOwnerV1 {
  /** Acquire shared policy fence BEFORE runtime/ROOT row locks; held until outer completion. */
  lockSelectionIn(
    uow: PlatformUnitOfWork,
    installationId: string,
    bounds: Bounds,
  ): Promise<Readonly<RootSelectedIamFenceV1>>;
  /** Before controller.transact; original IAM independently checks requester AND service. */
  prepare(input: RootDeploymentPolicyRequestV1): Promise<RootDeploymentPolicyEvidenceV1>;
  /** Original evidence only; one use; shared Installation fence retained through outer commit. */
  consumePreparedIn(
    uow: PlatformUnitOfWork,
    evidence: RootDeploymentPolicyEvidenceV1,
    invocation: Readonly<AuthenticatedRootInvocationV1>,
    lockedAgent: Readonly<Agent>,
    expectedFullPolicy: RootWorkPolicyV1,
    bounds: Bounds,
  ): Promise<Readonly<RootPolicyFenceV1>>;
  /** Internal currentness participant. No Core required to break the initial mint cycle. */
  checkRetainedIn(
    uow: PlatformUnitOfWork,
    identity: Readonly<RootWorkIdentityV1>,
    fullPolicy: RootWorkPolicyV1,
    bounds: Bounds,
  ): Promise<Readonly<RootPolicyFenceV1>>;
}

/** Producer-owned execution identity. Work MUST NOT derive executionId from revisionId.
 * allocation is the actual original retained RuntimeAllocation, including numeric generations.
 * assignmentGeneration is its owner's explicit opaque-string projection, compared exactly.
 */
export interface RootExecutionBindingV1 {
  readonly allocation: Readonly<RuntimeAllocation>;
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly agentRevisionId: string;
  readonly executionId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: string;
  readonly servicePrincipalId: string;
  readonly selectedIam: RootWorkIdentityV1["selectedIam"];
}
export interface RootAssignmentOwnerV1 {
  /** Original runtime/assignment owner recognizes active current execution under the same locks. */
  currentForRevisionIn(
    uow: PlatformUnitOfWork,
    lockedAgent: Readonly<Agent>,
    revision: Readonly<AgentRevision>,
    bounds: Bounds,
  ): Promise<Readonly<RootExecutionBindingV1> | undefined>;
}

export interface RetainedRootRecordV1 {
  readonly identity: Readonly<RootWorkIdentityV1>;
  readonly canonicalIdentity: string;
  readonly identityDigest: string;
  readonly fullPolicy: RootWorkPolicyV1;
  readonly originalInvocationId: string;
  readonly originalIntentDigest: string;
  readonly assignment: Readonly<RootExecutionBindingV1>;
  readonly state: "open" | "closed";
  readonly closureVersion: string;
  readonly cancellationAuthorizationId: string | null;
  readonly closedAt: number | null;
  /** Original cleanup owners retain their records; these refs never grant new work. */
  readonly retainedObligationRefs: readonly string[];
}
export interface RootRetentionInputV1 {
  readonly identity: Readonly<RootWorkIdentityV1>;
  readonly canonicalIdentity: string;
  readonly identityDigest: string;
  readonly fullPolicy: RootWorkPolicyV1;
  readonly originalInvocationId: string;
  readonly originalIntentDigest: string;
  readonly expectedAssignment: Readonly<RootExecutionBindingV1>;
}
export interface RootLookupV1 {
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly agentRevisionId: string;
  readonly executionId: string;
  readonly rootWorkId: string;
}
export interface RootClosureInputV1 {
  readonly root: RootLookupV1;
  readonly expectedClosureVersion: string;
  readonly cancellationAuthorizationId: string;
  readonly closedAt: number;
}
/** The State adapter joins ORIGINAL PlatformUnitOfWork through existing State recognition.
 * Returned records are DATA. Caller must hold relevant locks until outer completion.
 * A retain result never certifies commit; only successful PlatformStateStore.transact does.
 */
export interface RootWorkStateV1 {
  retainDeploymentIn(
    uow: PlatformUnitOfWork,
    input: RootRetentionInputV1,
    bounds: Bounds,
  ): Promise<Readonly<RetainedRootRecordV1>>;
  lockForExecutionIn(
    uow: PlatformUnitOfWork,
    assignment: Readonly<RootExecutionBindingV1>,
    bounds: Bounds,
  ): Promise<Readonly<RetainedRootRecordV1> | undefined>;
  lockForCurrentIn(
    uow: PlatformUnitOfWork,
    root: RootLookupV1,
    bounds: Bounds,
  ): Promise<Readonly<RetainedRootRecordV1> | undefined>;
  closeIn(
    uow: PlatformUnitOfWork,
    input: RootClosureInputV1,
    bounds: Bounds,
  ): Promise<Readonly<RetainedRootRecordV1>>;
  /** Fresh database transaction, exact original key+intent, never an authority reissue. */
  readOriginal(
    input: Pick<RootRetentionInputV1, "identity" | "originalInvocationId" | "originalIntentDigest">,
    bounds: Bounds,
  ): Promise<RootOriginalReadbackV1>;
}
export type RootOriginalReadbackV1 =
  | { readonly outcome: "committed"; readonly record: Readonly<RetainedRootRecordV1> }
  | { readonly outcome: "not-committed" }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "unknown" };

export interface RootCoreFactsV1 {
  readonly identity: Readonly<RootWorkIdentityV1>;
  readonly fullPolicy: RootWorkPolicyV1;
  readonly closureVersion: string;
}
export interface RootCoreRecognitionV1 {
  /** Exact WeakMap object custody; no clone/proxy/JSON recognition, no public mint. */
  recognize(authentication: CoreAuthenticationBinding): Readonly<RootCoreFactsV1> | undefined;
}
/** Original grant/broker/cancellation owners retain independent expectations.
 * This field distributes over the effect union so all original operands and original PR handle
 * survive. authentication is deliberately absent: original correspondence is DATA, not a mint.
 */
export type OriginalEffectDataV1<B extends AuthorityBinding = AuthorityBinding> =
  B extends AuthorityBinding ? Readonly<Omit<B, "authentication">> : never;
export interface RootEffectLocatorV1 {
  readonly installationId: string;
  readonly rootWorkId: string;
  readonly effect: AuthorityBinding["effect"];
  readonly operationId: string;
  readonly originalAttemptId: string;
  readonly inspectionReservationId: string;
}
export interface OriginalRootEffectV1 {
  readonly binding: OriginalEffectDataV1;
  readonly state: "admitted" | "closed";
  readonly recordVersion: string;
  readonly originalBundle: DefinitionRef | null;
  readonly capacity: readonly {
    readonly limitName: string;
    readonly currentUnits: number;
    readonly requestedUnits: number;
  }[];
}
export interface RootEffectCorrespondenceOwnerV1 {
  /** Original request registry supplies finite bound AND abort signal; no caller reflection. */
  boundsFor(binding: AuthorityBinding): Bounds | undefined;
  /** Lookup by exact original operation key; MUST NOT reflect a candidate binding as approval. */
  readIn(
    uow: PlatformUnitOfWork,
    locator: RootEffectLocatorV1,
    bounds: Bounds,
  ): Promise<Readonly<OriginalRootEffectV1> | undefined>;
}

/** Trusted startup construction only. Called once after Work allocates its private registry;
 * solves factory dependency without accepting an allow callback, mutable global, or fake Core.
 * Unavailable/unsupported IAM refuses startup. Recipes cannot provide this factory.
 */
export interface RootSelectedIamFactoryV1 {
  createForRootOwner(recognition: RootCoreRecognitionV1): SelectedIamAdmissionOwner;
}
export interface RootWorkDependenciesV1 {
  readonly platformState: PlatformStateStore;
  readonly state: RootWorkStateV1;
  readonly invocation: RootInvocationOwnerV1;
  readonly deploymentPolicy: RootDeploymentPolicyOwnerV1;
  readonly assignment: RootAssignmentOwnerV1;
  readonly effects: RootEffectCorrespondenceOwnerV1;
  readonly selectedIam: RootSelectedIamFactoryV1;
  readonly clock: { now(): number };
  readonly identity: { nextRootWorkId(): string };
}
export interface RootWorkRuntimeV1 {
  readonly owner: RootWorkOwnerV1 & WorkAdmissionOwner;
  readonly recognition: RootCoreRecognitionV1;
  readonly selectedIam: SelectedIamAdmissionOwner;
}
/** Factory contract; implementation remains the ROOT Work component's responsibility. */
export declare function createRootWorkRuntimeV1(
  dependencies: RootWorkDependenciesV1,
): RootWorkRuntimeV1;

/** Kernel split: real resolve/check and custody; unavailable admit/cancel are NOT claimed. */
export type RootCurrentWorkOwnerV1 = Pick<RootWorkOwnerV1, "resolveForRevision"> &
  WorkAdmissionOwner;
export interface RootCurrentWorkRuntimeV1 {
  readonly owner: RootCurrentWorkOwnerV1;
  readonly recognition: RootCoreRecognitionV1;
}
export type RootCurrentWorkDependenciesV1 = Pick<
  RootWorkDependenciesV1,
  "platformState" | "state" | "deploymentPolicy" | "assignment" | "effects" | "clock"
>;
export declare function createRootCurrentWorkRuntimeV1(
  dependencies: RootCurrentWorkDependenciesV1,
): RootCurrentWorkRuntimeV1;
