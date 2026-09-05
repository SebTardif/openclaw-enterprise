import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  requiresPostgres,
  setup,
  waitFor,
} from "../fixtures/worker-reconciliation/database-fixture.mjs";
import {
  effectGate,
  recordingCompute,
} from "../fixtures/worker-reconciliation/recording-drivers.mjs";

test(
  "database heartbeat loss aborts the active revision effect and preserves the successor claim",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { leaseDurationMs: 1_200 });
    const gate = effectGate({ releaseOnAbort: true });
    fixture.releases.push(gate.release);
    const recording = recordingCompute({ bindAgent: gate.hold });
    const namespace = await fixture.namespace("ready");
    const owner = await fixture.agent(namespace);
    const candidate = await fixture.revision(owner, 1, recording.driver);
    await fixture.start(recording.driver);
    const effect = await waitFor("the revision binding effect", async () => recording.calls[0]);
    assert.equal(effect.operation, "bindAgent");
    assert.equal(effect.args[0].namespace.id, namespace.id);
    assert.equal(effect.args[0].agent.id, owner.id);
    const original = await fixture.work(candidate, "claimed");

    // Revoke the actual database lease and hand the recovered row to another queue
    // owner while the first effect remains active. No manual signal abort is used.
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE idempotency_key = $1 AND claim_token = $2::uuid",
      [candidate.idempotencyKey, original.claim_token],
    );
    await fixture.recoveryQueue.recoverStale();
    const successor = await fixture.recoveryQueue.claim();
    assert.equal(successor?.idempotencyKey, candidate.idempotencyKey);
    assert.notEqual(successor.claimToken, original.claim_token);
    assert.equal(successor.actorId, fixture.actor.id);
    assert.equal(successor.attemptCount, 2);
    await waitFor("heartbeat-driven cooperative cancellation", async () =>
      effect.signal.aborted ? true : undefined,
    );
    assert.equal(effect.signal.reason.name, "WorkClaimLostError");
    gate.release();
    await waitFor("the runner claim-loss report", async () =>
      fixture.events.find(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
    );
    await fixture.stop();

    assert.deepEqual(
      recording.calls.map(({ operation }) => operation),
      ["bindAgent"],
    );
    const unchanged = await fixture.work(candidate, "claimed");
    assert.equal(unchanged.claim_token, successor.claimToken);
    assert.equal(unchanged.attempt_count, 2);
    assert.equal(unchanged.completed_at, null);
    const current = await fixture.state.read((view) =>
      view.agents.findAgent(namespace.id, owner.id),
    );
    assert.equal(current.activeRevisionId, undefined);
    assert.equal(
      (await fixture.audits(candidate)).some(
        ({ action, details }) =>
          action === "openclaw.agents.lifecycle.activate" ||
          details?.reasonCode === "RECONCILE_SUCCEEDED",
      ),
      false,
    );

    // The original token cannot finalize a successor, even through the real queue API.
    await assert.rejects(
      fixture.recoveryQueue.complete({
        idempotencyKey: candidate.idempotencyKey,
        claimToken: original.claim_token,
      }),
      { name: "WorkClaimLostError" },
    );
    assert.equal((await fixture.work(candidate, "claimed")).claim_token, successor.claimToken);
  },
);

test(
  "shutdown drains a cooperative effect and an in-flight PostgreSQL heartbeat before closing",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { leaseDurationMs: 3_000 });
    const gate = effectGate();
    fixture.releases.push(gate.release);
    const recording = recordingCompute({ ensureNamespace: gate.hold });
    const namespace = await fixture.namespace();
    const candidate = await fixture.namespaceWork(namespace);
    await fixture.start(recording.driver);
    const effect = await waitFor("the namespace effect", async () => recording.calls[0]);
    await fixture.work(candidate, "claimed");

    const blocker = await fixture.observerPool.connect();
    let lockReleased = false;
    const releaseLock = async () => {
      if (lockReleased) return;
      lockReleased = true;
      await blocker.query("ROLLBACK");
      blocker.release();
    };
    fixture.releases.push(releaseLock);
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT idempotency_key FROM occ.controller_work WHERE idempotency_key = $1 FOR UPDATE",
      [candidate.idempotencyKey],
    );
    // A real row lock makes the timer's UPDATE wait inside PostgreSQL, so the
    // shutdown assertion covers owned SQL work as well as the Driver promise.
    await waitFor("the heartbeat blocked on the real row lock", async () => {
      const result = await fixture.observerPool.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE application_name = $1 AND state = 'active'",
        [fixture.applicationName],
      );
      return result.rows.some(({ wait_event_type }) => wait_event_type === "Lock")
        ? true
        : undefined;
    });
    let stopped = false;
    const stopping = fixture.stop().then(() => {
      stopped = true;
    });
    await waitFor("shutdown cancellation of the active effect", async () =>
      effect.signal.aborted ? true : undefined,
    );
    assert.equal(stopped, false, "shutdown must wait for the owned effect");
    gate.release();
    await delay(50);
    assert.equal(stopped, false, "shutdown must also drain the pending database heartbeat");
    assert.equal(
      fixture.events.some(({ event }) => event === "worker.stopped"),
      false,
    );
    await releaseLock();
    await stopping;
    assert.equal(fixture.events.at(-1).event, "worker.stopped");
    assert.equal((await fixture.work(candidate, "claimed")).completed_at, null);
    assert.equal((await fixture.audits(candidate)).length, 0);
    const persisted = await fixture.state.read((view) =>
      view.namespaces.findNamespace(namespace.id),
    );
    assert.equal(persisted.status, "provisioning");
  },
);
