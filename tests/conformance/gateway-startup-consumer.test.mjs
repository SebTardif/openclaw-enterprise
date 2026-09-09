import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { requireAdmittedGatewayConfiguration } from "../../apps/gateway/src/admitted-configuration.ts";
import {
  createGatewayComposition,
  prepareGatewayComposition,
} from "../../apps/gateway/src/composition.ts";

// Resolve the public SDK exports from the Gateway workspace that owns them.
const gatewayRequire = createRequire(new URL("../../apps/gateway/package.json", import.meta.url));
const admittedUrl = new URL("../../apps/gateway/src/admitted-configuration.ts", import.meta.url);
const mainUrl = new URL("../../apps/gateway/src/main.mjs", import.meta.url);
const diagnostic = "Hosted gateway unavailable: startup or cleanup is not confirmed.\n";
let sequence = 0;
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Controlled producer ports exercise the actual main consumer only. They are not
// enrolled Runtime handles, durable startup claims or positive production authority.
async function mainFixture(t, read) {
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  t.after(() => {
    process.exitCode = priorExitCode;
  });
  if (read)
    t.mock.module(admittedUrl, { namedExports: { requireAdmittedGatewayConfiguration: read } });
  const url = new URL(mainUrl);
  url.searchParams.set("consumer", String(sequence++));
  const { main } = await import(url.href);
  // Let Node report its module-mocking warnings before capturing application output.
  await setImmediate();
  let output = "";
  t.mock.method(process.stderr, "write", (value) => {
    output += value;
    return true;
  });
  return {
    main,
    get output() {
      return output;
    },
  };
}

function enrollment(start) {
  return Object.freeze({
    usePort: Object.freeze({ start }),
    recipient: Object.freeze({}),
    startup: Object.freeze({}),
  });
}

test("actual admitted reader remains zero-argument and unavailable without protected bootstrap", () => {
  assert.equal(requireAdmittedGatewayConfiguration.length, 0);
  assert.throws(() => requireAdmittedGatewayConfiguration({ trusted: true }), /unavailable/);
});

test("actual fixed main refuses the missing bootstrap with a sanitized diagnostic", async (t) => {
  const f = await mainFixture(t);
  assert.equal(f.main.length, 0);
  await f.main();
  assert.equal(process.exitCode, 1);
  assert.equal(f.output, diagnostic);
});

for (const kind of ["denied", "unavailable", "recovery-required"]) {
  test(`main returns unsuccessfully for ${kind} without retry or locator disclosure`, async (t) => {
    let calls = 0;
    const input = enrollment(async (...args) => {
      calls += 1;
      assert.deepEqual(args, [input.recipient, input.startup]);
      assert.equal(args[0], input.recipient);
      assert.equal(args[1], input.startup);
      return { kind, operation: { operationRef: "retained-private-operation" } };
    });
    const f = await mainFixture(t, (...args) => {
      assert.equal(args.length, 0);
      return input;
    });
    await f.main();
    assert.equal(calls, 1);
    assert.equal(process.exitCode, 1);
    assert.equal(f.output, diagnostic);
  });
}

