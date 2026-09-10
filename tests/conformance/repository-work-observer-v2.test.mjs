import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { pathToFileURL } from "node:url";
import { RepositoryWorkObservationOwnerV2 } from "../../packages/occ/src/lifecycle/repository-work-observer-v2.ts";

// These cases call the actual production observation owner. Declared peers
// implement only its source interface and control completion/failure timing.
// They do not prove State persistence, original State authority, SQL COMMIT,
// restart recovery, or a successful native/GitHub request.
const test = (name, body) => nodeTest(name, { timeout: 5000 }, body);
const references = (suffix = "one") => ({
  operationRef: `operation/${suffix}`,
  observationRef: `observation/${suffix}`,
  workRef: `work/${suffix}`,
});
const original = () => Object.freeze({});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function sourcePeer({
  reconcile = async () => "unavailable",
  retire = async () => undefined,
} = {}) {
  const calls = { reconcile: [], retire: [] };
  const source = {
    reconcile(handle) {
      calls.reconcile.push(handle);
      return reconcile(handle);
    },
    retire(handle) {
      calls.retire.push(handle);
      return retire(handle);
    },
  };
  return { source, calls };
}

function enrolled(peer = sourcePeer(), maximumResponsibilities = 1) {
  const owner = new RepositoryWorkObservationOwnerV2(peer.source, { maximumResponsibilities });
  const handle = original();
  owner.register(handle, references());
  owner.activate(handle);
  return { owner, handle, ...peer };
}

const summaryKeys = [
  "operationRef",
  "observationRef",
  "workRef",
  "status",
  "retirement",
  "retained",
  "retention",
  "durable",
].sort();

function assertSummary(summary, expected = {}) {
  assert.equal(Object.isFrozen(summary), true);
  assert.deepEqual(Object.keys(summary).sort(), summaryKeys);
  assert.equal(summary.retention, "process");
  assert.equal(summary.durable, false);
  for (const [key, value] of Object.entries(expected)) assert.equal(summary[key], value, key);
}

test("reservation snapshots only nonsecret references and starts no source work", async () => {
  const peer = sourcePeer();
  const owner = new RepositoryWorkObservationOwnerV2(peer.source, { maximumResponsibilities: 1 });
  const handle = Object.freeze({ privateOriginal: "must-not-appear-in-summary" });
  const info = references();
  owner.register(handle, info);
  info.operationRef = "operation/changed-after-reservation";

  const reserved = owner.inspect(handle);
  assertSummary(reserved, {
    ...references(),
    status: "reserved",
    retirement: "not-started",
    retained: true,
  });
  assert.deepEqual(await owner.join(handle), reserved);
  assert.throws(() => owner.reconcile(handle));
  assert.deepEqual(peer.calls, { reconcile: [], retire: [] });
  assert.equal(JSON.stringify(reserved).includes("must-not-appear"), false);
});

test("activation exposes a pending historical responsibility without automatically attempting it", async () => {
  const { owner, handle, calls } = enrolled();
  assertSummary(owner.inspect(handle), {
    status: "pending",
    retirement: "not-started",
    retained: true,
  });
  assertSummary(await owner.join(handle), { status: "pending", retained: true });
  await Promise.resolve();
  assert.deepEqual(calls, { reconcile: [], retire: [] });
  assert.throws(() => owner.activate(handle));
});

test("copies, summaries, proxy wrappers, and another owner's unregistered original grant no access", () => {
  const { owner, handle, calls } = enrolled();
  const otherPeer = sourcePeer();
  const other = new RepositoryWorkObservationOwnerV2(otherPeer.source, {
    maximumResponsibilities: 1,
  });
  const otherOriginal = original();
  other.register(otherOriginal, references("other"));
  other.activate(otherOriginal);
  let traps = 0;
  const wrapper = new Proxy(handle, {
    get() {
      traps += 1;
      throw new Error("A proxy must not be read to recognize an original.");
    },
    getPrototypeOf() {
      traps += 1;
      throw new Error("A proxy must not be inspected to recognize an original.");
    },
  });
  for (const copy of [
    { ...handle },
    structuredClone(handle),
    owner.inspect(handle),
    { ...references() },
    wrapper,
    otherOriginal,
  ]) {
    for (const method of ["inspect", "activate", "discard", "reconcile", "join"]) {
      assert.throws(() => owner[method](copy), undefined, method);
    }
  }
  assert.throws(() => other.inspect(handle));
  assert.throws(() => other.reconcile(handle));
  assert.equal(traps, 0);
  assert.deepEqual(calls, { reconcile: [], retire: [] });
  assert.deepEqual(otherPeer.calls, { reconcile: [], retire: [] });
});

test("discard frees only an inactive reservation and never permits original re-enrollment", () => {
  const peer = sourcePeer();
  const owner = new RepositoryWorkObservationOwnerV2(peer.source, { maximumResponsibilities: 1 });
  const discarded = original();
  owner.register(discarded, references());
  assert.throws(() => owner.register(discarded, references("duplicate")));
  owner.discard(discarded);
  assert.deepEqual(owner.inspectPending(), []);
  assert.throws(() => owner.inspect(discarded));
  assert.throws(() => owner.register(discarded, references("reuse")));
  const replacement = original();
  owner.register(replacement, references("replacement"));
  owner.activate(replacement);
  assert.throws(() => owner.discard(replacement));
  assertSummary(owner.inspect(replacement), { status: "pending", retained: true });
  assert.deepEqual(peer.calls, { reconcile: [], retire: [] });
});

test("responsibility capacity has explicit finite integer bounds", () => {
  const peer = sourcePeer();
  for (const maximumResponsibilities of [0, -1, 1.5, NaN, Infinity, 4097, "1", undefined]) {
    assert.throws(
      () => new RepositoryWorkObservationOwnerV2(peer.source, { maximumResponsibilities }),
      TypeError,
    );
  }
  for (const maximumResponsibilities of [1, 4096]) {
    const owner = new RepositoryWorkObservationOwnerV2(peer.source, { maximumResponsibilities });
    assert.deepEqual(owner.inspectPending(), []);
  }
});

