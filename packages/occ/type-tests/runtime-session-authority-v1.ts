import type {
  AgentRevision,
  RootWorkIdentityV1,
  RuntimeAuthenticationProjectionV1,
  RuntimeAuthenticationReceiverV1,
} from "@openclaw-enterprise/contracts";
import type {
  AgentRevision as SessionAgentRevision,
  RootWorkIdentityV1 as SessionRootIdentity,
  RuntimeAuthenticationProjectionV1 as SessionProjection,
  RuntimeAuthenticationReceiverV1 as SessionReceiver,
  Bounds,
  CoreAuthenticationBinding,
  CredentialConnection as SessionConnection,
  CredentialProfileRef,
  ExternalRuntimeAuthenticationCapabilityV1,
  LocalHandle,
  PlatformUnitOfWork,
  RuntimeSessionAdmissionV1,
  RuntimeSessionAuthorityOwnerV1,
  RuntimeSessionAuthorityV1,
  RuntimeSessionEntitlementOwnerV1,
  RuntimeSessionEntitlementV1,
} from "@openclaw-enterprise/occ/internal/runtime-session-v1";
import type {
  AuthorityBinding,
  PlatformStateStore,
  RuntimeAuthenticationAttachmentV1,
  RuntimeAuthenticationOwnerV1,
  SelectedIamAdmissionOwner,
  WorkAdmissionOwner,
} from "@openclaw-enterprise/occ";
import type {
  Bounds as OriginalBounds,
  CoreAuthenticationBinding as OriginalCoreAuthenticationBinding,
  LocalHandle as OriginalLocalHandle,
} from "../src/credential-gateway-v1/handles.ts";
import type {
  CredentialConnection as OriginalConnection,
  CredentialProfileRef as OriginalProfile,
  ExternalRuntimeAuthenticationCapabilityV1 as OriginalCapability,
} from "../src/credential-gateway-v1/connection.ts";
import type { PlatformUnitOfWork as OriginalUow } from "../src/state/platform-state.ts";
import { NativeIAMDriver, type NativeIAMStateStore } from "../../iam/src/index.ts";

// @ts-expect-error Session authority remains at its deliberate internal boundary.
import type { RuntimeSessionAuthorityV1 as PublicSessionAuthority } from "@openclaw-enterprise/occ";
// @ts-expect-error Publishing the port does not restore the public generic handle barrel.
import type { LocalHandle as PublicLocalHandle } from "@openclaw-enterprise/occ";
// @ts-expect-error Original Core custody remains internal to its owner.
import type { CoreAuthenticationBinding as PublicCoreBinding } from "@openclaw-enterprise/occ";
// @ts-expect-error Private source files are not supported package deep-import routes.
import type { RuntimeSessionAuthorityV1 as DeepSessionAuthority } from "@openclaw-enterprise/occ/src/root-work-v1/runtime-session-ports.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

// Independent contract expectations compare the route with the actual suppliers.
type OriginalOperands = Assert<
  Equal<
    [
      Bounds,
      CoreAuthenticationBinding,
      LocalHandle<"runtime-session-authority-v1">,
      PlatformUnitOfWork,
      CredentialProfileRef,
      ExternalRuntimeAuthenticationCapabilityV1,
    ],
    [
      OriginalBounds,
      OriginalCoreAuthenticationBinding,
      OriginalLocalHandle<"runtime-session-authority-v1">,
      OriginalUow,
      OriginalProfile,
      OriginalCapability,
    ]
  >
>;
type OriginalConnectionOperand = Assert<Equal<SessionConnection, OriginalConnection>>;
type OriginalContractOperands = Assert<
  Equal<
    [SessionAgentRevision, SessionRootIdentity, SessionProjection, SessionReceiver],
    [
      AgentRevision,
      RootWorkIdentityV1,
      RuntimeAuthenticationProjectionV1,
      RuntimeAuthenticationReceiverV1,
    ]
  >
