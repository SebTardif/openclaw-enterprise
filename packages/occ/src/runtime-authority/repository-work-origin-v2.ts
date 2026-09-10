import { types } from "node:util";
import { parseCompletedContextV1 } from "@openclaw-enterprise/contracts/completed-context-v1";
import type {
  AuthorityCallV1,
  RuntimeAuthorityVerifiedServiceV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { ServicePrincipal } from "@openclaw-enterprise/contracts/identity/identity";
import type { GitHubMediationVersion, OpenRead } from "../github-mediation-v2/wire.ts";
import { decodeGitHubMediationRequest } from "../github-mediation-v2/wire.ts";
import {
  githubMediationClockContinuous,
  githubMediationMonotonicDeadline,
  sampleGitHubMediationClock,
  type GitHubMediationClockSample,
} from "../github-mediation-v2/clock.ts";
import type { RepositoryWorkNativeBindingV2 } from "../lifecycle/repository-work-v2.ts";
import type {
  VersionedWorkRefV2,
  WorkExecutionAssociationV2,
  WorkInstantV2,
  WorkOriginalOperationV2,
  WorkProfileRefV2,
} from "../lifecycle/work-authority-ports-v2.ts";
import { canonicalRuntimeServiceTrust } from "./service-trust-schema.ts";
import { RuntimeServiceTrustService } from "./service-trust.ts";

declare const originBrand: unique symbol;
export type OriginalRepositoryWorkOriginV2<V extends GitHubMediationVersion = 2> = {
  readonly [originBrand]: (version: V) => V;
};

/** The native owner recognizes its original Session and each current Exchange.
 * A retained Session signal must not be the temporary signal of an RPC call. */
export interface RepositoryWorkNativeSessionSourceV2<
  Session = never,
  in out V extends GitHubMediationVersion = 2,
> {
  readonly acquire: (request: OpenRead<V>, call: AuthorityCallV1) => Promise<Session | undefined>;
  inspect(
    session: Session,
    call: AuthorityCallV1,
  ): Promise<
    Readonly<{
      context: AuthorityCallV1["context"];
      verified: RuntimeAuthorityVerifiedServiceV1;
      lifetime: AbortSignal;
      sessionRef: string;
    }>
  >;
  assertCurrent(session: Session, call: AuthorityCallV1): void;
  release(session: Session): Promise<void>;
}

/** Original protected assignment/purpose facts, returned only after the State
 * owner's private acquisition. These values cannot enroll an assignment. */
export type RepositoryWorkOriginAssignmentV2<V extends GitHubMediationVersion = 2> = {
  readonly original: WorkOriginalOperationV2;
  readonly work: VersionedWorkRefV2;
  readonly execution: WorkExecutionAssociationV2;
  readonly service: ServicePrincipal;
  readonly attachmentRef: string;
  readonly repository: Readonly<{
    id: string;
    owner: string;
    name: string;
    profile: WorkProfileRefV2;
  }>;
  readonly purpose: "work.repository.use";
  readonly operationUntil: WorkInstantV2;
  readonly validUntil: WorkInstantV2;
} & (V extends 3
  ? {
      readonly operation: "git:read";
      readonly requiredPermissions: readonly ["contents:read", "metadata:read"];
    }
  : { readonly permission: "metadata:read" });

/** Captured once by the original State construction. This only recognizes an
 * existing Runtime origin and returns State's SAME private assignment operand.
 * It creates no Work, ancestry, admission, policy or recovery projection. */
export interface RepositoryWorkOriginAssignmentRecognizerV2<
  Assignment = never,
  V extends GitHubMediationVersion = 2,
> {
  recognize(origin: OriginalRepositoryWorkOriginV2<V>, call: AuthorityCallV1): Assignment;
}

/** Passed only to the fixed custody receiver during original construction.
 * Recognition borrows the exact retained native Session; custody must keep the
 * original native receiver's private inspection and prepared-write methods. */
export interface RepositoryWorkOriginNativeRecognizerV2<
  Session = never,
  V extends GitHubMediationVersion = 2,
> {
  readonly recognize: (origin: OriginalRepositoryWorkOriginV2<V>, call: AuthorityCallV1) => Session;
  /** Native correspondence only during the original State readset handoff.
   * The full recognizer remains required after reacquiring State authority. */
  readonly recognizeNative: (
    origin: OriginalRepositoryWorkOriginV2<V>,
    call: AuthorityCallV1,
  ) => Session;
}

/** The custody owner captures this binding once. There is no later receiver
 * setter, request-time callback, projected Session or new native enrollment. */
export interface RepositoryWorkOriginNativeCustodyV2<
  Session = never,
  in out V extends GitHubMediationVersion = 2,
> {
  readonly bindOrigins: (
    recognizer: RepositoryWorkOriginNativeRecognizerV2<Session, V>,
  ) => undefined;
}

/** Paired by original service construction with the actual native recognizer.
 * The State owner captures the SAME original native source at construction and
 * inspects this private Session before any assignment checkout. It recognizes its
 * own held registration/assignment/attachment participant on every method.
 * Replacement and withdrawal must conflict with that participant's currentness.
 * No ordinary stored-assignment reader or caller-provided allow callback fits. */
export interface RepositoryWorkOriginAssignmentSourceV2<
  Assignment = never,
  Session = never,
  in out V extends GitHubMediationVersion = 2,
> {
  bindOrigins(recognizer: RepositoryWorkOriginAssignmentRecognizerV2<Assignment, V>): undefined;
  readonly acquire: (
    request: OpenRead<V>,
    nativeSession: Session,
    call: AuthorityCallV1,
  ) => Promise<Assignment | undefined>;
  inspect(
    assignment: Assignment,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkOriginAssignmentV2<V>>;
  assertCurrent(assignment: Assignment): void;
  release(assignment: Assignment): Promise<void>;
}

export interface RepositoryWorkOriginLimitsV2 {
  readonly maximumOrigins: number;
  readonly maximumCallMilliseconds: number;
  readonly maximumOperationMilliseconds: number;
  readonly maximumLeaseMilliseconds: number;
  readonly clockAllowanceMilliseconds: number;
}

const failure = () => new Error("Repository origin unavailable.");
const maximumTime = 253402300799999;
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}(?![\s\S])/;
const reference = (value: unknown): value is string =>
  typeof value === "string" && referencePattern.test(value);
const digest = /^sha256:[0-9a-f]{64}(?![\s\S])/;
function instant(value: unknown): number {
  if (typeof value !== "string") throw failure();
  const result = Date.parse(value);
  if (
    !Number.isSafeInteger(result) ||
    result < 0 ||
    result > maximumTime ||
    new Date(result).toISOString() !== value
  )
    throw failure();
  return result;
}
function plain(input: unknown): unknown {
  let nodes = 4096;
  let bytes = 65536;
  function copy(value: unknown, depth: number): unknown {
    if (--nodes < 0 || depth > 16) throw failure();
    if (typeof value === "string") {
      bytes -= Buffer.byteLength(value);
      if (bytes < 0) throw failure();
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0))
      return value;
    if (!value || typeof value !== "object" || types.isProxy(value)) throw failure();
    const array = Array.isArray(value);
    if (
      Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) &&
      Object.getPrototypeOf(value) !== null
    )
      throw failure();
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== Object.keys(fields).length) throw failure();
    if (array) {
      if (value.length > 128 || Object.keys(fields).length !== value.length + 1) throw failure();
      return Object.freeze(
        Array.from({ length: value.length }, (_, index) => {
          const field = fields[String(index)];
          if (!field || !("value" in field) || !field.enumerable) throw failure();
          return copy(field.value, depth + 1);
        }),
      );
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, field] of Object.entries(fields)) {
      bytes -= Buffer.byteLength(key);
      if (
        bytes < 0 ||
        !("value" in field) ||
        !field.enumerable ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        throw failure();
      result[key] = copy(field.value, depth + 1);
    }
    return Object.freeze(result);
  }
  return copy(input, 0);
}
function encode(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${encode(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Pure correspondence checks only; successful comparison creates no handle. */
export function compareRepositoryWorkOriginAssignmentV2<V extends GitHubMediationVersion>(
  input: RepositoryWorkOriginAssignmentV2<NoInfer<V>>,
  request: OpenRead<V>,
  verified: Readonly<RuntimeAuthorityVerifiedServiceV1>,
): Readonly<RepositoryWorkOriginAssignmentV2<V>> {
  const value = plain(input) as RepositoryWorkOriginAssignmentV2<V>;
  const projection = plain(request) as OpenRead<V>;
  const declaration = decodeGitHubMediationRequest(
    Buffer.from(encode(projection)),
    projection.version,
  );
  if (!declaration || declaration.method !== "open-read") throw failure();
  // The actual Work/State policy decision must carry the selected operation and
  // every required permission. A metadata decision cannot authorize Git use.
  if (
    declaration.version === 2
      ? !("permission" in value) ||
        value.permission !== "metadata:read" ||
        "operation" in value ||
        "requiredPermissions" in value
      : !("operation" in value) ||
        value.operation !== "git:read" ||
        !("requiredPermissions" in value) ||
        !Array.isArray(value.requiredPermissions) ||
        value.requiredPermissions.length !== 2 ||
        value.requiredPermissions[0] !== "contents:read" ||
        value.requiredPermissions[1] !== "metadata:read" ||
        "permission" in value
  )
    throw failure();
  const scope = verified.configuration.allowedScope;
  const original = value.original;
  const execution = value.execution;
  const attempt = parseCompletedContextV1("exactAttempt", execution.attempt);
  if (
    value.purpose !== "work.repository.use" ||
    value.attachmentRef !== request.attachment_ref ||
    value.repository.owner !== request.repository_owner ||
    value.repository.name !== request.repository_name ||
    !reference(value.repository.id) ||
    !reference(value.repository.profile.ref) ||
    !reference(value.repository.profile.revision) ||
    scope.kind !== "agent" ||
    verified.configuration.role !== "repository-issuer" ||
    original.scope.installationRef !== scope.installationId ||
    original.scope.namespaceRef !== scope.namespaceId ||
    original.scope.agentRef !== scope.agentId ||
    original.requestDigest !== request.request_sha256 ||
    !digest.test(original.requestDigest) ||
    !reference(original.scope.revisionRef) ||
    attempt.installationRef !== scope.installationId ||
    attempt.namespaceRef !== scope.namespaceId ||
    attempt.agentRef !== scope.agentId ||
    value.service.kind !== "service_principal" ||
    !reference(value.service.id) ||
    (value.service.namespaceId !== undefined && value.service.namespaceId !== scope.namespaceId) ||
    (value.service.agentId !== undefined && value.service.agentId !== scope.agentId) ||
    !reference(original.operationRef) ||
    !reference(original.invocationRef) ||
    !reference(value.work.workRef) ||
    !Number.isSafeInteger(value.work.revision) ||
    value.work.revision < 1 ||
    !reference(execution.assignmentRef) ||
    !reference(execution.assignmentVersion) ||
    !reference(execution.executionIncarnationRef) ||
    !reference(execution.executionGeneration) ||
    !reference(execution.receiverRef) ||
    !reference(execution.protectedOriginRef) ||
    !reference(execution.executionProfile.ref) ||
    !reference(execution.executionProfile.revision)
  )
    throw failure();
  if (execution.predecessor.kind !== "none") {
    if (execution.predecessor.kind !== "terminated-original") throw failure();
    const predecessor = execution.predecessor;
    const prior = parseCompletedContextV1("exactAttempt", predecessor.attempt);
    if (
      prior.installationRef !== scope.installationId ||
      prior.namespaceRef !== scope.namespaceId ||
      prior.agentRef !== scope.agentId ||
      encode(prior) === encode(attempt) ||
      !reference(predecessor.assignmentRef) ||
      !reference(predecessor.executionIncarnationRef) ||
      !reference(predecessor.terminationEvidenceRef)
    )
      throw failure();
  }
  if (instant(value.validUntil) > instant(value.operationUntil)) throw failure();
  return value;
}

type Entry<N, A, V extends GitHubMediationVersion> = {
  readonly cancellation: AbortController;
  readonly pending: Set<Promise<unknown>>;
  readonly request: OpenRead<V>;
  readonly began: number;
  readonly wallBegan: number;
  readonly clock: GitHubMediationClockSample;
  readonly recipientRef: string;
  native?: N | undefined;
  assignment?: A | undefined;
  readonly originalCallSignal: AbortSignal;
  context?: AuthorityCallV1["context"];
  transport?: RuntimeAuthorityVerifiedServiceV1["transportBinding"];
  lifetime?: AbortSignal;
  sessionRef?: string;
  registry?: string;
  original?: Readonly<RepositoryWorkOriginAssignmentV2<V>>;
  fixed?: string;
  operationEnd: number;
  leaseEnd: number;
  callCutoff?: Readonly<{
    absoluteDeadline: string;
    clock: GitHubMediationClockSample;
    monotonicDeadline: number;
  }>;
  lastClock: GitHubMediationClockSample;
  timer?: ReturnType<typeof setTimeout>;
  stopNative?: () => void;
  closing: boolean;
  running: boolean;
  cleanup?: Promise<void>;
};

/** Trusted assembly captures the actual native and State owners once. The
 * returned origin is private Runtime custody; neither a copied handle nor any
 * projected facts can create one. This is distinct from Work preparation P/R. */
export class RepositoryWorkOriginOwnerV2<
  N = never,
  A = never,
  V extends GitHubMediationVersion = 2,
> {
  private readonly entries = new WeakMap<object, Entry<N, A, V>>();
  private readonly active = new Set<Entry<N, A, V>>();
  private closed = false;
  private readonly native: RepositoryWorkNativeSessionSourceV2<N, V>;
  private readonly assignments: RepositoryWorkOriginAssignmentSourceV2<A, N, V>;
  private readonly protocolVersion: V;
  private readonly readRegistry: RuntimeServiceTrustService["readCurrentRecord"];
  private readonly limits: RepositoryWorkOriginLimitsV2;

  constructor(
    options: {
      trust: RuntimeServiceTrustService;
      native: RepositoryWorkNativeSessionSourceV2<N, NoInfer<V>>;
      assignments: RepositoryWorkOriginAssignmentSourceV2<A, N, NoInfer<V>>;
      nativeCustody?: RepositoryWorkOriginNativeCustodyV2<N, NoInfer<V>>;
      limits: RepositoryWorkOriginLimitsV2;
      protocolVersion?: V;
    } & (V extends 2 ? { protocolVersion?: 2 } : { protocolVersion: 3 }) &
      ([GitHubMediationVersion] extends [V] ? never : unknown),
  ) {
    const version = options.protocolVersion === undefined ? 2 : options.protocolVersion;
    if (version !== 2 && version !== 3) throw failure();
    this.protocolVersion = version as V;
    const limits = plain(options.limits) as RepositoryWorkOriginLimitsV2;
    const keys = [
      "maximumOrigins",
      "maximumCallMilliseconds",
      "maximumOperationMilliseconds",
      "maximumLeaseMilliseconds",
      "clockAllowanceMilliseconds",
    ];
    if (
      Object.keys(limits).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(limits, key))
    )
      throw failure();
    for (const [key, value] of Object.entries(limits))
      if (
        !Number.isSafeInteger(value) ||
        value < (key === "clockAllowanceMilliseconds" ? 0 : 1) ||
        value > 2147483647
      )
        throw failure();
    if (limits.clockAllowanceMilliseconds >= limits.maximumLeaseMilliseconds) throw failure();
    this.limits = Object.freeze(limits);
    this.readRegistry = options.trust.readCurrentRecord.bind(options.trust);
    this.native = Object.freeze({
      acquire: options.native.acquire.bind(options.native),
      inspect: options.native.inspect.bind(options.native),
      assertCurrent: options.native.assertCurrent.bind(options.native),
      release: options.native.release.bind(options.native),
    });
    this.assignments = Object.freeze({
      bindOrigins: options.assignments.bindOrigins.bind(options.assignments),
      acquire: options.assignments.acquire.bind(options.assignments),
      inspect: options.assignments.inspect.bind(options.assignments),
      assertCurrent: options.assignments.assertCurrent.bind(options.assignments),
      release: options.assignments.release.bind(options.assignments),
    });
    const result = this.assignments.bindOrigins(
      Object.freeze({
        recognize: (origin: OriginalRepositoryWorkOriginV2<V>, call: AuthorityCallV1): A => {
          const entry = this.member(origin);
          // State uses this original operand to acquire its current readset.
          // Requiring that readset's final assertion here would prevent refresh.
          this.assert(entry, call, true, "native");
          if (entry.assignment === undefined) throw failure();
          return entry.assignment;
        },
      }),
    );
    if (result !== undefined) throw failure();
    const custody = options.nativeCustody;
    if (custody !== undefined) {
      const bindOrigins = custody.bindOrigins.bind(custody);
      const bound = bindOrigins(
        Object.freeze({
          recognize: (origin: OriginalRepositoryWorkOriginV2<V>, call: AuthorityCallV1): N => {
            const entry = this.member(origin);
            try {
              // Work refreshes its original Runtime/State readset before this
              // synchronous lookup. Recognition cannot refresh an expired call.
              this.assert(entry, call);
              if (entry.native === undefined || entry.original === undefined) throw failure();
              return entry.native;
            } catch {
              void this.retire(entry);
              throw failure();
            }
          },
          recognizeNative: (
            origin: OriginalRepositoryWorkOriginV2<V>,
            call: AuthorityCallV1,
          ): N => {
            const entry = this.member(origin);
            try {
              // The fixed custody receiver deliberately selects correspondence
              // during the SQL handoff; this cannot supply State authority.
              if (entry.native === undefined || entry.original === undefined) throw failure();
              this.assert(entry, call, true, "native");
              return entry.native;
            } catch {
              void this.retire(entry);
              throw failure();
            }
          },
        }),
      );
      if (bound !== undefined) throw failure();
    }
  }

  private clock(entry: Entry<N, A, V>): number {
    const now = sampleGitHubMediationClock();
    if (
      !githubMediationClockContinuous(entry.clock, now, this.limits.clockAllowanceMilliseconds) ||
      !githubMediationClockContinuous(entry.lastClock, now, this.limits.clockAllowanceMilliseconds)
    )
      throw failure();
    entry.lastClock = now;
    return now.after;
  }
  private deadline(clock: GitHubMediationClockSample, value: string): number {
    const deadline = githubMediationMonotonicDeadline(
      clock,
      instant(value),
      this.limits.clockAllowanceMilliseconds,
    );
    if (deadline === undefined) throw failure();
    return deadline;
  }
  private synchronous(entry: Entry<N, A, V>, result: unknown): void {
    if (result === undefined) return;
    // A mistakenly asynchronous final assertion cannot grant currentness. Its
    // accepted continuation still belongs to this origin and must be joined.
    const pending = Promise.resolve(result);
    entry.pending.add(pending);
    void pending.finally(() => entry.pending.delete(pending)).catch(() => {});
    throw failure();
  }
  private member(origin: OriginalRepositoryWorkOriginV2<V>): Entry<N, A, V> {
    const entry = origin && typeof origin === "object" ? this.entries.get(origin) : undefined;
    if (!entry || entry.closing) throw failure();
    return entry;
  }
  private assertLocal(
    entry: Entry<N, A, V>,
    call: AuthorityCallV1,
    lease: boolean,
    checkCallCutoff: boolean,
  ): void {
    const now = this.clock(entry);
    if (
      entry.closing ||
      entry.cancellation.signal.aborted ||
      call.signal.aborted ||
      call.requestRef !== entry.request.request_ref ||
      call.recipientRef !== entry.recipientRef ||
      Date.now() >= instant(call.deadline) ||
      now >= entry.operationEnd ||
      (lease && now >= entry.leaseEnd) ||
      entry.lifetime?.aborted
    )
      throw failure();
    if (entry.context !== undefined && entry.context !== call.context) throw failure();
    if (
      checkCallCutoff &&
      (entry.callCutoff === undefined ||
        entry.callCutoff.absoluteDeadline !== call.deadline ||
        now >= entry.callCutoff.monotonicDeadline ||
        !githubMediationClockContinuous(
          entry.callCutoff.clock,
          entry.lastClock,
          this.limits.clockAllowanceMilliseconds,
        ))
    )
      throw failure();
  }
  private assert(
    entry: Entry<N, A, V>,
    call: AuthorityCallV1,
    lease = true,
    sources: "none" | "native" | "all" = "all",
    checkCallCutoff = true,
  ): void {
    this.assertLocal(entry, call, lease, checkCallCutoff);
    if (sources !== "none" && entry.native !== undefined)
      this.synchronous(entry, this.native.assertCurrent(entry.native, call));
    if (sources === "all" && entry.assignment !== undefined)
      this.synchronous(entry, this.assignments.assertCurrent(entry.assignment));
    // A synchronous original-owner assertion may itself consume the remaining
    // time. Timer delivery is not required for this final local cutoff fence.
    this.assertLocal(entry, call, lease, checkCallCutoff);
  }
  private async run<T>(
    entry: Entry<N, A, V>,
    call: AuthorityCallV1,
    work: (bounded: AuthorityCallV1, clock: GitHubMediationClockSample) => Promise<T>,
    finalSources: "native" | "all" = "all",
  ): Promise<T> {
    // Each RPC has a new Exchange. Native/State inspection must recognize that
    // Exchange before their synchronous currentness assertions can accept it.
    this.assert(entry, call, entry.original !== undefined, "none", false);
    if (entry.running) throw failure();
    const clock = sampleGitHubMediationClock();
    const cutoff = Math.min(
      clock.before + this.limits.maximumCallMilliseconds,
      this.deadline(clock, call.deadline),
      entry.operationEnd,
      entry.original === undefined ? Infinity : entry.leaseEnd,
      // Narrowed wrappers of the same original RPC cannot reset its cutoff.
      // This is a time restriction only; native membership is still checked
      // by the original native owner for every actual Exchange.
      entry.callCutoff?.absoluteDeadline === call.deadline
        ? entry.callCutoff.monotonicDeadline
        : Infinity,
    );
    const remaining = cutoff - clock.after;
    if (!(remaining > 0)) throw failure();
    entry.callCutoff = Object.freeze({
      absoluteDeadline: call.deadline,
      clock,
      monotonicDeadline: cutoff,
    });
    const timed = new AbortController();
    const timer = setTimeout(() => timed.abort(), remaining);
    const signal = AbortSignal.any([call.signal, entry.cancellation.signal, timed.signal]);
    const bounded = Object.freeze({ ...call, signal });
    let abort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(failure());
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    entry.running = true;
    const pending = Promise.resolve().then(() => work(bounded, clock));
    entry.pending.add(pending);
    pending
      .finally(() => {
        entry.pending.delete(pending);
        entry.running = false;
      })
      .catch(() => {});
    try {
      const result = await Promise.race([pending, aborted]);
      this.assert(entry, bounded, entry.original !== undefined, finalSources);
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  private retire(entry: Entry<N, A, V>): Promise<void> {
    if (entry.cleanup) return entry.cleanup;
    entry.closing = true;
    entry.cancellation.abort();
    if (entry.timer) clearTimeout(entry.timer);
    entry.stopNative?.();
    entry.cleanup = (async () => {
      // Late original-owner acquisitions remain charged and joined before release.
      while (entry.pending.size) await Promise.allSettled([...entry.pending]);
      const released = await Promise.allSettled([
        entry.assignment === undefined
          ? Promise.resolve()
          : Promise.resolve().then(() => this.assignments.release(entry.assignment!)),
        entry.native === undefined
          ? Promise.resolve()
          : Promise.resolve().then(() => this.native.release(entry.native!)),
      ]);
      if (released.some((result) => result.status === "rejected")) {
        this.closed = true;
        throw failure();
      }
      this.active.delete(entry);
    })();
    entry.cleanup.catch(() => {});
    return entry.cleanup;
  }
  private async registry(
    entry: Entry<N, A, V>,
    verified: RuntimeAuthorityVerifiedServiceV1,
    call: AuthorityCallV1,
  ): Promise<void> {
    const record = await this.readRegistry(verified.configuration.serviceIdentityRef, call.signal);
    this.assert(entry, call, false, "native");
    if (
      !record ||
      record.admission.profile.operationPolicy !==
        (this.protocolVersion === 3 ? "github-git-read-rpc-v3" : "github-metadata-rpc-v2") ||
      record.admission.profile.transportProfileRef !==
        (this.protocolVersion === 3
          ? "owned-child-stdio-github-git-read-v3"
          : "owned-child-stdio-github-metadata-v2") ||
      record.admission.configuration.role !== "repository-issuer" ||
      record.admission.configuration.allowedScope.kind !== "agent" ||
      record.admission.configuration.permittedRecipientRef !== call.recipientRef ||
      canonicalRuntimeServiceTrust(record.admission.configuration) !==
        canonicalRuntimeServiceTrust(verified.configuration)
    )
      throw failure();
    const encoded = canonicalRuntimeServiceTrust(record);
    if (entry.registry !== undefined && entry.registry !== encoded) throw failure();
    entry.registry = encoded;
  }
  private async observeNative(entry: Entry<N, A, V>, call: AuthorityCallV1) {
    if (entry.native === undefined) throw failure();
    const observed = await this.native.inspect(entry.native, call);
    this.assert(entry, call, false, "native");
    if (
      observed.context !== call.context ||
      observed.lifetime === call.signal ||
      observed.lifetime === entry.originalCallSignal ||
      observed.lifetime.aborted ||
      !reference(observed.sessionRef) ||
      (entry.context !== undefined &&
        (entry.context !== observed.context ||
          entry.transport !== observed.verified.transportBinding ||
          entry.sessionRef !== observed.sessionRef ||
          entry.lifetime !== observed.lifetime))
    )
      throw failure();
    if (!entry.lifetime) {
      entry.context = observed.context;
      entry.transport = observed.verified.transportBinding;
      entry.sessionRef = observed.sessionRef;
      entry.lifetime = observed.lifetime;
      const abort = () => {
        void this.retire(entry);
      };
      observed.lifetime.addEventListener("abort", abort, { once: true });
      entry.stopNative = () => observed.lifetime.removeEventListener("abort", abort);
    }
    await this.registry(entry, observed.verified, call);
    return observed;
  }
  private async refresh(
    entry: Entry<N, A, V>,
    call: AuthorityCallV1,
    clock: GitHubMediationClockSample,
  ): Promise<RepositoryWorkNativeBindingV2> {
    if (entry.native === undefined) throw failure();
    const observed = await this.observeNative(entry, call);
    if (entry.assignment === undefined) {
      entry.assignment = await this.assignments.acquire(entry.request, entry.native, call);
      this.assert(entry, call, false, "native");
      if (entry.assignment === undefined) throw failure();
    }
    const held = await this.assignments.inspect(entry.assignment, call);
    this.assert(entry, call, false);
    const value = compareRepositoryWorkOriginAssignmentV2(held, entry.request, observed.verified);
    const { validUntil: _validUntil, ...fixed } = value;
    const encoded = encode(fixed);
    if (entry.fixed !== undefined && entry.fixed !== encoded) throw failure();
    const operationEnd = Math.min(
      entry.began + this.limits.maximumOperationMilliseconds,
      this.deadline(entry.clock, value.operationUntil),
      this.deadline(entry.clock, observed.verified.expiresAt),
    );
    entry.operationEnd = Math.min(entry.operationEnd, operationEnd);
    entry.leaseEnd = Math.min(
      entry.operationEnd,
      clock.before + this.limits.maximumLeaseMilliseconds - this.limits.clockAllowanceMilliseconds,
      this.deadline(clock, value.validUntil),
      this.deadline(clock, observed.verified.expiresAt),
    );
    this.assert(entry, call);
    await this.registry(entry, observed.verified, call);
    this.assert(entry, call);
    entry.original = value;
    entry.fixed = encoded;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => {
        void this.retire(entry);
      },
      Math.max(1, entry.leaseEnd - performance.now()),
    );
    return Object.freeze({
      context: observed.context,
      transportBinding: observed.verified.transportBinding,
      attachmentRef: value.attachmentRef,
      receiverRef: value.execution.receiverRef,
      execution: value.execution,
      service: value.service,
    });
  }

  async acquire(
    request: OpenRead<V>,
    call: AuthorityCallV1,
  ): Promise<OriginalRepositoryWorkOriginV2<V> | undefined> {
    if (this.closed || this.active.size >= this.limits.maximumOrigins) return undefined;
    let copied: OpenRead<V>;
    try {
      const decoded = decodeGitHubMediationRequest(
        Buffer.from(encode(plain(request))),
        this.protocolVersion,
      );
      if (!decoded || decoded.method !== "open-read" || decoded.request_ref !== call.requestRef)
        return undefined;
      // The original versioned decoder already returns a frozen declaration.
      copied = decoded;
    } catch {
      return undefined;
    }
    const clock = sampleGitHubMediationClock();
    const began = clock.before;
    const wallBegan = clock.wall;
    const entry: Entry<N, A, V> = {
      request: copied,
      originalCallSignal: call.signal,
      cancellation: new AbortController(),
      pending: new Set(),
      began,
      wallBegan,
      clock,
      recipientRef: call.recipientRef,
      lastClock: clock,
      operationEnd: began + this.limits.maximumOperationMilliseconds,
      leaseEnd: Infinity,
      closing: false,
      running: false,
    };
    this.active.add(entry);
    try {
      await this.run(entry, call, async (bounded, clock) => {
        entry.native = await this.native.acquire(copied, bounded);
        this.assert(entry, bounded, false);
        if (entry.native === undefined) throw failure();
        await this.refresh(entry, bounded, clock);
      });
      this.assert(entry, call);
      const origin = Object.freeze(Object.create(null)) as OriginalRepositoryWorkOriginV2<V>;
      this.entries.set(origin, entry);
      return origin;
    } catch {
      void this.retire(entry);
      return undefined;
    }
  }
  async inspect(
    origin: OriginalRepositoryWorkOriginV2<V>,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkNativeBindingV2> {
    const entry = this.member(origin);
    try {
      return await this.run(entry, call, (bounded, clock) => this.refresh(entry, bounded, clock));
    } catch {
      void this.retire(entry);
      throw failure();
    }
  }
  /** Authenticates the actual next native Exchange without reopening State SQL.
   * Original Work captures this method before its State readset handoff. */
  async inspectNative(
    origin: OriginalRepositoryWorkOriginV2<V>,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkNativeBindingV2> {
    const entry = this.member(origin);
    try {
      const original = entry.original;
      if (entry.native === undefined || original === undefined) throw failure();
      return await this.run(
        entry,
        call,
        async (bounded, clock) => {
          const observed = await this.observeNative(entry, bounded);
          // Refresh may shorten the original horizons, but cannot replace the
          // held State lease or grant another operation/session lifetime.
          entry.operationEnd = Math.min(
            entry.operationEnd,
            this.deadline(entry.clock, observed.verified.expiresAt),
          );
          const leaseEnd = Math.min(
            entry.leaseEnd,
            entry.operationEnd,
            this.deadline(clock, observed.verified.expiresAt),
          );
          if (leaseEnd < entry.leaseEnd) {
            entry.leaseEnd = leaseEnd;
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = setTimeout(
              () => {
                void this.retire(entry);
              },
              Math.max(1, leaseEnd - performance.now()),
            );
          }
          this.assert(entry, bounded, true, "native");
          await this.registry(entry, observed.verified, bounded);
          this.assert(entry, bounded, true, "native");
          return Object.freeze({
            context: observed.context,
            transportBinding: observed.verified.transportBinding,
            attachmentRef: original.attachmentRef,
            receiverRef: original.execution.receiverRef,
            execution: original.execution,
            service: original.service,
          });
        },
        "native",
      );
    } catch {
      void this.retire(entry);
      throw failure();
    }
  }
  assertCurrent(origin: OriginalRepositoryWorkOriginV2<V>, call: AuthorityCallV1): void {
    const entry = this.member(origin);
    try {
      this.assert(entry, call);
    } catch {
      void this.retire(entry);
      throw failure();
    }
  }
  /** Original Work captures this separate fence for its SQL-readset handoff.
   * It recognizes native membership/current Exchange only; State authority must
   * be reacquired through the original unit before full assertCurrent can pass. */
  assertNativeCurrent(origin: OriginalRepositoryWorkOriginV2<V>, call: AuthorityCallV1): void {
    const entry = this.member(origin);
    try {
      if (entry.native === undefined || entry.original === undefined) throw failure();
      this.assert(entry, call, true, "native");
    } catch {
      void this.retire(entry);
      throw failure();
    }
  }
  async release(origin: OriginalRepositoryWorkOriginV2<V>): Promise<void> {
    const entry = origin && typeof origin === "object" ? this.entries.get(origin) : undefined;
    if (!entry) throw failure();
    await this.retire(entry);
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.active].map((entry) => this.retire(entry)));
  }
}
