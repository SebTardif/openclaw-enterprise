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

const migrationCodes = new Set([
  "MIGRATION_DESCRIPTOR_UNCONFIGURED",
  "MIGRATION_DESCRIPTOR_INVALID",
  "MIGRATION_DESCRIPTOR_MISMATCH",
  "MIGRATION_CATALOG_INVALID",
  "MIGRATION_CATALOG_CHANGED",
  "MIGRATION_SENTINEL_MISMATCH",
  "MIGRATION_SENTINEL_MISSING",
  "MIGRATION_TRANSACTION_REQUIRED",
  "MIGRATION_ISOLATION_REQUIRED",
  "MIGRATION_OWNER_REQUIRED",
  "MIGRATION_HISTORY_MISMATCH",
  "MIGRATION_PHASE_LOCKS_REQUIRED",
  "MIGRATION_CODEC_PREFLIGHT_FAILED",
  "MIGRATION_FAILED",
  "MIGRATION_COMMIT_UNKNOWN",
]);
const diagnosticStages = new Set([
  "catalog-load",
  "catalog-validate",
  "adapter-load",
  "connection-acquire",
  "transaction-entry",
  "transaction-body",
  "transaction-settlement",
  "isolation-query",
  "transaction-guard",
  "migration-owner-lock",
  "ledger-initialize",
  "ledger-owner-query",
  "ledger-lock",
  "ledger-read",
  "ledger-validate",
  "migration-statement",
  "phase-lock-query",
  "phase-lock-validate",
  "codec-import",
  "codec-scan-query",
  "codec-decode",
  "conversion-query",
  "conversion-validate",
  "conversion-decode",
  "conversion-coverage-query",
  "conversion-coverage-validate",
  "ledger-publish",
  "execution",
]);
const entryStages = new Set([
  "entry-arguments",
  "entry-configuration",
  "entry-database-url",
  "entry-pg-load",
  "entry-pool-create",
  "entry-migration",
  "entry-reporting",
]);
const queryStages = new Set([
  "isolation-query",
  "transaction-guard",
  "migration-owner-lock",
  "ledger-initialize",
  "ledger-owner-query",
  "ledger-lock",
  "ledger-read",
  "migration-statement",
  "phase-lock-query",
  "codec-scan-query",
  "conversion-query",
  "conversion-coverage-query",
  "ledger-publish",
]);
const errorDiagnostics = new WeakMap();

function ownData(value, key) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function")
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isMigrationError(value) {
  try {
    return value instanceof MigrationExecutionError;
  } catch {
    return false;
  }
}

function querySqlState(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function") ||
      seen.has(current)
    )
      break;
    seen.add(current);
    const code = ownData(current, "code");
    if (typeof code === "string" && code.length === 5 && /^[A-Z0-9]{5}$/.test(code)) return code;
    current = ownData(current, "cause");
  }
  return undefined;
}

/** Diagnostic selection only: this collector supplies no transaction authority,
 * retry decision or proof of database outcome. Each invocation owns its collector. */
export function createMigrationDiagnostics() {
  let first;
  return Object.freeze({
    capture(stage, error, options = {}) {
      if (first !== undefined) return;
      const selected = diagnosticStages.has(stage) ? stage : "execution";
      const index = ownData(options, "migrationIndex");
      const tag = ownData(options, "migrationTag");
      const ordinal = ownData(options, "statementOrdinal");
      let operation = selected;
      if (
        Number.isSafeInteger(index) &&
        index >= 0 &&
        index < 10_000 &&
        typeof tag === "string" &&
        tag.length <= 128 &&
        /^[0-9]{4,}_[a-z0-9_]+$/.test(tag) &&
        !/[^0-9a-z_]/.test(tag) &&
        Number.isSafeInteger(ordinal) &&
        ordinal >= 0
      ) {
        operation += `:migration-${index}:${tag}:statement-${ordinal}`;
      }
      const state =
        queryStages.has(selected) && ownData(options, "queryFailure") === true
          ? querySqlState(error)
          : undefined;
      const fields = isMigrationError(error) ? migrationFailureLogFields(error) : undefined;
      first = Object.freeze({
        operation,
        ...(state === undefined ? {} : { result: `sqlstate:${state}` }),
        ...(fields === undefined ? {} : { code: fields.code, outcome: fields.outcome }),
      });
    },
    failure(error, bodyReturned = false) {
      const fields = migrationFailureLogFields(error);
      const retained = first ?? errorDiagnostics.get(error);
      const unknown =
        bodyReturned === true || retained?.outcome === "unknown" || fields.outcome === "unknown";
      const failure = new MigrationExecutionError(
        unknown ? "MIGRATION_COMMIT_UNKNOWN" : (retained?.code ?? fields.code),
        unknown ? "unknown" : "not-committed",
      );
      // Capture the helper's safe domain code before its caller can enter Drizzle
      // rollback. An earlier typed failure code and its first location win.
      if (retained !== undefined) {
        first = Object.freeze({ ...retained, code: failure.code, outcome: failure.outcome });
        errorDiagnostics.set(failure, first);
      }
      return failure;
    },
  });
}

