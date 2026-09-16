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

function fixture({
  gateFailure = false,
  createFailure,
  createResponse,
  beforeCreate,
  finalize,
  providers = ["model-provider"],
} = {}) {
  const events = [];
  const observations = [];
  const requests = [];
  const receivers = [];
  const providerSignals = [];
  const ownerSignal = new AbortController().signal;
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
      async createSandbox(request, signal) {
        events.push("create");
        requests.push(request);
        providerSignals.push(signal);
        if (createFailure) throw createFailure(request.name);
        return createResponse ?? { name: request.name, id: "runtime-uid", labels: request.labels };
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
          async submit(create) {
            events.push("submit");
            await beforeCreate?.();
            if (gateFailure) throw new Error("closed");
            let outcome;
            let failure;
            try {
              outcome = await create(ownerSignal);
            } catch (error) {
              outcome = { kind: "unknown" };
              failure = { error };
            }
            await finalize?.();
            events.push("record");
            observations.push(outcome);
            if (failure !== undefined) throw failure.error;
          },
        };
      },
    },
  };
  return {
    driver,
    options,
    context,
    ownerSignal,
    providerSignals,
    events,
    observations,
    requests,
    receivers,
    retain() {
      retained = true;
    },
  };
}

test("OpenShell submits the exact receiver and attaches only the broker-selected providers", async () => {
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
  assert.equal(f.providerSignals[0], f.ownerSignal);
  assert.ok(Object.isFrozen(sandbox));
  assert.deepEqual(f.events, ["submit", "create", "record"]);
  assert.deepEqual(f.observations, [{ kind: "created", receiverUid: "runtime-uid" }]);
});

test("closure before OpenShell admission submits nothing", async () => {
  const f = fixture({ gateFailure: true });
  await assert.rejects(f.driver.provisionHarness(f.context), /closed/);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.observations, []);
});

for (const [name, createFailure] of [
  ["lost create reply", () => new Error("connection lost")],
  ["AlreadyExists", (name) => new OpenShellSandboxAlreadyExistsError(name)],
]) {
  test(`OpenShell retains ${name} as an unknown attachment outcome`, async () => {
    const f = fixture({ createFailure });
    if (name === "AlreadyExists") {
      const sandbox = await f.driver.provisionHarness(f.context);
      assert.equal(sandbox.resourceName, f.requests[0].name);
      assert.ok(Object.isFrozen(sandbox));
    } else await assert.rejects(f.driver.provisionHarness(f.context), /connection lost/);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.observations, [{ kind: "unknown" }]);
  });
}

test("invalid broker provider references fail before OpenShell submission", async () => {
  const f = fixture({ providers: ["same", "same"] });
  await assert.rejects(f.driver.provisionHarness(f.context), /invalid OpenShell provider/);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.observations, []);
  assert.deepEqual(f.events, []);
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
  assert.deepEqual(f.events, ["submit", "create", "record"]);
  assert.deepEqual(f.observations, [{ kind: "created", receiverUid: "runtime-uid" }]);
});

test("OpenShell snapshots nested provider input before asynchronous admission", async () => {
  const admitted = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const f = fixture({
    beforeCreate() {
      entered.resolve();
      return admitted.promise;
    },
  });
  const operation = f.driver.provisionHarness(f.context);
  await entered.promise;
  assert.equal(f.requests.length, 0, "admission has not permitted a provider call");
  f.context.requirements.labels["openclaw.dev/agent-id"] = "replacement-agent";
  f.context.requirements.command.push("replacement-command");
  f.context.revision.id = "replacement-revision";
  f.options.policy.networkPolicies[0].endpoints[0].ports.push(80);
  f.options.policy.process.runAsUser = "0";
  admitted.resolve();
  await operation;
  const request = f.requests[0];
  assert.deepEqual(request.labels, { "openclaw.dev/agent-id": "agent-id" });
  assert.deepEqual(request.spec.template.labels, request.labels);
  assert.deepEqual(request.spec.command, ["codex", "app-server"]);
  assert.equal(request.annotations["openclaw.dev/revision-id"], "revision-id");
  assert.deepEqual(request.spec.policy.network_policies.model.endpoints[0].ports, [443]);
  assert.equal(request.spec.policy.process.run_as_user, "1000");
});

test("OpenShell waits for owner recording after the provider call", async () => {
  const recorded = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const f = fixture({
    finalize() {
      entered.resolve();
      return recorded.promise;
    },
  });
  let settled = false;
  const operation = f.driver.provisionHarness(f.context).finally(() => {
    settled = true;
  });
  await entered.promise;
  assert.equal(f.requests.length, 1);
  assert.equal(settled, false);
  recorded.resolve();
  await operation;
  assert.equal(settled, true);
});

test("OpenShell records a wrong-name response as unknown", async () => {
  const f = fixture({ createResponse: { name: "another-sandbox", id: "wrong-uid" } });
  await assert.rejects(f.driver.provisionHarness(f.context), /different Sandbox name/);
  assert.deepEqual(f.observations, [{ kind: "unknown" }]);
});

test("invalid OpenShell workload specifications fail before submission", async () => {
  const f = fixture();
  f.context.requirements.workspaceMounts[0].mountPath = "relative";
  await assert.rejects(f.driver.provisionHarness(f.context), /absolute/);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.requests, []);
});

test("retained OpenShell attempts do not construct a replacement request", async () => {
  const f = fixture();
  f.retain();
  // Invalid create-only input cannot affect inspection of the original receiver.
  f.context.requirements.workspaceMounts[0].mountPath = "relative";
  await f.driver.provisionHarness(f.context);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.requests, []);
});

test("OpenShell preserves direct creation and name validation without runtime authentication", async () => {
  const f = fixture();
  delete f.context.runtimeAuthentication;
  await f.driver.provisionHarness(f.context);
  assert.deepEqual(f.events, ["create"]);
  assert.equal(f.providerSignals[0], f.context.signal);
  assert.deepEqual(f.requests[0].spec.providers, []);
  const invalid = fixture({ createResponse: { name: "wrong-sandbox" } });
  delete invalid.context.runtimeAuthentication;
  await assert.rejects(invalid.driver.provisionHarness(invalid.context), /different Sandbox name/);
});
