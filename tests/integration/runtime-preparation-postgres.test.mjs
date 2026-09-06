import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";
import { canonicalRuntimeAuthorityMutationV1 } from "@openclaw-enterprise/contracts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/ports/transaction-errors.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import { exactRuntimeAuthorityOperation } from "../../packages/occ/src/runtime-authority/repository.ts";
import {
  canonicalRuntimePreparation,
  runtimePreparationDigest,
} from "../../packages/occ/src/runtime-preparation/types.ts";
import {
  copy,
  preparationWriter,
  seedPreparation,
  verifyRuntimePreparation,
  writablePreparationPlan,
} from "../fixtures/runtime-preparation.mjs";
import { profiles } from "../conformance/runtime-assignment-store.contract.mjs";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";

const url = process.env.OCC_RUNTIME_PREPARATION_DATABASE_URL;
const migratorUrl = process.env.OCC_RUNTIME_PREPARATION_MIGRATOR_DATABASE_URL;
const receiptPath = process.env.OCC_RUNTIME_PREPARATION_RESTART_RECEIPT;

async function verifyFreshProcess() {
  assert.ok(url, "A migrated application-role database is required for fresh-process readback.");
  assert.ok(receiptPath, "The original pre-restart receipt is required.");
  const expected = JSON.parse(await readFile(receiptPath, "utf8"));
  const pool = new pg.Pool({ connectionString: url });
  try {
    const store = new PostgresPlatformState(pool);
    const actual = await store.read(async (unit) => ({
      history: await unit.runtimePreparation.listHistory(expected.scope, expected.preparationRef),
      preparation: await unit.runtimePreparation.findPreparation(
        expected.scope,
        expected.preparationRef,
      ),
      operation: await unit.runtimePreparation.findOperation(expected.scope, expected.operationRef),
      assignment: await unit.runtimeAuthority.findAssignment(
        expected.scope,
        expected.assignmentRef,
      ),
      successor: await unit.runtimeAssignments.findRuntimeAllocation(expected.scope, {
        assignmentRef: expected.successor.assignmentRef,
      }),
    }));
    assert.equal(
      canonicalRuntimePreparation(actual),
      canonicalRuntimePreparation(expected.retained),
    );
    assert.equal(actual.preparation.localState, "closed");
    assert.equal(actual.preparation.retainedChildSequence, 1);
    assert.equal(actual.preparation.guard.admittedChildCutoff, 0);
    assert.equal(
      actual.preparation.bindingProposals[0].canonicalProposalJson,
      expected.originalProposalJson,
    );
    assert.deepEqual(
      actual.preparation.bindingProposals[0].operation,
      expected.originalAuthorityOperation,
    );
    assert.equal(actual.assignment.binding.status, "unbound");
    assert.equal(actual.successor.bindingCondition, "unbound");
    const {
      rows: [identity],
    } = await pool.query("SELECT current_user, pg_postmaster_start_time()::text AS started");
    assert.equal(identity.current_user, "occ_app");
    if (process.env.OCC_RUNTIME_PREPARATION_REQUIRE_DATABASE_RESTART === "1")
      assert.notEqual(
        identity.started,
        expected.databaseStarted,
        "A process-only reconnect is not a real database restart.",
      );
    process.stdout.write(
      JSON.stringify({
        mode: "fresh-process-readback",
        role: identity.current_user,
        databaseRestarted: identity.started !== expected.databaseStarted,
        operations: actual.history.length,
        localVersion: actual.preparation.localVersion,
        retainedChildren: actual.preparation.retainedChildSequence,
        admittedCutoff: actual.preparation.guard.admittedChildCutoff,
        localState: actual.preparation.localState,
        proposalDigest: runtimePreparationDigest(expected.originalProposalJson),
        exactOriginalLocator: true,
        assignmentBinding: actual.assignment.binding.status,
      }) + "\n",
    );
  } finally {
    await pool.end();
  }
}

async function runFreshProcess(path) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: {
      ...process.env,
      OCC_RUNTIME_PREPARATION_PROCESS_MODE: "readback",
      OCC_RUNTIME_PREPARATION_RESTART_RECEIPT: path,
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout.trim());
  assert.equal(result.exactOriginalLocator, true);
  return result;
}

