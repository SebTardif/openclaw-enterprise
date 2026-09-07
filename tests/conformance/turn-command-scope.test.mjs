import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnCommandScopeV1 } from "../../packages/occ/src/state/postgres/turn-command-scope.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";

// Actual local control, with controlled lease callbacks: no account authentication,
// SQL, native acceptance or real COMMIT is claimed by these component cases.
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const identity = () => ({
  installationId: "ins_original",
  namespaceId: "ns_original",
  agentId: "agt_original",
  operationRef: "op_original",
});
function fixture(overrides = {}) {
  const transaction = new RepositoryTransactionLifetime();
  const controller = new AbortController();
  const clock = {
    wall: 1000,
    elapsed: 0,
    now() {
      return this.wall;
    },
    monotonic() {
      return this.elapsed;
    },
  };
  const scope = new TurnCommandScopeV1(
    transaction,
    identity(),
    { signal: controller.signal, deadline: new Date(11000).toISOString() },
    clock,
  );
  const events = [];
  const lease = {
    async prepareCommit() {
      events.push("prepare");
    },
    assertCurrent() {},
    async release(outcome) {
      events.push(`release:${outcome}`);
    },
    ...overrides,
  };
  const source = {
    async consume(unit) {
      assert.equal(unit, scope.unit);
      events.push("enroll");
      return lease;
    },
  };
  return { scope, transaction, controller, clock, events, lease, source };
}
const failureOf = (p) =>
  p.then(
    () => assert.fail("expected rejection"),
    (error) => error,
  );
const rollback = (s) => failureOf(s.finishTerminal("rolled-back"));

