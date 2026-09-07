import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  GATEWAY_CHANNEL_MATERIAL_LIMITS_V1 as limits,
  GatewayChannelMaterialUnavailableV1,
  gatewayChannelMaterialEncodedLengthV1 as length,
  encodeGatewayChannelMaterialIntoV1 as encode,
  decodeGatewayChannelMaterialV1 as decode,
} from "@openclaw-enterprise/utils/gateway-channel-material";

// All values are synthetic. These tests do not authenticate or deliver material.
const denied = (e) =>
  e instanceof GatewayChannelMaterialUnavailableV1 &&
  e.message === "Selected channel material is unavailable.";
function material(bot = [0x62, 0x6f, 0x74], app = [0x61, 0x70, 0x70]) {
  const backing = new Uint8Array(bot.length + app.length);
  backing.set(bot);
  backing.set(app, bot.length);
  return {
    use: "startup-slack-pair",
    botToken: backing.subarray(0, bot.length),
    appToken: backing.subarray(bot.length),
  };
}
function frame(m) {
  const n = length(m);
  const owned = new Uint8Array(n + 24);
  const payload = owned.subarray(24);
  encode(m, payload);
  return { owned, payload };
}

test("canonical GCM1 wire matches an independently specified byte vector", () => {
  const m = material();
  const { payload } = frame(m);
  assert.deepEqual(
    [...payload],
    [0x47, 0x43, 0x4d, 1, 1, 0, 0, 3, 0, 3, 0x62, 0x6f, 0x74, 0x61, 0x70, 0x70],
  );
  const decoded = decode(payload, "startup-slack-pair");
  assert.equal(decoded.use, "startup-slack-pair");
  assert.equal(decoded.botToken.buffer, payload.buffer);
  assert.equal(decoded.appToken.buffer, payload.buffer);
  assert.equal(decoded.botToken.byteOffset, payload.byteOffset + 10);
  assert.equal(decoded.appToken.byteOffset, payload.byteOffset + 13);
});
test("receiver views observe disposal of the exact original frame", () => {
  const { owned, payload } = frame(material());
  const decoded = decode(payload, "startup-slack-pair");
  owned.fill(0);
  assert.deepEqual([...decoded.botToken], [0, 0, 0]);
  assert.deepEqual([...decoded.appToken], [0, 0, 0]);
});
test("fixed nonzero target offset preserves every surrounding frame byte", () => {
  const m = material();
  const owned = new Uint8Array(64).fill(0xa5);
  const view = owned.subarray(19, 19 + length(m));
  assert.equal(encode(m, view), length(m));
  assert.ok(owned.subarray(0, 19).every((x) => x === 0xa5));
  assert.ok(owned.subarray(19 + length(m)).every((x) => x === 0xa5));
});
test("maximum 28KiB payload includes codec overhead; one extra byte is rejected", () => {
  const m = material(new Array(limits.payloadBytes - 11).fill(0x61), [0x62]);
  assert.equal(length(m), limits.payloadBytes);
  const target = new Uint8Array(limits.frameBytes).subarray(0, limits.payloadBytes);
  encode(m, target);
  assert.equal(decode(target, m.use).appToken.length, 1);
  assert.throws(
    () => length(material(new Array(limits.payloadBytes - 10).fill(0x61), [0x62])),
    denied,
  );
});
test("UTF8 multi-byte values round-trip without a decoded string allocation", () => {
  const m = material([0xc2, 0xa2, 0xe2, 0x82, 0xac], [0xf0, 0x90, 0x8d, 0x88]);
  const { payload } = frame(m);
  const decoded = decode(payload, m.use);
  assert.deepEqual([...decoded.botToken], [...m.botToken]);
  assert.deepEqual([...decoded.appToken], [...m.appToken]);
});
for (const bad of [
  [0],
  [0x80],
  [0xc0, 0x80],
  [0xc2],
  [0xe0, 0x80, 0x80],
  [0xed, 0xa0, 0x80],
  [0xf0, 0x80, 0x80, 0x80],
  [0xf4, 0x90, 0x80, 0x80],
  [0xff],
]) {
  test("invalid UTF8 or NUL is rejected before target writes: " + bad.join("-"), () => {
    const m = material(bad, [0x61]);
    const target = new Uint8Array(10 + bad.length + 1).fill(0xa5);
    assert.throws(() => encode(m, target), denied);
    assert.ok(target.every((x) => x === 0xa5));
    const wire = new Uint8Array([0x47, 0x43, 0x4d, 1, 1, 0, 0, bad.length, 0, 1, ...bad, 0x61]);
    assert.throws(() => decode(wire, "startup-slack-pair"), denied);
  });
}
test("zero-length roles, wrong use and extra source fields are closed", () => {
  assert.throws(() => length(material([], [0x61])), denied);
  assert.throws(() => length(material([0x61], [])), denied);
  assert.throws(() => length({ ...material(), use: "teams-invocation-token" }), denied);
  assert.throws(() => length({ ...material(), refreshToken: "synthetic-extra" }), denied);
});
test("source buffers must be one dedicated complete adjacent backing", () => {
  const a = new Uint8Array(4).fill(0x61);
  const b = new Uint8Array(4).fill(0x62);
  assert.throws(() => length({ use: "startup-slack-pair", botToken: a, appToken: b }), denied);
  const whole = new Uint8Array(20).fill(0x61);
  assert.throws(
    () =>
      length({
        use: "startup-slack-pair",
        botToken: whole.subarray(3, 6),
        appToken: whole.subarray(6, 9),
      }),
    denied,
  );
  assert.throws(
    () =>
      length({
        use: "startup-slack-pair",
        botToken: whole.subarray(0, 11),
        appToken: whole.subarray(10),
      }),
    denied,
  );
});
test("source shared or resizable backing is refused", () => {
  for (const backing of [new SharedArrayBuffer(6), new ArrayBuffer(6, { maxByteLength: 12 })]) {
    const whole = new Uint8Array(backing).fill(0x61);
    assert.throws(
      () =>
        length({
          use: "startup-slack-pair",
          botToken: whole.subarray(0, 3),
          appToken: whole.subarray(3),
        }),
      denied,
    );
  }
});
test("target shared, resizable, oversized or wrong-length backing is refused before writes", () => {
  const m = material();
  const targets = [
    new Uint8Array(new SharedArrayBuffer(16)),
    new Uint8Array(new ArrayBuffer(16, { maxByteLength: 32 })),
    new Uint8Array(limits.frameBytes + 1).subarray(0, 16),
    new Uint8Array(17),
    new Uint8Array(15),
  ];
  for (const target of targets) {
    target.fill(0xa5);
    assert.throws(() => encode(m, target), denied);
    assert.ok(target.every((x) => x === 0xa5));
  }
});
test("decoder rejects wrong version/use/reserved/magic and mismatched expected use", () => {
  for (const index of [0, 1, 2, 3, 4, 5]) {
    const { payload } = frame(material());
    payload[index] ^= 0x80;
    assert.throws(() => decode(payload, "startup-slack-pair"), denied);
  }
  assert.throws(() => decode(frame(material()).payload, "teams-invocation-token"), denied);
});
test("decoder requires exact lengths and no truncation or trailing material", () => {
  const good = frame(material()).payload;
  for (const wire of [
    good.subarray(0, 15),
    Uint8Array.from([...good, 0x61]),
    Uint8Array.from([0x47, 0x43, 0x4d, 1, 1, 0, 0, 0, 0, 6, ...good.subarray(10)]),
  ]) {
    assert.throws(() => decode(wire, "startup-slack-pair"), denied);
  }
});
test("decoder rejects shared, resizable and oversized backing despite a short view", () => {
  const good = frame(material()).payload;
  for (const backing of [
    new SharedArrayBuffer(16),
    new ArrayBuffer(16, { maxByteLength: 32 }),
    new ArrayBuffer(limits.frameBytes + 1),
  ]) {
    const view = new Uint8Array(backing, 0, 16);
    view.set(good);
    assert.throws(() => decode(view, "startup-slack-pair"), denied);
  }
});
test("dedicated Buffer source and Buffer frame use the same zero-copy format", () => {
  const backing = Buffer.alloc(6, 0x61);
  const m = {
    use: "startup-slack-pair",
    botToken: backing.subarray(0, 3),
    appToken: backing.subarray(3),
  };
  const target = Buffer.alloc(16);
  encode(m, target);
  assert.equal(decode(target, m.use).botToken.buffer, target.buffer);
});

