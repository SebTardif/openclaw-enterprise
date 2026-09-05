import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRuntimeEffectsV1 as parse,
  parseRuntimeEffectsJsonV1 as parseJson,
  parseRuntimeEffectExchangeV1 as exchange,
  parseRuntimeFenceCompletionV1 as completeFence,
  canonicalRuntimeEffectRequestV1,
  runtimeEffectEvidenceFreshV1,
  parseRuntimeEffectsResponseV1,
  RUNTIME_EFFECT_LIMITS_V1,
} from "@openclaw-enterprise/contracts";
import {
  nextEffectAction,
  replacementBarrier,
  successorPreparationMatchesFence,
} from "../fixtures/runtime-effects-v1/lifecycle-consumer.ts";
import * as v from "../fixtures/runtime-effects-v1/vectors.mjs";

// These tests execute exported value codecs and pure consumer checks. The records
// describe contract traces; no fixture simulates a provider or asserts runtime proof.
const rejects = (kind, input) =>
  assert.throws(() => parse(kind, input), { message: "Invalid runtime effects V1 value." });
const proposal = () => {
  const { request, targets, children } = v.fenceState();
  return { schemaVersion: 1, kind: "complete-fence", request, targets, children };
};

test("all primary requests and positive representation branches round-trip through public codecs", () => {
  const cases = [
    ["create", v.createRequest()],
    ["create", v.createRequest("materialize")],
    ["setRoute", v.routeRequest()],
    ["stopRetainingState", v.stopRequest()],
    ["effectResult", v.appliedResult()],
    ["effectState", v.unknownResult()],
    ["observationInput", v.candidate()],
    ["observationResult", v.completeObservation()],
    ["fenceState", v.fenceState()],
    ["fenceCompletion", proposal()],
    ["priorWriterResult", v.handoffResult()],
    ["storeResult", v.storeResult()],
    ["storeBinding", v.store()],
    ["reservation", v.reservation()],
    ["attempt", v.attempt()],
    ["fault", v.fault()],
    ["gateState", v.gateState()],
    ["preparedChild", v.preparedChild()],
  ];
  for (const [kind, input] of cases) {
    const decoded = parseJson(kind, JSON.stringify(input));
    assert.equal(JSON.stringify(decoded), JSON.stringify(input), kind);
    assert(Object.isFrozen(decoded), kind);
  }
});

test("retained cleanup binds the execution to its exact cluster, namespace and Deployment", () => {
  const valid = v.stopRequest();
  const terminated = (request) => ({
    ...v.appliedResult(request),
    termination: {
      status: "terminated",
      execution: { target: request.effect.target, binding: request.binding },
      terminationEvidence: v.evidence("termination"),
    },
  });
  assert.equal(exchange(valid, terminated(valid)).termination.status, "terminated");
  for (const field of ["clusterRef", "kubernetesNamespaceUid", "deploymentUid"]) {
    const wrong = v.stopRequest();
    wrong.binding[field] = "different-instance";
    assert.throws(() => v.signRequest(wrong), field);
    rejects("stopRetainingState", wrong);
    assert.throws(() => exchange(wrong, terminated(wrong)), field);
  }
  const replacement = v.stopRequest();
  replacement.binding = v.binding(2);
  assert.throws(() => v.signRequest(replacement));
  rejects("stopRetainingState", replacement);
  assert.throws(() => exchange(replacement, terminated(replacement)));

  const route = v.stopRequest();
  route.effect.target = v.target(2);
  route.providerTarget = v.providerTarget(2, "Service");
  route.predicate = v.expectedObject(2, "Service");
  route.binding = v.binding(2);
  v.signRequest(route);
  assert.notEqual(route.predicate.uid, route.binding.deploymentUid);
  parse("stopRetainingState", route);
  exchange(route, terminated(route));
});

