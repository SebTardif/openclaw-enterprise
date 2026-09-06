import assert from "node:assert/strict";
import test from "node:test";
import {
  LifecycleAdmissionErrorV1,
  parseLifecycleAdmissionV1,
} from "../../packages/contracts/src/lifecycle-admission-v1.ts";
import {
  LifecycleWorkErrorV1,
  inspectInstalledLifecycleWorkV1,
  lifecycleAssociationsEqualV1,
  lifecycleWorkMatchesAssociationV1,
  lifecycleWorkSnapshotPreflightV1,
  parseControllerWorkV1,
  parsePlatformOperationV1,
  parseReconcileAgentLifecycleV1,
  parseWorkClaimV1,
} from "../../packages/occ/src/lifecycle/work-v1.ts";

// Synthetic data exercises parsers and snapshot comparisons only. No fixture
// creates a queue, authority producer, transaction, or accepting effect boundary.
const ref = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const ids = {
  installationId: `ins_${ref(1)}`,
  namespaceId: `ns_${ref(2)}`,
  agentId: `agt_${ref(3)}`,
  revisionId: `rev_${ref(4)}`,
  auditEventId: `aud_${ref(5)}`,
  requestId: `req_${ref(6)}`,
};
const instant = "2026-01-01T00:00:00.000Z";
const now = () => new Date(instant);
const clone = (value) => structuredClone(value);
const parseAssociation = (value) => parseLifecycleAdmissionV1("association", value);
function association() {
  return {
    schemaVersion: 1,
    request: {
      schemaVersion: 1,
      kind: "deploy",
      namespaceId: ids.namespaceId,
      agentId: ids.agentId,
      expectedLifecycleGeneration: 2,
    },
    intent: {
      installationId: ids.installationId,
      namespaceId: ids.namespaceId,
      agentId: ids.agentId,
      transitionRef: ref(7),
      generation: 3,
      desiredMode: "running",
      revisionId: ids.revisionId,
      actorId: "principal/example",
      requestId: ids.requestId,
      createdAt: instant,
    },
    auditEventId: ids.auditEventId,
    workId: `agent_revision:${ids.revisionId}:reconcile`,
  };
}
function payload(value = association()) {
  return {
    schemaVersion: 1,
    handler: "ReconcileAgentLifecycleV1",
    namespaceId: value.intent.namespaceId,
    agentId: value.intent.agentId,
    operationRef: value.intent.transitionRef,
    lifecycleGeneration: value.intent.generation,
    workId: value.workId,
  };
}
function operation(value = association()) {
  return {
    action: "reconcile",
    kind: "agent_revision",
    namespaceId: value.intent.namespaceId,
    resourceId: value.intent.revisionId,
    actorId: value.intent.actorId,
    runtimeTransitionRef: value.intent.transitionRef,
    lifecycleGeneration: value.intent.generation,
  };
}
function work(state = "claimed", value = association()) {
  return {
    idempotencyKey: value.workId,
    namespaceId: value.intent.namespaceId,
    agentId: value.intent.agentId,
    revisionId: value.intent.revisionId,
    actorId: value.intent.actorId,
    runtimeTransitionRef: value.intent.transitionRef,
    lifecycleGeneration: value.intent.generation,
    state,
    availableAt: now(),
    attemptCount: 1,
    createdAt: now(),
    updatedAt: now(),
    ...(state === "claimed"
      ? { claimToken: ref(8), leaseExpiresAt: new Date("2026-01-01T00:01:00.000Z") }
      : {}),
    ...(state === "succeeded" || state === "failed_permanent" ? { completedAt: now() } : {}),
  };
}
function claim() {
  return { idempotencyKey: association().workId, claimToken: ref(8) };
}
function preflight(overrides = {}) {
  const a = association();
  const values = {
    input: payload(a),
    association: a,
    operation: operation(a),
    work: work(),
    currentHead: a.intent,
    claim: claim(),
    installationId: ids.installationId,
    now: now(),
    ...overrides,
  };
  return lifecycleWorkSnapshotPreflightV1(
    values.input,
    values.association,
    values.operation,
    values.work,
    values.currentHead,
    values.claim,
    values.installationId,
    values.now,
  );
}
function invalidWork(run) {
  assert.throws(
    run,
    (error) => error instanceof LifecycleWorkErrorV1 && error.code === "INVALID_WORK",
  );
}
function invalidCanonical(run) {
  assert.throws(run, LifecycleAdmissionErrorV1);
}

