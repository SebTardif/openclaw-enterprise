import assert from "node:assert/strict";
import test from "node:test";
import {
  createPurgeManifestV1,
  initialPurgeProgressV1,
  parseRetirementPurgeV1,
} from "@openclaw-enterprise/contracts/retirement-purge-manifest-v1";
import { parseTurnJournalV1 } from "../../packages/contracts/src/turn-journal-v1.ts";
import {
  encodePurgeCallableV1,
  parsePurgeCallableV1,
  purgeHistoryMatchesV1,
} from "@openclaw-enterprise/contracts/retirement-purge-journal-v1";
import {
  REPLAY_BARRIER_CAPACITY_PER_INSTALLATION,
  replayBarrierCapacityAvailable,
  parseReplayRetiredTargetV1,
  encodeReplayRetiredTargetV1,
  digestReplayRetiredTargetV1,
  parseReplayReservationTargetV1,
  encodeReplayReservationTargetV1,
  digestReplayReservationTargetV1,
  replayReservationTargetsMatchV1,
  replayReservationCanBindTargetV1,
  advanceReplayObservationV1,
  replayObservationReceiptMatchesV1,
  decodeReplayRetirementRecordV1,
  decodeReplayObservationReceiptV1,
} from "../../packages/occ/src/turn-journal/replay-barrier.ts";
import {
  copy,
  manifestBody,
  retiredTarget,
  reservationTarget,
  retirementBinding,
  observationInput,
  retirementQuery,
} from "../fixtures/turn-journal-replay/values.mjs";

// These tests execute real value helpers against synthetic data. They establish
// neither database persistence nor current authority, lineage, clock health,
// mandatory audit, native absence, or physical capacity.
function initialRecord() {
  const manifest = createPurgeManifestV1(manifestBody());
  return {
    schemaVersion: 1,
    binding: retirementBinding(manifest),
    progress: initialPurgeProgressV1(manifest),
    auditIntentRef: "synthetic-audit-intent-reference",
    durableProgressResponsibilityRef: "synthetic-progress-responsibility-reference",
  };
}

function advanced(record, input) {
  const result = advanceReplayObservationV1(record, input);
  assert.equal(result.kind, "advance");
  return result;
}

function changed(value, path, replacement) {
  const candidate = copy(value);
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((node, key) => node[key], candidate);
  parent[last] = replacement;
  return candidate;
}

function without(value, path) {
  const candidate = copy(value);
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((node, key) => node[key], candidate);
  delete parent[last];
  return candidate;
}

function assertFrozenTree(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertFrozenTree(child);
}

test("closed target decoding retains all three exact original identity forms", () => {
  for (const kind of ["route", "context", "channel-installation"]) {
    const input = retiredTarget(kind);
    const parsed = parseReplayRetiredTargetV1(input);
    assert.throws(() =>
      parseReplayRetiredTargetV1(without(input, "identity.activationGeneration")),
    );
    if (kind === "channel-installation")
      assert.throws(() =>
        parseReplayRetiredTargetV1(without(input, "identity.installationGeneration")),
      );
    assert.equal(encodeReplayRetiredTargetV1(parsed), encodeReplayRetiredTargetV1(input));
    assertFrozenTree(parsed);
    if (kind === "route") {
      input.route.native.nativeConversation.rootThreadRef = "mutated-after-parse";
      assert.equal(
        parsed.route.native.nativeConversation.rootThreadRef,
        "original-native-root-thread",
      );
    }
    input.identity.activationGeneration++;
    assert.equal(parsed.identity.activationGeneration, 3);
    assert.notEqual(encodeReplayRetiredTargetV1(parsed), encodeReplayRetiredTargetV1(input));
  }
});

test("full native root thread and explicit route projection participate in exact matching", () => {
  const original = retiredTarget();
  for (const [path, replacement] of [
    ["identity.routeRef", "successor-route-projection"],
    ["identity.routeVersion", 8],
    ["identity.activationGeneration", 4],
    ["route.routeKey", "a".repeat(64)],
    ["route.native.providerTenantRef", "successor-tenant"],
    ["route.native.recipientAppRef", "successor-app"],
    ["route.native.nativeConversation.channelRef", "successor-channel"],
    ["route.native.nativeConversation.rootThreadRef", "successor-root-thread"],
  ]) {
    const candidate = changed(original, path, replacement);
    parseReplayRetiredTargetV1(candidate);
    assert.notEqual(
      encodeReplayRetiredTargetV1(original),
      encodeReplayRetiredTargetV1(candidate),
      path,
    );
    assert.notEqual(
      digestReplayRetiredTargetV1(original),
      digestReplayRetiredTargetV1(candidate),
      path,
    );
  }
});

