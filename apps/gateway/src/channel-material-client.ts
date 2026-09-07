import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type {
  GatewayMaterialDeliveryHeaderV1,
  GatewayMaterialDeliveryRequestV1,
} from "@openclaw-enterprise/contracts/gateway-material-delivery-v1";
import { parseGatewayMaterialDeliveryRequestV1 } from "@openclaw-enterprise/occ/gateway-startup-v1/material-delivery";
import type { GatewayInstallationServiceAssociationV1 } from "@openclaw-enterprise/occ/gateway-startup-v1/installation-service";
import type { GatewayStartupCommandBoundsV1 } from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import {
  createMaterialFrameV1,
  materialFrameKinds as kinds,
  materialMetadataTextV1,
  readMaterialFrameV1,
  writeMaterialFrameV1,
  type MaterialFrameV1,
} from "@openclaw-enterprise/utils/native-material-wire";
import type {
  GatewayMaterialNativeClientConnectionV1,
  GatewayMaterialNativeClientProducerV1,
} from "./startup-material-service-source.ts";
import type {
  GatewayStartupServiceHandleV1,
  GatewayStartupServiceSourceV1,
} from "./startup-service-source.ts";

const unavailable = () => new Error("Gateway native material client unavailable");
const policy = "installation-channel-material-v1";
const transport = "owned-child-stdio-installation-channel-material-v1";
const text = materialMetadataTextV1;
const digest = (value: unknown) =>
  `sha256:${createHash("sha256").update(text(value)).digest("hex")}`;
const id = () => randomBytes(16).toString("hex");
const idPattern = /^[0-9a-f]{32}$/u;
const hashPattern = /^sha256:[0-9a-f]{64}$/u;
const refPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/u;
const envelopeKeys = [
  "schemaVersion",
  "sequence",
  "connectionId",
  "exchangeId",
  "challenge",
  "requestDigest",
  "deadline",
  "message",
];
const closed = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw unavailable();
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw unavailable();
  return value as Record<string, unknown>;
};
const timestamp = (value: unknown): number => {
  if (typeof value !== "string") throw unavailable();
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value) throw unavailable();
  return result;
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const copy = <T>(value: T): T => freeze(JSON.parse(text(value)) as T);

/** Protected deployment inputs, captured once. These data are not a grant or a
 * substitute for original Source membership, current registration or TLS. The
 * native binary validates its existing exact profile schema; no new wire type
 * or caller-supplied process/transport callback is introduced here. */
export interface GatewayChannelMaterialClientOptionsV1 {
  readonly binaryPath: string;
  readonly address: string;
  readonly configurationVersion: number;
  readonly profile: Readonly<Record<string, unknown>>;
  readonly association: GatewayInstallationServiceAssociationV1;
}

/** The original deployment must protect the binary AND its parent directories.
 * This bounded digest check cannot defeat a privileged concurrent replacement. */
async function verifyExecutable(path: string, expected: string, signal: AbortSignal) {
  if (!isAbsolute(path) || normalize(path) !== path || !hashPattern.test(expected))
    throw unavailable();
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > 256 * 1024 * 1024 ||
      (before.mode & 0o022) !== 0 ||
      (before.mode & 0o111) === 0 ||
      (before.uid !== 0 && before.uid !== process.getuid?.())
    )
      throw unavailable();
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    try {
      for (let offset = 0; offset < before.size;) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - offset),
          offset,
        );
        if (!bytesRead) throw unavailable();
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await file.stat();
      signal.throwIfAborted();
      if (
        before.size !== after.size ||
        before.ctimeMs !== after.ctimeMs ||
        before.mtimeMs !== after.mtimeMs ||
        `sha256:${hash.digest("hex")}` !== expected
      )
        throw unavailable();
    } finally {
      buffer.fill(0);
    }
  } finally {
    await file.close();
  }
}

/** One active child, no queue or retry. The Source passed at construction owns
 * the only parent-handle membership check; a serialized record cannot enroll a
 * handle. A connection is recognized only by this factory's private WeakMap. */
