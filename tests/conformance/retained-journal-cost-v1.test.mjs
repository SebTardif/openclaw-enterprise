import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createWorkloadPlan,
  parseMeasurementSelection,
  parseWorkloadConfig,
  storageDelta,
  summarizeLatencies,
  validateMeasurementPlan,
} from "../../tools/benchmarks/retained-journal-cost-v1.mjs";
import {
  createRepositoryWorkload,
  WORKLOAD_CONFIG,
} from "../fixtures/retained-journal-cost-v1/values.mjs";

const config = (changes = {}) => ({ ...WORKLOAD_CONFIG, ...changes });
const runnerPath = fileURLToPath(
  new URL("../../tools/benchmarks/retained-journal-cost-v1.mjs", import.meta.url),
);
const kinds = new Set([
  "completion-read",
  "uncertain-attempt-read",
  "duplicate-admission",
  "append-completed-turn",
]);

function assertPlan(plan, input) {
  assert.deepEqual(Object.keys(plan).sort(), [
    "clients",
    "configSha256",
    "dataset",
    "evidence",
    "schemaVersion",
  ]);
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.evidence, "planned-only");
  assert.match(plan.configSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(plan.dataset, {
    agents: input.agents,
    retainedTurns: input.agents * input.retainedTurnsPerAgent,
    uncertainAttempts: input.uncertainAgents,
    totalAttempts: input.agents * input.retainedTurnsPerAgent + input.uncertainAgents,
    replyBytes: input.replyBytes,
  });
  assert.equal(plan.clients.length, input.clients);
  const nextAppend = new Map();
  for (const [clientId, client] of plan.clients.entries()) {
    assert.equal(client.clientId, clientId);
    assert.equal(client.operations.length, input.operationsPerClient);
    for (const [index, operation] of client.operations.entries()) {
      assert.deepEqual(Object.keys(operation).sort(), ["agentIndex", "index", "kind", "turnIndex"]);
      assert.equal(operation.index, index);
      assert.ok(kinds.has(operation.kind));
      assert.ok(Number.isSafeInteger(operation.agentIndex));
      assert.ok(operation.agentIndex >= 0 && operation.agentIndex < input.agents);
      assert.ok(Number.isSafeInteger(operation.turnIndex));
      if (operation.kind === "uncertain-attempt-read") {
        assert.ok(operation.agentIndex < input.uncertainAgents);
        assert.equal(operation.turnIndex, input.retainedTurnsPerAgent);
      } else if (operation.kind === "append-completed-turn") {
        const target = input.uncertainAgents + (clientId % (input.agents - input.uncertainAgents));
        assert.equal(operation.agentIndex, target);
        const next = nextAppend.get(target) ?? input.retainedTurnsPerAgent;
        assert.equal(operation.turnIndex, next);
        nextAppend.set(target, next + 1);
      } else {
        assert.ok(operation.turnIndex >= 0 && operation.turnIndex < input.retainedTurnsPerAgent);
      }
    }
  }
}

test("workload parsing detaches and freezes strict synthetic parameters", () => {
  const input = config();
  const parsed = parseWorkloadConfig(input);
  assert.notEqual(parsed, input);
  assert.deepEqual(parsed, input);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(input), false);
  input.replyBytes = 1;
  assert.equal(parsed.replyBytes, WORKLOAD_CONFIG.replyBytes);
  assert.throws(() => {
    parsed.replyBytes = 2;
  }, TypeError);
  assert.deepEqual(
    parseWorkloadConfig(Object.assign(Object.create(null), WORKLOAD_CONFIG)),
    parsed,
  );
});

