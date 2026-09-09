import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { TurnJournalStore } from "../../packages/occ/src/turn-journal/store.ts";
import { takeCommittedTurnJournalClaim } from "../../packages/occ/src/turn-journal/transaction-guard.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import {
  copy,
  deferred,
  digest,
  eventLookup,
  incomingLookup,
  journalValues,
  logicalLookup,
  ref,
  seedJournalOwner,
  storageProvenance,
  changedIncoming,
} from "../fixtures/turn-journal-storage/values.mjs";
import { seedRuntimeOwner, runtimeAudit } from "./runtime-assignment-store.contract.mjs";
import { verifyPlatformStateStoreContract } from "./platform-state-store.contract.mjs";

// Only provenance observations and external-effect endpoints are controlled here.
// Every journal record, transaction result, head/CAS and claim comes from product
// InMemoryPlatformState/TurnJournalStore. This fixture is never application
// authentication, native timing, canonical durability or common E2E authority.
const plain = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => assert.deepEqual(plain(a), plain(b));
const committed = (result) => {
  assert.equal(result.kind, "committed");
  return result.value;
};
const yields = async () => {
  await new Promise(setImmediate);
};
async function harness(options = {}) {
  let wall = Date.now();
  const origin = wall;
  const clock = options.clocked ? { now: () => wall } : undefined;
  const provenance =
    options.provenance ??
    storageProvenance({
      capacity: options.capacity,
      ...(clock ? { now: clock.now } : {}),
    });
  const journal = { ...provenance.options, ...(clock ? { clock } : {}) };
  const state = new InMemoryPlatformState({ turnJournal: journal, auditSink: options.auditSink });
  const owner = await seedJournalOwner(state);
  const h = {
    state,
    provenance,
    owner,
    journal,
    v: journalValues(owner, { now: clock ? wall : Date.now() }),
    call: provenance.call(),
    issue: provenance.issue,
    advance(milliseconds) {
      assert.ok(clock);
      wall += milliseconds;
    },
    now() {
      return clock ? wall : Date.now();
    },
    fresh() {
      h.call = provenance.call();
      return h.call;
    },
  };
  h.clock = clock
    ? { now: provenance.clock.now, monotonicMilliseconds: () => wall - origin }
    : provenance.clock;
  h.store = new TurnJournalStore({
    state,
    clock: h.clock,
    initiation: options.initiation ?? provenance.initiation,
  });
  h.read = (work, call = h.call) => h.store.read((j) => work(j, call), call);
  h.write = (work, call = h.call) =>
    h.store.transact(ref("transaction"), (j) => work(j, call), call);
  h.direct = (work) => state.transact((unit) => work(unit.turnJournal, unit));
  return h;
}
const admit = (h, v = h.v) =>
  h.write((j, call) => j.admit(h.issue("admission", v.observation), call)).then(committed);
const dispatch = (h, v = h.v) =>
  h
    .write((j, call) => j.recordDispatchIntent(h.issue("dispatch", v.binding), call))
    .then(committed);
const consume = (h, v = h.v) =>
  h
    .write((j, call) =>
      j.consumeAttempt(
        h.issue("consumption", { operation: v.consumption, binding: v.binding }),
        call,
      ),
    )
    .then(committed);
const attempt = (h, v = h.v) => h.read((j, call) => j.findAttempt(v.attempt, call));
async function dispatched(h) {
  assert.equal((await admit(h)).record.decision.kind, "accepted");
  assert.equal((await dispatch(h)).kind, "recorded");
  return h;
}
async function consumed(h) {
  await dispatched(h);
  assert.equal((await consume(h)).kind, "claim-pending");
  return h;
}
async function recordOutcome(h, kind = "failed", overrides = {}) {
  const before = await attempt(h);
  const observation = {
    ...copy(h.v.outcome),
    operationRef: ref("outcome"),
    expectedAttemptVersion: before.record.version,
    outcome:
      kind === "running"
        ? { kind, nativeSessionRef: ref("session"), nativeTurnRef: ref("native-turn") }
        : { kind, stage: "execution", evidenceRef: ref("evidence") },
    ...overrides,
  };
  const result = committed(
    await h.write((j, call) => j.recordOutcome(h.issue("outcome", observation), call)),
  );
  return { observation, result };
}
async function complete(h) {
  assert.equal(
    committed(await h.write((j, call) => j.allocateCheckpoint(h.v.allocation, call))).kind,
    "allocated",
  );
  const current = await attempt(h);
  const observation = copy(h.v.completion);
  observation.operation.expectedAttemptVersion = current.record.version;
  observation.pendingDelivery.outcomeVersion = current.record.version + 1;
  const result = committed(
    await h.write((j, call) => j.publishCompleted(h.issue("completion", observation), call)),
  );
  assert.equal(result.kind, "published");
  return { observation, result };
}
async function release(h) {
  const current = await attempt(h);
  const observation = { ...copy(h.v.release), expectedAttemptVersion: current.record.version };
  return {
    observation,
    result: committed(
      await h.write((j, call) => j.releaseReservation(h.issue("release", observation), call)),
    ),
  };
}
async function status(h, outcomeKind = "outcome-unknown", deliveryKind = "delivered") {
  await consumed(h);
  const recorded = await recordOutcome(h, outcomeKind);
  const operation = {
    ...copy(h.v.delivery),
    operationRef: ref("status"),
    outputRef: ref("status-output"),
    outputDigest: digest(),
    slot: "outcome-status",
    statusNoticeCode: outcomeKind,
    outcomeVersion: recorded.result.record.version,
  };
  const reservation = committed(
    await h.write((j, call) => j.reserveDelivery(h.issue("delivery", operation), call)),
  );
  assert.equal(reservation.kind, "reserved");
  const providerMessageRef = ref("provider-message");
  const outcome = {
    operation,
    deliveryAttemptRef: reservation.deliveryAttemptRef,
    outcome:
      deliveryKind === "delivered"
        ? { kind: "delivered", providerMessageRef }
        : { kind: "delivery-unknown" },
  };
  assert.equal(
    committed(await h.write((j, call) => j.recordDelivery(outcome, call))).kind,
    "recorded",
  );
  return { h, operation, reservation, outcome, providerMessageRef };
}
const updateStatus = (s, version, code = "resolved-completed") => ({
  ...copy(s.operation),
  operationRef: ref("update"),
  outputRef: ref("updated-output"),
  outputDigest: digest(),
  outcomeVersion: version,
  statusNoticeCode: code,
  operation: { kind: "update", providerMessageRef: s.providerMessageRef },
});
const journalNames = [
  "findExecution",
  "findExecutionInterruption",
  "retainExecutionStart",
  "retainExecutionInterruption",
  "findAdmission",
  "findAttempt",
  "findCompletion",
  "readHead",
  "findDelivery",
  "findCheckpointAllocation",
  "findCancellation",
  "findRelease",
  "findNonTurnIntake",
  "findIncomingLink",
  "findRejectedAdmission",
  "admit",
  "recordDispatchIntent",
  "consumeAttempt",
  "allocateCheckpoint",
  "publishCompleted",
  "releaseReservation",
  "recordOutcome",
  "commitCancellation",
  "reserveDelivery",
  "recordDelivery",
  "admitNonTurn",
  "admitRejected",
];

test("M01.1 default memory remains unavailable without invoking callbacks", async () => {
  const p = storageProvenance(),
    state = new InMemoryPlatformState();
  const store = new TurnJournalStore({ state, clock: p.clock, initiation: p.initiation });
  const unexpected = async () => assert.fail("unconfigured journal invoked application work");
  await assert.rejects(store.read(unexpected, p.call()), DependencyUnavailableError);
  assert.equal((await store.transact(ref("tx"), unexpected, p.call())).kind, "unavailable");
  assert.equal((await store.consumeAndInitiate({}, unexpected, p.call())).kind, "unavailable");
});

test("M01.2 configured state supplies all repository methods and read-only projection", async () => {
  const h = await harness();
  await h.state.transact(async (unit) => {
    assert.deepEqual(Object.keys(unit.turnJournal).sort(), [...journalNames].sort());
  });
  await h.state.read(async (view) => {
    assert.equal(Object.keys(view.turnJournal).length, 13);
    assert.equal(view.turnJournal.admit, undefined);
    assert.equal(view.turnJournal.consumeAttempt, undefined);
  });
});

