import assert from "node:assert/strict";
import test from "node:test";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/ports/transaction-errors.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";

// A transport protocol fixture for the actual outer owner, not a SQL database
// emulator. No repository reads/writes, authentication, custody or PG evidence.
function protocol({ commit, release, removeListener, pendingQuery } = {}) {
  const calls = [];
  let releases = 0;
  const client = {
    on() {},
    removeListener() {
      removeListener?.();
    },
    async query(statement) {
      calls.push(statement);
      if (statement === "SELECT 1" && pendingQuery) return pendingQuery;
      if (statement === "COMMIT")
        return commit ? commit() : { command: "COMMIT", rows: [], rowCount: 0 };
      if (statement === "ROLLBACK") return { command: "ROLLBACK", rows: [], rowCount: 0 };
      if (
        statement === "BEGIN" ||
        statement.startsWith("BEGIN ISOLATION") ||
        statement.startsWith("SELECT set_config(") ||
        statement.startsWith("SET LOCAL ")
      )
        return { command: "", rows: [], rowCount: 0 };
      throw new Error("This fixture does not simulate persistence queries.");
    },
    release(destroy) {
      releases++;
      release?.(destroy);
    },
  };
  const state = new PostgresPlatformState({
    options: { connectionTimeoutMillis: 100 },
    async connect() {
      return client;
    },
    async end() {},
  });
  return { state, calls, releases: () => releases };
}

test("known outer acknowledgment returns the original value after cleanup", async () => {
  const p = protocol();
  const value = Object.freeze({ result: "unchanged" });
  assert.equal(await p.state.transact(async () => value), value);
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
  assert.equal(p.releases(), 1);
});

test("callback failure before dispatch preserves the error and rolls back", async () => {
  const p = protocol();
  const failure = new Error("callback rejected");
  await assert.rejects(
    p.state.transact(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(p.calls, ["BEGIN", "ROLLBACK"]);
  assert.equal(p.releases(), 1);
});

test("definite server rejection at COMMIT remains a known no-commit failure", async () => {
  const p = protocol({
    commit: () => {
      throw Object.assign(new Error("constraint"), { code: "23514" });
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    ScopeViolationError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT", "ROLLBACK"]);
});

test("lost acknowledgment remains unknown even if a later rollback responds", async () => {
  const p = protocol({
    commit: () => {
      throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT", "ROLLBACK"]);
});

test("40003 statement completion unknown remains unknown after a responding rollback", async () => {
  let discarded;
  const p = protocol({
    commit: () => {
      throw Object.assign(new Error("statement completion unknown"), { code: "40003" });
    },
    release: (destroy) => {
      discarded = destroy;
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT", "ROLLBACK"]);
  assert.equal(discarded, true);
});

test("an unclassified valid SQLSTATE does not establish no commit", async () => {
  const p = protocol({
    commit: () => {
      throw Object.assign(new Error("unclassified server failure"), { code: "XX000" });
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT", "ROLLBACK"]);
});

test("an acknowledgment inspection failure cannot impersonate a COMMIT rejection", async () => {
  const p = protocol({
    commit: () => ({
      get command() {
        throw Object.assign(new Error("acknowledgment inspection failed"), { code: "23514" });
      },
    }),
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT", "ROLLBACK"]);
});

test("actual ROLLBACK command acknowledgment establishes no commit", async () => {
  const p = protocol({ commit: () => ({ command: "ROLLBACK", rows: [], rowCount: 0 }) });
  await assert.rejects(
    p.state.transact(async () => 1),
    (error) =>
      error instanceof DependencyUnavailableError &&
      !(error instanceof PostgresCommitOutcomeUnknownError),
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
});

test("unrecognized acknowledgment does not establish rollback", async () => {
  const p = protocol({ commit: () => ({ rows: [], rowCount: 0 }) });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
});

test("release failure after acknowledged COMMIT is unknown and cleanup continues", async () => {
  let detached = false;
  const p = protocol({
    release: () => {
      throw new Error("release failed");
    },
    removeListener: () => {
      detached = true;
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.equal(detached, true);
  assert.equal(p.releases(), 1);
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
});

test("cleanup failure cannot replace an earlier callback failure", async () => {
  const failure = new Error("original callback failure");
  const p = protocol({
    release: () => {
      throw new Error("cleanup failure");
    },
  });
  await assert.rejects(
    p.state.transact(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(p.calls, ["BEGIN", "ROLLBACK"]);
});

test("cancellation racing with acknowledgment retains the committed possibility", async () => {
  const abort = new AbortController();
  const p = protocol({
    commit: () => {
      abort.abort();
      return { command: "COMMIT", rows: [], rowCount: 0 };
    },
  });
  // Existing private execution is exercised without a credential participant or
  // a fabricated accepting authority; this tests only cancellation orchestration.
  await assert.rejects(
    p.state.execute(false, async () => 1, { signal: abort.signal, timeoutMs: 1000 }),
    PostgresCommitOutcomeUnknownError,
  );
  assert.equal(p.releases(), 1);
  assert.equal(p.calls.includes("COMMIT"), true);
  assert.equal(p.calls.includes("ROLLBACK"), false);
});

test("missing genuine credential participants fail before callback or pool acquisition", async () => {
  let connected = false;
  let called = false;
  const state = new PostgresPlatformState({
    async connect() {
      connected = true;
      throw new Error("must not connect");
    },
    async end() {},
  });
  const owners = state.bindCredentialInventoryOwnersV1();
  const result = await owners.transactions.run(
    { installationId: "installation", namespaceId: "namespace", agentId: "agent" },
    { signal: new AbortController().signal },
    async () => {
      called = true;
    },
  );
  assert.deepEqual(result, { kind: "unavailable" });
  assert.equal(called, false);
  assert.equal(connected, false);
});

test("cancellation joins a previously admitted raw query before the outer result settles", async () => {
  const abort = new AbortController();
  const steps = [];
  let rejectQuery;
  let reachedAbort;
  const query = new Promise((_resolve, reject) => {
    rejectQuery = reject;
  });
  const aborted = new Promise((resolve) => {
    reachedAbort = resolve;
  });
  const p = protocol({
    pendingQuery: query,
    release: () => {
      steps.push("released");
    },
  });
  let settled = false;
  const running = p.state.execute(
    false,
    async (unit) => {
      void p.state.queryInTransaction(unit, "SELECT 1").catch(() => {
        steps.push("query joined");
      });
      await Promise.resolve();
      abort.abort();
      reachedAbort();
      return 1;
    },
    { signal: abort.signal, timeoutMs: 1000 },
  );
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await aborted;
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(steps, ["released"]);
  rejectQuery(new Error("transport closed"));
  await assert.rejects(running, DependencyUnavailableError);
  assert.deepEqual(steps, ["released", "query joined"]);
  assert.equal(p.calls.includes("COMMIT"), false);
});
