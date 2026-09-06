import {
  projectRuntimeResourceDiagnostics,
  type RuntimeResourceDiagnosticInput,
  type RuntimeResourceDiagnostics,
} from "../../../apps/controller/src/drivers/compute/kubernetes/resource-diagnostics.ts";

export function consumeDiagnostics(
  input: RuntimeResourceDiagnosticInput,
): RuntimeResourceDiagnostics {
  const result = projectRuntimeResourceDiagnostics(input);
  const authority: "none" = result.authority;
  const effective: "unavailable" = result.effectiveResources;
  void authority;
  void effective;
  switch (result.status) {
    case "observed":
    case "unavailable":
    case "invalid":
    case "stale":
    case "out-of-order":
      return result;
    default: {
      const exhaustive: never = result.status;
      return exhaustive;
    }
  }
}