test("selected execution is explicitly unavailable in the memory journal", async () => {
  const h = await harness();
  for (const name of ["findExecution", "findExecutionInterruption"]) {
    assert.equal((await h.read((j, call) => j[name]({}, call))).kind, "unavailable");
  }
  for (const name of ["retainExecutionStart", "retainExecutionInterruption"]) {
    assert.equal(committed(await h.write((j, call) => j[name]({}, call))).kind, "unavailable");
  }
  assert.equal(
    committed(
      await h.write((j, call) =>
        j.consumeAttempt(
          h.issue("consumption", {
            operation: h.v.consumption,
            binding: h.v.binding,
            executionIntent: {},
          }),
          call,
        ),
      ),
    ).kind,
    "unavailable",
  );
});

test("M01.3 configuration is complete, bounded and owned", async () => {
  for (const n of [0, -1, 100001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const p = storageProvenance({ capacity: { maxOwnersPerInstallation: n } });
    assert.throws(() => new InMemoryPlatformState({ turnJournal: p.options }), TypeError);
  }
  const p = storageProvenance({ capacity: { maxOwnersPerInstallation: 1 } });
  const state = new InMemoryPlatformState({ turnJournal: p.options });
  p.options.capacity.maxOwnersPerInstallation = 100000;
  const owner = await seedJournalOwner(state);
  const store = new TurnJournalStore({ state, clock: p.clock, initiation: p.initiation });
  const call = p.call();
  assert.equal(
    committed(
      await store.transact(
        ref("tx"),
        (j) => j.admit(p.issue("admission", journalValues(owner).observation), call),
        call,
      ),
    ).kind,
    "recorded",
  );
  assert.equal(
    committed(
      await store.transact(
        ref("tx"),
        (j) => j.admit(p.issue("admission", journalValues(owner).observation), call),
        call,
      ),
    ).kind,
    "unavailable",
  );
  const incomplete = new InMemoryPlatformState({ turnJournal: { ...p.options, bind: () => ({}) } });
  await assert.rejects(
    incomplete.read(async () => {}),
    TypeError,
  );
});

test("M01.4 journal begins empty after real repository setup and accepts no seeded records", async () => {
  const h = await harness();
  assert.equal((await attempt(h)).kind, "absent");
  assert.equal((await h.read((j, c) => j.findAdmission(eventLookup(h.v), c))).kind, "absent");
  assert.equal(
    (await h.state.read((v) => v.installations.getInstallation())).id,
    h.owner.installation.id,
  );
  // A caller's unrelated map is never the platform's journal state.
  const supplied = new Map([[h.v.attempt.attemptRef, h.v]]);
  const other = new InMemoryPlatformState({ turnJournal: h.journal, journalRecords: supplied });
  const store = new TurnJournalStore({
    state: other,
    clock: h.provenance.clock,
    initiation: h.provenance.initiation,
  });
  await other.transact((u) => u.installations.createInstallation(h.owner.installation));
  assert.equal(
    (await store.read((j) => j.findAttempt(h.v.attempt, h.call), h.call)).kind,
    "absent",
  );
  assert.equal(supplied.size, 1);
});

test("M02.1 one publication includes real journal, resource, work and audit effects", async () => {
  const gate = deferred(),
    entered = deferred();
  const h = await harness({
    auditSink: {
      append: async () => {
        entered.resolve();
        await gate.promise;
      },
    },
  });
  const audit = runtimeAudit(h.owner);
  const operation = {
    kind: "agent_revision",
    action: "reconcile",
    namespaceId: h.owner.namespace.id,
    resourceId: h.owner.revision.id,
    actorId: audit.actorId,
  };
  const config = {
    id: `cfg_${randomUUID()}`,
    namespaceId: h.owner.namespace.id,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
  };
  const writing = h.state.transact(async (unit) => {
    const result = await unit.turnJournal.admit(h.issue("admission", h.v.observation), h.call);
    assert.equal(result.kind, "recorded");
    await unit.configurations.createConfiguration(config);
    await unit.operations.append(operation);
    await unit.audit.append(audit);
  });
  await entered.promise;
  let observed = false;
  const reading = h.read(async (j, c) => {
    observed = true;
    return j.findAdmission(eventLookup(h.v), c);
  });
  await yields();
  assert.equal(observed, false);
  gate.resolve();
  await writing;
  assert.equal((await reading).kind, "found");
  assert.equal(
    (await h.state.read((v) => v.configurations.findConfiguration(h.owner.namespace.id, config.id)))
      .id,
    config.id,
  );
  assert.ok((await h.state.read((v) => v.audit.list())).some((e) => e.id === audit.id));
  same(
    h.state.pendingOperations().find((op) => op.resourceId === operation.resourceId),
    operation,
  );
});

test("M02.2 callback failure discards provisional journal and normal repository writes", async () => {
  const h = await harness(),
    audit = runtimeAudit(h.owner);
  const configuration = {
    id: `cfg_${randomUUID()}`,
    namespaceId: h.owner.namespace.id,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
  };
  const operation = {
    kind: "agent_revision",
    action: "reconcile",
    namespaceId: h.owner.namespace.id,
    resourceId: h.owner.revision.id,
    actorId: audit.actorId,
  };
  await assert.rejects(
    h.state.transact(async (unit) => {
      await unit.turnJournal.admit(h.issue("admission", h.v.observation), h.call);
      await unit.configurations.createConfiguration(configuration);
      await unit.operations.append(operation);
      await unit.audit.append(audit);
      throw new Error("callback failed");
    }),
    /callback failed/,
  );
  assert.equal((await attempt(h)).kind, "absent");
  assert.equal((await h.read((j, c) => j.findAdmission(eventLookup(h.v), c))).kind, "absent");
  assert.ok(!(await h.state.read((v) => v.audit.list())).some((e) => e.id === audit.id));
  assert.equal(
    await h.state.read((v) =>
      v.configurations.findConfiguration(h.owner.namespace.id, configuration.id),
    ),
    undefined,
  );
  assert.ok(!h.state.pendingOperations().some((op) => op.resourceId === operation.resourceId));
});

test("M02.3 caught mutation rejection poisons the whole memory transaction", async () => {
  const h = await harness(),
    audit = runtimeAudit(h.owner);
  await assert.rejects(
    h.state.transact(async (unit) => {
      await unit.turnJournal.admit(h.issue("admission", h.v.observation), h.call);
      await unit.turnJournal.allocateCheckpoint({}, h.call).catch(() => {});
      await unit.audit.append(audit);
    }),
  );
  assert.equal((await attempt(h)).kind, "absent");
  assert.ok(!(await h.state.read((v) => v.audit.list())).some((e) => e.id === audit.id));
});

test("M02.4 an actual audit sink rejection prevents local publication and claims", async () => {
  const h = await harness({
    auditSink: {
      append: async () => {
        throw new Error("external sink rejected");
      },
    },
  });
  await dispatched(h);
  let pending, unit;
  await assert.rejects(
    h.state.transact(async (u) => {
      unit = u;
      pending = await u.turnJournal.consumeAttempt(
        h.issue("consumption", { operation: h.v.consumption, binding: h.v.binding }),
        h.call,
      );
      await u.audit.append(runtimeAudit(h.owner));
    }),
    DependencyUnavailableError,
  );
  assert.equal(takeCommittedTurnJournalClaim(unit, pending.claim), undefined);
  assert.equal((await attempt(h)).record.consumption, null);
});

test("M02.5 separate product state instances never share process-local records", async () => {
  const h = await harness();
  await admit(h);
  const fresh = new InMemoryPlatformState({ turnJournal: h.journal });
  await seedJournalOwner(fresh);
  const store = new TurnJournalStore({
    state: fresh,
    clock: h.provenance.clock,
    initiation: h.provenance.initiation,
  });
  assert.notEqual(
    (await store.read((j) => j.findAttempt(h.v.attempt, h.call), h.call)).kind,
    "found",
  );
  assert.equal((await attempt(h)).kind, "found");
});

test("M03.1 accepted journal mutations serialize before each subsequent observation", async () => {
  const h = await harness();
  const gate = deferred();
  h.provenance.hold("admission", gate.promise);
  const writing = h.direct(async (j) => {
    const first = j.admit(h.issue("admission", h.v.observation), h.call);
    let readSettled = false;
    const finding = j.findAttempt(h.v.attempt, h.call).then((value) => {
      readSettled = true;
      return value;
    });
    const head = j.readHead(h.v.context, h.call);
    const second = j.admit(h.issue("admission", h.v.observation), h.call);
    await yields();
    try {
      assert.equal(readSettled, false);
    } finally {
      gate.resolve();
    }
    const [a, found, currentHead, b] = await Promise.all([first, finding, head, second]);
    assert.equal(found.kind, "found");
    assert.equal(found.record.phase, "admitted-undispatched");
    assert.equal(currentHead.kind, "unavailable");
    assert.equal(currentHead.reason, "unresolved-work");
    return [a, b];
  });
  const [a, b] = await writing;
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, false);
  same(a.incomingLink, b.incomingLink);
  assert.equal((await attempt(h)).record.version, 1);
});

