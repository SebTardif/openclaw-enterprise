import {
  isMediationContextRef,
  parseGrantHolderV1,
  parseGrantTurnV1,
  parseModelOperationV1,
  parseModelOperations,
  parseRootGrantV1,
  sameGrantHolder,
  sameGrantTurn,
  sameModelOperation,
} from "./grant-contract.ts";
import { dataRecord, nonnegative, positive, reference } from "./validation.ts";

export type GrantConstraintReason =
  | "invalid-input"
  | "inactive"
  | "outside-validity"
  | "binding-mismatch"
  | "operation-denied"
  | "budget-exhausted";

export type GrantConstraintResult =
  | Readonly<{ result: "constraints-satisfied"; grantRef: string; operatorPolicyVersion: number }>
  | Readonly<{ result: "denied"; reason: GrantConstraintReason }>;

const policyFields = [
  "actorOperations",
  "commonOperations",
  "agentOperations",
  "operatorOperations",
] as const;

/**
 * Checks supplied constraints only. The accepting service must independently authenticate,
 * resolve current assignment/turn/IAM policy and atomically consume budget before effects.
 */
export function evaluateRootGrantConstraints(
  grantInput: unknown,
  requestInput: unknown,
  currentInput: unknown,
  nowEpochMs: number,
): GrantConstraintResult {
  const deny = (reason: GrantConstraintReason): GrantConstraintResult =>
    Object.freeze({ result: "denied", reason });
  const grant = parseRootGrantV1(grantInput);
  const request = dataRecord(requestInput, [
    "holder",
    "turn",
    "audienceRef",
    "mediationContextRef",
    "operation",
  ]);
  const current = dataRecord(currentInput, [
    ...policyFields,
    "operatorPolicyVersion",
    "usedRequests",
    "activeRequests",
  ]);
  if (!grant || !request || !current || !nonnegative(nowEpochMs)) return deny("invalid-input");
  const holder = parseGrantHolderV1(request.holder);
  const turn = parseGrantTurnV1(request.turn);
  const operation = parseModelOperationV1(request.operation);
  const policies = policyFields.map((field) => parseModelOperations(current[field]));
  if (
    !holder ||
    !turn ||
    !operation ||
    !reference(request.audienceRef) ||
    !isMediationContextRef(request.mediationContextRef) ||
    policies.some((policy) => policy === undefined) ||
    !positive(current.operatorPolicyVersion) ||
    !nonnegative(current.usedRequests) ||
    !nonnegative(current.activeRequests) ||
    current.activeRequests > current.usedRequests
  )
    return deny("invalid-input");
  if (grant.status !== "active") return deny("inactive");
  if (nowEpochMs < Date.parse(grant.notBefore) || nowEpochMs >= Date.parse(grant.expiresAt))
    return deny("outside-validity");
  if (
    !sameGrantHolder(grant.holder, holder) ||
    !sameGrantTurn(grant.turn, turn) ||
    grant.audienceRef !== request.audienceRef ||
    grant.mediationContextRef !== request.mediationContextRef
  )
    return deny("binding-mismatch");
  if (
    !grant.operations.some((allowed) => sameModelOperation(allowed, operation)) ||
    policies.some((policy) => !policy!.some((allowed) => sameModelOperation(allowed, operation)))
  )
    return deny("operation-denied");
  if (
    current.usedRequests >= grant.maxRequests ||
    current.activeRequests >= grant.maxConcurrentRequests
  )
    return deny("budget-exhausted");
  return Object.freeze({
    result: "constraints-satisfied",
    grantRef: grant.grantRef,
    operatorPolicyVersion: current.operatorPolicyVersion,
  });
}
