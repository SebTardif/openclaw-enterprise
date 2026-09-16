import type {
  IAMDriver,
  RootDeploymentInvocationV1,
  RootDurationPolicyV1,
  RootWorkIdentityV1,
  RootWorkPolicyV1,
} from "@openclaw-enterprise/contracts";
import {
  decodeRootWorkIdentityV1,
  encodeRootWorkIdentityV1,
  digestRootWorkIdentityV1,
} from "@openclaw-enterprise/contracts";
import type {
  AuthorityBinding,
  Bounds,
  CredentialAuthorityBindingV1,
  IamAdmissionEvidence,
  OpenClawController,
  PlatformStateStore,
  PlatformUnitOfWork,
  PrAuthorityBindingV1,
  ResourceAuthorityBindingV1,
  RootAuthorityBindingV1,
  RootCancellationV1,
  RootDeploymentAdmissionV1,
  RootWorkOwnerV1,
  SelectedIamAdmissionOwner,
  WorkAdmissionOwner,
} from "@openclaw-enterprise/occ";
import type { NativeIAMDriver } from "@openclaw-enterprise/iam";
import type {
  CoreAuthenticationBinding,
  ReceiptFinalization,
} from "../src/credential-gateway-v1/handles.ts";

// These are compiler operands, never fake runtime owners or minted handles.
declare const rootOwner: RootWorkOwnerV1;
declare const work: WorkAdmissionOwner;
declare const iam: SelectedIamAdmissionOwner;
declare const uow: PlatformUnitOfWork;
declare const bounds: Bounds;
declare const policy: RootWorkPolicyV1;
declare const authentication: CoreAuthenticationBinding;
declare const evidence: IamAdmissionEvidence;
declare const rootBinding: RootAuthorityBindingV1;
declare const credential: CredentialAuthorityBindingV1;
declare const resource: ResourceAuthorityBindingV1;
declare const pr: PrAuthorityBindingV1;
declare const finalization: ReceiptFinalization;
declare const nativeIam: NativeIAMDriver;
declare const controller: OpenClawController;
declare const deployArgs: Parameters<OpenClawController["deployAgent"]>;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type OriginalUow = Parameters<Parameters<PlatformStateStore["transact"]>[0]>[0];
type SameStateUow = Assert<Equal<OriginalUow, Parameters<RootWorkOwnerV1["admitDeploymentIn"]>[0]>>;
type SameRevision = Assert<
  Equal<
    Awaited<ReturnType<OpenClawController["deployAgent"]>>,
    Parameters<RootWorkOwnerV1["resolveForRevision"]>[0]
  >
>;
type SameAuthentication = Assert<
  Equal<
    Awaited<ReturnType<RootWorkOwnerV1["resolveForRevision"]>>,
    CoreAuthenticationBinding | undefined
  >
>;
type SameIamRequest = Assert<
  Equal<Parameters<NativeIAMDriver["authorize"]>[0], Parameters<IAMDriver["authorize"]>[0]>
>;

async function currentConsumer(): Promise<void> {
  // The real controller parameter and returned revision feed the proposed owner port.
  const revision = await controller.deployAgent(...deployArgs);
  const invocation: RootDeploymentInvocationV1 = {
    kind: "authenticated-deployment",
    invocationId: "invocation-1",
    requesterPrincipalId: deployArgs[0],
    namespaceId: deployArgs[1].namespaceId,
    agentId: deployArgs[1].agentId,
    requestedAt: 1,
    deadline: bounds.deadline,
  };
  const input: RootDeploymentAdmissionV1 = { invocation, revision, policy, bounds };
  const data = await rootOwner.admitDeploymentIn(uow, input);
  const canonical: string = encodeRootWorkIdentityV1(data);
  const digest: string = digestRootWorkIdentityV1(data);
  const decoded: Readonly<RootWorkIdentityV1> = decodeRootWorkIdentityV1(JSON.parse(canonical));
  const genuine = await rootOwner.resolveForRevision(revision, bounds);
  // Each current effect family uses the original UoW and the same evidence binding.
  for (const binding of [rootBinding, credential, resource, pr] satisfies AuthorityBinding[]) {
    const prepared = await iam.prepare(binding, bounds.deadline);
    await iam.consumeIn(uow, prepared, binding);
    await work.checkIn(uow, binding);
  }
  await rootOwner.cancelIn(uow, {
    authentication,
    cancellationBinding: rootBinding,
    evidence,
    bounds,
  });
  // Standard IAM remains the existing contract, not a substitute admission companion.
  const standard: IAMDriver = nativeIam;
  void [canonical, digest, decoded, genuine, standard];
}
void currentConsumer;

