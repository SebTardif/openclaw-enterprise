// Synthetic persisted-value vectors only. These factories issue no opaque input,
// authority, measured-clock evidence, native observation, or capacity reservation.
export const scope = Object.freeze({
  installationId: "ins_11111111-1111-4111-8111-111111111111",
  namespaceId: "ns_22222222-2222-4222-8222-222222222222",
  agentId: "agt_33333333-3333-4333-8333-333333333333",
});

export const channelInstallationRef = "chi_44444444-4444-4444-8444-444444444444";

function contextKey() {
  return {
    installationRef: scope.installationId,
    namespaceRef: scope.namespaceId,
    agentRef: scope.agentId,
    conversationRef: "original-conversation",
  };
}

function routeProjection() {
  return {
    routeKey: "f".repeat(64),
    native: {
      installationRef: scope.installationId,
      channelInstallationRef,
      platform: "slack",
      providerTenantRef: "original-provider-tenant",
      recipientAppRef: "original-recipient-app",
      nativeConversation: {
        channelRef: "original-native-channel",
        scope: "slack-private-channel",
        rootThreadRef: "original-native-root-thread",
      },
    },
  };
}

export function retiredIdentity(kind = "route") {
  if (kind === "route") {
    return {
      kind,
      routeRef: "original-route-projection",
      routeVersion: 7,
      activationGeneration: 3,
    };
  } else if (kind === "context") {
    return {
      kind,
      context: contextKey(),
      creationRef: "original-context-creation",
      activationGeneration: 3,
    };
  } else if (kind === "channel-installation") {
    return {
      kind,
      channelInstallationRef,
      installationGeneration: 5,
      activationGeneration: 3,
    };
  } else {
    throw new TypeError("Unknown synthetic target kind.");
  }
}

export function retiredTarget(kind = "route") {
  return {
    schemaVersion: 1,
    scope: { ...scope },
    channelInstallationRef,
    identity: retiredIdentity(kind),
    route: kind === "route" ? routeProjection() : null,
  };
}

// The reservation precedes the actual activation/installation generation. Its
// known creation operation and subject must not manufacture future generations.
export function reservationTarget(kind = "route") {
  let subject;
  if (kind === "route") {
    subject = { kind, route: routeProjection() };
  } else if (kind === "context") {
    subject = {
      kind,
      context: contextKey(),
      creationRef: "original-context-creation",
    };
  } else if (kind === "channel-installation") {
    subject = { kind };
  } else {
    throw new TypeError("Unknown synthetic pending subject kind.");
  }
  return {
    schemaVersion: 1,
    scope:
      kind === "channel-installation" ? { installationId: scope.installationId } : { ...scope },
    channelInstallationRef,
    creationOperationRef: `original-${kind}-creation-operation`,
    subject,
  };
}

export function manifestBody() {
  return {
    schemaVersion: 1,
    scope: { ...scope },
    purgeOperationRef: "original-purge-operation",
    requestRef: "original-purge-request",
    manifestVersion: 17,
    retiredIdentities: ["route", "context", "channel-installation"].map(retiredIdentity),
    stores: [0, 1].map((index) => ({
      deletionOperationRef: `original-delete-operation-${index}`,
      store: {
        schemaVersion: 1,
        kind: "configuration-object",
        binding: {
          schemaVersion: 1,
          scope: { ...scope },
          logicalStoreRef: `configuration-${index}`,
          bindingRef: `original-store-binding-${index}`,
          bindingVersion: 19 + index,
        },
        role: "configuration",
        backendRef: "original-configuration-backend",
        objectRef: `original-materialization-${index}`,
        objectVersion: `original-object-version-${index}`,
        contentDigest: `sha256:${String(index + 1).repeat(64)}`,
        ownership: "exclusive-agent-materialization",
      },
    })),
    retention: {
      permanentRetirementBarrier: "retain-installation-lifetime",
      audit: "separate-retention",
      providerMessages: "outside-purge",
      backupsAndSnapshots: "separate-disposal",
      sharedSecretsAndConfigurations: "excluded",
      retainedBackingVolumes: "separate-disposal",
    },
  };
}

export function retirementBinding(manifest) {
  const { schemaVersion, scope, purgeOperationRef, requestRef, manifestVersion, manifestDigest } =
    manifest;
  return {
    schemaVersion: 1,
    scope: { ...scope },
    originalTransactionRef: "original-retirement-transaction",
    expectedStoppedTransitionRef: "55555555-5555-4555-8555-555555555555",
    expectedLifecycleGeneration: 23,
    barrierRef: "original-permanent-barrier",
    barrierVersion: 11,
    activationReplayLineageRef: "original-replay-lineage",
    activationReplayLineageVersion: 13,
    manifest: {
      schemaVersion,
      scope,
      purgeOperationRef,
      requestRef,
      manifestVersion,
      manifestDigest,
    },
  };
}

export function observationInput(
  record,
  storeIndex = 0,
  outcome = "observed-present",
  sequence = 1,
) {
  const entry = record.progress.manifest.stores[storeIndex];
  return {
    originalTransactionRef: `original-observation-transaction-${storeIndex}-${sequence}`,
    binding: structuredClone(record.binding),
    observation: {
      schemaVersion: 1,
      manifest: structuredClone(record.binding.manifest),
      deletionOperationRef: entry.deletionOperationRef,
      store: structuredClone(entry.store),
      observationRef: `original-observation-${storeIndex}-${sequence}`,
      observationSequence: sequence,
      observedAt: `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
      evidenceRef: `synthetic-evidence-reference-${storeIndex}-${sequence}`,
      outcome,
    },
    expectedRecordVersion: record.progress.recordVersion,
  };
}

export function retirementQuery(record) {
  return {
    kind: "retirement",
    binding: structuredClone(record.binding),
    manifest: structuredClone(record.progress.manifest),
    auditIntentRef: record.auditIntentRef,
    durableProgressResponsibilityRef: record.durableProgressResponsibilityRef,
  };
}

export const copy = (value) => structuredClone(value);
