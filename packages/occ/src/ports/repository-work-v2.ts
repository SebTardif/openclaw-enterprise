import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  WorkOriginalOperationV2,
  WorkExecutionAssociationV2,
  VersionedWorkRefV2,
  WorkRepositoryGitReadV3,
} from "../lifecycle/work-authority-ports-v2.ts";
import type {
  RepositoryTokenMutationV2,
  RepositoryTokenRecordV2,
  RepositoryInventoryOperationV2,
  RepositoryLeaseInventoryTransactionV2,
} from "../credential-inventory-v1/repository-lease-v2.ts";

/** Stored values are data. Only the construction-paired original Work source can
 * enroll an invocation and qualify a locked readset for this transaction. */
export type RepositoryWorkJsonV2 =
  | null
  | boolean
  | number
  | string
  | readonly RepositoryWorkJsonV2[]
  | { readonly [key: string]: RepositoryWorkJsonV2 };
export interface RepositoryWorkScopeV2 {
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionRef: string;
}
export interface RepositoryWorkRecordV2 {
  readonly scope: RepositoryWorkScopeV2;
  readonly workRef: string;
  readonly revision: number;
  readonly withdrawalRevision: number;
  readonly parentWorkRef: string | null;
  readonly rootWorkRef: string;
  readonly originalHorizon: string;
  readonly state: "open" | "closed";
  readonly execution: RepositoryWorkJsonV2;
  readonly policy: RepositoryWorkJsonV2;
  readonly originalAdmission: RepositoryWorkJsonV2;
}
export interface RepositoryWorkReadsetV2 {
  readonly scope: RepositoryWorkScopeV2;
  /** Complete root-to-own chain, including own exactly once. */
  readonly lineage: readonly RepositoryWorkRecordV2[];
}
export interface RepositoryWorkAdmissionV2 {
  readonly record: RepositoryWorkRecordV2;
}
export interface RepositoryWorkPreparationV2 {
  readonly workRef: string;
  readonly workRevision: number;
  readonly requestDigest: string;
  readonly receiverRef: string;
  readonly sessionRef: string;
  readonly dnsBindingRef: string;
  readonly repositoryTarget: RepositoryWorkJsonV2;
  /** Required for the original held Work's Git V3 policy arm, absent for V2.
   * The State owner compares this exact declaration through dispatch/fresh use;
   * body custody and native transmission remain with their original owners. */
  readonly repositoryRequest?: WorkRepositoryGitReadV3;
}
export interface RepositoryWorkDispatchV2 extends RepositoryWorkPreparationV2 {
  readonly preparationOperationRef: string;
  readonly workRef: string;
  readonly workRevision: number;
  readonly requestDigest: string;
  readonly receiverRef: string;
  readonly sessionRef: string;
  readonly dnsBindingRef: string;
  readonly repositoryTarget: RepositoryWorkJsonV2;
  readonly accessLeaseRef: string;
  readonly inventoryRecordRef: string;
  readonly inventoryVersion: number;
  readonly releaseRef: string;
}
export interface RepositoryWorkClosureV2 {
  readonly workRef: string;
  readonly expectedRevision: number;
  readonly expectedWithdrawalRevision: number;
  readonly cause: "completed" | "cancelled" | "failed" | "withdrawn";
  readonly evidenceRef: string;
}
export interface RepositoryWorkObservationV2 {
  readonly observationRef: string;
  readonly dispatchOperationRef: string;
  readonly outcome: "not-dispatched" | "completed" | "unknown";
  readonly evidenceRef: string;
}
export interface RepositoryWorkOperationV2 {
  readonly operationRef: string;
  readonly requestDigest: string;
  readonly invocationRef: string;
  readonly scope: RepositoryWorkScopeV2;
  readonly commitRef: string;
  readonly kind: "admission" | "preparation" | "dispatch" | "closure" | "observation";
  readonly document: RepositoryWorkJsonV2;
}
export type RepositoryWorkOperationReadV2 =
  | { readonly kind: "absent" }
  | { readonly kind: "recorded"; readonly operation: RepositoryWorkOperationV2 };
