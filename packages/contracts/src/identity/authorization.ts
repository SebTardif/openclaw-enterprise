import type {
  ChannelAdministrationEvidenceV1,
  ChannelAdministrationMappingV1,
} from "../channel-administration.ts";
import type { ResourceKind, ResourceRef, Scope } from "../resources/scope.ts";

export type PermissionAction =
  "create" | "read" | "update" | "delete" | "deploy" | "operate" | "administer";

export interface Permission {
  readonly action: PermissionAction;
  readonly resourceKind: ResourceKind;
}

export interface Role extends Scope {
  readonly id: string;
  readonly namespaceId?: string;
  readonly name?: string;
  readonly permissions: readonly Permission[];
}

export type AccessBindingSubjectKind = "identity" | "group";

export interface AccessBinding extends Scope {
  readonly id: string;
  readonly namespaceId?: string;
  readonly subjectKind: AccessBindingSubjectKind;
  readonly subjectId: string;
  readonly roleId: string;
  readonly resourceKind?: ResourceKind;
  readonly resourceId?: string;
  readonly channelAdministration?: ChannelAdministrationMappingV1;
}

export interface Restriction extends Scope {
  readonly id: string;
  readonly namespaceId?: string;
  readonly action: PermissionAction;
  readonly resourceKind: ResourceKind;
  readonly resourceId?: string;
  readonly effect: "deny";
}

export interface AuthorizationRequest {
  readonly principalId: string;
  readonly action: PermissionAction;
  readonly resource: ResourceRef;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly driverId: string;
  readonly evidence: AuthorizationEvidence;
}

export interface AuthorizationEvidence {
  readonly identityId?: string;
  readonly groupIds: readonly string[];
  readonly bindingIds: readonly string[];
  readonly roleIds: readonly string[];
  readonly restrictionIds: readonly string[];
  readonly channelAdministration?: ChannelAdministrationEvidenceV1;
}
