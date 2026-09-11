import assert from "node:assert/strict";
import test from "node:test";
import { CompletedContextJournalService } from "../../packages/occ/src/turn-journal/completed-context.ts";
import * as values from "../fixtures/turn-journal-v1/values.mjs";

const assertData = (actual, expected, message) =>
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

const preparation = {
  ...values.attempt,
  expectedCompletionSequence: values.head.completionSequence,
  checkpointId: values.allocation.checkpointId,
  nativeTerminalEvidenceRef: "native-terminal-one",
  workspaceCompletionRef: values.checkpoint.workspaceCompletionRef,
};
const request = {
  allocation: values.allocation,
  operation: values.completionOperation,
  preparation,
  allocationTransactionRef: "transaction/allocation-one",
  publicationTransactionRef: "transaction/publication-one",
};
const reconciliation = {
  allocation: values.allocation,
  operation: values.completionOperation,
  checkpoint: values.checkpoint,
  publicationTransactionRef: request.publicationTransactionRef,
};

/** These recording port doubles test ONLY the real orchestration service's
 * ordering, binding checks, cancellation and unknown-outcome behavior. They do
 * not implement authenticated provenance, canonical byte storage, native terminal
 * verification, journal CAS, or PostgreSQL transactions. Those dependencies are
 * separate selected-provider integration obligations, including UPS05 below. */
function serviceProbe() {
  const calls = [];
  const controller = new AbortController();
  const authority = {
    // A sentinel is observed only by the port doubles, never accepted as a real
    // RuntimeAuthorityTrustedContextV1 by product authentication code.
    context: Object.freeze({ testOnlyContextSentinel: true }),
    requestRef: "request/checkpoint-one",
    recipientRef: "recipient/turn-journal",
    deadline: new Date(Date.now() + 30_000).toISOString(),
    signal: controller.signal,
  };
  const handle = Object.freeze({});
  const canonical = {
    kind: "verified",
    checkpointRef: values.checkpoint,
    verificationReceiptRef: "verification-one",
  };
  const observation = {
    operation: values.completionOperation,
    allocation: values.allocation,
    canonical,
    nativeTerminalEvidenceRef: preparation.nativeTerminalEvidenceRef,
    workspaceCompletionRef: preparation.workspaceCompletionRef,
    noMutatorEvidenceRef: "no-mutator-one",
    gatewayAssignment: values.identity.gatewayAssignment,
    harnessAssignment: values.identity.harnessAssignment,
    reservation: values.reservation,
    pendingDelivery: values.deliveryOperation,
  };
  const behavior = {
    allocation: { kind: "allocated", allocation: values.allocation },
    allocationRead: { kind: "found", allocation: values.allocation },
    completionRead: { kind: "published", record: values.completion },
    prepared: canonical,
    verified: canonical,
    evidence: handle,
    observation,
    published: { kind: "published", record: values.completion },
    allocationCommit: undefined,
    publicationCommit: undefined,
    before: async () => {},
  };
  async function record(name, args) {
    calls.push({ name, args });
    await behavior.before(name, args);
  }
  const read = {
    async findCheckpointAllocation(...args) {
      await record("findAllocation", args);
      return behavior.allocationRead;
    },
    async findCompletion(...args) {
      await record("findPublication", args);
      return behavior.completionRead;
    },
  };
  const unit = {
    ...read,
    async allocateCheckpoint(...args) {
      await record("allocate", args);
      return behavior.allocation;
    },
    async publishCompleted(...args) {
      await record("publish", args);
      return behavior.published;
    },
  };
  const service = new CompletedContextJournalService({
    store: {
      async read(work, call) {
        await record("read", [call]);
        return work(read);
      },
      async transact(ref, work, call) {
        await record("transact", [ref, call]);
        const value = await work(unit);
        const configured =
          ref === request.allocationTransactionRef
            ? behavior.allocationCommit
            : behavior.publicationCommit;
        await record("commit", [ref]);
        return configured ?? { kind: "committed", value };
      },
    },
    adapter: {
      async prepareCompleted(...args) {
        await record("prepare", args);
        return behavior.prepared;
      },
      async verify(...args) {
        await record("verify", args);
        return behavior.verified;
      },
    },
    evidence: {
      async verifyCompletion(...args) {
        await record("verifyEvidence", args);
        return behavior.evidence;
      },
      async inspectCompletion(...args) {
        await record("inspectEvidence", args);
        assert.equal(args[0], handle, "opaque handle is forwarded without cloning or decoding");
        return behavior.observation;
      },
    },
  });
  return {
    service,
    calls,
    behavior,
    authority,
    controller,
    handle,
    names: () => calls.map(({ name }) => name),
  };
}