test("repository composition rejects invalid or unbounded inputs before loading a repository", async () => {
  const active = new AbortController().signal;
  await assert.rejects(createRepositoryWorkload(undefined, config({ agents: 0 }), active));
  await assert.rejects(
    createRepositoryWorkload(undefined, config(), undefined),
    /cancellation signal/,
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    createRepositoryWorkload(undefined, config(), cancelled.signal),
    /cancellation signal/,
  );
  await assert.rejects(
    createRepositoryWorkload(
      undefined,
      config({
        agents: 16,
        clients: 16,
        retainedTurnsPerAgent: 256,
        uncertainAgents: 0,
        uncertainReadPercent: 0,
        readPercent: 100,
        duplicatePercent: 0,
      }),
      active,
    ),
    /execution profile/,
  );
  await assert.rejects(
    createRepositoryWorkload(
      undefined,
      config({
        agents: 4,
        clients: 4,
        retainedTurnsPerAgent: 1,
        operationsPerClient: 2_048,
        readPercent: 100,
        duplicatePercent: 0,
      }),
      active,
    ),
    /execution profile/,
  );
  await assert.rejects(createRepositoryWorkload(undefined, config(), active), /PostgreSQL pool/);
});

test("importing workload parameters loads only standard library dependencies", () => {
  const fixtureUrl = new URL("../fixtures/retained-journal-cost-v1/values.mjs", import.meta.url)
    .href;
  const source = `
    import { registerHooks } from "node:module";
    const fixtureUrl = ${JSON.stringify(fixtureUrl)};
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (!specifier.startsWith("node:") && specifier !== fixtureUrl) throw new Error("Unexpected dependency during parameter import.");
      return nextResolve(specifier, context);
    }});
    const { WORKLOAD_CONFIG } = await import(fixtureUrl);
    process.stdout.write(JSON.stringify(WORKLOAD_CONFIG));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 65_536,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), WORKLOAD_CONFIG);
});

test("workload parsing accepts exact individual and coupled bounds", () => {
  const minimal = config({
    seed: 1,
    agents: 1,
    retainedTurnsPerAgent: 1,
    uncertainAgents: 0,
    replyBytes: 0,
    clients: 1,
    operationsPerClient: 1,
    hotKeyPercent: 0,
    readPercent: 100,
    duplicatePercent: 0,
    uncertainReadPercent: 0,
    maxRunMs: 1,
  });
  const maximumAttempts = config({
    seed: 4_294_967_295,
    agents: 32,
    retainedTurnsPerAgent: 511,
    uncertainAgents: 32,
    replyBytes: 65_536,
    clients: 16,
    operationsPerClient: 2_048,
    hotKeyPercent: 100,
    readPercent: 100,
    duplicatePercent: 0,
    uncertainReadPercent: 100,
    maxRunMs: 600_000,
  });
  for (const input of [
    minimal,
    maximumAttempts,
    {
      ...minimal,
      agents: 16,
      clients: 16,
      retainedTurnsPerAgent: 1_024,
      operationsPerClient: 2_048,
    },
    { ...minimal, agents: 8, clients: 8, operationsPerClient: 4_096 },
    { ...minimal, readPercent: 0, duplicatePercent: 100 },
    { ...minimal, readPercent: 0, duplicatePercent: 0 },
  ])
    assert.deepEqual(parseWorkloadConfig(input), input);
});

test("workload parsing rejects invalid numeric fields, missing keys and coupled overflows", () => {
  for (const key of Object.keys(WORKLOAD_CONFIG)) {
    const missing = config();
    delete missing[key];
    assert.throws(() => parseWorkloadConfig(missing), key);
    for (const value of [
      NaN,
      Infinity,
      -Infinity,
      -0,
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      "1",
      1n,
      null,
      undefined,
    ]) {
      assert.throws(() => parseWorkloadConfig(config({ [key]: value })), key);
    }
  }
  for (const changes of [
    { schemaVersion: 2 },
    { seed: 0 },
    { seed: 4_294_967_296 },
    { agents: 0 },
    { agents: 33 },
    { retainedTurnsPerAgent: 0 },
    { retainedTurnsPerAgent: 1_025 },
    { uncertainAgents: 5 },
    { replyBytes: 65_537 },
    { clients: 0 },
    { clients: 17 },
    { clients: 5 },
    { operationsPerClient: 0 },
    { operationsPerClient: 4_097 },
    { hotKeyPercent: 101 },
    { readPercent: 101 },
    { duplicatePercent: 101 },
    { uncertainReadPercent: 101 },
    { maxRunMs: 0 },
    { maxRunMs: 600_001 },
    { readPercent: 81, duplicatePercent: 20 },
    { uncertainAgents: 0, uncertainReadPercent: 1 },
    { uncertainAgents: 4, readPercent: 80, duplicatePercent: 19 },
    { agents: 16, retainedTurnsPerAgent: 1_024, uncertainAgents: 1 },
    { agents: 17, retainedTurnsPerAgent: 1_024, uncertainAgents: 0, uncertainReadPercent: 0 },
    { agents: 16, clients: 16, operationsPerClient: 2_049 },
    { agents: 9, clients: 9, operationsPerClient: 4_096 },
  ])
    assert.throws(() => parseWorkloadConfig(config(changes)), JSON.stringify(changes));
});

test("workload parsing rejects untrusted shapes without invoking getters", () => {
  for (const input of [
    null,
    undefined,
    [],
    "config",
    1,
    new Date(),
    Object.create(WORKLOAD_CONFIG),
  ]) {
    assert.throws(() => parseWorkloadConfig(input));
  }
  const custom = Object.assign(Object.create({ inherited: true }), WORKLOAD_CONFIG);
  const symbol = { ...WORKLOAD_CONFIG, [Symbol("extra")]: true };
  const hidden = config();
  Object.defineProperty(hidden, "seed", { value: WORKLOAD_CONFIG.seed, enumerable: false });
  let getterCalls = 0;
  const accessor = config();
  Object.defineProperty(accessor, "seed", {
    enumerable: true,
    get() {
      getterCalls++;
      throw new Error("getter must not run");
    },
  });
  for (const input of [custom, symbol, hidden, accessor, config({ authority: true })]) {
    assert.throws(() => parseWorkloadConfig(input));
  }
  assert.equal(getterCalls, 0);
});

test("workload planning is deterministic, canonical across property order, and describes no measurements", () => {
  const first = createWorkloadPlan(config());
  createWorkloadPlan(config({ seed: 101 }));
  assert.deepEqual(createWorkloadPlan(config()), first);
  assert.deepEqual(
    createWorkloadPlan(Object.fromEntries(Object.entries(config()).reverse())),
    first,
  );
  assertPlan(first, WORKLOAD_CONFIG);
  assert.throws(() => createWorkloadPlan(config({ agents: 0 })));
  assert.throws(() => createWorkloadPlan(config({ measuredLatencyMs: 1 })));
});

test("read and duplicate endpoint percentages select only their eligible retained cohorts", () => {
  for (const [changes, expectedKind] of [
    [{ readPercent: 100, duplicatePercent: 0, uncertainReadPercent: 0 }, "completion-read"],
    [
      { readPercent: 100, duplicatePercent: 0, uncertainReadPercent: 100 },
      "uncertain-attempt-read",
    ],
    [{ readPercent: 0, duplicatePercent: 100, uncertainReadPercent: 0 }, "duplicate-admission"],
  ]) {
    const input = config({ ...changes, hotKeyPercent: 100 });
    const plan = createWorkloadPlan(input);
    assertPlan(plan, input);
    for (const client of plan.clients)
      for (const operation of client.operations) {
        assert.equal(operation.kind, expectedKind);
        assert.equal(operation.agentIndex, 0);
        assert.equal(
          operation.turnIndex,
          expectedKind === "uncertain-attempt-read" ? input.retainedTurnsPerAgent : 0,
        );
      }
  }
  const allUncertain = config({
    uncertainAgents: 4,
    readPercent: 0,
    duplicatePercent: 100,
    hotKeyPercent: 0,
  });
  assertPlan(createWorkloadPlan(allUncertain), allUncertain);
});

test("append locators serialize planned turn indices per available Agent across clients", () => {
  for (const hotKeyPercent of [0, 100]) {
    const input = config({
      agents: 5,
      clients: 5,
      uncertainAgents: 3,
      readPercent: 0,
      duplicatePercent: 0,
      hotKeyPercent,
    });
    const plan = createWorkloadPlan(input);
    assertPlan(plan, input);
    assert.ok(
      plan.clients.every((client) =>
        client.operations.every((operation) => operation.kind === "append-completed-turn"),
      ),
    );
    assert.equal(plan.dataset.retainedTurns, 80);
    assert.equal(plan.dataset.totalAttempts, 83);
  }
});

test("maximum workload plans remain finite and zero-byte replies remain zero", () => {
  const input = config({
    agents: 16,
    clients: 16,
    retainedTurnsPerAgent: 1_024,
    uncertainAgents: 0,
    uncertainReadPercent: 0,
    operationsPerClient: 2_048,
    replyBytes: 0,
  });
  const plan = createWorkloadPlan(input);
  assertPlan(plan, input);
  assert.equal(plan.dataset.totalAttempts, 16_384);
  assert.equal(
    plan.clients.reduce((count, client) => count + client.operations.length, 0),
    32_768,
  );
  assert.equal(plan.dataset.replyBytes, 0);
});

test("measurement selection requires exact local database identity and keeps URL details out of errors", () => {
  const secret = "synthetic-test-password";
  const selectedEnv = {
    OCC_RETAINED_JOURNAL_DATABASE_URL: `postgresql://occ_app:${secret}@127.0.0.1:65432/retained_test`,
    OCC_RETAINED_JOURNAL_DATABASE_NAME: "retained_test",
    OCC_RETAINED_JOURNAL_DATABASE_OID: "16386",
    OCC_RETAINED_JOURNAL_DATABASE_ROLE: "occ_app",
    OCC_RETAINED_JOURNAL_RUN_REF: "synthetic-run-01",
  };
  for (const url of [
    selectedEnv.OCC_RETAINED_JOURNAL_DATABASE_URL,
    `postgres://occ_app:${secret}@[::1]:65432/retained_test`,
  ]) {
    const selected = parseMeasurementSelection({
      ...selectedEnv,
      OCC_RETAINED_JOURNAL_DATABASE_URL: url,
    });
    assert.ok(selected.connectionString === url);
    assert.equal(selected.databaseName, "retained_test");
    assert.equal(selected.databaseOid, "16386");
    assert.equal(selected.databaseRole, "occ_app");
    assert.equal(selected.runRef, "synthetic-run-01");
    assert.equal(Object.isFrozen(selected), true);
  }
  for (const oid of ["1", "4294967295"]) {
    assert.equal(
      parseMeasurementSelection({ ...selectedEnv, OCC_RETAINED_JOURNAL_DATABASE_OID: oid })
        .databaseOid,
      oid,
    );
  }
  const invalidSelections = Object.keys(selectedEnv).map((key) => ({ ...selectedEnv, [key]: "" }));
  for (const changes of [
    { DATABASE_URL: `postgresql://occ_app:${secret}@192.0.2.1:65432/retained_test` },
    { DATABASE_URL: `postgresql://occ_app:${secret}@localhost:65432/retained_test` },
    { DATABASE_URL: `https://occ_app:${secret}@127.0.0.1:65432/retained_test` },
    { DATABASE_URL: `postgresql://occ_app:${secret}@127.0.0.1/retained_test` },
    { DATABASE_URL: "postgresql://127.0.0.1:65432/retained_test" },
    { DATABASE_URL: `${selectedEnv.OCC_RETAINED_JOURNAL_DATABASE_URL}?host=elsewhere` },
    { DATABASE_URL: `${selectedEnv.OCC_RETAINED_JOURNAL_DATABASE_URL}#fragment` },
    { DATABASE_NAME: "other_database" },
    { DATABASE_ROLE: "other_role" },
    { DATABASE_NAME: "invalid-name" },
    { DATABASE_ROLE: "invalid-role" },
    { DATABASE_OID: "0" },
    { DATABASE_OID: "01" },
    { DATABASE_OID: "-1" },
    { DATABASE_OID: "1.5" },
    { DATABASE_OID: "4294967296" },
    { RUN_REF: "../escape" },
    { RUN_REF: "x".repeat(81) },
  ])
    invalidSelections.push({
      ...selectedEnv,
      ...Object.fromEntries(
        Object.entries(changes).map(([key, value]) => [`OCC_RETAINED_JOURNAL_${key}`, value]),
      ),
    });
  for (const invalid of invalidSelections) {
    assert.throws(
      () => parseMeasurementSelection(invalid),
      (error) => {
        assert.equal(typeof error.message, "string");
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes("postgresql://"), false);
        return true;
      },
    );
  }
});

