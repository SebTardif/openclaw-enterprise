import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import {
  MigrationExecutionError,
  createMigrationDiagnostics,
  migrationFailureLogFields,
  phaseCodecSentinel,
  phaseUpgradeDescriptor,
  readMigrationCatalog,
  runMigrations,
  runMigrationsInTransaction,
  trackMigrationClient,
} from "../../scripts/turn-journal-phase-upgrade.mjs";

// These cases execute the original catalog reader, refusal paths and client
// ownership controls. Declared control-flow acknowledgments below do not model
// a migration ledger, codec output, SQL success or durable application.
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
// Expected public diagnostic vocabulary from the accepted original-owner scope.
// These values check the production projection; they do not grant authority.
const diagnosticCodes = Object.freeze([
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
    await assert.rejects(runMigrations(pool, { migrationsFolder: reviewedFolder() }), (error) => {
      migrationError("MIGRATION_FAILED")(error);
      assert.deepEqual(migrationFailureLogFields(error), {
        code: "MIGRATION_FAILED",
        outcome: "not-committed",
        operation: "connection-acquire",
      });
      return true;
    });
    assert.equal(attempts, 1);
  },
);

test(
  "acquired client query rejection and its separate error event remain one safe refusal",
  configured,
  async () => {
    const client = new pg.Client();
    const actualQuery = client.query.bind(client);
    const queries = [];
    const releaseArguments = [];
    const idleErrors = [];
    const idleListener = (error) => idleErrors.push(error);
    const connectionFailure = Object.assign(new Error("private acquired connection failure"), {
      code: "08006",
    });
    let acquisitions = 0;
    let networkEntries = 0;
    let escapedEvent;
    let emitted = false;
    let listenersDuringRelease = 0;
    client.connect = () => {
      networkEntries += 1;
      throw new Error("This controlled client must never open a connection.");
    };
    client.query = (...args) => {
      const statement = typeof args[0] === "string" ? args[0] : args[0].text;
      queries.push(statement);
      if (queries.length === 1) {
        assert.equal(statement, "begin isolation level read committed");
        // This single control-flow acknowledgment reaches the real isolation
        // refusal boundary. It is not a server transaction or SQL-success claim.
        return Promise.resolve({ rows: [] });
      }
      const pendingQuery = actualQuery(...args);
      if (!emitted) {
        emitted = true;
        assert.equal(statement, "SHOW transaction_isolation");
        queueMicrotask(() => {
          try {
            // The selected pg.Client implementation rejects its queued query
            // and emits the separate client error; no socket is connected.
            client._handleErrorEvent(connectionFailure);
          } catch (error) {
            escapedEvent = error;
          }
        });
      }
      return pendingQuery;
    };
    client.release = (discard) => {
      releaseArguments.push(discard);
      listenersDuringRelease = client.listenerCount("error");
      // Model only the pool's listener handoff, without acquiring or returning
      // a real database connection. The production owner must retain this one.
      client.on("error", idleListener);
    };
    try {
      await assert.rejects(
        runMigrations(
          {
            async connect() {
              acquisitions += 1;
              return client;
            },
          },
          { migrationsFolder: reviewedFolder() },
        ),
        (error) => {
          migrationError("MIGRATION_FAILED")(error);
          assert.deepEqual(migrationFailureLogFields(error), {
            code: "MIGRATION_FAILED",
            outcome: "not-committed",
            operation: "isolation-query",
            result: "sqlstate:08006",
          });
          return true;
        },
      );
      assert.equal(escapedEvent, undefined);
      assert.equal(emitted, true);
      assert.deepEqual(queries, [
        "begin isolation level read committed",
        "SHOW transaction_isolation",
        "rollback",
      ]);
      assert.equal(acquisitions, 1);
      assert.equal(networkEntries, 0);
      assert.deepEqual(releaseArguments, [true]);
      assert.equal(listenersDuringRelease, 1);
      assert.deepEqual(client.listeners("error"), [idleListener]);
      assert.deepEqual(idleErrors, []);
      assert.equal(client._connected, false);
      assert.equal(client._queryQueue.length, 0);
      assert.equal(client._sentQueryQueue.length, 0);
    } finally {
      client.removeListener("error", idleListener);
      await client.end();
    }
  },
);

