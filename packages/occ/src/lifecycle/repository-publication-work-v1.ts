import { types } from "node:util";
import { hrtime } from "node:process";

const monotonicNow = hrtime.bigint.bind(hrtime);
import type { ServicePrincipal } from "@openclaw-enterprise/contracts/identity/identity";
import type {
  WorkAdmittedExecutionV2,
  WorkExecutionAssociationV2,
  WorkLineageMemberV2,
  WorkOriginalOperationV2,
  WorkProfileRefV2,
  WorkPublicationIntentV1,
} from "./work-authority-ports-v2.ts";
import type { RepositoryWorkReadsetV2 } from "../ports/repository-work-v2.ts";
import {
  parsePublicationRequestV1,
  parsePublicationWorkBindingV1,
  publicationCanonicalV1,
  publicationDigestV1,
  publicationReferenceV1,
  publicationObjectV1,
  publicationBranchV1,
  publicationSha256V1,
  publicationSnapshotV1,
  type PublicationCallV1,
  type PublicationClockV1,
  type PublicationRequestV1,
  type PublicationWorkBindingV1,
} from "../repository-publication-v1/contract.ts";

/** Original controller actor/call enrollment and original State receipts remain
 * distinct, invariant private types. Defaults cannot manufacture any operand. */
export interface PublicationWorkPrivateBindingsV1 {
  readonly actor: object;
  readonly invocation: object;
  readonly admission: object;
  readonly use: object;
}
type Missing = { readonly [K in keyof PublicationWorkPrivateBindingsV1]: never };
declare const publicationWork: unique symbol;
export type OriginalPublicationWorkV1 = Readonly<{ [publicationWork]: true }>;

/** Current platform Work-use policy, not approver policy or credential access.
 * The first profile admits no child Work and no renewable operation horizon. */
export interface PublicationWorkPolicyV1 {
  readonly version: 1;
  readonly policyRef: string;
  readonly revision: string;
  readonly status: "enabled" | "disabled";
  readonly scope: WorkOriginalOperationV2["scope"];
  readonly servicePrincipalId: string;
  readonly executionProfile: WorkProfileRefV2;
  readonly operation: "work.repository.publish";
  readonly permission: "repository:publish";
  readonly actions: readonly ["push", "create-draft-pr"];
  readonly admitAttachedWork: false;
  readonly repository: PublicationRequestV1["repository"];
  readonly baseBranch: string;
  readonly targetBranches: readonly string[];
  readonly allowCreate: boolean;
  readonly bounds: Readonly<{
    notBefore: string;
    notAfter: string;
    maximumWorkMilliseconds: number;
    maximumCallMilliseconds: number;
    maximumClockUncertaintyMilliseconds: number;
  }>;
}

/** Original controller/native owner authenticates these values under its
 * private actor/call/selected-execution association before returning them. */
export interface PublicationWorkInvocationDataV1 {
  readonly scope: WorkOriginalOperationV2["scope"];
  readonly requesterPrincipalId: string;
  readonly invocationRef: string;
  readonly service: ServicePrincipal;
  readonly execution: WorkExecutionAssociationV2;
  readonly requestDigest: string;
  readonly callDeadline: string;
  readonly cancellationScopeRef: string;
}
export interface PublicationWorkInvocationLeaseV1<I extends object> {
  readonly original: I;
  inspect(): PublicationWorkInvocationDataV1;
  assertNativeCurrent(): undefined;
  /** Retire the original initial SQL readset before State opens its Work unit.
   * Native membership alone spans this gap. Actual State authority is later. */
  prepareStateUse(): Promise<void>;
  release(): Promise<void>;
}
export interface PublicationWorkInvocationSourceV1<A extends object, I extends object> {
  /** An acquisition that cannot hand off its lease owns its late cleanup. */
  acquire(
    actor: A,
    request: PublicationRequestV1,
    call: PublicationCallV1,
  ): Promise<PublicationWorkInvocationLeaseV1<I> | undefined>;
  recognize(
    original: I,
    actor: A,
    request: PublicationRequestV1,
    call: PublicationCallV1,
  ): undefined;
}

/** Original operations remain objects; admitted/readset/policy are detached
 * comparison data. State authenticates complete ancestry and the held policy. */
export interface PublicationWorkSelectionV1 {
  readonly operation: WorkOriginalOperationV2;
  readonly admitted: WorkAdmittedExecutionV2;
  readonly readset: RepositoryWorkReadsetV2;
  readonly policy: PublicationWorkPolicyV1;
  readonly admittedPolicyDigest: string;
}
export interface PublicationWorkAdmissionLeaseV1<A extends object> {
  inspect(): PublicationWorkSelectionV1;
  assertCurrent(): undefined;
  prepareCommit(): Promise<void>;
  /** Existing known admission returns its original receipt. New admission is
   * exposed only after outer ACK and terminal cleanup. Unknown retains original
   * State recovery ownership and cannot create a Work-use handle or retry. */
  commitAdmission(): Promise<
    | Readonly<{ kind: "committed"; original: A }>
    | Readonly<{ kind: "unknown" }>
    | Readonly<{ kind: "refused" }>
  >;
  release(): Promise<void>;
}
export interface PublicationWorkUseLeaseV1<U extends object> {
  readonly original: U;
  inspect(): PublicationWorkSelectionV1;
  assertCurrent(): undefined;
  prepare(): Promise<void>;
  release(): Promise<void>;
}
/** Capture one genuine State participant at trusted construction. It owns the
 * private invocation/operation/admission/use association and actual held SQL
 * readsets. No second transaction can substitute for a returned held unit.
 * New first admission and existing reuse share the same original receiver. */
