import { bindRepository } from "./repository-factory.ts";
import type { RepositoryTransactionLifetime } from "./transaction.ts";
import type { PlatformReadView } from "./platform-read-view.ts";
import type { InstallationRepository } from "./repositories/installation.ts";
import type { NamespaceRepository } from "./repositories/namespace.ts";
import type { AgentRepository } from "./repositories/agent.ts";
import type { AgentRevisionRepository } from "./repositories/revision.ts";
import type { ConfigurationRepository } from "./repositories/configuration.ts";
import type { SecretRepository } from "./repositories/secret.ts";
import type { ServiceAccountRepository } from "./repositories/service-account.ts";
import type { PlatformAuditRepository } from "./repositories/audit.ts";
import type { PlatformOperationRepository } from "./repositories/work.ts";
import type { ChannelBindingRepository } from "./repositories/channel-bindings.ts";
import type { RuntimeAdmissionRepository } from "./repositories/runtime-admission.ts";
import type { RuntimeAssignmentRepository } from "./repositories/runtime-assignment.ts";
import type { RuntimeAuthorityRepository } from "../runtime-authority/repository.ts";
import type { RuntimeServiceTrustRepository } from "../runtime-authority/service-trust.ts";

export interface PlatformUnitOfWork extends PlatformReadView {
  readonly channelBindings: ChannelBindingRepository;
  readonly runtimeAssignments: RuntimeAssignmentRepository;
  readonly runtimeAdmissions: RuntimeAdmissionRepository;
  readonly runtimeAuthority: RuntimeAuthorityRepository;
  readonly runtimeServiceTrust: RuntimeServiceTrustRepository;
  readonly installations: InstallationRepository;
  readonly namespaces: NamespaceRepository;
  readonly configurations: ConfigurationRepository;
  readonly secrets: SecretRepository;
  readonly serviceAccounts: ServiceAccountRepository;
  readonly agents: AgentRepository;
  readonly revisions: AgentRevisionRepository;
  readonly audit: PlatformAuditRepository;
  readonly operations: PlatformOperationRepository;
}

/** The explicit outward projection shares one transaction lifetime. */
export function bindPlatformUnitOfWork(
  repositories: PlatformUnitOfWork,
  lifetime: RepositoryTransactionLifetime,
): PlatformUnitOfWork {
  return Object.freeze({
    channelBindings: bindRepository(repositories.channelBindings, lifetime, [
      "findChannelInstallation",
      "listChannelInstallations",
      "findHumanBinding",
      "findHumanBindingBySubject",
      "listHumanBindings",
      "findAgentBinding",
      "findAgentBindingByChannel",
      "listAgentBindings",
      "createChannelInstallation",
      "createHumanBinding",
      "createAgentBinding",
      "setChannelInstallationStatus",
      "setHumanBindingStatus",
      "setAgentBindingStatus",
    ]),
    runtimeAssignments: bindRepository(repositories.runtimeAssignments, lifetime, [
      "findRuntimeIntent",
      "findRuntimeIntentHead",
      "findRuntimeAllocation",
      "initializeRuntimeIntent",
      "advanceRuntimeIntent",
      "allocateUnboundRuntime",
    ]),
    runtimeAdmissions: bindRepository(repositories.runtimeAdmissions, lifetime, [
      "findRevisionAdmission",
      "findCommittedAdmission",
      "recordAdmission",
    ]),
    runtimeAuthority: bindRepository(repositories.runtimeAuthority, lifetime, [
      "findAssignment",
      "listEvidence",
      "findOperation",
      "appendMutation",
    ]),
    runtimeServiceTrust: bindRepository(repositories.runtimeServiceTrust, lifetime, [
      "findOperation",
      "latest",
      "mutate",
    ]),
    installations: bindRepository(repositories.installations, lifetime, [
      "findInstallation",
      "getInstallation",
      "createInstallation",
    ]),
    namespaces: bindRepository(repositories.namespaces, lifetime, [
      "findNamespace",
      "listNamespaces",
      "createNamespace",
      "lockNamespace",
      "hasAgents",
      "hasConfigurations",
      "hasServiceAccounts",
      "hasSecrets",
      "transitionNamespaceStatus",
      "markNamespaceDeleted",
    ]),
    configurations: bindRepository(repositories.configurations, lifetime, [
      "findConfiguration",
      "createConfiguration",
      "lockConfiguration",
      "advanceConfigurationGeneration",
      "deleteConfiguration",
    ]),
    secrets: bindRepository(repositories.secrets, lifetime, [
      "findSecret",
      "lockSecret",
      "createSecret",
      "deleteSecret",
      "hasReferences",
    ]),
    serviceAccounts: bindRepository(repositories.serviceAccounts, lifetime, [
      "findServiceAccount",
      "listServiceAccounts",
      "findServiceAccountProviderBinding",
      "createServiceAccount",
      "lockServiceAccount",
      "updateCredential",
      "deleteServiceAccount",
    ]),
    agents: bindRepository(repositories.agents, lifetime, [
      "findAgent",
      "listAgents",
      "createAgent",
      "lockAgent",
      "updateConfiguration",
      "compareAndSetActiveRevision",
    ]),
    revisions: bindRepository(repositories.revisions, lifetime, [
      "findRevision",
      "listRevisions",
      "createRevision",
    ]),
    audit: bindRepository(repositories.audit, lifetime, ["append", "list"]),
    operations: bindRepository(repositories.operations, lifetime, ["append", "list"]),
  });
}
