import type { RevisionId, Timestamp } from "@openclaw-enterprise/contracts/api/common";
import type {
  AgentKeyV1,
  ExactAttemptV1,
} from "@openclaw-enterprise/contracts/completed-context-v1";
import type { ServicePrincipal } from "@openclaw-enterprise/contracts/identity/identity";
import type { LifecycleAdmissionAssociationV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type {
  CompletionRecordV1,
  ExactDeliveryOperationV1,
  ExactDeliveryOutcomeV1,
} from "@openclaw-enterprise/contracts/turn-journal-v1";
import type { TurnCommandOwnedUnitV1 } from "../ports/turn-command.ts";

/** Inactive declarations. No decoder, token factory, repository, issuer, dispatch
 * callback or positive authority implementation is installed by this module.
 * Brands distinguish data domains only; the original owner authenticates custody.
 */
declare const workValue: unique symbol;
type WorkValue<Name extends string, Value> = Value & { readonly [workValue]: Name };
export type WorkRefV2 = WorkValue<"logical-work", string>;
export type WorkOperationRefV2 = WorkValue<"work-operation", string>;
export type WorkInvocationRefV2 = WorkValue<"work-invocation", string>;
export type WorkDeliveryRefV2 = WorkValue<"work-delivery", string>;
export type WorkCandidateRefV2 = WorkValue<"work-inert-candidate", string>;
export type WorkReleaseRefV2 = WorkValue<"work-activation-release", string>;
export type WorkDigestV2 = WorkValue<"sha256", string>;
export type WorkRevisionV2 = WorkValue<"positive-work-revision", number>;
export type WorkWithdrawalRevisionV2 = WorkValue<"withdrawal-revision", number>;
export type WorkInstantV2 = WorkValue<"canonical-finite-timestamp", Timestamp>;
export type WorkDurationMsV2 = WorkValue<"finite-nonnegative-duration-ms", number>;

export type WorkScopeV2 = AgentKeyV1 & Readonly<{ revisionRef: RevisionId }>;
export type VersionedWorkRefV2 = Readonly<{ workRef: WorkRefV2; revision: WorkRevisionV2 }>;
export type WorkProfileRefV2 = Readonly<{ ref: string; revision: string }>;

/** Original supplier resolves the complete ordered ancestry. This projection is
 * not a read lock, authenticated completeness claim, or parent execution lease.
 */
export type WorkLineageMemberV2 = Readonly<{
  work: VersionedWorkRefV2;
  originalHorizon: WorkInstantV2;
  state: "open" | "closed";
  withdrawalRevision: WorkWithdrawalRevisionV2;
}>;
export type WorkLineageV2 = Readonly<{
  scope: WorkScopeV2;
  own: WorkLineageMemberV2;
  membershipProfile: WorkProfileRefV2;
}> &
  (
    | Readonly<{
        kind: "root";
        rootWorkRef: WorkRefV2;
        parentWorkRef: null;
        ancestors: readonly [];
      }>
    | Readonly<{
        kind: "attached-child";
        rootWorkRef: WorkRefV2;
        parentWorkRef: WorkRefV2;
        ancestors: readonly [WorkLineageMemberV2, ...WorkLineageMemberV2[]];
      }>
  );

/** Preserve the full journal attempt; no Work/queue/claim/locator aliasing. */
export type WorkExecutionAssociationV2 = Readonly<{
  attempt: ExactAttemptV1;
  assignmentRef: string;
  assignmentVersion: string;
  executionIncarnationRef: string;
  executionGeneration: string;
  receiverRef: string;
  protectedOriginRef: string;
  executionProfile: WorkProfileRefV2;
  predecessor:
    | Readonly<{ kind: "none" }>
    | Readonly<{
        kind: "terminated-original";
        attempt: ExactAttemptV1;
        assignmentRef: string;
        executionIncarnationRef: string;
        terminationEvidenceRef: string;
      }>;
}>;

/** Supported contracts exports provide WorkOwnerValueV2 and WorkInvocationValueV2
 * as types only. Keep diagnostic bindings explicit and unbound slots at never.
 * Export availability does not bind these slots or any private operand.
 * Do not duplicate their schemas or bypass the package boundary with a
 * cross-package relative source import.
 */
export interface WorkDiagnosticBindingsV2 {
  readonly owner: unknown;
  readonly invocation: unknown;
}
type MissingDiagnostics = { readonly [K in keyof WorkDiagnosticBindingsV2]: never };

export type WorkOriginalOperationV2 = Readonly<{
  operationRef: WorkOperationRefV2;
  requestDigest: WorkDigestV2;
  invocationRef: WorkInvocationRefV2;
  scope: WorkScopeV2;
}>;
export type WorkInvocationRequestV2<D extends WorkDiagnosticBindingsV2 = MissingDiagnostics> =
  WorkOriginalOperationV2 &
    Readonly<{
      operation: "work.invoke";
      diagnostics: D["invocation"];
      originalPayloadDigest: WorkDigestV2;
      objectiveRef: string;
      purposeRef: string;
      ceiling: WorkProfileRefV2;
      originalCallDeadline: WorkInstantV2;
      cancellationScopeRef: string;
    }>;

export type WorkServiceOperationV2 =
  | "work.admit"
  | "work.child.admit"
  | "work.authority.issue"
  | "work.authority.renew"
  | "work.model.generate"
  | "work.repository-token.issue"
  | "work.repository.use"
  | "work.repository.publish"
  | "work.delivery.submit"
  | "work.delivery.observe";
/** Closed repository-use comparison data. The constructor selects the protocol;
 * this record supplies neither the original operation nor its authority. */
export type WorkRepositoryProtocolVersionV2 = 2 | 3;
/** Fixed options preserve one trusted literal selection across generic assembly. */
export type WorkRepositoryProtocolOptionsV2<V extends WorkRepositoryProtocolVersionV2 = 2> = {
  readonly protocolVersion?: V;
} & (V extends 2 ? { readonly protocolVersion?: 2 } : { readonly protocolVersion: 3 }) &
  ([WorkRepositoryProtocolVersionV2] extends [V] ? never : unknown);
/** A trusted constructor chooses one literal profile before receiving requests. */
export type WorkRepositoryProtocolSelectionV2<V extends WorkRepositoryProtocolVersionV2 = 2> =
  (V extends 2 ? [options?: { protocolVersion?: 2 }] : [options: { protocolVersion: 3 }]) &
    ([WorkRepositoryProtocolVersionV2] extends [V] ? never : unknown);
export type WorkRepositoryPolicyArmV2<V extends WorkRepositoryProtocolVersionV2 = 2> = V extends 3
  ? Readonly<{
      repositoryOperation: "git:read";
      requiredPermissions: readonly ["contents:read", "metadata:read"];
    }>
  : Readonly<{ permission: "metadata:read" }>;
/** Exact retained Git request declaration, distinct from physical body custody. */
export interface WorkRepositoryGitReadV3 {
  readonly version: 3;
  readonly operation: "git:read";
  readonly gitOperation: "discovery" | "upload-pack";
  readonly gitProtocol: "version=2";
  readonly bodyBytes: number;
  readonly bodySha256: string;
  readonly requestDigest: string;
}
export type WorkPolicyIntentV2 = WorkOriginalOperationV2 &
  Readonly<{
    work: VersionedWorkRefV2;
    servicePrincipal: ServicePrincipal;
    purposeRef: string;
    ceiling: WorkProfileRefV2;
    originalHorizon: WorkInstantV2;
    dataEligibilityRef: string;
    executionProfile: WorkProfileRefV2;
  }> &
  (
    | Readonly<{ operation: "work.admit" | "work.child.admit"; phase: "original" }>
    | Readonly<{
        operation: "work.authority.issue" | "work.authority.renew";
        phase: "original" | "activation";
      }>
    | Readonly<{
        operation: "work.repository.use";
        phase: "preparation" | "dispatch" | "check";
        repository: Readonly<{
          id: string;
          owner: string;
          name: string;
          profile: WorkProfileRefV2;
        }>;
        execution: WorkExecutionAssociationV2;
        attachmentRef: string;
        receiverRef: string;
      }>
  );
/** Repository use is independently evaluated. Token issuance and authority
 * renewal cannot substitute for preparation, committed dispatch or online use.
 */
export type WorkRepositoryUseIntentV2 = Extract<
  WorkPolicyIntentV2,
  { operation: "work.repository.use" }
>;
/** V3 is an explicit separate authority arm; token issue/renewal is insufficient. */
export type WorkRepositoryUseIntentV3 = WorkRepositoryUseIntentV2 &
  Readonly<{
    protocolVersion: 3;
    repositoryOperation: "git:read";
    requiredPermissions: readonly ["contents:read", "metadata:read"];
    repositoryRequest: WorkRepositoryGitReadV3;
  }>;
export type WorkAdmissionCandidateV2<D extends WorkDiagnosticBindingsV2 = MissingDiagnostics> =
  WorkOriginalOperationV2 &
    Readonly<{
      owner: ServicePrincipal;
      ownerDiagnostics: D["owner"];
      invocationDiagnostics: D["invocation"];
      objectiveRef: string;
      purposeRef: string;
      ceiling: WorkProfileRefV2;
      dataEligibilityRef: string;
      cancellationScopeRef: string;
      lifecycleAssociation:
        | Readonly<{ kind: "none" }>
        | Readonly<{ kind: "original"; association: LifecycleAdmissionAssociationV1 }>;
      execution:
        | Readonly<{ kind: "nonexecuting" }>
        | Readonly<{ kind: "original-attempt"; association: WorkExecutionAssociationV2 }>;
    }> &
    (
      | Readonly<{
          operation: "work.admit";
          lineage: Extract<WorkLineageV2, { kind: "root" }>;
        }>
      | Readonly<{
          operation: "work.child.admit";
          lineage: Extract<WorkLineageV2, { kind: "attached-child" }>;
        }>
    );

/** Current withdrawal is independent of historical computation closure. */
export type WorkComputationStateV2 =
  | Readonly<{ kind: "open" }>
  | Readonly<{
      kind: "sealed";
      computationSealRef: string;
      requiredJoinSet: WorkProfileRefV2;
      effectResolutionCutRef: string;
      completion: CompletionRecordV1;
      outputRef: string;
      outputDigest: WorkDigestV2;
      completionCutRef: string;
    }>;
export type WorkHistoricalClosureV2 =
  | Readonly<{ kind: "open" }>
  | Readonly<{ kind: "closed"; closureRef: string; cause: "completed" | "cancelled" | "failed" }>;
export type WorkWithdrawalStateV2 =
  | Readonly<{ kind: "not-withdrawn-at-cut"; revision: WorkWithdrawalRevisionV2 }>
  | Readonly<{ kind: "withdrawn"; revision: WorkWithdrawalRevisionV2; withdrawalRef: string }>;

/** General Work closure carries the original policy's join/effect cut, including
 * an authenticated empty set where applicable. These references do not establish
 * completeness or resolution; the original held readset and owner do. No delivery,
 * successful computation, journal completion, attempt or output slot is required.
 * The discriminator distinguishes data records, not an admitted service operation.
 */
export type WorkGeneralClosureV2 = Readonly<{
  kind: "work-closure";
  original: WorkOriginalOperationV2;
  work: VersionedWorkRefV2;
  closure: Extract<WorkHistoricalClosureV2, { kind: "closed" }>;
  requiredJoinSet: WorkProfileRefV2;
  effectResolutionCutRef: string;
  protectedClosureEvidenceRef: string;
}>;

/** The original withdrawal comparison authenticates cause, scope and revision.
 * This request changes current withdrawal independently of historical closure;
 * it neither rewrites a completed closure nor manufactures a finite delivery.
 */
export type WorkGeneralWithdrawalV2 = Readonly<{
  kind: "work-withdrawal";
  original: WorkOriginalOperationV2;
  work: VersionedWorkRefV2;
  originalScopeRef: string;
  expectedWithdrawalRevision: WorkWithdrawalRevisionV2;
  cause: "explicit-work-cancel" | "ancestor-cancel" | "security-revocation" | "agent-disable";
  protectedCauseEvidenceRef: string;
}>;

export type WorkRefusalV2 =
  Readonly<{ kind: "denied" }> | Readonly<{ kind: "conflict" }> | Readonly<{ kind: "unavailable" }>;
export type WorkHeldResultV2<T> =
  | Readonly<{ kind: "held"; comparison: T }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "unavailable" }>;
