import type { GatewayHostV1 } from "openclaw/plugin-sdk/gateway-host";
import type {
  GatewayStartupBindingV1,
  GatewayStartupCloseV1,
  GatewayStartupEnrollmentV1,
  GatewayStartupHandleV1,
  GatewayStartupLifetimeV1,
  GatewayStartupOperationLocatorV1,
  GatewayStartupRecipientV1,
  GatewayStartupStartResultV1,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";
import type { GatewayCompositionInput } from "./composition.ts";

export interface GatewayStartupMaterialLeaseV1 {
  readonly input: GatewayCompositionInput;
  /** Actual original material/configuration-byte correspondence, not only a digest comparison. */
  assertCurrent(): undefined;
  close(): Promise<GatewayStartupCloseV1["cleanup"]>;
}
export interface GatewayStartupLocalGrantV1 {
  readonly binding: GatewayStartupBindingV1;
  readonly signal: AbortSignal;
  recheckCurrent(): Promise<void>;
  assertCurrent(): undefined;
  /** Fresh exact read of the original confirmed consume; never performs a second CAS. */
  readClaim(): Promise<"current" | "denied" | "unavailable" | "unknown">;
  borrowMaterial(): Promise<GatewayStartupMaterialLeaseV1>;
  close(): Promise<GatewayStartupCloseV1["cleanup"]>;
}
export interface GatewayStartupEnrollmentSourceV1 {
  /** The original bootstrap verifies actual context and confirmed durable consume before enrollment. */
  enroll(bootstrap: object): Promise<GatewayStartupLocalGrantV1 | undefined>;
}
export interface GatewayStartupPreparedCompositionV1 {
  start(): GatewayHostV1;
  /** Own all prepared resources even if startup is refused before a host is returned. */
  close(): Promise<Readonly<{ cleanup: GatewayStartupCloseV1["cleanup"] }>>;
}
export interface GatewayStartupFixedAdapterV1 {
  /** Return a synchronous start handoff; never hide the host behind a readiness await. */
  prepare(input: GatewayCompositionInput): Promise<GatewayStartupPreparedCompositionV1>;
}

type State = {
  readonly grant: GatewayStartupLocalGrantV1;
  readonly sourceSignal: AbortSignal;
  readonly pendingFences: Set<Promise<unknown>>;
  readonly binding: GatewayStartupBindingV1;
  readonly controller: AbortController;
  readonly closed: Promise<GatewayStartupCloseV1>;
  readonly resolveClosed: (value: GatewayStartupCloseV1) => void;
  readonly recheck: () => Promise<void>;
  readonly fence: () => undefined;
  readonly readClaim: () => Promise<"current" | "denied" | "unavailable" | "unknown">;
  readonly borrow: () => Promise<GatewayStartupMaterialLeaseV1>;
  readonly releaseGrant: () => Promise<GatewayStartupCloseV1["cleanup"]>;
  used: boolean;
  revoked: boolean;
  started: boolean;
  claimed: boolean;
  initializing?: Promise<void>;
  material?: GatewayStartupMaterialLeaseV1;
  prepared?: GatewayStartupPreparedCompositionV1;
  preparedClose?: Promise<GatewayStartupCloseV1["cleanup"]>;
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
  binding: GatewayStartupBindingV1,
  material: GatewayStartupMaterialLeaseV1,
  pending: Set<Promise<unknown>>,
): void {
  const c = material.input.configuration;
  const pairs: readonly (readonly [unknown, unknown])[] = [
    [c.schemaVersion, 1],
    [c.installationRef, binding.startup.installationId],
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
 * Internal trusted composition only. No production bootstrap is supplied here.
 * TODO(Installation startup): wire the genuine authenticated bootstrap/material source;
 * the zero-argument production reader remains unavailable until that owner exists.
 */
export function createGatewayStartupLocalOwnerV1(
  source: GatewayStartupEnrollmentSourceV1,
  adapter: GatewayStartupFixedAdapterV1,
) {
  const enrollSource = source.enroll.bind(source);
  const prepare = adapter.prepare.bind(adapter);
  const recipients = new WeakMap<GatewayStartupRecipientV1, State>();
  const startups = new WeakMap<GatewayStartupHandleV1, State>();
  const active = new Set<State>();

  const assert = (s: State) => {
    if (s.revoked || s.controller.signal.aborted || s.sourceSignal.aborted) throw unavailable();
    fence(s.fence, s.pendingFences);
    if (s.material) fence(() => s.material!.assertCurrent(), s.pendingFences);
    if (s.revoked || s.controller.signal.aborted || s.sourceSignal.aborted) throw unavailable();
  };
  const recheck = async (s: State) => {
    assert(s);
    await s.recheck();
    assert(s);
  };
  const initiateHostClose = (s: State) => {
    if (!s.host || s.hostClose) return;
    try {
      s.host.quiesce();
    } catch {
      s.failedCleanup = true;
    }
    // The prepared adapter owns host/module cleanup; do not invoke module cleanup twice.
    s.preparedClose ??= Promise.resolve()
      .then(() => s.prepared!.close())
      .then(
        (value) => cleanupValue(value?.cleanup),
        () => "failed" as const,
      );
    s.hostClose = s.preparedClose.then(finished);
  };
  const initiateOwnedClose = (s: State) => {
    initiateHostClose(s);
    const safeClose = (work: () => Promise<GatewayStartupCloseV1["cleanup"]>) =>
      Promise.resolve()
        .then(work)
        .then(cleanupValue, () => "failed" as const);
    s.grantClose ??= safeClose(s.releaseGrant);
    if (s.material && !s.materialClose) s.materialClose = safeClose(() => s.material!.close());
    if (s.prepared && !s.preparedClose)
      s.preparedClose = safeClose(async () => cleanupValue((await s.prepared!.close())?.cleanup));
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
    s.prepared = await prepare(s.material.input);
    await recheck(s);
    assert(s);
    s.host = s.prepared.start();
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
      recipient: GatewayStartupRecipientV1,
      startup: GatewayStartupHandleV1,
    ): Promise<GatewayStartupStartResultV1> {
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
    async enroll(bootstrap: object): Promise<GatewayStartupEnrollmentV1 | undefined> {
      const grant = await enrollSource(bootstrap);
      if (!grant) return undefined;
      let binding: GatewayStartupBindingV1;
      let releaseGrant: State["releaseGrant"] | undefined;
      let captured: Pick<
        State,
        "sourceSignal" | "recheck" | "fence" | "readClaim" | "borrow" | "releaseGrant"
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
        for (const method of [recheckCurrent, assertCurrent, readClaim, borrowMaterial])
          if (typeof method !== "function") throw unavailable();
        if (!(sourceSignal instanceof AbortSignal)) throw unavailable();
        captured = {
          sourceSignal,
          recheck: recheckCurrent.bind(grant),
          fence: assertCurrent.bind(grant),
          readClaim: readClaim.bind(grant),
          borrow: borrowMaterial.bind(grant),
          releaseGrant,
        };
        binding = snapshot(grant.binding);
        for (const value of [
          binding.startup.installationId,
          binding.startup.processRef,
          binding.startup.operationRef,
          binding.startup.operationDigest,
          binding.createEffectRef,
          binding.configurationRef,
          binding.profileRef,
          binding.namespaceRef,
          binding.agentRef,
          binding.admittedRevisionRef,
          binding.gatewayAssignmentRef,
          binding.nativeConfigRef,
          binding.configDigest,
          binding.selection.recordRef,
          binding.stateOwnership.recordRef,
        ]) {
          if (typeof value !== "string" || !value.length) throw unavailable();
        }
        for (const value of [
          binding.startup.processGeneration,
          binding.hostRuntimeGeneration,
          binding.configurationVersion,
          binding.profileVersion,
          binding.selection.recordVersion,
          binding.stateOwnership.recordVersion,
          binding.stateSchemaVersion,
          binding.agentSchemaVersion,
          binding.protocolVersion,
          binding.startupDeadlineMs,
          binding.shutdownDeadlineMs,
        ]) {
          if (!Number.isSafeInteger(value) || value < 1) throw unavailable();
        }
        if (
          !Array.isArray(binding.modules) ||
          !binding.modules.length ||
          binding.modules.length > 32
        )
          throw unavailable();
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
        await recheck(s);
      } catch {
        await close(s);
        return undefined;
      }
      const recipient = Object.freeze({}) as GatewayStartupRecipientV1;
      const startup = Object.freeze({}) as GatewayStartupHandleV1;
      recipients.set(recipient, s);
      startups.set(startup, s);
      return Object.freeze({ usePort, recipient, startup });
    },
  });
}
