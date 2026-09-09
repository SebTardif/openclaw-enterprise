import type {
  HostedChannelAdmissionDependenciesV1,
  HostedChannelAdmissionDecisionV1,
  HostedChannelEnvelopeV1,
  HostedChannelIntakeLocatorV1,
  HostedChannelReceiptV1,
} from "openclaw/plugin-sdk/channel-inbound";
import type {
  ContextKeyV1,
  ExactAttemptV1,
  CheckpointRefV1,
  VerifiedCheckpointV1,
} from "./completed-context-v1.ts";
import type { AuthorityCallV1, AssignmentRefV1 } from "./runtime-authority-v1.ts";
import type { StoreBindingRefV1 } from "./completed-state-v1.ts";
import type { WorkspaceReservationRefV1 } from "./workspace-reservation-v1.ts";

/** Versioned repository definition. OCC is the sole durable journal owner. */
export const TURN_JOURNAL_VERSION_V1 = "turn-journal-v1" as const;
export const TURN_JOURNAL_LIMITS_V1 = Object.freeze({
  valueBytes: 65_536,
  referenceBytes: 1_024,
  referenceCharacters: 512,
  nestingDepth: 16,
  pendingReceiptsPerInstallation: 32,
  intakeDeadlineMs: 30_000,
  activeReservationsPerAgent: 1,
  executableQueue: 0,
  maximumTurnMs: 900_000,
  startWindowMs: 5_000,
  deliveryAttemptsPerSlot: 3,
  deliveryWindowMs: 120_000,
  knownIdStatusUpdates: 1,
});

declare const admissionProvenance: unique symbol;
declare const dispatchProvenance: unique symbol;
declare const consumptionProvenance: unique symbol;
declare const completionProvenance: unique symbol;
declare const releaseProvenance: unique symbol;
declare const outcomeProvenance: unique symbol;
declare const deliveryProvenance: unique symbol;
declare const cancellationProvenance: unique symbol;
declare const pendingClaim: unique symbol;

export type JournalReferenceV1 = string;
export type JournalDigestV1 = string;
export type JournalSequenceV1 = number;
export type JournalInstantV1 = string;
export type JournalUnavailableV1 = Readonly<{ kind: "unavailable" }>;
export type JournalConflictV1 = Readonly<{ kind: "conflict" }>;
export type JournalDeniedV1 = Readonly<{ kind: "denied" }>;
export type JournalAbsentV1 = Readonly<{ kind: "absent" }>;

/** Non-secret lookup keys. Lookup is currently authorized and never returns a permit. */
export type ExactEventOrLogicalKeyV1 =
  | Readonly<{
      schemaVersion: 1;
      kind: "event";
      installationRef: string;
      channelInstallationRef: string;
      eventKey: JournalDigestV1;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "logical-message";
      installationRef: string;
      channelInstallationRef: string;
      logicalMessageKey: JournalDigestV1;
    }>;

export type ExpectedCompletionHeadV1 = Readonly<{
  context: ContextKeyV1;
  headVersion: number;
  completionSequence: number;
  checkpointId: string | null;
  creationRef: string;
}>;
export type CompletionHeadV1 =
  | Readonly<{ kind: "new-context"; head: ExpectedCompletionHeadV1 }>
  | Readonly<{ kind: "completed"; head: ExpectedCompletionHeadV1; checkpoint: CheckpointRefV1 }>
  | Readonly<{ kind: "unavailable"; reason: "unresolved-work" | "retired" | "store-unavailable" }>;

/** Immutable attribution is historical data. It never restores a grant or current authority. */
export type JournalAdmissionIdentityV1 = Readonly<{
  locator: HostedChannelIntakeLocatorV1;
  receipt: HostedChannelReceiptV1;
  context: ContextKeyV1;
  principalRef: string;
  principalVersion: number;
  externalIdentityBindingRef: string;
  providerSubjectRef: string;
  routeKey: JournalDigestV1;
  conversationBindingVersion: number;
  routingPolicyVersion: number;
  commonGrantRef: string;
  commonGrantVersion: number;
  workspace: StoreBindingRefV1;
  audiencePolicyRef: string;
  audienceEvidenceRef: string;
  audienceVersion: number;
  replyDestinationRef: string;
  replyBindingVersion: number;
  admittedRevisionRef: string;
  admittedConfigurationDigest: JournalDigestV1;
  gatewayAssignment: AssignmentRefV1;
  harnessAssignment: AssignmentRefV1;
  harnessRuntimeGeneration: number;
  contentRef: string;
}>;
export type JournalAdmissionDecisionV1 =
  | Readonly<{ kind: "accepted"; attempt: ExactAttemptV1 }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "denied"; reason: "unavailable" | "not-current" | "unsupported" | "conflict" }>
  | Readonly<{ kind: "ignored"; reason: "not-addressed" | "non-turn" }>;
export type AdmissionRecordV1 = Readonly<{
  schemaVersion: 1;
  identity: JournalAdmissionIdentityV1;
  decision: JournalAdmissionDecisionV1;
  expectedHead: ExpectedCompletionHeadV1;
  decisionRef: string;
  auditIntentRef: string;
  decidedAt: JournalInstantV1;
}>;
export type AdmissionStateV1 =
  | Readonly<{ kind: "found"; record: AdmissionRecordV1 }>
  | Readonly<{ kind: "found-rejected"; record: RejectedAdmissionRecordV1 }>
  | Readonly<{ kind: "found-non-turn"; receipt: NonTurnReceiptV1 }>
  | JournalAbsentV1
  | JournalDeniedV1
  | JournalUnavailableV1;

/** Every submitted event is durably linked, including a logical twin or conflict.
 * If both keys resolve different owners, both originals survive and the incoming
 * link records the conflict. An old owner's receipt alone never proves this link.
 */
export type IncomingAdmissionLinkV1 = Readonly<{
  incomingLinkRef: string;
  incomingIdentityDigest: JournalDigestV1;
  locator: HostedChannelIntakeLocatorV1;
  incomingEventDigest: JournalDigestV1;
  incomingContentDigest: JournalDigestV1;
  originalReceiptRefs: readonly string[];
  disposition: "original" | "duplicate" | "conflict";
  auditIntentRef: string;
}>;
export type AdmissionResultV1 =
  | Readonly<{
      kind: "non-turn-owned";
      original: NonTurnReceiptV1;
      incomingLink: IncomingAdmissionLinkV1;
    }>
  | Readonly<{
      kind: "rejected-existing";
      record: RejectedAdmissionRecordV1;
      incomingLink: IncomingAdmissionLinkV1;
    }>
  | Readonly<{
      kind: "recorded";
      record: AdmissionRecordV1;
      incomingLink: IncomingAdmissionLinkV1;
      duplicate: boolean;
    }>
  | Readonly<{
      kind: "conflict";
      incomingLink: IncomingAdmissionLinkV1;
      originalReceipt: HostedChannelReceiptV1;
    }>
  | JournalDeniedV1
  | JournalUnavailableV1;

/** Opaque in-process handle, issued only after real channel verification and
 * exact current original-human/target policy. No decoder or public constructor
 * can create it. The repository MUST inspect with its configured provenance
 * owner on every use; a TypeScript brand or serializable boolean is insufficient.
 */
export interface VerifiedAdmissionInputV1 {
  readonly [admissionProvenance]: true;
}
export type VerifiedAdmissionObservationV1 = Readonly<{
  envelope: HostedChannelEnvelopeV1;
  identity: JournalAdmissionIdentityV1;
  expectedHead: ExpectedCompletionHeadV1;
  reservation: WorkspaceReservationRefV1;
  attempt: ExactAttemptV1;
  decisionRef: string;
  auditIntentRef: string;
}>;
export interface JournalAdmissionProvenanceV1<Native> {
  /** The actual supported SDK verifier; callers cannot supply its output as proof. */
  readonly verify: HostedChannelAdmissionDependenciesV1<Native>["verify"];
  authenticate(
    native: Native,
    call: AuthorityCallV1,
  ): Promise<VerifiedAdmissionInputV1 | JournalDeniedV1 | JournalUnavailableV1>;
  /** Reject foreign, copied, expired, revoked and wrong-recipient handles. Recheck
   * selected policy/current original actor and exact target in the transaction.
   */
  inspect(
    handle: VerifiedAdmissionInputV1,
    call: AuthorityCallV1,
  ): Promise<VerifiedAdmissionObservationV1 | JournalDeniedV1 | JournalUnavailableV1>;
}

/** Exact immutable correlation, never an initiating or running capability. */
export type ExactSelectedExecutionV1 = Readonly<{
  attempt: ExactAttemptV1;
  dispatchOperationRef: string;
  consumption: ExactConsumptionOperationV1;
  executionRef: string;
  recipientRef: string;
}>;
export type PreCommitDispatchClockV1 = Readonly<{
  kind: "pre-commit-monotonic-v1";
  clockSourceRef: string;
  clockEpochRef: string;
  anchorAtMs: number;
  deadlineAtMs: number;
}>;
/** Historical data only; cannot establish a new active clock owner. */
export type HistoricalDispatchClockV1 = Readonly<{
  clockSourceRef: string;
  clockEpochRef: string;
  committedAtMs: number;
  deadlineAtMs: number;
}>;
export type JournalExecutionSelectionV1 = Readonly<{
  execution: ExactSelectedExecutionV1;
  operationRef: string;
  operationDigest: string;
  executionLimitRef: string;
  executionLimitVersion: number;
  maximumExecutionMs: number;
}>;
export type JournalExecutionIntentV1 = JournalExecutionSelectionV1 &
  Readonly<{
    /** Genuine pre-commit lower-bound anchor from the original dispatch writer.
     * A known COMMIT transfers ownership; it does not turn this into a measured
     * physical COMMIT timestamp. Native readiness never renews the ceiling. */
    dispatchClock: PreCommitDispatchClockV1 | HistoricalDispatchClockV1;
  }>;
export type JournalExecutionStartV1 = Readonly<{
  intent: JournalExecutionIntentV1;
  operationRef: string;
  operationDigest: string;
  nativeExecutionRef: string;
  nativeIncarnationRef: string;
  nativeReservationRef: string;
  nativeSessionRef: string;
  nativeTurnRef: string;
  acceptanceEvidenceRef: string;
  clockSourceRef: string;
  clockEpochRef: string;
  startedAtMs: number;
  deadlineAtMs: number;
  /** Original dispatch ceiling mapped into THIS native epoch by its actual owner. */
  dispatchDeadlineAtMs: number;
  clockCorrespondenceEvidenceRef: string;
}>;
export type ExactExecutionInterruptionV1 = Readonly<{
  start: JournalExecutionStartV1;
  operationRef: string;
  operationDigest: string;
  responsibilityRef: string;
  responsibilityVersion: number;
}>;
declare const executionStartProvenance: unique symbol;
declare const executionInterruptionProvenance: unique symbol;
export interface VerifiedExecutionStartV1 {
  readonly [executionStartProvenance]: true;
}
export interface VerifiedExecutionInterruptionV1 {
  readonly [executionInterruptionProvenance]: true;
}
export type SelectedExecutionStateV1 =
  | Readonly<{ kind: "intent-only"; intent: JournalExecutionIntentV1 }>
  | Readonly<{ kind: "started"; start: JournalExecutionStartV1 }>
  | JournalAbsentV1
  | JournalDeniedV1
  | JournalUnavailableV1;
export type ExecutionInterruptionStateV1 =
  | Readonly<{ kind: "found"; interruption: ExactExecutionInterruptionV1 }>
  | JournalAbsentV1
  | JournalDeniedV1
  | JournalUnavailableV1;
export type ExecutionRetentionResultV1<T> =
  | Readonly<{ kind: "recorded" | "existing"; record: T }>
  | JournalConflictV1
  | JournalDeniedV1
  | JournalUnavailableV1;
export interface TurnJournalReadV1 {
  findExecution(
    input: ExactSelectedExecutionV1,
    call: AuthorityCallV1,
  ): Promise<SelectedExecutionStateV1>;
  findExecutionInterruption(
    input: ExactExecutionInterruptionV1,
    call: AuthorityCallV1,
  ): Promise<ExecutionInterruptionStateV1>;
}
export interface TurnJournalUnitOfWorkV1 {
  retainExecutionStart(
    input: VerifiedExecutionStartV1,
    call: AuthorityCallV1,
  ): Promise<ExecutionRetentionResultV1<JournalExecutionStartV1>>;
  retainExecutionInterruption(
    input: VerifiedExecutionInterruptionV1,
    call: AuthorityCallV1,
  ): Promise<ExecutionRetentionResultV1<ExactExecutionInterruptionV1>>;
}

/** Immutable admission facts. This projection contains no dispatch authority,
 * dispatch operation or borrowed request/turn expiry. */
export type JournalCommonAttemptBindingV1 = Readonly<{
  attempt: ExactAttemptV1;
  identity: JournalAdmissionIdentityV1;
  reservation: WorkspaceReservationRefV1;
  expectedHead: ExpectedCompletionHeadV1;
}>;
/** Supplied only by actual dispatch provenance. The common phase never fills
 * these fields from admission decision IDs, RPC references or deadlines. */
export type JournalAttemptBindingV1 = JournalCommonAttemptBindingV1 &
  Readonly<{
    dispatchOperationRef: string;
    authorityDecisionRef: string;
    expiresAt: JournalInstantV1;
  }>;