test("the repository execution profile bounds actual setup plus planned appends separately from planning", () => {
  const readOnly = config({
    agents: 2,
    clients: 2,
    retainedTurnsPerAgent: 1_024,
    uncertainAgents: 0,
    uncertainReadPercent: 0,
    operationsPerClient: 2_048,
    readPercent: 100,
    duplicatePercent: 0,
  });
  assert.deepEqual(validateMeasurementPlan(createWorkloadPlan(readOnly)), {
    plannedOperations: 4_096,
    maximumGeneratedAttempts: 2_048,
  });
  const appendOnly = config({
    agents: 1,
    clients: 1,
    retainedTurnsPerAgent: 1,
    uncertainAgents: 0,
    uncertainReadPercent: 0,
    operationsPerClient: 2_047,
    readPercent: 0,
    duplicatePercent: 0,
  });
  assert.deepEqual(validateMeasurementPlan(createWorkloadPlan(appendOnly)), {
    plannedOperations: 2_047,
    maximumGeneratedAttempts: 2_048,
  });
  assert.throws(() =>
    validateMeasurementPlan(createWorkloadPlan({ ...appendOnly, operationsPerClient: 2_048 })),
  );
  assert.throws(() =>
    validateMeasurementPlan(createWorkloadPlan({ ...readOnly, operationsPerClient: 2_049 })),
  );
  const largerPlan = createWorkloadPlan({ ...readOnly, agents: 3 });
  assert.equal(largerPlan.evidence, "planned-only");
  assert.throws(() => validateMeasurementPlan(largerPlan));
});

