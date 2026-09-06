import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalRuntimeEffectRequestV1,
  parseRuntimeEffectsResponseV1,
} from "../../../packages/contracts/src/runtime-effects-v1.ts";
import { vectors as v, consumer } from "./accepted-fixtures.mjs";
import { SCENARIOS, DEFERRED_CASES, RETAINED_LIFECYCLE_FIXTURE } from "./scenarios.ts";
import { runInterruptionScenario, runInterruptionMatrix } from "./runner.ts";
import {
  scenarioInput,
  controlledSession,
  retainedCleanup,
  sourceBinding,
} from "./controlled-fixture.mjs";

const source = sourceBinding();
const input = (id = "create/lost-acknowledgment") => scenarioInput(id, source);
const data = (value) => JSON.parse(JSON.stringify(value));
const run = (item, behavior = {}) => {
  const fixture = controlledSession(item, behavior);
  return runInterruptionScenario(item, fixture.options).then((report) => ({ report, fixture }));
};

test("before-call interruption never opens a session or reports durable provider non-submission", async () => {
  for (const method of ["create", "observe", "setRoute"]) {
    const { report, fixture } = await run(input(`${method}/before-call`));
    assert.equal(fixture.opened, 0);
    assert.equal(fixture.calls.length, 0);
    assert.equal(report.primary.status, "not-invoked");
    assert.equal(report.primary.response, undefined);
    assert.equal(report.checkpointReached, true);
  }
});

test("lost acknowledgment retains exact bytes, locator and request digest without replaying create", async () => {
  const item = input();
  const original = v.copy(item.request);
  const { report, fixture } = await run(item, {
    onOpen() {
      item.request.admittedRuntime.configurationDigest = v.digest(99);
    },
    readEffect: () => v.appliedResult(original),
  });
  assert.equal(report.primary.status, "unresolved");
  assert.equal(report.resolution.status, "settled");
  assert.equal(report.resolution.reason, "applied");
  assert.equal(report.checkpointReached, true);
  assert.equal(report.canonicalRequest, canonicalRuntimeEffectRequestV1(original));
  assert.equal(fixture.calls.filter(({ name }) => name === "create").length, 1);
  assert.deepEqual(
    fixture.calls.map(({ name }) => name),
    ["create", "discover", "readEffect"],
  );
  assert.equal(fixture.calls[0].call.signal.aborted, true);
  assert.equal(fixture.calls[2].call.signal.aborted, false);
  assert.deepEqual(data(fixture.calls[2].request), original.effect);
  assert.deepEqual(data(report.request), original);
  assert.equal(consumer.nextEffectAction(report.resolution.response), "inspect-applied");
  assert.equal(
    report.resolution.response.providerReceipt.clock.sourceObservedAt,
    v.evidence().clock.sourceObservedAt,
  );
  assert(
    Object.isFrozen(report) && Object.isFrozen(report.events) && Object.isFrozen(report.request),
  );
});

test("zero candidates and not-found readback exhaust the finite budget without settling create", async () => {
  // IFC-04 has no settled-empty discovery branch. A zero-candidate search is
  // represented by incomplete discovery; only exact effect readback can settle it.
  const { report, fixture } = await run(input("create/in-flight"));
  assert.equal(report.primary.status, "unresolved");
  assert.equal(report.resolution.status, "unresolved");
  assert.equal(report.resolution.reason, "not-found");
  assert.equal(consumer.nextEffectAction(report.resolution.response), "read-original");
  assert.equal(fixture.calls.filter(({ name }) => name === "create").length, 1);
  assert.equal(fixture.calls.filter(({ name }) => name === "discover").length, 2);
  assert.equal(fixture.calls.filter(({ name }) => name === "readEffect").length, 2);
  assert.deepEqual(
    report.events.filter(({ phase }) => phase === "discovery").map(({ detail }) => detail.status),
    ["incomplete", "incomplete"],
  );
});

