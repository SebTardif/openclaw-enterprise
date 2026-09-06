import { ScopeViolationError } from "../errors.ts";
import type { PlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";

/** The original transaction owner closes and drains this phase; it is not authority. */
export class LifecycleAdmissionUnitPhase {
  private mode: "idle" | "other" | "protective" = "idle";
  private accepting = true;
  private finished = false;
  private failed = false;
  private failure: unknown;
  private readonly pending = new Set<Promise<void>>();

  private reject<T>(message: string): Promise<T> {
    const error = new ScopeViolationError(message);
    if (this.accepting && !this.failed) {
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
    if (this.mode === "protective")
      return this.reject("Protective admission requires an isolated ordered transaction.");
    this.mode = "other";
    return work();
  }

  /** Internal continuation of an already accepted legacy operation; lifetime guards its backend. */
  legacyQuery<T>(work: () => Promise<T>): Promise<T> {
    if (this.mode === "protective")
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
                if (name === "installations" && method !== "createInstallation") return work();
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
