import {
  decodeContainmentAdmissionExchangeV1,
  type ContainmentAdmissionResultV1,
} from "@openclaw-enterprise/contracts/containment-admission-v1";

type CandidateReview =
  | { readonly disposition: "denied" }
  | {
      readonly disposition: "comparison-only";
      readonly result: ContainmentAdmissionResultV1;
      readonly requiresOriginalAdmissionAuthority: true;
    };

/** Candidate comparison never supplies future provider identity or permission to create. */
export function reviewCandidateComparison(input: unknown, result: unknown): CandidateReview {
  const parsed = decodeContainmentAdmissionExchangeV1(input, result);
  if (parsed.kind === "invalid") return { disposition: "denied" };
  if (parsed.value.binding.subject.stage !== "candidate") return { disposition: "denied" };
  if (parsed.value.outcome !== "conforming") return { disposition: "denied" };
  return {
    disposition: "comparison-only",
    result: parsed.value,
    requiresOriginalAdmissionAuthority: true,
  };
}
