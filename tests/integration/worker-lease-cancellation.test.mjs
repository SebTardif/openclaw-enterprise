import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  claim,
  controlledQueue,
  deferred,
  loadInstalledLeasedEffects,
  WorkClaimLostError,
} from "../fixtures/worker-lease-cancellation/controlled-queue.mjs";

const { LeasedEffects } = await loadInstalledLeasedEffects();

// Execute the installed helper with controlled queue boundaries and real abort
// signals. Manual cancellation is not PostgreSQL claim-loss or SDK evidence.
function context() {
  const controller = new AbortController();
  return { controller, worker: { claim: claim(), signal: controller.signal } };
}
function leased(queue, withAbortSignal = async (_signal, effect) => effect()) {
  return new LeasedEffects({ queue, leaseDurationMs: 30, withAbortSignal });
}

for (const method of ["renew", "run"]) {
  test(`pre-aborted ${method} performs no heartbeat or effect`, async () => {
    const { controller, worker } = context();
    const queue = controlledQueue();
    let effects = 0;
    controller.abort();
    const helper = leased(queue);
    await assert.rejects(
      helper[method](worker, async () => {
        effects += 1;
      }),
      WorkClaimLostError,
    );
    assert.equal(queue.calls.length, 0);
    assert.equal(effects, 0);
  });
}

for (const method of ["renew", "run"]) {
  test(
    `abort during ${method}'s initial renewal joins it and suppresses the effect`,
    { timeout: 2_000 },
    async () => {
      const { controller, worker } = context();
      const entered = deferred();
      const renewal = deferred();
      const queue = controlledQueue(() => {
        entered.resolve();
        return renewal.promise;
      });
      let effects = 0;
      let settled = false;
      const running = leased(queue)[method](worker, async () => {
        effects += 1;
      });
      running.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const rejected = assert.rejects(running, WorkClaimLostError);
      await entered.promise;
      controller.abort();
      await setImmediate();
      assert.equal(settled, false);
      renewal.resolve(worker.claim);
      await rejected;
      assert.equal(queue.calls.length, 1);
      assert.equal(queue.calls[0], worker.claim);
      assert.equal(effects, 0);
    },
  );
}

test("abort between completed renewal and listener registration cannot reach the bridge", async () => {
  const { controller, worker } = context();
  let bridgeCalls = 0;
  let effects = 0;
  const queue = controlledQueue((input) => {
    // The first microtask lets renew's awaited heartbeat complete; the second
    // aborts before run's continuation registers its listener. No method patch.
    queueMicrotask(() => queueMicrotask(() => controller.abort()));
    return input;
  });
  const helper = leased(queue, async (_signal, effect) => {
    bridgeCalls += 1;
    return effect();
  });
  await assert.rejects(
    helper.run(worker, async () => {
      effects += 1;
    }),
    WorkClaimLostError,
  );
  assert.equal(queue.calls.length, 1);
  assert.equal(bridgeCalls, 0);
  assert.equal(effects, 0);
});

test(
  "a bridge that invokes its callback after cancellation cannot start the effect",
  { timeout: 2_000 },
  async () => {
    const { controller, worker } = context();
    const entered = deferred();
    const release = deferred();
    const queue = controlledQueue((input) => input);
    let operationSignal;
    let effects = 0;
    const helper = leased(queue, async (signal, effect) => {
      operationSignal = signal;
      entered.resolve();
      await release.promise;
      return effect();
    });
    const rejected = assert.rejects(
      helper.run(worker, async () => {
        effects += 1;
      }),
      WorkClaimLostError,
    );
    await entered.promise;
    controller.abort();
    assert.ok(operationSignal.aborted);
    assert.ok(operationSignal.reason instanceof WorkClaimLostError);
    release.resolve();
    await rejected;
    assert.equal(effects, 0);
  },
);

for (const loss of ["cancelled", "missing", "rejected"]) {
  test(
    `${loss} periodic heartbeat suppresses queued renewals and joins pending work`,
    { timeout: 2_000 },
    async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { controller, worker } = context();
      const heartbeatEntered = deferred();
      const heartbeat = deferred();
      const effectEntered = deferred();
      const effect = deferred();
      const queue = controlledQueue(
        (input) => input,
        () => {
          heartbeatEntered.resolve();
          return heartbeat.promise;
        },
      );
      let operationSignal;
      let settled = false;
      const helper = leased(queue, async (signal, callback) => {
        operationSignal = signal;
        return callback();
      });
      const running = helper.run(worker, async () => {
        effectEntered.resolve();
        return effect.promise;
      });
      running.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const rejected = assert.rejects(running, WorkClaimLostError);
      await effectEntered.promise;
      // Three ticks queue renewals behind one unresolved heartbeat. Cancelling or
      // losing that claim must not let later queued callbacks contact the queue.
      t.mock.timers.tick(30);
      await heartbeatEntered.promise;
      assert.equal(queue.calls.length, 2);
      if (loss === "cancelled") controller.abort();
      effect.resolve("effect already in flight");
      await setImmediate();
      assert.equal(settled, false, "run must join its still-pending heartbeat");
      if (loss === "rejected") heartbeat.reject(new Error("controlled heartbeat outage"));
      else heartbeat.resolve(loss === "missing" ? undefined : worker.claim);
      await rejected;
      assert.ok(operationSignal.aborted);
      assert.ok(operationSignal.reason instanceof WorkClaimLostError);
      assert.equal(queue.calls.length, 2);
      t.mock.timers.tick(30);
      await setImmediate();
      assert.equal(queue.calls.length, 2, "the periodic timer must be cleared");
    },
  );
}

