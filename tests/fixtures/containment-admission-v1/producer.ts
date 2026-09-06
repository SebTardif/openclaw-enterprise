import {
  decodeContainmentAdmissionExchangeV1,
  decodeContainmentAdmissionInputV1,
  type ContainmentAdmissionComparatorV1,
  type ContainmentAdmissionDecodeResultV1,
  type ContainmentAdmissionResultV1,
} from "@openclaw-enterprise/contracts/containment-admission-v1";

/** The original producer supplies actual input; the injected comparator owns comparison.
 * A valid return establishes structural correlation only, never admission authority. */
export async function compareSuppliedInput(
  actualInput: unknown,
  comparator: ContainmentAdmissionComparatorV1,
): Promise<ContainmentAdmissionDecodeResultV1<ContainmentAdmissionResultV1>> {
  const parsed = decodeContainmentAdmissionInputV1(actualInput);
  if (parsed.kind === "invalid") return parsed;
  const result = await comparator.compare(parsed.value);
  return decodeContainmentAdmissionExchangeV1(parsed.value, result);
}