test("M03.2 unawaited accepted success drains and unawaited failure rolls back", async () => {
  const h = await harness();
  await h.direct(async (j) => {
    void j.admit(h.issue("admission", h.v.observation), h.call);
  });
  assert.equal((await attempt(h)).kind, "found");
  const other = journalValues(h.owner);
  await assert.rejects(
    h.direct(async (j) => {
      void j.admit(h.issue("admission", other.observation), h.call);
      void j.allocateCheckpoint({}, h.call);
    }),
  );
  assert.equal((await h.read((j, c) => j.findAdmission(eventLookup(other), c))).kind, "absent");
});

test("M03.3 escaped projections close while already accepted work can drain", async () => {
  const h = await harness(),
    gate = deferred(),
    entered = deferred();
  h.provenance.hold("admission", gate.promise);
  let escaped;
  const writing = h.direct(async (j) => {
    escaped = j;
    void j.admit(h.issue("admission", h.v.observation), h.call);
    entered.resolve();
  });
  await entered.promise;
  await yields();
  await assert.rejects(escaped.findAttempt(h.v.attempt, h.call), ScopeViolationError);
  gate.resolve();
  await writing;
  assert.equal((await attempt(h)).kind, "found");
});

test("M03.4 failure drains accepted work then releases the next real writer", async () => {
  const h = await harness(),
    gate = deferred(),
    entered = deferred();
  h.provenance.hold("admission", gate.promise);
  const writing = h.direct(async (j) => {
    void j.admit(h.issue("admission", h.v.observation), h.call);
    entered.resolve();
    throw new Error("original failure");
  });
  const failure = assert.rejects(writing, /original failure/);
  await entered.promise;
  let next = false;
  const following = h.state.transact(async () => {
    next = true;
  });
  await yields();
  assert.equal(next, false);
  gate.resolve();
  await failure;
  await following;
  assert.equal(next, true);
  assert.equal((await attempt(h)).kind, "absent");
});

test("M03.5 abort during provenance and expiry before publication both withhold commit", async () => {
  const h = await harness(),
    gate = deferred(),
    control = new AbortController();
  h.provenance.hold("admission", gate.promise);
  const call = h.provenance.call({ signal: control.signal });
  const writing = h.write((j, c) => j.admit(h.issue("admission", h.v.observation), c), call);
  await yields();
  control.abort();
  gate.resolve();
  assert.equal((await writing).kind, "unavailable");
  assert.equal((await attempt(h)).kind, "absent");
  const hold = deferred(),
    entered = deferred();
  const timed = await harness({
    clocked: true,
    auditSink: {
      append: async () => {
        entered.resolve();
        await hold.promise;
      },
    },
  });
  const w = timed.state.transact(async (u) => {
    await u.turnJournal.admit(timed.issue("admission", timed.v.observation), timed.call);
    await u.audit.append(runtimeAudit(timed.owner));
  });
  const refused = assert.rejects(w, DependencyUnavailableError);
  await entered.promise;
  timed.advance(30001);
  hold.resolve();
  await refused;
  timed.fresh();
  assert.equal((await attempt(timed)).kind, "absent");
});

test("M04.1 only real publication enables the original outward unit's claim", async () => {
  const gate = deferred(),
    entered = deferred();
  const h = await harness({
    auditSink: {
      append: async () => {
        entered.resolve();
        await gate.promise;
      },
    },
  });
  await dispatched(h);
  let unit, claim;
  const writing = h.state.transact(async (u) => {
    unit = u;
    claim = (
      await u.turnJournal.consumeAttempt(
        h.issue("consumption", { operation: h.v.consumption, binding: h.v.binding }),
        h.call,
      )
    ).claim;
    await u.audit.append(runtimeAudit(h.owner));
  });
  await entered.promise;
  assert.equal(takeCommittedTurnJournalClaim(unit, claim), undefined);
  gate.resolve();
  await writing;
  same(takeCommittedTurnJournalClaim(unit, claim).operation, h.v.consumption);
  assert.equal(takeCommittedTurnJournalClaim(unit, claim), undefined);
});

test("M04.2 concurrent Store consumers invoke one external effect at most once", async () => {
  const h = await dispatched(await harness());
  const handle = h.issue("consumption", { operation: h.v.consumption, binding: h.v.binding });
  let effects = 0;
  const initiate = async (_attempt, guard) => {
    await guard.assertCurrent();
    effects++;
  };
  const results = await Promise.all([
    h.store.consumeAndInitiate(handle, initiate, h.call),
    h.store.consumeAndInitiate(handle, initiate, h.call),
  ]);
  assert.deepEqual(results.map((r) => r.kind).sort(), ["already-consumed", "initiated"]);
  assert.equal(effects, 1);
});

test("M04.3 the initiation callback reads the actually committed attempt", async () => {
  const h = await dispatched(await harness());
  let seen;
  const result = await h.store.consumeAndInitiate(
    h.issue("consumption", { operation: h.v.consumption, binding: h.v.binding }),
    async (_attempt, guard) => {
      await guard.assertCurrent();
      seen = await attempt(h);
      await guard.assertCurrent();
    },
    h.call,
  );
  assert.equal(result.kind, "initiated");
  same(seen.record.consumption.operation, h.v.consumption);
});

test("M04.4 copied, foreign and readback values cannot create original claim membership", async () => {
  const h = await dispatched(await harness());
  let unit, claim;
  await h.state.transact(async (u) => {
    unit = u;
    claim = (
      await u.turnJournal.consumeAttempt(
        h.issue("consumption", { operation: h.v.consumption, binding: h.v.binding }),
        h.call,
      )
    ).claim;
  });
  assert.equal(takeCommittedTurnJournalClaim(unit, copy(claim)), undefined);
  assert.equal(takeCommittedTurnJournalClaim({}, claim), undefined);
  assert.equal(
    takeCommittedTurnJournalClaim(unit, {
      operation: (await attempt(h)).record.consumption.operation,
    }),
    undefined,
  );
  assert.ok(takeCommittedTurnJournalClaim(unit, claim));
  assert.equal(takeCommittedTurnJournalClaim(unit, claim), undefined);
});

test("M04.5 real rollback leaves consumption absent and invokes no initiation", async () => {
  const h = await dispatched(await harness());
  let claim, unit;
  await assert.rejects(
    h.state.transact(async (u) => {
      unit = u;
      claim = (
        await u.turnJournal.consumeAttempt(
          h.issue("consumption", { operation: h.v.consumption, binding: h.v.binding }),
          h.call,
        )
      ).claim;
      throw new Error("rollback");
    }),
    /rollback/,
  );
  assert.equal(takeCommittedTurnJournalClaim(unit, claim), undefined);
  assert.equal((await attempt(h)).record.consumption, null);
  let calls = 0;
  h.provenance.setAllowed(false);
  assert.notEqual(
    (
      await h.store.consumeAndInitiate(
        h.issue("consumption", { operation: h.v.consumption, binding: h.v.binding }),
        async () => {
          calls++;
        },
        h.call,
      )
    ).kind,
    "initiated",
  );
  assert.equal(calls, 0);
});

test("M04.6 callback throw, actual abort and elapsed start deadline stay execution-unknown", async () => {
  for (const mode of ["throw", "abort", "expiry"]) {
    const control = new AbortController();
    const h = await dispatched(await harness({ clocked: true }));
    const call = h.provenance.call({ signal: control.signal });
    let calls = 0;
    const result = await h.store.consumeAndInitiate(
      h.issue("consumption", { operation: h.v.consumption, binding: h.v.binding }),
      async (_a, guard) => {
        calls++;
        if (mode === "throw") throw new Error("external effect acknowledgement missing");
        if (mode === "abort") control.abort();
        else h.advance(5001);
        await guard.assertCurrent();
      },
      call,
    );
    assert.equal(result.kind, "execution-unknown");
    assert.equal(calls, 1);
    h.fresh();
    assert.equal(
      (
        await h.store.consumeAndInitiate(
          h.issue("consumption", { operation: h.v.consumption, binding: h.v.binding }),
          async () => assert.fail("consumed operation replayed"),
          h.call,
        )
      ).kind,
      "already-consumed",
    );
  }
});

