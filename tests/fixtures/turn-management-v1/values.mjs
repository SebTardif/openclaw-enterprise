import { attempt, attemptRecord, copy } from "../turn-journal-v1/values.mjs";
import { turnCancellationDigestV1 } from "../../../packages/contracts/src/turn-management-v1.ts";

export { attempt, attemptRecord, copy };
export const versions = {
  installation: 1,
  account: 2,
  credential: 3,
  grants: 4,
  iamPolicy: 5,
  semanticMapping: 6,
  driverSelection: 7,
};
export const locator = {
  attempt,
  receiptRef: attemptRecord.binding.identity.receipt.receiptRef,
  originalPrincipalRef: attemptRecord.binding.identity.principalRef,
  callerPrincipalRef: attemptRecord.binding.identity.principalRef,
  commonGrantRef: attemptRecord.binding.identity.commonGrantRef,
};
export const invocation = {
  account: {
    schemaVersion: 1,
    installationId: attempt.installationRef,
    requestId: "req_12345678-1234-4234-8234-123456789abc",
    currentnessProfile: "account-currentness-v1",
    createdAt: "2026-09-06T12:00:00.000Z",
    deadline: "2026-09-06T12:00:05.000Z",
  },
  expectedCurrentVersions: versions,
};
export const cancellation = {
  schemaVersion: 1,
  locator,
  mode: "own",
  transactionRef: "cancel-transaction-one",
  startedAt: invocation.account.createdAt,
  deadline: invocation.account.deadline,
  expectedVersions: versions,
  operation: {
    schemaVersion: 1,
    attempt,
    operationRef: "cancel-operation-one",
    requesterPrincipalRef: locator.callerPrincipalRef,
    originalPrincipalRef: locator.originalPrincipalRef,
    expectedAttemptVersion: attemptRecord.version,
    requestDigest: "0".repeat(64),
  },
};
cancellation.operation.requestDigest = turnCancellationDigestV1(cancellation);
export const statusRequest = { schemaVersion: 1, kind: "status", invocation, locator };
export const cancellationRequest = {
  schemaVersion: 1,
  kind: "request-cancellation",
  invocation,
  cancellation,
};
export const readRequest = {
  schemaVersion: 1,
  kind: "find-cancellation",
  invocation,
  cancellation,
};
export const observedAt = "2026-09-06T12:00:01.000Z";
export function commonRecord() {
  const full = copy(attemptRecord);
  const { dispatchOperationRef, authorityDecisionRef, expiresAt, ...binding } = full.binding;
  void dispatchOperationRef;
  void authorityDecisionRef;
  void expiresAt;
  return {
    phase: "admitted-undispatched",
    binding,
    version: full.version,
    consumption: null,
    outcome: { kind: "accepted-undispatched" },
  };
}
export function redigest(identity) {
  identity.operation.requestDigest = turnCancellationDigestV1(identity);
  return identity;
}