test("unknown create retains the original locator and permits only exact readback", () => {
  const request = v.createRequest();
  const result = exchange(request, v.unknownResult(request));
  assert.equal(nextEffectAction(result), "read-original");
  assert.equal(result.effect.effectRef, request.effect.effectRef);
  assert.equal(
    nextEffectAction({
      schemaVersion: 1,
      effect: request.effect,
      status: "not-found",
      outcome: "unknown",
    }),
    "read-original",
  );
  assert.equal(result.status, "unknown");
});

test("exact duplicate request uses stable canonical bytes; changed payload cannot borrow its digest", () => {
  const first = v.createRequest();
  const replay = v.copy(first);
  assert.equal(canonicalRuntimeEffectRequestV1(first), canonicalRuntimeEffectRequestV1(replay));
  exchange(replay, v.appliedResult(first));
  replay.admittedRuntime.resourceEnvelopeDigest = v.digest(99);
  assert.notEqual(canonicalRuntimeEffectRequestV1(first), canonicalRuntimeEffectRequestV1(replay));
  assert.throws(() => exchange(replay, v.appliedResult(first)));
  replay.effect.effectRef = v.uuid(999);
  assert.throws(() => exchange(replay, v.unknownResult(first)));
});

test("same-name different UID is conflict, never adopted by discovery or cleanup", () => {
  const input = v.exactCreate();
  input.expectedObject = v.providerObject();
  const discovered = {
    schemaVersion: 1,
    status: "exact",
    input,
    object: v.providerObject(),
    correlationEvidence: v.evidence(),
  };
  parse("discoveryResult", discovered);
  discovered.object.uid = "successor-uid";
  rejects("discoveryResult", discovered);
  const stop = v.stopRequest();
  const result = v.appliedResult(stop);
  result.object.uid = "successor-uid";
  result.termination = {
    status: "unknown",
    execution: { target: v.target(1), binding: v.binding(1) },
    reasonCode: "provider-outcome-unknown",
  };
  assert.throws(() => exchange(stop, result));
});

test("pre-submission cancellation requires positive durable non-submission; later abort stays unknown", () => {
  const request = v.createRequest();
  const before = {
    schemaVersion: 1,
    effect: request.effect,
    status: "not-submitted",
    boundary: "before-any-possible-submission",
    reasonCode: "cancelled",
    durableNonSubmissionEvidence: v.evidence("non-submission"),
  };
  assert.equal(exchange(request, before).status, "not-submitted");
  delete before.durableNonSubmissionEvidence;
  rejects("effectResult", before);
  const after = v.unknownResult(request);
  after.reasonCode = "cancelled";
  assert.equal(exchange(request, after).status, "unknown");
  rejects("effectResult", { ...after, status: "not-submitted" });
});

test("zero or ambiguous discovery cannot turn an unknown POST into known absence", () => {
  for (const status of ["incomplete", "ambiguous", "unknown", "conflict"])
    parse("discoveryResult", {
      schemaVersion: 1,
      status,
      input: v.exactCreate(),
      reasonCode: "provider-outcome-unknown",
    });
  rejects("discoveryResult", { schemaVersion: 1, status: "absent", input: v.exactCreate() });
  rejects("discoveryResult", {
    schemaVersion: 1,
    status: "exact",
    input: v.exactCreate(),
    candidates: [],
  });
});

test("delayed route write retains old UID/RV and cannot rebase using an old digest", () => {
  const request = v.routeRequest();
  const delayed = v.copy(request);
  delayed.predicate.resourceVersion = "successor-version";
  assert.throws(() => exchange(delayed, v.unknownResult(request)));
  const result = v.appliedResult(request);
  result.route = { status: "unknown", reasonCode: "provider-outcome-unknown" };
  assert.equal(exchange(request, result).route.status, "unknown");
  result.route = {
    status: "observed",
    route: { kind: "inactive", reservedUnmatchableRouteRef: "inactive" },
    controlObject: result.object,
    dataPlaneEvidence: v.evidence(),
  };
  assert.throws(() => exchange(request, result));
});

