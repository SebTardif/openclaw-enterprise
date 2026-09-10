import assert from "node:assert/strict";
import test from "node:test";
import { NativeJournalCompletionConsumer } from "../../packages/occ/src/turn-journal/native-completion.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { TurnJournalStore } from "../../packages/occ/src/turn-journal/store.ts";
import { storageProvenance } from "../fixtures/turn-journal-storage/values.mjs";
import * as values from "../fixtures/turn-journal-v1/values.mjs";

// The first case uses the real memory journal's unavailable selected-execution
// boundary. The other cases use recording dependency ports with designated
// outcomes to exercise the REAL consumer and its REAL internal completion
// service. They do not implement journal decisions, commits, CAS, authentication,
// canonical bytes, native execution, or no-mutator authority. Genuine retained
// native start -> publication remains a separately required provider/PG test.
const copy = (value) => structuredClone(value);
const plain = (value) => JSON.parse(JSON.stringify(value));
const same = (actual, expected) => assert.deepEqual(plain(actual), plain(expected));
const unavailable = { kind: "unavailable" };
const withheld = { kind: "publication-withheld", nextAction: "exact-readback-only" };
const deferred = () => Promise.withResolvers();

function data() {
  const execution = {
    attempt: copy(values.attempt),
    dispatchOperationRef: values.attemptRecord.binding.dispatchOperationRef,
    consumption: copy(values.attemptRecord.consumption.operation),
    executionRef: "execution/completion-one",
    recipientRef: "recipient/native-one",
  };
  const intent = {
    execution,
    operationRef: "intent/completion-one",
    operationDigest: "a".repeat(64),
    executionLimitRef: "execution-limit-one",
    executionLimitVersion: 1,
    maximumExecutionMs: 1000,
    dispatchClock: {
      kind: "pre-commit-monotonic-v1",
      clockSourceRef: "host-clock-one",
      clockEpochRef: "host-epoch-one",
      anchorAtMs: 100,
      deadlineAtMs: 900100,
    },
  };
  const deadlineControl = {
    kind: "host-deadline-v1",
    intent,
    operationRef: "cleanup/completion-one",
    operationDigest: "b".repeat(64),
    nativeIncarnationRef: "native-incarnation-one",
    nativeConstructionRef: "native-construction-one",
    responsibilityRef: "original-cleanup-one",
    responsibilityVersion: 1,
    deadlineAtMs: 1100,
  };
  const start = {
    kind: "host-controlled-v1",
    intent,
    operationRef: "start/completion-one",
    operationDigest: "c".repeat(64),
    nativeExecutionRef: "native-execution-one",
    nativeIncarnationRef: deadlineControl.nativeIncarnationRef,
    nativeReservationRef: "native-reservation-one",
    nativeSessionRef: "native-session-one",
    nativeTurnRef: "native-turn-one",
    acceptanceEvidenceRef: "native-ready-one",
    deadlineControl,
  };
  const publication = {
    allocation: copy(values.allocation),
    operation: copy(values.completionOperation),
    allocationTransactionRef: "transaction/native-allocation-one",
    publicationTransactionRef: "transaction/native-publication-one",
    preparation: {
      ...copy(values.attempt),
      checkpointId: values.allocation.checkpointId,
      expectedCompletionSequence: values.head.completionSequence,
      nativeTerminalEvidenceRef: "native-terminal-one",
      workspaceCompletionRef: values.checkpoint.workspaceCompletionRef,
    },
  };
  // This is the existing SDK callback shape. Its JSON payload is deliberately
  // opaque to the consumer; only the original source can authenticate terminal
  // meaning and private native-event membership.
  const event = {
    start: copy(start),
    nativeThreadId: "native-thread-one",
    event: { testOnlyOpaqueObservation: "terminal-observation-one" },
  };
  return { start, publication, event };
}

