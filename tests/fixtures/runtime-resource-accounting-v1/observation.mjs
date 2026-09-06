// Representation-only values of the existing runtime-effects V1 observation.
// These fictional bindings/provenance records do not simulate a trusted producer.
export const hash = (n) => `sha256:${String(n).padStart(64, "0")}`;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function observation() {
  const target = {
    installationId: `ins_${uuid(1)}`,
    namespaceId: `ns_${uuid(2)}`,
    agentId: `agt_${uuid(3)}`,
    assignmentRef: { schemaVersion: 1, id: uuid(12) },
    revisionId: `rev_${uuid(4)}`,
    component: "harness",
    lifecycleGeneration: 2,
    runtimeGeneration: 2,
    createEffectRef: uuid(22),
  };
  const binding = {
    schemaVersion: 1,
    bindingVersion: 1,
    provider: "occ/kubernetes-gvisor",
    component: "harness",
    clusterRef: "cluster",
    kubernetesNamespaceUid: "namespace-uid",
    podUid: "pod-2",
    deploymentUid: "deployment-2",
    replicaSetUid: "replica-set-2",
    imageDigests: [{ name: "harness", digest: hash(1) }],
    policyRevision: "policy-1",
    admittedConfigurationDigest: hash(2),
    profileDigests: { provider: hash(3), runtime: hash(4), identity: hash(5) },
    runtimeClass: "oce-gvisor-systrap",
    runtimeHandler: "oce-gvisor-systrap",
    runtimeType: "io.containerd.runsc.v1",
    platform: "systrap",
    isolation: "STRICT",
    runscSandboxId: "sandbox-2",
    runtimeInstanceRef: "execution-2",
    protectedRestartDiscriminator: "restart-2",
    runtimeBinaryDigest: hash(6),
    runtimeDistributionDigest: hash(7),
    runtimeFlagsDigest: hash(8),
  };
  const evidence = (ref) => ({
    producerRef: "fixture-producer",
    producerServiceVersion: 1,
    producerProfileRef: "profile",
    producerProfileDigest: hash(9),
    acceptedPortRef: "fixture-port",
    evidenceRef: ref,
    evidenceVersion: 2,
    clock: {
      sourceObservedAt: "2026-01-01T00:00:00.000Z",
      receivedAt: "2026-01-01T00:00:00.100Z",
      validUntil: "2026-01-01T00:00:15.000Z",
      uncertaintyMs: 100,
    },
  });
  return {
    schemaVersion: 1,
    status: "complete",
    input: {
      schemaVersion: 1,
      kind: "bound-instance",
      target,
      binding,
      expectedEvidenceVersion: 1,
    },
    object: {
      target: {
        targetRef: "Deployment-2",
        clusterRef: "cluster",
        kubernetesNamespaceUid: "namespace-uid",
        apiKind: "Deployment",
        name: "deployment-2",
        ownerAssignmentRef: target.assignmentRef,
        ownerCreateEffectRef: target.createEffectRef,
      },
      uid: "deployment-2",
      resourceVersion: "rv-2",
      fenceEpoch: 2,
    },
    binding,
    observation: evidence("observation"),
    ownerChainEvidence: evidence("owner-chain"),
    executionCorrespondenceEvidence: evidence("execution"),
    profile: {
      desired: { profileRef: "desired", version: 3, digest: hash(30) },
      delivered: {
        profileRef: "delivered",
        version: 2,
        digest: hash(20),
        evidence: evidence("delivered"),
      },
      effective: {
        profileRef: "effective",
        version: 1,
        digest: hash(10),
        evidence: evidence("effective"),
      },
    },
    identityEvidence: null,
    eligibility: "observation-only",
  };
}
