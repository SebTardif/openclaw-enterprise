import { currentComputeAbortSignal } from "../../../apps/controller/src/drivers/compute/operation-context.ts";
import { createDevelopmentComputeDriver } from "../../helpers/development.mjs";

// These passive Drivers expose worker ordering and cancellation, not live runtime proof.
// Queue admission, authorization, leases and finalization all use the real PostgreSQL worker.
export function recordingCompute(hooks = {}) {
  const calls = [];
  const base = createDevelopmentComputeDriver();
  const driver = { ...base };
  for (const operation of [
    "ensureNamespace",
    "deleteNamespace",
    "bindAgent",
    "prepareRevision",
    "retireRevision",
  ]) {
    if (base[operation] === undefined && hooks[operation] === undefined) continue;
    driver[operation] = async (...args) => {
      const call = { operation, args, signal: currentComputeAbortSignal() };
      calls.push(call);
      await hooks[operation]?.(call);
      return base[operation]?.(...args);
    };
  }
  return { driver, calls };
}

export function effectGate({ releaseOnAbort = false } = {}) {
  const entered = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const release = Promise.withResolvers();
  return {
    entered: entered.promise,
    aborted: aborted.promise,
    release: release.resolve,
    async hold(call) {
      const signal = call.signal;
      if (signal === undefined) throw new Error("Worker effect is missing its abort context.");
      const onAbort = () => {
        aborted.resolve(signal.reason);
        if (releaseOnAbort) release.resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      entered.resolve(call);
      try {
        await release.promise;
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
