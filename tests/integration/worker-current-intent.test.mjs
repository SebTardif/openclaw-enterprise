import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
  claim,
  deferred,
  WorkClaimLostError,
} from "../fixtures/worker-lease-cancellation/controlled-queue.mjs";

// Use the installed worker owners. Narrow their OCC value import to its actual
// canonical queue module, as in the existing cancellation fixture. No source or
// decision is replaced; this interval does not qualify the full OCC barrel.
const workerRoot = new URL("../../apps/controller/src/worker/", import.meta.url);
const workerFiles = [
  "leased-effect",
  "revision-currentness",
  "revisions",
  "finalization",
  "runner",
];
const originals = new Set(workerFiles.map((name) => new URL(`${name}.ts`, workerRoot).href));
const canonicalQueue = new URL(
  "../../packages/occ/src/state/postgres-work-queue.ts",
  import.meta.url,
);
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (originals.has(context.parentURL) && specifier === "@openclaw-enterprise/occ")
      return nextResolve(canonicalQueue.href, context);
    return nextResolve(specifier, context);
  },
});
let LeasedEffects, WorkerRevisionCurrentness, WorkerRevisionCurrentnessLostError;
let RevisionReconciler,
  WorkerFinalization,
  WorkerRevisionCleanup,
  WorkerRunner,
  validRevisionObservation;
try {
  ({ LeasedEffects } = await import(new URL("leased-effect.ts", workerRoot)));
  ({ WorkerRevisionCurrentness, WorkerRevisionCurrentnessLostError } = await import(
    new URL("revision-currentness.ts", workerRoot)
  ));
  ({ RevisionReconciler } = await import(new URL("revisions.ts", workerRoot)));
  ({ WorkerFinalization } = await import(new URL("finalization.ts", workerRoot)));
  ({ WorkerRevisionCleanup } = await import(new URL("cleanup.ts", workerRoot)));
  ({ WorkerRunner } = await import(new URL("runner.ts", workerRoot)));
  ({ validRevisionObservation } = await import(new URL("revision-inputs.ts", workerRoot)));
} finally {
  hook.deregister();
}

