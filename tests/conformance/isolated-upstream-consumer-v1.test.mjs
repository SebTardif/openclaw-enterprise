import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nativeMeasurementProfileDigestV1 } from "../../packages/contracts/src/native-measurement-codec-v1.ts";
import {
  canonical,
  digest,
  LIMITS,
  parseJson,
  REQUIRED_CASES,
  validateManifest,
} from "../../scripts/isolated-upstream-consumer-v1/manifest.mjs";
import {
  loadManifest,
  preparePlan,
  readArtifact,
  validateCanonicalContext,
  verifyArtifacts,
} from "../../scripts/isolated-upstream-consumer-v1/consumer.mjs";
import {
  CASE_MARKER,
  collectResults,
} from "../../scripts/isolated-upstream-consumer-v1/collector.mjs";
import { main } from "../../scripts/isolated-upstream-consumer-v1/cli.mjs";

const root = fileURLToPath(
  new URL("../fixtures/isolated-upstream-consumer-v1/", import.meta.url),
).replace(/\/$/, "");
const original = await readFile(join(root, "manifest.json"));
const selectedDigest = digest(original);
const fresh = () => JSON.parse(original);
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const selected = (value) => validateManifest(bytes(value), digest(bytes(value)));
const fixture = () => validateManifest(original, selectedDigest);
const observations = (m, attempts = []) => ({
  schema: "oce.isolated-upstream-observations/v1",
  manifestDigest: digest(bytes(m)),
  evidenceKind: m.evidenceKind,
  discovered: REQUIRED_CASES,
  selected: REQUIRED_CASES,
  attempts,
  measurements: { slack: null, teams: null },
});

function selectable(caseId = "preparation.context") {
  const m = fresh();
  const c = m.cases.find((entry) => entry.id === caseId);
  c.command = {
    state: "supplied",
    argv: ["node", "fixture-check.mjs"],
    cwdRef: "/fictional/work",
    artifactRootRef: "/fictional/work",
    executableDigest: "a".repeat(64),
    inputIds: c.inputIds,
    environmentNames: [],
    expectedExit: 0,
  };
  return m;
}

