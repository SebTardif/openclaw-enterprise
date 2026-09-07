import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readlink, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { parseTurnJournalV1 } from "../../packages/contracts/src/turn-journal-v1.ts";
import {
  phaseUpgradeDescriptor,
  readMigrationCatalog,
  runMigrations,
  runMigrationsInTransaction,
} from "../../scripts/turn-journal-phase-upgrade.mjs";
import { copy, digest, journalHarness, ref } from "../fixtures/turn-journal-storage/values.mjs";

// These bodies require a separate fresh database allocation. Its original
// migration owner must have established the reviewed prefix through 0029 with
// the corrected 0028 executor before this test starts. No database, role,
// baseline, migration folder or legacy journal row is created by this fixture.
// The retained old source and dependency inventory are checked before import;
// actual old/new stores supply every journal mutation. Their provenance handles
// are controlled backend fixtures, not native, COL or authority producer proof.
const prefix = "OCC_TEST_JOURNAL_STATUS_UPGRADE_";
const mode = process.env[`${prefix}MODE`];
if (mode !== undefined) assert.ok(["rollback", "commit"].includes(mode));
const candidateEntry = Object.freeze({
  idx: 30,
  version: "7",
  when: 1788767620617,
  tag: "0030_turn_journal_status_reconciliation",
  breakpoints: true,
});
const candidateHash = "a59c47ab858f6f660dfaca363e6c820521001df5cd92dfda53c762fb8d7d73b1";
const journalHash = "e854e6db2e15fe30d9daf43f0b1d4846677217c0bb5e5901c5589637f346c54c";
const checkoutJournalHash = "2df6652623dad2e6c3d25bdc58225b2b7fb61b97536e3cda573dc67e97ca57fb";
const legacyAcceptanceHash = "8753fa7b738950135c361b05519cacf6cb3211ef8666004a04359d9ec28fc915";
const legacyInventoryHash = "1018f432b0bf50b084504d841bd6b3b3c0a51571f432ee27d8ecd51a901e6304";
const legacyCommit = "49ca9e3350b19364a4be25cf60b73d1733a3c37a";
const legacySources = Object.freeze({
  "packages/contracts/src/turn-journal-v1.ts":
    "71a6344a88558c39ec43b806a30cc3bf55ed72187530158cb4a10fc629aa7f29",
  "packages/occ/src/turn-journal/postgres.ts":
    "01deadf950575b6748ec0e1bcbc2436e48a6c220e89c3bd0c4cab4093fb8e1c4",
  "packages/occ/src/turn-journal/rows.ts":
    "967cf4460ce491f785e1a40a82e11411949670a1cac8bfa33ddcd90d3a796519",
  "packages/occ/src/turn-journal/store.ts":
    "77f41f4a2341f530b8af9971023d269bd49716b6bed03f9b64cd39d23b2df307",
  "tests/fixtures/turn-journal-storage/values.mjs":
    "b8ab5a0c7cd6b4c679cf9f3a595166eb8c1ec96398d5373ee14dc2a9da001864",
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
const changedFunctions = Object.freeze([
  "occ.turn_journal_delivery_value_matches(jsonb)",
  "occ.turn_journal_delivery_slot_transition()",
  "occ.turn_journal_delivery_history_complete()",
]);
const plain = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const required = (name) => {
  const value = process.env[`${prefix}${name}`];
  assert.ok(value, `Explicit status-upgrade allocation requires ${prefix}${name}.`);
  return value;
};
const selected = (value) => ({
  skip:
    mode === value
      ? false
      : `Select ${prefix}MODE=${value} only with its separately allocated pre-status database.`,
  timeout: 120_000,
});

async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

async function originalLegacySource() {
  const root = required("LEGACY_SOURCE_ROOT");
  assert.ok(isAbsolute(root));
  const acceptancePath = required("LEGACY_CONSUMER_ACCEPTANCE");
  assert.ok(isAbsolute(acceptancePath));
  assert.equal(required("LEGACY_CONSUMER_ACCEPTANCE_SHA256"), legacyAcceptanceHash);
  const acceptanceBytes = await readFile(acceptancePath);
  assert.equal(sha256(acceptanceBytes), legacyAcceptanceHash);
  const acceptance = JSON.parse(acceptanceBytes);
  assert.equal(acceptance.schema, "per10-pg-consumer-acceptance-v1");
  assert.equal(acceptance.sourceCommit, legacyCommit);
  const acceptedRoot = acceptance.roots.find((entry) => entry.root === root);
  assert.ok(acceptedRoot, "Select the genuine preserved pre-status current root.");
  assert.equal(acceptedRoot.inventory.sha256, legacyInventoryHash);
  const inventoryPath = required("LEGACY_INVENTORY");
  assert.equal(inventoryPath, acceptedRoot.inventory.path);
  const inventoryStat = await stat(inventoryPath);
  assert.ok(inventoryStat.isFile());
  assert.equal(inventoryStat.size, acceptedRoot.inventory.bytes);
  assert.ok(inventoryStat.size <= 20 * 1024 * 1024);
  const inventoryBytes = await readFile(inventoryPath);
  assert.equal(sha256(inventoryBytes), legacyInventoryHash);
  const inventory = JSON.parse(inventoryBytes);
  assert.equal(inventory.schema, "per10-runtime-consumer-inventory-v1");
  assert.equal(inventory.sourceRoot, root);
  assert.equal(inventory.files.length, 50_323);
  assert.equal(inventory.links.length, 825);
  for (const entry of inventory.files) {
    const info = await stat(entry.path);
    assert.ok(info.isFile());
    assert.equal(info.size, entry.bytes);
    assert.equal(await fileHash(entry.path), entry.sha256, "Original import closure changed.");
  }
  for (const entry of inventory.links) {
    assert.equal(await readlink(entry.path), entry.target);
    assert.equal(await realpath(entry.path), entry.realpath);
  }
  for (const [path, expected] of Object.entries(legacySources))
    assert.equal(await fileHash(resolve(root, path)), expected);
  // The acceptance's old network-none observation remains historical. This
  // check binds the selected files and normal resolution; it does not create a
  // new offline-import, native-source or old-transaction success observation.
  const fixture = await import(
    pathToFileURL(resolve(root, "tests/fixtures/turn-journal-storage/values.mjs")).href
  );
  for (const name of ["journalHarness", "journalValues", "seedJournalOwner"])
    assert.equal(typeof fixture[name], "function");
  return fixture;
}

// The allocated folder stops at the amendment. The source checkout also has
// later migrations; pin that complete checkout without applying its later tail
// to the separately prepared pre-status database.
function reviewedJournalPrefix(provided, original) {
  assert.equal(sha256(original), checkoutJournalHash, "Current checkout journal changed.");
  assert.equal(sha256(provided), journalHash, "Selected status-upgrade prefix changed.");
  const checkout = JSON.parse(original);
  const selectedJournal = JSON.parse(provided);
  assert.equal(checkout.entries.length, 34);
  assert.equal(selectedJournal.entries.length, 31);
  assert.deepEqual(selectedJournal, {
    ...checkout,
    entries: checkout.entries.slice(0, 31),
  });
  assert.deepEqual(selectedJournal.entries.at(-1), candidateEntry);
  return selectedJournal;
}

async function reviewedCatalog() {
  const migrationsFolder = required("MIGRATIONS_FOLDER");
  assert.ok(isAbsolute(migrationsFolder));
  assert.equal(required("JOURNAL_SHA256"), journalHash);
  assert.equal(required("SQL_SHA256"), candidateHash);
  const provided = await readFile(resolve(migrationsFolder, "meta/_journal.json"));
  const original = await readFile(new URL("../../migrations/meta/_journal.json", import.meta.url));
  reviewedJournalPrefix(provided, original);
  const catalog = readMigrationCatalog(migrationsFolder);
  assert.equal(catalog.length, 31);
  assert.deepEqual(catalog.at(-1).entry, candidateEntry);
  assert.equal(catalog.at(-1).hash, candidateHash);
  assert.equal(catalog.at(-1).phase, false);
  assert.equal(catalog.at(-1).statements.length, 1);
  assert.ok(phaseUpgradeDescriptor);
  assert.equal(
    phaseUpgradeDescriptor.hash,
    "4418e1785eb6d98db22041fcf4b62e9ee248632a4d0a6770addf56ccb91b7ba7",
  );
  for (const migration of catalog) {
    const actual = await readFile(
      new URL(`../../migrations/${migration.entry.tag}.sql`, import.meta.url),
    );
    assert.equal(
      sha256(actual),
      migration.hash,
      "Selected SQL differs from the actual source checkout.",
    );
    if (migration.entry.idx === 29)
      assert.equal(
        migration.hash,
        "f665214e53a99e31eee97b4009bdd54f5de6ec336f9f2b7a74c589cc070ab8e3",
      );
    if (migration.entry.idx === 30) {
      assert.equal(actual.length, 19_676);
      assert.equal(migration.statements[0], actual.toString("utf8"));
    }
  }
  const baseline = catalog
    .slice(0, -1)
    .map(({ hash, entry }) => ({ hash, created_at: String(entry.when) }));
  assert.equal(baseline.length, 30);
  const candidate = { hash: candidateHash, created_at: String(candidateEntry.when) };
  const dependency = createRequire(new URL("../../packages/occ/package.json", import.meta.url));
  return {
    migrationsFolder,
    baseline,
    candidate,
    drizzle: dependency("drizzle-orm/node-postgres").drizzle,
  };
}

// These cases exercise the same metadata gate used before any pool is created.
// They read the actual checkout and never invoke a database or migration runner.
test("status upgrade catalog metadata preserves the selected migration boundary", async (t) => {
  const original = await readFile(new URL("../../migrations/meta/_journal.json", import.meta.url));
  const checkout = JSON.parse(original);
  const encode = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const selectedJournal = { ...checkout, entries: checkout.entries.slice(0, 31) };
  const provided = encode(selectedJournal);

  await t.test("accepts the exact 31-entry prefix of the actual 34-entry checkout", () => {
    const accepted = reviewedJournalPrefix(provided, original);
    assert.equal(accepted.entries.length, 31);
    assert.deepEqual(accepted.entries.at(-1), candidateEntry);
    assert.deepEqual(accepted.entries.slice(0, -1), checkout.entries.slice(0, 30));
  });
  await t.test("refuses the complete checkout as the selected upgrade folder", () => {
    assert.throws(
      () => reviewedJournalPrefix(original, original),
      /Selected status-upgrade prefix changed/,
    );
  });
  await t.test("refuses a 31-entry journal presented as the current checkout", () => {
    assert.throws(
      () => reviewedJournalPrefix(provided, provided),
      /Current checkout journal changed/,
    );
  });
  await t.test("refuses a change in the checkout tail after the selected amendment", () => {
    const changed = JSON.parse(original);
    changed.entries[33].when++;
    assert.throws(
      () => reviewedJournalPrefix(provided, encode(changed)),
      /Current checkout journal changed/,
    );
  });
  await t.test("refuses the historical uncomposed amendment timestamp", () => {
    const changed = JSON.parse(provided);
    changed.entries[30].when = 1788735485501;
    assert.throws(
      () => reviewedJournalPrefix(encode(changed), original),
      /Selected status-upgrade prefix changed/,
    );
  });
  await t.test("refuses an altered entry before the selected amendment", () => {
    const changed = JSON.parse(provided);
    changed.entries[29].when++;
    assert.throws(
      () => reviewedJournalPrefix(encode(changed), original),
      /Selected status-upgrade prefix changed/,
    );
  });
  await t.test("refuses a selected prefix that omits the amendment", () => {
    assert.throws(
      () =>
        reviewedJournalPrefix(
          encode({ ...checkout, entries: checkout.entries.slice(0, 30) }),
          original,
        ),
      /Selected status-upgrade prefix changed/,
    );
  });
  await t.test("refuses a selected prefix that appends a later migration", () => {
    assert.throws(
      () =>
        reviewedJournalPrefix(
          encode({ ...checkout, entries: checkout.entries.slice(0, 32) }),
          original,
        ),
      /Selected status-upgrade prefix changed/,
    );
  });
});

function pairedTarget(value, name) {
  const url = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), name);
  for (const key of url.searchParams.keys())
    assert.ok(!["host", "hostaddr", "port", "dbname", "database", "user", "options"].includes(key));
  return `${url.hostname}:${url.port || "5432"}/${name}`;
}