test("invalid reservation data neither invokes getters nor consumes capacity or the original", () => {
  const peer = sourcePeer();
  const owner = new RepositoryWorkObservationOwnerV2(peer.source, { maximumResponsibilities: 1 });
  const handle = original();
  let reads = 0;
  const accessor = {
    ...references(),
    get operationRef() {
      reads += 1;
      throw new Error("Reference getter must not run.");
    },
  };
  const proxy = new Proxy(references(), {
    ownKeys() {
      reads += 1;
      throw new Error("Reference proxy must not run.");
    },
  });
  for (const invalid of [
    accessor,
    proxy,
    { ...references(), operationRef: "" },
    { ...references(), workRef: "w".repeat(4097) },
    { ...references(), observationRef: 7 },
    { ...references(), original: handle },
  ]) {
    assert.throws(() => owner.register(handle, invalid));
    assert.deepEqual(owner.inspectPending(), []);
  }
  assert.equal(reads, 0);
  owner.register(handle, references());
  assertSummary(owner.inspect(handle), { status: "reserved", retained: true });
});

test("a full owner retains unknown responsibility without eviction and reuses capacity only after record plus retirement", async () => {
  let result = "unavailable";
  const peer = sourcePeer({ reconcile: async () => result });
  const { owner, handle } = enrolled(peer);
  const next = original();
  assert.throws(() => owner.register(next, references("next")));
  assert.equal(await owner.reconcile(handle), "unavailable");
  assert.throws(() => owner.register(next, references("next")));
  assert.throws(() => owner.discard(handle));
  assertSummary(owner.inspect(handle), { status: "pending", retained: true });
  assert.deepEqual(peer.calls.retire, []);

  result = "recorded";
  assert.equal(await owner.reconcile(handle), "recorded");
  assertSummary(owner.inspect(handle), {
    status: "recorded",
    retirement: "retired",
    retained: false,
  });
  owner.register(next, references("next"));
  assert.deepEqual(
    owner.inspectPending().map((s) => s.operationRef),
    ["operation/next"],
  );
  assert.deepEqual(peer.calls.reconcile, [handle, handle]);
  assert.deepEqual(peer.calls.retire, [handle]);
});

test("simultaneous and synchronous reentrant reconciliations share the exact installed Promise", async () => {
  const read = deferred();
  const entered = deferred();
  let owner;
  let handle;
  let reentrant;
  const peer = sourcePeer({
    reconcile(originalHandle) {
      reentrant = owner.reconcile(originalHandle);
      entered.resolve();
      return read.promise;
    },
  });
  ({ owner, handle } = enrolled(peer));
  const first = owner.reconcile(handle);
  const simultaneous = owner.reconcile(handle);
  assert.equal(first, simultaneous);
  await entered.promise;
  assert.equal(reentrant, first);
  const joined = owner.join(handle);
  let finished = false;
  void joined.then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  assertSummary(owner.inspect(handle), { status: "reconciling", retained: true });
  read.resolve("recorded");
  assert.equal(await first, "recorded");
  assertSummary(await joined, { status: "recorded", retirement: "retired", retained: false });
  assert.deepEqual(peer.calls.reconcile, [handle]);
  assert.deepEqual(peer.calls.retire, [handle]);
});

test("a source returning its reentrant owner Promise is unavailable instead of deadlocking", async () => {
  let owner;
  const peer = sourcePeer({ reconcile: (handle) => owner.reconcile(handle) });
  const fixture = enrolled(peer);
  owner = fixture.owner;
  assert.equal(await owner.reconcile(fixture.handle), "unavailable");
  assertSummary(owner.inspect(fixture.handle), { status: "pending", retained: true });
  assert.deepEqual(peer.calls.retire, []);
});

test("unavailable finishes the current attempt and only explicit reconciliation starts a fresh source read", async () => {
  let ready = false;
  const { owner, handle, calls } = enrolled(
    sourcePeer({ reconcile: async () => (ready ? "recorded" : "unavailable") }),
  );
  const first = owner.reconcile(handle);
  assert.equal(await first, "unavailable");
  assertSummary(await owner.join(handle), { status: "pending", retained: true });
  await Promise.resolve();
  assert.deepEqual(calls.reconcile, [handle]);
  ready = true;
  const retry = owner.reconcile(handle);
  assert.notEqual(retry, first);
  assert.equal(await retry, "recorded");
  assert.deepEqual(calls.reconcile, [handle, handle]);
  assert.deepEqual(calls.retire, [handle]);
});

test("thrown and rejected raw errors are never inspected or exposed and responsibility stays pending", async () => {
  let errorReads = 0;
  const secret = new Proxy(Object.create(null), {
    get() {
      errorReads += 1;
      throw new Error("Raw error getter must not run.");
    },
    ownKeys() {
      errorReads += 1;
      throw new Error("Raw error keys must not be read.");
    },
    getPrototypeOf() {
      errorReads += 1;
      throw new Error("Raw error prototype must not be read.");
    },
  });
  let synchronous = true;
  const peer = sourcePeer({
    reconcile() {
      if (synchronous) throw secret;
      return Promise.reject(secret);
    },
  });
  const { owner, handle } = enrolled(peer);
  const before = owner.inspect(handle);
  assert.equal(await owner.reconcile(handle), "unavailable");
  synchronous = false;
  assert.equal(await owner.reconcile(handle), "unavailable");
  assert.equal(errorReads, 0);
  assertSummary(before, { status: "pending", retained: true });
  assertSummary(owner.inspect(handle), {
    status: "pending",
    retirement: "not-started",
    retained: true,
  });
  assert.deepEqual(peer.calls.reconcile, [handle, handle]);
  assert.deepEqual(peer.calls.retire, []);
});