/** Project only fixed codes and bounded diagnostic scalars into the existing
 * logger. Untyped wrapper failures have no inferred transaction outcome. */
export function migrationFailureLogFields(error, fallbackOperation = "entry-migration") {
  const typed = isMigrationError(error);
  const suppliedCode = typed ? ownData(error, "code") : undefined;
  let code = migrationCodes.has(suppliedCode) ? suppliedCode : "MIGRATION_FAILED";
  const suppliedOutcome = typed ? ownData(error, "outcome") : undefined;
  let outcome = suppliedOutcome === "not-committed" ? suppliedOutcome : undefined;
  if (suppliedOutcome === "unknown" || code === "MIGRATION_COMMIT_UNKNOWN") {
    code = "MIGRATION_COMMIT_UNKNOWN";
    outcome = "unknown";
  }
  const diagnostic = errorDiagnostics.get(error);
  return Object.freeze({
    code,
    ...(outcome === undefined ? {} : { outcome }),
    operation:
      diagnostic?.operation ??
      (entryStages.has(fallbackOperation) ? fallbackOperation : "entry-migration"),
    ...(diagnostic?.result === undefined ? {} : { result: diagnostic.result }),
  });
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
  hash: "4418e1785eb6d98db22041fcf4b62e9ee248632a4d0a6770addf56ccb91b7ba7",
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

function atSync(diagnostics, stage, action, options) {
  try {
    return action();
  } catch (error) {
    diagnostics.capture(stage, error, options);
    throw error;
  }
}

async function at(diagnostics, stage, action, options) {
  try {
    return await action();
  } catch (error) {
    diagnostics.capture(stage, error, options);
    throw error;
  }
}

function queryOptions(location) {
  return { ...location, queryFailure: true };
}

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
  const diagnostics = createMigrationDiagnostics();
  try {
    return readCatalog(migrationsFolder, diagnostics);
  } catch (error) {
    throw diagnostics.failure(error);
  }
}

