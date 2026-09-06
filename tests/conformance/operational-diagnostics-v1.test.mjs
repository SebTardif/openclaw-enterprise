import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pino from "pino";
import {
  createOperationalDiagnosticsV1,
  OPERATIONAL_DIAGNOSTICS_LIMITS_V1,
} from "../../apps/controller/src/diagnostics/operational-diagnostics-v1.ts";
import { projectSecurityEvent } from "@openclaw-enterprise/contracts/security-events";
import { fixture, scenarios, canaries, hostileAudit } from "../fixtures/security-events/cases.mjs";

// Exercise the actual Pino library with a bounded destination. This is local
// submission behavior, not a Collector, durable audit store or authenticated reader.
function capture(level = "info", write) {
  const records = [];
  const logger = pino(
    { level, base: { service: "occ-api" }, timestamp: pino.stdTimeFunctions.isoTime },
    {
      write(chunk) {
        if (write) return write(chunk);
        assert.ok(records.length < 512, "bounded diagnostic capture");
        records.push(JSON.parse(String(chunk)));
        return true;
      },
    },
  );
  return { records, logger, diagnostics: createOperationalDiagnosticsV1(logger) };
}

function event(overrides = {}) {
  const input = fixture(overrides);
  return projectSecurityEvent(input.audit, input.context);
}

test("an existing projected security event retains source times and only operational correlation", () => {
  const { records, diagnostics } = capture();
  const input = event();
  assert.deepEqual(diagnostics.emitSecurityEvent(input), {
    submitted: 1,
    suppressed: 0,
    failed: 0,
    rejected: 0,
    failureCode: null,
    downstreamDelivery: "unobserved",
  });
  const record = records[0];
  assert.equal(record.event, "diagnostics.security");
  assert.equal(record.securityEventId, input.id);
  assert.equal(record.agentId, input.correlation.agentId);
  assert.equal(record.revisionId, input.correlation.revisionId);
  assert.equal(record.attemptId, input.correlation.attemptId);
  assert.equal(record.requestId, input.requestId);
  assert.equal(record.occurredAt, input.occurredAt);
  assert.equal(record.receivedAt, input.receivedAt);
  assert.equal(record.observedAt, input.observation.observedAt);
  assert.equal(record.observedAtAvailable, true);
  assert.notEqual(record.time, record.observedAt);
  for (const key of [
    "human",
    "workload",
    "conversationId",
    "channelEventId",
    "grantId",
    "policyId",
    "resource",
    "details",
    "credential",
    "actorId",
  ])
    assert.equal(
      Object.hasOwn(record, key),
      false,
      "protected fields do not enter the operational copy",
    );
  assert.ok(
    Buffer.byteLength(JSON.stringify(record)) < OPERATIONAL_DIAGNOSTICS_LIMITS_V1.maxPayloadBytes,
  );
});

test("all original security-event scenarios preserve their supplied decisions and unknown outcomes", () => {
  const { records, diagnostics } = capture();
  for (const scenario of scenarios) {
    const input = event(scenario.context);
    const result = diagnostics.emitSecurityEvent(input);
    assert.equal(result.submitted, 1);
    const record = records.at(-1);
    for (const key of [
      "source",
      "category",
      "action",
      "decision",
      "phase",
      "result",
      "reasonCode",
      "occurredAt",
      "receivedAt",
    ])
      assert.equal(record[key], input[key]);
    assert.equal(record.observedAt, input.observation?.observedAt ?? null);
    assert.equal(record.observedAtAvailable, input.observation !== undefined);
  }
  const reasons = new Set(records.map((record) => record.reasonCode));
  for (const reason of ["Busy", "Queued", "Interrupted", "StopUnconfirmed"])
    assert.ok(reasons.has(reason), "the original event family is exercised");
});

test("launch request and runtime-unreachable events do not become completed execution", () => {
  const { records, diagnostics } = capture();
  diagnostics.emitSecurityEvent(
    event({
      source: "occ",
      category: "lifecycle",
      action: "deploy",
      phase: "requested",
      result: "pending",
      reasonCode: "RequestReceived",
      observation: undefined,
    }),
  );
  diagnostics.emitSecurityEvent(
    event({
      source: "runtime",
      category: "lifecycle",
      action: "stop",
      phase: "unknown",
      result: "unknown",
      reasonCode: "RuntimeUnreachable",
      observation: undefined,
    }),
  );
  assert.equal(records[0].phase, "requested");
  assert.equal(records[0].result, "pending");
  assert.equal(records[1].result, "unknown");
  assert.equal(records[1].reasonCode, "RuntimeUnreachable");
  assert.equal(records[1].observedAt, null);
});

