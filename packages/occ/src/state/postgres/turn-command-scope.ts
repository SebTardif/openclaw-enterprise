import { AsyncLocalStorage } from "node:async_hooks";
import { DependencyUnavailableError, ScopeViolationError } from "../../errors.ts";
import type { RepositoryTransaction } from "../../ports/transaction.ts";

import type {
  TurnCommandIdentityV1,
  TurnCommandBoundsV1,
  TurnCommandTerminalV1,
  TurnCommandOperationV1,
  TurnCommandOwnedUnitV1,
  TurnCommandEnrollmentSourceV1,
  TurnCommandEnrollmentLeaseV1,
  TurnCommandAcceptedOperationV1,
} from "../../ports/turn-command.ts";
export type {
  TurnCommandIdentityV1,
  TurnCommandBoundsV1,
  TurnCommandTerminalV1,
  TurnCommandOperationV1,
  TurnCommandOwnedUnitV1,
  TurnCommandEnrollmentSourceV1,
  TurnCommandEnrollmentLeaseV1,
  TurnCommandAcceptedOperationV1,
} from "../../ports/turn-command.ts";

interface CapturedLease {
  prepareCommit: () => Promise<void>;
  assertCurrent: () => undefined;
  release: (outcome: TurnCommandTerminalV1) => Promise<void>;
}

const unavailable = () => new DependencyUnavailableError("The turn command owner is unavailable.");

/**
 * Internal transaction control only. The original PostgresPlatformState must
 * construct/enroll this scope on its existing client and recognize the exact
 * unit token; this class does not authenticate a caller, run SQL or mint a claim.
 * Its supplied owner lifetime must remain active through the final COMMIT fence;
 * the outward RepositoryTransactionLifetime closes earlier and is not that hook.
 * TODO(turn command assembly): install the genuine account/enrollment source,
 * original policy/selection and audit participants, and central transaction hooks.
 * Until that composition exists, enrollment without a source fails before work.
 */
export class TurnCommandScopeV1 {
  readonly unit: TurnCommandOwnedUnitV1;
  readonly #transaction: RepositoryTransaction;
  readonly #signal: AbortSignal;
  readonly #deadline: number;
  readonly #now: () => number;
  readonly #monotonic: () => number;
  readonly #startedAt: number;
  readonly #remainingAtStart: number;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #operation = new AsyncLocalStorage<{ active: boolean }>();
  #tail: Promise<void> = Promise.resolve();
  #open = true;
  #active = true;
  #enrollmentStarted = false;
  #enrolled = false;
  #lease: CapturedLease | undefined;
  #failed = false;
  #failure: unknown;
  #preparing = false;
  #prepared = false;
  #dispatched = false;
  #acknowledged = false;
  #terminal: TurnCommandTerminalV1 | undefined;
  #terminalWork: Promise<void> | undefined;
  readonly #abort: () => void;

