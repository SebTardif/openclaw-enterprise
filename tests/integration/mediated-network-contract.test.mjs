import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  MEDIATED_NETWORK_PROFILE,
  decodeMediatedNetworkPacketV1 as decode,
} from "@openclaw-enterprise/occ";
import { produceNetworkData } from "../fixtures/mediated-network-contract/producer.ts";
import { describeSelectedData } from "../fixtures/mediated-network-contract/consumer.ts";

import {
  NETWORK_PROFILE_LABEL,
  ORDINARY_NETWORK_PROFILE,
  ordinaryNetworkPolicySelector,
} from "../../apps/controller/src/drivers/compute/kubernetes/resources/network.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const valid = () => structuredClone(produceNetworkData());
const refusal = (input) =>
  assert.throws(
    () => decode(input),
    (error) => {
      assert.equal(error.message, "Invalid mediated network packet.");
      assert.equal(error.cause, undefined);
      return true;
    },
  );
function set(input, path, value) {
  const keys = path.split(".");
  const parent = keys.slice(0, -1).reduce((current, key) => current[key], input);
  parent[keys.at(-1)] = value;
}
function frozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}

test("public DATA boundary preserves independent field vectors, order and detached frozen snapshots", () => {
  const input = valid();
  input.upstreamHttpsCidrs.reverse();
  const output = decode(input);
  assert.deepEqual(output.binding, {
    namespaceId: "ns-example",
    agentId: "agt-example",
    revisionId: "rev-example",
  });
  assert.deepEqual(output.upstreamHttpsCidrs, ["2606:4700:4700::1111/128", "1.1.1.1/32"]);
  assert.equal(output.agent.podLabels["openclaw.dev/workload-role"], "agent");
  assert.equal(output.agentGateway.podLabels["openclaw.dev/workload-role"], "gateway");
  assert.equal(
    output.credentialGateway.podLabels["openclaw.dev/workload-role"],
    "credential-gateway",
  );
  const serialized = JSON.stringify(output);
  input.agent.podLabels["openclaw.dev/agent"] = "other";
  input.gatewayResolvers[0].peer.podLabels["k8s-app"] = "other";
  input.scopedDns.platformHosts[0].address = "10.43.1.14";
  input.publicCa.sha256 = "c".repeat(64);
  assert.equal(JSON.stringify(output), serialized);
  frozen(output);
  assert.throws(() => {
    output.database.port = 1234;
  }, TypeError);
  assert.throws(() => output.upstreamHttpsCidrs.reverse(), TypeError);
  assert.deepEqual(describeSelectedData(output).resolverPorts, [53]);
  assert.equal(describeSelectedData(output).transportPort, 18790);
  assert.equal(describeSelectedData(output).selectedProfile, MEDIATED_NETWORK_PROFILE);
  const ordinarySelector = ordinaryNetworkPolicySelector({ "openclaw.dev/workload-role": "agent" });
  assert.equal(NETWORK_PROFILE_LABEL, "openclaw.dev/network-profile");
  assert.equal(ORDINARY_NETWORK_PROFILE, "broad-egress-v1");
  assert.equal(ordinarySelector.matchLabels[NETWORK_PROFILE_LABEL], "broad-egress-v1");
});

test("canonical IPv6 services and independently expected variable-port limits are accepted", () => {
  const input = valid();
  input.gatewayService.clusterIP = "fd00::10";
  input.scopedDns.clusterIP = "fd00::11";
  input.gatewayResolvers[0].address = "fd00::12";
  input.database.address = "fd00::13";
  input.platformFlows[0].address = "fd00::14";
  input.scopedDns.platformHosts[0].address = "fd00::14";
  input.database.port = 1;
  input.gatewayResolvers[0].port = 65535;
  assert.equal(decode(input).database.port, 1);
  assert.equal(decode(input).gatewayResolvers[0].port, 65535);
});

