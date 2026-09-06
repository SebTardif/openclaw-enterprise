import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  LifecycleWorkCodecErrorV1,
  decodeLifecycleWorkV1,
  encodeLifecycleWorkV1,
} from "../../packages/occ/src/lifecycle/work-codec-v1.ts";
import { LifecycleWorkPreflightV1 } from "../../packages/occ/src/lifecycle/work-preflight-v1.ts";
import { instant, ref, vectors } from "../fixtures/lifecycle-work-preflight-v1/vectors.mjs";
import { LifecycleEffectGuard } from "../../apps/controller/src/worker/lifecycle-effect-guard.ts";
import {
  call as effectCall,
  cleanupAuthority,
  setup as effectSetup,
} from "../fixtures/lifecycle-worker-guard/peers.mjs";
import { stopRequest } from "../fixtures/lifecycle-worker-guard/vectors.mjs";

function fixture(options = {}) {
  const f = vectors();
  f.retained = structuredClone(f.association);
  f.head = structuredClone(f.association.intent);
  f.abort = new AbortController();
  f.reads = [];
  f.call = {
    context: Object.freeze({ fixture: "service-context" }),
    requestRef: ref(20),
    recipientRef: "test-lifecycle-reader",
    signal: f.abort.signal,
    deadline: "2026-01-01T00:00:30.000Z",
    claim: { idempotencyKey: f.work.idempotencyKey, claimToken: f.work.claimToken },
  };
  f.options = {
    installationId: f.association.intent.installationId,
    now: () => new Date(instant),
    async readQueue(input, call) {
      f.reads.push({ kind: "queue", input, call });
      return { operation: f.operation, work: f.work };
    },
    lifecycle: {
      async readAdmittedWork(input, call) {
        f.reads.push({ kind: "lifecycle", input, call });
        return { kind: "read", association: f.retained, currentIntent: f.head };
      },
    },
    ...options,
  };
  f.inspect = (preflight = new LifecycleWorkPreflightV1(f.options)) =>
    preflight.inspect(encodeLifecycleWorkV1(f.input), f.association, f.call);
  return f;
}

test("canonical codec round-trips bytes and preserves the original seven fields", () => {
  const { input } = vectors();
  const wire = encodeLifecycleWorkV1(input);
  assert.equal(wire, JSON.stringify(input));
  assert.equal(encodeLifecycleWorkV1(Object.fromEntries(Object.entries(input).reverse())), wire);
  for (const encoded of [wire, Buffer.from(wire), new TextEncoder().encode(wire)]) {
    const decoded = decodeLifecycleWorkV1(encoded);
    assert.deepEqual({ ...decoded }, input);
    assert.ok(Object.isFrozen(decoded));
  }
  assert.notEqual(input.workId, input.operationRef);
});

for (const field of ["actorId", "installationId", "claimToken", "authority", "runtimeUrl", "peer"])
  test(`codec rejects payload-supplied ${field}`, () => {
    const input = { ...vectors().input, [field]: "untrusted" };
    assert.throws(() => encodeLifecycleWorkV1(input), LifecycleWorkCodecErrorV1);
    assert.throws(() => decodeLifecycleWorkV1(JSON.stringify(input)), LifecycleWorkCodecErrorV1);
  });

