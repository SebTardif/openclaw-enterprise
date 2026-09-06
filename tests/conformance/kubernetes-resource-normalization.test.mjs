import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeResourceQuantity,
  normalizeResourceRequirements,
  normalizeResourceAccountingEnvelope,
  resourceRequirementsFromVector,
  compareResourceRequirements,
  compareResourceQuota,
} from "../../apps/controller/src/drivers/compute/kubernetes/resources/resource-normalization.ts";
import {
  produceResources,
  produceEnvelope,
  consumeEnvelope,
} from "../fixtures/kubernetes-resource-plan/normalization-producer.ts";
import {
  resourceEnvelope,
  resourceRequirements,
  selectedRequirements,
  unavailable,
  required,
  vector,
} from "../fixtures/kubernetes-resource-plan/normalization-values.mjs";

test("exact decimal, binary and exponent quantities normalize to integral canonical units", () => {
  for (const spelling of ["1", "1.0", "1000m", "1000000u", "1000000000n", "1e0", "0.001k"])
    assert.equal(normalizeResourceQuantity("cpu", spelling), 1000, spelling);
  for (const spelling of ["1Gi", "1024Mi", "1073741824", "1.073741824G", "1073741824e0"])
    assert.equal(normalizeResourceQuantity("memory", spelling), 1024 ** 3, spelling);
  assert.equal(normalizeResourceQuantity("ephemeral-storage", "1.5Ki"), 1536);
  assert.equal(normalizeResourceQuantity("memory", "1000m"), 1);
  assert.equal(normalizeResourceQuantity("cpu", ".001"), 1);
  assert.equal(normalizeResourceQuantity("memory", "9007199254740991"), Number.MAX_SAFE_INTEGER);
  assert.equal(normalizeResourceQuantity("cpu", "0e-30"), 0);
});

test("fractional base units, coercion, unsupported suffixes and unsafe quantities never round", () => {
  for (const [name, values] of [
    ["cpu", ["0.1m", "1n", "1Ki", "1e-4", "9007199254741", "1E", "1e31"]],
    ["memory", ["0.1", "400m", "1e-1", "1ki", "1KB", "1Ei", "9007199254740992", "1e-31"]],
  ])
    for (const value of [
      ...values,
      "",
      " ",
      " 1",
      "1 ",
      "+1",
      "-1",
      "-0",
      "-0m",
      "1_000",
      "NaN",
      "Infinity",
      1,
      null,
      true,
      "1".repeat(65),
    ])
      assert.throws(
        () => normalizeResourceQuantity(name, value),
        /Invalid resource normalization input/,
      );
});

test("real producer emits immutable detached requirements with all six explicit quantities", () => {
  const input = resourceRequirements();
  const result = produceResources(input);
  assert.equal(result.status, "normalized");
  assert.deepEqual(result.vector, {
    cpuMilli: { request: 250, limit: 1000 },
    memoryBytes: { request: 512 * 1024 ** 2, limit: 1024 ** 3 },
    ephemeralStorageBytes: { request: 256 * 1024 ** 2, limit: 1024 ** 3 },
  });
  assert.equal(result.resources.limits.cpu, "1000m");
  assert.equal(result.resources.requests.memory, "536870912");
  input.limits.cpu = "9";
  assert.equal(result.vector.cpuMilli.limit, 1000);
  assert.throws(() => {
    result.resources.limits.cpu = "9";
  }, TypeError);
  assert.throws(() => {
    result.vector.cpuMilli.limit = 9;
  }, TypeError);
  assert.deepEqual(normalizeResourceRequirements(result.resources), result);
  assert.deepEqual(resourceRequirementsFromVector(result.vector), result.resources);
});

test("missing resource dimensions remain incomplete; malformed and inverted pairs are invalid", () => {
  const missing = resourceRequirements();
  delete missing.requests["ephemeral-storage"];
  const result = normalizeResourceRequirements(missing);
  assert.deepEqual(result, {
    status: "incomplete",
    issues: [{ code: "missing-quantity", path: "requests.ephemeral-storage" }],
  });
  assert.equal("vector" in result, false);
  assert.equal(normalizeResourceRequirements(undefined).issues.length, 6);
  const inverted = resourceRequirements();
  inverted.requests.cpu = "1001m";
  assert.deepEqual(normalizeResourceRequirements(inverted).issues, [
    { code: "request-exceeds-limit", path: "cpu" },
  ]);
  for (const mutate of [
    (value) => {
      value.limits.memory = "1.2";
    },
    (value) => {
      value.requests.gpu = "1";
    },
    (value) => {
      value.measured = true;
    },
    (value) => {
      value.requests = null;
    },
  ]) {
    const value = resourceRequirements();
    mutate(value);
    assert.equal(normalizeResourceRequirements(value).status, "invalid");
  }
});

test("normalization rejects executable or excessive input without invoking it or leaking values", () => {
  let accesses = 0;
  const getter = resourceRequirements();
  Object.defineProperty(getter.requests, "cpu", {
    enumerable: true,
    get() {
      accesses++;
      return "secret-value";
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        accesses++;
        throw Error("secret-value");
      },
      getPrototypeOf() {
        accesses++;
        throw Error("secret-value");
      },
    },
  );
  const cycle = {};
  cycle.requests = cycle;
  for (const value of [
    getter,
    proxy,
    cycle,
    { requests: "x".repeat(262145) },
    new Date(),
    [resourceRequirements()],
  ]) {
    const result = normalizeResourceRequirements(value);
    assert.equal(result.status, "invalid");
    assert.equal(JSON.stringify(result).includes("secret-value"), false);
    assert.ok(JSON.stringify(result).length < 200);
  }
  assert.equal(accesses, 0);
});

