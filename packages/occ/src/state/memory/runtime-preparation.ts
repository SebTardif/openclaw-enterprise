import { immutableCopy } from "@openclaw-enterprise/utils";
import type { RuntimeAllocation } from "@openclaw-enterprise/contracts";
import type { MemoryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import type { RuntimeAssignmentReadRepository } from "../../ports/repositories/runtime-assignment.ts";
import type { RuntimeAdmissionReadRepository } from "../../ports/repositories/runtime-admission.ts";
import type {
  RuntimeAuthorityTransactionGuard,
  RuntimeAuthorityReadRepository,
} from "../../runtime-authority/repository.ts";
import {
  createRuntimePreparationRepository,
  retainedRuntimePreparationRequest,
  RuntimePreparationConflictError,
} from "../../runtime-preparation/repository.ts";
import { type StoredRuntimePreparationOperation } from "../../runtime-preparation/types.ts";

export interface RuntimePreparationMemorySnapshot {
  readonly operations: Map<string, StoredRuntimePreparationOperation>;
  readonly allocations: ReadonlyMap<string, Readonly<RuntimeAllocation>>;
}
export function createMemoryRuntimePreparation(
  context: MemoryRepositoryFactoryContext<RuntimePreparationMemorySnapshot>,
  assignments: RuntimeAssignmentReadRepository,
  admissions: RuntimeAdmissionReadRepository,
  authority: RuntimeAuthorityReadRepository,
  guard: RuntimeAuthorityTransactionGuard,
) {
  const active = () => context.transaction.assertActive();
  return createRuntimePreparationRepository(
    {
      lock: async () => {
        active();
      },
      allocation: async (scope, assignmentRef) => {
        active();
        if (context.scope.installationId !== scope.installationId) return undefined;
        const allocation = context.snapshot.allocations.get(assignmentRef);
        return allocation?.installationId === scope.installationId &&
          allocation.namespaceId === scope.namespaceId &&
          allocation.agentId === scope.agentId
          ? immutableCopy(allocation)
          : undefined;
      },
      operation: async (ref) => {
        active();
        return context.snapshot.operations.get(ref);
      },
      history: async (ref) => {
        active();
        return [...context.snapshot.operations.values()]
          .filter((entry) => entry.preparationRef === ref)
          .sort((a, b) => a.localVersion - b.localVersion);
      },
      identity: async (kind, ref) => {
        active();
        return [...context.snapshot.operations.values()].find((entry) => {
          const request = retainedRuntimePreparationRequest(entry);
          return kind === "child"
            ? request.kind === "retain-child" && request.child.effect.effectRef === ref
            : request.kind === "retain-binding" && request.operation.operationRef === ref;
        });
      },
      insert: async (operation) => {
        active();
        if (context.snapshot.operations.has(operation.operationRef))
          throw new RuntimePreparationConflictError();
        context.snapshot.operations.set(operation.operationRef, immutableCopy(operation));
      },
    },
    assignments,
    admissions,
    authority,
    guard,
  );
}