test("M05.1 value arguments are captured before a queued mutation runs", async () => {
  const h = await consumed(await harness()),
    gate = deferred();
  h.provenance.hold("outcome", gate.promise);
  const running = {
    ...copy(h.v.outcome),
    outcome: {
      kind: "running",
      nativeSessionRef: ref("session"),
      nativeTurnRef: ref("native-turn"),
    },
  };
  const allocation = copy(h.v.allocation),
    original = copy(allocation);
  await h.direct(async (j) => {
    const first = j.recordOutcome(h.issue("outcome", running), h.call);
    const second = j.allocateCheckpoint(allocation, h.call);
    allocation.checkpointId = ref("caller-mutated-checkpoint");
    gate.resolve();
    assert.equal((await first).kind, "recorded");
    assert.equal((await second).kind, "allocated");
  });
  same((await h.read((j, c) => j.findCheckpointAllocation(original, c))).allocation, original);
  assert.equal((await h.read((j, c) => j.findCheckpointAllocation(allocation, c))).kind, "absent");
});

test("M05.2 mutation of the first provenance observation cannot alter the retained comparison", async () => {
  const p = storageProvenance(),
    originalBind = p.options.bind;
  let first,
    inspections = 0;
  p.options.bind = (context) => {
    const ports = originalBind(context),
      inspect = ports.admission.inspect;
    return {
      ...ports,
      admission: {
        ...ports.admission,
        inspect: async (...args) => {
          const observed = await inspect(...args);
          if ("kind" in observed) return observed;
          inspections++;
          if (inspections === 1) {
            first = observed;
            return observed;
          }
          if (inspections === 2) {
            first.identity.principalRef = ref("changed-principal");
            return first;
          }
          return observed;
        },
      },
    };
  };
  const h = await harness({ provenance: p });
  assert.equal((await admit(h)).kind, "denied");
  assert.equal((await attempt(h)).kind, "absent");
});

test("M05.3 returned nested values cannot mutate later committed readback", async () => {
  const h = await harness(),
    result = await admit(h);
  const expected = plain(result);
  assert.throws(() => {
    result.record.identity.principalRef = "changed";
  }, TypeError);
  assert.throws(() => {
    result.incomingLink.originalReceiptRefs.push("foreign");
  }, TypeError);
  same(await admit(h), expected);
  const current = await attempt(h);
  assert.throws(() => {
    current.record.binding.expectedHead.creationRef = "changed";
  }, TypeError);
  same((await attempt(h)).record.binding.expectedHead, h.v.head);
});

test("M05.4 copied handles, malformed values and bounded-call failures never allocate", async () => {
  const h = await harness(),
    handle = h.issue("admission", h.v.observation);
  assert.equal((await h.write((j, c) => j.admit(copy(handle), c)).then(committed)).kind, "denied");
  await assert.rejects(
    h.direct((j) =>
      j.allocateCheckpoint({ ...h.v.allocation, operationRef: "x".repeat(1025) }, h.call),
    ),
  );
  await assert.rejects(
    h.read((j, c) => j.findAttempt({ ...h.v.attempt, extra: { unexpected: true } }, c)),
  );
  const invalid = h.provenance.call({ deadline: "invalid" });
  assert.equal((await h.write((j, c) => j.admit(handle, c), invalid)).kind, "unavailable");
  assert.equal((await attempt(h)).kind, "absent");
});

test("M06.1 duplicate-before-busy retains accepted, busy and denied original decisions", async () => {
  const h = await harness();
  await admit(h);
  const busy = journalValues(h.owner);
  assert.equal((await admit(h, busy)).record.decision.kind, "busy");
  assert.equal((await admit(h)).record.decision.kind, "accepted");
  await dispatch(h);
  await consume(h);
  await recordOutcome(h);
  await release(h);
  assert.equal((await admit(h, busy)).record.decision.kind, "busy");
  const rejected = journalValues(h.owner);
  assert.equal(
    committed(await h.write((j, c) => j.admitRejected(h.issue("rejected", rejected.rejected), c)))
      .kind,
    "recorded",
  );
  const result = await admit(h, rejected);
  assert.equal(result.kind, "rejected-existing");
  assert.equal(result.record.decision.kind, "denied");
});

test("M06.2 changed payload retains original owner and exact conflict incoming link", async () => {
  const h = await harness(),
    original = await admit(h);
  const changed = changedIncoming(h.v, (v) => {
    v.envelope.message.contentDigest = digest();
  });
  const result = await admit(h, changed);
  assert.equal(result.kind, "conflict");
  assert.equal(result.incomingLink.disposition, "conflict");
  same((await h.read((j, c) => j.findAdmission(eventLookup(h.v), c))).record, original.record);
  const exact = await h.read((j, c) => j.findIncomingLink(incomingLookup(changed.identity), c));
  assert.equal(exact.kind, "found");
  same(exact.link, result.incomingLink);
  assert.equal(
    (
      await h.read((j, c) =>
        j.findIncomingLink(
          { ...incomingLookup(changed.identity), incomingContentDigest: digest() },
          c,
        ),
      )
    ).kind,
    "absent",
  );
});

test("M06.3 event and logical collisions retain two distinct owners", async () => {
  const h = await harness(),
    first = await admit(h);
  const second = changedIncoming(h.v, (v) => {
    v.envelope.event.providerEventRef = ref("second-event");
    v.envelope.message.providerMessageRef = ref("second-message");
  });
  const saved = await admit(h, second);
  const collision = changedIncoming(h.v, (v) => {
    v.envelope.message.providerMessageRef = second.envelope.message.providerMessageRef;
  });
  const result = await admit(h, collision);
  assert.equal(result.kind, "conflict");
  assert.deepEqual(
    [...result.incomingLink.originalReceiptRefs].sort(),
    [first.record.identity.receipt.receiptRef, saved.record.identity.receipt.receiptRef].sort(),
  );
  same((await h.read((j, c) => j.findAdmission(logicalLookup(second), c))).record, saved.record);
});

test("M06.4 rejected original replay and a distinct logical retry keep exact dispositions", async () => {
  const h = await harness();
  const original = committed(
    await h.write((j, c) => j.admitRejected(h.issue("rejected", h.v.rejected), c)),
  );
  assert.equal(original.kind, "recorded");
  const exact = committed(
    await h.write((j, c) => j.admitRejected(h.issue("rejected", h.v.rejected), c)),
  );
  assert.equal(exact.kind, "existing");
  assert.equal(exact.incomingLink.disposition, "original");
  same(exact.incomingLink, original.incomingLink);
  const retry = changedIncoming(h.v, (v) => {
    v.envelope.event.providerEventRef = ref("logical-retry");
  });
  const logical = committed(
    await h.write((j, c) => j.admitRejected(h.issue("rejected", retry.rejected), c)),
  );
  assert.equal(logical.kind, "existing");
  assert.equal(logical.incomingLink.disposition, "duplicate");
  same(logical.record, original.record);
});

test("M06.5 resolved, rejected and non-turn readback carriers remain distinct", async () => {
  const h = await harness(),
    accepted = await admit(h);
  const resolved = committed(
    await h.write((j, c) => j.admitRejected(h.issue("rejected", h.v.rejected), c)),
  );
  assert.equal(resolved.kind, "resolved-existing");
  same(resolved.record, accepted.record);
  const other = journalValues(h.owner);
  await h.write((j, c) => j.admitRejected(h.issue("rejected", other.rejected), c)).then(committed);
  assert.equal(
    (await h.read((j, c) => j.findAdmission(eventLookup(other), c))).kind,
    "found-rejected",
  );
  assert.equal(
    (await h.read((j, c) => j.findRejectedAdmission(eventLookup(other), c))).kind,
    "found",
  );
  const non = copy(h.v.nonTurn);
  non.classification = "unaddressed-original";
  non.logicalMessage = { kind: "equivalent-original", logicalMessageKey: digest() };
  await h.write((j, c) => j.admitNonTurn(h.issue("nonTurn", non), c)).then(committed);
  const lookup = {
    schemaVersion: 1,
    kind: "event",
    installationRef: non.installationRef,
    channelInstallationRef: non.channelInstallationRef,
    eventKey: non.eventKey,
  };
  assert.equal((await h.read((j, c) => j.findAdmission(lookup, c))).kind, "found-non-turn");
  assert.equal((await h.read((j, c) => j.findRejectedAdmission(lookup, c))).kind, "absent");
});

