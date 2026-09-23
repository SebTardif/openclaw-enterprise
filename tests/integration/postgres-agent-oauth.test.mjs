import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import {
  oauthAttempt,
  seedOAuthAgent,
  stagedSecret,
  verifyAgentOAuthState,
} from "../conformance/agent-oauth-state.contract.mjs";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import {
  createProviderController,
  createProviderWorkerDrivers,
  waitFor,
} from "../helpers/postgres-provider-state.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;

test(
  "PostgreSQL Agent OAuth repository enforces durable custody and generations",
  { skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to a disposable migrated database." },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    await verifyAgentOAuthState(t, store);
    await t.test(
      "concurrent generation allocation accepts one publisher and SQL rejects credential material",
      async () => {
        const { agent } = await seedOAuthAgent(store);
        const first = oauthAttempt(agent);
        const outcomes = await Promise.allSettled(
          [first, oauthAttempt(agent)].map((attempt) =>
            store.transact(async (unit) => {
              await unit.agents.lockAgent(agent.namespaceId, agent.id);
              return unit.agentOAuth.create(attempt);
            }),
          ),
        );
        assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
        const latest = await store.read((view) =>
          view.agentOAuth.latest(agent.namespaceId, agent.id),
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.agent_oauth_attempts SET staged_secret = $3 WHERE namespace_id=$1 AND agent_id=$2",
            [agent.namespaceId, agent.id, { accessToken: "must-not-persist" }],
          ),
          { code: "23514" },
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.agent_oauth_attempts SET failure_code='provider-error-with-secret' WHERE namespace_id=$1 AND agent_id=$2",
            [agent.namespaceId, agent.id],
          ),
          { code: "23514" },
        );
        assert.deepEqual(
          await store.read((view) => view.agentOAuth.latest(agent.namespaceId, agent.id)),
          latest,
        );
      },
    );
  },
);

