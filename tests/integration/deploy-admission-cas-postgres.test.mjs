import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  DependencyUnavailableError,
  OpenClawController,
  PostgresCommitOutcomeUnknownError,
  PostgresPlatformState,
  PostgresWorkQueue,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";
import { createRuntimeAdmissionContext } from "../fixtures/runtime-admission-context.mjs";
import { createTestAuthPrincipal } from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  cleanupNamespaces,
  ensureInstallation,
  waitFor,
} from "../helpers/postgres-provider-state.mjs";

// This suite proves direct controller CAS and repository races with real PostgreSQL
// and Native IAM. It does not expose a generation-bearing HTTP route or exercise
// lifecycle-management entitlement, disable/stop handlers, or live provider effects.
const databaseUrl = process.env.OCC_DEPLOY_CAS_TEST_DATABASE_URL;
const options = {
  skip: databaseUrl
    ? false
    : "Set OCC_DEPLOY_CAS_TEST_DATABASE_URL for dedicated PostgreSQL CAS coverage.",
  timeout: 180_000,
};
if (databaseUrl) {
  const target = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t, { withSecret = false } = {}) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  let cleanupNamespaceId;
  t.after(async () => {
    try {
      if (cleanupNamespaceId !== undefined) await cleanupNamespaces(pool, [cleanupNamespaceId]);
    } finally {
      await pool.end();
    }
  });
  const state = new PostgresPlatformState(pool);
  const installation = await ensureInstallation(state, "deploy-cas");
  const credentials = await createTestAuthPrincipal({ installationId: installation.id });
  const actor = credentials.seed.principal;
  const roleId = `rol_${randomUUID()}`;
  await state.seedNativeIAM({
    identities: [actor],
    groups: [],
    memberships: [],
    restrictions: [],
    roles: [
      {
        id: roleId,
        permissions: [
          ["create", "namespace"],
          ["create", "configuration"],
          ["read", "configuration"],
          ["update", "configuration"],
          ["create", "agent"],
          ["deploy", "agent"],
          ...(withSecret
            ? [
                ["create", "secret"],
                ["operate", "secret"],
              ]
            : []),
        ].map(([action, resourceKind]) => ({ action, resourceKind })),
      },
    ],
    bindings: [{ id: `bnd_${randomUUID()}`, subjectKind: "identity", subjectId: actor.id, roleId }],
  });
  const durations = [];
  const configuration = createTestConfigurationDriver();
  const compute = createDevelopmentComputeDriver();
  const secretStorage = createTestSecretDriver();
  let failSecretResolution = false;
  const secretDriver = {
    ...secretStorage,
    async resolve(secret) {
      const result = await secretStorage.resolve(secret);
      // Inject only a failure after genuine passive storage resolution; the
      // controller and Native IAM still decide admission and exact permissions.
      if (failSecretResolution) throw new Error("INJECTED_SECRET_RESOLUTION_FAILURE");
      return result;
    },
  };
  // Instrumentation delegates every call to its actual selected Driver; no
  // fixture supplies an authorization decision or admission result.
  const timed = (driver) =>
    new Proxy(driver, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return async (...args) => {
          const started = performance.now();
          try {
            return await value.apply(target, args);
          } finally {
            durations.push({
              driver: target.id,
              method: String(property),
              ms: performance.now() - started,
            });
          }
        };
      },
    });
  function controllerFor(store = state) {
    const controller = new OpenClawController(installation, {
      state: store,
      recordOperations: false,
    });
    // Separate normal IAM connections keep COMMIT transport faults scoped to the
    // actual admission transaction rather than permission reads.
    for (const driver of [
      timed(new NativeIAMDriver(state)),
      timed(configuration),
      compute,
      ...(withSecret ? [timed(secretDriver)] : []),
    ]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    return controller;
  }
  const controller = controllerFor();
  const namespace = await controller.createNamespace(actor.id, {
    name: `deploy-cas-${randomUUID()}`,
  });
  cleanupNamespaceId = namespace.id;
  const draft = await controller.createConfiguration(actor.id, {
    namespaceId: namespace.id,
    kind: "agent",
    values: { model: "gpt-test" },
  });
  const agent = await controller.createAgent(actor.id, {
    namespaceId: namespace.id,
    name: "CAS Agent",
    configurationId: draft.id,
  });
  await state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  let secret;
  if (withSecret) {
    secret = await controller.createSecret(actor.id, {
      namespaceId: namespace.id,
      name: "CAS model credential",
      value: "synthetic-cas-test-value",
    });
    await controller.updateConfiguration(actor.id, {
      namespaceId: namespace.id,
      configurationId: draft.id,
      values: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.example.test/v1",
              apiKey: { source: "env", provider: "model", id: "OPENAI_API_KEY" },
            },
          },
        },
        secrets: { providers: { model: { source: "env", allowlist: ["OPENAI_API_KEY"] } } },
      },
      secretBindings: { OPENAI_API_KEY: { source: secret.ref } },
    });
    const serviceRoleId = `rol_${randomUUID()}`;
    // seedNativeIAM provisions a complete identity set; it is not an incremental
    // service grant API. Agent creation already persists its service identity.
    // Seed an exact constrained Role/Binding and let Native IAM evaluate it.
    await state.transact(async (unit) => {
      await state.queryInTransaction(
        unit,
        "INSERT INTO occ.iam_roles (id,namespace_id,permissions) VALUES ($1,$2,$3::jsonb)",
        [
          serviceRoleId,
          namespace.id,
          JSON.stringify([{ action: "operate", resourceKind: "secret" }]),
        ],
      );
      await state.queryInTransaction(
        unit,
        "INSERT INTO occ.iam_access_bindings (id,namespace_id,identity_subject_id,role_id,resource_kind,resource_id) VALUES ($1,$2,$3,$4,'secret',$5)",
        [`bnd_${randomUUID()}`, namespace.id, agent.servicePrincipalId, serviceRoleId, secret.id],
      );
    });
  }
  const scope = { namespaceId: namespace.id, agentId: agent.id };
  const context = (settings) => createRuntimeAdmissionContext(installation.id, actor.id, settings);
  const deploy = (expectedLifecycleGeneration, admission = context(), selected = controller) =>
    selected.deployAgent(
      actor.id,
      { ...scope, expectedLifecycleGeneration },
      resolveApprovedHarness,
      admission,
    );
  const head = () => state.read((view) => view.runtimeAssignments.findRuntimeIntentHead(scope));
  async function snapshot() {
    const result = await pool.query(
      `SELECT
      (SELECT count(*)::int FROM occ.agent_revisions WHERE namespace_id=$1) AS revisions,
      (SELECT count(*)::int FROM occ.agent_runtime_intents WHERE namespace_id=$1) AS intents,
      (SELECT count(*)::int FROM occ.agent_revision_runtime_admissions WHERE namespace_id=$1) AS admissions,
      (SELECT count(*)::int FROM occ.controller_work WHERE namespace_id=$1) AS work,
      (SELECT count(*)::int FROM occ.audit_events WHERE namespace_id=$1 AND action='openclaw.agents.deploy' AND outcome='success') AS audits`,
      [namespace.id],
    );
    return { ...result.rows[0], head: await head() };
  }
  return {
    pool,
    state,
    actor,
    controller,
    controllerFor,
    draft,
    scope,
    context,
    deploy,
    head,
    snapshot,
    durations,
    compute,
    secret,
    setSecretFailure(value) {
      failSecretResolution = value;
    },
  };
}