test("old write versus seal preserves historical uncertainty while invalidating retained predicates", () => {
  const fence = v.fenceState();
  assert.equal(parse("fenceState", fence).children[0].historicalOutcome, "unknown");
  const child = fence.children[0];
  child.retainedPredicate = v.expectedObject();
  child.seal.resourceVersion = child.retainedPredicate.resourceVersion;
  rejects("fenceState", fence);
  child.seal.resourceVersion = "rv-sealed";
  child.historicalOutcome = "applied";
  assert.equal(parse("fenceState", fence).children[0].historicalOutcome, "applied");
});

test("inert reservation survives late POST; executable unconditioned create and tombstone deletion deny", () => {
  const inert = v.createRequest();
  parse("create", inert);
  const materialize = v.createRequest("materialize");
  materialize.predicate = inert.predicate;
  rejects("create", materialize);
  inert.preparation = {
    kind: "writable",
    preparationRef: v.uuid(60),
    preparationVersion: 1,
    admittedProfileDigest: v.digest(4),
    priorWriterEvidence: v.noWriterRef(),
  };
  rejects("create", inert);
  const stop = v.stopRequest();
  stop.action = "remove-exact";
  stop.effect.effectKind = "remove-exact";
  rejects("stopRetainingState", stop);
});

test("partial multi-target coverage cannot establish a provider fence", () => {
  const partial = v.fenceState();
  partial.targets.pop();
  rejects("fenceState", partial);
  const unknown = v.fenceState();
  unknown.targets[0] = {
    target: unknown.targets[0].target,
    status: "unknown",
    reasonCode: "provider-outcome-unknown",
  };
  rejects("fenceState", unknown);
  const { completion: _completion, guarantee: _guarantee, ...pending } = unknown;
  pending.status = "pending";
  assert.equal(parse("fenceState", pending).status, "pending");
});

test("Fence completion uses exact current gate, epoch, plan and admitted-child cutoff", () => {
  completeFence(v.gateState(), proposal());
  for (const field of [
    "gateVersion",
    "requestedFenceEpoch",
    "planVersion",
    "admittedChildCutoff",
    "lifecycleGeneration",
  ]) {
    const changed = v.gateState();
    changed.guard[field] += 1;
    assert.throws(() => completeFence(changed, proposal()), field);
  }
  const changed = v.gateState();
  changed.children.push({
    ...v.preparedChild(),
    effect: { ...v.createRequest().effect, effectRef: v.uuid(999) },
  });
  assert.throws(() => completeFence(changed, proposal()));
});

test("A late sealer cannot rebase after completion or supersession", () => {
  const closed = v.gateState();
  closed.sealerAdmission = "closed";
  assert.throws(() => completeFence(closed, proposal()));
  const changedPredicate = v.gateState();
  changedPredicate.children[0].predicate = v.expectedObject();
  assert.throws(() => completeFence(changedPredicate, proposal()));
  const changedTarget = v.gateState();
  changedTarget.children[0].providerTarget.name = "different-anchor";
  assert.throws(() => completeFence(changedTarget, proposal()));
});

test("Same-generation authority loss remains durable fault/fence work after restart", () => {
  for (const source of ["service", "profile", "responsibility", "authoritative-lease"]) {
    const loss = v.fault();
    loss.cause.source = source;
    assert.equal(parse("fault", loss).guard.lifecycleGeneration, v.target().lifecycleGeneration);
  }
  const restarted = v.gateState();
  restarted.authority = "lost";
  parse("gateState", restarted);
  restarted.ordinaryAdmission = "open";
  rejects("gateState", restarted);
  const loss = v.fault();
  loss.cause.currentVersion = loss.cause.previousVersion;
  rejects("fault", loss);
});