async function ledger(query) {
  return (
    await query.query(
      "SELECT id,hash,created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id",
    )
  ).rows;
}

async function snapshot(query) {
  const result = {};
  for (const table of tables)
    result[table] = (
      await query.query(
        `SELECT to_jsonb(row_value)::text AS bytes FROM occ.${table} row_value ORDER BY to_jsonb(row_value)::text COLLATE "C"`,
      )
    ).rows.map((row) => row.bytes);
  return result;
}

async function definitions(query) {
  const result = [];
  for (const name of changedFunctions)
    result.push(
      (await query.query("SELECT pg_get_functiondef($1::regprocedure) AS definition", [name]))
        .rows[0].definition,
    );
  return result;
}

async function allocation(t) {
  const name = required("DATABASE_NAME");
  assert.match(name, /(?:^|_)test(?:_|$)/);
  const appUrl = required("DATABASE_URL");
  const migrationUrl = required("MIGRATOR_URL");
  assert.equal(pairedTarget(appUrl, name), pairedTarget(migrationUrl, name));
  const runner = await reviewedCatalog();
  const legacy = await originalLegacySource();
  const app = new pg.Pool({
    connectionString: appUrl,
    max: 2,
    connectionTimeoutMillis: 1000,
    options: "-c timezone=UTC",
  });
  const migration = new pg.Pool({
    connectionString: migrationUrl,
    max: 2,
    connectionTimeoutMillis: 1000,
    options: "-c timezone=UTC",
  });
  t.after(async () => {
    await app.end();
    await migration.end();
  });
  const identify = async (pool) =>
    (
      await pool.query(
        "SELECT current_database() AS database,current_user AS role,d.oid::text AS database_oid,inet_server_addr()::text AS address,inet_server_port() AS port,r.rolsuper,r.rolbypassrls FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()",
      )
    ).rows[0];
  const appIdentity = await identify(app);
  const migrationIdentity = await identify(migration);
  assert.equal(appIdentity.database, name);
  assert.equal(migrationIdentity.database, name);
  for (const key of ["database_oid", "address", "port"])
    assert.equal(appIdentity[key], migrationIdentity[key]);
  assert.equal(appIdentity.rolsuper, false);
  assert.equal(appIdentity.rolbypassrls, false);
  assert.notEqual(appIdentity.role, migrationIdentity.role);
  const owners = (
    await migration.query(
      "SELECT c.relname,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname='occ' AND c.relname=ANY($1::text[])) OR (n.nspname='drizzle' AND c.relname='__drizzle_migrations')",
      [tables],
    )
  ).rows;
  assert.equal(owners.length, tables.length + 1);
  for (const row of owners) assert.equal(row.owner, migrationIdentity.role);
  const history = await ledger(migration);
  assert.deepEqual(
    history.map(({ hash, created_at }) => ({ hash, created_at })),
    runner.baseline,
  );
  for (const table of tables)
    assert.equal(
      (await app.query(`SELECT count(*)::int AS count FROM occ.${table}`)).rows[0].count,
      0,
      "Allocate an empty pre-status journal; this test never resets it.",
    );
  const old = legacy.journalHarness(app);
  assert.ok(
    await old.state.read((view) => view.installations.getInstallation()),
    "The allocation must initialize its real Installation before the test.",
  );
  return { app, migration, runner, history, legacy, old, current: journalHarness(app) };
}

