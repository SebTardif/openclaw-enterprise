import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type { Agent } from "@openclaw-enterprise/contracts/resources/agent";
import type { AuditEvent } from "@openclaw-enterprise/contracts/identity/audit";
import type {
  RuntimeAllocation,
  RuntimeIntent,
} from "@openclaw-enterprise/contracts/runtime-assignment";
import type { LifecycleAdmissionAssociationV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ResourceConflictError, ScopeViolationError } from "../../errors.ts";
import {
  copyProtectiveWrite,
  protectiveIntentDecision,
  protectiveRecord,
  retainedProtectiveRecordMatches,
} from "../../lifecycle/protective-admission-v1.ts";
import type { LifecycleAdmissionUnitPhase } from "../../lifecycle/protective-admission-unit.ts";
import type {
  LifecycleAdmissionRepository,
  PendingAuditExportV1,
  ProtectiveAdmissionStorageResultV1,
  RuntimeCleanupResponsibilityV1,
  StoredPlatformWork,
} from "../../ports/repositories/lifecycle-admission.ts";
import type { PersistedNamespace } from "../../ports/repositories/namespace.ts";
import type { MemoryRepositoryFactoryContext } from "../../ports/repository-factory.ts";

export interface MemoryLifecycleAdmissionSnapshot {
  readonly installation: Readonly<Installation> | undefined;
  readonly namespaces: ReadonlyMap<string, Readonly<PersistedNamespace>>;
  readonly agents: ReadonlyMap<string, Readonly<Agent>>;
  readonly runtimeIntents: Map<string, Readonly<RuntimeIntent>>;
  readonly runtimeHeads: Map<string, string>;
  readonly runtimeAllocations: ReadonlyMap<string, Readonly<RuntimeAllocation>>;
  readonly lifecycleAdmissions: Map<string, Readonly<LifecycleAdmissionAssociationV1>>;
  readonly cleanupResponsibilities: Map<string, Readonly<RuntimeCleanupResponsibilityV1>>;
  readonly auditExports: Map<string, Readonly<PendingAuditExportV1>>;
  readonly operations: StoredPlatformWork[];
  readonly audit: readonly Readonly<AuditEvent>[];
}

interface Context extends MemoryRepositoryFactoryContext<MemoryLifecycleAdmissionSnapshot> {
  readonly phase: LifecycleAdmissionUnitPhase;
  readonly appendAudit: (event: AuditEvent) => Promise<void>;
  readonly resourceKey: (namespaceId: string, agentId: string) => string;
}

