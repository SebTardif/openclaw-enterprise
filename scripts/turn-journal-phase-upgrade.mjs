import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

const dependency = createRequire(new URL("../packages/occ/package.json", import.meta.url));

/** A transaction failure never includes stored values or connection details. */
export class MigrationExecutionError extends Error {
  constructor(code, outcome = "not-committed") {
    super("The migration did not complete successfully.");
    this.name = "MigrationExecutionError";
    this.code = code;
    this.outcome = outcome;
  }
}

// Fixed deployment metadata for the mandatory codec step; callers cannot replace it.
export const phaseUpgradeDescriptor = freeze({
  journalVersion: "7",
  journalDialect: "postgresql",
  entry: {
    idx: 28,
    version: "7",
    when: 1788734317285,
    tag: "0028_turn_journal_attempt_phase",
    breakpoints: true,
  },
  hash: "1a396a7f3186a1a1be5e5bf672ea6d952c20bc332e72193d35908364e80beb42",
  statementIndex: 1,
  statement:
    "\nDO $turn_journal_codec_step$\nBEGIN\n  RAISE EXCEPTION 'This migration requires the original locked journal codec step'\n    USING ERRCODE = '0A000';\nEND;\n$turn_journal_codec_step$;\n",
});

export const phaseCodecSentinel = `
DO $turn_journal_codec_step$
BEGIN
  RAISE EXCEPTION 'This migration requires the original locked journal codec step'
    USING ERRCODE = '0A000';
END;
$turn_journal_codec_step$;
`;

const breakpoint = "--> statement-breakpoint";
const pageSize = 64;
const attemptKey = Object.freeze([
  "installation_id",
  "namespace_id",
  "agent_id",
  "conversation_ref",
  "turn_ref",
  "attempt_ref",
  "reservation_ref",
]);
const journalTables = Object.freeze([
  "turn_journal_attempts",
  "turn_journal_deliveries",
  "turn_journal_delivery_attempts",
  "turn_journal_heads",
  "turn_journal_incoming_links",
  "turn_journal_keys",
  "turn_journal_operations",
  "turn_journal_owners",
  "turn_journal_reservations",
]);

function fail(code) {
  throw new MigrationExecutionError(code);
}

function freeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Read a captured catalog, without acquiring a connection or selecting work.
 * The descriptor is original deployment metadata, never a caller argument. */
export function readMigrationCatalog(migrationsFolder) {
  if (phaseUpgradeDescriptor === null) fail("MIGRATION_DESCRIPTOR_UNCONFIGURED");
  try {
    if (typeof migrationsFolder !== "string" || !isAbsolute(migrationsFolder)) {
      fail("MIGRATION_CATALOG_INVALID");
    }
    const descriptor = phaseUpgradeDescriptor;
    if (
      descriptor.journalVersion !== "7" ||
      descriptor.journalDialect !== "postgresql" ||
      !Number.isSafeInteger(descriptor.statementIndex) ||
      descriptor.statementIndex < 0 ||
      descriptor.statement !== phaseCodecSentinel ||
      !/^[a-f0-9]{64}$/.test(descriptor.hash)
    )
      fail("MIGRATION_DESCRIPTOR_INVALID");
    const journalPath = join(migrationsFolder, "meta", "_journal.json");
    const before = readFileSync(journalPath, "utf8");
    const journal = JSON.parse(before);
    if (
      journal.version !== descriptor.journalVersion ||
      journal.dialect !== descriptor.journalDialect ||
      !Array.isArray(journal.entries) ||
      journal.entries.length === 0 ||
      journal.entries.length > 10_000
    )
      fail("MIGRATION_CATALOG_INVALID");
    const { readMigrationFiles } = dependency("drizzle-orm/migrator");
    const migrations = readMigrationFiles({ migrationsFolder });
    if (
      readFileSync(journalPath, "utf8") !== before ||
      migrations.length !== journal.entries.length
    ) {
      fail("MIGRATION_CATALOG_CHANGED");
    }
    const tags = new Set();
    let sentinelCount = 0;
    let selected = 0;
    let previousWhen = -1;
    const catalog = migrations.map((migration, index) => {
      const entry = journal.entries[index];
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !== "breakpoints,idx,tag,version,when" ||
        entry.idx !== index ||
        entry.version !== "7" ||
        entry.breakpoints !== true ||
        !Number.isSafeInteger(entry.when) ||
        entry.when <= previousWhen ||
        typeof entry.tag !== "string" ||
        !/^[0-9]{4,}_[a-z0-9_]+$/.test(entry.tag) ||
        tags.has(entry.tag) ||
        migration.folderMillis !== entry.when ||
        migration.bps !== entry.breakpoints ||
        !Array.isArray(migration.sql) ||
        migration.sql.length === 0 ||
        migration.sql.some((statement) => typeof statement !== "string") ||
        createHash("sha256").update(migration.sql.join(breakpoint)).digest("hex") !== migration.hash
      )
        fail("MIGRATION_CATALOG_INVALID");
      tags.add(entry.tag);
      previousWhen = entry.when;
      const phase = entry.tag === descriptor.entry?.tag;
      if (phase) {
        selected += 1;
        if (
          Object.keys(descriptor.entry).sort().join(",") !== "breakpoints,idx,tag,version,when" ||
          Object.keys(entry).some((key) => entry[key] !== descriptor.entry[key]) ||
          migration.hash !== descriptor.hash ||
          migration.sql[descriptor.statementIndex] !== descriptor.statement
        )
          fail("MIGRATION_DESCRIPTOR_MISMATCH");
      }
      for (const [ordinal, statement] of migration.sql.entries()) {
        if (statement.includes("$turn_journal_codec_step$")) {
          sentinelCount += 1;
          if (
            !phase ||
            ordinal !== descriptor.statementIndex ||
            statement !== descriptor.statement
          ) {
            fail("MIGRATION_SENTINEL_MISMATCH");
          }
        }
      }
      return { entry: { ...entry }, hash: migration.hash, statements: [...migration.sql], phase };
    });
    if (selected !== 1 || sentinelCount !== 1) fail("MIGRATION_SENTINEL_MISSING");
    return freeze(catalog);
  } catch (error) {
    if (error instanceof MigrationExecutionError) throw error;
    fail("MIGRATION_CATALOG_INVALID");
  }
}

