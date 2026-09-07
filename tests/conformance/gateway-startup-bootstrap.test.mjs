import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const ownerUrl = new URL("../../packages/occ/src/gateway-startup-v1/owner.ts", import.meta.url)
  .href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openclaw-enterprise/occ/gateway-startup-v1/owner")
      return { url: ownerUrl, shortCircuit: true };
    return next(specifier, context);
  },
});
const { canonicalGatewayStartupValueV1, gatewayStartupCommandDigestV1 } = await import(ownerUrl);
const { createGatewayStartupServiceSourceV1 } =
  await import("../../apps/gateway/src/startup-service-source.ts");
const { createGatewayStartupBootstrapV1 } =
  await import("../../apps/gateway/src/startup-bootstrap.ts");

const ref = (recordRef) => ({ recordRef, recordVersion: 1 });
function fixture(options = {}) {
  // Actual local Source/bootstrap/Runtime owner bodies, with explicitly controlled
  // native, material and adapter participants. No host or credential is created.
  const startup = {
    installationId: "installation-one",
    processRef: "process-one",
    processGeneration: 1,
    operationRef: "accept-one",
    operationDigest: "a".repeat(64),
  };
  const binding = {
    startup,
    createEffectRef: "effect-one",
    selection: ref("selection-one"),
    configurationRef: "configuration-one",
    configurationVersion: 1,
    profileRef: "profile-one",
    profileVersion: 1,
    namespaceRef: "namespace-one",
    agentRef: "agent-one",
    admittedRevisionRef: "revision-one",
    gatewayAssignmentRef: "gateway-one",
    hostRuntimeGeneration: 2,
    nativeConfigRef: "native-one",
    configDigest: "b".repeat(64),
    stateOwnership: ref("state-one"),
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    protocolVersion: 1,
    modules: [
      { id: "identity", kind: "identity", profileRef: "identity-one", requiredCapabilities: [] },
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
      operationRef: consumeCommand.operationRef,
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
  const nativeAbort = new AbortController(),
    events = [];
  let nativeClose = 0,
    materialClose = 0,
    preparedClose = 0,
    starts = 0,
    consumed = 0,
    borrowed = 0;
  const connection = {
    binding,
    consumeCommand,
    signal: nativeAbort.signal,
    expiresAtMs: Date.now() + 10000,
    assertCurrent() {
      if (nativeAbort.signal.aborted) throw new Error("controlled source closed");
    },
    async recheckCurrent() {},
    async execute(command) {
      events.push(command.kind);
      if (command.kind === "consume-startup") {
        consumed++;
        if (options.consumeWait) await options.consumeWait();
        if (options.unknown) return { kind: "recovery-required", operation: record.claim.command };
      }
      // Controlled native boundary returns the genuine Runtime public result shape.
      return {
        kind: command.kind === "consume-startup" ? "consumed" : "current",
        record,
      };
    },
    async close() {
      nativeClose++;
      nativeAbort.abort();
      return "finished";
    },
  };
  const originals = new WeakSet([connection]);
  const service = createGatewayStartupServiceSourceV1({
    assertOriginal(value) {
      if (!originals.has(value)) throw new Error("controlled foreign connection");
    },
    async open() {
      events.push("authenticate");
      if (options.openWait) await options.openWait();
      return connection;
    },
  });
  const configuration = {
    schemaVersion: 1,
    installationRef: startup.installationId,
    namespaceRef: binding.namespaceRef,
    agentRef: binding.agentRef,
    admittedRevisionRef: binding.admittedRevisionRef,
    gatewayAssignmentRef: binding.gatewayAssignmentRef,
    runtimeGeneration: binding.hostRuntimeGeneration,
    nativeConfigRef: binding.nativeConfigRef,
    configDigest: binding.configDigest,
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    protocolVersion: 1,
    startupDeadlineMs: 3000,
    shutdownDeadlineMs: 3000,
    modules: binding.modules,
  };
  const material = {
    async borrowMaterial() {
      events.push("borrow-material");
      borrowed++;
      assert.equal(consumed, 1);
      return {
        input: { configuration, dependencies: {}, slack: {}, teams: {} },
        assertCurrent() {
          if (nativeAbort.signal.aborted) throw new Error("controlled material revoked");
        },
        async close() {
          materialClose++;
          return "finished";
        },
      };
    },
  };
  const adapter = {
    async prepare() {
      events.push("prepare");
      if (options.prepareWait) await options.prepareWait();
      return {
        start() {
          events.push("start");
          starts++;
          return {
            quiesce() {
              events.push("quiesce");
            },
            startupSettled: Promise.resolve({
              phase: "ready",
              runtimeGeneration: binding.hostRuntimeGeneration,
              admittedRevisionRef: binding.admittedRevisionRef,
            }),
          };
        },
        async close() {
          preparedClose++;
          return { cleanup: "finished" };
        },
      };
    },
  };
  const bootstrap = createGatewayStartupBootstrapV1(
    service,
    options.missingMaterial ? undefined : material,
    adapter,
  );
  return {
    bootstrap,
    service,
    nativeAbort,
    events,
    get consumed() {
      return consumed;
    },
    get borrowed() {
      return borrowed;
    },
    get starts() {
      return starts;
    },
    get nativeClose() {
      return nativeClose;
    },
    get materialClose() {
      return materialClose;
    },
    get preparedClose() {
      return preparedClose;
    },
  };
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(1);
  }
  assert.fail("Controlled bootstrap did not reach expected boundary");
}

test("authenticate and one confirmed claim precede local start and material", async () => {
  const f = fixture();
  try {
    const enrolled = await f.bootstrap.enroll();
    assert.ok(enrolled);
    assert.equal(f.consumed, 1);
    assert.equal(f.borrowed, 0);
    assert.equal(f.starts, 0);
    assert.equal(await f.bootstrap.enroll(), undefined);
    const result = await enrolled.usePort.start(enrolled.recipient, enrolled.startup);
    assert.equal(result.kind, "started");
    assert.equal(f.consumed, 1);
    assert.equal(f.borrowed, 1);
    assert.equal(f.starts, 1);
    assert.ok(f.events.indexOf("authenticate") < f.events.indexOf("consume-startup"));
    assert.ok(f.events.indexOf("consume-startup") < f.events.indexOf("borrow-material"));
    assert.equal(
      (await enrolled.usePort.start(enrolled.recipient, enrolled.startup)).kind,
      "denied",
    );
    await result.lifetime.close();
    assert.equal(f.preparedClose, 1);
    assert.equal(f.materialClose, 1);
  } finally {
    await f.bootstrap.close();
  }
  assert.equal(f.nativeClose, 1);
});

test("unknown consume gives no local enrollment, material, start or retry", async () => {
  const f = fixture({ unknown: true });
  assert.equal(await f.bootstrap.enroll(), undefined);
  assert.equal(await f.bootstrap.enroll(), undefined);
  assert.equal(f.consumed, 1);
  assert.equal(f.borrowed, 0);
  assert.equal(f.starts, 0);
  await f.bootstrap.close();
  assert.equal(f.nativeClose, 1);
});

test("foreign local pairs are refused by the actual Runtime local owner", async () => {
  const a = fixture(),
    b = fixture();
  try {
    const aa = await a.bootstrap.enroll(),
      bb = await b.bootstrap.enroll();
    assert.ok(aa);
    assert.ok(bb);
    assert.equal((await aa.usePort.start(bb.recipient, aa.startup)).kind, "denied");
    assert.equal((await aa.usePort.start({ ...aa.recipient }, aa.startup)).kind, "denied");
    assert.equal(a.starts, 0);
    assert.equal(a.borrowed, 0);
  } finally {
    await a.bootstrap.close();
    await b.bootstrap.close();
  }
});

test("native loss after enrollment never starts the local host", async () => {
  const f = fixture();
  const enrolled = await f.bootstrap.enroll();
  assert.ok(enrolled);
  f.nativeAbort.abort();
  assert.equal((await enrolled.usePort.start(enrolled.recipient, enrolled.startup)).kind, "denied");
  await f.bootstrap.close();
  assert.equal(f.borrowed, 0);
  assert.equal(f.starts, 0);
  assert.equal(f.nativeClose, 1);
});

test("close during authentication joins the original late Source", async () => {
  let settle;
  const gate = new Promise((resolve) => {
    settle = resolve;
  });
  const f = fixture({ openWait: () => gate });
  const opening = f.bootstrap.enroll();
  await until(() => f.events.includes("authenticate"));
  let closed = false;
  const closing = f.bootstrap.close().then((v) => {
    closed = true;
    return v;
  });
  await delay(5);
  assert.equal(closed, false);
  settle();
  assert.equal(await opening, undefined);
  await closing;
  assert.equal(f.consumed, 0);
  assert.equal(f.borrowed, 0);
  assert.equal(f.nativeClose, 1);
});

test("close during pending consume retains its result without enrollment", async () => {
  let settle;
  const gate = new Promise((resolve) => {
    settle = resolve;
  });
  const f = fixture({ consumeWait: () => gate });
  const opening = f.bootstrap.enroll();
  await until(() => f.consumed === 1);
  const closing = f.bootstrap.close();
  await until(() => f.nativeClose === 1);
  settle();
  assert.equal(await opening, undefined);
  await closing;
  assert.equal(f.consumed, 1);
  assert.equal(f.borrowed, 0);
  assert.equal(f.starts, 0);
});

test("revocation during preparation joins the late prepared resource and prevents start", async () => {
  let settle;
  const gate = new Promise((resolve) => {
    settle = resolve;
  });
  const f = fixture({ prepareWait: () => gate });
  const enrolled = await f.bootstrap.enroll();
  const starting = enrolled.usePort.start(enrolled.recipient, enrolled.startup);
  await until(() => f.events.includes("prepare"));
  f.nativeAbort.abort();
  await until(() => f.nativeClose === 1);
  assert.equal(f.starts, 0);
  settle();
  const result = await starting;
  assert.equal(result.kind, "recovery-required");
  assert.equal(f.starts, 0);
  assert.equal(f.preparedClose, 1);
  await f.bootstrap.close();
});

test("missing fixed material producer refuses before service authentication", async () => {
  const f = fixture({ missingMaterial: true });
  assert.equal(await f.bootstrap.enroll(), undefined);
  assert.deepEqual(f.events, []);
  await f.bootstrap.close();
});