export type AttemptOutcomeV1 =
  | Readonly<{ kind: "accepted-undispatched" }>
  | Readonly<{ kind: "dispatch-intent"; dispatchOperationRef: string }>
  | Readonly<{ kind: "consumed"; consumptionOperationRef: string; consumedAt: JournalInstantV1 }>
  | Readonly<{ kind: "running"; nativeSessionRef: string; nativeTurnRef: string }>
  | Readonly<{ kind: "completed"; checkpoint: CheckpointRefV1; completionOperationRef: string }>
  | Readonly<{
      kind: "failed" | "interrupted" | "outcome-unknown" | "cancelled";
      stage: "before-dispatch" | "dispatch" | "execution" | "checkpoint";
      evidenceRef: string;
    }>;
export type AdmittedUndispatchedOutcomeV1 =
  | Readonly<{ kind: "accepted-undispatched" }>
  | Readonly<{
      kind: "failed" | "interrupted" | "outcome-unknown" | "cancelled";
      stage: "before-dispatch";
      evidenceRef: string;
    }>;
/** Canonical committed ownership before any dispatch binding exists. Terminal
 * outcomes keep the same common binding and reservation until trusted release. */
export type AdmittedUndispatchedAttemptRecordV1 = Readonly<{
  phase: "admitted-undispatched";
  binding: JournalCommonAttemptBindingV1;
  version: number;
  consumption: null;
  outcome: AdmittedUndispatchedOutcomeV1;
}>;
/** Existing full-binding wire shape is retained for genuine dispatch evidence.
 * Early authorization may precede intent, but is never required at admission. */
export type DispatchBoundAttemptRecordV1 = Readonly<{
  binding: JournalAttemptBindingV1;
  version: number;
  /** Immutable consumption survives running, cancellation and outcome uncertainty. */
  consumption: Readonly<{
    operation: ExactConsumptionOperationV1;
    consumedAt: JournalInstantV1;
  }> | null;
  outcome: AttemptOutcomeV1;
}>;
export type AttemptRecordV1 = AdmittedUndispatchedAttemptRecordV1 | DispatchBoundAttemptRecordV1;
export type AttemptStateV1 =
  | Readonly<{ kind: "found"; record: AttemptRecordV1 }>
  | JournalAbsentV1
  | JournalDeniedV1
  | JournalUnavailableV1;
export interface AuthorizedDispatchV1 {
  readonly [dispatchProvenance]: true;
}
export interface VerifiedConsumptionV1 {
  readonly [consumptionProvenance]: true;
}
export interface VerifiedCompletionPublicationV1 {
  readonly [completionProvenance]: true;
}
export interface VerifiedNoMutatorReleaseV1 {
  readonly [releaseProvenance]: true;
}
export interface VerifiedOutcomeV1 {
  readonly [outcomeProvenance]: true;
}
export interface VerifiedDeliveryV1 {
  readonly [deliveryProvenance]: true;
}
export interface VerifiedCancellationV1 {
  readonly [cancellationProvenance]: true;
}

export type ExactConsumptionOperationV1 = Readonly<{
  schemaVersion: 1;
  attempt: ExactAttemptV1;
  operationRef: string;
  claimantRef: string;
  requestDigest: JournalDigestV1;
}>;
/** Transaction-local claim. There is deliberately no method capable of starting. */
export interface PendingInitiationClaimV1 {
  readonly [pendingClaim]: true;
  readonly operation: ExactConsumptionOperationV1;
}
export type DispatchIntentResultV1 =
  | Readonly<{
      kind: "recorded";
      record: DispatchBoundAttemptRecordV1 &
        Readonly<{
          consumption: null;
          outcome: Extract<AttemptOutcomeV1, { kind: "dispatch-intent" }>;
        }>;
    }>
  /** An existing result retains actual intent or later progress; the result
   * codec excludes accepted and before-dispatch outcomes despite early authority. */
  | Readonly<{ kind: "existing"; record: DispatchBoundAttemptRecordV1 }>
  | JournalConflictV1
  | JournalDeniedV1
  | JournalUnavailableV1;
export type ConsumptionResultV1 =
  | Readonly<{ kind: "claim-pending"; claim: PendingInitiationClaimV1 }>
  | Readonly<{ kind: "already-consumed"; operation: ExactConsumptionOperationV1 }>
  | JournalConflictV1
  | JournalDeniedV1
  | JournalUnavailableV1;

export type ExactCheckpointAllocationV1 = Readonly<{
  schemaVersion: 1;
  attempt: ExactAttemptV1;
  operationRef: string;
  checkpointId: string;
  expectedHead: ExpectedCompletionHeadV1;
}>;
export type CheckpointAllocationResultV1 =
  | Readonly<{ kind: "allocated" | "existing"; allocation: ExactCheckpointAllocationV1 }>
  | JournalConflictV1
  | JournalDeniedV1
  | JournalUnavailableV1;
export type ExactCompletionOperationV1 = Readonly<{
  schemaVersion: 1;
  attempt: ExactAttemptV1;
  operationRef: string;
  checkpointId: string;
  expectedCompletionSequence: number;
  expectedAttemptVersion: number;
  requestDigest: JournalDigestV1;
}>;
export type JournalCompletionObservationV1 = Readonly<{
  operation: ExactCompletionOperationV1;
  allocation: ExactCheckpointAllocationV1;
  canonical: VerifiedCheckpointV1;
  nativeTerminalEvidenceRef: string;
  workspaceCompletionRef: string;
  noMutatorEvidenceRef: string;
  gatewayAssignment: AssignmentRefV1;
  harnessAssignment: AssignmentRefV1;
  reservation: WorkspaceReservationRefV1;
  pendingDelivery: ExactDeliveryOperationV1;
}>;
export type CompletionRecordV1 = Readonly<{
  operation: ExactCompletionOperationV1;
  checkpoint: CheckpointRefV1;
  head: ExpectedCompletionHeadV1;
  outcomeVersion: number;
  pendingDelivery: ExactDeliveryOperationV1;
}>;
export type CompletionStateV1 =
  | Readonly<{ kind: "published"; record: CompletionRecordV1 }>
  | JournalAbsentV1
  | JournalConflictV1
  | JournalDeniedV1
  | JournalUnavailableV1;
export type CompletionPublicationResultV1 =
  | Readonly<{ kind: "published" | "existing"; record: CompletionRecordV1 }>
  | JournalConflictV1
  | JournalDeniedV1
  | JournalUnavailableV1;

/** Protected evidence owner must cover the closed inventory of mutators and
 * unresolved creates/restores, exact store versions and original assignments.
 * Reply success, lease expiry, timeout, a route seal or caller's empty list cannot
 * create this observation. Any unknown owner keeps the reservation held.
 */
export type JournalReleaseObservationV1 = Readonly<{
  attempt: ExactAttemptV1;
  reservation: WorkspaceReservationRefV1;
  workspace: StoreBindingRefV1;
  releaseOperationRef: string;
  noMutatorEvidenceRef: string;
  closedOwnerInventoryRef: string;
  closedOwnerInventoryVersion: number;
  closedOwnerInventoryDigest: JournalDigestV1;
  expectedAttemptVersion: number;
}>;
export type ReservationReleaseResultV1 =
  | Readonly<{ kind: "released" | "existing"; releaseOperationRef: string }>
  | Readonly<{ kind: "held" }>
  | JournalConflictV1
  | JournalDeniedV1
  | JournalUnavailableV1;

export type ExactOutcomeOperationV1 = Readonly<{
  schemaVersion: 1;
  attempt: ExactAttemptV1;
  operationRef: string;
  expectedAttemptVersion: number;
  outcome: Exclude<
    AttemptOutcomeV1,
    { kind: "accepted-undispatched" | "dispatch-intent" | "consumed" | "completed" }
  >;
  requestDigest: JournalDigestV1;
}>;
export type OutcomeResultV1 =
  | Readonly<{ kind: "recorded" | "existing"; record: AttemptRecordV1 }>
  | JournalConflictV1
  | JournalDeniedV1
  | JournalUnavailableV1;
export type ExactCancellationOperationV1 = Readonly<{
  schemaVersion: 1;
  attempt: ExactAttemptV1;
  operationRef: string;
  requesterPrincipalRef: string;
  originalPrincipalRef: string;
  expectedAttemptVersion: number;
  requestDigest: JournalDigestV1;
}>;
export type CancellationResultV1 =
  | Readonly<{
      kind: "recorded" | "existing";
      operation: ExactCancellationOperationV1;
      outcome: "requested" | "cancelled-before-dispatch";
    }>
  | Readonly<{ kind: "too-late" }>
  | JournalConflictV1
  | JournalDeniedV1
  | JournalUnavailableV1;

export type ExactDeliveryOperationV1 = Readonly<{
  schemaVersion: 1;
  attempt: ExactAttemptV1;
  operationRef: string;
  outputRef: string;
  outputDigest: JournalDigestV1;
  outcomeVersion: number;
  slot: "completed-result" | "outcome-status" | "cancel-ack";
  /** Immutable fixed-notice classification resolved by the original delivery
   * provenance owner and checked against canonical outcome at reservation.
   * Absent legacy classification is unclassified, never proof of an unknown
   * notice. New status reservations require it; decoding grants no authority.
   */
  statusNoticeCode?:
    | "failed"
    | "interrupted"
    | "cancelled"
    | "outcome-unknown"
    | "unavailable-before-dispatch"
    | "resolved-completed";
  replyDestinationRef: string;
  replyBindingVersion: number;
  operation:
    Readonly<{ kind: "create" }> | Readonly<{ kind: "update"; providerMessageRef: string }>;
}>;
export type ExactDeliveryOutcomeV1 = Readonly<{
  operation: ExactDeliveryOperationV1;
  deliveryAttemptRef: string;
  outcome:
    | Readonly<{ kind: "delivered"; providerMessageRef: string }>
    | Readonly<{ kind: "definitive-no-effect"; retryClass: "transient" | "permanent" }>
    | Readonly<{ kind: "delivery-unknown" }>
    | Readonly<{ kind: "suppressed"; reason: "not-current" | "unsupported" | "slot-unavailable" }>;
}>;
export type DeliveryStateV1 =
  | Readonly<{ kind: "recorded" | "existing"; record: ExactDeliveryOutcomeV1 }>
  | Readonly<{ kind: "pending"; operation: ExactDeliveryOperationV1 }>
  | JournalConflictV1
  | JournalDeniedV1
  | JournalUnavailableV1;
export type DeliveryReservationResultV1 =
  | Readonly<{
      kind: "reserved";
      operation: ExactDeliveryOperationV1;
      deliveryAttemptRef: string;
      attemptNumber: number;
      episodeStartedAt: JournalInstantV1;
    }>
  | Readonly<{ kind: "existing"; state: DeliveryStateV1 }>
  | JournalConflictV1
  | JournalDeniedV1
  | JournalUnavailableV1;

/** The actual accepting repository authenticates the independent service, checks
 * its recipient/scope and the selected provenance owner on every mutation.
 * Wire lookups never grant operation authority. Required checks and audit intents
 * participate in the SAME outer OCC transaction and exact record locks/CAS.
 */
export interface TurnJournalReadV1 {
  findAdmission(input: ExactEventOrLogicalKeyV1, call: AuthorityCallV1): Promise<AdmissionStateV1>;
  findAttempt(input: ExactAttemptV1, call: AuthorityCallV1): Promise<AttemptStateV1>;
  findCompletion(
    input: ExactCompletionOperationV1,
    call: AuthorityCallV1,
  ): Promise<CompletionStateV1>;
  readHead(input: ContextKeyV1, call: AuthorityCallV1): Promise<CompletionHeadV1>;
  findDelivery(input: ExactDeliveryOperationV1, call: AuthorityCallV1): Promise<DeliveryStateV1>;
}
/** Status-only exact operation readback. Absence or uncertainty never retries a
 * mutation, creates a new checkpoint ID, requests cancellation or releases a gate.
 */
export type CheckpointAllocationStateV1 =
  | Readonly<{ kind: "found"; allocation: ExactCheckpointAllocationV1 }>
  | JournalAbsentV1
  | JournalDeniedV1
  | JournalUnavailableV1;
export type CancellationStateV1 =
  | Readonly<{
      kind: "found";
      operation: ExactCancellationOperationV1;
      outcome: "requested" | "cancelled-before-dispatch";
    }>
  | JournalAbsentV1
  | JournalDeniedV1
  | JournalUnavailableV1;
export type ReservationReleaseStateV1 =
  | Readonly<{ kind: "released"; observation: JournalReleaseObservationV1 }>
  | JournalAbsentV1
  | JournalDeniedV1
  | JournalUnavailableV1;
export interface TurnJournalReadV1 {
  findCheckpointAllocation(
    input: ExactCheckpointAllocationV1,
    call: AuthorityCallV1,
  ): Promise<CheckpointAllocationStateV1>;
  findCancellation(
    input: ExactCancellationOperationV1,
    call: AuthorityCallV1,
  ): Promise<CancellationStateV1>;
  findRelease(
    input: JournalReleaseObservationV1,
    call: AuthorityCallV1,
  ): Promise<ReservationReleaseStateV1>;
}

