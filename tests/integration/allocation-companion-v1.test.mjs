import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, symlink, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ACCEPTANCE_LEAVES_V1,
  ACCEPTANCE_VECTORS_V1,
} from "@openclaw-enterprise/contracts/acceptance-companion-v1";
import {
  digestAcceptanceBytesV1,
  decodeProducerReceiptV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-codec-v1";
import { fixture, attempt, encode } from "../fixtures/allocation-companion-v1/fixtures.ts";
import { consumeOriginalBytes } from "../fixtures/allocation-companion-v1/consumer.ts";
import {
  readAllocationRunV1,
  parseAllocationJsonV1,
  ALLOCATION_RUN_LIMITS_V1,
} from "../../scripts/release-evidence/allocation-companion-v1/reader.ts";
import {
  buildAllocationReportV1,
  encodeAllocationReportV1,
} from "../../scripts/release-evidence/allocation-companion-v1/report.ts";
import { readAllocationFileV1 } from "../../scripts/release-evidence/allocation-companion-v1/cli.mjs";

const json = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
const one = (id = "R1-outside-install") => fixture([id]);
const codes = (read) => read.structuralIssues.map((issue) => issue.code);
const modifyCompanion = (input, mutate, select = false) => {
  const value = json(input.companions[0]);
  mutate(value);
  input.companions[0] = encode(value);
  if (select) {
    const selection = json(input.selection);
    selection.plans[0].companion = digestAcceptanceBytesV1("companion", input.companions[0]);
    input.selection = encode(selection);
  }
};
const modifyReceipt = (input, mutate, mapAttempt = true) => {
  const value = json(input.receipts[0]);
  mutate(value);
  input.receipts[0] = encode(value);
  if (mapAttempt) input.attempts[0] = encode(attempt(value, "synthetic-attempt-0"));
};

test("complete synthetic inventory preserves every denominator and remains unauthenticated", () => {
  const input = fixture();
  const read = readAllocationRunV1(input);
  assert.deepEqual(read.structuralIssues, []);
  assert.deepEqual(read.completenessIssues, []);
  const report = buildAllocationReportV1(input);
  assert.equal(report.inventoryCompleteness, "complete");
  assert.deepEqual(
    [
      report.counts.expectedLeaves,
      report.counts.requiredLeaves,
      report.counts.optionalLeaves,
      report.counts.parentAssertionPairs,
      report.counts.registryCases,
      report.counts.gates,
      report.counts.demonstrations,
      report.counts.vectors,
      report.counts.handoffs,
    ],
    [324, 321, 3, 63, 20, 16, 66, 49, 9],
  );
  assert.equal(report.counts.channels.slack.required, 66);
  assert.equal(report.counts.channels.teams.required, 65);
  assert.equal(report.counts.channels.none.required, 190);
  assert.equal(report.counts.declaredAttempts, 324);
  assert.equal(report.counts.decodedReceipts, 324);
  assert.equal(report.counts.requiredDeclaredOutcomes.pass, 321);
  assert.equal(report.counts.requiredLiveOutcomes.unrun, 321);
  assert.equal(report.authentication, "unverified");
  assert.equal(report.authenticAcceptance, "not-established");
  assert.equal(report.outsideActivity, "unknown");
  assert.equal(
    report.demonstrations.filter((demo) => demo.applicability === "not_applicable")[0].id,
    "TEAMS-15",
  );
  assert.equal(
    report.demonstrations.find((demo) => demo.id === "TEAMS-14").applicability,
    "required",
  );
  assert.ok(
    report.gates.find((gate) => gate.id === "R10").requiredLeafIds.includes("R4-restore-r01"),
  );
  assert.equal(json(encodeAllocationReportV1(report)).leaves.length, 324);
});

test("empty and partial runs retain all expected missing leaves and broad parent pairs", () => {
  const report = buildAllocationReportV1(fixture([]));
  assert.equal(report.structuralValidity, "valid");
  assert.equal(report.inventoryCompleteness, "incomplete");
  assert.equal(report.leaves.length, 324);
  assert.equal(report.counts.requiredLiveOutcomes.unrun, 321);
  assert.equal(
    new Set(report.parents.map((parent) => `${parent.caseId}/${parent.assertionId}`)).size,
    63,
  );
  assert.ok(report.leaves.every((leaf) => leaf.companionIdentity === null));
});

test("actual exported strict consumer decodes and binds original receipt bytes", () => {
  const input = one();
  const result = consumeOriginalBytes(input, input.companions[0], input.receipts[0]);
  assert.equal(result.joined.ok, true);
  assert.equal(result.authentication, "unverified");
  assert.equal(json(result.bytes).counts.declaredAttempts, 1);
});

for (const [name, mutate, code] of [
  [
    "unknown leaf",
    (value) => {
      value.leaf.id = "R1-invented";
    },
    "invalid-shape",
  ],
  [
    "wrong parent assertion",
    (value) => {
      value.leaf.parentAssertionId = "private-dependency";
    },
    "metadata-mismatch",
  ],
  [
    "wrong parent case",
    (value) => {
      value.leaf.parentCaseId = "r2-revisions";
    },
    "invalid-shape",
  ],
  [
    "missing demo applicability",
    (value) => {
      value.demoApplicability.pop();
    },
    "invalid-shape",
  ],
  [
    "duplicate demo applicability",
    (value) => {
      value.demoApplicability[1] = value.demoApplicability[0];
    },
    "metadata-mismatch",
  ],
  [
    "unreviewed Teams exception",
    (value) => {
      value.demoApplicability.find((row) => row.demoCaseId === "TEAMS-15").review = null;
    },
    "metadata-mismatch",
  ],
  [
    "additional Teams waiver",
    (value) => {
      value.demoApplicability.find((row) => row.demoCaseId === "TEAMS-14").applicability =
        "not_applicable";
    },
    "metadata-mismatch",
  ],
])
  test(`rejects ${name} through real decoder`, () => {
    const input = one();
    modifyCompanion(input, mutate);
    assert.ok(codes(readAllocationRunV1(input)).includes(code));
  });

test("duplicate companions, receipts and selected plans are rejected", () => {
  for (const field of ["companions", "receipts"]) {
    const input = one();
    input[field].push(input[field][0]);
    assert.ok(
      codes(readAllocationRunV1(input)).includes(
        `duplicate-${field === "companions" ? "companion" : "receipt"}`,
      ),
    );
  }
  const input = one();
  const selected = json(input.selection);
  selected.plans.push(selected.plans[0]);
  input.selection = encode(selected);
  assert.ok(codes(readAllocationRunV1(input)).includes("duplicate-plan"));
});

test("ordered substeps and every vector slot survive; incomplete and reordered plans fail", () => {
  const input = one("R1-example-slack");
  modifyCompanion(input, (value) => {
    value.demonstrations[0].substeps[0].order = 2;
  });
  assert.ok(codes(readAllocationRunV1(input)).includes("metadata-mismatch"));
  for (const mutate of [
    (value) => value.vectors[0].requiredByGates.pop(),
    (value) => value.vectors[0].subchecks.pop(),
  ]) {
    const vector = one("R4-restore-r01");
    modifyCompanion(vector, mutate);
    assert.ok(readAllocationRunV1(vector).structuralIssues.length > 0);
  }
  const report = buildAllocationReportV1(one("R4-restore-r01"));
  assert.deepEqual(
    report.vectors.find((vector) => vector.id === "R01").requiredByGates,
    ACCEPTANCE_VECTORS_V1.R01.requiredByGates,
  );
  assert.deepEqual(
    report.leaves
      .find((leaf) => leaf.id === "R4-restore-r01")
      .vectors[0].subchecks.map((check) => check.slot),
    ["stimulus", "requiredResult", "sourceProofLane"],
  );
});

for (const field of [
  "runId",
  "inputManifest",
  "demonstrationInputs",
  "limits",
  "tuple",
  "handoffs",
  "procedure",
])
  test(`rejects changed selected ${field}`, () => {
    const input = one();
    modifyCompanion(
      input,
      (value) => {
        if (field === "runId") value.runId = "different-run";
        else if (field === "demonstrationInputs") value.demonstrationInputs.reverse();
        else if (field === "handoffs") value.handoffs.E9.sha256 = "a".repeat(64);
        else value[field].sha256 = "a".repeat(64);
      },
      true,
    );
    assert.ok(codes(readAllocationRunV1(input)).includes("selected-input-mismatch"));
  });

test("absent reviewed procedure is missing/unrun without a invented companion identity", () => {
  const input = one();
  const selection = json(input.selection);
  selection.plans[0].procedureReview = null;
  input.selection = encode(selection);
  const report = buildAllocationReportV1(input);
  const leaf = report.leaves.find((row) => row.id === "R1-outside-install");
  assert.equal(leaf.companionIdentity, null);
  assert.equal(leaf.diagnosticOutcome, "unrun");
  assert.equal(report.inventoryCompleteness, "incomplete");
});

test("partial primary checks and supporting-only receipts never supply complete leaf coverage", () => {
  const input = one();
  modifyReceipt(input, (value) => {
    value.outcome = "unknown";
    value.checks = [];
  });
  let report = buildAllocationReportV1(input);
  assert.equal(report.leaves[0].inventoryComplete, false);
  modifyReceipt(input, (value) => {
    value.role = "supporting";
    value.producer = "P-AUD";
  });
  report = buildAllocationReportV1(input);
  assert.equal(report.leaves[0].primaryReceiptIds.length, 0);
  assert.equal(report.leaves[0].supportingReceiptIds.length, 1);
  assert.equal(report.leaves[0].diagnosticOutcome, "unrun");
});

test("one channel and optional rows cannot replace the separate required Teams inventory", () => {
  const ids = Object.entries(ACCEPTANCE_LEAVES_V1)
    .filter(([, leaf]) => leaf.channel === "slack" || !leaf.required)
    .map(([id]) => id);
  const report = buildAllocationReportV1(fixture(ids));
  assert.equal(report.counts.channels.teams.required, 65);
  assert.equal(report.counts.channels.teams.liveOutcomes.unrun, 65);
  assert.equal(report.inventoryCompleteness, "incomplete");
});

test("receipt history and observation reuse do not create another attempt", () => {
  const input = one();
  const first = json(input.receipts[0]);
  const second = structuredClone(first);
  second.receiptId = "synthetic-receipt-next";
  second.previousReceipt = digestAcceptanceBytesV1("receipt", input.receipts[0]);
  second.reuse = {
    originalReceipt: second.previousReceipt,
    originalObservedAt: first.execution.started.observedAt,
    rationale: digestAcceptanceBytesV1("review", encode({ synthetic: "reuse" })),
  };
  input.receipts.push(encode(second));
  const declaration = json(input.attempts[0]);
  declaration.receiptIds.push(second.receiptId);
  input.attempts[0] = encode(declaration);
  const report = buildAllocationReportV1(input);
  assert.deepEqual(report.structuralIssues, []);
  assert.equal(report.counts.decodedReceipts, 2);
  assert.equal(report.counts.declaredAttempts, 1);
  assert.equal(report.counts.receiptsReusingObservations, 1);
  assert.ok(report.counts.repeatedEvidenceReferences > 0);
  input.attempts.push(encode(attempt(second, "false-second-attempt")));
  assert.ok(codes(readAllocationRunV1(input)).includes("receipt-attempt-collision"));
});

test("genuine distinct attempts and earlier failed receipts remain visible after success", () => {
  const input = one();
  modifyReceipt(input, (receipt) => {
    receipt.outcome = "fail";
    receipt.checks[0].outcome = "fail";
  });
  const prior = json(input.receipts[0]);
  const next = structuredClone(prior);
  next.receiptId = "synthetic-next";
  next.previousReceipt = digestAcceptanceBytesV1("receipt", input.receipts[0]);
  next.outcome = "pass";
  next.checks[0].outcome = "pass";
  next.execution.started.observedAt = "2026-01-01T00:00:00.001Z";
  next.execution.ended.observedAt = next.execution.started.observedAt;
  input.receipts.push(encode(next));
  const nextAttempt = attempt(next, "synthetic-next-attempt");
  nextAttempt.originalAttemptId = "synthetic-attempt-0";
  input.attempts.push(encode(nextAttempt));
  const report = buildAllocationReportV1(input);
  assert.deepEqual(report.structuralIssues, []);
  assert.equal(report.counts.declaredAttempts, 2);
  assert.equal(report.counts.receiptOutcomes.fail, 1);
  assert.equal(report.counts.receiptOutcomes.pass, 1);
  assert.equal(report.leaves[0].declaredOutcome, "fail");
  assert.equal(report.attempts[1].value.originalAttemptId, "synthetic-attempt-0");
});

test("duplicate and contradictory attempts reject; missing history remains explicit", () => {
  const input = one();
  input.attempts.push(input.attempts[0]);
  assert.ok(codes(readAllocationRunV1(input)).includes("duplicate-attempt"));
  input.attempts.pop();
  const value = json(input.attempts[0]);
  value.execution.executorRef = "contradiction";
  input.attempts[0] = encode(value);
  assert.ok(codes(readAllocationRunV1(input)).includes("attempt-execution-conflict"));
  const missing = one();
  modifyReceipt(missing, (receipt) => {
    receipt.previousReceipt = digestAcceptanceBytesV1("receipt", encode({ absent: true }));
  });
  assert.ok(
    readAllocationRunV1(missing).completenessIssues.some(
      (issue) => issue.code === "previous-receipt-unavailable",
    ),
  );
});

test("all seven outcomes, missing collection and null remain separate", () => {
  for (const outcome of [
    "pass",
    "fail",
    "blocked",
    "skipped",
    "unrun",
    "unknown",
    "not_applicable",
    null,
  ]) {
    const id =
      outcome === "not_applicable"
        ? Object.keys(ACCEPTANCE_LEAVES_V1).find((id) => !ACCEPTANCE_LEAVES_V1[id].required)
        : "R1-outside-install";
    const input = one(id);
    modifyReceipt(
      input,
      (receipt) => {
        receipt.outcome = outcome;
        if (["unrun", "skipped", null].includes(outcome)) {
          receipt.execution = { state: "unrun" };
          input.attempts = [];
        }
        if (outcome === null) {
          receipt.collection = "missing";
          receipt.result = { state: "missing" };
          receipt.checks = [];
          receipt.observations = [];
        }
      },
      false,
    );
    if (!input.attempts.length) {
    } else input.attempts = [encode(attempt(json(input.receipts[0]), "synthetic-attempt-0"))];
    const report = buildAllocationReportV1(input);
    assert.deepEqual(report.structuralIssues, []);
    if (outcome === null) {
      assert.equal(report.counts.missingCollection, 1);
      assert.equal(report.counts.nullOutcomes, 1);
      assert.equal(report.counts.receiptOutcomes.unrun, 0);
    } else assert.equal(report.counts.receiptOutcomes[outcome], 1);
  }
});

test("rejected collection, redaction, missing review/capture and invalidation cannot make usable pass", () => {
  const input = one();
  modifyReceipt(input, (receipt) => {
    receipt.collection = "rejected";
    receipt.custody.redaction = "rejected";
    receipt.execution.executionClass = "live";
    receipt.invalidation = {
      state: "invalidated",
      replacementInput: digestAcceptanceBytesV1("input", encode({ synthetic: "replacement" })),
      reason: digestAcceptanceBytesV1("review", encode({ synthetic: "invalidation" })),
    };
  });
  const report = buildAllocationReportV1(input);
  const receipt = report.receipts[0];
  assert.equal(report.counts.receiptOutcomes.pass, 1);
  assert.equal(report.counts.rejectedCollection, 1);
  for (const reason of [
    "collection-rejected",
    "redaction-rejected",
    "review-missing",
    "capture-missing",
    "invalidated",
  ])
    assert.ok(receipt.reasons.includes(reason));
  assert.equal(report.leaves[0].diagnosticOutcome, "blocked");
  assert.equal(receipt.evidenceUsability, "unusable");
});

test("current Q1 launched unavailable end stays unknown without an invented duration", () => {
  const input = one();
  modifyReceipt(input, (receipt) => {
    receipt.outcome = "unknown";
    receipt.execution.executionClass = "live";
    receipt.execution.state = "end-unavailable";
    delete receipt.execution.ended;
    delete receipt.execution.monotonicDurationMs;
    delete receipt.execution.monotonicClockRef;
  });
  assert.equal(decodeProducerReceiptV1(input.receipts[0]).ok, true);
  const report = buildAllocationReportV1(input);
  assert.deepEqual(report.structuralIssues, []);
  assert.equal(report.leaves[0].liveOutcome, "unknown");
  assert.equal(report.leaves[0].diagnosticOutcome, "unknown");
  assert.equal(report.receipts[0].declaration.execution.monotonicDurationMs, undefined);
  modifyReceipt(input, (receipt) => {
    receipt.outcome = "pass";
  });
  assert.ok(codes(readAllocationRunV1(input)).includes("inconsistent-receipt"));
});

test("old receipt digest is explicitly refused", () => {
  const input = one();
  modifyReceipt(input, (receipt) => {
    receipt.schemaDigest = "b7964df399d61f90f1c79808e3f68fb6e7f5a1c25c4c37055e903fcd2fdef62a";
  });
  assert.ok(codes(readAllocationRunV1(input)).includes("schema-mismatch"));
});

test("truthful unknown handling does not fill positive physical or revocation leaves", () => {
  const report = buildAllocationReportV1(fixture(["R9-unknown-stop", "R7-unknown-revoke"]));
  assert.equal(
    report.leaves.find((leaf) => leaf.id === "R9-physical-stop").diagnosticOutcome,
    "unrun",
  );
  assert.equal(
    report.leaves.find((leaf) => leaf.id === "R7-confirmed-revoke").diagnosticOutcome,
    "unrun",
  );
  for (const id of ["R9-physical-stop", "R7-confirmed-revoke"]) {
    const input = one(id);
    modifyReceipt(input, (receipt) => {
      receipt.execution.executionClass = "live";
    });
    const result = buildAllocationReportV1(input);
    assert.ok(result.receipts[0].reasons.some((reason) => reason.startsWith("positive-")));
    assert.equal(result.leaves.find((leaf) => leaf.id === id).diagnosticOutcome, "blocked");
  }
});

test("diagnostic gates retain fail then blocked/unknown then skipped then unrun precedence", () => {
  const input = one();
  modifyReceipt(input, (receipt) => {
    receipt.execution.executionClass = "live";
    receipt.outcome = "fail";
  });
  let report = buildAllocationReportV1(input);
  assert.equal(report.gates.find((gate) => gate.id === "R1").outcome, "fail");
  modifyReceipt(input, (receipt) => {
    receipt.outcome = "unknown";
  });
  report = buildAllocationReportV1(input);
  const gate = report.gates.find((gate) => gate.id === "R1");
  assert.equal(gate.outcome, "blocked-or-unknown");
  assert.equal(gate.outcomeCounts.unknown, 1);
  assert.ok(gate.outcomeCounts.unrun > 0);
});

test("artifact original bytes verify exact identity, stale bytes reject and absent originals stay unavailable", () => {
  const input = one();
  const bytes = encode({ synthetic: "input" });
  const identity = digestAcceptanceBytesV1("input", bytes);
  input.artifacts.push({ identity, bytes });
  let report = buildAllocationReportV1(input);
  assert.equal(
    report.artifacts.find((row) => row.identity.domain === "input").integrity,
    "verified-bytes",
  );
  assert.ok(report.artifacts.some((row) => row.integrity === "unavailable"));
  input.artifacts[0].bytes = encode({ synthetic: "stale" });
  assert.ok(codes(readAllocationRunV1(input)).includes("artifact-integrity-mismatch"));
});

test("JSON duplicate keys, invalid UTF-8, deep nesting and finite byte/count/output bounds reject", () => {
  assert.throws(
    () => parseAllocationJsonV1(new TextEncoder().encode('{"a":1,"\\u0061":2}'), 100),
    /duplicate-key/,
  );
  assert.throws(() => parseAllocationJsonV1(new Uint8Array([0xff]), 100));
  assert.throws(
    () =>
      parseAllocationJsonV1(new TextEncoder().encode("[".repeat(20) + "0" + "]".repeat(20)), 100),
    /json-limit/,
  );
  const duplicate = one();
  const text = new TextDecoder().decode(duplicate.receipts[0]);
  duplicate.receipts[0] = new TextEncoder().encode(text.replace("{", '{"runId":"synthetic-run",'));
  assert.ok(codes(readAllocationRunV1(duplicate)).includes("duplicate-key"));
  const tooMany = one();
  tooMany.receipts = new Array(ALLOCATION_RUN_LIMITS_V1.maxRecords + 1).fill(tooMany.receipts[0]);
  assert.ok(codes(readAllocationRunV1(tooMany)).includes("record-limit"));
  const tooLarge = one();
  tooLarge.receipts[0] = new Uint8Array(262_145);
  assert.ok(codes(readAllocationRunV1(tooLarge)).includes("input-size"));
  const aggregate = one();
  aggregate.artifacts = new Array(33).fill({
    identity: digestAcceptanceBytesV1("evidence", encode({ synthetic: "large" })),
    bytes: new Uint8Array(1_048_576),
  });
  assert.ok(codes(readAllocationRunV1(aggregate)).includes("aggregate-limit"));
  assert.throws(
    () => encodeAllocationReportV1(buildAllocationReportV1(one()), 1024),
    /output-limit/,
  );
});

test("explicit CLI handles controlled files, writes exclusive private report and keeps command text inert", async () => {
  const root = await mkdtemp(join(tmpdir(), "allocation-reader-"));
  const input = one();
  const marker = join(root, "never-created");
  const inert = encode({ command: `touch ${marker}`, manualStep: "$(exit 99)" });
  input.artifacts.push({ identity: digestAcceptanceBytesV1("procedure", inert), bytes: inert });
  for (const [name, bytes] of [
    ["selection.json", input.selection],
    ["companion.json", input.companions[0]],
    ["receipt.json", input.receipts[0]],
    ["attempt.json", input.attempts[0]],
    ["procedure.json", inert],
  ])
    await writeFile(join(root, name), bytes);
  const files = {
    schemaVersion: "allocation-run-files/v1",
    selection: "selection.json",
    companions: ["companion.json"],
    receipts: ["receipt.json"],
    attempts: ["attempt.json"],
    artifacts: [{ path: "procedure.json", identity: input.artifacts[0].identity }],
  };
  await writeFile(join(root, "files.json"), encode(files));
  const output = join(root, "report.json");
  const args = [
    "scripts/release-evidence/allocation-companion-v1/cli.mjs",
    "--root",
    root,
    "--files",
    "files.json",
    "--output",
    output,
  ];
  const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /authentication unverified/);
  assert.equal(json(await readFile(output)).leaves.length, 324);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(access(marker));
  assert.equal(spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20_000 }).status, 1);
  await symlink(join(root, "companion.json"), join(root, "linked.json"));
  files.companions = ["linked.json"];
  await writeFile(join(root, "files.json"), encode(files));
  args[args.length - 1] = join(root, "unsafe-report.json");
  assert.equal(spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20_000 }).status, 1);
});

