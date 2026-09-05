import { randomUUID } from "node:crypto";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";

/** Caller-owned correlation only; deployment always uses the canonical OCC method. */
export function createRuntimeAdmissionContext(installationId, actorId, options = {}) {
  const transitionRef = options.transitionRef ?? randomUUID();
  const requestId = options.requestId ?? `deploy-${randomUUID()}`;
  const factory = options.factory ?? new AuditEventFactory();
  return Object.freeze({
    transitionRef,
    requestId,
    createAuditEvent: (revision) =>
      factory.create({
        installationId,
        namespaceId: revision.namespaceId,
        kind: "mutation",
        source: "occ",
        requestId,
        actor: { principalId: actorId },
        action: "openclaw.agents.deploy",
        resource: { kind: "agent_revision", id: revision.id, namespaceId: revision.namespaceId },
        authorization: {
          principalId: actorId,
          action: "deploy",
          resource: { kind: "agent", id: revision.agentId, namespaceId: revision.namespaceId },
        },
        outcome: "success",
      }),
  });
}