async function backendPid(f, unit) {
  return (await f.state.queryInTransaction(unit, "SELECT pg_backend_pid() AS pid")).rows[0].pid;
}

// Both callbacks enter real transactions before racing; separate backend PIDs
// establish actual database concurrency rather than single-client sequencing.
async function simultaneous(f, operations) {
  const barrier = deferred();
  const pids = [];
  const outcomes = await Promise.allSettled(
    operations.map((operation) =>
      f.controller.transact(async (unit) => {
        pids.push(await backendPid(f, unit));
        if (pids.length === operations.length) barrier.resolve();
        await barrier.promise;
        return operation(unit);
      }),
    ),
  );
  assert.equal(new Set(pids).size, operations.length);
  return outcomes;
}

// Hold the first transaction's actual owner locks and observe the second backend
// blocked in PostgreSQL before releasing the winner. This proves both lock orders
// without a timing sleep or a fabricated repository result.
async function ordered(f, first, second) {
  const locked = deferred();
  const release = deferred();
  const secondPid = deferred();
  const firstResult = Promise.allSettled([
    f.controller.transact(async (unit) => {
      await unit.namespaces.lockNamespace(f.scope.namespaceId);
      await unit.agents.lockAgent(f.scope.namespaceId, f.scope.agentId);
      locked.resolve(await backendPid(f, unit));
      await release.promise;
      return first(unit);
    }),
  ]);
  const firstPid = await locked.promise;
  const secondResult = Promise.allSettled([
    f.controller.transact(async (unit) => {
      secondPid.resolve(await backendPid(f, unit));
      return second(unit);
    }),
  ]);
  try {
    const pid = await secondPid.promise;
    assert.notEqual(pid, firstPid);
    await waitFor("second CAS transaction blocked by first owner lock", async () => {
      const result = await f.pool.query(
        "SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked",
        [pid, firstPid],
      );
      return result.rows[0].blocked ? true : undefined;
    });
  } finally {
    release.resolve();
  }
  return [(await firstResult)[0], (await secondResult)[0]];
}