test("missing selected companion cannot erase a known live launch with unavailable end", () => {
  const input = one();
  modifyReceipt(input, (receipt) => {
    receipt.outcome = "unknown";
    receipt.execution.executionClass = "live";
    receipt.execution.state = "end-unavailable";
    delete receipt.execution.ended;
    delete receipt.execution.monotonicDurationMs;
    delete receipt.execution.monotonicClockRef;
    receipt.checks = receipt.checks.map((check) => ({ ...check, outcome: "unknown" }));
  });
  const selected = json(input.selection);
  selected.plans[0].procedureReview = null;
  input.selection = encode(selected);
  const report = buildAllocationReportV1(input);
  assert.equal(report.leaves[0].companionIdentity, null);
  assert.equal(report.leaves[0].liveOutcome, "unknown");
  assert.equal(report.leaves[0].diagnosticOutcome, "unknown");
  assert.equal(report.gates.find((gate) => gate.id === "R1").outcome, "blocked-or-unknown");
  assert.equal(report.attempts[0].value.execution.state, "end-unavailable");
});

test("required live demo and vector subcheck failures retain failure precedence under unknown aggregate", () => {
  for (const [id, kind, gateId] of [
    ["R1-example-slack", "demo-substep", "R1"],
    ["R4-restore-r01", "vector-subcheck", "R10"],
  ]) {
    const input = one(id);
    modifyReceipt(input, (receipt) => {
      receipt.outcome = "unknown";
      receipt.execution.executionClass = "live";
      receipt.checks.find((check) => check.subject.kind === kind).outcome = "fail";
    });
    const report = buildAllocationReportV1(input);
    const leaf = report.leaves.find((leaf) => leaf.id === id);
    assert.equal(leaf.liveOutcome, "unknown");
    assert.equal(leaf.liveSubcheckOutcomeCounts.fail, 1);
    assert.equal(leaf.diagnosticOutcome, "fail");
    assert.ok(leaf.reasons.some((reason) => reason.includes(":check-fail:")));
    assert.equal(report.gates.find((gate) => gate.id === gateId).outcome, "fail");
    assert.equal(report.counts.receiptOutcomes.unknown, 1);
    assert.equal(report.counts.receiptOutcomes.fail, 0);
  }
});

