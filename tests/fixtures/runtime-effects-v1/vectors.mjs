import { createHash } from "node:crypto";
import {
  canonicalRuntimeEffectRequestV1,
  canonicalRuntimeFenceRequestV1,
  canonicalRuntimeFaultRequestV1,
} from "@openclaw-enterprise/contracts";

// Representation fixtures only. None of these synthetic records is provider,
// authenticated currentness, PostgreSQL, runsc or physical-termination evidence.
export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const digest = (n = 1) => `sha256:${String(n).padStart(64, "0")}`;
export const hash = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
export const scope = {
  installationId: `ins_${uuid(1)}`,
  namespaceId: `ns_${uuid(2)}`,
  agentId: `agt_${uuid(3)}`,
};
export const now = "2026-01-01T00:00:01.000Z";
export const copy = (v) => structuredClone(v);
export const target = (n = 2) => ({
  ...scope,
  assignmentRef: { schemaVersion: 1, id: uuid(10 + n) },
  revisionId: `rev_${uuid(4)}`,
  component: "harness",
  lifecycleGeneration: n,
  runtimeGeneration: n,
  createEffectRef: uuid(20 + n),
});
export function binding(n = 2) {
  return {
    schemaVersion: 1,
    bindingVersion: 1,
    provider: "occ/kubernetes-gvisor",
    component: "harness",
    clusterRef: "cluster",
    kubernetesNamespaceUid: "namespace-uid",
    podUid: `pod-${n}`,
    deploymentUid: `deployment-${n}`,
    replicaSetUid: `replica-set-${n}`,
    imageDigests: [{ name: "harness", digest: digest(1) }],
    policyRevision: "policy-1",
    admittedConfigurationDigest: digest(2),
    profileDigests: { provider: digest(3), runtime: digest(4), identity: digest(5) },
    runtimeClass: "oce-gvisor-systrap",
    runtimeHandler: "oce-gvisor-systrap",
    runtimeType: "io.containerd.runsc.v1",
    platform: "systrap",
    isolation: "STRICT",
    runscSandboxId: `sandbox-${n}`,
    runtimeInstanceRef: `execution-${n}`,
    protectedRestartDiscriminator: `restart-${n}`,
    runtimeBinaryDigest: digest(6),
    runtimeDistributionDigest: digest(7),
    runtimeFlagsDigest: digest(8),
  };
}
export const responsibility = (kind = "preparation") => ({
  responsibilityRef: uuid(kind === "preparation" ? 31 : 32),
  responsibilityVersion: 1,
  kind,
});
export const providerTarget = (n = 2, apiKind = "Deployment") => ({
  targetRef: `${apiKind}-${n}`,
  clusterRef: "cluster",
  kubernetesNamespaceUid: "namespace-uid",
  apiKind,
  name: `${apiKind.toLowerCase()}-${n}`,
  ownerAssignmentRef: target(n).assignmentRef,
  ownerCreateEffectRef: target(n).createEffectRef,
});
export const providerObject = (n = 2, epoch = 2, apiKind = "Deployment", rv = "rv-2") => ({
  target: providerTarget(n, apiKind),
  uid: `${apiKind.toLowerCase()}-${n}`,
  resourceVersion: rv,
  fenceEpoch: epoch,
});
export const evidence = (name = "evidence", version = 1) => ({
  producerRef: "protected-producer",
  producerServiceVersion: 1,
  producerProfileRef: "producer-profile",
  producerProfileDigest: digest(9),
  acceptedPortRef: "protected-port",
  evidenceRef: name,
  evidenceVersion: version,
  clock: {
    sourceObservedAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.100Z",
    validUntil: "2026-01-01T00:00:15.000Z",
    uncertaintyMs: 100,
  },
});
export function plan() {
  return {
    schemaVersion: 1,
    scope,
    planRef: "plan",
    planVersion: 1,
    planDigest: digest(10),
    targets: [1, 2]
      .map((n) => ({
        target: providerTarget(n),
        desiredSpecDigest: digest(11),
        allowedMutations: ["reserve-inert", "materialize", "seal"],
      }))
      .concat([
        {
          target: providerTarget(2, "Service"),
          desiredSpecDigest: digest(12),
          allowedMutations: ["route-active", "route-inactive", "seal", "remove-exact"],
        },
      ]),
    producerDomains: [
      {
        domainRef: "controllers",
        kind: "deployment-descendants",
        targetRefs: ["Deployment-1", "Deployment-2"],
        requiredProducerRef: "compute-observer",
        requiredCapabilityRef: "controller-drain",
      },
      {
        domainRef: "starts",
        kind: "node-start-restart",
        targetRefs: ["Deployment-1", "Deployment-2"],
        requiredProducerRef: "execution-observer",
        requiredCapabilityRef: "protected-start-closure",
      },
    ],
    reservationRetention: "permanent",
    capacityPolicyRef: "finite-capacity-profile",
  };
}
export const gate = (kind = "preparation") => ({
  schemaVersion: 1,
  scope,
  intentRef: uuid(40),
  mode: "running",
  lifecycleGeneration: 2,
  requestedFenceEpoch: 2,
  responsibility: responsibility(kind),
  gateVersion: 4,
  planRef: "plan",
  planVersion: 1,
  planDigest: digest(10),
  admittedChildCutoff: 1,
});
export const locator = (kind = "reserve-inert", n = 2) => ({
  schemaVersion: 1,
  target: target(n),
  effectRef: uuid(50 + n),
  effectKind: kind,
  responsibility: responsibility(),
  requestDigest: digest(20),
});
export const storeRef = () => ({
  schemaVersion: 1,
  scope,
  logicalStoreRef: "workspace",
  bindingRef: "store-binding",
  bindingVersion: 1,
});
export const reservation = () => ({
  schemaVersion: 1,
  scope,
  reservationRef: "reservation",
  reservationVersion: 1,
});
export const attempt = () => ({
  schemaVersion: 1,
  reservation: reservation(),
  conversationRef: "conversation",
  turnRef: "turn",
  attemptRef: "attempt",
});
export const store = () => ({
  schemaVersion: 1,
  kind: "kubernetes-volume",
  ref: storeRef(),
  role: "workspace",
  clusterRef: "cluster",
  namespaceName: "tenant",
  namespaceUid: "namespace-uid",
  claimName: "workspace",
  claimUid: "claim-uid",
  volumeName: "workspace-volume",
  volumeUid: "volume-uid",
  storageProfileRef: "local-storage",
  storageProfileDigest: digest(30),
  filesystem: "ext4",
  accessMode: "ReadWriteOnce",
  volumeMode: "Filesystem",
  nodeIdentity: { nodeRef: "node-ref", nodeUid: "node-uid", affinityProfileDigest: digest(31) },
  mountPolicyDigest: digest(32),
  approvedSubpaths: [
    { category: "workspace", relativePath: "workspace", readOnly: false, component: "harness" },
  ],
  ownership: { uid: 1000, gid: 1000, fsGroup: 1000 },
});
export const noWriterRef = () => ({
  evidenceRef: "owner-snapshot",
  evidenceVersion: 1,
  reservation: reservation(),
  workspaceStore: storeRef(),
  stores: [storeRef()],
  closedPlanDigest: digest(10),
  admittedChildCutoff: 1,
});
export function signRequest(request) {
  request.effect.requestDigest = hash(canonicalRuntimeEffectRequestV1(request));
  return request;
}
export function createRequest(action = "reserve-inert") {
  return signRequest({
    schemaVersion: 1,
    kind: "create",
    action,
    effect: locator(action),
    gate: gate(),
    plan: plan(),
    providerTarget: providerTarget(),
    predicate:
      action === "reserve-inert"
        ? { kind: "expected-absent", retention: "permanent-inert-reservation" }
        : expectedObject(),
    admittedRuntime: {
      provider: "occ/kubernetes-gvisor",
      imageSetDigest: digest(1),
      configurationDigest: digest(2),
      runtimeProfileRef: "runtime-profile",
      runtimeProfileDigest: digest(4),
      containmentProfileDigest: digest(33),
      mountPolicyDigest: digest(32),
      resourceEnvelopeDigest: digest(34),
    },
    preparation: {
      kind: "nonmutating",
      preparationRef: uuid(60),
      preparationVersion: 1,
      admittedProfileDigest: digest(4),
      retainedStoreAccess: "none",
    },
  });
}
export const expectedObject = (n = 2, apiKind = "Deployment") => ({
  kind: "expected-object",
  uid: `${apiKind.toLowerCase()}-${n}`,
  resourceVersion: "rv-1",
  fenceEpoch: 1,
  ownerAssignmentRef: target(n).assignmentRef,
  ownerCreateEffectRef: target(n).createEffectRef,
});
export function routeRequest() {
  return signRequest({
    schemaVersion: 1,
    kind: "set-route",
    effect: locator("route-active"),
    gate: gate(),
    plan: plan(),
    providerTarget: providerTarget(2, "Service"),
    predicate: expectedObject(2, "Service"),
    desiredRoute: {
      kind: "active",
      selectedTarget: target(),
      binding: binding(),
      selectionRef: uuid(61),
      selectionVersion: 1,
      priorWriterEvidence: noWriterRef(),
    },
  });
}
export function stopRequest() {
  const effect = locator("seal", 1);
  effect.responsibility = responsibility("retained-stop");
  return signRequest({
    schemaVersion: 1,
    kind: "stop-retaining-state",
    effect,
    gate: gate("retained-stop"),
    plan: plan(),
    providerTarget: providerTarget(1),
    predicate: expectedObject(1),
    binding: binding(1),
    action: "seal",
    retainedStores: [storeRef()],
    retainState: true,
    gracefulStopMs: 30_000,
    observeForMs: 120_000,
  });
}
export const unknownResult = (request = createRequest()) => ({
  schemaVersion: 1,
  effect: request.effect,
  status: "unknown",
  phase: "provider-response",
  reasonCode: "provider-outcome-unknown",
});
export const appliedResult = (request = createRequest()) => ({
  schemaVersion: 1,
  effect: request.effect,
  status: "applied",
  object: {
    target: request.providerTarget,
    uid: request.predicate.kind === "expected-object" ? request.predicate.uid : "deployment-2",
    resourceVersion: "rv-2",
    fenceEpoch: 2,
  },
  providerReceipt: evidence("provider-receipt"),
});
export const exactCreate = () => ({
  schemaVersion: 1,
  effect: createRequest().effect,
  providerTarget: providerTarget(),
  expectedObject: null,
});
export const candidate = () => ({
  schemaVersion: 1,
  kind: "preallocated-candidate",
  target: target(),
  expectedEvidenceVersion: null,
  createEffect: exactCreate(),
  responsibility: responsibility(),
  preparation: createRequest().preparation,
});
export const completeObservation = () => ({
  schemaVersion: 1,
  status: "complete",
  input: candidate(),
  object: providerObject(),
  binding: binding(),
  observation: evidence("observation"),
  ownerChainEvidence: evidence("owner-chain"),
  executionCorrespondenceEvidence: evidence("execution-chain"),
  profile: {
    desired: { profileRef: "profile", version: 1, digest: digest(4) },
    delivered: {
      profileRef: "profile",
      version: 1,
      digest: digest(4),
      evidence: evidence("delivered"),
    },
    effective: {
      profileRef: "profile",
      version: 1,
      digest: digest(4),
      evidence: evidence("effective"),
    },
  },
  identityEvidence: null,
  eligibility: "observation-only",
});
export const fenceRequest = () => {
  const request = {
    schemaVersion: 1,
    fenceRef: uuid(70),
    requestDigest: digest(40),
    guard: gate("protective-fence"),
    plan: plan(),
    children: [createRequest().effect],
  };
  request.requestDigest = hash(canonicalRuntimeFenceRequestV1(request));
  return request;
};