test("context creation and installation generation cannot collapse into their parent identity", () => {
  for (const [kind, path, replacement] of [
    ["context", "identity.creationRef", "successor-context-creation"],
    ["context", "identity.context.conversationRef", "successor-conversation"],
    ["context", "identity.activationGeneration", 4],
    ["channel-installation", "identity.installationGeneration", 6],
    ["channel-installation", "identity.activationGeneration", 4],
  ]) {
    const original = retiredTarget(kind);
    const candidate = changed(original, path, replacement);
    assert.notEqual(
      encodeReplayRetiredTargetV1(original),
      encodeReplayRetiredTargetV1(candidate),
      path,
    );
  }
  assert.throws(() =>
    parseReplayRetiredTargetV1(without(retiredTarget("context"), "identity.creationRef")),
  );
});

test("a channel binding id/version cannot replace the route ref/version or original root thread", () => {
  const route = retiredTarget();
  const missingProjection = without(without(route, "identity.routeRef"), "identity.routeVersion");
  missingProjection.identity.channelAgentBindingId = "channel-agent-binding";
  missingProjection.identity.channelAgentBindingVersion = 7;
  for (const candidate of [
    missingProjection,
    without(route, "route.native.nativeConversation.rootThreadRef"),
    changed(route, "route", null),
    changed(retiredTarget("context"), "route", route.route),
  ])
    assert.throws(() => parseReplayRetiredTargetV1(candidate));
});

