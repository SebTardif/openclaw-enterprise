import assert from "node:assert/strict";
import { posix } from "node:path";
import {
  decodeNativeMeasurementResultsJsonV1,
  evaluateNativeMeasurementsV1,
} from "../../packages/contracts/src/native-measurement-codec-v1.ts";
import {
  RESULT_SCHEMA,
  LIMITS,
  canonical,
  closed,
  digest,
  hex,
  parseJson,
  preparationBlockers,
  text,
  uint,
  unique,
} from "./manifest.mjs";

export const OBSERVATIONS_SCHEMA = "oce.isolated-upstream-observations/v1";
export const CASE_MARKER = "OCE_ISOLATED_CASES_V1=";
const outcomes = [
  "pass",
  "fail",
  "skip",
  "blocked",
  "missing",
  "unknown",
  "setup-failed",
  "timed-out",
  "cancelled",
  "incomplete",
  "unselected",
];
const rawOutcomes = ["passed", "failed", "launch_error", "timed_out", "cancelled", "incomplete"];

const stableFile = (entry) =>
  entry?.kind === "file" && entry.stable_during_read === true && !entry.error;
function provenanceIdentity(p) {
  const { version_probe: ignored, ...executable } = p.executable ?? {};
  return canonical({
    schema: p.schema,
    source: p.source,
    dependencies: p.dependencies,
    configuration: p.configuration,
    executable,
  });
}
function selectedExecutable(p, command) {
  const e = p?.executable;
  return (
    e?.requested === command.argv[0] &&
    typeof e.physical === "string" &&
    posix.isAbsolute(e.physical) &&
    e.physical_entry?.path === e.physical &&
    stableFile(e.physical_entry) &&
    e.physical_entry.sha256 === command.executableDigest &&
    typeof e.resolved === "string" &&
    posix.isAbsolute(e.resolved) &&
    e.selected_entry?.path === e.resolved &&
    ["file", "symlink"].includes(e.selected_entry.kind) &&
    e.selected_entry.stable_during_read === true &&
    !e.selected_entry.error
  );
}
function selectedInput(p, artifact, rootRef) {
  if (artifact.state !== "supplied") return false;
  const expected = posix.join(rootRef, artifact.path);
  const inventories = [
    { root: p.source?.root, entries: p.source?.entries },
    ...["dependencies", "configuration"].flatMap((group) =>
      (p[group]?.roots ?? []).map((r) => ({ root: r.absolute, entries: r.entries })),
    ),
  ];
  return inventories.some(
    ({ root, entries }) =>
      typeof root === "string" &&
      posix.isAbsolute(root) &&
      posix.normalize(root) === root &&
      Array.isArray(entries) &&
      entries.some((entry) => {
        if (
          !stableFile(entry) ||
          entry.sha256 !== artifact.sha256 ||
          entry.bytes !== artifact.bytes ||
          typeof entry.path !== "string"
        )
          return false;
        if (
          entry.path !== "." &&
          (posix.isAbsolute(entry.path) ||
            entry.path.split("/").some((part) => !part || part === "." || part === ".."))
        )
          return false;
        return posix.join(root, entry.path) === expected;
      }),
  );
}

function record(value, schema) {
  if (value === null) return null;
  closed(value, ["originalPath", "content"]);
  text(value.originalPath, 1024);
  assert.equal(typeof value.content, "string");
  assert.ok(Buffer.byteLength(value.content) <= LIMITS.jsonBytes);
  const parsed = schema === null ? null : parseJson(value.content, { integersOnly: false });
  if (schema !== null) assert.equal(parsed.schema, schema, "unsupported original record schema");
  return {
    path: value.originalPath,
    sha256: digest(Buffer.from(value.content)),
    content: value.content,
    value: parsed,
  };
}

function reference(ref, actual) {
  if (!actual || !ref) return false;
  assert.equal(ref.path, actual.path);
  assert.equal(ref.sha256, actual.sha256, "record digest mismatch");
  return true;
}

