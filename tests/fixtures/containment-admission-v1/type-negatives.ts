import type {
  ContainmentAdmissionBindingV1,
  ContainmentAdmissionInputV1,
  ContainmentAdmissionResultV1,
  ContainmentAdmissionSubjectV1,
  ContainmentRawJsonValueV1,
  ContainmentRawObjectV1,
} from "@openclaw-enterprise/contracts/containment-admission-v1";
import type {
  WorkloadProfileSelectionV1,
  WorkloadProfileUseV1,
} from "@openclaw-enterprise/contracts/workload-profile-v1";
import type { RuntimeObservationResultV1 } from "@openclaw-enterprise/contracts/runtime-effects-v1";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type DeepMutable<T> = T extends readonly (infer V)[]
  ? DeepMutable<V>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;
type Candidate = Extract<ContainmentAdmissionSubjectV1, { stage: "candidate" }>;
type Observed = Extract<ContainmentAdmissionSubjectV1, { stage: "observed" }>;
type CandidateBinding = Extract<ContainmentAdmissionBindingV1, { subject: Candidate }>;
type UsedProfile = NonNullable<ContainmentAdmissionBindingV1["profileUse"]>;

// Exact equality fails if forbidden variants or replacement DTO fields are added.
export type CandidateHasOnlyPrecreateFields = Assert<
  Equal<keyof Candidate, "stage" | "requestRef" | "operation">
>;
export type CandidateProviderIdentityIsNotDue = Assert<
  Equal<CandidateBinding["serverBindings"]["providerObjects"]["status"], "not-due">
>;
export type CandidateExecutionIdentityIsNotDue = Assert<
  Equal<CandidateBinding["serverBindings"]["execution"]["status"], "not-due">
>;
export type HarnessOnly = Assert<Equal<UsedProfile["component"], "harness">>;
export type OriginalUsePreserved = Assert<Equal<DeepMutable<UsedProfile>, WorkloadProfileUseV1>>;
export type OriginalSelectionPreserved = Assert<
  Equal<DeepMutable<ContainmentAdmissionBindingV1["selection"]>, WorkloadProfileSelectionV1>
>;
export type OriginalObservationPreserved = Assert<
  Equal<DeepMutable<Observed["observation"]>, RuntimeObservationResultV1>
>;
export type ExactOutcomes = Assert<
  Equal<ContainmentAdmissionResultV1["outcome"], "conforming" | "nonconforming" | "unknown">
>;
export type ComparisonPurposeOnly = Assert<
  Equal<ContainmentAdmissionResultV1["purpose"], "comparison-only">
>;
export type ObservationEligibilityOnly = Assert<
  Equal<Extract<Observed["observation"], { status: "complete" }>["eligibility"], "observation-only">
>;

/** Compile-only rejection checks use otherwise valid assignments, so a widening
 * or loss of readonly causes an unused directive instead of an unrelated error. */
export function rejectMutations(
  input: ContainmentAdmissionInputV1,
  result: ContainmentAdmissionResultV1,
  object: ContainmentRawObjectV1,
  array: readonly ContainmentRawJsonValueV1[],
): void {
  // @ts-expect-error Target identity is recursively readonly.
  input.binding.target.revisionId = input.binding.target.revisionId;
  // @ts-expect-error Original selection is recursively readonly.
  input.binding.selection.admissionVersion = input.binding.selection.admissionVersion;
  if (input.binding.profileUse) {
    // @ts-expect-error Original profile roles are recursively readonly.
    input.binding.profileUse.profileRefs.containment.contentDigest =
      input.binding.profileUse.profileRefs.containment.contentDigest;
  }
  // @ts-expect-error The raw object index signature is readonly.
  object.unknownProviderField = null;
  // @ts-expect-error Raw array order cannot be changed after decoding.
  array[0] = null;
  // @ts-expect-error Diagnostic exclusions cannot be appended after decoding.
  input.binding.diagnosticExclusions.push("pod.metadata.creationTimestamp");
  if (input.expectation.status === "available") {
    // @ts-expect-error Expectation field coverage is readonly.
    input.expectation.fieldGroups.push("images-and-pull-policy");
  }
  const finding = result.findings[0];
  if (finding) {
    // @ts-expect-error Finding reasons cannot be rewritten after decoding.
    finding.reasonCode = finding.reasonCode;
  }
  if (input.binding.subject.stage === "observed") {
    const observation = input.binding.subject.observation;
    // @ts-expect-error The original observation target is recursively readonly.
    observation.input.target.revisionId = observation.input.target.revisionId;
  }
}

// Property-level types isolate each forbidden widening from readonly diagnostics.
// @ts-expect-error Gateway is outside the original Harness-scoped profile use.
export const forbiddenComponent: UsedProfile["component"] = "gateway";
// @ts-expect-error A comparison cannot assert admission.
export const forbiddenPurpose: ContainmentAdmissionResultV1["purpose"] = "admission";
// @ts-expect-error Eligibility is not a comparison outcome.
export const forbiddenOutcome: ContainmentAdmissionResultV1["outcome"] = "eligible";
