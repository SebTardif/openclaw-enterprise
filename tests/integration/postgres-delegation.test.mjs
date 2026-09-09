import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  PostgresPlatformState,
  PostgresCommitOutcomeUnknownError,
} from "../../packages/occ/src/state/postgres-state.ts";
import {
  seedRuntimeOwner,
  runtimeAudit,
} from "../conformance/runtime-assignment-store.contract.mjs";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";

const url = process.env.OCC_TEST_DATABASE_URL;
const hex = () => randomBytes(32).toString("hex");
const iso = (time) => new Date(time).toISOString();
const model = {
  kind: "model.generate",
  providerBindingRef: "provider/test",
  modelId: "test-model",
  transportProfileRef: "codex-responses-http-v1",
};

test(
  "delegation: original platform transaction and PostgreSQL transition guards",
  {
    skip: url
      ? false
      : "Set OCC_TEST_DATABASE_URL to an isolated migrated PostgreSQL18.6 database.",
    timeout: 90000,
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    const host = store.delegationTransactionHost();
    const execute = (work) => host.transact((_unit, grants) => work(grants));
    const owner = await seedRuntimeOwner(store);
    const scope = {
      installationId: owner.installation.id,
      namespaceId: owner.namespace.id,
      agentId: owner.agent.id,
    };
    async function fixture(overrides = {}) {
      const now = Date.now();
      const grant = {
        schemaVersion: 1,
        grantRef: `grant/${randomUUID()}`,
        mediationContextRef: randomUUID(),
        holder: {
          ...scope,
          agentRevisionId: owner.revision.id,
          servicePrincipalId: owner.agent.servicePrincipalId,
          assignmentRef: { schemaVersion: 1, id: randomUUID() },
          component: "harness",
          lifecycleGeneration: 1,
          runtimeGeneration: 1,
          providerProfileRef: "profile/provider",
          runtimeProfileRef: "profile/runtime",
          identityProfileRef: "profile/identity",
        },
        turn: {
          principalId: "test/human",
          conversationRef: "test/conversation",
          turnRef: randomUUID(),
          attemptRef: randomUUID(),
          commonGrantRef: "test/common",
        },
        audienceRef: "test/mediator",
        operations: [model],
        issuedAt: iso(now - 2000),
        notBefore: iso(now - 1000),
        expiresAt: iso(now + 60000),
        maxRequests: 3,
        maxConcurrentRequests: 1,
        status: "active",
        ...overrides,
      };
      await execute((g) => g.insertRoot(grant));
      const request = (extra) => ({
        operationRef: hex(),
        grantRef: grant.grantRef,
        operation: model,
        requestDigest: hex(),
        decisionRef: `decision/${randomUUID()}`,
        acceptedAt: iso(now - 100),
        dispatchBefore: iso(now + 30000),
        expiresAt: iso(now + 50000),
        dispatchedAt: null,
        status: "accepted",
        outcome: null,
        ...extra,
      });
      return {
        grant,
        request,
        read: () => execute((g) => g.findByContext(scope, grant.mediationContextRef)),
      };
    }
    await t.test("actual application role and PostgreSQL version", async () => {
      const {
        rows: [role],
      } = await pool.query(
        "SELECT current_user,current_setting('server_version') version,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      );
      assert.equal(role.current_user, "occ_app");
      assert.match(role.version, /^18\.6(?:\s|$)/);
      for (const key of ["rolsuper", "rolcreatedb", "rolcreaterole", "rolbypassrls"])
        assert.equal(role[key], false);
    });
    await t.test("exact replay, changed binding and scoped lookup", async () => {
      const f = await fixture();
      assert.deepEqual(await execute((g) => g.insertRoot(f.grant)), await f.read());
      await assert.rejects(execute((g) => g.insertRoot({ ...f.grant, audienceRef: "changed" })));
      assert.equal(
        await execute((g) =>
          g.findByContext(
            { ...scope, agentId: `agt_${randomUUID()}` },
            f.grant.mediationContextRef,
          ),
        ),
        undefined,
      );
      await assert.rejects(
        execute((g) =>
          g.findByContext(
            { ...scope, installationId: `ins_${randomUUID()}` },
            f.grant.mediationContextRef,
          ),
        ),
      );
      const op = f.request();
      assert.equal((await execute((g) => g.acceptOperation(scope, 1, op))).result, "accepted");
      assert.equal((await execute((g) => g.acceptOperation(scope, 1, op))).result, "duplicate");
      await assert.rejects(
        execute((g) => g.acceptOperation(scope, 1, { ...op, requestDigest: hex() })),
      );
      const stored = await f.read();
      assert.equal(stored.usedRequests, 1);
      assert.equal(stored.activeRequests, 1);
    });
    await t.test(
      "two real connections cannot spend the final request or concurrency slot twice",
      async () => {
        for (const limits of [
          { maxRequests: 1, maxConcurrentRequests: 1 },
          { maxRequests: 8, maxConcurrentRequests: 1 },
        ]) {
          const f = await fixture(limits);
          const results = await Promise.allSettled(
            [f.request(), f.request()].map((op) => execute((g) => g.acceptOperation(scope, 1, op))),
          );
          assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
          const stored = await f.read();
          assert.equal(stored.usedRequests, 1);
          assert.equal(stored.activeRequests, 1);
        }
      },
    );
    await t.test(
      "aliases of the same platform unit share whole-operation serialization",
      async () => {
        const f = await fixture();
        const op = f.request();
        await host.transact(async (unit, g) => {
          const alias = store.delegationInTransaction(unit);
          assert.equal(alias, g);
          const replay = await Promise.all([g.insertRoot(f.grant), alias.insertRoot(f.grant)]);
          assert.deepEqual(replay[0], replay[1]);
          const admits = await Promise.all([
            g.acceptOperation(scope, 1, op),
            alias.acceptOperation(scope, 1, op),
          ]);
          assert.deepEqual(
            admits.map((r) => r.result),
            ["accepted", "duplicate"],
          );
          const dispatched = await Promise.all([
            g.dispatchOperation(scope, op.grantRef, op.operationRef, op.requestDigest, 1),
            alias.dispatchOperation(scope, op.grantRef, op.operationRef, op.requestDigest, 1),
          ]);
          assert.deepEqual(
            dispatched.map((r) => r.result),
            ["dispatched", "already-consumed"],
          );
        });
      },
    );
    await t.test(
      "the original transaction drains admitted repository work before commit",
      async () => {
        const f = await fixture();
        const op = f.request();
        await host.transact(async (_unit, g) => {
          void g.acceptOperation(scope, 1, op);
        });
        assert.equal(
          (await execute((g) => g.findOperation(scope, op.grantRef, op.operationRef))).status,
          "accepted",
        );
      },
    );
    await t.test("retirement serializes against waiting admission and is monotonic", async () => {
      const f = await fixture();
      let locked, release;
      const arrived = new Promise((resolve) => {
        locked = resolve;
      });
      const barrier = new Promise((resolve) => {
        release = resolve;
      });
      const retire = host.transact(async (_unit, g) => {
        await g.retireRoot(scope, f.grant.grantRef, 1, "revoked");
        locked();
        await barrier;
      });
      await arrived;
      const accept = execute((g) => g.acceptOperation(scope, 1, f.request()));
      void accept.catch(() => {});
      release();
      await retire;
      await assert.rejects(accept);
      await assert.rejects(execute((g) => g.retireRoot(scope, f.grant.grantRef, 2, "closed")));
      assert.equal((await execute((g) => g.insertRoot(f.grant))).grant.status, "revoked");
      assert.equal((await f.read()).usedRequests, 0);
    });
    await t.test("digest, version, model and immutable database-time bounds refuse", async () => {
      const f = await fixture();
      const op = f.request();
      await assert.rejects(execute((g) => g.acceptOperation(scope, 2, op)));
      await assert.rejects(
        execute((g) =>
          g.acceptOperation(scope, 1, f.request({ operation: { ...model, modelId: "other" } })),
        ),
      );
      await assert.rejects(
        execute((g) =>
          g.acceptOperation(scope, 1, f.request({ dispatchBefore: iso(Date.now() - 1) })),
        ),
      );
      await assert.rejects(
        execute((g) =>
          g.acceptOperation(scope, 1, f.request({ expiresAt: iso(Date.now() + 120000) })),
        ),
      );
      await execute((g) => g.acceptOperation(scope, 1, op));
      await assert.rejects(
        execute((g) => g.dispatchOperation(scope, op.grantRef, op.operationRef, hex(), 1)),
      );
      await assert.rejects(
        execute((g) =>
          g.dispatchOperation(scope, op.grantRef, op.operationRef, op.requestDigest, 2),
        ),
      );
      assert.equal(
        (await execute((g) => g.findOperation(scope, op.grantRef, op.operationRef))).status,
        "accepted",
      );
    });
    await t.test(
      "dispatch is consumed once, unknown retains capacity, reconciliation releases once",
      async () => {
        const f = await fixture();
        const op = f.request();
        await execute((g) => g.acceptOperation(scope, 1, op));
        const dispatch = () =>
          execute((g) =>
            g.dispatchOperation(scope, op.grantRef, op.operationRef, op.requestDigest, 1),
          );
        const results = await Promise.all([dispatch(), dispatch()]);
        assert.deepEqual(results.map((r) => r.result).sort(), ["already-consumed", "dispatched"]);
        const marker = results[0].operation.dispatchedAt;
        assert.ok(marker);
        await execute((g) =>
          g.finishOperation(scope, op.grantRef, op.operationRef, {
            status: "unknown",
            outcome: "unknown",
          }),
        );
        await assert.rejects(execute((g) => g.acceptOperation(scope, 1, f.request())));
        assert.equal((await f.read()).activeRequests, 1);
        const terminal = { status: "completed", outcome: "ended" };
        const finished = await execute((g) =>
          g.finishOperation(scope, op.grantRef, op.operationRef, terminal),
        );
        assert.equal(finished.dispatchedAt, marker);
        assert.deepEqual(
          await execute((g) => g.finishOperation(scope, op.grantRef, op.operationRef, terminal)),
          finished,
        );
        assert.equal((await f.read()).activeRequests, 0);
        assert.equal((await f.read()).usedRequests, 1);
        await assert.rejects(
          execute((g) =>
            g.finishOperation(scope, op.grantRef, op.operationRef, {
              status: "unknown",
              outcome: "unknown",
            }),
          ),
        );
        const replay = await execute((g) => g.acceptOperation(scope, 1, op));
        assert.equal(replay.result, "duplicate");
        assert.equal(replay.operation.status, "completed");
        assert.equal((await dispatch()).result, "already-consumed");
      },
    );
    await t.test(
      "never-dispatched cancellation keeps charge; unknown without marker cannot become completed",
      async () => {
        const f = await fixture();
        const op = f.request();
        await execute((g) => g.acceptOperation(scope, 1, op));
        await execute((g) =>
          g.finishOperation(scope, op.grantRef, op.operationRef, {
            status: "unknown",
            outcome: "unknown",
          }),
        );
        await assert.rejects(
          execute((g) =>
            g.finishOperation(scope, op.grantRef, op.operationRef, {
              status: "completed",
              outcome: "ended",
            }),
          ),
        );
        await execute((g) =>
          g.finishOperation(scope, op.grantRef, op.operationRef, {
            status: "cancelled",
            outcome: "not-dispatched",
          }),
        );
        assert.equal((await f.read()).activeRequests, 0);
        assert.equal((await f.read()).usedRequests, 1);
      },
    );
    await t.test(
      "root, operation, history and platform audit roll back together; escaped repository closes",
      async () => {
        const f = await fixture();
        const op = f.request();
        const audit = runtimeAudit(owner);
        const rollbackGrant = {
          ...f.grant,
          grantRef: `grant/${randomUUID()}`,
          mediationContextRef: randomUUID(),
        };
        const rollbackOperation = { ...op, grantRef: rollbackGrant.grantRef };
        const configurationId = `cfg_${randomUUID()}`;
        let escaped;
        await assert.rejects(
          host.transact(async (unit, g) => {
            escaped = g;
            await unit.audit.append(audit);
            await unit.configurations.createConfiguration({
              id: configurationId,
              namespaceId: scope.namespaceId,
              kind: "agent",
              generation: 1,
              createdAt: new Date().toISOString(),
            });
            await g.insertRoot(rollbackGrant);
            await g.acceptOperation(scope, 1, rollbackOperation);
            throw new Error("rollback");
          }),
          /rollback/,
        );
        assert.equal((await f.read()).usedRequests, 0);
        assert.equal(
          await execute((g) => g.findByContext(scope, rollbackGrant.mediationContextRef)),
          undefined,
        );
        assert.equal(
          (
            await pool.query("SELECT version FROM occ.delegation_root_history WHERE grant_ref=$1", [
              rollbackGrant.grantRef,
            ])
          ).rowCount,
          0,
        );
        assert.equal(
          (await pool.query("SELECT id FROM occ.configurations WHERE id=$1", [configurationId]))
            .rowCount,
          0,
        );
        assert.equal(
          (await pool.query("SELECT id FROM occ.audit_events WHERE id=$1", [audit.id])).rowCount,
          0,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT version FROM occ.delegation_operation_history WHERE operation_ref=$1",
              [op.operationRef],
            )
          ).rowCount,
          0,
        );
        await assert.rejects(escaped.findByContext(scope, f.grant.mediationContextRef));
      },
    );
    await t.test("dispatch uses wall clock after waiting, not transaction start time", async () => {
      const f = await fixture();
      const op = f.request({ dispatchBefore: iso(Date.now() + 700) });
      await execute((g) => g.acceptOperation(scope, 1, op));
      await assert.rejects(
        host.transact(async (unit, g) => {
          await store.queryInTransaction(unit, "SELECT pg_sleep(0.8)");
          return g.dispatchOperation(scope, op.grantRef, op.operationRef, op.requestDigest, 1);
        }),
      );
      assert.equal(
        (await execute((g) => g.findOperation(scope, op.grantRef, op.operationRef))).status,
        "accepted",
      );
    });
    await t.test(
      "a connection waiting for the owner lock cannot dispatch after its deadline",
      async () => {
        const f = await fixture();
        const op = f.request({ dispatchBefore: iso(Date.now() + 700) });
        await execute((g) => g.acceptOperation(scope, 1, op));
        let acquired, allowSleep;
        const locked = new Promise((resolve) => {
          acquired = resolve;
        });
        const sleeping = new Promise((resolve) => {
          allowSleep = resolve;
        });
        const blocker = host.transact(async (unit) => {
          await store.queryInTransaction(
            unit,
            "SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE",
            [scope.namespaceId],
          );
          await store.queryInTransaction(
            unit,
            "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR UPDATE",
            [scope.namespaceId, scope.agentId],
          );
          acquired();
          await sleeping;
          await store.queryInTransaction(unit, "SELECT pg_sleep(0.8)");
        });
        await locked;
        const dispatch = execute((g) =>
          g.dispatchOperation(scope, op.grantRef, op.operationRef, op.requestDigest, 1),
        );
        void dispatch.catch(() => {});
        allowSleep();
        await blocker;
        await assert.rejects(dispatch);
        assert.equal(
          (await execute((g) => g.findOperation(scope, op.grantRef, op.operationRef))).status,
          "accepted",
        );
      },
    );
    await t.test("lost real COMMIT acknowledgement cannot rearm consumed dispatch", async () => {
      const f = await fixture();
      const op = f.request();
      await execute((g) => g.acceptOperation(scope, 1, op));
      const proxy = await runtimeCommitAckProxy(url);
      const faultPool = new pg.Pool({ connectionString: proxy.url, max: 1 });
      try {
        const faultStore = new PostgresPlatformState(faultPool);
        await assert.rejects(
          faultStore.delegationTransactionHost().transact(async (_unit, g) => {
            const provisional = await g.dispatchOperation(
              scope,
              op.grantRef,
              op.operationRef,
              op.requestDigest,
              1,
            );
            assert.equal(provisional.result, "dispatched");
            proxy.arm();
            return provisional;
          }),
          PostgresCommitOutcomeUnknownError,
        );
        assert.equal(proxy.observedCommit, true);
        assert.equal(
          (await execute((g) => g.findOperation(scope, op.grantRef, op.operationRef))).status,
          "dispatched",
        );
        assert.equal(
          (
            await execute((g) =>
              g.dispatchOperation(scope, op.grantRef, op.operationRef, op.requestDigest, 1),
            )
          ).result,
          "already-consumed",
        );
        assert.equal((await f.read()).activeRequests, 1);
      } finally {
        await faultPool.end();
        await proxy.close();
      }
    });
    await t.test(
      "limited role cannot alter immutable records, forge history or bypass transition guards",
      async () => {
        const f = await fixture();
        const op = f.request();
        await execute((g) => g.acceptOperation(scope, 1, op));
        const reject = (sql, args) => assert.rejects(pool.query(sql, args));
        await reject("UPDATE occ.delegation_roots SET root_grant='{}' WHERE grant_ref=$1", [
          f.grant.grantRef,
        ]);
        await reject("UPDATE occ.delegation_roots SET status='closed' WHERE grant_ref=$1", [
          f.grant.grantRef,
        ]);
        await reject("DELETE FROM occ.delegation_operations WHERE operation_ref=$1", [
          op.operationRef,
        ]);
        await reject(
          "UPDATE occ.delegation_operations SET status='completed',outcome=NULL,version=version+1 WHERE operation_ref=$1",
          [op.operationRef],
        );
        await reject(
          "UPDATE occ.delegation_operations SET status='dispatched',dispatched_at='2026-01-01T00:00:00.000Z',version=version+1 WHERE operation_ref=$1",
          [op.operationRef],
        );
        await reject(
          "UPDATE occ.delegation_operation_history SET record='{}' WHERE operation_ref=$1",
          [op.operationRef],
        );
        await reject(
          "INSERT INTO occ.delegation_root_history SELECT installation_id,namespace_id,agent_id,grant_ref,version+10,to_jsonb(r) FROM occ.delegation_roots r WHERE grant_ref=$1",
          [f.grant.grantRef],
        );
        const insert = (value) =>
          pool.query(
            `INSERT INTO occ.delegation_operations
          (installation_id,namespace_id,agent_id,grant_ref,operation_ref,admission,status,outcome,dispatched_at,root_version,version)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,'accepted',NULL,NULL,1,1)`,
            [
              scope.installationId,
              scope.namespaceId,
              scope.agentId,
              value.grantRef,
              value.operationRef,
              JSON.stringify(value),
            ],
          );
        // Bypass the TypeScript parser and pre-lock to exercise the actual database guards.
        await assert.rejects(insert(f.request()), (error) => error.code === "23514");
        await assert.rejects(
          insert(f.request({ decisionRef: "" })),
          (error) => error.code === "23514",
        );
        const clockOnly = await fixture();
        const clockNow = Date.now();
        // Valid interval and unused budget isolate the database wall-clock refusal.
        await assert.rejects(
          insert(
            clockOnly.request({
              acceptedAt: iso(clockNow - 500),
              dispatchBefore: iso(clockNow - 200),
            }),
          ),
          (error) => error.code === "23514",
        );
        const race = await fixture({ maxRequests: 1, maxConcurrentRequests: 1 });
        const admissions = await Promise.allSettled([
          insert(race.request()),
          insert(race.request()),
        ]);
        assert.equal(admissions.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal((await race.read()).usedRequests, 1);
        const client = await pool.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
          await assert.rejects(
            client.query(
              "UPDATE occ.delegation_roots SET status='closed',version=version+1 WHERE grant_ref=$1",
              [f.grant.grantRef],
            ),
            (error) => error.code === "23514",
          );
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
        assert.equal((await f.read()).activeRequests, 1);
      },
    );
  },
);
