import nodeTest, { mock } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Transform } from "node:stream";
import { createGatewayChannelMaterialClientV1 } from "../../apps/gateway/src/channel-material-client.ts";
import {
  createMaterialFrameV1,
  materialFrameKinds as kinds,
  materialMetadataTextV1,
  readMaterialFrameV1,
  writeMaterialFrameV1,
} from "../../packages/utils/src/native-material-wire.ts";

// Controlled pipe/Source fixtures only: no executable, TLS, credential, provider,
// registration or real startup authority is created or qualified by these tests.
const test = (name, body) => nodeTest(name, { timeout: 5000 }, body);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const wireHash = (value) => hash(materialMetadataTextV1(value));
const fixtureBinary = Buffer.from("controlled non-executable fixture bytes");
// A real pipe copies written bytes before its completion callback. PassThrough
// retains the sender's backing, which this protocol correctly zeroes on completion.
const fixturePipe = () =>
  new Transform({
    transform(chunk, _encoding, done) {
      done(null, Uint8Array.from(chunk));
    },
  });

function fixture(t, changes = {}) {
  const record = (recordRef) => ({ recordRef, recordVersion: 1 });
  const startup = {
    installationId: "ins_11111111-1111-4111-8111-111111111111",
    processRef: "process/gateway",
    processGeneration: 1,
    operationRef: "operation/startup",
    operationDigest: "1".repeat(64),
  };
  const association = {
    startup,
    createEffectRef: "effect/create",
    recipient: {
      recipient: record("recipient/gateway"),
      process: record("process/gateway"),
      incarnationRef: "incarnation/gateway",
      observation: record("observation/gateway"),
    },
    registration: record("registration/gateway"),
    sourceConfiguration: record("selected/native-source"),
    endpoints: {
      gateway: { serviceRef: "service/gateway", spiffeId: "spiffe://gateway.test/service/gateway" },
      controller: {
        serviceRef: "service/controller",
        spiffeId: "spiffe://gateway.test/service/controller",
      },
      transportRecipientRef: "service/controller",
    },
  };
  const request = {
    schemaVersion: 1,
    purpose: "read-selected-channel-material",
    use: "startup-slack-pair",
    startup,
    selection: record("selection/channel"),
    consumedClaim: {
      operationRef: "operation/consume",
      operationDigest: "2".repeat(64),
      afterRecordVersion: 3,
    },
    recipient: record("recipient/gateway"),
  };
  const profile = {
    schemaVersion: 1,
    operationPolicy: "installation-channel-material-v1",
    sourceRef: "source/physical-native",
    sourceConfigurationDigest: `sha256:${"3".repeat(64)}`,
    workloadApiSocketPath: "/controlled-not-opened/api.sock",
    ownSPIFFEId: association.endpoints.gateway.spiffeId,
    peerSPIFFEId: association.endpoints.controller.spiffeId,
    recipientRef: "service/controller",
    recipientSPIFFEId: association.endpoints.controller.spiffeId,
    trustDomain: "gateway.test",
    trustRootsRef: "roots/gateway",
    trustBundleSha256: `sha256:${"4".repeat(64)}`,
    verifierProfileRef: "verifier/gateway",
    nativeExecutableSha256: hash(fixtureBinary),
    transportProfileRef: "owned-child-stdio-installation-channel-material-v1",
    limits: {
      handshakeTimeoutMs: 3000,
      recheckIntervalMs: 1000,
      maxConnectionAgeMs: 5000,
      maxConnections: 1,
      requestTimeoutMs: 5000,
    },
  };
  const parent = Object.freeze({}),
    abort = new AbortController(),
    events = [],
    nativeTasks = [],
    protocolFailures = [];
  const handles = new WeakSet([parent]);
  let current = true,
    child,
    spawnCount = 0,
    sourceChecks = 0,
    fileClosed = 0,
    observedDeadline;
  const source = {
    assertCurrent(handle) {
      sourceChecks++;
      if (!handles.has(handle) || !current || abort.signal.aborted)
        throw new Error("Controlled Source refused");
      return changes.syncFence?.();
    },
    materialRequest(handle, use) {
      if (!handles.has(handle) || use !== request.use) throw new Error("Controlled Source refused");
      return request;
    },
    signal(handle) {
      if (!handles.has(handle)) throw new Error("Controlled Source refused");
      return abort.signal;
    },
    remainingSourceMs() {
      return 4000;
    },
    async recheckCurrent(handle) {
      await changes.recheck?.();
      source.assertCurrent(handle);
    },
  };
  const options = {
    binaryPath: "/controlled-not-executed/oce-runtime-authority",
    address: "127.0.0.1:4242",
    configurationVersion: 2,
    profile,
    association,
  };
  const bounds = {
    requestRef: "request/material",
    deadline: new Date(Date.now() + 4000).toISOString(),
    signal: abort.signal,
  };
  const files = mock.method(fsPromises, "open", async () => {
    events.push("executable-check");
    return {
      async stat() {
        return {
          isFile: () => true,
          size: fixtureBinary.length,
          mode: 0o100755,
          uid: process.getuid?.() ?? 0,
          ctimeMs: 1,
          mtimeMs: 1,
        };
      },
      async read(buffer, offset, length, position) {
        fixtureBinary.copy(buffer, offset, position, position + length);
        return { bytesRead: length };
      },
      async close() {
        fileClosed++;
      },
    };
  });
  const spawner = mock.method(childProcess, "spawn", (path, args, supplied) => {
    spawnCount++;
    assert.equal(path, options.binaryPath);
    assert.deepEqual(args, ["channel-material-client"]);
    assert.deepEqual(supplied.env, {});
    child = new EventEmitter();
    child.stdin = fixturePipe();
    child.stdout = fixturePipe();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    const end = deferred();
    child.stdin.on("end", () => {
      events.push("parent-eof");
      end.resolve();
    });
    let closed = false;
    child.kill = (signal) => {
      events.push(signal);
      closeChild();
      return true;
    };
    const closeChild = () => {
      if (closed) return;
      closed = true;
      end.resolve();
      child.exitCode = 0;
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    };
    const task = (async () => {
      let frame;
      try {
        frame = await readMaterialFrameV1(child.stdin, new AbortController().signal);
        const bootstrap = frame.metadata;
        observedDeadline = bootstrap.deadline;
        assert.equal(frame.kind, kinds.bootstrap);
        assert.equal(bootstrap.profileDigest, wireHash(profile));
        frame.release();
        const hello = {
          schemaVersion: 1,
          sequence: 1,
          connectionId: "a".repeat(32),
          exchangeId: "b".repeat(32),
          challenge: "c".repeat(32),
          requestDigest: "",
          deadline: "",
          message: {
            incarnation: bootstrap.incarnation,
            configurationVersion: 2,
            profileDigest: bootstrap.profileDigest,
            inspection: {
              valid: true,
              ownSPIFFEId: profile.ownSPIFFEId,
              peerSPIFFEId: profile.peerSPIFFEId,
              recipientSPIFFEId: profile.recipientSPIFFEId,
              authenticatedAt: new Date(Date.now() - 10).toISOString(),
              expiresAt: bootstrap.deadline,
              peerCertificateSha256: `sha256:${"5".repeat(64)}`,
            },
            expiresAt: bootstrap.deadline,
          },
        };
        changes.hello?.(hello);
        await writeMaterialFrameV1(
          child.stdout,
          createMaterialFrameV1(kinds.connected, hello),
          new AbortController().signal,
        );
        frame = await readMaterialFrameV1(child.stdin, new AbortController().signal, frame);
        const event = frame.metadata;
        assert.equal(frame.kind, kinds.request);
        // Independently pinned SHA256 of this exact sorted-key fixture request,
        // not the input object's insertion order or an imported parser result.
        assert.equal(
          event.requestDigest,
          "sha256:ff53414b0226b93e3437a0f6379fe80671097ac1f13322be3db3e9273635b28c",
        );
        assert.deepEqual(event.message.request, request);
        frame.release();
        const header = {
          schemaVersion: 1,
          purpose: request.purpose,
          use: request.use,
          requestRef: bounds.requestRef,
          kind: changes.resultKind ?? "selected-bundle",
        };
        const reply = { ...event, message: header };
        changes.reply?.(reply);
        const result = createMaterialFrameV1(
          kinds.result,
          reply,
          header.kind === "selected-bundle" ? 3 : 0,
        );
        result.payload.set(header.kind === "selected-bundle" ? [11, 22, 33] : []);
        await writeMaterialFrameV1(child.stdout, result, new AbortController().signal);
        frame = await readMaterialFrameV1(child.stdin, new AbortController().signal, frame);
        assert.equal(frame.kind, kinds.completed);
        assert.deepEqual(frame.metadata, { ...event, message: {} });
        events.push("ack-observed");
        frame.release();
        // The real peer performs a final read and waits for parent EOF after ACK.
        child.stdin.resume();
        await end.promise;
      } catch (error) {
        if (error?.code === "ERR_ASSERTION") protocolFailures.push(error);
        // Cancellation/refusal deliberately closes this controlled pipe. The
        // test separately checks no ACK/consumer invocation escaped that path.
      } finally {
        closeChild();
      }
    })();
    nativeTasks.push(task);
    return child;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    abort.abort();
    await Promise.allSettled(nativeTasks);
    spawner.mock.restore();
    files.mock.restore();
    syncBuiltinESMExports();
    assert.deepEqual(protocolFailures, []);
  });
  const producer = createGatewayChannelMaterialClientV1(source, options);
  return {
    producer,
    parent,
    request,
    bounds,
    abort,
    source,
    options,
    events,
    nativeTasks,
    failStderr() {
      child.stderr.emit("error", new Error("controlled private stderr failure"));
    },
    invalidate() {
      current = false;
    },
    get spawnCount() {
      return spawnCount;
    },
    get sourceChecks() {
      return sourceChecks;
    },
    get fileClosed() {
      return fileClosed;
    },
    get observedDeadline() {
      return observedDeadline;
    },
  };
}