test("M06.6 non-turn equivalent ownership and related-only correlation cannot execute", async () => {
  const h = await harness();
  const non = {
    ...copy(h.v.nonTurn),
    classification: "bot-original",
    eventKey: h.v.receipt.eventKey,
    eventDigest: h.v.receipt.eventDigest,
    logicalMessage: {
      kind: "equivalent-original",
      logicalMessageKey: h.v.receipt.logicalMessageKey,
    },
  };
  const owned = committed(await h.write((j, c) => j.admitNonTurn(h.issue("nonTurn", non), c)));
  assert.equal(owned.kind, "recorded");
  assert.equal((await admit(h)).kind, "non-turn-owned");
  assert.equal((await attempt(h)).kind, "absent");
  const related = {
    ...copy(h.v.nonTurn),
    eventKey: digest(),
    logicalMessage: { kind: "related-only", logicalMessageKey: h.v.receipt.logicalMessageKey },
  };
  assert.equal(
    committed(await h.write((j, c) => j.admitNonTurn(h.issue("nonTurn", related), c))).kind,
    "recorded",
  );
  const found = await h.read((j, c) => j.findNonTurnIntake(related, c));
  assert.equal(found.kind, "found");
  assert.equal(committed(await h.write((j, c) => j.admitNonTurn({}, c))).kind, "not-responsible");
  const typing = {
    ...copy(h.v.nonTurn),
    classification: "typing-control",
    eventKey: digest(),
    logicalMessage: { kind: "not-applicable" },
  };
  assert.equal(
    committed(await h.write((j, c) => j.admitNonTurn(h.issue("nonTurn", typing), c))).kind,
    "recorded",
  );
});

test("M06.7 full scope tuples and distinct contexts retain their real Agent gate", async () => {
  const h = await harness();
  // Supported context references use the workspace contract's alphabet. Distinct
  // conversations still share the same whole-Agent reservation gate.
  const first = journalValues(h.owner, { conversationRef: "thread/a" });
  const second = journalValues(h.owner, { conversationRef: "thread" });
  assert.equal((await admit(h, first)).record.decision.kind, "accepted");
  assert.equal((await admit(h, second)).record.decision.kind, "busy");
  assert.equal((await h.read((j, c) => j.findAttempt(second.attempt, c))).kind, "absent");
  const foreign = { ...first.attempt, installationRef: `ins_${randomUUID()}` };
  assert.equal((await h.read((j, c) => j.findAttempt(foreign, c))).kind, "denied");
  same(
    (await h.read((j, c) => j.findAttempt(first.attempt, c))).record.binding.attempt,
    first.attempt,
  );
});

test("M07.1 each configured record capacity fails closed without evicting originals", async () => {
  for (const field of [
    "maxOwnersPerInstallation",
    "maxIncomingLinksPerInstallation",
    "maxAttemptsPerInstallation",
  ]) {
    const h = await harness({ capacity: { [field]: 1 } });
    await admit(h);
    const otherOwner = {
      ...(await seedRuntimeOwner(h.state)),
      channelInstallation: h.owner.channelInstallation,
    };
    const other = journalValues(otherOwner);
    assert.equal((await admit(h, other)).kind, "unavailable");
    assert.equal((await h.read((j, c) => j.findAdmission(eventLookup(h.v), c))).kind, "found");
    assert.equal((await admit(h)).kind, "recorded");
    assert.equal((await h.read((j, c) => j.findAttempt(other.attempt, c))).kind, "absent");
  }
});

test("M07.2 distinct incoming linkage consumes capacity while exact retry does not", async () => {
  const h = await harness({ capacity: { maxIncomingLinksPerInstallation: 2 } });
  const original = await admit(h);
  const retry = changedIncoming(h.v, (v) => {
    v.envelope.event.providerEventRef = ref("retry");
  });
  const duplicate = await admit(h, retry);
  assert.equal(duplicate.duplicate, true);
  same((await admit(h)).incomingLink, original.incomingLink);
  const third = changedIncoming(h.v, (v) => {
    v.envelope.event.providerEventRef = ref("third");
  });
  assert.equal((await admit(h, third)).kind, "unavailable");
  same(
    (await h.read((j, c) => j.findIncomingLink(incomingLookup(retry.identity), c))).link,
    duplicate.incomingLink,
  );
});

test("M07.3 only 32 pending common reservations fit and expiry alone does not free one", async () => {
  const h = await harness({ clocked: true });
  await admit(h);
  for (let i = 1; i < 32; i++) {
    const owner = {
      ...(await seedRuntimeOwner(h.state)),
      channelInstallation: h.owner.channelInstallation,
    };
    assert.equal(
      (await admit(h, journalValues(owner, { now: h.now() }))).record.decision.kind,
      "accepted",
    );
  }
  const owner = {
    ...(await seedRuntimeOwner(h.state)),
    channelInstallation: h.owner.channelInstallation,
  };
  const blocked = journalValues(owner, { now: h.now() });
  assert.equal((await admit(h, blocked)).kind, "unavailable");
  h.advance(30001);
  h.fresh();
  const later = journalValues(owner, { now: h.now() });
  assert.equal((await admit(h, later)).kind, "unavailable");
  // Only an exact cancellation plus independently supplied release observation
  // changes the product reservation; no timeout scavenger exists.
  const cancelled = committed(
    await h.write((j, c) => j.commitCancellation(h.issue("cancellation", h.v.cancellation), c)),
  );
  assert.equal(cancelled.outcome, "cancelled-before-dispatch");
  assert.equal((await release(h)).result.kind, "released");
  assert.equal((await admit(h, later)).record.decision.kind, "accepted");
});

test("M07.4 one reservation covers every conversation of an Agent but not another Agent", async () => {
  const h = await harness();
  await admit(h);
  const otherThread = journalValues(h.owner);
  assert.equal((await admit(h, otherThread)).record.decision.kind, "busy");
  const owner = {
    ...(await seedRuntimeOwner(h.state)),
    channelInstallation: h.owner.channelInstallation,
  };
  const otherAgent = journalValues(owner);
  assert.equal((await admit(h, otherAgent)).record.decision.kind, "accepted");
  assert.equal((await h.read((j, c) => j.readHead(h.v.context, c))).reason, "unresolved-work");
});

test("M07.5 common admission never synthesizes dispatch and cannot renew intake time", async () => {
  const h = await harness({ clocked: true });
  await admit(h);
  const initial = (await attempt(h)).record;
  assert.equal(initial.phase, "admitted-undispatched");
  assert.equal(initial.consumption, null);
  for (const field of ["dispatchOperationRef", "authorityDecisionRef", "expiresAt"])
    assert.equal(field in initial.binding, false);
  h.advance(30001);
  h.fresh();
  assert.equal((await dispatch(h)).kind, "denied");
  same((await attempt(h)).record, initial);
});

test("M08.1 the original common attempt transitions to one intent and one consumption", async () => {
  const h = await dispatched(await harness());
  assert.equal((await attempt(h)).record.version, 2);
  assert.equal((await dispatch(h)).kind, "existing");
  assert.equal((await consume(h)).kind, "claim-pending");
  assert.equal((await consume(h)).kind, "already-consumed");
  const current = (await attempt(h)).record;
  assert.equal(current.version, 3);
  same(current.binding, h.v.binding);
  same(current.consumption.operation, h.v.consumption);
});

test("M08.2 stale binding, changed authority and expired calls do not retarget an attempt", async () => {
  const h = await harness();
  await admit(h);
  for (const change of [
    (v) => {
      v.expectedHead.headVersion++;
    },
    (v) => {
      v.reservation.reservationVersion++;
    },
    (v) => {
      v.identity.gatewayAssignment.id = randomUUID();
    },
    (v) => {
      v.attempt.attemptRef = ref("foreign-attempt");
    },
  ]) {
    const binding = copy(h.v.binding);
    change(binding);
    const result = committed(
      await h.write((j, c) => j.recordDispatchIntent(h.issue("dispatch", binding), c)),
    );
    assert.notEqual(result.kind, "recorded");
  }
  const revoked = h.issue("dispatch", h.v.binding);
  h.provenance.revoke(revoked);
  assert.equal(
    committed(await h.write((j, c) => j.recordDispatchIntent(revoked, c))).kind,
    "denied",
  );
  const expired = h.provenance.call({ deadline: new Date(Date.now() - 1).toISOString() });
  assert.equal(
    (await h.write((j, c) => j.recordDispatchIntent(h.issue("dispatch", h.v.binding), c), expired))
      .kind,
    "unavailable",
  );
  assert.equal((await attempt(h)).record.phase, "admitted-undispatched");
});