test("unknown COMMIT retains the original admitted child and request bytes", () => {
  const child = v.preparedChild();
  parse("preparedChild", child);
  const changed = v.copy(child);
  changed.canonicalRequestJson = '{"action":"reserve-inert","replicas":1}';
  rejects("preparedChild", changed);
  changed.canonicalRequestJson = '{ "replicas":0,"action":"reserve-inert" }';
  changed.requestBytesDigest = v.hash(changed.canonicalRequestJson);
  rejects("preparedChild", changed);
  const state = v.unknownResult();
  state.phase = "admission-commit";
  assert.equal(nextEffectAction(state), "read-original");
  parse("childAdmissionResult", { status: "commit-unknown", effect: child.effect });
});

test("capacity refusal retains reservations, disallows GC/reuse and does not grant non-submission by timeout", () => {
  const request = v.createRequest();
  const result = {
    schemaVersion: 1,
    effect: request.effect,
    status: "not-submitted",
    boundary: "before-any-possible-submission",
    reasonCode: "capacity-exhausted",
    durableNonSubmissionEvidence: v.evidence("capacity-refusal"),
  };
  exchange(request, result);
  const plan = v.plan();
  plan.reservationRetention = "evict-oldest";
  rejects("closedPlan", plan);
  plan.reservationRetention = "permanent";
  plan.targets.push(v.copy(plan.targets[0]));
  rejects("closedPlan", plan);
});

test("prebinding observation needs independent provenance but not target SVID, selection or restore", () => {
  const result = parse("observationResult", v.completeObservation());
  assert.equal(result.identityEvidence, null);
  assert.equal(result.input.kind, "preallocated-candidate");
  assert.equal(result.eligibility, "observation-only");
  const forged = v.completeObservation();
  delete forged.executionCorrespondenceEvidence;
  rejects("observationResult", forged);
  forged.executionCorrespondenceEvidence = v.evidence();
  forged.binding.protectedRestartDiscriminator = "different-instance";
  const bound = v.completeObservation();
  bound.input = {
    schemaVersion: 1,
    kind: "bound-instance",
    target: v.target(),
    expectedEvidenceVersion: null,
    binding: v.binding(),
  };
  bound.binding.protectedRestartDiscriminator = "different-instance";
  rejects("observationResult", bound);
});

test("freshness uses original source time, uncertainty and monotonically newer version", () => {
  const fresh = v.evidence("observation", 2);
  assert.equal(runtimeEffectEvidenceFreshV1(fresh, v.now, 1), true);
  assert.equal(runtimeEffectEvidenceFreshV1(fresh, v.now, 2), false);
  fresh.clock.receivedAt = "2026-01-01T00:01:00.000Z";
  assert.equal(runtimeEffectEvidenceFreshV1(fresh, "2026-01-01T00:01:00.000Z", null), false);
  assert.equal(runtimeEffectEvidenceFreshV1(v.evidence(), v.now, null, 500), false);
  const future = v.evidence();
  future.clock.sourceObservedAt = "2026-01-01T00:00:05.000Z";
  rejects("provenance", future);
  const stale = v.completeObservation();
  stale.input.expectedEvidenceVersion = 1;
  rejects("observationResult", stale);
});

test("all explicit targets sealed does not prove descendant/start/restore writer closure", () => {
  const fence = v.fenceState();
  const handoff = v.handoffResult();
  assert.equal(replacementBarrier(fence, handoff, v.now, {}), "barrier-observed");
  const held = {
    schemaVersion: 1,
    status: "held",
    input: handoff.input,
    reasonCode: "writer-unresolved",
  };
  assert.equal(replacementBarrier(fence, held, v.now, {}), "blocked");
  handoff.producerDomains.pop();
  rejects("priorWriterResult", handoff);
  const restore = v.handoffResult();
  restore.input.possibleWriters.push({
    kind: "restore",
    ownerRef: "pending-restore",
    restoreRef: "restore",
    target: v.target(1),
    responsibility: v.responsibility(),
  });
  rejects("priorWriterResult", restore);
});

