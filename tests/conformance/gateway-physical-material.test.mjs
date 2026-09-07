import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  createKubernetesGatewayMaterialReaderV1,
  GatewayPhysicalMaterialUnavailableV1,
} from "../../apps/controller/src/credentials/kubernetes-gateway-material.ts";
import { createGatewayPhysicalMaterialSourceV1 } from "../../apps/controller/src/credentials/gateway-material-source.ts";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";

// Every client, accepting owner and value in these cases is synthetic.
// These cases exercise local ownership; they supply no Kubernetes or startup authority.
const digest = (value) => createHash("sha256").update(value).digest("hex");
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const denial = (error) =>
  error instanceof GatewayPhysicalMaterialUnavailableV1 &&
  error.message === "Gateway physical material is unavailable.";
function fixture(bot = Buffer.from("synthetic-bot"), app = Buffer.from("synthetic-app")) {
  const selection = {
    clusterRef: "cluster-selected",
    namespace: "selected-namespace",
    name: "selected-secret",
    uid: "selected-uid",
    resourceVersion: "observed-rv",
    logicalRevisionRef: "logical-revision",
    items: [
      {
        role: "slack-bot",
        key: "bot",
        credentialRef: "bot-ref",
        credentialVersion: 7,
        sha256: digest(bot),
      },
      {
        role: "slack-app",
        key: "app",
        credentialRef: "app-ref",
        credentialVersion: 9,
        sha256: digest(app),
      },
    ],
  };
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    immutable: true,
    metadata: {
      namespace: selection.namespace,
      name: selection.name,
      uid: selection.uid,
      resourceVersion: selection.resourceVersion,
    },
    data: { bot: bot.toString("base64"), app: app.toString("base64") },
  };
  return { selection, secret, bot, app };
}
function sourceFixture(custom = {}) {
  const f = fixture();
  const invalidation = new AbortController();
  let calls = 0;
  let reads = 0;
  const owner = {
    signal: invalidation.signal,
    assertConsumedCurrent(binding) {
      assert.equal(this, owner);
      calls++;
      assert.equal(binding.recipientRef, "recipient-selected");
      if (custom.current) return custom.current(binding);
      return undefined;
    },
    remainingStartupMs() {
      assert.equal(this, owner);
      return custom.startup?.() ?? 1_000;
    },
    remainingSourceMs() {
      assert.equal(this, owner);
      return custom.remaining?.() ?? 1_000;
    },
  };
  const client = {
    async readNamespacedSecret(request) {
      assert.equal(this, client);
      reads++;
      assert.deepEqual(request, { namespace: f.selection.namespace, name: f.selection.name });
      assert.ok(currentComputeAbortSignal() instanceof AbortSignal);
      return custom.get ? await custom.get(request, currentComputeAbortSignal()) : f.secret;
    },
  };
  const low = createKubernetesGatewayMaterialReaderV1(client, f.selection.clusterRef);
  let lastResult;
  const reader = {
    async read(selected, signal) {
      assert.equal(this, reader);
      const result = await low.read(selected, signal);
      lastResult = result;
      return custom.result ? custom.result(result) : result;
    },
  };
  const binding = {
    // The real factory consumes the canonical original Runtime value. This tiny
    // test-only object is deliberately not claimed to pass that producer codec.
    startup: { startup: { installationId: "installation-synthetic" } },
    recipientRef: "recipient-selected",
    recipientIncarnation: "process-selected",
    source: f.selection,
  };
  const source = createGatewayPhysicalMaterialSourceV1(owner, binding, reader);
  return {
    ...f,
    owner,
    reader,
    client,
    source,
    binding,
    invalidation,
    calls: () => calls,
    reads: () => reads,
    lastResult: () => lastResult,
  };
}

