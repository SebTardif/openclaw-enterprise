import assert from "node:assert/strict";
import test from "node:test";
import {
  createGatewayStartupOwnerV1,
  createGatewayStartupSubmissionOwnerV1,
  GatewayStartupOwnerPhaseV1,
  canonicalGatewayStartupValueV1,
  parseGatewayStartupBindingV1,
  parseGatewayStartupCommandV1,
  parseGatewayStartupEventV1,
} from "../../packages/occ/src/gateway-startup-v1/owner.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import {
  binding,
  controlledOwner,
  submissionCommand,
  consumeCommand,
  deferred,
} from "../fixtures/gateway-startup-v1/values.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const readResult = {
  kind: "commit",
  provisional: {
    kind: "not-observed",
    operation: {
      installationId: "installation",
      operationRef: "operation",
      operationDigest: "a".repeat(64),
      startup: null,
    },
  },
};

test("missing genuine participants refuse before transaction", async () => {
  const f = await controlledOwner();
  let calls = 0;
  const owner = createGatewayStartupOwnerV1({
    transaction: {
      async run() {
        calls++;
      },
    },
  });
  assert.equal((await owner.execute(f.accept, f.token, f.bounds)).kind, "unavailable");
  assert.equal(calls, 0);
});
test("accept, separate create submission, recipient consume and current read retain exact original identity", async () => {
  const f = await controlledOwner();
  const a = await f.execute(f.accept);
  assert.equal(a.kind, "accepted");
  assert.equal(a.record.binding.startup.processGeneration, 1);
  assert.equal(a.record.binding.hostRuntimeGeneration, 19);
  const sub = submissionCommand(a);
  const s = await f.execute(sub);
  assert.equal(s.kind, "submitted");
  const consume = consumeCommand(a, s);
  const c = await f.execute(consume);
  assert.equal(c.kind, "consumed");
  const r = await f.execute({
    schemaVersion: 1,
    kind: "read-current",
    startup: a.record.binding.startup,
    expectedRecordVersion: 3,
    recipient: consume.recipient,
  });
  assert.equal(r.kind, "current");
  assert.deepEqual(r.record.acceptance, a.record);
  assert.equal(f.retained().events.size, 3);
  assert.equal(f.retained().audits.length, 3);
  assert.ok(f.events.indexOf("account") < f.events.indexOf("selection"));
  assert.ok(f.events.indexOf("selection") < f.events.indexOf("head"));
  assert.ok(f.events.indexOf("audit") < f.events.indexOf("commit-dispatched"));
  assert.ok(f.events.indexOf("commit-dispatched") < f.events.indexOf("account-release"));
});
test("concurrent same acceptance gets one retention and exact replay requires historical recovery", async () => {
  const f = await controlledOwner();
  const results = await Promise.all([f.execute(f.accept), f.execute(f.accept)]);
  assert.deepEqual(
    results.map((r) => r.kind),
    ["accepted", "recovery-required"],
  );
  assert.equal(f.retained().events.size, 1);
  assert.equal(f.events.filter((e) => e === "allocate-process").length, 1);
  const historical = await f.execute({
    schemaVersion: 1,
    kind: "read-operation",
    operation: results[1].operation,
  });
  assert.equal(historical.kind, "observed");
  assert.equal(historical.operation.kind, "accept-startup");
});
test("changed operation payload and stale expected head deny without allocation", async () => {
  const f = await controlledOwner();
  await f.execute(f.accept);
  const n = f.events.filter((e) => e.startsWith("allocate")).length;
  assert.equal(
    (await f.execute({ ...f.accept, selectedDefinition: { recordRef: "other", recordVersion: 1 } }))
      .kind,
    "denied",
  );
  assert.equal((await f.execute({ ...f.accept, operationRef: "new-stale" })).kind, "denied");
  assert.equal(f.events.filter((e) => e.startsWith("allocate")).length, n);
});
test("audit failure cannot retain head, operation or capacity even after allocation", async () => {
  const f = await controlledOwner();
  f.options.failAudit = true;
  assert.equal((await f.execute(f.accept)).kind, "recovery-required");
  assert.equal(f.retained().events.size, 0);
  assert.equal(f.retained().audits.length, 0);
  assert.equal(f.retained().head.version, 0);
});
test("currentness withdrawal at final owner fence refuses commit", async () => {
  const f = await controlledOwner();
  f.options.beforeFinalize = () => {
    f.options.current = false;
  };
  assert.equal((await f.execute(f.accept)).kind, "recovery-required");
  assert.equal(f.retained().events.size, 0);
  assert.ok(!f.events.includes("commit-dispatched"));
});
test("consume cannot precede create submission or accept an unrelated recipient on current read", async () => {
  const f = await controlledOwner();
  const a = await f.execute(f.accept);
  const c = consumeCommand(a, { event: { afterHeadVersion: 1 } });
  c.expectedHead.recordVersion = 1;
  assert.equal((await f.execute(c)).kind, "denied");
  const s = await f.execute(submissionCommand(a));
  const proper = consumeCommand(a, s);
  await f.execute(proper);
  assert.equal(
    (
      await f.execute({
        schemaVersion: 1,
        kind: "read-current",
        startup: a.record.binding.startup,
        expectedRecordVersion: 3,
        recipient: { ...proper.recipient, incarnationRef: "foreign" },
      })
    ).kind,
    "denied",
  );
});
test("withdrawal preserves original generation and complete predecessor is required for replacement", async () => {
  const f = await controlledOwner();
  const a = await f.execute(f.accept);
  const w = await f.execute({
    schemaVersion: 1,
    kind: "withdraw",
    operationRef: "withdraw",
    startup: a.record.binding.startup,
    expectedHead: { version: 1, startup: a.record.binding.startup, recordVersion: 1 },
    reason: "administrative",
  });
  assert.equal(w.kind, "withdrawn");
  assert.equal(w.head.processGeneration, 1);
  const a2 = await f.execute({
    ...f.accept,
    operationRef: "replacement",
    expectedHead: { version: 2, startup: a.record.binding.startup, recordVersion: 2 },
    predecessorDisposition: { recordRef: "retirement-proof", recordVersion: 1 },
  });
  assert.equal(a2.kind, "accepted");
  assert.equal(a2.head.processGeneration, 2);
  assert.notEqual(a2.record.binding.createEffectRef, a.record.binding.createEffectRef);
  assert.deepEqual(a2.record.predecessor.previousStartup, a.record.binding.startup);
});
for (const terminal of ["commit-unknown", "commit-rejected"])
  test(`${terminal} cannot issue positive acceptance`, async () => {
    const f = await controlledOwner();
    f.options.terminal = terminal;
    const r = await f.execute(f.accept);
    assert.equal(r.kind, terminal === "commit-unknown" ? "recovery-required" : "unavailable");
    if (terminal === "commit-unknown") {
      f.options.terminal = "committed";
      assert.equal((await f.execute(f.accept)).kind, "recovery-required");
      assert.equal(f.events.filter((e) => e === "allocate-process").length, 1);
    }
  });
