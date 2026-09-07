import { randomUUID } from "node:crypto";
import {
  decodeGatewayChannelMaterialV1,
  type GatewayChannelSlackMaterialV1,
} from "@openclaw-enterprise/utils/gateway-channel-material";
import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import type {
  GatewayMaterialDeliveryRequestV1,
  GatewayMaterialDeliveryHeaderV1,
  GatewayMaterialDeliveryOutcomeV1,
} from "@openclaw-enterprise/contracts/gateway-material-delivery-v1";
import type { GatewayStartupCloseV1 } from "@openclaw-enterprise/contracts/gateway-startup-v1";
import type { GatewayStartupCommandBoundsV1 } from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import type {
  GatewayStartupServiceHandleV1,
  GatewayStartupServiceSourceV1,
} from "./startup-service-source.ts";

type Cleanup = GatewayStartupCloseV1["cleanup"];
type Use = GatewayMaterialDeliveryRequestV1["use"];
export const gatewayMaterialOperationProfile = "installation-channel-material-v1";
export const gatewayMaterialTransportProfile = "owned-child-stdio-installation-channel-material-v1";

/** The original Runtime owner supplies these methods; a data flag cannot replace it. */
export interface GatewayMaterialRuntimeParentV1 {
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
  remainingStartupMs(): number;
  /**
   * Join other original Runtime-owned consumers at final owner shutdown. This
   * cannot authorize retaining this call's decoded frame views after read's
   * callback resolves; every such use/transfer must settle inside that callback.
   */
  joinConsumers(): Promise<void>;
}
/**
 * Consumer requirements for the separate fixed native material client. Only the
 * original trusted native producer may install this implementation. This port
 * does not spawn a child, authenticate a peer, or qualify a production adapter.
 */
export interface GatewayMaterialNativeClientConnectionV1 {
  readonly profile: typeof gatewayMaterialOperationProfile;
  readonly transport: typeof gatewayMaterialTransportProfile;
  readonly request: GatewayMaterialDeliveryRequestV1;
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
  remainingMs(): number;
  /**
   * One exact response on the original authenticated connection. The native owner
   * retains its frame while work runs, rejects unknown work, and joins actual
   * forwarding/borrow completion. It must not call work after this method settles.
   * Header/framing/challenge/recipient verification belongs to that original owner.
   */
  withPayload(
    work: (header: GatewayMaterialDeliveryHeaderV1, payload: Uint8Array) => Promise<undefined>,
  ): Promise<GatewayMaterialDeliveryOutcomeV1>;
  /** Initiate cancellation and join the exact owned child/connection and borrowed frame. */
  close(): Promise<Cleanup>;
}
export interface GatewayMaterialNativeClientProducerV1 {
  /** Verify original private child/connection and parent membership on every check. */
  assertOriginal(connection: GatewayMaterialNativeClientConnectionV1): undefined;
  /**
   * Fixed installation/process/recipient and profile, subordinate to the SAME
   * original startup parent. The supplied request is nonsecret metadata only.
   * The real producer independently verifies that original parent and current use.
   */
  open(
    parent: GatewayStartupServiceHandleV1,
    request: GatewayMaterialDeliveryRequestV1,
    bounds: GatewayStartupCommandBoundsV1,
  ): Promise<GatewayMaterialNativeClientConnectionV1>;
}

const unavailable = () => new Error("Gateway material source unavailable");
const result = (kind: GatewayMaterialDeliveryOutcomeV1["kind"]): GatewayMaterialDeliveryOutcomeV1 =>
  Object.freeze({ kind });
const cleanup = (value: unknown): Cleanup =>
  value === "finished" || value === "failed" || value === "unknown" ? value : "unknown";
function merge(a: Cleanup, b: Cleanup): Cleanup {
  if (a === "unknown" || b === "unknown") return "unknown";
  return a === "failed" || b === "failed" ? "failed" : "finished";
}

/**
 * Local receiver custody. No material is returned through a JSON result or a
 * startup command. The actual native/Runtime/current registration producers are
 * required; no credential, identity or replay authority is constructed here.
 */
