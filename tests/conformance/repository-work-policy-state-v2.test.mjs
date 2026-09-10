import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresRepositoryWorkPolicyV2 } from "../../packages/occ/src/state/postgres/repository-work-policy-v2.ts";
import { canonicalRepositoryWorkV2 } from "../../packages/occ/src/state/postgres/repository-work-v2.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";

// Data-repository tests only. The query peer is controlled; no result here
// authenticates an operator, creates a policy grant or claims PostgreSQL flow.
const scope = {
  installationId: "ins_11111111-1111-4111-8111-111111111111",
  namespaceId: "ns_11111111-1111-4111-8111-111111111111",
  agentId: "agt_11111111-1111-4111-8111-111111111111",
};
const canonicalPolicy = (version = 1) => ({
  schemaVersion: 2,
  scope,
  policyRef: "policy",
  version,
  status: "enabled",
  servicePrincipalId: "service",
  repository: {
    target: {
      installationId: scope.installationId,
      githubHost: "github.com",
      appId: "100",
      githubInstallationId: "200",
      repositoryId: "42",
    },
    owner: "owner",
    name: "name",
    profile: { ref: "repository-profile", revision: "1" },
  },
  executionProfile: { ref: "execution-profile", revision: "1" },
  operations: ["metadata:read"],
  bounds: {
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
    maximumWorkMilliseconds: 60000,
  },
});
const policy = (version = 1) => ({
  ...scope,
  policyRef: "policy",
  version,
  status: "enabled",
  servicePrincipalId: "service",
  repositoryId: "42",
  document: canonicalPolicy(version),
});
const change = (version = 1) => ({
  operationRef: `operation-${version}`,
  requestDigest: `sha256:${"1".repeat(64)}`,
  commitRef: "commit",
  actorId: "operator",
  expectedVersion: version === 1 ? null : version - 1,
  policy: policy(version),
});
function fixture(head, previous, transform = (value) => value) {
  const calls = [];
  let active = true;
  const context = {
    scope,
    transaction: {
      assertActive() {
        if (!active) throw new ScopeViolationError("ended");
      },
    },
    query: {
      async query(statement, values) {
        calls.push({ statement, values });
        const document = (value) => ({
          rows: [{ canonical_document: canonicalRepositoryWorkV2(transform(value)) }],
          rowCount: 1,
        });
        if (statement.startsWith("SELECT v.canonical_document"))
          return head ? document(head) : { rows: [], rowCount: 0 };
        if (
          statement.startsWith(
            "SELECT canonical_document FROM occ.repository_work_policy_operations_v2",
          )
        )
          return previous ? document(previous) : { rows: [], rowCount: 0 };
        if (
          statement.startsWith("INSERT INTO occ.repository_work_policy_versions_v2") ||
          statement.startsWith("INSERT INTO occ.repository_work_policy_operations_v2")
        )
          return { rows: [{ canonical_document: values.at(-1) }], rowCount: 1 };
        if (
          statement.startsWith("INSERT INTO occ.repository_work_policy_heads_v2") ||
          statement.startsWith("UPDATE occ.repository_work_policy_heads_v2")
        )
          return { rows: [{ policy_ref: values[3] }], rowCount: 1 };
        throw new Error("Unselected controlled query");
      },
    },
  };
  return {
    repository: createPostgresRepositoryWorkPolicyV2(context, scope, "commit"),
    calls,
    close() {
      active = false;
    },
  };
}

test("closed policy repository cannot reuse captured query capabilities", async () => {
  const test = fixture();
  test.close();
  await assert.rejects(test.repository.find("policy"), ScopeViolationError);
  await assert.rejects(test.repository.change(change()), ScopeViolationError);
  assert.equal(test.calls.length, 0);
});

test("current policy read rejects another scoped row", async () => {
  const test = fixture({ ...policy(), agentId: "other" });
  await assert.rejects(test.repository.find("policy"), ScopeViolationError);
});

test("a stale policy CAS creates no version or operation", async () => {
  const test = fixture(policy(2));
  assert.equal(await test.repository.change(change(2)), "conflict");
  assert.equal(
    test.calls.some((c) => c.statement.startsWith("INSERT") || c.statement.startsWith("UPDATE")),
    false,
  );
});

