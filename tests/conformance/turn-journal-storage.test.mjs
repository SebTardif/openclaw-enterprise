import assert from "node:assert/strict";
import test from "node:test";
import { TurnJournalStore } from "../../packages/occ/src/turn-journal/store.ts";
import {
  TurnJournalTransactionGuard,
  takeCommittedTurnJournalClaim,
} from "../../packages/occ/src/turn-journal/transaction-guard.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { attemptRecord } from "../fixtures/turn-journal-v1/values.mjs";
import * as values from "../fixtures/turn-journal-v1/values.mjs";
import {
  journalCancellationBeforeDispatchMatchesV1,
  journalDispatchIntentMatchesV1,
  journalOutcomeTransitionAllowedV1,
  parseTurnJournalResultV1,
  parseTurnJournalV1,
} from "../../packages/contracts/src/turn-journal-v1.ts";
import {
  parseOwnerRow,
  parseAttemptRow,
  parseAttemptFirstReceivedAt,
  parseOperationRow,
  TurnJournalRowError,
} from "../../packages/occ/src/turn-journal/rows.ts";
import {
  commonAttemptRecord,
  deferred,
  ref,
  storageProvenance,
} from "../fixtures/turn-journal-storage/values.mjs";

function attemptRow(record) {
  const { attempt, identity, reservation } = record.binding;
  return {
    installation_id: attempt.installationRef,
    namespace_id: attempt.namespaceRef,
    agent_id: attempt.agentRef,
    conversation_ref: attempt.conversationRef,
    turn_ref: attempt.turnRef,
    attempt_ref: attempt.attemptRef,
    reservation_ref: attempt.reservationRef,
    channel_installation_id: identity.locator.channelInstallationRef,
    admission_receipt_ref: identity.receipt.receiptRef,
    reservation,
    first_received_at: values.admission.decidedAt,
    version: String(record.version),
    record,
  };
}

test("canonical common rows retain admission facts without manufacturing dispatch fields", () => {
  const record = commonAttemptRecord(values);
  const row = attemptRow(record);
  const before = structuredClone(row);
  const decoded = parseAttemptRow(row);
  assert.equal(decoded.phase, "admitted-undispatched");
  assert.equal(decoded.version, 1);
  assert.equal(decoded.consumption, null);
  assert.equal(decoded.outcome.kind, "accepted-undispatched");
  assert.deepEqual(Object.keys(decoded.binding).sort(), [
    "attempt",
    "expectedHead",
    "identity",
    "reservation",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(decoded)), record);
  assert.deepEqual(row, before);
  assert.equal(parseAttemptFirstReceivedAt(row), values.admission.decidedAt);
  for (const field of [
    "installation_id",
    "namespace_id",
    "agent_id",
    "conversation_ref",
    "turn_ref",
    "attempt_ref",
    "reservation_ref",
    "channel_installation_id",
    "admission_receipt_ref",
  ])
    assert.throws(
      () => parseAttemptRow({ ...row, [field]: `foreign-${field}` }),
      TurnJournalRowError,
    );
  for (const patch of [
    { record: null },
    { record: undefined },
    { version: "2" },
    { reservation: { ...values.reservation, reservationVersion: 2 } },
    {
      record: { ...record, binding: { ...record.binding, expiresAt: "2026-01-01T00:01:00.000Z" } },
    },
    { record: { ...record, consumption: values.attemptRecord.consumption } },
  ])
    assert.throws(() => parseAttemptRow({ ...row, ...patch }), TurnJournalRowError);
});

function attemptWithScopeExtra(base, extra) {
  const record = structuredClone(base);
  record.binding.identity.workspace.scope = {
    ...record.binding.identity.workspace.scope,
    extra: structuredClone(extra),
  };
  record.binding.reservation.scope = {
    ...record.binding.reservation.scope,
    extra: structuredClone(extra),
  };
  return record;
}