export interface TurnJournalUnitOfWorkV1 extends TurnJournalReadV1 {
  /** All successes remain provisional until outer commit; duplicate BEFORE busy. */
  admit(input: VerifiedAdmissionInputV1, call: AuthorityCallV1): Promise<AdmissionResultV1>;
  recordDispatchIntent(
    input: AuthorizedDispatchV1,
    call: AuthorityCallV1,
  ): Promise<DispatchIntentResultV1>;
  consumeAttempt(input: VerifiedConsumptionV1, call: AuthorityCallV1): Promise<ConsumptionResultV1>;
  allocateCheckpoint(
    input: ExactCheckpointAllocationV1,
    call: AuthorityCallV1,
  ): Promise<CheckpointAllocationResultV1>;
  publishCompleted(
    input: VerifiedCompletionPublicationV1,
    call: AuthorityCallV1,
  ): Promise<CompletionPublicationResultV1>;
  releaseReservation(
    input: VerifiedNoMutatorReleaseV1,
    call: AuthorityCallV1,
  ): Promise<ReservationReleaseResultV1>;
  recordOutcome(input: VerifiedOutcomeV1, call: AuthorityCallV1): Promise<OutcomeResultV1>;
  commitCancellation(
    input: VerifiedCancellationV1,
    call: AuthorityCallV1,
  ): Promise<CancellationResultV1>;
  reserveDelivery(
    input: VerifiedDeliveryV1,
    call: AuthorityCallV1,
  ): Promise<DeliveryReservationResultV1>;
  recordDelivery(input: ExactDeliveryOutcomeV1, call: AuthorityCallV1): Promise<DeliveryStateV1>;
}

export type JournalCommitResultV1<T> =
  | Readonly<{ kind: "committed"; value: T }>
  | Readonly<{ kind: "commit-unknown"; transactionRef: string }>
  | JournalUnavailableV1;
/** Map read/transact to PlatformStateStore, never to nested OCC.transact. Repository
 * binding shares the supplied PlatformUnitOfWork/connection; no second journal.
 * The implementation poisons the transaction after failed mutation even if its
 * callback catches that failure. Unknown commit preserves original operation IDs.
 */
export interface TurnJournalStoreV1 {
  /** Dispatch and consume under the same original outer transaction. Only a new
   * dispatch and new consumption may commit and transfer the pre-commit clock. */
  dispatchAndConsumeAndInitiate(
    dispatch: AuthorizedDispatchV1,
    input: VerifiedConsumptionV1,
    initiate: (attempt: ExactAttemptV1, guard: JournalInitiationGuardV1) => Promise<void>,
    call: AuthorityCallV1,
  ): ReturnType<TurnJournalStoreV1["consumeAndInitiate"]>;
  read<T>(work: (view: TurnJournalReadV1) => Promise<T>, call: AuthorityCallV1): Promise<T>;
  transact<T>(
    transactionRef: string,
    work: (unit: TurnJournalUnitOfWorkV1) => Promise<T>,
    call: AuthorityCallV1,
  ): Promise<JournalCommitResultV1<T>>;
  /** Sole initiation path. Enters the OUTERMOST store transaction, consumes one
   * canonical attempt, then invokes initiate at most once ONLY for its newly
   * committed claimant. No callback on rollback/unknown commit/already consumed.
   * Initiation rechecks current original authority before the first effect and
   * after awaits, within the 5s/earliest-proof deadline. No returned/readback token
   * can restart it; callback throw/disconnect/timeout yields execution-unknown.
   */
  consumeAndInitiate(
    input: VerifiedConsumptionV1,
    initiate: (attempt: ExactAttemptV1, guard: JournalInitiationGuardV1) => Promise<void>,
    call: AuthorityCallV1,
  ): Promise<
    Readonly<{
      kind:
        | "initiated"
        | "already-consumed"
        | "execution-unknown"
        | "commit-unknown"
        | "denied"
        | "unavailable";
    }>
  >;
}

/** Projection dependency for the channel host. It may return SDK committed only
 * after the SAME outer journal transaction committed incoming linkage and original
 * receipt. A parsed or historically committed original receipt alone is insufficient.
 */
export interface HostedJournalAdmissionAdapterV1<Native> {
  authenticateAndAdmit(
    native: Native,
    call: AuthorityCallV1,
  ): Promise<HostedChannelAdmissionDecisionV1>;
}

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  hostedIntakeLocatorSchemaV1,
  hostedReceiptSchemaV1,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  ContextKeySchemaV1,
  ExactAttemptSchemaV1,
  CheckpointRefSchemaV1,
  parseCompletedContextV1,
} from "./completed-context-v1.ts";
import { StoreBindingRefSchemaV1 } from "./completed-state-v1.ts";
import { WorkspaceReservationRefSchemaV1 } from "./workspace-reservation-v1.ts";
import { BindRuntimeSchemaV1 } from "./runtime-authority-v1.ts";

