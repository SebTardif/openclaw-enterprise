import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { parseRuntimeMutationResultV1 } from "@openclaw-enterprise/contracts";
import {
  PostgresPlatformState,
  PostgresCommitOutcomeUnknownError,
} from "../../packages/occ/src/state/postgres-state.ts";
import { PostgresInitialBindingExecutionV1 } from "../../packages/occ/src/state/postgres/runtime-initial-binding.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { acceptInitialRuntimeBindingV1 } from "../../packages/occ/src/runtime-authority/initial-binding.ts";
import { seedPreparation } from "../fixtures/runtime-preparation.mjs";
import { bindRequest, trust } from "../fixtures/runtime-authority-v1/vectors.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const refusal = () => ({
  schemaVersion: 1,
  result: "rejected-before-effect",
  reasonCode: "lookup-unavailable",
});
const result = (rows = [], command = "SELECT") => ({ rows, rowCount: rows.length, command });
function inputs(request = bindRequest()) {
  const abort = new AbortController();
  const call = {
    context: Object.freeze({ controlled: "context" }),
    requestRef: request.requestRef,
    recipientRef: "recipient/occ",
    deadline: new Date(Date.now() + 2900).toISOString(),
    signal: abort.signal,
  };
  const service = {
    configuration: {
      ...trust(),
      installationId: request.target.installationId,
      serviceIdentityRef: "service/independent",
      allowedScope: {
        kind: "agent",
        installationId: request.target.installationId,
        namespaceId: request.target.namespaceId,
        agentId: request.target.agentId,
      },
      permittedRecipientRef: call.recipientRef,
      role: "lifecycle-authority",
    },
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
    peerEvidenceRef: "controlled/service",
    transportBinding: Object.freeze({ controlled: "transport" }),
  };
  return { request, call, service, abort };
}

// Protocol-only checkout exercises the real PostgresPlatformState finalizer.
// It has no SQL storage emulator, service authority or PostgreSQL lock proof.
function adapter(hooks = {}) {
  const events = [];
  const original = inputs();
  let checkouts = 0;
  const pool = {
    options: { connectionTimeoutMillis: 250 },
    async connect() {
      checkouts++;
      const client = new EventEmitter();
      client.release = () => {
        events.push("client-release");
        hooks.release?.();
      };
      client.query = async (statement, parameters) => {
        events.push(statement);
        if (statement.startsWith("BEGIN") || statement.startsWith("SET LOCAL")) return result();
        if (
          statement ===
          "SELECT set_config('statement_timeout',$1,true), set_config('transaction_timeout',$1,true), set_config('idle_in_transaction_session_timeout',$1,true)"
        ) {
          assert.equal(parameters.length, 1);
          assert.match(parameters[0], /^[1-9][0-9]*ms$/);
          const milliseconds = Number(parameters[0].slice(0, -2));
          assert.ok(milliseconds >= 1 && milliseconds <= 2900);
          return result();
        }
        if (statement === "COMMIT") {
          await hooks.commit?.();
          return result([], "COMMIT");
        }
        if (statement === "ROLLBACK") return result([], "ROLLBACK");
        if (statement.includes("FROM occ.installation"))
          return result([
            {
              id: original.request.target.installationId,
              name: "Controlled",
              created_at: new Date().toISOString(),
            },
          ]);
        if (statement.includes("runtime-authority-operation:")) return result();
        throw new Error("Unexpected controlled protocol query");
      };
      return client;
    },
  };
  const state = new PostgresPlatformState(pool);
  let sourceContext, sourceUnit;
  const source = {
    async acquire(context, request, service, call) {
      events.push("source-acquire");
      sourceContext = context;
      assert.equal(service.transportBinding, original.service.transportBinding);
      assert.equal(call.context, original.call.context);
      const lease = {
        assertCurrent() {
          return hooks.current?.(events);
        },
        async prepareCommit() {
          events.push("source-prepare");
          await hooks.prepare?.(context);
        },
        async qualifyPreparation() {
          throw new Error("No fresh proof in protocol fixture");
        },
        async release() {
          events.push("source-release");
          await hooks.sourceRelease?.(context);
        },
      };
      context.retain(lease);
      await hooks.acquire?.(context, lease, state);
      return lease;
    },
  };
  const run = (callback = async () => refusal()) =>
    state
      .runtimeInitialBindingOwnerV1(source)
      .run(original.request, original.service, original.call, async (unit) => {
        sourceUnit = unit;
        return callback(unit);
      });
  return {
    state,
    events,
    original,
    run,
    get checkouts() {
      return checkouts;
    },
    get context() {
      return sourceContext;
    },
    get unit() {
      return sourceUnit;
    },
  };
}

