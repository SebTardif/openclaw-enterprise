import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import {
  DEVELOPMENT_HARNESS_DESCRIPTOR,
  PRODUCTION_HARNESS_DESCRIPTOR,
} from "../../apps/controller/src/composition/production-harness.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";

async function fixture(t, configuration = installation()) {
  const directory = await mkdtemp(join(tmpdir(), "occ-installation-startup-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "installation.yaml");
  // JSON is valid YAML; mutations exercise the same real SDK YAML parser as controller startup.
  await writeFile(path, JSON.stringify(configuration), "utf8");
  return path;
}

function chatgptInstallation() {
  const configuration = installation();
  configuration.provider = [
    {
      id: "openai",
      type: "chatgpt",
      configuration: {
        workspaceId: "f7f33107-5fb9-4ee1-8922-3eae76b5b5a0",
        apiKeyPath: "/tmp/nonexistent-occ-chatgpt-admin-key",
        credentialTtlSeconds: 3600,
      },
      drivers: {
        service_account: "chatgpt-service-accounts",
      },
    },
  ];
  configuration.drivers.service_account = {
    id: "chatgpt-service-accounts",
    configuration: {},
  };
  return configuration;
}

function retiredChatgptInstallation() {
  const configuration = installation();
  configuration.integrations = {
    chatgpt: {
      workspaceId: "f7f33107-5fb9-4ee1-8922-3eae76b5b5a0",
      adminKeyPath: "/tmp/nonexistent-occ-chatgpt-admin-key",
      credentialTtlSeconds: 3600,
    },
  };
  configuration.drivers.service_account = {
    id: "chatgpt-service-accounts",
    configuration: {},
  };
  return configuration;
}

test("startup loads singleton Installation YAML and validates Drivers before construction", async (t) => {
  const path = await fixture(t);
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: path },
  });
  const configuration = drivers.installation;
  assert.equal(configuration.occ.cluster, "production-west");
  assert.equal(Object.hasOwn(configuration, "installationId"), false);

  // Runtime Driver identities must exactly match startup selections and admitted descriptors.
  assert.equal(drivers.computeDriver.id, "compute-kubernetes");
  assert.equal(drivers.computeDriver.implementation, "occ/kubernetes");
  assert.equal(drivers.configurationDriver.id, "config-kubernetes");
  assert.equal(drivers.configurationDriver.implementation, "occ/kubernetes-configmap");
});

test("shared startup loads provider metadata without reading the API-only ChatGPT admin Secret", async (t) => {
  // The worker shares this loader but deliberately cannot access the configured API-only mount.
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, chatgptInstallation()) },
  });

  assert.deepEqual(drivers.installation.provider, [
    {
      id: "openai",
      type: "chatgpt",
      configuration: {
        workspaceId: "f7f33107-5fb9-4ee1-8922-3eae76b5b5a0",
        apiKeyPath: "/tmp/nonexistent-occ-chatgpt-admin-key",
        credentialTtlSeconds: 3600,
      },
      drivers: {
        service_account: "chatgpt-service-accounts",
      },
    },
  ]);
  assert.equal(
    Object.hasOwn(drivers.installation.provider[0].configuration, "adminKeyPath"),
    false,
  );
  assert.deepEqual(drivers.installation.drivers.service_account, {
    id: "chatgpt-service-accounts",
  });
  assert.equal(Object.hasOwn(drivers, "serviceAccountDriver"), false);
  assert.equal(Object.hasOwn(drivers, "chatgptClient"), false);
});

