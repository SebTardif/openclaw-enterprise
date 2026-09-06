import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fields = Object.freeze({
  schemaVersion: [1, 1],
  seed: [1, 4_294_967_295],
  agents: [1, 32],
  retainedTurnsPerAgent: [1, 1_024],
  uncertainAgents: [0, 32],
  replyBytes: [0, 65_536],
  clients: [1, 16],
  operationsPerClient: [1, 4_096],
  hotKeyPercent: [0, 100],
  readPercent: [0, 100],
  duplicatePercent: [0, 100],
  uncertainReadPercent: [0, 100],
  maxRunMs: [1, 600_000],
});

function invalidConfig() {
  throw new Error("Invalid retained journal workload configuration.");
}

/** Finite workload controls; these are measurement limits, never store budgets. */
export function parseWorkloadConfig(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    invalidConfig();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== Object.keys(fields).length) invalidConfig();
  const copy = {};
  for (const key of keys) {
    if (typeof key !== "string" || !Object.hasOwn(fields, key)) invalidConfig();
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !("value" in property) || !property.enumerable) invalidConfig();
    const [minimum, maximum] = fields[key];
    if (
      !Number.isSafeInteger(property.value) ||
      Object.is(property.value, -0) ||
      property.value < minimum ||
      property.value > maximum
    ) {
      invalidConfig();
    }
    copy[key] = property.value;
  }
  if (
    copy.clients > copy.agents ||
    copy.uncertainAgents > copy.agents ||
    copy.readPercent + copy.duplicatePercent > 100 ||
    (copy.uncertainReadPercent > 0 && copy.uncertainAgents === 0) ||
    (copy.readPercent + copy.duplicatePercent < 100 && copy.uncertainAgents === copy.agents) ||
    copy.agents * copy.retainedTurnsPerAgent + copy.uncertainAgents > 16_384 ||
    copy.clients * copy.operationsPerClient > 32_768
  ) {
    invalidConfig();
  }
  // Fixed field order also makes equal configurations produce the same digest.
  return Object.freeze(Object.fromEntries(Object.keys(fields).map((key) => [key, copy[key]])));
}

function randomSequence(seed) {
  let state = seed >>> 0;
  return (exclusiveMaximum) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % exclusiveMaximum;
  };
}

/** Describe legal cohort locators without manufacturing journal authority. */
export function createWorkloadPlan(input) {
  const config = parseWorkloadConfig(input);
  const random = randomSequence(config.seed);
  const nextTurn = new Array(config.agents).fill(config.retainedTurnsPerAgent);
  const select = (size) => (random(100) < config.hotKeyPercent ? 0 : random(size));
  const clients = [];
  for (let clientId = 0; clientId < config.clients; clientId++) {
    const operations = [];
    for (let index = 0; index < config.operationsPerClient; index++) {
      const choice = random(100);
      let kind;
      let agentIndex;
      let turnIndex;
      if (choice < config.readPercent) {
        const uncertain = random(100) < config.uncertainReadPercent;
        kind = uncertain ? "uncertain-attempt-read" : "completion-read";
        agentIndex = select(uncertain ? config.uncertainAgents : config.agents);
        turnIndex = uncertain ? config.retainedTurnsPerAgent : select(config.retainedTurnsPerAgent);
      } else if (choice < config.readPercent + config.duplicatePercent) {
        kind = "duplicate-admission";
        agentIndex = select(config.agents);
        turnIndex = select(config.retainedTurnsPerAgent);
      } else {
        kind = "append-completed-turn";
        agentIndex = config.uncertainAgents + (clientId % (config.agents - config.uncertainAgents));
        turnIndex = nextTurn[agentIndex]++;
      }
      operations.push(Object.freeze({ index, kind, agentIndex, turnIndex }));
    }
    clients.push(Object.freeze({ clientId, operations: Object.freeze(operations) }));
  }
  return Object.freeze({
    schemaVersion: 1,
    evidence: "planned-only",
    configSha256: createHash("sha256").update(JSON.stringify(config), "utf8").digest("hex"),
    dataset: Object.freeze({
      agents: config.agents,
      retainedTurns: config.agents * config.retainedTurnsPerAgent,
      uncertainAttempts: config.uncertainAgents,
      totalAttempts: config.agents * config.retainedTurnsPerAgent + config.uncertainAgents,
      replyBytes: config.replyBytes,
    }),
    clients: Object.freeze(clients),
  });
}

