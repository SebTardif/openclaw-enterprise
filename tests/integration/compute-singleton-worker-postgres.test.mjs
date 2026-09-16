import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requiresPostgres, setup, waitFor } from "../helpers/compute-singleton-worker.mjs";

test(
  "a worker binds persisted Namespace, Agent, and service principal before provider effects",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const candidate = await fixture.revision(owner, 1);
    const effects = [];

    await fixture.start({
      ...fixture.compute,
      activationOrder: "beforeCommit",
      async preflight() {},
      async bindAgent(binding) {
        effects.push({
          action: "bind",
          namespaceId: binding.namespace.id,
          namespaceName: binding.namespace.name,
          agentId: binding.agent.id,
          agentName: binding.agent.name,
          servicePrincipalId: binding.agent.servicePrincipalId,
        });
      },
      async prepareRevision(revision) {
        effects.push({ action: "prepare", revisionId: revision.id });
        return fixture.compute.prepareRevision(revision);
      },
      async activateRevision(revision) {
        effects.push({ action: "activate", revisionId: revision.id });
      },
    });

    assert.equal((await fixture.work(candidate)).attempt_count, 1);
    assert.deepEqual(effects, [
      {
        action: "bind",
        namespaceId: fixture.namespace.id,
        namespaceName: fixture.namespace.name,
        agentId: owner.id,
        agentName: owner.name,
        servicePrincipalId: owner.servicePrincipalId,
      },
      { action: "prepare", revisionId: candidate.id },
      { action: "activate", revisionId: candidate.id },
    ]);
  },
);

test(
  "a production singleton driver activates under its claim heartbeat before CAS and retires only after CAS",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    const effects = [];

    async function record(action, candidate) {
      effects.push({
        action,
        revisionId: candidate.id,
        activeRevisionId: await fixture.activeRevision(owner),
      });
    }

    await fixture.start(
      {
        ...fixture.compute,
        activationOrder: "beforeCommit",
        async preflight() {},
        async prepareRevision(candidate) {
          await record("prepare", candidate);
          return fixture.compute.prepareRevision(candidate);
        },
        async activateRevision(candidate) {
          await record("activate", candidate);
          if (candidate.id === first.id) {
            const original = await fixture.observerPool.query(
              `SELECT claim_token, lease_expires_at::text AS expires_at
               FROM occ.controller_work WHERE idempotency_key = $1`,
              [first.idempotencyKey],
            );
            assert.equal(original.rowCount, 1);
            const claim = original.rows[0];
            assert.ok(claim.claim_token);
            assert.ok(claim.expires_at);

            // Keep activation open beyond its initial lease: the same claim must
            // remain live because the real worker renewed it before publication.
            await waitFor("the original activation claim to outlive its lease", async () => {
              const current = await fixture.observerPool.query(
                `SELECT state, claim_token, attempt_count,
                        lease_expires_at > clock_timestamp() AS live,
                        clock_timestamp() > $2::timestamptz AS original_expired,
                        lease_expires_at > $2::timestamptz AS renewed
                 FROM occ.controller_work WHERE idempotency_key = $1`,
                [first.idempotencyKey, claim.expires_at],
              );
              assert.equal(current.rowCount, 1);
              const work = current.rows[0];
              assert.equal(work.state, "claimed");
              assert.equal(work.claim_token, claim.claim_token);
              assert.equal(work.attempt_count, 1);
              assert.equal(
                work.live,
                true,
                "the original claim must remain live during activation",
              );
              return work.original_expired && work.renewed ? work : undefined;
            });
          }
        },
        async deactivateRevision(candidate) {
          await record("deactivate", candidate);
        },
        async retireRevision(candidate) {
          await record("retire", candidate);
          return fixture.compute.retireRevision(candidate);
        },
      },
      5_000,
    );
    assert.equal((await fixture.work(first)).attempt_count, 1);
    assert.equal(await fixture.activeRevision(owner), first.id);

    const second = await fixture.revision(owner, 2);
    assert.equal((await fixture.work(second)).attempt_count, 1);
    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.deepEqual(effects, [
      { action: "prepare", revisionId: first.id, activeRevisionId: null },
      { action: "activate", revisionId: first.id, activeRevisionId: null },
      { action: "prepare", revisionId: second.id, activeRevisionId: first.id },
      { action: "activate", revisionId: second.id, activeRevisionId: first.id },
      { action: "retire", revisionId: first.id, activeRevisionId: second.id },
    ]);

    const activation = await fixture.observerPool.query(
      `SELECT resource_id, details->>'previousRevisionId' AS previous
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.activate'
       ORDER BY occurred_at`,
      [fixture.namespace.id],
    );
    assert.deepEqual(activation.rows, [
      { resource_id: first.id, previous: null },
      { resource_id: second.id, previous: first.id },
    ]);
  },
);

