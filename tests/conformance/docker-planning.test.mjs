import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  ConfigurationFailure,
  agentEnvironment,
  dockerLoggingAddress,
  gatewayEnvironment,
  gatewayUsesTrustedProxy,
  providerEnvironment,
  runtimeContainerPayload,
} from "../../apps/controller/src/drivers/compute/docker/container-plan.ts";
import {
  OwnershipFailure,
  agentContainerName,
  agentOwnership,
  gatewayContainerName,
  gatewayOwnership,
  networkName,
  ownershipMetadata,
  verifyOwnership,
} from "../../apps/controller/src/drivers/compute/docker/ownership.ts";
import {
  gatewayRevisionDisposition,
  healthy,
  validTopology,
} from "../../apps/controller/src/drivers/compute/docker/revisions.ts";
import {
  DockerApiError,
  statusCode,
} from "../../apps/controller/src/drivers/compute/docker/client.ts";

const label = "org.openclaw.enterprise.";
const revision = Object.freeze({
  id: "rev-planning",
  namespaceId: "ns-planning",
  agentId: "agent-planning",
  revision: 3,
  harness: Object.freeze({ id: "codex", mode: "dedicated", version: "1.0.0" }),
});

function runtimeInput(overrides = {}) {
  return {
    name: "runtime-planning",
    image: "runtime:local",
    network: "namespace-network",
    ownership: Object.freeze(agentOwnership(revision)),
    role: "agent",
    environment: Object.freeze({ TOKEN: "a=b\nc", EMPTY: "" }),
    command: "process.exit(0)",
    healthcheckScript: "process.exit(0)",
    exposedPort: 18790,
    ...overrides,
  };
}

test("Docker payload planning preserves isolation, health checks and literal environment bytes", () => {
  const input = Object.freeze(runtimeInput());
  const before = structuredClone(input);
  const payload = runtimeContainerPayload(input);
  assert.deepEqual(input, before);
  assert.equal(payload.Image, input.image);
  assert.equal(payload.User, "1000:1000");
  assert.deepEqual(payload.Env, ["TOKEN=a=b\nc", "EMPTY="]);
  assert.deepEqual(payload.Entrypoint, ["node"]);
  assert.deepEqual(payload.Cmd, ["-e", input.command]);
  assert.deepEqual(payload.ExposedPorts, { "18790/tcp": {} });
  assert.deepEqual(payload.Healthcheck, {
    Test: ["CMD", "node", "-e", input.healthcheckScript],
    Interval: 2_000_000_000,
    Timeout: 2_000_000_000,
    Retries: 15,
  });
  assert.deepEqual(payload.HostConfig, {
    NetworkMode: input.network,
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    Tmpfs: {
      "/home/node": "size=1024m,uid=1000,gid=1000,mode=700",
      "/tmp": "size=64m,uid=1000,gid=1000,mode=1777",
    },
  });
  assert.deepEqual(payload.NetworkingConfig, {
    EndpointsConfig: { [input.network]: { Aliases: [input.name] } },
  });
  assert.equal(payload.Labels[`${label}role`], "agent");
  assert.equal(payload.Labels[`${label}version`], input.image);
  verifyOwnership(payload.Labels, agentOwnership(revision), "planned container");
});

test("Docker gateway payload exports bounded logging labels and exact loopback bindings", () => {
  const bindings = { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] };
  const payload = runtimeContainerPayload(
    runtimeInput({
      role: "gateway",
      exposedPort: 8080,
      ownership: gatewayOwnership(revision),
      portBindings: bindings,
      labels: { [`${label}revision-id`]: revision.id, "example.test/other": "present" },
    }),
    "127.0.0.1:24224",
  );
  assert.deepEqual(payload.HostConfig.PortBindings, bindings);
  assert.deepEqual(payload.HostConfig.LogConfig, {
    Type: "fluentd",
    Config: {
      "fluentd-address": "127.0.0.1:24224",
      "fluentd-async": "true",
      "fluentd-buffer-limit": "1024",
      "fluentd-write-timeout": "1s",
      mode: "non-blocking",
      "max-buffer-size": "1m",
      "cache-disabled": "false",
      "cache-max-size": "10m",
      "cache-max-file": "2",
      "cache-compress": "true",
      labels: [
        "agent-id",
        "compute-driver",
        "managed",
        "namespace-id",
        "revision-id",
        "role",
        "version",
      ]
        .map((suffix) => `${label}${suffix}`)
        .join(","),
    },
  });
});

