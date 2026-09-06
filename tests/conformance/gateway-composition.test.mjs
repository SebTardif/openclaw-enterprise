import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Server } from "node:http";
import test from "node:test";
import { createSlackGatewayModule } from "../../apps/gateway/src/channels/slack.ts";
import { createTeamsGatewayModule } from "../../apps/gateway/src/channels/teams.ts";
import { createGatewayComposition } from "../../apps/gateway/src/composition.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function hostConfiguration() {
  return {
    schemaVersion: 1,
    installationRef: "installation-a",
    namespaceRef: "namespace-a",
    agentRef: "agent-a",
    admittedRevisionRef: "revision-a",
    gatewayAssignmentRef: "assignment-a",
    runtimeGeneration: 1,
    nativeConfigRef: "native-config-a",
    nativeConfigJson: "{}",
    configDigest: `sha256:${createHash("sha256").update("{}").digest("hex")}`,
    statePaths: {
      root: "/gateway-state",
      gatewayPrivate: "/gateway-state/private",
      workspace: "/gateway-state/workspace",
      sessionProjection: "/gateway-state/session",
    },
    stateSchemaVersion: 15,
    agentSchemaVersion: 19,
    protocolVersion: 4,
    modules: [
      {
        id: "identity",
        kind: "identity",
        profileRef: "identity-profile",
        requiredCapabilities: ["identity"],
      },
      {
        id: "slack-channel",
        kind: "channel",
        profileRef: "slack-private-mentioned-v1",
        requiredCapabilities: ["slack.hosted-transport"],
      },
      {
        id: "teams-channel",
        kind: "channel",
        profileRef: "teams-standard-mentioned-v1",
        requiredCapabilities: ["msteams.hosted-listener"],
      },
      {
        id: "harness",
        kind: "harness",
        profileRef: "harness-profile",
        requiredCapabilities: ["harness"],
      },
      {
        id: "persistence",
        kind: "persistence",
        profileRef: "persistence-profile",
        requiredCapabilities: ["persistence"],
      },
    ],
    startupDeadlineMs: 1000,
    shutdownDeadlineMs: 1000,
  };
}

// Controlled native lifecycle only: these tests exercise the real module wrapper,
// without establishing Slack authentication, receipts, transport or serving authority.
function slackFixture(profileChange = {}) {
  const completion = deferred();
  const abort = new AbortController();
  let options;
  let calls = 0;
  let unavailable = 0;
  let fences = 0;
  let received;
  let signal;
  const receiver = {
    receive: async () => ({
      kind: "denied",
      reason: "unavailable",
      responsibility: { kind: "not-responsible" },
    }),
  };
  const input = {
    id: "slack-channel",
    receiver,
    options: {
      profile: {
        schemaVersion: 1,
        adapterProfileRef: "slack-private-mentioned-v1",
        normalizationVersion: 1,
        configurationVersion: 1,
        installationRef: "installation-a",
        channelInstallationRef: "slack-installation-a",
        providerTenantRef: "TEXAMPLE",
        recipientAppRef: "AEXAMPLE",
        channelRef: "CEXAMPLE",
        ...profileChange,
      },
      botUserId: "UEXAMPLE",
      botToken: "xoxb-fixture-no-network",
      appToken: "xapp-fixture-no-network",
      assertCurrent() {
        fences += 1;
      },
      authorizeOutput: async () => false,
    },
  };
  const bound = createSlackGatewayModule(input, (value) => {
    options = value;
    calls += 1;
    return {
      run(next, nextSignal) {
        received = next;
        signal = nextSignal;
        return completion.promise;
      },
      inspect: async () => null,
      inspectNonTurn: async () => null,
      deliver: async () => {
        throw new Error("No native delivery selected");
      },
      update: async () => {
        throw new Error("No native delivery selected");
      },
    };
  });
  const context = {
    configuration: hostConfiguration(),
    signal: abort.signal,
    assertCurrent() {
      fences += 1;
    },
    unavailable() {
      unavailable += 1;
    },
  };
  return {
    bound,
    input,
    context,
    completion,
    abort,
    health(value) {
      options.onHealth(value);
    },
    get calls() {
      return calls;
    },
    get unavailable() {
      return unavailable;
    },
    get fences() {
      return fences;
    },
    get received() {
      return received;
    },
    get signal() {
      return signal;
    },
    async finish() {
      const close = bound.module.close();
      if (options) options.onHealth({ state: "stopped" });
      completion.resolve();
      await close;
    },
  };
}