test("missing genuine source refuses before work", async () => {
  const f = fixture();
  const error = await failureOf(f.scope.enroll());
  assert.equal(error.name, "DependencyUnavailableError");
  assert.equal(
    await failureOf(f.scope.runOperation("journal-read", async () => assert.fail("ran"))),
    error,
  );
  assert.equal(await rollback(f.scope), error);
  assert.deepEqual(f.events, []);
});
test("absent enrollment result stays unavailable", async () => {
  const f = fixture();
  const error = await failureOf(
    f.scope.enroll({
      async consume() {
        return undefined;
      },
    }),
  );
  assert.equal(error.name, "DependencyUnavailableError");
  assert.equal(await rollback(f.scope), error);
});
test("frozen unit is an exact transaction identity; copies poison", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  assert.ok(Object.isFrozen(f.scope.unit));
  f.scope.assertOwned(f.scope.unit);
  let error;
  try {
    f.scope.assertOwned({ ...f.scope.unit });
  } catch (e) {
    error = e;
  }
  assert.equal(error.name, "ScopeViolationError");
  assert.equal(await rollback(f.scope), error);
});
test("identity accessors cannot run during capture", () => {
  const original = identity();
  let called = false;
  Object.defineProperty(original, "agentId", {
    get() {
      called = true;
      return "foreign";
    },
  });
  assert.throws(
    () =>
      new TurnCommandScopeV1(new RepositoryTransactionLifetime(), original, {
        signal: new AbortController().signal,
        deadline: new Date(Date.now() + 10000).toISOString(),
      }),
  );
  assert.equal(called, false);
});
test("original cancellation prevents source invocation", async () => {
  const f = fixture();
  const error = new Error("cancel");
  f.controller.abort(error);
  assert.equal(await failureOf(f.scope.enroll(f.source)), error);
  assert.deepEqual(f.events, []);
  assert.equal(await rollback(f.scope), error);
});
test("accepted operations serialize and drain after submissions close", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  const gate = deferred(),
    entered = deferred(),
    order = [];
  const a = f.scope.runOperation("journal-read", async () => {
    order.push(1);
    entered.resolve();
    await gate.promise;
    order.push(2);
  });
  const b = f.scope.runOperation("mutation-audit", async () => {
    order.push(3);
  });
  await entered.promise;
  const drain = f.scope.drainAccepted();
  assert.deepEqual(order, [1]);
  gate.resolve();
  await Promise.all([a, b, drain]);
  assert.deepEqual(order, [1, 2, 3]);
  await f.scope.prepareCommit();
  assert.equal(f.scope.assertCommitReady(), undefined);
  f.scope.markCommitDispatched();
  f.scope.observeCommitAcknowledgement("COMMIT");
  await f.scope.finishTerminal("committed");
  assert.deepEqual(f.events, ["enroll", "prepare", "release:committed"]);
});
test("caught late admission poisons commit preparation", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  f.scope.closeAdmissions();
  const error = await failureOf(
    f.scope.runOperation("journal-read", async () => assert.fail("late")),
  );
  assert.equal(await failureOf(f.scope.prepareCommit()), error);
  assert.equal(await rollback(f.scope), error);
});
test("unawaited child is joined and its original failure poisons", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  const gate = deferred(),
    entered = deferred(),
    error = new Error("child");
  const op = failureOf(
    f.scope.runOperation("journal-mutation", async (io) => {
      void io.track(async () => {
        entered.resolve();
        await gate.promise;
        throw error;
      });
    }),
  );
  await entered.promise;
  const preparing = failureOf(f.scope.prepareCommit());
  gate.resolve();
  assert.equal(await op, error);
  assert.equal(await preparing, error);
  assert.equal(await rollback(f.scope), error);
  assert.deepEqual(f.events, ["enroll", "release:rolled-back"]);
});
test("callback failure still joins child before terminal release", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  const gate = deferred(),
    entered = deferred(),
    error = new Error("callback");
  const op = failureOf(
    f.scope.runOperation("journal-mutation", async (io) => {
      void io.track(async () => {
        entered.resolve();
        await gate.promise;
      });
      await entered.promise;
      throw error;
    }),
  );
  await entered.promise;
  await Promise.resolve();
  const terminal = failureOf(f.scope.finishTerminal("rolled-back"));
  assert.equal(f.events.length, 1);
  gate.resolve();
  assert.equal(await op, error);
  assert.equal(await terminal, error);
  assert.equal(f.events.at(-1), "release:rolled-back");
});
test("earlier failure stops a queued operation", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  const error = new Error("first");
  let ran = false;
  const a = failureOf(
    f.scope.runOperation("journal-read", async () => {
      throw error;
    }),
  );
  const b = failureOf(
    f.scope.runOperation("journal-read", async () => {
      ran = true;
    }),
  );
  assert.equal(await a, error);
  assert.equal(await b, error);
  assert.equal(ran, false);
  assert.equal(await rollback(f.scope), error);
});
test("nested serialized operation refuses instead of deadlocking", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  const error = await failureOf(
    f.scope.runOperation("journal-read", async () =>
      f.scope.runOperation("journal-read", async () => assert.fail("nested")),
    ),
  );
  assert.equal(error.name, "DependencyUnavailableError");
  assert.equal(await rollback(f.scope), error);
});
test("escaped operation scope cannot admit later child work", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  let escaped;
  await f.scope.runOperation("journal-read", async (io) => {
    escaped = io;
  });
  const error = await failureOf(escaped.track(async () => assert.fail("escaped")));
  assert.equal(await rollback(f.scope), error);
});
test("async prepareCommit settles before final synchronous fence", async () => {
  const gate = deferred(),
    entered = deferred();
  const f = fixture({
    async prepareCommit() {
      entered.resolve();
      await gate.promise;
    },
  });
  await f.scope.enroll(f.source);
  const preparing = f.scope.prepareCommit();
  await entered.promise;
  gate.resolve();
  await preparing;
  assert.equal(f.scope.assertCommitReady(), undefined);
  f.scope.markCommitDispatched();
  await f.scope.finishTerminal("commit-unknown");
  assert.equal(f.events.at(-1), "release:commit-unknown");
});
test("revocation after prepare is caught immediately before COMMIT", async () => {
  const error = new Error("revoked");
  let revoked = false;
  const f = fixture({
    assertCurrent() {
      if (revoked) throw error;
    },
  });
  await f.scope.enroll(f.source);
  await f.scope.prepareCommit();
  revoked = true;
  assert.throws(
    () => f.scope.markCommitDispatched(),
    (e) => e === error,
  );
  assert.equal(await rollback(f.scope), error);
});
test("invalid async currentness is drained before lease release", async () => {
  const gate = deferred(),
    entered = deferred();
  let asyncFence = false;
  const f = fixture({
    assertCurrent() {
      if (asyncFence) {
        entered.resolve();
        return gate.promise;
      }
    },
  });
  await f.scope.enroll(f.source);
  asyncFence = true;
  const preparing = failureOf(f.scope.prepareCommit());
  await entered.promise;
  const terminal = failureOf(f.scope.finishTerminal("rolled-back"));
  assert.equal(f.events.length, 1);
  gate.resolve();
  const error = await preparing;
  assert.equal(error.name, "DependencyUnavailableError");
  assert.equal(await terminal, error);
});
test("release custody survives later enrollment getter failure", async () => {
  const f = fixture();
  const error = new Error("getter");
  let releases = 0;
  const lease = {
    async release(outcome) {
      assert.equal(outcome, "rolled-back");
      releases++;
    },
    get prepareCommit() {
      throw error;
    },
    assertCurrent() {},
  };
  assert.equal(
    await failureOf(
      f.scope.enroll({
        async consume() {
          return lease;
        },
      }),
    ),
    error,
  );
  assert.equal(await rollback(f.scope), error);
  assert.equal(releases, 1);
});
test("callbacks retain their original receiver and method", async () => {
  const f = fixture();
  const lease = {
    marker: 7,
    assertCurrent() {
      assert.equal(this.marker, 7);
    },
    async prepareCommit() {
      assert.equal(this.marker, 7);
    },
    async release() {
      assert.equal(this.marker, 7);
    },
  };
  await f.scope.enroll({
    async consume() {
      return lease;
    },
  });
  lease.prepareCommit = () => assert.fail("replacement");
  await f.scope.prepareCommit();
  await f.scope.finishTerminal("rolled-back");
});
test("wall clock rollback cannot extend the admitted duration", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  f.clock.wall = 0;
  f.clock.elapsed = 10000;
  const error = await failureOf(
    f.scope.runOperation("journal-read", async () => assert.fail("expired")),
  );
  assert.equal(error.name, "DependencyUnavailableError");
  assert.equal(await rollback(f.scope), error);
});
test("actual transaction lifetime closing rejects later work", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  f.transaction.close();
  const error = await failureOf(
    f.scope.runOperation("journal-read", async () => assert.fail("closed")),
  );
  assert.equal(error.name, "ScopeViolationError");
  assert.equal(await rollback(f.scope), error);
});
test("COMMIT cannot be marked before preparation or manufactured by ACK", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  assert.throws(() => f.scope.markCommitDispatched());
  assert.throws(() => f.scope.observeCommitAcknowledgement("COMMIT"));
  await rollback(f.scope);
});
test("unknown COMMIT remains unknown and cannot reenroll", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  await f.scope.prepareCommit();
  f.scope.markCommitDispatched();
  await assert.rejects(f.scope.finishTerminal("committed"));
  await f.scope.finishTerminal("commit-unknown");
  await assert.rejects(f.scope.enroll(f.source));
  assert.deepEqual(f.events, ["enroll", "prepare", "release:commit-unknown"]);
});
test("cancellation racing an ACK preserves actual terminal fact", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  await f.scope.prepareCommit();
  f.scope.markCommitDispatched();
  const error = new Error("cancel after send");
  f.controller.abort(error);
  f.scope.observeCommitAcknowledgement("COMMIT");
  assert.equal(await failureOf(f.scope.finishTerminal("committed")), error);
  assert.equal(f.events.at(-1), "release:committed");
});
test("terminal cleanup is once and original error survives release failure", async () => {
  const error = new Error("original");
  let count = 0;
  const f = fixture({
    async release() {
      count++;
      throw new Error("cleanup");
    },
  });
  await f.scope.enroll(f.source);
  f.scope.poison(error);
  const a = f.scope.finishTerminal("rolled-back"),
    b = f.scope.finishTerminal("rolled-back");
  assert.equal(a, b);
  assert.equal(await failureOf(a), error);
  assert.equal(count, 1);
  await assert.rejects(f.scope.finishTerminal("commit-unknown"));
});
test("a thrown undefined remains the exact first failure", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  await assert.rejects(
    f.scope.runOperation("journal-read", async () => {
      throw undefined;
    }),
    (e) => e === undefined,
  );
  await assert.rejects(f.scope.prepareCommit(), (e) => e === undefined);
  await assert.rejects(f.scope.finishTerminal("rolled-back"), (e) => e === undefined);
});

