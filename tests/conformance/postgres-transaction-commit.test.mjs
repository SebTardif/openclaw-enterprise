import assert from "node:assert/strict";
import test from "node:test";
import {
  PostgresPlatformState,
  PostgresCommitOutcomeUnknownError,
} from "../../packages/occ/src/state/postgres-state.ts";
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
