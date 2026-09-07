import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createGatewayMaterialDeliverySourceV1 } from "../../apps/controller/src/credentials/gateway-material-delivery.ts";
import { createKubernetesGatewayMaterialReaderV1 } from "../../apps/controller/src/credentials/kubernetes-gateway-material.ts";
import {
  decodeGatewayChannelMaterialV1,
  GatewayChannelMaterialUnavailableV1,
} from "@openclaw-enterprise/utils/gateway-channel-material";

const denied = (e) =>
  e instanceof GatewayChannelMaterialUnavailableV1 &&
  e.message === "Selected channel material is unavailable.";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
// All owners, requests, clients and values are synthetic. The reduced current
// record deliberately does not claim to pass Runtime's real original authority.
function fixture(options = {}) {
  const invalidation = new AbortController();
  const bot = Buffer.alloc(options.botBytes ?? 3, 0x62);
  const app = Buffer.alloc(options.appBytes ?? 3, 0x61);
  const hash = (x) => createHash("sha256").update(x).digest("hex");
  const selected = {
    startup: { startup: { installationId: "synthetic-installation" } },
    recipientRef: "synthetic-recipient",
    recipientIncarnation: "synthetic-process",
    source: {
      clusterRef: "synthetic-cluster",
      namespace: "synthetic-namespace",
      name: "synthetic-secret",
      uid: "synthetic-uid",
      resourceVersion: "rv-7",
      logicalRevisionRef: "logical-9",
      items: [
        {
          role: "slack-bot",
          key: "bot",
          credentialRef: "bot-ref",
          credentialVersion: 7,
          sha256: hash(bot),
        },
        {
          role: "slack-app",
          key: "app",
          credentialRef: "app-ref",
          credentialVersion: 9,
          sha256: hash(app),
        },
      ],
    },
  };
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    immutable: true,
    metadata: {
      namespace: selected.source.namespace,
      name: selected.source.name,
      uid: selected.source.uid,
      resourceVersion: selected.source.resourceVersion,
    },
    data: { bot: bot.toString("base64"), app: app.toString("base64") },
  };
  let calls = 0;
  let reads = 0;
  let disposed = 0;
  let observedViews;
  const scope = {
    current: {},
    selected,
    signal: invalidation.signal,
    assertCurrent() {
      assert.equal(this, scope);
      calls++;
      if (options.current) return options.current();
      return undefined;
    },
    async recheckCurrent() {
      throw new Error("Runtime-owned recheck is not called by this source");
    },
    remainingMs() {
      assert.equal(this, scope);
      return options.remaining ? options.remaining() : 1_000;
    },
    async confirmDisclosure() {
      throw new Error("Runtime-owned confirmation is not called by this source");
    },
  };
  const client = {
    async readNamespacedSecret(request) {
      assert.equal(this, client);
      reads++;
      assert.deepEqual(request, {
        namespace: selected.source.namespace,
        name: selected.source.name,
      });
      return options.get ? await options.get(secret) : secret;
    },
  };
  const low = createKubernetesGatewayMaterialReaderV1(client, selected.source.clusterRef);
  const reader = {
    async read(binding, signal) {
      assert.equal(this, reader);
      const original = await low.read(binding, signal);
      observedViews = original.borrow();
      return {
        observed: original.observed,
        borrow: original.borrow,
        dispose() {
          disposed++;
          return original.dispose();
        },
      };
    },
  };
  const source = createGatewayMaterialDeliverySourceV1(reader);
  return {
    scope,
    source,
    reader,
    selected,
    secret,
    invalidation,
    reads: () => reads,
    calls: () => calls,
    disposed: () => disposed,
    views: () => observedViews,
  };
}
async function deliver(lease, callback) {
  let retained;
  await lease.withEncodedPayload(async (payload) => {
    assert.equal(payload.byteLength, 16);
    assert.equal(payload.backingByteLength, 6);
    const frame = new Uint8Array(32);
    const view = frame.subarray(16);
    payload.encodeInto(view);
    retained = payload;
    const decoded = decodeGatewayChannelMaterialV1(view, "startup-slack-pair");
    assert.deepEqual([...decoded.botToken], [0x62, 0x62, 0x62]);
    assert.deepEqual([...decoded.appToken], [0x61, 0x61, 0x61]);
    if (callback) await callback({ payload, frame, decoded });
    frame.fill(0);
    return undefined;
  });
  return retained;
}

