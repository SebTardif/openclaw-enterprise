import {
  WorkClaimLostError,
  type ClaimedWork,
  type PostgresWorkQueue,
} from "@openclaw-enterprise/occ";
import type { WorkerRevisionCurrentness } from "./revision-currentness.ts";

/** The exact claimed work and cancellation owned by this worker run. */
export interface WorkerClaimContext {
  readonly claim: Readonly<ClaimedWork>;
  readonly signal: AbortSignal;
}

export interface LeasedEffectOptions {
  readonly queue: Pick<PostgresWorkQueue, "heartbeat">;
  readonly leaseDurationMs: number;
  readonly withAbortSignal: <T>(signal: AbortSignal, effect: () => Promise<T>) => Promise<T>;
}

/** Renews the existing claim and carries cooperative cancellation to each effect. */
export class LeasedEffects {
  private readonly options: LeasedEffectOptions;

  constructor(options: LeasedEffectOptions) {
    this.options = options;
  }

  async renew(context: WorkerClaimContext): Promise<void> {
    if (context.signal.aborted) throw new WorkClaimLostError();
    const renewed = await this.options.queue.heartbeat(context.claim);
    if (context.signal.aborted || renewed === undefined) throw new WorkClaimLostError();
  }

  async renewRevision(
    context: WorkerClaimContext,
    currentness: Pick<WorkerRevisionCurrentness, "assertCurrent">,
  ): Promise<void> {
    if (context.signal.aborted) throw new WorkClaimLostError();
    await currentness.assertCurrent();
    await this.renew(context);
    await currentness.assertCurrent();
    if (context.signal.aborted) throw new WorkClaimLostError();
  }

  /** Running revision effects cannot omit their original current-state reader. */
  async runRevision<T>(
    context: WorkerClaimContext,
    currentness: Pick<WorkerRevisionCurrentness, "assertCurrent">,
    effect: (assertCurrent: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    if (currentness === undefined || typeof currentness.assertCurrent !== "function")
      throw new TypeError("Running revision currentness is required.");
    return this.runOwned(context, effect, currentness);
  }

  /** Namespace effects and separately classified legacy cleanup retain this path. */
  async run<T>(context: WorkerClaimContext, effect: () => Promise<T>): Promise<T> {
    return this.runOwned(context, effect);
  }

  private async runOwned<T>(
    context: WorkerClaimContext,
    effect: (assertCurrent: () => Promise<void>) => Promise<T>,
    currentness?: Pick<WorkerRevisionCurrentness, "assertCurrent">,
  ): Promise<T> {
    const renew = () =>
      currentness === undefined ? this.renew(context) : this.renewRevision(context, currentness);
    await renew();
    let failed = false;
    let failure: unknown;
    let pending = Promise.resolve();
    const operation = new AbortController();
    const abandon = (error: unknown) => {
      if (!failed) {
        failed = true;
        failure = error;
      }
      operation.abort(failure);
    };
    const assertOwnedCurrent = async () => {
      if (failed) throw failure;
      if (context.signal.aborted) throw new WorkClaimLostError();
      if (currentness !== undefined) await currentness.assertCurrent();
      if (failed) throw failure;
      if (context.signal.aborted) throw new WorkClaimLostError();
    };
    const cancelled = () => abandon(new WorkClaimLostError());
    context.signal.addEventListener("abort", cancelled, { once: true });
    if (context.signal.aborted) cancelled();
    const heartbeat = setInterval(
      () => {
        pending = pending.then(async () => {
          if (failed) return;
          try {
            await renew();
          } catch (error) {
            // Preserve the original legacy classification. Revision currentness
            // and genuine queue claim loss retain their exact first error.
            abandon(currentness === undefined ? new WorkClaimLostError() : error);
          }
        });
      },
      Math.max(1, Math.floor(this.options.leaseDurationMs / 3)),
    );
    heartbeat.unref();
    try {
      if (failed) throw failure;
      // A completed renewal is not a durable permit across a later await.
      await assertOwnedCurrent();
      const result = await this.options.withAbortSignal(operation.signal, () => {
        if (failed) throw failure;
        if (context.signal.aborted) throw new WorkClaimLostError();
        return effect(assertOwnedCurrent);
      });
      await assertOwnedCurrent();
      return result;
    } catch (error) {
      if (currentness !== undefined) abandon(error);
      throw error;
    } finally {
      clearInterval(heartbeat);
      context.signal.removeEventListener("abort", cancelled);
      await pending;
      if (failed) throw failure;
    }
  }
}
