import type {
  AgentRevision,
  RootWorkIdentityV1,
  RuntimeAuthenticationProjectionV1,
  RuntimeAuthenticationReceiverV1,
} from "@openclaw-enterprise/contracts";
import type { PlatformUnitOfWork } from "../state/platform-state.ts";
import type {
  Bounds,
  CoreAuthenticationBinding,
  LocalHandle,
} from "../credential-gateway-v1/handles.ts";
import type {
  CredentialProfileRef,
  ExternalRuntimeAuthenticationCapabilityV1,
} from "../credential-gateway-v1/connection.ts";

/**
 * Original Work/Core-owned session authority. The existing Core registry must
 * recognize it; neither its kind nor copied DATA authenticates an instance.
 */
export type RuntimeSessionAuthorityV1 = LocalHandle<"runtime-session-authority-v1">;

/**
 * Authenticated producer output for one immutable selected external session.
 * Original grant, lease and session operation identifiers/digest are retained;
 * these fields are not caller-supplied admission or attachment evidence.
 */
export interface RuntimeSessionAdmissionV1 {
  readonly authentication: CoreAuthenticationBinding;
  readonly root: Readonly<RootWorkIdentityV1>;
  readonly projection: RuntimeAuthenticationProjectionV1;
  readonly grantId: string;
  readonly leaseId: string;
  /** Original session operation, never a newly allocated provider attempt. */
  readonly operationId: string;
  readonly inputDigest: string;
  readonly capability: Readonly<ExternalRuntimeAuthenticationCapabilityV1>;
  readonly profile: Readonly<CredentialProfileRef>;
  /** Nonsecret references only; the standing source stays with its custodian. */
  readonly providers: readonly string[];
}

/**
 * Independently retained selected-IAM whole-session policy output. Possession or
 * decoding does not authorize use: the original owner authenticates the policy,
 * exact ROOT/principal, grant/lease and immutable selected connection/profile.
 * Decode plain DATA independently; only original owner recognition permits use.
 * Whole-session permission cannot be inferred from repository read/write,
 * deployment permission or generic Agent operate.
 */
export interface RuntimeSessionEntitlementV1 {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly root: Readonly<RootWorkIdentityV1>;
  readonly servicePrincipalId: string;
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly serviceId: string;
  readonly profileDigest: string;
  readonly sandboxDriverId: string;
  readonly providerInstanceId: string;
  readonly grantId: string;
  readonly leaseId: string;
  /** Epoch milliseconds, validated by the original policy producer. */
  readonly notBefore: number;
  /** Finite epoch milliseconds, strictly after notBefore. */
  readonly expiresAt: number;
  readonly permission: "whole-session";
  readonly lifetime: "bounded";
  readonly withdrawal: "exact-receiver";
}

/**
 * Original selected-IAM policy producer, using its authorized policy retention
 * and shared Installation authority fence. Lookup operands are requested DATA,
 * compared independently with current retained policy after lock waits.
 * Entitlement, grant and profile changes join that same exclusive fence.
 */
export interface RuntimeSessionEntitlementOwnerV1 {
  /**
   * Synchronously enroll the whole callback in original State participation;
   * reject foreign, closed or escaped UoW objects before policy access. Hold the
   * Installation fence before assignment/ROOT, session and attempt locks and
   * check current policy/selected generation through the original outer outcome.
   * Return undefined when no exact current whole-session entitlement exists.
   */
  currentIn(
    uow: PlatformUnitOfWork,
    input: {
      readonly root: Readonly<RootWorkIdentityV1>;
      readonly sandboxDriverId: string;
      readonly connectionId: string;
      readonly connectionGeneration: string;
      readonly serviceId: string;
      readonly profileDigest: string;
      readonly bounds: Bounds;
    },
  ): Promise<RuntimeSessionEntitlementV1 | undefined>;
}

/**
 * Original Work/Core adapter, composed with the original selected-IAM and State
 * owners. Trusted construction snapshots one connection/profile and its original
 * registered schema/recipe. Admit only the exact capability tuple
 * external-runtime/runtime-authentication-v1@1/standing/source-managed.
 * The original runtime assignment owner supplies execution ID and opaque generation.
 * Configuration, revision IDs, decoded DATA, a fake empty token or an IAM consumer
 * alone cannot mint authority. No repository effect or AuthorityBinding arm applies.
 *
 * Every method synchronously calls original State runAuthorityParticipantIn for
 * its entire callback/UoW lifetime and rejects foreign, closed or escaped UoW
 * instances. Acquire the shared Installation authority fence before assignment/ROOT,
 * session and attempt locks; after every wait authenticate the existing Core, policy
 * and selected generation under that fence through the original outer outcome.
 * Successful inner calls and retained records do not certify commit. Release only
 * after original State reports known outer commit; uncertain outcomes require
 * original readback and cannot authorize replacement authority or provider create.
 * These ports declare the contract; the original producers supply its bodies.
 */
export interface RuntimeSessionAuthorityOwnerV1 {
  /**
   * Resolve retained current authority for the revision using the trusted immutable
   * selection. Return undefined for unadmitted or unsupported sessions. Session
   * expiry is the minimum of entitlement, grant, finite ROOT, profile and supported
   * provider session horizons. Even uncapped ROOT requires finite session expiry.
   * Recheck request deadline/cancellation and deny equality with the expiry boundary.
   */
  resolveIn(
    uow: PlatformUnitOfWork,
    input: {
      readonly revision: Readonly<AgentRevision>;
      readonly bounds: Bounds;
    },
  ): Promise<RuntimeSessionAuthorityV1 | undefined>;

  /** Authenticate the genuine same-owner handle and exact retained admission. */
  authenticateIn(
    uow: PlatformUnitOfWork,
    authority: RuntimeSessionAuthorityV1,
    bounds: Bounds,
  ): Promise<Readonly<RuntimeSessionAdmissionV1>>;

  /**
   * Check the exact original receiver/current admission after lock waits. Unsupported
   * finite lifetime or exact-receiver withdrawal denies use; no provider I/O occurs
   * in this transaction. Withdrawal never revokes the shared standing source.
   */
  checkIn(
    uow: PlatformUnitOfWork,
    input: {
      readonly authority: RuntimeSessionAuthorityV1;
      readonly receiver: RuntimeAuthenticationReceiverV1;
      readonly bounds: Bounds;
    },
  ): Promise<void>;
}

// Supported internal boundary: re-export the original declarations by reference.
export type {
  AgentRevision,
  RootWorkIdentityV1,
  RuntimeAuthenticationProjectionV1,
  RuntimeAuthenticationReceiverV1,
} from "@openclaw-enterprise/contracts";
export type { PlatformUnitOfWork } from "../state/platform-state.ts";
export type {
  Bounds,
  CoreAuthenticationBinding,
  LocalHandle,
} from "../credential-gateway-v1/handles.ts";
export type {
  CredentialConnection,
  CredentialProfileRef,
  ExternalRuntimeAuthenticationCapabilityV1,
} from "../credential-gateway-v1/connection.ts";
