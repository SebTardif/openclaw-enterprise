import {
  canonicalRuntimeFaultRequestV1,
  parseRuntimeEffectsV1,
  type RuntimeAuthorityScopeV1,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../errors.ts";
import type { LifecycleAdmissionUnitPhase } from "../../lifecycle/protective-admission-unit.ts";
import { parseRuntimeFaultWorkV1 } from "../../lifecycle/runtime-fault-work-v1.ts";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import type {
  RuntimeEffectAdmissionRepository,
  RuntimeFaultStorageWriteV1,
  StoredRuntimeEffectGateV1,
  StoredRuntimeFaultRequestV1,
} from "../../ports/repositories/runtime-effect-admission.ts";
import {
  parseRuntimePreparationCanonical,
  runtimePreparationDigest,
  samePreparationValue,
} from "../../runtime-preparation/types.ts";

interface Context extends QueryRepositoryFactoryContext {
  readonly phase: LifecycleAdmissionUnitPhase;
  requireInitialized(): Promise<unknown>;
  appendAudit(input: RuntimeFaultStorageWriteV1["audit"]): Promise<void>;
}
type Row = Record<string, unknown>;
const unavailable = (): never => {
  throw new DependencyUnavailableError("The canonical runtime gate is unavailable.");
};
const conflict = (): never => {
  throw new ResourceConflictError("The canonical runtime gate or fault identity changed.");
};

function gateFromRow(row: Row): StoredRuntimeEffectGateV1 {
  if (
    typeof row.preparation_ref !== "string" ||
    typeof row.preparation_operation_ref !== "string" ||
    row.ordinary_admission !== "closed" ||
    row.sealer_admission !== "closed" ||
    (row.last_closure_operation_ref !== null && typeof row.last_closure_operation_ref !== "string")
  )
    return unavailable();
  return immutableCopy({
    schemaVersion: 1,
    preparationRef: row.preparation_ref,
    preparationOperationRef: row.preparation_operation_ref,
    target: row.target as StoredRuntimeEffectGateV1["target"],
    guard: parseRuntimeEffectsV1("gateGuard", row.gate_guard),
    plan: parseRuntimeEffectsV1("closedPlan", row.plan),
    ordinaryAdmission: "closed",
    sealerAdmission: "closed",
    lastClosureOperationRef: row.last_closure_operation_ref,
  });
}

function faultFromRow(row: Row): StoredRuntimeFaultRequestV1 {
  if (
    typeof row.fault_canonical_request !== "string" ||
    typeof row.fault_audit_id !== "string" ||
    typeof row.fault_writer_ref !== "string"
  )
    return unavailable();
  const recordedAt =
    row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at));
  if (!Number.isFinite(recordedAt.getTime())) return unavailable();
  return immutableCopy({
    schemaVersion: 1,
    fault: parseRuntimeEffectsV1("fault", row.fault_request),
    canonicalRequest: row.fault_canonical_request,
    closedGuard: parseRuntimeEffectsV1("gateGuard", row.fault_closed_guard),
    work: parseRuntimeFaultWorkV1(row.fault_work),
    auditEventId: row.fault_audit_id,
    writerRef: row.fault_writer_ref,
    recordedAt: recordedAt.toISOString(),
  });
}

/** Borrows the original state transaction. This is storage, not a public fault
 * acceptor: it neither authenticates a producer nor exposes current effect grants.
 * TODO(runtime fault composition): enter from the genuine protected fault/source
 * mutation owner before exposing RuntimeEffectAdmissionV1 service acceptance. */