test("initial binding missing source refuses before checkout", async () => {
  const f = adapter();
  await assert.rejects(
    f.state
      .runtimeInitialBindingOwnerV1()
      .run(f.original.request, f.original.service, f.original.call, async () => refusal()),
  );
  assert.equal(f.checkouts, 0);
});

test("original adapter uses READ COMMITTED and holds source until client terminal", async () => {
  const f = adapter();
  assert.deepEqual(await f.run(), parseRuntimeMutationResultV1("bind", refusal()));
  assert.equal(f.events[0], "BEGIN ISOLATION LEVEL READ COMMITTED");
  assert.ok(f.events.indexOf("source-prepare") < f.events.indexOf("COMMIT"));
  assert.ok(f.events.indexOf("COMMIT") < f.events.indexOf("client-release"));
  assert.ok(f.events.indexOf("client-release") < f.events.indexOf("source-release"));
  assert.throws(() => f.unit.assertCurrent());
  await assert.rejects(f.context.query.query("SELECT 1"));
});

test("caught fresh append without original proofs still rolls back", async () => {
  const f = adapter();
  await assert.rejects(
    f.run(async (unit) => {
      await unit.append().catch(() => {});
      return refusal();
    }),
  );
  assert.equal(f.events.includes("COMMIT"), false);
  assert.equal(f.events.includes("ROLLBACK"), true);
  assert.equal(f.events.at(-1), "source-release");
});

test("caught nested transaction poisons original initial binding owner", async () => {
  const f = adapter({
    async acquire(_context, _lease, state) {
      await state.transact(async () => {}).catch(() => {});
    },
  });
  await assert.rejects(f.run());
  assert.equal(f.checkouts, 1);
  assert.equal(f.events.includes("COMMIT"), false);
  assert.equal(f.events.at(-1), "source-release");
});

test("acquisition failure after cleanup transfer releases before rejection", async () => {
  const failure = new Error("controlled acquisition");
  const f = adapter({
    async acquire() {
      throw failure;
    },
  });
  await assert.rejects(f.run(), (error) => error === failure);
  assert.equal(f.events.at(-1), "source-release");
});

test("malformed asynchronous currentness is joined before terminal cleanup", async () => {
  const pending = deferred();
  let invoked = false;
  const f = adapter({
    current() {
      if (!invoked) {
        invoked = true;
        return pending.promise;
      }
    },
  });
  const running = f.run();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.events.includes("source-release"), false);
  pending.resolve();
  await assert.rejects(running);
  assert.equal(f.events.includes("COMMIT"), false);
  assert.equal(f.events.at(-1), "source-release");
});

test("late caught unit call during prepareCommit poisons final fence", async () => {
  let f;
  f = adapter({
    async prepare() {
      await f.unit.readReplay().catch(() => {});
    },
  });
  await assert.rejects(f.run());
  assert.equal(f.events.includes("COMMIT"), false);
});

test("acknowledged COMMIT followed by cleanup failure remains unknown outward", async () => {
  const f = adapter({
    async sourceRelease() {
      throw new Error("controlled cleanup");
    },
  });
  await assert.rejects(f.run(), PostgresCommitOutcomeUnknownError);
  assert.equal(f.events.includes("COMMIT"), true);
  assert.equal(f.events.at(-1), "source-release");
});

test("lost COMMIT acknowledgement joins cleanup without retry", async () => {
  const f = adapter({
    async commit() {
      throw new Error("controlled transport");
    },
  });
  await assert.rejects(f.run(), PostgresCommitOutcomeUnknownError);
  assert.equal(f.events.filter((event) => event === "COMMIT").length, 1);
  assert.equal(f.events.at(-1), "source-release");
});

// Real memory preparation/candidate/authority repositories + the actual private
// PostgreSQL locator/owner are composed. Query transport and proof participants
// are controlled; no native service or PostgreSQL concurrency proof is claimed.
async function repositoryFixture() {
  const state = new InMemoryPlatformState();
  const f = await seedPreparation(state);
  await f.append(f.plan);
  await f.append(f.child);
  const binding = await f.candidate();
  await f.append(binding);
  const record = await f.operation(binding.operationRef);
  const original = inputs(binding.proposal);
  const events = [];
  const hooks = {};
  const source = {
    async acquire(context) {
      events.push("acquire");
      const lease = {
        assertCurrent() {},
        async prepareCommit() {
          events.push("prepare");
        },
        async release() {
          events.push("release");
        },
        async qualifyPreparation(preparation, proposal) {
          events.push("qualify");
          assert.equal(preparation.bindingProposals.includes(proposal), true);
          await hooks.qualify?.(preparation, proposal);
        },
      };
      context.retain(lease);
      return lease;
    },
  };
  const owner = {
    async run(request, service, call, work) {
      const execution = new PostgresInitialBindingExecutionV1(request, service, call, source);
      try {
        return await state.transact(async (platform) => {
          const value = await execution.invoke(
            platform,
            {
              async query(statement, parameters) {
                events.push(parameters?.[0] ?? statement);
                if (statement.includes("binding_operation_ref=$1"))
                  return result(hooks.missing ? [] : [{ record }]);
                return result();
              },
            },
            request.target.installationId,
            () => {},
            hooks.work ?? work,
          );
          await execution.prepareCommit();
          execution.assertCommitReady();
          return value;
        });
      } catch (error) {
        execution.poison(error);
        await execution.drain();
        throw error;
      } finally {
        await execution.finishTerminal();
      }
    },
  };
  const run = () =>
    acceptInitialRuntimeBindingV1(owner, original.request, original.service, original.call);
  return { f, binding, original, events, hooks, owner, run };
}