test("exact get returns only the fixed pair in dedicated jointly owned storage", async () => {
  const f = fixture();
  let count = 0;
  const client = {
    async readNamespacedSecret(request) {
      assert.equal(this, client);
      count++;
      assert.deepEqual(request, { namespace: f.selection.namespace, name: f.selection.name });
      return f.secret;
    },
  };
  const reader = createKubernetesGatewayMaterialReaderV1(client, f.selection.clusterRef);
  client.readNamespacedSecret = () => {
    throw new Error("replacement must not run");
  };
  const result = await reader.read(f.selection, new AbortController().signal);
  const values = result.borrow();
  assert.equal(count, 1);
  assert.deepEqual(values.botToken, f.bot);
  assert.deepEqual(values.appToken, f.app);
  assert.equal(values.botToken.buffer, values.appToken.buffer);
  assert.equal(values.botToken.byteOffset, 0);
  assert.equal(values.appToken.byteOffset, values.botToken.byteLength);
  assert.equal(values.botToken.buffer.byteLength, f.bot.length + f.app.length);
  assert.equal(result.observed.logicalRevisionRef, "logical-revision");
  assert.equal(result.observed.resourceVersion, "observed-rv");
  result.dispose();
  result.dispose();
  assert.ok(values.botToken.every((byte) => byte === 0));
  assert.ok(values.appToken.every((byte) => byte === 0));
  assert.throws(() => result.borrow(), denial);
});

test("immutable object identity, exact keys and content must all match", async () => {
  const mutations = [
    (s) => {
      s.immutable = false;
    },
    (s) => {
      delete s.immutable;
    },
    (s) => {
      s.metadata.uid = "other";
    },
    (s) => {
      s.metadata.resourceVersion = "other";
    },
    (s) => {
      s.metadata.namespace = "other";
    },
    (s) => {
      s.metadata.name = "other";
    },
    (s) => {
      s.metadata.deletionTimestamp = new Date();
    },
    (s) => {
      s.type = "other";
    },
    (s) => {
      s.kind = "other";
    },
    (s) => {
      s.apiVersion = "other";
    },
    (s) => {
      s.data.extra = "YQ==";
    },
    (s) => {
      delete s.data.bot;
    },
    (s) => {
      s.stringData = {};
    },
    (s) => {
      s.data.bot = "YQ==";
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f.secret);
    const reader = createKubernetesGatewayMaterialReaderV1(
      {
        async readNamespacedSecret() {
          return f.secret;
        },
      },
      f.selection.clusterRef,
    );
    await assert.rejects(reader.read(f.selection, new AbortController().signal), denial);
  }
});

