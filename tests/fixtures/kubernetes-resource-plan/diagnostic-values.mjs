import { observation } from "../runtime-resource-accounting-v1/observation.mjs";
import { completeObservation } from "../runtime-effects-v1/vectors.mjs";

// Representation-only runtime observation records. No fixture acts as an authenticated source.
export function diagnosticInput() {
  const result = observation();
  return {
    expected: structuredClone(result.input),
    result,
    now: "2026-01-01T00:00:01.000Z",
    previousEvidenceVersion: 1,
    operation: { status: "none" },
  };
}

export function candidateDiagnosticInput() {
  const result = completeObservation();
  return {
    expected: structuredClone(result.input),
    result,
    now: "2026-01-01T00:00:01.000Z",
    previousEvidenceVersion: null,
    operation: { status: "none" },
  };
}

export function unavailableDiagnosticInput(
  status = "incomplete",
  reasonCode = "evidence-incomplete",
) {
  const input = diagnosticInput();
  input.result = { schemaVersion: 1, status, input: structuredClone(input.expected), reasonCode };
  return input;
}