// These peers supply repository records, queue replies and Driver observations;
// actual installed currentness/reconciliation/effect/cleanup/finalization classes
// make every decision. The transaction marker observes callback boundaries only:
// it is not a database, lock emulator, IAM grant or provider fencing proof.
function installed({
  legacy = false,
  active = false,
  mode = "production",
  activationOrder = "afterCommit",
  agentId,
} = {}) {
  const controller = new AbortController();
  const work = claim();
  if (agentId !== undefined) work.agentId = agentId;
  if (legacy) {
    delete work.runtimeTransitionRef;
    delete work.lifecycleGeneration;
  }
  const execution = { claim: work, signal: controller.signal };
  const installation = {
    id: "ins_current-worker",
    name: "controlled",
    createdAt: work.createdAt.toISOString(),
  };
  const namespace = { id: work.namespaceId, status: "ready" };
  const revision = {
    id: work.revisionId,
    namespaceId: work.namespaceId,
    agentId: work.agentId,
    revision: 2,
    servicePrincipalId: "principal/revision",
    providerId: null,
    harness: { id: "harness/current", mode: "dedicated", version: "1" },
    compute: { id: "compute/current", implementation: "controlled" },
  };
  const agent = {
    id: work.agentId,
    namespaceId: work.namespaceId,
    servicePrincipalId: revision.servicePrincipalId,
    ...(active ? { activeRevisionId: revision.id } : {}),
  };
  const original = legacy
    ? undefined
    : {
        installationId: installation.id,
        namespaceId: work.namespaceId,
        agentId: work.agentId,
        revisionId: work.revisionId,
        transitionRef: work.runtimeTransitionRef,
        generation: work.lifecycleGeneration,
        desiredMode: "running",
        actorId: work.actorId,
        requestId: "request/original",
        createdAt: work.createdAt.toISOString(),
      };
  let head = original;
  let admission =
    original === undefined
      ? undefined
      : {
          namespaceId: work.namespaceId,
          agentId: work.agentId,
          revisionId: work.revisionId,
          runtimeTransitionRef: original.transitionRef,
          lifecycleGeneration: original.generation,
          auditEventId: "aud_original",
        };
  let historical = original;
  const calls = [],
    events = [],
    reads = [],
    audits = [];
  let inTransaction = false,
    transaction = 0,
    operationSignal;
  const controls = {};
  const scopeMatches = (scope) =>
    assert.deepEqual(scope, { namespaceId: work.namespaceId, agentId: work.agentId });
  const view = {
    namespaces: {
      async findNamespace(id) {
        assert.equal(id, namespace.id);
        return namespace;
      },
      async lockNamespace(id) {
        assert.ok(inTransaction);
        assert.equal(id, namespace.id);
        calls.push("lockNamespace");
        return namespace;
      },
    },
    agents: {
      async findAgent(ns, id) {
        assert.equal(ns, namespace.id);
        assert.equal(id, agent.id);
        return agent;
      },
      async lockAgent(ns, id) {
        assert.ok(inTransaction);
        assert.equal(ns, namespace.id);
        assert.equal(id, agent.id);
        calls.push("lockAgent");
        return agent;
      },
      async compareAndSetActiveRevision(ns, id, expected, next) {
        assert.ok(inTransaction);
        assert.equal(ns, namespace.id);
        assert.equal(id, agent.id);
        assert.equal(expected, agent.activeRevisionId);
        assert.equal(next, revision.id);
        calls.push("activateCAS");
        agent.activeRevisionId = next;
        return agent;
      },
    },
    revisions: {
      async findRevision(ns, id, ref) {
        assert.equal(ns, namespace.id);
        assert.equal(id, agent.id);
        assert.equal(ref, revision.id);
        return revision;
      },
    },
    runtimeAdmissions: {
      async findRevisionAdmission(scope, id) {
        scopeMatches(scope);
        assert.equal(id, revision.id);
        calls.push("admission");
        return admission;
      },
    },
    runtimeAssignments: {
      async findRuntimeIntent(scope, ref) {
        scopeMatches(scope);
        assert.equal(ref, admission.runtimeTransitionRef);
        calls.push("original");
        return historical;
      },
      async findRuntimeIntentHead(scope) {
        scopeMatches(scope);
        calls.push("head");
        await controls.headRead?.();
        return head;
      },
    },
    audit: {
      async append(event) {
        assert.ok(inTransaction);
        calls.push("audit");
        audits.push(event);
      },
    },
  };
  const queue = {
    async heartbeat(received) {
      assert.equal(received, work);
      calls.push("heartbeat");
      return controls.heartbeat === undefined ? work : controls.heartbeat(received);
    },
  };
  for (const method of ["complete", "retry", "defer", "fail", "enqueue"])
    queue[method] = async () => {
      assert.ok(inTransaction);
      calls.push(method);
    };
  const read = async (action, options) => {
    assert.equal(
      inTransaction,
      false,
      "fresh effect reads cannot borrow finalization's transaction",
    );
    reads.push(options);
    if (options !== undefined) {
      assert.equal(options.signal, controller.signal);
      assert.equal(options.timeoutMs, 3000);
    }
    if (controls.read !== undefined) await controls.read(options);
    return action(view);
  };
  const currentness = new WorkerRevisionCurrentness(read, installation.id, execution);
  const effects = new LeasedEffects({
    queue,
    leaseDurationMs: 30,
    async withAbortSignal(signal, effect) {
      assert.equal(inTransaction, false);
      operationSignal = signal;
      return effect();
    },
  });
  const observation = {
    namespaceId: namespace.id,
    agentId: agent.id,
    revisionId: revision.id,
    ready: true,
  };
  const compute = {
    ...revision.compute,
    activationOrder,
    async bindAgent() {
      assert.equal(inTransaction, false);
      calls.push("bind");
      await controls.bind?.();
    },
    async prepareRevision(received) {
      assert.equal(inTransaction, false);
      assert.equal(received, revision);
      calls.push("prepare");
      await controls.prepare?.();
      return observation;
    },
    async activateRevision(received) {
      assert.equal(inTransaction, false);
      assert.equal(received, revision);
      calls.push("activate");
      await controls.activate?.();
    },
    async deactivateRevision(received) {
      assert.equal(inTransaction, false);
      assert.equal(received, revision);
      calls.push("deactivate");
      await controls.deactivate?.();
    },
    async retireRevision(received) {
      assert.equal(inTransaction, false);
      calls.push("retire");
      await controls.retire?.(received);
    },
  };
  const cleanup = new WorkerRevisionCleanup({
    compute,
    effects,
    mode,
    maintenanceIntervalMs: 1000,
    listRevisions: async () => [revision],
    validObservation: validRevisionObservation,
  });
  const finalization = new WorkerFinalization({
    async transact(action) {
      assert.equal(inTransaction, false);
      const number = ++transaction;
      inTransaction = true;
      try {
        const result = await action(view, queue);
        calls.push(`commit:${number}`);
        return result;
      } catch (error) {
        calls.push(`rollback:${number}`);
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    readCurrentness: read,
    installation: () => installation,
    iamDriverId: "native-iam",
    computeDriverId: compute.id,
    convergenceTimeoutMs: 60_000,
    maxAttempts: 5,
    maintenanceIntervalMs: 1000,
    cleanup,
    emit: (event) => events.push(event),
  });
  const reconciler = new RevisionReconciler({
    read,
    installation: () => installation,
    compute,
    mode,
    resolveApprovedHarness: () => revision.harness,
    inputs: {
      async authorizeRevision() {
        calls.push("authorize");
        await controls.authorize?.();
        return undefined;
      },
      async resolveRevisionProvider() {
        return undefined;
      },
      async resolveRevisionSecretContext() {
        return { context: {} };
      },
    },
    effects,
    cleanup,
    finalization,
  });
  return {
    controller,
    work,
    execution,
    original,
    revision,
    agent,
    namespace,
    calls,
    events,
    reads,
    audits,
    controls,
    read,
    view,
    currentness,
    effects,
    reconciler,
    finalization,
    signal: () => operationSignal,
    replaceHead(value) {
      head = value;
    },
    removeAdmission() {
      admission = undefined;
    },
    removeOriginal() {
      historical = undefined;
    },
  };
}

function noSuccess(fixture) {
  assert.equal(fixture.calls.includes("complete"), false);
  assert.equal(fixture.calls.includes("enqueue"), false);
  assert.deepEqual(fixture.audits, []);
  assert.deepEqual(fixture.events, []);
}

test("installed runner composes admitted prepare, staged activation, final audit and queue completion", async () => {
  const f = installed();
  let stopped = false;
  const runnerEvents = [];
  const runner = new WorkerRunner({
    queue: { recoverStale: async () => {}, claim: async () => f.work, pending: async () => 0 },
    signal: f.controller.signal,
    stopping: () => stopped,
    pollIntervalMs: 1,
    async dispatch(execution) {
      await f.reconciler.reconcile(execution);
      stopped = true;
    },
    emit: (event) => runnerEvents.push(event),
  });
  await runner.run();
  const effects = f.calls.filter((call) =>
    [
      "bind",
      "prepare",
      "deactivate",
      "activateCAS",
      "commit:1",
      "activate",
      "audit",
      "complete",
      "enqueue",
      "commit:2",
    ].includes(call),
  );
  assert.deepEqual(effects, [
    "bind",
    "prepare",
    "deactivate",
    "activateCAS",
    "commit:1",
    "activate",
    "audit",
    "complete",
    "enqueue",
    "commit:2",
  ]);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].outcome, "success");
  assert.equal(runnerEvents[0].event, "worker.health");
  assert.ok(
    f.reads.filter(Boolean).length > 5,
    "currentness is freshly read across the installed waits",
  );
  for (const start of f.calls.flatMap((call, index) => (call === "lockNamespace" ? [index] : [])))
    assert.deepEqual(f.calls.slice(start, start + 6), [
      "lockNamespace",
      "lockAgent",
      "heartbeat",
      "admission",
      "original",
      "head",
    ]);
});