export function fenceState() {
  const request = fenceRequest();
  return {
    schemaVersion: 1,
    status: "established",
    request,
    targets: request.plan.targets.map((entry) => ({
      target: entry.target,
      status: "sealed",
      object: {
        target: entry.target,
        uid: `${entry.target.apiKind.toLowerCase()}-${entry.target.targetRef.endsWith("1") ? 1 : 2}`,
        resourceVersion: "rv-sealed",
        fenceEpoch: 2,
      },
      evidence: evidence(`seal-${entry.target.targetRef}`),
    })),
    children: [
      {
        effect: request.children[0],
        status: "sealed",
        historicalOutcome: "unknown",
        seal: providerObject(2, 2, "Deployment", "rv-sealed"),
        retainedPredicate: { kind: "expected-absent", retention: "permanent-inert-reservation" },
        evidence: evidence("child-seal"),
      },
    ],
    completion: {
      comparedGuard: request.guard,
      committedGateVersion: 5,
      sealerAdmission: "closed",
      successorAdmission: "current-matching-only",
      evidence: evidence("completion"),
    },
    guarantee: "explicit-provider-submission-fence-only",
  };
}
export function preparedChild() {
  const request = createRequest();
  const bytes = canonicalRuntimeEffectRequestV1(request);
  return {
    schemaVersion: 1,
    effect: request.effect,
    guard: request.gate,
    providerTarget: request.providerTarget,
    predicate: request.predicate,
    request,
    canonicalRequestJson: bytes,
    requestBytesDigest: hash(bytes),
    providerWire: {
      requestRef: "retained-provider-wire",
      bytesDigest: digest(91),
      byteLength: 1024,
      rendererProfileRef: "conditional-renderer",
      rendererProfileDigest: digest(92),
    },
  };
}
export const gateState = () => ({
  status: "observed",
  guard: gate("protective-fence"),
  ordinaryAdmission: "closed",
  sealerAdmission: "open",
  plan: plan(),
  children: [preparedChild()],
  authority: "current",
  evidence: evidence("gate-current"),
});
export const handoffInput = () => ({
  schemaVersion: 1,
  guard: gate("protective-fence"),
  plan: plan(),
  successor: target(),
  reservation: reservation(),
  workspaceStore: storeRef(),
  stores: [storeRef()],
  possibleWriters: [
    {
      kind: "execution",
      ownerRef: "prior-execution",
      execution: { target: target(1), binding: binding(1) },
    },
  ],
});
export function handoffResult() {
  const input = handoffInput();
  return {
    schemaVersion: 1,
    status: "released",
    input,
    canonicalOwnerSnapshot: evidence("owner-snapshot"),
    journalWorkspaceBindingEvidence: evidence("journal-workspace"),
    writers: input.possibleWriters.map((owner) => ({
      owner,
      status: "terminated",
      execution: owner.execution,
      terminationEvidence: evidence("termination"),
    })),
    producerDomains: input.plan.producerDomains.map((domain) => ({
      domain,
      mechanism: "protected-start-termination-boundary",
      closureEvidence: {
        ...evidence(`closure-${domain.domainRef}`),
        producerRef: domain.requiredProducerRef,
        acceptedPortRef: domain.requiredCapabilityRef,
      },
    })),
    observedStoreBindings: [store()],
    journalAttempt: { status: "no-attempt-confirmed", evidence: evidence("no-attempt") },
    release: "prior-writer-barrier-only",
  };
}
export const storeResult = () => ({
  schemaVersion: 1,
  status: "verified",
  input: { schemaVersion: 1, store: storeRef(), target: target(), binding: binding() },
  store: store(),
  mount: {
    mountIdentityRef: "actual-mount",
    filesystemIdentityRef: "actual-filesystem",
    namespaceUid: "namespace-uid",
    claimUid: "claim-uid",
    volumeUid: "volume-uid",
    nodeUid: "node-uid",
    effectiveMountPolicyDigest: digest(32),
    effectiveFilesystem: "ext4",
    effectiveAccessMode: "ReadWriteOnce",
    effectiveUid: 1000,
    effectiveGid: 1000,
    effectiveFsGroup: 1000,
    subpaths: [
      {
        category: "workspace",
        relativePath: "workspace",
        readOnly: false,
        mountIdentityRef: "workspace-mount",
      },
    ],
  },
  evidence: evidence("actual-mount"),
  guarantee: "exact-mount-binding-only",
});
export const fault = () => {
  const request = {
    schemaVersion: 1,
    operation: {
      schemaVersion: 1,
      scope,
      operationRef: uuid(80),
      operationKind: "fault-and-fence",
      requestDigest: digest(50),
    },
    target: target(),
    guard: gate(),
    cleanupResponsibility: responsibility("retained-stop"),
    reasonCode: "authority-lost",
    cause: {
      kind: "authority-loss",
      source: "service",
      authorityRef: "service-authority",
      previousVersion: 1,
      currentVersion: 2,
      currentnessEvidence: evidence("loss"),
      recoveryResponsibilityRef: uuid(81),
    },
  };
  request.operation.requestDigest = hash(canonicalRuntimeFaultRequestV1(request));
  return request;
};
