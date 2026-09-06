import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  decodeNativeMeasurementProfileV1,
  decodeNativeMeasurementResultsV1,
  decodeNativeMeasurementProfileJsonV1,
  decodeNativeMeasurementResultsJsonV1,
  nativeMeasurementProfileDigestV1,
  evaluateNativeMeasurementsV1,
} from "../../packages/contracts/src/native-measurement-codec-v1.ts";
import {
  NATIVE_MEASUREMENT_PRESERVED_V1,
  NATIVE_MEASUREMENT_CASES_V1,
} from "../../packages/contracts/src/native-measurement-v1.ts";
import { produceFixture } from "../fixtures/native-measurement-v1/producer.ts";
import { consumeMeasurement } from "../fixtures/native-measurement-v1/consumer.ts";

const profile = () =>
  JSON.parse(
    readFileSync(
      new URL("../fixtures/native-measurement-v1/profile.json", import.meta.url),
      "utf8",
    ),
  );
const valid = (d) => {
  assert.equal(d.kind, "valid");
  return d.value;
};
const evaluate = (p, r) => valid(evaluateNativeMeasurementsV1(p, r));
const row = (r, id = "startup-ready") => r.records.find((c) => c.id === id);
const caseResult = (e, id = "startup-ready") => e.cases.find((c) => c.id === id);
const run = (alter, changeProfile = () => {}) => {
  const p = profile();
  changeProfile(p);
  const r = produceFixture(p);
  alter(r, p);
  return evaluate(p, r);
};