test("every prior execution needs actual exact termination, not lease/Ready or an empty list", () => {
  const missing = v.handoffResult();
  missing.writers = [];
  rejects("priorWriterResult", missing);
  const wrong = v.handoffResult();
  wrong.writers[0].execution = { target: v.target(), binding: v.binding() };
  rejects("priorWriterResult", wrong);
  const lease = v.handoffResult();
  lease.writers[0] = {
    owner: lease.input.possibleWriters[0],
    status: "never-executed",
    nonExecutionEvidence: v.evidence(),
    resolution: "never-submitted",
  };
  rejects("priorWriterResult", lease);
  const empty = v.handoffResult();
  empty.input.possibleWriters = [];
  empty.writers = [];
  // Empty coverage is only representable with an explicit protected canonical snapshot,
  // reserved workspace and complete producer-domain closure; absence alone is invalid.
  parse("priorWriterResult", empty);
  delete empty.canonicalOwnerSnapshot;
  rejects("priorWriterResult", empty);
});

test("protected never-materialized owner resolves without fabricated runtime IDs", () => {
  const result = v.handoffResult();
  const owner = {
    kind: "create",
    ownerRef: "never-materialized",
    effect: v.createRequest().effect,
  };
  result.input.possibleWriters = [owner];
  result.writers = [
    {
      owner,
      status: "never-executed",
      resolution: "never-materialized",
      nonExecutionEvidence: v.evidence("never-materialized"),
    },
  ];
  parse("priorWriterResult", result);
  delete result.writers[0].nonExecutionEvidence;
  rejects("priorWriterResult", result);
});

test("workspace association is exact and configuration objects cannot satisfy mount proof", () => {
  const wrong = v.handoffResult();
  wrong.observedStoreBindings[0].ref.bindingVersion += 1;
  rejects("priorWriterResult", wrong);
  const cross = v.routeRequest();
  cross.desiredRoute.priorWriterEvidence.workspaceStore.bindingRef = "foreign-store";
  rejects("setRoute", cross);
  const mount = v.storeResult();
  mount.mount.claimUid = "foreign-uid";
  rejects("storeResult", mount);
  const config = {
    schemaVersion: 1,
    kind: "configuration-object",
    ref: v.storeRef(),
    role: "configuration",
    backendRef: "config-backend",
    objectRef: "config-object",
    objectVersion: "opaque-v1",
    contentDigest: v.digest(),
    storageProfileRef: "config-profile",
    storageProfileDigest: v.digest(),
  };
  parse("storeBinding", config);
  const wrongKind = v.storeResult();
  wrongKind.store = config;
  rejects("storeResult", wrongKind);
});

test("observed mount paths preserve the shared admitted 512-character limit", () => {
  for (const length of [201, 512]) {
    const mount = v.storeResult();
    const path = "a".repeat(length);
    mount.store.approvedSubpaths[0].relativePath = path;
    mount.mount.subpaths[0].relativePath = path;
    assert.equal(
      JSON.stringify(parseJson("storeBinding", JSON.stringify(mount.store))),
      JSON.stringify(mount.store),
    );
    assert.equal(
      JSON.stringify(parseJson("storeResult", JSON.stringify(mount))),
      JSON.stringify(mount),
    );
  }
  const tooLong = v.storeResult();
  tooLong.store.approvedSubpaths[0].relativePath = "a".repeat(513);
  tooLong.mount.subpaths[0].relativePath = "a".repeat(513);
  rejects("storeBinding", tooLong.store);
  rejects("storeResult", tooLong);
});

test("immutable store policy does not contain a successor mount; observed subpaths must match", () => {
  const store = v.store();
  store.approvedSubpaths[0].mountIdentityRef = "runtime-mount";
  rejects("storeBinding", store);
  const privateStore = v.store();
  privateStore.role = "gateway-private";
  rejects("storeBinding", privateStore);
  const mount = v.storeResult();
  mount.mount.subpaths[0].readOnly = true;
  rejects("storeResult", mount);
  for (const path of [
    "/etc",
    "../other",
    "workspace/../other",
    "workspace//nested",
    "workspace/",
    "workspace\\nested",
  ]) {
    const bad = v.store();
    bad.approvedSubpaths[0].relativePath = path;
    rejects("storeBinding", bad);
  }
});

