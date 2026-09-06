import type {
  AuthorityCallV1,
  ResolveAssignmentResultV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  ExactRuntimeFaultV1,
  RuntimeFaultSinkV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import type { ContainmentControlInputV1 } from "@openclaw-enterprise/contracts/containment-controls-v1";
import type {
  ContainmentEvidenceEvaluationV1,
  ContainmentEvidenceFindingV1,
} from "@openclaw-enterprise/occ/containment/evidence-evaluator-v1";
import type {
  ContainmentFaultAttemptV1,
  ContainmentFaultContinuationV1,
} from "@openclaw-enterprise/occ/containment/fault-request-adapter-v1";

declare const evaluation: ContainmentEvidenceEvaluationV1;
declare const finding: ContainmentEvidenceFindingV1;
declare const attempt: ContainmentFaultAttemptV1;
declare const continuation: ContainmentFaultContinuationV1;
declare const sink: RuntimeFaultSinkV1;
declare const call: AuthorityCallV1;
declare const input: ContainmentControlInputV1;

// @ts-expect-error Serialized fields do not construct the original trusted handle.
const context: AuthorityCallV1["context"] = { schemaVersion: 1, authenticated: true };
// @ts-expect-error A comparison is not the original correlated authority result.
const authority: ResolveAssignmentResultV1 = evaluation;
// @ts-expect-error Comparison scope cannot become an activation grant.
const grant: "activation-grant" = evaluation.scope;
// @ts-expect-error Adapter results cannot authorize ordinary admission.
const admission: "allowed" = attempt.admission;
// @ts-expect-error A durable request result does not prove downstream termination.
const stop: "terminated" = attempt.downstreamStop;
// @ts-expect-error Findings contain no original operation, guard or fault cause.
const fault: ExactRuntimeFaultV1 = finding;
// @ts-expect-error The original writer accepts only an exact original fault.
void sink.recordFaultAndRequestStop(finding, call);
// @ts-expect-error Call fields remain mandatory for original authorization correlation.
const partialCall: AuthorityCallV1 = { context: call.context, signal: call.signal };
// @ts-expect-error A names-only request cannot omit its exact execution binding.
const missingBinding: ContainmentControlInputV1["runtime"] = {
  schemaVersion: 1,
  kind: "bound-instance",
  target: input.runtime.target,
  expectedEvidenceVersion: null,
};
if (evaluation.nextState !== null) {
  // @ts-expect-error Returned state cannot be cleared to forget original ordering.
  evaluation.nextState.subjects.length = 0;
  // @ts-expect-error Nested original-producer watermarks are immutable.
  evaluation.nextState.subjects[0]!.watermarks[0]!.version = 1;
  // @ts-expect-error A caller cannot erase terminal assignment retirement.
  evaluation.nextState.retiredAssignments.pop();
}
// @ts-expect-error Findings cannot be rewritten into a different decision cause.
evaluation.findings[0]!.reasonCode = "control-ineffective";
// @ts-expect-error An uncertain continuation cannot be relabeled as safe to submit.
continuation.phase = "submit-allowed";
// @ts-expect-error Retained canonical request bytes cannot be rebased in place.
continuation.canonicalRequestJson = "{}";

void [context, authority, grant, admission, stop, fault, partialCall, missingBinding];
