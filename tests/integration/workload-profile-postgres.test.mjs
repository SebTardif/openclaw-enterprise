import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/ports/transaction-errors.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { createPostgresWorkloadProfile } from "../../packages/occ/src/state/postgres/workload-profile.ts";
import {
  ProfileOperationCapacityError,
  ProfileOperationConflictError,
  WorkloadProfileTransactionGuard,
} from "../../packages/occ/src/workload-profiles/repository.ts";
import {
  createProfilePreparation,
  InvalidProfileOperationError,
  normalizeProfilePreparation,
  PROFILE_ALLOCATION_KINDS,
} from "../../packages/occ/src/workload-profiles/types.ts";
import { inertProfileRequest, profileActorFixture } from "../fixtures/workload-profile.mjs";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";

// This opt-in suite exercises the preparation factory on real PlatformState
// transactions. It does not exercise HTTP, a human guard, manifest qualification,
// active admission, or downstream use. Its dedicated database must already have
// the composed tables, owner constraints and limited application-role grants.
const databaseUrl = process.env.OCC_WORKLOAD_PROFILE_DATABASE_URL;
const options = {
  skip: databaseUrl
    ? false
    : "Set OCC_WORKLOAD_PROFILE_DATABASE_URL to a freshly allocated, migrated profile test database.",
  timeout: 180_000,
};
if (databaseUrl) {
  const target = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  assert.match(decodeURIComponent(target.pathname), /^\/openclaw_profile_[a-z0-9_]+$/);
}

// The existing state remains the connection and COMMIT owner. This fixture
// composes the new factory through its real borrowed query seam and drains the
// profile guard before that owner's callback completes.
function profileTransaction(state, work, identities, namespaceId) {
  return state.transact(async (unit) => {
    const installation = await unit.installations.getInstallation();
    assert.ok(installation);
    const lifetime = new RepositoryTransactionLifetime();
    const guard = new WorkloadProfileTransactionGuard();
    const repository = createPostgresWorkloadProfile(
      {
        scope: { installationId: installation.id, ...(namespaceId ? { namespaceId } : {}) },
        transaction: lifetime,
        query: {
          query: (statement, parameters) => state.queryInTransaction(unit, statement, parameters),
        },
      },
      guard,
      identities,
    );
    try {
      return await work(repository, unit);
    } finally {
      try {
        await guard.finish();
      } finally {
        await lifetime.finish();
      }
    }
  });
}

async function freshProcessRead(locator) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, OCC_WORKLOAD_PROFILE_PROCESS_MODE: "readback" },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15_000,
  });
  let output = "";
  let errorOutput = "";
  child.stdout.on("data", (value) => {
    output += value;
  });
  child.stderr.on("data", (value) => {
    errorOutput += value;
  });
  child.stdin.end(JSON.stringify(locator));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, errorOutput);
  return JSON.parse(output);
}