test("codec rejects unknown version, malformed identity and unsafe generations", () => {
  for (const patch of [
    { schemaVersion: 2 },
    { schemaVersion: "1" },
    { handler: "ReconcileAgentLifecycleV2" },
    { namespaceId: `ns_${ref(1).toUpperCase()}BAD` },
    { agentId: "another-agent" },
    { operationRef: `req_${ref(4)}` },
    { lifecycleGeneration: 0 },
    { lifecycleGeneration: -1 },
    { lifecycleGeneration: 1.5 },
    { lifecycleGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { lifecycleGeneration: "1" },
    { workId: " " },
    { workId: "x".repeat(513) },
  ])
    assert.throws(
      () => decodeLifecycleWorkV1(JSON.stringify({ ...vectors().input, ...patch })),
      LifecycleWorkCodecErrorV1,
    );
});

test("codec rejects duplicate decoded keys and malformed or nested JSON", () => {
  const wire = encodeLifecycleWorkV1(vectors().input);
  for (const invalid of [
    wire.replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1'),
    wire.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'),
    wire.replace('"schemaVersion":1', '"schemaVersion":01'),
    wire.replace('"schemaVersion":1', '"schemaVersion":-0'),
    wire.replace('"schemaVersion":1', '"schemaVersion":{}'),
    wire.replace('"schemaVersion":1', '"schemaVersion":[1]'),
    wire.replace('"schemaVersion":1', '"schemaVersion":true'),
    wire.replace('"schemaVersion":1', '"schemaVersion":null'),
    wire.slice(0, -1) + ",}",
    wire + "{}",
    "\ufeff" + wire,
    "/* comment */" + wire,
    "[" + wire + "]",
    "{}",
  ])
    assert.throws(() => decodeLifecycleWorkV1(invalid), LifecycleWorkCodecErrorV1);
});

test("codec rejects invalid UTF-8, BOM, shared bytes and oversized encodings", () => {
  for (const invalid of [
    new Uint8Array([0xc0, 0xaf]),
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(encodeLifecycleWorkV1(vectors().input)),
    ]),
    new Uint8Array(new SharedArrayBuffer(10)),
    new Uint8Array(65_537),
    " ".repeat(65_537),
    new DataView(new ArrayBuffer(10)),
    {},
    new Proxy(new Uint8Array(10), {}),
  ])
    assert.throws(() => decodeLifecycleWorkV1(invalid), LifecycleWorkCodecErrorV1);
});

test("encoding never invokes payload accessors or accepts hidden fields", () => {
  let invoked = false;
  const input = vectors().input;
  Object.defineProperty(input, "actorId", {
    get() {
      invoked = true;
    },
  });
  assert.throws(() => encodeLifecycleWorkV1(input), LifecycleWorkCodecErrorV1);
  assert.equal(invoked, false);
  assert.throws(
    () => encodeLifecycleWorkV1(new Proxy(vectors().input, {})),
    LifecycleWorkCodecErrorV1,
  );
});

test("fresh preflight reads exact work and canonical association, returning no authority or lease", async () => {
  const f = fixture();
  const result = await f.inspect();
  assert.equal(result.kind, "snapshot-matches");
  assert.deepEqual({ ...result.input }, f.input);
  assert.deepEqual(structuredClone(result.association), f.association);
  assert.deepEqual(
    f.reads.map((item) => item.kind),
    ["queue", "lifecycle"],
  );
  for (const read of f.reads) {
    assert.equal(read.call.context, f.call.context);
    assert.equal(read.call.requestRef, f.call.requestRef);
    assert.equal(read.call.recipientRef, f.call.recipientRef);
    assert.equal(read.call.deadline, f.call.deadline);
    assert.equal(Object.hasOwn(read.call, "claim"), false);
    assert.deepEqual({ ...read.input }, f.input);
  }
  assert.deepEqual(Object.keys(result).sort(), ["association", "input", "kind"]);
  assert.equal(f.work.attemptCount, 1);
  assert.equal(f.work.leaseExpiresAt.toISOString(), "2026-01-01T00:00:10.000Z");
});

test("invalid work and foreign Installation are rejected before reading any provider", async () => {
  const f = fixture();
  const preflight = new LifecycleWorkPreflightV1(f.options);
  assert.deepEqual(await preflight.inspect("{}", f.association, f.call), {
    kind: "rejected",
    reason: "invalid-input",
  });
  f.association.intent.installationId = `ins_${ref(99)}`;
  assert.deepEqual(await f.inspect(preflight), {
    kind: "rejected",
    reason: "association-mismatch",
  });
  assert.equal(f.reads.length, 0);
});