test("same original held owner surrounds read and joined encoding; both owners dispose their own storage", async () => {
  const f = fixture();
  const lease = await f.source.readSelected(f.scope, "startup-slack-pair");
  const payload = await deliver(lease);
  assert.equal(f.reads(), 1);
  assert.ok(f.calls() > 4);
  assert.ok(f.views().botToken.some((x) => x !== 0));
  await lease.release();
  assert.equal(f.disposed(), 1);
  assert.ok(f.views().botToken.every((x) => x === 0));
  assert.throws(() => payload.encodeInto(new Uint8Array(16)), denied);
  assert.equal(await f.source.close(), "finished");
});
test("Teams and missing genuine scope methods refuse without any read", async () => {
  const f = fixture();
  await assert.rejects(f.source.readSelected(f.scope, "teams-invocation-token"), denied);
  await assert.rejects(
    f.source.readSelected({ selected: f.selected, signal: f.scope.signal }, "startup-slack-pair"),
    denied,
  );
  assert.equal(f.reads(), 0);
  assert.equal(await f.source.close(), "finished");
});
test("original accepting-owner refusal cannot be replaced by selected metadata", async () => {
  const f = fixture({
    current() {
      throw new Error("synthetic sensitive owner detail");
    },
  });
  await assert.rejects(f.source.readSelected(f.scope, "startup-slack-pair"), denied);
  assert.equal(f.reads(), 0);
  await f.source.close();
});
for (const value of [0, -1, NaN, Infinity, "100", Promise.resolve(100)]) {
  test("invalid original remainder refuses before read: " + String(value), async () => {
    const f = fixture({ remaining: () => value });
    await assert.rejects(f.source.readSelected(f.scope, "startup-slack-pair"), denied);
    assert.equal(f.reads(), 0);
    await f.source.close();
  });
}
test("one outstanding acquisition refuses another scope without a hidden queue", async () => {
  const gate = deferred();
  const f = fixture({ get: () => gate.promise });
  const first = f.source.readSelected(f.scope, "startup-slack-pair");
  await tick();
  await assert.rejects(f.source.readSelected({ ...f.scope }, "startup-slack-pair"), denied);
  assert.equal(f.reads(), 1);
  gate.resolve(f.secret);
  const lease = await first;
  await deliver(lease);
  await lease.release();
  await f.source.close();
});
test("cancelled acquisition retains the actual late read until it settles", async () => {
  const gate = deferred();
  const f = fixture({ get: () => gate.promise });
  const task = f.source.readSelected(f.scope, "startup-slack-pair");
  let settled = false;
  void task.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick();
  f.invalidation.abort();
  await tick();
  assert.equal(settled, false);
  const closed = f.source.close();
  let closedSettled = false;
  void closed.then(() => {
    closedSettled = true;
  });
  await tick();
  assert.equal(closedSettled, false);
  gate.resolve(f.secret);
  await assert.rejects(task, denied);
  assert.equal(await closed, "finished");
  assert.equal(f.reads(), 1);
});
test("selection mutation while read is pending rejects the returned result and disposes it", async () => {
  const gate = deferred();
  const f = fixture({ get: () => gate.promise });
  const task = f.source.readSelected(f.scope, "startup-slack-pair");
  await tick();
  f.selected.recipientIncarnation = "changed-process";
  gate.resolve(f.secret);
  await assert.rejects(task, denied);
  assert.equal(f.disposed(), 1);
  await f.source.close();
});
test("same scope cannot be reused after known cleanup; this is only local membership", async () => {
  const f = fixture();
  const lease = await f.source.readSelected(f.scope, "startup-slack-pair");
  await deliver(lease);
  await lease.release();
  await assert.rejects(f.source.readSelected(f.scope, "startup-slack-pair"), denied);
  assert.equal(f.reads(), 1);
  await f.source.close();
});
test("release joins a pending original encoded consumer, without an early zero", async () => {
  const gate = deferred();
  const entered = deferred();
  const f = fixture();
  const lease = await f.source.readSelected(f.scope, "startup-slack-pair");
  const use = deliver(lease, async () => {
    entered.resolve();
    await gate.promise;
  });
  void use.catch(() => {});
  await entered.promise;
  const release = lease.release();
  let released = false;
  void release.then(() => {
    released = true;
  });
  await tick();
  assert.equal(released, false);
  assert.ok(f.views().botToken.some((x) => x !== 0));
  gate.resolve();
  await assert.rejects(use, denied);
  await release;
  assert.equal(f.disposed(), 1);
  await f.source.close();
});
test("unknown native write rejects the borrow and retains source ownership", async () => {
  const f = fixture();
  const lease = await f.source.readSelected(f.scope, "startup-slack-pair");
  await assert.rejects(
    lease.withEncodedPayload(async (payload) => {
      const frame = new Uint8Array(16);
      payload.encodeInto(frame);
      frame.fill(0);
      throw new Error("synthetic unknown native write");
    }),
    denied,
  );
  await assert.rejects(lease.release(), denied);
  assert.equal(await f.source.close(), "unknown");
  assert.equal(f.disposed(), 0);
  assert.ok(f.views().botToken.some((x) => x !== 0));
  await assert.rejects(f.source.readSelected({ ...f.scope }, "startup-slack-pair"), denied);
});
for (const completion of ["unknown", null, false]) {
  test(
    "non-undefined native completion cannot be relabeled joined: " + String(completion),
    async () => {
      const f = fixture();
      const lease = await f.source.readSelected(f.scope, "startup-slack-pair");
      await assert.rejects(
        lease.withEncodedPayload(async (p) => {
          p.encodeInto(new Uint8Array(16));
          return completion;
        }),
        denied,
      );
      await assert.rejects(lease.release(), denied);
      assert.equal(await f.source.close(), "unknown");
    },
  );
}
test("a synchronous work return is not actual asynchronous settlement", async () => {
  const f = fixture();
  const lease = await f.source.readSelected(f.scope, "startup-slack-pair");
  await assert.rejects(
    lease.withEncodedPayload((p) => {
      p.encodeInto(new Uint8Array(16));
    }),
    denied,
  );
  await assert.rejects(lease.release(), denied);
  assert.equal(await f.source.close(), "unknown");
});
test("missing or swallowed second encoding cannot fake successful work", async () => {
  for (const twice of [false, true]) {
    const f = fixture();
    const lease = await f.source.readSelected(f.scope, "startup-slack-pair");
    await assert.rejects(
      lease.withEncodedPayload(async (p) => {
        if (twice) {
          p.encodeInto(new Uint8Array(16));
          assert.throws(() => p.encodeInto(new Uint8Array(16)), denied);
        }
        return undefined;
      }),
      denied,
    );
    await assert.rejects(lease.release(), denied);
    assert.equal(await f.source.close(), "unknown");
  }
});
test("oversize source is a known preflight refusal before any encoder/frame escapes", async () => {
  const f = fixture({ botBytes: 20_000, appBytes: 10_000 });
  const lease = await f.source.readSelected(f.scope, "startup-slack-pair");
  let entered = 0;
  await assert.rejects(
    lease.withEncodedPayload(async () => {
      entered++;
    }),
    denied,
  );
  assert.equal(entered, 0);
  await lease.release();
  assert.equal(f.disposed(), 1);
  assert.equal(await f.source.close(), "finished");
});
test("captured current method cannot be replaced by a permissive callback", async () => {
  let current = true;
  const f = fixture({
    current() {
      if (!current) throw new Error("withdrawn");
    },
  });
  const lease = await f.source.readSelected(f.scope, "startup-slack-pair");
  f.scope.assertCurrent = () => undefined;
  current = false;
  await assert.rejects(
    lease.withEncodedPayload(async () => {}),
    denied,
  );
  await lease.release();
  assert.equal(f.disposed(), 1);
  await f.source.close();
});
test("retained encoder is invalid after the original borrowed work settles", async () => {
  const f = fixture();
  const lease = await f.source.readSelected(f.scope, "startup-slack-pair");
  const encoder = await deliver(lease);
  const target = new Uint8Array(16).fill(0xa5);
  assert.throws(() => encoder.encodeInto(target), denied);
  assert.ok(target.every((x) => x === 0xa5));
  await lease.release();
  await f.source.close();
});
test("a released source denies a later borrow and repeated close shares one result", async () => {
  const f = fixture();
  const lease = await f.source.readSelected(f.scope, "startup-slack-pair");
  await lease.release();
  await assert.rejects(
    lease.withEncodedPayload(async () => {}),
    denied,
  );
  const a = f.source.close();
  const b = f.source.close();
  assert.equal(a, b);
  assert.equal(await a, "finished");
  assert.equal(f.disposed(), 1);
  await assert.rejects(f.source.readSelected({ ...f.scope }, "startup-slack-pair"), denied);
});