test("a delayed tracked child retains the nested-admission guard until drained", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  const gate = deferred(),
    entered = deferred();
  const operation = failureOf(
    f.scope.runOperation("journal-read", async (io) => {
      void io.track(async () => {
        entered.resolve();
        await gate.promise;
        await f.scope.runOperation("journal-read", async () => assert.fail("nested child"));
      });
    }),
  );
  await entered.promise;
  await Promise.resolve();
  gate.resolve();
  const error = await operation;
  assert.equal(error.name, "DependencyUnavailableError");
  assert.equal(await rollback(f.scope), error);
});
for (const method of ["drainAccepted", "prepareCommit", "finishTerminal"]) {
  test(`owner ${method} rejects reentry instead of joining itself`, async () => {
    const f = fixture();
    await f.scope.enroll(f.source);
    const error = await failureOf(
      f.scope.runOperation("journal-read", async () => {
        await f.scope[method]("rolled-back");
      }),
    );
    assert.equal(error.name, "DependencyUnavailableError");
    assert.equal(await rollback(f.scope), error);
  });
}

for (const stage of ["enrollment", "preparation"]) {
  for (const method of ["drainAccepted", "prepareCommit", "finishTerminal"]) {
    test(`${stage} callback cannot self-join through ${method}`, async () => {
      const f = fixture();
      const reenter = () => f.scope[method]("rolled-back");
      let error;
      if (stage === "enrollment") {
        error = await failureOf(
          f.scope.enroll({
            async consume() {
              await reenter();
              return f.lease;
            },
          }),
        );
      } else {
        f.lease.prepareCommit = reenter;
        await f.scope.enroll(f.source);
        error = await failureOf(f.scope.prepareCommit());
      }
      assert.equal(error.name, "DependencyUnavailableError");
      assert.equal(await rollback(f.scope), error);
    });
  }
}

test("terminal lease release cannot await its own terminal promise", async () => {
  let scope;
  const f = fixture({
    async release(outcome) {
      await scope.finishTerminal(outcome);
    },
  });
  scope = f.scope;
  await scope.enroll(f.source);
  const error = await failureOf(scope.finishTerminal("rolled-back"));
  assert.equal(error.name, "DependencyUnavailableError");
  assert.equal(await failureOf(scope.finishTerminal("rolled-back")), error);
});

test("detached operation descendants cannot reopen owner admission", async () => {
  const f = fixture();
  await f.scope.enroll(f.source);
  const gate = deferred();
  let detached;
  await f.scope.runOperation("journal-read", async () => {
    detached = failureOf(
      gate.promise.then(() =>
        f.scope.runOperation("journal-mutation", async () => assert.fail("late owner work")),
      ),
    );
  });
  gate.resolve();
  const error = await detached;
  assert.equal(error.name, "DependencyUnavailableError");
  assert.equal(await rollback(f.scope), error);
});