test("Slack native ports are unavailable before module start", () => {
  const f = slackFixture();
  assert.throws(() => f.bound.native.inspect({}, new AbortController().signal), /unavailable/);
  assert.equal(f.calls, 0);
});

test("Slack rejects a different Installation before constructing native resources", async () => {
  const f = slackFixture({ installationRef: "installation-b" });
  await assert.rejects(f.bound.module.start(f.context), /unavailable/);
  assert.equal(f.calls, 0);
  await f.finish();
});

test("Slack readiness follows connected health and preserves the exact receiver", async () => {
  const f = slackFixture();
  const start = f.bound.module.start(f.context);
  let ready = false;
  void start.then(() => {
    ready = true;
  });
  f.health({ state: "connecting" });
  await Promise.resolve();
  assert.equal(ready, false);
  f.health({ state: "connected" });
  assert.deepEqual(await start, { capabilities: ["slack.hosted-transport"] });
  assert.equal(f.calls, 1);
  assert.equal(f.received, f.input.receiver);
  assert.ok(f.fences >= 4);
  await f.finish();
});

test("Slack cancellation rejects pending startup and joins native completion", async () => {
  const f = slackFixture();
  const start = f.bound.module.start(f.context);
  f.abort.abort();
  await assert.rejects(start, /unavailable/);
  assert.equal(f.signal.aborted, true);
  let closed = false;
  const close = f.bound.module.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  f.health({ state: "stopped" });
  f.completion.resolve();
  await close;
});

test("Slack cancellation after connected health still rejects pending start continuation", async () => {
  const f = slackFixture();
  const start = f.bound.module.start(f.context);
  f.health({ state: "connected" });
  f.abort.abort();
  await assert.rejects(start, /unavailable/);
  await f.finish();
});

test("Slack close after connected health cannot publish late readiness", async () => {
  const f = slackFixture();
  const start = f.bound.module.start(f.context);
  f.health({ state: "connected" });
  const close = f.bound.module.close();
  await assert.rejects(start, /unavailable/);
  f.health({ state: "stopped" });
  f.completion.resolve();
  await close;
});

test("Slack close retains retired host receipts after transport run settles", async () => {
  const f = slackFixture();
  const start = f.bound.module.start(f.context);
  f.health({ state: "connected" });
  await start;
  const close = f.bound.module.close();
  assert.equal(close, f.bound.module.close());
  let closed = false;
  void close.then(() => {
    closed = true;
  });
  f.health({ state: "retired", pendingReceipts: 1, reason: "receipt" });
  f.completion.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(closed, false);
  f.health({ state: "stopped" });
  await close;
  assert.equal(closed, true);
});

test("Slack termination removes readiness and fences retained native ports", async () => {
  const f = slackFixture();
  const start = f.bound.module.start(f.context);
  f.health({ state: "connected" });
  await start;
  f.health({ state: "stopped" });
  f.completion.resolve();
  await Promise.resolve();
  assert.ok(f.unavailable >= 1);
  assert.throws(() => f.bound.native.inspect({}, new AbortController().signal));
  await f.finish();
});

test("Slack recovery after readiness cannot restore the host generation", async () => {
  const f = slackFixture();
  const start = f.bound.module.start(f.context);
  f.health({ state: "recovering", reason: "transport" });
  assert.equal(f.unavailable, 0);
  f.health({ state: "connected" });
  await start;
  f.health({ state: "recovering", reason: "transport" });
  assert.ok(f.unavailable >= 1);
  assert.equal(f.signal.aborted, true);
  f.health({ state: "connected" });
  assert.throws(() => f.bound.native.inspect({}, new AbortController().signal));
  await f.finish();
});

test("Slack per-event blocked health is not transport termination", async () => {
  const f = slackFixture();
  const start = f.bound.module.start(f.context);
  f.health({ state: "connected" });
  await start;
  f.health({ state: "blocked", reason: "receipt" });
  assert.equal(f.unavailable, 0);
  assert.equal(f.signal.aborted, false);
  await f.finish();
});