// These cases exercise the same lifetime object used by runMigrations. Their
// bodyReturned flags describe controlled owner states, never a real SQL commit.
test("acquired-client error observation ignores opaque payloads and cannot escape", () => {
  const client = new EventEmitter();
  const released = [];
  client.release = (discard) => released.push(discard);
  const lifetime = trackMigrationClient(client);
  let touched = 0;
  const opaque = new Proxy(
    {},
    {
      get() {
        touched += 1;
        throw new Error("private event payload");
      },
      getOwnPropertyDescriptor() {
        touched += 1;
        throw new Error("private event descriptor");
      },
    },
  );
  assert.equal(Object.isFrozen(lifetime), true);
  assert.doesNotThrow(() => client.emit("error", opaque));
  assert.throws(() => lifetime.assertHealthy(), migrationError("MIGRATION_FAILED"));
  assert.throws(() => lifetime.release(false), migrationError("MIGRATION_FAILED"));
  assert.deepEqual(released, [true]);
  assert.equal(client.listenerCount("error"), 0);
  assert.equal(touched, 0);
});

test("falsey acquired-client event payloads still prevent successful release", () => {
  for (const payload of [undefined, null, false, 0, ""]) {
    const client = new EventEmitter();
    const released = [];
    client.release = (discard) => released.push(discard);
    const lifetime = trackMigrationClient(client);
    assert.doesNotThrow(() => client.emit("error", payload));
    assert.throws(() => lifetime.assertHealthy(), migrationError("MIGRATION_FAILED"));
    assert.throws(() => lifetime.release(false), migrationError("MIGRATION_FAILED"));
    assert.deepEqual(released, [true]);
    assert.equal(client.listenerCount("error"), 0);
  }
});

test("clean release transfers listener ownership once and preserves unrelated listeners", () => {
  const client = new EventEmitter();
  const released = [];
  const foreignEvents = [];
  const idleEvents = [];
  const foreign = (error) => foreignEvents.push(error);
  const idle = (error) => idleEvents.push(error);
  client.on("error", foreign);
  client.release = (discard) => {
    released.push(discard);
    assert.equal(client.listenerCount("error"), 2);
    client.on("error", idle);
  };
  const lifetime = trackMigrationClient(client);
  assert.equal(lifetime.assertHealthy(), undefined);
  assert.equal(lifetime.release(false, true), undefined);
  assert.deepEqual(released, [false]);
  assert.deepEqual(client.listeners("error"), [foreign, idle]);
  assert.throws(
    () => lifetime.release(false, true),
    migrationError("MIGRATION_COMMIT_UNKNOWN", "unknown"),
  );
  assert.deepEqual(released, [false]);
  const afterHandoff = new Error("foreign idle observation");
  assert.doesNotThrow(() => client.emit("error", afterHandoff));
  assert.deepEqual(foreignEvents, [afterHandoff]);
  assert.deepEqual(idleEvents, [afterHandoff]);
  assert.deepEqual(client.listeners("error"), [foreign, idle]);
});

test("first query diagnostic survives a separate client event and failing release", () => {
  const client = new EventEmitter();
  const diagnostics = createMigrationDiagnostics();
  const released = [];
  const lifetime = trackMigrationClient(client, diagnostics);
  diagnostics.capture("ledger-publish", { code: "23505" }, { queryFailure: true });
  client.emit("error", new Error("private connection replacement"));
  client.release = (discard) => {
    released.push(discard);
    throw new Error("private release replacement");
  };
  assert.throws(
    () => lifetime.release(false),
    (error) => {
      migrationError("MIGRATION_FAILED")(error);
      const fields = migrationFailureLogFields(error);
      assert.deepEqual(fields, {
        code: "MIGRATION_FAILED",
        outcome: "not-committed",
        operation: "ledger-publish",
        result: "sqlstate:23505",
      });
      assertSafeDiagnostic(fields);
      return true;
    },
  );
  assert.deepEqual(released, [true]);
  assert.equal(client.listenerCount("error"), 0);
});

