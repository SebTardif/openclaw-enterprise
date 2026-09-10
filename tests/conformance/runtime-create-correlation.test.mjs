import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { parseRuntimeEffectsResponseV1 } from "@openclaw-enterprise/contracts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { resolveRuntimePreparationCreateReferenceV1 } from "../../packages/occ/src/runtime-preparation/create-reference.ts";
import {
  canonicalRuntimeCreateCorrelationV1,
  runtimeCreateCorrelationDigestV1,
  parseRuntimeCreateCorrelationReferenceV1,
  parseRuntimeCreateCorrelationRequestV1,
  parseRuntimeCreateCorrelationRecordV1,
  prepareRuntimeCreateCorrelationV1,
  decodeStoredRuntimeCreateCorrelationV1,
  currentRuntimeCreateCorrelationV1,
} from "../../packages/occ/src/runtime-preparation/create-correlation.ts";
import { copy, seedPreparation } from "../fixtures/runtime-preparation.mjs";
import { evidence } from "../fixtures/runtime-effects-v1/vectors.mjs";
import { trust } from "../fixtures/runtime-authority-v1/vectors.mjs";

// Actual memory preparation retention and the accepted historical projector are
// used below. Submission/response, native-qualified data and clock are controlled
// representation fixtures. No source operation, registry permit, PostgreSQL ACK,
// provider object or independently live native exchange is created by these tests.
const now = "2026-09-06T00:00:03.000Z";
const canon = canonicalRuntimeCreateCorrelationV1;
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
async function fixture() {
  const f = await seedPreparation(new InMemoryPlatformState());
  await f.append(f.plan);
  const inserted = await f.append(f.child);
  const child = f.child.child;
  const read = copy({
    status: "retained",
    childOperation: inserted.operation,
    history: await f.history(),
    preparation: await f.record(),
    child,
    providerWireUtf8: f.providerWireUtf8,
    submission: {
      submissionRef: randomUUID(),
      effectRef: child.effect.effectRef,
      ...f.scope,
      revisionId: child.effect.target.revisionId,
      preparationRef: f.plan.preparationRef,
      preparationVersion: 2,
      requestDigest: child.effect.requestDigest,
      providerWireDigest: child.providerWire.bytesDigest,
      submittedAt: "2026-09-06T00:00:01.000Z",
    },
    response: {
      namespace: "retained-runtime",
      name: child.providerTarget.name,
      uid: child.predicate.kind === "expected-object" ? child.predicate.uid : "original-deployment",
      resourceVersion: "original-response/rv-4",
      receivedAt: "2026-09-06T00:00:02.000Z",
    },
  });
  const locator = { kind: "create-effect", createEffectRef: child.effect.effectRef };
  const located = resolveRuntimePreparationCreateReferenceV1(f.scope, locator, read);
  assert.equal(located.status, "located");
  const request = {
    operationRef: randomUUID(),
    requestRef: randomUUID(),
    scope: copy(f.scope),
    locator,
    input: copy(located.input),
    expectedVersion: null,
  };
  const provenance = evidence("native-evidence/independent", 11);
  provenance.clock = {
    sourceObservedAt: "2026-09-06T00:00:02.100Z",
    receivedAt: "2026-09-06T00:00:02.200Z",
    validUntil: "2026-09-06T00:00:15.000Z",
    uncertaintyMs: 10,
  };
  const configuration = trust();
  configuration.installationId = f.scope.installationId;
  configuration.allowedScope = { kind: "agent", ...f.scope };
  const { evidenceRef: _ref, evidenceVersion: _version, clock: _clock, ...producer } = provenance;
  const authority = { sourceRef: "native-source/original", configuration, producer };
  const observation = {
    namespace: read.response.namespace,
    object: {
      target: copy(child.providerTarget),
      uid: read.response.uid,
      resourceVersion: "current-object/rv-12",
      fenceEpoch: 7,
    },
    evidence: provenance,
  };
  const reference = { recordRef: `correlation/${randomUUID()}`, recordVersion: 1 };
  const x = { f, read, request, authority, observation, reference };
  x.prepare = () =>
    prepareRuntimeCreateCorrelationV1(
      x.request,
      x.authority,
      x.read,
      x.observation,
      x.reference,
      now,
    );
  return x;
}

