import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CompletedStateError } from "openclaw/plugin-sdk/completed-state";
import {
  loadCheckpointCompositionV1,
  runCheckpointCompositionV1,
  selectCheckpointCompositionV1,
} from "../fixtures/turn-journal-checkpoint/composition.ts";
import * as values from "../fixtures/turn-journal-v1/values.mjs";

// These component cases exercise the real selector, acquisition/settlement
// boundary and upstream SDK constructor. Acquisition and cleanup are controlled
// peers. The database below is deliberately NOT an original canonical owner;
// its existing source-file path lets the SDK reach its ownership refusal without
// creating a database or executing SQL. No case supplies authenticated authority,
// native/workspace evidence, PostgreSQL publication, or successful preparation.
const sourcePath = fileURLToPath(import.meta.url);
const limits = { timeout: 5_000 };

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function observe(promise) {
  const observation = { settled: false, result: undefined };
  observation.result = promise.then(
    (value) => {
      observation.settled = true;
      return { kind: "fulfilled", value };
    },
    (error) => {
      observation.settled = true;
      return { kind: "rejected", error };
    },
  );
  return observation;
}

async function requireEntry(entry, observation, message) {
  await Promise.race([
    entry.promise,
    observation.result.then((result) => {
      throw new Error(message, {
        cause: result.kind === "rejected" ? result.error : undefined,
      });
    }),
  ]);
}

async function requirePending(observation, message) {
  // Yield one event-loop turn so an incorrectly detached result is observable.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observation.settled, false, message);
}

function binding() {
  return {
    ...values.context,
    canonicalSessionId: "component-canonical-session",
    gatewayStoreBindingRef: values.checkpoint.gatewayStoreBindingRef,
    workspaceBindingRef: values.checkpoint.workspaceBindingRef,
    revisionRef: values.checkpoint.revisionRef,
    admittedConfigurationDigest: values.checkpoint.admittedConfigurationDigest,
    revisionLineageRef: values.checkpoint.revisionLineageRef,
    producerTuple: { ...values.checkpoint.producerTuple },
  };
}

function controlledLease(signal, options = {}) {
  const events = [];
  function unexpected(name) {
    return () => {
      events.push(name);
      throw new Error(`Unexpected ${name}: no original authority was supplied.`);
    };
  }
  const lease = {
    canonical: {
      database: Object.freeze({ db: Object.freeze({}), path: sourcePath }),
      binding: { ...binding(), unexpectedField: "must-be-refused" },
      authority: { acquire: unexpected("canonical-authority") },
      redact: unexpected("redact"),
    },
    store: {
      read: unexpected("journal-read"),
      transact: unexpected("journal-transact"),
    },
    evidence: {
      verifyCompletion: unexpected("evidence-verify"),
      inspectCompletion: unexpected("evidence-inspect"),
    },
    publication: {
      allocation: values.allocation,
      operation: values.completionOperation,
      preparation: {
        ...values.attempt,
        expectedCompletionSequence: values.head.completionSequence,
        checkpointId: values.allocation.checkpointId,
        nativeTerminalEvidenceRef: "component-native-terminal-not-authenticated",
        workspaceCompletionRef: values.checkpoint.workspaceCompletionRef,
      },
      allocationTransactionRef: "transaction/component-allocation",
      publicationTransactionRef: "transaction/component-publication",
    },
    call: {
      // This sentinel never reaches a trusted authority owner: the SDK refuses
      // the canonical construction before journal/provenance operations begin.
      context: Object.freeze({ componentOnlyUnauthenticatedContext: true }),
      requestRef: "request/component-checkpoint",
      recipientRef: "recipient/component-journal",
      deadline: "9999-12-31T23:59:59.999Z",
      signal,
    },
    async assertCurrent() {
      assert.equal(this, lease, "the acquired lifecycle receiver is retained");
    },
    async settle() {
      assert.equal(this, lease, "settlement uses the original acquired receiver");
      events.push("settle-enter");
      await options.settle?.();
      events.push("settle-exit");
    },
  };
  return { lease, events };
}

function requireCorruptBinding(error) {
  assert.ok(error instanceof CompletedStateError, "the original SDK decoder refuses the binding");
  assert.equal(error.code, "checkpoint-corrupt");
  return true;
}

function requireNoCanonicalOrJournalEffects(events) {
  assert.equal(
    events.some((event) =>
      [
        "canonical-authority",
        "redact",
        "journal-read",
        "journal-transact",
        "evidence-verify",
        "evidence-inspect",
      ].includes(event),
    ),
    false,
    "constructor refusal cannot continue to authority, canonical content, evidence or journal work",
  );
}

