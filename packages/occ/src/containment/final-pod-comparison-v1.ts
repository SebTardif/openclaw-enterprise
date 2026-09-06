import {
  CONTAINMENT_ADMISSION_LIMITS_V1,
  decodeContainmentAdmissionInputV1,
  decodeContainmentAdmissionExchangeV1,
  type ContainmentAdmissionComparatorV1,
  type ContainmentAdmissionInputV1,
  type ContainmentAdmissionResultV1,
} from "@openclaw-enterprise/contracts/containment-admission-v1";
import { inspectDocument, compareDocuments, type Finding } from "./final-pod-fields-v1.ts";

function bounded(findings: Finding[]): Finding[] {
  const unique = new Map(findings.map((f) => [`${f.reasonCode}:${f.fieldPath}`, f]));
  return [...unique.values()]
    .sort((a, b) => {
      // An unavailable reason must survive any diagnostic truncation.
      const order =
        Number(b.reasonCode.endsWith("unavailable")) - Number(a.reasonCode.endsWith("unavailable"));
      if (order) return order;
      const ak = `${a.reasonCode}:${a.fieldPath}`,
        bk = `${b.reasonCode}:${b.fieldPath}`;
      if (ak < bk) return -1;
      if (ak > bk) return 1;
      return 0;
    })
    .slice(0, CONTAINMENT_ADMISSION_LIMITS_V1.maxFindings);
}

/** Stateless bounded comparison of supplied content. No admission, producer
 * authentication, current-use lookup, provider access or runtime operation. */
export class FinalPodContainmentComparatorV1 implements ContainmentAdmissionComparatorV1 {
  async compare(input: ContainmentAdmissionInputV1): Promise<ContainmentAdmissionResultV1> {
    const decoded = decodeContainmentAdmissionInputV1(input);
    if (decoded.kind === "invalid") throw new TypeError("Invalid containment comparison input");
    const value = decoded.value;
    const { binding, expectation } = value;
    const unavailable: Finding[] = [];
    if (!binding.profileUse)
      unavailable.push({ reasonCode: "profile-use-unavailable", fieldPath: "$" });
    if (binding.expectedContentRef === null)
      unavailable.push({ reasonCode: "expectation-adapter-unavailable", fieldPath: "$" });
    for (const fact of Object.values(binding.serverBindings))
      if (fact.status === "unavailable")
        unavailable.push({ reasonCode: fact.reasonCode, fieldPath: "$" });
    if (binding.subject.stage === "observed" && binding.subject.observation.status !== "complete")
      unavailable.push({ reasonCode: "observation-unavailable", fieldPath: "$" });
    if (expectation.status === "unavailable")
      unavailable.push({ reasonCode: expectation.reasonCode, fieldPath: "$" });
    let mismatches: Finding[] = [];
    if (expectation.status === "available") {
      const expectedFindings = inspectDocument(expectation.document, binding);
      for (const finding of expectedFindings)
        unavailable.push({
          reasonCode:
            finding.reasonCode === "required-field-absent"
              ? "static-input-unavailable"
              : "normalization-unavailable",
          fieldPath: finding.fieldPath,
        });
      if (unavailable.length === 0)
        mismatches = [
          ...inspectDocument(value.actual, binding),
          ...compareDocuments(value.actual, expectation.document, binding.diagnosticExclusions),
        ];
    }
    let result: ContainmentAdmissionResultV1;
    if (unavailable.length > 0)
      result = {
        binding,
        purpose: "comparison-only",
        outcome: "unknown",
        findings: bounded(unavailable),
      };
    else if (mismatches.length > 0)
      result = {
        binding,
        purpose: "comparison-only",
        outcome: "nonconforming",
        findings: bounded(mismatches),
      };
    else result = { binding, purpose: "comparison-only", outcome: "conforming", findings: [] };
    const exchange = decodeContainmentAdmissionExchangeV1(value, result);
    if (exchange.kind === "invalid") throw new TypeError("Invalid containment comparison result");
    return exchange.value;
  }
}