test("main keeps pending start owned until its producer returns a joined result", async (t) => {
  const start = deferred();
  const f = await mainFixture(t, () => enrollment(() => start.promise));
  let settled = false;
  const running = f.main().then(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(settled, false);
  assert.equal(f.output, "");
  start.resolve({ kind: "unavailable" });
  await running;
  assert.equal(process.exitCode, 1);
});

test("main awaits mandatory owner close without requesting shutdown after started", async (t) => {
  const closed = deferred();
  let closes = 0;
  let calls = 0;
  const input = enrollment(async () => {
    calls += 1;
    return {
      kind: "started",
      lifetime: {
        closed: closed.promise,
        close() {
          closes += 1;
          throw new Error("main must not request close");
        },
      },
    };
  });
  const f = await mainFixture(t, () => input);
  let settled = false;
  const running = f.main().then(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(settled, false);
  assert.equal(closes, 0);
  assert.equal(calls, 1);
  closed.resolve({ cleanup: "finished", termination: "unknown" });
  await running;
  assert.equal(closes, 0);
  assert.equal(process.exitCode, undefined);
  assert.equal(f.output, "");
});

for (const cleanup of ["failed", "unknown"]) {
  test(`main preserves ${cleanup} cleanup as unsuccessful local completion`, async (t) => {
    const f = await mainFixture(t, () =>
      enrollment(async () => ({
        kind: "started",
        lifetime: {
          closed: Promise.resolve({ cleanup, termination: "unknown" }),
        },
      })),
    );
    await f.main();
    assert.equal(process.exitCode, 1);
    assert.equal(f.output, diagnostic);
  });
}

test("main rejects absent close joins and unsupported termination claims", async (t) => {
  for (const closed of [
    undefined,
    { cleanup: "finished", termination: "unknown" },
    Promise.resolve({ cleanup: "finished", termination: "terminated" }),
  ]) {
    await t.test("invalid owner result", async (child) => {
      const f = await mainFixture(child, () =>
        enrollment(async () => ({ kind: "started", lifetime: { closed } })),
      );
      await f.main();
      assert.equal(process.exitCode, 1);
      assert.equal(f.output, diagnostic);
    });
  }
});

test("main observes rejected start and close without disclosing original errors", async (t) => {
  for (const stage of ["start", "close"]) {
    await t.test(stage, async (child) => {
      const f = await mainFixture(child, () =>
        enrollment(async () => {
          if (stage === "start") throw new Error("private-start-detail");
          return {
            kind: "started",
            lifetime: { closed: Promise.reject(new Error("private-close-detail")) },
          };
        }),
      );
      await f.main();
      assert.equal(process.exitCode, 1);
      assert.equal(f.output, diagnostic);
    });
  }
});

// Preparation tests never invoke a provider, native factory, listening socket or
// policy-positive owner. These inputs borrow only controlled module close peers.
function compositionFixture() {
  const refuse = () => {
    throw new Error("FIXTURE_DEPENDENCY_UNAVAILABLE");
  };
  const modules = ["identity", "harness", "persistence"].map((kind) => ({
    id: kind,
    kind,
    profileRef: `${kind}-profile`,
    start: async () => refuse(),
    close: async () => {},
  }));
  const selected = [
    ...modules.map(({ id, kind, profileRef }) => ({
      id,
      kind,
      profileRef,
      requiredCapabilities: [kind],
    })),
    {
      id: "slack",
      kind: "channel",
      profileRef: "slack-private-mentioned-v1",
      requiredCapabilities: ["slack.hosted-transport"],
    },
    {
      id: "teams",
      kind: "channel",
      profileRef: "teams-standard-mentioned-v1",
      requiredCapabilities: ["msteams.hosted-listener"],
    },
  ];
  const profile = {
    schemaVersion: 1,
    normalizationVersion: 1,
    configurationVersion: 1,
    installationRef: "installation-a",
    channelRef: "channel-a",
  };
  const input = {
    configuration: {
      schemaVersion: 1,
      installationRef: "installation-a",
      namespaceRef: "namespace-a",
      agentRef: "agent-a",
      admittedRevisionRef: "revision-a",
      gatewayAssignmentRef: "assignment-a",
      runtimeGeneration: 3,
      nativeConfigRef: "config-a",
      nativeConfigJson: "{}",
      configDigest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      statePaths: {
        root: "/gateway-state",
        gatewayPrivate: "/gateway-state/private",
        workspace: "/gateway-state/workspace",
        sessionProjection: "/gateway-state/session",
      },
      stateSchemaVersion: 15,
      agentSchemaVersion: 19,
      protocolVersion: 4,
      modules: selected,
      startupDeadlineMs: 1000,
      shutdownDeadlineMs: 1000,
    },
    dependencies: {
      modules,
      authorizeOperation: async () => refuse(),
      consumeAttempt: async () => refuse(),
      reauthorizeOutput: async () => refuse(),
    },
    slack: {
      id: "slack",
      receiver: {
        receive: async () => ({
          kind: "denied",
          reason: "unavailable",
          responsibility: { kind: "not-responsible" },
        }),
      },
      options: {
        profile: {
          ...profile,
          adapterProfileRef: "slack-private-mentioned-v1",
          channelInstallationRef: "slack-a",
          providerTenantRef: "TEXAMPLE",
          recipientAppRef: "AEXAMPLE",
        },
        botUserId: "UEXAMPLE",
        botToken: "xoxb-fixture-no-network",
        appToken: "xapp-fixture-no-network",
        assertCurrent: refuse,
        authorizeOutput: async () => false,
      },
    },
    teams: {
      id: "teams",
      listener: { host: "127.0.0.1", port: 3978 },
      ingress: {
        profile: {
          ...profile,
          adapterProfileRef: "teams-standard-mentioned-v1",
          channelInstallationRef: "teams-a",
          providerTenantRef: "11111111-1111-4111-8111-111111111111",
          recipientAppRef: "22222222-2222-4222-8222-222222222222",
        },
        teamRef: "team-a",
        serviceUrl: "https://smba.trafficmanager.net/emea",
        messagingEndpoint: "/api/messages",
        credentialRef: "credential-a",
        getBotToken: async () => refuse(),
        authority: {
          resolveHuman: async () => null,
          resolveConversation: async () => null,
          assertCurrent: refuse,
          readClock: refuse,
        },
        resolveReply: async () => null,
        admission: {
          installationRef: "installation-a",
          agentRef: "agent-a",
          assignmentRef: "assignment-a",
          runtimeGeneration: 3,
          assertCurrent: refuse,
          admit: async () => ({ kind: "not-responsible", reason: "unavailable" }),
          consumeAttempt: async () => false,
          reauthorizeOutput: async () => false,
          isCompletionCommitted: async () => false,
          reserveDelivery: async () => ({ kind: "denied" }),
          recordDelivery: async () => false,
          authorizeCancel: async () => false,
          commitCancellation: async () => ({ kind: "denied" }),
        },
      },
    },
  };
  const ready = deferred();
  const host = {
    configuration: input.configuration,
    startupSettled: ready.promise,
    status: () => ({ phase: "starting", runtimeGeneration: 3, admittedRevisionRef: "revision-a" }),
    quiesce() {},
    close: async () => ({ cleanup: "unknown", termination: "unknown" }),
  };
  let starts = 0;
  const factories = {
    host() {
      starts += 1;
      return host;
    },
    slack: refuse,
    teams: refuse,
  };
  return {
    input,
    factories,
    host,
    ready,
    modules,
    get starts() {
      return starts;
    },
  };
}

test("explicit no-channel preparation contains only the original core modules and owns their cleanup", async () => {
  const f = compositionFixture();
  f.input.slack = null;
  f.input.teams = null;
  f.input.configuration.modules = f.input.configuration.modules.filter(
    (module) => module.kind !== "channel",
  );
  const closed = [];
  for (const module of f.modules)
    module.close = async () => {
      closed.push(module.id);
    };
  let calls = 0;
  f.factories.slack = () => {
    calls++;
    throw Error("No selected Slack channel");
  };
  f.factories.teams = () => {
    calls++;
    throw Error("No selected Teams channel");
  };
  const prepared = createGatewayComposition(f.input, f.factories);
  assert.equal(prepared.slack, null);
  assert.deepEqual(await prepared.close(), { cleanup: "finished" });
  assert.deepEqual(closed, ["identity", "harness", "persistence"]);
  assert.equal(calls, 0);
  assert.equal(f.starts, 0, "This is preparation/cleanup evidence, never positive host readiness");
});

test("no-channel preparation cannot drop an admitted channel or a required core owner", () => {
  const f = compositionFixture();
  f.input.slack = null;
  f.input.teams = null;
  assert.throws(() => createGatewayComposition(f.input, f.factories), /unavailable/);
  f.input.configuration.modules = f.input.configuration.modules.filter(
    (module) => module.kind !== "channel",
  );
  f.input.dependencies.modules.pop();
  assert.throws(() => createGatewayComposition(f.input, f.factories), /unavailable/);
});

test("prepared upstream host retains its channel requirement after local no-channel preparation", async () => {
  const { startGatewayHostV1 } = await import(
    gatewayRequire.resolve("openclaw/plugin-sdk/gateway-host")
  );
  const f = compositionFixture();
  f.input.slack = null;
  f.input.teams = null;
  f.input.configuration.modules = f.input.configuration.modules.filter(
    (module) => module.kind !== "channel",
  );
  const prepared = createGatewayComposition(f.input, { ...f.factories, host: startGatewayHostV1 });
  try {
    // TODO(no-channel SDK): replace this refusal with actual host lifecycle coverage
    // when the reviewed upstream host permits the complete core-only module set.
    // Its minimum of four modules rejects the three core owners before the
    // separate required-channel check, process reservation or module startup.
    assert.throws(() => prepared.start(), /INVALID_CONFIG/);
  } finally {
    assert.deepEqual(await prepared.close(), { cleanup: "finished" });
  }
});

test("prepared close prevents synchronous start and joins every original module once", async () => {
  const f = compositionFixture();
  const pending = deferred();
  const calls = [];
  f.modules.forEach((module, index) => {
    module.close = () => {
      calls.push(module.id);
      return index === 0 ? pending.promise : Promise.resolve();
    };
  });
  const prepared = createGatewayComposition(f.input, f.factories);
  const close = prepared.close();
  assert.equal(close, prepared.close());
  assert.throws(() => prepared.start(), /unavailable/);
  let settled = false;
  void close.then(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(settled, false);
  assert.deepEqual(calls, ["identity", "harness", "persistence"]);
  pending.resolve();
  assert.deepEqual(await close, { cleanup: "finished" });
  assert.equal(f.starts, 0);
});

test("prepared cleanup failure still joins other modules and retains the failed result", async () => {
  const f = compositionFixture();
  const pending = deferred();
  f.modules[0].close = () => {
    throw new Error("private-close-detail");
  };
  f.modules[1].close = () => pending.promise;
  const prepared = createGatewayComposition(f.input, f.factories);
  const close = prepared.close();
  let settled = false;
  void close.then(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(settled, false);
  pending.resolve();
  assert.deepEqual(await close, { cleanup: "failed" });
  assert.equal(close, prepared.close());
});

test("synchronous host is returned before readiness and owns subsequent module cleanup", async () => {
  const f = compositionFixture();
  let moduleCloses = 0;
  let hostCloses = 0;
  for (const module of f.modules)
    module.close = async () => {
      moduleCloses += 1;
    };
  f.host.close = async () => {
    hostCloses += 1;
    return { cleanup: "unknown", termination: "unknown" };
  };
  const prepared = createGatewayComposition(f.input, f.factories);
  assert.equal(prepared.start(), f.host);
  assert.equal(f.starts, 1);
  assert.throws(() => prepared.start(), /unavailable/);
  const close = prepared.close();
  assert.deepEqual(await close, { cleanup: "unknown" });
  assert.equal(close, prepared.close());
  assert.equal(hostCloses, 1);
  assert.equal(moduleCloses, 0);
  // Pending startupSettled remains the Runtime owner's join; this wrapper neither
  // awaits it before close nor claims that local close proves process termination.
  f.ready.resolve(f.host.status());
});

test("a synchronous host factory failure leaves constructed modules owned by preparation", async () => {
  const f = compositionFixture();
  let closes = 0;
  for (const module of f.modules)
    module.close = async () => {
      closes += 1;
    };
  f.factories.host = () => {
    throw new Error("synthetic-host-construction-failure");
  };
  const prepared = createGatewayComposition(f.input, f.factories);
  assert.throws(() => prepared.start(), /synthetic-host/);
  assert.deepEqual(await prepared.close(), { cleanup: "finished" });
  assert.equal(closes, 3);
});

test("fixed preparation resolves only the three selected public factories without starting them", async (t) => {
  const f = compositionFixture();
  let nativeCalls = 0;
  const refuseNative = () => {
    nativeCalls += 1;
    throw new Error("native execution is not selected");
  };
  // Controlled module exports exercise the real fixed loader and composition;
  // they do not qualify the installed factory or any native provider.
  t.mock.module(gatewayRequire.resolve("openclaw/plugin-sdk/gateway-host"), {
    namedExports: { startGatewayHostV1: f.factories.host },
  });
  t.mock.module(gatewayRequire.resolve("openclaw/plugin-sdk/slack-hosted"), {
    namedExports: { createSlackHostedAdapterV1: refuseNative },
  });
  t.mock.module(gatewayRequire.resolve("openclaw/plugin-sdk/msteams-hosted"), {
    namedExports: { createMSTeamsHostedIngress: refuseNative },
  });
  const prepared = await prepareGatewayComposition(f.input);
  assert.equal(f.starts, 0);
  assert.equal(nativeCalls, 0);
  assert.equal(prepared.start(), f.host);
  assert.equal(f.starts, 1);
  assert.equal(nativeCalls, 0);
  assert.deepEqual(await prepared.close(), { cleanup: "unknown" });
  f.ready.resolve(f.host.status());
});
