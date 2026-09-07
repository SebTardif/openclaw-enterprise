import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  canonicalGatewayStartupValueV1,
  gatewayStartupCommandDigestV1,
  parseGatewayStartupCommandV1,
  type createGatewayStartupOwnerV1,
  type GatewayStartupCommandBoundsV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import type {
  createGatewayInstallationServiceAuthorityV1,
  GatewayInstallationNativeSourceV1,
  GatewayInstallationServiceAssociationV1,
  GatewayInstallationServiceCommandV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/installation-service";
import {
  closeNativeChild,
  nativeChildExit,
  verifyNativeExecutable,
} from "./native-child-lifetime.ts";
import {
  closedNativeObject,
  consumeNativeFrames,
  nativeDigest,
  nativeJson,
  nativePayload,
  nativeTimestamp,
  nativeUnavailable,
  writeNativeFrame,
} from "./runtime-authority-wire.ts";

/** Protected deployment selection. Parsing this data supplies no service grant. */
export interface GatewayStartupNativeProfileV1 {
  readonly schemaVersion: 1;
  readonly operationPolicy: "installation-gateway-startup-v1";
  readonly sourceRef: string;
  readonly sourceConfigurationDigest: string;
  readonly workloadApiSocketPath: string;
  readonly ownSPIFFEId: string;
  readonly peerSPIFFEId: string;
  readonly recipientRef: string;
  readonly recipientSPIFFEId: string;
  readonly trustDomain: string;
  readonly trustRootsRef: string;
  readonly trustBundleSha256: string;
  readonly verifierProfileRef: string;
  readonly nativeExecutableSha256: string;
  readonly transportProfileRef: "owned-child-stdio-installation-gateway-startup-v1";
  readonly limits: Readonly<{
    handshakeTimeoutMs: 3000;
    recheckIntervalMs: 1000;
    maxConnectionAgeMs: 30000;
    maxConnections: 1;
    requestTimeoutMs: 3000;
  }>;
}

/** The original registration participant consumes this local inspector inside
 * its existing owner unit. This object never crosses the child/TLS boundary. */
export interface GatewayStartupRegistrationNativeV1 {
  /** Lookup only an already-issued original object for the exact private call.
   * This cannot create one or change its method/body/signal correspondence. */
  originalFor(
    command: GatewayInstallationServiceCommandV1,
    bounds: GatewayStartupCommandBoundsV1,
  ): object | undefined;
  inspectOriginal(
    original: object,
    command: GatewayInstallationServiceCommandV1,
    bounds: GatewayStartupCommandBoundsV1,
  ):
    | Readonly<{
        /** Constructor expectation only. The original selected configuration
         * owner must map the actual native tuple to this record under currentness. */
        expectedSourceConfiguration: GatewayInstallationServiceAssociationV1["sourceConfiguration"];
        /** Exact original child profile/bootstrap inputs, bound by its checked
         * event profile digest and configuration version; not a mapped record. */
        nativeConfiguration: Readonly<{
          sourceRef: string;
          configurationVersion: number;
          sourceConfigurationDigest: string;
        }>;
        gatewaySpiffeId: string;
        controllerSpiffeId: string;
        commandDigest: string;
        operationProfile: "installation-gateway-startup-v1";
        transportProfile: "owned-child-stdio-installation-gateway-startup-v1";
        expiresAtMs: number;
        signal: AbortSignal;
        assertCurrent(): undefined;
      }>
    | undefined;
}

export interface GatewayStartupNativeServiceOptionsV1 {
  readonly binaryPath: string;
  readonly listenAddress: string;
  readonly configurationVersion: number;
  readonly profile: GatewayStartupNativeProfileV1;
  readonly association: GatewayInstallationServiceAssociationV1;
  /** Called exactly once during trusted construction. Install the actual
   * Runtime service/owner and original registration/currentness participants.
   * No caller, request or subsequent setter can select these dependencies. */
  readonly compose: (
    native: GatewayInstallationNativeSourceV1,
    registrationNative: GatewayStartupRegistrationNativeV1,
  ) => Readonly<{
    service: ReturnType<typeof createGatewayInstallationServiceAuthorityV1>;
    owner: ReturnType<typeof createGatewayStartupOwnerV1>;
  }>;
}

const id = () => randomBytes(16).toString("hex");
const idPattern = /^[0-9a-f]{32}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
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
const canonical = canonicalGatewayStartupValueV1;
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
type Event = Record<string, unknown> & {
  connectionId: string;
  exchangeId: string;
  requestDigest: string;
  deadline: string;
};
interface Exchange {
  readonly event: Event;
  readonly proof: object;
  readonly input: GatewayInstallationServiceCommandV1;
  readonly inputText: string;
  readonly bounds: GatewayStartupCommandBoundsV1;
  readonly abort: AbortController;
  readonly started: number;
  readonly budget: number;
  readonly timer: ReturnType<typeof setTimeout>;
  inspectedAt: number;
  acquired: boolean;
  released: boolean;
  terminal: boolean;
}

/** Owns only this factory's original Go child, pipe and connection. There is no
 * entrypoint accepting a decoded peer/context to construct native provenance.
 * The Runtime owner still performs every current grant and transaction check. */
export function createGatewayStartupNativeServiceV1(options: GatewayStartupNativeServiceOptionsV1) {
  const profile = freeze(JSON.parse(canonical(options.profile))) as GatewayStartupNativeProfileV1;
  const association = freeze(
    JSON.parse(canonical(options.association)),
  ) as GatewayInstallationServiceAssociationV1;
  const binaryPath = options.binaryPath,
    listenAddress = options.listenAddress;
  const configurationVersion = options.configurationVersion;
  if (
    profile.schemaVersion !== 1 ||
    profile.operationPolicy !== "installation-gateway-startup-v1" ||
    profile.transportProfileRef !== "owned-child-stdio-installation-gateway-startup-v1" ||
    profile.recipientSPIFFEId !== profile.ownSPIFFEId ||
    profile.ownSPIFFEId !== association.endpoints.controller.spiffeId ||
    profile.peerSPIFFEId !== association.endpoints.gateway.spiffeId ||
    profile.recipientRef !== association.endpoints.transportRecipientRef ||
    association.endpoints.transportRecipientRef !== association.endpoints.controller.serviceRef ||
    !Number.isSafeInteger(configurationVersion) ||
    configurationVersion < 1 ||
    canonical(profile.limits) !==
      canonical({
        handshakeTimeoutMs: 3000,
        recheckIntervalMs: 1000,
        maxConnectionAgeMs: 30000,
        maxConnections: 1,
        requestTimeoutMs: 3000,
      })
  )
    throw nativeUnavailable();
  const profileBytes = Buffer.from(canonical(profile));
  const profileDigest = nativeDigest(profileBytes);
  const incarnation = id();
  const lifetime = new AbortController();
  const proofs = new WeakMap<object, Exchange>();
  const requests = new Set<Promise<void>>();
  const resourceOwners = new Set<Exchange>();
  let active: Exchange | undefined;
  let connection:
    { id: string; deadline: string; inspectionText: string; expiry: number } | undefined;
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollWork: Promise<void> = Promise.resolve();
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<void> | undefined;
  let started = false,
    stopped = false,
    commandSequence = 1,
    eventSequence = 0,
    queued = 0;
  let writes: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  let stopFrames = () => {};
  let readyResolve: () => void = () => {},
    readyReject: () => void = () => {};
  let pending:
    | {
        exchange: Exchange;
        challenge: string;
        resolve: (value: Event) => void;
        reject: () => void;
        stop: () => void;
      }
    | undefined;
  const cancelled: { exchange: Exchange; challenge: string }[] = [];
  const match = (event: Event, exchange: Exchange) =>
    event.connectionId === exchange.event.connectionId &&
    event.exchangeId === exchange.event.exchangeId &&
    event.requestDigest === exchange.event.requestDigest &&
    event.deadline === exchange.event.deadline;
  const valid = (exchange: Exchange, bounds: GatewayStartupCommandBoundsV1) =>
    !stopped &&
    active === exchange &&
    !exchange.terminal &&
    !lifetime.signal.aborted &&
    !exchange.abort.signal.aborted &&
    bounds.signal === exchange.bounds.signal &&
    !bounds.signal.aborted &&
    bounds.requestRef === exchange.bounds.requestRef &&
    bounds.deadline === exchange.bounds.deadline &&
    connection?.id === exchange.event.connectionId &&
    Date.now() < Date.parse(bounds.deadline) &&
    performance.now() - exchange.started < exchange.budget &&
    Date.now() < connection.expiry;
  const requireCurrent = (exchange: Exchange): undefined => {
    if (!valid(exchange, exchange.bounds) || performance.now() - exchange.inspectedAt >= 1000)
      throw nativeUnavailable();
    return undefined;
  };
  const stopExchange = (exchange: Exchange) => {
    if (exchange.terminal) return;
    exchange.terminal = true;
    clearTimeout(exchange.timer);
    exchange.abort.abort();
    if (pending?.exchange === exchange) {
      const old = pending;
      pending = undefined;
      cancelled.push({ exchange, challenge: old.challenge });
      if (cancelled.length > 64) cancelled.shift();
      old.stop();
      old.reject();
    }
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    stopped = true;
    lifetime.abort();
    clearTimeout(connectionTimer);
    clearTimeout(pollTimer);
    readyReject();
    if (active) stopExchange(active);
    stopFrames();
    closing = (async () => {
      const native = child && exited ? closeNativeChild(child, exited) : Promise.resolve();
      native.catch(() => {});
      await Promise.allSettled([writes, pollWork, ...requests]);
      await native;
    })();
    return closing;
  };
  const fail = () => {
    void close().catch(() => {});
  };
  const send = (
    kind: "inspect" | "result" | "cancel",
    exchange: Exchange,
    challenge: string,
    payloadBase64: string,
    signal: AbortSignal,
  ): Promise<void> => {
    if (stopped || !child?.stdin || signal.aborted || queued >= 4)
      return Promise.reject(nativeUnavailable());
    queued++;
    const stream = child.stdin;
    const message = {
      schemaVersion: 1,
      kind,
      incarnation,
      sequence: ++commandSequence,
      connectionId: exchange.event.connectionId,
      exchangeId: exchange.event.exchangeId,
      requestDigest: exchange.event.requestDigest,
      challenge,
      payloadBase64,
    };
    const work = writes.then(() => writeNativeFrame(stream, message, signal));
    writes = work.catch(fail).finally(() => {
      queued--;
    });
    return work;
  };
  const parseInspection = (event: Event): string => {
    const peer = closedNativeObject(nativeJson(nativePayload(event.payloadBase64)), inspectionKeys);
    if (
      peer.valid !== true ||
      peer.ownSPIFFEId !== profile.ownSPIFFEId ||
      peer.peerSPIFFEId !== profile.peerSPIFFEId ||
      peer.recipientSPIFFEId !== profile.recipientSPIFFEId ||
      typeof peer.peerCertificateSha256 !== "string" ||
      !digestPattern.test(peer.peerCertificateSha256)
    )
      throw nativeUnavailable();
    const authenticatedAt = nativeTimestamp(peer.authenticatedAt),
      expiresAt = nativeTimestamp(peer.expiresAt);
    if (
      Date.parse(authenticatedAt) > Date.now() ||
      Date.parse(expiresAt) <= Date.now() ||
      Date.parse(expiresAt) - Date.parse(authenticatedAt) > 30000
    )
      throw nativeUnavailable();
    return canonical(peer);
  };
  const inspect = async (exchange: Exchange): Promise<void> => {
    if (!valid(exchange, exchange.bounds) || pending) throw nativeUnavailable();
    const challenge = id();
    let abort = () => {};
    const response = new Promise<Event>((resolve, reject) => {
      const stop = () => exchange.abort.signal.removeEventListener("abort", abort);
      abort = () => {
        if (pending?.challenge === challenge) {
          pending = undefined;
          cancelled.push({ exchange, challenge });
          if (cancelled.length > 64) cancelled.shift();
        }
        stop();
        reject(nativeUnavailable());
      };
      pending = { exchange, challenge, resolve, reject: () => reject(nativeUnavailable()), stop };
      exchange.abort.signal.addEventListener("abort", abort, { once: true });
      if (!valid(exchange, exchange.bounds)) abort();
    });
    response.catch(() => {});
    try {
      await send("inspect", exchange, challenge, "", exchange.abort.signal);
      const event = await response;
      if (
        !valid(exchange, exchange.bounds) ||
        parseInspection(event) !== connection?.inspectionText
      )
        throw nativeUnavailable();
      exchange.inspectedAt = performance.now();
    } finally {
      abort();
    }
  };
  const corresponds = (
    proof: object,
    input: GatewayInstallationServiceCommandV1,
    bounds: GatewayStartupCommandBoundsV1,
  ): Exchange | undefined => {
    const exchange = proofs.get(proof);
    if (!exchange || !valid(exchange, bounds)) return undefined;
    try {
      return canonical(parseGatewayStartupCommandV1(input)) === exchange.inputText
        ? exchange
        : undefined;
    } catch {
      return undefined;
    }
  };
  const native = Object.freeze<GatewayInstallationNativeSourceV1>({
    async inspect(proof, input, bounds) {
      const exchange = corresponds(proof, input, bounds);
      if (!exchange || exchange.acquired) return undefined;
      exchange.acquired = true;
      try {
        await inspect(exchange);
        requireCurrent(exchange);
        return Object.freeze({
          profile: "installation-gateway-startup-v1" as const,
          transport: "owned-child-stdio-installation-gateway-startup-v1" as const,
          association,
          signal: exchange.abort.signal,
          assertCurrent: () => {
            if (exchange.released) throw nativeUnavailable();
            return requireCurrent(exchange);
          },
          async close() {
            exchange.released = true;
          },
        });
      } catch {
        return undefined;
      }
    },
  });
  const registrationNative = Object.freeze<GatewayStartupRegistrationNativeV1>({
    originalFor(input, bounds) {
      if (
        !active ||
        !corresponds(active.proof, input, bounds) ||
        !active.acquired ||
        active.released
      )
        return undefined;
      try {
        requireCurrent(active);
        return active.proof;
      } catch {
        return undefined;
      }
    },
    inspectOriginal(original, input, bounds) {
      const exchange = corresponds(original, input, bounds);
      if (!exchange || !exchange.acquired || exchange.released) return undefined;
      try {
        requireCurrent(exchange);
        return Object.freeze({
          expectedSourceConfiguration: association.sourceConfiguration,
          nativeConfiguration: Object.freeze({
            sourceRef: profile.sourceRef,
            configurationVersion,
            sourceConfigurationDigest: profile.sourceConfigurationDigest,
          }),
          gatewaySpiffeId: profile.peerSPIFFEId,
          controllerSpiffeId: profile.ownSPIFFEId,
          commandDigest: gatewayStartupCommandDigestV1(exchange.input),
          operationProfile: "installation-gateway-startup-v1" as const,
          transportProfile: "owned-child-stdio-installation-gateway-startup-v1" as const,
          expiresAtMs: Math.min(connection!.expiry, Date.parse(exchange.bounds.deadline)),
          signal: exchange.abort.signal,
          assertCurrent: () => {
            if (exchange.released) throw nativeUnavailable();
            return requireCurrent(exchange);
          },
        });
      } catch {
        return undefined;
      }
    },
  });
  // One startup-owned composition point. Captured methods cannot be replaced by
  // request metadata or a later mutation of the originally supplied objects.
  const composed = options.compose(native, registrationNative);
  const enroll = composed.service.enroll.bind(composed.service);
  const execute = composed.owner.execute.bind(composed.owner);
  const poll = () => {
    if (stopped) return;
    pollTimer = setTimeout(() => {
      if (active && !active.terminal && !active.released && !pending)
        pollWork = inspect(active).catch(fail);
      void pollWork.finally(poll);
    }, 750);
  };
  const handle = async (exchange: Exchange) => {
    let enrollment: Awaited<ReturnType<typeof enroll>>;
    try {
      enrollment = await enroll(exchange.proof, exchange.input, exchange.bounds);
      if (!enrollment || !valid(exchange, exchange.bounds)) throw nativeUnavailable();
      const result = await execute(exchange.input, enrollment.invocation, exchange.bounds);
      if (!valid(exchange, exchange.bounds)) throw nativeUnavailable();
      // Give an already-owned poll its terminal result before the disclosure
      // challenge; never replace it with a cached positive inspection.
      await pollWork;
      await inspect(exchange);
      const allowed =
        exchange.input.kind === "consume-startup"
          ? ["consumed", "denied", "unavailable", "recovery-required"]
          : exchange.input.kind === "read-current"
            ? ["current", "denied", "unavailable"]
            : ["observed", "not-observed", "denied", "unavailable"];
      if (!allowed.includes(result.kind)) throw nativeUnavailable();
      const raw = Buffer.from(canonical(result));
      if (raw.length > 65536) throw nativeUnavailable();
      // Finish actual owner/native leases before allowing the next exchange.
      await enrollment.close();
      enrollment = undefined;
      if (!valid(exchange, exchange.bounds)) throw nativeUnavailable();
      resourceOwners.delete(exchange);
      await send("result", exchange, "", raw.toString("base64"), exchange.abort.signal);
    } catch {
      fail();
    } finally {
      if (enrollment) await enrollment.close();
      resourceOwners.delete(exchange);
    }
  };
  const onFrame = (bytes: Buffer) => {
    const raw = closedNativeObject(nativeJson(bytes), eventKeys);
    if (
      raw.schemaVersion !== 1 ||
      raw.incarnation !== incarnation ||
      raw.sequence !== eventSequence + 1 ||
      !Number.isSafeInteger(raw.sequence) ||
      raw.configurationVersion !== configurationVersion ||
      raw.profileDigest !== profileDigest ||
      [
        "kind",
        "connectionId",
        "exchangeId",
        "requestDigest",
        "challenge",
        "payloadBase64",
        "deadline",
      ].some((key) => typeof raw[key] !== "string")
    )
      throw nativeUnavailable();
    eventSequence++;
    const event = raw as Event;
    if (event.kind === "ready") {
      if (
        eventSequence !== 1 ||
        event.connectionId !== "" ||
        event.exchangeId !== "" ||
        event.requestDigest !== "" ||
        event.challenge !== "" ||
        event.deadline !== ""
      )
        throw nativeUnavailable();
      const value = closedNativeObject(nativeJson(nativePayload(event.payloadBase64)), ["address"]);
      if (value.address !== listenAddress) throw nativeUnavailable();
      readyResolve();
      return;
    }
    if (event.kind === "connected") {
      if (
        connection ||
        eventSequence !== 2 ||
        !idPattern.test(event.connectionId) ||
        event.exchangeId !== "" ||
        event.requestDigest !== "" ||
        event.challenge !== ""
      )
        throw nativeUnavailable();
      const deadline = nativeTimestamp(event.deadline),
        inspectionText = parseInspection(event);
      const expiry = Date.parse(deadline);
      const peer = JSON.parse(inspectionText) as { expiresAt: string };
      if (
        expiry !== Date.parse(peer.expiresAt) ||
        expiry <= Date.now() ||
        expiry - Date.now() > 30000
      )
        throw nativeUnavailable();
      connection = { id: event.connectionId, deadline, inspectionText, expiry };
      connectionTimer = setTimeout(fail, expiry - Date.now());
      poll();
      return;
    }
    if (event.kind === "closed") {
      if (
        !connection ||
        event.connectionId !== connection.id ||
        event.exchangeId !== "" ||
        event.requestDigest !== "" ||
        event.challenge !== "" ||
        event.payloadBase64 !== "" ||
        event.deadline !== connection.deadline
      )
        throw nativeUnavailable();
      fail();
      return;
    }
    if (
      !connection ||
      event.connectionId !== connection.id ||
      !idPattern.test(event.exchangeId) ||
      !digestPattern.test(event.requestDigest)
    )
      throw nativeUnavailable();
    nativeTimestamp(event.deadline);
    if (event.kind === "request") {
      if (active || resourceOwners.size || event.challenge !== "") throw nativeUnavailable();
      const bytes = nativePayload(event.payloadBase64);
      if (nativeDigest(bytes) !== event.requestDigest) throw nativeUnavailable();
      const request = closedNativeObject(nativeJson(bytes), [
        "schemaVersion",
        "method",
        "deadline",
        "operation",
      ]);
      const input = parseGatewayStartupCommandV1(request.operation);
      if (
        request.schemaVersion !== 1 ||
        request.method !== input.kind ||
        (input.kind !== "consume-startup" &&
          input.kind !== "read-current" &&
          input.kind !== "read-operation") ||
        Date.parse(nativeTimestamp(request.deadline)) < Date.parse(event.deadline)
      )
        throw nativeUnavailable();
      const budget = Math.min(
        3000,
        Date.parse(event.deadline) - Date.now(),
        connection.expiry - Date.now(),
      );
      if (budget <= 0) throw nativeUnavailable();
      const abort = new AbortController(),
        proof = Object.freeze({});
      const bounds = Object.freeze({
        requestRef: `native-gateway/${incarnation}/${event.exchangeId}`,
        deadline: event.deadline,
        signal: abort.signal,
      });
      const exchange: Exchange = {
        event,
        proof,
        input,
        inputText: canonical(input),
        bounds,
        abort,
        started: performance.now(),
        budget,
        timer: setTimeout(fail, budget),
        inspectedAt: -Infinity,
        acquired: false,
        released: false,
        terminal: false,
      };
      proofs.set(proof, exchange);
      active = exchange;
      resourceOwners.add(exchange);
      const work = handle(exchange);
      requests.add(work);
      void work.catch(fail).finally(() => requests.delete(work));
      return;
    }
    if (event.kind === "inspected") {
      const p = pending;
      if (p && match(event, p.exchange) && event.challenge === p.challenge) {
        pending = undefined;
        p.stop();
        p.resolve(event);
        return;
      }
      if (
        cancelled.some(
          (value) => match(event, value.exchange) && event.challenge === value.challenge,
        )
      )
        return;
      throw nativeUnavailable();
    }
    if (
      event.kind === "completed" &&
      active &&
      match(event, active) &&
      event.challenge === "" &&
      event.payloadBase64 === ""
    ) {
      stopExchange(active);
      active = undefined;
      return;
    }
    throw nativeUnavailable();
  };
  return Object.freeze({
    signal: lifetime.signal,
    close,
    async start(): Promise<
      Readonly<{ listenAddress: string; signal: AbortSignal; close: () => Promise<void> }>
    > {
      if (started || stopped) throw nativeUnavailable();
      started = true;
      const startup = AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]);
      const onAbort = () => fail();
      startup.addEventListener("abort", onAbort, { once: true });
      try {
        await verifyNativeExecutable(binaryPath, profile.nativeExecutableSha256, startup);
        if (startup.aborted) throw nativeUnavailable();
        const owned = spawn(binaryPath, ["serve"], {
          env: {},
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        });
        child = owned;
        exited = nativeChildExit(owned);
        owned.stdin.on("error", fail);
        void exited.then(fail);
        const ready = new Promise<void>((resolve, reject) => {
          readyResolve = resolve;
          readyReject = () => reject(nativeUnavailable());
        });
        ready.catch(() => {});
        stopFrames = consumeNativeFrames(owned.stdout, onFrame, fail);
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
            listenAddress,
          },
          startup,
        );
        await ready;
        if (startup.aborted || stopped) throw nativeUnavailable();
        return Object.freeze({ listenAddress, signal: lifetime.signal, close });
      } catch {
        await close();
        throw nativeUnavailable();
      } finally {
        startup.removeEventListener("abort", onAbort);
      }
    },
  });
}
