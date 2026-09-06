import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { repositoryFixture } from "../fixtures/lifecycle-work-preflight-v1/repository.mjs";

/** Test-only accepting consumer; its second real preflight is the tested guard.
 * It does not implement provider currentness, effect idempotency or UID fencing.
 */
async function acceptingConsumer(f, delivery, between = async () => {}) {
  const before = await f.inspect(delivery);
  if (before.kind !== "snapshot-matches") return before;
  await between();
  return f.inspect(delivery, f.createPreflight());
}

function assertUnresolved(result, reason, original) {
  assert.equal(result.kind, "unresolved");
  assert.equal(result.reason, reason);
  assert.deepEqual(structuredClone(result.association), structuredClone(original.association));
  assert.deepEqual({ ...result.input }, original.input);
  assert.equal(Object.hasOwn(result, "executionTerminated"), false);
}

test("memory admission repositories bind the exact original audit and reject substituted recovery data", async (t) => {
  const f = await repositoryFixture(t);
  const delivery = await f.deploy();
  assert.equal((await f.inspect(delivery)).kind, "snapshot-matches");
  const snapshot = await f.state.read(async (view) => ({
    audit: await view.audit.list(),
    committed: await view.runtimeAdmissions.findCommittedAdmission(
      f.scope,
      delivery.input.operationRef,
      {
        actorId: delivery.association.intent.actorId,
        requestId: delivery.association.intent.requestId,
      },
    ),
  }));
  assert.equal(snapshot.committed.id, delivery.revision.id);
  assert.equal(
    snapshot.audit.filter((entry) => entry.id === delivery.association.auditEventId).length,
    1,
  );
  for (const mutate of [
    (value) => {
      value.auditEventId = `aud_${randomUUID()}`;
    },
    (value) => {
      value.intent.actorId = "foreign-actor";
    },
    (value) => {
      value.intent.requestId = `req_${randomUUID()}`;
    },
  ]) {
    const forged = structuredClone(delivery.association);
    mutate(forged);
    const result = await f.createPreflight().inspect(delivery.wire, forged, delivery.call);
    assert.deepEqual(result, { kind: "rejected", reason: "association-mismatch" });
  }
});

test("memory fresh readers preserve historical admission and suppress superseded running work", async (t) => {
  const f = await repositoryFixture(t);
  const original = await f.deploy();
  const result = await acceptingConsumer(f, original, async () => {
    await f.controller.updateConfiguration(f.actorId, {
      namespaceId: f.scope.namespaceId,
      configurationId: f.configuration.id,
      values: { model: "gpt-edited" },
    });
    await f.deploy();
  });
  assertUnresolved(result, "head-mismatch", original);
  // A newly constructed preflight retains the old association, while the real
  // memory head/revision stores retain the superseding generation separately.
  assertUnresolved(await f.inspect(original, f.restart()), "head-mismatch", original);
  const recovered = await f.state.read((view) =>
    view.runtimeAdmissions.findCommittedAdmission(f.scope, original.input.operationRef, {
      actorId: original.association.intent.actorId,
      requestId: original.association.intent.requestId,
    }),
  );
  assert.equal(recovered.id, original.revision.id);
});

test("memory repository work plus explicitly synthetic terminal claim rejects duplicate delivery", async (t) => {
  const f = await repositoryFixture(t);
  const original = await f.deploy();
  assert.equal((await f.inspect(original)).kind, "snapshot-matches");
  const { claimToken: _token, leaseExpiresAt: _expiry, ...row } = original.claim;
  f.syntheticClaims.set(original.input.workId, {
    ...row,
    state: "succeeded",
    completedAt: new Date(),
  });
  assertUnresolved(await f.inspect(original, f.restart()), "claim-mismatch", original);
});

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const postgres = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL to an allocated migrated PostgreSQL test database.",
  timeout: 60_000,
};

test(
  "PostgreSQL original work is read without lease renewal and terminal duplicate survives fresh repository instances",
  postgres,
  async (t) => {
    const f = await repositoryFixture(t, databaseUrl);
    const original = await f.deploy();
    const before = await f.readQueue(original.input, original.call);
    assert.equal((await f.inspect(original)).kind, "snapshot-matches");
    assert.equal((await f.inspect(original)).kind, "snapshot-matches");
    const after = await f.readQueue(original.input, original.call);
    assert.equal(after.work.leaseExpiresAt.getTime(), before.work.leaseExpiresAt.getTime());
    assert.equal(after.work.updatedAt.getTime(), before.work.updatedAt.getTime());
    assert.equal(after.work.attemptCount, before.work.attemptCount);
    await f.queue.complete(original.call.claim);
    assertUnresolved(await f.inspect(original, f.restart()), "claim-mismatch", original);
    const replay = await f.queue.enqueue({
      idempotencyKey: original.input.workId,
      ...f.scope,
      revisionId: original.revision.id,
      actorId: original.association.intent.actorId,
      runtimeTransitionRef: original.input.operationRef,
      lifecycleGeneration: original.input.lifecycleGeneration,
    });
    assert.equal(replay.state, "succeeded");
    assert.equal(replay.attemptCount, original.claim.attemptCount);
    assertUnresolved(await acceptingConsumer(f, original), "claim-mismatch", original);
    const count = await f.pool.query(
      "SELECT count(*)::integer AS count FROM occ.controller_work WHERE idempotency_key=$1",
      [original.input.workId],
    );
    assert.equal(count.rows[0].count, 1);
  },
);

test(
  "PostgreSQL expired and replaced claim remains unresolved across restart and subsequent intent supersession",
  postgres,
  async (t) => {
    const f = await repositoryFixture(t, databaseUrl);
    const original = await f.deploy();
    const result = await acceptingConsumer(f, original, async () => {
      // This is an actual elapsed database lease, not an aborted signal or a
      // modified preflight Date. Expiry alone proves no physical termination.
      await delay(Math.max(0, original.claim.leaseExpiresAt.getTime() - Date.now()) + 30);
    });
    assertUnresolved(result, "claim-mismatch", original);
    await f.queue.recoverStale();
    // Existing recovery may apply queue backoff. Only scheduling time changes;
    // original operation/work/actor/generation and uncertain effects stay intact.
    await f.pool.query(
      "UPDATE occ.controller_work SET available_at=clock_timestamp() WHERE idempotency_key=$1",
      [original.input.workId],
    );
    f.restart();
    const nextClaim = await f.queue.claim();
    assert.equal(nextClaim.idempotencyKey, original.input.workId);
    assert.notEqual(nextClaim.claimToken, original.call.claim.claimToken);
    assert.equal(nextClaim.runtimeTransitionRef, original.input.operationRef);
    assert.equal(nextClaim.lifecycleGeneration, original.input.lifecycleGeneration);
    assertUnresolved(await f.inspect(original), "claim-mismatch", original);
    const reclaimed = { ...original, call: f.callFor(nextClaim) };
    assert.equal((await f.inspect(reclaimed)).kind, "snapshot-matches");

    // A new generation supersedes the running work but does not erase its exact
    // historical admission; receiving consumers must recheck before any submit.
    const superseded = await acceptingConsumer(f, reclaimed, async () => {
      await f.deploy({ claimWork: false });
    });
    assertUnresolved(superseded, "head-mismatch", original);
    const retained = await f.state.read((view) =>
      view.runtimeAdmissions.findCommittedAdmission(f.scope, original.input.operationRef, {
        actorId: original.association.intent.actorId,
        requestId: original.association.intent.requestId,
      }),
    );
    assert.equal(retained.id, original.revision.id);
  },
);
