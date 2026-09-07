import assert from "node:assert/strict";
import test from "node:test";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { TurnCommandScopeV1 } from "../../packages/occ/src/state/postgres/turn-command-scope.ts";
import { takeCommittedTurnJournalClaim } from "../../packages/occ/src/turn-journal/transaction-guard.ts";
import { TurnJournalStore } from "../../packages/occ/src/turn-journal/store.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/ports/transaction-errors.ts";
import { attemptRecord } from "../fixtures/turn-journal-v1/values.mjs";

// Actual central owner, scope, repository wrappers, NativeIAM binding and journal
// guard, driven through private composition seams. The transport supplies recorded
// row values and protocol replies; it is not PostgreSQL, a SQL constraint/lock
// emulator or an authenticated account/native producer. Controlled leases prove
// owner lifetime only. No positive account authorization is claimed.
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const identity = Object.freeze({
  installationId: "installation",
  namespaceId: "namespace",
  agentId: "agent",
  operationRef: "operation",
});
const bounds = (signal = new AbortController().signal) =>
  Object.freeze({ signal, deadline: new Date(Date.now() + 2900).toISOString() });
const installation = {
  id: identity.installationId,
  name: "Installation",
  created_at: "2026-01-01T00:00:00.000Z",
};
const metadata = {
  installation_id: identity.installationId,
  version: 1,
  status: "enabled",
  created_at: installation.created_at,
  updated_at: installation.created_at,
  created_by: "principal",
  updated_by: "principal",
};
const parent = {
  ...metadata,
  id: "channel-parent",
  platform: "slack",
  provider_tenant_ref: "tenant",
  recipient_app_ref: "app",
};
const human = {
  ...metadata,
  id: "human-binding",
  channel_installation_id: parent.id,
  provider_subject_ref: "subject",
  iam_driver_id: "occ-native-iam",
  principal_id: "principal",
  principal_issuer: "installation",
  principal_subject: "account",
};
const agentBinding = {
  ...metadata,
  id: "agent-binding",
  channel_installation_id: parent.id,
  channel_ref: "channel",
  scope_kind: "slack-private-channel",
  namespace_id: identity.namespaceId,
  agent_id: identity.agentId,
};
const locator = Object.freeze({
  parentId: parent.id,
  providerSubjectRef: human.provider_subject_ref,
  channelRef: agentBinding.channel_ref,
});
const result = (rows = [], command = "SELECT") => ({ rows, command, rowCount: rows.length });
function protocol(overrides = {}, journal = false) {
  const events = [],
    queries = [],
    releases = [];
  let connects = 0,
    listener,
    journalContext;
  const client = {
    on(_name, fn) {
      listener = fn;
    },
    removeListener() {
      events.push("remove-listener");
      overrides.removeListener?.();
      listener = undefined;
    },
    async query(statement, parameters) {
      queries.push({ statement, parameters });
      if (statement === "COMMIT") {
        events.push("commit");
        return overrides.commit ? overrides.commit() : result([], "COMMIT");
      }
      if (statement === "ROLLBACK") {
        events.push("rollback");
        return result([], "ROLLBACK");
      }
      if (
        statement.startsWith("BEGIN") ||
        statement.startsWith("SET LOCAL") ||
        statement.startsWith("SELECT set_config")
      )
        return result();
      if (statement === "SELECT probe") {
        events.push("probe");
        return overrides.probe ? overrides.probe() : result([{ id: "probe" }]);
      }
      if (statement.includes("FROM occ.installation ")) return result([installation]);
      if (statement.includes("SELECT * FROM occ.channel_installations")) return result([parent]);
      if (statement.includes("SELECT * FROM occ.channel_human_bindings")) return result([human]);
      if (statement.includes("SELECT * FROM occ.channel_agent_bindings"))
        return result([agentBinding]);
      if (statement.startsWith("SELECT id FROM occ.")) return result([{ id: "locked" }]);
      if (statement.includes("lock_workload_profile_iam")) {
        events.push("policy");
        return overrides.policy ? overrides.policy() : result();
      }
      if (statement.includes("pg_advisory_xact_lock")) return result();
      if (statement.includes("FROM occ.iam_")) {
        events.push("policy-read");
        if (statement.includes("FROM occ.iam_identities "))
          return result([
            { id: "principal", kind: "principal", issuer: "installation", subject: "account" },
          ]);
        if (statement.includes("FROM occ.iam_roles "))
          return result([{ id: "role", permissions: [{ action: "read", resourceKind: "agent" }] }]);
        if (statement.includes("FROM occ.iam_access_bindings "))
          return result([{ id: "binding", identity_subject_id: "principal", role_id: "role" }]);
        return result();
      }
      if (statement.includes("INSERT INTO occ.audit_events")) {
        events.push("audit");
        if (overrides.audit) return overrides.audit(statement, parameters);
        return result();
      }
      throw new Error(`Unexpected transport query: ${statement}`);
    },
    release(destroy) {
      releases.push(destroy);
      events.push("client-release");
      overrides.release?.();
    },
  };
  const state = new PostgresPlatformState(
    {
      options: { connectionTimeoutMillis: 100 },
      async connect() {
        connects++;
        return client;
      },
      async end() {},
    },
    journal
      ? {
          turnJournal: {
            canonicalRouteKey() {
              throw new Error("No route classification in these cases");
            },
            capacity: {
              maxOwnersPerInstallation: 10,
              maxIncomingLinksPerInstallation: 10,
              maxAttemptsPerInstallation: 10,
            },
            bind(context) {
              journalContext = context;
              const unavailable = async () => ({ kind: "unavailable" });
              return {
                admission: { inspect: unavailable, inspectRejected: unavailable },
                nonTurn: { inspectNonTurn: unavailable },
                evidence: {},
                authorization: { authorize: unavailable },
              };
            },
          },
        }
      : {},
  );
  return {
    state,
    client,
    events,
    queries,
    releases,
    connects: () => connects,
    journalContext: () => journalContext,
    transportError: () => listener?.(new Error("transport")),
  };
}
function runTurn(p, work = async () => 1, options = {}) {
  const originalBounds = bounds(options.signal);
  let context, unit;
  const execution = {
    identity,
    bounds: originalBounds,
    close() {
      p.events.push("owner-close");
    },
  };
  const promise = p.state.execute(
    false,
    async (actualUnit, actualContext) => {
      unit = actualUnit;
      context = actualContext;
      const phase = execution.phase;
      assert.ok(phase instanceof TurnCommandScopeV1);
      await phase.enroll({
        async consume() {
          return {
            async prepareCommit() {
              p.events.push("prepare");
              await options.prepare?.(context, phase);
            },
            assertCurrent() {
              options.current?.();
            },
            async release(terminal) {
              p.events.push(`lease:${terminal}`);
              await options.cleanup?.(terminal, context);
            },
          };
        },
      });
      return work({ unit, context, phase });
    },
    { signal: originalBounds.signal, timeoutMs: 2800 },
    false,
    undefined,
    undefined,
    execution,
  );
  return { promise, execution, context: () => context, unit: () => unit };
}
function boundAccount(p, overrides = {}) {
  const selection = new DriverSelection();
  const driver = new NativeIAMDriver(p.state);
  selection.registerDriver(driver);
  selection.selectDriver("iam", driver.id);
  let accountUnit;
  const account = {
    async consume(unit) {
      accountUnit = unit;
      await unit.locateChannel(locator);
      unit.retainSecurityCleanup(async (outcome) => {
        p.events.push(`security:${outcome}`);
        await overrides.securityCleanup?.(outcome);
      });
      if (overrides.beforePolicy) await overrides.beforePolicy(unit);
      await unit.lockPolicy();
      await unit.lockParentsAndReload();
      await unit.iam.lookupIdentity({ issuer: "installation", subject: "account" });
      return {
        async prepareCommit(current) {
          assert.equal(current, unit);
          await current.readLockedChannel();
          await overrides.prepare?.(current);
        },
        assertCurrent() {
          overrides.current?.();
        },
        async release(terminal) {
          p.events.push(`account:${terminal}`);
          await overrides.cleanup?.(terminal);
        },
      };
    },
  };
  return {
    adapter: p.state.bindTurnCommandStateV1(identity, bounds(), {
      driverSelection: selection,
      account,
    }),
    selection,
    unit: () => accountUnit,
  };
}
const audit = () => ({
  id: "audit-original",
  installationId: identity.installationId,
  namespaceId: identity.namespaceId,
  occurredAt: installation.created_at,
  kind: "mutation",
  actorId: "principal",
  action: "turn.accept",
  resource: { kind: "Agent", id: identity.agentId, namespaceId: identity.namespaceId },
  outcome: "success",
});
const knownFailure = (e) => e instanceof Error && !(e instanceof PostgresCommitOutcomeUnknownError);