function oneWinner(outcomes) {
  assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
  const loser = outcomes.find((value) => value.status === "rejected");
  assert.ok(loser.reason instanceof ResourceConflictError, String(loser.reason));
}

for (const initial of [null, 1]) {
  test(
    `independent PostgreSQL deploys expecting ${initial} admit one exact generation`,
    options,
    async (t) => {
      const f = await fixture(t);
      if (initial !== null) await f.deploy(null);
      const before = await f.snapshot();
      const contexts = [f.context(), f.context()];
      const outcomes = await simultaneous(
        f,
        contexts.map((admission) => () => f.deploy(initial, admission)),
      );
      oneWinner(outcomes);
      const after = await f.snapshot();
      for (const key of ["revisions", "intents", "admissions", "work", "audits"])
        assert.equal(after[key], before[key] + 1);
      assert.equal(after.head.generation, (initial ?? 0) + 1);
      const rejected = contexts[outcomes.findIndex((value) => value.status === "rejected")];
      assert.equal(
        await f.state.read((view) =>
          view.runtimeAssignments.findRuntimeIntent(f.scope, rejected.transitionRef),
        ),
        undefined,
      );
      await assert.rejects(f.deploy(initial), ResourceConflictError);
      assert.deepEqual(await f.snapshot(), after);
    },
  );
}

for (const desiredMode of ["disabled", "stopped"]) {
  for (const firstKind of ["deploy", "repository-transition"]) {
    test(
      `${desiredMode} repository race: ${firstKind} takes the owner lock first`,
      options,
      async (t) => {
        const f = await fixture(t);
        const original = await f.deploy(null);
        const transitionRef = randomUUID();
        const admission = f.context();
        const transition = (unit) =>
          unit.runtimeAssignments.advanceRuntimeIntent(
            f.scope,
            1,
            { desiredMode, revisionId: original.id },
            transitionRef,
            { actorId: f.actor.id, requestId: `repository-race-${randomUUID()}` },
          );
        const deploy = () => f.deploy(1, admission);
        const outcomes = await ordered(
          f,
          ...(firstKind === "deploy" ? [deploy, transition] : [transition, deploy]),
        );
        oneWinner(outcomes);
        assert.equal(outcomes[0].status, "fulfilled");
        const saved = await f.snapshot();
        assert.equal(saved.head.generation, 2);
        assert.equal(saved.head.desiredMode, firstKind === "deploy" ? "running" : desiredMode);
        assert.equal(saved.intents, 2);
        for (const key of ["revisions", "admissions", "work", "audits"])
          assert.equal(saved[key], firstKind === "deploy" ? 2 : 1);
        const loserRef = firstKind === "deploy" ? transitionRef : admission.transitionRef;
        assert.equal(
          await f.state.read((view) =>
            view.runtimeAssignments.findRuntimeIntent(f.scope, loserRef),
          ),
          undefined,
        );
        if (firstKind !== "deploy") {
          // Matching generation still cannot turn deploy into an implicit resume.
          await assert.rejects(f.deploy(2), ResourceConflictError);
          assert.deepEqual(await f.snapshot(), saved);
        }
      },
    );
  }
}