async function write(h, work) {
  const call = h.provenance.call();
  const result = await h.write((journal) => work(journal, call), call);
  assert.equal(result.kind, "committed", "Uncertain or unavailable writes are not retried.");
  return result.value;
}

async function read(h, work) {
  const call = h.provenance.call();
  return h.read((journal) => work(journal, call), call);
}

async function reserve(h, operation) {
  return write(h, (journal, call) => journal.reserveDelivery(h.issue("delivery", operation), call));
}

async function record(h, outcome) {
  return write(h, (journal, call) => journal.recordDelivery(outcome, call));
}

async function legacyAttempt(allocated) {
  const { legacy, old } = allocated;
  const values = legacy.journalValues(await legacy.seedJournalOwner(old.state));
  const admitted = await write(old, (journal, call) =>
    journal.admit(old.issue("admission", values.observation), call),
  );
  assert.equal(admitted.kind, "recorded");
  assert.equal(admitted.record.decision.kind, "accepted");
  assert.equal(
    (
      await write(old, (journal, call) =>
        journal.recordDispatchIntent(old.issue("dispatch", values.binding), call),
      )
    ).kind,
    "recorded",
  );
  assert.equal(
    (
      await write(old, (journal, call) =>
        journal.consumeAttempt(
          old.issue("consumption", { operation: values.consumption, binding: values.binding }),
          call,
        ),
      )
    ).kind,
    "claim-pending",
  );
  const observation = {
    ...values.outcome,
    outcome: {
      kind: "outcome-unknown",
      stage: "execution",
      evidenceRef: legacy.ref("legacy-unknown"),
    },
  };
  const result = await write(old, (journal, call) =>
    journal.recordOutcome(old.issue("outcome", observation), call),
  );
  assert.equal(result.kind, "recorded");
  assert.equal(result.record.version, 4);
  assert.equal(result.record.outcome.kind, "outcome-unknown");
  return values;
}

