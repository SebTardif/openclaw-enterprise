import { randomUUID, createHash } from "node:crypto";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import {
  parseCompletedContextV1,
  type ContextKeyV1,
  type ExactAttemptV1,
  type CheckpointRefV1,
} from "@openclaw-enterprise/contracts/completed-context-v1";
import {
  TURN_JOURNAL_LIMITS_V1,
  classifyJournalAdmissionV1,
  digestJournalAdmissionIdentityV1,
  journalCancellationBeforeDispatchMatchesV1,
  journalCompletionMatchesV1,
  journalDispatchIntentMatchesV1,
  journalOutcomeTransitionAllowedV1,
  journalReleaseMatchesV1,
  parseTurnJournalV1,
  parseTurnJournalResultV1,
  parseRejectedAdmissionV1,
  parseNonTurnIntakeV1,
  parseNonTurnReceiptV1,
  parseExactIncomingLinkV1,
  type TurnJournalUnitOfWorkV1,
  type JournalAdmissionProvenanceV1,
  type NonTurnProvenanceV1,
  type JournalEvidenceProvenanceV1,
  type JournalDeniedV1,
  type JournalUnavailableV1,
  type JournalAdmissionOwnerV1,
  type IncomingAdmissionLinkV1,
  type AdmissionRecordV1,
  type RejectedAdmissionRecordV1,
  type NonTurnReceiptV1,
  type ExactNonTurnIntakeV1,
  type JournalAdmissionIdentityV1,
  type AttemptRecordV1,
  type ExpectedCompletionHeadV1,
  type ExactCheckpointAllocationV1,
  type ExactCompletionOperationV1,
  type CompletionRecordV1,
  type ExactDeliveryOperationV1,
  type ExactDeliveryOutcomeV1,
  type ExactCancellationOperationV1,
  type DeliveryStateV1,
  type ExactOutcomeOperationV1,
  type JournalReleaseObservationV1,
} from "@openclaw-enterprise/contracts/turn-journal-v1";
import type { RepositoryFactoryContext } from "../../ports/repository-factory.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../errors.ts";
import { TurnJournalTransactionGuard } from "../../turn-journal/transaction-guard.ts";
import { canonicalJournalValue, sameJournalValue } from "../../turn-journal/rows.ts";

/** Borrowed from the actual memory owner's working snapshot. No journal storage,
 * mutable maps or claim issuer is exposed to the provenance provider. */
export interface MemoryTurnJournalProvenanceContext extends RepositoryFactoryContext {
  currentInstallation(): Promise<Readonly<Installation> | undefined>;
}
export interface MemoryTurnJournalProvenance {
  readonly admission: Pick<JournalAdmissionProvenanceV1<never>, "inspect" | "inspectRejected">;
  readonly nonTurn: Pick<NonTurnProvenanceV1<never>, "inspectNonTurn">;
  readonly evidence: Pick<
    JournalEvidenceProvenanceV1,
    | "inspectDispatch"
    | "inspectConsumption"
    | "inspectCompletion"
    | "inspectRelease"
    | "inspectOutcome"
    | "inspectDelivery"
    | "inspectCancellation"
  >;
  readonly authorization: {
    authorize(
      input: Readonly<{ operation: keyof TurnJournalUnitOfWorkV1; value: unknown }>,
      call: AuthorityCallV1,
    ): Promise<Readonly<{ kind: "authorized" }> | JournalDeniedV1 | JournalUnavailableV1>;
  };
}
export interface MemoryTurnJournalOptions {
  /** Server-owned wall clock. This never supplies provenance or extends a proof. */
  readonly clock?: Readonly<{ now(): number }>;
  readonly canonicalRouteKey: (
    envelope: RejectedAdmissionRecordV1["envelope"],
  ) => JournalAdmissionIdentityV1["routeKey"];
  bind(context: MemoryTurnJournalProvenanceContext): MemoryTurnJournalProvenance;
  readonly capacity: Readonly<{
    maxOwnersPerInstallation: number;
    maxIncomingLinksPerInstallation: number;
    maxAttemptsPerInstallation: number;
  }>;
}

/** Configuration is owned before callers can mutate it between transactions. */
export function retainMemoryTurnJournalOptions(
  options: MemoryTurnJournalOptions,
): MemoryTurnJournalOptions {
  if (
    !options ||
    typeof options.bind !== "function" ||
    typeof options.canonicalRouteKey !== "function"
  )
    throw new TypeError("All memory journal configuration is required.");
  const capacity = options.capacity && Object.freeze({ ...options.capacity });
  if (!capacity || Reflect.ownKeys(capacity).length !== 3)
    throw new TypeError("All journal capacities are required.");
  for (const key of [
    "maxOwnersPerInstallation",
    "maxIncomingLinksPerInstallation",
    "maxAttemptsPerInstallation",
  ] as const) {
    const n = capacity[key];
    if (!Number.isSafeInteger(n) || n < 1 || n > 100_000)
      throw new TypeError("Journal capacity must be between one and 100000 records.");
  }
  if (options.clock !== undefined && typeof options.clock.now !== "function")
    throw new TypeError("The memory journal clock is unavailable.");
  const clock =
    options.clock === undefined
      ? undefined
      : Object.freeze({ now: options.clock.now.bind(options.clock) });
  return Object.freeze({
    bind: options.bind,
    canonicalRouteKey: options.canonicalRouteKey,
    capacity: Object.freeze({ ...capacity }),
    ...(clock === undefined ? {} : { clock }),
  });
}

interface StoredAttempt {
  readonly record: AttemptRecordV1;
  readonly firstReceivedAt: string;
}
interface StoredHead {
  readonly head: ExpectedCompletionHeadV1;
  readonly checkpoint: CheckpointRefV1 | null;
}
type StoredOperation =
  | Readonly<{
      operationKind: "checkpoint-allocation";
      request: ExactCheckpointAllocationV1;
      record: ExactCheckpointAllocationV1;
    }>
  | Readonly<{
      operationKind: "completion";
      request: ExactCompletionOperationV1;
      record: CompletionRecordV1;
    }>
  | Readonly<{
      operationKind: "outcome";
      request: ExactOutcomeOperationV1;
      record: AttemptRecordV1;
    }>
  | Readonly<{
      operationKind: "cancellation";
      request: ExactCancellationOperationV1;
      record: Readonly<{
        operation: ExactCancellationOperationV1;
        outcome: "requested" | "cancelled-before-dispatch";
      }>;
    }>
  | Readonly<{
      operationKind: "release";
      request: JournalReleaseObservationV1;
      record: JournalReleaseObservationV1;
    }>;
interface StoredDelivery {
  readonly operation: ExactDeliveryOperationV1;
  readonly outcome: ExactDeliveryOutcomeV1 | null;
  readonly deliveryAttemptRef: string | null;
  readonly attemptNumber: number;
  readonly episodeStartedAt: string | null;
  readonly updateUsed: boolean;
}
interface JournalRecords {
  readonly owners: Map<string, JournalAdmissionOwnerV1>;
  readonly ownerKeys: Map<string, string>;
  readonly incomingLinks: Map<string, IncomingAdmissionLinkV1>;
  readonly nonTurnLinks: Map<string, NonTurnReceiptV1>;
  readonly anchors: Map<
    string,
    Readonly<{ link: IncomingAdmissionLinkV1 | NonTurnReceiptV1; ownerKey: string }>
  >;
  readonly attempts: Map<string, StoredAttempt>;
  readonly heads: Map<string, StoredHead>;
  readonly reservations: Map<string, ExactAttemptV1>;
  readonly operations: Map<string, StoredOperation>;
  readonly deliveries: Map<string, StoredDelivery>;
  readonly deliveryHistory: Map<string, StoredDelivery>;
}
declare const snapshotIdentity: unique symbol;
/** Opaque owner state; consumers cannot preload journal maps or decisions. */
export interface MemoryTurnJournalSnapshot {
  readonly [snapshotIdentity]: true;
}
const snapshots = new WeakMap<MemoryTurnJournalSnapshot, JournalRecords>();
const recordsOf = (snapshot: MemoryTurnJournalSnapshot): JournalRecords => {
  const records = snapshots.get(snapshot);
  if (!records) throw new ScopeViolationError("The memory journal owner is unavailable.");
  return records;
};
function retainSnapshot(records: JournalRecords): MemoryTurnJournalSnapshot {
  const snapshot = Object.freeze({}) as MemoryTurnJournalSnapshot;
  snapshots.set(snapshot, records);
  return snapshot;
}
export function createMemoryTurnJournalSnapshot(): MemoryTurnJournalSnapshot {
  return retainSnapshot({
    owners: new Map(),
    ownerKeys: new Map(),
    incomingLinks: new Map(),
    nonTurnLinks: new Map(),
    anchors: new Map(),
    attempts: new Map(),
    heads: new Map(),
    reservations: new Map(),
    operations: new Map(),
    deliveries: new Map(),
    deliveryHistory: new Map(),
  });
}
export function cloneMemoryTurnJournalSnapshot(
  snapshot: MemoryTurnJournalSnapshot,
): MemoryTurnJournalSnapshot {
  const r = recordsOf(snapshot);
  // Records are deeply owned/frozen; only indexes are mutable within one owner.
  return retainSnapshot({
    owners: new Map(r.owners),
    ownerKeys: new Map(r.ownerKeys),
    incomingLinks: new Map(r.incomingLinks),
    nonTurnLinks: new Map(r.nonTurnLinks),
    anchors: new Map(r.anchors),
    attempts: new Map(r.attempts),
    heads: new Map(r.heads),
    reservations: new Map(r.reservations),
    operations: new Map(r.operations),
    deliveries: new Map(r.deliveries),
    deliveryHistory: new Map(r.deliveryHistory),
  });
}

/** Only InMemoryPlatformState binds, drains and confirms this participant.
 * It records call liveness without claiming to issue original authority. */
export class MemoryTurnJournalParticipant {
  readonly guard = new TurnJournalTransactionGuard();
  private lastMutation: Promise<unknown> = Promise.resolve();

  /** A read captures the already admitted mutation tail. Its rejection remains
   * a rejection; reading cannot turn a poisoned provisional snapshot into data. */
  beforeRead(): Promise<void> {
    return this.lastMutation.then(() => {});
  }

  retainMutation<T>(result: Promise<T>): Promise<T> {
    this.lastMutation = result;
    // The transaction guard also observes every operation. Retaining this tail
    // never creates a new unhandled rejection if its caller intentionally drains.
    void result.catch(() => {});
    return result;
  }
  private readonly clock: () => number;
  private last = Number.NEGATIVE_INFINITY;
  constructor(clock?: Readonly<{ now(): number }>) {
    this.clock = clock === undefined ? Date.now : clock.now.bind(clock);
  }
  now(): number {
    const value = this.clock();
    if (!Number.isFinite(value) || value < this.last)
      throw new DependencyUnavailableError("The memory journal clock is unavailable.");
    this.last = value;
    return value;
  }
  private readonly retained = new WeakMap<AuthorityCallV1, AuthorityCallV1>();
  private readonly calls = new Set<AuthorityCallV1>();
  call(call: AuthorityCallV1): AuthorityCallV1 {
    const existing = this.retained.get(call);
    if (existing) return existing;
    if (
      !call ||
      !(call.signal instanceof AbortSignal) ||
      typeof call.requestRef !== "string" ||
      typeof call.recipientRef !== "string" ||
      typeof call.deadline !== "string"
    )
      throw new TypeError("A bounded journal authority call is required.");
    const exact = Object.freeze({
      requestRef: call.requestRef,
      recipientRef: call.recipientRef,
      deadline: call.deadline,
      signal: call.signal,
      context: call.context,
    });
    this.retained.set(call, exact);
    this.retained.set(exact, exact);
    this.calls.add(exact);
    return exact;
  }
  assertCurrent(): void {
    for (const call of this.calls)
      if (
        call.signal.aborted ||
        !Number.isFinite(Date.parse(call.deadline)) ||
        this.now() >= Date.parse(call.deadline)
      )
        throw new DependencyUnavailableError("The journal call has expired.");
  }
}
interface MemoryTurnJournalContext extends MemoryTurnJournalProvenanceContext {
  readonly snapshot: MemoryTurnJournalSnapshot;
  readonly participant: MemoryTurnJournalParticipant;
  agentExists(key: ContextKeyV1): Promise<boolean>;
  channelExists(installation: string, channel: string): Promise<boolean>;
}