for (const mode of ["missing-account", "missing-journal"])
  test(`${mode} denies before checkout`, async () => {
    const p = protocol({}, mode !== "missing-journal");
    const adapter =
      mode === "missing-account"
        ? p.state.bindTurnCommandStateV1(identity, bounds())
        : boundAccount(p).adapter;
    await assert.rejects(
      adapter.transact(async () => assert.fail("callback")),
      DependencyUnavailableError,
    );
    assert.equal(p.connects(), 0);
  });
for (const mixed of ["read", "profile", "credential", "gateway"])
  test(`turn rejects mixed ${mixed} before checkout`, async () => {
    const p = protocol();
    const execution = { identity, bounds: bounds(), close() {} };
    await assert.rejects(
      p.state.execute(
        mixed === "read",
        async () => assert.fail("callback"),
        undefined,
        mixed === "profile",
        mixed === "credential" ? {} : undefined,
        mixed === "gateway" ? {} : undefined,
        execution,
      ),
      ScopeViolationError,
    );
    assert.equal(p.connects(), 0);
  });
test("outer lifetime survives outward finish and terminal cleanup follows client release", async () => {
  const p = protocol();
  const run = runTurn(
    p,
    async ({ phase, context }) => {
      await phase.runOperation("journal-read", (op) =>
        op.track(() => context.turnQuery("SELECT probe")),
      );
      return "done";
    },
    {
      cleanup: async (terminal, context) => {
        assert.equal(terminal, "committed");
        assert.throws(() => context.lifetime.assertActive());
      },
    },
  );
  assert.equal(await run.promise, "done");
  assert.ok(p.events.indexOf("prepare") < p.events.indexOf("commit"));
  assert.ok(p.events.indexOf("client-release") < p.events.indexOf("lease:committed"));
  assert.equal(p.releases.length, 1);
});
test("unawaited accepted query drains before COMMIT", async () => {
  const gate = deferred();
  const p = protocol({ probe: () => gate.promise });
  const run = runTurn(p, async ({ phase, context }) => {
    void phase.runOperation("journal-read", (op) =>
      op.track(() => context.turnQuery("SELECT probe")),
    );
  });
  await tick();
  assert.ok(!p.events.includes("commit"));
  gate.resolve(result());
  await run.promise;
  assert.ok(p.events.indexOf("probe") < p.events.indexOf("commit"));
});
test("caught accepted failure poisons the outer unit", async () => {
  const error = new ScopeViolationError("original failure");
  const p = protocol();
  const run = runTurn(p, async ({ phase }) => {
    await phase
      .runOperation("journal-mutation", async () => {
        throw error;
      })
      .catch(() => {});
  });
  await assert.rejects(run.promise, knownFailure);
  assert.ok(!p.events.includes("commit"));
  assert.ok(p.events.includes("rollback"));
});
test("direct callback is joined after cancellation before retained cleanup", async () => {
  const signal = new AbortController(),
    gate = deferred(),
    entered = deferred();
  const p = protocol();
  const run = runTurn(
    p,
    async () => {
      entered.resolve();
      await gate.promise;
      p.events.push("callback-end");
    },
    { signal: signal.signal },
  );
  await entered.promise;
  signal.abort();
  await tick();
  assert.ok(!p.events.some((e) => e.startsWith("lease:")));
  gate.resolve();
  await assert.rejects(run.promise, knownFailure);
  assert.ok(p.events.indexOf("callback-end") < p.events.indexOf("lease:rolled-back"));
});
test("revocation during preparation prevents COMMIT", async () => {
  let live = true;
  const p = protocol();
  const run = runTurn(p, undefined, {
    current() {
      if (!live) throw new ScopeViolationError("revoked");
    },
    prepare: async () => {
      live = false;
    },
  });
  await assert.rejects(run.promise, knownFailure);
  assert.ok(!p.events.includes("commit"));
});
for (const scenario of ["no-ack", "rollback-ack", "explicit-rejection", "ack-cleanup-failure"])
  test(`preserves ${scenario} terminal and outward outcome`, async () => {
    const p = protocol({
      commit: async () => {
        if (scenario === "no-ack") throw new Error("connection lost after send");
        if (scenario === "rollback-ack") return result([], "ROLLBACK");
        if (scenario === "explicit-rejection")
          throw Object.assign(new Error("serialization rejection"), { code: "40001" });
        return result([], "COMMIT");
      },
    });
    const run = runTurn(p, undefined, {
      cleanup: async () => {
        if (scenario === "ack-cleanup-failure") throw new Error("cleanup");
      },
    });
    await assert.rejects(
      run.promise,
      scenario === "no-ack" || scenario === "ack-cleanup-failure"
        ? PostgresCommitOutcomeUnknownError
        : knownFailure,
    );
    assert.ok(
      p.events.includes(
        `lease:${scenario === "no-ack" ? "commit-unknown" : scenario === "ack-cleanup-failure" ? "committed" : "commit-rejected"}`,
      ),
    );
  });