test("malformed non-Promise or non-result source outputs cannot mark a responsibility recorded", async () => {
  let thenReads = 0;
  const thenable = {
    get then() {
      thenReads += 1;
      throw new Error("Untrusted thenable must not be assimilated.");
    },
  };
  for (const output of [undefined, "recorded", thenable, Promise.resolve({ kind: "recorded" })]) {
    const { owner, handle, calls } = enrolled(sourcePeer({ reconcile: () => output }));
    assert.equal(await owner.reconcile(handle), "unavailable");
    assertSummary(owner.inspect(handle), { status: "pending", retained: true });
    assert.deepEqual(calls.retire, []);
  }
  assert.equal(thenReads, 0);
});

test("captured source methods retain their original receiver after method and prototype replacement", async () => {
  const calls = [];
  class DeclaredSourcePeer {
    async reconcile(handle) {
      calls.push(["read", this, handle]);
      return "recorded";
    }
    async retire(handle) {
      calls.push(["retire", this, handle]);
    }
  }
  const source = new DeclaredSourcePeer();
  const owner = new RepositoryWorkObservationOwnerV2(source, { maximumResponsibilities: 1 });
  const handle = original();
  owner.register(handle, references());
  owner.activate(handle);
  let replacements = 0;
  Object.defineProperty(source, "reconcile", {
    get() {
      replacements += 1;
      throw new Error("Replaced reconcile must not be read.");
    },
  });
  Object.defineProperty(source, "retire", {
    get() {
      replacements += 1;
      throw new Error("Replaced retire must not be read.");
    },
  });
  DeclaredSourcePeer.prototype.reconcile = async () => "unavailable";
  DeclaredSourcePeer.prototype.retire = async () => {
    replacements += 1;
  };
  assert.equal(await owner.reconcile(handle), "recorded");
  assert.deepEqual(calls, [
    ["read", source, handle],
    ["retire", source, handle],
  ]);
  assert.equal(replacements, 0);
});

test("source accessors and proxies are rejected at construction without invoking them", () => {
  let reads = 0;
  const source = {
    get reconcile() {
      reads += 1;
      return async () => "recorded";
    },
    async retire() {},
  };
  assert.throws(
    () => new RepositoryWorkObservationOwnerV2(source, { maximumResponsibilities: 1 }),
    TypeError,
  );
  const proxy = new Proxy(sourcePeer().source, {
    getOwnPropertyDescriptor() {
      reads += 1;
      throw new Error("Source proxy must not be inspected.");
    },
  });
  assert.throws(
    () => new RepositoryWorkObservationOwnerV2(proxy, { maximumResponsibilities: 1 }),
    TypeError,
  );
  assert.equal(reads, 0);
});

test("a deferred source read keeps capacity occupied and rejects discard until a known result", async () => {
  const read = deferred();
  const entered = deferred();
  const { owner, handle, calls } = enrolled(
    sourcePeer({
      reconcile() {
        entered.resolve();
        return read.promise;
      },
    }),
  );
  const pending = owner.reconcile(handle);
  await entered.promise;
  assertSummary(owner.inspect(handle), { status: "reconciling", retained: true });
  assert.throws(() => owner.register(original(), references("overflow")));
  assert.throws(() => owner.discard(handle));
  assert.deepEqual(calls.retire, []);
  read.resolve("unavailable");
  assert.equal(await pending, "unavailable");
  assert.throws(() => owner.register(original(), references("still-full")));
  assertSummary(await owner.join(handle), { status: "pending", retained: true });
});

test("recorded outcome remains owned while retirement is deferred, and all in-flight callers join it", async () => {
  const retirement = deferred();
  const entered = deferred();
  const { owner, handle, calls } = enrolled(
    sourcePeer({
      reconcile: async () => "recorded",
      retire() {
        entered.resolve();
        return retirement.promise;
      },
    }),
  );
  const pending = owner.reconcile(handle);
  await entered.promise;
  const whileRetiring = owner.inspect(handle);
  assertSummary(whileRetiring, { status: "recorded", retirement: "retiring", retained: true });
  assert.equal(owner.reconcile(handle), pending);
  const joined = owner.join(handle);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.throws(() => owner.register(original(), references("overflow")));
  assert.throws(() => owner.discard(handle));
  retirement.resolve();
  assert.equal(await pending, "recorded");
  assertSummary(await joined, { status: "recorded", retirement: "retired", retained: false });
  assertSummary(whileRetiring, { status: "recorded", retirement: "retiring", retained: true });
  assert.deepEqual(calls, { reconcile: [handle], retire: [handle] });
});

test("retirement rejection latches recorded outcome and a later attempt retries retirement only", async () => {
  const firstRetirement = deferred();
  const entered = deferred();
  let retirementAttempts = 0;
  let errorReads = 0;
  const rawError = Object.create(null, {
    message: {
      get() {
        errorReads += 1;
        throw new Error("No raw retirement error reads.");
      },
    },
    stack: {
      get() {
        errorReads += 1;
        throw new Error("No raw retirement stack reads.");
      },
    },
  });
  const { owner, handle, calls } = enrolled(
    sourcePeer({
      reconcile: async () => "recorded",
      retire() {
        retirementAttempts += 1;
        if (retirementAttempts === 1) {
          entered.resolve();
          return firstRetirement.promise;
        }
        return Promise.resolve();
      },
    }),
  );
  const first = owner.reconcile(handle);
  await entered.promise;
  firstRetirement.reject(rawError);
  assert.equal(await first, "recorded");
  const failed = owner.inspect(handle);
  assertSummary(failed, { status: "recorded", retirement: "failed", retained: true });
  assert.throws(() => owner.register(original(), references("blocked")));
  assertSummary(await owner.join(handle), {
    status: "recorded",
    retirement: "failed",
    retained: true,
  });
  assert.equal(retirementAttempts, 1, "joining a failed retirement must not retry it");

  const retry = owner.reconcile(handle);
  assert.notEqual(retry, first);
  assert.equal(await retry, "recorded");
  assert.deepEqual(
    calls.reconcile,
    [handle],
    "a recorded observation must never be appended again",
  );
  assert.deepEqual(calls.retire, [handle, handle]);
  assert.equal(errorReads, 0);
  assertSummary(owner.inspect(handle), {
    status: "recorded",
    retirement: "retired",
    retained: false,
  });
  assertSummary(failed, { status: "recorded", retirement: "failed", retained: true });
  owner.register(original(), references("capacity-reused"));
});

