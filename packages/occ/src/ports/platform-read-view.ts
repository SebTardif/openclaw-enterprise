import type { TurnJournalReadV1 } from "@openclaw-enterprise/contracts/turn-journal-v1";
import { bindRepository } from "./repository-factory.ts";
import type { RepositoryTransactionLifetime } from "./transaction.ts";
import type { InstallationReadRepository } from "./repositories/installation.ts";
import type { NamespaceReadRepository } from "./repositories/namespace.ts";
import type { AgentReadRepository } from "./repositories/agent.ts";
import type { AgentRevisionReadRepository } from "./repositories/revision.ts";
import type { ConfigurationReadRepository } from "./repositories/configuration.ts";
import type { SecretReadRepository } from "./repositories/secret.ts";
import type { ServiceAccountReadRepository } from "./repositories/service-account.ts";
import type { ChannelBindingReadRepository } from "./repositories/channel-bindings.ts";
import type { RuntimeAdmissionReadRepository } from "./repositories/runtime-admission.ts";
import type { RuntimeAssignmentReadRepository } from "./repositories/runtime-assignment.ts";
import type { RuntimeAuthorityReadRepository } from "../runtime-authority/repository.ts";
import type { RuntimeServiceTrustReadRepository } from "../runtime-authority/service-trust.ts";
import type { PlatformAuditReadRepository } from "./repositories/audit.ts";
import type { PlatformOperationReadRepository } from "./repositories/work.ts";

export interface PlatformReadView {
  readonly turnJournal?: TurnJournalReadV1;
  readonly audit: PlatformAuditReadRepository;
  readonly operations: PlatformOperationReadRepository;
  readonly channelBindings: ChannelBindingReadRepository;
  readonly runtimeAssignments: RuntimeAssignmentReadRepository;
  readonly runtimeAdmissions: RuntimeAdmissionReadRepository;
  readonly runtimeAuthority: RuntimeAuthorityReadRepository;
  readonly runtimeServiceTrust: RuntimeServiceTrustReadRepository;
  readonly installations: InstallationReadRepository;
  readonly namespaces: NamespaceReadRepository;
  readonly configurations: ConfigurationReadRepository;
  readonly secrets: SecretReadRepository;
  readonly serviceAccounts: ServiceAccountReadRepository;
  readonly agents: AgentReadRepository;
  readonly revisions: AgentRevisionReadRepository;
}

/** The explicit outward projection shares one transaction lifetime. */
export function createPlatformReadView(
  repositories: PlatformReadView,
  lifetime: RepositoryTransactionLifetime,
): PlatformReadView {
  return Object.freeze({
    ...(repositories.turnJournal
      ? {
          turnJournal: bindRepository(repositories.turnJournal, lifetime, [
            "findAdmission",
            "findAttempt",
            "findCompletion",
            "readHead",
            "findDelivery",
            "findCheckpointAllocation",
            "findCancellation",
            "findRelease",
            "findNonTurnIntake",
            "findIncomingLink",
            "findRejectedAdmission",
          ]),
        }
      : {}),
    audit: bindRepository(repositories.audit, lifetime, ["list"]),
    operations: bindRepository(repositories.operations, lifetime, ["list"]),
    channelBindings: bindRepository(repositories.channelBindings, lifetime, [
      "findChannelInstallation",
      "listChannelInstallations",
      "findHumanBinding",
      "findHumanBindingBySubject",
      "listHumanBindings",
      "findAgentBinding",
      "findAgentBindingByChannel",
      "listAgentBindings",
    ]),
    runtimeAssignments: bindRepository(repositories.runtimeAssignments, lifetime, [
      "findRuntimeIntent",
      "findRuntimeIntentHead",
      "findRuntimeAllocation",
    ]),
    runtimeAdmissions: bindRepository(repositories.runtimeAdmissions, lifetime, [
      "findRevisionAdmission",
      "findCommittedAdmission",
    ]),
    runtimeAuthority: bindRepository(repositories.runtimeAuthority, lifetime, [
      "findAssignment",
      "listEvidence",
      "findOperation",
    ]),
    runtimeServiceTrust: bindRepository(repositories.runtimeServiceTrust, lifetime, [
      "findOperation",
      "latest",
    ]),
    installations: bindRepository(repositories.installations, lifetime, [
      "findInstallation",
      "getInstallation",
    ]),
    namespaces: bindRepository(repositories.namespaces, lifetime, [
      "findNamespace",
      "listNamespaces",
    ]),
    configurations: bindRepository(repositories.configurations, lifetime, ["findConfiguration"]),
    secrets: bindRepository(repositories.secrets, lifetime, ["findSecret"]),
    serviceAccounts: bindRepository(repositories.serviceAccounts, lifetime, [
      "findServiceAccount",
      "listServiceAccounts",
      "findServiceAccountProviderBinding",
    ]),
    agents: bindRepository(repositories.agents, lifetime, ["findAgent", "listAgents"]),
    revisions: bindRepository(repositories.revisions, lifetime, ["findRevision", "listRevisions"]),
  });
}
