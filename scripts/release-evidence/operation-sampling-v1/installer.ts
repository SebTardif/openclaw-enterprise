import { ACCEPTANCE_LEAVES_V1 } from "@openclaw-enterprise/contracts/acceptance-companion-v1";
import {
  IndependentInstallerJournalSchemaV1,
  SAMPLING_SCHEMA_DIGESTS_V1,
  decodeSamplingRecordV1,
  failSamplingV1,
  uniqueSamplingV1,
  type InstallerJournalV1,
  type SamplingResultV1,
} from "./schema.ts";
import {
  adaptValidatedJournalV1,
  executionIssueV1,
  usableExecutionV1,
  type JournalReceiptDeclarationV1,
} from "./sampling.ts";

export function decodeInstallerJournalV1(bytes: unknown): SamplingResultV1<InstallerJournalV1> {
  const result = decodeSamplingRecordV1<InstallerJournalV1>(
    bytes,
    IndependentInstallerJournalSchemaV1,
    SAMPLING_SCHEMA_DIGESTS_V1.installer,
  );
  if (!result.ok) return result;
  const journal = result.value;
  if (ACCEPTANCE_LEAVES_V1[journal.leafId].producer !== "P-OPS")
    return failSamplingV1("installer-leaf-mismatch");
  if (
    !uniqueSamplingV1(journal.steps.map((row) => row.stepId)) ||
    !journal.steps.every((row, index) => row.order === index + 1) ||
    !uniqueSamplingV1(journal.attempts.map((row) => row.attemptId)) ||
    !uniqueSamplingV1(journal.prerequisites.map((row) => row.prerequisiteId)) ||
    !uniqueSamplingV1(journal.interventions.map((row) => row.interventionId)) ||
    !uniqueSamplingV1(journal.resources.map((row) => row.resourceRef)) ||
    !uniqueSamplingV1(journal.installer.authorRefs)
  )
    return failSamplingV1("duplicate-or-unordered-installer-identity");
  const steps = new Map(journal.steps.map((row, index) => [row.stepId, { row, index }]));
  const seen = new Map<string, InstallerJournalV1["attempts"][number]>();
  for (const attempt of journal.attempts) {
    const issue = executionIssueV1(attempt.execution, attempt.outcome, journal.source);
    if (issue) return failSamplingV1(issue);
    if (attempt.originalAttemptId === attempt.attemptId) {
      if (attempt.supersedesAttemptId !== null) return failSamplingV1("invalid-installer-history");
    } else {
      const original = seen.get(attempt.originalAttemptId);
      const previous =
        attempt.supersedesAttemptId === null ? undefined : seen.get(attempt.supersedesAttemptId);
      if (
        !original ||
        !previous ||
        original.originalAttemptId !== original.attemptId ||
        previous.originalAttemptId !== original.attemptId
      )
        return failSamplingV1("invalid-installer-history");
    }
    if (!uniqueSamplingV1(attempt.steps.map((row) => row.stepId)))
      return failSamplingV1("duplicate-step-result");
    let previousOrder = -1;
    for (const observed of attempt.steps) {
      const expected = steps.get(observed.stepId);
      if (!expected || expected.index <= previousOrder)
        return failSamplingV1("unknown-or-unordered-step");
      previousOrder = expected.index;
      if (expected.row.instruction.kind === "manual" && observed.exitCode !== null)
        return failSamplingV1("manual-exit-code");
      if (
        expected.row.instruction.kind === "command" &&
        observed.state === "completed" &&
        observed.exitCode !== null &&
        observed.exitCode !== 0
      )
        return failSamplingV1("completed-command-failed-exit");
    }
    seen.set(attempt.attemptId, attempt);
  }
  for (const intervention of journal.interventions) {
    if (
      !seen.has(intervention.attemptId) ||
      (intervention.stepId !== null && !steps.has(intervention.stepId))
    )
      return failSamplingV1("unknown-intervention-target");
  }
  return result;
}