  constructor(
    transaction: RepositoryTransaction,
    identity: TurnCommandIdentityV1,
    bounds: TurnCommandBoundsV1,
    clock: Readonly<{ now(): number; monotonic(): number }> = {
      now: () => Date.now(),
      monotonic: () => performance.now(),
    },
  ) {
    this.#transaction = transaction;
    const copy: Record<string, string> = {};
    const keys = ["installationId", "namespaceId", "agentId", "operationRef"] as const;
    if (Reflect.ownKeys(identity).length !== keys.length) throw unavailable();
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(identity, key);
      if (
        !field ||
        !("value" in field) ||
        typeof field.value !== "string" ||
        field.value.length < 1 ||
        field.value.length > 512 ||
        /[\u0000-\u001f\u007f]/u.test(field.value)
      )
        throw unavailable();
      copy[key] = field.value;
    }
    this.unit = Object.freeze(copy) as unknown as TurnCommandOwnedUnitV1;
    this.#signal = bounds.signal;
    this.#deadline = Date.parse(bounds.deadline);
    this.#now = clock.now.bind(clock);
    this.#monotonic = clock.monotonic.bind(clock);
    this.#startedAt = this.#monotonic();
    this.#remainingAtStart = this.#deadline - this.#now();
    if (
      !(this.#signal instanceof AbortSignal) ||
      !Number.isFinite(this.#deadline) ||
      !Number.isFinite(this.#startedAt) ||
      !Number.isFinite(this.#remainingAtStart) ||
      this.#remainingAtStart <= 0
    )
      throw unavailable();
    this.#abort = () => this.poison(this.#signal.reason ?? unavailable());
    this.#signal.addEventListener("abort", this.#abort, { once: true });
    if (this.#signal.aborted) this.#abort();
  }

  poison(error: unknown): void {
    if (this.#active && !this.#failed) {
      this.#failed = true;
      this.#failure = error;
    }
  }

  #reject(): never {
    const error = unavailable();
    this.poison(error);
    throw this.#failed ? this.#failure : error;
  }

  #assertActive(): void {
    if (this.#failed) throw this.#failure;
    if (!this.#active || this.#terminal !== undefined) this.#reject();
    try {
      this.#transaction.assertActive();
      const elapsed = this.#monotonic() - this.#startedAt;
      const now = this.#now();
      if (
        this.#signal.aborted ||
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        !Number.isFinite(now) ||
        now >= this.#deadline ||
        elapsed >= this.#remainingAtStart
      )
        this.#reject();
    } catch (error) {
      this.poison(error);
      throw error;
    }
  }

  assertOwned(unit: TurnCommandOwnedUnitV1): void {
    if (unit !== this.unit) {
      const error = new ScopeViolationError("The turn unit belongs to another transaction.");
      this.poison(error);
      throw error;
    }
    this.#assertActive();
  }

  #track<T>(work: Promise<T>): Promise<T> {
    const result = work.catch((error: unknown) => {
      this.poison(error);
      throw error;
    });
    this.#pending.add(result);
    void result.then(
      () => this.#pending.delete(result),
      () => this.#pending.delete(result),
    );
    return result;
  }

  #assertLease(): void {
    this.#assertActive();
    if (!this.#lease) this.#reject();
    try {
      const result: unknown = this.#lease.assertCurrent();
      if (result !== undefined) {
        // An invalid async fence is still accepted work to drain before release.
        this.#track(Promise.resolve(result));
        this.#reject();
      }
      this.#assertActive();
    } catch (error) {
      this.poison(error);
      throw error;
    }
  }

  async #invokeOwnerCallback<T>(work: () => Promise<T>): Promise<T> {
    const executing = { active: true };
    try {
      return await this.#operation.run(executing, work);
    } finally {
      executing.active = false;
    }
  }

  enroll(source?: TurnCommandEnrollmentSourceV1): Promise<void> {
    try {
      this.#assertActive();
      if (!this.#open || this.#enrollmentStarted || !source) this.#reject();
      this.#enrollmentStarted = true;
      const consume = source.consume.bind(source);
      return this.#track(
        Promise.resolve().then(async () => {
          this.#assertActive();
          const lease = await this.#invokeOwnerCallback(() => consume(this.unit));
          if (!lease) this.#reject();
          // Capture release first: later getter/fence failure must not orphan a
          // lease already transferred by the genuine enrollment owner.
          const release = lease.release.bind(lease);
          this.#lease = {
            release,
            prepareCommit: () => Promise.reject(unavailable()),
            assertCurrent: () => this.#reject(),
          };
          this.#lease.prepareCommit = lease.prepareCommit.bind(lease);
          this.#lease.assertCurrent = lease.assertCurrent.bind(lease);
          this.#assertLease();
          this.#enrolled = true;
        }),
      );
    } catch (error) {
      this.poison(error);
      return Promise.reject(error);
    }
  }

  runOperation<T>(
    kind: TurnCommandOperationV1,
    work: (scope: TurnCommandAcceptedOperationV1) => Promise<T>,
  ): Promise<T> {
    try {
      this.#assertLease();
      if (
        !this.#open ||
        !this.#enrolled ||
        this.#operation.getStore() !== undefined ||
        !["currentness-read", "journal-read", "journal-mutation", "mutation-audit"].includes(kind)
      )
        this.#reject();
    } catch (error) {
      this.poison(error);
      return Promise.reject(error);
    }
    const result = this.#track(
      this.#tail.then(async () => {
        this.#assertLease();
        let active = true;
        let accepting = true;
        const children = new Set<Promise<unknown>>();
        const assertActive = () => {
          if (!active) this.#reject();
          this.#assertLease();
        };
        const scope: TurnCommandAcceptedOperationV1 = Object.freeze({
          unit: this.unit,
          assertActive,
          track: <Value>(child: () => Promise<Value>): Promise<Value> => {
            try {
              if (!accepting) this.#reject();
              assertActive();
            } catch (error) {
              this.poison(error);
              return Promise.reject(error);
            }
            const pending = this.#track(
              Promise.resolve().then(async () => {
                assertActive();
                const value = await child();
                assertActive();
                return value;
              }),
            );
            children.add(pending);
            void pending.then(
              () => children.delete(pending),
              () => children.delete(pending),
            );
            return pending;
          },
        });
        let value: T;
        const executing = { active: true };
        try {
          value = await this.#operation.run(executing, () => work(scope));
        } catch (error) {
          this.poison(error);
          throw error;
        } finally {
          accepting = false;
          while (children.size) await Promise.allSettled([...children]);
          executing.active = false;
          active = false;
        }
        this.#assertLease();
        return value;
      }),
    );
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  closeAdmissions(): void {
    this.#open = false;
  }

  async drainAccepted(): Promise<void> {
    this.closeAdmissions();
    if (this.#operation.getStore() !== undefined) this.#reject();
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  prepareCommit(): Promise<void> {
    this.closeAdmissions();
    if (this.#preparing || this.#operation.getStore() !== undefined) {
      try {
        this.#reject();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    this.#preparing = true;
    // Do not put this drain promise in its own pending set.
    return (async () => {
      await this.drainAccepted();
      this.#assertLease();
      if (!this.#enrolled) this.#reject();
      await this.#track(
        Promise.resolve().then(() => {
          this.#assertLease();
          return this.#invokeOwnerCallback(() => this.#lease!.prepareCommit());
        }),
      );
      await this.drainAccepted();
      this.#assertLease();
      this.#prepared = true;
    })().catch((error: unknown) => {
      this.poison(error);
      throw error;
    });
  }

  /** Synchronous final fence; the caller must send raw COMMIT without an await. */
  assertCommitReady(): undefined {
    this.#assertLease();
    if (this.#open || !this.#prepared || this.#pending.size || this.#dispatched) this.#reject();
    return undefined;
  }

  markCommitDispatched(): void {
    this.assertCommitReady();
    this.#dispatched = true;
  }

  /** Capture protocol fact even when cancellation raced the returned ACK. */
  observeCommitAcknowledgement(command: unknown): void {
    if (
      !this.#dispatched ||
      this.#acknowledged ||
      this.#terminal !== undefined ||
      command !== "COMMIT"
    )
      this.#reject();
    this.#acknowledged = true;
  }

  finishTerminal(outcome: TurnCommandTerminalV1): Promise<void> {
    if (this.#operation.getStore() !== undefined) {
      try {
        this.#reject();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (this.#terminalWork) {
      if (outcome === this.#terminal) return this.#terminalWork;
      return Promise.reject(unavailable());
    }
    if (
      !["rolled-back", "commit-rejected", "commit-unknown", "committed"].includes(outcome) ||
      (outcome === "committed" && !this.#acknowledged) ||
      (outcome === "rolled-back" && this.#dispatched) ||
      (outcome === "commit-rejected" && (!this.#dispatched || this.#acknowledged)) ||
      (outcome === "commit-unknown" && (!this.#dispatched || this.#acknowledged))
    )
      return Promise.reject(unavailable());
    this.closeAdmissions();
    this.#terminal = outcome;
    this.#terminalWork = (async () => {
      await this.drainAccepted();
      try {
        if (this.#lease) await this.#invokeOwnerCallback(() => this.#lease!.release(outcome));
      } catch (error) {
        this.poison(error);
      } finally {
        this.#active = false;
        this.#signal.removeEventListener("abort", this.#abort);
      }
      if (this.#failed) throw this.#failure;
    })();
    return this.#terminalWork;
  }
}
