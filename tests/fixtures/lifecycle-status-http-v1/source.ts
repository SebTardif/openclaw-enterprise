import type { AuthenticatedRequestHandleV1 } from "@openclaw-enterprise/contracts/account-authority-v1";
import type { LifecycleScopeV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type { LifecycleStatusReadPortV1 } from "@openclaw-enterprise/occ/lifecycle/handler-ports-v1";
import type {
  LifecycleReadCallV1,
  LifecycleReadFailureV1,
} from "@openclaw-enterprise/occ/lifecycle/ports-v1";
import type {
  LifecycleStatusReadMethodV1,
  LifecycleStatusReadRequestV1,
  LifecycleStatusReadResultV1,
} from "@openclaw-enterprise/occ/lifecycle/status-projector-v1";

export type LifecycleStatusFixtureRepliesV1 = {
  readonly [K in LifecycleStatusReadMethodV1]: (
    request: LifecycleStatusReadRequestV1<K>,
    call: LifecycleReadCallV1,
  ) => LifecycleStatusReadResultV1<K> | Promise<LifecycleStatusReadResultV1<K>>;
};

export interface LifecycleStatusFixtureInvocationV1 {
  readonly method: LifecycleStatusReadMethodV1;
  readonly request: LifecycleScopeV1;
  readonly call: LifecycleReadCallV1;
}

/** Test-only correlation and controlled replies for exercising the real service
 * and transport. This fixture is not authentication, IAM, a repository, or an
 * observation producer. Its private map establishes only fixture membership.
 */
export function createControlledLifecycleStatusSourceV1(replies: LifecycleStatusFixtureRepliesV1) {
  const invocations: LifecycleStatusFixtureInvocationV1[] = [];
  const handles = new WeakMap<
    AuthenticatedRequestHandleV1,
    { readonly scope: LifecycleScopeV1; visibility: "visible" | "denied" | "hidden" }
  >();

  function beforeRead(
    method: LifecycleStatusReadMethodV1,
    request: LifecycleScopeV1,
    call: LifecycleReadCallV1,
  ): LifecycleReadFailureV1 | undefined {
    invocations.push(Object.freeze({ method, request, call }));
    const owned = handles.get(call.authenticated);
    if (!owned) return { kind: "rejected", code: "UNAUTHENTICATED" };
    if (
      owned.visibility === "hidden" ||
      request.namespaceId !== owned.scope.namespaceId ||
      request.agentId !== owned.scope.agentId
    )
      return { kind: "rejected", code: "NOT_FOUND" };
    if (owned.visibility === "denied") return { kind: "rejected", code: "FORBIDDEN" };
    return undefined;
  }

  const source: LifecycleStatusReadPortV1 = Object.freeze({
    async readStatus(request, call) {
      return beforeRead("readStatus", request, call) ?? (await replies.readStatus(request, call));
    },
    async readOperation(request, call) {
      return (
        beforeRead("readOperation", request, call) ?? (await replies.readOperation(request, call))
      );
    },
    async listOperations(request, call) {
      return (
        beforeRead("listOperations", request, call) ?? (await replies.listOperations(request, call))
      );
    },
    async readCapability(request, call) {
      return (
        beforeRead("readCapability", request, call) ?? (await replies.readCapability(request, call))
      );
    },
  } satisfies LifecycleStatusReadPortV1);

  return Object.freeze({
    source,
    invocations: (): readonly LifecycleStatusFixtureInvocationV1[] =>
      Object.freeze([...invocations]),
    createCall(scope: LifecycleScopeV1, signal: AbortSignal): LifecycleReadCallV1 {
      // This explicit test cast cannot mint an authentic production handle.
      const authenticated = Object.freeze({}) as AuthenticatedRequestHandleV1;
      handles.set(authenticated, { scope: Object.freeze({ ...scope }), visibility: "visible" });
      return Object.freeze({ authenticated, signal });
    },
    setVisibility(call: LifecycleReadCallV1, visibility: "visible" | "denied" | "hidden"): void {
      const owned = handles.get(call.authenticated);
      if (!owned) throw new Error("Unknown fixture call.");
      owned.visibility = visibility;
    },
  });
}
