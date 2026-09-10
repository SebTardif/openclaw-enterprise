import { createHash } from "node:crypto";
import { types } from "node:util";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { ServicePrincipal } from "@openclaw-enterprise/contracts/identity/identity";
import {
  githubMediationClockContinuous,
  githubMediationMonotonicDeadline,
  sampleGitHubMediationClock,
  type GitHubMediationClockSample,
} from "../github-mediation-v2/clock.ts";
import type {
  GitHubMediationOperationOwner,
  GitHubMediationOutcome,
  GitHubMediationPreparation,
  GitHubMediationRefusal,
  GitHubMediationRelease,
} from "../github-mediation-v2/ports.ts";
import {
  decodeGitHubMediationRequest,
  encodeGitHubMediationMetadata,
  githubGitReadDigest,
  type GitHubMediationVersion,
  METADATA_LIMIT,
  type DispatchRead,
  type GitHubMediationTimes,
  type OpenRead,
} from "../github-mediation-v2/wire.ts";
import type {
  VersionedWorkRefV2,
  WorkExecutionAssociationV2,
  WorkInstantV2,
  WorkLineageV2,
  WorkOriginalOperationV2,
  WorkProfileRefV2,
  WorkWithdrawalStateV2,
  WorkRepositoryPolicyArmV2,
  WorkRepositoryProtocolOptionsV2,
  WorkRepositoryProtocolSelectionV2,
  WorkRepositoryGitReadV3,
} from "./work-authority-ports-v2.ts";

import { repositoryWorkPolicyArmMatchesV2 } from "./repository-work-policy-v2.ts";

const unavailable = (): GitHubMediationRefusal => ({ kind: "refused", code: "unavailable" });
const failure = () => new Error("Repository Work unavailable.");
const MAX_TIME = 253_402_300_799_999;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const reference = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}(?![\s\S])/.test(value);
const profile = (value: WorkProfileRefV2): boolean =>
  reference(value.ref) && reference(value.revision);

/** Data read under the original State participant. This projection is not a
 * grant or a private readset, and cannot independently create a preparation. */
export type RepositoryWorkCurrentV2<V extends GitHubMediationVersion = 2> = {
  readonly original: WorkOriginalOperationV2;
  readonly work: VersionedWorkRefV2;
  readonly execution: WorkExecutionAssociationV2;
  readonly lineage: WorkLineageV2;
  /** Same order as own Work followed by the complete ordered ancestry. */
  readonly withdrawals: readonly WorkWithdrawalStateV2[];
  readonly service: ServicePrincipal;
  readonly originalHorizon: WorkInstantV2;
  readonly repository: Readonly<{
    id: string;
    owner: string;
    name: string;
    profile: WorkProfileRefV2;
  }>;
  readonly policy: Readonly<{
    operation: "work.repository.use";
    service: ServicePrincipal;
    repositoryId: string;
    profile: WorkProfileRefV2;
  }> &
    WorkRepositoryPolicyArmV2<V>;
  readonly attachmentRef: string;
  readonly dnsBindingRef: string;
  readonly upstreamIpv4: string;
  readonly validUntil: WorkInstantV2;
} & (V extends 3
  ? { readonly repositoryRequest: WorkRepositoryGitReadV3 }
  : { readonly repositoryRequest?: never });

/** Actual native owner supplies these observations only after private original
 * exchange, attachment, assignment and service-purpose recognition. */
export interface RepositoryWorkNativeBindingV2 {
  readonly context: AuthorityCallV1["context"];
  readonly transportBinding: object;
  readonly attachmentRef: string;
  readonly receiverRef: string;
  readonly execution: WorkExecutionAssociationV2;
  readonly service: ServicePrincipal;
}

export interface RepositoryWorkPrivateBindingsV2 {
  readonly origin: unknown;
  readonly preparation: unknown;
  readonly token: unknown;
  readonly commit: unknown;
}
type MissingBindings = { readonly [K in keyof RepositoryWorkPrivateBindingsV2]: never };

/** Construction dependencies, captured once by the trusted service assembly.
 * Each source must recognize its own original operands at runtime. Implementing
 * this TypeScript interface with a positive callback supplies no such authority.
 * No native source, transaction owner or custody implementation is installed by
 * this interface. The concrete adapters remain required production dependencies.
 */
export interface RepositoryWorkSourcesV2<
  B extends RepositoryWorkPrivateBindingsV2 = MissingBindings,
  in out V extends GitHubMediationVersion = 2,