// Serial mocks replace only the actual Node filesystem/spawn edges. Actual
// production framing, parent checks and factory membership remain under test.
test("payload is retired before ACK; IDN post-fence precedes explicit EOF and join", async (t) => {
  const f = fixture(t),
    connection = await f.producer.open(f.parent, f.request, f.bounds);
  assert.equal(f.producer.assertOriginal(connection), undefined);
  let borrowed;
  assert.deepEqual(
    await connection.withPayload(async (header, bytes) => {
      assert.equal(header.use, f.request.use);
      assert.equal(header.requestRef, f.bounds.requestRef);
      assert.deepEqual([...bytes], [11, 22, 33]);
      borrowed = bytes;
      f.events.push("callback-settled");
    }),
    { kind: "delivered" },
  );
  assert.deepEqual([...borrowed], [0, 0, 0]);
  await tick();
  assert.ok(f.events.includes("ack-observed"));
  assert.ok(!f.events.includes("parent-eof"));
  assert.equal(connection.assertCurrent(), undefined);
  f.events.push("idn-post-fence");
  assert.equal(await connection.close(), "finished");
  assert.ok(f.events.indexOf("callback-settled") < f.events.indexOf("ack-observed"));
  assert.ok(f.events.indexOf("idn-post-fence") < f.events.indexOf("parent-eof"));
  assert.equal(f.spawnCount, 1);
  assert.equal(f.fileClosed, 1);
  assert.throws(() => f.producer.assertOriginal({ ...connection }));
  assert.throws(() => connection.assertCurrent());
});