test("non-disclosing strict JSON rejects unknown, duplicate, accessor, sparse and prototype-bearing data", () => {
  const errors = [];
  for (const raw of [
    '{"schemaVersion":1,"schemaVersion":1}',
    '{"schemaVersion":1,"\\u0073chemaVersion":1}',
    '{"schemaVersion":1e0}',
    '{"schemaVersion":1.0}',
    '{"schemaVersion":1.0000000000000001}',
    '{"schemaVersion":-0}',
    '{"schemaVersion":9007199254740993}',
  ]) {
    try {
      parseJson("reservation", raw);
      assert.fail("accepted malformed JSON");
    } catch (error) {
      errors.push(error.message);
    }
  }
  let invoked = false;
  const getter = {};
  Object.defineProperty(getter, "schemaVersion", {
    enumerable: true,
    get() {
      invoked = true;
      return 1;
    },
  });
  rejects("reservation", getter);
  assert.equal(invoked, false);
  rejects("reservation", Object.assign(Object.create({ schemaVersion: 1 }), v.reservation()));
  const sparse = v.plan();
  sparse.targets.length += 1;
  rejects("closedPlan", sparse);
  const symbol = v.reservation();
  symbol[Symbol("private")] = true;
  rejects("reservation", symbol);
  const foreign = v.reservation();
  foreign.secret = "opaque-canary";
  rejects("reservation", foreign);
  assert(errors.every((error) => error === "Invalid runtime effects V1 value."));
});

test("bounded decoders reject oversized collections and values without truncating coverage", () => {
  const plan = v.plan();
  plan.targets = Array.from({ length: 33 }, () => v.copy(plan.targets[0]));
  rejects("closedPlan", plan);
  const owner = v.handoffInput();
  owner.possibleWriters = Array.from({ length: 65 }, () => v.copy(owner.possibleWriters[0]));
  rejects("exactHandoff", owner);
  assert.throws(() =>
    parseJson("reservation", " ".repeat(RUNTIME_EFFECT_LIMITS_V1.maxJsonBytes + 1)),
  );
  const invalidClock = v.evidence();
  invalidClock.clock.uncertaintyMs = 2001;
  rejects("provenance", invalidClock);
});

test("received values are detached and deeply frozen", () => {
  const input = v.createRequest();
  const parsed = parse("create", input);
  input.effect.target.runtimeGeneration = 99;
  assert.equal(parsed.effect.target.runtimeGeneration, 2);
  assert(Object.isFrozen(parsed.effect.target));
  assert.throws(() => {
    parsed.effect.target.runtimeGeneration = 99;
  }, TypeError);
});

test("request-specific readback rejects foreign input and cannot change retained ownership", () => {
  const request = v.exactCreate();
  const result = {
    schemaVersion: 1,
    status: "unknown",
    input: request,
    reasonCode: "provider-outcome-unknown",
  };
  parseRuntimeEffectsResponseV1("discover", request, result);
  result.input = v.copy(request);
  result.input.effect.effectRef = v.uuid(901);
  assert.throws(() => parseRuntimeEffectsResponseV1("discover", request, result));
  const fence = v.fenceState();
  const original = v.copy(fence.request);
  fence.request.fenceRef = v.uuid(902);
  assert.throws(() => parseRuntimeEffectsResponseV1("readFence", original, fence));
  const fault = v.fault();
  const unknown = {
    status: "commit-unknown",
    operation: fault.operation,
    reasonCode: "unavailable",
  };
  parseRuntimeEffectsResponseV1("recordFaultAndRequestStop", fault, unknown);
  const other = v.copy(fault);
  other.operation.operationRef = v.uuid(903);
  assert.throws(() => parseRuntimeEffectsResponseV1("recordFaultAndRequestStop", other, unknown));
});