function attempt(
  m,
  {
    rawOutcome = "passed",
    exit = 0,
    assertion = "pass",
    settlement = "not-required",
    caseId = "preparation.context",
    measurement = null,
  } = {},
) {
  const id = "fictional-attempt-1";
  const c = m.cases.find((entry) => entry.id === caseId);
  const records = {};
  const record = (name, value) =>
    (records[name] = {
      originalPath: `/fictional/receipts/${name}.json`,
      content: typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
    });
  const ref = (value) => ({ path: value.originalPath, sha256: digest(Buffer.from(value.content)) });
  const inputArtifacts = c.inputIds
    .map((id) => m.artifacts.find((entry) => entry.id === id))
    .filter((a) => a.state === "supplied");
  const provenance = {
    schema: "development-loop.provenance/v1",
    source: {
      root: c.command.artifactRootRef,
      inventory_complete: true,
      entries: inputArtifacts.map((inputArtifact) => ({
        kind: "file",
        path: inputArtifact.path,
        bytes: inputArtifact.bytes,
        sha256: inputArtifact.sha256,
        stable_during_read: true,
      })),
    },
    dependencies: { roots: [] },
    configuration: { roots: [] },
    executable: {
      requested: c.command.argv[0],
      resolved: "/fictional/bin/node",
      physical: "/fictional/bin/node",
      selected_entry: {
        path: "/fictional/bin/node",
        kind: "file",
        stable_during_read: true,
        sha256: c.command.executableDigest,
      },
      physical_entry: {
        path: "/fictional/bin/node",
        kind: "file",
        stable_during_read: true,
        sha256: c.command.executableDigest,
      },
    },
    identity_sha256: "b".repeat(64),
  };
  record("sourceBefore", { source_before: {}, inputs_before: [], provenance_before: provenance });
  record("intent", {
    schema: "development-loop.launch-intent/v1",
    id,
    argv: c.command.argv,
    cwd: c.command.cwdRef,
    source_before: ref(records.sourceBefore),
    automatic_retry: false,
  });
  if (rawOutcome !== "launch_error")
    record("launched", { schema: "development-loop.launched/v1", id, pid: 42, process_group: 42 });
  else records.launched = null;
  record("terminal", {
    schema: "development-loop.terminal/v1",
    id,
    outcome: rawOutcome,
    exit_code: exit,
    command_launched: rawOutcome !== "launch_error",
    leader_exit_observed: exit !== null,
    pid: rawOutcome === "launch_error" ? null : 42,
    process_group: rawOutcome === "launch_error" ? null : 42,
    descendant_termination_verified: null,
    automatic_retry: false,
    settlement:
      rawOutcome === "launch_error"
        ? "not-launched"
        : exit === null
          ? "leader-unresolved"
          : "leader-exit-observed",
  });
  record(
    "log",
    `${CASE_MARKER}${JSON.stringify({ schema: "oce.isolated-upstream-cases/v1", caseIds: [caseId], results: [{ id: caseId, outcome: assertion, settlement, evidenceRefs: ["fictional/assertion"], measurement }] })}\n`,
  );
  record("receipt", {
    schema: "development-loop.command/v1",
    id,
    argv: c.command.argv,
    cwd: c.command.cwdRef,
    outcome: rawOutcome,
    exit_code: exit,
    durable: true,
    launch_intent: ref(records.intent),
    terminal_record: ref(records.terminal),
    log: { ...ref(records.log), bytes: Buffer.byteLength(records.log.content) },
    provenance_before: provenance,
    provenance_after: provenance,
    provenance_identity_changed: false,
    source_before: {},
    source_after: {},
    inputs_before: [],
    inputs_after: [],
    observed_inputs_changed: false,
    evidence: { value: "executed", basis: "caller-declared" },
    test_counts: null,
  });
  const callerReturn =
    { timed_out: 124, incomplete: 125, launch_error: 127, cancelled: 143 }[rawOutcome] ?? exit;
  record("wrapper", {
    schema: "development-loop.wrapper-result/v1",
    id,
    wrapper_outcome: rawOutcome === "incomplete" ? "incomplete" : "completed",
    return_code: callerReturn,
    deadline_expired_at_decision: false,
    terminal_record: ref(records.terminal),
    receipt_record: ref(records.receipt),
  });
  return { id, caseIds: [caseId], callerReturn, environment: [], ...records };
}

const collect = (m, a) => collectResults(selected(m), digest(bytes(m)), bytes(observations(m, a)));

function reviseRecord(a, key, mutate) {
  const value = JSON.parse(a[key].content);
  mutate(value);
  a[key].content = `${JSON.stringify(value)}\n`;
  const ref = (r) => ({ path: r.originalPath, sha256: digest(Buffer.from(r.content)) });
  if (key === "sourceBefore") {
    const intent = JSON.parse(a.intent.content);
    intent.source_before = ref(a.sourceBefore);
    a.intent.content = `${JSON.stringify(intent)}\n`;
    const receipt = JSON.parse(a.receipt.content);
    receipt.launch_intent = ref(a.intent);
    a.receipt.content = `${JSON.stringify(receipt)}\n`;
  }
  if (key === "terminal") {
    const receipt = JSON.parse(a.receipt.content);
    receipt.terminal_record = ref(a.terminal);
    a.receipt.content = `${JSON.stringify(receipt)}\n`;
  }
  const wrapper = JSON.parse(a.wrapper.content);
  wrapper.terminal_record = ref(a.terminal);
  wrapper.receipt_record = ref(a.receipt);
  a.wrapper.content = `${JSON.stringify(wrapper)}\n`;
}

test("fixture manifest binds all required browser groups and both complete measurement profiles", () => {
  const m = fixture();
  assert.equal(m.cases.filter((c) => c.required).length, REQUIRED_CASES.length);
  assert.equal(m.cases.filter((c) => c.measurement?.channel === "slack").length, 14);
  assert.equal(m.cases.filter((c) => c.measurement?.channel === "teams").length, 14);
  for (const group of ["B1", "B2", "B3", "B4", "B5", "B6"])
    assert.ok(m.cases.some((c) => c.id.startsWith(`${group}.`)));
  assert.equal(m.cases.filter((c) => /^B5\.[^.]+\.B[1-4]\./.test(c.id)).length, 54);
  assert.ok(Object.isFrozen(m.profiles.slack) && Object.isFrozen(m.cases[0]));
});

