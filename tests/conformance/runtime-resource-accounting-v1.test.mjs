import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  parseRuntimeResourceAccountingV1 as parse,
  validateRuntimeResourceAccountingV1 as validate,
  runtimeResourceDeadlineBudgetV1 as deadline,
  RUNTIME_AUTHORITY_LIMITS_V1,
  RUNTIME_EFFECT_LIMITS_V1,
} from "@openclaw-enterprise/contracts/runtime-resource-accounting-v1";
import { RUNTIME_AUTHORITY_LIMITS_V1 as originalLimits } from "../../packages/contracts/src/runtime-authority-v1.ts";
import {
  envelope,
  selectedRequirements,
  supplied,
  required,
  unavailable,
  vector,
  resourceInputs,
} from "../fixtures/runtime-resource-accounting-v1/values.mjs";
import {
  validateProducedAccounting,
  providerRequestBudget,
} from "../fixtures/runtime-resource-accounting-v1/producer.ts";
import {
  consumeInput,
  gatewayObservation,
  effectiveEvidence,
} from "../fixtures/runtime-resource-accounting-v1/consumer.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const check = (value, code, path) => {
  const result = validate(value);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === code && (path === undefined || issue.path === path),
    ),
    JSON.stringify(result),
  );
  return result;
};

test("independent producer, consumer and expected-negative projects compile against actual leaf export", () => {
  for (const name of ["module", "producer", "consumer", "negatives"])
    execFileSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "-p",
        `tests/fixtures/runtime-resource-accounting-v1/${name}.tsconfig.json`,
        "--pretty",
        "false",
      ],
      { cwd: root, timeout: 90000, stdio: "pipe", encoding: "utf8" },
    );
});

test("real port accounts concurrent init, overhead, shared stores and owned node reservations", () => {
  const result = validateProducedAccounting(envelope());
  assert.equal(result.status, "accounted");
  assert.deepEqual(result.totals.gateway, vector(500, 5000, 50000));
  assert.deepEqual(result.totals.harness, vector(510, 5100, 51000));
  // Reserve declared envelopes for simultaneously possible Pods plus external
  // services. Storage/log sub-budgets are not added a second time.
  assert.deepEqual(result.totals.node, vector(1260, 12600, 126000));
  assert.equal(result.totals.nodeHostTasks, 140);
  assert.equal(result.totals.retainedBytes, 506000);
  assert.equal(result.evidence, "supplied-accounting-only");
  assert.equal(result.effectiveResources, "unavailable");
  assert.equal(consumeInput(envelope()).authority, "none");
});

test("sequential init uses maxima; explicitly concurrent init uses sums", () => {
  const sequential = envelope();
  sequential.harness.value.phases.value = [
    { phaseRef: "a", kind: "initialization", active: ["harness/init-a"] },
    { phaseRef: "b", kind: "initialization", active: ["harness/init-b"] },
    { phaseRef: "steady", kind: "steady", active: ["harness/app"] },
  ];
  assert.deepEqual(validate(sequential).totals.harness, vector(310, 3100, 31000));
  assert.equal(validate(envelope()).totals.harness.cpuMilli.request, 510);
});

test("restartable init and helpers remain in steady-state overlap", () => {
  const value = envelope();
  const w = value.harness.value;
  w.contributions[1].kind = "restartable-init";
  w.contributions.push({
    accountingId: "harness/helper",
    kind: "helper",
    resources: resourceInputs(vector(5, 50, 500)),
  });
  check(value, "invalid-concurrency");
  w.phases.value[1].active.push("harness/init-a", "harness/helper");
  assert.equal(validate(value).status, "accounted");
});

test("known selected inputs retain missing init, Job, service, process and storage budgets", () => {
  const value = selectedRequirements();
  const parsed = parse(value);
  const result = validate(parsed);
  assert.equal(result.status, "incomplete");
  check(value, "unavailable-budget", "gateway.contributions[1].ephemeralStorageBytes");
  check(value, "unavailable-budget", "repositoryPreparation");
  check(value, "unavailable-budget", "externalReservations.spire");
  assert.equal(
    parsed.harness.value.contributions[0].resources.memoryBytes.value.limit,
    4 * 1024 ** 3,
  );
  assert.equal(parsed.repositoryPreparation.status, "unavailable");
  assert.equal(result.totals.node, null);
  assert.equal(result.totals.retainedBytes, null);
  assert.equal(result.totals.nodeHostTasks, null);
});

