import assert from "node:assert/strict";
import { mock, test } from "node:test";

// COMPONENT ONLY. The real protected assembler is exercised against explicitly
// controlled Runtime, Work-adapter and unused material construction boundaries.
// These cases create no genuine native admission, State readset, grant, token,
// provider invocation or committed release. Run with module mocks enabled only
// in a separately selected receiving environment; authoring is not execution.
const source = "../../packages/occ/src/";
const url = (path) => new URL(source + path, import.meta.url).href;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
const denied = () => {
  throw new Error("controlled refusal");
};
let constructing;
class ControlledCrypto {}
class ControlledStore {
  assertSeparateKeySource(value) {
    assert.ok(value instanceof ControlledCrypto);
  }
}
class ControlledCustody {
  constructor() {
    throw new Error("Wrapper cases must not construct token custody");
  }
}
class ControlledError extends Error {}

class ControlledRuntime {
  constructor(options) {
    this.control = constructing;
    const c = this.control;
    c.runtime = this;
    c.runtimeConstructions++;
    assert.equal(options.native, c.rawSource);
    assert.equal(options.assignments, c.assignments);
    this.raw = options.native;
    this.pending = new Set();
    const recognizer = {
      recognize(origin, call) {
        assert.equal(this, recognizer);
        c.member(origin, call);
        c.events.push("recognize-full");
        if (!c.fullCurrent) denied();
        return c.raw;
      },
      recognizeNative(origin, call) {
        assert.equal(this, recognizer);
        c.member(origin, call);
        c.events.push("recognize-native");
        return c.recognizedRaw ?? c.raw;
      },
    };
    c.recognizer = recognizer;
    if (c.missing === "recognizeNative") delete recognizer.recognizeNative;
    if (c.missing === "recognize") delete recognizer.recognize;
    options.nativeCustody.bindOrigins(recognizer);
    if (c.bindTwice) options.nativeCustody.bindOrigins(recognizer);
    if (c.missing === "inspectNative") this.inspectNative = undefined;
    if (c.missing === "assertNativeCurrent") this.assertNativeCurrent = undefined;
  }
  async acquire(request, call) {
    const c = this.control;
    assert.equal(this, c.runtime);
    c.events.push("runtime-acquire");
    c.calls.add(call);
    c.opening = request;
    return c.origin;
  }
  async inspect(origin, call) {
    const c = this.control;
    assert.equal(this, c.runtime);
    c.member(origin, call);
    c.events.push("inspect-full");
    if (!c.fullCurrent) denied();
    return c.binding;
  }
  inspectNative(origin, call) {
    const c = this.control;
    assert.equal(this, c.runtime);
    assert.equal(origin, c.origin);
    assert.equal(call, c.freshCall);
    c.events.push("inspect-native-enter");
    c.nativeEntered.resolve();
    const pending = (async () => {
      if (c.nativeGate) await c.nativeGate.promise;
      if (call.signal.aborted || c.retired) denied();
      c.calls.add(call);
      c.events.push("inspect-native-complete");
      return c.nextBinding ?? c.binding;
    })();
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }
  assertNativeCurrent(origin, call) {
    const c = this.control;
    assert.equal(this, c.runtime);
    c.member(origin, call);
    c.events.push("assert-native");
  }
  assertCurrent(origin, call) {
    const c = this.control;
    assert.equal(this, c.runtime);
    c.member(origin, call);
    c.events.push("assert-full");
    if (!c.fullCurrent) denied();
  }
  async release(origin) {
    const c = this.control;
    assert.equal(this, c.runtime);
    assert.equal(origin, c.origin);
    await Promise.allSettled([...this.pending]);
    if (!c.retired) {
      c.retired = true;
      await this.raw.release(c.raw);
    }
  }
  close() {
    return this.release(this.control.origin);
  }
}
class ControlledAdapter {
  constructor(binding, native, selection, tokens, milliseconds, options) {
    const c = constructing;
    c.adapterConstructions++;
    assert.equal(binding, c.bindingSource);
    assert.equal(milliseconds, 1000);
    assert.equal(options.native, c.rawSource);
    c.adapterNative = native;
    c.adapterSelection = selection;
    c.custodySource = tokens.source;
    this.inventory = Object.freeze({});
    this.state = {
      async prepare(origin, request, call) {
        assert.equal(this, c.adapterState);
        assert.equal(origin, c.origin);
        assert.equal(call, c.freshCall);
        return c.prepare ? c.prepare(native, selection, origin, request, call) : undefined;
      },
      readPreparationOriginal: denied,
      readCurrent: denied,
      commitDispatch: denied,
      inspectCommitted: denied,
      async settle() {
        throw new Error("No preparation is issued by these controls");
      },
    };
    c.adapterState = this.state;
  }
}
mock.module(url("runtime-authority/repository-work-origin-v2.ts"), {
  namedExports: { RepositoryWorkOriginOwnerV2: ControlledRuntime },
});
mock.module(url("lifecycle/repository-work-state-v2.ts"), {
  namedExports: { RepositoryWorkStateAdapterV2: ControlledAdapter },
});
mock.module(url("credential-custody-v1/protected-github-crypto.ts"), {
  namedExports: {
    ProtectedGitHubCryptoV1: ControlledCrypto,
    ProtectedGitHubCustodyErrorV1: ControlledError,
  },
});
mock.module(url("credential-custody-v1/protected-github-token-store.ts"), {
  namedExports: { ProtectedGitHubTokenStoreV1: ControlledStore },
});
mock.module(url("credential-custody-v1/protected-github-token-custody.ts"), {
  namedExports: { ProtectedGitHubTokenCustodyV1: ControlledCustody },
});
const { createProtectedGitHubRepositorySourcesV2 } = await import(
  url("credential-custody-v1/protected-github-repository-work.ts")
);