test("a malformed retirement completion remains failed and retained instead of freeing capacity", async () => {
  let thenReads = 0;
  const malformed = {
    get then() {
      thenReads += 1;
      throw new Error("Untrusted retirement thenable must not be assimilated.");
    },
  };
  let valid = false;
  const { owner, handle, calls } = enrolled(
    sourcePeer({
      reconcile: async () => "recorded",
      retire: () => (valid ? Promise.resolve() : malformed),
    }),
  );
  assert.equal(await owner.reconcile(handle), "recorded");
  assertSummary(owner.inspect(handle), {
    status: "recorded",
    retirement: "failed",
    retained: true,
  });
  assert.throws(() => owner.register(original(), references("full")));
  valid = true;
  assert.equal(await owner.reconcile(handle), "recorded");
  assert.equal(thenReads, 0);
  assert.deepEqual(calls, { reconcile: [handle], retire: [handle, handle] });
});

test("join captures existing work and never initiates an attempt for idle pending responsibility", async () => {
  const { owner, handle, calls } = enrolled();
  const idleJoin = owner.join(handle);
  const startedLater = owner.reconcile(handle);
  assertSummary(await idleJoin, { status: "pending", retirement: "not-started", retained: true });
  assert.equal(await startedLater, "unavailable");
  for (let index = 0; index < 3; index += 1) {
    assertSummary(await owner.join(handle), { status: "pending", retained: true });
  }
  assert.deepEqual(calls, { reconcile: [handle], retire: [] });
});

test("distinct enrolled originals have independent attempts and retirement accounting", async () => {
  const firstRead = deferred();
  const firstEntered = deferred();
  const first = original();
  const second = original();
  const peer = sourcePeer({
    reconcile(handle) {
      if (handle === first) {
        firstEntered.resolve();
        return firstRead.promise;
      }
      return Promise.resolve("recorded");
    },
  });
  const owner = new RepositoryWorkObservationOwnerV2(peer.source, { maximumResponsibilities: 2 });
  owner.register(first, references("first"));
  owner.register(second, references("second"));
  owner.activate(first);
  owner.activate(second);
  const firstTask = owner.reconcile(first);
  await firstEntered.promise;
  const secondTask = owner.reconcile(second);
  assert.notEqual(firstTask, secondTask);
  assert.equal(await secondTask, "recorded");
  assertSummary(owner.inspect(first), { status: "reconciling", retained: true });
  assertSummary(owner.inspect(second), { status: "recorded", retained: false });
  assert.deepEqual(peer.calls.retire, [second]);
  firstRead.resolve("unavailable");
  assert.equal(await firstTask, "unavailable");
  assert.deepEqual(
    owner.inspectPending().map((s) => s.operationRef),
    ["operation/first"],
  );
});

test("pending inventory is a frozen bounded snapshot and cannot be used as original authority", async () => {
  const { owner, handle } = enrolled(sourcePeer({ reconcile: async () => "recorded" }), 2);
  const reserved = original();
  owner.register(reserved, references("reserved"));
  const before = owner.inspectPending();
  assert.equal(Object.isFrozen(before), true);
  assert.equal(before.length, 2);
  for (const summary of before) {
    assertSummary(summary, { retained: true });
    assert.throws(() => owner.reconcile(summary));
    assert.throws(() => {
      summary.retained = false;
    }, TypeError);
  }
  assert.throws(() => before.push(owner.inspect(handle)), TypeError);
  assert.equal(await owner.reconcile(handle), "recorded");
  owner.discard(reserved);
  assert.deepEqual(owner.inspectPending(), []);
  assert.equal(before.length, 2);
  assertSummary(before[0], { status: "pending", retained: true });
  assertSummary(before[1], { status: "reserved", retained: true });
});

test("fully retired observations remain inspectable without source replay or renewed capacity use", async () => {
  const { owner, handle, calls } = enrolled(sourcePeer({ reconcile: async () => "recorded" }));
  assert.equal(await owner.reconcile(handle), "recorded");
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await owner.reconcile(handle), "recorded");
    assertSummary(await owner.join(handle), {
      status: "recorded",
      retirement: "retired",
      retained: false,
    });
  }
  assert.deepEqual(calls, { reconcile: [handle], retire: [handle] });
  assert.deepEqual(owner.inspectPending(), []);
  assert.throws(() => owner.register(handle, references("replay")));
  assert.throws(() => owner.discard(handle));
  owner.register(original(), references("next"));
});

test("repeated unknown outcomes remain process-owned and make no durable or restart-recognition claim", async () => {
  const peer = sourcePeer();
  const { owner, handle } = enrolled(peer);
  for (let index = 0; index < 8; index += 1) {
    assert.equal(await owner.reconcile(handle), "unavailable");
    assertSummary(owner.inspect(handle), {
      status: "pending",
      retirement: "not-started",
      retained: true,
      retention: "process",
      durable: false,
    });
    assert.throws(() => owner.register(original(), references(`overflow-${index}`)));
  }
  assert.equal(peer.calls.reconcile.length, 8);
  assert.deepEqual(peer.calls.retire, []);
  assert.equal(owner.inspectPending().length, 1);
  const newProcessOwner = new RepositoryWorkObservationOwnerV2(peer.source, {
    maximumResponsibilities: 1,
  });
  assert.deepEqual(newProcessOwner.inspectPending(), []);
  assert.throws(() => newProcessOwner.inspect(handle));
  assert.throws(() => newProcessOwner.reconcile(handle));
});

test("bounded next reconciliation returns null for an empty owner or only reserved originals", async () => {
  const peer = sourcePeer();
  const owner = new RepositoryWorkObservationOwnerV2(peer.source, { maximumResponsibilities: 2 });
  assert.equal(await owner.reconcileNext(), null);
  const first = original();
  const second = original();
  owner.register(first, references("first"));
  owner.register(second, references("second"));
  assert.equal(await owner.reconcileNext(), null);
  assert.deepEqual(peer.calls, { reconcile: [], retire: [] });
  assertSummary(owner.inspect(first), { status: "reserved", retained: true });
  assertSummary(owner.inspect(second), { status: "reserved", retained: true });
});

