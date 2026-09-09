import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createMemoryWorkloadProfileAdmissionBackendV2 } from "../../packages/occ/src/state/memory/workload-profile-admission.ts";
import { createPostgresWorkloadProfileAdmissionBackendV2 } from "../../packages/occ/src/state/postgres/workload-profile-admission.ts";
import {
  createWorkloadProfileAdmissionRepositoryV2,
  workloadProfileAdmissionHistoryV2,
  workloadProfileInvalidationV2,
  withdrawWorkloadProfileAdmissionV2,
} from "../../packages/occ/src/workload-profiles/admission-record.ts";
import { profileOperationKey } from "../../packages/occ/src/workload-profiles/types.ts";
import { WorkloadProfileTransactionGuard } from "../../packages/occ/src/workload-profiles/repository.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { createGuardedWorkloadProfileUnit } from "../../packages/occ/src/state/postgres/workload-profile-guard.ts";
import { workloadProfileAdmissionAuditV2 } from "../../packages/occ/src/state/platform-state.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { createGatewayStartupOwnerV2 } from "../../packages/occ/src/gateway-startup-v1/owner.ts";
import { binding as historicalGatewayBinding } from "../fixtures/gateway-startup-v1/values.mjs";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import {
  workloadProfileAdmissionFixture,
  profileAcceptedAt,
} from "../fixtures/workload-profile-admission-v2.mjs";

// Actual adapters/domain/lifetime and original central owner; controlled memory
// snapshots and PostgreSQL protocol replies. No SQL locking, DDL, genuine
// account/capability producer or physical execution qualification is claimed.
const copy = structuredClone;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function memoryFixture() {
  const f = workloadProfileAdmissionFixture();
  let stored = {
    operations: new Map(),
    capacities: new Map(),
    namespaces: new Map([[f.namespaceId, { id: f.namespaceId, status: "ready" }]]),
    admissions: new Map(),
    history: new Map(),
    invalidations: new Map(),
    audits: new Map(),
  };
  const seed = (record) => {
    const locator = {
      installationId: f.installationId,
      actor: record.actor,
      operationRef: record.operationRef,
    };
    stored.operations.set(profileOperationKey(locator), copy(record));
    const old = stored.capacities.get(f.installationId) ?? {
      ordinaryOperations: 0,
      pendingOrdinaryOperations: 0,
      terminalSlots: 0,
    };
    stored.capacities.set(f.installationId, {
      ordinaryOperations: old.ordinaryOperations + 1,
      pendingOrdinaryOperations: old.pendingOrdinaryOperations + 1,
      terminalSlots: old.terminalSlots,
    });
  };
  seed(f.prepared);
  const transact = async (work, options = {}) => {
    const snapshot = copy(stored),
      lifetime = new RepositoryTransactionLifetime(),
      guard = new WorkloadProfileTransactionGuard();
    const backend = createMemoryWorkloadProfileAdmissionBackendV2(
      { scope: { installationId: f.installationId }, snapshot, transaction: lifetime },
      async (attribution, history) => {
        if (options.auditFailure) throw options.auditFailure;
        const event = workloadProfileAdmissionAuditV2(attribution, history);
        assert.equal(snapshot.audits.has(event.id), false);
        snapshot.audits.set(event.id, event);
      },
    );
    const repo = createWorkloadProfileAdmissionRepositoryV2(
      backend,
      guard,
      () => profileAcceptedAt,
    );
    try {
      const result = await work(repo, backend, guard);
      await guard.finish();
      await lifetime.finish();
      guard.assertCurrent();
      stored = snapshot;
      return result;
    } catch (error) {
      try {
        await guard.finish();
      } catch {
        /* original failure */
      }
      await lifetime.finish();
      throw error;
    }
  };
  return {
    ...f,
    seed,
    transact,
    get snapshot() {
      return copy(stored);
    },
    replacement(expected) {
      return workloadProfileAdmissionFixture({
        installationId: f.installationId,
        namespaceId: f.namespaceId,
        actor: f.actor,
        expected,
      });
    },
    qualify: async () => undefined,
  };
}
const accept = (f) => f.transact((repo) => repo.accept(f.locator, f.attribution, f.qualify));

test("memory storage retains original preparation, admission, history, audit and exact quota", async () => {
  const f = memoryFixture();
  const result = await accept(f);
  assert.deepEqual(result, { action: "admit", history: f.history });
  const snapshot = f.snapshot;
  assert.equal(snapshot.operations.size, 1);
  assert.equal(snapshot.admissions.size, 1);
  assert.equal(snapshot.history.size, 1);
  assert.equal(snapshot.audits.size, 1);
  assert.equal(snapshot.invalidations.size, 0);
  assert.deepEqual(snapshot.capacities.get(f.installationId), {
    ordinaryOperations: 1,
    pendingOrdinaryOperations: 0,
    terminalSlots: 1,
  });
  const event = [...snapshot.audits.values()][0];
  assert.equal(event.id, `aud_${f.head.acceptance.auditRef}`);
  assert.equal(event.details.historyRef, f.history.historyRef);
  assert.equal(event.requestId, f.attribution.requestRef);
  assert.equal(event.admissionDecisionId, f.attribution.decisionRef);
  assert.equal(event.actorId, f.actor.principalRef);
  const replay = await f.transact((repo) =>
    repo.accept(f.locator, { ...f.attribution, requestRef: "later/transport" }),
  );
  assert.deepEqual(replay, result);
  assert.deepEqual(f.snapshot, snapshot);
});