function control(changes = {}) {
  const context = Object.freeze({});
  const c = {
    origin: Object.freeze({}),
    raw: Object.freeze({}),
    selected: Object.freeze({}),
    context,
    calls: new Set(),
    fullCurrent: true,
    retired: false,
    events: [],
    runtimeConstructions: 0,
    adapterConstructions: 0,
    rawReleases: 0,
    nativeEntered: deferred(),
    handoffEntered: deferred(),
    binding: Object.freeze({
      context,
      transportBinding: Object.freeze({}),
      attachmentRef: "attachment/1",
      receiverRef: "receiver/1",
      execution: Object.freeze({ executionRef: "execution/1" }),
      service: Object.freeze({ principalId: "service/1" }),
    }),
    ...changes,
  };
  c.member = (origin, call) => {
    assert.equal(origin, c.origin);
    assert.equal(call.context, context);
    if (!c.calls.has(call) || call.signal.aborted || c.retired) denied();
  };
  c.call = (seconds) => {
    const abort = new AbortController();
    return {
      abort,
      value: Object.freeze({
        context,
        requestRef: "request/1",
        recipientRef: "receiver/1",
        deadline: new Date(Date.now() + seconds * 1000).toISOString(),
        signal: abort.signal,
      }),
    };
  };
  c.first = c.call(30);
  c.fresh = c.call(20);
  c.freshCall = c.fresh.value;
  c.rawSource = {
    acquire: denied,
    async inspect(raw, call) {
      assert.equal(this, c.rawSource);
      assert.equal(raw, c.raw);
      assert.equal(call, c.first.value);
      return Object.freeze({ sessionRef: "github-native/controlled" });
    },
    assertCurrent(raw, call) {
      assert.equal(this, c.rawSource);
      assert.equal(raw, c.raw);
      c.member(c.origin, call);
    },
    async release(raw) {
      assert.equal(this, c.rawSource);
      assert.equal(raw, c.raw);
      c.rawReleases++;
    },
    prepareCommittedToken: denied,
    writePreparedCommittedToken: denied,
  };
  c.assignments = Object.freeze({});
  c.bindingSource = { participant: { assertOriginal: denied } };
  c.selection = {
    async acquire(origin, request, call) {
      assert.equal(this, c.selection);
      assert.equal(origin, c.origin);
      assert.equal(call, c.freshCall);
      return c.selected;
    },
    inspect: denied,
    async prepareStateUse(selected, origin, call) {
      assert.equal(this, c.selection);
      assert.equal(selected, c.selected);
      assert.equal(origin, c.origin);
      assert.equal(call, c.freshCall);
      c.events.push("prepare-state-use-enter");
      c.fullCurrent = false;
      c.handoffEntered.resolve();
      if (c.handoffGate) await c.handoffGate.promise;
      if (call.signal.aborted) denied();
      c.events.push("prepare-state-use-complete");
    },
    retainPolicy: denied,
    retainObservation: denied,
    observationCall: denied,
    async release(selected) {
      assert.equal(this, c.selection);
      assert.equal(selected, c.selected);
      c.events.push("selection-release");
    },
  };
  if (c.missing === "prepareStateUse") delete c.selection.prepareStateUse;
  c.options = {
    binding: c.bindingSource,
    native: c.rawSource,
    assignments: c.assignments,
    trust: {},
    originLimits: {},
    selection: c.selection,
    key: { clientId: "client", bindingRef: "binding/1", immutableVersion: "version/1" },
    material: { withJwt: denied },
    crypto: new ControlledCrypto(),
    store: new ControlledStore(),
    endpoint: {},
    transactionMilliseconds: 1000,
    maximumResponsibilities: 2,
    clock: {
      read: () => ({ wallMs: Date.now(), monotonicMs: performance.now(), uncertaintyMs: 1 }),
    },
  };
  c.build = () => {
    constructing = c;
    try {
      return (c.sources = createProtectedGitHubRepositorySourcesV2(c.options));
    } finally {
      constructing = undefined;
    }
  };
  c.open = async () => {
    const origin = await c.sources.native.acquire(
      Object.freeze({
        version: 2,
        method: "open-read",
        request_ref: "request/1",
      }),
      c.first.value,
    );
    assert.equal(origin, c.origin);
    assert.notEqual(origin, c.raw);
    c.events.length = 0;
  };
  return c;
}
async function cleanup(c) {
  c.nativeGate?.resolve();
  c.handoffGate?.resolve();
  await c.sources?.close().catch(() => {});
}