test("intrinsic backing checks reject shadowed resizable and oversized allocation claims", () => {
  const m = material();
  for (const backing of [new ArrayBuffer(16, { maxByteLength: 32 }), new ArrayBuffer(40_000)]) {
    Object.defineProperty(backing, "resizable", { value: false });
    Object.defineProperty(backing, "byteLength", { value: 16 });
    const target = new Uint8Array(backing, 0, 16).fill(0xa5);
    assert.throws(() => encode(m, target), denied);
    assert.ok(target.every((x) => x === 0xa5));
  }
});
test("accessor source operands cannot replace the preflight selection", () => {
  const m = material();
  let reads = 0;
  const operand = {
    use: m.use,
    get botToken() {
      reads++;
      return m.botToken;
    },
    appToken: m.appToken,
  };
  assert.throws(() => length(operand), denied);
  assert.equal(reads, 0);
});
test("typed-array property shadows do not change actual view boundaries", () => {
  const m = material();
  const target = new Uint8Array(16);
  Object.defineProperty(target, "byteLength", { value: 1 });
  Object.defineProperty(target, "buffer", { value: new ArrayBuffer(1) });
  assert.equal(encode(m, target), 16);
  const decoded = decode(target, m.use);
  assert.deepEqual([...decoded.botToken], [0x62, 0x6f, 0x74]);
});