test(
  "failed singleton activation retries without publishing or retiring the previous revision",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    const activations = [];
    const retirements = [];
    let failed = false;
    let second;

    await fixture.start({
      ...fixture.compute,
      activationOrder: "beforeCommit",
      async preflight() {},
      async activateRevision(candidate) {
        activations.push({
          revisionId: candidate.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
        if (candidate.revision === 2 && !failed) {
          failed = true;
          throw new Error("provider readiness verification failed");
        }
      },
      async retireRevision(candidate) {
        retirements.push({
          revisionId: candidate.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
        return fixture.compute.retireRevision(candidate);
      },
    });
    await fixture.work(first);

    second = await fixture.revision(owner, 2);
    assert.equal((await fixture.work(second)).attempt_count, 2);
    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.deepEqual(activations, [
      { revisionId: first.id, activeRevisionId: null },
      { revisionId: second.id, activeRevisionId: first.id },
      { revisionId: second.id, activeRevisionId: first.id },
    ]);
    assert.deepEqual(retirements, [{ revisionId: first.id, activeRevisionId: second.id }]);

    const failure = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS reason
       FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'`,
      [second.id],
    );
    assert.deepEqual(failure.rows, [{ reason: "DEPENDENCY_UNAVAILABLE" }]);
  },
);

for (const scenario of [
  { executionMode: "dedicated", initialDeactivatesCandidate: true },
  { executionMode: "embedded", initialDeactivatesCandidate: false },
]) {
  test(
    `default production ${scenario.executionMode} Drivers publish the route before active revision`,
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context);
      const owner = await fixture.agent(scenario.executionMode);
      const first = await fixture.revision(owner, 1);
      const effects = [];

      async function record(action, candidate) {
        effects.push({
          action,
          revisionId: candidate.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
      }

      await fixture.start({
        ...fixture.compute,
        async preflight() {},
        async prepareRevision(candidate) {
          await record("prepare", candidate);
          return fixture.compute.prepareRevision(candidate);
        },
        async deactivateRevision(candidate) {
          await record("deactivate", candidate);
        },
        async activateRevision(candidate) {
          await record("activate", candidate);
        },
        async retireRevision(candidate) {
          await record("retire", candidate);
          return fixture.compute.retireRevision(candidate);
        },
      });
      await fixture.work(first);
      const second = await fixture.revision(owner, 2);
      await fixture.work(second);

      assert.equal(await fixture.activeRevision(owner), second.id);
      assert.deepEqual(effects, [
        { action: "prepare", revisionId: first.id, activeRevisionId: null },
        ...(scenario.initialDeactivatesCandidate
          ? [{ action: "deactivate", revisionId: first.id, activeRevisionId: null }]
          : []),
        { action: "activate", revisionId: first.id, activeRevisionId: null },
        { action: "prepare", revisionId: second.id, activeRevisionId: first.id },
        { action: "activate", revisionId: second.id, activeRevisionId: first.id },
        { action: "retire", revisionId: first.id, activeRevisionId: second.id },
      ]);
      const completed = await fixture.work(second);
      assert.equal(completed.cutover_started_at, null);
      assert.equal(completed.cutover_expected_active_revision_id, null);
    },
  );
}

test(
  "failed route-before-CAS cutover retries without committing or retiring the predecessor",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    const activations = [];
    const retirements = [];
    let failed = false;
    let second;

    await fixture.start({
      ...fixture.compute,
      async preflight() {},
      async deactivateRevision() {},
      async activateRevision(candidate) {
        activations.push({
          revisionId: candidate.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
        if (second !== undefined && candidate.id === second.id && !failed) {
          failed = true;
          throw new Error("route readiness failed");
        }
      },
      async retireRevision(candidate) {
        retirements.push({
          revisionId: candidate.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
        return fixture.compute.retireRevision(candidate);
      },
    });

    await fixture.work(first);
    assert.equal(await fixture.activeRevision(owner), first.id);
    second = await fixture.revision(owner, 2);
    await fixture.work(second, "succeeded", 30_000);

    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.deepEqual(activations, [
      { revisionId: first.id, activeRevisionId: null },
      { revisionId: second.id, activeRevisionId: first.id },
      { revisionId: second.id, activeRevisionId: first.id },
    ]);
    assert.deepEqual(retirements, [{ revisionId: first.id, activeRevisionId: second.id }]);
  },
);

test(
  "lost claim after route switch recovers before recording the active revision",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    const activations = [];
    let stoleFirstSecondClaim = false;
    let second;

    await fixture.start({
      ...fixture.compute,
      async preflight() {},
      async deactivateRevision() {},
      async activateRevision(candidate) {
        activations.push({
          revisionId: candidate.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
        if (second !== undefined && candidate.id === second.id && !stoleFirstSecondClaim) {
          stoleFirstSecondClaim = true;
          await fixture.observerPool.query(
            `UPDATE occ.controller_work
             SET lease_expires_at = clock_timestamp() - interval '1 second'
             WHERE idempotency_key = $1 AND state = 'claimed'`,
            [second.idempotencyKey],
          );
        }
      },
      async retireRevision(candidate) {
        return fixture.compute.retireRevision(candidate);
      },
    });

    await fixture.work(first);
    second = await fixture.revision(owner, 2);
    await fixture.work(second);

    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.deepEqual(activations, [
      { revisionId: first.id, activeRevisionId: null },
      { revisionId: second.id, activeRevisionId: first.id },
      { revisionId: second.id, activeRevisionId: first.id },
    ]);
  },
);

test(
  "revoked route-before-CAS cutover rolls back before permanent failure",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let servingRevisionId;
    const effects = [];
    let second;

    await fixture.start({
      ...fixture.compute,
      async preflight() {},
      async deactivateRevision(candidate) {
        effects.push({ action: "deactivate", revisionId: candidate.id });
        if (servingRevisionId === candidate.id) servingRevisionId = undefined;
      },
      async activateRevision(candidate) {
        effects.push({
          action: "activate",
          revisionId: candidate.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
        servingRevisionId = candidate.id;
        if (second !== undefined && candidate.id === second.id) {
          throw new Error("lost confirmation after route switch");
        }
      },
    });

    await fixture.work(first);
    assert.equal(servingRevisionId, first.id);
    second = await fixture.revision(owner, 2);
    await waitFor("the second cutover to start and fail confirmation", async () => {
      const current = await fixture.observerPool.query(
        `SELECT state, cutover_started_at
         FROM occ.controller_work
         WHERE idempotency_key = $1`,
        [second.idempotencyKey],
      );
      return current.rows[0]?.cutover_started_at !== null ? current.rows[0] : undefined;
    });
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
    );

    const failed = await fixture.work(second, "failed_permanent");
    assert.equal(await fixture.activeRevision(owner), first.id);
    assert.equal(servingRevisionId, first.id);
    assert.equal(failed.cutover_started_at, null);
    assert.deepEqual(
      effects.filter(({ revisionId }) => revisionId === second.id),
      [
        { action: "activate", revisionId: second.id, activeRevisionId: first.id },
        { action: "deactivate", revisionId: second.id },
      ],
    );
    assert.ok(
      effects.some(
        ({ action, revisionId, activeRevisionId }) =>
          action === "activate" && revisionId === first.id && activeRevisionId === first.id,
      ),
    );
  },
);

test(
  "expired route-before-CAS cutover restores the predecessor before terminal failure",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let servingRevisionId;
    let second;

    await fixture.start({
      ...fixture.compute,
      async preflight() {},
      async deactivateRevision(candidate) {
        if (servingRevisionId === candidate.id) servingRevisionId = undefined;
      },
      async activateRevision(candidate) {
        servingRevisionId = candidate.id;
        if (second !== undefined && candidate.id === second.id)
          throw new Error("lost confirmation after route switch");
      },
    });

    await fixture.work(first);
    second = await fixture.revision(owner, 2);
    await waitFor("the second cutover to remain unresolved", async () => {
      const current = await fixture.observerPool.query(
        `SELECT state, cutover_started_at
         FROM occ.controller_work
         WHERE idempotency_key = $1`,
        [second.idempotencyKey],
      );
      const row = current.rows[0];
      return row?.state === "queued" && row.cutover_started_at !== null ? row : undefined;
    });
    await fixture.stop();

    await fixture.start(
      {
        ...fixture.compute,
        async preflight() {},
        async deactivateRevision(candidate) {
          if (servingRevisionId === candidate.id) servingRevisionId = undefined;
        },
        async activateRevision(candidate) {
          servingRevisionId = candidate.id;
        },
      },
      30_000,
      1,
    );

    const failed = await fixture.work(second, "failed_permanent");
    assert.equal(await fixture.activeRevision(owner), first.id);
    assert.equal(servingRevisionId, first.id);
    assert.equal(failed.cutover_started_at, null);
  },
);

test(
  "failed deadline compensation keeps unresolved cutover queued",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let servingRevisionId;
    let second;

    await fixture.start({
      ...fixture.compute,
      async preflight() {},
      async deactivateRevision(candidate) {
        if (servingRevisionId === candidate.id) servingRevisionId = undefined;
      },
      async activateRevision(candidate) {
        servingRevisionId = candidate.id;
        if (second !== undefined && candidate.id === second.id)
          throw new Error("lost confirmation after route switch");
      },
    });

    await fixture.work(first);
    second = await fixture.revision(owner, 2);
    await waitFor("the second cutover to remain unresolved", async () => {
      const current = await fixture.observerPool.query(
        `SELECT state, cutover_started_at
         FROM occ.controller_work
         WHERE idempotency_key = $1`,
        [second.idempotencyKey],
      );
      const row = current.rows[0];
      return row?.state === "queued" && row.cutover_started_at !== null ? row : undefined;
    });
    await fixture.stop();

    let compensationAttempts = 0;
    await fixture.start(
      {
        ...fixture.compute,
        async preflight() {},
        async deactivateRevision(candidate) {
          if (candidate.id === second.id) compensationAttempts += 1;
          if (servingRevisionId === candidate.id) servingRevisionId = undefined;
        },
        async activateRevision(candidate) {
          if (candidate.id === first.id) throw new Error("predecessor restore unavailable");
          servingRevisionId = candidate.id;
        },
      },
      30_000,
      1,
    );

    await waitFor("failed compensation to preserve queued cutover", async () => {
      const current = await fixture.observerPool.query(
        `SELECT work.state, work.cutover_started_at, work.completed_at,
                events.details->>'reasonCode' AS reason
         FROM occ.controller_work AS work
         JOIN occ.audit_events AS events ON events.resource_id = work.revision_id
         WHERE work.idempotency_key = $1
           AND events.action = 'reconcile'
           AND events.details->>'reasonCode' = 'REVISION_CUTOVER_COMPENSATION_INCOMPLETE'
         ORDER BY events.occurred_at DESC
         LIMIT 1`,
        [second.idempotencyKey],
      );
      const row = current.rows[0];
      if (compensationAttempts === 0) return undefined;
      return row?.state === "queued" && row.cutover_started_at !== null ? row : undefined;
    });
    assert.equal(await fixture.activeRevision(owner), first.id);
    assert.equal(servingRevisionId, undefined);

    await fixture.stop();
    await fixture.start(
      {
        ...fixture.compute,
        async preflight() {},
        async deactivateRevision(candidate) {
          if (servingRevisionId === candidate.id) servingRevisionId = undefined;
        },
        async activateRevision(candidate) {
          servingRevisionId = candidate.id;
        },
      },
      30_000,
      1,
    );
    await fixture.work(second, "failed_permanent");
  },
);

test(
  "mismatched Drivers preserve marked route-before-CAS cutovers",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let second;
    const deactivations = [];

    await fixture.start({
      ...fixture.compute,
      async preflight() {},
      async deactivateRevision(candidate) {
        deactivations.push(candidate.id);
      },
      async activateRevision(candidate) {
        if (second !== undefined && candidate.id === second.id)
          throw new Error("lost confirmation after route switch");
      },
    });

    await fixture.work(first);
    second = await fixture.revision(owner, 2);
    await waitFor("the second cutover to remain unresolved", async () => {
      const current = await fixture.observerPool.query(
        `SELECT state, cutover_started_at
         FROM occ.controller_work
         WHERE idempotency_key = $1`,
        [second.idempotencyKey],
      );
      const row = current.rows[0];
      return row?.state === "queued" && row.cutover_started_at !== null ? row : undefined;
    });
    await fixture.stop();

    await fixture.start({
      ...fixture.compute,
      id: `${fixture.compute.id}-other`,
      activationOrder: "beforeCommit",
      async preflight() {},
      async deactivateRevision(candidate) {
        deactivations.push(candidate.id);
      },
      async activateRevision() {},
    });

    await waitFor("the mismatched Driver to defer the marked cutover", async () => {
      const deferred = await fixture.observerPool.query(
        `SELECT work.state, work.cutover_started_at, events.details->>'reasonCode' AS reason
         FROM occ.controller_work AS work
         JOIN occ.audit_events AS events ON events.resource_id = work.revision_id
         WHERE work.idempotency_key = $1
           AND events.action = 'reconcile'
           AND events.details->>'reasonCode' = 'COMPUTE_DRIVER_MISMATCH'
         ORDER BY events.occurred_at DESC
         LIMIT 1`,
        [second.idempotencyKey],
      );
      const row = deferred.rows[0];
      return row?.state === "queued" && row.cutover_started_at !== null ? row : undefined;
    });
    assert.equal(await fixture.activeRevision(owner), first.id);
    assert.ok(!deactivations.includes(second.id));

    await fixture.stop();
    await fixture.start({
      ...fixture.compute,
      async preflight() {},
      async deactivateRevision(candidate) {
        deactivations.push(candidate.id);
      },
      async activateRevision() {},
    });
    await fixture.work(second);
  },
);

test(
  "post-CAS cleanup finishes without reauthorizing a new deployment",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let allowRetirement = false;
    const retirements = [];

    await fixture.start({
      ...fixture.compute,
      async preflight() {},
      async deactivateRevision() {},
      async activateRevision() {},
      async retireRevision(candidate) {
        retirements.push({
          revisionId: candidate.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
        if (candidate.id === first.id && !allowRetirement) {
          throw new Error("retirement dependency unavailable");
        }
        return fixture.compute.retireRevision(candidate);
      },
    });

    await fixture.work(first);
    const second = await fixture.revision(owner, 2);
    await waitFor("the second revision cleanup to fail after becoming active", async () => {
      const active = await fixture.activeRevision(owner);
      if (active !== second.id) return undefined;
      const current = await fixture.observerPool.query(
        `SELECT state, cutover_started_at
         FROM occ.controller_work
         WHERE idempotency_key = $1`,
        [second.idempotencyKey],
      );
      const row = current.rows[0];
      return retirements.length === 1 && row?.state === "queued" && row.cutover_started_at !== null
        ? row
        : undefined;
    });
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
      VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
    );
    allowRetirement = true;

    await waitFor("the post-CAS cleanup retry to retire the predecessor", async () =>
      retirements.length === 2 ? retirements : undefined,
    );
    await fixture.work(second);

    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.deepEqual(retirements, [
      { revisionId: first.id, activeRevisionId: second.id },
      { revisionId: first.id, activeRevisionId: second.id },
    ]);
  },
);

test(
  "compensation guard preserves a DB-active route for an invalid marked cutover",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let second;
    let allowRetirement = false;
    const deactivations = [];
    let retirementAttempts = 0;

    await fixture.start({
      ...fixture.compute,
      async preflight() {},
      async deactivateRevision(candidate) {
        deactivations.push(candidate.id);
      },
      async activateRevision() {},
      async retireRevision(candidate) {
        if (candidate.id === first.id) retirementAttempts += 1;
        if (candidate.id === first.id && !allowRetirement) {
          throw new Error("retirement dependency unavailable");
        }
        return fixture.compute.retireRevision(candidate);
      },
    });

    await fixture.work(first);
    second = await fixture.revision(owner, 2);
    await waitFor("the second revision cleanup to fail after becoming DB-active", async () => {
      if ((await fixture.activeRevision(owner)) !== second.id) return undefined;
      const current = await fixture.observerPool.query(
        `SELECT state, cutover_started_at
         FROM occ.controller_work
         WHERE idempotency_key = $1`,
        [second.idempotencyKey],
      );
      const row = current.rows[0];
      return retirementAttempts === 1 && row?.state === "queued" && row.cutover_started_at !== null
        ? row
        : undefined;
    });

    await fixture.stop();
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      random: () => 0,
    });
    const claim = await waitFor(
      "the retained cutover claim to become available",
      () => queue.claim(),
      30_000,
    );
    assert.equal(claim.idempotencyKey, second.idempotencyKey);
    const boundaryWorker = fixture.createWorker({
      ...fixture.compute,
      async preflight() {},
      async deactivateRevision(candidate) {
        deactivations.push(candidate.id);
      },
      async activateRevision() {},
      async retireRevision(candidate) {
        if (candidate.id === first.id && !allowRetirement) {
          throw new Error("retirement dependency unavailable");
        }
        return fixture.compute.retireRevision(candidate);
      },
    });
    try {
      await boundaryWorker.compensateRevisionCutover(claim, second, second, {
        outcome: "permanent",
        code: "HARNESS_DESCRIPTOR_MISMATCH",
      });
    } finally {
      await boundaryWorker.stop();
    }

    const guarded = await fixture.observerPool.query(
      `SELECT state, cutover_started_at
       FROM occ.controller_work
       WHERE idempotency_key = $1`,
      [second.idempotencyKey],
    );
    assert.equal(guarded.rows[0]?.state, "queued");
    assert.notEqual(guarded.rows[0]?.cutover_started_at, null);
    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.ok(!deactivations.includes(second.id));
    allowRetirement = true;
    await fixture.start({
      ...fixture.compute,
      async preflight() {},
      async deactivateRevision(candidate) {
        deactivations.push(candidate.id);
      },
      async activateRevision() {},
      async retireRevision(candidate) {
        return fixture.compute.retireRevision(candidate);
      },
    });
    await fixture.work(second);
  },
);