export function evaluateInstallerV1(bytes: unknown) {
  const result = decodeInstallerJournalV1(bytes);
  if (!result.ok) return result;
  const journal = result.value;
  const issues: { subjectRef: string; reason: string }[] = [];
  const add = (subjectRef: string, reason: string) => issues.push({ subjectRef, reason });
  if (journal.inputs.procedureReview.state === "missing")
    add(journal.journalId, "missing-procedure-review");
  if (journal.packageReferences.length === 0) add(journal.journalId, "missing-package-references");
  if (
    journal.installer.independence !== "declared-independent" ||
    journal.installer.declaration.state === "missing" ||
    journal.installer.independenceEvidence.state === "missing" ||
    journal.installer.authorRefs.length === 0 ||
    journal.installer.authorRefs.includes(journal.installer.actorRef)
  )
    add(journal.installer.actorRef, "independence-unestablished");
  if (journal.prerequisites.length === 0) add(journal.journalId, "missing-prerequisites");
  for (const row of journal.prerequisites)
    if (row.outcome !== "pass" || row.evidence.state === "missing")
      add(row.prerequisiteId, `prerequisite-${row.outcome}-${row.evidence.state}`);
  if (journal.steps.length === 0) add(journal.journalId, "missing-procedure-steps");
  if (journal.attempts.length === 0) add(journal.journalId, "missing-attempts");
  const attempts = journal.attempts.map((attempt) => {
    const incomplete: { stepId: string; reasons: string[] }[] = [];
    for (const expected of journal.steps) {
      const actual = attempt.steps.find((row) => row.stepId === expected.stepId);
      const reasons: string[] = [];
      if (!actual) reasons.push("missing-step-result");
      else {
        if (actual.state !== "completed" && actual.state !== "failed")
          reasons.push(`step-${actual.state}`);
        if (actual.capture.state === "missing") reasons.push("missing-step-capture");
        if (expected.instruction.kind === "command" && actual.exitCode === null)
          reasons.push("missing-exit-code");
        if (actual.actorRef !== journal.installer.actorRef) reasons.push("different-step-actor");
      }
      if (reasons.length) incomplete.push({ stepId: expected.stepId, reasons });
    }
    if (incomplete.length) add(attempt.attemptId, "incomplete-step-results");
    if (!usableExecutionV1(attempt.execution))
      add(attempt.attemptId, "incomplete-execution-capture");
    if (
      attempt.execution.state === "launched" &&
      attempt.execution.executorRef !== journal.installer.actorRef
    )
      add(attempt.attemptId, "different-execution-actor");
    return {
      attempt,
      incomplete,
      successfulSteps:
        incomplete.length === 0 && attempt.steps.every((step) => step.state === "completed"),
    };
  });
  for (const row of journal.interventions) {
    if (row.visibility !== "documented" || row.evidence.state === "missing")
      add(row.interventionId, "private-or-unobserved-intervention");
    if (row.actorRef !== journal.installer.actorRef)
      add(row.interventionId, "outside-installer-intervention");
  }
  if (journal.resources.length === 0) add(journal.journalId, "missing-resource-inventory");
  for (const row of journal.resources)
    if (row.state === "unknown" || row.evidence.state === "missing" || row.cleanupOwnerRef === null)
      add(row.resourceRef, "resource-state-or-cleanup-responsibility-missing");
  for (const omission of journal.omissions) add(journal.journalId, `omission:${omission}`);
  return {
    ok: true as const,
    journal,
    attempts,
    issues,
    counts: {
      attempted: journal.attempts.filter((row) => row.execution.state === "launched").length,
      failed: journal.attempts.filter((row) => row.outcome === "fail").length,
      unknown: journal.attempts.filter((row) => row.outcome === "unknown").length,
      blocked: journal.attempts.filter((row) => row.outcome === "blocked").length,
      skipped: journal.attempts.filter((row) => row.outcome === "skipped").length,
      unrun: journal.attempts.filter((row) => row.outcome === "unrun").length,
    },
    declarationComplete: issues.length === 0,
    independenceAuthenticated: false as const,
    installationEstablished: false as const,
    authentication: "unverified" as const,
  };
}

export function adaptInstallerJournalV1(options: {
  journalBytes: unknown;
  companionBytes: unknown;
  attemptId: string;
  declaration: JournalReceiptDeclarationV1;
}) {
  const evaluated = evaluateInstallerV1(options.journalBytes);
  if (!evaluated.ok) return evaluated;
  const decoded = decodeInstallerJournalV1(options.journalBytes);
  if (!decoded.ok) return decoded;
  const attempt = decoded.value.attempts.find((row) => row.attemptId === options.attemptId);
  if (!attempt) return failSamplingV1("missing-adapter-attempt");
  if (
    options.declaration.outcome === "pass" &&
    (!evaluated.declarationComplete ||
      !evaluated.attempts.find((row) => row.attempt.attemptId === options.attemptId)
        ?.successfulSteps)
  )
    return failSamplingV1("installer-pass-incomplete");
  return adaptValidatedJournalV1({
    companionBytes: options.companionBytes,
    journalBytes: decoded.originalBytes(),
    runId: decoded.value.runId,
    leafId: decoded.value.leafId,
    inputs: decoded.value.inputs,
    execution: attempt.execution,
    outcome: attempt.outcome,
    declaration: options.declaration,
  });
}
