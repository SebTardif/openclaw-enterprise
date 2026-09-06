import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Check } from "typebox/value";
import {
  decodeProducerReceiptV1,
  digestAcceptanceBytesV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-codec-v1";
import {
  SAMPLING_LIMITS_V1,
  SAMPLING_SCHEMA_DIGESTS_V1,
  OperationSamplingPlanSchemaV1,
  OperationSampleJournalSchemaV1,
  IndependentInstallerJournalSchemaV1,
} from "../../scripts/release-evidence/operation-sampling-v1/schema.ts";
import {
  adaptSampleJournalV1,
  decodeSamplingPlanV1,
  decodeSampleJournalV1,
  evaluateSamplingV1,
} from "../../scripts/release-evidence/operation-sampling-v1/sampling.ts";
import {
  adaptInstallerJournalV1,
  decodeInstallerJournalV1,
  evaluateInstallerV1,
} from "../../scripts/release-evidence/operation-sampling-v1/installer.ts";
import {
  describeDurationsV1,
  measureDurationV1,
} from "../../scripts/release-evidence/operation-sampling-v1/statistics.ts";
import {
  encode,
  fictionalDigest,
  syntheticClock,
  syntheticPlan,
  syntheticSamples,
  syntheticInstaller,
  syntheticDeclaration,
  companionBytes,
} from "../fixtures/operation-sampling-v1/fixtures.ts";
import { consumeSample, consumeInstaller } from "../fixtures/operation-sampling-v1/consumer.ts";

const fixture = () => {
  const plan = syntheticPlan();
  return { plan, journal: syntheticSamples(plan) };
};
const evaluate = ({ plan, journal }) => evaluateSamplingV1(encode(plan), encode(journal));
const success = (result) => {
  assert.equal(result.ok, true, result.code);
  return result;
};
const rejected = (result, code) => assert.deepEqual(result, { ok: false, code });
const timed = (journal) =>
  journal.attempts.filter((row) => row.requirementId === "fictional-disable");
const adapt = (plan, journal, attempt = journal.attempts[0], declaration) => {
  const bytes = encode(journal);
  return adaptSampleJournalV1({
    planBytes: encode(plan),
    journalBytes: bytes,
    companionBytes: companionBytes(attempt.leafId),
    attemptId: attempt.attemptId,
    declaration: declaration ?? syntheticDeclaration(attempt.leafId, bytes),
  });
};
const declarationFor = (journal, attempt) => ({
  ...syntheticDeclaration(attempt.leafId, encode(journal)),
  outcome: attempt.outcome,
});
const installerAdapt = (
  journal,
  declaration = syntheticDeclaration(journal.leafId, encode(journal)),
) =>
  adaptInstallerJournalV1({
    journalBytes: encode(journal),
    companionBytes: companionBytes(journal.leafId),
    attemptId: journal.attempts.at(-1).attemptId,
    declaration,
  });

test("local versioned schema digests and complete selected P6 synthetic inventory", () => {
  const { plan, journal } = fixture();
  for (const [key, schema, value] of [
    ["plan", OperationSamplingPlanSchemaV1, plan],
    ["sample", OperationSampleJournalSchemaV1, journal],
    ["installer", IndependentInstallerJournalSchemaV1, syntheticInstaller()],
  ]) {
    assert.equal(
      createHash("sha256").update(encode(schema)).digest("hex"),
      SAMPLING_SCHEMA_DIGESTS_V1[key],
    );
    assert.equal(Check(schema, value), true);
  }
  const report = success(evaluate({ plan, journal }));
  assert.equal(report.inventoryComplete, true);
  assert.equal(report.sampleMinimumsMet, true);
  assert.equal(report.authentication, "unverified");
  assert.equal(report.realMeasurementsEstablished, false);
  assert.deepEqual(
    report.requirements.map((row) => row.counted),
    [3, 3, 10, 10, 10, 1, 1],
  );
  assert.equal(
    report.requirements.reduce((sum, row) => sum + row.counts.qualifyingABTurns, 0),
    40,
  );
  assert.deepEqual(
    report.requirements
      .filter(
        (row) =>
          row.requirement.variantKind === "outage" || row.requirement.variantKind === "restart",
      )
      .map((row) => row.counted),
    [3, 1],
  );
});

test("P6 allocation, disposition, minima and both native channels cannot be weakened", () => {
  for (const index of [0, 2, 4]) {
    const plan = syntheticPlan();
    plan.requirements[index].requiredCount--;
    rejected(decodeSamplingPlanV1(encode(plan)), "p6-denominator-too-small");
  }
  for (const key of ["allocationSha256", "p6DispositionSha256"]) {
    const plan = syntheticPlan();
    plan.selection[key] = "0".repeat(64);
    rejected(decodeSamplingPlanV1(encode(plan)), "invalid-shape");
  }
  const plan = syntheticPlan();
  plan.requirements = plan.requirements.filter((row) => row.channel !== "teams");
  plan.expected = plan.expected.filter((row) => row.requirementId !== "fictional-story-teams");
  rejected(decodeSamplingPlanV1(encode(plan)), "missing-p6-category");
});

test("unknown operations are plan-owned and original parent case/assertion pairs are checked", () => {
  const { plan, journal } = fixture();
  journal.attempts[0].operationId = "not-in-the-plan";
  rejected(evaluate({ plan, journal }), "unexpected-attempt-scope");
  journal.attempts[0].parentCaseId = "r11-bounded-operation";
  rejected(decodeSampleJournalV1(encode(journal)), "sample-leaf-mismatch");
});

test("missing samples stay visible and cannot supply a passing sampling receipt", () => {
  const { plan, journal } = fixture();
  journal.attempts.splice(0, 1);
  const report = success(evaluate({ plan, journal }));
  assert.equal(report.inventoryComplete, false);
  assert.equal(report.requirements[0].counts.missed, 1);
  assert.deepEqual(report.requirements[0].missedSampleIds, [plan.expected[0].sampleId]);
  rejected(adapt(plan, journal), "sampling-pass-incomplete");
});

test("retry preserves failed original and never fills a fresh A/B story denominator", () => {
  const { plan, journal } = fixture();
  const original = journal.attempts.find((row) => row.channel === "slack");
  original.outcome = "fail";
  original.accepted = false;
  const retry = structuredClone(original);
  retry.attemptId += "-retry";
  retry.kind = "retry";
  retry.supersedesAttemptId = original.attemptId;
  retry.outcome = "pass";
  retry.accepted = true;
  retry.turns.forEach((turn) => {
    turn.turnId += "-retry";
  });
  journal.attempts.push(retry);
  const report = success(evaluate({ plan, journal }));
  const row = report.requirements.find((row) => row.requirement.channel === "slack");
  assert.equal(row.counts.attempted, 11);
  assert.equal(row.counts.failed, 1);
  assert.equal(row.counts.qualifiedStories, 9);
  assert.equal(row.minimumMet, false);
  assert.equal(row.attempts.length, 11);
});

test("probe, reused turns, seed collision and duplicate attempts cannot count as fresh stories", () => {
  const { plan, journal } = fixture();
  journal.attempts.push(structuredClone(journal.attempts[0]));
  rejected(evaluate({ plan, journal }), "duplicate-attempt-identity");
  const other = fixture();
  const stories = other.journal.attempts.filter((row) => row.channel === "slack");
  stories[1].turns[0].turnId = stories[0].turns[0].turnId;
  rejected(evaluate(other), "reused-turn-identity");
  plan.expected[1].seed = plan.expected[0].seed;
  rejected(decodeSamplingPlanV1(encode(plan)), "duplicate-plan-identity");
});

test("qualification needs two distinct ordered collaborators and original capture/freshness", () => {
  for (const change of [
    (row) => {
      row.turns[1].actorRef = row.turns[0].actorRef;
    },
    (row) => {
      row.turns.reverse();
    },
    (row) => {
      row.turns[1].evidence = { state: "missing" };
    },
    (row) => {
      row.captureReferences = [];
    },
    (row) => {
      row.freshnessEvidence = { state: "missing" };
    },
  ]) {
    const data = fixture();
    change(data.journal.attempts.find((row) => row.channel === "teams"));
    assert.equal(
      success(evaluate(data)).requirements.find((row) => row.requirement.channel === "teams").counts
        .qualifiedStories,
      9,
    );
  }
});

test("timed attempted denominator retains failed, unknown, blocked, skipped and unrun separately", () => {
  const data = fixture();
  const rows = timed(data.journal);
  for (const [index, state] of ["fail", "unknown", "blocked", "skipped", "unrun"].entries()) {
    rows[index].outcome = state;
    rows[index].accepted = false;
    if (["skipped", "unrun"].includes(state))
      rows[index].execution = {
        state: "not-launched",
        evidence: fictionalDigest("evidence", state),
      };
    if (["unknown", "blocked"].includes(state)) rows[index].execution.ended = { state: "missing" };
  }
  const row = success(evaluate(data)).requirements.find(
    (row) => row.requirement.kind === "timed-condition",
  );
  assert.equal(row.counts.attempted, 8);
  assert.equal(row.counted, 8);
  assert.deepEqual(
    [
      row.counts.failed,
      row.counts.unknown,
      row.counts.blocked,
      row.counts.skipped,
      row.counts.unrun,
    ],
    [1, 1, 1, 1, 1],
  );
});

test("request, authentication and commit clocks expose distinct local-denial intervals", () => {
  const data = fixture();
  const report = success(evaluate(data));
  const durations = report.statistics.rows.filter(
    (row) => row.attemptId === timed(data.journal)[0].attemptId,
  );
  assert.deepEqual(
    durations.map((row) => [row.metric, row.duration.milliseconds, row.hardBoundMs]),
    [
      ["request-to-denial", 500, null],
      ["acceptance-to-denial", 400, 60000],
      ["commit-to-denial", 300, null],
      ["commit-latency", 100, null],
    ],
  );
  assert.equal(report.journal.attempts[0].physicalTermination.state, "unknown");
  assert.equal(report.journal.attempts[0].tokens[0].revocation.state, "unknown");
});

test("missing clocks, missing boundary capture and failed/ambiguous commit are indeterminate", () => {
  for (const change of [
    (row) => {
      row.clocks.authenticatedAcceptance = { state: "missing" };
    },
    (row) => {
      row.boundaries = [];
    },
    (row) => {
      row.commitState = "failed";
    },
    (row) => {
      row.commitState = "unknown";
    },
  ]) {
    const data = fixture();
    change(timed(data.journal)[0]);
    const report = success(evaluate(data));
    assert.ok(report.statistics.omissions.length);
    rejected(adapt(data.plan, data.journal), "sampling-pass-incomplete");
  }
});

test("unknown clock relation does not become a duration; monotonic evidence can establish one", () => {
  const start = syntheticClock(100, 0, "clock-one");
  const end = syntheticClock(300, 0, "clock-two");
  assert.deepEqual(measureDurationV1(start, end), {
    state: "unavailable",
    reason: "incompatible-clocks",
  });
  end.monotonic.clockRef = start.monotonic.clockRef;
  assert.equal(measureDurationV1(start, end).milliseconds, 200);
  start.monotonic = { state: "missing" };
  end.monotonic = { state: "missing" };
  end.clockRef = start.clockRef;
  assert.equal(measureDurationV1(start, end).method, "same-domain-wall");
});

test("uncertainty straddling a hard bound stays indeterminate and an observed violation fails", () => {
  const data = fixture();
  const row = timed(data.journal)[0];
  row.boundaries[0].firstDeny = syntheticClock(60_100, 10);
  row.boundaries[0].denial.clock = row.boundaries[0].firstDeny;
  assert.equal(success(evaluate(data)).statistics.boundDisposition, "indeterminate");
  row.boundaries[0].firstDeny = syntheticClock(60_111, 10);
  row.boundaries[0].denial.clock = row.boundaries[0].firstDeny;
  const report = success(evaluate(data));
  assert.equal(report.statistics.boundDisposition, "fail");
  assert.equal(report.statistics.violations.length, 1);
  assert.equal(report.statistics.violations[0].attemptId, row.attemptId);
});

const durationRow = (value, index = 0) => ({
  attemptId: `attempt-${index}`,
  requirementId: "requirement",
  operationId: "operation",
  conditionId: null,
  variantId: "baseline",
  channel: "slack",
  purpose: "none",
  boundaryId: "boundary",
  metric: "latency",
  eligibility: { state: "eligible" },
  duration: {
    state: "available",
    clockDomain: "clock",
    method: "monotonic",
    milliseconds: value,
    lowerMs: value,
    upperMs: value,
  },
  hardBoundMs: 60_000,
});
test("nearest-rank descriptive p95, even median, empty data and outliers are exact", () => {
  const summary = describeDurationsV1([1, 2, 3, 4].map(durationRow)).summaries[0];
  assert.deepEqual(summary.statistics, { min: 1, median: 2.5, max: 4, descriptiveP95: 4 });
  assert.deepEqual(describeDurationsV1([]).summaries, []);
  const missing = durationRow(0);
  missing.duration = { state: "unavailable", reason: "no-capture" };
  assert.equal(describeDurationsV1([missing]).summaries[0].statistics, null);
  const outlier = describeDurationsV1([...Array(19).fill(1), 60_001].map(durationRow));
  assert.equal(outlier.summaries[0].statistics.descriptiveP95, 1);
  assert.equal(outlier.boundDisposition, "fail");
  assert.equal(outlier.violations.length, 1);
  assert.equal(outlier.tailReliabilityEstablished, false);
});

test("statistics never pool channels, operations, variants or clock domains and reject overflow", () => {
  const rows = [durationRow(1), durationRow(2), durationRow(3), durationRow(4)];
  rows[1].channel = "teams";
  rows[2].operationId = "other";
  rows[3].duration.clockDomain = "other-clock";
  assert.equal(describeDurationsV1(rows).summaries.length, 4);
  assert.throws(() => describeDurationsV1([durationRow(Infinity)]), /invalid-statistic-value/);
  assert.throws(
    () => describeDurationsV1(Array(16_385).fill(durationRow(1))),
    /statistics-overflow/,
  );
});

test("plan-defined generic measurement hard bounds retain absent endpoints and observation limits", () => {
  const data = fixture();
  const requirement = data.plan.requirements[1];
  requirement.measurements = [
    { metricId: "fictional-physical-episode", meaning: "observation-limit", maximumMs: 120000 },
    { metricId: "fictional-replacement", meaning: "hard-bound", maximumMs: 5000 },
  ];
  data.journal.plan = digestAcceptanceBytesV1("input", encode(data.plan));
  const report = success(evaluate(data));
  assert.equal(
    report.statistics.rows.filter((row) => row.metric === "fictional-physical-episode").length,
    3,
  );
  assert.equal(
    report.statistics.indeterminate.filter((row) => row.metric === "fictional-replacement").length,
    3,
  );
  assert.equal(report.journal.attempts[3].physicalTermination.state, "unknown");
});

test("actual sampler adapter and independent exported consumer bind current receipt bytes", () => {
  const { plan, journal } = fixture();
  const attempt = journal.attempts[0];
  const result = success(adapt(plan, journal));
  assert.equal(result.authentication, "unverified");
  assert.equal(result.binding.receipt.value.producer, "P-OPS");
  assert.equal(result.binding.receipt.value.role, "primary");
  assert.deepEqual(result.journalResult, digestAcceptanceBytesV1("result", encode(journal)));
  assert.deepEqual(result.journalEvidence, digestAcceptanceBytesV1("evidence", encode(journal)));
  assert.equal(success(decodeProducerReceiptV1(result.receiptBytes)).value.review.state, "missing");
  const consumer = consumeSample(
    encode(plan),
    encode(journal),
    companionBytes(attempt.leafId),
    attempt.attemptId,
    syntheticDeclaration(attempt.leafId, encode(journal)),
  );
  assert.equal(consumer.binding.ok, true);
});

test("current Q1 launched end-unavailable unknown and blocked have no end or duration", () => {
  for (const outcome of ["unknown", "blocked"]) {
    const { plan, journal } = fixture();
    const attempt = journal.attempts[0];
    attempt.outcome = outcome;
    attempt.accepted = false;
    attempt.execution.ended = { state: "missing" };
    attempt.execution.capture = { state: "missing" };
    const result = success(adapt(plan, journal, attempt, declarationFor(journal, attempt)));
    const execution = result.binding.receipt.value.execution;
    assert.equal(execution.state, "end-unavailable");
    assert.equal(execution.capture.state, "missing");
    assert.equal(Object.hasOwn(execution, "ended"), false);
    assert.equal(Object.hasOwn(execution, "monotonicDurationMs"), false);
    assert.equal(result.binding.receipt.value.outcome, outcome);
  }
});

test("no-launch requires affirmative evidence and unknown launch cannot be represented as unrun", () => {
  const { plan, journal } = fixture();
  const attempt = journal.attempts[0];
  attempt.accepted = false;
  attempt.outcome = "unrun";
  attempt.execution = { state: "not-launched", evidence: fictionalDigest("evidence", "no-launch") };
  assert.equal(
    success(adapt(plan, journal, attempt, declarationFor(journal, attempt))).binding.receipt.value
      .execution.state,
    "unrun",
  );
  attempt.execution = { state: "launch-unknown" };
  attempt.outcome = "unknown";
  rejected(
    adapt(plan, journal, attempt, declarationFor(journal, attempt)),
    "execution-unrepresentable",
  );
  attempt.outcome = "unrun";
  rejected(decodeSampleJournalV1(encode(journal)), "unknown-launch-outcome-mismatch");
});

test("missing launch fields never get receipt-time, zero or guessed executor repairs", () => {
  for (const change of [
    (execution) => {
      execution.started = { state: "missing" };
    },
    (execution) => {
      execution.executorRef = null;
    },
    (execution) => {
      execution.tool = { state: "missing" };
    },
  ]) {
    const { plan, journal } = fixture();
    const attempt = journal.attempts[0];
    attempt.accepted = false;
    attempt.outcome = "unknown";
    attempt.execution.ended = { state: "missing" };
    change(attempt.execution);
    rejected(
      adapt(plan, journal, attempt, declarationFor(journal, attempt)),
      "execution-unrepresentable",
    );
  }
});

test("end unavailable rejects pass/fail/skipped/unrun and closed current schema rejects fake ending", () => {
  for (const outcome of ["pass", "fail", "skipped", "unrun"]) {
    const { journal } = fixture();
    journal.attempts[0].execution.ended = { state: "missing" };
    journal.attempts[0].outcome = outcome;
    journal.attempts[0].accepted = false;
    assert.equal(decodeSampleJournalV1(encode(journal)).ok, false);
  }
  const { plan, journal } = fixture();
  const attempt = journal.attempts[0];
  attempt.execution.ended = { state: "missing" };
  attempt.outcome = "unknown";
  attempt.accepted = false;
  const receipt = structuredClone(
    success(adapt(plan, journal, attempt, declarationFor(journal, attempt))).binding.receipt.value,
  );
  receipt.execution.ended = {
    clockRef: "invented",
    observedAt: "2026-01-01T00:00:01.000Z",
    uncertaintyMs: 0,
  };
  rejected(decodeProducerReceiptV1(encode(receipt)), "invalid-shape");
});

test("ended observer execution retains unknown target terminal and physical settlement", () => {
  const { plan, journal } = fixture();
  const result = success(adapt(plan, journal));
  assert.equal(result.binding.receipt.value.execution.state, "observed");
  assert.equal(journal.attempts[0].nativeTerminal.state, "unknown");
  assert.equal(journal.attempts[0].physicalTermination.state, "unknown");
  assert.equal(result.binding.receipt.value.observations[0].state, "unknown");
});

test("exact journal input/procedure/tuple/limits and ordered demonstration joins are required", () => {
  for (const key of ["inputManifest", "procedure", "tuple", "limits"]) {
    const data = fixture();
    data.journal.inputs = structuredClone(data.journal.inputs);
    data.journal.inputs[key] = fictionalDigest(data.journal.inputs[key].domain, "wrong");
    rejected(evaluate(data), "journal-plan-mismatch");
  }
  const data = fixture();
  data.journal.inputs = structuredClone(data.journal.inputs);
  data.journal.inputs.demonstrationInputs.reverse();
  rejected(evaluate(data), "journal-plan-mismatch");
  const other = fixture();
  const result = adaptSampleJournalV1({
    planBytes: encode(other.plan),
    journalBytes: encode(other.journal),
    companionBytes: companionBytes("R1-public-inputs"),
    attemptId: other.journal.attempts[0].attemptId,
    declaration: syntheticDeclaration("R1-public-inputs", encode(other.journal)),
  });
  rejected(result, "journal-companion-mismatch");
});

test("collection rejection, redaction, invalidation and receipt history remain explicit", () => {
  const { plan, journal } = fixture();
  const attempt = journal.attempts[0];
  attempt.outcome = "unknown";
  attempt.accepted = false;
  attempt.collection = "rejected";
  const declaration = declarationFor(journal, attempt);
  declaration.collection = "rejected";
  declaration.custody.redaction = "partial";
  declaration.previousReceipt = fictionalDigest("receipt", "old");
  declaration.invalidation = {
    state: "invalidated",
    replacementInput: fictionalDigest("input", "replacement"),
    reason: fictionalDigest("review", "invalidated"),
  };
  declaration.reuse = {
    originalReceipt: declaration.previousReceipt,
    originalObservedAt: "2026-01-01T00:00:00.000Z",
    rationale: fictionalDigest("review", "reuse"),
  };
  const receipt = success(adapt(plan, journal, attempt, declaration)).binding.receipt.value;
  assert.equal(receipt.collection, "rejected");
  assert.equal(receipt.custody.redaction, "partial");
  assert.equal(receipt.invalidation.state, "invalidated");
  assert.deepEqual(receipt.previousReceipt, declaration.previousReceipt);
  assert.deepEqual(receipt.reuse, declaration.reuse);
  declaration.collection = "missing";
  rejected(adapt(plan, journal, attempt, declaration), "sample-collection-mismatch");
});

test("installer complete synthetic journal and actual receipt consumer establish no real installation", () => {
  const journal = syntheticInstaller();
  const report = success(evaluateInstallerV1(encode(journal)));
  assert.equal(report.declarationComplete, true);
  assert.equal(report.independenceAuthenticated, false);
  assert.equal(report.installationEstablished, false);
  assert.equal(success(installerAdapt(journal)).authentication, "unverified");
  assert.equal(
    consumeInstaller(
      encode(journal),
      companionBytes(journal.leafId),
      journal.attempts[0].attemptId,
      syntheticDeclaration(journal.leafId, encode(journal)),
    ).ok,
    true,
  );
});

test("installer declaration alone, self-install and missing independence evidence remain incomplete", () => {
  for (const change of [
    (journal) => {
      journal.installer.independenceEvidence = { state: "missing" };
    },
    (journal) => {
      journal.installer.authorRefs.push(journal.installer.actorRef);
    },
    (journal) => {
      journal.installer.declaration = { state: "missing" };
    },
  ]) {
    const journal = syntheticInstaller();
    change(journal);
    assert.equal(success(evaluateInstallerV1(encode(journal))).declarationComplete, false);
    rejected(installerAdapt(journal), "installer-pass-incomplete");
  }
});

test("partial installer prerequisites, commands, exit/capture and resource responsibility survive", () => {
  const journal = syntheticInstaller();
  journal.prerequisites[0].outcome = "unknown";
  journal.attempts[0].steps[0].exitCode = null;
  journal.attempts[0].steps[0].capture = { state: "missing" };
  journal.attempts[0].steps.pop();
  journal.resources[0].state = "unknown";
  journal.resources[0].cleanupOwnerRef = null;
  journal.omissions.push("Fictional missing operator note");
  const report = success(evaluateInstallerV1(encode(journal)));
  assert.equal(report.declarationComplete, false);
  assert.ok(report.issues.some((row) => row.reason.includes("prerequisite")));
  assert.ok(report.attempts[0].incomplete.some((row) => row.reasons.includes("missing-exit-code")));
  assert.ok(
    report.attempts[0].incomplete.some((row) => row.reasons.includes("missing-step-result")),
  );
  assert.equal(report.journal.resources[0].state, "unknown");
});

test("actor-attributed private interventions and inert commands are retained without dispatch", () => {
  const journal = syntheticInstaller();
  journal.steps[0].instruction.executable = "$(fictional-command-must-never-execute)";
  journal.steps[0].instruction.arguments = ["; fictional-side-effect", "`fictional-interpolation`"];
  journal.interventions.push({
    interventionId: "fictional-intervention",
    attemptId: journal.attempts[0].attemptId,
    stepId: journal.steps[0].stepId,
    actorRef: "fictional-author",
    visibility: "private",
    description: "Fictional intervention",
    evidence: { state: "missing" },
  });
  const report = success(evaluateInstallerV1(encode(journal)));
  assert.equal(report.declarationComplete, false);
  assert.equal(report.journal.interventions[0].actorRef, "fictional-author");
  assert.equal(
    report.journal.steps[0].instruction.executable,
    journal.steps[0].instruction.executable,
  );
});

test("installer keeps replacement purpose and failed original attempts in ordered history", () => {
  const journal = syntheticInstaller();
  journal.purpose = "replacement";
  journal.attempts[0].outcome = "fail";
  journal.attempts[0].steps[0].state = "failed";
  journal.attempts[0].steps[0].exitCode = 1;
  const retry = structuredClone(journal.attempts[0]);
  retry.attemptId += "-retry";
  retry.supersedesAttemptId = journal.attempts[0].attemptId;
  retry.outcome = "pass";
  retry.steps[0].state = "completed";
  retry.steps[0].exitCode = 0;
  journal.attempts.push(retry);
  const report = success(evaluateInstallerV1(encode(journal)));
  assert.equal(report.counts.failed, 1);
  assert.equal(report.counts.attempted, 2);
  assert.equal(report.journal.purpose, "replacement");
  assert.equal(report.journal.attempts[0].steps[0].exitCode, 1);
  assert.equal(success(installerAdapt(journal)).binding.receipt.value.outcome, "pass");
  journal.steps.reverse();
  rejected(decodeInstallerJournalV1(encode(journal)), "duplicate-or-unordered-installer-identity");
});

test("original journal bytes determine result/evidence identity and exact review result", () => {
  const journal = syntheticInstaller();
  const compact = encode(journal);
  const pretty = new TextEncoder().encode(JSON.stringify(journal, null, 2) + "\n");
  const options = {
    companionBytes: companionBytes(journal.leafId),
    attemptId: journal.attempts[0].attemptId,
    declaration: syntheticDeclaration(journal.leafId, compact),
  };
  const a = success(adaptInstallerJournalV1({ ...options, journalBytes: compact }));
  const b = success(adaptInstallerJournalV1({ ...options, journalBytes: pretty }));
  assert.notEqual(a.journalResult.sha256, b.journalResult.sha256);
  assert.equal(b.journalResult.sha256, createHash("sha256").update(pretty).digest("hex"));
  assert.equal(b.journalResult.sha256, b.journalEvidence.sha256);
  assert.notEqual(b.journalResult.domain, b.journalEvidence.domain);
});

test("bounded byte decoders reject overflow, invalid clocks, duplicate escaped keys and lossy numbers", () => {
  const bytes = encode(syntheticPlan());
  const text = new TextDecoder().decode(bytes);
  rejected(decodeSamplingPlanV1(new Uint8Array(SAMPLING_LIMITS_V1.maxBytes + 1)), "too-large");
  rejected(
    decodeSamplingPlanV1(
      new TextEncoder().encode(text.replace('"planId":', '"plan\\u0049d":"duplicate","planId":')),
    ),
    "duplicate-key",
  );
  rejected(
    decodeSamplingPlanV1(
      new TextEncoder().encode(
        text.replace('"requiredCount":3', '"requiredCount":3.0000000000000001'),
      ),
    ),
    "invalid-number",
  );
  const journal = syntheticSamples();
  journal.attempts[0].clocks.requestReceived.observedAt = "2026-02-30T00:00:00.000Z";
  rejected(decodeSampleJournalV1(encode(journal)), "invalid-clock");
  rejected(
    decodeSamplingPlanV1(new TextEncoder().encode("[".repeat(26) + "0" + "]".repeat(26))),
    "limit-exceeded",
  );
  rejected(decodeSamplingPlanV1(new Uint8Array(new SharedArrayBuffer(8))), "invalid-input");
});

test("bounded decoding snapshots original bytes and freezes schema and nested values", () => {
  const bytes = encode(syntheticPlan());
  const before = bytes.slice();
  const decoded = success(decodeSamplingPlanV1(bytes));
  bytes.fill(0);
  decoded.originalBytes().fill(0);
  assert.deepEqual(decoded.originalBytes(), before);
  assert.throws(() => {
    decoded.value.requirements[0].requiredCount = 1;
  }, TypeError);
  assert.throws(() => {
    OperationSampleJournalSchemaV1.additionalProperties = true;
  }, TypeError);
});

test("missing or mismatched denial capture cannot supply an eligible passing bound", () => {
  for (const change of [
    (boundary) => {
      boundary.denial.evidence = { state: "missing" };
    },
    (boundary) => {
      boundary.denial.clock = { state: "missing" };
    },
    (boundary) => {
      boundary.denial.clock = syntheticClock(700);
    },
  ]) {
    const data = fixture();
    change(timed(data.journal)[0].boundaries[0]);
    const report = success(evaluate(data));
    assert.equal(report.statistics.boundDisposition, "indeterminate");
    assert.ok(
      report.statistics.omissions.some(
        (row) => row.reason === "denial-unconfirmed-or-capture-mismatch",
      ),
    );
    rejected(adapt(data.plan, data.journal), "sampling-pass-incomplete");
  }
});

test("every qualifying sample requires its own usable captured execution", () => {
  for (const change of [
    (execution) => {
      execution.ended.observedAt = "2025-12-31T23:59:59.000Z";
    },
    (execution) => {
      execution.capture = { state: "missing" };
    },
    (execution) => {
      execution.executorRef = null;
    },
    (execution) => {
      execution.tool = { state: "missing" };
    },
    (execution) => {
      execution.interval = { state: "missing" };
    },
    (execution) => {
      execution.interval.durationMs = 20;
    },
    (execution) => {
      execution.ended = syntheticClock(1_000, 0, "incompatible");
    },
  ]) {
    const data = fixture();
    change(data.journal.attempts[1].execution);
    const report = success(evaluate(data));
    assert.equal(report.requirements[0].counted, 2);
    assert.equal(report.requirements[0].counts.attempted, 3);
    rejected(adapt(data.plan, data.journal), "sampling-pass-incomplete");
  }
});

test("frozen procedure review state and exact bytes must agree with the sample journal", () => {
  for (const review of [
    { state: "missing" },
    { state: "present", digest: fictionalDigest("review", "different-review") },
  ]) {
    const data = fixture();
    data.journal.inputs = structuredClone(data.journal.inputs);
    data.journal.inputs.procedureReview = review;
    rejected(evaluate(data), "journal-plan-mismatch");
  }
});

test("selected rejected or missing collection cannot be relabeled received", () => {
  for (const collection of ["rejected", "missing"]) {
    const data = fixture();
    const attempt = data.journal.attempts[0];
    attempt.outcome = "unknown";
    attempt.accepted = false;
    attempt.collection = collection;
    const declaration = declarationFor(data.journal, attempt);
    declaration.collection = "received";
    rejected(adapt(data.plan, data.journal, attempt, declaration), "sample-collection-mismatch");
  }
});

test("a failed or unknown commit cannot hide any captured hard-bound violation", () => {
  for (const commitState of ["failed", "unknown"]) {
    const data = fixture();
    const attempt = timed(data.journal)[0];
    attempt.commitState = commitState;
    attempt.boundaries[0].firstDeny = syntheticClock(70_100);
    attempt.boundaries[0].denial.clock = attempt.boundaries[0].firstDeny;
    const report = success(evaluate(data));
    const row = report.statistics.rows.find(
      (row) => row.attemptId === attempt.attemptId && row.metric === "acceptance-to-denial",
    );
    assert.equal(row.duration.milliseconds, 70_000);
    assert.deepEqual(row.eligibility, { state: "omitted", reason: `commit-${commitState}` });
    assert.equal(report.statistics.boundDisposition, "fail");
    assert.equal(report.statistics.violations.length, 1);
    assert.ok(report.statistics.omissions.some((row) => row.reason === `commit-${commitState}`));
    rejected(adapt(data.plan, data.journal), "sampling-pass-incomplete");
  }
});

test("installer execution identity and capture cannot be replaced by step actor labels", () => {
  for (const change of [
    (execution) => {
      execution.executorRef = "fictional-author";
    },
    (execution) => {
      execution.executorRef = null;
    },
    (execution) => {
      execution.tool = { state: "missing" };
    },
    (execution) => {
      execution.interval = { state: "missing" };
    },
    (execution) => {
      execution.capture = { state: "missing" };
    },
  ]) {
    const journal = syntheticInstaller();
    change(journal.attempts[0].execution);
    const report = success(evaluateInstallerV1(encode(journal)));
    assert.equal(report.declarationComplete, false);
    rejected(installerAdapt(journal), "installer-pass-incomplete");
  }
});
