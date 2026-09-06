import type { Logger } from "pino";
import type {
  LifecycleScopeV1,
  LifecycleMutationReceiptV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type { SecurityEventV1 } from "@openclaw-enterprise/contracts/security-events";
import type { LifecycleReadCallV1 } from "@openclaw-enterprise/occ/lifecycle/ports-v1";
import type { LifecycleStatusReadPortV1 } from "@openclaw-enterprise/occ/lifecycle/handler-ports-v1";
import { createOperationalDiagnosticsV1 } from "../../../apps/controller/src/diagnostics/operational-diagnostics-v1.ts";

/** Compiling composition example only. The caller supplies its original current
 * authorized reader/call and logger. This does not implement either producer. */
export async function logAuthorizedStatus(
  reader: LifecycleStatusReadPortV1,
  call: LifecycleReadCallV1,
  scope: LifecycleScopeV1,
  logger: Logger,
) {
  const result = await reader.readStatus(scope, call);
  if (result.kind !== "read") return { result, submission: null };
  const submission = createOperationalDiagnosticsV1(logger).emitLifecycleStatus(
    scope,
    result.value,
  );
  return { result, submission };
}

export function logProjectedEvent(logger: Logger, event: SecurityEventV1) {
  return createOperationalDiagnosticsV1(logger).emitSecurityEvent(event);
}

function receiptIsNotStatus(
  logger: Logger,
  scope: LifecycleScopeV1,
  receipt: LifecycleMutationReceiptV1,
) {
  // @ts-expect-error A mutation receipt contains no authorized status or observations.
  createOperationalDiagnosticsV1(logger).emitLifecycleStatus(scope, receipt);
}
void receiptIsNotStatus;
