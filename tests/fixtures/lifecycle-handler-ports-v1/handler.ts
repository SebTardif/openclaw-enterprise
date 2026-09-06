import {
  parseLifecycleAdmissionV1,
  type LifecycleMutationReceiptV1,
  type ReconcileAgentLifecycleV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import {
  parseLifecycleObservationV1,
  parseLifecycleObservationResponseV1,
  parseRuntimeEffectsV1,
  type ExactCleanupV1,
  type ExactHandoffV1,
  type LifecycleHandlerResultV1,
  type RuntimeEffectsV1,
  type WorkspaceHandoffEvidenceV1,
} from "@openclaw-enterprise/contracts/lifecycle-observation-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  LifecycleHandlerCallV1,
  LifecycleHandlerPortV1,
  LifecycleHandlerProvidersV1,
} from "@openclaw-enterprise/occ/lifecycle/handler-ports-v1";

/** Compile-only handler consumer. Actual queue/service custody is injected; this
 * function constructs no provider or permission. It makes one handler call and
 * validates its correspondence to the same original work. Errors propagate and
 * unknown results keep their exact identity; neither path automatically retries.
 */
export async function consumeOneLifecycleStep(
  handler: LifecycleHandlerPortV1,
  input: unknown,
  call: LifecycleHandlerCallV1,
): Promise<LifecycleHandlerResultV1> {
  const work = parseLifecycleAdmissionV1("workInput", input);
  const result = await handler.reconcile(work, call);
  return parseLifecycleObservationResponseV1("reconcile", work, result);
}

/** Exact readback example after the original unit has unwound. The fresh call is
 * supplied by the real service owner and checked by each existing reader. The
 * result may still be unknown/not-found; no branch issues a mutation, substitutes
 * an identity, releases a writer or retries the lifecycle POST.
 */
export async function readUnresolvedLifecycleOperation(
  providers: LifecycleHandlerProvidersV1,
  input: LifecycleHandlerResultV1,
  freshCall: () => Promise<AuthorityCallV1>,
) {
  const retained = parseLifecycleObservationV1("handlerResult", input);
  if (
    retained.kind === "observed" ||
    retained.kind === "unavailable" ||
    retained.kind === "conflict" ||
    retained.kind === "rejected"
  ) {
    throw new Error("Expected an unresolved lifecycle operation.");
  }
  const call = await freshCall();
  switch (retained.kind) {
    case "effect-unknown":
      return providers.effects.readEffect(retained.effect, call);
    case "authority-unknown":
      return providers.authority.readOperation(retained.operation, call);
    case "fence-unknown":
      // Revalidate the full retained value with its original codec. No fields
      // are reconstructed; readonly observation data gains no new authority.
      return providers.effects.readFence(
        parseRuntimeEffectsV1("fenceRequest", retained.fence),
        call,
      );
    case "cleanup-unknown":
      return providers.effectAdmission.readRequest(retained.operation, call);
  }
}

/** Reading this type does not qualify the supplied composition. The actual
 * handler must retain the original canonical provider identities and guards.
 */
export type ExistingLifecycleProviderInputs = {
  cleanup: Parameters<LifecycleHandlerProvidersV1["effects"]["stopRetainingState"]>[0];
  priorWriters: Parameters<LifecycleHandlerProvidersV1["workspace"]["observePriorWriters"]>[0];
  fault: Parameters<LifecycleHandlerProvidersV1["effectAdmission"]["recordFaultAndRequestStop"]>[0];
};

type Assert<T extends true> = T;
type AssertFalse<T extends false> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Accepted = Extract<LifecycleMutationReceiptV1, { disposition: "accepted" }>;

export type LifecycleHandlerConsumerChecks = [
  Assert<Same<Parameters<LifecycleHandlerPortV1["reconcile"]>[0], ReconcileAgentLifecycleV1>>,
  Assert<LifecycleHandlerCallV1 extends AuthorityCallV1 ? true : false>,
  Assert<Same<ExistingLifecycleProviderInputs["cleanup"], ExactCleanupV1>>,
  Assert<Same<ExistingLifecycleProviderInputs["priorWriters"], ExactHandoffV1>>,
  Assert<Same<LifecycleHandlerProvidersV1["effects"], RuntimeEffectsV1>>,
  Assert<Same<LifecycleHandlerProvidersV1["workspace"], WorkspaceHandoffEvidenceV1>>,
  AssertFalse<ReconcileAgentLifecycleV1 extends LifecycleHandlerCallV1 ? true : false>,
  AssertFalse<"requestedRevisionId" extends keyof Accepted["operation"] ? true : false>,
  AssertFalse<"authority" extends keyof LifecycleHandlerResultV1 ? true : false>,
];
