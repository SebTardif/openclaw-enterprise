import type { PlatformUnitOfWork } from "../state/platform-state.ts";
import type { GrantHolderV1, RootGrantV1 } from "./grant-contract.ts";
import type { GrantOperationV1 } from "./operation-contract.ts";

export type { GrantOperationV1 } from "./operation-contract.ts";

export type GrantCompletionV1 =
  | Readonly<{ status: "completed"; outcome: "ended" | "stopped" }>
  | Readonly<{ status: "cancelled"; outcome: "not-dispatched" }>
  | Readonly<{ status: "unknown"; outcome: "unknown" }>;

export type DelegationScope = Pick<GrantHolderV1, "installationId" | "namespaceId" | "agentId">;

export interface StoredRootGrantV1 {
  readonly grant: RootGrantV1;
  readonly version: number;
  readonly usedRequests: number;
  readonly activeRequests: number;
}

/** Private transaction-local storage contract, not authenticated service ingress. */
export interface DelegationReadRepository {
  findByContext(
    scope: DelegationScope,
    mediationContextRef: string,
  ): Promise<StoredRootGrantV1 | undefined>;
  findOperation(
    scope: DelegationScope,
    grantRef: string,
    operationRef: string,
  ): Promise<GrantOperationV1 | undefined>;
}

export interface DelegationRepository extends DelegationReadRepository {
  /** Exact immutable replay returns the prior record; changed binding conflicts. */
  insertRoot(grant: RootGrantV1): Promise<StoredRootGrantV1>;
  /** Compare-and-set; closed/revoked authority can never return to active. */
  retireRoot(
    scope: DelegationScope,
    grantRef: string,
    expectedVersion: number,
    status: "closed" | "revoked",
  ): Promise<StoredRootGrantV1>;
  /**
   * Serialize with retireRoot; recheck active state, expiry, version and shared counters.
   * Exact stable-reference replay cannot consume twice or authorize dispatch by itself.
   * This is NOT assignment/IAM/turn authorization.
   */
  acceptOperation(
    scope: DelegationScope,
    expectedVersion: number,
    operation: GrantOperationV1 & { readonly status: "accepted"; readonly dispatchedAt: null },
  ): Promise<Readonly<{ result: "accepted" | "duplicate"; operation: GrantOperationV1 }>>;
  /**
   * Under the same root lock, recheck root active/expiry/version and exact request digest,
   * then consume accepted -> dispatched before immutable dispatchBefore using database time.
   * Operation expiry is immutable and no later than grant expiry; neither deadline renews.
   * Only the first acknowledged dispatched transition permits provider bytes. A replay or
   * unknown commit is never permission to send; readback cannot rearm a consumed operation.
   */
  dispatchOperation(
    scope: DelegationScope,
    grantRef: string,
    operationRef: string,
    requestDigest: string,
    expectedVersion: number,
  ): Promise<Readonly<{ result: "dispatched" | "already-consumed"; operation: GrantOperationV1 }>>;
  /**
   * Unknown retains concurrency until reconciliation proves work ended or never dispatched.
   * Completed means confirmed ended work/exchange, including verified stop, not business success.
   * Cancelled requires guaranteed zero application bytes, even if a dispatch marker was consumed.
   * Both release concurrency once and preserve that marker; every outcome retains request charge.
   * Repeating an outcome is idempotent; only unknown may later resolve to a known outcome.
   */
  finishOperation(
    scope: DelegationScope,
    grantRef: string,
    operationRef: string,
    completion: GrantCompletionV1,
  ): Promise<GrantOperationV1>;
}

/**
 * TODO(delegated authority persistence): the canonical schema owner must supply a real
 * repository sharing this platform transaction before executable issuance is wired.
 * A separate in-memory map beside PlatformStateStore.transact does not satisfy this port.
 */
export interface DelegationTransactionHost {
  transact<T>(
    work: (unit: PlatformUnitOfWork, grants: DelegationRepository) => Promise<T>,
  ): Promise<T>;
}
