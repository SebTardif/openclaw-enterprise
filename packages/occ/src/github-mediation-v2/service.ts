import { createHash, randomBytes } from "node:crypto";
import type {
  AuthorityCallV1,
  RuntimeAuthorityVerifiedServiceV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import { parseRuntimeAuthorityV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import { canonicalRuntimeServiceTrust } from "../runtime-authority/service-trust-schema.ts";
import type {
  GitHubMediationLimits,
  GitHubMediationOperationOwner,
  GitHubMediationOutcome,
  GitHubMediationPreparation,
  GitHubMediationTransportOwner,
} from "./ports.ts";
import {
  decodeGitHubMediationRequest,
  encodeGitHubMediationMetadata,
  METADATA_LIMIT,
  type CheckRead,
  type CompleteRead,
  type DispatchRead,
  type GitHubMediationBinding,
  type GitHubMediationReply,
  type GitHubMediationRequest,
  type GitHubMediationTimes,
  type GitHubMediationVersion,
  type OpenRead,
  type Refused,
} from "./wire.ts";

import {
  githubMediationClockContinuous,
  githubMediationMonotonicDeadline,
  sampleGitHubMediationClock,
  type GitHubMediationClockSample,
} from "./clock.ts";

const MAX_TIME = 253402300799999;
const reference = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}(?![\s\S])/;
const digest = /^sha256:[0-9a-f]{64}(?![\s\S])/;
const unavailable = () => new Error("GitHub mediation unavailable.");
const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
type Identity = Readonly<{ binding: object; configuration: string; expires: number }>;
type Session<P, R, V extends GitHubMediationVersion> = {
  readonly context: AuthorityCallV1["context"];
  readonly identity: Identity;
  readonly request: OpenRead<V>;
  readonly cancellation: AbortController;
  readonly began: number;
  readonly clock: GitHubMediationClockSample;
  readonly identityMono: number;
  call: AuthorityCallV1;
  phase: "opening" | "opened" | "dispatching" | "dispatched" | "terminal";
  sequence: number;
  binding?: Omit<GitHubMediationBinding<V>, "sequence">;
  prepared?: GitHubMediationPreparation<P>;
  release?: R;
  releaseRef?: string;
  operationUntil?: number;
  operationMono?: number;
  leaseUntil: number;
  leaseMono: number;
  dispatchAttempted: boolean;
  outcome: GitHubMediationOutcome;
  busy: boolean;
  closing: boolean;
  closeWork?: Promise<void>;
  settlement?: Promise<"recorded" | "unavailable">;
  timer?: ReturnType<typeof setTimeout>;
};

export type GitHubMediationServiceOptions<
  P = never,
  R = never,
  V extends GitHubMediationVersion = 2,
> = {
  readonly transport: GitHubMediationTransportOwner;
  readonly limits: GitHubMediationLimits;
  readonly protocolVersion?: V;
  readonly operations?: GitHubMediationOperationOwner<P, R, NoInfer<V>>;
} & (V extends 2 ? { readonly protocolVersion?: 2 } : { readonly protocolVersion: 3 }) &
  // One constructor selects one literal profile; an owner type covering more
  // versions does not replace that explicit deployment selection.
  ([GitHubMediationVersion] extends [V] ? never : unknown);

/** One native connection owns one immutable request and one possible dispatch.
 * This service grants no authority itself. Missing original operation suppliers
 * explicitly refuse; contexts come only from the native accepting owner. */
export class GitHubMediationService<P = never, R = never, V extends GitHubMediationVersion = 2> {
  private readonly version: V;
  private readonly transport: GitHubMediationTransportOwner;
  private readonly operations?: GitHubMediationOperationOwner<P, R, V>;
  private readonly limits: GitHubMediationLimits;
  private readonly sessions = new WeakMap<object, Session<P, R, V>>();
  private readonly contexts = new WeakMap<object, Session<P, R, V>>();
  private readonly active = new Set<Session<P, R, V>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly pendingContexts = new Map<object, AbortController>();
  private readonly openingContexts = new Set<object>();
  private stopping = false;

  constructor(options: GitHubMediationServiceOptions<P, R, V>) {
    const version = options.protocolVersion ?? 2;
    if (version !== 2 && version !== 3) throw unavailable();
    this.version = version as V;
    const limits = { ...options.limits };
    for (const key of [
      "maximumSessions",
      "maximumCallMilliseconds",
      "maximumOperationMilliseconds",
      "maximumLeaseMilliseconds",
    ] as const) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw unavailable();
    }
    if (
      !Number.isSafeInteger(limits.clockAllowanceMilliseconds) ||
      limits.clockAllowanceMilliseconds < 0 ||
      limits.maximumLeaseMilliseconds > limits.maximumOperationMilliseconds ||
      limits.maximumCallMilliseconds > limits.maximumOperationMilliseconds ||
      limits.maximumOperationMilliseconds > 0x7fffffff
    )
      throw unavailable();
    this.limits = Object.freeze(limits);
    // Capture the original methods/receivers once; later property replacement
    // cannot replace an enrolled transport or authority/custody participant.
    this.transport = Object.freeze({
      inspect: options.transport.inspect.bind(options.transport),
      writeMetadata: options.transport.writeMetadata.bind(options.transport),
      close: options.transport.close.bind(options.transport),
    });
    const owner = options.operations;
    if (owner)
      this.operations = Object.freeze({
        prepare: owner.prepare.bind(owner),
        dispatch: owner.dispatch.bind(owner),
        check: owner.check.bind(owner),
        writeRelease: owner.writeRelease.bind(owner),
        settle: owner.settle.bind(owner),
      });
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  private snapshotCall(input: AuthorityCallV1): AuthorityCallV1 {
    const { context, signal, requestRef, recipientRef, deadline } = input;
    if (
      typeof requestRef !== "string" ||
      typeof recipientRef !== "string" ||
      typeof deadline !== "string"
    )
      throw unavailable();
    const end = Date.parse(deadline);
    if (
      !context ||
      typeof context !== "object" ||
      !(signal instanceof AbortSignal) ||
      !reference.test(requestRef) ||
      !reference.test(recipientRef) ||
      !Number.isFinite(end) ||
      new Date(end).toISOString() !== deadline ||
      end <= Date.now() ||
      signal.aborted
    )
      throw unavailable();
    return Object.freeze({ context, signal, requestRef, recipientRef, deadline });
  }
  private identity(
    value: RuntimeAuthorityVerifiedServiceV1 | undefined,
    call: AuthorityCallV1,
  ): Identity {
    if (!value || !value.transportBinding || typeof value.transportBinding !== "object")
      throw unavailable();
    const configuration = parseRuntimeAuthorityV1("serviceTrust", value.configuration);
    const start = Date.parse(value.authenticatedAt),
      expires = Date.parse(value.expiresAt);
    if (
      configuration.permittedRecipientRef !== call.recipientRef ||
      !Number.isFinite(start) ||
      !Number.isFinite(expires) ||
      start > Date.now() + this.limits.clockAllowanceMilliseconds ||
      expires <= Date.now() + this.limits.clockAllowanceMilliseconds
    )
      throw unavailable();
    return Object.freeze({
      binding: value.transportBinding,
      configuration: canonicalRuntimeServiceTrust(configuration),
      expires,
    });
  }
  private async inspect(
    call: AuthorityCallV1,
    hash: string,
    session?: Session<P, R, V>,
  ): Promise<Identity> {
    this.current(call, session);
    const verified = this.identity(await this.transport.inspect(call, hash), call);
    this.current(call, session);
    if (
      session &&
      (session.context !== call.context ||
        session.identity.binding !== verified.binding ||
        session.identity.configuration !== verified.configuration ||
        session.identity.expires !== verified.expires)
    )
      throw unavailable();
    return verified;
  }
  private current(call: AuthorityCallV1, session?: Session<P, R, V>): void {
    const clock = sampleGitHubMediationClock();
    const now = clock.wall;
    if (this.stopping || call.signal.aborted || now >= Date.parse(call.deadline))
      throw unavailable();
    if (
      session &&
      (session.closing ||
        session.cancellation.signal.aborted ||
        !githubMediationClockContinuous(
          session.clock,
          clock,
          this.limits.clockAllowanceMilliseconds,
        ) ||
        now >= session.leaseUntil ||
        clock.after >= session.leaseMono ||
        clock.after >= session.identityMono ||
        (session.operationMono !== undefined && clock.after >= session.operationMono) ||
        now >= session.identity.expires - this.limits.clockAllowanceMilliseconds ||
        (session.operationUntil !== undefined && now >= session.operationUntil))
    )
      throw unavailable();
  }
  private times(
    input: GitHubMediationTimes,
    session: Session<P, R, V>,
    started: GitHubMediationClockSample,
  ): GitHubMediationTimes {
    const { server_time_ms, valid_until_ms, operation_until_ms } = input;
    const allowance = this.limits.clockAllowanceMilliseconds;
    const clock = sampleGitHubMediationClock();
    if (!githubMediationClockContinuous(session.clock, clock, allowance)) throw unavailable();
    if (
      [server_time_ms, valid_until_ms, operation_until_ms].some(
        (v) => !Number.isSafeInteger(v) || Object.is(v, -0) || v < 0 || v > MAX_TIME,
      ) ||
      server_time_ms >= valid_until_ms ||
      valid_until_ms > operation_until_ms ||
      server_time_ms > Date.now() + allowance ||
      Date.now() - server_time_ms > this.limits.maximumCallMilliseconds + allowance ||
      valid_until_ms - server_time_ms > this.limits.maximumLeaseMilliseconds ||
      operation_until_ms > session.began + this.limits.maximumOperationMilliseconds ||
      (session.operationUntil !== undefined && operation_until_ms !== session.operationUntil)
    )
      throw unavailable();
    const duration = valid_until_ms - server_time_ms - allowance;
    const deadline = Math.min(
      valid_until_ms - allowance,
      started.wall + duration,
      operation_until_ms,
      session.identity.expires - allowance,
    );
    const operationMono =
      session.operationMono ??
      githubMediationMonotonicDeadline(session.clock, operation_until_ms, allowance);
    if (operationMono === undefined) throw unavailable();
    const mono = Math.min(started.before + duration, operationMono, session.identityMono);
    if (duration <= 0 || clock.wall >= deadline || clock.after >= mono) throw unavailable();
    session.operationUntil ??= operation_until_ms;
    session.operationMono ??= operationMono;
    session.leaseUntil = deadline;
    session.leaseMono = mono;
    this.arm(session);
    return Object.freeze({ server_time_ms, valid_until_ms, operation_until_ms });
  }
  private arm(session: Session<P, R, V>): void {
    if (session.timer) clearTimeout(session.timer);
    const left = Math.min(session.leaseUntil - Date.now(), session.leaseMono - performance.now());
    session.timer = setTimeout(
      () => {
        void this.track(this.closeSession(session));
      },
      Math.max(1, Math.ceil(left)),
    );
  }
  private async write(
    reply: GitHubMediationReply<V>,
    call: AuthorityCallV1,
    session?: Session<P, R, V>,
  ): Promise<void> {
    this.current(call, session);
    const bytes = encodeGitHubMediationMetadata(reply);
    await this.transport.writeMetadata(bytes, call);
    this.current(call, session);
  }
  private correlation(request: GitHubMediationRequest<V>) {
    return { version: this.version, sequence: request.sequence, request_ref: request.request_ref };
  }
  private async refuse(
    request: GitHubMediationRequest<V>,
    code: Refused["code"],
    call: AuthorityCallV1,
  ): Promise<void> {
    try {
      await this.write({ ...this.correlation(request), ok: false, code }, call);
    } catch {
      /* Fixed refusal may be lost; never retry. */
    }
  }
  private settle(session: Session<P, R, V>): Promise<"recorded" | "unavailable"> {
    if (session.settlement) return session.settlement;
    session.phase = "terminal";
    const prepared = session.prepared;
    session.settlement =
      prepared && this.operations
        ? this.track(
            Promise.resolve()
              .then(() =>
                this.operations!.settle(prepared.preparation, session.release, session.outcome),
              )
              .catch(() => "unavailable" as const),
          )
        : Promise.resolve("unavailable" as const);
    return session.settlement;
  }
  private closeTransport(call: AuthorityCallV1): Promise<void> {
    return Promise.resolve()
      .then(() => this.transport.close(call))
      .catch(() => {});
  }
  private async closeSession(session: Session<P, R, V>): Promise<void> {
    session.closing = true;
    session.cancellation.abort();
    this.pendingContexts.get(session.context)?.abort();
    if (session.timer) clearTimeout(session.timer);
    session.closeWork ??= this.track(this.closeTransport(session.call));
    await session.closeWork;
    // A running provider/COMMIT worker may still acquire original responsibility.
    // Its handle's finally block, after that worker joins, performs settlement.
    if (!session.busy) {
      await this.settle(session);
      this.active.delete(session);
    }
  }
  private match(
    request: DispatchRead<V> | CheckRead<V> | CompleteRead<V>,
    session: Session<P, R, V>,
  ): void {
    const binding = session.binding;
    if (
      !binding ||
      request.version !== session.request.version ||
      request.sequence !== session.sequence + 1 ||
      request.sequence > 0xffffffff ||
      request.request_ref !== binding.request_ref ||
      request.session_ref !== binding.session_ref ||
      request.effect_ref !== binding.effect_ref ||
      request.work_binding_sha256 !== binding.work_binding_sha256 ||
      request.request_sha256 !== binding.request_sha256
    )
      throw unavailable();
    session.sequence = request.sequence;
  }

  /** Native adapter passes the exact metadata from its owned connection. This
   * method writes replies only through that adapter and returns no token bytes. */
  handle(metadata: Uint8Array, input: AuthorityCallV1): Promise<void> {
    return this.track(this.handleOwned(metadata, input));
  }
  private async handleOwned(metadata: Uint8Array, input: AuthorityCallV1): Promise<void> {
    let call: AuthorityCallV1;
    try {
      call = this.snapshotCall(input);
    } catch {
      await this.closeTransport(input);
      return;
    }
    if (this.pendingContexts.has(call.context)) {
      this.pendingContexts.get(call.context)?.abort();
      const original = this.contexts.get(call.context);
      if (original) await this.closeSession(original);
      else await this.closeTransport(call);
      return;
    }
    const opening = !this.contexts.has(call.context);
    if (
      this.pendingContexts.size >= this.limits.maximumSessions ||
      (opening && this.active.size + this.openingContexts.size >= this.limits.maximumSessions)
    ) {
      await this.closeTransport(call);
      return;
    }
    const cancellation = new AbortController();
    this.pendingContexts.set(call.context, cancellation);
    if (opening) this.openingContexts.add(call.context);
    const timeout = setTimeout(
      () => {
        cancellation.abort();
        const original = this.contexts.get(call.context);
        void this.track(original ? this.closeSession(original) : this.closeTransport(call));
      },
      Math.min(this.limits.maximumCallMilliseconds, Date.parse(call.deadline) - Date.now()),
    );
    let bounded = Object.freeze({
      ...call,
      signal: AbortSignal.any([call.signal, cancellation.signal]),
    });
    let session: Session<P, R, V> | undefined = this.contexts.get(call.context);
    let ownsSession = false;
    let succeeded = false;
    try {
      if (
        !(metadata instanceof Uint8Array) ||
        metadata.byteLength < 1 ||
        metadata.byteLength > METADATA_LIMIT
      )
        throw unavailable();
      const captured = Uint8Array.from(metadata);
      const request = decodeGitHubMediationRequest(captured, this.version);
      if (!request || request.request_ref !== call.requestRef) throw unavailable();
      const hash = sha256(captured);
      if (session) this.current(bounded, session);
      const verified = await this.inspect(bounded, hash);
      // A native context cannot adopt another connection incarnation, even if
      // the new binding has no session yet. Retain the old cleanup owner.
      if (session && session.identity.binding !== verified.binding) throw unavailable();
      const byBinding = this.sessions.get(verified.binding);
      if (session && byBinding !== session) throw unavailable();
      session = byBinding;
      if (
        session &&
        (session.context !== call.context ||
          session.identity.configuration !== verified.configuration ||
          session.identity.expires !== verified.expires)
      )
        throw unavailable();
      if (session)
        bounded = Object.freeze({
          ...bounded,
          signal: AbortSignal.any([bounded.signal, session.cancellation.signal]),
        });
      if (request.method === "open-read") {
        if (session || this.active.size >= this.limits.maximumSessions) throw unavailable();
        if (!this.operations) {
          // TODO(repository-use composition): install the original Work authority,
          // inventory and protected token-use owners before enabling GitHub reads.
          await this.refuse(request, "unavailable", bounded);
          return;
        }
        const clock = sampleGitHubMediationClock();
        const began = clock.wall;
        const identityMono = githubMediationMonotonicDeadline(
          clock,
          verified.expires,
          this.limits.clockAllowanceMilliseconds,
        );
        if (identityMono === undefined) throw unavailable();
        session = {
          context: call.context,
          identity: verified,
          request,
          cancellation: new AbortController(),
          began,
          clock,
          identityMono,
          call,
          phase: "opening",
          sequence: 1,
          leaseUntil: began + this.limits.maximumCallMilliseconds,
          leaseMono: Math.min(clock.before + this.limits.maximumCallMilliseconds, identityMono),
          dispatchAttempted: false,
          outcome: "not-dispatched",
          busy: true,
          closing: false,
        };
        ownsSession = true;
        this.sessions.set(verified.binding, session);
        this.contexts.set(call.context, session);
        this.active.add(session);
        this.arm(session);
        bounded = Object.freeze({
          ...bounded,
          signal: AbortSignal.any([bounded.signal, session.cancellation.signal]),
        });
        const prepared = await this.operations.prepare(request, bounded);
        if (prepared.kind === "refused") {
          await this.refuse(request, prepared.code, bounded);
          return;
        }
        // Capture known responsibility before cancellation checks or reply writes.
        session.prepared = Object.freeze({
          ...prepared,
          times: Object.freeze({ ...prepared.times }),
        });
        this.current(bounded, session);
        const effect = prepared.original.operationRef;
        if (
          !reference.test(effect) ||
          !digest.test(prepared.workBindingSha256) ||
          prepared.original.requestDigest !== request.request_sha256 ||
          !reference.test(prepared.dnsBindingRef) ||
          !Number.isFinite(Date.parse(prepared.originalHorizon)) ||
          prepared.times.operation_until_ms > Date.parse(prepared.originalHorizon)
        )
          throw unavailable();
        const times = this.times(prepared.times, session, clock);
        session.binding = Object.freeze({
          version: this.version,
          request_ref: request.request_ref,
          session_ref: randomBytes(16).toString("hex"),
          effect_ref: effect,
          work_binding_sha256: prepared.workBindingSha256,
          request_sha256: request.request_sha256,
        });
        await this.inspect(bounded, hash, session);
        await this.write(
          {
            ...session.binding,
            sequence: 1,
            ...times,
            ok: true,
            phase: "opened",
            dns_binding_ref: prepared.dnsBindingRef,
            upstream_ipv4: prepared.upstreamIpv4,
          },
          bounded,
          session,
        );
        session.phase = "opened";
      } else {
        if (!session || session.busy || session.closing || session.context !== call.context)
          throw unavailable();
        session.busy = true;
        ownsSession = true;
        session.call = call;
        this.current(bounded, session);
        this.match(request, session);
        if (request.method === "dispatch-read")
          await this.dispatch(request, bounded, hash, session);
        else if (request.method === "check-read") {
          if (
            session.phase !== "dispatched" ||
            !session.prepared ||
            session.release === undefined ||
            request.release_ref !== session.releaseRef ||
            !this.operations
          )
            throw unavailable();
          const started = sampleGitHubMediationClock();
          const result = await this.operations.check(
            session.prepared.preparation,
            session.release,
            bounded,
          );
          if (result.kind === "refused") {
            await this.refuse(request, result.code, bounded);
            return;
          }
          this.current(bounded, session);
          const times = this.times(result.times, session, started);
          await this.inspect(bounded, hash, session);
          await this.write(
            {
              ...session.binding!,
              sequence: request.sequence,
              ...times,
              ok: true,
              phase: "current",
              release_ref: request.release_ref,
            },
            bounded,
            session,
          );
        } else await this.complete(request, bounded, session);
      }
      succeeded = true;
    } catch {
      // Fixed transport errors only. In particular no provider, request or token
      // exception is returned, logged or reflected to the execution environment.
    } finally {
      clearTimeout(timeout);
      cancellation.abort();
      this.pendingContexts.delete(call.context);
      this.openingContexts.delete(call.context);
      if (session) {
        if (ownsSession) session.busy = false;
        if (
          !succeeded ||
          session.phase === "opening" ||
          session.phase === "dispatching" ||
          session.phase === "terminal" ||
          session.closing
        )
          await this.closeSession(session);
      } else await this.closeTransport(call);
    }
  }
  private async dispatch(
    request: DispatchRead<V>,
    call: AuthorityCallV1,
    hash: string,
    session: Session<P, R, V>,
  ): Promise<void> {
    const prepared = session.prepared;
    if (
      session.phase !== "opened" ||
      session.dispatchAttempted ||
      !prepared ||
      !this.operations ||
      request.dns_binding_ref !== prepared.dnsBindingRef ||
      request.upstream_ipv4 !== prepared.upstreamIpv4
    )
      throw unavailable();
    session.phase = "dispatching";
    session.dispatchAttempted = true;
    session.outcome = "unknown";
    const started = sampleGitHubMediationClock();
    const result = await this.operations.dispatch(prepared.preparation, request, call);
    if (result.kind === "not-released") {
      session.outcome = "not-dispatched";
      await this.refuse(request, result.code, call);
      return;
    }
    if (result.kind === "unknown") {
      await this.refuse(request, "unavailable", call);
      return;
    }
    session.release = result.release;
    session.releaseRef = result.releaseRef;
    this.current(call, session);
    const times = this.times(result.times, session, started);
    await this.inspect(call, hash, session);
    const response = encodeGitHubMediationMetadata({
      ...session.binding!,
      sequence: request.sequence,
      ...times,
      ok: true,
      phase: "dispatch-once",
      dns_binding_ref: request.dns_binding_ref,
      upstream_ipv4: request.upstream_ipv4,
      peer_certificate_sha256: request.peer_certificate_sha256,
      release_ref: result.releaseRef,
    });
    this.current(call, session);
    await this.operations.writeRelease(result.release, response, call);
    this.current(call, session);
    session.phase = "dispatched";
  }
  private async complete(
    request: CompleteRead<V>,
    call: AuthorityCallV1,
    session: Session<P, R, V>,
  ): Promise<void> {
    if (
      (session.phase !== "opened" && session.phase !== "dispatched") ||
      (request.release_ref !== session.releaseRef &&
        !(request.release_ref === null && request.outcome === "unknown") &&
        !(request.release_ref === null && !session.dispatchAttempted)) ||
      (request.outcome === "completed" && !session.dispatchAttempted) ||
      (!session.dispatchAttempted && request.outcome !== "not-dispatched")
    )
      throw unavailable();
    session.outcome = request.outcome;
    const recorded = await this.settle(session);
    if (recorded !== "recorded") throw unavailable();
    await this.write(
      {
        ...session.binding!,
        sequence: request.sequence,
        ok: true,
        phase: "recorded",
        release_ref: request.release_ref,
      },
      call,
      session,
    );
  }
  async close(call: AuthorityCallV1): Promise<void> {
    this.pendingContexts.get(call.context)?.abort();
    const session = this.contexts.get(call.context);
    if (session) await this.track(this.closeSession(session));
    else await this.track(this.closeTransport(call));
  }
  /** Joins actual owned work; it is not a receipt of provider completion. */
  async join(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const cancellation of this.pendingContexts.values()) cancellation.abort();
    await Promise.allSettled([...this.active].map((session) => this.closeSession(session)));
    await this.join();
  }
}
