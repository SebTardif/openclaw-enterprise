import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
  PLUGIN_AGENT_RUNTIME_ENTRYPOINT,
  PLUGIN_RUNTIME_HELPERS,
} from "../../apps/controller/src/drivers/compute/runtime/runtime-entrypoints.ts";
import {
  PLUGIN_RUNTIME_CODEX_CONFIG,
  PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT,
  PLUGIN_RUNTIME_ENVIRONMENT,
  PLUGIN_RUNTIME_MANIFEST,
  PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT,
  PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT,
  pluginRuntimeConfigMapData,
  pluginRuntimeEnvironment,
  pluginRuntimeSpecForRevision,
} from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";

const OCC_DIFFS_DIGEST =
  "sha512-5VTDNEo7D3iOgRoL5C31JPTbA/EXQEFRuxOvLy67IMFmOajwroGsUMWeuKkmqzFbPNQxvn7GACDSr/5Vmpx3/g==";
const CODEX_LINEAR_NATIVE_ID = "linear@openai-curated-remote";
const CODEX_LINEAR_REMOTE_ID = "plugin_asdk_app_69a089a326dc8191b32a3f2553f5be2c";
const CODEX_LINEAR_APP_ID = "asdk_app_69a089a326dc8191b32a3f2553f5be2c";
const CODEX_LINEAR_VERSION = "5.0.1";
const nodeRequire = createRequire(import.meta.url);

const tenant = {
  id: "ns_00000000-0000-4000-8000-000000000016",
  name: "Plugin compute tenant",
  status: "ready",
  createdAt: "2026-09-08T00:00:00.000Z",
};

const agent = Object.freeze({
  id: "agent-plugin-compute",
  namespaceId: tenant.id,
  name: "Plugin compute agent",
  configurationId: "cfg_00000000-0000-4000-8000-000000000016",
  executionMode: "embedded",
  servicePrincipalId: "service-principal-plugin-compute",
  createdAt: tenant.createdAt,
});

function context(mode) {
  return {
    namespace: tenant,
    agent: { ...agent, executionMode: mode },
    harness: { id: mode === "embedded" ? "openclaw" : "codex", version: "2026.9.0", mode },
    configuration: {},
    signal: AbortSignal.timeout(1_000),
  };
}

function revision(overrides = {}) {
  return {
    id: "revision-plugin-compute-1",
    namespaceId: tenant.id,
    agentId: agent.id,
    revision: 1,
    configurationId: agent.configurationId,
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: admitLoggingConfiguration({}, "info"),
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    compute: { id: "compute-kubernetes", implementation: "kubernetes" },
    servicePrincipalId: agent.servicePrincipalId,
    secretDriverId: "secret-kubernetes",
    createdAt: tenant.createdAt,
    ...overrides,
  };
}

function occSelection(overrides = {}) {
  return {
    "occ-plugin:diffs": {
      enabled: true,
      approvalMode: "always",
      ...overrides,
    },
  };
}

function codexSelection(overrides = {}) {
  return {
    "codex-plugin:linear@openai-curated-remote": {
      enabled: true,
      approvalMode: "auto",
      ...overrides,
    },
  };
}

function openClawPluginState() {
  return {
    driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
    plugins: occSelection(),
  };
}

function codexNoPluginState() {
  return {
    driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
    plugins: {},
  };
}

function codexLinearPluginState(overrides = {}) {
  return {
    driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
    plugins: codexSelection(overrides),
  };
}

function kubernetesOptions(overrides = {}) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };
  return {
    authentication: {
      mode: "kubeconfig",
      kubeconfigPath: "/tmp/openclaw-enterprise-conformance/kubeconfig",
      context: "openclaw-enterprise-local",
    },
    images: {
      gateway: "openclaw-enterprise/gateway-fixture:local",
      agent: "openclaw-enterprise/agent-fixture:local",
      requireImmutableDigest: false,
    },
    resources: {
      gateway: resources,
      agent: resources,
      namespace: {
        quota: { pods: "10", "requests.cpu": "2", "requests.memory": "1Gi" },
        containerDefaults: resources,
      },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 8080,
      gatewayClients: [
        { namespace: "openclaw-controller", podLabels: { "app.kubernetes.io/name": "controller" } },
      ],
    },
    servicePrincipalCredentials: { mode: "disabled" },
    runtime: {
      transportSecretPrefix: "transport",
      modelSecretPrefix: "model",
      gatewayStorageClassName: "local-path",
    },
    ...overrides,
  };
}