test("a client fault after the controlled body-return boundary always remains unknown", () => {
  const client = new EventEmitter();
  const diagnostics = createMigrationDiagnostics();
  const released = [];
  client.release = (discard) => released.push(discard);
  const lifetime = trackMigrationClient(client, diagnostics);
  diagnostics.capture(
    "ledger-owner-query",
    new MigrationExecutionError("MIGRATION_OWNER_REQUIRED"),
  );
  client.emit("error", new Error("private post-body failure"));
  for (const action of [() => lifetime.assertHealthy(true), () => lifetime.release(false, true)]) {
    assert.throws(action, (error) => {
      migrationError("MIGRATION_COMMIT_UNKNOWN", "unknown")(error);
      const fields = migrationFailureLogFields(error);
      assert.equal(fields.operation, "ledger-owner-query");
      assert.equal(fields.result, undefined);
      assertSafeDiagnostic(fields);
      return true;
    });
  }
  assert.deepEqual(released, [true]);
  assert.equal(client.listenerCount("error"), 0);
});

test("release-time client error is observed through handoff before success can escape", () => {
  const client = new EventEmitter();
  const released = [];
  const foreignEvents = [];
  const idleEvents = [];
  const foreign = (error) => foreignEvents.push(error);
  const idle = (error) => idleEvents.push(error);
  const releaseError = new Error("private release-time event");
  client.on("error", foreign);
  client.release = (discard) => {
    released.push(discard);
    assert.equal(client.listenerCount("error"), 2);
    client.on("error", idle);
    client.emit("error", releaseError);
  };
  const lifetime = trackMigrationClient(client);
  assert.equal(lifetime.assertHealthy(true), undefined);
  assert.throws(
    () => lifetime.release(false, true),
    (error) => {
      migrationError("MIGRATION_COMMIT_UNKNOWN", "unknown")(error);
      assert.deepEqual(migrationFailureLogFields(error), {
        code: "MIGRATION_COMMIT_UNKNOWN",
        outcome: "unknown",
        operation: "transaction-settlement",
      });
      return true;
    },
  );
  assert.deepEqual(released, [false]);
  assert.deepEqual(foreignEvents, [releaseError]);
  assert.deepEqual(idleEvents, [releaseError]);
  assert.deepEqual(client.listeners("error"), [foreign, idle]);
});

test("release exception without an event cannot turn a controlled post-body result into success", () => {
  const client = new EventEmitter();
  const released = [];
  client.release = (discard) => {
    released.push(discard);
    throw undefined;
  };
  const lifetime = trackMigrationClient(client);
  assert.equal(lifetime.assertHealthy(true), undefined);
  assert.throws(
    () => lifetime.release(false, true),
    migrationError("MIGRATION_COMMIT_UNKNOWN", "unknown"),
  );
  assert.deepEqual(released, [false]);
  assert.equal(client.listenerCount("error"), 0);
});

function assertSafeDiagnostic(fields) {
  assert.equal(Object.isFrozen(fields), true);
  assert.ok(
    Object.keys(fields).every((key) => ["code", "outcome", "operation", "result"].includes(key)),
  );
  // These are the existing controller logger's scalar alphabet and 512-character
  // limit. Checking the projected values does not invoke the logger or provider.
  for (const value of Object.values(fields)) {
    assert.equal(typeof value, "string");
    assert.ok(value.length > 0 && value.length <= 512);
    assert.match(value, /^[A-Za-z0-9]/);
    assert.doesNotMatch(value, /[^A-Za-z0-9._: /@-]/);
  }
}

function queryDiagnostic(error, options = {}) {
  const diagnostics = createMigrationDiagnostics();
  diagnostics.capture("migration-statement", error, { queryFailure: true, ...options });
  const failure = diagnostics.failure(error);
  migrationError("MIGRATION_FAILED")(failure);
  const fields = migrationFailureLogFields(failure);
  assertSafeDiagnostic(fields);
  return fields;
}

