import assert from "node:assert/strict";
import test from "node:test";
import { WorkerRevisionCurrentnessLostError } from "../../apps/controller/src/worker/revision-currentness.ts";
import { WorkerFinalization } from "../../apps/controller/src/worker/finalization.ts";
import { WorkClaimLostError } from "../../packages/occ/src/state/postgres-work-queue.ts";
import { claim } from "../fixtures/worker-lease-cancellation/controlled-queue.mjs";
import {
  requiresPostgres,
  setup,
  waitFor,
} from "../fixtures/worker-reconciliation/database-fixture.mjs";
import {
  effectGate,
  recordingCompute,
} from "../fixtures/worker-reconciliation/recording-drivers.mjs";

// These controls exercise the finalizer's injected boundaries and event timing.
// They record calls only; the PostgreSQL cases below verify persisted transitions.
function controlledFinalization({
  attemptCount = 1,
  afterAction,
  heartbeat,
  cleanup,
  maintenanceIntervalMs,
} = {}) {
  const execution = { claim: { ...claim(), attemptCount }, signal: new AbortController().signal };
  const revision = {
    id: execution.claim.revisionId,
    namespaceId: execution.claim.namespaceId,
    agentId: execution.claim.agentId,
    servicePrincipalId: "service-principal/finalization",
  };
  const calls = [];
  const events = [];
  const current = {
    id: revision.agentId,
    servicePrincipalId: revision.servicePrincipalId,
    activeRevisionId: revision.id,
  };
  const original = {
    installationId: "installation/finalization",
    namespaceId: execution.claim.namespaceId,
    agentId: execution.claim.agentId,
    revisionId: execution.claim.revisionId,
    transitionRef: execution.claim.runtimeTransitionRef,
    generation: execution.claim.lifecycleGeneration,
    desiredMode: "running",
    actorId: execution.claim.actorId,
    requestId: "request/finalization",
    createdAt: execution.claim.createdAt.toISOString(),
  };
  let head = original;
  const unit = {
    agents: {
      async lockAgent() {
        calls.push("lockAgent");
        return current;
      },
      async compareAndSetActiveRevision() {
        calls.push("compareAndSetActiveRevision");
        return current;
      },
    },
    namespaces: {
      async lockNamespace(id) {
        calls.push("lockNamespace");
        assert.equal(id, execution.claim.namespaceId);
        return { id, status: "ready" };
      },
    },
    runtimeAdmissions: {
      async findRevisionAdmission() {
        calls.push("readAdmission");
        return {
          namespaceId: original.namespaceId,
          agentId: original.agentId,
          revisionId: original.revisionId,
          runtimeTransitionRef: original.transitionRef,
          lifecycleGeneration: original.generation,
          auditEventId: "aud_original",
        };
      },
    },
    runtimeAssignments: {
      async findRuntimeIntent() {
        calls.push("readOriginal");
        return original;
      },
      async findRuntimeIntentHead() {
        calls.push("readHead");
        return head;
      },
    },
    audit: {
      async append(event) {
        calls.push(event.action);
      },
    },
  };
  const queue = {
    async heartbeat(input) {
      calls.push("heartbeat");
      return heartbeat === undefined ? input : heartbeat(input);
    },
  };
  for (const operation of ["complete", "defer", "retry", "fail", "enqueue"])
    queue[operation] = async () => {
      calls.push(operation);
    };
  let transactions = 0;
  const finalizer = new WorkerFinalization({
    async transact(action) {
      const number = ++transactions;
      const value = await action(unit, queue);
      calls.push(`transaction:${number}:ready`);
      await afterAction?.(number);
      calls.push(`transaction:${number}:committed`);
      return value;
    },
    installation: () => ({ id: "installation/finalization" }),
    readCurrentness: (action) => action(unit),
    iamDriverId: "native-iam",
    computeDriverId: "compute/finalization",
    convergenceTimeoutMs: 60_000,
    maxAttempts: 5,
    maintenanceIntervalMs,
    cleanup: {
      async afterActivation(...args) {
        calls.push("cleanup");
        await cleanup?.(...args);
      },
    },
    emit(event) {
      events.push(event);
      calls.push("emit");
    },
  });
  return {
    execution,
    revision,
    current,
    calls,
    events,
    finalizer,
    original,
    replaceHead(value) {
      head = value;
    },
  };
}

