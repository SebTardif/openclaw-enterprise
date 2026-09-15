import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { createDestinationSelector } from "../../apps/credential-gateway/src/transport/destination.ts";
import {
  assertAddress,
  deferred,
  destinationConfig as config,
  destinationError,
  destinationHarness,
  dnsFailure,
  selectionBounds as bounds,
} from "../helpers/credential-gateway-destination.mjs";

// Independent numerical boundary vectors include the complete denied intervals.
const ipv4Intervals = [
  ["0.0.0.0", "0.255.255.255"],
  ["10.0.0.0", "10.255.255.255"],
  ["100.64.0.0", "100.127.255.255"],
  ["127.0.0.0", "127.255.255.255"],
  ["169.254.0.0", "169.254.255.255"],
  ["172.16.0.0", "172.31.255.255"],
  ["192.0.0.0", "192.0.0.255"],
  ["192.0.2.0", "192.0.2.255"],
  ["192.31.196.0", "192.31.196.255"],
  ["192.52.193.0", "192.52.193.255"],
  ["192.88.99.0", "192.88.99.255"],
  ["192.168.0.0", "192.168.255.255"],
  ["192.175.48.0", "192.175.48.255"],
  ["198.18.0.0", "198.19.255.255"],
  ["198.51.100.0", "198.51.100.255"],
  ["203.0.113.0", "203.0.113.255"],
  ["224.0.0.0", "239.255.255.255"],
  ["240.0.0.0", "255.255.255.255"],
];
const ipv4PublicNeighbors = [
  "1.0.0.0",
  "9.255.255.255",
  "11.0.0.0",
  "100.63.255.255",
  "100.128.0.0",
  "126.255.255.255",
  "128.0.0.0",
  "169.253.255.255",
  "169.255.0.0",
  "172.15.255.255",
  "172.32.0.0",
  "191.255.255.255",
  "192.0.1.0",
  "192.0.1.255",
  "192.0.3.0",
  "192.31.195.255",
  "192.31.197.0",
  "192.52.192.255",
  "192.52.194.0",
  "192.88.98.255",
  "192.88.100.0",
  "192.167.255.255",
  "192.169.0.0",
  "192.175.47.255",
  "192.175.49.0",
  "198.17.255.255",
  "198.20.0.0",
  "198.51.99.255",
  "198.51.101.0",
  "203.0.112.255",
  "203.0.114.0",
  "223.255.255.255",
];
const ipv6Blocked = [
  "1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "4000::",
  "::",
  "::1",
  "fc00::",
  "fe80::1",
  "ff02::1",
  "2001::",
  "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff",
  "2001:db8::",
  "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
  "2002::",
  "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "2620:4f:8000::",
  "2620:4f:8000:ffff:ffff:ffff:ffff:ffff",
  "3fff::",
  "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
  "::ffff:140.82.112.3",
  "::140.82.112.3",
  "64:ff9b::8c52:7003",
  "64:ff9b:1::1",
];
const ipv6PublicAddresses = [
  "2000::",
  "3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "2001:200::",
  "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff",
  "2001:db9::",
  "2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "2003::",
  "2620:4f:7fff:ffff:ffff:ffff:ffff:ffff",
  "2620:4f:8001::",
  "3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "3fff:1000::",
  "2606:50C0:8000::153",
  "2606:50c0:8000:0000:0000:0000:0000:0153",
];

for (const { name, family, permitted, addresses } of [
  {
    name: "IPv4 denied interval endpoints",
    family: 4,
    permitted: false,
    addresses: ipv4Intervals.flat(),
  },
  { name: "IPv4 public neighbors", family: 4, permitted: true, addresses: ipv4PublicNeighbors },
  {
    name: "IPv6 denied envelope and exception boundaries",
    family: 6,
    permitted: false,
    addresses: ipv6Blocked,
  },
  {
    name: "IPv6 public envelope and exception neighbors",
    family: 6,
    permitted: true,
    addresses: ipv6PublicAddresses,
  },
  {
    name: "malformed and wrong-family A records",
    family: 4,
    permitted: false,
    addresses: [
      "127.1",
      "0140.82.112.3",
      "140.82.112.3:443",
      " 140.82.112.3",
      "https://github.com",
      "[2606:50c0::1]",
      "2606:50c0::1%eth0",
      "2606::1.2.3.4",
      "bad",
      "",
      null,
      false,
      "2606:50c0::1",
    ],
  },
  {
    name: "malformed and wrong-family AAAA records",
    family: 6,
    permitted: false,
    addresses: [
      "140.82.112.3",
      "[2606:50c0::1]",
      "2606:50c0::1%eth0",
      "2606::1.2.3.4",
      " 2606:50c0::1",
      "2606:50c0:::1",
      "2606:50c0::10000",
      "2606:50c0::1:443:99999",
    ],
  },
]) {
  test(name, async (t) => {
    for (const address of addresses)
      await t.test(String(address), () => assertAddress(address, family, permitted));
  });
}

