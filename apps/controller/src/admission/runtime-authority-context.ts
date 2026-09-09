import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  canonicalRuntimeAuthorityMutationV1,
  parseRuntimeAuthorityJsonV1,
  parseRuntimeAuthorityV1,
  parseRuntimeMutationResultV1,
  parseRuntimeEffectsV1,
  parseRuntimeEffectsResponseV1,
  type ComputeDriver,
  type ExactCreateEffectV1,
  type RuntimeObservationInputV1,
  type RuntimeAuthorityCallBoundsV1,
  type RuntimeAuthorityContextFactoryV1,
  type RuntimeAuthorityTrustedContextV1,
  type RuntimeAuthorityTransportBindingV1,
  type RuntimeAuthorityVerifiedServiceV1,
  type ExactAuthorityOperationV1,
  type BindRuntimeV1,
} from "@openclaw-enterprise/contracts";
import {
  canonicalRuntimeServiceTrust,
  RuntimeAuthorityService,
  type RuntimeServiceTrustService,
  type CurrentRuntimeServiceTrust,
  type PlatformStateStore,
} from "@openclaw-enterprise/occ";
import {
  closeNativeChild,
  nativeChildExit,
  verifyNativeExecutable,
} from "./runtime-authority-profile.ts";
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
import { connectSelectedComputeRuntimeObservations } from "../composition/driver-factories/compute.ts";

const id = () => randomBytes(16).toString("hex");
const idPattern = /^[0-9a-f]{32}$/;
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
type Event = Record<string, unknown> & {
  connectionId: string;
  exchangeId: string;
  requestDigest: string;
  deadline: string;
};
interface Exchange {
  readonly event: Event;
  readonly transport: object;
  readonly binding: RuntimeAuthorityTransportBindingV1;
  readonly abort: AbortController;
  readonly requestRef: string;
  readonly request: NativeOperation | undefined;
  readonly started: number;
  readonly remaining: number;
  readonly timer: ReturnType<typeof setTimeout>;
  closed: boolean;
}

type NativeOperation =
  | { readonly method: "readOperation"; readonly operation: ExactAuthorityOperationV1 }
  | { readonly method: "bind"; readonly operation: BindRuntimeV1 }
  | {
      readonly method: "discover";
      readonly operation: ExactCreateEffectV1;
      readonly requestRef: string;
    }
  | {
      readonly method: "observe";
      readonly operation: RuntimeObservationInputV1;
      readonly requestRef: string;
    };

// Matches the existing observation consumer's canonical input digest, retaining
// array order. The closed IFC parser runs first; a digest adds no authentication.
const observationDigest = (input: ExactCreateEffectV1 | RuntimeObservationInputV1) =>
  nativeDigest(
    Buffer.from(
      JSON.stringify(input, (_key, value) =>
        value === null || Array.isArray(value) || typeof value !== "object"
          ? value
          : Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            ),
      ),
    ),
  );

export interface NativeRuntimeReadbackOptions {
  readonly binaryPath: string;
  readonly listenAddress: string;
  readonly recipientRef: string;
  readonly serviceIdentityRef: string;
  readonly installationId: string;
  readonly state: PlatformStateStore;
  readonly trust: RuntimeServiceTrustService;
  readonly computeDriver?: ComputeDriver;
}

/** Actual accepting path. No callback or exported method accepts diagnostics,
 * JSON, a principal or an AdmittedCaller to mint a context. WeakMap keys are
 * created only while consuming the original pipe of this spawned child. */