test("bounded next reconciliation fairly rotates unknown originals and performs one source attempt per call", async () => {
  const peer = sourcePeer();
  const owner = new RepositoryWorkObservationOwnerV2(peer.source, { maximumResponsibilities: 3 });
  const reserved = original();
  const first = original();
  const second = original();
  owner.register(reserved, references("reserved"));
  owner.register(first, references("first"));
  owner.register(second, references("second"));
  owner.activate(first);
  owner.activate(second);
  const expected = [first, second, first, second];
  for (let index = 0; index < expected.length; index += 1) {
    const selected = await owner.reconcileNext();
    assertSummary(selected, {
      operationRef: expected[index] === first ? "operation/first" : "operation/second",
      status: "pending",
      retirement: "not-started",
      retained: true,
    });
    assert.deepEqual(peer.calls.reconcile, expected.slice(0, index + 1));
    assert.deepEqual(peer.calls.retire, []);
  }
  assertSummary(owner.inspect(reserved), { status: "reserved", retained: true });
  assert.equal(
    owner.inspectPending().length,
    3,
    "unknown outcomes must not be evicted by rotation",
  );
});

test("bounded next reconciliation joins an already running original without a duplicate source attempt", async () => {
  const read = deferred();
  const entered = deferred();
  const { owner, handle, calls } = enrolled(
    sourcePeer({
      reconcile() {
        entered.resolve();
        return read.promise;
      },
    }),
  );
  const direct = owner.reconcile(handle);
  await entered.promise;
  const selected = owner.reconcileNext();
  let completed = false;
  void selected.then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.deepEqual(calls.reconcile, [handle]);
  read.resolve("recorded");
  assert.equal(await direct, "recorded");
  assertSummary(await selected, {
    ...references(),
    status: "recorded",
    retirement: "retired",
    retained: false,
  });
  assert.deepEqual(calls, { reconcile: [handle], retire: [handle] });
  assert.equal(await owner.reconcileNext(), null);
});

test("bounded next reconciliation rotates a failed retirement and later retries only its release", async () => {
  const first = original();
  const second = original();
  let allowRetirement = false;
  const peer = sourcePeer({
    reconcile: async () => "recorded",
    retire(handle) {
      if (handle === first && !allowRetirement)
        return Promise.reject(new Error("Declared release failure."));
      return Promise.resolve();
    },
  });
  const owner = new RepositoryWorkObservationOwnerV2(peer.source, { maximumResponsibilities: 2 });
  owner.register(first, references("first"));
  owner.register(second, references("second"));
  owner.activate(first);
  owner.activate(second);
  assertSummary(await owner.reconcileNext(), {
    operationRef: "operation/first",
    status: "recorded",
    retirement: "failed",
    retained: true,
  });
  assertSummary(await owner.reconcileNext(), {
    operationRef: "operation/second",
    status: "recorded",
    retirement: "retired",
    retained: false,
  });
  assert.deepEqual(peer.calls.reconcile, [first, second]);
  allowRetirement = true;
  assertSummary(await owner.reconcileNext(), {
    operationRef: "operation/first",
    status: "recorded",
    retirement: "retired",
    retained: false,
  });
  assert.deepEqual(
    peer.calls.reconcile,
    [first, second],
    "selection must preserve the recorded latch",
  );
  assert.deepEqual(peer.calls.retire, [first, second, first]);
  assert.equal(await owner.reconcileNext(), null);
});

// Optional receiving-tree check: an explicit absolute path selects the actual
// adapter module with its existing dependency graph. Missing selection is a
// reported integration gap; an import failure of a selected module is a failure.
// The declared constructor peers below are negative-only. No prepared State
// original is manufactured and no positive State/GitHub flow is claimed.
const adapterModulePath = process.env.OCC_REPOSITORY_WORK_OBSERVER_ADAPTER_MODULE;
nodeTest(
  "actual adapter observation facade refuses unenrolled handles before calling source peers",
  {
    timeout: 5000,
    skip: adapterModulePath
      ? false
      : "Select the actual adapter module and existing dependency graph; positive State preparation is not covered by helper peers.",
  },
  async () => {
    assert.equal(
      adapterModulePath.startsWith("/"),
      true,
      "Select an absolute actual adapter module path.",
    );
    const { RepositoryWorkStateAdapterV2 } = await import(pathToFileURL(adapterModulePath).href);
    const events = [];
    const unexpected = (method) => () => {
      events.push(method);
      throw new Error(`Unenrolled observer access reached declared peer: ${method}`);
    };
    const participant = Object.fromEntries(
      [
        "assertOriginal",
        "recognizeCommittedRelease",
        "recognizeCommittedInventory",
        "acquireCommittedMint",
        "acquireCommittedRevocation",
      ].map((name) => [name, unexpected(`participant.${name}`)]),
    );
    const binding = {
      participant,
      bindOriginalSources(source, custody) {
        assert.equal(typeof source.acquire, "function");
        assert.equal(custody, tokenSource);
        events.push("bind-original-sources");
        return {
          run: unexpected("store.run"),
          recoverAfterUnwind: unexpected("store.recoverAfterUnwind"),
        };
      },
    };
    const native = Object.fromEntries(
      [
        "acquire",
        "inspect",
        "inspectNative",
        "assertNativeCurrent",
        "assertCurrent",
        "release",
      ].map((name) => [name, unexpected(`native.${name}`)]),
    );
    const selection = Object.fromEntries(
      [
        "acquire",
        "inspect",
        "prepareStateUse",
        "retainPolicy",
        "retainObservation",
        "observationCall",
        "release",
      ].map((name) => [name, unexpected(`selection.${name}`)]),
    );
    const tokenSource = Object.freeze({ acquire: unexpected("custody.acquire") });
    const tokens = { source: tokenSource, inspect: unexpected("tokens.inspect") };
    const adapter = new RepositoryWorkStateAdapterV2(binding, native, selection, tokens, 1000, {
      protocolVersion: 2,
      maximumObservationResponsibilities: 1,
    });
    assert.equal(Object.isFrozen(adapter.observations), true);
    assert.deepEqual(Object.keys(adapter.observations).sort(), [
      "inspect",
      "inspectPending",
      "join",
      "reconcile",
      "reconcileNext",
    ]);
    const pending = adapter.observations.inspectPending();
    assert.equal(Object.isFrozen(pending), true);
    assert.deepEqual(pending, []);
    assert.equal(await adapter.observations.reconcileNext(), null);
    for (const denied of [original(), references(), { ...references(), status: "pending" }]) {
      assert.throws(() => adapter.observations.inspect(denied));
      assert.throws(() => adapter.observations.reconcile(denied));
      assert.throws(() => adapter.observations.join(denied));
      assert.equal(await adapter.state.settle(denied, undefined, "unknown"), "unavailable");
    }
    assert.deepEqual(events, ["bind-original-sources"]);
  },
);

