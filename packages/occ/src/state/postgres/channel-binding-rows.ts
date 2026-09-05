import type {
  ChannelInstallation,
  ChannelHumanBinding,
  ChannelAgentBinding,
  ChannelBindingMetadata,
} from "@openclaw-enterprise/contracts/channel-bindings";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { DependencyUnavailableError } from "../../errors.ts";

export type PostgresChannelBindingRow = Record<string, unknown>;

function channelMetadataFromRow(row: PostgresChannelBindingRow): ChannelBindingMetadata {
  const version = Number(row.version);
  const status = text(row, "status");
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    (status !== "enabled" && status !== "disabled")
  )
    throw new DependencyUnavailableError("The stored channel binding state is invalid.");
  return {
    id: text(row, "id"),
    installationId: text(row, "installation_id"),
    version,
    status,
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
    createdBy: text(row, "created_by"),
    updatedBy: text(row, "updated_by"),
  };
}
export function channelInstallationFromRow(
  row: PostgresChannelBindingRow,
): Readonly<ChannelInstallation> {
  const platform = text(row, "platform");
  if (platform !== "slack" && platform !== "msteams")
    throw new DependencyUnavailableError("The stored channel platform is invalid.");
  return immutableCopy({
    ...channelMetadataFromRow(row),
    platform,
    providerTenantRef: text(row, "provider_tenant_ref"),
    recipientAppRef: text(row, "recipient_app_ref"),
  });
}
export function channelHumanFromRow(row: PostgresChannelBindingRow): Readonly<ChannelHumanBinding> {
  return immutableCopy({
    ...channelMetadataFromRow(row),
    channelInstallationId: text(row, "channel_installation_id"),
    providerSubjectRef: text(row, "provider_subject_ref"),
    iamDriverId: text(row, "iam_driver_id"),
    principalId: text(row, "principal_id"),
    principalIssuer: text(row, "principal_issuer"),
    principalSubject: text(row, "principal_subject"),
  });
}
export function channelAgentFromRow(row: PostgresChannelBindingRow): Readonly<ChannelAgentBinding> {
  const scopeKind = text(row, "scope_kind");
  if (scopeKind !== "slack-private-channel" && scopeKind !== "msteams-standard-channel")
    throw new DependencyUnavailableError("The stored channel scope is invalid.");
  return immutableCopy({
    ...channelMetadataFromRow(row),
    channelInstallationId: text(row, "channel_installation_id"),
    channelRef: text(row, "channel_ref"),
    scopeKind,
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
  });
}

export function rows(value: unknown[]): PostgresChannelBindingRow[] {
  return value.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row))
      throw new DependencyUnavailableError("The persistence repository returned invalid data.");
    return row as PostgresChannelBindingRow;
  });
}

function text(row: PostgresChannelBindingRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0)
    throw new DependencyUnavailableError("Persisted platform state is invalid or incomplete.");
  return value;
}

function timestamp(row: PostgresChannelBindingRow, key: string): string {
  const value = row[key];
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime()))
    throw new DependencyUnavailableError("Persisted platform state has an invalid timestamp.");
  return date.toISOString();
}
