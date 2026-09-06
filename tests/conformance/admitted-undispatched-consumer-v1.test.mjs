import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTurnJournalV1 as parse,
  parseTurnJournalJsonV1 as parseJson,
  parseTurnJournalResultV1 as result,
  parseTurnJournalResultJsonV1 as resultJson,
  journalDispatchIntentMatchesV1,
  journalCancellationBeforeDispatchMatchesV1,
  journalOutcomeTransitionAllowedV1,
  journalReleaseMatchesV1,
  journalCompletionMatchesV1,
  createJournalInitiatorV1,
} from "../../packages/contracts/src/turn-journal-v1.ts";
import {
  admittedValue,
  projectAttemptStatus,
  cancelBeforeDispatchAndRead,
} from "../fixtures/admitted-undispatched-consumer-v1/consumer.ts";
import * as v from "../fixtures/turn-journal-v1/values.mjs";

function common() {
  return {
    attempt: v.copy(v.attempt),
    identity: v.copy(v.identity),
    reservation: v.copy(v.reservation),
    expectedHead: v.copy(v.head),
  };
}
function admitted() {
  return admittedValue(common());
}
function beforeOutcome(kind = "cancelled") {
  return {
    ...v.copy(v.outcome),
    expectedAttemptVersion: 1,
    outcome: { kind, stage: "before-dispatch", evidenceRef: "before-dispatch-evidence" },
  };
}
function cancelled() {
  return { ...admitted(), version: 2, outcome: beforeOutcome().outcome };
}
function cancellation() {
  return {
    schemaVersion: 1,
    attempt: v.copy(v.attempt),
    operationRef: "cancellation-one",
    requesterPrincipalRef: "principal-one",
    originalPrincipalRef: "principal-one",
    expectedAttemptVersion: 1,
    requestDigest: "9".repeat(64),
  };
}
function intent() {
  return {
    binding: v.copy(v.attemptRecord.binding),
    version: 2,
    consumption: null,
    outcome: {
      kind: "dispatch-intent",
      dispatchOperationRef: v.attemptRecord.binding.dispatchOperationRef,
    },
  };
}
function deniedValue(fn) {
  try {
    assert.equal(fn(), false);
  } catch (error) {
    if (error.message !== "Invalid turn journal V1 value.") throw error;
  }
}

test("committed admission facts form a visible canonical attempt without dispatch aliases", () => {
  const record = admitted();
  assert.deepEqual(Object.keys(record.binding).sort(), [
    "attempt",
    "expectedHead",
    "identity",
    "reservation",
  ]);
  assert.equal(record.phase, "admitted-undispatched");
  assert.equal(record.consumption, null);
  assert.equal(Object.hasOwn(record.binding, "dispatchOperationRef"), false);
  assert.equal(Object.hasOwn(record.binding, "authorityDecisionRef"), false);
  assert.equal(Object.hasOwn(record.binding, "expiresAt"), false);
  const decoded = parseJson("attempt", JSON.stringify(record));
  assert.equal(decoded.version, 1);
  assert.ok(Object.isFrozen(decoded.binding.reservation));
  const found = resultJson("attemptState", JSON.stringify({ kind: "found", record }));
  assert.equal(found.kind, "found");
  assert.equal(found.record.binding.attempt.attemptRef, v.attempt.attemptRef);
});
for (const kind of ["failed", "interrupted", "outcome-unknown", "cancelled"]) {
  test(`common ownership survives ${kind} before dispatch`, () => {
    const record = { ...admitted(), version: 2, outcome: beforeOutcome(kind).outcome };
    const found = result("attemptState", { kind: "found", record });
    assert.equal(found.record.outcome.kind, kind);
    assert.equal(found.record.phase, "admitted-undispatched");
    assert.equal(result("outcome", { kind: "recorded", record }).record.consumption, null);
    assert.equal(journalOutcomeTransitionAllowedV1(admitted(), beforeOutcome(kind)), true);
  });
}
for (const field of ["dispatchOperationRef", "authorityDecisionRef", "expiresAt"]) {
  test(`common binding forbids fabricated ${field}`, () => {
    const record = v.copy(admitted());
    record.binding[field] = v.attemptRecord.binding[field];
    assert.throws(() => parse("attempt", record), /Invalid turn journal/);
  });
  test(`full dispatch binding still requires ${field}`, () => {
    const record = intent();
    delete record.binding[field];
    assert.throws(() => parse("attempt", record), /Invalid turn journal/);
  });
}
test("common branch requires explicit phase, exact null consumption and closed record", () => {
  const noPhase = v.copy(admitted());
  delete noPhase.phase;
  for (const record of [
    noPhase,
    { ...admitted(), consumption: v.attemptRecord.consumption },
    { ...admitted(), verified: true },
    { ...admitted(), phase: "running" },
  ])
    assert.throws(() => parse("attempt", record), /Invalid turn journal/);
});
for (const outcome of [
  intent().outcome,
  v.attemptRecord.outcome,
  { kind: "running", nativeSessionRef: "session-one", nativeTurnRef: "turn-one" },
  { kind: "completed", checkpoint: v.checkpoint, completionOperationRef: "complete-one" },
  { kind: "failed", stage: "execution", evidenceRef: "failure" },
  { kind: "outcome-unknown", stage: "dispatch", evidenceRef: "unknown" },
])
  test(`common phase rejects ${outcome.kind}/${outcome.stage ?? "none"}`, () => {
    assert.throws(() => parse("attempt", { ...admitted(), outcome }), /Invalid turn journal/);
  });