declare const invocation: RootDeploymentInvocationV1;
// Hold every required field constant so these negatives fail solely on the role tag.
const serviceRoleInvocation = { ...invocation, kind: policy.kind };
const requesterRolePolicy = { ...policy, kind: invocation.kind };
// @ts-expect-error A retained service role cannot replace the authenticated invocation role.
const serviceAsRequester: RootDeploymentAdmissionV1["invocation"] = serviceRoleInvocation;
// @ts-expect-error The invocation role cannot replace the retained service-policy role.
const requesterAsPolicy: RootDeploymentAdmissionV1["policy"] = requesterRolePolicy;
// @ts-expect-error Complete DATA cannot recreate the existing nominal Core handle.
const metadataAsAuthority: CoreAuthenticationBinding = decodeRootWorkIdentityV1({});
// @ts-expect-error Receipt finalization is a different original owner/family.
const finalizationAsAuthority: CoreAuthenticationBinding = finalization;
// @ts-expect-error IAM evidence is distinct from the genuine root binding.
const evidenceAsAuthority: CoreAuthenticationBinding = evidence;
// @ts-expect-error Standard IAM authorization is not a transaction-bound companion.
const ordinaryAsCompanion: SelectedIamAdmissionOwner = nativeIam;
// @ts-expect-error Raw IDs cannot provide the existing Core custody handle.
const noCustody: RootAuthorityBindingV1["authentication"] = { rootWorkId: "root-1" };
const credentialRoleRootReceiver = { ...rootBinding.receiver, kind: credential.receiver.kind };
// @ts-expect-error Credential receiver role cannot be crossed into the ROOT family.
const crossedRootReceiver: RootAuthorityBindingV1["receiver"] = credentialRoleRootReceiver;
// @ts-expect-error Resource receiver cannot substitute for an exact credential receiver.
const crossedCredentialReceiver: CredentialAuthorityBindingV1["receiver"] = resource.receiver;
// Preserve the PR effect/receiver and all other fields: only the claim is absent.
const { originalPrClaim: omittedClaim, ...prWithoutClaim } = pr;
// @ts-expect-error PR resource dispatch requires its original runtime claim.
const missingClaim: PrAuthorityBindingV1 = prWithoutClaim;
void omittedClaim;
// @ts-expect-error Credential admission has no PR claim to consume prematurely.
credential.originalPrClaim;
// @ts-expect-error ROOT cancellation has no fabricated external backend operand.
rootBinding.connection;
// @ts-expect-error ROOT cancellation requires independently authorized work.cancel mapping.
const wrongRootAction: RootAuthorityBindingV1["iam"]["action"] = "deploy";
const serviceRoleCanceller = { kind: policy.kind, principalId: policy.servicePrincipalId };
// @ts-expect-error Service policy is not an authenticated cancellation requester.
const serviceAsCanceller: RootAuthorityBindingV1["requester"] = serviceRoleCanceller;
// @ts-expect-error Caller bounds/abort alone cannot authorize root closure.
const abortAsCancellation: RootCancellationV1 = { bounds };
// @ts-expect-error Another evidence family cannot replace selected-IAM evidence.
iam.consumeIn(uow, authentication, rootBinding);
// @ts-expect-error Resolution uses the actual immutable AgentRevision, not identity DATA.
rootOwner.resolveForRevision(rootBinding.root, bounds);
// @ts-expect-error Finite duration requires its original horizon.
const missingHorizon: RootDurationPolicyV1 = { kind: "finite", policyId: "p", policyVersion: "1" };
// @ts-expect-error Uncapped duration must explicitly retain a null original deadline.
const crossedHorizon: RootDurationPolicyV1 = {
  kind: "uncapped",
  policyId: "p",
  policyVersion: "1",
  originalDeadline: 50,
};
// @ts-expect-error Retained DATA cannot be silently rewritten after admission.
rootBinding.root.servicePrincipalId = "requester";
void [
  serviceAsRequester,
  requesterAsPolicy,
  metadataAsAuthority,
  finalizationAsAuthority,
  evidenceAsAuthority,
  ordinaryAsCompanion,
  noCustody,
  crossedRootReceiver,
  crossedCredentialReceiver,
  missingClaim,
  wrongRootAction,
  serviceAsCanceller,
  abortAsCancellation,
  missingHorizon,
  crossedHorizon,
];
export type { SameStateUow, SameRevision, SameAuthentication, SameIamRequest };