// Actual Work adapter with declared State/native/selection/token peers.
// Store.run executes the real adapter body; only the adapter mints P.
// This proves no original State authority, SQL COMMIT, policy custody, or GitHub I/O.
async function declaredAdapterPreparation(dispatchResult = "not-committed") {
  assert.equal(adapterModulePath.startsWith("/"), true);
  const adapterUrl = pathToFileURL(adapterModulePath);
  const { RepositoryWorkStateAdapterV2 } = await import(adapterUrl.href);
  const { githubMetadataDigest } = await import(
    new URL("../github-mediation-v2/wire.ts", adapterUrl).href
  );
  const { repositoryWorkPolicyDigestV2 } = await import(
    new URL("./repository-work-policy-v2.ts", adapterUrl).href
  );
  const token = original();
  const receiver = original();
  const session = original();
  const releaseEntered = deferred();
  const releaseCompletion = deferred();
  const events = [];
  const context = Object.freeze({ declaredPeer: "native context" });
  const origin = Object.freeze({ declaredPeer: "native origin" });
  const selected = Object.freeze({ declaredPeer: "State selection" });
  const transportBinding = Object.freeze({ declaredPeer: "native transport" });
  const end = new Date(Date.now() + 9000).toISOString();
  const request = Object.freeze({
    version: 2,
    sequence: 1,
    method: "open-read",
    request_ref: "1".repeat(32),
    attachment_ref: "attachment/join",
    repository_owner: "example",
    repository_name: "project",
    request_sha256: githubMetadataDigest("example", "project"),
  });
  const scope = {
    installationRef: "installation/join",
    namespaceRef: "namespace/join",
    agentRef: "agent/join",
    revisionRef: "revision/join",
  };
  const sqlScope = {
    installationId: scope.installationRef,
    namespaceId: scope.namespaceRef,
    agentId: scope.agentRef,
    revisionRef: scope.revisionRef,
  };
  const profile = { ref: "profile/join", revision: "1" };
  const work = { workRef: "work/join", revision: 1 };
  const service = {
    kind: "service_principal",
    id: "service/join",
    namespaceId: scope.namespaceRef,
    agentId: scope.agentRef,
  };
  const execution = {
    attempt: {
      installationRef: scope.installationRef,
      namespaceRef: scope.namespaceRef,
      agentRef: scope.agentRef,
      conversationRef: "conversation/join",
      turnRef: "turn/join",
      attemptRef: "attempt/join",
      reservationRef: "reservation/join",
    },
    assignmentRef: "assignment/join",
    assignmentVersion: "1",
    executionIncarnationRef: "incarnation/join",
    executionGeneration: "1",
    receiverRef: "receiver/join",
    protectedOriginRef: "origin/join",
    executionProfile: profile,
    predecessor: { kind: "none" },
  };
  const operation = (kind) => ({
    operationRef: "operation/join-" + kind,
    requestDigest: request.request_sha256,
    invocationRef: "invocation/join",
    scope,
  });
  const current = {
    original: operation("dispatch"),
    work,
    execution,
    lineage: {
      scope,
      own: { work, originalHorizon: end, state: "open", withdrawalRevision: 0 },
      membershipProfile: profile,
      kind: "root",
      rootWorkRef: work.workRef,
      parentWorkRef: null,
      ancestors: [],
    },
    withdrawals: [{ kind: "not-withdrawn-at-cut", revision: 0 }],
    service,
    originalHorizon: end,
    repository: { id: "789", owner: "example", name: "project", profile },
    policy: {
      operation: "work.repository.use",
      service,
      repositoryId: "789",
      profile,
      permission: "metadata:read",
    },
    attachmentRef: request.attachment_ref,
    dnsBindingRef: "dns/join",
    upstreamIpv4: "140.82.114.5",
    validUntil: end,
  };
  const target = {
    installationId: scope.installationRef,
    githubHost: "github.com",
    appId: "123",
    githubInstallationId: "456",
    repositoryId: "789",
  };
  const policy = {
    schemaVersion: 2,
    policyRef: "policy/join",
    version: 1,
    status: "enabled",
    scope: {
      installationId: scope.installationRef,
      namespaceId: scope.namespaceRef,
      agentId: scope.agentRef,
    },
    servicePrincipalId: service.id,
    repository: { target, owner: "example", name: "project", profile },
    executionProfile: profile,
    operations: ["metadata:read"],
    bounds: {
      notBefore: new Date(Date.now() - 60000).toISOString(),
      notAfter: new Date(Date.now() + 60000).toISOString(),
      maximumWorkMilliseconds: 10000,
    },
  };
  const record = {
    scope: sqlScope,
    workRef: work.workRef,
    revision: 1,
    withdrawalRevision: 0,
    parentWorkRef: null,
    rootWorkRef: work.workRef,
    originalHorizon: end,
    state: "open",
    execution,
    policy: current.policy,
    originalAdmission: { operationRef: "operation/join-admission" },
  };
  const data = {
    current,
    preparation: operation("preparation"),
    observation: operation("observation"),
    admission: {
      kind: "existing",
      originalAdmission: {
        ...operation("admission"),
        scope: sqlScope,
        commitRef: "declared-state/admission-commit",
        kind: "admission",
        document: { record },
      },
    },
    sessionRef: "github-native/" + "a".repeat(32),
    repositoryTarget: target,
    workBeganAt: new Date().toISOString(),
    policyAdmission: {
      policyRef: policy.policyRef,
      policyVersion: policy.version,
      policyDigest: repositoryWorkPolicyDigestV2(policy),
      execution,
      originalHorizon: end,
    },
    observationRef: "observation/join",
    observationEvidenceRef: "evidence/join",
  };
  const nativeBinding = {
    context,
    transportBinding,
    receiverRef: execution.receiverRef,
    attachmentRef: request.attachment_ref,
    execution,
    service,
  };
  // Declared native-peer call, never constructed by the production observer.
  const call = {
    context,
    signal: new AbortController().signal,
    requestRef: request.request_ref,
    recipientRef: execution.receiverRef,
    deadline: end,
  };
  const unexpected = (name) => () => {
    events.push(["unexpected", name]);
    throw new Error("Unselected declared peer method: " + name);
  };
  const native = {
    async acquire() {
      return origin;
    },
    async inspect() {
      return nativeBinding;
    },
    async inspectNative() {
      return nativeBinding;
    },
    assertNativeCurrent() {
      assert.equal(call.signal.aborted, false);
    },
    assertCurrent: unexpected("native.assertCurrent"),
    release: unexpected("native.release"),
  };
  const selection = {
    async acquire(givenOrigin) {
      assert.equal(givenOrigin, origin);
      return selected;
    },
    async inspect(givenSelection, givenOrigin, givenCall) {
      assert.equal(givenSelection, selected);
      assert.equal(givenOrigin, origin);
      assert.equal(givenCall, call);
      return data;
    },
    async prepareStateUse(givenSelection, givenOrigin, givenCall) {
      assert.equal(givenSelection, selected);
      assert.equal(givenOrigin, origin);
      assert.equal(givenCall, call);
      events.push(["prepare-state-use"]);
    },
    retainPolicy: unexpected("selection.retainPolicy"),
    retainObservation: unexpected("selection.retainObservation"),
    async observationCall(givenSelection) {
      assert.equal(givenSelection, selected);
      const observerCall = { ...call, signal: new AbortController().signal };
      events.push(["observer-call", observerCall]);
      return observerCall;
    },
    async release(givenSelection) {
      assert.equal(givenSelection, selected);
      events.push(["release-enter"]);
      releaseEntered.resolve();
      await releaseCompletion.promise;
      events.push(["release-complete"]);
    },
  };
  const staged = [];
  const dispatches = [];
  const originalsSeen = [];
  const participant = Object.fromEntries(
    [
      "assertOriginal",
      "recognizeCommittedRelease",
      "recognizeCommittedInventory",
      "acquireCommittedMint",
      "acquireCommittedRevocation",
    ].map((name) => [name, unexpected("participant." + name)]),
  );
  const tokenSource = Object.freeze({ acquire: unexpected("custody.acquire") });
  const binding = {
    participant,
    bindOriginalSources(source, custody) {
      assert.equal(typeof source.acquire, "function");
      assert.equal(custody, tokenSource);
      return {
        async run(givenOriginal, givenCall, bounds, body) {
          // The actual adapter body must read and stage before State reports a result.
          assert.ok(givenOriginal === data.preparation || givenOriginal === data.current.original);
          assert.equal(givenCall, call);
          assert.equal(bounds.signal, call.signal);
          assert.ok(bounds.timeoutMs > 0 && bounds.timeoutMs <= 1000);
          originalsSeen.push(givenOriginal);
          const unit = {
            context: {
              installationId: scope.installationRef,
              assertActive: unexpected("unit.context.assertActive"),
              retain: unexpected("unit.context.retain"),
              joinAccepted: unexpected("unit.context.joinAccepted"),
            },
            async readForMutation(givenWork, givenExecution) {
              assert.deepEqual({ ...givenWork }, work);
              assert.equal(givenExecution.receiverRef, execution.receiverRef);
              return { scope: sqlScope, lineage: [record] };
            },
            async stagePreparation(input) {
              staged.push(input);
            },
            assertCurrent() {
              events.push(["state-assert-current"]);
            },
            stageAdmission: unexpected("unit.stageAdmission"),
            async stageDispatchAndRelease(input) {
              dispatches.push(input);
            },
            stageClosure: unexpected("unit.stageClosure"),
            appendObservation: unexpected("unit.appendObservation"),
            readExactOperation: unexpected("unit.readExactOperation"),
            stageRepositoryInventory: unexpected("unit.stageRepositoryInventory"),
            readRepositoryInventoryOperation: unexpected("unit.readRepositoryInventoryOperation"),
            readRepositoryInventoryCurrent: unexpected("unit.readRepositoryInventoryCurrent"),
          };
          const value = await body(unit);
          if (givenOriginal === data.current.original) {
            return dispatchResult === "unknown"
              ? { kind: "unknown", operationRef: givenOriginal.operationRef }
              : { kind: "not-committed" };
          }
          return {
            kind: "committed",
            value,
            commit: Object.freeze({ declaredPeer: "State preparation commit result" }),
            acknowledgedAt: new Date().toISOString(),
          };
        },
        async recoverAfterUnwind(givenOriginal, observerCall, bounds) {
          assert.equal(givenOriginal, data.current.original);
          assert.equal(bounds.signal, observerCall.signal);
          events.push(["recover-absent", givenOriginal]);
          return { kind: "absent" };
        },
      };
    },
  };
  const tokens = {
    source: tokenSource,
    inspect(givenToken, givenSelection) {
      assert.equal(givenToken, token);
      assert.equal(givenSelection, selected);
      return {
        accessLeaseRef: "lease/join",
        inventoryRecordRef: "inventory/join",
        inventoryVersion: 1,
        releaseRef: "release/join",
        repositoryTarget: target,
        receiver,
        session,
      };
    },
  };
  const adapter = new RepositoryWorkStateAdapterV2(binding, native, selection, tokens, 1000, {
    protocolVersion: 2,
    maximumObservationResponsibilities: 1,
  });
  const preparation = await adapter.state.prepare(origin, request, call);
  assert.ok(preparation, "Actual adapter preparation required.");
  assert.equal(staged.length, 1);
  assert.equal(staged[0].workRef, work.workRef);
  assert.equal(staged[0].requestDigest, request.request_sha256);
  assert.deepEqual(originalsSeen, [data.preparation]);
  assertSummary(adapter.observations.inspect(preparation), {
    status: "reserved",
    retained: true,
  });
  assert.throws(() => adapter.observations.inspect({ ...preparation }));

  const dispatch = {
    version: 2,
    sequence: 2,
    method: "dispatch-read",
    request_ref: request.request_ref,
    session_ref: "2".repeat(32),
    effect_ref: data.preparation.operationRef,
    request_sha256: request.request_sha256,
    dns_binding_ref: current.dnsBindingRef,
    upstream_ipv4: current.upstreamIpv4,
    work_binding_sha256: "sha256:" + "3".repeat(64),
    peer_certificate_sha256: "sha256:" + "4".repeat(64),
  };
  return {
    adapter,
    preparation,
    origin,
    token,
    dispatch,
    current,
    call,
    releaseEntered,
    releaseCompletion,
    events,
    staged,
    dispatches,
  };
}

