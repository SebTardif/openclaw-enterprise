import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { projectRuntimePreparation } from "../../packages/occ/src/runtime-preparation/repository.ts";
import { samePreparationValue } from "../../packages/occ/src/runtime-preparation/types.ts";
import {
  resolveRuntimePreparationCreateReferenceV1,
  parseRuntimePreparationCreateLocatorV1,
} from "../../packages/occ/src/runtime-preparation/create-reference.ts";
import {
  copy,
  seedPreparation,
  rebuildPreparationChild,
} from "../fixtures/runtime-preparation.mjs";

// Original memory retention is real. The marker/response below are controlled
// historical data, not PostgreSQL acceptance, native custody or provider proof.
async function fixture({ marker = true, response = true } = {}) {
  const f = await seedPreparation(new InMemoryPlatformState());
  await f.append(f.plan);
  const inserted = await f.append(f.child);
  const history = await f.history();
  const preparation = await f.record();
  const child = f.child.child;
  const submission = {
    submissionRef: randomUUID(),
    effectRef: child.effect.effectRef,
    ...f.scope,
    revisionId: child.effect.target.revisionId,
    preparationRef: f.plan.preparationRef,
    preparationVersion: 2,
    requestDigest: child.effect.requestDigest,
    providerWireDigest: child.providerWire.bytesDigest,
    submittedAt: "2026-09-06T00:00:01.000Z",
  };
  const acceptedResponse = {
    namespace: "retained-runtime",
    name: child.providerTarget.name,
    uid:
      child.predicate.kind === "expected-object"
        ? child.predicate.uid
        : "controlled-deployment-uid",
    resourceVersion: "original-response/rv-9",
    receivedAt: "2026-09-06T00:00:02.000Z",
  };
  const read = copy({
    status: "retained",
    childOperation: inserted.operation,
    history,
    preparation,
    child,
    providerWireUtf8: f.providerWireUtf8,
    ...(marker ? { submission } : {}),
    ...(marker && response ? { response: acceptedResponse } : {}),
  });
  const locator = { kind: "create-effect", createEffectRef: child.effect.effectRef };
  return {
    f,
    read,
    locator,
    resolve: (value = read, selected = locator, scope = f.scope) =>
      resolveRuntimePreparationCreateReferenceV1(scope, selected, value),
  };
}

for (const kind of ["create-effect", "submission"]) {
  test(`create reference: ${kind} resolves real retained child without creating observation authority`, async () => {
    const x = await fixture();
    const locator =
      kind === "submission" ? { kind, submissionRef: x.read.submission.submissionRef } : x.locator;
    const result = x.resolve(x.read, locator);
    assert.equal(result.status, "located");
    assert.ok(samePreparationValue(result.input.effect, x.read.child.effect));
    assert.ok(samePreparationValue(result.input.providerTarget, x.read.child.providerTarget));
    assert.equal(result.input.expectedObject, null);
    assert.deepEqual(result.retained.response, x.read.response);
    assert.deepEqual(
      result.retained.history.map((row) => row.canonicalRequest),
      x.read.history.map((row) => row.canonicalRequest),
    );
    assert.equal(Object.hasOwn(result, "evidence"), false);
    assert.equal(Object.hasOwn(result, "sourceCall"), false);
    assert.equal(Object.hasOwn(result, "recordVersion"), false);
    assert.equal(Object.hasOwn(result.input, "fenceEpoch"), false);
    assert.equal(Object.isFrozen(result.input), true);
    assert.equal(Object.isFrozen(result.retained), true);
    x.read.response.uid = "changed-after-read";
    assert.notEqual(result.retained.response.uid, x.read.response.uid);
  });
}

for (const kind of ["create-effect", "submission"]) {
  test(`create reference: ${kind} preserves an earlier SDK-host response clock`, async () => {
    const x = await fixture();
    const receivedAt = "2026-09-05T23:59:01.000Z";
    x.read.response.receivedAt = receivedAt;
    const locator =
      kind === "submission" ? { kind, submissionRef: x.read.submission.submissionRef } : x.locator;
    // Response and submission clocks have different owners. The historical
    // projection preserves their canonical values and exact object association.
    const result = x.resolve(x.read, locator);
    assert.equal(result.status, "located");
    assert.equal(result.retained.response.receivedAt, receivedAt);
    assert.equal(result.retained.submission.submittedAt, x.read.submission.submittedAt);
    assert.equal(result.retained.response.uid, x.read.response.uid);
    assert.equal(result.retained.response.name, x.read.child.providerTarget.name);
    assert.equal(result.input.expectedObject, null);
    assert.ok(Date.parse(receivedAt) < Date.parse(result.retained.submission.submittedAt));
  });
}