export interface PublicationWorkStateSourceV1<
  I extends object,
  A extends object,
  U extends object,
> {
  acquireAdmission(
    originalInvocation: I,
    request: PublicationRequestV1,
    call: PublicationCallV1,
  ): Promise<PublicationWorkAdmissionLeaseV1<A> | undefined>;
  recognizeAdmission(
    original: A,
    invocation: I,
    request: PublicationRequestV1,
    call: PublicationCallV1,
  ): undefined;
  acquireUse(
    originalAdmission: A,
    invocation: I,
    request: PublicationRequestV1,
    call: PublicationCallV1,
  ): Promise<PublicationWorkUseLeaseV1<U> | undefined>;
  recognizeUse(
    original: U,
    admission: A,
    invocation: I,
    request: PublicationRequestV1,
    call: PublicationCallV1,
  ): undefined;
}
/** A required factual bound from the original protected clock producer. For
 * this process's captured hrtime.bigint domain, throughout validForMonotonicMs
 * after its fresh sample DURING this read, true time must stay at or below
 * wallMs + uncertaintyMs +
 * ceil(elapsedNs * maxWallAdvancePpm / 1e12). The rate is the complete maximum
 * ratio, not drift added to an assumed rate. It must cover adjustments/suspend
 * through the final State/native callbacks. Work starts elapsed time before
 * entering read(), conservatively including its latency. An issued guarantee
 * cannot be retracted by later reads or source-health changes. Cached earlier
 * samples must be advanced to this read before return. Missing qualification
 * refuses; copying this data or specifying a rate does not qualify a producer.
 * Trusted construction must select the genuine clock and domain relationship. */
export interface PublicationWorkClockV1 extends PublicationClockV1 {
  read(): Readonly<{
    wallMs: number;
    uncertaintyMs: number;
    maxWallAdvancePpm: number;
    validForMonotonicMs: number;
  }>;
}
type ClockSample = Readonly<ReturnType<PublicationWorkClockV1["read"]> & { started: bigint }>;

export interface PublicationWorkSourcesV1<B extends PublicationWorkPrivateBindingsV1 = Missing> {
  readonly invocation: PublicationWorkInvocationSourceV1<B["actor"], B["invocation"]>;
  readonly state: PublicationWorkStateSourceV1<B["invocation"], B["admission"], B["use"]>;
  readonly clock: PublicationWorkClockV1;
}
export interface PublicationWorkLimitsV1 {
  readonly maximumActive: number;
}

function refuse(): never {
  throw new Error("Original publication Work unavailable.");
}
function object(value: unknown): object {
  if (!value || typeof value !== "object" || types.isProxy(value)) return refuse();
  return value;
}
function own(value: unknown, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(object(value), key);
  if (!d || !("value" in d)) return refuse();
  return d.value;
}
function method<F extends (...args: never[]) => unknown>(value: unknown, key: string): F {
  const receiver = object(value);
  let cursor: object | null = receiver;
  for (let i = 0; cursor && i < 4; i++, cursor = Object.getPrototypeOf(cursor)) {
    const d = Object.getOwnPropertyDescriptor(cursor, key);
    if (d) {
      if (!("value" in d) || typeof d.value !== "function") return refuse();
      return d.value.bind(receiver) as F;
    }
  }
  return refuse();
}
function snapshot<T>(value: T): T {
  return publicationSnapshotV1(value) as T;
}
function same(a: unknown, b: unknown): boolean {
  return (
    publicationCanonicalV1(publicationSnapshotV1(a)) ===
    publicationCanonicalV1(publicationSnapshotV1(b))
  );
}
function instant(value: unknown): number {
  if (typeof value !== "string") return refuse();
  const n = Date.parse(value);
  if (!Number.isSafeInteger(n) || n < 0 || new Date(n).toISOString() !== value) return refuse();
  return n;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return refuse();
  return value;
}
function reference(value: unknown): void {
  if (!publicationReferenceV1(value)) refuse();
}
function profile(value: WorkProfileRefV2): void {
  reference(value.ref);
  reference(value.revision);
}
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
function isAborted(signal: AbortSignal): boolean {
  return Reflect.apply(aborted, signal, []);
}

/** Shared read/publication comparison against State's actual held complete rows.
 * This function cannot create the original admission or recognize any receipt. */
