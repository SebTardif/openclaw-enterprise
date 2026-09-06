import assert from "node:assert/strict";
import test from "node:test";
import {
  LifecycleObservationErrorV1,
  parseLifecycleObservationV1,
  parseLifecycleObservationResponseV1,
} from "../../packages/contracts/src/lifecycle-observation-v1.ts";

// Independently constructed data tests canonical request/response correspondence.
// No producer, authenticated context, queue, writer or effect is implemented here.
const ref = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const scope = () => ({ namespaceId: `ns_${ref(1)}`, agentId: `agt_${ref(2)}` });
const revisionId = `rev_${ref(3)}`;
const sourceTime = "2026-01-01T00:00:00.000Z";
const receiptTime = "2026-01-01T00:00:01.000Z";
const plain = (value) => structuredClone(value);
const parse = parseLifecycleObservationResponseV1;
function rejects(method, request, input) {
  assert.throws(() => parse(method, request, input), LifecycleObservationErrorV1);
}
function condition() {
  return { status: "unknown", observedAt: null, recordedAt: null, reasonCode: "NOT_OBSERVED" };
}
function status() {
  return {
    ...scope(),
    head: null,
    requestedRevisionId: null,
    selectedRevisionId: null,
    servingRevisionId: null,
    observedLifecycleGeneration: null,
    phase: "pending",
    attempt: 0,
    step: "observe",
    reasonCode: "LIFECYCLE_UNINITIALIZED",
    retryAt: null,
    conditions: {
      accessDenied: condition(),
      routeRemoved: condition(),
      executionTerminated: condition(),
      credentialRevocation: {
        status: "not-requested",
        observedAt: null,
        recordedAt: null,
        reasonCode: "NOT_REQUESTED",
      },
      stateRetention: condition(),
    },
    serving: false,
    stopComplete: false,
    retention: "verification-pending",
  };
}
function operation(generation = 7) {
  return {
    operationRef: ref(100 + generation),
    kind: "deploy",
    revisionSource: "saved-draft",
    lifecycleGeneration: generation,
    desiredMode: "running",
    acceptedAt: sourceTime,
  };
}
function observation() {
  return {
    phase: "blocked",
    attempt: 2,
    step: "observe",
    reasonCode: "DEPENDENCY_UNAVAILABLE",
    observedAt: sourceTime,
    recordedAt: receiptTime,
    retryAt: null,
  };
}
function operationRead(generation = 7) {
  return {
    operation: { ...operation(generation), requestedRevisionId: revisionId },
    observation: observation(),
  };
}
function exactRequest(generation = 7) {
  return { schemaVersion: 1, ...scope(), operationRef: operation(generation).operationRef };
}
function pageRequest(overrides = {}) {
  return { schemaVersion: 1, ...scope(), afterGeneration: null, limit: 2, ...overrides };
}
function work() {
  return {
    schemaVersion: 1,
    handler: "ReconcileAgentLifecycleV1",
    ...scope(),
    operationRef: operation().operationRef,
    lifecycleGeneration: 7,
    workId: "original/lifecycle/work",
  };
}
function capability(stage = "live") {
  return {
    schemaVersion: 1,
    protocol: "lifecycle-control-v1",
    stage,
    capabilityVersion: 1,
    supportedConsumerVersions: {
      api: 1,
      worker: 1,
      maintenance: stage === "live" ? 1 : null,
      receiving: 1,
    },
  };
}
function effectUnknown() {
  return {
    schemaVersion: 1,
    kind: "effect-unknown",
    work: work(),
    step: "prepare",
    phase: "provider-response",
    selectedRequestStartedAt: sourceTime,
    selectedRequestDeadlineAt: "2026-01-01T00:00:10.000Z",
    recordedAt: "2026-01-01T00:00:11.000Z",
    reasonCode: "CREATE_OUTCOME_UNKNOWN",
    effect: {
      schemaVersion: 1,
      target: {
        installationId: `ins_${ref(4)}`,
        ...scope(),
        assignmentRef: { schemaVersion: 1, id: ref(5) },
        revisionId,
        component: "harness",
        lifecycleGeneration: 7,
        runtimeGeneration: 11,
        createEffectRef: ref(6),
      },
      effectRef: ref(6),
      effectKind: "materialize",
      responsibility: { responsibilityRef: ref(8), responsibilityVersion: 1, kind: "preparation" },
      requestDigest: `sha256:${"a".repeat(64)}`,
    },
  };
}

