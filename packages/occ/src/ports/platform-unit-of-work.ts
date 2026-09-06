import { ScopeViolationError } from "../errors.ts";
import { WorkloadProfileTransactionGuard } from "../workload-profiles/repository.ts";
import type { WorkloadProfileRepository } from "./repositories/workload-profile.ts";
import type { TurnJournalUnitOfWorkV1 } from "@openclaw-enterprise/contracts/turn-journal-v1";
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
import type { RuntimePreparationRepository } from "./repositories/runtime-preparation.ts";
import type { RuntimeServiceTrustRepository } from "../runtime-authority/service-trust.ts";

export interface PlatformUnitOfWork extends PlatformReadView {
  readonly workloadProfiles: WorkloadProfileRepository;
  readonly turnJournal?: TurnJournalUnitOfWorkV1;
  readonly channelBindings: ChannelBindingRepository;
  readonly runtimeAssignments: RuntimeAssignmentRepository;
  readonly runtimeAdmissions: RuntimeAdmissionRepository;
  readonly runtimeAuthority: RuntimeAuthorityRepository;
  readonly runtimePreparation: RuntimePreparationRepository;
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
  profilePhase?: WorkloadProfileUnitPhase,
): PlatformUnitOfWork {
  const unit: PlatformUnitOfWork = Object.freeze({
    workloadProfiles: bindRepository(repositories.workloadProfiles, lifetime, [
      "findOperation",
      "prepareOperation",
    ]),
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
            "admit",
            "recordDispatchIntent",
            "consumeAttempt",
            "allocateCheckpoint",
            "publishCompleted",
            "releaseReservation",
            "recordOutcome",
            "commitCancellation",
            "reserveDelivery",
            "recordDelivery",
            "admitNonTurn",
            "admitRejected",
          ]),
        }
      : {}),
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
    runtimePreparation: bindRepository(repositories.runtimePreparation, lifetime, [
      "findPreparation",
      "findOperation",
      "listHistory",
      "retain",
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
  return profilePhase === undefined ? unit : profilePhase.bind(unit);
}

/** Conservative isolation until an actual protected authority/IAM guard is composed.
 * One preparation may acquire capacity -> operation -> Namespace locks. Unrelated
 * work, raw borrowed SQL and a second preparation cannot straddle that sequence.
 * Exact historical reads do not acquire those locks or confer current authority.
 */
export class WorkloadProfileUnitPhase {
  readonly guard = new WorkloadProfileTransactionGuard();
  private otherStarted = false;
  private preparationStarted = false;
  private guardedPolicy = false;
  private policyComplete = false;

  /** This owner object never escapes through PlatformUnitOfWork. Ordinary callers
   * cannot qualify borrowed SQL or acquire a protected policy phase with a flag. */
  claimGuardedPolicy(): { complete(): void; assertPolicy(): void } {
    if (this.guardedPolicy || this.otherStarted || this.preparationStarted)
      throw new ScopeViolationError("The profile policy phase is unavailable.");
    this.guardedPolicy = true;
    return Object.freeze({
      assertPolicy: () => {
        if (this.policyComplete || this.preparationStarted)
          throw new ScopeViolationError("The profile policy phase is closed.");
      },
      complete: () => {
        if (this.policyComplete || this.preparationStarted)
          throw new ScopeViolationError("The profile policy phase is closed.");
        this.policyComplete = true;
      },
    });
  }

  other<T>(work: () => Promise<T>): Promise<T> {
    if (this.guardedPolicy || this.preparationStarted) return this.reject();
    this.otherStarted = true;
    return work();
  }

  private prepare<T>(work: () => Promise<T>): Promise<T> {
    if (
      this.otherStarted ||
      this.preparationStarted ||
      (this.guardedPolicy && !this.policyComplete)
    )
      return this.reject();
    this.preparationStarted = true;
    return work();
  }

  private reject<T>(): Promise<T> {
    return this.guard.run(async () => {
      throw new ScopeViolationError(
        "Profile preparation requires an isolated ordered transaction.",
      );
    });
  }

  bind(unit: PlatformUnitOfWork): PlatformUnitOfWork {
    const result = Object.fromEntries(
      Object.entries(unit).map(([name, repository]) => [
        name,
        Object.freeze(
          Object.fromEntries(
            Object.entries(repository).map(([method, invoke]) => [
              method,
              (...args: unknown[]) => {
                if (typeof invoke !== "function")
                  throw new TypeError("A repository method is required.");
                const work = () => Reflect.apply(invoke, repository, args) as Promise<unknown>;
                if (name === "workloadProfiles")
                  return method === "prepareOperation" ? this.prepare(work) : work();
                if (name === "installations" && method !== "createInstallation") return work();
                return this.other(work);
              },
            ]),
          ),
        ),
      ]),
    );
    return Object.freeze(result) as unknown as PlatformUnitOfWork;
  }
}