export function compareWorkAdmittedExecutionV2(
  admittedInput: WorkAdmittedExecutionV2,
  readsetInput: RepositoryWorkReadsetV2,
  invocationInput: PublicationWorkInvocationDataV1,
): void {
  const admitted = snapshot(admittedInput),
    rows = snapshot(readsetInput),
    invocation = snapshot(invocationInput);
  const scope = admitted.admissionOriginal.scope,
    e = admitted.execution;
  for (const v of Object.values(scope)) reference(v);
  const expectedScope = {
    installationId: scope.installationRef,
    namespaceId: scope.namespaceRef,
    agentId: scope.agentRef,
    revisionRef: scope.revisionRef,
  };
  if (
    !same(scope, invocation.scope) ||
    !same(rows.scope, expectedScope) ||
    !same(admitted.lineage.scope, scope) ||
    !same(e, invocation.execution) ||
    admitted.requesterPrincipalId !== invocation.requesterPrincipalId ||
    admitted.invocationRef !== invocation.invocationRef ||
    admitted.admissionOriginal.invocationRef !== admitted.invocationRef ||
    admitted.cancellationScopeRef !== invocation.cancellationScopeRef ||
    !same(admitted.owner, invocation.service)
  )
    refuse();
  if (
    admitted.owner.kind !== "service_principal" ||
    admitted.owner.namespaceId !== scope.namespaceRef ||
    admitted.owner.agentId !== scope.agentRef ||
    e.attempt.installationRef !== scope.installationRef ||
    e.attempt.namespaceRef !== scope.namespaceRef ||
    e.attempt.agentRef !== scope.agentRef
  )
    refuse();
  for (const v of [
    admitted.owner.id,
    admitted.requesterPrincipalId,
    admitted.invocationRef,
    admitted.cancellationScopeRef,
    admitted.admissionOriginal.operationRef,
    e.assignmentRef,
    e.assignmentVersion,
    e.executionIncarnationRef,
    e.executionGeneration,
    e.receiverRef,
    e.protectedOriginRef,
    admitted.authority.ref,
    admitted.authority.revision,
  ])
    reference(v);
  profile(e.executionProfile);
  profile(admitted.lineage.membershipProfile);
  positive(admitted.work.revision);
  if (
    !Number.isSafeInteger(admitted.lineage.own.withdrawalRevision) ||
    admitted.lineage.own.withdrawalRevision < 0
  )
    refuse();
  if (!publicationSha256V1(admitted.admissionOriginal.requestDigest)) refuse();
  const chain = [...admitted.lineage.ancestors, admitted.lineage.own];
  if (
    chain.length < 1 ||
    chain.length > 128 ||
    rows.lineage.length !== chain.length ||
    new Set(chain.map((member) => member.work.workRef)).size !== chain.length ||
    !same(admitted.work, admitted.lineage.own.work) ||
    admitted.lineage.own.originalHorizon !== admitted.originalHorizon
  )
    refuse();
  if (admitted.lineage.kind === "root") {
    if (
      chain.length !== 1 ||
      admitted.lineage.parentWorkRef !== null ||
      admitted.lineage.rootWorkRef !== admitted.work.workRef
    )
      refuse();
  } else if (
    admitted.lineage.kind !== "attached-child" ||
    chain.length < 2 ||
    admitted.lineage.parentWorkRef !== chain.at(-2)!.work.workRef ||
    admitted.lineage.rootWorkRef !== chain[0]!.work.workRef
  )
    refuse();
  for (let i = 0; i < chain.length; i++) {
    const member = chain[i]!,
      row = rows.lineage[i]!;
    reference(member.work.workRef);
    positive(member.work.revision);
    if (
      !Number.isSafeInteger(member.withdrawalRevision) ||
      member.withdrawalRevision < 0 ||
      member.state !== "open" ||
      row.state !== "open" ||
      !same(row.scope, expectedScope) ||
      row.workRef !== member.work.workRef ||
      row.revision !== member.work.revision ||
      row.withdrawalRevision !== member.withdrawalRevision ||
      row.originalHorizon !== member.originalHorizon ||
      row.rootWorkRef !== admitted.lineage.rootWorkRef ||
      row.parentWorkRef !== (i === 0 ? null : chain[i - 1]!.work.workRef) ||
      instant(member.originalHorizon) < instant(admitted.originalHorizon)
    )
      refuse();
  }
  if (!same(rows.lineage.at(-1)!.execution, e)) refuse();
  if (
    instant(admitted.workBeganAt) >= instant(admitted.originalHorizon) ||
    instant(admitted.authority.notBefore) >= instant(admitted.authority.notAfter) ||
    instant(admitted.authority.notAfter) > instant(admitted.originalHorizon)
  )
    refuse();
}

export function publicationWorkExecutionDigestV1(execution: WorkExecutionAssociationV2): string {
  return publicationDigestV1("execution-binding", snapshot(execution));
}

