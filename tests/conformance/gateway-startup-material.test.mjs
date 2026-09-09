import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createGatewayStartupMaterialBorrowerV1,
  inspectGatewayMaterialInputV1,
} from "../../apps/gateway/src/startup-material.ts";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
const signal = () => new AbortController().signal;
const request = {
  credentialRef: "teams-token",
  appId: "teams-app",
  tenantId: "tenant",
  scope: "https://api.botframework.com/.default",
};
function fixture() {
  const events = [];
  const parent = new AbortController();
  const sourceSignal = new AbortController();
  const profile = (name) => ({
    installationRef: "installation",
    adapterProfileRef: name,
    recipientAppRef: name === "slack" ? "slack-app" : "teams-app",
    providerTenantRef: "tenant",
  });
  const modules = ["identity", "harness", "persistence"].map((kind) => ({
    id: kind,
    kind,
    profileRef: kind,
    requiredCapabilities: [kind],
  }));
  modules.push(
    { id: "slack", kind: "channel", profileRef: "slack", requiredCapabilities: ["channel"] },
    { id: "teams", kind: "channel", profileRef: "teams", requiredCapabilities: ["channel"] },
  );
  const binding = {
    startup: {
      installationId: "installation",
      processRef: "process",
      processGeneration: 1,
      operationRef: "operation",
      operationDigest: "digest",
    },
    createEffectRef: "effect",
    selection: { recordRef: "selection", recordVersion: 1 },
    configurationRef: "config",
    configurationVersion: 1,
    profileRef: "profile",
    profileVersion: 1,
    namespaceRef: "namespace",
    agentRef: "agent",
    admittedRevisionRef: "revision",
    gatewayAssignmentRef: "assignment",
    hostRuntimeGeneration: 1,
    nativeConfigRef: "native",
    configDigest: `sha256:${createHash("sha256").update("{}").digest("hex")}`,
    stateOwnership: { recordRef: "paths", recordVersion: 1 },
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    protocolVersion: 1,
    modules,
    startupDeadlineMs: 5000,
    shutdownDeadlineMs: 5000,
  };
  const statePaths = {
    root: "/controlled",
    gatewayPrivate: "/controlled/private",
    workspace: "/controlled/work",
    sessionProjection: "/controlled/session",
  };
  const selected = {
    binding,
    recipientRef: "recipient",
    recipientIncarnation: "incarnation",
    statePaths,
    slack: {
      moduleId: "slack",
      profile: profile("slack"),
      botUserId: "bot",
      botCredential: { ref: "slack-bot", version: 1 },
      appCredential: { ref: "slack-app", version: 1 },
    },
    teams: {
      moduleId: "teams",
      profile: profile("teams"),
      credential: { ref: "teams-token", version: 1 },
      teamRef: "team",
      serviceUrl: "https://controlled.invalid",
      messagingEndpoint: "/messages",
      listener: { port: 10000, host: "127.0.0.1" },
    },
  };
  const noop = () => undefined;
  const asyncNoop = async () => undefined;
  const input = {
    configuration: {
      schemaVersion: 1,
      installationRef: "installation",
      namespaceRef: binding.namespaceRef,
      agentRef: binding.agentRef,
      admittedRevisionRef: binding.admittedRevisionRef,
      gatewayAssignmentRef: binding.gatewayAssignmentRef,
      runtimeGeneration: binding.hostRuntimeGeneration,
      nativeConfigRef: binding.nativeConfigRef,
      nativeConfigJson: "{}",
      configDigest: binding.configDigest,
      statePaths,
      stateSchemaVersion: 1,
      agentSchemaVersion: 1,
      protocolVersion: 1,
      modules,
      startupDeadlineMs: 5000,
      shutdownDeadlineMs: 5000,
    },
    dependencies: {
      modules: modules.slice(0, 3).map((m) => ({ ...m, start: asyncNoop, close: asyncNoop })),
      authorizeOperation: asyncNoop,
      consumeAttempt: asyncNoop,
      reauthorizeOutput: asyncNoop,
    },
    slack: {
      id: "slack",
      options: {
        profile: selected.slack.profile,
        botUserId: "bot",
        botToken: "synthetic-bot",
        appToken: "synthetic-app",
        assertCurrent: noop,
        authorizeOutput: async () => false,
      },
      receiver: { receive: asyncNoop },
    },
    teams: {
      id: "teams",
      listener: selected.teams.listener,
      ingress: {
        profile: selected.teams.profile,
        credentialRef: "teams-token",
        teamRef: "team",
        serviceUrl: selected.teams.serviceUrl,
        messagingEndpoint: "/messages",
        getBotToken: async () => {
          events.push("token");
          return "synthetic-token";
        },
        resolveReply: asyncNoop,
        authority: {
          assertCurrent: noop,
          resolveHuman: asyncNoop,
          resolveConversation: asyncNoop,
          readClock: noop,
        },
        admission: {
          assertCurrent: noop,
          admit: asyncNoop,
          consumeAttempt: asyncNoop,
          reauthorizeOutput: asyncNoop,
          isCompletionCommitted: asyncNoop,
          reserveDelivery: asyncNoop,
          recordDelivery: asyncNoop,
          authorizeCancel: asyncNoop,
          commitCancellation: asyncNoop,
        },
      },
    },
  };
  let startupMs = 5000;
  let sourceMs = 5000;
  let current = true;
  const fence = () => {
    if (!current) throw new Error("private currentness");
  };
  const lease = {
    signal: sourceSignal.signal,
    observed: structuredClone(selected),
    input,
    assertCurrent: fence,
    remainingMs: () => sourceMs,
    async release() {
      events.push("release");
      return { cleanup: "finished" };
    },
  };
  const owner = {
    signal: parent.signal,
    assertCurrent: fence,
    remainingStartupMs: () => startupMs,
    async joinConsumers() {
      events.push("settled");
    },
  };
  const source = {
    assertCurrent: fence,
    remainingMs: () => sourceMs,
    async acquire() {
      events.push("acquire");
      return lease;
    },
  };
  return {
    events,
    parent,
    sourceSignal,
    selected,
    input,
    lease,
    owner,
    source,
    setCurrent(v) {
      current = v;
    },
    setStartup(v) {
      startupMs = v;
    },
    setSource(v) {
      sourceMs = v;
    },
  };
}
const reject = (promise) =>
  assert.rejects(promise, (error) => error.message === "Gateway startup material unavailable");

