import { FinalPodContainmentComparatorV1 } from "@openclaw-enterprise/occ/containment/final-pod-comparison-v1";
import {
  decodeContainmentAdmissionExchangeV1,
  decodeContainmentAdmissionInputV1,
  type ContainmentAdmissionInputV1,
  type ContainmentAdmissionResultV1,
} from "@openclaw-enterprise/contracts/containment-admission-v1";

type CandidateComparison =
  | { readonly disposition: "denied" }
  | {
      readonly disposition: "comparison-only";
      readonly input: ContainmentAdmissionInputV1;
      readonly result: ContainmentAdmissionResultV1;
      readonly requiresOriginalAdmissionAuthority: true;
    };

/** The original accepting boundary still verifies current admission and exact
 * producer-bound expected bytes. Conformance alone permits no create or update. */
export async function compareCandidate(supplied: unknown): Promise<CandidateComparison> {
  const input = decodeContainmentAdmissionInputV1(supplied);
  if (input.kind === "invalid") return { disposition: "denied" };
  if (input.value.binding.subject.stage !== "candidate") return { disposition: "denied" };
  try {
    const result = await new FinalPodContainmentComparatorV1().compare(input.value);
    const exchange = decodeContainmentAdmissionExchangeV1(input.value, result);
    if (exchange.kind === "invalid") return { disposition: "denied" };
    if (exchange.value.outcome !== "conforming") return { disposition: "denied" };
    return {
      disposition: "comparison-only",
      input: input.value,
      result: exchange.value,
      requiresOriginalAdmissionAuthority: true,
    };
  } catch {
    return { disposition: "denied" };
  }
}
