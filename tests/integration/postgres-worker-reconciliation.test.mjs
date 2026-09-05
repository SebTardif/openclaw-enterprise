import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  poolWithAuditFailure,
  requiresPostgres,
  setup,
  waitFor,
} from "../fixtures/worker-reconciliation/database-fixture.mjs";
import {
  effectGate,
  recordingCompute,
} from "../fixtures/worker-reconciliation/recording-drivers.mjs";

test(
  "runner handoff preserves Namespace work identity, actor attribution and one completion",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const recording = recordingCompute();
    const namespace = await fixture.namespace();
    const candidate = await fixture.namespaceWork(namespace);
    await fixture.start(recording.driver);
    const completed = await fixture.work(candidate, "succeeded");
    await fixture.stop();
    assert.equal(completed.actor_id, fixture.actor.id);
    assert.equal(completed.namespace_id, namespace.id);
    assert.equal(completed.namespace_target, "ready");
    assert.equal(completed.attempt_count, 1);
    assert.equal(completed.claim_token, null);
    assert.ok(completed.completed_at);
    assert.equal(recording.calls.length, 1);
    assert.equal(recording.calls[0].args[0].id, namespace.id);
    assert.ok(recording.calls[0].signal instanceof AbortSignal);
    const evidence = await fixture.audits(candidate);
    assert.deepEqual(evidence.map(({ action }) => action).sort(), [
      "openclaw.namespaces.lifecycle.ensure",
      "reconcile",
    ]);
    for (const event of evidence) {
      assert.equal(event.actor_id, fixture.actor.id);
      assert.equal(event.namespace_id, namespace.id);
      assert.equal(event.resource_id, namespace.id);
      assert.equal(event.outcome, "success");
    }
    assert.deepEqual(
      fixture.events.filter(({ event }) => event === "worker.completed"),
      [
        {
          event: "worker.completed",
          workId: candidate.idempotencyKey,
          attempt: 1,
          operation: "namespace.ensure",
          namespaceId: namespace.id,
          result: "success",
          outcome: "success",
          code: "NAMESPACE_RECONCILED",
        },
      ],
    );
  },
);

test(
  "current Namespace denial and supersession preserve distinct lifecycle and audit outcomes",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const recording = recordingCompute();
    const denied = await fixture.namespace();
    const superseded = await fixture.namespace("ready");
    await fixture.observerPool.query(
      "INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id, effect) VALUES ($1, $2, 'create', 'namespace', $2, 'deny')",
      [`restriction-${randomUUID()}`, denied.id],
    );
    const deniedWork = await fixture.namespaceWork(denied);
    const supersededWork = await fixture.namespaceWork(superseded);
    await fixture.start(recording.driver);
    await fixture.work(deniedWork, "failed_permanent");
    await fixture.work(supersededWork, "succeeded");
    await fixture.stop();
    assert.deepEqual(recording.calls, []);
    const deniedState = await fixture.state.read((view) =>
      view.namespaces.findNamespace(denied.id),
    );
    const currentState = await fixture.state.read((view) =>
      view.namespaces.findNamespace(superseded.id),
    );
    assert.equal(deniedState.status, "failed");
    assert.equal(currentState.status, "ready");
    const denial = await fixture.audits(denied);
    assert.deepEqual(
      denial
        .map(({ action, outcome }) => ({ action, outcome }))
        .sort((a, b) => a.action.localeCompare(b.action)),
      [
        { action: "openclaw.namespaces.create", outcome: "denied" },
        { action: "reconcile", outcome: "failure" },
      ],
    );
    assert.ok(denial.every(({ actor_id }) => actor_id === fixture.actor.id));
    const decodedDenial = await fixture.state.read(async (view) =>
      (await view.audit.list()).find(
        (event) => event.resource.id === denied.id && event.kind === "authorization_denial",
      ),
    );
    assert.equal(decodedDenial.reasonCode, "AUTHORIZATION_DENIED");
    assert.equal(
      denial.find(({ action }) => action === "reconcile").details.reasonCode,
      "AUTHORIZATION_DENIED",
    );
    const supersession = await fixture.audits(superseded);
    assert.equal(supersession.length, 1);
    assert.equal(supersession[0].action, "reconcile");
    assert.equal(supersession[0].outcome, "success");
    assert.ok(
      fixture.events.some(
        ({ workId, code }) =>
          workId === supersededWork.idempotencyKey && code === "SUPERSEDED_TARGET",
      ),
    );
  },
);

