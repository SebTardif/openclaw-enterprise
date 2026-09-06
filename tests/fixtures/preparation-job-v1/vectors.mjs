import {
  id,
  digest,
  now,
  at,
  subject,
  checkoutRequest,
  checkoutReceipt,
  provenance as credentialProvenance,
} from "../repository-preparation-v1/vectors.mjs";
import { preparationCheckoutRequestDigestV1 } from "@openclaw-enterprise/contracts/repository-preparation-codec-v1";
import {
  preparationJobPlanDigestV1,
  preparationJobMutationDigestV1,
  preparationJobAttemptManifestDigestV1,
  preparationJobAdmissionManifestDigestV1,
} from "@openclaw-enterprise/contracts/preparation-job-codec-v1";
export { id, digest, now, at };
export const clone = (value) => structuredClone(value);
export const clock = (ms = 1000) => ({
  sourceObservedAt: at(ms),
  receivedAt: at(ms),
  validUntil: at(ms + 4000),
  uncertaintyMs: 0,
});
export function provenance(kind, ms = 1000) {
  return {
    producerRef: `producer/${kind}`,
    producerServiceVersion: 1,
    producerProfileRef: `profile/${kind}`,
    producerProfileDigest: digest,
    acceptedPortRef: `port/${kind}`,
    evidenceRef: `evidence/${kind}/${ms}`,
    evidenceVersion: 1,
    clock: clock(ms),
  };
}
export function sealDigest(value) {
  return { ...value, requestDigest: preparationJobMutationDigestV1(value) };
}
export function scenario() {
  const preparation = subject();
  const target = {
    schemaVersion: 1,
    purpose: preparation.purpose,
    preparation,
    clusterRef: "cluster/example",
    kubernetesNamespace: "candidate",
    kubernetesNamespaceUid: "namespace-uid",
    apiVersion: "batch/v1",
    apiKind: "Job",
    name: "candidate-preparation",
    reservationRef: id(30),
    retention: "permanent-inert-reservation",
  };
  const plan = {
    schemaVersion: 1,
    planRef: preparation.gate.planRef,
    planVersion: preparation.gate.planVersion,
    planDigest: digest,
    target,
    jobSpecDigest: digest,
    podTemplateDigest: digest,
    profile: {
      initialSuspend: true,
      parallelism: 1,
      completions: 1,
      completionMode: "NonIndexed",
      backoffLimit: 0,
      restartPolicy: "Never",
      automaticRootDeletion: false,
      runtimeHandler: "runsc",
      platform: "systrap",
      isolationPolicy: "STRICT",
      runscExecutableDigest: digest,
      runtimeProfileDigest: digest,
      containmentProfileDigest: digest,
      mountPolicyDigest: digest,
      resourceEnvelopeDigest: digest,
      identityProfileRef: "identity/preparation",
      identityProfileDigest: digest,
      admittedExecutionNotAfter: preparation.notAfter,
    },
    producerDomains: ["job-controller", "node-runtime", "staging-writers"].map((kind) => ({
      domainRef: `domain/${kind}`,
      kind,
      requiredProducerRef: `producer/${kind}`,
      requiredCapabilityRef: `capability/${kind}`,
      profileDigest: digest,
    })),
    reservationRetention: "permanent",
  };
  const planDigest = preparationJobPlanDigestV1(plan);
  plan.planDigest = planDigest;
  preparation.gate.planDigest = planDigest;
  const checkout = { ...checkoutRequest(), preparation: clone(preparation), effectRef: id(32) };
  checkout.requestDigest = preparationCheckoutRequestDigestV1(checkout);
  const reserve = sealDigest({
    schemaVersion: 1,
    effectRef: id(31),
    requestDigest: digest,
    requestId: `req_${id(34)}`,
    createdAt: now,
    deadline: at(5000),
    method: "reserve-job",
    target,
    plan,
    checkout,
    releaseEffectRef: checkout.effectRef,
    gate: clone(preparation.gate),
    predicate: { kind: "expected-absent", retention: "permanent-inert-reservation" },
  });
  const predicate = {
    kind: "expected-job",
    jobUid: "job-uid",
    resourceVersion: "job-rv-1",
    namespaceUid: target.kubernetesNamespaceUid,
    ownerPreparationRef: preparation.preparationRef,
    ownerIncarnationRef: preparation.incarnationRef,
    ownerReserveEffectRef: reserve.effectRef,
    fenceEpoch: 1,
  };
  const release = sealDigest({
    schemaVersion: 1,
    effectRef: reserve.releaseEffectRef,
    requestDigest: digest,
    requestId: `req_${id(35)}`,
    createdAt: at(100),
    deadline: at(5000),
    method: "release-job",
    original: reserve,
    gate: clone(reserve.gate),
    predicate,
  });
  const pod = {
    namespaceUid: target.kubernetesNamespaceUid,
    jobUid: predicate.jobUid,
    controllerKind: "Job",
    controllerUid: predicate.jobUid,
    podUid: "pod-uid",
    resourceVersion: "pod-rv-1",
  };
  const execution = {
    executionRef: "execution/one",
    executionGeneration: 1,
    podUid: pod.podUid,
    nodeUid: "node-uid",
    sandboxId: "sandbox/one",
    containerName: "checkout",
    containerKind: "main",
    runtimeHandler: "runsc",
    platform: "systrap",
    isolationPolicy: "STRICT",
    runscExecutableDigest: digest,
    runtimeProfileDigest: digest,
    identityProfileRef: plan.profile.identityProfileRef,
    identityProfileDigest: digest,
  };
  const identity = {
    schemaVersion: 1,
    purpose: preparation.purpose,
    target,
    reserveEffectRef: reserve.effectRef,
    reserveRequestDigest: reserve.requestDigest,
    releaseEffectRef: release.effectRef,
    authorizationGeneration: 1,
    lifecycleGeneration: 1,
    fenceEpoch: 1,
    pod,
    execution,
    controlPlane: provenance("job-controller"),
    runtime: provenance("node-runtime"),
  };
  const receipt = {
    ...checkoutReceipt(),
    request: checkout,
    effectRef: checkout.effectRef,
    effectRequestDigest: checkout.requestDigest,
    provenance: { ...credentialProvenance(), clock: clock() },
  };
  const pair = { schemaVersion: 1, release, identity, receipt };
  const guard = {
    ...clone(reserve.gate),
    mode: "stopped",
    lifecycleGeneration: 2,
    requestedFenceEpoch: 2,
    responsibility: {
      responsibilityRef: id(40),
      responsibilityVersion: 2,
      kind: "protective-fence",
    },
    gateVersion: 2,
    admittedChildCutoff: 3,
  };
  const cleanupBinding = {
    reserveEffectRef: reserve.effectRef,
    reserveRequestDigest: reserve.requestDigest,
    targetPlanRef: plan.planRef,
    targetPlanVersion: plan.planVersion,
    targetPlanDigest: plan.planDigest,
    responsibility: guard.responsibility,
  };
  const seal = sealDigest({
    schemaVersion: 1,
    effectRef: id(33),
    requestDigest: digest,
    requestId: `req_${id(36)}`,
    createdAt: at(6000),
    deadline: at(11000),
    method: "seal-job",
    original: reserve,
    gate: guard,
    cleanupBinding,
    predicate,
    closeAdmittedChildCutoff: 3,
  });
  const { closeAdmittedChildCutoff: _cutoff, ...cleanup } = seal;
  const terminate = sealDigest({
    ...cleanup,
    effectRef: id(37),
    method: "terminate-exact",
    terminationTarget: { kind: "runtime-execution", pod, execution },
  });
  return {
    target,
    plan,
    reserve,
    release,
    predicate,
    pod,
    execution,
    identity,
    pair,
    guard,
    cleanupBinding,
    seal,
    terminate,
  };
}
export function read(original, method = "observe-job", gate = original.gate, ms = 1000, admission) {
  return {
    schemaVersion: 1,
    method,
    original,
    gate,
    requestId: `req_${id(44)}`,
    createdAt: at(ms),
    deadline: at(ms + 3000),
    ...(method === "read-closure" ? { admission: clone(admission) } : {}),
  };
}
function root(s, suspended, resourceVersion, fenceEpoch) {
  const { kind: _kind, jobUid, ...owner } = s.predicate;
  return { ...owner, uid: jobUid, suspended, resourceVersion, fenceEpoch };
}
export function observation(s, ms = 1000) {
  return {
    schemaVersion: 1,
    original: s.reserve,
    gate: clone(s.reserve.gate),
    job: root(s, false, "job-rv-2", 1),
    pods: [clone(s.pod)],
    executions: [clone(s.execution)],
    collection: {
      state: "complete",
      snapshotRef: "snapshot/one",
      sourceResourceVersion: "list-rv",
      observedChildCutoff: 0,
    },
    controlPlane: provenance("job-controller", ms),
    runtime: provenance("node-runtime", ms),
  };
}
export function admissionSnapshot(s) {
  const members = [
    {
      attemptRef: "attempt/root",
      effectRef: s.reserve.effectRef,
      requestDigest: s.reserve.requestDigest,
      domainRef: "domain/job-controller",
      admittedSequence: 0,
    },
    {
      attemptRef: "attempt/release",
      effectRef: s.release.effectRef,
      requestDigest: s.release.requestDigest,
      domainRef: "domain/job-controller",
      admittedSequence: 1,
    },
    {
      attemptRef: "attempt/pod",
      effectRef: id(43),
      requestDigest: digest,
      domainRef: "domain/job-controller",
      admittedSequence: 2,
    },
    {
      attemptRef: "attempt/execution",
      effectRef: id(42),
      requestDigest: digest,
      domainRef: "domain/node-runtime",
      admittedSequence: 3,
    },
  ];
  return {
    schemaVersion: 1,
    snapshotRef: "admission/snapshot",
    snapshotVersion: 1,
    original: clone(s.reserve),
    gate: clone(s.guard),
    closedChildCutoff: 3,
    admissionSealVersion: 2,
    targetPlanDigest: s.plan.planDigest,
    admission: "closed",
    members,
    manifestDigest: preparationJobAdmissionManifestDigestV1(members),
    provenance: provenance("canonical-admission", 7000),
  };
}
export function closure(s) {
  const admission = admissionSnapshot(s);
  const domains = s.plan.producerDomains.map((d) => ({
    domainRef: d.domainRef,
    kind: d.kind,
    capabilityRef: d.requiredCapabilityRef,
    originalReserveEffectRef: s.reserve.effectRef,
    targetPlanDigest: s.plan.planDigest,
    closedChildCutoff: 3,
    sealVersion: 2,
    futureStarts: "closed",
    unresolvedAttempts: 0,
    unresolvedWriters: 0,
    provenance: provenance(d.kind, 7000),
  }));
  const attempts = [
    {
      ...admission.members[0],
      outcome: "inert-root",
      rootUid: s.predicate.jobUid,
      rootResourceVersion: "job-rv-3",
      resolutionEvidenceRef: domains[0].provenance.evidenceRef,
    },
    // Lost release acknowledgement remains historical uncertainty. The independent
    // controller/node closures resolve every possible physical execution instead.
    {
      ...admission.members[1],
      outcome: "executions-excluded",
      originalEffectOutcome: "unknown",
      resolutionEvidenceRef: domains[0].provenance.evidenceRef,
    },
    {
      ...admission.members[2],
      outcome: "terminated",
      pod: clone(s.pod),
      execution: clone(s.execution),
      finalState: "execution-terminated",
      resolutionEvidenceRef: domains[0].provenance.evidenceRef,
    },
    {
      ...admission.members[3],
      outcome: "terminated",
      pod: clone(s.pod),
      execution: clone(s.execution),
      finalState: "execution-terminated",
      resolutionEvidenceRef: domains[1].provenance.evidenceRef,
    },
  ];
  return {
    schemaVersion: 1,
    original: clone(s.reserve),
    gate: clone(s.guard),
    cleanupBinding: clone(s.cleanupBinding),
    root: root(s, true, "job-rv-3", 2),
    admission,
    targetPlanDigest: s.plan.planDigest,
    closedChildCutoff: 3,
    admissionSealVersion: 2,
    attemptManifestDigest: preparationJobAttemptManifestDigestV1(attempts),
    attempts,
    producerDomains: domains,
    staging: clone(s.target.preparation.staging),
    storeEvidence: {
      staging: clone(s.target.preparation.staging),
      closedChildCutoff: 3,
      targetPlanDigest: s.plan.planDigest,
      writerState: "no-writers",
      provenance: provenance("staging-writers", 7000),
    },
    outcome: "original-writers-excluded",
  };
}
export function unknown(original, reason = "provider-outcome-unknown") {
  return { status: "unknown", original, reason, nextAction: "retain-original-and-readback" };
}