export function createPostgresRuntimeEffectAdmission(
  context: Context,
): RuntimeEffectAdmissionRepository {
  const query = async (statement: string, parameters: readonly unknown[] = []): Promise<Row[]> => {
    context.transaction.assertActive();
    const result = await context.query.query(statement, parameters);
    context.transaction.assertActive();
    return result.rows as Row[];
  };
  const scopeValues = async (scope: RuntimeAuthorityScopeV1) => {
    await context.requireInitialized();
    if (scope.installationId !== context.scope.installationId) return unavailable();
    return [scope.installationId, scope.namespaceId, scope.agentId] as const;
  };
  const lockOwner = async (scope: RuntimeAuthorityScopeV1) => {
    const values = await scopeValues(scope);
    const isolation = await query("SELECT current_setting('transaction_isolation') AS isolation");
    if (isolation[0]?.isolation !== "read committed")
      throw new ScopeViolationError("Runtime gate mutations require READ COMMITTED isolation.");
    const namespaces = await query("SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE", [
      scope.namespaceId,
    ]);
    const agents = await query(
      "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR UPDATE",
      [scope.namespaceId, scope.agentId],
    );
    if (namespaces.length !== 1 || agents.length !== 1) return unavailable();
    return values;
  };
  const readGate = async (scope: RuntimeAuthorityScopeV1, locked = false) => {
    const rows = await query(
      `SELECT * FROM occ.runtime_effect_gates
      WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3${locked ? " FOR UPDATE" : ""}`,
      await scopeValues(scope),
    );
    return rows[0] === undefined ? undefined : gateFromRow(rows[0]);
  };
  return {
    findGate: (scope) => readGate(scope),
    findFaultRequest: async (input) => {
      const operation = parseRuntimeEffectsV1("faultOperation", input);
      const rows = await query(
        `SELECT * FROM occ.runtime_cleanup_responsibilities
        WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3
          AND origin_kind='runtime-fault-v1' AND origin_operation_ref=$4`,
        [...(await scopeValues(operation.scope)), operation.operationRef],
      );
      if (rows[0] === undefined) return undefined;
      const result = faultFromRow(rows[0]);
      if (!samePreparationValue(result.fault.operation, operation)) return conflict();
      return result;
    },
    retainClosedGate: async (scope, preparationOperationRef) => {
      await scopeValues(scope);
      // Match preparation's existing order. Fault/lifecycle closure below never
      // acquires this earlier prefix after taking the Agent lock.
      await query("SELECT pg_advisory_xact_lock(hashtextextended('runtime-preparation:'||$1,0))", [
        `operation:${preparationOperationRef}`,
      ]);
      const values = await lockOwner(scope);
      const original = await query(
        `SELECT * FROM occ.runtime_preparation_operations
        WHERE operation_ref=$1 AND installation_id=$2 AND namespace_id=$3 AND agent_id=$4
          AND operation_kind='retain-plan'`,
        [preparationOperationRef, ...values],
      );
      if (original.length !== 1 || typeof original[0]!.canonical_request !== "string")
        return unavailable();
      const request = parseRuntimePreparationCanonical(original[0]!.canonical_request);
      if (request.kind !== "retain-plan" || request.guard.admittedChildCutoff !== 0)
        return conflict();
      const head = await query(
        `SELECT i.* FROM occ.agent_runtime_intent_heads h
        JOIN occ.agent_runtime_intents i ON i.transition_ref=h.transition_ref
        WHERE h.namespace_id=$1 AND h.agent_id=$2 FOR SHARE OF h`,
        [scope.namespaceId, scope.agentId],
      );
      if (
        head[0]?.transition_ref !== request.guard.intentRef ||
        Number(head[0]?.generation) !== request.guard.lifecycleGeneration ||
        head[0]?.desired_mode !== request.guard.mode
      )
        return conflict();
      await query(
        `INSERT INTO occ.runtime_effect_gates
        (installation_id,namespace_id,agent_id,preparation_ref,preparation_operation_ref,target,gate_guard,plan)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)
        ON CONFLICT (installation_id,namespace_id,agent_id) DO NOTHING`,
        [
          ...values,
          request.preparationRef,
          preparationOperationRef,
          JSON.stringify(request.target),
          JSON.stringify(request.guard),
          JSON.stringify(request.plan),
        ],
      );
      const gate = await readGate(scope, true);
      if (
        !gate ||
        gate.preparationOperationRef !== preparationOperationRef ||
        !samePreparationValue(gate.guard, request.guard)
      )
        return conflict();
      return Object.freeze({ kind: "provisional", gate });
    },
    retainFaultRequest: async (input) => {
      context.phase.assertProtective();
      const fault = immutableCopy(parseRuntimeEffectsV1("fault", input.fault));
      const audit = immutableCopy(input.audit);
      const workId = input.workId;
      const canonicalRequest = canonicalRuntimeFaultRequestV1(fault);
      if (
        runtimePreparationDigest(canonicalRequest) !== fault.operation.requestDigest ||
        fault.cleanupResponsibility.responsibilityVersion !== 1
      )
        return conflict();
      const scope = fault.operation.scope;
      const values = await lockOwner(scope);
      const old = await query(
        `SELECT * FROM occ.runtime_cleanup_responsibilities
        WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3
          AND origin_kind='runtime-fault-v1' AND origin_operation_ref=$4`,
        [...values, fault.operation.operationRef],
      );
      if (old[0] !== undefined) {
        const retained = faultFromRow(old[0]);
        if (
          retained.canonicalRequest !== canonicalRequest ||
          retained.work.workId !== workId ||
          retained.auditEventId !== audit.id
        )
          return conflict();
        return Object.freeze({ kind: "exact-replay", retained });
      }
      const gate = await readGate(scope, true);
      if (
        !gate ||
        !samePreparationValue(gate.guard, fault.guard) ||
        !samePreparationValue(gate.target, fault.target)
      )
        return conflict();
      const head = await query(
        `SELECT i.* FROM occ.agent_runtime_intent_heads h
        JOIN occ.agent_runtime_intents i ON i.transition_ref=h.transition_ref
        WHERE h.namespace_id=$1 AND h.agent_id=$2 FOR SHARE OF h`,
        [scope.namespaceId, scope.agentId],
      );
      if (
        head[0]?.transition_ref !== gate.guard.intentRef ||
        Number(head[0]?.generation) !== gate.guard.lifecycleGeneration ||
        head[0]?.desired_mode !== gate.guard.mode
      )
        return conflict();
      if (
        audit.installationId !== scope.installationId ||
        audit.namespaceId !== scope.namespaceId ||
        audit.kind !== "mutation" ||
        audit.action !== "runtime.fault.request" ||
        audit.outcome !== "success" ||
        audit.resource.kind !== "agent" ||
        audit.resource.id !== scope.agentId ||
        audit.authorization !== undefined
      )
        throw new ScopeViolationError(
          "Runtime fault retention requires its independent source audit.",
        );
      const closedGuard = parseRuntimeEffectsV1("gateGuard", {
        ...gate.guard,
        gateVersion: gate.guard.gateVersion + 1,
        requestedFenceEpoch: gate.guard.requestedFenceEpoch + 1,
        responsibility: fault.cleanupResponsibility,
      });
      const work = parseRuntimeFaultWorkV1({
        schemaVersion: 2,
        handler: "ReconcileRuntimeFaultV1",
        ...scope,
        intentRef: closedGuard.intentRef,
        lifecycleGeneration: closedGuard.lifecycleGeneration,
        operationRef: fault.operation.operationRef,
        requestDigest: fault.operation.requestDigest,
        responsibilityRef: fault.cleanupResponsibility.responsibilityRef,
        responsibilityVersion: 1,
        requestedFenceEpoch: closedGuard.requestedFenceEpoch,
        gateVersion: closedGuard.gateVersion,
        workId,
      });
      await context.appendAudit(audit);
      await query(
        `INSERT INTO occ.runtime_cleanup_responsibilities
        (responsibility_ref,responsibility_version,origin_kind,origin_operation_ref,
         installation_id,namespace_id,agent_id,lifecycle_generation,kind,predecessor_ref,
         predecessor_generation,inventory_status,created_at,fault_request,fault_canonical_request,
         fault_closed_guard,fault_work,fault_audit_id,fault_writer_ref)
        VALUES($1,1,'runtime-fault-v1',$2,$3,$4,$5,$6,$7,$8,$6,'unresolved',$9,
          $10::jsonb,$11,$12::jsonb,$13::jsonb,$14,$15)`,
        [
          fault.cleanupResponsibility.responsibilityRef,
          fault.operation.operationRef,
          ...values,
          closedGuard.lifecycleGeneration,
          fault.cleanupResponsibility.kind,
          closedGuard.intentRef,
          audit.occurredAt,
          JSON.stringify(fault),
          canonicalRequest,
          JSON.stringify(closedGuard),
          JSON.stringify(work),
          audit.id,
          audit.actorId,
        ],
      );
      await query(
        `INSERT INTO occ.runtime_cleanup_responsibility_allocations
        (responsibility_ref,responsibility_version,installation_id,namespace_id,agent_id,assignment_ref)
        SELECT $1,1,installation_id,namespace_id,agent_id,assignment_ref
        FROM occ.runtime_assignment_allocations
        WHERE installation_id=$2 AND namespace_id=$3 AND agent_id=$4 AND lifecycle_generation<=$5`,
        [fault.cleanupResponsibility.responsibilityRef, ...values, closedGuard.lifecycleGeneration],
      );
      await query(
        `INSERT INTO occ.controller_work
        (idempotency_key,namespace_id,agent_id,revision_id,actor_id,runtime_transition_ref,
         lifecycle_generation,work_schema_version,handler,fault_work,state,available_at,attempt_count,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,2,'ReconcileRuntimeFaultV1',$8::jsonb,'queued',$9,0,$9,$9)`,
        [
          work.workId,
          scope.namespaceId,
          scope.agentId,
          fault.target.revisionId,
          audit.actorId,
          work.intentRef,
          work.lifecycleGeneration,
          JSON.stringify(work),
          audit.occurredAt,
        ],
      );
      const updated = await query(
        `UPDATE occ.runtime_effect_gates
        SET gate_guard=$4::jsonb,last_closure_operation_ref=$5
        WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND gate_guard=$6::jsonb RETURNING *`,
        [
          ...values,
          JSON.stringify(closedGuard),
          fault.operation.operationRef,
          JSON.stringify(gate.guard),
        ],
      );
      if (updated.length !== 1) return conflict();
      return Object.freeze({
        kind: "provisional",
        retained: immutableCopy({
          schemaVersion: 1 as const,
          fault,
          canonicalRequest,
          closedGuard,
          work,
          auditEventId: audit.id,
          writerRef: audit.actorId,
          recordedAt: audit.occurredAt,
        }),
      });
    },
  };
}
