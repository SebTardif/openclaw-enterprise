import type {
  AgentRevision,
  RootDeploymentInvocationV1,
  RootWorkIdentityV1,
  RootWorkPolicyV1,
} from "@openclaw-enterprise/contracts";
import type { PlatformUnitOfWork } from "../state/platform-state.ts";
import type {
  Bounds,
  CoreAuthenticationBinding,
  LocalHandle,
} from "../credential-gateway-v1/handles.ts";
import type {
  CredentialConnection,
  CredentialProfileRef,
  CredentialTarget,
} from "../credential-gateway-v1/connection.ts";
import type { SchemaRef } from "../credential-gateway-v1/schema.ts";

export interface RootDeploymentAdmissionV1 {
  readonly invocation: RootDeploymentInvocationV1;
  readonly revision: Readonly<AgentRevision>;
  readonly policy: RootWorkPolicyV1;
  readonly bounds: Bounds;
}

/** One-use evidence authenticated by the original selected-IAM implementation. */
export type IamAdmissionEvidence = LocalHandle<"iam-admission-evidence-v1">;
/** Original runtime-owned PR claim; its DATA identity cannot recreate this handle. */
export type OriginalPrCreationClaimV1 = LocalHandle<"pr-creation-claim-v1">;

export interface AuthorityBoundsV1 {
  readonly authorityDeadline: number;
  readonly requestDeadline: number;
  readonly requestedAllowance: number;
  readonly capacityUnits: number;
  readonly withdrawalProfile: {
    readonly profileId: string;
    readonly profileVersion: string;
    readonly maximumObservationLagMs: number;
    readonly maximumDecisionToSendMs: number;
    readonly maximumEnforcementDelayMs: number;
    readonly clockAllowanceMs: number;
  };
}

interface AuthorityBindingBaseV1 {
  /** Exact existing owner handle; the accompanying IDs/digests are not authority. */
  readonly authentication: CoreAuthenticationBinding;
  readonly root: Readonly<RootWorkIdentityV1>;
  readonly grantId: string;
  readonly leaseId: string;
  readonly operationId: string;
  readonly originalAttemptId: string;
  readonly inspectionReservationId: string;
  readonly inputDigest: string;
  readonly factsDigest: string;
  readonly bounds: AuthorityBoundsV1;
}

/** ROOT cancellation does not invent an external backend, receiver or PR claim. */
export interface RootAuthorityBindingV1 extends AuthorityBindingBaseV1 {
  readonly effect: "root-cancel";
  readonly requester: { readonly kind: "authenticated-canceller"; readonly principalId: string };
  readonly receiver: { readonly kind: "root-work"; readonly rootWorkId: string };
  readonly iam: {
    readonly action: "work.cancel";
    readonly resource: { readonly kind: "root-work"; readonly rootWorkId: string };
  };
}

interface ExternalAuthorityBindingBaseV1 extends AuthorityBindingBaseV1 {
  /** Immutable admitted backend/schema/connection and canonical authority/resource. */
  readonly connection: Pick<
    CredentialConnection,
    "connectionId" | "namespaceId" | "generation" | "definition" | "upstreamInstanceId"
  >;
  readonly target: CredentialTarget;
  readonly operationSchema: SchemaRef;
  readonly profile: CredentialProfileRef;
  readonly callerServiceId: string;
  readonly serviceId: string;
  readonly audienceRef: string;
  readonly iam: { readonly action: string; readonly canonicalResource: string };
}

export interface CredentialAuthorityBindingV1 extends ExternalAuthorityBindingBaseV1 {
  readonly effect: "credential";
  readonly operation: "acquire" | "exchange" | "refresh";
  readonly receiver: {
    readonly kind: "credential";
    readonly receiverId: string;
    readonly incarnation: string;
  };
}

export interface ResourceAuthorityBindingV1 extends ExternalAuthorityBindingBaseV1 {
  readonly effect: "resource";
  readonly receiver: {
    readonly kind: "resource";
    readonly receiverId: string;
    readonly incarnation: string;
  };
}

export interface PrAuthorityBindingV1 extends ExternalAuthorityBindingBaseV1 {
  readonly effect: "pr-create";
  readonly receiver: {
    readonly kind: "pr-create";
    readonly receiverId: string;
    readonly incarnation: string;
  };
  /** Required only at PR resource dispatch; credential admission cannot spend it. */
  readonly originalPrClaim: OriginalPrCreationClaimV1;
}

/** Small current effect families. Owners authenticate all operands and their equality. */
export type AuthorityBinding =
  | RootAuthorityBindingV1
  | CredentialAuthorityBindingV1
  | ResourceAuthorityBindingV1
  | PrAuthorityBindingV1;

// TODO(ROOT admission): original Work, selected IAM and State owners implement these
// bodies before genuine execution composition. These declarations issue no authority.
export interface RootWorkOwnerV1 {
  /**
   * Verify the authenticated requester and independently resolved locked-Agent service
   * owner, full immutable policy, execution/assignment, duration and cancellation.
   * Retain one service-owned root per execution in this real UoW. Output is DATA;
   * resolve no usable binding before known outer COMMIT. Unknown commit requires
   * exact original readback, never another root/attempt or authority reissue.
   */
  admitDeploymentIn(
    uow: PlatformUnitOfWork,
    input: RootDeploymentAdmissionV1,
  ): Promise<Readonly<RootWorkIdentityV1>>;
  /** Resolve genuine retained current authority; revision/configuration cannot mint it. */
  resolveForRevision(
    revision: Readonly<AgentRevision>,
    bounds: Bounds,
  ): Promise<CoreAuthenticationBinding | undefined>;
  /**
   * Independently authenticate work.cancel evidence and exact original root under
   * matching locks. Closure is monotonic and serialized against new admission;
   * caller abort or requester possession alone cannot authorize cancellation.
   * Retained finalization/withdrawal obligations remain available after closure.
   */
  cancelIn(uow: PlatformUnitOfWork, input: RootCancellationV1): Promise<void>;
}

export interface RootCancellationV1 {
  readonly authentication: CoreAuthenticationBinding;
  readonly cancellationBinding: RootAuthorityBindingV1;
  readonly evidence: IamAdmissionEvidence;
  readonly bounds: Bounds;
}

export interface WorkAdmissionOwner {
  /**
   * After State lock waits, authenticate original Core custody and exact retained
   * ownership/open root, immutable policy/ceilings/horizons, assignment/execution,
   * grant/lease and configuration. Join the caller's real UoW and lifetime; never
   * accept a recipe callback or derive currentness from copied identity DATA.
   */
  checkIn(uow: PlatformUnitOfWork, binding: AuthorityBinding): Promise<void>;
}

export interface SelectedIamAdmissionOwner {
  /**
   * Outside the admission transaction, authenticate the complete binding and capture
   * coherent original-owner policy/selection evidence with finite retention/expiry.
   * Ordinary IAMDriver.authorize plus a local TTL cannot establish this validity.
   */
  prepare(binding: AuthorityBinding, deadline: number): Promise<IamAdmissionEvidence>;
  /**
   * Authenticate/spend the original exact evidence once after lock waits, comparing
   * current policy epoch and durable selected-IAM generation under the matching
   * State fence/writer protocol through outer commit/rollback. Unsupported remote
   * observation/withdrawal semantics deny; no external calls inside this UoW.
   */
  consumeIn(
    uow: PlatformUnitOfWork,
    evidence: IamAdmissionEvidence,
    binding: AuthorityBinding,
  ): Promise<void>;
}
