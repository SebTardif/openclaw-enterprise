import { performance } from "node:perf_hooks";
import type { GatewayMaterialRuntimeOwnerV1 } from "./startup-material.ts";
import type { GatewayHostV1 } from "openclaw/plugin-sdk/gateway-host";
import type {
  GatewayStartupBindingV2,
  GatewayStartupCloseV1,
  GatewayStartupLifetimeV1,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";
import type {
  GatewayStartupEnrollmentV2,
  GatewayStartupHandleV2,
  GatewayStartupRecipientV2,
  GatewayStartupStartResultV2,
} from "@openclaw-enterprise/contracts/gateway-startup-local-v2";
import { parseGatewayStartupBindingV2 } from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import type {
  GatewayStartupFixedAdapterV1,
  GatewayStartupMaterialLeaseV1,
  GatewayStartupPreparedCompositionV1,
} from "./startup-lifetime.ts";

/** Host material/adapter types are shared SDK operands; startup membership and
 * its exact recovery subject remain exclusively in this Agent/V2 owner. */
export interface GatewayStartupLocalGrantV2 {
  readonly binding: GatewayStartupBindingV2;
  readonly signal: AbortSignal;
  recheckCurrent(): Promise<void>;
  assertCurrent(): undefined;
  readClaim(): Promise<"current" | "denied" | "unavailable" | "unknown">;
  remainingSourceMs(): number;
  bindMaterial(runtime: GatewayMaterialRuntimeOwnerV1): Promise<void>;
  borrowMaterial(): Promise<GatewayStartupMaterialLeaseV1>;
  close(): Promise<GatewayStartupCloseV1["cleanup"]>;
}
export interface GatewayStartupEnrollmentSourceV2 {
  enroll(bootstrap: object): Promise<GatewayStartupLocalGrantV2 | undefined>;
}

type State = {
  readonly grant: GatewayStartupLocalGrantV2;
  readonly sourceSignal: AbortSignal;
  readonly pendingFences: Set<Promise<unknown>>;
  readonly binding: GatewayStartupBindingV2;
  readonly controller: AbortController;
  readonly closed: Promise<GatewayStartupCloseV1>;
  readonly resolveClosed: (value: GatewayStartupCloseV1) => void;
  readonly recheck: () => Promise<void>;
  readonly fence: () => undefined;
  readonly readClaim: () => Promise<"current" | "denied" | "unavailable" | "unknown">;
  readonly borrow: () => Promise<GatewayStartupMaterialLeaseV1>;
  readonly bindMaterial: (runtime: GatewayMaterialRuntimeOwnerV1) => Promise<void>;
  readonly remainingSourceMs: () => number;
  readonly startupStartedAt: number;
  readonly releaseGrant: () => Promise<GatewayStartupCloseV1["cleanup"]>;
  used: boolean;
  revoked: boolean;
  started: boolean;
  claimed: boolean;
  initializing?: Promise<void>;
  preparing?: Promise<void>;
  preparationFailed: boolean;
  consumerJoin?: Promise<void>;
  material?: GatewayStartupMaterialLeaseV1;
  prepared?: GatewayStartupPreparedCompositionV1;
  preparedClose?: Promise<GatewayStartupCloseV1["cleanup"]>;
  releasePrepared?: () => Promise<Readonly<{ cleanup: GatewayStartupCloseV1["cleanup"] }>>;
  startPrepared?: () => GatewayHostV1;
  hostQuiesced: boolean;
  materialClose?: Promise<GatewayStartupCloseV1["cleanup"]>;
  grantClose?: Promise<GatewayStartupCloseV1["cleanup"]>;
  host?: GatewayHostV1;
  hostClose?: Promise<GatewayStartupCloseV1>;
  closeTask?: Promise<void>;
  failedCleanup: boolean;
  refusal: "denied" | "unavailable" | "unknown";
  onRevoke: () => void;
};

const unavailable = () => new Error("Gateway startup unavailable");
const finished = (cleanup: GatewayStartupCloseV1["cleanup"]): GatewayStartupCloseV1 =>
  Object.freeze({ cleanup, termination: "unknown" });
function fence(work: () => undefined, pending: Set<Promise<unknown>>): void {
  const value: unknown = work();
  if (value !== undefined) {
    // Observe an invalid async fence without accepting it as authorization.
    const settled = Promise.resolve(value).catch(() => {});
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
    throw unavailable();
  }
}
function cleanupValue(value: unknown): GatewayStartupCloseV1["cleanup"] {
  return value === "finished" || value === "failed" || value === "unknown" ? value : "unknown";
}
function mergeCleanup(
  a: GatewayStartupCloseV1["cleanup"],
  b: GatewayStartupCloseV1["cleanup"],
): GatewayStartupCloseV1["cleanup"] {
  if (a === "unknown" || b === "unknown") return "unknown";
  return a === "failed" || b === "failed" ? "failed" : "finished";
}
function snapshot<T>(value: T): T {
  const active = new Set<object>();
  let count = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++count > 4096 || depth > 20) throw unavailable();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      if (item.length > 65536) throw unavailable();
      return item;
    }
    if (typeof item === "number" && Number.isSafeInteger(item)) return item;
    if (typeof item !== "object" || item === null || active.has(item)) throw unavailable();
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw unavailable();
    active.add(item);
    const out: unknown[] | Record<string, unknown> = Array.isArray(item) ? [] : {};
    if (
      Array.isArray(item) &&
      (Reflect.ownKeys(item).length !== item.length + 1 ||
        Array.from({ length: item.length }, (_, i) => !Object.hasOwn(item, i)).some(Boolean))
    )
      throw unavailable();
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== "string")) throw unavailable();
    for (const key of (keys as string[]).sort()) {
      if (Array.isArray(item) && key === "length") continue;
      if (typeof key !== "string" || key === "__proto__") throw unavailable();
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) throw unavailable();
      Object.defineProperty(out, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    active.delete(item);
    return Object.freeze(out);
  };
  return visit(value, 0) as T;
}
function compareConfiguration(
  binding: GatewayStartupBindingV2,
  material: GatewayStartupMaterialLeaseV1,
  pending: Set<Promise<unknown>>,
): void {
  const c = material.input.configuration;
  const pairs: readonly (readonly [unknown, unknown])[] = [
    [c.schemaVersion, 1],
    [c.installationRef, binding.startup.subject.installationId],
    [c.namespaceRef, binding.namespaceRef],
    [c.agentRef, binding.agentRef],
    [c.admittedRevisionRef, binding.admittedRevisionRef],
    [c.gatewayAssignmentRef, binding.gatewayAssignmentRef],
    [c.runtimeGeneration, binding.hostRuntimeGeneration],
    [c.nativeConfigRef, binding.nativeConfigRef],
    [c.configDigest, binding.configDigest],
    [c.stateSchemaVersion, binding.stateSchemaVersion],
    [c.agentSchemaVersion, binding.agentSchemaVersion],
    [c.protocolVersion, binding.protocolVersion],
    [c.startupDeadlineMs, binding.startupDeadlineMs],
    [c.shutdownDeadlineMs, binding.shutdownDeadlineMs],
  ];
  if (
    pairs.some(([a, b]) => a !== b) ||
    JSON.stringify(snapshot(c.modules)) !== JSON.stringify(binding.modules)
  )
    throw unavailable();
  // Actual state-path and native byte correspondence remains in the original material fence.
  fence(() => material.assertCurrent(), pending);
}