function recordingPorts() {
  const fixture = data();
  const allocationTransactionRef = fixture.publication.allocationTransactionRef;
  const calls = [];
  const caller = new AbortController();
  const acquisition = new AbortController();
  let wall = Date.now();
  const call = {
    context: Object.freeze({ testOnlyProvenanceContext: true }),
    requestRef: "request/native-completion-one",
    recipientRef: "recipient/turn-journal",
    deadline: new Date(wall + 30_000).toISOString(),
    signal: caller.signal,
  };
  // This opaque sentinel is owned only by recording ports, never accepted as
  // authenticated provenance by a real repository or native producer.
  const evidenceHandle = Object.freeze({});
  const canonical = {
    kind: "verified",
    checkpointRef: copy(values.checkpoint),
    verificationReceiptRef: "canonical-verification-one",
  };
  const observation = {
    operation: copy(fixture.publication.operation),
    allocation: copy(fixture.publication.allocation),
    canonical,
    nativeTerminalEvidenceRef: fixture.publication.preparation.nativeTerminalEvidenceRef,
    workspaceCompletionRef: fixture.publication.preparation.workspaceCompletionRef,
    noMutatorEvidenceRef: "no-mutator-one",
    gatewayAssignment: copy(values.identity.gatewayAssignment),
    harnessAssignment: copy(values.identity.harnessAssignment),
    reservation: copy(values.reservation),
    pendingDelivery: copy(values.deliveryOperation),
  };
  const behavior = {
    before: async () => {},
    acquisition: undefined,
    execution: { kind: "started", start: copy(fixture.start) },
    allocation: { kind: "allocated", allocation: copy(fixture.publication.allocation) },
    allocationRead: { kind: "found", allocation: copy(fixture.publication.allocation) },
    publication: { kind: "published", record: copy(values.completion) },
    allocationCommit: undefined,
    publicationCommit: undefined,
    prepared: canonical,
  };
  async function record(name, args) {
    calls.push({ name, args });
    await behavior.before(name, args);
  }
  const view = {
    async findExecution(...args) {
      await record("findExecution", args);
      return behavior.execution;
    },
    async findCheckpointAllocation(...args) {
      await record("findAllocation", args);
      return behavior.allocationRead;
    },
  };
  const unit = {
    async allocateCheckpoint(...args) {
      await record("allocate", args);
      return behavior.allocation;
    },
    async publishCompleted(...args) {
      await record("publish", args);
      assert.equal(args[0], evidenceHandle);
      return behavior.publication;
    },
  };
  const store = {
    async read(work, authority) {
      await record("read", [authority]);
      return work(view);
    },
    async transact(transactionRef, work, authority) {
      await record("transact", [transactionRef, authority]);
      const value = await work(unit);
      await record("commit", [transactionRef]);
      return (
        (transactionRef === allocationTransactionRef
          ? behavior.allocationCommit
          : behavior.publicationCommit) ?? { kind: "committed", value }
      );
    },
  };
  const lease = {
    start: fixture.start,
    nativeThreadId: fixture.event.nativeThreadId,
    publication: fixture.publication,
    signal: acquisition.signal,
    async assertCurrent() {
      assert.equal(this, lease);
      await record("current", []);
    },
    async release() {
      assert.equal(this, lease);
      await record("release", []);
    },
  };
  const source = {
    async acquire(...args) {
      assert.equal(this, source);
      await record("acquire", args);
      return behavior.acquisition ?? { kind: "acquired", lease };
    },
  };
  const options = {
    store,
    source,
    now: () => new Date(wall),
    adapter: {
      async prepareCompleted(...args) {
        await record("prepare", args);
        return behavior.prepared;
      },
      async verify() {
        assert.fail("Fresh preparation must not enter recovery verification.");
      },
    },
    evidence: {
      async verifyCompletion(...args) {
        await record("verifyEvidence", args);
        return evidenceHandle;
      },
      async inspectCompletion(...args) {
        await record("inspectEvidence", args);
        assert.equal(args[0], evidenceHandle);
        return observation;
      },
    },
  };
  const consumer = new NativeJournalCompletionConsumer(options);
  return {
    ...fixture,
    consumer,
    options,
    source,
    lease,
    call,
    caller,
    acquisition,
    behavior,
    calls,
    evidenceHandle,
    names: () => calls.map(({ name }) => name),
    count: (name) => calls.filter((entry) => entry.name === name).length,
    advance: (milliseconds) => {
      wall += milliseconds;
    },
    publish: () => consumer.publish(fixture.event, call),
  };
}

