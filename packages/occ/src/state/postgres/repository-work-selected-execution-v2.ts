import { randomUUID } from "node:crypto";
import { types } from "node:util";
import type { NativeIAMTransactionView } from "@openclaw-enterprise/iam";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import { parseTurnJournalV1 } from "@openclaw-enterprise/contracts/turn-journal-v1";
import { ScopeViolationError } from "../../errors.ts";
import { decodeGitHubMediationRequest, type OpenRead } from "../../github-mediation-v2/wire.ts";
import {
  compareRepositoryWorkCurrentV2,
  repositoryWorkCurrentPolicyArmV2,
  repositoryWorkGitReadBindingV3,
  type RepositoryWorkCurrentV2,
} from "../../lifecycle/repository-work-v2.ts";
import { compareRepositoryWorkStateReadsetV2 } from "../../lifecycle/repository-work-state-v2.ts";
import {
  parseRepositoryWorkPolicyV2,
  repositoryWorkPolicyDigestV2,
  evaluateRepositoryWorkProtocolPolicyV2,
  type RepositoryWorkPolicyV2,
} from "../../lifecycle/repository-work-policy-v2.ts";
import type {
  WorkOriginalOperationV2,
  WorkRefV2,
  WorkRevisionV2,
  WorkWithdrawalRevisionV2,
  WorkInstantV2,
  WorkLineageMemberV2,
  WorkLineageV2,
} from "../../lifecycle/work-authority-ports-v2.ts";
import type {
  RepositoryWorkScopeV2,
  RepositoryWorkRecordV2,
  RepositoryWorkOperationV2,
  RepositoryWorkJsonV2,
  RepositoryWorkHeldLeaseV2,
  RepositoryWorkTransactionContextV2,
  RepositoryWorkSelectedExecutionDataV2,
  RepositoryWorkSelectedExecutionParticipantV2,
} from "../../ports/repository-work-v2.ts";
import type {
  RepositoryWorkNativeSelectedExecutionDataV2,
  RepositoryWorkNativeSelectedExecutionLeaseV2,
  RepositoryWorkSelectedExecutionAdmissionConstructionV2,
  RepositoryWorkSelectedExecutionAdmissionCoreV2,
  RepositoryWorkSelectedAdmissionV2,
} from "../../ports/repository-work-selected-execution-v2.ts";
import { runtimeAllocationTarget } from "../../runtime-authority/repository.ts";
import { parseAttemptRow, parseOperationRow, sameJournalValue } from "../../turn-journal/rows.ts";
import { createRuntimePreparationCreateReferenceReaderV1 } from "./runtime-preparation-create-correlation.ts";
import { canonicalRepositoryWorkV2 as canonical } from "./repository-work-canonical-v2.ts";
import {
  createPostgresRepositoryWorkV2,
  type RepositoryWorkBackendV2,
  type RepositoryWorkExecutionV2,
} from "./repository-work-v2.ts";
import { createPostgresRepositoryWorkPolicyV2 } from "./repository-work-policy-v2.ts";

export interface RepositoryWorkSelectedExecutionBackendV2 extends Pick<
  RepositoryWorkBackendV2,
  "context" | "joinAccepted" | "readRuntimeAllocation" | "appendAudit"
> {
  readonly iam: NativeIAMTransactionView;
  lockIAM(): Promise<void>;
}
export type RepositoryWorkSelectedExecutionEnterV2 = <T>(
  scope: RepositoryWorkScopeV2,
  bounds: { signal: AbortSignal; timeoutMs: number },
  execution: RepositoryWorkExecutionV2,
  body: (backend: RepositoryWorkSelectedExecutionBackendV2) => Promise<T>,
) => Promise<T>;

const fail: () => never = () => {
  throw new ScopeViolationError("The original selected Work execution is unavailable.");
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const copy = <T>(value: T): T => freeze(JSON.parse(canonical(value)));
const json = (value: unknown): RepositoryWorkJsonV2 => JSON.parse(canonical(value));
function method<T extends object, K extends keyof T>(owner: T, key: K): T[K] {
  const value = owner?.[key];
  if (typeof value !== "function") fail();
  return value.bind(owner) as T[K];
}
function ref(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}(?![\s\S])/.test(value))
    fail();
}
function instant(value: string): number {
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || time < 0 || new Date(time).toISOString() !== value) fail();
  return time;
}
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function scopeOf(data: RepositoryWorkNativeSelectedExecutionDataV2): RepositoryWorkScopeV2 {
  const s = data.admission.original.scope;
  return Object.freeze({
    installationId: s.installationRef,
    namespaceId: s.namespaceRef,
    agentId: s.agentRef,
    revisionRef: s.revisionRef,
  });
}

/** This component owns actual A, its first logical Work admission, and bounded
 * locked observations. It does not implement the later use/observer/inventory
 * interface and cannot be passed as a complete source by structural omission. */
