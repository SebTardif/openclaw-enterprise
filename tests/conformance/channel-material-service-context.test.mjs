import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createChannelMaterialNativeServiceV1 } from "../../apps/controller/src/admission/channel-material-service-context.ts";
import {
  createGatewayMaterialDeliveryV1,
  parseGatewayMaterialDeliveryRequestV1,
} from "../../packages/occ/src/gateway-startup-v1/material-delivery.ts";

// Synthetic metadata exercises the actual private-source denials. No test DTO
// supplies a native proof, current claim, registration or credential selection.
function fixture() {
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
  const hash = `sha256:${"1".repeat(64)}`;
  const profile = {
    schemaVersion: 1,
    operationPolicy: "installation-channel-material-v1",
    sourceRef: "source/physical-native",
    sourceConfigurationDigest: hash,
    workloadApiSocketPath: "/nonexistent-material-fixture/api.sock",
    ownSPIFFEId: association.endpoints.controller.spiffeId,
    peerSPIFFEId: association.endpoints.gateway.spiffeId,
    recipientRef: "service/controller",
    recipientSPIFFEId: association.endpoints.controller.spiffeId,
    trustDomain: "gateway.test",
    trustRootsRef: "roots/gateway",
    trustBundleSha256: hash,
    verifierProfileRef: "verifier/gateway",
    nativeExecutableSha256: hash,
    transportProfileRef: "owned-child-stdio-installation-channel-material-v1",
    limits: {
      handshakeTimeoutMs: 3000,
      recheckIntervalMs: 1000,
      maxConnectionAgeMs: 5000,
      maxConnections: 1,
      requestTimeoutMs: 5000,
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
  const controller = new AbortController();
  let native,
    registration,
    service,
    count = 0,
    currentCalls = 0,
    materialReads = 0;
  const options = {
    binaryPath: "/nonexistent-material-fixture/oce-runtime-authority",
    listenAddress: "127.0.0.1:1",
    configurationVersion: 2,
    profile,
    association,
    signal: controller.signal,
    deadline: new Date(Date.now() + 4000).toISOString(),
    compose(source, original) {
      native = source;
      registration = original;
      count++;
      service = createGatewayMaterialDeliveryV1({
        native: source,
        current: {
          async withCurrent() {
            currentCalls++;
            throw new Error("No selected current provider");
          },
        },
        source: {
          async readSelected() {
            materialReads++;
            throw new Error("No selected material provider");
          },
        },
      });
      return service;
    },
  };
  return {
    options,
    request,
    controller,
    get native() {
      return native;
    },
    get registration() {
      return registration;
    },
    get service() {
      return service;
    },
    get count() {
      return count;
    },
    get currentCalls() {
      return currentCalls;
    },
    get materialReads() {
      return materialReads;
    },
  };
}

test("actual material source and coordinator deny foreign proof without native or material activity", async () => {
  const f = fixture(),
    context = createChannelMaterialNativeServiceV1(f.options);
  assert.deepEqual(parseGatewayMaterialDeliveryRequestV1(f.request), f.request);
  const bounds = {
    requestRef: "request/material",
    deadline: f.options.deadline,
    signal: new AbortController().signal,
  };
  for (const proof of [
    {},
    Object.freeze({}),
    { ...f.options.association },
    { valid: true, profile: f.options.profile },
    { consumed: true, request: f.request },
  ]) {
    assert.equal(await f.native.inspect(proof, f.request, bounds), undefined);
    assert.equal(f.registration.originalFor(f.request, bounds), undefined);
    assert.equal(f.registration.inspectOriginal(proof, f.request, bounds), undefined);
    assert.equal((await f.service.execute(f.request, proof, bounds)).kind, "unavailable");
  }
  assert.equal(f.currentCalls, 0);
  assert.equal(f.materialReads, 0);
  assert.equal(f.count, 1);
  await context.close();
  assert.equal(context.signal.aborted, true);
});

for (const [name, change] of [
  [
    "startup policy",
    (f) => {
      f.options.profile.operationPolicy = "installation-gateway-startup-v1";
    },
  ],
  [
    "old transport",
    (f) => {
      f.options.profile.transportProfileRef = "owned-child-stdio-installation-gateway-startup-v1";
    },
  ],
  [
    "recipient cast to Gateway",
    (f) => {
      f.options.profile.recipientSPIFFEId = f.options.profile.peerSPIFFEId;
    },
  ],
  [
    "different Controller",
    (f) => {
      f.options.association.endpoints.controller.spiffeId = "spiffe://gateway.test/service/other";
    },
  ],
  [
    "local recipient as transport",
    (f) => {
      f.options.profile.recipientRef = "recipient/gateway";
    },
  ],
  [
    "longer age",
    (f) => {
      f.options.profile.limits.maxConnectionAgeMs = 30000;
    },
  ],
  [
    "second connection",
    (f) => {
      f.options.profile.limits.maxConnections = 2;
    },
  ],
  [
    "invalid configuration",
    (f) => {
      f.options.configurationVersion = 0;
    },
  ],
  [
    "expired original lifetime",
    (f) => {
      f.options.deadline = new Date(Date.now() - 1).toISOString();
    },
  ],
  [
    "aborted original lifetime",
    (f) => {
      f.controller.abort();
    },
  ],
])
  test(`material construction rejects ${name} before composition`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => createChannelMaterialNativeServiceV1(f.options));
    assert.equal(f.count, 0);
  });

