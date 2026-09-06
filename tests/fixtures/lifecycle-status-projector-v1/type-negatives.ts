import type { AuthenticatedRequestHandleV1 } from "@openclaw-enterprise/contracts/account-authority-v1";
import type {
  LifecycleAcceptedOperationV1,
  LifecycleMutationReceiptV1,
  LifecycleOperationReadRequestV1,
  LifecycleScopeV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type {
  LifecycleConditionV1,
  LifecycleObservationResponseRequestTypesV1,
  LifecycleObservationResponseTypesV1,
  LifecycleOperationStatusV1,
  LifecycleReasonCodeV1,
  LifecycleStatusV1,
} from "@openclaw-enterprise/contracts/lifecycle-observation-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  LifecycleReadCallV1,
  LifecycleReadResultV1,
} from "@openclaw-enterprise/occ/lifecycle/ports-v1";
import type {
  LifecycleStatusReadMethodV1,
  LifecycleStatusReadRequestV1,
  LifecycleStatusReadResultV1,
  LifecycleStatusReadValueV1,
} from "@openclaw-enterprise/occ/lifecycle/status-projector-v1";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type MustBeTrue<T extends true> = T;
type EveryMethod = {
  [K in LifecycleStatusReadMethodV1]: Equal<
    LifecycleStatusReadRequestV1<K>,
    LifecycleObservationResponseRequestTypesV1[K]
  > extends true
    ? Equal<LifecycleStatusReadValueV1<K>, LifecycleObservationResponseTypesV1[K]> extends true
      ? Equal<
          LifecycleStatusReadResultV1<K>,
          LifecycleReadResultV1<LifecycleObservationResponseTypesV1[K]>
        >
      : false
    : false;
}[LifecycleStatusReadMethodV1];
export type EveryAliasIsCanonical = MustBeTrue<Equal<EveryMethod, true>>;
export type ExactFourMethods = MustBeTrue<
  Equal<
    LifecycleStatusReadMethodV1,
    "readStatus" | "readOperation" | "listOperations" | "readCapability"
  >
>;

/** Compile-only checks. The function is never called and constructs no handle.
 * Numeric bounds and time/currentness relationships require runtime validation.
 */
export function rejectedTypeAssignmentsV1(
  status: LifecycleStatusV1,
  receipt: LifecycleMutationReceiptV1,
  minimalOperation: LifecycleAcceptedOperationV1,
  operationResult: LifecycleReadResultV1<LifecycleOperationStatusV1>,
  operationRequest: LifecycleOperationReadRequestV1,
  scope: LifecycleScopeV1,
): void {
  // @ts-expect-error A minimal receipt has no current status/condition fields.
  const receiptAsStatus: LifecycleStatusV1 = receipt;
  // @ts-expect-error Discovery and accepted receipts omit detailed revision data.
  const revisionFromReceipt: string = minimalOperation.requestedRevisionId;
  // @ts-expect-error An exact operation result is not an Agent status result.
  const wrongMethodResult: LifecycleStatusReadResultV1<"readStatus"> = operationResult;
  // @ts-expect-error A scope is not an exact accepted operation locator.
  const wrongMethodRequest: LifecycleStatusReadRequestV1<"readOperation"> = scope;
  // @ts-expect-error A read locator cannot construct private runtime authority.
  const requestAsAuthority: AuthorityCallV1 = operationRequest;
  // @ts-expect-error Authenticated handles require the existing private brand.
  const inventedHandle: AuthenticatedRequestHandleV1 = {};
  // @ts-expect-error A caller-selected scope cannot stand in for an invocation.
  const scopeAsCall: LifecycleReadCallV1 = scope;
  // @ts-expect-error No-head remains a valid state; no forced initialized head.
  const forcedHead: NonNullable<LifecycleStatusV1["head"]> = status.head;
  // @ts-expect-error Protective and uninitialized revisions remain nullable.
  const forcedRevision: string = status.requestedRevisionId;
  // @ts-expect-error An unknown condition cannot be rewritten into confirmation.
  status.conditions.executionTerminated.status = "confirmed";
  // @ts-expect-error Nested source timestamps are readonly too.
  status.conditions.executionTerminated.observedAt = "2026-01-01T00:00:00.000Z";
  // @ts-expect-error Condition vocabulary is the canonical closed vocabulary.
  const impossibleCondition: LifecycleConditionV1["status"] = "terminated";
  // @ts-expect-error Raw provider error strings are not safe canonical reasons.
  const rawReason: LifecycleReasonCodeV1 = "RAW_PROVIDER_ERROR";
  // @ts-expect-error Reconciliation is not one of the four read methods.
  const mutationMethod: LifecycleStatusReadMethodV1 = "reconcile";
  void [
    receiptAsStatus,
    revisionFromReceipt,
    wrongMethodResult,
    wrongMethodRequest,
    requestAsAuthority,
    inventedHandle,
    scopeAsCall,
    forcedHead,
    forcedRevision,
    impossibleCondition,
    rawReason,
    mutationMethod,
  ];
}