>;
type NoRuntimeRepositoryEffect = Assert<
  Equal<Extract<AuthorityBinding, { readonly effect: "runtime-session" }>, never>
>;
type OriginalAuthority = Assert<
  Equal<RuntimeSessionAuthorityV1, OriginalLocalHandle<"runtime-session-authority-v1">>
>;
type ExactEntitlementLookup = Assert<
  Equal<
    Parameters<RuntimeSessionEntitlementOwnerV1["currentIn"]>,
    [
      uow: OriginalUow,
      input: {
        readonly root: Readonly<RootWorkIdentityV1>;
        readonly sandboxDriverId: string;
        readonly connectionId: string;
        readonly connectionGeneration: string;
        readonly serviceId: string;
        readonly profileDigest: string;
        readonly bounds: OriginalBounds;
      },
    ]
  >
>;
type ExactResolve = Assert<
  Equal<
    Parameters<RuntimeSessionAuthorityOwnerV1["resolveIn"]>,
    [
      uow: OriginalUow,
      input: { readonly revision: Readonly<AgentRevision>; readonly bounds: OriginalBounds },
    ]
  >
>;
type ExactAuthenticate = Assert<
  Equal<
    Parameters<RuntimeSessionAuthorityOwnerV1["authenticateIn"]>,
    [uow: OriginalUow, authority: RuntimeSessionAuthorityV1, bounds: OriginalBounds]
  >
>;
type ExactCheck = Assert<
  Equal<
    Parameters<RuntimeSessionAuthorityOwnerV1["checkIn"]>,
    [
      uow: OriginalUow,
      input: {
        readonly authority: RuntimeSessionAuthorityV1;
        readonly receiver: RuntimeAuthenticationReceiverV1;
        readonly bounds: OriginalBounds;
      },
    ]
  >
>;
type ExactResults = Assert<
  Equal<
    [
      ReturnType<RuntimeSessionEntitlementOwnerV1["currentIn"]>,
      ReturnType<RuntimeSessionAuthorityOwnerV1["resolveIn"]>,
      ReturnType<RuntimeSessionAuthorityOwnerV1["authenticateIn"]>,
      ReturnType<RuntimeSessionAuthorityOwnerV1["checkIn"]>,
    ],
    [
      Promise<RuntimeSessionEntitlementV1 | undefined>,
      Promise<RuntimeSessionAuthorityV1 | undefined>,
      Promise<Readonly<RuntimeSessionAdmissionV1>>,
      Promise<void>,
    ]
  >
>;
type ExactOwnerMethods = Assert<
  Equal<keyof RuntimeSessionAuthorityOwnerV1, "resolveIn" | "authenticateIn" | "checkIn">
>;
type ExactPolicyMethods = Assert<Equal<keyof RuntimeSessionEntitlementOwnerV1, "currentIn">>;
type ExactAdmission = Assert<
  Equal<
    RuntimeSessionAdmissionV1,
    {
      readonly authentication: OriginalCoreAuthenticationBinding;
      readonly root: Readonly<RootWorkIdentityV1>;
      readonly projection: RuntimeAuthenticationProjectionV1;
      readonly grantId: string;
      readonly leaseId: string;
      readonly operationId: string;
      readonly inputDigest: string;
      readonly capability: Readonly<OriginalCapability>;
      readonly profile: Readonly<OriginalProfile>;
      readonly providers: readonly string[];
    }
  >
>;
type ExactEntitlement = Assert<
  Equal<
    RuntimeSessionEntitlementV1,
    {
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
      readonly notBefore: number;
      readonly expiresAt: number;
      readonly permission: "whole-session";
      readonly lifetime: "bounded";
      readonly withdrawal: "exact-receiver";
    }
  >
>;

