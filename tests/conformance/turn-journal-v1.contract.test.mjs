import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTurnJournalV1,
  parseTurnJournalJsonV1,
  classifyJournalAdmissionV1,
  journalCompletionMatchesV1,
  journalOutcomeTransitionAllowedV1,
  journalReleaseMatchesV1,
  createJournalInitiatorV1,
  parseNonTurnIntakeV1,
  parseNonTurnReceiptV1,
  nonTurnReceiptMatchesV1,
} from "../../packages/contracts/src/turn-journal-v1.ts";
import * as v from "../fixtures/turn-journal-v1/values.mjs";

// These exercise the exported definition codecs/classifiers and commit-callback
// wrapper. They do not implement or certify journal/database/runtime persistence.
for (const [kind, value] of Object.entries({
  admissionIdentity: v.identity,
  admission: v.admission,
  head: v.head,
  attempt: v.attemptRecord,
  checkpointAllocation: v.allocation,
  completionOperation: v.completionOperation,
  completion: v.completion,
  releaseObservation: v.release,
  outcomeOperation: v.outcome,
  deliveryOperation: v.deliveryOperation,
})) {
  test(`strict ${kind} value round-trips and freezes`, () => {
    const parsed = parseTurnJournalJsonV1(kind, JSON.stringify(value));
    assert.equal(JSON.stringify(parsed), JSON.stringify(value));
    assert.equal(Object.isFrozen(parsed), true);
  });
}
for (const decision of [
  { kind: "busy" },
  { kind: "denied", reason: "not-current" },
  { kind: "ignored", reason: "non-turn" },
  v.admission.decision,
]) {
  test(`duplicate precedes busy and preserves sticky ${decision.kind}`, () => {
    const original = { ...v.admission, decision };
    const result = classifyJournalAdmissionV1({
      incoming: v.identity,
      byEvent: original,
      byLogicalMessage: original,
      agentReserved: true,
    });
    assert.equal(result.kind, "duplicate");
    assert.equal(JSON.stringify(result.original.decision), JSON.stringify(decision));
  });
}
for (const field of [
  "principalRef",
  "providerSubjectRef",
  "replyDestinationRef",
  "commonGrantRef",
  "routeKey",
]) {
  test(`changed immutable ${field} conflicts without replacing original`, () => {
    const incoming = v.copy(v.identity);
    incoming[field] = field === "routeKey" ? "0".repeat(64) : "changed";
    const result = classifyJournalAdmissionV1({
      incoming,
      byEvent: v.admission,
      byLogicalMessage: v.admission,
      agentReserved: false,
    });
    assert.equal(result.kind, "conflict");
    assert.deepEqual(result.originalReceiptRefs, [v.receipt.receiptRef]);
  });
}
test("changed payload conflicts; logical twin keeps original owner", () => {
  const changed = v.copy(v.identity);
  changed.receipt.contentDigest = "0".repeat(64);
  assert.equal(
    classifyJournalAdmissionV1({
      incoming: changed,
      byEvent: v.admission,
      byLogicalMessage: v.admission,
      agentReserved: false,
    }).kind,
    "conflict",
  );
  const twin = v.copy(v.identity);
  twin.locator.eventKey = "0".repeat(64);
  twin.receipt.eventKey = twin.locator.eventKey;
  twin.receipt.eventDigest = "1".repeat(64);
  assert.equal(
    classifyJournalAdmissionV1({
      incoming: twin,
      byEvent: null,
      byLogicalMessage: v.admission,
      agentReserved: true,
    }).kind,
    "duplicate",
  );
});
test("two distinct key owners conflict and both survive", () => {
  const other = v.copy(v.admission);
  other.identity.receipt.receiptRef = "receipt-two";
  const result = classifyJournalAdmissionV1({
    incoming: v.identity,
    byEvent: v.admission,
    byLogicalMessage: other,
    agentReserved: false,
  });
  assert.equal(result.kind, "conflict");
  assert.deepEqual(result.originalReceiptRefs, ["receipt-one", "receipt-two"]);
});
test("new independent event is busy while the Agent is reserved", () => {
  assert.equal(
    classifyJournalAdmissionV1({
      incoming: v.identity,
      byEvent: null,
      byLogicalMessage: null,
      agentReserved: true,
    }).kind,
    "busy",
  );
});
const completionInput = () => ({
  currentAttempt: v.copy(v.attemptRecord),
  currentHead: v.copy(v.head),
  allocation: v.copy(v.allocation),
  candidate: v.copy(v.completion),
  expectedAttemptVersion: 3,
});
test("completion definition matches one exact successor", () =>
  assert.equal(journalCompletionMatchesV1(completionInput()), true));
