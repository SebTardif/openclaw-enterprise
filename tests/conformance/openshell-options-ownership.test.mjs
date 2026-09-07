import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deepFreeze } from "../../packages/utils/src/objects.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";

function options() {
  return {
    gateway: {
      endpoint: "https://openshell.example.test:50051",
      workspace: "accepted-workspace",
      auth: { mode: "bearerTokenFile", path: "/run/openshell/token" },
    },
    kubernetes: {
      runtimeClassName: "openshell-sandbox",
      serviceAccount: { mode: "driverConfig" },
      sandboxDataMount: {
        claimName: "agent-workspace",
        subPath: "workspace",
        mountPath: "/sandbox/enterprise",
        readOnly: false,
      },
      agentResources: { requests: { cpu: "250m" }, limits: { memory: "1Gi" } },
      userNamespaces: true,
    },
    policy: {
      filesystem: {
        includeWorkdir: false,
        readOnly: ["/opt/codex"],
        readWrite: ["/tmp/codex"],
      },
      landlockCompatibility: "best_effort",
      process: { runAsUser: "1000", runAsGroup: "1000" },
      networkPolicies: [
        {
          name: "model-egress",
          endpoints: [{ host: "api.openai.com", ports: [443], protocol: "tcp", tls: "terminate" }],
        },
      ],
    },
    sandboxNamePrefix: "sb",
    logLevel: "info",
    providers: ["openai"],
  };
}

