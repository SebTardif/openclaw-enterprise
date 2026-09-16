import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { seedAuthority, writer } from "../fixtures/runtime-authority-state/seed.mjs";
import {
  PostgresCommitOutcomeUnknownError,
  PostgresPlatformState,
} from "../../packages/occ/src/state/postgres-state.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import {
  verifyAuthorityParticipants,
  verifyOwnerSettlement,
  verifyRepositoryLifetime,
} from "../conformance/repository-lifetime.contract.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
test(
  "PostgreSQL repository ownership, lifetime, and atomicity",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL to a disposable migrated PostgreSQL database.",
    timeout: 60000,
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    (await store.loadInstallation()) ??
      (await store.transact((unit) =>
        unit.installations.createInstallation({
          id: `ins_${randomUUID()}`,
          name: "Repository tests",
          createdAt: new Date().toISOString(),
        }),
      ));
    await verifyRepositoryLifetime(t, store);
    await verifyAuthorityParticipants(t, store, new PostgresPlatformState(pool));
    // The production queue projection must forward the actual user Promise too.
    await verifyOwnerSettlement(t, store, "transactWithQueue", (_unit, queue) => queue.pending());
    await t.test(
      "closed consume denies escaped siblings while an original child waits on a real row lock",
      { timeout: 10000 },
      async () => {
        const namespace = {
          id: "ns_" + randomUUID(),
          name: "Drain lock " + randomUUID(),
          status: "ready",
          createdAt: new Date().toISOString(),
        };
        await store.transact((unit) => unit.namespaces.createNamespace(namespace));
        const configuration = {
          id: "cfg_" + randomUUID(),
          namespaceId: namespace.id,
          kind: "agent",
          generation: 1,
          createdAt: namespace.createdAt,
        };
        const denied = { ...configuration, id: "cfg_" + randomUUID() };
        const blocker = await pool.connect();
        let open = false;
        let transaction;
        let escape;
        let releaseEscape;
        const escapeGate = new Promise((resolve) => {
          releaseEscape = resolve;
        });
        let outerReturned;
        const outer = new Promise((resolve) => {
          outerReturned = resolve;
        });
        let child;
        let complete = false;
        try {
          await blocker.query("BEGIN");
          open = true;
          await blocker.query("SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE", [
            namespace.id,
          ]);
          transaction = store.transact(async (unit) => {
            await store.runAuthorityParticipantIn(unit, async () => {
              // The genuine child must perform its Namespace lock before writing.
              // A second real client retains that lock across callback settlement.
              child = unit.configurations.createConfiguration(configuration).then((value) => {
                complete = true;
                return value;
              });
              escape = (async () => {
                await escapeGate;
                await assert.rejects(
                  unit.configurations.createConfiguration(denied),
                  ScopeViolationError,
                );
              })();
            });
            outerReturned();
          });
          void transaction.catch(() => {});
          await outer;
          await nextTurn();
          assert.equal(complete, false);
          releaseEscape();
          await escape;
          assert.equal(complete, false);
          await blocker.query("ROLLBACK");
          open = false;
          await transaction;
          assert.equal((await child).id, configuration.id);
          assert.equal(complete, true);
          assert.equal(
            (
              await store.read((unit) =>
                unit.configurations.findConfiguration(namespace.id, configuration.id),
              )
            ).id,
            configuration.id,
          );
          assert.equal(
            await store.read((unit) =>
              unit.configurations.findConfiguration(namespace.id, denied.id),
            ),
            undefined,
          );
        } finally {
          if (open) await blocker.query("ROLLBACK");
          blocker.release();
          releaseEscape();
          await transaction?.catch(() => {});
          await escape?.catch(() => {});
        }
      },
    );

    await t.test(
      "caught original query failure remains the authority failure before COMMIT",
      async () => {
        const namespace = {
          id: "ns_" + randomUUID(),
          name: "Query denial " + randomUUID(),
          status: "ready",
          createdAt: new Date().toISOString(),
        };
        let originalQueryError;
        await assert.rejects(
          store.transact(async (unit) => {
            await unit.namespaces.createNamespace(namespace);
            await store.runAuthorityParticipantIn(unit, async () => {
              // A real SQL error aborts the backend. Catching it must still preserve
              // the original authority error, rather than reaching a ROLLBACK ACK at COMMIT.
              try {
                await store.queryInTransaction(unit, "SELECT 1 / 0");
              } catch (error) {
                originalQueryError = error;
              }
            });
          }),
          (error) => error === originalQueryError && error.code === "22012",
        );
        assert.equal(
          await store.read((unit) => unit.namespaces.findNamespace(namespace.id)),
          undefined,
        );
      },
    );

    await t.test(
      "drained whole authority consume retains real lost-COMMIT outcome and receipt",
      { timeout: 30000 },
      async () => {
        const f = await seedAuthority(store);
        const proxy = await commitAckProxy(databaseUrl);
        const faultPool = new pg.Pool({
          connectionString: proxy.url,
          max: 1,
          connectionTimeoutMillis: 3000,
        });
        const faultState = new PostgresPlatformState(faultPool);
        let completed = false;
        try {
          // Consume the real server completion: committed data must survive while
          // the caller receives an unknown outcome and the dead client is discarded.
          proxy.arm();
          await assert.rejects(
            faultState.transact(async (unit) => {
              faultState.runAuthorityParticipantIn(unit, async () => {
                await Promise.resolve();
                assert.ok(await unit.installations.getInstallation());
                await unit.runtimeAuthority.appendMutation(f.bind, writer);
                completed = true;
              });
            }),
            PostgresCommitOutcomeUnknownError,
          );
          assert.equal(completed, true);
          assert.equal(proxy.observedCommit, true);
          assert.equal((await f.record()).authority.assignmentRecordVersion, 2);
          assert.equal(
            (await f.operation(f.bind.operationRef)).receipt.operationRef,
            f.bind.operationRef,
          );
          // This read requires a replacement client from the same pool.
          assert.equal(
            (
              await faultState.read((unit) =>
                unit.runtimeAuthority.findOperation(f.target, f.bind.operationRef),
              )
            ).receipt.operationRef,
            f.bind.operationRef,
          );
        } finally {
          await faultPool.end();
          await proxy.close();
        }
      },
    );

    await t.test(
      "accepted raw SQL drains and queue/query handles close before connection reuse",
      async () => {
        let retainedUnit;
        let retainedQueue;
        let accepted;
        let completed = false;
        await store.transactWithQueue(async (unit, queue) => {
          retainedUnit = unit;
          retainedQueue = queue;
          accepted = store
            .queryInTransaction(unit, "SELECT pg_sleep(0.02), 1 AS value")
            .then((result) => {
              completed = true;
              return result;
            });
        });
        assert.equal(completed, true);
        assert.equal((await accepted).rows[0].value, 1);
        await assert.rejects(retainedQueue.pending(), ScopeViolationError);
        assert.throws(
          () => store.queryInTransaction(retainedUnit, "SELECT 1"),
          DependencyUnavailableError,
        );
        assert.equal((await pool.query("SELECT 1 AS value")).rows[0].value, 1);
      },
    );
  },
);