async function crashProcess(mode) {
  assert.ok(url);
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const mutation = JSON.parse(input);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const store = new PostgresPlatformState(pool);
  await store.transact(async (unit) => {
    if (mode === "crash-after-retention")
      await unit.runtimePreparation.retain(mutation, preparationWriter);
    process.stdout.write(mode + "\n", () => process.kill(process.pid, "SIGKILL"));
    // The process is killed while the actual transaction still owns its connection.
    await new Promise(() => {});
  });
}

async function runCrashProcess(mode, mutation) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, OCC_RUNTIME_PREPARATION_PROCESS_MODE: mode },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15_000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(JSON.stringify(mutation));
  const ended = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(ended, { code: null, signal: "SIGKILL" }, stderr);
  assert.equal(stdout.trim(), mode);
}

const insertOperation = (pool, row) =>
  pool.query(
    `INSERT INTO occ.runtime_preparation_operations
   (operation_ref,preparation_ref,installation_id,namespace_id,agent_id,assignment_ref,
    local_version,operation_kind,child_effect_ref,binding_operation_ref,canonical_request,record)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [
      row.operation_ref,
      row.preparation_ref,
      row.installation_id,
      row.namespace_id,
      row.agent_id,
      row.assignment_ref,
      row.local_version,
      row.operation_kind,
      row.child_effect_ref,
      row.binding_operation_ref,
      row.canonical_request,
      JSON.stringify(row.record),
    ],
  );

function rowFor(mutation, localVersion, retainedChildSequence = 0) {
  const canonicalRequest = canonicalRuntimePreparation(mutation);
  return {
    operation_ref: mutation.operationRef,
    preparation_ref: mutation.preparationRef,
    installation_id: mutation.target.installationId,
    namespace_id: mutation.target.namespaceId,
    agent_id: mutation.target.agentId,
    assignment_ref: mutation.target.assignmentRef.id,
    local_version: localVersion,
    operation_kind: mutation.kind,
    child_effect_ref: mutation.kind === "retain-child" ? mutation.child.effect.effectRef : null,
    binding_operation_ref:
      mutation.kind === "retain-binding" ? mutation.operation.operationRef : null,
    canonical_request: canonicalRequest,
    record: {
      schemaVersion: 1,
      operationRef: mutation.operationRef,
      preparationRef: mutation.preparationRef,
      target: mutation.target,
      kind: mutation.kind,
      localVersion,
      retainedChildSequence,
      localState: mutation.kind === "close" ? mutation.reason : "open",
      guard: mutation.kind === "supersede-plan" ? mutation.nextGuard : mutation.guard,
      canonicalRequest,
      requestDigest: runtimePreparationDigest(canonicalRequest),
      attribution: preparationWriter,
    },
  };
}

const constraintFailure = (error) => ["23514", "23503", "23505", "23001"].includes(error.code);

async function rejectSql(pool, operation, matches = constraintFailure) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(operation(client), matches);
  } finally {
    // An unexpectedly accepted negative case must never change other test history.
    await client.query("ROLLBACK");
    client.release();
  }
}

if (process.env.OCC_RUNTIME_PREPARATION_PROCESS_MODE === "readback") {
  await verifyFreshProcess();
} else if (
  ["crash-before-retention", "crash-after-retention"].includes(
    process.env.OCC_RUNTIME_PREPARATION_PROCESS_MODE,
  )
) {
  await crashProcess(process.env.OCC_RUNTIME_PREPARATION_PROCESS_MODE);
} else {
  test(
    "runtime preparation: actual restricted PostgreSQL storage and protocol recovery",
    {
      skip: url
        ? false
        : "Set OCC_RUNTIME_PREPARATION_DATABASE_URL and OCC_RUNTIME_PREPARATION_MIGRATOR_DATABASE_URL for the isolated migrated PostgreSQL 18.6 database.",
      timeout: 300_000,
    },
    async (t) => {
      assert.ok(
        migratorUrl,
        "Migration catalog verification requires the separate migrator connection.",
      );
      const pool = new pg.Pool({ connectionString: url, max: 8 });
      const store = new PostgresPlatformState(pool);
      t.after(() => pool.end());

      await t.test(
        "real application role and installed migration catalog enforce the retained table",
        async () => {
          const {
            rows: [identity],
          } = await pool.query(
            "SELECT current_user, current_setting('server_version') AS version, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user",
          );
          assert.equal(identity.current_user, "occ_app");
          assert.match(identity.version, /^18\.6(?:\s|$)/);
          for (const flag of ["rolsuper", "rolcreatedb", "rolcreaterole", "rolbypassrls"])
            assert.equal(identity[flag], false);
          const {
            rows: [permissions],
          } = await pool.query(
            "SELECT has_table_privilege(current_user,'occ.runtime_preparation_operations','SELECT') AS read, has_table_privilege(current_user,'occ.runtime_preparation_operations','INSERT') AS append, has_table_privilege(current_user,'occ.runtime_preparation_operations','UPDATE') AS update, has_table_privilege(current_user,'occ.runtime_preparation_operations','DELETE') AS delete, has_table_privilege(current_user,'occ.runtime_preparation_operations','TRUNCATE') AS truncate",
          );
          assert.equal(permissions.read, true);
          assert.equal(permissions.append, true);
          const triggers = await pool.query(
            "SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid='occ.runtime_preparation_operations'::regclass AND NOT tgisinternal",
          );
          assert.ok(triggers.rows.length > 0);
          assert.ok(triggers.rows.every((row) => row.tgenabled === "O" || row.tgenabled === "A"));
          const constraints = await pool.query(
            "SELECT contype FROM pg_constraint WHERE conrelid='occ.runtime_preparation_operations'::regclass",
          );
          assert.ok(constraints.rows.some((row) => row.contype === "p"));
          assert.ok(constraints.rows.some((row) => row.contype === "f"));
          const migration = await readFile(
            new URL("../../migrations/0023_runtime_preparation.sql", import.meta.url),
          );
          const digest = createHash("sha256").update(migration).digest("hex");
          const catalogPool = new pg.Pool({ connectionString: migratorUrl });
          try {
            const catalog = await catalogPool.query(
              "SELECT hash FROM drizzle.__drizzle_migrations WHERE hash=$1",
              [digest],
            );
            assert.equal(catalog.rowCount, 1, "The exact new migration must have run.");
          } finally {
            await catalogPool.end();
          }
        },
      );

      await verifyRuntimePreparation(t, store);

      await t.test(
        "real process death before retention and before COMMIT leaves no retained operation",
        async () => {
          for (const mode of ["crash-before-retention", "crash-after-retention"]) {
            const f = await seedPreparation(store);
            await runCrashProcess(mode, f.plan);
            assert.equal(await f.operation(f.plan.operationRef), undefined);
            assert.equal(await f.record(), undefined);
            assert.equal((await f.assignment()).binding.status, "unbound");
            assert.equal((await f.head()).transitionRef, f.intent.transitionRef);
            // Reusing this preknown local locator proves rollback; it makes no
            // inference about submission or execution at an external provider.
            assert.equal((await f.append(f.plan)).status, "retained");
          }
        },
      );

      await t.test("checked-out independent clients race one retained version", async () => {
        const f = await seedPreparation(store);
        let arrived = 0;
        const barrier = Promise.withResolvers();
        const operations = [f.plan.operationRef, randomUUID()];
        const outcomes = await Promise.allSettled(
          operations.map((operationRef) =>
            store.transact(async (unit) => {
              if (++arrived === 2) barrier.resolve();
              await barrier.promise;
              return unit.runtimePreparation.retain({ ...f.plan, operationRef }, preparationWriter);
            }),
          ),
        );
        assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
        assert.equal((await f.history()).length, 1);
        assert.equal(
          await f.operation(
            operations[outcomes.findIndex((result) => result.status === "rejected")],
          ),
          undefined,
        );
      });

      await t.test("same operation ID across Agent locks commits one immutable owner", async () => {
        const a = await seedPreparation(store);
        const b = await seedPreparation(store);
        const operationRef = randomUUID();
        const outcomes = await Promise.allSettled([
          a.append({ ...a.plan, operationRef }),
          b.append({ ...b.plan, operationRef }),
        ]);
        assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
        assert.equal((await a.history()).length + (await b.history()).length, 1);
      });

      await t.test(
        "actual lock wait cancellation rolls back the waiting retention and releases custody",
        async () => {
          const f = await seedPreparation(store);
          const blocker = await pool.connect();
          const waitingPool = new pg.Pool({
            connectionString: url,
            max: 1,
            application_name: `preparation-wait-${randomUUID()}`,
          });
          const waitingStore = new PostgresPlatformState(waitingPool);
          let pending;
          try {
            await blocker.query("BEGIN");
            await blocker.query(
              "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR UPDATE",
              [f.target.namespaceId, f.target.agentId],
            );
            const {
              rows: [blockerIdentity],
            } = await blocker.query("SELECT pg_backend_pid() AS pid");
            pending = waitingStore.transact((unit) =>
              unit.runtimePreparation.retain(f.plan, preparationWriter),
            );
            pending.catch(() => {});
            let waitingPid;
            const deadline = Date.now() + 2500;
            while (Date.now() < deadline) {
              const result = await pool.query(
                "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))",
                [waitingPool.options.application_name, blockerIdentity.pid],
              );
              if (result.rows.length) {
                waitingPid = result.rows[0].pid;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.ok(
              waitingPid,
              "The actual second transaction must reach a PostgreSQL lock wait.",
            );
            const cancelled = await pool.query("SELECT pg_cancel_backend($1) AS cancelled", [
              waitingPid,
            ]);
            assert.equal(cancelled.rows[0].cancelled, true);
            await assert.rejects(pending, DependencyUnavailableError);
            await blocker.query("ROLLBACK");
            assert.equal(await f.record(), undefined);
            assert.equal(
              (
                await waitingStore.transact((unit) =>
                  unit.runtimePreparation.retain(f.plan, preparationWriter),
                )
              ).status,
              "retained",
            );
          } finally {
            await blocker.query("ROLLBACK");
            blocker.release();
            if (pending) await Promise.allSettled([pending]);
            await waitingPool.end();
          }
        },
      );

      await t.test(
        "restricted SQL cannot alter history or bypass ownership, bytes and transition invariants",
        async () => {
          const f = await seedPreparation(store);
          await f.append(f.plan);
          const before = await f.history();
          for (const sql of [
            "UPDATE occ.runtime_preparation_operations SET record='{}'::jsonb WHERE operation_ref=$1",
            "DELETE FROM occ.runtime_preparation_operations WHERE operation_ref=$1",
          ])
            await rejectSql(
              pool,
              (client) => client.query(sql, [f.plan.operationRef]),
              (error) => error.code === "42501" || error.code === "23001",
            );
          await rejectSql(
            pool,
            (client) => client.query("TRUNCATE occ.runtime_preparation_operations"),
            (error) => error.code === "42501" || error.code === "23001" || error.code === "0A000",
          );
          const valid = rowFor(f.child, 2, 1);
          for (const change of [
            (row) => {
              row.agent_id = `agt_${randomUUID()}`;
            },
            (row) => {
              row.assignment_ref = randomUUID();
            },
            (row) => {
              row.preparation_ref = randomUUID();
            },
            (row) => {
              row.local_version = 9;
            },
            (row) => {
              row.child_effect_ref = randomUUID();
            },
            (row) => {
              row.record.retainedChildSequence = 9;
            },
            (row) => {
              row.record.requestDigest = runtimePreparationDigest("changed");
            },
            (row) => {
              row.record.localState = "closed";
            },
            (row) => {
              row.record.attribution.extra = true;
            },
            (row) => {
              row.record.unexpectedAuthority = "current";
            },
          ]) {
            const row = copy(valid);
            change(row);
            await rejectSql(pool, (client) => insertOperation(client, row));
          }
          const canonical = valid.canonical_request;
          for (const value of [
            " " + canonical,
            JSON.stringify(JSON.parse(canonical), null, 2),
            canonical.replace('"schemaVersion":1', '"schemaVersion":1.0'),
            canonical.replace(
              '"kind":"retain-child"',
              '"kind":"retain-child","kind":"retain-child"',
            ),
          ]) {
            const row = copy(valid);
            row.canonical_request = value;
            row.record.canonicalRequest = value;
            row.record.requestDigest = runtimePreparationDigest(value);
            await rejectSql(pool, (client) => insertOperation(client, row));
          }
          for (const mutate of [
            (input) => {
              input.guard.gateVersion += 1;
            },
            (input) => {
              input.currentIntent.intentRef = randomUUID();
            },
            (input) => {
              input.child.canonicalRequestJson += " ";
            },
            (input) => {
              input.providerWireUtf8 += " ";
            },
            (input) => {
              input.child.providerWire.byteLength += 1;
            },
          ]) {
            const mutation = copy(f.child);
            mutate(mutation);
            await rejectSql(pool, (client) => insertOperation(client, rowFor(mutation, 2, 1)));
          }
          assert.deepEqual(await f.history(), before);
          await f.append(f.child);
          const binding = copy(await f.candidate());
          binding.proposal.expectedAssignmentRecordVersion = 2;
          binding.operation = exactRuntimeAuthorityOperation(binding.proposal);
          await rejectSql(pool, (client) => insertOperation(client, rowFor(binding, 3, 1)));
          assert.equal((await f.record()).bindingProposals.length, 0);

          const writable = await seedPreparation(store);
          for (const change of [
            (prior) => {
              prior.stores.push({
                ...copy(prior.workspaceStore),
                logicalStoreRef: "different-store",
              });
            },
            (prior) => {
              prior.stores = [{ ...copy(prior.workspaceStore), bindingRef: "different-binding" }];
            },
          ]) {
            const plan = writablePreparationPlan(writable);
            change(plan.preparation.priorWriterEvidence);
            await rejectSql(pool, (client) => insertOperation(client, rowFor(plan, 1)));
            assert.equal(await writable.record(), undefined);
          }
        },
      );

      await t.test(
        "real protocol COMMIT acknowledgment loss recovers only the preknown original binding proposal",
        async () => {
          const f = await seedPreparation(store);
          await f.append(f.plan);
          await f.append(f.child);
          const binding = await f.candidate();
          const originalProposalJson = canonicalRuntimeAuthorityMutationV1(binding.proposal);
          const originalAuthorityOperation = copy(binding.operation);
          const operationRef = binding.operationRef;
          assert.equal(await f.operation(operationRef), undefined);
          const proxy = await runtimeCommitAckProxy(url);
          const faultPool = new pg.Pool({
            connectionString: proxy.url,
            max: 1,
            connectionTimeoutMillis: 3000,
          });
          try {
            const faultStore = new PostgresPlatformState(faultPool);
            proxy.arm();
            await assert.rejects(
              faultStore.transact((unit) =>
                unit.runtimePreparation.retain(binding, preparationWriter),
              ),
              PostgresCommitOutcomeUnknownError,
            );
            assert.equal(proxy.observedCommit, true);
            const recovered = await f.operation(operationRef);
            assert.ok(recovered);
            assert.equal(recovered.canonicalRequest, canonicalRuntimePreparation(binding));
            assert.equal(
              (await f.record()).bindingProposals[0].canonicalProposalJson,
              originalProposalJson,
            );
            assert.deepEqual(
              (await f.record()).bindingProposals[0].operation,
              originalAuthorityOperation,
            );
            assert.equal((await f.assignment()).binding.status, "unbound");
            assert.deepEqual(f.representation.events, ["gate", "discover", "observe", "gate"]);
            const supersede = f.nextPlan(3);
            await f.append(supersede);
            const stopped = await f.advance();
            await f.append({
              ...f.close,
              expectedVersion: 4,
              guard: supersede.nextGuard,
              currentIntent: {
                intentRef: stopped.transitionRef,
                mode: stopped.desiredMode,
                lifecycleGeneration: stopped.generation,
              },
            });
            const running = await store.transact((unit) =>
              unit.runtimeAssignments.advanceRuntimeIntent(
                f.scope,
                2,
                { desiredMode: "running", revisionId: f.revision.id },
                randomUUID(),
                f.attribution,
              ),
            );
            const successor = await store.transact((unit) =>
              unit.runtimeAssignments.allocateUnboundRuntime(
                f.scope,
                running.generation,
                "harness",
                1,
                randomUUID(),
                profiles,
              ),
            );
            const retained = {
              history: await f.history(),
              preparation: await f.record(),
              operation: recovered,
              assignment: await f.assignment(),
              successor,
            };
            const {
              rows: [database],
            } = await pool.query("SELECT pg_postmaster_start_time()::text AS started");
            // The parent runs the same module after a real database restart. The
            // receipt carries original bytes and locators; recovery never reobserves.
            if (receiptPath) {
              await writeFile(
                receiptPath,
                JSON.stringify(
                  {
                    scope: f.scope,
                    preparationRef: f.plan.preparationRef,
                    operationRef,
                    assignmentRef: f.allocation.assignmentRef,
                    successor,
                    retained,
                    originalProposalJson,
                    originalAuthorityOperation,
                    databaseStarted: database.started,
                  },
                  null,
                  2,
                ) + "\n",
              );
              const readback = await runFreshProcess(receiptPath);
              assert.equal(readback.localVersion, 5);
            } else {
              assert.fail(
                "Set OCC_RUNTIME_PREPARATION_RESTART_RECEIPT to retain the mandatory fresh-process and restart evidence.",
              );
            }
            assert.equal((await f.append(binding)).status, "exact-replay");
            assert.deepEqual(await f.history(), retained.history);
          } finally {
            await faultPool.end();
            await proxy.close();
          }
        },
      );
    },
  );
}