const adapterRegressionOptions = {
  timeout: 5000,
  skip: adapterModulePath ? false : "Select the actual adapter module for component coverage.",
};
nodeTest(
  "actual adapter immediate observation join waits for undispatched settlement retirement",
  adapterRegressionOptions,
  async () => {
    const {
      adapter,
      preparation,
      origin,
      call,
      releaseEntered,
      releaseCompletion,
      events,
      staged,
    } = await declaredAdapterPreparation();
    // There must be no await between settle and join: this is the reported race.
    // P is the exact object produced above; no private entry or handle is injected.
    const settlement = adapter.state.settle(preparation, undefined, "not-dispatched");
    let joinedEarly = false;
    const joined = adapter.observations.join(preparation).then((summary) => {
      joinedEarly = true;
      return summary;
    });
    assert.equal(adapter.state.settle(preparation, undefined, "not-dispatched"), settlement);
    try {
      await releaseEntered.promise;
      assert.equal(joinedEarly, false, "Immediate join must wait for selection release.");
      assertSummary(adapter.observations.inspect(preparation), {
        status: "recorded",
        retirement: "retiring",
        retained: true,
      });
      await assert.rejects(adapter.state.readCurrent(preparation, origin, call));
      assert.equal(events.filter(([name]) => name === "release-enter").length, 1);
      assert.equal(
        events.some(([name]) => name === "release-complete"),
        false,
      );
    } finally {
      releaseCompletion.resolve();
    }
    assert.equal(await settlement, "recorded");
    assertSummary(await joined, { status: "recorded", retirement: "retired", retained: false });
    assert.deepEqual(adapter.observations.inspectPending(), []);
    assert.equal(events.filter(([name]) => name === "release-complete").length, 1);
    assert.equal(
      events.some(([name]) => name === "unexpected"),
      false,
    );
    assert.equal(staged.length, 1, "Historical joining must not repeat preparation.");
  },
);

