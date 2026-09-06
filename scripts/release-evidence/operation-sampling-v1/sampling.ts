import {
  ACCEPTANCE_LEAVES_V1,
  type ProducerReceiptV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-v1";
import {
  ACCEPTANCE_SCHEMA_DIGESTS_V1,
  bindProducerReceiptV1,
  decodeAssertionCompanionV1,
  decodeProducerReceiptV1,
  digestAcceptanceBytesV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-codec-v1";
import {
  OperationSamplingPlanSchemaV1,
  OperationSampleJournalSchemaV1,
  SAMPLING_SCHEMA_DIGESTS_V1,
  decodeSamplingRecordV1,
  encodeSamplingV1,
  failSamplingV1,
  sameDigestV1,
  sameInputsV1,
  sameSamplingClockV1,
  uniqueSamplingV1,
  type SampleAttemptV1,
  type SampleJournalV1,
  type SamplingExecutionV1,
  type SamplingInputsV1,
  type SamplingPlanV1,
  type SamplingResultV1,
} from "./schema.ts";
import { describeDurationsV1, measureDurationV1, type DurationRowV1 } from "./statistics.ts";

const minimum = {
  "runtime-operation": 3,
  "native-story": 10,
  "timed-condition": 10,
  negative: 1,
} as const;
const scopeKey = (row: SamplingPlanV1["requirements"][number] | SampleAttemptV1) =>
  JSON.stringify([
    row.operationId,
    row.conditionId,
    row.variantId,
    row.variantKind,
    row.channel,
    row.purpose,
    row.leafId,
  ]);

export function decodeSamplingPlanV1(bytes: unknown): SamplingResultV1<SamplingPlanV1> {
  const decoded = decodeSamplingRecordV1<SamplingPlanV1>(
    bytes,
    OperationSamplingPlanSchemaV1,
    SAMPLING_SCHEMA_DIGESTS_V1.plan,
  );
  if (!decoded.ok) return decoded;
  const plan = decoded.value;
  if (
    !uniqueSamplingV1(plan.requirements.map((row) => row.requirementId)) ||
    !uniqueSamplingV1(plan.requirements.map((row) => `${row.kind}:${scopeKey(row)}`)) ||
    !uniqueSamplingV1(plan.expected.map((row) => row.sampleId)) ||
    !uniqueSamplingV1(plan.expected.map((row) => row.attemptId)) ||
    !uniqueSamplingV1(plan.expected.map((row) => row.seed.sha256))
  )
    return failSamplingV1("duplicate-plan-identity");
  const requirements = new Map(plan.requirements.map((row) => [row.requirementId, row]));
  for (const row of plan.requirements) {
    const leaf = ACCEPTANCE_LEAVES_V1[row.leafId];
    if (leaf.producer !== "P-OPS") return failSamplingV1("plan-leaf-mismatch");
    if (row.requiredCount < minimum[row.kind]) return failSamplingV1("p6-denominator-too-small");
    if (
      (row.kind === "runtime-operation" && row.purpose === "none") ||
      (row.kind === "native-story" && row.channel === "none") ||
      (row.kind === "timed-condition" && row.conditionId === null)
    )
      return failSamplingV1("invalid-requirement-scope");
    if (
      !uniqueSamplingV1(row.measurements.map((metric) => metric.metricId)) ||
      !uniqueSamplingV1(row.denialBoundaryIds)
    )
      return failSamplingV1("duplicate-measurement-identity");
    if (
      row.kind === "timed-condition" &&
      row.measurements.length === 0 &&
      row.denialBoundaryIds.length === 0
    )
      return failSamplingV1("missing-timed-measurement-plan");
    if (
      plan.expected.filter((slot) => slot.requirementId === row.requirementId).length <
      row.requiredCount
    )
      return failSamplingV1("missing-expected-samples");
  }
  for (const slot of plan.expected) {
    const row = requirements.get(slot.requirementId);
    if (!row || (row.kind === "native-story") !== (slot.storyId !== null))
      return failSamplingV1("unknown-or-invalid-slot");
  }
  const storyIds = plan.expected.flatMap((slot) => (slot.storyId === null ? [] : [slot.storyId]));
  if (!uniqueSamplingV1(storyIds)) return failSamplingV1("reused-story-identity");
  if (
    !["runtime-operation", "timed-condition", "negative"].every((kind) =>
      plan.requirements.some((row) => row.kind === kind),
    ) ||
    !["slack", "teams"].every((native) =>
      plan.requirements.some((row) => row.kind === "native-story" && row.channel === native),
    )
  )
    return failSamplingV1("missing-p6-category");
  if (plan.source === "live" && plan.inputs.procedureReview.state === "missing")
    return failSamplingV1("missing-procedure-review");
  return decoded;
}

export function executionIssueV1(
  execution: SamplingExecutionV1,
  outcome: string,
  source: "synthetic" | "live",
): string | null {
  if (execution.state === "not-launched" && !["unrun", "skipped", "blocked"].includes(outcome))
    return "no-launch-outcome-mismatch";
  if (execution.state === "launch-unknown" && !["unknown", "blocked"].includes(outcome))
    return "unknown-launch-outcome-mismatch";
  if (execution.state !== "launched") return null;
  if (source === "synthetic" && execution.executionClass === "live")
    return "synthetic-live-class-mismatch";
  if (source === "live" && execution.executionClass !== "live") return "live-class-mismatch";
  if (["skipped", "unrun"].includes(outcome)) return "launched-unrun-mismatch";
  if (execution.ended.state === "missing" && !["unknown", "blocked"].includes(outcome))
    return "unavailable-end-outcome-mismatch";
  return null;
}
export function decodeSampleJournalV1(bytes: unknown): SamplingResultV1<SampleJournalV1> {
  const decoded = decodeSamplingRecordV1<SampleJournalV1>(
    bytes,
    OperationSampleJournalSchemaV1,
    SAMPLING_SCHEMA_DIGESTS_V1.sample,
  );
  if (!decoded.ok) return decoded;
  const journal = decoded.value;
  if (!uniqueSamplingV1(journal.attempts.map((row) => row.attemptId)))
    return failSamplingV1("duplicate-attempt-identity");
  const seen = new Map<string, SampleAttemptV1>();
  for (const row of journal.attempts) {
    const leaf = ACCEPTANCE_LEAVES_V1[row.leafId];
    if (
      leaf.producer !== "P-OPS" ||
      leaf.parentCaseId !== row.parentCaseId ||
      leaf.parentAssertionId !== row.parentAssertionId
    )
      return failSamplingV1("sample-leaf-mismatch");
    const issue = executionIssueV1(row.execution, row.outcome, journal.source);
    if (issue) return failSamplingV1(issue);
    if (row.accepted && (row.outcome !== "pass" || row.collection !== "received"))
      return failSamplingV1("accepted-outcome-mismatch");
    if (
      !uniqueSamplingV1(row.turns.map((turn) => turn.turnId)) ||
      !uniqueSamplingV1(row.boundaries.map((boundary) => boundary.boundaryId)) ||
      !uniqueSamplingV1(row.tokens.map((token) => token.tokenRef)) ||
      !uniqueSamplingV1(row.measurements.map((metric) => metric.metricId))
    )
      return failSamplingV1("duplicate-observation-identity");
    if (row.kind === "fresh") {
      if (row.originalAttemptId !== row.attemptId || row.supersedesAttemptId !== null)
        return failSamplingV1("invalid-original-attempt");
    } else {
      const original = seen.get(row.originalAttemptId);
      const previous =
        row.supersedesAttemptId === null ? original : seen.get(row.supersedesAttemptId);
      if (
        !original ||
        !previous ||
        original.kind !== "fresh" ||
        original.sampleId !== row.sampleId ||
        previous.sampleId !== row.sampleId ||
        original.requirementId !== row.requirementId ||
        previous.originalAttemptId !== row.originalAttemptId ||
        scopeKey(original) !== scopeKey(row) ||
        !sameDigestV1(original.seed, row.seed) ||
        original.storyId !== row.storyId
      )
        return failSamplingV1("invalid-attempt-history");
    }
    seen.set(row.attemptId, row);
  }
  return decoded;
}
const hasAttempt = (row: SampleAttemptV1) => row.execution.state === "launched";
const hasObservation = (row: SampleAttemptV1) =>
  row.captureReferences.length > 0 && row.collection !== "missing";
function freshQualifies(row: SampleAttemptV1): boolean {
  return (
    row.kind === "fresh" &&
    row.accepted &&
    hasAttempt(row) &&
    row.execution.state === "launched" &&
    row.execution.ended.state === "available" &&
    row.execution.started.state === "available" &&
    usableExecutionV1(row.execution) &&
    hasObservation(row) &&
    row.freshnessEvidence.state === "present" &&
    row.omissions.length === 0
  );
}
export function usableExecutionV1(execution: SamplingExecutionV1): boolean {
  if (
    execution.state !== "launched" ||
    execution.executorRef === null ||
    execution.tool.state === "missing" ||
    execution.capture.state === "missing" ||
    execution.started.state === "missing" ||
    execution.ended.state === "missing" ||
    execution.interval.state === "missing"
  )
    return false;
  if (
    execution.started.clockRef === execution.ended.clockRef &&
    Date.parse(execution.ended.observedAt) + execution.ended.uncertaintyMs <
      Date.parse(execution.started.observedAt) - execution.started.uncertaintyMs
  )
    return false;
  const interval = measureDurationV1(execution.started, execution.ended);
  if (interval.state === "unavailable") return false;
  if (
    interval.method === "monotonic" &&
    (execution.interval.clockRef !== interval.clockDomain ||
      execution.interval.durationMs !== interval.milliseconds)
  )
    return false;
  return true;
}
function storyQualifies(row: SampleAttemptV1): boolean {
  if (!freshQualifies(row)) return false;
  const a = row.turns.find(
    (turn) =>
      turn.participant === "A" && turn.outcome === "pass" && turn.evidence.state === "present",
  );
  const b = row.turns.find(
    (turn) =>
      turn.participant === "B" && turn.outcome === "pass" && turn.evidence.state === "present",
  );
  return (
    a !== undefined &&
    b !== undefined &&
    a.actorRef !== b.actorRef &&
    row.turns.indexOf(a) < row.turns.indexOf(b)
  );
}

export function evaluateSamplingV1(planBytes: unknown, journalBytes: unknown) {
  const planResult = decodeSamplingPlanV1(planBytes);
  if (!planResult.ok) return planResult;
  const journalResult = decodeSampleJournalV1(journalBytes);
  if (!journalResult.ok) return journalResult;
  const plan = planResult.value;
  const journal = journalResult.value;
  if (
    journal.runId !== plan.runId ||
    journal.source !== plan.source ||
    !sameInputsV1(journal.inputs, plan.inputs) ||
    !sameDigestV1(journal.plan, digestAcceptanceBytesV1("input", planResult.originalBytes()))
  )
    return failSamplingV1("journal-plan-mismatch");
  const requirements = new Map(plan.requirements.map((row) => [row.requirementId, row]));
  const slots = new Map(plan.expected.map((row) => [row.sampleId, row]));
  const fresh = new Set<string>();
  const allTurnIds = new Set<string>();
  const durations: DurationRowV1[] = [];
  for (const row of journal.attempts) {
    const requirement = requirements.get(row.requirementId);
    const slot = slots.get(row.sampleId);
    if (
      !requirement ||
      !slot ||
      slot.requirementId !== row.requirementId ||
      scopeKey(requirement) !== scopeKey(row) ||
      slot.storyId !== row.storyId ||
      !sameDigestV1(slot.seed, row.seed)
    )
      return failSamplingV1("unexpected-attempt-scope");
    if (row.kind === "fresh") {
      if (slot.attemptId !== row.attemptId || fresh.has(row.sampleId))
        return failSamplingV1("duplicate-or-unexpected-fresh-attempt");
      fresh.add(row.sampleId);
    }
    for (const turn of row.turns) {
      if (allTurnIds.has(turn.turnId)) return failSamplingV1("reused-turn-identity");
      allTurnIds.add(turn.turnId);
    }
    if (
      row.boundaries.some(
        (boundary) => !requirement.denialBoundaryIds.includes(boundary.boundaryId),
      ) ||
      row.measurements.some(
        (measurement) =>
          !requirement.measurements.some((expected) => expected.metricId === measurement.metricId),
      )
    )
      return failSamplingV1("unexpected-measurement");
    for (const metric of requirement.measurements) {
      if (durations.length >= 16_384) return failSamplingV1("duration-inventory-overflow");
      const observed = row.measurements.find((item) => item.metricId === metric.metricId);
      const duration =
        !observed || observed.evidence.state === "missing"
          ? { state: "unavailable" as const, reason: "missing-measurement-capture" }
          : measureDurationV1(observed.started, observed.ended);
      durations.push({
        attemptId: row.attemptId,
        requirementId: row.requirementId,
        operationId: row.operationId,
        conditionId: row.conditionId,
        variantId: row.variantId,
        channel: row.channel,
        purpose: row.purpose,
        boundaryId: observed?.subjectRef ?? "missing-subject",
        metric: metric.metricId,
        duration,
        eligibility: { state: "eligible" },
        hardBoundMs: metric.meaning === "hard-bound" ? metric.maximumMs : null,
      });
    }
    for (const boundaryId of requirement.denialBoundaryIds) {
      const boundary = row.boundaries.find((item) => item.boundaryId === boundaryId) ?? {
        boundaryId,
        firstDeny: { state: "missing" as const },
        denial: {
          state: "unobserved" as const,
          clock: { state: "missing" as const },
          evidence: { state: "missing" as const },
        },
      };
      // All attempted boundaries survive, including failed commits and unavailable clocks.
      const metrics = [
        ["request-to-denial", row.clocks.requestReceived, boundary.firstDeny],
        ["acceptance-to-denial", row.clocks.authenticatedAcceptance, boundary.firstDeny],
        ["commit-to-denial", row.clocks.durableCommit, boundary.firstDeny],
        ["commit-latency", row.clocks.authenticatedAcceptance, row.clocks.durableCommit],
      ] as const;
      for (const [metric, start, end] of metrics) {
        if (durations.length >= 16_384) return failSamplingV1("duration-inventory-overflow");
        const clockDuration = measureDurationV1(start, end);
        const capturedDenial =
          boundary.denial.state === "denied" &&
          boundary.denial.evidence.state === "present" &&
          boundary.denial.clock.state === "available" &&
          sameSamplingClockV1(boundary.denial.clock, boundary.firstDeny);
        const duration =
          !capturedDenial && metric !== "commit-latency"
            ? { state: "unavailable" as const, reason: "denial-unconfirmed-or-capture-mismatch" }
            : clockDuration;
        durations.push({
          attemptId: row.attemptId,
          requirementId: row.requirementId,
          operationId: row.operationId,
          conditionId: row.conditionId,
          variantId: row.variantId,
          channel: row.channel,
          purpose: row.purpose,
          boundaryId: boundary.boundaryId,
          metric,
          duration,
          eligibility:
            row.commitState === "confirmed"
              ? { state: "eligible" }
              : { state: "omitted", reason: `commit-${row.commitState}` },
          hardBoundMs:
            metric === "acceptance-to-denial" ? plan.selection.localDenialTargetMs : null,
        });
      }
    }
  }
  const rows = plan.requirements.map((requirement) => {
    const expected = plan.expected.filter(
      (slot) => slot.requirementId === requirement.requirementId,
    );
    const attempts = journal.attempts.filter(
      (row) => row.requirementId === requirement.requirementId,
    );
    const missed = expected
      .filter((slot) => !fresh.has(slot.sampleId))
      .map((slot) => slot.sampleId);
    const qualified = attempts.filter((row) =>
      requirement.kind === "native-story" ? storyQualifies(row) : freshQualifies(row),
    );
    const attemptedFresh = attempts.filter((row) => row.kind === "fresh" && hasAttempt(row));
    const counted =
      requirement.kind === "timed-condition" || requirement.kind === "negative"
        ? attemptedFresh.length
        : qualified.length;
    return {
      requirement,
      expected,
      attempts,
      counts: {
        expected: expected.length,
        attempted: attempts.filter(hasAttempt).length,
        freshAttempted: attemptedFresh.length,
        observed: attempts.filter(hasObservation).length,
        accepted: attempts.filter((row) => row.accepted).length,
        qualifiedFresh: qualified.length,
        qualifiedStories: requirement.kind === "native-story" ? qualified.length : 0,
        qualifyingABTurns: requirement.kind === "native-story" ? qualified.length * 2 : 0,
        missed: missed.length,
        failed: attempts.filter((row) => row.outcome === "fail").length,
        unknown: attempts.filter((row) => row.outcome === "unknown").length,
        blocked: attempts.filter((row) => row.outcome === "blocked").length,
        skipped: attempts.filter((row) => row.outcome === "skipped").length,
        unrun: attempts.filter((row) => row.outcome === "unrun").length,
      },
      missedSampleIds: missed,
      selectedDenominator:
        requirement.kind === "timed-condition" || requirement.kind === "negative"
          ? ("fresh-attempted" as const)
          : ("qualified-fresh" as const),
      counted,
      minimumMet: counted >= requirement.requiredCount,
    };
  });
  const statistics = describeDurationsV1(durations);
  const report = {
    ok: true as const,
    authentication: "unverified" as const,
    source: journal.source,
    runId: journal.runId,
    plan: planResult.value,
    journal: journalResult.value,
    requirements: rows,
    inventoryComplete:
      rows.every((row) => row.counts.missed === 0) && journal.omissions.length === 0,
    sampleMinimumsMet: rows.every((row) => row.minimumMet),
    statistics,
    realMeasurementsEstablished: false as const,
  };
  if (encodeSamplingV1(report).byteLength > 16_777_216) return failSamplingV1("report-too-large");
  return report;
}

export type JournalReceiptDeclarationV1 = Pick<
  ProducerReceiptV1,
  | "receiptId"
  | "previousReceipt"
  | "receivedAt"
  | "collection"
  | "outcome"
  | "reasonCode"
  | "checks"
  | "observations"
  | "review"
  | "custody"
  | "invalidation"
  | "reuse"
>;

/** Partial journal states cannot be repaired into a different execution subject. */
export function mapJournalExecutionV1(
  execution: SamplingExecutionV1,
): ProducerReceiptV1["execution"] | null {
  if (execution.state === "not-launched") return { state: "unrun" };
  if (
    execution.state !== "launched" ||
    execution.executorRef === null ||
    execution.tool.state === "missing" ||
    execution.started.state === "missing"
  )
    return null;
  const common = {
    executionClass: execution.executionClass,
    executorRef: execution.executorRef,
    tool: execution.tool.digest,
    started: {
      clockRef: execution.started.clockRef,
      observedAt: execution.started.observedAt,
      uncertaintyMs: execution.started.uncertaintyMs,
    },
    capture: execution.capture,
  };
  if (execution.ended.state === "missing") return { state: "end-unavailable", ...common };
  if (execution.interval.state === "missing") return null;
  return {
    state: "observed",
    ...common,
    ended: {
      clockRef: execution.ended.clockRef,
      observedAt: execution.ended.observedAt,
      uncertaintyMs: execution.ended.uncertaintyMs,
    },
    monotonicClockRef: execution.interval.clockRef,
    monotonicDurationMs: execution.interval.durationMs,
  };
}

/** Internal shared adapter also used by the installer. All execution claims remain declarations. */
export function adaptValidatedJournalV1(options: {
  companionBytes: unknown;
  journalBytes: Uint8Array;
  runId: string;
  leafId: keyof typeof ACCEPTANCE_LEAVES_V1;
  inputs: SamplingInputsV1;
  execution: SamplingExecutionV1;
  outcome: string;
  declaration: JournalReceiptDeclarationV1;
}) {
  const companion = decodeAssertionCompanionV1(options.companionBytes);
  if (!companion.ok) return companion;
  const spec = companion.value;
  if (
    spec.leaf.primaryProducer !== "P-OPS" ||
    spec.runId !== options.runId ||
    spec.leaf.id !== options.leafId ||
    !sameDigestV1(spec.inputManifest, options.inputs.inputManifest) ||
    !sameDigestV1(spec.procedure, options.inputs.procedure) ||
    !sameDigestV1(spec.tuple, options.inputs.tuple) ||
    !sameDigestV1(spec.limits, options.inputs.limits) ||
    !spec.demonstrationInputs.every((item, index) =>
      sameDigestV1(item, options.inputs.demonstrationInputs[index]!),
    )
  )
    return failSamplingV1("journal-companion-mismatch");
  const execution = mapJournalExecutionV1(options.execution);
  if (execution === null) return failSamplingV1("execution-unrepresentable");
  if (
    options.declaration.collection === "missing" ||
    options.declaration.outcome !== options.outcome
  )
    return failSamplingV1("journal-declaration-mismatch");
  const result = digestAcceptanceBytesV1("result", options.journalBytes);
  const evidence = digestAcceptanceBytesV1("evidence", options.journalBytes);
  const declaration = options.declaration;
  const receipt: ProducerReceiptV1 = {
    schemaVersion: "producer-receipt/v1",
    schemaDigest: ACCEPTANCE_SCHEMA_DIGESTS_V1.receipt,
    receiptId: declaration.receiptId,
    runId: options.runId,
    leafId: options.leafId,
    companion: companion.identity,
    inputManifest: options.inputs.inputManifest,
    procedure: { state: "frozen", digest: options.inputs.procedure },
    producer: "P-OPS",
    role: "primary",
    result: { state: "present", digest: result },
    execution,
    previousReceipt: declaration.previousReceipt,
    receivedAt: declaration.receivedAt,
    collection: declaration.collection,
    outcome: declaration.outcome,
    reasonCode: declaration.reasonCode,
    checks: declaration.checks,
    observations: declaration.observations,
    review: declaration.review,
    custody: declaration.custody,
    invalidation: declaration.invalidation,
    reuse: declaration.reuse,
  };
  const receiptBytes = encodeSamplingV1(receipt);
  const decoded = decodeProducerReceiptV1(receiptBytes);
  if (!decoded.ok) return decoded;
  const binding = bindProducerReceiptV1(options.companionBytes, receiptBytes);
  if (!binding.ok) return binding;
  return {
    ok: true as const,
    receiptBytes,
    journalResult: result,
    journalEvidence: evidence,
    binding,
    authentication: "unverified" as const,
  };
}
export function adaptSampleJournalV1(options: {
  planBytes: unknown;
  journalBytes: unknown;
  companionBytes: unknown;
  attemptId: string;
  declaration: JournalReceiptDeclarationV1;
}) {
  const evaluated = evaluateSamplingV1(options.planBytes, options.journalBytes);
  if (!evaluated.ok) return evaluated;
  const decoded = decodeSampleJournalV1(options.journalBytes);
  if (!decoded.ok) return decoded;
  const attempt = decoded.value.attempts.find((row) => row.attemptId === options.attemptId);
  if (!attempt) return failSamplingV1("missing-adapter-attempt");
  if (options.declaration.collection !== attempt.collection)
    return failSamplingV1("sample-collection-mismatch");
  // A pass declared for the sampling leaf needs the complete selected denominator and no uncertain bound.
  if (
    options.declaration.outcome === "pass" &&
    (!evaluated.inventoryComplete ||
      !evaluated.sampleMinimumsMet ||
      evaluated.statistics.omissions.length !== 0 ||
      evaluated.statistics.boundDisposition !== "no-observed-violation")
  )
    return failSamplingV1("sampling-pass-incomplete");
  return adaptValidatedJournalV1({
    companionBytes: options.companionBytes,
    journalBytes: decoded.originalBytes(),
    runId: decoded.value.runId,
    leafId: attempt.leafId,
    inputs: decoded.value.inputs,
    execution: attempt.execution,
    outcome: attempt.outcome,
    declaration: options.declaration,
  });
}