test("all closed record positions reject unknown, missing and accessor fields without executing hooks", () => {
  const paths = [
    "",
    "binding",
    "agent",
    "agent.podLabels",
    "agentGateway",
    "credentialGateway",
    "gatewayService",
    "scopedDns",
    "scopedDns.peer",
    "scopedDns.platformHosts.0",
    "gatewayResolvers.0",
    "gatewayResolvers.0.peer",
    "database",
    "platformFlows.0",
    "platformFlows.0.peer",
    "harness",
    "publicCa",
  ];
  let hooks = 0;
  for (const path of paths) {
    const input = valid();
    const object = path ? path.split(".").reduce((current, key) => current[key], input) : input;
    // Labels are open bounded dictionaries; their names/values still reject executable data.
    if (!path.endsWith("podLabels")) {
      object.unknown = "secret-value";
      refusal(input);
      delete object.unknown;
      const key = Object.keys(object)[0];
      const prior = object[key];
      delete object[key];
      refusal(input);
      object[key] = prior;
    }
    const key = Object.keys(object)[0];
    Object.defineProperty(object, key, {
      enumerable: true,
      get() {
        hooks++;
        throw new Error("secret");
      },
    });
    refusal(input);
  }
  for (const hook of ["toJSON", Symbol.iterator]) {
    const input = valid();
    Object.defineProperty(input, hook, {
      get() {
        hooks++;
        throw new Error("secret");
      },
    });
    refusal(input);
  }
  const input = valid();
  Object.defineProperty(input.gatewayResolvers, "0", {
    get() {
      hooks++;
      return {};
    },
  });
  refusal(input);
  assert.equal(hooks, 0);
});

test("non-JSON values, sparse/cyclic/pathological data and proxies fail without traps", () => {
  for (const value of [
    undefined,
    () => 1,
    Symbol("secret"),
    1n,
    NaN,
    Infinity,
    -Infinity,
    -0,
    new Date(),
    new Map(),
    new Set(),
    new Uint8Array(1),
    new Number(1),
    "\ud800",
    "\udc00",
  ]) {
    const input = valid();
    input.database.port = value;
    refusal(input);
  }
  for (const value of [null, undefined, [], true, 1, "secret"]) refusal(value);
  const sparse = valid();
  sparse.gatewayResolvers = new Array(3);
  refusal(sparse);
  const cyclic = valid();
  cyclic.database = cyclic;
  refusal(cyclic);
  const huge = valid();
  huge.gatewayResolvers = new Array(100000000);
  refusal(huge);
  const deep = valid();
  let nested = {};
  for (let index = 0; index < 100; index++) nested = { next: nested };
  deep.database.address = nested;
  refusal(deep);
  const symbol = valid();
  symbol[Symbol("secret")] = "secret";
  refusal(symbol);
  const nonEnumerable = valid();
  Object.defineProperty(nonEnumerable, "hidden", { value: "secret" });
  refusal(nonEnumerable);
  let traps = 0;
  const proxy = new Proxy(valid(), {
    ownKeys() {
      traps++;
      throw new Error("secret");
    },
    getPrototypeOf() {
      traps++;
      throw new Error("secret");
    },
    get() {
      traps++;
      throw new Error("secret");
    },
  });
  refusal(proxy);
  const revoked = Proxy.revocable(valid(), {});
  revoked.revoke();
  refusal(revoked.proxy);
  assert.equal(traps, 0);
});

test("fixed ports, numeric domains, profile, Harness, CA and immutable image are exact", () => {
  const variablePorts = ["database.port", "gatewayResolvers.0.port", "platformFlows.0.port"];
  for (const path of variablePorts)
    for (const value of [0, -1, 1.5, 65536, "443", null, false]) {
      const input = valid();
      set(input, path, value);
      refusal(input);
    }
  for (const [path, values] of [
    ["kind", ["other"]],
    ["profile", ["broad-egress-v1", "other"]],
    ["gatewayService.port", [80, "443"]],
    ["gatewayService.targetPort", [443]],
    ["scopedDns.servicePort", [54]],
    ["scopedDns.targetPort", [53]],
    ["harness.protocol", ["UDP", "tcp"]],
    ["harness.port", [18791, "18790"]],
    ["publicCa.key", ["other.crt"]],
    ["publicCa.sha256", ["a".repeat(63), "a".repeat(65), "A".repeat(64), "x".repeat(64)]],
    [
      "scopedDns.image",
      [
        "dns:latest",
        "dns@sha256:" + "A".repeat(64),
        "dns@sha256:" + "a".repeat(63),
        "https://registry.example/dns@sha256:" + "a".repeat(64),
        "bad..name@sha256:" + "a".repeat(64),
      ],
    ],
  ])
    for (const value of values) {
      const input = valid();
      set(input, path, value);
      refusal(input);
    }
});

