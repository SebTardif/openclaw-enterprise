import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePurgeCallableV1 as parse,
  parsePurgeCallableJsonV1 as parseJson,
  encodePurgeCallableV1 as encode,
  purgeHistoryMatchesV1,
  reconcileUnknownPurgeV1,
  PURGE_CALLABLE_LIMITS_V1,
} from "../../packages/contracts/src/retirement-purge-journal-v1.ts";
import { AtomicRetirementModel } from "../fixtures/retirement-purge-journal-v1/model.mjs";
import {
  publishAndReport,
  recordObservationAndReport,
} from "../fixtures/retirement-purge-journal-v1/consumer.ts";
import {
  createPurgeManifestV1,
  purgeManifestLocatorV1,
  initialPurgeProgressV1,
} from "../../packages/contracts/src/retirement-purge-manifest-v1.ts";
import {
  manifestBody,
  observation,
  withObservation,
} from "../fixtures/retirement-purge-manifest-v1/values.mjs";

const clone = (value) => structuredClone(value);
function fixture() {
  const manifest = createPurgeManifestV1(manifestBody());
  const binding = {
    schemaVersion: 1,
    scope: manifest.scope,
    originalTransactionRef: "transaction-publication-1",
    expectedStoppedTransitionRef: "55555555-5555-4555-8555-555555555555",
    expectedLifecycleGeneration: 7,
    barrierRef: "barrier-1",
    barrierVersion: 2,
    activationReplayLineageRef: "lineage-1",
    activationReplayLineageVersion: 4,
    manifest: purgeManifestLocatorV1(manifest),
  };
  const input = {
    binding,
    manifest,
    auditIntentRef: "audit-1",
    durableProgressResponsibilityRef: "responsibility-1",
  };
  const record = {
    schemaVersion: 1,
    binding,
    progress: initialPurgeProgressV1(manifest),
    auditIntentRef: input.auditIntentRef,
    durableProgressResponsibilityRef: input.durableProgressResponsibilityRef,
  };
  const obs = observation(manifest, 0, "observed-present");
  const observationInput = {
    originalTransactionRef: "transaction-observation-1",
    binding,
    observation: obs,
    expectedRecordVersion: 1,
  };
  const receipt = {
    schemaVersion: 1,
    binding,
    originalTransactionRef: observationInput.originalTransactionRef,
    observation: obs,
    recordedAtRecordVersion: 2,
  };
  const progressed = {
    ...record,
    progress: withObservation(record.progress, 0, obs),
  };
  const query = { kind: "retirement", ...input };
  const observationQuery = {
    kind: "observation",
    ...input,
    originalTransactionRef: observationInput.originalTransactionRef,
    observation: obs,
  };
  return {
    manifest,
    binding,
    input,
    record,
    obs,
    observationInput,
    receipt,
    progressed,
    query,
    observationQuery,
  };
}
const f = fixture();
const values = {
  binding: f.binding,
  record: f.record,
  retirementInputObservation: f.input,
  observationInputObservation: f.observationInput,
  receipt: f.receipt,
  query: f.query,
  publicationResult: { kind: "published", record: f.record },
  observationResult: {
    kind: "recorded",
    record: f.progressed,
    receipt: f.receipt,
  },
  readResult: { kind: "found", record: f.record, observationReceipt: null },
  publicationCommit: {
    kind: "committed",
    value: { kind: "published", record: f.record },
  },
  observationCommit: {
    kind: "committed",
    value: { kind: "recorded", record: f.progressed, receipt: f.receipt },
  },
};
function rejects(kind, value) {
  assert.throws(() => parse(kind, value), {
    name: "TypeError",
    message: "Invalid retirement callable value.",
  });
}
for (const [kind, value] of Object.entries(values)) {
  test(`strict roundtrip and detached immutable ${kind}`, () => {
    const input = clone(value);
    const parsed = parse(kind, input);
    assert.equal(encode(kind, parseJson(kind, encode(kind, parsed))), encode(kind, value));
    assert.ok(Object.isFrozen(parsed));
    if (parsed.binding) assert.ok(Object.isFrozen(parsed.binding));
    input.extra = "mutated";
    assert.equal(Object.hasOwn(parsed, "extra"), false);
    rejects(kind, { ...value, extra: true });
  });
}
for (const [field, invalidValue] of [
  ["originalTransactionRef", ""],
  ["originalTransactionRef", "x\n"],
  ["originalTransactionRef", "x".repeat(201)],
  ["originalTransactionRef", "https://example.invalid/path"],
  ["expectedStoppedTransitionRef", "purge-operation-1"],
  ["expectedStoppedTransitionRef", "55555555-5555-1555-8555-555555555555"],
  ["expectedLifecycleGeneration", 0],
  ["expectedLifecycleGeneration", 1.5],
  ["barrierVersion", Number.MAX_SAFE_INTEGER + 1],
  ["barrierVersion", -0],
  ["activationReplayLineageVersion", -1],
  ["activationReplayLineageRef", "lineage with spaces"],
])
  test(`binding rejects ${field} ${JSON.stringify(invalidValue)}`, () =>
    rejects("binding", { ...f.binding, [field]: invalidValue }));