function assertInputPreserved(input, work) {
  const before = structuredClone(input);
  const objects = new Map();
  const capture = (value) => {
    if (value === null || typeof value !== "object" || objects.has(value)) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    objects.set(value, {
      descriptors,
      prototype: Object.getPrototypeOf(value),
      extensible: Object.isExtensible(value),
      keys: Reflect.ownKeys(value),
    });
    for (const descriptor of Object.values(descriptors)) capture(descriptor.value);
  };
  capture(input);
  try {
    return work();
  } finally {
    assert.deepEqual(input, before, "Parsing must preserve caller data.");
    for (const [value, original] of objects) {
      assert.equal(Object.getPrototypeOf(value), original.prototype);
      assert.equal(Object.isExtensible(value), original.extensible);
      assert.deepEqual(Reflect.ownKeys(value), original.keys);
      for (const key of original.keys) {
        const current = Object.getOwnPropertyDescriptor(value, key);
        const previous = original.descriptors[key];
        assert.equal(
          current.value,
          previous.value,
          "Parsing must not replace caller-owned objects.",
        );
        assert.equal(current.writable, previous.writable);
        assert.equal(current.enumerable, previous.enumerable);
        assert.equal(current.configurable, previous.configurable);
      }
    }
  }
}

test("actual codecs preserve partial carriers, annotated heads and extended dates in open scopes", () => {
  const cases = [
    ["partial attempt", { binding: {}, outcome: {}, consumption: null }],
    ["partial head", { kind: "new-context", head: { completionSequence: 0 } }],
    [
      "annotated head",
      { kind: "new-context", head: { ...structuredClone(values.head), annotation: "benign" } },
    ],
    [
      "extended dates",
      { customAt: "+010000-01-01T00:00:00.000Z", earlierAt: "-000001-01-01T00:00:00.000Z" },
    ],
  ];
  for (const [name, extra] of cases) {
    for (const [phase, base] of [
      ["common", commonAttemptRecord(values)],
      ["full", attemptRecord],
    ]) {
      const record = attemptWithScopeExtra(base, extra);
      const row = attemptRow(record);
      assert.notEqual(
        record.binding.identity.workspace.scope.extra,
        record.binding.reservation.scope.extra,
      );
      assertInputPreserved(row, () => {
        let parsed;
        let decoded;
        assert.doesNotThrow(() => {
          parsed = parseTurnJournalV1("attempt", record);
          decoded = parseAttemptRow(row);
        }, `${phase}: ${name} must retain the actual accepted scope domain.`);
        for (const result of [parsed, decoded]) {
          assert.deepEqual(JSON.parse(JSON.stringify(result)), record);
          for (const [actual, original] of [
            [
              result.binding.identity.workspace.scope.extra,
              record.binding.identity.workspace.scope.extra,
            ],
            [result.binding.reservation.scope.extra, record.binding.reservation.scope.extra],
          ]) {
            assert.deepEqual(JSON.parse(JSON.stringify(actual)), extra);
            assert.notEqual(actual, original);
            assert.equal(Object.isFrozen(actual), true);
          }
        }
      });
    }
  }
});

test("actual codecs refuse invalid scope consumption, outcome structure and noncanonical dates without mutating callers", () => {
  const cases = [
    ["numeric consumption", { binding: {}, outcome: {}, consumption: 1 }],
    ["boolean consumption", { binding: {}, outcome: {}, consumption: true }],
    [
      "consumed without consumption",
      { binding: {}, outcome: { kind: "consumed" }, consumption: null },
    ],
    [
      "execution without consumption",
      { binding: {}, outcome: { kind: "failed", stage: "execution" }, consumption: null },
    ],
    ["primitive outcome", { binding: {}, outcome: true, consumption: null }],
    ["nonempty new context", { kind: "new-context", head: { completionSequence: 1 } }],
    ["missing intermediate context", { expectedHead: {}, attempt: {} }],
    ["noncanonical extension date", { customAt: "+010000-01-01T00:00:00.000000Z" }],
  ];
  for (const [name, extra] of cases) {
    for (const base of [commonAttemptRecord(values), attemptRecord]) {
      const record = attemptWithScopeExtra(base, extra);
      const row = attemptRow(record);
      assertInputPreserved(row, () => {
        assert.throws(
          () => parseTurnJournalV1("attempt", record),
          /Invalid turn journal V1 value/,
          name,
        );
        assert.throws(() => parseAttemptRow(row), TurnJournalRowError, name);
      });
    }
  }
  for (const consumption of [1, true]) {
    const record = { ...structuredClone(attemptRecord), consumption };
    const row = attemptRow(record);
    assertInputPreserved(row, () => {
      assert.throws(() => parseTurnJournalV1("attempt", record), /Invalid turn journal V1 value/);
      assert.throws(() => parseAttemptRow(row), TurnJournalRowError);
    });
  }
});