test("COMPONENT ONLY: captures exact fresh-RPC and handoff receivers before source properties change", async () => {
  const c = control();
  c.build();
  try {
    await c.open();
    c.first.abort.abort();
    c.runtime.inspectNative = denied;
    c.runtime.assertNativeCurrent = denied;
    c.selection.prepareStateUse = denied;
    c.recognizer.recognizeNative = denied;
    c.fullCurrent = false;
    const observed = await c.sources.native.inspectNative(c.origin, c.freshCall);
    assert.equal(observed, c.binding);
    c.sources.native.assertNativeCurrent(c.origin, c.freshCall);
    await c.adapterSelection.prepareStateUse(c.selected, c.origin, c.freshCall);
    assert.deepEqual(c.events, [
      "inspect-native-enter",
      "inspect-native-complete",
      "recognize-native",
      "assert-native",
      "prepare-state-use-enter",
      "prepare-state-use-complete",
    ]);
    assert.equal("recognizeNative" in c.sources, false);
    assert.equal("bindOrigins" in c.sources, false);
  } finally {
    await cleanup(c);
  }
});

test("COMPONENT ONLY: native-only correspondence refuses changed raw session and retained association", async () => {
  for (const change of [
    (c) => {
      c.recognizedRaw = {};
    },
    (c) => {
      c.nextBinding = { ...c.binding, context: {} };
    },
    (c) => {
      c.nextBinding = { ...c.binding, transportBinding: {} };
    },
    (c) => {
      c.nextBinding = { ...c.binding, attachmentRef: "other" };
    },
    (c) => {
      c.nextBinding = { ...c.binding, execution: { executionRef: "changed" } };
    },
    (c) => {
      c.nextBinding = { ...c.binding, receiverRef: "other" };
    },
    (c) => {
      c.nextBinding = { ...c.binding, service: { principalId: "other" } };
    },
  ]) {
    const c = control();
    c.build();
    try {
      await c.open();
      c.fullCurrent = false;
      change(c);
      await assert.rejects(c.sources.native.inspectNative(c.origin, c.freshCall));
      assert.equal(c.events.includes("inspect-full"), false);
      assert.equal(c.events.includes("recognize-full"), false);
      assert.equal(c.events.includes("assert-full"), false);
    } finally {
      await cleanup(c);
    }
  }
});