test("development staged Compute activates only after publication through the installed worker owners", async () => {
  // SSH provides staged activation in development. The worker must call it after
  // the active-revision transaction, with the same currentness and lease guards.
  const f = installed({ mode: "development" });
  await f.reconciler.reconcile(f.execution);
  const effects = f.calls.filter((call) =>
    ["prepare", "deactivate", "activateCAS", "commit:1", "activate", "complete"].includes(call),
  );
  assert.deepEqual(effects, ["prepare", "activateCAS", "commit:1", "activate", "complete"]);
  assert.equal(f.events[0].outcome, "success");
});

test("development published-revision replay repairs staged activation without republishing", async () => {
  // A lost response after publication leaves the selected Driver responsible
  // for idempotently activating the already-published immutable revision.
  const f = installed({ mode: "development", active: true });
  await f.reconciler.reconcile(f.execution);
  assert.equal(f.calls.filter((call) => call === "activate").length, 1);
  assert.ok(f.calls.indexOf("prepare") < f.calls.indexOf("activate"));
  assert.ok(f.calls.indexOf("activate") < f.calls.indexOf("complete"));
  assert.equal(f.calls.includes("activateCAS"), false);
});

for (const desiredMode of ["disabled", "stopped", "running"]) {
  test(`an original running intent cannot act after a ${desiredMode} successor for the same revision`, async () => {
    const f = installed();
    f.replaceHead({ ...f.original, generation: 2, transitionRef: "successor", desiredMode });
    await assert.rejects(f.reconciler.reconcile(f.execution), WorkerRevisionCurrentnessLostError);
    assert.equal(f.calls.includes("bind"), false);
    assert.equal(f.calls.includes("prepare"), false);
    noSuccess(f);
  });
}