test(
  "queue recovery completes exhausted cutovers before same-Agent successors with the same retry cap",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const staleOwner = await fixture.agent();
    const queuedOwner = await fixture.agent();
    const stale = await fixture.revision(staleOwner, 1);
    const queued = await fixture.revision(queuedOwner, 1);
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      random: () => 0,
    });
    const claimedStale = await queue.claim();
    assert.equal(claimedStale.idempotencyKey, stale.idempotencyKey);
    await queue.startRevisionCutover(claimedStale, undefined);
    await assert.rejects(
      () => queue.fail(claimedStale, { code: "SHOULD_NOT_CLEAR_MARKER" }),
      /controller work claim is missing, expired, or owned by another worker/,
    );
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET attempt_count = 5,
           lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = $1`,
      [stale.idempotencyKey],
    );
    const claimedQueued = await queue.claim();
    assert.equal(claimedQueued.idempotencyKey, queued.idempotencyKey);
    await queue.startRevisionCutover(claimedQueued, undefined);
    await queue.defer(claimedQueued, { code: "TEST_QUEUED_CUTOVER" });
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET attempt_count = 5
       WHERE idempotency_key = $1`,
      [queued.idempotencyKey],
    );

    const recovery = await queue.recoverStale();
    assert.equal(recovery.failedPermanent, 0);
    assert.equal(recovery.exhaustedQueued, 0);

    const states = await fixture.observerPool.query(
      `SELECT idempotency_key, state, completed_at IS NOT NULL AS completed,
              cutover_started_at IS NOT NULL AS cutover_started
       FROM occ.controller_work
       WHERE idempotency_key = ANY($1::text[])
       ORDER BY idempotency_key`,
      [[queued.idempotencyKey, stale.idempotencyKey]],
    );
    assert.deepEqual(
      states.rows.map(({ state, completed, cutover_started }) => ({
        state,
        completed,
        cutover_started,
      })),
      [
        { state: "queued", completed: false, cutover_started: true },
        { state: "queued", completed: false, cutover_started: true },
      ],
    );

    // Earlier availability must not let a successor bypass its Agent's retained
    // cutover. Recovery uses the original limit, including after a final-attempt crash.
    const staleSuccessor = await fixture.revision(staleOwner, 2);
    const queuedSuccessor = await fixture.revision(queuedOwner, 2);
    const unresolved = new Set([queued.idempotencyKey, stale.idempotencyKey]);
    const recoveredClaims = [];
    for (const _ of Array.from(unresolved)) {
      const recovered = await queue.claim();
      assert.ok(recovered, "an exhausted cutover must remain claimable with maxAttempts=5");
      assert.ok(unresolved.delete(recovered.idempotencyKey));
      assert.equal(recovered.attemptCount, 6);
      assert.ok(recovered.cutoverStartedAt);
      recoveredClaims.push(recovered);
    }
    assert.equal(unresolved.size, 0);
    assert.equal(await queue.claim(), undefined);

    // Give the actual worker the retained, still-exhausted rows; queue.defer
    // refunds this inspection claim, so both rows remain at the original cap.
    for (const recovered of recoveredClaims) {
      await queue.defer(recovered, { code: "TEST_RESUME_CUTOVER" });
    }
    const activations = [];
    await fixture.start({
      ...fixture.compute,
      async preflight() {},
      async deactivateRevision() {},
      async activateRevision(candidate) {
        activations.push(candidate.id);
      },
    });
    for (const candidate of [stale, queued, staleSuccessor, queuedSuccessor]) {
      const completed = await fixture.work(candidate);
      assert.equal(completed.cutover_started_at, null);
      assert.equal(completed.cutover_expected_active_revision_id, null);
    }
    assert.equal(await fixture.activeRevision(staleOwner), staleSuccessor.id);
    assert.equal(await fixture.activeRevision(queuedOwner), queuedSuccessor.id);
    for (const [candidate, successor] of [
      [stale, staleSuccessor],
      [queued, queuedSuccessor],
    ]) {
      assert.deepEqual(
        activations.filter((id) => id === candidate.id || id === successor.id),
        [candidate.id, successor.id],
      );
    }
  },
);

