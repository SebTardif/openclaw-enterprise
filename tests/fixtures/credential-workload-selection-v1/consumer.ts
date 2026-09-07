import {
  decodeCredentialWorkloadSelectionV1,
  type CredentialWorkloadSelectionV1,
  type CredentialWorkloadAssociationV1,
} from "@openclaw-enterprise/contracts/credential-workload-selection-v1";
import type {
  CurrentCredentialAuthorityV1,
  CurrentCredentialAuthorityHandleV1,
} from "@openclaw-enterprise/contracts/credential-authority-v1";
import type {
  WorkloadProfileSelectionV1,
  WorkloadProfileRolesV1,
} from "@openclaw-enterprise/contracts/workload-profile-v1";

/** Independent public-subpath consumer: declarations only, no producer fixture import. */
export function inspectCredentialSelection(input: unknown): string | undefined {
  const result = decodeCredentialWorkloadSelectionV1(input);
  if (result.kind === "invalid") return undefined;
  const value: CredentialWorkloadSelectionV1 = result.value;
  const association: CredentialWorkloadAssociationV1 = value.association;
  const selected: WorkloadProfileSelectionV1 = association.selection;
  const roles: WorkloadProfileRolesV1 = association.profileRefs;
  if (false) {
    // @ts-expect-error Nonsecret selection is not a current authority handle.
    const handle: CurrentCredentialAuthorityHandleV1 = value;
    // @ts-expect-error Parsed correspondence is not an invocation-bound authority.
    const authority: CurrentCredentialAuthorityV1 = result;
    // @ts-expect-error Nested admitted selections are immutable.
    value.association.selection.admissionVersion = 2;
    // @ts-expect-error Logical secret version is numeric, not Kubernetes resourceVersion.
    value.repository.binding.secretVersion = "resource-version";
    // @ts-expect-error Closed channel values carry no token bytes.
    value.channels[0]!.token = "not-a-token";
    void handle;
    void authority;
  }
  return `${selected.manifestRef}:${roles.runtime.ref}:${value.repository.profile.mode}`;
}
