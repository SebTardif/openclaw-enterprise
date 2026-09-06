import { FinalPodContainmentComparatorV1 } from "@openclaw-enterprise/occ/containment/final-pod-comparison-v1";
import {
  decodeContainmentAdmissionExchangeV1,
  decodeContainmentAdmissionInputV1,
  type ContainmentAdmissionInputV1,
  type ContainmentAdmissionResultV1,
} from "@openclaw-enterprise/contracts/containment-admission-v1";

type ProducedComparison =
  | { readonly kind: "denied" }
  | {
      readonly kind: "comparison-only";
      readonly input: ContainmentAdmissionInputV1;
      readonly result: ContainmentAdmissionResultV1;
    };

/** Supplied documents and bindings come from the original producer. This example
 * neither creates an expectation nor authenticates the supplied policy. */
export async function compareProducerInput(supplied: unknown): Promise<ProducedComparison> {
  const input = decodeContainmentAdmissionInputV1(supplied);
  if (input.kind === "invalid") return { kind: "denied" };
  try {
    const result = await new FinalPodContainmentComparatorV1().compare(input.value);
    const exchange = decodeContainmentAdmissionExchangeV1(input.value, result);
    if (exchange.kind === "invalid") return { kind: "denied" };
    // Retain all three comparison outcomes for diagnostics, never an authority grant.
    return { kind: "comparison-only", input: input.value, result: exchange.value };
  } catch {
    return { kind: "denied" };
  }
}