for (const kind of ["create-effect", "submission"]) {
  test(`create correlation: ${kind} builds durable bytes from actual retained history`, async () => {
    const x = await fixture();
    if (kind === "submission")
      x.request.locator = { kind, submissionRef: x.read.submission.submissionRef };
    const stored = x.prepare();
    assert.equal(stored.record.recordRef, x.reference.recordRef);
    assert.equal(stored.record.recordVersion, 1);
    assert.notEqual(stored.record.recordVersion, x.read.submission.preparationVersion);
    assert.notEqual(stored.record.recordRef, x.read.submission.submissionRef);
    assert.equal(stored.record.evidence.evidenceVersion, 11);
    assert.equal(stored.record.object.fenceEpoch, 7);
    assert.equal(stored.record.input.expectedObject, null);
    assert.equal(stored.canonicalRecord, canon(stored.record));
    assert.equal(stored.recordDigest, hash(stored.canonicalRecord));
    assert.equal(stored.requestDigest, hash(stored.canonicalRequest));
    assert.equal(
      canon(decodeStoredRuntimeCreateCorrelationV1(stored).record),
      canon(stored.record),
    );
    const current = currentRuntimeCreateCorrelationV1(stored, x.authority, now);
    assert.equal(current.kind, "create-correlation");
    assert.equal(current.recordDigest, stored.recordDigest);
    assert.equal(canon(current.producer), canon(x.authority.producer));
    // This is the actual existing Compute discovery result decoder boundary.
    const accepted = parseRuntimeEffectsResponseV1("discover", stored.record.input, {
      schemaVersion: 1,
      status: "exact",
      input: stored.record.input,
      object: stored.record.object,
      correlationEvidence: stored.record.evidence,
    });
    assert.equal(accepted.status, "exact");
    assert.equal(accepted.object.uid, x.read.response.uid);
    assert.equal(Object.hasOwn(stored, "sourceCall"), false);
    assert.equal(Object.hasOwn(current, "authority"), false);
    assert.equal(Object.isFrozen(stored.record.object), true);
    x.observation.object.uid = "mutated-after-build";
    x.request.input.providerTarget.name = "mutated-after-build";
    assert.notEqual(stored.record.object.uid, x.observation.object.uid);
    assert.notEqual(stored.record.input.providerTarget.name, x.request.input.providerTarget.name);
  });
}

test("create correlation: original response anchors UID while native observation supplies current RV", async () => {
  const x = await fixture();
  const stored = x.prepare();
  assert.equal(stored.record.object.uid, x.read.response.uid);
  assert.notEqual(stored.record.object.resourceVersion, x.read.response.resourceVersion);
  assert.equal(stored.record.object.resourceVersion, x.observation.object.resourceVersion);
  assert.equal(
    stored.record.evidence.clock.sourceObservedAt,
    x.observation.evidence.clock.sourceObservedAt,
  );
  assert.notEqual(stored.record.evidence.clock.sourceObservedAt, x.read.response.receivedAt);
});
test("create correlation: historical projection remains valid after original preparation closure", async () => {
  const x = await fixture();
  await x.f.append(x.f.close);
  assert.equal((await x.f.record()).localState, "closed");
  assert.equal(x.prepare().record.input.effect.effectRef, x.read.child.effect.effectRef);
});
test("create correlation: version two requires explicit preceding version and independent record identity", async () => {
  const x = await fixture();
  const first = x.prepare();
  x.request.operationRef = randomUUID();
  x.request.expectedVersion = 1;
  x.reference.recordVersion = 2;
  x.observation.evidence.evidenceVersion = 12;
  const next = x.prepare();
  assert.equal(next.record.recordRef, first.record.recordRef);
  assert.equal(next.record.recordVersion, 2);
  assert.notEqual(next.request.operationRef, first.request.operationRef);
  assert.notEqual(next.recordDigest, first.recordDigest);
  // This codec supplies no head CAS or permission to supersede; State owns both.
  assert.equal(Object.hasOwn(next, "head"), false);
});