test("shared wrapper projection admits exactly the reviewed typed code vocabulary", () => {
  assert.equal(new Set(diagnosticCodes).size, 15);
  for (const code of diagnosticCodes) {
    const fields = migrationFailureLogFields(new MigrationExecutionError(code), "entry-migration");
    assert.deepEqual(fields, {
      code,
      outcome: code === "MIGRATION_COMMIT_UNKNOWN" ? "unknown" : "not-committed",
      operation: "entry-migration",
    });
    assertSafeDiagnostic(fields);
  }
  assert.deepEqual(migrationFailureLogFields(new MigrationExecutionError("UNREVIEWED_CODE")), {
    code: "MIGRATION_FAILED",
    outcome: "not-committed",
    operation: "entry-migration",
  });
  for (const operation of [
    "entry-arguments",
    "entry-configuration",
    "entry-database-url",
    "entry-pg-load",
    "entry-pool-create",
    "entry-migration",
    "entry-reporting",
  ]) {
    const fields = migrationFailureLogFields(new Error("private wrapper error"), operation);
    assert.deepEqual(fields, { code: "MIGRATION_FAILED", operation });
    assertSafeDiagnostic(fields);
  }
});

test("projection never forwards untyped codes, raw error fields or secret-bearing getters", () => {
  const secret = "postgres://private-user:private-password@example.invalid/private-database";
  let touched = 0;
  const opaque = {};
  for (const key of [
    "code",
    "outcome",
    "message",
    "stack",
    "cause",
    "query",
    "params",
    "operation",
    "result",
  ]) {
    Object.defineProperty(opaque, key, {
      get() {
        touched += 1;
        throw new Error(secret);
      },
    });
  }
  const cyclic = { code: "MIGRATION_OWNER_REQUIRED", outcome: "unknown", message: secret };
  cyclic.cause = cyclic;
  for (const error of [undefined, null, 7, secret, opaque, cyclic, new Error(secret)]) {
    const fields = migrationFailureLogFields(error, secret);
    assert.deepEqual(fields, { code: "MIGRATION_FAILED", operation: "entry-migration" });
    assertSafeDiagnostic(fields);
    assert.equal(JSON.stringify(fields).includes(secret), false);
  }
  const typed = new MigrationExecutionError("MIGRATION_OWNER_REQUIRED");
  for (const key of ["message", "stack", "cause", "query", "params", "operation", "result"]) {
    Object.defineProperty(typed, key, {
      get() {
        touched += 1;
        throw new Error(secret);
      },
    });
  }
  assert.deepEqual(migrationFailureLogFields(typed), {
    code: "MIGRATION_OWNER_REQUIRED",
    outcome: "not-committed",
    operation: "entry-migration",
  });
  Object.defineProperty(typed, "code", {
    get() {
      touched += 1;
      throw new Error(secret);
    },
  });
  assert.equal(migrationFailureLogFields(typed).code, "MIGRATION_FAILED");
  assert.equal(touched, 0);
});

test("query diagnostic selects only an exact five-character own-data SQLSTATE", () => {
  for (const code of ["23505", "42P01", "P0001", "XX000", "00000"]) {
    const fields = queryDiagnostic({
      query: "private SQL",
      params: ["private stored value"],
      cause: { code },
    });
    assert.equal(fields.result, `sqlstate:${code}`);
  }
  let touched = 0;
  const codeGetter = Object.defineProperty({}, "code", {
    get() {
      touched += 1;
      return "23505";
    },
  });
  const causeGetter = Object.defineProperty({}, "cause", {
    get() {
      touched += 1;
      return { code: "23505" };
    },
  });
  const cyclic = { code: "malformed" };
  cyclic.cause = cyclic;
  const inaccessible = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("private inaccessible carrier");
      },
    },
  );
  const coercible = {
    toString() {
      touched += 1;
      return "23505";
    },
  };
  for (const error of [
    ...[
      "23505\n",
      "23505\r\n",
      "2350",
      "235050",
      "42p01",
      "２３５０５",
      23505,
      true,
      coercible,
    ].map((code) => ({ code })),
    Object.create({ code: "23505" }),
    codeGetter,
    causeGetter,
    cyclic,
    inaccessible,
    { cause: "private error message" },
    { cause: 23505 },
    { cause: false },
  ]) {
    assert.equal(queryDiagnostic(error).result, undefined);
  }
  assert.equal(touched, 0);
  assert.equal(queryDiagnostic({ code: "23505" }, { queryFailure: false }).result, undefined);
  for (const stage of [
    "transaction-settlement",
    "transaction-entry",
    "codec-import",
    "codec-decode",
  ]) {
    const diagnostics = createMigrationDiagnostics();
    diagnostics.capture(stage, { code: "23505" }, { queryFailure: true });
    assert.equal(
      migrationFailureLogFields(diagnostics.failure(new Error("private nonquery failure"))).result,
      undefined,
    );
  }
});

