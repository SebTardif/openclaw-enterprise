import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mock, test } from "node:test";
import { promisify } from "node:util";

const serverUrl = new URL("../../apps/controller/src/server.mjs", import.meta.url);
const run = promisify(execFile);
let snapshotHook;
let driversHook;
let productionHook;
let developmentHook;
let loggerHook;

// Only server startup is real here. Configuration, Driver loading, composition,
// logging and the app are controlled peers. Opaque sentinels prove forwarding,
// not original factory membership, authority admission or a repository read.
mock.module(new URL("./composition/startup-config/read.ts", serverUrl).href, {
  namedExports: { loadStartupConfigurationSnapshot: (...args) => snapshotHook(...args) },
});
mock.module(new URL("./composition/installation-config.ts", serverUrl).href, {
  namedExports: { loadInstallationConfiguration: (...args) => driversHook(...args) },
});
mock.module(new URL("./composition/production.ts", serverUrl).href, {
  namedExports: { composeProduction: (...args) => productionHook(...args) },
});
mock.module(new URL("./composition/development-postgres.ts", serverUrl).href, {
  namedExports: { composePostgresDevelopment: (...args) => developmentHook(...args) },
});
mock.module(new URL("./logging.ts", serverUrl).href, {
  namedExports: { createOccLogger: (...args) => loggerHook(...args) },
});

const importedListeners = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
const importedExitCode = process.exitCode;
// Hooks are deliberately unset: an import that starts configuration would fail.
const { createControllerServer } = await import(serverUrl.href);

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function fixture(t, mode = "production") {
  const previous = { ...process.env };
  const selected = (name) => name === "NODE_ENV" || name.startsWith("OCC_");
  for (const name of Object.keys(process.env)) if (selected(name)) delete process.env[name];
  Object.assign(process.env, {
    NODE_ENV: mode,
    OCC_HOST: mode === "production" ? "192.0.2.10" : "127.0.0.1",
    OCC_PORT: "8080",
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/unused",
    OCC_AUTH_BASE_URL: "http://127.0.0.1:8080",
    OCC_AUTH_SECRET: "controller-startup-test-auth-secret-at-least-32-bytes",
  });
  t.after(() => {
    for (const name of Object.keys(process.env)) if (selected(name)) delete process.env[name];
    for (const [name, value] of Object.entries(previous))
      if (selected(name)) process.env[name] = value;
  });
  const events = [];
  const productionCalls = [];
  const developmentCalls = [];
  const startupConfiguration = { logging: { level: "warn" } };
  const drivers = { installation: { drivers: {} } };
  const logger = { info: (record) => events.push(record) };
  const app = {
    async listen(options) {
      events.push({ listen: options });
    },
    async close() {
      events.push("close");
    },
  };
  snapshotHook = async (options) => {
    events.push({ snapshot: options });
    return startupConfiguration;
  };
  driversHook = async (options) => {
    assert.equal(options.startupConfiguration, startupConfiguration);
    events.push("drivers");
    return drivers;
  };
  loggerHook = () => logger;
  productionHook = async (options) => {
    productionCalls.push(options);
    return app;
  };
  developmentHook = async (...options) => {
    developmentCalls.push(options);
    return app;
  };
  return { events, productionCalls, developmentCalls, startupConfiguration, drivers, logger, app };
}