test("standalone attempts validate canonical clocks and preserve cross-domain uncertainty", () => {
  for (const [mutate, code] of [
    [
      (value) => {
        value.execution.started.observedAt = "2026-02-30T00:00:00.000Z";
      },
      "attempt-clock-invalid",
    ],
    [
      (value) => {
        value.execution.ended.observedAt = "2025-12-31T23:59:59.000Z";
      },
      "attempt-clock-order",
    ],
  ]) {
    const input = one();
    input.receipts = [];
    const value = json(input.attempts[0]);
    value.receiptIds = [];
    mutate(value);
    input.attempts[0] = encode(value);
    const read = readAllocationRunV1(input);
    assert.ok(codes(read).includes(code));
    assert.equal(read.attempts.length, 0);
    assert.equal(read.supplied.attempts, 1);
  }
  const input = one();
  input.receipts = [];
  const value = json(input.attempts[0]);
  value.receiptIds = [];
  value.execution.ended.clockRef = "different-clock";
  value.execution.ended.observedAt = "2025-12-31T23:59:59.000Z";
  input.attempts[0] = encode(value);
  const read = readAllocationRunV1(input);
  assert.deepEqual(read.structuralIssues, []);
  assert.equal(read.attempts.length, 1);
});

test("decoded duplicate leaf IDs reject even when neither companion has a reviewed procedure selection", () => {
  const input = one();
  const selected = json(input.selection);
  selected.plans[0].procedureReview = null;
  input.selection = encode(selected);
  const duplicate = json(input.companions[0]);
  duplicate.companionId = "different-companion-id";
  input.companions.push(encode(duplicate));
  assert.ok(codes(readAllocationRunV1(input)).includes("duplicate-companion"));
});