function runOpenClawRuntimeHelper(runtime, responses, options = {}) {
  const calls = [];
  const files = new Map([
    [
      "/etc/openclaw/openclaw.json",
      JSON.stringify(
        options.baseConfig ?? {
          gateway: { port: 8080 },
          plugins: { installs: { keep: { source: "npm" } }, load: { paths: ["existing"] } },
          tools: { alsoAllow: ["existing-tool"] },
        },
      ),
    ],
  ]);
  const sandbox = {
    JSON,
    process: {
      env: { OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json", HOME: "/home/node" },
    },
    require(specifier) {
      if (specifier === "node:child_process") {
        return {
          spawnSync(command, args, options) {
            calls.push({ command, args, options });
            return responses.shift() ?? { status: 0, stdout: "", stderr: "" };
          },
        };
      }
      if (specifier === "node:fs") {
        return {
          mkdirSync() {},
          readFileSync(path) {
            if (!files.has(path)) throw new Error(`Missing mocked file: ${path}`);
            return files.get(path);
          },
          writeFileSync(path, data) {
            files.set(path, String(data));
          },
        };
      }
      return nodeRequire(specifier);
    },
  };
  vm.runInNewContext(
    `${PLUGIN_RUNTIME_HELPERS}
installOpenClawPlugins(${JSON.stringify(runtime)});`,
    sandbox,
  );
  return { calls, files };
}

function codexListResponse(options = {}) {
  return {
    marketplaces: [
      {
        name: "openai-curated-remote",
        path: null,
        interface: null,
        plugins: [
          {
            id: options.nativeId ?? CODEX_LINEAR_NATIVE_ID,
            remotePluginId: options.remotePluginId ?? CODEX_LINEAR_REMOTE_ID,
            name: options.name ?? "linear",
            source: { type: "remote" },
            installed: false,
            enabled: false,
            installPolicy: "AVAILABLE",
            authPolicy: "ON_USE",
            availability: "AVAILABLE",
            version: options.version ?? CODEX_LINEAR_VERSION,
            interface: null,
          },
        ],
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

function codexReadResponse(options = {}) {
  return {
    plugin: {
      marketplaceName: "openai-curated-remote",
      marketplacePath: null,
      summary: {
        id: options.nativeId ?? CODEX_LINEAR_NATIVE_ID,
        remotePluginId: options.remotePluginId ?? CODEX_LINEAR_REMOTE_ID,
        name: options.name ?? "linear",
        source: { type: "remote" },
        installed: options.installed ?? true,
        enabled: options.enabled ?? true,
        installPolicy: "AVAILABLE",
        authPolicy: "ON_USE",
        availability: "AVAILABLE",
        version: options.version ?? CODEX_LINEAR_VERSION,
        interface: null,
      },
      description: null,
      skills: [],
      apps: options.apps ?? [{ id: CODEX_LINEAR_APP_ID, name: "Linear", needsAuth: false }],
      appTemplates: [],
      hooks: [],
      mcpServers: [],
      scheduledTasks: [],
    },
  };
}

function codexConfigReadResponse(appConfig = {}) {
  return {
    config: {
      features: { apps: true, plugins: true, remote_plugin: true },
      apps: {
        _default: { enabled: false },
        [CODEX_LINEAR_APP_ID]: {
          enabled: true,
          default_tools_approval_mode: "auto",
          ...appConfig,
        },
      },
      plugins: {},
    },
    origins: {},
  };
}

async function runCodexRuntimeHelper(runtime, handler, options = {}) {
  const requests = [];
  const sockets = [];
  const files = new Map();
  class FakeWebSocket {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.listeners = new Map();
      sockets.push(this);
      setTimeout(() => this.dispatch("open", {}), 0);
    }
    on(name, listener) {
      const existing = this.listeners.get(name) ?? [];
      existing.push(listener);
      this.listeners.set(name, existing);
      return this;
    }
    dispatch(name, event) {
      for (const listener of this.listeners.get(name) ?? []) listener(event);
    }
    send(raw) {
      const request = JSON.parse(raw);
      if (request.method === "initialized") return;
      requests.push({ method: request.method, params: request.params });
      Promise.resolve(handler(request.method, request.params)).then(
        (result) =>
          this.dispatch("message", Buffer.from(JSON.stringify({ id: request.id, result }))),
        (error) =>
          this.dispatch(
            "message",
            Buffer.from(JSON.stringify({ id: request.id, error: { message: error.message } })),
          ),
      );
    }
    close() {}
  }
  const sandbox = {
    JSON,
    Buffer,
    Date,
    WebSocket: FakeWebSocket,
    setTimeout,
    clearTimeout,
    process: {
      env: {
        APP_SERVER_PORT: "4321",
        APP_SERVER_TOKEN: "capability-token-test-value",
        CODEX_HOME: "/home/node/.codex",
        OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "25",
        ...(options.env ?? {}),
      },
    },
    require(specifier) {
      if (specifier === "ws") return FakeWebSocket;
      if (specifier === "node:fs") {
        return {
          mkdirSync() {},
          readFileSync(path) {
            if (!files.has(path)) throw new Error(`Missing mocked file: ${path}`);
            return files.get(path);
          },
          writeFileSync(path, data) {
            files.set(path, String(data));
          },
        };
      }
      return nodeRequire(specifier);
    },
    result: {},
  };
  const completion = new Promise((resolve, reject) => {
    sandbox.result.resolve = resolve;
    sandbox.result.reject = reject;
  });
  vm.runInNewContext(
    `${PLUGIN_RUNTIME_HELPERS}
installCodexPlugins(${JSON.stringify(runtime)}).then(result.resolve, result.reject);`,
    sandbox,
  );
  await completion;
  return { requests, sockets };
}

test("compute preserves plugin-free Codex revisions without added runtime material", () => {
  assert.equal(pluginRuntimeSpecForRevision(revision()), undefined);
  assert.doesNotMatch(
    AGENT_RUNTIME_ENTRYPOINT,
    /pluginRuntimeTranslator|readPluginRuntime|installCodexPlugins/,
  );
  assert.doesNotMatch(
    GATEWAY_RUNTIME_ENTRYPOINT,
    /pluginRuntimeTranslator|readGatewayPluginRuntime|installOpenClawPlugins/,
  );
});

test("compute preserves explicitly empty plugin selections without added runtime material", () => {
  const state = codexNoPluginState();
  assert.equal(pluginRuntimeSpecForRevision(revision({ plugins: state })), undefined);
  assert.deepEqual(state, codexNoPluginState());
  assert.equal(
    pluginRuntimeSpecForRevision(
      revision({
        harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
        plugins: {
          driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
          plugins: {},
        },
      }),
    ),
    undefined,
  );
});

test("compute serializes selected Codex plugins for startup-time resolution", () => {
  const state = codexLinearPluginState({ approvalsReviewer: "auto_review" });
  const runtime = pluginRuntimeSpecForRevision(revision({ plugins: state }));

  assert.equal(runtime.kind, "codex");
  assert.deepEqual(runtime.selections, state.plugins);

  const data = pluginRuntimeConfigMapData(runtime);
  const manifest = JSON.parse(data[PLUGIN_RUNTIME_MANIFEST]);
  assert.deepEqual(manifest, {
    kind: "codex",
    selections: state.plugins,
  });
  assert.match(
    data[PLUGIN_RUNTIME_CODEX_CONFIG],
    /^\[features\]\napps = true\nplugins = true\nremote_plugin = true/m,
  );
  assert.doesNotMatch(
    data[PLUGIN_RUNTIME_CODEX_CONFIG],
    /asdk_app_69a089a326dc8191b32a3f2553f5be2c/,
  );
});

test("compute serializes selected OpenClaw plugins for startup-time resolution", () => {
  const state = openClawPluginState();
  const runtime = pluginRuntimeSpecForRevision(
    revision({
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
      plugins: state,
    }),
  );

  assert.deepEqual(runtime.selections, state.plugins);
  const data = pluginRuntimeConfigMapData(runtime);
  assert.deepEqual(Object.keys(data), [PLUGIN_RUNTIME_MANIFEST]);
  assert.deepEqual(JSON.parse(data[PLUGIN_RUNTIME_MANIFEST]), {
    kind: "openclaw",
    selections: state.plugins,
  });
});

test("Codex runtime helper installs selected remote plugins before readiness", async () => {
  const state = codexLinearPluginState({ approvalsReviewer: "auto_review" });
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  let readCount = 0;
  const { requests, sockets } = await runCodexRuntimeHelper(runtime, (method, params) => {
    if (method === "initialize") return { serverInfo: { name: "codex", version: "0.149.0" } };
    if (method === "plugin/list") {
      assert.deepEqual(params, {});
      return codexListResponse();
    }
    if (method === "plugin/read") {
      assert.deepEqual(params, {
        remoteMarketplaceName: "openai-curated-remote",
        pluginName: CODEX_LINEAR_REMOTE_ID,
      });
      readCount += 1;
      return codexReadResponse({ installed: readCount > 1, enabled: readCount > 1 });
    }
    if (method === "config/batchWrite") {
      assert.deepEqual(params, {
        edits: [
          { keyPath: "features.apps", mergeStrategy: "replace", value: true },
          { keyPath: "features.plugins", mergeStrategy: "replace", value: true },
          { keyPath: "features.remote_plugin", mergeStrategy: "replace", value: true },
          { keyPath: 'apps."_default"', mergeStrategy: "replace", value: { enabled: false } },
          {
            keyPath: `apps.${CODEX_LINEAR_APP_ID}`,
            mergeStrategy: "replace",
            value: {
              enabled: true,
              default_tools_approval_mode: "auto",
              approvals_reviewer: "auto_review",
            },
          },
        ],
        reloadUserConfig: true,
      });
      return { status: "ok", version: "test-config-1" };
    }
    if (method === "plugin/install") {
      assert.deepEqual(params, {
        remoteMarketplaceName: "openai-curated-remote",
        pluginName: CODEX_LINEAR_REMOTE_ID,
      });
      return { authPolicy: "ON_USE", appsNeedingAuth: [] };
    }
    if (method === "config/read") {
      assert.deepEqual(params, {});
      return codexConfigReadResponse({ approvals_reviewer: "auto_review" });
    }
    throw new Error(`unexpected request ${method}`);
  });

  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "plugin/list",
      "initialize",
      "plugin/read",
      "initialize",
      "config/batchWrite",
      "initialize",
      "plugin/install",
      "initialize",
      "plugin/read",
      "initialize",
      "config/read",
    ],
  );
  assert.equal(
    sockets.every(
      (socket) => socket.options.headers.Authorization === "Bearer capability-token-test-value",
    ),
    true,
  );
});

test("Codex runtime keeps disabled selected plugins default-denied while preserving install identity", async () => {
  for (const [name, selectionOverride] of [
    ["disabled", { enabled: false }],
    ["never-approved", { approvalMode: "never" }],
  ]) {
    const state = codexLinearPluginState(selectionOverride);
    const runtime = {
      manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
    };
    let readCount = 0;
    const installRequests = [];
    const { requests } = await runCodexRuntimeHelper(runtime, (method, params) => {
      if (method === "initialize") return { serverInfo: { name: "codex", version: "0.149.0" } };
      if (method === "plugin/list") return codexListResponse();
      if (method === "plugin/read") {
        readCount += 1;
        return codexReadResponse({ installed: readCount > 1, enabled: readCount > 1 });
      }
      if (method === "config/batchWrite") {
        assert.deepEqual(params, {
          edits: [
            { keyPath: "features.apps", mergeStrategy: "replace", value: true },
            { keyPath: "features.plugins", mergeStrategy: "replace", value: true },
            { keyPath: "features.remote_plugin", mergeStrategy: "replace", value: true },
            { keyPath: 'apps."_default"', mergeStrategy: "replace", value: { enabled: false } },
          ],
          reloadUserConfig: true,
        });
        return { status: "ok", version: `${name}-config-1` };
      }
      if (method === "plugin/install") {
        installRequests.push(params);
        return { authPolicy: "ON_USE", appsNeedingAuth: [] };
      }
      if (method === "config/read") {
        return {
          config: {
            features: { apps: true, plugins: true, remote_plugin: true },
            apps: { _default: { enabled: false } },
            plugins: {},
          },
          origins: {},
        };
      }
      throw new Error(`unexpected request ${method}`);
    });

    assert.deepEqual(installRequests, [
      {
        remoteMarketplaceName: "openai-curated-remote",
        pluginName: CODEX_LINEAR_REMOTE_ID,
      },
    ]);
    assert.equal(
      requests.some(
        (request) =>
          request.method === "config/batchWrite" &&
          request.params.edits.some((edit) => edit.keyPath === `apps.${CODEX_LINEAR_APP_ID}`),
      ),
      false,
    );

    const gatewayRuntime = {
      manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
    };
    const { files } = runOpenClawRuntimeHelper(gatewayRuntime, []);
    const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
    const bridge = effective.plugins.entries.codex.config.codexPlugins;
    assert.equal(bridge.enabled, true);
    assert.equal(bridge.allow_all_plugins, false);
    assert.deepEqual(bridge.plugins.linear, {
      enabled: false,
      marketplaceName: "openai-curated-remote",
      pluginName: "linear",
      allow_destructive_actions: "auto",
    });
  }
});

test("Codex runtime helper fails before readiness when catalog identity is absent", async () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  await assert.rejects(
    () =>
      runCodexRuntimeHelper(runtime, (method) => {
        if (method === "initialize") return { serverInfo: { name: "codex", version: "0.149.0" } };
        if (method === "plugin/list") {
          return codexListResponse({
            nativeId: "asana@openai-curated-remote",
            remotePluginId: "plugin_asdk_app_asana",
            name: "asana",
          });
        }
        throw new Error(`unexpected request ${method}`);
      }),
    /catalog did not contain the selected plugin/,
  );
});

test("Codex runtime helper fails before readiness when native app mapping drifts", async () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  let readCount = 0;
  await assert.rejects(
    () =>
      runCodexRuntimeHelper(runtime, (method, params) => {
        if (method === "initialize") return { serverInfo: { name: "codex", version: "0.149.0" } };
        if (method === "plugin/list") return codexListResponse();
        if (method === "plugin/read") {
          readCount += 1;
          return codexReadResponse({
            apps: [
              {
                id: readCount === 1 ? CODEX_LINEAR_APP_ID : "asdk_app_changed",
                name: "Linear",
                needsAuth: false,
              },
            ],
          });
        }
        if (method === "config/batchWrite") return { status: "ok", version: "test-config-1" };
        if (method === "plugin/install") {
          assert.deepEqual(params, {
            remoteMarketplaceName: "openai-curated-remote",
            pluginName: CODEX_LINEAR_REMOTE_ID,
          });
          return { authPolicy: "ON_USE", appsNeedingAuth: [] };
        }
        throw new Error(`unexpected request ${method}`);
      }),
    /installed app mapping does not match startup resolution/,
  );
});