test("removed independent epoch and ambiguous lifecycle field reject", () => {
  rejects("binding", { ...f.binding, retirementGeneration: 1 });
  rejects("binding", {
    ...f.binding,
    lifecycleOperationRef: f.binding.expectedStoppedTransitionRef,
  });
});
test("scope is the canonical manifest scope", () => {
  const b = clone(f.binding);
  b.scope.agentId = "agt_66666666-6666-4666-8666-666666666666";
  rejects("binding", b);
});
test("complete manifest digest and record association are reused", () => {
  const bad = clone(f.record);
  bad.progress.manifest.stores[0].store.claimUid = "successor-uid";
  rejects("record", bad);
  const other = clone(f.record);
  other.binding.manifest.requestRef = "other-request";
  rejects("record", other);
});
test("input inspection view is data only, no verified handle codec", () => {
  rejects("verifiedRetirement", f.input);
  rejects("retirementInputObservation", { ...f.input, verified: true });
});
for (const kind of ["publicationResult", "observationResult", "readResult"]) {
  for (const outcome of ["conflict", "denied", "unavailable"])
    test(`${kind} closed ${outcome}`, () =>
      assert.equal(parse(kind, { kind: outcome }).kind, outcome));
}
for (const kind of ["publicationCommit", "observationCommit"]) {
  test(`${kind} preserves exact unknown locator, no value/permit`, () => {
    assert.equal(
      parse(kind, { kind: "commit-unknown", transactionRef: "original-tx" }).transactionRef,
      "original-tx",
    );
    assert.equal(parse(kind, { kind: "unavailable" }).kind, "unavailable");
    rejects(kind, {
      kind: "commit-unknown",
      transactionRef: "original-tx",
      value: values.publicationResult,
    });
    rejects(kind, {
      kind: "committed",
      transactionRef: "original-tx",
      value: values.publicationResult,
    });
  });
}
test("publication result cannot masquerade as later progress", () =>
  rejects("publicationResult", { kind: "published", record: f.progressed }));
test("observation result requires exact receipt and row correlation", () => {
  const bad = clone(values.observationResult);
  bad.receipt = {
    ...bad.receipt,
    observation: {
      ...bad.receipt.observation,
      evidenceRef: "foreign-evidence",
    },
  };
  rejects("observationResult", bad);
  const future = clone(values.observationResult);
  future.receipt.recordedAtRecordVersion = 3;
  rejects("observationResult", future);
  rejects("observationResult", { kind: "existing", record: f.progressed });
});
test("retained receipt can accompany later progress but not a claimed new advance", () => {
  const later = {
    ...f.progressed,
    progress: withObservation(f.progressed.progress, 1, observation(f.manifest, 1)),
  };
  assert.equal(
    parse("observationResult", {
      kind: "existing",
      record: later,
      receipt: f.receipt,
    }).record.progress.recordVersion,
    3,
  );
  rejects("observationResult", {
    kind: "recorded",
    record: later,
    receipt: f.receipt,
  });
});
test("same row newer observation retains old exact historical receipt", () => {
  const laterObs = observation(f.manifest, 0, "observed-absent", 2);
  const later = {
    ...f.progressed,
    progress: withObservation(f.progressed.progress, 0, laterObs),
  };
  assert.equal(
    parse("readResult", {
      kind: "found",
      record: later,
      observationReceipt: f.receipt,
    }).observationReceipt.recordedAtRecordVersion,
    2,
  );
});
test("observation query requires exact full manifest target", () => {
  parse("query", f.observationQuery);
  const bad = clone(f.observationQuery);
  bad.observation.store.claimUid = "foreign-uid";
  rejects("query", bad);
});
test("canonical JSON rejects duplicates, whitespace, alternate escapes and oversized input", () => {
  const wire = encode("binding", f.binding);
  for (const input of [
    " " + wire,
    wire + "\n",
    wire.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    wire.replace("barrier-1", "barrier\\u002d1"),
    " ".repeat(PURGE_CALLABLE_LIMITS_V1.maxJsonBytes + 1),
  ])
    assert.throws(() => parseJson("binding", input), /Invalid retirement callable value/);
});
test("untrusted snapshot does not invoke accessor", () => {
  let invoked = 0;
  const object = { ...f.binding };
  Object.defineProperty(object, "barrierRef", {
    enumerable: true,
    get() {
      invoked++;
      return "barrier-1";
    },
  });
  rejects("binding", object);
  assert.equal(invoked, 0);
});
test("untrusted exotic, cycles, symbols, hidden keys, sparse arrays, malformed unicode reject", () => {
  const cycle = { ...f.binding };
  cycle.scope = cycle;
  const hidden = { ...f.binding };
  Object.defineProperty(hidden, "hidden", { value: 1 });
  const symbol = { ...f.binding, [Symbol("secret")]: 1 };
  const sparse = clone(f.record);
  delete sparse.progress.stores[0];
  for (const value of [
    cycle,
    hidden,
    symbol,
    new Date(),
    { ...f.binding, barrierRef: "\ud800" },
    { ...f.binding, barrierRef: undefined },
  ])
    rejects("binding", value);
  rejects("record", sparse);
});
test("bounded nesting and arrays reject before semantic decoding", () => {
  let nested = null;
  for (let i = 0; i < 30; i++) nested = { nested };
  rejects("binding", { ...f.binding, scope: nested });
  rejects("record", {
    ...f.record,
    progress: { stores: Array(257).fill(null) },
  });
});

