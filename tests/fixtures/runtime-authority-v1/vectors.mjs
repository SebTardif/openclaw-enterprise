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
export function sourceEvidence() {
  return {
    reference: "evidence/example",
    version: 1,
    sourceObservedAt: now,
    receivedAt: now,
    validUntil: until,
    uncertaintyMs: 0,
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
export function evidence() {
  return {
    schemaVersion: 1,
    kind: "runtime",
    target: target(),
    bindingVersion: 1,
    evidenceVersion: 1,
    observationRef: "observation/example",
    providerObservedAt: now,
    receivedAt: now,
    validUntil: until,
    uncertaintyMs: 0,
    binding: binding(),
    outcome: { result: "satisfied", reasonCode: "conditions-satisfied" },
    policyObservedAt: now,
    readinessObservedAt: now,
  };
}
export function evidenceRequest() {
  return {
    schemaVersion: 1,
    kind: "record-evidence",
    operationRef: id(13),
    requestRef: "request/example",
    target: target(),
    expectedLifecycleGeneration: 1,
    expectedAssignmentRecordVersion: 2,
    evidence: evidence(),
    expectedEvidenceVersion: null,
  };
}
export function retireRequest() {
  return {
    schemaVersion: 1,
    kind: "retire",
    operationRef: id(14),
    requestRef: "request/example",
    target: target(),
    expectedLifecycleGeneration: 2,
    expectedAssignmentRecordVersion: 3,
    bindingVersion: 1,
    expectedCurrentSelection: null,
    responsibilityRef: id(15),
    expectedResponsibilityVersion: 1,
    reasonCode: "agent-stopped",
  };
}
export function snapshot() {
  return {
    target: target(),
    binding: binding(),
    assignmentRecordVersion: 3,
    providerProfileRef: "provider/example",
    runtimeProfileRef: "runtime/example",
    identityProfileRef: "identity/example",
    profileDigests: { provider: digest, runtime: digest, identity: digest },
  };
}
export function registration() {
  return {
    registrationId: "registration/example",
    registrationVersion: 1,
    bundleSetVersion: 1,
    identityProfileRef: "identity/example",
    evidence: sourceEvidence(),
  };
}
export function resolveRequest(purpose = "model-call") {
  const base = {
    schemaVersion: 1,
    ...scope,
    assignmentRef: target().assignmentRef,
    requestRef: "request/example",
    purpose,
  };
  if (
    ["identity-registration", "readiness-probe", "cleanup", "completed-context-restore"].includes(
      purpose,
    )
  ) {
    base.operationRef = id(15);
    base.expectedResponsibilityVersion = 1;
  }
  if (purpose === "cleanup") base.requestedOperation = "terminate-instance";
  if (purpose === "completed-context-restore") {
    base.purposeContract = "completed-context-restore-v1";
    base.requestedSuboperation = "importCompletedContext";
  }
  return base;
}
export function current() {
  return {
    schemaVersion: 1,
    evaluatedAt: now,
    validUntil: until,
    requestRef: "request/example",
    result: "current",
    purpose: "model-call",
    reasonCode: "conditions-satisfied",
    snapshot: snapshot(),
    runtimeEvidence: sourceEvidence(),
    policyEvidence: sourceEvidence(),
    lifecycleGeneration: 1,
    selectionVersion: 1,
    identityEvidence: registration(),
    servingEvidence: sourceEvidence(),
    mutationEligibilityEvidence: sourceEvidence(),
  };
}
export function cleanup() {
  return {
    schemaVersion: 1,
    evaluatedAt: now,
    validUntil: until,
    requestRef: "request/example",
    result: "cleanup-eligible",
    purpose: "cleanup",
    reasonCode: "cleanup-allowed",
    operationRef: id(15),
    responsibilityVersion: 1,
    snapshot: snapshot(),
    allowedOperation: "terminate-instance",
    successorExclusionEvidence: sourceEvidence(),
    effectPreconditionEvidence: sourceEvidence(),
    cleanupPolicyEvidence: sourceEvidence(),
  };
}
export function unboundCleanup() {
  const { snapshot: _snapshot, ...base } = cleanup();
  return {
    ...base,
    allowedOperation: "remove-provider-object",
    targetKind: "owned-provider-object",
    target: target(),
    assignmentRecordVersion: 2,
    providerProfileRef: "provider/example",
    runtimeProfileRef: "runtime/example",
    identityProfileRef: "identity/example",
    profileDigests: { provider: digest, runtime: digest, identity: digest },
    providerObject: {
      provider: "occ/kubernetes-gvisor",
      component: "harness",
      clusterRef: "cluster/example",
      kubernetesNamespaceUid: id(7),
      deploymentUid: id(9),
    },
    ownershipEvidence: sourceEvidence(),
  };
}
export function candidate() {
  return {
    schemaVersion: 1,
    evaluatedAt: now,
    validUntil: until,
    requestRef: "request/example",
    result: "candidate-eligible",
    purpose: "identity-registration",
    reasonCode: "registration-allowed",
    snapshot: snapshot(),
    runtimeEvidence: sourceEvidence(),
    policyEvidence: sourceEvidence(),
    operationRef: id(15),
    responsibilityVersion: 1,
    allowedOperation: "register",
    registrationTemplateRef: "template/example",
    parentBindingRef: "parent/example",
    selectorEvidenceRef: "selectors/example",
  };
}
export function restore() {
  return {
    schemaVersion: 1,
    evaluatedAt: now,
    validUntil: until,
    requestRef: "request/example",
    result: "candidate-eligible",
    purpose: "completed-context-restore",
    purposeContract: "completed-context-restore-v1",
    reasonCode: "restore-operation-eligible",
    allowedSuboperation: "importCompletedContext",
    binding: {
      ...scope,
      conversationRef: "conversation/example",
      preparationRef: id(12),
      restoreRef: id(15),
      responsibilityVersion: 1,
      lifecycleGeneration: 1,
      gatewayAssignmentRef: { schemaVersion: 1, id: id(16) },
      harnessAssignmentRef: target().assignmentRef,
      gatewayBindingVersion: 1,
      harnessBindingVersion: 1,
      pairingRecordRef: "pair/example",
      pairingRecordVersion: 1,
      checkpointId: "checkpoint/example",
      checkpointHeadVersion: 1,
      completionSequence: 1,
      contextDigest: digest,
      gatewayStoreBindingRef: "store/gateway-v1",
      workspaceStoreBindingRef: "store/workspace-v1",
      admittedRevisionRef: `rev_${id(5)}`,
      admittedConfigurationDigest: digest,
      producerTupleRef: "tuple/example",
      currentPolicyEvidenceRef: "policy/example",
      restoreFenceEpoch: 1,
      nativeEffectRef: id(17),
    },
    currentPolicyEvidence: sourceEvidence(),
    pairingEvidence: sourceEvidence(),
  };
}
export function exactOperation() {
  return {
    schemaVersion: 1,
    ...scope,
    operationRef: id(11),
    operationKind: "bind",
    canonicalPayloadDigest: digest,
    requestRef: "request/example",
  };
}
export function receipt() {
  const { requestRef: _, ...key } = exactOperation();
  return {
    ...key,
    assignmentRef: target().assignmentRef,
    acceptedServiceIdentityRef: "service/observer",
    committedAt: now,
    assignmentRecordVersion: 2,
    outcome: { kind: "bind", binding: binding() },
  };
}
export function trust() {
  return {
    schemaVersion: 1,
    installationId: scope.installationId,
    configurationVersion: 1,
    serviceIdentityRef: "service/observer",
    serviceTrustProfileRef: "trust/service-v1",
    serviceTrustProfileDigest: digest,
    trustRootsRef: "roots/example",
    verifierProfileRef: "verifier/example",
    permittedRecipientRef: "service/authority",
    role: "compute-observer",
    allowedScope: { kind: "agent", ...scope },
  };
}