test(
  "an opted-in active runtime continuously repairs under its original authorized actor",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const candidate = await fixture.revision(owner, 1);
    const preparations = [];
    const activations = [];

    await fixture.start({
      ...fixture.compute,
      activationOrder: "beforeCommit",
      maintenanceIntervalMs: 75,
      async preflight() {},
      async prepareRevision(revision) {
        preparations.push({
          revisionId: revision.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
        return fixture.compute.prepareRevision(revision);
      },
      async activateRevision(revision) {
        activations.push({
          revisionId: revision.id,
          activeRevisionId: await fixture.activeRevision(owner),
        });
      },
    });
    await fixture.work(candidate);

    const maintained = await waitFor("a durable authorized maintenance pass", async () => {
      const work = await fixture.observerPool.query(
        `SELECT actor_id, namespace_id, agent_id, revision_id, state
         FROM occ.controller_work
         WHERE namespace_id = $1 AND revision_id = $2
           AND idempotency_key LIKE $3 AND state = 'succeeded'
         ORDER BY completed_at DESC
         LIMIT 1`,
        [fixture.namespace.id, candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
      );
      return work.rows[0];
    });
    await fixture.stop();

    assert.deepEqual(maintained, {
      actor_id: fixture.actor.id,
      namespace_id: fixture.namespace.id,
      agent_id: owner.id,
      revision_id: candidate.id,
      state: "succeeded",
    });
    assert.equal(await fixture.activeRevision(owner), candidate.id);
    assert.deepEqual(preparations.slice(0, 2), [
      { revisionId: candidate.id, activeRevisionId: null },
      { revisionId: candidate.id, activeRevisionId: candidate.id },
    ]);
    assert.deepEqual(activations.slice(0, 2), [
      { revisionId: candidate.id, activeRevisionId: null },
      { revisionId: candidate.id, activeRevisionId: candidate.id },
    ]);

    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET state = 'succeeded', completed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE namespace_id = $1 AND state = 'queued'
         AND idempotency_key LIKE $2`,
      [fixture.namespace.id, `agent_revision:${candidate.id}:maintenance:%`],
    );
  },
);

test(
  "active maintenance recovers after its convergence deadline and stops when its actor is denied",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const candidate = await fixture.revision(owner, 1);
    let available = false;
    let maintenanceAttempts = 0;

    await fixture.start(
      {
        ...fixture.compute,
        activationOrder: "beforeCommit",
        maintenanceIntervalMs: 75,
        async preflight() {},
        async prepareRevision(revision) {
          const observation = await fixture.compute.prepareRevision(revision);
          if ((await fixture.activeRevision(owner)) === revision.id) {
            maintenanceAttempts += 1;
            if (!available) return { ...observation, ready: false };
          }
          return observation;
        },
        async activateRevision() {},
      },
      30_000,
      40,
    );
    await fixture.work(candidate);

    // Each failed maintenance observation must schedule another exact-Agent
    // pass even though the original deployment convergence deadline elapsed.
    await waitFor("multiple failed but rescheduled maintenance passes", async () => {
      const result = await fixture.observerPool.query(
        `SELECT COUNT(*)::integer AS failures
         FROM occ.controller_work
         WHERE namespace_id = $1 AND revision_id = $2
           AND idempotency_key LIKE $3 AND state = 'failed_permanent'`,
        [fixture.namespace.id, candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
      );
      return result.rows[0].failures >= 2 ? result.rows[0] : undefined;
    });
    available = true;

    await waitFor("active runtime recovery after a prolonged provider outage", async () => {
      const result = await fixture.observerPool.query(
        `SELECT actor_id, state
         FROM occ.controller_work
         WHERE namespace_id = $1 AND revision_id = $2
           AND idempotency_key LIKE $3 AND state = 'succeeded'
         ORDER BY completed_at DESC LIMIT 1`,
        [fixture.namespace.id, candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
      );
      return result.rows[0];
    });
    assert.equal(await fixture.activeRevision(owner), candidate.id);

    // Revoking the original actor must halt the chain before another provider
    // effect; maintenance never grants an Agent permission to deploy itself.
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
    );
    const effectsBeforeDenial = maintenanceAttempts;
    await waitFor("the denied maintenance pass to stop without a successor", async () => {
      const result = await fixture.observerPool.query(
        `SELECT COUNT(*)::integer AS pending
         FROM occ.controller_work
         WHERE namespace_id = $1 AND revision_id = $2
           AND idempotency_key LIKE $3 AND state IN ('queued', 'claimed')`,
        [fixture.namespace.id, candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
      );
      return result.rows[0].pending === 0 ? result.rows[0] : undefined;
    });
    assert.equal(maintenanceAttempts, effectsBeforeDenial);
  },
);

test(
  "development after-commit Drivers activate after CAS and retry before retiring the previous revision",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent();
    const first = await fixture.revision(owner, 1);
    let second;
    const effects = [];
    let secondActivationAttempts = 0;
    let retryStarted = false;
    let releaseRetry;
    const retryRelease = new Promise((resolve) => {
      releaseRetry = resolve;
    });

    async function record(action, candidate) {
      effects.push({
        action,
        revisionId: candidate.id,
        activeRevisionId: await fixture.activeRevision(owner),
      });
    }

    await fixture.start(
      {
        ...fixture.compute,
        async preflight() {},
        async prepareRevision(candidate) {
          await record("prepare", candidate);
          return fixture.compute.prepareRevision(candidate);
        },
        async activateRevision(candidate) {
          await record("activate", candidate);
          if (candidate.id === second?.id) {
            secondActivationAttempts += 1;
            if (secondActivationAttempts === 1) {
              throw new Error("development gateway did not start");
            }
            retryStarted = true;
            await retryRelease;
          }
        },
        async retireRevision(candidate) {
          await record("retire", candidate);
          return fixture.compute.retireRevision(candidate);
        },
      },
      30_000,
      900_000,
      "development",
    );
    await fixture.work(first);

    try {
      second = await fixture.revision(owner, 2);
      await waitFor("activation retry", async () => (retryStarted ? true : undefined));
      assert.equal(await fixture.activeRevision(owner), second.id);
      assert.deepEqual(
        effects.filter(({ action }) => action === "retire"),
        [],
      );
    } finally {
      // Release paused activation before fixture cleanup waits for the worker to stop.
      releaseRetry();
    }

    // Pending finalization restores the retry budget despite making two activation calls.
    assert.equal((await fixture.work(second)).attempt_count, 1);
    assert.equal(secondActivationAttempts, 2);
    assert.equal(await fixture.activeRevision(owner), second.id);
    assert.deepEqual(effects, [
      { action: "prepare", revisionId: first.id, activeRevisionId: null },
      { action: "activate", revisionId: first.id, activeRevisionId: first.id },
      { action: "prepare", revisionId: second.id, activeRevisionId: first.id },
      { action: "activate", revisionId: second.id, activeRevisionId: second.id },
      { action: "activate", revisionId: second.id, activeRevisionId: second.id },
      { action: "retire", revisionId: first.id, activeRevisionId: second.id },
    ]);
  },
);

// The real SSH Driver owns binding validation; only its remote process protocol
// is substituted. PostgreSQL, IAM, claims, CAS, and the worker run unchanged.
for (const phase of ["post-CAS", "revoked pre-CAS"]) {
  test(
    `a cold SSH worker recovers ${phase} cutover with persisted bindings`,
    requiresPostgres,
    async (context) => {
      const { SshComputeDriver } =
        await import("../../apps/controller/src/drivers/compute/ssh/index.ts");
      const fixture = await setup(context, { id: "compute-ssh", implementation: "occ/ssh" });
      const owner = await fixture.agent("embedded");
      const directory = await mkdtemp(join(tmpdir(), "occ-worker-ssh-"));
      context.after(() => rm(directory, { recursive: true, force: true }));
      const identityFile = join(directory, "identity");
      const knownHostsFile = join(directory, "known_hosts");
      await Promise.all([writeFile(identityFile, "fixture"), writeFile(knownHostsFile, "fixture")]);
      const operations = [];
      let interrupted = false;
      let recovering = false;
      let second;
      const executor = {
        async execute(command) {
          const operation = JSON.parse(Buffer.from(command.operation, "base64").toString());
          operations.push(operation);
          if (
            !recovering &&
            second !== undefined &&
            ((phase === "post-CAS" && operation.operation === "retire-revision") ||
              (phase === "revoked pre-CAS" &&
                operation.operation === "activate-revision" &&
                operation.revision.id === second.id))
          ) {
            interrupted = true;
            throw new Error("lost remote operation confirmation");
          }
          return { code: 0, stdout: JSON.stringify({ ok: true, ready: true }), stderr: "" };
        },
      };
      const options = {
        ssh: { identityFile, knownHostsFile },
        hosts: { [fixture.namespace.name]: { address: "127.0.0.1", user: "root" } },
        runtime: {
          nodePath: process.execPath,
          openclawPath: "/opt/openclaw/index.js",
          user: "openclaw",
          root: "/var/lib/openclaw-enterprise",
        },
        network: { gatewayPortRange: { start: 18800, end: 18899 } },
      };
      const first = await fixture.revision(owner, 1);
      await fixture.start(new SshComputeDriver(options, { executor }));
      await fixture.work(first);
      second = await fixture.revision(owner, 2);
      await waitFor("an interrupted durable cutover", async () => {
        const result = await fixture.observerPool.query(
          "SELECT state, cutover_started_at FROM occ.controller_work WHERE idempotency_key = $1",
          [second.idempotencyKey],
        );
        const row = result.rows[0];
        return interrupted && row?.state === "queued" && row.cutover_started_at !== null
          ? row
          : undefined;
      });
      await fixture.stop();
      const activeId = phase === "post-CAS" ? second.id : first.id;
      assert.equal(await fixture.activeRevision(owner), activeId);

      // Revocation forbids a new deployment, but cannot abandon committed cleanup
      // or compensation for the already authorized durable attempt.
      await fixture.observerPool.query(
        `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
        [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
      );
      operations.length = 0;
      recovering = true;
      await fixture.start(new SshComputeDriver(options, { executor }));
      const completed = await fixture.work(
        second,
        phase === "post-CAS" ? "succeeded" : "failed_permanent",
      );
      assert.equal(completed.cutover_started_at, null);
      assert.equal(completed.cutover_expected_active_revision_id, null);
      assert.equal(await fixture.activeRevision(owner), activeId);
      assert.deepEqual(
        operations
          .filter(({ operation }) => operation !== "probe")
          .map(({ operation, revision, rollbackFromRevisionId }) => ({
            operation,
            revisionId: revision.id,
            rollbackFromRevisionId,
          })),
        phase === "post-CAS"
          ? [
              {
                operation: "retire-revision",
                revisionId: first.id,
                rollbackFromRevisionId: undefined,
              },
            ]
          : [
              {
                operation: "deactivate-revision",
                revisionId: second.id,
                rollbackFromRevisionId: undefined,
              },
              {
                operation: "activate-revision",
                revisionId: first.id,
                rollbackFromRevisionId: second.id,
              },
            ],
      );
    },
  );
}