async function legacyCase(allocated, kind) {
  const values = await legacyAttempt(allocated);
  const operation = {
    ...values.delivery,
    operationRef: ref("legacy-status-create"),
    slot: "outcome-status",
  };
  assert.equal(Object.hasOwn(operation, "statusNoticeCode"), false);
  const reserved = await reserve(allocated.old, operation);
  assert.equal(reserved.kind, "reserved", "The actual old writer must establish this history.");
  const providerMessageRef = ref("legacy-known-message");
  const first = { operation, reserved, outcome: null };
  const operations = [first];
  if (!kind.startsWith("pending-create")) {
    first.outcome = {
      operation,
      deliveryAttemptRef: reserved.deliveryAttemptRef,
      outcome: { kind: "delivered", providerMessageRef },
    };
    assert.equal((await record(allocated.old, first.outcome)).kind, "recorded");
  }
  if (kind.startsWith("update")) {
    const update = {
      ...operation,
      operationRef: ref("legacy-status-update"),
      outputRef: ref("legacy-update-output"),
      outputDigest: digest(),
      operation: { kind: "update", providerMessageRef },
    };
    const updateReserved = await reserve(allocated.old, update);
    assert.equal(
      updateReserved.kind,
      "reserved",
      "A genuine old refusal cannot be replaced by a seeded row.",
    );
    assert.equal(updateReserved.attemptNumber, 1);
    assert.equal(update.outcomeVersion, operation.outcomeVersion);
    const entry = { operation: update, reserved: updateReserved, outcome: null };
    operations.push(entry);
    if (kind === "update-delivered") {
      entry.outcome = {
        operation: update,
        deliveryAttemptRef: updateReserved.deliveryAttemptRef,
        outcome: { kind: "delivered", providerMessageRef },
      };
      assert.equal((await record(allocated.old, entry.outcome)).kind, "recorded");
    }
  }
  return { kind, values, operations, providerMessageRef };
}