test("foreign parent and changed consumed request refuse before executable or child", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.producer.open({}, f.request, f.bounds));
  await assert.rejects(
    f.producer.open(
      f.parent,
      { ...f.request, consumedClaim: { ...f.request.consumedClaim, afterRecordVersion: 4 } },
      f.bounds,
    ),
  );
  assert.equal(f.spawnCount, 0);
  assert.ok(!f.events.includes("executable-check"));
});

test("one active child has no open queue and one payload invocation", async (t) => {
  const f = fixture(t),
    c = await f.producer.open(f.parent, f.request, f.bounds);
  await assert.rejects(f.producer.open(f.parent, f.request, f.bounds));
  const gate = deferred(),
    entered = deferred();
  const read = c.withPayload(async () => {
    entered.resolve();
    await gate.promise;
  });
  await Promise.race([entered.promise, read]);
  await assert.rejects(c.withPayload(async () => {}));
  gate.resolve();
  await read;
  await c.close();
  assert.equal(f.spawnCount, 1);
});

test("abort retains callback/backing and occupied slot until late settlement", async (t) => {
  const f = fixture(t),
    c = await f.producer.open(f.parent, f.request, f.bounds);
  const gate = deferred(),
    entered = deferred();
  let borrowed;
  const read = c.withPayload(async (_header, bytes) => {
    borrowed = bytes;
    entered.resolve();
    await gate.promise;
  });
  const rejected = assert.rejects(read);
  await Promise.race([entered.promise, read]);
  f.abort.abort();
  let settled = false;
  const closing = c.close().then((value) => {
    settled = true;
    return value;
  });
  await tick();
  assert.equal(settled, false);
  assert.deepEqual([...borrowed], [11, 22, 33]);
  await assert.rejects(f.producer.open(f.parent, f.request, f.bounds));
  gate.resolve();
  await rejected;
  await closing;
  assert.deepEqual([...borrowed], [0, 0, 0]);
  assert.ok(!f.events.includes("ack-observed"));
});

test("currentness loss after callback withholds ACK", async (t) => {
  const f = fixture(t),
    c = await f.producer.open(f.parent, f.request, f.bounds);
  await assert.rejects(
    c.withPayload(async () => {
      f.invalidate();
    }),
  );
  await c.close();
  assert.ok(!f.events.includes("ack-observed"));
});

test("callback non-undefined outcome cannot ACK", async (t) => {
  const f = fixture(t),
    c = await f.producer.open(f.parent, f.request, f.bounds);
  await assert.rejects(c.withPayload(async () => ({ accepted: true })));
  await c.close();
  assert.ok(!f.events.includes("ack-observed"));
});