test("Codex runtime helper fails before readiness when native version drifts", async () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  let readCount = 0;
  await assert.rejects(
    () =>
      runCodexRuntimeHelper(runtime, (method) => {
        if (method === "initialize") return { serverInfo: { name: "codex", version: "0.149.0" } };
        if (method === "plugin/list") return codexListResponse();
        if (method === "plugin/read") {
          readCount += 1;
          return codexReadResponse({ version: readCount === 1 ? "5.0.1" : "5.0.2" });
        }
        if (method === "config/batchWrite") return { status: "ok", version: "test-config-1" };
        if (method === "plugin/install") return { authPolicy: "ON_USE", appsNeedingAuth: [] };
        throw new Error(`unexpected request ${method}`);
      }),
    /installed release metadata does not match startup resolution/,
  );
});

test("Codex runtime helper fails before readiness when effective native app config drifts", async () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  await assert.rejects(
    () =>
      runCodexRuntimeHelper(runtime, (method) => {
        if (method === "initialize") return { serverInfo: { name: "codex", version: "0.149.0" } };
        if (method === "plugin/list") return codexListResponse();
        if (method === "plugin/read") return codexReadResponse();
        if (method === "config/batchWrite") return { status: "ok", version: "test-config-1" };
        if (method === "plugin/install") return { authPolicy: "ON_USE", appsNeedingAuth: [] };
        if (method === "config/read") {
          return {
            config: {
              features: { apps: true, plugins: true, remote_plugin: true },
              apps: { _default: { enabled: true } },
              plugins: {},
            },
            origins: {},
          };
        }
        throw new Error(`unexpected request ${method}`);
      }),
    /effective config does not match admitted configuration/,
  );
});