test("canonical address and public single-host routes reject private/default/special-use CIDRs", () => {
  const paths = [
    "gatewayService.clusterIP",
    "scopedDns.clusterIP",
    "database.address",
    "gatewayResolvers.0.address",
    "platformFlows.0.address",
    "scopedDns.platformHosts.0.address",
  ];
  for (const path of paths)
    for (const value of [
      "example.com",
      "01.2.3.4",
      "1.2.3",
      "1.2.3.256",
      "FD00::10",
      "fd00:0:0:0:0:0:0:10",
      "fd00::10%eth0",
      "[fd00::10]",
      "::ffff:1.2.3.4",
    ]) {
      const input = valid();
      set(input, path, value);
      refusal(input);
    }
  for (const value of [
    "0.0.0.0/0",
    "1.1.1.1/24",
    "1.1.1.1/032",
    "10.0.0.1/32",
    "127.0.0.1/32",
    "169.254.1.1/32",
    "172.16.0.1/32",
    "192.168.1.1/32",
    "100.64.0.1/32",
    "192.0.2.1/32",
    "198.18.0.1/32",
    "224.0.0.1/32",
    "240.0.0.1/32",
    "::/0",
    "::/128",
    "::1/128",
    "fd00::1/128",
    "fe80::1/128",
    "ff02::1/128",
    "::ffff:808:808/128",
    "2001:db8::1/128",
    "2002::1/128",
    "2606:4700:4700::1111/64",
  ]) {
    const input = valid();
    input.upstreamHttpsCidrs = [value];
    refusal(input);
  }
  const input = valid();
  input.upstreamHttpsCidrs = ["8.8.8.8/32", "2606:4700:4700::1001/128"];
  assert.deepEqual(decode(input).upstreamHttpsCidrs, input.upstreamHttpsCidrs);
});

test("names, exact selectors, role separation and caller purpose domains refuse malformed data", () => {
  for (const path of [
    "agent.namespace",
    "publicCa.configMapName",
    "scopedDns.platformHosts.0.hostname",
  ])
    for (const value of [
      "",
      "*",
      "*.example.com",
      "Upper.example",
      "a..b",
      "-bad",
      "bad-",
      "bad_name",
      "a".repeat(64),
    ]) {
      const input = valid();
      set(input, path, value);
      refusal(input);
    }
  for (const hostname of ["github.com", "api.github.com"]) {
    const input = valid();
    input.scopedDns.platformHosts[0].hostname = hostname;
    refusal(input);
  }
  for (const labels of [
    {},
    { "bad key": "value" },
    { "UPPER.example/name": "value" },
    { app: "" },
    { app: "a".repeat(64) },
  ]) {
    const input = valid();
    input.scopedDns.peer.podLabels = labels;
    refusal(input);
  }
  for (const path of ["agent", "agentGateway"]) {
    for (const key of [
      "openclaw.dev/namespace-id",
      "openclaw.dev/agent",
      "openclaw.dev/revision",
      "openclaw.dev/network-profile",
      "openclaw.dev/workload-role",
    ]) {
      const input = valid();
      delete input[path].podLabels[key];
      refusal(input);
    }
    const input = valid();
    input[path].podLabels["openclaw.dev/workload-role"] = "credential-gateway";
    refusal(input);
  }
  const credential = valid();
  credential.credentialGateway.podLabels["openclaw.dev/workload-role"] = "gateway";
  refusal(credential);
  for (const [path, value] of [
    ["platformFlows.0.caller", "credential-gateway"],
    ["platformFlows.0.purpose", "database"],
  ]) {
    const input = valid();
    set(input, path, value);
    refusal(input);
  }
  for (const role of ["agent", "agentGateway"]) {
    for (const key of [
      "openclaw.dev/namespace-id",
      "openclaw.dev/agent",
      "openclaw.dev/revision",
    ]) {
      const mismatched = valid();
      mismatched[role].podLabels[key] = "other-owned-id";
      refusal(mismatched);
    }
    const mismatched = valid();
    mismatched[role].podLabels["openclaw.dev/network-profile"] = "broad-egress-v1";
    refusal(mismatched);
  }
  // Internal correspondence is checked; the decoder has no authenticated owner
  // against which to compare a different, internally consistent supplied revision.
  const different = valid();
  different.binding = {
    namespaceId: "ns-different",
    agentId: "agt-different",
    revisionId: "rev-different",
  };
  for (const role of ["agent", "agentGateway"]) {
    different[role].podLabels["openclaw.dev/namespace-id"] = different.binding.namespaceId;
    different[role].podLabels["openclaw.dev/agent"] = different.binding.agentId;
    different[role].podLabels["openclaw.dev/revision"] = different.binding.revisionId;
  }
  assert.equal(decode(different).binding.revisionId, "rev-different");
  assert.equal(decode(different).agent.namespace, "tenant");
  assert.equal(decode(different).credentialGateway.namespace, "control-plane");
});