export interface RepositoryWorkHeldLeaseV2 {
  assertCurrent(): undefined;
  prepareCommit(): Promise<void>;
  release(): Promise<void>;
}
export interface RepositoryWorkTransactionContextV2 {
  readonly installationId: string;
  assertActive(): undefined;
  retain(lease: RepositoryWorkHeldLeaseV2): undefined;
}
/** Original State-retained inventory facts. Qualifiers recognize their own
 * operation/Work or independent observation responsibility; data is not admission. */
export interface RepositoryWorkInventoryFactsV2 {
  readonly input: RepositoryTokenMutationV2;
  readonly record: RepositoryTokenRecordV2 | undefined;
  readonly mintClaim: Awaited<ReturnType<RepositoryLeaseInventoryTransactionV2["findMintClaim"]>>;
  readonly revocationClaim: Awaited<
    ReturnType<RepositoryLeaseInventoryTransactionV2["findRevocationClaim"]>
  >;
  readonly readset: RepositoryWorkReadsetV2 | undefined;
}
export interface RepositoryWorkInventoryQualificationV2 {
  qualifyInventory?(facts: RepositoryWorkInventoryFactsV2): Promise<void>;
  qualifyInventoryRead?(operation: RepositoryInventoryOperationV2 | undefined): Promise<void>;
  qualifyMintUse?(
    operation: RepositoryInventoryOperationV2,
    currentRecord: RepositoryTokenRecordV2,
    readset: RepositoryWorkReadsetV2,
  ): Promise<void>;
  /** Independent cleanup/observation authority; no live user Work permission. */
  qualifyRevocationUse?(
    operation: RepositoryInventoryOperationV2,
    currentRecord: RepositoryTokenRecordV2,
  ): Promise<void>;
}
export interface RepositoryWorkSourceLeaseV2
  extends RepositoryWorkHeldLeaseV2, RepositoryWorkInventoryQualificationV2 {
  readonly actorId: string;
  qualifyReadset(originalReadset: RepositoryWorkReadsetV2): Promise<void>;
  qualifyAdmission(admission: RepositoryWorkAdmissionV2): Promise<void>;
  qualifyClosure(
    originalReadset: RepositoryWorkReadsetV2,
    closure: RepositoryWorkClosureV2,
  ): Promise<void>;
  qualifyObservation(
    operation: RepositoryWorkOperationV2,
    observation: RepositoryWorkObservationV2,
  ): Promise<void>;
}
export interface RepositoryWorkOriginalSourceV2 {
  acquire(
    context: RepositoryWorkTransactionContextV2,
    original: WorkOriginalOperationV2,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkSourceLeaseV2>;
}
export interface RepositoryWorkCustodyLeaseV2
  extends RepositoryWorkHeldLeaseV2, RepositoryWorkInventoryQualificationV2 {
  /** Original protected source supplies its sampled time/uncertainty; no State
   * zero-uncertainty fallback is used for inventory expiry/resolution. */
  readonly inventoryClock?: import("../credential-inventory-v1/repository-lease-transactions-v2.ts").RepositoryInventoryClockV2;
  /** Original identity-owned operands captured at fixed service construction. */
  readonly receiver: object;
  readonly session: object;
  readonly receiverRef: string;
  readonly sessionRef: string;
  /** Records the original protected material/audit responsibility, using the
   * construction-paired same-unit inventory participant. It never emits bytes. */
  stageRelease(input: RepositoryWorkDispatchV2): Promise<void>;
}
export interface RepositoryWorkCustodySourceV2 {
  acquire(
    context: RepositoryWorkTransactionContextV2,
    original: WorkOriginalOperationV2,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkCustodyLeaseV2>;
}
export interface RepositoryWorkCommittedV2 {
  readonly commitRef: string;
}
export interface RepositoryWorkCommittedReleaseV2 {
  readonly operationRef: string;
  readonly commitRef: string;
  readonly dispatch: RepositoryWorkDispatchV2;
}
export interface RepositoryWorkUnitV2 {
  readonly context: RepositoryWorkTransactionContextV2;
  readForMutation(
    work: VersionedWorkRefV2,
    execution: WorkExecutionAssociationV2,
  ): Promise<RepositoryWorkReadsetV2>;
  stageAdmission(candidate: RepositoryWorkAdmissionV2): Promise<void>;
  stagePreparation(input: RepositoryWorkPreparationV2): Promise<void>;
  stageDispatchAndRelease(input: RepositoryWorkDispatchV2): Promise<void>;
  stageClosure(input: RepositoryWorkClosureV2): Promise<void>;
  appendObservation(input: RepositoryWorkObservationV2): Promise<void>;
  readExactOperation(): Promise<RepositoryWorkOperationReadV2>;
  /** Exact canonical reserve/claim/outcome/retire/resolve transition in the SAME
   * inventory journal. A staged result is provisional until outer run commits. */
  stageRepositoryInventory(
    input: RepositoryTokenMutationV2,
  ): Promise<
    import("../credential-inventory-v1/repository-lease-transactions-v2.ts").RepositoryInventoryTransitionV2
  >;
  /** Exact original inventory operation readback, including after old Work closes. */
  readRepositoryInventoryOperation(): Promise<RepositoryInventoryOperationV2 | undefined>;
  assertCurrent(): undefined;
}
export interface RepositoryWorkStoreV2 {
  run<T>(
    original: WorkOriginalOperationV2,
    call: AuthorityCallV1,
    bounds: { readonly signal: AbortSignal; readonly timeoutMs: number },
    body: (unit: RepositoryWorkUnitV2) => Promise<T>,
  ): Promise<
    | {
        readonly kind: "committed";
        readonly value: T;
        readonly commit: RepositoryWorkCommittedV2;
        readonly acknowledgedAt: string;
      }
    | { readonly kind: "unknown"; readonly operationRef: string }
    | { readonly kind: "not-committed" }
  >;
  recoverAfterUnwind(
    original: WorkOriginalOperationV2,
    call: AuthorityCallV1,
    bounds: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<RepositoryWorkOperationReadV2 | { readonly kind: "unavailable" }>;
}
export interface RepositoryWorkCommittedUseLeaseV2 {
  readonly committed: RepositoryWorkCommittedReleaseV2;
  assertCurrent(): undefined;
  /** Full final fence and one-way transfer after synchronous protected decrypt,
   * immediately before fixed write initiation with no intervening await.
   * Permission expiry then forbids another write while original cleanup continues
   * holding the readset until release after ACK or actual child/transport retirement. */
  beginSubmittedUse(): undefined;
  release(): Promise<void>;
}
export interface RepositoryWorkCommittedMintUseLeaseV2 {
  readonly operation: RepositoryInventoryOperationV2;
  /** Check-only before HTTP and after capture; submission does not disable this
   * check or grant another send. Expired/withdrawn authority still refuses. */
  assertCurrent(): undefined;
  /** Final synchronous currentness check and one-way submitted-use latch. */
  beginSubmittedUse(): undefined;
  /** Join only after the original provider settles its exact returned attempt;
   * a bounded outward unknown result is not that terminal observation. */
  release(): Promise<void>;
}
export interface RepositoryWorkCommittedRevocationUseLeaseV2 {
  readonly operation: RepositoryInventoryOperationV2;
  assertCurrent(): undefined;
  /** Final currentness fence and one-way submission under original mitigation. */
  beginSubmittedUse(): undefined;
  /** Join after provider.settleAttempt(exactResult), including outward unknown. */
  release(): Promise<void>;
}
export interface RepositoryWorkStateParticipantV2 {
  assertOriginal(
    context: RepositoryWorkTransactionContextV2,
    original: WorkOriginalOperationV2,
    call: AuthorityCallV1,
  ): undefined;
  /** Only a borrowed operation projection; no query, COMMIT or second pool. */
  inventory(context: RepositoryWorkTransactionContextV2): RepositoryLeaseInventoryTransactionV2;
  /** Historical acknowledgement only; neither copied data nor replay makes this witness. */
  recognizeCommittedInventory(
    commit: RepositoryWorkCommittedV2,
    original: WorkOriginalOperationV2,
  ): RepositoryInventoryOperationV2;
  acquireCommittedMint(
    commit: RepositoryWorkCommittedV2,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkCommittedMintUseLeaseV2 | undefined>;
  acquireCommittedRevocation(
    commit: RepositoryWorkCommittedV2,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkCommittedRevocationUseLeaseV2 | undefined>;
  recognizeCommittedRelease(
    commit: RepositoryWorkCommittedV2,
    releaseRef: string,
    receiver: object,
    session: object,
  ): RepositoryWorkCommittedReleaseV2;
  /** Prepare/authenticate the fixed native sink FIRST. This fresh, bounded lease
   * holds the original current readset through immediate synchronous decrypt and
   * native write initiation; it never exposes a query or caller-selected sink. */
  acquireCommittedRelease(
    commit: RepositoryWorkCommittedV2,
    call: AuthorityCallV1,
    receiver: object,
    session: object,
  ): Promise<RepositoryWorkCommittedUseLeaseV2 | undefined>;
}
export interface RepositoryWorkStateBindingV2 {
  readonly participant: RepositoryWorkStateParticipantV2;
  bindOriginalSources(
    work: RepositoryWorkOriginalSourceV2,
    custody: RepositoryWorkCustodySourceV2,
  ): RepositoryWorkStoreV2;
}

/** Separate authenticated operator purpose; this does not widen the existing
 * workload-profile request union or authenticate a principal from data. */
export interface RepositoryWorkPolicyOperatorRequestV2 {
  readonly purpose: "repository-work-policy-operator";
  readonly binding: Readonly<{
    method: "mutate" | "readOperation";
    operationRef: string;
    canonicalInput: string;
  }>;
}
export interface RepositoryWorkPolicyAccountUnitV2 {
  readonly installationId: string;
  readonly signal: AbortSignal;
  retainSecurityCleanup(release: () => void): undefined;
  query(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}
export interface RepositoryWorkPolicyAccountLeaseV2 {
  readonly principal: import("@openclaw-enterprise/contracts/identity/identity").Principal;
  readonly accountRef: string;
  readonly requestId: string;
  readonly admissionDecisionId: string;
  assertCurrent(): void;
  release(): void;
}
export interface RepositoryWorkPolicyAccountParticipantV2 {
  consume(
    invocation: import("@openclaw-enterprise/contracts/account-authority-v1").AuthenticatedRequestHandleV1,
    request: RepositoryWorkPolicyOperatorRequestV2,
    unit: RepositoryWorkPolicyAccountUnitV2,
  ): Promise<RepositoryWorkPolicyAccountLeaseV2>;
}
export interface RepositoryWorkPolicyAccountOwnerV2 {
  /** Recognizes this owner's exact unit and takes terminal cleanup before return. */
  bind(
    unit: RepositoryWorkPolicyAccountUnitV2,
    terminalCleanup: () => void,
  ): Readonly<{
    assertAcquiring(): void;
    assertCurrent(): void;
    retainAccepted(work: Promise<void>): void;
  }>;
}

export interface RepositoryWorkPolicyMutationV2 {
  readonly operationRef: string;
  readonly expectedVersion: number | null;
  readonly policy: import("../lifecycle/repository-work-policy-v2.ts").RepositoryWorkPolicyV2;
}
export type RepositoryWorkPolicyResultV2 =
  | Readonly<{
      kind: "committed";
      operationRef: string;
      commitRef: string;
      policy: import("../lifecycle/repository-work-policy-v2.ts").RepositoryWorkPolicyV2;
    }>
  | Readonly<{ kind: "unknown"; operationRef: string }>
  | Readonly<{ kind: "conflict" | "denied" | "unavailable" }>;
export interface RepositoryWorkPolicyStoreV2 {
  mutate(
    invocation: import("@openclaw-enterprise/contracts/account-authority-v1").AuthenticatedRequestHandleV1,
    input: RepositoryWorkPolicyMutationV2,
    bounds: Readonly<{ signal: AbortSignal; timeoutMs: number }>,
  ): Promise<RepositoryWorkPolicyResultV2>;
}
export interface RepositoryWorkPolicyBindingV2 {
  readonly accountOwner: RepositoryWorkPolicyAccountOwnerV2;
  bindOriginalAccount(
    account: RepositoryWorkPolicyAccountParticipantV2,
  ): RepositoryWorkPolicyStoreV2;
}

/** The SAME State recognizes the exact policy unit before borrowing its current
 * account/session locks. The lookup is supplied by consumed original auth custody. */
export interface RepositoryWorkPolicySessionSecurityReaderV2 {
  lock(
    unit: RepositoryWorkPolicyAccountUnitV2,
    lookup: import("./workload-profile-session-security.ts").WorkloadProfileSessionLookupV1,
  ): Promise<
    import("./workload-profile-session-security.ts").WorkloadProfileSessionReadLeaseV1 | undefined
  >;
}