/** The original serialized snapshot supplies atomicity; this factory owns no transaction. */
export function createMemoryLifecycleAdmission(context: Context): LifecycleAdmissionRepository {
  const { snapshot, transaction } = context;
  function owner(namespaceId: string, agentId: string): string {
    transaction.assertActive();
    const installation = snapshot.installation;
    const namespace = snapshot.namespaces.get(namespaceId);
    const agent = snapshot.agents.get(context.resourceKey(namespaceId, agentId));
    // Tombstones retain exact owned history. Ordinary running paths keep their ready guard.
    if (
      !installation ||
      context.scope.installationId !== installation.id ||
      !namespace ||
      !agent ||
      agent.namespaceId !== namespaceId ||
      agent.id !== agentId
    )
      throw new ScopeViolationError("The protective runtime owner is unavailable.");
    return installation.id;
  }

  return {
    findCommitted: async (scope, operationRef) => {
      const installationId = owner(scope.namespaceId, scope.agentId);
      const association = snapshot.lifecycleAdmissions.get(operationRef);
      if (
        !association ||
        association.intent.installationId !== installationId ||
        association.intent.namespaceId !== scope.namespaceId ||
        association.intent.agentId !== scope.agentId
      )
        return undefined;
      const intent = snapshot.runtimeIntents.get(operationRef);
      const entry = snapshot.operations.find(
        (item) => item.version === 1 && item.work.input.workId === association.workId,
      );
      const audit = snapshot.audit.find((item) => item.id === association.auditEventId);
      const cleanup = [...snapshot.cleanupResponsibilities.values()].find(
        (item) => item.originOperationRef === operationRef,
      );
      const outbox = snapshot.auditExports.get(association.auditEventId);
      if (!intent || !entry || entry.version !== 1 || !audit || !cleanup || !outbox)
        return undefined;
      const predecessor =
        cleanup.predecessor === null
          ? undefined
          : snapshot.runtimeIntents.get(cleanup.predecessor.transitionRef);
      if (
        cleanup.predecessor !== null &&
        (!predecessor ||
          predecessor.namespaceId !== scope.namespaceId ||
          predecessor.agentId !== scope.agentId ||
          predecessor.generation !== cleanup.predecessor.generation ||
          predecessor.revisionId !== intent.revisionId)
      )
        return undefined;
      const retained = {
        association: { ...association, intent },
        work: entry.work,
        audit,
        cleanup,
        export: outbox,
      };
      transaction.assertActive();
      return retainedProtectiveRecordMatches(retained) ? immutableCopy(retained) : undefined;
    },
    applyProtective: async (value) => {
      context.phase.assertProtective();
      const input = copyProtectiveWrite(value);
      const { namespaceId, agentId } = input.request;
      const installationId = owner(namespaceId, agentId);
      if (
        snapshot.runtimeIntents.has(input.transitionRef) ||
        snapshot.lifecycleAdmissions.has(input.transitionRef)
      )
        throw new ResourceConflictError("The original lifecycle operation already exists.");
      const key = context.resourceKey(namespaceId, agentId);
      const headRef = snapshot.runtimeHeads.get(key);
      const head = headRef === undefined ? undefined : snapshot.runtimeIntents.get(headRef);
      if (headRef !== undefined && !head)
        throw new ScopeViolationError("The runtime head is incomplete.");
      if (
        head === undefined &&
        [...snapshot.runtimeIntents.values()].some(
          (item) => item.namespaceId === namespaceId && item.agentId === agentId,
        )
      )
        throw new ResourceConflictError("A prior runtime lineage cannot be reinitialized.");
      const decision = protectiveIntentDecision(
        input,
        installationId,
        head,
        new Date().toISOString(),
      );
      if ("kind" in decision) return decision;
      const allocations = [...snapshot.runtimeAllocations.values()].filter(
        (item) => item.namespaceId === namespaceId && item.agentId === agentId,
      );
      if (
        allocations.some(
          (item) =>
            item.installationId !== installationId ||
            !head ||
            item.lifecycleGeneration > head.generation,
        )
      )
        throw new ScopeViolationError("The retained runtime allocation lineage is incomplete.");
      const record = protectiveRecord(input, decision, head, allocations);
      if (
        snapshot.cleanupResponsibilities.has(input.responsibilityRef) ||
        snapshot.auditExports.has(input.audit.id) ||
        snapshot.operations.some((entry) =>
          entry.version === 1
            ? entry.work.input.workId === input.workId
            : `${entry.operation.kind}:${entry.operation.resourceId}:${entry.operation.action}${entry.operation.kind === "namespace" ? `:${entry.operation.target}` : ""}` ===
              input.workId,
        )
      )
        throw new ResourceConflictError("The retained lifecycle material identity already exists.");
      snapshot.runtimeIntents.set(input.transitionRef, decision);
      await context.appendAudit(input.audit);
      transaction.assertActive();
      context.phase.assertProtective();
      snapshot.cleanupResponsibilities.set(input.responsibilityRef, record.cleanup);
      snapshot.auditExports.set(input.audit.id, record.export);
      snapshot.lifecycleAdmissions.set(input.transitionRef, record.association);
      snapshot.operations.push(immutableCopy({ version: 1, work: record.work }));
      snapshot.runtimeHeads.set(key, input.transitionRef);
      if (!retainedProtectiveRecordMatches(record))
        throw new ScopeViolationError("The protective admission is incomplete.");
      return immutableCopy<ProtectiveAdmissionStorageResultV1>({
        kind: "provisional",
        retained: record,
      });
    },
  };
}
