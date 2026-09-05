import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import { ScopeViolationError } from "../errors.ts";
import type { PlatformReadView } from "../ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
import type { PlatformStateStore } from "../ports/transaction.ts";
import { PostgresCommitOutcomeUnknownError } from "../ports/transaction-errors.ts";
import { MutationCompensations, type Compensation } from "./compensation.ts";
import {
  MutationContext,
  copyRepositorySelection,
  selectRepositories,
  type MutationRepositoryOperations,
  type MutationRepositorySelection,
  type RepositorySelection,
  type SelectedRepositories,
} from "./mutation-context.ts";

/** Owns the shared resource, revision, admission, work and audit mutation boundary. */
export class MutationRunner {
  private readonly installation: Readonly<Installation>;
  private readonly state: PlatformStateStore;
  private readonly context = new MutationContext();
  private readonly compensations = new MutationCompensations();

  constructor(installation: Readonly<Installation>, state: PlatformStateStore) {
    this.installation = installation;
    this.state = state;
  }

  hasActiveTransaction(): boolean {
    return this.context.current() !== undefined;
  }

  /** Nested services join the same unit; the store alone owns commit and draining. */
  async transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    const active = this.context.current();
    if (active) return work(active);

    const compensations: Compensation[] = [];
    try {
      return await this.state.transact(async (state) =>
        this.context.run(state, () =>
          this.compensations.run(compensations, async () => {
            const existing = await state.installations.getInstallation();
            if (!existing) await state.installations.createInstallation(this.installation);
            else if (existing.id !== this.installation.id)
              throw new ScopeViolationError(
                "The controller state belongs to another Installation.",
              );
            const result = await work(state);
            this.context.assertAdmissionSucceeded(state);
            return result;
          }),
        ),
      );
    } catch (error) {
      // Ambiguous COMMIT requires the caller's retained locator and authoritative
      // readback. Compensating or replaying could undo a committed mutation.
      if (error instanceof PostgresCommitOutcomeUnknownError) throw error;
      await this.compensations.rollback(compensations);
      throw error;
    }
  }

  async read<T>(work: (state: PlatformReadView) => Promise<T>): Promise<T> {
    const active = this.context.current();
    return active ? work(active) : this.state.read(work);
  }

  async mutate<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    const active = this.context.current();
    return active ? work(active) : this.transact(work);
  }

  registerRollback(rollback: Compensation): void {
    this.compensations.register(rollback, this.hasActiveTransaction());
  }

  /** Caught admission rejection still rolls back its enclosing resource unit. */
  poisonAdmission(error: unknown): void {
    this.context.poisonAdmission(error);
  }

  /** Capability services select explicit repository sets without receiving the store. */
  forRepositories<
    const Read extends RepositorySelection<PlatformReadView>,
    const Mutation extends RepositorySelection<PlatformUnitOfWork>,
  >(
    selection: MutationRepositorySelection<Read, Mutation>,
  ): MutationRepositoryOperations<Read, Mutation> {
    const read = copyRepositorySelection<PlatformReadView, Read>(selection.read);
    const mutate = copyRepositorySelection<PlatformUnitOfWork, Mutation>(selection.mutate);
    return Object.freeze({
      read: <T>(work: (state: SelectedRepositories<PlatformReadView, Read>) => Promise<T>) =>
        this.read((state) => work(selectRepositories(state, read))),
      mutate: <T>(
        work: (state: SelectedRepositories<PlatformUnitOfWork, Mutation>) => Promise<T>,
      ) => this.mutate((state) => work(selectRepositories(state, mutate))),
      registerRollback: (rollback: Compensation) => this.registerRollback(rollback),
    });
  }
}