/** The trusted caller must invoke this from the transaction's current original
 * owning callback, keep exclusive client use, and await it before that callback
 * settles. The caller owns commit/rollback, including intentional rollback tests.
 * Runtime checks do not authenticate an escaped transaction object's original
 * lifetime if its session/client has since been reused. */
export async function runMigrationsInTransaction(transaction, { migrationsFolder }) {
  const catalog = readMigrationCatalog(migrationsFolder);
  try {
    return await applyCatalog(transaction, catalog);
  } catch (error) {
    if (error instanceof MigrationExecutionError) throw error;
    fail("MIGRATION_FAILED");
  }
}

/** The pool entry owns one client and one transaction, with no retry. Drizzle
 * discards the COMMIT result and may replace its failure with a ROLLBACK error.
 * Therefore every failure after our callback returns has unknown commit status. */
export async function runMigrations(pool, { migrationsFolder }) {
  const catalog = readMigrationCatalog(migrationsFolder);
  const { drizzle } = dependency("drizzle-orm/node-postgres");
  let client;
  let bodyReturned = false;
  let committed = false;
  try {
    client = await pool.connect();
    const result = await drizzle(client).transaction(
      async (transaction) => {
        const applied = await applyCatalog(transaction, catalog);
        bodyReturned = true;
        return applied;
      },
      { isolationLevel: "read committed" },
    );
    committed = true;
    return result;
  } catch (error) {
    if (bodyReturned) throw new MigrationExecutionError("MIGRATION_COMMIT_UNKNOWN", "unknown");
    if (error instanceof MigrationExecutionError) throw error;
    fail("MIGRATION_FAILED");
  } finally {
    if (client !== undefined) {
      try {
        // Discard a failed connection; never let disposal conceal uncertainty.
        client.release(!committed);
      } catch {
        // Disposal cannot change the transaction result already observed above.
      }
    }
  }
}

