import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MigrationExecutionError,
  phaseCodecSentinel,
  phaseUpgradeDescriptor,
  readMigrationCatalog,
  runMigrations,
  runMigrationsInTransaction,
} from "../../scripts/turn-journal-phase-upgrade.mjs";

// These cases execute the original catalog reader and refusal paths. They do
// not simulate transactions, a migration ledger, codecs or durable application.
// The owner must materialize its descriptor before configured catalog cases run.
const configured = {
  skip:
    phaseUpgradeDescriptor === null
      ? "The original migration owner has not materialized the reviewed descriptor."
      : false,
};
const unconfigured = { skip: phaseUpgradeDescriptor !== null };
const breakpoint = "--> statement-breakpoint";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const migrationError =
  (code, outcome = "not-committed") =>
  (error) => {
    assert.ok(error instanceof MigrationExecutionError);
    assert.equal(error.name, "MigrationExecutionError");
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    assert.equal(error.message, "The migration did not complete successfully.");
    assert.equal(error.cause, undefined);
    return true;
  };
const reviewedFolder = () => {
  const folder = process.env.OCC_TEST_JOURNAL_PHASE_UPGRADE_MIGRATIONS_FOLDER;
  assert.ok(folder, "Configured catalog checks require the explicitly reviewed migration folder.");
  return folder;
};
const inertEntry = (overrides = {}) => ({
  idx: 0,
  version: "7",
  when: 1,
  tag:
    phaseUpgradeDescriptor?.entry?.tag === "0000_executor_inert"
      ? "0000_executor_other"
      : "0000_executor_inert",
  breakpoints: true,
  ...overrides,
});