for (const mutation of ["head", "attempt", "assignment", "cancel", "checkpoint", "version"]) {
  test(`completion rejects stale or changed ${mutation}`, () => {
    const input = completionInput();
    if (mutation === "head") input.currentHead.headVersion++;
    if (mutation === "attempt") input.currentAttempt.binding.attempt.attemptRef = "attempt-two";
    if (mutation === "assignment")
      input.currentAttempt.binding.identity.harnessAssignment.id =
        "00000000-0000-4000-8000-000000000004";
    if (mutation === "cancel")
      input.currentAttempt.outcome = {
        kind: "cancelled",
        stage: "execution",
        evidenceRef: "cancel-terminal",
      };
    if (mutation === "checkpoint") input.allocation.checkpointId = "checkpoint-two";
    if (mutation === "version") input.expectedAttemptVersion++;
    assert.equal(journalCompletionMatchesV1(input), false);
  });
}
for (const kind of ["failed", "interrupted", "outcome-unknown", "cancelled"]) {
  test(`${kind} remains explicit without inferred successful completion`, () => {
    const operation = v.copy(v.outcome);
    operation.outcome.kind = kind;
    assert.equal(journalOutcomeTransitionAllowedV1(v.attemptRecord, operation), true);
    const candidate = completionInput();
    candidate.currentAttempt.outcome = operation.outcome;
    if (kind === "outcome-unknown") {
      candidate.currentAttempt.consumption = null;
      assert.throws(() => journalCompletionMatchesV1(candidate), /Invalid turn journal/);
    } else {
      assert.equal(journalCompletionMatchesV1(candidate), false);
    }
  });
}
test("cancel/outcome race requires exact version; completed outcome cannot regress", () => {
  const stale = v.copy(v.outcome);
  stale.expectedAttemptVersion--;
  assert.equal(journalOutcomeTransitionAllowedV1(v.attemptRecord, stale), false);
  const completed = v.copy(v.attemptRecord);
  completed.outcome = {
    kind: "completed",
    checkpoint: v.checkpoint,
    completionOperationRef: "completion-one",
  };
  assert.equal(journalOutcomeTransitionAllowedV1(completed, v.outcome), false);
});
test("release is exact original reservation and inventory observation only", () => {
  assert.equal(journalReleaseMatchesV1(v.attemptRecord, v.release), true);
  const stale = v.copy(v.release);
  stale.expectedAttemptVersion++;
  assert.equal(journalReleaseMatchesV1(v.attemptRecord, stale), false);
  assert.throws(() =>
    parseTurnJournalV1("releaseObservation", { ...v.release, leaseExpired: true }),
  );
  assert.throws(() =>
    parseTurnJournalV1("releaseObservation", { ...v.release, noMutatorEvidenceRef: undefined }),
  );
});
test("unknown delivery remains separate from completed head", () => {
  const unknown = parseTurnJournalV1("delivery", {
    operation: v.deliveryOperation,
    deliveryAttemptRef: "delivery-attempt-one",
    outcome: { kind: "delivery-unknown" },
  });
  assert.equal(unknown.outcome.kind, "delivery-unknown");
  assert.equal(
    parseTurnJournalV1("completion", v.completion).head.checkpointId,
    v.checkpoint.checkpointId,
  );
});
test("known-ID update is confined to outcome-status", () => {
  assert.throws(() =>
    parseTurnJournalV1("deliveryOperation", {
      ...v.deliveryOperation,
      operation: { kind: "update", providerMessageRef: "message-one" },
    }),
  );
});
for (const [name, make] of [
  ["unknown keys", () => ({ ...v.head, verified: true })],
  ["unsafe integer", () => ({ ...v.head, headVersion: Number.MAX_SAFE_INTEGER + 1 })],
  ["negative zero", () => ({ ...v.head, completionSequence: -0 })],
  ["foreign prototype", () => Object.assign(Object.create({ verified: true }), v.head)],
  ["unpaired Unicode", () => ({ ...v.head, creationRef: "\ud800" })],
  ["credential URL", () => ({ ...v.head, creationRef: "https://example.invalid/token" })],
])
  test(`decoder rejects ${name}`, () =>
    assert.throws(
      () => parseTurnJournalV1("head", make()),
      /^Error: Invalid turn journal V1 value\.$/,
    ));