test("checkpoint composition distinguishes absent selection from every explicit malformed selection", () => {
  assert.deepEqual(selectCheckpointCompositionV1(undefined), { kind: "unselected" });
  for (const value of [
    "",
    " ",
    "\t\n",
    "./checkpoint-provider.mjs",
    "checkpoint-provider.mjs",
    "https://example.invalid/checkpoint-provider.mjs",
    "data:text/javascript,export{}",
    "file://remote.invalid/checkpoint-provider.mjs",
    `${import.meta.url}?provider=one`,
    `${import.meta.url}#provider`,
  ]) {
    assert.throws(
      () => selectCheckpointCompositionV1(value),
      `explicit selection ${JSON.stringify(value)} must fail rather than become unselected`,
    );
  }
});

test("checkpoint composition preserves an explicitly selected local module as a file URL", () => {
  const expected = { kind: "selected", moduleUrl: pathToFileURL(sourcePath).href };
  assert.deepEqual(selectCheckpointCompositionV1(sourcePath), expected);
  assert.deepEqual(selectCheckpointCompositionV1(import.meta.url), expected);
});

test(
  "selected checkpoint modules fail when the real import or required owner export is absent",
  limits,
  async () => {
    // A regular source file cannot contain a child module. This provides a
    // guaranteed missing import without making any temporary fixture files.
    const missing = selectCheckpointCompositionV1(`${sourcePath}/missing-provider.mjs`);
    await assert.rejects(loadCheckpointCompositionV1(missing));

    // This evaluated conformance module deliberately exports no provider. The
    // genuine dynamic importer must reject it instead of supplying a default.
    const incomplete = selectCheckpointCompositionV1(sourcePath);
    await assert.rejects(loadCheckpointCompositionV1(incomplete), /openCheckpointCompositionV1/);
  },
);

for (const kind of ["synchronous", "asynchronous"]) {
  test(
    `checkpoint composition retains ${kind} acquisition failure and calls the selected owner once`,
    limits,
    async () => {
      const controller = new AbortController();
      const primary = new Error(`${kind} original acquisition failure`);
      const calls = [];
      function open(signal) {
        calls.push(signal);
        if (kind === "synchronous") throw primary;
        return Promise.reject(primary);
      }
      await assert.rejects(
        runCheckpointCompositionV1(open, controller.signal),
        (error) => error === primary,
      );
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0],
        controller.signal,
        "the original abort signal reaches the acquired owner",
      );
    },
  );
}

for (const shape of ["unknown field", "custom prototype", "accessor"]) {
  test(
    `checkpoint composition retains the SDK's refusal of a binding containing ${shape}`,
    limits,
    async () => {
      const controller = new AbortController();
      const { lease, events } = controlledLease(controller.signal);
      let getterCalls = 0;
      if (shape === "custom prototype") {
        lease.canonical.binding = Object.assign(Object.create({ inherited: true }), binding());
      }
      if (shape === "accessor") {
        lease.canonical.binding = binding();
        Object.defineProperty(lease.canonical.binding, "canonicalSessionId", {
          enumerable: true,
          get() {
            getterCalls += 1;
            return "getter-must-not-be-evaluated";
          },
        });
      }
      await assert.rejects(
        runCheckpointCompositionV1(async () => lease, controller.signal),
        requireCorruptBinding,
      );
      assert.equal(getterCalls, 0, "SDK-owned data decoding must not execute binding accessors");
      assert.deepEqual(events, ["settle-enter", "settle-exit"]);
      requireNoCanonicalOrJournalEffects(events);
    },
  );
}

test(
  "checkpoint composition uses the SDK's exact canonical database-owner check before any journal work",
  limits,
  async () => {
    const controller = new AbortController();
    const { lease, events } = controlledLease(controller.signal);
    lease.canonical.binding = binding();
    await assert.rejects(
      runCheckpointCompositionV1(async () => lease, controller.signal),
      /Completed state requires its exact live canonical database owner\./,
    );
    assert.deepEqual(events, ["settle-enter", "settle-exit"]);
    requireNoCanonicalOrJournalEffects(events);
  },
);

test(
  "checkpoint composition captures original settlement before reading other acquired properties",
  limits,
  async () => {
    const controller = new AbortController();
    const { lease, events } = controlledLease(controller.signal);
    const primary = new Error("original acquired canonical property failed");
    let replacementCalls = 0;
    Object.defineProperty(lease, "canonical", {
      get() {
        lease.settle = async () => {
          replacementCalls += 1;
        };
        throw primary;
      },
    });
    await assert.rejects(
      runCheckpointCompositionV1(async () => lease, controller.signal),
      (error) => error === primary,
    );
    assert.equal(replacementCalls, 0, "later mutation cannot replace the retained cleanup owner");
    assert.deepEqual(events, ["settle-enter", "settle-exit"]);
  },
);