/** Closed publication policy decoder. Parsing alone grants no Work authority. */
export function parsePublicationWorkPolicyV1(value: unknown): PublicationWorkPolicyV1 {
  const p = publicationSnapshotV1(value) as PublicationWorkPolicyV1;
  publicationObjectV1(p, [
    "version",
    "policyRef",
    "revision",
    "status",
    "scope",
    "servicePrincipalId",
    "executionProfile",
    "operation",
    "permission",
    "actions",
    "admitAttachedWork",
    "repository",
    "baseBranch",
    "targetBranches",
    "allowCreate",
    "bounds",
  ]);
  publicationObjectV1(p.scope, ["installationRef", "namespaceRef", "agentRef", "revisionRef"]);
  publicationObjectV1(p.executionProfile, ["ref", "revision"]);
  publicationObjectV1(p.repository, [
    "installationId",
    "githubHost",
    "appId",
    "githubInstallationId",
    "repositoryId",
  ]);
  publicationObjectV1(p.bounds, [
    "notBefore",
    "notAfter",
    "maximumWorkMilliseconds",
    "maximumCallMilliseconds",
    "maximumClockUncertaintyMilliseconds",
  ]);
  for (const ref of [
    p.policyRef,
    p.revision,
    p.servicePrincipalId,
    ...Object.values(p.scope),
    p.repository.installationId,
  ])
    reference(ref);
  profile(p.executionProfile);
  if (
    p.version !== 1 ||
    (p.status !== "enabled" && p.status !== "disabled") ||
    p.operation !== "work.repository.publish" ||
    p.permission !== "repository:publish" ||
    !same(p.actions, ["push", "create-draft-pr"]) ||
    p.admitAttachedWork !== false ||
    p.repository.githubHost !== "github.com" ||
    p.repository.installationId !== p.scope.installationRef ||
    [p.repository.appId, p.repository.githubInstallationId, p.repository.repositoryId].some(
      (v) => typeof v !== "string" || !/^[1-9][0-9]{0,19}(?![\s\S])/.test(v),
    ) ||
    !publicationBranchV1(p.baseBranch) ||
    !Array.isArray(p.targetBranches) ||
    p.targetBranches.length < 1 ||
    p.targetBranches.length > 128 ||
    new Set(p.targetBranches).size !== p.targetBranches.length ||
    p.targetBranches.some((v) => !publicationBranchV1(v) || v === p.baseBranch) ||
    typeof p.allowCreate !== "boolean"
  )
    refuse();
  positive(p.bounds.maximumWorkMilliseconds);
  positive(p.bounds.maximumCallMilliseconds);
  if (
    !Number.isSafeInteger(p.bounds.maximumClockUncertaintyMilliseconds) ||
    p.bounds.maximumClockUncertaintyMilliseconds < 0 ||
    instant(p.bounds.notBefore) >= instant(p.bounds.notAfter)
  )
    refuse();
  return p;
}

export function publicationWorkPolicyDigestV1(policy: PublicationWorkPolicyV1): string {
  return publicationDigestV1("work-policy", parsePublicationWorkPolicyV1(policy));
}

/** Compare an admitted selection under the caller's actually held State unit.
 * This creates detached binding data only, never a private admission/use handle. */
export function comparePublicationWorkSelectionV1(
  selectionInput: PublicationWorkSelectionV1,
  invocationInput: PublicationWorkInvocationDataV1,
  requestInput: PublicationRequestV1,
  sampleInput: Readonly<{ wallMs: number; uncertaintyMs: number }>,
): PublicationWorkBindingV1 {
  const selected = snapshot(selectionInput),
    invocation = snapshot(invocationInput);
  const requestData = parsePublicationRequestV1(requestInput);
  const requestDigest = publicationDigestV1("request", requestData);
  const sample = snapshot(sampleInput);
  if (
    !Number.isSafeInteger(sample.wallMs) ||
    sample.wallMs < 0 ||
    !Number.isSafeInteger(sample.uncertaintyMs) ||
    sample.uncertaintyMs < 0 ||
    !Number.isSafeInteger(sample.wallMs + sample.uncertaintyMs)
  )
    refuse();
  const admitted = selected.admitted,
    policy = parsePublicationWorkPolicyV1(selected.policy),
    operation = selected.operation;
  compareWorkAdmittedExecutionV2(admitted, selected.readset, invocation);
  const expectedScope = admitted.admissionOriginal.scope;
  if (
    !same(operation.scope, expectedScope) ||
    operation.invocationRef !== invocation.invocationRef ||
    operation.requestDigest !== requestDigest ||
    operation.operationRef === admitted.admissionOriginal.operationRef
  )
    refuse();
  reference(operation.operationRef);
  if (invocation.requestDigest !== requestDigest) refuse();
  if (
    policy.version !== 1 ||
    policy.status !== "enabled" ||
    policy.operation !== "work.repository.publish" ||
    policy.permission !== "repository:publish" ||
    !same(policy.actions, ["push", "create-draft-pr"]) ||
    policy.admitAttachedWork !== false ||
    admitted.lineage.kind !== "root" ||
    !same(policy.scope, expectedScope) ||
    policy.servicePrincipalId !== admitted.owner.id ||
    !same(policy.executionProfile, admitted.execution.executionProfile) ||
    !same(policy.repository, requestData.repository) ||
    policy.repository.installationId !== expectedScope.installationRef ||
    policy.baseBranch !== requestData.baseBranch ||
    !Array.isArray(policy.targetBranches) ||
    policy.targetBranches.length < 1 ||
    policy.targetBranches.length > 128 ||
    new Set(policy.targetBranches).size !== policy.targetBranches.length ||
    !policy.targetBranches.includes(requestData.targetBranch) ||
    typeof policy.allowCreate !== "boolean" ||
    (requestData.expectedTarget.kind === "create" && !policy.allowCreate) ||
    selected.admittedPolicyDigest !== publicationWorkPolicyDigestV1(policy) ||
    !same(selected.readset.lineage.at(-1)!.policy, policy)
  )
    refuse();
  publicationObjectV1(policy, [
    "version",
    "policyRef",
    "revision",
    "status",
    "scope",
    "servicePrincipalId",
    "executionProfile",
    "operation",
    "permission",
    "actions",
    "admitAttachedWork",
    "repository",
    "baseBranch",
    "targetBranches",
    "allowCreate",
    "bounds",
  ]);
  publicationObjectV1(policy.bounds, [
    "notBefore",
    "notAfter",
    "maximumWorkMilliseconds",
    "maximumCallMilliseconds",
    "maximumClockUncertaintyMilliseconds",
  ]);
  reference(policy.policyRef);
  reference(policy.revision);
  profile(policy.executionProfile);
  const bound = policy.bounds;
  positive(bound.maximumWorkMilliseconds);
  positive(bound.maximumCallMilliseconds);
  if (
    !Number.isSafeInteger(bound.maximumClockUncertaintyMilliseconds) ||
    bound.maximumClockUncertaintyMilliseconds < 0 ||
    sample.uncertaintyMs > bound.maximumClockUncertaintyMilliseconds
  )
    refuse();
  const begin = instant(admitted.workBeganAt),
    horizon = instant(admitted.originalHorizon);
  const policyStart = instant(bound.notBefore),
    policyEnd = instant(bound.notAfter);
  const authorityStart = instant(admitted.authority.notBefore),
    authorityEnd = instant(admitted.authority.notAfter);
  const callEnd = instant(invocation.callDeadline),
    upper = sample.wallMs + sample.uncertaintyMs;
  if (
    sample.wallMs - sample.uncertaintyMs < Math.max(begin, policyStart, authorityStart) ||
    horizon > policyEnd ||
    horizon - begin > bound.maximumWorkMilliseconds ||
    callEnd > upper + bound.maximumCallMilliseconds
  )
    refuse();
  const end = Math.min(
    horizon,
    authorityEnd,
    callEnd,
    policyEnd,
    ...admitted.lineage.ancestors.map((a: WorkLineageMemberV2) => instant(a.originalHorizon)),
  );
  if (upper >= end) refuse();
  const intent: WorkPublicationIntentV1 = {
    ...operation,
    operation: "work.repository.publish",
    permission: "repository:publish",
    actions: ["push", "create-draft-pr"],
    work: admitted.work,
    execution: admitted.execution,
    requesterPrincipalId: admitted.requesterPrincipalId,
    authorityRef: admitted.authority.ref,
    authorityRevision: admitted.authority.revision,
    executionBindingDigest: publicationWorkExecutionDigestV1(
      admitted.execution,
    ) as WorkPublicationIntentV1["executionBindingDigest"],
  };
  return parsePublicationWorkBindingV1({
    installationId: expectedScope.installationRef,
    namespaceId: expectedScope.namespaceRef,
    agentId: expectedScope.agentRef,
    agentRevisionRef: expectedScope.revisionRef,
    workRef: intent.work.workRef,
    workRevision: intent.work.revision,
    authorityRef: intent.authorityRef,
    authorityRevision: intent.authorityRevision,
    operationRef: operation.operationRef,
    invocationRef: operation.invocationRef,
    requestDigest: operation.requestDigest,
    executionBindingDigest: intent.executionBindingDigest,
    requesterPrincipalId: intent.requesterPrincipalId,
  });
}