export type WorkStagingResultV2<T, Staged> =
  | Readonly<{ kind: "provisional"; value: T; staged: Staged }>
  | Readonly<{ kind: "existing"; value: T }>
  | WorkRefusalV2;
export type WorkCommitResultV2<T, Recovery> =
  | Readonly<{ kind: "committed"; value: T }>
  | Readonly<{ kind: "commit-unknown"; originalRecovery: Recovery }>
  | Readonly<{ kind: "commit-rejected" }>
  | WorkRefusalV2;
export type WorkRecoveryExpectationV2 = Readonly<{
  original: WorkOriginalOperationV2;
  originalActorRef: string;
  lineage: WorkLineageV2;
  expectedResultDigest: WorkDigestV2;
  execution:
    | Readonly<{ kind: "nonexecuting" }>
    | Readonly<{ kind: "original-attempt"; association: WorkExecutionAssociationV2 }>;
}>;
/** Fresh authorized historical reads only after full original unwind. Even a
 * definitive noncommit does not override the original locator/submission policy.
 * No branch returns a journal claimant, replacement grant or replay callback.
 */
export type WorkRecoveryResultV2<T> =
  | Readonly<{ kind: "confirmed-committed"; expectation: WorkRecoveryExpectationV2; value: T }>
  | Readonly<{ kind: "definitively-not-committed"; expectation: WorkRecoveryExpectationV2 }>
  | Readonly<{ kind: "unconfirmed"; expectation: WorkRecoveryExpectationV2 }>
  | WorkRefusalV2;

