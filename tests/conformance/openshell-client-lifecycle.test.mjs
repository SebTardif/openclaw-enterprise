import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createConfiguration, KubernetesObjectApi } from "@kubernetes/client-node";

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

function context(name = "one") {
  return {
    namespace: {
      id: `namespace-${name}`,
      name: `tenant-${name}`,
      status: "ready",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    revision: {
      id: `revision-${name}`,
      namespaceId: `namespace-${name}`,
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

function deferred() {
  return Promise.withResolvers();
}

function controlledClient({ completion, invokeError, closeError, onClose } = {}) {
  const calls = [];
  function invoke(receiver, method, request, signal) {
    calls.push({ receiver, method, request, signal });
    if (invokeError !== undefined) throw invokeError;
    return (completion?.promise ?? Promise.resolve()).then(() =>
      method === "createSandbox"
        ? { ...request, id: "provider-sandbox-one", deletionTimestampMs: "0" }
        : undefined,
    );
  }
  return {
    calls,
    closeCount: 0,
    health(signal) {
      return invoke(this, "health", undefined, signal);
    },
    createSandbox(request, signal) {
      return invoke(this, "createSandbox", request, signal);
    },
    getSandbox() {
      assert.fail("The driver must not issue an unrelated gateway read.");
    },
    deleteSandbox(request, signal) {
      return invoke(this, "deleteSandbox", request, signal);
    },
    close() {
      this.closeCount += 1;
      onClose?.();
      if (closeError !== undefined) throw closeError;
    },
  };
}

function networkPolicy() {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "gateway-egress" },
    spec: { podSelector: {}, policyTypes: ["Egress"], egress: [] },
  };
}

// The driver requires this native SDK class by identity. Only public effect
// methods are controlled here; this is driver coverage, not cluster/API proof.
class ControlledKubernetes extends KubernetesObjectApi {
  calls = [];
  entered = { patch: deferred(), read: deferred() };

  constructor({ patchGate, readGate, deleteError } = {}) {
    super(createConfiguration());
    this.patchGate = patchGate;
    this.readGate = readGate;
    this.deleteError = deleteError;
  }

  async patch(resource, ...args) {
    this.calls.push({ method: "patch", resource, args });
    this.entered.patch.resolve();
    await this.patchGate?.promise;
    return resource;
  }

  async read(resource) {
    this.calls.push({ method: "read", resource });
    this.entered.read.resolve();
    await this.readGate?.promise;
    return { ...resource, spec: { ports: [{ port: 50051 }] } };
  }

  async list(...args) {
    this.calls.push({ method: "list", args });
    return {
      apiVersion: "v1",
      kind: "PodList",
      metadata: {},
      items: [
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name: "gateway-one", namespace: args[2] },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        },
      ],
    };
  }

  async delete(resource) {
    this.calls.push({ method: "delete", resource });
    if (this.deleteError !== undefined) throw this.deleteError;
    return { apiVersion: "v1", kind: "Status", status: "Success", code: 200 };
  }
}

function namespaceContext(request) {
  return { namespace: request.namespace, kubernetes: request.kubernetes, signal: request.signal };
}

function assertOwned(driver, count) {
  // Supplement observable invocation/close/settlement assertions with the
  // actual owner's retention, without reproducing its registry algorithm.
  assert.equal(driver.activeNativeCalls.size, count);
}

