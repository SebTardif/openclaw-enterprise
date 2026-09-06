import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { ExactRuntimeFaultV1 } from "@openclaw-enterprise/contracts/runtime-effects-v1";
import type { ImmutableContainmentControlV1 } from "@openclaw-enterprise/contracts/containment-controls-v1";
import {
  evaluateContainmentEvidenceV1,
  type ContainmentEvidenceEvaluationInputV1,
  type ContainmentEvidenceStateV1,
} from "@openclaw-enterprise/occ/containment/evidence-evaluator-v1";
import type {
  ContainmentFaultRequestAdapterV1,
  ContainmentFaultExpectedV1,
  ContainmentFaultContinuationV1,
} from "@openclaw-enterprise/occ/containment/fault-request-adapter-v1";

/** The owner retains original evidence and comparison history under its existing
 * custody. A null nextState is invalid state; do not replace it with empty state.
 * Even a satisfied comparison requires fresh checks at each accepting boundary.
 */
export function compareRetainedOriginals(
  original: ContainmentEvidenceEvaluationInputV1,
  previous: ImmutableContainmentControlV1<ContainmentEvidenceStateV1>,
) {
  return evaluateContainmentEvidenceV1(original, previous);
}

/** Only the existing responsibility owner decides that this original request is
 * new and has never been submitted. This function does not derive a fault from
 * findings, allocate an operation, or replace an existing continuation.
 */
export function prepareOriginalFault(
  adapter: ContainmentFaultRequestAdapterV1,
  originalFault: ExactRuntimeFaultV1,
  originalExpected: ContainmentFaultExpectedV1,
) {
  return adapter.prepare(originalFault, originalExpected);
}

/** Exactly one explicit attempt using the latest serially retained continuation.
 * The caller supplies a new original authorized call and retains the returned
 * continuation before any later attempt. Unknown commit allows readback only.
 * No callback here grants authority, retries, or persists a competing journal.
 */
export async function continueOriginalFault(
  adapter: ContainmentFaultRequestAdapterV1,
  latest: ContainmentFaultContinuationV1,
  originalCall: AuthorityCallV1,
) {
  if (latest.phase === "submit-allowed") return adapter.submit(latest, originalCall);
  return adapter.readback(latest, originalCall);
}