test("original genuine dispatch-bound wire projection remains valid", () => {
  assert.equal(parse("attempt", v.attemptRecord).outcome.kind, "consumed");
  assert.equal(
    parse("attemptBinding", v.attemptRecord.binding).authorityDecisionRef,
    "authority-one",
  );
  assert.equal(
    result("dispatchIntent", { kind: "recorded", record: intent() }).record.outcome.kind,
    "dispatch-intent",
  );
  assert.throws(
    () => result("dispatchIntent", { kind: "recorded", record: admitted() }),
    /Invalid turn journal/,
  );
});
test("pure intent correspondence preserves common identity and exact version", () => {
  assert.equal(journalDispatchIntentMatchesV1(admitted(), intent(), 1), true);
  assert.equal(journalDispatchIntentMatchesV1(admitted(), intent(), 2), false);
  assert.equal(journalDispatchIntentMatchesV1(cancelled(), intent(), 2), false);
  const wrong = intent();
  wrong.outcome.dispatchOperationRef = "different-dispatch";
  assert.throws(() => parse("attempt", wrong), /Invalid turn journal/);
});
for (const mutation of ["attempt", "identity", "reservation", "head", "version"]) {
  test(`intent rejects changed ${mutation}`, () => {
    const next = intent();
    if (mutation === "attempt") next.binding.attempt.attemptRef = "attempt-two";
    if (mutation === "identity") next.binding.identity.principalRef = "principal-two";
    if (mutation === "reservation") next.binding.reservation.reservationVersion++;
    if (mutation === "head") next.binding.expectedHead.headVersion++;
    if (mutation === "version") next.version++;
    deniedValue(() => journalDispatchIntentMatchesV1(admitted(), next, 1));
  });
}
test("unknown-before-dispatch can be resolved only in the same common phase", () => {
  const unknown = { ...admitted(), version: 2, outcome: beforeOutcome("outcome-unknown").outcome };
  const resolved = { ...beforeOutcome("interrupted"), expectedAttemptVersion: 2 };
  assert.equal(journalOutcomeTransitionAllowedV1(unknown, resolved), true);
  assert.equal(
    journalOutcomeTransitionAllowedV1(unknown, {
      ...resolved,
      outcome: { kind: "failed", stage: "execution", evidenceRef: "fake-terminal" },
    }),
    false,
  );
  assert.equal(
    journalOutcomeTransitionAllowedV1(admitted(), { ...v.outcome, expectedAttemptVersion: 1 }),
    false,
  );
});
test("common status is never a completion publication", () => {
  assert.equal(
    journalCompletionMatchesV1({
      currentAttempt: admitted(),
      currentHead: v.head,
      allocation: v.allocation,
      candidate: v.completion,
      expectedAttemptVersion: 1,
    }),
    false,
  );
});
for (const stage of ["execution", "checkpoint"]) {
  for (const kind of ["failed", "interrupted", "outcome-unknown", "cancelled"]) {
    test(`full ${kind}/${stage} retains immutable consumption in standalone and result codecs`, () => {
      const record = {
        ...intent(),
        outcome: { kind, stage, evidenceRef: "later-stage-evidence" },
      };
      assert.throws(() => parse("attempt", record), /Invalid turn journal/);
      assert.throws(() => parseJson("attempt", JSON.stringify(record)), /Invalid turn journal/);
      for (const [resultKind, carrierKind] of [
        ["attemptState", "found"],
        ["outcome", "recorded"],
      ]) {
        const carrier = { kind: carrierKind, record };
        assert.throws(() => result(resultKind, carrier), /Invalid turn journal/);
        assert.throws(
          () => resultJson(resultKind, JSON.stringify(carrier)),
          /Invalid turn journal/,
        );
      }
      const consumed = { ...record, consumption: v.copy(v.attemptRecord.consumption) };
      assert.equal(parse("attempt", consumed).outcome.stage, stage);
    });
  }
}
for (const kind of ["failed", "interrupted", "outcome-unknown", "cancelled"]) {
  test(`early full authorization cannot promote before-dispatch unknown to ${kind}/dispatch`, () => {
    const current = { ...intent(), outcome: beforeOutcome("outcome-unknown").outcome };
    const operation = {
      ...beforeOutcome(kind),
      expectedAttemptVersion: current.version,
      outcome: { kind, stage: "dispatch", evidenceRef: "dispatch-evidence" },
    };
    assert.equal(journalOutcomeTransitionAllowedV1(current, operation), false);
    assert.equal(
      journalOutcomeTransitionAllowedV1(current, {
        ...operation,
        outcome: beforeOutcome(kind).outcome,
      }),
      true,
    );
    assert.equal(journalOutcomeTransitionAllowedV1(intent(), operation), true);
  });
}
for (const carrierKind of ["recorded", "existing"]) {
  test(`dispatch intent ${carrierKind} cannot report accepted or before-dispatch ownership`, () => {
    for (const outcome of [
      { kind: "accepted-undispatched" },
      ...["failed", "interrupted", "outcome-unknown", "cancelled"].map(
        (kind) => beforeOutcome(kind).outcome,
      ),
    ]) {
      const carrier = { kind: carrierKind, record: { ...intent(), outcome } };
      assert.throws(() => result("dispatchIntent", carrier), /Invalid turn journal/);
      assert.throws(
        () => resultJson("dispatchIntent", JSON.stringify(carrier)),
        /Invalid turn journal/,
      );
    }
    assert.equal(
      result("dispatchIntent", { kind: carrierKind, record: intent() }).record.outcome.kind,
      "dispatch-intent",
    );
  });
}
test("existing intent may report later retained progress but newly recorded intent cannot", () => {
  const records = [
    v.copy(v.attemptRecord),
    {
      ...intent(),
      outcome: { kind: "outcome-unknown", stage: "dispatch", evidenceRef: "dispatch-unknown" },
    },
    {
      ...v.copy(v.attemptRecord),
      outcome: { kind: "failed", stage: "execution", evidenceRef: "execution-failed" },
    },
  ];
  for (const record of records) {
    assert.equal(
      result("dispatchIntent", { kind: "existing", record }).record.outcome.kind,
      record.outcome.kind,
    );
    assert.throws(
      () => result("dispatchIntent", { kind: "recorded", record }),
      /Invalid turn journal/,
    );
  }
});
test("cancellation-before-dispatch comparison binds original version and principal", () => {
  assert.equal(journalCancellationBeforeDispatchMatchesV1(admitted(), cancellation()), true);
  assert.equal(
    journalCancellationBeforeDispatchMatchesV1(intent(), {
      ...cancellation(),
      expectedAttemptVersion: 2,
    }),
    false,
  );
  assert.equal(
    journalCancellationBeforeDispatchMatchesV1(admitted(), {
      ...cancellation(),
      originalPrincipalRef: "another",
    }),
    false,
  );
  assert.equal(
    journalCancellationBeforeDispatchMatchesV1(admitted(), {
      ...cancellation(),
      expectedAttemptVersion: 2,
    }),
    false,
  );
});
test("release correlation accepts common reservation but never invents no-mutator evidence", () => {
  const release = { ...v.copy(v.release), expectedAttemptVersion: 2 };
  assert.equal(journalReleaseMatchesV1(cancelled(), release), true);
  assert.equal(
    journalReleaseMatchesV1(cancelled(), { ...release, expectedAttemptVersion: 1 }),
    false,
  );
  const partial = { ...release };
  delete partial.noMutatorEvidenceRef;
  assert.throws(() => journalReleaseMatchesV1(cancelled(), partial), /Invalid turn journal/);
  assert.throws(
    () => journalReleaseMatchesV1(cancelled(), { ...release, leaseExpired: true }),
    /Invalid turn journal/,
  );
  const status = projectAttemptStatus({ kind: "found", record: cancelled() });
  assert.equal(status.release, "unverified");
  assert.equal(status.initiation, "none");
  assert.equal(status.binding.reservation.reservationRef, v.attempt.reservationRef);
});
for (const kind of ["absent", "unavailable", "denied"])
  test(`${kind} attempt read cannot release/replay known ownership`, () => {
    const status = projectAttemptStatus({ kind });
    assert.equal(status.kind, "ownership-unresolved");
    assert.equal(status.release, "unverified");
    assert.equal(status.initiation, "none");
  });

