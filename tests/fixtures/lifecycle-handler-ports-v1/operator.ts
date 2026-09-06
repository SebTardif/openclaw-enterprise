import {
  LifecycleAdmissionErrorV1,
  parseLifecycleAdmissionV1,
  type LifecycleMutationReceiptV1,
  type LifecycleOperationReadRequestV1,
  type LifecycleScopeV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import {
  parseLifecycleObservationV1,
  parseLifecycleObservationResponseV1,
  type LifecycleOperationPageRequestV1,
  type LifecycleStatusV1,
} from "@openclaw-enterprise/contracts/lifecycle-observation-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  LifecycleReadCallV1,
  LifecycleReadFailureV1,
} from "@openclaw-enterprise/occ/lifecycle/ports-v1";
import type { LifecycleStatusReadPortV1 } from "@openclaw-enterprise/occ/lifecycle/handler-ports-v1";

function readFailure(input: unknown): LifecycleReadFailureV1 {
  const result = parseLifecycleAdmissionV1("mutationResult", input);
  if (result.kind === "unavailable" || result.kind === "rejected") return result;
  throw new LifecycleAdmissionErrorV1();
}

/** Independent authorized read examples. Each call uses the actual supplied
 * reader; parsed responses establish shape/correspondence, never read authority.
 * Original timestamps and unknown outcomes are returned without refreshing them.
 */
export async function readLifecycleStatusForOperatorV1(
  reader: LifecycleStatusReadPortV1,
  input: LifecycleScopeV1,
  call: LifecycleReadCallV1,
): ReturnType<LifecycleStatusReadPortV1["readStatus"]> {
  const scope = parseLifecycleAdmissionV1("scope", input);
  const result = await reader.readStatus(scope, call);
  if (result.kind !== "read") return readFailure(result);
  return {
    kind: "read",
    value: parseLifecycleObservationResponseV1("readStatus", scope, result.value),
  };
}

export async function readLifecycleOperationForOperatorV1(
  reader: LifecycleStatusReadPortV1,
  input: LifecycleOperationReadRequestV1,
  call: LifecycleReadCallV1,
): ReturnType<LifecycleStatusReadPortV1["readOperation"]> {
  const request = parseLifecycleAdmissionV1("operationReadRequest", input);
  const result = await reader.readOperation(request, call);
  if (result.kind !== "read") return readFailure(result);
  // Historical reads remain historical after later heads. This locator is not
  // an idempotent mutation request or permission to resume the old operation.
  return {
    kind: "read",
    value: parseLifecycleObservationResponseV1("readOperation", request, result.value),
  };
}

export async function listLifecycleOperationsForOperatorV1(
  reader: LifecycleStatusReadPortV1,
  input: LifecycleOperationPageRequestV1,
  call: LifecycleReadCallV1,
): ReturnType<LifecycleStatusReadPortV1["listOperations"]> {
  const request = parseLifecycleObservationV1("pageRequest", input);
  const result = await reader.listOperations(request, call);
  if (result.kind !== "read") return readFailure(result);
  // The reader enforces exact owner scope; public page entries contain no owner
  // metadata. An empty page does not prove rollback of an in-flight admission.
  return {
    kind: "read",
    value: parseLifecycleObservationResponseV1("listOperations", request, result.value),
  };
}

export async function readLifecycleCapabilityForOperatorV1(
  reader: LifecycleStatusReadPortV1,
  input: LifecycleScopeV1,
  call: LifecycleReadCallV1,
): ReturnType<LifecycleStatusReadPortV1["readCapability"]> {
  const scope = parseLifecycleAdmissionV1("scope", input);
  const result = await reader.readCapability(scope, call);
  if (result.kind !== "read") return readFailure(result);
  return {
    kind: "read",
    value: parseLifecycleObservationResponseV1("readCapability", scope, result.value),
  };
}

/** Mutation responses stay minimal. A receipt does not supply status, a revision
 * document, evidence of serving/stop, or permission for a subsequent read. */
export function retainLifecycleMutationReceiptV1(input: unknown): LifecycleMutationReceiptV1 {
  return parseLifecycleAdmissionV1("mutationReceipt", input);
}

type MustBeFalse<T extends false> = T;
export type ReceiptIsNotStatus = MustBeFalse<
  LifecycleMutationReceiptV1 extends LifecycleStatusV1 ? true : false
>;
export type OperatorRequestIsNotAuthority = MustBeFalse<
  LifecycleOperationReadRequestV1 extends AuthorityCallV1 ? true : false
>;
