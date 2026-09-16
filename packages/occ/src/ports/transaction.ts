import { AsyncLocalStorage } from "node:async_hooks";
import { promiseHooks } from "node:v8";
import { types } from "node:util";
import { ScopeViolationError } from "../errors.ts";
import type { RuntimeAuthorityTransactionGuard } from "../runtime-authority/repository.ts";

interface RepositoryOperationContext {
  open: boolean;
  readonly authority: boolean;
}

// An earlier callback reaction can run before the owner's .then handler.
// Close admission at native settlement before that reaction starts fresh work.
// Promise keys are weak; pending callback closures are removed at settlement.
const observedPromises = new WeakSet<Promise<unknown>>();
const settledPromises = new WeakSet<Promise<unknown>>();
const settlementCallbacks = new WeakMap<Promise<unknown>, Set<() => void>>();
// Keep the stop handle private. Observation spans module import through process exit:
// deferred callbacks may return Promises created before any State lifetime exists.
const settlementObserver = {
  stop: promiseHooks.createHook({
    init: (promise) => {
      observedPromises.add(promise);
    },
    settled: (promise) => {
      settledPromises.add(promise);
      const callbacks = settlementCallbacks.get(promise);
      if (callbacks !== undefined) {
        for (const close of callbacks) close();
        settlementCallbacks.delete(promise);
      }
    },
  }),
};

function observeSettlement(promise: Promise<unknown>, close: () => void): void {
  // Native brand recognition includes subclasses and Promises from other realms.
  // Unknown/pre-import Promises cannot prove a still-open callback boundary.
  if (!types.isPromise(promise) || !observedPromises.has(promise) || settledPromises.has(promise)) {
    close();
    return;
  }
  const callbacks = settlementCallbacks.get(promise) ?? new Set<() => void>();
  callbacks.add(close);
  settlementCallbacks.set(promise, callbacks);
}

/**
 * Owns outward admission and the complete lifetime of accepted repository work.
 * Private per-operation contexts let accepted collaborators finish during drain;
 * an inherited context stops admitting work when its own callback settles.
 */
export class RepositoryTransactionLifetime {
  private accepting = true;
  private active = true;
  private readonly pending = new Set<Promise<void>>();
  private readonly operationContext = new AsyncLocalStorage<RepositoryOperationContext>();

  private readonly authorityGuard: RuntimeAuthorityTransactionGuard | undefined;

  constructor(authorityGuard?: RuntimeAuthorityTransactionGuard) {
    this.authorityGuard = authorityGuard;
    // Retain one shared observer, including its stop handle, across overlapping owners.
    void settlementObserver;
  }

  /** Observe the original outer callback without extending its admission boundary. */
  runOwnerCallback<T>(work: () => Promise<T>): Promise<T> {
    const close = () => {
      this.accepting = false;
    };
    try {
      const returned = work();
      observeSettlement(returned, close);
      // Normalization delivers values; it does not determine admission.
      return Promise.resolve(returned).then(
        (value) => {
          close();
          return value;
        },
        (error: unknown) => {
          close();
          throw error;
        },
      );
    } catch (error) {
      close();
      throw error;
    }
  }

  assertActive(): void {
    if (!this.active) throw new ScopeViolationError("The platform transaction is closed.");
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    const context = this.operationContext.getStore();
    if (!this.active || (context ? !context.open : !this.accepting)) return this.denied();
    return this.enroll(work, context?.authority ?? false);
  }

  /** Core-only whole callback: enroll and invoke synchronously, never in the serial queue. */
  participate<T>(consume: () => Promise<T>): Promise<T> {
    const context = this.operationContext.getStore();
    if (!this.active || !this.accepting || (context !== undefined && !context.open))
      return this.denied();
    const guard = this.authorityGuard;
    if (guard === undefined) return this.denied();
    // Bind callback admission to consume's own Promise, rather than the guard's
    // later wrapper settlement. Accepted child contexts have independent lifetimes.
    return guard.participate(() => this.enroll(consume, true));
  }

  /** A nested mutation belongs to the existing callback; a standalone one enrolls it. */
  runAuthorityOperation<T>(work: () => Promise<T>): Promise<T> {
    const context = this.operationContext.getStore();
    return context?.authority ? this.run(work) : this.participate(work);
  }

  private denied<T>(): Promise<T> {
    const result = Promise.reject<T>(
      new ScopeViolationError("The platform transaction is closed."),
    );
    // Escaped/unawaited callers still receive rejection, without a process-level leak.
    void result.catch(() => {});
    return result;
  }

  private enroll<T>(work: () => Promise<T>, authority: boolean): Promise<T> {
    const context: RepositoryOperationContext = { open: true, authority };
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const completion = result.then(
      () => {},
      () => {},
    );
    // Registration precedes invocation, including synchronous throws and nested work.
    this.pending.add(completion);
    void completion.then(() => this.pending.delete(completion));
    const fail = (error: unknown) => {
      context.open = false;
      if (authority) this.authorityGuard?.fail(error);
      reject(error);
    };
    this.operationContext.run(context, () => {
      try {
        this.assertActive();
        const returned = work();
        observeSettlement(returned, () => {
          context.open = false;
        });
        const promise = Promise.resolve(returned);
        promise.then((value) => {
          context.open = false;
          resolve(value);
        }, fail);
      } catch (error) {
        fail(error);
      }
    });
    return result;
  }

  async finish(): Promise<void> {
    // Close fresh outward registrations before the first drain await.
    this.accepting = false;
    while (this.pending.size !== 0) await Promise.all([...this.pending]);
    this.active = false;
  }

  /** The owner closes backend access when transaction cleanup finishes. */
  close(): void {
    this.accepting = false;
    this.active = false;
  }
}