/** Bind these slots to ORIGINAL implementation-owned types. The default is never,
 * not an object-shaped authority substitute. Type compatibility alone does not
 * authenticate any supplied object. The transaction owner retains private operation
 * recognition, security -> IAM -> parent -> issuer/root/ancestor/work locking,
 * caught/unawaited failure poisoning, drain, prepareCommit, final fencing, actual
 * COMMIT ACK and terminal cleanup. A consumer never releases a held participant.
 */
export interface WorkPrivateBindingsV2 {
  readonly nativeInvocation: unknown;
  readonly serviceCall: unknown;
  readonly invocationComparison: unknown;
  readonly policyComparison: unknown;
  readonly lineageReadSet: unknown;
  readonly stagedReceipt: unknown;
  readonly originalRecovery: unknown;
  readonly attemptAssociationRecovery: unknown;
  readonly freshReadCall: unknown;
  readonly enrolledHolder: unknown;
  readonly receiverActivationCall: unknown;
  readonly observationCall: unknown;
  readonly observationComparison: unknown;
  readonly providerEvidence: unknown;
  readonly deliveryAdmissionComparison: unknown;
  readonly withdrawalComparison: unknown;
}
type MissingPrivateBindings = { readonly [K in keyof WorkPrivateBindingsV2]: never };

