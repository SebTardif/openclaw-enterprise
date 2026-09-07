import { performance } from "node:perf_hooks";
import type { GatewayStartupBindingV1 } from "@openclaw-enterprise/contracts/gateway-startup-v1";
import {
  GATEWAY_PHYSICAL_MATERIAL_LIMITS_V1,
  GatewayPhysicalMaterialUnavailableV1,
  captureGatewayKubernetesMaterialSelectionV1,
  type GatewayKubernetesMaterialSelectionV1,
  type GatewayKubernetesMaterialResultV1,
  type GatewayPhysicalSlackValuesV1,
} from "./kubernetes-gateway-material.ts";

export type GatewayPhysicalMaterialBindingV1 = Readonly<{
  startup: GatewayStartupBindingV1;
  recipientRef: string;
  recipientIncarnation: string;
  source: GatewayKubernetesMaterialSelectionV1;
}>;

/** Captured from the genuine accepting owner, after its original consumed claim
 * and separate protected material-purpose acceptance. This is an internal
 * dependency interface, not an implementation of that owner or a public RPC.
 * The owner must compare the complete fixed binding on every invocation.
 * Caller data, an ordinary startup claim or a successful GET cannot supply it. */
export type GatewayPhysicalMaterialOwnerV1 = Readonly<{
  signal: AbortSignal;
  assertConsumedCurrent(binding: GatewayPhysicalMaterialBindingV1): undefined;
  remainingStartupMs(): number;
  remainingSourceMs(): number;
}>;

export type GatewayPhysicalMaterialLeaseV1 = Readonly<{
  binding: GatewayPhysicalMaterialBindingV1;
  signal: AbortSignal;
  assertCurrent(): undefined;
  remainingMs(): number;
  withMaterial(
    consume: (values: GatewayPhysicalSlackValuesV1) => Promise<undefined>,
  ): Promise<void>;
  close(): Promise<"finished" | "unknown">;
}>;

function unavailable(): never {
  throw new GatewayPhysicalMaterialUnavailableV1();
}

function current(check: () => unknown): void {
  const result = check();
  if (result !== undefined) {
    if (result instanceof Promise) void result.catch(() => undefined);
    unavailable();
  }
}
function remaining(read: () => unknown): number {
  const result = read();
  if (result instanceof Promise) void result.catch(() => undefined);
  if (typeof result !== "number" || !Number.isFinite(result) || result <= 0) unavailable();
  return result;
}
function freeze<T>(input: T): T {
  if (input !== null && typeof input === "object") {
    for (const value of Object.values(input)) freeze(value);
    Object.freeze(input);
  }
  return input;
}

/** One original owned acquisition and one joined local consumer, with no queue,
 * retries, cache, provider calls or material transport. All initial metadata
 * comes from a previously parsed trusted selection; cloning/freezing preserves
 * correspondence but authenticates nothing. Only the fixed Slack pair is read.
 *
 * The consumer is trusted in-process and must resolve undefined only after all
 * its actual material use has settled. Rejecting or returning another result
 * is unknown: storage is retained, never silently released. A hanging read or
 * consumer keeps close pending. This is not a physical termination guarantee.
 *
 * The selected protected wire purpose/codec and qualified Teams token supplier
 * must be supplied separately; this factory does not assemble Gateway input,
 * log values/digests or expose a callable route. */
