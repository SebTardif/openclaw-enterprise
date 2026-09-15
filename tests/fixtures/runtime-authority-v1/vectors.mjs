// Structurally valid examples only. These identifiers do not resolve real protected records.
export const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const digest = `sha256:${"a".repeat(64)}`;
export const now = "2026-01-01T00:00:00.000Z";
export const until = "2026-01-01T00:00:10.000Z";
export const scope = {
  installationId: `ins_${id(1)}`,
  namespaceId: `ns_${id(2)}`,
  agentId: `agt_${id(3)}`,
};
export function target() {
  return {
    ...scope,
    assignmentRef: { schemaVersion: 1, id: id(4) },
    revisionId: `rev_${id(5)}`,
    component: "harness",
    lifecycleGeneration: 1,
    runtimeGeneration: 1,
    createEffectRef: id(6),
  };
}
export function binding() {
  return {
    schemaVersion: 1,
    bindingVersion: 1,
    clusterRef: "cluster/example",
    kubernetesNamespaceUid: id(7),
    podUid: id(8),
    deploymentUid: id(9),
    replicaSetUid: id(10),
    imageDigests: [{ name: "harness", digest }],
    policyRevision: "policy/example-v1",
    admittedConfigurationDigest: digest,
    profileDigests: { provider: digest, runtime: digest, identity: digest },
    provider: "occ/kubernetes-gvisor",
    component: "harness",
    runtimeClass: "oce-gvisor-systrap",
    runtimeHandler: "oce-gvisor-systrap",
    runtimeType: "io.containerd.runsc.v1",
    platform: "systrap",
    isolation: "STRICT",
    runscSandboxId: "sandbox/example",
    runtimeInstanceRef: "instance/example",
    protectedRestartDiscriminator: "restart/example-1",
    runtimeBinaryDigest: digest,
    runtimeDistributionDigest: digest,
    runtimeFlagsDigest: digest,
  };
}
export function observation() {
  return {
    observationRef: "observation/example",
    ownerChainEvidenceRef: "ownership/example",
    createEffectCorrelationRef: "effect/example",
    instanceEvidenceRef: "instance-proof/example",
    sourceObservedAt: now,
    receivedAt: now,
    validUntil: until,
    uncertaintyMs: 0,
  };
}
export function bindRequest() {
  return {
    schemaVersion: 1,
    kind: "bind",
    operationRef: id(11),
    requestRef: "request/example",
    target: target(),
    expectedLifecycleGeneration: 1,
    expectedAssignmentRecordVersion: 1,
    binding: binding(),
    expectedBindingVersion: null,
    observation: observation(),
    responsibilityRef: id(12),
    expectedResponsibilityVersion: 1,
  };
}