async function reached(entered, pending) {
  return Promise.race([
    entered.promise,
    pending.then(() => assert.fail("Consumer settled before the selected boundary.")),
  ]);
}

function hold(probe, name, occurrence = 1) {
  const entered = deferred();
  const resume = deferred();
  let seen = 0;
  probe.behavior.before = async (operation, args) => {
    if (operation === name && ++seen === occurrence) {
      entered.resolve(args);
      await resume.promise;
    }
  };
  return { entered, resume };
}

function noPublication(probe) {
  assert.equal(probe.count("transact"), 0);
  assert.equal(probe.count("prepare"), 0);
  assert.equal(probe.count("publish"), 0);
}

test("real configured memory journal refuses completion without retained execution support", async () => {
  const provenance = storageProvenance();
  const state = new InMemoryPlatformState({ turnJournal: provenance.options });
  const store = new TurnJournalStore({
    state,
    clock: provenance.clock,
    initiation: provenance.initiation,
  });
  const probe = recordingPorts();
  const call = provenance.call();
  let enteredRead = false;
  same(
    await store.read(async (view) => {
      enteredRead = true;
      return view.findExecution(probe.start.intent.execution, call);
    }, call),
    unavailable,
  );
  assert.equal(enteredRead, true, "The configured real memory repository was reached.");
  const consumer = new NativeJournalCompletionConsumer({ ...probe.options, store });
  same(await consumer.publish(probe.event, call), unavailable);
  same(probe.names(), ["acquire", "current", "current", "release"]);
  noPublication(probe);
});

test("recording ports: real consumer and completion service preserve sequence and opaque inputs", async () => {
  const probe = recordingPorts();
  const before = copy({ event: probe.event, publication: probe.publication, start: probe.start });
  const result = await probe.publish();
  same(result, { kind: "published", record: values.completion });
  same(probe.names(), [
    "acquire",
    "current",
    "read",
    "findExecution",
    "current",
    "transact",
    "allocate",
    "commit",
    "read",
    "findAllocation",
    "prepare",
    "verifyEvidence",
    "inspectEvidence",
    "transact",
    "publish",
    "commit",
    "current",
    "release",
  ]);
  const [event, authority] = probe.calls[0].args;
  assert.equal(event, probe.event);
  assert.equal(event.event, probe.event.event);
  assert.equal(authority.context, probe.call.context);
  assert.equal(authority.signal, probe.call.signal);
  assert.equal(authority.requestRef, probe.call.requestRef);
  assert.equal(authority.recipientRef, probe.call.recipientRef);
  assert.equal(authority.deadline, probe.call.deadline);
  assert.equal(Object.isFrozen(authority), true);
  const selectedRead = probe.calls.find(({ name }) => name === "findExecution");
  same(selectedRead.args[0], probe.start.intent.execution);
  const preparation = probe.calls.find(({ name }) => name === "prepare");
  same(preparation.args[0], probe.publication.preparation);
  assert.notEqual(preparation.args[0], probe.publication.preparation);
  assert.equal(Object.isFrozen(preparation.args[0]), true);
  assert.equal(probe.calls.find(({ name }) => name === "publish").args[0], probe.evidenceHandle);
  for (const { name, args } of probe.calls) {
    if (
      [
        "read",
        "findExecution",
        "transact",
        "allocate",
        "findAllocation",
        "verifyEvidence",
        "inspectEvidence",
        "publish",
      ].includes(name)
    ) {
      const bound = args.at(-1);
      assert.equal(bound.context, probe.call.context);
      assert.equal(bound.requestRef, probe.call.requestRef);
      assert.equal(bound.recipientRef, probe.call.recipientRef);
      assert.equal(bound.deadline, probe.call.deadline);
      assert.equal(bound.signal.aborted, false);
      assert.equal(Object.isFrozen(bound), true);
    }
  }
  same({ event: probe.event, publication: probe.publication, start: probe.start }, before);
  assert.equal(Object.isFrozen(probe.event), false);
  assert.equal(Object.isFrozen(probe.start), false);
  assert.equal(Object.isFrozen(probe.publication), false);
});