function inspectAttempt(input, manifest) {
  closed(input, [
    "id",
    "caseIds",
    "callerReturn",
    "environment",
    "sourceBefore",
    "intent",
    "launched",
    "terminal",
    "receipt",
    "wrapper",
    "log",
  ]);
  text(input.id);
  unique(input.caseIds);
  assert.ok(input.caseIds.length > 0);
  if (input.callerReturn !== null) uint(input.callerReturn, 255);
  const s = input.sourceBefore === null ? null : record(input.sourceBefore, null);
  const intent = record(input.intent, "development-loop.launch-intent/v1");
  const launched = record(input.launched, "development-loop.launched/v1");
  const terminal = record(input.terminal, "development-loop.terminal/v1");
  const receipt = record(input.receipt, "development-loop.command/v1");
  const wrapper = record(input.wrapper, "development-loop.wrapper-result/v1");
  const log = record(input.log, null);
  for (const r of [intent, launched, terminal, receipt, wrapper])
    if (r !== null) assert.equal(r.value.id, input.id, "attempt identity mismatch");
  const t = terminal?.value;
  const r = receipt?.value;
  const w = wrapper?.value;
  if (t) {
    assert.ok(rawOutcomes.includes(t.outcome));
    assert.equal(t.automatic_retry, false);
    assert.equal(typeof t.command_launched, "boolean");
    assert.equal(typeof t.leader_exit_observed, "boolean");
    assert.ok(
      t.exit_code === null ||
        (Number.isSafeInteger(t.exit_code) && t.exit_code >= -255 && t.exit_code <= 255),
    );
    assert.equal(
      t.descendant_termination_verified,
      null,
      "runner does not certify physical descendants",
    );
    assert.equal(
      t.leader_exit_observed,
      t.command_launched && t.exit_code !== null,
      "incoherent leader observation",
    );
    assert.equal(
      t.settlement,
      !t.command_launched
        ? "not-launched"
        : t.exit_code === null
          ? "leader-unresolved"
          : "leader-exit-observed",
      "incoherent settlement",
    );
    if (t.command_launched) {
      assert.ok(Number.isSafeInteger(t.pid) && t.pid > 0);
      assert.equal(t.process_group, t.pid);
    } else {
      assert.equal(t.pid, null);
      assert.equal(t.process_group, null);
      assert.equal(t.exit_code, null);
      assert.equal(launched, null, "launched record contradicts no launch");
    }
    if (t.outcome === "passed" || t.outcome === "failed") {
      assert.ok(
        t.command_launched && t.leader_exit_observed,
        "normal outcome requires observed leader exit",
      );
      assert.equal(t.outcome === "passed", t.exit_code === 0, "raw outcome contradicts exit code");
    }
    if (t.outcome === "launch_error") assert.equal(t.command_launched, false);
    if (["timed_out", "cancelled"].includes(t.outcome)) assert.equal(t.command_launched, true);
  }
  if (r && t) {
    assert.equal(r.exit_code, t.exit_code);
    assert.equal(r.outcome, t.outcome);
    reference(r.terminal_record, terminal);
  }
  if (w) {
    assert.ok(["completed", "incomplete"].includes(w.wrapper_outcome));
    uint(w.return_code, 255);
    if (w.terminal_record !== null) reference(w.terminal_record, terminal);
    if (w.receipt_record !== null) reference(w.receipt_record, receipt);
  }
  if (r && log) {
    reference(r.log, log);
    assert.equal(r.log.bytes, Buffer.byteLength(log.content));
  }
  let disposition = !t
    ? "missing"
    : ({
        launch_error: "setup-failed",
        timed_out: "timed-out",
        cancelled: "cancelled",
        incomplete: "incomplete",
      }[t.outcome] ?? "unknown");
  let normalCompletion = false;
  let provenanceMatched = false;
  if (t && ["passed", "failed"].includes(t.outcome)) {
    disposition = "incomplete";
    normalCompletion = Boolean(
      w &&
      r &&
      log &&
      intent &&
      launched &&
      s &&
      w.terminal_record &&
      w.receipt_record &&
      r.terminal_record &&
      r.launch_intent &&
      r.log &&
      intent.value.source_before &&
      w.wrapper_outcome === "completed" &&
      w.deadline_expired_at_decision === false &&
      input.callerReturn === w.return_code &&
      t.command_launched &&
      t.leader_exit_observed &&
      t.exit_code !== null,
    );
    if (normalCompletion) {
      reference(intent.value.source_before, s);
      reference(r.launch_intent, intent);
      assert.equal(launched.value.pid, t.pid);
      assert.equal(launched.value.process_group, t.process_group);
      assert.equal(intent.value.automatic_retry, false);
      assert.equal(r.durable, true);
      assert.equal(canonical(r.argv), canonical(intent.value.argv));
      assert.equal(r.cwd, intent.value.cwd);
      assert.equal(w.return_code, t.exit_code < 0 ? 128 - t.exit_code : t.exit_code);
      const source = parseJson(s.content, { integersOnly: false });
      assert.equal(source.provenance_before?.schema, "development-loop.provenance/v1");
      assert.equal(canonical(source.provenance_before), canonical(r.provenance_before));
      const complete = (p) =>
        p?.source?.inventory_complete === true &&
        ["dependencies", "configuration"].every(
          (group) =>
            Array.isArray(p[group]?.roots) &&
            p[group].roots.every((root) => root.inventory_complete === true),
        );
      provenanceMatched =
        complete(r.provenance_before) &&
        complete(r.provenance_after) &&
        r.provenance_identity_changed === false &&
        r.observed_inputs_changed === false &&
        r.provenance_before.identity_sha256 === r.provenance_after.identity_sha256 &&
        provenanceIdentity(r.provenance_before) === provenanceIdentity(r.provenance_after) &&
        source.source_before !== undefined &&
        source.inputs_before !== undefined &&
        r.source_before !== undefined &&
        r.source_after !== undefined &&
        r.inputs_before !== undefined &&
        r.inputs_after !== undefined &&
        canonical(source.source_before) === canonical(r.source_before) &&
        canonical(source.inputs_before) === canonical(r.inputs_before) &&
        canonical(r.source_before) === canonical(r.source_after) &&
        canonical(r.inputs_before) === canonical(r.inputs_after) &&
        r.evidence?.value === "executed";
      disposition = provenanceMatched ? (t.outcome === "passed" ? "pass" : "fail") : "unknown";
    }
  }
  let assertions = [];
  if (normalCompletion) {
    const lines = log.content.split("\n").filter((line) => line.startsWith(CASE_MARKER));
    if (lines.length === 1) {
      const report = parseJson(lines[0].slice(CASE_MARKER.length));
      closed(report, ["schema", "caseIds", "results"]);
      assert.equal(report.schema, "oce.isolated-upstream-cases/v1");
      unique(report.caseIds);
      assert.equal(
        canonical([...report.caseIds].sort()),
        canonical([...input.caseIds].sort()),
        "case report selection mismatch",
      );
      assert.ok(Array.isArray(report.results));
      unique(report.results.map((entry) => entry.id));
      assert.equal(
        canonical(report.results.map((entry) => entry.id).sort()),
        canonical([...input.caseIds].sort()),
      );
      for (const a of report.results) {
        closed(a, ["id", "outcome", "settlement", "evidenceRefs", "measurement"]);
        assert.ok(["pass", "fail", "skip", "blocked", "unknown"].includes(a.outcome));
        assert.ok(["known", "unknown", "not-required"].includes(a.settlement));
        unique(a.evidenceRefs, 32).forEach((ref) => text(ref));
        assert.ok(a.evidenceRefs.length > 0, "assertion requires evidence references");
        if (a.measurement !== null) {
          closed(a.measurement, ["channel", "reportDigest"]);
          assert.ok(["slack", "teams"].includes(a.measurement.channel));
          hex(a.measurement.reportDigest);
        }
      }
      assertions = report.results;
    }
  }
  const cases = input.caseIds.map((id) => {
    const c = manifest.cases.find((entry) => entry.id === id);
    assert.ok(c?.selected, "attempt for unknown or unselected case");
    let outcome = disposition;
    let expectationMatched = false;
    if (normalCompletion && c.command.state === "supplied") {
      assert.equal(
        canonical(r.argv),
        canonical(c.command.argv),
        "argv differs from selected command",
      );
      assert.equal(r.cwd, c.command.cwdRef);
      const inputsMatch = [r.provenance_before, r.provenance_after].every(
        (p) =>
          selectedExecutable(p, c.command) &&
          c.inputIds.every((aid) =>
            selectedInput(
              p,
              manifest.artifacts.find((entry) => entry.id === aid),
              c.command.artifactRootRef,
            ),
          ),
      );
      if (!inputsMatch || canonical(input.environment) !== canonical(manifest.environment))
        outcome = "unknown";
      else if (provenanceMatched) {
        expectationMatched = t.exit_code === c.command.expectedExit;
        const a = assertions.find((entry) => entry.id === id);
        outcome = !expectationMatched ? "fail" : !a ? "incomplete" : a.outcome;
        if (a?.settlement === "unknown" && !id.endsWith("reconnect-ready")) outcome = "unknown";
      }
    } else if (normalCompletion) outcome = "blocked";
    if (preparationBlockers(manifest, c).length > 0 && outcome === "pass") outcome = "blocked";
    return {
      id,
      outcome,
      expectationMatched,
      blockers: preparationBlockers(manifest, c),
      assertion: assertions.find((entry) => entry.id === id) ?? null,
    };
  });
  return {
    id: input.id,
    cases,
    rawOutcome: t?.outcome ?? null,
    rawExit: t?.exit_code ?? null,
    callerReturn: input.callerReturn,
    wrapperOutcome: w?.wrapper_outcome ?? null,
    wrapperComplete: normalCompletion,
    provenanceMatched,
    rawTestCounts: r?.test_counts ?? null,
    caseSelectionVerified: assertions.length > 0,
    settlement: t?.settlement ?? "unknown",
    descendantTerminationVerified: null,
    environmentCoverage: "caller-declared-only",
    records: Object.fromEntries(
      Object.entries({ sourceBefore: s, intent, launched, terminal, receipt, wrapper, log }).map(
        ([key, entry]) => [key, entry ? { path: entry.path, sha256: entry.sha256 } : null],
      ),
    ),
  };
}

