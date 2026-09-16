import assert from "node:assert/strict";
import test from "node:test";
import {
  PostgresPlatformState,
  PostgresCommitOutcomeUnknownError,
} from "../../packages/occ/src/state/postgres-state.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";

// The real State owns all admission, draining and outcome decisions. This fixture
// supplies only transport acknowledgments; persisted SQL effects need the PG suite.
function protocol({ commit, release, detach, query } = {}) {
  const calls = [];
  let releases = 0;
  let listener;
  const client = {
    on(_event, callback) {
      listener = callback;
    },
    removeListener() {
      detach?.();
    },
    async query(statement, parameters) {
      calls.push(statement);
      if (statement === "COMMIT")
        return commit ? commit() : { command: "COMMIT", rows: [], rowCount: 0 };
      if (statement === "ROLLBACK" || statement.startsWith("BEGIN"))
        return { command: statement, rows: [], rowCount: 0 };
      if (query) return query(statement, parameters);
      throw new Error("Protocol fixture cannot simulate repository SQL.");
    },
    release(discard) {
      releases++;
      release?.(discard);
    },
  };
  const state = new PostgresPlatformState({
    async connect() {
      return client;
    },
    async end() {},
  });
  return { state, calls, releases: () => releases, transport: (error) => listener?.(error) };
}

function gate() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("original unit binding refuses foreign, forged, copied, read-only and settled units", async () => {
  const p = protocol();
  const foreign = protocol();
  let credential;
  let original;
  assert.throws(() => p.state.bindCredentialUnitIn({}), ScopeViolationError);
  await p.state.read(async (view) => {
    assert.throws(() => p.state.bindCredentialUnitIn(view), ScopeViolationError);
  });
  await p.state.transact(async (uow) => {
    original = uow;
    assert.throws(() => foreign.state.bindCredentialUnitIn(uow), ScopeViolationError);
    assert.throws(() => p.state.bindCredentialUnitIn({ ...uow }), ScopeViolationError);
    credential = p.state.bindCredentialUnitIn(uow);
    assert.equal(credential.uow, uow);
    assert.equal(p.state.bindCredentialUnitIn(uow), credential);
    assert.equal(Object.isFrozen(credential), true);
    assert.deepEqual(Object.keys(credential).sort(), ["query", "run", "uow"]);
    await assert.rejects(p.state.recognizeCredentialCommit(credential), ScopeViolationError);
    await assert.rejects(foreign.state.recognizeCredentialCommit(credential), ScopeViolationError);
    await assert.rejects(p.state.recognizeCredentialCommit({ ...credential }), ScopeViolationError);
  });
  assert.throws(() => p.state.bindCredentialUnitIn(original), ScopeViolationError);
  await assert.rejects(
    credential.run(async () => {}),
    ScopeViolationError,
  );
  await assert.rejects(credential.query("SELECT 1"), ScopeViolationError);
  const outcome = await p.state.recognizeCredentialCommit(credential);
  assert.equal(outcome.kind, "committed");
  assert.equal(Object.isFrozen(outcome.evidence), true);
  await assert.rejects(p.state.recognizeCredentialCommit(credential), ScopeViolationError);
});

test("unit run enrolls and invokes synchronously; accepted nested children drain before COMMIT", async () => {
  const p = protocol();
  const childGate = gate();
  const outerReturned = gate();
  let unit;
  let childFinished = false;
  let parentFinished = false;
  const transaction = p.state.transact(async (uow) => {
    unit = p.state.bindCredentialUnitIn(uow);
    let invoked = false;
    const parent = unit.run(async () => {
      invoked = true;
      unit.run(async () => {
        await childGate.promise;
        childFinished = true;
      });
      parentFinished = true;
    });
    assert.equal(invoked, true);
    await parent;
    outerReturned.resolve();
    return 17;
  });
  try {
    await outerReturned.promise;
    await nextTurn();
    assert.equal(parentFinished, true);
    assert.equal(childFinished, false);
    assert.deepEqual(p.calls, ["BEGIN"]);
    assert.equal(p.releases(), 0);
    await assert.rejects(p.state.recognizeCredentialCommit(unit), ScopeViolationError);
    childGate.resolve();
    assert.equal(await transaction, 17);
    assert.equal(childFinished, true);
    assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
    assert.equal(p.releases(), 1);
    assert.equal((await p.state.recognizeCredentialCommit(unit)).kind, "committed");
  } finally {
    childGate.resolve();
    await transaction.catch(() => {});
  }
});