async function legacyCases(allocated) {
  const cases = [];
  for (const kind of [
    "delivered-create",
    "pending-create-delivered",
    "pending-create-unknown",
    "update-delivered",
    "update-pending",
  ])
    cases.push(await legacyCase(allocated, kind));
  return cases;
}

async function publicHistory(h, cases) {
  for (const seed of cases) {
    for (const entry of seed.operations) {
      parseTurnJournalV1("deliveryOperation", entry.operation);
      assert.equal(Object.hasOwn(entry.operation, "statusNoticeCode"), false);
      const found = await read(h, (journal, call) => journal.findDelivery(entry.operation, call));
      if (entry.outcome) {
        assert.equal(found.kind, "recorded");
        assert.deepEqual(plain(found.record), entry.outcome);
        assert.equal(Object.hasOwn(found.record.operation, "statusNoticeCode"), false);
        assert.equal((await record(h, entry.outcome)).kind, "existing");
      } else {
        assert.equal(found.kind, "pending");
        assert.deepEqual(plain(found.operation), entry.operation);
      }
      const replayed = await reserve(h, entry.operation);
      assert.equal(
        replayed.kind,
        "existing",
        "Historical replay cannot issue a new delivery attempt.",
      );
      assert.deepEqual(plain(replayed.state), plain(found));
    }
  }
}