export interface WorkInvocationComparisonPortV2<
  P extends WorkPrivateBindingsV2 = MissingPrivateBindings,
  D extends WorkDiagnosticBindingsV2 = MissingDiagnostics,
> {
  consume(
    originalUnit: TurnCommandOwnedUnitV1,
    nativeInvocation: P["nativeInvocation"],
    exactRequest: WorkInvocationRequestV2<D>,
  ): Promise<WorkHeldResultV2<P["invocationComparison"]> | Readonly<{ kind: "not-visible" }>>;
}
export interface WorkServicePolicyPortV2<P extends WorkPrivateBindingsV2 = MissingPrivateBindings> {
  acquireWorkPolicyV2(
    originalUnit: TurnCommandOwnedUnitV1,
    intent: WorkPolicyIntentV2,
    authenticatedCall: P["serviceCall"],
  ): Promise<WorkHeldResultV2<P["policyComparison"]>>;
}
export interface WorkAdmissionPortV2<
  P extends WorkPrivateBindingsV2 = MissingPrivateBindings,
  D extends WorkDiagnosticBindingsV2 = MissingDiagnostics,
> {
  readForMutation(
    originalUnit: TurnCommandOwnedUnitV1,
    expected: WorkOriginalOperationV2 & Readonly<{ lineage: WorkLineageV2 }>,
  ): Promise<WorkHeldResultV2<P["lineageReadSet"]> | Readonly<{ kind: "conflict" }>>;
  stageAdmissionV2(
    originalUnit: TurnCommandOwnedUnitV1,
    readSet: P["lineageReadSet"],
    invocation: P["invocationComparison"],
    policy: P["policyComparison"],
    candidate: Extract<WorkAdmissionCandidateV2<D>, { operation: "work.admit" }>,
  ): Promise<WorkStagingResultV2<WorkAdmissionCandidateV2<D>, P["stagedReceipt"]>>;
  /** The actual held parent/lineage and current child-admission policy supply
   * this path. It does not acquire a fictitious fresh human invocation. */
  stageChildAdmissionV2(
    originalUnit: TurnCommandOwnedUnitV1,
    readSet: P["lineageReadSet"],
    policy: P["policyComparison"],
    candidate: Extract<WorkAdmissionCandidateV2<D>, { operation: "work.child.admit" }>,
  ): Promise<WorkStagingResultV2<WorkAdmissionCandidateV2<D>, P["stagedReceipt"]>>;
  stageAttemptAssociationV2(
    originalUnit: TurnCommandOwnedUnitV1,
    readSet: P["lineageReadSet"],
    original: WorkOriginalOperationV2 & Readonly<{ work: VersionedWorkRefV2 }>,
    association: WorkExecutionAssociationV2,
  ): Promise<WorkStagingResultV2<WorkExecutionAssociationV2, P["stagedReceipt"]>>;
  recoverAfterUnwind(
    originalRecovery: P["originalRecovery"],
    freshReadCall: P["freshReadCall"],
  ): Promise<WorkRecoveryResultV2<WorkAdmissionCandidateV2<D>>>;
  /** Distinct original attempt-association recovery, after complete unwind.
   * Admission, issue and delivery recovery operands cannot substitute for it.
   */
  recoverAttemptAssociationAfterUnwind(
    originalAttemptRecovery: P["attemptAssociationRecovery"],
    freshReadCall: P["freshReadCall"],
  ): Promise<WorkRecoveryResultV2<WorkExecutionAssociationV2>>;
}