test("create reference: child effect identity differs from owner-create identity", async () => {
  const x = await fixture();
  assert.notEqual(x.read.child.effect.effectRef, x.read.child.effect.target.createEffectRef);
  assert.equal(
    x.read.child.providerTarget.ownerCreateEffectRef,
    x.read.child.effect.target.createEffectRef,
  );
  assert.equal(x.resolve().status, "located");
  assert.throws(() =>
    x.resolve(x.read, {
      kind: "create-effect",
      createEffectRef: x.read.child.effect.target.createEffectRef,
    }),
  );
});

for (const later of ["close", "supersede", "intent-loss"]) {
  test(`create reference: exact historical prefix survives later ${later}`, async () => {
    const x = await fixture();
    if (later === "close") await x.f.append(x.f.close);
    else if (later === "supersede") await x.f.append(x.f.nextPlan());
    else await x.f.advance("stopped");
    const result = x.resolve();
    assert.equal(result.status, "located");
    assert.equal(result.retained.preparation.localVersion, 2);
    assert.equal(result.retained.history.length, 2);
    assert.equal(result.input.expectedObject, null);
    if (later !== "intent-loss") {
      const laterHistory = await x.f.history();
      assert.equal(laterHistory.length, 3);
      assert.throws(() =>
        x.resolve({
          ...x.read,
          history: laterHistory,
          preparation: projectRuntimePreparation(laterHistory),
        }),
      );
    }
  });
}

test("create reference: marker selects complete later prefix including another retained child", async () => {
  const x = await fixture();
  const request = copy(x.f.child);
  request.operationRef = randomUUID();
  request.expectedVersion = 2;
  request.child.request.effect.effectRef = randomUUID();
  request.child = rebuildPreparationChild(request.child, request.providerWireUtf8);
  await x.f.append(request);
  x.read.history = await x.f.history();
  x.read.preparation = await x.f.record();
  x.read.submission.preparationVersion = 3;
  const result = x.resolve();
  assert.equal(result.retained.history.length, 3);
  assert.equal(result.retained.preparation.children.length, 2);
  assert.equal(result.input.effect.effectRef, x.f.child.child.effect.effectRef);
});

for (const marker of [false, true]) {
  test(`create reference: missing response with marker=${marker} remains data without retry/absence claim`, async () => {
    const x = await fixture({ marker, response: false });
    const result = x.resolve();
    assert.equal(result.status, "located");
    assert.equal(result.input.expectedObject, null);
    assert.equal(Object.hasOwn(result.retained, "submission"), marker);
    assert.equal(Object.hasOwn(result.retained, "response"), false);
    assert.equal(Object.hasOwn(result, "safeToRetry"), false);
    assert.equal(Object.hasOwn(result, "providerAbsent"), false);
    if (!marker)
      assert.throws(() => x.resolve(x.read, { kind: "submission", submissionRef: randomUUID() }));
  });
}

test("create reference: scoped absence is inert and does not disclose additional fields", async () => {
  const x = await fixture();
  assert.deepEqual(x.resolve({ status: "absent" }), { status: "absent" });
  assert.throws(() => x.resolve({ status: "absent", response: x.read.response }));
});