test("ChatGPT startup rejects retired integrations and unsafe provider configuration", async (t) => {
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, retiredChatgptInstallation()) },
    }),
    /integrations is retired.*provider.*apiKeyPath/,
  );

  for (const [mutate, expected] of [
    [(value) => delete value.provider, /requires an owning provider/],
    [(value) => delete value.drivers.service_account, /requires drivers\.service_account/],
    [
      (value) => delete value.provider[0].drivers.service_account,
      /drivers\.service_account.*required/,
    ],
    [
      (value) => (value.provider[0].configuration.workspaceId = "untrusted"),
      /workspaceId.*invalid/,
    ],
    [
      (value) => (value.provider[0].configuration.apiKeyPath = "relative-admin-key"),
      /absolute mounted file path/,
    ],
    [
      (value) => (value.provider[0].configuration.credentialTtlSeconds = 2_592_001),
      /between 1 and 2592000/,
    ],
    [
      (value) => (value.provider[0].configuration.apiKey = "plaintext-admin-key"),
      /plaintext credential|unsupported option/,
    ],
    [
      (value) => (value.provider[0].configuration.adminKeyPath = "/tmp/old-admin-key"),
      /adminKeyPath.*unsupported/,
    ],
    [(value) => (value.provider[0].type = "installed"), /must be chatgpt/],
    [(value) => (value.provider[0].package = "@example/provider"), /unsupported option package/],
    [
      (value) => (value.provider[0].drivers.service_account = "other-service-accounts"),
      /must match the selected drivers\.service_account\.id/,
    ],
    [
      (value) => value.provider.push(structuredClone(value.provider[0])),
      /Provider IDs must be unique/,
    ],
    [
      (value) => {
        const duplicate = structuredClone(value.provider[0]);
        duplicate.id = "other-openai";
        value.provider.push(duplicate);
      },
      /ServiceAccount Driver cannot belong to multiple Providers/,
    ],
    [
      (value) => (value.drivers.service_account.configuration.providerId = "openai"),
      /unsupported option/,
    ],
  ]) {
    const configuration = chatgptInstallation();
    mutate(configuration);
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      }),
      expected,
    );
  }
});