test("independent selection rejects changed same-label artifact, schema, configuration and producer", () => {
  for (const change of [
    (m) => {
      m.artifacts[0].sha256 = "d".repeat(64);
    },
    (m) => {
      m.schema = "oce.isolated-upstream-consumer/v2";
    },
    (m) => {
      m.browser.browserChatExposed = true;
    },
    (m) => {
      m.producer.codexCommit = "a".repeat(40);
    },
  ]) {
    const m = fresh();
    change(m);
    assert.throws(() => validateManifest(bytes(m), selectedDigest));
  }
});

test("unknown fields and altered closed producer constants are rejected even under a new digest", () => {
  for (const change of [
    (m) => {
      m.extra = true;
    },
    (m) => {
      m.producer.nativeStateSchema = 16;
    },
    (m) => {
      m.producer.newNativeField = true;
    },
    (m) => {
      m.profiles.slack.subject.producer.codexVersion = "0.154.0";
    },
  ]) {
    const m = fresh();
    change(m);
    assert.throws(() => selected(m));
  }
});

test("duplicate JSON keys, unsafe numeric tokens, invalid Unicode and depth overflow reject", () => {
  for (const input of [
    '{"x":1,"x":2}',
    '{"x":9007199254740993}',
    '{"x":1.0000000000000001}',
    '{"x":1e0}',
    '{"x":"\\ud800"}',
    "[".repeat(34) + "0" + "]".repeat(34),
    "{} trailing",
  ])
    assert.throws(() => parseJson(input));
  assert.throws(() => parseJson(Buffer.from([0xff])));
  assert.throws(() => parseJson(Buffer.alloc(LIMITS.jsonBytes + 1)));
  assert.equal(
    parseJson('{"duration_seconds":0.25}', { integersOnly: false }).duration_seconds,
    0.25,
  );
  assert.throws(() => parseJson('{"exit_code":1.0000000000000001}', { integersOnly: false }));
});

test("missing quiet capability remains explicit and unsupported purpose is rejected", async () => {
  const m = fixture();
  const result = await verifyArtifacts(root, m);
  assert.equal(result.artifactChecks.find((c) => c.id === "quiet-capability").outcome, "missing");
  assert.ok(result.issues.includes("quiet-capability-unqualified"));
  assert.equal(result.runtimeQualified, false);
  const changed = fresh();
  changed.quiet.purpose = "serving";
  assert.throws(() => selected(changed));
});

test("supported declarations must be complete, unique and bound to declaration/closure roles", () => {
  for (const change of [
    (m) => {
      m.declarations.pop();
    },
    (m) => {
      m.declarations[0].import = "openclaw/src/internal";
    },
    (m) => {
      m.declarations[0].artifactId = "native";
    },
    (m) => {
      m.declarations[0].dependencyArtifactIds = ["missing-private-workspace"];
    },
  ]) {
    const m = fresh();
    change(m);
    assert.throws(() => selected(m));
  }
});

test("existing packager verifies actual fixture archive bytes and graph without an install", async () => {
  const result = await verifyArtifacts(root, fixture());
  assert.equal(result.prepared.outcome, "pass");
  assert.equal(result.prepared.detail.archiveMembersVerified, false);
  assert.equal(result.prepared.detail.installedClosureVerified, false);
  assert.equal(
    result.artifactChecks.filter((c) => c.id.startsWith("archive-") && c.outcome === "pass").length,
    5,
  );
  assert.equal(
    result.declarations.every((d) => d.compiled === false),
    true,
  );
});