export function createPostgresRepositoryWorkSelectedExecutionAdmissionV2<N, E, V extends 2 | 3>(
  enter: RepositoryWorkSelectedExecutionEnterV2,
  createPhase: () => RepositoryWorkExecutionV2["phase"],
  options: RepositoryWorkSelectedExecutionAdmissionConstructionV2<N, E, V>,
): RepositoryWorkSelectedExecutionAdmissionCoreV2<N, V> {
  const version = options.protocolVersion,
    maximum = options.maximumAdmissions;
  if (![2, 3].includes(version) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128)
    fail();
  const native = options.native,
    source = options.executions;
  const inspectNative = method(native, "inspect"),
    assertNative = method(native, "assertCurrent");
  const acquire = method(source, "acquire"),
    retainSource = method(source, "retain");
  const bindSource = method(source, "bindState");
  type Data = RepositoryWorkSelectedExecutionDataV2<V>;
  type Captured = { check(): undefined; prepare(): Promise<void>; release(): Promise<void> };
  type Hold = { check(): undefined; release(): Promise<void>; value: Data };
  type Entry = {
    session: N;
    raw: RepositoryWorkNativeSelectedExecutionLeaseV2<E>;
    execution: E;
    releaseRaw(): Promise<void>;
    inspectRaw(): RepositoryWorkNativeSelectedExecutionDataV2;
    checkRaw(call: AuthorityCallV1): undefined;
    native: Awaited<ReturnType<typeof inspectNative>>;
    data: RepositoryWorkNativeSelectedExecutionDataV2;
    original: WorkOriginalOperationV2;
    operationKey: string;
    fixed: string;
    request: OpenRead<V>;
    requestCanonical: string;
    originalCanonical: string;
    busy: boolean;
    closed: boolean;
    unknown: boolean;
    failed: boolean;
    failure?: unknown;
    pending: Set<Promise<unknown>>;
    tasks: Set<Promise<unknown>>;
    handle?: RepositoryWorkSelectedAdmissionV2<V>;
    selection?: Data;
    hold?: Hold | undefined;
    tx?: Tx | undefined;
    release?: Promise<void>;
    nativeStop?: (() => void) | undefined;
  };
  type Tx = {
    entry: Entry;
    backend: RepositoryWorkSelectedExecutionBackendV2;
    execution: RepositoryWorkExecutionV2;
    context: RepositoryWorkTransactionContextV2;
    call: AuthorityCallV1;
    requestRef: string;
    signal: AbortSignal;
    active: boolean;
    accepting: boolean;
    checking: boolean;
    held: Captured[];
    pending: Set<Promise<unknown>>;
    finalChecks: (() => undefined)[];
    stop(): void;
  };
  const members = new WeakMap<object, Entry>(),
    retained = new Map<E, Entry>();
  // Denial-only ownership of the scoped admission operation, independent of
  // fresh genuine E borrows. An unresolved COMMIT never becomes ordinary replay.
  const operations = new Map<string, Entry>();
  const contexts = new WeakMap<object, Tx>();
  let pendingAcquisitions = 0;
  let participant:
    | RepositoryWorkSelectedExecutionParticipantV2<N, RepositoryWorkSelectedAdmissionV2<V>>
    | undefined;
  function poison(e: Entry, error: unknown): never {
    if (!e.failed) {
      e.failed = true;
      e.failure = error;
    }
    e.tx?.execution.phase.poison(e.failure);
    throw e.failure;
  }
  function join(e: Entry, pending: Promise<unknown>): undefined {
    if (!types.isPromise(pending)) fail();
    e.pending.add(pending);
    void pending.then(
      () => e.pending.delete(pending),
      (error) => {
        e.pending.delete(pending);
        if (!e.failed) {
          e.failed = true;
          e.failure = error;
        }
        e.tx?.execution.phase.poison(error);
      },
    );
    const tx = e.tx;
    // Accepted completion is enrolled BEFORE checking operation permission,
    // including cancellation and out-of-ALS synchronous currentness callbacks.
    if (tx?.active) {
      tx.pending.add(pending);
      tx.backend.joinAccepted(pending);
      void pending.then(
        () => tx.pending.delete(pending),
        () => tx.pending.delete(pending),
      );
      if (tx.checking) {
        // Enroll first, including after cancellation/poison. Registration cannot
        // let the caller finish a synchronous fence by returning undefined.
        try {
          tx.execution.phase.assertActive();
        } catch (error) {
          return poison(e, error);
        }
        return poison(
          e,
          new ScopeViolationError("Completion entered during selected-execution currentness."),
        );
      }
    }
    return undefined;
  }
  function sync(e: Entry, value: unknown): undefined {
    if (value === undefined) return undefined;
    if (types.isPromise(value)) join(e, value);
    // Completion registration precedes even a preexisting phase refusal. Keep
    // that original error, without authorizing another operation or query.
    try {
      e.tx?.execution.phase.assertActive();
    } catch (error) {
      return poison(e, error);
    }
    return poison(e, new ScopeViolationError("Selected-execution assertions must be synchronous."));
  }
  async function drain(e: Entry) {
    while (e.pending.size) await Promise.allSettled([...e.pending]);
  }
  function local(e: Entry, call: AuthorityCallV1) {
    if (e.failed) throw e.failure;
    if (
      e.closed ||
      call.signal.aborted ||
      e.native.lifetime.aborted ||
      instant(call.deadline) <= Date.now() ||
      canonical(e.request) !== e.requestCanonical ||
      canonical(e.original) !== e.originalCanonical ||
      canonical(e.data) !== e.fixed
    )
      fail();
  }
  function captureData(e: Entry, value: RepositoryWorkNativeSelectedExecutionDataV2) {
    const observed: unknown = value;
    if (types.isPromise(observed)) {
      join(e, observed);
      fail();
    }
    const fixed = canonical(value);
    if (value.admission.original !== e.original || fixed !== e.fixed) fail();
  }
  function sourceFence(e: Entry, call: AuthorityCallV1) {
    local(e, call);
    sync(e, assertNative(e.session, call));
    sync(e, e.checkRaw(call));
    captureData(e, e.inspectRaw());
    local(e, call);
    if (
      Math.min(instant(e.data.validUntil), instant(e.data.admission.originalHorizon)) <= Date.now()
    )
      fail();
  }
  function fence(tx: Tx): undefined {
    if (
      !tx.active ||
      tx.checking ||
      tx.call.requestRef !== tx.requestRef ||
      tx.call.signal !== tx.signal
    )
      fail();
    tx.execution.phase.assertActive();
    tx.checking = true;
    try {
      sourceFence(tx.entry, tx.call);
      sync(tx.entry, tx.backend.iam.assertCurrent());
      for (const held of tx.held) sync(tx.entry, held.check());
      for (const check of tx.finalChecks) sync(tx.entry, check());
      local(tx.entry, tx.call);
      tx.execution.phase.assertActive();
      return undefined;
    } catch (error) {
      return poison(tx.entry, error);
    } finally {
      tx.checking = false;
    }
  }
  function retain(tx: Tx, raw: RepositoryWorkHeldLeaseV2) {
    if (!tx.active || !tx.accepting || tx.checking || tx.held.length >= 16) fail();
    const release = method(raw, "release");
    // Install cleanup before touching either later supplier method/getter.
    const held: Captured = { release, check: () => undefined, prepare: async () => {} };
    tx.held.push(held);
    held.check = method(raw, "assertCurrent");
    held.prepare = method(raw, "prepareCommit");
  }
  async function query(tx: Tx, sql: string, parameters: readonly unknown[]) {
    if (tx.checking) fail();
    fence(tx);
    const result = await tx.backend.context.query.query(sql, parameters);
    fence(tx);
    if (!Number.isSafeInteger(result.rowCount) || result.rowCount !== result.rows.length) fail();
    return result.rows;
  }
  bindSource(
    Object.freeze({
      assertOriginal(
        context: RepositoryWorkTransactionContextV2,
        execution: E,
        session: N,
        call: AuthorityCallV1,
      ): undefined {
        const tx = contexts.get(context);
        if (
          !tx ||
          !tx.active ||
          tx.entry.execution !== execution ||
          tx.entry.session !== session ||
          tx.call !== call
        )
          fail();
        tx.execution.phase.assertActive();
        local(tx.entry, call);
        return undefined;
      },
    }),
  );
  function validateNative(
    data: RepositoryWorkNativeSelectedExecutionDataV2,
    request: OpenRead<V>,
    observed: Entry["native"],
  ) {
    canonical(data);
    const start = parseTurnJournalV1("executionStart", data.start),
      original = data.admission.original;
    for (const value of [
      original.operationRef,
      original.invocationRef,
      ...Object.values(original.scope),
      data.requesterPrincipalId,
      data.admission.policyRef,
      data.admission.membershipProfile.ref,
      data.admission.membershipProfile.revision,
      data.attachmentRef,
      data.dnsBindingRef,
    ])
      ref(value);
    if (
      !/^sha256:[a-f0-9]{64}(?![\s\S])/.test(original.requestDigest) ||
      original.requestDigest !== request.request_sha256 ||
      data.attachmentRef !== request.attachment_ref ||
      data.service.kind !== "service_principal" ||
      observed.verified.configuration.allowedScope.kind !== "agent" ||
      observed.verified.configuration.role !== "repository-issuer" ||
      observed.verified.configuration.allowedScope.installationId !==
        original.scope.installationRef ||
      observed.verified.configuration.allowedScope.namespaceId !== original.scope.namespaceRef ||
      observed.verified.configuration.allowedScope.agentId !== original.scope.agentRef ||
      !same(data.execution.attempt, start.intent.execution.attempt) ||
      data.execution.executionIncarnationRef !== start.nativeIncarnationRef ||
      data.execution.assignmentRef !== data.runtime.target.assignmentRef.id ||
      data.execution.attempt.installationRef !== original.scope.installationRef ||
      data.execution.attempt.namespaceRef !== original.scope.namespaceRef ||
      data.execution.attempt.agentRef !== original.scope.agentRef ||
      !["admit-root", "admit-child", "existing"].includes(data.admission.mode.kind) ||
      !/^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(data.upstreamIpv4) ||
      data.upstreamIpv4.split(".").some((x) => Number(x) > 255) ||
      instant(data.admission.workBeganAt) > Date.now() ||
      instant(data.admission.originalHorizon) <= Date.now() ||
      instant(data.validUntil) > instant(data.admission.originalHorizon) ||
      instant(data.validUntil) <= Date.now()
    )
      fail();
    if (data.admission.mode.kind === "admit-child") ref(data.admission.mode.parentWorkRef);
    if (data.admission.mode.kind === "existing") ref(data.admission.mode.workRef);
  }
  async function journal(tx: Tx) {
    const d = tx.entry.data,
      start = d.start,
      exact = start.intent.execution,
      a = exact.attempt;
    const keys = [
      a.installationRef,
      a.namespaceRef,
      a.agentRef,
      a.conversationRef,
      a.turnRef,
      a.attemptRef,
      a.reservationRef,
    ];
    const where =
      "installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND conversation_ref=$4 AND turn_ref=$5 AND attempt_ref=$6 AND reservation_ref=$7";
    // Existing journal mutations acquire Agent before attempt: preserve that
    // order, then retain the row against cancellation/completion through COMMIT.
    const rows = await query(
      tx,
      `SELECT * FROM occ.turn_journal_attempts WHERE ${where} FOR SHARE`,
      keys,
    );
    if (rows.length !== 1) fail();
    const attempt = parseAttemptRow(row(rows[0]));
    if (
      ("phase" in attempt && attempt.phase === "admitted-undispatched") ||
      !attempt.consumption ||
      !sameJournalValue(attempt.consumption.operation, exact.consumption) ||
      !sameJournalValue(attempt.binding.attempt, a) ||
      !("dispatchOperationRef" in attempt.binding) ||
      attempt.binding.dispatchOperationRef !== exact.dispatchOperationRef ||
      attempt.binding.identity.admittedRevisionRef !== d.admission.original.scope.revisionRef ||
      attempt.binding.identity.principalRef !== d.requesterPrincipalId ||
      attempt.binding.identity.harnessAssignment.id !== d.execution.assignmentRef ||
      !["consumed", "running"].includes(attempt.outcome.kind)
    )
      fail();
    if (
      attempt.outcome.kind === "running" &&
      (attempt.outcome.nativeSessionRef !== start.nativeSessionRef ||
        attempt.outcome.nativeTurnRef !== start.nativeTurnRef)
    )
      fail();
    const operations = (
      await query(
        tx,
        `SELECT * FROM occ.turn_journal_operations WHERE ${where} AND operation_kind IN ('execution-intent','deadline-control','execution-start','execution-interruption','cancellation','completion','release') ORDER BY operation_kind`,
        keys,
      )
    ).map((value) => parseOperationRow(row(value)));
    if (operations.length !== 3) fail();
    const intent = operations.find((o) => o.operationKind === "execution-intent");
    const control = operations.find((o) => o.operationKind === "deadline-control");
    const begun = operations.find((o) => o.operationKind === "execution-start");
    if (
      !intent ||
      !control ||
      !begun ||
      !sameJournalValue(intent.record, start.intent) ||
      !sameJournalValue(control.record, start.deadlineControl) ||
      !sameJournalValue(begun.record, start)
    )
      fail();
    const reservations = await query(
      tx,
      `SELECT 1 AS held FROM occ.turn_journal_reservations WHERE ${where} FOR SHARE`,
      keys,
    );
    if (reservations.length !== 1) fail();
    // deadlineAtMs belongs to the retained native monotonic clock. The original
    // E lease fences that bound; it cannot be compared or converted to UTC.
    // UTC Work/policy/call bounds are independently fenced by this owner.
  }
  async function prefix(tx: Tx) {
    const e = tx.entry,
      d = e.data,
      scope = scopeOf(d);
    retain(tx, await retainSource(tx.context, e.execution, e.session, tx.call));
    fence(tx);
    await tx.backend.lockIAM();
    fence(tx);
    const runtime = d.runtime;
    const located = await createRuntimePreparationCreateReferenceReaderV1(tx.backend.context).read(
      {
        installationId: scope.installationId,
        namespaceId: scope.namespaceId,
        agentId: scope.agentId,
      },
      { kind: "create-effect", createEffectRef: runtime.childEffectRef },
    );
    fence(tx);
    if (
      located.status !== "located" ||
      located.retained.preparation.preparationRef !== runtime.preparationRef ||
      located.retained.preparation.localVersion !== runtime.preparationVersion ||
      !same(located.input.effect.target, runtime.target) ||
      !tx.backend.readRuntimeAllocation
    )
      fail();
    const allocation = await tx.backend.readRuntimeAllocation(d.execution.assignmentRef);
    fence(tx);
    if (
      !allocation ||
      allocation.installationId !== scope.installationId ||
      allocation.namespaceId !== scope.namespaceId ||
      allocation.agentId !== scope.agentId ||
      allocation.revisionId !== scope.revisionRef ||
      allocation.servicePrincipalId !== d.service.id ||
      !same(runtimeAllocationTarget(allocation), runtime.target)
    )
      fail();
    for (const [sql, args, id] of [
      [
        "SELECT id FROM occ.installation WHERE id=$1 FOR NO KEY UPDATE",
        [scope.installationId],
        scope.installationId,
      ],
      [
        "SELECT id FROM occ.namespaces WHERE id=$1 FOR NO KEY UPDATE",
        [scope.namespaceId],
        scope.namespaceId,
      ],
      [
        "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR NO KEY UPDATE",
        [scope.namespaceId, scope.agentId],
        scope.agentId,
      ],
    ] as const) {
      const found = await query(tx, sql, args);
      if (found.length !== 1 || !same(found[0], { id })) fail();
    }
    await journal(tx);
    const decision = await tx.backend.iam.authorize({
      principalId: d.requesterPrincipalId,
      action: "operate",
      resource: { kind: "agent", id: scope.agentId, namespaceId: scope.namespaceId },
    });
    fence(tx);
    if (!decision.allowed) fail();
  }
  function operation(
    e: Entry,
    purpose: "preparation" | "dispatch" | "observation",
  ): WorkOriginalOperationV2 {
    // Data-domain casts label State-allocated operation IDs. They never construct
    // E/A or turn a caller-supplied operation DTO into original membership.
    return Object.freeze({
      ...e.original,
      operationRef:
        `repository-${purpose}:${randomUUID()}` as WorkOriginalOperationV2["operationRef"],
    });
  }
  function build(
    e: Entry,
    policy: RepositoryWorkPolicyV2,
    chain: readonly RepositoryWorkRecordV2[],
    admission: RepositoryWorkOperationV2,
    call: AuthorityCallV1,
  ): Data {
    const d = e.data,
      own = chain.at(-1);
    if (!own) fail();
    const stored = row(own.originalAdmission),
      originals = row(stored.originals);
    const original = originals.dispatch as WorkOriginalOperationV2,
      preparation = originals.preparation as WorkOriginalOperationV2,
      observation = originals.observation as WorkOriginalOperationV2;
    const nativeStored = row(stored.native),
      admissionStored = row(nativeStored.admission);
    const { mode: _oldMode, ...oldAdmission } = admissionStored;
    const { mode: _newMode, ...newAdmission } = d.admission;
    if (
      !same({ ...nativeStored, admission: oldAdmission }, { ...d, admission: newAdmission }) ||
      !same(stored.admissionOriginal, e.original)
    )
      fail();
    if (d.admission.mode.kind === "admit-root" && own.parentWorkRef !== null) fail();
    if (
      d.admission.mode.kind === "admit-child" &&
      own.parentWorkRef !== d.admission.mode.parentWorkRef
    )
      fail();
    for (const operation of [original, preparation, observation]) {
      if (
        !operation ||
        !same(operation.scope, e.original.scope) ||
        operation.invocationRef !== e.original.invocationRef ||
        operation.requestDigest !== e.original.requestDigest
      )
        fail();
      ref(operation.operationRef);
    }
    if (
      new Set([
        e.original.operationRef,
        original.operationRef,
        preparation.operationRef,
        observation.operationRef,
      ]).size !== 4
    )
      fail();
    ref(stored.observationRef);
    ref(stored.observationEvidenceRef);
    const toMember = (r: RepositoryWorkRecordV2): WorkLineageMemberV2 =>
      Object.freeze({
        work: Object.freeze({
          workRef: r.workRef as WorkRefV2,
          revision: r.revision as WorkRevisionV2,
        }),
        state: r.state,
        originalHorizon: r.originalHorizon as WorkInstantV2,
        withdrawalRevision: r.withdrawalRevision as WorkWithdrawalRevisionV2,
      });
    const ownMember = toMember(own),
      ancestors = chain.slice(0, -1).map(toMember);
    const lineage: WorkLineageV2 =
      own.parentWorkRef === null
        ? {
            scope: e.original.scope,
            own: ownMember,
            membershipProfile: d.admission.membershipProfile,
            kind: "root",
            rootWorkRef: own.rootWorkRef as WorkRefV2,
            parentWorkRef: null,
            ancestors: [],
          }
        : {
            scope: e.original.scope,
            own: ownMember,
            membershipProfile: d.admission.membershipProfile,
            kind: "attached-child",
            rootWorkRef: own.rootWorkRef as WorkRefV2,
            parentWorkRef: own.parentWorkRef as WorkRefV2,
            ancestors: ancestors as [WorkLineageMemberV2, ...WorkLineageMemberV2[]],
          };
    const common = {
      original,
      work: ownMember.work,
      execution: d.execution,
      lineage,
      withdrawals: [ownMember, ...ancestors].map((member) => ({
        kind: "not-withdrawn-at-cut" as const,
        revision: member.withdrawalRevision,
      })),
      service: d.service,
      originalHorizon: own.originalHorizon as WorkInstantV2,
      repository: {
        id: policy.repository.target.repositoryId,
        owner: policy.repository.owner,
        name: policy.repository.name,
        profile: policy.repository.profile,
      },
      attachmentRef: d.attachmentRef,
      dnsBindingRef: d.dnsBindingRef,
      upstreamIpv4: d.upstreamIpv4,
      validUntil: new Date(
        Math.min(instant(call.deadline), instant(d.validUntil), instant(own.originalHorizon)),
      ).toISOString() as WorkInstantV2,
    };
    const policyBase = {
      operation: "work.repository.use" as const,
      service: d.service,
      repositoryId: policy.repository.target.repositoryId,
      profile: policy.repository.profile,
    };
    const candidate: RepositoryWorkCurrentV2<2 | 3> =
      version === 3
        ? {
            ...common,
            policy: {
              ...policyBase,
              repositoryOperation: "git:read",
              requiredPermissions: ["contents:read", "metadata:read"],
            },
            repositoryRequest: repositoryWorkGitReadBindingV3(e.request as OpenRead<3>),
          }
        : { ...common, policy: { ...policyBase, permission: "metadata:read" } };
    // Narrow only the locally constructed closed data arm, never authority.
    if (!currentArm(candidate, version)) fail();
    const current = candidate;
    const result: Data = {
      runtime: d.runtime,
      selection: {
        current,
        preparation,
        observation,
        admission: { kind: "existing", originalAdmission: admission },
        sessionRef: e.native.sessionRef,
        repositoryTarget: policy.repository.target,
        policyAdmission: {
          policyRef: policy.policyRef,
          policyVersion: policy.version,
          policyDigest: repositoryWorkPolicyDigestV2(policy),
          execution: d.execution,
          originalHorizon: own.originalHorizon,
        },
        workBeganAt: d.admission.workBeganAt,
        observationRef: String(stored.observationRef),
        observationEvidenceRef: String(stored.observationEvidenceRef),
      },
    };
    const prior = e.selection;
    if (prior) {
      const { validUntil: _old, ...oldCurrent } = prior.selection.current;
      const { validUntil: _new, ...newCurrent } = current;
      if (
        !same(
          { ...prior, selection: { ...prior.selection, current: oldCurrent } },
          { ...result, selection: { ...result.selection, current: newCurrent } },
        )
      )
        fail();
      // Preserve exact original phase objects across every refreshed SQL read.
      return freeze({
        ...result,
        selection: {
          ...result.selection,
          current: { ...current, original: prior.selection.current.original },
          preparation: prior.selection.preparation,
          observation: prior.selection.observation,
          admission: prior.selection.admission,
        },
      });
    }
    return freeze(result);
  }
  function currentArm<P extends 2 | 3>(
    value: RepositoryWorkCurrentV2<2 | 3>,
    selected: P,
  ): value is RepositoryWorkCurrentV2<2 | 3> & RepositoryWorkCurrentV2<P> {
    const arm = repositoryWorkCurrentPolicyArmV2(value);
    return selected === 3
      ? Object.hasOwn(value, "repositoryRequest") &&
          same(arm, {
            repositoryOperation: "git:read",
            requiredPermissions: ["contents:read", "metadata:read"],
          })
      : !Object.hasOwn(value, "repositoryRequest") && same(arm, { permission: "metadata:read" });
  }
  function validateSelection(e: Entry, value: Data, policy: RepositoryWorkPolicyV2) {
    const s = value.selection,
      c = s.current;
    compareRepositoryWorkCurrentV2(
      c,
      e.request,
      {
        context: e.native.context,
        transportBinding: e.native.verified.transportBinding,
        attachmentRef: e.data.attachmentRef,
        receiverRef: e.data.execution.receiverRef,
        execution: e.data.execution,
        service: e.data.service,
      },
      Date.now(),
      version,
    );
    const decision = evaluateRepositoryWorkProtocolPolicyV2(
      policy,
      {
        scope: c.original.scope,
        service: c.service,
        execution: c.execution,
        admitted: s.policyAdmission,
        repository: policy.repository,
        operation: version === 3 ? "git:read" : "metadata:read",
        workBeganAt: s.workBeganAt,
        originalHorizon: c.originalHorizon,
        now: new Date().toISOString(),
      },
      version,
      repositoryWorkCurrentPolicyArmV2(c),
    );
    if (decision.kind !== "matches") fail();
  }
  async function select(tx: Tx, mayInsert: boolean): Promise<Data> {
    const e = tx.entry,
      d = e.data,
      scope = scopeOf(d);
    const storedPolicy = await createPostgresRepositoryWorkPolicyV2(
      tx.backend.context,
      scope,
      tx.execution.commitRef,
    ).find(d.admission.policyRef);
    fence(tx);
    const policy = storedPolicy && parseRepositoryWorkPolicyV2(storedPolicy.document);
    if (
      !policy ||
      policy.status !== "enabled" ||
      policy.servicePrincipalId !== d.service.id ||
      !same(policy.executionProfile, d.execution.executionProfile) ||
      policy.repository.owner !== e.request.repository_owner ||
      policy.repository.name !== e.request.repository_name ||
      !policy.operations.includes(version === 3 ? "git:read" : "metadata:read") ||
      instant(d.admission.workBeganAt) < instant(policy.bounds.notBefore) ||
      instant(d.admission.originalHorizon) > instant(policy.bounds.notAfter) ||
      instant(d.admission.originalHorizon) - instant(d.admission.workBeganAt) >
        policy.bounds.maximumWorkMilliseconds
    )
      fail();
    const repository = createPostgresRepositoryWorkV2(
      tx.backend.context,
      scope,
      tx.execution.commitRef,
    );
    let found = await repository.findOperation(e.original.operationRef);
    fence(tx);
    if (found.kind === "absent") {
      if (!mayInsert || e.unknown || d.admission.mode.kind === "existing") fail();
      const parent =
        d.admission.mode.kind === "admit-child" ? d.admission.mode.parentWorkRef : null;
      const ancestry = parent === null ? [] : (await repository.readChain(parent)).lineage;
      fence(tx);
      if (
        ancestry.some(
          (r) =>
            r.state !== "open" || instant(r.originalHorizon) < instant(d.admission.originalHorizon),
        )
      )
        fail();
      const workRef = `repository-work:${randomUUID()}`;
      const originals = {
        preparation: operation(e, "preparation"),
        dispatch: operation(e, "dispatch"),
        observation: operation(e, "observation"),
      };
      const policyBase = {
        operation: "work.repository.use",
        service: d.service,
        repositoryId: policy.repository.target.repositoryId,
        profile: policy.repository.profile,
      };
      const record: RepositoryWorkRecordV2 = {
        scope,
        workRef,
        revision: 1,
        withdrawalRevision: 0,
        parentWorkRef: parent,
        rootWorkRef: ancestry[0]?.workRef ?? workRef,
        originalHorizon: d.admission.originalHorizon,
        state: "open",
        execution: json(d.execution),
        policy: json(
          version === 3
            ? {
                ...policyBase,
                repositoryOperation: "git:read",
                requiredPermissions: ["contents:read", "metadata:read"],
              }
            : { ...policyBase, permission: "metadata:read" },
        ),
        originalAdmission: json({
          native: d,
          admissionOriginal: e.original,
          originals,
          observationRef: `repository-observation:${randomUUID()}`,
          observationEvidenceRef: `repository-evidence:${randomUUID()}`,
        }),
      };
      // Original mode+operation, current IAM, exact journal, policy and parents
      // have all been checked. An absent row alone never reaches this insertion.
      const provisional: RepositoryWorkOperationV2 = {
        operationRef: e.original.operationRef,
        requestDigest: e.original.requestDigest,
        invocationRef: e.original.invocationRef,
        scope,
        commitRef: tx.execution.commitRef,
        kind: "admission",
        document: json({ record }),
      };
      const candidate = build(e, policy, [...ancestry, record], provisional, tx.call);
      validateSelection(e, candidate, policy);
      fence(tx);
      await repository.admit(e.original, { record });
      fence(tx);
      await tx.backend.appendAudit(d.requesterPrincipalId, e.original.operationRef, "admission");
      fence(tx);
      found = await repository.findOperation(e.original.operationRef);
      fence(tx);
    }
    if (
      found.kind !== "recorded" ||
      found.operation.kind !== "admission" ||
      found.operation.requestDigest !== e.original.requestDigest ||
      found.operation.invocationRef !== e.original.invocationRef ||
      !same(found.operation.scope, scope)
    )
      fail();
    const record = row(row(found.operation.document).record);
    ref(record.workRef);
    if (d.admission.mode.kind === "existing" && d.admission.mode.workRef !== record.workRef) fail();
    const readset = await repository.readChain(record.workRef);
    fence(tx);
    if (!same(readset.lineage.at(-1), record)) fail();
    const selected = build(e, policy, readset.lineage, found.operation, tx.call);
    compareRepositoryWorkStateReadsetV2(readset, selected.selection.current);
    validateSelection(e, selected, policy);
    tx.finalChecks.push(() => {
      validateSelection(e, selected, policy);
      return undefined;
    });
    return selected;
  }
  async function transaction(e: Entry, call: AuthorityCallV1, hold: boolean): Promise<Data | Hold> {
    const phase = createPhase();
    let tx: Tx | undefined, value: Data | undefined, stop!: () => void;
    let stopped = false,
      finish!: () => void,
      reject!: (error: unknown) => void;
    const stopping = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const ready = new Promise<void>((resolve, no) => {
      finish = resolve;
      reject = no;
    });
    void ready.catch(() => {});
    const retirement = new ScopeViolationError("The selected-execution readset was retired.");
    const stopRead = () => {
      stopped = true;
      stop();
    };
    const execution: RepositoryWorkExecutionV2 = {
      commitRef: randomUUID(),
      phase,
      disposition: "not-sent",
      establishedNoCommit: false,
      async prepareCommit() {
        await phase.drainAccepted();
        await phase.runFinalization(async () => {
          if (!tx || hold) fail();
          fence(tx);
          for (const held of tx.held) {
            await held.prepare();
            fence(tx);
          }
        });
      },
      assertCommitReady() {
        if (!tx || hold) fail();
        fence(tx);
        phase.assertCommitReady();
      },
      observeAcknowledgment() {
        execution.disposition = "acknowledged";
      },
      close() {
        stopRead();
      },
    };
    call.signal.addEventListener("abort", stopRead, { once: true });
    const timer = setTimeout(
      stopRead,
      Math.max(0, Math.min(3000, instant(call.deadline) - Date.now())),
    );
    const completion = (async () => {
      try {
        await enter(
          scopeOf(e.data),
          { signal: call.signal, timeoutMs: Math.min(3000, instant(call.deadline) - Date.now()) },
          execution,
          (backend) =>
            phase.runTransition(async () => {
              const context: RepositoryWorkTransactionContextV2 = Object.freeze({
                installationId: scopeOf(e.data).installationId,
                assertActive() {
                  if (!tx || tx.checking || !tx.accepting) fail();
                  backend.context.transaction.assertActive();
                  return undefined;
                },
                retain(raw: RepositoryWorkHeldLeaseV2) {
                  if (!tx) fail();
                  retain(tx, raw);
                  return undefined;
                },
                joinAccepted(pending: Promise<unknown>) {
                  if (this !== context || !tx?.active) fail();
                  return join(e, pending);
                },
              });
              tx = {
                entry: e,
                backend,
                execution,
                context,
                call,
                requestRef: call.requestRef,
                signal: call.signal,
                active: true,
                accepting: true,
                checking: false,
                held: [],
                pending: new Set(),
                finalChecks: [],
                stop: stopRead,
              };
              e.tx = tx;
              contexts.set(context, tx);
              try {
                await phase.runAcceptance(async () => {
                  await prefix(tx!);
                  return true;
                });
                tx.accepting = false;
                value = await phase.runOperation(async () => select(tx!, !hold));
                fence(tx);
                if (hold) {
                  await phase.runOperation(async () => {
                    if (stopped) throw retirement;
                    finish();
                    await stopping;
                    throw retirement;
                  });
                }
              } finally {
                tx.accepting = false;
                // Promise drainage must precede returning to outer rollback.
                await drain(e);
              }
            }),
        );
        if (hold || execution.disposition !== "acknowledged" || !value) fail();
      } catch (error) {
        if (execution.disposition === "sent") e.unknown = true;
        if (!(hold && stopped && error === retirement)) {
          reject(error);
          if (!e.failed) {
            e.failed = true;
            e.failure = error;
          }
          throw e.failure;
        }
      } finally {
        clearTimeout(timer);
        call.signal.removeEventListener("abort", stopRead);
        await drain(e);
        if (tx) {
          tx.active = false;
          contexts.delete(tx.context);
          for (const held of [...tx.held].reverse()) {
            try {
              await held.release();
            } catch (error) {
              if (!e.failed) {
                e.failed = true;
                e.failure = error;
              }
            }
          }
          if (e.tx === tx) e.tx = undefined;
        }
      }
      if (!hold) {
        if (e.failed) throw e.failure;
        return value!;
      }
      return undefined;
    })();
    e.tasks.add(completion);
    void completion.then(
      () => e.tasks.delete(completion),
      () => e.tasks.delete(completion),
    );
    if (!hold) {
      const result = await completion;
      if (!result) fail();
      sourceFence(e, call);
      return result;
    }
    await ready;
    if (!tx || !value || stopped) {
      await completion;
      fail();
    }
    let released: Promise<void> | undefined;
    return {
      value,
      check() {
        if (!tx || stopped) fail();
        return fence(tx);
      },
      release() {
        return (released ??= (async () => {
          stopRead();
          await completion;
          if (e.failed) throw e.failure;
        })());
      },
    };
  }
  async function retire(e: Entry) {
    return (e.release ??= (async () => {
      e.closed = true;
      e.tx?.stop();
      await e.hold?.release().catch(() => {});
      e.hold = undefined;
      while (e.tasks.size) await Promise.allSettled([...e.tasks]);
      await drain(e);
      await e.releaseRaw();
      e.nativeStop?.();
      e.nativeStop = undefined;
      // Unknown disposition retains its original operation slot; no retry or
      // remint is inferred. Later exact recovery remains a separate component.
      if (!e.unknown) {
        retained.delete(e.execution);
        if (operations.get(e.operationKey) === e) operations.delete(e.operationKey);
      }
    })());
  }
  async function refresh(e: Entry, call: AuthorityCallV1) {
    const observed = await inspectNative(e.session, call);
    if (
      observed.context !== call.context ||
      observed.sessionRef !== e.native.sessionRef ||
      observed.lifetime !== e.native.lifetime ||
      observed.verified.transportBinding !== e.native.verified.transportBinding ||
      !same(observed.verified.configuration, e.native.verified.configuration)
    )
      fail();
    e.native = observed;
    sourceFence(e, call);
  }
  const owner: RepositoryWorkSelectedExecutionAdmissionCoreV2<N, V> = {
    bindState(value) {
      if (participant) fail();
      // Capture actual recognizers once for the subsequent original use join.
      participant = Object.freeze({
        assertOriginal: method(value, "assertOriginal"),
        assertObservationOriginal: method(value, "assertObservationOriginal"),
      });
      return undefined;
    },
    async acquire(request, session, call) {
      if (!participant || retained.size + pendingAcquisitions >= maximum) return undefined;
      let cleanup: (() => Promise<void>) | undefined, e: Entry | undefined;
      const acquiring = new Set<Promise<unknown>>();
      pendingAcquisitions++;
      try {
        const decoded = decodeGitHubMediationRequest(
          new TextEncoder().encode(JSON.stringify(request)),
          version,
        );
        if (
          decoded?.method !== "open-read" ||
          !same(decoded, request) ||
          request.request_ref !== call.requestRef ||
          call.signal.aborted
        )
          fail();
        const observed = await inspectNative(session, call);
        if (observed.context !== call.context || observed.lifetime.aborted) fail();
        const raw = await acquire(session, request, call);
        if (!raw) return undefined;
        cleanup = method(raw, "release");
        const execution = raw.original;
        if (
          !execution ||
          (typeof execution !== "object" && typeof execution !== "function") ||
          retained.has(execution)
        )
          fail();
        const inspectRaw = method(raw, "inspect"),
          checkRaw = method(raw, "assertCurrent");
        const data = inspectRaw();
        if (types.isPromise(data)) {
          acquiring.add(data);
          await Promise.allSettled([...acquiring]);
          fail();
        }
        validateNative(data, request, observed);
        const original = data.admission.original;
        const operationKey = canonical({
          scope: scopeOf(data),
          operationRef: original.operationRef,
        });
        if (operations.has(operationKey)) fail();
        e = {
          session,
          raw,
          execution,
          releaseRaw: cleanup,
          inspectRaw,
          checkRaw,
          native: observed,
          data: copy(data),
          original,
          operationKey,
          fixed: canonical(data),
          request: copy(request),
          requestCanonical: canonical(request),
          originalCanonical: canonical(original),
          busy: true,
          closed: false,
          unknown: false,
          failed: false,
          pending: new Set(),
          tasks: new Set(),
        };
        retained.set(execution, e);
        operations.set(operationKey, e);
        cleanup = undefined;
        const entry = e;
        const abort = () => {
          void retire(entry).catch(() => {});
        };
        observed.lifetime.addEventListener("abort", abort, { once: true });
        e.nativeStop = () => observed.lifetime.removeEventListener("abort", abort);
        sourceFence(e, call);
        e.selection = (await transaction(e, call, false)) as Data;
        e.hold = (await transaction(e, call, true)) as Hold;
        e.selection = e.hold.value;
        e.hold.check();
        // This object is issued only here, after actual ACK+terminal cleanup and
        // reacquisition of a current original readset, never from stored JSON.
        const handle = Object.freeze({}) as RepositoryWorkSelectedAdmissionV2<V>;
        e.handle = handle;
        members.set(handle, e);
        e.busy = false;
        return handle;
      } catch (error) {
        if (e) {
          if (!e.failed) {
            e.failed = true;
            e.failure = error;
          }
          await retire(e).catch(() => {});
        } else if (cleanup) await cleanup();
        return undefined;
      } finally {
        pendingAcquisitions--;
      }
    },
    async inspect(admission, session, call) {
      const e = members.get(admission);
      if (!e || e.session !== session || e.busy || e.closed) fail();
      e.busy = true;
      try {
        await e.hold?.release();
        e.hold = undefined;
        await refresh(e, call);
        e.hold = (await transaction(e, call, true)) as Hold;
        e.selection = e.hold.value;
        e.hold.check();
        return e.selection;
      } catch (error) {
        await retire(e).catch(() => {});
        throw error;
      } finally {
        e.busy = false;
      }
    },
    assertCurrent(admission, session, call) {
      const e = members.get(admission);
      if (!e || e.session !== session || e.busy || e.closed || !e.hold || e.tx?.call !== call)
        fail();
      return e.hold.check();
    },
    async release(admission) {
      const e = members.get(admission);
      if (!e) fail();
      await retire(e);
    },
  };
  return Object.freeze(owner);
}
