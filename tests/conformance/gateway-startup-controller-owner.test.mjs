import assert from "node:assert/strict";
import test from "node:test";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  GatewayStartupOwnerPhaseV1,
  canonicalGatewayStartupValueV1,
} from "../../packages/occ/src/gateway-startup-v1/owner.ts";

// Real State/controller factory, original phase, scoped backend and NativeIAM
// loader. Rows and source callbacks are controlled orchestration. They do not
// establish PostgreSQL privileges/locks, a native service, account writer
// exclusion, selected launch material or an accepting launch implementation.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const subject = Object.freeze({
  kind: "agent-gateway",
  installationId: `ins_${uuid(1)}`,
  namespaceRef: `ns_${uuid(2)}`,
  agentRef: `agt_${uuid(3)}`,
});
const startup = Object.freeze({
  schemaVersion: 2,
  subject,
  operationRef: "original-acceptance",
  operationDigest: "a".repeat(64),
  processRef: "original-process",
  processGeneration: 1,
});
const read = () => ({
  schemaVersion: 2,
  subject,
  kind: "read-operation",
  operation: {
    schemaVersion: 2,
    subject,
    operationRef: "original-readback-target",
    operationDigest: "b".repeat(64),
    startup,
  },
});
const result = (rows = [], command = "SELECT") => ({ command, rows, rowCount: rows.length });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function protocol(options = {}) {
  const events = [],
    calls = [],
    releases = [];
  let connects = 0,
    sourceReleases = 0,
    launchReads = 0,
    launchCalls = 0;
  let unit,
    io,
    policy,
    account,
    capturedBounds,
    capturedCommand,
    sourceCurrent = true;
  const currentAccount = {
    installation_id: subject.installationId,
    account_id: "original-account",
    issuer: `occ:installation:${subject.installationId}:better-auth`,
    subject: "original-account",
    incarnation: uuid(4),
    account_version: "1",
    state: "active",
    current_user_id: "original-account",
    credential_account_id: "original-credential-account",
    principal_id: "original-principal",
  };
  const client = {
    on() {},
    removeListener() {},
    async query(statement, parameters = []) {
      calls.push({ statement, parameters });
      if (statement === "COMMIT") {
        events.push("commit");
        options.commit?.({ account, io, events });
        return result([], "COMMIT");
      }
      if (statement === "ROLLBACK") {
        events.push("rollback");
        return result([], "ROLLBACK");
      }
      if (statement.startsWith("BEGIN") || statement.startsWith("SET LOCAL")) return result();
      if (statement.startsWith("SELECT set_config")) {
        assert.equal(
          statement,
          "SELECT set_config('statement_timeout',$1,true), set_config('transaction_timeout',$1,true), set_config('idle_in_transaction_session_timeout',$1,true)",
        );
        assert.equal(parameters.length, 1);
        assert.match(parameters[0], /^[1-9][0-9]*ms$/);
        return result();
      }
      if (statement.includes("FROM occ.installation "))
        return result([
          {
            id: subject.installationId,
            name: "Installation",
            created_at: "2026-01-01T00:00:00Z",
          },
        ]);
      if (statement.includes("read_locked_gateway_startup_account_v1")) {
        events.push("account-query");
        assert.equal(
          statement,
          "SELECT * FROM occ.read_locked_gateway_startup_account_v1($1,$2,$3,$4,$5,$6::jsonb)",
        );
        // Model the fixed helper's exact locator equality, not arbitrary account lookup.
        const expected = [
          subject.installationId,
          startup.operationRef,
          startup.operationDigest,
          startup.processRef,
          String(startup.processGeneration),
          canonicalGatewayStartupValueV1(startup),
        ];
        if (JSON.stringify(parameters) !== JSON.stringify(expected)) return result();
        if (options.accountReply) return options.accountReply(currentAccount);
        return result([{ ...currentAccount }]);
      }
      if (statement === "SELECT occ.lock_workload_profile_iam()") {
        events.push("policy");
        return result();
      }
      if (statement.includes("FROM occ.iam_")) {
        events.push("iam-read");
        if (statement.includes("FROM occ.iam_identities "))
          return result([
            {
              id: "original-principal",
              kind: "principal",
              issuer: currentAccount.issuer,
              subject: currentAccount.subject,
            },
          ]);
        if (statement.includes("FROM occ.iam_roles "))
          return result([
            {
              id: "original-admin-role",
              permissions: [{ action: "administer", resourceKind: "installation" }],
            },
          ]);
        if (statement.includes("FROM occ.iam_access_bindings "))
          return result([
            {
              id: "original-admin-binding",
              identity_subject_id: "original-principal",
              role_id: "original-admin-role",
              resource_kind: "installation",
              resource_id: subject.installationId,
            },
          ]);
        return result();
      }
      if (statement === "SELECT id FROM occ.namespaces WHERE id=$1 FOR SHARE") {
        events.push("namespace");
        await options.parentQuery?.("namespace");
        return result([{ id: parameters[0] }]);
      }
      if (statement === "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR SHARE") {
        events.push("agent");
        await options.parentQuery?.("agent");
        return result([{ id: parameters[1] }]);
      }
      if (statement.startsWith("SELECT") && statement.includes("occ.gateway_startup_operations")) {
        events.push("history");
        await options.history?.({
          state,
          unit,
          io,
          account,
          policy,
          binding,
          capturedBounds,
          capturedCommand,
          revoke: () => {
            sourceCurrent = false;
          },
        });
        return result();
      }
      throw new Error(`Unexpected controlled Gateway query: ${statement}`);
    },
    release(destroy) {
      releases.push(destroy);
      events.push("client-release");
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
  const driverSelection = new DriverSelection();
  const driver = new NativeIAMDriver(state);
  driverSelection.registerDriver(driver);
  driverSelection.selectDriver("iam", driver.id);
  const reader = state.gatewayStartupAccountBindingV1();
  const source = {
    driverSelection,
    authority: {
      async consume(invocation, command, bounds, originalUnit, originalIO, originalPolicy) {
        assert.strictEqual(invocation, invocationIdentity);
        assert.equal(arguments.length, 6);
        unit = originalUnit;
        io = originalIO;
        policy = originalPolicy;
        capturedBounds = bounds;
        capturedCommand = command;
        assert.ok(unit.phase instanceof GatewayStartupOwnerPhaseV1);
        events.push("authority");
        await options.beforeAccount?.({ state, reader, unit, io, policy, bounds, command });
        account = await reader.lock(unit, io, bounds);
        if (!account) throw new Error("Controlled helper refused exact current account");
        assert.equal(account.account.state, "active");
        assert.equal(account.principalId, "original-principal");
        account.assertCurrent();
        await options.afterAccount?.({ state, reader, unit, io, policy, bounds, account });
        await policy.lockPolicy();
        const principal = await policy.iam.lookupIdentity({
          issuer: account.account.issuer,
          subject: account.account.subject,
        });
        assert.equal(principal?.id, account.principalId);
        const decision = await policy.iam.authorize({
          principalId: principal.id,
          action: "administer",
          resource: { kind: "installation", id: subject.installationId },
        });
        assert.equal(decision.allowed, true);
        const owned = {
          assertCurrent() {
            assert.strictEqual(this, owned);
            account.assertCurrent();
            if (!sourceCurrent) throw new Error("Controlled current source withdrawn");
            return options.assertCurrent?.();
          },
          async release() {
            assert.strictEqual(this, owned);
            sourceReleases++;
            events.push("source-release");
            await options.releaseGate?.promise;
            await options.sourceRelease?.();
          },
          attribution: {
            actorId: options.wrongActor ? "other-principal" : principal.id,
            requestRef: bounds.requestRef,
            decisionRef: "controlled-original-decision",
          },
        };
        options.sourceLease?.(owned);
        events.push("source-acquired");
        options.acquired?.resolve();
        await options.acquireGate?.promise;
        return owned;
      },
    },
    selection: {
      async resolveLocked() {
        throw new Error("Read-operation cannot acquire selection");
      },
    },
    process: {
      async requireDisposition() {
        throw new Error("Read-operation cannot create a process");
      },
      async requireCurrent() {
        throw new Error("Read-operation cannot inspect a process");
      },
    },
    launchResource: {
      get prepareLocked() {
        launchReads++;
        if (launchReads !== 1) throw new Error("Launch method read more than once");
        return async function () {
          launchCalls++;
          throw new Error("No genuine launch producer");
        };
      },
    },
    get audit() {
      throw new Error("Controller must not read external audit");
    },
    get allocate() {
      throw new Error("Controller must not read external allocator");
    },
  };
  const invocationIdentity = {};
  // Private binder is observed by a few negative protocol cases; it is not an
  // externally callable authorization port or an alternative factory.
  let binding;
  const originalBind = state.bindGatewayStartupOwnersV2;
  state.bindGatewayStartupOwnersV2 = function (...args) {
    binding = originalBind.apply(this, args);
    return binding;
  };
  // Observe and forward the exact State-produced lease without substituting its
  // unit, policy, attribution, methods or result. This is fixture observation.
  const originalBindAuthority = state.bindGatewayAuthorityConsumerV1;
  state.bindGatewayAuthorityConsumerV1 = function (...args) {
    const consume = originalBindAuthority.apply(this, args);
    return async function (...operands) {
      let retained;
      try {
        retained = await consume.apply(this, operands);
      } catch (error) {
        options.authorityFailure?.(error);
        throw error;
      }
      options.transferred?.(retained);
      return retained;
    };
  };
  let owner;
  const construct = () => (owner ??= state.gatewayStartupControllerOwnerV2(source));
  return {
    state,
    source,
    events,
    calls,
    releases,
    reader,
    construct,
    connects: () => connects,
    sourceReleases: () => sourceReleases,
    launchReads: () => launchReads,
    launchCalls: () => launchCalls,
    account: () => account,
    io: () => io,
    unit: () => unit,
    run(command = read(), signal = new AbortController().signal) {
      return construct().execute(command, invocationIdentity, {
        signal,
        deadline: new Date(Date.now() + 2500).toISOString(),
        requestRef: "original-request",
      });
    },
  };
}

test("original Controller reader acquires exact account before same-client IAM and protected parents", async () => {
  const p = protocol();
  assert.equal((await p.run()).kind, "not-observed");
  assert.equal(p.connects(), 1);
  assert.equal(p.launchReads(), 1);
  assert.equal(p.launchCalls(), 0);
  assert.equal(p.events.filter((value) => value === "iam-read").length, 12);
  for (const [before, after] of [
    ["account-query", "policy"],
    ["policy", "namespace"],
    ["namespace", "agent"],
    ["agent", "history"],
    ["client-release", "source-release"],
  ]) {
    assert.ok(p.events.indexOf(before) < p.events.indexOf(after), `${before} before ${after}`);
  }
  assert.equal(p.sourceReleases(), 1);
  assert.throws(() => p.account().assertCurrent());
});

test("retained account fence survives short acquisition IO until the original terminal", async () => {
  let fenced = false;
  const p = protocol({
    commit({ account }) {
      account.assertCurrent();
      fenced = true;
    },
  });
  // Runtime finished the account runOperation before history and COMMIT. The
  // retained check must not consult that short operation's closed IO slot.
  assert.equal((await p.run()).kind, "not-observed");
  assert.equal(fenced, true);
  assert.throws(() => p.io().assertActive());
  assert.throws(() => p.account().assertCurrent());
});

for (const kind of ["copied-unit", "copied-io", "copied-bounds", "other-state", "wrong-label"]) {
  test(`original account admission rejects ${kind} even when the caller catches it`, async () => {
    let rejected = false;
    const p = protocol({
      async beforeAccount({ state, reader, unit, io, bounds }) {
        let work;
        if (kind === "wrong-label")
          work = unit.phase.runOperation("not-account", (otherIO) =>
            reader.lock(unit, otherIO, bounds),
          );
        else if (kind === "other-state") work = protocol().reader.lock(unit, io, bounds);
        else
          work = reader.lock(
            kind === "copied-unit" ? { ...unit } : unit,
            kind === "copied-io" ? { ...io } : io,
            kind === "copied-bounds" ? { ...bounds } : bounds,
          );
        await assert.rejects(work);
        rejected = true;
      },
    });
    // A foreign State cannot find this enrollment and cannot poison a record it
    // does not own. Only the subsequent genuine original reader can proceed.
    assert.equal((await p.run()).kind, kind === "other-state" ? "not-observed" : "unavailable");
    assert.equal(rejected, true);
    assert.equal(p.events.includes("commit"), kind === "other-state");
  });
}

for (const field of [
  "operationRef",
  "operationDigest",
  "processRef",
  "processGeneration",
  "subject",
]) {
  test(`fixed account helper receives and refuses a changed startup ${field}`, async () => {
    const p = protocol();
    const command = structuredClone(read());
    command.operation.startup[field] =
      field === "processGeneration"
        ? 2
        : field === "operationDigest"
          ? "c".repeat(64)
          : field === "subject"
            ? { ...subject, agentRef: `agt_${uuid(99)}` }
            : `other-${field}`;
    const output = await p.run(command);
    assert.ok(["unavailable", "denied"].includes(output.kind));
    assert.equal(p.events.includes("policy"), false);
    assert.equal(p.events.includes("commit"), false);
  });
}

for (const state of ["provisioning", "deleted"]) {
  test(`current ${state} account cannot become Controller attribution`, async () => {
    const p = protocol({ accountReply: (row) => result([{ ...row, state }]) });
    assert.equal((await p.run()).kind, "unavailable");
    assert.equal(p.events.includes("policy"), false);
  });
}

test("changed original incarnation/version is refused by the fixed account helper before IAM", async () => {
  const p = protocol({
    accountReply(row) {
      const current = { ...row, incarnation: uuid(88), account_version: "2" };
      assert.notEqual(current.incarnation, row.incarnation);
      assert.notEqual(current.account_version, row.account_version);
      // Controlled helper refusal models immutable attribution mismatch. It is
      // not an executed PostgreSQL trigger or concurrent account-writer proof.
      return result();
    },
  });
  assert.equal((await p.run()).kind, "unavailable");
  assert.equal(p.events.includes("policy"), false);
});

test("a copied authority attribution cannot replace the original account principal", async () => {
  const p = protocol({ wrongActor: true });
  assert.equal((await p.run()).kind, "unavailable");
  assert.equal(p.sourceReleases(), 1);
  assert.equal(p.events.includes("namespace"), false);
});

test("policy-first ordering poisons the original account phase", async () => {
  const p = protocol({
    async beforeAccount({ policy }) {
      await policy.lockPolicy();
    },
  });
  assert.equal((await p.run()).kind, "unavailable");
  assert.equal(p.events.includes("account-query"), false);
  assert.equal(p.events.includes("commit"), false);
});

for (const kind of ["foreign-binding", "copied-audit-unit", "copied-audit-io"]) {
  test(`private State identity refuses ${kind} after original account acquisition`, async () => {
    let refused = false;
    const p = protocol({
      async history({ state, unit, io, binding }) {
        if (kind === "foreign-binding")
          assert.throws(() => state.allocateGatewayStartupIdentityV1(2, {}, "audit"));
        else
          await unit.phase.runOperation("mandatory-audit", async (auditIO) => {
            await assert.rejects(
              binding.participants.audit.append(
                {},
                {},
                kind === "copied-audit-unit" ? { ...unit } : unit,
                kind === "copied-audit-io" ? { ...auditIO } : auditIO,
              ),
            );
          });
        refused = true;
      },
    });
    assert.equal((await p.run()).kind, "unavailable");
    assert.equal(refused, true);
    assert.equal(
      p.calls.some(({ statement }) => statement.includes("INSERT INTO occ.audit_events")),
      false,
    );
    assert.equal(p.events.includes("commit"), false);
  });
}

test("caught account release and source withdrawal remain terminal fences", async () => {
  for (const mode of ["account", "source"]) {
    const p = protocol({
      history({ account, revoke }) {
        if (mode === "account") {
          account.release();
          assert.throws(() => account.assertCurrent());
        } else revoke();
      },
    });
    assert.equal((await p.run()).kind, "unavailable");
    assert.equal(p.events.includes("commit"), false);
    assert.equal(p.sourceReleases(), 1);
  }
});

test("cancelled entered acquisition is joined through the returned source cleanup", async () => {
  const acquired = deferred(),
    acquireGate = deferred(),
    releaseGate = deferred();
  const abort = new AbortController();
  const p = protocol({ acquired, acquireGate, releaseGate });
  let settled = false;
  const work = p.run(read(), abort.signal).then((value) => {
    settled = true;
    return value;
  });
  await acquired.promise;
  abort.abort();
  assert.equal(settled, false);
  assert.deepEqual(p.releases, [true]);
  acquireGate.resolve();
  while (!p.events.includes("source-release"))
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseGate.resolve();
  assert.equal((await work).kind, "unavailable");
  assert.equal(p.sourceReleases(), 1);
  assert.equal(p.events.includes("commit"), false);
});

test("missing launch source refuses Controller construction before pool checkout", () => {
  const p = protocol();
  delete p.source.launchResource;
  assert.throws(() => p.construct());
  assert.equal(p.connects(), 0);
});

test("malformed asynchronous currentness stays joined and poisons the original terminal", async () => {
  const entered = deferred(),
    gate = deferred();
  const p = protocol({
    assertCurrent() {
      entered.resolve();
      return gate.promise;
    },
  });
  let settled = false;
  const work = p.run().then((value) => {
    settled = true;
    return value;
  });
  await entered.promise;
  assert.equal(settled, false);
  gate.resolve();
  assert.equal((await work).kind, "unavailable");
  assert.equal(p.sourceReleases(), 1);
  assert.equal(p.events.includes("commit"), false);
});

test("an already acquired account cannot be reacquired after the policy barrier", async () => {
  const p = protocol({
    async afterAccount({ reader, unit, io, policy, bounds }) {
      await policy.lockPolicy();
      await assert.rejects(reader.lock(unit, io, bounds));
    },
  });
  assert.equal((await p.run()).kind, "unavailable");
  assert.equal(p.events.filter((value) => value === "account-query").length, 1);
  assert.equal(p.events.includes("commit"), false);
});

test("Controller captures changing attribution getters once for the account check and Runtime", async () => {
  const reads = { attribution: 0, actorId: 0, requestRef: 0, decisionRef: 0 };
  const expected = {
    actorId: "original-principal",
    requestRef: "original-request",
    decisionRef: "controlled-original-decision",
  };
  let returned;
  const p = protocol({
    sourceLease(owned) {
      const attribution = {};
      for (const field of Object.keys(expected))
        Object.defineProperty(attribution, field, {
          get() {
            return ++reads[field] === 1 ? expected[field] : `changed-${field}`;
          },
        });
      Object.defineProperty(owned, "attribution", {
        get() {
          reads.attribution++;
          return reads.attribution === 1
            ? attribution
            : {
                actorId: "other-principal",
                requestRef: "other-request",
                decisionRef: "other-decision",
              };
        },
      });
    },
    transferred(held) {
      returned = held;
    },
    commit() {
      assert.deepEqual(returned.attribution, expected);
    },
  });
  assert.equal((await p.run()).kind, "not-observed");
  assert.deepEqual(reads, { attribution: 1, actorId: 1, requestRef: 1, decisionRef: 1 });
  assert.deepEqual(returned.attribution, expected);
  assert.equal(Object.isFrozen(returned.attribution), true);
  assert.equal(Object.isFrozen(returned), true);
  assert.equal(p.events.includes("commit"), true);
  assert.equal(p.sourceReleases(), 1);
  assert.throws(() => returned.assertCurrent());
});

for (const parent of ["namespace", "agent"]) {
  test(`Controller retains the captured attribution during the ${parent} query wait`, async () => {
    const entered = deferred(),
      resume = deferred();
    const expected = {
      actorId: "original-principal",
      requestRef: "original-request",
      decisionRef: "controlled-original-decision",
    };
    let original, returned;
    const p = protocol({
      sourceLease(owned) {
        original = owned.attribution;
      },
      async parentQuery(kind) {
        if (kind === parent) {
          entered.resolve();
          await resume.promise;
        }
      },
      transferred(held) {
        returned = held;
      },
      commit() {
        assert.deepEqual(returned.attribution, expected);
      },
    });
    const pending = p.run();
    await entered.promise;
    assert.equal(returned, undefined);
    assert.equal(p.sourceReleases(), 0);
    Object.assign(original, {
      actorId: "other-principal",
      requestRef: "other-request",
      decisionRef: "other-decision",
    });
    resume.resolve();
    assert.equal((await pending).kind, "not-observed");
    assert.notStrictEqual(returned.attribution, original);
    assert.deepEqual(returned.attribution, expected);
    assert.equal(p.events.includes("commit"), true);
    assert.equal(p.sourceReleases(), 1);
    assert.throws(() => returned.assertCurrent());
  });
}

test("failed attribution capture joins exactly one original release and preserves first failure", async () => {
  const failure = new Error("Controlled attribution getter failure");
  const cleanupFailure = new Error("Controlled secondary release failure");
  let observedFailure;
  const p = protocol({
    sourceLease(owned) {
      Object.defineProperty(owned, "attribution", {
        get() {
          throw failure;
        },
      });
    },
    sourceRelease() {
      throw cleanupFailure;
    },
    authorityFailure(error) {
      observedFailure = error;
    },
  });
  assert.equal((await p.run()).kind, "unavailable");
  assert.strictEqual(observedFailure, failure);
  assert.equal(p.events.includes("namespace"), false);
  assert.equal(p.events.includes("commit"), false);
  assert.equal(p.sourceReleases(), 1);
});