const denied = { kind: "denied" } as const;
const unavailable = { kind: "unavailable" } as const;
const conflict = { kind: "conflict" } as const;
const absent = { kind: "absent" } as const;
const failure = (value: object): value is JournalDeniedV1 | JournalUnavailableV1 =>
  "kind" in value && (value.kind === "denied" || value.kind === "unavailable");
const ownerReceipt = (owner: JournalAdmissionOwnerV1) =>
  "intake" in owner
    ? {
        receiptRef: owner.receiptRef,
        eventKey: owner.intake.eventKey,
        logicalMessageKey:
          owner.intake.logicalMessage.kind === "equivalent-original"
            ? owner.intake.logicalMessage.logicalMessageKey
            : null,
        eventDigest: owner.intake.eventDigest,
      }
    : "identity" in owner
      ? owner.identity.receipt
      : owner.receipt;
const contextValues = (key: ContextKeyV1) => [
  key.installationRef,
  key.namespaceRef,
  key.agentRef,
  key.conversationRef,
];
const attemptValues = (attempt: ExactAttemptV1) => [
  ...contextValues(attempt),
  attempt.turnRef,
  attempt.attemptRef,
  attempt.reservationRef,
];
const keyOf = (...parts: readonly unknown[]) => JSON.stringify(parts);
const contextKey = (key: ContextKeyV1) => keyOf(...contextValues(key));
const attemptKey = (attempt: ExactAttemptV1) => keyOf(...attemptValues(attempt));
const agentKey = (key: ContextKeyV1) => keyOf(...contextValues(key).slice(0, 3));
const ownerKey = (installation: string, channel: string, receipt: string) =>
  keyOf(installation, channel, receipt);
const deliveryKey = (operation: ExactDeliveryOperationV1) =>
  keyOf(attemptKey(operation.attempt), operation.slot);
const historyKey = (operation: ExactDeliveryOperationV1, ref: string) =>
  keyOf(operation.attempt.installationRef, operation.operationRef, ref);
const digestValue = (value: unknown) =>
  createHash("sha256").update(canonicalJournalValue(value)).digest("hex");

/** A real process-local journal, borrowing only the owner's snapshot and lifetime.
 * No connection, transaction control or caller-owned storage is accepted. */