test("checkpoint service waits for allocation commit and sequences adapter, evidence and publication ports", async () => {
  const probe = serviceProbe();
  const committed = Promise.withResolvers();
  const enteredCommit = Promise.withResolvers();
  probe.behavior.before = async (name, args) => {
    if (name === "commit" && args[0] === request.allocationTransactionRef) {
      enteredCommit.resolve();
      await committed.promise;
    }
  };
  const pending = probe.service.prepareAndPublish(request, probe.authority);
  await Promise.race([
    enteredCommit.promise,
    pending.then(() => {
      throw new Error("Service returned before allocation commit.");
    }),
  ]);
  assert.equal(
    probe.names().includes("prepare"),
    false,
    "provisional allocation cannot write bytes",
  );
  committed.resolve();
  const result = await pending;
  assert.equal(result.kind, "published");
  assertData(probe.names(), [
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
  ]);
  assertData(probe.calls.find(({ name }) => name === "prepare").args, [preparation]);
  assert.equal(probe.calls.find(({ name }) => name === "publish").args[0], probe.handle);
  for (const { name, args } of probe.calls) {
    if (
      [
        "transact",
        "allocate",
        "findAllocation",
        "verifyEvidence",
        "inspectEvidence",
        "publish",
      ].includes(name)
    ) {
      const call = args.at(-1);
      assert.equal(call.context, probe.authority.context);
      assert.equal(call.signal, probe.authority.signal);
      assert.equal(call.requestRef, probe.authority.requestRef);
      assert.equal(call.recipientRef, probe.authority.recipientRef);
      assert.equal(call.deadline, probe.authority.deadline);
      assert.equal(Object.isFrozen(call), true);
    }
  }
});

for (const kind of ["conflict", "denied", "unavailable"]) {
  test(`checkpoint service stops before gateway preparation when allocation is ${kind}`, async () => {
    const probe = serviceProbe();
    probe.behavior.allocation = { kind };
    assertData(await probe.service.prepareAndPublish(request, probe.authority), { kind });
    assertData(probe.names(), ["transact", "allocate", "commit"]);
  });
}

test("unknown allocation commit permits only exact status readback and never a preparation write", async () => {
  const probe = serviceProbe();
  probe.behavior.allocationCommit = {
    kind: "commit-unknown",
    transactionRef: request.allocationTransactionRef,
  };
  const result = await probe.service.prepareAndPublish(request, probe.authority);
  assertData(result, {
    kind: "commit-unknown",
    stage: "allocation",
    transactionRef: request.allocationTransactionRef,
    allocation: values.allocation,
    operation: values.completionOperation,
    nextAction: "exact-readback-only",
  });
  probe.behavior.allocationRead = { kind: "absent" };
  assertData(await probe.service.findAllocation(values.allocation, probe.authority), {
    kind: "absent",
  });
  assertData(probe.names(), ["transact", "allocate", "commit", "read", "findAllocation"]);
});

test("existing allocation cannot blindly repeat a gateway preparation write", async () => {
  const probe = serviceProbe();
  probe.behavior.allocation = { kind: "existing", allocation: values.allocation };
  const result = await probe.service.prepareAndPublish(request, probe.authority);
  assertData(result, {
    kind: "allocated-existing",
    allocation: values.allocation,
    operation: values.completionOperation,
    nextAction: "verify-existing-checkpoint-only",
  });
  assert.equal(probe.names().includes("prepare"), false);
});

