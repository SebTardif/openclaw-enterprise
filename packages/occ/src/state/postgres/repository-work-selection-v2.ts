import { ScopeViolationError } from "../../errors.ts";
import {
  sameRepositoryWorkInventoryV2 as same,
  repositoryWorkInventoryUnavailableV2 as fail,
} from "./repository-work-current-inventory-v2.ts";
export { readRepositoryWorkInventoryCurrentV2 } from "./repository-work-current-inventory-v2.ts";

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import { decodeGitHubMediationRequest, type OpenRead } from "../../github-mediation-v2/wire.ts";
import type {
  RepositoryWorkOriginAssignmentV2,
  OriginalRepositoryWorkOriginV2,
  RepositoryWorkOriginAssignmentRecognizerV2,
} from "../../runtime-authority/repository-work-origin-v2.ts";
import { runtimeAllocationTarget } from "../../runtime-authority/repository.ts";
import { compareRepositoryWorkOriginAssignmentV2 } from "../../runtime-authority/repository-work-origin-v2.ts";
import { compareRepositoryWorkStateReadsetV2 } from "../../lifecycle/repository-work-state-v2.ts";
import type { WorkOriginalOperationV2 } from "../../lifecycle/work-authority-ports-v2.ts";
import { evaluateRepositoryWorkProtocolPolicyV2 } from "../../lifecycle/repository-work-policy-v2.ts";
import { repositoryWorkCurrentPolicyArmV2 } from "../../lifecycle/repository-work-v2.ts";
import type {
  RepositoryWorkSelectionConstructionV2,
  RepositoryWorkSelectionBindingV2,
  RepositoryWorkAssignmentV2,
  RepositoryWorkSelectionV2,
  RepositoryWorkSelectedExecutionDataV2,
  RepositoryWorkTransactionContextV2,
  RepositoryWorkStateParticipantV2,
} from "../../ports/repository-work-v2.ts";
import type { RepositoryWorkEnterV2, RepositoryWorkExecutionV2 } from "./repository-work-v2.ts";
import { createPostgresRepositoryWorkV2 } from "./repository-work-v2.ts";
import { canonicalRepositoryWorkV2 } from "./repository-work-canonical-v2.ts";
import { createPostgresRepositoryWorkPolicyV2 } from "./repository-work-policy-v2.ts";
import { createRuntimePreparationCreateReferenceReaderV1 } from "./runtime-preparation-create-correlation.ts";
import {
  parseRepositoryTokenMutationV2,
  repositoryInventoryDigestV2,
} from "../../credential-inventory-v1/repository-lease-v2.ts";
import type { RepositoryWorkHeldLeaseV2 } from "../../ports/repository-work-v2.ts";

/** Original State constructor only. The source must be the original native /
 * selected-execution admitting owner, paired once with this participant. This
 * owner cannot construct its A or recover one from the inspected data. */