test("M08.3 held public head is unresolved while owned completion checks can publish", async () => {
  const h = await consumed(await harness());
  assert.equal((await h.read((j, c) => j.readHead(h.v.context, c))).reason, "unresolved-work");
  const published = await complete(h);
  assert.equal((await h.read((j, c) => j.readHead(h.v.context, c))).reason, "unresolved-work");
  assert.equal((await release(h)).result.kind, "released");
  const head = await h.read((j, c) => j.readHead(h.v.context, c));
  assert.equal(head.kind, "completed");
  same(head.checkpoint, published.result.record.checkpoint);
});

test("M08.4 running, unknown and terminal outcomes retain the original immutable consumption", async () => {
  const h = await consumed(await harness());
  for (const kind of ["running", "outcome-unknown", "failed"]) {
    assert.equal((await recordOutcome(h, kind)).result.kind, "recorded");
    same((await attempt(h)).record.consumption.operation, h.v.consumption);
    assert.equal((await consume(h)).kind, "already-consumed");
  }
  assert.equal((await h.read((j, c) => j.readHead(h.v.context, c))).reason, "unresolved-work");
});

test("M09.1 allocation retains the exact checkpoint identity and refuses replacement", async () => {
  const h = await consumed(await harness());
  assert.equal(
    committed(await h.write((j, c) => j.allocateCheckpoint(h.v.allocation, c))).kind,
    "allocated",
  );
  same(
    (await h.read((j, c) => j.findCheckpointAllocation(h.v.allocation, c))).allocation,
    h.v.allocation,
  );
  assert.equal(
    committed(await h.write((j, c) => j.allocateCheckpoint(h.v.allocation, c))).kind,
    "existing",
  );
  for (const allocation of [
    { ...copy(h.v.allocation), checkpointId: ref("replacement") },
    { ...copy(h.v.allocation), operationRef: ref("replacement-operation") },
  ])
    assert.equal(
      committed(await h.write((j, c) => j.allocateCheckpoint(allocation, c))).kind,
      "conflict",
    );
});

test("M09.2 completion atomically retains one head, outcome and completed delivery intent", async () => {
  const h = await consumed(await harness()),
    publication = await complete(h);
  const current = (await attempt(h)).record;
  assert.equal(current.outcome.kind, "completed");
  assert.equal(current.version, 4);
  assert.equal(publication.result.record.head.headVersion, 2);
  assert.equal(publication.result.record.head.completionSequence, 1);
  same(current.outcome.checkpoint, publication.result.record.checkpoint);
  const slot = await h.read((j, c) => j.findDelivery(publication.result.record.pendingDelivery, c));
  assert.equal(slot.kind, "pending");
  same(slot.operation, publication.result.record.pendingDelivery);
  same(
    (await h.read((j, c) => j.findCompletion(publication.observation.operation, c))).record,
    publication.result.record,
  );
});

test("M09.3 mismatched completion evidence cannot partially publish", async () => {
  const h = await consumed(await harness());
  assert.equal(
    committed(await h.write((j, c) => j.allocateCheckpoint(h.v.allocation, c))).kind,
    "allocated",
  );
  const before = (await attempt(h)).record;
  for (const change of [
    (v) => {
      v.operation.expectedAttemptVersion++;
    },
    (v) => {
      v.operation.expectedCompletionSequence++;
    },
    (v) => {
      v.workspaceCompletionRef = ref("foreign-flush");
    },
    (v) => {
      v.gatewayAssignment.id = randomUUID();
    },
    (v) => {
      v.reservation.reservationVersion++;
    },
    (v) => {
      v.canonical.checkpointRef.checkpointId = ref("foreign-checkpoint");
    },
    (v) => {
      v.nativeTerminalEvidenceRef = "";
    },
    (v) => {
      v.noMutatorEvidenceRef = "";
    },
  ]) {
    const observation = copy(h.v.completion);
    change(observation);
    const result = await h.write((j, c) =>
      j.publishCompleted(h.issue("completion", observation), c),
    );
    assert.ok(
      result.kind !== "committed" || !["published", "existing"].includes(result.value.kind),
    );
    same((await attempt(h)).record, before);
    assert.equal(
      (await h.read((j, c) => j.findCompletion(h.v.completionOperation, c))).kind,
      "absent",
    );
    assert.equal((await h.read((j, c) => j.findDelivery(h.v.delivery, c))).kind, "unavailable");
  }
});

test("M09.4 reconciliation preserves original completion lineage and terminal restrictions", async () => {
  for (const stage of ["execution", "checkpoint"]) {
    const h = await consumed(await harness());
    await recordOutcome(h, "outcome-unknown", {
      outcome: { kind: "outcome-unknown", stage, evidenceRef: ref("uncertainty") },
    });
    const publication = await complete(h);
    const repeated = committed(
      await h.write((j, c) =>
        j.publishCompleted(h.issue("completion", publication.observation), c),
      ),
    );
    assert.equal(repeated.kind, "existing");
    same(repeated.record, publication.result.record);
    const changed = copy(publication.observation);
    changed.operation.requestDigest = digest();
    assert.equal(
      committed(await h.write((j, c) => j.publishCompleted(h.issue("completion", changed), c)))
        .kind,
      "conflict",
    );
    assert.equal((await h.read((j, c) => j.findCompletion(changed.operation, c))).kind, "conflict");
  }
  for (const terminal of ["failed", "interrupted", "cancelled"]) {
    const h = await consumed(await harness());
    await h.write((j, c) => j.allocateCheckpoint(h.v.allocation, c)).then(committed);
    await recordOutcome(h, terminal);
    const observation = copy(h.v.completion);
    observation.operation.expectedAttemptVersion = (await attempt(h)).record.version;
    observation.pendingDelivery.outcomeVersion = observation.operation.expectedAttemptVersion + 1;
    assert.equal(
      committed(await h.write((j, c) => j.publishCompleted(h.issue("completion", observation), c)))
        .kind,
      "conflict",
    );
    assert.equal((await attempt(h)).record.outcome.kind, terminal);
  }
});

test("M09.5 absent status reads allocate nothing and invoke no evidence producer", async () => {
  const h = await harness(),
    before = h.provenance.inspections.length;
  for (const [method, value] of [
    ["findCheckpointAllocation", h.v.allocation],
    ["findCompletion", h.v.completionOperation],
    ["findCancellation", h.v.cancellation],
    ["findRelease", h.v.release],
  ])
    assert.equal((await h.read((j, c) => j[method](value, c))).kind, "absent");
  assert.equal((await h.read((j, c) => j.readHead(h.v.context, c))).reason, "store-unavailable");
  assert.equal(h.provenance.inspections.length, before);
  assert.equal((await attempt(h)).kind, "absent");
});

test("M10.1 outcomes retain exact historical operations and refuse changed replay", async () => {
  const h = await consumed(await harness());
  const running = await recordOutcome(h, "running");
  assert.equal(running.result.kind, "recorded");
  await recordOutcome(h, "outcome-unknown");
  const repeated = committed(
    await h.write((j, c) => j.recordOutcome(h.issue("outcome", running.observation), c)),
  );
  assert.equal(repeated.kind, "existing");
  same(repeated.record, running.result.record);
  const changed = { ...copy(running.observation), requestDigest: digest() };
  assert.equal(
    committed(await h.write((j, c) => j.recordOutcome(h.issue("outcome", changed), c))).kind,
    "conflict",
  );
  await recordOutcome(h, "failed");
  assert.equal((await recordOutcome(h, "interrupted")).result.kind, "conflict");
  assert.equal((await attempt(h)).record.outcome.kind, "failed");
});

test("M10.2 nonfinal history exhaustion preserves reserved terminal and release capacity", async () => {
  const h = await consumed(await harness());
  for (let i = 0; i < 32; i++)
    assert.equal((await recordOutcome(h, "outcome-unknown")).result.kind, "recorded");
  const before = (await attempt(h)).record;
  const extra = {
    ...copy(h.v.outcome),
    operationRef: ref("overflow"),
    expectedAttemptVersion: before.version,
    outcome: { kind: "outcome-unknown", stage: "execution", evidenceRef: ref("still-unknown") },
  };
  assert.equal(
    (await h.write((j, c) => j.recordOutcome(h.issue("outcome", extra), c))).kind,
    "unavailable",
  );
  same((await attempt(h)).record, before);
  assert.equal(
    committed(await h.write((j, c) => j.allocateCheckpoint(h.v.allocation, c))).kind,
    "allocated",
  );
  assert.equal((await recordOutcome(h, "failed")).result.kind, "recorded");
  const released = await release(h);
  assert.equal(released.result.kind, "released");
  assert.equal((await h.read((j, c) => j.findRelease(released.observation, c))).kind, "released");
  assert.equal((await h.read((j, c) => j.readHead(h.v.context, c))).reason, "store-unavailable");
});

