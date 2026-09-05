const uid = "00000000-0000-4000-8000-000000000001";
export const context = {
  installationRef: `ins_${uid}`,
  namespaceRef: `ns_${uid}`,
  agentRef: `agt_${uid}`,
  conversationRef: "conversation-one",
};
export const attempt = {
  ...context,
  turnRef: "turn-one",
  attemptRef: "attempt-one",
  reservationRef: "reservation-one",
};
export const scope = {
  installationId: context.installationRef,
  namespaceId: context.namespaceRef,
  agentId: context.agentRef,
};
export const reservation = {
  schemaVersion: 1,
  scope,
  reservationRef: attempt.reservationRef,
  reservationVersion: 1,
};
export const workspace = {
  schemaVersion: 1,
  scope,
  logicalStoreRef: "workspace-one",
  bindingRef: "store-binding-one",
  bindingVersion: 1,
};
export const head = {
  context,
  headVersion: 1,
  completionSequence: 0,
  checkpointId: null,
  creationRef: "creation-one",
};
export const locator = {
  schemaVersion: 1,
  installationRef: context.installationRef,
  channelInstallationRef: "channel-installation-one",
  eventKey: "a".repeat(64),
  logicalMessageKey: "b".repeat(64),
};
export const receipt = {
  schemaVersion: 1,
  receiptRef: "receipt-one",
  eventKey: locator.eventKey,
  logicalMessageKey: locator.logicalMessageKey,
  eventDigest: "c".repeat(64),
  contentDigest: "d".repeat(64),
  profileConfigurationDigest: "e".repeat(64),
};
export const identity = {
  locator,
  receipt,
  context,
  principalRef: "principal-one",
  principalVersion: 1,
  externalIdentityBindingRef: "identity-binding-one",
  providerSubjectRef: "subject-one",
  routeKey: "f".repeat(64),
  conversationBindingVersion: 1,
  routingPolicyVersion: 1,
  commonGrantRef: "grant-one",
  commonGrantVersion: 1,
  workspace,
  audiencePolicyRef: "audience-one",
  audienceEvidenceRef: "audience-evidence-one",
  audienceVersion: 1,
  replyDestinationRef: "destination-one",
  replyBindingVersion: 1,
  admittedRevisionRef: `rev_${uid}`,
  admittedConfigurationDigest: "1".repeat(64),
  gatewayAssignment: { schemaVersion: 1, id: "00000000-0000-4000-8000-000000000002" },
  harnessAssignment: { schemaVersion: 1, id: "00000000-0000-4000-8000-000000000003" },
  harnessRuntimeGeneration: 1,
  contentRef: "content-one",
};
export const admission = {
  schemaVersion: 1,
  identity,
  decision: { kind: "accepted", attempt },
  expectedHead: head,
  decisionRef: "decision-one",
  auditIntentRef: "audit-one",
  decidedAt: "2026-01-01T00:00:00.000Z",
};
export const attemptRecord = {
  binding: {
    attempt,
    identity,
    reservation,
    expectedHead: head,
    dispatchOperationRef: "dispatch-one",
    authorityDecisionRef: "authority-one",
    expiresAt: "2026-01-01T00:15:00.000Z",
  },
  version: 3,
  consumption: {
    operation: {
      schemaVersion: 1,
      attempt,
      operationRef: "consume-one",
      claimantRef: "claimant-one",
      requestDigest: "a".repeat(64),
    },
    consumedAt: "2026-01-01T00:00:01.000Z",
  },
  outcome: {
    kind: "consumed",
    consumptionOperationRef: "consume-one",
    consumedAt: "2026-01-01T00:00:01.000Z",
  },
};
export const allocation = {
  schemaVersion: 1,
  attempt,
  operationRef: "allocate-one",
  checkpointId: "checkpoint-one",
  expectedHead: head,
};
export const checkpoint = {
  ...attempt,
  schemaVersion: 1,
  checkpointId: "checkpoint-one",
  completionSequence: 1,
  parentCheckpointId: null,
  contentDigest: "2".repeat(64),
  byteLength: 1024,
  itemCount: 2,
  revisionRef: identity.admittedRevisionRef,
  admittedConfigurationDigest: identity.admittedConfigurationDigest,
  revisionLineageRef: "lineage-one",
  producingGatewayAssignmentRef: identity.gatewayAssignment.id,
  producingHarnessAssignmentRef: identity.harnessAssignment.id,
  producerTuple: {
    enterpriseCommit: "1".repeat(40),
    upstreamCommit: "2".repeat(40),
    codexCommit: "3".repeat(40),
    codexVersion: "0.153.0",
    gatewayProtocol: 4,
    nativeStateSchema: 15,
    nativeAgentSchema: 19,
    adapterSchema: 1,
    contextFormat: "completed-context-text-v1",
    nativeImportContract: 1,
    nativeImportAdapterDigest: "4".repeat(64),
    artifactLedgerRef: "ledger-one",
  },
  gatewayStoreBindingRef: "gateway-store-one",
  workspaceBindingRef: workspace.bindingRef,
  workspaceCompletionRef: "workspace-completion-one",
};
export const deliveryOperation = {
  schemaVersion: 1,
  attempt,
  operationRef: "delivery-one",
  outputRef: "output-one",
  outputDigest: "5".repeat(64),
  outcomeVersion: 4,
  slot: "completed-result",
  replyDestinationRef: identity.replyDestinationRef,
  replyBindingVersion: 1,
  operation: { kind: "create" },
};
export const completionOperation = {
  schemaVersion: 1,
  attempt,
  operationRef: "completion-one",
  checkpointId: checkpoint.checkpointId,
  expectedCompletionSequence: 0,
  expectedAttemptVersion: 3,
  requestDigest: "6".repeat(64),
};
export const completion = {
  operation: completionOperation,
  checkpoint,
  head: { ...head, headVersion: 2, completionSequence: 1, checkpointId: checkpoint.checkpointId },
  outcomeVersion: 4,
  pendingDelivery: deliveryOperation,
};
export const release = {
  attempt,
  reservation,
  workspace,
  releaseOperationRef: "release-one",
  noMutatorEvidenceRef: "no-mutator-one",
  closedOwnerInventoryRef: "inventory-one",
  closedOwnerInventoryVersion: 1,
  closedOwnerInventoryDigest: "7".repeat(64),
  expectedAttemptVersion: 3,
};
export const outcome = {
  schemaVersion: 1,
  attempt,
  operationRef: "outcome-one",
  expectedAttemptVersion: 3,
  outcome: { kind: "failed", stage: "execution", evidenceRef: "terminal-one" },
  requestDigest: "8".repeat(64),
};
export const nonTurn = {
  schemaVersion: 1,
  installationRef: context.installationRef,
  channelInstallationRef: "channel-installation-one",
  platform: "slack",
  providerTenantRef: "tenant-one",
  recipientAppRef: "app-one",
  eventKey: "9".repeat(64),
  eventDigest: "a".repeat(64),
  classification: "edit",
  logicalMessage: { kind: "related-only", logicalMessageKey: "b".repeat(64) },
  normalizationProfileRef: "non-turn-profile-one",
};
export const copy = (value) => structuredClone(value);
