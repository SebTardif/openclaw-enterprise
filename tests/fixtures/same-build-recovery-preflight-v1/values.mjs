import { readFileSync } from "node:fs";

// Fixed canonical bytes, not a fixture codec or an authenticated checkpoint producer.
export const canonicalBytes = readFileSync(new URL("./canonical-context.utf8", import.meta.url));
export function tuple() {
  return {
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
    artifactLedgerRef: "artifact-ledger/fixture-build-1",
  };
}
export function checkpoint() {
  return {
    installationRef: "ins_11111111-1111-4111-8111-111111111111",
    namespaceRef: "ns_22222222-2222-4222-8222-222222222222",
    agentRef: "agt_33333333-3333-4333-8333-333333333333",
    conversationRef: "conversation/one",
    turnRef: "turn/7",
    attemptRef: "attempt/7",
    reservationRef: "reservation/7",
    schemaVersion: 1,
    checkpointId: "checkpoint/7",
    completionSequence: 7,
    parentCheckpointId: "checkpoint/6",
    contentDigest: "60ade7995e203c0fdbdebe20ff6913d294ddfffd5caa9d9085540a35faf9181a",
    byteLength: 818,
    itemCount: 2,
    revisionRef: "rev_44444444-4444-4444-8444-444444444444",
    admittedConfigurationDigest: "5".repeat(64),
    revisionLineageRef: "lineage/one",
    producingGatewayAssignmentRef: "55555555-5555-4555-8555-555555555555",
    producingHarnessAssignmentRef: "66666666-6666-4666-8666-666666666666",
    producerTuple: tuple(),
    gatewayStoreBindingRef: "gateway-store/1",
    workspaceBindingRef: "workspace-store/1",
    workspaceCompletionRef: "workspace-completion/7",
  };
}
export function input() {
  return {
    expectedCheckpoint: checkpoint(),
    checkpoint: checkpoint(),
    candidateTuple: tuple(),
    canonicalBytes: Uint8Array.from(canonicalBytes),
  };
}