test("malformed or unsupported source selections never call the client", async () => {
  const mutations = [
    (s) => {
      s.clusterRef = "other";
    },
    (s) => {
      s.namespace = "../escape";
    },
    (s) => {
      s.name = "";
    },
    (s) => {
      s.uid = "";
    },
    (s) => {
      s.items[0].credentialVersion = 0;
    },
    (s) => {
      s.items[0].role = "teams-refresh";
    },
    (s) => {
      s.items[0].key = s.items[1].key;
    },
    (s) => {
      s.items[0].sha256 = "not-a-digest";
    },
    (s) => {
      s.items.push(s.items[0]);
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    let reads = 0;
    mutate(f.selection);
    const reader = createKubernetesGatewayMaterialReaderV1(
      {
        async readNamespacedSecret() {
          reads++;
          return f.secret;
        },
      },
      "cluster-selected",
    );
    await assert.rejects(reader.read(f.selection, new AbortController().signal), denial);
    assert.equal(reads, 0);
  }
});

test("canonical nonempty UTF-8 material and strict base64 are required", async () => {
  for (const encoded of ["", "YQ", "YQ==\n", "YR==", "====", "AA==", "/w=="]) {
    const f = fixture();
    f.secret.data.bot = encoded;
    const reader = createKubernetesGatewayMaterialReaderV1(
      {
        async readNamespacedSecret() {
          return f.secret;
        },
      },
      f.selection.clusterRef,
    );
    await assert.rejects(reader.read(f.selection, new AbortController().signal), denial);
  }
});

test("32769-byte boundary is refused before allocating owned decoded storage", async (t) => {
  const f = fixture(Buffer.alloc(32_769, 65));
  const allocations = [];
  const original = Buffer.alloc;
  t.mock.method(Buffer, "alloc", (...args) => {
    allocations.push(args[0]);
    return original(...args);
  });
  const reader = createKubernetesGatewayMaterialReaderV1(
    {
      async readNamespacedSecret() {
        return f.secret;
      },
    },
    f.selection.clusterRef,
  );
  await assert.rejects(reader.read(f.selection, new AbortController().signal), denial);
  assert.deepEqual(allocations, []);
});

test("two maximal items fit exactly one 64KiB source allocation", async () => {
  const f = fixture(Buffer.alloc(32_768, 65), Buffer.alloc(32_768, 66));
  const reader = createKubernetesGatewayMaterialReaderV1(
    {
      async readNamespacedSecret() {
        return f.secret;
      },
    },
    f.selection.clusterRef,
  );
  const result = await reader.read(f.selection, new AbortController().signal);
  assert.equal(result.borrow().botToken.buffer.byteLength, 65_536);
  result.dispose();
  // This source-only case does not claim the native 28KiB payload profile fits.
});

test("source operands and the original get method cannot be redirected while awaiting", async () => {
  const f = fixture();
  const wait = deferred();
  let request;
  const client = {
    async readNamespacedSecret(value) {
      request = value;
      return await wait.promise;
    },
  };
  const reader = createKubernetesGatewayMaterialReaderV1(client, f.selection.clusterRef);
  const pending = reader.read(f.selection, new AbortController().signal);
  f.selection.name = "replacement";
  f.selection.items[0].key = "replacement";
  client.readNamespacedSecret = async () => {
    throw new Error("replacement");
  };
  wait.resolve(f.secret);
  const result = await pending;
  assert.deepEqual(request, { namespace: "selected-namespace", name: "selected-secret" });
  assert.equal(result.observed.name, "selected-secret");
  result.dispose();
});

test("abort before get denies without touching the client", async () => {
  const f = fixture();
  let reads = 0;
  const abort = new AbortController();
  abort.abort();
  const reader = createKubernetesGatewayMaterialReaderV1(
    {
      async readNamespacedSecret() {
        reads++;
        return f.secret;
      },
    },
    f.selection.clusterRef,
  );
  await assert.rejects(reader.read(f.selection, abort.signal), denial);
  assert.equal(reads, 0);
});

test("late canceled SDK result is refused and gets no owned decoded allocation", async (t) => {
  const f = fixture();
  const wait = deferred();
  const abort = new AbortController();
  const reader = createKubernetesGatewayMaterialReaderV1(
    {
      async readNamespacedSecret() {
        return await wait.promise;
      },
    },
    f.selection.clusterRef,
  );
  const pending = reader.read(f.selection, abort.signal);
  const allocations = [];
  const original = Buffer.alloc;
  t.mock.method(Buffer, "alloc", (...args) => {
    allocations.push(args[0]);
    return original(...args);
  });
  abort.abort();
  wait.resolve(f.secret);
  await assert.rejects(pending, denial);
  assert.deepEqual(allocations, []);
});

test("SDK exception contents never escape the constant diagnostic", async () => {
  const f = fixture();
  const reader = createKubernetesGatewayMaterialReaderV1(
    {
      async readNamespacedSecret() {
        throw new Error("synthetic-sensitive-detail");
      },
    },
    f.selection.clusterRef,
  );
  await assert.rejects(reader.read(f.selection, new AbortController().signal), denial);
});

test("captured same-instance owner and reader survive replacement without repeated acquisition", async () => {
  const f = sourceFixture();
  f.owner.assertConsumedCurrent = () => {
    throw new Error("replacement");
  };
  f.reader.read = () => {
    throw new Error("replacement");
  };
  f.binding.recipientRef = "replacement";
  const lease = await f.source.acquire();
  assert.equal(lease.binding.recipientRef, "recipient-selected");
  await assert.rejects(f.source.acquire(), denial);
  await lease.withMaterial(async (values) => {
    assert.deepEqual(values.botToken, f.bot);
    return undefined;
  });
  await assert.rejects(
    lease.withMaterial(async () => undefined),
    denial,
  );
  assert.equal(f.reads(), 1);
  assert.equal(await f.source.close(), "finished");
});

test("asynchronous or affirmative currentness cannot substitute a synchronous original check", async () => {
  for (const result of [
    true,
    false,
    {},
    Promise.resolve(undefined),
    Promise.reject(new Error("synthetic-denial")),
  ]) {
    const f = sourceFixture({ current: () => result });
    await assert.rejects(f.source.acquire(), denial);
    assert.equal(f.reads(), 0);
    assert.equal(await f.source.close(), "finished");
  }
});

test("promise-valued remaining time is observed and refused before a get", async () => {
  const f = sourceFixture({ remaining: () => Promise.reject(new Error("synthetic-time")) });
  await assert.rejects(f.source.acquire(), denial);
  assert.equal(f.reads(), 0);
  assert.equal(await f.source.close(), "finished");
});

test("post-get currentness loss refuses the result and clears known owned storage", async () => {
  let denied = false;
  let views;
  const f = sourceFixture({
    current() {
      if (denied) throw new Error("synthetic-denial");
    },
    result(result) {
      views = result.borrow();
      denied = true;
      return result;
    },
  });
  await assert.rejects(f.source.acquire(), denial);
  assert.ok(views.botToken.every((byte) => byte === 0));
  assert.equal(await f.source.close(), "finished");
});

test("close retains its slot until an actual pending read settles", async () => {
  const wait = deferred();
  const started = deferred();
  const f = sourceFixture({
    get: async () => {
      started.resolve();
      return await wait.promise;
    },
  });
  const pending = f.source.acquire();
  void pending.catch(() => undefined);
  await started.promise;
  const closing = f.source.close();
  assert.equal(closing, f.source.close());
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);
  wait.resolve(f.secret);
  await assert.rejects(pending, denial);
  assert.equal(await closing, "finished");
  assert.equal(f.reads(), 1);
});

