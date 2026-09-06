import { FinalPodContainmentComparatorV1 } from "@openclaw-enterprise/occ/containment/final-pod-comparison-v1";
import {
  decodeContainmentAdmissionExchangeV1,
  decodeContainmentAdmissionInputV1,
  type ContainmentAdmissionInputV1,
  type ContainmentAdmissionResultV1,
} from "@openclaw-enterprise/contracts/containment-admission-v1";
import type { RuntimeObservationResultV1 } from "@openclaw-enterprise/contracts/runtime-effects-v1";

type DeepReadonly<T> = T extends readonly (infer V)[]
  ? readonly DeepReadonly<V>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
type ObservedComparison =
  | { readonly disposition: "denied" }
  | {
      readonly disposition: "comparison-only";
      readonly input: ContainmentAdmissionInputV1;
      readonly result: ContainmentAdmissionResultV1;
      readonly observation: DeepReadonly<RuntimeObservationResultV1>;
      readonly requiresOriginalRuntimeAuthority: true;
    };

/** Preserve the full input and original observation, including original times,
 * identities and observation-only eligibility. The original Runtime boundary
 * separately authenticates the producer and checks current protected-use authority. */
export async function compareObserved(supplied: unknown): Promise<ObservedComparison> {
  const input = decodeContainmentAdmissionInputV1(supplied);
  if (input.kind === "invalid") return { disposition: "denied" };
  const subject = input.value.binding.subject;
  if (subject.stage !== "observed") return { disposition: "denied" };
  if (subject.observation.status !== "complete") return { disposition: "denied" };
  try {
    const result = await new FinalPodContainmentComparatorV1().compare(input.value);
    const exchange = decodeContainmentAdmissionExchangeV1(input.value, result);
    if (exchange.kind === "invalid") return { disposition: "denied" };
    if (exchange.value.outcome !== "conforming") return { disposition: "denied" };
    return {
      disposition: "comparison-only",
      input: input.value,
      result: exchange.value,
      observation: subject.observation,
      requiresOriginalRuntimeAuthority: true,
    };
  } catch {
    return { disposition: "denied" };
  }
}