async function inertCatalog(t, entries, statements = new Map()) {
  const folder = await mkdtemp(join(tmpdir(), "oce-executor-catalog-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await mkdir(join(folder, "meta"));
  await writeFile(
    join(folder, "meta/_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries,
    }),
  );
  for (const entry of entries) {
    // Temporary files contain inert test statements or the aborting sentinel,
    // never copied production DDL. No applying API receives this folder.
    assert.match(entry.tag, /^[0-9]{4,}_[a-z0-9_]+$/);
    await writeFile(join(folder, `${entry.tag}.sql`), statements.get(entry.tag) ?? "SELECT 1;\n");
  }
  return folder;
}

test("migration sentinel bytes identify an unconditional original-codec refusal", () => {
  assert.equal(
    phaseCodecSentinel,
    "\nDO $turn_journal_codec_step$\nBEGIN\n  RAISE EXCEPTION 'This migration requires the original locked journal codec step'\n    USING ERRCODE = '0A000';\nEND;\n$turn_journal_codec_step$;\n",
  );
  assert.equal(phaseCodecSentinel.includes(breakpoint), false);
});

test(
  "unconfigured original descriptor refuses catalogs without inspecting caller values",
  unconfigured,
  () => {
    let coerced = 0;
    const opaque = {
      [Symbol.toPrimitive]() {
        coerced += 1;
        throw new Error("caller carrier");
      },
    };
    for (const folder of [undefined, null, "relative", "/absent-reviewed-catalog", opaque]) {
      assert.throws(
        () => readMigrationCatalog(folder),
        migrationError("MIGRATION_DESCRIPTOR_UNCONFIGURED"),
      );
    }
    assert.equal(coerced, 0);
  },
);

test(
  "unconfigured applying APIs refuse before borrowed owner or pool access and ignore caller replacement hooks",
  unconfigured,
  async () => {
    let touched = 0;
    let hookCalled = 0;
    const forbiddenOwner = new Proxy(
      {},
      {
        get() {
          touched += 1;
          throw new Error("private connection value must remain unread");
        },
      },
    );
    const options = {
      migrationsFolder: "/absent-reviewed-catalog",
      descriptor: { hash: "caller-proposed-value" },
      preflight() {
        hookCalled += 1;
      },
    };
    await assert.rejects(
      runMigrations(forbiddenOwner, options),
      migrationError("MIGRATION_DESCRIPTOR_UNCONFIGURED"),
    );
    await assert.rejects(
      runMigrationsInTransaction(forbiddenOwner, options),
      migrationError("MIGRATION_DESCRIPTOR_UNCONFIGURED"),
    );
    assert.equal(touched, 0);
    assert.equal(hookCalled, 0);
  },
);

test(
  "configured original reader binds exact reviewed bytes and returns a detached deeply frozen catalog",
  configured,
  async () => {
    const folder = reviewedFolder();
    const catalog = readMigrationCatalog(folder);
    const journal = JSON.parse(await readFile(join(folder, "meta/_journal.json"), "utf8"));
    assert.equal(Object.isFrozen(catalog), true);
    assert.deepEqual(
      catalog.map((migration) => migration.entry),
      journal.entries,
    );
    for (const migration of catalog) {
      const source = await readFile(join(folder, `${migration.entry.tag}.sql`), "utf8");
      assert.equal(migration.hash, hash(source));
      assert.equal(migration.statements.join(breakpoint), source);
      assert.equal(Object.isFrozen(migration), true);
      assert.equal(Object.isFrozen(migration.entry), true);
      assert.equal(Object.isFrozen(migration.statements), true);
      assert.throws(() => {
        migration.entry.when += 1;
      }, TypeError);
      assert.throws(() => {
        migration.statements[0] = "SELECT 2;";
      }, TypeError);
    }
    const selected = catalog.filter((migration) => migration.phase);
    assert.equal(selected.length, 1);
    assert.deepEqual(selected[0].entry, phaseUpgradeDescriptor.entry);
    assert.equal(selected[0].hash, phaseUpgradeDescriptor.hash);
    assert.equal(selected[0].statements[phaseUpgradeDescriptor.statementIndex], phaseCodecSentinel);
    assert.equal(
      catalog
        .flatMap((migration) => migration.statements)
        .filter((statement) => statement.includes("$turn_journal_codec_step$")).length,
      1,
    );
    assert.deepEqual(readMigrationCatalog(folder), catalog);
  },
);

test(
  "configured catalog rejects nonabsolute inputs and malformed finite metadata",
  configured,
  async (t) => {
    for (const folder of [undefined, null, {}, [], "relative"])
      assert.throws(
        () => readMigrationCatalog(folder),
        migrationError("MIGRATION_CATALOG_INVALID"),
      );
    const cases = [
      [],
      [inertEntry({ idx: 1 })],
      [inertEntry({ version: "6" })],
      [inertEntry({ when: 1.5 })],
      [inertEntry({ when: Number.MAX_SAFE_INTEGER + 1 })],
      [inertEntry({ breakpoints: false })],
      [inertEntry({ annotation: "closed metadata" })],
      [inertEntry(), inertEntry({ idx: 1 })],
      [inertEntry(), inertEntry({ idx: 1, tag: "0001_executor_inert", when: 1 })],
    ];
    for (const entries of cases) {
      const folder = await inertCatalog(t, entries);
      assert.throws(
        () => readMigrationCatalog(folder),
        migrationError("MIGRATION_CATALOG_INVALID"),
      );
    }
  },
);

test(
  "configured catalog cannot accept an inert prefix lacking the fixed phase sentinel",
  configured,
  async (t) => {
    const folder = await inertCatalog(t, [inertEntry()]);
    assert.throws(() => readMigrationCatalog(folder), migrationError("MIGRATION_SENTINEL_MISSING"));
  },
);

test(
  "configured catalog refuses exact or altered sentinel markers in an unselected migration",
  configured,
  async (t) => {
    for (const statement of [
      phaseCodecSentinel,
      phaseCodecSentinel.trim(),
      `SELECT 1;${breakpoint}${phaseCodecSentinel}`,
    ]) {
      const entry = inertEntry();
      const folder = await inertCatalog(t, [entry], new Map([[entry.tag, statement]]));
      assert.throws(
        () => readMigrationCatalog(folder),
        migrationError("MIGRATION_SENTINEL_MISMATCH"),
      );
    }
  },
);

test(
  "fixed descriptor metadata cannot authorize different SQL even with a matching sentinel",
  configured,
  async (t) => {
    const original = readMigrationCatalog(reviewedFolder());
    const entries = original.map((migration) => ({ ...migration.entry }));
    const candidate = entries.find((entry) => entry.tag === phaseUpgradeDescriptor.entry.tag);
    assert.ok(candidate);
    const statements = Array.from(
      { length: phaseUpgradeDescriptor.statementIndex + 1 },
      () => "SELECT 1;\n",
    );
    statements[phaseUpgradeDescriptor.statementIndex] = phaseCodecSentinel;
    const synthetic = statements.join(breakpoint);
    assert.notEqual(hash(synthetic), phaseUpgradeDescriptor.hash);
    const folder = await inertCatalog(t, entries, new Map([[candidate.tag, synthetic]]));
    assert.throws(
      () => readMigrationCatalog(folder),
      migrationError("MIGRATION_DESCRIPTOR_MISMATCH"),
    );
  },
);

test(
  "configured applying API rejects an ordinary object before executing a transaction statement",
  configured,
  async () => {
    let statements = 0;
    const ordinary = {
      execute() {
        statements += 1;
        throw new Error("no transaction owner");
      },
    };
    await assert.rejects(
      runMigrationsInTransaction(ordinary, { migrationsFolder: reviewedFolder() }),
      migrationError("MIGRATION_TRANSACTION_REQUIRED"),
    );
    assert.equal(statements, 0);
  },
);

test(
  "configured pool acquisition failure remains not committed and hides its source error without retry",
  configured,
  async () => {
    let attempts = 0;
    const acquisitionFailure = new Error("private connection credential or stored value");
    const pool = {
      connect() {
        attempts += 1;
        throw acquisitionFailure;
      },
    };
    await assert.rejects(
      runMigrations(pool, { migrationsFolder: reviewedFolder() }),
      migrationError("MIGRATION_FAILED"),
    );
    assert.equal(attempts, 1);
  },
);
