export type ChannelPlatform = "slack" | "msteams";
export type ChannelBindingStatus = "enabled" | "disabled";
export type ChannelScopeKind = "slack-private-channel" | "msteams-standard-channel";

export interface ChannelBindingMetadata {
  readonly id: string;
  readonly installationId: string;
  readonly version: number;
  readonly status: ChannelBindingStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
  readonly updatedBy: string;
}
export interface ChannelInstallation extends ChannelBindingMetadata {
  readonly platform: ChannelPlatform;
  readonly providerTenantRef: string;
  readonly recipientAppRef: string;
}
export interface ChannelHumanBinding extends ChannelBindingMetadata {
  readonly channelInstallationId: string;
  readonly providerSubjectRef: string;
  readonly iamDriverId: string;
  readonly principalId: string;
  readonly principalIssuer: string;
  readonly principalSubject: string;
}
export interface ChannelAgentBinding extends ChannelBindingMetadata {
  readonly channelInstallationId: string;
  readonly channelRef: string;
  readonly scopeKind: ChannelScopeKind;
  readonly namespaceId: string;
  readonly agentId: string;
}
export interface CreateChannelInstallation {
  readonly platform: ChannelPlatform;
  readonly providerTenantRef: string;
  readonly recipientAppRef: string;
}
export interface CreateChannelHumanBinding {
  readonly providerSubjectRef: string;
  readonly principal: { readonly issuer: string; readonly subject: string };
}
export interface CreateChannelAgentBinding {
  readonly channelRef: string;
  readonly scopeKind: ChannelScopeKind;
  readonly namespaceId: string;
  readonly agentId: string;
}
export interface ChangeChannelBindingStatus {
  readonly expectedVersion: number;
  readonly status: ChannelBindingStatus;
}
export interface ChannelBindingPage<T> {
  readonly items: readonly Readonly<T>[];
  readonly nextCursor?: string;
}

/** Opaque provider references preserve exact Unicode scalars and UTF-8 bytes. */
export function isChannelBindingReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\ud800-\udfff]/u.test(value) &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    new TextEncoder().encode(value).length <= 1024
  );
}
