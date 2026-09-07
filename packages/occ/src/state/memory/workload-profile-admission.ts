import { immutableCopy } from "@openclaw-enterprise/utils";
import { WORKLOAD_PROFILE_LIMITS_V1 } from "@openclaw-enterprise/contracts/workload-profile-v1";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../errors.ts";
import type { MemoryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import {
  decodeWorkloadProfileAdmissionHeadV2,
  decodeWorkloadProfileAdmissionHistoryV2,
  workloadProfileInvalidationV2,
  withdrawWorkloadProfileAdmissionV2,
  type WorkloadProfileAdmissionBackendV2,
  type WorkloadProfileAdmissionHeadV2,
  type WorkloadProfileAdmissionHistoryV2,
  type WorkloadProfileInvalidationV2,
} from "../../workload-profiles/admission-record.ts";
import { profileUuid } from "../../workload-profiles/types.ts";
import {
  createMemoryWorkloadProfileBackend,
  type WorkloadProfileMemorySnapshot,
} from "./workload-profile.ts";

export interface WorkloadProfileAdmissionMemorySnapshotV2 extends WorkloadProfileMemorySnapshot {
  readonly admissions: Map<string, WorkloadProfileAdmissionHeadV2>;
  readonly history: Map<string, WorkloadProfileAdmissionHistoryV2>;
  readonly invalidations: Map<string, WorkloadProfileInvalidationV2>;
}
// Only validated closed JSON records reach this comparison. Ignore object-key
// order and prototype while preserving every value and array position.
function recordText(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

/** Uses the original clone/commit snapshot. Lock bookkeeping checks order; the
 * actual memory owner serializes whole transactions, not a second local store. */
export function createMemoryWorkloadProfileAdmissionBackendV2(
  context: MemoryRepositoryFactoryContext<WorkloadProfileAdmissionMemorySnapshotV2>,
  appendAudit: WorkloadProfileAdmissionBackendV2["appendAudit"],
): WorkloadProfileAdmissionBackendV2 {
  const preparation = createMemoryWorkloadProfileBackend(context);
  const { snapshot } = context;
  const installationId = () => preparation.installationId();
  const key = (ref: string) => JSON.stringify([installationId(), ref]);
  const lockKey = (namespaceId: string, ref: string) => JSON.stringify([namespaceId, ref]);
  const locked = new Map<string, "share" | "update">();
  const namespaces = new Set<string>();
  let capacityLocked = false;
  const own = (head: WorkloadProfileAdmissionHeadV2) => {
    context.transaction.assertActive();
    if (
      head.scope.installationId !== installationId() ||
      locked.get(lockKey(head.scope.namespaceId, head.selection.admissionRef)) !== "update"
    )
      throw new ScopeViolationError("The profile head is not locked by this owner.");
  };
  const historyKey = (head: WorkloadProfileAdmissionHeadV2) =>
    JSON.stringify([
      head.scope.installationId,
      head.selection.admissionRef,
      head.selection.admissionVersion,
    ]);
  const retainHistory = (
    head: WorkloadProfileAdmissionHeadV2,
    history: WorkloadProfileAdmissionHistoryV2,
  ) => {
    if (recordText(head) !== recordText(history.head))
      throw new ScopeViolationError("The profile history differs from its exact head.");
    if (
      snapshot.history.has(historyKey(head)) ||
      [...snapshot.history.values()].some(
        (item) =>
          item.head.scope.installationId === installationId() &&
          item.historyRef === history.historyRef,
      )
    )
      throw new ResourceConflictError("The profile history identity is immutable.");
    if (head.state === "admitted" || head.withdrawal.reason === "withdrawn") {
      const attribution = head.state === "admitted" ? head.acceptance : head.withdrawal;
      if (
        [...snapshot.history.values()].some(({ head: prior }) => {
          if (prior.state === "withdrawn" && prior.withdrawal.reason === "replaced") return false;
          const previous = prior.state === "admitted" ? prior.acceptance : prior.withdrawal;
          return (
            prior.scope.installationId === head.scope.installationId &&
            previous.actor.principalRef === attribution.actor.principalRef &&
            previous.operationRef === attribution.operationRef
          );
        })
      )
        throw new ResourceConflictError(
          "The original profile command already has a primary result.",
        );
    }
    snapshot.history.set(historyKey(head), immutableCopy(history));
  };
  return {
    ...preparation,
    lockCapacity: async () => {
      await preparation.lockCapacity();
      capacityLocked = true;
    },
    lockOperation: async (locator) => {
      if (!capacityLocked) throw new ScopeViolationError("The profile capacity prefix is missing.");
      await preparation.lockOperation(locator);
    },
    namespaceExists: async (namespaceId) => {
      const exists = await preparation.namespaceExists(namespaceId);
      if (exists) namespaces.add(namespaceId);
      return exists;
    },
    lockHeads: async (namespaceId, refsInput, mode) => {
      const refs = immutableCopy(refsInput);
      context.transaction.assertActive();
      if (
        (mode !== "share" && mode !== "update") ||
        refs.length < 1 ||
        refs.length > 2 ||
        new Set(refs).size !== refs.length ||
        (mode === "update" && (!capacityLocked || !namespaces.has(namespaceId)))
      )
        throw new ScopeViolationError("The profile head lock order is invalid.");
      for (const ref of refs) profileUuid(ref);
      for (const ref of [...refs].sort()) {
        if (locked.get(lockKey(namespaceId, ref)) === "share" && mode === "update")
          throw new ScopeViolationError("A selected-use lock cannot become a management write.");
        locked.set(lockKey(namespaceId, ref), mode);
      }
    },
    head: async (namespaceId, admissionRef) => {
      profileUuid(admissionRef);
      const head = snapshot.admissions.get(key(admissionRef));
      return head?.scope.namespaceId === namespaceId ? immutableCopy(head) : undefined;
    },
    acceptedOperation: async (locator) => {
      if (locator.installationId !== installationId()) return undefined;
      const candidates = [...snapshot.history.values()].filter(({ head }) => {
        if (
          head.scope.installationId !== installationId() ||
          (head.state === "withdrawn" && head.withdrawal.reason === "replaced")
        )
          return false;
        const attribution = head.state === "admitted" ? head.acceptance : head.withdrawal;
        return (
          attribution.actor.principalRef === locator.actor.principalRef &&
          attribution.operationRef === locator.operationRef
        );
      });
      if (candidates.length > 1)
        throw new DependencyUnavailableError("The profile command result is ambiguous.");
      return candidates[0] === undefined ? undefined : immutableCopy(candidates[0]);
    },
    insertAdmission: async (headInput, historyInput) => {
      const head = decodeWorkloadProfileAdmissionHeadV2(headInput);
      const history = decodeWorkloadProfileAdmissionHistoryV2(historyInput);
      own(head);
      if (recordText(head) !== recordText(history.head))
        throw new ScopeViolationError("The profile history differs from its exact head.");
      if (head.state !== "admitted" || head.selection.admissionVersion !== 1)
        throw new ScopeViolationError("An initial profile admission requires version one.");
      if (snapshot.admissions.has(key(head.selection.admissionRef)))
        throw new ResourceConflictError("The profile admission identity is immutable.");
      retainHistory(head, history);
      snapshot.admissions.set(key(head.selection.admissionRef), immutableCopy(head));
    },
    withdrawAdmission: async (expectedInput, headInput, historyInput, invalidationInput) => {
      const expected = decodeWorkloadProfileAdmissionHeadV2(expectedInput);
      const head = decodeWorkloadProfileAdmissionHeadV2(headInput);
      const history = decodeWorkloadProfileAdmissionHistoryV2(historyInput);
      const invalidation = immutableCopy(invalidationInput);
      if (
        head.state !== "withdrawn" ||
        expected.state !== "admitted" ||
        recordText(head) !== recordText(history.head) ||
        recordText(invalidation) !== recordText(workloadProfileInvalidationV2(head)) ||
        recordText(head) !==
          recordText(
            withdrawWorkloadProfileAdmissionV2(
              expected,
              {
                actor: head.withdrawal.actor,
                operationRef: head.withdrawal.operationRef,
                requestRef: head.withdrawal.requestRef,
                decisionRef: head.withdrawal.decisionRef,
              },
              head.withdrawal.reason,
              head.withdrawal.acceptedAt,
            ),
          )
      )
        throw new ScopeViolationError(
          "The terminal profile association differs from its original record.",
        );
      own(head);
      own(expected);
      const current = snapshot.admissions.get(key(expected.selection.admissionRef));
      if (
        expected.state !== "admitted" ||
        head.state !== "withdrawn" ||
        expected.selection.admissionVersion === Number.MAX_SAFE_INTEGER ||
        head.selection.admissionVersion !== expected.selection.admissionVersion + 1 ||
        recordText(current) !== recordText(expected)
      )
        throw new ResourceConflictError("The profile withdrawal version conflicts.");
      const { state: _state, selection: oldSelection, ...oldFixed } = expected;
      const {
        state: _terminalState,
        selection: newSelection,
        withdrawal: _withdrawal,
        ...newFixed
      } = head;
      if (
        recordText(oldFixed) !== recordText(newFixed) ||
        recordText({ ...oldSelection, admissionVersion: newSelection.admissionVersion }) !==
          recordText(newSelection)
      )
        throw new ScopeViolationError(
          "Withdrawal cannot replace the original profile association.",
        );
      if (snapshot.invalidations.has(key(head.terminal.invalidationRef)))
        throw new ResourceConflictError("The profile invalidation identity is immutable.");
      retainHistory(head, history);
      snapshot.admissions.set(key(head.selection.admissionRef), immutableCopy(head));
      snapshot.invalidations.set(key(head.terminal.invalidationRef), invalidation);
    },
    updateCapacity: async (expected, next) => {
      if (!capacityLocked) throw new ScopeViolationError("The profile capacity prefix is missing.");
      if (
        Object.values(next).some((value) => !Number.isSafeInteger(value) || value < 0) ||
        next.pendingOrdinaryOperations > next.ordinaryOperations ||
        next.pendingOrdinaryOperations > WORKLOAD_PROFILE_LIMITS_V1.pendingOrdinaryOperations ||
        next.ordinaryOperations + next.terminalSlots >
          WORKLOAD_PROFILE_LIMITS_V1.operationAndTerminalSlots
      )
        throw new ScopeViolationError("The profile capacity is invalid.");
      if (recordText(await preparation.capacity()) !== recordText(expected))
        throw new ResourceConflictError("The profile capacity changed.");
      snapshot.capacities.set(installationId(), immutableCopy(next));
    },
    appendAudit: async (attribution, history) => {
      own(history.head);
      await appendAudit(
        immutableCopy(attribution),
        decodeWorkloadProfileAdmissionHistoryV2(history),
      );
      context.transaction.assertActive();
    },
  };
}