test("Docker logging endpoints retain loopback parsing and reject remote or malformed addresses", () => {
  for (const [value, expected] of [
    [undefined, undefined],
    ["  ", undefined],
    [" 127.0.0.2:024224 ", "127.0.0.2:24224"],
    ["localhost:1", "localhost:1"],
    ["[::1]:65535", "[::1]:65535"],
  ])
    assert.equal(dockerLoggingAddress(value), expected);
  for (const value of [
    "0.0.0.0:24224",
    "[::]:24224",
    "127.0.0.256:1",
    "127.0.0.1:0",
    "localhost:65536",
    "localhost:1/path",
    "https://localhost:24224",
    "localhost:1.5",
    "remote.test:1",
  ]) {
    assert.throws(() => dockerLoggingAddress(value), ConfigurationFailure);
  }
});

test("Docker environment planners preserve credential bytes and runtime-owned overrides", () => {
  for (const value of [undefined, "", " \t "]) {
    assert.throws(() => providerEnvironment(value), ConfigurationFailure);
  }
  const provider = providerEnvironment(" fixture-secret-with-spaces ");
  assert.deepEqual(provider, { OPENAI_API_KEY: " fixture-secret-with-spaces " });
  const environment = Object.freeze({ ...provider, APP_SERVER_PORT: "wrong", HOME: "wrong" });
  const agent = agentEnvironment(environment, "transport-token", "debug");
  assert.equal(agent.OPENAI_API_KEY, provider.OPENAI_API_KEY);
  assert.equal(agent.APP_SERVER_PORT, "18790");
  assert.equal(agent.APP_SERVER_TOKEN, "transport-token");
  assert.equal(agent.HOME, "/home/node");
  assert.equal(agent.CODEX_HOME, "/home/node/.codex");
  assert.equal(agent.RUST_LOG, "debug,codex_otel=off");
  const gateway = gatewayEnvironment(
    '{"logging":{"level":"info"}}',
    { APP_SERVER_URL: "ws://agent:18790", APP_SERVER_TOKEN: "transport-token", HOME: "wrong" },
    "gateway-token",
  );
  assert.equal(gateway.OPENAI_API_KEY, undefined);
  assert.equal(gateway.OPENCLAW_CONFIG_PATH, "/home/node/.openclaw/openclaw.json");
  assert.equal(gateway.OPENCLAW_GATEWAY_TOKEN, "gateway-token");
  assert.equal(gateway.OPENCLAW_GATEWAY_PORT, "8080");
  assert.equal(gateway.HOME, "/home/node");
  assert.equal(gatewayUsesTrustedProxy({ gateway: { auth: { mode: "trusted-proxy" } } }), true);
  for (const configuration of [{}, { gateway: null }, { gateway: { auth: { mode: "token" } } }]) {
    assert.equal(gatewayUsesTrustedProxy(configuration), false);
  }
  assert.equal(gatewayEnvironment("{}", provider, undefined).OPENCLAW_GATEWAY_TOKEN, undefined);
});

test("Docker observed ownership requires every exact managed, provider and resource label", () => {
  const ownership = agentOwnership(revision);
  const expected = ownershipMetadata(ownership);
  assert.deepEqual(ownership, {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
  });
  assert.deepEqual(gatewayOwnership(revision), {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
  });
  assert.doesNotThrow(() =>
    verifyOwnership({ ...expected, unrelated: "kept" }, ownership, "container"),
  );
  assert.throws(() => verifyOwnership(undefined, ownership, "container"), OwnershipFailure);
  for (const key of Object.keys(expected)) {
    assert.throws(
      () => verifyOwnership({ ...expected, [key]: "foreign" }, ownership, "container"),
      OwnershipFailure,
    );
    const missing = { ...expected };
    delete missing[key];
    assert.throws(() => verifyOwnership(missing, ownership, "container"), OwnershipFailure);
  }
  // A stable gateway may move revisions, but an Agent container belongs to exactly one revision.
  const successor = { ...expected, [`${label}revision-id`]: "successor" };
  assert.doesNotThrow(() => verifyOwnership(successor, gatewayOwnership(revision), "gateway"));
  assert.throws(() => verifyOwnership(successor, ownership, "agent"), OwnershipFailure);
});