export function createGatewayPhysicalMaterialSourceV1(
  owner: GatewayPhysicalMaterialOwnerV1,
  selection: GatewayPhysicalMaterialBindingV1,
  reader: Readonly<{
    read(
      selection: GatewayKubernetesMaterialSelectionV1,
      signal: AbortSignal,
    ): Promise<GatewayKubernetesMaterialResultV1>;
  }>,
): Readonly<{
  binding: GatewayPhysicalMaterialBindingV1;
  acquire(): Promise<GatewayPhysicalMaterialLeaseV1>;
  close(): Promise<"finished" | "unknown">;
}> {
  let binding: GatewayPhysicalMaterialBindingV1;
  let sourceSignal: AbortSignal;
  let accept: (binding: GatewayPhysicalMaterialBindingV1) => unknown;
  let startupRemaining: () => unknown;
  let sourceRemaining: () => unknown;
  let read: typeof reader.read;
  try {
    if (
      !(owner.signal instanceof AbortSignal) ||
      typeof owner.assertConsumedCurrent !== "function" ||
      typeof owner.remainingStartupMs !== "function" ||
      typeof owner.remainingSourceMs !== "function" ||
      typeof reader.read !== "function"
    )
      unavailable();
    if (
      typeof selection.recipientRef !== "string" ||
      !selection.recipientRef ||
      selection.recipientRef.length > 200 ||
      typeof selection.recipientIncarnation !== "string" ||
      !selection.recipientIncarnation ||
      selection.recipientIncarnation.length > 200
    )
      unavailable();
    binding = freeze({
      startup: structuredClone(selection.startup),
      recipientRef: selection.recipientRef,
      recipientIncarnation: selection.recipientIncarnation,
      source: captureGatewayKubernetesMaterialSelectionV1(selection.source),
    });
    sourceSignal = owner.signal;
    accept = owner.assertConsumedCurrent.bind(owner);
    startupRemaining = owner.remainingStartupMs.bind(owner);
    sourceRemaining = owner.remainingSourceMs.bind(owner);
    read = reader.read.bind(reader);
  } catch {
    return unavailable();
  }

  const abort = new AbortController();
  let used = false;
  let consumerUsed = false;
  let closed = false;
  let unknown = false;
  let deadline = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let owned: GatewayKubernetesMaterialResultV1 | undefined;
  let acquisition: Promise<GatewayPhysicalMaterialLeaseV1> | undefined;
  let use: Promise<void> | undefined;
  let closeTask: Promise<"finished" | "unknown"> | undefined;

  function invalidate(): void {
    abort.abort();
  }
  sourceSignal.addEventListener("abort", invalidate, { once: true });
  if (sourceSignal.aborted) invalidate();

  function assertCurrent(): undefined {
    try {
      if (
        closed ||
        abort.signal.aborted ||
        sourceSignal.aborted ||
        (deadline !== 0 && performance.now() >= deadline)
      )
        unavailable();
      current(() => accept(binding));
      remaining(startupRemaining);
      remaining(sourceRemaining);
      if (
        closed ||
        abort.signal.aborted ||
        sourceSignal.aborted ||
        (deadline !== 0 && performance.now() >= deadline)
      )
        unavailable();
      return undefined;
    } catch {
      invalidate();
      return unavailable();
    }
  }

  function remainingMs(): number {
    try {
      assertCurrent();
      const sampledAt = performance.now();
      const sampledRemaining = Math.min(
        remaining(startupRemaining),
        remaining(sourceRemaining),
        deadline === 0 ? GATEWAY_PHYSICAL_MATERIAL_LIMITS_V1.acquireMs : deadline - sampledAt,
      );
      if (sampledRemaining <= 0) unavailable();
      // Original numeric readers can throw or withdraw the owning source.
      // No value escapes until their side effects pass the final owner fence.
      assertCurrent();
      const now = performance.now();
      const result = Math.min(
        sampledRemaining - (now - sampledAt),
        deadline === 0 ? Infinity : deadline - now,
      );
      if (result <= 0) unavailable();
      return result;
    } catch {
      invalidate();
      return unavailable();
    }
  }

  function close(): Promise<"finished" | "unknown"> {
    if (closeTask !== undefined) return closeTask;
    let finish!: (value: "finished" | "unknown") => void;
    closeTask = new Promise((resolve) => {
      finish = resolve;
    });
    closed = true;
    invalidate();
    if (timer !== undefined) clearTimeout(timer);
    sourceSignal.removeEventListener("abort", invalidate);
    // Publish the unique promise before abort callbacks or consumer settlement.
    void (async () => {
      try {
        await acquisition?.catch(() => undefined);
        await use?.catch(() => undefined);
        if (unknown) {
          finish("unknown");
          return;
        }
        owned?.dispose();
        owned = undefined;
        finish("finished");
      } catch {
        unknown = true;
        finish("unknown");
      }
    })();
    return closeTask;
  }

  async function withMaterial(
    consume: (values: GatewayPhysicalSlackValuesV1) => Promise<undefined>,
  ): Promise<void> {
    if (consumerUsed) unavailable();
    consumerUsed = true;
    assertCurrent();
    if (owned === undefined || typeof consume !== "function") unavailable();
    const values = owned.borrow();
    // Install use before invoking consumer code; reentrant close joins it.
    let settle!: () => void;
    let reject!: (error: unknown) => void;
    use = new Promise<void>((resolve, fail) => {
      settle = resolve;
      reject = fail;
    });
    void use.catch(() => undefined);
    let completed = false;
    try {
      const result = consume(values);
      if (!(result instanceof Promise)) {
        unknown = true;
        unavailable();
      }
      const completion = await result;
      if (completion !== undefined) {
        unknown = true;
        unavailable();
      }
      completed = true;
      settle();
      assertCurrent();
    } catch {
      // An already confirmed consumer completion remains known even if the
      // post-use fence rejects. A thrown/rejected consumer is unjoined.
      if (!completed) unknown = true;
      if (!closed && !abort.signal.aborted) invalidate();
      reject(new GatewayPhysicalMaterialUnavailableV1());
      return unavailable();
    }
  }

  function acquire(): Promise<GatewayPhysicalMaterialLeaseV1> {
    if (used) return Promise.reject(new GatewayPhysicalMaterialUnavailableV1());
    used = true;
    try {
      assertCurrent();
      const budget = Math.min(
        GATEWAY_PHYSICAL_MATERIAL_LIMITS_V1.acquireMs,
        remaining(startupRemaining),
        remaining(sourceRemaining),
      );
      deadline = performance.now() + budget;
      timer = setTimeout(invalidate, budget);
      const lease: GatewayPhysicalMaterialLeaseV1 = Object.freeze({
        binding,
        signal: abort.signal,
        assertCurrent,
        remainingMs,
        withMaterial,
        close,
      });
      acquisition = (async () => {
        try {
          // Publish acquisition before any original reader callback can reenter.
          await Promise.resolve();
          assertCurrent();
          const result = await read(binding.source, abort.signal);
          owned = result;
          assertCurrent();
          // Lower-layer metadata is data correspondence only; the accepting
          // owner's exact source selection was fixed before the get.
          if (JSON.stringify(result.observed) !== JSON.stringify(binding.source)) unavailable();
          return lease;
        } catch {
          if (owned !== undefined && !consumerUsed) {
            owned.dispose();
            owned = undefined;
          }
          return unavailable();
        }
      })();
      void acquisition.catch(() => undefined);
      const interrupted = new Promise<never>((_, reject) => {
        const stop = () => reject(new GatewayPhysicalMaterialUnavailableV1());
        if (abort.signal.aborted) stop();
        else {
          abort.signal.addEventListener("abort", stop, { once: true });
          void acquisition?.then(
            () => abort.signal.removeEventListener("abort", stop),
            () => abort.signal.removeEventListener("abort", stop),
          );
        }
      });
      return Promise.race([acquisition, interrupted]);
    } catch {
      invalidate();
      return Promise.reject(new GatewayPhysicalMaterialUnavailableV1());
    }
  }
  return Object.freeze({ binding, acquire, close });
}
