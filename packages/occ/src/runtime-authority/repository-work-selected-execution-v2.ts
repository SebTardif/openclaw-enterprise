import { immutableCopy } from "@openclaw-enterprise/utils";
import { parseTurnJournalV1 } from "@openclaw-enterprise/contracts/turn-journal-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import { decodeGitHubMediationRequest, type OpenRead } from "../github-mediation-v2/wire.ts";
import {
  githubMediationClockContinuous,
  githubMediationMonotonicDeadline,
  sampleGitHubMediationClock,
  type GitHubMediationClockSample,
} from "../github-mediation-v2/clock.ts";
import type {
  RepositoryWorkNativeSelectedExecutionDataV2,
  RepositoryWorkNativeSelectedExecutionLeaseV2,
  RepositoryWorkNativeSelectedExecutionSourceV2,
  RepositoryWorkSelectedExecutionNativeParticipantV2,
} from "../ports/repository-work-selected-execution-v2.ts";
import type {
  RepositoryWorkHeldLeaseV2,
  RepositoryWorkTransactionContextV2,
} from "../ports/repository-work-v2.ts";
import type { RepositoryWorkNativeSessionSourceV2 } from "./repository-work-origin-v2.ts";
import { canonicalRuntimeServiceTrust } from "./service-trust-schema.ts";
import type { RuntimeServiceTrustService } from "./service-trust.ts";

declare const nativeExecution: unique symbol;
export type OriginalRepositoryWorkNativeExecutionV2<V extends 2 | 3 = 2> = {
  readonly [nativeExecution]: (version: V) => V;
};

/** Fixed receiver at the original known-start accepting boundary. Its H must
 * already belong to the exact native Session and original retained ready
 * execution, including its selected admission operation and current-use locks.
 * The receiver must not construct H from the request, a start DTO or an
 * attachment name. Runtime neither exports an enrollment setter nor implements
 * the journal/native producer through this port.
 */