for (const step of ["barrier", "record", "lifecycle", "audit", "responsibility"]) {
  test(`modeled caught failure after ${step} rolls back all participants`, async () => {
    const model = new AtomicRetirementModel();
    const result = await model.publish(f.binding.originalTransactionRef, f.input, {
      failAfter: step,
    });
    assert.equal(result.kind, "unavailable");
    assert.ok(Object.values(model.state).every((value) => value === null));
    assert.equal((await model.findRetirementManifest(f.query)).kind, "not-found");
  });
}
test("modeled provisional local success is invisible until actual modeled commit", async () => {
  const model = new AtomicRetirementModel();
  const result = await model.publish(f.binding.originalTransactionRef, f.input, {
    beforeCommit: async (local) => {
      assert.equal(local.kind, "published");
      assert.equal(model.state.record, null);
      assert.equal((await model.findRetirementManifest(f.query)).kind, "unavailable");
    },
  });
  assert.equal(result.kind, "committed");
  assert.ok(Object.values(model.state).every((value) => value !== null));
  assert.equal((await model.findRetirementManifest(f.query)).kind, "found");
});
test("modeled throw after provisional success rolls back entire accepted unit", async () => {
  const model = new AtomicRetirementModel();
  const r = await model.publish(f.binding.originalTransactionRef, f.input, {
    beforeCommit: () => {
      throw new Error("synthetic");
    },
  });
  assert.equal(r.kind, "unavailable");
  assert.equal(model.state.barrier, null);
});
test("modeled activation first makes stopped inventory stale", async () => {
  const model = new AtomicRetirementModel();
  model.activate();
  assert.equal(
    (await model.publish(f.binding.originalTransactionRef, f.input)).value.kind,
    "conflict",
  );
  assert.equal(model.state.barrier, null);
});
test("modeled activation wins while retirement is preparing", async () => {
  const model = new AtomicRetirementModel();
  const r = await model.publish(f.binding.originalTransactionRef, f.input, {
    beforeCommit: () => assert.equal(model.activate(), "activated"),
  });
  assert.equal(r.value.kind, "conflict");
  assert.equal(model.state.barrier, null);
});
for (const operation of ["intake", "dispatch", "checkpoint", "head-advance", "delivery"]) {
  test(`modeled retirement first denies late old-generation ${operation}`, async () => {
    const model = new AtomicRetirementModel();
    await model.publish(f.binding.originalTransactionRef, f.input);
    assert.equal(model.acceptOldGeneration(operation), "denied");
    assert.equal(model.acceptedExternalOwners.size, 0);
  });
}
test("modeled prior accepted external work remains unresolved and owned", async () => {
  const model = new AtomicRetirementModel();
  assert.equal(model.acceptOldGeneration("unknown-external-write"), "accepted");
  await model.publish(f.binding.originalTransactionRef, f.input);
  assert.ok(model.acceptedExternalOwners.has("unknown-external-write"));
  assert.equal(model.activate(), "denied");
  assert.equal(model.oldGenerationResume(), "denied");
  assert.equal(model.compareDeleteTarget("delete-claim-1", "successor-uid"), "conflict");
  assert.equal(model.calls.delete, 0);
});
test("explicit transaction mismatch and initial publication reuse conflict", async () => {
  const model = new AtomicRetirementModel();
  assert.equal((await model.publish("diagnostic-request-id", f.input)).value.kind, "conflict");
  assert.equal(
    (await model.publish(f.binding.originalTransactionRef, f.input)).value.kind,
    "published",
  );
  assert.equal(
    (await model.publish(f.binding.originalTransactionRef, f.input)).value.kind,
    "conflict",
  );
});
test("modeled unknown committed publication recovers exact history after later head, without replay", async () => {
  const model = new AtomicRetirementModel();
  const unknown = await model.publish(f.binding.originalTransactionRef, f.input, {
    loseAcknowledgment: true,
  });
  assert.equal(unknown.transactionRef, f.binding.originalTransactionRef);
  model.modelLaterLifecycleHead();
  const found = await reconcileUnknownPurgeV1(model, f.query, unknown, {});
  assert.equal(found.kind, "found");
  assert.equal(found.record.binding.expectedLifecycleGeneration, 7);
  assert.deepEqual(model.calls, {
    publish: 1,
    observe: 0,
    read: 1,
    delete: 0,
    resume: 0,
  });
});
for (const status of ["not-found", "unavailable", "denied", "conflict"]) {
  test(`unknown recovery preserves non-actionable ${status}`, async () => {
    const reader = { findRetirementManifest: async () => ({ kind: status }) };
    assert.equal(
      (
        await reconcileUnknownPurgeV1(
          reader,
          f.query,
          {
            kind: "commit-unknown",
            transactionRef: f.binding.originalTransactionRef,
          },
          {},
        )
      ).kind,
      status,
    );
  });
}
test("unknown with wrong locator, malformed result or known result never reads", async () => {
  let reads = 0;
  const reader = {
    findRetirementManifest: async () => {
      reads++;
      return { kind: "not-found" };
    },
  };
  for (const result of [
    { kind: "commit-unknown", transactionRef: "other" },
    { kind: "unavailable" },
    values.publicationCommit,
    {
      kind: "commit-unknown",
      transactionRef: f.binding.originalTransactionRef,
      start: true,
    },
  ])
    assert.equal((await reconcileUnknownPurgeV1(reader, f.query, result, {})).kind, "unavailable");
  assert.equal(reads, 0);
});
for (const [field, changed] of [
  ["originalTransactionRef", "other-transaction"],
  ["expectedStoppedTransitionRef", "66666666-6666-4666-8666-666666666666"],
  ["expectedLifecycleGeneration", 8],
  ["barrierRef", "other-barrier"],
  ["barrierVersion", 3],
  ["activationReplayLineageRef", "other-lineage"],
  ["activationReplayLineageVersion", 5],
])
  test(`historical comparison rejects different ${field} under same manifest`, async () => {
    const record = clone(f.record);
    record.binding[field] = changed;
    const found = { kind: "found", record, observationReceipt: null };
    assert.equal(purgeHistoryMatchesV1(f.query, found), false);
    const r = await reconcileUnknownPurgeV1(
      { findRetirementManifest: async () => found },
      f.query,
      {
        kind: "commit-unknown",
        transactionRef: f.binding.originalTransactionRef,
      },
      {},
    );
    assert.equal(r.kind, "conflict");
  });
