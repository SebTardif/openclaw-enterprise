import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type {
  GatewayStartupBindingV1,
  GatewayStartupBindingV2,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";
import {
  parseGatewayInstallationServiceAssociationV1,
  parseGatewayInstallationServiceAssociationV2,
  type GatewayInstallationServiceAssociationV1,
  type GatewayInstallationServiceAssociationV2,
} from "@openclaw-enterprise/occ/gateway-startup-v1/installation-service";
import {
  canonicalGatewayStartupValueV1,
  parseGatewayStartupBindingV1,
  parseGatewayStartupBindingV2,
  parseGatewayStartupCommandV1,
  parseGatewayStartupCommandV2,
  type GatewayStartupCommandBoundsV1,
  type GatewayStartupOwnerFailureV1,
  type GatewayStartupOwnerFailureV2,
  type GatewayStartupOwnerSuccessV1,
  type GatewayStartupOwnerSuccessV2,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import { verifyGatewayNativeExecutableV1 } from "./native-client-executable.ts";
import {
  closedNativeObject,
  consumeNativeFrames,
  nativeDigest,
  nativeJson,
  nativePayload,
  nativeTimestamp,
  writeNativeFrame,
} from "./startup-native-wire.ts";
import {
  gatewayStartupOperationProfile,
  gatewayStartupTransportProfile,
  type GatewayStartupNativeConnectionV1,
  type GatewayStartupNativeProducerV1,
  type GatewayStartupNativeProducerV2,
  type GatewayStartupServiceCommandV1,
  type GatewayStartupServiceCommandV2,
} from "./startup-service-source.ts";

type Consume = Extract<GatewayStartupServiceCommandV1, { kind: "consume-startup" }>;
type Cleanup = Awaited<ReturnType<GatewayStartupNativeConnectionV1["close"]>>;
type ResultV1 = GatewayStartupOwnerSuccessV1 | GatewayStartupOwnerFailureV1;
type ResultV2 = GatewayStartupOwnerSuccessV2 | GatewayStartupOwnerFailureV2;
type Binding = GatewayStartupBindingV1 | GatewayStartupBindingV2;
type Command = GatewayStartupServiceCommandV1 | GatewayStartupServiceCommandV2;
type Consuming<C extends Command> = Extract<C, { kind: "consume-startup" }>;
interface NativeConnection<B extends Binding, C extends Command, R> {
  readonly binding: B;
  readonly consumeCommand: Consuming<C>;
  readonly signal: AbortSignal;
  readonly expiresAtMs: number;
  assertCurrent(): undefined;
  recheckCurrent(): Promise<void>;
  execute(command: C, bounds: GatewayStartupCommandBoundsV1): Promise<R>;
  close(): Promise<Cleanup>;
}
interface NativeProducer<B extends Binding, C extends Command, R> {
  assertOriginal(connection: NativeConnection<B, C, R>): undefined;
  open(signal: AbortSignal): Promise<NativeConnection<B, C, R>>;
}
interface NativeOptions<B extends Binding, C extends Command> {
  readonly binaryPath: string;
  readonly address: string;
  readonly configurationVersion: number;
  readonly profile: Readonly<Record<string, unknown>>;
  readonly association:
    GatewayInstallationServiceAssociationV1 | GatewayInstallationServiceAssociationV2;
  readonly binding: B;
  readonly consumeCommand: Consuming<C>;
}

/** Original protected deployment selection, captured once. These data provide
 * expectations only; the actual child authenticates TLS and the Controller
 * independently authorizes the exact startup, process, registration and claim. */
export interface GatewayStartupNativeClientOptionsV1 {
  readonly binaryPath: string;
  readonly address: string;
  readonly configurationVersion: number;
  readonly profile: Readonly<Record<string, unknown>>;
  readonly association: GatewayInstallationServiceAssociationV1;
  readonly binding: GatewayStartupBindingV1;
  readonly consumeCommand: Consume;
}

export interface GatewayStartupNativeClientOptionsV2 extends NativeOptions<
  GatewayStartupBindingV2,
  GatewayStartupServiceCommandV2
> {
  readonly association: GatewayInstallationServiceAssociationV2;
}

const unavailable = () => new Error("Gateway native startup unavailable");
const id = () => randomBytes(16).toString("hex");
const idPattern = /^[0-9a-f]{32}$/u;
const hashPattern = /^sha256:[0-9a-f]{64}$/u;
const eventKeys = [
  "schemaVersion",
  "kind",
  "incarnation",
  "sequence",
  "connectionId",
  "exchangeId",
  "requestDigest",
  "challenge",
  "payloadBase64",
  "deadline",
  "configurationVersion",
  "profileDigest",
];
const inspectionKeys = [
  "valid",
  "ownSPIFFEId",
  "peerSPIFFEId",
  "recipientSPIFFEId",
  "authenticatedAt",
  "expiresAt",
  "peerCertificateSha256",
];
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const copy = <T>(value: T): T => freeze(JSON.parse(canonicalGatewayStartupValueV1(value)) as T);

/** Owns one fixed native child, original pipes and connection. There is no
 * reconnect, queue, peer-object enrollment or caller-selected execution callback.
 * Rechecks ask that same child to inspect its original Source/TLS connection;
 * native authentication is separate from the service Source's current-claim read. */
export function createGatewayStartupNativeClientV1(
  options: GatewayStartupNativeClientOptionsV1,
): GatewayStartupNativeProducerV1 {
  return createNativeClient<GatewayStartupBindingV1, GatewayStartupServiceCommandV1, ResultV1>(
    options,
    {
      binding: parseGatewayStartupBindingV1,
      association: parseGatewayInstallationServiceAssociationV1,
      command(value) {
        const command = parseGatewayStartupCommandV1(value);
        if (
          command.kind !== "consume-startup" &&
          command.kind !== "read-current" &&
          command.kind !== "read-operation"
        )
          throw unavailable();
        return command;
      },
      consume(value) {
        const command = parseGatewayStartupCommandV1(value);
        if (command.kind !== "consume-startup") throw unavailable();
        return command;
      },
    },
  );
}
export function createGatewayStartupNativeClientV2(
  options: GatewayStartupNativeClientOptionsV2,
): GatewayStartupNativeProducerV2 {
  return createNativeClient<GatewayStartupBindingV2, GatewayStartupServiceCommandV2, ResultV2>(
    options,
    {
      binding: parseGatewayStartupBindingV2,
      association: parseGatewayInstallationServiceAssociationV2,
      command(value) {
        const command = parseGatewayStartupCommandV2(value);
        if (
          command.kind !== "consume-startup" &&
          command.kind !== "read-current" &&
          command.kind !== "read-operation"
        )
          throw unavailable();
        return command;
      },
      consume(value) {
        const command = parseGatewayStartupCommandV2(value);
        if (command.kind !== "consume-startup") throw unavailable();
        return command;
      },
    },
  );
}
/** Private shared transport only; callers cannot select codecs or replace its
 * Source/Inspect, executable, pipe, deadline or single-exchange ownership. */
function createNativeClient<B extends Binding, C extends Command, R>(
  options: NativeOptions<B, C>,
  protocol: {
    binding(value: unknown): B;
    association(
      value: unknown,
    ): GatewayInstallationServiceAssociationV1 | GatewayInstallationServiceAssociationV2;
    command(value: unknown): C;
    consume(value: unknown): Consuming<C>;
  },
): NativeProducer<B, C, R> {
  const profile = copy(options.profile),
    association = copy(protocol.association(options.association));
  const binding = copy(protocol.binding(options.binding));
  const command = copy(protocol.consume(options.consumeCommand));
  const { binaryPath, address, configurationVersion } = options;
  const endpoint = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/u.exec(address);
  if (
    !endpoint ||
    !isIP(endpoint[1] ?? endpoint[2] ?? "") ||
    String(Number(endpoint[3])) !== endpoint[3] ||
    Number(endpoint[3]) < 1 ||
    Number(endpoint[3]) > 65535 ||
    !Number.isSafeInteger(configurationVersion) ||
    configurationVersion < 1 ||
    profile.schemaVersion !== 1 ||
    profile.operationPolicy !== gatewayStartupOperationProfile ||
    profile.transportProfileRef !== gatewayStartupTransportProfile ||
    profile.ownSPIFFEId !== association.endpoints.gateway.spiffeId ||
    profile.peerSPIFFEId !== association.endpoints.controller.spiffeId ||
    profile.recipientSPIFFEId !== profile.peerSPIFFEId ||
    profile.recipientRef !== association.endpoints.transportRecipientRef ||
    association.endpoints.transportRecipientRef !== association.endpoints.controller.serviceRef ||
    typeof profile.nativeExecutableSha256 !== "string" ||
    !hashPattern.test(profile.nativeExecutableSha256) ||
    !isDeepStrictEqual(profile.limits, {
      handshakeTimeoutMs: 3000,
      recheckIntervalMs: 1000,
      maxConnectionAgeMs: 30000,
      maxConnections: 1,
      requestTimeoutMs: 3000,
    }) ||
    command.kind !== "consume-startup" ||
    !isDeepStrictEqual(command.startup, binding.startup) ||
    !isDeepStrictEqual(association.startup, binding.startup) ||
    !isDeepStrictEqual(association.recipient, command.recipient) ||
    association.createEffectRef !== binding.createEffectRef
  )
    throw unavailable();
  const consumeCommand = command;
  const executableDigest = profile.nativeExecutableSha256;
  const profileBytes = Buffer.from(canonicalGatewayStartupValueV1(profile));
  const profileDigest = nativeDigest(profileBytes);
  const originals = new WeakMap<NativeConnection<B, C, R>, () => undefined>();
  let attempted = false;

  return Object.freeze({
    assertOriginal(connection: NativeConnection<B, C, R>): undefined {
      const assert = originals.get(connection);
      if (!assert) throw unavailable();
      return assert();
    },
    async open(parent: AbortSignal): Promise<NativeConnection<B, C, R>> {
      if (attempted || !(parent instanceof AbortSignal) || parent.aborted) throw unavailable();
      attempted = true;
      const abort = new AbortController(),
        incarnation = id();
      let child: ChildProcessWithoutNullStreams | undefined, exited: Promise<void> | undefined;
      let acquisition: Promise<void> | undefined, closing: Promise<Cleanup> | undefined;
      let stopChildWork: Promise<void> | undefined;
      let stopFrames = () => {};
      let failure = false,
        consumed = false,
        serviceBusy = false;
      let sequence = 1,
        eventSequence = 0;
      let connectionId = "",
        inspectionText = "";
      let expiresAtMs = 0,
        monotonicEnd = 0,
        inspectedAt = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let termTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const pending = new Set<Promise<unknown>>();
      let exchange:
        | {
            readonly kind: "call" | "inspect";
            delivered: boolean;
            readonly exchangeId: string;
            readonly requestDigest: string;
            readonly challenge: string;
            readonly deadlineMs: number;
            readonly monotonicDeadline: number;
            readonly resolve: (value: Record<string, unknown>) => void;
            readonly reject: () => void;
          }
        | undefined;
      let readyResolve = () => {},
        readyReject = () => {};
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = () => reject(unavailable());
      });
      void ready.catch(() => {});
      const track = <T>(task: Promise<T>): Promise<T> => {
        pending.add(task);
        void task.then(
          () => pending.delete(task),
          () => pending.delete(task),
        );
        return task;
      };
      const stopChild = () => {
        if (!child || !exited || stopChildWork) return;
        const owned = child;
        stopChildWork = exited.finally(() => {
          clearTimeout(termTimer);
          clearTimeout(killTimer);
          owned.stdin.destroy();
          owned.stdout.destroy();
          owned.stderr.destroy();
        });
        owned.stdin.destroy();
        termTimer = setTimeout(() => {
          owned.kill("SIGTERM");
        }, 100);
        killTimer = setTimeout(() => {
          owned.kill("SIGKILL");
        }, 350);
      };
      const close = (): Promise<Cleanup> => {
        if (!closing) {
          // Publish the unique join before abort handlers can reenter. Pending
          // native work and the actual child exit remain owned without a timeout
          // being interpreted as successful cleanup or physical termination.
          closing = Promise.resolve().then(async () => {
            await acquisition?.catch(() => {});
            while (pending.size) await Promise.allSettled([...pending]);
            stopChild();
            await stopChildWork;
            parent.removeEventListener("abort", onAbort);
            return failure ? "failed" : "finished";
          });
          abort.abort();
          clearTimeout(timer);
          clearTimeout(pollTimer);
          readyReject();
          exchange?.reject();
          exchange = undefined;
          stopFrames();
          stopChild();
        }
        return closing;
      };
      const onAbort = () => {
        void close();
      };
      const fail = () => {
        failure = true;
        void close();
      };
      const live = (): undefined => {
        if (
          abort.signal.aborted ||
          parent.aborted ||
          !connectionId ||
          Date.now() >= expiresAtMs ||
          performance.now() >= monotonicEnd ||
          !child ||
          child.exitCode !== null ||
          child.signalCode !== null
        )
          throw unavailable();
        return undefined;
      };
      const current = (): undefined => {
        live();
        if (performance.now() - inspectedAt >= 1000) throw unavailable();
        return undefined;
      };
      const parseInspection = (event: Record<string, unknown>): string => {
        const value = closedNativeObject(
          nativeJson(nativePayload(event.payloadBase64)),
          inspectionKeys,
        );
        const start = Date.parse(nativeTimestamp(value.authenticatedAt));
        const end = Date.parse(nativeTimestamp(value.expiresAt));
        if (
          value.valid !== true ||
          value.ownSPIFFEId !== profile.ownSPIFFEId ||
          value.peerSPIFFEId !== profile.peerSPIFFEId ||
          value.recipientSPIFFEId !== profile.recipientSPIFFEId ||
          typeof value.peerCertificateSha256 !== "string" ||
          !hashPattern.test(value.peerCertificateSha256) ||
          start > Date.now() ||
          end <= Date.now() ||
          end - start > 30000
        )
          throw unavailable();
        return canonicalGatewayStartupValueV1(value);
      };
      const onFrame = (bytes: Buffer) => {
        const event = closedNativeObject(nativeJson(bytes), eventKeys);
        if (
          event.schemaVersion !== 1 ||
          event.incarnation !== incarnation ||
          !Number.isSafeInteger(event.sequence) ||
          event.sequence !== eventSequence + 1 ||
          event.configurationVersion !== configurationVersion ||
          event.profileDigest !== profileDigest ||
          typeof event.connectionId !== "string" ||
          !idPattern.test(event.connectionId)
        )
          throw unavailable();
        eventSequence++;
        if (event.kind === "ready") {
          if (
            connectionId ||
            exchange ||
            event.sequence !== 1 ||
            event.exchangeId !== "" ||
            event.requestDigest !== "" ||
            event.challenge !== ""
          )
            throw unavailable();
          inspectionText = parseInspection(event);
          const inspection = JSON.parse(inspectionText) as Record<string, unknown>;
          expiresAtMs = Math.min(
            Date.parse(nativeTimestamp(event.deadline)),
            Date.parse(nativeTimestamp(inspection.expiresAt)),
          );
          if (expiresAtMs <= Date.now() || expiresAtMs - Date.now() > 30000) throw unavailable();
          monotonicEnd = performance.now() + expiresAtMs - Date.now();
          connectionId = event.connectionId;
          inspectedAt = performance.now();
          clearTimeout(timer);
          timer = setTimeout(onAbort, Math.max(0, expiresAtMs - Date.now()));
          readyResolve();
          return;
        }
        live();
        const active = exchange;
        if (
          !active ||
          active.delivered ||
          event.connectionId !== connectionId ||
          event.exchangeId !== active.exchangeId ||
          event.requestDigest !== active.requestDigest ||
          event.challenge !== active.challenge ||
          Date.now() >= active.deadlineMs ||
          performance.now() >= active.monotonicDeadline
        )
          throw unavailable();
        if (active.kind === "inspect") {
          if (
            event.kind !== "inspected" ||
            Date.parse(nativeTimestamp(event.deadline)) !== expiresAtMs ||
            parseInspection(event) !== inspectionText
          )
            throw unavailable();
        } else if (
          event.kind !== "result" ||
          Date.parse(nativeTimestamp(event.deadline)) > active.deadlineMs ||
          Date.parse(nativeTimestamp(event.deadline)) <= Date.now()
        )
          throw unavailable();
        inspectedAt = performance.now();
        // Keep the original exchange occupied through result parsing and final
        // disclosure fences, including multiple frames in the same stream chunk.
        active.delivered = true;
        active.resolve(event);
      };
      const request = (
        kind: "call" | "inspect",
        payload: Buffer,
        bounds: GatewayStartupCommandBoundsV1,
      ) => {
        live();
        if (exchange || bounds.signal.aborted) return Promise.reject(unavailable());
        const deadlineMs = Math.min(Date.parse(nativeTimestamp(bounds.deadline)), expiresAtMs);
        if (deadlineMs <= Date.now() || deadlineMs - Date.now() > 3000)
          return Promise.reject(unavailable());
        let reject = () => {};
        const response = new Promise<Record<string, unknown>>((resolve, rejectResponse) => {
          reject = () => rejectResponse(unavailable());
          exchange = {
            kind,
            delivered: false,
            exchangeId: kind === "call" ? id() : "",
            requestDigest: kind === "call" ? nativeDigest(payload) : "",
            challenge: id(),
            deadlineMs,
            monotonicDeadline: performance.now() + deadlineMs - Date.now(),
            resolve,
            reject,
          };
        });
        void response.catch(() => {});
        const original = exchange!;
        const callTimer = setTimeout(onAbort, Math.max(0, deadlineMs - Date.now()));
        bounds.signal.addEventListener("abort", onAbort, { once: true });
        const work = (async () => {
          try {
            await writeNativeFrame(
              child!.stdin,
              {
                schemaVersion: 1,
                kind,
                incarnation,
                sequence: ++sequence,
                connectionId,
                exchangeId: original.exchangeId,
                requestDigest: original.requestDigest,
                challenge: original.challenge,
                payloadBase64: payload.toString("base64"),
              },
              abort.signal,
            );
            const result = await response;
            live();
            if (
              bounds.signal.aborted ||
              Date.now() >= deadlineMs ||
              performance.now() >= original.monotonicDeadline
            )
              throw unavailable();
            return result;
          } catch {
            fail();
            throw unavailable();
          } finally {
            clearTimeout(callTimer);
            bounds.signal.removeEventListener("abort", onAbort);
            if (exchange === original) exchange = undefined;
          }
        })();
        if (bounds.signal.aborted) onAbort();
        return track(work);
      };
      let inspecting: Promise<void> | undefined;
      const inspect = (): Promise<void> => {
        if (inspecting) return inspecting;
        if (serviceBusy) return Promise.reject(unavailable());
        const work = (async () => {
          await request("inspect", Buffer.alloc(0), {
            requestRef: id(),
            deadline: new Date(Math.min(Date.now() + 3000, expiresAtMs)).toISOString(),
            signal: abort.signal,
          });
          current();
        })();
        inspecting = work;
        void work.then(
          () => {
            inspecting = undefined;
          },
          () => {
            inspecting = undefined;
          },
        );
        return work;
      };
      const poll = () => {
        if (abort.signal.aborted) return;
        pollTimer = setTimeout(() => {
          const work = exchange || serviceBusy ? Promise.resolve() : inspect();
          void work.then(poll, fail);
        }, 750);
      };
      parent.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(onAbort, 3000);
      acquisition = (async () => {
        await verifyGatewayNativeExecutableV1(binaryPath, executableDigest, abort.signal);
        if (abort.signal.aborted || parent.aborted) throw unavailable();
        child = spawn(binaryPath, ["gateway-startup-client"], {
          env: {},
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        const owned = child;
        exited = new Promise<void>((resolve) => {
          owned.once("close", () => resolve());
          owned.once("error", fail);
        });
        owned.stdin.on("error", fail);
        owned.stderr.on("error", fail);
        owned.stderr.resume();
        stopFrames = consumeNativeFrames(owned.stdout, onFrame, fail);
        void exited.then(() => {
          if (!abort.signal.aborted) fail();
        });
        await writeNativeFrame(
          owned.stdin,
          {
            schemaVersion: 1,
            kind: "bootstrap",
            incarnation,
            sequence: 1,
            profileBase64: profileBytes.toString("base64"),
            profileDigest,
            configurationVersion,
            connectAddress: address,
          },
          abort.signal,
        );
        await ready;
        current();
      })();
      try {
        await acquisition;
        const connection = Object.freeze<NativeConnection<B, C, R>>({
          binding,
          consumeCommand,
          signal: abort.signal,
          expiresAtMs,
          assertCurrent: current,
          recheckCurrent: inspect,
          execute(input, suppliedBounds): Promise<R> {
            // Reserve before yielding to an already-owned native inspection. A
            // second service call is refused, and the idle poll cannot preempt
            // this accepted invocation while its original deadline keeps running.
            if (serviceBusy) return Promise.reject(unavailable());
            serviceBusy = true;
            let callTimer: ReturnType<typeof setTimeout> | undefined;
            let callSignal: AbortSignal | undefined;
            const work = (async (): Promise<R> => {
              try {
                const bounds = Object.freeze({
                  requestRef: suppliedBounds.requestRef,
                  deadline: suppliedBounds.deadline,
                  signal: suppliedBounds.signal,
                });
                callSignal = bounds.signal;
                const deadline = Date.parse(nativeTimestamp(bounds.deadline));
                const remaining = deadline - Date.now();
                const monotonicDeadline = performance.now() + remaining;
                if (
                  !(callSignal instanceof AbortSignal) ||
                  callSignal.aborted ||
                  remaining <= 0 ||
                  remaining > 3000
                )
                  throw unavailable();
                callSignal.addEventListener("abort", onAbort, { once: true });
                callTimer = setTimeout(onAbort, remaining);
                live();
                const parsed = copy(protocol.command(input));
                if (
                  parsed.kind !== "consume-startup" &&
                  parsed.kind !== "read-current" &&
                  parsed.kind !== "read-operation"
                )
                  throw unavailable();
                if (parsed.kind === "read-operation") {
                  if (
                    (parsed.schemaVersion === 2
                      ? !("subject" in binding.startup) ||
                        !isDeepStrictEqual(parsed.subject, binding.startup.subject) ||
                        !isDeepStrictEqual(parsed.operation.subject, binding.startup.subject)
                      : !("installationId" in binding.startup) ||
                        parsed.operation.installationId !== binding.startup.installationId) ||
                    (parsed.operation.startup
                      ? !isDeepStrictEqual(parsed.operation.startup, binding.startup)
                      : parsed.operation.operationRef !== binding.startup.operationRef ||
                        parsed.operation.operationDigest !== binding.startup.operationDigest)
                  )
                    throw unavailable();
                } else if (
                  !isDeepStrictEqual(parsed.startup, binding.startup) ||
                  !isDeepStrictEqual(parsed.recipient, consumeCommand.recipient)
                )
                  throw unavailable();
                if (parsed.kind === "consume-startup") {
                  if (consumed || !isDeepStrictEqual(parsed, consumeCommand)) throw unavailable();
                  consumed = true;
                }
                const payload = Buffer.from(
                  canonicalGatewayStartupValueV1({
                    schemaVersion: 1,
                    method: parsed.kind,
                    deadline: bounds.deadline,
                    operation: parsed,
                  }),
                );
                if (payload.length > 65536) throw unavailable();
                // Join only the existing original inspector, never another service
                // invocation or a new/replacement connection. No deadline is renewed.
                await inspecting;
                if (
                  bounds.signal.aborted ||
                  Date.now() >= deadline ||
                  performance.now() >= monotonicDeadline
                )
                  throw unavailable();
                const event = await request("call", payload, bounds);
                const result = copy(nativeJson(nativePayload(event.payloadBase64))) as R;
                current();
                if (
                  bounds.signal.aborted ||
                  Date.now() >= deadline ||
                  performance.now() >= monotonicDeadline
                )
                  throw unavailable();
                // Detailed command/record correspondence and the sole confirmed
                // consume remain owned by the corresponding startup service Source.
                return result;
              } catch {
                fail();
                throw unavailable();
              } finally {
                clearTimeout(callTimer);
                if (callSignal instanceof AbortSignal)
                  callSignal.removeEventListener("abort", onAbort);
                serviceBusy = false;
              }
            })();
            return track(work);
          },
          close,
        });
        originals.set(connection, current);
        poll();
        return connection;
      } catch {
        await close();
        throw unavailable();
      }
    },
  });
}
