import type { LifecycleMutationReceiptV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type {
  LifecycleObservationResponseTypesV1,
  LifecycleStatusV1,
} from "@openclaw-enterprise/contracts/lifecycle-observation-v1";
import type { LifecycleReadFailureV1 } from "@openclaw-enterprise/occ/lifecycle/ports-v1";
import type {
  LifecycleStatusReadMethodV1,
  LifecycleStatusReadResultV1,
  LifecycleStatusReadValueV1,
} from "@openclaw-enterprise/occ/lifecycle/status-projector-v1";

/** Presentation receives a sanitized value from the trusted transport boundary.
 * These imports are type-only; browser rendering needs no OCC runtime decoder.
 */
export function consumeLifecycleReadForOperatorV1<K extends LifecycleStatusReadMethodV1>(
  method: K,
  result: LifecycleStatusReadResultV1<NoInfer<K>>,
  receive: (method: K, value: LifecycleStatusReadValueV1<NoInfer<K>>) => void,
): LifecycleReadFailureV1 | null {
  if (result.kind !== "read") return result;
  receive(method, result.value);
  return null;
}

/** Minimal mutation receipts can be retained without treating them as status.
 * This consumer has no mutation retry, operation selection or page traversal.
 */
export function retainMinimalMutationReceiptV1(
  receipt: LifecycleMutationReceiptV1,
): LifecycleMutationReceiptV1 {
  return receipt;
}

export function inspectIndependentConditionsV1(
  status: LifecycleStatusV1,
  receive: (conditions: LifecycleStatusV1["conditions"]) => void,
): void {
  receive(status.conditions);
}

// A read of one exact operation carries its original observation, including
// stale source times. It is not a current-status projection for a later head.
export function retainHistoricalOperationV1(
  value: LifecycleObservationResponseTypesV1["readOperation"],
): LifecycleObservationResponseTypesV1["readOperation"] {
  return value;
}