test("OpenShell owns native calls until settlement", { concurrency: false }, async (t) => {
  let construct;
  // Requires --experimental-test-module-mocks. The real driver is imported only
  // after substituting its existing client constructor boundary. No executable,
  // bridge protocol, driver lifecycle method or shared SDK prototype is mocked.
  t.mock.module(
    new URL(
      "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts",
      import.meta.url,
    ),
    {
      namedExports: {
        GoOpenShellGatewayClient: class {
          constructor(selectedOptions) {
            return construct(selectedOptions);
          }
        },
      },
    },
  );
  const { OpenShellSandboxDriver } =
    await import("../../apps/controller/src/drivers/sandbox/openshell.ts");

  function fixture(subtest, supplied = options(), selection = {}) {
    const plans = [];
    const constructions = [];
    construct = (selectedOptions) => {
      const plan = plans.shift() ?? {};
      if (plan.constructorError !== undefined) throw plan.constructorError;
      const client = controlledClient(plan);
      constructions.push({ selectedOptions, client });
      return client;
    };
    const driver = new OpenShellSandboxDriver(supplied, selection);
    // Existing configuration validation constructs a client without invoking it.
    // It is separate from every operation-owned native adapter below.
    const validation = constructions.shift();
    assert.equal(validation.client.calls.length, 0);
    subtest.after(() => driver.close());
    return { driver, plans, constructions };
  }

  await t.test("Namespace churn retires each success and failure without cleanup", async (s) => {
    const supplied = options();
    supplied.gateway = { serviceName: "gateway" };
    const { driver, plans, constructions } = fixture(s, supplied);
    for (let i = 0; i < 12; i += 1) {
      const failure = new Error(`operation ${i} failed`);
      plans.push(i % 2 === 0 ? {} : { invokeError: failure });
      const request = context(String(i));
      const operation = driver.provisionHarness(request);
      if (i % 2 === 0) await operation;
      else await assert.rejects(operation, (error) => error === failure);
      const { client, selectedOptions } = constructions.at(-1);
      assert.equal(selectedOptions.endpoint, `http://gateway.tenant-${i}.svc:50051`);
      assert.equal(client.calls.length, 1);
      assert.equal(client.closeCount, 1);
      assertOwned(driver, 0);
    }
    driver.close();
    assert.ok(constructions.every(({ client }) => client.closeCount === 1));
  });

  await t.test("shared endpoints keep concurrent Namespace calls independent", async (s) => {
    for (const gateway of [
      { endpoint: "http://gateway.example.test:50051" },
      { serviceName: "gateway.shared.svc" },
    ]) {
      const { driver, plans, constructions } = fixture(s, { ...options(), gateway });
      const first = deferred();
      const survivor = deferred();
      plans.push({ completion: first }, { completion: survivor });
      const cancelled = new AbortController();
      const firstContext = context("a");
      firstContext.signal = cancelled.signal;
      const a = driver.provisionHarness(firstContext);
      const b = driver.provisionHarness(context("b"));
      assertOwned(driver, 2);
      assert.equal(
        constructions[0].selectedOptions.endpoint,
        constructions[1].selectedOptions.endpoint,
      );
      assert.notEqual(constructions[0].client, constructions[1].client);
      if (gateway.endpoint !== undefined) {
        first.resolve();
        await a;
      } else {
        const cancellation = new Error("first caller cancelled");
        const rejected = assert.rejects(a, (error) => error === cancellation);
        cancelled.abort(cancellation);
        first.reject(cancellation);
        await rejected;
      }
      assert.equal(constructions[0].client.closeCount, 1);
      assert.equal(constructions[1].client.closeCount, 0);
      assertOwned(driver, 1);
      survivor.resolve();
      await b;
      await driver.provisionHarness(context("b"));
      assert.equal(constructions.length, 3);
      assertOwned(driver, 0);
      driver.close();
    }
  });

  await t.test(
    "Namespace cleanup success, failure and recreation preserve a pending caller",
    async (s) => {
      for (const cleanupFailure of [undefined, new Error("resource deletion failed")]) {
        const supplied = options();
        supplied.gateway.networkPolicyResources = [networkPolicy()];
        const { driver, plans, constructions } = fixture(s, supplied);
        const pending = deferred();
        plans.push({ completion: pending });
        const operation = driver.provisionHarness(context("survivor"));
        const removed = context("removed");
        removed.kubernetes = new ControlledKubernetes({ deleteError: cleanupFailure });
        const cleanup = driver.cleanup(namespaceContext(removed));
        if (cleanupFailure === undefined) await cleanup;
        else await assert.rejects(cleanup, (error) => error === cleanupFailure);
        assert.equal(removed.kubernetes.calls[0].method, "delete");
        assert.equal(removed.kubernetes.calls[0].resource.metadata.namespace, "tenant-removed");
        assert.equal(constructions.length, 1);
        assert.equal(constructions[0].client.closeCount, 0);
        assertOwned(driver, 1);
        // Reusing the Namespace name creates a fresh call, regardless of cleanup.
        await driver.provisionHarness(context("removed"));
        assert.equal(constructions[1].client.closeCount, 1);
        assert.equal(constructions[0].client.closeCount, 0);
        pending.resolve();
        await operation;
        assertOwned(driver, 0);
        driver.close();
      }
    },
  );

  await t.test(
    "construction and synchronous invocation failures keep exact ownership",
    async (s) => {
      const { driver, plans, constructions } = fixture(s);
      const constructionFailure = new Error("constructor failed");
      plans.push({ constructorError: constructionFailure });
      await assert.rejects(
        driver.provisionHarness(context()),
        (error) => error === constructionFailure,
      );
      assert.equal(constructions.length, 0);
      assertOwned(driver, 0);
      const invocationFailure = new Error("invocation failed");
      for (const method of ["ensureNamespace", "provisionHarness", "cleanup"]) {
        plans.push({ invokeError: invocationFailure });
        await assert.rejects(driver[method](context()), (error) => error === invocationFailure);
        assert.equal(constructions.at(-1).client.closeCount, 1);
        assertOwned(driver, 0);
      }
      await driver.provisionHarness(context());
      assert.equal(constructions.at(-1).client.closeCount, 1);
    },
  );

  await t.test(
    "abort and signal deadline do not substitute for underlying settlement",
    async (s) => {
      for (const deadline of [false, true]) {
        const { driver, plans, constructions } = fixture(s);
        const pending = deferred();
        const controller = new AbortController();
        const signal = deadline ? AbortSignal.timeout(1) : controller.signal;
        const aborted = once(signal, "abort");
        plans.push({ completion: pending });
        const request = context();
        request.signal = signal;
        const operation = driver.provisionHarness(request);
        let settled = false;
        const observed = operation.then(() => {
          settled = true;
        });
        if (deadline) await Promise.all([aborted, delay(1)]);
        else {
          controller.abort();
          await aborted;
        }
        assert.equal(constructions[0].client.calls[0].signal, signal);
        assert.equal(settled, false);
        assert.equal(constructions[0].client.closeCount, 0);
        assertOwned(driver, 1);
        // This models a capability whose operation has not yet acknowledged
        // cancellation. The native subprocess deadline needs its own real test.
        pending.resolve();
        await observed;
        assertOwned(driver, 0);
        assert.equal(constructions[0].client.closeCount, 1);
        driver.close();
      }
    },
  );

  await t.test("close cancels all pending calls once before any can be admitted", async (s) => {
    const { driver, plans, constructions } = fixture(s);
    const closeFailure = new Error("cancellation failed");
    const anotherCloseFailure = new Error("another cancellation failed");
    const pending = [deferred(), deferred(), deferred()];
    const rejectedAdmissions = [];
    plans.push(
      {
        completion: pending[0],
        closeError: closeFailure,
        onClose() {
          rejectedAdmissions.push(
            assert.rejects(driver.provisionHarness(context("late")), /closed/),
          );
          driver.close();
        },
      },
      { completion: pending[1] },
      { completion: pending[2], closeError: anotherCloseFailure },
    );
    const operations = pending.map((_, i) => driver.provisionHarness(context(String(i))));
    assert.throws(driver.close.bind(driver), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [closeFailure, anotherCloseFailure]);
      return true;
    });
    driver.close();
    await Promise.all(rejectedAdmissions);
    assert.equal(constructions.length, 3);
    assert.ok(constructions.every(({ client }) => client.closeCount === 1));
    assertOwned(driver, 3);
    pending[0].resolve();
    await operations[0];
    assertOwned(driver, 2);
    pending[1].resolve();
    pending[2].resolve();
    await Promise.all(operations);
    assertOwned(driver, 0);
    assert.ok(constructions.every(({ client }) => client.closeCount === 1));
  });

  await t.test(
    "close before use rejects effectful operations and permits pure configuration",
    async (s) => {
      const { driver, constructions } = fixture(s);
      const request = context();
      request.kubernetes = new ControlledKubernetes();
      driver.close();
      driver.close();
      for (const method of ["ensureNamespace", "provisionHarness", "cleanup"]) {
        await assert.rejects(driver[method](request), /closed/);
      }
      await assert.rejects(driver.cleanup(namespaceContext(request)), /closed/);
      assert.equal(constructions.length, 0);
      assert.equal(request.kubernetes.calls.length, 0);
      assert.equal(request.signal.aborted, false);
      assert.equal(
        driver.configureAgent({}).plugins.entries.codex.config.appServer.sandbox,
        "danger-full-access",
      );
      const injected = controlledClient();
      const unused = fixture(s, options(), { gatewayClient: injected });
      unused.driver.close();
      unused.driver.close();
      await assert.rejects(unused.driver.ensureNamespace(request), /closed/);
      assert.equal(injected.closeCount, 1);
      assert.equal(injected.calls.length, 0);
      assert.equal(unused.constructions.length, 0);
    },
  );

  await t.test(
    "close during resource or readiness awaits prevents later native allocation",
    async (s) => {
      for (const stage of ["patch", "read"]) {
        const supplied = options();
        supplied.gateway.networkPolicyResources = [networkPolicy()];
        supplied.gateway.readiness = { serviceName: "gateway", podSelector: { app: "gateway" } };
        const gate = deferred();
        const request = context();
        request.kubernetes = new ControlledKubernetes({
          patchGate: stage === "patch" ? gate : undefined,
          readGate: stage === "read" ? gate : undefined,
        });
        const { driver, constructions } = fixture(s, supplied);
        const operation = driver.ensureNamespace(request);
        await request.kubernetes.entered[stage].promise;
        assert.equal(request.kubernetes.calls.at(-1).method, stage);
        driver.close();
        assert.equal(request.signal.aborted, false);
        gate.resolve();
        await assert.rejects(operation, /closed/);
        assert.deepEqual(
          request.kubernetes.calls.map(({ method }) => method),
          ["patch", "read", "list"],
        );
        assert.equal(request.kubernetes.calls[0].resource.metadata.namespace, "tenant-one");
        assert.equal(request.kubernetes.calls[2].args[7], "app=gateway");
        assert.equal(constructions.length, 0);
        assertOwned(driver, 0);
      }
    },
  );

  await t.test(
    "injected capability preserves identity, pending promises and once-only close",
    async (s) => {
      const pending = deferred();
      const closeFailure = new Error("injected close failed");
      let driver;
      const client = controlledClient({
        completion: pending,
        closeError: closeFailure,
        onClose() {
          driver.close();
        },
      });
      const selection = { gatewayClient: client };
      const created = fixture(s, options(), selection);
      driver = created.driver;
      selection.gatewayClient = controlledClient();
      const requests = [context("a"), context("b")];
      const operations = requests.map((request) => driver.provisionHarness(request));
      assert.equal(created.constructions.length, 0);
      assert.equal(client.closeCount, 0);
      for (let i = 0; i < requests.length; i += 1) {
        assert.equal(client.calls[i].receiver, client);
        assert.equal(client.calls[i].signal, requests[i].signal);
        assert.equal(client.calls[i].request.labels, requests[i].requirements.labels);
        assert.equal(
          client.calls[i].request.annotations["openclaw.dev/namespace-id"],
          requests[i].namespace.id,
        );
        assert.equal(client.calls[i].request.workspace, "accepted-workspace");
      }
      assert.throws(driver.close.bind(driver), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [closeFailure]);
        return true;
      });
      driver.close();
      assert.equal(client.closeCount, 1);
      assert.equal(selection.gatewayClient.closeCount, 0);
      assertOwned(driver, 0);
      pending.resolve();
      const references = await Promise.all(operations);
      assert.equal(references.length, 2);
      assert.equal(client.closeCount, 1);
      await assert.rejects(driver.provisionHarness(context()), /closed/);
      assert.equal(created.constructions.length, 0);
    },
  );

  await t.test(
    "fresh native options preserve accepted endpoint, auth and launch values",
    async (s) => {
      for (const [address, endpoint] of [
        [{ endpoint: "https://gateway.example.test:50051" }, "https://gateway.example.test:50051"],
        [{ serviceName: "gateway.shared.svc" }, "https://gateway.shared.svc:50051"],
        [{ serviceName: "gateway" }, "https://gateway.tenant-one.svc:50051"],
      ]) {
        const supplied = options();
        supplied.gateway = {
          ...address,
          workspace: "accepted-workspace",
          auth: { mode: "bearerTokenFile", path: "/run/openshell/token" },
          binaryPath: "/usr/local/bin/oce-runtime-security",
          requestTimeoutMs: 1234,
          rootCertificatePath: "/run/openshell/ca.crt",
        };
        const original = structuredClone(supplied);
        const { driver, constructions } = fixture(s, supplied);
        assert.deepEqual(supplied, original);
        supplied.gateway.endpoint = "https://changed.example.test:50051";
        supplied.gateway.auth.path = "/run/changed-token";
        supplied.gateway.workspace = "changed";
        supplied.gateway.requestTimeoutMs = 999;
        supplied.gateway.rootCertificatePath = "/run/changed-ca";
        supplied.policy.process.runAsUser = "2000";
        for (let i = 0; i < 2; i += 1) await driver.provisionHarness(context());
        for (const { selectedOptions, client } of constructions) {
          assert.deepEqual(selectedOptions, {
            endpoint,
            binaryPath: original.gateway.binaryPath,
            auth: original.gateway.auth,
            requestTimeoutMs: 1234,
            rootCertificatePath: original.gateway.rootCertificatePath,
          });
          assert.equal(Object.isFrozen(selectedOptions.auth), true);
          assert.equal(client.calls[0].request.workspace, "accepted-workspace");
          assert.equal(client.calls[0].request.spec.policy.process.run_as_user, "1000");
          assert.equal(client.closeCount, 1);
        }
        assert.notEqual(constructions[0].client, constructions[1].client);
        assertOwned(driver, 0);
        driver.close();
      }
    },
  );

  await t.test("health, create and revision delete all use call ownership", async (s) => {
    const { driver, constructions } = fixture(s);
    const request = context();
    await driver.ensureNamespace(request);
    const reference = await driver.provisionHarness(request);
    await driver.cleanup(request);
    await driver.cleanup(namespaceContext(request));
    assert.deepEqual(
      constructions.map(({ client }) => client.calls[0].method),
      ["health", "createSandbox", "deleteSandbox"],
    );
    assert.ok(constructions.every(({ client }) => client.closeCount === 1));
    assert.ok(constructions.every(({ client }) => client.calls[0].signal === request.signal));
    assert.equal(constructions[1].client.calls[0].request.name, reference.resourceName);
    assert.deepEqual(constructions[2].client.calls[0].request, {
      name: reference.resourceName,
      workspace: "accepted-workspace",
    });
    assertOwned(driver, 0);
  });

  await t.test("an unacknowledged cancellation leaves the unresolved call owned", async (s) => {
    const { driver, plans, constructions } = fixture(s);
    const unresolved = deferred();
    plans.push({ completion: unresolved });
    let settled = false;
    void driver.provisionHarness(context()).then(() => {
      settled = true;
    });
    driver.close();
    await Promise.resolve();
    driver.close();
    assert.equal(settled, false);
    assert.equal(constructions[0].client.closeCount, 1);
    assertOwned(driver, 1);
    // Intentionally leave this controlled promise unresolved. It holds no I/O
    // or timer handle. close() does not promise retirement or a joined drain.
  });

  await t.test(
    "settlement reports retirement failures without losing operation failures",
    async (s) => {
      const { driver, plans, constructions } = fixture(s);
      const operationFailure = new Error("operation failed");
      const retirementFailure = new Error("retirement failed");
      plans.push({ invokeError: operationFailure, closeError: retirementFailure });
      await assert.rejects(driver.provisionHarness(context()), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [operationFailure, retirementFailure]);
        return true;
      });
      assertOwned(driver, 0);
      plans.push({ closeError: retirementFailure });
      await assert.rejects(
        driver.provisionHarness(context()),
        (error) => error === retirementFailure,
      );
      assertOwned(driver, 0);
      const pending = deferred();
      plans.push({ completion: pending, closeError: retirementFailure });
      const late = assert.rejects(
        driver.provisionHarness(context()),
        (error) => error === operationFailure,
      );
      assert.throws(driver.close.bind(driver), AggregateError);
      assertOwned(driver, 1);
      pending.reject(operationFailure);
      await late;
      assertOwned(driver, 0);
      driver.close();
      assert.ok(constructions.every(({ client }) => client.closeCount === 1));
    },
  );
});