test("M10.3 common cancellation needs affirmative no-intent facts and preserves requester", async () => {
  const h = await harness();
  await admit(h);
  const cancellation = copy(h.v.cancellation);
  assert.notEqual(cancellation.requesterPrincipalRef, cancellation.originalPrincipalRef);
  const result = committed(
    await h.write((j, c) => j.commitCancellation(h.issue("cancellation", cancellation), c)),
  );
  assert.equal(result.outcome, "cancelled-before-dispatch");
  same((await h.read((j, c) => j.findCancellation(cancellation, c))).operation, cancellation);
  assert.equal((await attempt(h)).record.consumption, null);
  assert.equal((await h.read((j, c) => j.readHead(h.v.context, c))).reason, "unresolved-work");
  const uncertain = await harness();
  await admit(uncertain);
  await recordOutcome(uncertain, "outcome-unknown", {
    outcome: { kind: "outcome-unknown", stage: "before-dispatch", evidenceRef: ref("lost-ack") },
  });
  const op = {
    ...copy(uncertain.v.cancellation),
    expectedAttemptVersion: (await attempt(uncertain)).record.version,
  };
  assert.equal(
    committed(
      await uncertain.write((j, c) => j.commitCancellation(uncertain.issue("cancellation", op), c)),
    ).kind,
    "conflict",
  );
  assert.equal((await uncertain.read((j, c) => j.findCancellation(op, c))).kind, "absent");
});

test("M10.4 post-dispatch cancellation requests never prove termination or release", async () => {
  const h = await consumed(await harness());
  const operation = {
    ...copy(h.v.cancellation),
    expectedAttemptVersion: (await attempt(h)).record.version,
  };
  const result = committed(
    await h.write((j, c) => j.commitCancellation(h.issue("cancellation", operation), c)),
  );
  assert.equal(result.outcome, "requested");
  assert.equal((await attempt(h)).record.outcome.kind, "consumed");
  assert.equal((await release(h)).result.kind, "held");
  const another = { ...operation, operationRef: ref("second-cancel"), expectedAttemptVersion: 4 };
  assert.equal(
    committed(await h.write((j, c) => j.commitCancellation(h.issue("cancellation", another), c)))
      .kind,
    "conflict",
  );
  const completed = await consumed(await harness());
  await complete(completed);
  const late = { ...copy(completed.v.cancellation), expectedAttemptVersion: 4 };
  assert.equal(
    committed(
      await completed.write((j, c) =>
        j.commitCancellation(completed.issue("cancellation", late), c),
      ),
    ).kind,
    "too-late",
  );
});

test("M10.5 release requires exact current closed inventory and never follows expiry alone", async () => {
  const h = await consumed(await harness({ clocked: true }));
  await recordOutcome(h, "outcome-unknown");
  h.advance(60001);
  h.fresh();
  const before = (await attempt(h)).record;
  for (const change of [
    (v) => {
      delete v.noMutatorEvidenceRef;
    },
    (v) => {
      delete v.closedOwnerInventoryRef;
    },
    (v) => {
      v.closedOwnerInventoryVersion = 0;
    },
    (v) => {
      v.closedOwnerInventoryDigest = "unknown";
    },
    (v) => {
      v.workspace.bindingVersion++;
    },
    (v) => {
      v.reservation.reservationVersion++;
    },
    (v) => {
      v.expectedAttemptVersion--;
    },
    (v) => {
      v.attempt.attemptRef = ref("foreign-attempt");
    },
  ]) {
    const observation = { ...copy(h.v.release), expectedAttemptVersion: before.version };
    change(observation);
    const result = await h.write((j, c) =>
      j.releaseReservation(h.issue("release", observation), c),
    );
    assert.ok(result.kind !== "committed" || !["released", "existing"].includes(result.value.kind));
    assert.equal((await h.read((j, c) => j.readHead(h.v.context, c))).reason, "unresolved-work");
  }
  const released = await release(h);
  assert.equal(released.result.kind, "released");
  assert.equal(
    committed(
      await h.write((j, c) => j.releaseReservation(h.issue("release", released.observation), c)),
    ).kind,
    "existing",
  );
  assert.equal((await consume(h)).kind, "already-consumed");
});

test("M11.1 completed, status and cancellation slots have separate retained eligibility", async () => {
  const s = await status(await harness()),
    h = s.h;
  const cancel = {
    ...copy(h.v.cancellation),
    expectedAttemptVersion: (await attempt(h)).record.version,
  };
  assert.equal(
    committed(await h.write((j, c) => j.commitCancellation(h.issue("cancellation", cancel), c)))
      .outcome,
    "requested",
  );
  const cancellationAck = {
    ...copy(h.v.delivery),
    operationRef: ref("cancel-ack"),
    slot: "cancel-ack",
    outcomeVersion: (await attempt(h)).record.version,
  };
  assert.equal(
    committed(await h.write((j, c) => j.reserveDelivery(h.issue("delivery", cancellationAck), c)))
      .kind,
    "reserved",
  );
  const publication = await complete(h),
    completedOp = publication.result.record.pendingDelivery;
  assert.equal((await h.read((j, c) => j.findDelivery(completedOp, c))).kind, "pending");
  assert.equal(
    committed(await h.write((j, c) => j.reserveDelivery(h.issue("delivery", completedOp), c))).kind,
    "reserved",
  );
  assert.equal((await h.read((j, c) => j.findDelivery(s.operation, c))).kind, "recorded");
  assert.equal((await h.read((j, c) => j.findDelivery(cancellationAck, c))).kind, "pending");
});

test("M11.2 only bounded definitive-no-effect retries use the original delivery episode", async () => {
  const h = await consumed(await harness({ clocked: true }));
  const publication = await complete(h);
  const op = publication.result.record.pendingDelivery;
  let start;
  for (let i = 1; i <= 3; i++) {
    const reservation = committed(
      await h.write((j, c) => j.reserveDelivery(h.issue("delivery", op), c)),
    );
    assert.equal(reservation.kind, "reserved");
    assert.equal(reservation.attemptNumber, i);
    start ??= reservation.episodeStartedAt;
    assert.equal(reservation.episodeStartedAt, start);
    const outcome = {
      operation: op,
      deliveryAttemptRef: reservation.deliveryAttemptRef,
      outcome: { kind: "definitive-no-effect", retryClass: "transient" },
    };
    assert.equal(committed(await h.write((j, c) => j.recordDelivery(outcome, c))).kind, "recorded");
  }
  assert.equal(
    committed(await h.write((j, c) => j.reserveDelivery(h.issue("delivery", op), c))).kind,
    "existing",
  );
  const timed = await consumed(await harness({ clocked: true }));
  const done = await complete(timed);
  const reservation = committed(
    await timed.write((j, c) =>
      j.reserveDelivery(timed.issue("delivery", done.result.record.pendingDelivery), c),
    ),
  );
  await timed
    .write((j, c) =>
      j.recordDelivery(
        {
          operation: reservation.operation,
          deliveryAttemptRef: reservation.deliveryAttemptRef,
          outcome: { kind: "definitive-no-effect", retryClass: "transient" },
        },
        c,
      ),
    )
    .then(committed);
  timed.advance(120000);
  timed.fresh();
  assert.equal(
    committed(
      await timed.write((j, c) =>
        j.reserveDelivery(timed.issue("delivery", reservation.operation), c),
      ),
    ).kind,
    "existing",
  );
  same(
    (await timed.read((j, c) => j.findDelivery(reservation.operation, c))).record.operation,
    reservation.operation,
  );
});