test("Codex runtime helper fails before readiness when selected plugin lacks app mapping", async () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };
  await assert.rejects(
    () =>
      runCodexRuntimeHelper(runtime, (method) => {
        if (method === "initialize") return { serverInfo: { name: "codex", version: "0.149.0" } };
        if (method === "plugin/list") return codexListResponse();
        if (method === "plugin/read") return codexReadResponse({ apps: [] });
        throw new Error(`unexpected request ${method}`);
      }),
    /does not expose an app mapping/,
  );
});

test("OpenClaw runtime helper installs exact admitted package pins and verifies the install record", async () => {
  const state = openClawPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(
      revision({ harness: { id: "openclaw", version: "1.0.0", mode: "embedded" }, plugins: state }),
    ),
  };
  const { calls, files } = runOpenClawRuntimeHelper(runtime, [
    { status: 0, stdout: "", stderr: "" },
    { status: 0, stdout: JSON.stringify({ refreshed: true }), stderr: "" },
    {
      status: 0,
      stdout: JSON.stringify({
        plugin: {
          id: "diffs",
          version: "2026.8.2",
          rootDir: "/home/node/.openclaw/plugins/@openclaw/diffs",
        },
        install: {
          source: "npm",
          resolvedName: "@openclaw/diffs",
          resolvedVersion: "2026.8.2",
          installPath: "/home/node/.openclaw/plugins/@openclaw/diffs",
          integrity: OCC_DIFFS_DIGEST,
        },
      }),
      stderr: "",
    },
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(calls.map((call) => call.args))), [
    ["/app/openclaw.mjs", "plugins", "install", "@openclaw/diffs@2026.8.2", "--pin", "--force"],
    ["/app/openclaw.mjs", "plugins", "registry", "--refresh", "--json"],
    ["/app/openclaw.mjs", "plugins", "inspect", "diffs", "--json"],
  ]);

  const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.equal(effective.gateway.port, 8080);
  assert.deepEqual(effective.plugins.installs.keep, { source: "npm" });
  assert.deepEqual(effective.plugins.load.paths, ["existing"]);
  assert.deepEqual(effective.plugins.entries, { diffs: { enabled: true } });
  assert.deepEqual(effective.tools.alsoAllow, ["existing-tool", "diffs"]);
});

