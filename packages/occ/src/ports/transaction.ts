import type { PlatformReadView } from "./platform-read-view.ts";
import type { PlatformUnitOfWork } from "./platform-unit-of-work.ts";
import { ScopeViolationError } from "../errors.ts";

export interface PlatformReadOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface PlatformStateStore {
  read<T>(work: (state: PlatformReadView) => Promise<T>, options?: PlatformReadOptions): Promise<T>;
  transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T>;
}

/** A borrowed capability; only the transaction owner can close or finish it. */
export interface RepositoryTransaction {
  assertActive(): void;
}

/**
 * Owns callback admission and drains complete repository operations before the
 * owner commits. Closing admissions does not interrupt accepted operations.
 * Authority admission retains its separate poison guard and must finish before
 * commit. Ordinary caught repository conflicts keep their existing semantics.
 */
export class RepositoryTransactionLifetime implements RepositoryTransaction {
  private accepting = true;
  private active = true;
  private readonly pending = new Set<Promise<void>>();

  assertActive(): void {
    if (!this.active) throw new ScopeViolationError("The platform transaction is closed.");
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new ScopeViolationError("The platform transaction is closed."));
    const result = (async () => {
      this.assertActive();
      const value = await work();
      this.assertActive();
      return value;
    })();
    const settled = result.then(
      () => {},
      () => {},
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    return result;
  }

  async finish(): Promise<void> {
    this.accepting = false;
    await Promise.all([...this.pending]);
    this.active = false;
  }

  /** Cancellation revokes backend access immediately, including after awaits. */
  close(): void {
    this.accepting = false;
    this.active = false;
  }
}
