// Synthetic value examples; no authenticated producer or admitted profile.
export const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const digest = (n) => `sha256:${String(n).padStart(64, "0")}`;
export const copy = (value) => JSON.parse(JSON.stringify(value));
export const policy = (n) => ({ profileRef: `fixture-policy-${n}`, version: n, digest: digest(n) });
export const evidence = (producerRef = "fixture-control-producer", version = 2) => ({
  producerRef,
  producerServiceVersion: 1,
  producerProfileRef: "fixture-producer-profile",
  producerProfileDigest: digest(20),
  acceptedPortRef: "fixture/protected-control-port",
  evidenceRef: `fixture/evidence-${version}`,
  evidenceVersion: version,
  clock: {
    sourceObservedAt: "2026-01-01T00:00:01.000Z",
    receivedAt: "2026-01-01T00:00:01.100Z",
    validUntil: "2026-01-01T00:00:16.000Z",
    uncertaintyMs: 100,
  },
});
export function request() {
  return {
    schemaVersion: 1,
    projectionVersion: 1,
    requestRef: id(1),
    runtime: {
      schemaVersion: 1,
      kind: "bound-instance",
      target: {
        installationId: `ins_${id(2)}`,
        namespaceId: `ns_${id(3)}`,
        agentId: `agt_${id(4)}`,
        revisionId: `rev_${id(5)}`,
        assignmentRef: { schemaVersion: 1, id: id(6) },
        component: "harness",
        lifecycleGeneration: 1,
        runtimeGeneration: 1,
        createEffectRef: id(7),
      },
      binding: {
        schemaVersion: 1,
        bindingVersion: 1,
        provider: "occ/kubernetes-gvisor",
        component: "harness",
        clusterRef: "fixture-cluster",
        kubernetesNamespaceUid: "fixture-namespace",
        podUid: "fixture-pod",
        deploymentUid: "fixture-deployment",
        replicaSetUid: "fixture-replicaset",
        imageDigests: [{ name: "agent", digest: digest(1) }],
        policyRevision: "fixture-policy-1",
        admittedConfigurationDigest: digest(2),
        profileDigests: { provider: digest(3), runtime: digest(4), identity: digest(5) },
        runtimeClass: "oce-gvisor-systrap",
        runtimeHandler: "oce-gvisor-systrap",
        runtimeType: "io.containerd.runsc.v1",
        platform: "systrap",
        isolation: "STRICT",
        runscSandboxId: "fixture-sandbox",
        runtimeInstanceRef: "fixture-instance",
        protectedRestartDiscriminator: "fixture-execution-restart-1",
        runtimeBinaryDigest: digest(6),
        runtimeDistributionDigest: digest(7),
        runtimeFlagsDigest: digest(8),
      },
      expectedEvidenceVersion: 1,
    },
    containmentProfile: policy(10),
    requiredControls: [
      { control: "runtime-isolation", desired: policy(11) },
      { control: "outer-network", desired: policy(12) },
    ],
    after: null,
    maxAgeMs: 15_000,
    maxUncertaintyMs: 2_000,
  };
}
export function response(input = request()) {
  const runtime = input.runtime;
  const source = evidence("fixture-projection");
  return copy({
    schemaVersion: 1,
    projectionVersion: 1,
    input,
    eligibility: "observation-only",
    status: "observed",
    runtimeObservation: {
      schemaVersion: 1,
      status: "complete",
      input: runtime,
      binding: runtime.binding,
      object: {
        target: {
          targetRef: "fixture-target",
          clusterRef: runtime.binding.clusterRef,
          kubernetesNamespaceUid: runtime.binding.kubernetesNamespaceUid,
          apiKind: "Deployment",
          name: "fixture-deployment",
          ownerAssignmentRef: runtime.target.assignmentRef,
          ownerCreateEffectRef: runtime.target.createEffectRef,
        },
        uid: runtime.binding.deploymentUid,
        resourceVersion: "1",
        fenceEpoch: 1,
      },
      observation: evidence("fixture-runtime"),
      ownerChainEvidence: evidence("fixture-runtime"),
      executionCorrespondenceEvidence: evidence("fixture-runtime"),
      profile: {
        desired: policy(4),
        delivered: { ...policy(3), evidence: evidence("fixture-runtime") },
        effective: { ...policy(2), evidence: evidence("fixture-runtime") },
      },
      identityEvidence: null,
      eligibility: "observation-only",
    },
    observation: source,
    cursor: {
      producerRef: source.producerRef,
      epochRef: "fixture-projection-epoch-1",
      epochVersion: 1,
      evidenceVersion: source.evidenceVersion,
      sourceObservedAt: source.clock.sourceObservedAt,
    },
    controls: input.requiredControls.map(({ control, desired }) => ({
      control,
      desired,
      delivered: { ...desired, evidence: evidence() },
      effective: { ...desired, evidence: evidence() },
      outcome: "effective",
      reasonCode: null,
      source: evidence(),
      sourceEpoch: { epochRef: "fixture-control-epoch-1", epochVersion: 1 },
    })),
  });
}
export function unavailable(input = request(), status = "unavailable", reasonCode = "unavailable") {
  return {
    schemaVersion: 1,
    projectionVersion: 1,
    input: copy(input),
    eligibility: "observation-only",
    status,
    reasonCode,
  };
}
