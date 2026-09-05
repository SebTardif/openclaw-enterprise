import type {
  AuthorityCallV1,
  BindRuntimeV1,
  BindingResultV1,
  RuntimeAssignmentAuthorityV1,
  AuthorityOperationStateV1,
  ExactAuthorityOperationV1,
} from "../../../packages/contracts/src/index.ts";

const never = (value: never): never => {
  throw new Error("Unsupported contract variant.");
};
export function classifyBinding(
  result: BindingResultV1,
): "bound-observation" | "deny" | "readback-only" {
  switch (result.result) {
    case "applied":
    case "exact-replay":
      // Historical receipt proves binding admission only, never fresh runtime authority.
      return result.receipt.outcome.binding.bindingVersion === 1 ? "bound-observation" : "deny";
    case "rejected-before-effect":
    case "conflict":
      return "deny";
    case "commit-unknown":
      return "readback-only";
    default:
      return never(result);
  }
}
export function classifyReadback(
  result: AuthorityOperationStateV1,
): "receipt-only" | "deny" | "readback-only" {
  switch (result.result) {
    case "committed":
      return "receipt-only";
    case "not-found":
    case "unavailable":
      return "readback-only";
    case "not-visible":
    case "conflict":
      return "deny";
    default:
      return never(result);
  }
}
export async function submitObservedBinding(
  port: RuntimeAssignmentAuthorityV1,
  request: BindRuntimeV1,
  call: AuthorityCallV1,
) {
  return classifyBinding(await port.bind(request, call));
}
export async function inspectUnknown(
  port: RuntimeAssignmentAuthorityV1,
  request: ExactAuthorityOperationV1,
  call: AuthorityCallV1,
) {
  // This consumer has no create/rebind/retry path from unknown or missing readback.
  return classifyReadback(await port.readOperation(request, call));
}