/** General Work-only staging under the original unit and held readset. The owner
 * compares exact operation/scope/Work revisions and protected closure or withdrawal
 * evidence. Provisional records and the original staged receipt are not COMMIT.
 * Existing finite compound delivery methods remain a separate port. No new Work
 * operation is added to the transaction owner's private recognizer by this declaration.
 */
export interface WorkGeneralLifecyclePortV2<
  P extends WorkPrivateBindingsV2 = MissingPrivateBindings,
> {
  stageSealAndCloseV2(
    originalUnit: TurnCommandOwnedUnitV1,
    readSet: P["lineageReadSet"],
    exactGeneralWorkClosure: WorkGeneralClosureV2,
  ): Promise<WorkStagingResultV2<WorkGeneralClosureV2, P["stagedReceipt"]>>;
  stageWithdrawalV2(
    originalUnit: TurnCommandOwnedUnitV1,
    readSet: P["lineageReadSet"],
    withdrawalComparison: P["withdrawalComparison"],
    exactGeneralWorkWithdrawal: WorkGeneralWithdrawalV2,
  ): Promise<WorkStagingResultV2<WorkGeneralWithdrawalV2, P["stagedReceipt"]>>;
}

/** Each own/ancestor operand is mandatory. The privately retained read set proves
 * which members apply; an array or flag does not. External-change anchors require
 * the actual delay contract as well as clock and enforcement uncertainty.
 */