test("close before the deferred reader callback prevents any get", async () => {
  const f = sourceFixture();
  const pending = f.source.acquire();
  void pending.catch(() => undefined);
  assert.equal(await f.source.close(), "finished");
  await assert.rejects(pending, denial);
  assert.equal(f.reads(), 0);
});

test("the monotonic deadline denies late resolution even before timer callbacks can run", async () => {
  const wait = deferred();
  const started = deferred();
  const f = sourceFixture({
    startup: () => 2,
    get: async () => {
      started.resolve();
      return await wait.promise;
    },
  });
  const pending = f.source.acquire();
  void pending.catch(() => undefined);
  await started.promise;
  const end = performance.now() + 8;
  while (performance.now() < end) {
    /* Deliberately defer timer scheduling. */
  }
  wait.resolve(f.secret);
  await assert.rejects(pending, denial);
  assert.equal(await f.source.close(), "finished");
});

test("close waits for actual trusted consumer settlement before zeroing its views", async () => {
  const f = sourceFixture();
  const lease = await f.source.acquire();
  const wait = deferred();
  let views;
  const use = lease.withMaterial(async (value) => {
    views = value;
    await wait.promise;
    return undefined;
  });
  void use.catch(() => undefined);
  const closing = f.source.close();
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);
  assert.deepEqual(views.botToken, f.bot);
  wait.resolve();
  await assert.rejects(use, denial);
  assert.equal(await closing, "finished");
  assert.ok(views.botToken.every((byte) => byte === 0));
});