for (const mutate of [
  (x) => {
    x.extra = true;
  },
  (x) => {
    x.startup.processGeneration = 0;
  },
  (x) => {
    x.modules[0].extra = true;
  },
  (x) => {
    x.modules.push(x.modules[0]);
  },
])
  test("binding parser rejects malformed immutable data", () => {
    const b = binding();
    mutate(b);
    assert.throws(() => parseGatewayStartupBindingV1(b));
  });
test("canonical parser refuses accessors, sparse arrays, cycles and noninteger values without executing accessors", () => {
  let reads = 0;
  for (const x of [
    {
      get secret() {
        reads++;
        return 1;
      },
    },
    [, ,],
    { value: NaN },
    { value: 1.5 },
  ])
    assert.throws(() => canonicalGatewayStartupValueV1(x));
  const c = {};
  c.c = c;
  assert.throws(() => canonicalGatewayStartupValueV1(c));
  assert.equal(reads, 0);
});
test("retained event parser rejects cross-field identity and transition corruption", async () => {
  const f = await controlledOwner();
  await f.execute(f.accept);
  const good = [...f.retained().events.values()][0];
  for (const mutate of [
    (e) => {
      e.startup.processRef = "other";
    },
    (e) => {
      e.command.operationDigest = "f".repeat(64);
    },
    (e) => {
      e.afterHeadVersion = 3;
    },
    (e) => {
      e.acceptance.auditEventId = "other";
    },
    (e) => {
      e.recipient = {};
    },
  ]) {
    const e = structuredClone(good);
    mutate(e);
    assert.throws(() => parseGatewayStartupEventV1(e));
  }
  assert.deepEqual(parseGatewayStartupEventV1(good), good);
});

