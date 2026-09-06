import type {
  LifecycleOperationReadRequestV1,
  LifecycleScopeV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type { LifecycleOperationPageRequestV1 } from "@openclaw-enterprise/contracts/lifecycle-observation-v1";
import type { LifecycleStatusReadPortV1 } from "@openclaw-enterprise/occ/lifecycle/handler-ports-v1";
import type { LifecycleReadCallV1 } from "@openclaw-enterprise/occ/lifecycle/ports-v1";
import { createLifecycleStatusServiceV1 } from "@openclaw-enterprise/occ/lifecycle/status-service-v1";

/** Independent public-subpath consumer. The application supplies the current
 * owning Installation, qualified source, and original authenticated call.
 * Constructing this service supplies none of those qualifications.
 */
export function createLifecycleStatusConsumerV1(
  resolveInstallationId: () => string | undefined,
  resolveSource: () => LifecycleStatusReadPortV1 | undefined,
) {
  const service = createLifecycleStatusServiceV1({ resolveInstallationId, resolveSource });
  return Object.freeze({
    readStatus(scope: LifecycleScopeV1, call: LifecycleReadCallV1) {
      return service.readStatus(scope, call);
    },
    readOperation(request: LifecycleOperationReadRequestV1, call: LifecycleReadCallV1) {
      return service.readOperation(request, call);
    },
    // Each continuation is explicit and requires another current source read.
    listOperations(request: LifecycleOperationPageRequestV1, call: LifecycleReadCallV1) {
      return service.listOperations(request, call);
    },
    readCapability(scope: LifecycleScopeV1, call: LifecycleReadCallV1) {
      return service.readCapability(scope, call);
    },
  } satisfies LifecycleStatusReadPortV1);
}