export type WorkWithdrawalConstraintV2 = Readonly<{
  work: VersionedWorkRefV2;
  originalHorizon: WorkInstantV2;
  target: WorkProfileRefV2;
  profile: WorkProfileRefV2;
  anchor:
    | Readonly<{ kind: "withdrawal-commit"; anchorContractRef: string }>
    | Readonly<{
        kind: "external-change";
        anchorContractRef: string;
        maximumObservationDelayMs: WorkDurationMsV2;
      }>;
  targetMs: WorkDurationMsV2;
  clockAllowanceMs: WorkDurationMsV2;
  enforcementAllowanceMs: WorkDurationMsV2;
}>;
export type WorkCompleteConstraintsV2 = Readonly<{
  own: WorkWithdrawalConstraintV2;
  ancestors: readonly WorkWithdrawalConstraintV2[];
  selectedClassMaximumMs: WorkDurationMsV2;
  purposeDeadline: WorkInstantV2;
  originalCallDeadline: WorkInstantV2;
  stopDeadline: WorkInstantV2;
}>;
export type WorkIssueCandidateV2 = Readonly<{
  original: WorkOriginalOperationV2;
  candidateRef: WorkCandidateRefV2;
  candidateDigest: WorkDigestV2;
  originalIntent: "work.authority.issue" | "work.authority.renew";
  issuerIdentityRef: string;
  issuerIncarnationRef: string;
  issuerEpochRef: string;
  holderRef: string;
  receiverIncarnationRef: string;
  purposeRef: string;
  ceiling: WorkProfileRefV2;
  readProfile: WorkProfileRefV2;
  association: WorkExecutionAssociationV2;
  lineage: WorkLineageV2;
  constraints: WorkCompleteConstraintsV2;
  originalIssuedAt: WorkInstantV2;
  originalExpiresAt: WorkInstantV2;
  potentialExposureRef: string;
}>;
export type WorkActivationHistoryV2 = Readonly<{
  original: WorkOriginalOperationV2;
  candidateRef: WorkCandidateRefV2;
  candidateDigest: WorkDigestV2;
  releaseRef: WorkReleaseRefV2;
  issuedExposureRef: string;
}>;
export type WorkActivationResultV2<Recovery> =
  | Readonly<{ kind: "activated"; history: WorkActivationHistoryV2 }>
  | Readonly<{ kind: "suppressed" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "activation-unknown"; originalRecovery: Recovery }>;

/** Reservation COMMIT is inert. Separate receiver-authenticated transaction B
 * rechecks original policy/receiver/all constraints under the SAME closure locks.
 * Confirmed B COMMIT atomically records release/exposure/audit/outbox. Physical
 * transmission and local acceptance remain separate. Closure-first suppresses;
 * activation-first retains even possibly-unreceived exposure. Unknown B requires
 * original post-unwind history; neither recovery nor activation resets bounds.
 * No network/provider operation occurs inside either transaction.
 */
export interface WorkIssuePortV2<P extends WorkPrivateBindingsV2 = MissingPrivateBindings> {
  stageIssueOrRenewAgainstFenceV2(
    originalUnit: TurnCommandOwnedUnitV1,
    policy: P["policyComparison"],
    readSet: P["lineageReadSet"],
    enrolledHolder: P["enrolledHolder"],
    originalCandidate: WorkIssueCandidateV2,
  ): Promise<WorkStagingResultV2<WorkIssueCandidateV2, P["stagedReceipt"]>>;
  activateIssueV2(
    originalCandidateRef: WorkCandidateRefV2,
    receiverCall: P["receiverActivationCall"],
  ): Promise<WorkActivationResultV2<P["originalRecovery"]>>;
  readIssueActivationV2(
    originalRecovery: P["originalRecovery"],
    freshReadCall: P["freshReadCall"],
  ): Promise<WorkRecoveryResultV2<WorkActivationHistoryV2>>;
}