const closed = { additionalProperties: false } as const;
const object = (properties: Record<string, TSchema>) => Type.Object(properties, closed);
const ref = Type.String({ minLength: 1, maxLength: 512 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const one = Type.Literal(1);
const tag = (kind: string) => object({ kind: Type.Literal(kind) });
// Actual SDK codecs below validate these carrier fields. No alternate channel schema.
const sdkLocator = Type.Unknown();
const sdkReceipt = Type.Unknown();
const assignment = BindRuntimeSchemaV1.properties.target.properties.assignmentRef;

export const ExactEventOrLogicalKeySchemaV1 = Type.Union([
  object({
    schemaVersion: one,
    kind: Type.Literal("event"),
    installationRef: ref,
    channelInstallationRef: ref,
    eventKey: digest,
  }),
  object({
    schemaVersion: one,
    kind: Type.Literal("logical-message"),
    installationRef: ref,
    channelInstallationRef: ref,
    logicalMessageKey: digest,
  }),
]);
export const ExpectedCompletionHeadSchemaV1 = object({
  context: ContextKeySchemaV1,
  headVersion: version,
  completionSequence: sequence,
  checkpointId: Type.Union([ref, Type.Null()]),
  creationRef: ref,
});
export const JournalAdmissionIdentitySchemaV1 = object({
  locator: sdkLocator,
  receipt: sdkReceipt,
  context: ContextKeySchemaV1,
  principalRef: ref,
  principalVersion: version,
  externalIdentityBindingRef: ref,
  providerSubjectRef: ref,
  routeKey: digest,
  conversationBindingVersion: version,
  routingPolicyVersion: version,
  commonGrantRef: ref,
  commonGrantVersion: version,
  workspace: StoreBindingRefSchemaV1,
  audiencePolicyRef: ref,
  audienceEvidenceRef: ref,
  audienceVersion: version,
  replyDestinationRef: ref,
  replyBindingVersion: version,
  admittedRevisionRef: ref,
  admittedConfigurationDigest: digest,
  gatewayAssignment: assignment,
  harnessAssignment: assignment,
  harnessRuntimeGeneration: version,
  contentRef: ref,
});
const admissionDecision = Type.Union([
  object({ kind: Type.Literal("accepted"), attempt: ExactAttemptSchemaV1 }),
  tag("busy"),
  object({
    kind: Type.Literal("denied"),
    reason: Type.Enum(["unavailable", "not-current", "unsupported", "conflict"]),
  }),
  object({ kind: Type.Literal("ignored"), reason: Type.Enum(["not-addressed", "non-turn"]) }),
]);
export const AdmissionRecordSchemaV1 = object({
  schemaVersion: one,
  identity: JournalAdmissionIdentitySchemaV1,
  decision: admissionDecision,
  expectedHead: ExpectedCompletionHeadSchemaV1,
  decisionRef: ref,
  auditIntentRef: ref,
  decidedAt: instant,
});
export const IncomingAdmissionLinkSchemaV1 = object({
  incomingLinkRef: ref,
  incomingIdentityDigest: digest,
  locator: sdkLocator,
  incomingEventDigest: digest,
  incomingContentDigest: digest,
  originalReceiptRefs: Type.Array(ref, { minItems: 1, maxItems: 2, uniqueItems: true }),
  disposition: Type.Enum(["original", "duplicate", "conflict"]),
  auditIntentRef: ref,
});
export const JournalCommonAttemptBindingSchemaV1 = object({
  attempt: ExactAttemptSchemaV1,
  identity: JournalAdmissionIdentitySchemaV1,
  reservation: WorkspaceReservationRefSchemaV1,
  expectedHead: ExpectedCompletionHeadSchemaV1,
});
export const JournalAttemptBindingSchemaV1 = object({
  ...JournalCommonAttemptBindingSchemaV1.properties,
  dispatchOperationRef: ref,
  authorityDecisionRef: ref,
  expiresAt: instant,
});
const unsuccessfulOutcome = object({
  kind: Type.Enum(["failed", "interrupted", "outcome-unknown", "cancelled"]),
  stage: Type.Enum(["before-dispatch", "dispatch", "execution", "checkpoint"]),
  evidenceRef: ref,
});
const runningOutcome = object({
  kind: Type.Literal("running"),
  nativeSessionRef: ref,
  nativeTurnRef: ref,
});
const attemptOutcome = Type.Union([
  tag("accepted-undispatched"),
  object({ kind: Type.Literal("dispatch-intent"), dispatchOperationRef: ref }),
  object({ kind: Type.Literal("consumed"), consumptionOperationRef: ref, consumedAt: instant }),
  runningOutcome,
  object({
    kind: Type.Literal("completed"),
    checkpoint: CheckpointRefSchemaV1,
    completionOperationRef: ref,
  }),
  unsuccessfulOutcome,
]);
export const ExactConsumptionOperationSchemaV1 = object({
  schemaVersion: one,
  attempt: ExactAttemptSchemaV1,
  operationRef: ref,
  claimantRef: ref,
  requestDigest: digest,
});
export const ExactSelectedExecutionSchemaV1 = object({
  attempt: ExactAttemptSchemaV1,
  dispatchOperationRef: ref,
  consumption: ExactConsumptionOperationSchemaV1,
  executionRef: ref,
  recipientRef: ref,
});
export const JournalExecutionSelectionSchemaV1 = object({
  execution: ExactSelectedExecutionSchemaV1,
  operationRef: ref,
  operationDigest: digest,
  executionLimitRef: ref,
  executionLimitVersion: version,
  maximumExecutionMs: Type.Integer({ minimum: 1, maximum: TURN_JOURNAL_LIMITS_V1.maximumTurnMs }),
});
export const JournalExecutionIntentSchemaV1 = object({
  ...JournalExecutionSelectionSchemaV1.properties,
  dispatchClock: Type.Union([
    object({
      kind: Type.Literal("pre-commit-monotonic-v1"),
      clockSourceRef: ref,
      clockEpochRef: ref,
      anchorAtMs: sequence,
      deadlineAtMs: sequence,
    }),
    object({
      clockSourceRef: ref,
      clockEpochRef: ref,
      committedAtMs: sequence,
      deadlineAtMs: sequence,
    }),
  ]),
});
export const JournalExecutionStartSchemaV1 = object({
  intent: JournalExecutionIntentSchemaV1,
  operationRef: ref,
  operationDigest: digest,
  nativeExecutionRef: ref,
  nativeIncarnationRef: ref,
  nativeReservationRef: ref,
  nativeSessionRef: ref,
  nativeTurnRef: ref,
  acceptanceEvidenceRef: ref,
  clockSourceRef: ref,
  clockEpochRef: ref,
  startedAtMs: sequence,
  deadlineAtMs: sequence,
  dispatchDeadlineAtMs: sequence,
  clockCorrespondenceEvidenceRef: ref,
});
export const ExactExecutionInterruptionSchemaV1 = object({
  start: JournalExecutionStartSchemaV1,
  operationRef: ref,
  operationDigest: digest,
  responsibilityRef: ref,
  responsibilityVersion: version,
});
export const AdmittedUndispatchedAttemptRecordSchemaV1 = object({
  phase: Type.Literal("admitted-undispatched"),
  binding: JournalCommonAttemptBindingSchemaV1,
  version,
  consumption: Type.Null(),
  outcome: Type.Union([
    tag("accepted-undispatched"),
    object({
      kind: Type.Enum(["failed", "interrupted", "outcome-unknown", "cancelled"]),
      stage: Type.Literal("before-dispatch"),
      evidenceRef: ref,
    }),
  ]),
});
export const DispatchBoundAttemptRecordSchemaV1 = object({
  binding: JournalAttemptBindingSchemaV1,
  version,
  consumption: Type.Union([
    Type.Null(),
    object({ operation: ExactConsumptionOperationSchemaV1, consumedAt: instant }),
  ]),
  outcome: attemptOutcome,
});
export const AttemptRecordSchemaV1 = Type.Union([
  AdmittedUndispatchedAttemptRecordSchemaV1,
  DispatchBoundAttemptRecordSchemaV1,
]);
export const ExactCheckpointAllocationSchemaV1 = object({
  schemaVersion: one,
  attempt: ExactAttemptSchemaV1,
  operationRef: ref,
  checkpointId: ref,
  expectedHead: ExpectedCompletionHeadSchemaV1,
});
export const ExactCompletionOperationSchemaV1 = object({
  schemaVersion: one,
  attempt: ExactAttemptSchemaV1,
  operationRef: ref,
  checkpointId: ref,
  expectedCompletionSequence: sequence,
  expectedAttemptVersion: version,
  requestDigest: digest,
});
export const ExactDeliveryOperationSchemaV1 = object({
  schemaVersion: one,
  attempt: ExactAttemptSchemaV1,
  operationRef: ref,
  outputRef: ref,
  outputDigest: digest,
  outcomeVersion: version,
  slot: Type.Enum(["completed-result", "outcome-status", "cancel-ack"]),
  statusNoticeCode: Type.Optional(
    Type.Enum([
      "failed",
      "interrupted",
      "cancelled",
      "outcome-unknown",
      "unavailable-before-dispatch",
      "resolved-completed",
    ]),
  ),
  replyDestinationRef: ref,
  replyBindingVersion: version,
  operation: Type.Union([
    tag("create"),
    object({ kind: Type.Literal("update"), providerMessageRef: ref }),
  ]),
});
export const ExactDeliveryOutcomeSchemaV1 = object({
  operation: ExactDeliveryOperationSchemaV1,
  deliveryAttemptRef: ref,
  outcome: Type.Union([
    object({ kind: Type.Literal("delivered"), providerMessageRef: ref }),
    object({
      kind: Type.Literal("definitive-no-effect"),
      retryClass: Type.Enum(["transient", "permanent"]),
    }),
    tag("delivery-unknown"),
    object({
      kind: Type.Literal("suppressed"),
      reason: Type.Enum(["not-current", "unsupported", "slot-unavailable"]),
    }),
  ]),
});
export const CompletionRecordSchemaV1 = object({
  operation: ExactCompletionOperationSchemaV1,
  checkpoint: CheckpointRefSchemaV1,
  head: ExpectedCompletionHeadSchemaV1,
  outcomeVersion: version,
  pendingDelivery: ExactDeliveryOperationSchemaV1,
});
export const ExactOutcomeOperationSchemaV1 = object({
  schemaVersion: one,
  attempt: ExactAttemptSchemaV1,
  operationRef: ref,
  expectedAttemptVersion: version,
  outcome: Type.Union([runningOutcome, unsuccessfulOutcome]),
  requestDigest: digest,
});
export const ExactCancellationOperationSchemaV1 = object({
  schemaVersion: one,
  attempt: ExactAttemptSchemaV1,
  operationRef: ref,
  requesterPrincipalRef: ref,
  originalPrincipalRef: ref,
  expectedAttemptVersion: version,
  requestDigest: digest,
});
export const JournalReleaseObservationSchemaV1 = object({
  attempt: ExactAttemptSchemaV1,
  reservation: WorkspaceReservationRefSchemaV1,
  workspace: StoreBindingRefSchemaV1,
  releaseOperationRef: ref,
  noMutatorEvidenceRef: ref,
  closedOwnerInventoryRef: ref,
  closedOwnerInventoryVersion: version,
  closedOwnerInventoryDigest: digest,
  expectedAttemptVersion: version,
});

export const TurnJournalSchemasV1 = Object.freeze({
  selectedExecution: ExactSelectedExecutionSchemaV1,
  executionSelection: JournalExecutionSelectionSchemaV1,
  executionIntent: JournalExecutionIntentSchemaV1,
  executionStart: JournalExecutionStartSchemaV1,
  executionInterruption: ExactExecutionInterruptionSchemaV1,
  lookup: ExactEventOrLogicalKeySchemaV1,
  head: ExpectedCompletionHeadSchemaV1,
  admissionIdentity: JournalAdmissionIdentitySchemaV1,
  admission: AdmissionRecordSchemaV1,
  incomingLink: IncomingAdmissionLinkSchemaV1,
  commonAttemptBinding: JournalCommonAttemptBindingSchemaV1,
  attemptBinding: JournalAttemptBindingSchemaV1,
  attempt: AttemptRecordSchemaV1,
  consumption: ExactConsumptionOperationSchemaV1,
  checkpointAllocation: ExactCheckpointAllocationSchemaV1,
  completionOperation: ExactCompletionOperationSchemaV1,
  completion: CompletionRecordSchemaV1,
  outcomeOperation: ExactOutcomeOperationSchemaV1,
  cancellation: ExactCancellationOperationSchemaV1,
  deliveryOperation: ExactDeliveryOperationSchemaV1,
  delivery: ExactDeliveryOutcomeSchemaV1,
  releaseObservation: JournalReleaseObservationSchemaV1,
});
export interface TurnJournalWireValuesV1 {
  selectedExecution: ExactSelectedExecutionV1;
  executionSelection: JournalExecutionSelectionV1;
  executionIntent: JournalExecutionIntentV1;
  executionStart: JournalExecutionStartV1;
  executionInterruption: ExactExecutionInterruptionV1;
  lookup: ExactEventOrLogicalKeyV1;
  head: ExpectedCompletionHeadV1;
  admissionIdentity: JournalAdmissionIdentityV1;
  admission: AdmissionRecordV1;
  incomingLink: IncomingAdmissionLinkV1;
  commonAttemptBinding: JournalCommonAttemptBindingV1;
  attemptBinding: JournalAttemptBindingV1;
  attempt: AttemptRecordV1;
  consumption: ExactConsumptionOperationV1;
  checkpointAllocation: ExactCheckpointAllocationV1;
  completionOperation: ExactCompletionOperationV1;
  completion: CompletionRecordV1;
  outcomeOperation: ExactOutcomeOperationV1;
  cancellation: ExactCancellationOperationV1;
  deliveryOperation: ExactDeliveryOperationV1;
  delivery: ExactDeliveryOutcomeV1;
  releaseObservation: JournalReleaseObservationV1;
}

function invalid(): never {
  throw new Error("Invalid turn journal V1 value.");
}
function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function snapshot(
  input: unknown,
  depth = 0,
  budget = { remaining: TURN_JOURNAL_LIMITS_V1.valueBytes },
): unknown {
  if (depth > TURN_JOURNAL_LIMITS_V1.nestingDepth || --budget.remaining < 0) invalid();
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input) || input < 0 || Object.is(input, -0)) invalid();
    return input;
  }
  if (typeof input === "string") {
    if (/[\ud800-\udfff]/u.test(input)) invalid();
    budget.remaining -= bytes(input);
    if (budget.remaining < 0) invalid();
    return input;
  }
  if (typeof input !== "object") invalid();
  if (Array.isArray(input)) {
    if (
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > 128 ||
      Reflect.ownKeys(input).length !== input.length + 1
    )
      invalid();
    return Array.from({ length: input.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(input, String(i));
      if (!d || !("value" in d) || !d.enumerable) invalid();
      return snapshot(d.value, depth + 1, budget);
    });
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key))
      invalid();
    snapshot(key, depth + 1, budget);
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d || !("value" in d) || !d.enumerable) invalid();
    out[key] = snapshot(d.value, depth + 1, budget);
  }
  return out;
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) frozen(v);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function sameContext(a: ContextKeyV1, b: ContextKeyV1): boolean {
  return (
    a.installationRef === b.installationRef &&
    a.namespaceRef === b.namespaceRef &&
    a.agentRef === b.agentRef &&
    a.conversationRef === b.conversationRef
  );
}
function checkIntrinsic(input: unknown): void {
  if (!input || typeof input !== "object") return;
  if (Array.isArray(input)) {
    for (const v of input) checkIntrinsic(v);
    return;
  }
  const v = input as Record<string, unknown>;
  for (const [key, child] of Object.entries(v)) {
    if (key === "envelope") {
      // The actual SDK owns its bounded metadata/timestamp vocabulary.
      parseRejectedAdmissionV1(v);
      continue;
    }
    if (typeof child === "string") {
      if (
        child.length > 512 ||
        bytes(child) > TURN_JOURNAL_LIMITS_V1.referenceBytes ||
        child.trim() !== child ||
        child.includes("://") ||
        /[\u0000-\u001f\u007f]/u.test(child)
      )
        invalid();
      if (
        /(?:At)$/.test(key) &&
        (!Number.isFinite(Date.parse(child)) || new Date(child).toISOString() !== child)
      )
        invalid();
    }
    checkIntrinsic(child);
  }
  if (v.executionRef !== undefined && v.consumption !== undefined && v.attempt !== undefined) {
    if (!same(v.attempt, (v.consumption as ExactConsumptionOperationV1).attempt)) invalid();
  }
  if (v.dispatchClock !== undefined) {
    const c = v.dispatchClock as JournalExecutionIntentV1["dispatchClock"];
    const anchor = "kind" in c ? c.anchorAtMs : c.committedAtMs;
    if (
      c.deadlineAtMs <= anchor ||
      c.deadlineAtMs - anchor > TURN_JOURNAL_LIMITS_V1.maximumTurnMs ||
      ("kind" in c && c.deadlineAtMs - anchor !== TURN_JOURNAL_LIMITS_V1.maximumTurnMs)
    )
      invalid();
  }
  if (v.dispatchDeadlineAtMs !== undefined) {
    const start = v as unknown as JournalExecutionStartV1;
    if (
      start.deadlineAtMs <= start.startedAtMs ||
      start.deadlineAtMs !==
        Math.min(start.dispatchDeadlineAtMs, start.startedAtMs + start.intent.maximumExecutionMs) ||
      !Number.isSafeInteger(start.startedAtMs + start.intent.maximumExecutionMs)
    )
      invalid();
    if (
      start.clockSourceRef === start.intent.dispatchClock.clockSourceRef &&
      start.clockEpochRef === start.intent.dispatchClock.clockEpochRef &&
      (start.dispatchDeadlineAtMs !== start.intent.dispatchClock.deadlineAtMs ||
        start.startedAtMs <
          ("kind" in start.intent.dispatchClock
            ? start.intent.dispatchClock.anchorAtMs
            : start.intent.dispatchClock.committedAtMs))
    )
      invalid();
  }
  if (v.locator !== undefined) {
    const locatorValue = v.locator as Record<string, unknown>;
    if (locatorValue.classification !== undefined) {
      if (!Check(ExactNonTurnIntakeSchemaV1, locatorValue)) invalid();
    } else if (!hostedIntakeLocatorSchemaV1.safeParse(locatorValue).success) invalid();
  }
  if (v.originalReceipt !== undefined) {
    if (
      !hostedReceiptSchemaV1.safeParse(v.originalReceipt).success ||
      !v.incomingLink ||
      !(v.incomingLink as IncomingAdmissionLinkV1).originalReceiptRefs.includes(
        (v.originalReceipt as HostedChannelReceiptV1).receiptRef,
      )
    )
      invalid();
  }
  if (v.receipt !== undefined) {
    const receiptValue = v.receipt as Record<string, unknown>;
    if (receiptValue.intake !== undefined) {
      if (!Check(NonTurnReceiptSchemaV1, receiptValue)) invalid();
    } else if (!hostedReceiptSchemaV1.safeParse(receiptValue).success) invalid();
  }
  if (
    v.completionSequence !== undefined &&
    v.checkpointId !== undefined &&
    (v.completionSequence === 0) !== (v.checkpointId === null)
  )
    invalid();
  if (v.locator && v.receipt) {
    const l = v.locator as HostedChannelIntakeLocatorV1;
    const r = v.receipt as HostedChannelReceiptV1;
    const c = v.context as ContextKeyV1;
    if (
      l.installationRef !== c.installationRef ||
      l.eventKey !== r.eventKey ||
      l.logicalMessageKey !== r.logicalMessageKey
    )
      invalid();
    const workspace = v.workspace as StoreBindingRefV1;
    if (
      workspace.scope.installationId !== c.installationRef ||
      workspace.scope.namespaceId !== c.namespaceRef ||
      workspace.scope.agentId !== c.agentRef
    )
      invalid();
  }
  if (v.expectedHead && v.attempt) {
    if (
      !sameContext(
        (v.expectedHead as ExpectedCompletionHeadV1).context,
        v.attempt as ExactAttemptV1,
      )
    )
      invalid();
  }
  if (v.reservation && v.attempt) {
    const a = v.attempt as ExactAttemptV1;
    const r = v.reservation as WorkspaceReservationRefV1;
    if (
      a.reservationRef !== r.reservationRef ||
      a.installationRef !== r.scope.installationId ||
      a.namespaceRef !== r.scope.namespaceId ||
      a.agentRef !== r.scope.agentId
    )
      invalid();
  }
  if (v.identity && v.expectedHead) {
    const i = v.identity as JournalAdmissionIdentityV1;
    if (!sameContext(i.context, (v.expectedHead as ExpectedCompletionHeadV1).context)) invalid();
    if (
      v.decision &&
      (v.decision as JournalAdmissionDecisionV1).kind === "accepted" &&
      !sameContext(
        i.context,
        (v.decision as Extract<JournalAdmissionDecisionV1, { kind: "accepted" }>).attempt,
      )
    )
      invalid();
  }
  if (v.envelope !== undefined) parseRejectedAdmissionV1(v);
  if (v.binding && v.outcome && Object.hasOwn(v, "consumption")) {
    const record = v as unknown as AttemptRecordV1;
    const consumption = record.consumption;
    const outcome = record.outcome;
    if (consumption && !same(consumption.operation.attempt, record.binding.attempt)) invalid();
    if (
      outcome.kind === "dispatch-intent" &&
      ("phase" in record || outcome.dispatchOperationRef !== record.binding.dispatchOperationRef)
    )
      invalid();
    if (["accepted-undispatched", "dispatch-intent"].includes(outcome.kind) && consumption !== null)
      invalid();
    if (["consumed", "running", "completed"].includes(outcome.kind) && !consumption) invalid();
    if (
      outcome.kind === "consumed" &&
      (!consumption ||
        outcome.consumptionOperationRef !== consumption.operation.operationRef ||
        outcome.consumedAt !== consumption.consumedAt)
    )
      invalid();
    if ("stage" in outcome && outcome.stage === "before-dispatch" && consumption !== null)
      invalid();
    if (
      "stage" in outcome &&
      (outcome.stage === "execution" || outcome.stage === "checkpoint") &&
      consumption === null
    )
      invalid();
  }
  if (
    v.kind === "reserved" &&
    v.attemptNumber !== undefined &&
    v.operation &&
    (v.operation as ExactDeliveryOperationV1).operation.kind === "update" &&
    v.attemptNumber !== 1
  )
    invalid();
  if (v.statusNoticeCode !== undefined) {
    const operation = v.operation as ExactDeliveryOperationV1["operation"];
    if (
      v.slot !== "outcome-status" ||
      (v.statusNoticeCode === "resolved-completed" && operation.kind !== "update") ||
      ((v.statusNoticeCode === "outcome-unknown" ||
        v.statusNoticeCode === "unavailable-before-dispatch") &&
        operation.kind !== "create")
    )
      invalid();
  }
  if (v.checkpoint !== undefined) parseCompletedContextV1("checkpointRef", v.checkpoint);
  if (
    v.kind === "new-context" &&
    v.head &&
    (v.head as ExpectedCompletionHeadV1).completionSequence !== 0
  )
    invalid();
  if (v.head && v.checkpoint) {
    const h = v.head as ExpectedCompletionHeadV1;
    const checkpoint = v.checkpoint as CheckpointRefV1;
    if (
      !sameContext(h.context, checkpoint) ||
      h.checkpointId !== checkpoint.checkpointId ||
      h.completionSequence !== checkpoint.completionSequence
    )
      invalid();
  }
  if (v.record && v.incomingLink) {
    const record = v.record as AdmissionRecordV1 | RejectedAdmissionRecordV1;
    const receipt = "identity" in record ? record.identity.receipt : record.receipt;
    const installation =
      "identity" in record
        ? record.identity.locator.installationRef
        : record.envelope.installationRef;
    const channelInstallation =
      "identity" in record
        ? record.identity.locator.channelInstallationRef
        : record.envelope.channelInstallationRef;
    const link = v.incomingLink as IncomingAdmissionLinkV1;
    if (
      !link.originalReceiptRefs.includes(receipt.receiptRef) ||
      link.locator.installationRef !== installation ||
      link.locator.channelInstallationRef !== channelInstallation
    )
      invalid();
    if (
      (v.duplicate === true || v.kind === "rejected-existing") &&
      link.disposition !== "duplicate"
    )
      invalid();
    if (v.duplicate === false && link.disposition !== "original") invalid();
    if (v.kind === "resolved-existing" && link.disposition !== "duplicate") invalid();
    if (v.kind === "existing" && "envelope" in record && link.disposition !== "duplicate") {
      // Exact rejected replay retains its immutable original incoming link.
      // A distinct logical retry still needs its own duplicate link; routing
      // correspondence remains the accepting journal's responsibility.
      if (
        link.disposition !== "original" ||
        link.originalReceiptRefs.length !== 1 ||
        link.originalReceiptRefs[0] !== receipt.receiptRef ||
        link.locator.eventKey !== receipt.eventKey ||
        link.locator.logicalMessageKey !== receipt.logicalMessageKey ||
        link.incomingEventDigest !== receipt.eventDigest ||
        link.incomingContentDigest !== receipt.contentDigest
      )
        invalid();
    }
    if (v.kind === "recorded" && "envelope" in record && link.disposition !== "original") invalid();
  }
  if (
    v.link &&
    v.original &&
    !(v.link as IncomingAdmissionLinkV1).originalReceiptRefs.includes(
      "intake" in (v.original as JournalAdmissionOwnerV1)
        ? (v.original as NonTurnReceiptV1).receiptRef
        : ("identity" in (v.original as AdmissionRecordV1 | RejectedAdmissionRecordV1)
            ? (v.original as AdmissionRecordV1).identity.receipt
            : (v.original as RejectedAdmissionRecordV1).receipt
          ).receiptRef,
    )
  )
    invalid();
  if (v.kind === "non-turn-owned" && v.original && v.incomingLink) {
    const original = v.original as NonTurnReceiptV1;
    const link = v.incomingLink as IncomingAdmissionLinkV1;
    if (
      !link.originalReceiptRefs.includes(original.receiptRef) ||
      link.disposition !== "conflict" ||
      link.locator.installationRef !== original.intake.installationRef ||
      link.locator.channelInstallationRef !== original.intake.channelInstallationRef
    )
      invalid();
  }
  if (v.head && v.checkpoint && v.operation) {
    const c = v.checkpoint as CheckpointRefV1;
    const h = v.head as ExpectedCompletionHeadV1;
    const o = v.operation as ExactCompletionOperationV1;
    if (
      !sameContext(h.context, c) ||
      !sameContext(o.attempt, c) ||
      c.checkpointId !== o.checkpointId ||
      c.checkpointId !== h.checkpointId ||
      c.completionSequence !== h.completionSequence ||
      c.completionSequence !== o.expectedCompletionSequence + 1
    )
      invalid();
    if ((v.outcomeVersion as number) !== o.expectedAttemptVersion + 1) invalid();
    for (const k of ["turnRef", "attemptRef", "reservationRef"] as const)
      if (c[k] !== o.attempt[k]) invalid();
  }
  if (
    v.slot &&
    v.operation &&
    (v.operation as { kind: string }).kind === "update" &&
    v.slot !== "outcome-status"
  )
    invalid();
}

