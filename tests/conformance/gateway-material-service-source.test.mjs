import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { registerHooks } from "node:module";
const ownerUrl = new URL("../../packages/occ/src/gateway-startup-v1/owner.ts", import.meta.url)
  .href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openclaw-enterprise/occ/gateway-startup-v1/owner")
      return { url: ownerUrl, shortCircuit: true };
    if (specifier === "@openclaw-enterprise/utils/gateway-channel-material")
      return {
        url: new URL("../../packages/utils/src/gateway-channel-material.ts", import.meta.url).href,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { createGatewayStartupServiceSourceV1 } =
  await import("../../apps/gateway/src/startup-service-source.ts");
const { createGatewayStartupMaterialServiceSourceV1 } =
  await import("../../apps/gateway/src/startup-material-service-source.ts");
const { canonicalGatewayStartupValueV1, gatewayStartupCommandDigestV1 } = await import(ownerUrl);
const ref = (name) => ({ recordRef: name, recordVersion: 1 });
function fixture(overrides = {}) {
  // Controlled participant data only; this fixture creates no native process or identity.
  const startup = {
    installationId: "installation-one",
    processRef: "process-one",
    processGeneration: 1,
    operationRef: "accept-one",
    operationDigest: "a".repeat(64),
  };
  const binding = {
    startup,
    createEffectRef: "create-one",
    selection: ref("selection-one"),
    configurationRef: "configuration-one",
    configurationVersion: 1,
    profileRef: "profile-one",
    profileVersion: 1,
    namespaceRef: "namespace-one",
    agentRef: "agent-one",
    admittedRevisionRef: "revision-one",
    gatewayAssignmentRef: "gateway-one",
    hostRuntimeGeneration: 3,
    nativeConfigRef: "native-one",
    configDigest: "sha256:" + "b".repeat(64),
    stateOwnership: ref("state-one"),
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    protocolVersion: 1,
    modules: [
      { id: "channel", kind: "channel", profileRef: "channel-one", requiredCapabilities: [] },
    ],
    startupDeadlineMs: 3000,
    shutdownDeadlineMs: 3000,
  };
  const recipient = {
    recipient: ref("recipient-one"),
    process: ref("process-one"),
    incarnationRef: "incarnation-one",
    observation: ref("observation-one"),
  };
  const consumeCommand = {
    schemaVersion: 1,
    kind: "consume-startup",
    operationRef: "consume-one",
    startup,
    expectedHead: { version: 2, startup, recordVersion: 2 },
    recipient,
  };
  const claim = {
    kind: "consume-startup",
    command: {
      installationId: startup.installationId,
      operationRef: "consume-one",
      operationDigest: gatewayStartupCommandDigestV1(consumeCommand),
      startup,
    },
    canonicalCommand: canonicalGatewayStartupValueV1(consumeCommand),
    beforeHeadVersion: 2,
    afterHeadVersion: 3,
    beforeRecordVersion: 2,
    afterRecordVersion: 3,
    previousOperationRef: "submit-one",
    startup,
    createEffectRef: binding.createEffectRef,
    acceptance: null,
    submissionInput: null,
    recipient,
    withdrawalReason: null,
    auditEventId: "audit-one",
  };
  const record = {
    head: {
      version: 3,
      processGeneration: 1,
      latestOperationRef: "consume-one",
      startup,
      recordVersion: 3,
      state: "consumed",
    },
    acceptance: {
      binding,
      predecessor: {
        disposition: ref("initial-one"),
        previousStartup: null,
        processOwner: ref("owner-one"),
        settlement: ref("settlement-one"),
      },
      auditEventId: "accept-audit",
    },
    submission: null,
    claim,
  };
  const abort = new AbortController(),
    commands = [];
  let closed = 0,
    opens = 0,
    parentSignal;
  const connection = {
    binding,
    consumeCommand,
    signal: abort.signal,
    expiresAtMs: Date.now() + 10000,
    assertCurrent() {
      if (abort.signal.aborted) throw new Error("controlled closed");
    },
    async recheckCurrent() {},
    async execute(command, bounds) {
      commands.push(command.kind);
      assert.ok(bounds.signal instanceof AbortSignal);
      assert.ok(Date.parse(bounds.deadline) <= connection.expiresAtMs);
      if (overrides.execute) return overrides.execute(command, bounds, record);
      // Controlled native boundary returns the genuine Runtime public result shape.
      return {
        kind: command.kind === "consume-startup" ? "consumed" : "current",
        record,
      };
    },
    async close() {
      closed++;
      return overrides.cleanup ?? "finished";
    },
  };
  Object.assign(connection, overrides.connection);
  const originals = new WeakSet([connection]);
  const producer = {
    assertOriginal(value) {
      if (overrides.assertOriginal) return overrides.assertOriginal(value);
      if (!originals.has(value)) throw new Error("controlled foreign native object");
    },
    async open(signal) {
      opens++;
      parentSignal = signal;
      if (overrides.open) await overrides.open(signal);
      return connection;
    },
  };
  const source = createGatewayStartupServiceSourceV1(producer);
  return {
    source,
    connection,
    abort,
    record,
    commands,
    get closed() {
      return closed;
    },
    get opens() {
      return opens;
    },
    get parentSignal() {
      return parentSignal;
    },
  };
}

async function setup(options = {}) {
  const f = fixture(options.source);
  const parent = await f.source.open();
  if (options.confirm !== false) await f.source.consume(parent);
  const runtimeAbort = new AbortController();
  let joins = 0,
    closes = 0,
    opens = 0,
    uses = 0;
  const runtime = {
    signal: runtimeAbort.signal,
    assertCurrent() {
      if (runtimeAbort.signal.aborted) throw new Error("controlled ended parent");
    },
    remainingStartupMs: () => options.remaining ?? 10000,
    async joinConsumers() {
      joins++;
      if (options.join) await options.join();
    },
    ...options.runtime,
  };
  const originals = new WeakSet();
  const native = {
    assertOriginal(value) {
      if (!originals.has(value)) throw new Error("controlled foreign child");
    },
    async open(original, request, bounds) {
      opens++;
      assert.equal(original, parent);
      if (options.open) await options.open(bounds);
      const stop = new AbortController();
      const connection = {
        profile: "installation-channel-material-v1",
        transport: "owned-child-stdio-installation-channel-material-v1",
        request,
        signal: stop.signal,
        assertCurrent() {
          if (stop.signal.aborted) throw new Error("controlled closed child");
        },
        remainingMs: () => 10000,
        async withPayload(work) {
          uses++;
          if (options.withPayload) return await options.withPayload(work, request, bounds);
          await work(
            {
              schemaVersion: 1,
              purpose: request.purpose,
              use: request.use,
              requestRef: bounds.requestRef,
              kind: "selected-bundle",
            },
            new Uint8Array([0x47, 0x43, 0x4d, 1, 1, 0, 0, 1, 0, 1, 98, 97]),
          );
          return { kind: "delivered" };
        },
        async close() {
          closes++;
          stop.abort();
          if (options.close) return await options.close();
          return "finished";
        },
        ...options.connection,
      };
      if (options.closerAccessor)
        Object.defineProperty(connection, "close", {
          get() {
            throw new Error("controlled inaccessible closer");
          },
        });
      originals.add(connection);
      return connection;
    },
  };
  const material = createGatewayStartupMaterialServiceSourceV1(
    f.source,
    parent,
    options.noRuntime ? undefined : runtime,
    options.noNative ? undefined : native,
  );
  return {
    f,
    parent,
    runtimeAbort,
    runtime,
    native,
    material,
    get joins() {
      return joins;
    },
    get closes() {
      return closes;
    },
    get opens() {
      return opens;
    },
    get uses() {
      return uses;
    },
    async close() {
      await material.close();
      await f.source.close();
    },
  };
}
const success = async () => undefined;

test("separate material call borrows the original frame and does not add a startup method", async () => {
  const f = await setup();
  let observedInsideBorrow = false;
  try {
    assert.equal(
      (
        await f.material.read("startup-slack-pair", async (material) => {
          assert.deepEqual([...material.botToken], [98]);
          assert.deepEqual([...material.appToken], [97]);
          assert.equal(material.botToken.buffer, material.appToken.buffer);
          observedInsideBorrow = true;
        })
      ).kind,
      "delivered",
    );
    assert.equal(observedInsideBorrow, true);
    assert.equal(f.opens, 1);
    assert.equal(f.closes, 1);
    assert.deepEqual(f.f.commands, ["consume-startup", "read-current"]);
    assert.equal((await f.material.read("startup-slack-pair", success)).kind, "unavailable");
    assert.equal(f.opens, 1);
  } finally {
    await f.close();
  }
  assert.equal(f.joins, 1);
});
for (const option of ["noNative", "noRuntime"])
  test(`missing ${option} stays unavailable without material open`, async () => {
    const f = await setup({ [option]: true });
    try {
      assert.equal((await f.material.read("startup-slack-pair", success)).kind, "unavailable");
      assert.equal(f.opens, 0);
    } finally {
      await f.close();
    }
  });
test("unconfirmed parent cannot reserve or open material", async () => {
  const f = await setup({ confirm: false });
  try {
    assert.equal((await f.material.read("startup-slack-pair", success)).kind, "unavailable");
    assert.equal(f.opens, 0);
  } finally {
    await f.close();
  }
});
for (const [name, connection] of [
  ["wrong profile", { profile: "installation-gateway-startup-v1" }],
  ["wrong transport", { transport: "owned-child-stdio-installation-gateway-startup-v1" }],
  ["wrong request", { request: { purpose: "read-selected-channel-material" } }],
  ["expired native remainder", { remainingMs: () => 0 }],
  ["async native fence", { assertCurrent: async () => undefined }],
])
  test(name + " denies and retains acquired child close", async () => {
    const f = await setup({ connection });
    try {
      assert.notEqual((await f.material.read("startup-slack-pair", success)).kind, "delivered");
      await f.material.close();
      assert.equal(f.closes, 1);
    } finally {
      await f.close();
    }
  });
test("unknown native result cannot reconsume or reopen a startup attempt", async () => {
  const f = await setup({ withPayload: async () => ({ kind: "recovery-required" }) });
  try {
    assert.notEqual((await f.material.read("startup-slack-pair", success)).kind, "delivered");
    assert.notEqual((await f.material.read("startup-slack-pair", success)).kind, "delivered");
    assert.equal(f.opens, 1);
    assert.equal(f.f.commands.filter((k) => k === "consume-startup").length, 1);
  } finally {
    await f.close();
  }
});
test("consumer rejection remains unknown and never produces payload result", async () => {
  const f = await setup();
  try {
    const out = await f.material.read("startup-slack-pair", async () => {
      throw new Error("controlled private marker");
    });
    assert.equal(out.kind, "recovery-required");
    assert.deepEqual(Object.keys(out), ["kind"]);
  } finally {
    await f.close();
  }
});
test("native cannot hide a rejected borrowed callback", async () => {
  const f = await setup({
    withPayload: async (work, request, bounds) => {
      await work(
        {
          schemaVersion: 1,
          purpose: request.purpose,
          use: request.use,
          requestRef: bounds.requestRef,
          kind: "selected-bundle",
        },
        new Uint8Array([0x47, 0x43, 0x4d, 1, 1, 0, 0, 1, 0, 1, 98, 97]),
      ).catch(() => {});
      return { kind: "delivered" };
    },
  });
  try {
    assert.equal(
      (
        await f.material.read("startup-slack-pair", async () => {
          throw Error("controlled");
        })
      ).kind,
      "recovery-required",
    );
  } finally {
    await f.close();
  }
});
test("missing qualified Teams source never opens a material child", async () => {
  const f = await setup();
  try {
    assert.equal((await f.material.read("startup-slack-pair", success)).kind, "delivered");
    assert.equal((await f.material.read("teams-invocation-token", success)).kind, "unavailable");
    assert.equal((await f.material.read("teams-invocation-token", success)).kind, "unavailable");
    assert.equal(f.opens, 1);
  } finally {
    await f.close();
  }
});
test("deadline returns bounded uncertainty while a late original acquisition stays owned", async () => {
  let settle;
  const held = new Promise((resolve) => {
    settle = resolve;
  });
  const f = await setup({ remaining: 25, open: () => held });
  const call = f.material.read("startup-slack-pair", success);
  const out = await call;
  assert.equal(out.kind, "recovery-required");
  let closed = false;
  const close = f.material.close().then(() => {
    closed = true;
  });
  await delay(5);
  assert.equal(closed, false);
  assert.equal(f.closes, 0);
  settle();
  await close;
  assert.equal(f.closes, 1);
  await f.f.source.close();
});

for (const [name, mutate] of [
  [
    "wrong request reference",
    (header) => {
      header.requestRef = "different";
    },
  ],
  [
    "wrong selected use",
    (header) => {
      header.use = "teams-invocation-token";
    },
  ],
  [
    "wrong purpose",
    (header) => {
      header.purpose = "read-current";
    },
  ],
  [
    "extra metadata",
    (header) => {
      header.extra = "untrusted";
    },
  ],
])
  test(name + " denies before consumer use", async () => {
    let consumed = false;
    const f = await setup({
      withPayload: async (work, request, bounds) => {
        const header = {
          schemaVersion: 1,
          purpose: request.purpose,
          use: request.use,
          requestRef: bounds.requestRef,
          kind: "selected-bundle",
        };
        mutate(header);
        await work(header, new Uint8Array([0x47, 0x43, 0x4d, 1, 1, 0, 0, 1, 0, 1, 98, 97]));
        return { kind: "delivered" };
      },
    });
    try {
      assert.equal(
        (
          await f.material.read("startup-slack-pair", async () => {
            consumed = true;
          })
        ).kind,
        "recovery-required",
      );
      assert.equal(consumed, false);
    } finally {
      await f.close();
    }
  });

test("actual codec rejects malformed payload without material string/result exposure", async () => {
  let consumed = false;
  const f = await setup({
    withPayload: async (work, request, bounds) => {
      await work(
        {
          schemaVersion: 1,
          purpose: request.purpose,
          use: request.use,
          requestRef: bounds.requestRef,
          kind: "selected-bundle",
        },
        new Uint8Array([47, 43]),
      );
      return { kind: "delivered" };
    },
  });
  try {
    const out = await f.material.read("startup-slack-pair", async () => {
      consumed = true;
    });
    assert.deepEqual(out, { kind: "recovery-required" });
    assert.equal(consumed, false);
  } finally {
    await f.close();
  }
});

test("shorter native remainder bounds a stalled borrow and retains its actual settlement", async () => {
  let settle;
  const gate = new Promise((resolve) => {
    settle = resolve;
  });
  const f = await setup({ connection: { remainingMs: () => 20 }, withPayload: () => gate });
  const started = Date.now();
  const out = await f.material.read("startup-slack-pair", success);
  assert.equal(out.kind, "recovery-required");
  assert.ok(Date.now() - started < 1000);
  let closed = false;
  const close = f.material.close().then(() => {
    closed = true;
  });
  await delay(5);
  assert.equal(closed, false);
  settle({ kind: "unavailable" });
  await close;
  await f.f.source.close();
});

test("one outstanding call has no queue, including across receiver wrappers", async () => {
  let settle;
  const gate = new Promise((resolve) => {
    settle = resolve;
  });
  const f = await setup({ withPayload: () => gate });
  const first = f.material.read("startup-slack-pair", success);
  assert.equal((await f.material.read("startup-slack-pair", success)).kind, "unavailable");
  const second = createGatewayStartupMaterialServiceSourceV1(
    f.f.source,
    f.parent,
    f.runtime,
    f.native,
  );
  assert.equal((await second.read("startup-slack-pair", success)).kind, "unavailable");
  await second.close();
  while (f.uses === 0) await delay(1);
  settle({ kind: "unavailable" });
  await first;
  await f.close();
  assert.equal(f.opens, 1);
});

test("settled frame borrow is distinct from other Runtime resource shutdown", async () => {
  let settle;
  const gate = new Promise((resolve) => {
    settle = resolve;
  });
  const f = await setup({ join: () => gate });
  assert.equal((await f.material.read("startup-slack-pair", success)).kind, "delivered");
  let closed = false;
  const close = f.material.close().then(() => {
    closed = true;
  });
  await delay(5);
  assert.equal(closed, false);
  assert.equal(f.closes, 1);
  settle();
  await close;
  await f.f.source.close();
});

for (const [name, options] of [
  ["missing", { connection: { close: undefined } }],
  ["non-callable", { connection: { close: 17 } }],
  ["throwing accessor", { closerAccessor: true }],
])
  test("returned native with " + name + " closer retains unknown cleanup", async () => {
    const f = await setup(options);
    const out = await f.material.read("startup-slack-pair", success);
    assert.notEqual(out.kind, "delivered");
    assert.equal(await f.material.close(), "unknown");
    assert.equal(f.opens, 1);
    assert.equal(f.closes, 0);
    await f.f.source.close();
    assert.equal(await f.material.close(), "unknown");
  });
for (const kind of ["denied", "unavailable"])
  test("known native " + kind + " remains distinct from uncertain delivery", async () => {
    const f = await setup({ withPayload: async () => ({ kind }) });
    try {
      assert.deepEqual(await f.material.read("startup-slack-pair", success), { kind });
      assert.equal(await f.material.close(), "finished");
    } finally {
      await f.f.source.close();
    }
  });
test("native frame close waits for the original callback's complete view use", async () => {
  let settle,
    entered = false;
  const held = new Promise((resolve) => {
    settle = resolve;
  });
  const f = await setup();
  const call = f.material.read("startup-slack-pair", async (material) => {
    entered = true;
    assert.equal(material.botToken[0], 98);
    await held;
    assert.equal(material.appToken[0], 97);
  });
  while (!entered) await delay(1);
  assert.equal(f.closes, 0);
  settle();
  assert.equal((await call).kind, "delivered");
  assert.equal(f.closes, 1);
  await f.close();
});