test(
  "an active revision CAS competitor prevents loser publication and predecessor retirement",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const gate = effectGate();
    fixture.releases.push(gate.release);
    const recording = recordingCompute({ prepareRevision: gate.hold });
    const namespace = await fixture.namespace("ready");
    const owner = await fixture.agent(namespace);
    const candidate = await fixture.revision(owner, 1, recording.driver);
    const successor = await fixture.revision(owner, 2, recording.driver, { enqueue: false });
    await fixture.start(recording.driver);
    await waitFor("preparation before active-revision CAS", async () => recording.calls[0]);
    // A concurrent real store transaction publishes the newer admitted revision
    // after the worker read its expected head but before its CAS transaction.
    const activated = await fixture.state.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(namespace.id, owner.id, undefined, successor.id),
    );
    assert.equal(activated.activeRevisionId, successor.id);
    gate.release();
    await waitFor("the durable CAS conflict retry", async () =>
      (await fixture.audits(candidate)).find(
        ({ details }) => details?.reasonCode === "ACTIVE_REVISION_CHANGED",
      ),
    );
    await fixture.work(candidate, "succeeded");
    await fixture.stop();
    const current = await fixture.state.read((view) =>
      view.agents.findAgent(namespace.id, owner.id),
    );
    assert.equal(current.activeRevisionId, successor.id);
    assert.deepEqual(
      recording.calls.map(({ operation }) => operation),
      ["prepareRevision"],
    );
    const evidence = await fixture.audits(candidate);
    assert.equal(
      evidence.some(({ action }) => action === "openclaw.agents.lifecycle.activate"),
      false,
    );
    const superseded = evidence.filter(
      ({ action }) => action === "openclaw.agents.lifecycle.supersede",
    );
    assert.equal(superseded.length, 1);
    assert.equal(superseded[0].details.activeRevisionId, successor.id);
  },
);

test(
  "a retirement failure preserves the committed active revision and defers success until finalization",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const gate = effectGate();
    fixture.releases.push(gate.release);
    let retirements = 0;
    const recording = recordingCompute({
      async retireRevision(call) {
        retirements += 1;
        if (retirements === 1) throw new Error("Scoped passive Driver retirement unavailable");
        await gate.hold(call);
      },
    });
    const namespace = await fixture.namespace("ready");
    const owner = await fixture.agent(namespace);
    const first = await fixture.revision(owner, 1, recording.driver);
    await fixture.start(recording.driver);
    await fixture.work(first, "succeeded");
    const second = await fixture.revision(owner, 2, recording.driver);
    await waitFor("the retirement retry effect", async () =>
      retirements === 2 ? true : undefined,
    );
    const current = await fixture.state.read((view) =>
      view.agents.findAgent(namespace.id, owner.id),
    );
    assert.equal(current.activeRevisionId, second.id);
    const unfinished = await fixture.work(second, "claimed");
    assert.equal(
      unfinished.attempt_count,
      1,
      "ordinary finalization convergence preserves the failure budget",
    );
    const pending = await fixture.audits(second);
    assert.ok(
      pending.some(({ details }) => details?.reasonCode === "REVISION_FINALIZATION_INCOMPLETE"),
    );
    assert.equal(
      pending.some(
        ({ action, details }) =>
          action === "openclaw.agents.lifecycle.activate" ||
          details?.reasonCode === "RECONCILE_SUCCEEDED",
      ),
      false,
    );
    gate.release();
    await fixture.work(second, "succeeded");
    await fixture.stop();
    assert.equal(
      recording.calls.filter(
        ({ operation, args }) => operation === "prepareRevision" && args[0].id === second.id,
      ).length,
      1,
    );
    assert.equal(
      recording.calls.filter(
        ({ operation, args }) => operation === "retireRevision" && args[0].id === first.id,
      ).length,
      2,
    );
    const complete = await fixture.audits(second);
    assert.equal(
      complete.filter(({ action }) => action === "openclaw.agents.lifecycle.activate").length,
      1,
    );
    assert.equal(
      complete.filter(({ details }) => details?.reasonCode === "RECONCILE_SUCCEEDED").length,
      1,
    );
  },
);

test(
  "a real audit SQL failure rolls back Namespace status and queue completion together",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const recording = recordingCompute();
    const namespace = await fixture.namespace();
    const candidate = await fixture.namespaceWork(namespace);
    const fault = poolWithAuditFailure(fixture.workerPool, namespace.id);
    await fixture.start(recording.driver, fault.pool);
    await waitFor("the worker to report the PostgreSQL transaction failure", async () =>
      fixture.events.find(
        ({ event, code }) => event === "worker.error" && code === "WORKER_UNAVAILABLE",
      ),
    );
    await fixture.stop();
    assert.deepEqual(fault.failures, ["22012"]);
    const current = await fixture.state.read((view) => view.namespaces.findNamespace(namespace.id));
    assert.equal(
      current.status,
      "provisioning",
      "the earlier status write must roll back with the audit failure",
    );
    const unfinished = await fixture.work(candidate, "claimed");
    assert.equal(unfinished.completed_at, null);
    assert.equal(unfinished.attempt_count, 1);
    assert.deepEqual(await fixture.audits(candidate), []);
    assert.equal(
      fixture.events.some(({ event }) => event === "worker.completed"),
      false,
    );
    assert.equal(recording.calls.length, 1);
  },
);
