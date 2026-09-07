import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { registerHooks } from "node:module";
const ownerUrl = new URL("../../packages/occ/src/gateway-startup-v1/owner.ts", import.meta.url)
  .href;
// Resolve the genuine selected local owner source; no replacement API or SDK stub.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openclaw-enterprise/occ/gateway-startup-v1/owner")
      return { url: ownerUrl, shortCircuit: true };
    return next(specifier, context);
  },
});
const { createGatewayStartupServiceSourceV1 } =
  await import("../../apps/gateway/src/startup-service-source.ts");
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
async function tickUntil(check) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await delay(1);
  }
  assert.fail("Controlled operation did not reach its expected boundary");
}

test("one fixed acquisition and one confirmed claim, then current reads", async () => {
  const f = fixture();
  try {
    const handle = await f.source.open();
    assert.ok(handle);
    assert.equal(await f.source.open(), undefined);
    assert.equal((await f.source.consume(handle)).kind, "confirmed");
    assert.equal((await f.source.consume(handle)).kind, "denied");
    assert.equal(await f.source.readClaim(handle), "current");
    assert.deepEqual(f.commands, ["consume-startup", "read-current"]);
    assert.equal(f.opens, 1);
    assert.ok(Object.isFrozen(f.source.binding(handle)));
    assert.ok(Object.isFrozen(f.source.binding(handle).startup));
  } finally {
    assert.equal(await f.source.close(), "finished");
  }
  assert.equal(f.closed, 1);
});

test("copied and foreign handles cannot use the original Source", async () => {
  const f = fixture(),
    other = fixture();
  try {
    const handle = await f.source.open();
    const foreign = await other.source.open();
    assert.equal((await f.source.consume({ ...handle })).kind, "denied");
    assert.equal((await f.source.consume(foreign)).kind, "denied");
    assert.throws(() => f.source.binding({}), /unavailable/);
    assert.equal(f.commands.length, 0);
  } finally {
    await f.source.close();
    await other.source.close();
  }
});

test("Runtime recovery-required closes the source and cannot be retried or read as current", async () => {
  const f = fixture({
    execute: async (_command, _bounds, record) => ({
      kind: "recovery-required",
      operation: record.claim.command,
    }),
  });
  const handle = await f.source.open();
  assert.equal((await f.source.consume(handle)).kind, "unknown");
  assert.equal((await f.source.consume(handle)).kind, "denied");
  assert.equal(await f.source.readClaim(handle), "unavailable");
  assert.equal(await f.source.open(), undefined);
  assert.deepEqual(f.commands, ["consume-startup"]);
  await f.source.close();
  assert.equal(f.closed, 1);
});

test("a mismatched recipient or claim head cannot confirm consume", async (t) => {
  for (const change of [
    (record) => {
      record.claim.recipient.incarnationRef = "replacement";
    },
    (record) => {
      record.claim.beforeHeadVersion = 1;
    },
    (record) => {
      record.claim.command.startup.processGeneration = 2;
    },
  ]) {
    await t.test("wrong original correspondence", async () => {
      const f = fixture({
        execute: async (_command, _bounds, input) => {
          const record = structuredClone(input);
          change(record);
          return { kind: "consumed", record };
        },
      });
      const handle = await f.source.open();
      assert.equal((await f.source.consume(handle)).kind, "unknown");
      await f.source.close();
      assert.equal(f.closed, 1);
    });
  }
});

test("connection loss initiates close before joining a late consume result", async () => {
  let settle;
  const gate = new Promise((resolve) => {
    settle = resolve;
  });
  const f = fixture({
    execute: async (_command, _bounds, record) => {
      await gate;
      return { kind: "consumed", record };
    },
  });
  const handle = await f.source.open();
  let done = false;
  const operation = f.source.consume(handle).then((v) => {
    done = true;
    return v;
  });
  await tickUntil(() => f.commands.length === 1);
  f.abort.abort();
  await tickUntil(() => f.closed === 1);
  assert.equal(done, false);
  settle();
  assert.equal((await operation).kind, "unknown");
  await f.source.close();
  assert.equal(f.closed, 1);
});

test("closing during acquisition owns and closes the late native result", async () => {
  let settle;
  const gate = new Promise((resolve) => {
    settle = resolve;
  });
  const f = fixture({ open: async () => gate });
  const opening = f.source.open();
  await tickUntil(() => f.opens === 1);
  let done = false;
  const closing = f.source.close().then((v) => {
    done = true;
    return v;
  });
  await delay(5);
  assert.equal(done, false);
  settle();
  assert.equal(await opening, undefined);
  assert.equal(await closing, "finished");
  assert.equal(f.closed, 1);
  assert.equal(f.parentSignal.aborted, true);
});

test("native cleanup failure remains retained after spontaneous source loss", async () => {
  const f = fixture({ cleanup: "failed" });
  const handle = await f.source.open();
  f.abort.abort();
  await tickUntil(() => f.closed === 1);
  assert.throws(() => f.source.assertCurrent(handle), /unavailable/);
  assert.equal(await f.source.close(), "failed");
  assert.equal(f.closed, 1);
});

test("absolute source expiry terminates the handle without reconnect", async () => {
  const f = fixture({ connection: { expiresAtMs: Date.now() + 80 } });
  const handle = await f.source.open();
  assert.ok(handle);
  await delay(100);
  assert.throws(() => f.source.assertCurrent(handle), /unavailable/);
  assert.equal(await f.source.open(), undefined);
  await f.source.close();
  assert.equal(f.closed, 1);
});

test("async impostor fence is rejected and its rejection is observed", async () => {
  const f = fixture({ assertOriginal: () => Promise.reject(new Error("unsafe provider detail")) });
  assert.equal(await f.source.open(), undefined);
  assert.equal(f.parentSignal.aborted, true);
  await f.source.close();
});