test("closed target rejects cross-scope parent substitutions and unknown data at each nesting level", () => {
  const route = retiredTarget();
  const foreignInstallation = "ins_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const foreignChannel = "chi_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  for (const candidate of [
    changed(route, "route.native.installationRef", foreignInstallation),
    changed(route, "route.native.channelInstallationRef", foreignChannel),
    changed(
      retiredTarget("channel-installation"),
      "identity.channelInstallationRef",
      foreignChannel,
    ),
    changed(retiredTarget("context"), "identity.context.installationRef", foreignInstallation),
    changed(
      retiredTarget("context"),
      "identity.context.namespaceRef",
      "ns_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
    changed(
      retiredTarget("context"),
      "identity.context.agentRef",
      "agt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
  ])
    assert.throws(() => parseReplayRetiredTargetV1(candidate));
  for (const path of [
    "extra",
    "scope.extra",
    "identity.extra",
    "route.extra",
    "route.native.extra",
    "route.native.nativeConversation.extra",
  ])
    assert.throws(() => parseReplayRetiredTargetV1(changed(route, path, "unrecognized")), path);
});

test("target snapshots reject getters, cycles, exotic objects and unsafe version arithmetic", () => {
  let getterCalls = 0;
  const accessor = retiredTarget();
  Object.defineProperty(accessor.identity, "routeRef", {
    enumerable: true,
    get() {
      getterCalls++;
      return "must-not-be-read";
    },
  });
  assert.throws(() => parseReplayRetiredTargetV1(accessor));
  assert.equal(getterCalls, 0);
  const cyclic = retiredTarget();
  cyclic.route.native.nativeConversation.rootThreadRef = cyclic;
  for (const candidate of [cyclic, new Date(0), { ...retiredTarget(), [Symbol("extra")]: true }])
    assert.throws(() => parseReplayRetiredTargetV1(candidate));
  for (const value of [-0, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "7"])
    assert.throws(() =>
      parseReplayRetiredTargetV1(changed(retiredTarget(), "identity.routeVersion", value)),
    );
  assert.throws(() =>
    parseReplayRetiredTargetV1(
      changed(
        retiredTarget(),
        "route.native.nativeConversation.rootThreadRef",
        "x".repeat(1_048_577),
      ),
    ),
  );
});

test("canonical target encoding ignores key insertion order while preserving tuple bytes", () => {
  const target = retiredTarget();
  const reordered = Object.fromEntries(Object.entries(target).reverse());
  assert.equal(encodeReplayRetiredTargetV1(target), encodeReplayRetiredTargetV1(reordered));
  assert.equal(digestReplayRetiredTargetV1(target), digestReplayRetiredTargetV1(reordered));
  assert.match(digestReplayRetiredTargetV1(target), /^[0-9a-f]{64}$/);
});

test("new-obligation capacity math has a strict 10000 boundary and accepts no unsafe count", () => {
  assert.equal(REPLAY_BARRIER_CAPACITY_PER_INSTALLATION, 10_000);
  for (const count of [0, 1, 9_999]) assert.equal(replayBarrierCapacityAvailable(count), true);
  for (const count of [
    -0,
    -1,
    0.5,
    10_000,
    10_001,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "0",
    null,
  ])
    assert.equal(replayBarrierCapacityAvailable(count), false, String(count));
  // Durable reservation before generation creation and retirement at capacity
  // are explicitly deferred PostgreSQL obligations in the integration matrix.
});

test("pending capacity targets retain known identity without choosing a future generation", () => {
  for (const kind of ["route", "context", "channel-installation"]) {
    const input = reservationTarget(kind);
    const parsed = parseReplayReservationTargetV1(input);
    assertFrozenTree(parsed);
    assert.equal(parsed.creationOperationRef, `original-${kind}-creation-operation`);
    assert.equal(parsed.subject.kind, kind);
    if (kind === "channel-installation") {
      assert.deepEqual(Object.keys(parsed.scope), ["installationId"]);
      assert.throws(() =>
        parseReplayReservationTargetV1(
          changed(input, "scope.namespaceId", "ns_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        ),
      );
      assert.throws(() =>
        parseReplayReservationTargetV1(
          changed(input, "scope.agentId", "agt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        ),
      );
    } else {
      assert.throws(() => parseReplayReservationTargetV1(without(input, "scope.namespaceId")));
      assert.throws(() => parseReplayReservationTargetV1(without(input, "scope.agentId")));
    }
    assert.equal(replayReservationTargetsMatchV1(parsed, input), true);
    assert.equal(encodeReplayReservationTargetV1(parsed), encodeReplayReservationTargetV1(input));
    assert.match(digestReplayReservationTargetV1(input), /^[0-9a-f]{64}$/);
    assert.equal("identity" in parsed, false);
    for (const field of ["activationGeneration", "installationGeneration", "lifecycleGeneration"]) {
      assert.equal(field in parsed, false);
      assert.equal(field in parsed.subject, false);
      assert.throws(() => parseReplayReservationTargetV1({ ...input, [field]: 1 }));
      assert.throws(() =>
        parseReplayReservationTargetV1({ ...input, subject: { ...input.subject, [field]: 1 } }),
      );
    }
    // The two real value decoders require different closed representations.
    assert.throws(() => parseReplayReservationTargetV1(retiredTarget(kind)));
    assert.throws(() => parseReplayRetiredTargetV1(input));
    assert.throws(() => parseReplayReservationTargetV1(without(input, "creationOperationRef")));
    input.creationOperationRef = "replacement-creation-operation";
    assert.notEqual(parsed.creationOperationRef, input.creationOperationRef);
    assert.equal(replayReservationTargetsMatchV1(parsed, input), false);
  }
});

test("pending context creation references satisfy both original head and PER43 domains without mutation", () => {
  for (const [name, creationRef, headAccepts, retiredAccepts] of [
    ["ordinary reference", "ordinary-context-creation", true, true],
    ["200 ASCII boundary", "x".repeat(200), true, true],
    ["leading scheme delimiter", "scheme://creation", false, true],
    ["embedded scheme delimiter", "part/scheme://creation", false, true],
    ["201 ASCII boundary", "x".repeat(201), true, false],
  ]) {
    const pending = reservationTarget("context");
    pending.subject.creationRef = creationRef;
    const head = {
      context: copy(pending.subject.context),
      headVersion: 1,
      completionSequence: 0,
      checkpointId: null,
      creationRef,
    };
    const retired = retiredTarget("context").identity;
    retired.creationRef = creationRef;
    // Exercise the two actual codecs: the pending reference must belong to
    // their intersection, including an embedded delimiter rejected by the head.
    if (headAccepts) assert.equal(parseTurnJournalV1("head", head).creationRef, creationRef, name);
    else assert.throws(() => parseTurnJournalV1("head", head), name);
    if (retiredAccepts)
      assert.equal(
        parseRetirementPurgeV1("retiredIdentity", retired).creationRef,
        creationRef,
        name,
      );
    else assert.throws(() => parseRetirementPurgeV1("retiredIdentity", retired), name);

    // This input is plain fixture data, including the rejected values. Do not
    // run an accepting codec to produce its before-snapshot or normalize it.
    const before = copy(pending);
    const originalNodes = [[], ["scope"], ["subject"], ["subject", "context"]].map((path) => {
      const value = path.reduce((parent, key) => parent[key], pending);
      return {
        path,
        value,
        prototype: Object.getPrototypeOf(value),
        descriptors: Object.getOwnPropertyDescriptors(value),
        extensible: Object.isExtensible(value),
      };
    });
    if (headAccepts && retiredAccepts)
      assert.equal(parseReplayReservationTargetV1(pending).subject.creationRef, creationRef, name);
    else assert.throws(() => parseReplayReservationTargetV1(pending), name);
    assert.deepEqual(pending, before, name);
    for (const original of originalNodes) {
      const current = original.path.reduce((parent, key) => parent[key], pending);
      assert.equal(current, original.value, name);
      assert.equal(Object.getPrototypeOf(current), original.prototype, name);
      assert.deepEqual(Object.getOwnPropertyDescriptors(current), original.descriptors, name);
      assert.equal(Object.isExtensible(current), original.extensible, name);
    }
  }
});

test("pending route and context comparisons retain every known original correspondence", () => {
  for (const [kind, path, replacement] of [
    ["route", "creationOperationRef", "other-original-creation"],
    ["route", "subject.route.routeKey", "a".repeat(64)],
    ["route", "subject.route.native.providerTenantRef", "other-provider-tenant"],
    ["route", "subject.route.native.recipientAppRef", "other-recipient-app"],
    ["route", "subject.route.native.nativeConversation.channelRef", "other-channel"],
    ["route", "subject.route.native.nativeConversation.rootThreadRef", "other-root-thread"],
    ["context", "subject.context.conversationRef", "other-conversation"],
    ["context", "subject.creationRef", "other-context-creation"],
  ]) {
    const original = reservationTarget(kind);
    const candidate = changed(original, path, replacement);
    assert.equal(replayReservationTargetsMatchV1(original, candidate), false, path);
    assert.notEqual(
      digestReplayReservationTargetV1(original),
      digestReplayReservationTargetV1(candidate),
      path,
    );
  }
  const input = reservationTarget();
  const parsed = parseReplayReservationTargetV1(input);
  input.subject.route.native.nativeConversation.rootThreadRef = "mutated-after-parse";
  assert.equal(
    parsed.subject.route.native.nativeConversation.rootThreadRef,
    "original-native-root-thread",
  );
  for (const candidate of [
    without(reservationTarget(), "subject.route.native.nativeConversation.rootThreadRef"),
    changed(
      reservationTarget("context"),
      "subject.context.installationRef",
      "ins_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
    changed(
      reservationTarget(),
      "subject.route.native.channelInstallationRef",
      "chi_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ),
    changed(reservationTarget("channel-installation"), "subject.route", retiredTarget().route),
  ])
    assert.throws(() => parseReplayReservationTargetV1(candidate));
});

test("binding comparison connects a pending subject to retained history without authenticating it", () => {
  for (const kind of ["route", "context", "channel-installation"]) {
    const pending = reservationTarget(kind);
    const history = retiredTarget(kind);
    // This is only structural correspondence. Neither value supplies the actual
    // activation operation, generation, notBefore, watermark or clock proof.
    assert.equal(replayReservationCanBindTargetV1(pending, history), true);
    for (const otherKind of ["route", "context", "channel-installation"].filter(
      (other) => other !== kind,
    ))
      assert.equal(replayReservationCanBindTargetV1(pending, retiredTarget(otherKind)), false);
  }
  for (const [kind, path, replacement] of [
    ["route", "route.routeKey", "a".repeat(64)],
    ["route", "route.native.nativeConversation.rootThreadRef", "replacement-thread"],
    ["context", "identity.creationRef", "replacement-context-creation"],
    ["context", "identity.context.conversationRef", "replacement-conversation"],
    ["channel-installation", "scope.installationId", "ins_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
  ])
    assert.equal(
      replayReservationCanBindTargetV1(
        reservationTarget(kind),
        changed(retiredTarget(kind), path, replacement),
      ),
      false,
      path,
    );
});

test("an observation advances one exact target with an immutable first receipt", () => {
  const record = initialRecord();
  const input = observationInput(record);
  const before = encodePurgeCallableV1("record", record);
  const beforeBinding = encodePurgeCallableV1("binding", record.binding);
  const originalObjects = [];
  const rememberObjects = (value, path = []) => {
    if (value === null || typeof value !== "object") return;
    originalObjects.push({ path, value, prototype: Object.getPrototypeOf(value) });
    for (const [key, child] of Object.entries(value)) rememberObjects(child, [...path, key]);
  };
  rememberObjects(record);
  const result = advanced(record, input);
  // Canonical encoding compares complete data without flattening the parser's
  // null prototypes. Separately retain every original object and its prototype
  // so a same-value replacement or prototype mutation also fails this check.
  assert.equal(encodePurgeCallableV1("record", record), before);
  for (const original of originalObjects) {
    const current = original.path.reduce((value, key) => value[key], record);
    assert.equal(current, original.value);
    assert.equal(Object.getPrototypeOf(current), original.prototype);
  }
  assert.equal(result.record.progress.recordVersion, 2);
  assert.equal(result.record.progress.stores[0].state.kind, "observed-present");
  assert.equal(result.record.progress.stores[1].state.kind, "pending");
  assert.equal(encodePurgeCallableV1("binding", result.record.binding), beforeBinding);
  assert.equal(result.record.auditIntentRef, record.auditIntentRef);
  assert.equal(
    result.record.durableProgressResponsibilityRef,
    record.durableProgressResponsibilityRef,
  );
  assert.equal(result.receipt.recordedAtRecordVersion, 2);
  assert.equal(result.receipt.originalTransactionRef, input.originalTransactionRef);
  assert.equal(replayObservationReceiptMatchesV1(result.receipt, input), true);
  assertFrozenTree(result.record);
  assertFrozenTree(result.receipt);
});

test("immutable first receipt still matches after another target advances global progress", () => {
  const initial = initialRecord();
  const firstInput = observationInput(initial);
  const first = advanced(initial, firstInput);
  const retainedReceipt = JSON.stringify(first.receipt);
  const second = advanced(first.record, observationInput(first.record, 1, "observed-absent"));
  assert.equal(second.record.progress.recordVersion, 3);
  assert.equal(first.receipt.recordedAtRecordVersion, 2);
  assert.equal(JSON.stringify(first.receipt), retainedReceipt);
  // expectedRecordVersion is the caller's original CAS expectation, not part of
  // immutable receipt identity. A real owner must authorize before this lookup.
  assert.equal(replayObservationReceiptMatchesV1(first.receipt, firstInput), true);
  assert.equal(
    replayObservationReceiptMatchesV1(first.receipt, { ...firstInput, expectedRecordVersion: 3 }),
    true,
  );
  const found = parsePurgeCallableV1("readResult", {
    kind: "found",
    record: second.record,
    observationReceipt: first.receipt,
  });
  assert.equal(
    purgeHistoryMatchesV1(
      {
        ...retirementQuery(initial),
        kind: "observation",
        originalTransactionRef: firstInput.originalTransactionRef,
        observation: firstInput.observation,
      },
      found,
    ),
    true,
  );
  assert.equal(
    parsePurgeCallableV1("observationResult", {
      kind: "existing",
      record: second.record,
      receipt: first.receipt,
    }).receipt.recordedAtRecordVersion,
    2,
  );
  assert.throws(() =>
    parsePurgeCallableV1("observationResult", {
      kind: "recorded",
      record: second.record,
      receipt: first.receipt,
    }),
  );
});

test("same-target later sequence preserves a prior present or unknown receipt as history", () => {
  for (const priorOutcome of ["observed-present", "unknown"]) {
    const initial = initialRecord();
    const firstInput = observationInput(initial, 0, priorOutcome);
    const first = advanced(initial, firstInput);
    const next = advanced(first.record, observationInput(first.record, 0, "observed-absent", 2));
    assert.equal(replayObservationReceiptMatchesV1(first.receipt, firstInput), true);
    assert.equal(
      parsePurgeCallableV1("readResult", {
        kind: "found",
        record: next.record,
        observationReceipt: first.receipt,
      }).record.progress.recordVersion,
      3,
    );
    assert.equal(first.receipt.observation.outcome, priorOutcome);
    assert.equal(first.receipt.recordedAtRecordVersion, 2);
  }
});

test("same observation identity with changed transaction, binding, evidence or source time conflicts", () => {
  const initial = initialRecord();
  const input = observationInput(initial);
  const first = advanced(initial, input);
  const before = JSON.stringify(first.receipt);
  for (const [path, replacement] of [
    ["originalTransactionRef", "replacement-observation-transaction"],
    ["binding.originalTransactionRef", "replacement-retirement-transaction"],
    ["binding.expectedStoppedTransitionRef", "66666666-6666-4666-8666-666666666666"],
    ["binding.expectedLifecycleGeneration", 24],
    ["binding.barrierRef", "replacement-barrier"],
    ["binding.barrierVersion", 12],
    ["binding.activationReplayLineageRef", "replacement-lineage"],
    ["binding.activationReplayLineageVersion", 14],
    ["observation.evidenceRef", "replacement-evidence"],
    ["observation.observedAt", "2026-01-01T00:00:02.000Z"],
    ["observation.store.objectVersion", "replacement-object-version"],
    ["observation.store.binding.bindingVersion", 20],
    ["observation.deletionOperationRef", "replacement-delete-operation"],
    ["observation.outcome", "unknown"],
  ])
    assert.equal(
      replayObservationReceiptMatchesV1(first.receipt, changed(input, path, replacement)),
      false,
      path,
    );
  assert.equal(JSON.stringify(first.receipt), before);
});

test("new observations require exact binding, target, current CAS and next sequence", () => {
  const initial = initialRecord();
  const first = advanced(initial, observationInput(initial));
  const candidate = observationInput(first.record, 0, "unknown", 2);
  for (const [path, replacement] of [
    ["expectedRecordVersion", 1],
    ["binding.expectedLifecycleGeneration", 24],
    ["binding.barrierVersion", 12],
    ["binding.activationReplayLineageVersion", 14],
    ["observation.observationSequence", 1],
    ["observation.observationSequence", 3],
    ["observation.observationRef", first.receipt.observation.observationRef],
    ["observation.observedAt", "2026-01-01T00:00:00.000Z"],
    ["observation.deletionOperationRef", "unknown-deletion-operation"],
    ["observation.store.objectVersion", "successor-object-version"],
  ])
    assert.equal(
      advanceReplayObservationV1(first.record, changed(candidate, path, replacement)).kind,
      "conflict",
      path,
    );
  assert.equal(
    advanceReplayObservationV1(first.record, observationInput(initial)).kind,
    "conflict",
  );
});

test("observed absence is terminal and progress arithmetic never wraps", () => {
  const initial = initialRecord();
  const absent = advanced(initial, observationInput(initial, 0, "observed-absent"));
  for (const outcome of ["observed-present", "unknown", "observed-absent"])
    assert.equal(
      advanceReplayObservationV1(absent.record, observationInput(absent.record, 0, outcome, 2))
        .kind,
      "conflict",
    );
  const complete = advanced(absent.record, observationInput(absent.record, 1, "observed-absent"));
  assert.equal(complete.record.progress.state, "live-objects-absent");
  assert.equal(
    complete.record.progress.manifest.retention.permanentRetirementBarrier,
    "retain-installation-lifetime",
  );
  const atLimit = copy(initial);
  atLimit.progress.recordVersion = Number.MAX_SAFE_INTEGER;
  assert.equal(advanceReplayObservationV1(atLimit, observationInput(atLimit)).kind, "conflict");
});

test("persisted decoders reject altered headers and do not treat parseability as current lineage", () => {
  const initial = initialRecord();
  assert.equal(decodeReplayRetirementRecordV1(initial).binding.expectedLifecycleGeneration, 23);
  const first = advanced(initial, observationInput(initial));
  assert.equal(decodeReplayObservationReceiptV1(first.receipt).recordedAtRecordVersion, 2);
  for (const candidate of [
    { ...initial, deletionAllowed: true },
    changed(initial, "binding.manifest.manifestVersion", 18),
    changed(initial, "binding.scope.agentId", "agt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  ])
    assert.throws(() => decodeReplayRetirementRecordV1(candidate));
  assert.throws(() =>
    decodeReplayObservationReceiptV1({ ...first.receipt, currentAuthority: true }),
  );
});
