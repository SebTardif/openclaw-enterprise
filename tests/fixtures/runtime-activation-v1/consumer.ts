import {
  RuntimeActivationOrchestratorV1,
  type RuntimeActivationInputV1,
  type RuntimeActivationOptionsV1,
  type RuntimeActivationResultV1,
  type RuntimeActivationStateV1,
  type RuntimeRetirementInputV1,
  type ImmutableActivationV1,
} from "@openclaw-enterprise/occ/runtime-activation-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";

// Compile the actual public consumer against all original producer interfaces.
// These declarations instantiate no authority, observer, clock or owner store.
export function consume(
  options: RuntimeActivationOptionsV1,
  activation: RuntimeActivationInputV1,
  retirement: RuntimeRetirementInputV1,
  state: ImmutableActivationV1<RuntimeActivationStateV1>,
  originalCall: AuthorityCallV1,
  independentCleanupCall: AuthorityCallV1,
  independentReadCall: AuthorityCallV1,
): readonly Promise<RuntimeActivationResultV1>[] {
  const consumer = new RuntimeActivationOrchestratorV1(options);
  return [
    consumer.activate(activation, originalCall),
    consumer.retire(retirement, independentCleanupCall),
    consumer.readOperation(state, "original-retained-operation", independentReadCall),
  ];
}

export function negativeTypes(input: RuntimeActivationInputV1, result: RuntimeActivationResultV1) {
  // @ts-expect-error Cleanup is a separate purpose and cannot enter readiness.
  input.authority.purpose = "cleanup";
  // @ts-expect-error State is immutable and cannot reset retained operations.
  input.state.operations.push({});
  // @ts-expect-error Comparison does not expose a serving publication result.
  const serving: "serving" = result.serving;
  // @ts-expect-error Complete selected controls are not a readiness boolean.
  const selection: RuntimeActivationInputV1["selection"] = true;
  return { serving, selection };
}