async function phaseFixture(query = async () => ({ rows: [], rowCount: 0 })) {
  const lifetime = new RepositoryTransactionLifetime();
  return { lifetime, phase: new GatewayStartupOwnerPhaseV1(lifetime, query) };
}
test("caught operation rejection poisons whole phase", async () => {
  const { phase, lifetime } = await phaseFixture();
  await phase.runCommand(async () => {
    await phase
      .runOperation("failed", async () => {
        throw Error("failure");
      })
      .catch(() => {});
    return readResult;
  });
  await phase.drainAccepted();
  assert.throws(() => phase.finalize());
  await assert.rejects(phase.finishTerminal("rolled-back"));
  await lifetime.finish();
});
test("unawaited query is drained and its rejection poisons later commit", async () => {
  const wait = deferred();
  const { phase, lifetime } = await phaseFixture(() => wait.promise);
  let returned = false;
  const command = phase.runCommand(async () => {
    await phase.runOperation("query", async (io) => {
      void io.query("controlled query").catch(() => {});
    });
    returned = true;
    return readResult;
  });
  await tick();
  assert.equal(returned, false);
  wait.reject(Error("query failed"));
  await command;
  await phase.drainAccepted();
  assert.throws(() => phase.finalize());
  await assert.rejects(phase.finishTerminal("rolled-back"));
  await lifetime.finish();
});
test("escaped completed operation cannot issue queries and caught rejection poisons active command", async () => {
  const { phase, lifetime } = await phaseFixture();
  let scope;
  await phase.runCommand(async () => {
    await phase.runOperation("capture", async (io) => {
      scope = io;
    });
    await scope.query("late").catch(() => {});
    return readResult;
  });
  await phase.drainAccepted();
  assert.throws(() => phase.finalize());
  await assert.rejects(phase.finishTerminal("rolled-back"));
  await lifetime.finish();
});
test("second command and late currentness registration cannot be caught into a commit", async () => {
  for (const action of [
    (phase) => phase.runCommand(async () => readResult).catch(() => {}),
    async (phase) => {
      phase.closeAdmissions();
      try {
        phase.retainCurrentness(() => undefined);
      } catch {}
    },
  ]) {
    const { phase, lifetime } = await phaseFixture();
    await phase.runCommand(async () => {
      await action(phase);
      return readResult;
    });
    await phase.drainAccepted();
    assert.throws(() => phase.finalize());
    await assert.rejects(phase.finishTerminal("rolled-back"));
    await lifetime.finish();
  }
});
test("asynchronous final fence is rejected and its late settlement remains owned", async () => {
  const wait = deferred();
  const { phase, lifetime } = await phaseFixture();
  await phase.runCommand(async () => {
    phase.retainCurrentness(() => wait.promise);
    return readResult;
  });
  await phase.drainAccepted();
  assert.throws(() => phase.finalize());
  let done = false;
  const terminal = phase
    .finishTerminal("rolled-back")
    .catch(() => {})
    .then(() => {
      done = true;
    });
  await tick();
  assert.equal(done, false);
  wait.resolve();
  await terminal;
  await lifetime.finish();
});
test("actual COMMIT acknowledgement precedes release and terminal call closes all capabilities", async () => {
  const events = [];
  const { phase, lifetime } = await phaseFixture();
  await phase.runCommand(async () => {
    phase.retainCleanup(async () => {
      events.push("release");
    });
    phase.retainCurrentness(() => undefined);
    return readResult;
  });
  await phase.drainAccepted();
  phase.finalize();
  phase.markCommitDispatched();
  phase.observeCommitAcknowledgement("COMMIT");
  assert.deepEqual(events, []);
  await phase.finishTerminal("committed");
  assert.deepEqual(events, ["release"]);
  assert.throws(() => phase.assertCommitReady());
  await assert.rejects(phase.runCommand(async () => readResult));
  await lifetime.finish();
});

test("submission ticket needs a fresh confirmed durable claim, exact call/input, and is consumed once", async () => {
  const f = await controlledOwner();
  const a = await f.execute(f.accept);
  const command = submissionCommand(a);
  const call = { authorityCall: {} };
  const source = {
    async resolve() {
      return { command, invocation: f.token, bounds: f.bounds, assertCurrent() {} };
    },
  };
  const provider = createGatewayStartupSubmissionOwnerV1(f.owner, source);
  const [one, two] = await Promise.all([
    provider.claimOriginal(command.input, call),
    provider.claimOriginal(command.input, call),
  ]);
  assert.equal(one.kind, "claimed");
  assert.equal(two.kind, "unknown");
  assert.equal(provider.consumeSubmission(one.submission, command.input, call), undefined);
  assert.throws(() => provider.consumeSubmission(one.submission, command.input, call));
  assert.equal(f.retained().events.size, 2);
});
for (const mismatch of ["call", "input", "ticket", "async-fence", "withdrawn"])
  test(`submission ${mismatch} never passes its provider-boundary fence`, async () => {
    const f = await controlledOwner();
    const a = await f.execute(f.accept);
    const command = submissionCommand(a);
    const call = { authorityCall: {} };
    let current = true,
      asyncFence = false;
    const provider = createGatewayStartupSubmissionOwnerV1(f.owner, {
      async resolve() {
        return {
          command,
          invocation: f.token,
          bounds: f.bounds,
          assertCurrent() {
            if (!current) throw Error("revoked");
            if (asyncFence) return Promise.resolve();
          },
        };
      },
    });
    const r = await provider.claimOriginal(command.input, call);
    assert.equal(r.kind, "claimed");
    if (mismatch === "async-fence") asyncFence = true;
    if (mismatch === "withdrawn") current = false;
    assert.throws(() =>
      provider.consumeSubmission(
        mismatch === "ticket" ? {} : r.submission,
        mismatch === "input"
          ? { ...command.input, launchPlan: { recordRef: "other", recordVersion: 1 } }
          : command.input,
        mismatch === "call" ? { ...call } : call,
      ),
    );
  });