for (const { name, v4, v6, code } of [
  { name: "unsafe A alongside public A", v4: ["140.82.112.3", "10.0.0.1"], code: "address-denied" },
  {
    name: "unsafe AAAA alongside public A",
    v4: ["140.82.112.3"],
    v6: ["fe80::1"],
    code: "address-denied",
  },
  {
    name: "unsafe AAAA alongside public AAAA",
    v4: [],
    v6: ["2606:50c0::1", "::1"],
    code: "address-denied",
  },
  { name: "empty answers", v4: [], code: "empty-answer" },
  { name: "null answers", v4: null, code: "dns-failure" },
  { name: "boolean answers", v4: false, code: "dns-failure" },
  { name: "sparse answers", v4: Array(1), code: "address-denied" },
  { name: "oversized answer set", v4: Array(33).fill("140.82.112.3"), code: "answer-limit" },
  { name: "oversized address", v4: ["a".repeat(46)], code: "address-denied" },
  ...["ENOTFOUND", "ECANCELLED", "ETIMEOUT", undefined].map((code) => ({
    name: `AAAA failure ${code} despite public A`,
    v6: dnsFailure(code),
    code: "dns-failure",
  })),
  {
    name: "synchronous DNS failure",
    v4: () => {
      throw new Error("sync DNS failure");
    },
    code: "dns-failure",
  },
]) {
  test(`selection refuses ${name}`, () => destinationHarness({ v4, v6 }).refuses(code));
}

test("answer accessors are refused without execution", async () => {
  let accessed = 0;
  const answers = [];
  Object.defineProperty(answers, "0", {
    get() {
      accessed++;
      return "140.82.112.3";
    },
  });
  await destinationHarness({ v4: answers }).refuses("address-denied");
  assert.equal(accessed, 0);
});

test("each family can supply the maximum 32 records and A is preferred", async () => {
  const harness = destinationHarness({
    v4: Array(32).fill("140.82.112.3"),
    v6: Array(32).fill("2606:50c0::1"),
  });
  assert.equal((await harness.select()).family, 4);
});

test("ENODATA permits selecting a public answer from the other family", async () => {
  const harness = destinationHarness({ v4: dnsFailure("ENODATA"), v6: ["2606:50c0::1"] });
  assert.deepEqual(await harness.select("api.github.com"), {
    hostname: "api.github.com",
    address: "2606:50c0::1",
    family: 6,
    port: 443,
  });
});

const invalidHosts = [
  "github.com.",
  "GitHub.com",
  "other.example",
  "api.github.com:443",
  null,
  false,
];
const invalidBounds = () => [
  null,
  false,
  {},
  { signal: {}, deadline: Date.now() + 1000 },
  ...[NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1].map((deadline) => bounds({ deadline })),
  bounds({ signal: Object.create(AbortSignal.prototype) }),
];
for (const { name, operands, code, options } of [
  {
    name: "invalid host",
    operands: () => invalidHosts,
    code: "invalid-host",
    options: (hostname) => ({ hostname }),
  },
  {
    name: "invalid bounds",
    operands: invalidBounds,
    code: "invalid-bounds",
    options: (bounds) => ({ bounds }),
  },
]) {
  test(`${name} refuses before creating a resolver`, async () => {
    const harness = destinationHarness();
    for (const operand of operands()) await harness.refuses(code, options(operand));
    assert.equal(harness.observations.length, 0);
  });
}

test("already aborted and expired requests refuse before creating a resolver", async () => {
  const harness = destinationHarness();
  await harness.refuses("aborted", { bounds: bounds({ signal: AbortSignal.abort() }) });
  await harness.refuses("deadline", { bounds: bounds({ deadline: Date.now() - 1 }) });
  assert.equal(harness.observations.length, 0);
});

test("configuration rejects invalid servers, timeouts and factories", () => {
  const invalidConfigs = [
    null,
    false,
    {},
    config({ servers: [] }),
    config({ servers: Array(4).fill(config().servers[0]) }),
    ...[0, 5001, 1.5, NaN, false].map((lookupTimeoutMs) => config({ lookupTimeoutMs })),
    ...["dns.example", "[::1]", "::1%lo", " 127.0.0.1"].map((address) =>
      config({ servers: [{ address, port: 53 }] }),
    ),
    ...[0, 65536, 1.5, false].map((port) => config({ servers: [{ address: "::1", port }] })),
  ];
  for (const value of invalidConfigs)
    assert.throws(
      () => createDestinationSelector(value, () => {}),
      destinationError("invalid-config"),
    );
  assert.throws(
    () => createDestinationSelector(config(), null),
    destinationError("invalid-config"),
  );
});