test("inert lifecycle payload is closed, frozen and independent of installed operation kinds", () => {
  const input = payload();
  const parsed = parseReconcileAgentLifecycleV1(input);
  assert.deepEqual(clone(parsed), input);
  assert.ok(Object.isFrozen(parsed));
  assert.notEqual(parsed, input);
  input.workId = "different-work";
  assert.equal(parsed.workId, association().workId);
  invalidWork(() => parsePlatformOperationV1(parsed));
  for (const key of Object.keys(payload())) {
    const missing = payload();
    delete missing[key];
    invalidCanonical(() => parseReconcileAgentLifecycleV1(missing));
  }
  for (const key of [
    "actorId",
    "requestId",
    "auditEventId",
    "installationId",
    "revisionId",
    "runtimeUrl",
    "selectedPeer",
    "trusted",
    "claimToken",
  ]) {
    invalidCanonical(() => parseReconcileAgentLifecycleV1({ ...payload(), [key]: "injected" }));
  }
});

test("transition locator, generation and original work identity cannot be substituted or downgraded", () => {
  for (const [key, value] of [
    ["schemaVersion", 2],
    ["handler", "agent_revision"],
    ["operationRef", ids.revisionId],
    ["operationRef", ref(7).toUpperCase().replace("4000", "4ABC")],
    ["lifecycleGeneration", null],
    ["lifecycleGeneration", 0],
    ["lifecycleGeneration", "3"],
    ["lifecycleGeneration", 1.5],
    ["lifecycleGeneration", Number.MAX_SAFE_INTEGER + 1],
    ["workId", null],
    ["workId", ""],
    ["workId", "x".repeat(513)],
    ["namespaceId", ids.agentId],
    ["agentId", ids.namespaceId],
  ])
    invalidCanonical(() => parseReconcileAgentLifecycleV1({ ...payload(), [key]: value }));
  const opaque = { ...payload(), workId: "original/work/item" };
  assert.equal(parseReconcileAgentLifecycleV1(opaque).workId, opaque.workId);
  assert.equal(
    parseReconcileAgentLifecycleV1({ ...payload(), lifecycleGeneration: Number.MAX_SAFE_INTEGER })
      .lifecycleGeneration,
    Number.MAX_SAFE_INTEGER,
  );
});

test("installed work parser preserves all four real states and copies Date values", () => {
  for (const state of ["queued", "claimed", "succeeded", "failed_permanent"]) {
    const input = work(state);
    const parsed = parseControllerWorkV1(input);
    assert.deepEqual(parsed, input);
    assert.ok(Object.isFrozen(parsed));
    for (const key of ["availableAt", "createdAt", "updatedAt", "leaseExpiresAt", "completedAt"]) {
      if (!(key in input)) continue;
      assert.ok(parsed[key] instanceof Date);
      assert.notEqual(parsed[key], input[key]);
      input[key].setTime(0);
      assert.notEqual(parsed[key].getTime(), 0);
    }
  }
});

test("installed namespace and unassociated revision formats stay explicit", () => {
  const namespace = work("queued");
  for (const key of ["agentId", "revisionId", "runtimeTransitionRef", "lifecycleGeneration"])
    delete namespace[key];
  namespace.namespaceTarget = "ready";
  assert.deepEqual(parseControllerWorkV1(namespace), namespace);
  assert.equal(
    parseControllerWorkV1({ ...namespace, namespaceTarget: "deleted" }).namespaceTarget,
    "deleted",
  );
  const legacy = work("queued");
  delete legacy.runtimeTransitionRef;
  delete legacy.lifecycleGeneration;
  assert.deepEqual(parseControllerWorkV1(legacy), legacy);
  const op = {
    action: "reconcile",
    kind: "namespace",
    namespaceId: ids.namespaceId,
    resourceId: ids.namespaceId,
    actorId: "principal/example",
    target: "ready",
  };
  assert.deepEqual(parsePlatformOperationV1(op), op);
  invalidWork(() =>
    parsePlatformOperationV1({ ...op, runtimeTransitionRef: ref(7), lifecycleGeneration: 3 }),
  );
});