type CapturedInvocation<I extends object> = {
  original: I;
  inspect: () => PublicationWorkInvocationDataV1;
  current: () => undefined;
  handoff: () => Promise<void>;
};
type CapturedUse<U extends object> = {
  original: U;
  inspect: () => PublicationWorkSelectionV1;
  current: () => undefined;
  prepare: () => Promise<void>;
};
type Retirement = { run: () => Promise<void>; done: boolean };
type Entry<B extends PublicationWorkPrivateBindingsV1> = {
  actor: B["actor"];
  request: PublicationRequestV1;
  requestData: PublicationRequestV1;
  requestDigest: string;
  call: PublicationCallV1;
  requestRef: string;
  signal: AbortSignal;
  pending: Set<Promise<unknown>>;
  retirements: Retirement[];
  valid: boolean;
  checking: boolean;
  closed: boolean;
  cleanup?: Promise<void> | undefined;
  invocation?: CapturedInvocation<B["invocation"]>;
  invocationData?: PublicationWorkInvocationDataV1;
  admission?: B["admission"];
  use?: CapturedUse<B["use"]>;
  operation?: WorkOriginalOperationV2;
  admissionOperation?: WorkOriginalOperationV2;
  selection?: PublicationWorkSelectionV1;
  binding?: PublicationWorkBindingV1;
  notAfter?: number;
  firstClock?: ClockSample;
  removeAbort?: () => void;
};

/** Actual original Work owner. The constructor consumes original controller and
 * State participants; it neither installs them nor obtains authority from data.
 * Private handles are issued only after known admission and current held use. */
export class RepositoryPublicationWorkOwnerV1<
  B extends PublicationWorkPrivateBindingsV1 = Missing,