test("configuration is deeply copied and frozen; each selection owns its resolver", async () => {
  const input = config();
  const harness = destinationHarness({ config: input });
  input.servers[0].address = "10.0.0.1";
  input.servers[0].port = 1;
  input.lookupTimeoutMs = 1;
  input.servers.push({ address: "::1", port: 53 });
  const hostnames = ["github.com", "api.github.com"];
  const results = await Promise.all(hostnames.map((hostname) => harness.select(hostname)));
  harness.assertCancellations(1, 1);
  for (const [index, { retained, queries }] of harness.observations.entries()) {
    assert.deepEqual(retained, config());
    assert.ok(
      Object.isFrozen(retained) &&
        Object.isFrozen(retained.servers) &&
        Object.isFrozen(retained.servers[0]),
    );
    assert.deepEqual(queries, [
      [4, hostnames[index]],
      [6, hostnames[index]],
    ]);
    assert.deepEqual(results[index], {
      hostname: hostnames[index],
      address: "140.82.112.3",
      family: 4,
      port: 443,
    });
    assert.ok(Object.isFrozen(results[index]));
  }
});

test("answers are copied at settlement and preferred A waits for complete AAAA validation", async () => {
  const a = deferred(),
    aaaa = deferred();
  const answers = ["140.82.112.3"];
  const harness = destinationHarness({ v4: () => a.promise, v6: () => aaaa.promise });
  let finished = false;
  const selected = harness.select().then((value) => {
    finished = true;
    return value;
  });
  a.resolve(answers);
  await Promise.resolve();
  answers[0] = "127.0.0.1";
  assert.equal(finished, false);
  aaaa.resolve(["2606:50c0::1"]);
  assert.equal((await selected).address, "140.82.112.3");
});

test("abort settles hung DNS and consumes late success and failure", async () => {
  const a = deferred(),
    aaaa = deferred();
  const controller = new AbortController();
  const harness = destinationHarness({ v4: () => a.promise, v6: () => aaaa.promise });
  const selected = harness.select("github.com", bounds({ signal: controller.signal }));
  controller.abort();
  await assert.rejects(selected, destinationError("aborted"));
  harness.assertCancellations(1);
  a.resolve(["140.82.112.3"]);
  aaaa.reject(new Error("late failure"));
});

for (const { name, lookupTimeoutMs, deadlineMs } of [
  { name: "lookup timeout", lookupTimeoutMs: 15, deadlineMs: 2000 },
  { name: "request deadline", lookupTimeoutMs: 1000, deadlineMs: 15 },
]) {
  test(`shorter ${name} settles hung DNS`, async () => {
    const hanging = deferred();
    const harness = destinationHarness({
      config: config({ lookupTimeoutMs }),
      v4: () => hanging.promise,
      v6: () => hanging.promise,
    });
    await harness.refuses("deadline", { bounds: bounds({ deadline: Date.now() + deadlineMs }) });
    harness.assertCancellations(1);
  });
}

test("cancelling one selection leaves the other resolver independent", async () => {
  const hanging = deferred();
  const controller = new AbortController();
  const harness = destinationHarness({
    v4: (id) => (id ? Promise.resolve(["140.82.112.4"]) : hanging.promise),
  });
  const first = harness.select("github.com", bounds({ signal: controller.signal }));
  const second = harness.select("api.github.com");
  controller.abort();
  await assert.rejects(first, destinationError("aborted"));
  assert.equal((await second).address, "140.82.112.4");
  harness.assertCancellations(1, 1);
  hanging.resolve(["140.82.112.3"]);
});

test("synchronous factory abort cancels its resolver without issuing queries", async () => {
  const controller = new AbortController();
  const harness = destinationHarness({ onCreate: () => controller.abort() });
  await harness.refuses("aborted", { bounds: bounds({ signal: controller.signal }) });
  harness.assertCancellations(1);
  assert.deepEqual(harness.observations[0].queries, []);
});

test("configuration and bounds accessors are refused without execution", async () => {
  let accessed = 0;
  const trap = {
    get() {
      accessed++;
      throw new Error("getter");
    },
  };
  const inputConfig = config(),
    inputBounds = bounds();
  Object.defineProperty(inputConfig, "servers", trap);
  Object.defineProperty(inputBounds, "deadline", trap);
  assert.throws(
    () => destinationHarness({ config: inputConfig }),
    destinationError("invalid-config"),
  );
  await destinationHarness().refuses("invalid-bounds", { bounds: inputBounds });
  assert.equal(accessed, 0);
});