test("private locator holds original preparation before Agent and actual append", async () => {
  const f = await repositoryFixture();
  const applied = await f.run();
  assert.equal(applied.result, "applied");
  assert.ok(
    f.events.indexOf(`binding:${f.binding.operation.operationRef}`) <
      f.events.indexOf(`preparation:${f.binding.preparationRef}`),
  );
  assert.ok(
    f.events.indexOf(`preparation:${f.binding.preparationRef}`) <
      f.events.indexOf(f.original.request.target.namespaceId),
  );
  assert.equal((await f.f.assignment()).binding.status, "bound");
  assert.equal(f.events.at(-1), "release");
});

test("historical exact replay does not reacquire preparation or fresh proofs", async () => {
  const f = await repositoryFixture();
  assert.equal((await f.run()).result, "applied");
  f.events.length = 0;
  f.hooks.missing = true;
  const replay = await f.run();
  assert.equal(replay.result, "exact-replay");
  assert.equal(f.events.includes("qualify"), false);
  assert.equal(
    f.events.some((event) => event === `binding:${f.binding.operation.operationRef}`),
    false,
  );
});

test("copied preparation cannot select current proof path", async () => {
  const f = await repositoryFixture();
  f.hooks.work = async (unit) => {
    await unit.readReplay();
    const locator = await unit.readPreparationLocator();
    const preparation = await unit.findPreparation(locator.preparationRef);
    const copied = structuredClone(preparation);
    await unit.requireCurrentProofs(copied, copied.bindingProposals[0]).catch(() => {});
    return refusal();
  };
  assert.equal((await f.run()).result, "rejected-before-effect");
  assert.equal((await f.f.assignment()).binding.status, "unbound");
  assert.equal(f.events.includes("qualify"), false);
});

test("fresh independent proof failure leaves original authority unbound", async () => {
  const f = await repositoryFixture();
  f.hooks.qualify = async () => {
    throw new Error("controlled proof unavailable");
  };
  assert.equal((await f.run()).result, "rejected-before-effect");
  assert.equal((await f.f.assignment()).binding.status, "unbound");
});

for (const detached of [false, true]) {
  test(`successful ${detached ? "detached" : "awaited"} append cannot commit behind a refusal`, async () => {
    const f = await repositoryFixture();
    f.hooks.work = async (unit) => {
      await unit.readReplay();
      const locator = await unit.readPreparationLocator();
      const preparation = await unit.findPreparation(locator.preparationRef);
      await unit.requireCurrentProofs(preparation, preparation.bindingProposals[0]);
      if (detached) void unit.append();
      else await unit.append();
      return refusal();
    };
    assert.equal((await f.run()).result, "rejected-before-effect");
    assert.equal((await f.f.assignment()).binding.status, "unbound");
  });
}

for (const outlived of [false, true]) {
  test(
    `${outlived ? "outlived" : "nested"} qualifier membership cannot queue another owner operation`,
    { timeout: 1000 },
    async () => {
      const f = await repositoryFixture();
      const gate = deferred();
      let captured, late;
      let lateRejected = false;
      f.hooks.qualify = async () => {
        if (outlived) {
          // This continuation retains the qualifier's operation context after its
          // original method returns. It cannot become a new top-level admission.
          late = gate.promise.then(() => captured.readReplay());
        } else {
          await captured.readReplay();
        }
      };
      f.hooks.work = async (unit) => {
        captured = unit;
        await unit.readReplay();
        const locator = await unit.readPreparationLocator();
        const preparation = await unit.findPreparation(locator.preparationRef);
        await unit.requireCurrentProofs(preparation, preparation.bindingProposals[0]);
        gate.resolve();
        if (late) {
          await assert.rejects(late, {
            name: "ScopeViolationError",
            message: "Initial binding admission is closed.",
          });
          lateRejected = true;
        }
        return refusal();
      };
      assert.equal((await f.run()).result, "rejected-before-effect");
      assert.equal((await f.f.assignment()).binding.status, "unbound");
      assert.equal(f.events.at(-1), "release");
      if (outlived)
        assert.equal(lateRejected, true, "the outlived unit call must reject at admission");
    },
  );
}