for (const field of ["namespaceId", "agentId", "operationRef", "lifecycleGeneration", "workId"])
  test(`preflight rejects work ${field} substitution`, async () => {
    const f = fixture();
    const changes = {
      namespaceId: `ns_${ref(99)}`,
      agentId: `agt_${ref(99)}`,
      operationRef: ref(99),
      lifecycleGeneration: 2,
      workId: "other-work",
    };
    f.input[field] = changes[field];
    assert.deepEqual(await f.inspect(), { kind: "rejected", reason: "association-mismatch" });
    assert.equal(f.reads.length, 0);
  });

for (const field of ["auditEventId", "actorId", "requestId", "createdAt", "workId"])
  test(`fresh retained ${field} substitution cannot replace original admission`, async () => {
    const f = fixture();
    if (field === "auditEventId") f.retained.auditEventId = `aud_${ref(99)}`;
    else if (field === "workId") f.retained.workId = "other-work";
    else
      f.retained.intent[field] = {
        actorId: "other-actor",
        requestId: `req_${ref(99)}`,
        createdAt: "2026-01-01T00:00:01.000Z",
      }[field];
    assert.deepEqual(await f.inspect(), { kind: "rejected", reason: "association-mismatch" });
  });

test("queue owner, actor, original operation and maintenance identity mismatches reject", async () => {
  for (const change of [
    (f) => {
      f.work.agentId = `agt_${ref(99)}`;
    },
    (f) => {
      f.work.actorId = "other-actor";
    },
    (f) => {
      f.operation.runtimeTransitionRef = ref(99);
    },
    (f) => {
      f.operation.resourceId = `rev_${ref(99)}`;
    },
    (f) => {
      f.work.idempotencyKey += ":maintenance:1";
    },
  ]) {
    const f = fixture();
    change(f);
    assert.deepEqual(await f.inspect(), { kind: "rejected", reason: "association-mismatch" });
  }
});

test("missing and superseded intent leave original work unresolved", async () => {
  for (const head of [
    null,
    { ...vectors().association.intent, generation: 2, transitionRef: ref(99) },
    {
      ...vectors().association.intent,
      generation: 2,
      desiredMode: "stopped",
      transitionRef: ref(99),
    },
  ]) {
    const f = fixture();
    f.head = head;
    const result = await f.inspect();
    assert.equal(result.kind, "unresolved");
    assert.equal(result.reason, "head-mismatch");
    assert.deepEqual(structuredClone(result.association), f.association);
    assert.equal(result.input.workId, f.association.workId);
  }
});

test("protective and resume association definitions cannot enable the installed deploy queue", async () => {
  for (const kind of ["stop", "disable", "resume"]) {
    const f = fixture();
    const mode = { stop: "stopped", disable: "disabled", resume: "running" }[kind];
    f.association.request = {
      ...f.association.request,
      kind,
      expectedLifecycleGeneration: 1,
      ...(kind === "resume" ? { revisionSource: "retained" } : {}),
    };
    f.association.intent = { ...f.association.intent, generation: 2, desiredMode: mode };
    f.input.lifecycleGeneration = 2;
    f.work.lifecycleGeneration = 2;
    f.operation.lifecycleGeneration = 2;
    f.retained = structuredClone(f.association);
    f.head = structuredClone(f.association.intent);
    const result = await f.inspect();
    assert.equal(result.kind, "unresolved");
    assert.equal(result.reason, "unsupported-transition");
  }
});

test("expired, lost and terminal synthetic claims cannot pass or imply termination", async () => {
  for (const change of [
    (f) => {
      f.work.leaseExpiresAt = new Date(instant);
    },
    (f) => {
      f.work.claimToken = ref(99);
    },
    (f) => {
      delete f.work.claimToken;
      delete f.work.leaseExpiresAt;
      f.work.state = "succeeded";
      f.work.completedAt = new Date(instant);
    },
  ]) {
    const f = fixture();
    change(f);
    const result = await f.inspect();
    assert.equal(result.kind, "unresolved");
    assert.equal(result.reason, "claim-mismatch");
    assert.equal(result.input.workId, f.input.workId);
    assert.equal(Object.hasOwn(result, "executionTerminated"), false);
  }
});

