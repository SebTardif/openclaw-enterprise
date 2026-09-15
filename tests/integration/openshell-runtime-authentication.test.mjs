import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellSandboxAlreadyExistsError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

test("runtime authentication consumes the public gateway types without forging owner handles", () => {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-p",
      "packages/occ/tsconfig.credential-gateway-v1.json",
      "--pretty",
      "false",
    ],
    { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8", timeout: 60_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

function fixture({ gateFailure = false, createFailure, providers = ["model-provider"] } = {}) {
  const events = [];
  const observations = [];
  const requests = [];
  const receivers = [];
  let retained = false;
  const options = {
    gateway: { endpoint: "https://broker.example.test:50051", workspace: "model-workspace" },
    kubernetes: {
      runtimeClassName: "openshell",
      serviceAccount: { mode: "driverConfig" },
      sandboxDataMount: {
        subPath: "execution/workspace",
        mountPath: "/sandbox/workspace",
        readOnly: false,
      },
    },
    policy: {
      process: { runAsUser: "1000", runAsGroup: "1000" },
      networkPolicies: [{ name: "model", endpoints: [{ host: "api.example.test", ports: [443] }] }],
    },
  };
  // Exercise the actual adapter at its declared broker and upstream transport
  // boundaries. These substitutes do not prove broker admission or live OpenShell.
  const driver = new OpenShellSandboxDriver(options, {
    id: "sandbox-model",
    gatewayClient: {
      async createSandbox(request) {
        events.push("create");
        requests.push(request);
        if (createFailure) throw createFailure(request.name);
        return { name: request.name, id: "runtime-uid", labels: request.labels };
      },
      close() {},
    },
  });
  const context = {
    namespace: { id: "namespace-id", name: "tenant-runtime" },
    revision: {
      id: "revision-id",
      namespaceId: "namespace-id",
      agentId: "agent-id",
      sandboxDriverId: "sandbox-model",
      harness: { id: "codex", mode: "dedicated" },
    },
    signal: new AbortController().signal,
    requirements: {
      image: "example.test/harness@sha256:" + "a".repeat(64),
      command: ["codex", "app-server"],
      serviceAccountName: "agent-principal",
      serviceAccountToken: {
        audience: "oce",
        expirationSeconds: 600,
        mountPath: "/var/run/oce/principal",
        path: "token",
        readOnly: true,
      },
      workspaceMounts: [
        {
          claimName: "workspace",
          subPath: "execution/workspace",
          mountPath: "/workspace",
          readOnly: false,
        },
      ],
      environment: [],
      labels: { "openclaw.dev/agent-id": "agent-id" },
    },
    runtimeAuthentication: {
      async prepare(receiver) {
        receivers.push(receiver);
        if (retained) return { kind: "retained" };
        return {
          kind: "create",
          providers,
          assertAndConsume() {
            events.push("gate");
            if (gateFailure) throw new Error("closed");
          },
          async observe(outcome) {
            events.push("observe");
            observations.push(outcome);
          },
        };
      },
    },
  };
  return {
    driver,
    context,
    events,
    observations,
    requests,
    receivers,
    retain() {
      retained = true;
    },
  };
}

test("OpenShell gates the exact receiver and attaches only the broker-selected providers", async () => {
  const f = fixture();
  const sandbox = await f.driver.provisionHarness(f.context);
  assert.deepEqual(f.receivers, [
    {
      sandboxDriverId: "sandbox-model",
      gatewayEndpoint: "https://broker.example.test:50051",
      workspace: "model-workspace",
      namespaceName: "tenant-runtime",
      resourceName: sandbox.resourceName,
    },
  ]);
  assert.deepEqual(f.requests[0].spec.providers, ["model-provider"]);
  assert.deepEqual(f.requests[0].spec.environment, {});
  assert.deepEqual(f.events, ["gate", "create", "observe"]);
  assert.deepEqual(f.observations, [{ kind: "created", receiverUid: "runtime-uid" }]);
});

test("closure before the OpenShell create gate submits nothing", async () => {
  const f = fixture({ gateFailure: true });
  await assert.rejects(f.driver.provisionHarness(f.context), /closed/);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.observations, [{ kind: "not-submitted" }]);
});

for (const [name, createFailure] of [
  ["lost create reply", () => new Error("connection lost")],
  ["AlreadyExists", (name) => new OpenShellSandboxAlreadyExistsError(name)],
]) {
  test(`OpenShell retains ${name} as an unknown attachment outcome`, async () => {
    const f = fixture({ createFailure });
    if (name === "AlreadyExists") await f.driver.provisionHarness(f.context);
    else await assert.rejects(f.driver.provisionHarness(f.context), /connection lost/);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.observations, [{ kind: "unknown" }]);
  });
}

test("invalid broker provider references fail before OpenShell submission", async () => {
  const f = fixture({ providers: ["same", "same"] });
  await assert.rejects(f.driver.provisionHarness(f.context), /invalid OpenShell provider/);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.observations, [{ kind: "not-submitted" }]);
});

test("OpenShell reuses an owner-retained receiver without another create or outcome", async () => {
  const f = fixture();
  const original = await f.driver.provisionHarness(f.context);
  // The broker dependency now identifies the retained original attempt. The
  // adapter must leave readiness to Compute inspection and submit no new create.
  f.retain();
  const recovered = await f.driver.provisionHarness(f.context);
  assert.deepEqual(recovered, original);
  assert.equal(f.receivers.length, 2);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.events, ["gate", "create", "observe"]);
  assert.deepEqual(f.observations, [{ kind: "created", receiverUid: "runtime-uid" }]);
});
