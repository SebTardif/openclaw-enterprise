import { randomUUID } from "node:crypto";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { WORKLOAD_PROFILE_LIMITS_V1 } from "@openclaw-enterprise/contracts/workload-profile-v1";
import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import type { WorkloadProfileRepository } from "../ports/repositories/workload-profile.ts";
import {
  PROFILE_ALLOCATION_KINDS,
  createProfilePreparation,
  decodeStoredProfilePreparation,
  normalizeProfilePreparation,
  profileActor,
  profileInstallation,
  profileLocator,
  type ProfileAllocatedIdentities,
  type ProfileCapacity,
  type ProfileIdentityAllocator,
  type ProfileOperationActor,
  type ProfileOperationLocator,
  type StoredProfilePreparation,
} from "./types.ts";

export class ProfileOperationConflictError extends ResourceConflictError {
  constructor() {
    super("The workload profile operation conflicts with retained state.");
  }
}
export class ProfileOperationCapacityError extends Error {
  constructor() {
    super("Workload profile operation capacity is unavailable.");
  }
}
/** Serializes repository work and makes every caught failure rollback-only.
 * The transaction owner must await finish before committing its working unit. */
export class WorkloadProfileTransactionGuard {
  #closed = false;
  #failed = false;
  #failure: unknown;
  #pending: Promise<void> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed)
      return Promise.reject(new ScopeViolationError("The profile transaction is closed."));
    const result = this.#pending.then(async () => {
      if (this.#failed) throw this.#failure;
      try {
        return await work();
      } catch (error) {
        this.#failed = true;
        this.#failure = error;
        throw error;
      }
    });
    this.#pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async finish(): Promise<void> {
    this.#closed = true;
    await this.#pending;
    if (this.#failed) throw this.#failure;
  }
}

/** Narrow storage seam; methods borrow the owner's connection/snapshot. No method
 * commits, evaluates IAM, or converts retained content into current authority. */
export interface WorkloadProfileBackend {
  installationId(): string;
  lockCapacity(): Promise<void>;
  capacity(): Promise<ProfileCapacity>;
  lockOperation(locator: ProfileOperationLocator): Promise<void>;
  namespaceExists(namespaceId: string): Promise<boolean>;
  operation(locator: ProfileOperationLocator): Promise<unknown | undefined>;
  insert(record: StoredProfilePreparation, capacity: ProfileCapacity): Promise<void>;
}
const allocator: ProfileIdentityAllocator = Object.freeze({ allocate: () => randomUUID() });
function validCapacity(value: ProfileCapacity): void {
  for (const n of [value.ordinaryOperations, value.pendingOrdinaryOperations, value.terminalSlots])
    if (!Number.isSafeInteger(n) || n < 0) throw new ProfileOperationCapacityError();
  if (
    value.pendingOrdinaryOperations > value.ordinaryOperations ||
    value.pendingOrdinaryOperations > WORKLOAD_PROFILE_LIMITS_V1.pendingOrdinaryOperations ||
    value.ordinaryOperations + value.terminalSlots >
      WORKLOAD_PROFILE_LIMITS_V1.operationAndTerminalSlots
  )
    throw new ProfileOperationCapacityError();
}
function exact(record: StoredProfilePreparation, locator: ProfileOperationLocator): boolean {
  return (
    record.scope.installationId === locator.installationId &&
    record.actor.principalRef === locator.actor.principalRef &&
    record.actor.accountRef === locator.actor.accountRef &&
    record.operationRef === locator.operationRef
  );
}
export function createWorkloadProfileRepository(
  backend: WorkloadProfileBackend,
  guard: WorkloadProfileTransactionGuard,
  identities: ProfileIdentityAllocator = allocator,
  now: () => string = () => new Date().toISOString(),
): WorkloadProfileRepository {
  return Object.freeze({
    findOperation: (input: ProfileOperationLocator) =>
      guard.run(async () => {
        const locator = profileLocator(input);
        if (backend.installationId() !== locator.installationId) return undefined;
        const stored = await backend.operation(locator);
        if (stored === undefined) return undefined;
        const record = decodeStoredProfilePreparation(stored);
        return exact(record, locator) ? immutableCopy(record) : undefined;
      }),
    prepareOperation: (input: unknown, attribution: ProfileOperationActor) =>
      guard.run(async () => {
        const normalized = normalizeProfilePreparation(input);
        const actor = profileActor(attribution);
        const installationId = backend.installationId();
        profileInstallation(installationId);
        const locator = { installationId, actor, operationRef: normalized.request.operationRef };
        // One Installation capacity head precedes every actor-scoped operation lock.
        await backend.lockCapacity();
        await backend.lockOperation(locator);
        const prior = await backend.operation(locator);
        if (prior !== undefined) {
          const record = decodeStoredProfilePreparation(prior);
          if (
            !exact(record, locator) ||
            record.canonicalClientIntent !== normalized.canonicalClientIntent ||
            record.clientIntentDigest !== normalized.clientIntentDigest
          )
            throw new ProfileOperationConflictError();
          return immutableCopy(record);
        }
        if (!(await backend.namespaceExists(normalized.request.namespaceId)))
          throw new ProfileOperationConflictError();
        const capacity = await backend.capacity();
        validCapacity(capacity);
        if (
          capacity.pendingOrdinaryOperations ===
            WORKLOAD_PROFILE_LIMITS_V1.pendingOrdinaryOperations ||
          capacity.ordinaryOperations + capacity.terminalSlots ===
            WORKLOAD_PROFILE_LIMITS_V1.operationAndTerminalSlots
        )
          throw new ProfileOperationCapacityError();
        // Allocation happens only after locked exact replay lookup and all capacity checks.
        const allocated = Object.fromEntries(
          PROFILE_ALLOCATION_KINDS.map((kind) => [kind, identities.allocate(kind)]),
        ) as ProfileAllocatedIdentities;
        const record = createProfilePreparation(
          installationId,
          actor,
          normalized,
          allocated,
          now(),
        );
        await backend.insert(record, {
          ordinaryOperations: capacity.ordinaryOperations + 1,
          pendingOrdinaryOperations: capacity.pendingOrdinaryOperations + 1,
          terminalSlots: capacity.terminalSlots,
        });
        return immutableCopy(record);
      }),
  });
}
