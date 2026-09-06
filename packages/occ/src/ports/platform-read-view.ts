import type { WorkloadProfileReadRepository } from "./repositories/workload-profile.ts";
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
import type { RuntimePreparationReadRepository } from "./repositories/runtime-preparation.ts";
import type { RuntimeServiceTrustReadRepository } from "../runtime-authority/service-trust.ts";
import type { PlatformAuditReadRepository } from "./repositories/audit.ts";
import type { PlatformOperationReadRepository } from "./repositories/work.ts";
import type { LifecycleAdmissionReadRepository } from "./repositories/lifecycle-admission.ts";
import type { CredentialInventoryTransactionV1 } from "../credential-inventory-v1/ports.ts";

export type CredentialInventorySafeReadV1 = Pick<
  CredentialInventoryTransactionV1,
  | "findOperation"
  | "findRecord"
  | "liveCounts"
  | "listLive"
  | "findMintClaim"
  | "findRevocationClaim"
  | "findSnapshot"
>;

/** Internal projection of an already accepted transaction. The supplied owner
 * assertion and original methods retain exact scope/lifetime correspondence;
 * this helper neither authenticates nor adds access to PlatformReadView. */
export function createCredentialInventoryReadProjectionV1(
  transaction: CredentialInventoryTransactionV1,
  assertAcceptedRead: () => void,
): CredentialInventorySafeReadV1 {
  const methods = [
    "findOperation",
    "findRecord",
    "liveCounts",
    "listLive",
    "findMintClaim",
    "findRevocationClaim",
    "findSnapshot",
  ] as const;
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [
        method,
        (...args: unknown[]) => {
          assertAcceptedRead();
          return Reflect.apply(transaction[method], transaction, args);
        },
      ]),
    ),
  ) as unknown as CredentialInventorySafeReadV1;
}

export interface PlatformReadView {
  readonly lifecycleAdmissions: LifecycleAdmissionReadRepository;
  readonly workloadProfiles: WorkloadProfileReadRepository;
  readonly turnJournal?: TurnJournalReadV1;
  readonly audit: PlatformAuditReadRepository;
  readonly operations: PlatformOperationReadRepository;
  readonly channelBindings: ChannelBindingReadRepository;
  readonly runtimeAssignments: RuntimeAssignmentReadRepository;
  readonly runtimeAdmissions: RuntimeAdmissionReadRepository;
  readonly runtimeAuthority: RuntimeAuthorityReadRepository;
  readonly runtimePreparation: RuntimePreparationReadRepository;
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
    lifecycleAdmissions: bindRepository(repositories.lifecycleAdmissions, lifetime, [
      "findCommitted",
    ]),
    workloadProfiles: bindRepository(repositories.workloadProfiles, lifetime, ["findOperation"]),
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
    runtimePreparation: bindRepository(repositories.runtimePreparation, lifetime, [
      "findPreparation",
      "findOperation",
      "listHistory",
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
