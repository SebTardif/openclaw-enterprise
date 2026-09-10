import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  PostgresPlatformState,
  PostgresCommitOutcomeUnknownError,
} from "../../packages/occ/src/state/postgres-state.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { seedPreparation } from "../fixtures/runtime-preparation.mjs";

const reply = (rows = [], command = "SELECT") => ({ rows, rowCount: rows.length, command });
const clone = (value) => structuredClone(value);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// The preparation is retained by real repositories. The marker transport and
// current-use acquisition below are controlled protocol substitutes, not proof
// of PostgreSQL triggers/locks, account authority, capabilities or provider IO.
// Independent response transactions use the actual PostgresPlatformState owner.
async function fixture(hooks = {}) {
  const prepared = await seedPreparation(new InMemoryPlatformState());
  await prepared.append(prepared.plan);
  await prepared.append(prepared.child);
  const preparation = await prepared.record();
  const child = preparation.children[0].child;
  const request = {
    selection: {
      schemaVersion: 2,
      ...prepared.scope,
      revisionId: prepared.revision.id,
      configurationRef: "controlled/configuration",
      configurationVersion: 1,
      selection: { schemaVersion: 1, admissionRef: randomUUID(), admissionVersion: 1 },
    },
    preparationRef: preparation.preparationRef,
    preparationVersion: preparation.localVersion,
    effectRef: child.effect.effectRef,
    guard: child.guard,
  };
  const claim = { idempotencyKey: "controlled/work", claimToken: randomUUID() };
  const abort = new AbortController();
  const bounds = { signal: abort.signal, timeoutMs: 2900 };
  const events = [];
  const durable = { marker: undefined, response: undefined };
  const nativeResponses = new WeakSet();
  let currentUseClosed = false,
    currentUseCount = 0,
    invocationCount = 0,
    responseContext,
    retainedCallback,
    committed;
  const capabilities = {
    async acquire() {
      throw new Error("The controlled current-use fixture never asserts real capability authority");
    },
  };
  function markerRow(snapshot) {
    return snapshot.marker
      ? [
          {
            ...clone(snapshot.marker),
            ...(snapshot.response
              ? {
                  namespace_name: snapshot.response.namespace,
                  deployment_name: snapshot.response.name,
                  deployment_uid: snapshot.response.uid,
                  resource_version: snapshot.response.resourceVersion,
                  received_at: snapshot.response.receivedAt,
                }
              : {}),
          },
        ]
      : [];
  }
  async function dataQuery(snapshot, sql, args = []) {
    if (sql.includes("runtime-preparation-submission:")) {
      assert.deepEqual(args, [request.effectRef]);
      return reply();
    }
    if (sql.startsWith("SELECT s.*")) {
      assert.deepEqual(args, [request.effectRef]);
      return reply(markerRow(snapshot));
    }
    if (sql.startsWith("INSERT INTO occ.runtime_preparation_submissions")) {
      assert.equal(args.length, 10);
      assert.deepEqual(args.slice(2, 8), [
        request.selection.installationId,
        request.selection.namespaceId,
        request.selection.agentId,
        request.selection.revisionId,
        request.preparationRef,
        request.preparationVersion,
      ]);
      assert.deepEqual(args.slice(8), [child.effect.requestDigest, child.providerWire.bytesDigest]);
      assert.equal(args[0], request.effectRef);
      if (snapshot.marker) return reply();
      events.push("marker-insert");
      snapshot.marker = {
        effect_ref: args[0],
        submission_ref: args[1],
        installation_id: args[2],
        namespace_id: args[3],
        agent_id: args[4],
        revision_id: args[5],
        preparation_ref: args[6],
        preparation_version: String(args[7]),
        request_digest: args[8],
        provider_wire_digest: args[9],
        submitted_at: new Date().toISOString(),
      };
      return reply(
        [
          {
            submission_ref: snapshot.marker.submission_ref,
            submitted_at: snapshot.marker.submitted_at,
          },
        ],
        "INSERT",
      );
    }
    if (sql.startsWith("INSERT INTO occ.runtime_preparation_submission_responses")) {
      assert.equal(args.length, 6);
      assert.equal(args[0], request.effectRef);
      events.push("response-insert");
      if (!snapshot.response)
        snapshot.response = {
          namespace: args[1],
          name: args[2],
          uid: args[3],
          resourceVersion: args[4],
          receivedAt: args[5],
        };
      return reply([], "INSERT");
    }
    throw new Error(`Unexpected controlled data query: ${sql}`);
  }
  const pool = {
    options: { connectionTimeoutMillis: 250 },
    async connect() {
      const snapshot = clone(durable);
      const client = new EventEmitter();
      client.release = (destroy) => {
        events.push("response-client-release");
        if (destroy === true) events.push("response-client-destroy");
      };
      client.query = async (sql, args) => {
        if (sql.startsWith("BEGIN") || sql.startsWith("SET LOCAL")) {
          events.push(sql);
          return reply();
        }
        if (
          sql ===
          "SELECT set_config('statement_timeout',$1,true), set_config('transaction_timeout',$1,true), set_config('idle_in_transaction_session_timeout',$1,true)"
        ) {
          assert.equal(args.length, 1);
          assert.match(args[0], /^[1-9][0-9]*ms$/);
          assert.ok(Number(args[0].slice(0, -2)) <= 3000);
          return reply();
        }
        if (sql.includes("FROM occ.installation"))
          return reply([
            {
              id: request.selection.installationId,
              name: "Controlled",
              created_at: new Date().toISOString(),
            },
          ]);
        if (sql === "COMMIT") {
          events.push("response-commit");
          await hooks.beforeResponseCommit?.();
          Object.assign(durable, snapshot);
          if (hooks.responseUnknown) throw new Error("controlled lost acknowledgement");
          return reply([], "COMMIT");
        }
        if (sql === "ROLLBACK") {
          events.push("response-rollback");
          return reply([], "ROLLBACK");
        }
        return dataQuery(snapshot, sql, args);
      };
      return client;
    },
  };
  const state = new PostgresPlatformState(pool);
  state.withRuntimePreparationWorkerCurrentUseV1 = async (
    _selection,
    actualClaim,
    actualRequest,
    actualBounds,
    work,
    actualCapabilities,
  ) => {
    currentUseCount++;
    assert.equal(typeof actualCapabilities.acquire, "function");
    assert.deepEqual(actualClaim, claim);
    assert.deepEqual(actualRequest, request);
    assert.equal(actualBounds.signal, bounds.signal);
    if (currentUseClosed || bounds.signal.aborted) throw new Error("controlled current use closed");
    events.push("current-use");
    const snapshot = clone(durable);
    let active = true;
    const lease = {
      request: clone(request),
      preparation: clone(preparation),
      child: clone(child),
      providerWireUtf8: prepared.providerWireUtf8,
      assertCurrent() {
        assert.equal(active, true);
      },
      retain() {},
      release: async () => {},
    };
    try {
      const value = await work(lease, { query: (sql, args) => dataQuery(snapshot, sql, args) });
      await hooks.beforeMarkerCommit?.();
      if (hooks.markerRejected) throw new Error("controlled definite rollback");
      events.push("marker-commit");
      Object.assign(durable, snapshot);
      if (hooks.markerUnknown) throw new PostgresCommitOutcomeUnknownError();
      return value;
    } finally {
      active = false;
      events.push("marker-terminal");
    }
  };
  const source = {
    async acquire(context, actualCommitted, originalResponse, call) {
      events.push("observation-acquire");
      responseContext = context;
      assert.equal(context.installationId, request.selection.installationId);
      assert.equal(actualCommitted, committed);
      if (!nativeResponses.has(originalResponse))
        throw new Error("controlled native response identity absent");
      assert.equal(call.context, observerContext);
      const lease = {
        assertCurrent() {
          return hooks.current?.(events);
        },
        async prepareCommit() {
          events.push("observation-prepare");
          await hooks.prepare?.(context);
        },
        async release() {
          events.push("observation-release");
          await hooks.release?.(context);
        },
      };
      if (!hooks.skipEarlyRetain) context.retain(lease);
      await hooks.acquire?.(context, lease, state);
      return lease;
    },
  };
  const participant = {
    async invoke(value, retainResponse) {
      invocationCount++;
      events.push("invoke");
      committed = value;
      retainedCallback = retainResponse;
      assert.deepEqual(value.claim, claim);
      assert.deepEqual(value.preparation, preparation);
      assert.equal(value.providerWireUtf8, prepared.providerWireUtf8);
      assert.ok(Object.isFrozen(value));
      assert.equal("unit" in value, false);
      assert.equal("io" in value, false);
      assert.ok(events.indexOf("marker-terminal") < events.indexOf("invoke"));
      await hooks.invoke?.(value, retainResponse);
    },
  };
  const observerContext = Object.freeze({ controlled: "native service observation" });
  const call = () => ({
    context: observerContext,
    signal: new AbortController().signal,
    requestRef: "controlled/response",
    recipientRef: "recipient/occ",
    deadline: new Date(Date.now() + 2900).toISOString(),
  });
  function response(extra = {}) {
    const value = {
      namespace: "controlled-namespace",
      name: child.providerTarget.name,
      uid: child.predicate.kind === "expected-object" ? child.predicate.uid : "controlled-uid",
      resourceVersion: "opaque.01",
      receivedAt: new Date().toISOString(),
      ...extra,
    };
    nativeResponses.add(value);
    return value;
  }
  const owner = state.runtimePreparationSubmissionOwnerV1({}, participant, source, capabilities);
  return {
    state,
    owner,
    request,
    claim,
    bounds,
    events,
    durable,
    hooks,
    source,
    capabilities,
    participant,
    call,
    response,
    run: () => owner.submit(claim, request, bounds),
    closeCurrentUse() {
      currentUseClosed = true;
    },
    get context() {
      return responseContext;
    },
    get committed() {
      return committed;
    },
    get retain() {
      return retainedCallback;
    },
    get invocationCount() {
      return invocationCount;
    },
    get currentUseCount() {
      return currentUseCount;
    },
  };
}