test("independent producer and consumer exercise the public exports with fixture-only evidence", () => {
  const p = profile(),
    r = produceFixture(p),
    result = consumeMeasurement(p, JSON.stringify(r));
  assert.deepEqual(result.counts, {
    expected: 14,
    discovered: 14,
    selected: 14,
    pass: 14,
    fail: 0,
    skip: 0,
    unselected: 0,
    blocked: 0,
    missing: 0,
    unknown: 0,
  });
  assert.equal(result.verdict, "pass");
  assert.equal(result.evidenceKind, "fixture");
  assert.equal(result.runtimeQualified, false);
  assert.equal(result.evidenceAuthenticated, false);
  assert.equal(caseResult(result).observedSamples, 4);
  assert.equal(caseResult(result).warmupSamples, 2);
  assert.deepEqual(caseResult(result).distributionUs, {
    p50: 1000,
    p95: 1000,
    p99: 1000,
    max: 1000,
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.cases));
});
test("finite catalog preserves required native, Harness and authority constants", () => {
  assert.equal(NATIVE_MEASUREMENT_CASES_V1.length, 14);
  assert.deepEqual(NATIVE_MEASUREMENT_PRESERVED_V1.harness, {
    connectMs: 5000,
    sendMs: 5000,
    cancelMs: 3000,
    subscribeMs: 30000,
    reconnectMs: 5000,
    reconnectAttempts: 3,
    maxFrameBytes: 262144,
    maxInputBytes: 65536,
    maxEvents: 128,
    maxEventBytes: 1048576,
    maxAttempts: 64,
    maxSubscriptions: 16,
  });
  assert.equal(NATIVE_MEASUREMENT_PRESERVED_V1.native.executableQueue, 0);
  assert.equal(NATIVE_MEASUREMENT_PRESERVED_V1.native.completedTextUtf8Bytes, 3200);
  assert.equal(NATIVE_MEASUREMENT_PRESERVED_V1.authority.effectPermitMs, 5000);
});
test("unknown or unselected budget, policy, host resource and artifact cannot pass", () => {
  for (const change of [
    (p) => {
      p.cases[0].latencyBudget = { state: "unselected" };
    },
    (p) => {
      p.decision = { state: "unselected" };
    },
    (p) => {
      p.resourceProfile.expectation = { state: "unselected" };
    },
    (p) => {
      p.subject.artifacts.declarations = { state: "unknown" };
    },
    (p) => {
      p.resourceProfile.observed = { state: "unknown" };
    },
    (p) => {
      p.cases.find((c) => c.id === "cancel-retention").resourceTolerance = { state: "unselected" };
    },
  ]) {
    const e = run(() => {}, change);
    assert.equal(e.verdict, "incomplete");
    assert.ok(e.counts.blocked > 0);
  }
});
test("latency p95 and maximum use all measured samples and ignore observed warmups", () => {
  const e = run((r) => {
    const samples = row(r).samples;
    samples.find((s) => s.phase === "warmup").endUs += 1_000_000;
    const measured = samples.filter((s) => s.phase === "measured");
    for (let i = 0; i < measured.length; i++)
      measured[i].endUs = measured[i].startUs + [1, 2, 3, 10001][i];
  });
  assert.equal(e.verdict, "fail");
  assert.equal(e.counts.fail, 1);
  assert.deepEqual(caseResult(e).distributionUs, { p50: 2, p95: 10001, p99: 10001, max: 10001 });
});
test("missing sample, missing warmup and missing case remain missing", () => {
  for (const change of [
    (r) => row(r).samples.pop(),
    (r) => row(r).samples.shift(),
    (r) => r.records.shift(),
  ]) {
    const e = run(change);
    assert.equal(caseResult(e).outcome, "missing");
    assert.equal(e.verdict, "incomplete");
    assert.ok(caseResult(e).missingSamples > 0);
  }
});
test("explicit missing and unknown settlement are never zero-valued successful samples", () => {
  for (const [state, reason] of [
    ["missing", "not-recorded"],
    ["unknown", "settlement-unknown"],
  ]) {
    const e = run((r) => {
      row(r).samples[0] = { cycle: 0, phase: "warmup", index: 0, state, reason };
    });
    assert.equal(caseResult(e).outcome, state);
    assert.equal(e.verdict, "incomplete");
  }
});
test("case settlement, skip and unselected accounting stay distinct", () => {
  const e = run((r) => {
    r.records[0] = { id: "startup-ready", state: "blocked", reason: "dependency-unavailable" };
    r.records[1] = { id: "transport-ack", state: "unknown", reason: "settlement-unknown" };
    r.records[2] = { id: "admitted-turn-ack", state: "skip", reason: "operator-skipped" };
    r.records = r.records.filter((c) => c.id !== "busy");
    r.selected = r.selected.filter((id) => id !== "busy");
    r.discovered = r.discovered.filter((id) => id !== "busy");
  });
  assert.equal(e.verdict, "incomplete");
  assert.deepEqual(e.counts, {
    expected: 14,
    discovered: 13,
    selected: 13,
    pass: 10,
    fail: 0,
    skip: 1,
    unselected: 1,
    blocked: 1,
    missing: 0,
    unknown: 1,
  });
  assert.equal(e.counts.expected, e.counts.selected + e.counts.unselected);
});
test("only unselected model service can be explicitly not applicable", () => {
  const e = run(
    () => {},
    (p) => {
      p.workload.model = "none";
      p.cases.find((c) => c.id === "model-service").applicability = "not-applicable";
    },
  );
  assert.equal(e.verdict, "pass");
  assert.equal(e.counts.skip, 1);
  const p = profile();
  p.cases[0].applicability = "not-applicable";
  assert.equal(decodeNativeMeasurementProfileV1(p).kind, "invalid");
});
test("resource growth, late observation and shifted baseline are detected", () => {
  for (const mutate of [
    (s) => {
      s.after.rssBytes += 1025;
    },
    (s) => {
      s.after.fileDescriptors++;
    },
    (s) => {
      s.endUs = s.settledAtUs + 1001;
    },
  ]) {
    const e = run((r) =>
      mutate(row(r, "cancel-retention").samples.find((s) => s.phase === "measured")),
    );
    assert.equal(caseResult(e, "cancel-retention").outcome, "fail");
  }
  const p = profile(),
    r = produceFixture(p);
  row(r, "cancel-retention").samples.filter((s) => s.phase === "measured")[1].before.rssBytes++;
  assert.equal(evaluateNativeMeasurementsV1(p, r).kind, "invalid");
});
test("out-of-order input samples are safe but duplicate or out-of-grid slots fail", () => {
  assert.equal(run((r) => row(r).samples.reverse()).verdict, "pass");
  for (const mutate of [
    (s) => {
      s[1] = structuredClone(s[0]);
    },
    (s) => {
      s[0].cycle = 99;
    },
    (s) => {
      s[0].index = 99;
    },
  ]) {
    const p = profile(),
      r = produceFixture(p);
    mutate(row(r).samples);
    assert.equal(evaluateNativeMeasurementsV1(p, r).kind, "invalid");
  }
});
test("reports bind exact retained profile, full tuple, declarations and evidence class", () => {
  for (const mutate of [
    (r) => {
      r.profileDigest = "0".repeat(64);
    },
    (r) => {
      r.subject.producer.enterpriseCommit = "0".repeat(40);
    },
    (r) => {
      r.subject.artifacts.declarations.digest = "0".repeat(64);
    },
    (r) => {
      r.evidenceKind = "actual-provider";
    },
  ]) {
    const p = profile(),
      r = produceFixture(p);
    mutate(r);
    assert.equal(evaluateNativeMeasurementsV1(p, r).kind, "invalid");
  }
  const p = profile(),
    before = valid(nativeMeasurementProfileDigestV1(p));
  p.revision++;
  assert.notEqual(valid(nativeMeasurementProfileDigestV1(p)), before);
});
test("clock domain, backward endpoints, resource state and unsafe counters fail", () => {
  for (const mutate of [
    (s) => {
      s.clockOriginRef = "other-clock";
    },
    (s) => {
      s.endUs = s.startUs - 1;
    },
    (s) => {
      s.endUs = Number.MAX_SAFE_INTEGER + 1;
    },
    (s) => {
      s.startUs = -0;
    },
    (s) => {
      s.endUs = Infinity;
    },
    (s) => {
      s.state = "resources";
    },
  ]) {
    const p = profile(),
      r = produceFixture(p);
    mutate(row(r).samples[0]);
    assert.equal(evaluateNativeMeasurementsV1(p, r).kind, "invalid");
  }
});
test("boundary payload sizes, protocol pin, no queue, no attachments and no streaming are closed", () => {
  for (const mutate of [
    (p) => {
      p.workload.inputUtf8Bytes = 65537;
    },
    (p) => {
      p.workload.resultUtf8Bytes = 3201;
    },
    (p) => {
      p.workload.executableQueue = 1;
    },
    (p) => {
      p.workload.attachments = 1;
    },
    (p) => {
      p.workload.tokenStreaming = true;
    },
    (p) => {
      p.subject.producer.gatewayProtocol = 5;
    },
    (p) => {
      p.subject.producer.declarationsDigest = "a".repeat(64);
    },
    (p) => {
      p.subject.producer.codexVersion = "0.154.0";
    },
  ]) {
    const p = profile();
    mutate(p);
    assert.equal(decodeNativeMeasurementProfileV1(p).kind, "invalid");
  }
  const p = profile();
  p.workload.inputUtf8Bytes = 65536;
  p.workload.resultUtf8Bytes = 3200;
  assert.equal(decodeNativeMeasurementProfileV1(p).kind, "valid");
});
test("finite case/sample/container/depth/byte limits reject overflow", () => {
  const p = profile(),
    r = produceFixture(p);
  p.cases[0].cycles = 100;
  p.cases[0].samplesPerCycle = 100;
  assert.equal(decodeNativeMeasurementProfileV1(p).kind, "invalid");
  row(r).samples = Array.from({ length: 4097 }, () => structuredClone(row(r).samples[0]));
  assert.equal(decodeNativeMeasurementResultsV1(r).kind, "invalid");
  assert.equal(
    decodeNativeMeasurementProfileJsonV1(" ".repeat(2 * 1024 * 1024 + 1)).kind,
    "invalid",
  );
  assert.equal(decodeNativeMeasurementResultsV1(Array(8193).fill(null)).kind, "invalid");
  let deep = {};
  for (let i = 0; i < 18; i++) deep = { child: deep };
  assert.equal(decodeNativeMeasurementProfileV1(deep).kind, "invalid");
});
test("JSON duplicate keys, malformed Unicode, unknown keys and malformed grammar fail", () => {
  for (const input of [
    '{"format":1,"format":2}',
    '{"x":1,"\\u0078":2}',
    '{"x":"\\ud800"}',
    '{"x":1,}',
    "[1,]",
    '{"x":01}',
    '{"x":NaN}',
    "{}{}",
  ])
    assert.equal(decodeNativeMeasurementProfileJsonV1(input).kind, "invalid");
  const p = profile();
  p.unknown = true;
  assert.equal(decodeNativeMeasurementProfileV1(p).kind, "invalid");
  const original = JSON.stringify(profile());
  assert.equal(decodeNativeMeasurementProfileJsonV1(original).kind, "valid");
  assert.equal(
    decodeNativeMeasurementResultsJsonV1(JSON.stringify(produceFixture(profile()))).kind,
    "valid",
  );
});
test("snapshot rejects executable object behavior and does not invoke getters or proxies", () => {
  let calls = 0;
  const getter = Object.defineProperty({}, "format", {
    enumerable: true,
    get() {
      calls++;
      return "x";
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        return [];
      },
    },
  );
  const cycle = {};
  cycle.self = cycle;
  for (const input of [
    getter,
    proxy,
    cycle,
    new Date(),
    Object.assign([], { extra: 1 }),
    [, ,],
    { x: Symbol("x") },
    { x: () => {} },
  ])
    assert.equal(decodeNativeMeasurementProfileV1(input).kind, "invalid");
  assert.equal(calls, 0);
});
test("decoded profile is detached and frozen; property order does not change measurement digest", () => {
  const p = profile(),
    d = valid(decodeNativeMeasurementProfileV1(p));
  p.clock.originRef = "changed";
  assert.equal(d.clock.originRef, "fixture:observer-clock");
  assert.ok(Object.isFrozen(d.clock));
  const reversed = Object.fromEntries(Object.entries(d).reverse());
  assert.equal(
    valid(nativeMeasurementProfileDigestV1(d)),
    valid(nativeMeasurementProfileDigestV1(reversed)),
  );
});

