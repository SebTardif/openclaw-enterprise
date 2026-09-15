import { randomUUID } from "node:crypto";
import type {
  RuntimeScope,
  RuntimeIntent,
  RuntimeAllocation,
  RuntimeIntentAttribution,
} from "@openclaw-enterprise/contracts";
import type { Installation } from "@openclaw-enterprise/contracts";
import type { AgentReadRepository, AgentRepository } from "../platform-state.ts";
import type { NamespaceReadRepository, NamespaceRepository } from "../platform-state.ts";
import type { AgentRevisionReadRepository } from "../platform-state.ts";
import type { RuntimeAssignmentRepository } from "../../ports/repositories/runtime-assignment.ts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  ResourceConflictError,
  ScopeViolationError,
  DependencyUnavailableError,
} from "../../errors.ts";
import {
  createRuntimeAuthorityRepository,
  RuntimeAuthorityTransactionGuard,
  type StoredRuntimeAuthorityOperation,
} from "../../runtime-authority/repository.ts";
import { serializeRuntimeAssignmentMutations } from "../runtime-assignment.ts";
import type { RuntimeAssignmentSnapshot } from "../runtime-assignment.ts";
const runtimeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const validRuntimeReference = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 200 &&
  /^[A-Za-z0-9._:/-]+$/.test(value);