test("original hostile input is projected before logging and canaries reach no output", () => {
  const { records, diagnostics } = capture();
  const input = fixture();
  diagnostics.emitSecurityEvent(projectSecurityEvent(hostileAudit(input.audit), input.context));
  const output = JSON.stringify({ records, health: diagnostics.localSubmissions() });
  for (const canary of canaries) assert.equal(output.includes(canary), false);
});

test("unknown schemas, extra fields and invalid values produce constant rejection without writes", () => {
  const { records, diagnostics } = capture();
  const valid = event();
  for (const input of [
    { ...valid, schema: "unsupported" },
    { ...valid, details: { text: canaries[0] } },
    { ...valid, reasonCode: canaries[0] },
    { ...valid, observedAt: "2026-01-01T00:00:00.000Z" },
    { ...valid, id: "x".repeat(9000) },
    null,
  ]) {
    assert.deepEqual(diagnostics.emitSecurityEvent(input), {
      submitted: 0,
      suppressed: 0,
      failed: 0,
      rejected: 1,
      failureCode: "INVALID_DIAGNOSTIC",
      downstreamDelivery: "unobserved",
    });
  }
  assert.equal(records.length, 0);
  assert.equal(diagnostics.localSubmissions().rejected, 6);
});

test("unavailable source observation time stays null rather than the logger clock", () => {
  const input = scenarios.find((value) => value.id === "stop-unconfirmed");
  assert.ok(input, "original stop-unconfirmed fixture exists");
  const { records, diagnostics } = capture();
  diagnostics.emitSecurityEvent(event(input.context));
  assert.equal(records[0].observedAt, null);
  assert.equal(records[0].observedAtAvailable, false);
  assert.equal(records[0].result, "unknown");
  assert.equal(records[0].reasonCode, "StopUnconfirmed");
});

test("configured severity suppression is observable and is not a successful submission", () => {
  const { records, diagnostics } = capture("error");
  assert.deepEqual(diagnostics.emitSecurityEvent(event()), {
    submitted: 0,
    suppressed: 1,
    failed: 0,
    rejected: 0,
    failureCode: null,
    downstreamDelivery: "unobserved",
  });
  assert.equal(records.length, 0);
});

test("a throwing destination returns safe local failure without a retry or recursive log", () => {
  let writes = 0;
  const { diagnostics } = capture("info", () => {
    writes += 1;
    throw new Error(canaries.join(" "));
  });
  const result = diagnostics.emitSecurityEvent(event());
  assert.equal(writes, 1);
  assert.deepEqual(result, {
    submitted: 0,
    suppressed: 0,
    failed: 1,
    rejected: 0,
    failureCode: "LOCAL_LOG_SUBMISSION_FAILED",
    downstreamDelivery: "unobserved",
  });
  for (const canary of canaries) assert.equal(JSON.stringify(result).includes(canary), false);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(diagnostics.localSubmissions()));
});

test("logger completion and destination backpressure do not become downstream acknowledgement", () => {
  const { diagnostics } = capture("info", () => false);
  assert.equal(diagnostics.emitSecurityEvent(event()).submitted, 1);
  assert.equal(diagnostics.localSubmissions().downstreamDelivery, "unobserved");
});

test("failure remains visible after a later submission and counters have fixed keys", () => {
  let first = true;
  const { diagnostics } = capture("info", () => {
    if (first) {
      first = false;
      throw new Error("harmless destination marker");
    }
    return true;
  });
  diagnostics.emitSecurityEvent(event());
  for (let index = 0; index < 150; index++)
    diagnostics.emitSecurityEvent({
      ...event(),
      id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    });
  assert.deepEqual(diagnostics.localSubmissions(), {
    submitted: 150,
    suppressed: 0,
    failed: 1,
    rejected: 0,
    failureCode: "LOCAL_LOG_SUBMISSION_FAILED",
    downstreamDelivery: "unobserved",
  });
});

test("invalid lifecycle inputs fail before any target-bearing log is submitted", () => {
  const { records, diagnostics } = capture();
  assert.equal(diagnostics.emitLifecycleStatus({}, { actorId: canaries[0] }).rejected, 1);
  assert.equal(diagnostics.emitLifecycleOperation({}, { observation: canaries[0] }).rejected, 1);
  assert.equal(records.length, 0);
});