export type WorkDeliveryBoundsV2 = Readonly<{
  originalAdmittedAt: WorkInstantV2;
  originalDeliveryHorizon: WorkInstantV2;
  serviceCeiling: WorkProfileRefV2;
  episode:
    | Readonly<{ kind: "not-started" }>
    | Readonly<{ kind: "started"; originalEpisodeStartedAt: WorkInstantV2 }>;
  /** Existing V1 bounds, not a newly selected Work horizon or withdrawal target. */
  episodeLimitMs: 120000;
  maximumCreateAttempts: 3;
}>;
export type WorkDeliveryAttemptHistoryV2 = Readonly<{
  deliveryAttemptRef: string;
  attemptNumber: number;
  initial:
    Readonly<{ kind: "pending" }> | Readonly<{ kind: "recorded"; outcome: ExactDeliveryOutcomeV1 }>;
  /** Retain the initial unknown; later authenticated knowledge appends separately. */
  observations: readonly ExactDeliveryOutcomeV1[];
}>;
export type WorkDeliveryStateV2 = Readonly<{
  original: WorkOriginalOperationV2;
  work: VersionedWorkRefV2;
  deliveryRef: WorkDeliveryRefV2;
  destinationRef: string;
  audience: WorkProfileRefV2;
  cancellationScopeRef: string;
  bounds: WorkDeliveryBoundsV2;
  readiness:
    | Readonly<{ kind: "pending"; resultSlotRef: string }>
    | Readonly<{
        kind: "sealed";
        computation: Extract<WorkComputationStateV2, { kind: "sealed" }>;
      }>;
  historicalClosure: WorkHistoricalClosureV2;
  postingEligibility:
    | WorkWithdrawalStateV2
    | Readonly<{ kind: "expired"; boundRef: string }>
    | Readonly<{ kind: "unavailable" }>;
  history:
    | Readonly<{ kind: "unsubmitted" }>
    | Readonly<{
        kind: "submitted";
        operation: ExactDeliveryOperationV1;
        attempts: readonly [WorkDeliveryAttemptHistoryV2, ...WorkDeliveryAttemptHistoryV2[]];
      }>;
}>;
export type WorkDeliveryObservationV2 = Readonly<{
  observationOperation: WorkOriginalOperationV2;
  authorizationOperation: "work.delivery.observe";
  deliveryRef: WorkDeliveryRefV2;
  originalDeliveryOperation: ExactDeliveryOperationV1;
  deliveryAttemptRef: string;
  providerRef: string;
  expectedObservationRevision: WorkRevisionV2;
  evidenceDigest: WorkDigestV2;
}>;

export type WorkFiniteDeliveryAdmissionV2 = Readonly<{
  original: WorkOriginalOperationV2;
  work: VersionedWorkRefV2;
  deliveryRef: WorkDeliveryRefV2;
  resultSlotRef: string;
  owner: ServicePrincipal;
  destinationRef: string;
  audience: WorkProfileRefV2;
  cancellationScopeRef: string;
  originalAdmittedAt: WorkInstantV2;
  originalDeliveryHorizon: WorkInstantV2;
  serviceCeiling: WorkProfileRefV2;
}>;
export type WorkDeliverySealV2 = Readonly<{
  original: WorkOriginalOperationV2;
  work: VersionedWorkRefV2;
  deliveryRef: WorkDeliveryRefV2;
  expectedDeliveryRevision: WorkRevisionV2;
  computation: Extract<WorkComputationStateV2, { kind: "sealed" }>;
}>;
export type WorkDeliveryWithdrawalV2 = Readonly<{
  original: WorkOriginalOperationV2;
  work: VersionedWorkRefV2;
  deliveryRef: WorkDeliveryRefV2;
  originalScopeRef: string;
  expectedWithdrawalRevision: WorkWithdrawalRevisionV2;
  cause: "explicit-work-cancel" | "ancestor-cancel" | "security-revocation" | "agent-disable";
  protectedCauseEvidenceRef: string;
}>;

/** Original journal custody supplies persistence, not a new sender or queue.
 * Admission precedes or is atomic with closure; sealing binds original completion
 * once. A history read, existing receipt or withdrawal never transfers a send
 * claimant. The native send-only sink/one-use claimant signature remains an
 * explicit supplier dependency, so no reserve-and-initiate callback is invented.
 */