test("installed snapshot parsers reject partial ownership, association and claim states", () => {
  for (const key of Object.keys(work())) {
    const value = work();
    delete value[key];
    invalidWork(() => parseControllerWorkV1(value));
  }
  for (const [key, value] of [
    ["state", "future-kind"],
    ["attemptCount", -1],
    ["attemptCount", 1.1],
    ["attemptCount", Number.MAX_SAFE_INTEGER + 1],
    ["namespaceTarget", "ready"],
    ["revisionId", null],
    ["runtimeTransitionRef", null],
    ["lifecycleGeneration", null],
    ["lifecycleGeneration", 0],
    ["lifecycleGeneration", "3"],
    ["claimToken", "not-a-claim"],
    ["leaseExpiresAt", instant],
    ["availableAt", new Date(NaN)],
    ["completedAt", now()],
    ["idempotencyKey", "x".repeat(513)],
    ["actorId", ""],
    ["extra", "data"],
  ])
    invalidWork(() => parseControllerWorkV1({ ...work(), [key]: value }));
  invalidWork(() => parseControllerWorkV1({ ...work("queued"), claimToken: ref(8) }));
  invalidWork(() => parseControllerWorkV1({ ...work("queued"), leaseExpiresAt: now() }));
  invalidWork(() => parseControllerWorkV1({ ...work("queued"), completedAt: now() }));
  invalidWork(() => parseControllerWorkV1({ ...work("succeeded"), completedAt: undefined }));
  const namespace = work("queued");
  delete namespace.agentId;
  delete namespace.revisionId;
  namespace.namespaceTarget = "ready";
  invalidWork(() => parseControllerWorkV1(namespace));
});

test("installed operation and claim parsers reject unknown fields and partial lifecycle pairs", () => {
  assert.deepEqual(parsePlatformOperationV1(operation()), operation());
  for (const key of Object.keys(operation())) {
    const value = operation();
    delete value[key];
    invalidWork(() => parsePlatformOperationV1(value));
  }
  for (const patch of [
    { kind: "ReconcileAgentLifecycleV1" },
    { action: "delete" },
    { target: "ready" },
    { lifecycleGeneration: 0 },
    { runtimeTransitionRef: ref(7).replace("4000", "5000") },
    { extra: true },
  ])
    invalidWork(() => parsePlatformOperationV1({ ...operation(), ...patch }));
  const legacy = operation();
  delete legacy.runtimeTransitionRef;
  delete legacy.lifecycleGeneration;
  assert.deepEqual(parsePlatformOperationV1(legacy), legacy);
  assert.deepEqual(parseWorkClaimV1(claim()), claim());
  for (const value of [
    { idempotencyKey: claim().idempotencyKey },
    { claimToken: ref(8) },
    { ...claim(), claimToken: null },
    { ...claim(), leaseExpiresAt: now() },
    { ...claim(), idempotencyKey: "" },
  ])
    invalidWork(() => parseWorkClaimV1(value));
});

test("installed parsers do not invoke accessor properties or expose malformed data", () => {
  for (const [parse, input] of [
    [parseControllerWorkV1, work()],
    [parsePlatformOperationV1, operation()],
    [parseWorkClaimV1, claim()],
  ]) {
    const valid = clone(input);
    let calls = 0;
    const key = Object.keys(input)[0];
    Object.defineProperty(input, key, {
      enumerable: true,
      get() {
        calls++;
        return "private-input-marker";
      },
    });
    invalidWork(() => parse(input));
    assert.equal(calls, 0);
    for (const value of [null, [], "private-input-marker", { ...valid, [Symbol("extra")]: true }]) {
      assert.throws(
        () => parse(value),
        (error) =>
          error instanceof LifecycleWorkErrorV1 && !error.message.includes("private-input-marker"),
      );
    }
  }
});