function selectChannels(f, channels) {
  for (const channel of ["slack", "teams"]) {
    if (!channels.includes(channel)) {
      f.selected[channel] = null;
      f.input[channel] = null;
    }
  }
  f.selected.binding.modules = f.selected.binding.modules.filter(
    (module) => module.kind !== "channel" || channels.includes(module.id),
  );
  f.input.configuration.modules = structuredClone(f.selected.binding.modules);
  f.lease.observed = structuredClone(f.selected);
}

for (const channels of [[], ["slack"], ["teams"]]) {
  test(`explicit selected channels ${JSON.stringify(channels)} preserve original material ownership`, async () => {
    const f = fixture();
    selectChannels(f, channels);
    const joined = deferred();
    f.owner.joinConsumers = () => joined.promise;
    const borrower = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
    const material = await borrower.borrowMaterial();
    assert.equal(material.input.slack === null, !channels.includes("slack"));
    assert.equal(material.input.teams === null, !channels.includes("teams"));
    assert.deepEqual(
      material.input.configuration.modules.map((module) => module.kind),
      ["identity", "harness", "persistence", ...channels.map(() => "channel")],
    );
    assert.deepEqual(f.events, ["acquire"], "Borrowing retains one original source acquisition");
    f.parent.abort();
    assert.throws(() => material.assertCurrent(), /unavailable/);
    const close = material.close();
    await Promise.resolve();
    assert.deepEqual(f.events, ["acquire"], "Core consumers still own the source until their join");
    joined.resolve();
    assert.equal(await close, "finished");
    assert.deepEqual(f.events, ["acquire", "release"]);
  });
}

for (const change of [
  (f) => {
    f.input.slack = undefined;
  },
  (f) => {
    f.selected.teams = undefined;
    f.lease.observed.teams = undefined;
  },
  (f) => {
    f.selected.binding.modules.push({
      id: "slack",
      kind: "channel",
      profileRef: "slack",
      requiredCapabilities: [],
    });
    f.input.configuration.modules = structuredClone(f.selected.binding.modules);
    f.lease.observed = structuredClone(f.selected);
  },
  (f) => {
    f.input.dependencies.modules.pop();
  },
  (f) => {
    f.input.dependencies.authorizeOperation = undefined;
  },
]) {
  test("explicit no-channel material still refuses missing or mismatched original selections/owners", () => {
    const f = fixture();
    selectChannels(f, []);
    change(f);
    assert.throws(
      () => inspectGatewayMaterialInputV1(f.selected, f.lease.observed, f.input),
      /unavailable/,
    );
  });
}

