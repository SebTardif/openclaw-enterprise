export const ref = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
export const instant = "2026-01-01T00:00:00.000Z";

/** Controlled plain data only. These values are not repository/authority proof. */
export function vectors() {
  const scope = { namespaceId: `ns_${ref(1)}`, agentId: `agt_${ref(2)}` };
  const intent = {
    installationId: `ins_${ref(3)}`,
    ...scope,
    transitionRef: ref(4),
    generation: 1,
    desiredMode: "running",
    revisionId: `rev_${ref(5)}`,
    actorId: "test-actor",
    requestId: `req_${ref(6)}`,
    createdAt: instant,
  };
  const workId = `agent_revision:${intent.revisionId}:reconcile`;
  const input = {
    schemaVersion: 1,
    handler: "ReconcileAgentLifecycleV1",
    ...scope,
    operationRef: intent.transitionRef,
    lifecycleGeneration: intent.generation,
    workId,
  };
  const association = {
    schemaVersion: 1,
    request: { schemaVersion: 1, kind: "deploy", ...scope, expectedLifecycleGeneration: null },
    intent,
    auditEventId: `aud_${ref(7)}`,
    workId,
  };
  const operation = {
    action: "reconcile",
    kind: "agent_revision",
    namespaceId: scope.namespaceId,
    resourceId: intent.revisionId,
    actorId: intent.actorId,
    runtimeTransitionRef: intent.transitionRef,
    lifecycleGeneration: 1,
  };
  const work = {
    idempotencyKey: workId,
    ...scope,
    revisionId: intent.revisionId,
    actorId: intent.actorId,
    runtimeTransitionRef: intent.transitionRef,
    lifecycleGeneration: 1,
    state: "claimed",
    claimToken: ref(8),
    leaseExpiresAt: new Date("2026-01-01T00:00:10.000Z"),
    availableAt: new Date(instant),
    attemptCount: 1,
    createdAt: new Date(instant),
    updatedAt: new Date(instant),
  };
  return { input, association, operation, work };
}