test("lost acknowledgment checkpoint requires an actual produced response", async () => {
  for (const pending of [false, true]) {
    const item = input();
    item.callTimeoutMs = 15;
    item.maxReadbacks = 1;
    const { report } = await run(item, {
      create() {
        if (pending) return new Promise(() => {});
        throw new Error("response was not produced");
      },
    });
    assert.equal(report.checkpointReached, false);
    assert.equal(report.primary.reason, pending ? "deadline" : "call-failed");
    assert.equal(report.resolution.status, "unresolved");
    assert.equal(
      report.events.some(({ phase }) => phase === "checkpoint/response-produced"),
      false,
    );
  }
});

test("validated budgets and full matrix inputs cannot change while sessions are running", async () => {
  const item = input("create/in-flight");
  item.maxReadbacks = 1;
  item.callTimeoutMs = 25;
  const { report, fixture } = await run(item, {
    onOpen() {
      item.maxReadbacks = 100;
      item.callTimeoutMs = 10001;
    },
  });
  assert.equal(fixture.calls.length, 3);
  assert.equal(report.limits.maxReadbacks, 1);
  assert.equal(report.limits.callTimeoutMs, 25);
  assert.equal(report.limits.maxScenarioAwaitMs, 75);

  const sequence = [input("create/in-flight"), input("observe/in-flight")];
  const expected = v.copy(sequence[1].request);
  const reports = await runInterruptionMatrix(sequence, (selected) => {
    sequence[1].request.target.agentId = `agt_${v.uuid(999)}`;
    sequence[1].maxReadbacks = 100;
    assert(Object.isFrozen(selected) && Object.isFrozen(selected.request));
    return controlledSession(selected).options;
  });
  assert.deepEqual(data(reports[1].request), expected);
  assert.equal(reports[1].limits.maxReadbacks, 2);
});

test("only an exact durable non-submission receipt settles absence", async () => {
  const item = input();
  const receipt = {
    schemaVersion: 1,
    effect: item.request.effect,
    status: "not-submitted",
    boundary: "before-any-possible-submission",
    reasonCode: "cancelled",
    durableNonSubmissionEvidence: v.evidence("durable-non-submission"),
  };
  const { report, fixture } = await run(item, { readEffect: receipt });
  assert.equal(report.primary.status, "unresolved");
  assert.equal(report.resolution.status, "settled");
  assert.equal(report.resolution.reason, "not-submitted");
  assert.equal(fixture.calls.filter(({ name }) => name === "readEffect").length, 1);
  assert.equal(consumer.nextEffectAction(report.resolution.response), "report-terminal");
});

test("readback rejects changed effect digest, same-name successor UID and uncorrelated discovery", async () => {
  for (const change of ["digest", "uid"]) {
    const item = input("setRoute/in-flight");
    const result = {
      ...v.appliedResult(item.request),
      route: { status: "pending", reasonCode: "evidence-incomplete" },
    };
    if (change === "digest") result.effect = { ...result.effect, requestDigest: v.digest(91) };
    else result.object.uid = "successor-object";
    const { report } = await run(item, { readEffect: result });
    assert.equal(report.resolution.status, "invalid-response", change);
    assert.equal(report.primary.status, "unresolved", change);
  }
  const item = input();
  const wrong = v.exactCreate();
  wrong.effect.requestDigest = v.digest(93);
  const { report } = await run(item, {
    discover: { schemaVersion: 1, status: "unknown", input: wrong, reasonCode: "unavailable" },
  });
  assert.equal(report.resolution.status, "unresolved");
  assert.equal(report.events.filter(({ phase }) => phase === "discovery-invalid").length, 2);
});