for (const absent of ["admission", "original", "head"]) {
  test(`admitted work refuses a missing ${absent} through the actual currentness reader`, async () => {
    const f = installed();
    if (absent === "admission") f.removeAdmission();
    if (absent === "original") f.removeOriginal();
    if (absent === "head") f.replaceHead(undefined);
    await assert.rejects(f.currentness.assertCurrent(), WorkerRevisionCurrentnessLostError);
    noSuccess(f);
  });
}

test("legacy work requires both original admission and current lineage absence", async () => {
  const f = installed({ legacy: true });
  await f.reconciler.reconcile(f.execution);
  assert.equal(f.events[0].outcome, "success");
  const stale = installed({ legacy: true });
  stale.replaceHead({ desiredMode: "running", generation: 1, revisionId: stale.revision.id });
  await assert.rejects(
    stale.reconciler.reconcile(stale.execution),
    WorkerRevisionCurrentnessLostError,
  );
  assert.equal(stale.calls.includes("prepare"), false);
  noSuccess(stale);
});

for (const activationOrder of ["beforeCommit", "afterCommit"]) {
  test(`${activationOrder} refuses the nested stage when preparation returns after a head change`, async () => {
    const f = installed({ activationOrder });
    f.controls.prepare = async () =>
      f.replaceHead({ ...f.original, desiredMode: "stopped", generation: 2 });
    await assert.rejects(f.reconciler.reconcile(f.execution), WorkerRevisionCurrentnessLostError);
    assert.equal(f.calls.includes("activate"), false);
    assert.equal(f.calls.includes("deactivate"), false);
    noSuccess(f);
  });
}

