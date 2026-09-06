import type { AuthenticatedRequestHandleV1 } from "@openclaw-enterprise/contracts/account-authority-v1";
import type {
  LifecycleAdmissionAssociationV1,
  LifecycleIntentV1,
  LifecycleMutationReceiptV1,
  LifecycleMutationRequestV1,
  LifecycleOperationReadProjectionV1,
  LifecycleOperationReadRequestV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type { RuntimeIntent } from "@openclaw-enterprise/contracts/runtime-assignment";
import type {
  LifecycleAdmissionCallV1,
  LifecycleAdmissionOutcomeV1,
  LifecycleAdmissionPortV1,
  LifecycleIntentHeadProjectionV1,
  LifecycleReadCallV1,
  LifecycleReadPortV1,
  LifecycleReadResultV1,
  LifecycleRecoveryHandleV1,
  LifecycleRecoveryResultV1,
} from "@openclaw-enterprise/occ/lifecycle/ports-v1";

/** Compile-only integration example. The actual controller supplies authenticated
 * request custody and retains the one-use locator before entering admission.
 * No real implementation or authentication factory is constructed here.
 */
export async function submitLifecycleOnce(
  admission: LifecycleAdmissionPortV1,
  request: LifecycleMutationRequestV1,
  call: LifecycleAdmissionCallV1,
  freshRecoveryCall: () => Promise<LifecycleReadCallV1>,
): Promise<LifecycleAdmissionOutcomeV1 | LifecycleRecoveryResultV1> {
  const outcome = await admission.admit(request, call);
  if (outcome.kind !== "commit-unknown") return outcome;

  // The owner issues this handle only after terminal unwind. Read authorization
  // is checked again. Failure/unconfirmed is returned; admit is never retried.
  return admission.recoverAfterUnwind(outcome.recovery, await freshRecoveryCall());
}

/** Historical disclosure is a separate current-authorized read. It does not
 * reuse a mutation result or activate a revision, even after a later head.
 */
export function readHistoricalLifecycleOperation(
  reader: LifecycleReadPortV1,
  request: LifecycleOperationReadRequestV1,
  call: LifecycleReadCallV1,
): Promise<LifecycleReadResultV1<LifecycleOperationReadProjectionV1>> {
  return reader.readOperation(request, call);
}

type AssertFalse<T extends false> = T;
type AcceptedReceipt = Extract<LifecycleMutationReceiptV1, { disposition: "accepted" }>;

/** These compile-time correspondences prevent accidental integration widening.
 * Runtime parsers and actual provenance checks still enforce real boundaries.
 */
export type LifecycleAdmissionConsumerChecks = [
  AssertFalse<LifecycleMutationRequestV1 extends AuthenticatedRequestHandleV1 ? true : false>,
  AssertFalse<LifecycleAdmissionAssociationV1 extends LifecycleRecoveryHandleV1 ? true : false>,
  AssertFalse<LifecycleIntentV1 extends RuntimeIntent ? true : false>,
  AssertFalse<"requestedRevisionId" extends keyof AcceptedReceipt["operation"] ? true : false>,
  AssertFalse<"actorId" extends keyof LifecycleOperationReadProjectionV1 ? true : false>,
  AssertFalse<"auditEventId" extends keyof LifecycleOperationReadProjectionV1 ? true : false>,
  AssertFalse<"workId" extends keyof LifecycleOperationReadProjectionV1 ? true : false>,
  AssertFalse<
    {
      operationRef: string;
      lifecycleGeneration: number;
      desiredMode: "running";
      requestedRevisionId: null;
    } extends LifecycleIntentHeadProjectionV1
      ? true
      : false
  >,
];
