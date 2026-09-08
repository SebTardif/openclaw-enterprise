import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/errors.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { createPostgresTurnJournalReplayParticipant } from "../../packages/occ/src/state/postgres/turn-journal-replay.ts";
import { TurnJournalTransactionGuard } from "../../packages/occ/src/turn-journal/transaction-guard.ts";
import {
  REPLAY_BARRIER_CAPACITY_PER_INSTALLATION,
  digestReplayReservationTargetV1,
  encodeReplayReservationTargetV1,
  parseReplayReservationTargetV1,
} from "../../packages/occ/src/turn-journal/replay-barrier.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/ports/transaction-errors.ts";
import { createDevelopmentIAMState } from "../helpers/development-iam-state.mjs";
import {
  createTestAuthPrincipal,
  signInToControllerApp,
  authenticatedHeaders,
} from "../helpers/auth-session.mjs";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";

const databaseUrl = process.env.OCC_RESERVED_CHANNEL_CREATE_DATABASE_URL;
const options = {
  skip: databaseUrl
    ? false
    : "Set OCC_RESERVED_CHANNEL_CREATE_DATABASE_URL to a dedicated migrated loopback database with the limited occ_app role.",
  timeout: 120_000,
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const command = (state, prepared, currentness) =>
  state.transact((unit) =>
    unit.channelBindings.createReservedChannelInstallation(prepared, currentness),
  );

function validateDatabaseUrl(value) {
  const url = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/openclaw_reserved_channel_[a-z0-9_]+$/);
  assert.equal(decodeURIComponent(url.username), "occ_app");
  assert.equal(url.search, "", "connection query overrides are not accepted");
  assert.equal(url.hash, "");
  return decodeURIComponent(url.pathname.slice(1));
}

// This wraps actual pg clients only to schedule a specified boundary fault.
// Every delegated query executes on the real server. The explicitly labeled
// pre-delegation COMMIT case throws before that one call reaches pg.Client.
function observedPool(pool, { beforeQuery, afterQuery, queryFailure, releaseFailure } = {}) {
  return {
    options: pool.options,
    async connect() {
      const client = await pool.connect();
      return {
        on: (...args) => client.on(...args),
        removeListener: (...args) => client.removeListener(...args),
        async query(...args) {
          beforeQuery?.(args[0]);
          let result;
          try {
            result = await client.query(...args);
          } catch (error) {
            queryFailure?.(error);
            throw error;
          }
          await afterQuery?.(args[0], result);
          return result;
        },
        release(destroy) {
          client.release(destroy);
          if (releaseFailure) throw releaseFailure;
        },
      };
    },
  };
}

// Participant-only transaction fixture following the real replay schema suite:
// one borrowed application client, one actual lifetime and one original guard.
// It never commits fixture capacity or supplies complete-command authority.
async function rollbackParticipant(pool, installation, work) {
  const client = await pool.connect();
  const lifetime = new RepositoryTransactionLifetime();
  const guard = new TurnJournalTransactionGuard();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    const participant = createPostgresTurnJournalReplayParticipant({
      scope: { installationId: installation.id },
      query: client,
      transaction: lifetime,
      guard,
      currentInstallation: async () => {
        lifetime.assertActive();
        const result = await client.query("SELECT id,name,created_at FROM occ.installation");
        lifetime.assertActive();
        assert.equal(result.rows.length, 1);
        const row = result.rows[0];
        return { id: row.id, name: row.name, createdAt: row.created_at.toISOString() };
      },
    });
    const value = await lifetime.run(() => work({ client, participant }));
    await guard.finish();
    await lifetime.finish();
    await client.query("ROLLBACK");
    open = false;
    return value;
  } finally {
    try {
      await guard.finish().catch(() => {});
      await lifetime.finish();
      if (open) await client.query("ROLLBACK");
    } finally {
      guard.close();
      lifetime.close();
      client.release(true);
    }
  }
}