> {
  readonly native: {
    /** Own late acquisition cleanup even when acquisition cannot return a handle. */
    readonly acquire: (
      request: OpenRead<V>,
      call: AuthorityCallV1,
    ) => Promise<B["origin"] | undefined>;
    inspect(origin: B["origin"], call: AuthorityCallV1): Promise<RepositoryWorkNativeBindingV2>;
    /** Enroll the original fresh native Exchange before any cutoff-dependent
     * fence. No State acquisition and no renewal of an existing call's bounds. */
    inspectNative(
      origin: B["origin"],
      call: AuthorityCallV1,
    ): Promise<RepositoryWorkNativeBindingV2>;
    /** Native membership/current exchange only; safe while the original State
     * readset is retired. This never substitutes for full same-unit currentness. */
    assertNativeCurrent(origin: B["origin"], call: AuthorityCallV1): void;
    assertCurrent(origin: B["origin"], call: AuthorityCallV1): void;
    /** Release this Work owner's separately held exchange lease, independent
     * of temporary RPC signals. The broker still owns terminal metadata and
     * final transport close; releasing this lease must not close that sink. */
    release(origin: B["origin"]): Promise<void>;
  };
  readonly state: {
    /** Resolves/adopts original logical Work through actual service admission.
     * The source owns any unknown preparation COMMIT before returning a handle. */
    prepare(
      origin: B["origin"],
      request: OpenRead<V>,
      call: AuthorityCallV1,
    ): Promise<B["preparation"] | undefined>;
    /** Read the recorded preparation operation from this original private P.
     * Broker effect_ref identifies preparation, not the later dispatch operation. */
    readPreparationOriginal(
      preparation: B["preparation"],
      origin: B["origin"],
      call: AuthorityCallV1,
    ): Promise<WorkOriginalOperationV2>;
    readCurrent(
      preparation: B["preparation"],
      origin: B["origin"],
      call: AuthorityCallV1,
    ): Promise<RepositoryWorkCurrentV2<V>>;
    /** Same original closure-conflicting transaction re-reads and compares the
     * complete expectation and current repository-use policy, recognizes the
     * token/receiver, records separate business dispatch and credential exposure,
     * drains/poisons accepted work and performs its synchronous final COMMIT
     * fence. No network/provider operation runs inside this transaction.
     * This owner supplies the actual outer acknowledgment, not a staged receipt.
     */
    commitDispatch(
      preparation: B["preparation"],
      origin: B["origin"],
      token: B["token"],
      request: DispatchRead<V>,
      expected: RepositoryWorkCurrentV2<V>,
      call: AuthorityCallV1,
    ): Promise<
      | Readonly<{ kind: "committed"; receipt: B["commit"] }>
      | Readonly<{ kind: "not-committed" }>
      | Readonly<{ kind: "unknown" }>
    >;
    /** Runtime recognition of the original known-committed receipt and exact
     * preparation/token association; returns no authority-bearing DTO. */
    inspectCommitted(
      receipt: B["commit"],
      preparation: B["preparation"],
      token: B["token"],
    ): Readonly<{ releaseRef: string }>;
    /** Exact original recovery/observation only, after the original unit joins.
     * Unknown commit with no returned receipt is resolved from preparation's
     * retained operation. Missing response is never evidence of noncommit.
     */
    settle(
      preparation: B["preparation"],
      receipt: B["commit"] | undefined,
      outcome: GitHubMediationOutcome,
    ): Promise<"recorded" | "unavailable">;
  };
  readonly custody: {
    /** Existing inventory/provider operation outside the final State transaction.
     * Source retains mint uncertainty and cleanup before returning/throwing. */
    prepareToken(
      preparation: B["preparation"],
      origin: B["origin"],
      call: AuthorityCallV1,
    ): Promise<B["token"] | undefined>;
    /** Fixed original native sink, use-specific private receipt recognition.
     * No caller-selected sink, token getter or exact-revoke authority alias. */
    writeCommitted(
      receipt: B["commit"],
      metadata: Uint8Array,
      call: AuthorityCallV1,
    ): Promise<void>;
    settleToken(token: B["token"]): Promise<void>;
  };
}

declare const preparationBrand: unique symbol;
declare const releaseBrand: unique symbol;
export type OriginalRepositoryPreparationV2<V extends GitHubMediationVersion = 2> = {
  readonly [preparationBrand]: (version: V) => V;
};
export type OriginalCommittedRepositoryReleaseV2<V extends GitHubMediationVersion = 2> = {
  readonly [releaseBrand]: (version: V) => V;
};
export interface RepositoryWorkLimitsV2 {
  readonly maximumPreparations: number;
  readonly maximumOperationMilliseconds: number;
  readonly maximumLeaseMilliseconds: number;
  readonly clockAllowanceMilliseconds: number;
}

/** Copy bounded plain data without invoking accessors, toJSON or proxy traps. */
function data<T>(input: T): T {
  let budget = 65_536;
  let nodes = 4096;
  function copy(value: unknown, depth: number): unknown {
    if (--nodes < 0 || depth > 16) throw failure();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      budget -= Buffer.byteLength(value);
      if (budget < 0) throw failure();
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw failure();
      return value;
    }
    if (!value || typeof value !== "object" || types.isProxy(value)) throw failure();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) throw failure();
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    const keys = Reflect.ownKeys(value).filter((key) => !(array && key === "length"));
    if (array && (keys.length !== value.length || value.length > 4096)) throw failure();
    for (const key of keys.sort((a, b) =>
      String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
    )) {
      if (typeof key !== "string" || key === "__proto__") throw failure();
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) throw failure();
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw failure();
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    return Object.freeze(result);
  }
  return copy(input, 0) as T;
}
const canonical = (value: unknown): string => JSON.stringify(data(value));
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function field<T>(object: T, key: keyof T): T[keyof T] {
  if (!object || typeof object !== "object" || types.isProxy(object)) throw failure();
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor)) throw failure();
  return descriptor.value;
}
function captureCall(input: AuthorityCallV1): AuthorityCallV1 {
  const context = field(input, "context") as AuthorityCallV1["context"];
  const signal = field(input, "signal") as AbortSignal;
  const requestRef = field(input, "requestRef") as string;
  const recipientRef = field(input, "recipientRef") as string;
  const deadline = field(input, "deadline") as string;
  if (
    !context ||
    typeof context !== "object" ||
    types.isProxy(context) ||
    types.isProxy(signal) ||
    !(signal instanceof AbortSignal) ||
    typeof requestRef !== "string" ||
    typeof recipientRef !== "string" ||
    typeof deadline !== "string"
  )
    throw failure();
  instant(deadline);
  return Object.freeze({ context, signal, requestRef, recipientRef, deadline });
}
function instant(value: string): number {
  const time = Date.parse(value);
  if (
    !Number.isSafeInteger(time) ||
    time < 0 ||
    time > MAX_TIME ||
    new Date(time).toISOString() !== value
  )
    throw failure();
  return time;
}