test("CLI retains exact-size owned file buffers instead of each reader's maximum backing size", async () => {
  const root = await mkdtemp(join(tmpdir(), "allocation-buffer-"));
  const bytes = encode({ synthetic: "small" });
  await writeFile(join(root, "small.json"), bytes);
  const loaded = await readAllocationFileV1(
    root,
    "small.json",
    ALLOCATION_RUN_LIMITS_V1.maxArtifactBytes,
  );
  assert.equal(loaded.byteLength, bytes.byteLength);
  assert.equal(loaded.buffer.byteLength, bytes.byteLength);
  assert.equal(loaded.byteOffset, 0);
  assert.deepEqual(loaded, bytes);
});

test("skipped and blocked unrun declarations remain separate gate diagnostics", () => {
  for (const outcome of ["skipped", "blocked"]) {
    const input = one();
    modifyReceipt(
      input,
      (receipt) => {
        receipt.outcome = outcome;
        receipt.execution = { state: "unrun" };
        receipt.checks = [];
      },
      false,
    );
    input.attempts = [];
    const report = buildAllocationReportV1(input);
    const gate = report.gates.find((gate) => gate.id === "R1");
    assert.equal(report.leaves[0].diagnosticOutcome, outcome);
    assert.equal(gate.outcome, outcome === "blocked" ? "blocked-or-unknown" : "skipped");
    assert.equal(gate.outcomeCounts[outcome], 1);
  }
});