/**
 * Original Agent bootstrap membership and full binding remain local to this
 * owner. The fixed SDK host configuration is schemaVersion 1 independently of
 * the Agent startup protocol; comparing host fields does not project authority.
 */
export function createGatewayStartupLocalOwnerV2(
  source: GatewayStartupEnrollmentSourceV2,
  adapter: GatewayStartupFixedAdapterV1,
) {
  const enrollSource = source.enroll.bind(source);
  const prepare = adapter.prepare.bind(adapter);
  const recipients = new WeakMap<GatewayStartupRecipientV2, State>();
  const startups = new WeakMap<GatewayStartupHandleV2, State>();
  const active = new Set<State>();

  const assertParent = (s: State) => {
    if (s.revoked || s.controller.signal.aborted || s.sourceSignal.aborted) throw unavailable();
    fence(s.fence, s.pendingFences);
    if (s.revoked || s.controller.signal.aborted || s.sourceSignal.aborted) throw unavailable();
  };
  const assert = (s: State) => {
    assertParent(s);
    if (s.material) fence(() => s.material!.assertCurrent(), s.pendingFences);
    assertParent(s);
  };
  const recheck = async (s: State) => {
    assert(s);
    await s.recheck();
    assert(s);
  };
  const initiateHostClose = (s: State) => {
    if (s.host && !s.hostQuiesced) {
      // Fence the one quiesce attempt before calling the original host.
      s.hostQuiesced = true;
      try {
        s.host.quiesce();
      } catch {
        s.failedCleanup = true;
      }
    }
    if (!s.releasePrepared || s.preparedClose) return;
    // The original prepared owner closes both pre-start modules and a returned
    // host. Retain its result once; the material parent is a join, not a closer.
    s.preparedClose = Promise.resolve()
      .then(s.releasePrepared)
      .then(
        (value) => cleanupValue(value?.cleanup),
        () => "failed" as const,
      );
    if (s.host) s.hostClose = s.preparedClose.then(finished);
  };
  const joinConsumers = (s: State): Promise<void> => {
    if (s.consumerJoin) return s.consumerJoin;
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    // Publish before cancellation or original close callbacks can reenter.
    s.consumerJoin = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void s.consumerJoin.catch(() => {});
    s.revoked = true;
    if (!s.controller.signal.aborted) s.controller.abort();
    initiateHostClose(s);
    void (async () => {
      // Never join material binding/borrowing or whole initialization here. A
      // failed borrow itself calls this join before it can finish cleanup.
      await s.preparing?.catch(() => undefined);
      initiateHostClose(s);
      if (s.preparedClose && (await s.preparedClose) !== "finished") throw unavailable();
      // A rejecting adapter that returned no owner cannot establish settlement
      // of resources it might have created before transfer.
      if (s.preparationFailed || s.failedCleanup) throw unavailable();
    })().then(resolve, () => reject(unavailable()));
    void close(s);
    return s.consumerJoin;
  };
  const materialRuntime = (s: State): GatewayMaterialRuntimeOwnerV1 =>
    Object.freeze({
      signal: s.controller.signal,
      assertCurrent: () => {
        // Exclude material.assertCurrent: it calls this same original parent.
        assertParent(s);
        return undefined;
      },
      remainingStartupMs: () => {
        assertParent(s);
        const source: unknown = s.remainingSourceMs();
        if (typeof source !== "number" || !Number.isFinite(source) || source <= 0) {
          if (source && typeof source === "object" && "then" in source) {
            const task = Promise.resolve(source).catch(() => undefined);
            s.pendingFences.add(task);
            void task.then(() => s.pendingFences.delete(task));
          }
          throw unavailable();
        }
        const remaining = Math.min(
          source,
          s.binding.startupDeadlineMs - (performance.now() - s.startupStartedAt),
        );
        assertParent(s);
        if (!Number.isFinite(remaining) || remaining <= 0) throw unavailable();
        return remaining;
      },
      joinConsumers: () => joinConsumers(s),
    });
  const initiateOwnedClose = (s: State) => {
    void joinConsumers(s).catch(() => {});
    initiateHostClose(s);
    const safeClose = (work: () => Promise<GatewayStartupCloseV1["cleanup"]>) =>
      Promise.resolve()
        .then(work)
        .then(cleanupValue, () => "failed" as const);
    s.grantClose ??= safeClose(s.releaseGrant);
    if (s.material && !s.materialClose) s.materialClose = safeClose(() => s.material!.close());
  };
  const close = (s: State): Promise<GatewayStartupCloseV1> => {
    s.revoked = true;
    if (!s.controller.signal.aborted) s.controller.abort();
    initiateOwnedClose(s);
    if (!s.closeTask) {
      s.closeTask = (async () => {
        let cleanup: GatewayStartupCloseV1["cleanup"] = "finished";
        // Closing begins before this join, so pending startup can settle through its close path.
        await s.initializing?.catch(() => {});
        initiateOwnedClose(s);
        while (s.pendingFences.size) await Promise.allSettled([...s.pendingFences]);
        if (s.hostClose) cleanup = mergeCleanup(cleanup, (await s.hostClose).cleanup);
        if (s.preparedClose) cleanup = mergeCleanup(cleanup, await s.preparedClose);
        if (s.materialClose) cleanup = mergeCleanup(cleanup, await s.materialClose);
        if (s.grantClose) cleanup = mergeCleanup(cleanup, await s.grantClose);
        if (s.failedCleanup) cleanup = mergeCleanup(cleanup, "failed");
        if (s.preparationFailed) cleanup = mergeCleanup(cleanup, "unknown");
        s.sourceSignal.removeEventListener("abort", s.onRevoke);
        active.delete(s);
        s.resolveClosed(finished(cleanup));
      })();
      void s.closeTask.catch(() => {
        s.resolveClosed(finished("unknown"));
      });
    }
    return s.closed;
  };
  const lifetime = (s: State): GatewayStartupLifetimeV1 =>
    Object.freeze({
      signal: s.controller.signal,
      closed: s.closed,
      recheckCurrent: async () => {
        try {
          await recheck(s);
        } catch {
          void close(s);
          throw unavailable();
        }
      },
      assertCurrent: () => {
        try {
          assert(s);
        } catch {
          void close(s);
          throw unavailable();
        }
        return undefined;
      },
      close: () => close(s),
    });
  const initialize = async (s: State) => {
    await recheck(s);
    const claim = await s.readClaim();
    if (claim !== "current") {
      s.refusal = claim === "denied" ? "denied" : claim === "unknown" ? "unknown" : "unavailable";
      throw unavailable();
    }
    s.claimed = true;
    await recheck(s);
    // Save every late result before any post-await fence can throw.
    s.material = await s.borrow();
    await recheck(s);
    compareConfiguration(s.binding, s.material, s.pendingFences);
    assert(s);
    // Register the exact operation before invoking the adapter. If cancellation
    // wins first it cannot begin; any late returned disposer is retained before
    // the next authority fence or inspection of start().
    s.preparing = Promise.resolve().then(async () => {
      assert(s);
      try {
        const prepared = await prepare(s.material!.input);
        s.prepared = prepared;
        s.releasePrepared = prepared.close.bind(prepared);
        s.startPrepared = prepared.start.bind(prepared);
      } catch {
        s.preparationFailed = true;
        throw unavailable();
      }
    });
    await s.preparing;
    await recheck(s);
    assert(s);
    s.host = s.startPrepared!();
    if (s.revoked || s.sourceSignal.aborted) {
      initiateHostClose(s);
      throw unavailable();
    }
    const result = await s.host.startupSettled;
    await recheck(s);
    if (
      result.phase !== "ready" ||
      result.runtimeGeneration !== s.binding.hostRuntimeGeneration ||
      result.admittedRevisionRef !== s.binding.admittedRevisionRef
    )
      throw unavailable();
    s.started = true;
  };
  const usePort = Object.freeze({
    async start(
      recipient: GatewayStartupRecipientV2,
      startup: GatewayStartupHandleV2,
    ): Promise<GatewayStartupStartResultV2> {
      const s = recipients.get(recipient);
      if (!s || startups.get(startup) !== s || s.used || s.revoked)
        return Object.freeze({ kind: "denied" });
      s.used = true;
      s.initializing = Promise.resolve().then(() => initialize(s));
      void s.initializing.catch(() => {});
      try {
        await s.initializing;
        assert(s);
        return Object.freeze({ kind: "started", lifetime: lifetime(s) });
      } catch {
        await close(s);
        if (s.claimed || s.refusal === "unknown")
          return Object.freeze({ kind: "recovery-required", operation: s.binding.startup });
        return Object.freeze({ kind: s.refusal });
      }
    },
  });
  return Object.freeze({
    async enroll(bootstrap: object): Promise<GatewayStartupEnrollmentV2 | undefined> {
      const grant = await enrollSource(bootstrap);
      if (!grant) return undefined;
      let binding: GatewayStartupBindingV2;
      let releaseGrant: State["releaseGrant"] | undefined;
      let captured: Pick<
        State,
        | "sourceSignal"
        | "recheck"
        | "fence"
        | "readClaim"
        | "borrow"
        | "bindMaterial"
        | "remainingSourceMs"
        | "releaseGrant"
      >;
      try {
        // Capture the acquired cleanup before reading any other grant operand.
        const closeGrant = grant.close;
        if (typeof closeGrant !== "function") throw unavailable();
        releaseGrant = closeGrant.bind(grant);
        const sourceSignal = grant.signal;
        const recheckCurrent = grant.recheckCurrent;
        const assertCurrent = grant.assertCurrent;
        const readClaim = grant.readClaim;
        const borrowMaterial = grant.borrowMaterial;
        const bindMaterial = grant.bindMaterial;
        const remainingSourceMs = grant.remainingSourceMs;
        for (const method of [
          recheckCurrent,
          assertCurrent,
          readClaim,
          borrowMaterial,
          bindMaterial,
          remainingSourceMs,
        ])
          if (typeof method !== "function") throw unavailable();
        if (!(sourceSignal instanceof AbortSignal)) throw unavailable();
        captured = {
          sourceSignal,
          recheck: recheckCurrent.bind(grant),
          fence: assertCurrent.bind(grant),
          readClaim: readClaim.bind(grant),
          borrow: borrowMaterial.bind(grant),
          bindMaterial: bindMaterial.bind(grant),
          remainingSourceMs: remainingSourceMs.bind(grant),
          releaseGrant,
        };
        binding = parseGatewayStartupBindingV2(grant.binding);
      } catch {
        // The original owner still owns an acquired malformed grant.
        try {
          await releaseGrant?.();
        } catch {
          /* No authority or reusable handle is returned. */
        }
        return undefined;
      }
      let resolveClosed!: (value: GatewayStartupCloseV1) => void;
      const closed = new Promise<GatewayStartupCloseV1>((resolve) => {
        resolveClosed = resolve;
      });
      const s: State = {
        grant,
        ...captured,
        pendingFences: new Set(),
        binding,
        controller: new AbortController(),
        closed,
        resolveClosed,
        startupStartedAt: performance.now(),
        preparationFailed: false,
        hostQuiesced: false,
        used: false,
        revoked: false,
        started: false,
        claimed: false,
        failedCleanup: false,
        refusal: "unavailable",
        onRevoke: () => {},
      };
      s.onRevoke = () => {
        void close(s);
      };
      active.add(s);
      s.sourceSignal.addEventListener("abort", s.onRevoke, { once: true });
      try {
        assert(s);
        await s.bindMaterial(materialRuntime(s));
        await recheck(s);
      } catch {
        await close(s);
        return undefined;
      }
      const recipient = Object.freeze({}) as GatewayStartupRecipientV2;
      const startup = Object.freeze({}) as GatewayStartupHandleV2;
      recipients.set(recipient, s);
      startups.set(startup, s);
      return Object.freeze({ usePort, recipient, startup });
    },
  });
}