test("storage deltas retain exact decimal precision and negative allocation changes", () => {
  const before = {
    tables: [
      {
        relation: "turn_journal_attempts",
        rows: "9007199254740993",
        heap_bytes: "8192",
        table_bytes: "16384",
        index_bytes: "32768",
        total_bytes: "49152",
      },
    ],
  };
  const after = {
    tables: [
      {
        relation: "turn_journal_attempts",
        rows: "9007199254740995",
        heap_bytes: "0",
        table_bytes: "8192",
        index_bytes: "16384",
        total_bytes: "24576",
      },
    ],
  };
  const original = structuredClone(before);
  assert.deepEqual(storageDelta(before, after), [
    {
      relation: "turn_journal_attempts",
      rows: "2",
      heap_bytes: "-8192",
      table_bytes: "-8192",
      index_bytes: "-16384",
      total_bytes: "-24576",
    },
  ]);
  assert.deepEqual(before, original);
  assert.throws(() => storageDelta(before, { tables: [] }));
  for (const key of ["rows", "heap_bytes", "table_bytes", "index_bytes", "total_bytes"]) {
    const missing = structuredClone(after);
    delete missing.tables[0][key];
    assert.throws(() => storageDelta(before, missing));
    for (const invalid of [
      "",
      "-1",
      "1.5",
      "NaN",
      "1e3",
      " 1",
      undefined,
      NaN,
      1,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const changed = structuredClone(after);
      changed.tables[0][key] = invalid;
      assert.throws(() => storageDelta(before, changed));
    }
  }
});

test("empty latency summaries distinguish absent observations from measured zero", () => {
  assert.deepEqual(summarizeLatencies([]), {
    count: 0,
    minMs: null,
    maxMs: null,
    meanMs: null,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
  });
  for (const samples of [[0], [0, 0, 0]]) {
    assert.deepEqual(summarizeLatencies(samples), {
      count: samples.length,
      minMs: 0,
      maxMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
    });
  }
});

test("latency summaries use nearest rank on detached sorted samples and a finite mean", () => {
  const samples = [20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10];
  const before = [...samples];
  assert.deepEqual(summarizeLatencies(samples), {
    count: 20,
    minMs: 1,
    maxMs: 20,
    meanMs: 10.5,
    p50Ms: 10,
    p95Ms: 19,
    p99Ms: 20,
  });
  assert.deepEqual(samples, before);
  const fractional = summarizeLatencies([0, 0.25, 0.25, 0.5]);
  assert.equal(fractional.meanMs, 0.25);
  assert.equal(fractional.p50Ms, 0.25);
  const large = summarizeLatencies([Number.MAX_VALUE, Number.MAX_VALUE]);
  assert.equal(large.meanMs, Number.MAX_VALUE);
  assert.equal(summarizeLatencies(new Array(32_768).fill(0)).count, 32_768);
});

test("invalid latency samples cannot become silently dropped measurements", () => {
  const accessor = [1];
  let getterCalls = 0;
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      getterCalls++;
      return 1;
    },
  });
  class CustomSamples extends Array {}
  for (const samples of [
    null,
    {},
    "1",
    new CustomSamples(1),
    new Array(1),
    accessor,
    [NaN],
    [Infinity],
    [-Infinity],
    [-1],
    [-0],
    ["0"],
    [undefined],
    new Array(32_769).fill(0),
  ]) {
    assert.throws(() => summarizeLatencies(samples));
  }
  assert.equal(getterCalls, 0);
});