test("new marker invokes only after definite commit and terminal; repeat never invokes", async () => {
  const f = await fixture();
  assert.equal((await f.run()).status, "unknown");
  const marker = clone(f.durable.marker);
  assert.equal((await f.run()).status, "unknown");
  assert.equal(f.invocationCount, 1);
  assert.deepEqual(f.durable.marker, marker);
});
for (const condition of ["markerRejected", "markerUnknown"]) {
  test(`${condition} never enters captured participant`, async () => {
    const f = await fixture({ [condition]: true });
    assert.equal((await f.run()).status, condition === "markerUnknown" ? "unknown" : "unavailable");
    assert.equal(f.invocationCount, 0);
    if (condition === "markerUnknown") {
      f.hooks.markerUnknown = false;
      assert.equal((await f.run()).status, "unknown");
      assert.equal(f.invocationCount, 0);
    } else assert.equal(f.durable.marker, undefined);
  });
}
test("stored marker full version/digest mismatch refuses without invoking", async () => {
  const f = await fixture();
  await f.run();
  f.durable.marker.preparation_version = "999";
  assert.equal((await f.run()).status, "unavailable");
  assert.equal(f.invocationCount, 1);
});
test("late response has independent original transaction after current use closes", async () => {
  const f = await fixture();
  await f.run();
  f.closeCurrentUse();
  const response = f.response();
  assert.equal((await f.retain(response, f.call())).status, "retained");
  assert.equal(f.currentUseCount, 1);
  assert.equal(f.invocationCount, 1);
  assert.deepEqual(f.durable.response, response);
  assert.ok(f.events.includes("BEGIN ISOLATION LEVEL READ COMMITTED"));
  assert.ok(f.events.indexOf("response-client-release") < f.events.indexOf("observation-release"));
  await assert.rejects(f.context.query.query("SELECT 1"));
});
test("copied response cannot reach getters or append before original source recognition", async () => {
  const f = await fixture();
  await f.run();
  let touched = false;
  const invented = Object.defineProperty({}, "uid", {
    get() {
      touched = true;
      throw new Error("getter");
    },
  });
  assert.equal((await f.retain(invented, f.call())).status, "unavailable");
  assert.equal(touched, false);
  assert.equal(f.durable.response, undefined);
});
test("original response retention preserves SDK clock skew without ordering it against the database clock", async () => {
  const f = await fixture();
  await f.run();
  const response = f.response({
    receivedAt: new Date(Date.parse(f.committed.submittedAt) - 60_000).toISOString(),
  });
  const result = await f.retain(response, f.call());
  assert.equal(result.status, "retained");
  assert.equal(result.response.receivedAt, response.receivedAt);
  assert.deepEqual(f.durable.response, response);
  assert.equal(f.invocationCount, 1);
  assert.equal(f.events.filter((event) => event === "response-insert").length, 1);
});
test("original response retention still refuses an invalid reported timestamp", async () => {
  const f = await fixture();
  await f.run();
  assert.equal(
    (await f.retain(f.response({ receivedAt: "not-an-instant" }), f.call())).status,
    "unavailable",
  );
  assert.equal(f.durable.response, undefined);
});
test("identical retained response is idempotent and conflicting response is refused", async () => {
  const f = await fixture();
  await f.run();
  const response = f.response();
  assert.equal((await f.retain(response, f.call())).status, "retained");
  assert.equal((await f.retain(response, f.call())).status, "retained");
  assert.equal(
    (await f.retain(f.response({ resourceVersion: "different" }), f.call())).status,
    "unavailable",
  );
  assert.deepEqual(f.durable.response, response);
  assert.equal(f.events.filter((x) => x === "response-insert").length, 1);
});
test("response acquire failure releases transferred cleanup and rolls back", async () => {
  const f = await fixture({
    acquire() {
      throw new Error("controlled acquire failure");
    },
  });
  await f.run();
  assert.equal((await f.retain(f.response(), f.call())).status, "unavailable");
  assert.equal(f.events.at(-1), "observation-release");
  assert.equal(f.durable.response, undefined);
});
test("caught nested transaction poisons the original response owner", async () => {
  const f = await fixture({
    async acquire(_context, _lease, state) {
      await state.transact(async () => {}).catch(() => {});
    },
  });
  await f.run();
  assert.equal((await f.retain(f.response(), f.call())).status, "unavailable");
  assert.equal(f.durable.response, undefined);
  assert.ok(f.events.includes("response-rollback"));
});
test("async currentness is joined and refused before response publication", async () => {
  const pending = deferred();
  let started = false,
    ended = false;
  const f = await fixture({
    current() {
      started = true;
      return pending.promise.then(() => {
        ended = true;
      });
    },
  });
  await f.run();
  let settled = false;
  const operation = f.retain(f.response(), f.call()).then((value) => {
    settled = true;
    return value;
  });
  for (let n = 0; n < 20 && !started; n++) await new Promise((r) => setImmediate(r));
  assert.equal(started, true);
  assert.equal(settled, false);
  pending.resolve();
  assert.equal((await operation).status, "unavailable");
  assert.equal(ended, true);
  assert.equal(f.durable.response, undefined);
});
for (const failure of ["responseUnknown", "cleanup"]) {
  test(`${failure} cannot report definite retained commit`, async () => {
    const f = await fixture(
      failure === "cleanup"
        ? {
            release() {
              throw new Error("controlled cleanup");
            },
          }
        : { responseUnknown: true },
    );
    await f.run();
    assert.equal((await f.retain(f.response(), f.call())).status, "unknown");
    assert.equal(f.invocationCount, 1);
  });
}
test("submit joins entered response retention even when participant does not await it", async () => {
  const wait = deferred();
  let entered = false,
    settled = false;
  const f = await fixture({
    async prepare() {
      entered = true;
      await wait.promise;
    },
  });
  f.hooks.invoke = (_committed, retain) => {
    void retain(f.response(), f.call());
  };
  const operation = f.run().then((value) => {
    settled = true;
    return value;
  });
  for (let n = 0; n < 20 && !entered; n++) await new Promise((r) => setImmediate(r));
  assert.equal(entered, true);
  assert.equal(settled, false);
  wait.resolve();
  assert.equal((await operation).status, "retained");
});
test("missing complete capabilities refuses before current-use checkout", async () => {
  const f = await fixture();
  assert.throws(() =>
    f.state.runtimePreparationSubmissionOwnerV1({}, f.participant, f.source, undefined),
  );
  assert.equal(f.currentUseCount, 0);
});

