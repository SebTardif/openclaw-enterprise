import {
  SecretReference,
  SecretBinding,
  SecretBindings,
  type AgentRevision,
  type AuditEvent,
  type Configuration,
} from "@openclaw-enterprise/contracts";
import { Check } from "typebox/value";
import type { AuditEventFactory } from "../../../audit/src/index.ts";
import { produceRevision } from "./producer.ts";

export function consumeRevision(
  configuration: Configuration,
  bindings?: SecretBindings,
): AgentRevision {
  return produceRevision(configuration, bindings);
}

export function consumeAuditEvent(factory: AuditEventFactory): AuditEvent {
  return factory.create({
    installationId: "installation",
    kind: "mutation",
    actorId: "principal",
    action: "update",
    resource: { kind: "agent", id: "agent", namespaceId: "namespace" },
    outcome: "success",
  });
}

// Each Secret name is both a resource type and its runtime validation schema.
export function validateSecrets(
  reference: SecretReference,
  binding: SecretBinding,
  bindings: SecretBindings,
): boolean {
  return (
    Check(SecretReference, reference) &&
    Check(SecretBinding, binding) &&
    Check(SecretBindings, bindings)
  );
}