for (const method of ["finalize", "finalizeRevision"]) {
  for (const [outcome, attemptCount, operation, applied] of [
    ["success", 1, "complete", "success"],
    ["pending", 5, "defer", "pending"],
    ["retry", 1, "retry", "retry"],
    ["retry", 5, "fail", "permanent"],
    ["permanent", 1, "fail", "permanent"],
  ]) {
    test(`${method} reports ${applied} only after ${operation} commits at attempt ${attemptCount}`, async () => {
      const commit = Promise.withResolvers();
      const reached = Promise.withResolvers();
      const fixture = controlledFinalization({
        attemptCount,
        afterAction() {
          reached.resolve();
          return commit.promise;
        },
      });
      const result = { outcome, code: "OBSERVED_RESULT" };
      const args =
        method === "finalize"
          ? [fixture.execution, undefined, result]
          : [fixture.execution, result];
      const running = fixture.finalizer[method](...args);
      await reached.promise;
      assert.deepEqual(fixture.events, []);
      assert.ok(fixture.calls.includes(operation));
      commit.resolve();
      await running;
      assert.equal(fixture.events.length, 1);
      assert.equal(fixture.events[0].result, applied);
      assert.equal(fixture.events[0].outcome, applied);
      assert.equal(fixture.events[0].code, result.code);
      assert.deepEqual(fixture.calls.slice(-2), ["transaction:1:committed", "emit"]);
    });
  }
}

for (const method of ["finalizeRevision", "completeActivatedRevision"]) {
  for (const attemptCount of [1, 5]) {
    test(`${method} reports a controlled head conflict at attempt ${attemptCount}`, async () => {
      const fixture = controlledFinalization({ attemptCount });
      fixture.current.activeRevisionId = "another-revision";
      await fixture.finalizer[method](fixture.execution, {
        outcome: "success",
        code: "REVISION_ACTIVATED",
        revision: fixture.revision,
      });
      assert.equal(fixture.events.length, 1);
      assert.equal(fixture.events[0].outcome, attemptCount === 5 ? "permanent" : "retry");
      assert.equal(fixture.events[0].code, "ACTIVE_REVISION_CHANGED");
      assert.deepEqual(fixture.calls, [
        "lockNamespace",
        "lockAgent",
        "heartbeat",
        "readAdmission",
        "readOriginal",
        "readHead",
        "retry",
        "transaction:1:ready",
        "transaction:1:committed",
        "emit",
      ]);
    });
  }
}

for (const failure of ["commit", "claim"]) {
  for (const method of [
    "finalize",
    "finalizeRevision",
    "completeActivatedRevision",
    "finalizeActiveRevision",
  ]) {
    test(`${method} emits no completion after ${failure} failure`, async () => {
      const error = new Error("controlled commit failure");
      const fixture = controlledFinalization({
        maintenanceIntervalMs: 1000,
        ...(failure === "claim"
          ? { heartbeat: () => undefined }
          : {
              afterAction: () => {
                throw error;
              },
            }),
      });
      fixture.execution.claim.idempotencyKey = `agent_revision:${fixture.revision.id}:maintenance:1`;
      const result = {
        outcome: "success",
        code: "REVISION_ACTIVATED",
        revision: fixture.revision,
        expectedActiveRevisionId: fixture.revision.id,
      };
      const args =
        method === "finalize"
          ? [fixture.execution, undefined, result]
          : method === "finalizeActiveRevision"
            ? [fixture.execution, fixture.revision, "NOT_READY"]
            : [fixture.execution, result];
      await assert.rejects(
        fixture.finalizer[method](...args),
        failure === "claim" ? WorkClaimLostError : (received) => received === error,
      );
      assert.deepEqual(fixture.events, []);
      assert.equal(fixture.calls.includes("cleanup"), false);
    });
  }
}

test("revision activation waits for commit, cleanup and observation commit before reporting success", async () => {
  const commit = Promise.withResolvers();
  const reached = Promise.withResolvers();
  const cleanup = Promise.withResolvers();
  const cleanupEntered = Promise.withResolvers();
  const fixture = controlledFinalization({
    afterAction(number) {
      if (number === 1) {
        reached.resolve();
        return commit.promise;
      }
    },
    cleanup() {
      cleanupEntered.resolve();
      return cleanup.promise;
    },
  });
  const running = fixture.finalizer.finalizeRevision(fixture.execution, {
    outcome: "success",
    code: "REVISION_ACTIVATED",
    revision: fixture.revision,
    expectedActiveRevisionId: fixture.revision.id,
  });
  await reached.promise;
  assert.equal(fixture.calls.includes("cleanup"), false);
  commit.resolve();
  await cleanupEntered.promise;
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.calls.includes("complete"), false);
  cleanup.resolve();
  await running;
  assert.deepEqual(fixture.calls, [
    "lockNamespace",
    "lockAgent",
    "heartbeat",
    "readAdmission",
    "readOriginal",
    "readHead",
    "compareAndSetActiveRevision",
    "transaction:1:ready",
    "transaction:1:committed",
    "cleanup",
    "lockNamespace",
    "lockAgent",
    "heartbeat",
    "readAdmission",
    "readOriginal",
    "readHead",
    "openclaw.agents.lifecycle.activate",
    "complete",
    "transaction:2:ready",
    "transaction:2:committed",
    "emit",
  ]);
  assert.equal(fixture.events[0].outcome, "success");
});