test("Slack module starts once and cannot restart after close", async () => {
  const f = slackFixture();
  const start = f.bound.module.start(f.context);
  f.health({ state: "connected" });
  await start;
  await assert.rejects(f.bound.module.start(f.context), /unavailable/);
  await f.finish();
  await assert.rejects(f.bound.module.start(f.context), /unavailable/);
  assert.equal(f.calls, 1);
});

test("Slack missing terminal cleanup evidence does not report successful close", async () => {
  const f = slackFixture();
  const start = f.bound.module.start(f.context);
  f.health({ state: "connected" });
  await start;
  f.completion.resolve();
  await assert.rejects(f.bound.module.close(), /unavailable/);
});

test("Slack preserves a failed readiness-loss notification as failed cleanup", async () => {
  const f = slackFixture();
  f.context.unavailable = () => {
    throw new Error("private-owner-diagnostic");
  };
  const start = f.bound.module.start(f.context);
  f.health({ state: "connected" });
  await start;
  f.health({ state: "stopped" });
  f.completion.resolve();
  await assert.rejects(f.bound.module.close(), /^Error: Hosted Slack module unavailable$/);
});

test("Slack retained ports suppress producer diagnostic details on failed currentness", async () => {
  const f = slackFixture();
  const start = f.bound.module.start(f.context);
  f.health({ state: "connected" });
  await start;
  f.context.assertCurrent = () => {
    throw new Error("private-owner-diagnostic");
  };
  assert.throws(
    () => f.bound.native.inspect({}, new AbortController().signal),
    /^Error: Hosted Slack module unavailable$/,
  );
  await f.finish();
});

