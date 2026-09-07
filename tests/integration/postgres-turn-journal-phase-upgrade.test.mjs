import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  parseRejectedAdmissionV1,
  parseTurnJournalV1,
} from "../../packages/contracts/src/turn-journal-v1.ts";
import {
  MigrationExecutionError,
  phaseCodecSentinel,
  phaseUpgradeDescriptor,
  readMigrationCatalog,
  runMigrations,
  runMigrationsInTransaction,
} from "../../scripts/turn-journal-phase-upgrade.mjs";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";
import {
  commonAttemptRecord,
  deferred,
  journalHarness,
  journalScopeCompatibilityCases,
} from "../fixtures/turn-journal-storage/values.mjs";

// Source-authored PostgreSQL cases, unexecuted without a separate allocation.
// The operator must explicitly select rollback OR commit and supply an already
// initialized, dedicated test database through corrected 0027, its table-owning
// migration role, the reviewed 0028 SQL and an uncopied legacy source checkout.
// Both modes require the reviewed supported migration folder and complete
// accepted baseline prefix. Only the fixed original executor may cross the SQL
// preflight sentinel; ordinary Drizzle and whole-SQL application must refuse.
// No database, role, schema, Installation or baseline migration is created here.
// The legacy fixture exercises real storage with controlled provenance; it does
// not manufacture native execution, authority or workspace/no-mutator evidence.
const mode = process.env.OCC_TEST_JOURNAL_PHASE_UPGRADE_MODE;
if (mode !== undefined)
  assert.ok(
    ["rollback", "commit"].includes(mode),
    "Select an explicit rollback or commit upgrade allocation.",
  );
const legacySources = Object.freeze({
  "migrations/0022_turn_journal.sql":
    "3a374961915ee143bc78bc1b4a756436fbddc612603cf873c37db8d5fbbfedf8",
  "tests/fixtures/turn-journal-storage/values.mjs":
    "0d9b9536b3deb7176f28dff3a5454a2005354f4f2657a587931ada98d1c6a4a9",
  "tests/fixtures/turn-journal-v1/values.mjs":
    "7094d79887b87a45cb3d0c614439381a4f0558f08517ba67ab79dc6457171f52",
  "tests/conformance/runtime-assignment-store.contract.mjs":
    "c9b940b8e9382bf1955a4010516496bb59d5d78452b8e13eb4a83f902a0ba6f5",
  "tests/conformance/channel-binding-store.contract.mjs":
    "343fa88743b65a0641e491da75d1882abd39695ba949fbf6c2f0d97be6dbb9be",
  "packages/contracts/src/turn-journal-v1.ts":
    "a1a6edffa163f2f605e6cc93293a13477e2b05a09247a999d123e61a64f38cd9",
  "packages/occ/src/state/postgres-state.ts":
    "95eba9bfd9f3e574b544a9103851672a77bda0cc182bdf768f94a49bea808358",
  "packages/occ/src/turn-journal/postgres.ts":
    "0ca327cda87f63e6b91e7a2658513f07ba39ce7524cb2302fb5b672f9d40f098",
  "packages/occ/src/turn-journal/rows.ts":
    "9637b8630575611e43c420f03cba8c205d8effde156e0186a9ffe0a44cb601a5",
  "packages/occ/src/turn-journal/store.ts":
    "2f9f250a571668aed2be87bb2cf226c5f816c8df870660c89299e93bd50d217f",
  "packages/occ/src/turn-journal/transaction-guard.ts":
    "3f7f2ddc27841f0613db59f13f4760bd2874b1ca9f0a00cdbfd3d03672c4994f",
  "packages/occ/src/state/postgres/turn-journal-schema.ts":
    "a399d048471359c306eaecdd866c700db57c212e64f9903ac7ecac37df1e52e4",
});
const tables = Object.freeze([
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
const plain = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const committed = (result) => {
  assert.equal(result.kind, "committed");
  return result.value;
};
const required = (name) => {
  const value = process.env[name];
  assert.ok(value, `Explicit upgrade allocation requires ${name}.`);
  return value;
};
const options = (selected) => ({
  skip:
    mode === selected
      ? false
      : `Select OCC_TEST_JOURNAL_PHASE_UPGRADE_MODE=${selected} only for a separately allocated baseline PostgreSQL test database.`,
  timeout: 120_000,
});

async function reviewedMigrations(sql, expectedSqlHash) {
  assert.ok(
    phaseUpgradeDescriptor,
    "The original migration owner must materialize the exact reviewed phase descriptor before PostgreSQL allocation.",
  );
  // This fixture never invents a numbered slot or copies the candidate into a
  // migration folder. A separately reviewed real runner folder is mandatory.
  const migrationsFolder = resolve(required("OCC_TEST_JOURNAL_PHASE_UPGRADE_MIGRATIONS_FOLDER"));
  const journalBytes = await readFile(resolve(migrationsFolder, "meta/_journal.json"));
  const journalHash = required("OCC_TEST_JOURNAL_PHASE_UPGRADE_JOURNAL_SHA256");
  assert.match(journalHash, /^[a-f0-9]{64}$/);
  assert.equal(sha256(journalBytes), journalHash);
  const originalCatalogBytes = await readFile(
    new URL("../../migrations/meta/_journal.json", import.meta.url),
  );
  assert.equal(
    sha256(originalCatalogBytes),
    "56af6028a4b53c4137e7a6c27d2cca1b0e052c437f076f82a8341e6f2156da6b",
    "The reviewed original catalog through numbered 0028 must remain exact.",
  );
  const originalCatalog = JSON.parse(originalCatalogBytes);
  const selected = JSON.parse(journalBytes);
  assert.deepEqual(
    selected,
    originalCatalog,
    "Supply the same reviewed catalog as this checkout, including its numbered 0028 candidate.",
  );
  const candidate = originalCatalog.entries.at(-1);
  assert.deepEqual(candidate, phaseUpgradeDescriptor.entry);
  // The checkout already contains the candidate. Only the preceding entries
  // form the database's pre-upgrade ledger; do not expect an additional slot.
  const baselineEntries = originalCatalog.entries.slice(0, -1);
  assert.equal(
    baselineEntries.length,
    28,
    "The allocated database must contain exactly the accepted prefix through corrected 0027.",
  );
  assert.equal(baselineEntries.at(-1).tag, "0027_lifecycle_protective_admission");
  assert.match(candidate.tag, /^[0-9]{4}_[a-z0-9_]+$/);
  assert.equal(
    baselineEntries.some((entry) => entry.tag === candidate.tag),
    false,
  );
  assert.ok(Number.isSafeInteger(candidate.when) && candidate.when > baselineEntries.at(-1).when);
  const expectedPrefix = [];
  for (const entry of baselineEntries) {
    assert.match(entry.tag, /^[0-9]{4}_[a-z0-9_]+$/);
    const original = await readFile(new URL(`../../migrations/${entry.tag}.sql`, import.meta.url));
    const provided = await readFile(resolve(migrationsFolder, `${entry.tag}.sql`));
    assert.equal(
      sha256(provided),
      sha256(original),
      `Original migration prefix changed: ${entry.tag}`,
    );
    if (entry.tag === "0022_turn_journal")
      assert.equal(sha256(provided), legacySources["migrations/0022_turn_journal.sql"]);
    if (entry.tag === "0027_lifecycle_protective_admission")
      assert.equal(
        sha256(provided),
        "29a53a5795e43bccf5b8024cba2b6f38ca92dd021d5bd805563ff860232d0016",
      );
    expectedPrefix.push({ hash: sha256(original), created_at: String(entry.when) });
  }
  assert.equal(expectedSqlHash, phaseUpgradeDescriptor.hash);
  const candidateSql = await readFile(resolve(migrationsFolder, `${candidate.tag}.sql`), "utf8");
  const originalCandidateSql = await readFile(
    new URL(`../../migrations/${candidate.tag}.sql`, import.meta.url),
    "utf8",
  );
  assert.equal(
    candidateSql,
    originalCandidateSql,
    "The supplied candidate must match this checkout's exact numbered SQL.",
  );
  assert.equal(sha256(candidateSql), expectedSqlHash);
  assert.equal(candidateSql, sql, "The runner must use the exact reviewed additive candidate.");
  // Resolve the same genuine package entry points as migrate-production.mjs.
  const dependency = createRequire(new URL("../../packages/occ/package.json", import.meta.url));
  const { drizzle } = dependency("drizzle-orm/node-postgres");
  const { migrate } = dependency("drizzle-orm/node-postgres/migrator");
  const { readMigrationFiles } = dependency("drizzle-orm/migrator");
  const actual = readMigrationFiles({ migrationsFolder });
  const catalog = readMigrationCatalog(migrationsFolder);
  assert.deepEqual(
    actual.map((entry) => ({ hash: entry.hash, created_at: String(entry.folderMillis) })),
    [...expectedPrefix, { hash: expectedSqlHash, created_at: String(candidate.when) }],
  );
  return {
    migrationsFolder,
    drizzle,
    migrate,
    catalog,
    expectedPrefix,
    candidate: { hash: expectedSqlHash, created_at: String(candidate.when) },
  };
}

async function migrationHistory(query) {
  return (
    await query.query(
      "SELECT id,hash,created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id",
    )
  ).rows;
}

function connectionTarget(value, databaseName) {
  const url = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), databaseName);
  // Connection-string host/database overrides would defeat the paired-target check.
  assert.equal(
    [...url.searchParams.keys()].some((key) =>
      ["host", "hostaddr", "port", "dbname", "database", "user", "options"].includes(key),
    ),
    false,
  );
  return `${url.hostname}:${url.port || "5432"}/${databaseName}`;
}

