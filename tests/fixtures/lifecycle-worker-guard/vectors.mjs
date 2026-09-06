import { createHash } from "node:crypto";
import { canonicalRuntimeEffectRequestV1 } from "../../../packages/contracts/src/runtime-effects-v1.ts";

// Data-only subset of tests/fixtures/runtime-effects-v1/vectors.mjs at c680e185.
// The leaf import avoids unrelated SDK preparation. No guard decisions are copied.
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
