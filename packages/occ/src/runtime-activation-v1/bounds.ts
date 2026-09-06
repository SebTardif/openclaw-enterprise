import { types } from "node:util";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { ContainmentFaultClockV1 } from "../containment/fault-request-adapter-v1.ts";

export class ActivationFailure extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}
export function requireValue(value: unknown, reason = "input-mismatch"): asserts value {
  if (!value) throw new ActivationFailure(reason);
}
/** Inspect descriptors before copying; never invoke input accessors or coercions. */
export function snapshot<T>(input: T): T {
  let nodes = 131_072;
  const visit = (value: unknown, depth: number): void => {
    requireValue(--nodes >= 0 && depth <= 40, "input-capacity");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      requireValue(value.length <= 1_048_576);
      return;
    }
    if (typeof value === "number") {
      requireValue(Number.isFinite(value));
      return;
    }
    requireValue(typeof value === "object" && !types.isProxy(value), "invalid-input");
    const proto = Object.getPrototypeOf(value);
    requireValue(
      proto === Object.prototype ||
        proto === null ||
        (Array.isArray(value) && proto === Array.prototype),
    );
    const keys = Reflect.ownKeys(value);
    requireValue(keys.length <= 1025, "input-capacity");
    if (Array.isArray(value))
      requireValue(
        keys.length === value.length + 1 &&
          Array.from({ length: value.length }, (_, index) => String(index)).every((key) =>
            keys.includes(key),
          ),
        "invalid-input",
      );
    for (const key of keys) {
      requireValue(
        typeof key === "string" && !["__proto__", "prototype", "constructor"].includes(key),
      );
      const property = Object.getOwnPropertyDescriptor(value, key);
      requireValue(
        property &&
          "value" in property &&
          (property.enumerable || (Array.isArray(value) && key === "length")),
      );
      visit(property.value, depth + 1);
    }
  };
  visit(input, 0);
  requireValue(Buffer.byteLength(JSON.stringify(input)) <= 2_097_152, "input-capacity");
  return immutableCopy(input);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}
export const same = (left: unknown, right: unknown): boolean =>
  canonical(left) === canonical(right);

/** Local waits only. Original context, request, recipient and UTC deadline survive;
 * the actual acceptor still owns claim/current-authority and possible-effect checks. */
export class ActivationBudget {
  readonly call: AuthorityCallV1;
  private readonly start: { wall: number; mono: number };
  private previous: { wall: number; mono: number };
  private readonly deadline: number;
  private readonly clock: ContainmentFaultClockV1;
  constructor(clock: ContainmentFaultClockV1, call: AuthorityCallV1) {
    this.clock = clock;
    this.call = Object.freeze({
      context: call.context,
      requestRef: call.requestRef,
      recipientRef: call.recipientRef,
      deadline: call.deadline,
      signal: call.signal,
    });
    this.deadline = Date.parse(call.deadline);
    requireValue(
      Number.isSafeInteger(this.deadline) &&
        new Date(this.deadline).toISOString() === call.deadline,
      "invalid-deadline",
    );
    this.start = this.previous = this.sample();
    this.check();
  }
  private sample() {
    const wall = this.clock.wallNowMs(),
      mono = this.clock.monotonicNowMs();
    requireValue(
      Number.isSafeInteger(wall) &&
        wall >= 0 &&
        Number.isFinite(mono) &&
        mono >= 0 &&
        mono <= Number.MAX_SAFE_INTEGER,
      "clock-unavailable",
    );
    return { wall, mono };
  }
  check() {
    requireValue(!this.call.signal.aborted, "cancelled");
    const now = this.sample();
    requireValue(
      now.wall >= this.previous.wall && now.mono >= this.previous.mono,
      "clock-rollback",
    );
    this.previous = now;
    requireValue(
      now.wall < this.deadline && now.mono - this.start.mono < this.deadline - this.start.wall,
      "deadline-exceeded",
    );
    // ISO43 persists integer milliseconds; deadline arithmetic retains full precision.
    return { now: new Date(now.wall).toISOString(), monotonicMs: Math.floor(now.mono) };
  }
  async run<T>(work: (call: AuthorityCallV1) => Promise<T>, ceiling = 10_000): Promise<T> {
    this.check();
    const before = this.previous;
    const duration = Math.min(
      ceiling,
      this.deadline - before.wall,
      this.deadline - this.start.wall - (before.mono - this.start.mono),
    );
    const controller = new AbortController();
    let dispose = () => {};
    let stop = (_reason: string) => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      stop = (reason) => {
        controller.abort();
        reject(new ActivationFailure(reason));
      };
    });
    const abort = () => stop("cancelled");
    this.call.signal.addEventListener("abort", abort, { once: true });
    const pending = Promise.resolve().then(() => {
      this.check();
      requireValue(!controller.signal.aborted, "deadline-exceeded");
      return work(Object.freeze({ ...this.call, signal: controller.signal }));
    });
    const raced = Promise.race([pending, stopped]);
    try {
      try {
        dispose = this.clock.schedule(duration, () => stop("deadline-exceeded"));
      } catch {
        stop("clock-unavailable");
      }
      const result = await raced;
      this.check();
      requireValue(
        !controller.signal.aborted &&
          this.previous.mono - before.mono < duration &&
          this.previous.wall - before.wall < duration,
        "deadline-exceeded",
      );
      return result;
    } finally {
      controller.abort();
      this.call.signal.removeEventListener("abort", abort);
      try {
        dispose();
      } catch {
        /* Disposal cannot change possible-effect truth. */
      }
    }
  }
}