async function allocation(t) {
  const databaseName = required("OCC_TEST_JOURNAL_PHASE_UPGRADE_DATABASE_NAME");
  assert.match(
    databaseName,
    /(?:^|_)test(?:_|$)/,
    "The explicitly allocated database name must identify a test database.",
  );
  const appUrl = required("OCC_TEST_JOURNAL_PHASE_UPGRADE_DATABASE_URL");
  const migratorUrl = required("OCC_TEST_JOURNAL_PHASE_UPGRADE_MIGRATOR_URL");
  assert.equal(connectionTarget(appUrl, databaseName), connectionTarget(migratorUrl, databaseName));
  if (mode === "commit")
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(new URL(migratorUrl).hostname),
      "The committed upgrade allocation also exercises the original loopback COMMIT-ACK transport fault.",
    );
  const legacyRoot = resolve(required("OCC_TEST_JOURNAL_PHASE_UPGRADE_LEGACY_SOURCE_ROOT"));
  for (const [path, expected] of Object.entries(legacySources)) {
    assert.equal(
      sha256(await readFile(resolve(legacyRoot, path))),
      expected,
      `Preserved legacy source mismatch: ${path}`,
    );
  }
  const sql = await readFile(resolve(required("OCC_TEST_JOURNAL_PHASE_UPGRADE_SQL")), "utf8");
  const expectedSqlHash = required("OCC_TEST_JOURNAL_PHASE_UPGRADE_SQL_SHA256");
  assert.match(expectedSqlHash, /^[a-f0-9]{64}$/);
  assert.equal(
    sha256(sql),
    expectedSqlHash,
    "Only the separately reviewed additive SQL may execute.",
  );
  const runner = await reviewedMigrations(sql, expectedSqlHash);
  const legacy = await import(
    pathToFileURL(resolve(legacyRoot, "tests/fixtures/turn-journal-storage/values.mjs")).href
  );
  const app = new pg.Pool({
    connectionString: appUrl,
    max: 3,
    connectionTimeoutMillis: 250,
    options: "-c timezone=UTC",
  });
  const migration = new pg.Pool({
    connectionString: migratorUrl,
    max: 2,
    connectionTimeoutMillis: 500,
    options: "-c timezone=UTC",
  });
  t.after(async () => {
    await app.end();
    await migration.end();
  });
  const appRole = (
    await app.query(
      "SELECT current_database() AS database,current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  const migrationRole = (
    await migration.query(
      "SELECT current_database() AS database,current_user AS role,pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='occ.turn_journal_attempts'::regclass",
    )
  ).rows[0];
  assert.equal(appRole.database, databaseName);
  assert.equal(migrationRole.database, databaseName);
  assert.equal(appRole.rolsuper, false);
  assert.equal(appRole.rolbypassrls, false);
  assert.notEqual(appRole.role, migrationRole.role);
  assert.equal(migrationRole.role, migrationRole.owner);
  const history = await migrationHistory(migration);
  assert.deepEqual(
    history.map(({ hash, created_at }) => ({ hash, created_at })),
    runner.expectedPrefix,
    "Actual migration history must exactly match the reviewed folder's accepted baseline prefix.",
  );
  assert.equal(await recordIsRequired(migration), false);
  assert.equal(
    (
      await migration.query(
        "SELECT to_regprocedure('occ.turn_journal_phase_value_valid(text,jsonb)') AS phase",
      )
    ).rows[0].phase,
    null,
  );
  for (const table of tables)
    assert.equal(
      (await app.query(`SELECT count(*)::int AS count FROM occ.${table}`)).rows[0].count,
      0,
      `Allocate an empty baseline journal; this test never clears ${table}.`,
    );
  const h = legacy.journalHarness(app);
  assert.ok(
    await h.state.read((view) => view.installations.getInstallation()),
    "The original Installation must already be initialized by the explicit allocation.",
  );
  return { app, migration, legacy, h, sql, runner, history, migratorUrl };
}