test("claim change during an awaited read is suppressed by the fresh receiving-boundary recheck", async () => {
  const f = fixture();
  let first = true;
  f.options.lifecycle.readAdmittedWork = async () => {
    if (first) {
      first = false;
      f.work.claimToken = ref(99);
    }
    return { kind: "read", association: f.retained, currentIntent: f.head };
  };
  // The first queue snapshot predates the intervening change. It is explicitly
  // not a permit: the accepting test consumer checks again before submission.
  assert.equal((await f.inspect()).kind, "snapshot-matches");
  const current = await f.inspect();
  assert.equal(current.kind, "unresolved");
  assert.equal(current.reason, "claim-mismatch");
});

test("changed intent between preflight and submission is unresolved on fresh inspection", async () => {
  const f = fixture();
  assert.equal((await f.inspect()).kind, "snapshot-matches");
  f.head = { ...f.head, generation: 2, transitionRef: ref(99), desiredMode: "disabled" };
  const current = await f.inspect(new LifecycleWorkPreflightV1(f.options));
  assert.equal(current.kind, "unresolved");
  assert.equal(current.reason, "head-mismatch");
  assert.equal(current.input.operationRef, f.input.operationRef);
});

test("missing, failed and malformed fresh readers stay unresolved", async () => {
  for (const override of [
    { readQueue: async () => null },
    {
      readQueue: async () => {
        throw new Error("sensitive-storage-detail");
      },
    },
    { readQueue: async () => ({ operation: {}, work: {} }) },
    {
      lifecycle: {
        readAdmittedWork: async () => ({ kind: "unavailable", reasonCode: "UNAVAILABLE" }),
      },
    },
    {
      lifecycle: {
        readAdmittedWork: async () => ({ kind: "read", association: {}, currentIntent: null }),
      },
    },
  ]) {
    const result = await fixture(override).inspect();
    assert.equal(result.kind, "unresolved");
    assert.equal(result.reason, "dependency-unavailable");
    assert.equal(JSON.stringify(result).includes("sensitive-storage-detail"), false);
  }
});

test("cancelled and expired enclosing calls do not begin reads", async () => {
  const f = fixture();
  f.abort.abort();
  assert.equal((await f.inspect()).reason, "cancelled");
  assert.equal(f.reads.length, 0);
  const expired = fixture();
  expired.call.deadline = instant;
  assert.equal((await expired.inspect()).reason, "deadline-exceeded");
  assert.equal(expired.reads.length, 0);
});