/** Extract the exact permission arm; common policy association is checked separately. */
export function repositoryWorkCurrentPolicyArmV2<V extends GitHubMediationVersion>(
  current: RepositoryWorkCurrentV2<V>,
): unknown {
  const {
    operation: _operation,
    service: _service,
    repositoryId: _repositoryId,
    profile: _profile,
    ...arm
  } = current.policy;
  return arm;
}
/** Canonical retained declaration, never a provider request or authority object. */
export function repositoryWorkGitReadBindingV3(request: OpenRead<3>): WorkRepositoryGitReadV3 {
  request = data(request);
  const decoded = decodeGitHubMediationRequest(
    new TextEncoder().encode(JSON.stringify(request)),
    3,
  );
  if (
    decoded?.method !== "open-read" ||
    request.request_sha256 !==
      githubGitReadDigest(
        request.repository_owner,
        request.repository_name,
        request.git_operation,
        request.body_bytes,
        request.body_sha256,
      )
  )
    throw failure();
  return data({
    version: 3,
    operation: "git:read",
    gitOperation: request.git_operation,
    gitProtocol: request.git_protocol,
    bodyBytes: request.body_bytes,
    bodySha256: request.body_sha256,
    requestDigest: request.request_sha256,
  });
}

/** Evaluates already acquired current data, not provenance. Only an actual
 * original State/native transaction can authorize or commit the resulting use.
 * All lineage/withdrawal rows must have been acquired by that same readset owner.
 */
export function compareRepositoryWorkCurrentV2<V extends GitHubMediationVersion = 2>(
  input: RepositoryWorkCurrentV2<V>,
  request: OpenRead<V>,
  native: RepositoryWorkNativeBindingV2,
  now: number,
  version: V = 2 as V,
): RepositoryWorkCurrentV2<V> {
  const current = data(input);
  request = data(request);
  const decoded = decodeGitHubMediationRequest(
    new TextEncoder().encode(JSON.stringify(request)),
    version,
  );
  if (
    decoded?.method !== "open-read" ||
    !repositoryWorkPolicyArmMatchesV2(version, repositoryWorkCurrentPolicyArmV2(current)) ||
    (version === 3
      ? !same(current.repositoryRequest, repositoryWorkGitReadBindingV3(request as OpenRead<3>))
      : Object.hasOwn(current, "repositoryRequest"))
  )
    throw failure();
  const members = [current.lineage.own, ...current.lineage.ancestors];
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > MAX_TIME ||
    !reference(current.original.operationRef) ||
    !reference(current.original.invocationRef) ||
    !reference(current.original.scope.installationRef) ||
    !reference(current.original.scope.namespaceRef) ||
    !reference(current.original.scope.agentRef) ||
    !reference(current.original.scope.revisionRef) ||
    !reference(current.service.id) ||
    !reference(current.repository.id) ||
    !profile(current.repository.profile) ||
    !profile(current.lineage.membershipProfile) ||
    !profile(current.execution.executionProfile) ||
    current.original.requestDigest !== request.request_sha256 ||
    !same(current.original.scope, current.lineage.scope) ||
    !same(current.work, current.lineage.own.work) ||
    current.execution.attempt.installationRef !== current.original.scope.installationRef ||
    current.execution.attempt.namespaceRef !== current.original.scope.namespaceRef ||
    current.execution.attempt.agentRef !== current.original.scope.agentRef ||
    !same(current.execution, native.execution) ||
    current.execution.receiverRef !== native.receiverRef ||
    current.attachmentRef !== request.attachment_ref ||
    current.attachmentRef !== native.attachmentRef ||
    !same(current.service, native.service) ||
    current.service.kind !== "service_principal" ||
    (current.service.namespaceId !== undefined &&
      current.service.namespaceId !== current.original.scope.namespaceRef) ||
    (current.service.agentId !== undefined &&
      current.service.agentId !== current.original.scope.agentRef) ||
    !same(current.policy.service, current.service) ||
    current.policy.operation !== "work.repository.use" ||
    current.policy.repositoryId !== current.repository.id ||
    !same(current.policy.profile, current.repository.profile) ||
    current.repository.owner !== request.repository_owner ||
    current.repository.name !== request.repository_name ||
    instant(current.originalHorizon) <= now ||
    instant(current.validUntil) <= now ||
    instant(current.validUntil) > instant(current.originalHorizon) ||
    current.withdrawals.length !== members.length ||
    new Set(members.map((member) => member.work.workRef)).size !== members.length
  )
    throw failure();
  for (let index = 0; index < members.length; index++) {
    const member = members[index]!;
    const withdrawal = current.withdrawals[index]!;
    if (
      !reference(member.work.workRef) ||
      !Number.isSafeInteger(member.work.revision) ||
      member.work.revision <= 0 ||
      !Number.isSafeInteger(member.withdrawalRevision) ||
      member.withdrawalRevision < 0 ||
      member.state !== "open" ||
      withdrawal.kind !== "not-withdrawn-at-cut" ||
      withdrawal.revision !== member.withdrawalRevision ||
      instant(member.originalHorizon) < instant(current.originalHorizon)
    )
      throw failure();
  }
  if (current.lineage.kind === "root") {
    if (
      current.lineage.ancestors.length !== 0 ||
      current.lineage.parentWorkRef !== null ||
      current.lineage.rootWorkRef !== current.work.workRef
    )
      throw failure();
  } else if (current.lineage.kind === "attached-child") {
    if (
      current.lineage.ancestors.length === 0 ||
      current.lineage.ancestors[0].work.workRef !== current.lineage.rootWorkRef ||
      current.lineage.ancestors.at(-1)!.work.workRef !== current.lineage.parentWorkRef
    )
      throw failure();
  } else throw failure();
  return current;
}

