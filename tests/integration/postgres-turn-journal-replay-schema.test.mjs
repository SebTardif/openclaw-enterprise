import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { createPostgresChannelBindingRepository } from "../../packages/occ/src/state/postgres/channel-bindings.ts";
import { createPostgresTurnJournalReplayParticipant } from "../../packages/occ/src/state/postgres/turn-journal-replay.ts";
import { TurnJournalTransactionGuard } from "../../packages/occ/src/turn-journal/transaction-guard.ts";
import {
  digestReplayReservationTargetV1,
  parseReplayReservationTargetV1,
} from "../../packages/occ/src/turn-journal/replay-barrier.ts";

const databaseUrl = process.env.OCC_REPLAY_SCHEMA_DATABASE_URL;
const tables = [
  "turn_journal_replay_heads",
  "turn_journal_replay_lineage",
  "turn_journal_retired_identities",
  "turn_journal_retirement_publications",
  "turn_journal_retirement_observations",
];
const reference = (prefix) => `${prefix}:${randomUUID()}`;

function reservation(installationId) {
  return {
    target: parseReplayReservationTargetV1({
      schemaVersion: 1,
      scope: { installationId },
      channelInstallationRef: `chi_${randomUUID()}`,
      creationOperationRef: reference("channel-create"),
      subject: { kind: "channel-installation" },
    }),
    reservationRef: reference("reservation"),
    originalTransactionRef: reference("transaction"),
  };
}

function channelRecord(input) {
  const at = new Date().toISOString();
  return {
    id: input.target.channelInstallationRef,
    installationId: input.target.scope.installationId,
    version: 1,
    status: "enabled",
    createdAt: at,
    updatedAt: at,
    createdBy: "replay-schema-fixture",
    updatedBy: "replay-schema-fixture",
    platform: "slack",
    providerTenantRef: reference("metadata-tenant"),
    recipientAppRef: reference("metadata-app"),
  };
}

