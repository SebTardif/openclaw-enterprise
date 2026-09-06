import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseLifecycleAdmissionV1 } from "../../packages/contracts/src/lifecycle-admission-v1.ts";
import {
  LIFECYCLE_STATUS_PROJECTION_LIMITS_V1,
  parseLifecycleStatusReadRequestV1,
  projectLifecycleStatusReadV1 as project,
} from "../../packages/occ/src/lifecycle/status-projector-v1.ts";
import { parseLifecycleObservationResponseV1 } from "../../packages/contracts/src/lifecycle-observation-v1.ts";
import {
  lifecycleScopeFixture,
  lifecycleStatusFixture,
  lifecycleOperationFixture,
  lifecycleObservationFixture,
  lifecyclePageRequestFixture,
  lifecycleCapabilityFixture,
  lifecycleStatusReadCases,
  richLifecycleStatusReadCase,
} from "../fixtures/lifecycle-status-projector-v1/values.mjs";

// The actual pure projector is exercised with synthetic declarations, including
// rejected reads. No fixture supplies authentication, permission or runtime proof.
const unavailable = { kind: "unavailable" };
const plain = (value) => JSON.parse(JSON.stringify(value));
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function caseFor(method) {
  const value = lifecycleStatusReadCases().find(
    (entry) => entry.method === method && entry.result.kind === "read",
  );
  assert.ok(value, `missing canonical ${method} fixture`);
  return value;
}
function objects(value, path = []) {
  if (value === null || typeof value !== "object") return [];
  return [
    [path, value],
    ...Object.entries(value).flatMap(([key, child]) => objects(child, [...path, key])),
  ];
}
function at(value, path) {
  return path.reduce((parent, key) => parent[key], value);
}
function modify(value, change) {
  const copy = structuredClone(value);
  change(copy);
  return copy;
}
function assertUnavailable(method, request, result) {
  const output = project(method, request, result);
  assert.deepEqual(output, unavailable);
  assert.ok(Object.isFrozen(output));
}

test("all supplied canonical read cases preserve exact public values and original validation", () => {
  const cases = lifecycleStatusReadCases();
  assert.ok(cases.length >= 4);
  for (const entry of cases) {
    const output = project(entry.method, entry.request, entry.result);
    assert.deepEqual(plain(output), entry.result, entry.label);
    if (output.kind === "read") {
      assert.deepEqual(
        plain(output.value),
        plain(parseLifecycleObservationResponseV1(entry.method, entry.request, entry.result.value)),
      );
    }
  }
});

test("all four richer responses omit private descriptors without invoking their getters", () => {
  for (const method of ["readStatus", "readOperation", "listOperations", "readCapability"]) {
    const entry = richLifecycleStatusReadCase(method);
    const output = project(method, entry.request, entry.result);
    assert.equal(output.kind, "read");
    assert.equal(entry.privateReads(), 0);
    const encoded = JSON.stringify(output);
    for (const key of [
      "actorId",
      "auditEventId",
      "conversationId",
      "credential",
      "backend",
      "installationId",
    ])
      assert.equal(encoded.includes(`"${key}"`), false);
  }
});

test("descriptor allowlist drops private data at every public object and array position", () => {
  let calls = 0;
  for (const method of ["readStatus", "readOperation", "listOperations", "readCapability"]) {
    const entry = caseFor(method);
    const expected = plain(entry.result);
    const privateProxy = new Proxy(
      {},
      {
        ownKeys() {
          calls++;
          throw Error("private");
        },
        get() {
          calls++;
          throw Error("private");
        },
        getPrototypeOf() {
          calls++;
          throw Error("private");
        },
      },
    );
    const privateCycle = {};
    privateCycle.self = privateCycle;
    for (const [, node] of objects(entry.result)) {
      node.actorId = "private-actor";
      node.auditEventId = "private-audit";
      node.secretPayload = privateProxy;
      node.privateGraph = privateCycle;
      node[Symbol("private")] = () => {
        calls++;
      };
      Object.defineProperty(node, "credential", {
        enumerable: true,
        get() {
          calls++;
          throw Error("private credential");
        },
      });
      Object.defineProperty(node, "toJSON", {
        enumerable: false,
        get() {
          calls++;
          throw Error("private coercion");
        },
      });
    }
    assert.deepEqual(plain(project(method, entry.request, entry.result)), expected);
  }
  assert.equal(calls, 0);
});