test("caught, unawaited and synchronous original participant failures poison the outer transaction", async () => {
  for (const mode of ["caught", "unawaited", "synchronous"]) {
    const p = protocol();
    const failure = new Error("Original credential participant failed");
    let unit;
    await assert.rejects(
      p.state.transact(async (uow) => {
        unit = p.state.bindCredentialUnitIn(uow);
        const result = unit.run(
          mode === "synchronous"
            ? () => {
                throw failure;
              }
            : async () => {
                await Promise.resolve();
                throw failure;
              },
        );
        if (mode !== "unawaited") await result.catch(() => {});
      }),
      (error) => error === failure,
    );
    assert.deepEqual(p.calls, ["BEGIN", "ROLLBACK"]);
    assert.deepEqual(await p.state.recognizeCredentialCommit(unit), { kind: "not-committed" });
  }
});

test("settled original callbacks deny escaped binding, run and query during child drain", async () => {
  const p = protocol();
  const childGate = gate();
  const escapeGate = gate();
  const returned = gate();
  let escape;
  const transaction = p.state.transact(async (uow) => {
    const unit = p.state.bindCredentialUnitIn(uow);
    await unit.run(async () => {
      unit.run(async () => {
        await childGate.promise;
      });
      escape = (async () => {
        await escapeGate.promise;
        assert.throws(() => p.state.bindCredentialUnitIn(uow), ScopeViolationError);
        await assert.rejects(
          unit.run(async () => {}),
          ScopeViolationError,
        );
        await assert.rejects(unit.query("SELECT 1"), ScopeViolationError);
      })();
    });
    returned.resolve();
  });
  try {
    await returned.promise;
    await nextTurn();
    escapeGate.resolve();
    await escape;
    assert.deepEqual(p.calls, ["BEGIN"]);
    childGate.resolve();
    await transaction;
  } finally {
    escapeGate.resolve();
    childGate.resolve();
    await transaction.catch(() => {});
    await escape?.catch(() => {});
  }
});

test("borrowed queries refuse transaction/session commands and concealed extra statements", async () => {
  const statements = [
    "COMMIT",
    " END ;",
    "ROLLBACK",
    "ABORT",
    "BEGIN",
    "START TRANSACTION",
    "SAVEPOINT borrowed",
    "RELEASE SAVEPOINT borrowed",
    "PREPARE TRANSACTION 'borrowed'",
    "COMMIT PREPARED 'borrowed'",
    "SET TRANSACTION READ ONLY",
    "RESET ALL",
    "/* before */\nCOMMIT",
    "-- before\nROLLBACK",
    "/* nested /* inner */ outer */ END",
    "SELECT 1; COMMIT",
    "SELECT 1 ;/**/ROLLBACK",
    "SELECT 1;-- boundary\nEND",
    "SELECT 1;-- boundary\rCOMMIT",
    "-- before\rCOMMIT",
    "SELECT ';COMMIT'; /* boundary */ COMMIT",
    "SELECT $$;ROLLBACK$$; COMMIT",
    "SELECT $tag$;END$tag$; /* nested /* comment */ */ COMMIT",
    "SELECT $é$ -- hidden $é$; COMMIT",
    "SELECT $é1$ /* hidden $é1$; ROLLBACK",
    "SELECT $tagé$ -- hidden $tagé$; END",
    "SELECT foo$tag$; COMMIT; -- $tag$",
    "SELECT E'\\\';COMMIT'; COMMIT",
    "SELECT é$tag$; COMMIT; -- $tag$",
    "SELECT éE'\\'; COMMIT; --'",
    "SELECT '\\'; COMMIT; --'",
    "SELECT 1; /* unterminated",
    "/* only */",
    "DO $$ BEGIN COMMIT; END $$",
    "CALL borrowed()",
  ];
  for (const statement of statements) {
    const p = protocol();
    let unit;
    // A caught borrowed-query denial is still a credential operation failure.
    await assert.rejects(
      p.state.transact(async (uow) => {
        unit = p.state.bindCredentialUnitIn(uow);
        await assert.rejects(unit.query(statement), ScopeViolationError);
      }),
      ScopeViolationError,
    );
    assert.deepEqual(p.calls, ["BEGIN", "ROLLBACK"], statement);
    assert.deepEqual(await p.state.recognizeCredentialCommit(unit), { kind: "not-committed" });
  }
});

test("malformed UTF16 refuses before forwarding and poisons caught or unawaited queries", async () => {
  const high = String.fromCharCode(0xd800);
  const otherHigh = String.fromCharCode(0xd801);
  const low = String.fromCharCode(0xdc00);
  const statements = [
    `SELECT $${high}$ -- hidden $${otherHigh}$; COMMIT -- $${high}$`,
    `SELECT $${low}$value$${low}$`,
    `SELECT 1 -- trailing ${high}`,
  ];
  for (const mode of ["caught", "unawaited"]) {
    for (const statement of statements) {
      const p = protocol();
      let unit;
      await assert.rejects(
        p.state.transact(async (uow) => {
          unit = p.state.bindCredentialUnitIn(uow);
          const result = unit.query(statement);
          // Callback success must not erase the original query's failure latch.
          if (mode === "caught") await assert.rejects(result, ScopeViolationError);
        }),
        ScopeViolationError,
      );
      assert.deepEqual(p.calls, ["BEGIN", "ROLLBACK"], mode);
      assert.deepEqual(await p.state.recognizeCredentialCommit(unit), { kind: "not-committed" });
    }
  }
});