test("caught configured initial-binding entry poisons the active response owner", async () => {
  let sourceEntered = false,
    nestedRejected = false;
  const f = await fixture({
    async acquire(_context, _lease, state) {
      const nested = state.runtimeInitialBindingOwnerV1({
        async acquire() {
          sourceEntered = true;
          throw new Error("must not acquire");
        },
      });
      await assert.rejects(
        nested.run({}, {}, {}, async () => {}),
        { name: "ScopeViolationError" },
      );
      nestedRejected = true;
    },
  });
  await f.run();
  assert.equal((await f.retain(f.response(), f.call())).status, "unavailable");
  assert.equal(nestedRejected, true);
  assert.equal(sourceEntered, false);
  assert.equal(f.durable.response, undefined);
  assert.ok(f.events.includes("response-rollback"));
});

test("factory observes each original supplier method once", async () => {
  const f = await fixture();
  const counts = { invoke: 0, response: 0, capability: 0 };
  const changing = (key, original) => {
    counts[key]++;
    return counts[key] === 1 ? original : undefined;
  };
  const owner = f.state.runtimePreparationSubmissionOwnerV1(
    {},
    {
      get invoke() {
        return changing("invoke", f.participant.invoke.bind(f.participant));
      },
    },
    {
      get acquire() {
        return changing("response", f.source.acquire.bind(f.source));
      },
    },
    {
      get acquire() {
        return changing("capability", f.capabilities.acquire.bind(f.capabilities));
      },
    },
  );
  assert.deepEqual(counts, { invoke: 1, response: 1, capability: 1 });
  assert.equal((await owner.submit(f.claim, f.request, f.bounds)).status, "unknown");
  assert.equal(f.invocationCount, 1);
  assert.deepEqual(counts, { invoke: 1, response: 1, capability: 1 });
});