const refused = [
  [
    "missing response",
    (x) => {
      delete x.read.response;
    },
  ],
  [
    "missing submission and response",
    (x) => {
      delete x.read.submission;
      delete x.read.response;
    },
  ],
  [
    "scoped absent retained read",
    (x) => {
      x.read = { status: "absent" };
    },
  ],
  [
    "changed original history",
    (x) => {
      x.read.history[0].requestDigest = hash("other");
    },
  ],
  [
    "provider UID mismatch",
    (x) => {
      x.observation.object.uid = "unrelated-deployment";
    },
  ],
  [
    "namespace mismatch",
    (x) => {
      x.observation.namespace = "other-namespace";
    },
  ],
  [
    "provider target mismatch",
    (x) => {
      x.observation.object.target.name = "other-deployment";
    },
  ],
  [
    "owner-create effect substituted for child effect",
    (x) => {
      x.request.locator.createEffectRef = x.read.child.effect.target.createEffectRef;
    },
  ],
  [
    "request scope mismatch",
    (x) => {
      x.request.scope.agentId = `agt_${randomUUID()}`;
    },
  ],
  [
    "changed exact request operand",
    (x) => {
      x.request.input.effect.requestDigest = hash("different-request");
    },
  ],
  [
    "supplied expected object replaces original null query",
    (x) => {
      x.request.input.expectedObject = copy(x.observation.object);
    },
  ],
  [
    "missing native object fence",
    (x) => {
      delete x.observation.object.fenceEpoch;
    },
  ],
  [
    "missing original evidence time",
    (x) => {
      delete x.observation.evidence.clock.sourceObservedAt;
    },
  ],
  [
    "wrong producer",
    (x) => {
      x.observation.evidence.producerRef = "other-producer";
    },
  ],
  [
    "expired evidence",
    (x) => {
      x.observation.evidence.clock.validUntil = "2026-09-06T00:00:02.500Z";
    },
  ],
  [
    "configuration scope mismatch",
    (x) => {
      x.authority.configuration.allowedScope.agentId = `agt_${randomUUID()}`;
    },
  ],
  [
    "skipped initial record version",
    (x) => {
      x.reference.recordVersion = 2;
    },
  ],
  [
    "extra observation field",
    (x) => {
      x.observation.providerReceipt = {};
    },
  ],
  [
    "extra request field",
    (x) => {
      x.request.permit = true;
    },
  ],
];
for (const [name, change] of refused) {
  test(`create correlation: refuses ${name}`, async () => {
    const x = await fixture();
    change(x);
    assert.throws(() => x.prepare());
  });
}