/** Nearest-rank quantiles of observed monotonic milliseconds, not target latency. */
export function summarizeLatencies(samplesMs) {
  if (
    !Array.isArray(samplesMs) ||
    Object.getPrototypeOf(samplesMs) !== Array.prototype ||
    samplesMs.length > 32_768
  ) {
    throw new Error("Invalid latency samples.");
  }
  const sorted = [];
  for (let index = 0; index < samplesMs.length; index++) {
    const property = Object.getOwnPropertyDescriptor(samplesMs, String(index));
    if (
      !property ||
      !("value" in property) ||
      !property.enumerable ||
      !Number.isFinite(property.value) ||
      property.value < 0 ||
      Object.is(property.value, -0)
    ) {
      throw new Error("Invalid latency samples.");
    }
    sorted.push(property.value);
  }
  sorted.sort((a, b) => a - b);
  const count = sorted.length;
  let meanMs = null;
  if (count) {
    // Sorted nonnegative values keep every intermediate mean within the range.
    meanMs = sorted.reduce((mean, value, index) => mean + (value - mean) / (index + 1), 0);
    if (!Number.isFinite(meanMs)) throw new Error("Invalid latency samples.");
  }
  const percentile = (fraction) => (count ? sorted[Math.ceil(count * fraction) - 1] : null);
  return Object.freeze({
    count,
    minMs: count ? sorted[0] : null,
    maxMs: count ? sorted[count - 1] : null,
    meanMs,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  });
}

const help = `Retained journal workload planner

Usage:
  node tools/benchmarks/retained-journal-cost-v1.mjs --plan CONFIG.json
  node tools/benchmarks/retained-journal-cost-v1.mjs --run CONFIG.json --output REPORT.json
  node tools/benchmarks/retained-journal-cost-v1.mjs --help

--plan validates finite synthetic workload controls and prints deterministic cohort
locators. It does not connect to a database, create journal rows, or report measured
latency, WAL growth, provider flushes, capacity or lost-acknowledgment fault evidence.
`;

const root = fileURLToPath(new URL("../../", import.meta.url));
const relations = Object.freeze([
  "turn_journal_owners",
  "turn_journal_keys",
  "turn_journal_incoming_links",
  "turn_journal_attempts",
  "turn_journal_heads",
  "turn_journal_operations",
  "turn_journal_reservations",
  "turn_journal_deliveries",
  "turn_journal_delivery_attempts",
]);
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Explicit local selection only; validation never opens a connection. */
export function parseMeasurementSelection(env) {
  if (env === null || typeof env !== "object")
    throw new Error("Repository measurements require a valid explicit local database selection.");
  const prefix = "OCC_RETAINED_JOURNAL_";
  const values = Object.fromEntries(
    ["DATABASE_URL", "DATABASE_NAME", "DATABASE_OID", "DATABASE_ROLE", "RUN_REF"].map((name) => [
      name,
      env[`${prefix}${name}`],
    ]),
  );
  const invalid = () => {
    throw new Error("Repository measurements require a valid explicit local database selection.");
  };
  if (
    Object.values(values).some(
      (value) => typeof value !== "string" || !value || value.length > 4_096,
    )
  )
    invalid();
  let url;
  try {
    url = new URL(values.DATABASE_URL);
  } catch {
    invalid();
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.search ||
    url.hash ||
    !url.port ||
    !url.username ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(values.DATABASE_NAME) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(values.DATABASE_ROLE) ||
    !/^[1-9][0-9]{0,9}$/.test(values.DATABASE_OID) ||
    Number(values.DATABASE_OID) > 4_294_967_295 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(values.RUN_REF)
  )
    invalid();
  try {
    if (
      decodeURIComponent(url.pathname.slice(1)) !== values.DATABASE_NAME ||
      decodeURIComponent(url.username) !== values.DATABASE_ROLE
    )
      invalid();
  } catch {
    invalid();
  }
  return Object.freeze({
    connectionString: values.DATABASE_URL,
    databaseName: values.DATABASE_NAME,
    databaseOid: values.DATABASE_OID,
    databaseRole: values.DATABASE_ROLE,
    runRef: values.RUN_REF,
  });
}

