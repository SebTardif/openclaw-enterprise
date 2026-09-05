import assert from "node:assert/strict";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";

// These tests exercise the real Driver and HTTP transport against finite Docker API
// responses. They do not start a Docker daemon, containers, or provider-backed runtimes.
const prefix = "org.openclaw.enterprise.";
const namespace = {
  id: "ns_00000000-0000-4000-8000-000000000011",
  name: "Docker transport fixture",
  status: "ready",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const namespaceLabels = {
  [`${prefix}managed`]: "true",
  [`${prefix}compute-driver`]: "docker",
  [`${prefix}namespace-id`]: namespace.id,
};
const images = { gateway: "gateway:local", agent: "agent:local" };

function revision(number = 1, mode = "embedded") {
  return {
    id: `revision-${number}`,
    namespaceId: namespace.id,
    agentId: "agent-docker-transport",
    revision: number,
    configurationId: "cfg_00000000-0000-4000-8000-000000000011",
    configurationKind: "agent",
    configurationGeneration: number,
    configuration: admitLoggingConfiguration({}, "info"),
    harness: { id: mode === "embedded" ? "openclaw" : "codex", version: "1.0.0", mode },
    compute: { id: "compute-docker-development", implementation: "docker-local" },
    servicePrincipalId: "service-principal-docker-transport",
    createdAt: namespace.createdAt,
  };
}

function step(method, path, status, response, inspect) {
  return { method, path, status, response, inspect };
}
const network = () => step("GET", /^\/networks\/oce-/, 200, { Labels: namespaceLabels });
const absent = () =>
  step("GET", /^\/containers\/oce-.*\/json$/, 404, { message: "No such container" });
const created = (capture) =>
  step("POST", /^\/containers\/create\?name=oce-/, 201, { Id: "fixture-container" }, capture);
const started = (status = 204) => step("POST", /^\/containers\/oce-.*\/start$/, status);
const removed = () => step("DELETE", /^\/containers\/oce-.*\?force=true&v=true$/, 204);
const inspected = (payload, state = { Running: true, Health: { Status: "healthy" } }) =>
  step("GET", /^\/containers\/oce-.*\/json$/, 200, () => ({
    Config: { Labels: payload().Labels },
    State: state,
  }));
const environment = (payload) =>
  Object.fromEntries(
    payload.Env.map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );

async function fixture(t, script, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "docker-api-fixture-"));
  const socketPath = join(directory, "engine.sock");
  const records = [];
  const errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      const record = {
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: text === "" ? undefined : JSON.parse(text),
      };
      records.push(record);
      const expected = script.shift();
      assert.ok(expected, `Unexpected Docker request ${record.method} ${record.path}`);
      assert.equal(record.method, expected.method);
      if (typeof expected.path === "string") assert.equal(record.path, expected.path);
      else assert.match(record.path, expected.path);
      if (record.body !== undefined) {
        assert.equal(record.headers["content-type"], "application/json");
        assert.equal(Number(record.headers["content-length"]), Buffer.byteLength(text));
      }
      await expected.inspect?.(record);
      // A held response models a stalled Engine request; the test cancels its owner.
      if (expected.status === undefined) return;
      response.statusCode = expected.status;
      const body =
        typeof expected.response === "function" ? expected.response() : expected.response;
      if (body !== undefined && typeof body !== "string") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(body));
      } else {
        if (options.invalidJson) response.setHeader("content-type", "application/json");
        response.end(body);
      }
    } catch (error) {
      errors.push(error);
      response.statusCode = 500;
      response.end("Unexpected fixture request");
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const originalRequest = http.request;
  const previousCredential = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture-model-credential";
  // Production deliberately fixes /var/run/docker.sock. Redirect only that address,
  // preserving the real request, serialization, response parsing, and abort handling.
  http.request = function (requestOptions, callback) {
    assert.equal(requestOptions.socketPath, "/var/run/docker.sock");
    return originalRequest.call(http, { ...requestOptions, socketPath }, callback);
  };
  syncBuiltinESMExports();
  t.after(async () => {
    http.request = originalRequest;
    syncBuiltinESMExports();
    if (previousCredential === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousCredential;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
    assert.equal(script.length, 0, "Driver must complete every expected Docker API exchange");
  });
  return { driver: new DockerComputeDriver({ images }), records };
}

function lifecycle(driver, events) {
  driver.setLifecycleDrivers([
    {
      id: "fixture-secrets",
      capability: "secrets",
      implementation: "fixture",
      computeLifecycleHooks: {
        beforeWorkloadStart(_revision, launch) {
          events.push("launch");
          launch.environment.RUNTIME_SECRET = "opaque-fixture-secret";
        },
        beforeWorkloadStop(_revision, signal) {
          assert.equal(signal.aborted, false);
          events.push("stop");
        },
      },
    },
  ]);
}

test(
  "Docker preflight uses the Engine socket and encodes image references",
  { timeout: 5_000 },
  async (t) => {
    const { driver } = await fixture(t, [
      step("GET", "/_ping", 200, "OK\n"),
      step("GET", "/images/gateway%3Alocal/json", 200, { Id: "gateway" }),
      step("GET", "/images/agent%3Alocal/json", 200, { Id: "agent" }),
    ]);
    await driver.preflight();
  },
);

test("Docker transport rejects malformed Engine JSON", { timeout: 5_000 }, async (t) => {
  const { driver } = await fixture(t, [step("GET", "/_ping", 200, "{broken")], {
    invalidJson: true,
  });
  await assert.rejects(driver.preflight(), /Docker API returned invalid JSON/);
});

test(
  "Docker namespace creation observes ownership before notifying lifecycle hooks",
  { timeout: 5_000 },
  async (t) => {
    let payload;
    const { driver, records } = await fixture(t, [
      step("GET", /^\/networks\/oce-/, 404, { message: "No such network" }),
      step("POST", "/networks/create", 201, { Id: "fixture-network" }, ({ body }) => {
        payload = body;
      }),
      step("GET", /^\/networks\/oce-/, 200, () => ({ Labels: payload.Labels })),
    ]);
    let notified = false;
    driver.setLifecycleDrivers([
      {
        id: "fixture-network-hook",
        capability: "secrets",
        implementation: "fixture",
        computeLifecycleHooks: {
          afterNamespacePrepared(observed) {
            assert.equal(observed.id, namespace.id);
            assert.equal(records.length, 3);
            notified = true;
          },
        },
      },
    ]);
    assert.deepEqual(await driver.ensureNamespace(namespace), {
      namespaceId: namespace.id,
      namespaceReady: true,
    });
    assert.deepEqual(payload.Labels, namespaceLabels);
    assert.equal(payload.Driver, "bridge");
    assert.equal(payload.CheckDuplicate, true);
    assert.equal(notified, true);
  },
);

test(
  "Docker embedded preparation creates, starts, and waits for healthy inspection",
  { timeout: 5_000 },
  async (t) => {
    let payload;
    const events = [];
    const { driver, records } = await fixture(t, [
      network(),
      absent(),
      created(({ body }) => {
        assert.deepEqual(events, ["launch"]);
        payload = body;
      }),
      started(304),
      inspected(() => payload, { Running: true, Health: { Status: "starting" } }),
      inspected(() => payload),
    ]);
    lifecycle(driver, events);
    const prepared = revision();
    assert.deepEqual(await driver.prepareRevision(prepared), {
      namespaceId: namespace.id,
      agentId: prepared.agentId,
      revisionId: prepared.id,
      ready: true,
    });
    const env = environment(payload);
    assert.equal(env.OPENAI_API_KEY, "fixture-model-credential");
    assert.equal(env.RUNTIME_SECRET, "opaque-fixture-secret");
    assert.equal(env.OPENCLAW_CONFIG_JSON, JSON.stringify(prepared.configuration));
    assert.match(env.OPENCLAW_GATEWAY_TOKEN, /^[0-9a-f]{64}$/);
    assert.equal(payload.Labels[`${prefix}revision-id`], prepared.id);
    assert.equal(payload.User, "1000:1000");
    assert.equal(payload.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(payload.HostConfig.CapDrop, ["ALL"]);
    assert.deepEqual(payload.HostConfig.PortBindings, {
      "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
    });
    assert.equal(records.filter(({ path }) => path.endsWith("/json")).length, 3);
    assert.deepEqual(events, ["launch"]);
  },
);

test(
  "Docker dedicated preparation delivers model credentials only to the Agent and cleans failed gateway first",
  { timeout: 5_000 },
  async (t) => {
    let agent;
    let gateway;
    let agentName;
    let gatewayName;
    const events = [];
    const { driver, records } = await fixture(t, [
      network(),
      absent(),
      created(({ body, path }) => {
        agent = body;
        agentName = new URL(path, "http://fixture").searchParams.get("name");
      }),
      started(),
      inspected(() => agent),
      absent(),
      created(({ body, path }) => {
        gateway = body;
        gatewayName = new URL(path, "http://fixture").searchParams.get("name");
      }),
      step("POST", /^\/containers\/oce-.*\/start$/, 500, { message: "gateway start failed" }),
      removed(),
      removed(),
    ]);
    lifecycle(driver, events);
    await assert.rejects(driver.prepareRevision(revision(1, "dedicated")), /gateway start failed/);
    const agentEnv = environment(agent);
    const gatewayEnv = environment(gateway);
    assert.equal(agentEnv.OPENAI_API_KEY, "fixture-model-credential");
    assert.equal(agentEnv.RUNTIME_SECRET, "opaque-fixture-secret");
    assert.equal(gatewayEnv.OPENAI_API_KEY, undefined);
    assert.equal(gatewayEnv.RUNTIME_SECRET, undefined);
    assert.match(agentEnv.APP_SERVER_TOKEN, /^[0-9a-f]{64}$/);
    assert.equal(gatewayEnv.APP_SERVER_TOKEN, agentEnv.APP_SERVER_TOKEN);
    assert.equal(gatewayEnv.APP_SERVER_URL, `ws://${agentName}:18790`);
    assert.equal(agent.HostConfig.PortBindings, undefined);
    assert.deepEqual(
      records.filter(({ method }) => method === "DELETE").map(({ path }) => path),
      [
        `/containers/${gatewayName}?force=true&v=true`,
        `/containers/${agentName}?force=true&v=true`,
      ],
    );
    assert.deepEqual(events, ["launch", "stop"]);
  },
);

test(
  "Docker failed create does not remove a container whose creation was rejected",
  { timeout: 5_000 },
  async (t) => {
    const events = [];
    const { driver } = await fixture(t, [
      network(),
      absent(),
      step("POST", /^\/containers\/create\?name=oce-/, 409, { message: "name conflict" }),
    ]);
    lifecycle(driver, events);
    await assert.rejects(driver.prepareRevision(revision()), /name conflict/);
    assert.deepEqual(events, ["launch", "stop"]);
  },
);

test(
  "Docker exited container fails readiness and is removed before launch cleanup",
  { timeout: 5_000 },
  async (t) => {
    let payload;
    const events = [];
    const { driver } = await fixture(t, [
      network(),
      absent(),
      created(({ body }) => {
        payload = body;
      }),
      started(),
      inspected(() => payload, { Running: false }),
      { ...removed(), inspect: () => assert.deepEqual(events, ["launch"]) },
    ]);
    lifecycle(driver, events);
    await assert.rejects(driver.prepareRevision(revision()), /exited before readiness/);
    assert.deepEqual(events, ["launch", "stop"]);
  },
);

test(
  "Docker owner cancellation aborts an in-flight start and recovers lifecycle cleanup signal",
  { timeout: 5_000 },
  async (t) => {
    let startReceived;
    const waitingForStart = new Promise((resolve) => {
      startReceived = resolve;
    });
    const events = [];
    const { driver, records } = await fixture(t, [
      network(),
      absent(),
      created(),
      step("POST", /^\/containers\/oce-.*\/start$/, undefined, undefined, () => startReceived()),
    ]);
    lifecycle(driver, events);
    const owner = new AbortController();
    const operation = withComputeAbortSignal(owner.signal, () =>
      driver.prepareRevision(revision()),
    );
    const rejected = assert.rejects(operation, (error) => error.name === "AbortError");
    await waitingForStart;
    owner.abort(new Error("operation cancelled"));
    await rejected;
    assert.deepEqual(events, ["launch", "stop"]);
    // Existing cancellation semantics keep Docker deletion under the cancelled owner;
    // the compensating HTTP removal cannot run, while hook cleanup gets a fresh signal.
    assert.equal(
      records.some(({ method }) => method === "DELETE"),
      false,
    );
  },
);

test(
  "Docker revision replacement precedes creation and stale retirement preserves the newer gateway",
  { timeout: 5_000 },
  async (t) => {
    let first;
    let second;
    const { driver, records } = await fixture(t, [
      network(),
      absent(),
      created(({ body }) => {
        first = body;
      }),
      started(),
      inspected(() => first),
      network(),
      inspected(() => first),
      removed(),
      created(({ body }) => {
        second = body;
      }),
      started(),
      inspected(() => second),
      network(),
      inspected(() => second),
      absent(),
      inspected(() => second),
    ]);
    assert.equal((await driver.prepareRevision(revision(1))).ready, true);
    assert.equal((await driver.prepareRevision(revision(2))).ready, true);
    assert.equal((await driver.prepareRevision(revision(1))).ready, false);
    await driver.retireRevision(revision(1));
    assert.equal(first.Labels[`${prefix}revision-number`], "1");
    assert.equal(second.Labels[`${prefix}revision-number`], "2");
    assert.equal(records.filter(({ method }) => method === "DELETE").length, 1);
  },
);

test(
  "Docker admitted revision is idempotent and rejects changed immutable configuration",
  { timeout: 5_000 },
  async (t) => {
    let payload;
    const { driver, records } = await fixture(t, [
      network(),
      absent(),
      created(({ body }) => {
        payload = body;
      }),
      started(),
      inspected(() => payload),
      network(),
      inspected(() => payload),
      network(),
      inspected(() => payload),
    ]);
    const prepared = revision();
    assert.equal((await driver.prepareRevision(prepared)).ready, true);
    assert.equal((await driver.prepareRevision(prepared)).ready, true);
    await assert.rejects(
      driver.prepareRevision({
        ...prepared,
        configuration: admitLoggingConfiguration({}, "debug"),
      }),
      /Immutable AgentRevision gateway configuration cannot change/,
    );
    assert.equal(records.filter(({ path }) => path.startsWith("/containers/create?")).length, 1);
    assert.equal(
      records.some(({ method }) => method === "DELETE"),
      false,
    );
  },
);

for (const [key, value] of [
  ["managed", "false"],
  ["compute-driver", "kubernetes"],
  ["namespace-id", "another-namespace"],
  ["agent-id", "another-agent"],
]) {
  test(
    `Docker preparation refuses a named gateway with mismatched ${key} ownership`,
    { timeout: 5_000 },
    async (t) => {
      const prepared = revision();
      const { driver, records } = await fixture(t, [
        network(),
        step("GET", /^\/containers\/oce-.*\/json$/, 200, {
          Config: {
            Labels: {
              ...namespaceLabels,
              [`${prefix}agent-id`]: prepared.agentId,
              [`${prefix}revision-id`]: prepared.id,
              [`${prefix}revision-number`]: "1",
              [`${prefix}${key}`]: value,
            },
          },
          State: { Running: true, Health: { Status: "healthy" } },
        }),
      ]);
      await assert.rejects(driver.prepareRevision(prepared), /Refusing unowned Docker container/);
      assert.equal(
        records.some(({ method }) => method !== "GET"),
        false,
      );
    },
  );
}

test(
  "Docker retirement refuses an Agent whose inspected revision ownership differs",
  { timeout: 5_000 },
  async (t) => {
    const prepared = revision(1, "dedicated");
    const { driver, records } = await fixture(t, [
      step("GET", /^\/containers\/oce-.*-agent-.*\/json$/, 200, {
        Config: {
          Labels: {
            ...namespaceLabels,
            [`${prefix}agent-id`]: prepared.agentId,
            [`${prefix}revision-id`]: "another-revision",
          },
        },
      }),
    ]);
    await assert.rejects(driver.retireRevision(prepared), /Refusing unowned Docker container/);
    assert.equal(records.length, 1);
  },
);

test(
  "Docker namespace deletion rechecks every listed container before removing any",
  { timeout: 5_000 },
  async (t) => {
    const { driver, records } = await fixture(t, [
      network(),
      step(
        "GET",
        /^\/containers\/json\?all=true&filters=/,
        200,
        [{ Id: "owned" }, { Id: "foreign" }],
        ({ path }) => {
          assert.deepEqual(
            JSON.parse(new URL(path, "http://fixture").searchParams.get("filters")),
            {
              label: Object.entries(namespaceLabels).map(([key, value]) => `${key}=${value}`),
            },
          );
        },
      ),
      step("GET", "/containers/owned/json", 200, { Config: { Labels: namespaceLabels } }),
      // Even if the Engine's filtered list includes an object, its inspected ownership
      // is authoritative. No previously inspected container may be deleted on failure.
      step("GET", "/containers/foreign/json", 200, {
        Config: { Labels: { ...namespaceLabels, [`${prefix}namespace-id`]: "another-namespace" } },
      }),
    ]);
    assert.deepEqual(await driver.deleteNamespace(namespace), {
      namespaceId: namespace.id,
      namespaceDeleted: false,
      failure: "permanent",
    });
    assert.equal(
      records.some(({ method }) => method === "DELETE"),
      false,
    );
  },
);