test("historical receipt idempotence after another store advances preserves first evidence", async () => {
  const model = new AtomicRetirementModel();
  await model.publish(f.binding.originalTransactionRef, f.input);
  const first = await model.observe(f.observationInput.originalTransactionRef, f.observationInput);
  assert.equal(first.value.kind, "recorded");
  const secondInput = {
    ...f.observationInput,
    originalTransactionRef: "observation-tx-2",
    expectedRecordVersion: 2,
    observation: observation(f.manifest, 1),
  };
  assert.equal(
    (await model.observe(secondInput.originalTransactionRef, secondInput)).value.kind,
    "recorded",
  );
  const existing = await model.observe(
    f.observationInput.originalTransactionRef,
    f.observationInput,
  );
  assert.equal(existing.value.kind, "existing");
  assert.equal(existing.value.record.progress.recordVersion, 3);
  assert.equal(existing.value.receipt.recordedAtRecordVersion, 2);
  assert.equal(encode("receipt", existing.value.receipt), encode("receipt", first.value.receipt));
  assert.equal(model.receipts.size, 2);
  const denied = await model.observe(
    f.observationInput.originalTransactionRef,
    f.observationInput,
    { authorized: false },
  );
  assert.equal(denied.value.kind, "denied");
});
test("new stale observation is not historical replay; changed receipt conflicts", async () => {
  const model = new AtomicRetirementModel();
  await model.publish(f.binding.originalTransactionRef, f.input);
  await model.observe(f.observationInput.originalTransactionRef, f.observationInput);
  const stale = {
    ...f.observationInput,
    originalTransactionRef: "new-tx",
    observation: observation(f.manifest, 1),
  };
  assert.equal((await model.observe(stale.originalTransactionRef, stale)).value.kind, "conflict");
  const changed = clone(f.observationInput);
  changed.observation.evidenceRef = "replacement-evidence";
  assert.equal(
    (await model.observe(changed.originalTransactionRef, changed)).value.kind,
    "conflict",
  );
  assert.equal(model.state.record.progress.recordVersion, 2);
});
test("unknown observation recovers its exact receipt with later current progress", async () => {
  const model = new AtomicRetirementModel();
  await model.publish(f.binding.originalTransactionRef, f.input);
  const unknown = await model.observe(
    f.observationInput.originalTransactionRef,
    f.observationInput,
    { loseAcknowledgment: true },
  );
  const next = {
    ...f.observationInput,
    originalTransactionRef: "next-tx",
    expectedRecordVersion: 2,
    observation: observation(f.manifest, 1),
  };
  await model.observe(next.originalTransactionRef, next);
  model.modelLaterLifecycleHead();
  const found = await reconcileUnknownPurgeV1(model, f.observationQuery, unknown, {});
  assert.equal(found.kind, "found");
  assert.equal(found.observationReceipt.recordedAtRecordVersion, 2);
  assert.equal(found.record.progress.recordVersion, 3);
  assert.equal(model.calls.observe, 2);
  model.readAuthorized = false;
  assert.equal(
    (await reconcileUnknownPurgeV1(model, f.observationQuery, unknown, {})).kind,
    "denied",
  );
});
test("observation rollback leaves both receipt and current progress unchanged", async () => {
  const model = new AtomicRetirementModel();
  await model.publish(f.binding.originalTransactionRef, f.input);
  assert.equal(
    (
      await model.observe(f.observationInput.originalTransactionRef, f.observationInput, {
        failBeforeCommit: true,
      })
    ).kind,
    "unavailable",
  );
  assert.equal(model.state.record.progress.recordVersion, 1);
  assert.equal(model.receipts.size, 0);
});
test("untrusted history cannot substitute missing or unrelated exact observation receipt", async () => {
  const result = {
    kind: "found",
    record: f.progressed,
    observationReceipt: null,
  };
  assert.equal(purgeHistoryMatchesV1(f.observationQuery, result), false);
  const other = {
    kind: "found",
    record: f.progressed,
    observationReceipt: { ...f.receipt, originalTransactionRef: "other-tx" },
  };
  assert.equal(purgeHistoryMatchesV1(f.observationQuery, other), false);
});
for (const field of ["auditIntentRef", "durableProgressResponsibilityRef"]) {
  test(`history binds original ${field} as well as manifest`, () => {
    const record = { ...f.record, [field]: "replacement" };
    assert.equal(
      purgeHistoryMatchesV1(f.query, {
        kind: "found",
        record,
        observationReceipt: null,
      }),
      false,
    );
  });
}
test("independent publication consumer preserves the explicit original locator and validates returned binding", async () => {
  const received = [];
  let readCalls = 0;
  const inputHandle = Object.freeze({ syntheticOpaqueInput: true });
  const journal = {
    publishRetirementManifest: async (...args) => {
      received.push(args);
      return values.publicationCommit;
    },
    findRetirementManifest: async () => {
      throw new Error("unexpected");
    },
  };
  const r = await publishAndReport(journal, f.query, inputHandle, {}, async () => {
    readCalls++;
    return {};
  });
  assert.equal(r.kind, "committed");
  assert.equal(received[0][0], f.binding.originalTransactionRef);
  assert.equal(received[0][1], inputHandle);
  assert.equal(readCalls, 0);
  const wrong = clone(values.publicationCommit);
  wrong.value.record.auditIntentRef = "wrong";
  journal.publishRetirementManifest = async () => wrong;
  assert.equal(
    (await publishAndReport(journal, f.query, inputHandle, {}, async () => ({}))).kind,
    "conflict",
  );
});
test("independent observation consumer uses fresh read only after unknown and retains exact receipt", async () => {
  let sends = 0;
  let freshCalls = 0;
  const journal = {
    recordRetiredStoreObservation: async (tx) => {
      sends++;
      assert.equal(tx, f.observationInput.originalTransactionRef);
      return { kind: "commit-unknown", transactionRef: tx };
    },
    findRetirementManifest: async (query, call) => {
      assert.equal(query.kind, "observation");
      assert.equal(call.syntheticRead, 1);
      return {
        kind: "found",
        record: f.progressed,
        observationReceipt: f.receipt,
      };
    },
  };
  const result = await recordObservationAndReport(journal, f.observationQuery, {}, {}, async () => {
    freshCalls++;
    return { syntheticRead: 1 };
  });
  assert.equal(result.kind, "found");
  assert.equal(sends, 1);
  assert.equal(freshCalls, 1);
});
for (const scenario of [
  "terminal-absence",
  "same-global-version",
  "sequence-distance",
  "backward-time",
  "reused-observation-ref",
]) {
  test(`historical receipt rejects impossible ${scenario} successor`, () => {
    const nextObservation = observation(f.manifest, 0, "observed-present", 2);
    const record = {
      ...f.progressed,
      progress: withObservation(f.progressed.progress, 0, nextObservation),
    };
    const receipt = clone(f.receipt);
    if (scenario === "terminal-absence") receipt.observation.outcome = "observed-absent";
    if (scenario === "same-global-version")
      receipt.recordedAtRecordVersion = record.progress.recordVersion;
    if (scenario === "sequence-distance")
      record.progress.stores[0].state.observation.observationSequence = 3;
    if (scenario === "backward-time")
      record.progress.stores[0].state.observation.observedAt = "2026-01-01T00:00:00.000Z";
    if (scenario === "reused-observation-ref")
      record.progress.stores[0].state.observation.observationRef =
        receipt.observation.observationRef;
    rejects("readResult", {
      kind: "found",
      record,
      observationReceipt: receipt,
    });
    rejects("observationResult", { kind: "existing", record, receipt });
  });
}

