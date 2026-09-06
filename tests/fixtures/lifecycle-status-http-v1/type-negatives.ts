import type { AuthenticatedRequestHandleV1 } from "@openclaw-enterprise/contracts/account-authority-v1";
import type {
  LifecycleMutationReceiptV1,
  LifecycleOperationReadRequestV1,
  LifecycleScopeV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type { LifecycleStatusReadPortV1 } from "@openclaw-enterprise/occ/lifecycle/handler-ports-v1";
import type { LifecycleReadCallV1 } from "@openclaw-enterprise/occ/lifecycle/ports-v1";
import { createLifecycleStatusServiceV1 } from "@openclaw-enterprise/occ/lifecycle/status-service-v1";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type MustBeTrue<T extends true> = T;
export type ServiceUsesExistingReadPort = MustBeTrue<
  Equal<ReturnType<typeof createLifecycleStatusServiceV1>, LifecycleStatusReadPortV1>
>;

/** Compile-only checks; never invoke this function or create a production call. */
export function rejectedLifecycleServiceInputsV1(
  service: LifecycleStatusReadPortV1,
  scope: LifecycleScopeV1,
  call: LifecycleReadCallV1,
  receipt: LifecycleMutationReceiptV1,
  operation: LifecycleOperationReadRequestV1,
): void {
  // @ts-expect-error The existing scope has no caller-selected Installation.
  const expandedScope: LifecycleScopeV1 = { ...scope, installationId: "caller-selected" };
  // @ts-expect-error A plain object is not an authenticated invocation handle.
  const minted: AuthenticatedRequestHandleV1 = {};
  // @ts-expect-error Actor strings do not supply private invocation custody.
  const actorCall: LifecycleReadCallV1 = { actorId: "actor", signal: call.signal };
  // @ts-expect-error An exact operation read requires its accepted operation locator.
  void service.readOperation(scope, call);
  // @ts-expect-error Mutation receipts are not lifecycle read calls.
  void service.readStatus(scope, receipt);
  // @ts-expect-error The original signal is readonly and cannot be replaced.
  call.signal = new AbortController().signal;
  createLifecycleStatusServiceV1({
    resolveInstallationId: () => undefined,
    // @ts-expect-error A source must implement all four existing canonical methods.
    resolveSource: () => ({ readStatus: service.readStatus }),
  });
  // @ts-expect-error A parsed operation request is not an authenticated handle.
  const requestHandle: AuthenticatedRequestHandleV1 = operation;
  void [expandedScope, minted, actorCall, requestHandle];
}