test("default and override comparison accepts equivalent spelling but never fills absent values", () => {
  const selected = normalizeResourceRequirements(resourceRequirements()).vector;
  const equivalent = resourceRequirements();
  equivalent.requests.cpu = ".25";
  equivalent.limits.memory = "1073741824";
  assert.equal(compareResourceRequirements(selected, equivalent).status, "match");
  equivalent.limits.cpu = "1001m";
  assert.deepEqual(compareResourceRequirements(selected, equivalent), {
    status: "conflict",
    issues: [{ code: "resource-conflict", path: "limits.cpu" }],
  });
  delete equivalent.limits.memory;
  assert.equal(compareResourceRequirements(selected, equivalent).status, "incomplete");
  assert.equal(compareResourceRequirements(null, equivalent).status, "invalid");
});

test("quota arithmetic includes existing usage, all six caps and safe addition without zero defaults", () => {
  const demand = vector(100, 1000, 10000);
  const used = vector(20, 200, 2000);
  const hard = vector(120, 1200, 12000);
  assert.equal(compareResourceQuota(demand, hard, used).status, "fits");
  for (const name of Object.keys(hard))
    for (const side of ["request", "limit"]) {
      const oneShort = structuredClone(hard);
      oneShort[name][side]--;
      const result = compareResourceQuota(demand, oneShort, used);
      assert.equal(result.status, "exceeded");
      assert.equal(result.issues.length, 1);
    }
  const independentCaps = vector(1000, 10000, 100000);
  independentCaps.cpuMilli.limit = 240;
  assert.equal(compareResourceQuota(demand, independentCaps, used).status, "fits");
  assert.equal(compareResourceQuota(demand, hard, undefined).status, "invalid");
  const enormous = vector(0, 0, 0);
  enormous.cpuMilli = { request: Number.MAX_SAFE_INTEGER, limit: Number.MAX_SAFE_INTEGER };
  const overflow = compareResourceQuota(enormous, enormous, vector(1, 0, 0));
  assert.equal(overflow.status, "invalid");
  assert.ok(overflow.issues.every((issue) => issue.code === "quantity-overflow"));
});

test("actual resource-accounting envelope consumer preserves concurrent init, runsc, storage and accounting identities", () => {
  const input = resourceEnvelope();
  const result = produceEnvelope(input);
  assert.equal(result.status, "accounted");
  assert.deepEqual(consumeEnvelope(result.envelope), result.accounting);
  assert.equal(result.envelope.envelopeRef, input.envelopeRef);
  assert.equal(result.accounting.totals.harness.cpuMilli.request, 510);
  assert.equal(result.accounting.totals.node.cpuMilli.request, 1260);
  assert.equal(result.accounting.totals.retainedBytes, 506000);
  assert.equal(result.accounting.evidence, "supplied-accounting-only");
  assert.equal(result.accounting.effectiveResources, "unavailable");
  input.envelopeVersion++;
  assert.equal(result.envelope.envelopeVersion, 1);
  assert.throws(() => {
    result.envelope.harness.value.overhead.value.push({});
  }, TypeError);
  const sequential = resourceEnvelope();
  sequential.harness.value.phases.value = [
    { phaseRef: "a", kind: "initialization", active: ["harness/init-a"] },
    { phaseRef: "b", kind: "initialization", active: ["harness/init-b"] },
    { phaseRef: "steady", kind: "steady", active: ["harness/app"] },
  ];
  assert.equal(
    normalizeResourceAccountingEnvelope(sequential).accounting.totals.harness.cpuMilli.request,
    310,
  );
});

test("owner-input states survive normalization and separately missing Job never inherits Harness", () => {
  for (const state of [
    required(),
    unavailable(),
    { status: "unsupported", ownerRef: "owner", reason: "accounting-unsupported" },
  ]) {
    const input = resourceEnvelope();
    input.repositoryPreparation = state;
    const result = normalizeResourceAccountingEnvelope(input);
    assert.equal(result.status, "incomplete");
    assert.deepEqual(JSON.parse(JSON.stringify(result.envelope.repositoryPreparation)), state);
    assert.equal(result.accounting.totals.node, null);
  }
  const unresolved = normalizeResourceAccountingEnvelope(selectedRequirements());
  assert.equal(unresolved.status, "incomplete");
  assert.equal(
    unresolved.envelope.gateway.value.contributions[1].resources.ephemeralStorageBytes.status,
    "unavailable",
  );
  for (const field of ["overhead", "processes", "logs", "storage", "execution"])
    assert.equal(unresolved.envelope.harness.value[field].status, "unavailable");
  assert.equal(unresolved.envelope.repositoryPreparation.status, "unavailable");
});

test("normalization delegates duplicate costs, default conflicts and finite budgets to accepted validator", () => {
  for (const [code, mutate] of [
    [
      "double-counting",
      (input) =>
        input.harness.value.overhead.value.push(
          structuredClone(input.harness.value.overhead.value[0]),
        ),
    ],
    [
      "default-conflict",
      (input) =>
        input.gateway.value.alternatives.value.push({
          source: "limitrange-default",
          accountingId: "gateway/app",
          resources: vector(101),
        }),
    ],
    [
      "budget-exceeded",
      (input) => {
        input.gateway.value.processes.value.guestProcessBudget = 41;
      },
    ],
    [
      "budget-exceeded",
      (input) => {
        input.gateway.value.logs.value.maxFiles = 6;
      },
    ],
  ]) {
    const input = resourceEnvelope();
    mutate(input);
    const result = normalizeResourceAccountingEnvelope(input);
    assert.equal(result.status, "invalid");
    assert.equal(result.envelope, null);
    assert.ok(result.accounting.issues.some((issue) => issue.code === code));
  }
});
