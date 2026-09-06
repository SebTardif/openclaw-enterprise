import { immutableCopy } from "@openclaw-enterprise/utils";
import { ScopeViolationError } from "../../errors.ts";
import type { MemoryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import type { PersistedNamespace } from "../../ports/repositories/namespace.ts";
import {
  createWorkloadProfileRepository,
  ProfileOperationConflictError,
  type WorkloadProfileTransactionGuard,
} from "../../workload-profiles/repository.ts";
import {
  profileOperationKey,
  PROFILE_ALLOCATION_KINDS,
  type ProfileCapacity,
  type ProfileIdentityAllocator,
  type StoredProfilePreparation,
} from "../../workload-profiles/types.ts";

export interface WorkloadProfileMemorySnapshot {
  readonly operations: Map<string, StoredProfilePreparation>;
  readonly capacities: Map<string, ProfileCapacity>;
  /** The owner's actual lifecycle records, including retained tombstones. */
  readonly namespaces: ReadonlyMap<string, Readonly<PersistedNamespace>>;
}
/** The owner supplies its isolated working snapshot and serializes commits. This
 * adapter has no shared human/account/IAM gate and cannot authorize acceptance. */
export function createMemoryWorkloadProfile(
  context: MemoryRepositoryFactoryContext<WorkloadProfileMemorySnapshot>,
  guard: WorkloadProfileTransactionGuard,
  identities?: ProfileIdentityAllocator,
  now?: () => string,
) {
  const active = () => {
    context.transaction.assertActive();
    if (context.scope.namespaceId !== undefined)
      throw new ScopeViolationError("Workload profile operations require Installation scope.");
  };
  return createWorkloadProfileRepository(
    {
      installationId: () => {
        active();
        return context.scope.installationId;
      },
      lockCapacity: async () => {
        active();
      },
      lockOperation: async () => {
        active();
      },
      capacity: async () => {
        active();
        return immutableCopy(
          context.snapshot.capacities.get(context.scope.installationId) ?? {
            ordinaryOperations: 0,
            pendingOrdinaryOperations: 0,
            terminalSlots: 0,
          },
        );
      },
      namespaceExists: async (namespaceId) => {
        active();
        const namespace = context.snapshot.namespaces.get(namespaceId);
        return namespace?.status === "ready" && namespace.deletedAt === undefined;
      },
      operation: async (locator) => {
        active();
        return context.snapshot.operations.get(profileOperationKey(locator));
      },
      insert: async (record, capacity) => {
        active();
        const key = profileOperationKey({
          installationId: record.scope.installationId,
          actor: record.actor,
          operationRef: record.operationRef,
        });
        if (context.snapshot.operations.has(key)) throw new ProfileOperationConflictError();
        // Each future identity belongs to one immutable preparation in this Installation.
        // Exact operation replay returned before insertion and does not reserve it again.
        for (const retained of context.snapshot.operations.values()) {
          if (
            retained.scope.installationId === record.scope.installationId &&
            PROFILE_ALLOCATION_KINDS.some(
              (kind) => retained.allocated[kind] === record.allocated[kind],
            )
          )
            throw new ProfileOperationConflictError();
        }
        context.snapshot.operations.set(key, immutableCopy(record));
        context.snapshot.capacities.set(context.scope.installationId, immutableCopy(capacity));
      },
    },
    guard,
    identities,
    now,
  );
}