test("OpenClaw runtime helper fails before readiness when raw Codex bridge config conflicts", () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision({ plugins: state })),
  };

  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [], {
        baseConfig: {
          gateway: { port: 8080 },
          plugins: {
            entries: {
              codex: {
                config: {
                  codexPlugins: {
                    enabled: true,
                    allow_all_plugins: false,
                    plugins: { google_calendar: { enabled: true } },
                  },
                },
              },
            },
          },
        },
      }),
    /Codex bridge configuration conflicts/,
  );
});

test("OpenClaw runtime helper fails before readiness when installed metadata drifts", async () => {
  const state = openClawPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(
      revision({ harness: { id: "openclaw", version: "1.0.0", mode: "embedded" }, plugins: state }),
    ),
  };
  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [
        { status: 0, stdout: "", stderr: "" },
        { status: 0, stdout: JSON.stringify({ refreshed: true }), stderr: "" },
        {
          status: 0,
          stdout: JSON.stringify({
            plugin: {
              id: "diffs",
              version: "2026.8.2",
              rootDir: "/home/node/.openclaw/plugins/@openclaw/diffs",
            },
            install: {
              source: "npm",
              resolvedName: "@openclaw/diffs",
              resolvedVersion: "2026.8.3",
              installPath: "/home/node/.openclaw/plugins/@openclaw/diffs",
              integrity: OCC_DIFFS_DIGEST,
            },
          }),
          stderr: "",
        },
      ]),
    /installed version does not match/,
  );
});