for (const loss of [false, true]) {
  test(`cleanup ${loss ? "claim loss" : "failure"} preserves incomplete-finalization handling`, async () => {
    const error = loss ? new WorkClaimLostError() : new Error("controlled cleanup failure");
    const fixture = controlledFinalization({
      cleanup() {
        throw error;
      },
    });
    const running = fixture.finalizer.finalizeRevision(fixture.execution, {
      outcome: "success",
      code: "REVISION_ACTIVATED",
      revision: fixture.revision,
      expectedActiveRevisionId: fixture.revision.id,
    });
    if (loss) {
      await assert.rejects(running, (received) => received === error);
      assert.deepEqual(fixture.events, []);
    } else {
      await running;
      assert.equal(fixture.events.length, 1);
      assert.equal(fixture.events[0].outcome, "pending");
      assert.equal(fixture.events[0].code, "REVISION_FINALIZATION_INCOMPLETE");
      assert.ok(fixture.calls.includes("defer"));
    }
    assert.equal(fixture.calls.includes("complete"), false);
    assert.equal(fixture.calls.includes("openclaw.agents.lifecycle.activate"), false);
  });
}

for (const obsolete of [false, true]) {
  test(`active maintenance reports its ${obsolete ? "completed obsolete" : "failed and rescheduled"} item`, async () => {
    const fixture = controlledFinalization({ maintenanceIntervalMs: 1000 });
    fixture.execution.claim.idempotencyKey = `agent_revision:${fixture.revision.id}:maintenance:1`;
    if (obsolete) fixture.current.activeRevisionId = "another-revision";
    await fixture.finalizer.finalizeActiveRevision(
      fixture.execution,
      fixture.revision,
      "NOT_READY",
    );
    assert.equal(fixture.events[0].outcome, obsolete ? "success" : "permanent");
    assert.equal(fixture.calls.includes("enqueue"), !obsolete);
    assert.equal(fixture.calls.includes("fail"), !obsolete);
    assert.equal(fixture.calls.includes("complete"), obsolete);
  });
}

