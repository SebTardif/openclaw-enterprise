import type { Principal } from "@openclaw-enterprise/contracts";
import type { StoredProfilePreparation } from "../../workload-profiles/types.ts";
import type { AuthenticatedRequestHandleV1 } from "@openclaw-enterprise/contracts/account-authority-v1";
import type {
  WorkloadProfilePrepareV1,
  WorkloadProfileWithdrawV1,
} from "@openclaw-enterprise/contracts/workload-profile-v1";
import type {
  WorkloadProfileAcknowledgement,
  WorkloadProfileUnknownOutcome,
  WorkloadProfilePreparationProjection,
  WorkloadProfileAdmissionProjection,
} from "@openclaw-enterprise/contracts/api/workload-profile/resources";

export type ProfileMutationResponse =
  WorkloadProfileAcknowledgement | WorkloadProfileUnknownOutcome;
/** The handle is opaque request custody, never a caller-supplied actor/scope DTO.
 * Implementations must validate real provenance and hold current authority to commit. */
export interface WorkloadProfileServicePort {
  prepare(
    invocation: AuthenticatedRequestHandleV1,
    input: WorkloadProfilePrepareV1,
    signal: AbortSignal,
  ): Promise<ProfileMutationResponse>;
  accept(
    invocation: AuthenticatedRequestHandleV1,
    operationRef: string,
    signal: AbortSignal,
  ): Promise<ProfileMutationResponse>;
  withdraw(
    invocation: AuthenticatedRequestHandleV1,
    admissionRef: string,
    input: WorkloadProfileWithdrawV1,
    signal: AbortSignal,
  ): Promise<ProfileMutationResponse>;
  readOperation(
    invocation: AuthenticatedRequestHandleV1,
    operationRef: string,
    signal: AbortSignal,
  ): Promise<WorkloadProfilePreparationProjection>;
  readProfile(
    invocation: AuthenticatedRequestHandleV1,
    admissionRef: string,
    signal: AbortSignal,
  ): Promise<WorkloadProfileAdmissionProjection>;
}

/** Internal accepting-unit participation, to be implemented by the original
 * account authority owner. The interface alone grants no authority. An adapter
 * must consume the exact original request once, lock/read real session/account
 * security state in this unit and retain currentness through terminal cleanup.
 * No implementation is installed and no controller route supplies this input. */
export interface WorkloadProfileAccountParticipant {
  consume(
    invocation: AuthenticatedRequestHandleV1,
    request: Readonly<{
      method: "prepare" | "readOperation";
      operationRef: string;
      canonicalInput: string;
    }>,
    unit: WorkloadProfileAccountUnit,
  ): Promise<WorkloadProfileAccountLease>;
}

/** Borrowed only by the trusted account adapter, never by an API invocation. */
export interface WorkloadProfileAccountUnit {
  readonly installationId: string;
  readonly signal: AbortSignal;
  query(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<{
    rows: unknown[];
    rowCount: number | null;
  }>;
}

export interface WorkloadProfileAccountLease {
  readonly principal: import("@openclaw-enterprise/contracts").Principal;
  readonly accountRef: string;
  readonly requestId: string;
  readonly admissionDecisionId: string;
  /** Actual source/account/session eligibility and expiry; no cached allow. */
  assertCurrent(): void;
  /** Synchronous local release after the owner has joined database cleanup. */
  release(): void;
}

/** Internal attribution is deliberately not an authenticated account capability. */
export interface GuardedProfileActor {
  readonly principal: Principal;
  readonly accountRef: string;
  readonly requestId: string;
  readonly admissionDecisionId: string;
}
export interface GuardedWorkloadProfileUnit {
  readonly account: WorkloadProfileAccountUnit;
  /** Additional denial checks retained until immediately before COMMIT. */
  retainCurrentness(assertCurrent: () => void): void;
  prepare(input: unknown, actor: GuardedProfileActor): Promise<StoredProfilePreparation>;
  readOperation(
    operationRef: string,
    actor: GuardedProfileActor,
  ): Promise<StoredProfilePreparation | undefined>;
}

/** Trusted owner port, with the PostgreSQL implementation retaining real policy
 * locks, selected-driver/store custody and all terminal transaction cleanup.
 * This storage port neither authenticates an account nor enables a route. */
export interface WorkloadProfileTransactionStore {
  workloadProfileTransaction<T>(
    selection: import("../../application/driver-selection.ts").DriverSelection,
    work: (unit: GuardedWorkloadProfileUnit) => Promise<T>,
    options: import("../../ports/transaction.ts").PlatformReadOptions,
  ): Promise<T>;
}