for (const activationOrder of ["beforeCommit", "afterCommit"]) {
  test(
    `${activationOrder} suppresses the nested stage after periodic claim loss even if preparation ignores abort`,
    { timeout: 2000 },
    async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const f = installed({ activationOrder });
      const entered = deferred(),
        finish = deferred();
      f.controls.prepare = async () => {
        entered.resolve();
        await finish.promise;
      };
      const running = f.reconciler.reconcile(f.execution);
      let exact;
      const rejected = assert.rejects(running, (error) => {
        exact = error;
        return error instanceof WorkClaimLostError;
      });
      await entered.promise;
      f.controls.heartbeat = async () => undefined;
      t.mock.timers.tick(10);
      await setImmediate();
      const first = f.signal().reason;
      assert.ok(first instanceof WorkClaimLostError);
      finish.resolve();
      await rejected;
      assert.equal(exact, first);
      assert.equal(f.calls.includes("activate"), false);
      assert.equal(f.calls.includes("deactivate"), false);
      noSuccess(f);
    },
  );
}

test(
  "a periodic head change aborts and joins a late provider before any success",
  { timeout: 2000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const f = installed();
    const entered = deferred(),
      finish = deferred();
    f.controls.bind = async () => {
      entered.resolve();
      await finish.promise;
    };
    const rejected = assert.rejects(
      f.reconciler.reconcile(f.execution),
      WorkerRevisionCurrentnessLostError,
    );
    await entered.promise;
    f.replaceHead({ ...f.original, generation: 2 });
    t.mock.timers.tick(10);
    await setImmediate();
    assert.ok(f.signal().reason instanceof WorkerRevisionCurrentnessLostError);
    assert.equal(f.calls.includes("prepare"), false);
    finish.resolve();
    await rejected;
    noSuccess(f);
  },
);

test("head change during initial heartbeat suppresses the first running effect", async () => {
  const f = installed();
  f.controls.heartbeat = async () => {
    f.replaceHead({ ...f.original, generation: 2 });
    return f.work;
  };
  await assert.rejects(f.reconciler.reconcile(f.execution), WorkerRevisionCurrentnessLostError);
  assert.equal(f.calls.includes("bind"), false);
  noSuccess(f);
});

test("post-commit activation failure cannot produce a second completion after a changed head", async () => {
  const f = installed();
  f.controls.activate = async () =>
    f.replaceHead({ ...f.original, desiredMode: "disabled", generation: 2 });
  await assert.rejects(f.reconciler.reconcile(f.execution), WorkerRevisionCurrentnessLostError);
  assert.ok(f.calls.includes("commit:1"));
  assert.equal(f.calls.includes("commit:2"), false);
  assert.equal(f.calls.filter((call) => call === "activate").length, 1);
  noSuccess(f);
});

for (const mode of ["development", "production"]) {
  test(`${mode} maintenance observes a stopped head before reprepare, activation or enqueue`, async () => {
    const f = installed({ active: true, mode });
    f.work.idempotencyKey = `agent_revision:${f.revision.id}:maintenance:1`;
    f.replaceHead({ ...f.original, desiredMode: "stopped", generation: 2 });
    await assert.rejects(f.reconciler.reconcile(f.execution), WorkerRevisionCurrentnessLostError);
    assert.equal(f.calls.includes("prepare"), false);
    assert.equal(f.calls.includes("activate"), false);
    noSuccess(f);
  });
}

test("cancellation during a rejecting currentness read retains claim-loss classification", async () => {
  const f = installed();
  const dependency = new Error("read interrupted");
  f.controls.read = async (options) => {
    if (options !== undefined) {
      f.controller.abort();
      throw dependency;
    }
  };
  await assert.rejects(f.reconciler.reconcile(f.execution), WorkClaimLostError);
  assert.equal(f.calls.includes("retry"), false);
  noSuccess(f);
  const live = installed();
  live.controls.read = async () => {
    throw dependency;
  };
  await assert.rejects(live.currentness.assertCurrent(), (error) => error === dependency);
});

