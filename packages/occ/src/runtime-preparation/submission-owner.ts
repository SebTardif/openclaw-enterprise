// Internal declarations only. Concrete original owners authenticate sources and
// retain transactions, provider work and response custody; no implementation is installed here.
import type { AuthorityCallV1, RuntimePreparedChildV1 } from "@openclaw-enterprise/contracts";
import type { DriverSelection } from "../application/driver-selection.ts";
import type { TransactionQuery } from "../ports/repository-factory.ts";
import type { WorkClaim } from "../ports/repositories/work.ts";
import type { PlatformReadOptions } from "../ports/transaction.ts";
import type { WorkloadProfileCapabilitySourceV2 } from "../workload-profiles/selection.ts";
import type { RuntimePreparationCurrentUseRequestV1 } from "./current-use.ts";
import type { RetainedRuntimePreparation } from "./types.ts";
import type {
  RuntimePreparationDeploymentResponseV1,
  RuntimePreparationSubmissionResultV1,
} from "./submission.ts";

/** Detached original input and database marker identity, never effect authority.
 * claim is the original in-flight locator, not a new persisted row field or a
 * prerequisite for recording a later authenticated response. */
export interface RuntimePreparationCommittedSubmissionV1 {
  readonly submissionRef: string;
  readonly submittedAt: string;
  readonly claim: WorkClaim;
  readonly request: RuntimePreparationCurrentUseRequestV1;
  readonly preparation: RetainedRuntimePreparation;
  readonly child: RuntimePreparedChildV1;
  readonly providerWireUtf8: string;
}

/** Pass the ORIGINAL selected SDK-response projection instance. The observer
 * authenticates its retained native response association before copying data. */
export type RuntimePreparationRetainResponseV1 = (
  response: RuntimePreparationDeploymentResponseV1,
  observationCall: AuthorityCallV1,
) => Promise<RuntimePreparationSubmissionResultV1>;

export interface RuntimePreparationSubmissionParticipantV1 {
  /** Called once only for a new marker after definite original COMMIT/cleanup.
   * Reacquire actual worker context and RuntimeEffects authority before dispatch.
   * No SQL lease/unit/IO is passed or valid here. Own the exact SDK promise and
   * response retention through its terminal, including late responses. Returning
   * void grants no queue success, serving, binding, cleanup or stop authority. */
  invoke(
    committed: RuntimePreparationCommittedSubmissionV1,
    retainResponse: RuntimePreparationRetainResponseV1,
  ): Promise<void>;
}

export interface RuntimePreparationResponseObservationLeaseV1 {
  assertCurrent(): undefined;
  prepareCommit(): Promise<void>;
  release(): Promise<void>;
}

/** Original response transaction context with its own private owner recognition.
 * This is not a profile/deployment unit or a copied transport-provided object. */
export interface RuntimePreparationResponseObservationContextV1 {
  readonly installationId: string;
  readonly query: TransactionQuery;
  assertActive(): undefined;
  retain(lease: RuntimePreparationResponseObservationLeaseV1): undefined;
}

export interface RuntimePreparationResponseObservationSourceV1 {
  /** Authenticate original provider response custody AND this fresh service-only
   * call, scoped to the exact retained submission/child/destination. Generic
   * service scope and matching fields are insufficient. Capture cleanup before
   * later acquisition waits; hold currentness through append and terminal ACK.
   * No live human claim/profile/open-work predicate is imposed on observation. */
  acquire(
    context: RuntimePreparationResponseObservationContextV1,
    committed: RuntimePreparationCommittedSubmissionV1,
    originalResponse: RuntimePreparationDeploymentResponseV1,
    observationCall: AuthorityCallV1,
  ): Promise<RuntimePreparationResponseObservationLeaseV1>;
}

export interface RuntimePreparationSubmissionOwnerV1 {
  /** One original transaction accepts a possible submission. Existing marker or
   * uncertain COMMIT never invokes. This actual promise remains owned until its
   * entered participant, accepted response writes and cleanup have settled. */
  submit(
    originalClaim: WorkClaim,
    request: RuntimePreparationCurrentUseRequestV1,
    bounds: PlatformReadOptions,
  ): Promise<RuntimePreparationSubmissionResultV1>;
}

export interface RuntimePreparationSubmissionFactoryV1 {
  /** Capture each original participant once. Missing complete capability or
   * observation source refuses; no DTO/default participant is manufactured. */
  runtimePreparationSubmissionOwnerV1(
    selection: DriverSelection,
    participant: RuntimePreparationSubmissionParticipantV1,
    responseSource: RuntimePreparationResponseObservationSourceV1,
    capabilities: WorkloadProfileCapabilitySourceV2,
  ): RuntimePreparationSubmissionOwnerV1;
}
