import type {
  CredentialBackendModelProjectionV1,
  CredentialBackendProfileV1,
} from "@openclaw-enterprise/contracts/credential-backend-profile-v1";
import type { NamedCustodyProjectionV1 } from "../credential-custody-v1/ports.ts";
import type {
  WorkloadProfileCandidateRecordsV2,
  WorkloadProfileCandidateRecordsViewV2,
  WorkloadProfileDeploymentUnitV2,
  WorkloadProfileOwnedLeaseV2,
  WorkloadProfileOwnedOperationV2,
} from "../workload-profiles/admitted-use.ts";
import type { WorkloadProfileSelectionRequestV2 } from "../workload-profiles/selection.ts";

/** Private nonmaterial facts from the original protected credential owner.
 * Their data shape does not authenticate a source or confer model authority. */
export type CredentialFactsV1 = Readonly<{
  model: CredentialBackendModelProjectionV1;
  backend: CredentialBackendProfileV1;
  named: NamedCustodyProjectionV1;
}>;

/** Borrowed custody of an already retained source. Currentness is synchronous,
 * survives acquisition-IO closure and performs no query or new acquisition. */
export interface CapturedCredentialViewV1 {
  readonly facts: CredentialFactsV1;
  assertCurrent(): undefined;
}

export type CapturedCredentialLeaseV1 = CapturedCredentialViewV1 & WorkloadProfileOwnedLeaseV2;

/** Fixed process-owned source, captured before candidate-context construction.
 * The original owner acquires after normalized account/configuration/Secret
 * observations and before completion/head SHARE. Retain cleanup before reading
 * further result getters. No manifest/head, material or definition revision is
 * supplied here. A matching interface alone does not enroll its implementer. */
export interface OriginalCredentialCandidateSourceV1 {
  acquireCapturedLocked(
    request: WorkloadProfileSelectionRequestV2,
    captured: Omit<WorkloadProfileCandidateRecordsV2, "head">,
    unit: WorkloadProfileDeploymentUnitV2,
    io: WorkloadProfileOwnedOperationV2,
  ): Promise<CapturedCredentialLeaseV1>;
}

/** Only the original candidate owner authenticates this correspondence against
 * its private captured slot: exact request/selection, unit, IO and sourceIdentity.
 * Return the already held observation without SQL, lock, release or enrollment.
 * Missing genuine capture refuses; a deployment view cannot serve other phases. */
export interface OriginalCredentialCaptureConsumerV1 {
  consumeCapturedCredentialV1(
    request: WorkloadProfileSelectionRequestV2,
    records: WorkloadProfileCandidateRecordsViewV2,
    unit: WorkloadProfileDeploymentUnitV2,
    io: WorkloadProfileOwnedOperationV2,
  ): Promise<CapturedCredentialViewV1>;
}