test("reconnect response preserves truthful domain unknown without establishing settlement", () => {
  const e = run((r) => {
    row(r, "reconnect-ready").samples[0].domainOutcome = "unknown";
    r.records = r.records.map((c) =>
      c.id === "reconnect-retention"
        ? { id: c.id, state: "unknown", reason: "settlement-unknown" }
        : c,
    );
  });
  assert.equal(caseResult(e, "reconnect-ready").outcome, "pass");
  assert.equal(caseResult(e, "reconnect-ready").domainUnknownSamples, 1);
  assert.equal(caseResult(e, "reconnect-retention").outcome, "unknown");
  assert.equal(e.verdict, "incomplete");
});
test("observed payload mismatch and capture overflow cannot hide in warmups", () => {
  for (const mutate of [
    (w) => {
      w.overflow = true;
    },
    (w) => {
      w.inputUtf8Bytes++;
    },
    (w) => {
      w.resultUtf8Bytes++;
    },
    (w) => {
      w.outputCaptureBytes++;
    },
  ]) {
    const e = run((r) => mutate(row(r).samples[0].workload));
    assert.equal(caseResult(e).outcome, "fail");
  }
});
test("resource request/limit meaning, observed binding and unselected storage remain explicit", () => {
  const p = profile();
  p.resourceProfile.observed.roles.gateway.cpuMillicores.request++;
  assert.equal(decodeNativeMeasurementProfileV1(p).kind, "invalid");
  const q = profile();
  q.resourceProfile.expectation.roles.privateStateInit.ephemeralStorageBytes = {
    state: "unselected",
  };
  q.resourceProfile.observed.roles.privateStateInit.ephemeralStorageBytes = { state: "unselected" };
  const e = evaluate(q, produceFixture(q));
  assert.equal(e.verdict, "incomplete");
  assert.equal(e.counts.blocked, 14);
});