test("OpenClaw runtime helper fails before readiness when bundled metadata shadows the install", async () => {
  const state = openClawPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(
      revision({ harness: { id: "openclaw", version: "1.0.0", mode: "embedded" }, plugins: state }),
    ),
  };
  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [
        { status: 0, stdout: "", stderr: "" },
        { status: 0, stdout: JSON.stringify({ refreshed: true }), stderr: "" },
        {
          status: 0,
          stdout: JSON.stringify({
            plugin: {
              id: "diffs",
              version: "2026.8.2",
              rootDir: "/app/plugin-skills/diffs",
            },
            install: {
              source: "npm",
              resolvedName: "@openclaw/diffs",
              resolvedVersion: "2026.8.2",
              installPath: "/home/node/.openclaw/plugins/@openclaw/diffs",
              integrity: OCC_DIFFS_DIGEST,
            },
          }),
          stderr: "",
        },
      ]),
    /runtime root directory does not resolve inside the admitted install path/,
  );
});

test("compute rejects plugin selections that target the wrong native runtime", async () => {
  await assert.rejects(async () => {
    const state = openClawPluginState();
    pluginRuntimeSpecForRevision(revision({ plugins: state }));
  }, /embedded OpenClaw Harness/);
});

test("compute fails closed when Codex plugin selections are malformed", () => {
  assert.throws(
    () =>
      pluginRuntimeSpecForRevision(
        revision({
          plugins: {
            driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
            plugins: { "codex-plugin:linear@openai-curated-remote": null },
          },
        }),
      ),
    /plugin selections are invalid/,
  );
});

