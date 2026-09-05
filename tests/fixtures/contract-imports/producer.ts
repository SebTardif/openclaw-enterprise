import {
  freezeAgentRevision,
  type AgentRevision,
} from "@openclaw-enterprise/contracts/resources/agent";
import type { Configuration } from "@openclaw-enterprise/contracts/resources/configuration";
import type { SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";

export function produceRevision(
  configuration: Configuration,
  secretBindings?: SecretBindings,
): Readonly<AgentRevision> {
  return freezeAgentRevision({
    id: "rev_12345678-1234-4234-8234-123456789abc",
    namespaceId: configuration.namespaceId,
    agentId: "agt_12345678-1234-4234-8234-123456789abc",
    revision: 1,
    providerId: null,
    configurationId: configuration.id,
    configurationKind: configuration.kind,
    configurationGeneration: configuration.generation,
    configuration: configuration.values,
    ...(secretBindings === undefined ? {} : { secretBindings }),
    harness: { id: "openclaw", version: "1", mode: "embedded" },
    compute: { id: "compute", implementation: "occ/kubernetes" },
    servicePrincipalId: "service-principal",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}