export function createGatewayStartupMaterialServiceSourceV1(
  source: GatewayStartupServiceSourceV1,
  parent: GatewayStartupServiceHandleV1,
  runtime: GatewayMaterialRuntimeParentV1 | undefined,
  native: GatewayMaterialNativeClientProducerV1 | undefined,
) {
  const sourceSignal = source.signal.bind(source);
  const assertSource = source.assertCurrent.bind(source);
  const recheckSource = source.recheckCurrent.bind(source);
  const readClaim = source.readClaim.bind(source);
  const remainingSource = source.remainingSourceMs.bind(source);
  const reserve = source.withMaterialCall.bind(source);
  const closeSource = source.close.bind(source);
  const runtimeSignal = runtime?.signal;
  const assertRuntime = runtime?.assertCurrent.bind(runtime);
  const remainingRuntime = runtime?.remainingStartupMs.bind(runtime);
  const joinConsumers = runtime?.joinConsumers.bind(runtime);
  const openNative = native?.open.bind(native);
  const assertOriginal = native?.assertOriginal.bind(native);
  const abort = new AbortController();
  const pendingFences = new Set<Promise<unknown>>();
  let active: Promise<GatewayMaterialDeliveryOutcomeV1> | undefined;
  let nativeClose: (() => Promise<Cleanup>) | undefined;
  let closing: Promise<Cleanup> | undefined;
  let terminalCleanup: Cleanup = "finished";

  const fence = (work: () => undefined): void => {
    const value: unknown = work();
    if (value !== undefined) {
      const p = Promise.resolve(value).catch(() => undefined);
      pendingFences.add(p);
      void p.then(() => pendingFences.delete(p));
      throw unavailable();
    }
  };
  const remainder = (work: () => number): number => {
    const value: unknown = work();
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      if (value && typeof value === "object" && "then" in value) {
        const p = Promise.resolve(value).catch(() => undefined);
        pendingFences.add(p);
        void p.then(() => pendingFences.delete(p));
      }
      throw unavailable();
    }
    return value;
  };
  const assertParents = (): undefined => {
    if (
      abort.signal.aborted ||
      !runtimeSignal ||
      runtimeSignal.aborted ||
      !assertRuntime ||
      !remainingRuntime ||
      !joinConsumers ||
      !(runtimeSignal instanceof AbortSignal) ||
      sourceSignal(parent).aborted
    )
      throw unavailable();
    fence(() => assertSource(parent));
    fence(assertRuntime);
    if (abort.signal.aborted || runtimeSignal.aborted || sourceSignal(parent).aborted)
      throw unavailable();
    return undefined;
  };
  const stop = (): void => {
    abort.abort();
    // Start cancellation before joining any pending acquisition/read/borrow.
    void nativeClose?.();
  };
  if (runtimeSignal instanceof AbortSignal)
    runtimeSignal.addEventListener("abort", stop, { once: true });
  let originalSourceSignal: AbortSignal | undefined;
  try {
    originalSourceSignal = sourceSignal(parent);
    originalSourceSignal.addEventListener("abort", stop, { once: true });
    if (originalSourceSignal.aborted || runtimeSignal?.aborted) stop();
  } catch {
    stop();
  }

  const read = (
    use: Use,
    // Fulfill undefined only after EVERY use/transfer of these borrowed views
    // settles. Do not retain them for the later Runtime shutdown join. A genuine
    // consumer that cannot meet this boundary must remain unavailable.
    consume: (material: GatewayChannelSlackMaterialV1) => Promise<undefined>,
  ): Promise<GatewayMaterialDeliveryOutcomeV1> => {
    // Qualified Teams token/expiry and its codec are not supplied by this source.
    if (use !== "startup-slack-pair" || active || closing || !openNative || !assertOriginal)
      return Promise.resolve(result("unavailable"));
    try {
      assertParents();
    } catch {
      return Promise.resolve(result("unavailable"));
    }
    let task: Promise<GatewayMaterialDeliveryOutcomeV1>;
    let knownRefusal: GatewayMaterialDeliveryOutcomeV1 | undefined;
    try {
      task = reserve(parent, use, async (request, signal) => {
        let connection: GatewayMaterialNativeClientConnectionV1 | undefined;
        let acquisitionReturned = false;
        let closeConnection: (() => Promise<Cleanup>) | undefined;
        let released: Promise<Cleanup> | undefined;
        let received = false;
        let borrowed: Promise<undefined> | undefined;
        let accepting = true;
        let nativeCurrent: (() => undefined) | undefined;
        let nativeRemaining: (() => number) | undefined;
        let end =
          performance.now() +
          Math.min(
            5000,
            remainder(() => remainingSource(parent)),
            remainder(remainingRuntime!),
          );
        const wallEnd = Date.now() + Math.max(0, end - performance.now());
        const callAbort = new AbortController();
        const callSignal = AbortSignal.any([
          abort.signal,
          signal,
          runtimeSignal!,
          callAbort.signal,
        ]);
        const bounds = Object.freeze({
          requestRef: randomUUID(),
          deadline: new Date(wallEnd).toISOString(),
          signal: callSignal,
        });
        const release = (): Promise<Cleanup> => {
          if (!released && closeConnection) {
            released = Promise.resolve()
              .then(closeConnection)
              .then(cleanup, () => "failed");
            void released.then((value) => {
              terminalCleanup = merge(terminalCleanup, value);
            });
          }
          if (acquisitionReturned && !closeConnection)
            terminalCleanup = merge(terminalCleanup, "unknown");
          return released ?? Promise.resolve("unknown");
        };
        nativeClose = release;
        const onAbort = () => {
          void release();
        };
        callSignal.addEventListener("abort", onAbort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(
            () => {
              callAbort.abort();
              stop();
              void closeSource();
            },
            Math.max(0, end - performance.now()),
          );
        };
        const check = (): undefined => {
          const previousEnd = end;
          assertParents();
          if (callSignal.aborted || Date.now() >= wallEnd || performance.now() >= end)
            throw unavailable();
          end = Math.min(
            end,
            performance.now() + remainder(() => remainingSource(parent)),
            performance.now() + remainder(remainingRuntime!),
          );
          if (connection) {
            fence(() => assertOriginal(connection!));
            fence(nativeCurrent!);
            if (connection.signal.aborted) throw unavailable();
            end = Math.min(end, performance.now() + remainder(nativeRemaining!));
          }
          if (callSignal.aborted || performance.now() >= end) throw unavailable();
          if (end < previousEnd) arm();
          return undefined;
        };
        arm();
        try {
          check();
          await recheckSource(parent);
          check();
          if ((await readClaim(parent)) !== "current") throw unavailable();
          check();
          connection = await openNative(parent, request, bounds);
          acquisitionReturned = true;
          // Own close before inspecting a late or malformed result.
          const close = connection.close;
          if (typeof close !== "function") throw unavailable();
          closeConnection = close.bind(connection);
          if (callSignal.aborted) void release();
          fence(() => assertOriginal(connection!));
          nativeCurrent = connection.assertCurrent.bind(connection);
          nativeRemaining = connection.remainingMs.bind(connection);
          const withPayload = connection.withPayload.bind(connection);
          if (
            connection.profile !== gatewayMaterialOperationProfile ||
            connection.transport !== gatewayMaterialTransportProfile ||
            !(connection.signal instanceof AbortSignal) ||
            !isDeepStrictEqual(connection.request, request)
          )
            throw unavailable();
          connection.signal.addEventListener("abort", onAbort, { once: true });
          check();
          const response = await withPayload((header, payload) => {
            if (!accepting || received) return Promise.reject(unavailable());
            received = true;
            borrowed = Promise.resolve().then(async (): Promise<undefined> => {
              check();
              if (
                !header ||
                Object.keys(header).sort().join() !== "kind,purpose,requestRef,schemaVersion,use" ||
                header.schemaVersion !== 1 ||
                header.purpose !== request.purpose ||
                header.use !== request.use ||
                header.requestRef !== bounds.requestRef ||
                header.kind !== "selected-bundle" ||
                !(payload instanceof Uint8Array) ||
                !(payload.buffer instanceof ArrayBuffer) ||
                payload.byteLength < 1 ||
                payload.byteLength > 28672 ||
                payload.buffer.byteLength > 32768 ||
                Buffer.byteLength(JSON.stringify(header), "utf8") > 2048
              )
                throw unavailable();
              const material = decodeGatewayChannelMaterialV1(payload, request.use);
              const value: unknown = await consume(material);
              if (value !== undefined) throw unavailable();
              check();
              return undefined;
            });
            void borrowed.catch(() => undefined);
            return borrowed;
          });
          accepting = false;
          // A native adapter cannot hide an unjoined or rejected consumer callback.
          if (borrowed) await borrowed;
          check();
          if (!response || Object.keys(response).join() !== "kind") throw unavailable();
          if (response.kind === "delivered" && received) return result("delivered");
          if (
            !received &&
            (response.kind === "denied" ||
              response.kind === "unavailable" ||
              response.kind === "recovery-required")
          ) {
            knownRefusal = result(response.kind);
            stop();
            void closeSource();
            return knownRefusal;
          }
          throw unavailable();
        } catch {
          stop();
          void closeSource();
          return result(received ? "recovery-required" : "unavailable");
        } finally {
          accepting = false;
          // Cancellation may start now, but borrowed bytes remain owned until actual settlement.
          void release();
          if (borrowed) await borrowed.catch(() => undefined);
          if (released) await released;
          while (pendingFences.size) await Promise.allSettled([...pendingFences]);
          clearTimeout(timer);
          callSignal.removeEventListener("abort", onAbort);
          connection?.signal?.removeEventListener("abort", onAbort);
          nativeClose = undefined;
        }
      });
    } catch {
      return Promise.resolve(result("unavailable"));
    }
    active = task.catch(() => result("unavailable"));
    const tracked = active;
    void tracked.then(() => {
      if (active === tracked) active = undefined;
    });
    // Return the bounded refusal while retaining the original task until real
    // settlement. A timeout never clears the active slot or certifies cleanup.
    return new Promise<GatewayMaterialDeliveryOutcomeV1>((resolve) => {
      const stopped = () => resolve(knownRefusal ?? result("recovery-required"));
      abort.signal.addEventListener("abort", stopped, { once: true });
      if (abort.signal.aborted) stopped();
      void tracked.then((value) => {
        abort.signal.removeEventListener("abort", stopped);
        resolve(value);
      });
    });
  };

  return Object.freeze({
    /** Fixed trusted consumer; the raw selected frame never becomes a result DTO. */
    read,
    assertCurrent: assertParents,
    close(): Promise<Cleanup> {
      stop();
      if (!closing)
        closing = (async () => {
          await active;
          while (pendingFences.size) await Promise.allSettled([...pendingFences]);
          try {
            await joinConsumers?.();
          } catch {
            terminalCleanup = merge(terminalCleanup, "unknown");
          }
          runtimeSignal?.removeEventListener("abort", stop);
          originalSourceSignal?.removeEventListener("abort", stop);
          return terminalCleanup;
        })();
      return closing;
    },
  });
}
