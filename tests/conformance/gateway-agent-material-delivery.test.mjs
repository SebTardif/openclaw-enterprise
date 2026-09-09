import test from "node:test";
import assert from "node:assert/strict";
import {
  createGatewayMaterialDeliveryV1,
  createGatewayMaterialDeliveryV2,
  parseGatewayMaterialDeliveryRequestV1,
  parseGatewayMaterialDeliveryRequestV2,
} from "../../packages/occ/src/gateway-startup-v1/material-delivery.ts";
import { createGatewayStartupMaterialServiceSourceV2 } from "../../apps/gateway/src/startup-material-service-source.ts";
import { controlledAgentBootstrap } from "../fixtures/gateway-startup-v2/local-bootstrap.mjs";

// Actual V2 parser, history correspondence, local permit and Source owners.
// Native transport, account/registration/current selection and bytes are controlled
// here. The separate native test supplies actual Go/TLS, never production custody.
async function fixture() {
  const f = controlledAgentBootstrap();
  assert.ok(await f.bootstrap.enroll());
  const request = f.service.materialRequest(f.handle, "startup-slack-pair");
  const events = [];
  const ref = (recordRef) => ({ recordRef, recordVersion: 1 });
  const association = {
    startup: f.binding.startup,
    createEffectRef: f.binding.createEffectRef,
    recipient: f.record.claim.recipient,
    registration: ref("registration"),
    sourceConfiguration: ref("source"),
    endpoints: {
      gateway: { serviceRef: "gateway", spiffeId: "spiffe://fixture/gateway" },
      controller: { serviceRef: "controller", spiffeId: "spiffe://fixture/controller" },
      transportRecipientRef: "controller",
    },
  };
  const abort = new AbortController();
  const bounds = {
    requestRef: "material",
    deadline: new Date(Date.now() + 4000).toISOString(),
    signal: abort.signal,
  };
  let router;
  let replay = false;
  const native = {
    profile: "installation-channel-material-v1",
    transport: "owned-child-stdio-installation-channel-material-v1",
    association,
    signal: abort.signal,
    assertCurrent() {
      abort.signal.throwIfAborted();
    },
    remainingMs: () => 4000,
    async disclose(header, payload, permit) {
      const target = new Uint8Array(payload.byteLength);
      try {
        payload.encodeInto(target);
        await router.confirmDisclosure(permit, native, header, payload);
        router.consumeDisclosure(permit, native, header, payload);
        events.push("write");
        if (replay)
          assert.throws(
            () => router.consumeDisclosure(permit, native, header, payload),
            /unavailable/,
          );
      } finally {
        target.fill(0);
      }
    },
    async close() {
      events.push("native-close");
    },
  };
  const scope = {
    current: structuredClone(f.record),
    selected: Object.freeze({ fixture: true }),
    signal: abort.signal,
    assertCurrent() {
      abort.signal.throwIfAborted();
    },
    remainingMs: () => 4000,
    async recheckCurrent() {
      events.push("recheck");
    },
    async confirmDisclosure() {
      events.push("confirm");
    },
  };
  const options = {
    native: {
      async inspect() {
        events.push("inspect");
        return native;
      },
    },
    current: {
      async withCurrent(observed, actualNative, _bounds, work) {
        assert.deepEqual(observed, request);
        assert.equal(actualNative, native);
        events.push("current");
        try {
          return await work(scope);
        } finally {
          events.push("scope-close");
        }
      },
    },
    source: {
      async readSelected(actual, use) {
        assert.equal(actual, scope);
        assert.equal(use, request.use);
        events.push("read");
        return {
          signal: abort.signal,
          assertCurrent() {
            abort.signal.throwIfAborted();
          },
          remainingMs: () => 4000,
          async withEncodedPayload(work) {
            return await work({
              byteLength: 3,
              backingByteLength: 3,
              encodeInto(target) {
                events.push("encode");
                target.set([1, 2, 3]);
              },
            });
          },
          async release() {
            events.push("bundle-close");
          },
        };
      },
    },
  };
  router = createGatewayMaterialDeliveryV2(options);
  return {
    ...f,
    original: f,
    router,
    request,
    association,
    native,
    scope,
    options,
    events,
    bounds,
    replay() {
      replay = true;
    },
    run(input = request) {
      return router.execute(input, {}, bounds);
    },
    async close() {
      await router.close();
      await f.bootstrap.close();
    },
  };
}