for (const kind of ["denied", "unavailable"]) {
  test(`recording ports: original source ${kind} is terminal and cannot be replayed`, async () => {
    const probe = recordingPorts();
    probe.behavior.acquisition = { kind };
    same(await probe.publish(), { kind });
    same(await probe.publish(), unavailable);
    same(probe.names(), ["acquire"]);
    noPublication(probe);
  });
}

for (const result of [
  { kind: "published", record: values.completion },
  { kind: "commit-unknown", nextAction: "exact-readback-only" },
  { kind: "unexpected" },
  {},
]) {
  test(`recording ports: source cannot inject non-acquired ${result.kind ?? "missing-kind"} results`, async () => {
    const probe = recordingPorts();
    probe.behavior.acquisition = result;
    same(await probe.publish(), unavailable);
    same(probe.names(), ["acquire"]);
    noPublication(probe);
  });
}

test("recording ports: source rejection spends the consumer and never enters journal work", async () => {
  const probe = recordingPorts();
  probe.behavior.before = async (name) => {
    if (name === "acquire") throw new Error("Original acquisition unavailable.");
  };
  same(await probe.publish(), unavailable);
  same(await probe.publish(), unavailable);
  same(probe.names(), ["acquire"]);
});

test("recording ports: terminal-looking event JSON cannot replace original source authority", async () => {
  const probe = recordingPorts();
  probe.event.event = { kind: "completed", authority: "caller-supplied", success: true };
  probe.behavior.acquisition = { kind: "denied" };
  same(await probe.publish(), { kind: "denied" });
  assert.equal(probe.calls[0].args[0], probe.event);
  noPublication(probe);
});

for (const [name, mutate] of [
  [
    "lease start",
    (p) => {
      p.lease.start = { ...copy(p.start), nativeTurnRef: "other-turn" };
    },
  ],
  [
    "lease thread",
    (p) => {
      p.lease.nativeThreadId = "other-thread";
    },
  ],
  [
    "allocation attempt",
    (p) => {
      p.publication.allocation.attempt.turnRef = "other-turn";
    },
  ],
  [
    "completion attempt",
    (p) => {
      p.publication.operation.attempt.turnRef = "other-turn";
    },
  ],
  [
    "retained start",
    (p) => {
      p.behavior.execution.start.nativeSessionRef = "other-session";
    },
  ],
]) {
  test(`recording ports: mismatched ${name} releases once without publication`, async () => {
    const probe = recordingPorts();
    mutate(probe);
    same(await probe.publish(), { kind: "conflict" });
    assert.equal(probe.count("release"), 1);
    assert.equal(probe.count("findExecution"), name === "retained start" ? 1 : 0);
    noPublication(probe);
  });
}

for (const [name, mutate] of [
  [
    "invalid start",
    (p) => {
      p.lease.start = {};
    },
  ],
  [
    "invalid signal",
    (p) => {
      p.lease.signal = {};
    },
  ],
  [
    "invalid publication",
    (p) => {
      p.lease.publication = {};
    },
  ],
  [
    "empty thread",
    (p) => {
      p.lease.nativeThreadId = "";
    },
  ],
]) {
  test(`recording ports: acquired ${name} still joins its release`, async () => {
    const probe = recordingPorts();
    mutate(probe);
    same(await probe.publish(), unavailable);
    assert.equal(probe.count("release"), 1);
    noPublication(probe);
  });
}