// Named inert producer/consumer substitutes only. These declarations do not issue
// authority, evaluate selected policy, recognize UoW liveness or implement the
// downstream broker. Actual producers retain their source-composition acceptance.
declare const originalWorkCoreProducer: RuntimeSessionAuthorityOwnerV1;
declare const originalSelectedIamPolicyProducer: RuntimeSessionEntitlementOwnerV1;
declare const originalState: PlatformStateStore;
declare const downstreamRuntimeConsumer: RuntimeAuthenticationOwnerV1;
declare const originalWorkAdmission: WorkAdmissionOwner;
declare const originalSelectedIamAdmission: SelectedIamAdmissionOwner;
declare const uow: PlatformUnitOfWork;
declare const revision: Readonly<AgentRevision>;
declare const root: Readonly<RootWorkIdentityV1>;
declare const bounds: Bounds;
declare const receiver: RuntimeAuthenticationReceiverV1;
declare const authority: RuntimeSessionAuthorityV1;
declare const authentication: CoreAuthenticationBinding;
declare const projection: RuntimeAuthenticationProjectionV1;
declare const attachment: RuntimeAuthenticationAttachmentV1;
declare const capability: ExternalRuntimeAuthenticationCapabilityV1;
declare const profile: CredentialProfileRef;
declare const entitlement: RuntimeSessionEntitlementV1;
declare const admission: Readonly<RuntimeSessionAdmissionV1>;

// Typecheck the actual original IAM source constructor and its real State operand;
// ordinary IAM authorization is not a whole-session policy or authority producer.
function originalProducerImportFixture(nativeState: NativeIAMStateStore): void {
  const nativeIam = new NativeIAMDriver(nativeState);
  // @ts-expect-error An IAM Driver alone cannot authenticate whole-session authority.
  const iamAsAuthority: RuntimeSessionAuthorityOwnerV1 = nativeIam;
  // @ts-expect-error Generic IAM does not provide retained whole-session entitlement.
  const iamAsPolicy: RuntimeSessionEntitlementOwnerV1 = nativeIam;
  void [iamAsAuthority, iamAsPolicy];
}

// Construct declared producer outputs using original nominal operands. This
// fixture is never run and makes no claim that its DATA was authenticated.
function originalProducerOutputFixture(): void {
  const session: RuntimeSessionAdmissionV1 = {
    authentication,
    root,
    projection,
    grantId: "declared-grant",
    leaseId: "declared-lease",
    operationId: "declared-original-session-operation",
    inputDigest: "declared-session-digest",
    capability,
    profile,
    providers: ["declared-nonsecret-provider-reference"],
  };
  const selectedPolicy: RuntimeSessionEntitlementV1 = {
    policyId: "declared-independent-policy",
    policyVersion: "declared-policy-version",
    root,
    servicePrincipalId: root.servicePrincipalId,
    connectionId: projection.connectionId,
    connectionGeneration: projection.connectionGeneration,
    serviceId: projection.serviceId,
    profileDigest: projection.profileDigest,
    sandboxDriverId: projection.sandboxDriverId,
    providerInstanceId: "declared-provider-instance",
    grantId: session.grantId,
    leaseId: session.leaseId,
    notBefore: 1,
    expiresAt: 2,
    permission: "whole-session",
    lifetime: "bounded",
    withdrawal: "exact-receiver",
  };
  void [session, selectedPolicy];
}

async function downstreamConsumerImportFixture(): Promise<void> {
  // Compile the original State callback/UoW/whole-participation API with the
  // supported port. Fulfilled inner calls do not constitute known outer commit.
  const result: Readonly<RuntimeSessionAdmissionV1> | undefined = await originalState.transact(
    async (originalUow) =>
      originalState.runAuthorityParticipantIn(originalUow, async () => {
        const resolved = await originalWorkCoreProducer.resolveIn(originalUow, {
          revision,
          bounds,
        });
        if (resolved === undefined) return undefined;
        const authenticated = await originalWorkCoreProducer.authenticateIn(
          originalUow,
          resolved,
          bounds,
        );
        const current = await originalSelectedIamPolicyProducer.currentIn(originalUow, {
          root: authenticated.root,
          sandboxDriverId: authenticated.projection.sandboxDriverId,
          connectionId: authenticated.projection.connectionId,
          connectionGeneration: authenticated.projection.connectionGeneration,
          serviceId: authenticated.projection.serviceId,
          profileDigest: authenticated.projection.profileDigest,
          bounds,
        });
        if (current === undefined) return undefined;
        await originalWorkCoreProducer.checkIn(originalUow, {
          authority: resolved,
          receiver,
          bounds,
        });
        return authenticated;
      }),
  );
  if (result === undefined) return;
  const planned = await downstreamRuntimeConsumer.prepareAttachment({
    projection: result.projection,
    receiver,
    bounds,
  });
  void planned;
}