test("missing native producer is explicit unavailable with zero native acquisition", async () => {
  const source = createGatewayStartupServiceSourceV1(undefined);
  assert.equal(await source.open(), undefined);
  assert.equal(await source.close(), "finished");
});

test("public consume failures stay terminal without claiming a committed wrapper", async (t) => {
  for (const kind of ["denied", "unavailable"]) {
    await t.test(kind, async () => {
      const f = fixture({ execute: async () => ({ kind }) });
      const handle = await f.source.open();
      assert.equal((await f.source.consume(handle)).kind, kind);
      assert.equal((await f.source.consume(handle)).kind, "denied");
      assert.equal(await f.source.readClaim(handle), "unavailable");
      assert.deepEqual(f.commands, ["consume-startup"]);
      await f.source.close();
      assert.equal(f.closed, 1);
    });
  }
});

test("internal transaction wrappers and wrong public success cannot confirm consume", async (t) => {
  for (const make of [
    (record) => ({ kind: "committed", response: { kind: "consumed", record } }),
    (record) => ({ kind: "current", record }),
    () => ({ kind: "rolled-back", response: { kind: "denied" } }),
  ]) {
    await t.test("unexpected result", async () => {
      const f = fixture({ execute: async (_command, _bounds, record) => make(record) });
      const handle = await f.source.open();
      assert.equal((await f.source.consume(handle)).kind, "unknown");
      assert.equal((await f.source.consume(handle)).kind, "denied");
      assert.deepEqual(f.commands, ["consume-startup"]);
      await f.source.close();
      assert.equal(f.closed, 1);
    });
  }
});

test("a lost public consume result closes the original source without retry", async () => {
  const f = fixture({
    execute: async () => {
      throw new Error("controlled lost result");
    },
  });
  const handle = await f.source.open();
  assert.equal((await f.source.consume(handle)).kind, "unknown");
  assert.equal(await f.source.readClaim(handle), "unavailable");
  assert.equal((await f.source.consume(handle)).kind, "denied");
  assert.deepEqual(f.commands, ["consume-startup"]);
  await f.source.close();
  assert.equal(f.closed, 1);
});

test("public current-read failures preserve denial versus unavailable and end the lifetime", async (t) => {
  for (const kind of ["denied", "unavailable", "recovery-required"]) {
    await t.test(kind, async () => {
      const f = fixture({
        execute: async (command, _bounds, record) => {
          if (command.kind === "consume-startup") return { kind: "consumed", record };
          return kind === "recovery-required"
            ? { kind, operation: record.claim.command }
            : { kind };
        },
      });
      const handle = await f.source.open();
      assert.equal((await f.source.consume(handle)).kind, "confirmed");
      assert.equal(
        await f.source.readClaim(handle),
        kind === "recovery-required" ? "unknown" : kind,
      );
      assert.equal(await f.source.readClaim(handle), "unavailable");
      assert.deepEqual(f.commands, ["consume-startup", "read-current"]);
      await f.source.close();
      assert.equal(f.closed, 1);
    });
  }
});

test("material metadata is derived only from the original confirmed receiver", async () => {
  const f = fixture();
  try {
    const handle = await f.source.open();
    assert.throws(() => f.source.materialRequest(handle, "startup-slack-pair"), /unavailable/);
    assert.equal((await f.source.consume(handle)).kind, "confirmed");
    const request = f.source.materialRequest(handle, "startup-slack-pair");
    assert.deepEqual(request, {
      schemaVersion: 1,
      purpose: "read-selected-channel-material",
      use: "startup-slack-pair",
      startup: f.record.acceptance.binding.startup,
      selection: f.record.acceptance.binding.selection,
      consumedClaim: {
        operationRef: f.record.claim.command.operationRef,
        operationDigest: f.record.claim.command.operationDigest,
        afterRecordVersion: f.record.claim.afterRecordVersion,
      },
      recipient: f.record.claim.recipient.recipient,
    });
    assert.ok(Object.isFrozen(request) && Object.isFrozen(request.consumedClaim));
    assert.throws(() => f.source.materialRequest({}, "startup-slack-pair"), /unavailable/);
    assert.throws(() => f.source.materialRequest(handle, "read-current"), /unavailable/);
    assert.ok(f.source.remainingSourceMs(handle) > 0);
    assert.deepEqual(f.commands, ["consume-startup"]);
  } finally {
    await f.source.close();
  }
});

test("Source reserves initial material once, rejects overlap and joins its owned work", async () => {
  const f = fixture();
  let settle;
  try {
    const handle = await f.source.open();
    await f.source.consume(handle);
    const held = new Promise((resolve) => {
      settle = resolve;
    });
    const one = f.source.withMaterialCall(handle, "startup-slack-pair", () => held);
    await assert.rejects(
      f.source.withMaterialCall(handle, "teams-invocation-token", async () => undefined),
      /unavailable/,
    );
    settle();
    await one;
    await assert.rejects(
      f.source.withMaterialCall(handle, "startup-slack-pair", async () => undefined),
      /unavailable/,
    );
    let settleTeams;
    const teams = f.source.withMaterialCall(
      handle,
      "teams-invocation-token",
      () =>
        new Promise((resolve) => {
          settleTeams = resolve;
        }),
    );
    await tickUntil(() => !!settleTeams);
    let closed = false;
    const close = f.source.close().then(() => {
      closed = true;
    });
    await delay(5);
    assert.equal(closed, false);
    settleTeams();
    await teams;
    await close;
  } finally {
    settle?.();
    await f.source.close();
  }
});