async function retained(pool, prepared) {
  const result = await pool.query(
    `SELECT
    (SELECT count(*)::integer FROM occ.channel_installations WHERE id=$1) AS parents,
    (SELECT count(*)::integer FROM occ.turn_journal_replay_heads WHERE channel_installation_id=$1) AS reservations,
    (SELECT count(*)::integer FROM occ.audit_events WHERE id=$2) AS audits`,
    [prepared.record.id, prepared.audit.id],
  );
  return result.rows[0];
}
const noRows = { parents: 0, reservations: 0, audits: 0 };

// All complete-command attempts originate in actual authenticated Fastify
// requests. Only the real channel service issues prepared/currentness identity;
// the trusted constructor collaborator schedules faults around the actual unit.
// The capacity subcase remains explicitly participant-only SQL coverage.
test(
  "service-owned reserved channel creation owns real PostgreSQL reservation, parent and audit",
  options,
  async (t) => {
    const database = validateDatabaseUrl(databaseUrl);
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 6,
      connectionTimeoutMillis: 1000,
    });
    t.after(() => pool.end());
    const identity = (
      await pool.query(
        "SELECT current_database() AS database, current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.deepEqual(identity, { database, role: "occ_app", rolsuper: false, rolbypassrls: false });
    const state = new PostgresPlatformState(pool);
    let installation = await state.loadInstallation();
    installation ??= {
      id: `ins_${randomUUID()}`,
      name: "Reserved channel integration",
      createdAt: new Date().toISOString(),
    };
    const { auth, seed, email, password } = await createTestAuthPrincipal({
      installationId: installation.id,
    });
    const policy = createDevelopmentIAMState(seed);
    if (await state.loadInstallation()) await state.seedNativeIAM(policy);
    else {
      state.setBootstrapNativeIAM(policy);
      await state.transact((unit) => unit.installations.createInstallation(installation));
    }
    const unavailable = { kind: "recovery-required", reason: "original-association-unavailable" };
    const input = () => ({
      platform: "slack",
      providerTenantRef: `tenant-${randomUUID()}`,
      recipientAppRef: "App α/one",
    });

    let session;
    async function run(scenario, { ownerState = state, body = input() } = {}) {
      // Both genuine Native IAM instances read persisted policy. Driver changes
      // use the actual controller selection API, never substitute currentness.
      const primary = new NativeIAMDriver(state, { id: "reserved-primary" });
      const alternate = new NativeIAMDriver(state, { id: "reserved-alternate" });
      const observed = { ownerState, body };
      let controller;
      controller = new OpenClawController(installation, {
        state: ownerState,
        recordOperations: false,
        reservedChannelInstallationCreate: {
          state: ownerState,
          async create(prepared, currentness) {
            observed.prepared = prepared;
            observed.currentness = currentness;
            try {
              const result = await scenario({
                ownerState,
                prepared,
                currentness,
                controller,
                changeIAM: () => controller.selectDriver("iam", alternate.id),
                restoreIAM: () => controller.selectDriver("iam", primary.id),
              });
              observed.result = result;
              return result;
            } catch (error) {
              observed.error = error;
              throw error;
            }
          },
        },
      });
      controller.registerDriver(primary);
      controller.registerDriver(alternate);
      controller.selectDriver("iam", primary.id);
      const app = createFastifyApp({
        controller,
        auth,
        iamDriver: primary,
        auditSink: state.auditSink,
        publicOrigin: "http://127.0.0.1",
        development: { enabled: true, installationId: installation.id },
      });
      try {
        await app.ready();
        // The same real auth instance verifies one issued session across these
        // requests. Repeated password sign-in is unrelated to command custody.
        session ??= await signInToControllerApp(app, { email, password });
        const response = await app.inject({
          method: "POST",
          url: "/api/channel-installations",
          payload: body,
          headers: { ...authenticatedHeaders(session), host: "127.0.0.1" },
        });
        observed.response = {
          status: response.statusCode,
          ...(response.body.length === 0 ? {} : response.json()),
        };
        assert.ok(observed.prepared, JSON.stringify(observed.response));
        return observed;
      } finally {
        await app.close();
      }
    }
    function assertFailed(observed, expected) {
      assert.ok(observed.response.status >= 400, JSON.stringify(observed.response));
      if (typeof expected === "function") assert.ok(observed.error instanceof expected);
      else assert.equal(observed.error, expected);
    }
    async function assertCreated(prepared, result) {
      assert.equal(result.kind, "created-provisional");
      assert.deepEqual(result.record, prepared.record);
      assert.deepEqual(Object.keys(result.locator).sort(), [
        "channelInstallationRef",
        "creationOperationRef",
        "originalTransactionRef",
        "reservationRef",
      ]);
      assert.equal(result.locator.channelInstallationRef, prepared.record.id);
      assert.equal(result.locator.creationOperationRef, prepared.creationOperationRef);
      assert.equal(result.locator.reservationRef, prepared.reservationRef);
      assert.equal(new Set(Object.values(result.locator)).size, 4);
      assert.deepEqual(await retained(pool, prepared), { parents: 1, reservations: 1, audits: 1 });
      const head = (
        await pool.query(
          "SELECT * FROM occ.turn_journal_replay_heads WHERE channel_installation_id=$1",
          [prepared.record.id],
        )
      ).rows[0];
      assert.deepEqual(head.target, {
        schemaVersion: 1,
        scope: { installationId: installation.id },
        channelInstallationRef: prepared.record.id,
        creationOperationRef: prepared.creationOperationRef,
        subject: { kind: "channel-installation" },
      });
      assert.equal(head.reservation_ref, result.locator.reservationRef);
      assert.equal(head.reservation_transaction_ref, result.locator.originalTransactionRef);
      assert.equal(head.state, "reserved");
      assert.equal(Number(head.record_version), 1);
      for (const key of ["namespace_id", "agent_id", "lineage_ref", "activated_target"])
        assert.equal(head[key], null);
      const audit = (await state.transact((unit) => unit.audit.list())).find(
        (event) => event.id === prepared.audit.id,
      );
      assert.deepEqual(audit, {
        ...prepared.audit,
        details: {
          ...prepared.audit.details,
          reservedChannelCreation: { schemaVersion: 1, ...result.locator },
        },
      });
    }
    const dataQueries = (statements) =>
      statements.filter((sql) => !["BEGIN", "COMMIT", "ROLLBACK"].includes(sql));
    let originalCommitted;

    await t.test(
      "genuine service creation stays invisible until commit and reopens exactly",
      async () => {
        const ready = Promise.withResolvers(),
          resume = Promise.withResolvers();
        let prepared;
        const pending = run(({ ownerState, prepared: original, currentness }) => {
          prepared = original;
          return ownerState.transact(async (unit) => {
            const result = await unit.channelBindings.createReservedChannelInstallation(
              original,
              currentness,
            );
            ready.resolve();
            await resume.promise;
            return result;
          });
        });
        pending.then((result) => {
          if (result.response.status !== 201)
            ready.reject(new Error(JSON.stringify(result.response)));
        }, ready.reject);
        try {
          await ready.promise;
          assert.deepEqual(await retained(pool, prepared), noRows);
        } finally {
          resume.resolve();
        }
        const observed = await pending;
        assert.equal(observed.response.status, 201, JSON.stringify(observed.response));
        assert.deepEqual(observed.response.data, prepared.record);
        await assertCreated(prepared, observed.result);
        originalCommitted = { prepared, locator: observed.result.locator };
        const freshPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
        try {
          assert.deepEqual(
            await new PostgresPlatformState(freshPool).read((view) =>
              view.channelBindings.findChannelInstallation(prepared.record.id),
            ),
            prepared.record,
          );
        } finally {
          await freshPool.end();
        }
        // An ended service invocation cannot renew its consumed original identity.
        assert.deepEqual(await command(state, prepared, observed.currentness), unavailable);
        assert.deepEqual(await retained(pool, prepared), {
          parents: 1,
          reservations: 1,
          audits: 1,
        });
      },
    );
    await t.test(
      "actual replay participant returns existing and exhausts finite capacity without retaining fixture rows",
      async () => {
        assert.ok(originalCommitted, "the earlier actual complete command must have committed");
        const { prepared, locator } = originalCommitted;
        const target = parseReplayReservationTargetV1({
          schemaVersion: 1,
          scope: { installationId: installation.id },
          channelInstallationRef: prepared.record.id,
          creationOperationRef: locator.creationOperationRef,
          subject: { kind: "channel-installation" },
        });
        const originalInput = {
          target,
          reservationRef: locator.reservationRef,
          originalTransactionRef: locator.originalTransactionRef,
        };
        // audit_events belongs to the selected singleton database and has no
        // installation_id column; this exclusively allocated DB uses its total.
        const countSql = `SELECT
        (SELECT count(*)::integer FROM occ.turn_journal_replay_heads WHERE installation_id=$1) AS heads,
        (SELECT count(*)::integer FROM occ.channel_installations WHERE installation_id=$1) AS parents,
        (SELECT count(*)::integer FROM occ.audit_events) AS audits`;
        const snapshot = async (query) => ({
          counts: (await query.query(countSql, [installation.id])).rows[0],
          head: (
            await query.query(
              "SELECT * FROM occ.turn_journal_replay_heads WHERE installation_id=$1 AND reservation_ref=$2",
              [installation.id, locator.reservationRef],
            )
          ).rows[0],
        });
        const before = await snapshot(pool);
        try {
          // The actual retained correlation reaches the participant's existing
          // branch. Ended service custody cannot be reused by a complete command;
          // this internal participant retry is not service idempotency evidence.
          await rollbackParticipant(pool, installation, async ({ client, participant }) => {
            assert.deepEqual(await participant.reserveCapacity(originalInput), {
              kind: "existing",
              record: {
                target,
                activatedTarget: null,
                reservationRef: locator.reservationRef,
                originalTransactionRef: locator.originalTransactionRef,
                capacitySlot: Number(before.head.capacity_slot),
                state: "reserved",
                recordVersion: 1,
                lineage: null,
              },
            });
            assert.deepEqual(await snapshot(client), before);
          });
          // A distinct target needs its own original participant lock prefix.
          await rollbackParticipant(pool, installation, async ({ client, participant }) => {
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              `turn-journal-admission:${installation.id}`,
            ]);
            const parents = await client.query(
              'SELECT id FROM occ.channel_installations WHERE installation_id=$1 AND id=ANY($2::text[]) ORDER BY id COLLATE "C" FOR UPDATE',
              [installation.id, [prepared.record.id]],
            );
            assert.deepEqual(parents.rows, [{ id: prepared.record.id }]);
            assert.equal(REPLAY_BARRIER_CAPACITY_PER_INSTALLATION, 10_000);
            const slots = (
              await client.query(
                `SELECT candidate AS slot FROM generate_series(1,$2::integer) candidate
            WHERE NOT EXISTS (SELECT 1 FROM occ.turn_journal_replay_heads h WHERE h.installation_id=$1 AND h.capacity_slot=candidate)
            ORDER BY candidate`,
                [installation.id, REPLAY_BARRIER_CAPACITY_PER_INSTALLATION],
              )
            ).rows;
            assert.equal(
              slots.length,
              REPLAY_BARRIER_CAPACITY_PER_INSTALLATION - before.counts.heads,
            );
            // Every seeded row is a valid pending channel reservation anchored to
            // the genuine existing parent. Canonical encoders supply the target and
            // digest; SQL constraints validate all rows. No activation is seeded.
            const seeds = slots.map(({ slot }) => {
              const seedTarget = parseReplayReservationTargetV1({
                ...target,
                creationOperationRef: `capacity-create:${randomUUID()}`,
              });
              return {
                capacity_slot: slot,
                target_key: digestReplayReservationTargetV1(seedTarget),
                target: JSON.parse(encodeReplayReservationTargetV1(seedTarget)),
                reservation_ref: `capacity-reservation:${randomUUID()}`,
                reservation_transaction_ref: `capacity-tx:${randomUUID()}`,
              };
            });
            const inserted = await client.query(
              `INSERT INTO occ.turn_journal_replay_heads
            (installation_id,namespace_id,agent_id,channel_installation_id,target_key,target,capacity_slot,reservation_ref,reservation_transaction_ref,state,record_version,lineage_ref,lineage_version,activated_target,activated_target_key)
            SELECT $1,NULL,NULL,$2,v.target_key,v.target,v.capacity_slot,v.reservation_ref,v.reservation_transaction_ref,'reserved',1,NULL,NULL,NULL,NULL
            FROM jsonb_to_recordset($3::jsonb) AS v(target_key text,target jsonb,capacity_slot integer,reservation_ref text,reservation_transaction_ref text)`,
              [installation.id, prepared.record.id, JSON.stringify(seeds)],
            );
            assert.equal(inserted.rowCount, seeds.length);
            // Execute the real deferred parent/completeness checks before rollback.
            await client.query("SET CONSTRAINTS ALL IMMEDIATE");
            const full = await snapshot(client);
            assert.deepEqual(full.counts, {
              ...before.counts,
              heads: REPLAY_BARRIER_CAPACITY_PER_INSTALLATION,
            });
            assert.deepEqual(full.head, before.head);
            const fresh = {
              target: parseReplayReservationTargetV1({
                ...target,
                creationOperationRef: `exhausted-create:${randomUUID()}`,
              }),
              reservationRef: `exhausted-reservation:${randomUUID()}`,
              originalTransactionRef: `exhausted-tx:${randomUUID()}`,
            };
            assert.deepEqual(await participant.reserveCapacity(fresh), {
              kind: "capacity-exhausted",
            });
            assert.deepEqual(
              await snapshot(client),
              full,
              "capacity exhaustion changes no head, parent or audit count",
            );
          });
        } finally {
          const freshPool = new pg.Pool({
            connectionString: databaseUrl,
            max: 1,
            connectionTimeoutMillis: 1000,
          });
          try {
            assert.deepEqual(
              await snapshot(freshPool),
              before,
              "all capacity fixture rows must roll back, preserving the original retained record",
            );
          } finally {
            await freshPool.end();
          }
        }
      },
    );

    await t.test(
      "service-issued immutable input survives an early outer callback return",
      async () => {
        const observed = await run(async ({ ownerState, prepared, currentness }) => {
          assert.ok(Object.isFrozen(prepared));
          assert.ok(Object.isFrozen(prepared.record));
          assert.ok(Object.isFrozen(prepared.audit.details.current));
          const original = plain(prepared);
          let operation;
          const outer = await ownerState.transact((unit) => {
            operation = unit.channelBindings.createReservedChannelInstallation(
              prepared,
              currentness,
            );
            assert.equal(Reflect.set(prepared.record, "providerTenantRef", "replacement"), false);
            assert.equal(Reflect.set(prepared.audit.details.current, "version", 91), false);
            assert.equal(
              Reflect.set(prepared, "creationOperationRef", `replacement:${randomUUID()}`),
              false,
            );
            return "early callback return";
          });
          assert.equal(outer, "early callback return");
          assert.deepEqual(prepared, original);
          return operation;
        });
        assert.equal(observed.response.status, 201, JSON.stringify(observed.response));
        await assertCreated(observed.prepared, observed.result);
      },
    );

    await t.test(
      "rollback consumes original service custody and retry starts no data query",
      async () => {
        const failure = new Error("original service transaction refused commit");
        const statements = [];
        const ownerState = new PostgresPlatformState(
          observedPool(pool, { beforeQuery: (sql) => statements.push(sql) }),
        );
        const observed = await run(
          ({ ownerState, prepared, currentness }) =>
            ownerState.transact(async (unit) => {
              await unit.channelBindings.createReservedChannelInstallation(prepared, currentness);
              throw failure;
            }),
          { ownerState },
        );
        assertFailed(observed, failure);
        assert.deepEqual(await retained(pool, observed.prepared), noRows);
        statements.length = 0;
        assert.deepEqual(
          await command(ownerState, observed.prepared, observed.currentness),
          unavailable,
        );
        assert.deepEqual(dataQueries(statements), []);
        assert.deepEqual(await retained(pool, observed.prepared), noRows);
      },
    );

    await t.test(
      "actual duplicate audit error rolls back service reservation and parent when caught",
      async () => {
        let originalQueryFailure, caught;
        const ownerState = new PostgresPlatformState(
          observedPool(pool, {
            queryFailure(error) {
              originalQueryFailure = error;
            },
          }),
        );
        const observed = await run(
          async ({ ownerState, prepared, currentness }) => {
            // The actual service generated this audit. A separate fixture transaction
            // retains its ID to exercise the real same-client duplicate-key failure.
            await state.transact((unit) => unit.audit.append(prepared.audit));
            return ownerState.transact(async (unit) => {
              try {
                return await unit.channelBindings.createReservedChannelInstallation(
                  prepared,
                  currentness,
                );
              } catch (error) {
                caught = error;
              }
            });
          },
          { ownerState },
        );
        assertFailed(observed, ResourceConflictError);
        assert.equal(caught, originalQueryFailure);
        assert.equal(caught.code, "23505");
        assert.deepEqual(await retained(pool, observed.prepared), { ...noRows, audits: 1 });
      },
    );

    await t.test(
      "two genuine requests with the same parent tuple retain one complete winner",
      async () => {
        const body = input();
        const create = ({ ownerState, prepared, currentness }) =>
          command(ownerState, prepared, currentness);
        const winner = await run(create, { body });
        assert.equal(winner.response.status, 201, JSON.stringify(winner.response));
        const loser = await run(create, { body });
        assertFailed(loser, ResourceConflictError);
        assert.notEqual(loser.prepared, winner.prepared);
        assert.notEqual(loser.prepared.record.id, winner.prepared.record.id);
        assert.deepEqual(await retained(pool, loser.prepared), noRows);
        await assertCreated(winner.prepared, winner.result);
      },
    );

    for (const stage of ["reservation", "parent", "audit"]) {
      await t.test(
        `actual selected driver change after real ${stage} insertion rolls back every row`,
        async () => {
          const table = {
            reservation: "turn_journal_replay_heads",
            parent: "channel_installations",
            audit: "audit_events",
          }[stage];
          let changeIAM,
            changed = false;
          const ownerState = new PostgresPlatformState(
            observedPool(pool, {
              afterQuery(sql) {
                if (new RegExp(`INSERT INTO occ\\.${table}\\b`).test(sql)) {
                  changed = true;
                  changeIAM();
                }
              },
            }),
          );
          const observed = await run(
            async (context) => {
              changeIAM = context.changeIAM;
              try {
                return await command(context.ownerState, context.prepared, context.currentness);
              } finally {
                context.restoreIAM();
              }
            },
            { ownerState },
          );
          assert.equal(changed, true);
          assertFailed(observed, DependencyUnavailableError);
          assert.deepEqual(await retained(pool, observed.prepared), noRows);
        },
      );
    }

    await t.test(
      "final original currentness fence sees a genuine driver selection change",
      async () => {
        const observed = await run(async (context) => {
          try {
            return await context.ownerState.transact(async (unit) => {
              const result = await unit.channelBindings.createReservedChannelInstallation(
                context.prepared,
                context.currentness,
              );
              assert.equal(result.kind, "created-provisional");
              context.changeIAM();
              return result;
            });
          } finally {
            context.restoreIAM();
          }
        });
        assertFailed(observed, DependencyUnavailableError);
        assert.deepEqual(await retained(pool, observed.prepared), noRows);
      },
    );

    await t.test(
      "original currentness blocks later participant queries after a genuine driver switch at the installation lock",
      async () => {
        let changeIAM,
          changed = false,
          laterQueries = 0;
        const ownerState = new PostgresPlatformState(
          observedPool(pool, {
            beforeQuery(sql) {
              if (changed && !["ROLLBACK", "COMMIT"].includes(sql)) laterQueries++;
            },
            afterQuery(sql) {
              if (sql.startsWith("SELECT pg_advisory_xact_lock(")) {
                changed = true;
                changeIAM();
              }
            },
          }),
        );
        const observed = await run(
          async (context) => {
            changeIAM = context.changeIAM;
            try {
              return await command(context.ownerState, context.prepared, context.currentness);
            } finally {
              context.restoreIAM();
            }
          },
          { ownerState },
        );
        assertFailed(observed, DependencyUnavailableError);
        assert.equal(changed, true);
        assert.equal(laterQueries, 0);
        assert.deepEqual(await retained(pool, observed.prepared), noRows);
      },
    );

    for (const kind of ["cloned prepared", "wrong currentness", "foreign state"]) {
      await t.test(`${kind} cannot borrow an active genuine service attempt`, async () => {
        const statements = [];
        const ownerState = new PostgresPlatformState(
          observedPool(pool, { beforeQuery: (sql) => statements.push(sql) }),
        );
        const foreignState = new PostgresPlatformState(
          observedPool(pool, { beforeQuery: (sql) => statements.push(sql) }),
        );
        let invoked = false;
        const observed = await run(
          (context) =>
            command(
              kind === "foreign state" ? foreignState : ownerState,
              kind === "cloned prepared" ? plain(context.prepared) : context.prepared,
              kind === "wrong currentness"
                ? {
                    assertSelectedIAM() {
                      invoked = true;
                      return Promise.resolve();
                    },
                  }
                : context.currentness,
            ),
          { ownerState },
        );
        assert.deepEqual(observed.result, unavailable);
        assert.equal(observed.response.status, 503, JSON.stringify(observed.response));
        assert.equal(invoked, false);
        assert.deepEqual(dataQueries(statements), []);
        assert.equal(ownerState.channelFirstCreateFailureLocatorV1(observed.result), undefined);
        assert.deepEqual(await retained(pool, observed.prepared), noRows);
      });
    }

    await t.test(
      "an unused original prepared object expires when its genuine service invocation closes",
      async () => {
        const statements = [],
          failure = new Error("constructor transport failed before command entry");
        const ownerState = new PostgresPlatformState(
          observedPool(pool, { beforeQuery: (sql) => statements.push(sql) }),
        );
        const observed = await run(
          () => {
            throw failure;
          },
          { ownerState },
        );
        assertFailed(observed, failure);
        assert.deepEqual(statements, []);
        assert.deepEqual(
          await command(ownerState, observed.prepared, observed.currentness),
          unavailable,
        );
        assert.deepEqual(dataQueries(statements), []);
        assert.deepEqual(await retained(pool, observed.prepared), noRows);
      },
    );

    for (const timing of ["prior", "concurrent", "after-completion"]) {
      await t.test(
        `${timing} outward Installation read poisons the service-owned isolated command`,
        async () => {
          const observed = await run(({ ownerState, prepared, currentness }) =>
            ownerState.transact(async (unit) => {
              if (timing === "prior") await unit.installations.getInstallation();
              const operation = unit.channelBindings.createReservedChannelInstallation(
                prepared,
                currentness,
              );
              void operation.catch(() => {});
              if (timing === "after-completion") await operation;
              if (timing !== "prior") await unit.installations.getInstallation();
              return operation;
            }),
          );
          assertFailed(observed, ScopeViolationError);
          assert.deepEqual(await retained(pool, observed.prepared), noRows);
        },
      );
    }

    await t.test(
      "controlled pre-delegation COMMIT failure leaves no head and cannot renew original or cloned custody",
      async () => {
        const statements = [];
        const failure = Object.assign(
          new Error("controlled connection failure before COMMIT delegation"),
          { code: "ECONNRESET" },
        );
        let inject = true,
          provisional;
        const ownerState = new PostgresPlatformState(
          observedPool(pool, {
            beforeQuery(sql) {
              statements.push(sql);
              if (sql === "COMMIT" && inject) {
                inject = false;
                throw failure;
              }
            },
          }),
        );
        const observed = await run(
          ({ prepared, currentness }) =>
            ownerState.transact(async (unit) => {
              provisional = await unit.channelBindings.createReservedChannelInstallation(
                prepared,
                currentness,
              );
              assert.equal(provisional.kind, "created-provisional");
              return provisional;
            }),
          { ownerState },
        );
        // The owner has marked COMMIT sent when this controlled transport rejects.
        // The peer knows delegation never happened; the conservative public owner
        // still reports unknown. Real ROLLBACK removes all three inserted stages.
        assertFailed(observed, PostgresCommitOutcomeUnknownError);
        assert.equal(inject, false);
        assert.ok(statements.includes("ROLLBACK"));
        assert.deepEqual(
          ownerState.channelFirstCreateFailureLocatorV1(observed.error),
          provisional.locator,
        );
        const freshPool = new pg.Pool({
          connectionString: databaseUrl,
          max: 1,
          connectionTimeoutMillis: 1000,
        });
        try {
          assert.deepEqual(await retained(freshPool, observed.prepared), noRows);
        } finally {
          await freshPool.end();
        }
        // Neither the ended original identity nor an equal clone can use the
        // absence of a committed head to manufacture a replacement reservation.
        for (const prepared of [observed.prepared, plain(observed.prepared)]) {
          statements.length = 0;
          const refused = await command(ownerState, prepared, observed.currentness);
          assert.deepEqual(refused, unavailable);
          assert.deepEqual(dataQueries(statements), []);
          assert.equal(ownerState.channelFirstCreateFailureLocatorV1(refused), undefined);
          assert.deepEqual(await retained(pool, observed.prepared), noRows);
        }
      },
    );

    await t.test(
      "lost real COMMIT acknowledgment retains the original locator and cannot renew service custody",
      async () => {
        const proxy = await runtimeCommitAckProxy(databaseUrl);
        const faultPool = new pg.Pool({
          connectionString: proxy.url,
          max: 1,
          connectionTimeoutMillis: 1000,
        });
        const statements = [];
        const ownerState = new PostgresPlatformState(
          observedPool(faultPool, { beforeQuery: (sql) => statements.push(sql) }),
        );
        let provisional;
        try {
          const observed = await run(
            async ({ prepared, currentness }) => {
              proxy.arm();
              return ownerState.transact(async (unit) => {
                provisional = await unit.channelBindings.createReservedChannelInstallation(
                  prepared,
                  currentness,
                );
                return provisional;
              });
            },
            { ownerState },
          );
          assertFailed(observed, PostgresCommitOutcomeUnknownError);
          assert.equal(proxy.observedCommit, true);
          assert.deepEqual(
            ownerState.channelFirstCreateFailureLocatorV1(observed.error),
            provisional.locator,
          );
          await assertCreated(observed.prepared, provisional);
          statements.length = 0;
          assert.deepEqual(
            await command(ownerState, observed.prepared, observed.currentness),
            unavailable,
          );
          assert.deepEqual(dataQueries(statements), []);
          await assertCreated(observed.prepared, provisional);
        } finally {
          await faultPool.end();
          await proxy.close();
        }
      },
    );

    await t.test(
      "post-acknowledgment cleanup failure preserves the service-origin committed locator",
      async () => {
        const failure = new Error("controlled cleanup failure after real client release");
        const ownerState = new PostgresPlatformState(
          observedPool(pool, { releaseFailure: failure }),
        );
        let provisional;
        const observed = await run(
          ({ prepared, currentness }) =>
            ownerState.transact(async (unit) => {
              provisional = await unit.channelBindings.createReservedChannelInstallation(
                prepared,
                currentness,
              );
              return provisional;
            }),
          { ownerState },
        );
        assertFailed(observed, PostgresCommitOutcomeUnknownError);
        assert.deepEqual(
          ownerState.channelFirstCreateFailureLocatorV1(observed.error),
          provisional.locator,
        );
        await assertCreated(observed.prepared, provisional);
      },
    );
  },
);