for (const kind of ["absent", "intent-only", "unavailable", "denied"]) {
  test(`recording ports: execution state ${kind} never authorizes preparation`, async () => {
    const probe = recordingPorts();
    probe.behavior.execution =
      kind === "intent-only" ? { kind, intent: copy(probe.start.intent) } : { kind };
    same(await probe.publish(), kind === "denied" ? { kind } : unavailable);
    assert.equal(probe.count("findExecution"), 1);
    assert.equal(probe.count("release"), 1);
    noPublication(probe);
  });
}

test("recording ports: journal read rejection releases acquisition and leaves service unentered", async () => {
  const probe = recordingPorts();
  probe.behavior.before = async (name) => {
    if (name === "findExecution") throw new Error("Selected journal unavailable.");
  };
  same(await probe.publish(), unavailable);
  assert.equal(probe.count("release"), 1);
  noPublication(probe);
});

for (const phase of ["before-read", "after-read", "after-publication"]) {
  test(`recording ports: supplier currentness failure ${phase} fences the result`, async () => {
    const probe = recordingPorts();
    const occurrence = { "before-read": 1, "after-read": 2, "after-publication": 3 }[phase];
    probe.behavior.before = async (name) => {
      if (name === "current" && probe.count("current") === occurrence)
        throw new Error("Original supplier currentness ended.");
    };
    same(await probe.publish(), phase === "after-publication" ? withheld : unavailable);
    assert.equal(probe.count("release"), 1);
    if (phase === "after-publication") assert.equal(probe.count("publish"), 1);
    else noPublication(probe);
    const count = probe.calls.length;
    same(await probe.publish(), unavailable);
    assert.equal(probe.calls.length, count);
  });
}

for (const kind of ["caller-abort", "lease-abort", "deadline"]) {
  test(`recording ports: ${kind} while journal read waits prevents service entry`, async () => {
    const probe = recordingPorts();
    const gate = hold(probe, "findExecution");
    const pending = probe.publish();
    try {
      await reached(gate.entered, pending);
      if (kind === "caller-abort") probe.caller.abort();
      else if (kind === "lease-abort") probe.acquisition.abort();
      else probe.advance(30_001);
    } finally {
      gate.resume.resolve();
      same(await pending, unavailable);
    }
    assert.equal(probe.count("release"), 1);
    noPublication(probe);
  });
}

test("recording ports: expired initial authority spends the consumer without acquisition", async () => {
  const probe = recordingPorts();
  probe.advance(30_001);
  same(await probe.publish(), unavailable);
  probe.advance(-30_001);
  same(await probe.publish(), unavailable);
  same(probe.names(), []);
});

test("recording ports: cancellation still joins a late acquisition and its blocked release", async () => {
  const probe = recordingPorts();
  const acquired = deferred();
  const allowAcquisition = deferred();
  const releasing = deferred();
  const allowRelease = deferred();
  probe.behavior.before = async (name) => {
    if (name === "acquire") {
      acquired.resolve();
      await allowAcquisition.promise;
    }
    if (name === "release") {
      releasing.resolve();
      await allowRelease.promise;
    }
  };
  let settled = false;
  const pending = probe.publish().then((result) => {
    settled = true;
    return result;
  });
  try {
    await reached(acquired, pending);
    probe.caller.abort();
    same(await probe.publish(), unavailable);
    assert.equal(settled, false);
    allowAcquisition.resolve();
    await reached(releasing, pending);
    assert.equal(settled, false, "Late original acquisition cleanup must remain joined.");
    noPublication(probe);
  } finally {
    allowAcquisition.resolve();
    allowRelease.resolve();
    same(await pending, unavailable);
  }
  assert.equal(probe.count("acquire"), 1);
  assert.equal(probe.count("release"), 1);
});