export function validateMeasurementPlan(plan) {
  const operations = plan.clients.flatMap((client) => client.operations);
  const appends = operations.filter(
    (operation) => operation.kind === "append-completed-turn",
  ).length;
  if (operations.length > 4_096 || plan.dataset.totalAttempts + appends > 2_048) {
    throw new Error(
      "Plan exceeds the measurement profile: 4096 operations and 2048 initial plus append attempts.",
    );
  }
  return Object.freeze({
    plannedOperations: operations.length,
    maximumGeneratedAttempts: plan.dataset.totalAttempts + appends,
  });
}

async function readConfiguration(path) {
  try {
    const file = await open(path, "r");
    try {
      if (!(await file.stat()).isFile()) invalidConfig();
      const bytes = Buffer.alloc(16_385);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > 16_384) invalidConfig();
      return parseWorkloadConfig(JSON.parse(bytes.subarray(0, length).toString("utf8")));
    } finally {
      await file.close();
    }
  } catch {
    throw new Error("Cannot read a valid bounded workload configuration.");
  }
}

async function sourceIdentity() {
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 262_144 }).trim();
  const paths = [
    "tools/benchmarks/retained-journal-cost-v1.mjs",
    "tests/fixtures/retained-journal-cost-v1/values.mjs",
    "tests/fixtures/turn-journal-storage/values.mjs",
    "packages/occ/src/turn-journal/store.ts",
    "packages/occ/src/turn-journal/postgres.ts",
    "packages/occ/src/state/postgres-state.ts",
    "packages/contracts/src/turn-journal-v1.ts",
    "package.json",
    "pnpm-lock.yaml",
  ];
  const files = [];
  for (const path of paths) {
    const handle = await open(resolve(root, path), "r");
    try {
      files.push({ path, sha256: digest(await handle.readFile()) });
    } finally {
      await handle.close();
    }
  }
  return {
    commit: git(["rev-parse", "HEAD"]),
    tree: git(["rev-parse", "HEAD^{tree}"]),
    dirtyPaths: git(["status", "--porcelain=v1", "--untracked-files=all"]),
    node: process.version,
    files,
    build: "Node direct TypeScript source; no emitted build",
  };
}

async function checkTarget(pool, selected) {
  const client = await pool.connect();
  try {
    const {
      rows: [target],
    } = await client.query(`SELECT current_database() AS name,
      d.oid::text AS oid,current_user AS role,r.rolsuper,r.rolcreatedb,r.rolcreaterole,
      r.rolreplication,r.rolbypassrls,has_schema_privilege(current_user,'occ','CREATE') AS can_create
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`);
    if (
      !target ||
      target.name !== selected.databaseName ||
      target.oid !== selected.databaseOid ||
      target.role !== selected.databaseRole ||
      target.rolsuper ||
      target.rolcreatedb ||
      target.rolcreaterole ||
      target.rolreplication ||
      target.rolbypassrls ||
      target.can_create
    ) {
      throw new Error("Selected target or limited application role does not match.");
    }
    const {
      rows: [activity],
    } = await client.query(
      "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datid=$1::oid AND pid<>pg_backend_pid()",
      [selected.databaseOid],
    );
    if (activity.count !== "0") throw new Error("Selected database has other clients.");
    const {
      rows: [installation],
    } = await client.query("SELECT count(*)::text AS count FROM occ.installation");
    if (installation.count !== "0")
      throw new Error("Measurement requires a separately prepared empty database.");
    for (const relation of relations) {
      const {
        rows: [row],
      } = await client.query(`SELECT count(*)::text AS count FROM occ.${relation}`);
      if (row.count !== "0") throw new Error("Measurement requires empty journal tables.");
    }
    const { rows: settings } = await client.query(
      "SELECT name,setting,unit FROM pg_settings WHERE name=ANY($1::text[]) ORDER BY name",
      [
        [
          "server_version",
          "fsync",
          "synchronous_commit",
          "full_page_writes",
          "wal_level",
          "wal_compression",
          "track_io_timing",
          "track_wal_io_timing",
          "shared_buffers",
          "work_mem",
          "max_connections",
          "random_page_cost",
          "effective_cache_size",
          "autovacuum",
          "checkpoint_timeout",
          "max_wal_size",
          "statement_timeout",
          "lock_timeout",
        ],
      ],
    );
    return {
      name: target.name,
      oid: target.oid,
      role: target.role,
      otherClientsAtPreflight: 0,
      settings,
    };
  } finally {
    client.release();
  }
}