test("exact candidate observation rejects same-name changed UID and noncreate effects", () => {
  const observation = v.completeObservation();
  observation.input.createEffect.expectedObject = v.providerObject();
  observation.input.createEffect.expectedObject.uid = "previous-uid";
  rejects("observationResult", observation);
  const exact = v.exactCreate();
  exact.effect.effectKind = "route-active";
  rejects("exactCreate", exact);
  const candidate = v.candidate();
  candidate.responsibility = v.responsibility("retained-stop");
  rejects("observationInput", candidate);
});

test("writable candidate observations require exact prior-writer reservation and store scope", () => {
  const candidate = v.copy(v.candidate());
  candidate.preparation = {
    kind: "writable",
    preparationRef: v.uuid(60),
    preparationVersion: 1,
    admittedProfileDigest: v.digest(4),
    priorWriterEvidence: v.copy(v.noWriterRef()),
  };
  assert.equal(
    JSON.stringify(parseJson("observationInput", JSON.stringify(candidate))),
    JSON.stringify(candidate),
  );
  const malformed = [
    [
      "foreign reservation",
      (ref) => {
        ref.reservation.scope.agentId = `agt_${v.uuid(999)}`;
      },
    ],
    [
      "foreign workspace",
      (ref) => {
        ref.workspaceStore.scope.agentId = `agt_${v.uuid(999)}`;
      },
    ],
    [
      "missing workspace",
      (ref) => {
        ref.workspaceStore.bindingRef = "missing-from-stores";
      },
    ],
    [
      "mixed store scope",
      (ref) => {
        const foreign = v.copy(ref.stores[0]);
        foreign.bindingRef = "foreign-store";
        foreign.scope.agentId = `agt_${v.uuid(999)}`;
        ref.stores.push(foreign);
      },
    ],
    [
      "duplicate store",
      (ref) => {
        ref.stores.push(v.copy(ref.stores[0]));
      },
    ],
    [
      "conflicting store",
      (ref) => {
        const conflict = v.copy(ref.stores[0]);
        conflict.bindingVersion += 1;
        ref.stores.push(conflict);
      },
    ],
  ];
  for (const [name, corrupt] of malformed) {
    const wrong = v.copy(candidate);
    corrupt(wrong.preparation.priorWriterEvidence);
    assert.throws(() => parse("observationInput", wrong), name);
    const result = v.completeObservation();
    result.input = wrong;
    assert.throws(() => parse("observationResult", result), name);
  }
});

test("no-writer closure requires the named producer/capability and coherent journal attempt", () => {
  const wrongProducer = v.handoffResult();
  wrongProducer.producerDomains[0].closureEvidence.producerRef = "unrelated-producer";
  rejects("priorWriterResult", wrongProducer);
  const wrongPort = v.handoffResult();
  wrongPort.producerDomains[0].closureEvidence.acceptedPortRef = "unrelated-port";
  rejects("priorWriterResult", wrongPort);
  const contradictory = v.handoffResult();
  const owner = {
    kind: "attempt",
    ownerRef: "attempt-owner",
    attempt: v.attempt(),
    target: v.target(1),
  };
  contradictory.input.possibleWriters = [owner];
  contradictory.writers = [
    {
      owner,
      status: "terminated",
      execution: { target: v.target(1), binding: v.binding(1) },
      terminationEvidence: v.evidence(),
    },
  ];
  rejects("priorWriterResult", contradictory);
  contradictory.journalAttempt = {
    status: "attempt",
    attempt: v.attempt(),
    historicalOutcome: "unknown",
  };
  assert.equal(
    parse("priorWriterResult", contradictory).journalAttempt.historicalOutcome,
    "unknown",
  );
});