test("canonical strings reject trailing line terminators and image-internal controls", () => {
  for (const [path, value] of [
    ["publicCa.sha256", "a".repeat(64) + "\n"],
    ["publicCa.configMapName", "gateway-ca\n"],
    ["agent.namespace", "tenant\n"],
    ["scopedDns.platformHosts.0.hostname", "model.example.com\n"],
    ["scopedDns.peer.podLabels.app", "scoped-dns\n"],
    ["scopedDns.image", "dns\n@sha256:" + "a".repeat(64)],
    ["scopedDns.image", "dns:V1\n@sha256:" + "a".repeat(64)],
    ["scopedDns.image", "registry.example:5000\n/dns@sha256:" + "a".repeat(64)],
  ]) {
    const input = valid();
    set(input, path, value);
    refusal(input);
  }
  const key = valid();
  key.scopedDns.peer.podLabels = { "app\n": "scoped-dns" };
  refusal(key);
});

test("DNS, namespace and label names accept exact Kubernetes bounds; digest image syntax stays immutable", () => {
  const longestDns = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
  assert.equal(longestDns.length, 253);
  const labelPrefix = longestDns + "/" + "e".repeat(63);
  const input = valid();
  input.agent.namespace = "n".repeat(63);
  input.publicCa.configMapName = longestDns;
  input.scopedDns.platformHosts[0].hostname = longestDns;
  input.scopedDns.peer.podLabels = { [labelPrefix]: "v".repeat(63) };
  assert.equal(decode(input).publicCa.configMapName, longestDns);
  assert.equal(Object.keys(decode(input).scopedDns.peer.podLabels)[0], labelPrefix);
  for (const path of ["publicCa.configMapName", "scopedDns.platformHosts.0.hostname"]) {
    const oversized = structuredClone(input);
    set(oversized, path, longestDns + "d");
    refusal(oversized);
  }
  for (const namespace of ["tenant.example", "n".repeat(64)]) {
    const malformed = valid();
    malformed.agent.namespace = namespace;
    refusal(malformed);
  }
  const tooLongKey = valid();
  tooLongKey.scopedDns.peer.podLabels = { [labelPrefix + "e"]: "value" };
  refusal(tooLongKey);
  for (const imageName of [
    "dns",
    "registry.example:5000/team/dns",
    "registry.example/dns:V1",
    "[fd00::1]:5000/team/dns:V1",
  ]) {
    const immutable = valid();
    immutable.scopedDns.image = imageName + "@sha256:" + "a".repeat(64);
    assert.equal(decode(immutable).scopedDns.image, immutable.scopedDns.image);
  }
  for (const imageName of [
    "registry.example/",
    "registry.example:65536/dns",
    "/dns",
    "registry.example/dns:",
    "registry.example/Dns",
  ]) {
    const malformed = valid();
    malformed.scopedDns.image = imageName + "@sha256:" + "a".repeat(64);
    refusal(malformed);
  }
});

