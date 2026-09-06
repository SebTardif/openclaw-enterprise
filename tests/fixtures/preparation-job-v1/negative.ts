import type {
  PreparationJobTargetV1,
  PreparationJobIdentityV1,
  PreparationJobEffectsV1,
  PreparationJobSealV1,
} from "@openclaw-enterprise/contracts/preparation-job-v1";
import type { RuntimeProviderTargetV1 } from "@openclaw-enterprise/contracts/runtime-effects-v1";
import type {
  RuntimeBindingV1,
  AuthorityCallV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { ProtectedPreparationReceiptHandleV1 } from "@openclaw-enterprise/contracts/repository-preparation-v1";

declare const job: PreparationJobTargetV1;
declare const deployment: RuntimeProviderTargetV1;
declare const identity: PreparationJobIdentityV1;
declare const effects: PreparationJobEffectsV1;
declare const seal: PreparationJobSealV1;
declare const call: AuthorityCallV1;
// @ts-expect-error A Job is not the existing Deployment/Service provider target.
export const coercedDeployment: RuntimeProviderTargetV1 = job;
// @ts-expect-error An existing target lacks separate preparation identity/subject.
export const coercedJob: PreparationJobTargetV1 = deployment;
// @ts-expect-error Preparation identity is not a gateway/Harness runtime binding.
export const coercedHarness: RuntimeBindingV1 = identity;
// @ts-expect-error JSON cannot construct the credential-owned nominal receipt handle.
export const forgedReceipt: ProtectedPreparationReceiptHandleV1 = {};
// @ts-expect-error Root deletion is intentionally absent from the Job effect port.
void effects.deleteJob(job, call);
// @ts-expect-error A cleanup mutation cannot be supplied as preparation release.
void effects.release(seal, call);