test("open scope acceptance does not broaden closed head or named instant schemas", () => {
  const head = { ...structuredClone(values.head), annotation: "benign" };
  assertInputPreserved(head, () => {
    assert.throws(() => parseTurnJournalV1("head", head), /Invalid turn journal V1 value/);
  });
  for (const decidedAt of ["+010000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z"]) {
    const admission = { ...structuredClone(values.admission), decidedAt };
    assertInputPreserved(admission, () => {
      assert.throws(
        () => parseTurnJournalV1("admission", admission),
        /Invalid turn journal V1 value/,
      );
    });
  }
});

test("common to dispatch matches the exact locked version and recorded result excludes common or consumed history", () => {
  const common = commonAttemptRecord(values);
  const intent = {
    binding: structuredClone(values.attemptRecord.binding),
    version: 2,
    consumption: null,
    outcome: {
      kind: "dispatch-intent",
      dispatchOperationRef: values.attemptRecord.binding.dispatchOperationRef,
    },
  };
  assert.equal(journalDispatchIntentMatchesV1(common, intent, 1), true);
  assert.equal(journalDispatchIntentMatchesV1(common, intent, 2), false);
  const later = { ...common, version: 7 };
  assert.equal(journalDispatchIntentMatchesV1(later, { ...intent, version: 8 }, 7), true);
  assert.equal(journalDispatchIntentMatchesV1(later, intent, 7), false);
  assert.equal(
    parseTurnJournalResultV1("dispatchIntent", { kind: "recorded", record: intent }).kind,
    "recorded",
  );
  assert.equal(
    parseTurnJournalResultV1("dispatchIntent", { kind: "existing", record: values.attemptRecord })
      .kind,
    "existing",
  );
  for (const record of [common, values.attemptRecord])
    assert.throws(() => parseTurnJournalResultV1("dispatchIntent", { kind: "recorded", record }));
  assert.throws(() =>
    parseTurnJournalResultV1("dispatchIntent", { kind: "existing", record: common }),
  );
  const changedHead = structuredClone(intent);
  changedHead.binding.expectedHead.creationRef = "replacement-creation";
  assert.equal(journalDispatchIntentMatchesV1(common, changedHead, 1), false);
});