function readCatalog(migrationsFolder, diagnostics) {
  let stage = "catalog-validate";
  try {
    if (phaseUpgradeDescriptor === null) fail("MIGRATION_DESCRIPTOR_UNCONFIGURED");
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
    stage = "catalog-load";
    const before = readFileSync(journalPath, "utf8");
    stage = "catalog-validate";
    const journal = JSON.parse(before);
    if (
      journal.version !== descriptor.journalVersion ||
      journal.dialect !== descriptor.journalDialect ||
      !Array.isArray(journal.entries) ||
      journal.entries.length === 0 ||
      journal.entries.length > 10_000
    )
      fail("MIGRATION_CATALOG_INVALID");
    const { readMigrationFiles } = atSync(diagnostics, "adapter-load", () =>
      dependency("drizzle-orm/migrator"),
    );
    stage = "catalog-load";
    const migrations = readMigrationFiles({ migrationsFolder });
    const after = readFileSync(journalPath, "utf8");
    stage = "catalog-validate";
    if (after !== before || migrations.length !== journal.entries.length) {
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
    diagnostics.capture(stage, error);
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
  const diagnostics = createMigrationDiagnostics();
  try {
    const catalog = readCatalog(migrationsFolder, diagnostics);
    return await applyCatalog(transaction, catalog, diagnostics);
  } catch (error) {
    diagnostics.capture("transaction-body", error);
    throw diagnostics.failure(error);
  }
}

/** Observe only this checked-out client's faults through its synchronous pool
 * release. This object does not execute or authorize a transaction. Event payloads
 * are deliberately ignored so an awaited query failure keeps its own diagnostic. */
export function trackMigrationClient(client, diagnostics = createMigrationDiagnostics()) {
  let faulted = false;
  let released = false;
  const onError = () => {
    faulted = true;
  };
  client.on("error", onError);

  function captureFailure(error, bodyReturned) {
    diagnostics.capture(bodyReturned ? "transaction-settlement" : "transaction-entry", error);
  }

  function assertHealthy(bodyReturned = false) {
    if (!faulted) return;
    const error = new MigrationExecutionError("MIGRATION_FAILED");
    captureFailure(error, bodyReturned);
    throw diagnostics.failure(error, bodyReturned);
  }

  return Object.freeze({
    assertHealthy,
    release(discard, bodyReturned = false) {
      if (released) {
        const error = new MigrationExecutionError("MIGRATION_FAILED");
        captureFailure(error, bodyReturned);
        throw diagnostics.failure(error, bodyReturned);
      }
      released = true;
      try {
        // A prior fault discards the client. Keep observation active while pg
        // reattaches its idle listener and completes the release handoff.
        client.release(discard || faulted);
      } catch (error) {
        faulted = true;
        captureFailure(error, bodyReturned);
      } finally {
        try {
          client.removeListener("error", onError);
        } catch (error) {
          faulted = true;
          captureFailure(error, bodyReturned);
        }
      }
      assertHealthy(bodyReturned);
    },
  });
}

/** The pool entry owns one client and one transaction, with no retry. Drizzle
 * discards the COMMIT result and may replace its failure with a ROLLBACK error.
 * Therefore every failure after our callback returns has unknown commit status. */
export async function runMigrations(pool, { migrationsFolder }) {
  const diagnostics = createMigrationDiagnostics();
  let client;
  let clientLifetime;
  let bodyReturned = false;
  let committed = false;
  let result;
  let failure;
  try {
    const catalog = readCatalog(migrationsFolder, diagnostics);
    const { drizzle } = atSync(diagnostics, "adapter-load", () =>
      dependency("drizzle-orm/node-postgres"),
    );
    await at(diagnostics, "connection-acquire", async () => {
      client = await pool.connect();
      clientLifetime = trackMigrationClient(client, diagnostics);
    });
    clientLifetime.assertHealthy();
    const database = atSync(diagnostics, "adapter-load", () => drizzle(client));
    result = await database.transaction(
      async (transaction) => {
        try {
          const applied = await applyCatalog(transaction, catalog, diagnostics);
          clientLifetime.assertHealthy();
          bodyReturned = true;
          return applied;
        } catch (error) {
          diagnostics.capture("transaction-body", error);
          throw diagnostics.failure(error);
        }
      },
      { isolationLevel: "read committed" },
    );
    committed = true;
    clientLifetime.assertHealthy(bodyReturned);
  } catch (error) {
    // Drizzle owns BEGIN/COMMIT/ROLLBACK. This outer observation may be a
    // replacement rollback error, so it cannot supply an original SQLSTATE.
    diagnostics.capture(bodyReturned ? "transaction-settlement" : "transaction-entry", error);
    failure = diagnostics.failure(error, bodyReturned);
  } finally {
    if (client !== undefined) {
      try {
        if (clientLifetime !== undefined) {
          clientLifetime.release(!committed, bodyReturned);
        } else {
          // Listener installation failed before transaction use.
          client.release(true);
        }
      } catch (error) {
        diagnostics.capture(bodyReturned ? "transaction-settlement" : "transaction-entry", error);
        failure = diagnostics.failure(error, bodyReturned);
      }
    }
  }
  // A release-time fault must be observed before success leaves this owner.
  if (failure !== undefined) throw failure;
  return result;
}

async function applyCatalog(transaction, catalog, diagnostics) {
  const { is, sql } = atSync(diagnostics, "adapter-load", () => dependency("drizzle-orm"));
  const { NodePgTransaction } = atSync(diagnostics, "adapter-load", () =>
    dependency("drizzle-orm/node-postgres"),
  );
  atSync(diagnostics, "transaction-guard", () => {
    if (!is(transaction, NodePgTransaction) || transaction.nestedIndex !== 0) {
      fail("MIGRATION_TRANSACTION_REQUIRED");
    }
  });
  const isolation = await at(
    diagnostics,
    "isolation-query",
    () => transaction.execute(sql`SHOW transaction_isolation`),
    queryOptions(),
  );
  atSync(diagnostics, "transaction-guard", () => {
    if (
      isolation.rows.length !== 1 ||
      isolation.rows[0].transaction_isolation !== "read committed"
    ) {
      fail("MIGRATION_ISOLATION_REQUIRED");
    }
  });
  // This lock serializes the migration owner before the ledger even exists.
  // It is unrelated to the runtime journal admission lock and is not configurable.
  await at(
    diagnostics,
    "migration-owner-lock",
    () => transaction.execute(sql`SELECT pg_advisory_xact_lock(1868784941, 1768387186)`),
    queryOptions(),
  );
  // LOCK rejects autocommit use before ledger DDL. It establishes an active
  // physical transaction, not the original lifetime of a retained Drizzle object
  // whose session/client may now belong to another transaction.
  await at(
    diagnostics,
    "transaction-guard",
    () => transaction.execute(sql`LOCK TABLE pg_catalog.pg_class IN ACCESS SHARE MODE`),
    queryOptions(),
  );
  await at(
    diagnostics,
    "ledger-initialize",
    () => transaction.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`),
    queryOptions(),
  );
  await at(
    diagnostics,
    "ledger-initialize",
    () =>
      transaction.execute(sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
  )`),
    queryOptions(),
  );
  const owner = await at(
    diagnostics,
    "ledger-owner-query",
    () =>
      transaction.execute(sql`SELECT
    current_user = pg_get_userbyid(c.relowner) AS owns_ledger
    FROM pg_class c WHERE c.oid = 'drizzle.__drizzle_migrations'::regclass`),
    queryOptions(),
  );
  atSync(diagnostics, "ledger-validate", () => {
    if (owner.rows.length !== 1 || owner.rows[0].owns_ledger !== true) {
      fail("MIGRATION_OWNER_REQUIRED");
    }
  });
  // Exclude a concurrently applying legacy runner from changing the prefix while
  // this owner holds it. Read committed takes the fresh snapshot after this wait.
  await at(
    diagnostics,
    "ledger-lock",
    () =>
      transaction.execute(sql`LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE`),
    queryOptions(),
  );
  const history = await at(
    diagnostics,
    "ledger-read",
    () =>
      transaction.execute(sql`SELECT id, hash, created_at
    FROM drizzle.__drizzle_migrations ORDER BY id LIMIT ${catalog.length + 1}`),
    queryOptions(),
  );
  atSync(diagnostics, "ledger-validate", () => {
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
  });
  let applied = 0;
  for (const migration of catalog.slice(history.rows.length)) {
    for (const [ordinal, statement] of migration.statements.entries()) {
      const location = {
        migrationIndex: migration.entry.idx,
        migrationTag: migration.entry.tag,
        statementOrdinal: ordinal,
      };
      if (migration.phase && ordinal === phaseUpgradeDescriptor.statementIndex) {
        atSync(
          diagnostics,
          "migration-statement",
          () => {
            if (statement !== phaseCodecSentinel) fail("MIGRATION_SENTINEL_MISMATCH");
          },
          location,
        );
        await runJournalPhaseCodecPreflight(transaction, sql, diagnostics, location);
      } else {
        await at(
          diagnostics,
          "migration-statement",
          () => transaction.execute(sql.raw(statement)),
          queryOptions(location),
        );
      }
    }
    // This is a distinct owner operation; no previous statement context carries over.
    await at(
      diagnostics,
      "ledger-publish",
      () =>
        transaction.execute(sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${migration.hash}, ${migration.entry.when})`),
      queryOptions(),
    );
    applied += 1;
  }
  return Object.freeze({ applied, previouslyApplied: history.rows.length });
}

async function scan(transaction, sql, table, keys, visit, diagnostics, location) {
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
    const result = await at(
      diagnostics,
      "codec-scan-query",
      () =>
        transaction.execute(sql`SELECT * FROM ${sql.identifier(table.schema)}.${sql.identifier(table.name)}
      ${after} ORDER BY ${sql.join(columns, sql`, `)} LIMIT ${pageSize}`),
      queryOptions(location),
    );
    if (result.rows.length === 0) return;
    for (const row of result.rows) {
      await at(diagnostics, "codec-decode", () => visit(nativeTimestampColumns(row)), location);
    }
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

async function runJournalPhaseCodecPreflight(transaction, sql, diagnostics, location) {
  try {
    const locks = await at(
      diagnostics,
      "phase-lock-query",
      () =>
        transaction.execute(sql`SELECT count(DISTINCT relation)::integer AS count
      FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'relation'
      AND mode = 'AccessExclusiveLock' AND granted
      AND relation IN (${sql.join(
        journalTables.map((name) => sql`to_regclass(${"occ." + name})`),
        sql`, `,
      )})`),
      queryOptions(location),
    );
    atSync(
      diagnostics,
      "phase-lock-validate",
      () => {
        if (locks.rows.length !== 1 || locks.rows[0].count !== journalTables.length) {
          fail("MIGRATION_PHASE_LOCKS_REQUIRED");
        }
      },
      location,
    );
    // These are the original application parsers. Their decoded outputs are
    // discarded: validation must never normalize stored SDK envelopes or rows.
    const rows = await at(
      diagnostics,
      "codec-import",
      () => import("../packages/occ/src/turn-journal/rows.ts"),
      location,
    );
    const { parseTurnJournalV1 } = await at(
      diagnostics,
      "codec-import",
      () => import("../packages/contracts/src/turn-journal-v1.ts"),
      location,
    );
    const { parseCompletedContextV1 } = await at(
      diagnostics,
      "codec-import",
      () => import("../packages/contracts/src/completed-context-v1.ts"),
      location,
    );
    const table = (name) => ({ schema: "occ", name });
    const scanPhase = (relation, keys, visit) =>
      scan(transaction, sql, relation, keys, visit, diagnostics, location);
    await scanPhase(
      table("turn_journal_owners"),
      ["installation_id", "channel_installation_id", "receipt_ref"],
      rows.parseOwnerRow,
    );
    await scanPhase(
      table("turn_journal_incoming_links"),
      ["installation_id", "channel_installation_id", "incoming_link_ref"],
      rows.parseIncomingLinkRow,
    );
    await scanPhase(
      table("turn_journal_heads"),
      ["installation_id", "namespace_id", "agent_id", "conversation_ref"],
      rows.parseHeadRow,
    );
    await scanPhase(
      table("turn_journal_operations"),
      ["installation_id", "operation_kind", "operation_ref"],
      rows.parseOperationRow,
    );
    await scanPhase(
      table("turn_journal_deliveries"),
      [...attemptKey, "slot"],
      rows.parseDeliveryRow,
    );
    await scanPhase(
      table("turn_journal_delivery_attempts"),
      ["installation_id", "delivery_attempt_ref"],
      rows.parseDeliveryRow,
    );
    await scanPhase(
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
    await scanPhase(
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
    await scanPhase(table("turn_journal_attempts"), attemptKey, (row) => {
      if (row.record !== null) rows.parseAttemptRow(row);
    });
    await scanPhase(
      { schema: "pg_temp", name: "turn_journal_phase_conversion" },
      attemptKey,
      async (candidate) => {
        const predicates = attemptKey.map((key) => sql`${sql.identifier(key)} = ${candidate[key]}`);
        const retained = await at(
          diagnostics,
          "conversion-query",
          () =>
            transaction.execute(sql`SELECT *
          FROM occ.turn_journal_attempts a WHERE ${sql.join(predicates, sql` AND `)}
          AND to_jsonb(a) = ${JSON.stringify(candidate.old_row)}::jsonb`),
          queryOptions(location),
        );
        const row = atSync(
          diagnostics,
          "conversion-validate",
          () => {
            if (retained.rows.length !== 1) fail("MIGRATION_CODEC_PREFLIGHT_FAILED");
            const value = nativeTimestampColumns(retained.rows[0]);
            if (value.record !== null || String(value.version) !== "1")
              fail("MIGRATION_CODEC_PREFLIGHT_FAILED");
            return value;
          },
          location,
        );
        atSync(
          diagnostics,
          "conversion-decode",
          () =>
            rows.parseAttemptRow({
              ...row,
              record: candidate.new_record,
              version: candidate.new_record.version,
            }),
          location,
        );
      },
    );
    const coverage = await at(
      diagnostics,
      "conversion-coverage-query",
      () =>
        transaction.execute(sql`SELECT
      (SELECT count(*) FROM occ.turn_journal_attempts WHERE record IS NULL) =
      (SELECT count(*) FROM pg_temp.turn_journal_phase_conversion) AS complete`),
      queryOptions(location),
    );
    atSync(
      diagnostics,
      "conversion-coverage-validate",
      () => {
        if (coverage.rows.length !== 1 || coverage.rows[0].complete !== true) {
          fail("MIGRATION_CODEC_PREFLIGHT_FAILED");
        }
      },
      location,
    );
  } catch (error) {
    diagnostics.capture("codec-decode", error, location);
    if (error instanceof MigrationExecutionError) throw error;
    fail("MIGRATION_CODEC_PREFLIGHT_FAILED");
  }
}