test("Kubernetes refuses retained plugin revisions before configuration, provider or launch work", async () => {
  const driver = new KubernetesComputeDriver(kubernetesOptions(), {
    resourcePolicy: { mode: "admitted" },
  });
  let configurationReads = 0;
  let providerCalls = 0;
  let launchCalls = 0;
  driver.resolveNamespace = async () => {
    configurationReads++;
    throw new Error("unexpected configuration lookup");
  };
  driver.clients = async () => {
    providerCalls++;
    throw new Error("unexpected provider access");
  };
  driver.reconcile = async () => {
    providerCalls++;
    throw new Error("unexpected provider mutation");
  };
  driver.lifecycle.beforeWorkloadStart = async () => {
    launchCalls++;
    throw new Error("unexpected launch hook");
  };
  for (const [harness, plugins] of [
    [{ id: "openclaw", version: "1.0.0", mode: "embedded" }, openClawPluginState()],
    [{ id: "codex", version: "1.0.0", mode: "dedicated" }, codexLinearPluginState()],
  ]) {
    const selected = revision({
      harness,
      plugins,
      compute: { id: driver.id, implementation: driver.implementation },
    });
    await assert.rejects(
      driver.prepareRevision(selected),
      /workload profiles do not bind plugin runtime artifacts/,
    );
    await assert.rejects(
      driver.activateRevision(selected),
      /workload profiles do not bind plugin runtime artifacts/,
    );
    assert.throws(
      () => driver.acquireCurrentLaunchOperands(selected),
      /workload profiles do not bind plugin runtime artifacts/,
    );
  }
  assert.equal(configurationReads, 0);
  assert.equal(providerCalls, 0);
  assert.equal(launchCalls, 0);
});