export function createGatewayChannelMaterialClientV1(
  source: GatewayStartupServiceSourceV1,
  options: GatewayChannelMaterialClientOptionsV1,
): GatewayMaterialNativeClientProducerV1 {
  const profile = copy(options.profile),
    association = copy(options.association);
  const { binaryPath, address, configurationVersion } = options;
  const assertSource = source.assertCurrent.bind(source),
    sourceRequest = source.materialRequest.bind(source);
  const sourceSignal = source.signal.bind(source),
    sourceRemaining = source.remainingSourceMs.bind(source);
  const recheckSource = source.recheckCurrent.bind(source);
  const host = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/u.exec(address);
  if (
    !host ||
    !isIP(host[1] ?? host[2] ?? "") ||
    !host[3] ||
    String(Number(host[3])) !== host[3] ||
    Number(host[3]) < 1 ||
    Number(host[3]) > 65535 ||
    !Number.isSafeInteger(configurationVersion) ||
    configurationVersion < 1 ||
    profile.schemaVersion !== 1 ||
    profile.operationPolicy !== policy ||
    profile.transportProfileRef !== transport ||
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
      maxConnectionAgeMs: 5000,
      maxConnections: 1,
      requestTimeoutMs: 5000,
    })
  )
    throw unavailable();
  const executableDigest = profile.nativeExecutableSha256,
    profileDigest = digest(profile);
  const originals = new WeakMap<GatewayMaterialNativeClientConnectionV1, () => undefined>();
  let occupied = false;
  return Object.freeze({
    assertOriginal(connection: GatewayMaterialNativeClientConnectionV1): undefined {
      const current = originals.get(connection);
      if (!current) throw unavailable();
      return current();
    },
    async open(
      parent: GatewayStartupServiceHandleV1,
      input: GatewayMaterialDeliveryRequestV1,
      suppliedBounds: GatewayStartupCommandBoundsV1,
    ) {
      if (occupied) throw unavailable();
      occupied = true; // Reserve before any await; a losing open never joins a queue.
      const abort = new AbortController(),
        pendingFences = new Set<Promise<unknown>>();
      let child: ChildProcessWithoutNullStreams | undefined, childExit: Promise<void> | undefined;
      let init: Promise<void> | undefined, operation: Promise<unknown> | undefined;
      let closing: Promise<"finished" | "failed" | "unknown"> | undefined;
      let signal: AbortSignal | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      let terminateTimer: ReturnType<typeof setTimeout> | undefined,
        killTimer: ReturnType<typeof setTimeout> | undefined;
      let stopChildWork: Promise<void> | undefined,
        failure = false,
        used = false;
      let expiresAt = 0,
        monotonicEnd = 0;
      let frame: MaterialFrameV1 | undefined, hello: Record<string, unknown> | undefined;
      let request: GatewayMaterialDeliveryRequestV1, bounds: GatewayStartupCommandBoundsV1;
      let parentSignal: AbortSignal;
      const trackFence = (value: unknown) => {
        const promise = Promise.resolve(value);
        pendingFences.add(promise);
        void promise.then(
          () => pendingFences.delete(promise),
          () => pendingFences.delete(promise),
        );
        return promise;
      };
      const assertParent = () => {
        const result: unknown = assertSource(parent);
        if (result !== undefined) {
          trackFence(result);
          throw unavailable();
        }
        if (!isDeepStrictEqual(sourceRequest(parent, request.use), request)) throw unavailable();
      };
      const current = (): undefined => {
        if (
          abort.signal.aborted ||
          !signal ||
          signal.aborted ||
          Date.now() >= expiresAt ||
          performance.now() >= monotonicEnd
        )
          throw unavailable();
        assertParent();
        return undefined;
      };
      const stopChild = () => {
        if (!child || !childExit || stopChildWork) return;
        const owned = child;
        // EOF follows the receiver's final fence on normal explicit close. On
        // cancellation it interrupts immediately, but owned work remains joined.
        stopChildWork = childExit.finally(() => {
          clearTimeout(terminateTimer);
          clearTimeout(killTimer);
          owned.stdin.destroy();
          owned.stdout.destroy();
          owned.stderr.destroy();
        });
        try {
          owned.stdin.end();
        } catch {
          failure = true;
        }
        terminateTimer = setTimeout(() => {
          try {
            owned.kill("SIGTERM");
          } catch {
            failure = true;
          }
        }, 100);
        killTimer = setTimeout(() => {
          try {
            owned.kill("SIGKILL");
          } catch {
            failure = true;
          }
        }, 350);
      };
      const close = (): Promise<"finished" | "failed" | "unknown"> => {
        if (!closing) {
          // Install the close promise before abort/EOF can synchronously
          // reenter through an owned stream listener.
          closing = Promise.resolve().then(async () => {
            await Promise.allSettled([init, operation]);
            await Promise.allSettled([...pendingFences]);
            stopChild();
            // No timeout relabels an unsettled child as clean. The outer IDN
            // owner retains this pending close and its occupied consumer slot.
            await stopChildWork;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            occupied = false;
            return failure ? "failed" : "finished";
          });
          abort.abort();
          stopChild();
        }
        return closing;
      };
      const onAbort = () => {
        void close();
      };
      const send = async (kind: Parameters<typeof createMaterialFrameV1>[0], metadata: unknown) => {
        current();
        if (!child) throw unavailable();
        await writeMaterialFrameV1(
          child.stdin,
          createMaterialFrameV1(kind, metadata),
          abort.signal,
        );
        current();
      };
      const envelope = (value: MaterialFrameV1) => {
        const event = closed(value.metadata, envelopeKeys);
        if (
          event.schemaVersion !== 1 ||
          event.sequence !== 1 ||
          ![event.connectionId, event.exchangeId, event.challenge].every(
            (v) => typeof v === "string" && idPattern.test(v),
          )
        )
          throw unavailable();
        return event;
      };
      init = (async () => {
        request = copy(parseGatewayMaterialDeliveryRequestV1(input));
        bounds = Object.freeze({
          requestRef: suppliedBounds.requestRef,
          deadline: suppliedBounds.deadline,
          signal: suppliedBounds.signal,
        });
        if (
          !refPattern.test(bounds.requestRef) ||
          !(bounds.signal instanceof AbortSignal) ||
          !isDeepStrictEqual(request.startup, association.startup) ||
          !isDeepStrictEqual(request.recipient, association.recipient.recipient)
        )
          throw unavailable();
        assertParent();
        parentSignal = sourceSignal(parent);
        if (!(parentSignal instanceof AbortSignal)) throw unavailable();
        signal = AbortSignal.any([parentSignal, bounds.signal]);
        const originalDeadline = timestamp(bounds.deadline);
        const monotonicStart = performance.now(),
          wallStart = Date.now();
        const remaining = Math.min(5000, sourceRemaining(parent), originalDeadline - wallStart);
        if (!Number.isFinite(remaining) || remaining <= 0 || signal.aborted) throw unavailable();
        expiresAt = Math.min(originalDeadline, wallStart + remaining);
        monotonicEnd = monotonicStart + remaining;
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(
          onAbort,
          Math.max(0, Math.min(expiresAt - Date.now(), monotonicEnd - performance.now())),
        );
        current();
        if ((await trackFence(recheckSource(parent))) !== undefined) throw unavailable();
        current();
        await verifyExecutable(binaryPath, executableDigest, abort.signal);
        current();
        child = spawn(binaryPath, ["channel-material-client"], {
          env: {},
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        const owned = child;
        childExit = new Promise<void>((resolve) => {
          owned.once("close", () => resolve());
          owned.once("error", () => {
            failure = true;
            onAbort();
          });
        });
        owned.stdin.on("error", onAbort);
        owned.stdout.on("error", onAbort);
        owned.stderr.on("error", () => {
          failure = true;
          onAbort();
        });
        owned.stderr.resume(); // Never retain or publish native diagnostics/material.
        void childExit.then(() => {
          if (!abort.signal.aborted) {
            failure = true;
            onAbort();
          }
        });
        const incarnation = id();
        await send(kinds.bootstrap, {
          schemaVersion: 1,
          incarnation,
          configurationVersion,
          profileDigest,
          profile,
          address,
          deadline: new Date(expiresAt).toISOString(),
        });
        frame = await readMaterialFrameV1(owned.stdout, abort.signal);
        try {
          hello = envelope(frame);
          const data = closed(hello.message, [
            "incarnation",
            "configurationVersion",
            "profileDigest",
            "inspection",
            "expiresAt",
          ]);
          const inspection = closed(data.inspection, [
            "valid",
            "ownSPIFFEId",
            "peerSPIFFEId",
            "recipientSPIFFEId",
            "authenticatedAt",
            "expiresAt",
            "peerCertificateSha256",
          ]);
          const authenticatedAt = timestamp(inspection.authenticatedAt),
            nativeEnd = Math.min(timestamp(inspection.expiresAt), timestamp(data.expiresAt));
          if (
            frame.kind !== kinds.connected ||
            frame.payload.byteLength ||
            hello.requestDigest !== "" ||
            hello.deadline !== "" ||
            data.incarnation !== incarnation ||
            data.configurationVersion !== configurationVersion ||
            data.profileDigest !== profileDigest ||
            inspection.valid !== true ||
            inspection.ownSPIFFEId !== profile.ownSPIFFEId ||
            inspection.peerSPIFFEId !== profile.peerSPIFFEId ||
            inspection.recipientSPIFFEId !== profile.recipientSPIFFEId ||
            typeof inspection.peerCertificateSha256 !== "string" ||
            !hashPattern.test(inspection.peerCertificateSha256) ||
            authenticatedAt > Date.now() ||
            nativeEnd <= Date.now() ||
            timestamp(inspection.expiresAt) - authenticatedAt > 5000
          )
            throw unavailable();
          expiresAt = Math.min(expiresAt, nativeEnd);
          monotonicEnd = Math.min(monotonicEnd, performance.now() + expiresAt - Date.now());
          clearTimeout(timer);
          timer = setTimeout(
            onAbort,
            Math.max(0, Math.min(expiresAt - Date.now(), monotonicEnd - performance.now())),
          );
        } finally {
          frame.release();
        }
        current();
      })();
      try {
        await init;
        const connection: GatewayMaterialNativeClientConnectionV1 = Object.freeze({
          profile: policy,
          transport,
          request: request!,
          signal: abort.signal,
          assertCurrent: current,
          remainingMs() {
            current();
            return Math.max(0, Math.min(expiresAt - Date.now(), monotonicEnd - performance.now()));
          },
          close,
          withPayload(work: Parameters<GatewayMaterialNativeClientConnectionV1["withPayload"]>[0]) {
            if (used || abort.signal.aborted || typeof work !== "function")
              return Promise.reject(unavailable());
            used = true;
            const run = async () => {
              current();
              if (!child || !hello) throw unavailable();
              // This is only the existing Go wire digest. Runtime's separate
              // canonical request digest is computed by its registration owner.
              const event = {
                ...hello,
                requestDigest: digest(request),
                deadline: new Date(expiresAt).toISOString(),
                message: { requestRef: bounds.requestRef, request },
              };
              await send(kinds.request, event);
              frame = await readMaterialFrameV1(child.stdout, abort.signal, frame);
              let outcome: "delivered" | "denied" | "unavailable" | "recovery-required";
              try {
                const reply = envelope(frame),
                  header = closed(reply.message, [
                    "schemaVersion",
                    "purpose",
                    "use",
                    "requestRef",
                    "kind",
                  ]);
                if (
                  frame.kind !== kinds.result ||
                  ["connectionId", "exchangeId", "challenge", "requestDigest", "deadline"].some(
                    (key) => reply[key] !== event[key as keyof typeof event],
                  ) ||
                  header.schemaVersion !== 1 ||
                  header.purpose !== request.purpose ||
                  header.use !== request.use ||
                  header.requestRef !== bounds.requestRef
                )
                  throw unavailable();
                current();
                if (header.kind === "selected-bundle") {
                  if (!frame.payload.byteLength) throw unavailable();
                  const publicHeader: GatewayMaterialDeliveryHeaderV1 = Object.freeze({
                    schemaVersion: 1,
                    purpose: request.purpose,
                    use: request.use,
                    requestRef: bounds.requestRef,
                    kind: "selected-bundle",
                  });
                  // Await the actual callback, including late settlement. The
                  // original backing stays owned until this finally retires it.
                  const result: unknown = await work(publicHeader, frame.payload);
                  if (result !== undefined) throw unavailable();
                  current();
                  outcome = "delivered";
                } else {
                  if (
                    frame.payload.byteLength ||
                    !["denied", "unavailable", "recovery-required"].includes(String(header.kind))
                  )
                    throw unavailable();
                  outcome = header.kind as Exclude<typeof outcome, "delivered">;
                }
              } finally {
                frame.release();
              }
              current();
              await send(kinds.completed, { ...event, message: {} });
              // ACK is local pipe-write settlement only. Leave the pipe OPEN:
              // IDN checks currentness after this return, then calls close().
              return Object.freeze({ kind: outcome });
            };
            const running = run();
            operation = running;
            void running.catch(() => {
              failure = true;
              void close();
            });
            return running;
          },
        });
        originals.set(connection, current);
        current();
        return connection;
      } catch {
        failure = true;
        await close();
        throw unavailable();
      }
    },
  });
}
