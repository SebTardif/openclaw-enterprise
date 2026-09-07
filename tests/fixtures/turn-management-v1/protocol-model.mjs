import { turnManagementCancellationOperationMatchesV1 } from "../../../packages/contracts/src/turn-management-v1.ts";

/** Synthetic protocol model, never a journal/backend implementation. Its Map,
 * booleans and single-process final decision prove no SQL/authentication property.
 * Tests use it only to make the interface's race/readback expectations explicit. */
export class CancellationProtocolModel {
  records = new Map();
  version = 1;
  inFlight = 0;
  requesterCurrent = true;
  initiatorCurrent = true;
  publications = 0;
  async submit(identity, { wait = Promise.resolve(), unknown = false } = {}) {
    if (this.inFlight >= 32) return { kind: "overloaded" };
    this.inFlight++;
    try {
      await wait;
      if (!this.requesterCurrent) return { kind: "not-visible" };
      // Shared cancellation does not inherit the initiator's revoked authority.
      if (identity.mode === "own" && !this.initiatorCurrent) return { kind: "not-visible" };
      const previous = this.records.get(identity.operation.operationRef);
      if (previous)
        return turnManagementCancellationOperationMatchesV1(identity, previous.operation)
          ? { kind: "existing", operation: previous.operation }
          : { kind: "conflict" };
      if (identity.operation.expectedAttemptVersion !== this.version) return { kind: "conflict" };
      // One synchronous modeled final decision after every pending await.
      this.records.set(identity.operation.operationRef, structuredClone(identity));
      this.publications++;
      return unknown
        ? { kind: "commit-unknown" }
        : { kind: "recorded", operation: identity.operation };
    } finally {
      this.inFlight--;
    }
  }
  find(identity) {
    if (!this.requesterCurrent) return { kind: "not-visible" };
    const previous = this.records.get(identity.operation.operationRef);
    return previous && turnManagementCancellationOperationMatchesV1(identity, previous.operation)
      ? { kind: "found", operation: previous.operation }
      : { kind: "not-visible" };
  }
}
