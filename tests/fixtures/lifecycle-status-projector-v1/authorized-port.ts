import type {
  LifecycleOperationReadRequestV1,
  LifecycleScopeV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type { LifecycleOperationPageRequestV1 } from "@openclaw-enterprise/contracts/lifecycle-observation-v1";
import type { LifecycleReadCallV1 } from "@openclaw-enterprise/occ/lifecycle/ports-v1";
import type { LifecycleStatusReadPortV1 } from "@openclaw-enterprise/occ/lifecycle/handler-ports-v1";
import { createSanitizedLifecycleStatusReaderV1 } from "@openclaw-enterprise/occ/lifecycle/status-reader-v1";

/** The application supplies its qualified source and original invocation call.
 * This example constructs neither authentication nor a successful source.
 */
export function readStatusForInvocationV1(
  source: LifecycleStatusReadPortV1 | undefined,
  scope: LifecycleScopeV1,
  call: LifecycleReadCallV1,
): ReturnType<LifecycleStatusReadPortV1["readStatus"]> {
  return createSanitizedLifecycleStatusReaderV1(source).readStatus(scope, call);
}

export function readExactOperationForInvocationV1(
  source: LifecycleStatusReadPortV1 | undefined,
  request: LifecycleOperationReadRequestV1,
  call: LifecycleReadCallV1,
): ReturnType<LifecycleStatusReadPortV1["readOperation"]> {
  return createSanitizedLifecycleStatusReaderV1(source).readOperation(request, call);
}

/** Each explicit continuation invokes the source again with its supplied
 * original call and requires fresh source authorization. An ambiguous or empty
 * page does not justify resubmitting a mutation.
 */
export function readOneOperationPageForInvocationV1(
  source: LifecycleStatusReadPortV1 | undefined,
  request: LifecycleOperationPageRequestV1,
  call: LifecycleReadCallV1,
): ReturnType<LifecycleStatusReadPortV1["listOperations"]> {
  return createSanitizedLifecycleStatusReaderV1(source).listOperations(request, call);
}

export function readCapabilityForInvocationV1(
  source: LifecycleStatusReadPortV1 | undefined,
  scope: LifecycleScopeV1,
  call: LifecycleReadCallV1,
): ReturnType<LifecycleStatusReadPortV1["readCapability"]> {
  return createSanitizedLifecycleStatusReaderV1(source).readCapability(scope, call);
}