test("original lifetime abort is terminal and cannot be repaired by changing input configuration", async () => {
  const f = fixture(),
    context = createChannelMaterialNativeServiceV1(f.options);
  f.controller.abort();
  f.options.deadline = new Date(Date.now() + 50000).toISOString();
  assert.equal(context.signal.aborted, true);
  await assert.rejects(context.start(), /unavailable/);
  await context.close();
  await context.close();
  assert.equal(f.count, 1);
  assert.equal(f.materialReads, 0);
});

test("closed material context cannot launch or issue proof through another context", async () => {
  const a = fixture(),
    b = fixture();
  const first = createChannelMaterialNativeServiceV1(a.options),
    second = createChannelMaterialNativeServiceV1(b.options);
  await first.close();
  const bounds = {
    requestRef: "request/material",
    deadline: b.options.deadline,
    signal: b.controller.signal,
  };
  assert.equal(await b.native.inspect(first, b.request, bounds), undefined);
  await assert.rejects(first.start(), /unavailable/);
  await second.close();
  assert.equal(a.materialReads + b.materialReads, 0);
});

test("close joins the actual pending executable verification without launching a child", async () => {
  const f = fixture(),
    context = createChannelMaterialNativeServiceV1(f.options);
  let startupFinished = false;
  const starting = context.start().finally(() => {
    startupFinished = true;
  });
  const denied = assert.rejects(starting, /unavailable/);
  await context.close();
  assert.equal(startupFinished, true);
  await denied;
  assert.equal(f.currentCalls, 0);
  assert.equal(f.materialReads, 0);
});

test("throwing trusted composition retains no original lifetime listener", () => {
  const f = fixture(),
    before = getEventListeners(f.controller.signal, "abort").length;
  f.options.compose = () => {
    throw new Error("synthetic composition rejection");
  };
  assert.throws(() => createChannelMaterialNativeServiceV1(f.options), /unavailable/);
  assert.equal(getEventListeners(f.controller.signal, "abort").length, before);
});

test("ordinary failed start closes the captured service and releases its original listener", async (t) => {
  const f = fixture(),
    compose = f.options.compose;
  let closes = 0;
  f.options.compose = (...args) => {
    const original = compose(...args);
    return Object.freeze({
      ...original,
      async close() {
        closes++;
        await original.close();
      },
    });
  };
  const before = getEventListeners(f.controller.signal, "abort").length;
  const context = createChannelMaterialNativeServiceV1(f.options);
  t.after(() => context.close());
  await assert.rejects(context.start(), /unavailable/);
  assert.equal(closes, 1);
  assert.equal(getEventListeners(f.controller.signal, "abort").length, before);
});
