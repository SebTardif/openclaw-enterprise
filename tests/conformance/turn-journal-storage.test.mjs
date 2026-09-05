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
  parseOwnerRow,
  parseAttemptRow,
  parseAttemptFirstReceivedAt,
  parseOperationRow,
  TurnJournalRowError,
} from "../../packages/occ/src/turn-journal/rows.ts";
import { deferred, ref, storageProvenance } from "../fixtures/turn-journal-storage/values.mjs";

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

test("unsupported memory journal fails before invoking read, transaction, or initiation callbacks", async () => {
  const provenance = storageProvenance();
  const store = new TurnJournalStore({
    state: new InMemoryPlatformState(),
    clock: provenance.clock,
    initiation: provenance.initiation,
  });
  const unexpected = async () => assert.fail("unsupported backend called user work");
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
