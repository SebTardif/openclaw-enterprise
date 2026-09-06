import type { RuntimeReadCallV1 } from "@openclaw-enterprise/contracts/runtime-effects-v1";
import type {
  ContainmentControlResultV1,
  ContainmentControlInputV1,
  ImmutableContainmentControlV1,
} from "@openclaw-enterprise/contracts/containment-controls-v1";

declare const result: ImmutableContainmentControlV1<ContainmentControlResultV1>;
declare const request: ContainmentControlInputV1;
// @ts-expect-error A serialized identity is not the original trusted call context.
const context: RuntimeReadCallV1["context"] = { schemaVersion: 1 };
// @ts-expect-error Read results cannot grant activation.
const eligibility: "eligible" = result.eligibility;
// @ts-expect-error Binding is required; names alone cannot identify an execution.
const missingBinding: ContainmentControlInputV1["runtime"] = {
  schemaVersion: 1,
  kind: "bound-instance",
  target: request.runtime.target,
  expectedEvidenceVersion: null,
};
if (result.status === "observed") {
  // @ts-expect-error Decoded nested data is immutable.
  result.controls[0]!.source.evidenceVersion = 3;
}
void [context, eligibility, missingBinding];