test(
  "Agent deletion worker retains OAuth recovery identities until every generation is cleaned",
  {
    skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to a disposable migrated database.",
    timeout: 20_000,
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const workerPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const renewedDuringCleanup = Promise.withResolvers();
    let cleanupBlocked = false;
    workerPool.on("connect", (client) => {
      const query = client.query.bind(client);
      client.query = async (statement, ...parameters) => {
        const result = await query(statement, ...parameters);
        if (cleanupBlocked && /SET lease_expires_at = clock_timestamp\(\)/.test(statement)) {
          assert.equal(result.rowCount, 1);
          renewedDuringCleanup.resolve();
        }
        return result;
      };
    });
    const store = new PostgresPlatformState(pool);
    const { agent, namespace } = await seedOAuthAgent(store);
    const { agent: sibling } = await seedOAuthAgent(store);
    const actorId = `prn_${randomUUID()}`;
    const roleId = `role_${randomUUID()}`;
    await pool.query(
      "INSERT INTO occ.iam_identities (id,kind,issuer,subject) VALUES ($1,'principal','oauth-cleanup-test',$1)",
      [actorId],
    );
    await pool.query(
      "INSERT INTO occ.iam_roles (id,namespace_id,name,permissions) VALUES ($1,$2,$1,$3)",
      [roleId, namespace.id, JSON.stringify([{ action: "delete", resourceKind: "agent" }])],
    );
    await pool.query(
      `INSERT INTO occ.iam_access_bindings
         (id,namespace_id,identity_subject_id,role_id,resource_kind,resource_id)
       VALUES ($1,$2,$3,$4,'agent',$5)`,
      [`binding_${randomUUID()}`, namespace.id, actorId, roleId, agent.id],
    );
    const computeDeleted = [];
    const compute = {
      ...createDevelopmentComputeDriver(),
      async deleteAgentRuntimeCredentials({ agent: owner }) {
        computeDeleted.push(owner.id);
      },
    };
    const drivers = createProviderWorkerDrivers(compute, []);
    const first = oauthAttempt(agent, { actorId, secretDriverId: drivers.secretDriver.id });
    const second = oauthAttempt(agent, {
      actorId,
      secretDriverId: drivers.secretDriver.id,
      connectionId: first.connectionId,
      generation: 2,
    });
    const other = oauthAttempt(sibling, { actorId, secretDriverId: drivers.secretDriver.id });
    const known = stagedSecret(first);
    const unknown = stagedSecret(second);
    const untouched = stagedSecret(other);
    await store.transact(async (unit) => {
      for (const attempt of [first, second, other]) {
        await unit.agentOAuth.create(attempt);
        await unit.agentOAuth.update({
          ...attempt,
          expectedPhase: "authorizing",
          phase: "staging",
        });
        if (attempt === first) {
          await unit.agentOAuth.update({
            ...attempt,
            expectedPhase: "staging",
            phase: "authenticated",
            stagedSecret: known,
          });
          await unit.agentOAuth.update({
            ...attempt,
            expectedPhase: "authenticated",
            phase: "superseded",
            stagedSecret: known,
          });
        }
      }
    });
    const backend = new Map([known, unknown, untouched].map((secret) => [secret.id, secret]));
    const deletes = [];
    const events = [];
    const retryEntered = Promise.withResolvers();
    const resumeCleanup = Promise.withResolvers();
    let discoveries = 0;
    drivers.secretDriver = {
      ...drivers.secretDriver,
      async findStaged(identity) {
        assert.equal(identity.id, second.secretIdentity.id);
        assert.equal(
          computeDeleted.at(-1),
          agent.id,
          "runtime credentials retire before custody cleanup",
        );
        if (++discoveries === 1) {
          throw new Error("unsafe-provider-error-do-not-log");
        }
        cleanupBlocked = true;
        retryEntered.resolve();
        await resumeCleanup.promise;
        cleanupBlocked = false;
        return backend.get(identity.id)?.backendRef;
      },
      async delete(secret) {
        assert.deepEqual(secret, secret.id === known.id ? known : unknown);
        deletes.push(secret.id);
        backend.delete(secret.id); // Exact-identity deletion is idempotent after a lost acknowledgment.
      },
    };
    const worker = createControllerWorker({
      pool: workerPool,
      drivers,
      pollIntervalMs: 15,
      leaseDurationMs: 3_000,
      emit: (event) => events.push(event),
    });
    t.after(async () => {
      resumeCleanup.resolve();
      await worker.stop();
      await pool.end();
    });
    const controller = createProviderController(
      { installation: await store.loadInstallation(), state: store },
      { providers: [] },
    );
    await controller.deleteAgent(actorId, namespace.id, agent.id);
    await worker.start();
    await retryEntered.promise;
    const retained = await store.read((view) => view.agentOAuth.list(namespace.id, agent.id));
    assert.equal(retained.length, 2, "backend uncertainty must retain every recovery identity");
    assert.equal(retained[0].stagedSecret.backendRef.uid, known.backendRef.uid);
    assert.equal(retained[1].phase, "staging");
    assert.equal(retained[1].stagedSecret, null);
    assert.equal(
      backend.has(known.id),
      false,
      "first cleanup effect committed before the failed lookup",
    );
    // The worker owns one PostgreSQL connection. Its periodic lease renewal must
    // use the held transaction while a Secret backend operation remains pending.
    await renewedDuringCleanup.promise;
    resumeCleanup.resolve();
    await waitFor("Agent deletion after OAuth cleanup retry", async () =>
      (await store.read((view) => view.agents.findAgent(namespace.id, agent.id))) === undefined
        ? true
        : undefined,
    );
    await worker.stop();
    assert.deepEqual(await store.read((view) => view.agentOAuth.list(namespace.id, agent.id)), []);
    assert.deepEqual(deletes, [known.id, known.id, unknown.id]);
    assert.deepEqual([...backend.keys()], [untouched.id]);
    assert.equal(
      (await store.read((view) => view.agentOAuth.latest(sibling.namespaceId, sibling.id))).phase,
      "staging",
    );
    const audit = await pool.query(
      "SELECT outcome, details FROM occ.audit_events WHERE resource_id=$1 AND action='openclaw.agents.lifecycle.delete'",
      [agent.id],
    );
    assert.equal(audit.rows.at(-1).outcome, "success");
    assert.equal(audit.rows.at(-1).details.attemptCount, 2);
    assert.doesNotMatch(
      JSON.stringify({ events, audit: audit.rows }),
      /unsafe-provider-error-do-not-log/,
    );
  },
);
