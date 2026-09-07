import type {
  AccessBinding,
  Restriction,
  Role,
} from "@openclaw-enterprise/contracts/identity/authorization";
import type {
  Group,
  GroupMembership,
  Identity,
} from "@openclaw-enterprise/contracts/identity/identity";

export interface NativeIAMState {
  readonly identities: readonly Identity[];
  readonly groups: readonly Group[];
  readonly memberships: readonly GroupMembership[];
  readonly roles: readonly Role[];
  readonly bindings: readonly AccessBinding[];
  readonly restrictions: readonly Restriction[];
}