test("prepared request binds operation, predicate and canonical bytes; standalone fence request validates its gate", () => {
  const child = v.preparedChild();
  child.request.providerTarget.name = "different-name";
  rejects("preparedChild", child);
  const request = v.fenceRequest();
  request.guard.planDigest = v.digest(999);
  rejects("fenceRequest", request);
  const ordinary = v.fenceRequest();
  ordinary.guard.responsibility = v.responsibility();
  rejects("fenceRequest", ordinary);
  const gate = v.gateState();
  gate.ordinaryAdmission = "open";
  assert.throws(() => completeFence(gate, proposal()));
});

test("a protective inert reservation is callable while ordinary materialization stays closed", () => {
  const protective = v.createRequest();
  protective.effect.responsibility = v.responsibility("protective-fence");
  protective.gate = v.gate("protective-fence");
  protective.gate.mode = "stopped";
  v.signRequest(protective);
  parse("create", protective);
  protective.action = "materialize";
  protective.effect.effectKind = "materialize";
  protective.predicate = v.expectedObject();
  rejects("create", protective);
});

test("completed protective fence admits only a distinct current matching successor preparation", () => {
  const next = v.gate();
  next.gateVersion = 5;
  assert.equal(successorPreparationMatchesFence(next, v.fenceState()), true);
  assert.equal(successorPreparationMatchesFence(v.gate(), v.fenceState()), false);
  const wrong = v.copy(next);
  wrong.requestedFenceEpoch = 3;
  assert.equal(successorPreparationMatchesFence(wrong, v.fenceState()), false);
});

test("durable fault receipts correlate denial and exact cleanup without claiming stop", () => {
  const fault = v.fault();
  const state = {
    status: "accepted",
    receipt: {
      schemaVersion: 1,
      operation: fault.operation,
      fault,
      denialRecordRef: v.uuid(910),
      denialRecordVersion: 1,
      cleanupResponsibility: fault.cleanupResponsibility,
      fence: v.fenceRequest(),
      admission: "durably-closed",
      downstreamStop: "not-proved",
      evidence: v.evidence("denial-commit"),
    },
  };
  const result = parseRuntimeEffectsResponseV1("recordFaultAndRequestStop", fault, state);
  assert.equal(result.receipt.downstreamStop, "not-proved");
  const different = v.copy(state);
  different.receipt.cleanupResponsibility = v.responsibility();
  rejects("faultState", different);
  const foreign = v.copy(state);
  foreign.receipt.operation.scope.agentId = `agt_${v.uuid(911)}`;
  rejects("faultState", foreign);
  parseRuntimeEffectsResponseV1("readRequest", fault.operation, state);
  const admitted = {
    status: "admitted",
    child: v.preparedChild(),
    evidence: v.evidence("admission"),
  };
  parseRuntimeEffectsResponseV1("admitChild", admitted.child, admitted);
});

test("protective seal has an exact callable child without inventing an unbound runtime identity", () => {
  const create = v.createRequest();
  const seal = {
    schemaVersion: 1,
    kind: "seal-target",
    action: "seal",
    retainState: true,
    effect: {
      ...create.effect,
      effectKind: "seal",
      responsibility: v.responsibility("protective-fence"),
    },
    gate: v.gate("protective-fence"),
    plan: v.plan(),
    providerTarget: v.providerTarget(),
    predicate: v.expectedObject(),
    safeState: { kind: "replicas-zero", replicas: 0 },
  };
  v.signRequest(seal);
  parse("sealTarget", seal);
  const bytes = canonicalRuntimeEffectRequestV1(seal);
  const child = {
    ...v.preparedChild(),
    effect: seal.effect,
    guard: seal.gate,
    request: seal,
    predicate: seal.predicate,
    canonicalRequestJson: bytes,
    requestBytesDigest: v.hash(bytes),
  };
  parse("preparedChild", child);
  seal.safeState = { kind: "inactive-route", reservedUnmatchableRouteRef: "inactive" };
  rejects("sealTarget", seal);
});