test("M11.3 only known delivered prior-unknown status permits one strictly newer update", async () => {
  const s = await status(await harness()),
    h = s.h;
  const terminal = await recordOutcome(h, "failed");
  const update = updateStatus(s, terminal.result.record.version, "failed");
  for (const change of [
    (v) => {
      v.operation.providerMessageRef = ref("wrong-message");
    },
    (v) => {
      v.outcomeVersion = s.operation.outcomeVersion;
    },
    (v) => {
      v.replyDestinationRef = ref("different-destination");
    },
    (v) => {
      v.replyBindingVersion++;
    },
    (v) => {
      delete v.statusNoticeCode;
    },
  ]) {
    const wrong = copy(update);
    change(wrong);
    assert.notEqual(
      committed(await h.write((j, c) => j.reserveDelivery(h.issue("delivery", wrong), c))).kind,
      "reserved",
    );
  }
  const reserved = committed(
    await h.write((j, c) => j.reserveDelivery(h.issue("delivery", update), c)),
  );
  assert.equal(reserved.kind, "reserved");
  const recorded = {
    operation: update,
    deliveryAttemptRef: reserved.deliveryAttemptRef,
    outcome: { kind: "delivered", providerMessageRef: s.providerMessageRef },
  };
  assert.equal(committed(await h.write((j, c) => j.recordDelivery(recorded, c))).kind, "recorded");
  const second = {
    ...copy(update),
    operationRef: ref("second-update"),
    outputRef: ref("second-output"),
  };
  assert.notEqual(
    committed(await h.write((j, c) => j.reserveDelivery(h.issue("delivery", second), c))).kind,
    "reserved",
  );
  const unknown = await status(await harness(), "outcome-unknown", "delivery-unknown");
  const resolved = await recordOutcome(unknown.h, "failed");
  assert.notEqual(
    committed(
      await unknown.h.write((j, c) =>
        j.reserveDelivery(
          unknown.h.issue(
            "delivery",
            updateStatus(unknown, resolved.result.record.version, "failed"),
          ),
          c,
        ),
      ),
    ).kind,
    "reserved",
  );
  const unclassified = await consumed(await harness());
  const failed = await recordOutcome(unclassified, "failed");
  const legacy = {
    ...copy(unclassified.v.delivery),
    slot: "outcome-status",
    operationRef: ref("legacy"),
    outcomeVersion: failed.result.record.version,
  };
  assert.equal(
    committed(
      await unclassified.write((j, c) =>
        j.reserveDelivery(unclassified.issue("delivery", legacy), c),
      ),
    ).kind,
    "denied",
  );
});

test("M11.4 resolved-completed update binds original publication and preserves history", async () => {
  const s = await status(await harness()),
    h = s.h;
  assert.notEqual(
    committed(
      await h.write((j, c) =>
        j.reserveDelivery(h.issue("delivery", updateStatus(s, s.operation.outcomeVersion + 1)), c),
      ),
    ).kind,
    "reserved",
  );
  const publication = await complete(h),
    update = updateStatus(s, publication.result.record.outcomeVersion);
  assert.equal((await h.read((j, c) => j.readHead(h.v.context, c))).reason, "unresolved-work");
  const reserved = committed(
    await h.write((j, c) => j.reserveDelivery(h.issue("delivery", update), c)),
  );
  assert.equal(reserved.kind, "reserved");
  assert.equal(reserved.episodeStartedAt, s.reservation.episodeStartedAt);
  const retained = await h.read((j, c) => j.findCompletion(publication.observation.operation, c));
  same(retained.record.operation, publication.observation.operation);
  assert.notEqual(retained.record.operation.expectedAttemptVersion, s.operation.outcomeVersion - 1);
  same((await h.read((j, c) => j.findDelivery(s.operation, c))).record, s.outcome);
  assert.equal(
    (await h.read((j, c) => j.findDelivery(publication.result.record.pendingDelivery, c))).kind,
    "pending",
  );
});

test("M11.5 changed evidence and elapsed original update deadline cannot reserve", async () => {
  const p = storageProvenance(),
    bind = p.options.bind;
  let armed = false,
    count = 0;
  p.options.bind = (context) => {
    const ports = bind(context),
      inspect = ports.evidence.inspectDelivery;
    return {
      ...ports,
      evidence: {
        ...ports.evidence,
        inspectDelivery: async (...args) => {
          const observed = await inspect(...args);
          if (armed && !("kind" in observed) && ++count === 2)
            observed.outputRef = ref("changed-after-await");
          return observed;
        },
      },
    };
  };
  const changed = await status(await harness({ provenance: p })),
    done = await complete(changed.h);
  armed = true;
  const candidate = updateStatus(changed, done.result.record.outcomeVersion);
  assert.equal(
    committed(
      await changed.h.write((j, c) => j.reserveDelivery(changed.h.issue("delivery", candidate), c)),
    ).kind,
    "denied",
  );
  same(
    (await changed.h.read((j, c) => j.findDelivery(changed.operation, c))).record,
    changed.outcome,
  );
  const s = await status(await harness({ clocked: true })),
    h = s.h;
  const publication = await complete(h),
    update = updateStatus(s, publication.result.record.outcomeVersion);
  const handle = h.issue("delivery", update);
  h.provenance.revoke(handle);
  assert.equal(committed(await h.write((j, c) => j.reserveDelivery(handle, c))).kind, "denied");
  h.advance(120000);
  h.fresh();
  const result = committed(
    await h.write((j, c) => j.reserveDelivery(h.issue("delivery", update), c)),
  );
  assert.equal(result.kind, "existing");
  same(result.state.record, s.outcome);
  same((await h.read((j, c) => j.findDelivery(s.operation, c))).record, s.outcome);
  assert.equal((await h.read((j, c) => j.findDelivery(update, c))).kind, "unavailable");
});

test("M11.6 exact delivery recording is idempotent and unknown never becomes a resend", async () => {
  const s = await status(await harness(), "outcome-unknown", "delivery-unknown"),
    h = s.h;
  assert.equal(committed(await h.write((j, c) => j.recordDelivery(s.outcome, c))).kind, "existing");
  const changed = {
    ...copy(s.outcome),
    outcome: { kind: "delivered", providerMessageRef: ref("invented-message") },
  };
  assert.equal(committed(await h.write((j, c) => j.recordDelivery(changed, c))).kind, "conflict");
  const wrong = { ...copy(s.outcome), deliveryAttemptRef: ref("foreign-attempt") };
  assert.equal(committed(await h.write((j, c) => j.recordDelivery(wrong, c))).kind, "conflict");
  assert.equal(
    committed(await h.write((j, c) => j.reserveDelivery(h.issue("delivery", s.operation), c))).kind,
    "existing",
  );
  same((await h.read((j, c) => j.findDelivery(s.operation, c))).record, s.outcome);
});

test("M12.1 queued reads observe the complete publication and escaped projections close", async () => {
  const h = await harness(),
    entered = deferred(),
    gate = deferred();
  let escaped;
  const writer = h.state.transact(async (u) => {
    await u.turnJournal.admit(h.issue("admission", h.v.observation), h.call);
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  let invoked = false;
  const reading = h.state.read(async (v) => {
    invoked = true;
    escaped = v.turnJournal;
    return v.turnJournal.findAttempt(h.v.attempt, h.call);
  });
  await yields();
  assert.equal(invoked, false);
  gate.resolve();
  await writer;
  assert.equal((await reading).kind, "found");
  await assert.rejects(escaped.findAttempt(h.v.attempt, h.call));
});

test("M12.2 bounded reads retain queue abort, timeout and post-await lifetime refusal", async () => {
  const h = await harness(),
    gate = deferred(),
    entered = deferred();
  const writer = h.state.transact(async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  const abort = new AbortController();
  let callbacks = 0;
  const reading = h.state.read(
    async () => {
      callbacks++;
    },
    { signal: abort.signal, timeoutMs: 3000 },
  );
  abort.abort();
  await assert.rejects(reading, DependencyUnavailableError);
  const timed = h.state.read(
    async () => {
      callbacks++;
    },
    { signal: new AbortController().signal, timeoutMs: 1 },
  );
  await Promise.all([
    assert.rejects(timed, DependencyUnavailableError),
    new Promise((resolve) => setTimeout(resolve, 5)),
  ]);
  assert.equal(callbacks, 0);
  gate.resolve();
  await writer;
  await yields();
  assert.equal(callbacks, 0);
  await assert.rejects(
    h.state.read(
      async () => {
        callbacks++;
      },
      { signal: new AbortController().signal, timeoutMs: 3001 },
    ),
    DependencyUnavailableError,
  );
  const controller = new AbortController();
  await assert.rejects(
    h.state.read(
      async (v) => {
        await v.installations.getInstallation();
        controller.abort();
        await yields();
        await assert.rejects(v.turnJournal.findAttempt(h.v.attempt, h.call));
      },
      { signal: controller.signal, timeoutMs: 3000 },
    ),
    DependencyUnavailableError,
  );
});

test("M12.3 original memory resource, work and audit contract remains supported in both configurations", async () => {
  await verifyPlatformStateStoreContract(new InMemoryPlatformState());
  const provenance = storageProvenance();
  await verifyPlatformStateStoreContract(
    new InMemoryPlatformState({ turnJournal: provenance.options }),
  );
});