test("missing required public fields fail closed at every fixed object depth", () => {
  for (const method of ["readStatus", "readOperation", "listOperations", "readCapability"]) {
    const entry = caseFor(method);
    for (const [path, node] of objects(entry.result)) {
      if (Array.isArray(node)) continue;
      for (const key of Object.keys(node)) {
        assertUnavailable(
          method,
          entry.request,
          modify(entry.result, (value) => {
            delete at(value, path)[key];
          }),
        );
      }
    }
  }
});

test("accessors in selected public fields fail without executing caller code", () => {
  let calls = 0;
  for (const method of ["readStatus", "readOperation", "listOperations", "readCapability"]) {
    const entry = caseFor(method);
    for (const [path, node] of objects(entry.result)) {
      if (Array.isArray(node)) continue;
      for (const key of Object.keys(node)) {
        const result = modify(entry.result, (value) => {
          Object.defineProperty(at(value, path), key, {
            enumerable: true,
            get() {
              calls++;
              throw Error("private");
            },
          });
        });
        assertUnavailable(method, entry.request, result);
      }
    }
  }
  assert.equal(calls, 0);
});

test("selected proxy revoked proxy class and inherited fields are not coerced", () => {
  let calls = 0;
  const entry = caseFor("readStatus");
  const proxy = new Proxy(entry.result.value, {
    getPrototypeOf() {
      calls++;
      throw Error("private");
    },
    getOwnPropertyDescriptor() {
      calls++;
      throw Error("private");
    },
  });
  assertUnavailable("readStatus", entry.request, { kind: "read", value: proxy });
  assertUnavailable(
    "readStatus",
    entry.request,
    new Proxy(entry.result, {
      getOwnPropertyDescriptor() {
        calls++;
        throw Error("private");
      },
    }),
  );
  const revoked = Proxy.revocable(entry.result, {});
  revoked.revoke();
  assertUnavailable("readStatus", entry.request, revoked.proxy);
  class BackendRecord {}
  assertUnavailable("readStatus", entry.request, Object.assign(new BackendRecord(), entry.result));
  const inherited = Object.create(entry.result.value);
  assertUnavailable("readStatus", entry.request, { kind: "read", value: inherited });
  const hidden = structuredClone(entry.result);
  Object.defineProperty(hidden.value, "head", { enumerable: false });
  assertUnavailable("readStatus", entry.request, hidden);
  const cyclic = structuredClone(entry.result);
  cyclic.value.conditions = cyclic.value;
  assertUnavailable("readStatus", entry.request, cyclic);
  assert.equal(calls, 0);
});

test("strict request parsing retains original method types and never redacts caller extras", () => {
  for (const method of ["readStatus", "readOperation", "listOperations", "readCapability"]) {
    const entry = caseFor(method);
    const parsed = parseLifecycleStatusReadRequestV1(method, entry.request);
    assert.deepEqual(plain(parsed), entry.request);
    assert.ok(Object.isFrozen(parsed));
    for (const patch of [
      { installationId: `ins_${id(1)}` },
      { actorId: "caller" },
      { authority: true },
      { expectedLifecycleGeneration: null },
    ]) {
      const request = { ...entry.request, ...patch };
      assert.throws(() => parseLifecycleStatusReadRequestV1(method, request), {
        name: "LifecycleObservationErrorV1",
        message: "Invalid lifecycle observation data.",
      });
      assertUnavailable(method, request, entry.result);
      assertUnavailable(method, request, { kind: "rejected", code: "NOT_FOUND" });
    }
  }
  for (const method of [
    "reconcile",
    "readCurrentIntent",
    "constructor",
    "__proto__",
    "",
    undefined,
    1,
    new String("readStatus"),
  ]) {
    assert.throws(() => parseLifecycleStatusReadRequestV1(method, lifecycleScopeFixture()), {
      name: "LifecycleObservationErrorV1",
    });
    assertUnavailable(method, lifecycleScopeFixture(), { kind: "unavailable" });
  }
});