/** Strict bounded JSON-data decoding; returned values are locators/observations,
 * never provenance handles, verified checkpoints or initiation authority.
 */
export function parseTurnJournalV1<K extends keyof TurnJournalWireValuesV1>(
  kind: K,
  input: unknown,
): TurnJournalWireValuesV1[K] {
  try {
    if (!Object.hasOwn(TurnJournalSchemasV1, kind)) invalid();
    const value = snapshot(input);
    if (!Check(TurnJournalSchemasV1[kind], value)) invalid();
    checkIntrinsic(value);
    // The closed selected schema, complete SDK carrier checks and intrinsic
    // correlation checks above establish this wire value, never trusted provenance.
    return frozen(value) as TurnJournalWireValuesV1[K];
  } catch {
    return invalid();
  }
}

/** Duplicate-key preserving scanner. Counters require exact decimal lexemes. */
function readJournalJsonV1(input: string): unknown {
  try {
    if (typeof input !== "string" || bytes(input) > TURN_JOURNAL_LIMITS_V1.valueBytes) invalid();
    let at = 0;
    const ws = () => {
      while (/[\x20\x09\x0a\x0d]/.test(input[at] ?? "!")) at++;
    };
    const string = (): string => {
      const start = at++;
      while (at < input.length) {
        const ch = input[at++];
        if (ch === "\\") {
          at++;
          continue;
        }
        if (ch === '"') return JSON.parse(input.slice(start, at));
      }
      return invalid();
    };
    const value = (depth: number): unknown => {
      if (depth > TURN_JOURNAL_LIMITS_V1.nestingDepth) invalid();
      ws();
      if (input[at] === '"') return string();
      if (input[at] === "{") {
        at++;
        ws();
        const out: Record<string, unknown> = Object.create(null);
        if (input[at] === "}") {
          at++;
          return out;
        }
        for (;;) {
          ws();
          if (input[at] !== '"') invalid();
          const key = string();
          if (Object.hasOwn(out, key)) invalid();
          ws();
          if (input[at++] !== ":") invalid();
          out[key] = value(depth + 1);
          ws();
          const next = input[at++];
          if (next === "}") return out;
          if (next !== ",") invalid();
        }
      }
      if (input[at] === "[") {
        at++;
        ws();
        const out: unknown[] = [];
        if (input[at] === "]") {
          at++;
          return out;
        }
        for (;;) {
          if (out.length >= 128) invalid();
          out.push(value(depth + 1));
          ws();
          const next = input[at++];
          if (next === "]") return out;
          if (next !== ",") invalid();
        }
      }
      const token =
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
          input.slice(at),
        );
      if (!token) invalid();
      at += token[0].length;
      const parsed: unknown = JSON.parse(token[0]);
      if (
        typeof parsed === "number" &&
        (!/^(?:0|[1-9][0-9]*)$/.test(token[0]) || !Number.isSafeInteger(parsed))
      )
        invalid();
      return parsed;
    };
    const parsed = value(0);
    ws();
    if (at !== input.length) invalid();
    return parsed;
  } catch {
    return invalid();
  }
}

/** Pure definition classifier, not an authorization or durability check. Call it
 * only over one consistent, locked journal snapshot; persist its incoming link,
 * immutable decision, reservation and audit intent in the same transaction.
 */
export type JournalAdmissionOwnerV1 =
  AdmissionRecordV1 | RejectedAdmissionRecordV1 | NonTurnReceiptV1;
export function classifyJournalAdmissionV1(
  input: Readonly<{
    incoming: JournalAdmissionIdentityV1;
    byEvent: JournalAdmissionOwnerV1 | null;
    byLogicalMessage: JournalAdmissionOwnerV1 | null;
    agentReserved: boolean;
  }>,
): Readonly<
  | { kind: "duplicate"; original: AdmissionRecordV1 | RejectedAdmissionRecordV1 }
  | { kind: "non-turn-owned"; original: NonTurnReceiptV1; originalReceiptRefs: readonly string[] }
  | { kind: "conflict"; originalReceiptRefs: readonly string[] }
  | { kind: "busy" }
  | { kind: "candidate" }
> {
  const incoming = parseTurnJournalV1("admissionIdentity", input.incoming);
  const parseOwner = (value: JournalAdmissionOwnerV1 | null) => {
    if (value === null) return null;
    if ("intake" in value) return parseNonTurnReceiptV1(value);
    return Object.hasOwn(value, "envelope")
      ? parseRejectedAdmissionV1(value)
      : parseTurnJournalV1("admission", value);
  };
  const event = parseOwner(input.byEvent);
  const logical = parseOwner(input.byLogicalMessage);
  const ownerReceipt = (r: JournalAdmissionOwnerV1) => {
    if ("intake" in r)
      return {
        receiptRef: r.receiptRef,
        eventKey: r.intake.eventKey,
        logicalMessageKey:
          r.intake.logicalMessage.kind === "equivalent-original"
            ? r.intake.logicalMessage.logicalMessageKey
            : undefined,
        eventDigest: r.intake.eventDigest,
      };
    return "identity" in r ? r.identity.receipt : r.receipt;
  };
  const ownerScope = (r: JournalAdmissionOwnerV1) => {
    if ("intake" in r) return r.intake;
    return "identity" in r ? r.identity.locator : r.envelope;
  };
  const owners = [event, logical].filter((r): r is JournalAdmissionOwnerV1 => r !== null);
  const ids = [...new Set(owners.map((r) => ownerReceipt(r).receiptRef))];
  for (const owner of owners) {
    const scope = ownerScope(owner);
    if (
      scope.installationRef !== incoming.locator.installationRef ||
      scope.channelInstallationRef !== incoming.locator.channelInstallationRef
    )
      invalid();
  }
  if (event && ownerReceipt(event).eventKey !== incoming.locator.eventKey) invalid();
  if (logical && ownerReceipt(logical).logicalMessageKey !== incoming.locator.logicalMessageKey)
    invalid();
  const nonTurnOwner = owners.find((owner): owner is NonTurnReceiptV1 => "intake" in owner);
  // An executable candidate cannot promote any prior non-turn owner. Retain the
  // separate carrier and every related owner; never invent a human SDK receipt.
  if (nonTurnOwner)
    return frozen({ kind: "non-turn-owned", original: nonTurnOwner, originalReceiptRefs: ids });
  if (ids.length > 1) return frozen({ kind: "conflict", originalReceiptRefs: ids });
  const original = event ?? logical;
  if (original && !("intake" in original)) {
    const receipt = "identity" in original ? original.identity.receipt : original.receipt;
    const immutableContentMatches =
      receipt.logicalMessageKey === incoming.receipt.logicalMessageKey &&
      receipt.contentDigest === incoming.receipt.contentDigest &&
      receipt.profileConfigurationDigest === incoming.receipt.profileConfigurationDigest;
    const comparable = (i: JournalAdmissionIdentityV1) => ({
      context: i.context,
      principalRef: i.principalRef,
      providerSubjectRef: i.providerSubjectRef,
      routeKey: i.routeKey,
      commonGrantRef: i.commonGrantRef,
      workspace: i.workspace,
      replyDestinationRef: i.replyDestinationRef,
      externalIdentityBindingRef: i.externalIdentityBindingRef,
    });
    const identityMatches =
      "identity" in original
        ? same(comparable(original.identity), comparable(incoming))
        : original.envelope.sender.providerSubjectRef === incoming.providerSubjectRef &&
          hostedChannelRouteKeyV1(original.envelope) === incoming.routeKey;
    if (
      !immutableContentMatches ||
      !identityMatches ||
      (event && ownerReceipt(event).eventDigest !== incoming.receipt.eventDigest)
    )
      return frozen({ kind: "conflict", originalReceiptRefs: ids });
    // Includes unresolved-human denial. Later provisioning cannot promote it.
    return frozen({ kind: "duplicate", original });
  }
  return Object.freeze(input.agentReserved ? { kind: "busy" } : { kind: "candidate" });
}