async function snapshotStorage(pool) {
  const tables = [];
  for (const relation of relations) {
    const {
      rows: [row],
    } = await pool.query(`SELECT count(*)::text AS rows,
      pg_relation_size('occ.${relation}'::regclass)::text AS heap_bytes,
      pg_table_size('occ.${relation}'::regclass)::text AS table_bytes,
      pg_indexes_size('occ.${relation}'::regclass)::text AS index_bytes,
      pg_total_relation_size('occ.${relation}'::regclass)::text AS total_bytes FROM occ.${relation}`);
    tables.push({ relation, ...row });
  }
  let wal;
  try {
    const {
      rows: [row],
    } = await pool.query("SELECT pg_current_wal_lsn()::text AS lsn");
    wal = { status: "observed", lsn: row.lsn, scope: "cluster-wide-unisolated" };
  } catch {
    wal = { status: "unmeasured", reason: "WAL position unavailable" };
  }
  return { tables, wal };
}

export function storageDelta(before, after) {
  if (
    !Array.isArray(before?.tables) ||
    !Array.isArray(after?.tables) ||
    before.tables.length !== after.tables.length ||
    new Set(before.tables.map((table) => table.relation)).size !== before.tables.length ||
    new Set(after.tables.map((table) => table.relation)).size !== after.tables.length
  ) {
    throw new Error("Incomplete storage snapshot.");
  }
  const result = [];
  for (const previous of before.tables) {
    const next = after.tables.find((table) => table.relation === previous.relation);
    if (!next) throw new Error("Incomplete storage snapshot.");
    const changes = {};
    for (const key of ["rows", "heap_bytes", "table_bytes", "index_bytes", "total_bytes"]) {
      if (
        typeof previous[key] !== "string" ||
        typeof next[key] !== "string" ||
        !/^\d+$/.test(previous[key]) ||
        !/^\d+$/.test(next[key])
      )
        throw new Error("Invalid storage counter.");
      changes[key] = (BigInt(next[key]) - BigInt(previous[key])).toString();
    }
    result.push({ relation: previous.relation, ...changes });
  }
  return result;
}

async function capturePlans(pool, manifest) {
  const captured = [];
  const completed = manifest.entries.find((entry) => entry.stage === "completed-released");
  const uncertain = manifest.entries.find((entry) => entry.stage === "outcome-unknown-unreleased");
  // Read-only diagnostic EXPLAIN inputs mirror the exact original repository
  // lookup shapes. They are not intercepted queries or substitutes for its reads.
  if (completed) {
    captured.push({
      method: "findCompletion/getOperation",
      sql: "SELECT * FROM occ.turn_journal_operations WHERE installation_id=$1 AND operation_kind=$2 AND operation_ref=$3",
      parameters: [
        completed.attempt.installationRef,
        "completion",
        completed.operationRefs.completion,
      ],
    });
    captured.push({
      method: "admit/findOwner",
      sql: "SELECT o.* FROM occ.turn_journal_keys k JOIN occ.turn_journal_owners o USING (installation_id,channel_installation_id,receipt_ref) WHERE k.installation_id=$1 AND k.channel_installation_id=$2 AND k.key_kind=$3 AND k.key_digest=$4",
      parameters: [
        completed.attempt.installationRef,
        completed.channelInstallationRef,
        "event",
        completed.eventKey,
      ],
    });
  }
  if (uncertain)
    captured.push({
      method: "findAttempt",
      sql: "SELECT * FROM occ.turn_journal_attempts WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND conversation_ref=$4 AND turn_ref=$5 AND attempt_ref=$6 AND reservation_ref=$7",
      parameters: [
        "installationRef",
        "namespaceRef",
        "agentRef",
        "conversationRef",
        "turnRef",
        "attemptRef",
        "reservationRef",
      ].map((key) => uncertain.attempt[key]),
    });
  const plans = [];
  for (const { sql, parameters, method } of captured) {
    const parameterJson = JSON.stringify(parameters);
    const identity = {
      method,
      sqlSha256: digest(sql),
      sql,
      parameterSha256: digest(parameterJson),
      parameterBytes: Buffer.byteLength(parameterJson),
      phase: "after-measurement",
      executesQuery: false,
      origin: "reviewed original repository lookup shape; diagnostic EXPLAIN only; not intercepted",
    };
    try {
      const result = await pool.query(`EXPLAIN (FORMAT JSON) ${sql}`, parameters);
      const plan = result.rows[0]?.["QUERY PLAN"];
      if (!plan || Buffer.byteLength(JSON.stringify(plan)) > 65_536) throw new Error();
      plans.push({ ...identity, status: "observed", plan });
    } catch {
      plans.push({ ...identity, status: "unmeasured", reason: "plan unavailable" });
    }
  }
  return plans;
}