test("factory retains original current-use method despite later property replacement", async () => {
  const f = await fixture();
  f.state.withRuntimePreparationWorkerCurrentUseV1 = async () => {
    throw new Error("replacement must not run");
  };
  assert.equal((await f.run()).status, "unknown");
  assert.equal(f.currentUseCount, 1);
  assert.equal(f.invocationCount, 1);
});

test("cancelled accepted acquire transfers its late unretained lease before rollback cleanup", async () => {
  const gate = deferred();
  let acquired = false,
    released = 0,
    settled = false;
  const f = await fixture({
    skipEarlyRetain: true,
    async acquire() {
      acquired = true;
      await gate.promise;
    },
    release() {
      released++;
    },
  });
  await f.run();
  const cancelled = new AbortController();
  const operation = f
    .retain(f.response(), { ...f.call(), signal: cancelled.signal })
    .then((value) => {
      settled = true;
      return value;
    });
  for (let n = 0; n < 20 && !acquired; n++) await new Promise((r) => setImmediate(r));
  assert.equal(acquired, true);
  cancelled.abort();
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  gate.resolve();
  assert.equal((await operation).status, "unavailable");
  assert.equal(released, 1);
  assert.equal(f.durable.response, undefined);
  assert.ok(f.events.includes("response-client-destroy"));
  assert.equal(f.events.includes("response-commit"), false);
  assert.ok(f.events.indexOf("response-client-release") < f.events.indexOf("observation-release"));
});