test("known committed allocation reconciliation verifies the exact existing manifest without preparation", async () => {
  const probe = serviceProbe();
  const result = await probe.service.reconcileAndPublish(reconciliation, probe.authority);
  assert.equal(result.kind, "published");
  assertData(probe.names(), [
    "read",
    "findAllocation",
    "verify",
    "verifyEvidence",
    "inspectEvidence",
    "transact",
    "publish",
    "commit",
  ]);
  assertData(probe.calls.find(({ name }) => name === "verify").args, [
    values.context,
    values.checkpoint,
  ]);
});

test("reconciliation rejects a changed immutable manifest returned by the adapter", async () => {
  const probe = serviceProbe();
  probe.behavior.verified = structuredClone(probe.behavior.verified);
  probe.behavior.verified.checkpointRef.revisionLineageRef = "lineage-other";
  assert.equal(
    (await probe.service.reconcileAndPublish(reconciliation, probe.authority)).kind,
    "unavailable",
  );
  assertData(probe.names(), ["read", "findAllocation", "verify"]);
});

test("current allocation read denial after commit prevents entry to the gateway adapter", async () => {
  const probe = serviceProbe();
  probe.behavior.allocationRead = { kind: "denied" };
  assertData(await probe.service.prepareAndPublish(request, probe.authority), { kind: "denied" });
  assertData(probe.names(), ["transact", "allocate", "commit", "read", "findAllocation"]);
});

for (const kind of ["absent", "denied", "unavailable"]) {
  test(`reconciliation with ${kind} allocation does not call either gateway operation`, async () => {
    const probe = serviceProbe();
    probe.behavior.allocationRead = { kind };
    const result = await probe.service.reconcileAndPublish(reconciliation, probe.authority);
    assert.equal(result.kind, kind === "absent" ? "unavailable" : kind);
    assertData(probe.names(), ["read", "findAllocation"]);
  });
}

test("gateway preparation uncertainty retains the allocated checkpoint for verification only", async () => {
  const probe = serviceProbe();
  probe.behavior.before = async (name) => {
    if (name === "prepare") throw new Error("simulated gateway response loss");
  };
  const result = await probe.service.prepareAndPublish(request, probe.authority);
  assertData(result, {
    kind: "checkpoint-unresolved",
    allocation: values.allocation,
    operation: values.completionOperation,
    nextAction: "verify-existing-checkpoint-only",
  });
  assert.equal(probe.names().includes("verifyEvidence"), false);
  assert.equal(probe.names().includes("publish"), false);
});

test("selected adapter unavailability cannot become publication or an empty checkpoint", async () => {
  for (const method of ["prepareAndPublish", "reconcileAndPublish"]) {
    const probe = serviceProbe();
    probe.behavior.prepared = probe.behavior.verified = {
      kind: "unavailable",
      reasonCode: "writer-unresolved",
    };
    const result = await probe.service[method](
      method === "prepareAndPublish" ? request : reconciliation,
      probe.authority,
    );
    assertData(result, { kind: "unavailable", reasonCode: "writer-unresolved" });
    assert.equal(probe.names().includes("verifyEvidence"), false);
    assert.equal(probe.names().includes("publish"), false);
  }
});

test("changed operation, attempt, sequence or preparation binding is rejected before any provider access", async () => {
  for (const change of [
    (input) => {
      input.operation.attempt.attemptRef = "attempt-other";
    },
    (input) => {
      input.operation.checkpointId = "checkpoint-other";
    },
    (input) => {
      input.operation.expectedCompletionSequence += 1;
    },
    (input) => {
      input.preparation.reservationRef = "reservation-other";
    },
    (input) => {
      input.preparation.checkpointId = "checkpoint-other";
    },
    (input) => {
      input.preparation.expectedCompletionSequence += 1;
    },
  ]) {
    const probe = serviceProbe();
    const input = structuredClone(request);
    change(input);
    assert.ok(
      ["conflict", "denied"].includes(
        (await probe.service.prepareAndPublish(input, probe.authority)).kind,
      ),
    );
    assertData(probe.names(), []);
  }
});