type Entry<B extends RepositoryWorkPrivateBindingsV2, V extends GitHubMediationVersion> = {
  origin: B["origin"];
  request: OpenRead<V>;
  state?: B["preparation"];
  token?: B["token"];
  commit?: B["commit"];
  original?: RepositoryWorkCurrentV2<V>;
  preparationOriginal?: WorkOriginalOperationV2;
  native?: RepositoryWorkNativeBindingV2;
  phase: "preparing" | "prepared" | "dispatching" | "committed" | "closing" | "closed";
  pending: Set<Promise<unknown>>;
  release?: OriginalCommittedRepositoryReleaseV2<V>;
  releaseRef?: string;
  releaseMetadata?: Uint8Array;
  writeAttempted: boolean;
  writeCompleted: boolean;
  /** Dispatch exposure remains separate from later business outcome evidence. */
  dispatchEntered: boolean;
  outcome: GitHubMediationOutcome;
  busy: boolean;
  end: number;
  monoEnd: number;
  began: number;
  monoBegan: number;
  clock: GitHubMediationClockSample;
  leaseEnd: number;
  leaseMono: number;
  abort: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  settlement?: Promise<"recorded" | "unavailable">;
};

/** Real repository-use sequencing and privately recognized P/R handles. This
 * owner neither substitutes for original State/native/custody participants nor
 * installs them. Construct it only with those actual original source bindings.
 */
export class RepositoryWorkOperationOwnerV2<
  B extends RepositoryWorkPrivateBindingsV2 = MissingBindings,
  V extends GitHubMediationVersion = 2,
> implements GitHubMediationOperationOwner<
  OriginalRepositoryPreparationV2<V>,
  OriginalCommittedRepositoryReleaseV2<V>,
  V
