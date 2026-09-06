import * as original from "../runtime-effects-v1/vectors.mjs";

// Synthetic original-port values and controlled scheduling only. No fixture
// authenticates a service, persists a fault, or proves physical termination.
export const fault = original.fault;
export const clone = structuredClone;
export const expected = (input) => ({
  target: input.target,
  guard: input.guard,
  cleanupResponsibility: input.cleanupResponsibility,
  cause: input.cause,
});
export const receipt = (input, status = "accepted") => ({
  status,
  receipt: {
    schemaVersion: 1,
    operation: input.operation,
    fault: input,
    denialRecordRef: original.uuid(910),
    denialRecordVersion: 1,
    cleanupResponsibility: input.cleanupResponsibility,
    fence: original.fenceRequest(),
    admission: "durably-closed",
    downstreamStop: "not-proved",
    evidence: original.evidence("denial-commit"),
  },
});
export const unresolved = (input, status = "commit-unknown") => ({
  status,
  operation: input.operation,
  reasonCode: "unavailable",
});
export const call = (clock, controller = new AbortController(), remainingMs = 20_000) => ({
  context: Object.freeze({ syntheticTestHandle: true }),
  requestRef: "synthetic-original-request",
  recipientRef: "synthetic-original-recipient",
  deadline: new Date(clock.wall + remainingMs).toISOString(),
  signal: controller.signal,
});
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
export class Clock {
  wall = Date.parse(original.now);
  monotonic = 0;
  timers = new Set();
  port = {
    wallNowMs: () => this.wall,
    monotonicNowMs: () => this.monotonic,
    schedule: (delayMs, callback) => {
      const timer = { due: this.monotonic + delayMs, callback };
      this.timers.add(timer);
      return () => this.timers.delete(timer);
    },
  };
  advance(ms) {
    this.wall += ms;
    this.monotonic += ms;
    for (const timer of this.timers) {
      if (timer.due <= this.monotonic) {
        this.timers.delete(timer);
        timer.callback();
      }
    }
  }
}
