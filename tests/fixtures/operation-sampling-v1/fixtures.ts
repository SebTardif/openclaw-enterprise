import {
  ACCEPTANCE_ALLOCATION_SHA256_V1,
  ACCEPTANCE_LEAVES_V1,
  type AcceptanceDigestDomainV1,
  type AcceptanceLeafIdV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-v1";
import { digestAcceptanceBytesV1 } from "@openclaw-enterprise/contracts/acceptance-companion-codec-v1";
import { syntheticCompanion, syntheticReceipt } from "../acceptance-companion-v1/producer.ts";
import {
  SAMPLING_SCHEMA_DIGESTS_V1,
  SELECTED_P6_SHA256_V1,
  encodeSamplingV1,
  type InstallerJournalV1,
  type SampleAttemptV1,
  type SampleJournalV1,
  type SamplingClockV1,
  type SamplingInputsV1,
  type SamplingPlanV1,
} from "../../../scripts/release-evidence/operation-sampling-v1/schema.ts";
import { type JournalReceiptDeclarationV1 } from "../../../scripts/release-evidence/operation-sampling-v1/sampling.ts";

export const encode = encodeSamplingV1;
export const fictionalDigest = <D extends AcceptanceDigestDomainV1>(
  domain: D,
  label: string = domain,
) => digestAcceptanceBytesV1(domain, encode({ fictional: label }));
export function syntheticClock(
  milliseconds = 0,
  uncertaintyMs = 0,
  clockRef = "fictional-clock",
): SamplingClockV1 {
  return {
    state: "available",
    clockRef,
    observedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + milliseconds).toISOString(),
    uncertaintyMs,
    monotonic: { state: "available", clockRef: `${clockRef}-monotonic`, ticksMs: milliseconds },
  };
}
export function syntheticInputs(): SamplingInputsV1 {
  const companion = syntheticCompanion();
  return {
    inputManifest: companion.inputManifest,
    procedure: companion.procedure,
    limits: companion.limits,
    tuple: companion.tuple,
    demonstrationInputs: companion.demonstrationInputs,
    procedureReview: { state: "present", digest: fictionalDigest("review", "procedure") },
  };
}
export function syntheticPlan(): SamplingPlanV1 {
  const requirements: SamplingPlanV1["requirements"] = [
    {
      requirementId: "fictional-install",
      kind: "runtime-operation",
      operationId: "fictional-install",
      conditionId: null,
      variantId: "fictional-baseline",
      variantKind: "baseline",
      channel: "none",
      purpose: "cold-install",
      leafId: "R1-outside-install",
      requiredCount: 3,
      freshness: "fresh-seed",
      measurements: [],
      denialBoundaryIds: [],
    },
    {
      requirementId: "fictional-replace",
      kind: "runtime-operation",
      operationId: "fictional-replace",
      conditionId: null,
      variantId: "fictional-restart",
      variantKind: "restart",
      channel: "none",
      purpose: "replacement",
      leafId: "R11-time-limits-tool",
      requiredCount: 3,
      freshness: "fresh-seed",
      measurements: [],
      denialBoundaryIds: [],
    },
    ...(["slack", "teams"] as const).map((channel) => ({
      requirementId: `fictional-story-${channel}`,
      kind: "native-story" as const,
      operationId: "fictional-collaboration",
      conditionId: null,
      variantId: "fictional-baseline",
      variantKind: "baseline" as const,
      channel,
      purpose: "none" as const,
      leafId: "R11-collaborator-samples" as const,
      requiredCount: 10,
      freshness: "fresh-seed" as const,
      measurements: [],
      denialBoundaryIds: [],
    })),
    {
      requirementId: "fictional-disable",
      kind: "timed-condition",
      operationId: "fictional-disable",
      conditionId: "fictional-deny",
      variantId: "fictional-baseline",
      variantKind: "baseline",
      channel: "none",
      purpose: "none",
      leafId: "R11-diagnostics-denial",
      requiredCount: 10,
      freshness: "fresh-seed",
      measurements: [],
      denialBoundaryIds: ["fictional-local"],
    },
    {
      requirementId: "fictional-outage",
      kind: "negative",
      operationId: "fictional-failure",
      conditionId: "fictional-outage",
      variantId: "fictional-outage",
      variantKind: "outage",
      channel: "none",
      purpose: "none",
      leafId: "R11-diagnostics-unreachable",
      requiredCount: 1,
      freshness: "fresh-seed",
      measurements: [],
      denialBoundaryIds: [],
    },
    {
      requirementId: "fictional-negative",
      kind: "negative",
      operationId: "fictional-failure",
      conditionId: "fictional-negative",
      variantId: "fictional-negative",
      variantKind: "negative",
      channel: "none",
      purpose: "none",
      leafId: "R11-diagnostics-launch-failure",
      requiredCount: 1,
      freshness: "fresh-seed",
      measurements: [],
      denialBoundaryIds: [],
    },
  ];
  return {
    schemaVersion: "operation-sampling-plan/v1",
    schemaDigest: SAMPLING_SCHEMA_DIGESTS_V1.plan,
    planId: "fictional-plan",
    runId: "synthetic-run",
    source: "synthetic",
    selection: {
      allocationSha256: ACCEPTANCE_ALLOCATION_SHA256_V1,
      p6DispositionSha256: SELECTED_P6_SHA256_V1,
      localDenialTargetMs: 60_000,
      providerObservationLimitMs: 120_000,
    },
    inputs: syntheticInputs(),
    requirementsEvidence: fictionalDigest("input", "reviewed-requirements"),
    requirements,
    expected: requirements.flatMap((row) =>
      Array.from({ length: row.requiredCount }, (_, index) => ({
        sampleId: `${row.requirementId}-${index}`,
        attemptId: `${row.requirementId}-${index}-attempt`,
        requirementId: row.requirementId,
        storyId: row.kind === "native-story" ? `${row.requirementId}-${index}-story` : null,
        seed: fictionalDigest("input", `${row.requirementId}-${index}-seed`),
      })),
    ),
  };
}
export function syntheticObservation(): SampleAttemptV1["physicalTermination"] {
  return { state: "unknown", clock: { state: "missing" }, evidence: { state: "missing" } };
}
export function syntheticExecution(id: string): SampleAttemptV1["execution"] {
  return {
    state: "launched",
    executionClass: "unit",
    executorRef: "fictional-installer",
    tool: { state: "present", digest: fictionalDigest("tool") },
    started: syntheticClock(),
    ended: syntheticClock(1_000),
    interval: { state: "available", clockRef: "fictional-clock-monotonic", durationMs: 1_000 },
    capture: {
      state: "claimed",
      authorityRef: "fictional-observer",
      executorBinding: fictionalDigest("evidence", "executor"),
      sourceAttemptBinding: fictionalDigest("evidence", id),
    },
  };
}
export function syntheticSamples(plan: SamplingPlanV1 = syntheticPlan()): SampleJournalV1 {
  return {
    schemaVersion: "operation-sample-journal/v1",
    schemaDigest: SAMPLING_SCHEMA_DIGESTS_V1.sample,
    journalId: "fictional-samples",
    runId: plan.runId,
    source: "synthetic",
    plan: digestAcceptanceBytesV1("input", encode(plan)),
    inputs: plan.inputs,
    omissions: [],
    attempts: plan.expected.map((slot) => {
      const requirement = plan.requirements.find(
        (row) => row.requirementId === slot.requirementId,
      )!;
      const leaf = ACCEPTANCE_LEAVES_V1[requirement.leafId];
      return {
        attemptId: slot.attemptId,
        sampleId: slot.sampleId,
        requirementId: slot.requirementId,
        storyId: slot.storyId,
        originalAttemptId: slot.attemptId,
        supersedesAttemptId: null,
        kind: "fresh",
        operationId: requirement.operationId,
        conditionId: requirement.conditionId,
        variantId: requirement.variantId,
        variantKind: requirement.variantKind,
        channel: requirement.channel,
        purpose: requirement.purpose,
        leafId: requirement.leafId,
        parentCaseId: leaf.parentCaseId,
        parentAssertionId: leaf.parentAssertionId,
        producerRef: "fictional-producer",
        seed: slot.seed,
        freshnessEvidence: {
          state: "present",
          digest: fictionalDigest("evidence", `${slot.sampleId}-freshness`),
        },
        captureReferences: [fictionalDigest("evidence", slot.attemptId)],
        outcome: "pass",
        collection: "received",
        accepted: true,
        execution: syntheticExecution(slot.attemptId),
        turns:
          slot.storyId === null
            ? []
            : (["A", "B"] as const).map((participant) => ({
                turnId: `${slot.attemptId}-${participant}`,
                participant,
                actorRef: `fictional-actor-${participant}`,
                outcome: "pass" as const,
                evidence: {
                  state: "present" as const,
                  digest: fictionalDigest("evidence", `${slot.attemptId}-${participant}`),
                },
              })),
        clocks: {
          requestReceived: syntheticClock(),
          authenticatedAcceptance: syntheticClock(100),
          durableCommit: syntheticClock(200),
        },
        commitState: "confirmed",
        boundaries: requirement.denialBoundaryIds.map((boundaryId) => ({
          boundaryId,
          lastAllow: syntheticClock(190),
          firstDeny: syntheticClock(500),
          denial: {
            state: "denied" as const,
            clock: syntheticClock(500),
            evidence: {
              state: "present" as const,
              digest: fictionalDigest("evidence", `${slot.attemptId}-deny`),
            },
          },
        })),
        stream: syntheticObservation(),
        cancellationAck: syntheticObservation(),
        physicalTermination: syntheticObservation(),
        nativeTerminal: syntheticObservation(),
        tokens: [
          {
            tokenRef: `${slot.attemptId}-token`,
            issued: syntheticClock(),
            revocation: syntheticObservation(),
            expiry: syntheticObservation(),
          },
        ],
        measurements: [],
        observationsLimit: {
          providerEpisodeMs: 120_000,
          physicalEpisodeMs: 120_000,
          elapsed: true,
        },
        omissions: [],
      };
    }),
  };
}
export function syntheticInstaller(): InstallerJournalV1 {
  return {
    schemaVersion: "independent-installer-journal/v1",
    schemaDigest: SAMPLING_SCHEMA_DIGESTS_V1.installer,
    journalId: "fictional-installer-journal",
    runId: "synthetic-run",
    source: "synthetic",
    inputs: syntheticInputs(),
    leafId: "R1-outside-install",
    purpose: "cold-install",
    packageReferences: [fictionalDigest("input", "package")],
    installer: {
      actorRef: "fictional-installer",
      authorRefs: ["fictional-author"],
      independence: "declared-independent",
      declaration: { state: "present", digest: fictionalDigest("evidence", "declaration") },
      independenceEvidence: {
        state: "present",
        digest: fictionalDigest("evidence", "independence"),
      },
    },
    prerequisites: [
      {
        prerequisiteId: "fictional-prerequisite",
        description: "Fictional prerequisite; never executed",
        outcome: "pass",
        evidence: { state: "present", digest: fictionalDigest("evidence", "prerequisite") },
      },
    ],
    steps: [
      {
        stepId: "fictional-command",
        order: 1,
        instruction: {
          kind: "command",
          executable: "fictional-installer",
          arguments: ["--fixture-only"],
          directory: "fictional-directory",
        },
        inputs: [fictionalDigest("input", "step")],
      },
      {
        stepId: "fictional-manual",
        order: 2,
        instruction: {
          kind: "manual",
          instruction: "Fictional manual verification; no operator performs this fixture.",
        },
        inputs: [],
      },
    ],
    attempts: [
      {
        attemptId: "fictional-install-attempt",
        originalAttemptId: "fictional-install-attempt",
        supersedesAttemptId: null,
        outcome: "pass",
        execution: syntheticExecution("fictional-install-attempt"),
        steps: [
          {
            stepId: "fictional-command",
            actorRef: "fictional-installer",
            state: "completed",
            exitCode: 0,
            capture: { state: "present", digest: fictionalDigest("evidence", "command") },
          },
          {
            stepId: "fictional-manual",
            actorRef: "fictional-installer",
            state: "completed",
            exitCode: null,
            capture: { state: "present", digest: fictionalDigest("evidence", "manual") },
          },
        ],
      },
    ],
    interventions: [],
    resources: [
      {
        resourceRef: "fictional-resource",
        state: "cleaned",
        cleanupOwnerRef: "fictional-installer",
        evidence: { state: "present", digest: fictionalDigest("evidence", "cleanup") },
      },
    ],
    omissions: [],
  };
}
export function syntheticDeclaration(
  leafId: AcceptanceLeafIdV1,
  journalBytes: Uint8Array,
): JournalReceiptDeclarationV1 {
  const receipt = syntheticReceipt(encode(syntheticCompanion(leafId)));
  return {
    receiptId: receipt.receiptId,
    previousReceipt: receipt.previousReceipt,
    receivedAt: receipt.receivedAt,
    collection: receipt.collection,
    outcome: receipt.outcome,
    reasonCode: receipt.reasonCode,
    checks: receipt.checks.map((check) => ({
      ...check,
      evidence: digestAcceptanceBytesV1("evidence", journalBytes),
    })),
    observations: receipt.observations,
    review: receipt.review,
    custody: receipt.custody,
    invalidation: receipt.invalidation,
    reuse: receipt.reuse,
  };
}
export const companionBytes = (leafId: AcceptanceLeafIdV1) => encode(syntheticCompanion(leafId));