test("status response matches both scoped request IDs and preserves the exact public projection", () => {
  const input = status();
  assert.deepEqual(plain(parse("readStatus", scope(), input)), input);
  for (const field of ["namespaceId", "agentId"]) {
    const other = { ...scope(), [field]: `${field === "namespaceId" ? "ns" : "agt"}_${ref(20)}` };
    rejects("readStatus", other, input);
    rejects("readStatus", scope(), { ...input, ...other });
  }
  for (const request of [
    null,
    {},
    { ...scope(), installationId: `ins_${ref(4)}` },
    { ...scope(), operationRef: ref(7) },
  ])
    rejects("readStatus", request, input);
  assert.equal(input.serving, false);
  assert.equal(input.stopComplete, false);
});

test("exact operation read retains original identity and historical source time", () => {
  const input = operationRead();
  input.observation.phase = "superseded";
  input.observation.reasonCode = "SUPERSEDED";
  const result = parse("readOperation", exactRequest(), input);
  assert.deepEqual(plain(result), input);
  assert.equal(result.observation.observedAt, sourceTime);
  assert.equal(result.observation.recordedAt, receiptTime);
  assert.notEqual(result.observation.observedAt, result.observation.recordedAt);
  rejects("readOperation", exactRequest(8), input);
  rejects("readOperation", exactRequest(), operationRead(8));
  rejects("readOperation", { ...exactRequest(), operationRef: null }, input);
  rejects("readOperation", { ...exactRequest(), requestId: `req_${ref(9)}` }, input);
  // Public operation fields omit owner scope. Shape/correspondence cannot replace
  // the reader's actual exact owner restriction and current authorization.
  assert.equal(Object.hasOwn(result.operation, "namespaceId"), false);
  assert.equal(Object.hasOwn(result.operation, "agentId"), false);
});

test("operation pages enforce requested cursor and limit without adding protected details", () => {
  const request = pageRequest({ afterGeneration: 6 });
  const input = { operations: [operation(7), operation(8)], nextAfterGeneration: 8 };
  const result = parse("listOperations", request, input);
  assert.deepEqual(plain(result), input);
  for (const entry of result.operations) {
    assert.equal(Object.hasOwn(entry, "requestedRevisionId"), false);
    assert.equal(Object.hasOwn(entry, "actorId"), false);
  }
  rejects("listOperations", { ...request, limit: 1 }, input);
  rejects("listOperations", { ...request, afterGeneration: 7 }, input);
  rejects("listOperations", { ...request, afterGeneration: 8 }, input);
  // A requested limit is a maximum, not a required page length. The retained
  // reader may return a shorter page with a cursor at its actual last row.
  const partial = { operations: [operation(7)], nextAfterGeneration: 7 };
  assert.deepEqual(plain(parse("listOperations", request, partial)), partial);
  rejects("listOperations", request, { ...partial, nextAfterGeneration: 8 });
  rejects("listOperations", request, { ...input, nextAfterGeneration: 9 });
  rejects("listOperations", request, {
    operations: [operation(8), operation(7)],
    nextAfterGeneration: null,
  });
  rejects("listOperations", request, {
    operations: [operation(7), operation(7)],
    nextAfterGeneration: null,
  });
  rejects("listOperations", request, {
    operations: [{ ...operation(7), requestedRevisionId: revisionId }],
    nextAfterGeneration: null,
  });
});

test("empty and final operation pages stay observations of a scoped read, not rollback receipts", () => {
  const empty = { operations: [], nextAfterGeneration: null };
  assert.deepEqual(
    plain(parse("listOperations", pageRequest({ afterGeneration: 99 }), empty)),
    empty,
  );
  const final = { operations: [operation(7)], nextAfterGeneration: null };
  assert.deepEqual(plain(parse("listOperations", pageRequest(), final)), final);
  for (const invalid of [
    { ...empty, aborted: true },
    { ...empty, outcome: "not-submitted" },
    { ...empty, nextAfterGeneration: 99 },
  ])
    rejects("listOperations", pageRequest(), invalid);
  for (const patch of [
    { limit: 0 },
    { limit: 101 },
    { afterGeneration: 0 },
    { afterGeneration: "7" },
    { afterGeneration: Number.MAX_SAFE_INTEGER + 1 },
  ])
    rejects("listOperations", pageRequest(patch), empty);
});

test("capability read validates scoped requests and supported versions without inventing an installed gate", () => {
  for (const stage of ["legacy", "drain", "live"])
    assert.deepEqual(plain(parse("readCapability", scope(), capability(stage))), capability(stage));
  rejects("readCapability", { ...scope(), installationId: `ins_${ref(4)}` }, capability());
  rejects("readCapability", {}, capability());
  rejects("readCapability", scope(), { ...capability(), schemaVersion: 2 });
  rejects("readCapability", scope(), {
    ...capability(),
    supportedConsumerVersions: { ...capability().supportedConsumerVersions, worker: 2 },
  });
  assert.equal(Object.hasOwn(parse("readCapability", scope(), capability()), "installed"), false);
});