test("policy identity cannot move to another service or repository on the same head", async () => {
  for (const field of ["servicePrincipalId", "repositoryId"]) {
    const test = fixture(policy());
    const input = change(2);
    input.policy[field] = field === "repositoryId" ? "43" : "other";
    if (field === "repositoryId") input.policy.document.repository.target.repositoryId = "43";
    else input.policy.document.servicePrincipalId = "other";
    assert.equal(await test.repository.change(input), "conflict");
    assert.equal(
      test.calls.some((c) => c.statement.startsWith("INSERT") || c.statement.startsWith("UPDATE")),
      false,
    );
  }
});

test("exact operation replay preserves original stored commit and writes nothing", async () => {
  const previous = { ...change(), commitRef: "old-original-commit" },
    test = fixture(policy(), previous);
  assert.equal(await test.repository.change(change()), "existing");
  assert.equal(
    (await test.repository.readOperation("operation-1")).commitRef,
    "old-original-commit",
  );
  assert.equal(
    test.calls.some((c) => c.statement.startsWith("INSERT") || c.statement.startsWith("UPDATE")),
    false,
  );
});

test("same operation with a changed policy document conflicts", async () => {
  const test = fixture(policy(), { ...change(), commitRef: "old-commit" });
  const input = change();
  input.policy.document = { ...input.policy.document, operations: ["metadata:read", "git:read"] };
  assert.equal(await test.repository.change(input), "conflict");
});

test("policy version and scope must correspond before any query", async () => {
  for (const input of [
    { ...change(), policy: policy(2) },
    { ...change(), policy: { ...policy(), namespaceId: "other" } },
    { ...change(), requestDigest: "1".repeat(64) },
  ]) {
    const test = fixture();
    await assert.rejects(test.repository.change(input), ScopeViolationError);
    assert.equal(test.calls.length, 0);
  }
});

test("successful policy storage stages version then head then immutable operation", async () => {
  const test = fixture();
  assert.equal(await test.repository.change(change()), "staged");
  const writes = test.calls.filter((c) => c.statement.startsWith("INSERT"));
  assert.equal(writes.length, 3);
  assert.match(writes[0].statement, /policy_versions_v2/);
  assert.match(writes[1].statement, /policy_heads_v2/);
  assert.match(writes[2].statement, /policy_operations_v2/);
  assert.equal(JSON.parse(writes[2].values.at(-1)).commitRef, "commit");
});

import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";