// This is a SQL participant fixture, not the absent complete channel command.
// Both real repositories borrow one client and the real lifetime/guard. No IAM,
// native authentication, audit, clock or activation producer is manufactured.
async function transaction(pool, installation, work, commit = false) {
  const client = await pool.connect();
  const lifetime = new RepositoryTransactionLifetime();
  const guard = new TurnJournalTransactionGuard();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    const context = {
      scope: { installationId: installation.id },
      query: client,
      transaction: lifetime,
      guard,
      currentInstallation: async () => {
        lifetime.assertActive();
        const { rows } = await client.query("SELECT id,name,created_at FROM occ.installation");
        lifetime.assertActive();
        assert.equal(rows.length, 1);
        return {
          id: rows[0].id,
          name: rows[0].name,
          createdAt: rows[0].created_at.toISOString(),
        };
      },
    };
    const participant = createPostgresTurnJournalReplayParticipant(context);
    const channels = createPostgresChannelBindingRepository(context);
    const value = await lifetime.run(() => work({ client, participant, channels }));
    await guard.finish();
    await lifetime.finish();
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    open = false;
    return value;
  } finally {
    // Rollback also runs after deferred COMMIT rejection; the raw connection is
    // discarded so the next transaction/readback uses a fresh PostgreSQL client.
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

async function rejectSql(client, statement, parameters, code, constraint) {
  // These negatives exercise PostgreSQL directly. A savepoint isolates each
  // rejected constraint/privilege write without weakening the participant guard.
  await client.query("SAVEPOINT rejected_write");
  try {
    await assert.rejects(client.query(statement, parameters), (error) => {
      assert.equal(error.code, code);
      if (constraint) assert.equal(error.constraint, constraint);
      return true;
    });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT rejected_write");
    await client.query("RELEASE SAVEPOINT rejected_write");
  }
}

function headRow(input, capacitySlot) {
  return {
    installation_id: input.target.scope.installationId,
    namespace_id: null,
    agent_id: null,
    channel_installation_id: input.target.channelInstallationRef,
    target_key: digestReplayReservationTargetV1(input.target),
    target: input.target,
    activated_target: null,
    activated_target_key: null,
    capacity_slot: capacitySlot,
    reservation_ref: input.reservationRef,
    reservation_transaction_ref: input.originalTransactionRef,
    state: "reserved",
    record_version: 1,
    lineage_ref: null,
    lineage_version: null,
  };
}

async function rejectHead(client, row, code, constraint) {
  const columns = Object.keys(row);
  await rejectSql(
    client,
    `INSERT INTO occ.turn_journal_replay_heads (${columns.join(",")})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})`,
    Object.values(row),
    code,
    constraint,
  );
}

async function assertAbsent(pool, input, otherChannelId) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*) FROM occ.turn_journal_replay_heads
        WHERE installation_id=$1 AND reservation_ref=$2)::integer AS heads,
       (SELECT count(*) FROM occ.channel_installations
        WHERE installation_id=$1 AND id=ANY($3::text[]))::integer AS parents`,
    [
      input.target.scope.installationId,
      input.reservationRef,
      [input.target.channelInstallationRef, ...(otherChannelId ? [otherChannelId] : [])],
    ],
  );
  assert.deepEqual(result.rows, [{ heads: 0, parents: 0 }]);
}

test(
  "PostgreSQL replay schema: reserved capacity and closed activation boundaries",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_REPLAY_SCHEMA_DATABASE_URL to a dedicated migrated occ_app replay schema database.",
    timeout: 60_000,
  },
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 1_000,
      statement_timeout: 5_000,
      lock_timeout: 2_000,
      idle_in_transaction_session_timeout: 10_000,
    });
    try {
      // Refuse an ordinary development database or an elevated test connection
      // before creating any fixture. Migrations are prepared outside this suite.
      const { rows: roles } = await pool.query(
        `SELECT current_database() AS database, current_user AS name,
          session_user AS session_name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
         FROM pg_roles WHERE rolname=current_user`,
      );
      assert.match(roles[0].database, /^openclaw_replay_/);
      assert.deepEqual(
        { ...roles[0], database: undefined },
        {
          database: undefined,
          name: "occ_app",
          session_name: "occ_app",
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
        },
      );
      const membership = await pool.query(
        `SELECT rolname FROM pg_roles WHERE oid<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
         AND pg_has_role(current_user,oid,'MEMBER')`,
      );
      assert.deepEqual(membership.rows, [], "The fixture role must not inherit another role.");
      const owners = await pool.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='occ' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
         UNION ALL SELECT nspname FROM pg_namespace
         WHERE nspname='occ' AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
         UNION ALL SELECT datname FROM pg_database
         WHERE datname=current_database() AND datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user)`,
      );
      assert.deepEqual(owners.rows, [], "occ_app must not own the database, schema or relations.");

      await t.test("effective grants permit only reservation insert and locking", async () => {
        for (const table of tables) {
          const qualified = `occ.${table}`;
          const { rows } = await pool.query(
            `SELECT has_table_privilege(current_user,$1,'SELECT') AS read,
              has_table_privilege(current_user,$1,'INSERT') AS insert,
              has_table_privilege(current_user,$1,'UPDATE') AS update,
              has_table_privilege(current_user,$1,'DELETE') AS delete,
              has_table_privilege(current_user,$1,'TRUNCATE') AS truncate,
              has_table_privilege(current_user,$1,'REFERENCES') AS references,
              has_table_privilege(current_user,$1,'TRIGGER') AS trigger`,
            [qualified],
          );
          assert.deepEqual(rows[0], {
            read: true,
            insert: table === tables[0],
            update: false,
            delete: false,
            truncate: false,
            references: false,
            trigger: false,
          });
          const columns = await pool.query(
            `SELECT attname,
              has_column_privilege(current_user,attrelid,attnum,'INSERT') AS insert,
              has_column_privilege(current_user,attrelid,attnum,'UPDATE') AS update,
              has_column_privilege(current_user,attrelid,attnum,'REFERENCES') AS references
             FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped`,
            [qualified],
          );
          assert.ok(columns.rows.length > 0);
          for (const column of columns.rows) {
            assert.equal(column.insert, table === tables[0], `${table}.${column.attname} INSERT`);
            assert.equal(
              column.update,
              table === tables[0] && column.attname === "record_version",
              `${table}.${column.attname} UPDATE`,
            );
            assert.equal(column.references, false);
          }
        }
      });

      // Metadata-only fixture: no admitted revision, native envelope or external
      // provider is needed to exercise a pending channel capacity reservation.
      await pool.query(
        "INSERT INTO occ.installation(id,name,created_at) VALUES ($1,$2,now()) ON CONFLICT DO NOTHING",
        [`ins_${randomUUID()}`, "Replay schema integration"],
      );
      const installations = await pool.query("SELECT id,name,created_at FROM occ.installation");
      assert.equal(installations.rows.length, 1);
      const installation = installations.rows[0];
      const committed = reservation(installation.id);
      let original;

      await t.test(
        "reserve precedes parent insert and survives COMMIT with exact readback",
        async () => {
          original = await transaction(
            pool,
            installation,
            async ({ client, participant, channels }) => {
              const before = await channels.findChannelInstallation(
                committed.target.channelInstallationRef,
              );
              assert.equal(before, undefined);
              const result = await participant.reserveCapacity(committed);
              assert.equal(result.kind, "reserved");
              assert.equal(result.record.state, "reserved");
              assert.equal(result.record.recordVersion, 1);
              assert.equal(result.record.activatedTarget, null);
              assert.equal(result.record.lineage, null);
              assert.deepEqual(result.record.target, committed.target);
              assert.equal(result.record.reservationRef, committed.reservationRef);
              assert.equal(result.record.originalTransactionRef, committed.originalTransactionRef);
              const parent = await channels.createChannelInstallation(channelRecord(committed));
              assert.equal(parent.id, committed.target.channelInstallationRef);
              const locked = await client.query(
                "SELECT record_version FROM occ.turn_journal_replay_heads WHERE reservation_ref=$1 FOR UPDATE",
                [committed.reservationRef],
              );
              assert.equal(locked.rows.length, 1);
              return result.record;
            },
            true,
          );
          await transaction(pool, installation, async ({ participant, channels }) => {
            assert.deepEqual(await participant.findReservation(committed.target), {
              kind: "found",
              record: original,
            });
            assert.equal(
              (await channels.findChannelInstallation(committed.target.channelInstallationRef)).id,
              committed.target.channelInstallationRef,
            );
          });
        },
      );

      await t.test(
        "exact retry is existing; changed correspondence conflicts without renewal",
        async () => {
          await transaction(pool, installation, async ({ participant }) => {
            assert.deepEqual(await participant.reserveCapacity(committed), {
              kind: "existing",
              record: original,
            });
            for (const changed of [
              { ...committed, reservationRef: reference("changed-reservation") },
              { ...committed, originalTransactionRef: reference("changed-transaction") },
            ]) {
              assert.deepEqual(await participant.reserveCapacity(changed), { kind: "conflict" });
            }
          });
          // Each distinct target uses its own original lock prefix/transaction.
          for (const target of [
            { ...committed.target, creationOperationRef: reference("changed-operation") },
            { ...committed.target, channelInstallationRef: `chi_${randomUUID()}` },
          ]) {
            await transaction(pool, installation, async ({ participant }) => {
              assert.deepEqual(await participant.reserveCapacity({ ...committed, target }), {
                kind: "conflict",
              });
            });
          }
          await transaction(pool, installation, async ({ participant }) => {
            assert.deepEqual(await participant.findReservation(committed.target), {
              kind: "found",
              record: original,
            });
          });
        },
      );

      for (const wrongParent of [false, true]) {
        await t.test(
          `deferred COMMIT rejects ${wrongParent ? "a different" : "a missing"} channel parent`,
          async () => {
            const input = reservation(installation.id);
            const other = reservation(installation.id);
            await assert.rejects(
              transaction(
                pool,
                installation,
                async ({ participant, channels }) => {
                  assert.equal((await participant.reserveCapacity(input)).kind, "reserved");
                  if (wrongParent) await channels.createChannelInstallation(channelRecord(other));
                },
                true,
              ),
              { code: "23503", constraint: "turn_journal_replay_heads_channel" },
            );
            await assertAbsent(pool, input, other.target.channelInstallationRef);
          },
        );
      }

      await t.test(
        "explicit rollback removes both pending reservation and exact parent",
        async () => {
          const input = reservation(installation.id);
          await transaction(pool, installation, async ({ participant, channels }) => {
            assert.equal((await participant.reserveCapacity(input)).kind, "reserved");
            await channels.createChannelInstallation(channelRecord(input));
          });
          await assertAbsent(pool, input);
        },
      );

      await t.test(
        "real SQL constraints reject malformed heads and immutable changes",
        async () => {
          await transaction(pool, installation, async ({ client, participant, channels }) => {
            const input = reservation(installation.id);
            const reserved = await participant.reserveCapacity(input);
            assert.equal(reserved.kind, "reserved");
            await channels.createChannelInstallation(channelRecord(input));
            const fresh = () => headRow(reservation(installation.id), 10_000);
            for (const capacity_slot of [0, 10_001]) {
              await rejectHead(
                client,
                { ...fresh(), capacity_slot },
                "23514",
                "turn_journal_replay_heads_capacity",
              );
            }
            await rejectHead(
              client,
              { ...fresh(), target_key: "f".repeat(64) },
              "23514",
              "turn_journal_replay_heads_key",
            );
            await rejectHead(
              client,
              { ...fresh(), channel_installation_id: `chi_${randomUUID()}` },
              "23514",
              "turn_journal_replay_heads_target",
            );
            for (const record_version of [0, 2, "9007199254740992"]) {
              await rejectHead(client, { ...fresh(), record_version }, "23514");
            }
            for (const state of ["active", "retired"]) {
              await rejectHead(client, { ...fresh(), state }, "23514");
            }
            await rejectHead(
              client,
              { ...fresh(), lineage_ref: reference("unissued-lineage") },
              "23514",
            );
            await rejectHead(
              client,
              { ...fresh(), capacity_slot: reserved.record.capacitySlot },
              "23505",
              "turn_journal_replay_heads_slot_unique",
            );
            await rejectHead(
              client,
              { ...fresh(), reservation_ref: input.reservationRef },
              "23505",
              "turn_journal_replay_heads_reservation_unique",
            );
            await rejectHead(
              client,
              { ...headRow(input, 10_000), reservation_ref: reference("different") },
              "23505",
              "turn_journal_replay_heads_pk",
            );
            await rejectSql(
              client,
              "UPDATE occ.turn_journal_replay_heads SET record_version=record_version+1 WHERE reservation_ref=$1",
              [input.reservationRef],
              "23514",
            );
            for (const column of [
              "installation_id",
              "state",
              "lineage_ref",
              "target",
              "reservation_transaction_ref",
            ]) {
              await rejectSql(
                client,
                `UPDATE occ.turn_journal_replay_heads SET ${column}=${column} WHERE reservation_ref=$1`,
                [input.reservationRef],
                "42501",
              );
            }
            await rejectSql(
              client,
              "DELETE FROM occ.turn_journal_replay_heads WHERE reservation_ref=$1",
              [input.reservationRef],
              "42501",
            );
            assert.deepEqual(await participant.findReservation(input.target), {
              kind: "found",
              record: reserved.record,
            });
          });
        },
      );

      await t.test(
        "lineage and publication remain unavailable under the actual app role",
        async () => {
          await transaction(pool, installation, async ({ client, participant }) => {
            const validation = await client.query(
              "SELECT occ.turn_journal_replay_lineage_valid($1::jsonb) AS valid",
              [JSON.stringify({ schemaVersion: 1, ref: "unissued-lineage" })],
            );
            assert.deepEqual(validation.rows, [{ valid: false }]);
            for (const table of tables.slice(1)) {
              await rejectSql(client, `INSERT INTO occ.${table} DEFAULT VALUES`, [], "42501");
              await rejectSql(
                client,
                `UPDATE occ.${table} SET installation_id=installation_id`,
                [],
                "42501",
              );
              await rejectSql(client, `DELETE FROM occ.${table}`, [], "42501");
            }
            // Plain unusable carriers deliberately cannot stand in for the missing
            // original-owner authority. This does not execute the SQL publication
            // trigger: occ_app is refused by the earlier INSERT privilege boundary.
            assert.deepEqual(await participant.inspectLineage({}), { kind: "unavailable" });
            assert.deepEqual(
              await participant.publishRetirement(reference("unissued"), {}, {}, {}),
              { kind: "unavailable" },
            );
            assert.deepEqual(
              await participant.recordObservation(reference("unissued"), {}, {}, {}),
              { kind: "unavailable" },
            );
          });
        },
      );
    } finally {
      await pool.end();
    }
  },
);