test("recording ports: synchronous source reentry cannot acquire or publish twice", async () => {
  const probe = recordingPorts();
  let nested;
  probe.behavior.before = async (name) => {
    if (name === "acquire") nested = probe.consumer.publish(copy(probe.event), probe.call);
  };
  assert.equal((await probe.publish()).kind, "published");
  same(await nested, unavailable);
  assert.equal(probe.count("acquire"), 1);
  assert.equal(probe.count("prepare"), 1);
  assert.equal(probe.count("publish"), 1);
  assert.equal(probe.count("release"), 1);
});

test("recording ports: overlapping calls cannot escape the acquisition or release waits", async () => {
  const probe = recordingPorts();
  const entering = deferred();
  const allowAcquisition = deferred();
  const releasing = deferred();
  const allowRelease = deferred();
  probe.behavior.before = async (name) => {
    if (name === "acquire") {
      entering.resolve();
      await allowAcquisition.promise;
    }
    if (name === "release") {
      releasing.resolve();
      await allowRelease.promise;
    }
  };
  let settled = false;
  const pending = probe.publish().then((result) => {
    settled = true;
    return result;
  });
  try {
    await reached(entering, pending);
    same(await probe.publish(), unavailable);
    allowAcquisition.resolve();
    await reached(releasing, pending);
    same(await probe.publish(), unavailable);
    assert.equal(settled, false);
    assert.equal(probe.count("publish"), 1);
  } finally {
    allowAcquisition.resolve();
    allowRelease.resolve();
    assert.equal((await pending).kind, "published");
  }
  same(await probe.publish(), unavailable);
  assert.equal(probe.count("acquire"), 1);
  assert.equal(probe.count("release"), 1);
});

test("recording ports: actual service waits for allocation acknowledgment before canonical preparation", async () => {
  const probe = recordingPorts();
  const gate = hold(probe, "commit");
  const pending = probe.publish();
  try {
    const [transactionRef] = await reached(gate.entered, pending);
    assert.equal(transactionRef, probe.publication.allocationTransactionRef);
    assert.equal(probe.count("prepare"), 0);
    assert.equal(probe.count("release"), 0);
  } finally {
    gate.resume.resolve();
    assert.equal((await pending).kind, "published");
  }
});

for (const stage of ["allocation", "publication"]) {
  test(`recording ports: ${stage} commit uncertainty retains exact readback identity without retry`, async () => {
    const probe = recordingPorts();
    const transactionRef =
      stage === "allocation"
        ? probe.publication.allocationTransactionRef
        : probe.publication.publicationTransactionRef;
    probe.behavior[`${stage}Commit`] = { kind: "commit-unknown", transactionRef };
    const result = await probe.publish();
    same(result, {
      kind: "commit-unknown",
      stage,
      transactionRef,
      allocation: probe.publication.allocation,
      operation: probe.publication.operation,
      nextAction: "exact-readback-only",
    });
    assert.equal(probe.count("prepare"), stage === "allocation" ? 0 : 1);
    assert.equal(probe.count("publish"), stage === "allocation" ? 0 : 1);
    assert.equal(probe.count("release"), 1);
    const count = probe.calls.length;
    same(await probe.publish(), unavailable);
    assert.equal(probe.calls.length, count);
  });
}

test("recording ports: a current service unavailable result passes through by exact object identity", async () => {
  const probe = recordingPorts();
  const result = { kind: "unavailable" };
  probe.behavior.allocationCommit = result;
  assert.equal(await probe.publish(), result);
  assert.equal(probe.count("prepare"), 0);
  assert.equal(probe.count("release"), 1);
});

for (const kind of ["release-rejection", "caller-abort", "deadline"]) {
  test(`recording ports: ${kind} during joined cleanup withholds a returned publication`, async () => {
    const probe = recordingPorts();
    probe.behavior.before = async (name) => {
      if (name !== "release") return;
      if (kind === "release-rejection") throw new Error("Acquisition cleanup unconfirmed.");
      if (kind === "caller-abort") probe.caller.abort();
      if (kind === "deadline") probe.advance(30_001);
    };
    same(await probe.publish(), withheld);
    assert.equal(probe.count("publish"), 1);
    assert.equal(probe.count("release"), 1);
    const count = probe.calls.length;
    same(await probe.publish(), unavailable);
    assert.equal(probe.calls.length, count);
  });
}