for (const stateResult of ["not-committed", "unknown"]) {
  nodeTest(
    "actual adapter retains the State dispatch distinction: " + stateResult,
    adapterRegressionOptions,
    async () => {
      const {
        adapter,
        preparation,
        origin,
        token,
        dispatch,
        current,
        call,
        releaseCompletion,
        events,
        dispatches,
      } = await declaredAdapterPreparation(stateResult);
      // Declared State results exercise adapter settlement, without SQL outcome proof.
      const dispatched = await adapter.state.commitDispatch(
        preparation,
        origin,
        token,
        dispatch,
        current,
        call,
      );
      assert.equal(dispatched.kind, stateResult);
      assert.equal(dispatches.length, 1);
      await assert.rejects(
        adapter.state.commitDispatch(preparation, origin, token, dispatch, current, call),
      );
      releaseCompletion.resolve();
      const settled = await adapter.state.settle(preparation, undefined, "unknown");
      if (stateResult === "not-committed") {
        assert.equal(settled, "recorded");
        assertSummary(adapter.observations.inspect(preparation), {
          status: "recorded",
          retirement: "retired",
          retained: false,
        });
        assert.equal(events.filter(([name]) => name === "release-complete").length, 1);
        assert.equal(
          events.some(([name]) => name === "observer-call"),
          false,
        );
        assert.equal(
          events.some(([name]) => name === "recover-absent"),
          false,
        );
      } else {
        assert.equal(settled, "unavailable");
        assertSummary(adapter.observations.inspect(preparation), {
          status: "pending",
          retirement: "not-started",
          retained: true,
        });
        assert.equal(await adapter.observations.reconcile(preparation), "unavailable");
        assertSummary(await adapter.observations.join(preparation), {
          status: "pending",
          retirement: "not-started",
          retained: true,
        });
        const calls = events.filter(([name]) => name === "observer-call");
        assert.equal(calls.length, 2);
        assert.notEqual(
          calls[0][1],
          calls[1][1],
          "Retry must use the source's fresh bounded call.",
        );
        assert.equal(events.filter(([name]) => name === "recover-absent").length, 2);
        assert.equal(
          events.some(([name]) => name === "release-enter"),
          false,
        );
      }
      await assert.rejects(
        adapter.state.commitDispatch(preparation, origin, token, dispatch, current, call),
      );
      assert.equal(dispatches.length, 1, "Settlement must never redispatch.");
      assert.equal(
        events.some(([name]) => name === "unexpected"),
        false,
      );
    },
  );
}
