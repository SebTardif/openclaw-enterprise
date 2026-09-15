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
import { parseRuntimeAuthorityV1 } from "@openclaw-enterprise/contracts";
import type { PostgresQueryClient } from "../postgres-work-queue.ts";
function runtimeGeneration(row: PostgresRow, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new DependencyUnavailableError("The stored runtime generation is invalid.");
  return value;
}
function runtimeIntentFromRow(row: PostgresRow): Readonly<RuntimeIntent> {
  const desiredMode = text(row, "desired_mode");
  if (desiredMode !== "running" && desiredMode !== "disabled" && desiredMode !== "stopped")
    throw new DependencyUnavailableError("The stored runtime intent mode is invalid.");
  const revisionId = optionalText(row, "revision_id") ?? null;
  if (
    (desiredMode === "running" || Number(row.admission_version ?? 0) === 0) &&
    revisionId === null
  )
    throw new DependencyUnavailableError("The stored runtime revision is missing.");
  const identity = {
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
    installationId: text(row, "installation_id"),
    transitionRef: text(row, "transition_ref"),
    generation: runtimeGeneration(row, "generation"),
    actorId: text(row, "actor_id"),
    requestId: text(row, "request_id"),
    createdAt: timestamp(row, "created_at"),
  };
  return desiredMode === "running"
    ? immutableCopy({ ...identity, desiredMode, revisionId: text(row, "revision_id") })
    : immutableCopy({ ...identity, desiredMode, revisionId });
}
function runtimeAllocationFromRow(row: PostgresRow): Readonly<RuntimeAllocation> {
  const component = text(row, "component");
  if (
    (component !== "gateway" && component !== "harness") ||
    text(row, "binding_condition") !== "unbound"
  )
    throw new DependencyUnavailableError("The stored runtime allocation is invalid.");
  return immutableCopy({
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
    installationId: text(row, "installation_id"),
    assignmentRef: text(row, "assignment_ref"),
    createEffectRef: text(row, "create_effect_ref"),
    revisionId: text(row, "revision_id"),
    servicePrincipalId: text(row, "service_principal_id"),
    lifecycleGeneration: runtimeGeneration(row, "lifecycle_generation"),
    component,
    runtimeGeneration: runtimeGeneration(row, "runtime_generation"),
    providerProfileRef: text(row, "provider_profile_ref"),
    runtimeProfileRef: text(row, "runtime_profile_ref"),
    identityProfileRef: text(row, "identity_profile_ref"),
    bindingCondition: "unbound",
    createdAt: timestamp(row, "created_at"),
  });
}

