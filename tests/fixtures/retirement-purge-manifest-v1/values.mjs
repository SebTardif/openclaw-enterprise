export const scope = Object.freeze({
  installationId: "ins_11111111-1111-4111-8111-111111111111",
  namespaceId: "ns_22222222-2222-4222-8222-222222222222",
  agentId: "agt_33333333-3333-4333-8333-333333333333",
});

export function manifestBody() {
  return {
    schemaVersion: 1,
    scope: { ...scope },
    purgeOperationRef: "purge-operation-1",
    requestRef: "purge-request-1",
    manifestVersion: 1,
    retiredIdentities: [
      { kind: "route", routeRef: "route-1", routeVersion: 7, activationGeneration: 3 },
      {
        kind: "context",
        context: {
          installationRef: scope.installationId,
          namespaceRef: scope.namespaceId,
          agentRef: scope.agentId,
          conversationRef: "conversation-1",
        },
        creationRef: "creation-1",
        activationGeneration: 3,
      },
      {
        kind: "channel-installation",
        channelInstallationRef: "chi_44444444-4444-4444-8444-444444444444",
        installationGeneration: 2,
        activationGeneration: 3,
      },
    ],
    stores: [
      {
        deletionOperationRef: "delete-claim-1",
        store: {
          schemaVersion: 1,
          kind: "kubernetes-volume",
          deleteTarget: "persistent-volume-claim",
          binding: {
            schemaVersion: 1,
            scope: { ...scope },
            logicalStoreRef: "workspace-1",
            bindingRef: "workspace-binding-1",
            bindingVersion: 5,
          },
          role: "workspace",
          clusterRef: "cluster-1",
          namespaceName: "agent-space",
          namespaceUid: "namespace-uid-1",
          claimName: "workspace",
          claimUid: "claim-uid-1",
          volumeName: "volume-1",
          volumeUid: "volume-uid-1",
          storageProfileRef: "storage-profile-1",
          storageProfileDigest: `sha256:${"1".repeat(64)}`,
          mountPolicyDigest: `sha256:${"2".repeat(64)}`,
          ownership: "exclusive-agent",
        },
      },
      {
        deletionOperationRef: "delete-materialization-1",
        store: {
          schemaVersion: 1,
          kind: "configuration-object",
          binding: {
            schemaVersion: 1,
            scope: { ...scope },
            logicalStoreRef: "materialization-1",
            bindingRef: "materialization-binding-1",
            bindingVersion: 4,
          },
          role: "configuration",
          backendRef: "config-backend-1",
          objectRef: "materialization-object-1",
          objectVersion: "materialization-version-4",
          contentDigest: `sha256:${"3".repeat(64)}`,
          ownership: "exclusive-agent-materialization",
        },
      },
    ],
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

export function observation(
  manifest,
  storeIndex,
  outcome = "observed-absent",
  observationSequence = 1,
) {
  const { schemaVersion, scope, purgeOperationRef, requestRef, manifestVersion, manifestDigest } =
    manifest;
  const entry = manifest.stores[storeIndex];
  return {
    schemaVersion: 1,
    manifest: {
      schemaVersion,
      scope,
      purgeOperationRef,
      requestRef,
      manifestVersion,
      manifestDigest,
    },
    deletionOperationRef: entry.deletionOperationRef,
    store: entry.store,
    observationRef: `observation-${storeIndex}-${observationSequence}`,
    observationSequence,
    observedAt: `2026-01-01T00:00:${String(observationSequence).padStart(2, "0")}.000Z`,
    evidenceRef: `evidence-${storeIndex}-${observationSequence}`,
    outcome,
  };
}

export function withObservation(previous, storeIndex, nextObservation) {
  const candidate = structuredClone(previous);
  candidate.recordVersion++;
  candidate.stores[storeIndex].state = {
    kind: nextObservation.outcome,
    observation: nextObservation,
  };
  candidate.state = candidate.stores.every((row) => row.state.kind === "observed-absent")
    ? "live-objects-absent"
    : "purge-incomplete";
  return candidate;
}