test("Docker names retain exact resource hashes and stable gateway versus revision-specific Agent identity", () => {
  const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);
  assert.equal(networkName("NS Example!"), `oce-ns-example-${hash("NS Example!")}`);
  assert.equal(networkName("!!!"), `oce-namespace-${hash("!!!")}`);
  assert.equal(
    gatewayContainerName(revision.namespaceId, revision.agentId),
    `oce-${hash(revision.namespaceId)}-gateway-${hash(revision.agentId)}`,
  );
  assert.equal(
    agentContainerName(revision.namespaceId, revision.agentId, revision.id),
    `oce-${hash(revision.namespaceId)}-agent-${hash(revision.agentId)}-rev-${hash(revision.id)}`,
  );
  assert.notEqual(
    agentContainerName(revision.namespaceId, revision.agentId, "next"),
    agentContainerName(revision.namespaceId, revision.agentId, revision.id),
  );
});

function gatewayInspect(
  number = revision.revision,
  id = revision.id,
  hash = "configuration-hash",
  running = true,
  health = "healthy",
) {
  return {
    Config: {
      Labels: {
        [`${label}revision-number`]: String(number),
        [`${label}revision-id`]: id,
        [`${label}configuration-hash`]: hash,
      },
    },
    State: { Running: running, Health: { Status: health } },
  };
}

test("Docker revision decisions preserve stale protection, exact immutable configuration and readiness", () => {
  const disposition = (inspect) =>
    gatewayRevisionDisposition(inspect, revision, "configuration-hash", "gateway");
  assert.equal(disposition(gatewayInspect()), "ready");
  assert.equal(disposition(gatewayInspect(4, "newer", "different")), "stale");
  assert.equal(disposition(gatewayInspect(2, "older", "different")), "replace");
  assert.equal(disposition(gatewayInspect(3, "different-id", "different")), "replace");
  assert.equal(
    disposition(gatewayInspect(3, revision.id, "configuration-hash", true, "starting")),
    "replace",
  );
  assert.equal(disposition(gatewayInspect(3, revision.id, "configuration-hash", false)), "replace");
  assert.throws(
    () => disposition(gatewayInspect(3, revision.id, "different")),
    ConfigurationFailure,
  );
  for (const number of ["invalid", "", "1.5", "0", "-1", "9007199254740992"]) {
    assert.throws(() => disposition(gatewayInspect(number)), OwnershipFailure);
  }
  assert.throws(() => disposition(gatewayInspect(3, "")), OwnershipFailure);
});

test("Docker readiness, supported topologies and API status typing remain precise", () => {
  assert.equal(healthy(gatewayInspect()), true);
  for (const inspect of [
    {},
    { State: { Running: true } },
    { State: { Running: false, Health: { Status: "healthy" } } },
    { State: { Running: true, Health: { Status: "starting" } } },
  ])
    assert.equal(healthy(inspect), false);
  for (const [id, mode, expected] of [
    ["codex", "dedicated", true],
    ["openclaw", "embedded", true],
    ["codex", "embedded", false],
    ["openclaw", "dedicated", false],
    ["other", "dedicated", false],
  ]) {
    assert.equal(validTopology({ ...revision, harness: { id, mode } }), expected);
  }
  assert.equal(statusCode(new DockerApiError(409, "collision")), 409);
  assert.equal(statusCode({ statusCode: 409 }), undefined);
  assert.equal(statusCode(new Error("409")), undefined);
});