test(
  "claim loss aborts cooperatively but does not detach an already running effect",
  { timeout: 2_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { worker } = context();
    const effectEntered = deferred();
    const effect = deferred();
    const queue = controlledQueue(
      (input) => input,
      () => undefined,
    );
    let operationSignal;
    let settled = false;
    const running = leased(queue, async (signal, callback) => {
      operationSignal = signal;
      return callback();
    }).run(worker, async () => {
      effectEntered.resolve();
      return effect.promise;
    });
    running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = assert.rejects(running, WorkClaimLostError);
    await effectEntered.promise;
    t.mock.timers.tick(10);
    await setImmediate();
    assert.ok(operationSignal.aborted);
    assert.equal(settled, false, "cooperative abort cannot join the effect on its behalf");
    effect.resolve("late result");
    await rejected;
    assert.equal(queue.calls.length, 2);
  },
);

test("normal consecutive effects each renew and retain their values", async () => {
  const { worker } = context();
  const queue = controlledQueue(
    (input) => input,
    (input) => input,
  );
  const helper = leased(queue);
  const value = { exact: "callback value" };
  assert.equal(await helper.run(worker, async () => value), value);
  assert.equal(await helper.run(worker, async () => 42), 42);
  assert.equal(queue.calls.length, 2);
  assert.equal(queue.calls[0], worker.claim);
  assert.equal(queue.calls[1], worker.claim);
});

test("an ordinary effect error retains its identity when the claim was not lost", async () => {
  const { worker } = context();
  const queue = controlledQueue((input) => input);
  const original = new Error("controlled effect failure");
  await assert.rejects(
    leased(queue).run(worker, async () => {
      throw original;
    }),
    (error) => error === original,
  );
  assert.equal(queue.calls.length, 1);
});

// These required-currentness controls exercise the installed helper's ordering.
// The full source-data comparison is exercised by worker-current-intent.test.mjs.
for (const boundary of ["before-renewal", "after-renewal", "before-effect", "after-effect"]) {
  test(`running revision currentness failure ${boundary} preserves its own first error`, async () => {
    const { worker } = context();
    const error = new Error("controlled intent change");
    const calls = [];
    const failAt = {
      "before-renewal": 1,
      "after-renewal": 2,
      "before-effect": 3,
      "after-effect": 4,
    }[boundary];
    let reads = 0;
    const currentness = {
      async assertCurrent() {
        calls.push("current");
        if (++reads === failAt) throw error;
      },
    };
    const queue = {
      async heartbeat() {
        calls.push("heartbeat");
        return worker.claim;
      },
    };
    await assert.rejects(
      leased(queue).runRevision(worker, currentness, async () => {
        calls.push("effect");
        return "late value";
      }),
      (received) => received === error,
    );
    assert.equal(calls.includes("heartbeat"), boundary !== "before-renewal");
    assert.equal(calls.includes("effect"), boundary === "after-effect");
  });
}

test(
  "a periodic revision currentness failure aborts the effect and is joined without claim-loss relabeling",
  { timeout: 2000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const entered = deferred();
    const { worker } = context();
    const error = new Error("controlled periodic intent change");
    let checks = 0;
    let effects = 0;
    const helper = leased({ heartbeat: async () => worker.claim }, async (signal, effect) => {
      await effect();
      if (!signal.aborted)
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      assert.equal(signal.reason, error);
      return "late provider response";
    });
    const rejected = assert.rejects(
      helper.runRevision(
        worker,
        {
          async assertCurrent() {
            if (++checks >= 4) throw error;
          },
        },
        async () => {
          effects++;
          entered.resolve();
        },
      ),
      (received) => received === error,
    );
    await entered.promise;
    t.mock.timers.tick(10);
    await rejected;
    assert.equal(effects, 1);
  },
);

test("required revision currentness cannot be omitted or replaced by a successful renewal", async () => {
  const { worker } = context();
  let effects = 0;
  let renewals = 0;
  await assert.rejects(
    leased({
      heartbeat: async () => {
        renewals++;
        return worker.claim;
      },
    }).runRevision(worker, undefined, async () => {
      effects++;
    }),
  );
  assert.equal(effects, 0);
  assert.equal(renewals, 0);
});