test("replacement preserves both immutable histories and returns the new primary command", async () => {
  const f = memoryFixture();
  await accept(f);
  const next = f.replacement(f.head.selection);
  f.seed(next.prepared);
  const replaced = await f.transact((repo) =>
    repo.accept(next.locator, next.attribution, f.qualify),
  );
  assert.equal(replaced.action, "replace");
  assert.deepEqual(replaced.history, next.history);
  const snapshot = f.snapshot;
  assert.equal(snapshot.history.size, 3);
  assert.equal(snapshot.invalidations.size, 1);
  assert.equal(snapshot.audits.size, 3);
  assert.deepEqual(snapshot.capacities.get(f.installationId), {
    ordinaryOperations: 3,
    pendingOrdinaryOperations: 0,
    terminalSlots: 1,
  });
  const old = await f.transact((repo) =>
    repo.readProfile(f.namespaceId, f.head.selection.admissionRef),
  );
  assert.equal(old.state, "withdrawn");
  assert.equal(old.selection.admissionVersion, 2);
  assert.equal(old.withdrawal.reason, "replaced");
  assert.deepEqual(await f.transact((repo) => repo.accept(f.locator, f.attribution)), {
    action: "admit",
    history: f.history,
  });
  assert.deepEqual(
    await f.transact((repo) => repo.accept(next.locator, next.attribution)),
    replaced,
  );
  assert.deepEqual(f.snapshot, snapshot);
});

test("standalone withdrawal consumes one reserved terminal action and replays immutable history", async () => {
  const f = memoryFixture();
  await accept(f);
  const at = { ...f.attribution, operationRef: randomUUID() };
  const result = await f.transact((repo) => repo.withdraw(f.namespaceId, f.head.selection, at));
  assert.equal(result.head.withdrawal.reason, "withdrawn");
  assert.equal(result.historyRef, f.head.terminal.historyRef);
  const snapshot = f.snapshot;
  assert.deepEqual(snapshot.capacities.get(f.installationId), {
    ordinaryOperations: 2,
    pendingOrdinaryOperations: 0,
    terminalSlots: 0,
  });
  assert.deepEqual(
    [...snapshot.invalidations.values()][0],
    workloadProfileInvalidationV2(result.head),
  );
  assert.deepEqual(
    await f.transact((repo) =>
      repo.withdraw(f.namespaceId, f.head.selection, { ...at, requestRef: "retry/transport" }),
    ),
    result,
  );
  assert.deepEqual(f.snapshot, snapshot);
  await assert.rejects(
    f.transact((repo) =>
      repo.withdraw(f.namespaceId, f.head.selection, {
        ...at,
        actor: { ...at.actor, accountRef: "another-account" },
      }),
    ),
  );
});

for (const mode of ["awaited", "caught", "unawaited"])
  test(`mandatory audit failure rolls back ${mode} acceptance`, async () => {
    const f = memoryFixture(),
      before = f.snapshot,
      error = new Error("audit unavailable");
    await assert.rejects(
      f.transact(
        async (repo) => {
          const pending = repo.accept(f.locator, f.attribution, f.qualify);
          if (mode === "awaited") return pending;
          if (mode === "caught") await pending.catch(() => {});
          else void pending.catch(() => {});
        },
        { auditFailure: error },
      ),
      (actual) => actual === error,
    );
    assert.deepEqual(f.snapshot, before);
  });

test("memory backend rejects unordered writes, shared-lock upgrades and mismatched history", async () => {
  const f = memoryFixture();
  await f.transact(async (_repo, backend) => {
    await assert.rejects(backend.insertAdmission(f.head, f.history), ScopeViolationError);
    await assert.rejects(
      backend.lockHeads(f.namespaceId, [f.head.selection.admissionRef], "update"),
      ScopeViolationError,
    );
    await backend.lockHeads(f.namespaceId, [f.head.selection.admissionRef], "share");
    await backend.lockCapacity();
    await backend.namespaceExists(f.namespaceId);
    await assert.rejects(
      backend.lockHeads(f.namespaceId, [f.head.selection.admissionRef], "update"),
      ScopeViolationError,
    );
  });
  await f.transact(async (_repo, backend) => {
    await backend.lockCapacity();
    await backend.namespaceExists(f.namespaceId);
    await backend.lockHeads(f.namespaceId, [f.head.selection.admissionRef], "update");
    const other = f.replacement(null);
    await assert.rejects(backend.insertAdmission(f.head, other.history), ScopeViolationError);
  });
  assert.equal(f.snapshot.admissions.size, 0);
});