/** Consistency check only. The actual repository must additionally authenticate
 * canonical/native/workspace evidence, lock current records and perform one CAS.
 */
export function journalCompletionMatchesV1(
  input: Readonly<{
    currentAttempt: AttemptRecordV1;
    currentHead: ExpectedCompletionHeadV1;
    allocation: ExactCheckpointAllocationV1;
    candidate: CompletionRecordV1;
    expectedAttemptVersion: number;
  }>,
): boolean {
  const a = parseTurnJournalV1("attempt", input.currentAttempt);
  const head = parseTurnJournalV1("head", input.currentHead);
  const allocation = parseTurnJournalV1("checkpointAllocation", input.allocation);
  const candidate = parseTurnJournalV1("completion", input.candidate);
  return (
    a.version === input.expectedAttemptVersion &&
    a.version === candidate.operation.expectedAttemptVersion &&
    a.consumption !== null &&
    (["consumed", "running"].includes(a.outcome.kind) ||
      (a.outcome.kind === "outcome-unknown" &&
        ["execution", "checkpoint"].includes(a.outcome.stage))) &&
    same(a.binding.attempt, allocation.attempt) &&
    same(allocation.attempt, candidate.operation.attempt) &&
    same(a.binding.expectedHead, head) &&
    same(allocation.expectedHead, head) &&
    allocation.checkpointId === candidate.checkpoint.checkpointId &&
    head.completionSequence < Number.MAX_SAFE_INTEGER &&
    head.headVersion < Number.MAX_SAFE_INTEGER &&
    candidate.head.creationRef === head.creationRef &&
    candidate.head.headVersion === head.headVersion + 1 &&
    candidate.head.completionSequence === head.completionSequence + 1 &&
    candidate.checkpoint.parentCheckpointId === head.checkpointId &&
    candidate.checkpoint.revisionRef === a.binding.identity.admittedRevisionRef &&
    candidate.checkpoint.admittedConfigurationDigest ===
      a.binding.identity.admittedConfigurationDigest &&
    candidate.checkpoint.producingGatewayAssignmentRef ===
      a.binding.identity.gatewayAssignment.id &&
    candidate.checkpoint.producingHarnessAssignmentRef ===
      a.binding.identity.harnessAssignment.id &&
    candidate.checkpoint.workspaceBindingRef === a.binding.identity.workspace.bindingRef &&
    same(candidate.pendingDelivery.attempt, a.binding.attempt) &&
    candidate.pendingDelivery.replyDestinationRef === a.binding.identity.replyDestinationRef &&
    candidate.pendingDelivery.replyBindingVersion === a.binding.identity.replyBindingVersion &&
    candidate.pendingDelivery.slot === "completed-result" &&
    candidate.pendingDelivery.operation.kind === "create" &&
    candidate.pendingDelivery.outcomeVersion === a.version + 1 &&
    candidate.outcomeVersion === a.version + 1
  );
}

/** Validate the versioned observation transition. This does not authenticate a
 * native terminal or prove cancellation/termination/no-mutator release.
 */
export function journalOutcomeTransitionAllowedV1(
  current: AttemptRecordV1,
  operation: ExactOutcomeOperationV1,
): boolean {
  const c = parseTurnJournalV1("attempt", current);
  const op = parseTurnJournalV1("outcomeOperation", operation);
  if (
    !same(c.binding.attempt, op.attempt) ||
    c.version !== op.expectedAttemptVersion ||
    c.version === Number.MAX_SAFE_INTEGER ||
    c.outcome.kind === "completed"
  )
    return false;
  if (["failed", "cancelled", "interrupted"].includes(c.outcome.kind)) return false;
  if (op.outcome.kind === "running")
    return !("phase" in c) && c.outcome.kind === "consumed" && c.consumption !== null;
  if (op.outcome.stage === "before-dispatch")
    return (
      c.consumption === null &&
      (c.outcome.kind === "accepted-undispatched" ||
        (c.outcome.kind === "outcome-unknown" && c.outcome.stage === "before-dispatch"))
    );
  if ("phase" in c) return false;
  if (
    c.outcome.kind === "accepted-undispatched" ||
    (c.outcome.kind === "outcome-unknown" && c.outcome.stage === "before-dispatch")
  )
    return false;
  if (["execution", "checkpoint"].includes(op.outcome.stage) && c.consumption === null)
    return false;
  if (c.outcome.kind === "outcome-unknown")
    return (
      op.outcome.kind === "outcome-unknown" ||
      op.outcome.kind === "interrupted" ||
      op.outcome.kind === "failed" ||
      op.outcome.kind === "cancelled"
    );
  return true;
}

export function journalReleaseMatchesV1(
  current: AttemptRecordV1,
  observation: JournalReleaseObservationV1,
): boolean {
  const c = parseTurnJournalV1("attempt", current);
  const o = parseTurnJournalV1("releaseObservation", observation);
  return (
    c.version === o.expectedAttemptVersion &&
    same(c.binding.attempt, o.attempt) &&
    same(c.binding.reservation, o.reservation) &&
    same(c.binding.identity.workspace, o.workspace)
  );
}

/** Compare the exact common-to-intent transition. A matching value still needs
 * real current dispatch provenance and the original outer versioned mutation;
 * this pure comparison does not initiate or create dispatch authority. */
export function journalDispatchIntentMatchesV1(
  current: AttemptRecordV1,
  candidate: DispatchBoundAttemptRecordV1,
  expectedAttemptVersion: number,
): boolean {
  const c = parseTurnJournalV1("attempt", current);
  const next = parseTurnJournalV1("attempt", candidate);
  if ("phase" in next) return false;
  return (
    c.version === expectedAttemptVersion &&
    c.version < Number.MAX_SAFE_INTEGER &&
    next.version === c.version + 1 &&
    c.outcome.kind === "accepted-undispatched" &&
    c.consumption === null &&
    next.consumption === null &&
    next.outcome.kind === "dispatch-intent" &&
    same(c.binding.attempt, next.binding.attempt) &&
    same(c.binding.identity, next.binding.identity) &&
    same(c.binding.reservation, next.binding.reservation) &&
    same(c.binding.expectedHead, next.binding.expectedHead) &&
    ("phase" in c || same(c.binding, next.binding))
  );
}

/** Value correspondence for cancellation before dispatch. The receiving owner
 * must still prove current cancellation authority and locked no-intent/no-
 * consumption facts; neither this result nor cancellation releases ownership. */
export function journalCancellationBeforeDispatchMatchesV1(
  current: AttemptRecordV1,
  operation: ExactCancellationOperationV1,
): boolean {
  const c = parseTurnJournalV1("attempt", current);
  const op = parseTurnJournalV1("cancellation", operation);
  return (
    c.version === op.expectedAttemptVersion &&
    c.version < Number.MAX_SAFE_INTEGER &&
    same(c.binding.attempt, op.attempt) &&
    c.binding.identity.principalRef === op.originalPrincipalRef &&
    c.outcome.kind === "accepted-undispatched" &&
    c.consumption === null
  );
}

/** Host-binding utility implementing the post-commit callback boundary, not a
 * journal backend. The owner supplies the actual outer-store consumption plus
 * live guard. Durable unique consumption remains the repository's responsibility.
 * The wrapper never exposes a permit and never retries a callback.
 */
export interface JournalInitiationGuardV1 {
  readonly executionIntent?: JournalExecutionIntentV1;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export function createJournalInitiatorV1(
  owner: Readonly<{
    /** Trusted monotonic milliseconds, same clock as guard.validUntil. */
    now(): number;
    consume(
      input: VerifiedConsumptionV1,
      call: AuthorityCallV1,
    ): Promise<JournalCommitResultV1<ConsumptionResultV1>>;
    inspectCommittedClaim(
      claim: PendingInitiationClaimV1,
      call: AuthorityCallV1,
    ): Promise<
      | Readonly<{
          attempt: ExactAttemptV1;
          signal: AbortSignal;
          validUntil: number;
          executionIntent?: JournalExecutionIntentV1;
          assertCurrent(): Promise<void>;
        }>
      | undefined
    >;
  }>,
): TurnJournalStoreV1["consumeAndInitiate"] {
  const spent = new WeakSet<PendingInitiationClaimV1>();
  return async (input, initiate, call) => {
    let startedAt: number;
    try {
      startedAt = owner.now();
    } catch {
      return { kind: "unavailable" };
    }
    let transaction: JournalCommitResultV1<ConsumptionResultV1>;
    try {
      transaction = await owner.consume(input, call);
    } catch {
      return { kind: "commit-unknown" };
    }
    if (transaction.kind !== "committed") return { kind: transaction.kind };
    const result = transaction.value;
    if (result.kind === "already-consumed") return { kind: "already-consumed" };
    if (result.kind === "conflict" || result.kind === "denied") return { kind: "denied" };
    if (result.kind === "unavailable") return { kind: "unavailable" };
    const claim = result.claim;
    if (spent.has(claim)) return { kind: "already-consumed" };
    spent.add(claim);
    try {
      const guard = await owner.inspectCommittedClaim(claim, call);
      if (!guard || !Number.isFinite(startedAt) || !Number.isFinite(guard.validUntil))
        return { kind: "execution-unknown" };
      if (
        !same(
          parseCompletedContextV1("exactAttempt", guard.attempt),
          parseTurnJournalV1("consumption", claim.operation).attempt,
        )
      )
        return { kind: "execution-unknown" };
      const signal = AbortSignal.any([call.signal, guard.signal]);
      const latestStart = Math.min(
        startedAt + TURN_JOURNAL_LIMITS_V1.startWindowMs,
        guard.validUntil,
      );
      const assertWithinDeadline = () => {
        const now = owner.now();
        if (signal.aborted || !Number.isFinite(now) || now < startedAt || now >= latestStart)
          throw new Error("Journal initiation unavailable.");
      };
      const assertCurrent = async () => {
        assertWithinDeadline();
        await guard.assertCurrent();
        assertWithinDeadline();
      };
      await assertCurrent();
      await initiate(guard.attempt, {
        signal,
        assertCurrent,
        ...(guard.executionIntent === undefined
          ? {}
          : { executionIntent: parseTurnJournalV1("executionIntent", guard.executionIntent) }),
      });
      return { kind: "initiated" };
    } catch {
      return { kind: "execution-unknown" };
    }
  };
}

/** Authenticated non-executable intake. This is not a human channel envelope. */
export type ExactNonTurnIntakeV1 = Readonly<{
  schemaVersion: 1;
  installationRef: string;
  channelInstallationRef: string;
  platform: "slack" | "msteams";
  providerTenantRef: string;
  recipientAppRef: string;
  eventKey: string;
  eventDigest: string;
  classification:
    "bot-original" | "unaddressed-original" | "edit" | "delete" | "reaction" | "typing-control";
  logicalMessage:
    | Readonly<{ kind: "equivalent-original"; logicalMessageKey: string }>
    | Readonly<{ kind: "related-only"; logicalMessageKey: string }>
    | Readonly<{ kind: "not-applicable" }>;
  normalizationProfileRef: string;
}>;
declare const nonTurnProvenance: unique symbol;
export interface VerifiedNonTurnInputV1 {
  readonly [nonTurnProvenance]: true;
}
export type NonTurnReceiptV1 = Readonly<{
  schemaVersion: 1;
  /** This handling/link receipt, never a rewritten original owner's receipt. */
  receiptRef: string;
  intake: ExactNonTurnIntakeV1;
  disposition: "ignored" | "conflict";
  incomingLinkRef: string;
  originalReceiptRefs: readonly string[];
  auditIntentRef: string;
}>;
export type NonTurnResponsibilityV1 =
  | Readonly<{ kind: "committed"; receipt: NonTurnReceiptV1 }>
  | Readonly<{ kind: "unknown"; locator: ExactNonTurnIntakeV1 }>
  | Readonly<{ kind: "not-responsible" }>;
export type NonTurnStateV1 =
  | Readonly<{ kind: "found"; receipt: NonTurnReceiptV1 }>
  | Readonly<{ kind: "not-found" | "denied" | "unavailable" | "unknown" }>;
/** An adapter view of the same real transport verifier, never a fallback verifier.
 * Missing stable authenticated event/digest or unresolved logical eligibility
 * returns not-responsible. A brand test or caller classification is insufficient.
 */
export interface NonTurnProvenanceV1<Native> {
  authenticateNonTurn(
    native: Native,
    call: AuthorityCallV1,
  ): Promise<VerifiedNonTurnInputV1 | Readonly<{ kind: "not-responsible" }>>;
  inspectNonTurn(
    handle: VerifiedNonTurnInputV1,
    call: AuthorityCallV1,
  ): Promise<ExactNonTurnIntakeV1 | JournalDeniedV1 | JournalUnavailableV1>;
}
export interface TurnJournalReadV1 {
  /** Read only. Exact same digest/class/relation/profile + committed incoming link
   * is required for responsibility ACK; not-found cannot retry or mutate a turn.
   */
  findNonTurnIntake(input: ExactNonTurnIntakeV1, call: AuthorityCallV1): Promise<NonTurnStateV1>;
}
export interface TurnJournalUnitOfWorkV1 {
  /** Same event namespace/journal. Equivalent-original may own sticky logical ignored;
   * related-only never claims its parent. No conversation/turn/reservation is created.
   */
  admitNonTurn(
    input: VerifiedNonTurnInputV1,
    call: AuthorityCallV1,
  ): Promise<
    | Readonly<{ kind: "recorded"; receipt: NonTurnReceiptV1 }>
    | Readonly<{ kind: "not-responsible" }>
  >;
}
const nonTurnCommon = {
  schemaVersion: one,
  installationRef: ref,
  channelInstallationRef: ref,
  platform: Type.Enum(["slack", "msteams"]),
  providerTenantRef: ref,
  recipientAppRef: ref,
  eventKey: digest,
  eventDigest: digest,
  normalizationProfileRef: ref,
};
export const ExactNonTurnIntakeSchemaV1 = Type.Union([
  object({
    ...nonTurnCommon,
    classification: Type.Enum(["bot-original", "unaddressed-original"]),
    logicalMessage: object({
      kind: Type.Literal("equivalent-original"),
      logicalMessageKey: digest,
    }),
  }),
  object({
    ...nonTurnCommon,
    classification: Type.Enum(["edit", "delete", "reaction"]),
    logicalMessage: object({ kind: Type.Literal("related-only"), logicalMessageKey: digest }),
  }),
  object({
    ...nonTurnCommon,
    classification: Type.Literal("typing-control"),
    logicalMessage: tag("not-applicable"),
  }),
]);
export const NonTurnReceiptSchemaV1 = object({
  schemaVersion: one,
  receiptRef: ref,
  intake: ExactNonTurnIntakeSchemaV1,
  disposition: Type.Enum(["ignored", "conflict"]),
  incomingLinkRef: ref,
  originalReceiptRefs: Type.Array(ref, { maxItems: 2, uniqueItems: true }),
  auditIntentRef: ref,
});
export function parseNonTurnIntakeV1(input: unknown): ExactNonTurnIntakeV1 {
  try {
    const value = snapshot(input);
    if (!Check(ExactNonTurnIntakeSchemaV1, value)) invalid();
    checkIntrinsic(value);
    return frozen(value) as ExactNonTurnIntakeV1;
  } catch {
    return invalid();
  }
}
export function parseNonTurnReceiptV1(input: unknown): NonTurnReceiptV1 {
  try {
    const value = snapshot(input);
    if (!Check(NonTurnReceiptSchemaV1, value)) invalid();
    checkIntrinsic(value);
    return frozen(value) as NonTurnReceiptV1;
  } catch {
    return invalid();
  }
}

/** Pure exact-link correlation. Requires an already authenticated journal read;
 * this function/JSON shape alone never establishes a committed receipt.
 */
export function nonTurnReceiptMatchesV1(
  input: ExactNonTurnIntakeV1,
  receipt: NonTurnReceiptV1,
): boolean {
  return same(parseNonTurnIntakeV1(input), parseNonTurnReceiptV1(receipt).intake);
}

/** Selected trusted owners resolve these locators against protected current state
 * and actual native/store evidence. Resolution is not caller attestation. Each
 * inspect rechecks issuer membership, recipient, original actor/target, exact
 * record versions and actual authority inside the accepting transaction. The
 * provenance service implements no competing journal, checkpoint writer or verifier.
 */
export interface JournalEvidenceProvenanceV1 {
  /** Optional only for unselected adapters. Missing native provenance refuses the
   * selected branch. Implementations inspect actual original transport custody,
   * clock correspondence and current purpose again after accepting locks. */
  inspectExecutionStart?(
    handle: VerifiedExecutionStartV1,
    call: AuthorityCallV1,
  ): Promise<JournalExecutionStartV1 | JournalDeniedV1 | JournalUnavailableV1>;
  inspectExecutionInterruption?(
    handle: VerifiedExecutionInterruptionV1,
    call: AuthorityCallV1,
  ): Promise<ExactExecutionInterruptionV1 | JournalDeniedV1 | JournalUnavailableV1>;

