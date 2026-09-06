import type { LifecycleIntentV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type { RuntimeIntent } from "@openclaw-enterprise/contracts/runtime-assignment";
import type {
  AuthorityCallV1,
  RuntimeAssignmentAuthorityV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { RuntimeEffectsV1 } from "@openclaw-enterprise/contracts";
import type { LifecycleWorkerReadPortV1 } from "@openclaw-enterprise/occ/lifecycle/ports-v1";
import {
  lifecycleAssociationsEqualV1,
  lifecycleWorkSnapshotPreflightV1,
  parseReconcileAgentLifecycleV1,
  type ControllerWork,
  type LifecycleAdmissionAssociationV1,
  type LifecycleWorkSnapshotPreflightV1,
  type PlatformOperation,
  type ReconcileAgentLifecycleV1,
  type WorkClaim,
} from "@openclaw-enterprise/occ/lifecycle/work-v1";

/** The future worker consumes these existing ports. This example neither
 * implements a producer nor constructs a trusted call or effect request. */
export interface LifecycleWorkerDependenciesV1 {
  readonly lifecycle: LifecycleWorkerReadPortV1;
  readonly assignments: RuntimeAssignmentAuthorityV1;
  readonly effects: RuntimeEffectsV1;
}

/** Independent read-only consumer. Original records, claim and clock are supplied
 * by the real worker/storage owners. Even snapshot-matches requires fresh checks
 * at subsequent acceptance boundaries and cannot authorize any runtime effect. */
export async function inspectRetainedLifecycleWorkV1(
  dependencies: LifecycleWorkerDependenciesV1,
  input: ReconcileAgentLifecycleV1,
  original: LifecycleAdmissionAssociationV1,
  operation: PlatformOperation,
  work: ControllerWork,
  claim: WorkClaim,
  installationId: string,
  clock: () => Date,
  call: AuthorityCallV1,
): Promise<LifecycleWorkSnapshotPreflightV1 | "read-unavailable"> {
  const request = parseReconcileAgentLifecycleV1(input);
  const retained = await dependencies.lifecycle.readAdmittedWork(request, call);
  if (retained.kind !== "read") return "read-unavailable";
  if (!lifecycleAssociationsEqualV1(original, retained.association)) return "association-mismatch";
  return lifecycleWorkSnapshotPreflightV1(
    request,
    retained.association,
    operation,
    work,
    retained.currentIntent,
    claim,
    installationId,
    clock(),
  );
}

type MustBeFalse<T extends false> = T;
export type InertWorkIsNotAnInstalledOperation = MustBeFalse<
  ReconcileAgentLifecycleV1 extends PlatformOperation ? true : false
>;
export type InertWorkIsNotAuthority = MustBeFalse<
  ReconcileAgentLifecycleV1 extends AuthorityCallV1 ? true : false
>;
export type ProtectiveIntentIsNotInstalledIntent = MustBeFalse<
  LifecycleIntentV1 extends RuntimeIntent ? true : false
>;