> {
  private readonly preparations = new WeakMap<object, Entry<B, V>>();
  private readonly releases = new WeakMap<object, Entry<B, V>>();
  private readonly active = new Set<Entry<B, V>>();
  private readonly sources: RepositoryWorkSourcesV2<B, V>;
  private readonly limits: RepositoryWorkLimitsV2;
  private readonly protocolVersion: V;
  private readonly versionIdentity: (version: V) => V;
  private stopping = false;
  private acquiring = 0;
  private readonly acquisitions = new Set<Promise<unknown>>();
  private readonly acquisitionAborts = new Set<AbortController>();
  private readonly callClocks = new WeakMap<
    object,
    { start: GitHubMediationClockSample; deadline: number }
  >();

  constructor(
    sources: RepositoryWorkSourcesV2<B, NoInfer<V>>,
    limits: RepositoryWorkLimitsV2,
    options: WorkRepositoryProtocolOptionsV2<V>,
  );
  constructor(
    sources: RepositoryWorkSourcesV2<B, NoInfer<V>>,
    limits: RepositoryWorkLimitsV2,
    ...selection: WorkRepositoryProtocolSelectionV2<V>
  );
  constructor(
    sources: RepositoryWorkSourcesV2<B, NoInfer<V>>,
    limits: RepositoryWorkLimitsV2,
    options?: { readonly protocolVersion?: GitHubMediationVersion },
  ) {
    const version = options?.protocolVersion ?? 2;
    if (version !== 2 && version !== 3) throw failure();
    this.protocolVersion = version as V;
    this.versionIdentity = (value: V) => value;
    this.limits = data(limits);
    for (const key of [
      "maximumPreparations",
      "maximumOperationMilliseconds",
      "maximumLeaseMilliseconds",
    ] as const)
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] <= 0) throw failure();
    if (
      !Number.isSafeInteger(this.limits.clockAllowanceMilliseconds) ||
      this.limits.clockAllowanceMilliseconds < 0 ||
      this.limits.maximumLeaseMilliseconds > this.limits.maximumOperationMilliseconds ||
      this.limits.maximumOperationMilliseconds > 0x7fffffff
    )
      throw failure();
    const { native, state, custody } = sources;
    this.sources = Object.freeze({
      native: Object.freeze({
        acquire: native.acquire.bind(native),
        inspect: native.inspect.bind(native),
        inspectNative: native.inspectNative.bind(native),
        assertNativeCurrent: native.assertNativeCurrent.bind(native),
        assertCurrent: native.assertCurrent.bind(native),
        release: native.release.bind(native),
      }),
      state: Object.freeze({
        prepare: state.prepare.bind(state),
        readPreparationOriginal: state.readPreparationOriginal.bind(state),
        readCurrent: state.readCurrent.bind(state),
        commitDispatch: state.commitDispatch.bind(state),
        inspectCommitted: state.inspectCommitted.bind(state),
        settle: state.settle.bind(state),
      }),
      custody: Object.freeze({
        prepareToken: custody.prepareToken.bind(custody),
        writeCommitted: custody.writeCommitted.bind(custody),
        settleToken: custody.settleToken.bind(custody),
      }),
    });
  }
  private assertCall(call: AuthorityCallV1, entry?: Entry<B, V>): void {
    const sample = sampleGitHubMediationClock();
    const clock = this.callClocks.get(call);
    if (
      clock &&
      (!githubMediationClockContinuous(
        clock.start,
        sample,
        this.limits.clockAllowanceMilliseconds,
      ) ||
        sample.after >= clock.deadline)
    )
      throw failure();
    if (
      entry &&
      (!githubMediationClockContinuous(
        entry.clock,
        sample,
        this.limits.clockAllowanceMilliseconds,
      ) ||
        sample.wall >= entry.leaseEnd ||
        sample.after >= entry.leaseMono)
    )
      throw failure();
    if (
      this.stopping ||
      !(call.signal instanceof AbortSignal) ||
      call.signal.aborted ||
      Date.now() >= instant(call.deadline) ||
      (entry &&
        (entry.phase === "closing" ||
          entry.phase === "closed" ||
          entry.abort.signal.aborted ||
          Date.now() < entry.began ||
          performance.now() < entry.monoBegan ||
          Date.now() >= entry.end ||
          performance.now() >= entry.monoEnd))
    )
      throw failure();
    if (
      entry?.native &&
      (call.context !== entry.native.context ||
        call.recipientRef !== entry.native.receiverRef ||
        call.requestRef !== entry.request.request_ref)
    )
      throw failure();
  }
  private bounded(
    input: AuthorityCallV1,
    abort: AbortController,
  ): { call: AuthorityCallV1; close(): void } {
    const original = captureCall(input);
    this.assertCall(original);
    const start = sampleGitHubMediationClock();
    const deadline = githubMediationMonotonicDeadline(
      start,
      instant(original.deadline),
      this.limits.clockAllowanceMilliseconds,
    );
    if (deadline === undefined) throw failure();
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(),
      Math.max(
        1,
        Math.min(this.limits.maximumOperationMilliseconds, instant(original.deadline) - Date.now()),
      ),
    );
    const call = Object.freeze({
      ...original,
      signal: AbortSignal.any([original.signal, abort.signal, timeout.signal]),
    });
    this.callClocks.set(call, { start, deadline });
    return { call, close: () => clearTimeout(timer) };
  }
  private nativeCurrent(entry: Entry<B, V>, call: AuthorityCallV1): void {
    const result: unknown = this.sources.native.assertNativeCurrent(entry.origin, call);
    if (result !== undefined) {
      // A malformed asynchronous final fence never authorizes entry. Own and
      // join its continuation before original exchange cleanup.
      const pending = Promise.resolve(result);
      entry.pending.add(pending);
      void pending.finally(() => entry.pending.delete(pending)).catch(() => {});
      throw failure();
    }
    this.assertCall(call, entry);
  }
  private inspectCommitted(entry: Entry<B, V>): Readonly<{ releaseRef: string }> {
    const result = this.sources.state.inspectCommitted(entry.commit!, entry.state!, entry.token!);
    try {
      return data(result);
    } catch (error) {
      // Invalid asynchronous inspection never supplies a release. Its actual
      // continuation still belongs to this entry, including a late rejection.
      const pending = Promise.resolve(result);
      entry.pending.add(pending);
      void pending.finally(() => entry.pending.delete(pending)).catch(() => {});
      throw error;
    }
  }
  private nativeBinding(raw: RepositoryWorkNativeBindingV2): RepositoryWorkNativeBindingV2 {
    return Object.freeze({
      context: field(raw, "context") as RepositoryWorkNativeBindingV2["context"],
      transportBinding: field(raw, "transportBinding") as object,
      attachmentRef: field(raw, "attachmentRef") as string,
      receiverRef: field(raw, "receiverRef") as string,
      execution: data(field(raw, "execution") as WorkExecutionAssociationV2),
      service: data(field(raw, "service") as ServicePrincipal),
    });
  }
  private async captureNative(
    entry: Entry<B, V>,
    call: AuthorityCallV1,
    initial = false,
  ): Promise<void> {
    this.assertCall(call, entry);
    // Only initial preparation may inspect the original State association.
    if (initial) {
      if (entry.native) throw failure();
      entry.native = this.nativeBinding(await this.sources.native.inspect(entry.origin, call));
      this.assertCall(call, entry);
    }
    const retained = entry.native;
    if (!retained) throw failure();
    // The original native owner authenticates/enrolls this Exchange. Comparison
    // of its result preserves our association; comparison itself grants nothing.
    const native = this.nativeBinding(await this.sources.native.inspectNative(entry.origin, call));
    this.assertCall(call, entry);
    if (
      native.context !== call.context ||
      !native.transportBinding ||
      typeof native.transportBinding !== "object" ||
      native.receiverRef !== call.recipientRef ||
      native.attachmentRef !== entry.request.attachment_ref ||
      native.transportBinding !== retained.transportBinding ||
      native.context !== retained.context ||
      native.attachmentRef !== retained.attachmentRef ||
      native.receiverRef !== retained.receiverRef ||
      !same(native.execution, retained.execution) ||
      !same(native.service, retained.service)
    )
      throw failure();
    this.nativeCurrent(entry, call);
  }
  private async current(
    entry: Entry<B, V>,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkCurrentV2<V>> {
    await this.captureNative(entry, call);
    // Fixed comparison data captured before State retires its initial readset.
    // Calling Runtime.inspect here would reopen a different SQL transaction.
    const native = entry.native;
    if (!native) throw failure();
    const read = await this.sources.state.readCurrent(entry.state!, entry.origin, call);
    this.assertCall(call, entry);
    const current = compareRepositoryWorkCurrentV2(
      read,
      entry.request,
      native,
      Date.now(),
      this.protocolVersion,
    );
    const preparation = data(
      await this.sources.state.readPreparationOriginal(entry.state!, entry.origin, call),
    );
    this.assertCall(call, entry);
    if (
      !reference(preparation.operationRef) ||
      preparation.operationRef === current.original.operationRef ||
      preparation.requestDigest !== current.original.requestDigest ||
      preparation.invocationRef !== current.original.invocationRef ||
      !same(preparation.scope, current.original.scope) ||
      (entry.preparationOriginal && !same(entry.preparationOriginal, preparation))
    )
      throw failure();
    entry.preparationOriginal ??= preparation;
    if (entry.original) {
      // Fresh online validity may change, but none of the bound Work, policy,
      // ancestry, receiver, repository or DNS operands may be rebased.
      const { validUntil: _old, ...old } = entry.original;
      const { validUntil: _next, ...next } = current;
      if (!same(old, next)) throw failure();
    }
    this.nativeCurrent(entry, call);
    entry.native ??= native;
    return current;
  }
  private times(entry: Entry<B, V>, current: RepositoryWorkCurrentV2<V>): GitHubMediationTimes {
    const sample = sampleGitHubMediationClock(),
      now = sample.wall;
    if (
      !githubMediationClockContinuous(entry.clock, sample, this.limits.clockAllowanceMilliseconds)
    )
      throw failure();
    if (
      !Number.isSafeInteger(now) ||
      now < entry.began ||
      now > MAX_TIME ||
      performance.now() >= entry.monoEnd
    )
      throw failure();
    const valid =
      Math.min(instant(current.validUntil), entry.end, now + this.limits.maximumLeaseMilliseconds) -
      this.limits.clockAllowanceMilliseconds;
    if (valid <= now) throw failure();
    const mono = githubMediationMonotonicDeadline(
      sample,
      valid,
      this.limits.clockAllowanceMilliseconds,
    );
    if (mono === undefined) throw failure();
    entry.leaseEnd = valid;
    entry.leaseMono = Math.min(mono, entry.monoEnd);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => {
        void this.finish(entry);
      },
      Math.max(1, Math.ceil(entry.leaseMono - sample.after)),
    );
    return Object.freeze({
      server_time_ms: now,
      valid_until_ms: valid,
      operation_until_ms: entry.end,
    });
  }
  readonly prepare = (
    request: OpenRead<V>,
    call: AuthorityCallV1,
  ): Promise<
    GitHubMediationPreparation<OriginalRepositoryPreparationV2<V>> | GitHubMediationRefusal
  > => {
    // Snapshot before returning to the caller, but register the promise before
    // any supplier can synchronously reenter stop().
    let captured: OpenRead<V>, capturedCall: AuthorityCallV1;
    try {
      captured = data(request);
      capturedCall = captureCall(call);
    } catch {
      return Promise.resolve(unavailable());
    }
    const operation = Promise.resolve().then(() => this.prepareOwned(captured, capturedCall));
    this.acquisitions.add(operation);
    void operation.finally(() => this.acquisitions.delete(operation)).catch(() => {});
    return operation;
  };
  private async prepareOwned(
    input: OpenRead<V>,
    call: AuthorityCallV1,
  ): Promise<
    GitHubMediationPreparation<OriginalRepositoryPreparationV2<V>> | GitHubMediationRefusal
  > {
    let entry: Entry<B, V> | undefined;
    let bounded: ReturnType<RepositoryWorkOperationOwnerV2<B, V>["bounded"]> | undefined;
    if (this.stopping || this.active.size + this.acquiring >= this.limits.maximumPreparations)
      return unavailable();
    this.acquiring++;
    const clock = sampleGitHubMediationClock(),
      began = clock.wall,
      mono = clock.before;
    const abort = new AbortController();
    this.acquisitionAborts.add(abort);
    try {
      bounded = this.bounded(call, abort);
      call = bounded.call;
      const request = data(input);
      const decoded = decodeGitHubMediationRequest(
        new TextEncoder().encode(JSON.stringify(request)),
        this.protocolVersion,
      );
      if (
        decoded?.method !== "open-read" ||
        request.method !== "open-read" ||
        request.sequence !== 1 ||
        request.request_ref !== call.requestRef ||
        request.version !== this.protocolVersion
      )
        throw failure();
      const origin = await this.sources.native.acquire(request, call);
      if (origin === undefined) return unavailable();
      // Retain original release ownership before any cancellation/data access.
      entry = {
        origin,
        request,
        phase: "preparing",
        pending: new Set(),
        writeAttempted: false,
        writeCompleted: false,
        dispatchEntered: false,
        outcome: "not-dispatched",
        busy: false,
        end: began + this.limits.maximumOperationMilliseconds,
        monoEnd: mono + this.limits.maximumOperationMilliseconds,
        began,
        monoBegan: mono,
        clock,
        leaseEnd: began + this.limits.maximumOperationMilliseconds,
        leaseMono: mono + this.limits.maximumOperationMilliseconds,
        abort,
      };
      this.active.add(entry);
      this.assertCall(call, entry);
      await this.captureNative(entry, call, true);
      entry.state = await this.sources.state.prepare(origin, request, call);
      if (entry.state === undefined) throw failure();
      const current = await this.current(entry, call);
      entry.original = current;
      entry.end = Math.min(entry.end, instant(current.originalHorizon));
      const operationMono = githubMediationMonotonicDeadline(
        clock,
        entry.end,
        this.limits.clockAllowanceMilliseconds,
      );
      if (operationMono === undefined) throw failure();
      entry.monoEnd = operationMono;
      const times = this.times(entry, current);
      const handle = Object.freeze(Object.create(null)) as OriginalRepositoryPreparationV2<V>;
      this.preparations.set(handle, entry);
      entry.phase = "prepared";
      return Object.freeze({
        kind: "prepared",
        preparation: handle,
        original: entry.preparationOriginal!,
        work: current.work,
        execution: current.execution,
        originalHorizon: current.originalHorizon,
        workBindingSha256: `sha256:${createHash("sha256")
          .update(canonical({ current, preparation: entry.preparationOriginal }))
          .digest("hex")}`,
        dnsBindingRef: current.dnsBindingRef,
        upstreamIpv4: current.upstreamIpv4,
        times,
      });
    } catch {
      if (entry) await this.finish(entry);
      return unavailable();
    } finally {
      bounded?.close();
      this.acquisitionAborts.delete(abort);
      this.acquiring--;
    }
  }
  private owned<T>(
    entry: Entry<B, V>,
    input: AuthorityCallV1,
    operation: (call: AuthorityCallV1) => Promise<T>,
  ): Promise<T> {
    // Snapshot and own cancellation before scheduling any supplier access.
    let bounded: ReturnType<RepositoryWorkOperationOwnerV2<B, V>["bounded"]>;
    try {
      bounded = this.bounded(input, entry.abort);
    } catch (error) {
      entry.busy = false;
      return Promise.reject(error);
    }
    entry.busy = true;
    const pending = Promise.resolve()
      .then(() => operation(bounded.call))
      .finally(() => {
        bounded.close();
        entry.busy = false;
      });
    entry.pending.add(pending);
    void pending.finally(() => entry.pending.delete(pending)).catch(() => {});
    return pending;
  }
  readonly dispatch = (
    handle: OriginalRepositoryPreparationV2<V>,
    input: DispatchRead<V>,
    call: AuthorityCallV1,
  ): Promise<GitHubMediationRelease<OriginalCommittedRepositoryReleaseV2<V>>> => {
    const entry = this.preparations.get(handle);
    if (!entry || entry.phase !== "prepared" || entry.busy)
      return Promise.resolve({ kind: "not-released", code: "unavailable" });
    entry.phase = "dispatching";
    entry.busy = true;
    let request: DispatchRead<V>;
    try {
      request = data(input);
    } catch {
      entry.busy = false;
      return Promise.resolve({ kind: "not-released", code: "unavailable" });
    }
    return this.owned<GitHubMediationRelease<OriginalCommittedRepositoryReleaseV2<V>>>(
      entry,
      call,
      async (call) => {
        let commitEntered = false;
        try {
          const expected = entry.original!;
          const decoded = decodeGitHubMediationRequest(
            new TextEncoder().encode(JSON.stringify(request)),
            this.protocolVersion,
          );
          if (
            decoded?.method !== "dispatch-read" ||
            request.method !== "dispatch-read" ||
            request.sequence !== 2 ||
            request.request_ref !== entry.request.request_ref ||
            request.effect_ref !== entry.preparationOriginal!.operationRef ||
            request.request_sha256 !== entry.request.request_sha256 ||
            request.work_binding_sha256 !==
              `sha256:${createHash("sha256")
                .update(canonical({ current: expected, preparation: entry.preparationOriginal }))
                .digest("hex")}` ||
            request.dns_binding_ref !== expected.dnsBindingRef ||
            request.upstream_ipv4 !== expected.upstreamIpv4 ||
            !/^[a-f0-9]{32}$/.test(request.session_ref) ||
            !/^sha256:[a-f0-9]{64}$/.test(request.peer_certificate_sha256)
          )
            throw failure();
          await this.current(entry, call);
          entry.token = await this.sources.custody.prepareToken(entry.state!, entry.origin, call);
          if (entry.token === undefined) throw failure();
          const current = await this.current(entry, call);
          this.assertCall(call, entry);
          // Unknown responsibility precedes the effectful State call and remains
          // reachable through P even if no receipt reaches the broker.
          commitEntered = true;
          entry.dispatchEntered = true;
          entry.outcome = "unknown";
          const result = await this.sources.state.commitDispatch(
            entry.state!,
            entry.origin,
            entry.token,
            request,
            current,
            call,
          );
          const kind = field(result, "kind");
          if (kind === "unknown") return { kind: "unknown" };
          if (kind === "not-committed") {
            entry.outcome = "not-dispatched";
            entry.dispatchEntered = false;
            return { kind: "not-released", code: "unavailable" };
          }
          if (kind !== "committed") throw failure();
          entry.commit = field(result as { receipt: B["commit"] }, "receipt") as B["commit"];
          if (entry.commit === undefined) throw failure();
          const inspected = this.inspectCommitted(entry);
          if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(inspected.releaseRef)) throw failure();
          entry.releaseRef = inspected.releaseRef;
          const release = Object.freeze(
            Object.create(null),
          ) as OriginalCommittedRepositoryReleaseV2<V>;
          entry.release = release;
          this.releases.set(release, entry);
          this.assertCall(call, entry);
          this.nativeCurrent(entry, call);
          const times = this.times(entry, current);
          // Exact maintained broker serialization, including its fixed field order.
          entry.releaseMetadata = encodeGitHubMediationMetadata({
            version: this.protocolVersion,
            request_ref: request.request_ref,
            session_ref: request.session_ref,
            effect_ref: request.effect_ref,
            work_binding_sha256: request.work_binding_sha256,
            request_sha256: request.request_sha256,
            sequence: request.sequence,
            ...times,
            ok: true,
            phase: "dispatch-once",
            dns_binding_ref: request.dns_binding_ref,
            upstream_ipv4: request.upstream_ipv4,
            peer_certificate_sha256: request.peer_certificate_sha256,
            release_ref: inspected.releaseRef,
          });
          entry.phase = "committed";
          return { kind: "released", release, releaseRef: inspected.releaseRef, times };
        } catch {
          return commitEntered
            ? { kind: "unknown" }
            : { kind: "not-released", code: "unavailable" };
        } finally {
          entry.busy = false;
        }
      },
    ).catch(() => ({ kind: "not-released" as const, code: "unavailable" as const }));
  };
  check(
    handle: OriginalRepositoryPreparationV2<V>,
    release: OriginalCommittedRepositoryReleaseV2<V>,
    call: AuthorityCallV1,
  ): Promise<Readonly<{ kind: "current"; times: GitHubMediationTimes }> | GitHubMediationRefusal> {
    const entry = this.preparations.get(handle);
    if (
      !entry ||
      this.releases.get(release) !== entry ||
      entry.release !== release ||
      entry.phase !== "committed" ||
      entry.busy
    )
      return Promise.resolve(unavailable());
    return this.owned<
      Readonly<{ kind: "current"; times: GitHubMediationTimes }> | GitHubMediationRefusal
    >(entry, call, async (call) => {
      try {
        return { kind: "current", times: this.times(entry, await this.current(entry, call)) };
      } catch {
        return unavailable();
      }
    }).catch(() => unavailable());
  }
  writeRelease(
    release: OriginalCommittedRepositoryReleaseV2<V>,
    metadata: Uint8Array,
    call: AuthorityCallV1,
  ): Promise<void> {
    const entry = this.releases.get(release);
    if (
      !entry ||
      entry.release !== release ||
      entry.phase !== "committed" ||
      entry.writeAttempted ||
      entry.busy
    )
      return Promise.reject(failure());
    // A failed or partial write consumes transmission; it can never be retried.
    entry.writeAttempted = true;
    let captured: Uint8Array;
    try {
      if (types.isProxy(metadata) || !types.isUint8Array(metadata)) throw failure();
      if (
        Reflect.apply(byteLength, metadata, []) > METADATA_LIMIT ||
        Reflect.apply(arrayBuffer, metadata, []) instanceof SharedArrayBuffer
      )
        throw failure();
      captured = new Uint8Array(metadata);
      if (
        captured.byteLength > METADATA_LIMIT ||
        !entry.releaseMetadata ||
        !Buffer.from(captured).equals(Buffer.from(entry.releaseMetadata))
      )
        throw failure();
    } catch {
      return Promise.reject(failure());
    }
    return this.owned(entry, call, async (call) => {
      this.assertCall(call, entry);
      await this.current(entry, call);
      const recognized = this.inspectCommitted(entry);
      if (recognized.releaseRef !== entry.releaseRef) throw failure();
      this.nativeCurrent(entry, call);
      await this.sources.custody.writeCommitted(entry.commit!, captured, call);
      this.assertCall(call, entry);
      entry.writeCompleted = true;
    });
  }
  settle(
    handle: OriginalRepositoryPreparationV2<V>,
    release: OriginalCommittedRepositoryReleaseV2<V> | undefined,
    outcome: GitHubMediationOutcome,
  ): Promise<"recorded" | "unavailable"> {
    const entry = this.preparations.get(handle);
    if (
      !entry ||
      (release !== undefined &&
        (this.releases.get(release) !== entry || entry.release !== release)) ||
      !["not-dispatched", "completed", "unknown"].includes(outcome) ||
      (outcome === "completed" && !entry.writeCompleted)
    )
      return Promise.resolve("unavailable");
    // An unconfirmed original commit cannot be downgraded by a caller's later
    // business report. State must retain dispatch/exposure independently even
    // when a known-committed call later reports no business request was sent.
    if (!entry.settlement)
      entry.outcome = entry.dispatchEntered && entry.commit === undefined ? "unknown" : outcome;
    return this.finish(entry);
  }
  private finish(entry: Entry<B, V>): Promise<"recorded" | "unavailable"> {
    if (entry.settlement) return entry.settlement;
    entry.phase = "closing";
    entry.settlement = Promise.resolve().then(async () => {
      let result: "recorded" | "unavailable" = "unavailable";
      while (entry.pending.size) await Promise.allSettled([...entry.pending]);
      try {
        if (entry.state !== undefined)
          result = await this.sources.state.settle(entry.state, entry.commit, entry.outcome);
      } catch {
        /* Original durable responsibility remains State-owned. */
      }
      try {
        if (entry.token !== undefined) await this.sources.custody.settleToken(entry.token);
      } catch {
        result = "unavailable";
      }
      try {
        await this.sources.native.release(entry.origin);
      } catch {
        result = "unavailable";
      }
      entry.phase = "closed";
      this.active.delete(entry);
      return result;
    });
    // Abort dispatch invokes listeners synchronously. Reentrant callers must
    // already see this one join before cancellation or any other callback.
    entry.abort.abort();
    if (entry.timer) clearTimeout(entry.timer);
    return entry.settlement;
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const abort of this.acquisitionAborts) abort.abort();
    for (const entry of this.active) entry.abort.abort();
    const settlements = [...this.active]
      .filter((entry) => entry.phase !== "preparing")
      .map((entry) => this.finish(entry));
    await Promise.allSettled([...this.acquisitions]);
    await Promise.allSettled(settlements);
    await Promise.allSettled([...this.active].map((entry) => this.finish(entry)));
  }
}