  authorizeDispatch(
    attempt: ExactAttemptV1,
    call: AuthorityCallV1,
  ): Promise<AuthorizedDispatchV1 | JournalDeniedV1 | JournalUnavailableV1>;
  inspectDispatch(
    handle: AuthorizedDispatchV1,
    call: AuthorityCallV1,
  ): Promise<JournalAttemptBindingV1 | JournalDeniedV1 | JournalUnavailableV1>;
  authorizeConsumption(
    operation: ExactConsumptionOperationV1,
    call: AuthorityCallV1,
  ): Promise<VerifiedConsumptionV1 | JournalDeniedV1 | JournalUnavailableV1>;
  inspectConsumption(
    handle: VerifiedConsumptionV1,
    call: AuthorityCallV1,
  ): Promise<
    | Readonly<{
        operation: ExactConsumptionOperationV1;
        binding: JournalAttemptBindingV1;
        /** Selected by the original consumption authority; the writer supplies its clock. */
        executionSelection?: JournalExecutionSelectionV1;
        /** Historical input is explicitly refused for new selected writes. */
        executionIntent?: JournalExecutionIntentV1;
      }>
    | JournalDeniedV1
    | JournalUnavailableV1
  >;
  verifyCompletion(
    operation: ExactCompletionOperationV1,
    call: AuthorityCallV1,
  ): Promise<VerifiedCompletionPublicationV1 | JournalDeniedV1 | JournalUnavailableV1>;
  inspectCompletion(
    handle: VerifiedCompletionPublicationV1,
    call: AuthorityCallV1,
  ): Promise<JournalCompletionObservationV1 | JournalDeniedV1 | JournalUnavailableV1>;
  verifyRelease(
    attempt: ExactAttemptV1,
    releaseOperationRef: string,
    call: AuthorityCallV1,
  ): Promise<VerifiedNoMutatorReleaseV1 | JournalDeniedV1 | JournalUnavailableV1>;
  inspectRelease(
    handle: VerifiedNoMutatorReleaseV1,
    call: AuthorityCallV1,
  ): Promise<JournalReleaseObservationV1 | JournalDeniedV1 | JournalUnavailableV1>;
  verifyOutcome(
    operation: ExactOutcomeOperationV1,
    call: AuthorityCallV1,
  ): Promise<VerifiedOutcomeV1 | JournalDeniedV1 | JournalUnavailableV1>;
  inspectOutcome(
    handle: VerifiedOutcomeV1,
    call: AuthorityCallV1,
  ): Promise<ExactOutcomeOperationV1 | JournalDeniedV1 | JournalUnavailableV1>;
  /** Resolve immutable output reference/digest to its exact authorized bytes and
   * fixed status classification. New status reservations require classification;
   * legacy absence cannot be inferred from current state or a generic status slot.
   * The accepting journal also checks the canonical outcome/version and retained
   * predecessor. A classified unknown create must have been accepted as unknown
   * and positively delivered before one exact known-ID reconciliation update.
   * Resolved-completed requires actual canonical checkpoint publication, never
   * native success alone. Current audience/destination, deadline and one-update
   * limits remain independent; serialized classification is not trusted proof.
   */
  authorizeDelivery(
    operation: ExactDeliveryOperationV1,
    call: AuthorityCallV1,
  ): Promise<VerifiedDeliveryV1 | JournalDeniedV1 | JournalUnavailableV1>;
  inspectDelivery(
    handle: VerifiedDeliveryV1,
    call: AuthorityCallV1,
  ): Promise<ExactDeliveryOperationV1 | JournalDeniedV1 | JournalUnavailableV1>;
  authorizeCancellation(
    operation: ExactCancellationOperationV1,
    call: AuthorityCallV1,
  ): Promise<VerifiedCancellationV1 | JournalDeniedV1 | JournalUnavailableV1>;
  inspectCancellation(
    handle: VerifiedCancellationV1,
    call: AuthorityCallV1,
  ): Promise<ExactCancellationOperationV1 | JournalDeniedV1 | JournalUnavailableV1>;
}

export type {
  HostedChannelEnvelopeV1,
  HostedChannelAdmissionDependenciesV1,
  HostedChannelAdmissionDecisionV1,
  HostedChannelReceiptV1,
  HostedChannelIntakeLocatorV1,
} from "openclaw/plugin-sdk/channel-inbound";

export type ExactIncomingLinkV1 = Readonly<{
  locator: HostedChannelIntakeLocatorV1;
  incomingEventDigest: JournalDigestV1;
  incomingContentDigest: JournalDigestV1;
  /** Protected verifier/resolver digest of the complete immutable incoming
   * actor/target/route/grant/workspace identity, not the original owner's data.
   */
  incomingIdentityDigest: JournalDigestV1;
}>;
export type IncomingLinkStateV1 =
  | Readonly<{ kind: "found"; link: IncomingAdmissionLinkV1; original: AdmissionRecordV1 }>
  | Readonly<{
      kind: "found-rejected";
      link: IncomingAdmissionLinkV1;
      original: RejectedAdmissionRecordV1;
    }>
  | Readonly<{ kind: "found-non-turn"; link: IncomingAdmissionLinkV1; original: NonTurnReceiptV1 }>
  | JournalAbsentV1
  | JournalDeniedV1
  | JournalUnavailableV1;
export interface TurnJournalReadV1 {
  /** findAdmission discovers an original owner; it cannot establish a changed
   * payload/twin's incoming link. This exact read is required for uncertain ACK.
   */
  findIncomingLink(input: ExactIncomingLinkV1, call: AuthorityCallV1): Promise<IncomingLinkStateV1>;
}

export const ExactIncomingLinkSchemaV1 = object({
  locator: sdkLocator,
  incomingEventDigest: digest,
  incomingContentDigest: digest,
  incomingIdentityDigest: digest,
});
export const RejectedAdmissionRecordSchemaV1 = object({
  schemaVersion: one,
  envelope: Type.Unknown(),
  receipt: sdkReceipt,
  decision: object({
    kind: Type.Literal("denied"),
    reason: Type.Enum(["not-current", "unsupported", "unavailable"]),
  }),
  decisionRef: ref,
  auditIntentRef: ref,
  decidedAt: instant,
});
const failures = [tag("conflict"), tag("denied"), tag("unavailable")];
const absentFailures = [tag("absent"), tag("denied"), tag("unavailable")];
const deliveryState = Type.Union([
  object({ kind: Type.Enum(["recorded", "existing"]), record: ExactDeliveryOutcomeSchemaV1 }),
  object({ kind: Type.Literal("pending"), operation: ExactDeliveryOperationSchemaV1 }),
  ...failures,
]);
/** Wire states never contain PendingInitiationClaimV1 or any provenance handle. */
export const TurnJournalResultSchemasV1 = Object.freeze({
  rejectedAdmissionState: Type.Union([
    object({ kind: Type.Literal("found"), record: RejectedAdmissionRecordSchemaV1 }),
    ...absentFailures,
  ]),
  rejectedAdmissionResult: Type.Union([
    object({
      kind: Type.Enum(["recorded", "existing"]),
      record: RejectedAdmissionRecordSchemaV1,
      incomingLink: IncomingAdmissionLinkSchemaV1,
    }),
    object({
      kind: Type.Literal("resolved-existing"),
      record: AdmissionRecordSchemaV1,
      incomingLink: IncomingAdmissionLinkSchemaV1,
    }),
    object({
      kind: Type.Literal("non-turn-owned"),
      original: NonTurnReceiptSchemaV1,
      incomingLink: IncomingAdmissionLinkSchemaV1,
    }),
    object({
      kind: Type.Literal("conflict"),
      originalReceipt: sdkReceipt,
      incomingLink: IncomingAdmissionLinkSchemaV1,
    }),
    tag("unavailable"),
  ]),
  admissionState: Type.Union([
    object({ kind: Type.Literal("found"), record: AdmissionRecordSchemaV1 }),
    object({ kind: Type.Literal("found-rejected"), record: RejectedAdmissionRecordSchemaV1 }),
    object({ kind: Type.Literal("found-non-turn"), receipt: NonTurnReceiptSchemaV1 }),
    ...absentFailures,
  ]),
  admissionResult: Type.Union([
    object({
      kind: Type.Literal("non-turn-owned"),
      original: NonTurnReceiptSchemaV1,
      incomingLink: IncomingAdmissionLinkSchemaV1,
    }),
    object({
      kind: Type.Literal("rejected-existing"),
      record: RejectedAdmissionRecordSchemaV1,
      incomingLink: IncomingAdmissionLinkSchemaV1,
    }),
    object({
      kind: Type.Literal("recorded"),
      record: AdmissionRecordSchemaV1,
      incomingLink: IncomingAdmissionLinkSchemaV1,
      duplicate: Type.Boolean(),
    }),
    object({
      kind: Type.Literal("conflict"),
      incomingLink: IncomingAdmissionLinkSchemaV1,
      originalReceipt: sdkReceipt,
    }),
    tag("denied"),
    tag("unavailable"),
  ]),
  attemptState: Type.Union([
    object({ kind: Type.Literal("found"), record: AttemptRecordSchemaV1 }),
    ...absentFailures,
  ]),
  completionState: Type.Union([
    object({ kind: Type.Literal("published"), record: CompletionRecordSchemaV1 }),
    tag("absent"),
    ...failures,
  ]),
  completionHead: Type.Union([
    object({ kind: Type.Literal("new-context"), head: ExpectedCompletionHeadSchemaV1 }),
    object({
      kind: Type.Literal("completed"),
      head: ExpectedCompletionHeadSchemaV1,
      checkpoint: CheckpointRefSchemaV1,
    }),
    object({
      kind: Type.Literal("unavailable"),
      reason: Type.Enum(["unresolved-work", "retired", "store-unavailable"]),
    }),
  ]),
  dispatchIntent: Type.Union([
    object({
      kind: Type.Enum(["recorded", "existing"]),
      record: DispatchBoundAttemptRecordSchemaV1,
    }),
    ...failures,
  ]),
  checkpointAllocationState: Type.Union([
    object({ kind: Type.Literal("found"), allocation: ExactCheckpointAllocationSchemaV1 }),
    ...absentFailures,
  ]),
  cancellationState: Type.Union([
    object({
      kind: Type.Literal("found"),
      operation: ExactCancellationOperationSchemaV1,
      outcome: Type.Enum(["requested", "cancelled-before-dispatch"]),
    }),
    ...absentFailures,
  ]),
  releaseState: Type.Union([
    object({ kind: Type.Literal("released"), observation: JournalReleaseObservationSchemaV1 }),
    ...absentFailures,
  ]),
  checkpointAllocation: Type.Union([
    object({
      kind: Type.Enum(["allocated", "existing"]),
      allocation: ExactCheckpointAllocationSchemaV1,
    }),
    ...failures,
  ]),
  completionPublication: Type.Union([
    object({ kind: Type.Enum(["published", "existing"]), record: CompletionRecordSchemaV1 }),
    ...failures,
  ]),
  outcome: Type.Union([
    object({ kind: Type.Enum(["recorded", "existing"]), record: AttemptRecordSchemaV1 }),
    ...failures,
  ]),
  cancellation: Type.Union([
    object({
      kind: Type.Enum(["recorded", "existing"]),
      operation: ExactCancellationOperationSchemaV1,
      outcome: Type.Enum(["requested", "cancelled-before-dispatch"]),
    }),
    tag("too-late"),
    ...failures,
  ]),
  release: Type.Union([
    object({ kind: Type.Enum(["released", "existing"]), releaseOperationRef: ref }),
    tag("held"),
    ...failures,
  ]),
  delivery: deliveryState,
  deliveryReservation: Type.Union([
    object({
      kind: Type.Literal("reserved"),
      operation: ExactDeliveryOperationSchemaV1,
      deliveryAttemptRef: ref,
      attemptNumber: Type.Integer({ minimum: 1, maximum: 3 }),
      episodeStartedAt: instant,
    }),
    object({ kind: Type.Literal("existing"), state: deliveryState }),
    ...failures,
  ]),
  incomingLink: Type.Union([
    object({
      kind: Type.Literal("found-non-turn"),
      link: IncomingAdmissionLinkSchemaV1,
      original: NonTurnReceiptSchemaV1,
    }),
    object({
      kind: Type.Literal("found-rejected"),
      link: IncomingAdmissionLinkSchemaV1,
      original: RejectedAdmissionRecordSchemaV1,
    }),
    object({
      kind: Type.Literal("found"),
      link: IncomingAdmissionLinkSchemaV1,
      original: AdmissionRecordSchemaV1,
    }),
    ...absentFailures,
  ]),
  nonTurn: Type.Union([
    object({ kind: Type.Literal("found"), receipt: NonTurnReceiptSchemaV1 }),
    object({ kind: Type.Enum(["not-found", "denied", "unavailable", "unknown"]) }),
  ]),
  nonTurnResponsibility: Type.Union([
    object({ kind: Type.Literal("committed"), receipt: NonTurnReceiptSchemaV1 }),
    object({ kind: Type.Literal("unknown"), locator: ExactNonTurnIntakeSchemaV1 }),
    tag("not-responsible"),
  ]),
});
export interface TurnJournalResultValuesV1 {
  rejectedAdmissionState: RejectedAdmissionStateV1;
  rejectedAdmissionResult: RejectedAdmissionResultV1;
  admissionState: AdmissionStateV1;
  admissionResult: AdmissionResultV1;
  attemptState: AttemptStateV1;
  completionState: CompletionStateV1;
  completionHead: CompletionHeadV1;
  dispatchIntent: DispatchIntentResultV1;
  checkpointAllocation: CheckpointAllocationResultV1;
  checkpointAllocationState: CheckpointAllocationStateV1;
  cancellationState: CancellationStateV1;
  releaseState: ReservationReleaseStateV1;
  completionPublication: CompletionPublicationResultV1;
  outcome: OutcomeResultV1;
  cancellation: CancellationResultV1;
  release: ReservationReleaseResultV1;
  delivery: DeliveryStateV1;
  deliveryReservation: DeliveryReservationResultV1;
  incomingLink: IncomingLinkStateV1;
  nonTurn: NonTurnStateV1;
  nonTurnResponsibility: NonTurnResponsibilityV1;
}
export function parseTurnJournalResultV1<K extends keyof TurnJournalResultValuesV1>(
  kind: K,
  input: unknown,
): TurnJournalResultValuesV1[K] {
  try {
    if (!Object.hasOwn(TurnJournalResultSchemasV1, kind)) invalid();
    const value = snapshot(input);
    if (!Check(TurnJournalResultSchemasV1[kind] as TSchema, value)) invalid();
    checkIntrinsic(value);
    if (kind === "dispatchIntent") {
      const result = value as DispatchIntentResultV1;
      if (result.kind === "recorded" || result.kind === "existing") {
        const outcome = result.record.outcome;
        if (
          (result.kind === "recorded" && outcome.kind !== "dispatch-intent") ||
          outcome.kind === "accepted-undispatched" ||
          ("stage" in outcome && outcome.stage === "before-dispatch")
        )
          invalid();
      }
    }
    return frozen(value) as TurnJournalResultValuesV1[K];
  } catch {
    return invalid();
  }
}
export function parseExactIncomingLinkV1(input: unknown): ExactIncomingLinkV1 {
  try {
    const value = snapshot(input);
    if (!Check(ExactIncomingLinkSchemaV1, value)) invalid();
    checkIntrinsic(value);
    return frozen(value) as ExactIncomingLinkV1;
  } catch {
    return invalid();
  }
}

/** A verified native event can fail human/target resolution. Retaining that denial
 * must not invent a principal, Namespace, Agent, context, head or reservation.
 * This record occupies the SAME event/logical-owner indexes and stays negative
 * after later provisioning/policy changes. Its decoder confers no authority.
 */
export type RejectedAdmissionRecordV1 = Readonly<{
  schemaVersion: 1;
  envelope: import("openclaw/plugin-sdk/channel-inbound").ChannelEnvelopeV1;
  receipt: HostedChannelReceiptV1;
  decision: Readonly<{ kind: "denied"; reason: "not-current" | "unsupported" | "unavailable" }>;
  decisionRef: string;
  auditIntentRef: string;
  decidedAt: JournalInstantV1;
}>;
declare const rejectedAdmissionProvenance: unique symbol;
export interface VerifiedRejectedAdmissionV1 {
  readonly [rejectedAdmissionProvenance]: true;
}
export interface JournalAdmissionProvenanceV1<Native> {
  /** Same real verifier plus current denial disposition. No fallback verifier and
   * no handle for unauthenticated/unstable intake. This cannot mint turn authority.
   */
  authenticateRejected(
    native: Native,
    call: AuthorityCallV1,
  ): Promise<VerifiedRejectedAdmissionV1 | JournalDeniedV1 | JournalUnavailableV1>;
  inspectRejected(
    handle: VerifiedRejectedAdmissionV1,
    call: AuthorityCallV1,
  ): Promise<RejectedAdmissionRecordV1 | JournalDeniedV1 | JournalUnavailableV1>;
}
export type RejectedAdmissionResultV1 =
  | Readonly<{
      kind: "recorded" | "existing";
      record: RejectedAdmissionRecordV1;
      incomingLink: IncomingAdmissionLinkV1;
    }>
  | Readonly<{
      kind: "resolved-existing";
      record: AdmissionRecordV1;
      incomingLink: IncomingAdmissionLinkV1;
    }>
  | Extract<AdmissionResultV1, { kind: "conflict" | "non-turn-owned" }>
  | JournalUnavailableV1;
export type RejectedAdmissionStateV1 =
  | Readonly<{ kind: "found"; record: RejectedAdmissionRecordV1 }>
  | JournalAbsentV1
  | JournalDeniedV1
  | JournalUnavailableV1;
export interface TurnJournalUnitOfWorkV1 {
  /** Same transaction and owner indexes; no separate negative-event journal.
   * Exact retries retain the original denied, resolved or non-turn owner. Current
   * denial never rewrites a historical decision or grants execution. Changed
   * facts retain both original owners and only add the exact incoming conflict.
   */
  admitRejected(
    input: VerifiedRejectedAdmissionV1,
    call: AuthorityCallV1,
  ): Promise<RejectedAdmissionResultV1>;
}
export interface TurnJournalReadV1 {
  findRejectedAdmission(
    input: ExactEventOrLogicalKeyV1,
    call: AuthorityCallV1,
  ): Promise<RejectedAdmissionStateV1>;
}
import {
  channelEnvelopeSchemaV1,
  hostedChannelEventKeyV1,
  hostedChannelRouteKeyV1,
} from "openclaw/plugin-sdk/channel-inbound";
export function parseRejectedAdmissionV1(input: unknown): RejectedAdmissionRecordV1 {
  try {
    const value = snapshot(input);
    if (!Check(RejectedAdmissionRecordSchemaV1, value)) invalid();
    const record = value as RejectedAdmissionRecordV1;
    if (
      !channelEnvelopeSchemaV1.safeParse(record.envelope).success ||
      !hostedReceiptSchemaV1.safeParse(record.receipt).success
    )
      invalid();
    if (
      hostedChannelEventKeyV1(record.envelope) !== record.receipt.eventKey ||
      record.envelope.event.eventDigest !== record.receipt.eventDigest ||
      record.envelope.message.contentDigest !== record.receipt.contentDigest ||
      record.envelope.message.logicalMessageKey !== record.receipt.logicalMessageKey
    )
      invalid();
    // Apply the same intrinsic bounds in standalone and nested result codecs.
    // The SDK envelope retains its own timestamp vocabulary and must not recurse
    // through the journal's envelope dispatch again.
    checkIntrinsic(
      Object.fromEntries(Object.entries(record).filter(([key]) => key !== "envelope")),
    );
    return frozen(record);
  } catch {
    return invalid();
  }
}

export function parseTurnJournalJsonV1<K extends keyof TurnJournalWireValuesV1>(
  kind: K,
  input: string,
): TurnJournalWireValuesV1[K] {
  return parseTurnJournalV1(kind, readJournalJsonV1(input));
}
export function parseTurnJournalResultJsonV1<K extends keyof TurnJournalResultValuesV1>(
  kind: K,
  input: string,
): TurnJournalResultValuesV1[K] {
  return parseTurnJournalResultV1(kind, readJournalJsonV1(input));
}
export function parseNonTurnIntakeJsonV1(input: string): ExactNonTurnIntakeV1 {
  return parseNonTurnIntakeV1(readJournalJsonV1(input));
}
export function parseNonTurnReceiptJsonV1(input: string): NonTurnReceiptV1 {
  return parseNonTurnReceiptV1(readJournalJsonV1(input));
}
export function parseRejectedAdmissionJsonV1(input: string): RejectedAdmissionRecordV1 {
  return parseRejectedAdmissionV1(readJournalJsonV1(input));
}

import { createHash } from "node:crypto";
/** Content-free correlation digest, not an authentication proof. Allocation IDs,
 * receipt IDs, transport retry fields and mutable permission-observation versions
 * are deliberately excluded; the original semantic actor/target/content binding
 * is retained. The trusted resolver computes it before writing the incoming link.
 */
export function digestJournalAdmissionIdentityV1(input: JournalAdmissionIdentityV1): string {
  const i = parseTurnJournalV1("admissionIdentity", input);
  const binding = {
    domain: "turn-journal-incoming-identity-v1",
    installationRef: i.locator.installationRef,
    channelInstallationRef: i.locator.channelInstallationRef,
    eventKey: i.locator.eventKey,
    logicalMessageKey: i.locator.logicalMessageKey,
    eventDigest: i.receipt.eventDigest,
    contentDigest: i.receipt.contentDigest,
    profileConfigurationDigest: i.receipt.profileConfigurationDigest,
    context: i.context,
    principalRef: i.principalRef,
    providerSubjectRef: i.providerSubjectRef,
    externalIdentityBindingRef: i.externalIdentityBindingRef,
    routeKey: i.routeKey,
    workspace: i.workspace,
    commonGrantRef: i.commonGrantRef,
    replyDestinationRef: i.replyDestinationRef,
  };
  return createHash("sha256").update(canonical(binding), "utf8").digest("hex");
}
