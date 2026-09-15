import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import {
  createDestinationSelector,
  DestinationError,
} from "../../apps/credential-gateway/src/transport/destination.ts";

const config = () => ({ servers: [{ address: "127.0.0.1", port: 5353 }], lookupTimeoutMs: 1000 });
const bounds = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2000 });
function observed(v4 = ["140.82.112.3"], v6 = []) {
  const observations = [];
  const factory = (retained) => {
    const observation = { retained, names: [], cancelled: 0 };
    observations.push(observation);
    return {
      resolve4(name) {
        observation.names.push([4, name]);
        return typeof v4 === "function" ? v4() : Promise.resolve(v4);
      },
      resolve6(name) {
        observation.names.push([6, name]);
        return typeof v6 === "function" ? v6() : Promise.resolve(v6);
      },
      cancel() {
        observation.cancelled++;
      },
    };
  };
  return { selector: createDestinationSelector(config(), factory), observations, factory };
}
const denied = (code) => (error) => error instanceof DestinationError && error.code === code;
async function addressCase(address, family, permitted) {
  const { selector } = family === 4 ? observed([address]) : observed([], [address]);
  const result = selector.select("github.com", bounds());
  if (permitted) assert.equal((await result).address, address);
  else await assert.rejects(result, denied("address-denied"), address);
}

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
test("IPv4 conservative policy denies each full interval and admits public neighbors", async () => {
  for (const interval of ipv4Intervals)
    for (const address of interval) await addressCase(address, 4, false);
  for (const address of ipv4PublicNeighbors) await addressCase(address, 4, true);
});
test("IPv6 conservative policy enforces global envelope and every exception boundary", async () => {
  const blocked = [
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
  const publicAddresses = [
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
  for (const address of blocked) await addressCase(address, 6, false);
  for (const address of publicAddresses) await addressCase(address, 6, true);
});
test("address syntax and answer family are strict, and one unsafe record denies the whole set", async () => {
  for (const address of [
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
  ]) {
    await addressCase(address, 4, false);
  }
  await addressCase("2606:50c0::1", 4, false);
  await addressCase("140.82.112.3", 6, false);
  for (const address of [
    "[2606:50c0::1]",
    "2606:50c0::1%eth0",
    "2606::1.2.3.4",
    " 2606:50c0::1",
    "2606:50c0:::1",
    "2606:50c0::10000",
    "2606:50c0::1:443:99999",
  ])
    await addressCase(address, 6, false);
  for (const [v4, v6] of [
    [["140.82.112.3", "10.0.0.1"], []],
    [["140.82.112.3"], ["fe80::1"]],
    [[], ["2606:50c0::1", "::1"]],
  ]) {
    await assert.rejects(
      observed(v4, v6).selector.select("github.com", bounds()),
      denied("address-denied"),
    );
  }
});
test("empty, malformed, sparse, accessor and oversized answers fail with finite codes", async () => {
  for (const [v4, code] of [
    [[], "empty-answer"],
    [null, "dns-failure"],
    [false, "dns-failure"],
    [Array(1), "address-denied"],
    [Array(33).fill("140.82.112.3"), "answer-limit"],
    [["a".repeat(46)], "address-denied"],
  ]) {
    await assert.rejects(observed(v4).selector.select("github.com", bounds()), denied(code));
  }
  let executed = false;
  const answers = [];
  Object.defineProperty(answers, "0", {
    get() {
      executed = true;
      return "140.82.112.3";
    },
  });
  await assert.rejects(
    observed(answers).selector.select("github.com", bounds()),
    denied("address-denied"),
  );
  assert.equal(executed, false);
  const full = Array(32).fill("140.82.112.3");
  const ipv6 = Array(32).fill("2606:50c0::1");
  assert.equal((await observed(full, ipv6).selector.select("github.com", bounds())).family, 4);
});
test("only ENODATA is empty; other family failure refuses even with a public answer", async () => {
  const rejected = (code) => () =>
    Promise.reject(Object.assign(new Error("external detail"), { code }));
  assert.equal(
    (
      await observed(rejected("ENODATA"), ["2606:50c0::1"]).selector.select(
        "api.github.com",
        bounds(),
      )
    ).family,
    6,
  );
  for (const code of ["ENOTFOUND", "ECANCELLED", "ETIMEOUT", undefined]) {
    await assert.rejects(
      observed(["140.82.112.3"], rejected(code)).selector.select("github.com", bounds()),
      denied("dns-failure"),
    );
  }
  await assert.rejects(
    observed(() => {
      throw new Error("sync DNS failure");
    }).selector.select("github.com", bounds()),
    denied("dns-failure"),
  );
});
test("fixed host, mandatory native signal and safe integer epoch deadline reject before factory", async () => {
  const { selector, observations } = observed();
  for (const name of [
    "github.com.",
    "GitHub.com",
    "other.example",
    "api.github.com:443",
    null,
    false,
  ])
    await assert.rejects(selector.select(name, bounds()), denied("invalid-host"));
  for (const b of [
    null,
    false,
    {},
    { signal: {}, deadline: Date.now() + 1000 },
    ...[NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1].map((deadline) => ({
      ...bounds(),
      deadline,
    })),
  ])
    await assert.rejects(selector.select("github.com", b), denied("invalid-bounds"));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    selector.select("github.com", { ...bounds(), signal: aborted.signal }),
    denied("aborted"),
  );
  await assert.rejects(
    selector.select("github.com", { ...bounds(), deadline: Date.now() - 1 }),
    denied("deadline"),
  );
  assert.equal(observations.length, 0);
  await assert.rejects(
    selector.select("github.com", { ...bounds(), signal: Object.create(AbortSignal.prototype) }),
    denied("invalid-bounds"),
  );
});
test("configuration is validated, copied deeply and frozen; each selection owns its resolver", async () => {
  for (const c of [
    null,
    false,
    {},
    { ...config(), servers: [] },
    { ...config(), servers: Array(4).fill(config().servers[0]) },
    ...[0, 5001, 1.5, NaN, false].map((lookupTimeoutMs) => ({ ...config(), lookupTimeoutMs })),
    ...["dns.example", "[::1]", "::1%lo", " 127.0.0.1"].map((address) => ({
      ...config(),
      servers: [{ address, port: 53 }],
    })),
    ...[0, 65536, 1.5, false].map((port) => ({ ...config(), servers: [{ address: "::1", port }] })),
  ])
    assert.throws(() => createDestinationSelector(c, () => {}), denied("invalid-config"));
  assert.throws(() => createDestinationSelector(config(), null), denied("invalid-config"));
  const { factory, observations } = observed();
  const c = config();
  const selector = createDestinationSelector(c, factory);
  c.servers[0].address = "10.0.0.1";
  c.servers[0].port = 1;
  c.lookupTimeoutMs = 1;
  c.servers.push({ address: "::1", port: 53 });
  const results = await Promise.all([
    selector.select("github.com", bounds()),
    selector.select("api.github.com", bounds()),
  ]);
  assert.equal(observations.length, 2);
  for (const o of observations) {
    assert.deepEqual(o.retained, config());
    assert.ok(
      Object.isFrozen(o.retained) &&
        Object.isFrozen(o.retained.servers) &&
        Object.isFrozen(o.retained.servers[0]),
    );
    assert.equal(o.cancelled, 1);
    assert.equal(o.names.length, 2);
    assert.equal(o.names[0][1], o.names[1][1]);
  }
  assert.deepEqual(results[0], {
    hostname: "github.com",
    address: "140.82.112.3",
    family: 4,
    port: 443,
  });
  assert.ok(Object.isFrozen(results[0]));
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
test("answers are copied at settlement and preferred A waits for complete AAAA validation", async () => {
  const a = deferred(),
    aaaa = deferred();
  const answers = ["140.82.112.3"];
  const { selector } = observed(
    () => a.promise,
    () => aaaa.promise,
  );
  let finished = false;
  const selected = selector.select("github.com", bounds()).then((value) => {
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
test("abort and shorter monotonic timeout settle without hung DNS; late failures are consumed", async () => {
  const lateA = deferred(),
    lateAAAA = deferred();
  const controller = new AbortController();
  const { selector, observations } = observed(
    () => lateA.promise,
    () => lateAAAA.promise,
  );
  const failure = selector.select("github.com", { ...bounds(), signal: controller.signal });
  controller.abort();
  await assert.rejects(failure, denied("aborted"));
  assert.equal(observations[0].cancelled, 1);
  lateA.resolve(["140.82.112.3"]);
  lateAAAA.reject(new Error("late failure"));
  const hanging = observed(
    () => new Promise(() => {}),
    () => new Promise(() => {}),
  );
  const timed = createDestinationSelector({ ...config(), lookupTimeoutMs: 15 }, hanging.factory);
  await assert.rejects(timed.select("github.com", bounds()), denied("deadline"));
  assert.equal(hanging.observations[0].cancelled, 1);
  await assert.rejects(
    hanging.selector.select("github.com", { ...bounds(), deadline: Date.now() + 15 }),
    denied("deadline"),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
});
test("cancellation isolation and synchronous factory abort both cancel exactly their own resolver", async () => {
  const hanging = deferred();
  let count = 0;
  const cancellations = [0, 0];
  const selector = createDestinationSelector(config(), () => {
    const id = count++;
    return {
      resolve4: () => (id ? Promise.resolve(["140.82.112.4"]) : hanging.promise),
      resolve6: () => Promise.resolve([]),
      cancel() {
        cancellations[id]++;
      },
    };
  });
  const controller = new AbortController();
  const first = selector.select("github.com", { ...bounds(), signal: controller.signal });
  const second = selector.select("api.github.com", bounds());
  controller.abort();
  await assert.rejects(first, denied("aborted"));
  assert.equal((await second).address, "140.82.112.4");
  assert.deepEqual(cancellations, [1, 1]);
  hanging.resolve(["140.82.112.3"]);
  const sync = new AbortController();
  let cancelled = 0,
    queried = 0;
  const abortedFactory = createDestinationSelector(config(), () => {
    sync.abort();
    return {
      resolve4() {
        queried++;
        return Promise.resolve([]);
      },
      resolve6() {
        queried++;
        return Promise.resolve([]);
      },
      cancel() {
        cancelled++;
      },
    };
  });
  await assert.rejects(
    abortedFactory.select("github.com", { ...bounds(), signal: sync.signal }),
    denied("aborted"),
  );
  assert.equal(cancelled, 1);
  assert.equal(queried, 0);
});

test("configuration and bounds accessor fields are refused without running them", async () => {
  let accessed = 0;
  const c = config();
  Object.defineProperty(c, "servers", {
    get() {
      accessed++;
      throw new Error("getter");
    },
  });
  assert.throws(() => createDestinationSelector(c, () => {}), denied("invalid-config"));
  const b = bounds();
  Object.defineProperty(b, "deadline", {
    get() {
      accessed++;
      throw new Error("getter");
    },
  });
  await assert.rejects(observed().selector.select("github.com", b), denied("invalid-bounds"));
  assert.equal(accessed, 0);
});

test("hostile bounds and signal inspection reject with fixed invalid-bounds before factory", async () => {
  const { selector, observations } = observed();
  const external = () => {
    throw new Error("external operand detail");
  };
  const revokedBounds = Proxy.revocable(bounds(), {});
  revokedBounds.revoke();
  const revokedSignal = Proxy.revocable(new AbortController().signal, {});
  revokedSignal.revoke();
  const operands = [
    ...["signal", "deadline"].map(
      (field) =>
        new Proxy(bounds(), {
          getOwnPropertyDescriptor(target, key) {
            if (key === field) external();
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        }),
    ),
    revokedBounds.proxy,
    { ...bounds(), signal: new Proxy(new AbortController().signal, { getPrototypeOf: external }) },
    { ...bounds(), signal: revokedSignal.proxy },
    { ...bounds(), signal: new Proxy(new AbortController().signal, { get: external }) },
  ];
  // These are caller operands; the actual selector must contain their inspection errors.
  for (const operand of operands) {
    await assert.rejects(selector.select("github.com", operand), (error) => {
      assert.ok(error instanceof DestinationError);
      assert.equal(error.code, "invalid-bounds");
      assert.equal(error.message, "Destination selection refused: invalid-bounds");
      return true;
    });
    assert.equal(observations.length, 0);
  }
});

test("native constructor traps and transparent signal wrappers refuse before resolver effects", async () => {
  const { selector, observations } = observed();
  const trapped = new AbortController().signal;
  Object.defineProperty(trapped, "constructor", {
    get() {
      throw new Error("external operand detail");
    },
  });
  const revocable = Proxy.revocable(new AbortController().signal, {});
  for (const signal of [trapped, new Proxy(new AbortController().signal, {}), revocable.proxy]) {
    const selected = selector.select("github.com", { ...bounds(), signal });
    // Revocation immediately after the public call must never reach an installed listener.
    if (signal === revocable.proxy) revocable.revoke();
    await assert.rejects(selected, (error) => {
      assert.ok(error instanceof DestinationError);
      assert.equal(error.code, "invalid-bounds");
      assert.equal(error.message, "Destination selection refused: invalid-bounds");
      return true;
    });
    assert.equal(observations.length, 0);
  }
});

test("earlier stopImmediatePropagation cannot suppress native cancellation", async () => {
  const controller = new AbortController();
  const suppress = (event) => event.stopImmediatePropagation();
  controller.signal.addEventListener("abort", suppress);
  const lateA = deferred(),
    lateAAAA = deferred();
  const { factory, observations } = observed(
    () => lateA.promise,
    () => lateAAAA.promise,
  );
  const selector = createDestinationSelector({ ...config(), lookupTimeoutMs: 80 }, factory);
  const selected = selector.select("github.com", { ...bounds(), signal: controller.signal });
  controller.abort();
  // Cancellation is observable synchronously, before any deadline timer can run.
  assert.equal(observations[0].cancelled, 1);
  await assert.rejects(selected, denied("aborted"));
  assert.deepEqual(getEventListeners(controller.signal, "abort"), [suppress]);
  lateA.resolve(["140.82.112.3"]);
  lateAAAA.reject(new Error("late DNS"));
  controller.signal.removeEventListener("abort", suppress);
});

test("signal method mutation and throwing resolver disposal cannot strand settlement", async () => {
  const controller = new AbortController();
  const lateA = deferred(),
    lateAAAA = deferred();
  let cancelled = 0;
  const selector = createDestinationSelector({ ...config(), lookupTimeoutMs: 40 }, () => ({
    resolve4: () => lateA.promise,
    resolve6: () => lateAAAA.promise,
    cancel() {
      cancelled++;
      throw new Error("external disposal detail");
    },
  }));
  const selected = selector.select("github.com", { ...bounds(), signal: controller.signal });
  for (const method of ["addEventListener", "removeEventListener"]) {
    Object.defineProperty(controller.signal, method, {
      get() {
        throw new Error("external method detail");
      },
    });
  }
  controller.abort();
  await assert.rejects(selected, denied("aborted"));
  assert.equal(cancelled, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  lateA.resolve(["140.82.112.3"]);
  lateAAAA.reject(new Error("late DNS"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(cancelled, 1);
});

test("later native signal observation failures settle with fixed bounds error and own cancellation", async () => {
  const controller = new AbortController();
  const lateA = deferred(),
    lateAAAA = deferred();
  const { factory, observations } = observed(
    () => lateA.promise,
    () => lateAAAA.promise,
  );
  const selector = createDestinationSelector({ ...config(), lookupTimeoutMs: 25 }, factory);
  const selected = selector.select("github.com", { ...bounds(), signal: controller.signal });
  // Native composite currentness reads its source; a later operand trap must be contained.
  Object.defineProperty(controller.signal, "aborted", {
    get() {
      throw new Error("external currentness detail");
    },
  });
  await assert.rejects(selected, (error) => {
    assert.ok(error instanceof DestinationError);
    assert.equal(error.code, "invalid-bounds");
    assert.equal(error.message, "Destination selection refused: invalid-bounds");
    return true;
  });
  assert.equal(observations[0].cancelled, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  lateA.resolve(["140.82.112.3"]);
  lateAAAA.reject(new Error("late DNS"));
});

test("cancellation during successful disposal refuses the destination exactly once", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const selector = createDestinationSelector(config(), () => ({
    resolve4: () => Promise.resolve(["140.82.112.3"]),
    resolve6: () => Promise.resolve([]),
    cancel() {
      cancelled++;
      controller.abort();
      throw new Error("external disposal detail");
    },
  }));
  await assert.rejects(
    selector.select("github.com", { ...bounds(), signal: controller.signal }),
    denied("aborted"),
  );
  assert.equal(cancelled, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