test("request accessors and proxies are rejected without invocation even for backend denials", () => {
  let calls = 0;
  const input = lifecycleScopeFixture();
  Object.defineProperty(input, "namespaceId", {
    enumerable: true,
    get() {
      calls++;
      throw Error("private");
    },
  });
  assertUnavailable("readStatus", input, { kind: "rejected", code: "NOT_FOUND" });
  const proxy = new Proxy(lifecycleScopeFixture(), {
    ownKeys() {
      calls++;
      throw Error("private");
    },
  });
  assertUnavailable("readStatus", proxy, unavailable);
  assert.equal(calls, 0);
});

test("known read failures keep the existing protocol and hidden foreign details are indistinguishable", () => {
  const request = lifecycleScopeFixture();
  for (const code of [
    "INVALID_REQUEST",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "NAMESPACE_NOT_READY",
    "INTERNAL_ERROR",
  ]) {
    const output = project("readStatus", request, {
      kind: "rejected",
      code,
      backend: { account: "private" },
      value: lifecycleStatusFixture(),
    });
    assert.deepEqual(plain(output), { kind: "rejected", code });
    assert.ok(Object.isFrozen(output));
  }
  const hidden = {
    kind: "rejected",
    code: "NOT_FOUND",
    exists: true,
    accountId: "private-account",
    hidden: true,
  };
  const foreign = {
    kind: "rejected",
    code: "NOT_FOUND",
    owner: "foreign-account",
    foreignCount: 900,
    hidden: false,
  };
  assert.deepEqual(project("readStatus", request, hidden), project("readStatus", request, foreign));
  assertUnavailable("readStatus", request, {
    kind: "unavailable",
    value: lifecycleStatusFixture(),
    error: "raw backend text",
  });
  for (const result of [
    { kind: "not-found" },
    { kind: "rejected", code: "provider-secret-error" },
    { kind: "accepted", receipt: {} },
    { kind: "commit-unknown" },
    { kind: "unchanged" },
    null,
    "NOT_FOUND",
  ])
    assertUnavailable("readStatus", request, result);
});

test("failure redaction never touches dropped value or error accessors", () => {
  let calls = 0;
  for (const kind of ["unavailable", "rejected"]) {
    const input = { kind, ...(kind === "rejected" ? { code: "NOT_FOUND" } : {}) };
    for (const key of ["value", "error", "actorId"])
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          calls++;
          throw Error("sensitive backend detail");
        },
      });
    assert.equal(project("readStatus", lifecycleScopeFixture(), input).kind, kind);
  }
  const bad = { kind: "rejected" };
  Object.defineProperty(bad, "code", {
    enumerable: true,
    get() {
      calls++;
      throw Error("sensitive code");
    },
  });
  assertUnavailable("readStatus", lifecycleScopeFixture(), bad);
  assert.equal(calls, 0);
});

test("mismatched status owner and operation locator are not repaired by projection", () => {
  const entry = caseFor("readStatus");
  for (const [key, value] of [
    ["namespaceId", `ns_${id(901)}`],
    ["agentId", `agt_${id(902)}`],
  ])
    assertUnavailable(
      "readStatus",
      entry.request,
      modify(entry.result, (v) => {
        v.value[key] = value;
      }),
    );
  const operation = caseFor("readOperation");
  assertUnavailable(
    "readOperation",
    operation.request,
    modify(operation.result, (v) => {
      v.value.operation.operationRef = id(903);
    }),
  );
});

