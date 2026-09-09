import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  canonicalGatewayStartupValueV1,
  gatewayStartupCommandDigestV2,
  parseGatewayStartupBindingV2,
  parseGatewayStartupCommandV2,
  parseGatewayStartupEventV2,
  type GatewayStartupCommandV2,
  type GatewayStartupCurrentV2,
  type GatewayStartupRecipientBindingV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import type { GatewayMaterialDeliveryRequestV2 } from "@openclaw-enterprise/contracts/gateway-material-delivery-v2";
import type {
  GatewayStartupBindingV2,
  GatewayStartupCloseV1,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";
import type {
  GatewayStartupNativeConnectionV2,
  GatewayStartupNativeProducerV2,
  GatewayStartupServiceCommandV2,
} from "./startup-service-source.ts";

type Consume = Extract<GatewayStartupCommandV2, { kind: "consume-startup" }>;
type ReadCurrent = Extract<GatewayStartupCommandV2, { kind: "read-current" }>;
type Cleanup = GatewayStartupCloseV1["cleanup"];

declare const sourceBrand: unique symbol;
export interface GatewayStartupServiceHandleV2 {
  readonly [sourceBrand]: true;
}
export type GatewayStartupServiceConsumeV2 =
  | Readonly<{ kind: "confirmed"; binding: GatewayStartupBindingV2 }>
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
  readonly connection: GatewayStartupNativeConnectionV2;
  readonly binding: GatewayStartupBindingV2;
  readonly command: Consume;
  readonly abort: AbortController;
  readonly pending: Set<Promise<unknown>>;
  readonly expiresAtMs: number;
  readonly assertNative: () => undefined;
  readonly recheckNative: () => Promise<void>;
  readonly executeNative: GatewayStartupNativeConnectionV2["execute"];
  readonly releaseNative: () => Promise<Cleanup>;
  readonly onAbort: () => void;
  timer: ReturnType<typeof setTimeout>;
  used: boolean;
  busy: boolean;
  materialBusy: boolean;
  startupMaterialAttempted: boolean;
  current?: GatewayStartupCurrentV2;
  closeTask?: Promise<Cleanup>;
};

/**
 * One fixed native Source acquisition and one claim per constructed source.
 * No production native producer is installed by this module.
 */
