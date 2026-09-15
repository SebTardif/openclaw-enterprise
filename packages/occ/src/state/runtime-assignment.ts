import type { RuntimeIntent, RuntimeAllocation } from "@openclaw-enterprise/contracts";
import type { RuntimeAssignmentRepository } from "../ports/repositories/runtime-assignment.ts";
import type { StoredRuntimeAuthorityOperation } from "../runtime-authority/repository.ts";
export interface RuntimeAssignmentSnapshot {
  readonly runtimeIntents: Map<string, Readonly<RuntimeIntent>>;
  readonly runtimeHeads: Map<string, string>;
  readonly runtimeAllocations: Map<string, Readonly<RuntimeAllocation>>;
  readonly runtimeAuthorityOperations: Map<string, StoredRuntimeAuthorityOperation>;
}
export function emptyRuntimeAssignmentSnapshot(): RuntimeAssignmentSnapshot {
  return {
    runtimeIntents: new Map(),
    runtimeHeads: new Map(),
    runtimeAllocations: new Map(),
    runtimeAuthorityOperations: new Map(),
  };
}
export function cloneRuntimeAssignmentSnapshot(
  snapshot: RuntimeAssignmentSnapshot,
): RuntimeAssignmentSnapshot {
  return {
    runtimeIntents: new Map(snapshot.runtimeIntents),
    runtimeHeads: new Map(snapshot.runtimeHeads),
    runtimeAllocations: new Map(snapshot.runtimeAllocations),
    runtimeAuthorityOperations: new Map(snapshot.runtimeAuthorityOperations),
  };
}
export function serializeRuntimeAssignmentMutations(
  repository: RuntimeAssignmentRepository,
): RuntimeAssignmentRepository {
  let pending: Promise<void> = Promise.resolve();
  function mutate<T>(work: () => Promise<T>): Promise<T> {
    const result = pending.then(work);
    // A rejected CAS remains the caller's error; it must not prevent subsequent
    // independently awaited operations from examining the current stored state.
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  return {
    ...repository,
    initializeRuntimeIntent: (...args) => mutate(() => repository.initializeRuntimeIntent(...args)),
    advanceRuntimeIntent: (...args) => mutate(() => repository.advanceRuntimeIntent(...args)),
    allocateUnboundRuntime: (...args) => mutate(() => repository.allocateUnboundRuntime(...args)),
  };
}