test("same-label archive byte corruption fails independent file and context checks", async (t) => {
  assert.ok(process.env.OCE_TEST_OUTPUT_ROOT, "select the task-private fixture output root");
  const temp = await mkdtemp(join(process.env.OCE_TEST_OUTPUT_ROOT, "fixture-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await cp(root, temp, { recursive: true });
  const path = join(temp, "prepared-context/artifacts/openclaw.tgz");
  const data = await readFile(path);
  data[data.length - 1] ^= 1;
  await writeFile(path, data);
  const result = await verifyArtifacts(temp, fixture());
  assert.equal(result.artifactChecks.find((c) => c.id === "archive-openclaw").outcome, "fail");
  assert.equal(result.prepared.outcome, "blocked");
});

test("path traversal, duplicate artifact path and missing file stay explicit", async () => {
  for (const path of ["../private", "/absolute", "a//b", "a/./b", "a/../../b", "a\\b"]) {
    const m = fresh();
    m.artifacts[0].path = path;
    assert.throws(() => selected(m));
  }
  const m = fresh();
  m.artifacts[0].path = m.artifacts[1].path;
  assert.throws(() => selected(m));
  const other = fresh();
  other.artifacts[0].path = "absent.json";
  assert.equal((await verifyArtifacts(root, selected(other))).artifactChecks[0].outcome, "missing");
});

test("canonical context rejects whitespace, content/digest change and unsafe counter", async () => {
  const b = await readFile(join(root, "canonical-context.utf8"));
  const expected = fixture().canonicalContext;
  assert.equal(validateCanonicalContext(b, expected).canonical, true);
  assert.throws(() => validateCanonicalContext(Buffer.concat([b, Buffer.from("\n")]), expected));
  assert.throws(() => validateCanonicalContext(b, { ...expected, sha256: "1".repeat(64) }));
  assert.throws(() =>
    validateCanonicalContext(
      Buffer.from(b.toString().replace('"ordinal":0', '"ordinal":9007199254740993')),
      expected,
    ),
  );
});

test("missing public quiet schema cannot be replaced by a fictional positive descriptor", async () => {
  const m = fresh();
  m.quiet.expectedReceipt = { schemaVersion: 1, quiet: true };
  assert.throws(() => selected(m));
  const result = await verifyArtifacts(root, fixture());
  assert.equal(result.quiet.outcome, "blocked");
  assert.equal(result.quiet.detail.receiptSchemaVerified, false);
});

test("inert plan retains every missing required command and exact endpoints", () => {
  const plan = preparePlan(fixture(), selectedDigest);
  assert.equal(plan.execution, "external-maintained-runner-only");
  assert.equal(plan.automaticRetry, false);
  assert.equal(
    plan.cases.filter((c) => c.required).every((c) => c.initialOutcome === "blocked"),
    true,
  );
  assert.equal(
    plan.cases.filter((c) => !c.required).every((c) => c.initialOutcome === "unselected"),
    true,
  );
});

test("undeclared environment cannot pass caller binding or command selection", async () => {
  const m = fresh();
  m.cases[0].command = {
    state: "supplied",
    argv: ["node", "fixture"],
    cwdRef: "/fictional",
    artifactRootRef: "/fictional",
    executableDigest: "a".repeat(64),
    inputIds: ["prepared"],
    environmentNames: ["UNDECLARED"],
    expectedExit: 0,
  };
  assert.throws(() => selected(m));
  assert.ok(
    (
      await verifyArtifacts(root, fixture(), [{ name: "UNDECLARED", sha256: "b".repeat(64) }])
    ).issues.includes("environment-binding-mismatch"),
  );
});

test("missing required browser group, changed measurement endpoints and removed warmups reject", () => {
  for (const change of [
    (m) => {
      m.cases = m.cases.filter((c) => !c.id.startsWith("B3."));
    },
    (m) => {
      m.cases.find((c) => c.measurement).measurement.endpoints[0] = "post-authorization";
    },
    (m) => {
      m.profiles.slack.cases[0].warmupPerCycle = -1;
    },
  ]) {
    const m = fresh();
    change(m);
    assert.throws(() => selected(m));
  }
});

test("empty attempts retain required blocked cases and optional unselected denominator", async () => {
  const result = collectResults(
    fixture(),
    selectedDigest,
    await readFile(join(root, "receipts.json")),
  );
  assert.equal(result.counts.expected, fixture().cases.length);
  assert.equal(result.counts.blocked, REQUIRED_CASES.length);
  assert.equal(result.counts.unselected, 3);
  assert.equal(result.allRequiredReportedPass, false);
});

test("command success requires matching durable records and case evidence", () => {
  const m = selectable();
  const result = collect(m, [attempt(m)]);
  assert.equal(result.cases.find((c) => c.id === "preparation.context").outcome, "pass");
  assert.equal(result.attempts[0].rawOutcome, "passed");
  assert.equal(result.attempts[0].rawTestCounts, null);
  assert.equal(result.evidenceAuthenticated, false);
  assert.equal(result.runtimeQualified, false);
});

test("raw failed negative check can match expectation without rewriting raw failure", () => {
  const m = selectable();
  m.cases.find((c) => c.id === "preparation.context").command.expectedExit = 2;
  const result = collect(m, [attempt(m, { rawOutcome: "failed", exit: 2 })]);
  assert.equal(result.attempts[0].rawOutcome, "failed");
  assert.equal(result.attempts[0].rawExit, 2);
  assert.equal(result.cases.find((c) => c.id === "preparation.context").outcome, "pass");
});

test("mandatory declaration/export/closure inputs cannot be omitted, and missing inputs remain representable", () => {
  const m = selectable("preparation.declarations");
  assert.ok(selected(m));
  assert.equal(
    preparePlan(selected(m), digest(bytes(m))).cases.find(
      (c) => c.id === "preparation.declarations",
    ).initialOutcome,
    "blocked",
  );
  for (const id of m.cases.find((c) => c.id === "preparation.declarations").inputIds) {
    const changed = structuredClone(m);
    const c = changed.cases.find((c) => c.id === "preparation.declarations");
    c.inputIds = c.inputIds.filter((aid) => aid !== id);
    c.command.inputIds = c.inputIds;
    assert.throws(() => selected(changed));
  }
  assert.notEqual(
    collect(m, [attempt(m, { caseId: "preparation.declarations" })]).cases.find(
      (c) => c.id === "preparation.declarations",
    ).outcome,
    "pass",
  );
});

test("opaque supplied quiet artifacts and a passing assertion cannot override unavailable receiver", () => {
  const m = selectable("preparation.quiet");
  for (const id of ["quiet-capability", "quiet-receipt"])
    Object.assign(
      m.artifacts.find((a) => a.id === id),
      {
        state: "supplied",
        path: `${id}.json`,
        bytes: 2,
        sha256: digest(Buffer.from("{}")),
        reason: null,
      },
    );
  assert.equal(
    preparePlan(selected(m), digest(bytes(m))).cases.find((c) => c.id === "preparation.quiet")
      .initialOutcome,
    "blocked",
  );
  const result = collect(m, [attempt(m, { caseId: "preparation.quiet" })]);
  assert.equal(result.cases.find((c) => c.id === "preparation.quiet").outcome, "blocked");
});

test("contradictory raw exit labels and launch/leader facts reject before case reconciliation", () => {
  for (const [rawOutcome, exit] of [
    ["failed", 0],
    ["passed", 2],
  ]) {
    const m = selectable();
    m.cases.find((c) => c.id === "preparation.context").command.expectedExit = exit;
    assert.throws(() => collect(m, [attempt(m, { rawOutcome, exit })]));
  }
  for (const mutate of [
    (t) => {
      t.leader_exit_observed = false;
    },
    (t) => {
      t.command_launched = false;
    },
    (t) => {
      t.pid = null;
    },
    (t) => {
      t.settlement = "leader-unresolved";
    },
  ]) {
    const m = selectable();
    const a = attempt(m);
    reviseRecord(a, "terminal", mutate);
    assert.throws(() => collect(m, [a]));
  }
});

test("after-only executable changes or unstable reads cannot agree with unchanged provenance", () => {
  for (const mutate of [
    (p) => {
      p.executable.physical_entry.sha256 = "f".repeat(64);
    },
    (p) => {
      p.executable.physical_entry.stable_during_read = false;
    },
    (p) => {
      p.executable.physical_entry.kind = "symlink";
    },
    (p) => {
      p.executable.resolved = "/different/node";
    },
  ]) {
    const m = selectable();
    const a = attempt(m);
    reviseRecord(a, "receipt", (r) => mutate(r.provenance_after));
    assert.equal(
      collect(m, [a]).cases.find((c) => c.id === "preparation.context").outcome,
      "unknown",
    );
  }
});

test("identical content at a different provenance path cannot replace the selected file", () => {
  for (const mutate of [
    (p) => {
      p.source.entries[0].path = "unrelated-copy.utf8";
    },
    (p) => {
      p.source.root = "/different/root";
    },
  ]) {
    const m = selectable();
    const a = attempt(m);
    reviseRecord(a, "sourceBefore", (s) => mutate(s.provenance_before));
    reviseRecord(a, "receipt", (r) => {
      mutate(r.provenance_before);
      mutate(r.provenance_after);
    });
    assert.equal(
      collect(m, [a]).cases.find((c) => c.id === "preparation.context").outcome,
      "unknown",
    );
  }
});

test("explicit artifact root maps a selected dependency or configuration file outside command cwd", () => {
  for (const group of ["dependencies", "configuration"]) {
    const m = selectable();
    m.cases.find((c) => c.id === "preparation.context").command.artifactRootRef =
      "/fictional/artifacts";
    const a = attempt(m);
    const move = (p) => {
      const entry = p.source.entries[0];
      p[group].roots = [
        {
          absolute: `/fictional/artifacts/${entry.path}`,
          entries: [{ ...entry, path: "." }],
          inventory_complete: true,
        },
      ];
      p.source = { root: "/fictional/work", entries: [], inventory_complete: true };
    };
    reviseRecord(a, "sourceBefore", (s) => move(s.provenance_before));
    reviseRecord(a, "receipt", (r) => {
      move(r.provenance_before);
      move(r.provenance_after);
    });
    assert.equal(collect(m, [a]).cases.find((c) => c.id === "preparation.context").outcome, "pass");
  }
});

function measuredFixture() {
  const caseId = "slack.startup-ready";
  const m = selectable(caseId);
  // Fictional data only: this creates no receiver, process, installed tuple or measured evidence.
  for (const a of m.artifacts.filter((a) => a.state === "missing"))
    Object.assign(a, {
      state: "supplied",
      path: `fictional-${a.id}.json`,
      bytes: 2,
      sha256: digest(Buffer.from("{}")),
      reason: null,
    });
  const p = m.profiles.slack;
  const roles = {
    declarations: "declarations",
    exports: "exports",
    package: "archive",
    dependencyClosure: "dependency-closure",
    nativeExecutable: "native-executable",
    gatewayImage: "gateway-image",
    effectiveConfiguration: "configuration",
    capabilities: "quiet-capability",
    toolchain: "toolchain",
    producerReceipt: "producer-receipt",
  };
  for (const [key, role] of Object.entries(roles))
    p.subject.artifacts[key] = {
      state: "known",
      digest: m.artifacts.find((a) => a.role === role).sha256,
    };
  p.resourceProfile.observed = {
    state: "observed",
    effectiveConfigurationDigest: p.subject.artifacts.effectiveConfiguration.digest,
    bindingDigest: "e".repeat(64),
    nativeMappingDigest: "f".repeat(64),
    roles: structuredClone(p.resourceProfile.expectation.roles),
  };
  const c = p.cases.find((c) => c.id === "startup-ready");
  const samples = [];
  for (let cycle = 0; cycle < c.cycles; cycle++)
    for (const phase of ["warmup", "measured"])
      for (
        let index = 0;
        index < (phase === "warmup" ? c.warmupPerCycle : c.samplesPerCycle);
        index++
      )
        samples.push({
          cycle,
          phase,
          index,
          startUs: 1000,
          endUs: 1001,
          clockOriginRef: p.clock.originRef,
          evidenceRef: `fictional:${cycle}/${phase}/${index}`,
          workload: {
            inputUtf8Bytes: p.workload.inputUtf8Bytes,
            resultUtf8Bytes: p.workload.resultUtf8Bytes,
            outputCaptureBytes: 4096,
            overflow: false,
          },
          state: "latency",
          endpoint: "observed",
          domainOutcome: "confirmed",
        });
  const report = {
    format: "native-measurement-results-v1",
    profileDigest: nativeMeasurementProfileDigestV1(p).value,
    subject: structuredClone(p.subject),
    evidenceKind: "fixture",
    discovered: p.cases.map((c) => c.id),
    selected: ["startup-ready"],
    records: [{ id: "startup-ready", state: "samples", samples }],
  };
  const content = JSON.stringify(report);
  const supplied = { content, sha256: digest(Buffer.from(content)) };
  return { m, caseId, report, supplied };
}

test("measurement report digest must join the exact original attempt case log", () => {
  const { m, caseId, supplied, report } = measuredFixture();
  const a = attempt(m, {
    caseId,
    measurement: { channel: "slack", reportDigest: supplied.sha256 },
  });
  const b = observations(m, [a]);
  b.measurements.slack = supplied;
  const run = () => collectResults(selected(m), digest(bytes(m)), bytes(b));
  assert.equal(run().cases.find((c) => c.id === caseId).outcome, "pass");
  report.records[0].samples[0].evidenceRef = "fictional:another-execution";
  const different = JSON.stringify(report);
  b.measurements.slack = { content: different, sha256: digest(Buffer.from(different)) };
  assert.equal(run().cases.find((c) => c.id === caseId).outcome, "unknown");
  b.measurements.slack = supplied;
  b.attempts = [attempt(m, { caseId })];
  assert.equal(run().cases.find((c) => c.id === caseId).outcome, "unknown");
  b.attempts = [
    attempt(m, { caseId, measurement: { channel: "teams", reportDigest: supplied.sha256 } }),
  ];
  assert.equal(run().cases.find((c) => c.id === caseId).outcome, "unknown");
  b.measurements.slack = { ...supplied, sha256: "f".repeat(64) };
  assert.throws(run);
});

test("launch failure, timeout, cancellation and incomplete output are not retries or passes", () => {
  for (const [rawOutcome, expected] of [
    ["launch_error", "setup-failed"],
    ["timed_out", "timed-out"],
    ["cancelled", "cancelled"],
    ["incomplete", "incomplete"],
  ]) {
    const m = selectable();
    const result = collect(m, [
      attempt(m, { rawOutcome, exit: rawOutcome === "launch_error" ? null : 1 }),
    ]);
    assert.equal(result.cases.find((c) => c.id === "preparation.context").outcome, expected);
    assert.equal(result.automaticRetry, false);
  }
});

test("missing wrapper or caller completion cannot turn a passed command into completed evidence", () => {
  for (const key of ["wrapper", "callerReturn"]) {
    const m = selectable();
    const a = attempt(m);
    a[key] = null;
    assert.equal(
      collect(m, [a]).cases.find((c) => c.id === "preparation.context").outcome,
      "incomplete",
    );
  }
});

test("absent terminal and missing wrapper receipt binding remain incomplete or missing", () => {
  const m = selectable();
  const a = attempt(m);
  a.terminal = null;
  assert.equal(
    collect(m, [a]).cases.find((c) => c.id === "preparation.context").outcome,
    "missing",
  );
  const other = attempt(m);
  const wrapper = JSON.parse(other.wrapper.content);
  wrapper.receipt_record = null;
  other.wrapper.content = JSON.stringify(wrapper);
  assert.equal(
    collect(m, [other]).cases.find((c) => c.id === "preparation.context").outcome,
    "incomplete",
  );
});

test("internally consistent provenance must still contain each independently selected input digest", () => {
  const m = selectable();
  const a = attempt(m);
  const change = (p) => {
    p.source.entries[0].sha256 = "f".repeat(64);
  };
  reviseRecord(a, "sourceBefore", (s) => change(s.provenance_before));
  reviseRecord(a, "receipt", (r) => {
    change(r.provenance_before);
    change(r.provenance_after);
  });
  assert.equal(
    collect(m, [a]).cases.find((c) => c.id === "preparation.context").outcome,
    "unknown",
  );
});

test("complete reporter count without case identities does not prove selected case execution", () => {
  const m = selectable();
  const a = attempt(m);
  a.log.content = "TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0\n";
  reviseRecord(a, "receipt", (r) => {
    r.log.sha256 = digest(Buffer.from(a.log.content));
    r.log.bytes = Buffer.byteLength(a.log.content);
    r.test_counts = { tests: 0, pass: 0, fail: 0 };
  });
  const result = collect(m, [a]);
  assert.equal(result.cases.find((c) => c.id === "preparation.context").outcome, "incomplete");
  assert.equal(result.attempts[0].rawTestCounts.tests, 0);
});

test("canonical snapshot closed item schema rejects extras and attachments", async () => {
  const b = await readFile(join(root, "canonical-context.utf8"));
  for (const change of [
    (c) => {
      c.items[0].unexpected = true;
    },
    (c) => {
      c.attachmentRefs.push("attachment/fixture");
    },
    (c) => {
      c.items[0].kind = "partial-token";
    },
  ]) {
    const c = JSON.parse(b);
    change(c);
    const raw = Buffer.from(canonical(c));
    assert.throws(() =>
      validateCanonicalContext(raw, { ...fixture().canonicalContext, sha256: digest(raw) }),
    );
  }
});

test("unknown settlement preserves unknown despite command and assertion success", () => {
  const m = selectable();
  const result = collect(m, [attempt(m, { settlement: "unknown" })]);
  assert.equal(result.cases.find((c) => c.id === "preparation.context").outcome, "unknown");
  assert.equal(result.attempts[0].descendantTerminationVerified, null);
});

test("raw record tampering and conflicting attempt/command identities reject", () => {
  for (const change of [
    (a) => {
      a.log.content += "tampered";
    },
    (a) => {
      a.terminal.content = a.terminal.content.replace('"exit_code":0', '"exit_code":2');
    },
    (a) => {
      a.id = "different-attempt";
    },
    (a) => {
      a.intent.content = a.intent.content.replace("fixture-check", "different-check");
    },
  ]) {
    const m = selectable();
    const a = attempt(m);
    change(a);
    assert.throws(() => collect(m, [a]));
  }
});

test("case selection cannot omit required discovery or select two attempts for one case", () => {
  const m = selectable();
  const b = observations(m);
  b.discovered = b.discovered.filter((id) => id !== "B1.effective-configuration");
  b.selected = b.selected.filter((id) => id !== "B1.effective-configuration");
  assert.equal(
    collectResults(selected(m), digest(bytes(m)), bytes(b)).cases.find(
      (c) => c.id === "B1.effective-configuration",
    ).outcome,
    "missing",
  );
  assert.throws(() => collect(m, [attempt(m), attempt(m)]));
});

test("measurement results from another selected profile cannot be pooled", () => {
  const m = selectable();
  const b = observations(m);
  b.measurements.slack = { format: "native-measurement-results-v1", profileDigest: "f".repeat(64) };
  assert.throws(() => collectResults(selected(m), digest(bytes(m)), bytes(b)));
});

test("CLI verifies selection and writes no output unless explicitly requested", async () => {
  const plan = JSON.parse(
    await main([
      "plan",
      "--root",
      root,
      "--manifest",
      "manifest.json",
      "--expected",
      selectedDigest,
    ]),
  );
  assert.equal(plan.schema, "oce.isolated-upstream-plan/v1");
  await assert.rejects(
    main(["plan", "--root", root, "--manifest", "manifest.json", "--expected", "f".repeat(64)]),
  );
  await assert.rejects(
    main(["execute", "--root", root, "--manifest", "manifest.json", "--expected", selectedDigest]),
  );
  assert.equal(
    (await loadManifest(root, "manifest.json", selectedDigest)).schema,
    fixture().schema,
  );
  await assert.rejects(readArtifact(root, "../manifest.json"));
});
