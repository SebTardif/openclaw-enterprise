import {
  ACCEPTANCE_ALLOCATION_SHA256_V1,
  ACCEPTANCE_ALLOCATION_VERSION_V1,
  ACCEPTANCE_DEMOS_V1,
  ACCEPTANCE_HANDOFFS_V1,
  ACCEPTANCE_LEAVES_V1,
  ACCEPTANCE_REGISTRY_SHA256_V1,
  ACCEPTANCE_REGISTRY_VERSION_V1,
  ACCEPTANCE_VECTORS_V1,
  type AcceptanceDigestDomainV1,
  type AcceptanceLeafIdV1,
  type AssertionCompanionV1,
  type ProducerReceiptV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-v1";
import {
  ACCEPTANCE_SCHEMA_DIGESTS_V1,
  decodeAssertionCompanionV1,
  digestAcceptanceBytesV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-codec-v1";

/** Synthetic metadata only. No procedure, native fixture or live result is executed. */
export const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));
const digest = <D extends AcceptanceDigestDomainV1>(domain: D, label = domain as string) =>
  digestAcceptanceBytesV1(domain, encode({ synthetic: label }));
export function syntheticCompanion(
  leafId: AcceptanceLeafIdV1 = "R1-outside-install",
): AssertionCompanionV1 {
  const leaf = ACCEPTANCE_LEAVES_V1[leafId];
  return {
    schemaVersion: "assertion-companion/v1",
    schemaDigest: ACCEPTANCE_SCHEMA_DIGESTS_V1.companion,
    companionId: "synthetic-companion",
    runId: "synthetic-run",
    registry: { version: ACCEPTANCE_REGISTRY_VERSION_V1, sha256: ACCEPTANCE_REGISTRY_SHA256_V1 },
    allocation: {
      version: ACCEPTANCE_ALLOCATION_VERSION_V1,
      sha256: ACCEPTANCE_ALLOCATION_SHA256_V1,
      leafCount: 324,
    },
    leaf: {
      id: leafId,
      parentCaseId: leaf.parentCaseId,
      parentAssertionId: leaf.parentAssertionId,
      primaryProducer: leaf.producer,
      channel: leaf.channel,
      required: leaf.required,
      requiredExecutionClass: "live",
    },
    inputManifest: digest("input"),
    demonstrationInputs: [
      digest("demonstration", "input-1"),
      digest("demonstration", "input-2"),
      digest("demonstration", "input-3"),
      digest("demonstration", "input-4"),
    ],
    limits: digest("limits"),
    tuple: digest("tuple"),
    procedure: digest("procedure"),
    handoffs: Object.fromEntries(
      Object.keys(ACCEPTANCE_HANDOFFS_V1).map((id) => [id, digest("handoff", id)]),
    ) as AssertionCompanionV1["handoffs"],
    demoApplicability: Object.entries(ACCEPTANCE_DEMOS_V1).map(([demoCaseId, demo]) => ({
      demoCaseId: demoCaseId as keyof typeof ACCEPTANCE_DEMOS_V1,
      applicability: demo.applicability,
      review: demo.applicability === "not_applicable" ? digest("review", "applicability") : null,
    })),
    demonstrations: leaf.demoCaseIds.map((demoCaseId) => ({
      demoCaseId,
      applicability: ACCEPTANCE_DEMOS_V1[demoCaseId].applicability,
      applicabilityEvidence: null,
      substeps: [
        { substepId: "synthetic-step", order: 1, expectation: digest("expectation", demoCaseId) },
      ],
    })),
    vectors: Object.entries(ACCEPTANCE_VECTORS_V1)
      .filter(([, vector]) => (vector.assertionIds as readonly string[]).includes(leafId))
      .map(([vectorId, vector]) => ({
        vectorId: vectorId as keyof typeof ACCEPTANCE_VECTORS_V1,
        contract: vector.contract,
        requiredByGates: [...vector.requiredByGates],
        subchecks: (["stimulus", "requiredResult", "sourceProofLane"] as const).map((slot) => ({
          subcheckId: slot,
          slot,
          expectation: digest("expectation", `${vectorId}-${slot}`),
        })),
      })),
  };
}

export function syntheticReceipt(companionBytes: Uint8Array): ProducerReceiptV1 {
  const decoded = decodeAssertionCompanionV1(companionBytes);
  if (!decoded.ok) throw new Error(decoded.code);
  const companion = decoded.value;
  const clock = {
    clockRef: "synthetic-clock",
    observedAt: "2026-01-01T00:00:00.000Z",
    uncertaintyMs: 0,
  };
  const evidence = digest("evidence");
  return {
    schemaVersion: "producer-receipt/v1",
    schemaDigest: ACCEPTANCE_SCHEMA_DIGESTS_V1.receipt,
    receiptId: "synthetic-receipt",
    runId: companion.runId,
    leafId: companion.leaf.id,
    companion: decoded.identity,
    inputManifest: companion.inputManifest,
    procedure: { state: "frozen", digest: companion.procedure },
    producer: companion.leaf.primaryProducer,
    role: "primary",
    previousReceipt: null,
    receivedAt: "2026-01-01T00:00:01.000Z",
    collection: "received",
    outcome: "pass",
    reasonCode: "synthetic-declaration",
    result: { state: "present", digest: digest("result") },
    execution: {
      state: "observed",
      executionClass: "unit",
      executorRef: "synthetic-executor",
      tool: digest("tool"),
      started: clock,
      ended: clock,
      monotonicClockRef: "synthetic-monotonic",
      monotonicDurationMs: 0,
      capture: { state: "missing" },
    },
    checks: [
      { subject: { kind: "leaf", leafId: companion.leaf.id }, outcome: "pass", evidence },
      ...companion.demonstrations.flatMap((demo) =>
        demo.substeps.map((step) => ({
          subject: {
            kind: "demo-substep" as const,
            demoCaseId: demo.demoCaseId,
            substepId: step.substepId,
          },
          outcome: "pass" as const,
          evidence,
        })),
      ),
      ...companion.vectors.flatMap((vector) =>
        vector.subchecks.map((check) => ({
          subject: {
            kind: "vector-subcheck" as const,
            vectorId: vector.vectorId,
            subcheckId: check.subcheckId,
          },
          outcome: "pass" as const,
          evidence,
        })),
      ),
    ],
    observations: [
      {
        axis: "physical-termination",
        subjectRef: "synthetic-effect",
        state: "unknown",
        clock,
        evidence: null,
      },
    ],
    review: { state: "missing" },
    custody: {
      holderRef: "synthetic-custodian",
      accessPolicy: digest("policy", "access"),
      retentionPolicy: digest("policy", "retention"),
      retainedUntil: "2026-01-02T00:00:00.000Z",
      redaction: "unknown",
      redactionEvidence: null,
    },
    invalidation: { state: "current" },
    reuse: null,
  };
}