test("recording ports: cleanup may close its own signal without revoking current result disclosure", async () => {
  const probe = recordingPorts();
  probe.behavior.before = async (name) => {
    if (name === "release") probe.acquisition.abort();
  };
  assert.equal((await probe.publish()).kind, "published");
  assert.equal(probe.acquisition.signal.aborted, true);
  assert.equal(probe.call.signal.aborted, false);
  assert.equal(probe.count("release"), 1);
});

test("recording ports: prepublication cleanup failure remains unavailable without a publication claim", async () => {
  const probe = recordingPorts();
  probe.behavior.execution = { kind: "unavailable" };
  probe.behavior.before = async (name) => {
    if (name === "release") throw new Error("Acquisition cleanup unconfirmed.");
  };
  same(await probe.publish(), unavailable);
  noPublication(probe);
  assert.equal(probe.count("release"), 1);
});

for (const field of ["start", "nativeThreadId"]) {
  test(`recording ports: mutation of original event ${field} across acquisition conflicts`, async () => {
    const probe = recordingPorts();
    const gate = hold(probe, "acquire");
    const pending = probe.publish();
    try {
      await reached(gate.entered, pending);
      if (field === "start") probe.event.start.nativeTurnRef = "replaced-native-turn";
      else probe.event.nativeThreadId = "replaced-native-thread";
    } finally {
      gate.resume.resolve();
      same(await pending, { kind: "conflict" });
    }
    noPublication(probe);
    assert.equal(probe.count("release"), 1);
  });
}

test("recording ports: caller field replacement during acquisition cannot alter the captured call", async () => {
  const probe = recordingPorts();
  const original = { ...probe.call };
  const gate = hold(probe, "acquire");
  const pending = probe.publish();
  try {
    await reached(gate.entered, pending);
    Object.assign(probe.call, {
      context: {},
      requestRef: "replaced-request",
      recipientRef: "replaced-recipient",
      deadline: new Date(0).toISOString(),
      signal: new AbortController().signal,
    });
  } finally {
    gate.resume.resolve();
    assert.equal((await pending).kind, "published");
  }
  for (const { name, args } of probe.calls) {
    if (["acquire", "findExecution", "allocate", "publish"].includes(name)) {
      const captured = args.at(-1);
      assert.equal(captured.context, original.context);
      assert.equal(captured.requestRef, original.requestRef);
      assert.equal(captured.recipientRef, original.recipientRef);
      assert.equal(captured.deadline, original.deadline);
    }
  }
});

test("recording ports: captured lease data and methods survive supplier mutation after currentness wait", async () => {
  const probe = recordingPorts();
  const original = copy(probe.publication);
  const gate = hold(probe, "current");
  const pending = probe.publish();
  try {
    await reached(gate.entered, pending);
    probe.publication.preparation.nativeTerminalEvidenceRef = "replaced-evidence";
    probe.publication.allocationTransactionRef = "transaction/replaced-allocation";
    probe.publication.publicationTransactionRef = "transaction/replaced-publication";
    probe.start.nativeTurnRef = "replaced-lease-turn";
    probe.lease.assertCurrent = async () => assert.fail("Replaced currentness method entered.");
    probe.lease.release = async () => assert.fail("Replaced cleanup method entered.");
  } finally {
    gate.resume.resolve();
    assert.equal((await pending).kind, "published");
  }
  same(probe.calls.find(({ name }) => name === "prepare").args[0], original.preparation);
  same(
    probe.calls.filter(({ name }) => name === "transact").map(({ args }) => args[0]),
    [original.allocationTransactionRef, original.publicationTransactionRef],
  );
  assert.equal(probe.count("current"), 3);
  assert.equal(probe.count("release"), 1);
});