test("create correlation: historical decoding does not refresh expired evidence", async () => {
  const x = await fixture();
  const stored = x.prepare();
  assert.equal(decodeStoredRuntimeCreateCorrelationV1(stored).recordDigest, stored.recordDigest);
  assert.throws(() =>
    currentRuntimeCreateCorrelationV1(stored, x.authority, "2026-09-06T00:00:16.000Z"),
  );
  assert.equal(stored.record.evidence.clock.validUntil, "2026-09-06T00:00:15.000Z");
});
for (const part of ["source", "configuration", "producer"]) {
  test(`create correlation: current projection refuses changed ${part} association`, async () => {
    const x = await fixture();
    const stored = x.prepare();
    const changed = copy(x.authority);
    if (part === "source") changed.sourceRef = "native-source/replaced";
    if (part === "configuration") changed.configuration.configurationVersion += 1;
    if (part === "producer") changed.producer.producerServiceVersion += 1;
    assert.throws(() => currentRuntimeCreateCorrelationV1(stored, changed, now));
  });
}
for (const field of ["canonicalRequest", "requestDigest", "canonicalRecord", "recordDigest"]) {
  test(`create correlation: durable decoder refuses changed ${field}`, async () => {
    const x = await fixture();
    const value = copy(x.prepare());
    value[field] += " ";
    assert.throws(() => decodeStoredRuntimeCreateCorrelationV1(value));
  });
}
test("create correlation: coherent rehash cannot conceal request versus record substitution", async () => {
  const x = await fixture();
  const value = copy(x.prepare());
  value.request.input.effect.requestDigest = hash("different-canonical-request");
  value.canonicalRequest = canon(value.request);
  value.requestDigest = hash(value.canonicalRequest);
  assert.throws(() => decodeStoredRuntimeCreateCorrelationV1(value));
});
test("create correlation: malformed reference and exhausted version refuse", async () => {
  const x = await fixture();
  for (const bad of [
    { recordRef: "", recordVersion: 1 },
    { recordRef: "valid", recordVersion: 0 },
    { recordRef: "valid", recordVersion: 1, permit: true },
  ])
    assert.throws(() => parseRuntimeCreateCorrelationReferenceV1(bad));
  x.request.expectedVersion = Number.MAX_SAFE_INTEGER;
  assert.throws(() => parseRuntimeCreateCorrelationRequestV1(x.request));
});

test("create correlation: canonical digest uses exact Compute UTF-16 sorting and unchanged arrays", () => {
  const value = {
    "\uffff": 1,
    "\ud83d\ude00": -0,
    z: [2.5, -1, null, "é"],
    a: { y: false, x: true },
  };
  const expected = '{"a":{"x":true,"y":false},"z":[2.5,-1,null,"é"],"😀":0,"￿":1}';
  assert.equal(canon(value), expected);
  assert.equal(runtimeCreateCorrelationDigestV1(value), hash(expected));
  assert.equal(canon(Object.assign(Object.create(null), value)), expected);
});
test("create correlation: canonical size is UTF-8 and includes JSON quotes", () => {
  assert.equal(Buffer.byteLength(canon("a".repeat(262142)), "utf8"), 262144);
  assert.throws(() => canon("a".repeat(262143)));
  assert.throws(() => canon("é".repeat(131072)));
});
test("create correlation: record parser rejects accessor without invoking it", async () => {
  const x = await fixture();
  const record = copy(x.prepare().record);
  let entered = 0;
  Object.defineProperty(record, "evidence", {
    enumerable: true,
    get() {
      entered++;
      return x.observation.evidence;
    },
  });
  assert.throws(() => parseRuntimeCreateCorrelationRecordV1(record));
  assert.equal(entered, 0);
});
test("create correlation: request locator accessor cannot run before validation", async () => {
  const x = await fixture();
  let entered = 0;
  Object.defineProperty(x.request.locator, "createEffectRef", {
    enumerable: true,
    get() {
      entered++;
      return x.read.child.effect.effectRef;
    },
  });
  assert.throws(() => parseRuntimeCreateCorrelationRequestV1(x.request));
  assert.equal(entered, 0);
});
test("create correlation: canonical data rejects hidden fields, holes, undefined and nonfinite numbers", () => {
  let entered = 0;
  const getter = {
    get value() {
      entered++;
      return 1;
    },
  };
  const hidden = Object.defineProperty({}, "value", { value: 1 });
  const hole = Array(1);
  const extra = Object.assign([], { surprise: 1 });
  const symbol = { [Symbol("hidden")]: 1 };
  for (const value of [getter, hidden, hole, extra, symbol, undefined, NaN, Infinity, new Date(0)])
    assert.throws(() => canon(value));
  assert.equal(entered, 0);
});