test("route application preserves pending traffic evidence and never claims route withdrawal", async () => {
  const item = input("setRoute/lost-acknowledgment");
  const applied = {
    ...v.appliedResult(item.request),
    route: { status: "pending", reasonCode: "evidence-incomplete" },
  };
  const { report, fixture } = await run(item, { readEffect: applied });
  assert.equal(report.resolution.status, "settled");
  assert.equal(report.resolution.response.route.status, "pending");
  assert.equal(report.runtimeMeasurements.routeRemoved, "unmeasured");
  assert.equal(fixture.calls.filter(({ name }) => name === "setRoute").length, 1);
});

test("interrupted observation repeats only the exact read and preserves original source times", async () => {
  const item = input("observe/in-flight");
  const { report, fixture } = await run(item, { observe: v.completeObservation() });
  assert.equal(report.primary.status, "unresolved");
  assert.equal(report.resolution.status, "observed");
  assert.equal(report.resolution.response.eligibility, "observation-only");
  assert.equal(
    report.resolution.response.observation.clock.sourceObservedAt,
    v.evidence().clock.sourceObservedAt,
  );
  assert.deepEqual(
    fixture.calls.map(({ name }) => name),
    ["observe", "observe"],
  );
  assert.deepEqual(data(fixture.calls[1].request), item.request);
  assert.equal(report.canonicalRequest, null);
  assert.equal(report.runtimeMeasurements.executionTerminated, "unmeasured");
});

test("hanging primary and readback calls are bounded; late settlement cannot change retained evidence", async () => {
  const item = input("create/in-flight");
  item.callTimeoutMs = 15;
  item.maxReadbacks = 1;
  let finish;
  const { report, fixture } = await run(item, {
    omitCheckpoints: true,
    create: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    discover: () => new Promise(() => {}),
    readEffect: () => new Promise(() => {}),
  });
  assert.equal(report.primary.reason, "deadline");
  assert.equal(report.resolution.reason, "deadline");
  assert.equal(report.checkpointReached, false);
  assert.equal(fixture.calls.length, 3);
  assert(fixture.calls.every(({ call }) => call.signal.aborted));
  const retained = JSON.stringify(report);
  finish(v.appliedResult(item.request));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(report), retained);
});

test("owner cancellation stops subsequent calls and cannot claim provider termination", async () => {
  const owner = new AbortController();
  const item = input("create/in-flight");
  item.cleanup = retainedCleanup();
  const { report, fixture } = await run(item, {
    signal: owner.signal,
    onCall() {
      owner.abort();
    },
  });
  assert.equal(fixture.calls.length, 1);
  assert.equal(report.resolution.status, "unresolved");
  assert.equal(report.cleanup.status, "not-invoked");
  assert.equal(report.cleanup.reason, "owner-cancelled");
  assert.equal(report.runtimeMeasurements.executionTerminated, "unmeasured");
});

test("owner abort during the scheduling gap invokes no port or cleanup", async () => {
  const item = input("create/in-flight");
  item.cleanup = retainedCleanup();
  const owner = new AbortController();
  const fixture = controlledSession(item, { signal: owner.signal });
  const pending = runInterruptionScenario(item, fixture.options);
  owner.abort();
  const report = await pending;
  assert.equal(fixture.calls.length, 0);
  assert.equal(report.primary.status, "not-invoked");
  assert.equal(report.primary.reason, "cancelled");
  assert.equal(report.checkpointReached, false);
  assert.equal(
    report.events.some(({ phase }) => phase.startsWith("call/")),
    false,
  );
  assert.equal(report.cleanup.status, "not-invoked");
});

test("known execution tuple and cleanup identity must match before any session opens", async () => {
  for (const field of ["configurationDigest", "runtimeProfileDigest", "imageDigests"]) {
    const item = input("setRoute/before-call");
    item.binding[field] =
      field === "imageDigests" ? [{ name: "harness", digest: v.digest(999) }] : v.digest(999);
    const fixture = controlledSession(item);
    await assert.rejects(runInterruptionScenario(item, fixture.options));
    assert.equal(fixture.opened, 0);
  }
  const item = input("setRoute/in-flight");
  item.cleanup = retainedCleanup();
  item.cleanup.binding.runtimeInstanceRef = "different-execution";
  v.signRequest(item.cleanup);
  const fixture = controlledSession(item);
  await assert.rejects(runInterruptionScenario(item, fixture.options));
  assert.equal(fixture.opened, 0);
});