for (const field of [
  "revisionLineageRef",
  "gatewayStoreBindingRef",
  "workspaceBindingRef",
  "workspaceCompletionRef",
  "producingGatewayAssignmentRef",
  "producerTuple",
  "contentDigest",
]) {
  test(`service rejects adapter/evidence manifest substitution in ${field}`, async () => {
    const probe = serviceProbe();
    const observation = structuredClone(probe.behavior.observation);
    const checkpoint = observation.canonical.checkpointRef;
    if (field === "producerTuple") checkpoint.producerTuple.artifactLedgerRef = "ledger-other";
    else if (field === "contentDigest") checkpoint[field] = "0".repeat(64);
    else if (field === "producingGatewayAssignmentRef")
      checkpoint[field] = "00000000-0000-4000-8000-000000000099";
    else checkpoint[field] = "other";
    probe.behavior.observation = observation;
    const result = await probe.service.prepareAndPublish(request, probe.authority);
    assert.ok(["conflict", "unavailable"].includes(result.kind));
    assert.equal(probe.names().includes("publish"), false);
  });
}

for (const change of [
  (observed) => {
    observed.operation.requestDigest = "0".repeat(64);
  },
  (observed) => {
    observed.allocation.operationRef = "allocation-other";
  },
  (observed) => {
    observed.nativeTerminalEvidenceRef = "native-terminal-other";
  },
  (observed) => {
    observed.workspaceCompletionRef = "workspace-completion-other";
  },
]) {
  test("service requires evidence for the exact allocated operation and preparation references", async () => {
    const probe = serviceProbe();
    const observed = structuredClone(probe.behavior.observation);
    change(observed);
    probe.behavior.observation = observed;
    assert.equal(
      (await probe.service.prepareAndPublish(request, probe.authority)).kind,
      "conflict",
    );
    assert.equal(probe.names().includes("publish"), false);
  });
}

for (const port of ["evidence", "observation"]) {
  for (const kind of ["denied", "unavailable"]) {
    test(`service stops publication when ${port} provider is ${kind}`, async () => {
      const probe = serviceProbe();
      probe.behavior[port] = { kind };
      assertData(await probe.service.prepareAndPublish(request, probe.authority), { kind });
      assert.equal(probe.names().includes("publish"), false);
    });
  }
}

test("call cancellation while gateway preparation is pending prevents late publication", async () => {
  const probe = serviceProbe();
  const entered = Promise.withResolvers();
  const completed = Promise.withResolvers();
  probe.behavior.before = async (name) => {
    if (name === "prepare") {
      entered.resolve();
      await completed.promise;
    }
  };
  const pending = probe.service.prepareAndPublish(request, probe.authority);
  await Promise.race([
    entered.promise,
    pending.then(() => {
      throw new Error("Service returned before gateway preparation.");
    }),
  ]);
  probe.controller.abort();
  assert.equal((await pending).kind, "checkpoint-unresolved");
  completed.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probe.names().includes("verifyEvidence"), false);
  assert.equal(probe.names().includes("publish"), false);
});

test("call cancellation after asynchronous evidence inspection cannot enter publication", async () => {
  const probe = serviceProbe();
  probe.behavior.before = async (name) => {
    if (name === "inspectEvidence") probe.controller.abort();
  };
  assert.equal(
    (await probe.service.prepareAndPublish(request, probe.authority)).kind,
    "unavailable",
  );
  assert.equal(probe.names().includes("publish"), false);
});

test("caller mutation during allocation cannot retarget the gateway preparation or current call", async () => {
  const probe = serviceProbe();
  const input = structuredClone(request);
  const call = { ...probe.authority };
  probe.behavior.before = async (name, args) => {
    if (name === "commit" && args[0] === request.allocationTransactionRef) {
      input.preparation.nativeTerminalEvidenceRef = "native-terminal-other";
      input.allocation.checkpointId = "checkpoint-other";
      call.recipientRef = "recipient/other";
    }
  };
  assert.equal((await probe.service.prepareAndPublish(input, call)).kind, "published");
  assertData(probe.calls.find(({ name }) => name === "prepare").args, [preparation]);
  assert.equal(
    probe.calls.find(({ name }) => name === "publish").args[1].recipientRef,
    probe.authority.recipientRef,
  );
});

