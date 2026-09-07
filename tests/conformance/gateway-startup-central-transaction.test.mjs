import assert from "node:assert/strict";
import test from "node:test";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { GatewayStartupOwnerPhaseV1 } from "../../packages/occ/src/gateway-startup-v1/owner.ts";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/ports/transaction-errors.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";

// Actual central execute + actual Gateway phase, with a transport protocol double.
// Private-erased execute is used only to reach its orchestration seam. These cases
// supply no authority invocation, configured producer, SQL persistence emulator,
// NativeIAM decision, physical process evidence, or PostgreSQL integration proof.
const tick = () => new Promise((resolve) => setImmediate(resolve));
const options = { timeout: 5000 };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const queryResult = () => ({ command: "SELECT", rows: [{ probe: 1 }], rowCount: 1 });
const operation = Object.freeze({
  installationId: "installation",
  operationRef: "controlled-operation",
  operationDigest: "a".repeat(64),
  startup: null,
});
// A valid completion payload drives phase mechanics; it is not a repository read.
const completion = Object.freeze({
  kind: "commit",
  provisional: Object.freeze({ kind: "not-observed", operation }),
});
const exactError = (expected) => (actual) => {
  assert.equal(actual, expected);
  return true;
};
const knownUnavailable = (actual) => {
  assert.ok(actual instanceof DependencyUnavailableError);
  assert.ok(!(actual instanceof PostgresCommitOutcomeUnknownError));
  return true;
};
const knownFailure = (actual) => {
  assert.ok(actual instanceof Error);
  assert.ok(!(actual instanceof PostgresCommitOutcomeUnknownError));
  return true;
};