async function deliveryRows(query, seed) {
  const values = [seed.values.attempt.installationRef, seed.values.attempt.attemptRef];
  return {
    slot: (
      await query.query(
        "SELECT * FROM occ.turn_journal_deliveries WHERE installation_id=$1 AND attempt_ref=$2 AND slot='outcome-status'",
        values,
      )
    ).rows,
    history: (
      await query.query(
        "SELECT * FROM occ.turn_journal_delivery_attempts WHERE installation_id=$1 AND attempt_ref=$2 AND slot='outcome-status' ORDER BY delivery_attempt_ref",
        values,
      )
    ).rows,
  };
}

async function settlePending(allocated, seed, outcomeKind) {
  const entry = seed.operations.at(-1);
  assert.equal(entry.outcome, null);
  const before = await deliveryRows(allocated.app, seed);
  const outcome = {
    operation: entry.operation,
    deliveryAttemptRef: entry.reserved.deliveryAttemptRef,
    outcome:
      outcomeKind === "delivered"
        ? { kind: "delivered", providerMessageRef: seed.providerMessageRef }
        : { kind: "delivery-unknown" },
  };
  const settled = await record(allocated.current, outcome);
  assert.equal(settled.kind, "recorded");
  assert.deepEqual(plain(settled.record), outcome);
  entry.outcome = outcome;
  const after = await deliveryRows(allocated.app, seed);
  for (const key of ["slot", "history"])
    assert.deepEqual(
      after[key].map(({ outcome: ignored, ...headers }) => headers),
      before[key].map(({ outcome: ignored, ...headers }) => headers),
    );
  assert.equal(after.slot[0].update_used, seed.kind.startsWith("update"));
  await publicHistory(allocated.current, [seed]);
  const changed = {
    ...outcome,
    outcome: { kind: "delivered", providerMessageRef: ref("different-message") },
  };
  assert.equal((await record(allocated.current, changed)).kind, "conflict");
  assert.deepEqual(await deliveryRows(allocated.app, seed), after);
}

