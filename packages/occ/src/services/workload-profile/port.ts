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
