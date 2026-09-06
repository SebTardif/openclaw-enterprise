import type { AuditEvent } from "@openclaw-enterprise/contracts/identity/audit";
import type {
  RuntimeAllocation,
  RuntimeIntent,
} from "@openclaw-enterprise/contracts/runtime-assignment";
import { parseLifecycleAdmissionV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../errors.ts";
import {
  copyProtectiveWrite,
  protectiveIntentDecision,
  protectiveRecord,
  retainedProtectiveRecordMatches,
} from "../../lifecycle/protective-admission-v1.ts";
import type { LifecycleAdmissionUnitPhase } from "../../lifecycle/protective-admission-unit.ts";
import type {
  LifecycleAdmissionRepository,
  ProtectiveAdmissionRecordV1,
} from "../../ports/repositories/lifecycle-admission.ts";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";

type Row = Record<string, unknown>;
interface Context extends QueryRepositoryFactoryContext {
  readonly phase: LifecycleAdmissionUnitPhase;
  readonly requireInitialized: () => Promise<unknown>;
  readonly appendAudit: (event: AuditEvent) => Promise<void>;
  readonly intentFromRow: (row: Row) => Readonly<RuntimeIntent>;
  readonly allocationFromRow: (row: Row) => Readonly<RuntimeAllocation>;
  readonly auditFromRow: (row: Row, installationId: string) => Readonly<AuditEvent>;
}
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DependencyUnavailableError("The lifecycle persistence row is invalid.");
  return value as Row;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.length)
    throw new DependencyUnavailableError("The lifecycle persistence identity is invalid.");
  return value;
}
function date(value: unknown): Date {
  const result = value instanceof Date ? new Date(value) : new Date(text(value));
  if (!Number.isFinite(result.getTime()))
    throw new DependencyUnavailableError("The lifecycle persistence date is invalid.");
  return result;
}