// Genuine State + NativeIAM transaction implementation with a controlled SQL
// transport and explicitly controlled account boundary. This proves constructor,
// lock, authorization, audit and terminal behavior, not real HTTP/PG acceptance.
function operatorFixture(hooks = {}) {
  const queries = [],
    events = [],
    operations = new Map();
  const principal = { id: "operator", kind: "principal", issuer: "issuer", subject: "subject" };
  const rows = (values) => ({ rows: values, rowCount: values.length });
  const client = {
    on() {},
    removeListener() {},
    release(destroy) {
      events.push(["client-release", destroy]);
    },
    async query(statement, values) {
      queries.push(statement);
      hooks.query?.(statement, values);
      if (statement === "COMMIT") {
        if (hooks.commit) return hooks.commit();
        return { command: "COMMIT", ...rows([]) };
      }
      if (statement === "ROLLBACK") return { command: "ROLLBACK", ...rows([]) };
      if (
        statement.startsWith("BEGIN") ||
        statement.startsWith("SET LOCAL") ||
        statement.startsWith("SELECT set_config(")
      )
        return rows([]);
      if (statement === "SELECT id, name, created_at FROM occ.installation ORDER BY id LIMIT 2")
        return rows([
          {
            id: scope.installationId,
            name: "installation",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ]);
      if (statement === "SELECT occ.lock_workload_profile_iam()") {
        events.push(["iam-lock"]);
        return rows([{ lock_workload_profile_iam: null }]);
      }
      if (statement.startsWith("SELECT id FROM occ.")) return rows([{ id: values.at(-1) }]);
      if (statement.includes("FROM occ.read_locked_workload_profile_session_v1")) {
        events.push(["session-lock"]);
        return rows([
          {
            installation_id: values[0],
            account_id: values[1],
            issuer: values[2],
            subject: values[3],
            session_id: values[4],
            session_credential_digest: values[5],
            incarnation: "incarnation",
            account_version: "1",
            state: "active",
            current_user_id: values[1],
            credential_account_id: "credential",
            session_user_id: values[1],
            expires_at: new Date(Date.now() + 60000).toISOString(),
            remaining_ms: "60000",
          },
        ]);
      }
      if (statement.includes("FROM occ.iam_identities"))
        return rows([
          {
            id: "operator",
            kind: "principal",
            namespace_id: null,
            agent_id: null,
            issuer: "issuer",
            subject: "subject",
          },
          {
            id: "service",
            kind: "service_principal",
            namespace_id: scope.namespaceId,
            agent_id: scope.agentId,
            issuer: null,
            subject: null,
          },
        ]);
      if (statement.includes("FROM occ.iam_roles"))
        return rows([
          {
            id: "admin-role",
            namespace_id: scope.namespaceId,
            name: "admin",
            permissions: [{ resourceKind: "agent", action: hooks.denied ? "read" : "administer" }],
          },
        ]);
      if (statement.includes("FROM occ.iam_access_bindings"))
        return rows([
          {
            id: "binding",
            namespace_id: scope.namespaceId,
            identity_subject_id: "operator",
            group_subject_id: null,
            role_id: "admin-role",
            resource_kind: "agent",
            resource_id: scope.agentId,
            channel_administration: null,
          },
        ]);
      if (statement.includes("FROM occ.iam_")) return rows([]);
      if (statement.startsWith("SELECT v.canonical_document")) return rows([]);
      if (
        statement.startsWith(
          "SELECT canonical_document FROM occ.repository_work_policy_operations_v2",
        )
      ) {
        const stored = operations.get(values[3]);
        return stored ? rows([{ canonical_document: stored }]) : rows([]);
      }
      if (statement.startsWith("INSERT INTO occ.repository_work_policy_versions_v2"))
        return rows([{ canonical_document: values.at(-1) }]);
      if (statement.startsWith("INSERT INTO occ.repository_work_policy_heads_v2"))
        return rows([{ policy_ref: values[3] }]);
      if (statement.startsWith("INSERT INTO occ.repository_work_policy_operations_v2")) {
        operations.set(values[3], values.at(-1));
        return rows([{ canonical_document: values.at(-1) }]);
      }
      if (statement.startsWith("INSERT INTO occ.audit_events")) {
        events.push(["audit", values[3], values[4]]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error("Unknown controlled policy protocol query");
    },
  };
  const state = new PostgresPlatformState({
    options: { connectionTimeoutMillis: 100 },
    async connect() {
      return client;
    },
    async end() {},
  });
  const selection = new DriverSelection();
  selection.registerDriver(
    new NativeIAMDriver(
      hooks.wrongStore
        ? {
            async loadNativeIAMState() {
              throw new Error();
            },
          }
        : state,
    ),
  );
  selection.selectDriver("iam", "occ-native-iam");
  const binding = state.repositoryWorkPolicyBindingV2(selection);
  let captured;
  const source = {
    async consume(invocation, request, unit) {
      assert.equal(request.purpose, "repository-work-policy-operator");
      assert.equal(request.binding.method, "mutate");
      captured = unit;
      const owner = binding.accountOwner.bind(unit, () => {
        events.push(["account-owner-release"]);
      });
      events.push(["account-held"]);
      await hooks.consume?.(binding, unit, state, owner);
      return {
        get principal() {
          hooks.principal?.();
          return principal;
        },
        accountRef: "account",
        requestId: "request",
        admissionDecisionId: "decision",
        assertCurrent() {
          owner.assertCurrent();
          hooks.current?.(unit);
        },
        release() {
          events.push(["account-lease-release"]);
        },
      };
    },
  };
  const store = binding.bindOriginalAccount(source);
  const mutate = () =>
    store.mutate(
      Object.freeze({}),
      { operationRef: "change", expectedVersion: null, policy: canonicalPolicy() },
      { signal: new AbortController().signal, timeoutMs: 1500 },
    );
  return { mutate, queries, events, binding, state, captured: () => captured };
}

test("original State policy mutation uses actual NativeIAM administer and same audit before COMMIT", async () => {
  let principalReads = 0;
  const test = operatorFixture({
    principal() {
      principalReads++;
    },
  });
  const result = await test.mutate();
  assert.equal(
    result.kind,
    "committed",
    JSON.stringify({ queries: test.queries, events: test.events }),
  );
  assert.equal(principalReads, 1);
  assert.ok(
    test.events.findIndex((e) => e[0] === "account-held") <
      test.events.findIndex((e) => e[0] === "iam-lock"),
  );
  assert.deepEqual(
    test.events.find((e) => e[0] === "audit"),
    ["audit", "operator", "work.repository.policy.mutate"],
  );
  assert.ok(
    test.queries.findIndex((q) => q.includes("INSERT INTO occ.audit_events")) <
      test.queries.indexOf("COMMIT"),
  );
  await assert.rejects(test.captured().query("SELECT 1"), ScopeViolationError);
});

test("real NativeIAM denial cannot write a repository policy", async () => {
  const test = operatorFixture({ denied: true });
  assert.equal((await test.mutate()).kind, "denied");
  assert.equal(
    test.queries.some((q) => q.startsWith("INSERT INTO occ.repository_work_policy")),
    false,
  );
});

test("NativeIAM bound to another store cannot enter account acceptance", async () => {
  const test = operatorFixture({ wrongStore: true });
  assert.equal((await test.mutate()).kind, "unavailable");
  assert.equal(
    test.events.some((e) => e[0] === "account-held"),
    false,
  );
  assert.equal(test.queries.includes("COMMIT"), false);
});

test("copied policy account unit does not enroll and poisons caught attempts", async () => {
  const test = operatorFixture({
    consume(binding, unit) {
      assert.throws(() => binding.accountOwner.bind({ ...unit }, () => {}), ScopeViolationError);
    },
  });
  assert.equal((await test.mutate()).kind, "unavailable");
  assert.equal(test.queries.includes("COMMIT"), false);
});

test("synchronous policy fence cannot submit account SQL", async () => {
  let attempted;
  const test = operatorFixture({
    current(unit) {
      if (!attempted) {
        attempted = unit.query("SELECT forbidden");
        void attempted.catch(() => {});
      }
    },
  });
  assert.equal((await test.mutate()).kind, "unavailable");
  await assert.rejects(attempted, ScopeViolationError);
  assert.equal(test.queries.includes("SELECT forbidden"), false);
  assert.equal(test.queries.includes("COMMIT"), false);
});

test("policy nested State transaction fails and retains original cleanup", async () => {
  const test = operatorFixture({
    async consume(_binding, _unit, state) {
      await assert.rejects(
        state.transact(async () => 1),
        ScopeViolationError,
      );
    },
  });
  assert.equal((await test.mutate()).kind, "unavailable");
  assert.equal(test.queries.includes("COMMIT"), false);
  assert.equal(test.events.filter((e) => e[0] === "account-owner-release").length, 1);
});

const sessionLookup = () => ({
  installationId: scope.installationId,
  accountId: "account",
  issuer: `occ:installation:${scope.installationId}:better-auth`,
  subject: "account",
  sessionId: "session",
  sessionCredentialDigest: "1".repeat(64),
});
test("policy session reader recognizes its real enrolled unit and retains session locks before IAM", async () => {
  let held;
  const test = operatorFixture({
    async consume(_binding, unit, state) {
      held = await state.repositoryWorkPolicySessionSecurityV2().lock(unit, sessionLookup());
      assert.ok(held);
      held.assertCurrent();
    },
  });
  assert.equal((await test.mutate()).kind, "committed");
  assert.ok(
    test.events.findIndex((e) => e[0] === "session-lock") <
      test.events.findIndex((e) => e[0] === "iam-lock"),
  );
  assert.throws(() => held.assertCurrent());
  await assert.rejects(
    test.state.repositoryWorkPolicySessionSecurityV2().lock(test.captured(), sessionLookup()),
    ScopeViolationError,
  );
});
test("copied policy session unit poisons the actual owner even when its refusal is caught", async () => {
  let entered = false;
  const test = operatorFixture({
    async consume(_binding, unit, state) {
      entered = true;
      await assert.rejects(
        state.repositoryWorkPolicySessionSecurityV2().lock({ ...unit }, sessionLookup()),
        ScopeViolationError,
      );
    },
  });
  assert.equal((await test.mutate()).kind, "unavailable");
  assert.equal(entered, true);
  assert.equal(
    test.events.some((e) => e[0] === "session-lock"),
    false,
  );
  assert.equal(test.queries.includes("COMMIT"), false);
});