test("complete bound observation must name an owned Deployment and declared execution tuple", async () => {
  for (const mismatch of ["unowned-object", "configuration"]) {
    const item = input("observe/in-flight");
    item.request = {
      schemaVersion: 1,
      kind: "bound-instance",
      target: v.target(),
      binding: v.binding(),
      expectedEvidenceVersion: null,
    };
    const observed = v.completeObservation();
    observed.input = item.request;
    if (mismatch === "unowned-object") observed.object.target.name = "unlisted-deployment";
    else item.binding.configurationDigest = v.digest(999);
    if (mismatch === "unowned-object") {
      // The shared contract correlates execution identity; this runner additionally
      // binds the exact declared provider resource selected for this finite sample.
      parseRuntimeEffectsResponseV1("observe", item.request, observed);
      const { report } = await run(item, { observe: observed });
      assert.equal(report.resolution.status, "invalid-response");
    } else {
      const fixture = controlledSession(item, { observe: observed });
      await assert.rejects(runInterruptionScenario(item, fixture.options));
      assert.equal(fixture.opened, 0);
    }
  }
  const item = input("observe/in-flight");
  item.binding.configurationDigest = v.digest(999);
  const { report } = await run(item, { observe: v.completeObservation() });
  assert.equal(report.resolution.status, "invalid-response");
});

test("primary and cleanup attempts remain separate from both exact readback outcomes", async () => {
  const item = input();
  item.cleanup = retainedCleanup();
  const cleanupApplied = {
    ...v.appliedResult(item.cleanup),
    termination: {
      status: "unknown",
      execution: { target: item.cleanup.effect.target, binding: item.cleanup.binding },
      reasonCode: "provider-outcome-unknown",
    },
  };
  const { report, fixture } = await run(item, {
    stopRetainingState() {
      throw new Error("private provider diagnostic must not leak");
    },
    readEffect(effect) {
      return effect.effectRef === item.cleanup.effect.effectRef
        ? cleanupApplied
        : v.appliedResult(item.request);
    },
  });
  assert.equal(report.primary.status, "unresolved");
  assert.equal(report.resolution.reason, "applied");
  assert.equal(report.cleanup.reason, "call-failed");
  assert.equal(report.cleanupResolution.reason, "applied");
  assert.equal(report.cleanupResolution.response.termination.status, "unknown");
  assert.equal(report.cleanupRequest.retainState, true);
  assert.deepEqual(data(report.cleanupRequest.retainedStores), item.cleanup.retainedStores);
  assert(!JSON.stringify(report).includes("private provider diagnostic"));
  assert.deepEqual(
    fixture.calls.map(({ name }) => name),
    ["create", "discover", "readEffect", "stopRetainingState", "readEffect"],
  );
  assert.equal(report.cleanupCanonicalRequest, canonicalRuntimeEffectRequestV1(item.cleanup));
});

test("execution learned during readback cannot be silently substituted into preaccepted cleanup", async () => {
  for (const method of ["create", "observe"]) {
    const item = input(`${method}/in-flight`);
    item.cleanup = retainedCleanup();
    const applied = method === "create" ? v.appliedResult(item.request) : v.completeObservation();
    if (method === "create") applied.object.uid = "different-deployment-uid";
    else applied.binding.runtimeInstanceRef = "different-runtime-instance";
    const { report, fixture } = await run(item, {
      [method === "create" ? "readEffect" : "observe"]: applied,
    });
    assert.equal(report.resolution.status, method === "create" ? "settled" : "observed");
    assert.equal(report.cleanup.status, "not-invoked");
    assert.equal(report.cleanup.reason, "resolved-execution-mismatch");
    assert.equal(
      fixture.calls.some(({ name }) => name === "stopRetainingState"),
      false,
    );
    assert.deepEqual(data(report.cleanupRequest), item.cleanup);
  }
});