const corruptions = [
  [
    "marker scope",
    (r) => {
      r.submission.namespaceId += "-other";
    },
  ],
  [
    "marker revision",
    (r) => {
      r.submission.revisionId += "-other";
    },
  ],
  [
    "marker preparation",
    (r) => {
      r.submission.preparationRef = randomUUID();
    },
  ],
  [
    "marker effect",
    (r) => {
      r.submission.effectRef = randomUUID();
    },
  ],
  [
    "marker digest",
    (r) => {
      r.submission.requestDigest = `sha256:${"0".repeat(64)}`;
    },
  ],
  [
    "marker wire digest",
    (r) => {
      r.submission.providerWireDigest = `sha256:${"0".repeat(64)}`;
    },
  ],
  [
    "marker earlier version",
    (r) => {
      r.submission.preparationVersion = 1;
    },
  ],
  [
    "marker future version",
    (r) => {
      r.submission.preparationVersion = 3;
    },
  ],
  [
    "canonical operation",
    (r) => {
      r.childOperation.canonicalRequest += " ";
    },
  ],
  [
    "wire",
    (r) => {
      r.providerWireUtf8 += " ";
    },
  ],
  [
    "child target",
    (r) => {
      r.child.effect.target.revisionId += "-other";
    },
  ],
  [
    "child kind",
    (r) => {
      r.child.request.kind = "set-route";
    },
  ],
  [
    "child resource",
    (r) => {
      r.child.providerTarget.apiKind = "Service";
    },
  ],
  [
    "response name",
    (r) => {
      r.response.name += "-other";
    },
  ],
  [
    "response uid",
    (r) => {
      r.response.uid += "-other";
    },
  ],
  [
    "response namespace",
    (r) => {
      r.response.namespace = "../outside";
    },
  ],
  [
    "response empty version",
    (r) => {
      r.response.resourceVersion = "";
    },
  ],
  [
    "noncanonical response timestamp",
    (r) => {
      r.response.receivedAt = "2026-09-06T00:00:02Z";
    },
  ],
  [
    "nonfinite response timestamp",
    (r) => {
      r.response.receivedAt = "not-a-timestamp";
    },
  ],
  [
    "response without marker",
    (r) => {
      delete r.submission;
    },
  ],
  [
    "explicit undefined marker",
    (r) => {
      r.submission = undefined;
    },
  ],
  [
    "history missing beginning",
    (r) => {
      r.history.shift();
    },
  ],
  [
    "history repeated row",
    (r) => {
      r.history[1] = copy(r.history[0]);
    },
  ],
  [
    "history reordered",
    (r) => {
      r.history.reverse();
    },
  ],
  [
    "history cutoff",
    (r) => {
      r.history[1].retainedChildSequence = 0;
    },
  ],
  [
    "projected child omission",
    (r) => {
      r.preparation.children = [];
    },
  ],
];
for (const [name, corrupt] of corruptions) {
  test(`create reference refuses ${name}`, async () => {
    const x = await fixture();
    corrupt(x.read);
    assert.throws(() => x.resolve());
  });
}

test("create reference refuses mismatched requested scope and submission reference", async () => {
  const x = await fixture();
  assert.throws(() =>
    x.resolve(x.read, x.locator, { ...x.f.scope, agentId: `${x.f.scope.agentId}-other` }),
  );
  assert.throws(() => x.resolve(x.read, { kind: "submission", submissionRef: randomUUID() }));
  assert.throws(() => parseRuntimePreparationCreateLocatorV1({ ...x.locator, expectedObject: {} }));
});

test("create reference accepts canonical null-prototype dictionaries without invoking accessors", async () => {
  const x = await fixture();
  const nullRecord = (value) =>
    value === null || typeof value !== "object"
      ? value
      : Array.isArray(value)
        ? value.map(nullRecord)
        : Object.assign(
            Object.create(null),
            Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nullRecord(item)])),
          );
  const result = x.resolve(nullRecord(x.read), nullRecord(x.locator), nullRecord(x.f.scope));
  assert.equal(result.status, "located");
  let invoked = 0;
  const accessor = { ...x.read };
  Object.defineProperty(accessor, "history", {
    enumerable: true,
    get() {
      invoked += 1;
      throw new Error("not data");
    },
  });
  assert.throws(() => x.resolve(accessor));
  assert.equal(invoked, 0);
});

test("create reference preserves history above a single request byte cap", async () => {
  const x = await fixture();
  const wire = JSON.stringify({ kind: "controlled-retained-wire", payload: "x".repeat(64000) });
  for (let index = 0; index < 17; index++) {
    const request = copy(x.f.child);
    request.operationRef = randomUUID();
    request.expectedVersion = index + 2;
    request.providerWireUtf8 = wire;
    request.child.request.effect.effectRef = randomUUID();
    request.child = rebuildPreparationChild(request.child, wire);
    const result = await x.f.append(request);
    assert.equal(result.status, "retained");
  }
  x.read.history = await x.f.history();
  x.read.preparation = await x.f.record();
  x.read.submission.preparationVersion = 19;
  assert.ok(Buffer.byteLength(JSON.stringify(x.read.history), "utf8") > 1_048_576);
  assert.ok(Buffer.byteLength(JSON.stringify(x.read.preparation), "utf8") > 1_048_576);
  const result = x.resolve();
  assert.equal(result.retained.history.length, 19);
  assert.equal(result.retained.preparation.children.length, 18);
  assert.deepEqual(
    result.retained.history.map((row) => row.canonicalRequest),
    x.read.history.map((row) => row.canonicalRequest),
  );
  assert.equal(result.input.expectedObject, null);
});
