import { ScopeViolationError } from "../errors.ts";
import type { PlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";

/** The original transaction owner closes and drains this phase; it is not authority. */
export class LifecycleAdmissionUnitPhase {
  private mode: "idle" | "other" | "protective" | "channel-first-create" = "idle";
  private accepting = true;
  private finished = false;
  private failed = false;
  private failure: unknown;
  private readonly pending = new Set<Promise<void>>();
  private channelClosed = false;
  private channelDispatched = false;

  private reject<T>(message: string): Promise<T> {
    const error = new ScopeViolationError(message);
    if (
      (this.accepting || (this.mode === "channel-first-create" && !this.channelClosed)) &&
      !this.failed
    ) {
      this.failed = true;
      this.failure = error;
    }
    const result = Promise.reject<T>(error);
    // The owner still observes an unawaited rejection through finish().
    void result.catch(() => {});
    return result;
  }

  other<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting) return this.reject("The lifecycle transaction is closed.");
    if (this.mode === "protective" || this.mode === "channel-first-create")
      return this.reject("Protective admission requires an isolated ordered transaction.");
    this.mode = "other";
    return work();
  }

  /** Internal continuation of an already accepted legacy operation; lifetime guards its backend. */
  legacyQuery<T>(work: () => Promise<T>): Promise<T> {
    if (this.mode === "protective" || this.mode === "channel-first-create")
      return this.reject("Protective admission cannot borrow an outward query.");
    this.mode = "other";
    return work();
  }

  private apply<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting) return this.reject("The lifecycle transaction is closed.");
    if (this.mode !== "idle")
      return this.reject("Protective admission requires an isolated ordered transaction.");
    this.mode = "protective";
    const result = Promise.resolve().then(async () => {
      try {
        this.assertProtective();
        return await work();
      } catch (error) {
        if (!this.failed) {
          this.failed = true;
          this.failure = error;
        }
        throw error;
      }
    });
    const settled = result.then(
      () => {},
      () => {},
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    return result;
  }

  /** Claim synchronously before the one outward lifetime admission. The raw
   * complete operation is already captured by the original unit dispatcher. */
  runChannelFirstCreate<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting || this.mode !== "idle")
      return this.reject("Channel first creation requires an isolated original transaction.");
    this.mode = "channel-first-create";
    let result: Promise<T>;
    try {
      this.assertChannelFirstCreateActive();
      result = work();
    } catch (error) {
      result = Promise.reject(error);
    }
    const observed = result.catch((error: unknown) => {
      this.poisonChannelFirstCreate(error);
      throw error;
    });
    const settled = observed.then(
      () => {},
      () => {},
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    return observed;
  }

  assertChannelFirstCreateActive(): void {
    if (this.failed) throw this.failure;
    if (this.mode !== "channel-first-create" || this.channelClosed || this.channelDispatched)
      throw new ScopeViolationError("The channel first-create continuation is unavailable.");
  }

  poisonChannelFirstCreate(error: unknown): void {
    if (this.mode === "channel-first-create" && !this.failed) {
      this.failed = true;
      this.failure = error;
    }
  }

  assertChannelCommitReady(): void {
    if (this.mode !== "channel-first-create") return;
    this.assertChannelFirstCreateActive();
    if (this.accepting || !this.finished || this.pending.size !== 0)
      throw new ScopeViolationError("The channel first-create operation has not settled.");
  }

  markChannelCommitDispatched(): void {
    if (this.mode !== "channel-first-create") return;
    this.assertChannelCommitReady();
    this.channelDispatched = true;
  }

  assertChannelOutcome(): void {
    if (this.mode === "channel-first-create" && this.failed) throw this.failure;
  }

  closeChannelFirstCreate(): void {
    this.channelClosed = true;
  }

  assertProtective(): void {
    if (this.finished || this.mode !== "protective")
      throw new ScopeViolationError("The protective transaction phase is unavailable.");
    if (this.failed) throw this.failure;
  }

  closeAdmissions(): void {
    this.accepting = false;
  }

  async finish(): Promise<void> {
    this.closeAdmissions();
    await Promise.all([...this.pending]);
    this.finished = true;
    if (this.failed) throw this.failure;
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
                if (
                  name === "installations" &&
                  method !== "createInstallation" &&
                  this.mode !== "channel-first-create"
                )
                  return work();
                if (name === "lifecycleAdmissions" && method === "applyProtective")
                  return this.apply(work);
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
