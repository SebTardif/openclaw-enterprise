import type {
  AgentPluginSnapshot,
  AgentRevision,
  ComputeRevisionContext,
  PluginIdentity,
} from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

export function nativePluginIdentityKey(identity: PluginIdentity): string {
  return `${identity.driverId}\u0000${identity.pluginId}`;
}

export function selectedNativePlugins(
  revision: Readonly<AgentRevision>,
): readonly AgentPluginSnapshot[] {
  const candidate = revision.selectedPlugins;
  if (!Array.isArray(candidate)) {
    throw new Error("AgentRevision selected plugin snapshot is invalid.");
  }
  const seen = new Set<string>();
  return Object.freeze(
    candidate.map((entry) => {
      const record = asRecord(entry);
      if (
        record === undefined ||
        !isNonEmptyString(record.driverId) ||
        !isNonEmptyString(record.pluginId) ||
        !isNonEmptyString(record.remoteMarketplaceName) ||
        !isNonEmptyString(record.remotePluginId) ||
        (record.version !== null &&
          record.version !== undefined &&
          typeof record.version !== "string") ||
        !isNonEmptyString(record.catalogCodexVersion)
      ) {
        throw new Error("AgentRevision selected plugin snapshot is invalid.");
      }
      const snapshot: AgentPluginSnapshot = {
        driverId: record.driverId,
        pluginId: record.pluginId,
        remoteMarketplaceName: record.remoteMarketplaceName,
        remotePluginId: record.remotePluginId,
        version: record.version ?? null,
        catalogCodexVersion: record.catalogCodexVersion,
      };
      const key = nativePluginIdentityKey(snapshot);
      if (seen.has(key)) throw new Error("AgentRevision selected plugin snapshot is ambiguous.");
      seen.add(key);
      return snapshot;
    }),
  );
}

export function failedNativePluginKeys(
  context: ComputeRevisionContext | undefined,
): ReadonlySet<string> {
  const failedPluginIdentities = context?.failedPluginIdentities;
  if (!Array.isArray(failedPluginIdentities)) {
    throw new Error("Native plugin failure context is invalid.");
  }
  const keys = new Set<string>();
  for (const identity of failedPluginIdentities) {
    const record = asRecord(identity);
    if (
      record === undefined ||
      !isNonEmptyString(record.driverId) ||
      !isNonEmptyString(record.pluginId)
    ) {
      throw new Error("Native plugin failure context is invalid.");
    }
    keys.add(nativePluginIdentityKey({ driverId: record.driverId, pluginId: record.pluginId }));
  }
  return keys;
}