test("CLI produces a bounded deterministic plan and requires explicit measurement selection", async (t) => {
  const scratchRoot = process.env.OCC_RETAINED_JOURNAL_TEST_OUTPUT_DIR ?? tmpdir();
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(scratchRoot, "retained-cost-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const invoke = (...args) => {
    const result = spawnSync(process.execPath, [runnerPath, ...args], {
      cwd: scratch,
      env: {
        ...process.env,
        OCC_RETAINED_JOURNAL_DATABASE_URL: "",
        OCC_RETAINED_JOURNAL_DATABASE_NAME: "",
        OCC_RETAINED_JOURNAL_DATABASE_OID: "",
        OCC_RETAINED_JOURNAL_DATABASE_ROLE: "",
        OCC_RETAINED_JOURNAL_RUN_REF: "",
      },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 65_536,
    });
    assert.ifError(result.error);
    return result;
  };
  const help = invoke("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--plan/);
  assert.deepEqual(await readdir(scratch), []);
  const input = config({ clients: 2, operationsPerClient: 4 });
  const path = join(scratch, "config.json");
  await writeFile(path, JSON.stringify(input), { mode: 0o600 });
  const result = invoke("--plan", path);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), createWorkloadPlan(input));
  assert.equal(result.stderr, "");
  const unavailable = invoke(
    "--run",
    join(scratch, "missing-config.json"),
    "--output",
    join(scratch, "report.json"),
  );
  assert.notEqual(unavailable.status, 0);
  assert.equal(unavailable.stdout, "");
  assert.ok(unavailable.stderr.length > 0);
  await writeFile(path, " ".repeat(16_385), { mode: 0o600 });
  const oversized = invoke("--plan", path);
  assert.notEqual(oversized.status, 0);
  assert.equal(oversized.stdout, "");
  const directory = invoke("--plan", scratch);
  assert.notEqual(directory.status, 0);
  assert.equal(directory.stdout, "");
  assert.deepEqual(await readdir(scratch), ["config.json"]);
});