test("decoder never invokes accessors", () => {
  let read = false;
  const value = { ...v.head };
  Object.defineProperty(value, "creationRef", {
    enumerable: true,
    get() {
      read = true;
      throw new Error("private text");
    },
  });
  assert.throws(() => parseTurnJournalV1("head", value));
  assert.equal(read, false);
});
for (const replacement of [
  '"headVersion":1,"headVersion":2',
  '"headVersion":1,"head\\u0056ersion":2',
  '"headVersion":1.00000000000000001',
  '"headVersion":1e0',
])
  test(`JSON rejects duplicate/rounded counter ${replacement}`, () =>
    assert.throws(() =>
      parseTurnJournalJsonV1(
        "head",
        JSON.stringify(v.head).replace('"headVersion":1', replacement),
      ),
    ));

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function initiatorHarness() {
  let time = 10,
    starts = 0;
  const commit = deferred();
  const claim = {
    operation: {
      schemaVersion: 1,
      attempt: v.attempt,
      operationRef: "consume-one",
      claimantRef: "claimant-one",
      requestDigest: "a".repeat(64),
    },
  };
  const signal = new AbortController();
  const call = { signal: signal.signal };
  const run = createJournalInitiatorV1({
    now: () => time,
    consume: async () => commit.promise,
    inspectCommittedClaim: async () => ({
      attempt: v.attempt,
      signal: signal.signal,
      validUntil: 5_010,
      assertCurrent: async () => {},
    }),
  });
  return {
    run,
    commit,
    claim,
    call,
    start: async () => {
      starts++;
    },
    get starts() {
      return starts;
    },
    set time(t) {
      time = t;
    },
    signal,
  };
}
test("transaction-local consumption does not start before outer commit", async () => {
  const h = initiatorHarness();
  const pending = h.run({}, h.start, h.call);
  await Promise.resolve();
  assert.equal(h.starts, 0);
  h.commit.resolve({ kind: "committed", value: { kind: "claim-pending", claim: h.claim } });
  assert.equal((await pending).kind, "initiated");
  assert.equal(h.starts, 1);
  assert.equal((await h.run({}, h.start, h.call)).kind, "already-consumed");
  assert.equal(h.starts, 1);
});
for (const kind of ["commit-unknown", "unavailable"])
  test(`${kind} never invokes initiation`, async () => {
    const h = initiatorHarness();
    h.commit.resolve({ kind, transactionRef: "transaction-one" });
    assert.equal((await h.run({}, h.start, h.call)).kind, kind);
    assert.equal(h.starts, 0);
  });
test("consumed ordinary status cannot return a fresh initiation", async () => {
  const h = initiatorHarness();
  h.commit.resolve({
    kind: "committed",
    value: { kind: "already-consumed", operation: h.claim.operation },
  });
  assert.equal((await h.run({}, h.start, h.call)).kind, "already-consumed");
  assert.equal(h.starts, 0);
});
test("guard expiry and cancellation suppress first effect after commit", async () => {
  for (const expired of [true, false]) {
    const h = initiatorHarness();
    const pending = h.run({}, h.start, h.call);
    if (expired) h.time = 5_010;
    else h.signal.abort();
    h.commit.resolve({ kind: "committed", value: { kind: "claim-pending", claim: h.claim } });
    assert.equal((await pending).kind, "execution-unknown");
    assert.equal(h.starts, 0);
  }
});
test("callback uncertainty is not retried", async () => {
  const h = initiatorHarness();
  h.commit.resolve({ kind: "committed", value: { kind: "claim-pending", claim: h.claim } });
  let calls = 0;
  const callback = async () => {
    calls++;
    throw new Error("unknown native acknowledgement");
  };
  assert.equal((await h.run({}, callback, h.call)).kind, "execution-unknown");
  assert.equal((await h.run({}, callback, h.call)).kind, "already-consumed");
  assert.equal(calls, 1);
});
test("non-turn related key cannot claim original logical ownership", () => {
  assert.equal(parseNonTurnIntakeV1(v.nonTurn).logicalMessage.kind, "related-only");
  assert.throws(() =>
    parseNonTurnIntakeV1({
      ...v.nonTurn,
      logicalMessage: { kind: "equivalent-original", logicalMessageKey: "b".repeat(64) },
    }),
  );
  assert.throws(() =>
    parseNonTurnIntakeV1({ ...v.nonTurn, logicalMessage: { kind: "not-applicable" } }),
  );
});
test("non-turn ACK correlation requires exact submitted link", () => {
  const receipt = parseNonTurnReceiptV1({
    schemaVersion: 1,
    receiptRef: "handling-one",
    intake: v.nonTurn,
    disposition: "ignored",
    incomingLinkRef: "link-one",
    originalReceiptRefs: ["receipt-one"],
    auditIntentRef: "audit-one",
  });
  assert.equal(nonTurnReceiptMatchesV1(v.nonTurn, receipt), true);
  assert.equal(
    nonTurnReceiptMatchesV1({ ...v.nonTurn, eventDigest: "0".repeat(64) }, receipt),
    false,
  );
});