async function applyCatalog(transaction, catalog) {
  const { is, sql } = dependency("drizzle-orm");
  const { NodePgTransaction } = dependency("drizzle-orm/node-postgres");
  if (!is(transaction, NodePgTransaction) || transaction.nestedIndex !== 0) {
    fail("MIGRATION_TRANSACTION_REQUIRED");
  }
  const isolation = await transaction.execute(sql`SHOW transaction_isolation`);
  if (isolation.rows.length !== 1 || isolation.rows[0].transaction_isolation !== "read committed") {
    fail("MIGRATION_ISOLATION_REQUIRED");
  }
  // This lock serializes the migration owner before the ledger even exists.
  // It is unrelated to the runtime journal admission lock and is not configurable.
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(1868784941, 1768387186)`);
  // LOCK rejects autocommit use before ledger DDL. It establishes an active
  // physical transaction, not the original lifetime of a retained Drizzle object
  // whose session/client may now belong to another transaction.
  await transaction.execute(sql`LOCK TABLE pg_catalog.pg_class IN ACCESS SHARE MODE`);
  await transaction.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await transaction.execute(sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
  )`);
  const owner = await transaction.execute(sql`SELECT
    current_user = pg_get_userbyid(c.relowner) AS owns_ledger
    FROM pg_class c WHERE c.oid = 'drizzle.__drizzle_migrations'::regclass`);
  if (owner.rows.length !== 1 || owner.rows[0].owns_ledger !== true) {
    fail("MIGRATION_OWNER_REQUIRED");
  }
  // Exclude a concurrently applying legacy runner from changing the prefix while
  // this owner holds it. Read committed takes the fresh snapshot after this wait.
  await transaction.execute(sql`LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE`);
  const history = await transaction.execute(sql`SELECT id, hash, created_at
    FROM drizzle.__drizzle_migrations ORDER BY id LIMIT ${catalog.length + 1}`);
  if (history.rows.length > catalog.length) fail("MIGRATION_HISTORY_MISMATCH");
  let previousId = 0;
  for (const [index, row] of history.rows.entries()) {
    const migration = catalog[index];
    const id = Number(row.id);
    if (
      !Number.isSafeInteger(id) ||
      id <= previousId ||
      row.hash !== migration.hash ||
      String(row.created_at) !== String(migration.entry.when)
    )
      fail("MIGRATION_HISTORY_MISMATCH");
    previousId = id;
  }
  let applied = 0;
  for (const migration of catalog.slice(history.rows.length)) {
    for (const [ordinal, statement] of migration.statements.entries()) {
      if (migration.phase && ordinal === phaseUpgradeDescriptor.statementIndex) {
        if (statement !== phaseCodecSentinel) fail("MIGRATION_SENTINEL_MISMATCH");
        await runJournalPhaseCodecPreflight(transaction, sql);
      } else {
        await transaction.execute(sql.raw(statement));
      }
    }
    await transaction.execute(sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${migration.hash}, ${migration.entry.when})`);
    applied += 1;
  }
  return Object.freeze({ applied, previouslyApplied: history.rows.length });
}

async function scan(transaction, sql, table, keys, visit) {
  let last;
  const columns = keys.map((key) => sql.identifier(key));
  for (;;) {
    const after =
      last === undefined
        ? sql``
        : sql`WHERE
      (${sql.join(columns, sql`, `)}) > (${sql.join(
        last.map((value) => sql`${value}`),
        sql`, `,
      )})`;
    const result =
      await transaction.execute(sql`SELECT * FROM ${sql.identifier(table.schema)}.${sql.identifier(table.name)}
      ${after} ORDER BY ${sql.join(columns, sql`, `)} LIMIT ${pageSize}`);
    if (result.rows.length === 0) return;
    for (const row of result.rows) await visit(nativeTimestampColumns(row));
    last = keys.map((key) => result.rows.at(-1)[key]);
  }
}

function nativeTimestampColumns(row) {
  // Drizzle raw execution returns timestamp strings; the existing pg-backed row
  // parsers accept Date values for these two native columns. JSON is untouched.
  const result = { ...row };
  for (const key of ["first_received_at", "episode_started_at"]) {
    if (typeof result[key] === "string") result[key] = new Date(result[key]);
  }
  return result;
}

async function runJournalPhaseCodecPreflight(transaction, sql) {
  try {
    const locks = await transaction.execute(sql`SELECT count(DISTINCT relation)::integer AS count
      FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'relation'
      AND mode = 'AccessExclusiveLock' AND granted
      AND relation IN (${sql.join(
        journalTables.map((name) => sql`to_regclass(${"occ." + name})`),
        sql`, `,
      )})`);
    if (locks.rows.length !== 1 || locks.rows[0].count !== journalTables.length) {
      fail("MIGRATION_PHASE_LOCKS_REQUIRED");
    }
    // These are the original application parsers. Their decoded outputs are
    // discarded: validation must never normalize stored SDK envelopes or rows.
    const rows = await import("../packages/occ/src/turn-journal/rows.ts");
    const { parseTurnJournalV1 } = await import("../packages/contracts/src/turn-journal-v1.ts");
    const { parseCompletedContextV1 } =
      await import("../packages/contracts/src/completed-context-v1.ts");
    const table = (name) => ({ schema: "occ", name });
    await scan(
      transaction,
      sql,
      table("turn_journal_owners"),
      ["installation_id", "channel_installation_id", "receipt_ref"],
      rows.parseOwnerRow,
    );
    await scan(
      transaction,
      sql,
      table("turn_journal_incoming_links"),
      ["installation_id", "channel_installation_id", "incoming_link_ref"],
      rows.parseIncomingLinkRow,
    );
    await scan(
      transaction,
      sql,
      table("turn_journal_heads"),
      ["installation_id", "namespace_id", "agent_id", "conversation_ref"],
      rows.parseHeadRow,
    );
    await scan(
      transaction,
      sql,
      table("turn_journal_operations"),
      ["installation_id", "operation_kind", "operation_ref"],
      rows.parseOperationRow,
    );
    await scan(
      transaction,
      sql,
      table("turn_journal_deliveries"),
      [...attemptKey, "slot"],
      rows.parseDeliveryRow,
    );
    await scan(
      transaction,
      sql,
      table("turn_journal_delivery_attempts"),
      ["installation_id", "delivery_attempt_ref"],
      rows.parseDeliveryRow,
    );
    await scan(
      transaction,
      sql,
      table("turn_journal_keys"),
      ["installation_id", "channel_installation_id", "key_kind", "key_digest"],
      (row) => {
        parseTurnJournalV1("lookup", {
          schemaVersion: 1,
          kind: row.key_kind,
          installationRef: row.installation_id,
          channelInstallationRef: row.channel_installation_id,
          ...(row.key_kind === "event"
            ? { eventKey: row.key_digest }
            : { logicalMessageKey: row.key_digest }),
        });
      },
    );
    await scan(
      transaction,
      sql,
      table("turn_journal_reservations"),
      ["installation_id", "namespace_id", "agent_id"],
      (row) => {
        parseCompletedContextV1("exactAttempt", {
          installationRef: row.installation_id,
          namespaceRef: row.namespace_id,
          agentRef: row.agent_id,
          conversationRef: row.conversation_ref,
          turnRef: row.turn_ref,
          attemptRef: row.attempt_ref,
          reservationRef: row.reservation_ref,
        });
      },
    );
    await scan(transaction, sql, table("turn_journal_attempts"), attemptKey, (row) => {
      if (row.record !== null) rows.parseAttemptRow(row);
    });
    await scan(
      transaction,
      sql,
      { schema: "pg_temp", name: "turn_journal_phase_conversion" },
      attemptKey,
      async (candidate) => {
        const predicates = attemptKey.map((key) => sql`${sql.identifier(key)} = ${candidate[key]}`);
        const retained = await transaction.execute(sql`SELECT *
          FROM occ.turn_journal_attempts a WHERE ${sql.join(predicates, sql` AND `)}
          AND to_jsonb(a) = ${JSON.stringify(candidate.old_row)}::jsonb`);
        if (retained.rows.length !== 1) fail("MIGRATION_CODEC_PREFLIGHT_FAILED");
        const row = nativeTimestampColumns(retained.rows[0]);
        if (row.record !== null || String(row.version) !== "1") {
          fail("MIGRATION_CODEC_PREFLIGHT_FAILED");
        }
        rows.parseAttemptRow({
          ...row,
          record: candidate.new_record,
          version: candidate.new_record.version,
        });
      },
    );
    const coverage = await transaction.execute(sql`SELECT
      (SELECT count(*) FROM occ.turn_journal_attempts WHERE record IS NULL) =
      (SELECT count(*) FROM pg_temp.turn_journal_phase_conversion) AS complete`);
    if (coverage.rows.length !== 1 || coverage.rows[0].complete !== true) {
      fail("MIGRATION_CODEC_PREFLIGHT_FAILED");
    }
  } catch (error) {
    if (error instanceof MigrationExecutionError) throw error;
    fail("MIGRATION_CODEC_PREFLIGHT_FAILED");
  }
}
