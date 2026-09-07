import type {
  RuntimeIdentityCloseResultV1,
  RuntimeIdentityInvalidationV1,
} from "@openclaw-enterprise/contracts/runtime-identity-v1";

/** Trusted clock/scheduler installation. The optional clock is for controlled integration
 * tests and embedding; request data never selects it. Times are milliseconds. */
export interface RuntimeIdentityClockV1 {
  now(): number;
  monotonicNow(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

export function captureRuntimeIdentityClockV1(
  clock?: RuntimeIdentityClockV1,
): RuntimeIdentityClockV1 {
  if (clock) {
    return Object.freeze({
      now: clock.now.bind(clock),
      monotonicNow: clock.monotonicNow.bind(clock),
      schedule: clock.schedule.bind(clock),
    });
  }
  return Object.freeze({
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    schedule(callback: () => void, delayMs: number) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  });
}

/** Internal ownership, not a transport or data queue. Cancellation settles the public
 * wait; only actual operation settlement releases capacity. No borrowed object is closed. */
export class RuntimeIdentityStreamLifetimeV1 {
  readonly #controller = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #timers = new Map<string, () => void>();
  readonly #clock: RuntimeIdentityClockV1;
  readonly #requestRef: string;
  readonly #closeMs: number;
  readonly #release: () => void;
  readonly #originalSignal: AbortSignal;
  readonly #originalAbort: () => void;
  readonly #started: number;
  readonly #end: number;
  readonly #wallEnd: number;
  #released = false;
  #reason: RuntimeIdentityInvalidationV1 | undefined;
  #close: Promise<RuntimeIdentityCloseResultV1> | undefined;

  constructor(options: {
    clock: RuntimeIdentityClockV1;
    requestRef: string;
    signal: AbortSignal;
    started: number;
    monotonicDeadline: number;
    wallDeadline: number;
    closeDeadlineMs: number;
    release(): void;
  }) {
    this.#clock = options.clock;
    this.#requestRef = options.requestRef;
    this.#closeMs = options.closeDeadlineMs;
    this.#release = options.release;
    this.#started = options.started;
    this.#end = options.monotonicDeadline;
    this.#wallEnd = options.wallDeadline;
    this.#originalSignal = options.signal;
    this.#originalAbort = () => this.invalidate("cancelled");
    options.signal.addEventListener("abort", this.#originalAbort, { once: true });
    this.arm("original-deadline", this.#end, "deadline-exceeded");
    if (options.signal.aborted) this.invalidate("cancelled");
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  get reason(): RuntimeIdentityInvalidationV1 | undefined {
    return this.#reason;
  }
  get monotonicDeadline(): number {
    return this.#end;
  }
  get wallDeadline(): number {
    return this.#wallEnd;
  }

  /** Synchronous terminal check is also called after every dependency await. */
  current(): boolean {
    if (this.signal.aborted) return false;
    const mono = this.#clock.monotonicNow();
    const wall = this.#clock.now();
    if (
      !Number.isFinite(mono) ||
      !Number.isFinite(wall) ||
      mono < this.#started ||
      mono >= this.#end ||
      wall >= this.#wallEnd
    )
      this.invalidate("deadline-exceeded");
    return !this.signal.aborted;
  }

  /** Independent timers remain active when a caller never reads another data item. */
  arm(key: string, deadline: number, reason: RuntimeIdentityInvalidationV1): void {
    this.#timers.get(key)?.();
    this.#timers.delete(key);
    if (this.signal.aborted) return;
    const remaining = deadline - this.#clock.monotonicNow();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      this.invalidate(reason);
      return;
    }
    const cancel = this.#clock.schedule(
      () => {
        this.#timers.delete(key);
        if (!this.current()) return;
        if (this.#clock.monotonicNow() < deadline) this.arm(key, deadline, reason);
        else this.invalidate(reason);
      },
      Math.min(remaining, 2_147_483_647),
    );
    this.#timers.set(key, cancel);
  }

  schedulePoll(delayMs: number, poll: () => void): void {
    this.#timers.get("poll")?.();
    if (!this.current()) return;
    this.#timers.set(
      "poll",
      this.#clock.schedule(() => {
        this.#timers.delete("poll");
        if (this.current()) poll();
      }, delayMs),
    );
  }

  track<T>(operation: Promise<T>): Promise<T> {
    this.#pending.add(operation);
    // Both handlers fulfill; an ignored rejecting dependency never becomes unhandled.
    void operation.then(
      () => this.#settled(operation),
      () => this.#settled(operation),
    );
    return operation;
  }

  #settled(operation: Promise<unknown>): void {
    this.#pending.delete(operation);
    this.#releaseIfSettled();
  }

  #releaseIfSettled(): void {
    if (this.signal.aborted && this.#pending.size === 0 && !this.#released) {
      this.#released = true;
      this.#release();
    }
  }

  invalidate(reason: RuntimeIdentityInvalidationV1): void {
    if (this.signal.aborted) return;
    this.#reason = reason;
    // Mark terminal before callbacks or any cleanup await can run.
    this.#controller.abort(reason);
    for (const cancel of this.#timers.values()) cancel();
    this.#timers.clear();
    this.#originalSignal.removeEventListener("abort", this.#originalAbort);
    this.#releaseIfSettled();
  }

  close(): Promise<RuntimeIdentityCloseResultV1> {
    this.invalidate("connection-closed");
    if (this.#close) return this.#close;
    if (this.#pending.size === 0) {
      this.#close = Promise.resolve({ kind: "closed" });
      return this.#close;
    }
    const joined = (async () => {
      while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
      return { kind: "closed" } as const;
    })();
    let cancelTimer = () => {};
    const timeout = new Promise<RuntimeIdentityCloseResultV1>((resolve) => {
      cancelTimer = this.#clock.schedule(
        () =>
          resolve({
            schemaVersion: 1,
            kind: "transport-failure",
            reasonCode: "cleanup-unsettled",
            requestRef: this.#requestRef,
          }),
        Math.min(this.#closeMs, 2_147_483_647),
      );
    });
    this.#close = Promise.race([joined, timeout]).finally(() => cancelTimer());
    return this.#close;
  }
}