test("production embedded and dedicated replacements preserve their active Services across failed activation", async (t) => {
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t) },
  });
  const { computeDriver } = drivers;
  // This worker activation unit uses managed placement without claiming live Kubernetes discovery.
  t.mock.method(computeDriver, "resolveNamespace", async (namespaceId) => ({
    name: kubernetesNamespaceName(namespaceId),
    external: false,
  }));
  const pool = new pg.Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
  t.after(async () => pool.end());
  const worker = createControllerWorker({
    pool,
    mode: "production",
    drivers,
    emit: () => {},
  });

  const shortHash = (value, length) =>
    createHash("sha256").update(value).digest("hex").slice(0, length);
  for (const harness of [
    { ...DEVELOPMENT_HARNESS_DESCRIPTOR, mode: "embedded" },
    { ...PRODUCTION_HARNESS_DESCRIPTOR, mode: "dedicated" },
  ]) {
    const namespaceId = `ns_production-${harness.mode}-cutover`;
    const agentId = `agt_production-${harness.mode}-cutover`;
    const servicePrincipalId = `service-production-${harness.mode}-cutover`;
    const predecessor = {
      id: `rev_production-${harness.mode}-active`,
      namespaceId,
      agentId,
      revision: 1,
      configurationId: `cfg_production-${harness.mode}-cutover`,
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: {},
      harness,
      compute: { id: computeDriver.id, implementation: computeDriver.implementation },
      servicePrincipalId,
      createdAt: new Date().toISOString(),
    };
    const candidate = {
      ...predecessor,
      id: `rev_production-${harness.mode}-candidate`,
      revision: 2,
    };
    const embedded = harness.mode === "embedded";
    const name = `${embedded ? "gateway" : "agent"}-${shortHash(agentId, 12)}`;
    const activeSelector = embedded
      ? {
          "app.kubernetes.io/name": name,
          "openclaw.dev/agent": agentId,
        }
      : {
          "app.kubernetes.io/name": `${name}-rev-${shortHash(predecessor.id, 12)}`,
          "openclaw.dev/agent": agentId,
          "openclaw.dev/revision": predecessor.id,
        };
    const ownership = embedded
      ? { namespaceId, agentId }
      : { namespaceId, agentId, servicePrincipalId };
    const service = computeDriver.service(
      name,
      ownership,
      kubernetesNamespaceName(namespaceId),
      structuredClone(activeSelector),
    );
    assert.equal(service.spec.ports[0].name, embedded ? "http" : "websocket");

    const serviceWrites = [];
    computeDriver.reconcile = async (manifest) => {
      assert.equal(manifest.kind, "Service");
      assert.equal(manifest.metadata.name, name);
      service.spec.selector = structuredClone(manifest.spec.selector);
      serviceWrites.push(structuredClone(manifest.spec.selector));
    };
    computeDriver.prepareRevision = async (revision) => ({
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
      ready: true,
    });
    const now = new Date();
    const claim = {
      idempotencyKey: `revision:${candidate.id}:reconcile`,
      namespaceId,
      agentId,
      revisionId: candidate.id,
      actorId: "principal-production",
      state: "claimed",
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      availableAt: now,
      attemptCount: 1,
      createdAt: now,
      updatedAt: now,
    };
    // This selector unit assumes a live claim at the queue boundary; actual
    // renewal/loss is exercised by the PostgreSQL worker and stale-claim suites.
    const heartbeat = t.mock.method(worker.queue, "heartbeat", async (received) => {
      assert.equal(received, claim);
      return claim;
    });

    // Preparation must leave each mode's currently serving selector untouched before CAS.
    const observation = await worker.observeRevision(claim, candidate, predecessor, predecessor.id);
    assert.deepEqual(service.spec.selector, activeSelector);
    assert.deepEqual(serviceWrites, []);
    assert.equal(observation.expectedActiveRevisionId, predecessor.id);

    const activeAgent = {
      id: agentId,
      namespaceId,
      servicePrincipalId,
      activeRevisionId: predecessor.id,
    };
    const retries = [];
    let compareAndSetAttempts = 0;
    worker.state.transactWithQueue = async (transaction) =>
      transaction(
        {
          agents: {
            lockAgent: async () => activeAgent,
            compareAndSetActiveRevision: async (...arguments_) => {
              compareAndSetAttempts++;
              assert.deepEqual(arguments_, [namespaceId, agentId, predecessor.id, candidate.id]);
              return undefined;
            },
          },
        },
        {
          heartbeat: async () => claim,
          retry: async (_claim, reason) => retries.push(reason),
        },
      );
    await worker.finalizeRevision(claim, observation);
    assert.equal(compareAndSetAttempts, 1);
    assert.deepEqual(retries, [{ code: "ACTIVE_REVISION_CHANGED" }]);
    assert.equal(activeAgent.activeRevisionId, predecessor.id);
    assert.deepEqual(service.spec.selector, activeSelector);
    assert.deepEqual(serviceWrites, []);

    if (embedded) {
      // Recovery for an older claim must never replace a gateway already advanced to a newer revision.
      const newerGateway = computeDriver.deployment(
        name,
        ownership,
        kubernetesNamespaceName(namespaceId),
        "openclaw-enterprise/gateway-fixture:local",
        `agent-${shortHash(agentId, 12)}`,
        "gateway",
        {},
        computeDriver.gatewayConfiguration(candidate),
        true,
        servicePrincipalId,
      );
      const originalGet = computeDriver.get;
      computeDriver.get = async (kind, requestedName) => {
        assert.equal(kind, "Deployment");
        assert.equal(requestedName, name);
        return newerGateway;
      };
      try {
        await assert.rejects(computeDriver.activateRevision(predecessor), /stale.*activation/i);
      } finally {
        computeDriver.get = originalGet;
      }
      assert.deepEqual(serviceWrites, []);
    }

    const inactiveSelector = { "app.kubernetes.io/name": `${name}-inactive` };
    if (embedded) {
      // Embedded preparation already fences its gateway; the worker must never rewrite it pre-CAS.
      service.spec.selector = computeDriver.service(
        name,
        ownership,
        kubernetesNamespaceName(namespaceId),
        inactiveSelector,
      ).spec.selector;
    }
    const initial = await worker.observeRevision(claim, candidate, undefined, undefined);
    assert.equal(initial.outcome, "success");
    assert.equal(initial.code, "REVISION_ACTIVATED");
    assert.equal(Object.hasOwn(initial, "expectedActiveRevisionId"), false);
    assert.deepEqual(serviceWrites, embedded ? [] : [inactiveSelector]);
    assert.deepEqual(service.spec.selector, inactiveSelector);
    heartbeat.mock.restore();
  }
});