test("COMPONENT ONLY: pre-unit forwarding uses native-only methods and keeps full fences after completion", async () => {
  const c = control();
  c.build();
  try {
    await c.open();
    c.prepare = async (native, selection, origin, request, call) => {
      await native.inspectNative(origin, call);
      const selected = await selection.acquire(origin, request, call);
      native.assertNativeCurrent(origin, call);
      await selection.prepareStateUse(selected, origin, call);
      native.assertNativeCurrent(origin, call);
      assert.throws(() => native.assertCurrent(origin, call));
      assert.equal(c.events.includes("inspect-full"), false);
      assert.equal(c.events.includes("recognize-full"), false);
      // Controlled completion only; this flag is not an actual State readset.
      c.events.push("controlled-unit-complete");
      c.fullCurrent = true;
      native.assertCurrent(origin, call);
      return undefined;
    };
    assert.equal(await c.sources.state.prepare(c.origin, {}, c.freshCall), undefined);
    assert.deepEqual(c.events.slice(-2), ["controlled-unit-complete", "assert-full"]);
  } finally {
    await cleanup(c);
  }
});

test("COMPONENT ONLY: missing mandatory hooks and repeated binder enrollment refuse construction", () => {
  for (const missing of [
    "prepareStateUse",
    "inspectNative",
    "assertNativeCurrent",
    "recognizeNative",
    "recognize",
  ]) {
    const c = control({ missing });
    assert.throws(c.build);
    assert.equal(c.adapterConstructions, 0);
    if (missing === "prepareStateUse") assert.equal(c.runtimeConstructions, 0);
    assert.equal(c.rawReleases, 0);
  }
  assert.throws(control({ bindTwice: true }).build);
});

test("COMPONENT ONLY: fresh calls require native RPC enrollment; foreign origins never become raw sessions", async () => {
  const c = control();
  c.build();
  try {
    await c.open();
    assert.throws(() => c.sources.native.assertNativeCurrent(c.origin, c.freshCall));
    assert.throws(() => c.sources.native.inspectNative(c.raw, c.freshCall));
    assert.throws(() => c.sources.native.inspectNative({}, c.freshCall));
    assert.equal(c.events.includes("inspect-native-enter"), false);
  } finally {
    await cleanup(c);
  }
});

test("COMPONENT ONLY: aborted native authentication stays joined through close and only Runtime retires raw N", async () => {
  const c = control({ nativeGate: deferred() });
  c.build();
  try {
    await c.open();
    const pending = c.sources.native.inspectNative(c.origin, c.freshCall);
    const refused = assert.rejects(pending);
    await c.nativeEntered.promise;
    c.fresh.abort.abort();
    let done = false;
    const closed = c.sources.close();
    assert.equal(c.sources.close(), closed);
    const closedRefusal = assert.rejects(closed).finally(() => {
      done = true;
    });
    await turn();
    assert.equal(done, false);
    assert.equal(c.rawReleases, 0);
    c.nativeGate.resolve();
    await refused;
    await closedRefusal;
    assert.equal(c.rawReleases, 1);
    assert.equal(c.events.includes("recognize-native"), false);
  } finally {
    await cleanup(c);
  }
});

test("COMPONENT ONLY: delayed handoff refusal remains joined before original selection cleanup and shutdown", async () => {
  const c = control({ handoffGate: deferred() });
  c.build();
  try {
    await c.open();
    c.prepare = async (native, selection, origin, request, call) => {
      await native.inspectNative(origin, call);
      const selected = await selection.acquire(origin, request, call);
      try {
        await selection.prepareStateUse(selected, origin, call);
        throw new Error("Aborted handoff must not complete");
      } finally {
        await selection.release(selected);
      }
    };
    const refused = assert.rejects(c.sources.state.prepare(c.origin, {}, c.freshCall));
    await c.handoffEntered.promise;
    c.fresh.abort.abort();
    let closed = false;
    const closing = assert.rejects(c.sources.close()).finally(() => {
      closed = true;
    });
    await turn();
    assert.equal(closed, false);
    assert.equal(c.events.includes("selection-release"), false);
    c.handoffGate.resolve();
    await refused;
    await closing;
    assert.equal(c.events.includes("selection-release"), true);
    assert.equal(c.events.includes("prepare-state-use-complete"), false);
    assert.equal(c.rawReleases, 1);
  } finally {
    await cleanup(c);
  }
});

test("COMPONENT ONLY: metadata constructor refuses a Git request before Runtime acquisition", async () => {
  const c = control();
  c.build();
  try {
    assert.throws(() => c.sources.native.acquire({ version: 3 }, c.first.value));
    assert.equal(c.events.includes("runtime-acquire"), false);
  } finally {
    await cleanup(c);
  }
});
