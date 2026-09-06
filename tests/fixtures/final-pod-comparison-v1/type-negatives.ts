import { FinalPodContainmentComparatorV1 } from "@openclaw-enterprise/occ/containment/final-pod-comparison-v1";
import type {
  ContainmentAdmissionComparatorV1,
  ContainmentAdmissionInputV1,
  ContainmentAdmissionResultV1,
} from "@openclaw-enterprise/contracts/containment-admission-v1";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Compare = FinalPodContainmentComparatorV1["compare"];
type Result = Awaited<ReturnType<Compare>>;

// These exact checks fail on permissive any/unknown input, dependency injection,
// alternate DTOs, synchronous returns or added authority-bearing outcomes.
export type NoConstructorDependencies = Assert<
  Equal<ConstructorParameters<typeof FinalPodContainmentComparatorV1>, []>
>;
export type ExactOriginalInput = Assert<Equal<Parameters<Compare>, [ContainmentAdmissionInputV1]>>;
export type ExactOriginalAsyncResult = Assert<
  Equal<ReturnType<Compare>, Promise<ContainmentAdmissionResultV1>>
>;
export type CompleteOriginalBinding = Assert<
  Equal<Result["binding"], ContainmentAdmissionInputV1["binding"]>
>;
export type ExactComparisonOutcomes = Assert<
  Equal<Result["outcome"], "conforming" | "nonconforming" | "unknown">
>;
export type ComparisonPurposeOnly = Assert<Equal<Result["purpose"], "comparison-only">>;
export type CompleteUnknownBinding = Assert<
  Equal<Extract<Result, { outcome: "unknown" }>["binding"], Result["binding"]>
>;

export const originalComparisonPort: ContainmentAdmissionComparatorV1 =
  new FinalPodContainmentComparatorV1();

/** Compile only: no valid instance is invoked by this fixture. Rejections isolate
 * argument/type and readonly constraints rather than masking them with other errors. */
export async function rejectInvalidUses(
  comparator: FinalPodContainmentComparatorV1,
  input: ContainmentAdmissionInputV1,
  undecoded: unknown,
): Promise<void> {
  // @ts-expect-error Unknown input must pass through the canonical decoder first.
  await comparator.compare(undecoded);
  // @ts-expect-error Comparing only raw actual objects loses the original full binding.
  await comparator.compare(input.actual);
  // @ts-expect-error The pure comparator accepts no clock/provider/authority callback.
  new FinalPodContainmentComparatorV1(() => true);
  const result = await comparator.compare(input);
  // @ts-expect-error Comparison is asynchronous and cannot be used as a synchronous result.
  const synchronous: ContainmentAdmissionResultV1 = comparator.compare(input);
  void synchronous;
  // @ts-expect-error The returned original target remains deeply readonly.
  result.binding.target.revisionId = result.binding.target.revisionId;
  // @ts-expect-error Bound diagnostic exclusions cannot be rewritten by a consumer.
  result.binding.diagnosticExclusions.push("pod.metadata.creationTimestamp");
  if (result.binding.subject.stage === "observed") {
    const observation = result.binding.subject.observation;
    // @ts-expect-error Original observation target identity remains deeply readonly.
    observation.input.target.revisionId = observation.input.target.revisionId;
  }
}

// @ts-expect-error Conformance cannot be renamed to an eligibility grant.
export const forbiddenOutcome: Result["outcome"] = "eligible";
// @ts-expect-error Comparison cannot claim admission authority.
export const forbiddenPurpose: Result["purpose"] = "admission";
