import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  canonicalGatewayStartupValueV1,
  gatewayStartupCommandDigestV1,
  parseGatewayStartupBindingV1,
  parseGatewayStartupCommandV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import type { GatewayMaterialDeliveryRequestV1 } from "@openclaw-enterprise/contracts/gateway-material-delivery-v1";
import type {
  GatewayStartupBindingV1,
  GatewayStartupCloseV1,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";
import type {
  GatewayStartupCommandBoundsV1,
  GatewayStartupCommandV1,
  GatewayStartupCurrentV1,
  GatewayStartupRecipientBindingV1,
  GatewayStartupOwnerSuccessV1,
  GatewayStartupOwnerFailureV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";

export const gatewayStartupOperationProfile = "installation-gateway-startup-v1";
export const gatewayStartupTransportProfile = "owned-child-stdio-installation-gateway-startup-v1";

type Consume = Extract<GatewayStartupCommandV1, { kind: "consume-startup" }>;
type ReadCurrent = Extract<GatewayStartupCommandV1, { kind: "read-current" }>;
type ReadOperation = Extract<GatewayStartupCommandV1, { kind: "read-operation" }>;
export type GatewayStartupServiceCommandV1 = Consume | ReadCurrent | ReadOperation;
type Cleanup = GatewayStartupCloseV1["cleanup"];

/**
 * Consumer requirements for the original native producer. Only trusted composition
 * installs that producer. Implementing this interface with a callback does not
 * authenticate a process, create a service invocation, or implement a native bridge.
 */
export interface GatewayStartupNativeConnectionV1 {
  readonly binding: GatewayStartupBindingV1;
  readonly consumeCommand: Consume;
  readonly signal: AbortSignal;
  readonly expiresAtMs: number;
  assertCurrent(): undefined;
  recheckCurrent(): Promise<void>;
  execute(
    command: GatewayStartupServiceCommandV1,
    bounds: GatewayStartupCommandBoundsV1,
  ): Promise<GatewayStartupOwnerSuccessV1 | GatewayStartupOwnerFailureV1>;
  close(): Promise<Cleanup>;
}
export interface GatewayStartupNativeProducerV1 {
  /** Must verify original private native child/connection ownership on every call. */
  assertOriginal(connection: GatewayStartupNativeConnectionV1): undefined;
  /** Fixed identity, endpoint and profile; no caller-selected native configuration. */
  open(signal: AbortSignal): Promise<GatewayStartupNativeConnectionV1>;
}

declare const sourceBrand: unique symbol;
export interface GatewayStartupServiceHandleV1 {
  readonly [sourceBrand]: true;
}
export type GatewayStartupServiceConsumeV1 =
  | Readonly<{ kind: "confirmed"; binding: GatewayStartupBindingV1 }>
  | Readonly<{ kind: "denied" | "unavailable" | "unknown" }>;

const unavailable = () => new Error("Gateway startup service unavailable");
function fence(work: () => undefined, pending: Set<Promise<unknown>>): void {
  const value: unknown = work();
  if (value !== undefined) {
    const settled = Promise.resolve(value).catch(() => undefined);
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
    throw unavailable();
  }
}
/** Bounded data copy only. This function never verifies authority or a peer. */
function copy<T>(value: T): T {
  let count = 0;
  const ancestors = new Set<object>();
  const walk = (item: unknown, depth: number): unknown => {
    if (++count > 4096 || depth > 20) throw unavailable();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string" && item.length <= 65536) return item;
    if (typeof item === "number" && Number.isSafeInteger(item)) return item;
    if (typeof item !== "object" || item === null || ancestors.has(item)) throw unavailable();
    const array = Array.isArray(item);
    if (
      !array &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw unavailable();
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== "string")) throw unavailable();
    if (array && (item.length > 4096 || keys.length !== item.length + 1)) throw unavailable();
    ancestors.add(item);
    const result: unknown[] | Record<string, unknown> = array ? [] : {};
    for (const key of keys) {
      if (array && key === "length") continue;
      if (key === "__proto__") throw unavailable();
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) throw unavailable();
      Object.defineProperty(result, key, {
        value: walk(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    if (
      array &&
      Array.from({ length: item.length }, (_, i) => !Object.hasOwn(result, i)).some(Boolean)
    )
      throw unavailable();
    ancestors.delete(item);
    return Object.freeze(result);
  };
  return walk(value, 0) as T;
}

type State = {
  readonly connection: GatewayStartupNativeConnectionV1;
  readonly binding: GatewayStartupBindingV1;
  readonly command: Consume;
  readonly abort: AbortController;
  readonly pending: Set<Promise<unknown>>;
  readonly expiresAtMs: number;
  readonly assertNative: () => undefined;
  readonly recheckNative: () => Promise<void>;
  readonly executeNative: GatewayStartupNativeConnectionV1["execute"];
  readonly releaseNative: () => Promise<Cleanup>;
  readonly onAbort: () => void;
  timer: ReturnType<typeof setTimeout>;
  used: boolean;
  busy: boolean;
  materialBusy: boolean;
  startupMaterialAttempted: boolean;
  current?: GatewayStartupCurrentV1;
  closeTask?: Promise<Cleanup>;
};

/**
 * One fixed native Source acquisition and one claim per constructed source.
 * No production native producer is installed by this module.
 */
export function createGatewayStartupServiceSourceV1(
  producer: GatewayStartupNativeProducerV1 | undefined,
) {
  const assertOriginal = producer?.assertOriginal.bind(producer);
  const openOriginal = producer?.open.bind(producer);
  const handles = new WeakMap<GatewayStartupServiceHandleV1, State>();
  const active = new Set<State>();
  const acquisitionAbort = new AbortController();
  let opened = false;
  let acquisition: Promise<GatewayStartupServiceHandleV1 | undefined> | undefined;
  let closing: Promise<Cleanup> | undefined;
  let acquisitionFailure: Cleanup = "finished";

  const closeState = (s: State): Promise<Cleanup> => {
    s.abort.abort();
    clearTimeout(s.timer);
    if (!s.closeTask) {
      // Request native close before joining a pending exchange, so close can unblock it.
      const released = Promise.resolve()
        .then(s.releaseNative)
        .then(
          (value): Cleanup => (value === "finished" || value === "failed" ? value : "unknown"),
          (): Cleanup => "failed",
        );
      s.closeTask = (async () => {
        while (s.pending.size) await Promise.allSettled([...s.pending]);
        const result = await released;
        s.connection.signal.removeEventListener("abort", s.onAbort);
        return result;
      })();
    }
    return s.closeTask;
  };
  const assert = (s: State): undefined => {
    try {
      if (
        acquisitionAbort.signal.aborted ||
        s.abort.signal.aborted ||
        s.connection.signal.aborted ||
        Date.now() >= s.expiresAtMs
      )
        throw unavailable();
      fence(() => assertOriginal!(s.connection), s.pending);
      fence(s.assertNative, s.pending);
      if (s.abort.signal.aborted || s.connection.signal.aborted || Date.now() >= s.expiresAtMs)
        throw unavailable();
      return undefined;
    } catch {
      void closeState(s);
      throw unavailable();
    }
  };
  const get = (handle: GatewayStartupServiceHandleV1): State => {
    const s = handles.get(handle);
    if (!s) throw unavailable();
    assert(s);
    return s;
  };
  const track = <T>(s: State, work: () => Promise<T>): Promise<T> => {
    const task = Promise.resolve().then(work);
    s.pending.add(task);
    void task.then(
      () => s.pending.delete(task),
      () => s.pending.delete(task),
    );
    return task;
  };
  const exchange = async (s: State, command: GatewayStartupServiceCommandV1) => {
    assert(s);
    if (s.busy) throw unavailable();
    s.busy = true;
    const callAbort = new AbortController();
    const deadlineMs = Math.min(Date.now() + 3000, s.expiresAtMs);
    const signal = AbortSignal.any([s.abort.signal, callAbort.signal]);
    const timer = setTimeout(
      () => {
        callAbort.abort();
        void closeState(s);
      },
      Math.max(0, deadlineMs - Date.now()),
    );
    try {
      const bounds = Object.freeze({
        requestRef: randomUUID(),
        deadline: new Date(deadlineMs).toISOString(),
        signal,
      });
      const response = await track(s, () => s.executeNative(command, bounds));
      assert(s);
      if (signal.aborted || Date.now() >= deadlineMs) throw unavailable();
      return copy(response);
    } finally {
      clearTimeout(timer);
      s.busy = false;
    }
  };
  const recordMatches = (s: State, record: GatewayStartupCurrentV1): boolean =>
    isDeepStrictEqual(record.acceptance.binding, s.binding) &&
    record.head.state === "consumed" &&
    isDeepStrictEqual(record.head.startup, s.binding.startup) &&
    record.head.processGeneration === s.binding.startup.processGeneration &&
    record.claim?.kind === "consume-startup" &&
    isDeepStrictEqual(record.claim.startup, s.binding.startup) &&
    record.claim.createEffectRef === s.binding.createEffectRef &&
    isDeepStrictEqual(record.claim.recipient, s.command.recipient) &&
    record.claim.canonicalCommand === canonicalGatewayStartupValueV1(s.command) &&
    record.claim.command.operationDigest === gatewayStartupCommandDigestV1(s.command) &&
    record.claim.command.operationRef === s.command.operationRef &&
    record.claim.command.installationId === s.binding.startup.installationId &&
    isDeepStrictEqual(record.claim.command.startup, s.binding.startup) &&
    record.claim.beforeHeadVersion === s.command.expectedHead.version &&
    record.claim.beforeRecordVersion === s.command.expectedHead.recordVersion &&
    record.claim.afterHeadVersion === s.command.expectedHead.version + 1 &&
    record.claim.afterRecordVersion === s.command.expectedHead.recordVersion + 1 &&
    record.head.version === record.claim.afterHeadVersion &&
    record.head.recordVersion === record.claim.afterRecordVersion;

  const api = {
    open(): Promise<GatewayStartupServiceHandleV1 | undefined> {
      if (opened || acquisitionAbort.signal.aborted || !openOriginal || !assertOriginal) {
        return Promise.resolve(undefined);
      }
      opened = true;
      // Keep the original acquisition even if a caller drops its returned promise.
      acquisition = Promise.resolve().then(async () => {
        let connection: GatewayStartupNativeConnectionV1 | undefined;
        let state: State | undefined;
        let owned = false;
        const pending = new Set<Promise<unknown>>();
        const acquisitionTimer = setTimeout(() => acquisitionAbort.abort(), 30000);
        try {
          if (acquisitionAbort.signal.aborted) throw unavailable();
          connection = await openOriginal(acquisitionAbort.signal);
          fence(() => assertOriginal(connection!), pending);
          owned = true;
          const binding = parseGatewayStartupBindingV1(connection.binding);
          const command = parseGatewayStartupCommandV1(connection.consumeCommand);
          if (command.kind !== "consume-startup") throw unavailable();
          if (
            !(connection.signal instanceof AbortSignal) ||
            !Number.isSafeInteger(connection.expiresAtMs) ||
            connection.expiresAtMs <= Date.now() ||
            connection.expiresAtMs > Date.now() + 30000 ||
            command.schemaVersion !== 1 ||
            command.kind !== "consume-startup" ||
            !isDeepStrictEqual(command.startup, binding.startup) ||
            !isDeepStrictEqual(command.expectedHead.startup, binding.startup)
          )
            throw unavailable();
          for (const method of [
            connection.assertCurrent,
            connection.recheckCurrent,
            connection.execute,
            connection.close,
          ])
            if (typeof method !== "function") throw unavailable();
          const abort = new AbortController();
          const s: State = {
            connection,
            binding,
            command,
            abort,
            pending,
            expiresAtMs: connection.expiresAtMs,
            assertNative: connection.assertCurrent.bind(connection),
            recheckNative: connection.recheckCurrent.bind(connection),
            executeNative: connection.execute.bind(connection),
            releaseNative: connection.close.bind(connection),
            onAbort: () => {
              void closeState(s);
            },
            timer: setTimeout(
              () => {
                void closeState(s);
              },
              Math.max(0, connection.expiresAtMs - Date.now()),
            ),
            used: false,
            busy: false,
            materialBusy: false,
            startupMaterialAttempted: false,
          };
          state = s;
          active.add(s);
          connection.signal.addEventListener("abort", s.onAbort, { once: true });
          assert(s);
          await track(s, s.recheckNative);
          assert(s);
          const handle = Object.freeze({}) as GatewayStartupServiceHandleV1;
          handles.set(handle, s);
          return handle;
        } catch {
          if (state) acquisitionFailure = await closeState(state);
          else if (connection && owned) {
            try {
              const result = await connection.close();
              acquisitionFailure =
                result === "finished" || result === "failed" ? result : "unknown";
            } catch {
              acquisitionFailure = "failed";
            }
          }
          acquisitionAbort.abort();
          while (pending.size) await Promise.allSettled([...pending]);
          return undefined;
        } finally {
          clearTimeout(acquisitionTimer);
        }
      });
      return acquisition;
    },
    binding(handle: GatewayStartupServiceHandleV1): GatewayStartupBindingV1 {
      return get(handle).binding;
    },
    recipient(handle: GatewayStartupServiceHandleV1): GatewayStartupRecipientBindingV1 {
      return get(handle).command.recipient;
    },
    signal(handle: GatewayStartupServiceHandleV1): AbortSignal {
      return get(handle).abort.signal;
    },
    assertCurrent(handle: GatewayStartupServiceHandleV1): undefined {
      return assert(get(handle));
    },
    /** Original absolute Source remainder. Reading it never renews the connection. */
    remainingSourceMs(handle: GatewayStartupServiceHandleV1): number {
      const s = get(handle);
      return Math.max(0, s.expiresAtMs - Date.now());
    },
    /**
     * Nonsecret operands from this receiver's confirmed consume only. This is data,
     * not a disclosure permit or proof of current Controller-side registration.
     * Material calls use their separate authenticated connection and purpose.
     */
    materialRequest(
      handle: GatewayStartupServiceHandleV1,
      use: GatewayMaterialDeliveryRequestV1["use"],
    ): GatewayMaterialDeliveryRequestV1 {
      const s = get(handle);
      if (
        !s.used ||
        !s.current ||
        !recordMatches(s, s.current) ||
        !s.current.claim ||
        (use !== "startup-slack-pair" && use !== "teams-invocation-token")
      )
        throw unavailable();
      const request: GatewayMaterialDeliveryRequestV1 = {
        schemaVersion: 1,
        purpose: "read-selected-channel-material",
        use,
        startup: s.binding.startup,
        selection: s.binding.selection,
        consumedClaim: {
          operationRef: s.current.claim.command.operationRef,
          operationDigest: s.current.claim.command.operationDigest,
          afterRecordVersion: s.current.claim.afterRecordVersion,
        },
        recipient: s.command.recipient.recipient,
      };
      assert(s);
      return copy(request);
    },
    /**
     * Reserve before yielding and join original material work in Source shutdown.
     * This is local custody only: the Controller still verifies the consumed claim,
     * current process and selected use. It is not a durable cross-process replay store.
     */
    withMaterialCall<T>(
      handle: GatewayStartupServiceHandleV1,
      use: GatewayMaterialDeliveryRequestV1["use"],
      work: (request: GatewayMaterialDeliveryRequestV1, signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      const s = get(handle);
      const request = api.materialRequest(handle, use);
      if (s.materialBusy || (use === "startup-slack-pair" && s.startupMaterialAttempted))
        return Promise.reject(unavailable());
      s.materialBusy = true;
      if (use === "startup-slack-pair") s.startupMaterialAttempted = true;
      return track(s, async () => {
        try {
          assert(s);
          return await work(request, s.abort.signal);
        } finally {
          s.materialBusy = false;
        }
      });
    },
    async recheckCurrent(handle: GatewayStartupServiceHandleV1): Promise<void> {
      const s = get(handle);
      try {
        await track(s, s.recheckNative);
        assert(s);
      } catch {
        void closeState(s);
        throw unavailable();
      }
    },
    async consume(handle: GatewayStartupServiceHandleV1): Promise<GatewayStartupServiceConsumeV1> {
      let s: State;
      try {
        s = get(handle);
      } catch {
        return Object.freeze({ kind: "denied" });
      }
      if (s.used) return Object.freeze({ kind: "denied" });
      s.used = true;
      try {
        const result = await exchange(s, s.command);
        // The actual native bridge returns the Runtime owner's public result.
        // Recovery or transport uncertainty cannot enroll or repeat consume.
        if (result.kind === "recovery-required") {
          await closeState(s);
          return Object.freeze({ kind: "unknown" });
        }
        if (result.kind === "denied" || result.kind === "unavailable") {
          await closeState(s);
          return Object.freeze({ kind: result.kind });
        }
        if (result.kind !== "consumed" || !recordMatches(s, result.record)) throw unavailable();
        s.current = result.record;
        assert(s);
        return Object.freeze({ kind: "confirmed", binding: s.binding });
      } catch {
        await closeState(s);
        // A call that may have reached consume cannot be retried after losing its result.
        return Object.freeze({ kind: "unknown" });
      }
    },
    async readClaim(
      handle: GatewayStartupServiceHandleV1,
    ): Promise<"current" | "denied" | "unavailable" | "unknown"> {
      let s: State;
      try {
        s = get(handle);
      } catch {
        return "unavailable";
      }
      if (!s.used || !s.current) return "denied";
      try {
        const command: ReadCurrent = Object.freeze({
          schemaVersion: 1,
          kind: "read-current",
          startup: s.binding.startup,
          expectedRecordVersion: s.current.head.recordVersion,
          recipient: s.command.recipient,
        });
        const result = await exchange(s, command);
        if (result.kind === "recovery-required") {
          void closeState(s);
          return "unknown";
        }
        if (result.kind === "denied" || result.kind === "unavailable") {
          void closeState(s);
          return result.kind;
        }
        if (result.kind !== "current" || !recordMatches(s, result.record)) {
          void closeState(s);
          return "denied";
        }
        return "current";
      } catch {
        void closeState(s);
        return "unavailable";
      }
    },
    close(): Promise<Cleanup> {
      if (closing) return closing;
      acquisitionAbort.abort();
      const current = [...active].map(closeState);
      closing = (async () => {
        await acquisition;
        const results = [
          acquisitionFailure,
          ...(await Promise.all(current)),
          ...(await Promise.all([...active].map(closeState))),
        ];
        if (results.includes("unknown")) return "unknown";
        if (results.includes("failed")) return "failed";
        return "finished";
      })();
      void closing.catch(() => undefined);
      return closing;
    },
  };
  return Object.freeze(api);
}

export type GatewayStartupServiceSourceV1 = ReturnType<typeof createGatewayStartupServiceSourceV1>;