test("startup accepts actual block-style YAML instead of requiring JSON", async (t) => {
  const path = await fixture(t);
  const configuration = installation();
  const yaml = `occ:\n  cluster: production-west\ndrivers:\n  configuration: ${JSON.stringify(configuration.drivers.configuration)}\n  iam: ${JSON.stringify(configuration.drivers.iam)}\n  compute: ${JSON.stringify(configuration.drivers.compute)}\n  secret: ${JSON.stringify(configuration.drivers.secret)}\n`;
  await writeFile(path, yaml, "utf8");
  const loaded = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: path },
  });
  assert.equal(loaded.installation.occ.cluster, "production-west");
});

test("production requires one YAML while development may start without a ConfigurationDriver", async () => {
  await assert.rejects(
    loadInstallationConfiguration({ mode: "production", environment: {} }),
    /OCC_CONFIG_PATH/,
  );
  assert.equal(
    await loadInstallationConfiguration({ mode: "development", environment: {} }),
    undefined,
  );
});

async function startupConnectionProbe(t) {
  let connections = 0;
  // This observes real startup connection attempts and does not emulate PostgreSQL.
  const listener = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  return {
    url: `postgresql://127.0.0.1:${listener.address().port}/occ`,
    connections: () => connections,
  };
}

async function failedStartup(component, env) {
  try {
    await promisify(execFile)(process.execPath, [`apps/controller/src/${component}.mjs`], {
      cwd: process.cwd(),
      env,
      timeout: 10_000,
    });
    assert.fail("Startup must fail at the selected boundary.");
  } catch (error) {
    assert.equal(error.code, 1);
    assert.equal(error.signal, null);
    assert.deepEqual(JSON.parse(error.stderr), {
      event: component === "server" ? "startup-error" : "worker.startup-error",
      code: "STARTUP_FAILED",
      error: "Controller startup failed. Check the configured startup prerequisites.",
    });
  }
}

test("production server and worker resolve singleton startup without an Installation ID", async (t) => {
  const path = await fixture(t);
  const database = await startupConnectionProbe(t);
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: path,
    OCC_DATABASE_URL: database.url,
  };
  const api = { ...shared, OCC_HOST: "192.0.2.10", OCC_PORT: "8080" };
  await failedStartup("server", api);
  assert.equal(database.connections(), 0);

  // Completing only auth configuration advances the actual server to persistence.
  await failedStartup("server", {
    ...api,
    OCC_AUTH_SECRET: "production-auth-secret-with-at-least-32-characters",
    OCC_AUTH_BASE_URL: "http://192.0.2.10:8080",
  });
  assert.equal(database.connections(), 1);
  await failedStartup("worker", shared);
  assert.equal(database.connections(), 2);
});

test("only the actual API process reads ChatGPT admin credentials and provider accounts require PostgreSQL", async (t) => {
  const configuration = chatgptInstallation();
  const path = await fixture(t, configuration);
  const keyPath = join(dirname(path), "admin-key");
  configuration.provider[0].configuration.apiKeyPath = keyPath;
  await writeFile(path, JSON.stringify(configuration));
  const database = await startupConnectionProbe(t);
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: path,
    OCC_DATABASE_URL: database.url,
  };
  const api = {
    ...shared,
    OCC_HOST: "192.0.2.10",
    OCC_PORT: "8080",
    OCC_AUTH_SECRET: "production-auth-secret-with-at-least-32-characters",
    OCC_AUTH_BASE_URL: "http://192.0.2.10:8080",
  };

  // With the API-only key missing, only the worker can reach persistence.
  await failedStartup("server", api);
  assert.equal(database.connections(), 0);
  await failedStartup("worker", shared);
  assert.equal(database.connections(), 1);
  // Creating only the key advances the API. No provider request can run: the
  // PostgreSQL connection is closed before any state or account initialization.
  await writeFile(keyPath, "benign-unused-admin-key", { mode: 0o600 });
  await failedStartup("server", api);
  assert.equal(database.connections(), 2);

  const development = {
    PATH: process.env.PATH,
    NODE_ENV: "development",
    OCC_CONFIG_PATH: path,
    OCC_HOST: "127.0.0.1",
    OCC_PORT: "8080",
  };
  await failedStartup("server", development);
  assert.equal(database.connections(), 2);
  // Provider bindings cannot silently use memory: supplying persistence advances startup.
  await failedStartup("server", { ...development, OCC_DATABASE_URL: database.url });
  assert.equal(database.connections(), 3);
});