test("one Agent's changed lineage does not poison an independent current execution", async () => {
  const stale = installed(),
    current = installed({ agentId: "agt_00000000-0000-4000-8000-000000000012" });
  stale.replaceHead({ ...stale.original, generation: 2 });
  await assert.rejects(
    stale.reconciler.reconcile(stale.execution),
    WorkerRevisionCurrentnessLostError,
  );
  await current.reconciler.reconcile(current.execution);
  noSuccess(stale);
  assert.equal(current.events[0].outcome, "success");
});

test("actual queue transaction entry selects READ COMMITTED and joins original unit/queue lifetime", async () => {
  // This controlled transport observes SQL dispatch and the real transaction
  // callback/lifetime; it does not claim PostgreSQL snapshot or concurrency proof.
  const { PostgresPlatformState } = await import("../../packages/occ/src/state/postgres-state.ts");
  const statements = [];
  let released = false,
    checkouts = 0,
    retainedUnit,
    retainedQueue;
  const client = {
    async query(text) {
      assert.equal(released, false);
      statements.push(text);
      if (text.startsWith("SELECT count(*)::integer AS count"))
        return { rows: [{ count: 0 }], rowCount: 1 };
      if (text === "SELECT id, name, created_at FROM occ.installation ORDER BY id LIMIT 2")
        return { rows: [], rowCount: 0 };
      if (["BEGIN ISOLATION LEVEL READ COMMITTED", "COMMIT", "ROLLBACK"].includes(text))
        return { rows: [], rowCount: null, command: text.split(" ")[0] };
      throw new Error(`Unexpected controlled transaction statement: ${text}`);
    },
    release() {
      assert.equal(released, false);
      released = true;
    },
  };
  const state = new PostgresPlatformState({
    async connect() {
      checkouts++;
      return client;
    },
  });
  const value = await state.transactWithQueue(async (unit, queue) => {
    retainedUnit = unit;
    retainedQueue = queue;
    assert.equal(statements[0], "BEGIN ISOLATION LEVEL READ COMMITTED");
    assert.equal(await unit.installations.getInstallation(), undefined);
    assert.equal(await queue.pending(), 0);
    return "original callback result";
  });
  assert.equal(value, "original callback result");
  assert.equal(checkouts, 1);
  assert.equal(released, true);
  assert.equal(statements.at(-1), "COMMIT");
  const count = statements.length;
  await assert.rejects(retainedQueue.pending());
  await assert.rejects(retainedUnit.installations.getInstallation());
  assert.equal(
    statements.length,
    count,
    "closed original participants cannot query a released client",
  );
});

test("bounded read entry refuses an unbounded pool and uses the original bounded checkout", async () => {
  const { PostgresPlatformState } = await import("../../packages/occ/src/state/postgres-state.ts");
  const options = { signal: new AbortController().signal, timeoutMs: 3000 };
  let connections = 0,
    releases = 0;
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (
        sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" ||
        sql === "SET LOCAL client_connection_check_interval = '100ms'" ||
        sql === "COMMIT"
      )
        return { rows: [], rowCount: null, command: sql.split(" ")[0] };
      if (
        sql.startsWith("SELECT set_config(") ||
        sql === "SELECT id, name, created_at FROM occ.installation ORDER BY id LIMIT 2"
      )
        return { rows: [], rowCount: 0 };
      throw new Error("Unexpected controlled bounded-read statement.");
    },
    release() {
      releases++;
    },
  };
  const pool = {
    async connect() {
      connections++;
      return client;
    },
  };
  await assert.rejects(
    new PostgresPlatformState(pool).read((view) => view.installations.getInstallation(), options),
  );
  assert.equal(connections, 0);
  const bounded = new PostgresPlatformState({ ...pool, options: { connectionTimeoutMillis: 250 } });
  assert.equal(
    await bounded.read((view) => view.installations.getInstallation(), options),
    undefined,
  );
  assert.equal(connections, 1);
  assert.equal(releases, 1);
  assert.equal(statements[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(statements.at(-1), "COMMIT");
});