test("required, unavailable, unsupported and omitted budgets have distinct outcomes", () => {
  for (const [state, code] of [
    [required(), "missing-budget"],
    [unavailable(), "unavailable-budget"],
    [
      { status: "unsupported", ownerRef: "owner", reason: "accounting-unsupported" },
      "unsupported-budget",
    ],
  ]) {
    const v = envelope();
    v.repositoryPreparation = state;
    assert.equal(check(v, code, "repositoryPreparation").status, "incomplete");
  }
  const missing = envelope();
  delete missing.repositoryPreparation;
  assert.equal(check(missing, "invalid-input").status, "invalid");
  const inherited = envelope();
  inherited.repositoryPreparation = { status: "inherit-harness", ownerRef: "owner" };
  check(inherited, "invalid-input");
});

test("invalid and noncanonical quantities never round, coerce, or become unbounded", () => {
  for (const amount of [
    -1,
    -0,
    0.1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "500m",
    "1Gi",
    null,
  ]) {
    const value = envelope();
    value.gateway.value.contributions[0].resources.cpuMilli.value.request = amount;
    const result = check(value, "invalid-input");
    assert.equal(result.status, "invalid");
    assert.deepEqual(result.issues, [{ code: "invalid-input", path: "$root" }]);
  }
  const reversed = envelope();
  reversed.gateway.value.contributions[0].resources.cpuMilli.value.request = 201;
  check(reversed, "request-exceeds-limit");
});

test("safe individual quantities can overflow an aggregate and never expose totals", () => {
  const value = envelope();
  value.gateway.value.contributions[1].resources.cpuMilli.value = {
    request: Number.MAX_SAFE_INTEGER,
    limit: Number.MAX_SAFE_INTEGER,
  };
  const result = check(value, "quantity-overflow");
  assert.ok(Object.values(result.totals).every((v) => v === null));
});

test("runsc, helper, phase and shared bucket duplicate accounting is refused", () => {
  for (const mutate of [
    (v) => v.harness.value.overhead.value.push(structuredClone(v.harness.value.overhead.value[0])),
    (v) => {
      v.harness.value.overhead.value[0].accountingId = "harness/app";
    },
    (v) => v.gateway.value.phases.value[0].active.push("gateway/init-a"),
    (v) => v.gateway.value.storage.value.push(structuredClone(v.gateway.value.storage.value[0])),
    (v) => {
      v.externalReservations.nodeSystem.value.accountingId = "harness/runsc";
    },
    (v) => v.workloadConcurrency.value.push(["harness", "gateway"]),
  ]) {
    const value = envelope();
    mutate(value);
    check(value, "double-counting");
  }
});

test("a runsc charge can move to the node once, without changing the node reservation silently", () => {
  const value = envelope();
  value.harness.value.overhead.value[0].chargedTo = "node";
  const result = validate(value);
  assert.equal(result.status, "accounted");
  assert.equal(result.totals.harness.cpuMilli.request, 500);
  assert.equal(result.totals.node.cpuMilli.request, 1270);
  value.harness.value.overhead.value = [];
  check(value, "missing-runsc-overhead");
});

test("all contributions and workload possibilities require an explicit concurrency plan", () => {
  const absent = envelope();
  absent.harness.value.phases = unavailable();
  assert.equal(check(absent, "unavailable-budget").totals.harness, null);
  for (const mutate of [
    (v) => v.harness.value.phases.value.shift(),
    (v) => v.harness.value.phases.value[0].active.push("unlisted"),
    (v) => {
      v.workloadConcurrency.value = [["gateway", "harness"]];
    },
    (v) => {
      v.workloadConcurrency.value = [["gateway"], ["harness"], ["repositoryPreparation"]];
    },
  ]) {
    const value = envelope();
    mutate(value);
    check(value, "invalid-concurrency");
  }
});

