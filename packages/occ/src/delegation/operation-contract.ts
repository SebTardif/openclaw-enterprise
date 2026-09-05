import { parseModelOperationV1, type ModelOperationV1 } from "./grant-contract.ts";
import { dataRecord, reference, timestamp } from "./validation.ts";

export interface GrantOperationV1 {
  /** Stable 32-byte lowercase-hex reservation chosen before admission, never replaced after uncertainty. */
  readonly operationRef: string;
  readonly grantRef: string;
  readonly operation: ModelOperationV1;
  readonly requestDigest: string;
  readonly decisionRef: string;
  readonly acceptedAt: string;
  readonly dispatchBefore: string;
  readonly expiresAt: string;
  readonly dispatchedAt: string | null;
  readonly status: "accepted" | "dispatched" | "completed" | "cancelled" | "unknown";
  /** Lifecycle evidence only; ended/stopped says nothing about business success. */
  readonly outcome: "ended" | "stopped" | "not-dispatched" | "unknown" | null;
}

export function parseGrantOperationV1(input: unknown): GrantOperationV1 | undefined {
  const value = dataRecord(input, [
    "operationRef",
    "grantRef",
    "operation",
    "requestDigest",
    "decisionRef",
    "acceptedAt",
    "dispatchBefore",
    "expiresAt",
    "dispatchedAt",
    "status",
    "outcome",
  ]);
  if (!value) return undefined;
  const operation = parseModelOperationV1(value.operation);
  if (
    !operation ||
    typeof value.operationRef !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.operationRef) ||
    !reference(value.grantRef) ||
    !reference(value.decisionRef) ||
    typeof value.requestDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.requestDigest) ||
    !timestamp(value.acceptedAt) ||
    !timestamp(value.dispatchBefore) ||
    !timestamp(value.expiresAt) ||
    value.acceptedAt >= value.dispatchBefore ||
    value.dispatchBefore > value.expiresAt ||
    typeof value.status !== "string" ||
    !["accepted", "dispatched", "completed", "cancelled", "unknown"].includes(value.status)
  )
    return undefined;
  if (
    ((value.status === "accepted" || value.status === "dispatched") && value.outcome !== null) ||
    (value.status === "completed" && value.outcome !== "ended" && value.outcome !== "stopped") ||
    (value.status === "cancelled" && value.outcome !== "not-dispatched") ||
    (value.status === "unknown" && value.outcome !== "unknown")
  )
    return undefined;
  if (value.dispatchedAt !== null) {
    if (
      !timestamp(value.dispatchedAt) ||
      value.dispatchedAt < value.acceptedAt ||
      value.dispatchedAt >= value.dispatchBefore ||
      value.status === "accepted"
    )
      return undefined;
  } else if (value.status === "dispatched" || value.status === "completed") return undefined;
  return Object.freeze({ ...value, operation }) as unknown as GrantOperationV1;
}

export type OperationUseResult =
  | Readonly<{ result: "constraints-satisfied" }>
  | Readonly<{
      result: "denied";
      reason:
        "invalid-input" | "binding-mismatch" | "outside-dispatch-window" | "expired" | "inactive";
    }>;

/**
 * Checks supplied state only. Dispatch still needs an atomic first-consumer transition,
 * and both phases need fresh root/identity/turn/policy authorization by their real owners.
 */
export function evaluateOperationUse(
  operationInput: unknown,
  requestInput: unknown,
  nowEpochMs: number,
): OperationUseResult {
  const operation = parseGrantOperationV1(operationInput);
  const request = dataRecord(requestInput, ["phase", "grantRef", "operationRef", "requestDigest"]);
  const deny = (
    reason: Extract<OperationUseResult, { result: "denied" }>["reason"],
  ): OperationUseResult => Object.freeze({ result: "denied", reason });
  if (
    !operation ||
    !request ||
    !Number.isSafeInteger(nowEpochMs) ||
    nowEpochMs < 0 ||
    (request.phase !== "inspect" && request.phase !== "dispatch" && request.phase !== "continue")
  )
    return deny("invalid-input");
  if (
    request.grantRef !== operation.grantRef ||
    request.operationRef !== operation.operationRef ||
    request.requestDigest !== operation.requestDigest
  )
    return deny("binding-mismatch");
  if (nowEpochMs >= Date.parse(operation.expiresAt)) return deny("expired");
  if (
    request.phase === "dispatch" ||
    (request.phase === "inspect" && operation.status === "accepted")
  ) {
    if (operation.status !== "accepted") return deny("inactive");
    if (
      nowEpochMs < Date.parse(operation.acceptedAt) ||
      nowEpochMs >= Date.parse(operation.dispatchBefore)
    )
      return deny("outside-dispatch-window");
  } else if (operation.status !== "dispatched" || nowEpochMs < Date.parse(operation.dispatchedAt!))
    return deny("inactive");
  return Object.freeze({ result: "constraints-satisfied" });
}
