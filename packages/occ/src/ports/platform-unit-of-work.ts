import { AsyncLocalStorage } from "node:async_hooks";
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
import type { LifecycleAdmissionRepository } from "./repositories/lifecycle-admission.ts";
import type { LifecycleAdmissionUnitPhase } from "../lifecycle/protective-admission-unit.ts";

export interface PlatformUnitOfWork extends PlatformReadView {
  readonly lifecycleAdmissions: LifecycleAdmissionRepository;
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
  lifecyclePhase?: LifecycleAdmissionUnitPhase,
  credentialPhase?: CredentialInventoryOwnerPhaseV1,
  rejectIsolated?: (error: unknown) => never,
): PlatformUnitOfWork {
  const unit: PlatformUnitOfWork = Object.freeze({
    lifecycleAdmissions: bindRepository(repositories.lifecycleAdmissions, lifetime, [
      "findCommitted",
      "applyProtective",
    ]),
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
  const profiled = profilePhase === undefined ? unit : profilePhase.bind(unit);
  const lifecycle = lifecyclePhase === undefined ? profiled : lifecyclePhase.bind(profiled);
  const credential = credentialPhase === undefined ? lifecycle : credentialPhase.bind(lifecycle);
  if (rejectIsolated === undefined) return credential;
  // Internal owner isolation only; this projection creates no authority.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(credential).map(([name, repository]) => [
        name,
        Object.freeze(
          Object.fromEntries(
            Object.keys(repository).map((method) => [
              method,
              () =>
                rejectIsolated(
                  new ScopeViolationError(
                    "The isolated owner transaction forbids outward repositories.",
                  ),
                ),
            ]),
          ),
        ),
      ]),
    ),
  ) as unknown as PlatformUnitOfWork;
}

/** Internal execution control only. Exact transaction enrollment, authentic
 * acceptance, completion facts and COMMIT disposition remain with the owner.
 * This phase never authenticates a caller or issues an authority capability.
 */
export class CredentialInventoryOwnerPhaseV1 {
  private accepting = true;
  private active = true;
  private failed = false;
  private failure: unknown;
  private transitionStarted = false;
  private transitionSettled = false;
  private acceptanceStarted = false;
  private acceptanceSettled = false;
  private accepted = false;
  private finalizationStarted = false;
  private finalizationSettled = false;
  private readonly pending = new Set<Promise<void>>();
  private tail: Promise<void> = Promise.resolve();
  private readonly operation = new AsyncLocalStorage<{ active: boolean }>();

  assertActive(): void {
    if (!this.active) {
      const error = new ScopeViolationError("The credential transaction is closed.");
      this.poison(error);
      throw error;
    }
    if (this.failed) throw this.failure;
  }

  /** Backend queries require an admitted operation, acceptance or finalization.
   * A captured async continuation loses permission when that body settles.
   */
  assertOperationActive(): void {
    this.assertActive();
    if (this.operation.getStore()?.active !== true) {
      const error = new ScopeViolationError("The credential operation is unavailable.");
      this.poison(error);
      throw error;
    }
  }

  poison(error: unknown): void {
    if (!this.failed) {
      this.failed = true;
      this.failure = error;
    }
  }

  runTransition<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting || !this.active || this.transitionStarted)
      return this.rejectOutward(
        new ScopeViolationError("The credential transition is unavailable."),
      );
    this.transitionStarted = true;
    const result = (async () => {
      try {
        this.assertActive();
        const value = await work();
        this.assertActive();
        return value;
      } catch (error) {
        this.poison(error);
        throw error;
      } finally {
        this.transitionSettled = true;
        this.closeAdmissions();
      }
    })();
    return this.observe(result);
  }

  runAcceptance<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting || !this.active || !this.transitionStarted || this.acceptanceStarted)
      return this.rejectOutward(
        new ScopeViolationError("The credential acceptance is unavailable."),
      );
    this.acceptanceStarted = true;
    return this.observe(
      this.runScoped(async () => {
        try {
          const value = await work();
          this.assertActive();
          if (typeof value !== "boolean")
            throw new ScopeViolationError("The credential acceptance is invalid.");
          this.accepted = value === true;
          return value;
        } finally {
          this.acceptanceSettled = true;
        }
      }),
    );
  }

  runOperation<T>(work: () => Promise<T>): Promise<T> {
    if (
      !this.accepting ||
      !this.active ||
      !this.accepted ||
      !this.acceptanceSettled ||
      this.operation.getStore() !== undefined
    )
      return this.rejectOutward(
        new ScopeViolationError("The credential operation is unavailable."),
      );
    const result = this.tail.then(() => this.runScoped(work));
    // A failed predecessor still settles the queue; runScoped rejects before
    // starting the next body, using the original first failure.
    this.tail = result.then(
      () => {},
      () => {},
    );
    return this.observe(result);
  }

  rejectOutward<T>(error: unknown): Promise<T> {
    // Closing admission does not clear the poison latch. The execution owner
    // separately retains whether COMMIT was already dispatched.
    this.poison(error);
    const result = Promise.reject<T>(error);
    void result.catch(() => {});
    return result;
  }

  closeAdmissions(): void {
    this.accepting = false;
  }

  async drainAccepted(): Promise<void> {
    // The callback is tracked separately from the operation serializer, so an
    // accepted multi-query body can finish without enqueueing behind itself.
    while (this.pending.size !== 0) await Promise.all([...this.pending]);
    if (this.failed) throw this.failure;
  }

  runFinalization(work: () => Promise<void>): Promise<void> {
    if (
      this.accepting ||
      !this.active ||
      !this.transitionSettled ||
      !this.acceptanceSettled ||
      this.finalizationStarted ||
      this.pending.size !== 0 ||
      this.operation.getStore() !== undefined
    )
      return this.rejectOutward(
        new ScopeViolationError("The credential finalization is unavailable."),
      );
    this.finalizationStarted = true;
    return this.observe(
      this.runScoped(async () => {
        try {
          await work();
        } finally {
          this.finalizationSettled = true;
        }
      }),
    );
  }

  assertCommitReady(): void {
    this.assertActive();
    if (
      this.accepting ||
      !this.transitionSettled ||
      !this.acceptanceSettled ||
      !this.finalizationSettled ||
      this.pending.size !== 0
    ) {
      const error = new ScopeViolationError("The credential transition is incomplete.");
      this.poison(error);
      throw error;
    }
  }

  close(): void {
    this.closeAdmissions();
    this.active = false;
  }

  bind(unit: PlatformUnitOfWork): PlatformUnitOfWork {
    const result = Object.fromEntries(
      Object.entries(unit).map(([name, repository]) => [
        name,
        Object.freeze(
          Object.fromEntries(
            Object.keys(repository).map((method) => [
              method,
              () =>
                this.rejectOutward(
                  new ScopeViolationError(
                    "Credential inventory requires an isolated owner transaction.",
                  ),
                ),
            ]),
          ),
        ),
      ]),
    );
    return Object.freeze(result) as unknown as PlatformUnitOfWork;
  }

  private runScoped<T>(work: () => Promise<T>): Promise<T> {
    const token = { active: true };
    return this.operation.run(token, async () => {
      try {
        this.assertActive();
        const value = await work();
        this.assertActive();
        return value;
      } catch (error) {
        this.poison(error);
        throw error;
      } finally {
        token.active = false;
      }
    });
  }

  private observe<T>(result: Promise<T>): Promise<T> {
    const settled = result.then(
      () => {},
      (error: unknown) => this.poison(error),
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    return result;
  }
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