export function createMemoryTurnJournal(
  context: MemoryTurnJournalContext,
  suppliedOptions: MemoryTurnJournalOptions,
): TurnJournalUnitOfWorkV1 {
  const options = retainMemoryTurnJournalOptions(suppliedOptions);
  const capacity = options.capacity;
  const data = recordsOf(context.snapshot);
  const participant = context.participant;
  const nowMilliseconds = () => participant.now();
  const supplied = options.bind(
    Object.freeze({
      get scope() {
        return context.scope;
      },
      transaction: context.transaction,
      currentInstallation: () => context.currentInstallation(),
    }),
  );
  if (
    !supplied?.admission?.inspect ||
    !supplied.admission.inspectRejected ||
    !supplied.nonTurn?.inspectNonTurn ||
    !supplied.authorization?.authorize ||
    !supplied.evidence?.inspectDispatch ||
    !supplied.evidence.inspectConsumption ||
    !supplied.evidence.inspectCompletion ||
    !supplied.evidence.inspectRelease ||
    !supplied.evidence.inspectOutcome ||
    !supplied.evidence.inspectDelivery ||
    !supplied.evidence.inspectCancellation
  )
    throw new TypeError("All journal provenance owners are required.");
  const ports: MemoryTurnJournalProvenance = Object.freeze({
    admission: Object.freeze({
      inspect: supplied.admission.inspect.bind(supplied.admission),
      inspectRejected: supplied.admission.inspectRejected.bind(supplied.admission),
    }),
    nonTurn: Object.freeze({
      inspectNonTurn: supplied.nonTurn.inspectNonTurn.bind(supplied.nonTurn),
    }),
    evidence: Object.freeze({
      inspectDispatch: supplied.evidence.inspectDispatch.bind(supplied.evidence),
      inspectConsumption: supplied.evidence.inspectConsumption.bind(supplied.evidence),
      inspectCompletion: supplied.evidence.inspectCompletion.bind(supplied.evidence),
      inspectRelease: supplied.evidence.inspectRelease.bind(supplied.evidence),
      inspectOutcome: supplied.evidence.inspectOutcome.bind(supplied.evidence),
      inspectDelivery: supplied.evidence.inspectDelivery.bind(supplied.evidence),
      inspectCancellation: supplied.evidence.inspectCancellation.bind(supplied.evidence),
    }),
    authorization: Object.freeze({
      authorize: supplied.authorization.authorize.bind(supplied.authorization),
    }),
  });
  const checkedCall = (call: AuthorityCallV1) => participant.call(call);
  const owned = async <T>(value: Promise<T>): Promise<T> => immutableCopy(await value);
  const active = (call: AuthorityCallV1) => {
    call = checkedCall(call);
    context.transaction.assertActive();
    if (
      call.signal.aborted ||
      !Number.isFinite(Date.parse(call.deadline)) ||
      nowMilliseconds() >= Date.parse(call.deadline)
    )
      throw new DependencyUnavailableError("The journal call has expired.");
  };
  const authorize = async (
    operation: keyof TurnJournalUnitOfWorkV1,
    value: unknown,
    call: AuthorityCallV1,
  ) => {
    active(call);
    const result = await owned(
      ports.authorization.authorize({ operation, value }, checkedCall(call)),
    );
    active(call);
    if (result.kind !== "authorized") return result;
    const installation = await context.currentInstallation();
    active(call);
    if (!installation || installation.id !== context.scope.installationId) return unavailable;
    const candidate = value as {
      installationRef?: unknown;
      attempt?: { installationRef?: unknown };
      locator?: { installationRef?: unknown };
    };
    const supplied =
      candidate?.installationRef ??
      candidate?.attempt?.installationRef ??
      candidate?.locator?.installationRef;
    if (supplied !== undefined && supplied !== installation.id) return denied;
    return { kind: "authorized", installation } as const;
  };
  const read = async <T>(
    method: keyof TurnJournalUnitOfWorkV1,
    input: unknown,
    call: AuthorityCallV1,
    work: (installation: Readonly<Installation>) => Promise<T>,
  ): Promise<T | JournalDeniedV1 | JournalUnavailableV1> => {
    const priorMutations = participant.beforeRead();
    await priorMutations;
    active(call);
    const authorized = await authorize(method, input, call);
    if (authorized.kind !== "authorized") return authorized;
    const value = await work(authorized.installation);
    active(call);
    return value;
  };
  const mutate = <T>(call: AuthorityCallV1, work: () => Promise<T>) =>
    participant.retainMutation(
      participant.guard.mutate(async () => {
        active(call);
        const result = await work();
        active(call);
        return result;
      }),
    );
  // The state owner serializes complete transactions; these checks do not claim
  // a separate lock or admit another owner while provenance is being inspected.
  const admissionLock = async (_installation: string) => context.transaction.assertActive();
  const agentLock = async (key: ContextKeyV1) => {
    context.transaction.assertActive();
    const exists = await context.agentExists(key);
    context.transaction.assertActive();
    return exists;
  };
  const findOwner = async (
    installation: string,
    channel: string,
    kind: "event" | "logical-message",
    key: string,
  ) => {
    context.transaction.assertActive();
    const found = data.ownerKeys.get(keyOf(installation, channel, kind, key));
    return found === undefined ? null : (data.owners.get(found) ?? null);
  };
  const eventAnchor = async (installation: string, channel: string, eventKey: string) => {
    context.transaction.assertActive();
    const anchor = data.anchors.get(keyOf(installation, channel, eventKey));
    if (!anchor) return null;
    const owner = data.owners.get(anchor.ownerKey);
    if (!owner) throw new DependencyUnavailableError("The retained event owner is unavailable.");
    return { link: anchor.link, owner };
  };
  const getAttempt = async (attempt: ExactAttemptV1) => {
    context.transaction.assertActive();
    return data.attempts.get(attemptKey(attempt)) ?? null;
  };
  const reservationHeld = async (attempt: ExactAttemptV1) => {
    context.transaction.assertActive();
    return sameJournalValue(data.reservations.get(agentKey(attempt)) ?? null, attempt);
  };
  const contextUsed = async (key: ContextKeyV1) => {
    context.transaction.assertActive();
    return [...data.attempts.values()].some(
      ({ record }) =>
        contextKey(record.binding.attempt) === contextKey(key) && !("phase" in record),
    );
  };
  const getHead = async (key: ContextKeyV1) => {
    context.transaction.assertActive();
    return data.heads.get(contextKey(key)) ?? null;
  };
  const getOperation = async (attempt: ExactAttemptV1, kind: string, ref: string) => {
    context.transaction.assertActive();
    return data.operations.get(keyOf(attempt.installationRef, kind, ref)) ?? null;
  };
  const operationsFor = (attempt: ExactAttemptV1, kind: StoredOperation["operationKind"]) =>
    [...data.operations.values()].filter(
      (op) => op.operationKind === kind && sameJournalValue(op.request.attempt, attempt),
    );
  const putOperation = async (
    attempt: ExactAttemptV1,
    kind: string,
    ref: string,
    request: unknown,
    result: unknown,
  ) => {
    context.transaction.assertActive();
    const finalOutcome =
      kind === "outcome" &&
      ["failed", "interrupted", "cancelled"].includes(
        (request as ExactOutcomeOperationV1).outcome.kind,
      );
    if (kind === "outcome" && !finalOutcome && operationsFor(attempt, "outcome").length >= 32)
      throw new DependencyUnavailableError("The journal operation capacity is exhausted.");
    let operation: StoredOperation;
    if (kind === "checkpoint-allocation") {
      const exact = parseTurnJournalV1("checkpointAllocation", request);
      const record = parseTurnJournalV1("checkpointAllocation", result);
      if (!sameJournalValue(exact, record))
        throw new ScopeViolationError("The checkpoint operation differs.");
      operation = { operationKind: kind, request: exact, record };
    } else if (kind === "completion") {
      const exact = parseTurnJournalV1("completionOperation", request);
      const record = parseTurnJournalV1("completion", result);
      if (!sameJournalValue(exact, record.operation))
        throw new ScopeViolationError("The completion operation differs.");
      operation = { operationKind: kind, request: exact, record };
    } else if (kind === "outcome") {
      const exact = parseTurnJournalV1("outcomeOperation", request);
      const record = parseTurnJournalV1("attempt", result);
      if (
        !sameJournalValue(exact.attempt, record.binding.attempt) ||
        !sameJournalValue(exact.outcome, record.outcome) ||
        record.version !== exact.expectedAttemptVersion + 1
      )
        throw new ScopeViolationError("The outcome operation differs.");
      operation = { operationKind: kind, request: exact, record };
    } else if (kind === "cancellation") {
      const exact = parseTurnJournalV1("cancellation", request);
      const state = parseTurnJournalResultV1("cancellationState", {
        kind: "found",
        ...(result as object),
      });
      if (state.kind !== "found" || !sameJournalValue(exact, state.operation))
        throw new ScopeViolationError("The cancellation operation differs.");
      operation = {
        operationKind: kind,
        request: exact,
        record: { operation: state.operation, outcome: state.outcome },
      };
    } else if (kind === "release") {
      const exact = parseTurnJournalV1("releaseObservation", request);
      const record = parseTurnJournalV1("releaseObservation", result);
      if (!sameJournalValue(exact, record))
        throw new ScopeViolationError("The release operation differs.");
      operation = { operationKind: kind, request: exact, record };
    } else throw new ScopeViolationError("The journal operation kind is unsupported.");
    if (
      !sameJournalValue(operation.request.attempt, attempt) ||
      ("releaseOperationRef" in operation.request
        ? operation.request.releaseOperationRef
        : operation.request.operationRef) !== ref
    )
      throw new ScopeViolationError("The journal operation owner differs.");
    const key = keyOf(attempt.installationRef, kind, ref);
    if (data.operations.has(key))
      throw new ScopeViolationError("The journal operation is already retained.");
    if (kind !== "outcome" && operationsFor(attempt, operation.operationKind).length !== 0)
      throw new ScopeViolationError("The attempt already has this operation.");
    if (operation.operationKind === "checkpoint-allocation") {
      const checkpointId = operation.request.checkpointId;
      if (
        [...data.operations.values()].some(
          (prior) =>
            prior.operationKind === "checkpoint-allocation" &&
            prior.request.attempt.installationRef === attempt.installationRef &&
            prior.request.checkpointId === checkpointId,
        )
      )
        throw new ScopeViolationError("The checkpoint identity is already allocated.");
    }
    if (operation.operationKind === "completion") {
      const sequence = operation.record.head.completionSequence;
      if (
        [...data.operations.values()].some(
          (prior) =>
            prior.operationKind === "completion" &&
            contextKey(prior.request.attempt) === contextKey(attempt) &&
            prior.record.head.completionSequence === sequence,
        )
      )
        throw new ScopeViolationError("The completion sequence is already published.");
    }
    if (!data.attempts.has(attemptKey(attempt)))
      throw new ScopeViolationError("The journal operation attempt is unavailable.");
    data.operations.set(key, immutableCopy(operation));
  };
  const updateAttempt = async (attempt: ExactAttemptV1, record: AttemptRecordV1) => {
    context.transaction.assertActive();
    const exact = parseTurnJournalV1("attempt", record);
    const old = data.attempts.get(attemptKey(attempt));
    if (
      !old ||
      !sameJournalValue(exact.binding.attempt, attempt) ||
      exact.version !== old.record.version + 1
    )
      throw new DependencyUnavailableError("The journal attempt changed during its update.");
    data.attempts.set(
      attemptKey(attempt),
      Object.freeze({ record: exact, firstReceivedAt: old.firstReceivedAt }),
    );
  };
  const capacityAvailable = async (
    installation: string,
    newOwner: boolean,
    newAttempt: boolean,
  ) => {
    context.transaction.assertActive();
    const owners = [...data.owners.values()].filter((o) =>
      "intake" in o
        ? o.intake.installationRef === installation
        : "identity" in o
          ? o.identity.locator.installationRef === installation
          : o.envelope.installationRef === installation,
    ).length;
    const links =
      [...data.incomingLinks.values()].filter((l) => l.locator.installationRef === installation)
        .length +
      [...data.nonTurnLinks.values()].filter((l) => l.intake.installationRef === installation)
        .length;
    const attempts = [...data.attempts.values()].filter(
      (a) => a.record.binding.attempt.installationRef === installation,
    );
    const pending = attempts.filter(
      (a) =>
        "phase" in a.record &&
        sameJournalValue(
          data.reservations.get(agentKey(a.record.binding.attempt)) ?? null,
          a.record.binding.attempt,
        ),
    ).length;
    return (
      links < capacity.maxIncomingLinksPerInstallation &&
      (!newOwner || owners < capacity.maxOwnersPerInstallation) &&
      (!newAttempt ||
        (attempts.length < capacity.maxAttemptsPerInstallation &&
          pending < TURN_JOURNAL_LIMITS_V1.pendingReceiptsPerInstallation))
    );
  };
  const putOwner = async (
    installation: string,
    channel: string,
    owner: JournalAdmissionOwnerV1,
  ) => {
    context.transaction.assertActive();
    if (!(await context.channelExists(installation, channel)))
      throw new ScopeViolationError("The journal channel owner is unavailable.");
    context.transaction.assertActive();
    const owned = immutableCopy(owner);
    const receipt = ownerReceipt(owned);
    const key = ownerKey(installation, channel, receipt.receiptRef);
    if (data.owners.has(key))
      throw new ScopeViolationError("The receipt owner is already retained.");
    for (const [kind, value] of [
      ["event", receipt.eventKey],
      ["logical-message", receipt.logicalMessageKey],
    ])
      if (value && data.ownerKeys.has(keyOf(installation, channel, kind, value)))
        throw new ScopeViolationError("The incoming key is already owned.");
    data.owners.set(key, owned);
    for (const [kind, value] of [
      ["event", receipt.eventKey],
      ["logical-message", receipt.logicalMessageKey],
    ])
      if (value) data.ownerKeys.set(keyOf(installation, channel, kind, value), key);
  };
  const exactLink = async (
    locator: IncomingAdmissionLinkV1["locator"],
    identityDigest: string,
    eventDigest: string,
    contentDigest: string,
  ) => {
    context.transaction.assertActive();
    const link = data.incomingLinks.get(
      keyOf(
        locator.installationRef,
        locator.channelInstallationRef,
        locator.eventKey,
        identityDigest,
        eventDigest,
        contentDigest,
      ),
    );
    return link && sameJournalValue(link.locator, locator) ? link : null;
  };
  const linkIdentity = (link: IncomingAdmissionLinkV1) =>
    keyOf(
      link.locator.installationRef,
      link.locator.channelInstallationRef,
      link.locator.eventKey,
      link.incomingIdentityDigest,
      link.incomingEventDigest,
      link.incomingContentDigest,
    );
  const putLink = async (value: IncomingAdmissionLinkV1) => {
    context.transaction.assertActive();
    const link = parseTurnJournalV1("incomingLink", value);
    if (
      !(await context.channelExists(
        link.locator.installationRef,
        link.locator.channelInstallationRef,
      )) ||
      link.originalReceiptRefs.some(
        (ref) =>
          !data.owners.has(
            ownerKey(link.locator.installationRef, link.locator.channelInstallationRef, ref),
          ),
      )
    )
      throw new ScopeViolationError("The incoming link original owner is unavailable.");
    context.transaction.assertActive();
    if (
      data.incomingLinks.has(linkIdentity(link)) ||
      [...data.incomingLinks.values(), ...data.nonTurnLinks.values()].some(
        (l) => l.incomingLinkRef === link.incomingLinkRef,
      )
    )
      throw new ScopeViolationError("The incoming link is already retained.");
    data.incomingLinks.set(linkIdentity(link), link);
    const anchorKey = keyOf(
      link.locator.installationRef,
      link.locator.channelInstallationRef,
      link.locator.eventKey,
    );
    if (!data.anchors.has(anchorKey))
      data.anchors.set(
        anchorKey,
        Object.freeze({
          link,
          ownerKey: ownerKey(
            link.locator.installationRef,
            link.locator.channelInstallationRef,
            link.originalReceiptRefs[0]!,
          ),
        }),
      );
  };
  const linkFor = (
    identity: JournalAdmissionIdentityV1,
    originals: readonly string[],
    disposition: IncomingAdmissionLinkV1["disposition"],
    auditIntentRef: string,
  ): IncomingAdmissionLinkV1 =>
    parseTurnJournalV1("incomingLink", {
      incomingLinkRef: randomUUID(),
      incomingIdentityDigest: digestJournalAdmissionIdentityV1(identity),
      locator: identity.locator,
      incomingEventDigest: identity.receipt.eventDigest,
      incomingContentDigest: identity.receipt.contentDigest,
      originalReceiptRefs: originals,
      disposition,
      auditIntentRef,
    });
  const nonTurnKey = (intake: ExactNonTurnIntakeV1) =>
    keyOf(
      intake.installationRef,
      intake.channelInstallationRef,
      intake.eventKey,
      digestValue(intake),
    );
  const latestHistory = (operation: ExactDeliveryOperationV1) =>
    [...data.deliveryHistory.values()]
      .filter(
        (h) =>
          h.operation.attempt.installationRef === operation.attempt.installationRef &&
          h.operation.operationRef === operation.operationRef,
      )
      .sort((a, b) => b.attemptNumber - a.attemptNumber)
      .slice(0, 1);

  const insertAttempt = (record: AttemptRecordV1, firstReceivedAt: string) => {
    context.transaction.assertActive();
    const exact = parseTurnJournalV1("attempt", record);
    if (data.attempts.has(attemptKey(exact.binding.attempt)))
      throw new ScopeViolationError("The attempt identity is already retained.");
    const attempt = exact.binding.attempt,
      identity = exact.binding.identity;
    if (
      !Number.isFinite(Date.parse(firstReceivedAt)) ||
      [...data.attempts.values()].some(({ record: prior }) => {
        const previous = prior.binding.attempt;
        return (
          (contextKey(previous) === contextKey(attempt) && previous.turnRef === attempt.turnRef) ||
          (agentKey(previous) === agentKey(attempt) &&
            previous.reservationRef === attempt.reservationRef) ||
          (previous.installationRef === attempt.installationRef &&
            prior.binding.identity.locator.channelInstallationRef ===
              identity.locator.channelInstallationRef &&
            prior.binding.identity.receipt.receiptRef === identity.receipt.receiptRef)
        );
      })
    )
      throw new ScopeViolationError("The turn, reservation or admission is already retained.");
    data.attempts.set(
      attemptKey(exact.binding.attempt),
      Object.freeze({ record: exact, firstReceivedAt }),
    );
  };
  const insertReservation = (attempt: ExactAttemptV1) => {
    context.transaction.assertActive();
    if (data.reservations.has(agentKey(attempt)))
      throw new ScopeViolationError("The Agent reservation is already held.");
    data.reservations.set(agentKey(attempt), parseCompletedContextV1("exactAttempt", attempt));
  };
  const removeReservation = (attempt: ExactAttemptV1) => {
    context.transaction.assertActive();
    if (!sameJournalValue(data.reservations.get(agentKey(attempt)) ?? null, attempt)) return false;
    return data.reservations.delete(agentKey(attempt));
  };
  const publishHead = (
    attempt: ExactAttemptV1,
    expected: ExpectedCompletionHeadV1,
    head: ExpectedCompletionHeadV1,
    checkpoint: CheckpointRefV1,
  ) => {
    context.transaction.assertActive();
    const current = data.heads.get(contextKey(attempt));
    if (!current || !sameJournalValue(current.head, expected)) return false;
    data.heads.set(
      contextKey(attempt),
      Object.freeze({
        head: parseTurnJournalV1("head", head),
        checkpoint: parseCompletedContextV1("checkpointRef", checkpoint),
      }),
    );
    return true;
  };
  const putNonTurnLink = (value: NonTurnReceiptV1) => {
    context.transaction.assertActive();
    const receipt = parseNonTurnReceiptV1(value),
      intake = receipt.intake;
    if (
      data.nonTurnLinks.has(nonTurnKey(intake)) ||
      [...data.incomingLinks.values(), ...data.nonTurnLinks.values()].some(
        (l) => l.incomingLinkRef === receipt.incomingLinkRef,
      )
    )
      throw new ScopeViolationError("The non-turn link is already retained.");
    data.nonTurnLinks.set(nonTurnKey(intake), receipt);
    const key = keyOf(intake.installationRef, intake.channelInstallationRef, intake.eventKey);
    if (!data.anchors.has(key))
      data.anchors.set(
        key,
        Object.freeze({
          link: receipt,
          ownerKey: ownerKey(
            intake.installationRef,
            intake.channelInstallationRef,
            receipt.originalReceiptRefs[0] ?? receipt.receiptRef,
          ),
        }),
      );
  };
  const retainEmptyDeliverySlot = (value: ExactDeliveryOperationV1) => {
    context.transaction.assertActive();
    const operation = parseTurnJournalV1("deliveryOperation", value);
    if (data.deliveries.has(deliveryKey(operation)))
      throw new ScopeViolationError("The delivery slot is already retained.");
    if (
      !data.attempts.has(attemptKey(operation.attempt)) ||
      [...data.deliveries.values()].some(
        (prior) =>
          prior.operation.attempt.installationRef === operation.attempt.installationRef &&
          prior.operation.operationRef === operation.operationRef,
      )
    )
      throw new ScopeViolationError("The delivery operation owner differs.");
    data.deliveries.set(
      deliveryKey(operation),
      Object.freeze({
        operation,
        outcome: null,
        deliveryAttemptRef: null,
        attemptNumber: 0,
        episodeStartedAt: null,
        updateUsed: false,
      }),
    );
  };
  const retainDeliveryHistory = (record: StoredDelivery) => {
    context.transaction.assertActive();
    if (record.deliveryAttemptRef === null)
      throw new ScopeViolationError("The delivery attempt is missing.");
    if (
      [...data.deliveryHistory.values()].some(
        (h) => h.deliveryAttemptRef === record.deliveryAttemptRef,
      )
    )
      throw new ScopeViolationError("The delivery attempt identity is already retained.");
    if (
      [...data.deliveryHistory.values()].some(
        (h) =>
          h.operation.attempt.installationRef === record.operation.attempt.installationRef &&
          h.operation.operationRef === record.operation.operationRef &&
          h.attemptNumber === record.attemptNumber,
      )
    )
      throw new ScopeViolationError("The delivery operation attempt is already retained.");
    data.deliveryHistory.set(
      historyKey(record.operation, record.deliveryAttemptRef),
      immutableCopy(record),
    );
  };
  const repository: TurnJournalUnitOfWorkV1 = {
    async findDeadlineControl() {
      return unavailable;
    },
    async retainDeadlineControl() {
      return unavailable;
    },
    async findExecution() {
      return unavailable;
    },
    async findExecutionInterruption() {
      return unavailable;
    },
    async retainExecutionStart() {
      return unavailable;
    },
    async retainExecutionInterruption() {
      return unavailable;
    },
    async findAdmission(input, call) {
      const key = parseTurnJournalV1("lookup", input);
      return read("findAdmission", key, call, async () => {
        let owner = await findOwner(
          key.installationRef,
          key.channelInstallationRef,
          key.kind,
          key.kind === "event" ? key.eventKey : key.logicalMessageKey,
        );
        if (!owner && key.kind === "event")
          owner =
            (await eventAnchor(key.installationRef, key.channelInstallationRef, key.eventKey))
              ?.owner ?? null;
        if (!owner) return absent;
        if ("intake" in owner) return { kind: "found-non-turn", receipt: owner } as const;
        return "identity" in owner
          ? ({ kind: "found", record: owner } as const)
          : ({ kind: "found-rejected", record: owner } as const);
      });
    },
    async findRejectedAdmission(input, call) {
      const key = parseTurnJournalV1("lookup", input);
      return read("findRejectedAdmission", key, call, async () => {
        let owner = await findOwner(
          key.installationRef,
          key.channelInstallationRef,
          key.kind,
          key.kind === "event" ? key.eventKey : key.logicalMessageKey,
        );
        if (!owner && key.kind === "event")
          owner =
            (await eventAnchor(key.installationRef, key.channelInstallationRef, key.eventKey))
              ?.owner ?? null;
        return owner && "envelope" in owner ? ({ kind: "found", record: owner } as const) : absent;
      });
    },
    async findIncomingLink(input, call) {
      const key = parseExactIncomingLinkV1(input);
      return read("findIncomingLink", key, call, async () => {
        const link = await exactLink(
          key.locator,
          key.incomingIdentityDigest,
          key.incomingEventDigest,
          key.incomingContentDigest,
        );
        if (!link) return absent;
        const rows = [
          data.owners.get(
            ownerKey(
              key.locator.installationRef,
              key.locator.channelInstallationRef,
              link.originalReceiptRefs[0]!,
            ),
          ),
        ].filter((v): v is JournalAdmissionOwnerV1 => v !== undefined);
        if (!rows[0])
          throw new DependencyUnavailableError("The incoming link owner is unavailable.");
        const original = rows[0];
        if ("intake" in original) return { kind: "found-non-turn", link, original } as const;
        return "identity" in original
          ? ({ kind: "found", link, original } as const)
          : ({ kind: "found-rejected", link, original } as const);
      });
    },
    async findAttempt(input, call) {
      const attempt = parseCompletedContextV1("exactAttempt", input);
      return read("findAttempt", attempt, call, async () => {
        const rows = [data.attempts.get(attemptKey(attempt))].filter(
          (v): v is StoredAttempt => v !== undefined,
        );
        return rows[0] ? ({ kind: "found", record: rows[0].record } as const) : absent;
      });
    },
    async readHead(input, call) {
      const key = parseCompletedContextV1("contextKey", input);
      const state = await read("readHead", key, call, async () => {
        const head = await getHead(key);
        if (!head) return { kind: "unavailable", reason: "store-unavailable" } as const;
        // A held first turn is unresolved even before any checkpoint exists.
        const unresolved = [...data.reservations.values()].filter(
          (r) => contextKey(r) === contextKey(key),
        );
        if (unresolved.length) return { kind: "unavailable", reason: "unresolved-work" } as const;
        if (!head.checkpoint && (await contextUsed(key)))
          return { kind: "unavailable", reason: "store-unavailable" } as const;
        return head.checkpoint
          ? ({ kind: "completed", head: head.head, checkpoint: head.checkpoint } as const)
          : ({ kind: "new-context", head: head.head } as const);
      });
      return state.kind === "denied" || (state.kind === "unavailable" && !("reason" in state))
        ? { kind: "unavailable", reason: "store-unavailable" }
        : state;
    },
    async findCheckpointAllocation(input, call) {
      const allocation = parseTurnJournalV1("checkpointAllocation", input);
      return read("findCheckpointAllocation", allocation, call, async () => {
        const op = await getOperation(
          allocation.attempt,
          "checkpoint-allocation",
          allocation.operationRef,
        );
        return op && sameJournalValue(op.request, allocation)
          ? ({
              kind: "found",
              allocation: parseTurnJournalV1("checkpointAllocation", op.record),
            } as const)
          : absent;
      });
    },
    async findCompletion(input, call) {
      const operation = parseTurnJournalV1("completionOperation", input);
      return read("findCompletion", operation, call, async () => {
        const op = await getOperation(operation.attempt, "completion", operation.operationRef);
        if (!op) return absent;
        return sameJournalValue(op.request, operation)
          ? ({ kind: "published", record: parseTurnJournalV1("completion", op.record) } as const)
          : conflict;
      });
    },
    async findCancellation(input, call) {
      const operation = parseTurnJournalV1("cancellation", input);
      return read("findCancellation", operation, call, async () => {
        const op = await getOperation(operation.attempt, "cancellation", operation.operationRef);
        if (!op || op.operationKind !== "cancellation" || !sameJournalValue(op.request, operation))
          return absent;
        return { kind: "found", ...op.record } as const;
      });
    },
    async findRelease(input, call) {
      const observation = parseTurnJournalV1("releaseObservation", input);
      return read("findRelease", observation, call, async () => {
        const op = await getOperation(
          observation.attempt,
          "release",
          observation.releaseOperationRef,
        );
        return op && sameJournalValue(op.request, observation)
          ? ({
              kind: "released",
              observation: parseTurnJournalV1("releaseObservation", op.record),
            } as const)
          : absent;
      });
    },
    async findNonTurnIntake(input, call) {
      const intake = parseNonTurnIntakeV1(input);
      return read("findNonTurnIntake", intake, call, async () => {
        const rows = [data.nonTurnLinks.get(nonTurnKey(intake))].filter(
          (v): v is NonTurnReceiptV1 => v !== undefined,
        );
        if (!rows[0]) return { kind: "not-found" } as const;
        const receipt = parseNonTurnReceiptV1(rows[0]);
        return sameJournalValue(receipt.intake, intake)
          ? ({ kind: "found", receipt } as const)
          : ({ kind: "not-found" } as const);
      });
    },
    // Mutation methods are assigned below so internal calls never reenter the
    // owner's outward admission wrapper while accepted work drains.
    ...mutations(),
  };
  const mutationNames = new Set<keyof TurnJournalUnitOfWorkV1>([
    "admit",
    "admitRejected",
    "admitNonTurn",
    "recordDispatchIntent",
    "consumeAttempt",
    "allocateCheckpoint",
    "publishCompleted",
    "recordOutcome",
    "commitCancellation",
    "releaseReservation",
    "reserveDelivery",
    "recordDelivery",
  ]);
  const valueInput = (name: keyof TurnJournalUnitOfWorkV1, input: unknown): unknown => {
    switch (name) {
      case "findAdmission":
      case "findRejectedAdmission":
        return parseTurnJournalV1("lookup", input);
      case "findIncomingLink":
        return parseExactIncomingLinkV1(input);
      case "findAttempt":
        return parseCompletedContextV1("exactAttempt", input);
      case "readHead":
        return parseCompletedContextV1("contextKey", input);
      case "findCheckpointAllocation":
      case "allocateCheckpoint":
        return parseTurnJournalV1("checkpointAllocation", input);
      case "findCompletion":
        return parseTurnJournalV1("completionOperation", input);
      case "findCancellation":
        return parseTurnJournalV1("cancellation", input);
      case "findRelease":
        return parseTurnJournalV1("releaseObservation", input);
      case "findNonTurnIntake":
        return parseNonTurnIntakeV1(input);
      case "findDelivery":
        return parseTurnJournalV1("deliveryOperation", input);
      case "recordDelivery":
        return parseTurnJournalV1("delivery", input);
      default:
        return input; // Opaque handles are inspected by their original owner.
    }
  };
  const projection = {} as TurnJournalUnitOfWorkV1;
  for (const name of Object.keys(repository) as (keyof TurnJournalUnitOfWorkV1)[]) {
    const method = repository[name];
    Object.defineProperty(projection, name, {
      enumerable: true,
      value: (input: unknown, call: AuthorityCallV1) => {
        try {
          const exactCall = checkedCall(call);
          const exactInput = valueInput(name, input);
          return Reflect.apply(method, repository, [exactInput, exactCall]);
        } catch (error) {
          if (mutationNames.has(name))
            return participant.retainMutation(
              participant.guard.mutate(async () => {
                throw error;
              }),
            );
          return Promise.reject(error);
        }
      },
    });
  }
  return Object.freeze(projection);

  function mutations(): Pick<
    TurnJournalUnitOfWorkV1,
    | "admit"
    | "admitRejected"
    | "admitNonTurn"
    | "recordDispatchIntent"
    | "consumeAttempt"
    | "allocateCheckpoint"
    | "publishCompleted"
    | "recordOutcome"
    | "commitCancellation"
    | "releaseReservation"
    | "reserveDelivery"
    | "recordDelivery"
    | "findDelivery"
  > {
    return {
      admit: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("admit", input, call);
          if (auth.kind !== "authorized") return auth;
          let observation = await owned(ports.admission.inspect(input, checkedCall(call)));
          active(call);
          if (failure(observation)) return observation;
          const identity = parseTurnJournalV1("admissionIdentity", observation.identity);
          const attempt = parseCompletedContextV1("exactAttempt", observation.attempt);
          const expectedHead = parseTurnJournalV1("head", observation.expectedHead);
          const admittedBinding = parseTurnJournalV1("commonAttemptBinding", {
            attempt,
            identity,
            reservation: observation.reservation,
            expectedHead,
          });
          const firstReceivedAt = observation.envelope.receivedAt;
          const firstReceived = Date.parse(firstReceivedAt);
          if (
            identity.locator.installationRef !== auth.installation.id ||
            !sameJournalValue(identity.context, expectedHead.context) ||
            !sameJournalValue(contextValues(attempt), contextValues(identity.context))
          )
            return denied;
          await admissionLock(auth.installation.id);
          observation = await owned(ports.admission.inspect(input, checkedCall(call)));
          active(call);
          if (failure(observation)) return observation;
          if (
            !sameJournalValue(observation.identity, identity) ||
            !sameJournalValue(observation.attempt, attempt) ||
            !sameJournalValue(observation.expectedHead, expectedHead) ||
            !sameJournalValue(observation.reservation, admittedBinding.reservation) ||
            observation.envelope.receivedAt !== firstReceivedAt
          )
            return denied;
          const repeated = await exactLink(
            identity.locator,
            digestJournalAdmissionIdentityV1(identity),
            identity.receipt.eventDigest,
            identity.receipt.contentDigest,
          );
          const event = await findOwner(
            auth.installation.id,
            identity.locator.channelInstallationRef,
            "event",
            identity.locator.eventKey,
          );
          const logical = await findOwner(
            auth.installation.id,
            identity.locator.channelInstallationRef,
            "logical-message",
            identity.locator.logicalMessageKey,
          );
          const anchor = await eventAnchor(
            auth.installation.id,
            identity.locator.channelInstallationRef,
            identity.locator.eventKey,
          );
          const anchorLink = anchor && "locator" in anchor.link ? anchor.link : null;
          const changedEvent =
            anchor !== null &&
            (anchorLink === null ||
              anchorLink.disposition === "conflict" ||
              anchorLink.locator.logicalMessageKey !== identity.locator.logicalMessageKey ||
              anchorLink.incomingEventDigest !== identity.receipt.eventDigest ||
              anchorLink.incomingContentDigest !== identity.receipt.contentDigest);
          const anchoredOwner = anchor?.owner ?? null;
          const retainedRefs = [
            ...new Set(
              [anchoredOwner, logical]
                .filter((owner): owner is JournalAdmissionOwnerV1 => owner !== null)
                .map((owner) => ownerReceipt(owner).receiptRef),
            ),
          ];
          const existing =
            anchor && "intake" in anchor.owner
              ? {
                  kind: "non-turn-owned" as const,
                  original: anchor.owner,
                  originalReceiptRefs: retainedRefs,
                }
              : changedEvent
                ? { kind: "conflict" as const, originalReceiptRefs: retainedRefs }
                : classifyJournalAdmissionV1({
                    incoming: identity,
                    byEvent: event,
                    byLogicalMessage:
                      logical ??
                      (anchoredOwner &&
                      ownerReceipt(anchoredOwner).logicalMessageKey ===
                        identity.locator.logicalMessageKey
                        ? anchoredOwner
                        : null),
                    agentReserved: false,
                  });
          if (existing.kind !== "candidate") {
            const refs =
              existing.kind === "duplicate"
                ? [ownerReceipt(existing.original).receiptRef]
                : "originalReceiptRefs" in existing
                  ? existing.originalReceiptRefs
                  : [];
            const link =
              repeated ??
              linkFor(
                identity,
                refs,
                existing.kind === "duplicate" ? "duplicate" : "conflict",
                observation.auditIntentRef,
              );
            if (!repeated) {
              if (!(await capacityAvailable(auth.installation.id, false, false)))
                return unavailable;
              await putLink(link);
            }
            if (existing.kind === "duplicate")
              return "identity" in existing.original
                ? {
                    kind: "recorded",
                    record: existing.original,
                    incomingLink: link,
                    duplicate: link.disposition !== "original",
                  }
                : { kind: "rejected-existing", record: existing.original, incomingLink: link };
            if (existing.kind === "non-turn-owned")
              return { kind: "non-turn-owned", original: existing.original, incomingLink: link };
            const original = event ?? anchoredOwner ?? logical;
            if (!original || "intake" in original)
              throw new DependencyUnavailableError("The admission conflict owner is unavailable.");
            return {
              kind: "conflict",
              incomingLink: link,
              originalReceipt:
                "identity" in original ? original.identity.receipt : original.receipt,
            };
          }
          if (!(await agentLock(attempt))) return denied;
          const reserved =
            [...data.reservations.values()].filter((r) => agentKey(r) === agentKey(attempt))
              .length > 0;
          observation = await owned(ports.admission.inspect(input, checkedCall(call)));
          active(call);
          if (failure(observation)) return observation;
          if (
            !sameJournalValue(observation.identity, identity) ||
            !sameJournalValue(observation.attempt, attempt) ||
            !sameJournalValue(observation.expectedHead, expectedHead) ||
            !sameJournalValue(observation.reservation, admittedBinding.reservation) ||
            !Number.isFinite(firstReceived) ||
            observation.envelope.receivedAt !== firstReceivedAt ||
            firstReceived > nowMilliseconds() ||
            nowMilliseconds() >= firstReceived + TURN_JOURNAL_LIMITS_V1.intakeDeadlineMs
          )
            return denied;
          const current = await getHead(attempt);
          if (!reserved && current && !current.checkpoint && (await contextUsed(attempt)))
            return denied;
          // Only authenticated first-creation evidence can establish an empty head.
          if (
            (current && !sameJournalValue(current.head, expectedHead)) ||
            (!current &&
              (expectedHead.headVersion !== 1 ||
                expectedHead.completionSequence !== 0 ||
                expectedHead.checkpointId !== null))
          )
            return denied;
          if (!(await capacityAvailable(auth.installation.id, true, !reserved))) return unavailable;
          const record = parseTurnJournalV1("admission", {
            schemaVersion: 1,
            identity,
            decision: reserved ? { kind: "busy" } : { kind: "accepted", attempt },
            expectedHead,
            decisionRef: observation.decisionRef,
            auditIntentRef: observation.auditIntentRef,
            decidedAt: new Date(nowMilliseconds()).toISOString(),
          });
          const link = linkFor(
            identity,
            [identity.receipt.receiptRef],
            "original",
            observation.auditIntentRef,
          );
          await putOwner(auth.installation.id, identity.locator.channelInstallationRef, record);
          await putLink(link);
          if (!reserved) {
            if (!current)
              data.heads.set(
                contextKey(attempt),
                Object.freeze({ head: expectedHead, checkpoint: null }),
              );
            const admitted = parseTurnJournalV1("attempt", {
              phase: "admitted-undispatched",
              binding: admittedBinding,
              version: 1,
              consumption: null,
              outcome: { kind: "accepted-undispatched" },
            });
            insertAttempt(admitted, firstReceivedAt);
            insertReservation(attempt);
          }
          active(call);
          return { kind: "recorded", record, incomingLink: link, duplicate: false };
        }),
      admitRejected: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("admitRejected", input, call);
          if (auth.kind !== "authorized") return unavailable;
          const inspected = await owned(ports.admission.inspectRejected(input, checkedCall(call)));
          active(call);
          if (failure(inspected)) return unavailable;
          const incoming = parseRejectedAdmissionV1(inspected);
          if (incoming.envelope.installationRef !== auth.installation.id) return unavailable;
          const receipt = incoming.receipt;
          const locator = {
            schemaVersion: 1 as const,
            installationRef: auth.installation.id,
            channelInstallationRef: incoming.envelope.channelInstallationRef,
            eventKey: receipt.eventKey,
            logicalMessageKey: receipt.logicalMessageKey,
          };
          const identityDigest = digestValue({
            envelope: {
              platform: incoming.envelope.platform,
              providerTenantRef: incoming.envelope.providerTenantRef,
              recipientAppRef: incoming.envelope.recipientAppRef,
              sender: incoming.envelope.sender,
              nativeConversation: incoming.envelope.nativeConversation,
            },
            locator,
            eventDigest: receipt.eventDigest,
            contentDigest: receipt.contentDigest,
            profileConfigurationDigest: receipt.profileConfigurationDigest,
          });
          await admissionLock(auth.installation.id);
          const currentRejected = await owned(
            ports.admission.inspectRejected(input, checkedCall(call)),
          );
          active(call);
          if (
            failure(currentRejected) ||
            !sameJournalValue(parseRejectedAdmissionV1(currentRejected), incoming)
          )
            return unavailable;
          const repeated = await exactLink(
            locator,
            identityDigest,
            receipt.eventDigest,
            receipt.contentDigest,
          );
          const event = await findOwner(
            auth.installation.id,
            locator.channelInstallationRef,
            "event",
            receipt.eventKey,
          );
          const logical = await findOwner(
            auth.installation.id,
            locator.channelInstallationRef,
            "logical-message",
            receipt.logicalMessageKey,
          );
          const anchor = await eventAnchor(
            auth.installation.id,
            locator.channelInstallationRef,
            receipt.eventKey,
          );
          const anchorLink = anchor && "locator" in anchor.link ? anchor.link : null;
          const originals = [
            ...new Map(
              [event ?? anchor?.owner ?? null, logical]
                .filter((owner): owner is JournalAdmissionOwnerV1 => owner !== null)
                .map((owner) => [ownerReceipt(owner).receiptRef, owner]),
            ).values(),
          ];
          const original = originals[0];
          const nonTurn = originals.find((owner): owner is NonTurnReceiptV1 => "intake" in owner);
          const originalSdk =
            original && !("intake" in original)
              ? "identity" in original
                ? original.identity.receipt
                : original.receipt
              : null;
          const subjectMatches =
            original &&
            !("intake" in original) &&
            ("identity" in original
              ? original.identity.providerSubjectRef
              : original.envelope.sender.providerSubjectRef) ===
              incoming.envelope.sender.providerSubjectRef;
          const incomingRoute = options.canonicalRouteKey(incoming.envelope);
          if (!/^[a-f0-9]{64}$/.test(incomingRoute)) return unavailable;
          const originalRoute =
            original && !("intake" in original)
              ? "identity" in original
                ? original.identity.routeKey
                : options.canonicalRouteKey(original.envelope)
              : null;
          // Logical-message identity does not contain the native root thread.
          // Compare the selected SDK route separately to preserve its exact target.
          const duplicate =
            originals.length === 1 &&
            originalSdk !== null &&
            subjectMatches &&
            originalRoute === incomingRoute &&
            originalSdk.logicalMessageKey === receipt.logicalMessageKey &&
            originalSdk.contentDigest === receipt.contentDigest &&
            originalSdk.profileConfigurationDigest === receipt.profileConfigurationDigest &&
            (!event || ownerReceipt(event).eventDigest === receipt.eventDigest) &&
            (!anchor ||
              (anchorLink !== null &&
                anchorLink.disposition !== "conflict" &&
                anchorLink.locator.logicalMessageKey === receipt.logicalMessageKey &&
                anchorLink.incomingEventDigest === receipt.eventDigest &&
                anchorLink.incomingContentDigest === receipt.contentDigest));
          const link: IncomingAdmissionLinkV1 = repeated ?? {
            incomingLinkRef: randomUUID(),
            incomingIdentityDigest: identityDigest,
            locator,
            incomingEventDigest: receipt.eventDigest,
            incomingContentDigest: receipt.contentDigest,
            originalReceiptRefs: originals.length
              ? originals.map((owner) => ownerReceipt(owner).receiptRef)
              : [receipt.receiptRef],
            disposition: originals.length ? (duplicate ? "duplicate" : "conflict") : "original",
            auditIntentRef: incoming.auditIntentRef,
          };
          if (!repeated) {
            if (!(await capacityAvailable(auth.installation.id, !originals.length, false)))
              return unavailable;
            if (!originals.length)
              await putOwner(auth.installation.id, locator.channelInstallationRef, incoming);
            await putLink(link);
          }
          if (nonTurn) return { kind: "non-turn-owned", original: nonTurn, incomingLink: link };
          if (duplicate && original && "identity" in original)
            return { kind: "resolved-existing", record: original, incomingLink: link };
          if (duplicate && original && "envelope" in original)
            return {
              kind: "existing",
              record: original,
              incomingLink: link,
            };
          if (originalSdk)
            return { kind: "conflict", originalReceipt: originalSdk, incomingLink: link };
          active(call);
          return { kind: repeated ? "existing" : "recorded", record: incoming, incomingLink: link };
        }),
      admitNonTurn: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("admitNonTurn", input, call);
          if (auth.kind !== "authorized") return { kind: "not-responsible" };
          const inspected = await owned(ports.nonTurn.inspectNonTurn(input, checkedCall(call)));
          active(call);
          if (failure(inspected)) return { kind: "not-responsible" };
          const intake = parseNonTurnIntakeV1(inspected);
          if (intake.installationRef !== auth.installation.id) return { kind: "not-responsible" };
          await admissionLock(auth.installation.id);
          const currentNonTurn = await owned(
            ports.nonTurn.inspectNonTurn(input, checkedCall(call)),
          );
          active(call);
          if (
            failure(currentNonTurn) ||
            !sameJournalValue(parseNonTurnIntakeV1(currentNonTurn), intake)
          )
            return { kind: "not-responsible" };
          const repeated = [data.nonTurnLinks.get(nonTurnKey(intake))].filter(
            (v): v is NonTurnReceiptV1 => v !== undefined,
          );
          if (repeated[0]) {
            const receipt = parseNonTurnReceiptV1(repeated[0]);
            return sameJournalValue(receipt.intake, intake)
              ? { kind: "recorded", receipt }
              : { kind: "not-responsible" };
          }
          const anchor = await eventAnchor(
            intake.installationRef,
            intake.channelInstallationRef,
            intake.eventKey,
          );
          const event =
            (await findOwner(
              intake.installationRef,
              intake.channelInstallationRef,
              "event",
              intake.eventKey,
            )) ??
            anchor?.owner ??
            null;
          const logical =
            intake.logicalMessage.kind === "equivalent-original"
              ? await findOwner(
                  intake.installationRef,
                  intake.channelInstallationRef,
                  "logical-message",
                  intake.logicalMessage.logicalMessageKey,
                )
              : null;
          const refs = [
            ...new Set(
              [event, logical]
                .filter((owner): owner is JournalAdmissionOwnerV1 => owner !== null)
                .map((owner) => ownerReceipt(owner).receiptRef),
            ),
          ];
          const original = event ?? logical;
          const exact =
            original && "intake" in original && sameJournalValue(original.intake, intake);
          if (!(await capacityAvailable(auth.installation.id, refs.length === 0, false)))
            return { kind: "not-responsible" };
          const receipt = parseNonTurnReceiptV1({
            schemaVersion: 1,
            receiptRef: randomUUID(),
            intake,
            disposition: refs.length && !exact ? "conflict" : "ignored",
            incomingLinkRef: randomUUID(),
            originalReceiptRefs: refs,
            auditIntentRef: randomUUID(),
          });
          if (!refs.length)
            await putOwner(intake.installationRef, intake.channelInstallationRef, receipt);
          putNonTurnLink(receipt);
          active(call);
          return { kind: "recorded", receipt };
        }),
      ...executionMutations(),
    };
  }

  function executionMutations(): Pick<
    TurnJournalUnitOfWorkV1,
    | "recordDispatchIntent"
    | "consumeAttempt"
    | "allocateCheckpoint"
    | "publishCompleted"
    | "recordOutcome"
    | "commitCancellation"
    | "releaseReservation"
    | "reserveDelivery"
    | "recordDelivery"
    | "findDelivery"
  > {
    return {
      recordDispatchIntent: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("recordDispatchIntent", input, call);
          if (auth.kind !== "authorized") return auth;
          let observed = await owned(ports.evidence.inspectDispatch(input, checkedCall(call)));
          active(call);
          if (failure(observed)) return observed;
          const binding = parseTurnJournalV1("attemptBinding", observed);
          if (
            binding.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(binding.attempt))
          )
            return denied;
          const row = await getAttempt(binding.attempt);
          if (!row) return conflict;
          observed = await owned(ports.evidence.inspectDispatch(input, checkedCall(call)));
          active(call);
          if (failure(observed)) return observed;
          if (!sameJournalValue(parseTurnJournalV1("attemptBinding", observed), binding))
            return denied;
          const current = row.record;
          // Replays retain actual intent or later progress. Neither a common
          // record nor early authority is an existing dispatch intent.
          if (current.outcome.kind !== "accepted-undispatched") {
            if (
              "phase" in current ||
              ("stage" in current.outcome && current.outcome.stage === "before-dispatch") ||
              !sameJournalValue(current.binding, binding)
            )
              return conflict;
            return parseTurnJournalResultV1("dispatchIntent", {
              kind: "existing",
              record: current,
            });
          }
          if (current.version === Number.MAX_SAFE_INTEGER) return conflict;
          const result = parseTurnJournalResultV1("dispatchIntent", {
            kind: "recorded",
            record: {
              binding,
              version: current.version + 1,
              consumption: null,
              outcome: {
                kind: "dispatch-intent",
                dispatchOperationRef: binding.dispatchOperationRef,
              },
            },
          });
          if (result.kind !== "recorded")
            throw new DependencyUnavailableError("The dispatch intent result is unavailable.");
          if (!journalDispatchIntentMatchesV1(current, result.record, current.version))
            return conflict;
          const ownerRows = [
            data.owners.get(
              ownerKey(
                auth.installation.id,
                row.record.binding.identity.locator.channelInstallationRef,
                row.record.binding.identity.receipt.receiptRef,
              ),
            ),
          ].filter((v): v is JournalAdmissionOwnerV1 => v !== undefined);
          const owner = ownerRows[0] && ownerRows[0];
          if (
            !owner ||
            !("identity" in owner) ||
            owner.decision.kind !== "accepted" ||
            !sameJournalValue(owner.decision.attempt, binding.attempt) ||
            !sameJournalValue(owner.identity, binding.identity) ||
            !sameJournalValue(owner.expectedHead, binding.expectedHead) ||
            !sameJournalValue(row.record.binding.reservation, binding.reservation)
          )
            return conflict;
          if (
            !(await reservationHeld(binding.attempt)) ||
            Date.parse(binding.expiresAt) <= nowMilliseconds() ||
            nowMilliseconds() >=
              Date.parse(row.firstReceivedAt) + TURN_JOURNAL_LIMITS_V1.intakeDeadlineMs
          )
            return denied;
          const cancellations = operationsFor(binding.attempt, "cancellation");
          if (cancellations.length) return denied;
          const head = await getHead(binding.attempt);
          if (!head || !sameJournalValue(head.head, binding.expectedHead)) return conflict;
          await updateAttempt(binding.attempt, result.record);
          active(call);
          return result;
        }),
      consumeAttempt: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("consumeAttempt", input, call);
          if (auth.kind !== "authorized") return auth;
          let observed = await owned(ports.evidence.inspectConsumption(input, checkedCall(call)));
          active(call);
          if (failure(observed)) return observed;
          if (observed.executionIntent !== undefined || observed.executionSelection !== undefined)
            return unavailable;
          const operation = parseTurnJournalV1("consumption", observed.operation);
          if (
            operation.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(operation.attempt))
          )
            return denied;
          const row = await getAttempt(operation.attempt);
          const record = row && row.record;
          if (!record || "phase" in record) return conflict;
          if (record.consumption)
            return sameJournalValue(record.consumption.operation, operation)
              ? { kind: "already-consumed", operation: record.consumption.operation }
              : conflict;
          observed = await owned(ports.evidence.inspectConsumption(input, checkedCall(call)));
          active(call);
          if (failure(observed)) return observed;
          if (observed.executionIntent !== undefined || observed.executionSelection !== undefined)
            return unavailable;
          if (
            !sameJournalValue(observed.operation, operation) ||
            !sameJournalValue(observed.binding, record.binding)
          )
            return denied;
          if (
            record.outcome.kind !== "dispatch-intent" ||
            record.version === Number.MAX_SAFE_INTEGER ||
            nowMilliseconds() >= Date.parse(record.binding.expiresAt) ||
            !(await reservationHeld(operation.attempt))
          )
            return denied;
          const cancellations = operationsFor(operation.attempt, "cancellation");
          if (cancellations.length) return denied;
          const consumedAt = new Date(nowMilliseconds()).toISOString();
          const next = parseTurnJournalV1("attempt", {
            ...record,
            version: record.version + 1,
            consumption: { operation, consumedAt },
            outcome: {
              kind: "consumed",
              consumptionOperationRef: operation.operationRef,
              consumedAt,
            },
          });
          await updateAttempt(operation.attempt, next);
          active(call);
          return {
            kind: "claim-pending",
            claim: participant.guard.createClaim(
              operation,
              new Date(
                Math.min(
                  Date.parse(record.binding.expiresAt),
                  Date.parse(call.deadline),
                  nowMilliseconds() + TURN_JOURNAL_LIMITS_V1.startWindowMs,
                ),
              ).toISOString(),
            ),
          };
        }),
      allocateCheckpoint: (input, call) =>
        mutate(call, async () => {
          const allocation = parseTurnJournalV1("checkpointAllocation", input);
          const auth = await authorize("allocateCheckpoint", allocation, call);
          if (auth.kind !== "authorized") return auth;
          if (!(await agentLock(allocation.attempt))) return denied;
          const existing = await getOperation(
            allocation.attempt,
            "checkpoint-allocation",
            allocation.operationRef,
          );
          if (existing)
            return sameJournalValue(existing.request, allocation)
              ? {
                  kind: "existing",
                  allocation: parseTurnJournalV1("checkpointAllocation", existing.record),
                }
              : conflict;
          const row = await getAttempt(allocation.attempt);
          const record = row && row.record;
          const head = await getHead(allocation.attempt);
          if (
            !record?.consumption ||
            !head ||
            !sameJournalValue(record.binding.expectedHead, allocation.expectedHead) ||
            !sameJournalValue(head.head, allocation.expectedHead) ||
            !(await reservationHeld(allocation.attempt))
          )
            return conflict;
          if (!["consumed", "running", "outcome-unknown"].includes(record.outcome.kind))
            return denied;
          const prior = operationsFor(allocation.attempt, "checkpoint-allocation");
          if (prior.length) return conflict;
          const current = await authorize("allocateCheckpoint", allocation, call);
          if (current.kind !== "authorized") return current;
          await putOperation(
            allocation.attempt,
            "checkpoint-allocation",
            allocation.operationRef,
            allocation,
            allocation,
          );
          active(call);
          return { kind: "allocated", allocation };
        }),
      publishCompleted: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("publishCompleted", input, call);
          if (auth.kind !== "authorized") return auth;
          let observation = await owned(ports.evidence.inspectCompletion(input, checkedCall(call)));
          active(call);
          if (failure(observation)) return observation;
          const operation = parseTurnJournalV1("completionOperation", observation.operation);
          if (
            operation.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(operation.attempt))
          )
            return denied;
          const existing = await getOperation(
            operation.attempt,
            "completion",
            operation.operationRef,
          );
          if (existing)
            return sameJournalValue(existing.request, operation)
              ? { kind: "existing", record: parseTurnJournalV1("completion", existing.record) }
              : conflict;
          const row = await getAttempt(operation.attempt);
          const current = row && row.record;
          const head = await getHead(operation.attempt);
          if (
            !current ||
            "phase" in current ||
            !current.consumption ||
            !head ||
            !(await reservationHeld(operation.attempt))
          )
            return conflict;
          if (
            current.version !== operation.expectedAttemptVersion ||
            head.head.completionSequence !== operation.expectedCompletionSequence
          )
            return conflict;
          observation = await owned(ports.evidence.inspectCompletion(input, checkedCall(call)));
          active(call);
          if (failure(observation)) return observation;
          if (!sameJournalValue(operation, observation.operation)) return denied;
          const allocationOp = await getOperation(
            operation.attempt,
            "checkpoint-allocation",
            observation.allocation.operationRef,
          );
          if (
            !allocationOp ||
            !sameJournalValue(allocationOp.record, observation.allocation) ||
            !sameJournalValue(head.head, observation.allocation.expectedHead)
          )
            return conflict;
          const checkpoint = parseCompletedContextV1(
            "checkpointRef",
            observation.canonical.checkpointRef,
          );
          if (
            observation.canonical.kind !== "verified" ||
            !observation.canonical.verificationReceiptRef ||
            !observation.nativeTerminalEvidenceRef ||
            !observation.noMutatorEvidenceRef ||
            observation.workspaceCompletionRef !== checkpoint.workspaceCompletionRef ||
            !sameJournalValue(
              observation.gatewayAssignment,
              current.binding.identity.gatewayAssignment,
            ) ||
            !sameJournalValue(
              observation.harnessAssignment,
              current.binding.identity.harnessAssignment,
            ) ||
            !sameJournalValue(observation.reservation, current.binding.reservation)
          )
            return denied;
          const record = parseTurnJournalV1("completion", {
            operation,
            checkpoint,
            head: {
              ...head.head,
              headVersion: head.head.headVersion + 1,
              completionSequence: head.head.completionSequence + 1,
              checkpointId: checkpoint.checkpointId,
            },
            outcomeVersion: current.version + 1,
            pendingDelivery: observation.pendingDelivery,
          });
          if (
            !journalCompletionMatchesV1({
              currentAttempt: current,
              currentHead: head.head,
              allocation: observation.allocation,
              candidate: record,
              expectedAttemptVersion: operation.expectedAttemptVersion,
            })
          )
            return conflict;
          const slots = [...data.deliveries.values()].filter(
            (d) =>
              sameJournalValue(d.operation.attempt, operation.attempt) &&
              d.operation.slot === "completed-result",
          );
          if (slots.length) return conflict;
          const updated = publishHead(operation.attempt, head.head, record.head, checkpoint);
          if (!updated)
            throw new DependencyUnavailableError(
              "The completed context head changed during publication.",
            );
          await updateAttempt(operation.attempt, {
            ...current,
            version: current.version + 1,
            outcome: {
              kind: "completed",
              checkpoint,
              completionOperationRef: operation.operationRef,
            },
          });
          await putOperation(
            operation.attempt,
            "completion",
            operation.operationRef,
            operation,
            record,
          );
          await insertDeliverySlot(record.pendingDelivery);
          active(call);
          return { kind: "published", record };
        }),
      recordOutcome: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("recordOutcome", input, call);
          if (auth.kind !== "authorized") return auth;
          let observed = await owned(ports.evidence.inspectOutcome(input, checkedCall(call)));
          active(call);
          if (failure(observed)) return observed;
          const operation = parseTurnJournalV1("outcomeOperation", observed);
          if (
            operation.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(operation.attempt))
          )
            return denied;
          const existing = await getOperation(operation.attempt, "outcome", operation.operationRef);
          if (existing)
            return sameJournalValue(existing.request, operation)
              ? { kind: "existing", record: parseTurnJournalV1("attempt", existing.record) }
              : conflict;
          const row = await getAttempt(operation.attempt);
          const current = row && row.record;
          if (!current) return unavailable;
          observed = await owned(ports.evidence.inspectOutcome(input, checkedCall(call)));
          active(call);
          if (failure(observed)) return observed;
          if (!sameJournalValue(observed, operation)) return denied;
          if (!journalOutcomeTransitionAllowedV1(current, operation)) return conflict;
          const next = parseTurnJournalV1("attempt", {
            ...current,
            version: current.version + 1,
            outcome: operation.outcome,
          });
          await updateAttempt(operation.attempt, next);
          await putOperation(operation.attempt, "outcome", operation.operationRef, operation, next);
          active(call);
          return { kind: "recorded", record: next };
        }),
      commitCancellation: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("commitCancellation", input, call);
          if (auth.kind !== "authorized") return auth;
          let observed = await owned(ports.evidence.inspectCancellation(input, checkedCall(call)));
          active(call);
          if (failure(observed)) return observed;
          const operation = parseTurnJournalV1("cancellation", observed);
          if (
            operation.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(operation.attempt))
          )
            return denied;
          const existing = await getOperation(
            operation.attempt,
            "cancellation",
            operation.operationRef,
          );
          if (existing) {
            if (
              existing.operationKind !== "cancellation" ||
              !sameJournalValue(existing.request, operation)
            )
              return conflict;
            return { kind: "existing", ...existing.record };
          }
          const previousCancellation = operationsFor(operation.attempt, "cancellation");
          if (previousCancellation.length) return conflict;
          const row = await getAttempt(operation.attempt);
          if (!row) return conflict;
          const current = row.record;
          if (["completed", "failed", "interrupted", "cancelled"].includes(current.outcome.kind))
            return { kind: "too-late" };
          if (
            current.version !== operation.expectedAttemptVersion ||
            current.version === Number.MAX_SAFE_INTEGER
          )
            return conflict;
          const owners = [
            data.owners.get(
              ownerKey(
                auth.installation.id,
                row.record.binding.identity.locator.channelInstallationRef,
                row.record.binding.identity.receipt.receiptRef,
              ),
            ),
          ].filter((v): v is JournalAdmissionOwnerV1 => v !== undefined);
          const owner = owners[0] && owners[0];
          if (
            !owner ||
            !("identity" in owner) ||
            owner.decision.kind !== "accepted" ||
            !sameJournalValue(owner.decision.attempt, operation.attempt) ||
            !sameJournalValue(owner.identity, current.binding.identity) ||
            !sameJournalValue(owner.expectedHead, current.binding.expectedHead) ||
            operation.originalPrincipalRef !== owner.identity.principalRef
          )
            return denied;
          observed = await owned(ports.evidence.inspectCancellation(input, checkedCall(call)));
          active(call);
          if (failure(observed)) return observed;
          if (!sameJournalValue(observed, operation)) return denied;
          const beforeDispatch = journalCancellationBeforeDispatchMatchesV1(current, operation);
          // Before-dispatch uncertainty is not proof of accepted, unstarted
          // work. Its original outcome owner must resolve it before cancellation.
          if (
            !beforeDispatch &&
            ("phase" in current ||
              ("stage" in current.outcome && current.outcome.stage === "before-dispatch"))
          )
            return conflict;
          if (!(await reservationHeld(operation.attempt))) return { kind: "too-late" };
          const outcome = beforeDispatch ? "cancelled-before-dispatch" : "requested";
          const next = parseTurnJournalV1("attempt", {
            ...current,
            version: current.version + 1,
            outcome: beforeDispatch
              ? {
                  kind: "cancelled",
                  stage: "before-dispatch",
                  evidenceRef: operation.operationRef,
                }
              : current.outcome,
          });
          await putOperation(operation.attempt, "cancellation", operation.operationRef, operation, {
            operation,
            outcome,
          });
          await updateAttempt(operation.attempt, next);
          active(call);
          return { kind: "recorded", operation, outcome };
        }),
      releaseReservation: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("releaseReservation", input, call);
          if (auth.kind !== "authorized") return auth;
          let observed = await owned(ports.evidence.inspectRelease(input, checkedCall(call)));
          active(call);
          if (failure(observed)) return observed;
          const observation = parseTurnJournalV1("releaseObservation", observed);
          if (
            observation.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(observation.attempt))
          )
            return denied;
          const existing = await getOperation(
            observation.attempt,
            "release",
            observation.releaseOperationRef,
          );
          if (existing)
            return sameJournalValue(existing.request, observation)
              ? { kind: "existing", releaseOperationRef: observation.releaseOperationRef }
              : conflict;
          const row = await getAttempt(observation.attempt);
          const current = row && row.record;
          if (!current) return { kind: "held" };
          observed = await owned(ports.evidence.inspectRelease(input, checkedCall(call)));
          active(call);
          if (failure(observed)) return observed;
          if (!sameJournalValue(observed, observation)) return denied;
          if (!journalReleaseMatchesV1(current, observation)) return conflict;
          if (
            !["completed", "failed", "interrupted", "cancelled", "outcome-unknown"].includes(
              current.outcome.kind,
            ) ||
            !(await reservationHeld(observation.attempt))
          )
            return { kind: "held" };
          await putOperation(
            observation.attempt,
            "release",
            observation.releaseOperationRef,
            observation,
            observation,
          );
          const removed = removeReservation(observation.attempt);
          if (!removed)
            throw new DependencyUnavailableError("The reservation owner changed during release.");
          active(call);
          return { kind: "released", releaseOperationRef: observation.releaseOperationRef };
        }),
      ...deliveryMethods(),
    };
  }

  async function insertDeliverySlot(operation: ExactDeliveryOperationV1) {
    parseTurnJournalV1("deliveryOperation", operation);
    retainEmptyDeliverySlot(operation);
  }
  function deliveryMethods(): Pick<
    TurnJournalUnitOfWorkV1,
    "reserveDelivery" | "recordDelivery" | "findDelivery"
  > {
    const slotRow = async (operation: ExactDeliveryOperationV1) => {
      const rows = [data.deliveries.get(deliveryKey(operation))].filter(
        (v): v is StoredDelivery => v !== undefined,
      );
      return rows[0];
    };
    const stateFor = async (operation: ExactDeliveryOperationV1): Promise<DeliveryStateV1> => {
      const slot = await slotRow(operation);
      if (slot && slot.operation.operationRef === operation.operationRef) {
        const record = slot;
        if (!sameJournalValue(record.operation, operation)) return conflict;
        return record.outcome
          ? { kind: "recorded", record: record.outcome }
          : { kind: "pending", operation };
      }
      const history = latestHistory(operation);
      if (!history[0]) return unavailable;
      const record = history[0];
      if (!sameJournalValue(record.operation, operation)) return conflict;
      return record.outcome
        ? { kind: "recorded", record: record.outcome }
        : { kind: "pending", operation };
    };
    const completedStatusPublished = async (
      attempt: AttemptRecordV1,
      prior: ExactDeliveryOperationV1,
      call: AuthorityCallV1,
    ): Promise<boolean> => {
      if ("phase" in attempt || !attempt.consumption || attempt.outcome.kind !== "completed")
        return false;
      const completed = await getOperation(
        attempt.binding.attempt,
        "completion",
        attempt.outcome.completionOperationRef,
      );
      active(call);
      if (!completed || completed.operationKind !== "completion") return false;
      const { request, record } = completed;
      const { checkpoint, head } = record;
      const expected = attempt.binding.expectedHead;
      const identity = attempt.binding.identity;
      if (
        request.operationRef !== attempt.outcome.completionOperationRef ||
        !sameJournalValue(request.attempt, attempt.binding.attempt) ||
        !sameJournalValue(record.operation, request) ||
        !sameJournalValue(checkpoint, attempt.outcome.checkpoint) ||
        !sameJournalValue(attemptValues(checkpoint), attemptValues(attempt.binding.attempt)) ||
        request.checkpointId !== checkpoint.checkpointId ||
        request.expectedCompletionSequence !== expected.completionSequence ||
        record.outcomeVersion !== request.expectedAttemptVersion + 1 ||
        record.outcomeVersion <= prior.outcomeVersion ||
        record.outcomeVersion > attempt.version ||
        checkpoint.workspaceBindingRef !== identity.workspace.bindingRef ||
        checkpoint.revisionRef !== identity.admittedRevisionRef ||
        checkpoint.admittedConfigurationDigest !== identity.admittedConfigurationDigest ||
        checkpoint.producingGatewayAssignmentRef !== identity.gatewayAssignment.id ||
        checkpoint.producingHarnessAssignmentRef !== identity.harnessAssignment.id ||
        checkpoint.parentCheckpointId !== expected.checkpointId ||
        !sameJournalValue(head.context, expected.context) ||
        head.creationRef !== expected.creationRef ||
        head.checkpointId !== checkpoint.checkpointId ||
        head.completionSequence !== checkpoint.completionSequence ||
        head.headVersion !== expected.headVersion + 1 ||
        head.completionSequence !== expected.completionSequence + 1 ||
        !sameJournalValue(record.pendingDelivery.attempt, attempt.binding.attempt) ||
        record.pendingDelivery.replyDestinationRef !== identity.replyDestinationRef ||
        record.pendingDelivery.replyBindingVersion !== identity.replyBindingVersion ||
        record.pendingDelivery.slot !== "completed-result" ||
        record.pendingDelivery.operation.kind !== "create" ||
        record.pendingDelivery.outcomeVersion !== record.outcomeVersion
      )
        return false;
      const current = await getHead(attempt.binding.attempt);
      active(call);
      // The immutable operation was atomically published with this exact head
      // and checkpoint. Later publications advance both counters together while
      // preserving the creation; they do not replace this historical evidence.
      return (
        current !== null &&
        sameJournalValue(current.head.context, head.context) &&
        current.head.creationRef === head.creationRef &&
        current.head.completionSequence >= head.completionSequence &&
        current.head.headVersion - head.headVersion ===
          current.head.completionSequence - head.completionSequence &&
        (current.head.completionSequence !== head.completionSequence ||
          (sameJournalValue(current.head, head) &&
            sameJournalValue(current.checkpoint, checkpoint)))
      );
    };
    return {
      async findDelivery(input, call) {
        const operation = parseTurnJournalV1("deliveryOperation", input);
        return read("findDelivery", operation, call, () => stateFor(operation));
      },
      reserveDelivery: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("reserveDelivery", input, call);
          if (auth.kind !== "authorized") return auth;
          let observed = await owned(ports.evidence.inspectDelivery(input, checkedCall(call)));
          active(call);
          if (failure(observed)) return observed;
          const operation = parseTurnJournalV1("deliveryOperation", observed);
          if (
            operation.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(operation.attempt))
          )
            return denied;
          let raw = await slotRow(operation);
          let slot = raw && raw;
          const sameOperation = slot && sameJournalValue(slot.operation, operation);
          const historical = latestHistory(operation);
          if (historical[0] && !sameOperation)
            return { kind: "existing", state: await stateFor(operation) };
          if (
            slot &&
            sameOperation &&
            slot.deliveryAttemptRef !== null &&
            (!slot.outcome ||
              slot.outcome.outcome.kind !== "definitive-no-effect" ||
              slot.outcome.outcome.retryClass !== "transient")
          )
            return { kind: "existing", state: await stateFor(operation) };
          const attemptRow = await getAttempt(operation.attempt);
          const attempt = attemptRow && attemptRow.record;
          if (
            !attempt ||
            operation.replyDestinationRef !== attempt.binding.identity.replyDestinationRef ||
            operation.replyBindingVersion !== attempt.binding.identity.replyBindingVersion ||
            operation.outcomeVersion !== attempt.version
          )
            return denied;
          if (
            operation.slot === "completed-result" &&
            (attempt.outcome.kind !== "completed" || !slot)
          )
            return conflict;
          if (operation.slot === "outcome-status") {
            const code = operation.statusNoticeCode;
            // Legacy absence is unclassified. This unit has no affirmative
            // no-intent producer for an unavailable-before-dispatch notice.
            if (
              code === undefined ||
              code === "unavailable-before-dispatch" ||
              (code === "resolved-completed"
                ? attempt.outcome.kind !== "completed"
                : code !== attempt.outcome.kind)
            )
              return denied;
          }
          if (operation.slot === "cancel-ack") {
            const cancelled = operationsFor(operation.attempt, "cancellation");
            if (!cancelled.length) return denied;
          }
          const update = operation.operation.kind === "update";
          if (slot && !sameOperation) {
            if (
              !update ||
              operation.slot !== "outcome-status" ||
              raw?.updateUsed !== false ||
              slot.operation.operation.kind !== "create" ||
              slot.operation.statusNoticeCode !== "outcome-unknown" ||
              !sameJournalValue(slot.operation.attempt, operation.attempt) ||
              slot.operation.replyDestinationRef !== operation.replyDestinationRef ||
              slot.operation.replyBindingVersion !== operation.replyBindingVersion ||
              operation.outcomeVersion <= slot.operation.outcomeVersion ||
              slot.outcome?.outcome.kind !== "delivered" ||
              operation.operation.kind !== "update" ||
              operation.operation.providerMessageRef !== slot.outcome.outcome.providerMessageRef
            )
              return conflict;
          } else if (update) return { kind: "existing", state: await stateFor(operation) };
          if (
            operation.slot === "outcome-status" &&
            operation.statusNoticeCode === "resolved-completed"
          ) {
            if (!slot || !(await completedStatusPublished(attempt, slot.operation, call)))
              return conflict;
            active(call);
          }
          const current = await authorize("reserveDelivery", input, call);
          if (current.kind !== "authorized") return current;
          observed = await owned(ports.evidence.inspectDelivery(input, checkedCall(call)));
          active(call);
          if (failure(observed)) return observed;
          if (!sameJournalValue(observed, operation)) return denied;
          if (!slot) {
            if (update) return conflict;
            await insertDeliverySlot(operation);
            raw = await slotRow(operation);
            slot = raw && raw;
          }
          if (!slot) throw new DependencyUnavailableError("The delivery slot is unavailable.");
          const now = nowMilliseconds();
          const episodeStartedAt = slot.episodeStartedAt ?? new Date(now).toISOString();
          if (
            now >= Date.parse(episodeStartedAt) + TURN_JOURNAL_LIMITS_V1.deliveryWindowMs ||
            (!update && slot.attemptNumber >= TURN_JOURNAL_LIMITS_V1.deliveryAttemptsPerSlot)
          )
            return { kind: "existing", state: await stateFor(slot.operation) };
          const attemptNumber = update ? 1 : slot.attemptNumber + 1;
          const deliveryAttemptRef = randomUUID();
          retainDeliveryHistory(
            Object.freeze({
              operation,
              deliveryAttemptRef,
              attemptNumber,
              episodeStartedAt,
              outcome: null,
              updateUsed: update,
            }),
          );
          data.deliveries.set(
            deliveryKey(operation),
            Object.freeze({
              operation,
              deliveryAttemptRef,
              attemptNumber: update ? slot.attemptNumber : attemptNumber,
              episodeStartedAt,
              outcome: null,
              updateUsed: update || raw?.updateUsed === true,
            }),
          );
          active(call);
          return {
            kind: "reserved",
            operation,
            deliveryAttemptRef,
            attemptNumber,
            episodeStartedAt,
          };
        }),
      recordDelivery: (input, call) =>
        mutate(call, async () => {
          const outcome = parseTurnJournalV1("delivery", input);
          const auth = await authorize("recordDelivery", outcome, call);
          if (auth.kind !== "authorized") return auth;
          const operation = outcome.operation;
          if (
            operation.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(operation.attempt))
          )
            return denied;
          const history = [...data.deliveryHistory.values()].filter(
            (h) =>
              h.operation.attempt.installationRef === operation.attempt.installationRef &&
              h.deliveryAttemptRef === outcome.deliveryAttemptRef,
          );
          if (!history[0]) return conflict;
          const reserved = history[0];
          if (!sameJournalValue(reserved.operation, operation)) return conflict;
          if (reserved.outcome)
            return sameJournalValue(reserved.outcome, outcome)
              ? { kind: "existing", record: reserved.outcome }
              : conflict;
          const raw = await slotRow(operation);
          if (
            !raw ||
            raw.deliveryAttemptRef !== outcome.deliveryAttemptRef ||
            !sameJournalValue(raw.operation, operation)
          )
            return conflict;
          const current = await authorize("recordDelivery", outcome, call);
          if (current.kind !== "authorized") return current;
          data.deliveryHistory.set(
            historyKey(operation, outcome.deliveryAttemptRef),
            Object.freeze({ ...reserved, outcome }),
          );
          data.deliveries.set(deliveryKey(operation), Object.freeze({ ...raw, outcome }));
          active(call);
          return { kind: "recorded", record: outcome };
        }),
    };
  }
}