function fakeStore(options = {}) {
  const calls = { transactions: 0, mutations: 0, reads: 0, released: 0, initiated: 0 };
  let unitOpen = false;
  const operation = cancellation();
  const value = { kind: "recorded", operation, outcome: "cancelled-before-dispatch" };
  const store = {
    async transact(tx, work) {
      calls.transactions++;
      unitOpen = true;
      const provisional = await work({
        commitCancellation: async () => {
          calls.mutations++;
          return value;
        },
      });
      assert.equal(unitOpen, true);
      unitOpen = false;
      return options.commit ?? { kind: "committed", value: provisional };
    },
    async read(work) {
      assert.equal(unitOpen, false);
      calls.reads++;
      return work({
        findCancellation: async () =>
          options.cancellation ?? {
            kind: "found",
            operation,
            outcome: "cancelled-before-dispatch",
          },
        findAttempt: async () => options.attempt ?? { kind: "found", record: cancelled() },
      });
    },
  };
  return { store, calls };
}
for (const mode of ["known-commit", "unknown-commit"])
  test(`independent cancellation consumer ${mode} keeps common ownership and no termination/release`, async () => {
    const setup = fakeStore(
      mode === "unknown-commit"
        ? { commit: { kind: "commit-unknown", transactionRef: "cancel-tx" } }
        : {},
    );
    const reply = await cancelBeforeDispatchAndRead(
      setup.store,
      "cancel-tx",
      admitted(),
      cancellation(),
      {},
      {},
      async () => ({}),
    );
    assert.equal(reply.kind, "cancelled-before-dispatch");
    assert.equal(reply.release, "unverified");
    assert.equal(reply.termination, "unverified");
    assert.equal(reply.initiation, "none");
    assert.deepEqual(Object.keys(reply.binding).sort(), [
      "attempt",
      "expectedHead",
      "identity",
      "reservation",
    ]);
    assert.deepEqual(setup.calls, {
      transactions: 1,
      mutations: 1,
      reads: 1,
      released: 0,
      initiated: 0,
    });
  });