test(
  "checkpoint composition captures an acquired settlement accessor once before constructor refusal",
  limits,
  async () => {
    const controller = new AbortController();
    const { lease, events } = controlledLease(controller.signal);
    const originalSettle = lease.settle;
    let settlementReads = 0;
    Object.defineProperty(lease, "settle", {
      get() {
        settlementReads += 1;
        if (settlementReads !== 1)
          throw new Error("a second settlement read lost the originally acquired cleanup");
        return originalSettle;
      },
    });
    // Checking the property and then reading it again to bind can lose the cleanup
    // function between those reads. Once obtained, the original function owns
    // settlement even when the following real SDK construction is refused.
    await assert.rejects(
      runCheckpointCompositionV1(async () => lease, controller.signal),
      requireCorruptBinding,
    );
    assert.equal(settlementReads, 1);
    assert.deepEqual(events, ["settle-enter", "settle-exit"]);
    requireNoCanonicalOrJournalEffects(events);
  },
);

test(
  "checkpoint composition joins asynchronous settlement before returning an SDK construction failure",
  limits,
  async () => {
    const controller = new AbortController();
    const entered = deferred();
    const release = deferred();
    const { lease, events } = controlledLease(controller.signal, {
      async settle() {
        entered.resolve();
        await release.promise;
      },
    });
    const observed = observe(runCheckpointCompositionV1(async () => lease, controller.signal));
    try {
      await requireEntry(
        entered,
        observed,
        "composition returned before joining acquired settlement",
      );
      await requirePending(
        observed,
        "the SDK failure is not returned while cleanup is outstanding",
      );
      assert.deepEqual(events, ["settle-enter"]);
    } finally {
      release.resolve();
    }
    const result = await observed.result;
    assert.equal(result.kind, "rejected");
    requireCorruptBinding(result.error);
    assert.deepEqual(events, ["settle-enter", "settle-exit"]);
  },
);

test(
  "checkpoint composition reports both the original failure and settlement failure in causal order",
  limits,
  async () => {
    const controller = new AbortController();
    const primary = new Error("original constructor-input acquisition failure");
    const cleanup = new Error("original resource settlement failure");
    const { lease, events } = controlledLease(controller.signal, {
      async settle() {
        throw cleanup;
      },
    });
    Object.defineProperty(lease, "canonical", {
      get() {
        throw primary;
      },
    });
    await assert.rejects(
      runCheckpointCompositionV1(async () => lease, controller.signal),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, primary);
        assert.equal(error.errors.length, 2);
        assert.equal(error.errors[0], primary);
        assert.equal(error.errors[1], cleanup);
        return true;
      },
    );
    assert.deepEqual(events, ["settle-enter"]);
  },
);

test(
  "checkpoint composition retains the real SDK failure when settlement also fails",
  limits,
  async () => {
    const controller = new AbortController();
    const cleanup = new Error("settlement failed after SDK refusal");
    const { lease, events } = controlledLease(controller.signal, {
      async settle() {
        throw cleanup;
      },
    });
    await assert.rejects(
      runCheckpointCompositionV1(async () => lease, controller.signal),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        requireCorruptBinding(error.errors[0]);
        assert.equal(error.cause, error.errors[0]);
        assert.equal(error.errors[1], cleanup);
        return true;
      },
    );
    assert.deepEqual(events, ["settle-enter"]);
    requireNoCanonicalOrJournalEffects(events);
  },
);

test(
  "checkpoint composition retains and joins a lease returned after acquisition was aborted",
  limits,
  async () => {
    const controller = new AbortController();
    const opened = deferred();
    const acquired = deferred();
    const settlementEntered = deferred();
    const settlementReleased = deferred();
    const abortReason = new Error("caller ended while original acquisition was pending");
    const { lease, events } = controlledLease(controller.signal, {
      async settle() {
        settlementEntered.resolve();
        await settlementReleased.promise;
      },
    });
    let canonicalReads = 0;
    Object.defineProperty(lease, "canonical", {
      get() {
        canonicalReads += 1;
        throw new Error("late aborted lease must be settled before canonical construction");
      },
    });
    let openCalls = 0;
    const observed = observe(
      runCheckpointCompositionV1(async (signal) => {
        openCalls += 1;
        assert.equal(signal, controller.signal);
        opened.resolve();
        return acquired.promise;
      }, controller.signal),
    );
    try {
      await requireEntry(opened, observed, "selected acquisition never started");
      controller.abort(abortReason);
      await requirePending(
        observed,
        "abort cannot detach an acquisition that may still yield a resource",
      );
      assert.deepEqual(events, []);
      acquired.resolve(lease);
      await requireEntry(
        settlementEntered,
        observed,
        "late acquired lease was not joined for settlement",
      );
      await requirePending(observed, "abort cannot detach the late lease's settlement");
      assert.equal(canonicalReads, 0, "an ended acquisition cannot start canonical work");
    } finally {
      acquired.resolve(lease);
      settlementReleased.resolve();
    }
    const result = await observed.result;
    assert.equal(
      result.kind,
      "rejected",
      "aborted acquisition must never become successful coverage",
    );
    assert.equal(openCalls, 1);
    assert.deepEqual(events, ["settle-enter", "settle-exit"]);
    assert.equal(canonicalReads, 0);
    requireNoCanonicalOrJournalEffects(events);
  },
);