export interface RepositoryWorkAcceptedExecutionOwnerV2<N, H, in out V extends 2 | 3 = 2> {
  acquire(
    session: N,
    request: OpenRead<V>,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkNativeSelectedExecutionLeaseV2<H> | undefined>;
  retain(
    context: RepositoryWorkTransactionContextV2,
    original: H,
    session: N,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkHeldLeaseV2>;
}

export interface RepositoryWorkNativeExecutionLimitsV2 {
  readonly maximumBorrows: number;
  readonly maximumCallMilliseconds: number;
  readonly clockAllowanceMilliseconds: number;
}
type NativeObservation<N, V extends 2 | 3> = Awaited<
  ReturnType<RepositoryWorkNativeSessionSourceV2<N, V>["inspect"]>
>;
type Entry<N, H, V extends 2 | 3> = {
  readonly original: OriginalRepositoryWorkNativeExecutionV2<V>;
  readonly session: N;
  readonly request: OpenRead<V>;
  readonly call: AuthorityCallV1;
  readonly clock: GitHubMediationClockSample;
  readonly pending: Set<Promise<unknown>>;
  readonly cutoffs: Map<string, number>;
  readonly holds: Set<Promise<void>>;
  readonly joiners: Set<(pending: Promise<unknown>) => undefined>;
  raw?: H;
  inspectRaw?: () => RepositoryWorkNativeSelectedExecutionDataV2;
  assertRaw?: (call: AuthorityCallV1) => undefined;
  releaseRaw?: () => Promise<void>;
  observed?: NativeObservation<N, V>;
  registry?: string;
  data?: RepositoryWorkNativeSelectedExecutionDataV2;
  encoded?: string;
  horizon: number;
  monotonicHorizon: number;
  closing: boolean;
  checking: boolean;
  cleanup?: Promise<void>;
  stopNative?: () => void;
};
const fail: () => never = () => {
  throw new Error("Original repository selected execution unavailable.");
};
const encode = (value: unknown) => canonicalRuntimeServiceTrust(value);
function capture<T extends object, K extends keyof T>(owner: T, key: K): T[K] {
  const value = owner?.[key];
  if (typeof value !== "function") fail();
  return value.bind(owner) as T[K];
}

/** Runtime consumer only. Original Session and accepting-owner membership are
 * both required before E exists. Comparison facts never enroll either operand.
 * State owns the journal/assignment/policy reads and the first Work admission.
 */
export function createRepositoryWorkNativeExecutionSourceV2<N, H, V extends 2 | 3>(options: {
  readonly protocolVersion: V;
  readonly native: RepositoryWorkNativeSessionSourceV2<N, V>;
  readonly accepted: RepositoryWorkAcceptedExecutionOwnerV2<N, H, V>;
  readonly trust: Pick<RuntimeServiceTrustService, "readCurrentRecord">;
  readonly limits: RepositoryWorkNativeExecutionLimitsV2;
}): RepositoryWorkNativeSelectedExecutionSourceV2<
  N,
  OriginalRepositoryWorkNativeExecutionV2<V>,
  V
> & {
  close(): Promise<void>;
} {
  const version = options.protocolVersion;
  const limits = Object.freeze({ ...options.limits });
  if (
    (version !== 2 && version !== 3) ||
    !Number.isSafeInteger(limits.maximumBorrows) ||
    limits.maximumBorrows < 1 ||
    limits.maximumBorrows > 128 ||
    !Number.isSafeInteger(limits.maximumCallMilliseconds) ||
    limits.maximumCallMilliseconds < 1 ||
    limits.maximumCallMilliseconds > 3000 ||
    !Number.isSafeInteger(limits.clockAllowanceMilliseconds) ||
    limits.clockAllowanceMilliseconds < 0 ||
    limits.clockAllowanceMilliseconds >= limits.maximumCallMilliseconds
  )
    fail();
  const inspectNative = capture(options.native, "inspect");
  const assertNative = capture(options.native, "assertCurrent");
  const acquireAccepted = capture(options.accepted, "acquire");
  const retainAccepted = capture(options.accepted, "retain");
  const readRegistry = capture(options.trust, "readCurrentRecord");
  const entries = new WeakMap<object, Entry<N, H, V>>();
  const active = new Set<Entry<N, H, V>>();
  let participant:
    | RepositoryWorkSelectedExecutionNativeParticipantV2<
        N,
        OriginalRepositoryWorkNativeExecutionV2<V>
      >
    | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;

  function track<T>(entry: Entry<N, H, V>, pending: Promise<T>): Promise<T> {
    entry.pending.add(pending);
    void pending.then(
      () => entry.pending.delete(pending),
      () => entry.pending.delete(pending),
    );
    return pending;
  }
  function synchronous(
    entry: Entry<N, H, V>,
    value: unknown,
    join?: (pending: Promise<unknown>) => undefined,
  ): undefined {
    if (value !== undefined) {
      if (value && typeof (value as PromiseLike<unknown>).then === "function") {
        const pending = track(entry, Promise.resolve(value));
        // E.assertCurrent is also called directly by State while this prefix is
        // held. Retain its original drain even outside the retain() call stack.
        const receivers = new Set(entry.joiners);
        if (join) receivers.add(join);
        for (const receiver of receivers) receiver(pending);
      }
      fail();
    }
    return undefined;
  }
  function retire(entry: Entry<N, H, V>): Promise<void> {
    if (entry.cleanup) return entry.cleanup;
    entry.closing = true;
    entry.stopNative?.();
    entry.cleanup = (async () => {
      while (entry.pending.size || entry.holds.size)
        await Promise.allSettled([...entry.pending, ...entry.holds]);
      try {
        await entry.releaseRaw?.();
      } finally {
        active.delete(entry);
      }
    })();
    void entry.cleanup.catch(() => {
      closing = true;
    });
    return entry.cleanup;
  }
  function member(original: OriginalRepositoryWorkNativeExecutionV2<V>, session: N) {
    const entry = entries.get(original);
    if (!entry || entry.session !== session || entry.closing || closing) fail();
    return entry;
  }
  function local(entry: Entry<N, H, V>, call: AuthorityCallV1): void {
    if (
      closing ||
      entry.closing ||
      entry.checking ||
      call.signal.aborted ||
      call.context !== entry.call.context ||
      call.requestRef !== entry.call.requestRef ||
      call.recipientRef !== entry.call.recipientRef ||
      entry.observed?.lifetime.aborted
    )
      fail();
    const now = sampleGitHubMediationClock();
    const end = Date.parse(call.deadline);
    if (
      !Number.isSafeInteger(end) ||
      !githubMediationClockContinuous(entry.clock, now, limits.clockAllowanceMilliseconds)
    )
      fail();
    let cutoff = entry.cutoffs.get(call.deadline);
    if (cutoff === undefined) {
      // This never refreshes native membership. The original source's synchronous
      // fence below must recognize this exact freshly authenticated Exchange.
      if (entry.cutoffs.size >= 128) fail();
      const absolute = Math.min(end, now.wall + limits.maximumCallMilliseconds, entry.horizon);
      cutoff = githubMediationMonotonicDeadline(now, absolute, limits.clockAllowanceMilliseconds);
      if (cutoff === undefined) fail();
      entry.cutoffs.set(call.deadline, cutoff);
    }
    if (
      now.wall >= end ||
      now.wall >= entry.horizon ||
      now.after >= cutoff ||
      now.after >= entry.monotonicHorizon
    )
      fail();
  }
  function current(
    entry: Entry<N, H, V>,
    call: AuthorityCallV1,
    join?: (pending: Promise<unknown>) => undefined,
  ): undefined {
    try {
      local(entry, call);
      entry.checking = true;
      try {
        synchronous(entry, assertNative(entry.session, call), join);
        if (entry.assertRaw) synchronous(entry, entry.assertRaw(call), join);
        if (entry.inspectRaw && entry.data) {
          const raw = entry.inspectRaw();
          if (
            raw.admission.original !== entry.data.admission.original ||
            encode(raw) !== entry.encoded
          )
            fail();
        }
      } finally {
        entry.checking = false;
      }
      local(entry, call);
      return undefined;
    } catch (error) {
      void retire(entry);
      throw error;
    }
  }
  async function observe(entry: Entry<N, H, V>, call: AuthorityCallV1): Promise<void> {
    local(entry, call);
    const observed = await inspectNative(entry.session, call);
    local(entry, call);
    const previous = entry.observed;
    if (
      observed.context !== call.context ||
      !observed.lifetime ||
      observed.lifetime === call.signal ||
      observed.lifetime.aborted ||
      !observed.verified.transportBinding ||
      (previous &&
        (observed.context !== previous.context ||
          observed.lifetime !== previous.lifetime ||
          observed.sessionRef !== previous.sessionRef ||
          observed.verified.transportBinding !== previous.verified.transportBinding ||
          encode(observed.verified.configuration) !== encode(previous.verified.configuration)))
    )
      fail();
    const record = await readRegistry(
      observed.verified.configuration.serviceIdentityRef,
      call.signal,
    );
    local(entry, call);
    if (
      !record ||
      record.admission.configuration.role !== "repository-issuer" ||
      record.admission.configuration.allowedScope.kind !== "agent" ||
      record.admission.configuration.permittedRecipientRef !== call.recipientRef ||
      record.admission.profile.operationPolicy !==
        (version === 3 ? "github-git-read-rpc-v3" : "github-metadata-rpc-v2") ||
      record.admission.profile.transportProfileRef !==
        (version === 3
          ? "owned-child-stdio-github-git-read-v3"
          : "owned-child-stdio-github-metadata-v2") ||
      encode(record.admission.configuration) !== encode(observed.verified.configuration)
    )
      fail();
    const registry = encode(record);
    if (entry.registry !== undefined && entry.registry !== registry) fail();
    entry.registry = registry;
    entry.observed = observed;
    const horizon = Date.parse(observed.verified.expiresAt);
    if (!Number.isSafeInteger(horizon)) fail();
    entry.horizon = Math.min(entry.horizon, horizon);
    const mono = githubMediationMonotonicDeadline(
      entry.clock,
      entry.horizon,
      limits.clockAllowanceMilliseconds,
    );
    if (mono === undefined) fail();
    entry.monotonicHorizon = Math.min(entry.monotonicHorizon, mono);
    if (!previous) {
      const stop = () => {
        void retire(entry);
      };
      observed.lifetime.addEventListener("abort", stop, { once: true });
      entry.stopNative = () => observed.lifetime.removeEventListener("abort", stop);
    }
    current(entry, call);
  }
  function snapshot(entry: Entry<N, H, V>, input: RepositoryWorkNativeSelectedExecutionDataV2) {
    const original = input.admission.original;
    const data = immutableCopy(input);
    const scope = entry.observed!.verified.configuration.allowedScope;
    const start = parseTurnJournalV1("executionStart", data.start);
    const attempt = data.execution.attempt;
    if (
      scope.kind !== "agent" ||
      encode(attempt) !== encode(start.intent.execution.attempt) ||
      original.scope.installationRef !== scope.installationId ||
      original.scope.namespaceRef !== scope.namespaceId ||
      original.scope.agentRef !== scope.agentId ||
      attempt.installationRef !== scope.installationId ||
      attempt.namespaceRef !== scope.namespaceId ||
      attempt.agentRef !== scope.agentId ||
      data.runtime.target.installationId !== scope.installationId ||
      data.runtime.target.namespaceId !== scope.namespaceId ||
      data.runtime.target.agentId !== scope.agentId ||
      data.runtime.target.assignmentRef.id !== data.execution.assignmentRef ||
      data.service.kind !== "service_principal" ||
      data.attachmentRef !== entry.request.attachment_ref ||
      (data.service.namespaceId !== undefined && data.service.namespaceId !== scope.namespaceId) ||
      (data.service.agentId !== undefined && data.service.agentId !== scope.agentId) ||
      !["admit-root", "admit-child", "existing"].includes(data.admission.mode.kind)
    )
      fail();
    const horizon = Math.min(
      Date.parse(data.validUntil),
      Date.parse(data.admission.originalHorizon),
    );
    if (!Number.isSafeInteger(horizon)) fail();
    entry.horizon = Math.min(entry.horizon, horizon);
    const mono = githubMediationMonotonicDeadline(
      entry.clock,
      entry.horizon,
      limits.clockAllowanceMilliseconds,
    );
    if (mono === undefined) fail();
    entry.monotonicHorizon = Math.min(entry.monotonicHorizon, mono);
    // State's original-operation recognition requires this exact object.
    entry.data = Object.freeze({
      ...data,
      admission: Object.freeze({ ...data.admission, original }),
    });
    entry.encoded = encode(input);
  }

  const source: RepositoryWorkNativeSelectedExecutionSourceV2<
    N,
    OriginalRepositoryWorkNativeExecutionV2<V>,
    V
  > & { close(): Promise<void> } = {
    bindState(original) {
      if (participant || closing) fail();
      participant = Object.freeze({ assertOriginal: capture(original, "assertOriginal") });
      return undefined;
    },
    async acquire(session, input, call) {
      if (!participant || closing || active.size >= limits.maximumBorrows) fail();
      const copied = immutableCopy(input);
      const request = decodeGitHubMediationRequest(Buffer.from(JSON.stringify(copied)), version);
      if (!request || request.method !== "open-read" || request.request_ref !== call.requestRef)
        fail();
      const original = Object.freeze({}) as OriginalRepositoryWorkNativeExecutionV2<V>;
      const entry: Entry<N, H, V> = {
        original,
        session,
        request: request as OpenRead<V>,
        call: Object.freeze({ ...call }),
        clock: sampleGitHubMediationClock(),
        pending: new Set(),
        holds: new Set(),
        cutoffs: new Map(),
        joiners: new Set(),
        horizon: Number.MAX_SAFE_INTEGER,
        monotonicHorizon: Infinity,
        closing: false,
        checking: false,
      };
      active.add(entry);
      let accepted = false;
      const pending = (async () => {
        await observe(entry, call);
        const raw = await acquireAccepted(session, entry.request, call);
        if (raw === undefined) return undefined;
        // A late acquisition transfers cleanup before ANY other supplier getter.
        entry.releaseRaw = capture(raw, "release");
        local(entry, call);
        entry.raw = raw.original;
        if (!entry.raw || typeof entry.raw !== "object") fail();
        entry.inspectRaw = capture(raw, "inspect");
        entry.assertRaw = capture(raw, "assertCurrent");
        snapshot(entry, entry.inspectRaw());
        await observe(entry, call);
        current(entry, call);
        entries.set(original, entry);
        accepted = true;
        return Object.freeze<
          RepositoryWorkNativeSelectedExecutionLeaseV2<OriginalRepositoryWorkNativeExecutionV2<V>>
        >({
          original,
          inspect() {
            if (entry.closing || closing || !entry.data) fail();
            const value = entry.inspectRaw!();
            if (
              value.admission.original !== entry.data.admission.original ||
              encode(value) !== entry.encoded
            ) {
              void retire(entry);
              fail();
            }
            return entry.data;
          },
          assertCurrent: (nextCall) => current(entry, nextCall),
          release: () => retire(entry),
        });
      })();
      try {
        return await track(entry, pending);
      } finally {
        if (!accepted) await retire(entry);
      }
    },
    async retain(context, original, session, call) {
      const entry = member(original, session);
      const selected = participant;
      if (!selected || !entry.data) fail();
      synchronous(entry, selected.assertOriginal(context, original, session, call));
      if (context.installationId !== entry.data.admission.original.scope.installationRef) fail();
      const join = capture(context, "joinAccepted");
      let releaseRaw: (() => Promise<void>) | undefined;
      let checkRaw: (() => undefined) | undefined;
      let prepareRaw: (() => Promise<void>) | undefined;
      let released = false;
      let cleanup: Promise<void> | undefined;
      const acceptedWork = new Set<Promise<unknown>>();
      const joinWork = (pending: Promise<unknown>): undefined => {
        acceptedWork.add(pending);
        void pending.then(
          () => acceptedWork.delete(pending),
          () => acceptedWork.delete(pending),
        );
        track(entry, pending);
        return join(pending);
      };
      let done!: () => void;
      const heldDone = new Promise<void>((resolve) => {
        done = resolve;
      });
      entry.holds.add(heldDone);
      entry.joiners.add(joinWork);
      void heldDone.then(() => entry.holds.delete(heldDone));
      const pending = (async () => {
        await observe(entry, call);
        synchronous(entry, selected.assertOriginal(context, original, session, call));
        const raw = await retainAccepted(context, entry.raw!, session, call);
        releaseRaw = capture(raw, "release");
        if (released) fail();
        checkRaw = capture(raw, "assertCurrent");
        prepareRaw = capture(raw, "prepareCommit");
        current(entry, call, joinWork);
      })();
      track(entry, pending);
      const held: RepositoryWorkHeldLeaseV2 = Object.freeze({
        assertCurrent() {
          if (released || !checkRaw) fail();
          synchronous(entry, selected.assertOriginal(context, original, session, call));
          current(entry, call, joinWork);
          entry.checking = true;
          try {
            synchronous(entry, checkRaw(), joinWork);
          } finally {
            entry.checking = false;
          }
          current(entry, call, joinWork);
          return undefined;
        },
        async prepareCommit() {
          held.assertCurrent();
          const accepted = Promise.resolve().then(() => prepareRaw!());
          joinWork(accepted);
          await accepted;
          held.assertCurrent();
        },
        release() {
          if (!cleanup) {
            released = true;
            cleanup = (async () => {
              try {
                await pending.catch(() => {});
                while (acceptedWork.size) await Promise.allSettled([...acceptedWork]);
                await releaseRaw?.();
              } finally {
                entry.joiners.delete(joinWork);
                done();
              }
            })();
          }
          return cleanup;
        },
      });
      try {
        join(pending);
        await pending;
        held.assertCurrent();
        return held;
      } catch (error) {
        await held.release();
        void retire(entry);
        throw error;
      }
    },
    close() {
      if (!closePromise) {
        closing = true;
        closePromise = (async () => {
          const results = await Promise.allSettled([...active].map(retire));
          if (results.some((result) => result.status === "rejected")) fail();
        })();
      }
      return closePromise;
    },
  };
  return Object.freeze(source);
}