const agentKey = (namespaceId: string, agentId: string) => `${namespaceId}\u0000${agentId}`;
export function createMemoryRuntimeRepositories(
  snapshot: RuntimeAssignmentSnapshot & {
    readonly installation: Readonly<Installation> | undefined;
  },
  namespaces: NamespaceReadRepository,
  agents: AgentReadRepository,
  revisions: AgentRevisionReadRepository,
  authorityGuard: RuntimeAuthorityTransactionGuard,
) {
  const runtimeOwner = async (scope: RuntimeScope, writing = false) => {
    const namespace = await namespaces.findNamespace(scope.namespaceId);
    const agent = await agents.findAgent(scope.namespaceId, scope.agentId);
    if (
      snapshot.installation === undefined ||
      namespace === undefined ||
      agent === undefined ||
      (writing && namespace.status !== "ready")
    )
      return undefined;
    return agent;
  };
  const runtimeAssignments: RuntimeAssignmentRepository = {
    findRuntimeIntent: async (scope, transitionRef) => {
      if (!(await runtimeOwner(scope))) return undefined;
      const intent = snapshot.runtimeIntents.get(transitionRef);
      return intent?.namespaceId === scope.namespaceId && intent.agentId === scope.agentId
        ? immutableCopy(intent)
        : undefined;
    },
    findRuntimeIntentHead: async (scope) => {
      const ref = snapshot.runtimeHeads.get(agentKey(scope.namespaceId, scope.agentId));
      return ref === undefined ? undefined : runtimeAssignments.findRuntimeIntent(scope, ref);
    },
    findRuntimeAllocation: async (scope, locator) => {
      if (!(await runtimeOwner(scope))) return undefined;
      const allocation =
        locator.assignmentRef !== undefined
          ? snapshot.runtimeAllocations.get(locator.assignmentRef)
          : Array.from(snapshot.runtimeAllocations.values()).find(
              (item) => item.createEffectRef === locator.createEffectRef,
            );
      return allocation?.namespaceId === scope.namespaceId && allocation.agentId === scope.agentId
        ? immutableCopy(allocation)
        : undefined;
    },
    initializeRuntimeIntent: async (scope, revisionId, transitionRef, attribution) =>
      saveIntent(scope, 0, { desiredMode: "running", revisionId }, transitionRef, attribution),
    advanceRuntimeIntent: async (scope, expectedGeneration, next, transitionRef, attribution) => {
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
        throw new ResourceConflictError("The runtime intent generation is invalid.");
      return saveIntent(scope, expectedGeneration, next, transitionRef, attribution);
    },
    allocateUnboundRuntime: async (
      scope,
      expectedLifecycleGeneration,
      component,
      expectedRuntimeGeneration,
      createEffectRef,
      profileRefs,
    ) => {
      if (
        profileRefs === null ||
        typeof profileRefs !== "object" ||
        Object.keys(profileRefs).sort().join(",") !==
          "identityProfileRef,providerProfileRef,runtimeProfileRef"
      )
        throw new ScopeViolationError("The runtime profile reference shape is invalid.");
      const agent = await runtimeOwner(scope, true);
      if (agent === undefined) throw new ScopeViolationError("The runtime owner is unavailable.");
      const existing = Array.from(snapshot.runtimeAllocations.values()).find(
        (item) => item.createEffectRef === createEffectRef,
      );
      if (existing !== undefined) {
        if (
          existing.namespaceId !== scope.namespaceId ||
          existing.agentId !== scope.agentId ||
          existing.lifecycleGeneration !== expectedLifecycleGeneration ||
          existing.component !== component ||
          existing.runtimeGeneration !== expectedRuntimeGeneration + 1 ||
          existing.providerProfileRef !== profileRefs.providerProfileRef ||
          existing.runtimeProfileRef !== profileRefs.runtimeProfileRef ||
          existing.identityProfileRef !== profileRefs.identityProfileRef
        )
          throw new ResourceConflictError(
            "The runtime create effect conflicts with its stored allocation.",
          );
        return immutableCopy(existing);
      }
      const head = await runtimeAssignments.findRuntimeIntentHead(scope);
      if (
        head === undefined ||
        head.generation !== expectedLifecycleGeneration ||
        head.desiredMode !== "running"
      )
        throw new ResourceConflictError("The running runtime intent does not match.");
      const prior = Array.from(snapshot.runtimeAllocations.values())
        .filter(
          (item) =>
            item.namespaceId === scope.namespaceId &&
            item.agentId === scope.agentId &&
            item.component === component,
        )
        .reduce((value, item) => Math.max(value, item.runtimeGeneration), 0);
      if (prior !== expectedRuntimeGeneration || !Number.isSafeInteger(prior + 1))
        throw new ResourceConflictError("The runtime allocation generation does not match.");
      if (
        !runtimeUuid.test(createEffectRef) ||
        !["gateway", "harness"].includes(component) ||
        !Object.values(profileRefs).every(validRuntimeReference) ||
        Object.keys(profileRefs).sort().join(",") !==
          "identityProfileRef,providerProfileRef,runtimeProfileRef"
      )
        throw new ScopeViolationError("The runtime allocation references are invalid.");
      const allocation: RuntimeAllocation = immutableCopy({
        namespaceId: scope.namespaceId,
        agentId: scope.agentId,
        ...profileRefs,
        assignmentRef: randomUUID(),
        createEffectRef,
        installationId: snapshot.installation!.id,
        revisionId: head.revisionId,
        servicePrincipalId: agent.servicePrincipalId,
        lifecycleGeneration: head.generation,
        component,
        runtimeGeneration: prior + 1,
        bindingCondition: "unbound",
        createdAt: new Date().toISOString(),
      });
      snapshot.runtimeAllocations.set(allocation.assignmentRef, allocation);
      return immutableCopy(allocation);
    },
  };
  async function saveIntent(
    scope: RuntimeScope,
    expected: number,
    next: { readonly desiredMode: "running" | "disabled" | "stopped"; readonly revisionId: string },
    transitionRef: string,
    attribution: RuntimeIntentAttribution,
  ): Promise<Readonly<RuntimeIntent>> {
    if (
      !(await runtimeOwner(scope, true)) ||
      !(await revisions.findRevision(scope.namespaceId, scope.agentId, next.revisionId))
    )
      throw new ScopeViolationError("The runtime owner or revision is unavailable.");
    const key = agentKey(scope.namespaceId, scope.agentId);
    const head = await runtimeAssignments.findRuntimeIntentHead(scope);
    if (
      (head?.generation ?? 0) !== expected ||
      !Number.isSafeInteger(expected + 1) ||
      snapshot.runtimeIntents.has(transitionRef)
    )
      throw new ResourceConflictError("The runtime intent transition conflicts.");
    if (
      !runtimeUuid.test(transitionRef) ||
      !["running", "disabled", "stopped"].includes(next.desiredMode) ||
      !validRuntimeReference(attribution.actorId) ||
      !validRuntimeReference(attribution.requestId)
    )
      throw new ScopeViolationError("The runtime intent references are invalid.");
    const intent: RuntimeIntent = immutableCopy({
      namespaceId: scope.namespaceId,
      agentId: scope.agentId,
      installationId: snapshot.installation!.id,
      transitionRef,
      generation: expected + 1,
      desiredMode: next.desiredMode,
      revisionId: next.revisionId,
      actorId: attribution.actorId,
      requestId: attribution.requestId,
      createdAt: new Date().toISOString(),
    });
    snapshot.runtimeIntents.set(transitionRef, intent);
    snapshot.runtimeHeads.set(key, transitionRef);
    return immutableCopy(intent);
  }
  const runtimeAuthority = createRuntimeAuthorityRepository(
    {
      lockOperation: async () => {}, // Existing memory transaction already serializes all writers.
      allocation: async (scope, assignmentRef) => {
        if (snapshot.installation?.id !== scope.installationId) return undefined;
        const allocation = snapshot.runtimeAllocations.get(assignmentRef);
        return allocation?.namespaceId === scope.namespaceId && allocation.agentId === scope.agentId
          ? allocation
          : undefined;
      },
      operations: async (scope, assignmentRef) =>
        [...snapshot.runtimeAuthorityOperations.values()]
          .filter(
            ({ receipt }) =>
              receipt.installationId === scope.installationId &&
              receipt.namespaceId === scope.namespaceId &&
              receipt.agentId === scope.agentId &&
              receipt.assignmentRef.id === assignmentRef,
          )
          .sort((a, b) => a.receipt.assignmentRecordVersion - b.receipt.assignmentRecordVersion),
      operation: async (operationRef) => snapshot.runtimeAuthorityOperations.get(operationRef),
      insert: async (operation) => {
        if (snapshot.runtimeAuthorityOperations.has(operation.receipt.operationRef))
          throw new ResourceConflictError("The runtime authority operation already exists.");
        snapshot.runtimeAuthorityOperations.set(
          operation.receipt.operationRef,
          immutableCopy(operation),
        );
      },
    },
    runtimeAssignments,
    authorityGuard,
  );
  return {
    runtimeAssignments: serializeRuntimeAssignmentMutations(runtimeAssignments),
    runtimeAuthority,
  };
}
