import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  PostgresPlatformState,
  PostgresCommitOutcomeUnknownError,
} from "../../packages/occ/src/state/postgres-state.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";

function namespace() {
  return {
    id: `ns_${randomUUID()}`,
    name: `Credential participant ${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
}
function gate() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const insert = `INSERT INTO occ.namespaces (id, name, status, created_at)
  VALUES ($1, $2, $3, $4) RETURNING id`;
const parameters = (value) => [value.id, value.name, value.status, value.createdAt];
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test(
  "PostgreSQL original credential participant and commit recognition",
  { timeout: 60000 },
  async (t) => {
    const url = process.env.OCC_TEST_DATABASE_URL;
    assert.ok(
      url,
      "OCC_TEST_DATABASE_URL is required; missing real PostgreSQL fails this contract.",
    );
    const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
    const state = new PostgresPlatformState(pool);
    const find = (id) => state.read((view) => view.namespaces.findNamespace(id));
    try {
      // Verify the application role itself. Migration privileges must never be used
      // to make an otherwise unsupported persistence or transaction test pass.
      const role = (
        await pool.query(`SELECT current_user AS name, rolsuper, rolbypassrls,
      rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user`)
      ).rows[0];
      assert.equal(role.name, "occ_app");
      for (const flag of ["rolsuper", "rolbypassrls", "rolcreatedb", "rolcreaterole"])
        assert.equal(role[flag], false);
      if (!(await state.loadInstallation()))
        await state.transact((uow) =>
          uow.installations.createInstallation({
            id: `ins_${randomUUID()}`,
            name: "Credential State integration",
            createdAt: new Date().toISOString(),
          }),
        );

      await t.test(
        "exact original unit stages real SQL; one recognition follows acknowledged outer COMMIT",
        async () => {
          const value = namespace();
          let unit;
          let original;
          await state.transact(async (uow) => {
            original = uow;
            unit = state.bindCredentialUnitIn(uow);
            assert.equal(state.bindCredentialUnitIn(uow), unit);
            await unit.run(async () => {
              const written = await unit.query(insert, parameters(value));
              assert.equal(written.rowCount, 1);
              assert.equal(written.rows[0].id, value.id);
              await assert.rejects(state.recognizeCredentialCommit(unit), ScopeViolationError);
              assert.equal(await find(value.id), undefined);
            });
            await assert.rejects(state.recognizeCredentialCommit(unit), ScopeViolationError);
          });
          assert.equal((await find(value.id)).id, value.id);
          const known = await state.recognizeCredentialCommit(unit);
          assert.equal(known.kind, "committed");
          assert.equal("commitRef" in known.evidence, false);
          await assert.rejects(state.recognizeCredentialCommit(unit), ScopeViolationError);
          assert.throws(() => state.bindCredentialUnitIn(original), ScopeViolationError);
          await assert.rejects(unit.query(insert, parameters(namespace())), ScopeViolationError);
          await assert.rejects(
            unit.run(async () => {}),
            ScopeViolationError,
          );
        },
      );

      await t.test("foreign, copied and read-only units never gain State ownership", async () => {
        const foreign = new PostgresPlatformState(pool);
        let first;
        let second;
        await state.read(async (view) => {
          assert.throws(() => state.bindCredentialUnitIn(view), ScopeViolationError);
        });
        await state.transact(async (uow) => {
          assert.throws(() => foreign.bindCredentialUnitIn(uow), ScopeViolationError);
          assert.throws(() => state.bindCredentialUnitIn({ ...uow }), ScopeViolationError);
          first = state.bindCredentialUnitIn(uow);
          await assert.rejects(foreign.recognizeCredentialCommit(first), ScopeViolationError);
          await assert.rejects(state.recognizeCredentialCommit({ ...first }), ScopeViolationError);
        });
        await state.transact(async (uow) => {
          second = state.bindCredentialUnitIn(uow);
        });
        const a = await state.recognizeCredentialCommit(first);
        const b = await state.recognizeCredentialCommit(second);
        assert.equal(a.kind, "committed");
        assert.equal(b.kind, "committed");
        assert.notEqual(a.evidence, b.evidence);
      });

      await t.test(
        "callback rollback, caught and unawaited participant failures leave no persisted writes or evidence",
        async () => {
          for (const mode of ["callback", "caught", "unawaited", "nested-query", "direct-query"]) {
            const value = namespace();
            const failure = new Error("Original credential failure");
            let unit;
            await assert.rejects(
              state.transact(async (uow) => {
                unit = state.bindCredentialUnitIn(uow);
                await unit.query(insert, parameters(value));
                if (mode === "callback") throw failure;
                if (mode === "direct-query") {
                  // The genuine duplicate-key failure poisons a borrowed credential
                  // query even when it is used without a surrounding run callback.
                  await unit.query(insert, parameters(value)).catch(() => {});
                  return;
                }
                const result = unit.run(async () => {
                  if (mode === "nested-query") {
                    await unit.query(insert, parameters(value)).catch(() => {});
                    return;
                  }
                  await Promise.resolve();
                  throw failure;
                });
                if (mode !== "unawaited") await result.catch(() => {});
              }),
              (error) => (mode.includes("query") ? error instanceof Error : error === failure),
            );
            assert.equal(await find(value.id), undefined, mode);
            assert.deepEqual(await state.recognizeCredentialCommit(unit), {
              kind: "not-committed",
            });
          }
        },
      );

      await t.test(
        "accepted original child query retains its row lock and drains; settled siblings cannot write",
        async () => {
          const value = namespace();
          value.status = "provisioning";
          await state.transact((uow) => uow.namespaces.createNamespace(value));
          const blocker = await pool.connect();
          const returned = gate();
          const escapeGate = gate();
          let open = false;
          let transaction;
          let child;
          let escape;
          let unit;
          let complete = false;
          const denied = namespace();
          try {
            // A separate real client blocks the accepted update across parent and
            // outer callback settlement. State must retain the query's own lifetime.
            await blocker.query("BEGIN");
            open = true;
            await blocker.query("SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE", [
              value.id,
            ]);
            transaction = state.transact(async (uow) => {
              unit = state.bindCredentialUnitIn(uow);
              await unit.run(async () => {
                child = unit
                  .query(
                    "UPDATE occ.namespaces SET status = 'ready' WHERE id = $1 AND status = 'provisioning' RETURNING id",
                    [value.id],
                  )
                  .then((result) => {
                    complete = true;
                    return result;
                  });
                escape = (async () => {
                  await escapeGate.promise;
                  assert.throws(() => state.bindCredentialUnitIn(uow), ScopeViolationError);
                  await assert.rejects(unit.query(insert, parameters(denied)), ScopeViolationError);
                  await assert.rejects(
                    unit.run(async () => {}),
                    ScopeViolationError,
                  );
                })();
              });
              returned.resolve();
            });
            void transaction.catch(() => {});
            await returned.promise;
            await nextTurn();
            assert.equal(complete, false);
            await assert.rejects(state.recognizeCredentialCommit(unit), ScopeViolationError);
            escapeGate.resolve();
            await escape;
            assert.equal(complete, false);
            await blocker.query("ROLLBACK");
            open = false;
            await transaction;
            assert.equal((await child).rowCount, 1);
            assert.equal((await find(value.id)).status, "ready");
            assert.equal(await find(denied.id), undefined);
            assert.equal((await state.recognizeCredentialCommit(unit)).kind, "committed");
          } finally {
            if (open) await blocker.query("ROLLBACK");
            blocker.release();
            escapeGate.resolve();
            await transaction?.catch(() => {});
            await escape?.catch(() => {});
          }
        },
      );

      await t.test(
        "borrowed SQL supports PostgreSQL quoting, parameters, WITH and locks; transaction-control attempts roll back",
        async () => {
          let accepted;
          await state.transact(async (uow) => {
            accepted = state.bindCredentialUnitIn(uow);
            const result = await accepted.query(
              `/* nested /* inner */ boundary */
          SELECT '; COMMIT' AS a, $$; ROLLBACK$$ AS b, $tag$; END$tag$ AS c,
          E'escaped \\' quote; COMMIT' AS d, $é$ -- quoted ; COMMIT$é$ AS e,
          $é1$ /* quoted ; ROLLBACK$é1$ AS f, $1::text AS parameter; -- trailing comment`,
              ["original parameter"],
            );
            assert.equal(result.rows[0].a, "; COMMIT");
            assert.equal(result.rows[0].b, "; ROLLBACK");
            assert.equal(result.rows[0].c, "; END");
            assert.equal(result.rows[0].d, "escaped ' quote; COMMIT");
            assert.equal(result.rows[0].e, " -- quoted ; COMMIT");
            assert.equal(result.rows[0].f, " /* quoted ; ROLLBACK");
            assert.equal(result.rows[0].parameter, "original parameter");
            assert.equal(
              (
                await accepted.query(
                  "WITH original AS (SELECT 1 AS value) SELECT value FROM original",
                )
              ).rows[0].value,
              1,
            );
            await accepted.query("LOCK TABLE occ.namespaces IN ROW SHARE MODE");
          });
          assert.equal((await state.recognizeCredentialCommit(accepted)).kind, "committed");
          for (const statement of [
            "COMMIT",
            "/* comment */ ROLLBACK",
            "SELECT 1;-- boundary\nCOMMIT",
            "SELECT $$;COMMIT$$; /* boundary */ END",
            "SELECT $é$ -- hidden $é$; COMMIT",
            "SELECT $é1$ /* hidden $é1$; ROLLBACK",
            "SELECT $tagé$ -- hidden $tagé$; END",
            "SET TRANSACTION READ ONLY",
          ]) {
            const value = namespace();
            let unit;
            await assert.rejects(
              state.transact(async (uow) => {
                unit = state.bindCredentialUnitIn(uow);
                await unit.query(insert, parameters(value));
                await assert.rejects(unit.query(statement), ScopeViolationError);
              }),
              ScopeViolationError,
            );
            assert.equal(await find(value.id), undefined);
            assert.deepEqual(await state.recognizeCredentialCommit(unit), {
              kind: "not-committed",
            });
          }
        },
      );

      for (const mode of ["caught", "unawaited"]) {
        await t.test(`malformed UTF16 ${mode} refusal rolls back without forwarding`, async () => {
          const high = String.fromCharCode(0xd800);
          const otherHigh = String.fromCharCode(0xd801);
          const low = String.fromCharCode(0xdc00);
          const statements = [
            `SELECT $${high}$ -- hidden $${otherHigh}$; COMMIT -- $${high}$`,
            `SELECT $${low}$value$${low}$`,
            `SELECT 1 -- trailing ${high}`,
          ];
          const forwarded = [];
          // Observe transport admission while delegating every accepted operation
          // unchanged to pg. Persistence is read on a separate real connection.
          const observed = new PostgresPlatformState({
            async connect() {
              const client = await pool.connect();
              return {
                query(statement, parameters) {
                  forwarded.push(statement);
                  return client.query(statement, parameters);
                },
                on: (...args) => client.on(...args),
                removeListener: (...args) => client.removeListener(...args),
                release: (...args) => client.release(...args),
              };
            },
            async end() {},
          });
          const reader = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
          await reader.connect();
          try {
            for (const statement of statements) {
              const value = namespace();
              let unit;
              await assert.rejects(
                observed.transact(async (uow) => {
                  unit = observed.bindCredentialUnitIn(uow);
                  await unit.query(insert, parameters(value));
                  const result = unit.query(statement);
                  // No independent callback throw: refusal itself must poison
                  // the original outer transaction, even when ignored or caught.
                  if (mode === "caught") await assert.rejects(result, ScopeViolationError);
                }),
                ScopeViolationError,
              );
              assert.equal(forwarded.includes(statement), false);
              const durable = await reader.query("SELECT id FROM occ.namespaces WHERE id = $1", [
                value.id,
              ]);
              assert.equal(durable.rowCount, 0);
              assert.deepEqual(await observed.recognizeCredentialCommit(unit), {
                kind: "not-committed",
              });
            }
            assert.equal(forwarded.includes("COMMIT"), false);
          } finally {
            await reader.end();
          }
        });
      }

      await t.test(
        "well-formed Unicode dollar tags preserve SQL and parameter values",
        async () => {
          const supplementary = String.fromCodePoint(0x1f680);
          const replacement = String.fromCharCode(0xfffd);
          const tags = [supplementary, replacement, "e\u0301", "Tag"];
          let unit;
          await state.transact(async (uow) => {
            unit = state.bindCredentialUnitIn(uow);
            for (const tag of tags) {
              const statement = `SELECT $${tag}$ -- quoted ; COMMIT $${tag}$ AS value, $1::text AS parameter`;
              const result = await unit.query(statement, ["parameter " + tag]);
              assert.equal(result.rows[0].value, " -- quoted ; COMMIT ");
              assert.equal(result.rows[0].parameter, "parameter " + tag);
            }
            // Dollar tags are case-sensitive: a differently cased tag is content.
            const result = await unit.query("SELECT $Tag$inside $tag$ ; COMMIT$Tag$ AS value");
            assert.equal(result.rows[0].value, "inside $tag$ ; COMMIT");
          });
          assert.equal((await state.recognizeCredentialCommit(unit)).kind, "committed");
          for (const tag of tags) {
            const value = namespace();
            let denied;
            await assert.rejects(
              state.transact(async (uow) => {
                denied = state.bindCredentialUnitIn(uow);
                await denied.query(insert, parameters(value));
                await assert.rejects(
                  denied.query(`SELECT $${tag}$ -- hidden $${tag}$; COMMIT`),
                  ScopeViolationError,
                );
              }),
              ScopeViolationError,
            );
            assert.equal(await find(value.id), undefined);
            assert.deepEqual(await state.recognizeCredentialCommit(denied), {
              kind: "not-committed",
            });
          }
        },
      );

      await t.test(
        "lost real COMMIT acknowledgment stays unknown after exact durable readback",
        { timeout: 30000 },
        async () => {
          const proxy = await commitAckProxy(url);
          const faultPool = new pg.Pool({
            connectionString: proxy.url,
            max: 1,
            connectionTimeoutMillis: 3000,
          });
          const faultState = new PostgresPlatformState(faultPool);
          const value = namespace();
          let unit;
          try {
            proxy.arm();
            await assert.rejects(
              faultState.transact(async (uow) => {
                unit = faultState.bindCredentialUnitIn(uow);
                await unit.run(async () => {
                  await unit.query(insert, parameters(value));
                });
              }),
              PostgresCommitOutcomeUnknownError,
            );
            assert.equal(proxy.observedCommit, true);
            assert.equal((await find(value.id)).id, value.id);
            assert.deepEqual(await faultState.recognizeCredentialCommit(unit), {
              kind: "unknown",
              nextAction: "reconcile-only",
            });
            await assert.rejects(faultState.recognizeCredentialCommit(unit), ScopeViolationError);
            await assert.rejects(state.recognizeCredentialCommit(unit), ScopeViolationError);
          } finally {
            await faultPool.end();
            await proxy.close();
          }
        },
      );

      await t.test(
        "real persisted COMMIT with a release fault supplies only unknown reconciliation",
        async () => {
          // The adapter delegates every query/event to the real pg client and releases
          // it once, then injects a cleanup failure. It simulates cleanup uncertainty;
          // it does not fabricate SQL results, COMMIT or persistence evidence.
          const faultState = new PostgresPlatformState({
            async connect() {
              const client = await pool.connect();
              return {
                query: client.query.bind(client),
                on: client.on.bind(client),
                removeListener: client.removeListener.bind(client),
                release(discard) {
                  client.release(discard);
                  throw new Error("Injected release fault");
                },
              };
            },
            async end() {},
          });
          const value = namespace();
          let unit;
          await assert.rejects(
            faultState.transact(async (uow) => {
              unit = faultState.bindCredentialUnitIn(uow);
              await unit.query(insert, parameters(value));
            }),
            PostgresCommitOutcomeUnknownError,
          );
          assert.equal((await find(value.id)).id, value.id);
          assert.deepEqual(await faultState.recognizeCredentialCommit(unit), {
            kind: "unknown",
            nextAction: "reconcile-only",
          });
        },
      );
    } finally {
      await pool.end();
    }
  },
);
