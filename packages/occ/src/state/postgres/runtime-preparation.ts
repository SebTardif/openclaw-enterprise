import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import type { BindRuntimeV1 } from "@openclaw-enterprise/contracts";
import { ScopeViolationError } from "../../errors.ts";
import type { RuntimeAssignmentReadRepository } from "../../ports/repositories/runtime-assignment.ts";
import type { RuntimeAdmissionReadRepository } from "../../ports/repositories/runtime-admission.ts";
import type {
  RuntimeAuthorityTransactionGuard,
  RuntimeAuthorityReadRepository,
} from "../../runtime-authority/repository.ts";
import {
  createRuntimePreparationRepository,
  decodeRuntimePreparationOperation,
} from "../../runtime-preparation/repository.ts";
import { parseRuntimePreparationCanonical } from "../../runtime-preparation/types.ts";

/** Private accepting-owner join. The original binding identity is held before
 * its preparation and Agent; this does not expose a public reverse reader. */
export async function lockRuntimeBindingPreparationLocatorV1(
  context: QueryRepositoryFactoryContext,
  request: BindRuntimeV1,
): Promise<Readonly<{ preparationRef: string }> | undefined> {
  context.transaction.assertActive();
  if (context.scope.installationId !== request.target.installationId)
    throw new ScopeViolationError("The binding preparation scope is unavailable.");
  await context.query.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('runtime-preparation:'||$1,0))",
    [`binding:${request.operationRef}`],
  );
  context.transaction.assertActive();
  const found = await context.query.query(
    "SELECT record FROM occ.runtime_preparation_operations WHERE binding_operation_ref=$1",
    [request.operationRef],
  );
  context.transaction.assertActive();
  if (found.rows.length === 0) return undefined;
  if (found.rows.length !== 1)
    throw new ScopeViolationError("The binding preparation identity is ambiguous.");
  const row = found.rows[0];
  if (row === null || typeof row !== "object" || !("record" in row))
    throw new ScopeViolationError("The binding preparation record is invalid.");
  const entry = decodeRuntimePreparationOperation(row.record);
  const retained = parseRuntimePreparationCanonical(entry.canonicalRequest);
  if (
    retained.kind !== "retain-binding" ||
    retained.operation.operationRef !== request.operationRef ||
    entry.target.installationId !== request.target.installationId ||
    entry.target.namespaceId !== request.target.namespaceId ||
    entry.target.agentId !== request.target.agentId ||
    entry.target.assignmentRef.id !== request.target.assignmentRef.id
  )
    throw new ScopeViolationError("The binding preparation belongs to another operation.");
  await context.query.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('runtime-preparation:'||$1,0))",
    [`preparation:${entry.preparationRef}`],
  );
  context.transaction.assertActive();
  return Object.freeze({ preparationRef: entry.preparationRef });
}

export function createPostgresRuntimePreparation(
  context: QueryRepositoryFactoryContext,
  assignments: RuntimeAssignmentReadRepository,
  admissions: RuntimeAdmissionReadRepository,
  authority: RuntimeAuthorityReadRepository,
  guard: RuntimeAuthorityTransactionGuard,
) {
  const query = async (sql: string, parameters: readonly unknown[] = []) => {
    context.transaction.assertActive();
    const result = await context.query.query(sql, parameters);
    context.transaction.assertActive();
    return result.rows.map((row) =>
      decodeRuntimePreparationOperation((row as { record: unknown }).record),
    );
  };
  return createRuntimePreparationRepository(
    {
      lock: async (input) => {
        const identities = [
          `operation:${input.operationRef}`,
          `preparation:${input.preparationRef}`,
        ];
        if (input.kind === "retain-child") identities.push(`child:${input.child.effect.effectRef}`);
        if (input.kind === "retain-binding")
          identities.push(`binding:${input.operation.operationRef}`);
        for (const identity of identities.sort()) {
          context.transaction.assertActive();
          await context.query.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('runtime-preparation:'||$1,0))",
            [identity],
          );
        }
      },
      allocation: async (scope, assignmentRef, lock) => {
        context.transaction.assertActive();
        if (lock)
          await context.query.query(
            "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR UPDATE",
            [scope.namespaceId, scope.agentId],
          );
        const allocation = await assignments.findRuntimeAllocation(scope, { assignmentRef });
        if (allocation === undefined || context.scope.installationId !== scope.installationId)
          return undefined;
        return allocation;
      },
      operation: async (ref) =>
        (
          await query(
            "SELECT record FROM occ.runtime_preparation_operations WHERE operation_ref=$1",
            [ref],
          )
        )[0],
      history: async (ref) =>
        query(
          "SELECT record FROM occ.runtime_preparation_operations WHERE preparation_ref=$1 ORDER BY local_version",
          [ref],
        ),
      identity: async (kind, ref) =>
        (
          await query(
            `SELECT record FROM occ.runtime_preparation_operations WHERE ${kind === "child" ? "child_effect_ref" : "binding_operation_ref"}=$1`,
            [ref],
          )
        )[0],
      insert: async (operation) => {
        context.transaction.assertActive();
        const request = parseRuntimePreparationCanonical(operation.canonicalRequest);
        await context.query.query(
          `INSERT INTO occ.runtime_preparation_operations
        (operation_ref, preparation_ref, installation_id, namespace_id, agent_id, assignment_ref,
         local_version, operation_kind, child_effect_ref, binding_operation_ref, canonical_request, record)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
          [
            operation.operationRef,
            operation.preparationRef,
            operation.target.installationId,
            operation.target.namespaceId,
            operation.target.agentId,
            operation.target.assignmentRef.id,
            operation.localVersion,
            operation.kind,
            request.kind === "retain-child" ? request.child.effect.effectRef : null,
            request.kind === "retain-binding" ? request.operation.operationRef : null,
            operation.canonicalRequest,
            JSON.stringify(operation),
          ],
        );
      },
    },
    assignments,
    admissions,
    authority,
    guard,
  );
}