test("overrides and infrastructure defaults must match already selected values exactly", () => {
  for (const source of ["explicit-override", "limitrange-default", "runtimeclass-default"]) {
    const value = envelope();
    value.gateway.value.alternatives.value.push({
      source,
      accountingId: "gateway/app",
      resources: vector(),
    });
    assert.equal(validate(value).status, "accounted");
    value.gateway.value.alternatives.value[0].resources.cpuMilli.limit++;
    check(value, "default-conflict");
  }
  const missing = envelope();
  missing.gateway.value.contributions[0].resources.cpuMilli = unavailable();
  missing.gateway.value.alternatives.value.push({
    source: "limitrange-default",
    accountingId: "gateway/app",
    resources: vector(),
  });
  check(missing, "default-conflict");
  assert.equal(
    parse(missing).gateway.value.contributions[0].resources.cpuMilli.status,
    "unavailable",
  );
});

test("finite process, storage, logs and request/limit envelopes reject exhaustion", () => {
  for (const mutate of [
    (v) => {
      v.gateway.value.processes.value.podHostTaskBudget = 257;
    },
    (v) => {
      v.gateway.value.processes.value.guestProcessBudget = 41;
    },
    (v) => {
      v.nodeHostTaskLimit.value = 139;
    },
    (v) => {
      v.gateway.value.podBudget.value.cpuMilli.limit = 999;
    },
    (v) => {
      v.gateway.value.logs.value.maxFiles = 6;
    },
    (v) => {
      v.gateway.value.storage.value[1].reservedBytes = 50001;
    },
    (v) => {
      v.gateway.value.storage.value[1].capacityBytes = 150000;
      v.gateway.value.storage.value[1].reservedBytes = 150000;
    },
    (v) => {
      v.nodeBudget.value.memoryBytes.limit = 20000;
    },
  ]) {
    const value = envelope();
    mutate(value);
    check(value, "budget-exceeded");
  }
  const wrongBucket = envelope();
  wrongBucket.gateway.value.logs.value.storageId = "harness/logs";
  check(wrongBucket, "invalid-storage");
  const zeroLimit = envelope();
  zeroLimit.harness.value.processes.value.podHostTaskLimit = 0;
  check(zeroLimit, "invalid-input");
});

test("contained Job concurrency and attempts have their own finite budget", () => {
  const value = envelope();
  value.repositoryPreparation.value.execution.value.maxConcurrentInstances = 2;
  const result = validate(value);
  assert.equal(result.status, "accounted");
  assert.equal(result.totals.node.cpuMilli.request, 1860);
  assert.equal(result.totals.nodeHostTasks, 204);
  for (const field of ["maxConcurrentInstances", "maxAttempts", "totalPreparationMs"]) {
    const invalid = envelope();
    invalid.repositoryPreparation.value.execution.value[field] = 0;
    check(invalid, "invalid-input");
  }
  value.repositoryPreparation.value.execution.value.totalPreparationMs = 900001;
  check(value, "invalid-input");
});

test("parsed snapshots and output remain deeply immutable and detached", () => {
  const input = envelope();
  const parsed = parse(input);
  input.gateway.value.contributions[0].resources.cpuMilli.value.limit = 999;
  assert.equal(parsed.gateway.value.contributions[0].resources.cpuMilli.value.limit, 200);
  assert.throws(() => {
    parsed.gateway.value.contributions[0].resources.cpuMilli.value.limit = 1;
  }, TypeError);
  const result = validate(parsed);
  assert.throws(() => {
    result.totals.gateway.cpuMilli.limit = 0;
  }, TypeError);
  assert.throws(() => {
    result.issues.push({});
  }, TypeError);
});

test("bounded plain data parsing rejects getters, sparse arrays, cycles and surplus claims without leaking values", () => {
  let called = false;
  const accessor = envelope();
  Object.defineProperty(accessor, "envelopeRef", {
    enumerable: true,
    get() {
      called = true;
      return "secret-value";
    },
  });
  check(accessor, "invalid-input");
  assert.equal(called, false);
  const cycle = envelope();
  cycle.gateway = cycle;
  check(cycle, "invalid-input");
  const sparse = envelope();
  delete sparse.workloadConcurrency.value[0];
  check(sparse, "invalid-input");
  const claim = envelope();
  claim.measuredCapacity = "secret-value";
  const result = check(claim, "invalid-input");
  assert.ok(!JSON.stringify(result).includes("secret-value"));
  const huge = envelope();
  huge.envelopeRef = "x".repeat(262145);
  check(huge, "invalid-input");
  assert.equal(effectiveEvidence(parse(envelope())), "producer-port-unavailable");
  assert.equal(gatewayObservation(parse(envelope())), "owner-input-missing");
});