/** Uses only the original owner's guarded connection, decoders and audit serializer. */
export function createPostgresLifecycleAdmission(context: Context): LifecycleAdmissionRepository {
  const query = async (sql: string, parameters: readonly unknown[] = []): Promise<Row[]> => {
    context.transaction.assertActive();
    const result = await context.query.query(sql, parameters);
    context.transaction.assertActive();
    return result.rows.map(row);
  };
  async function owner(namespaceId: string, agentId: string, lock: boolean): Promise<string> {
    await context.requireInitialized();
    const installationId = context.scope.installationId;
    if (lock) {
      const isolation = await query("SELECT current_setting('transaction_isolation') AS isolation");
      if (isolation[0]?.isolation !== "read committed")
        throw new ScopeViolationError("Protective admission requires READ COMMITTED isolation.");
    }
    const namespace = await query(
      `SELECT id FROM occ.namespaces WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [namespaceId],
    );
    const agent = await query(
      `SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
      [namespaceId, agentId],
    );
    if (namespace.length !== 1 || agent.length !== 1)
      throw new ScopeViolationError("The protective runtime owner is unavailable.");
    return installationId;
  }
  return {
    findCommitted: async (scope, operationRef) => {
      const installationId = await owner(scope.namespaceId, scope.agentId, false);
      const found = await query(
        "SELECT * FROM occ.agent_lifecycle_admissions WHERE operation_ref=$1 AND installation_id=$2 AND namespace_id=$3 AND agent_id=$4",
        [operationRef, installationId, scope.namespaceId, scope.agentId],
      );
      const admission = found[0];
      if (!admission) return undefined;
      const intentRow = (
        await query(
          "SELECT * FROM occ.agent_runtime_intents WHERE transition_ref=$1 AND admission_version=1",
          [operationRef],
        )
      )[0];
      const work = (
        await query(
          "SELECT * FROM occ.controller_work WHERE idempotency_key=$1 AND work_schema_version=1 AND handler='ReconcileAgentLifecycleV1'",
          [admission.work_id],
        )
      )[0];
      const audit = (
        await query("SELECT * FROM occ.audit_events WHERE id=$1", [admission.audit_event_id])
      )[0];
      const cleanup = (
        await query(
          "SELECT * FROM occ.runtime_cleanup_responsibilities WHERE responsibility_ref=$1 AND responsibility_version=$2",
          [admission.responsibility_ref, admission.responsibility_version],
        )
      )[0];
      const outbox = (
        await query("SELECT * FROM occ.audit_export_outbox WHERE audit_event_id=$1", [
          admission.audit_event_id,
        ])
      )[0];
      if (!intentRow || !work || !audit || !cleanup || !outbox) return undefined;
      const intent = context.intentFromRow(intentRow);
      const predecessor =
        cleanup.predecessor_ref === null
          ? null
          : {
              transitionRef: text(cleanup.predecessor_ref),
              generation: Number(cleanup.predecessor_generation),
            };
      if (predecessor !== null) {
        const previous = (
          await query(
            "SELECT * FROM occ.agent_runtime_intents WHERE transition_ref=$1 AND namespace_id=$2 AND agent_id=$3 AND generation=$4",
            [predecessor.transitionRef, scope.namespaceId, scope.agentId, predecessor.generation],
          )
        )[0];
        if (
          !previous ||
          previous.installation_id !== installationId ||
          previous.revision_id !== intent.revisionId
        )
          return undefined;
      }
      const allocations = (
        await query(
          `SELECT a.* FROM occ.runtime_cleanup_responsibility_allocations m
        JOIN occ.runtime_assignment_allocations a ON a.assignment_ref=m.assignment_ref
          AND a.installation_id=m.installation_id AND a.namespace_id=m.namespace_id AND a.agent_id=m.agent_id
        WHERE m.responsibility_ref=$1 AND m.responsibility_version=$2 ORDER BY a.assignment_ref`,
          [admission.responsibility_ref, admission.responsibility_version],
        )
      ).map(context.allocationFromRow);
      const retained: ProtectiveAdmissionRecordV1 = {
        association: parseLifecycleAdmissionV1("association", {
          schemaVersion: 1,
          request: admission.canonical_request,
          intent,
          auditEventId: admission.audit_event_id,
          workId: admission.work_id,
        }),
        work: {
          schemaVersion: 1,
          input: parseLifecycleAdmissionV1("workInput", {
            schemaVersion: 1,
            handler: work.handler,
            namespaceId: work.namespace_id,
            agentId: work.agent_id,
            operationRef: work.runtime_transition_ref,
            lifecycleGeneration: Number(work.lifecycle_generation),
            workId: work.idempotency_key,
          }),
          row: {
            idempotencyKey: text(work.idempotency_key),
            namespaceId: text(work.namespace_id),
            agentId: text(work.agent_id),
            ...(work.revision_id === null ? {} : { revisionId: text(work.revision_id) }),
            runtimeTransitionRef: text(work.runtime_transition_ref),
            lifecycleGeneration: Number(work.lifecycle_generation),
            actorId: text(work.actor_id),
            state: text(work.state) as ProtectiveAdmissionRecordV1["work"]["row"]["state"],
            availableAt: date(work.available_at),
            attemptCount: Number(work.attempt_count),
            ...(work.claim_token === null ? {} : { claimToken: text(work.claim_token) }),
            ...(work.lease_expires_at === null
              ? {}
              : { leaseExpiresAt: date(work.lease_expires_at) }),
            ...(work.completed_at === null ? {} : { completedAt: date(work.completed_at) }),
            createdAt: date(work.created_at),
            updatedAt: date(work.updated_at),
          },
        },
        audit: context.auditFromRow(audit, installationId),
        cleanup: {
          installationId: text(cleanup.installation_id),
          namespaceId: text(cleanup.namespace_id),
          agentId: text(cleanup.agent_id),
          responsibilityRef: text(cleanup.responsibility_ref),
          responsibilityVersion: Number(cleanup.responsibility_version) as 1,
          originKind: text(cleanup.origin_kind) as "lifecycle-protective-v1",
          originOperationRef: text(cleanup.origin_operation_ref),
          lifecycleGeneration: Number(cleanup.lifecycle_generation),
          kind: text(cleanup.kind) as "protective-fence" | "retained-stop",
          predecessor,
          inventoryStatus: text(cleanup.inventory_status) as "unresolved",
          createdAt: date(cleanup.created_at).toISOString(),
          allocations,
        },
        export: {
          auditEventId: text(outbox.audit_event_id),
          installationId: text(outbox.installation_id),
          namespaceId: text(outbox.namespace_id),
          originKind: text(outbox.origin_kind) as "lifecycle-protective-v1",
          originOperationRef: text(outbox.origin_operation_ref),
          state: text(outbox.state) as "pending",
          createdAt: date(outbox.created_at).toISOString(),
        },
      };
      if (
        work.namespace_target !== null ||
        admission.kind !== retained.association.request.kind ||
        Number(admission.lifecycle_generation) !== intent.generation ||
        (admission.expected_generation === null ? null : Number(admission.expected_generation)) !==
          retained.association.request.expectedLifecycleGeneration
      )
        return undefined;
      return retainedProtectiveRecordMatches(retained) ? immutableCopy(retained) : undefined;
    },
    applyProtective: async (value) => {
      context.phase.assertProtective();
      const input = copyProtectiveWrite(value);
      const { namespaceId, agentId } = input.request;
      // TODO: the actual account participant enters here, before resource locks, in this same unit.
      const installationId = await owner(namespaceId, agentId, true);
      if (
        (
          await query(
            "SELECT transition_ref FROM occ.agent_runtime_intents WHERE transition_ref=$1",
            [input.transitionRef],
          )
        ).length
      )
        throw new ResourceConflictError("The original lifecycle operation already exists.");
      const headRow = (
        await query(
          `SELECT i.* FROM occ.agent_runtime_intent_heads h
        JOIN occ.agent_runtime_intents i ON i.transition_ref=h.transition_ref
        WHERE h.namespace_id=$1 AND h.agent_id=$2 FOR UPDATE OF h`,
          [namespaceId, agentId],
        )
      )[0];
      const head = headRow ? context.intentFromRow(headRow) : undefined;
      if (
        !head &&
        (
          await query(
            "SELECT 1 FROM occ.agent_runtime_intents WHERE namespace_id=$1 AND agent_id=$2 LIMIT 1",
            [namespaceId, agentId],
          )
        ).length
      )
        throw new ResourceConflictError("A prior runtime lineage cannot be reinitialized.");
      const decision = protectiveIntentDecision(
        input,
        installationId,
        head,
        new Date().toISOString(),
      );
      if ("kind" in decision) return decision;
      const allocations = (
        await query(
          "SELECT * FROM occ.runtime_assignment_allocations WHERE namespace_id=$1 AND agent_id=$2 ORDER BY assignment_ref",
          [namespaceId, agentId],
        )
      ).map(context.allocationFromRow);
      if (
        allocations.some(
          (item) =>
            item.installationId !== installationId ||
            !head ||
            item.lifecycleGeneration > head.generation,
        )
      )
        throw new ScopeViolationError("The retained runtime allocation lineage is incomplete.");
      const retained = protectiveRecord(input, decision, head, allocations);
      await query(
        `INSERT INTO occ.agent_runtime_intents
        (transition_ref,installation_id,namespace_id,agent_id,generation,desired_mode,revision_id,actor_id,request_id,created_at,admission_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)`,
        [
          input.transitionRef,
          installationId,
          namespaceId,
          agentId,
          decision.generation,
          decision.desiredMode,
          decision.revisionId,
          decision.actorId,
          decision.requestId,
          decision.createdAt,
        ],
      );
      await context.appendAudit(input.audit);
      await query(
        `INSERT INTO occ.agent_lifecycle_admissions
        (operation_ref,installation_id,namespace_id,agent_id,lifecycle_generation,kind,expected_generation,canonical_request,audit_event_id,work_id,responsibility_ref,responsibility_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,1)`,
        [
          input.transitionRef,
          installationId,
          namespaceId,
          agentId,
          decision.generation,
          input.request.kind,
          input.request.expectedLifecycleGeneration,
          JSON.stringify(input.request),
          input.audit.id,
          input.workId,
          input.responsibilityRef,
        ],
      );
      await query(
        `INSERT INTO occ.runtime_cleanup_responsibilities
        (responsibility_ref,responsibility_version,origin_kind,origin_operation_ref,installation_id,namespace_id,agent_id,lifecycle_generation,kind,predecessor_ref,predecessor_generation,inventory_status,created_at)
        VALUES ($1,1,'lifecycle-protective-v1',$2,$3,$4,$5,$6,$7,$8,$9,'unresolved',$10)`,
        [
          input.responsibilityRef,
          input.transitionRef,
          installationId,
          namespaceId,
          agentId,
          decision.generation,
          retained.cleanup.kind,
          head?.transitionRef ?? null,
          head?.generation ?? null,
          decision.createdAt,
        ],
      );
      for (const allocation of allocations)
        await query(
          `INSERT INTO occ.runtime_cleanup_responsibility_allocations
          (responsibility_ref,responsibility_version,installation_id,namespace_id,agent_id,assignment_ref)
          VALUES ($1,1,$2,$3,$4,$5)`,
          [input.responsibilityRef, installationId, namespaceId, agentId, allocation.assignmentRef],
        );
      await query(
        `INSERT INTO occ.audit_export_outbox
        (audit_event_id,installation_id,namespace_id,origin_kind,origin_operation_ref,state,created_at)
        VALUES ($1,$2,$3,'lifecycle-protective-v1',$4,'pending',$5)`,
        [input.audit.id, installationId, namespaceId, input.transitionRef, decision.createdAt],
      );
      await query(
        `INSERT INTO occ.controller_work
        (idempotency_key,namespace_id,agent_id,revision_id,actor_id,runtime_transition_ref,lifecycle_generation,
         work_schema_version,handler,state,available_at,attempt_count,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,1,'ReconcileAgentLifecycleV1','queued',$8,0,$8,$8)`,
        [
          input.workId,
          namespaceId,
          agentId,
          decision.revisionId,
          decision.actorId,
          input.transitionRef,
          decision.generation,
          decision.createdAt,
        ],
      );
      if (head) {
        const changed = await query(
          `UPDATE occ.agent_runtime_intent_heads SET generation=$3,transition_ref=$4
          WHERE namespace_id=$1 AND agent_id=$2 AND generation=$5 AND transition_ref=$6 RETURNING transition_ref`,
          [
            namespaceId,
            agentId,
            decision.generation,
            input.transitionRef,
            head.generation,
            head.transitionRef,
          ],
        );
        if (changed.length !== 1)
          throw new ResourceConflictError("The runtime intent generation does not match.");
      } else
        await query(
          "INSERT INTO occ.agent_runtime_intent_heads(namespace_id,agent_id,generation,transition_ref) VALUES ($1,$2,$3,$4)",
          [namespaceId, agentId, decision.generation, input.transitionRef],
        );
      context.phase.assertProtective();
      return immutableCopy({ kind: "provisional", retained });
    },
  };
}