export function createGatewayStartupServiceSourceV2(
  producer: GatewayStartupNativeProducerV2 | undefined,
) {
  const assertOriginal = producer?.assertOriginal.bind(producer);
  const openOriginal = producer?.open.bind(producer);
  const handles = new WeakMap<GatewayStartupServiceHandleV2, State>();
  const active = new Set<State>();
  const acquisitionAbort = new AbortController();
  let opened = false;
  let acquisition: Promise<GatewayStartupServiceHandleV2 | undefined> | undefined;
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
  const get = (handle: GatewayStartupServiceHandleV2): State => {
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
  const exchange = async (s: State, command: GatewayStartupServiceCommandV2) => {
    assert(s);
    if (s.busy) throw unavailable();
    s.busy = true;
    const callAbort = new AbortController();
    const deadlineMs = Math.min(Date.now() + 3000, s.expiresAtMs);
    const monotonicDeadline = performance.now() + deadlineMs - Date.now();
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
      const result = copy(response);
      assert(s);
      if (signal.aborted || Date.now() >= deadlineMs || performance.now() >= monotonicDeadline)
        throw unavailable();
      return result;
    } finally {
      clearTimeout(timer);
      s.busy = false;
    }
  };
  const recordMatches = (s: State, record: GatewayStartupCurrentV2): boolean => {
    if (record.claim === null || record.submission === null) return false;
    // The original owner requires a retained submit before consume. Validate
    // both exact events; a matching digest alone cannot replace their chain.
    const claim = parseGatewayStartupEventV2(record.claim);
    const submission = parseGatewayStartupEventV2(record.submission);
    return (
      isDeepStrictEqual(record.acceptance.binding, s.binding) &&
      record.head.state === "consumed" &&
      isDeepStrictEqual(record.head.subject, s.binding.startup.subject) &&
      isDeepStrictEqual(record.head.startup, s.binding.startup) &&
      record.head.processGeneration === s.binding.startup.processGeneration &&
      record.head.latestOperationRef === claim.command.operationRef &&
      claim.kind === "consume-startup" &&
      isDeepStrictEqual(claim.startup, s.binding.startup) &&
      claim.createEffectRef === s.binding.createEffectRef &&
      isDeepStrictEqual(claim.recipient, s.command.recipient) &&
      claim.canonicalCommand === canonicalGatewayStartupValueV1(s.command) &&
      claim.command.operationDigest === gatewayStartupCommandDigestV2(s.command) &&
      claim.command.operationRef === s.command.operationRef &&
      isDeepStrictEqual(claim.command.subject, s.binding.startup.subject) &&
      isDeepStrictEqual(claim.command.startup, s.binding.startup) &&
      claim.beforeHeadVersion === s.command.expectedHead.version &&
      claim.beforeRecordVersion === s.command.expectedHead.recordVersion &&
      claim.afterHeadVersion === s.command.expectedHead.version + 1 &&
      claim.afterRecordVersion === s.command.expectedHead.recordVersion + 1 &&
      record.head.version === claim.afterHeadVersion &&
      record.head.recordVersion === claim.afterRecordVersion &&
      submission.kind === "submit-create" &&
      isDeepStrictEqual(submission.submissionInput?.binding, s.binding) &&
      isDeepStrictEqual(submission.startup, s.binding.startup) &&
      submission.createEffectRef === s.binding.createEffectRef &&
      claim.previousOperationRef === submission.command.operationRef &&
      claim.beforeHeadVersion === submission.afterHeadVersion &&
      claim.beforeRecordVersion === submission.afterRecordVersion
    );
  };

  const api = {
    open(): Promise<GatewayStartupServiceHandleV2 | undefined> {
      if (opened || acquisitionAbort.signal.aborted || !openOriginal || !assertOriginal) {
        return Promise.resolve(undefined);
      }
      opened = true;
      // Keep the original acquisition even if a caller drops its returned promise.
      acquisition = Promise.resolve().then(async () => {
        let connection: GatewayStartupNativeConnectionV2 | undefined;
        let state: State | undefined;
        let owned = false;
        const pending = new Set<Promise<unknown>>();
        const acquisitionTimer = setTimeout(() => acquisitionAbort.abort(), 30000);
        try {
          if (acquisitionAbort.signal.aborted) throw unavailable();
          connection = await openOriginal(acquisitionAbort.signal);
          fence(() => assertOriginal(connection!), pending);
          owned = true;
          const binding = parseGatewayStartupBindingV2(connection.binding);
          const command = parseGatewayStartupCommandV2(connection.consumeCommand);
          if (command.kind !== "consume-startup") throw unavailable();
          if (
            !(connection.signal instanceof AbortSignal) ||
            !Number.isSafeInteger(connection.expiresAtMs) ||
            connection.expiresAtMs <= Date.now() ||
            connection.expiresAtMs > Date.now() + 30000 ||
            command.schemaVersion !== 2 ||
            command.kind !== "consume-startup" ||
            !isDeepStrictEqual(command.subject, binding.startup.subject) ||
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
          const handle = Object.freeze({}) as GatewayStartupServiceHandleV2;
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
    binding(handle: GatewayStartupServiceHandleV2): GatewayStartupBindingV2 {
      return get(handle).binding;
    },
    recipient(handle: GatewayStartupServiceHandleV2): GatewayStartupRecipientBindingV1 {
      return get(handle).command.recipient;
    },
    signal(handle: GatewayStartupServiceHandleV2): AbortSignal {
      return get(handle).abort.signal;
    },
    assertCurrent(handle: GatewayStartupServiceHandleV2): undefined {
      return assert(get(handle));
    },
    /** Original absolute Source remainder. Reading it never renews the connection. */
    remainingSourceMs(handle: GatewayStartupServiceHandleV2): number {
      const s = get(handle);
      return Math.max(0, s.expiresAtMs - Date.now());
    },
    /**
     * Nonsecret operands from this receiver's confirmed consume only. This is data,
     * not a disclosure permit or proof of current Controller-side registration.
     * Material calls use their separate authenticated connection and purpose.
     */
    materialRequest(
      handle: GatewayStartupServiceHandleV2,
      use: GatewayMaterialDeliveryRequestV2["use"],
    ): GatewayMaterialDeliveryRequestV2 {
      const s = get(handle);
      if (
        !s.used ||
        !s.current ||
        !recordMatches(s, s.current) ||
        !s.current.claim ||
        (use !== "startup-slack-pair" && use !== "teams-invocation-token")
      )
        throw unavailable();
      const request: GatewayMaterialDeliveryRequestV2 = {
        schemaVersion: 2,
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
      const captured = copy(request);
      assert(s);
      return captured;
    },
    /**
     * Reserve before yielding and join original material work in Source shutdown.
     * This is local custody only: the Controller still verifies the consumed claim,
     * current process and selected use. It is not a durable cross-process replay store.
     */
    withMaterialCall<T>(
      handle: GatewayStartupServiceHandleV2,
      use: GatewayMaterialDeliveryRequestV2["use"],
      work: (request: GatewayMaterialDeliveryRequestV2, signal: AbortSignal) => Promise<T>,
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
          const result = await work(request, s.abort.signal);
          assert(s);
          return result;
        } finally {
          s.materialBusy = false;
        }
      });
    },
    async recheckCurrent(handle: GatewayStartupServiceHandleV2): Promise<void> {
      const s = get(handle);
      try {
        await track(s, s.recheckNative);
        assert(s);
      } catch {
        void closeState(s);
        throw unavailable();
      }
    },
    async consume(handle: GatewayStartupServiceHandleV2): Promise<GatewayStartupServiceConsumeV2> {
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
      handle: GatewayStartupServiceHandleV2,
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
          schemaVersion: 2,
          subject: s.binding.startup.subject,
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
        assert(s);
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

export type GatewayStartupServiceSourceV2 = ReturnType<typeof createGatewayStartupServiceSourceV2>;