test("a selected channel still requires its complete material when the other channel is absent", () => {
  for (const [channel, change] of [
    [
      "slack",
      (f) => {
        f.input.slack.options.botToken = "";
      },
    ],
    [
      "slack",
      (f) => {
        f.input.slack.options.profile = {
          ...f.input.slack.options.profile,
          installationRef: "other",
        };
      },
    ],
    [
      "teams",
      (f) => {
        f.input.teams.ingress.credentialRef = "other";
      },
    ],
    [
      "teams",
      (f) => {
        f.input.teams.ingress.getBotToken = undefined;
      },
    ],
    [
      "slack",
      (f) => {
        f.input.slack = null;
      },
    ],
    [
      "teams",
      (f) => {
        f.input.teams = null;
      },
    ],
  ]) {
    const f = fixture();
    selectChannels(f, [channel]);
    change(f);
    assert.throws(
      () => inspectGatewayMaterialInputV1(f.selected, f.lease.observed, f.input),
      /unavailable/,
    );
  }
});

test("one borrower snapshots data, preserves original callbacks and releases only after consumer settlement", async () => {
  const f = fixture();
  const joined = deferred();
  f.owner.joinConsumers = () => joined.promise;
  const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
  const material = await owner.borrowMaterial();
  await reject(owner.borrowMaterial());
  f.input.configuration.statePaths.root = "/changed";
  assert.equal(material.input.configuration.statePaths.root, "/controlled");
  assert.equal(material.input.slack.options.botToken, "synthetic-bot");
  assert.equal(
    await material.input.teams.ingress.getBotToken(request, signal()),
    "synthetic-token",
  );
  const close = material.close();
  assert.equal(close, owner.close());
  await Promise.resolve();
  assert.deepEqual(f.events, ["acquire", "token"]);
  joined.resolve();
  assert.equal(await close, "finished");
  assert.equal(f.events.at(-1), "release");
  assert.throws(material.assertCurrent, /material unavailable/);
});

