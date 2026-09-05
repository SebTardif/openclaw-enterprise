import type { PlatformReadView, PlatformStateStore } from "../state/platform-state.ts";
import { parseGrantHolderV1, type GrantHolderV1 } from "./grant-contract.ts";

export type RuntimeOwnerInspection =
  | Readonly<{ result: "unbound"; holder: GrantHolderV1 }>
  | Readonly<{ result: "invalid-input" | "not-visible" | "not-current" | "unavailable" }>;

/**
 * Reads persistence facts within one platform view. Even a matching allocation is unbound:
 * this function never produces the identity owner's current-workload authorization result.
 */
export async function inspectRuntimeOwnerInView(
  view: PlatformReadView,
  holderInput: unknown,
): Promise<RuntimeOwnerInspection> {
  const holder = parseGrantHolderV1(holderInput);
  if (!holder) return Object.freeze({ result: "invalid-input" });
  const scope = { namespaceId: holder.namespaceId, agentId: holder.agentId };
  const installation = await view.installations.getInstallation();
  if (installation?.id !== holder.installationId) return Object.freeze({ result: "not-visible" });
  const namespace = await view.namespaces.findNamespace(holder.namespaceId);
  const agent = await view.agents.findAgent(holder.namespaceId, holder.agentId);
  const revision = await view.revisions.findRevision(
    holder.namespaceId,
    holder.agentId,
    holder.agentRevisionId,
  );
  const allocation = await view.runtimeAssignments.findRuntimeAllocation(scope, {
    assignmentRef: holder.assignmentRef.id,
  });
  if (!namespace || !agent || !revision || !allocation)
    return Object.freeze({ result: "not-visible" });
  if (
    agent.namespaceId !== holder.namespaceId ||
    revision.namespaceId !== holder.namespaceId ||
    revision.agentId !== holder.agentId ||
    allocation.installationId !== holder.installationId ||
    allocation.namespaceId !== holder.namespaceId ||
    allocation.agentId !== holder.agentId ||
    allocation.revisionId !== holder.agentRevisionId ||
    allocation.assignmentRef !== holder.assignmentRef.id ||
    agent.servicePrincipalId !== holder.servicePrincipalId ||
    revision.servicePrincipalId !== holder.servicePrincipalId ||
    allocation.servicePrincipalId !== holder.servicePrincipalId
  )
    return Object.freeze({ result: "not-visible" });
  const intent = await view.runtimeAssignments.findRuntimeIntentHead(scope);
  if (
    namespace.status !== "ready" ||
    !intent ||
    intent.installationId !== holder.installationId ||
    intent.namespaceId !== holder.namespaceId ||
    intent.agentId !== holder.agentId ||
    intent.desiredMode !== "running" ||
    intent.generation !== holder.lifecycleGeneration ||
    intent.revisionId !== holder.agentRevisionId ||
    allocation.lifecycleGeneration !== holder.lifecycleGeneration ||
    allocation.runtimeGeneration !== holder.runtimeGeneration ||
    allocation.component !== holder.component ||
    allocation.providerProfileRef !== holder.providerProfileRef ||
    allocation.runtimeProfileRef !== holder.runtimeProfileRef ||
    allocation.identityProfileRef !== holder.identityProfileRef ||
    allocation.bindingCondition !== "unbound"
  )
    return Object.freeze({ result: "not-current" });
  // Historical allocations can match these facts too; there is no active selector here.
  return Object.freeze({ result: "unbound", holder });
}

/** Dependency failure yields no cached observation and no foreign-state detail. */
export async function inspectRuntimeOwner(
  state: PlatformStateStore,
  holderInput: unknown,
): Promise<RuntimeOwnerInspection> {
  try {
    return await state.read((view) => inspectRuntimeOwnerInView(view, holderInput));
  } catch {
    return Object.freeze({ result: "unavailable" });
  }
}
