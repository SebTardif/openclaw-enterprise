import { AsyncLocalStorage } from "node:async_hooks";
import { ScopeViolationError } from "../errors.ts";
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
