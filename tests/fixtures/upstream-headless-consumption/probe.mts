import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// TODO: Replace these version-pinned internal imports when upstream publishes a
// supported headless lifecycle and dispatch adapter. This is not a product API.
const root = process.env.OCC_TEST_UPSTREAM_SNAPSHOT;
assert.ok(root, "The parent integration test must provide the pinned source snapshot.");
const load = (path: string) => import(pathToFileURL(join(root, path)).href);
const { createGatewayKernel } = await load("src/gateway/server-kernel.ts");
const { dispatchGatewayRequestInProcess } = await load("src/gateway/server-in-process-dispatch.ts");
const { createSyntheticPluginRuntimeClient } = await load(
  "src/gateway/server-plugin-runtime-client.ts",
);
const { PROTOCOL_VERSION } = await load("packages/gateway-protocol/src/version.ts");
assert.equal(PROTOCOL_VERSION, 4);
const observations: string[] = [];
let hostCalls = 0;
const kernel = await createGatewayKernel(19789, {
  bootId: "enterprise-headless-consumption-probe",
  bind: "loopback",
  controlUiEnabled: false,
  sidecarStartup: "defer",
  ambientEnvTriggers: "suppress",
  hostLifecycle: {
    async request(_action: string, assertCaller: () => void) {
      assertCaller();
      hostCalls += 1;
      return { ok: true, value: { outcome: "scheduled" } };
    },
  },
});
let closed = false;
try {
  const { getStartup, getReadiness } = kernel.createHttpTransportOptions();
  assert.equal(kernel.minimalTestGateway, false);
  assert.equal(getReadiness().ready, false);
  assert.ok(getReadiness().failing.includes("startup-sidecars"));
  observations.push("deferred startup is not ready");
  const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
  const dispatchOptions = {
    client,
    context: kernel.gatewayRequestContext,
    methodRegistry: kernel.getAttachedGatewayMethodRegistry(),
    timeoutMs: 5000,
  };
  // A synthetic local message reaches the real startup gate; it must never run a model.
  await assert.rejects(
    dispatchGatewayRequestInProcess(
      "chat.send",
      {
        sessionKey: "agent:main:headless-probe",
        message: "Synthetic local channel input",
        idempotencyKey: "headless-probe-startup-denied",
      },
      dispatchOptions,
    ),
    {
      code: "UNAVAILABLE",
      retryable: true,
      message: "chat.send unavailable during gateway startup",
    },
  );
  observations.push("chat.send is denied by the real startup gate");
  // The socket-free host owns readiness publication normally performed by listener startup.
  // No channel or harness readiness is implied: both are disabled in this probe.
  kernel.kernel.unlockStartupMethods();
  kernel.kernel.markSidecarsReady();
  kernel.kernel.setDispatchReady(true);
  assert.equal(getReadiness().ready, true);
  assert.equal(getStartup().status, "started");
  observations.push("host publishes readiness");
  const health = await dispatchGatewayRequestInProcess("health", { probe: false }, dispatchOptions);
  assert.equal(health.ok, true);
  assert.deepEqual(health.channelOrder, []);
  observations.push("health uses the real request router and handler");
  await assert.rejects(
    dispatchGatewayRequestInProcess(
      "logs.tail",
      { limit: 1 },
      {
        ...dispatchOptions,
        client: createSyntheticPluginRuntimeClient({ scopes: [] }),
      },
    ),
    {
      code: "FORBIDDEN",
      retryable: false,
      message: "missing scope: operator.read",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.read",
        requiredScopes: ["operator.read"],
      },
    },
  );
  observations.push("unscoped internal client is denied");
  const boundHost = kernel.gatewayRequestContext.hostLifecycle;
  assert.deepEqual(await boundHost.request("stop", () => {}), {
    ok: true,
    value: { outcome: "scheduled" },
  });
  assert.equal(hostCalls, 1);
  // Exercise the actual close handler without substituting reloader or sidecar methods.
  const closing = kernel.createCloseHandler()({ reason: "headless consumption probe" });
  assert.equal(getReadiness().ready, false);
  assert.ok(getReadiness().failing.includes("gateway-draining"));
  assert.equal(getStartup().status, "draining");
  await assert.rejects(async () => boundHost.request("start", () => {}), /closed instance/);
  assert.equal(hostCalls, 1);
  await closing;
  closed = true;
  assert.equal(kernel.gatewayInstanceRuntime.isAvailable(), false);
  assert.equal(kernel.gatewayRequestContext.resolveGatewayContext(), undefined);
  await assert.rejects(
    kernel.gatewayInstanceRuntime.recovery.abortAgent(
      { sessionKey: "agent:main:headless-probe" },
      1000,
    ),
    /Gateway instance dispatch unavailable for chat.abort/,
  );
  observations.push("close drains readiness and fences retained lifecycle authority");
  process.stdout.write(
    `OCC_UPSTREAM_PROBE_RESULT ${JSON.stringify({ protocol: PROTOCOL_VERSION, observations })}\n`,
  );
} finally {
  if (!closed) await kernel.closeOnStartupFailure();
}