test("actual journal claim remains bound to the original outward unit, not turn token or copy", async () => {
  const p = protocol();
  let claim;
  const run = runTurn(p, async ({ context, unit, phase }) => {
    claim = await context.journalGuard.mutate(async () =>
      context.journalGuard.createClaim(
        attemptRecord.consumption.operation,
        new Date(Date.now() + 2000).toISOString(),
      ),
    );
    assert.equal(takeCommittedTurnJournalClaim(unit, claim), undefined);
    assert.equal(takeCommittedTurnJournalClaim(phase.unit, claim), undefined);
  });
  await run.promise;
  assert.equal(takeCommittedTurnJournalClaim({ ...run.unit() }, claim), undefined);
  assert.equal(takeCommittedTurnJournalClaim(run.execution.phase.unit, claim), undefined);
  assert.ok(takeCommittedTurnJournalClaim(run.unit(), claim));
  assert.equal(takeCommittedTurnJournalClaim(run.unit(), claim), undefined);
});
test("actual Store retains its unknown result after acknowledged cleanup failure", async () => {
  const p = protocol({}, true);
  const adapter = {
    read: p.state.read.bind(p.state),
    transact: (work) =>
      runTurn(p, ({ unit }) => work(unit), {
        cleanup: async () => {
          throw new Error("cleanup");
        },
      }).promise,
  };
  const store = new TurnJournalStore({
    state: adapter,
    clock: { now: () => new Date(), monotonicMilliseconds: () => performance.now() },
    initiation: { assertCurrent: async () => assert.fail("no initiation") },
  });
  const response = await store.commit("original-transaction", async () => "provisional", {
    ...bounds(),
    requestRef: "request",
    recipientRef: "recipient",
    context: {},
  });
  assert.deepEqual(response, { kind: "commit-unknown", transactionRef: "original-transaction" });
});
test("bound account IO uses actual token, full native loader and same-client audit", async () => {
  const p = protocol({}, true);
  const bound = boundAccount(p);
  let outward;
  await bound.adapter.transact(async (unit) => {
    outward = unit;
    await unit.audit.append(audit());
  });
  assert.notEqual(bound.unit().token, outward);
  assert.equal(p.events.filter((e) => e === "policy-read").length, 6);
  assert.ok(p.events.indexOf("policy") < p.events.indexOf("policy-read"));
  assert.ok(p.events.indexOf("audit") < p.events.indexOf("commit"));
  assert.ok(p.events.indexOf("client-release") < p.events.indexOf("account:committed"));
  await assert.rejects(bound.unit().readLockedChannel(), knownFailure);
});
test("copied native token poisons the genuine bound owner", async () => {
  const p = protocol({}, true);
  const bound = boundAccount(p, {
    beforePolicy: (unit) => p.state.loadNativeIAMStateInTransaction({ ...unit.token }),
  });
  await assert.rejects(
    bound.adapter.transact(async () => assert.fail("callback")),
    knownFailure,
  );
  assert.ok(!p.events.includes("commit"));
});
test("caught audit failure poisons COMMIT through actual UoW append", async () => {
  const p = protocol(
    {
      audit: async () => {
        throw new ScopeViolationError("audit unavailable");
      },
    },
    true,
  );
  const bound = boundAccount(p);
  await assert.rejects(
    bound.adapter.transact(async (unit) => {
      await unit.audit.append(audit()).catch(() => {});
    }),
    knownFailure,
  );
  assert.ok(p.events.includes("audit"));
  assert.ok(!p.events.includes("commit"));
});
test("bound owner rejects nested state transaction and unrelated repositories", async () => {
  for (const nested of [true, false]) {
    const p = protocol({}, true);
    const bound = boundAccount(p);
    await assert.rejects(
      bound.adapter.transact(async (unit) => {
        if (nested) await p.state.transact(async () => assert.fail("nested"));
        else await unit.agents.listAgents(identity.namespaceId);
      }),
      knownFailure,
    );
    assert.equal(p.connects(), 1);
    assert.ok(!p.events.includes("commit"));
  }
});