export interface WorkFiniteDeliveryPortV2<
  P extends WorkPrivateBindingsV2 = MissingPrivateBindings,
> {
  admitFiniteDeliveryV2(
    originalUnit: TurnCommandOwnedUnitV1,
    readSet: P["lineageReadSet"],
    admission: P["deliveryAdmissionComparison"],
    exact: WorkFiniteDeliveryAdmissionV2,
  ): Promise<WorkStagingResultV2<WorkFiniteDeliveryAdmissionV2, P["stagedReceipt"]>>;
  sealWorkAndDeliveryV2(
    originalUnit: TurnCommandOwnedUnitV1,
    readSet: P["lineageReadSet"],
    exact: WorkDeliverySealV2,
  ): Promise<WorkStagingResultV2<WorkDeliverySealV2, P["stagedReceipt"]>>;
  readDeliverySubmissionV2(
    originalRecovery: P["originalRecovery"],
    freshReadCall: P["freshReadCall"],
  ): Promise<WorkRecoveryResultV2<WorkDeliveryStateV2>>;
  withdrawWorkDeliveryV2(
    originalUnit: TurnCommandOwnedUnitV1,
    readSet: P["lineageReadSet"],
    withdrawal: P["withdrawalComparison"],
    exact: WorkDeliveryWithdrawalV2,
  ): Promise<WorkStagingResultV2<WorkDeliveryWithdrawalV2, P["stagedReceipt"]>>;
}

/** A fresh current scoped observation comparison survives no revocation of its
 * own rights. Closed/expired/withdrawn posting alone does not deny observation.
 * Append/audit uses the original unit and provider evidence; no claimant, provider
 * query, send, retry, renewal or reopened eligibility is returned.
 */
export interface WorkDeliveryObservationPortV2<
  P extends WorkPrivateBindingsV2 = MissingPrivateBindings,
> {
  acquireDeliveryObservationV2(
    originalUnit: TurnCommandOwnedUnitV1,
    exact: WorkDeliveryObservationV2,
    observerCall: P["observationCall"],
  ): Promise<WorkHeldResultV2<P["observationComparison"]>>;
  appendDeliveryObservationV2(
    originalUnit: TurnCommandOwnedUnitV1,
    observation: P["observationComparison"],
    exact: WorkDeliveryObservationV2,
    providerEvidence: P["providerEvidence"],
  ): Promise<WorkStagingResultV2<WorkDeliveryObservationV2, P["stagedReceipt"]>>;
}

/** Shared comparison emitted from a genuinely admitted service-owned Work.
 * State owns known admission COMMIT and privately recognizes the original
 * execution/requester association. Parsing this record never admits Work.
 * Read and publication consumers may share this association, not permissions. */
export interface WorkAdmittedExecutionV2 {
  readonly admissionOriginal: WorkOriginalOperationV2;
  readonly work: VersionedWorkRefV2;
  readonly owner: ServicePrincipal;
  readonly requesterPrincipalId: string;
  readonly invocationRef: WorkInvocationRefV2;
  readonly execution: WorkExecutionAssociationV2;
  readonly lineage: WorkLineageV2;
  readonly workBeganAt: WorkInstantV2;
  readonly originalHorizon: WorkInstantV2;
  readonly cancellationScopeRef: string;
  readonly authority: Readonly<{
    ref: string;
    revision: string;
    notBefore: WorkInstantV2;
    notAfter: WorkInstantV2;
  }>;
}

/** This platform permission is distinct from provider credential permissions.
 * Repository-read V2/V3 and token-issue grants cannot admit this operation. */
export type WorkPublicationIntentV1 = WorkOriginalOperationV2 &
  Readonly<{
    operation: "work.repository.publish";
    permission: "repository:publish";
    actions: readonly ["push", "create-draft-pr"];
    work: VersionedWorkRefV2;
    execution: WorkExecutionAssociationV2;
    requesterPrincipalId: string;
    authorityRef: string;
    authorityRevision: string;
    executionBindingDigest: WorkDigestV2;
  }>;
