import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresAccountSecurityReaderV1 } from "../../packages/occ/src/state/postgres/account-security.ts";
import { TurnCommandScopeV1 } from "../../packages/occ/src/state/postgres/turn-command-scope.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";

// Actual borrowed reader, transaction lifetime and private-field turn scope.
// Controlled row transport exercises decoding, identity and lifetime behavior;
// it does not execute PostgreSQL, emulate locks/triggers, or authenticate accounts.
const identity = {
  installationId: "installation",
  namespaceId: "namespace",
  agentId: "agent",
  operationRef: "operation",
};
const lookup = {
  installationId: identity.installationId,
  accountId: "local-user",
  issuer: "occ:installation:installation:better-auth",
  subject: "local-user",
};
const row = {
  installation_id: lookup.installationId,
  account_id: lookup.accountId,
  issuer: lookup.issuer,
  subject: lookup.subject,
  incarnation: "dba0ab49-4139-450b-a4d8-5886d2a79ee4",
  account_version: "2",
  state: "active",
  current_user_id: lookup.accountId,
  credential_account_id: "credential-row-pk",
};
const result = (value = row) => ({ rows: [value], rowCount: 1 });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

function setup(t, options = {}) {
  const outer = new RepositoryTransactionLifetime();
  let io = new RepositoryTransactionLifetime();
  const abort = new AbortController();
  const scope = new TurnCommandScopeV1(outer, identity, {
    signal: abort.signal,
    deadline: new Date(Date.now() + 30_000).toISOString(),
  });
  const calls = [];
  let reply = options.reply ?? (() => result());
  const context = {
    owner: options.owner ?? scope,
    token: options.copiedToken ? { ...scope.unit } : scope.unit,
    scope: { installationId: options.installationId ?? identity.installationId },
    get transaction() {
      return io;
    },
    assertAcquisitionOrder() {
      options.order?.();
    },
    query: {
      query(statement, parameters) {
        calls.push({ statement, parameters });
        return io.run(() => reply());
      },
    },
  };
  const reader = createPostgresAccountSecurityReaderV1(context);
  t.after(async () => {
    outer.close();
    io.close();
    await scope.finishTerminal("rolled-back").catch(() => {});
  });
  return {
    scope,
    outer,
    abort,
    reader,
    calls,
    closeIO: () => io.finish(),
    reopenIO: () => (io = new RepositoryTransactionLifetime()),
    reply: (next) => (reply = next),
  };
}

test("reader retains an immutable nonsecret record and the original lookup across await", async (t) => {
  const pending = deferred();
  const h = setup(t, { reply: () => pending.promise });
  const supplied = { ...lookup };
  const locking = h.reader.lock(supplied);
  supplied.accountId = "different-user";
  pending.resolve(result({ ...row, password: "not-projected" }));
  const lease = await locking;
  assert.deepEqual(h.calls[0].parameters, Object.values(lookup));
  assert.equal(lease.record.accountId, lookup.accountId);
  assert.equal(lease.record.credentialAccountId, "credential-row-pk");
  assert.equal(lease.record.accountVersion, 2);
  assert.equal(Object.hasOwn(lease.record, "password"), false);
  assert.equal(Object.isFrozen(lease), true);
  assert.equal(Object.isFrozen(lease.record), true);
  assert.equal(lease.assertCurrent(), undefined);
});

test("a missing managed record remains absent", async (t) => {
  const h = setup(t, { reply: () => ({ rowCount: 0, rows: [] }) });
  assert.equal(await h.reader.lock(lookup), undefined);
  assert.equal(h.calls.length, 1);
});

for (const state of ["provisioning", "deleted"]) {
  test(`reader preserves ${state} without promoting it to active`, async (t) => {
    const h = setup(t, {
      reply: () =>
        result({
          ...row,
          state,
          current_user_id: state === "deleted" ? null : row.current_user_id,
          credential_account_id: null,
        }),
    });
    const lease = await h.reader.lock(lookup);
    assert.equal(lease.record.state, state);
    assert.equal(lease.record.credentialAccountId, null);
  });
}

test("largest supported account version decodes without precision loss", async (t) => {
  const h = setup(t, { reply: () => result({ ...row, account_version: "9007199254740991" }) });
  assert.equal((await h.reader.lock(lookup)).record.accountVersion, Number.MAX_SAFE_INTEGER);
});

for (const version of ["0", "-1", "02", "9007199254740992", "1.5", 2]) {
  test(`unsupported wire version ${JSON.stringify(version)} refuses and poisons the owner`, async (t) => {
    const h = setup(t, { reply: () => result({ ...row, account_version: version }) });
    await assert.rejects(h.reader.lock(lookup), DependencyUnavailableError);
    assert.throws(() => h.scope.assertOwned(h.scope.unit), DependencyUnavailableError);
  });
}

for (const field of ["installation_id", "account_id", "issuer", "subject"]) {
  test(`returned ${field} must retain original lookup correspondence`, async (t) => {
    const h = setup(t, { reply: () => result({ ...row, [field]: "foreign" }) });
    await assert.rejects(h.reader.lock(lookup), DependencyUnavailableError);
  });
}

test("foreign lookup and foreign owner scope reject before SQL", async (t) => {
  const h = setup(t);
  await assert.rejects(h.reader.lock({ ...lookup, subject: "foreign" }), ScopeViolationError);
  assert.equal(h.calls.length, 0);
  const other = setup(t, { installationId: "foreign" });
  await assert.rejects(other.reader.lock(lookup), ScopeViolationError);
  assert.equal(other.calls.length, 0);
});

