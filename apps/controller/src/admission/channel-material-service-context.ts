import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { GatewayMaterialDeliveryRequestV1 } from "@openclaw-enterprise/contracts/gateway-material-delivery-v1";
import {
  parseGatewayMaterialDeliveryRequestV1,
  type createGatewayMaterialDeliveryV1,
  type GatewayMaterialNativeSourceV1,
  type GatewayMaterialNativeLeaseV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/material-delivery";
import type { GatewayInstallationServiceAssociationV1 } from "@openclaw-enterprise/occ/gateway-startup-v1/installation-service";
import {
  canonicalGatewayStartupValueV1,
  type GatewayStartupCommandBoundsV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import {
  MATERIAL_FRAME_BYTES,
  MATERIAL_ENDPOINT_BYTES,
  materialFrameKinds as kinds,
  materialMetadataTextV1,
  createMaterialFrameV1,
  readMaterialFrameV1,
  writeMaterialFrameV1,
  assertMaterialFrameV1,
  type MaterialFrameV1,
  type MaterialFrameKindV1,
} from "@openclaw-enterprise/utils/native-material-wire";
import type { GatewayStartupNativeProfileV1 } from "./gateway-startup-service-context.ts";
import {
  closeNativeChild,
  nativeChildExit,
  verifyNativeExecutable,
} from "./native-child-lifetime.ts";
import {
  closedNativeObject,
  nativeDigest,
  nativeTimestamp,
  nativeUnavailable,
} from "./runtime-authority-wire.ts";

/** Protected configuration only; no parser or constructor can register a service. */
export interface ChannelMaterialNativeProfileV1 extends Omit<
  GatewayStartupNativeProfileV1,
  "operationPolicy" | "transportProfileRef" | "limits"
> {
  readonly operationPolicy: "installation-channel-material-v1";
  readonly transportProfileRef: "owned-child-stdio-installation-channel-material-v1";
  readonly limits: Readonly<{
    handshakeTimeoutMs: 3000;
    recheckIntervalMs: 1000;
    maxConnectionAgeMs: 5000;
    maxConnections: 1;
    requestTimeoutMs: 5000;
  }>;
}

/** Consumed only by the original same-unit selected registration/current owner.
 * Expected configuration is never relabeled as the actual native mapping. */
export interface ChannelMaterialRegistrationNativeV1 {
  originalFor(
    request: GatewayMaterialDeliveryRequestV1,
    bounds: GatewayStartupCommandBoundsV1,
  ): object | undefined;
  inspectOriginal(
    original: object,
    request: GatewayMaterialDeliveryRequestV1,
    bounds: GatewayStartupCommandBoundsV1,
  ):
    | Readonly<{
        expectedSourceConfiguration: GatewayInstallationServiceAssociationV1["sourceConfiguration"];
        nativeConfiguration: Readonly<{
          sourceRef: string;
          configurationVersion: number;
          sourceConfigurationDigest: string;
        }>;
        gatewaySpiffeId: string;
        controllerSpiffeId: string;
        requestDigest: string;
        operationProfile: "installation-channel-material-v1";
        transportProfile: "owned-child-stdio-installation-channel-material-v1";
        expiresAtMs: number;
        signal: AbortSignal;
        assertCurrent(): undefined;
      }>
    | undefined;
}
export interface ChannelMaterialNativeServiceOptionsV1 {
  readonly binaryPath: string;
  readonly listenAddress: string;
  readonly configurationVersion: number;
  readonly profile: ChannelMaterialNativeProfileV1;
  readonly association: GatewayInstallationServiceAssociationV1;
  /** Original protected owner supplies the subordinate startup deadline/signal.
   * A fresh connection cannot extend either or repair an expired consumed claim. */
  readonly deadline: string;
  readonly signal: AbortSignal;
  /** One immutable trusted composition. The actual current owner and CRD source
   * remain required; missing providers have no accepting fallback. */
  readonly compose: (
    native: GatewayMaterialNativeSourceV1,
    registrationNative: ChannelMaterialRegistrationNativeV1,
  ) => ReturnType<typeof createGatewayMaterialDeliveryV1>;
}
const text = materialMetadataTextV1;
const frozenCopy = <T>(input: T): T => {
  const value: T = JSON.parse(text(input));
  const freeze = (v: unknown): void => {
    if (v && typeof v === "object") {
      for (const x of Object.values(v)) freeze(x);
      Object.freeze(v);
    }
  };
  freeze(value);
  return value;
};
const id = () => randomBytes(16).toString("hex");
const isId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/u.test(value);
const digest = (value: unknown) => nativeDigest(Buffer.from(text(value)));
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
type Envelope = Record<string, unknown> & {
  connectionId: string;
  exchangeId: string;
  challenge: string;
  requestDigest: string;
  deadline: string;
};
interface Exchange {
  event: Envelope;
  request: GatewayMaterialDeliveryRequestV1;
  requestText: string;
  bounds: GatewayStartupCommandBoundsV1;
  proof: object;
  acquired: boolean;
  released: boolean;
  inspectedAt: number;
  sent: boolean;
}

/** Owns a separate one-call child/connection. Only the original pipe creates a
 * local proof. No decoded peer record, caller DTO or public handle can do so. */
export function createChannelMaterialNativeServiceV1(
  options: ChannelMaterialNativeServiceOptionsV1,
) {
  const profile = frozenCopy(options.profile),
    association = frozenCopy(options.association);
  const configurationVersion = options.configurationVersion,
    binaryPath = options.binaryPath,
    listenAddress = options.listenAddress;
  const originalSignal = options.signal,
    deadline = nativeTimestamp(options.deadline);
  if (
    !(originalSignal instanceof AbortSignal) ||
    originalSignal.aborted ||
    Date.parse(deadline) <= Date.now() ||
    profile.operationPolicy !== "installation-channel-material-v1" ||
    profile.transportProfileRef !== "owned-child-stdio-installation-channel-material-v1" ||
    profile.schemaVersion !== 1 ||
    profile.ownSPIFFEId !== association.endpoints.controller.spiffeId ||
    profile.peerSPIFFEId !== association.endpoints.gateway.spiffeId ||
    profile.recipientSPIFFEId !== profile.ownSPIFFEId ||
    profile.recipientRef !== association.endpoints.transportRecipientRef ||
    association.endpoints.transportRecipientRef !== association.endpoints.controller.serviceRef ||
    !Number.isSafeInteger(configurationVersion) ||
    configurationVersion < 1 ||
    canonicalGatewayStartupValueV1(profile.limits) !==
      canonicalGatewayStartupValueV1({
        handshakeTimeoutMs: 3000,
        recheckIntervalMs: 1000,
        maxConnectionAgeMs: 5000,
        maxConnections: 1,
        requestTimeoutMs: 5000,
      })
  )
    throw nativeUnavailable();
  const profileDigest = digest(profile),
    incarnation = id();
  const abort = new AbortController(),
    proofs = new WeakMap<object, Exchange>();
  let child: ReturnType<typeof spawn> | undefined, exited: Promise<void> | undefined;
  let startupWork:
    | Promise<Readonly<{ listenAddress: string; signal: AbortSignal; close: () => Promise<void> }>>
    | undefined;
  let cleanupWork: Promise<void> | undefined;
  let runTask: Promise<void> | undefined,
    childClose: Promise<void> | undefined,
    closing: Promise<void> | undefined;
  let started = false,
    stopped = false,
    active: Exchange | undefined;
  let inspectionText = "",
    nativeExpiry = 0,
    monotonicEnd = Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = () => {
    stopped = true;
    abort.abort();
    if (child && exited && !childClose) {
      childClose = closeNativeChild(child, exited);
      void childClose.catch(() => {});
    }
  };
  const originalAbort = () => {
    expire();
    void close().catch(() => {});
  };
  const valid = (exchange: Exchange, bounds = exchange.bounds) =>
    !stopped &&
    active === exchange &&
    !abort.signal.aborted &&
    !originalSignal.aborted &&
    bounds.signal === exchange.bounds.signal &&
    !bounds.signal.aborted &&
    bounds.deadline === exchange.bounds.deadline &&
    bounds.requestRef === exchange.bounds.requestRef &&
    Date.now() < Math.min(Date.parse(deadline), Date.parse(bounds.deadline), nativeExpiry) &&
    performance.now() < monotonicEnd;
  const assert = (exchange: Exchange): undefined => {
    if (!valid(exchange) || exchange.released || performance.now() - exchange.inspectedAt >= 1000)
      throw nativeUnavailable();
    return undefined;
  };
  const parseEnvelope = (frame: MaterialFrameV1): Envelope => {
    if (frame.payload.byteLength) throw nativeUnavailable();
    const value = closedNativeObject(frame.metadata, envelopeKeys);
    if (
      value.schemaVersion !== 1 ||
      value.sequence !== 1 ||
      !isId(value.connectionId) ||
      !isId(value.exchangeId) ||
      !isId(value.challenge) ||
      typeof value.requestDigest !== "string" ||
      typeof value.deadline !== "string"
    )
      throw nativeUnavailable();
    return value as Envelope;
  };
  const same = (value: Envelope, exchange: Exchange) =>
    value.connectionId === exchange.event.connectionId &&
    value.exchangeId === exchange.event.exchangeId &&
    value.requestDigest === exchange.event.requestDigest &&
    value.deadline === exchange.event.deadline;
  const parseInspection = (value: unknown): string => {
    const v = closedNativeObject(value, [
      "valid",
      "ownSPIFFEId",
      "peerSPIFFEId",
      "recipientSPIFFEId",
      "authenticatedAt",
      "expiresAt",
      "peerCertificateSha256",
    ]);
    const authenticatedAt = Date.parse(nativeTimestamp(v.authenticatedAt)),
      expiresAt = Date.parse(nativeTimestamp(v.expiresAt));
    if (
      v.valid !== true ||
      v.ownSPIFFEId !== profile.ownSPIFFEId ||
      v.peerSPIFFEId !== profile.peerSPIFFEId ||
      v.recipientSPIFFEId !== profile.recipientSPIFFEId ||
      typeof v.peerCertificateSha256 !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(v.peerCertificateSha256) ||
      authenticatedAt > Date.now() ||
      expiresAt <= Date.now() ||
      expiresAt - authenticatedAt > 5000
    )
      throw nativeUnavailable();
    return text(v);
  };
  const send = async (kind: MaterialFrameKindV1, metadata: unknown) => {
    if (!child?.stdin || stopped) throw nativeUnavailable();
    await writeMaterialFrameV1(child.stdin, createMaterialFrameV1(kind, metadata), abort.signal);
  };
  const inspect = async (exchange: Exchange) => {
    if (!valid(exchange) || !child?.stdout) throw nativeUnavailable();
    const challenge = id();
    await send(kinds.inspect, { ...exchange.event, challenge, message: {} });
    const frame = await readMaterialFrameV1(child.stdout, abort.signal);
    try {
      const event = parseEnvelope(frame);
      if (
        frame.kind !== kinds.inspected ||
        !same(event, exchange) ||
        event.challenge !== challenge ||
        parseInspection(event.message) !== inspectionText ||
        !valid(exchange)
      )
        throw nativeUnavailable();
      exchange.inspectedAt = performance.now();
    } finally {
      frame.release();
    }
  };
  const corresponds = (
    proof: object,
    request: GatewayMaterialDeliveryRequestV1,
    bounds: GatewayStartupCommandBoundsV1,
  ) => {
    const exchange = proofs.get(proof);
    if (!exchange || !valid(exchange, bounds)) return undefined;
    try {
      return text(parseGatewayMaterialDeliveryRequestV1(request)) === exchange.requestText
        ? exchange
        : undefined;
    } catch {
      return undefined;
    }
  };
  let service!: ReturnType<typeof createGatewayMaterialDeliveryV1>;
  const native = Object.freeze<GatewayMaterialNativeSourceV1>({
    async inspect(proof, request, bounds) {
      const exchange = corresponds(proof, request, bounds);
      if (!exchange || exchange.acquired) return undefined;
      exchange.acquired = true;
      try {
        await inspect(exchange);
        assert(exchange);
        const lease = Object.freeze<GatewayMaterialNativeLeaseV1>({
          profile: "installation-channel-material-v1",
          transport: "owned-child-stdio-installation-channel-material-v1",
          association,
          signal: abort.signal,
          assertCurrent: () => assert(exchange),
          remainingMs: () => {
            assert(exchange);
            return Math.min(
              monotonicEnd - performance.now(),
              nativeExpiry - Date.now(),
              Date.parse(bounds.deadline) - Date.now(),
            );
          },
          async disclose(header, payload, permit) {
            assert(exchange);
            if (exchange.sent || !child?.stdin || !child.stdout) throw nativeUnavailable();
            exchange.sent = true;
            // Finish/release control input before CRD encoding. No concurrent reader
            // allocates a third frame while source backing and output are live.
            await inspect(exchange);
            assert(exchange);
            const frame = createMaterialFrameV1(
              kinds.result,
              { ...exchange.event, message: header },
              payload.byteLength,
            );
            try {
              if (
                frame.payload.buffer.byteLength !== MATERIAL_FRAME_BYTES ||
                payload.backingByteLength + MATERIAL_FRAME_BYTES > MATERIAL_ENDPOINT_BYTES
              )
                throw nativeUnavailable();
              if (payload.encodeInto(frame.payload) !== undefined) throw nativeUnavailable();
              assertMaterialFrameV1(frame);
              assert(exchange);
              await service.confirmDisclosure(permit, lease, header, payload);
              assertMaterialFrameV1(frame);
              assert(exchange);
              // No await or external callback between consuming this exact permit
              // and submitting the original bytes to the owned native pipe.
              service.consumeDisclosure(permit, lease, header, payload);
              await writeMaterialFrameV1(child.stdin, frame, abort.signal);
              if (!valid(exchange)) throw nativeUnavailable();
              // The cleared output backing is now reused for the metadata-only
              // recipient-borrow settlement ACK. CRD backing stays held throughout.
              const completed = await readMaterialFrameV1(child.stdout, abort.signal, frame);
              try {
                const event = parseEnvelope(completed);
                if (
                  completed.kind !== kinds.completed ||
                  !same(event, exchange) ||
                  event.challenge !== exchange.event.challenge ||
                  text(event.message) !== "{}" ||
                  !valid(exchange)
                )
                  throw nativeUnavailable();
              } finally {
                completed.release();
              }
            } finally {
              frame.release();
            }
          },
          async close() {
            exchange.released = true;
          },
        });
        return lease;
      } catch {
        return undefined;
      }
    },
  });
  const registrationNative = Object.freeze<ChannelMaterialRegistrationNativeV1>({
    originalFor(request, bounds) {
      if (
        !active ||
        !active.acquired ||
        active.released ||
        !corresponds(active.proof, request, bounds)
      )
        return undefined;
      try {
        assert(active);
        return active.proof;
      } catch {
        return undefined;
      }
    },
    inspectOriginal(original, request, bounds) {
      const exchange = corresponds(original, request, bounds);
      if (!exchange || !exchange.acquired || exchange.released) return undefined;
      try {
        assert(exchange);
        return Object.freeze({
          expectedSourceConfiguration: association.sourceConfiguration,
          nativeConfiguration: Object.freeze({
            sourceRef: profile.sourceRef,
            configurationVersion,
            sourceConfigurationDigest: profile.sourceConfigurationDigest,
          }),
          gatewaySpiffeId: profile.peerSPIFFEId,
          controllerSpiffeId: profile.ownSPIFFEId,
          // Semantic registration digest explicitly uses the Runtime canonical encoder.
          // The separate wire digest already bound the escaped JSON representation.
          requestDigest: createHash("sha256")
            .update(canonicalGatewayStartupValueV1(exchange.request), "utf8")
            .digest("hex"),
          operationProfile: "installation-channel-material-v1" as const,
          transportProfile: "owned-child-stdio-installation-channel-material-v1" as const,
          expiresAtMs: Math.min(nativeExpiry, Date.parse(bounds.deadline)),
          signal: abort.signal,
          assertCurrent: () => assert(exchange),
        });
      } catch {
        return undefined;
      }
    },
  });
  try {
    service = options.compose(native, registrationNative);
  } catch {
    originalSignal.removeEventListener("abort", originalAbort);
    expire();
    throw nativeUnavailable();
  }
  const execute = service.execute.bind(service),
    closeService = service.close.bind(service);
  const confirm = service.confirmDisclosure.bind(service),
    consume = service.consumeDisclosure.bind(service);
  // Freeze captured methods even if the original composition object is mutable.
  service = Object.freeze({
    execute,
    close: closeService,
    confirmDisclosure: confirm,
    consumeDisclosure: consume,
  });
  const cleanup = (): Promise<void> => {
    if (!cleanupWork) {
      cleanupWork = (async () => {
        try {
          await Promise.allSettled([runTask, Promise.resolve().then(closeService)]);
          if (childClose) await childClose;
        } finally {
          clearTimeout(timer);
          originalSignal.removeEventListener("abort", originalAbort);
        }
      })();
    }
    return cleanupWork;
  };
  const close = (): Promise<void> => {
    if (!closing) {
      expire();
      closing = (async () => {
        // Join the actual public startup operation. Its failure path invokes
        // cleanup directly, so it never waits recursively for this close.
        await Promise.allSettled([startupWork]);
        await cleanup();
      })();
    }
    return closing;
  };
  originalSignal.addEventListener("abort", originalAbort, { once: true });
  if (originalSignal.aborted) originalAbort();
  return Object.freeze({
    signal: abort.signal,
    close,
    start(): Promise<
      Readonly<{ listenAddress: string; signal: AbortSignal; close: () => Promise<void> }>
    > {
      if (started || stopped) return Promise.reject(nativeUnavailable());
      started = true;
      startupWork = (async () => {
        monotonicEnd = performance.now() + Math.min(5000, Date.parse(deadline) - Date.now());
        timer = setTimeout(originalAbort, Math.max(0, monotonicEnd - performance.now()));
        try {
          await verifyNativeExecutable(binaryPath, profile.nativeExecutableSha256, abort.signal);
          if (stopped || abort.signal.aborted) throw nativeUnavailable();
          const owned = spawn(binaryPath, ["channel-material-serve"], {
            env: {},
            stdio: ["pipe", "pipe", "ignore"],
            windowsHide: true,
          });
          child = owned;
          exited = nativeChildExit(owned);
          owned.stdin.on("error", expire);
          owned.stdout.on("error", expire);
          void exited.then(expire);
          await writeMaterialFrameV1(
            owned.stdin,
            createMaterialFrameV1(kinds.bootstrap, {
              schemaVersion: 1,
              incarnation,
              configurationVersion,
              profileDigest,
              profile,
              address: listenAddress,
              deadline,
            }),
            abort.signal,
          );
          const ready = await readMaterialFrameV1(owned.stdout, abort.signal);
          try {
            const data = closedNativeObject(ready.metadata, [
              "schemaVersion",
              "incarnation",
              "configurationVersion",
              "profileDigest",
              "address",
            ]);
            if (
              ready.kind !== kinds.ready ||
              ready.payload.byteLength ||
              data.schemaVersion !== 1 ||
              data.incarnation !== incarnation ||
              data.configurationVersion !== configurationVersion ||
              data.profileDigest !== profileDigest ||
              data.address !== listenAddress
            )
              throw nativeUnavailable();
          } finally {
            ready.release();
          }
          runTask = (async () => {
            const connected = await readMaterialFrameV1(owned.stdout, abort.signal);
            let hello: Envelope;
            try {
              hello = parseEnvelope(connected);
              const data = closedNativeObject(hello.message, [
                "incarnation",
                "configurationVersion",
                "profileDigest",
                "inspection",
                "expiresAt",
              ]);
              if (
                connected.kind !== kinds.connected ||
                hello.requestDigest !== "" ||
                hello.deadline !== "" ||
                data.incarnation !== incarnation ||
                data.configurationVersion !== configurationVersion ||
                data.profileDigest !== profileDigest
              )
                throw nativeUnavailable();
              inspectionText = parseInspection(data.inspection);
              nativeExpiry = Math.min(
                Date.parse(nativeTimestamp(data.expiresAt)),
                Date.parse((JSON.parse(inspectionText) as { expiresAt: string }).expiresAt),
              );
              if (nativeExpiry <= Date.now() || nativeExpiry - Date.now() > 5000)
                throw nativeUnavailable();
            } finally {
              connected.release();
            }
            const frame = await readMaterialFrameV1(owned.stdout, abort.signal);
            let event: Envelope, request: GatewayMaterialDeliveryRequestV1, requestRef: string;
            try {
              event = parseEnvelope(frame);
              const body = closedNativeObject(event.message, ["requestRef", "request"]);
              request = parseGatewayMaterialDeliveryRequestV1(body.request);
              requestRef = body.requestRef as string;
              if (
                frame.kind !== kinds.request ||
                event.connectionId !== hello.connectionId ||
                event.exchangeId !== hello.exchangeId ||
                event.challenge !== hello.challenge ||
                digest(body.request) !== event.requestDigest ||
                typeof requestRef !== "string" ||
                !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/u.test(requestRef) ||
                Date.parse(nativeTimestamp(event.deadline)) <= Date.now() ||
                Date.parse(event.deadline) > Date.parse(deadline)
              )
                throw nativeUnavailable();
            } finally {
              frame.release();
            }
            const bounds = Object.freeze({
              requestRef,
              deadline: event.deadline,
              signal: abort.signal,
            });
            const exchange: Exchange = {
              event,
              request,
              requestText: text(request),
              bounds,
              proof: Object.freeze({}),
              acquired: false,
              released: false,
              inspectedAt: -Infinity,
              sent: false,
            };
            active = exchange;
            proofs.set(exchange.proof, exchange);
            const result = await execute(request, exchange.proof, bounds);
            // A refusal may return ahead of owned cleanup. Join it before any negative
            // header and never send a second response after disclosure began.
            await closeService();
            if (!exchange.sent && valid(exchange)) {
              if (!["denied", "unavailable", "recovery-required"].includes(result.kind))
                throw nativeUnavailable();
              await send(kinds.result, {
                ...event,
                message: {
                  schemaVersion: 1,
                  purpose: "read-selected-channel-material",
                  use: request.use,
                  requestRef,
                  kind: result.kind,
                },
              });
              const ack = await readMaterialFrameV1(owned.stdout, abort.signal);
              try {
                const complete = parseEnvelope(ack);
                if (
                  ack.kind !== kinds.completed ||
                  !same(complete, exchange) ||
                  complete.challenge !== event.challenge ||
                  text(complete.message) !== "{}"
                )
                  throw nativeUnavailable();
              } finally {
                ack.release();
              }
            }
            // The recipient retains this original connection through its final
            // post-borrow currentness check and then explicitly closes it. Join
            // that terminal native lifetime after Runtime/CRD cleanup, without
            // treating the acknowledgement as a fresh authority grant.
            await exited;
          })()
            .catch(() => {
              expire();
            })
            .finally(() => {
              expire();
              void close().catch(() => {});
            });
          return Object.freeze({ listenAddress, signal: abort.signal, close });
        } catch {
          expire();
          // An ordinary failed start owns cleanup even when its caller never
          // calls close. This helper does not join startupWork or call close.
          await cleanup();
          throw nativeUnavailable();
        }
      })();
      return startupWork;
    },
  });
}