test("importing server does not start configuration, listen or install signal handlers", () => {
  assert.equal(typeof createControllerServer, "function");
  assert.deepEqual(
    [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")],
    importedListeners,
  );
  assert.equal(process.exitCode, importedExitCode);
});

test("production captures read definitions before awaiting configuration and forwards identities once", async (t) => {
  const f = fixture(t);
  const first = Object.freeze({});
  const second = Object.freeze({});
  const definitions = [first, second];
  const options = { githubReadServices: definitions };
  const loading = deferred();
  snapshotHook = () => loading.promise;
  const composing = createControllerServer(options);
  definitions.splice(0, 2, Object.freeze({}));
  options.githubReadServices = [];
  loading.resolve(f.startupConfiguration);
  const composed = await composing;
  assert.equal(f.productionCalls.length, 1);
  const forwarded = f.productionCalls[0];
  assert.notEqual(forwarded.githubReadServices, definitions);
  assert.ok(Object.isFrozen(forwarded.githubReadServices));
  assert.equal(forwarded.githubReadServices.length, 2);
  assert.equal(forwarded.githubReadServices[0], first);
  assert.equal(forwarded.githubReadServices[1], second);
  assert.equal(forwarded.drivers, f.drivers);
  assert.equal(forwarded.logger, f.logger);
  assert.equal(forwarded.logging, f.startupConfiguration.logging);
  assert.equal(composed.app, f.app);
  assert.deepEqual(composed.listenOptions, { host: "192.0.2.10", port: 8080 });
  assert.equal(composed.logger, f.logger);
  assert.deepEqual(f.events, ["drivers"]);
  assert.equal(f.developmentCalls.length, 0);
  // Programmatic callers own listening and cleanup; composition installs none.
  assert.deepEqual(
    [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")],
    importedListeners,
  );
  await composed.app.close();
  assert.equal(f.events.at(-1), "close");
});

test("absent production read services preserve default composition", async (t) => {
  const f = fixture(t);
  for (const options of [undefined, {}, { githubReadServices: undefined }]) {
    await createControllerServer(options);
    assert.equal(Object.hasOwn(f.productionCalls.at(-1), "githubReadServices"), false);
  }
  assert.equal(f.productionCalls.length, 3);
});

test("an explicitly empty production list is forwarded as an empty snapshot", async (t) => {
  const f = fixture(t);
  await createControllerServer({ githubReadServices: [] });
  assert.equal(f.productionCalls.length, 1);
  assert.deepEqual(f.productionCalls[0].githubReadServices, []);
});

test("production refusal propagates unchanged without listening", async (t) => {
  const f = fixture(t);
  const refusal = new Error("controlled composition refusal");
  productionHook = async (options) => {
    f.productionCalls.push(options);
    throw refusal;
  };
  await assert.rejects(
    createControllerServer({ githubReadServices: [Object.freeze({})] }),
    (e) => e === refusal,
  );
  assert.equal(f.productionCalls.length, 1);
  assert.deepEqual(f.events, [{ snapshot: { mode: "production" } }, "drivers"]);
});

test("development refuses explicit read services, including an empty list, before loading peers", async (t) => {
  const f = fixture(t, "development");
  for (const githubReadServices of [[], [Object.freeze({})]]) {
    await assert.rejects(
      createControllerServer({ githubReadServices }),
      /GitHub read services require production controller startup/,
    );
  }
  assert.deepEqual(f.events, []);
  assert.equal(f.productionCalls.length, 0);
  assert.equal(f.developmentCalls.length, 0);
});

test("development without read services retains its composition and persistence requirement", async (t) => {
  const f = fixture(t, "development");
  await createControllerServer({ githubReadServices: undefined });
  assert.equal(f.developmentCalls.length, 1);
  assert.equal(f.developmentCalls[0][1], f.drivers);
  assert.equal(f.productionCalls.length, 0);
  delete process.env.OCC_DATABASE_URL;
  await assert.rejects(createControllerServer(), /OCC_DATABASE_URL must be explicitly configured/);
  assert.equal(f.developmentCalls.length, 1);
});

test("startup continues to validate environment before composing", async (t) => {
  const f = fixture(t);
  process.env.OCC_HOST = "127.0.0.1";
  await assert.rejects(createControllerServer(), /Production OCC_HOST/);
  assert.deepEqual(f.events, []);
  assert.equal(f.productionCalls.length, 0);
});

test("serialized or non-array service selections are refused before loading peers", async (t) => {
  const f = fixture(t);
  for (const githubReadServices of [null, "[]", {}, new Set()]) {
    await assert.rejects(createControllerServer({ githubReadServices }), /must be an array/);
  }
  assert.deepEqual(f.events, []);
});

// Run the real direct-entry branch in a separate process so signal listeners,
// exitCode and the module cache cannot leak into other conformance cases.
async function exerciseCli(serverHref, scenario) {
  const { default: assert } = await import("node:assert/strict");
  const { mock } = await import("node:test");
  const { fileURLToPath } = await import("node:url");
  const records = [];
  const events = [];
  const sentinel = () => {};
  process.on("SIGTERM", sentinel);
  process.on("SIGINT", sentinel);
  let releaseClose;
  const pendingClose = new Promise((resolve) => {
    releaseClose = resolve;
  });
  const app = {
    async listen(options) {
      events.push("listen");
      assert.deepEqual(options, { host: "192.0.2.10", port: 8080 });
      if (scenario === "listen-failure" || scenario === "listen-signal-race") {
        if (scenario === "listen-signal-race") process.emit("SIGTERM");
        throw new Error("PRIVATE_LISTEN_FAILURE");
      }
    },
    async close() {
      events.push("close-start");
      await pendingClose;
      events.push("close-end");
      if (scenario === "close-failure") throw new Error("PRIVATE_CLOSE_FAILURE");
    },
  };
  const peers = {
    "./composition/startup-config/read.ts": {
      loadStartupConfigurationSnapshot: async () => ({ logging: { level: "info" } }),
    },
    "./composition/installation-config.ts": {
      loadInstallationConfiguration: async () => ({ installation: { drivers: {} } }),
    },
    "./composition/production.ts": {
      composeProduction: async (options) => {
        events.push("compose");
        assert.equal(Object.hasOwn(options, "githubReadServices"), false);
        if (scenario === "composition-failure") throw new Error("PRIVATE_COMPOSITION_FAILURE");
        return app;
      },
    },
    "./logging.ts": {
      createOccLogger: () => ({
        info: (record) => records.push(record),
        error: (record) => records.push(record),
      }),
    },
  };
  for (const [path, namedExports] of Object.entries(peers)) {
    mock.module(new URL(path, serverHref).href, { namedExports });
  }
  process.argv[1] = fileURLToPath(serverHref);
  const starting = import(serverHref);
  const failure = scenario === "listen-failure" || scenario === "listen-signal-race";
  if (failure) {
    // A deferred close must finish before the CLI reports the original failure.
    while (!events.includes("close-start")) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(records, []);
    assert.equal(process.exitCode, undefined);
    releaseClose();
  }
  await starting;
  if (scenario === "success" || scenario === "close-failure") {
    assert.deepEqual(events, ["compose", "listen"]);
    assert.deepEqual(records, [{ event: "listening", host: "192.0.2.10", port: 8080 }]);
    const shutdownTerm = process.listeners("SIGTERM").find((fn) => fn !== sentinel);
    const shutdownInt = process.listeners("SIGINT").find((fn) => fn !== sentinel);
    assert.equal(typeof shutdownTerm, "function");
    assert.equal(shutdownTerm, shutdownInt);
    const first = shutdownTerm();
    const second = shutdownInt();
    await Promise.resolve();
    assert.deepEqual(events, ["compose", "listen", "close-start"]);
    assert.equal(process.exitCode, undefined);
    releaseClose();
    await Promise.all([first, second]);
    assert.equal(process.exitCode, scenario === "close-failure" ? 1 : 0);
  } else {
    assert.equal(process.exitCode, 1);
    assert.deepEqual(records, [
      {
        event: "startup-error",
        code: "STARTUP_FAILED",
        error: "Controller startup failed. Check the configured startup prerequisites.",
      },
    ]);
  }
  assert.deepEqual(process.listeners("SIGTERM"), [sentinel]);
  assert.deepEqual(process.listeners("SIGINT"), [sentinel]);
  assert.deepEqual(
    events,
    scenario === "composition-failure"
      ? ["compose"]
      : ["compose", "listen", "close-start", "close-end"],
  );
  process.stdout.write(JSON.stringify({ events, records, exitCode: process.exitCode }));
  // Preserve the observed product exitCode in the result; assertions determine
  // this child harness's exit status.
  process.exitCode = 0;
}

for (const scenario of [
  "success",
  "composition-failure",
  "listen-failure",
  "listen-signal-race",
  "close-failure",
]) {
  test(`direct CLI preserves composition, listening and joined cleanup: ${scenario}`, async () => {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        "--input-type=module",
        "--eval",
        `await (${exerciseCli.toString()})(${JSON.stringify(serverUrl.href)}, ${JSON.stringify(scenario)});`,
      ],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "production",
          OCC_HOST: "192.0.2.10",
          OCC_PORT: "8080",
          OCC_DATABASE_URL: "postgresql://127.0.0.1:1/unused",
          OCC_AUTH_BASE_URL: "http://127.0.0.1:8080",
          OCC_AUTH_SECRET: "controller-startup-test-auth-secret-at-least-32-bytes",
        },
        timeout: 15_000,
      },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.exitCode, scenario === "success" ? 0 : 1);
    assert.doesNotMatch(stdout + stderr, /PRIVATE_/);
  });
}