test("snapshot parsers reject proxies and invalid Date slots with bounded errors", () => {
  let traps = 0;
  const handler = {
    getPrototypeOf() {
      traps++;
      throw new Error("private-input-marker");
    },
    ownKeys() {
      traps++;
      throw new Error("private-input-marker");
    },
    get() {
      traps++;
      throw new Error("private-input-marker");
    },
  };
  for (const [parse, input] of [
    [parseControllerWorkV1, work()],
    [parsePlatformOperationV1, operation()],
    [parseWorkClaimV1, claim()],
  ]) {
    invalidWork(() => parse(new Proxy(input, handler)));
    const revoked = Proxy.revocable(input, handler);
    revoked.revoke();
    invalidWork(() => parse(revoked.proxy));
  }
  for (const malformed of [
    Object.create(Date.prototype),
    new Proxy(now(), handler),
    new Date(NaN),
  ]) {
    invalidWork(() => parseControllerWorkV1({ ...work(), availableAt: malformed }));
    invalidWork(() => preflight({ now: malformed }));
  }
  assert.equal(traps, 0);
  const specialDate = now();
  specialDate.getTime = () => {
    throw new Error("must not execute");
  };
  assert.equal(
    parseControllerWorkV1({ ...work(), availableAt: specialDate }).availableAt.getTime(),
    now().getTime(),
  );
});

test("full original association equality checks every immutable owner and attribution field", () => {
  const original = association();
  assert.deepEqual(clone(parseAssociation(original)), original);
  const reordered = {
    workId: original.workId,
    auditEventId: original.auditEventId,
    intent: { ...original.intent },
    request: { ...original.request },
    schemaVersion: 1,
  };
  assert.equal(lifecycleAssociationsEqualV1(original, reordered), true);
  const variants = [
    (a) => {
      a.intent.installationId = `ins_${ref(20)}`;
    },
    (a) => {
      a.intent.namespaceId = a.request.namespaceId = `ns_${ref(20)}`;
    },
    (a) => {
      a.intent.agentId = a.request.agentId = `agt_${ref(20)}`;
    },
    (a) => {
      a.intent.transitionRef = ref(20);
    },
    (a) => {
      a.intent.generation++;
      a.request.expectedLifecycleGeneration++;
    },
    (a) => {
      a.intent.revisionId = `rev_${ref(20)}`;
    },
    (a) => {
      a.intent.actorId = "principal/another";
    },
    (a) => {
      a.intent.requestId = `req_${ref(20)}`;
    },
    (a) => {
      a.intent.createdAt = "2026-01-01T00:00:01.000Z";
    },
    (a) => {
      a.auditEventId = `aud_${ref(20)}`;
    },
    (a) => {
      a.workId = "another-original-work";
    },
    (a) => {
      a.request.kind = "resume";
      a.request.revisionSource = "saved-draft";
    },
    (a) => {
      a.request.kind = "disable";
      a.intent.desiredMode = "disabled";
    },
  ];
  for (const change of variants) {
    const value = association();
    change(value);
    parseAssociation(value);
    assert.equal(lifecycleAssociationsEqualV1(original, value), false);
  }
  const resume = association();
  resume.request.kind = "resume";
  resume.request.revisionSource = "retained";
  assert.equal(
    lifecycleAssociationsEqualV1(resume, {
      ...resume,
      request: { ...resume.request, revisionSource: "saved-draft" },
    }),
    false,
  );
});

test("partial or internally mismatched retained associations never confirm history", () => {
  for (const key of Object.keys(association())) {
    const value = association();
    delete value[key];
    invalidCanonical(() => lifecycleAssociationsEqualV1(association(), value));
  }
  for (const part of ["intent", "request"])
    for (const key of Object.keys(association()[part])) {
      const value = association();
      delete value[part][key];
      invalidCanonical(() => lifecycleWorkMatchesAssociationV1(payload(), value));
    }
  const foreign = association();
  foreign.intent.agentId = `agt_${ref(30)}`;
  invalidCanonical(() => lifecycleAssociationsEqualV1(association(), foreign));
  const nullRevision = association();
  nullRevision.intent.revisionId = null;
  invalidCanonical(() => lifecycleWorkMatchesAssociationV1(payload(), nullRevision));
});

