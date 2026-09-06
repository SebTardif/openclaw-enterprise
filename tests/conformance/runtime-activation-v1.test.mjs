import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeActivationOrchestratorV1 } from "@openclaw-enterprise/occ/runtime-activation-v1";
import {
  canonicalRuntimeEffectRequestV1,
  parseRuntimeEffectsResponseV1,
  parseRuntimeEffectExchangeV1,
  parseRuntimeEffectsV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import { decodeContainmentControlExchangeV1 } from "@openclaw-enterprise/contracts/containment-controls-codec-v1";
import {
  canonicalRuntimeAuthorityMutationV1,
  parseRuntimeAuthorityV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import { ContainmentFaultRequestAdapterV1 } from "@openclaw-enterprise/occ/containment/fault-request-adapter-v1";
import { sha256Hex } from "@openclaw-enterprise/utils";
import {
  setup,
  copy,
  same,
  names,
  count,
  effects,
  deferred,
  settle,
  routeResult,
  freshCall,
} from "../fixtures/runtime-activation-v1/peers.mjs";
import {
  expected as faultExpected,
  unresolved as faultUnknown,
} from "../fixtures/containment-evidence-v1/fault-values.mjs";

// Controlled protocol peers only. These tests do not authenticate a caller,
// persist owner state, observe a provider, or qualify actual admission/serving.
const activate = (s) => new RuntimeActivationOrchestratorV1(s.options).activate(s.input, s.call);
const noEffects = (s) => {
  for (const name of ["route", "cleanup", "retire", "fault"]) assert.equal(count(s, name), 0, name);
};
const resign = (request) => {
  request.effect.requestDigest = `sha256:${sha256Hex(canonicalRuntimeEffectRequestV1(request))}`;
};

test("complete controlled Harness evidence routes once without publishing serving", async () => {
  const s = setup();
  const result = await activate(s);
  assert.equal(result.status, "route-observed", result.reason);
  assert.equal(result.serving, "publication-unavailable");
  assert.equal(result.termination, "not-proved");
  assert.equal(count(s, "route"), 1);
  assert.equal(count(s, "cleanup"), 0);
  assert.ok(names(s).indexOf("resolve") < names(s).indexOf("controls"));
  assert.ok(names(s).indexOf("writers") < names(s).indexOf("store"));
  assert.ok(names(s).indexOf("store") < names(s).indexOf("route"));
  const beforeRoute = s.events
    .slice(0, names(s).indexOf("route"))
    .filter(([name]) => name === "checkpoint")
    .at(-1)[1];
  assert.equal(beforeRoute.operations[0].phase, "readback-only");
  same(beforeRoute.operations[0].request, s.input.route);
  same(result.state, s.retained);
  assert.ok(Object.isFrozen(result.state));
  assert.equal(s.clock.timers.size, 0);
});

for (const [name, mutate] of [
  [
    "missing selected profile",
    (s) => {
      s.input.selection = null;
    },
  ],
  [
    "incomplete control set",
    (s) => {
      s.input.selection.controls.pop();
      s.input.expected.requiredControls.pop();
    },
  ],
  [
    "duplicated selection",
    (s) => {
      s.input.selection.controls[7] = copy(s.input.selection.controls[0]);
    },
  ],
  [
    "mismatched containment selection",
    (s) => {
      s.input.selection.containmentProfile.digest = effects.digest(999);
    },
  ],
  [
    "mismatched runtime selection",
    (s) => {
      s.input.selection.runtimeProfile.digest = effects.digest(999);
    },
  ],
  [
    "future Gateway target",
    (s) => {
      s.input.expected.runtime.target.component = "gateway";
    },
  ],
  [
    "unselected cleanup purpose",
    (s) => {
      s.input.authority.purpose = "cleanup";
    },
  ],
  [
    "changed original request",
    (s) => {
      s.input.authority.requestRef = "changed";
    },
  ],
  [
    "changed route revision",
    (s) => {
      s.input.route.effect.target.revisionId = `rev_${effects.uuid(998)}`;
      s.input.route.desiredRoute.selectedTarget.revisionId = s.input.route.effect.target.revisionId;
      resign(s.input.route);
    },
  ],
  [
    "partial store list",
    (s) => {
      s.input.stores = [];
    },
  ],
])
  test(`${name} refuses before observation or any provider effect`, async () => {
    const s = setup();
    mutate(s);
    const result = await activate(s);
    assert.equal(result.status, "blocked");
    assert.equal(count(s, "controls"), 0);
    noEffects(s);
  });

test("accessors and malformed owner state are refused without empty-state reset", async () => {
  const s = setup();
  let invoked = 0;
  Object.defineProperty(s.input.state, "operations", {
    enumerable: true,
    get() {
      invoked++;
      return [];
    },
  });
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  assert.equal(result.state, null);
  assert.equal(invoked, 0);
  assert.equal(s.events.length, 0);
});

test("cursor/state mismatch refuses before observation", async () => {
  const s = setup();
  s.input.expected.after = { ...copy(s.observation.cursor), controlVersions: [] };
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  assert.equal(count(s, "controls"), 0);
  noEffects(s);
});

test("unknown control evidence retains actual evaluator state but cannot route", async () => {
  const s = setup();
  s.observation.runtimeObservation = {
    schemaVersion: 1,
    status: "unknown",
    input: copy(s.input.expected.runtime),
    reasonCode: "provider-outcome-unknown",
  };
  parseRuntimeEffectsV1("observationResult", s.observation.runtimeObservation);
  assert.equal(decodeContainmentControlExchangeV1(s.input.expected, s.observation).kind, "valid");
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  assert.equal(result.evaluation.decision, "unknown");
  assert.ok(result.evaluation.nextState);
  assert.equal(count(s, "checkpoint"), 1);
  noEffects(s);
  assert.notEqual(result.serving, "serving");
});

test("stale original evidence cannot become current by later observation time", async () => {
  const s = setup();
  s.clock.advance(20_000);
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  noEffects(s);
});

test("invalid evaluator history denies without retaining replacement history", async () => {
  const s = setup();
  s.input.state.evidence = {
    schemaVersion: 1,
    clock: null,
    subjects: [],
    retiredAssignments: [],
    unexpected: true,
  };
  s.retained = copy(s.input.state);
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  noEffects(s);
  assert.equal(count(s, "checkpoint"), 0);
  same(result.state.evidence, s.input.state.evidence);
});

test("continuation version overflow denies without changing owner state", async () => {
  const s = setup();
  s.input.state.version = Number.MAX_SAFE_INTEGER;
  s.retained = copy(s.input.state);
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  assert.equal(s.events.length, 0);
});

test("authority withdrawal during workspace work prevents conditional route", async () => {
  const s = setup();
  const original = s.options.authority.resolve;
  let reads = 0;
  s.options.authority.resolve = async (...args) => {
    reads++;
    if (reads > 1) {
      const denied = {
        schemaVersion: 1,
        result: "unavailable",
        reasonCode: "lookup-unavailable",
        evaluatedAt: new Date(s.clock.wall).toISOString(),
        requestRef: args[0].requestRef,
      };
      parseRuntimeAuthorityV1("resolveResult", denied);
      return denied;
    }
    return original(...args);
  };
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  assert.equal(reads, 2);
  assert.equal(result.evaluation.decision, "unknown");
  assert.ok(
    result.evaluation.findings.some((finding) => finding.reasonCode === "authority-unknown"),
  );
  noEffects(s);
});

test("evidence expiration during the pre-submission checkpoint preserves exact unsent operation", async () => {
  const s = setup();
  const original = s.options.owner.checkpoint;
  s.options.owner.checkpoint = async (previous, proposed, call) => {
    const result = await original(previous, proposed, call);
    if (proposed.operations.length > previous.operations.length) s.clock.advance(14_000);
    return result;
  };
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  noEffects(s);
  assert.ok(result.proposedState || result.state.operations.length === 1);
  assert.equal(s.retained.operations[0].phase, "readback-only");
});

test("unreleased prior writer blocks route even after satisfied controls", async () => {
  const s = setup();
  s.options.workspace.observePriorWriters = async (input) => ({
    schemaVersion: 1,
    status: "unavailable",
    input,
    reasonCode: "unavailable",
  });
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  assert.equal(result.evaluation.decision, "satisfied");
  noEffects(s);
});

test("an unverified selected store cannot be inferred from writer release", async () => {
  const s = setup();
  s.options.workspace.verifyStoreBinding = async (input) => ({
    schemaVersion: 1,
    status: "unknown",
    input,
    reasonCode: "unavailable",
  });
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  noEffects(s);
});

test("partial producer-domain closure cannot satisfy original no-writer semantics", async () => {
  const s = setup();
  const original = s.options.workspace.observePriorWriters;
  s.options.workspace.observePriorWriters = async (...args) => {
    const value = await original(...args);
    value.producerDomains = [];
    return value;
  };
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  noEffects(s);
});

test("owner conflict before submission never calls provider", async () => {
  const s = setup();
  s.options.owner.checkpoint = async () => "conflict";
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  assert.equal(result.stateRetention, "unknown");
  assert.ok(result.proposedState);
  noEffects(s);
});

test("lost owner acknowledgement preserves proposed state and prevents effect", async () => {
  const s = setup();
  const original = s.options.owner.checkpoint;
  s.options.owner.checkpoint = async (...args) => {
    await original(...args);
    throw new Error("controlled owner response loss");
  };
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  assert.equal(result.stateRetention, "unknown");
  assert.ok(result.proposedState);
  same(result.proposedState, s.retained);
  noEffects(s);
});

test("unknown route retains exact operation and recovery reads without resubmission", async () => {
  const s = setup();
  const original = s.options.effects.setRoute;
  s.options.effects.setRoute = async (...args) => {
    await original(...args);
    throw new Error("controlled provider response loss");
  };
  const orchestrator = new RuntimeActivationOrchestratorV1(s.options);
  const first = await orchestrator.activate(s.input, s.call);
  assert.equal(first.status, "blocked");
  assert.equal(first.state.operations[0].phase, "readback-only");
  const retry = await orchestrator.activate({ ...s.input, state: first.state }, s.call);
  assert.equal(retry.status, "blocked");
  assert.equal(count(s, "route"), 1);
  const recovered = await orchestrator.readOperation(
    first.state,
    s.input.route.effect.effectRef,
    freshCall(s, "independent-read"),
  );
  assert.equal(recovered.status, "readback", recovered.reason);
  assert.equal(count(s, "route"), 1);
  assert.equal(count(s, "readEffect"), 1);
  assert.equal(recovered.serving, "publication-unavailable");
});

test("historical read requires a distinct request and does not retry a missing effect", async () => {
  const s = setup();
  s.options.effects.setRoute = async () => {
    throw new Error("unknown submission");
  };
  const orchestrator = new RuntimeActivationOrchestratorV1(s.options);
  const result = await orchestrator.activate(s.input, s.call);
  const denied = await orchestrator.readOperation(
    result.state,
    s.input.route.effect.effectRef,
    s.call,
  );
  assert.equal(denied.status, "blocked");
  assert.equal(count(s, "readEffect"), 0);
  const read = await orchestrator.readOperation(
    result.state,
    s.input.route.effect.effectRef,
    freshCall(s, "read-missing"),
  );
  assert.equal(read.status, "readback", read.reason);
  assert.equal(read.operation.phase, "readback-only");
  assert.equal(read.termination, "not-proved");
});

test("readback rejects a coherent receipt for changed original route bytes", async () => {
  const s = setup();
  s.options.effects.setRoute = async () => {
    throw new Error("unknown submission");
  };
  const orchestrator = new RuntimeActivationOrchestratorV1(s.options);
  const first = await orchestrator.activate(s.input, s.call);
  const altered = copy(s.input.route);
  altered.desiredRoute.binding.profileDigests.runtime = effects.digest(996);
  resign(altered);
  s.effectHistory.set(altered.effect.effectRef, routeResult(altered));
  const result = await orchestrator.readOperation(
    first.state,
    altered.effect.effectRef,
    freshCall(s, "read-changed"),
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.state.operations[0].phase, "readback-only");
});

test("abort before any work leaves all original ports untouched", async () => {
  const s = setup();
  s.abort.abort();
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  assert.equal(s.events.length, 0);
});

test("local read deadline preserves original call deadline and bounds a stalled dependency", async () => {
  const s = setup();
  const wait = deferred();
  let received;
  s.options.authority.resolve = async (_input, call) => {
    received = call;
    return wait.promise;
  };
  const pending = activate(s);
  await settle();
  assert.equal(received.deadline, s.call.deadline);
  assert.equal(received.context, s.call.context);
  assert.notEqual(received.signal, s.call.signal);
  s.clock.advance(3_000);
  const result = await pending;
  assert.equal(result.status, "blocked");
  assert.equal(received.signal.aborted, true);
  noEffects(s);
  wait.resolve(copy(s.authorityResult));
  await settle();
  assert.equal(s.clock.timers.size, 0);
});

test("monotonic clock rollback after an await denies further work", async () => {
  const s = setup();
  const original = s.options.authority.resolve;
  s.options.authority.resolve = async (...args) => {
    const result = await original(...args);
    s.clock.monotonic--;
    return result;
  };
  const result = await activate(s);
  assert.equal(result.status, "blocked");
  noEffects(s);
  assert.equal(count(s, "controls"), 0);
});

test("cancellation after possible route submission retains recovery-only history", async () => {
  const s = setup();
  let received;
  const wait = deferred();
  const original = s.options.effects.setRoute;
  s.options.effects.setRoute = async (...args) => {
    received = args[1];
    await original(...args);
    return wait.promise;
  };
  const pending = activate(s);
  for (let i = 0; i < 100 && !received; i++) await settle();
  assert.ok(received);
  s.abort.abort();
  const result = await pending;
  assert.equal(result.status, "blocked");
  assert.equal(result.state.operations[0].phase, "readback-only");
  assert.equal(count(s, "route"), 1);
  assert.equal(received.signal.aborted, true);
  wait.resolve(routeResult(s.input.route));
  await settle();
  assert.equal(count(s, "route"), 1);
});

test("ten-second provider wait cannot convert a late route result into current success", async () => {
  const s = setup();
  const wait = deferred();
  let called = false;
  s.options.effects.setRoute = async () => {
    called = true;
    return wait.promise;
  };
  const pending = activate(s);
  for (let i = 0; i < 100 && !called; i++) await settle();
  assert.equal(called, true);
  s.clock.advance(10_000);
  const result = await pending;
  assert.equal(result.status, "blocked");
  assert.equal(result.state.operations[0].phase, "readback-only");
  assert.equal(result.serving, "publication-unavailable");
  wait.resolve(routeResult(s.input.route));
  await settle();
  assert.equal(s.clock.timers.size, 0);
});

test("retirement uses independent cleanup authority and exact original effects", async () => {
  const s = setup();
  const orchestrator = new RuntimeActivationOrchestratorV1(s.options);
  const result = await orchestrator.retire(
    s.retirement,
    freshCall(s, s.retirement.retirement.requestRef),
  );
  assert.equal(result.status, "retirement-observed", result.reason);
  assert.equal(result.termination, "observed");
  assert.equal(result.serving, "publication-unavailable");
  assert.equal(result.state.activationClosed, true);
  assert.equal(count(s, "retire"), 1);
  assert.equal(count(s, "route"), 1);
  assert.equal(count(s, "cleanup"), 1);
  assert.ok(
    s.events
      .filter(([name]) => name === "resolve")
      .every(([, input]) => input.purpose === "cleanup"),
  );
  same(
    s.events.find(([name]) => name === "cleanup")[1].retainedStores,
    s.retirement.cleanup.retainedStores,
  );
});

test("lost retirement COMMIT response keeps original identity and does not route or clean up", async () => {
  const s = setup();
  const original = s.options.authority.retire;
  s.options.authority.retire = async (...args) => {
    await original(...args);
    throw new Error("lost retirement response");
  };
  const orchestrator = new RuntimeActivationOrchestratorV1(s.options);
  const first = await orchestrator.retire(
    s.retirement,
    freshCall(s, s.retirement.retirement.requestRef),
  );
  assert.equal(first.status, "blocked");
  assert.equal(first.state.activationClosed, true);
  assert.equal(count(s, "route"), 0);
  assert.equal(count(s, "cleanup"), 0);
  const recovered = await orchestrator.readOperation(
    first.state,
    s.retirement.retirement.operationRef,
    freshCall(s, "retirement-history-read"),
  );
  assert.equal(recovered.status, "readback", recovered.reason);
  assert.equal(count(s, "retire"), 1);
  assert.equal(recovered.termination, "not-proved");
});

test("mismatched predecessor binding refuses retirement before mutating authority", async () => {
  const s = setup();
  s.retirement.retirement.bindingVersion++;
  const result = await new RuntimeActivationOrchestratorV1(s.options).retire(
    s.retirement,
    freshCall(s, s.retirement.retirement.requestRef),
  );
  assert.equal(result.status, "blocked");
  noEffects(s);
});

test("unconfirmed inactive route blocks exact cleanup and preserves original effect", async () => {
  const s = setup();
  s.options.effects.setRoute = async (input) => effects.unknownResult(input);
  const result = await new RuntimeActivationOrchestratorV1(s.options).retire(
    s.retirement,
    freshCall(s, s.retirement.retirement.requestRef),
  );
  assert.equal(result.status, "blocked");
  assert.equal(count(s, "cleanup"), 0);
  assert.equal(result.state.operations.at(-1).phase, "readback-only");
  assert.equal(result.termination, "not-proved");
});

test("fault request uses original adapter and accepted stop request is not physical stop", async () => {
  const s = setup();
  const fault = effects.fault();
  const result = await new RuntimeActivationOrchestratorV1(s.options).requestFault(
    { state: s.input.state, fault, expected: faultExpected(fault) },
    freshCall(s, "independent-fault"),
  );
  assert.equal(result.status, "fault-request", result.reason);
  assert.equal(count(s, "fault"), 1);
  assert.equal(result.state.activationClosed, true);
  assert.equal(result.termination, "not-proved");
  assert.equal(count(s, "cleanup"), 0);
  same(s.events.find(([name]) => name === "fault")[1], fault);
});

test("unknown fault result keeps original operation readback-only and prevents activation", async () => {
  const s = setup();
  const fault = effects.fault();
  s.options.faults.recordFaultAndRequestStop = async (input) => faultUnknown(input);
  const orchestrator = new RuntimeActivationOrchestratorV1(s.options);
  const result = await orchestrator.requestFault(
    { state: s.input.state, fault, expected: faultExpected(fault) },
    freshCall(s, "independent-fault"),
  );
  assert.equal(result.status, "fault-request", result.reason);
  assert.equal(result.state.operations[0].phase, "readback-only");
  const blocked = await orchestrator.activate({ ...s.input, state: result.state }, s.call);
  assert.equal(blocked.status, "blocked");
  noEffects(s);
});

for (const status of ["unknown", "not-found", "pending"])
  test(`resolved history cannot conceal original ${status} effect`, async () => {
    const s = setup();
    const request = copy(s.input.route);
    const result =
      status === "unknown"
        ? effects.unknownResult(request)
        : status === "not-found"
          ? { schemaVersion: 1, status: "not-found", outcome: "unknown", effect: request.effect }
          : routeResult(request, "pending");
    parseRuntimeEffectsResponseV1("readEffect", request.effect, result);
    if (status !== "not-found") parseRuntimeEffectExchangeV1(request, result);
    s.input.state.operations = [
      {
        kind: "effect",
        request,
        originalRequestRef: "old-effect-request",
        phase: "resolved",
        result,
      },
    ];
    const actual = await activate(s);
    assert.equal(actual.status, "blocked");
    assert.equal(actual.reason, "invalid-state");
    assert.equal(s.events.length, 0);
  });

for (const status of ["commit-unknown", "not-found"])
  test(`resolved history cannot conceal authority ${status}`, async () => {
    const s = setup();
    const request = copy(s.retirement.retirement);
    const operation = {
      schemaVersion: 1,
      installationId: request.target.installationId,
      namespaceId: request.target.namespaceId,
      agentId: request.target.agentId,
      operationRef: request.operationRef,
      operationKind: "retire",
      requestRef: request.requestRef,
      canonicalPayloadDigest: `sha256:${sha256Hex(canonicalRuntimeAuthorityMutationV1(request))}`,
    };
    const result =
      status === "commit-unknown"
        ? { schemaVersion: 1, result: status, operation, nextAction: "exact-readback-only" }
        : { schemaVersion: 1, result: status, nextAction: "exact-readback-only" };
    parseRuntimeAuthorityV1(
      status === "commit-unknown" ? "mutationResult" : "operationState",
      result,
    );
    s.retirement.state = {
      ...copy(s.input.state),
      activationClosed: true,
      operations: [
        {
          kind: "authority-retirement",
          request,
          originalRequestRef: "old-retirement-request",
          phase: "resolved",
          result,
        },
      ],
    };
    const actual = await new RuntimeActivationOrchestratorV1(s.options).retire(
      s.retirement,
      freshCall(s, s.retirement.retirement.requestRef),
    );
    assert.equal(actual.status, "blocked");
    assert.equal(actual.reason, "invalid-state");
    assert.equal(s.events.length, 0);
  });

for (const phase of ["readback-only", "resolved"])
  test(`resolved outer fault history rejects ${phase} continuation with unknown result`, async () => {
    const s = setup();
    const fault = effects.fault();
    const adapter = new ContainmentFaultRequestAdapterV1({
      sink: s.options.faults,
      clock: s.clock.port,
    });
    const prepared = adapter.prepare(fault, faultExpected(fault));
    assert.equal(prepared.status, "prepared");
    const continuation = { ...copy(prepared.continuation), phase };
    const result = {
      scope: "fault-request-adapter-only",
      admission: "denied",
      downstreamStop: "not-proved",
      status: "commit-unknown",
      result: faultUnknown(fault),
      continuation,
    };
    s.retirement.state = {
      ...copy(s.input.state),
      activationClosed: true,
      operations: [
        { kind: "fault", continuation, result, phase: "resolved", originalRequestRef: "old-fault" },
      ],
    };
    const actual = await new RuntimeActivationOrchestratorV1(s.options).retire(
      s.retirement,
      freshCall(s, s.retirement.retirement.requestRef),
    );
    assert.equal(actual.status, "blocked");
    assert.equal(actual.reason, "invalid-state");
    assert.equal(s.events.length, 0);
  });

test("expired historical terminal route evidence remains valid retained history", async () => {
  const s = setup();
  const original = await activate(s);
  assert.equal(original.status, "route-observed");
  s.events = [];
  s.clock.advance(20_000);
  const result = await new RuntimeActivationOrchestratorV1(s.options).readOperation(
    original.state,
    s.input.route.effect.effectRef,
    freshCall(s, "old-route-read"),
  );
  assert.equal(result.status, "readback", result.reason);
  assert.equal(count(s, "readEffect"), 1);
  assert.equal(result.serving, "publication-unavailable");
  assert.equal(result.operation.phase, "resolved");
  same(result.state, original.state);
  assert.equal(count(s, "checkpoint"), 0);
});

test("a later unknown lookup cannot replace confirmed original terminal history", async () => {
  const s = setup();
  const original = await activate(s);
  assert.equal(original.status, "route-observed");
  s.events = [];
  s.effectHistory.set(s.input.route.effect.effectRef, effects.unknownResult(s.input.route));
  const result = await new RuntimeActivationOrchestratorV1(s.options).readOperation(
    original.state,
    s.input.route.effect.effectRef,
    freshCall(s, "terminal-followup"),
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "historical-result-mismatch");
  same(result.state, original.state);
  same(result.operation, original.state.operations[0]);
  assert.equal(count(s, "checkpoint"), 0);
});

for (const [kind, remaining] of [
  ["activation", 4],
  ["retirement", 6],
  ["fault", 2],
])
  test(`${kind} refuses when its last mandatory checkpoint cannot be retained`, async () => {
    const s = setup();
    s.input.state.version = Number.MAX_SAFE_INTEGER - remaining;
    s.retained = copy(s.input.state);
    s.retirement.state = copy(s.input.state);
    const consumer = new RuntimeActivationOrchestratorV1(s.options);
    const fault = effects.fault();
    const result =
      kind === "activation"
        ? await consumer.activate(s.input, s.call)
        : kind === "retirement"
          ? await consumer.retire(s.retirement, freshCall(s, s.retirement.retirement.requestRef))
          : await consumer.requestFault(
              { state: s.input.state, fault, expected: faultExpected(fault) },
              freshCall(s, "capacity-fault"),
            );
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "state-capacity");
    assert.equal(s.events.length, 0);
  });

test("exact six-checkpoint retirement capacity retains its final cleanup result", async () => {
  const s = setup();
  s.retirement.state.version = Number.MAX_SAFE_INTEGER - 7;
  s.retained = copy(s.retirement.state);
  const result = await new RuntimeActivationOrchestratorV1(s.options).retire(
    s.retirement,
    freshCall(s, s.retirement.retirement.requestRef),
  );
  assert.equal(result.status, "retirement-observed", result.reason);
  assert.equal(result.state.version, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(result.state.operations.at(-1).phase, "resolved");
  same(result.state, s.retained);
});