function context() {
  return {
    namespace: {
      id: "namespace-one",
      name: "tenant-one",
      status: "ready",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    revision: {
      id: "revision-one",
      namespaceId: "namespace-one",
      agentId: "agent-one",
      revision: 1,
      providerId: "provider-openai",
      configurationId: "configuration-one",
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: {},
      harness: { mode: "dedicated", id: "codex", version: "0.153.0" },
      compute: { id: "compute-kubernetes", implementation: "kubernetes" },
      sandboxDriverId: "sandbox-openshell-local",
      servicePrincipalId: "service-principal-one",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    requirements: {
      image: `codex@sha256:${"a".repeat(64)}`,
      command: ["codex", "app-server"],
      serviceAccountName: "agent-one",
      serviceAccountToken: {
        audience: "openclaw-service-principal",
        expirationSeconds: 600,
        mountPath: "/var/run/openclaw/service-principal",
        path: "token",
        readOnly: true,
      },
      workspaceMounts: [
        {
          claimName: "agent-workspace",
          subPath: "workspace",
          mountPath: "/workspace",
          readOnly: false,
        },
      ],
      environment: [{ name: "CODEX_HOME", value: "/workspace/.codex" }],
      labels: { "openclaw.dev/agent-id": "agent-one" },
    },
    kubernetes: undefined,
    signal: new AbortController().signal,
  };
}

function gatewayRecorder() {
  // This supported injected capability captures the actual driver's request;
  // it does not implement or qualify the provider's protocol or enforcement.
  return {
    creates: [],
    deletes: [],
    closeCount: 0,
    async health() {},
    async createSandbox(request, signal) {
      this.creates.push({ request, signal });
      return { ...request, id: "provider-sandbox-one", deletionTimestampMs: "0" };
    },
    async getSandbox() {
      assert.fail("Provisioning through the injected client must use createSandbox.");
    },
    async deleteSandbox(request, signal) {
      this.deletes.push({ request, signal });
    },
    close() {
      this.closeCount += 1;
    },
  };
}

test("OpenShell provisioning and cleanup retain accepted nested options and the injected capability", async (t) => {
  const supplied = options();
  const original = structuredClone(supplied);
  const gatewayClient = gatewayRecorder();
  const selection = { gatewayClient };
  const driver = new OpenShellSandboxDriver(supplied, selection);
  t.after(() => driver.close());
  assert.deepEqual(supplied, original);
  assert.equal(Object.isFrozen(supplied.kubernetes.agentResources.limits), false);
  assert.equal(Object.isFrozen(gatewayClient), false);

  // Mutations remain possible for the caller, but cannot rewrite accepted intent.
  supplied.gateway.workspace = "changed-workspace";
  supplied.gateway.auth.path = "/run/openshell/changed-token";
  supplied.sandboxNamePrefix = "zz";
  supplied.logLevel = "debug";
  supplied.providers.push("changed-provider");
  supplied.kubernetes.runtimeClassName = "changed-runtime";
  supplied.kubernetes.serviceAccount.mode = "gatewayConfigured";
  supplied.kubernetes.sandboxDataMount.mountPath = "/sandbox/changed";
  supplied.kubernetes.sandboxDataMount.readOnly = true;
  supplied.kubernetes.agentResources.requests.cpu = "2";
  supplied.kubernetes.agentResources.limits.memory = "8Gi";
  supplied.kubernetes.userNamespaces = false;
  supplied.policy.process.runAsUser = "2000";
  supplied.policy.process.runAsGroup = "2000";
  supplied.policy.landlockCompatibility = "hard_requirement";
  supplied.policy.filesystem.includeWorkdir = true;
  supplied.policy.filesystem.readOnly.push("/opt/changed");
  supplied.policy.filesystem.readWrite[0] = "/tmp/changed";
  supplied.policy.networkPolicies[0].name = "changed-egress";
  supplied.policy.networkPolicies[0].endpoints[0].host = "changed.example.test";
  supplied.policy.networkPolicies[0].endpoints[0].ports.push(8443);
  supplied.policy.networkPolicies[0].endpoints[0].tls = "passthrough";
  selection.gatewayClient = gatewayRecorder();

  const requestContext = context();
  const reference = await driver.provisionHarness(requestContext);
  const [{ request, signal }] = gatewayClient.creates;
  const expectedName = `sb-${createHash("sha256").update(requestContext.revision.id).digest("hex").slice(0, 16)}`;
  assert.equal(signal, requestContext.signal);
  assert.equal(request.name, expectedName);
  assert.equal(reference.resourceName, expectedName);
  assert.equal(request.workspace, original.gateway.workspace);
  assert.equal(request.spec.log_level, "info");
  assert.deepEqual(request.spec.providers, ["openai"]);
  assert.deepEqual(request.spec.policy.process, { run_as_user: "1000", run_as_group: "1000" });
  assert.deepEqual(request.spec.policy.landlock, { compatibility: "best_effort" });
  assert.deepEqual(request.spec.policy.network_policies, {
    "model-egress": {
      name: "model-egress",
      endpoints: [{ host: "api.openai.com", ports: [443], protocol: "tcp", tls: "terminate" }],
    },
  });
  assert.deepEqual(request.spec.policy.filesystem, {
    include_workdir: false,
    read_only: ["/opt/codex", "/var/run/openclaw/service-principal"],
    read_write: ["/tmp/codex", "/workspace", "/sandbox/enterprise"],
  });
  assert.equal(request.spec.template.runtime_class_name, "openshell-sandbox");
  assert.equal(request.spec.template.user_namespaces, true);
  const kubernetes = request.spec.template.driver_config.kubernetes;
  assert.deepEqual(kubernetes.pod, {
    runtime_class_name: "openshell-sandbox",
    service_account_name: "agent-one",
  });
  assert.deepEqual(kubernetes.containers.agent.resources, original.kubernetes.agentResources);
  assert.ok(
    kubernetes.containers.agent.volume_mounts.some(
      (mount) => mount.mount_path === "/sandbox/enterprise" && mount.read_only === false,
    ),
  );

  // Resources are forwarded into the request; the consumer cannot mutate the
  // retained configuration through that nested reference between operations.
  assert.throws(() => {
    kubernetes.containers.agent.resources.limits.memory = "16Gi";
  }, TypeError);
  supplied.kubernetes.agentResources.limits.memory = "32Gi";
  const nextReference = await driver.provisionHarness(requestContext);
  assert.deepEqual(nextReference, reference);
  assert.deepEqual(gatewayClient.creates[1].request, request);
  await driver.cleanup(requestContext);
  assert.deepEqual(gatewayClient.deletes, [
    { request: { name: expectedName, workspace: "accepted-workspace" }, signal },
  ]);
  driver.close();
  assert.equal(gatewayClient.closeCount, 1);
  assert.equal(selection.gatewayClient.creates.length, 0);
  assert.equal(selection.gatewayClient.closeCount, 0);
});

test("OpenShell accepts deeply frozen caller configuration without modifying it", async (t) => {
  const supplied = deepFreeze(options());
  const original = structuredClone(supplied);
  const gatewayClient = gatewayRecorder();
  const driver = new OpenShellSandboxDriver(supplied, { gatewayClient });
  t.after(() => driver.close());
  await driver.provisionHarness(context());
  assert.equal(gatewayClient.creates.length, 1);
  assert.deepEqual(supplied, original);
  assert.notEqual(
    gatewayClient.creates[0].request.spec.template.driver_config.kubernetes.containers.agent
      .resources,
    supplied.kubernetes.agentResources,
  );
});

test("OpenShell rejects invalid accepted configuration before using the injected capability", () => {
  for (const [change, expected] of [
    [(value) => (value.policy.networkPolicies[0].endpoints[0].ports = [0]), /valid TCP port/],
    [(value) => (value.kubernetes.sandboxDataMount.subPath = ".."), /exact PVC subpath/],
    [(value) => (value.gateway.binaryPath = "relative-binary"), /invalid_binary_path/],
    [
      (value) =>
        (value.gateway.networkPolicyResources = [
          { apiVersion: "v1", kind: "Secret", metadata: { name: "credential" } },
        ]),
      /must not contain OpenShell credential-bearing Secrets/,
    ],
  ]) {
    const supplied = options();
    change(supplied);
    const original = structuredClone(supplied);
    const gatewayClient = gatewayRecorder();
    assert.throws(() => new OpenShellSandboxDriver(supplied, { gatewayClient }), expected);
    assert.deepEqual(supplied, original);
    assert.equal(gatewayClient.creates.length, 0);
    assert.equal(gatewayClient.closeCount, 0);
  }
});