for (const scenario of ["same-locator", "different-locator", "unknown-first-commit"]) {
  test(`overlapping modeled publications preserve one winner: ${scenario}`, async () => {
    const model = new AtomicRetirementModel();
    let releaseFirst, releaseSecond;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise((resolve) => {
      releaseSecond = resolve;
    });
    const secondInput = clone(f.input);
    if (scenario === "different-locator") {
      const body = manifestBody();
      body.purgeOperationRef = "purge-operation-2";
      body.requestRef = "purge-request-2";
      secondInput.manifest = createPurgeManifestV1(body);
      secondInput.binding.manifest = purgeManifestLocatorV1(secondInput.manifest);
      secondInput.binding.originalTransactionRef = "transaction-publication-2";
      secondInput.binding.barrierRef = "barrier-2";
    }
    const first = model.publish(f.binding.originalTransactionRef, f.input, {
      beforeCommit: () => firstGate,
      loseAcknowledgment: scenario === "unknown-first-commit",
    });
    const second = model.publish(secondInput.binding.originalTransactionRef, secondInput, {
      beforeCommit: () => secondGate,
    });
    assert.equal(model.pendingUnits, 2);
    releaseFirst();
    const winner = await first;
    assert.equal(winner.kind, scenario === "unknown-first-commit" ? "commit-unknown" : "committed");
    if (winner.kind === "committed") assert.equal(winner.value.kind, "published");
    assert.equal(model.pendingUnits, 1);
    assert.equal((await model.findRetirementManifest(f.query)).kind, "unavailable");
    releaseSecond();
    const loser = await second;
    assert.equal(loser.kind, "committed");
    assert.equal(loser.value.kind, "conflict");
    assert.equal(model.pendingUnits, 0);
    const found = await model.findRetirementManifest(f.query);
    assert.equal(found.kind, "found");
    assert.equal(found.record.binding.originalTransactionRef, f.binding.originalTransactionRef);
    assert.equal(found.record.binding.barrierRef, f.binding.barrierRef);
  });
}