test(
  "CAS admission audit uniqueness failure rolls back revision, intent, head, work, and audit",
  options,
  async (t) => {
    const f = await fixture(t);
    const fixedId = randomUUID();
    const factory = new AuditEventFactory({ idGenerator: () => "aud_" + fixedId });
    await f.deploy(null, f.context({ factory }));
    const before = await f.snapshot();
    const rejected = f.context({ factory });
    await assert.rejects(f.deploy(1, rejected), ResourceConflictError);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(
      await f.state.read((view) =>
        view.runtimeAssignments.findRuntimeIntent(f.scope, rejected.transitionRef),
      ),
      undefined,
    );
  },
);

test(
  "CAS COMMIT acknowledgement loss recovers retained original admission after terminal work and later head",
  options,
  async (t) => {
    const f = await fixture(t);
    const proxy = await runtimeCommitAckProxy(databaseUrl);
    const faultPool = new pg.Pool({
      connectionString: proxy.url,
      max: 1,
      query_timeout: 5000,
      connectionTimeoutMillis: 5000,
    });
    faultPool.on("error", () => {});
    try {
      const controller = f.controllerFor(new PostgresPlatformState(faultPool));
      const admission = f.context();
      proxy.arm();
      await assert.rejects(
        f.deploy(null, admission, controller),
        PostgresCommitOutcomeUnknownError,
      );
      assert.equal(proxy.observedCommit, true);
      const saved = await f.head();
      assert.equal(saved.transitionRef, admission.transitionRef);
      // Claim only this fixture's exact original work; other fixtures retain terminal
      // work and must never supply recovery evidence for this admission.
      const queue = new PostgresWorkQueue(f.pool);
      const claim = await queue.claim();
      assert.equal(claim.namespaceId, f.scope.namespaceId);
      assert.equal(claim.runtimeTransitionRef, admission.transitionRef);
      await queue.fail(claim, { code: "CAS_RECOVERY_TERMINAL" });
      await f.deploy(1);
      const before = await f.snapshot();
      const recovered = await controller.recoverDeployAgent(
        f.actor.id,
        { ...f.scope, expectedLifecycleGeneration: null },
        admission,
      );
      assert.equal(recovered.id, saved.revisionId);
      assert.equal(recovered.revision, 1);
      assert.equal(before.head.generation, 2);
      assert.deepEqual(await f.snapshot(), before);
    } finally {
      await faultPool.end();
      await proxy.close();
    }
  },
);

test(
  "caught invalid CAS after an admitted deploy makes the outer PostgreSQL transaction roll back",
  options,
  async (t) => {
    const f = await fixture(t);
    const before = await f.snapshot();
    await assert.rejects(
      f.controller.transact(async () => {
        await f.deploy(null);
        // The caller may catch validation, but cannot commit the earlier admission
        // from the same failed unit of work.
        await assert.rejects(f.deploy(undefined), ScopeViolationError);
      }),
      ScopeViolationError,
    );
    assert.deepEqual(await f.snapshot(), before);
  },
);

