import {
  WorkClaimLostError,
  type ClaimedWork,
  type PostgresWorkQueue,
} from "@openclaw-enterprise/occ";

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

  async run<T>(context: WorkerClaimContext, effect: () => Promise<T>): Promise<T> {
    // Short consecutive effects still renew before each call, even when their
    // individual timers never fire during the longer reconciliation sequence.
    await this.renew(context);
    let lost = false;
    let pending = Promise.resolve();
    const operation = new AbortController();
    const abandon = () => {
      lost = true;
      operation.abort(new WorkClaimLostError());
    };
    context.signal.addEventListener("abort", abandon, { once: true });
    if (context.signal.aborted) abandon();
    const heartbeat = setInterval(
      () => {
        pending = pending.then(async () => {
          if (lost) return;
          await this.renew(context);
        });
        pending.catch(() => {
          abandon();
        });
      },
      Math.max(1, Math.floor(this.options.leaseDurationMs / 3)),
    );
    heartbeat.unref();
    try {
      if (lost) throw new WorkClaimLostError();
      return await this.options.withAbortSignal(operation.signal, () => {
        if (lost || context.signal.aborted) throw new WorkClaimLostError();
        return effect();
      });
    } finally {
      clearInterval(heartbeat);
      context.signal.removeEventListener("abort", abandon);
      await pending.catch(() => {});
      if (lost) throw new WorkClaimLostError();
    }
  }
}