const external = () => {
  throw new Error("external operand detail");
};
const revokedProxy = (value) => {
  const proxy = Proxy.revocable(value, {});
  proxy.revoke();
  return proxy.proxy;
};
for (const { name, operand } of [
  ...["signal", "deadline"].map((field) => ({
    name: `bounds ${field} descriptor trap`,
    operand: () =>
      new Proxy(bounds(), {
        getOwnPropertyDescriptor(target, key) {
          if (key === field) external();
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }),
  })),
  { name: "revoked bounds", operand: () => revokedProxy(bounds()) },
  {
    name: "signal prototype trap",
    operand: () =>
      bounds({ signal: new Proxy(new AbortController().signal, { getPrototypeOf: external }) }),
  },
  {
    name: "revoked signal",
    operand: () => bounds({ signal: revokedProxy(new AbortController().signal) }),
  },
  {
    name: "signal property trap",
    operand: () => bounds({ signal: new Proxy(new AbortController().signal, { get: external }) }),
  },
  {
    name: "signal constructor trap",
    operand: () =>
      bounds({
        signal: Object.defineProperty(new AbortController().signal, "constructor", {
          get: external,
        }),
      }),
  },
  {
    name: "transparent signal wrapper",
    operand: () => bounds({ signal: new Proxy(new AbortController().signal, {}) }),
  },
]) {
  test(`${name} refuses with a fixed bounds error before resolver effects`, async () => {
    const harness = destinationHarness();
    // Caller operands may throw during inspection; no external error detail may escape.
    await harness.refuses("invalid-bounds", { bounds: operand() });
    assert.equal(harness.observations.length, 0);
  });
}

test("signal wrapper revocation after selection cannot reach an installed listener", async () => {
  const harness = destinationHarness();
  const signal = Proxy.revocable(new AbortController().signal, {});
  const selected = harness.select("github.com", bounds({ signal: signal.proxy }));
  signal.revoke();
  await assert.rejects(selected, destinationError("invalid-bounds"));
  assert.equal(harness.observations.length, 0);
});

test("earlier stopImmediatePropagation cannot suppress native cancellation", async () => {
  const controller = new AbortController();
  const suppress = (event) => event.stopImmediatePropagation();
  controller.signal.addEventListener("abort", suppress);
  const a = deferred(),
    aaaa = deferred();
  const harness = destinationHarness({
    config: config({ lookupTimeoutMs: 80 }),
    v4: () => a.promise,
    v6: () => aaaa.promise,
  });
  const selected = harness.select("github.com", bounds({ signal: controller.signal }));
  controller.abort();
  // Cancellation must be synchronous, before any deadline timer can run.
  harness.assertCancellations(1);
  await assert.rejects(selected, destinationError("aborted"));
  assert.deepEqual(getEventListeners(controller.signal, "abort"), [suppress]);
  a.resolve(["140.82.112.3"]);
  aaaa.reject(new Error("late DNS"));
  controller.signal.removeEventListener("abort", suppress);
});

test("signal method mutation and throwing resolver disposal cannot strand settlement", async () => {
  const controller = new AbortController();
  const a = deferred(),
    aaaa = deferred();
  const harness = destinationHarness({
    config: config({ lookupTimeoutMs: 40 }),
    v4: () => a.promise,
    v6: () => aaaa.promise,
    onCancel: external,
  });
  const selected = harness.select("github.com", bounds({ signal: controller.signal }));
  for (const method of ["addEventListener", "removeEventListener"])
    Object.defineProperty(controller.signal, method, { get: external });
  controller.abort();
  await assert.rejects(selected, destinationError("aborted"));
  harness.assertCancellations(1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  a.resolve(["140.82.112.3"]);
  aaaa.reject(new Error("late DNS"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  harness.assertCancellations(1);
});

test("later signal observation failure settles with a fixed bounds error and own cancellation", async () => {
  const controller = new AbortController();
  const a = deferred(),
    aaaa = deferred();
  const harness = destinationHarness({
    config: config({ lookupTimeoutMs: 25 }),
    v4: () => a.promise,
    v6: () => aaaa.promise,
  });
  const selected = harness.select("github.com", bounds({ signal: controller.signal }));
  // Native composite currentness reads its source; a later operand trap must be contained.
  Object.defineProperty(controller.signal, "aborted", { get: external });
  await assert.rejects(selected, destinationError("invalid-bounds"));
  harness.assertCancellations(1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  a.resolve(["140.82.112.3"]);
  aaaa.reject(new Error("late DNS"));
});

test("cancellation during successful disposal refuses the destination exactly once", async () => {
  const controller = new AbortController();
  const harness = destinationHarness({
    onCancel() {
      controller.abort();
      external();
    },
  });
  await harness.refuses("aborted", { bounds: bounds({ signal: controller.signal }) });
  harness.assertCancellations(1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
