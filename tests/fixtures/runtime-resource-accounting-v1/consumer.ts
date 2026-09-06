import {
  runtimeResourceAccountingV1,
  type RuntimeResourceAccountingEnvelopeV1,
  type RuntimeResourceAccountingResultV1,
  type RuntimeResourceAccountingV1,
  type RuntimeResourceIssueV1,
  type RuntimeResourceObservationV1,
  type RuntimeResourceVectorV1,
} from "@openclaw-enterprise/contracts/runtime-resource-accounting-v1";

type DisplayResult =
  | {
      readonly kind: "accounted";
      readonly node: RuntimeResourceVectorV1 | null;
      readonly authority: "none";
    }
  | { readonly kind: "incomplete"; readonly pending: readonly RuntimeResourceIssueV1[] }
  | { readonly kind: "invalid"; readonly problems: readonly RuntimeResourceIssueV1[] };

/** Every result remains accounting data, including the successful branch. */
export function consumeResult(result: RuntimeResourceAccountingResultV1): DisplayResult {
  const evidence: "supplied-accounting-only" = result.evidence;
  const effective: "unavailable" = result.effectiveResources;
  void evidence;
  void effective;
  switch (result.status) {
    case "accounted":
      return { kind: "accounted", node: result.totals.node, authority: "none" };
    case "incomplete":
      return { kind: "incomplete", pending: result.issues };
    case "invalid":
      return { kind: "invalid", problems: result.issues };
    default: {
      const exhaustive: never = result.status;
      return exhaustive;
    }
  }
}

export function consumeInput(
  input: unknown,
  port: RuntimeResourceAccountingV1 = runtimeResourceAccountingV1,
): DisplayResult {
  const envelope = port.parse(input);
  return consumeResult(port.validate(envelope));
}

/** This exported alias preserves the existing IFC observation variants. */
export function observationState(observation: RuntimeResourceObservationV1): string {
  switch (observation.status) {
    case "complete": {
      const eligibility: "observation-only" = observation.eligibility;
      return `${eligibility}:${observation.profile.effective.digest}`;
    }
    case "incomplete":
    case "ambiguous":
    case "unknown":
      return observation.reasonCode;
    default: {
      const exhaustive: never = observation;
      return exhaustive;
    }
  }
}

export function effectiveEvidence(
  envelope: RuntimeResourceAccountingEnvelopeV1,
): "producer-port-unavailable" {
  const state: "unavailable" = envelope.effectiveResources.status;
  void state;
  return envelope.effectiveResources.reason;
}

export function gatewayObservation(envelope: RuntimeResourceAccountingEnvelopeV1): string {
  const observation = envelope.observations.gateway;
  switch (observation.status) {
    case "supplied":
      return observationState(observation.value);
    case "required":
      return `required:${observation.ownerRef}`;
    case "unavailable":
    case "unsupported":
      return observation.reason;
    default: {
      const exhaustive: never = observation;
      return exhaustive;
    }
  }
}
