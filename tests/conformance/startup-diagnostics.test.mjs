import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { startupDiagnostic } from "../../apps/controller/src/startup-diagnostics.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { KubeConfig } = require("@kubernetes/client-node");
const marker = "BENIGN_LOADER_FRAGMENT_9241";
const loadMessage = "The Kubernetes client configuration could not be loaded.";
class ValidationFailure extends Error {}

function config() {
  return {
    apiVersion: "v1",
    kind: "Config",
    clusters: [{ name: "selected-cluster", cluster: { server: "https://127.0.0.1:6443" } }],
    users: [{ name: "selected-user", user: { token: "benign-unused-test-identity" } }],
    contexts: [
      { name: "selected", context: { cluster: "selected-cluster", user: "selected-user" } },
    ],
    "current-context": "ignored-default",
  };
}

async function fixture(t, contents) {
  const directory = await mkdtemp(join(tmpdir(), "oce-startup-loader-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, `${marker}.yaml`);
  if (contents !== undefined) await writeFile(path, contents, { mode: 0o600 });
  return path;
}

function load(path, context = "selected") {
  return createKubernetesClientConfiguration(
    { mode: "kubeconfig", kubeconfigPath: path, context },
    (message) => new ValidationFailure(message),
  );
}

for (const [name, contents] of [
  ["malformed", `apiVersion: v1\nkind: Config\nusers: [${marker}\n`],
  ["missing", undefined],
  ["semantic", JSON.stringify({ ...config(), clusters: [{ name: marker, cluster: {} }] })],
]) {
  test(`actual SDK ${name} load errors become constant validation failures`, async (t) => {
    const path = await fixture(t, contents);
    // Establish that these fixtures really fail in the installed SDK, not a fake parser.
    assert.throws(() => new KubeConfig().loadFromFile(path));
    await assert.rejects(load(path), (error) => {
      assert.ok(error instanceof ValidationFailure);
      assert.equal(error.message, loadMessage);
      assert.equal(Object.hasOwn(error, "cause"), false);
      assert.doesNotMatch(error.stack, new RegExp(marker));
      for (const component of ["api", "worker"]) {
        const diagnostic = startupDiagnostic(component, error);
        assert.equal(diagnostic.code, "KUBERNETES_CONFIGURATION_INVALID");
        assert.equal(
          diagnostic.error,
          "Kubernetes client configuration is unavailable or invalid.",
        );
        assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(marker));
      }
      return true;
    });
  });
}

test("explicit context selects its verified HTTPS cluster and identity", async (t) => {
  const value = config();
  value.clusters.push({ name: "unused", cluster: { server: "https://unused.example.test" } });
  value.contexts.push({
    name: "ignored-default",
    context: { cluster: "unused", user: "selected-user" },
  });
  const path = await fixture(t, JSON.stringify(value));
  const { kubeConfig } = await load(path);
  assert.equal(kubeConfig.getCurrentContext(), "selected");
  assert.equal(kubeConfig.getCurrentCluster().server, "https://127.0.0.1:6443");
  assert.equal(kubeConfig.getCurrentCluster().skipTLSVerify, false);
  assert.equal(kubeConfig.getCurrentUser().name, "selected-user");
});

test("actual configuration refuses ambiguous selection, missing identity and insecure TLS", async (t) => {
  const scenarios = [
    [
      "missing-context",
      (value) => {
        value.contexts = [];
      },
    ],
    [
      "duplicate-context",
      (value) => {
        value.contexts.push(value.contexts[0]);
      },
    ],
    [
      "missing-cluster",
      (value) => {
        value.clusters = [];
      },
    ],
    [
      "duplicate-cluster",
      (value) => {
        value.clusters.push(value.clusters[0]);
      },
    ],
    [
      "missing-user",
      (value) => {
        value.users = [];
      },
    ],
    [
      "http",
      (value) => {
        value.clusters[0].cluster.server = "http://127.0.0.1:6443";
      },
    ],
    [
      "skip-tls",
      (value) => {
        value.clusters[0].cluster["insecure-skip-tls-verify"] = true;
      },
    ],
    [
      "credentials",
      (value) => {
        value.clusters[0].cluster.server = "https://benign:unused@127.0.0.1:6443";
      },
    ],
    [
      "query",
      (value) => {
        value.clusters[0].cluster.server += "?benign=unused";
      },
    ],
  ];
  for (const [name, mutate] of scenarios) {
    await t.test(name, async (t) => {
      const value = config();
      mutate(value);
      const path = await fixture(t, JSON.stringify(value));
      await assert.rejects(load(path), (error) => {
        assert.ok(error instanceof ValidationFailure);
        assert.equal(startupDiagnostic("api", error).code, "KUBERNETES_CONFIGURATION_INVALID");
        return true;
      });
    });
  }
});

test("in-cluster selection retains SDK identity and verified TLS without kubeconfig fallback", async (t) => {
  const previous = {
    KUBERNETES_SERVICE_HOST: process.env.KUBERNETES_SERVICE_HOST,
    KUBERNETES_SERVICE_PORT: process.env.KUBERNETES_SERVICE_PORT,
    KUBECONFIG: process.env.KUBECONFIG,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.KUBERNETES_SERVICE_HOST = "127.0.0.1";
  process.env.KUBERNETES_SERVICE_PORT = "6443";
  process.env.KUBECONFIG = await fixture(t, `users: [${marker}`);
  const { kubeConfig } = await createKubernetesClientConfiguration(
    { mode: "inCluster" },
    (message) => new ValidationFailure(message),
  );
  assert.equal(kubeConfig.getCurrentContext(), "inClusterContext");
  assert.equal(kubeConfig.getCurrentCluster().server, "https://127.0.0.1:6443");
  assert.equal(kubeConfig.getCurrentCluster().skipTLSVerify, false);
  assert.equal(kubeConfig.getCurrentUser().authProvider.name, "tokenFile");
  // Configuration-only proof: this neither reads a token nor connects to an API server.
  await assert.rejects(load(process.env.KUBECONFIG), ValidationFailure);
});

test("startup projection never reads unknown messages, nested causes or arbitrary properties", () => {
  const error = new Error(marker, { cause: { excerpt: marker } });
  error.code = "KUBERNETES_CONFIGURATION_INVALID";
  error.details = { marker };
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error(marker);
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [
    error,
    hostile,
    revoked.proxy,
    marker,
    null,
    undefined,
    17,
    Symbol(marker),
  ]) {
    for (const component of ["api", "worker"]) {
      assert.deepEqual(startupDiagnostic(component, value), {
        event: component === "api" ? "startup-error" : "worker.startup-error",
        code: "STARTUP_FAILED",
        error: "Controller startup failed. Check the configured startup prerequisites.",
      });
    }
  }
});
