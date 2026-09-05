import type { HarnessExecutionMode } from "@openclaw-enterprise/contracts/resources/agent";
import type { SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";
import { ScopeViolationError } from "../../errors.ts";

export function validExecutionMode(value: unknown): value is HarnessExecutionMode {
  return value === "embedded" || value === "dedicated";
}

export function validateModelBinding(
  bindings: SecretBindings,
  mode: HarnessExecutionMode,
  serviceAccountId?: string,
): void {
  if (
    bindings.OPENAI_API_KEY !== undefined &&
    (mode !== "embedded" || serviceAccountId !== undefined)
  )
    throw new ScopeViolationError(
      "An explicit model Secret requires an embedded Agent without a competing ServiceAccount source.",
    );
}