test("payload correspondence requires exact target, operation, generation and original work", () => {
  assert.equal(lifecycleWorkMatchesAssociationV1(payload(), association()), true);
  for (const patch of [
    { namespaceId: `ns_${ref(30)}` },
    { agentId: `agt_${ref(30)}` },
    { operationRef: ref(30) },
    { lifecycleGeneration: 4 },
    { workId: "different-work" },
  ]) {
    assert.equal(
      lifecycleWorkMatchesAssociationV1({ ...payload(), ...patch }, association()),
      false,
    );
  }
});

test("original installed deploy correspondence survives terminal work and changing queue metadata", () => {
  for (const state of ["queued", "claimed", "succeeded", "failed_permanent"]) {
    const row = work(state);
    row.attemptCount = 9;
    row.updatedAt = new Date("2026-01-02T00:00:00.000Z");
    assert.equal(
      inspectInstalledLifecycleWorkV1(payload(), association(), operation(), row),
      "matches-installed-deploy",
    );
  }
});

test("installed deploy correspondence rejects every available owner, actor and identity mismatch", () => {
  for (const [part, patch] of [
    ["work", { idempotencyKey: "different-work" }],
    ["work", { namespaceId: `ns_${ref(30)}` }],
    ["work", { agentId: `agt_${ref(30)}` }],
    ["work", { revisionId: `rev_${ref(30)}` }],
    ["work", { actorId: "principal/another" }],
    ["work", { runtimeTransitionRef: ref(30) }],
    ["work", { lifecycleGeneration: 4 }],
    ["operation", { namespaceId: `ns_${ref(30)}` }],
    ["operation", { resourceId: `rev_${ref(30)}` }],
    ["operation", { actorId: "principal/another" }],
    ["operation", { runtimeTransitionRef: ref(30) }],
    ["operation", { lifecycleGeneration: 4 }],
  ]) {
    const row = work(),
      op = operation();
    Object.assign(part === "work" ? row : op, patch);
    assert.equal(
      inspectInstalledLifecycleWorkV1(payload(), association(), op, row),
      "association-mismatch",
    );
  }
  const namespaceOp = {
    action: "reconcile",
    kind: "namespace",
    namespaceId: ids.namespaceId,
    resourceId: ids.namespaceId,
    actorId: association().intent.actorId,
    target: "ready",
  };
  assert.equal(
    inspectInstalledLifecycleWorkV1(payload(), association(), namespaceOp, work()),
    "association-mismatch",
  );
});

test("absent legacy association and maintenance keys cannot become original lifecycle work", () => {
  for (const part of ["work", "operation"]) {
    const row = work(),
      op = operation();
    const value = part === "work" ? row : op;
    delete value.runtimeTransitionRef;
    delete value.lifecycleGeneration;
    assert.equal(
      inspectInstalledLifecycleWorkV1(payload(), association(), op, row),
      "association-mismatch",
    );
  }
  const a = association();
  a.workId = `agent_revision:${ids.revisionId}:maintenance:123`;
  assert.equal(lifecycleWorkMatchesAssociationV1(payload(a), a), true);
  assert.equal(
    inspectInstalledLifecycleWorkV1(payload(a), a, operation(a), work("claimed", a)),
    "association-mismatch",
  );
  assert.equal(
    inspectInstalledLifecycleWorkV1(
      { ...payload(), operationRef: ref(30) },
      association(),
      operation(),
      work(),
    ),
    "association-mismatch",
  );
});