async function recordIsRequired(query) {
  return (
    await query.query(
      "SELECT attnotnull FROM pg_attribute WHERE attrelid='occ.turn_journal_attempts'::regclass AND attname='record'",
    )
  ).rows[0].attnotnull;
}

async function snapshot(query) {
  const data = {};
  for (const table of tables) {
    data[table] = (
      await query.query(
        `SELECT to_jsonb(row_value)::text AS bytes FROM occ.${table} AS row_value ORDER BY to_jsonb(row_value)::text COLLATE "C"`,
      )
    ).rows.map((row) => row.bytes);
  }
  return data;
}

async function attemptRow(query, values) {
  const result = await query.query(
    "SELECT to_jsonb(a) AS row,record::text AS record_bytes FROM occ.turn_journal_attempts a WHERE attempt_ref=$1",
    [values.attempt.attemptRef],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

const write = (h, work) => {
  const call = h.provenance.call();
  return h.write((journal) => work(journal, call), call).then(committed);
};

function refusedSentinel(error) {
  // Genuine Drizzle wraps a PostgreSQL error in its query error. Inspect only
  // that finite cause chain; unrelated failures cannot satisfy this assertion.
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth += 1) {
    if (
      current.code === "0A000" &&
      current.message === "This migration requires the original locked journal codec step"
    )
      return true;
  }
  return false;
}

async function admitted(allocated, prepare = () => {}) {
  const { legacy, h } = allocated;
  const values = legacy.journalValues(await legacy.seedJournalOwner(h.state));
  prepare(values);
  assert.equal(
    (
      await write(h, (journal, call) =>
        journal.admit(h.issue("admission", values.observation), call),
      )
    ).record.decision.kind,
    "accepted",
  );
  assert.equal((await attemptRow(allocated.app, values)).row.record, null);
  return values;
}

async function legacyCases(allocated) {
  const accepted = await admitted(allocated);
  const cancelled = await admitted(allocated);
  const cancellation = await write(allocated.h, (journal, call) =>
    journal.commitCancellation(allocated.h.issue("cancellation", cancelled.cancellation), call),
  );
  assert.equal(cancellation.kind, "recorded");
  assert.equal(cancellation.outcome, "cancelled-before-dispatch");
  const cancelledRow = (await attemptRow(allocated.app, cancelled)).row;
  assert.equal(cancelledRow.record, null);
  assert.equal(Number(cancelledRow.version), 1);
  const consumed = await admitted(allocated, (values) => {
    // Both genuine old and current codecs permit retained scope extensions;
    // migration must compare identity fields without deleting these bytes.
    values.workspace.scope.retainedCompatibilityRef = "historical-scope-extension";
    values.reservation.scope.retainedCompatibilityRef = "historical-scope-extension";
  });
  assert.equal(
    (
      await write(allocated.h, (journal, call) =>
        journal.recordDispatchIntent(allocated.h.issue("dispatch", consumed.binding), call),
      )
    ).kind,
    "recorded",
  );
  assert.equal(
    (
      await write(allocated.h, (journal, call) =>
        journal.consumeAttempt(
          allocated.h.issue("consumption", {
            operation: consumed.consumption,
            binding: consumed.binding,
          }),
          call,
        ),
      )
    ).kind,
    "claim-pending",
  );
  const full = (await attemptRow(allocated.app, consumed)).row.record;
  assert.equal(full.version, 3);
  assert.equal(full.outcome.kind, "consumed");
  assert.ok(full.consumption);
  assert.equal(Object.hasOwn(full, "phase"), false);
  parseTurnJournalV1("attempt", full);
  assert.equal(
    full.binding.identity.workspace.scope.retainedCompatibilityRef,
    "historical-scope-extension",
  );
  assert.equal(
    full.binding.reservation.scope.retainedCompatibilityRef,
    "historical-scope-extension",
  );
  const released = await admitted(allocated);
  assert.equal(
    (
      await write(allocated.h, (journal, call) =>
        journal.recordDispatchIntent(allocated.h.issue("dispatch", released.binding), call),
      )
    ).kind,
    "recorded",
  );
  assert.equal(
    (
      await write(allocated.h, (journal, call) =>
        journal.consumeAttempt(
          allocated.h.issue("consumption", {
            operation: released.consumption,
            binding: released.binding,
          }),
          call,
        ),
      )
    ).kind,
    "claim-pending",
  );
  const unknown = {
    ...released.outcome,
    operationRef: allocated.legacy.ref("historical-unknown"),
    requestDigest: allocated.legacy.digest(),
    expectedAttemptVersion: 3,
    outcome: {
      kind: "outcome-unknown",
      stage: "execution",
      evidenceRef: allocated.legacy.ref("historical-unknown-evidence"),
    },
  };
  const unknownResult = await write(allocated.h, (journal, call) =>
    journal.recordOutcome(allocated.h.issue("outcome", unknown), call),
  );
  assert.equal(unknownResult.kind, "recorded");
  assert.equal(unknownResult.record.version, 4);
  const releasedObservation = { ...released.release, expectedAttemptVersion: 4 };
  assert.equal(
    (
      await write(allocated.h, (journal, call) =>
        journal.releaseReservation(allocated.h.issue("release", releasedObservation), call),
      )
    ).kind,
    "released",
  );
  assert.equal(
    (
      await allocated.app.query(
        "SELECT count(*)::int AS count FROM occ.turn_journal_reservations WHERE reservation_ref=$1",
        [released.attempt.reservationRef],
      )
    ).rows[0].count,
    0,
  );
  // The original owner accepts the controlled verified release observation.
  // Later factual metadata may resolve uncertainty without reacquiring ownership;
  // the fixture does not establish native no-mutator or authority provenance.
  const terminal = { ...released.outcome, expectedAttemptVersion: 4 };
  const terminalResult = await write(allocated.h, (journal, call) =>
    journal.recordOutcome(allocated.h.issue("outcome", terminal), call),
  );
  assert.equal(terminalResult.kind, "recorded");
  assert.equal(terminalResult.record.version, 5);
  assert.equal(terminalResult.record.outcome.kind, "failed");
  assert.deepEqual(plain(terminalResult.record.binding), plain(unknownResult.record.binding));
  assert.deepEqual(
    plain(terminalResult.record.consumption),
    plain(unknownResult.record.consumption),
  );
  parseTurnJournalV1("attempt", terminalResult.record);
  assert.equal(
    (
      await allocated.app.query(
        "SELECT count(*)::int AS count FROM occ.turn_journal_reservations WHERE reservation_ref=$1",
        [released.attempt.reservationRef],
      )
    ).rows[0].count,
    0,
  );
  const historicalRelease = (
    await allocated.app.query(
      "SELECT request,record FROM occ.turn_journal_operations WHERE operation_kind='release' AND operation_ref=$1",
      [releasedObservation.releaseOperationRef],
    )
  ).rows[0];
  assert.deepEqual(historicalRelease.request, releasedObservation);
  assert.deepEqual(historicalRelease.record, releasedObservation);
  assert.ok(historicalRelease.record.expectedAttemptVersion < terminalResult.record.version);
  const compatibilityCommon = [];
  const compatibilityFull = [];
  for (let index = 0; index < 5; index++) {
    const prepare = (values) => {
      const rejected = allocated.legacy.changedIncoming(values, (incoming) => {
        incoming.envelope.retryMetadata = {};
      }).rejected;
      const { name, extra } = journalScopeCompatibilityCases(values, rejected)[index];
      values.identity.workspace.scope = {
        ...values.identity.workspace.scope,
        extra: allocated.legacy.copy(extra),
      };
      values.reservation.scope = {
        ...values.reservation.scope,
        extra: allocated.legacy.copy(extra),
      };
      parseTurnJournalV1("attempt", commonAttemptRecord(values));
      if (name === "nested SDK rejection")
        assert.deepEqual(plain(parseRejectedAdmissionV1(extra).envelope.retryMetadata), {});
    };
    compatibilityCommon.push(await admitted(allocated, prepare));
    const fullValues = await admitted(allocated, prepare);
    assert.equal(
      (
        await write(allocated.h, (journal, call) =>
          journal.recordDispatchIntent(allocated.h.issue("dispatch", fullValues.binding), call),
        )
      ).kind,
      "recorded",
    );
    assert.equal(
      (
        await write(allocated.h, (journal, call) =>
          journal.consumeAttempt(
            allocated.h.issue("consumption", {
              operation: fullValues.consumption,
              binding: fullValues.binding,
            }),
            call,
          ),
        )
      ).kind,
      "claim-pending",
    );
    parseTurnJournalV1("attempt", (await attemptRow(allocated.app, fullValues)).row.record);
    compatibilityFull.push(fullValues);
  }
  const rejectedValues = allocated.legacy.changedIncoming(
    allocated.legacy.journalValues(await allocated.legacy.seedJournalOwner(allocated.h.state)),
    (incoming) => {
      incoming.envelope.retryMetadata = {};
    },
  );
  const rejection = await write(allocated.h, (journal, call) =>
    journal.admitRejected(allocated.h.issue("rejected", rejectedValues.rejected), call),
  );
  assert.equal(rejection.kind, "recorded");
  assert.deepEqual(plain(rejection.record.envelope.retryMetadata), {});
  return {
    accepted,
    cancelled,
    consumed,
    released,
    releasedObservation,
    compatibilityCommon,
    compatibilityFull,
    rejectedValues,
  };
}

async function begin(client) {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout='3s'");
  await client.query("SET LOCAL statement_timeout='15s'");
}

async function assertConversion(query, cases, before, insideTransaction = true) {
  const accepted = await attemptRow(query, cases.accepted);
  const cancelled = await attemptRow(query, cases.cancelled);
  assert.deepEqual(accepted.row.record, commonAttemptRecord(cases.accepted));
  assert.deepEqual(cancelled.row.record, {
    ...commonAttemptRecord(cases.cancelled),
    version: 2,
    outcome: {
      kind: "cancelled",
      stage: "before-dispatch",
      evidenceRef: cases.cancelled.cancellation.operationRef,
    },
  });
  assert.equal(Number(accepted.row.version), 1);
  assert.equal(Number(cancelled.row.version), 2);
  parseTurnJournalV1("attempt", accepted.row.record);
  parseTurnJournalV1("attempt", cancelled.row.record);
  const priorAttempts = before.turn_journal_attempts.map(JSON.parse);
  const convertedRows = [accepted.row, cancelled.row];
  for (const values of cases.compatibilityCommon) {
    const converted = (await attemptRow(query, values)).row;
    assert.deepEqual(converted.record, commonAttemptRecord(values));
    assert.equal(Number(converted.version), 1);
    parseTurnJournalV1("attempt", converted.record);
    convertedRows.push(converted);
  }
  for (const current of convertedRows) {
    const prior = priorAttempts.find((row) => row.attempt_ref === current.attempt_ref);
    const { record: priorRecord, version: priorVersion, ...priorIdentity } = prior;
    const { record: currentRecord, version: currentVersion, ...currentIdentity } = current;
    assert.equal(priorRecord, null);
    assert.equal(Number(priorVersion), 1);
    assert.deepEqual(
      currentIdentity,
      priorIdentity,
      "Conversion preserves all original scope, owner, receipt, first-received time and reservation columns.",
    );
    assert.equal(currentRecord.version, Number(currentVersion));
  }
  const after = await snapshot(query);
  assert.equal(after.turn_journal_attempts.length, before.turn_journal_attempts.length);
  for (const values of [cases.consumed, cases.released, ...cases.compatibilityFull]) {
    const full = await attemptRow(query, values);
    assert.deepEqual(
      full.row,
      priorAttempts.find((row) => row.attempt_ref === values.attempt.attemptRef),
    );
    assert.equal(
      after.turn_journal_attempts.find(
        (bytes) => JSON.parse(bytes).attempt_ref === values.attempt.attemptRef,
      ),
      before.turn_journal_attempts.find(
        (bytes) => JSON.parse(bytes).attempt_ref === values.attempt.attemptRef,
      ),
      "Full history, including later metadata after release, must remain byte-identical.",
    );
  }
  const commonBindings = [cases.accepted, cases.cancelled, ...cases.compatibilityCommon];
  const dispatchedBindings = [cases.consumed, cases.released, ...cases.compatibilityFull];
  for (const [values, dispatched] of [
    ...commonBindings.map((values) => [values, false]),
    ...dispatchedBindings.map((values) => [values, true]),
  ]) {
    const record = (await attemptRow(query, values)).row.record;
    parseTurnJournalV1("attempt", record);
    for (const key of ["dispatchOperationRef", "authorityDecisionRef", "expiresAt"])
      assert.equal(Object.hasOwn(record.binding, key), dispatched);
    const projected = await query.query(
      "SELECT occ.turn_journal_phase_common_binding($1::jsonb) AS binding",
      [JSON.stringify(record)],
    );
    assert.equal(projected.rows.length, 1);
    assert.deepEqual(
      projected.rows[0].binding,
      commonAttemptRecord(values).binding,
      "The installed SQL function retains the complete original common binding, including extension payloads.",
    );
    for (const key of ["dispatchOperationRef", "authorityDecisionRef", "expiresAt"])
      assert.equal(Object.hasOwn(projected.rows[0].binding, key), false);
  }
  const historicalRelease = (
    await query.query(
      "SELECT request,record FROM occ.turn_journal_operations WHERE operation_kind='release' AND operation_ref=$1",
      [cases.releasedObservation.releaseOperationRef],
    )
  ).rows[0];
  assert.deepEqual(historicalRelease.request, cases.releasedObservation);
  assert.deepEqual(historicalRelease.record, cases.releasedObservation);
  assert.equal(historicalRelease.record.expectedAttemptVersion, 4);
  assert.equal((await attemptRow(query, cases.released)).row.record.version, 5);
  assert.equal(
    (
      await query.query(
        "SELECT count(*)::int AS count FROM occ.turn_journal_reservations WHERE reservation_ref=$1",
        [cases.released.attempt.reservationRef],
      )
    ).rows[0].count,
    0,
  );
  for (const table of tables.filter((name) => name !== "turn_journal_attempts"))
    assert.deepEqual(
      after[table],
      before[table],
      `Conversion must retain original ${table} bytes, including cancellation attribution and held reservations.`,
    );
  assert.equal(await recordIsRequired(query), true);
  if (insideTransaction) await query.query("SET CONSTRAINTS ALL IMMEDIATE");
}

test(
  "PostgreSQL phase upgrade rollback probes preserve original history and abort incompatible legacy rows",
  options("rollback"),
  async (t) => {
    const allocated = await allocation(t);
    const cases = await legacyCases(allocated);
    const before = await snapshot(allocated.app);
    await t.test(
      "both genuine NULL states convert atomically and full history is unchanged inside a rolled-back migration",
      async () => {
        const client = await allocated.migration.connect();
        const rollback = new Error("intentional rollback after original executor conversion");
        try {
          await assert.rejects(
            allocated.runner.drizzle(client).transaction(
              async (transaction) => {
                await runMigrationsInTransaction(transaction, {
                  migrationsFolder: allocated.runner.migrationsFolder,
                });
                await assertConversion(client, cases, before);
                const insideHistory = await migrationHistory(client);
                assert.equal(insideHistory.length, allocated.history.length + 1);
                throw rollback;
              },
              { isolationLevel: "read committed" },
            ),
            (error) => error === rollback,
          );
        } finally {
          client.release();
        }
        assert.deepEqual(await snapshot(allocated.app), before);
        assert.deepEqual(await migrationHistory(allocated.migration), allocated.history);
        assert.equal(await recordIsRequired(allocated.app), false);
      },
    );
    await t.test(
      "failure after conversion rolls back converted records, installed guards and final NOT NULL",
      async () => {
        const client = await allocated.migration.connect();
        try {
          await assert.rejects(
            allocated.runner.drizzle(client).transaction(
              async (transaction) => {
                await runMigrationsInTransaction(transaction, {
                  migrationsFolder: allocated.runner.migrationsFolder,
                });
                await assertConversion(client, cases, before);
                await client.query("SELECT 1/0");
              },
              { isolationLevel: "read committed" },
            ),
            (error) => error.code === "22012",
          );
        } finally {
          client.release();
        }
        assert.deepEqual(await snapshot(allocated.app), before);
        assert.deepEqual(await migrationHistory(allocated.migration), allocated.history);
        assert.equal(await recordIsRequired(allocated.app), false);
        assert.equal(
          (
            await allocated.migration.query(
              "SELECT to_regprocedure('occ.turn_journal_phase_value_valid(text,jsonb)') AS phase",
            )
          ).rows[0].phase,
          null,
        );
      },
    );
    await t.test(
      "borrowed executor refuses transaction objects used in autocommit, nested and wrong-isolation transactions before publishing migration history",
      async () => {
        const client = await allocated.migration.connect();
        const database = allocated.runner.drizzle(client);
        try {
          let stale;
          await database.transaction(
            async (transaction) => {
              stale = transaction;
            },
            { isolationLevel: "read committed" },
          );
          await assert.rejects(
            runMigrationsInTransaction(stale, {
              migrationsFolder: allocated.runner.migrationsFolder,
            }),
            (error) =>
              error instanceof MigrationExecutionError &&
              error.code === "MIGRATION_FAILED" &&
              error.outcome === "not-committed",
          );
          await assert.rejects(
            database.transaction(
              (transaction) =>
                runMigrationsInTransaction(transaction, {
                  migrationsFolder: allocated.runner.migrationsFolder,
                }),
              { isolationLevel: "repeatable read" },
            ),
            (error) =>
              error instanceof MigrationExecutionError &&
              error.code === "MIGRATION_ISOLATION_REQUIRED",
          );
          await database.transaction(
            async (transaction) => {
              await assert.rejects(
                transaction.transaction((nested) =>
                  runMigrationsInTransaction(nested, {
                    migrationsFolder: allocated.runner.migrationsFolder,
                  }),
                ),
                (error) =>
                  error instanceof MigrationExecutionError &&
                  error.code === "MIGRATION_TRANSACTION_REQUIRED",
              );
            },
            { isolationLevel: "read committed" },
          );
        } finally {
          client.release();
        }
        assert.deepEqual(await snapshot(allocated.app), before);
        assert.deepEqual(await migrationHistory(allocated.migration), allocated.history);
        assert.equal(await recordIsRequired(allocated.app), false);
      },
    );
    await t.test(
      "concurrent original migration owners apply pending work after a predecessor rolls back",
      async () => {
        const firstClient = await allocated.migration.connect();
        const secondClient = await allocated.migration.connect();
        const firstReady = deferred();
        const releaseFirst = deferred();
        const secondStarted = deferred();
        const firstAbort = new Error("roll back first migration owner");
        const secondAbort = new Error("roll back second migration owner");
        let first;
        let second;
        let secondApplied = false;
        try {
          first = allocated.runner.drizzle(firstClient).transaction(
            async (transaction) => {
              await runMigrationsInTransaction(transaction, {
                migrationsFolder: allocated.runner.migrationsFolder,
              });
              await assertConversion(firstClient, cases, before);
              firstReady.resolve(
                (await firstClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
              );
              await releaseFirst.promise;
              throw firstAbort;
            },
            { isolationLevel: "read committed" },
          );
          first.catch((error) => firstReady.reject(error));
          const firstPid = await firstReady.promise;
          second = allocated.runner.drizzle(secondClient).transaction(
            async (transaction) => {
              secondStarted.resolve(
                (await secondClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
              );
              await runMigrationsInTransaction(transaction, {
                migrationsFolder: allocated.runner.migrationsFolder,
              });
              secondApplied = true;
              await assertConversion(secondClient, cases, before);
              assert.equal(
                (await migrationHistory(secondClient)).length,
                allocated.history.length + 1,
              );
              throw secondAbort;
            },
            { isolationLevel: "read committed" },
          );
          second.catch((error) => secondStarted.reject(error));
          const secondPid = await secondStarted.promise;
          let blocked = false;
          const deadline = performance.now() + 2_000;
          while (performance.now() < deadline) {
            blocked = (
              await allocated.app.query("SELECT $1=ANY(pg_blocking_pids($2)) AS blocked", [
                firstPid,
                secondPid,
              ])
            ).rows[0].blocked;
            if (blocked) break;
            await new Promise((resolveWait) => setTimeout(resolveWait, 10));
          }
          assert.equal(blocked, true);
          assert.equal(secondApplied, false);
          releaseFirst.resolve();
          await assert.rejects(first, (error) => error === firstAbort);
          await assert.rejects(second, (error) => error === secondAbort);
          assert.equal(secondApplied, true);
        } finally {
          releaseFirst.resolve();
          await Promise.allSettled([first, second]);
          firstClient.release();
          secondClient.release();
        }
        assert.deepEqual(await snapshot(allocated.app), before);
        assert.deepEqual(await migrationHistory(allocated.migration), allocated.history);
        assert.equal(await recordIsRequired(allocated.app), false);
      },
    );
    await t.test(
      "direct whole SQL and the ordinary Drizzle runner refuse at the exact mandatory codec sentinel",
      async () => {
        assert.equal(
          allocated.sql.split("--> statement-breakpoint")[phaseUpgradeDescriptor.statementIndex],
          phaseCodecSentinel,
        );
        for (const entrypoint of ["whole SQL", "ordinary Drizzle"]) {
          const client = await allocated.migration.connect();
          try {
            if (entrypoint === "whole SQL") {
              await begin(client);
              try {
                await assert.rejects(client.query(allocated.sql), refusedSentinel);
              } finally {
                await client.query("ROLLBACK");
              }
            } else {
              await assert.rejects(
                allocated.runner.migrate(allocated.runner.drizzle(client), {
                  migrationsFolder: allocated.runner.migrationsFolder,
                }),
                refusedSentinel,
              );
            }
          } finally {
            client.release();
          }
          assert.deepEqual(await snapshot(allocated.app), before, entrypoint);
          assert.deepEqual(
            await migrationHistory(allocated.migration),
            allocated.history,
            entrypoint,
          );
          assert.equal(await recordIsRequired(allocated.app), false, entrypoint);
        }
      },
    );
    await t.test(
      "a genuine old full execution outcome without consumption aborts preflight before either eligible NULL row changes",
      async () => {
        const incompatible = await admitted(allocated);
        assert.equal(
          (
            await write(allocated.h, (journal, call) =>
              journal.recordDispatchIntent(
                allocated.h.issue("dispatch", incompatible.binding),
                call,
              ),
            )
          ).kind,
          "recorded",
        );
        const operation = { ...incompatible.outcome, expectedAttemptVersion: 2 };
        const outcome = await write(allocated.h, (journal, call) =>
          journal.recordOutcome(allocated.h.issue("outcome", operation), call),
        );
        assert.equal(
          outcome.kind,
          "recorded",
          "The preserved original owner must actually produce this historical row; no trigger bypass is used.",
        );
        assert.equal(outcome.record.outcome.stage, "execution");
        assert.equal(outcome.record.consumption, null);
        assert.throws(() => parseTurnJournalV1("attempt", outcome.record));
        const incompatibleBefore = await snapshot(allocated.app);
        await assert.rejects(
          runMigrations(allocated.migration, {
            migrationsFolder: allocated.runner.migrationsFolder,
          }),
          (error) =>
            error instanceof MigrationExecutionError &&
            error.code === "MIGRATION_FAILED" &&
            error.outcome === "not-committed",
        );
        assert.deepEqual(await snapshot(allocated.app), incompatibleBefore);
        assert.deepEqual(await migrationHistory(allocated.migration), allocated.history);
        assert.equal((await attemptRow(allocated.app, cases.accepted)).row.record, null);
        assert.equal((await attemptRow(allocated.app, cases.cancelled)).row.record, null);
        assert.equal(await recordIsRequired(allocated.app), false);
      },
    );
  },
);

test(
  "PostgreSQL supported migration runner commits phase history and excludes a waiting old writer",
  options("commit"),
  async (t) => {
    const allocated = await allocation(t);
    const cases = await legacyCases(allocated);
    const stale = allocated.legacy.journalValues(
      await allocated.legacy.seedJournalOwner(allocated.h.state),
    );
    const before = await snapshot(allocated.app);
    const runner = allocated.runner;
    assert.ok(
      runner,
      "Committed proof requires the separately supplied supported migration folder.",
    );
    const blocker = await allocated.app.connect();
    let oldWrite;
    let migrationCommand;
    let concurrentMigration;
    let blockerOpen = false;
    try {
      await blocker.query("BEGIN");
      blockerOpen = true;
      // Hold the last maintenance relation so the original executor already
      // owns earlier journal locks before an old writer can enter those tables.
      await blocker.query("LOCK TABLE occ.turn_journal_reservations IN ACCESS SHARE MODE");
      migrationCommand = runMigrations(allocated.migration, {
        migrationsFolder: runner.migrationsFolder,
      });
      void migrationCommand.catch(() => {});
      let migrationQueued = false;
      let migratorPid;
      const migrationDeadline = performance.now() + 2_000;
      while (performance.now() < migrationDeadline) {
        const waiting = (
          await allocated.app.query(
            "SELECT pid FROM pg_locks WHERE relation='occ.turn_journal_reservations'::regclass AND mode='AccessExclusiveLock' AND NOT granted",
          )
        ).rows;
        assert.ok(
          waiting.length <= 1,
          "The allocated database must have one original migration owner.",
        );
        migrationQueued = waiting.length === 1;
        if (migrationQueued) migratorPid = waiting[0].pid;
        if (migrationQueued) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      assert.equal(
        migrationQueued,
        true,
        "The supported runner must request the candidate's actual maintenance lock.",
      );
      const lockedParents = (
        await allocated.app.query(
          "SELECT count(*)::int AS count FROM pg_locks WHERE pid=$1 AND relation IN ('occ.turn_journal_attempts'::regclass,'occ.turn_journal_keys'::regclass,'occ.turn_journal_owners'::regclass) AND mode='AccessExclusiveLock' AND granted",
          [migratorPid],
        )
      ).rows[0].count;
      assert.equal(lockedParents, 3);
      concurrentMigration = runMigrations(allocated.migration, {
        migrationsFolder: runner.migrationsFolder,
      });
      void concurrentMigration.catch(() => {});
      let secondOwnerBlocked = false;
      const secondDeadline = performance.now() + 2_000;
      while (performance.now() < secondDeadline) {
        secondOwnerBlocked = (
          await allocated.app.query(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND $1=ANY(pg_blocking_pids(pid))) AS blocked",
            [migratorPid],
          )
        ).rows[0].blocked;
        if (secondOwnerBlocked) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      assert.equal(
        secondOwnerBlocked,
        true,
        "Concurrent applying owner must wait before reading and selecting pending history.",
      );
      const entered = deferred();
      const call = allocated.h.provenance.call();
      oldWrite = allocated.h.state.transact(async (unit) => {
        const row = await allocated.h.state.queryInTransaction(
          unit,
          "SELECT pg_backend_pid() AS pid",
        );
        entered.resolve(row.rows[0].pid);
        return unit.turnJournal.admit(allocated.h.issue("admission", stale.observation), call);
      });
      oldWrite.catch((error) => entered.reject(error));
      const writerPid = await entered.promise;
      let blocked = false;
      const deadline = performance.now() + 2_000;
      while (performance.now() < deadline) {
        blocked = (
          await allocated.app.query("SELECT $1=ANY(pg_blocking_pids($2)) AS blocked", [
            migratorPid,
            writerPid,
          ])
        ).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      assert.equal(
        blocked,
        true,
        "The actual old owner must queue behind the supported runner's pending exclusive lock.",
      );
      await blocker.query("ROLLBACK");
      blockerOpen = false;
      await migrationCommand;
      await concurrentMigration;
      // The actual original state owner maps SQL state/ownership constraint
      // failures to its public ScopeViolationError before returning.
      await assert.rejects(oldWrite, { name: "ScopeViolationError" });
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK");
      blocker.release();
      await migrationCommand?.catch(() => {});
      await concurrentMigration?.catch(() => {});
      await oldWrite?.catch(() => {});
    }
    await assertConversion(allocated.app, cases, before, false);
    const historyAfter = await migrationHistory(allocated.migration);
    assert.equal(historyAfter.length, allocated.history.length + 1);
    assert.deepEqual(historyAfter.slice(0, -1), allocated.history);
    assert.deepEqual(
      { hash: historyAfter.at(-1).hash, created_at: historyAfter.at(-1).created_at },
      runner.candidate,
    );
    const committedSnapshot = await snapshot(allocated.app);
    const current = journalHarness(allocated.app);
    for (const values of [
      cases.accepted,
      cases.cancelled,
      cases.consumed,
      cases.released,
      ...cases.compatibilityCommon,
      ...cases.compatibilityFull,
    ]) {
      const call = current.provenance.call();
      const found = await current.read(
        (journal) => journal.findAttempt(values.attempt, call),
        call,
      );
      assert.equal(found.kind, "found");
      assert.deepEqual(plain(found.record), (await attemptRow(allocated.app, values)).row.record);
    }
    const call = current.provenance.call();
    const cancellation = await current.read(
      (journal) => journal.findCancellation(cases.cancelled.cancellation, call),
      call,
    );
    assert.equal(cancellation.kind, "found");
    assert.deepEqual(plain(cancellation.operation), cases.cancelled.cancellation);
    const releaseCall = current.provenance.call();
    const releaseReadback = await current.read(
      (journal) => journal.findRelease(cases.releasedObservation, releaseCall),
      releaseCall,
    );
    assert.equal(releaseReadback.kind, "released");
    const rejectedCall = current.provenance.call();
    const rejected = await current.read(
      (journal) =>
        journal.findRejectedAdmission(
          {
            schemaVersion: 1,
            kind: "event",
            installationRef: cases.rejectedValues.locator.installationRef,
            channelInstallationRef: cases.rejectedValues.locator.channelInstallationRef,
            eventKey: cases.rejectedValues.locator.eventKey,
          },
          rejectedCall,
        ),
      rejectedCall,
    );
    assert.equal(rejected.kind, "found");
    assert.deepEqual(plain(rejected.record), cases.rejectedValues.rejected);
    assert.deepEqual(plain(rejected.record.envelope.retryMetadata), {});
    assert.equal(
      (
        await allocated.app.query(
          "SELECT count(*)::int AS count FROM occ.turn_journal_attempts WHERE attempt_ref=$1",
          [stale.attempt.attemptRef],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await allocated.app.query(
          "SELECT count(*)::int AS count FROM occ.turn_journal_owners WHERE installation_id=$1 AND channel_installation_id=$2 AND receipt_ref=$3",
          [
            stale.context.installationRef,
            stale.identity.locator.channelInstallationRef,
            stale.identity.receipt.receiptRef,
          ],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await allocated.app.query(
          "SELECT count(*)::int AS count FROM occ.turn_journal_reservations WHERE reservation_ref=$1",
          [stale.attempt.reservationRef],
        )
      ).rows[0].count,
      0,
    );
    // Exact replay from the current owner preserves the original cancellation;
    // it does not publish a second operation or release held responsibility.
    const replay = await write(current, (journal, exactCall) =>
      journal.commitCancellation(
        current.issue("cancellation", cases.cancelled.cancellation),
        exactCall,
      ),
    );
    assert.equal(replay.kind, "existing");
    assert.deepEqual(plain(replay.operation), cases.cancelled.cancellation);
    assert.equal((await attemptRow(allocated.app, cases.cancelled)).row.record.version, 2);
    assert.equal(
      (
        await allocated.app.query(
          "SELECT count(*)::int AS count FROM occ.turn_journal_reservations WHERE reservation_ref=$1",
          [cases.cancelled.attempt.reservationRef],
        )
      ).rows[0].count,
      1,
    );
    // Reopening the genuine runner must consult its committed history and skip
    // the candidate, preserving history IDs and all converted journal bytes.
    await runMigrations(allocated.migration, {
      migrationsFolder: runner.migrationsFolder,
    });
    assert.deepEqual(await migrationHistory(allocated.migration), historyAfter);
    assert.deepEqual(await snapshot(allocated.app), committedSnapshot);
    // The original transport fixture consumes a real server COMMIT completion.
    // This replay has no pending migration, so it isolates the executor's lost
    // acknowledgement classification without applying a second candidate.
    const proxy = await runtimeCommitAckProxy(allocated.migratorUrl);
    const faultPool = new pg.Pool({
      connectionString: proxy.url,
      max: 1,
      connectionTimeoutMillis: 500,
    });
    let acquired = 0;
    faultPool.on("acquire", () => {
      acquired += 1;
    });
    faultPool.on("error", () => {});
    try {
      proxy.arm();
      await assert.rejects(
        runMigrations(faultPool, { migrationsFolder: runner.migrationsFolder }),
        (error) =>
          error instanceof MigrationExecutionError &&
          error.code === "MIGRATION_COMMIT_UNKNOWN" &&
          error.outcome === "unknown",
      );
      assert.equal(proxy.observedCommit, true);
      assert.equal(
        acquired,
        1,
        "The original executor must not blindly reacquire and retry after an unknown COMMIT.",
      );
    } finally {
      await faultPool.end();
      await proxy.close();
    }
    assert.deepEqual(await migrationHistory(allocated.migration), historyAfter);
    assert.deepEqual(await snapshot(allocated.app), committedSnapshot);
  },
);