type PostgresRow = Record<string, unknown>;
function rows(value: unknown[]): PostgresRow[] {
  return value as PostgresRow[];
}
function text(row: PostgresRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value)
    throw new DependencyUnavailableError("Invalid persisted runtime value.");
  return value;
}
function optionalText(row: PostgresRow, key: string): string | undefined {
  return row[key] == null ? undefined : text(row, key);
}
function timestamp(row: PostgresRow, key: string): string {
  const value = row[key];
  return value instanceof Date ? value.toISOString() : text(row, key);
}
export function createPostgresRuntimeRepositories(
  client: PostgresQueryClient,
  currentInstallation: () => Promise<Readonly<Installation> | undefined>,
  namespaces: NamespaceRepository,
  agents: AgentRepository,
  revisions: AgentRevisionReadRepository,
  authorityGuard: RuntimeAuthorityTransactionGuard,
) {
  const runtimeOwner = async (scope: RuntimeScope, writing = false) => {
    const installation = await currentInstallation();
    const namespace = writing
      ? await namespaces.lockNamespace(scope.namespaceId)
      : await namespaces.findNamespace(scope.namespaceId);
    const agent = writing
      ? await agents.lockAgent(scope.namespaceId, scope.agentId)
      : await agents.findAgent(scope.namespaceId, scope.agentId);
    if (
      installation === undefined ||
      namespace === undefined ||
      agent === undefined ||
      (writing && namespace.status !== "ready")
    )
      return undefined;
    return { installation, agent };
  };
  const runtimeAssignments: RuntimeAssignmentRepository = {
    findRuntimeIntent: async (scope, transitionRef) => {
      if (!(await runtimeOwner(scope))) return undefined;
      const found = rows(
        (
          await client.query(
            "SELECT * FROM occ.agent_runtime_intents WHERE namespace_id = $1 AND agent_id = $2 AND transition_ref = $3",
            [scope.namespaceId, scope.agentId, transitionRef],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : runtimeIntentFromRow(found);
    },
    findRuntimeIntentHead: async (scope) => {
      if (!(await runtimeOwner(scope))) return undefined;
      const found = rows(
        (
          await client.query(
            "SELECT intent.* FROM occ.agent_runtime_intents intent JOIN occ.agent_runtime_intent_heads head USING (namespace_id, agent_id, generation, transition_ref) WHERE head.namespace_id = $1 AND head.agent_id = $2",
            [scope.namespaceId, scope.agentId],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : runtimeIntentFromRow(found);
    },
    findRuntimeAllocation: async (scope, locator) => {
      if (!(await runtimeOwner(scope))) return undefined;
      const found = rows(
        (
          await client.query(
            `SELECT * FROM occ.runtime_assignment_allocations WHERE namespace_id = $1 AND agent_id = $2 AND ${locator.assignmentRef !== undefined ? "assignment_ref" : "create_effect_ref"} = $3`,
            [scope.namespaceId, scope.agentId, locator.assignmentRef ?? locator.createEffectRef],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : runtimeAllocationFromRow(found);
    },
    initializeRuntimeIntent: async (scope, revisionId, transitionRef, attribution) =>
      saveRuntimeIntent(
        scope,
        0,
        { desiredMode: "running", revisionId },
        transitionRef,
        attribution,
      ),
    advanceRuntimeIntent: async (scope, expectedGeneration, next, transitionRef, attribution) => {
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
        throw new ResourceConflictError("The runtime intent generation is invalid.");
      return saveRuntimeIntent(scope, expectedGeneration, next, transitionRef, attribution);
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
      const owner = await runtimeOwner(scope, true);
      if (owner === undefined) throw new ScopeViolationError("The runtime owner is unavailable.");
      const existing = rows(
        (
          await client.query(
            "SELECT * FROM occ.runtime_assignment_allocations WHERE create_effect_ref = $1",
            [createEffectRef],
          )
        ).rows,
      )[0];
      if (existing !== undefined) {
        const saved = runtimeAllocationFromRow(existing);
        if (
          saved.namespaceId !== scope.namespaceId ||
          saved.agentId !== scope.agentId ||
          saved.lifecycleGeneration !== expectedLifecycleGeneration ||
          saved.component !== component ||
          saved.runtimeGeneration !== expectedRuntimeGeneration + 1 ||
          saved.providerProfileRef !== profileRefs.providerProfileRef ||
          saved.runtimeProfileRef !== profileRefs.runtimeProfileRef ||
          saved.identityProfileRef !== profileRefs.identityProfileRef
        )
          throw new ResourceConflictError(
            "The runtime create effect conflicts with its stored allocation.",
          );
        return saved;
      }
      const head = await runtimeAssignments.findRuntimeIntentHead(scope);
      if (
        head === undefined ||
        head.generation !== expectedLifecycleGeneration ||
        head.desiredMode !== "running"
      )
        throw new ResourceConflictError("The running runtime intent does not match.");
      // Every allocator holds the same Agent lock before reading its component sequence.
      const latest = rows(
        (
          await client.query(
            "SELECT runtime_generation FROM occ.runtime_assignment_allocations WHERE namespace_id = $1 AND agent_id = $2 AND component = $3 ORDER BY runtime_generation DESC LIMIT 1",
            [scope.namespaceId, scope.agentId, component],
          )
        ).rows,
      )[0];
      const prior = latest === undefined ? 0 : runtimeGeneration(latest, "runtime_generation");
      if (prior !== expectedRuntimeGeneration || !Number.isSafeInteger(prior + 1))
        throw new ResourceConflictError("The runtime allocation generation does not match.");
      const found = rows(
        (
          await client.query(
            `INSERT INTO occ.runtime_assignment_allocations
          (assignment_ref, create_effect_ref, installation_id, namespace_id, agent_id, revision_id, service_principal_id, lifecycle_generation, component, runtime_generation, provider_profile_ref, runtime_profile_ref, identity_profile_ref, binding_condition, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'unbound',clock_timestamp()) RETURNING *`,
            [
              randomUUID(),
              createEffectRef,
              owner.installation.id,
              scope.namespaceId,
              scope.agentId,
              head.revisionId,
              owner.agent.servicePrincipalId,
              head.generation,
              component,
              prior + 1,
              profileRefs.providerProfileRef,
              profileRefs.runtimeProfileRef,
              profileRefs.identityProfileRef,
            ],
          )
        ).rows,
      )[0];
      return runtimeAllocationFromRow(found!);
    },
  };
  async function saveRuntimeIntent(
    scope: RuntimeScope,
    expected: number,
    next: {
      readonly desiredMode: "running" | "disabled" | "stopped";
      readonly revisionId: string;
    },
    transitionRef: string,
    attribution: RuntimeIntentAttribution,
  ): Promise<Readonly<RuntimeIntent>> {
    const owner = await runtimeOwner(scope, true);
    if (
      owner === undefined ||
      !(await revisions.findRevision(scope.namespaceId, scope.agentId, next.revisionId))
    )
      throw new ScopeViolationError("The runtime owner or revision is unavailable.");
    const head = await runtimeAssignments.findRuntimeIntentHead(scope);
    if ((head?.generation ?? 0) !== expected || !Number.isSafeInteger(expected + 1))
      throw new ResourceConflictError("The runtime intent transition conflicts.");
    const found = rows(
      (
        await client.query(
          `INSERT INTO occ.agent_runtime_intents
        (transition_ref,installation_id,namespace_id,agent_id,generation,desired_mode,revision_id,actor_id,request_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()) RETURNING *`,
          [
            transitionRef,
            owner.installation.id,
            scope.namespaceId,
            scope.agentId,
            expected + 1,
            next.desiredMode,
            next.revisionId,
            attribution.actorId,
            attribution.requestId,
          ],
        )
      ).rows,
    )[0];
    if (expected === 0) {
      await client.query(
        "INSERT INTO occ.agent_runtime_intent_heads (namespace_id,agent_id,generation,transition_ref) VALUES ($1,$2,1,$3)",
        [scope.namespaceId, scope.agentId, transitionRef],
      );
    } else {
      const updated = await client.query(
        "UPDATE occ.agent_runtime_intent_heads SET generation = $3, transition_ref = $4 WHERE namespace_id = $1 AND agent_id = $2 AND generation = $5 RETURNING agent_id",
        [scope.namespaceId, scope.agentId, expected + 1, transitionRef, expected],
      );
      if (updated.rows.length !== 1)
        throw new ResourceConflictError("The runtime intent transition conflicts.");
    }
    return runtimeIntentFromRow(found!);
  }
  function authorityOperation(row: PostgresRow): StoredRuntimeAuthorityOperation {
    const result = parseRuntimeAuthorityV1("operationState", {
      schemaVersion: 1,
      result: "committed",
      receipt: row.receipt,
    });
    if (!("receipt" in result) || typeof row.canonical_payload !== "string")
      throw new DependencyUnavailableError("The runtime authority record is invalid.");
    return immutableCopy({ canonicalPayload: row.canonical_payload, receipt: result.receipt });
  }
  const runtimeAuthority = createRuntimeAuthorityRepository(
    {
      lockOperation: async (operationRef) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('runtime-authority-operation:' || $1, 0))",
          [operationRef],
        );
      },
      allocation: async (scope, assignmentRef, lock) => {
        const installation = await currentInstallation();
        if (installation?.id !== scope.installationId) return undefined;
        // Use the same Agent lock as intent/assignment writers before any head or version read.
        if (lock)
          await client.query(
            "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR UPDATE",
            [scope.namespaceId, scope.agentId],
          );
        const found = rows(
          (
            await client.query(
              "SELECT * FROM occ.runtime_assignment_allocations WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND assignment_ref=$4",
              [scope.installationId, scope.namespaceId, scope.agentId, assignmentRef],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : runtimeAllocationFromRow(found);
      },
      operations: async (scope, assignmentRef) =>
        rows(
          (
            await client.query(
              "SELECT canonical_payload, receipt FROM occ.runtime_authority_operations WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND assignment_ref=$4 ORDER BY assignment_record_version",
              [scope.installationId, scope.namespaceId, scope.agentId, assignmentRef],
            )
          ).rows,
        ).map(authorityOperation),
      operation: async (operationRef) => {
        const found = rows(
          (
            await client.query(
              "SELECT canonical_payload, receipt FROM occ.runtime_authority_operations WHERE operation_ref=$1",
              [operationRef],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : authorityOperation(found);
      },
      insert: async ({ canonicalPayload, receipt }) => {
        await client.query(
          `INSERT INTO occ.runtime_authority_operations
          (operation_ref, installation_id, namespace_id, agent_id, assignment_ref, assignment_record_version, operation_kind, canonical_payload, receipt)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            receipt.operationRef,
            receipt.installationId,
            receipt.namespaceId,
            receipt.agentId,
            receipt.assignmentRef.id,
            receipt.assignmentRecordVersion,
            receipt.operationKind,
            canonicalPayload,
            JSON.stringify(receipt),
          ],
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