> {
  private readonly sources: PublicationWorkSourcesV1<B>;
  private readonly maximumActive: number;
  private readonly handles = new WeakMap<OriginalPublicationWorkV1, Entry<B>>();
  private readonly active = new Set<Entry<B>>();
  private readonly usedCalls = new WeakSet<object>();
  private stopping = false;

  constructor(sources: PublicationWorkSourcesV1<B>, limits: PublicationWorkLimitsV1) {
    this.maximumActive = positive(own(limits, "maximumActive"));
    const invocation = sources.invocation,
      state = sources.state,
      clock = sources.clock;
    this.sources = Object.freeze({
      invocation: Object.freeze({
        acquire: method<PublicationWorkInvocationSourceV1<B["actor"], B["invocation"]>["acquire"]>(
          invocation,
          "acquire",
        ),
        recognize: method<
          PublicationWorkInvocationSourceV1<B["actor"], B["invocation"]>["recognize"]
        >(invocation, "recognize"),
      }),
      state: Object.freeze({
        acquireAdmission: method<
          PublicationWorkStateSourceV1<
            B["invocation"],
            B["admission"],
            B["use"]
          >["acquireAdmission"]
        >(state, "acquireAdmission"),
        recognizeAdmission: method<
          PublicationWorkStateSourceV1<
            B["invocation"],
            B["admission"],
            B["use"]
          >["recognizeAdmission"]
        >(state, "recognizeAdmission"),
        acquireUse: method<
          PublicationWorkStateSourceV1<B["invocation"], B["admission"], B["use"]>["acquireUse"]
        >(state, "acquireUse"),
        recognizeUse: method<
          PublicationWorkStateSourceV1<B["invocation"], B["admission"], B["use"]>["recognizeUse"]
        >(state, "recognizeUse"),
      }),
      clock: Object.freeze({ read: method<PublicationWorkClockV1["read"]>(clock, "read") }),
    });
  }

  private track<T>(entry: Entry<B>, pending: Promise<T>): Promise<T> {
    entry.pending.add(pending);
    void pending.then(
      () => entry.pending.delete(pending),
      () => entry.pending.delete(pending),
    );
    return pending;
  }
  private poison(entry: Entry<B>, value?: unknown): never {
    entry.valid = false; // Irreversible before assimilation, callback or refusal.
    if (value !== undefined) this.track(entry, Promise.resolve(value));
    void this.finish(entry).catch(() => {});
    return refuse();
  }
  private fence(entry: Entry<B>, callback: () => unknown): void {
    const value = callback();
    if (value !== undefined) this.poison(entry, value);
  }
  private inspectData<T>(entry: Entry<B>, callback: () => T): T {
    const value = callback();
    if (types.isPromise(value)) this.poison(entry, value);
    return value;
  }
  private retain(entry: Entry<B>, offered: unknown): Retirement {
    // Release custody precedes original/data/method access on the returned lease.
    const retirement = { run: method<() => Promise<void>>(offered, "release"), done: false };
    entry.retirements.push(retirement);
    return retirement;
  }
  private async retire(retirement: Retirement): Promise<void> {
    if (retirement.done) return;
    await retirement.run();
    retirement.done = true;
  }
  private local(entry: Entry<B>): void {
    if (
      !entry.valid ||
      entry.closed ||
      this.stopping ||
      isAborted(entry.signal) ||
      own(entry.call, "requestRef") !== entry.requestRef ||
      own(entry.call, "signal") !== entry.signal ||
      !same(parsePublicationRequestV1(entry.request), entry.requestData)
    )
      refuse();
  }
  private sample(entry: Entry<B>): ClockSample {
    // Capture the original monotonic domain before any clock-source callback.
    const started = monotonicNow();
    const raw = this.inspectData(entry, () => this.sources.clock.read());
    const wallMs = own(raw, "wallMs"),
      uncertaintyMs = own(raw, "uncertaintyMs");
    if (
      typeof wallMs !== "number" ||
      !Number.isSafeInteger(wallMs) ||
      wallMs < 0 ||
      typeof uncertaintyMs !== "number" ||
      !Number.isSafeInteger(uncertaintyMs) ||
      uncertaintyMs < 0 ||
      !Number.isSafeInteger(wallMs + uncertaintyMs)
    )
      refuse();
    const maxWallAdvancePpm = positive(own(raw, "maxWallAdvancePpm"));
    const validForMonotonicMs = positive(own(raw, "validForMonotonicMs"));
    const sample = Object.freeze({
      wallMs,
      uncertaintyMs,
      maxWallAdvancePpm,
      validForMonotonicMs,
      started,
    });
    entry.firstClock ??= sample;
    return sample;
  }
  private projectedUpper(sample: ClockSample, now: bigint): bigint {
    const elapsed = now - sample.started;
    if (elapsed < 0n || elapsed >= BigInt(sample.validForMonotonicMs) * 1_000_000n) refuse();
    // Exact upward rounding; a floating-point product must not lower the bound.
    const advance =
      (elapsed * BigInt(sample.maxWallAdvancePpm) + 999_999_999_999n) / 1_000_000_000_000n;
    return BigInt(sample.wallMs) + BigInt(sample.uncertaintyMs) + advance;
  }
  private native(entry: Entry<B>): void {
    this.local(entry);
    const invocation = entry.invocation;
    if (!invocation) refuse();
    this.fence(entry, () =>
      this.sources.invocation.recognize(
        invocation.original,
        entry.actor,
        entry.request,
        entry.call,
      ),
    );
    this.fence(entry, invocation.current);
    const current = snapshot(this.inspectData(entry, invocation.inspect));
    if (!entry.invocationData || !same(current, entry.invocationData)) refuse();
    this.local(entry);
  }
  private captureSelection(
    entry: Entry<B>,
    offered: PublicationWorkSelectionV1,
  ): PublicationWorkSelectionV1 {
    if (types.isPromise(offered)) this.poison(entry, offered);
    const operation = own(offered, "operation") as WorkOriginalOperationV2;
    object(operation);
    if (entry.operation && operation !== entry.operation) refuse();
    const admitted = own(offered, "admitted");
    const admissionOperation = own(admitted, "admissionOriginal") as WorkOriginalOperationV2;
    object(admissionOperation);
    if (entry.admissionOperation && entry.admissionOperation !== admissionOperation) refuse();
    const fixed = snapshot(offered);
    entry.admissionOperation ??= admissionOperation;
    entry.operation ??= operation; // Retain original separately from comparison.
    return fixed;
  }
  private compare(
    entry: Entry<B>,
    selected: PublicationWorkSelectionV1,
    sample: ClockSample,
  ): PublicationWorkBindingV1 {
    const binding = comparePublicationWorkSelectionV1(
      selected,
      entry.invocationData!,
      entry.requestData,
      { wallMs: sample.wallMs, uncertaintyMs: sample.uncertaintyMs },
    );
    const admitted = selected.admitted;
    const end = Math.min(
      instant(admitted.originalHorizon),
      instant(admitted.authority.notAfter),
      instant(entry.invocationData!.callDeadline),
      instant(selected.policy.bounds.notAfter),
      ...admitted.lineage.ancestors.map((a) => instant(a.originalHorizon)),
    );
    if (!entry.firstClock) refuse();
    entry.notAfter ??= end;
    if (entry.notAfter !== end) refuse();
    const monotonic = monotonicNow(),
      fixedEnd = BigInt(end);
    if (
      this.projectedUpper(entry.firstClock, monotonic) >= fixedEnd ||
      this.projectedUpper(sample, monotonic) >= fixedEnd
    )
      refuse();
    return binding;
  }

  acquire(
    actor: B["actor"],
    request: PublicationRequestV1,
    call: PublicationCallV1,
  ): Promise<OriginalPublicationWorkV1 | undefined> {
    let entry: Entry<B>;
    try {
      object(actor);
      object(request);
      object(call);
      if (this.stopping || this.active.size >= this.maximumActive || this.usedCalls.has(call))
        refuse();
      const requestRef = own(call, "requestRef"),
        signal = own(call, "signal") as AbortSignal;
      reference(requestRef);
      if (isAborted(signal)) refuse();
      const requestData = parsePublicationRequestV1(request);
      entry = {
        actor,
        request,
        requestData,
        requestDigest: publicationDigestV1("request", requestData),
        call,
        requestRef: requestRef as string,
        signal,
        pending: new Set(),
        retirements: [],
        valid: true,
        checking: false,
        closed: false,
      };
      this.usedCalls.add(call);
      this.active.add(entry);
      const cancel = () => {
        entry.valid = false;
        void this.finish(entry).catch(() => {});
      };
      EventTarget.prototype.addEventListener.call(signal, "abort", cancel, { once: true });
      entry.removeAbort = () =>
        EventTarget.prototype.removeEventListener.call(signal, "abort", cancel);
      if (isAborted(signal)) cancel();
    } catch {
      return Promise.resolve(undefined);
    }
    const entered = this.track(
      entry,
      Promise.resolve().then(() => this.acquireOwned(entry)),
    );
    return entered.then(
      async (value) => {
        if (!value) await this.finish(entry);
        return value;
      },
      async () => {
        entry.valid = false;
        await this.finish(entry);
        return undefined;
      },
    );
  }
  private async acquireOwned(entry: Entry<B>): Promise<OriginalPublicationWorkV1 | undefined> {
    this.local(entry);
    this.sample(entry); // Include every entered acquisition in the fixed lifetime.
    this.local(entry);
    const invocation = await this.sources.invocation.acquire(
      entry.actor,
      entry.request,
      entry.call,
    );
    if (!invocation) return undefined;
    this.retain(entry, invocation);
    entry.invocation = {
      original: own(invocation, "original") as B["invocation"],
      inspect: method(invocation, "inspect"),
      current: method(invocation, "assertNativeCurrent"),
      handoff: method(invocation, "prepareStateUse"),
    };
    object(entry.invocation.original);
    this.fence(entry, () =>
      this.sources.invocation.recognize(
        entry.invocation!.original,
        entry.actor,
        entry.request,
        entry.call,
      ),
    );
    entry.invocationData = snapshot(this.inspectData(entry, entry.invocation.inspect));
    if (entry.invocationData.requestDigest !== entry.requestDigest) refuse();
    this.native(entry);
    await entry.invocation.handoff();
    this.native(entry);
    const candidate = await this.sources.state.acquireAdmission(
      entry.invocation.original,
      entry.request,
      entry.call,
    );
    if (!candidate) return undefined;
    const admissionRetirement = this.retain(entry, candidate);
    const inspect = method<() => PublicationWorkSelectionV1>(candidate, "inspect");
    const current = method<() => undefined>(candidate, "assertCurrent");
    const prepare = method<() => Promise<void>>(candidate, "prepareCommit");
    const commit = method<PublicationWorkAdmissionLeaseV1<B["admission"]>["commitAdmission"]>(
      candidate,
      "commitAdmission",
    );
    const initialClock = this.sample(entry);
    this.native(entry);
    this.fence(entry, current);
    const selected = this.captureSelection(entry, this.inspectData(entry, inspect));
    this.compare(entry, selected, initialClock);
    const finalInitialClock = this.sample(entry);
    this.native(entry);
    this.fence(entry, current);
    const finalSelected = this.captureSelection(entry, this.inspectData(entry, inspect));
    if (!same(finalSelected, selected)) refuse();
    this.local(entry);
    this.compare(entry, finalSelected, finalInitialClock);
    entry.selection = finalSelected;
    await prepare();
    const preparedClock = this.sample(entry);
    this.native(entry);
    this.fence(entry, current);
    const prepared = this.captureSelection(entry, this.inspectData(entry, inspect));
    if (!same(prepared, selected)) refuse();
    this.compare(entry, prepared, preparedClock);
    const finalPreparedClock = this.sample(entry);
    this.native(entry);
    this.fence(entry, current);
    const finalPrepared = this.captureSelection(entry, this.inspectData(entry, inspect));
    if (!same(finalPrepared, prepared)) refuse();
    this.local(entry);
    this.compare(entry, finalPrepared, finalPreparedClock);
    const result = await commit();
    const kind = own(result, "kind");
    if (kind !== "committed") {
      if (kind !== "unknown" && kind !== "refused") refuse();
      return undefined;
    }
    entry.admission = own(result, "original") as B["admission"];
    object(entry.admission);
    this.fence(entry, () =>
      this.sources.state.recognizeAdmission(
        entry.admission!,
        entry.invocation!.original,
        entry.request,
        entry.call,
      ),
    );
    await this.retire(admissionRetirement);
    this.native(entry);
    const use = await this.sources.state.acquireUse(
      entry.admission,
      entry.invocation.original,
      entry.request,
      entry.call,
    );
    if (!use) return undefined;
    this.retain(entry, use);
    entry.use = {
      original: own(use, "original") as B["use"],
      inspect: method(use, "inspect"),
      current: method(use, "assertCurrent"),
      prepare: method(use, "prepare"),
    };
    object(entry.use.original);
    await entry.use.prepare();
    this.current(entry);
    const handle = Object.freeze({}) as OriginalPublicationWorkV1;
    this.handles.set(handle, entry);
    return handle;
  }
  private current(entry: Entry<B>): void {
    if (entry.checking) this.poison(entry);
    entry.checking = true;
    try {
      const currentClock = this.sample(entry);
      this.native(entry);
      if (!entry.use || !entry.admission || !entry.selection) refuse();
      this.fence(entry, () =>
        this.sources.state.recognizeAdmission(
          entry.admission!,
          entry.invocation!.original,
          entry.request,
          entry.call,
        ),
      );
      this.fence(entry, () =>
        this.sources.state.recognizeUse(
          entry.use!.original,
          entry.admission!,
          entry.invocation!.original,
          entry.request,
          entry.call,
        ),
      );
      this.fence(entry, entry.use.current);
      const selected = this.captureSelection(entry, this.inspectData(entry, entry.use.inspect));
      if (!same(selected, entry.selection)) refuse();
      this.compare(entry, selected, currentClock);
      const finalClock = this.sample(entry);
      this.native(entry);
      this.fence(entry, () =>
        this.sources.state.recognizeAdmission(
          entry.admission!,
          entry.invocation!.original,
          entry.request,
          entry.call,
        ),
      );
      this.fence(entry, () =>
        this.sources.state.recognizeUse(
          entry.use!.original,
          entry.admission!,
          entry.invocation!.original,
          entry.request,
          entry.call,
        ),
      );
      this.fence(entry, entry.use.current);
      const finalSelected = this.captureSelection(
        entry,
        this.inspectData(entry, entry.use.inspect),
      );
      if (!same(finalSelected, selected)) refuse();
      const binding = this.compare(entry, finalSelected, finalClock);
      if (entry.binding && !same(binding, entry.binding)) refuse();
      entry.binding ??= binding;
      this.local(entry);
    } catch (error) {
      entry.valid = false;
      void this.finish(entry).catch(() => {});
      throw error;
    } finally {
      entry.checking = false;
    }
  }
  assertCurrent(original: OriginalPublicationWorkV1, call: PublicationCallV1): undefined {
    const entry = this.handles.get(original);
    if (!entry || call !== entry.call) refuse();
    this.current(entry);
    return undefined;
  }
  inspect(original: OriginalPublicationWorkV1, call: PublicationCallV1): PublicationWorkBindingV1 {
    this.assertCurrent(original, call);
    return this.handles.get(original)!.binding!;
  }
  /** State's publisher recognizer obtains only the SAME known private receipt. */
  recognize(original: OriginalPublicationWorkV1, call: PublicationCallV1): B["admission"] {
    this.assertCurrent(original, call);
    return this.handles.get(original)!.admission!;
  }
  release(original: OriginalPublicationWorkV1): Promise<void> {
    const entry = this.handles.get(original);
    if (!entry) return Promise.reject(new Error("Original publication Work unavailable."));
    entry.valid = false;
    return this.finish(entry);
  }
  private finish(entry: Entry<B>): Promise<void> {
    entry.valid = false;
    if (entry.cleanup) return entry.cleanup;
    const cleanup = Promise.resolve().then(async () => {
      while (entry.pending.size) await Promise.allSettled([...entry.pending]);
      // A failed dependent retirement keeps its ancestors held. Retrying this
      // same cleanup can retire only the remaining original resources.
      for (const retirement of [...entry.retirements].reverse()) await this.retire(retirement);
      entry.removeAbort?.();
      entry.closed = true;
      this.active.delete(entry);
    });
    entry.cleanup = cleanup;
    void cleanup.catch(() => {
      if (entry.cleanup === cleanup) entry.cleanup = undefined;
    });
    return cleanup;
  }
  async close(): Promise<void> {
    this.stopping = true;
    const results = await Promise.allSettled([...this.active].map((entry) => this.finish(entry)));
    if (results.some((result) => result.status === "rejected")) refuse();
  }
}