export async function startNativeRuntimeReadback(options: NativeRuntimeReadbackOptions) {
  const lifetime = new AbortController();
  const startup = AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]);
  const initial = await options.trust.readCurrentRecord(options.serviceIdentityRef, startup);
  if (
    !initial ||
    initial.admission.configuration.installationId !== options.installationId ||
    initial.admission.configuration.serviceIdentityRef !== options.serviceIdentityRef ||
    initial.admission.configuration.role !== "lifecycle-authority" ||
    initial.admission.configuration.allowedScope.kind !== "agent" ||
    initial.admission.configuration.permittedRecipientRef !== options.recipientRef ||
    initial.admission.profile.recipientRef !== options.recipientRef ||
    startup.aborted
  )
    throw nativeUnavailable();
  const configuration = initial.admission.configuration;
  const profile = initial.admission.profile;
  if (
    profile.operationPolicy === "runtime-observation-read-v1" &&
    options.computeDriver === undefined
  )
    throw nativeUnavailable();
  const incarnation = id();
  const initialBinding = canonicalRuntimeServiceTrust(initial);
  const profileBytes = Buffer.from(canonicalRuntimeServiceTrust(profile));
  if (nativeDigest(profileBytes) !== configuration.serviceTrustProfileDigest)
    throw nativeUnavailable();
  await verifyNativeExecutable(options.binaryPath, profile.nativeExecutableSha256, startup);
  const child = spawn(options.binaryPath, ["serve"], {
    env: {},
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const exited = nativeChildExit(child);
  const transports = new WeakMap<object, Exchange>();
  const contexts = new WeakMap<RuntimeAuthorityTrustedContextV1, Exchange>();
  let active: Exchange | undefined;
  let commandSequence = 1,
    eventSequence = 0,
    stopped = false;
  let stopFrames = () => {};
  let closing: Promise<void> | undefined;
  let observations: ReturnType<typeof connectSelectedComputeRuntimeObservations> | undefined;
  let writes: Promise<void> = Promise.resolve();
  let queued = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollWork: Promise<void> = Promise.resolve();
  const requests = new Set<Promise<void>>();
  const registryReads = new Set<Promise<unknown>>();
  const operationRegistryReads = new Set<Promise<unknown>>();
  const cancelledChallenges: { exchange: Exchange; challenge: string }[] = [];
  const rememberCancelled = (exchange: Exchange, challenge: string) => {
    cancelledChallenges.push({ exchange, challenge });
    if (cancelledChallenges.length > 64) cancelledChallenges.shift();
  };
  let pending:
    | {
        exchange: Exchange;
        challenge: string;
        resolve: (event: Event) => void;
        reject: () => void;
        stop: () => void;
      }
    | undefined;
  let readyResolve: (address: string) => void = () => {};
  let readyReject: () => void = () => {};
  const ready = new Promise<string>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = () => reject(nativeUnavailable());
  });
  // Install a rejection observer before any asynchronous bootstrap write.
  ready.catch(() => {});
  const stopExchange = (exchange: Exchange) => {
    if (exchange.closed) return;
    exchange.closed = true;
    clearTimeout(exchange.timer);
    exchange.abort.abort();
    if (pending?.exchange === exchange) {
      const value = pending;
      pending = undefined;
      rememberCancelled(exchange, value.challenge);
      value.stop();
      value.reject();
    }
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    stopped = true;
    lifetime.abort();
    observations?.close();
    clearTimeout(pollTimer);
    readyReject();
    if (active) stopExchange(active);
    stopFrames();
    // Invalidate first, interrupt native I/O next, and then join the actual
    // bounded database work. No new admission can use this incarnation.
    closing = (async () => {
      const nativeExit = closeNativeChild(child, exited);
      nativeExit.catch(() => {});
      await Promise.allSettled([writes, ...requests, ...registryReads, pollWork]);
      await authority.joinPendingReadbacks();
      await nativeExit;
    })();
    return closing;
  };
  const fail = () => {
    void close().catch(() => {});
  };
  child.stdin.on("error", fail);
  exited.then(fail);
  const current = async (
    signal: AbortSignal,
    operationRead = false,
  ): Promise<Readonly<CurrentRuntimeServiceTrust>> => {
    if (stopped || signal.aborted) throw nativeUnavailable();
    const read = options.trust.readCurrentRecord(options.serviceIdentityRef, signal);
    registryReads.add(read);
    if (operationRead) operationRegistryReads.add(read);
    let record: Readonly<CurrentRuntimeServiceTrust> | undefined;
    try {
      record = await read;
    } finally {
      registryReads.delete(read);
      operationRegistryReads.delete(read);
    }
    if (
      !record ||
      signal.aborted ||
      stopped ||
      canonicalRuntimeServiceTrust(record) !== initialBinding
    ) {
      fail();
      throw nativeUnavailable();
    }
    return record;
  };
  const bounds = (exchange: Exchange, call: RuntimeAuthorityCallBoundsV1): boolean =>
    !stopped &&
    active === exchange &&
    !exchange.closed &&
    !exchange.abort.signal.aborted &&
    !call.signal.aborted &&
    call.requestRef === exchange.requestRef &&
    call.recipientRef === options.recipientRef &&
    call.deadline === exchange.event.deadline &&
    Date.now() < Date.parse(call.deadline) &&
    performance.now() - exchange.started < exchange.remaining;
  const command = (
    kind: "inspect" | "result" | "cancel",
    exchange: Exchange,
    challenge: string,
    payloadBase64: string,
    signal: AbortSignal,
  ): Promise<void> => {
    if (stopped || queued >= 4 || signal.aborted) return Promise.reject(nativeUnavailable());
    queued++;
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
    const operation = writes.then(() => writeNativeFrame(child.stdin, message, signal));
    writes = operation.catch(fail).finally(() => {
      queued--;
    });
    return operation;
  };
  const inspectNative = async (
    exchange: Exchange,
    call: RuntimeAuthorityCallBoundsV1,
  ): Promise<Readonly<RuntimeAuthorityVerifiedServiceV1>> => {
    if (!bounds(exchange, call) || pending) throw nativeUnavailable();
    await current(call.signal, true);
    if (!bounds(exchange, call)) throw nativeUnavailable();
    const challenge = id();
    let responseReject = () => {};
    const response = new Promise<Event>((resolve, reject) => {
      const abort = () => {
        if (pending?.challenge === challenge) {
          pending = undefined;
          rememberCancelled(exchange, challenge);
        }
        cleanup();
        reject(nativeUnavailable());
      };
      const cleanup = () => {
        call.signal.removeEventListener("abort", abort);
        exchange.abort.signal.removeEventListener("abort", abort);
      };
      responseReject = abort;
      pending = {
        exchange,
        challenge,
        resolve,
        reject: () => reject(nativeUnavailable()),
        stop: cleanup,
      };
      call.signal.addEventListener("abort", abort, { once: true });
      exchange.abort.signal.addEventListener("abort", abort, { once: true });
      if (!bounds(exchange, call)) abort();
    });
    response.catch(() => {});
    try {
      await command("inspect", exchange, challenge, "", call.signal);
      const event = await response;
      if (!bounds(exchange, call)) throw nativeUnavailable();
      const peer = closedNativeObject(
        nativeJson(nativePayload(event.payloadBase64)),
        inspectionKeys,
      );
      if (
        peer.valid !== true ||
        peer.ownSPIFFEId !== profile.ownSPIFFEId ||
        peer.peerSPIFFEId !== profile.peerSPIFFEId ||
        peer.recipientSPIFFEId !== profile.recipientSPIFFEId ||
        typeof peer.peerCertificateSha256 !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(peer.peerCertificateSha256)
      )
        throw nativeUnavailable();
      const authenticatedAt = nativeTimestamp(peer.authenticatedAt),
        expiresAt = nativeTimestamp(peer.expiresAt);
      if (Date.parse(authenticatedAt) > Date.now() || Date.parse(expiresAt) <= Date.now())
        throw nativeUnavailable();
      // Close the DB/native comparison interval with another current durable
      // lookup. Every caller invocation performs a new challenge; none is cached.
      await current(call.signal, true);
      if (!bounds(exchange, call)) throw nativeUnavailable();
      return Object.freeze({
        configuration,
        authenticatedAt,
        expiresAt,
        peerEvidenceRef: `native-peer/${exchange.event.connectionId}`,
        transportBinding: exchange.binding,
      });
    } finally {
      responseReject();
    }
  };
  const factory: RuntimeAuthorityContextFactoryV1<object> = {
    async authenticate(transport, expected, call) {
      const exchange = transports.get(transport);
      if (
        !exchange ||
        canonicalRuntimeServiceTrust(expected) !== canonicalRuntimeServiceTrust(configuration)
      )
        throw nativeUnavailable();
      await inspectNative(exchange, call);
      // The nominal assertion is confined to construction of this new local
      // object; the WeakMap, original child and fresh checks establish custody.
      const context = Object.freeze({ schemaVersion: 1 }) as RuntimeAuthorityTrustedContextV1;
      contexts.set(context, exchange);
      return context;
    },
    async inspect(context, call) {
      const exchange = contexts.get(context);
      if (!exchange) return undefined;
      try {
        return await inspectNative(exchange, call);
      } catch {
        return undefined;
      }
    },
  };
  const authority = new RuntimeAuthorityService({
    store: options.state,
    installationId: options.installationId,
    recipientRef: options.recipientRef,
    clock: { now: () => new Date(), monotonicMilliseconds: () => performance.now() },
    contextFactory: factory,
    requestBinding: {
      matchesRequest(method, input, call) {
        const exchange = contexts.get(call.context);
        // Correspondence is an additional denial check, not authentication or
        // current authority. Only this child's original parsed request and its
        // factory-owned context can match; no caller-supplied digest is trusted.
        if (!exchange || !bounds(exchange, call) || exchange.request?.method !== method)
          return false;
        try {
          if (exchange.request.method === "bind") {
            const parsed = parseRuntimeAuthorityV1("bind", input);
            // The existing mutation canonicalizer includes arrays and all effect
            // data, but deliberately excludes correlation. Compare that separately.
            return (
              parsed.requestRef === exchange.requestRef &&
              canonicalRuntimeAuthorityMutationV1(exchange.request.operation) ===
                canonicalRuntimeAuthorityMutationV1(parsed)
            );
          }
          const parsed = parseRuntimeAuthorityV1("exactOperation", input);
          return (
            canonicalRuntimeServiceTrust(exchange.request.operation) ===
            canonicalRuntimeServiceTrust(parsed)
          );
        } catch {
          return false;
        }
      },
    },
    currentTrust: {
      async readCurrent(serviceIdentityRef, signal) {
        if (serviceIdentityRef !== options.serviceIdentityRef) throw nativeUnavailable();
        const { admission } = await current(signal, true);
        return {
          configuration: admission.configuration,
          operationPolicy: admission.profile.operationPolicy,
        };
      },
    },
  });
  if (profile.operationPolicy === "runtime-observation-read-v1") {
    try {
      observations = connectSelectedComputeRuntimeObservations(options.computeDriver!, {
        clock: { now: () => new Date(), monotonicMilliseconds: () => performance.now() },
        signal: lifetime.signal,
        contextFactory: factory,
        async readAuthorization(method, input, call) {
          const exchange = contexts.get(call.context);
          if (!exchange || !bounds(exchange, call) || exchange.request?.method !== method)
            return undefined;
          const request = exchange.request;
          if (request.method !== "discover" && request.method !== "observe") return undefined;
          try {
            const parsed =
              method === "discover"
                ? parseRuntimeEffectsV1("exactCreate", input)
                : parseRuntimeEffectsV1("observationInput", input);
            const target = "effect" in parsed ? parsed.effect.target : parsed.target;
            const scope = configuration.allowedScope;
            const inputDigest = observationDigest(parsed);
            if (
              scope.kind !== "agent" ||
              target.component !== "harness" ||
              target.installationId !== configuration.installationId ||
              target.installationId !== scope.installationId ||
              target.namespaceId !== scope.namespaceId ||
              target.agentId !== scope.agentId ||
              inputDigest !== observationDigest(request.operation)
            )
              return undefined;
            const verified = await factory.inspect(call.context, call);
            if (!verified || !bounds(exchange, call)) return undefined;
            return Object.freeze({
              configuration,
              method,
              inputDigest,
              requestRef: call.requestRef,
              recipientRef: call.recipientRef,
              transportBinding: verified.transportBinding,
            });
          } catch {
            return undefined;
          }
        },
      });
    } catch {
      // No startup frames have been sent. Join the actual child even if the
      // selected observer already belongs to another listener.
      stopped = true;
      lifetime.abort();
      await closeNativeChild(child, exited);
      throw nativeUnavailable();
    }
  }
  const handle = async (exchange: Exchange, request: NativeOperation) => {
    const call = {
      requestRef: exchange.requestRef,
      recipientRef: options.recipientRef,
      deadline: exchange.event.deadline,
      signal: exchange.abort.signal,
    };
    try {
      const context = await factory.authenticate(exchange.transport, configuration, call);
      // The parsed original request is retained on this exchange. Neither a
      // second public message nor a callback can choose a different service call.
      const invoke = async () => {
        if (request.method === "bind")
          return parseRuntimeMutationResultV1(
            "bind",
            await authority.bind(request.operation, { ...call, context }),
          );
        if (request.method === "readOperation")
          return parseRuntimeAuthorityV1(
            "operationState",
            await authority.readOperation(request.operation, { ...call, context }),
          );
        if (!observations) throw nativeUnavailable();
        if (request.method === "discover")
          return parseRuntimeEffectsResponseV1(
            "discover",
            request.operation,
            await observations.effects.discover(request.operation, { ...call, context }),
          );
        return parseRuntimeEffectsResponseV1(
          "observe",
          request.operation,
          await observations.effects.observe(request.operation, { ...call, context }),
        );
      };
      const safe = await invoke();
      if (!bounds(exchange, call)) return;
      await inspectNative(exchange, call);
      if (!bounds(exchange, call)) return;
      await command(
        "result",
        exchange,
        "",
        Buffer.from(JSON.stringify(safe)).toString("base64"),
        call.signal,
      );
    } catch {
      if (!stopped && !exchange.closed) {
        await command(
          "cancel",
          exchange,
          "",
          "",
          AbortSignal.any([lifetime.signal, AbortSignal.timeout(250)]),
        ).catch(fail);
      }
    } finally {
      await authority.joinPendingReadbacks();
      await Promise.allSettled([...operationRegistryReads]);
    }
  };
  const match = (event: Event, exchange: Exchange): boolean =>
    event.connectionId === exchange.event.connectionId &&
    event.exchangeId === exchange.event.exchangeId &&
    event.requestDigest === exchange.event.requestDigest &&
    event.deadline === exchange.event.deadline;
  stopFrames = consumeNativeFrames(
    child.stdout,
    (bytes) => {
      const raw = closedNativeObject(nativeJson(bytes), eventKeys);
      if (
        raw.schemaVersion !== 1 ||
        raw.incarnation !== incarnation ||
        raw.sequence !== eventSequence + 1 ||
        !Number.isSafeInteger(raw.sequence) ||
        raw.configurationVersion !== configuration.configurationVersion ||
        raw.profileDigest !== configuration.serviceTrustProfileDigest ||
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
        const address = closedNativeObject(nativeJson(nativePayload(event.payloadBase64)), [
          "address",
        ]);
        if (address.address !== options.listenAddress) throw nativeUnavailable();
        readyResolve(options.listenAddress);
        return;
      }
      if (
        eventSequence <= 1 ||
        !idPattern.test(event.connectionId) ||
        !idPattern.test(event.exchangeId) ||
        !/^sha256:[0-9a-f]{64}$/.test(event.requestDigest)
      )
        throw nativeUnavailable();
      nativeTimestamp(event.deadline);
      if (event.kind === "request") {
        if (
          active ||
          requests.size !== 0 ||
          operationRegistryReads.size !== 0 ||
          event.challenge !== ""
        )
          throw nativeUnavailable();
        const requestBytes = nativePayload(event.payloadBase64);
        if (nativeDigest(requestBytes) !== event.requestDigest) throw nativeUnavailable();
        let operation: NativeOperation | undefined;
        try {
          const request = closedNativeObject(nativeJson(requestBytes), [
            "schemaVersion",
            "method",
            "deadline",
            "operation",
            ...(profile.operationPolicy === "runtime-observation-read-v1" ? ["requestRef"] : []),
          ]);
          const requestedDeadline = nativeTimestamp(request.deadline);
          if (
            request.schemaVersion !== 1 ||
            Date.parse(event.deadline) > Date.parse(requestedDeadline)
          )
            throw nativeUnavailable();
          if (
            (request.method === "discover" || request.method === "observe") &&
            profile.operationPolicy === "runtime-observation-read-v1"
          ) {
            if (
              typeof request.requestRef !== "string" ||
              !/^[A-Za-z0-9._:/-]{1,200}$/.test(request.requestRef)
            )
              throw nativeUnavailable();
            if (request.method === "discover") {
              const input = parseRuntimeEffectsV1("exactCreate", request.operation);
              if (input.effect.target.component !== "harness") throw nativeUnavailable();
              operation = { method: "discover", operation: input, requestRef: request.requestRef };
            } else {
              const input = parseRuntimeEffectsV1("observationInput", request.operation);
              if (input.kind !== "preallocated-candidate" || input.target.component !== "harness")
                throw nativeUnavailable();
              operation = { method: "observe", operation: input, requestRef: request.requestRef };
            }
          } else if (
            request.method === "readOperation" &&
            profile.operationPolicy !== "runtime-observation-read-v1"
          ) {
            operation = {
              method: "readOperation",
              operation: parseRuntimeAuthorityJsonV1(
                "exactOperation",
                JSON.stringify(request.operation),
              ),
            };
          } else if (
            request.method === "bind" &&
            profile.operationPolicy === "initial-harness-bind-v1"
          ) {
            const bind = parseRuntimeAuthorityJsonV1("bind", JSON.stringify(request.operation));
            if (
              bind.target.component !== "harness" ||
              bind.binding.provider !== "occ/kubernetes-gvisor" ||
              bind.binding.component !== "harness" ||
              bind.expectedBindingVersion !== null
            )
              throw nativeUnavailable();
            operation = { method: "bind", operation: bind };
          } else throw nativeUnavailable();
        } catch {
          /* Public input is rejected on its original exchange, without a context. */
        }
        const remaining = Math.max(0, Math.min(3000, Date.parse(event.deadline) - Date.now()));
        if (stopped) throw nativeUnavailable();
        const abort = new AbortController();
        const exchange: Exchange = {
          event,
          abort,
          transport: Object.freeze({}),
          binding: Object.freeze({}) as RuntimeAuthorityTransportBindingV1,
          requestRef:
            operation === undefined
              ? ""
              : "requestRef" in operation
                ? operation.requestRef
                : operation.operation.requestRef,
          request: operation,
          started: performance.now(),
          remaining,
          closed: false,
          timer: setTimeout(() => stopExchange(exchange), remaining),
        };
        active = exchange;
        let work: Promise<void>;
        if (operation === undefined || remaining <= 0) {
          work = command(
            "cancel",
            exchange,
            "",
            "",
            AbortSignal.any([lifetime.signal, AbortSignal.timeout(250)]),
          ).catch(fail);
        } else {
          transports.set(exchange.transport, exchange);
          work = handle(exchange, operation).catch(fail);
        }
        requests.add(work);
        work.finally(() => requests.delete(work));
        return;
      }
      if (event.kind === "inspected") {
        if (!idPattern.test(String(event.challenge))) throw nativeUnavailable();
        const waiting = pending;
        if (waiting && match(event, waiting.exchange) && event.challenge === waiting.challenge) {
          pending = undefined;
          waiting.stop();
          waiting.resolve(event);
          return;
        }
        // A reply already in flight when cancellation closed its exact original
        // exchange cannot revive it. All other unsolicited challenges fail closed.
        if (
          cancelledChallenges.some(
            (old) => old.challenge === event.challenge && match(event, old.exchange),
          )
        )
          return;
        throw nativeUnavailable();
      }
      if (event.kind !== "closed" && event.kind !== "completed") throw nativeUnavailable();
      if (!active || !match(event, active) || event.challenge !== "" || event.payloadBase64 !== "")
        throw nativeUnavailable();
      if (event.kind === "completed") return;
      stopExchange(active);
      active = undefined;
    },
    fail,
  );
  const poll = () => {
    if (stopped) return;
    pollTimer = setTimeout(() => {
      pollWork = current(AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]))
        .then(() => {})
        .catch(fail)
        .finally(poll);
    }, 1000);
  };
  const abortStartup = () => {
    readyReject();
    fail();
  };
  startup.addEventListener("abort", abortStartup, { once: true });
  try {
    await writeNativeFrame(
      child.stdin,
      {
        schemaVersion: 1,
        kind: "bootstrap",
        incarnation,
        sequence: 1,
        profileBase64: profileBytes.toString("base64"),
        profileDigest: configuration.serviceTrustProfileDigest,
        configurationVersion: configuration.configurationVersion,
        listenAddress: options.listenAddress,
      },
      startup,
    );
    const address = await ready;
    if (startup.aborted || stopped) throw nativeUnavailable();
    await current(startup);
    poll();
    const closed = exited.then(close);
    closed.catch(() => {});
    return Object.freeze({ address, close, closed });
  } catch {
    await close();
    throw nativeUnavailable();
  } finally {
    startup.removeEventListener("abort", abortStartup);
  }
}