test("canonical timing ceilings and stricter purpose/remaining budgets survive unchanged", () => {
  assert.equal(RUNTIME_AUTHORITY_LIMITS_V1, originalLimits);
  for (const [kind, ceiling] of Object.entries(originalLimits).filter(([kind]) =>
    [
      "preparationMaxMs",
      "providerRequestMaxMs",
      "lookupMaxMs",
      "observationMaxAgeMs",
      "clockUncertaintyMaxMs",
      "activeRecheckMaxMs",
      "gracefulStopMaxMs",
      "terminationObservationMaxMs",
    ].includes(kind),
  )) {
    assert.equal(deadline(kind, 1000000, 1000000), ceiling);
    assert.equal(deadline(kind, 500, 200), 200);
    assert.equal(deadline(kind, 100, 200), 100);
    assert.equal(deadline(kind, 0, 200), 0);
  }
  assert.deepEqual(originalLimits.reconcileBackoffMs, [1000, 2000, 4000, 8000, 16000, 30000]);
  assert.equal(RUNTIME_EFFECT_LIMITS_V1.denialTargetMs, 60000);
  assert.equal(providerRequestBudget(8000, 3000), 3000);
  for (const args of [
    ["providerRequestMaxMs", -1, 1],
    ["providerRequestMaxMs", 1, 0],
    ["denialTargetMs", 1, 1],
    ["providerRequestMaxMs", Infinity, 1],
  ])
    assert.throws(() => deadline(...args), /Invalid runtime resource accounting/);
});

test("existing IFC observation variants and profile provenance survive without resource authority", async () => {
  const { observation } =
    await import("../fixtures/runtime-resource-accounting-v1/observation.mjs");
  const { parseRuntimeEffectsV1 } =
    await import("../../packages/contracts/src/runtime-effects-v1.ts");
  const actual = observation();
  const accepted = parseRuntimeEffectsV1("observationResult", actual);
  const value = envelope();
  value.observations.harness = supplied(actual, "original-compute-owner");
  const parsed = parse(value);
  assert.deepEqual(parsed.observations.harness.value, accepted);
  assert.notEqual(
    parsed.observations.harness.value.profile.desired.digest,
    parsed.observations.harness.value.profile.effective.digest,
  );
  assert.equal(validate(value).effectiveResources, "unavailable");
  assert.equal(
    parsed.observations.harness.value.observation.clock.sourceObservedAt,
    "2026-01-01T00:00:00.000Z",
  );
  for (const status of ["incomplete", "ambiguous", "unknown"]) {
    value.observations.harness = supplied({
      schemaVersion: 1,
      status,
      input: actual.input,
      reasonCode: "evidence-incomplete",
    });
    assert.equal(parse(value).observations.harness.value.status, status);
  }
  value.observations.harness = supplied(actual);
  actual.observation.clock.sourceObservedAt = "2026-01-01T00:00:10.000Z";
  assert.throws(() => parseRuntimeEffectsV1("observationResult", actual));
  check(value, "invalid-input");
  const wrongComponent = envelope();
  wrongComponent.observations.gateway = supplied(observation());
  check(wrongComponent, "invalid-input");
});

test("Pod default targets cannot collide with contribution or reservation IDs", () => {
  const value = envelope();
  value.gateway.value.alternatives.value.push({
    source: "limitrange-default",
    accountingId: "pod",
    resources: structuredClone(value.gateway.value.podBudget.value),
  });
  assert.equal(validate(value).status, "accounted");
  value.gateway.value.contributions[0].accountingId = "pod";
  check(value, "invalid-input");
  const external = envelope();
  external.externalReservations.nodeSystem.value.accountingId = "pod";
  check(external, "invalid-input");
});