for (const expected of [null, 1]) {
  for (const table of [
    "agent_revisions",
    "agent_runtime_intents",
    "agent_runtime_intent_heads",
    "audit_events",
    "agent_revision_runtime_admissions",
    "controller_work",
  ]) {
    test(
      `CAS ${expected === null ? "initialization" : "advancement"} rolls back after actual ${table} write`,
      options,
      async (t) => {
        const f = await fixture(t);
        if (expected === 1) await f.deploy(null);
        const before = await f.snapshot();
        let injected = false;
        const injectedFailure = new Error(`INJECTED_AFTER_${table}`);
        // This transport adapter delegates every SQL statement to a real pg client.
        // Only after the selected write has actually completed does it throw. It
        // does not fabricate rows, permissions, or repository state. Each snapshot
        // below is independently read from PostgreSQL after rollback.
        const faultPool = {
          async connect() {
            const client = await f.pool.connect();
            return new Proxy(client, {
              get(target, property) {
                if (property === "query")
                  return async (...args) => {
                    const result = await target.query(...args);
                    const write = new RegExp(`^\\s*(?:INSERT INTO|UPDATE) occ\\.${table}\\b`, "i");
                    if (!injected && typeof args[0] === "string" && write.test(args[0])) {
                      injected = true;
                      assert.equal(
                        result.rowCount,
                        1,
                        "the selected real database write completed",
                      );
                      throw injectedFailure;
                    }
                    return result;
                  };
                const value = Reflect.get(target, property);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          },
        };
        const controller = f.controllerFor(new PostgresPlatformState(faultPool));
        const admission = f.context();
        await assert.rejects(
          f.deploy(expected, admission, controller),
          (error) => error === injectedFailure,
        );
        assert.equal(injected, true);
        assert.deepEqual(await f.snapshot(), before);
        assert.equal(
          await f.state.read((view) =>
            view.runtimeAssignments.findRuntimeIntent(f.scope, admission.transitionRef),
          ),
          undefined,
        );
      },
    );
  }
}

test(
  "CAS measures actual passive Secret resolution and admits nothing after its injected failure",
  options,
  async (t) => {
    const f = await fixture(t, { withSecret: true });
    f.durations.length = 0;
    const revision = await f.deploy(null);
    assert.equal(revision.secretDriverId, "secret-test");
    assert.deepEqual(revision.secretBindings.OPENAI_API_KEY, {
      source: f.secret.ref,
      delivery: { type: "env" },
    });
    const successfulResolution = f.durations.find(
      (entry) => entry.driver === "secret-test" && entry.method === "resolve",
    );
    assert.ok(successfulResolution);
    const before = await f.snapshot();
    f.setSecretFailure(true);
    f.durations.length = 0;
    await assert.rejects(f.deploy(1), DependencyUnavailableError);
    assert.deepEqual(await f.snapshot(), before);
    const failedResolution = f.durations.find(
      (entry) => entry.driver === "secret-test" && entry.method === "resolve",
    );
    assert.ok(failedResolution);
    f.setSecretFailure(false);
    const next = await f.deploy(1);
    assert.equal(next.revision, 2);
    t.diagnostic(
      JSON.stringify({
        secretDriver: "test-passive-secret-storage",
        successfulResolution,
        failedResolution,
        limitation:
          "Synthetic Secret stored through real OCC/native IAM and passive storage; delegated resolve failure, not a live Secret provider or latency benchmark.",
      }),
    );
  },
);

test(
  "CAS admission measures local Driver time, transaction time, and full history reads at 20 and 100 revisions",
  options,
  async (t) => {
    const f = await fixture(t);
    for (let count = 0; count < 100; count++) {
      await f.deploy(count === 0 ? null : count);
      if (![20, 100].includes(count + 1)) continue;
      const historyStarted = performance.now();
      const history = await f.state.read((view) =>
        view.revisions.listRevisions(f.scope.namespaceId, f.scope.agentId),
      );
      const historyReadMs = performance.now() - historyStarted;
      assert.equal(history.length, count + 1);
      const started = performance.now();
      f.durations.length = 0;
      let lockMs;
      let callbackMs;
      // An intentionally rolled-back admitted transaction gives a complete measured
      // Driver path at this history size without incrementing the next expectation.
      const rollback = new Error("MEASURED_TRANSACTION_ROLLBACK");
      await assert.rejects(
        f.controller.transact(async (unit) => {
          const callbackStarted = performance.now();
          await unit.namespaces.lockNamespace(f.scope.namespaceId);
          await unit.agents.lockAgent(f.scope.namespaceId, f.scope.agentId);
          lockMs = performance.now() - callbackStarted;
          await f.deploy(count + 1);
          callbackMs = performance.now() - callbackStarted;
          throw rollback;
        }),
        (error) => error === rollback,
      );
      assert.equal((await f.head()).generation, count + 1);
      assert.ok(f.durations.some((entry) => entry.method === "authorize"));
      assert.ok(f.durations.some((entry) => entry.method === "read"));
      assert.ok(f.durations.some((entry) => entry.method === "validate"));
      t.diagnostic(
        JSON.stringify({
          historyCount: history.length,
          historyReadMs,
          measuredTransactionOutcome: "rolled_back",
          wallMs: performance.now() - started,
          lockMs,
          callbackMs,
          driverCalls: f.durations,
          compute: f.compute.implementation,
          limitation:
            "Direct controller/native IAM with test-memory Configuration and local compute selection; no live provider calls. Full revision rows are read. Same-Namespace locks serialize; uncontended lock timing and two sampled history sizes are not fleet limits.",
        }),
      );
    }
  },
);