test("missing, expired and aborted calls never reach a selected provider", async () => {
  for (const state of ["missing", "expired", "aborted"]) {
    const probe = serviceProbe();
    if (state === "aborted") probe.controller.abort();
    const call =
      state === "missing"
        ? undefined
        : state === "expired"
          ? { ...probe.authority, deadline: "2000-01-01T00:00:00.000Z" }
          : probe.authority;
    assert.equal((await probe.service.prepareAndPublish(request, call)).kind, "denied");
    assertData(probe.names(), []);
  }
});

test("unknown publication preserves original identities and status readback never repeats a write", async () => {
  const probe = serviceProbe();
  probe.behavior.publicationCommit = {
    kind: "commit-unknown",
    transactionRef: request.publicationTransactionRef,
  };
  assertData(await probe.service.prepareAndPublish(request, probe.authority), {
    kind: "commit-unknown",
    stage: "publication",
    transactionRef: request.publicationTransactionRef,
    allocation: values.allocation,
    operation: values.completionOperation,
    nextAction: "exact-readback-only",
  });
  const writes = probe.names().filter((name) => ["allocate", "prepare", "publish"].includes(name));
  assert.equal(
    (await probe.service.findPublication(values.completionOperation, probe.authority)).kind,
    "published",
  );
  probe.behavior.completionRead = { kind: "absent" };
  assert.equal(
    (await probe.service.findPublication(values.completionOperation, probe.authority)).kind,
    "absent",
  );
  assertData(
    probe.names().filter((name) => ["allocate", "prepare", "publish"].includes(name)),
    writes,
  );
});

test("malformed post-commit observations retain commit uncertainty instead of claiming success", async () => {
  for (const stage of ["allocation", "publication"]) {
    const probe = serviceProbe();
    if (stage === "allocation") probe.behavior.allocation = { kind: "allocated" };
    else probe.behavior.published = { kind: "published" };
    const result = await probe.service.prepareAndPublish(request, probe.authority);
    assert.equal(result.kind, "commit-unknown");
    assert.equal(result.stage, stage);
    assert.equal(result.nextAction, "exact-readback-only");
    if (stage === "allocation") assert.equal(probe.names().includes("prepare"), false);
  }
});

test("provenance ports cannot substitute a serializable published result for an opaque handle", async () => {
  for (const port of ["evidence", "observation"]) {
    const probe = serviceProbe();
    probe.behavior[port] = { kind: "published", record: values.completion };
    assert.equal(
      (await probe.service.prepareAndPublish(request, probe.authority)).kind,
      "unavailable",
    );
    assert.equal(probe.names().includes("publish"), false);
  }
});

// TODO(PER11 accepting composition): the original gateway/native/workspace and
// PostgreSQL owners must supply this exact local construction module. A URL or
// fixture-created authority is insufficient; absence preserves the unselected
// integration, while an explicit but incomplete selection fails.
const checkpointCompositionModule = process.env.OCC_TEST_CHECKPOINT_COMPOSITION_MODULE;
test(
  "UPS05 selected gateway CompletedStateAdapterV1 plus actual native/workspace evidence and PostgreSQL publication",
  {
    skip:
      checkpointCompositionModule === undefined
        ? "Unselected: supply OCC_TEST_CHECKPOINT_COMPOSITION_MODULE with the original admitted gateway/native/workspace/PostgreSQL composition."
        : false,
  },
  async (t) => {
    // Load the real SDK-bearing composition only for this explicit integration;
    // the unrelated recording-service cases above keep their original boundary.
    const {
      selectCheckpointCompositionV1,
      loadCheckpointCompositionV1,
      runCheckpointCompositionV1,
    } = await import("../fixtures/turn-journal-checkpoint/composition.ts");
    const selection = selectCheckpointCompositionV1(checkpointCompositionModule);
    assert.equal(selection.kind, "selected");
    if (selection.kind !== "selected") throw new Error("Checkpoint composition was not selected.");
    const open = await loadCheckpointCompositionV1(selection);
    await runCheckpointCompositionV1(open, t.signal);
  },
);
