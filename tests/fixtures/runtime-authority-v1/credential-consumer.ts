import type {
  AuthorityCallV1,
  ResolveAssignmentRequestV1,
  ResolveAssignmentResultV1,
  RuntimeAssignmentAuthorityV1,
} from "../../../packages/contracts/src/index.ts";

const never = (value: never): never => {
  throw new Error("Unsupported contract variant.");
};
export function classifyPurpose(
  result: ResolveAssignmentResultV1,
):
  "separate-current-operation-authorization-required" | "candidate-only" | "cleanup-only" | "deny" {
  switch (result.result) {
    case "current":
      return "separate-current-operation-authorization-required";
    case "candidate-eligible":
      switch (result.purpose) {
        case "identity-registration":
        case "readiness-probe":
          return "candidate-only";
        case "completed-context-restore":
          switch (result.allowedSuboperation) {
            case "importCompletedContext":
            case "readImportedContext":
              return "candidate-only";
            default:
              return never(result.allowedSuboperation);
          }
        default:
          return never(result);
      }
    case "cleanup-eligible":
      return "cleanup-only";
    case "pending":
    case "not-current":
    case "not-visible":
    case "unavailable":
      return "deny";
    default:
      return never(result);
  }
}
export async function inspectModelBoundary(
  port: RuntimeAssignmentAuthorityV1,
  request: Extract<
    ResolveAssignmentRequestV1,
    { purpose: "runtime-peer" | "model-call" | "repository-issuance" }
  >,
  call: AuthorityCallV1,
) {
  // A real acceptor also binds exact scope/ref/purpose/correlation and fresh proof to this call,
  // then checks original turn/account/context/resource policy under its actual effect guard.
  return classifyPurpose(await port.resolve(request, call));
}
