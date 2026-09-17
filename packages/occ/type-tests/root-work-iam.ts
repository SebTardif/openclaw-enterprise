import { createNativeRootIamAdmissionV1, type PlatformUnitOfWork } from "@openclaw-enterprise/occ";
import { NativeIAMDriver } from "@openclaw-enterprise/iam";
import type { AuthorizationRequest, RootWorkIdentityV1 } from "@openclaw-enterprise/contracts";
import type { InitialDeploymentPolicyOwnerV1 } from "../src/root-work-v1/selected-iam-ports.ts";
import type { OriginalPrCreationClaimV1 } from "../src/root-work-v1/ports.ts";
type NativeRootIamAdmissionDependenciesV1 = Parameters<typeof createNativeRootIamAdmissionV1>[0];
type SelectedIamAdmissionOwner = ReturnType<typeof createNativeRootIamAdmissionV1>;
type AuthorityBinding = Parameters<SelectedIamAdmissionOwner["prepare"]>[0];
type IamAdmissionEvidence = Awaited<ReturnType<SelectedIamAdmissionOwner["prepare"]>>;
type ProjectionOwner = NativeRootIamAdmissionDependenciesV1["grantOperations"];

// @ts-expect-error Generic handle custody is private at the package root.
import type { LocalHandle } from "@openclaw-enterprise/occ";
// @ts-expect-error Authentication custody is private at the package root.
import type { AuthenticatedAccess } from "@openclaw-enterprise/occ";
// @ts-expect-error Projection declarations remain internal at the package root.
import type { OriginalGrantOperationProjectionOwnerV1 } from "@openclaw-enterprise/occ";
// @ts-expect-error Projection DATA declarations remain internal at the package root.
import type { RegisteredGrantOperationProjectionV1 } from "@openclaw-enterprise/occ";

export function projectionCorrespondence(dependencies: NativeRootIamAdmissionDependenciesV1) {
  const { grantOperations: _projection, ...missing } = dependencies;
  // @ts-expect-error The original operation projection is required at construction.
  createNativeRootIamAdmissionV1(missing);
  const asynchronous: ProjectionOwner = {
    projectRegisteredGrant: async (grant) =>
      // @ts-expect-error The original owner returns synchronous DATA, never a Promise.
      dependencies.grantOperations.projectRegisteredGrant(grant),
  };
  // @ts-expect-error A predicate does not project original operation DATA.
  const predicate: ProjectionOwner = { projectRegisteredGrant: () => true };
  const candidateDependent: ProjectionOwner = {
    // @ts-expect-error The projector cannot require a candidate binding operand.
    projectRegisteredGrant: (
      grant: Parameters<ProjectionOwner["projectRegisteredGrant"]>[0],
      candidate: AuthorityBinding,
    ) => dependencies.grantOperations.projectRegisteredGrant(grant),
  };
  const wrongProfile: ProjectionOwner = {
    projectRegisteredGrant: (grant) => ({
      ...dependencies.grantOperations.projectRegisteredGrant(grant),
      // @ts-expect-error Projection profile correspondence requires the full original profile.
      originalProfile: "read",
    }),
  };
  const wrongOperations: ProjectionOwner = {
    projectRegisteredGrant: (grant) => ({
      ...dependencies.grantOperations.projectRegisteredGrant(grant),
      // @ts-expect-error Projection operations correspondence requires the original retained value.
      originalOperations: "read",
    }),
  };
  void asynchronous;
  void predicate;
  void candidateDependent;
  void wrongProfile;
  void wrongOperations;
}

export async function publicConsumer(
  dependencies: NativeRootIamAdmissionDependenciesV1,
  binding: AuthorityBinding,
  uow: PlatformUnitOfWork,
  claim: OriginalPrCreationClaimV1,
  identity: RootWorkIdentityV1,
  driver: NativeIAMDriver,
): Promise<void> {
  const owner: SelectedIamAdmissionOwner = createNativeRootIamAdmissionV1(dependencies);
  const evidence: IamAdmissionEvidence = await owner.prepare(binding, 1000);
  await owner.consumeIn(uow, evidence, binding);
  // @ts-expect-error ROOT DATA cannot supply effect or original Core custody.
  await owner.prepare(identity, 1000);
  // @ts-expect-error Original PR claim and selected-IAM evidence are distinct owners.
  await owner.consumeIn(uow, claim, binding);
  const request: AuthorizationRequest = {
    principalId: "p",
    // @ts-expect-error Business cancellation never enters the closed native vocabulary.
    action: "work.cancel",
    resource: { kind: "agent", id: "a", namespaceId: "n" },
  };
  // @ts-expect-error Original effect lookup uses independently retained readIn.
  dependencies.effects.retainIn(uow, binding);
  const recognized = dependencies.core.recognize(binding.authentication);
  if (recognized) {
    // @ts-expect-error The original Work recognizer exposes identity, not root.
    recognized.root;
    // @ts-expect-error Original request bounds do not come from Core DATA.
    recognized.bounds;
  }
  if (binding.effect !== "root-cancel") {
    // @ts-expect-error Current recipe identity has no historical packageId.
    binding.connection.definition.packageId;
  }
  // @ts-expect-error A copied shape is not the actual NativeIAMDriver.
  const copied: NativeIAMDriver = { ...driver };
  void request;
  void copied;
}

/** Exact six original operands; this is type correspondence, not an initial provider. */
export function initialDeploymentCorrespondence(
  owner: InitialDeploymentPolicyOwnerV1,
  operands: Parameters<InitialDeploymentPolicyOwnerV1["consumePreparedIn"]>,
) {
  const [uow, evidence, invocation, lockedAgent, fullPolicy, bounds] = operands;
  return owner.consumePreparedIn(uow, evidence, invocation, lockedAgent, fullPolicy, bounds);
}
