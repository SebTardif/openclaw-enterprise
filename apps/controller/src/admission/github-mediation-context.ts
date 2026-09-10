import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type {
  AuthorityCallV1,
  RuntimeAuthorityTrustedContextV1,
  RuntimeAuthorityTransportBindingV1,
  RuntimeAuthorityVerifiedServiceV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import {
  canonicalRuntimeServiceTrust,
  parseRuntimeServiceNativeProfile,
  type RuntimeServiceNativeProfile,
  type RuntimeServiceTrustService,
  type CurrentRuntimeServiceTrust,
} from "@openclaw-enterprise/occ";
import {
  GitHubMediationService,
  type GitHubMediationServiceOptions,
} from "@openclaw-enterprise/occ/github-mediation-v2/service";
import {
  decodeGitHubMediationRequest,
  encodeGitHubMediationMetadata,
  type DispatchOnce,
  type GitHubMediationVersion,
  type OpenRead,
} from "@openclaw-enterprise/occ/github-mediation-v2/wire";
import type {
  GitHubMediationLimits,
  GitHubMediationOperationOwner,
} from "@openclaw-enterprise/occ/github-mediation-v2/ports";
import {
  closeNativeChild,
  nativeChildExit,
  verifyNativeExecutable,
} from "./native-child-lifetime.ts";
import {
  closedNativeObject,
  nativeDigest,
  nativeJson,
  nativeUnavailable,
} from "./runtime-authority-wire.ts";

const id = () => randomBytes(16).toString("hex");
const nonce = /^[0-9a-f]{32}$/;
const digest = /^sha256:[0-9a-f]{64}$/;
const parentMetadataLimit = 32768;
const metadataLimit = 16384;
const maximumTime = 253402300799999;
const envelopeKeys = [
  "version",
  "kind",
  "incarnation",
  "sequence",
  "connection_id",
  "exchange_id",
  "request_sha256",
  "challenge",
  "metadata_base64",
  "deadline_ms",
];
const inspectionKeys = [
  "valid",
  "own_spiffe_id",
  "peer_spiffe_id",
  "recipient_spiffe_id",
  "authenticated_at_ms",
  "expires_at_ms",
  "peer_certificate_sha256",
];
type Envelope = {
  version: 1;
  kind: string;
  incarnation: string;
  sequence: number;
  connection_id: string;
  exchange_id: string;
  request_sha256: string;
  challenge: string;
  metadata_base64: string;
  deadline_ms: number;
};
type Exchange = {
  readonly event: Envelope;
  readonly call: AuthorityCallV1;
  readonly requestSequence: number;
  readonly cancellation: AbortController;
  readonly began: number;
  readonly remaining: number;
  readonly timer: ReturnType<typeof setTimeout>;
  replied: boolean;
  acknowledged: boolean;
  finished: boolean;
};
type Session = {
  readonly connectionId: string;
  readonly context: RuntimeAuthorityTrustedContextV1;
  readonly binding: RuntimeAuthorityTransportBindingV1;
  readonly cancellation: AbortController;
  readonly closed: Promise<void>;
  readonly resolveClosed: () => void;
  closing: boolean;
  retired: boolean;
  credentialWriteAttempted: boolean;
  active: Exchange | undefined;
};

/** Actual process assembly only. The registry is the existing durable service
 * admission owner. Original operation suppliers retain their own private Work,
 * dispatch and custody recognition; this owner supplies no operation grant. */
export interface GitHubMediationNativeDeployment {
  readonly listenPath: string;
  readonly peerUid: number;
  readonly trustedAncestorUids: readonly number[];
}
export type GitHubMediationNativeOptions<
  P = never,
  R = never,
  V extends GitHubMediationVersion = 2,
> = GitHubMediationNativeDeployment & {
  readonly binaryPath: string;
  readonly serviceIdentityRef: string;
  readonly installationId: string;
  readonly recipientRef: string;
  readonly trust: RuntimeServiceTrustService;
  readonly limits: GitHubMediationLimits;
  readonly protocolVersion?: V;
  readonly operations?: GitHubMediationOperationOwner<P, R, NoInfer<V>>;
  readonly operationsFactory?: {
    readonly create: (
      source: GitHubMediationNativeServiceSource<NoInfer<V>>,
    ) => GitHubMediationOperationOwner<P, R, NoInfer<V>>;
  };
} & (V extends 2 ? { readonly protocolVersion?: 2 } : { readonly protocolVersion: 3 }) &
  ([GitHubMediationVersion] extends [V] ? never : unknown);

/** Diagnostic fields accompany this exact privately enrolled object. Copying
 * them cannot recreate source membership or authenticate a Work association. */
export interface GitHubMediationNativeServiceSession {
  readonly context: RuntimeAuthorityTrustedContextV1;
  readonly transportBinding: RuntimeAuthorityTransportBindingV1;
  readonly configuration: RuntimeAuthorityVerifiedServiceV1["configuration"];
  readonly attachmentRef: string;
  readonly horizon: string;
  readonly signal: AbortSignal;
}

declare const preparedWriteBrand: unique symbol;
export type GitHubMediationPreparedTokenWrite = { readonly [preparedWriteBrand]: true };

/** The actual service connection lifetime is independent of message cancellation.
 * Protected attachment, assignment and original Work remain separate owners. */
export interface GitHubMediationNativeServiceSource<in out V extends GitHubMediationVersion = 2> {
  readonly acquire: (
    request: OpenRead<V>,
    call: AuthorityCallV1,
  ) => Promise<GitHubMediationNativeServiceSession | undefined>;
  inspect(
    original: GitHubMediationNativeServiceSession,
    call: AuthorityCallV1,
  ): Promise<
    Readonly<{
      context: RuntimeAuthorityTrustedContextV1;
      verified: RuntimeAuthorityVerifiedServiceV1;
      lifetime: AbortSignal;
      sessionRef: string;
    }>
  >;
  assertCurrent(original: GitHubMediationNativeServiceSession, call: AuthorityCallV1): void;
  release(original: GitHubMediationNativeServiceSession): Promise<void>;
  /** Native preparation authenticates only this fixed receiver/exchange. The
   * paired custody owner subsequently holds actual current State use through the
   * immediate write; a known historical commit alone cannot authorize bytes. */
  prepareCommittedToken(
    original: GitHubMediationNativeServiceSession,
    metadata: Uint8Array,
    call: AuthorityCallV1,
  ): Promise<GitHubMediationPreparedTokenWrite>;
  /** Submits bytes synchronously before its first asynchronous wait. Refuses a
   * busy output queue. After submission, settlement requires the original TLS
   * write ACK or confirmed receiver retirement, including on cancellation. The
   * caller retains current State use while this promise is pending; a shutdown
   * timeout alone cannot establish that confidential delivery stopped. */
  writePreparedCommittedToken(
    prepared: GitHubMediationPreparedTokenWrite,
    token: Uint8Array,
    call: AuthorityCallV1,
  ): Promise<void>;
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}
function payload(text: string, maximum: number): Buffer {
  if (text.length > Math.ceil(maximum / 3) * 4) throw nativeUnavailable();
  const bytes = Buffer.from(text, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== text) throw nativeUnavailable();
  return bytes;
}
function envelope(bytes: Uint8Array): Envelope {
  const value = closedNativeObject(nativeJson(Buffer.from(bytes)), envelopeKeys);
  if (
    value.version !== 1 ||
    typeof value.kind !== "string" ||
    typeof value.incarnation !== "string" ||
    !nonce.test(value.incarnation) ||
    !integer(value.sequence, 1, Number.MAX_SAFE_INTEGER) ||
    !integer(value.deadline_ms, 0, maximumTime) ||
    ["connection_id", "exchange_id", "request_sha256", "challenge", "metadata_base64"].some(
      (key) => typeof value[key] !== "string",
    )
  )
    throw nativeUnavailable();
  return value as Envelope;
}

function profileVersion(profile: Readonly<RuntimeServiceNativeProfile>): GitHubMediationVersion {
  if (
    profile.operationPolicy === "github-metadata-rpc-v2" &&
    profile.transportProfileRef === "owned-child-stdio-github-metadata-v2"
  )
    return 2;
  if (
    profile.operationPolicy === "github-git-read-rpc-v3" &&
    profile.transportProfileRef === "owned-child-stdio-github-git-read-v3"
  )
    return 3;
  throw nativeUnavailable();
}

function projectProfile(
  input: Readonly<RuntimeServiceNativeProfile>,
  deployment: GitHubMediationNativeDeployment,
) {
  const profile = parseRuntimeServiceNativeProfile(input);
  const protocolVersion = profileVersion(profile);
  if (
    profile.recipientSPIFFEId !== profile.ownSPIFFEId ||
    !integer(deployment.peerUid, 0, 0xffffffff) ||
    !Array.isArray(deployment.trustedAncestorUids) ||
    deployment.trustedAncestorUids.length < 1 ||
    deployment.trustedAncestorUids.length > 8 ||
    new Set(deployment.trustedAncestorUids).size !== deployment.trustedAncestorUids.length ||
    deployment.trustedAncestorUids.some((uid) => !integer(uid, 0, 0xffffffff))
  )
    throw nativeUnavailable();
  return {
    version: 1,
    ...(protocolVersion === 3 ? { protocol_version: 3 } : {}),
    workload_api_socket_path: profile.workloadApiSocketPath,
    own_spiffe_id: profile.ownSPIFFEId,
    peer_spiffe_id: profile.peerSPIFFEId,
    recipient_spiffe_id: profile.recipientSPIFFEId,
    trust_bundle_sha256: profile.trustBundleSha256,
    listen_path: deployment.listenPath,
    peer_uid: deployment.peerUid,
    trusted_ancestor_uids: [...deployment.trustedAncestorUids],
    handshake_timeout_ms: profile.limits.handshakeTimeoutMs,
    recheck_interval_ms: profile.limits.recheckIntervalMs,
    max_connection_age_ms: profile.limits.maxConnectionAgeMs,
    request_timeout_ms: profile.limits.requestTimeoutMs,
  };
}

/** Admission invokes the actual pure native parser with the same protected
 * deployment projection used by startup. This creates no Source, listener,
 * registration, context or grant. */
export async function validateNativeGitHubMediationProfile(
  binaryPath: string,
  profile: Readonly<RuntimeServiceNativeProfile>,
  deployment: GitHubMediationNativeDeployment,
  parentSignal: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(3000)]);
  const projected = projectProfile(profile, deployment);
  await verifyNativeExecutable(binaryPath, profile.nativeExecutableSha256, signal);
  if (signal.aborted) throw nativeUnavailable();
  const child = spawn(binaryPath, ["validate-profile"], {
    env: {},
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const exited = nativeChildExit(child);
  let buffered = Buffer.alloc(0);
  let failed = false;
  let ended = false;
  const onData = (chunk: Buffer) => {
    if (buffered.length + chunk.length > 256) {
      failed = true;
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
  };
  const abort = () => {
    void closeNativeChild(child, exited).catch(() => {});
  };
  const onError = () => {
    failed = true;
    abort();
  };
  child.stdout.on("data", onData);
  child.stdout.on("end", () => {
    ended = true;
  });
  child.stdout.on("error", onError);
  child.stdin.on("error", onError);
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    const bytes = Buffer.from(JSON.stringify(projected));
    const header = Buffer.alloc(8);
    header.writeUInt32BE(bytes.length);
    child.stdin.end(Buffer.concat([header, bytes]));
    await exited;
    if (
      signal.aborted ||
      failed ||
      !ended ||
      child.exitCode !== 0 ||
      buffered.length < 8 ||
      buffered.readUInt32BE(4) !== 0 ||
      buffered.readUInt32BE(0) !== buffered.length - 8
    )
      throw nativeUnavailable();
    const response = closedNativeObject(nativeJson(buffered.subarray(8)), ["version", "result"]);
    if (response.version !== 1 || response.result !== "valid") throw nativeUnavailable();
  } finally {
    signal.removeEventListener("abort", abort);
    child.stdout.off("data", onData);
    await closeNativeChild(child, exited);
  }
}

/** Starts the fixed GitHub native accepting executable. Opaque contexts are
 * created only from its original pipe and held connection. There is no exported
 * diagnostic-to-context, arbitrary sink, token writer or positive factory. */
export async function startGitHubMediationNative<
  P = never,
  R = never,
  V extends GitHubMediationVersion = 2,
>(input: GitHubMediationNativeOptions<P, R, V>) {
  const options = Object.freeze({
    ...input,
    trustedAncestorUids: Object.freeze([...input.trustedAncestorUids]),
  });
  if (options.operations && options.operationsFactory) throw nativeUnavailable();
  const selectedVersion = options.protocolVersion ?? 2;
  if (selectedVersion !== 2 && selectedVersion !== 3) throw nativeUnavailable();
  // The protected constructor selects one literal admitted profile. Request
  // metadata cannot select another operation owner, profile or ALPN.
  const protocolVersion = selectedVersion as V;
  const lifetime = new AbortController();
  const startup = AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]);
  const readRecord = options.trust.readCurrentRecord.bind(options.trust);
  const initial = await readRecord(options.serviceIdentityRef, startup);
  if (!initial || startup.aborted) throw nativeUnavailable();
  const configuration = initial.admission.configuration;
  const profile = initial.admission.profile;
  // These exact new strings are admitted by the existing registry's closed
  // profile extension. Older lifecycle profiles can never enter this owner.
  if (
    configuration.installationId !== options.installationId ||
    configuration.serviceIdentityRef !== options.serviceIdentityRef ||
    configuration.role !== "repository-issuer" ||
    configuration.allowedScope.kind !== "agent" ||
    configuration.permittedRecipientRef !== options.recipientRef ||
    profile.recipientRef !== options.recipientRef ||
    profileVersion(profile) !== protocolVersion ||
    profile.recipientSPIFFEId !== profile.ownSPIFFEId
  )
    throw nativeUnavailable();
  const originalRegistry = canonicalRuntimeServiceTrust(initial);
  const nativeProfile = projectProfile(profile, options);
  await verifyNativeExecutable(options.binaryPath, profile.nativeExecutableSha256, startup);
  if (startup.aborted) throw nativeUnavailable();
  const child = spawn(options.binaryPath, ["serve"], {
    env: {},
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const exited = nativeChildExit(child);
  const incarnation = id();
  const contexts = new WeakMap<RuntimeAuthorityTrustedContextV1, Session>();
  const originalServices = new WeakMap<
    GitHubMediationNativeServiceSession,
    {
      readonly owner: Session;
      readonly expires: number;
      readonly began: number;
      readonly remaining: number;
      readonly requestRef: string;
      readonly recipientRef: string;
      readonly cancellation: AbortController;
      latest: Exchange;
      released: boolean;
    }
  >();
  const serviceBySession = new WeakMap<Session, GitHubMediationNativeServiceSession>();
  const preparedTokenWrites = new WeakMap<
    GitHubMediationPreparedTokenWrite,
    {
      readonly held: GitHubMediationNativeServiceSession;
      readonly exchange: Exchange;
      readonly metadata: Buffer;
      readonly validUntil: number;
      readonly began: number;
      readonly remaining: number;
      used: boolean;
    }
  >();
  const requests = new Set<Promise<unknown>>();
  const registryReads = new Set<Promise<unknown>>();
  let buffered = Buffer.alloc(0);
  let session: Session | undefined;
  let deferredRequest: { readonly event: Envelope; readonly owner: Session } | undefined;
  const retiredResponses: {
    readonly kind: "inspection" | "written";
    readonly event: Envelope;
    readonly challenge: string;
  }[] = [];
  const retireResponse = (kind: "inspection" | "written", event: Envelope, challenge = "") => {
    retiredResponses.push({ kind, event, challenge });
    if (retiredResponses.length > 128) retiredResponses.shift();
  };
  const consumeRetiredResponse = (event: Envelope) => {
    const index = retiredResponses.findIndex(
      (held) =>
        held.kind === event.kind &&
        held.challenge === event.challenge &&
        held.event.connection_id === event.connection_id &&
        held.event.exchange_id === event.exchange_id &&
        held.event.request_sha256 === event.request_sha256 &&
        held.event.deadline_ms === event.deadline_ms,
    );
    if (index < 0) return false;
    if (event.kind === "written" && event.metadata_base64 !== "") return false;
    if (event.kind === "inspection") {
      // Drain only the original native response. Its diagnostics cannot restore
      // a retired context, resolve a call or authorize another exchange.
      closedNativeObject(nativeJson(payload(event.metadata_base64, metadataLimit)), inspectionKeys);
    }
    retiredResponses.splice(index, 1);
    return true;
  };
  let commandSequence = 0,
    eventSequence = 0,
    queuedWrites = 0;
  let stopped = false,
    readySeen = false;
  let writes = Promise.resolve();
  let closing: Promise<void> | undefined;
  let nativeClosing: Promise<void> | undefined;
  let broker: GitHubMediationService<P, R, V> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollWork = Promise.resolve();
  let pending:
    | {
        readonly exchange: Exchange;
        readonly challenge: string;
        readonly resolve: (value: Envelope) => void;
        readonly reject: () => void;
        readonly stop: () => void;
      }
    | undefined;
  let pendingWrite:
    | {
        readonly exchange: Exchange;
        readonly confidential: boolean;
        readonly retire: () => void;
        readonly resolve: () => void;
        readonly reject: () => void;
        readonly stop: () => void;
      }
    | undefined;
  let resolveReady: () => void = () => {};
  let rejectReady: () => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = () => reject(nativeUnavailable());
  });
  ready.catch(() => {});

  const stopExchange = (exchange: Exchange) => {
    exchange.cancellation.abort();
    clearTimeout(exchange.timer);
    if (pending?.exchange === exchange) {
      const old = pending;
      pending = undefined;
      retireResponse("inspection", old.exchange.event, old.challenge);
      old.stop();
      old.reject();
    }
    if (pendingWrite?.exchange === exchange) {
      const old = pendingWrite;
      if (!old.confidential) {
        pendingWrite = undefined;
        retireResponse("written", old.exchange.event);
        old.stop();
      }
      // A confidential write still owns its exact ACK until either that ACK
      // arrives or the original receiver has actually stopped writing.
      old.reject();
    }
  };
  const stopNative = (): Promise<void> => {
    if (nativeClosing) return nativeClosing;
    stopped = true;
    buffered.fill(0);
    buffered = Buffer.alloc(0);
    deferredRequest = undefined;
    retiredResponses.length = 0;
    // Publish shutdown ownership before abort listeners can re-enter it. The
    // bounded helper may reject; only exited proves actual process retirement.
    nativeClosing = closeNativeChild(child, exited);
    nativeClosing.catch(() => {});
    lifetime.abort();
    if (pollTimer) clearTimeout(pollTimer);
    rejectReady();
    if (session) {
      session.cancellation.abort();
      session.retired = true;
      const owner = session;
      void exited.then(owner.resolveClosed);
      if (session.active) stopExchange(session.active);
    }
    child.stdout.off("data", onData);
    child.stdout.off("end", onEnd);
    return nativeClosing;
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    const native = stopNative();
    closing = (async () => {
      const shutdown = broker?.stop();
      await Promise.allSettled([native, writes, pollWork, ...requests, ...registryReads, shutdown]);
      await broker?.join();
      await native;
    })();
    closing.catch(() => {});
    return closing;
  };
  const fail = () => {
    void close().catch(() => {});
  };
  const current = async (signal: AbortSignal): Promise<Readonly<CurrentRuntimeServiceTrust>> => {
    if (stopped || signal.aborted) throw nativeUnavailable();
    const read = readRecord(options.serviceIdentityRef, signal);
    registryReads.add(read);
    let record: Readonly<CurrentRuntimeServiceTrust> | undefined;
    try {
      record = await read;
    } finally {
      registryReads.delete(read);
    }
    if (stopped || signal.aborted) throw nativeUnavailable();
    if (!record || canonicalRuntimeServiceTrust(record) !== originalRegistry) {
      fail();
      throw nativeUnavailable();
    }
    return record;
  };
  const original = (call: AuthorityCallV1, hash?: string): Exchange => {
    const owner = contexts.get(call.context);
    const exchange = owner?.active;
    if (
      stopped ||
      !owner ||
      owner !== session ||
      owner.closing ||
      owner.retired ||
      !exchange ||
      exchange.finished ||
      call.signal.aborted ||
      exchange.cancellation.signal.aborted ||
      call.context !== exchange.call.context ||
      call.requestRef !== exchange.call.requestRef ||
      call.recipientRef !== exchange.call.recipientRef ||
      call.deadline !== exchange.call.deadline ||
      Date.now() >= exchange.event.deadline_ms ||
      performance.now() - exchange.began >= exchange.remaining ||
      (hash !== undefined && hash !== exchange.event.request_sha256)
    )
      throw nativeUnavailable();
    return exchange;
  };
  const write = (
    kind: "bootstrap" | "inspect" | "reply" | "close-session",
    event?: Envelope,
    challenge = "",
    metadata: Buffer = Buffer.alloc(0),
    secret: Buffer = Buffer.alloc(0),
    guard?: () => void,
    immediate = false,
  ): Promise<void> => {
    if (
      (immediate && queuedWrites !== 0) ||
      stopped ||
      queuedWrites >= 4 ||
      secret.length > metadataLimit ||
      (secret.length > 0 && kind !== "reply")
    )
      return Promise.reject(nativeUnavailable());
    queuedWrites++;
    let guardRejected = false;
    const execute = (resolve: () => void, reject: (reason: unknown) => void) => {
      if (stopped) {
        reject(nativeUnavailable());
        return;
      }
      try {
        guard?.();
      } catch {
        guardRejected = true;
        reject(nativeUnavailable());
        return;
      }
      const value: Envelope = {
        version: 1,
        kind,
        incarnation,
        sequence: commandSequence + 1,
        connection_id: event?.connection_id ?? "",
        exchange_id: kind === "close-session" ? "" : (event?.exchange_id ?? ""),
        request_sha256: kind === "close-session" ? "" : (event?.request_sha256 ?? ""),
        challenge,
        metadata_base64: metadata.toString("base64"),
        deadline_ms: kind === "close-session" ? 0 : (event?.deadline_ms ?? 0),
      };
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > parentMetadataLimit || commandSequence >= Number.MAX_SAFE_INTEGER) {
        reject(nativeUnavailable());
        return;
      }
      commandSequence++;
      const header = Buffer.alloc(8);
      header.writeUInt32BE(bytes.length);
      header.writeUInt32BE(secret.length, 4);
      const frame = Buffer.concat([header, bytes, secret]);
      try {
        child.stdin.write(frame, (error) => {
          frame.fill(0);
          if (error || stopped) reject(nativeUnavailable());
          else resolve();
        });
      } catch {
        frame.fill(0);
        reject(nativeUnavailable());
      }
    };
    const operation = immediate
      ? new Promise<void>(execute)
      : writes.then(() => new Promise<void>(execute));
    writes = operation
      .catch(() => {
        if (!guardRejected) fail();
      })
      .finally(() => {
        queuedWrites--;
      });
    return operation;
  };
  const inspect = async (
    call: AuthorityCallV1,
    hash: string,
  ): Promise<RuntimeAuthorityVerifiedServiceV1 | undefined> => {
    try {
      const exchange = original(call, hash);
      if (pending || pendingWrite) throw nativeUnavailable();
      await current(call.signal);
      original(call, hash);
      const challenge = id();
      let rejectResponse = () => {};
      const response = new Promise<Envelope>((resolve, reject) => {
        const abort = () => {
          if (pending?.challenge === challenge) {
            retireResponse("inspection", exchange.event, challenge);
            pending = undefined;
          }
          cleanup();
          reject(nativeUnavailable());
        };
        const cleanup = () => {
          call.signal.removeEventListener("abort", abort);
          exchange.cancellation.signal.removeEventListener("abort", abort);
        };
        rejectResponse = abort;
        pending = {
          exchange,
          challenge,
          resolve,
          reject: () => reject(nativeUnavailable()),
          stop: cleanup,
        };
        call.signal.addEventListener("abort", abort, { once: true });
        exchange.cancellation.signal.addEventListener("abort", abort, { once: true });
        if (call.signal.aborted || exchange.cancellation.signal.aborted) abort();
      });
      response.catch(() => {});
      try {
        await write("inspect", exchange.event, challenge);
        const event = await response;
        original(call, hash);
        const peer = closedNativeObject(
          nativeJson(payload(event.metadata_base64, metadataLimit)),
          inspectionKeys,
        );
        if (
          peer.valid !== true ||
          peer.own_spiffe_id !== profile.ownSPIFFEId ||
          peer.peer_spiffe_id !== profile.peerSPIFFEId ||
          peer.recipient_spiffe_id !== profile.recipientSPIFFEId ||
          !integer(peer.authenticated_at_ms, 0, maximumTime) ||
          !integer(peer.expires_at_ms, 1, maximumTime) ||
          peer.authenticated_at_ms > Date.now() ||
          peer.expires_at_ms <= Date.now() ||
          typeof peer.peer_certificate_sha256 !== "string" ||
          !digest.test(peer.peer_certificate_sha256)
        )
          throw nativeUnavailable();
        await current(call.signal);
        original(call, hash);
        return Object.freeze({
          configuration,
          authenticatedAt: new Date(peer.authenticated_at_ms).toISOString(),
          expiresAt: new Date(peer.expires_at_ms).toISOString(),
          peerEvidenceRef: `github-native/${exchange.event.connection_id}`,
          transportBinding: session!.binding,
        });
      } finally {
        rejectResponse();
      }
    } catch {
      return undefined;
    }
  };
  const closeSession = async (owner: Session) => {
    if (stopped) {
      void stopNative();
      await exited;
      return;
    }
    if (owner.retired) return;
    if (owner !== session) throw nativeUnavailable();
    if (!owner.closing) {
      owner.closing = true;
      owner.cancellation.abort();
      const exchange = owner.active;
      if (exchange) {
        stopExchange(exchange);
        await write("close-session", exchange.event);
      } else throw nativeUnavailable();
    }
    const timer = setTimeout(fail, profile.limits.requestTimeoutMs);
    try {
      await owner.closed;
    } finally {
      clearTimeout(timer);
    }
  };
  const sendReply = async (
    exchange: Exchange,
    fixed: Buffer,
    call: AuthorityCallV1,
    secret = Buffer.alloc(0),
    guard?: () => void,
    immediate = false,
  ) => {
    try {
      if (exchange.replied) throw nativeUnavailable();
      if (pending || pendingWrite) throw nativeUnavailable();
      const confidential = secret.length > 0;
      const owner = contexts.get(exchange.call.context);
      if (!owner) throw nativeUnavailable();
      let rejectWritten = () => {};
      const written = new Promise<void>((resolve, reject) => {
        let cancelled = false;
        let settled = false;
        const cleanup = () => {
          call.signal.removeEventListener("abort", abort);
          exchange.cancellation.signal.removeEventListener("abort", abort);
        };
        const rejectAfterRetirement = () => {
          if (settled) return;
          settled = true;
          if (pendingWrite?.exchange === exchange) {
            retireResponse("written", exchange.event);
            pendingWrite = undefined;
          }
          cleanup();
          reject(nativeUnavailable());
        };
        const abort = () => {
          if (settled || cancelled) return;
          cancelled = true;
          if (!confidential) {
            rejectAfterRetirement();
            return;
          }
          // Cancellation is not receiver retirement. Keep the exact pending
          // ACK and the caller's current-use responsibility until either the
          // native writer acknowledges, closes this connection, or exits.
          void closeSession(owner).then(rejectAfterRetirement, () => {
            fail();
            void exited.then(rejectAfterRetirement);
          });
        };
        rejectWritten = abort;
        pendingWrite = {
          exchange,
          confidential,
          retire: rejectAfterRetirement,
          resolve: () => {
            if (settled) return;
            settled = true;
            cleanup();
            if (cancelled) reject(nativeUnavailable());
            else resolve();
          },
          reject: abort,
          stop: cleanup,
        };
        call.signal.addEventListener("abort", abort, { once: true });
        exchange.cancellation.signal.addEventListener("abort", abort, { once: true });
        if (call.signal.aborted || exchange.cancellation.signal.aborted) abort();
      });
      written.catch(() => {});
      exchange.replied = true;
      try {
        await write(
          "reply",
          exchange.event,
          "",
          fixed,
          secret,
          () => {
            original(call);
            guard?.();
          },
          immediate,
        );
        await written;
      } catch {
        rejectWritten();
        // Pipe errors also leave delivery unknown until the receiver retires.
        // An unsuccessful bounded shutdown never releases this responsibility.
        if (confidential) await written.catch(() => {});
        throw nativeUnavailable();
      } finally {
        rejectWritten();
      }
    } finally {
      secret.fill(0);
    }
  };
  const heldService = (
    held: GitHubMediationNativeServiceSession,
    call: AuthorityCallV1,
    requireInspection: boolean,
  ) => {
    const retained = originalServices.get(held);
    if (
      !retained ||
      retained.released ||
      held.signal.aborted ||
      retained.owner !== session ||
      retained.owner.closing ||
      retained.owner.retired ||
      call.context !== held.context ||
      call.requestRef !== retained.requestRef ||
      call.recipientRef !== retained.recipientRef ||
      Date.now() >= retained.expires ||
      performance.now() - retained.began >= retained.remaining
    )
      throw nativeUnavailable();
    const exchange = original(call);
    if (requireInspection && retained.latest !== exchange) throw nativeUnavailable();
    return { retained, exchange };
  };
  const serviceSource: GitHubMediationNativeServiceSource<V> = Object.freeze({
    async acquire(request: OpenRead<V>, call: AuthorityCallV1) {
      try {
        const exchange = original(call);
        const owner = contexts.get(call.context)!;
        const captured = decodeGitHubMediationRequest(
          payload(exchange.event.metadata_base64, metadataLimit),
          protocolVersion,
        );
        if (
          !captured ||
          captured.method !== "open-read" ||
          canonicalRuntimeServiceTrust(captured) !== canonicalRuntimeServiceTrust(request)
        )
          return undefined;
        const verified = await inspect(call, exchange.event.request_sha256);
        if (!verified) return undefined;
        original(call, exchange.event.request_sha256);
        const existing = serviceBySession.get(owner);
        if (existing) {
          if (existing.attachmentRef !== captured.attachment_ref) return undefined;
          await serviceSource.inspect(existing, call);
          return existing;
        }
        const expires = Date.parse(verified.expiresAt);
        const remaining = expires - Date.now();
        if (remaining <= 0) return undefined;
        const cancellation = new AbortController();
        const held: GitHubMediationNativeServiceSession = Object.freeze({
          context: owner.context,
          transportBinding: owner.binding,
          configuration: verified.configuration,
          attachmentRef: captured.attachment_ref,
          horizon: verified.expiresAt,
          signal: AbortSignal.any([
            lifetime.signal,
            owner.cancellation.signal,
            cancellation.signal,
          ]),
        });
        originalServices.set(held, {
          owner,
          expires,
          began: performance.now(),
          remaining,
          cancellation,
          requestRef: captured.request_ref,
          recipientRef: call.recipientRef,
          latest: exchange,
          released: false,
        });
        serviceBySession.set(owner, held);
        return held;
      } catch {
        return undefined;
      }
    },
    async inspect(held: GitHubMediationNativeServiceSession, call: AuthorityCallV1) {
      const { retained, exchange } = heldService(held, call, false);
      const verified = await inspect(call, exchange.event.request_sha256);
      if (!verified) throw nativeUnavailable();
      heldService(held, call, false);
      if (
        verified.transportBinding !== held.transportBinding ||
        canonicalRuntimeServiceTrust(verified.configuration) !==
          canonicalRuntimeServiceTrust(held.configuration) ||
        verified.expiresAt !== held.horizon
      )
        throw nativeUnavailable();
      retained.latest = exchange;
      return Object.freeze({
        context: held.context,
        verified,
        lifetime: held.signal,
        sessionRef: `github-native/${retained.owner.connectionId}`,
      });
    },
    assertCurrent(held: GitHubMediationNativeServiceSession, call: AuthorityCallV1) {
      heldService(held, call, true);
    },
    async prepareCommittedToken(
      held: GitHubMediationNativeServiceSession,
      metadata: Uint8Array,
      call: AuthorityCallV1,
    ) {
      const { retained, exchange } = heldService(held, call, true);
      call = Object.freeze({ ...call, signal: AbortSignal.any([call.signal, held.signal]) });
      if (
        retained.owner.credentialWriteAttempted ||
        exchange.replied ||
        !(metadata instanceof Uint8Array) ||
        metadata.length < 1 ||
        metadata.length > metadataLimit
      )
        throw nativeUnavailable();
      const request = decodeGitHubMediationRequest(
        payload(exchange.event.metadata_base64, metadataLimit),
        protocolVersion,
      );
      const fixed = Buffer.from(metadata);
      const response = nativeJson(fixed) as DispatchOnce<V>;
      if (
        !request ||
        request.method !== "dispatch-read" ||
        !response ||
        response.ok !== true ||
        response.phase !== "dispatch-once" ||
        !Buffer.from(encodeGitHubMediationMetadata(response)).equals(fixed)
      )
        throw nativeUnavailable();
      for (const key of [
        "version",
        "sequence",
        "request_ref",
        "session_ref",
        "effect_ref",
        "work_binding_sha256",
        "request_sha256",
        "dns_binding_ref",
        "upstream_ipv4",
        "peer_certificate_sha256",
      ] as const)
        if (response[key] !== request[key]) throw nativeUnavailable();
      if (
        response.operation_until_ms > retained.expires ||
        response.valid_until_ms <= Date.now() ||
        response.valid_until_ms - response.server_time_ms > options.limits.maximumLeaseMilliseconds
      )
        throw nativeUnavailable();
      const began = performance.now();
      const remaining = response.valid_until_ms - Date.now();
      retained.owner.credentialWriteAttempted = true;
      await serviceSource.inspect(held, call);
      heldService(held, call, true);
      if (Date.now() >= response.valid_until_ms || performance.now() - began >= remaining)
        throw nativeUnavailable();
      const prepared = Object.freeze({}) as GitHubMediationPreparedTokenWrite;
      preparedTokenWrites.set(prepared, {
        held,
        exchange,
        metadata: fixed,
        validUntil: response.valid_until_ms,
        began,
        remaining,
        used: false,
      });
      return prepared;
    },
    writePreparedCommittedToken(
      prepared: GitHubMediationPreparedTokenWrite,
      token: Uint8Array,
      call: AuthorityCallV1,
    ): Promise<void> {
      const entry = preparedTokenWrites.get(prepared);
      if (!entry || entry.used) throw nativeUnavailable();
      const { exchange } = heldService(entry.held, call, true);
      if (
        exchange !== entry.exchange ||
        exchange.replied ||
        queuedWrites !== 0 ||
        Date.now() >= entry.validUntil ||
        performance.now() - entry.began >= entry.remaining ||
        !(token instanceof Uint8Array) ||
        token.length < 1 ||
        token.length > metadataLimit
      )
        throw nativeUnavailable();
      call = Object.freeze({ ...call, signal: AbortSignal.any([call.signal, entry.held.signal]) });
      const owned = Buffer.from(token);
      try {
        for (const byte of owned) if (byte < 0x21 || byte > 0x7e) throw nativeUnavailable();
        entry.used = true;
        // No await occurs between this synchronous ownership fence and the
        // private write's immediate pipe submission. The original custody
        // caller holds its real State current-use lease until this ACK settles.
        return sendReply(
          exchange,
          entry.metadata,
          call,
          owned,
          () => {
            heldService(entry.held, call, true);
            if (
              Date.now() >= entry.validUntil ||
              performance.now() - entry.began >= entry.remaining
            )
              throw nativeUnavailable();
          },
          true,
        );
      } catch {
        owned.fill(0);
        throw nativeUnavailable();
      }
    },
    async release(held: GitHubMediationNativeServiceSession) {
      const retained = originalServices.get(held);
      if (!retained) throw nativeUnavailable();
      retained.released = true;
      retained.cancellation.abort();
      // Release only this borrowed Work lifetime. The broker still owns its
      // terminal metadata write and final native connection close.
    },
  });
  try {
    // A protected startup builder receives this actual source once. It cannot
    // construct native contexts; only this child's authenticated frames enroll
    // them. The original Work/State/custody builders supply their own authority.
    const operations = options.operationsFactory
      ? options.operationsFactory.create(serviceSource)
      : options.operations;
    // Both constructor boundaries require the same literal V. Its exact native
    // profile was checked before spawning; this assertion preserves that generic
    // selection through TypeScript's conditional options type, never an owner
    // conversion from metadata to Git.
    broker = new GitHubMediationService<P, R, V>({
      protocolVersion,
      limits: options.limits,
      ...(operations === undefined ? {} : { operations }),
      transport: {
        inspect,
        async writeMetadata(metadata, call) {
          const exchange = original(call);
          if (exchange.replied || metadata.length === 0 || metadata.length > metadataLimit)
            throw nativeUnavailable();
          const fixed = Buffer.from(metadata);
          const reply = nativeJson(fixed) as Record<string, unknown> | null;
          if (
            !reply ||
            typeof reply !== "object" ||
            reply.request_ref !== exchange.call.requestRef ||
            reply.sequence !== exchange.requestSequence
          )
            throw nativeUnavailable();
          // The public broker transport carries metadata only. The constructor-
          // held custody receiver below owns the separate confidential path.
          await current(call.signal);
          original(call);
          await sendReply(exchange, fixed, call);
        },
        async close(call) {
          const owner = contexts.get(call.context);
          if (!owner) throw nativeUnavailable();
          await closeSession(owner);
        },
      },
    } as GitHubMediationServiceOptions<P, R, V>);
  } catch {
    await stopNative();
    throw nativeUnavailable();
  }

  const receive = (event: Envelope) => {
    if (stopped || event.incarnation !== incarnation || event.sequence !== ++eventSequence)
      throw nativeUnavailable();
    if (event.kind === "ready") {
      if (
        readySeen ||
        event.sequence !== 1 ||
        event.connection_id !== "" ||
        event.exchange_id !== "" ||
        event.request_sha256 !== "" ||
        event.challenge !== "" ||
        event.metadata_base64 !== "" ||
        event.deadline_ms !== 0
      )
        throw nativeUnavailable();
      readySeen = true;
      resolveReady();
      return;
    }
    if (!readySeen) throw nativeUnavailable();
    if (event.kind === "closed") {
      if (
        !nonce.test(event.connection_id) ||
        event.exchange_id !== "" ||
        event.request_sha256 !== "" ||
        event.challenge !== "" ||
        event.metadata_base64 !== "" ||
        event.deadline_ms !== 0
      )
        throw nativeUnavailable();
      // An authenticated peer may disconnect before sending a request; no
      // context was created and there is nothing to lend to a later session.
      if (!session) return;
      if (event.connection_id !== session.connectionId) throw nativeUnavailable();
      const owner = session;
      if (deferredRequest?.owner === owner) deferredRequest = undefined;
      owner.retired = true;
      owner.cancellation.abort();
      owner.resolveClosed();
      if (owner.active) {
        if (pendingWrite?.exchange === owner.active && pendingWrite.confidential)
          pendingWrite.retire();
        stopExchange(owner.active);
        const cleanup = broker!.close(owner.active.call);
        requests.add(cleanup);
        void cleanup.catch(fail).finally(() => requests.delete(cleanup));
      }
      session = undefined;
      return;
    }
    if ((event.kind === "written" || event.kind === "inspection") && consumeRetiredResponse(event))
      return;
    if (event.kind === "written") {
      const held = pendingWrite;
      if (
        !held ||
        event.challenge !== "" ||
        event.metadata_base64 !== "" ||
        event.connection_id !== held.exchange.event.connection_id ||
        event.exchange_id !== held.exchange.event.exchange_id ||
        event.request_sha256 !== held.exchange.event.request_sha256 ||
        event.deadline_ms !== held.exchange.event.deadline_ms
      )
        throw nativeUnavailable();
      pendingWrite = undefined;
      held.exchange.acknowledged = true;
      held.stop();
      held.resolve();
      return;
    }
    if (event.kind === "inspection") {
      const held = pending;
      if (
        !held ||
        event.challenge !== held.challenge ||
        event.connection_id !== held.exchange.event.connection_id ||
        event.exchange_id !== held.exchange.event.exchange_id ||
        event.request_sha256 !== held.exchange.event.request_sha256 ||
        event.deadline_ms !== held.exchange.event.deadline_ms
      )
        throw nativeUnavailable();
      pending = undefined;
      held.stop();
      held.resolve(event);
      return;
    }
    if (
      event.kind !== "request" ||
      event.challenge !== "" ||
      !nonce.test(event.connection_id) ||
      !nonce.test(event.exchange_id) ||
      !digest.test(event.request_sha256)
    )
      throw nativeUnavailable();
    receiveRequest(event);
  };
  function receiveRequest(event: Envelope) {
    if (session) {
      if (session.connectionId !== event.connection_id || session.closing || session.retired)
        throw nativeUnavailable();
      if (session.active && !session.active.finished) {
        if (deferredRequest || !session.active.acknowledged) throw nativeUnavailable();
        // The child may coalesce its completed-write ACK and the next request
        // into one pipe chunk. Keep one request until the broker's original
        // promise settles, without renewing its native deadline.
        deferredRequest = { event, owner: session };
        return;
      }
    }
    const metadata = payload(event.metadata_base64, metadataLimit);
    if (metadata.length === 0 || nativeDigest(metadata) !== event.request_sha256)
      throw nativeUnavailable();
    const request = nativeJson(metadata);
    const requestRef =
      request && typeof request === "object"
        ? (request as Record<string, unknown>).request_ref
        : undefined;
    const requestSequence =
      request && typeof request === "object"
        ? (request as Record<string, unknown>).sequence
        : undefined;
    if (
      typeof requestRef !== "string" ||
      !nonce.test(requestRef) ||
      !integer(requestSequence, 1, 0xffffffff)
    )
      throw nativeUnavailable();
    const remaining = event.deadline_ms - Date.now();
    if (event.deadline_ms < 1 || remaining > profile.limits.requestTimeoutMs)
      throw nativeUnavailable();
    if (remaining <= 0) {
      // A genuine native request may expire in the pipe or while waiting for
      // the prior broker promise. Retire only its connection without creating
      // a context or admitting an expired call; the listener remains available.
      if (session) void closeSession(session).catch(fail);
      else void write("close-session", event).catch(fail);
      return;
    }
    if (!session) {
      // The assertions are confined to new private keys. Only this child's
      // actual connection and original pipe can enroll them in the WeakMap.
      const context = Object.freeze({ schemaVersion: 1 }) as RuntimeAuthorityTrustedContextV1;
      const binding = Object.freeze({}) as RuntimeAuthorityTransportBindingV1;
      let resolveClosed: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      session = {
        connectionId: event.connection_id,
        context,
        binding,
        active: undefined,
        cancellation: new AbortController(),
        closing: false,
        retired: false,
        credentialWriteAttempted: false,
        closed,
        resolveClosed,
      };
      contexts.set(context, session);
    }
    const owner = session;
    const cancellation = new AbortController();
    const call: AuthorityCallV1 = Object.freeze({
      context: session.context,
      requestRef,
      recipientRef: options.recipientRef,
      deadline: new Date(event.deadline_ms).toISOString(),
      signal: AbortSignal.any([lifetime.signal, session.cancellation.signal, cancellation.signal]),
    });
    const timer = setTimeout(() => {
      void closeSession(owner).catch(fail);
    }, remaining);
    const exchange: Exchange = {
      event,
      call,
      requestSequence,
      cancellation,
      began: performance.now(),
      remaining,
      timer,
      replied: false,
      acknowledged: false,
      finished: false,
    };
    session.active = exchange;
    const work = broker!.handle(metadata, call);
    requests.add(work);
    void work
      .catch(() => closeSession(owner))
      .catch(fail)
      .finally(() => {
        exchange.finished = true;
        clearTimeout(timer);
        requests.delete(work);
        if (deferredRequest?.owner === owner && owner.active === exchange) {
          const next = deferredRequest.event;
          deferredRequest = undefined;
          if (!stopped && !owner.closing && !owner.retired && session === owner) {
            try {
              receiveRequest(next);
            } catch {
              fail();
            }
          }
        }
      });
  }
  function onData(chunk: Buffer) {
    try {
      if (stopped || buffered.length + chunk.length > 2 * (parentMetadataLimit + 8))
        throw nativeUnavailable();
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 8) {
        const size = buffered.readUInt32BE(0),
          secretSize = buffered.readUInt32BE(4);
        if (size < 1 || size > parentMetadataLimit || secretSize !== 0) throw nativeUnavailable();
        if (buffered.length < size + 8) return;
        const frame = buffered.subarray(8, 8 + size);
        buffered = buffered.subarray(8 + size);
        receive(envelope(frame));
      }
    } catch {
      fail();
    }
  }
  function onEnd() {
    fail();
  }
  child.stdout.on("data", onData);
  child.stdout.on("end", onEnd);
  child.stdout.on("error", fail);
  child.stdin.on("error", fail);
  exited.then(fail);
  const poll = () => {
    if (stopped) return;
    pollWork = current(AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]))
      .then(() => {
        if (!stopped) pollTimer = setTimeout(poll, profile.limits.recheckIntervalMs);
      })
      .catch(fail);
  };
  try {
    await write("bootstrap", undefined, "", Buffer.from(JSON.stringify(nativeProfile)));
    const abort = () => rejectReady();
    startup.addEventListener("abort", abort, { once: true });
    try {
      if (startup.aborted) rejectReady();
      await ready;
    } finally {
      startup.removeEventListener("abort", abort);
    }
    await current(startup);
    poll();
    return Object.freeze({ close });
  } catch {
    await close();
    throw nativeUnavailable();
  }
}
