import assert from "node:assert/strict";
import test from "node:test";
import { snapshotCanonicalJsonV1 } from "../../packages/occ/src/credential-broker-v1/schema-json.ts";

const limits = { maxBytes: 65_536, maxDepth: 32 };
const snapshot = (input, bounds = limits) => snapshotCanonicalJsonV1(input, bounds);
const denied = (input, bounds = limits) =>
  assert.throws(() => snapshot(input, bounds), /^Error: INVALID_VALUE$/);

test("canonical JSON matches independent protocol vectors and UTF-16 key ordering", () => {
  const vectors = [
    [{ b: true, a: 1 }, '{"a":1,"b":true}'],
    [[3, 1, null, false], "[3,1,null,false]"],
    [-0, "0"],
    [1e21, "1e+21"],
    [JSON.parse('"\\u00e9"'), '"é"'],
    ['line\n"\\', '"line\\n\\"\\\\"'],
    [{ "\ue000": 1, "\ud83d\ude00": 2 }, '{"😀":2,"":1}'],
    [{ z: { b: 2, a: [true, "x"] }, a: null }, '{"a":null,"z":{"a":[true,"x"],"b":2}}'],
  ];
  for (const [input, expected] of vectors) assert.equal(snapshot(input).canonicalJson, expected);
  assert.equal(snapshot("\ud800").canonicalJson, '"\\ud800"');
});

test("snapshots own immutable data without aliasing or prototype setters", () => {
  const input = JSON.parse('{"__proto__":{"enabled":true},"items":[{"n":1}]}');
  const result = snapshot(input);
  input.items[0].n = 9;
  input.__proto__.enabled = false;
  assert.equal(result.value.items[0].n, 1);
  assert.equal(result.value.__proto__.enabled, true);
  assert.equal(Object.getPrototypeOf(result.value), null);
  for (const value of [
    result,
    result.value,
    result.value.items,
    result.value.items[0],
    result.value.__proto__,
  ])
    assert.ok(Object.isFrozen(value));
  assert.throws(() => {
    result.value.items[0].n = 8;
  }, TypeError);
  const shared = { n: 1 };
  assert.equal(snapshot([shared, shared]).canonicalJson, '[{"n":1},{"n":1}]');
});

test("malformed values deny before getters, toJSON or proxy traps execute", () => {
  let calls = 0;
  const getter = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      calls++;
      throw new Error("private");
    },
  });
  const toJSON = {
    toJSON() {
      calls++;
      return {};
    },
  };
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        return [];
      },
      getPrototypeOf() {
        calls++;
        return Object.prototype;
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const hidden = Object.defineProperty({}, "x", { value: 1 });
  const symbol = { [Symbol("x")]: 1 };
  const sparse = new Array(2);
  const extended = [1];
  extended.extra = 2;
  const arrayGetter = Object.defineProperty([1], "0", {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  const cycle = {};
  cycle.self = cycle;
  for (const input of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    () => 1,
    Symbol(),
    getter,
    toJSON,
    proxy,
    revoked.proxy,
    hidden,
    symbol,
    sparse,
    extended,
    arrayGetter,
    cycle,
    new Date(),
    new Map(),
    new Number(1),
    new Uint8Array(1),
    Object.create({ inherited: 1 }),
  ])
    denied(input);
  const limitGetter = Object.defineProperty({ maxDepth: 1 }, "maxBytes", {
    get() {
      calls++;
      return 10;
    },
  });
  denied(null, limitGetter);
  denied(null, proxy);
  assert.equal(calls, 0);
});

test("UTF-8 byte, escaped text and root-zero depth bounds are exact", () => {
  assert.equal(snapshot("é", { maxBytes: 4, maxDepth: 1 }).canonicalJson, '"é"');
  denied("é", { maxBytes: 3, maxDepth: 1 });
  assert.equal(snapshot("\n", { maxBytes: 4, maxDepth: 1 }).canonicalJson, '"\\n"');
  denied("\n", { maxBytes: 3, maxDepth: 1 });
  assert.equal(snapshot({ x: 0 }, { maxBytes: 7, maxDepth: 1 }).canonicalJson, '{"x":0}');
  denied({ x: 0 }, { maxBytes: 6, maxDepth: 1 });
  assert.equal(snapshot([0], { maxBytes: 3, maxDepth: 1 }).canonicalJson, "[0]");
  denied([[0]], { maxBytes: 10, maxDepth: 1 });
  let chain = 0;
  for (let index = 0; index < 32; index++) chain = [chain];
  snapshot(chain);
  denied([chain]);
  assert.equal(snapshot(0, { maxBytes: 1, maxDepth: 1 }).canonicalJson, "0");
  denied(null, { maxBytes: 1, maxDepth: 1 });
  snapshot("x".repeat(65_534));
  denied("x".repeat(65_535));
});

test("finite operand and node ceilings deny unsupported runtime inputs", () => {
  for (const bounds of [
    null,
    undefined,
    false,
    {},
    { maxBytes: 0, maxDepth: 1 },
    { maxBytes: 65_537, maxDepth: 1 },
    { maxBytes: 8, maxDepth: 0 },
    { maxBytes: 8, maxDepth: 33 },
    { maxBytes: 8.5, maxDepth: 1 },
    { maxBytes: 8, maxDepth: NaN },
    { maxBytes: "8", maxDepth: 1 },
  ]) {
    // Passing undefined explicitly must exercise the runtime API, not our test default.
    assert.throws(() => snapshotCanonicalJsonV1(null, bounds), /^Error: INVALID_VALUE$/);
  }
  snapshot(Array(8_191).fill(0));
  denied(Array(8_192).fill(0));
  denied(Array(4_096).fill({ a: 0 }));
});