test("public malformed scalars timestamps unions and unsupported reasons remain invalid", () => {
  const entry = caseFor("readStatus");
  for (const patch of [
    { serving: "false" },
    { stopComplete: 0 },
    { phase: "finished" },
    { reasonCode: "raw-provider-message" },
    { retention: "purged" },
    { attempt: -0 },
    { attempt: NaN },
    { attempt: Infinity },
    { attempt: 1.25 },
    { observedLifecycleGeneration: 0 },
    { observedLifecycleGeneration: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assertUnavailable("readStatus", entry.request, {
      kind: "read",
      value: { ...entry.result.value, ...patch },
    });
  for (const bad of [
    "2026-02-30T00:00:00.000Z",
    "2026-09-06T00:00:00Z",
    "2026-09-06T00:00:00.000+00:00",
    "bad\ud800",
    "bad\u0000",
    new Date(),
  ])
    assertUnavailable(
      "readStatus",
      entry.request,
      modify(entry.result, (v) => {
        v.value.conditions.executionTerminated.recordedAt = bad;
      }),
    );
  const capability = caseFor("readCapability");
  for (const patch of [{ stage: "ready" }, { protocol: "v2" }, { capabilityVersion: 0 }])
    assertUnavailable("readCapability", capability.request, {
      kind: "read",
      value: { ...capability.result.value, ...patch },
    });
});

test("stale source with fresh receipt and uncertainty reasons survive without promotion", () => {
  const value = lifecycleStatusFixture();
  value.serving = false;
  value.stopComplete = false;
  value.phase = "blocked";
  value.reasonCode = "CREATE_OUTCOME_UNKNOWN";
  value.conditions.executionTerminated = {
    status: "unknown",
    observedAt: "2020-01-01T00:00:00.000Z",
    recordedAt: "2026-09-06T12:00:00.000Z",
    reasonCode: "CREATE_OUTCOME_UNKNOWN",
  };
  const expected = parseLifecycleObservationResponseV1(
    "readStatus",
    lifecycleScopeFixture(),
    value,
  );
  const output = project("readStatus", lifecycleScopeFixture(), { kind: "read", value });
  assert.equal(output.kind, "read");
  assert.deepEqual(plain(output.value), plain(expected));
  assert.equal(output.value.conditions.executionTerminated.observedAt, "2020-01-01T00:00:00.000Z");
  assert.equal(output.value.serving, false);
  assert.equal(output.value.stopComplete, false);
});

test("denial credential and retained-state conditions cannot turn unknown execution into stop completion", () => {
  const value = lifecycleStatusFixture();
  value.phase = "blocked";
  value.reasonCode = "TERMINATION_UNKNOWN";
  value.serving = false;
  value.stopComplete = false;
  value.conditions.accessDenied = {
    status: "confirmed",
    observedAt: null,
    recordedAt: "2026-09-06T12:00:00.000Z",
    reasonCode: "AUTHORITY_DENIED",
  };
  value.conditions.executionTerminated = {
    status: "unknown",
    observedAt: null,
    recordedAt: null,
    reasonCode: "TERMINATION_UNKNOWN",
  };
  value.conditions.credentialRevocation = {
    status: "pending",
    observedAt: null,
    recordedAt: "2026-09-06T12:00:00.000Z",
    reasonCode: "CREDENTIAL_OUTCOME_UNKNOWN",
  };
  value.conditions.stateRetention = {
    status: "confirmed",
    observedAt: null,
    recordedAt: "2026-09-06T12:00:00.000Z",
    reasonCode: "NONE",
  };
  value.retention = "retained";
  const output = project("readStatus", lifecycleScopeFixture(), {
    kind: "read",
    value,
    writersReleased: true,
    cancellationRequested: true,
  });
  assert.equal(output.kind, "read");
  assert.equal(output.value.stopComplete, false);
  assert.equal(output.value.retention, "retained");
  assertUnavailable("readStatus", lifecycleScopeFixture(), {
    kind: "read",
    value: { ...value, stopComplete: true },
  });
});

test("historical operation source timestamps and requested revision remain unchanged", () => {
  const operation = lifecycleOperationFixture();
  const observation = lifecycleObservationFixture({
    phase: "converged",
    reasonCode: "NONE",
    observedAt: "2020-01-01T00:00:00.000Z",
    recordedAt: "2020-01-01T00:00:00.100Z",
    retryAt: null,
  });
  const request = {
    schemaVersion: 1,
    ...lifecycleScopeFixture(),
    operationRef: operation.operationRef,
  };
  const value = { operation, observation };
  const output = project("readOperation", request, {
    kind: "read",
    value,
    currentHeadGeneration: 900,
  });
  assert.equal(output.kind, "read");
  assert.deepEqual(plain(output.value), value);
  assertUnavailable("readOperation", request, {
    kind: "read",
    value: { disposition: "accepted", operation },
  });
});

test("full bounded pages redact detailed revisions while keeping order limit and cursor correspondence", () => {
  const operations = Array.from({ length: 100 }, (_, index) => ({
    ...lifecycleOperationFixture(),
    operationRef: id(1000 + index),
    lifecycleGeneration: index + 1,
    kind: "deploy",
    desiredMode: "running",
    revisionSource: "saved-draft",
  }));
  const request = lifecyclePageRequestFixture({ afterGeneration: null, limit: 100 });
  const output = project("listOperations", request, {
    kind: "read",
    value: { operations, nextAfterGeneration: 100, foreignCount: 10 },
  });
  assert.equal(output.kind, "read");
  assert.equal(output.value.operations.length, 100);
  assert.ok(output.value.operations.every((entry) => !Object.hasOwn(entry, "requestedRevisionId")));
  assertUnavailable(
    "listOperations",
    { ...request, limit: 99 },
    { kind: "read", value: { operations, nextAfterGeneration: 100 } },
  );
  assertUnavailable("listOperations", request, {
    kind: "read",
    value: { operations: [...operations, operations[0]], nextAfterGeneration: 100 },
  });
  assertUnavailable("listOperations", request, {
    kind: "read",
    value: { operations: [...operations].reverse(), nextAfterGeneration: 1 },
  });
  assertUnavailable("listOperations", request, {
    kind: "read",
    value: { operations, nextAfterGeneration: 99 },
  });
  assertUnavailable(
    "listOperations",
    { ...request, afterGeneration: 1 },
    { kind: "read", value: { operations, nextAfterGeneration: 100 } },
  );
  assert.equal(
    project("listOperations", request, {
      kind: "read",
      value: { operations: operations.slice(0, 1), nextAfterGeneration: 1 },
    }).kind,
    "read",
  );
});

test("sparse or accessor array elements fail without iteration hooks", () => {
  const entry = caseFor("listOperations");
  let calls = 0;
  const sparse = new Array(1);
  assertUnavailable("listOperations", entry.request, {
    kind: "read",
    value: { operations: sparse, nextAfterGeneration: null },
  });
  const array = [lifecycleOperationFixture()];
  Object.defineProperty(array, "0", {
    enumerable: true,
    get() {
      calls++;
      throw Error("private");
    },
  });
  assertUnavailable("listOperations", entry.request, {
    kind: "read",
    value: { operations: array, nextAfterGeneration: null },
  });
  const empty = [];
  Object.defineProperty(empty, Symbol.iterator, {
    get() {
      calls++;
      throw Error("private");
    },
  });
  assert.equal(
    project("listOperations", entry.request, {
      kind: "read",
      value: { operations: empty, nextAfterGeneration: null },
    }).kind,
    "read",
  );
  assert.equal(calls, 0);
});

test("all compatibility stages retain declared versions and never acquire authority flags", () => {
  for (const stage of ["legacy", "drain", "live"]) {
    const value = lifecycleCapabilityFixture(stage);
    const output = project("readCapability", lifecycleScopeFixture(), {
      kind: "read",
      value: { ...value, authorized: true, oldWritersExcluded: true },
    });
    assert.equal(output.kind, "read");
    assert.deepEqual(plain(output.value), value);
  }
});

test("output is detached and deeply immutable without freezing backend records", () => {
  for (const method of ["readStatus", "readOperation", "listOperations", "readCapability"]) {
    const entry = caseFor(method);
    const expected = plain(entry.result);
    const output = project(method, entry.request, entry.result);
    for (const [, node] of objects(output)) assert.ok(Object.isFrozen(node));
    assert.equal(Object.isFrozen(entry.result), false);
    for (const [, node] of objects(entry.result)) {
      assert.equal(Object.isFrozen(node), false);
      if (!Array.isArray(node)) {
        node.privateMutation = true;
        for (const [key, value] of Object.entries(node))
          if (typeof value === "string") node[key] = "mutated-backend-value";
      }
    }
    assert.deepEqual(plain(output), expected);
  }
});

test("selected byte bounds reject oversized public values while huge dropped data stays unvisited", () => {
  const entry = caseFor("readStatus");
  const oversized = "x".repeat(LIFECYCLE_STATUS_PROJECTION_LIMITS_V1.maxJsonBytes + 1);
  assertUnavailable(
    "readStatus",
    entry.request,
    modify(entry.result, (v) => {
      v.value.namespaceId = oversized;
    }),
  );
  assert.deepEqual(
    plain(
      project("readStatus", entry.request, {
        ...entry.result,
        privateTranscript: oversized,
        protectedBytes: new Uint8Array(512),
      }),
    ),
    entry.result,
  );
  for (const value of [undefined, null, true, 1n, "{}", new Uint8Array([123, 125])])
    assertUnavailable("readStatus", entry.request, value);
});

test("distinct revisions and stale observed generation cannot be promoted into serving", () => {
  const value = lifecycleStatusFixture();
  assert.equal(value.head.lifecycleGeneration, 4);
  assert.equal(value.observedLifecycleGeneration, 3);
  assert.notEqual(value.requestedRevisionId, value.selectedRevisionId);
  assert.notEqual(value.selectedRevisionId, value.servingRevisionId);
  const output = project("readStatus", lifecycleScopeFixture(), { kind: "read", value });
  assert.equal(output.kind, "read");
  assert.equal(output.value.serving, false);
  assert.equal(output.value.observedLifecycleGeneration, 3);
  assertUnavailable("readStatus", lifecycleScopeFixture(), {
    kind: "read",
    value: { ...value, serving: true },
  });
  assertUnavailable("readStatus", lifecycleScopeFixture(), {
    kind: "read",
    value: { ...value, serving: true, observedLifecycleGeneration: value.head.lifecycleGeneration },
  });
});

test("portable JSON read cases and separate minimal mutation results retain original contracts", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../fixtures/lifecycle-status-projector-v1/sanitized.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(fixture.format, "lifecycle-status-fixtures-v1");
  assert.equal(fixture.readCases.length, 18);
  for (const entry of fixture.readCases) {
    assert.deepEqual(
      plain(project(entry.method, entry.request, entry.result)),
      entry.result,
      entry.label,
    );
  }
  assert.equal(fixture.mutationResults.length, 4);
  assert.deepEqual(
    fixture.mutationResults.map((entry) => entry.value.kind).sort(),
    ["accepted", "unchanged", "conflict", "commit-unknown"].sort(),
  );
  for (const entry of fixture.mutationResults) {
    assert.deepEqual(
      plain(parseLifecycleAdmissionV1("mutationResult", entry.value)),
      entry.value,
      entry.label,
    );
    assertUnavailable("readStatus", lifecycleScopeFixture(), entry.value);
    assertUnavailable("readStatus", lifecycleScopeFixture(), { kind: "read", value: entry.value });
    if (entry.value.kind === "accepted")
      assert.equal(Object.hasOwn(entry.value.receipt.operation, "requestedRevisionId"), false);
  }
});