/** The original state owner runs this synchronously before publication, including
 * transactions that only change another repository. This mirrors the retained
 * journal references that PostgreSQL protects with foreign keys/deferred checks. */
export function assertMemoryTurnJournalSnapshot(
  snapshot: MemoryTurnJournalSnapshot,
  owner: Readonly<{
    installationId: string | undefined;
    hasAgent(attempt: ContextKeyV1): boolean;
    hasChannel(channel: string): boolean;
  }>,
): void {
  const data = recordsOf(snapshot);
  const invalid = (): never => {
    throw new ScopeViolationError("The memory journal owner invariant failed.");
  };
  const ownsAttempt = (attempt: ContextKeyV1) =>
    attempt.installationRef === owner.installationId && owner.hasAgent(attempt);
  const completions = new Map<string, Extract<StoredOperation, { operationKind: "completion" }>>();
  const released = new Set<string>();
  const admissionHeads = new Set<string>();
  for (const operation of data.operations.values()) {
    const attempt = operation.request.attempt;
    if (!ownsAttempt(attempt) || !data.attempts.has(attemptKey(attempt))) invalid();
    if (operation.operationKind === "release") released.add(attemptKey(attempt));
    if (operation.operationKind === "completion") {
      const key = contextKey(attempt),
        prior = completions.get(key);
      if (!prior || prior.record.head.completionSequence < operation.record.head.completionSequence)
        completions.set(key, operation);
      const current = data.attempts.get(attemptKey(attempt))!.record;
      if (
        current.outcome.kind !== "completed" ||
        current.outcome.completionOperationRef !== operation.request.operationRef ||
        !sameJournalValue(current.outcome.checkpoint, operation.record.checkpoint) ||
        current.version !== operation.record.outcomeVersion
      )
        invalid();
    }
  }
  for (const [key, value] of data.owners) {
    const installation =
      "intake" in value
        ? value.intake.installationRef
        : "identity" in value
          ? value.identity.locator.installationRef
          : value.envelope.installationRef;
    const channel =
      "intake" in value
        ? value.intake.channelInstallationRef
        : "identity" in value
          ? value.identity.locator.channelInstallationRef
          : value.envelope.channelInstallationRef;
    const receipt = ownerReceipt(value);
    if (
      installation !== owner.installationId ||
      !owner.hasChannel(channel) ||
      key !== ownerKey(installation, channel, receipt.receiptRef) ||
      data.ownerKeys.get(keyOf(installation, channel, "event", receipt.eventKey)) !== key ||
      (receipt.logicalMessageKey !== null &&
        data.ownerKeys.get(
          keyOf(installation, channel, "logical-message", receipt.logicalMessageKey),
        ) !== key)
    )
      invalid();
    const anchor = data.anchors.get(keyOf(installation, channel, receipt.eventKey));
    if (!anchor || anchor.ownerKey !== key) invalid();
    if ("identity" in value && value.decision.kind === "accepted") {
      admissionHeads.add(canonicalJournalValue(value.expectedHead));
      const attempt = value.decision.attempt,
        stored = data.attempts.get(attemptKey(attempt));
      if (
        !stored ||
        !sameJournalValue(stored.record.binding.identity, value.identity) ||
        !sameJournalValue(stored.record.binding.expectedHead, value.expectedHead) ||
        !data.heads.has(contextKey(attempt)) ||
        (!sameJournalValue(data.reservations.get(agentKey(attempt)) ?? null, attempt) &&
          !released.has(attemptKey(attempt)))
      )
        invalid();
    }
  }
  for (const link of [...data.incomingLinks.values(), ...data.nonTurnLinks.values()]) {
    const intake = "locator" in link ? link.locator : link.intake;
    if (
      intake.installationRef !== owner.installationId ||
      !owner.hasChannel(intake.channelInstallationRef) ||
      !data.anchors.has(
        keyOf(intake.installationRef, intake.channelInstallationRef, intake.eventKey),
      )
    )
      invalid();
    for (const ref of link.originalReceiptRefs)
      if (!data.owners.has(ownerKey(intake.installationRef, intake.channelInstallationRef, ref)))
        invalid();
    if (
      link.originalReceiptRefs.length === 0 &&
      (!("intake" in link) ||
        !sameJournalValue(
          data.owners.get(
            ownerKey(intake.installationRef, intake.channelInstallationRef, link.receiptRef),
          ) ?? null,
          link,
        ))
    )
      invalid();
  }
  for (const stored of data.attempts.values()) {
    const record = stored.record,
      attempt = record.binding.attempt,
      identity = record.binding.identity;
    const original = data.owners.get(
      ownerKey(
        attempt.installationRef,
        identity.locator.channelInstallationRef,
        identity.receipt.receiptRef,
      ),
    );
    if (
      !ownsAttempt(attempt) ||
      !original ||
      !("identity" in original) ||
      original.decision.kind !== "accepted" ||
      !sameJournalValue(original.decision.attempt, attempt) ||
      !data.heads.has(contextKey(attempt)) ||
      !Number.isFinite(Date.parse(stored.firstReceivedAt))
    )
      invalid();
  }
  for (const [key, attempt] of data.reservations)
    if (
      key !== agentKey(attempt) ||
      !ownsAttempt(attempt) ||
      !data.attempts.has(attemptKey(attempt))
    )
      invalid();
  for (const [key, head] of data.heads) {
    if (key !== contextKey(head.head.context) || !ownsAttempt(head.head.context)) invalid();
    if (head.head.completionSequence === 0) {
      if (
        head.checkpoint !== null ||
        head.head.headVersion !== 1 ||
        !admissionHeads.has(canonicalJournalValue(head.head))
      )
        invalid();
    } else {
      const completed = completions.get(key);
      if (
        !completed ||
        !sameJournalValue(completed.record.head, head.head) ||
        !sameJournalValue(completed.record.checkpoint, head.checkpoint)
      )
        invalid();
    }
  }
  for (const slot of data.deliveries.values()) {
    if (!data.attempts.has(attemptKey(slot.operation.attempt))) invalid();
    if (slot.deliveryAttemptRef !== null) {
      const historical = data.deliveryHistory.get(
        historyKey(slot.operation, slot.deliveryAttemptRef),
      );
      if (
        !historical ||
        !sameJournalValue(historical.operation, slot.operation) ||
        !sameJournalValue(historical.outcome, slot.outcome) ||
        historical.episodeStartedAt !== slot.episodeStartedAt
      )
        invalid();
    }
  }
  for (const historical of data.deliveryHistory.values())
    if (!data.attempts.has(attemptKey(historical.operation.attempt))) invalid();
}
