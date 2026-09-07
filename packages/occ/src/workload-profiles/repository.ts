import { randomUUID } from "node:crypto";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { WORKLOAD_PROFILE_LIMITS_V1 } from "@openclaw-enterprise/contracts/workload-profile-v1";
import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import type { WorkloadProfileRepository } from "../ports/repositories/workload-profile.ts";
import { decodeWorkloadProfileJson } from "./canonical.ts";
import { deriveWorkloadProfileManifestV2, deriveWorkloadProfileManifest } from "./projections.ts";
import {
  PROFILE_ALLOCATION_KINDS,
  InvalidProfileOperationError,
  createProfilePreparation,
  createProfilePreparationV2,
  normalizeAnyProfilePreparation,
  normalizeProfilePreparationV2,
  type NormalizedProfilePreparationV2,
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
  type NormalizedProfilePreparation,
  type StoredProfilePreparation,
} from "./types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The envelope already claims canonical content. Normalize through the closed
 * dictionary, then require exact bytes rather than rewriting the caller's intent.
 * Computable projections identify this inert candidate; they confer no authority. */
function validateManifest(
  normalized: NormalizedProfilePreparation | NormalizedProfilePreparationV2,
): void {
  const { request } = normalized;
  const manifest =
    request.schemaVersion === 2
      ? deriveWorkloadProfileManifestV2(encoder.encode(request.manifest.canonicalUtf8))
      : deriveWorkloadProfileManifest(encoder.encode(request.manifest.canonicalUtf8));
  if (
    decoder.decode(manifest.canonicalBytes) !== request.manifest.canonicalUtf8 ||
    manifest.digests.manifestDigest !== request.manifest.manifestDigest ||
    manifest.content.target.component !== request.component
  )
    throw new InvalidProfileOperationError();
}

/** Historical lexical records also pass the current closed content boundary.
 * A self-consistent operation digest cannot substitute for manifest validation. */
function validatedStoredPreparation(input: unknown): StoredProfilePreparation {
  const record = decodeStoredProfilePreparation(input);
  const intent = decodeWorkloadProfileJson(
    encoder.encode(record.canonicalClientIntent),
    "operator-envelope",
  ).value;
  validateManifest(normalizeAnyProfilePreparation(intent));
  return record;
}

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
    if (this.#closed) {
      const error = new ScopeViolationError("The profile transaction is closed.");
      if (!this.#failed) {
        this.#failed = true;
        this.#failure = error;
      }
      return Promise.reject(error);
    }
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
  /** Original owner calls this in its final synchronous pre-COMMIT fence. */
  assertCurrent(): void {
    if (this.#failed) throw this.#failure;
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
): Pick<WorkloadProfileRepository, "prepareOperation" | "findOperation"> {
  return Object.freeze({
    findOperation: (input: ProfileOperationLocator) =>
      guard.run(async () => {
        const locator = profileLocator(input);
        if (backend.installationId() !== locator.installationId) return undefined;
        const stored = await backend.operation(locator);
        if (stored === undefined) return undefined;
        const record = validatedStoredPreparation(stored);
        return exact(record, locator) ? immutableCopy(record) : undefined;
      }),
    prepareOperation: (input: unknown, attribution: ProfileOperationActor) =>
      guard.run(async () => {
        const normalized = normalizeAnyProfilePreparation(input);
        validateManifest(normalized);
        const actor = profileActor(attribution);
        const installationId = backend.installationId();
        profileInstallation(installationId);
        const locator = { installationId, actor, operationRef: normalized.request.operationRef };
        // One Installation capacity head precedes every actor-scoped operation lock.
        await backend.lockCapacity();
        await backend.lockOperation(locator);
        const prior = await backend.operation(locator);
        if (prior !== undefined) {
          const record = validatedStoredPreparation(prior);
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
        const record =
          normalized.request.schemaVersion === 2
            ? createProfilePreparationV2(
                installationId,
                actor,
                normalizeProfilePreparationV2(normalized.request),
                allocated,
                now(),
              )
            : createProfilePreparation(
                installationId,
                actor,
                normalizeProfilePreparation(normalized.request),
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