if (process.env.OCC_WORKLOAD_PROFILE_PROCESS_MODE === "readback") {
  assert.ok(databaseUrl);
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const retained = await profileTransaction(new PostgresPlatformState(pool), (repository) =>
      repository.findOperation(JSON.parse(input)),
    );
    assert.ok(retained);
    process.stdout.write(JSON.stringify(retained));
  } finally {
    await pool.end();
  }
} else {
  test(
    "PostgreSQL inert workload-profile preparation, constraints and recovery",
    options,
    async (t) => {
      const pool = new pg.Pool({
        connectionString: databaseUrl,
        max: 8,
        query_timeout: 10_000,
        connectionTimeoutMillis: 5_000,
      });
      t.after(() => pool.end());
      const state = new PostgresPlatformState(pool);
      const identity = (
        await pool.query(
          `SELECT current_user, current_database(), rolsuper, rolcreaterole
       FROM pg_roles WHERE rolname=current_user`,
        )
      ).rows[0];
      assert.equal(identity.current_user, "occ_app");
      assert.equal(identity.rolsuper, false);
      assert.equal(identity.rolcreaterole, false);
      assert.match(identity.current_database, /^openclaw_profile_[a-z0-9_]+$/);
      // A configured but uncomposed database fails here; missing migration is not
      // substituted with test-created DDL or mocked query results.
      const existing = (
        await pool.query(
          `SELECT (SELECT count(*)::int FROM occ.workload_profile_operations) AS operations,
        (SELECT count(*)::int FROM occ.workload_profile_capacity) AS capacity`,
        )
      ).rows[0];
      assert.deepEqual(
        existing,
        { operations: 0, capacity: 0 },
        "Use a fresh dedicated profile database.",
      );
      let installation = await state.read((unit) => unit.installations.getInstallation());
      if (!installation)
        installation = await state.transact((unit) =>
          unit.installations.createInstallation({
            id: `ins_${randomUUID()}`,
            name: "Inert profile persistence test",
            createdAt: new Date().toISOString(),
          }),
        );
      const namespace = {
        id: `ns_${randomUUID()}`,
        name: `Profile ${randomUUID()}`,
        status: "ready",
        createdAt: new Date().toISOString(),
      };
      await state.transact((unit) => unit.namespaces.createNamespace(namespace));
      const actor = profileActorFixture();
      const request = inertProfileRequest({ namespaceId: namespace.id });
      const locator = {
        installationId: installation.id,
        actor,
        operationRef: request.operationRef,
      };
      let original;
      const prepare = (input = request, attribution = actor, source = state, identities) =>
        profileTransaction(
          source,
          (repository) => repository.prepareOperation(input, attribution),
          identities,
        );
      const read = (input = locator) =>
        profileTransaction(state, (repository) => repository.findOperation(input));
      async function snapshot() {
        const result = await pool.query(
          `SELECT (SELECT count(*)::int FROM occ.workload_profile_operations WHERE installation_id=$1) AS operations,
          ordinary_operations, pending_ordinary_operations, terminal_slots
         FROM occ.workload_profile_capacity WHERE installation_id=$1`,
          [installation.id],
        );
        return (
          result.rows[0] ?? {
            operations: 0,
            ordinary_operations: 0,
            pending_ordinary_operations: 0,
            terminal_slots: 0,
          }
        );
      }

      await t.test(
        "exact durable replay allocates once and preserves the original actor",
        async () => {
          let allocations = 0;
          const allocator = {
            allocate: () => {
              allocations++;
              return randomUUID();
            },
          };
          original = await prepare(request, actor, state, allocator);
          assert.deepEqual(await prepare(request, actor, state, allocator), original);
          assert.equal(allocations, PROFILE_ALLOCATION_KINDS.length);
          assert.deepEqual(await read(), original);
          assert.deepEqual(await freshProcessRead(locator), original);
          assert.equal(
            await read({ ...locator, actor: { ...actor, accountRef: `other/${randomUUID()}` } }),
            undefined,
          );
          assert.equal(await read({ ...locator, actor: profileActorFixture() }), undefined);
          assert.equal(
            await read({ ...locator, installationId: `ins_${randomUUID()}` }),
            undefined,
          );
          const before = await snapshot();
          await assert.rejects(
            prepare(request, { ...actor, accountRef: `other/${randomUUID()}` }),
            ProfileOperationConflictError,
          );
          await assert.rejects(
            prepare(inertProfileRequest({ ...request, namespaceId: `ns_${randomUUID()}` })),
            ProfileOperationConflictError,
          );
          assert.deepEqual(await snapshot(), before);
          const second = await prepare(request, profileActorFixture());
          assert.notDeepEqual(second.allocated, original.allocated);
        },
      );

      await t.test("two PostgreSQL transactions replay one retained allocation", async () => {
        const input = inertProfileRequest({ namespaceId: namespace.id });
        let release;
        const barrier = new Promise((resolve) => {
          release = resolve;
        });
        const pids = [];
        let allocations = 0;
        const allocator = {
          allocate: () => {
            allocations++;
            return randomUUID();
          },
        };
        const results = await Promise.all(
          [0, 1].map(() =>
            profileTransaction(
              state,
              async (repository, unit) => {
                const result = await state.queryInTransaction(
                  unit,
                  "SELECT pg_backend_pid() AS pid",
                );
                pids.push(result.rows[0].pid);
                if (pids.length === 2) release();
                await barrier;
                return repository.prepareOperation(input, actor);
              },
              allocator,
            ),
          ),
        );
        assert.equal(new Set(pids).size, 2);
        assert.deepEqual(results[0], results[1]);
        assert.equal(allocations, PROFILE_ALLOCATION_KINDS.length);
      });

      await t.test(
        "a Namespace-scoped factory cannot hide an Installation operation key",
        async () => {
          const before = await snapshot();
          let allocations = 0;
          await assert.rejects(
            profileTransaction(
              state,
              (repository) => repository.prepareOperation(request, actor),
              {
                allocate: () => {
                  allocations++;
                  return randomUUID();
                },
              },
              namespace.id,
            ),
            ScopeViolationError,
          );
          assert.equal(allocations, 0);
          assert.deepEqual(await snapshot(), before);
        },
      );

      await t.test(
        "caught failure rolls back the owner's complete transaction and closes the factory",
        async () => {
          const input = inertProfileRequest({ namespaceId: namespace.id });
          const before = await snapshot();
          let escaped;
          await assert.rejects(
            profileTransaction(state, async (repository) => {
              escaped = repository;
              await repository.prepareOperation(input, actor);
              await assert.rejects(
                repository.prepareOperation({ ...input, extra: true }, actor),
                InvalidProfileOperationError,
              );
            }),
            InvalidProfileOperationError,
          );
          assert.deepEqual(await snapshot(), before);
          assert.equal(await read({ ...locator, operationRef: input.operationRef }), undefined);
          await assert.rejects(escaped.findOperation(locator), ScopeViolationError);
        },
      );

      await t.test(
        "Namespace lifecycle rejects new preparation without reserving capacity",
        async () => {
          for (const status of ["provisioning", "failed", "deleting"]) {
            const ns = {
              id: `ns_${randomUUID()}`,
              name: `Unavailable ${randomUUID()}`,
              status,
              createdAt: new Date().toISOString(),
              ...(status === "deleting" ? { deletedAt: new Date().toISOString() } : {}),
            };
            await state.transact((unit) => unit.namespaces.createNamespace(ns));
            if (ns.deletedAt)
              await pool.query("UPDATE occ.namespaces SET deleted_at=$2 WHERE id=$1", [
                ns.id,
                ns.deletedAt,
              ]);
            const before = await snapshot();
            await assert.rejects(
              prepare(inertProfileRequest({ namespaceId: ns.id })),
              ProfileOperationConflictError,
            );
            assert.deepEqual(await snapshot(), before);
          }
        },
      );

      await t.test(
        "database CHECK and FK constraints reject malformed direct inserts",
        async () => {
          const insert = (record, scope = {}) =>
            pool.query(
              `INSERT INTO occ.workload_profile_operations
          (installation_id, namespace_id, principal_ref, account_ref, operation_ref, record)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
              [
                scope.installationId ?? record.scope.installationId,
                scope.namespaceId ?? record.scope.namespaceId,
                record.actor.principalRef,
                record.actor.accountRef,
                record.operationRef,
                JSON.stringify(record),
              ],
            );
          const candidateFor = (owner = installation.id, namespaceId = namespace.id) =>
            structuredClone(
              createProfilePreparation(
                owner,
                actor,
                normalizeProfilePreparation(inertProfileRequest({ namespaceId })),
                original.allocated,
                original.preparedAt,
              ),
            );
          // Rebuild the entire canonical envelope under a fresh operation key so
          // each mutation starts with a valid record, independent of PK conflicts.
          for (const mutate of [
            (record) => {
              record.extra = true;
            },
            (record) => {
              delete record.actor.accountRef;
            },
            (record) => {
              record.allocated.runtimeRef = record.allocated.providerRef;
            },
            (record) => {
              record.canonicalClientIntent += " ";
            },
            (record) => {
              record.preparedAt = "2026-02-31T00:00:00.000Z";
            },
          ]) {
            const candidate = candidateFor();
            mutate(candidate);
            await assert.rejects(insert(candidate), (error) =>
              ["23502", "23514", "22008"].includes(error.code),
            );
          }
          await assert.rejects(
            insert(candidateFor(`ins_${randomUUID()}`)),
            (error) => error.code === "23503",
          );
          await assert.rejects(
            insert(candidateFor(installation.id, `ns_${randomUUID()}`)),
            (error) => error.code === "23503",
          );
          await assert.rejects(insert(original), (error) => error.code === "23505");
          const before = await snapshot();
          await assert.rejects(
            pool.query(
              "UPDATE occ.workload_profile_capacity SET pending_ordinary_operations=33 WHERE installation_id=$1",
              [installation.id],
            ),
            (error) => ["23514", "42501"].includes(error.code),
          );
          assert.deepEqual(await snapshot(), before);
        },
      );

      await t.test("app-role retained records are append-only after owner migration", async () => {
        // These checks deliberately require the actual owner migration/grants.
        // Table metadata alone cannot establish append-only protection.
        for (const statement of [
          "UPDATE occ.workload_profile_operations SET record=record WHERE installation_id=$1 AND principal_ref=$2 AND operation_ref=$3",
          "DELETE FROM occ.workload_profile_operations WHERE installation_id=$1 AND principal_ref=$2 AND operation_ref=$3",
        ]) {
          let deniedCode;
          await assert.rejects(
            state.transact(async (unit) => {
              try {
                await state.queryInTransaction(unit, statement, [
                  installation.id,
                  actor.principalRef,
                  request.operationRef,
                ]);
              } catch (error) {
                deniedCode = error.code;
                throw error;
              }
              // If protection is absent, assertion failure rolls the mutation back.
              assert.fail("The application role must not modify retained preparation records.");
            }),
            (error) =>
              ["42501", "23514", "55000"].includes(deniedCode) &&
              (error instanceof ScopeViolationError || error.code === deniedCode),
          );
        }
        assert.deepEqual(await read(), original);
      });

      for (const statementPrefix of [
        "INSERT INTO occ.workload_profile_operations",
        "UPDATE occ.workload_profile_capacity",
      ]) {
        await t.test(`rollback after actual ${statementPrefix}`, async () => {
          const before = await snapshot();
          const input = inertProfileRequest({ namespaceId: namespace.id });
          const failure = new Error("Injected failure after completed PostgreSQL write");
          let injected = false;
          const faultPool = {
            async connect() {
              const client = await pool.connect();
              return new Proxy(client, {
                get(target, property) {
                  if (property === "query")
                    return async (...args) => {
                      const result = await target.query(...args);
                      if (
                        !injected &&
                        typeof args[0] === "string" &&
                        args[0].trimStart().startsWith(statementPrefix)
                      ) {
                        assert.equal(result.rowCount, 1);
                        injected = true;
                        throw failure;
                      }
                      return result;
                    };
                  const value = Reflect.get(target, property);
                  return typeof value === "function" ? value.bind(target) : value;
                },
              });
            },
          };
          // Every result comes from PostgreSQL; only a completed transport call fails.
          await assert.rejects(
            prepare(input, actor, new PostgresPlatformState(faultPool)),
            (error) => error === failure,
          );
          assert.equal(injected, true);
          assert.deepEqual(await snapshot(), before);
          assert.equal(await read({ ...locator, operationRef: input.operationRef }), undefined);
        });
      }

      await t.test(
        "lost prepare COMMIT acknowledgement recovers exact bytes in a fresh process",
        async () => {
          const proxy = await runtimeCommitAckProxy(databaseUrl);
          const faultPool = new pg.Pool({
            connectionString: proxy.url,
            max: 1,
            query_timeout: 5_000,
            connectionTimeoutMillis: 5_000,
          });
          faultPool.on("error", () => {});
          const input = inertProfileRequest({ namespaceId: namespace.id });
          const exact = { ...locator, operationRef: input.operationRef };
          let prepared;
          try {
            proxy.arm();
            await assert.rejects(
              profileTransaction(new PostgresPlatformState(faultPool), async (repository) => {
                prepared = await repository.prepareOperation(input, actor);
              }),
              PostgresCommitOutcomeUnknownError,
            );
            assert.equal(proxy.observedCommit, true);
            assert.deepEqual(await read(exact), prepared);
            assert.deepEqual(await freshProcessRead(exact), prepared);
            const before = await snapshot();
            assert.deepEqual(await prepare(input), prepared);
            assert.deepEqual(await snapshot(), before);
          } finally {
            await faultPool.end();
            await proxy.close();
          }
        },
      );

      await t.test(
        "Installation capacity admits one final contender and never allocates on overflow",
        async () => {
          let count = (await snapshot()).pending_ordinary_operations;
          for (; count < 31; count++)
            await prepare(inertProfileRequest({ namespaceId: namespace.id }));
          let allocations = 0;
          const allocator = {
            allocate: () => {
              allocations++;
              return randomUUID();
            },
          };
          const inputs = [0, 1].map(() => inertProfileRequest({ namespaceId: namespace.id }));
          const results = await Promise.allSettled(
            inputs.map((input) => prepare(input, actor, state, allocator)),
          );
          assert.equal(results.filter((value) => value.status === "fulfilled").length, 1);
          assert.ok(
            results.find((value) => value.status === "rejected").reason instanceof
              ProfileOperationCapacityError,
          );
          assert.equal(allocations, PROFILE_ALLOCATION_KINDS.length);
          assert.deepEqual(await snapshot(), {
            operations: 32,
            ordinary_operations: 32,
            pending_ordinary_operations: 32,
            terminal_slots: 0,
          });
          assert.deepEqual(
            await prepare(),
            original,
            "Exact replay remains available at capacity.",
          );
        },
      );
      t.diagnostic(
        "Real database coverage only when enabled; acceptance, terminal withdrawal and downstream authority remain unimplemented by this suite.",
      );
    },
  );
}