function teamsInput() {
  const unavailable = () => {
    throw new Error("FIXTURE_AUTHORITY_UNAVAILABLE");
  };
  return {
    id: "teams-channel",
    listener: { port: 3978, host: "127.0.0.1" },
    ingress: {
      profile: {
        schemaVersion: 1,
        adapterProfileRef: "teams-standard-mentioned-v1",
        normalizationVersion: 1,
        configurationVersion: 1,
        installationRef: "installation-a",
        channelInstallationRef: "teams-installation-a",
        providerTenantRef: "11111111-1111-4111-8111-111111111111",
        recipientAppRef: "22222222-2222-4222-8222-222222222222",
        channelRef: "channel-fixture",
      },
      teamRef: "team-fixture",
      serviceUrl: "https://smba.trafficmanager.net/emea",
      messagingEndpoint: "/api/messages",
      credentialRef: "credential-fixture",
      getBotToken: async () => unavailable(),
      authority: {
        resolveHuman: async () => null,
        resolveConversation: async () => null,
        assertCurrent: unavailable,
        readClock: unavailable,
      },
      resolveReply: async () => null,
      admission: {
        installationRef: "installation-a",
        agentRef: "agent-a",
        assignmentRef: "assignment-a",
        runtimeGeneration: 1,
        assertCurrent: unavailable,
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
  };
}

// A controlled listener peer, never an opened HTTP socket or Teams SDK instance.
class ListenerPeer extends Server {
  simulatedListening = false;
  get listening() {
    return this.simulatedListening;
  }
  set listening(value) {
    this.simulatedListening = value;
  }
  closes = 0;
  closeError;
  close(callback) {
    this.closes += 1;
    if (!this.closeError) {
      this.listening = false;
      this.emit("close");
    }
    callback(this.closeError);
    return this;
  }
}

function teamsFixture(input = teamsInput(), hooks = {}) {
  const construction = deferred();
  const listening = deferred();
  const enteredFactory = deferred();
  const enteredListen = deferred();
  const server = new ListenerPeer();
  const abort = new AbortController();
  let options;
  let factories = 0;
  let listens = 0;
  let closes = 0;
  let unavailable = 0;
  let nativeClose;
  const native = {
    app: undefined,
    listen(port, host) {
      listens += 1;
      enteredListen.resolve({ port, host });
      hooks.onListen?.();
      return listening.promise;
    },
    close() {
      if (!nativeClose) {
        closes += 1;
        nativeClose = new Promise((resolve, reject) => {
          if (server.listening) server.close((error) => (error ? reject(error) : resolve()));
          else resolve();
        });
      }
      return nativeClose;
    },
  };
  const module = createTeamsGatewayModule(input, (value) => {
    factories += 1;
    options = value;
    enteredFactory.resolve();
    hooks.onFactory?.();
    return construction.promise;
  });
  const context = {
    configuration: hostConfiguration(),
    signal: abort.signal,
    assertCurrent() {
      abort.signal.throwIfAborted();
      hooks.onFence?.();
    },
    unavailable() {
      unavailable += 1;
    },
  };
  return {
    module,
    input,
    native,
    context,
    server,
    abort,
    construction,
    listening,
    enteredFactory: enteredFactory.promise,
    enteredListen: enteredListen.promise,
    get factories() {
      return factories;
    },
    get listens() {
      return listens;
    },
    get closes() {
      return closes;
    },
    get unavailable() {
      return unavailable;
    },
    get options() {
      return options;
    },
    async ready() {
      const start = module.start(context);
      await enteredFactory.promise;
      construction.resolve(native);
      await enteredListen.promise;
      server.listening = true;
      listening.resolve(server);
      await start;
    },
  };
}

test("Teams rejects profile and Installation mismatch before factory construction", async () => {
  for (const profileChange of [
    { installationRef: "installation-b" },
    { adapterProfileRef: "slack-private-mentioned-v1" },
  ]) {
    const input = teamsInput();
    Object.assign(input.ingress.profile, profileChange);
    const f = teamsFixture(input);
    await assert.rejects(f.module.start(f.context), /DEPENDENCY_UNAVAILABLE/);
    assert.equal(f.factories, 0);
    await f.module.close();
  }
});

test("Teams readiness follows the actual wrapper's owned listen completion", async () => {
  const f = teamsFixture();
  const start = f.module.start(f.context);
  let ready = false;
  void start.then(() => {
    ready = true;
  });
  await f.enteredFactory;
  f.construction.resolve(f.native);
  assert.deepEqual(await f.enteredListen, f.input.listener);
  assert.equal(ready, false);
  f.server.listening = true;
  f.listening.resolve(f.server);
  assert.deepEqual(await start, { capabilities: ["msteams.hosted-listener"] });
  assert.equal(f.factories, 1);
  assert.equal(f.listens, 1);
  await f.module.close();
  assert.equal(f.server.closes, 1);
  assert.equal(f.server.listenerCount("error"), 0);
});

test("Teams close owns an ingress returned after factory cancellation", async () => {
  const f = teamsFixture();
  const start = f.module.start(f.context);
  await f.enteredFactory;
  f.abort.abort();
  const close = f.module.close();
  let closed = false;
  void close.then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  f.construction.resolve(f.native);
  await assert.rejects(start, /DEPENDENCY_UNAVAILABLE/);
  await close;
  assert.equal(f.closes, 1);
  assert.equal(f.listens, 0);
});

test("Teams closes a server that opens after memoized native close completed", async () => {
  const f = teamsFixture();
  const start = f.module.start(f.context);
  await f.enteredFactory;
  f.construction.resolve(f.native);
  await f.enteredListen;
  const close = f.module.close();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.closes, 1);
  assert.equal(f.server.closes, 0);
  // Native close already saw a non-listening server. Only the wrapper owns this late result.
  f.server.listening = true;
  f.listening.resolve(f.server);
  await assert.rejects(start, /DEPENDENCY_UNAVAILABLE/);
  await close;
  assert.equal(f.server.closes, 1);
  assert.equal(f.server.listening, false);
});

test("Teams synchronous factory cancellation retains the late construction result", async () => {
  let f;
  f = teamsFixture(teamsInput(), {
    onFactory() {
      f.abort.abort();
    },
  });
  const start = f.module.start(f.context);
  await f.enteredFactory;
  assert.equal(f.abort.signal.aborted, true);
  f.construction.resolve(f.native);
  await assert.rejects(start, /DEPENDENCY_UNAVAILABLE/);
  await f.module.close();
  assert.equal(f.closes, 1);
  assert.equal(f.listens, 0);
});

test("Teams synchronous listen cancellation still closes its returned server", async () => {
  let f;
  f = teamsFixture(teamsInput(), {
    onListen() {
      f.abort.abort();
    },
  });
  const start = f.module.start(f.context);
  await f.enteredFactory;
  f.construction.resolve(f.native);
  await f.enteredListen;
  f.server.listening = true;
  f.listening.resolve(f.server);
  await assert.rejects(start, /DEPENDENCY_UNAVAILABLE/);
  await f.module.close();
  assert.equal(f.server.listening, false);
  assert.ok(f.server.closes >= 1);
});

test("Teams cancellation inside the local fence prevents factory acquisition", async () => {
  let f;
  f = teamsFixture(teamsInput(), {
    onFence() {
      f.abort.abort();
    },
  });
  await assert.rejects(f.module.start(f.context), /DEPENDENCY_UNAVAILABLE/);
  await f.module.close();
  assert.equal(f.factories, 0);
});

test("Teams factory and listen rejection settle startup with one owned cleanup join", async () => {
  for (const stage of ["factory", "listen"]) {
    const f = teamsFixture();
    const start = f.module.start(f.context);
    await f.enteredFactory;
    if (stage === "factory") f.construction.reject(new Error("private-factory-diagnostic"));
    else {
      f.construction.resolve(f.native);
      await f.enteredListen;
      f.listening.reject(new Error("private-listener-diagnostic"));
    }
    await assert.rejects(start, /^Error: DEPENDENCY_UNAVAILABLE$/);
    const close = f.module.close();
    assert.equal(close, f.module.close());
    await close;
    assert.equal(f.closes, stage === "factory" ? 0 : 1);
  }
});

test("Teams close before start and an already-aborted host avoid acquisition", async () => {
  for (const stage of ["closed", "aborted"]) {
    const f = teamsFixture();
    if (stage === "closed") await f.module.close();
    else f.abort.abort();
    await assert.rejects(f.module.start(f.context), /DEPENDENCY_UNAVAILABLE/);
    await f.module.close();
    assert.equal(f.factories, 0);
  }
});

test("Teams concurrent duplicate start cannot create a second factory", async () => {
  const f = teamsFixture();
  const first = f.module.start(f.context);
  await f.enteredFactory;
  await assert.rejects(f.module.start(f.context), /DEPENDENCY_UNAVAILABLE/);
  f.abort.abort();
  f.construction.resolve(f.native);
  await assert.rejects(first, /DEPENDENCY_UNAVAILABLE/);
  await f.module.close();
  assert.equal(f.factories, 1);
  assert.equal(f.closes, 1);
});

test("Teams unexpected listener loss removes readiness without allowing restart", async () => {
  const f = teamsFixture();
  await f.ready();
  f.server.listening = false;
  f.server.emit("close");
  await f.module.close();
  assert.equal(f.unavailable, 1);
  await assert.rejects(f.module.start(f.context), /DEPENDENCY_UNAVAILABLE/);
  assert.equal(f.factories, 1);
});

test("Teams cleanup failure remains the same rejected close join", async () => {
  const f = teamsFixture();
  await f.ready();
  f.server.closeError = new Error("synthetic-close-failure");
  const close = f.module.close();
  assert.equal(close, f.module.close());
  await assert.rejects(close, /^Error: DEPENDENCY_UNAVAILABLE$/);
  await assert.rejects(f.module.close(), /^Error: DEPENDENCY_UNAVAILABLE$/);
});

test("Teams listener error fences readiness even if its unavailable observer throws", async () => {
  const f = teamsFixture();
  await f.ready();
  f.context.unavailable = () => {
    throw new Error("private-owner-diagnostic");
  };
  f.server.emit("error", new Error("private-server-diagnostic"));
  await assert.rejects(f.module.close(), /^Error: DEPENDENCY_UNAVAILABLE$/);
  assert.equal(f.server.listening, false);
  assert.throws(() => f.options.authority.assertCurrent(), /DEPENDENCY_UNAVAILABLE/);
});

test("Teams retained callbacks preserve producer denial and close fences", async () => {
  const f = teamsFixture();
  await f.ready();
  assert.throws(() => f.options.authority.assertCurrent(), /FIXTURE_AUTHORITY_UNAVAILABLE/);
  assert.throws(() => f.options.admission.assertCurrent(), /FIXTURE_AUTHORITY_UNAVAILABLE/);
  await f.module.close();
  assert.throws(() => f.options.authority.assertCurrent(), /DEPENDENCY_UNAVAILABLE/);
  assert.throws(() => f.options.admission.assertCurrent(), /DEPENDENCY_UNAVAILABLE/);
  await assert.rejects(
    f.options.getBotToken(credentialRequest(f.input), new AbortController().signal),
    /DEPENDENCY_UNAVAILABLE/,
  );
});

function credentialRequest(input) {
  return {
    credentialRef: input.ingress.credentialRef,
    appId: input.ingress.profile.recipientAppRef,
    tenantId: input.ingress.profile.providerTenantRef,
    scope: "https://api.botframework.com/.default",
  };
}

test("Teams credential resolution canceled while pending cannot return late material", async () => {
  const token = deferred();
  let receivedSignal;
  let receivedRequest;
  const input = teamsInput();
  input.ingress.getBotToken = async (request, signal) => {
    receivedRequest = request;
    receivedSignal = signal;
    return token.promise;
  };
  const f = teamsFixture(input);
  await f.ready();
  const request = credentialRequest(input);
  const result = f.options.getBotToken(request, new AbortController().signal);
  assert.equal(receivedRequest, request);
  const close = f.module.close();
  assert.equal(receivedSignal.aborted, true);
  token.resolve("synthetic-unusable-credential");
  await assert.rejects(result);
  await close;
});

function compositionFixture() {
  const unavailable = () => {
    throw new Error("FIXTURE_DEPENDENCY_UNAVAILABLE");
  };
  const configuration = hostConfiguration();
  const modules = ["identity", "harness", "persistence"].map((kind) => ({
    id: kind,
    kind,
    profileRef: `${kind}-profile`,
    start: async () => unavailable(),
    close: async () => {},
  }));
  const input = {
    configuration,
    dependencies: {
      modules,
      authorizeOperation: async () => unavailable(),
      consumeAttempt: async () => unavailable(),
      reauthorizeOutput: async () => unavailable(),
    },
    slack: slackFixture().input,
    teams: teamsInput(),
  };
  let call;
  let calls = 0;
  const factories = {
    host(config, dependencies) {
      calls += 1;
      call = { config, dependencies };
      const status = {
        phase: "failed",
        code: "MISSING_DEPENDENCY",
        runtimeGeneration: config.runtimeGeneration,
        admittedRevisionRef: config.admittedRevisionRef,
      };
      return {
        configuration: config,
        status: () => status,
        startupSettled: Promise.resolve(status),
        quiesce() {},
        close: async () => ({ cleanup: "unknown", termination: "unknown" }),
      };
    },
    slack: unavailable,
    teams: unavailable,
  };
  return {
    input,
    factories,
    get call() {
      return call;
    },
    get calls() {
      return calls;
    },
  };
}

test("Composition preserves admitted order and exact existing policy hooks without native startup", () => {
  const f = compositionFixture();
  const composition = createGatewayComposition(f.input, f.factories);
  assert.equal(f.calls, 0);
  composition.start();
  assert.equal(f.calls, 1);
  assert.deepEqual(
    f.call.dependencies.modules.map((module) => module.id),
    f.input.configuration.modules.map((module) => module.id),
  );
  for (const name of ["authorizeOperation", "consumeAttempt", "reauthorizeOutput"]) {
    assert.equal(f.call.dependencies[name], f.input.dependencies[name]);
  }
  assert.throws(() => composition.start(), /unavailable/);
});

test("Composition rejects missing, duplicate and mismatched module owners", () => {
  for (const mutate of [
    (input) => input.dependencies.modules.pop(),
    (input) => {
      input.dependencies.modules[1] = input.dependencies.modules[0];
    },
    (input) => {
      input.configuration.modules[0].profileRef = "different-profile";
    },
    (input) => {
      input.configuration.modules[1].id = input.configuration.modules[0].id;
    },
    (input) => {
      input.dependencies.authorizeOperation = undefined;
    },
  ]) {
    const f = compositionFixture();
    mutate(f.input);
    assert.throws(() => createGatewayComposition(f.input, f.factories), /unavailable/);
    assert.equal(f.calls, 0);
  }
});

test("Composition snapshots admitted data and the selected host factory before start", () => {
  const f = compositionFixture();
  const composition = createGatewayComposition(f.input, f.factories);
  f.input.configuration.installationRef = "installation-b";
  f.input.configuration.modules.reverse();
  f.factories.host = () => {
    throw new Error("replaced-factory");
  };
  composition.start();
  assert.equal(f.call.config.installationRef, "installation-a");
  assert.equal(f.call.dependencies.modules[0].id, "identity");
});