import { createHash } from "node:crypto";
import {
  parseCompletedContextV1,
  parseCompletedContextJsonV1,
  canonicalCompletedContextSnapshotV1,
  digestCompletedContextSnapshotV1,
  verifyCompletedCheckpointSnapshotV1,
  requireMatchingCompletedCheckpointV1,
  requireMatchingNativeImportReceiptV1,
} from "../../packages/contracts/src/completed-context-v1.ts";
const snapshot = {
  ...v.context,
  format: "completed-context-text-v1",
  parentCheckpointId: null,
  canonicalGeneration: "canonical-one",
  canonicalThroughSequence: 2,
  transcriptRootDigest: "a".repeat(64),
  attachmentRefs: [],
  items: [
    {
      ordinal: 0,
      sourceEventRef: "event-one",
      turnRef: v.attempt.turnRef,
      attemptRef: v.attempt.attemptRef,
      kind: "user-text",
      actorRef: "principal-one",
      text: "Remember this fact.",
    },
    {
      ordinal: 1,
      sourceEventRef: "event-two",
      turnRef: v.attempt.turnRef,
      attemptRef: v.attempt.attemptRef,
      kind: "assistant-text",
      actorRef: "executor-one",
      text: "A quoted fact.\nCafé.",
    },
  ],
};
function exactCheckpoint() {
  const encoded = canonicalCompletedContextSnapshotV1(snapshot);
  return {
    ...v.checkpoint,
    byteLength: Buffer.byteLength(encoded),
    itemCount: 2,
    contentDigest: createHash("sha256").update(encoded).digest("hex"),
  };
}
test("canonical completed bytes have stable key order and exact Unicode", () => {
  const reordered = { items: snapshot.items, ...snapshot };
  const encoded = canonicalCompletedContextSnapshotV1(reordered);
  assert.equal(encoded.startsWith('{"agentRef":'), true);
  assert.equal(encoded.includes("A quoted fact.\\nCafé."), true);
  assert.equal(
    encoded.includes(
      '"actorRef":"principal-one","attemptRef":"attempt-one","kind":"user-text","ordinal":0',
    ),
    true,
  );
  assert.equal(
    digestCompletedContextSnapshotV1(snapshot),
    createHash("sha256").update(encoded).digest("hex"),
  );
  assert.equal(
    digestCompletedContextSnapshotV1({
      ...snapshot,
      items: [snapshot.items[0], { ...snapshot.items[1], text: "Changed" }],
    }) === digestCompletedContextSnapshotV1(snapshot),
    false,
  );
});
test("exact checkpoint verifies full snapshot and final successful attempt", () => {
  assert.equal(
    verifyCompletedCheckpointSnapshotV1(exactCheckpoint(), snapshot).checkpointRef.checkpointId,
    "checkpoint-one",
  );
  const changed = v.copy(snapshot);
  changed.items[1].attemptRef = "foreign-attempt";
  assert.throws(() => verifyCompletedCheckpointSnapshotV1(exactCheckpoint(), changed));
});
for (const field of [
  "workspaceCompletionRef",
  "revisionLineageRef",
  "gatewayStoreBindingRef",
  "producingHarnessAssignmentRef",
])
  test(`full immutable checkpoint comparison includes ${field}`, () => {
    const expected = exactCheckpoint();
    const actual = {
      ...expected,
      [field]:
        field === "producingHarnessAssignmentRef"
          ? "00000000-0000-4000-8000-000000000004"
          : "different",
    };
    assert.throws(() => requireMatchingCompletedCheckpointV1(expected, actual));
  });
