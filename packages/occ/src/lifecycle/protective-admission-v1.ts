import { parseLifecycleAdmissionV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type {
  RuntimeIntent,
  RuntimeAllocation,
} from "@openclaw-enterprise/contracts/runtime-assignment";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import type { PlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
import type {
  ProtectiveAdmissionWriteV1,
  ProtectiveAdmissionRecordV1,
  ProtectiveAdmissionStorageResultV1,
  StoredPlatformWork,
} from "../ports/repositories/lifecycle-admission.ts";
import type { PlatformOperation } from "../ports/repositories/work.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const attributionRef = /^[A-Za-z0-9._:/-]{1,200}$/;

/** Storage only. TODO: compose the actual account participant before public lifecycle admission. */
export function applyProtectiveAdmissionV1(
  unit: Pick<PlatformUnitOfWork, "lifecycleAdmissions">,
  input: ProtectiveAdmissionWriteV1,
): Promise<ProtectiveAdmissionStorageResultV1> {
  return unit.lifecycleAdmissions.applyProtective(input);
}

export function copyProtectiveWrite(
  input: ProtectiveAdmissionWriteV1,
): Readonly<ProtectiveAdmissionWriteV1> {
  const value = immutableCopy(input);
  const request = parseLifecycleAdmissionV1("mutationRequest", value.request);
  if (
    (request.kind !== "disable" && request.kind !== "stop") ||
    !uuid.test(value.transitionRef) ||
    !uuid.test(value.responsibilityRef) ||
    !attributionRef.test(value.attribution.actorId) ||
    !attributionRef.test(value.attribution.requestId) ||
    typeof value.workId !== "string" ||
    value.workId.length < 1 ||
    value.workId.length > 512 ||
    value.workId === value.transitionRef
  )
    throw new ScopeViolationError("The retained protective admission identity is invalid.");
  return immutableCopy({ ...value, request });
}

export function protectiveIntentDecision(
  input: Readonly<ProtectiveAdmissionWriteV1>,
  installationId: string,
  head: Readonly<RuntimeIntent> | undefined,
  now: string,
): Readonly<RuntimeIntent> | Extract<ProtectiveAdmissionStorageResultV1, { kind: "unchanged" }> {
  const expected = input.request.expectedLifecycleGeneration;
  if ((head?.generation ?? null) !== expected)
    throw new ResourceConflictError("The runtime intent generation does not match.");
  const desiredMode = input.request.kind === "disable" ? "disabled" : "stopped";
  if (head?.desiredMode === desiredMode)
    return Object.freeze({ kind: "unchanged", lifecycleGeneration: head.generation, desiredMode });
  if (head?.desiredMode === "stopped")
    throw new ResourceConflictError("A stopped Agent cannot be disabled.");
  const generation = (head?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new ResourceConflictError("The runtime intent generation is exhausted.");
  return parseLifecycleAdmissionV1("intent", {
    installationId,
    namespaceId: input.request.namespaceId,
    agentId: input.request.agentId,
    transitionRef: input.transitionRef,
    generation,
    desiredMode,
    revisionId: head?.revisionId ?? null,
    actorId: input.attribution.actorId,
    requestId: input.attribution.requestId,
    createdAt: now,
  });
}

/** Attribution correspondence is deliberately distinct from current account authorization. */
export function protectiveAuditMatches(
  input: Readonly<ProtectiveAdmissionWriteV1>,
  intent: Readonly<RuntimeIntent>,
): boolean {
  const event = input.audit;
  return (
    event.installationId === intent.installationId &&
    event.namespaceId === intent.namespaceId &&
    event.resource.kind === "agent" &&
    event.resource.id === intent.agentId &&
    event.resource.namespaceId === intent.namespaceId &&
    event.kind === "mutation" &&
    event.outcome === "success" &&
    event.action === `openclaw.agents.${input.request.kind}` &&
    event.actorId === intent.actorId &&
    event.requestId === intent.requestId &&
    event.actor?.unresolved !== true &&
    (event.actor?.principalId === undefined || event.actor.principalId === intent.actorId) &&
    (event.actor?.id === undefined || event.actor.id === intent.actorId) &&
    (event.authorization === undefined ||
      (event.authorization.principalId === intent.actorId &&
        event.authorization.action === "operate" &&
        event.authorization.resource.kind === "agent" &&
        event.authorization.resource.id === intent.agentId &&
        event.authorization.resource.namespaceId === intent.namespaceId))
  );
}

export function protectiveRecord(
  input: Readonly<ProtectiveAdmissionWriteV1>,
  intent: Readonly<RuntimeIntent>,
  predecessor: Readonly<RuntimeIntent> | undefined,
  allocations: readonly Readonly<RuntimeAllocation>[],
): Readonly<ProtectiveAdmissionRecordV1> {
  if (!protectiveAuditMatches(input, intent))
    throw new ScopeViolationError("The protective admission audit attribution does not match.");
  const association = parseLifecycleAdmissionV1("association", {
    schemaVersion: 1,
    request: input.request,
    intent,
    auditEventId: input.audit.id,
    workId: input.workId,
  });
  const workInput = parseLifecycleAdmissionV1("workInput", {
    schemaVersion: 1,
    handler: "ReconcileAgentLifecycleV1",
    namespaceId: intent.namespaceId,
    agentId: intent.agentId,
    operationRef: intent.transitionRef,
    lifecycleGeneration: intent.generation,
    workId: input.workId,
  });
  const now = new Date(intent.createdAt);
  return immutableCopy({
    association,
    work: {
      schemaVersion: 1,
      input: workInput,
      row: {
        idempotencyKey: input.workId,
        namespaceId: intent.namespaceId,
        agentId: intent.agentId,
        ...(intent.revisionId === null ? {} : { revisionId: intent.revisionId }),
        runtimeTransitionRef: intent.transitionRef,
        lifecycleGeneration: intent.generation,
        actorId: intent.actorId,
        state: "queued",
        availableAt: now,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    },
    audit: input.audit,
    cleanup: {
      installationId: intent.installationId,
      namespaceId: intent.namespaceId,
      agentId: intent.agentId,
      responsibilityRef: input.responsibilityRef,
      responsibilityVersion: 1,
      originKind: "lifecycle-protective-v1",
      originOperationRef: intent.transitionRef,
      lifecycleGeneration: intent.generation,
      kind: input.request.kind === "disable" ? "protective-fence" : "retained-stop",
      predecessor: predecessor
        ? { transitionRef: predecessor.transitionRef, generation: predecessor.generation }
        : null,
      inventoryStatus: "unresolved",
      createdAt: intent.createdAt,
      allocations,
    },
    export: {
      auditEventId: input.audit.id,
      installationId: intent.installationId,
      namespaceId: intent.namespaceId,
      originKind: "lifecycle-protective-v1",
      originOperationRef: intent.transitionRef,
      state: "pending",
      createdAt: intent.createdAt,
    },
  });
}

/** Preserve the current legacy projection while both protocols share the owner collection. */
export function legacyOperations(
  work: readonly StoredPlatformWork[],
): readonly Readonly<PlatformOperation>[] {
  return Object.freeze(work.flatMap((entry) => (entry.version === 0 ? [entry.operation] : [])));
}

/** Verify historical correspondence without requiring the operation to remain current or queued. */
export function retainedProtectiveRecordMatches(
  record: Readonly<ProtectiveAdmissionRecordV1>,
): boolean {
  try {
    const association = parseLifecycleAdmissionV1("association", record.association);
    const { intent, request, auditEventId, workId } = association;
    if (request.kind !== "disable" && request.kind !== "stop") return false;
    const input = parseLifecycleAdmissionV1("workInput", record.work.input);
    const work = record.work.row;
    const cleanup = record.cleanup;
    const outbox = record.export;
    const predecessor = cleanup.predecessor;
    const sameScope = (value: { installationId: string; namespaceId: string; agentId: string }) =>
      value.installationId === intent.installationId &&
      value.namespaceId === intent.namespaceId &&
      value.agentId === intent.agentId;
    const finite = (date: Date | undefined) =>
      date instanceof Date && Number.isFinite(date.getTime());
    if (
      record.work.schemaVersion !== 1 ||
      input.namespaceId !== intent.namespaceId ||
      input.agentId !== intent.agentId ||
      input.operationRef !== intent.transitionRef ||
      input.lifecycleGeneration !== intent.generation ||
      input.workId !== workId ||
      work.idempotencyKey !== workId ||
      work.namespaceId !== intent.namespaceId ||
      work.agentId !== intent.agentId ||
      (work.revisionId ?? null) !== intent.revisionId ||
      work.namespaceTarget !== undefined ||
      work.runtimeTransitionRef !== intent.transitionRef ||
      work.lifecycleGeneration !== intent.generation ||
      work.actorId !== intent.actorId ||
      !finite(work.createdAt) ||
      !finite(work.updatedAt) ||
      !finite(work.availableAt) ||
      work.createdAt.toISOString() !== intent.createdAt ||
      !Number.isSafeInteger(work.attemptCount) ||
      work.attemptCount < 0 ||
      !["queued", "claimed", "succeeded", "failed_permanent"].includes(work.state) ||
      !sameScope(cleanup) ||
      !uuid.test(cleanup.responsibilityRef) ||
      cleanup.responsibilityVersion !== 1 ||
      cleanup.originKind !== "lifecycle-protective-v1" ||
      cleanup.originOperationRef !== intent.transitionRef ||
      cleanup.lifecycleGeneration !== intent.generation ||
      cleanup.kind !== (request.kind === "disable" ? "protective-fence" : "retained-stop") ||
      cleanup.inventoryStatus !== "unresolved" ||
      cleanup.createdAt !== intent.createdAt ||
      (predecessor?.generation ?? null) !== request.expectedLifecycleGeneration ||
      (predecessor !== null && !uuid.test(predecessor.transitionRef)) ||
      record.audit.id !== auditEventId ||
      !protectiveAuditMatches(
        {
          request,
          transitionRef: intent.transitionRef,
          attribution: intent,
          audit: record.audit,
          workId,
          responsibilityRef: cleanup.responsibilityRef,
        },
        intent,
      ) ||
      outbox.auditEventId !== auditEventId ||
      outbox.installationId !== intent.installationId ||
      outbox.namespaceId !== intent.namespaceId ||
      outbox.originKind !== "lifecycle-protective-v1" ||
      outbox.originOperationRef !== intent.transitionRef ||
      outbox.state !== "pending" ||
      outbox.createdAt !== intent.createdAt
    )
      return false;
    if (work.state === "claimed") {
      if (
        work.claimToken === undefined ||
        !uuid.test(work.claimToken) ||
        !finite(work.leaseExpiresAt)
      )
        return false;
    } else if (work.claimToken !== undefined || work.leaseExpiresAt !== undefined) return false;
    if (work.state === "succeeded" || work.state === "failed_permanent") {
      if (!finite(work.completedAt)) return false;
    } else if (work.completedAt !== undefined) return false;
    const ids = new Set<string>();
    for (const allocation of cleanup.allocations) {
      if (
        !sameScope(allocation) ||
        predecessor === null ||
        allocation.lifecycleGeneration > predecessor.generation ||
        ids.has(allocation.assignmentRef)
      )
        return false;
      ids.add(allocation.assignmentRef);
    }
    return true;
  } catch {
    return false;
  }
}