test("SQLSTATE cause traversal is finite and independent for each invocation", () => {
  const chain = (parents) => {
    let value = { code: "23505" };
    for (let index = 0; index < parents; index += 1) value = { cause: value };
    return value;
  };
  assert.equal(queryDiagnostic(chain(7)).result, "sqlstate:23505");
  assert.equal(queryDiagnostic(chain(8)).result, undefined);
  const first = createMigrationDiagnostics();
  const second = createMigrationDiagnostics();
  first.capture("codec-decode", new Error("private first invocation"));
  second.capture("ledger-publish", { code: "42501" }, { queryFailure: true });
  assert.deepEqual(migrationFailureLogFields(first.failure(new Error("replacement"))), {
    code: "MIGRATION_FAILED",
    outcome: "not-committed",
    operation: "codec-decode",
  });
  assert.deepEqual(migrationFailureLogFields(second.failure(new Error("replacement"))), {
    code: "MIGRATION_FAILED",
    outcome: "not-committed",
    operation: "ledger-publish",
    result: "sqlstate:42501",
  });
});

test("first query diagnostic survives later rollback replacement without retaining the source error", () => {
  const diagnostics = createMigrationDiagnostics();
  assert.equal(Object.isFrozen(diagnostics), true);
  const original = { message: "private query", cause: { code: "23505" } };
  const location = {
    migrationIndex: 28,
    migrationTag: "0028_turn_journal_attempt_phase",
    statementOrdinal: 2,
    queryFailure: true,
  };
  diagnostics.capture("migration-statement", original, location);
  original.cause.code = "40001";
  location.migrationTag = "0000_changed_after_capture";
  diagnostics.capture("transaction-settlement", { code: "40001" }, { queryFailure: true });
  const failure = diagnostics.failure(new Error("private rollback replacement"));
  migrationError("MIGRATION_FAILED")(failure);
  assert.deepEqual(migrationFailureLogFields(failure), {
    code: "MIGRATION_FAILED",
    outcome: "not-committed",
    operation: "migration-statement:migration-28:0028_turn_journal_attempt_phase:statement-2",
    result: "sqlstate:23505",
  });
  assertSafeDiagnostic(migrationFailureLogFields(failure));
});

test("first typed failure code and operation survive rollback replacement while unknown always dominates", () => {
  const diagnostics = createMigrationDiagnostics();
  diagnostics.capture(
    "ledger-owner-query",
    new MigrationExecutionError("MIGRATION_OWNER_REQUIRED"),
  );
  diagnostics.capture("transaction-settlement", new Error("private rollback replacement"));
  const replacement = new Error("private outer rollback error");
  assert.deepEqual(migrationFailureLogFields(diagnostics.failure(replacement)), {
    code: "MIGRATION_OWNER_REQUIRED",
    outcome: "not-committed",
    operation: "ledger-owner-query",
  });
  for (const error of [
    replacement,
    new MigrationExecutionError("MIGRATION_CATALOG_INVALID"),
    null,
  ]) {
    const fields = migrationFailureLogFields(diagnostics.failure(error, true));
    assert.equal(fields.code, "MIGRATION_COMMIT_UNKNOWN");
    assert.equal(fields.outcome, "unknown");
    assertSafeDiagnostic(fields);
  }
  for (const error of [
    new MigrationExecutionError("MIGRATION_FAILED", "unknown"),
    new MigrationExecutionError("UNREVIEWED_CODE", "unknown"),
    new MigrationExecutionError("MIGRATION_COMMIT_UNKNOWN", "not-committed"),
  ]) {
    assert.equal(migrationFailureLogFields(error).code, "MIGRATION_COMMIT_UNKNOWN");
    assert.equal(migrationFailureLogFields(diagnostics.failure(error)).outcome, "unknown");
  }
  const firstUnknown = createMigrationDiagnostics();
  firstUnknown.capture(
    "transaction-settlement",
    new MigrationExecutionError("MIGRATION_COMMIT_UNKNOWN", "unknown"),
  );
  assert.equal(
    migrationFailureLogFields(firstUnknown.failure(new MigrationExecutionError("MIGRATION_FAILED")))
      .outcome,
    "unknown",
  );
  const settlement = createMigrationDiagnostics();
  settlement.capture(
    "transaction-settlement",
    { code: "40001", message: "private replacement" },
    { queryFailure: true },
  );
  assert.deepEqual(migrationFailureLogFields(settlement.failure(new Error("replacement"), true)), {
    code: "MIGRATION_COMMIT_UNKNOWN",
    outcome: "unknown",
    operation: "transaction-settlement",
  });
});