test("V2 material metadata uses closed Agent scope and four-field selection", async () => {
  const f = await fixture();
  try {
    const parsed = parseGatewayMaterialDeliveryRequestV2(f.request);
    assert.deepEqual(parsed, f.request);
    assert.ok(Object.isFrozen(parsed.startup.subject));
    assert.equal(Object.hasOwn(parsed.selection, "recordRef"), false);
    assert.throws(() => parseGatewayMaterialDeliveryRequestV1(parsed));
    const legacy = createGatewayMaterialDeliveryV1({});
    assert.deepEqual(await legacy.execute(parsed, {}, f.bounds), { kind: "denied" });
    await legacy.close();
    for (const mutate of [
      (r) => (r.schemaVersion = 1),
      (r) => (r.selection = { recordRef: "old", recordVersion: 1 }),
      (r) => (r.startup.subject.namespaceRef = ""),
      (r) => (r.startup.subject.agentRef = ""),
      (r) => (r.startup.subject.installationId = ""),
      (r) => (r.material = "caller-selection"),
    ]) {
      const changed = structuredClone(parsed);
      mutate(changed);
      assert.throws(() => parseGatewayMaterialDeliveryRequestV2(changed));
      assert.deepEqual(await f.run(changed), { kind: "denied" });
    }
    assert.deepEqual(f.events, []);
  } finally {
    await f.close();
  }
});

test("V2 current owner confirms the exact original claim before one controlled disclosure", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.run(), { kind: "delivered" });
    await f.router.close();
    assert.deepEqual(f.events, [
      "inspect",
      "current",
      "recheck",
      "read",
      "encode",
      "recheck",
      "confirm",
      "write",
      "bundle-close",
      "scope-close",
      "native-close",
    ]);
    assert.equal(f.original.events.filter((x) => x === "consume-startup").length, 1);
  } finally {
    await f.close();
  }
});

for (const [name, change] of [
  ["head Agent", (c) => (c.head.subject.agentRef = "another-agent")],
  ["binding selection", (c) => c.acceptance.binding.selection.admissionVersion++],
  ["missing submission", (c) => (c.submission = null)],
  ["submission binding", (c) => (c.submission.submissionInput.binding.agentRef = "another-agent")],
  ["claim subject", (c) => (c.claim.command.subject.namespaceRef = "another-namespace")],
  ["claim chain", (c) => (c.claim.previousOperationRef = "another-submission")],
  ["predecessor kind", (c) => (c.acceptance.predecessor.kind = "unknown")],
  ["initial predecessor", (c) => (c.acceptance.predecessor.previousStartup = c.head.startup)],
])
  test(`V2 ${name} mismatch cannot disclose selected material`, async () => {
    const f = await fixture();
    try {
      change(f.scope.current);
      assert.deepEqual(await f.run(), { kind: "unavailable" });
      assert.equal(f.events.includes("read"), false);
    } finally {
      await f.close();
    }
  });

test("V2 replayed local disclosure permit poisons the same owned call", async () => {
  const f = await fixture();
  try {
    f.replay();
    assert.deepEqual(await f.run(), { kind: "recovery-required" });
    assert.equal(f.events.filter((x) => x === "write").length, 1);
  } finally {
    await f.close();
  }
});

test("V2 material Source retains its original Agent parent and unavailable native outcome", async () => {
  const f = await fixture();
  let opens = 0,
    closed = 0;
  const originals = new WeakSet();
  const producer = {
    assertOriginal(c) {
      assert.ok(originals.has(c));
      c.assertCurrent();
    },
    async open(parent, request, bounds) {
      opens++;
      assert.equal(parent, f.original.handle);
      assert.deepEqual(request, f.request);
      assert.ok(bounds.signal instanceof AbortSignal);
      const c = {
        profile: "installation-channel-material-v1",
        transport: "owned-child-stdio-installation-channel-material-v1",
        request,
        signal: bounds.signal,
        assertCurrent() {
          bounds.signal.throwIfAborted();
        },
        remainingMs: () => 4000,
        async withPayload() {
          return { kind: "unavailable" };
        },
        async close() {
          closed++;
          return "finished";
        },
      };
      originals.add(c);
      return c;
    },
  };
  const source = createGatewayStartupMaterialServiceSourceV2(
    f.original.service,
    f.original.handle,
    f.original.materialParent,
    producer,
  );
  try {
    assert.deepEqual(
      await source.read("startup-slack-pair", async () => assert.fail("No material was received")),
      { kind: "unavailable" },
    );
    assert.notEqual(
      (await source.read("startup-slack-pair", async () => undefined)).kind,
      "delivered",
    );
    assert.equal(opens, 1);
    assert.equal(closed, 1);
  } finally {
    await source.close();
    await f.close();
  }
});