export function collectResults(manifest, manifestDigest, input) {
  hex(manifestDigest);
  const bytes = typeof input === "string" ? Buffer.from(input) : input;
  const b = parseJson(bytes);
  closed(b, [
    "schema",
    "manifestDigest",
    "evidenceKind",
    "discovered",
    "selected",
    "attempts",
    "measurements",
  ]);
  assert.equal(b.schema, OBSERVATIONS_SCHEMA);
  assert.equal(b.manifestDigest, manifestDigest);
  assert.equal(b.evidenceKind, manifest.evidenceKind);
  unique(b.discovered);
  unique(b.selected);
  unique(b.attempts.map((a) => a.id));
  for (const id of b.discovered)
    assert.ok(
      manifest.cases.some((c) => c.id === id),
      "unexpected discovery",
    );
  for (const id of b.selected)
    assert.ok(
      b.discovered.includes(id) && manifest.cases.some((c) => c.id === id && c.selected),
      "unexpected selection",
    );
  const attempts = b.attempts.map((a) => inspectAttempt(a, manifest));
  const observedCases = attempts.flatMap((a) => a.cases);
  unique(observedCases.map((c) => c.id)); // one attempt per case; no hidden retry selection
  for (const c of observedCases) assert.ok(b.selected.includes(c.id), "unselected observation");
  closed(b.measurements, ["slack", "teams"]);
  const measurements = {};
  for (const channel of ["slack", "teams"]) {
    const result = b.measurements[channel];
    if (result === null) {
      measurements[channel] = null;
      continue;
    }
    closed(result, ["content", "sha256"]);
    hex(result.sha256);
    assert.equal(typeof result.content, "string");
    assert.equal(
      digest(Buffer.from(result.content)),
      result.sha256,
      "measurement report digest mismatch",
    );
    const decoded = decodeNativeMeasurementResultsJsonV1(result.content);
    assert.equal(decoded.kind, "valid", "invalid measurement report");
    const evaluated = evaluateNativeMeasurementsV1(manifest.profiles[channel], decoded.value);
    assert.equal(evaluated.kind, "valid", "measurement correspondence mismatch");
    measurements[channel] = { sha256: result.sha256, evaluation: evaluated.value };
  }
  const counts = Object.fromEntries(outcomes.map((key) => [key, 0]));
  Object.assign(counts, {
    expected: manifest.cases.length,
    discovered: b.discovered.length,
    selected: b.selected.length,
  });
  const cases = manifest.cases.map((c) => {
    const observation = observedCases.find((entry) => entry.id === c.id);
    let outcome = !c.selected
      ? "unselected"
      : !b.discovered.includes(c.id)
        ? "missing"
        : !b.selected.includes(c.id)
          ? "unselected"
          : (observation?.outcome ??
            (c.command.state === "missing" || preparationBlockers(manifest, c).length > 0
              ? "blocked"
              : "missing"));
    if (outcome === "pass" && preparationBlockers(manifest, c).length > 0) outcome = "blocked";
    if (c.measurement && outcome === "pass") {
      const report = measurements[c.measurement.channel];
      const binding = observation.assertion?.measurement;
      const measured = report?.evaluation.cases.find((entry) => entry.id === c.measurement.caseId);
      outcome = !report
        ? "missing"
        : binding?.channel !== c.measurement.channel || binding?.reportDigest !== report.sha256
          ? "unknown"
          : (measured?.outcome ?? "missing");
    }
    assert.ok(outcomes.includes(outcome));
    counts[outcome]++;
    return {
      id: c.id,
      required: c.required,
      outcome,
      observation: observation ?? null,
      measurement: c.measurement,
      substitutes: c.substitutes,
    };
  });
  return {
    schema: RESULT_SCHEMA,
    manifestDigest,
    observationsDigest: digest(bytes),
    evidenceKind: manifest.evidenceKind,
    counts,
    cases,
    attempts,
    measurements,
    allRequiredReportedPass: cases.filter((c) => c.required).every((c) => c.outcome === "pass"),
    evidenceAuthenticated: false,
    runtimeQualified: false,
    automaticRetry: false,
  };
}