test("Kubernetes prepared verification refuses unsupported plugins before opening child operands", async () => {
  const driver = createKubernetesComputeDriver(kubernetesOptions());
  const selected = revision({
    compute: { id: driver.id, implementation: driver.implementation },
    plugins: codexLinearPluginState(),
  });
  let currentnessCalls = 0;
  let childReads = 0;
  let providerCalls = 0;
  driver.clients = async () => {
    providerCalls++;
    throw new Error("unexpected provider access");
  };
  // A refusal-only component input: it must never reach any accepting child or I/O.
  await assert.rejects(
    driver.verifyPreparedDeployment(
      {
        assertCurrent() {
          currentnessCalls++;
        },
        revision: selected,
        get child() {
          childReads++;
          throw new Error("unexpected child acquisition");
        },
      },
      undefined,
    ),
    /workload profiles do not bind plugin runtime artifacts/,
  );
  assert.equal(currentnessCalls, 1);
  assert.equal(childReads, 0);
  assert.equal(providerCalls, 0);
});

test("Codex runtime clears stale readiness marker before startup failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-plugin-ready-"));
  const marker = join(directory, "ready");
  writeFileSync(marker, "ready\n", { mode: 0o600 });
  assert.equal(existsSync(marker), true);
  try {
    const sandbox = {
      console: { error() {} },
      process: {
        env: {
          CODEX_HOME: "/home/node/.codex",
          OPENCLAW_PLUGIN_READY_MARKER: marker,
        },
      },
      require(specifier) {
        if (specifier === "node:fs") {
          return {
            mkdirSync() {},
            rmSync,
            readFileSync() {
              throw new Error("plugin runtime payload should not be read before login failure");
            },
            writeFileSync() {},
          };
        }
        if (specifier === "node:child_process") {
          return {
            spawnSync() {
              return { status: 1 };
            },
            spawn() {
              assert.fail("app-server must not start after login failure");
            },
          };
        }
        return nodeRequire(specifier);
      },
    };

    assert.throws(
      () => vm.runInNewContext(PLUGIN_AGENT_RUNTIME_ENTRYPOINT, sandbox),
      /Codex model authentication initialization failed/,
    );
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Kubernetes no-plugin fixed agent and gateway retain entrypoints without plugin mounts", () => {
  const driver = createKubernetesComputeDriver(kubernetesOptions());
  for (const plugins of [undefined, codexNoPluginState()]) {
    assert.equal(pluginRuntimeSpecForRevision(revision({ plugins })), undefined);
    for (const [role, entrypoint] of [
      ["agent", AGENT_RUNTIME_ENTRYPOINT],
      ["gateway", GATEWAY_RUNTIME_ENTRYPOINT],
    ]) {
      const deployment = driver.deployment(
        role + "-plugin-compute-rev",
        { namespaceId: tenant.id, agentId: agent.id, revisionId: "revision-plugin-compute-1" },
        "oce-plugin-compute",
        "openclaw-enterprise/" + role + "-fixture:local",
        role + "-plugin-compute",
        role,
        {},
        "info",
      );
      const pod = deployment.spec.template.spec;
      const container = pod.containers[0];
      assert.deepEqual(container.command, ["node", "-e"]);
      assert.deepEqual(container.args, [entrypoint]);
      assert.equal(
        (pod.volumes ?? []).some((volume) => volume.name === "openclaw-plugin-runtime"),
        false,
      );
      assert.equal(
        (container.volumeMounts ?? []).some((mount) => mount.name === "openclaw-plugin-runtime"),
        false,
      );
      for (const name of [
        PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT,
        PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT,
        PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT,
      ]) {
        assert.equal(
          (container.env ?? []).some((variable) => variable.name === name),
          false,
        );
      }
    }
  }
});