test("unknown submission COMMIT and missing process source never issue a ticket", async () => {
  const f = await controlledOwner();
  const a = await f.execute(f.accept);
  const command = submissionCommand(a);
  const call = { authorityCall: {} };
  const noSource = createGatewayStartupSubmissionOwnerV1(f.owner);
  assert.equal((await noSource.claimOriginal(command.input, call)).kind, "unavailable");
  f.options.terminal = "commit-unknown";
  const provider = createGatewayStartupSubmissionOwnerV1(f.owner, {
    async resolve() {
      return { command, invocation: f.token, bounds: f.bounds, assertCurrent() {} };
    },
  });
  assert.equal((await provider.claimOriginal(command.input, call)).kind, "unknown");
});

test("owner captures original command bounds before transaction admission waits", async () => {
  const f = await controlledOwner();
  const original = { ...f.bounds };
  let received;
  const owner = createGatewayStartupOwnerV1({
    transaction: f.transaction,
    participants: {
      ...f.participants,
      authority: {
        async consume(invocation, command, bounds, unit, io) {
          received = { ...bounds };
          return f.participants.authority.consume(invocation, command, bounds, unit, io);
        },
      },
    },
  });
  const pending = owner.execute(f.accept, f.token, f.bounds);
  f.bounds.requestRef = "substituted-request";
  f.bounds.deadline = "2100-01-01T00:00:00.000Z";
  const result = await pending;
  assert.equal(result.kind, "accepted");
  assert.equal(received.requestRef, original.requestRef);
  assert.equal(received.deadline, original.deadline);
});

for (const [participant, method] of [
  ["authority", "consume"],
  ["selection", "resolveLocked"],
  ["process", "requireDisposition"],
]) {
  for (const malformed of ["missing", "noncallable", "throwing-access"]) {
    test(`acquired ${participant} lease with ${malformed} assertion retains exactly one joined cleanup`, async () => {
      const f = await controlledOwner();
      const wait = deferred();
      const original = f.participants[participant][method];
      let closes = 0;
      let closed = false;
      f.participants[participant][method] = async (...args) => {
        const lease = await original(...args);
        const release = lease.release.bind(lease);
        lease.release = async () => {
          closes++;
          await wait.promise;
          await release();
          closed = true;
        };
        if (malformed === "missing") delete lease.assertCurrent;
        else if (malformed === "noncallable") lease.assertCurrent = 0;
        else
          Object.defineProperty(lease, "assertCurrent", {
            get() {
              throw Error("controlled assertion access");
            },
          });
        return lease;
      };
      const owner = createGatewayStartupOwnerV1({
        transaction: f.transaction,
        participants: f.participants,
      });
      let returned = false;
      const pending = owner.execute(f.accept, f.token, f.bounds).then((result) => {
        returned = true;
        return result;
      });
      await tick();
      assert.equal(closes, 1);
      assert.equal(returned, false);
      assert.ok(f.events.includes("client-settled"));
      wait.resolve();
      assert.notEqual((await pending).kind, "accepted");
      assert.equal(closes, 1);
      assert.equal(closed, true);
      assert.equal(f.retained().events.size, 0);
      assert.equal(f.retained().audits.length, 0);
      assert.equal(f.events.filter((event) => event.startsWith("phase-terminal-")).length, 1);
    });
  }
}
test("acknowledged commit retains history when one joined cleanup fails", async () => {
  const f = await controlledOwner();
  const original = f.participants.authority.consume;
  let closes = 0;
  f.participants.authority.consume = async (...args) => {
    const lease = await original(...args);
    lease.release = async () => {
      closes++;
      throw Error("controlled cleanup failure");
    };
    return lease;
  };
  const owner = createGatewayStartupOwnerV1({
    transaction: f.transaction,
    participants: f.participants,
  });
  const result = await owner.execute(f.accept, f.token, f.bounds);
  assert.equal(result.kind, "recovery-required");
  assert.equal(f.retained().events.size, 1);
  assert.equal(f.retained().audits.length, 1);
  assert.equal(closes, 1);
  assert.deepEqual(
    f.events.filter((event) => event.startsWith("phase-terminal-")),
    ["phase-terminal-committed"],
  );
});