test("diagnostic location is detached, bounded and omitted safely for malformed caller carriers", () => {
  const valid = {
    migrationIndex: 9999,
    migrationTag: `0000_${"a".repeat(123)}`,
    statementOrdinal: Number.MAX_SAFE_INTEGER,
  };
  assert.equal(valid.migrationTag.length, 128);
  assertSafeDiagnostic(queryDiagnostic({ code: "23505" }, valid));
  for (const overrides of [
    { migrationIndex: -1 },
    { migrationIndex: 10000 },
    { migrationIndex: 0.5 },
    { migrationTag: `0000_${"a".repeat(124)}` },
    { migrationTag: "0000_valid\n" },
    { migrationTag: "0000_private?credential=value" },
    { statementOrdinal: -1 },
    { statementOrdinal: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const fields = queryDiagnostic({ code: "23505" }, { ...valid, ...overrides });
    assert.equal(fields.operation, "migration-statement");
    assertSafeDiagnostic(fields);
  }
  let touched = 0;
  const options = {};
  for (const key of ["migrationIndex", "migrationTag", "statementOrdinal", "queryFailure"]) {
    Object.defineProperty(options, key, {
      get() {
        touched += 1;
        throw new Error("private option getter");
      },
    });
  }
  const diagnostics = createMigrationDiagnostics();
  diagnostics.capture("private unexpected stage", { code: "23505" }, options);
  assert.deepEqual(migrationFailureLogFields(diagnostics.failure(new Error("replacement"))), {
    code: "MIGRATION_FAILED",
    outcome: "not-committed",
    operation: "execution",
  });
  assert.equal(touched, 0);
});

test(
  "diagnostic tag bound does not narrow the actual accepted catalog metadata domain",
  configured,
  async (t) => {
    const entry = inertEntry({ tag: `0000_${"a".repeat(124)}` });
    const folder = await inertCatalog(t, [entry]);
    // The real reader accepts this long tag, then rejects the missing mandatory
    // phase. Diagnostic truncation must not turn it into invalid catalog metadata.
    assert.throws(() => readMigrationCatalog(folder), migrationError("MIGRATION_SENTINEL_MISSING"));
    const fields = queryDiagnostic(
      { code: "23505" },
      { migrationIndex: 0, migrationTag: entry.tag, statementOrdinal: 0 },
    );
    assert.equal(fields.operation, "migration-statement");
  },
);

test(
  "actual bad catalog diagnostics are selected before any pool acquisition",
  configured,
  async (t) => {
    let attempted = 0;
    const pool = {
      connect() {
        attempted += 1;
        throw new Error("pool must stay untouched");
      },
    };
    for (const [folder, operation] of [
      [undefined, "catalog-validate"],
      [join(await mkdtemp(join(tmpdir(), "oce-executor-missing-")), "absent"), "catalog-load"],
    ]) {
      if (folder !== undefined)
        t.after(() => rm(join(folder, ".."), { recursive: true, force: true }));
      await assert.rejects(runMigrations(pool, { migrationsFolder: folder }), (error) => {
        migrationError("MIGRATION_CATALOG_INVALID")(error);
        assert.deepEqual(migrationFailureLogFields(error), {
          code: "MIGRATION_CATALOG_INVALID",
          outcome: "not-committed",
          operation,
        });
        return true;
      });
    }
    assert.equal(attempted, 0);
  },
);