test("predispatch uncertainty remains common and cannot dispatch or satisfy no-intent cancellation", () => {
  const common = commonAttemptRecord(values);
  const unknownOperation = {
    ...values.outcome,
    expectedAttemptVersion: 1,
    outcome: {
      kind: "outcome-unknown",
      stage: "before-dispatch",
      evidenceRef: "predispatch-unknown",
    },
  };
  assert.equal(journalOutcomeTransitionAllowedV1(common, unknownOperation), true);
  const unknown = { ...common, version: 2, outcome: unknownOperation.outcome };
  assert.equal(parseAttemptRow(attemptRow(unknown)).phase, "admitted-undispatched");
  const cancellation = {
    schemaVersion: 1,
    attempt: values.attempt,
    operationRef: "cancel-before-dispatch",
    requesterPrincipalRef: "requester",
    originalPrincipalRef: values.identity.principalRef,
    expectedAttemptVersion: 2,
    requestDigest: "a".repeat(64),
  };
  assert.equal(journalCancellationBeforeDispatchMatchesV1(unknown, cancellation), false);
  const intent = {
    binding: values.attemptRecord.binding,
    version: 3,
    consumption: null,
    outcome: {
      kind: "dispatch-intent",
      dispatchOperationRef: values.attemptRecord.binding.dispatchOperationRef,
    },
  };
  assert.equal(journalDispatchIntentMatchesV1(unknown, intent, 2), false);
  assert.equal(
    journalOutcomeTransitionAllowedV1(unknown, {
      ...unknownOperation,
      expectedAttemptVersion: 2,
      outcome: {
        kind: "failed",
        stage: "before-dispatch",
        evidenceRef: "resolved-before-dispatch",
      },
    }),
    true,
  );
  assert.equal(
    journalOutcomeTransitionAllowedV1(unknown, { ...values.outcome, expectedAttemptVersion: 2 }),
    false,
  );
  assert.throws(() =>
    parseTurnJournalV1("attempt", { ...unknown, outcome: values.outcome.outcome }),
  );
});

test("common outcome and original cancellation rows preserve exact operation and version correspondence", () => {
  const operation = {
    ...values.outcome,
    expectedAttemptVersion: 1,
    outcome: {
      kind: "failed",
      stage: "before-dispatch",
      evidenceRef: "original-before-dispatch-evidence",
    },
  };
  const record = { ...commonAttemptRecord(values), version: 2, outcome: operation.outcome };
  const row = {
    ...attemptRow(record),
    operation_kind: "outcome",
    operation_ref: operation.operationRef,
    request: operation,
    record,
  };
  assert.equal(parseOperationRow(row).record.phase, "admitted-undispatched");
  assert.throws(
    () => parseOperationRow({ ...row, record: { ...record, version: 3 } }),
    TurnJournalRowError,
  );
  assert.throws(
    () => parseOperationRow({ ...row, operation_ref: "replacement-operation" }),
    TurnJournalRowError,
  );
  const cancellation = {
    schemaVersion: 1,
    attempt: values.attempt,
    operationRef: "original-cancellation",
    requesterPrincipalRef: "requester",
    originalPrincipalRef: values.identity.principalRef,
    expectedAttemptVersion: 1,
    requestDigest: "b".repeat(64),
  };
  const cancellationRow = {
    ...attemptRow(commonAttemptRecord(values)),
    operation_kind: "cancellation",
    operation_ref: cancellation.operationRef,
    request: cancellation,
    record: { operation: cancellation, outcome: "cancelled-before-dispatch" },
  };
  assert.equal(parseOperationRow(cancellationRow).record.operation.expectedAttemptVersion, 1);
  assert.throws(
    () =>
      parseOperationRow({
        ...cancellationRow,
        record: {
          ...cancellationRow.record,
          operation: { ...cancellation, expectedAttemptVersion: 2 },
        },
      }),
    TurnJournalRowError,
  );
});

test("common admission and historical status data cannot become committed initiation claims", async () => {
  const guard = new TurnJournalTransactionGuard();
  const unit = {};
  guard.bind(unit);
  const common = parseAttemptRow(attemptRow(commonAttemptRecord(values)));
  await guard.finish();
  guard.confirmCommitted();
  guard.close();
  for (const candidate of [
    common,
    { operation: values.attemptRecord.consumption.operation },
    values.attemptRecord,
  ])
    assert.equal(takeCommittedTurnJournalClaim(unit, candidate), undefined);
});

// These are local implementation boundary tests. They do not stand in for real
// PostgreSQL uniqueness/COMMIT, authenticated authority, or native execution.
test("journal mutation guard drains accepted work before closing admission", async () => {
  const guard = new TurnJournalTransactionGuard();
  const gate = deferred();
  const entered = deferred();
  const order = [];
  const first = guard.mutate(async () => {
    order.push("first");
    entered.resolve();
    await gate.promise;
    order.push("drained");
  });
  const second = guard.mutate(async () => {
    order.push("second");
  });
  await entered.promise;
  let finished = false;
  const finish = guard.finish().then(() => {
    finished = true;
  });
  await assert.rejects(
    guard.mutate(async () => assert.fail("late work ran")),
    ScopeViolationError,
  );
  assert.equal(finished, false);
  gate.resolve();
  await Promise.all([first, second, finish]);
  assert.deepEqual(order, ["first", "drained", "second"]);
  guard.close();
  assert.throws(() => guard.assertActive(), ScopeViolationError);
});