async function publishCompletion(allocated, seed) {
  const { current } = allocated;
  const { values } = seed;
  const before = await read(current, (journal, call) => journal.findAttempt(values.attempt, call));
  assert.equal(before.kind, "found");
  assert.equal(before.record.outcome.kind, "outcome-unknown");
  assert.equal(
    (await write(current, (journal, call) => journal.allocateCheckpoint(values.allocation, call)))
      .kind,
    "allocated",
  );
  const completion = copy(values.completion);
  completion.operation.expectedAttemptVersion = before.record.version;
  completion.pendingDelivery.outcomeVersion = before.record.version + 1;
  const result = await write(current, (journal, call) =>
    journal.publishCompleted(current.issue("completion", completion), call),
  );
  assert.equal(result.kind, "published");
  assert.equal(result.record.outcomeVersion, before.record.version + 1);
  assert.equal(result.record.head.creationRef, values.head.creationRef);
  const after = await read(current, (journal, call) => journal.findAttempt(values.attempt, call));
  assert.equal(after.kind, "found");
  assert.equal(after.record.outcome.kind, "completed");
  assert.equal(after.record.version, result.record.outcomeVersion);
  assert.deepEqual(plain(after.record.binding), plain(before.record.binding));
  return after.record.version;
}

function classificationGuard(error) {
  const seen = new Set();
  for (let current = error, depth = 0; current && depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    if (
      current.code === "23514" &&
      current.message === "Turn journal status classification is not established"
    )
      return true;
    current = current.cause;
  }
  return false;
}