test("reentrant close inside the trusted callback still joins the original use", async () => {
  const f = sourceFixture();
  const lease = await f.source.acquire();
  const wait = deferred();
  let closing;
  const use = lease.withMaterial(async () => {
    closing = f.source.close();
    await wait.promise;
    return undefined;
  });
  void use.catch(() => undefined);
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);
  wait.resolve();
  await assert.rejects(use, denial);
  assert.equal(await closing, "finished");
});

test("rejected or non-undefined consumer completion retains storage with unknown cleanup", async () => {
  for (const consume of [
    async () => {
      throw new Error("synthetic-consumer");
    },
    async () => true,
    () => undefined,
  ]) {
    const f = sourceFixture();
    const lease = await f.source.acquire();
    let views;
    await assert.rejects(
      lease.withMaterial((value) => {
        views = value;
        return consume();
      }),
      denial,
    );
    assert.equal(await f.source.close(), "unknown");
    assert.deepEqual(views.botToken, f.bot);
    // Explicit test-fixture cleanup; the source correctly retained the unknown allocation.
    views.botToken.fill(0);
    views.appToken.fill(0);
  }
});

test("confirmed completed use plus a failing final fence does not invent unjoined cleanup", async () => {
  let denied = false;
  const f = sourceFixture({
    current: () => {
      if (denied) throw new Error("synthetic-denial");
    },
  });
  const lease = await f.source.acquire();
  let views;
  await assert.rejects(
    lease.withMaterial(async (value) => {
      views = value;
      denied = true;
      return undefined;
    }),
    denial,
  );
  assert.equal(await f.source.close(), "finished");
  assert.ok(views.botToken.every((byte) => byte === 0));
});

test("original owner invalidation fences a pending consumer and retains the actual join", async () => {
  const f = sourceFixture();
  const lease = await f.source.acquire();
  const wait = deferred();
  const use = lease.withMaterial(async () => {
    await wait.promise;
    return undefined;
  });
  void use.catch(() => undefined);
  f.invalidation.abort();
  assert.equal(lease.signal.aborted, true);
  assert.throws(() => lease.assertCurrent(), denial);
  const closing = lease.close();
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);
  wait.resolve();
  await assert.rejects(use, denial);
  assert.equal(await closing, "finished");
});

test("a reader cannot substitute a different observed logical selection", async () => {
  const f = sourceFixture({
    result: (result) => ({
      ...result,
      observed: { ...result.observed, logicalRevisionRef: "other" },
    }),
  });
  await assert.rejects(f.source.acquire(), denial);
  assert.throws(() => f.lastResult().borrow(), denial);
  assert.equal(await f.source.close(), "finished");
});

test("remaining-time callbacks are contained and re-fenced after their later invocation", async () => {
  for (const action of ["throw", "abort"]) {
    let reads = 0;
    let armed = false;
    let f;
    f = sourceFixture({
      remaining: () => {
        if (armed && ++reads === 2) {
          if (action === "throw") throw new Error("synthetic-private-time-detail");
          f.invalidation.abort();
        }
        return 1_000;
      },
    });
    const lease = await f.source.acquire();
    armed = true;
    assert.throws(() => lease.remainingMs(), denial);
    assert.equal(lease.signal.aborted, true);
    assert.equal(await f.source.close(), "finished");
  }
});

test("remaining time subtracts time spent in the final original-owner fence", async () => {
  let armed = false;
  let fences = 0;
  const f = sourceFixture({
    current: () => {
      if (armed && ++fences === 2) {
        const until = performance.now() + 20;
        while (performance.now() < until) {
          /* Bounded synchronous original fence. */
        }
      }
      return undefined;
    },
  });
  const lease = await f.source.acquire();
  armed = true;
  const before = performance.now();
  const remainder = lease.remainingMs();
  const elapsed = performance.now() - before;
  assert.ok(elapsed >= 20);
  assert.ok(remainder > 0);
  assert.ok(remainder <= 1_000 - elapsed + 1);
  assert.equal(await f.source.close(), "finished");
});