test("well-formed Unicode SQL reaches the borrowed client with original parameters", async () => {
  const forwarded = [];
  const p = protocol({
    query(statement, parameters) {
      forwarded.push({ statement, parameters });
      return { rows: [], rowCount: 0 };
    },
  });
  const tags = [String.fromCodePoint(0x1f680), String.fromCharCode(0xfffd)];
  const parameters = ["original parameter"];
  let unit;
  await p.state.transact(async (uow) => {
    unit = p.state.bindCredentialUnitIn(uow);
    for (const tag of tags) {
      const statement = `SELECT $${tag}$ -- quoted ; COMMIT $${tag}$, $1::text`;
      await unit.query(statement, parameters);
      assert.equal(forwarded.at(-1).statement, statement);
      assert.equal(forwarded.at(-1).parameters, parameters);
    }
  });
  assert.equal(forwarded.length, tags.length);
  assert.equal((await p.state.recognizeCredentialCommit(unit)).kind, "committed");
});

test("only acknowledged COMMIT plus clean release and listener cleanup permits one recognition", async () => {
  for (const mode of ["lost", "missing", "40003", "rejected", "rollback", "release", "detach"]) {
    const p = protocol({
      commit: () => {
        if (mode === "lost") throw Object.assign(new Error("Lost ACK"), { code: "ECONNRESET" });
        if (mode === "40003")
          throw Object.assign(new Error("Unknown completion"), { code: "40003" });
        if (mode === "rejected") throw Object.assign(new Error("Rejected"), { code: "23514" });
        if (mode === "missing") return { rows: [], rowCount: 0 };
        return { command: mode === "rollback" ? "ROLLBACK" : "COMMIT", rows: [], rowCount: 0 };
      },
      release: () => {
        if (mode === "release") throw new Error("Release uncertain");
      },
      detach: () => {
        if (mode === "detach") throw new Error("Listener cleanup uncertain");
      },
    });
    let unit;
    const definite = mode === "rejected" || mode === "rollback";
    await assert.rejects(
      p.state.transact(async (uow) => {
        unit = p.state.bindCredentialUnitIn(uow);
        await unit.run(async () => {});
      }),
      (error) =>
        definite
          ? !(error instanceof PostgresCommitOutcomeUnknownError)
          : error instanceof PostgresCommitOutcomeUnknownError,
    );
    assert.deepEqual(
      await p.state.recognizeCredentialCommit(unit),
      definite ? { kind: "not-committed" } : { kind: "unknown", nextAction: "reconcile-only" },
    );
    await assert.rejects(p.state.recognizeCredentialCommit(unit), ScopeViolationError);
  }
});

test("recognition refuses inside COMMIT and cleanup rather than waiting for its own owner", async () => {
  let unit;
  const denials = [];
  const p = protocol({
    commit: () => {
      denials.push(assert.rejects(p.state.recognizeCredentialCommit(unit), ScopeViolationError));
      return { command: "COMMIT", rows: [], rowCount: 0 };
    },
    release: () => {
      denials.push(assert.rejects(p.state.recognizeCredentialCommit(unit), ScopeViolationError));
    },
    detach: () => {
      denials.push(assert.rejects(p.state.recognizeCredentialCommit(unit), ScopeViolationError));
    },
  });
  await p.state.transact(async (uow) => {
    unit = p.state.bindCredentialUnitIn(uow);
  });
  await Promise.all(denials);
  assert.equal((await p.state.recognizeCredentialCommit(unit)).kind, "committed");
});

test("transport uncertainty after the acknowledged COMMIT cannot become credential evidence", async () => {
  for (const phase of ["commit", "release", "detach"]) {
    const fail = () => p.transport(new Error("Late transport uncertainty"));
    const p = protocol({
      commit: () => {
        if (phase === "commit") fail();
        return { command: "COMMIT", rows: [], rowCount: 0 };
      },
      release: () => {
        if (phase === "release") fail();
      },
      detach: () => {
        if (phase === "detach") fail();
      },
    });
    let unit;
    await assert.rejects(
      p.state.transact(async (uow) => {
        unit = p.state.bindCredentialUnitIn(uow);
      }),
      PostgresCommitOutcomeUnknownError,
    );
    assert.deepEqual(await p.state.recognizeCredentialCommit(unit), {
      kind: "unknown",
      nextAction: "reconcile-only",
    });
  }
});