test(
  "status amendment rollback restores the real prior guards, ledger and accepted legacy history",
  selected("rollback"),
  async (t) => {
    const allocated = await allocation(t);
    const cases = await legacyCases(allocated);
    const before = await snapshot(allocated.app);
    const previousDefinitions = await definitions(allocated.migration);
    const client = await allocated.migration.connect();
    const rollback = new Error("intentional status migration rollback");
    try {
      await assert.rejects(
        allocated.runner.drizzle(client).transaction(
          async (transaction) => {
            const result = await runMigrationsInTransaction(transaction, {
              migrationsFolder: allocated.runner.migrationsFolder,
            });
            assert.deepEqual(result, { applied: 1, previouslyApplied: 30 });
            assert.deepEqual(await snapshot(client), before);
            assert.notDeepEqual(await definitions(client), previousDefinitions);
            assert.deepEqual(
              (await ledger(client)).map(({ hash, created_at }) => ({ hash, created_at })),
              [...allocated.runner.baseline, allocated.runner.candidate],
            );
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
    assert.deepEqual(await definitions(allocated.migration), previousDefinitions);
    assert.deepEqual(await ledger(allocated.migration), allocated.history);
    await publicHistory(allocated.old, cases);
    assert.deepEqual(await snapshot(allocated.app), before);
    // A new real old-writer reservation after rollback proves the old guard is
    // active; merely comparing SQL text does not qualify restored behavior.
    const afterRollback = await legacyCase(allocated, "delivered-create");
    await publicHistory(allocated.old, [afterRollback]);
  },
);

test(
  "status amendment preserves old delivery history while excluding new unclassified sends",
  selected("commit"),
  async (t) => {
    const allocated = await allocation(t);
    const cases = await legacyCases(allocated);
    const before = await snapshot(allocated.app);
    const previousDefinitions = await definitions(allocated.migration);
    // Use the actual fixed executor once. Any failure/unknown COMMIT propagates;
    // this fixture never retries an uncertain application or synthesizes a row.
    const applied = await runMigrations(allocated.migration, {
      migrationsFolder: allocated.runner.migrationsFolder,
    });
    assert.deepEqual(applied, { applied: 1, previouslyApplied: 30 });
    assert.deepEqual(
      (await ledger(allocated.migration)).map(({ hash, created_at }) => ({ hash, created_at })),
      [...allocated.runner.baseline, allocated.runner.candidate],
    );
    assert.notDeepEqual(await definitions(allocated.migration), previousDefinitions);
    assert.deepEqual(
      await snapshot(allocated.app),
      before,
      "The amendment must not classify or rewrite accepted history.",
    );

    await t.test(
      "new reader and exact replay preserve delivered, pending and already-used legacy operations",
      async () => {
        await publicHistory(allocated.current, cases);
        assert.deepEqual(await snapshot(allocated.app), before);
        for (const seed of cases.filter((value) => value.kind.startsWith("update"))) {
          const rows = await deliveryRows(allocated.app, seed);
          assert.equal(rows.slot.length, 1);
          assert.equal(rows.history.length, 2);
          assert.equal(rows.slot[0].update_used, true);
          assert.equal(rows.history[0].operation.outcomeVersion, 4);
          assert.equal(rows.history[1].operation.outcomeVersion, 4);
        }
      },
    );

    await t.test(
      "accepted legacy pending creates settle to delivered or unknown without a new reservation",
      async () => {
        await settlePending(
          allocated,
          cases.find((seed) => seed.kind === "pending-create-delivered"),
          "delivered",
        );
        await settlePending(
          allocated,
          cases.find((seed) => seed.kind === "pending-create-unknown"),
          "delivery-unknown",
        );
      },
    );

    await t.test(
      "a previously accepted legacy update settles once and retains its used allowance",
      async () => {
        const seed = cases.find((value) => value.kind === "update-pending");
        await settlePending(allocated, seed, "delivered");
        const entry = seed.operations.at(-1);
        const denied = { ...entry.operation, operationRef: ref("new-unclassified-update") };
        const rows = await deliveryRows(allocated.app, seed);
        assert.equal((await reserve(allocated.current, denied)).kind, "denied");
        assert.deepEqual(await deliveryRows(allocated.app, seed), rows);
      },
    );

    await t.test(
      "real completion does not turn an unclassified predecessor into reconciliation authority",
      async () => {
        const seed = cases.find((value) => value.kind === "delivered-create");
        const outcomeVersion = await publishCompletion(allocated, seed);
        const previous = seed.operations[0].operation;
        const update = {
          ...previous,
          operationRef: ref("classified-reconciliation"),
          outputRef: ref("resolved-output"),
          outputDigest: digest(),
          outcomeVersion,
          statusNoticeCode: "resolved-completed",
          operation: { kind: "update", providerMessageRef: seed.providerMessageRef },
        };
        parseTurnJournalV1("deliveryOperation", update);
        const rows = await deliveryRows(allocated.app, seed);
        assert.equal((await reserve(allocated.current, update)).kind, "conflict");
        const { statusNoticeCode: ignored, ...unclassified } = update;
        assert.equal((await reserve(allocated.current, unclassified)).kind, "denied");
        assert.deepEqual(await deliveryRows(allocated.app, seed), rows);
        await publicHistory(allocated.current, [seed]);
      },
    );

    await t.test(
      "the limited-role genuine old writer reaches the new SQL refusal and rolls back every proposed row",
      async () => {
        const values = await legacyAttempt(allocated);
        const operation = {
          ...values.delivery,
          operationRef: ref("old-writer-new-status"),
          slot: "outcome-status",
        };
        const beforeRefusal = await snapshot(allocated.app);
        assert.equal((await reserve(allocated.current, operation)).kind, "denied");
        assert.deepEqual(await snapshot(allocated.app), beforeRefusal);
        const call = allocated.old.provenance.call();
        // The genuine fixture's original state transaction exposes the actual SQL
        // exception, unlike the store's intentionally opaque unavailable result.
        await assert.rejects(
          allocated.old.mutate((journal) =>
            journal.reserveDelivery(allocated.old.issue("delivery", operation), call),
          ),
          classificationGuard,
        );
        assert.deepEqual(await snapshot(allocated.app), beforeRefusal);
      },
    );

    await t.test(
      "exact supported-executor replay changes no ledger, guard or journal history",
      async () => {
        const previous = await snapshot(allocated.app);
        const history = await ledger(allocated.migration);
        const guards = await definitions(allocated.migration);
        assert.deepEqual(
          await runMigrations(allocated.migration, {
            migrationsFolder: allocated.runner.migrationsFolder,
          }),
          { applied: 0, previouslyApplied: 31 },
        );
        assert.deepEqual(await ledger(allocated.migration), history);
        assert.deepEqual(await definitions(allocated.migration), guards);
        assert.deepEqual(await snapshot(allocated.app), previous);
      },
    );
  },
);