test("protective null and both resume sources remain inert and unsupported by the installed queue", () => {
  for (const [kind, desiredMode] of [
    ["disable", "disabled"],
    ["stop", "stopped"],
  ]) {
    for (const initial of [false, true]) {
      const a = association();
      a.request.kind = kind;
      a.intent.desiredMode = desiredMode;
      a.intent.revisionId = null;
      if (initial) {
        a.request.expectedLifecycleGeneration = null;
        a.intent.generation = 1;
      }
      parseAssociation(a);
      assert.equal(lifecycleWorkMatchesAssociationV1(payload(a), a), true);
      assert.equal(
        inspectInstalledLifecycleWorkV1(payload(a), a, operation(), work()),
        "unsupported-transition",
      );
      assert.equal(
        preflight({ input: payload(a), association: a, currentHead: a.intent }),
        "unsupported-transition",
      );
    }
    const selected = association();
    selected.request.kind = kind;
    selected.intent.desiredMode = desiredMode;
    assert.equal(
      inspectInstalledLifecycleWorkV1(payload(selected), selected, operation(), work()),
      "unsupported-transition",
    );
  }
  for (const revisionSource of ["retained", "saved-draft"]) {
    const a = association();
    a.request.kind = "resume";
    a.request.revisionSource = revisionSource;
    parseAssociation(a);
    assert.equal(
      inspectInstalledLifecycleWorkV1(payload(a), a, operation(a), work("claimed", a)),
      "unsupported-transition",
    );
  }
  invalidWork(() => parseControllerWorkV1({ ...work(), revisionId: null }));
});

test("claim preflight uses exact original identity and a strictly future lease snapshot", () => {
  assert.equal(preflight(), "snapshot-matches");
  for (const milliseconds of [-1, 0, 1]) {
    const row = work();
    row.leaseExpiresAt = new Date(now().getTime() + milliseconds);
    assert.equal(
      preflight({ work: row }),
      milliseconds === 1 ? "snapshot-matches" : "claim-mismatch",
    );
  }
  assert.equal(preflight({ claim: { ...claim(), claimToken: ref(40) } }), "claim-mismatch");
  assert.equal(
    preflight({ claim: { ...claim(), idempotencyKey: "different-work" } }),
    "claim-mismatch",
  );
  for (const state of ["queued", "succeeded", "failed_permanent"])
    assert.equal(preflight({ work: work(state) }), "claim-mismatch");
  assert.equal(preflight({ installationId: `ins_${ref(40)}` }), "association-mismatch");
  assert.equal(preflight({ currentHead: null }), "head-mismatch");
  for (const value of [new Date(NaN), instant, null, undefined, {}, Number.NaN])
    invalidWork(() => preflight({ now: value }));
});

test("head advancement cannot erase historical acceptance or authorize old work", () => {
  const original = association();
  const later = association();
  later.request.expectedLifecycleGeneration = 3;
  later.intent.generation = 4;
  later.intent.transitionRef = ref(40);
  later.request.kind = "stop";
  later.intent.desiredMode = "stopped";
  parseAssociation(later);
  assert.equal(lifecycleAssociationsEqualV1(original, clone(original)), true);
  assert.equal(
    inspectInstalledLifecycleWorkV1(payload(original), original, operation(), work("succeeded")),
    "matches-installed-deploy",
  );
  assert.equal(preflight({ currentHead: later.intent }), "head-mismatch");
  assert.equal(preflight({ currentHead: later.intent, work: work("succeeded") }), "head-mismatch");
  for (const patch of [
    { installationId: `ins_${ref(40)}` },
    { namespaceId: `ns_${ref(40)}` },
    { agentId: `agt_${ref(40)}` },
    { actorId: "principal/another" },
    { requestId: `req_${ref(40)}` },
    { revisionId: `rev_${ref(40)}` },
    { createdAt: "2026-01-01T00:00:01.000Z" },
  ])
    assert.equal(preflight({ currentHead: { ...original.intent, ...patch } }), "head-mismatch");
});

test("a prior snapshot result cannot substitute for the next claim or head comparison", () => {
  const row = work();
  const before = clone(row);
  assert.equal(preflight({ work: row }), "snapshot-matches");
  assert.deepEqual(row, before);
  assert.equal(
    preflight({ work: row, now: new Date("2026-01-01T00:02:00.000Z") }),
    "claim-mismatch",
  );
  row.claimToken = ref(50);
  assert.equal(preflight({ work: row }), "claim-mismatch");
  const next = { ...association().intent, generation: 4, transitionRef: ref(50) };
  assert.equal(preflight({ currentHead: next }), "head-mismatch");
});