// Known DATA and every other nominal family fail independently of missing fields.
// @ts-expect-error Decoded ROOT DATA cannot mint a registered session authority.
const rootAsAuthority: RuntimeSessionAuthorityV1 = root;
// @ts-expect-error Even a complete policy record remains DATA rather than authority.
const policyAsAuthority: RuntimeSessionAuthorityV1 = entitlement;
// @ts-expect-error Complete authenticated admission output is not its owner's handle.
const admissionAsAuthority: RuntimeSessionAuthorityV1 = admission;
// @ts-expect-error A Core grant handle has a distinct kind from session authority.
const coreAsAuthority: RuntimeSessionAuthorityV1 = authentication;
// @ts-expect-error Projection custody is distinct from original Work/Core authority.
const projectionAsAuthority: RuntimeSessionAuthorityV1 = projection;
// @ts-expect-error An attachment represents cleanup, not authority for another session.
const attachmentAsAuthority: RuntimeSessionAuthorityV1 = attachment;
// @ts-expect-error Original generic Core custody cannot be recreated by a session handle.
const authorityAsCore: CoreAuthenticationBinding = authority;
// @ts-expect-error Runtime projection uses its original contracts registry/brand.
const authorityAsProjection: RuntimeAuthenticationProjectionV1 = authority;
// @ts-expect-error The original effect union has no runtime-session arm.
const authorityAsRepositoryEffect: AuthorityBinding = admission;
// @ts-expect-error The existing Work effect checker cannot consume a session handle.
originalWorkAdmission.checkIn(uow, authority);
// @ts-expect-error The existing selected-IAM effect bridge cannot reinterpret session authority.
originalSelectedIamAdmission.prepare(authority, bounds.deadline);
// @ts-expect-error Ordinary ROOT/revision DATA cannot be authenticated as a session handle.
originalWorkCoreProducer.authenticateIn(uow, revision, bounds);
// @ts-expect-error A structural empty object cannot recreate an original UoW.
originalWorkCoreProducer.resolveIn({}, { revision, bounds });
// @ts-expect-error A UoW argument is mandatory; no detached authority check exists.
originalWorkCoreProducer.authenticateIn(authority, bounds);
// @ts-expect-error Session lookup requires original State UoW participation.
originalSelectedIamPolicyProducer.currentIn({ root, bounds });
// @ts-expect-error Trusted constructor selection is not caller-selected request DATA.
originalWorkCoreProducer.resolveIn(uow, { revision, bounds, profile });
// @ts-expect-error Exact receiver admission cannot omit the original receiver operand.
originalWorkCoreProducer.checkIn(uow, { authority, bounds });
// @ts-expect-error Resolution cannot omit caller cancellation/deadline bounds.
originalWorkCoreProducer.resolveIn(uow, { revision });
const receiverWithoutWorkspace = { ...receiver, workspace: undefined };
// @ts-expect-error Receiver identity remains its complete original contracts shape.
originalWorkCoreProducer.checkIn(uow, { authority, receiver: receiverWithoutWorkspace, bounds });
// @ts-expect-error Request cancellation without a finite request deadline is insufficient.
originalWorkCoreProducer.resolveIn(uow, { revision, bounds: { signal: bounds.signal } });
const { connectionGeneration: omittedGeneration, ...noGeneration } = {
  root,
  sandboxDriverId: projection.sandboxDriverId,
  connectionId: projection.connectionId,
  connectionGeneration: projection.connectionGeneration,
  serviceId: projection.serviceId,
  profileDigest: projection.profileDigest,
  bounds,
};
// @ts-expect-error Exact independently checked generation cannot be omitted from lookup DATA.
originalSelectedIamPolicyProducer.currentIn(uow, noGeneration);
const { profile: omittedProfile, ...noProfile } = admission;
// @ts-expect-error The original immutable profile cannot be omitted from admission output.
const missingProfile: RuntimeSessionAdmissionV1 = noProfile;
const { inputDigest: omittedDigest, ...noSessionDigest } = admission;
// @ts-expect-error The original session operation digest is mandatory producer output.
const missingSessionDigest: RuntimeSessionAdmissionV1 = noSessionDigest;
const { projection: omittedProjection, ...noProjection } = admission;
// @ts-expect-error Original projection cannot be omitted from the admitted producer output.
const missingProjection: RuntimeSessionAdmissionV1 = noProjection;
const { policyVersion: omittedPolicyVersion, ...noPolicyVersion } = entitlement;
// @ts-expect-error Current policy identity/version must be independently retained.
const missingPolicyVersion: RuntimeSessionEntitlementV1 = noPolicyVersion;
const { expiresAt: omittedExpiry, ...noExpiry } = entitlement;
// @ts-expect-error Even uncapped ROOT requires a finite admitted session horizon.
const missingExpiry: RuntimeSessionEntitlementV1 = noExpiry;
// @ts-expect-error Repository read permission does not confer whole-session authority.
const repositoryPermission: RuntimeSessionEntitlementV1["permission"] = "read";
// @ts-expect-error Deployment permission does not confer whole-session authority.
const deploymentPermission: RuntimeSessionEntitlementV1["permission"] = "deploy";
// @ts-expect-error Generic Agent operate does not confer whole-session authority.
const operatePermission: RuntimeSessionEntitlementV1["permission"] = "operate";
// @ts-expect-error Per-request mediation is a different policy contract.
const perRequestPermission: RuntimeSessionEntitlementV1["permission"] = "request";
// @ts-expect-error Unbounded sessions are unsupported independently of ROOT duration.
const unboundedLifetime: RuntimeSessionEntitlementV1["lifetime"] = "unbounded";
// @ts-expect-error Receiver withdrawal cannot replace shared-source revocation.
const sourceRevocation: RuntimeSessionEntitlementV1["withdrawal"] = "per-credential";
// @ts-expect-error The exact original profile reference is immutable producer output.
admission.profile = profile;
// @ts-expect-error Provider references cannot be extended by a consumer.
admission.providers.push("another-provider");
// @ts-expect-error The published session owner provides no authority factory.
originalWorkCoreProducer.issue({ revision, bounds });

void [
  originalProducerImportFixture,
  originalProducerOutputFixture,
  downstreamConsumerImportFixture,
  rootAsAuthority,
  policyAsAuthority,
  admissionAsAuthority,
  coreAsAuthority,
  projectionAsAuthority,
  attachmentAsAuthority,
  authorityAsCore,
  authorityAsProjection,
  authorityAsRepositoryEffect,
  omittedGeneration,
  omittedDigest,
  missingSessionDigest,
  omittedProfile,
  missingProfile,
  omittedProjection,
  missingProjection,
  omittedPolicyVersion,
  missingPolicyVersion,
  omittedExpiry,
  missingExpiry,
  repositoryPermission,
  deploymentPermission,
  operatePermission,
  perRequestPermission,
  unboundedLifetime,
  sourceRevocation,
];
export type {
  OriginalOperands,
  OriginalConnectionOperand,
  OriginalContractOperands,
  NoRuntimeRepositoryEffect,
  OriginalAuthority,
  ExactEntitlementLookup,
  ExactResolve,
  ExactAuthenticate,
  ExactCheck,
  ExactResults,
  ExactOwnerMethods,
  ExactPolicyMethods,
  ExactAdmission,
  ExactEntitlement,
};