for (const kind of ["absent", "unavailable", "denied"])
  test(`unknown cancellation ${kind} read remains unresolved without mutation retry`, async () => {
    const setup = fakeStore({
      commit: { kind: "commit-unknown", transactionRef: "cancel-tx" },
      cancellation: { kind },
    });
    const reply = await cancelBeforeDispatchAndRead(
      setup.store,
      "cancel-tx",
      admitted(),
      cancellation(),
      {},
      {},
      async () => ({}),
    );
    assert.equal(reply.kind, "unresolved");
    assert.equal(reply.binding.reservation.reservationRef, v.attempt.reservationRef);
    assert.equal(setup.calls.transactions, 1);
    assert.equal(setup.calls.mutations, 1);
  });
test("unknown cancellation cannot borrow a different transaction or changed record", async () => {
  const wrongTx = fakeStore({ commit: { kind: "commit-unknown", transactionRef: "other-tx" } });
  assert.equal(
    (
      await cancelBeforeDispatchAndRead(
        wrongTx.store,
        "cancel-tx",
        admitted(),
        cancellation(),
        {},
        {},
        async () => ({}),
      )
    ).kind,
    "unresolved",
  );
  assert.equal(wrongTx.calls.reads, 0);
  const record = v.copy(cancelled());
  record.binding.reservation.reservationVersion++;
  const changed = fakeStore({ attempt: { kind: "found", record } });
  assert.equal(
    (
      await cancelBeforeDispatchAndRead(
        changed.store,
        "cancel-tx",
        admitted(),
        cancellation(),
        {},
        {},
        async () => ({}),
      )
    ).kind,
    "unresolved",
  );
});
for (const returned of [
  { kind: "commit-unknown", transactionRef: "consume-original" },
  { kind: "unavailable" },
  {
    kind: "committed",
    value: { kind: "already-consumed", operation: v.attemptRecord.consumption.operation },
  },
])
  test(`original consumption ${returned.kind}/${returned.value?.kind ?? "none"} yields no initiation from readback`, async () => {
    let starts = 0;
    let inspections = 0;
    const consumeAndInitiate = createJournalInitiatorV1({
      now: () => 10,
      consume: async () => returned,
      inspectCommittedClaim: async () => {
        inspections++;
        throw new Error("must not inspect");
      },
    });
    const result = await consumeAndInitiate(
      {},
      async () => {
        starts++;
      },
      { signal: new AbortController().signal },
    );
    assert.ok(["commit-unknown", "unavailable", "already-consumed"].includes(result.kind));
    assert.equal(starts, 0);
    assert.equal(inspections, 0);
  });