test("native imported receipt binds exact operation, checkpoint and segment data", () => {
  const checkpointRef = exactCheckpoint();
  const input = {
    restoreRef: "restore-one",
    checkpointRef,
    snapshot,
    currentHarnessAssignmentRef: v.identity.harnessAssignment.id,
    currentAdmittedConfigurationRef: "configuration-one",
  };
  const receipt = {
    schemaVersion: 1,
    restoreRef: "restore-one",
    checkpointId: checkpointRef.checkpointId,
    nativeThreadRef: "thread-one",
    nativeContextSegmentRef: "segment-one",
    contextDigest: checkpointRef.contentDigest,
    itemCount: 2,
    currentHarnessAssignmentRef: v.identity.harnessAssignment.id,
    quietRestoreGeneration: "quiet-one",
  };
  assert.equal(
    requireMatchingNativeImportReceiptV1(input, receipt).nativeContextSegmentRef,
    "segment-one",
  );
  assert.throws(() =>
    requireMatchingNativeImportReceiptV1(input, { ...receipt, restoreRef: "restore-two" }),
  );
});
for (const [name, mutate] of [
  [
    "unknown native payload",
    (s) => {
      s.items[0].toolCall = {};
    },
  ],
  [
    "noncontiguous ordinal",
    (s) => {
      s.items[1].ordinal = 3;
    },
  ],
  [
    "unpaired Unicode",
    (s) => {
      s.items[0].text = "\ud800";
    },
  ],
  [
    "binary attachment",
    (s) => {
      s.attachmentRefs.push("file-one");
    },
  ],
  [
    "oversize encoded item",
    (s) => {
      s.items[0].text = "a".repeat(256 * 1024);
    },
  ],
  [
    "unsafe source sequence",
    (s) => {
      s.canonicalThroughSequence = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
])
  test(`completed snapshot rejects ${name}`, () => {
    const input = v.copy(snapshot);
    mutate(input);
    assert.throws(() => parseCompletedContextV1("canonicalSnapshot", input));
  });
for (const replacement of [
  '"ordinal":0,"ordinal":1',
  '"ordinal":0,"ord\\u0069nal":1',
  '"ordinal":0.000000000000000000001',
  '"ordinal":0e0',
  '"ordinal":-0',
])
  test(`completed JSON rejects duplicate or non-exact counter ${replacement}`, () => {
    assert.throws(() =>
      parseCompletedContextJsonV1(
        "canonicalSnapshot",
        JSON.stringify(snapshot).replace('"ordinal":0', replacement),
      ),
    );
  });
test("ready context must match its exact completion sequence", () => {
  assert.throws(() =>
    parseCompletedContextV1("contextState", {
      kind: "ready",
      expectedCompletionSequence: 2,
      checkpointRef: exactCheckpoint(),
      lookupVersion: "lookup-one",
    }),
  );
});
test("decoded checkpoint kind cannot authenticate its provenance", () => {
  const parsed = parseCompletedContextV1("verifiedCheckpoint", {
    kind: "verified",
    checkpointRef: exactCheckpoint(),
    verificationReceiptRef: "receipt-one",
  });
  assert.equal(Object.keys(parsed).length, 3);
  assert.equal(Object.getOwnPropertySymbols(parsed).length, 0);
});

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  parseTurnJournalResultV1,
  parseTurnJournalResultJsonV1,
  parseRejectedAdmissionV1,
  parseRejectedAdmissionJsonV1,
} from "../../packages/contracts/src/turn-journal-v1.ts";
const requireContracts = createRequire(
  new URL("../../packages/contracts/package.json", import.meta.url),
);
const sdk = await import(
  pathToFileURL(requireContracts.resolve("openclaw/plugin-sdk/channel-inbound")).href
);
const nativeEnvelope = {
  schemaVersion: 1,
  adapterProfileRef: "slack-private-mentioned-v1",
  platform: "slack",
  installationRef: v.context.installationRef,
  channelInstallationRef: v.locator.channelInstallationRef,
  providerTenantRef: "tenant-one",
  recipientAppRef: "app-one",
  sender: { kind: "human", providerSubjectRef: v.identity.providerSubjectRef },
  event: {
    providerEventRef: "event-one",
    eventKind: "app_mention",
    occurredAt: "2026-01-01T00:00:00.000000Z",
    eventDigest: "0".repeat(64),
  },
  message: {
    providerMessageRef: "message-one",
    logicalMessageKey: "0".repeat(64),
    contentDigest: v.receipt.contentDigest,
  },
  nativeConversation: {
    channelRef: "channel-one",
    scope: "slack-private-channel",
    rootThreadRef: "root-one",
  },
  replyBindingCandidateRef: "reply-candidate-one",
  contentRef: "content-one",
  receivedAt: "2026-01-01T00:00:00.000000Z",
  verifiedAt: "2026-01-01T00:00:00.000000Z",
  verifierEvidenceRef: "verification-one",
  deliveryRef: "transport-one",
};
nativeEnvelope.message.logicalMessageKey = sdk.hostedChannelLogicalMessageKeyV1(nativeEnvelope);
nativeEnvelope.event.eventDigest = sdk.digestHostedChannelEventV1(nativeEnvelope);
const rejectedReceipt = {
  ...v.receipt,
  eventKey: sdk.hostedChannelEventKeyV1(nativeEnvelope),
  logicalMessageKey: nativeEnvelope.message.logicalMessageKey,
  eventDigest: nativeEnvelope.event.eventDigest,
};
const rejected = {
  schemaVersion: 1,
  envelope: nativeEnvelope,
  receipt: rejectedReceipt,
  decision: { kind: "denied", reason: "not-current" },
  decisionRef: "denial-one",
  auditIntentRef: "audit-one",
  decidedAt: "2026-01-01T00:00:00.000Z",
};
test("authenticated unresolved-human denial persists without invented target", () => {
  const result = parseRejectedAdmissionV1(rejected);
  assert.equal(Object.hasOwn(result, "context"), false);
  assert.equal(Object.hasOwn(result, "principalRef"), false);
  const incoming = v.copy(v.identity);
  incoming.locator.eventKey = rejectedReceipt.eventKey;
  incoming.locator.logicalMessageKey = rejectedReceipt.logicalMessageKey;
  incoming.receipt = rejectedReceipt;
  incoming.routeKey = sdk.hostedChannelRouteKeyV1(nativeEnvelope);
  const classified = classifyJournalAdmissionV1({
    incoming,
    byEvent: result,
    byLogicalMessage: result,
    agentReserved: true,
  });
  assert.equal(classified.kind, "duplicate");
  assert.equal(classified.original.decision.kind, "denied");
});
test("rejected receipt cannot claim another event", () => {
  assert.throws(() =>
    parseRejectedAdmissionV1({
      ...rejected,
      receipt: { ...rejectedReceipt, eventKey: "0".repeat(64) },
    }),
  );
});
const incomingLink = {
  incomingLinkRef: "link-one",
  incomingIdentityDigest: "a".repeat(64),
  locator: v.locator,
  incomingEventDigest: v.receipt.eventDigest,
  incomingContentDigest: v.receipt.contentDigest,
  originalReceiptRefs: [v.receipt.receiptRef],
  disposition: "original",
  auditIntentRef: "audit-one",
};
const nonTurnReceipt = {
  schemaVersion: 1,
  receiptRef: "handling-one",
  intake: v.nonTurn,
  disposition: "ignored",
  incomingLinkRef: "nonturn-link-one",
  originalReceiptRefs: [],
  auditIntentRef: "audit-one",
};
for (const [kind, value] of Object.entries({
  admissionState: { kind: "found", record: v.admission },
  admissionResult: { kind: "recorded", record: v.admission, incomingLink, duplicate: false },
  attemptState: { kind: "found", record: v.attemptRecord },
  completionState: { kind: "published", record: v.completion },
  completionHead: { kind: "completed", head: v.completion.head, checkpoint: v.checkpoint },
  dispatchIntent: { kind: "existing", record: v.attemptRecord },
  checkpointAllocation: { kind: "allocated", allocation: v.allocation },
  completionPublication: { kind: "published", record: v.completion },
  outcome: { kind: "recorded", record: v.attemptRecord },
  cancellation: { kind: "too-late" },
  release: { kind: "held" },
  delivery: {
    kind: "recorded",
    record: {
      operation: v.deliveryOperation,
      deliveryAttemptRef: "delivery-attempt-one",
      outcome: { kind: "delivery-unknown" },
    },
  },
  deliveryReservation: {
    kind: "reserved",
    operation: v.deliveryOperation,
    deliveryAttemptRef: "delivery-attempt-one",
    attemptNumber: 1,
    episodeStartedAt: "2026-01-01T00:00:00.000Z",
  },
  incomingLink: { kind: "found", link: incomingLink, original: v.admission },
  nonTurn: { kind: "found", receipt: nonTurnReceipt },
  nonTurnResponsibility: { kind: "committed", receipt: nonTurnReceipt },
}))
  test(`${kind} result has a bounded closed wire codec`, () => {
    assert.equal(parseTurnJournalResultJsonV1(kind, JSON.stringify(value)).kind, value.kind);
    assert.throws(() => parseTurnJournalResultV1(kind, { ...value, initiationPermit: true }));
  });
test("method result JSON retains duplicate-key rejection", () => {
  assert.throws(() =>
    parseTurnJournalResultJsonV1(
      "release",
      '{"kind":"held","kind":"released","releaseOperationRef":"release-one"}',
    ),
  );
});

import { digestJournalAdmissionIdentityV1 } from "../../packages/contracts/src/turn-journal-v1.ts";
test("incoming identity digest preserves actor/target and excludes receipt allocation IDs", () => {
  const baseline = digestJournalAdmissionIdentityV1(v.identity);
  const retry = v.copy(v.identity);
  retry.receipt.receiptRef = "new-allocation";
  assert.equal(digestJournalAdmissionIdentityV1(retry), baseline);
  retry.principalRef = "different-human";
  assert.notEqual(digestJournalAdmissionIdentityV1(retry), baseline);
});

test("start guard enforces the first-effect deadline after callback awaits", async () => {
  const h = initiatorHarness();
  h.commit.resolve({ kind: "committed", value: { kind: "claim-pending", claim: h.claim } });
  let effects = 0;
  const result = await h.run(
    {},
    async (_attempt, guard) => {
      await Promise.resolve();
      h.time = 6_000;
      await guard.assertCurrent();
      effects++;
    },
    h.call,
  );
  assert.equal(result.kind, "execution-unknown");
  assert.equal(effects, 0);
});

test("committed claim cannot initiate a different exact attempt", async () => {
  const h = initiatorHarness();
  h.claim.operation.attempt = { ...v.attempt, attemptRef: "foreign-attempt" };
  h.commit.resolve({ kind: "committed", value: { kind: "claim-pending", claim: h.claim } });
  assert.equal((await h.run({}, h.start, h.call)).kind, "execution-unknown");
  assert.equal(h.starts, 0);
});

test("sticky unresolved-human owner has committed duplicate and exact readback carriers", () => {
  const link = {
    ...incomingLink,
    locator: {
      ...v.locator,
      eventKey: rejected.receipt.eventKey,
      logicalMessageKey: rejected.receipt.logicalMessageKey,
    },
    originalReceiptRefs: [rejected.receipt.receiptRef],
    disposition: "duplicate",
  };
  const result = parseTurnJournalResultV1("admissionResult", {
    kind: "rejected-existing",
    record: rejected,
    incomingLink: link,
  });
  assert.equal(result.record.receipt.receiptRef, rejected.receipt.receiptRef);
  assert.equal(
    parseTurnJournalResultV1("admissionState", { kind: "found-rejected", record: rejected }).kind,
    "found-rejected",
  );
  assert.equal(
    parseTurnJournalResultV1("incomingLink", { kind: "found-rejected", original: rejected, link })
      .kind,
    "found-rejected",
  );
  assert.throws(() =>
    parseTurnJournalResultV1("admissionResult", {
      kind: "rejected-existing",
      record: rejected,
      incomingLink: { ...link, disposition: "original" },
    }),
  );
});

test("exact prepared successful checkpoint can resolve an unknown original consumed attempt", () => {
  for (const stage of ["execution", "checkpoint"]) {
    const currentAttempt = {
      ...v.attemptRecord,
      outcome: { kind: "outcome-unknown", stage, evidenceRef: "unknown-evidence" },
    };
    assert.equal(
      journalCompletionMatchesV1({
        currentAttempt,
        currentHead: v.head,
        allocation: v.allocation,
        candidate: v.completion,
        expectedAttemptVersion: 3,
      }),
      true,
    );
    assert.throws(
      () =>
        journalCompletionMatchesV1({
          currentAttempt: { ...currentAttempt, consumption: null },
          currentHead: v.head,
          allocation: v.allocation,
          candidate: v.completion,
          expectedAttemptVersion: 3,
        }),
      /Invalid turn journal/,
    );
  }
  // Byte matching alone cannot replace the actual native/workspace provenance owner.
  for (const kind of ["failed", "interrupted", "cancelled"]) {
    assert.equal(
      journalCompletionMatchesV1({
        currentAttempt: {
          ...v.attemptRecord,
          outcome: { kind, stage: "execution", evidenceRef: "terminal-evidence" },
        },
        currentHead: v.head,
        allocation: v.allocation,
        candidate: v.completion,
        expectedAttemptVersion: 3,
      }),
      false,
    );
  }
});

test("running and terminal observations retain the immutable consumption", () => {
  assert.throws(() => parseTurnJournalV1("attempt", { ...v.attemptRecord, consumption: null }));
  assert.throws(() =>
    parseTurnJournalV1("attempt", {
      ...v.attemptRecord,
      consumption: {
        ...v.attemptRecord.consumption,
        operation: {
          ...v.attemptRecord.consumption.operation,
          attempt: { ...v.attempt, attemptRef: "other-attempt" },
        },
      },
    }),
  );
});

test("known-ID status update permits one attempted write", () => {
  const result = {
    kind: "reserved",
    operation: {
      ...v.deliveryOperation,
      slot: "outcome-status",
      operation: { kind: "update", providerMessageRef: "message-one" },
    },
    deliveryAttemptRef: "delivery-attempt-one",
    attemptNumber: 1,
    episodeStartedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(parseTurnJournalResultV1("deliveryReservation", result).attemptNumber, 1);
  assert.throws(() =>
    parseTurnJournalResultV1("deliveryReservation", { ...result, attemptNumber: 2 }),
  );
});

for (const [kind, value] of Object.entries({
  checkpointAllocationState: { kind: "found", allocation: v.allocation },
  cancellationState: {
    kind: "found",
    operation: {
      schemaVersion: 1,
      attempt: v.attempt,
      operationRef: "cancel-one",
      requesterPrincipalRef: "requester-one",
      originalPrincipalRef: v.identity.principalRef,
      expectedAttemptVersion: 3,
      requestDigest: "a".repeat(64),
    },
    outcome: "requested",
  },
  releaseState: { kind: "released", observation: v.release },
}))
  test(`${kind} supports exact status-only unknown-commit readback`, () => {
    assert.equal(parseTurnJournalResultV1(kind, value).kind, value.kind);
    assert.equal(parseTurnJournalResultV1(kind, { kind: "absent" }).kind, "absent");
    assert.throws(() => parseTurnJournalResultV1(kind, { ...value, initiate: true }));
  });

test("non-turn original ownership cannot be promoted by a later executable candidate", () => {
  const original = {
    ...nonTurnReceipt,
    intake: {
      ...v.nonTurn,
      eventKey: v.locator.eventKey,
      classification: "unaddressed-original",
      logicalMessage: {
        kind: "equivalent-original",
        logicalMessageKey: v.locator.logicalMessageKey,
      },
    },
  };
  const result = classifyJournalAdmissionV1({
    incoming: v.identity,
    byEvent: original,
    byLogicalMessage: original,
    agentReserved: false,
  });
  assert.equal(result.kind, "non-turn-owned");
  assert.equal(result.original.receiptRef, original.receiptRef);
  const link = {
    ...incomingLink,
    originalReceiptRefs: [original.receiptRef],
    disposition: "conflict",
  };
  assert.equal(
    parseTurnJournalResultV1("admissionResult", {
      kind: "non-turn-owned",
      original,
      incomingLink: link,
    }).kind,
    "non-turn-owned",
  );
  assert.equal(
    parseTurnJournalResultV1("admissionState", { kind: "found-non-turn", receipt: original }).kind,
    "found-non-turn",
  );
  assert.equal(
    parseTurnJournalResultV1("incomingLink", { kind: "found-non-turn", original, link }).kind,
    "found-non-turn",
  );
  assert.throws(() =>
    classifyJournalAdmissionV1({
      incoming: v.identity,
      byEvent: null,
      byLogicalMessage: {
        ...original,
        intake: {
          ...original.intake,
          classification: "edit",
          logicalMessage: { kind: "related-only", logicalMessageKey: v.locator.logicalMessageKey },
        },
      },
      agentReserved: false,
    }),
  );
});

for (const mutation of [
  "revision",
  "configuration",
  "creation",
  "reply-destination",
  "reply-version",
  "delivery-slot",
]) {
  test(`completion rejects changed immutable ${mutation}`, () => {
    const input = completionInput();
    if (mutation === "revision")
      input.candidate.checkpoint.revisionRef = "rev_00000000-0000-4000-8000-000000000099";
    if (mutation === "configuration")
      input.candidate.checkpoint.admittedConfigurationDigest = "9".repeat(64);
    if (mutation === "creation") input.candidate.head.creationRef = "foreign-creation";
    if (mutation === "reply-destination")
      input.candidate.pendingDelivery.replyDestinationRef = "foreign-destination";
    if (mutation === "reply-version") input.candidate.pendingDelivery.replyBindingVersion++;
    if (mutation === "delivery-slot") input.candidate.pendingDelivery.slot = "cancel-ack";
    assert.equal(journalCompletionMatchesV1(input), false);
  });
}

for (const [name, reference] of Object.entries({
  control: "ref\nvalue",
  whitespace: " ref ",
  url: "https://example.invalid/ref",
  utf8: "界".repeat(342),
})) {
  test(`standalone rejected admission rejects ${name} journal references consistently`, () => {
    const value = { ...rejected, decisionRef: reference };
    assert.throws(() => parseRejectedAdmissionV1(value));
    assert.throws(() => parseRejectedAdmissionJsonV1(JSON.stringify(value)));
    assert.throws(() =>
      parseTurnJournalResultV1("admissionState", { kind: "found-rejected", record: value }),
    );
  });
}
test("standalone rejected admission retains genuine SDK microsecond timestamp support", () => {
  assert.equal(
    parseRejectedAdmissionJsonV1(JSON.stringify(rejected)).envelope.event.occurredAt,
    nativeEnvelope.event.occurredAt,
  );
});

test("rejected admission result codec retains denied, resolved and non-turn original owners", () => {
  const deniedLink = {
    ...incomingLink,
    locator: {
      ...v.locator,
      eventKey: rejected.receipt.eventKey,
      logicalMessageKey: rejected.receipt.logicalMessageKey,
    },
    originalReceiptRefs: [rejected.receipt.receiptRef],
  };
  const nonTurnLink = {
    ...incomingLink,
    disposition: "conflict",
    originalReceiptRefs: [nonTurnReceipt.receiptRef, v.receipt.receiptRef],
  };
  for (const result of [
    { kind: "recorded", record: rejected, incomingLink: deniedLink },
    {
      kind: "existing",
      record: rejected,
      incomingLink: { ...deniedLink, disposition: "duplicate" },
    },
    {
      kind: "resolved-existing",
      record: v.admission,
      incomingLink: { ...incomingLink, disposition: "duplicate" },
    },
    { kind: "non-turn-owned", original: nonTurnReceipt, incomingLink: nonTurnLink },
    { kind: "conflict", originalReceipt: v.receipt, incomingLink: nonTurnLink },
    { kind: "unavailable" },
  ]) {
    assert.equal(
      parseTurnJournalResultJsonV1("rejectedAdmissionResult", JSON.stringify(result)).kind,
      result.kind,
    );
    assert.throws(() =>
      parseTurnJournalResultV1("rejectedAdmissionResult", { ...result, permit: true }),
    );
  }
  assert.equal(
    parseTurnJournalResultV1("rejectedAdmissionState", { kind: "found", record: rejected }).kind,
    "found",
  );
  assert.equal(
    parseTurnJournalResultV1("rejectedAdmissionState", { kind: "absent" }).kind,
    "absent",
  );
  assert.throws(() =>
    parseTurnJournalResultV1("rejectedAdmissionResult", {
      kind: "resolved-existing",
      record: v.admission,
      incomingLink,
    }),
  );
});