test("startup rejects caller-selected Installation IDs and obsolete Driver selectors", async (t) => {
  const path = await fixture(t);
  for (const [name, value] of [
    ["OCC_INSTALLATION_ID", "ins_untrusted"],
    ["OCC_COMPUTE_DRIVER", "kubernetes"],
    ["OCC_KUBERNETES_CONFIG_PATH", "/tmp/obsolete.json"],
    ["OCC_NATIVE_IAM_DRIVER_ID", "native-iam"],
  ]) {
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: path, [name]: value },
      }),
      new RegExp(name),
    );
  }

  const injected = installation();
  injected.drivers.compute.configuration.authentication.installation_id = "ins_untrusted";
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, injected) },
    }),
    /must not contain an Installation ID/,
  );
});

test("startup rejects plaintext secrets, caller-authored identities, and unsupported schema options", async (t) => {
  for (const [mutate, expected] of [
    [(value) => (value.drivers.compute.configuration.apiKey = "plaintext"), /plaintext credential/],
    [
      (value) => (value.drivers.configuration.implementation = "occ/docker-config"),
      /unsupported option.*implementation/,
    ],
    [
      (value) =>
        (value.drivers.configuration.configuration.authentication = { mode: "kubeconfig" }),
      /schema|authentication/,
    ],
    [(value) => (value.drivers.iam.configuration.unexpected = true), /schema|unsupported option/],
    [
      (value) => (value.drivers.compute.configuration.resources.gateway.unexpected = true),
      /schema|unsupported option/,
    ],
    [
      (value) => (value.drivers.compute.configuration.images.requireImmutableDigest = false),
      /immutable image digests/,
    ],
    [
      (value) =>
        (value.drivers.compute.configuration.network.gatewayPort = Number.MAX_SAFE_INTEGER + 1),
      /schema|integer|port/,
    ],
    [
      (value) => (value.drivers.compute.configuration.images.gateway = "gateway:latest"),
      /immutable SHA-256 digest/,
    ],
    [
      (value) => (value.drivers.compute.configuration.images.agent = "agent:latest"),
      /immutable SHA-256 digest/,
    ],
    [
      (value) => delete value.drivers.compute.configuration.runtime,
      /explicitly configured Codex runtime/,
    ],
    [
      (value) =>
        (value.drivers.compute.configuration.runtime.modelSecretPrefix =
          value.drivers.compute.configuration.runtime.transportSecretPrefix),
      /credentials must remain separate/,
    ],
  ]) {
    const configuration = installation();
    mutate(configuration);
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      }),
      expected,
    );
  }
});

test("startup loads updated Compute Driver settings from trusted YAML", async (t) => {
  const initial = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t) },
  });
  assert.equal(initial.computeDriver.id, "compute-kubernetes");
  assert.equal(initial.installation.drivers.compute.configuration.network.gatewayPort, 8080);

  // Startup constructs the selected Compute Driver using the updated trusted YAML settings.
  const changed = installation();
  changed.drivers.compute.configuration.network.gatewayPort = 8081;
  const updated = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, changed) },
  });
  assert.equal(updated.computeDriver.id, initial.computeDriver.id);
  assert.equal(updated.computeDriver.implementation, initial.computeDriver.implementation);
  assert.equal(updated.installation.drivers.compute.configuration.network.gatewayPort, 8081);
});