test("turn adapter rejects an existing ordinary outer owner before a second checkout", async () => {
  const p = protocol({}, true);
  const bound = boundAccount(p);
  await p.state.transact(async () => {
    await assert.rejects(
      bound.adapter.transact(async () => assert.fail("nested turn")),
      ScopeViolationError,
    );
  });
  assert.equal(p.connects(), 1);
});

test("registered security custody survives acquisition failure and releases once after rollback", async () => {
  const p = protocol({}, true);
  const failure = new DependencyUnavailableError("original account unavailable");
  const bound = boundAccount(p, {
    beforePolicy: async () => {
      throw failure;
    },
  });
  await assert.rejects(
    bound.adapter.transact(async () => assert.fail("callback")),
    (e) => e === failure,
  );
  assert.equal(p.events.filter((e) => e === "security:rolled-back").length, 1);
  assert.ok(p.events.indexOf("client-release") < p.events.indexOf("security:rolled-back"));
  assert.ok(!p.events.includes("commit"));
});

test("selected IAM remains pinned through retained account and security terminal cleanup", async () => {
  const p = protocol({}, true);
  let bound;
  bound = boundAccount(p, {
    securityCleanup: async () => {
      assert.throws(() => bound.selection.selectDriver("iam", "replacement"));
      await tick();
    },
  });
  const replacement = new NativeIAMDriver(p.state, { id: "replacement" });
  bound.selection.registerDriver(replacement);
  await bound.adapter.transact(async (unit) => {
    await unit.audit.append(audit());
  });
  assert.equal(p.events.at(-1), "security:committed");
  assert.equal(bound.selection.selectDriver("iam", replacement.id), replacement);
});

test("private turn facade has no read authority before or after its transaction", async () => {
  const p = protocol({}, true);
  const bound = boundAccount(p);
  await assert.rejects(
    bound.adapter.read(async () => assert.fail("pre-enrollment read")),
    DependencyUnavailableError,
  );
  assert.equal(p.connects(), 0);
  await bound.adapter.transact(async (unit) => {
    await unit.audit.append(audit());
  });
  await assert.rejects(
    bound.adapter.read(async () => assert.fail("closed-source read")),
    DependencyUnavailableError,
  );
  assert.equal(p.connects(), 1);
});

test("caught premature native policy assertion poisons the admitted account unit", async () => {
  const p = protocol({}, true);
  const bound = boundAccount(p, {
    beforePolicy: async (unit) => {
      assert.throws(() => unit.iam.assertCurrent(), DependencyUnavailableError);
    },
  });
  await assert.rejects(
    bound.adapter.transact(async () => assert.fail("callback")),
    DependencyUnavailableError,
  );
  assert.ok(!p.events.includes("policy"));
  assert.ok(!p.events.includes("commit"));
  assert.equal(p.events.filter((e) => e === "security:rolled-back").length, 1);
});