function protocol({ commit, rollback, release, removeListener, probe } = {}) {
  const calls = [];
  const events = [];
  const releases = [];
  let connects = 0;
  let transportListener;
  const client = {
    on(event, listener) {
      assert.equal(event, "error");
      assert.equal(transportListener, undefined);
      transportListener = listener;
      events.push("listener-attached");
    },
    removeListener(event, listener) {
      assert.equal(event, "error");
      assert.equal(listener, transportListener);
      transportListener = undefined;
      events.push("listener-removed");
      removeListener?.();
    },
    async query(statement, parameters) {
      calls.push(statement);
      if (statement === "SELECT 1" || statement === "SELECT 2") {
        events.push(statement);
        return probe ? probe(statement, parameters) : queryResult();
      }
      if (statement === "COMMIT") {
        events.push("commit-dispatched");
        return commit ? commit() : { command: "COMMIT", rows: [], rowCount: 0 };
      }
      if (statement === "ROLLBACK") {
        events.push("rollback-dispatched");
        return rollback ? rollback() : { command: "ROLLBACK", rows: [], rowCount: 0 };
      }
      if (
        statement === "BEGIN" ||
        statement.startsWith("BEGIN ISOLATION") ||
        statement.startsWith("SELECT set_config(") ||
        statement.startsWith("SET LOCAL ")
      )
        return { command: "", rows: [], rowCount: 0 };
      throw new Error("The protocol fixture does not simulate persistence queries.");
    },
    release(destroy) {
      releases.push(destroy);
      events.push("client-released");
      release?.(destroy);
    },
  };
  const state = new PostgresPlatformState({
    options: { connectionTimeoutMillis: 100 },
    async connect() {
      connects++;
      return client;
    },
    async end() {},
  });
  return {
    state,
    calls,
    events,
    releases,
    connects: () => connects,
    controls: () =>
      calls.filter((sql) => sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK"),
    transportError: () => transportListener?.(new Error("controlled transport event")),
  };
}

function runGateway(p, work = async () => completion, { signal, beforeCommand, cleanup } = {}) {
  const seen = { callbackCount: 0, commandCount: 0, cleanupCount: 0, settled: false };
  const execution = {
    disposition: "not-sent",
    establishedNoCommit: false,
    close() {
      p.events.push("binding-closed");
    },
  };
  const promise = p.state.execute(
    false,
    async (unit, context) => {
      seen.callbackCount++;
      seen.unit = unit;
      seen.context = context;
      const phase = execution.phase;
      assert.ok(phase instanceof GatewayStartupOwnerPhaseV1);
      assert.equal(context.gateway, execution);
      seen.phase = phase;
      if (beforeCommand) await beforeCommand();
      // The real owner callback owns this sole runCommand. An extra admission in
      // execute would make the actual phase reject these successful cases.
      return phase.runCommand(async () => {
        seen.commandCount++;
        phase.retainCleanup(async () => {
          seen.cleanupCount++;
          p.events.push("retained-cleanup");
          await cleanup?.(phase, unit, context);
        });
        return work(phase, unit, context);
      });
    },
    { signal: signal ?? new AbortController().signal, timeoutMs: 1000 },
    false,
    undefined,
    execution,
  );
  // Observe both outcomes immediately, including cancellation before a test awaits.
  void promise.then(
    () => {
      seen.settled = true;
    },
    () => {
      seen.settled = true;
    },
  );
  return { promise, execution, seen };
}

function assertTerminalCleanup(p, run) {
  assert.equal(run.seen.cleanupCount, 1);
  assert.equal(p.releases.length, 1);
  assert.equal(p.events.filter((event) => event === "binding-closed").length, 1);
  assert.equal(p.events.filter((event) => event === "listener-removed").length, 1);
  for (const earlier of ["binding-closed", "client-released", "listener-removed"])
    assert.ok(p.events.indexOf(earlier) < p.events.indexOf("retained-cleanup"), earlier);
}

test(
  "Gateway central owns one real phase and returns exact completion after terminal cleanup",
  options,
  async () => {
    const p = protocol();
    const run = runGateway(p, async () => completion, {
      cleanup: async (_phase, unit, context) => {
        // The actual lifetime and store correspondence must already be revoked when
        // the real phase releases a retained participant cleanup callback.
        assert.throws(() => context.lifetime.assertActive(), ScopeViolationError);
        assert.throws(
          () => p.state.queryInTransaction(unit, "SELECT 2"),
          DependencyUnavailableError,
        );
      },
    });
    assert.equal(await run.promise, completion);
    assert.equal(run.execution.finalized, completion);
    assert.equal(run.execution.disposition, "acknowledged");
    assert.equal(run.execution.establishedNoCommit, false);
    assert.equal(run.seen.phase, run.execution.phase);
    assert.equal(run.seen.callbackCount, 1);
    assert.equal(run.seen.commandCount, 1);
    assert.deepEqual(p.controls(), ["BEGIN ISOLATION LEVEL READ COMMITTED", "COMMIT"]);
    assertTerminalCleanup(p, run);
    let lateRan = false;
    await assert.rejects(
      run.seen.phase.runOperation("late", async () => {
        lateRan = true;
      }),
    );
    assert.equal(lateRan, false);
    assert.equal(p.calls.includes("SELECT 2"), false);
  },
);

test(
  "Gateway central drains a query ignored by its accepted operation before COMMIT",
  options,
  async (t) => {
    const waiting = deferred();
    const submitted = deferred();
    t.after(() => waiting.resolve(queryResult()));
    const p = protocol({
      probe: () => {
        submitted.resolve();
        return waiting.promise;
      },
    });
    const run = runGateway(p, async (phase) => {
      void phase.runOperation("ignored-query", async (io) => {
        // The scope owns this query even when both enclosing callers ignore it.
        void io.query("SELECT 1");
      });
      return completion;
    });
    await submitted.promise;
    await tick();
    assert.equal(run.seen.settled, false);
    assert.equal(p.calls.includes("COMMIT"), false);
    assert.equal(run.execution.finalized, undefined);
    waiting.resolve(queryResult());
    assert.equal(await run.promise, completion);
    assert.equal(p.calls.filter((sql) => sql === "SELECT 1").length, 1);
    assertTerminalCleanup(p, run);
  },
);

test(
  "Gateway central retains the full accepted continuation and later query during drainage",
  options,
  async (t) => {
    const queryWait = deferred();
    const querySubmitted = deferred();
    const applicationWait = deferred();
    const applicationEntered = deferred();
    t.after(() => {
      queryWait.resolve(queryResult());
      applicationWait.resolve();
    });
    const p = protocol({
      probe: (statement) => {
        if (statement === "SELECT 1") {
          querySubmitted.resolve();
          return queryWait.promise;
        }
        return queryResult();
      },
    });
    const run = runGateway(p, async (phase) => {
      void phase.runOperation("complete-continuation", async (io) => {
        await io.query("SELECT 1");
        applicationEntered.resolve();
        await applicationWait.promise;
        io.assertActive();
        await io.query("SELECT 2");
        p.events.push("application-finished");
      });
      return completion;
    });
    await querySubmitted.promise;
    queryWait.resolve(queryResult());
    await applicationEntered.promise;
    await tick();
    assert.equal(run.seen.settled, false);
    assert.equal(p.calls.includes("COMMIT"), false);
    applicationWait.resolve();
    assert.equal(await run.promise, completion);
    assert.equal(p.calls.filter((sql) => sql === "SELECT 2").length, 1);
    assert.ok(p.events.indexOf("application-finished") < p.events.indexOf("commit-dispatched"));
    assertTerminalCleanup(p, run);
  },
);

test(
  "Gateway central cannot commit after an accepted query rejection is caught",
  options,
  async () => {
    const failure = new Error("controlled query rejection");
    const p = protocol({
      probe: () => {
        throw failure;
      },
    });
    const run = runGateway(p, async (phase) => {
      await phase.runOperation("caught-query", async (io) => {
        try {
          await io.query("SELECT 1");
        } catch {
          p.events.push("query-error-caught");
        }
      });
      return completion;
    });
    await assert.rejects(run.promise, exactError(failure));
    assert.equal(run.execution.disposition, "not-sent");
    assert.equal(run.execution.finalized, undefined);
    assert.equal(p.calls.includes("COMMIT"), false);
    assert.equal(p.events.includes("query-error-caught"), true);
    assert.deepEqual(p.controls(), ["BEGIN ISOLATION LEVEL READ COMMITTED", "ROLLBACK"]);
    assertTerminalCleanup(p, run);
  },
);

for (const failure of [new Error("explicit swallowed participant failure"), undefined]) {
  test(
    `Gateway central preserves explicit poison despite a returned completion (${failure === undefined ? "undefined" : "Error"})`,
    options,
    async () => {
      const p = protocol();
      const run = runGateway(p, async (phase) => {
        await phase.runOperation("swallowed-application-error", async (io) => {
          try {
            throw failure;
          } catch (error) {
            io.poison(error);
          }
        });
        return completion;
      });
      await assert.rejects(
        run.promise,
        failure === undefined ? knownUnavailable : exactError(failure),
      );
      assert.equal(run.execution.finalized, undefined);
      assert.equal(run.execution.disposition, "not-sent");
      assert.equal(p.calls.includes("COMMIT"), false);
      assertTerminalCleanup(p, run);
    },
  );
}

test(
  "Gateway central returns rollback completion without ever dispatching COMMIT",
  options,
  async () => {
    const rejected = Object.freeze({
      kind: "rollback",
      response: Object.freeze({ kind: "denied" }),
    });
    const p = protocol();
    const run = runGateway(p, async () => rejected);
    assert.equal(await run.promise, rejected);
    assert.equal(run.execution.finalized, rejected);
    assert.equal(run.execution.disposition, "not-sent");
    assert.deepEqual(p.controls(), ["BEGIN ISOLATION LEVEL READ COMMITTED", "ROLLBACK"]);
    assertTerminalCleanup(p, run);
  },
);

test(
  "Gateway central rollback cleanup failure cannot produce a committed result",
  options,
  async () => {
    const failure = new Error("release failed after rollback");
    const p = protocol({
      release: () => {
        throw failure;
      },
    });
    const run = runGateway(p, async () => ({
      kind: "rollback",
      response: { kind: "unavailable" },
    }));
    await assert.rejects(run.promise, exactError(failure));
    assert.equal(run.execution.finalized.kind, "rollback");
    assert.equal(run.execution.disposition, "not-sent");
    assert.equal(p.calls.includes("COMMIT"), false);
    assertTerminalCleanup(p, run);
  },
);

test(
  "Gateway central preserves command failure before dispatch over later cleanup failure",
  options,
  async () => {
    const failure = new Error("original command failure");
    const p = protocol({
      release: () => {
        throw new Error("later release failure");
      },
    });
    const run = runGateway(p, async () => {
      throw failure;
    });
    await assert.rejects(run.promise, exactError(failure));
    assert.equal(run.execution.disposition, "not-sent");
    assert.deepEqual(p.controls(), ["BEGIN ISOLATION LEVEL READ COMMITTED", "ROLLBACK"]);
    assertTerminalCleanup(p, run);
  },
);

test(
  "Gateway central finalizes after lifetime closure and fences failure before dispatch",
  options,
  async () => {
    const failure = new Error("selected state changed");
    const p = protocol();
    const run = runGateway(p, async (phase, _unit, context) => {
      phase.retainCurrentness(() => {
        assert.throws(() => context.lifetime.assertActive(), ScopeViolationError);
        p.events.push("final-fence");
        throw failure;
      });
      return completion;
    });
    await assert.rejects(run.promise, exactError(failure));
    assert.equal(p.events.includes("final-fence"), true);
    assert.equal(p.calls.includes("COMMIT"), false);
    assert.equal(run.execution.finalized, undefined);
    assertTerminalCleanup(p, run);
  },
);

test(
  "Gateway central drains an invalid asynchronous final fence before rollback cleanup",
  options,
  async (t) => {
    const fence = deferred();
    const entered = deferred();
    t.after(() => fence.resolve());
    const p = protocol();
    const run = runGateway(p, async (phase) => {
      // A currentness fence is synchronous. Its invalid promise must still be joined
      // by the actual phase after finalization discovers the contract violation.
      phase.retainCurrentness(() => {
        entered.resolve();
        return fence.promise;
      });
      return completion;
    });
    await entered.promise;
    await tick();
    assert.equal(run.seen.settled, false);
    assert.equal(run.seen.cleanupCount, 0);
    assert.equal(p.calls.includes("ROLLBACK"), false);
    assert.equal(p.calls.includes("COMMIT"), false);
    fence.resolve();
    await assert.rejects(run.promise);
    assert.equal(run.execution.disposition, "not-sent");
    assertTerminalCleanup(p, run);
  },
);

for (const code of ["40003", "ECONNRESET", "XX000"]) {
  test(
    `Gateway central ${code} at COMMIT remains unknown despite a later responding rollback`,
    options,
    async () => {
      const p = protocol({
        commit: () => {
          throw Object.assign(new Error("controlled commit failure"), { code });
        },
      });
      const run = runGateway(p);
      await assert.rejects(run.promise, PostgresCommitOutcomeUnknownError);
      assert.equal(run.execution.disposition, "sent");
      assert.equal(run.execution.establishedNoCommit, false);
      assert.equal(run.execution.finalized, completion);
      assert.deepEqual(p.controls(), [
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        "COMMIT",
        "ROLLBACK",
      ]);
      assert.deepEqual(p.releases, [true]);
      assertTerminalCleanup(p, run);
    },
  );
}

test(
  "Gateway central positively classified COMMIT rejection stays established noncommit",
  options,
  async () => {
    const p = protocol({
      commit: () => {
        throw Object.assign(new Error("constraint rejected COMMIT"), { code: "23514" });
      },
    });
    const run = runGateway(p);
    await assert.rejects(run.promise, ScopeViolationError);
    assert.equal(run.execution.disposition, "sent");
    assert.equal(run.execution.establishedNoCommit, true);
    assert.deepEqual(p.controls(), ["BEGIN ISOLATION LEVEL READ COMMITTED", "COMMIT", "ROLLBACK"]);
    assertTerminalCleanup(p, run);
  },
);

test(
  "Gateway central exact ROLLBACK acknowledgement establishes rejection without another rollback",
  options,
  async () => {
    const p = protocol({ commit: () => ({ command: "ROLLBACK", rows: [], rowCount: 0 }) });
    const run = runGateway(p);
    await assert.rejects(run.promise, knownUnavailable);
    assert.equal(run.execution.disposition, "sent");
    assert.equal(run.execution.establishedNoCommit, true);
    assert.deepEqual(p.controls(), ["BEGIN ISOLATION LEVEL READ COMMITTED", "COMMIT"]);
    assertTerminalCleanup(p, run);
  },
);

test("Gateway central missing acknowledgement command remains unknown", options, async () => {
  const p = protocol({ commit: () => ({ rows: [], rowCount: 0 }) });
  const run = runGateway(p);
  await assert.rejects(run.promise, PostgresCommitOutcomeUnknownError);
  assert.equal(run.execution.disposition, "sent");
  assert.equal(run.execution.establishedNoCommit, false);
  assertTerminalCleanup(p, run);
});

test(
  "Gateway central acknowledgement inspection error cannot imitate a classified COMMIT rejection",
  options,
  async () => {
    const p = protocol({
      commit: () => ({
        get command() {
          throw Object.assign(new Error("acknowledgement getter failed"), { code: "23514" });
        },
      }),
    });
    const run = runGateway(p);
    await assert.rejects(run.promise, PostgresCommitOutcomeUnknownError);
    assert.equal(run.execution.disposition, "sent");
    assert.equal(run.execution.establishedNoCommit, false);
    assertTerminalCleanup(p, run);
  },
);

for (const failedCleanup of ["release", "listener", "lease"]) {
  test(
    `Gateway central acknowledged COMMIT plus ${failedCleanup} cleanup failure stays terminal committed and outward unknown`,
    options,
    async () => {
      const failure = new Error(`controlled ${failedCleanup} cleanup failure`);
      const p = protocol({
        release:
          failedCleanup === "release"
            ? () => {
                throw failure;
              }
            : undefined,
        removeListener:
          failedCleanup === "listener"
            ? () => {
                throw failure;
              }
            : undefined,
      });
      const run = runGateway(p, async (phase) => {
        phase.retainCleanup(async () => {
          p.events.push("second-retained-cleanup");
          if (failedCleanup === "lease") throw failure;
        });
        return completion;
      });
      await assert.rejects(run.promise, PostgresCommitOutcomeUnknownError);
      assert.equal(run.execution.disposition, "acknowledged");
      assert.equal(run.execution.establishedNoCommit, false);
      assert.equal(run.execution.finalized, completion);
      assert.deepEqual(p.controls(), ["BEGIN ISOLATION LEVEL READ COMMITTED", "COMMIT"]);
      assertTerminalCleanup(p, run);
      assert.ok(p.events.indexOf("listener-removed") < p.events.indexOf("second-retained-cleanup"));
      assert.ok(p.events.indexOf("second-retained-cleanup") < p.events.indexOf("retained-cleanup"));
      // With actual ACK observed, the real phase rejects every other terminal enum
      // before running cleanup. Both releases above therefore require committed.
      // Its one terminal pass remains consumed even when a retained release throws.
      const completedCleanups = p.events.filter((event) => event.includes("retained-cleanup"));
      await assert.rejects(run.seen.phase.finishTerminal("committed"));
      assert.deepEqual(
        p.events.filter((event) => event.includes("retained-cleanup")),
        completedCleanups,
      );
    },
  );
}

test(
  "Gateway central cancellation racing with exact COMMIT ACK retains terminal committed",
  options,
  async () => {
    const abort = new AbortController();
    const p = protocol({
      commit: () => {
        abort.abort();
        return { command: "COMMIT", rows: [], rowCount: 0 };
      },
    });
    const run = runGateway(p, async () => completion, { signal: abort.signal });
    await assert.rejects(run.promise, PostgresCommitOutcomeUnknownError);
    assert.equal(run.execution.disposition, "acknowledged");
    assert.equal(run.execution.establishedNoCommit, false);
    assert.deepEqual(p.controls(), ["BEGIN ISOLATION LEVEL READ COMMITTED", "COMMIT"]);
    assert.deepEqual(p.releases, [true]);
    assertTerminalCleanup(p, run);
  },
);

test(
  "Gateway central transport error after callback completion poisons the final boundary",
  options,
  async () => {
    const p = protocol();
    const run = runGateway(p, async (phase) => {
      phase.retainCurrentness(() => {
        p.transportError();
        return undefined;
      });
      return completion;
    });
    await assert.rejects(run.promise, knownFailure);
    assert.equal(p.calls.includes("COMMIT"), false);
    assert.equal(run.execution.disposition, "not-sent");
    assert.deepEqual(p.releases, [true]);
    assertTerminalCleanup(p, run);
  },
);

test(
  "Gateway central cancellation waits for the accepted raw query and rejection continuation",
  options,
  async (t) => {
    const abort = new AbortController();
    const waiting = deferred();
    const submitted = deferred();
    t.after(() => waiting.resolve(queryResult()));
    const p = protocol({
      probe: () => {
        submitted.resolve();
        return waiting.promise;
      },
    });
    const run = runGateway(
      p,
      async (phase) => {
        void phase.runOperation("cancelled-query", async (io) => {
          try {
            await io.query("SELECT 1");
          } catch (error) {
            p.events.push("query-rejection-joined");
            throw error;
          }
        });
        return completion;
      },
      { signal: abort.signal },
    );
    await submitted.promise;
    abort.abort();
    await tick();
    assert.deepEqual(p.releases, [true]);
    assert.equal(run.seen.settled, false);
    assert.equal(run.seen.cleanupCount, 0);
    assert.equal(p.calls.includes("COMMIT"), false);
    waiting.reject(new Error("destroyed transport rejects admitted query"));
    await assert.rejects(run.promise, knownUnavailable);
    assert.ok(p.events.indexOf("client-released") < p.events.indexOf("query-rejection-joined"));
    assert.ok(p.events.indexOf("query-rejection-joined") < p.events.indexOf("retained-cleanup"));
    assertTerminalCleanup(p, run);
  },
);

test(
  "Gateway central cancellation joins an accepted command before rejecting its late operation",
  options,
  async (t) => {
    const abort = new AbortController();
    const resume = deferred();
    const entered = deferred();
    t.after(() => resume.resolve());
    const p = protocol();
    let lateBodyRan = false;
    const run = runGateway(
      p,
      async (phase) => {
        entered.resolve();
        await resume.promise;
        await assert.rejects(
          phase.runOperation("late-after-cancellation", async (io) => {
            lateBodyRan = true;
            await io.query("SELECT 2");
          }),
        );
        p.events.push("late-command-joined");
        return completion;
      },
      { signal: abort.signal },
    );
    await entered.promise;
    abort.abort();
    await tick();
    assert.equal(run.seen.settled, false);
    assert.equal(run.seen.cleanupCount, 0);
    resume.resolve();
    await assert.rejects(run.promise, knownUnavailable);
    assert.equal(lateBodyRan, false);
    assert.equal(p.calls.includes("SELECT 2"), false);
    assert.equal(p.calls.includes("COMMIT"), false);
    assert.ok(p.events.indexOf("late-command-joined") < p.events.indexOf("retained-cleanup"));
    assertTerminalCleanup(p, run);
  },
);

test(
  "Gateway central joins a cancelled direct callback even before it attempts phase admission",
  options,
  async (t) => {
    const abort = new AbortController();
    const resume = deferred();
    const entered = deferred();
    t.after(() => resume.resolve());
    const p = protocol();
    const run = runGateway(p, async () => completion, {
      signal: abort.signal,
      beforeCommand: async () => {
        entered.resolve();
        await resume.promise;
        p.events.push("direct-callback-joined");
      },
    });
    await entered.promise;
    abort.abort();
    await tick();
    assert.equal(run.seen.settled, false);
    assert.equal(p.events.includes("binding-closed"), false);
    resume.resolve();
    await assert.rejects(run.promise, knownUnavailable);
    assert.equal(run.seen.callbackCount, 1);
    assert.equal(run.seen.commandCount, 0);
    assert.equal(run.seen.cleanupCount, 0);
    assert.ok(p.events.indexOf("direct-callback-joined") < p.events.indexOf("binding-closed"));
    assert.equal(p.calls.includes("COMMIT"), false);
    assert.equal(p.releases.length, 1);
  },
);

for (const route of ["repository", "query-helper", "outward-client"]) {
  test(
    `Gateway central ${route} isolation poisons even when the caller catches rejection`,
    options,
    async () => {
      const p = protocol();
      const run = runGateway(p, async (_phase, unit, context) => {
        try {
          if (route === "repository") await unit.installations.getInstallation();
          if (route === "query-helper") await p.state.queryInTransaction(unit, "SELECT 1");
          if (route === "outward-client") await context.client.query("SELECT 1");
          assert.fail("Outward access must reject in the isolated Gateway transaction.");
        } catch (error) {
          assert.ok(error instanceof ScopeViolationError);
        }
        return completion;
      });
      await assert.rejects(run.promise, ScopeViolationError);
      assert.equal(p.calls.includes("SELECT 1"), false);
      assert.equal(p.calls.includes("COMMIT"), false);
      assertTerminalCleanup(p, run);
    },
  );
}

test(
  "Gateway central absent genuine participants fail before pool acquisition or callback",
  options,
  async () => {
    const p = protocol();
    const binding = p.state.bindGatewayStartupOwnersV1();
    let callbackRan = false;
    const result = await binding.transaction.run(
      { schemaVersion: 1, kind: "read-operation", operation },
      {
        requestRef: "controlled-request",
        deadline: new Date(Date.now() + 1000).toISOString(),
        signal: new AbortController().signal,
      },
      async () => {
        callbackRan = true;
        return completion;
      },
    );
    assert.deepEqual(result, { kind: "rolled-back", response: { kind: "unavailable" } });
    assert.equal(binding.participants, undefined);
    assert.equal(callbackRan, false);
    assert.equal(p.connects(), 0);
    assert.deepEqual(p.calls, []);
    assert.deepEqual(p.releases, []);
  },
);

test(
  "Gateway central captures the acknowledgement command once before terminal cleanup",
  options,
  async () => {
    let commandReads = 0;
    const p = protocol({
      commit: () => ({
        get command() {
          commandReads++;
          if (commandReads !== 1) throw new Error("protocol acknowledgement reread");
          return "COMMIT";
        },
        rows: [],
        rowCount: 0,
      }),
    });
    const run = runGateway(p);
    assert.equal(await run.promise, completion);
    assert.equal(commandReads, 1);
    assert.equal(run.execution.disposition, "acknowledged");
    assert.equal(run.execution.establishedNoCommit, false);
    assert.deepEqual(p.controls(), ["BEGIN ISOLATION LEVEL READ COMMITTED", "COMMIT"]);
    assertTerminalCleanup(p, run);
  },
);