test("incomplete tuples, changed digests, unowned resources and foreign cleanup refuse before fixture invocation", async () => {
  const changes = [
    (i) => {
      i.binding.source.commit = "missing";
    },
    (i) => {
      i.binding.source.files = [];
    },
    (i) => {
      i.binding.evidenceKind = "runtime-pass";
    },
    (i) => {
      i.binding.configurationDigest = v.digest(999);
    },
    (i) => {
      i.binding.ownedResources = [v.providerTarget(1)];
    },
    (i) => {
      i.request.effect.requestDigest = v.digest(999);
    },
    (i) => {
      i.cleanup = v.stopRequest();
    },
    (i) => {
      i.callTimeoutMs = 10001;
    },
    (i) => {
      i.maxReadbacks = 4;
    },
  ];
  for (const change of changes) {
    const item = input();
    item.binding = structuredClone(item.binding);
    change(item);
    const fixture = controlledSession(item);
    await assert.rejects(runInterruptionScenario(item, fixture.options));
    assert.equal(fixture.opened, 0);
  }
});

test("matrix preflights all inputs, enforces fixed ordering and rejects deferred executable claims", async () => {
  let opened = 0;
  const options = (item) => {
    opened++;
    return controlledSession(item).options;
  };
  for (const sequence of [
    [],
    [input(), input("create/in-flight")],
    [input(), input()],
    [input(), input("quiet-native-restore")],
  ])
    await assert.rejects(runInterruptionMatrix(sequence, options));
  const incomplete = input("observe/in-flight");
  incomplete.binding = { ...incomplete.binding, imageDigests: [] };
  await assert.rejects(runInterruptionMatrix([input(), incomplete], options));
  assert.equal(opened, 0);
  const reports = await runInterruptionMatrix(
    SCENARIOS.map(({ id }) => input(id)),
    options,
  );
  assert.deepEqual(
    reports.map(({ scenario }) => scenario.id),
    SCENARIOS.map(({ id }) => id),
  );
  assert(reports.every(({ checkpointReached }) => checkpointReached));
  for (const descriptor of DEFERRED_CASES) {
    assert.equal(descriptor.executable, false);
    assert.equal(descriptor.status, "unrun");
    assert(Object.values(descriptor).every((value) => typeof value !== "function"));
  }
  assert.equal(RETAINED_LIFECYCLE_FIXTURE.entrypoint, "runScenario");
  assert.equal(RETAINED_LIFECYCLE_FIXTURE.status, "unrun");
});

test("CLI writes a finite controlled report once, preserves existing evidence and rejects live mode", () => {
  const directory = mkdtempSync(join(tmpdir(), "interruption-runner-test-"));
  try {
    const output = join(directory, "report.json");
    const command = [
      "tests/runtime/direct-compute-interruption/run.mjs",
      "--controlled",
      "--output",
      output,
    ];
    const first = spawnSync(process.execPath, command, { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const bytes = readFileSync(output);
    const report = JSON.parse(bytes);
    assert.equal(report.evidenceKind, "controlled-preparation");
    assert.equal(report.reports.length, 9);
    assert(
      report.reports.every(({ runtimeMeasurements }) =>
        Object.values(runtimeMeasurements).every((value) => value === "unmeasured"),
      ),
    );
    assert.notEqual(spawnSync(process.execPath, command).status, 0);
    assert.deepEqual(readFileSync(output), bytes);
    assert.notEqual(
      spawnSync(process.execPath, [command[0], "--live", "--output", output]).status,
      0,
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});