test("bounded lookup ignores late results and cleans cancellation listeners", async () => {
  const f = fixture({ maxLookupMs: 10 });
  let finish;
  let child;
  f.options.readQueue = (_input, call) => {
    child = call.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const result = await f.inspect();
  assert.equal(result.kind, "unresolved");
  assert.equal(result.reason, "deadline-exceeded");
  assert.equal(child.aborted, true);
  assert.equal(getEventListeners(f.call.signal, "abort").length, 0);
  finish({ operation: f.operation, work: f.work });
  await delay(0);
  assert.equal(result.kind, "unresolved");
  assert.equal(f.reads.length, 0);
});

test("clock failure during wait setup leaves no dangling abort listener", async () => {
  let reads = 0;
  const f = fixture({ now: () => (++reads === 2 ? new Date(NaN) : new Date(instant)) });
  assert.equal((await f.inspect()).reason, "dependency-unavailable");
  assert.equal(getEventListeners(f.call.signal, "abort").length, 0);
});

test("clock rollback cannot extend the local lookup ceiling", { timeout: 1000 }, async () => {
  let reads = 0;
  const f = fixture({
    maxLookupMs: 10,
    now: () => new Date(Date.parse(instant) - (++reads > 1 ? 60_000 : 0)),
    readQueue: () => new Promise(() => {}),
  });
  assert.equal((await f.inspect()).reason, "deadline-exceeded");
  assert.equal(getEventListeners(f.call.signal, "abort").length, 0);
});

test("lookup cancellation propagates without claiming underlying operation termination", async () => {
  const f = fixture();
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  let child;
  f.options.readQueue = (_input, call) => {
    child = call.signal;
    entered();
    return new Promise(() => {});
  };
  const pending = f.inspect();
  await ready;
  f.abort.abort();
  const result = await pending;
  assert.equal(result.reason, "cancelled");
  assert.equal(child.aborted, true);
  assert.equal(getEventListeners(f.call.signal, "abort").length, 0);
});

test("lookup ceilings cannot exceed the canonical maximum", () => {
  for (const maxLookupMs of [0, -1, 3001, 1.5, NaN, Infinity])
    assert.throws(
      () => new LifecycleWorkPreflightV1({ ...fixture().options, maxLookupMs }),
      TypeError,
    );
});

function preflightForGuard(s) {
  const preflight = new LifecycleWorkPreflightV1({
    installationId: s.context.installationId,
    now: s.options.now,
    lifecycle: s.options.lifecycle,
    readQueue: async () => ({ operation: s.context.operation, work: s.context.work }),
  });
  return () =>
    preflight.inspect(encodeLifecycleWorkV1(s.context.input), s.context.original, {
      ...s.context.call,
      claim: {
        idempotencyKey: s.context.work.idempotencyKey,
        claimToken: s.context.work.claimToken,
      },
    });
}

test("superseded preflight composes with the existing guard's exact uncertain-create readback", async () => {
  // Controlled peers exercise both real library components. They do not prove
  // authenticated authority, provider completion or physical candidate absence.
  const s = effectSetup();
  const inspect = preflightForGuard(s);
  assert.equal((await inspect()).kind, "snapshot-matches");
  const submitted = await s.guard.run(s.context, s.request);
  assert.equal(submitted.kind, "unresolved");
  s.state.head = {
    ...s.state.head,
    generation: s.state.head.generation + 1,
    transitionRef: ref(99),
    desiredMode: "stopped",
  };
  const stale = await inspect();
  assert.equal(stale.kind, "unresolved");
  assert.equal(stale.reason, "head-mismatch");
  assert.deepEqual(stale.association, s.context.original);
  // Restart recovery observes the original effect, without a new work identity
  // or another create. The effect guard owns this existing read-only behavior.
  const recovered = await new LifecycleEffectGuard(s.options).readOriginal(
    submitted.effect,
    effectCall(),
  );
  assert.equal(recovered.kind, "unresolved");
  assert.deepEqual(recovered.effect, submitted.effect);
  assert.equal(s.events.filter(([kind]) => kind === "create").length, 1);
  assert.equal(s.events.filter(([kind]) => kind === "readEffect").length, 1);
});

test("stale running preflight retains association for the existing guard's independent exact candidate cleanup", async () => {
  const request = stopRequest();
  const s = effectSetup(request);
  const authority = cleanupAuthority(request);
  s.options.assignments = { resolve: async () => authority.value };
  s.state.head = {
    ...s.state.head,
    generation: s.state.head.generation + 1,
    transitionRef: ref(99),
    desiredMode: "stopped",
  };
  const stale = await preflightForGuard(s)();
  assert.equal(stale.kind, "unresolved");
  assert.equal(stale.reason, "head-mismatch");
  s.abort.abort();
  const result = await s.guard.cleanup(stale.association, request, authority.input, effectCall());
  assert.equal(result.kind, "unresolved");
  assert.deepEqual(structuredClone(result.effect), structuredClone(request.effect));
  assert.equal(s.events.filter(([kind]) => kind === "cleanup").length, 1);
  assert.equal(s.events.filter(([kind]) => kind === "create" || kind === "route").length, 0);
  assert.equal(Object.hasOwn(result, "executionTerminated"), false);
});