test("copied nominal token cannot replace the actual scope unit", async (t) => {
  const h = setup(t, { copiedToken: true });
  await assert.rejects(h.reader.lock(lookup), ScopeViolationError);
  assert.equal(h.calls.length, 0);
});

test("structurally positive owner is not a private-field scope", async (t) => {
  const h = setup(t, { owner: { assertOwned() {}, poison() {} } });
  await assert.rejects(h.reader.lock(lookup), TypeError);
  assert.equal(h.calls.length, 0);
});

test("original owner's acquisition-order refusal is preserved before SQL", async (t) => {
  const refusal = new Error("policy already acquired");
  const h = setup(t, {
    order: () => {
      throw refusal;
    },
  });
  await assert.rejects(h.reader.lock(lookup), (error) => error === refusal);
  assert.throws(
    () => h.scope.assertOwned(h.scope.unit),
    (error) => error === refusal,
  );
  assert.equal(h.calls.length, 0);
});

test("retained fence survives closed acquisition IO, and fresh preparation uses new active IO", async (t) => {
  const h = setup(t);
  let lease;
  await h.scope.enroll({
    async consume() {
      lease = await h.reader.lock(lookup);
      await h.closeIO();
      return {
        async prepareCommit() {
          h.reopenIO();
          await lease.prepareCommit();
          await h.closeIO();
        },
        assertCurrent: () => lease.assertCurrent(),
        async release() {
          lease.release();
        },
      };
    },
  });
  assert.equal(lease.assertCurrent(), undefined);
  await h.scope.prepareCommit();
  assert.equal(h.calls.length, 2);
  h.scope.markCommitDispatched();
  h.scope.observeCommitAcknowledgement("COMMIT");
  await h.scope.finishTerminal("committed");
  assert.throws(() => lease.assertCurrent(), DependencyUnavailableError);
});

test("preparation cannot query through the expired acquisition callback", async (t) => {
  const h = setup(t);
  const lease = await h.reader.lock(lookup);
  await h.closeIO();
  await assert.rejects(lease.prepareCommit(), ScopeViolationError);
  assert.equal(h.calls.length, 1);
});

for (const [field, changed] of [
  ["account_version", "3"],
  ["incarnation", "96453b04-f846-40b9-97f8-58ce27492ee4"],
  ["state", "provisioning"],
  ["current_user_id", null],
  ["credential_account_id", "replacement-row"],
]) {
  test(`preparation refuses changed retained ${field}`, async (t) => {
    const h = setup(t);
    const lease = await h.reader.lock(lookup);
    h.reply(() => result({ ...row, [field]: changed }));
    await assert.rejects(lease.prepareCommit(), DependencyUnavailableError);
    assert.throws(() => lease.assertCurrent(), DependencyUnavailableError);
  });
}

test("post-await cancellation retains the original loss identity", async (t) => {
  const pending = deferred();
  const h = setup(t, { reply: () => pending.promise });
  const locking = h.reader.lock(lookup);
  const lost = new Error("original source cancelled");
  h.abort.abort(lost);
  pending.resolve(result());
  await assert.rejects(locking, (error) => error === lost);
});

test("post-await outer lifetime loss is refused", async (t) => {
  const pending = deferred();
  const h = setup(t, { reply: () => pending.promise });
  const locking = h.reader.lock(lookup);
  h.outer.close();
  pending.resolve(result());
  await assert.rejects(locking, ScopeViolationError);
});

test("query failure poisons the genuine owner even when the caller catches it", async (t) => {
  const lost = new Error("query transport failed");
  const h = setup(t, {
    reply: async () => {
      throw lost;
    },
  });
  await assert.rejects(h.reader.lock(lookup), (error) => error === lost);
  assert.throws(
    () => h.scope.assertOwned(h.scope.unit),
    (error) => error === lost,
  );
});

test("one reader cannot reacquire or retarget another record", async (t) => {
  const h = setup(t);
  await h.reader.lock(lookup);
  await assert.rejects(h.reader.lock(lookup), DependencyUnavailableError);
  assert.equal(h.calls.length, 1);
});

test("ambiguous helper result cannot produce a retained lease", async (t) => {
  const h = setup(t, { reply: () => ({ rowCount: 2, rows: [row, row] }) });
  await assert.rejects(h.reader.lock(lookup), DependencyUnavailableError);
});

test("release closes only the observation and never issues transaction SQL", async (t) => {
  const h = setup(t);
  const lease = await h.reader.lock(lookup);
  lease.release();
  lease.release();
  h.outer.assertActive();
  assert.equal(h.calls.length, 1);
  await assert.rejects(lease.prepareCommit(), DependencyUnavailableError);
  assert.equal(h.calls.length, 1);
});

test("concurrent prepare and a final fence during preparation cannot be accepted", async (t) => {
  const h = setup(t);
  const lease = await h.reader.lock(lookup);
  const pending = deferred();
  h.reply(() => pending.promise);
  const preparing = lease.prepareCommit();
  assert.throws(() => lease.assertCurrent(), DependencyUnavailableError);
  await assert.rejects(lease.prepareCommit(), DependencyUnavailableError);
  pending.resolve(result());
  await assert.rejects(preparing, DependencyUnavailableError);
});