function canonicalReadCases() {
  const selectedPath = process.env.OCC_TEST_LIFECYCLE_DIAGNOSTIC_FIXTURES;
  const selectedHash = process.env.OCC_TEST_LIFECYCLE_DIAGNOSTIC_FIXTURE_SHA256;
  const path =
    selectedPath ??
    new URL("../fixtures/lifecycle-status-projector-v1/sanitized.json", import.meta.url);
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (!selectedPath && error.code === "ENOENT") return null;
    throw error;
  }
  assert.ok(bytes.length <= 2 * 1024 * 1024, "bounded canonical fixture input");
  if (selectedPath) {
    assert.match(
      selectedHash ?? "",
      /^[0-9a-f]{64}$/,
      "an explicitly selected external fixture needs its exact reviewed hash",
    );
    assert.equal(createHash("sha256").update(bytes).digest("hex"), selectedHash);
  }
  const fixture = JSON.parse(bytes);
  assert.ok(Array.isArray(fixture.readCases) && fixture.readCases.length <= 100);
  return fixture.readCases;
}

const readCases = canonicalReadCases();
test(
  "a partial local lifecycle log failure stays separate from the supplied status",
  {
    skip: readCases === null ? "original canonical lifecycle fixture is unavailable" : false,
  },
  () => {
    const entry = readCases.find(
      (value) => value.method === "readStatus" && value.result.kind === "read",
    );
    assert.ok(entry);
    const before = JSON.stringify(entry.result.value);
    let writes = 0;
    const { diagnostics } = capture("info", () => {
      writes += 1;
      if (writes === 1) throw new Error("harmless destination marker");
      return true;
    });
    assert.deepEqual(diagnostics.emitLifecycleStatus(entry.request, entry.result.value), {
      submitted: 5,
      suppressed: 0,
      failed: 1,
      rejected: 0,
      failureCode: "LOCAL_LOG_SUBMISSION_FAILED",
      downstreamDelivery: "unobserved",
    });
    assert.equal(writes, 6, "each member is attempted once without replaying the failed record");
    assert.equal(JSON.stringify(entry.result.value), before);
  },
);
test(
  "original canonical lifecycle fixtures retain generations, independent conditions and source times",
  {
    skip:
      readCases === null
        ? "original lifecycle projector fixture has not been integrated or explicitly selected"
        : false,
  },
  () => {
    let statusCount = 0;
    let operationCount = 0;
    for (const entry of readCases) {
      if (entry.result.kind !== "read") continue;
      const { records, diagnostics } = capture();
      if (entry.method === "readStatus") {
        const status = entry.result.value;
        assert.equal(diagnostics.emitLifecycleStatus(entry.request, status).submitted, 6);
        const summary = records[0];
        assert.equal(summary.lifecycleGeneration, status.head?.lifecycleGeneration ?? null);
        for (const key of [
          "requestedRevisionId",
          "selectedRevisionId",
          "servingRevisionId",
          "observedLifecycleGeneration",
          "attempt",
          "phase",
          "step",
          "reasonCode",
          "serving",
          "stopComplete",
          "retention",
        ])
          assert.equal(summary[key], status[key]);
        assert.equal(
          Object.hasOwn(summary, "observedAt"),
          false,
          "status has no aggregate source time",
        );
        for (const record of records.slice(1)) {
          const condition = status.conditions[record.condition];
          assert.equal(record.conditionStatus, condition.status);
          assert.equal(record.reasonCode, condition.reasonCode);
          assert.equal(record.observedAt, condition.observedAt);
          assert.equal(record.recordedAt, condition.recordedAt);
          assert.equal(record.observedAtAvailable, condition.observedAt !== null);
        }
        const foreign = { ...entry.request, agentId: "agt_ffffffff-ffff-4fff-8fff-ffffffffffff" };
        assert.equal(diagnostics.emitLifecycleStatus(foreign, status).rejected, 1);
        assert.equal(records.length, 6);
        statusCount += 1;
      }
      if (entry.method === "readOperation") {
        const status = entry.result.value;
        assert.equal(diagnostics.emitLifecycleOperation(entry.request, status).submitted, 1);
        assert.equal(records[0].operationRef, status.operation.operationRef);
        assert.equal(records[0].lifecycleGeneration, status.operation.lifecycleGeneration);
        assert.equal(records[0].acceptedAt, status.operation.acceptedAt);
        assert.equal(records[0].observedAt, status.observation.observedAt);
        assert.equal(records[0].recordedAt, status.observation.recordedAt);
        operationCount += 1;
      }
    }
    assert.ok(
      statusCount > 0 && operationCount > 0,
      "both actual canonical fixture families execute",
    );
  },
);