export function createPostgresRepositoryWorkSelectionBindingV2<N, A, V extends 2 | 3>(
  enter: RepositoryWorkEnterV2,
  createPhase: () => RepositoryWorkExecutionV2["phase"],
  work: RepositoryWorkStateParticipantV2,
  options: RepositoryWorkSelectionConstructionV2<N, A, V>,
): RepositoryWorkSelectionBindingV2<N, A, V> {
  const version = options.protocolVersion,
    maximum = options.maximumAssignments;
  if (![2, 3].includes(version) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128)
    fail();
  const native = options.native,
    selected = options.selected;
  function capture<T extends object, K extends keyof T>(owner: T, key: K): T[K] {
    const method = owner?.[key];
    if (typeof method !== "function") fail();
    return method.bind(owner) as T[K];
  }
  const inspectNative = capture(native, "inspect"),
    assertNative = capture(native, "assertCurrent");
  const acquire = capture(selected, "acquire"),
    inspect = capture(selected, "inspect"),
    assertSelected = capture(selected, "assertCurrent"),
    releaseSelected = capture(selected, "release"),
    retainUse = capture(selected, "retainUse"),
    retainObservation = capture(selected, "retainObservation"),
    observationCall = capture(selected, "observationCall"),
    acquireInventory = capture(selected, "acquireInventory"),
    bindState = capture(selected, "bindState");
  const assertWork = capture(work, "assertOriginal"),
    acquirePolicy = capture(work, "acquireCurrentPolicy"),
    acquireReadset = capture(work, "acquireCurrentReadset");
  type Data = RepositoryWorkSelectedExecutionDataV2<V>;
  type Borrowed = { assertCurrent(): undefined; release(): Promise<void> };
  type Hold = {
    active: boolean;
    call: AuthorityCallV1;
    assertCurrent(): undefined;
    release(): Promise<void>;
  };
  type Entry = {
    session: N;
    admission: A;
    request: OpenRead<V>;
    data?: Data;
    fixed?: string;
    dataCanonical?: string;
    originalObjects?: readonly object[];
    handle: RepositoryWorkAssignmentV2<V>;
    call: AuthorityCallV1;
    nativeLifetime?: AbortSignal;
    stopNative?: () => void;
    hold?: Hold | undefined;
    workHold?: Borrowed | undefined;
    handoff: boolean;
    closed: boolean;
    failed: boolean;
    failure?: unknown;
    checking: boolean;
    tail: Promise<void>;
    release?: Promise<void>;
    admissionRelease?: Promise<void>;
    selections: number;
    inventoryStarted: boolean;
    inventories: Set<InventoryOwner>;
    pending: Set<Promise<unknown>>;
    sourcePending: Set<Promise<unknown>>;
    joinPending?: ((pending: Promise<unknown>) => undefined) | undefined;
  };
  const entries = new WeakMap<object, Entry>(),
    selections = new WeakMap<object, Entry>(),
    live = new Set<Entry>();
  const admissions = new Map<A, Entry>();
  const pendingAcquisitions = new Set<Promise<unknown>>();
  const operations = new AsyncLocalStorage<Entry>();
  type ContextMembership = {
    entry: Entry;
    call: AuthorityCallV1;
    active: boolean;
    checking: boolean;
    inventory?: InventoryPhase;
    issue?: boolean;
    heldCheck?: (() => undefined) | undefined;
  };
  const contexts = new WeakMap<object, ContextMembership>();
  let origins:
    RepositoryWorkOriginAssignmentRecognizerV2<RepositoryWorkAssignmentV2<V>, V> | undefined;
  let closed = false,
    acquiring = 0;
  function poison(entry: Entry, error: unknown): never {
    if (!entry.failed) {
      entry.failed = true;
      entry.failure = error;
    }
    throw entry.failure;
  }
  function original(entry: Entry, call: AuthorityCallV1) {
    if (
      closed ||
      entry.closed ||
      entry.failed ||
      call.signal.aborted ||
      entry.nativeLifetime?.aborted ||
      Date.parse(call.deadline) <= Date.now()
    )
      poison(entry, new ScopeViolationError("The original assignment is unavailable."));
    if (entry.data && canonicalRepositoryWorkV2(entry.data) !== entry.dataCanonical)
      poison(entry, new ScopeViolationError("Selected execution data changed."));
  }
  function synchronous(
    entry: Entry,
    value: unknown,
    joinPending: Entry["joinPending"] = entry.joinPending,
  ): undefined {
    if (value === undefined) return undefined;
    // Malformed asynchronous assertions do not become authority. Their accepted
    // completion is nevertheless joined before releasing original custody.
    const observed = Promise.resolve(value);
    entry.pending.add(observed);
    void observed.then(
      () => entry.pending.delete(observed),
      () => entry.pending.delete(observed),
    );
    joinPending?.(observed);
    return poison(entry, new ScopeViolationError("Assignment assertions must be synchronous."));
  }
  async function drain(entry: Entry) {
    while (entry.pending.size) await Promise.allSettled([...entry.pending]);
  }
  function sourceFence(entry: Entry, call: AuthorityCallV1): undefined {
    original(entry, call);
    if (entry.checking) poison(entry, new ScopeViolationError("Reentrant assignment fence."));
    entry.checking = true;
    try {
      synchronous(entry, assertNative(entry.session, call));
      synchronous(entry, assertSelected(entry.admission, entry.session, call));
      original(entry, call);
      if (entry.data && Date.parse(entry.data.selection.current.validUntil) <= Date.now()) fail();
      return undefined;
    } catch (error) {
      return poison(entry, error);
    } finally {
      entry.checking = false;
    }
  }
  function member(handle: object): Entry {
    const e = entries.get(handle);
    if (!e || e.closed) fail();
    return e;
  }
  function enqueue<T>(entry: Entry, body: () => Promise<T>): Promise<T> {
    if (operations.getStore() === entry || entry.checking || entry.closed) {
      const error = new ScopeViolationError("Nested or closed assignment operation.");
      entry.failed = true;
      entry.failure ??= error;
      const rejected = Promise.reject<T>(error);
      void rejected.catch(() => {});
      return rejected;
    }
    const task = entry.tail.then(() => operations.run(entry, body));
    entry.tail = task.then(
      () => {},
      (error) => {
        if (!entry.failed) {
          entry.failed = true;
          entry.failure = error;
        }
      },
    );
    return task;
  }
  function sourceOperation<T>(entry: Entry, body: () => Promise<T>): Promise<T> {
    if (entry.checking || operations.getStore() === entry || entry.admissionRelease) {
      const error = new ScopeViolationError("Nested or released source operation.");
      if (!entry.failed) {
        entry.failed = true;
        entry.failure = error;
      }
      const refused = Promise.reject<T>(entry.failure);
      void refused.catch(() => {});
      return refused;
    }
    const task = entry.tail.then(() => operations.run(entry, body));
    entry.tail = task.then(
      () => {},
      (error) => {
        if (!entry.failed) {
          entry.failed = true;
          entry.failure = error;
        }
      },
    );
    entry.sourcePending.add(task);
    void task.then(
      () => entry.sourcePending.delete(task),
      () => entry.sourcePending.delete(task),
    );
    return task;
  }

  type InventorySource = NonNullable<Awaited<ReturnType<typeof acquireInventory>>>;
  type OriginalOperation = WorkOriginalOperationV2;
  type InventoryInput = Parameters<InventorySource["selectOperation"]>[0];
  type InventoryOwner = {
    entry: Entry;
    raw: InventorySource;
    releaseRaw: () => Promise<void>;
    closing: boolean;
    pending: Set<Promise<unknown>>;
    borrowers: number;
    changed?: (() => void) | undefined;
    released?: Promise<void>;
    phases: Map<OriginalOperation, InventoryPhase>;
    refs: Set<string>;
  };
  type InventoryPhase = {
    owner: InventoryOwner;
    original: OriginalOperation;
    originalCanonical: string;
    input: InventoryInput;
    canonical: string;
    digest: string;
    issue: boolean;
  };
  const inventorySources = new WeakMap<object, InventoryOwner>();
  const finishedInventories = new WeakSet<object>();
  const inventoryOperations = new WeakMap<object, InventoryPhase>();
  function signalInventory(owner: InventoryOwner) {
    owner.changed?.();
    owner.changed = undefined;
  }
  function releaseInventory(owner: InventoryOwner, joinAdmission = true): Promise<void> {
    if (!owner.released) {
      owner.closing = true;
      owner.released = (async () => {
        while (owner.pending.size || owner.borrowers)
          await new Promise<void>((resolve) => {
            owner.changed = resolve;
          });
        try {
          await owner.releaseRaw();
        } finally {
          for (const operation of owner.phases.keys()) inventoryOperations.delete(operation);
          owner.phases.clear();
          inventorySources.delete(owner.raw);
          finishedInventories.add(owner.raw);
          owner.entry.inventories.delete(owner);
          if (joinAdmission) await releaseAdmission(owner.entry);
        }
      })();
    }
    return owner.released;
  }
  function inventoryOperation<T>(owner: InventoryOwner, body: () => Promise<T>): Promise<T> {
    const task = sourceOperation(owner.entry, async () => {
      if (owner.closing) fail();
      return body();
    });
    owner.pending.add(task);
    void task.then(
      () => {
        owner.pending.delete(task);
        signalInventory(owner);
      },
      () => {
        owner.pending.delete(task);
        signalInventory(owner);
      },
    );
    return task;
  }
  function enrollInventory(
    owner: InventoryOwner,
    originalOperation: OriginalOperation,
    input: InventoryInput,
  ): InventoryPhase {
    const fixed = parseRepositoryTokenMutationV2(input);
    const originalCanonical = canonicalRepositoryWorkV2(originalOperation);
    const data = JSON.parse(originalCanonical);
    const selectedData = owner.entry.data!.selection;
    const expected = selectedData.current.original;
    const fixedOriginals = [
      expected,
      selectedData.preparation,
      selectedData.observation,
      selectedData.admission.kind === "new"
        ? selectedData.admission.original
        : selectedData.admission.originalAdmission,
    ];
    if (
      owner.closing ||
      owner.phases.size >= 128 ||
      originalOperation === null ||
      typeof originalOperation !== "object" ||
      inventoryOperations.has(originalOperation) ||
      data === null ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(",") !== "invocationRef,operationRef,requestDigest,scope" ||
      owner.refs.has(data.operationRef) ||
      fixedOriginals.some((value) => value.operationRef === data.operationRef) ||
      data.operationRef !== fixed.operationRef ||
      data.invocationRef !== expected.invocationRef ||
      data.requestDigest !== expected.requestDigest ||
      !same(data.scope, expected.scope) ||
      !same(fixed.scope, {
        installationId: expected.scope.installationRef,
        namespaceId: expected.scope.namespaceRef,
        agentId: expected.scope.agentRef,
      })
    )
      fail();
    const phase: InventoryPhase = {
      owner,
      original: originalOperation,
      originalCanonical,
      input: fixed,
      canonical: canonicalRepositoryWorkV2(fixed),
      digest: repositoryInventoryDigestV2(fixed),
      issue: fixed.method === "reserveRepositoryToken" || fixed.method === "claimRepositoryMint",
    };
    owner.phases.set(originalOperation, phase);
    owner.refs.add(data.operationRef);
    inventoryOperations.set(originalOperation, phase);
    return phase;
  }
  function inventoryPhase(
    owner: InventoryOwner,
    originalOperation: OriginalOperation,
    input?: InventoryInput,
  ): InventoryPhase {
    const phase = inventoryOperations.get(originalOperation);
    if (
      owner.closing ||
      !phase ||
      phase.owner !== owner ||
      canonicalRepositoryWorkV2(originalOperation) !== phase.originalCanonical ||
      (input !== undefined &&
        (canonicalRepositoryWorkV2(parseRepositoryTokenMutationV2(input)) !== phase.canonical ||
          repositoryInventoryDigestV2(input) !== phase.digest))
    )
      fail();
    return phase;
  }
  async function retainInventory(
    owner: InventoryOwner,
    context: RepositoryWorkTransactionContextV2,
    originalOperation: OriginalOperation,
    input: InventoryInput,
    call: AuthorityCallV1,
    issue: boolean,
    method: InventorySource["retainIssue"],
  ): Promise<RepositoryWorkHeldLeaseV2> {
    assertWork(context, originalOperation, call);
    const phase = inventoryPhase(owner, originalOperation, input);
    if ((issue && !phase.issue) || contexts.has(context)) fail();
    if (issue) sourceFence(owner.entry, call);
    const joinPending = context.joinAccepted.bind(context);
    const membership: ContextMembership = {
      entry: owner.entry,
      call,
      active: true,
      checking: false,
      inventory: phase,
      issue,
      heldCheck: undefined,
    };
    contexts.set(context, membership);
    owner.borrowers++;
    let complete!: () => void;
    const acquired = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let releaseRaw: (() => Promise<void>) | undefined;
    let checkRaw: (() => undefined) | undefined;
    let prepareRaw: (() => Promise<void>) | undefined;
    let released: Promise<void> | undefined;
    const held: RepositoryWorkHeldLeaseV2 = Object.freeze({
      assertCurrent(): undefined {
        if (!membership.active || membership.checking || owner.entry.checking) fail();
        inventoryPhase(owner, originalOperation, input);
        if (call.signal.aborted || Date.parse(call.deadline) <= Date.now()) fail();
        if (issue) sourceFence(owner.entry, call);
        if (!checkRaw) fail();
        membership.checking = true;
        owner.entry.checking = true;
        try {
          synchronous(owner.entry, checkRaw(), joinPending);
          inventoryPhase(owner, originalOperation, input);
          return undefined;
        } finally {
          membership.checking = false;
          owner.entry.checking = false;
        }
      },
      async prepareCommit() {
        held.assertCurrent();
        if (!prepareRaw) fail();
        await prepareRaw();
        held.assertCurrent();
      },
      release() {
        if (!released) {
          membership.active = false;
          if (contexts.get(context) === membership) contexts.delete(context);
          released = (async () => {
            try {
              await acquired;
              await releaseRaw?.();
            } finally {
              owner.borrowers--;
              signalInventory(owner);
            }
          })();
        }
        return released;
      },
    });
    membership.heldCheck = held.assertCurrent;
    let transferred = false;
    try {
      // The entered original Work acquisition joins this supplier call. Transfer
      // its returned cleanup before observing any later lease getter.
      const raw = await method(context, originalOperation, input, call);
      releaseRaw = capture(raw, "release");
      context.retain(held);
      transferred = true;
      checkRaw = capture(raw, "assertCurrent");
      prepareRaw = capture(raw, "prepareCommit");
      held.assertCurrent();
      return held;
    } finally {
      complete();
      if (!transferred) await held.release();
    }
  }

  // This checks only the locally projected protocol arm. It neither accepts
  // external data nor creates the original Assignment membership.
  function assignmentArm<P extends 2 | 3>(
    projection: RepositoryWorkOriginAssignmentV2<2 | 3>,
    protocolVersion: P,
  ): projection is RepositoryWorkOriginAssignmentV2<2 | 3> & RepositoryWorkOriginAssignmentV2<P> {
    if (protocolVersion === 3)
      return (
        !("permission" in projection) &&
        "operation" in projection &&
        projection.operation === "git:read" &&
        projection.requiredPermissions.length === 2 &&
        projection.requiredPermissions[0] === "contents:read" &&
        projection.requiredPermissions[1] === "metadata:read"
      );
    return (
      protocolVersion === 2 &&
      !("operation" in projection) &&
      !("requiredPermissions" in projection) &&
      "permission" in projection &&
      projection.permission === "metadata:read"
    );
  }
  function association(entry: Entry): RepositoryWorkOriginAssignmentV2<V> {
    const c = entry.data!.selection.current;
    const projection: RepositoryWorkOriginAssignmentV2<2 | 3> = {
      original: c.original,
      work: c.work,
      execution: c.execution,
      service: c.service,
      attachmentRef: c.attachmentRef,
      repository: c.repository,
      purpose: "work.repository.use",
      operationUntil: c.originalHorizon,
      validUntil: c.validUntil,
      ...(version === 3
        ? {
            operation: "git:read",
            requiredPermissions: ["contents:read", "metadata:read"] as const,
          }
        : { permission: "metadata:read" }),
    };
    if (!assignmentArm(projection, version)) fail();
    return projection;
  }
  async function refreshSource(entry: Entry, call: AuthorityCallV1) {
    original(entry, call);
    const observed = await inspectNative(entry.session, call);
    original(entry, call);
    const data = await inspect(entry.admission, entry.session, call);
    const dataCanonical = canonicalRepositoryWorkV2(data),
      s = data.selection;
    const { validUntil: _validUntil, ...fixedCurrent } = s.current;
    const fixed = canonicalRepositoryWorkV2({
      ...data,
      selection: { ...s, current: fixedCurrent },
    });
    const objects = [
      s.current.original,
      s.preparation,
      s.observation,
      s.admission.kind === "new" ? s.admission.original : s.admission.originalAdmission,
    ];
    if (
      entry.fixed !== undefined &&
      (entry.fixed !== fixed || objects.some((v, i) => v !== entry.originalObjects![i]))
    )
      fail();
    if (
      observed.context !== call.context ||
      observed.sessionRef !== s.sessionRef ||
      observed.lifetime.aborted ||
      (entry.nativeLifetime && entry.nativeLifetime !== observed.lifetime)
    )
      fail();
    if (!entry.nativeLifetime) {
      entry.nativeLifetime = observed.lifetime;
      const abort = () => {
        void retire(entry).catch(() => {});
      };
      observed.lifetime.addEventListener("abort", abort, { once: true });
      entry.stopNative = () => observed.lifetime.removeEventListener("abort", abort);
    }
    entry.data = data;
    entry.fixed = fixed;
    entry.dataCanonical = dataCanonical;
    entry.originalObjects = objects;
    entry.call = call;
    const scope = s.current.original.scope;
    if (
      new Set(objects.slice(0, 3).map((o) => (o as { operationRef: string }).operationRef)).size !==
        3 ||
      !same(s.preparation.scope, scope) ||
      !same(s.observation.scope, scope) ||
      s.preparation.requestDigest !== s.current.original.requestDigest ||
      s.observation.requestDigest !== s.current.original.requestDigest ||
      s.preparation.invocationRef !== s.current.original.invocationRef ||
      s.observation.invocationRef !== s.current.original.invocationRef
    )
      fail();
    compareRepositoryWorkOriginAssignmentV2(association(entry), entry.request, observed.verified);
    sourceFence(entry, call);
  }
  function policyMatches(entry: Entry, policy: unknown): void {
    const s = entry.data!.selection,
      c = s.current;
    const result = evaluateRepositoryWorkProtocolPolicyV2(
      policy,
      {
        scope: c.original.scope,
        service: c.service,
        execution: c.execution,
        admitted: s.policyAdmission,
        repository: {
          target: s.repositoryTarget,
          owner: c.repository.owner,
          name: c.repository.name,
          profile: c.repository.profile,
        },
        operation: version === 3 ? "git:read" : "metadata:read",
        workBeganAt: s.workBeganAt,
        originalHorizon: c.originalHorizon,
        now: new Date().toISOString(),
      },
      version,
      repositoryWorkCurrentPolicyArmV2(c),
    );
    if (result.kind !== "matches") fail();
  }
  async function openReadset(entry: Entry, call: AuthorityCallV1): Promise<void> {
    if (entry.handoff) fail();
    await entry.hold?.release();
    entry.hold = undefined;
    await refreshSource(entry, call);
    const data = entry.data!,
      c = data.selection.current,
      s = c.original.scope;
    const scope = {
      installationId: s.installationRef,
      namespaceId: s.namespaceRef,
      agentId: s.agentRef,
      revisionRef: s.revisionRef,
    };
    const phase = createPhase(),
      releases: (() => Promise<void>)[] = [];
    let active = true,
      checking = false,
      prepared = false,
      stopped = false;
    let rawCheck: (() => undefined) | undefined, rawPrepare: (() => Promise<void>) | undefined;
    let stop!: () => void, resolve!: () => void, reject!: (error: unknown) => void;
    const stoppedPromise = new Promise<void>((r) => {
      stop = r;
    });
    const ready = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void ready.catch(() => {});
    const stopRead = () => {
      stopped = true;
      stop();
    };
    const fence = (): undefined => {
      if (!active || stopped || checking) fail();
      phase.assertActive();
      sourceFence(entry, call);
      checking = true;
      entry.checking = true;
      try {
        if (rawCheck) synchronous(entry, rawCheck());
        original(entry, call);
      } finally {
        checking = false;
        entry.checking = false;
      }
      return undefined;
    };
    const execution: RepositoryWorkExecutionV2 = {
      commitRef: randomUUID(),
      phase,
      disposition: "not-sent",
      establishedNoCommit: false,
      async prepareCommit() {
        await phase.drainAccepted();
        await phase.runFinalization(async () => {
          fence();
          await rawPrepare?.();
          fence();
        });
      },
      assertCommitReady() {
        fence();
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
    const completion = (async () => {
      try {
        await enter(
          scope,
          {
            signal: call.signal,
            timeoutMs: Math.min(3000, Date.parse(call.deadline) - Date.now()),
          },
          execution,
          (backend) =>
            phase.runTransition(async () => {
              await phase.runAcceptance(async () => {
                const context = Object.freeze<RepositoryWorkTransactionContextV2>({
                  installationId: scope.installationId,
                  assertActive() {
                    if (checking)
                      poison(
                        entry,
                        new ScopeViolationError("A retained fence cannot reenter acquisition."),
                      );
                    backend.context.transaction.assertActive();
                    fence();
                    return undefined;
                  },
                  joinAccepted(pending) {
                    if (
                      this !== context ||
                      !active ||
                      !types.isPromise(pending) ||
                      (!checking && operations.getStore() !== entry)
                    )
                      poison(
                        entry,
                        new ScopeViolationError("The original pending owner is unavailable."),
                      );
                    // An entered assertion may have just poisoned its phase.
                    // Join the original transaction before checking permission.
                    backend.joinAccepted(pending);
                    const observed = pending.then(
                      () => {},
                      (error) => {
                        phase.poison(error);
                        if (!entry.failed) {
                          entry.failed = true;
                          entry.failure = error;
                        }
                      },
                    );
                    entry.pending.add(observed);
                    void observed.then(() => entry.pending.delete(observed));
                    if (!checking) phase.assertOperationActive();
                    if (checking) {
                      const error = new ScopeViolationError(
                        "Asynchronous currentness is unavailable.",
                      );
                      phase.poison(error);
                      if (!entry.failed) {
                        entry.failed = true;
                        entry.failure = error;
                      }
                    }
                    return undefined;
                  },
                  retain(raw) {
                    // Already-entered acquisition cleanup transfers before currentness/getters.
                    if (!active || checking || !raw || typeof raw !== "object")
                      poison(
                        entry,
                        new ScopeViolationError("Invalid or nested source enrollment."),
                      );
                    const release = raw.release;
                    if (typeof release !== "function") fail();
                    releases.push(() => Promise.resolve(Reflect.apply(release, raw, [])));
                    const check = raw.assertCurrent,
                      prepare = raw.prepareCommit;
                    if (typeof check !== "function" || typeof prepare !== "function") fail();
                    const previousCheck = rawCheck,
                      previousPrepare = rawPrepare;
                    rawCheck = () => {
                      if (previousCheck) synchronous(entry, previousCheck());
                      return synchronous(entry, Reflect.apply(check, raw, []));
                    };
                    rawPrepare = async () => {
                      await previousPrepare?.();
                      await Reflect.apply(prepare, raw, []);
                    };
                    return undefined;
                  },
                });
                const membership = { entry, call, active: true, checking: false };
                // The source fence may be invoked outside query-operation ALS.
                // Its entered Promise still belongs to this original transaction.
                const joinPending = (pending: Promise<unknown>): undefined => {
                  backend.joinAccepted(pending);
                  return undefined;
                };
                entry.joinPending = joinPending;
                releases.push(async () => {
                  if (entry.joinPending === joinPending) entry.joinPending = undefined;
                });
                contexts.set(context, membership);
                releases.push(async () => {
                  membership.active = false;
                });
                const held = await retainUse(context, entry.admission, entry.session, call);
                context.retain(held);
                fence();
                // Original exact preparation read precedes Agent/Work locks. This
                // reader requires only the explicit three-field scope projection.
                const runtime = data.runtime;
                const located = await createRuntimePreparationCreateReferenceReaderV1(
                  backend.context,
                ).read(
                  {
                    installationId: scope.installationId,
                    namespaceId: scope.namespaceId,
                    agentId: scope.agentId,
                  },
                  { kind: "create-effect", createEffectRef: runtime.childEffectRef },
                );
                fence();
                if (
                  located.status !== "located" ||
                  located.retained.preparation.preparationRef !== runtime.preparationRef ||
                  located.retained.preparation.localVersion !== runtime.preparationVersion ||
                  !same(located.input.effect.target, runtime.target) ||
                  !backend.readRuntimeAllocation
                )
                  fail();
                const allocation = await backend.readRuntimeAllocation(c.execution.assignmentRef);
                fence();
                if (
                  !allocation ||
                  allocation.assignmentRef !== runtime.target.assignmentRef.id ||
                  allocation.installationId !== scope.installationId ||
                  allocation.namespaceId !== scope.namespaceId ||
                  allocation.agentId !== scope.agentId ||
                  allocation.revisionId !== scope.revisionRef ||
                  allocation.servicePrincipalId !== c.service.id ||
                  allocation.createEffectRef !== runtime.target.createEffectRef ||
                  !same(runtimeAllocationTarget(allocation), runtime.target)
                )
                  fail();
                for (const [statement, values, id] of [
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
                  const result = await backend.context.query.query(statement, values);
                  fence();
                  if (result.rowCount !== 1 || (result.rows[0] as { id?: unknown })?.id !== id)
                    fail();
                }
                const policy = await createPostgresRepositoryWorkPolicyV2(
                  backend.context,
                  scope,
                  execution.commitRef,
                ).find(data.selection.policyAdmission.policyRef);
                fence();
                if (!policy) fail();
                policyMatches(entry, policy.document);
                const repository = createPostgresRepositoryWorkV2(
                  backend.context,
                  scope,
                  execution.commitRef,
                );
                // First admission remains the original Work admitting operation.
                // This owner selects an actual already-retained admission only.
                if (data.selection.admission.kind !== "existing") fail();
                const admission = data.selection.admission.originalAdmission;
                const stored = await repository.findOperation(admission.operationRef);
                fence();
                if (
                  stored.kind !== "recorded" ||
                  stored.operation.kind !== "admission" ||
                  !same(stored.operation, admission)
                )
                  fail();
                const readset = await repository.readChain(c.work.workRef);
                fence();
                compareRepositoryWorkStateReadsetV2(readset, c);
                const own = readset.lineage.at(-1)!;
                if (!same((stored.operation.document as { record?: unknown }).record, own)) fail();
                await rawPrepare?.();
                fence();
                policyMatches(entry, policy.document);
                prepared = true;
                return true;
              });
              if (!prepared) fail();
              await phase.runOperation(async () => {
                fence();
                resolve();
                await stoppedPromise;
                // Readset retirement always rolls back this read-only transaction.
                // It never creates a known-commit business/release witness.
                throw new ScopeViolationError("The assignment readset was retired.");
              });
            }),
        );
      } catch (error) {
        reject(error);
        if (!stopped && !entry.failed) {
          entry.failed = true;
          entry.failure = error;
        }
      } finally {
        active = false;
        call.signal.removeEventListener("abort", stopRead);
        await drain(entry);
        for (const release of releases.reverse())
          try {
            await release();
          } catch (error) {
            if (!entry.failed) {
              entry.failed = true;
              entry.failure = error;
            }
          }
      }
    })();
    const hold: Hold = {
      active: true,
      call,
      assertCurrent: fence,
      async release() {
        hold.active = false;
        stopRead();
        await completion;
      },
    };
    entry.hold = hold;
    try {
      await ready;
      fence();
    } catch (error) {
      await hold.release();
      throw error;
    }
  }
  async function releaseAdmission(entry: Entry): Promise<void> {
    if (!entry.closed || entry.selections !== 0 || entry.workHold || entry.inventories.size) return;
    if (!entry.admissionRelease)
      entry.admissionRelease = (async () => {
        await drain(entry);
        while (entry.sourcePending.size) await Promise.allSettled([...entry.sourcePending]);
        try {
          await releaseSelected(entry.admission);
        } catch (error) {
          if (!entry.failed) {
            entry.failed = true;
            entry.failure = error;
          }
        } finally {
          live.delete(entry);
          admissions.delete(entry.admission);
        }
      })();
    await entry.admissionRelease;
  }
  async function retire(entry: Entry): Promise<void> {
    if (entry.release) return entry.release;
    entry.closed = true;
    entry.stopNative?.();
    entry.release = (async () => {
      await entry.hold?.release();
      await entry.tail;
      await releaseAdmission(entry);
    })();
    return entry.release;
  }
  function selectionEntry(
    handle: RepositoryWorkSelectionV2<V>,
    origin: OriginalRepositoryWorkOriginV2<V>,
    call: AuthorityCallV1,
  ): Entry {
    const entry = selections.get(handle);
    if (!entry || !origins || origins.recognize(origin, call) !== entry.handle) fail();
    original(entry, call);
    return entry;
  }
  const participant = Object.freeze({
    assertObservationOriginal(
      context: RepositoryWorkTransactionContextV2,
      admission: A,
      originalOperation: Data["selection"]["observation"],
      call: AuthorityCallV1,
    ): undefined {
      const entry = admissions.get(admission);
      if (
        !entry ||
        entry.admissionRelease ||
        (originalOperation !== entry.data?.selection.observation &&
          originalOperation !== entry.data?.selection.current.original &&
          !(
            contexts.get(context)?.entry === entry &&
            contexts.get(context)?.active &&
            contexts.get(context)?.issue === false &&
            contexts.get(context)?.inventory?.original === originalOperation
          ))
      )
        fail();
      assertWork(context, originalOperation, call);
      return undefined;
    },
    assertOriginal(
      context: RepositoryWorkTransactionContextV2,
      admission: A,
      session: N,
      call: AuthorityCallV1,
    ): undefined {
      const m = contexts.get(context);
      if (
        !m ||
        !m.active ||
        m.entry.admission !== admission ||
        m.entry.session !== session ||
        m.call.context !== call.context ||
        m.call.requestRef !== call.requestRef ||
        m.call.recipientRef !== call.recipientRef ||
        m.call.deadline !== call.deadline
      )
        fail();
      context.assertActive();
      return undefined;
    },
  });
  if (bindState(participant) !== undefined) fail();
  const result: RepositoryWorkSelectionBindingV2<N, A, V> = {
    assignments: {
      bindOrigins(value) {
        if (origins || closed) fail();
        const recognize = capture(value, "recognize");
        origins = Object.freeze({ recognize });
        return undefined;
      },
      acquire(request, session, call) {
        const task = (async () => {
          if (closed || !origins || live.size + acquiring >= maximum || request.version !== version)
            return undefined;
          acquiring++;
          let admission: A | undefined, entry: Entry | undefined;
          try {
            const capturedRequest = decodeGitHubMediationRequest(
              new TextEncoder().encode(canonicalRepositoryWorkV2(request)),
              version,
            );
            if (!capturedRequest || capturedRequest.method !== "open-read") fail();
            await inspectNative(session, call);
            if (closed || call.signal.aborted || Date.parse(call.deadline) <= Date.now()) fail();
            admission = await acquire(capturedRequest, session, call);
            if (admission === undefined) return undefined;
            if (admission === null || typeof admission !== "object" || admissions.has(admission))
              fail();
            // Cleanup ownership is established before inspecting any admitted data.
            entry = {
              admission,
              session,
              request: capturedRequest,
              call,
              handle: Object.freeze({}) as RepositoryWorkAssignmentV2<V>,
              handoff: false,
              closed: false,
              failed: false,
              checking: false,
              tail: Promise.resolve(),
              selections: 0,
              inventoryStarted: false,
              inventories: new Set(),
              pending: new Set(),
              sourcePending: new Set(),
            };
            entries.set(entry.handle, entry);
            admissions.set(admission, entry);
            live.add(entry);
            await enqueue(entry, () => openReadset(entry!, call));
            return entry.handle;
          } catch (error) {
            if (entry) await retire(entry);
            else if (admission !== undefined && !admissions.has(admission)) {
              try {
                await releaseSelected(admission);
              } catch {
                /* Preserve the first acquisition failure. */
              }
            }
            throw error;
          } finally {
            acquiring--;
          }
        })();
        pendingAcquisitions.add(task);
        void task.then(
          () => pendingAcquisitions.delete(task),
          () => pendingAcquisitions.delete(task),
        );
        return task;
      },
      async inspect(handle, call) {
        const e = member(handle);
        return enqueue(e, async () => {
          if (e.workHold) {
            e.workHold.assertCurrent();
            await refreshSource(e, call);
          } else if (e.handoff) fail();
          else if (!e.hold?.active || e.hold.call !== call || call.signal.aborted)
            await openReadset(e, call);
          else {
            await refreshSource(e, call);
            e.hold.assertCurrent();
          }
          return association(e);
        });
      },
      assertCurrent(handle) {
        const e = member(handle);
        sourceFence(e, e.call);
        if (e.workHold) e.workHold.assertCurrent();
        else if (e.hold?.active && !e.handoff) e.hold.assertCurrent();
        else fail();
      },
      release(handle) {
        const entry = entries.get(handle);
        if (!entry) fail();
        if (entry.checking || operations.getStore() === entry)
          poison(entry, new ScopeViolationError("Nested assignment release."));
        return retire(entry);
      },
    },
    selection: {
      async acquire(origin, request, call) {
        if (!origins) fail();
        const e = member(origins.recognize(origin, call));
        original(e, call);
        if (e.checking || operations.getStore() === e)
          poison(e, new ScopeViolationError("Nested selection acquisition."));
        if (!same(e.request, request)) fail();
        const handle = Object.freeze({}) as RepositoryWorkSelectionV2<V>;
        selections.set(handle, e);
        e.selections++;
        return handle;
      },
      async inspect(handle, origin, call) {
        const e = selectionEntry(handle, origin, call);
        return enqueue(e, async () => {
          await refreshSource(e, call);
          return e.data!.selection;
        });
      },
      async retainPolicy(context, handle, originalOperation, call) {
        const e = selections.get(handle);
        if (!e || !e.handoff || e.workHold) fail();
        return sourceOperation(e, async () => {
          assertWork(context, originalOperation, call);
          let issueCheck: (() => undefined) | undefined;
          if (!e.originalObjects?.includes(originalOperation)) {
            const phase = inventoryOperations.get(originalOperation);
            const membership = contexts.get(context);
            if (
              !phase ||
              phase.owner.entry !== e ||
              !phase.issue ||
              !membership?.active ||
              membership.entry !== e ||
              membership.inventory !== phase ||
              membership.issue !== true ||
              !membership.heldCheck
            )
              fail();
            inventoryPhase(phase.owner, originalOperation);
            issueCheck = membership.heldCheck;
            issueCheck();
          }
          const joinPending = context.joinAccepted.bind(context);
          e.joinPending = joinPending;
          try {
            sourceFence(e, call);
            const policy = await acquirePolicy(
              context,
              originalOperation,
              call,
              e.data!.selection.policyAdmission.policyRef,
            );
            // Original State already owns this returned policy cleanup.
            policyMatches(e, policy.policy);
            const c = e.data!.selection.current;
            const current = await acquireReadset(
              context,
              originalOperation,
              call,
              c.work,
              c.execution,
            );
            compareRepositoryWorkStateReadsetV2(current.readset, c);
            let active = true;
            const borrowed = {
              assertCurrent(): undefined {
                if (!active) fail();
                current.assertCurrent();
                policy.assertCurrent();
                issueCheck?.();
                sourceFence(e, call);
                policyMatches(e, policy.policy);
                return undefined;
              },
              async release() {
                active = false;
                if (e.workHold === borrowed) {
                  e.workHold = undefined;
                  e.handoff = false;
                }
                if (e.joinPending === joinPending) e.joinPending = undefined;
                await releaseAdmission(e);
              },
            };
            e.workHold = borrowed;
            e.call = call;
            const held = Object.freeze({
              policy: policy.policy,
              assertCurrent: borrowed.assertCurrent,
              async prepareCommit() {
                borrowed.assertCurrent();
              },
              release: borrowed.release,
            });
            context.retain(held);
            borrowed.assertCurrent();
            return held;
          } finally {
            if (!e.workHold && e.joinPending === joinPending) e.joinPending = undefined;
          }
        });
      },
      async retainObservation(context, handle, originalOperation, call) {
        const e = selections.get(handle);
        if (
          !e ||
          (originalOperation !== e.data?.selection.observation &&
            originalOperation !== e.data?.selection.current.original)
        )
          fail();
        return sourceOperation(e, async () => {
          assertWork(context, originalOperation, call);
          // The independent observer belongs to this Work transaction, including
          // its first assertion after Assignment retirement. Do not replace the
          // entry-wide join of another retained readset.
          const joinPending = context.joinAccepted.bind(context);
          const held = await retainObservation(context, e.admission, originalOperation, call);
          context.retain(held);
          synchronous(e, held.assertCurrent(), joinPending);
          return held;
        });
      },
      async observationCall(handle) {
        const e = selections.get(handle);
        if (!e) fail();
        return sourceOperation(e, () => observationCall(e.admission));
      },
      async acquireInventory(handle, origin, call) {
        const e = selectionEntry(handle, origin, call);
        sourceFence(e, call);
        return sourceOperation(e, async () => {
          if (e.inventoryStarted) fail();
          e.inventoryStarted = true;
          const raw = await acquireInventory(e.admission, e.session, call);
          if (raw === undefined) return undefined;
          if (
            !raw ||
            typeof raw !== "object" ||
            inventorySources.has(raw) ||
            finishedInventories.has(raw)
          )
            fail();
          // Capture the original cleanup before any reservation or method getter.
          const releaseRaw = capture(raw, "release");
          const owner: InventoryOwner = {
            entry: e,
            raw,
            releaseRaw,
            closing: false,
            pending: new Set(),
            borrowers: 0,
            phases: new Map(),
            refs: new Set(),
          };
          inventorySources.set(raw, owner);
          e.inventories.add(owner);
          try {
            const offered = raw.reservation;
            canonicalRepositoryWorkV2(offered);
            const input = parseRepositoryTokenMutationV2(offered.input);
            if (input.method !== "reserveRepositoryToken") fail();
            const reservation = Object.freeze({ original: offered.original, input });
            enrollInventory(owner, reservation.original, input);
            const select = capture(raw, "selectOperation");
            const retainIssue = capture(raw, "retainIssue");
            const retainHistorical = capture(raw, "retainObservation");
            const observe = capture(raw, "observationCall");
            sourceFence(e, call);
            const result: InventorySource = {
              reservation,
              selectOperation(input, call) {
                return inventoryOperation(owner, async () => {
                  const fixed = parseRepositoryTokenMutationV2(input);
                  if (fixed.method === "reserveRepositoryToken") fail();
                  const canonical = canonicalRepositoryWorkV2(fixed);
                  const issue = fixed.method === "claimRepositoryMint";
                  if (issue) sourceFence(e, call);
                  const originalOperation = await select(input, call);
                  if (
                    canonicalRepositoryWorkV2(parseRepositoryTokenMutationV2(input)) !== canonical
                  )
                    fail();
                  if (issue) sourceFence(e, call);
                  enrollInventory(owner, originalOperation, fixed);
                  return originalOperation;
                });
              },
              retainIssue(context, originalOperation, input, call) {
                return inventoryOperation(owner, () =>
                  retainInventory(
                    owner,
                    context,
                    originalOperation,
                    input,
                    call,
                    true,
                    retainIssue,
                  ),
                );
              },
              retainObservation(context, originalOperation, input, call) {
                return inventoryOperation(owner, () =>
                  retainInventory(
                    owner,
                    context,
                    originalOperation,
                    input,
                    call,
                    false,
                    retainHistorical,
                  ),
                );
              },
              observationCall() {
                return inventoryOperation(owner, observe);
              },
              release() {
                if (e.checking || operations.getStore() === e) {
                  const rejected = Promise.reject<void>(
                    new ScopeViolationError("Nested inventory retirement."),
                  );
                  void rejected.catch(() => {});
                  return rejected;
                }
                return releaseInventory(owner);
              },
            };
            return Object.freeze(result);
          } catch (error) {
            try {
              await releaseInventory(owner, false);
            } catch {
              /* Preserve the first acquisition/inspection failure. */
            }
            throw error;
          }
        });
      },
      async release(handle) {
        const e = selections.get(handle);
        if (!e) fail();
        if (e.checking || operations.getStore() === e)
          poison(e, new ScopeViolationError("Nested selection release."));
        selections.delete(handle);
        e.selections--;
        await releaseAdmission(e);
      },
      async prepareStateUse(handle, origin, call) {
        const e = selectionEntry(handle, origin, call);
        await enqueue(e, async () => {
          sourceFence(e, call);
          if (e.workHold || e.handoff) fail();
          e.handoff = true;
          await e.hold?.release();
          e.hold = undefined;
        });
      },
    },
    async close() {
      const operation = operations.getStore();
      if (operation)
        poison(operation, new ScopeViolationError("Nested assignment constructor shutdown."));
      closed = true;
      // Accepted acquisition may return original custody after shutdown begins.
      // Join its cleanup transfer before completing constructor shutdown.
      while (pendingAcquisitions.size) await Promise.allSettled([...pendingAcquisitions]);
      await Promise.allSettled(
        [...live].map(async (entry) => {
          await retire(entry);
          await Promise.allSettled([...entry.inventories].map((owner) => releaseInventory(owner)));
          await releaseAdmission(entry);
        }),
      );
    },
  };
  return Object.freeze(result);
}