test("array and selector cardinalities retain order at each exact maximum and reject one over", () => {
  for (const [path, minimum, maximum, build] of [
    [
      "scopedDns.platformHosts",
      0,
      32,
      (index) => ({ hostname: "h" + index + ".example.com", address: "10.44.0." + (index + 1) }),
    ],
    [
      "platformFlows",
      0,
      32,
      (index) => ({
        caller: "agent-gateway",
        purpose: "control",
        peer: { namespace: "control", podLabels: { app: "api" } },
        address: "10.45.0." + (index + 1),
        port: 443,
      }),
    ],
    [
      "gatewayResolvers",
      1,
      3,
      (index) => ({
        peer: { namespace: "system", podLabels: { app: "dns" } },
        address: "10.46.0." + (index + 1),
        port: 53,
      }),
    ],
    ["upstreamHttpsCidrs", 1, 64, (index) => "8.8.4." + (index + 1) + "/32"],
  ]) {
    for (const length of [minimum, maximum]) {
      const input = valid();
      const expected = Array.from({ length }, (_, index) => build(index));
      set(input, path, expected);
      const decoded = path.split(".").reduce((current, key) => current[key], decode(input));
      assert.deepEqual(decoded, expected);
    }
    for (const length of [maximum + 1, ...(minimum ? [0] : [])]) {
      const input = valid();
      set(
        input,
        path,
        Array.from({ length }, (_, index) => build(index)),
      );
      refusal(input);
    }
  }
  for (const length of [1, 16]) {
    const input = valid();
    input.scopedDns.peer.podLabels = Object.fromEntries(
      Array.from({ length }, (_, index) => ["label" + index, "value"]),
    );
    assert.equal(Object.keys(decode(input).scopedDns.peer.podLabels).length, length);
  }
  const input = valid();
  input.scopedDns.peer.podLabels = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => ["label" + index, "value"]),
  );
  refusal(input);
});

test("duplicate and conflicting routes, resolver endpoints, hostnames and flow endpoints are refused", () => {
  for (const mutate of [
    (input) => input.upstreamHttpsCidrs.push(input.upstreamHttpsCidrs[0]),
    (input) => input.gatewayResolvers.push(structuredClone(input.gatewayResolvers[0])),
    (input) =>
      input.scopedDns.platformHosts.push({
        ...input.scopedDns.platformHosts[0],
        address: "10.43.9.14",
      }),
    (input) => input.platformFlows.push({ ...input.platformFlows[0], purpose: "control" }),
    (input) => {
      input.database.address = input.gatewayService.clusterIP;
      input.database.port = 443;
    },
    (input) => {
      input.scopedDns.clusterIP = input.gatewayService.clusterIP;
      input.scopedDns.servicePort = 443;
    },
  ]) {
    const input = valid();
    mutate(input);
    refusal(input);
  }
});

function maximumImagePacket() {
  const input = valid();
  input.scopedDns.peer.podLabels = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => ["x" + index, "x".repeat(63)]),
  );
  input.platformFlows = Array.from({ length: 32 }, (_, index) => ({
    caller: "agent",
    purpose: "model",
    peer: structuredClone(input.scopedDns.peer),
    address: "10.48.0." + (index + 1),
    port: 443,
  }));
  return input;
}
test("64 KiB limit counts exact UTF-8 JSON representation before retaining a snapshot", () => {
  const input = maximumImagePacket();
  const digest = "@sha256:" + "a".repeat(64);
  input.scopedDns.image = "r" + digest;
  const base = Buffer.byteLength(JSON.stringify(input), "utf8");
  // Adjust bounded selectors to reach the aggregate limit with a short image name.
  assert.ok(base < 65536);
  // Increase only valid bounded label keys until the remaining padding is small.
  const prefix = "p".repeat(60) + ".example.com/";
  outer: for (const flow of input.platformFlows) {
    for (const key of Object.keys(flow.peer.podLabels)) {
      if (65536 - Buffer.byteLength(JSON.stringify(input), "utf8") <= 900) break outer;
      const labels = flow.peer.podLabels;
      const value = labels[key];
      delete labels[key];
      labels[prefix + key] = value;
    }
  }
  const needed = 65536 - Buffer.byteLength(JSON.stringify(input), "utf8");
  assert.ok(needed >= 0 && needed <= 900);
  input.scopedDns.image = "r".repeat(needed + 1) + digest;
  assert.equal(Buffer.byteLength(JSON.stringify(input), "utf8"), 65536);
  assert.equal(decode(input).scopedDns.image, input.scopedDns.image);
  input.scopedDns.image = "r" + input.scopedDns.image;
  assert.equal(Buffer.byteLength(JSON.stringify(input), "utf8"), 65537);
  refusal(input);
});

test("producer and Compute-policy consumer compile independently through the actual package route", () => {
  for (const fixture of ["producer", "consumer"]) {
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--noUncheckedIndexedAccess",
        "--exactOptionalPropertyTypes",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2022",
        "--allowImportingTsExtensions",
        "--skipLibCheck",
        "false",
        "--types",
        "node",
        "tests/fixtures/mediated-network-contract/" + fixture + ".ts",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 60000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.error, undefined);
  }
});