test("handler failure response must retain every original work identity field", () => {
  const input = {
    schemaVersion: 1,
    kind: "unavailable",
    work: work(),
    reasonCode: "DEPENDENCY_UNAVAILABLE",
  };
  assert.deepEqual(plain(parse("reconcile", work(), input)), input);
  for (const patch of [
    { namespaceId: `ns_${ref(20)}` },
    { agentId: `agt_${ref(20)}` },
    { operationRef: ref(20) },
    { lifecycleGeneration: 8 },
    { workId: "another-work" },
  ]) {
    const wrong = { ...input, work: { ...work(), ...patch } };
    parseLifecycleObservationV1("handlerResult", wrong);
    rejects("reconcile", work(), wrong);
    rejects("reconcile", { ...work(), ...patch }, input);
  }
  for (const kind of ["conflict", "rejected"])
    assert.equal(parse("reconcile", work(), { ...input, kind }).kind, kind);
});

test("late unknown effect results preserve the exact original effect, responsibility and request interval", () => {
  const input = effectUnknown();
  const result = parse("reconcile", work(), input);
  assert.deepEqual(plain(result), input);
  assert.equal(result.kind, "effect-unknown");
  assert.equal(result.effect.effectRef, ref(6));
  assert.equal(result.effect.target.runtimeGeneration, 11);
  assert.equal(result.work.lifecycleGeneration, 7);
  assert.ok(Date.parse(result.recordedAt) > Date.parse(result.selectedRequestDeadlineAt));
  assert.ok(Object.isFrozen(result.effect.responsibility));
  input.effect.responsibility.responsibilityVersion = 2;
  assert.equal(result.effect.responsibility.responsibilityVersion, 1);
  rejects("reconcile", { ...work(), workId: "replacement-work" }, effectUnknown());
  rejects("reconcile", work(), { ...effectUnknown(), outcome: "absent" });
  rejects("reconcile", work(), { ...effectUnknown(), kind: "not-submitted" });
  rejects("reconcile", work(), {
    ...effectUnknown(),
    selectedRequestDeadlineAt: "2026-01-01T00:00:11.000Z",
  });
  const foreign = effectUnknown();
  foreign.effect.target.agentId = `agt_${ref(20)}`;
  rejects("reconcile", work(), foreign);
});

test("observed historical work and a later current head retain separate identities", () => {
  const current = status();
  current.head = {
    operationRef: ref(108),
    lifecycleGeneration: 8,
    desiredMode: "stopped",
    requestedRevisionId: revisionId,
  };
  current.requestedRevisionId = revisionId;
  current.observedLifecycleGeneration = 7;
  current.phase = "blocked";
  current.attempt = 3;
  current.reasonCode = "TERMINATION_UNKNOWN";
  current.step = "terminate-predecessor";
  const historical = { ...observation(), phase: "superseded", reasonCode: "SUPERSEDED" };
  const input = {
    schemaVersion: 1,
    kind: "observed",
    work: work(),
    observation: historical,
    status: current,
  };
  const result = parse("reconcile", work(), input);
  assert.equal(result.work.operationRef, ref(107));
  assert.equal(result.status.head.operationRef, ref(108));
  assert.equal(result.observation.phase, "superseded");
  assert.equal(result.status.stopComplete, false);
  assert.equal(result.status.serving, false);
  const terminal = parse("reconcile", work(), {
    ...input,
    observation: { ...historical, phase: "converged", reasonCode: "NONE", step: "publish" },
  });
  // Original convergence remains historical; it cannot establish the later
  // stopped head's completion or make its current status serving.
  assert.equal(terminal.work.operationRef, ref(107));
  assert.equal(terminal.observation.phase, "converged");
  assert.equal(terminal.status.head.operationRef, ref(108));
  assert.equal(terminal.status.stopComplete, false);
  assert.equal(terminal.status.serving, false);
  rejects("reconcile", { ...work(), operationRef: ref(108), lifecycleGeneration: 8 }, input);
  rejects("reconcile", work(), { ...input, observation: observation() });
});

test("response entrypoints reject cross-surface data and disclose only fixed errors", () => {
  rejects("readStatus", scope(), operationRead());
  rejects("readOperation", exactRequest(), status());
  rejects("listOperations", pageRequest(), { kind: "commit-unknown" });
  rejects("reconcile", work(), {
    disposition: "unchanged",
    lifecycleGeneration: 7,
    desiredMode: "stopped",
  });
  const marker = "untrusted-provider-detail";
  for (const method of ["toString", "unsupported", null]) {
    assert.throws(
      () => parse(method, { marker }, { marker }),
      (error) => error instanceof LifecycleObservationErrorV1 && !error.message.includes(marker),
    );
  }
});