test("caught journal mutation failure poisons finish and queued mutations", async () => {
  const guard = new TurnJournalTransactionGuard();
  const failure = new Error("mutation failed");
  await assert.rejects(
    guard.mutate(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  await assert.rejects(
    guard.mutate(async () => assert.fail("poisoned successor ran")),
    (error) => error === failure,
  );
  await assert.rejects(guard.finish(), (error) => error === failure);
  guard.close();
});

test("returned negative business decisions do not poison an otherwise valid unit", async () => {
  const guard = new TurnJournalTransactionGuard();
  assert.deepEqual(await guard.mutate(async () => ({ kind: "conflict" })), { kind: "conflict" });
  assert.equal(await guard.mutate(async () => 7), 7);
  await guard.finish();
  guard.close();
});

test("consumption claim remains private to its committed original unit and is single-use", async () => {
  const guard = new TurnJournalTransactionGuard();
  const unit = {};
  guard.bind(unit);
  const operation = attemptRecord.consumption.operation;
  const claim = await guard.mutate(async () =>
    guard.createClaim(operation, "2026-01-01T00:00:05.000Z"),
  );
  assert.equal(takeCommittedTurnJournalClaim(unit, claim), undefined);
  assert.equal(takeCommittedTurnJournalClaim(unit, structuredClone(claim)), undefined);
  assert.equal(takeCommittedTurnJournalClaim({}, claim), undefined);
  await guard.finish();
  guard.confirmCommitted();
  guard.close();
  assert.deepEqual(takeCommittedTurnJournalClaim(unit, claim), {
    operation: claim.operation,
    expiresAt: "2026-01-01T00:00:05.000Z",
  });
  assert.equal(takeCommittedTurnJournalClaim(unit, claim), undefined);
});

test("unfinished or poisoned units cannot confirm an initiation claim", async () => {
  for (const poison of [false, true]) {
    const guard = new TurnJournalTransactionGuard();
    const unit = {};
    guard.bind(unit);
    const claim = await guard.mutate(async () =>
      guard.createClaim(attemptRecord.consumption.operation, "2026-01-01T00:00:05.000Z"),
    );
    if (poison) {
      await assert.rejects(
        guard.mutate(async () => {
          throw new Error("rollback");
        }),
      );
      await assert.rejects(guard.finish());
    }
    guard.confirmCommitted();
    guard.close();
    assert.equal(takeCommittedTurnJournalClaim(unit, claim), undefined);
  }
});

test("claims cannot be constructed outside an admitted mutation or rebound to another unit", async () => {
  const guard = new TurnJournalTransactionGuard();
  const unit = {};
  guard.bind(unit);
  assert.throws(
    () => guard.createClaim(attemptRecord.consumption.operation, "2026-01-01T00:00:05.000Z"),
    ScopeViolationError,
  );
  assert.throws(() => guard.bind({}), ScopeViolationError);
  const second = new TurnJournalTransactionGuard();
  assert.throws(() => second.bind(unit), ScopeViolationError);
  guard.close();
  second.close();
});

test("unconfigured memory journal fails before invoking read, transaction, or initiation callbacks", async () => {
  const provenance = storageProvenance();
  const store = new TurnJournalStore({
    state: new InMemoryPlatformState(),
    clock: provenance.clock,
    initiation: provenance.initiation,
  });
  const unexpected = async () => assert.fail("unconfigured backend called user work");
  await assert.rejects(store.read(unexpected, provenance.call()), DependencyUnavailableError);
  assert.deepEqual(await store.transact(ref("transaction"), unexpected, provenance.call()), {
    kind: "unavailable",
  });
  assert.deepEqual(await store.consumeAndInitiate({}, unexpected, provenance.call()), {
    kind: "unavailable",
  });
});

test("journal store requires an explicit initiation authority", () => {
  const provenance = storageProvenance();
  assert.throws(
    () => new TurnJournalStore({ state: new InMemoryPlatformState(), clock: provenance.clock }),
    DependencyUnavailableError,
  );
});

test("row decoding rejects foreign SQL ownership without exposing stored private values", () => {
  const row = {
    installation_id: values.context.installationRef,
    channel_installation_id: values.locator.channelInstallationRef,
    receipt_ref: values.receipt.receiptRef,
    owner_kind: "admission",
    record: values.admission,
  };
  assert.equal(parseOwnerRow(row).record.identity.receipt.receiptRef, values.receipt.receiptRef);
  for (const patch of [
    { installation_id: "foreign-installation" },
    { channel_installation_id: "foreign-channel" },
    { receipt_ref: "foreign-receipt" },
    { record: { ...values.admission, credential: "private-storage-value" } },
  ]) {
    assert.throws(
      () => parseOwnerRow({ ...row, ...patch }),
      (error) =>
        error instanceof TurnJournalRowError &&
        error.message === "The stored turn journal value is invalid.",
    );
  }
});

test("attempt rows reject unsafe counters, replaced consumption and mismatched owner columns", () => {
  const row = {
    installation_id: values.context.installationRef,
    namespace_id: values.context.namespaceRef,
    agent_id: values.context.agentRef,
    conversation_ref: values.context.conversationRef,
    turn_ref: values.attempt.turnRef,
    attempt_ref: values.attempt.attemptRef,
    reservation_ref: values.attempt.reservationRef,
    channel_installation_id: values.locator.channelInstallationRef,
    admission_receipt_ref: values.receipt.receiptRef,
    reservation: values.reservation,
    first_received_at: new Date(values.admission.decidedAt),
    version: "3",
    record: values.attemptRecord,
  };
  assert.equal(
    parseAttemptRow(row).consumption.operation.operationRef,
    values.attemptRecord.consumption.operation.operationRef,
  );
  assert.equal(parseAttemptFirstReceivedAt(row), values.admission.decidedAt);
  for (const first_received_at of ["not-a-date", "2026-01-01T00:00:00.000000Z", 0, new Date(NaN)]) {
    assert.throws(
      () => parseAttemptFirstReceivedAt({ ...row, first_received_at }),
      TurnJournalRowError,
    );
  }
  for (const patch of [
    { version: "9007199254740992" },
    { version: "3.0" },
    { attempt_ref: "another-attempt" },
    { reservation: { ...values.reservation, reservationVersion: 2 } },
    { record: { ...values.attemptRecord, consumption: null } },
  ])
    assert.throws(() => parseAttemptRow({ ...row, ...patch }), TurnJournalRowError);
});

test("operation readback cannot exchange the original checkpoint identity or scope", () => {
  const row = {
    installation_id: values.context.installationRef,
    namespace_id: values.context.namespaceRef,
    agent_id: values.context.agentRef,
    conversation_ref: values.context.conversationRef,
    turn_ref: values.attempt.turnRef,
    attempt_ref: values.attempt.attemptRef,
    reservation_ref: values.attempt.reservationRef,
    operation_kind: "checkpoint-allocation",
    operation_ref: values.allocation.operationRef,
    request: values.allocation,
    record: values.allocation,
  };
  assert.equal(parseOperationRow(row).record.checkpointId, values.allocation.checkpointId);
  assert.throws(
    () => parseOperationRow({ ...row, agent_id: "foreign-agent" }),
    TurnJournalRowError,
  );
  assert.throws(
    () =>
      parseOperationRow({
        ...row,
        record: { ...values.allocation, checkpointId: "replacement-checkpoint" },
      }),
    TurnJournalRowError,
  );
});
