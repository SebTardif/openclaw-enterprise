/** Local limits do not authenticate a source or extend its original lease. */
export const GATEWAY_MATERIAL_LIMITS_V1 = Object.freeze({
  itemBytes: 32_768,
  bundleBytes: 65_536,
  acquisitionMs: 5_000,
});

export type GatewayMaterialCleanupV1 = Readonly<{
  cleanup: "finished" | "failed" | "unknown";
}>;

export class GatewayMaterialUnavailableV1 extends Error {
  constructor() {
    super("Gateway startup material unavailable");
    this.name = "GatewayMaterialUnavailableV1";
  }
}

/** Exact synchronous fences cannot be replaced by a promise or Boolean. */
export function assertGatewayMaterialCurrentV1(assertCurrent: () => unknown): void {
  try {
    const result = assertCurrent();
    if (result !== undefined) {
      // Rejected native promises must not escape as a second raw diagnostic.
      // Observing settlement never turns an asynchronous value into authority.
      if (result instanceof Promise) void Promise.prototype.then.call(result, undefined, () => {});
      throw new GatewayMaterialUnavailableV1();
    }
  } catch {
    throw new GatewayMaterialUnavailableV1();
  }
}

export interface GatewayMaterialOwnedLeaseV1 {
  readonly signal: AbortSignal;
  /** Release only this lease's resources, not a transferred native module. */
  release(): Promise<GatewayMaterialCleanupV1>;
}

export interface GatewayMaterialCustodyV1 {
  readonly signal: AbortSignal;
  acquire<T extends GatewayMaterialOwnedLeaseV1>(
    source: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  assertActive(): void;
  /** Caller first joins any consumers of already borrowed resources. */
  close(): Promise<GatewayMaterialCleanupV1>;
}

/** Recipient-local cleanup accounting, not a source registrar or authority.
 * Only trusted composition supplies the original protected source callbacks.
 * Invalidation fences immediately; release waits for explicit owner close so
 * retained native consumers can settle before underlying material is released. */
export function createGatewayMaterialCustodyV1(
  parentSignal: AbortSignal,
): GatewayMaterialCustodyV1 {
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  type Record = {
    lease: GatewayMaterialOwnedLeaseV1;
    signal?: AbortSignal;
    release: () => Promise<GatewayMaterialCleanupV1>;
    result?: Promise<void>;
  };
  const leases: Record[] = [];
  const seen = new WeakSet<object>();
  let closed = false;
  let closing: Promise<GatewayMaterialCleanupV1> | undefined;
  let cleanup: GatewayMaterialCleanupV1["cleanup"] = "finished";

  function merge(value: unknown): void {
    try {
      if (typeof value !== "object" || value === null || !Object.hasOwn(value, "cleanup"))
        throw new Error();
      const result = (value as GatewayMaterialCleanupV1).cleanup;
      if (result === "unknown" || (result !== "finished" && result !== "failed"))
        cleanup = "unknown";
      else if (result === "failed" && cleanup !== "unknown") cleanup = "failed";
    } catch {
      cleanup = "unknown";
    }
  }

  function release(record: Record): Promise<void> {
    record.result ??= Promise.resolve()
      .then(record.release)
      .then(merge, () => {
        if (cleanup !== "unknown") cleanup = "failed";
      });
    return record.result;
  }

  function fence(): void {
    if (!lifetime.signal.aborted) lifetime.abort();
  }
  function assertActive(): void {
    if (closed || lifetime.signal.aborted || parentSignal.aborted)
      throw new GatewayMaterialUnavailableV1();
  }

  async function acquire<T extends GatewayMaterialOwnedLeaseV1>(
    source: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    assertActive();
    const result = Promise.resolve()
      .then(() => {
        assertActive();
        return source(lifetime.signal);
      })
      .then(async (lease) => {
        // Capture ownership before post-await validation. Invalid results cannot
        // establish custody; retain any available disposer rather than losing it.
        if (typeof lease !== "object" || lease === null || seen.has(lease))
          throw new GatewayMaterialUnavailableV1();
        seen.add(lease);
        let record: Record;
        try {
          const releaseMethod = lease.release;
          if (typeof releaseMethod !== "function") throw new Error();
          record = { lease, release: () => releaseMethod.call(lease) };
          leases.push(record);
          const signal = lease.signal;
          if (!(signal instanceof AbortSignal)) throw new Error();
          record.signal = signal;
        } catch {
          cleanup = "unknown";
          throw new GatewayMaterialUnavailableV1();
        }
        record.signal!.addEventListener("abort", fence, { once: true });
        if (record.signal!.aborted) fence();
        if (closed || lifetime.signal.aborted || parentSignal.aborted) {
          await release(record);
          throw new GatewayMaterialUnavailableV1();
        }
        return lease;
      });
    pending.add(result);
    try {
      return await result;
    } catch {
      throw new GatewayMaterialUnavailableV1();
    } finally {
      pending.delete(result);
    }
  }

  function close(): Promise<GatewayMaterialCleanupV1> {
    if (closing) return closing;
    let finish!: (value: GatewayMaterialCleanupV1) => void;
    closing = new Promise((resolve) => {
      finish = resolve;
    });
    // Publish the unique join before abort handlers can synchronously reenter.
    closed = true;
    fence();
    parentSignal.removeEventListener("abort", fence);
    void (async () => {
      await Promise.allSettled([...pending]);
      for (const record of [...leases].reverse()) {
        record.signal?.removeEventListener("abort", fence);
        await release(record);
      }
      finish(Object.freeze({ cleanup }));
    })();
    return closing;
  }

  parentSignal.addEventListener("abort", fence, { once: true });
  if (parentSignal.aborted) fence();
  return Object.freeze({ signal: lifetime.signal, acquire, assertActive, close });
}
