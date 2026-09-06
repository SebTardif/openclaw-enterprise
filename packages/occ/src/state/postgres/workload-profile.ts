import { DependencyUnavailableError, ScopeViolationError } from "../../errors.ts";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import {
  createWorkloadProfileRepository,
  type WorkloadProfileTransactionGuard,
} from "../../workload-profiles/repository.ts";
import {
  profileOperationKey,
  type ProfileCapacity,
  type ProfileIdentityAllocator,
} from "../../workload-profiles/types.ts";

function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new DependencyUnavailableError("Persisted workload profile state is invalid.");
  return value as Record<string, unknown>;
}

/** Retains inert preparations on the owner's Installation-scoped connection.
 * The owner acquires the capacity/operation prefix before any Namespace locks
 * and drains the profile guard before commit. No authentication gate is supplied. */
export function createPostgresWorkloadProfile(
  context: QueryRepositoryFactoryContext,
  guard: WorkloadProfileTransactionGuard,
  identities?: ProfileIdentityAllocator,
  now?: () => string,
) {
  const installationId = () => {
    context.transaction.assertActive();
    if (context.scope.namespaceId !== undefined)
      throw new ScopeViolationError("Workload profile operations require Installation scope.");
    return context.scope.installationId;
  };
  const query = async (statement: string, parameters: readonly unknown[] = []) => {
    context.transaction.assertActive();
    const result = await context.query.query(statement, parameters);
    context.transaction.assertActive();
    return result;
  };
  return createWorkloadProfileRepository(
    {
      installationId,
      lockCapacity: async () => {
        const scope = installationId();
        // The advisory lock also serializes the first creation of an absent head.
        await query(
          "SELECT pg_advisory_xact_lock(hashtextextended('workload-profile-capacity:' || $1, 0))",
          [scope],
        );
        await query(
          `INSERT INTO occ.workload_profile_capacity
            (installation_id, ordinary_operations, pending_ordinary_operations, terminal_slots)
           VALUES ($1, 0, 0, 0) ON CONFLICT (installation_id) DO NOTHING`,
          [scope],
        );
        const locked = await query(
          "SELECT installation_id FROM occ.workload_profile_capacity WHERE installation_id=$1 FOR UPDATE",
          [scope],
        );
        if (locked.rowCount !== 1)
          throw new DependencyUnavailableError(
            "The workload profile capacity head is unavailable.",
          );
      },
      lockOperation: async (locator) => {
        await query(
          "SELECT pg_advisory_xact_lock(hashtextextended('workload-profile-operation:' || $1, 0))",
          [profileOperationKey(locator)],
        );
      },
      capacity: async () => {
        const result = await query(
          `SELECT ordinary_operations, pending_ordinary_operations, terminal_slots
           FROM occ.workload_profile_capacity WHERE installation_id=$1`,
          [installationId()],
        );
        if (result.rows.length !== 1)
          throw new DependencyUnavailableError(
            "The workload profile capacity head is unavailable.",
          );
        const value = row(result.rows[0]);
        // PostgreSQL int4 values arrive as numbers; the shared repository checks
        // the complete quota relation before allocation.
        return {
          ordinaryOperations: value.ordinary_operations,
          pendingOrdinaryOperations: value.pending_ordinary_operations,
          terminalSlots: value.terminal_slots,
        } as ProfileCapacity;
      },
      namespaceExists: async (namespaceId) => {
        const result = await query(
          `SELECT id FROM occ.namespaces
           WHERE id=$1 AND status='ready' AND deleted_at IS NULL FOR UPDATE`,
          [namespaceId],
        );
        return result.rowCount === 1;
      },
      operation: async (locator) => {
        if (installationId() !== locator.installationId) return undefined;
        // Account is deliberately outside this unique key. The shared decoder
        // compares it before readback and rejects changed-account preparation.
        const result = await query(
          `SELECT record FROM occ.workload_profile_operations
           WHERE installation_id=$1 AND principal_ref=$2 AND operation_ref=$3`,
          [locator.installationId, locator.actor.principalRef, locator.operationRef],
        );
        if (result.rows.length > 1)
          throw new DependencyUnavailableError(
            "Persisted workload profile identity is not unique.",
          );
        return result.rows.length === 0 ? undefined : row(result.rows[0]).record;
      },
      insert: async (record, capacity) => {
        if (record.scope.installationId !== installationId())
          throw new ScopeViolationError("The workload profile does not belong to the transaction.");
        const inserted = await query(
          `INSERT INTO occ.workload_profile_operations
            (installation_id, namespace_id, principal_ref, account_ref, operation_ref, record)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            record.scope.installationId,
            record.scope.namespaceId,
            record.actor.principalRef,
            record.actor.accountRef,
            record.operationRef,
            JSON.stringify(record),
          ],
        );
        if (inserted.rowCount !== 1)
          throw new DependencyUnavailableError(
            "The workload profile preparation was not retained.",
          );
        const updated = await query(
          `UPDATE occ.workload_profile_capacity
           SET ordinary_operations=$2, pending_ordinary_operations=$3, terminal_slots=$4
           WHERE installation_id=$1 AND ordinary_operations=$2-1
             AND pending_ordinary_operations=$3-1 AND terminal_slots=$4`,
          [
            record.scope.installationId,
            capacity.ordinaryOperations,
            capacity.pendingOrdinaryOperations,
            capacity.terminalSlots,
          ],
        );
        if (updated.rowCount !== 1)
          throw new DependencyUnavailableError("The workload profile capacity update conflicted.");
      },
    },
    guard,
    identities,
    now,
  );
}