// Real store competitors change the persisted active pointer while passive
// Compute effects wait. Queue claims, budgets, audit and commits stay PostgreSQL-owned.
for (const stage of ["activation", "observation"]) {
  for (const priorFailures of [0, 4]) {
    test(
      `${stage} conflict reports the committed ${priorFailures === 0 ? "retry" : "permanent failure"}`,
      requiresPostgres,
      async (context) => {
        const fixture = await setup(context);
        const gate = effectGate();
        fixture.releases.push(gate.release);
        const recording = recordingCompute(
          stage === "activation" ? { prepareRevision: gate.hold } : { retireRevision: gate.hold },
        );
        const namespace = await fixture.namespace("ready");
        const owner = await fixture.agent(namespace);
        if (stage === "observation") {
          const predecessor = await fixture.revision(owner, 1, recording.driver, {
            enqueue: false,
          });
          await fixture.state.transact((unit) =>
            unit.agents.compareAndSetActiveRevision(
              namespace.id,
              owner.id,
              undefined,
              predecessor.id,
            ),
          );
        }
        const candidate = await fixture.revision(owner, 2, recording.driver);
        const successor = await fixture.revision(owner, 3, recording.driver, { enqueue: false });
        // Spend the budget through actual claims and retries; zero jitter on this
        // existing queue fixture makes each preceding retry immediately eligible.
        for (let attempt = 1; attempt <= priorFailures; attempt += 1) {
          const claimed = await fixture.recoveryQueue.claim();
          assert.equal(claimed.idempotencyKey, candidate.idempotencyKey);
          assert.equal(claimed.attemptCount, attempt);
          await fixture.recoveryQueue.retry(claimed, { code: "TEST_DEPENDENCY_UNAVAILABLE" });
        }
        await fixture.start(recording.driver);
        await gate.entered;
        const expectedHead = stage === "activation" ? undefined : candidate.id;
        const before = await fixture.state.read((view) =>
          view.agents.findAgent(namespace.id, owner.id),
        );
        assert.equal(before.activeRevisionId, expectedHead);
        const competing = await fixture.state.transact((unit) =>
          unit.agents.compareAndSetActiveRevision(
            namespace.id,
            owner.id,
            expectedHead,
            successor.id,
          ),
        );
        assert.equal(competing.activeRevisionId, successor.id);
        gate.release();
        const attempt = priorFailures + 1;
        const event = await waitFor("the committed conflict completion event", async () =>
          fixture.events.find(
            (event) =>
              event.event === "worker.completed" &&
              event.workId === candidate.idempotencyKey &&
              event.attempt === attempt,
          ),
        );
        const outcome = priorFailures === 0 ? "retry" : "permanent";
        assert.equal(event.outcome, outcome);
        assert.equal(event.result, outcome);
        assert.equal(event.code, "ACTIVE_REVISION_CHANGED");
        const work = await fixture.work(
          candidate,
          priorFailures === 0 ? "succeeded" : "failed_permanent",
        );
        await fixture.stop();
        assert.equal(work.attempt_count, priorFailures === 0 ? 2 : 5);
        assert.equal(work.claim_token, null);
        assert.equal(work.lease_expires_at, null);
        assert.ok(work.completed_at);
        const current = await fixture.state.read((view) =>
          view.agents.findAgent(namespace.id, owner.id),
        );
        assert.equal(current.activeRevisionId, successor.id);
        const audits = await fixture.audits(candidate);
        assert.deepEqual(
          audits.filter(({ details }) => details?.reasonCode === "ACTIVE_REVISION_CHANGED"),
          [
            {
              actor_id: fixture.actor.id,
              namespace_id: namespace.id,
              resource_id: candidate.id,
              action: "reconcile",
              outcome: "failure",
              details: { reasonCode: "ACTIVE_REVISION_CHANGED", attemptCount: attempt },
            },
          ],
        );
        assert.equal(
          audits.some(({ action }) => action === "openclaw.agents.lifecycle.activate"),
          false,
        );
        assert.equal(
          audits.filter(({ action }) => action === "openclaw.agents.lifecycle.supersede").length,
          priorFailures === 0 ? 1 : 0,
        );
        assert.equal(
          audits.filter(({ details }) => details?.reasonCode === "RECONCILE_SUCCEEDED").length,
          priorFailures === 0 ? 1 : 0,
        );
        assert.equal(
          fixture.events.filter(
            (event) =>
              event.event === "worker.completed" &&
              event.workId === candidate.idempotencyKey &&
              event.attempt === attempt,
          ).length,
          1,
        );
        assert.equal(
          recording.calls.filter(({ operation }) => operation === "prepareRevision").length,
          1,
        );
        assert.equal(
          recording.calls.filter(({ operation }) => operation === "retireRevision").length,
          stage === "activation" ? 0 : 1,
        );
      },
    );
  }
}

for (const mode of ["disabled", "stopped"]) {
  for (const method of [
    "finalizeRevision",
    "completeActivatedRevision",
    "finalizeActiveRevision",
  ]) {
    test(`${method} refuses a ${mode} current intent without success or maintenance publication`, async () => {
      const fixture = controlledFinalization({ maintenanceIntervalMs: 1000 });
      fixture.execution.claim.idempotencyKey = `agent_revision:${fixture.revision.id}:maintenance:1`;
      fixture.replaceHead({ ...fixture.original, desiredMode: mode, generation: 2 });
      const args =
        method === "finalizeActiveRevision"
          ? [fixture.execution, fixture.revision, "NOT_READY"]
          : [
              fixture.execution,
              { outcome: "success", code: "REVISION_ACTIVATED", revision: fixture.revision },
            ];
      await assert.rejects(fixture.finalizer[method](...args), WorkerRevisionCurrentnessLostError);
      assert.deepEqual(fixture.calls, [
        "lockNamespace",
        "lockAgent",
        "heartbeat",
        "readAdmission",
        "readOriginal",
        "readHead",
      ]);
      assert.deepEqual(fixture.events, []);
    });
  }
}

test("the second original transaction rejects an intent changed during cleanup", async () => {
  let fixture;
  fixture = controlledFinalization({
    cleanup() {
      fixture.replaceHead({
        ...fixture.original,
        generation: 2,
        transitionRef: "00000000-0000-4000-8000-000000000099",
      });
    },
  });
  await assert.rejects(
    fixture.finalizer.finalizeRevision(fixture.execution, {
      outcome: "success",
      code: "REVISION_ACTIVATED",
      revision: fixture.revision,
      expectedActiveRevisionId: fixture.revision.id,
    }),
    WorkerRevisionCurrentnessLostError,
  );
  assert.ok(fixture.calls.includes("transaction:1:committed"));
  assert.ok(fixture.calls.includes("cleanup"));
  assert.equal(fixture.calls.includes("complete"), false);
  assert.equal(fixture.calls.includes("openclaw.agents.lifecycle.activate"), false);
  assert.deepEqual(fixture.events, []);
});