for (const kind of ["denied", "unavailable", "recovery-required"]) {
  test(`native ${kind} is correlated and never invokes payload consumer`, async (t) => {
    const f = fixture(t, { resultKind: kind }),
      c = await f.producer.open(f.parent, f.request, f.bounds);
    let called = false;
    assert.deepEqual(
      await c.withPayload(async () => {
        called = true;
      }),
      { kind },
    );
    assert.equal(called, false);
    await c.close();
  });
}

for (const [name, mutate] of [
  [
    "challenge",
    (reply) => {
      reply.challenge = "d".repeat(32);
    },
  ],
  [
    "exchange",
    (reply) => {
      reply.exchangeId = "d".repeat(32);
    },
  ],
  [
    "wire digest",
    (reply) => {
      reply.requestDigest = `sha256:${"6".repeat(64)}`;
    },
  ],
  [
    "deadline",
    (reply) => {
      reply.deadline = new Date(Date.now() + 10000).toISOString();
    },
  ],
  [
    "request reference",
    (reply) => {
      reply.message.requestRef = "request/other";
    },
  ],
  [
    "use",
    (reply) => {
      reply.message.use = "teams-invocation-token";
    },
  ],
]) {
  test(`different ${name} refuses before callback and ACK`, async (t) => {
    const f = fixture(t, { reply: mutate }),
      c = await f.producer.open(f.parent, f.request, f.bounds);
    let called = false;
    await assert.rejects(
      c.withPayload(async () => {
        called = true;
      }),
    );
    await c.close();
    assert.equal(called, false);
    assert.ok(!f.events.includes("ack-observed"));
  });
}

test("wrong authenticated peer refuses before material request", async (t) => {
  const f = fixture(t, {
    hello: (hello) => {
      hello.message.inspection.peerSPIFFEId = "spiffe://gateway.test/service/other";
    },
  });
  await assert.rejects(f.producer.open(f.parent, f.request, f.bounds));
  assert.equal(f.spawnCount, 1);
  assert.ok(!f.events.includes("ack-observed"));
});

test("cancellation while Source recheck is pending cannot spawn after late settlement", async (t) => {
  const gate = deferred(),
    entered = deferred();
  const f = fixture(t, {
    recheck: async () => {
      entered.resolve();
      await gate.promise;
    },
  });
  const opening = f.producer.open(f.parent, f.request, f.bounds),
    rejected = assert.rejects(opening);
  await entered.promise;
  f.abort.abort();
  await tick();
  await assert.rejects(f.producer.open(f.parent, f.request, f.bounds));
  gate.resolve();
  await rejected;
  assert.equal(f.spawnCount, 0);
  assert.ok(!f.events.includes("executable-check"));
});

test("expired or aborted bounds never start native work", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.producer.open(f.parent, f.request, {
      ...f.bounds,
      deadline: new Date(Date.now() - 1).toISOString(),
    }),
  );
  f.abort.abort();
  await assert.rejects(f.producer.open(f.parent, f.request, f.bounds));
  assert.equal(f.spawnCount, 0);
});

test("an invalid asynchronous synchronous fence stays owned until it settles", async (t) => {
  const gate = deferred();
  const f = fixture(t, { syncFence: () => gate.promise });
  const opening = f.producer.open(f.parent, f.request, f.bounds),
    rejected = assert.rejects(opening);
  await tick();
  await assert.rejects(f.producer.open(f.parent, f.request, f.bounds));
  gate.resolve();
  await rejected;
  assert.equal(f.spawnCount, 0);
  assert.ok(!f.events.includes("executable-check"));
});

test("synchronous abort listeners receive the same already published close", async (t) => {
  const f = fixture(t),
    c = await f.producer.open(f.parent, f.request, f.bounds);
  let nested;
  c.signal.addEventListener(
    "abort",
    () => {
      nested = c.close();
    },
    { once: true },
  );
  const first = c.close();
  assert.strictEqual(nested, first);
  assert.strictEqual(c.close(), first);
  await first;
});

test("successive wall observations cannot extend the original command deadline", async (t) => {
  const f = fixture(t),
    actualNow = Date.now.bind(Date);
  let calls = 0;
  const clock = mock.method(Date, "now", () => actualNow() + calls++);
  t.after(() => clock.mock.restore());
  const c = await f.producer.open(f.parent, f.request, f.bounds);
  assert.ok(Date.parse(f.observedDeadline) <= Date.parse(f.bounds.deadline));
  await c.close();
});

test("owned stderr error is observed and joins the same failed close without ACK", async (t) => {
  const f = fixture(t),
    c = await f.producer.open(f.parent, f.request, f.bounds);
  assert.doesNotThrow(() => f.failStderr());
  await assert.rejects(c.withPayload(async () => {}));
  assert.equal(await c.close(), "failed");
  assert.ok(!f.events.includes("ack-observed"));
});
