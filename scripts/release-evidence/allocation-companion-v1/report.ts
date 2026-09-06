import {
  ACCEPTANCE_ALLOCATION_SHA256_V1,
  ACCEPTANCE_CLASSES_V1,
  ACCEPTANCE_DEMOS_V1,
  ACCEPTANCE_HANDOFFS_V1,
  ACCEPTANCE_LEAVES_V1,
  ACCEPTANCE_OUTCOMES_V1,
  ACCEPTANCE_REGISTRY_SHA256_V1,
  ACCEPTANCE_VECTORS_V1,
  type AcceptanceDigestV1,
  type AcceptanceOutcomeV1,
  type ProducerReceiptV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-v1";
import { ACCEPTANCE_SCHEMA_DIGESTS_V1 } from "@openclaw-enterprise/contracts/acceptance-companion-codec-v1";
import {
  ALLOCATION_READER_SCHEMA_DIGESTS_V1,
  ALLOCATION_RUN_LIMITS_V1,
  digestKeyV1,
  readAllocationRunV1,
  type AllocationRunInputV1,
  type ReadAllocationRunV1,
} from "./reader.ts";

type Outcome = AcceptanceOutcomeV1;
const outcomes = (): Record<Outcome, number> => ({
  pass: 0,
  fail: 0,
  blocked: 0,
  skipped: 0,
  unrun: 0,
  unknown: 0,
  not_applicable: 0,
});
const reduce = (values: readonly Outcome[]): Outcome => {
  for (const outcome of [
    "fail",
    "blocked",
    "unknown",
    "skipped",
    "unrun",
    "pass",
    "not_applicable",
  ] as const)
    if (values.includes(outcome)) return outcome;
  return "unrun";
};
const counts = (values: readonly Outcome[]) => {
  const result = outcomes();
  for (const value of values) result[value]++;
  return result;
};
const subjectKey = (subject: ProducerReceiptV1["checks"][number]["subject"]): string => {
  if (subject.kind === "leaf") return `leaf:${subject.leafId}`;
  if (subject.kind === "demo-substep") return `demo:${subject.demoCaseId}:${subject.substepId}`;
  return `vector:${subject.vectorId}:${subject.subcheckId}`;
};

/** Collect only exact typed references, never artifact contents or procedures. */
function referenced(
  value: unknown,
  result = new Map<string, AcceptanceDigestV1>(),
): Map<string, AcceptanceDigestV1> {
  if (value === null || typeof value !== "object") return result;
  if ("domain" in value && "sha256" in value && "byteLength" in value) {
    const digest = value as AcceptanceDigestV1;
    result.set(digestKeyV1(digest), digest);
  } else for (const child of Object.values(value)) referenced(child, result);
  return result;
}

export function reportAllocationRunV1(read: ReadAllocationRunV1) {
  const verified = new Set(read.artifacts.map(digestKeyV1));
  for (const companion of read.companions) verified.add(digestKeyV1(companion.identity));
  for (const receipt of read.receipts) verified.add(digestKeyV1(receipt.identity));
  const expectedArtifacts = referenced(read.selection);
  for (const companion of read.companions) referenced(companion.value, expectedArtifacts);
  for (const receipt of read.receipts) referenced(receipt.value, expectedArtifacts);
  for (const attempt of read.attempts) referenced(attempt.value, expectedArtifacts);
  const artifacts = [...expectedArtifacts].map(([key, identity]) => ({
    identity,
    integrity: verified.has(key) ? "verified-bytes" : "unavailable",
  }));
  const has = (digest: AcceptanceDigestV1) => verified.has(digestKeyV1(digest));
  const receiptRows = read.receipts.map(({ identity, value }) => {
    const reasons: string[] = [];
    if (value.collection !== "received") reasons.push(`collection-${value.collection}`);
    if (value.outcome === null) reasons.push("outcome-missing");
    if (value.procedure.state === "missing") reasons.push("procedure-missing");
    if (value.result.state === "missing") reasons.push("result-missing");
    if (value.custody.redaction !== "complete")
      reasons.push(`redaction-${value.custody.redaction}`);
    if (value.invalidation.state === "invalidated") reasons.push("invalidated");
    if (value.review.state === "missing") reasons.push("review-missing");
    else if (value.review.disposition !== "accepted")
      reasons.push(`review-${value.review.disposition}`);
    if (value.execution.state === "unrun") reasons.push("execution-unrun");
    else {
      if (value.execution.executionClass !== "live") reasons.push("execution-not-live");
      if (value.execution.state === "end-unavailable") reasons.push("execution-end-unavailable");
      if (value.execution.capture.state === "missing") reasons.push("capture-missing");
      if (!read.receiptAttempts.has(value.receiptId)) reasons.push("attempt-missing");
    }
    const absent = [...referenced(value).values()].filter((digest) => !has(digest));
    if (absent.length) reasons.push("referenced-bytes-unavailable");
    if (value.outcome === "pass" && value.leafId === "R9-physical-stop") {
      const physical = value.observations.filter(
        (observation) => observation.axis === "physical-termination",
      );
      if (
        physical.length === 0 ||
        physical.some((observation) => observation.state !== "confirmed")
      )
        reasons.push("positive-physical-termination-unavailable");
    }
    if (value.outcome === "pass" && value.leafId === "R7-confirmed-revoke") {
      const tokens = value.observations.filter(
        (observation) => observation.axis === "token-disposition",
      );
      const subjects = new Set(tokens.map((observation) => observation.subjectRef));
      if (
        subjects.size === 0 ||
        tokens.some(
          (observation) => observation.state === "unknown" || observation.state === "unobserved",
        ) ||
        [...subjects].some(
          (subject) =>
            !["confirmed", "denied"].every((state) =>
              tokens.some(
                (observation) => observation.subjectRef === subject && observation.state === state,
              ),
            ),
        )
      )
        reasons.push("positive-token-confirmation-and-denial-unavailable");
    }
    const issues = [...read.structuralIssues, ...read.completenessIssues].filter(
      (issue) => issue.subject === value.receiptId,
    );
    reasons.push(...issues.map((issue) => issue.code));
    return {
      identity,
      declaration: value,
      attemptId: read.receiptAttempts.get(value.receiptId) ?? null,
      evidenceUsability: reasons.length === 0 ? "declared-prerequisites-present" : "unusable",
      reasons: [...new Set(reasons)],
      missingArtifacts: absent,
    };
  });
  const leaves = Object.entries(ACCEPTANCE_LEAVES_V1).map(([id, leaf]) => {
    const companion = read.companions.find(({ value }) => value.leaf.id === id);
    const primary = receiptRows.filter(
      ({ declaration }) => declaration.leafId === id && declaration.role === "primary",
    );
    const supporting = receiptRows.filter(
      ({ declaration }) => declaration.leafId === id && declaration.role === "supporting",
    );
    const expectedChecks = [`leaf:${id}`];
    if (companion) {
      for (const demo of companion.value.demonstrations)
        for (const step of demo.substeps)
          expectedChecks.push(`demo:${demo.demoCaseId}:${step.substepId}`);
      for (const vector of companion.value.vectors)
        for (const check of vector.subchecks)
          expectedChecks.push(`vector:${vector.vectorId}:${check.subcheckId}`);
    }
    const checks = expectedChecks.map((key) => ({
      key,
      receipts: primary.flatMap(({ declaration }) =>
        declaration.checks
          .filter((check) => subjectKey(check.subject) === key)
          .map((check) => ({
            receiptId: declaration.receiptId,
            outcome: check.outcome,
            evidence: check.evidence,
          })),
      ),
    }));
    const declared = primary.map(({ declaration }) => declaration.outcome ?? "unrun");
    const live = primary
      .filter(
        ({ declaration }) =>
          declaration.execution.state === "unrun" ||
          declaration.execution.executionClass === "live",
      )
      .map(({ declaration }) => declaration.outcome ?? "unrun");
    const liveChecks = primary
      .filter(
        ({ declaration }) =>
          declaration.execution.state !== "unrun" &&
          declaration.execution.executionClass === "live",
      )
      .flatMap(({ declaration }) =>
        declaration.checks.map((check) => ({
          receiptId: declaration.receiptId,
          key: subjectKey(check.subject),
          outcome: check.outcome,
        })),
      );
    const reasons = [...read.structuralIssues, ...read.completenessIssues]
      .filter((issue) => issue.subject === id)
      .map((issue) => issue.code);
    for (const check of checks)
      if (check.receipts.length === 0) reasons.push(`check-missing:${check.key}`);
    for (const receipt of primary)
      reasons.push(
        ...receipt.reasons.map((reason) => `${receipt.declaration.receiptId}:${reason}`),
      );
    for (const check of liveChecks)
      if (check.outcome !== "pass")
        reasons.push(`${check.receiptId}:check-${check.outcome}:${check.key}`);
    const plan = read.selection?.plans.find((candidate) => candidate.leafId === id);
    if (plan?.procedureReview === null || plan === undefined)
      reasons.push("procedure-review-missing");
    else if (!has(plan.procedureReview)) reasons.push("procedure-review-bytes-unavailable");
    const declarationOutcome = reduce(declared);
    const liveOutcome = reduce(live);
    const checkOutcome = reduce([...live, ...liveChecks.map((check) => check.outcome)]);
    let diagnosticOutcome: Outcome = checkOutcome;
    if (read.structuralIssues.length || (checkOutcome === "pass" && reasons.length > 0))
      diagnosticOutcome = "blocked";
    if (!companion || primary.length === 0) {
      const launched = receiptRows.some(
        ({ declaration }) =>
          declaration.leafId === id &&
          declaration.execution.state !== "unrun" &&
          declaration.execution.executionClass === "live",
      );
      if (launched) diagnosticOutcome = checkOutcome === "unknown" ? "unknown" : "blocked";
      else diagnosticOutcome = "unrun";
    }
    if (checkOutcome === "fail") diagnosticOutcome = "fail";
    const inventoryComplete =
      Boolean(companion) &&
      primary.length > 0 &&
      checks.every((check) => check.receipts.length > 0);
    return {
      id,
      ...leaf,
      companionIdentity: companion?.identity ?? null,
      procedure: plan?.procedure ?? null,
      procedureReview: plan?.procedureReview ?? null,
      demonstrations: companion?.value.demonstrations ?? null,
      vectors: companion?.value.vectors ?? null,
      primaryReceiptIds: primary.map(({ declaration }) => declaration.receiptId),
      supportingReceiptIds: supporting.map(({ declaration }) => declaration.receiptId),
      checks,
      inventoryComplete,
      declaredOutcome: declarationOutcome,
      declaredOutcomeCounts: counts(declared),
      liveOutcome,
      liveOutcomeCounts: counts(live),
      liveSubcheckOutcomeCounts: counts(liveChecks.map((check) => check.outcome)),
      diagnosticOutcome,
      reasons: [...new Set(reasons)],
    };
  });
  const parents = [
    ...new Set(leaves.map((leaf) => `${leaf.parentCaseId}/${leaf.parentAssertionId}`)),
  ].map((key) => {
    const children = leaves.filter(
      (leaf) => `${leaf.parentCaseId}/${leaf.parentAssertionId}` === key,
    );
    return {
      caseId: children[0]!.parentCaseId,
      assertionId: children[0]!.parentAssertionId,
      leafIds: children.map((leaf) => leaf.id),
      requiredLeafIds: children.filter((leaf) => leaf.required).map((leaf) => leaf.id),
    };
  });
  const gates = [...new Set(leaves.map((leaf) => leaf.requirement))].map((id) => {
    const dependentVectors = Object.entries(ACCEPTANCE_VECTORS_V1).filter(([, vector]) =>
      (vector.requiredByGates as readonly string[]).includes(id),
    );
    const vectorLeaves = new Set<string>(
      dependentVectors.flatMap(([, vector]) => [...vector.assertionIds]),
    );
    const children = leaves.filter(
      (leaf) => leaf.required && (leaf.requirement === id || vectorLeaves.has(leaf.id)),
    );
    const reduced = reduce(children.map((leaf) => leaf.diagnosticOutcome));
    return {
      id,
      requiredLeafIds: children.map((leaf) => leaf.id),
      requiredVectorIds: dependentVectors.map(([key]) => key),
      outcome: reduced === "blocked" || reduced === "unknown" ? "blocked-or-unknown" : reduced,
      outcomeCounts: counts(children.map((leaf) => leaf.diagnosticOutcome)),
      reasons: children
        .filter((leaf) => leaf.diagnosticOutcome !== "pass")
        .map((leaf) => ({
          leafId: leaf.id,
          outcome: leaf.diagnosticOutcome,
          reasons: leaf.reasons,
        })),
    };
  });
  const demonstrations = Object.entries(ACCEPTANCE_DEMOS_V1).map(([id, demo]) => ({
    id,
    ...demo,
    applicabilityRecords: read.companions.map(({ value }) => ({
      leafId: value.leaf.id,
      record: value.demoApplicability.find((row) => row.demoCaseId === id)!,
    })),
    suppliedPlans: leaves.flatMap((leaf) =>
      (leaf.demonstrations ?? [])
        .filter((row) => row.demoCaseId === id)
        .map((plan) => ({ leafId: leaf.id, plan })),
    ),
    originalProcedureFidelity: "unverified",
  }));
  const vectors = Object.entries(ACCEPTANCE_VECTORS_V1).map(([id, vector]) => ({
    id,
    ...vector,
    suppliedPlans: leaves.flatMap((leaf) =>
      (leaf.vectors ?? [])
        .filter((row) => row.vectorId === id)
        .map((plan) => ({ leafId: leaf.id, plan })),
    ),
  }));
  const required = leaves.filter((leaf) => leaf.required);
  const optional = leaves.filter((leaf) => !leaf.required);
  const evidenceReferenceUses = new Map<string, number>();
  for (const { value } of read.receipts) {
    for (const digest of [
      ...value.checks.map((check) => check.evidence),
      ...value.observations.map((observation) => observation.evidence),
    ]) {
      if (digest !== null) {
        const key = digestKeyV1(digest);
        evidenceReferenceUses.set(key, (evidenceReferenceUses.get(key) ?? 0) + 1);
      }
    }
  }
  const sourceClasses = Object.fromEntries(
    ACCEPTANCE_CLASSES_V1.map((executionClass) => [
      executionClass,
      counts(
        read.receipts
          .filter(
            ({ value }) =>
              value.execution.state !== "unrun" &&
              value.execution.executionClass === executionClass,
          )
          .flatMap(({ value }) => (value.outcome === null ? [] : [value.outcome])),
      ),
    ]),
  );
  return {
    schemaVersion: "allocation-completeness-report/v1",
    authentication: "unverified",
    authenticAcceptance: "not-established",
    outsideActivity: "unknown",
    originalProcedureFidelity: "unverified",
    identity: {
      registrySha256: ACCEPTANCE_REGISTRY_SHA256_V1,
      allocationSha256: ACCEPTANCE_ALLOCATION_SHA256_V1,
      companionSchemas: ACCEPTANCE_SCHEMA_DIGESTS_V1,
      readerSchemas: ALLOCATION_READER_SCHEMA_DIGESTS_V1,
      selection: read.selectionIdentity,
    },
    selected: read.selection,
    structuralValidity: read.structuralIssues.length === 0 ? "valid" : "invalid",
    inventoryCompleteness:
      read.selection !== null &&
      read.structuralIssues.length === 0 &&
      read.completenessIssues.length === 0 &&
      leaves.every((leaf) => leaf.inventoryComplete)
        ? "complete"
        : "incomplete",
    structuralIssues: read.structuralIssues,
    completenessIssues: read.completenessIssues,
    counts: {
      expectedLeaves: leaves.length,
      requiredLeaves: required.length,
      optionalLeaves: optional.length,
      parentAssertionPairs: parents.length,
      registryCases: new Set(parents.map((parent) => parent.caseId)).size,
      gates: gates.length,
      demonstrations: demonstrations.length,
      vectors: vectors.length,
      handoffs: Object.keys(ACCEPTANCE_HANDOFFS_V1).length,
      supplied: read.supplied,
      decodedReceipts: read.receipts.length,
      declaredAttempts: read.attempts.length,
      receiptsReusingObservations: read.receipts.filter(({ value }) => value.reuse !== null).length,
      uniqueEvidenceReferences: evidenceReferenceUses.size,
      repeatedEvidenceReferences: [...evidenceReferenceUses.values()].reduce(
        (sum, count) => sum + count - 1,
        0,
      ),
      missingCollection: read.receipts.filter(({ value }) => value.collection === "missing").length,
      rejectedCollection: read.receipts.filter(({ value }) => value.collection === "rejected")
        .length,
      nullOutcomes: read.receipts.filter(({ value }) => value.outcome === null).length,
      receiptOutcomes: counts(
        read.receipts.flatMap(({ value }) => (value.outcome === null ? [] : [value.outcome])),
      ),
      requiredDeclaredOutcomes: counts(required.map((leaf) => leaf.declaredOutcome)),
      optionalDeclaredOutcomes: counts(optional.map((leaf) => leaf.declaredOutcome)),
      requiredLiveOutcomes: counts(required.map((leaf) => leaf.liveOutcome)),
      optionalLiveOutcomes: counts(optional.map((leaf) => leaf.liveOutcome)),
      sourceClasses,
      channels: Object.fromEntries(
        ["slack", "teams", "none"].map((channel) => [
          channel,
          {
            required: required.filter((leaf) => leaf.channel === channel).length,
            liveOutcomes: counts(
              required.filter((leaf) => leaf.channel === channel).map((leaf) => leaf.liveOutcome),
            ),
          },
        ]),
      ),
    },
    leaves,
    parents,
    gates,
    demonstrations,
    vectors,
    handoffs: Object.entries(ACCEPTANCE_HANDOFFS_V1).map(([id, meaning]) => ({
      id,
      meaning,
      identity: read.selection?.handoffs[id as keyof typeof ACCEPTANCE_HANDOFFS_V1] ?? null,
    })),
    receipts: receiptRows,
    attempts: read.attempts,
    artifacts,
    suppliedArtifactIdentities: read.artifacts,
    outcomeVocabulary: ACCEPTANCE_OUTCOMES_V1,
  };
}
export type AllocationReportV1 = ReturnType<typeof reportAllocationRunV1>;
export const buildAllocationReportV1 = (input: AllocationRunInputV1): AllocationReportV1 =>
  reportAllocationRunV1(readAllocationRunV1(input));

/** Refuse output overflow before retaining additional serialized chunks. No detail is dropped. */
export function encodeAllocationReportV1(
  report: AllocationReportV1,
  limit = ALLOCATION_RUN_LIMITS_V1.maxOutputBytes,
): Uint8Array {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ALLOCATION_RUN_LIMITS_V1.maxOutputBytes)
    throw new Error("invalid-output-limit");
  const chunks: string[] = [];
  let length = 0;
  const append = (chunk: string) => {
    const bytes = Buffer.byteLength(chunk);
    if (bytes > limit - length) throw new Error("output-limit");
    length += bytes;
    chunks.push(chunk);
  };
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") {
      append(JSON.stringify(value) ?? "null");
      return;
    }
    const array = Array.isArray(value);
    append(array ? "[" : "{");
    let first = true;
    for (const [key, child] of Object.entries(value)) {
      if (!first) append(",");
      first = false;
      if (!array) {
        append(JSON.stringify(key));
        append(":");
      }
      visit(child);
    }
    append(array ? "]" : "}");
  };
  visit(report);
  append("\n");
  return new TextEncoder().encode(chunks.join(""));
}
