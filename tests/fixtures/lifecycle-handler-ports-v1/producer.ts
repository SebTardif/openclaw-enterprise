import {
  parseLifecycleAdmissionV1,
  type ReconcileAgentLifecycleV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import {
  parseLifecycleObservationResponseV1,
  type ExactCleanupV1,
  type LifecycleHandlerResultV1,
  type LifecycleStatusV1,
} from "@openclaw-enterprise/contracts/lifecycle-observation-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { LifecycleObservationProducerPortV1 } from "@openclaw-enterprise/occ/lifecycle/handler-ports-v1";

/** Independent consumer of the actual injected producer. The producer resolves
 * authoritative owned sources and verifies the supplied private service context.
 * This example neither constructs that context nor publishes caller-built proof.
 */
export async function observeLifecycleForHandlerV1(
  producer: LifecycleObservationProducerPortV1,
  input: ReconcileAgentLifecycleV1,
  call: AuthorityCallV1,
): Promise<LifecycleHandlerResultV1> {
  const work = parseLifecycleAdmissionV1("workInput", input);
  const result = await producer.observe(work, call);
  // Preserve source times and exact uncertain identities. A thrown transport
  // error supplies no non-submission proof and must not trigger a mutation retry.
  return parseLifecycleObservationResponseV1("reconcile", work, result);
}

type MustBeFalse<T extends false> = T;
type MustBeTrue<T extends true> = T;
export type ParsedObservationIsNotAuthority = MustBeFalse<
  LifecycleStatusV1 extends AuthorityCallV1 ? true : false
>;
export type ParsedWorkIsNotAuthority = MustBeFalse<
  ReconcileAgentLifecycleV1 extends AuthorityCallV1 ? true : false
>;
export type CleanupCannotPurge = MustBeFalse<
  "purge" extends ExactCleanupV1["action"] ? true : false
>;
export type CleanupMustRetainState = MustBeTrue<ExactCleanupV1["retainState"]>;
