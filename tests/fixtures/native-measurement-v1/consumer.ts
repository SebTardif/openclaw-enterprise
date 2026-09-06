import {
  decodeNativeMeasurementResultsJsonV1,
  evaluateNativeMeasurementsV1,
} from "@openclaw-enterprise/contracts/native-measurement-codec-v1";
import type {
  NativeMeasurementEvaluationV1,
  NativeMeasurementOutcomeV1,
} from "@openclaw-enterprise/contracts/native-measurement-v1";

/** Consumer deliberately imports neither fixture producer nor its expected outcomes. */
export function consumeMeasurement(
  expectedProfile: unknown,
  serializedResults: string,
): NativeMeasurementEvaluationV1 {
  const decoded = decodeNativeMeasurementResultsJsonV1(serializedResults);
  if (decoded.kind !== "valid") throw new Error("invalid-measurement-results");
  const checked = evaluateNativeMeasurementsV1(expectedProfile, decoded.value);
  if (checked.kind !== "valid") throw new Error("measurement-expectation-mismatch");
  return checked.value;
}
export function needsFollowup(outcome: NativeMeasurementOutcomeV1): boolean {
  switch (outcome) {
    case "pass":
      return false;
    case "fail":
    case "skip":
    case "unselected":
    case "blocked":
    case "missing":
    case "unknown":
      return true;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
