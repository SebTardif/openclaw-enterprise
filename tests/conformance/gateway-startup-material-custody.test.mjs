import test from "node:test";
import assert from "node:assert/strict";
import {
  createGatewayMaterialCustodyV1,
  assertGatewayMaterialCurrentV1,
} from "../../apps/gateway/src/startup-material-custody.ts";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const lease = (events, name = "lease") => ({
  signal: new AbortController().signal,
  async release() {
    events.push(name);
    return { cleanup: "finished" };
  },
});

test("only synchronous undefined currentness passes and exceptions are sanitized", () => {
  assertGatewayMaterialCurrentV1(() => undefined);
  for (const value of [true, false, null, Promise.resolve()])
    assert.throws(() => assertGatewayMaterialCurrentV1(() => value), /material unavailable/);
  assert.throws(
    () =>
      assertGatewayMaterialCurrentV1(() => {
        throw new Error("secret");
      }),
    (e) => e.message === "Gateway startup material unavailable",
  );
});

test("pre-abort and closing before the source microtask prevent source invocation", async () => {
  for (const before of [true, false]) {
    const parent = new AbortController();
    if (before) parent.abort();
    const owner = createGatewayMaterialCustodyV1(parent.signal);
    let calls = 0;
    const result = owner.acquire(async () => {
      calls++;
      return lease([]);
    });
    const reject = assert.rejects(result, /material unavailable/);
    await owner.close();
    await reject;
    assert.equal(calls, 0);
  }
});

test("close retains and joins a late acquisition and releases it exactly once", async () => {
  const owner = createGatewayMaterialCustodyV1(new AbortController().signal);
  const pending = deferred();
  const entered = deferred();
  const events = [];
  const use = owner.acquire(() => {
    entered.resolve();
    return pending.promise;
  });
  const rejected = assert.rejects(use, /material unavailable/);
  await entered.promise;
  let settled = false;
  const closing = owner.close();
  assert.equal(owner.close(), closing);
  void closing.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  pending.resolve(lease(events));
  await rejected;
  assert.deepEqual(await closing, { cleanup: "finished" });
  assert.deepEqual(events, ["lease"]);
});

test("invalidation fences but borrowed consumers retain material until explicit close", async () => {
  const parent = new AbortController();
  const events = [];
  const owner = createGatewayMaterialCustodyV1(parent.signal);
  await owner.acquire(async () => lease(events));
  parent.abort();
  assert.equal(owner.signal.aborted, true);
  assert.throws(owner.assertActive, /material unavailable/);
  await Promise.resolve();
  assert.deepEqual(events, []);
  await owner.close();
  assert.deepEqual(events, ["lease"]);
});

test("original source invalidation fences the entire borrowed bundle", async () => {
  const source = new AbortController();
  const events = [];
  const owner = createGatewayMaterialCustodyV1(new AbortController().signal);
  await owner.acquire(async () => ({ ...lease(events), signal: source.signal }));
  source.abort();
  assert.equal(owner.signal.aborted, true);
  assert.deepEqual(events, []);
  await owner.close();
  assert.deepEqual(events, ["lease"]);
});

test("reverse acquisition release preserves the strongest cleanup result", async () => {
  const owner = createGatewayMaterialCustodyV1(new AbortController().signal);
  const events = [];
  for (const [name, outcome] of [
    ["a", "finished"],
    ["b", "unknown"],
    ["c", "failed"],
  ])
    await owner.acquire(async () => ({
      signal: new AbortController().signal,
      async release() {
        events.push(name);
        return { cleanup: outcome };
      },
    }));
  assert.deepEqual(await owner.close(), { cleanup: "unknown" });
  assert.deepEqual(events, ["c", "b", "a"]);
});

test("reentrant invalidation/close uses one installed join", async () => {
  const owner = createGatewayMaterialCustodyV1(new AbortController().signal);
  const events = [];
  let nested;
  await owner.acquire(async () => lease(events));
  owner.signal.addEventListener("abort", () => {
    nested = owner.close();
  });
  const closing = owner.close();
  assert.equal(nested, closing);
  assert.deepEqual(await closing, { cleanup: "finished" });
  assert.deepEqual(events, ["lease"]);
});

test("duplicate lease is refused and its original release still occurs once", async () => {
  const owner = createGatewayMaterialCustodyV1(new AbortController().signal);
  const events = [];
  const original = lease(events);
  await owner.acquire(async () => original);
  await assert.rejects(
    owner.acquire(async () => original),
    /material unavailable/,
  );
  await owner.close();
  assert.deepEqual(events, ["lease"]);
});

test("bad cleanup objects and source exceptions expose no raw diagnostic", async () => {
  const owner = createGatewayMaterialCustodyV1(new AbortController().signal);
  await assert.rejects(
    owner.acquire(async () => {
      throw new Error("raw credential");
    }),
    (e) => e.message === "Gateway startup material unavailable",
  );
  await owner.acquire(async () => ({
    signal: new AbortController().signal,
    async release() {
      return {
        get cleanup() {
          throw new Error("raw credential");
        },
      };
    },
  }));
  assert.deepEqual(await owner.close(), { cleanup: "unknown" });
});

test("invalid signal retains an already captured disposer until explicit close", async () => {
  for (const throwing of [false, true]) {
    const owner = createGatewayMaterialCustodyV1(new AbortController().signal);
    let releases = 0;
    const original = {
      get signal() {
        if (throwing) throw new Error("private signal detail");
        return {};
      },
      async release() {
        releases++;
        return { cleanup: "finished" };
      },
    };
    await assert.rejects(
      owner.acquire(async () => original),
      (error) => error.message === "Gateway startup material unavailable",
    );
    assert.equal(releases, 0);
    assert.deepEqual(await owner.close(), { cleanup: "unknown" });
    await owner.close();
    assert.equal(releases, 1);
  }
});

test("rejected asynchronous currentness is observed without accepting it or leaking its reason", async () => {
  const raw = new Error("private rejected currentness detail");
  assert.throws(
    () => assertGatewayMaterialCurrentV1(() => Promise.reject(raw)),
    (error) => error !== raw && error.message === "Gateway startup material unavailable",
  );
  // node:test reports unhandled rejections as failures, including after return.
  await new Promise((resolve) => setImmediate(resolve));
});