test("complete selected binding, path, immutable version and module correspondence are required", () => {
  for (const change of [
    (f) => {
      f.lease.observed.binding.startup.processGeneration++;
    },
    (f) => {
      f.lease.observed.slack.botCredential.version++;
    },
    (f) => {
      f.input.configuration.configDigest = "sha256:wrong";
    },
    (f) => {
      f.input.configuration.statePaths = { ...f.selected.statePaths, root: "/other" };
    },
    (f) => {
      f.input.dependencies.modules[0].id = "other";
    },
    (f) => {
      f.input.slack.options.profile = { ...f.selected.slack.profile, installationRef: "other" };
    },
    (f) => {
      f.input.teams.ingress.credentialRef = "other";
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(
      () => inspectGatewayMaterialInputV1(f.selected, f.lease.observed, f.input),
      /material unavailable/,
    );
  }
});

test("pre-existing owner denial and expired source/startup prevent physical acquisition", async () => {
  for (const change of [
    (f) => f.setCurrent(false),
    (f) => f.setSource(0),
    (f) => f.setStartup(0),
    (f) => f.parent.abort(),
  ]) {
    const f = fixture();
    change(f);
    const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
    await reject(owner.borrowMaterial());
    await owner.close();
    assert.equal(f.events.includes("acquire"), false);
  }
});

test("minimum original acquisition deadline refuses but retains and cleans a late source lease", async () => {
  const f = fixture();
  const late = deferred();
  f.setStartup(5);
  f.source.acquire = () => late.promise;
  const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
  await reject(owner.borrowMaterial());
  const closing = owner.close();
  let complete = false;
  void closing.then(() => {
    complete = true;
  });
  await Promise.resolve();
  assert.equal(complete, false);
  late.resolve(f.lease);
  assert.equal(await closing, "finished");
  assert.equal(f.events.filter((e) => e === "release").length, 1);
});

test("source withdrawal prevents retained Slack fences and Teams token delivery", async () => {
  const f = fixture();
  const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
  const material = await owner.borrowMaterial();
  f.sourceSignal.abort();
  assert.throws(material.input.slack.options.assertCurrent, /material unavailable/);
  await reject(material.input.teams.ingress.getBotToken(request, signal()));
  assert.equal(f.events.includes("token"), false);
  await owner.close();
});

test("token callback has exact target, no cache, no parallel queue and rechecks after await", async () => {
  const f = fixture();
  const token = deferred();
  let entered = deferred();
  let calls = 0;
  f.input.teams.ingress.getBotToken = async () => {
    calls++;
    entered.resolve();
    return token.promise;
  };
  const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
  const material = await owner.borrowMaterial();
  const get = material.input.teams.ingress.getBotToken;
  await reject(get({ ...request, scope: "wrong" }, signal()));
  assert.equal(calls, 0);
  const first = get(request, signal());
  await entered.promise;
  await reject(get(request, signal()));
  assert.equal(calls, 1);
  f.setCurrent(false);
  token.resolve("synthetic-late-token");
  await reject(first);
  await owner.close();
});

test("callback failure and invalid tokens expose only constant error", async () => {
  for (const value of ["", "bad\0token", "\ud800", "\udc00", "x".repeat(32769)]) {
    const f = fixture();
    f.input.teams.ingress.getBotToken = async () => value;
    const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
    const material = await owner.borrowMaterial();
    await reject(material.input.teams.ingress.getBotToken(request, signal()));
    await owner.close();
  }
  const f = fixture();
  f.input.teams.ingress.getBotToken = async () => {
    throw new Error("private provider response");
  };
  const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
  const material = await owner.borrowMaterial();
  await reject(material.input.teams.ingress.getBotToken(request, signal()));
  await owner.close();
});

test("valid surrogate pairs retain their values and UTF-8 byte counts", async () => {
  for (const value of ["\ud800\udc00", "\ud83d\ude00", "\udbff\udfff"]) {
    const f = fixture();
    f.input.slack.options.botToken = value;
    f.input.slack.options.appToken = value;
    f.input.teams.ingress.getBotToken = async () => value;
    assert.equal(
      inspectGatewayMaterialInputV1(f.selected, f.lease.observed, f.input).slackMaterialBytes,
      8,
    );
    const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
    try {
      const material = await owner.borrowMaterial();
      assert.equal(material.input.slack.options.botToken, value);
      assert.equal(material.input.slack.options.appToken, value);
      assert.equal(await material.input.teams.ingress.getBotToken(request, signal()), value);
    } finally {
      await owner.close();
    }
  }
});

test("UTF-8 item and live owned bundle bounds deny without truncation", async () => {
  const f = fixture();
  f.input.slack.options.botToken = "x".repeat(32768);
  f.input.slack.options.appToken = "y".repeat(32768);
  const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
  const material = await owner.borrowMaterial();
  await reject(material.input.teams.ingress.getBotToken(request, signal()));
  await owner.close();
  const other = fixture();
  other.input.slack.options.botToken = "é".repeat(16385);
  assert.throws(
    () => inspectGatewayMaterialInputV1(other.selected, other.lease.observed, other.input),
    /material unavailable/,
  );
});

test("unknown consumer settlement cannot release already borrowed material", async () => {
  for (const join of [
    async () => {
      throw new Error("private unfinished consumer");
    },
    async () => true,
  ]) {
    const f = fixture();
    f.owner.joinConsumers = join;
    const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
    await owner.borrowMaterial();
    assert.equal(await owner.close(), "unknown");
    assert.equal(f.events.includes("release"), false);
  }
});

test("close joins an in-flight token callback after original consumers settle", async () => {
  const f = fixture();
  const token = deferred();
  const entered = deferred();
  f.input.teams.ingress.getBotToken = async () => {
    entered.resolve();
    return token.promise;
  };
  const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
  const material = await owner.borrowMaterial();
  const pending = material.input.teams.ingress.getBotToken(request, signal());
  const rejected = reject(pending);
  await entered.promise;
  const closing = owner.close();
  await Promise.resolve();
  assert.equal(f.events.includes("release"), false);
  token.resolve("synthetic-late-token");
  await rejected;
  assert.equal(await closing, "finished");
  assert.equal(f.events.at(-1), "release");
});

test("sequential token requests consult the original supplier each time", async () => {
  const f = fixture();
  let calls = 0;
  f.input.teams.ingress.getBotToken = async () => `synthetic-${++calls}`;
  const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
  const material = await owner.borrowMaterial();
  assert.equal(await material.input.teams.ingress.getBotToken(request, signal()), "synthetic-1");
  assert.equal(await material.input.teams.ingress.getBotToken(request, signal()), "synthetic-2");
  assert.equal(calls, 2);
  await owner.close();
});

test("captured Teams fences include material withdrawal and constructor diagnostics are sanitized", async () => {
  const f = fixture();
  const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
  const material = await owner.borrowMaterial();
  f.sourceSignal.abort();
  assert.throws(material.input.teams.ingress.authority.assertCurrent, /material unavailable/);
  assert.throws(material.input.teams.ingress.admission.assertCurrent, /material unavailable/);
  await owner.close();
  const bad = {
    get assertCurrent() {
      throw new Error("private source configuration");
    },
  };
  assert.throws(
    () => createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, bad),
    (error) => error.message === "Gateway startup material unavailable",
  );
});

test("elapsed acquisition is refused even when synchronous source work delays the timer", async () => {
  const f = fixture();
  f.setStartup(3);
  f.source.acquire = async () => {
    const started = performance.now();
    while (performance.now() - started < 8) {
      /* controlled local scheduling delay */
    }
    return f.lease;
  };
  const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
  await reject(owner.borrowMaterial());
  assert.equal(await owner.close(), "finished");
  assert.equal(f.events.filter((event) => event === "release").length, 1);
});

test("all declared original callbacks preserve their receiver and are captured once", async () => {
  const f = fixture();
  const ingress = f.input.teams.ingress;
  const options = f.input.slack.options;
  const admission = ingress.admission;
  const native = {};
  const calls = [];
  const method = (receiver, name) =>
    function () {
      assert.equal(this, receiver);
      calls.push(name);
      return Promise.resolve();
    };
  ingress.resolveReply = method(ingress, "reply");
  options.receiveNonTurn = method(options, "non-turn");
  options.onHealth = method(options, "health");
  const required = [
    "admit",
    "consumeAttempt",
    "reauthorizeOutput",
    "isCompletionCommitted",
    "reserveDelivery",
    "recordDelivery",
    "authorizeCancel",
    "commitCancellation",
  ];
  for (const key of [...required, "onNativeEvent"]) admission[key] = method(admission, key);
  for (const key of ["dispatch", "cancel"]) native[key] = method(native, key);
  admission.native = native;
  const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
  const material = await owner.borrowMaterial();
  ingress.resolveReply = () => {
    throw new Error("replacement");
  };
  await material.input.teams.ingress.resolveReply();
  await material.input.slack.options.receiveNonTurn();
  await material.input.slack.options.onHealth();
  for (const key of [...required, "onNativeEvent"])
    await material.input.teams.ingress.admission[key]();
  await material.input.teams.ingress.admission.native.dispatch();
  await material.input.teams.ingress.admission.native.cancel();
  assert.equal(calls.length, 14);
  await owner.close();
});

test("missing required admission operations and malformed optional callbacks refuse the bundle", async () => {
  const required = [
    "admit",
    "consumeAttempt",
    "reauthorizeOutput",
    "isCompletionCommitted",
    "reserveDelivery",
    "recordDelivery",
    "authorizeCancel",
    "commitCancellation",
  ];
  for (const key of required) {
    const f = fixture();
    delete f.input.teams.ingress.admission[key];
    const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
    await reject(owner.borrowMaterial());
    assert.equal(await owner.close(), "finished");
  }
  for (const change of [
    (f) => {
      f.input.slack.options.onHealth = true;
    },
    (f) => {
      f.input.teams.ingress.admission.native = { dispatch() {} };
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(
      () => inspectGatewayMaterialInputV1(f.selected, f.lease.observed, f.input),
      /material unavailable/,
    );
  }
});

test("deferred supplier receives a frozen selected target despite caller mutation", async () => {
  const f = fixture();
  const entered = deferred();
  const continuation = deferred();
  let observed;
  f.input.teams.ingress.getBotToken = async (target) => {
    entered.resolve();
    await continuation.promise;
    observed = target;
    assert.equal(Object.isFrozen(target), true);
    return "synthetic-token";
  };
  const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
  const material = await owner.borrowMaterial();
  const caller = { ...request };
  const pending = material.input.teams.ingress.getBotToken(caller, signal());
  await entered.promise;
  caller.scope = "changed";
  caller.credentialRef = "changed";
  continuation.resolve();
  assert.equal(await pending, "synthetic-token");
  assert.deepEqual(observed, request);
  assert.notEqual(observed, caller);
  await owner.close();
});

test("malformed numeric callbacks refuse and observe rejected native promises", async () => {
  for (const where of ["owner", "source", "lease"]) {
    const f = fixture();
    const read = () => Promise.reject(new Error("private numeric source detail"));
    if (where === "owner") f.owner.remainingStartupMs = read;
    else f[where].remainingMs = read;
    const owner = createGatewayStartupMaterialBorrowerV1(f.owner, f.selected, f.source);
    await reject(owner.borrowMaterial());
    await owner.close();
  }
  await new Promise((resolve) => setImmediate(resolve));
});