test("PostgreSQL adapter borrows the exact client and orders capacity/operation/Namespace/sorted heads", async () => {
  const f = workloadProfileAdmissionFixture(),
    calls = [],
    lifetime = new RepositoryTransactionLifetime();
  const backend = createPostgresWorkloadProfileAdmissionBackendV2(
    {
      scope: { installationId: f.installationId },
      transaction: lifetime,
      query: {
        query: async (statement, values = []) => {
          calls.push({ statement, values: copy(values) });
          if (statement.includes("SELECT installation_id FROM occ.workload_profile_capacity"))
            return { rows: [{ installation_id: f.installationId }], rowCount: 1 };
          if (statement.includes("FROM occ.namespaces"))
            return { rows: [{ id: f.namespaceId }], rowCount: 1 };
          if (statement.startsWith("INSERT")) return { rows: [], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
      },
    },
    async () => undefined,
  );
  await assert.rejects(backend.lockOperation(f.locator), ScopeViolationError);
  assert.equal(calls.length, 0);
  await backend.lockCapacity();
  await backend.lockOperation(f.locator);
  await backend.namespaceExists(f.namespaceId);
  const refs = [f.head.selection.admissionRef, randomUUID()].sort().reverse();
  await backend.lockHeads(f.namespaceId, refs, "update");
  assert.match(calls[0].statement, /workload-profile-capacity/);
  assert.match(calls[2].statement, /FOR UPDATE/);
  assert.match(calls[3].statement, /workload-profile-operation/);
  assert.match(calls[4].statement, /namespaces/);
  const locks = calls.filter((item) => item.statement.includes("workload-profile-head:"));
  assert.deepEqual(
    locks.map((item) => item.values),
    [...refs].sort().map((ref) => [f.installationId, ref]),
  );
  await backend.insertAdmission(f.head, f.history);
  const inserted = calls.filter((item) =>
    item.statement.includes("INSERT INTO occ.workload_profile_admission"),
  );
  assert.equal(inserted.length, 2);
  assert.deepEqual(JSON.parse(inserted[0].values.at(-1)), f.head);
  assert.deepEqual(JSON.parse(inserted[1].values.at(-1)), f.history);
  assert.equal(
    calls.some((item) => /BEGIN|COMMIT|ROLLBACK/.test(item.statement)),
    false,
  );
  await lifetime.finish();
  await assert.rejects(
    backend.head(f.namespaceId, f.head.selection.admissionRef),
    ScopeViolationError,
  );
});

test("PostgreSQL terminal mismatch fails before any borrowed mutation", async () => {
  const f = workloadProfileAdmissionFixture(),
    calls = [];
  const backend = createPostgresWorkloadProfileAdmissionBackendV2(
    {
      scope: { installationId: f.installationId },
      transaction: { assertActive() {} },
      query: {
        query: async (statement, values) => {
          calls.push({ statement, values });
          return { rows: [], rowCount: 0 };
        },
      },
    },
    async () => undefined,
  );
  const terminal = withdrawWorkloadProfileAdmissionV2(
    f.head,
    { ...f.attribution, operationRef: randomUUID() },
    "withdrawn",
    profileAcceptedAt,
  );
  const invalidation = { ...workloadProfileInvalidationV2(terminal), requestRef: randomUUID() };
  await assert.rejects(
    backend.withdrawAdmission(
      f.head,
      terminal,
      workloadProfileAdmissionHistoryV2(terminal),
      invalidation,
    ),
    ScopeViolationError,
  );
  assert.equal(calls.length, 0);
});

function guardFixture() {
  const f = workloadProfileAdmissionFixture(),
    controller = new AbortController(),
    trace = [];
  let outward = true,
    outer = true;
  const principal = {
    id: f.actor.principalRef,
    kind: "principal",
    issuer: "controlled",
    subject: "account",
  };
  const actor = {
    principal,
    accountRef: f.actor.accountRef,
    requestId: f.attribution.requestRef,
    admissionDecisionId: f.attribution.decisionRef,
  };
  const owner = {
    installationId: f.installationId,
    signal: controller.signal,
    assertActive() {
      if (!outward) throw new Error("outward closed");
    },
    assertOwnerActive() {
      if (!outer) throw new Error("outer closed");
    },
    assertSelection() {},
    query: async () => ({ rows: [], rowCount: 0 }),
    accountQuery: async () => ({ rows: [], rowCount: 0 }),
    lockPolicy: async () => {
      trace.push("policy");
    },
    iam: {
      lookupIdentity: async () => principal,
      authorize: async () => ({ allowed: true, driverId: "controlled", evidence: {} }),
    },
    profiles: {},
    resolveNamespace: async () => f.namespaceId,
    findAudit: async () => undefined,
    appendAudit: async () => {},
  };
  const guard = createGuardedWorkloadProfileUnit(owner);
  const target = [
    {
      action: "read",
      resource: { kind: "agent", id: "controlled-agent", namespaceId: f.namespaceId },
    },
  ];
  return {
    ...f,
    guard,
    actor,
    target,
    trace,
    controller,
    closeOutward() {
      outward = false;
    },
    closeOuter() {
      outer = false;
    },
  };
}

test("account owner captures cleanup before failure and joins malformed async cleanup before earlier lease release", async () => {
  const f = guardFixture(),
    wait = deferred();
  f.guard.unit.account.retainSecurityCleanup(() => {
    f.trace.push("older-release");
  });
  const owner = f.guard.bindAccountOwner(() => {
    f.trace.push("async-release-start");
    return wait.promise;
  });
  owner.assertAcquiring();
  const release = f.guard.release();
  let settled = false;
  void release.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(f.trace.includes("older-release"), false);
  wait.resolve();
  await assert.rejects(release);
  assert.equal(f.trace.at(-1), "older-release");
  assert.strictEqual(f.guard.release(), release);
});

test("same retained account facade survives outward IO closure and never recursively checks its own lease", async () => {
  const f = guardFixture();
  const owner = f.guard.bindAccountOwner(() => {
    f.trace.push("release");
  });
  f.guard.unit.retainCurrentness(() => owner.assertCurrent());
  let io;
  await f.guard.runMutation(f.actor, f.target, async (operation) => {
    io = operation;
  });
  await f.guard.finish();
  f.closeOutward();
  f.guard.assertCurrent();
  owner.assertCurrent();
  assert.throws(() => owner.assertAcquiring());
  assert.throws(() => io.assertActive());
  f.closeOuter();
  assert.throws(() => f.guard.assertCurrent(), /outer closed/);
  await f.guard.release();
  assert.deepEqual(f.trace, ["policy", "release"]);
});

test("caught detached IO failure and late operations poison the final same-owner fence", async () => {
  const f = guardFixture();
  let io;
  await f.guard.runMutation(f.actor, f.target, async (operation) => {
    io = operation;
  });
  await assert.rejects(io.query("SELECT 1"));
  await assert.rejects(f.guard.finish());
  assert.throws(() => f.guard.assertCurrent());
  await assert.rejects(f.guard.release());
});

function centralProtocol(options = {}) {
  const f = workloadProfileAdmissionFixture(),
    statements = [],
    events = [];
  const principal = {
    id: f.actor.principalRef,
    kind: "principal",
    issuer: "controlled",
    subject: "account",
  };
  const result = (rows = [], command = "SELECT") => ({ rows, rowCount: rows.length, command });
  let connects = 0,
    acquisitions = 0,
    actualView,
    actualUnit,
    actualIO;
  const client = {
    on() {},
    removeListener() {},
    release() {
      events.push("client-release");
    },
    async query(statement, parameters = []) {
      statements.push({ statement, parameters: copy(parameters) });
      if (statement === "COMMIT" || statement === "ROLLBACK") {
        events.push(statement);
        return result([], statement);
      }
      if (
        statement.startsWith("BEGIN") ||
        statement.startsWith("SET ") ||
        statement.startsWith("SELECT set_config")
      )
        return result();
      if (statement.includes("FROM occ.installation "))
        return result([
          { id: f.installationId, name: "Controlled", created_at: profileAcceptedAt },
        ]);
      if (statement.includes("lock_workload_profile_iam")) {
        events.push("policy");
        return result();
      }
      if (statement.includes("FROM occ.iam_identities ")) return result([principal]);
      if (statement.includes("FROM occ.iam_roles "))
        return result([
          {
            id: "role",
            permissions: ["agent", "configuration", "service_account"].flatMap((resourceKind) =>
              ["read", "update", "deploy"].map((action) => ({ action, resourceKind })),
            ),
          },
        ]);
      if (statement.includes("FROM occ.iam_access_bindings "))
        return result([{ id: "binding", identity_subject_id: principal.id, role_id: "role" }]);
      if (statement.includes("FROM occ.iam_")) return result();
      if (statement.includes("SELECT a.record FROM occ.workload_profile_admissions AS a")) {
        assert.deepEqual(parameters, [
          f.installationId,
          f.namespaceId,
          f.head.selection.admissionRef,
        ]);
        return result(
          options.absentSnapshot
            ? []
            : [{ record: options.snapshotRecord?.(copy(f.head)) ?? f.head }],
        );
      }
      if (options.gateway) {
        if (statement.startsWith("SELECT") && statement.includes("occ.gateway_startup_operations"))
          return result();
        if (statement.startsWith("SELECT") && statement.includes("occ.gateway_startup_heads"))
          return result([
            {
              installation_id: parameters[0],
              subject_version: parameters[1],
              subject_key: parameters[2],
              namespace_ref: parameters[3],
              agent_ref: parameters[4],
              head_version: 0,
              process_generation: 0,
              latest_operation_ref: null,
              startup_operation_ref: null,
              record_version: 0,
              state: "empty",
            },
          ]);
        if (statement.startsWith("INSERT INTO occ.gateway_startup_"))
          return result([{ inserted: true }]);
        if (statement.startsWith("UPDATE occ.gateway_startup_heads"))
          return result([{ head_version: 1 }]);
      }
      if (
        statement ===
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('workload-profile-capacity:'||$1,0))"
      ) {
        assert.deepEqual(parameters, [f.installationId]);
        return result();
      }
      if (options.deployment || options.gateway) {
        if (statement.includes("FROM occ.namespaces")) return result([{ id: f.namespaceId }]);
        if (statement.includes("FROM occ.agents"))
          return result([{ id: binding[1].agentId, namespace_id: f.namespaceId }]);
        if (statement.includes("pg_advisory_xact_lock_shared")) return result();
        if (statement.includes("SELECT admission_ref FROM occ.workload_profile_admissions"))
          return result([{ admission_ref: f.head.selection.admissionRef }]);
        if (statement.includes("SELECT record FROM occ.workload_profile_admissions"))
          return result([{ record: f.head }]);
        if (statement.includes("FROM occ.agent_revisions")) {
          const spec = {
            configuration_id: request.configurationRef,
            configuration_generation: request.configurationVersion,
            workload_profile_use: copy(retainedUse),
          };
          options.amendStored?.(spec);
          return result([
            {
              id: request.revisionId,
              namespace_id: f.namespaceId,
              agent_id: request.agentId,
              admitted_spec: spec,
            },
          ]);
        }
      }
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
  const selection = new DriverSelection(),
    driver = new NativeIAMDriver(state);
  selection.registerDriver(driver);
  selection.selectDriver("iam", driver.id);
  const invocation = Object.freeze({ controlledInvocation: true });
  const account = {
    async consume(actual, request, unit) {
      acquisitions++;
      assert.strictEqual(actual, invocation);
      assert.equal(
        request.purpose,
        options.deployment ? "workload-profile-deployment" : "workload-profile-deployment-recovery",
      );
      events.push("account");
      unit.retainSecurityCleanup(() => {
        events.push("security-release");
      });
      if (options.acquisition) await options.acquisition();
      return {
        principal,
        accountRef: f.actor.accountRef,
        requestId: "original/request",
        admissionDecisionId: "original/decision",
        assertCurrent() {
          if (options.current) options.current();
        },
        release() {
          events.push("account-release");
        },
      };
    },
  };
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
  const request = {
    schemaVersion: 2,
    installationId: f.installationId,
    namespaceId: f.namespaceId,
    agentId: binding[1].agentId,
    revisionId: `rev_${randomUUID()}`,
    configurationRef: binding[1].command.expectedDraft.configurationId,
    configurationVersion: 1,
    selection: f.head.selection,
  };
  const retainedUse = {
    schemaVersion: 2,
    installationId: f.installationId,
    namespaceId: f.namespaceId,
    component: "gateway-harness-pair",
    ...f.head.selection,
    canonicalFormat: "oce.workload-profile.canonical-json.v1",
    profileRefs: copy(f.head.profileRefs),
    admittedConfigurationDigest: `sha256:${"c".repeat(64)}`,
  };
  const { enrollment } = state.workloadProfileMutationEnrollmentV2(selection, account);
  const outer = options.deployment ? state.transact.bind(state) : state.read.bind(state);
  const run = () =>
    outer(async (view) => {
      actualView = view;
      if (options.earlyRead) await view.installations.getInstallation();
      const enter = options.deployment ? enrollment.withDeployment : enrollment.withRecovery;
      const work = enter(invocation, binding, async (unit, io) => {
        actualUnit = unit;
        actualIO = io;
        if (options.deployment) assert.strictEqual(unit.platform, view);
        else {
          assert.strictEqual(unit.read, view);
          assert.equal(Object.hasOwn(unit, "platform"), false);
          assert.equal(Object.hasOwn(unit.read.revisions, "createRevision"), false);
        }
        io.assertActive();
        events.push("callback");
        if (options.work)
          return options.work(unit, io, { state, request, retainedUse, head: f.head });
        return "original-result";
      });
      if (options.unawaited) {
        void work.catch(() => {});
        return "callback-returned";
      }
      const result = await work;
      if (options.afterEnrollment) await options.afterEnrollment();
      return result;
    });
  return {
    ...f,
    state,
    run,
    async runGateway() {
      const subject = {
        kind: "agent-gateway",
        installationId: f.installationId,
        namespaceRef: f.namespaceId,
        agentRef: binding[1].agentId,
      };
      let allocations = 0;
      const lease = () => ({
        assertCurrent() {},
        async release() {
          events.push("gateway-lease-release");
        },
      });
      const source = {
        driverSelection: selection,
        authority: {
          async consume(_invocation, _command, bounds, unit, io, policy) {
            events.push("account");
            await policy.lockPolicy();
            assert.equal(
              (
                await policy.iam.lookupIdentity({
                  issuer: principal.issuer,
                  subject: principal.subject,
                })
              ).id,
              principal.id,
            );
            return {
              ...lease(),
              attribution: {
                actorId: principal.id,
                requestRef: bounds.requestRef,
                decisionRef: "controlled-decision",
              },
            };
          },
        },
        selection: {
          async resolveLocked(_command, _original, unit, io) {
            actualUnit = unit;
            actualIO = io;
            const held = await state.workloadProfileSelectionStorageV2().enroll(request, unit, io);
            try {
              await held.lockNamespace();
              await held.lockAgent();
              const record = await held.readAdmission();
              assert.deepEqual(record.use, retainedUse);
              const { startup, createEffectRef, ...host } = historicalGatewayBinding();
              return {
                assertCurrent() {
                  held.assertCurrent();
                  events.push("gateway-storage-current");
                },
                async release() {
                  await held.release();
                  events.push("gateway-storage-release");
                },
                selected: {
                  ...host,
                  schemaVersion: 2,
                  selection: f.head.selection,
                  profileRefs: f.head.profileRefs,
                  admittedConfigurationDigest: retainedUse.admittedConfigurationDigest,
                  namespaceRef: f.namespaceId,
                  agentRef: binding[1].agentId,
                },
              };
            } catch (error) {
              await held.release();
              throw error;
            }
          },
        },
        process: {
          async requireDisposition(command, _previous, _unit, io) {
            io.assertActive();
            return {
              ...lease(),
              predecessor: {
                kind: "complete-initial",
                disposition: command.predecessorDisposition,
                previousStartup: null,
                processOwner: { recordRef: "controlled-process", recordVersion: 1 },
                settlement: { recordRef: "controlled-settlement", recordVersion: 1 },
              },
            };
          },
          async requireCurrent() {
            return lease();
          },
        },
        audit: {
          async append(_event, _attribution, _unit, io) {
            io.assertActive();
            events.push("gateway-audit");
          },
        },
        allocate(kind) {
          return `${kind}-${++allocations}`;
        },
      };
      const owner = createGatewayStartupOwnerV2(state.bindGatewayStartupOwnersV2(source));
      return owner.execute(
        {
          schemaVersion: 2,
          subject,
          kind: "accept-startup",
          operationRef: "controlled-startup",
          expectedHead: null,
          selectedDefinition: f.head.selection,
          predecessorDisposition: {
            recordRef: "controlled-original-disposition",
            recordVersion: 1,
          },
        },
        {},
        {
          requestRef: "controlled-request",
          signal: new AbortController().signal,
          deadline: new Date(Date.now() + 2500).toISOString(),
        },
      );
    },
    statements,
    events,
    binding,
    request,
    retainedUse,
    enrollment,
    invocation,
    get connects() {
      return connects;
    },
    get acquisitions() {
      return acquisitions;
    },
    get unit() {
      return actualUnit;
    },
    get view() {
      return actualView;
    },
    get io() {
      return actualIO;
    },
  };
}

test("fresh recovery locks use the same original read checkout before data; outward view stays read-only", async () => {
  const f = centralProtocol();
  assert.equal(await f.run(), "original-result");
  assert.equal(f.connects, 1);
  assert.equal(f.statements.filter((item) => item.statement.startsWith("BEGIN")).length, 1);
  const conversion = f.statements.findIndex(
    (item) => item.statement === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE",
  );
  const firstData = f.statements.findIndex((item) =>
    item.statement.includes("FROM occ.installation "),
  );
  assert.ok(conversion >= 0 && conversion < firstData);
  assert.ok(f.events.indexOf("account") < f.events.indexOf("policy"));
  assert.ok(f.events.indexOf("COMMIT") < f.events.indexOf("client-release"));
  assert.ok(f.events.indexOf("client-release") < f.events.indexOf("account-release"));
  assert.ok(f.events.indexOf("account-release") < f.events.indexOf("security-release"));
  assert.throws(() => f.io.assertActive());
  await assert.rejects(f.view.installations.getInstallation());
});

test("ordinary reads retain REPEATABLE READ READ ONLY; late recovery conversion refuses", async () => {
  const ordinary = centralProtocol();
  await ordinary.state.read((view) => view.installations.getInstallation());
  assert.ok(
    ordinary.statements.some((item) => item.statement.includes("REPEATABLE READ READ ONLY")),
  );
  assert.equal(
    ordinary.statements.some((item) => item.statement.includes("READ COMMITTED, READ WRITE")),
    false,
  );
  const late = centralProtocol({ earlyRead: true });
  await assert.rejects(late.run());
  assert.equal(late.acquisitions, 0);
  assert.equal(
    late.statements.some((item) => item.statement.includes("READ COMMITTED, READ WRITE")),
    false,
  );
  assert.equal(late.events.includes("COMMIT"), false);
  assert.ok(late.events.includes("ROLLBACK"));
});

test("ordinary readProfile observes exact scoped data without locks or a read/write upgrade", async () => {
  const f = centralProtocol();
  const observed = await f.state.read((view) =>
    view.workloadProfiles.readProfile(f.namespaceId, f.head.selection.admissionRef),
  );
  assert.deepEqual(observed, f.head);
  assert.equal(f.statements[0].statement, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(
    f.statements.some((x) =>
      /FOR (SHARE|UPDATE)|pg_advisory|READ COMMITTED|READ WRITE/.test(x.statement),
    ),
    false,
  );
  assert.equal(f.events.includes("account"), false);
  assert.equal(Object.hasOwn(observed, "assertCurrent"), false);
  const absent = centralProtocol({ absentSnapshot: true });
  assert.equal(
    await absent.state.read((view) =>
      view.workloadProfiles.readProfile(absent.namespaceId, absent.head.selection.admissionRef),
    ),
    undefined,
  );
});
test("ordinary readProfile refuses misbound retained data without acquiring authority", async () => {
  const f = centralProtocol({
    snapshotRecord(head) {
      head.scope.installationId = `ins_${randomUUID()}`;
      return head;
    },
  });
  await assert.rejects(
    f.state.read((view) =>
      view.workloadProfiles.readProfile(f.namespaceId, f.head.selection.admissionRef),
    ),
  );
  assert.equal(f.events.includes("COMMIT"), false);
  assert.equal(
    f.statements.some((x) => /FOR (SHARE|UPDATE)|pg_advisory|READ WRITE/.test(x.statement)),
    false,
  );
});

test("unawaited original enrollment is joined before COMMIT and retains account cleanup", async () => {
  const acquired = deferred(),
    entered = deferred();
  const f = centralProtocol({
    unawaited: true,
    acquisition: async () => {
      entered.resolve();
      await acquired.promise;
    },
  });
  const result = f.run();
  await entered.promise;
  assert.equal(f.events.includes("COMMIT"), false);
  assert.equal(f.events.includes("security-release"), false);
  acquired.resolve();
  assert.equal(await result, "callback-returned");
  assert.ok(f.events.indexOf("callback") < f.events.indexOf("COMMIT"));
  assert.equal(f.events.filter((value) => value === "security-release").length, 1);
});

test("copied selected unit cannot enroll original storage and missing account stays unavailable", async () => {
  const f = centralProtocol();
  await f.run();
  const storage = f.state.workloadProfileSelectionStorageV2();
  await assert.rejects(
    storage.enroll(
      {
        schemaVersion: 2,
        installationId: f.installationId,
        namespaceId: f.namespaceId,
        agentId: f.binding[1].agentId,
        revisionId: `rev_${randomUUID()}`,
        configurationRef: f.binding[1].command.expectedDraft.configurationId,
        configurationVersion: 1,
        selection: f.head.selection,
      },
      { ...f.unit },
      f.io,
    ),
  );
  const empty = f.state.workloadProfileMutationEnrollmentV2(new DriverSelection());
  await assert.rejects(
    f.state.transact(() =>
      empty.enrollment.withDraft(
        f.invocation,
        [
          f.binding[0],
          {
            namespaceId: f.namespaceId,
            agentId: f.binding[1].agentId,
            configurationId: f.binding[1].command.expectedDraft.configurationId,
          },
        ],
        async () => {
          throw new Error("must not reach callback");
        },
      ),
    ),
  );
});

test("actual deployment storage retains immutable revision Use and a fence after acquisition IO closes", async () => {
  let expiredIOFences = 0,
    held,
    acquiredIO;
  const f = centralProtocol({
    deployment: true,
    afterEnrollment() {
      assert.throws(() => acquiredIO.assertActive());
      held.assertCurrent();
      expiredIOFences++;
    },
    async work(unit, io, { state, request, retainedUse, head }) {
      acquiredIO = io;
      held = await state.workloadProfileSelectionStorageV2().enroll(request, unit, io);
      let record;
      try {
        await held.lockNamespace();
        await held.lockAgent();
        record = await held.readAdmission();
      } catch (error) {
        await held.release();
        throw error;
      }
      unit.retain(held);
      assert.deepEqual(record.use, retainedUse);
      assert.deepEqual(record.revision.workloadProfileUse, retainedUse);
      assert.equal(record.configuration.ref, request.configurationRef);
      assert.equal(record.configuration.version, request.configurationVersion);
      assert.equal(
        record.configuration.admittedConfigurationDigest,
        retainedUse.admittedConfigurationDigest,
      );
      assert.equal(record.canonicalManifest, head.canonicalManifest);
      assert.equal(Object.hasOwn(record, "workloadProfileSelection"), false);
      return "selected-record";
    },
  });
  assert.equal(await f.run(), "selected-record");
  assert.ok(expiredIOFences > 0, "retained fences must run after short acquisition closes");
  assert.throws(() => acquiredIO.assertActive());
  assert.throws(() => held.assertCurrent());
  const namespace = f.statements.findIndex((x) => x.statement.includes("FROM occ.namespaces"));
  const agent = f.statements.findIndex((x) => x.statement.includes("FROM occ.agents"));
  const head = f.statements.findIndex((x) =>
    x.statement.includes("SELECT admission_ref FROM occ.workload_profile_admissions"),
  );
  const revision = f.statements.findIndex((x) => x.statement.includes("FROM occ.agent_revisions"));
  assert.ok(namespace < agent && agent < head && head < revision);
  assert.equal(f.statements[revision].statement.includes("workload_profile_selection"), false);
  assert.equal(f.events.filter((x) => x === "COMMIT").length, 1);
});
for (const bad of ["missing-use", "configuration-version", "admission-version"]) {
  test(`actual selected storage poisons caught ${bad} correspondence failure`, async () => {
    const f = centralProtocol({
      deployment: true,
      amendStored(spec) {
        if (bad === "missing-use") delete spec.workload_profile_use;
        if (bad === "configuration-version") spec.configuration_generation++;
        if (bad === "admission-version") spec.workload_profile_use.admissionVersion++;
      },
      async work(unit, io, { state, request }) {
        const held = await state.workloadProfileSelectionStorageV2().enroll(request, unit, io);
        try {
          await held.lockNamespace();
          await held.lockAgent();
          await assert.rejects(held.readAdmission());
        } finally {
          await held.release();
        }
      },
    });
    await assert.rejects(f.run());
    assert.equal(f.events.includes("COMMIT"), false);
    assert.equal(f.events.filter((x) => x === "account-release").length, 1);
  });
}

test("actual Gateway storage lease survives the original resolver clearing its acquisition IO slot", async () => {
  const f = centralProtocol({ gateway: true });
  const output = await f.runGateway();
  assert.equal(
    output.kind,
    "accepted",
    JSON.stringify({ output, events: f.events, statements: f.statements }),
  );
  assert.ok(f.events.filter((x) => x === "gateway-storage-current").length > 1);
  assert.equal(f.events.filter((x) => x === "gateway-storage-release").length, 1);
  assert.equal(f.events.filter((x) => x === "COMMIT").length, 1);
  assert.ok(f.events.indexOf("COMMIT") < f.events.indexOf("gateway-storage-release"));
  assert.throws(() => f.io.assertActive());
});

test("canonical admission tables retain original parent objects and history/outbox correspondence", async () => {
  const { createRequire } = await import("node:module");
  const { getTableConfig } = createRequire(
    new URL("../../packages/occ/package.json", import.meta.url),
  )("drizzle-orm/pg-core");
  const schema = await import("../../packages/occ/src/state/postgres-schema.ts");
  const head = getTableConfig(schema.workloadProfileAdmissions),
    history = getTableConfig(schema.workloadProfileAdmissionHistory),
    outbox = getTableConfig(schema.workloadProfileInvalidations);
  assert.equal(head.schema, "occ");
  assert.equal(head.name, "workload_profile_admissions");
  assert.deepEqual(
    head.primaryKeys[0].columns.map((column) => column.name),
    ["installation_id", "admission_ref"],
  );
  assert.deepEqual(
    head.foreignKeys.map((key) => key.reference().foreignTable),
    [schema.installation, schema.namespaces],
  );
  assert.deepEqual(
    history.primaryKeys[0].columns.map((column) => column.name),
    ["installation_id", "admission_ref", "admission_version"],
  );
  assert.strictEqual(
    history.foreignKeys[0].reference().foreignTable,
    schema.workloadProfileAdmissions,
  );
  assert.deepEqual(
    outbox.foreignKeys.map((key) => key.reference().foreignTable),
    [schema.workloadProfileAdmissions, schema.workloadProfileAdmissionHistory],
  );
  assert.ok(
    history.indexes.some(
      (index) =>
        index.config.name === "workload_profile_primary_command" &&
        index.config.unique &&
        index.config.where,
    ),
  );
  assert.ok(head.checks.some((check) => check.name === "workload_profile_admissions_record"));
  assert.ok(history.checks.some((check) => check.name === "workload_profile_history_record"));
  assert.ok(outbox.checks.some((check) => check.name === "workload_profile_invalidation_record"));
  assert.equal(
    head.columns.some((column) => /configuration|digest_h/.test(column.name)),
    false,
  );
});