async function runMeasurement(config, selected, outputPath) {
  const plan = createWorkloadPlan(config);
  const bounds = validateMeasurementPlan(plan);
  const source = await sourceIdentity();
  const output = await open(outputPath, "wx", 0o600);
  let pool;
  let workload;
  let observedConnections = 0;
  let signalHandler;
  let runTimer;
  const cancellation = new AbortController();
  const report = {
    schemaVersion: 1,
    evidence: "synthetic-repository-measurement",
    execution: "not-started",
    runRef: selected.runRef,
    createdAt: new Date().toISOString(),
    source,
    config,
    plan,
    bounds,
    stage: "preflight",
    requestedDatabase: {
      name: selected.databaseName,
      oid: selected.databaseOid,
      role: selected.databaseRole,
    },
    cases: [],
    unmeasured: [
      "native canonical flush",
      "workspace synchronization",
      "device fsync latency",
      "isolated SQL COMMIT acknowledgment duration",
      "authentic attribution",
      "cross-store capacity reservation",
      "predispatch attempt projection",
      "lost-ACK fault injection",
    ],
  };
  const save = async () => {
    if (workload) report.dataset = workload.manifest();
    report.observedPoolConnections = observedConnections;
    const encoded = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    if (encoded.length > 16 * 1_024 * 1_024)
      throw new Error("Measurement report exceeds its 16 MiB bound.");
    await output.truncate(0);
    await output.write(encoded, 0, encoded.length, 0);
    await output.sync();
  };
  try {
    await save();
    const requireOcc = createRequire(new URL("../../packages/occ/package.json", import.meta.url));
    const pg = requireOcc("pg");
    pool = new pg.Pool({
      connectionString: selected.connectionString,
      max: config.clients,
      application_name: "oce-retained-journal-cost-v1",
      connectionTimeoutMillis: 250,
      statement_timeout: 10_000,
      lock_timeout: 3_000,
      idleTimeoutMillis: 1_000,
    });
    pool.on("connect", () => {
      observedConnections++;
    });
    pool.on("error", () => cancellation.abort());
    report.database = await checkTarget(pool, selected);
    report.empty = await snapshotStorage(pool);
    const { createRepositoryWorkload } =
      await import("../../tests/fixtures/retained-journal-cost-v1/values.mjs");
    workload = await createRepositoryWorkload(pool, config, cancellation.signal);
    signalHandler = () => cancellation.abort();
    process.on("SIGINT", signalHandler);
    process.on("SIGTERM", signalHandler);
    runTimer = setTimeout(() => cancellation.abort(), config.maxRunMs);
    report.execution = "setup-in-progress";
    report.stage = "setup";
    await save();
    const setupStarted = performance.now();
    const setup = await workload.setup();
    report.setup = { ...setup, elapsedMs: performance.now() - setupStarted };
    if (report.setup.outcome !== "completed") throw new Error("Repository setup did not complete.");
    report.before = await snapshotStorage(pool);
    report.execution = "measurement-in-progress";
    report.stage = "measurement";
    await save();
    const started = performance.now();
    const clients = await Promise.allSettled(
      plan.clients.map(async (client) => {
        for (const operation of client.operations) {
          if (cancellation.signal.aborted || performance.now() - started >= config.maxRunMs) break;
          const began = performance.now();
          let result;
          try {
            result = await workload.execute(operation);
          } catch {
            result = { outcome: "unexpected-error", details: { stage: "repository-operation" } };
            cancellation.abort();
          }
          report.cases.push({
            clientId: client.clientId,
            ...operation,
            ...result,
            elapsedMs: performance.now() - began,
          });
          if (["unavailable", "commit-unknown"].includes(result.outcome)) cancellation.abort();
        }
      }),
    );
    if (clients.some((client) => client.status !== "fulfilled")) cancellation.abort();
    clearTimeout(runTimer);
    runTimer = undefined;
    report.measurementElapsedMs = performance.now() - started;
    report.notStartedOperations = bounds.plannedOperations - report.cases.length;
    report.interrupted = cancellation.signal.aborted;
    report.stage = "verification";
    // Verification uses the original helper's fresh current calls. An aborted
    // helper reports the gap; cancellation never becomes successful preservation.
    report.verification = await workload.verify();
    report.stage = "storage-metrics";
    report.after = await snapshotStorage(pool);
    report.storageChanges = storageDelta(report.before, report.after);
    report.setupStorageChanges = storageDelta(report.empty, report.before);
    if (report.before.wal.status === "observed" && report.after.wal.status === "observed") {
      const {
        rows: [row],
      } = await pool.query("SELECT pg_wal_lsn_diff($1::pg_lsn,$2::pg_lsn)::text AS bytes", [
        report.after.wal.lsn,
        report.before.wal.lsn,
      ]);
      report.walChange = /^\d+$/.test(row.bytes)
        ? {
            status: "observed",
            bytes: row.bytes,
            scope: "cluster-wide-unisolated",
            perOperationAttribution: "not-established",
          }
        : { status: "unmeasured", reason: "WAL counter discontinuity" };
    } else report.walChange = { status: "unmeasured" };
    report.stage = "query-plans";
    report.plans = await capturePlans(pool, workload.manifest());
    report.latencies = [];
    for (const kind of new Set(report.cases.map((sample) => sample.kind))) {
      for (const outcome of new Set(
        report.cases.filter((sample) => sample.kind === kind).map((sample) => sample.outcome),
      )) {
        const samples = report.cases.filter(
          (sample) => sample.kind === kind && sample.outcome === outcome,
        );
        report.latencies.push({
          kind,
          outcome,
          ...summarizeLatencies(samples.map((sample) => sample.elapsedMs)),
        });
      }
    }
    report.execution =
      report.notStartedOperations === 0 &&
      !report.interrupted &&
      report.verification.outcome === "verified-read" &&
      report.walChange.status === "observed" &&
      report.plans.length > 0 &&
      report.plans.every((plan) => plan.status === "observed") &&
      report.cases.every((sample) =>
        ["verified-read", "exact-replay", "completed", "busy"].includes(sample.outcome),
      )
        ? "measured"
        : "incomplete";
    report.stage = "finished";
    await save();
  } catch (error) {
    report.execution = "incomplete";
    if (typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code))
      report.sqlState = error.code;
    report.failure =
      "Measurement did not complete; retained stage and exact fixture locators are authoritative. No automatic retry or cleanup was attempted.";
    await save();
  } finally {
    if (runTimer !== undefined) clearTimeout(runTimer);
    if (signalHandler) {
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
    }
    if (pool) await pool.end();
    await output.close();
  }
  if (report.execution !== "measured")
    throw new Error("Measurement incomplete; inspect the selected report.");
  return report;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(help);
    return;
  }
  if (args.length === 4 && args[0] === "--run" && args[2] === "--output") {
    const selected = parseMeasurementSelection(process.env);
    const config = await readConfiguration(args[1]);
    await runMeasurement(config, selected, args[3]);
    process.stdout.write("Measurement recorded in the selected report.\n");
    return;
  }
  if (args.length !== 2 || args[0] !== "--plan") {
    throw new Error("Expected --plan CONFIG.json or --help.");
  }
  const config = await readConfiguration(args[1]);
  process.stdout.write(`${JSON.stringify(createWorkloadPlan(config), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Workload planner failed."}\n`,
    );
    process.exitCode = 1;
  });
}