test("JSON counters reject fractional and exponent tokens before numeric rounding", () => {
  const serialized = JSON.stringify(profile());
  for (const token of ["1.0000000000000001", "1e-400", "1.0", "1e0", "9007199254740993"]) {
    const input = serialized.replace('"warmupPerCycle":1', '"warmupPerCycle":' + token);
    assert.notEqual(input, serialized);
    assert.equal(decodeNativeMeasurementProfileJsonV1(input).kind, "invalid");
  }
  const packet = JSON.stringify(produceFixture(profile()));
  assert.equal(
    decodeNativeMeasurementResultsJsonV1(packet.replace('"cycle":0', '"cycle":1e-400')).kind,
    "invalid",
  );
});
test("aggregate slot boundary admits a complete 1024-slot report and rejects 1025", () => {
  const p = profile();
  for (const c of p.cases) {
    c.cycles = 1;
    c.warmupPerCycle = 0;
    c.samplesPerCycle = 1;
  }
  p.cases[0].cycles = 10;
  p.cases[0].samplesPerCycle = 100;
  p.cases[1].samplesPerCycle = 12;
  assert.equal(decodeNativeMeasurementProfileV1(p).kind, "valid");
  const e = consumeMeasurement(p, JSON.stringify(produceFixture(p)));
  assert.equal(e.verdict, "pass");
  assert.equal(
    e.cases.reduce((sum, c) => sum + c.observedSamples + c.warmupSamples, 0),
    1024,
  );
  p.cases[1].samplesPerCycle = 13;
  assert.equal(decodeNativeMeasurementProfileV1(p).kind, "invalid");
});
test("initial per-channel profile preserves 680 measured plus 280 warmup slots", () => {
  const p = profile();
  const frequent = new Set([
    "transport-ack",
    "admitted-turn-ack",
    "completed-result",
    "status",
    "busy",
    "model-service",
  ]);
  for (const c of p.cases) {
    c.cycles = 10;
    c.warmupPerCycle = 2;
    c.samplesPerCycle = frequent.has(c.id) ? 10 : 1;
  }
  const e = consumeMeasurement(p, JSON.stringify(produceFixture(p)));
  assert.equal(e.verdict, "pass");
  assert.equal(e.counts.pass, 14);
  assert.equal(
    e.cases.reduce((sum, c) => sum + c.observedSamples, 0),
    680,
  );
  assert.equal(
    e.cases.reduce((sum, c) => sum + c.warmupSamples, 0),
    280,
  );
});
