import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { workloadProfileAdmissionFixture } from "../fixtures/workload-profile-admission-v2.mjs";

// Actual state/phase/reader and NativeIAM against a controlled PostgreSQL protocol
// peer. These cases do not execute SQL, install roles or qualify a real session.
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function protocol(options = {}) {
  const f = workloadProfileAdmissionFixture();
  const issuer = `occ:installation:${f.installationId}:better-auth`;
  const principal = { id: f.actor.principalRef, kind: "principal", issuer, subject: "account" };
  const lookup = {
    installationId: f.installationId,
    accountId: "account",
    issuer,
    subject: "account",
    sessionId: "session",
    sessionCredentialDigest: "a".repeat(64),
  };
  const row = {
    installation_id: f.installationId,
    account_id: "account",
    issuer,
    subject: "account",
    incarnation: randomUUID(),
    account_version: "1",
    state: "active",
    current_user_id: "account",
    credential_account_id: "credential-row",
    session_id: "session",
    session_user_id: "account",
    session_credential_digest: "a".repeat(64),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    remaining_ms: "60000",
  };
  const events = [],
    statements = [];
  let connects = 0,
    held,
    accountUnit,
    operationIO;
  const response = (rows = [], command = "SELECT") => ({ rows, rowCount: rows.length, command });
  const client = {
    on() {},
    removeListener() {},
    release() {
      events.push("client-release");
      if (options.releaseFailure) throw options.releaseFailure;
    },
    async query(statement, parameters = []) {
      statements.push({ statement, parameters: structuredClone(parameters) });
      if (statement === "COMMIT" || statement === "ROLLBACK") {
        if (statement === "COMMIT") {
          assert.throws(() => operationIO.assertActive());
          held?.assertCurrent();
          events.push("retained-fence-after-io-close");
          if (options.commitFailure) throw options.commitFailure;
        }
        events.push(statement);
        return response([], statement);
      }
      if (
        statement.startsWith("BEGIN") ||
        statement.startsWith("SET ") ||
        statement.startsWith("SELECT set_config")
      )
        return response();
      if (statement.includes("FROM occ.installation "))
        return response([
          { id: f.installationId, name: "Controlled", created_at: new Date().toISOString() },
        ]);
      if (statement.includes("read_locked_workload_profile_session_v1")) {
        events.push("session-read");
        assert.deepEqual(parameters, Object.values(lookup));
        if (options.wait) await options.wait.promise;
        events.push("session-read-settled");
        if (options.queryFailure) throw options.queryFailure;
        return response(
          options.absent ? [] : [options.row ? options.row(structuredClone(row)) : row],
        );
      }
      if (statement.includes("lock_workload_profile_iam")) {
        events.push("policy");
        return response();
      }
      if (statement.includes("FROM occ.iam_identities ")) return response([principal]);
      if (statement.includes("FROM occ.iam_roles "))
        return response([
          {
            id: "role",
            permissions: ["agent", "configuration", "service_account"].map((resourceKind) => ({
              action: "read",
              resourceKind,
            })),
          },
        ]);
      if (statement.includes("FROM occ.iam_access_bindings "))
        return response([{ id: "binding", identity_subject_id: principal.id, role_id: "role" }]);
      if (statement.includes("FROM occ.iam_")) return response();
      throw new Error(`Unexpected controlled SQL: ${statement}`);
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
  const selection = new DriverSelection();
  const driver = new NativeIAMDriver(state);
  selection.registerDriver(driver);
  selection.selectDriver("iam", driver.id);
  const reader = state.workloadProfileSessionSecurityV1();
  const invocation = Object.freeze({ controlled: true });
  const binding = [
    principal.id,
    {
      namespaceId: f.namespaceId,
      agentId: `agt_${randomUUID()}`,
      command: {
        schemaVersion: 2,
        operationRef: randomUUID(),
        expectedLifecycleGeneration: null,
        revisionSource: "saved-draft",
        expectedDraft: {
          configurationId: `cfg_${randomUUID()}`,
          configurationGeneration: 1,
          providerId: "provider/controlled",
          executionMode: "dedicated",
          serviceAccountId: null,
          workloadProfileSelection: f.head.selection,
        },
      },
    },
  ];
  const account = {
    async consume(actual, request, unit) {
      assert.strictEqual(actual, invocation);
      assert.equal(request.purpose, "workload-profile-deployment-recovery");
      accountUnit = unit;
      unit.retainSecurityCleanup(() => {
        events.push("older-security-release");
      });
      const input = options.lookup ? options.lookup(lookup) : lookup;
      const pending = reader.lock(options.copyUnit ? { ...unit } : unit, input);
      if (options.unawaited) {
        void pending.catch(() => {});
      } else if (options.caught) {
        try {
          held = await pending;
        } catch {
          events.push("caught-reader-failure");
        }
      } else held = await pending;
      if (!options.unawaited && !options.caught && !held)
        throw new Error("Controlled source refuses absence");
      if (options.earlyRelease) held.release();
      return {
        principal,
        accountRef: "account",
        requestId: "request",
        admissionDecisionId: "decision",
        assertCurrent() {
          held?.assertCurrent();
        },
        release() {
          events.push("account-release");
          held?.release();
        },
      };
    },
  };
  const { enrollment } = state.workloadProfileMutationEnrollmentV2(selection, account);
  const run = () =>
    state.read((view) =>
      enrollment.withRecovery(invocation, binding, async (unit, io) => {
        operationIO = io;
        events.push("callback");
        if (options.lateRead) {
          try {
            await reader.lock(accountUnit, lookup);
          } catch {
            events.push("caught-late-read");
          }
        }
        if (options.callback) await options.callback({ held, unit, io, events });
        return "result";
      }),
    );
  return {
    run,
    reader,
    lookup,
    events,
    statements,
    state,
    get connects() {
      return connects;
    },
    get held() {
      return held;
    },
    get unit() {
      return accountUnit;
    },
  };
}

test("actual profile reader holds exact account/session identity before policy and through original COMMIT", async () => {
  const f = protocol();
  assert.equal(await f.run(), "result");
  assert.equal(f.connects, 1);
  assert.ok(f.events.indexOf("session-read") < f.events.indexOf("policy"));
  assert.ok(f.events.indexOf("retained-fence-after-io-close") < f.events.indexOf("COMMIT"));
  assert.ok(f.events.indexOf("client-release") < f.events.indexOf("account-release"));
  assert.ok(f.events.indexOf("account-release") < f.events.indexOf("older-security-release"));
  assert.throws(() => f.held.assertCurrent());
  assert.equal(
    f.statements.filter((q) => q.statement.includes("read_locked_workload_profile_session_v1"))
      .length,
    1,
  );
  assert.equal(Object.hasOwn(f.held, "token"), false);
});

test("foreign and copied canonical units cannot borrow the reader", async () => {
  const f = protocol();
  await assert.rejects(f.reader.lock({ installationId: f.lookup.installationId }, f.lookup));
  assert.equal(f.connects, 0);
  const copied = protocol({ copyUnit: true });
  await assert.rejects(copied.run());
  assert.equal(copied.events.includes("session-read"), false);
});
for (const [name, amend] of [
  ["provisioning", (r) => ({ ...r, state: "provisioning", credential_account_id: null })],
  [
    "deleted",
    (r) => ({ ...r, state: "deleted", current_user_id: null, credential_account_id: null }),
  ],
  ["foreign user", (r) => ({ ...r, session_user_id: "foreign" })],
  ["rotated credential", (r) => ({ ...r, session_credential_digest: "b".repeat(64) })],
  ["expired", (r) => ({ ...r, expires_at: new Date(Date.now() - 1000).toISOString() })],
  ["unsafe version", (r) => ({ ...r, account_version: "9007199254740992" })],
  ["zero duration", (r) => ({ ...r, remaining_ms: "0" })],
])
  test(`actual reader rejects ${name} and prevents COMMIT`, async () => {
    const f = protocol({ row: amend });
    await assert.rejects(f.run());
    assert.equal(f.events.includes("COMMIT"), false);
    assert.ok(f.events.includes("ROLLBACK"));
    assert.ok(f.events.includes("older-security-release"));
  });

test("missing session observation remains unavailable", async () => {
  const f = protocol({ absent: true });
  await assert.rejects(f.run());
  assert.equal(f.events.includes("policy"), false);
  assert.equal(f.events.includes("COMMIT"), false);
});
for (const kind of ["caught", "unawaited"])
  test(`${kind} reader failure is joined and poisons the original operation`, async () => {
    const f = protocol({ [kind]: true, queryFailure: new Error("controlled reader failure") });
    await assert.rejects(f.run());
    assert.equal(f.events.includes("COMMIT"), false);
    assert.ok(f.events.includes("older-security-release"));
  });

test("input getter failure occurs after cleanup ownership and rolls back", async () => {
  const f = protocol({
    lookup: (value) => ({
      ...value,
      get sessionId() {
        throw new Error("lookup getter");
      },
    }),
  });
  await assert.rejects(f.run(), /lookup getter/);
  assert.equal(f.events.includes("session-read"), false);
  assert.ok(f.events.includes("older-security-release"));
});

test("same-owner late account SQL is refused and caught denial still prevents commit", async () => {
  const f = protocol({ lateRead: true });
  await assert.rejects(f.run());
  assert.ok(f.events.includes("caught-late-read"));
  assert.equal(f.events.includes("COMMIT"), false);
  assert.equal(
    f.statements.filter((q) => q.statement.includes("read_locked_workload_profile_session_v1"))
      .length,
    1,
  );
});

test("releasing observation early cannot release locks or authorize commit", async () => {
  const f = protocol({ earlyRelease: true });
  await assert.rejects(f.run());
  assert.equal(f.events.includes("COMMIT"), false);
  assert.ok(f.events.includes("client-release"));
});

test("expiry after acquisition is checked again before original COMMIT", async () => {
  const f = protocol({
    row: (r) => ({
      ...r,
      expires_at: new Date(Date.now() + 500).toISOString(),
      remaining_ms: "500",
    }),
    callback: async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    },
  });
  await assert.rejects(f.run());
  assert.ok(f.events.includes("callback"));
  assert.equal(f.events.includes("COMMIT"), false);
});

test("recovery read cleanup preserves the original error after acknowledged COMMIT", async () => {
  const failure = new Error("controlled cleanup");
  const f = protocol({ releaseFailure: failure });
  await assert.rejects(f.run(), (error) => error === failure);
  assert.ok(f.events.includes("COMMIT"));
  assert.ok(f.events.includes("older-security-release"));
});

test("session successor reuses the original statement gate and restricts helper disclosure", async () => {
  const sql = await readFile(
    new URL("../../migrations/0035_workload_profile_session_security.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /TG_TABLE_NAME NOT IN \('user', 'account', 'session'\)/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE ON occ\.session\s+FOR EACH STATEMENT/);
  assert.match(sql, /BEFORE TRUNCATE ON occ\.session/);
  assert.match(sql, /native-account-security-v1:' \|\| canonical_installation, 0/);
  assert.ok(
    sql.indexOf("FROM occ.read_locked_account_security_v1") < sql.indexOf("FROM occ.session AS s"),
  );
  assert.ok(
    sql.indexOf("account_record.state IS DISTINCT FROM 'active'") <
      sql.indexOf("FROM occ.session AS s"),
  );
  assert.ok(sql.indexOf("FOR SHARE") < sql.indexOf("sampled_now := pg_catalog.clock_timestamp()"));
  assert.match(sql, /session_record\.token, 'UTF8'/);
  assert.match(sql, /SET search_path = pg_catalog, pg_temp/);
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION occ\.read_locked_workload_profile_session_v1\(text,text,text,text,text,text\) FROM PUBLIC/,
  );
  assert.doesNotMatch(sql, /GRANT|CREATE ROLE|ALTER TABLE|UPDATE occ\.account_security_records/);
  const returns = sql.slice(
    sql.indexOf("RETURNS TABLE"),
    sql.indexOf("LANGUAGE plpgsql", sql.indexOf("RETURNS TABLE")),
  );
  assert.doesNotMatch(returns, /\btoken\b|\bpassword\b/);
});

test("detached security acquisition is joined and refused before policy or commit", async () => {
  const wait = deferred();
  const f = protocol({ wait, unawaited: true });
  let settled = false;
  const running = f.run().finally(() => {
    settled = true;
  });
  const denied = assert.rejects(running, /The account acquisition is closed/);
  while (!f.events.includes("session-read")) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(f.events.includes("policy"), false);
  assert.equal(f.events.includes("COMMIT"), false);
  assert.equal(f.events.includes("older-security-release"), false);
  wait.resolve();
  await denied;
  assert.equal(f.events.includes("policy"), false);
  assert.equal(f.events.includes("callback"), false);
  assert.equal(f.events.includes("COMMIT"), false);
  assert.ok(f.events.includes("ROLLBACK"));
  assert.ok(f.events.indexOf("session-read-settled") < f.events.indexOf("older-security-release"));
});

test("the initial query wait never extends the database-sampled retained duration", async () => {
  const wait = deferred();
  const f = protocol({ wait, row: (r) => ({ ...r, remaining_ms: "10" }) });
  const running = f.run();
  const denied = assert.rejects(running);
  while (!f.events.includes("session-read")) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 30));
  wait.resolve();
  await denied;
  assert.equal(f.events.includes("COMMIT"), false);
});
