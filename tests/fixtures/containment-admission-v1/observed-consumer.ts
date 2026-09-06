import {
  decodeContainmentAdmissionExchangeV1,
  type ContainmentAdmissionResultV1,
} from "@openclaw-enterprise/contracts/containment-admission-v1";
import type { RuntimeObservationResultV1 } from "@openclaw-enterprise/contracts/runtime-effects-v1";

type DeepReadonly<T> = T extends readonly (infer V)[]
  ? readonly DeepReadonly<V>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
type OriginalObservation = DeepReadonly<RuntimeObservationResultV1>;
type ObservedReview =
  | { readonly disposition: "denied" }
  | {
      readonly disposition: "comparison-only";
      readonly result: ContainmentAdmissionResultV1;
      readonly observation: OriginalObservation;
      readonly requiresOriginalRuntimeAuthority: true;
    };

/** Retain the full original observation, including provenance and observation-only
 * eligibility. Neither complete shape nor conformance grants runtime eligibility. */
export function reviewObservedComparison(input: unknown, result: unknown): ObservedReview {
  const parsed = decodeContainmentAdmissionExchangeV1(input, result);
  if (parsed.kind === "invalid") return { disposition: "denied" };
  const subject = parsed.value.binding.subject;
  if (subject.stage !== "observed") return { disposition: "denied" };
  if (parsed.value.outcome !== "conforming") return { disposition: "denied" };
  if (subject.observation.status !== "complete") return { disposition: "denied" };
  return {
    disposition: "comparison-only",
    result: parsed.value,
    observation: subject.observation,
    requiresOriginalRuntimeAuthority: true,
  };
}
