import assert from "node:assert/strict";
import test from "node:test";
import {
  LIFECYCLE_OBSERVATION_LIMITS_V1,
  LifecycleObservationSchemasV1,
  LifecycleObservationErrorV1,
  parseLifecycleObservationV1 as parse,
  decodeLifecycleObservationV1 as decode,
} from "../../packages/contracts/src/lifecycle-observation-v1.ts";
import {
  RuntimeEffectsSchemasV1,
  parseRuntimeEffectsV1,
} from "../../packages/contracts/src/runtime-effects-v1.ts";

// Synthetic declarations exercise the actual pure codecs. They do not establish
// persisted operations, source provenance, current authority or physical stop.
const uuid = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ns = `ns_${uuid()}`;
const agent = `agt_${uuid(2)}`;
const revision = `rev_${uuid(3)}`;
const time = "2026-09-06T12:00:00.000Z";
const later = "2026-09-06T12:00:10.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const plain = (value) => JSON.parse(JSON.stringify(value));
const scope = () => ({ installationId: `ins_${uuid(4)}`, namespaceId: ns, agentId: agent });
const work = () => ({
  schemaVersion: 1,
  handler: "ReconcileAgentLifecycleV1",
  namespaceId: ns,
  agentId: agent,
  operationRef: uuid(5),
  lifecycleGeneration: 2,
  workId: "retained:work:example",
});
const condition = (status = "unknown") => ({
  status,
  observedAt: status === "confirmed" ? time : null,
  recordedAt: status === "confirmed" ? later : null,
  reasonCode:
    status === "confirmed" ? "NONE" : status === "not-requested" ? "NOT_REQUESTED" : "NOT_OBSERVED",
});
const observation = () => ({
  phase: "pending",
  attempt: 0,
  step: "observe",
  reasonCode: "NOT_OBSERVED",
  observedAt: null,
  recordedAt: null,
  retryAt: null,
});
function status(mode = null) {
  return {
    namespaceId: ns,
    agentId: agent,
    head:
      mode === null
        ? null
        : {
            operationRef: uuid(5),
            lifecycleGeneration: 2,
            desiredMode: mode,
            requestedRevisionId: revision,
          },
    requestedRevisionId: mode === null ? null : revision,
    selectedRevisionId: null,
    servingRevisionId: null,
    observedLifecycleGeneration: null,
    phase: "pending",
    attempt: 0,
    step: "observe",
    reasonCode: mode === null ? "LIFECYCLE_UNINITIALIZED" : "NOT_OBSERVED",
    retryAt: null,
    conditions: {
      accessDenied: condition(),
      routeRemoved: condition(),
      executionTerminated: condition(),
      credentialRevocation: condition("not-requested"),
      stateRetention: condition(),
    },
    serving: false,
    stopComplete: false,
    retention: "verification-pending",
  };
}
function converged(mode) {
  const value = status(mode);
  Object.assign(value, {
    observedLifecycleGeneration: 2,
    phase: "converged",
    reasonCode: "NONE",
    attempt: 1,
  });
  if (mode === "running")
    Object.assign(value, {
      serving: true,
      servingRevisionId: revision,
      selectedRevisionId: revision,
    });
  else {
    value.conditions.accessDenied = condition("confirmed");
    value.conditions.routeRemoved = condition("confirmed");
    if (mode === "stopped") {
      value.conditions.executionTerminated = condition("confirmed");
      value.stopComplete = true;
    }
  }
  return value;
}
const operation = () => ({
  operationRef: uuid(5),
  lifecycleGeneration: 2,
  acceptedAt: time,
  kind: "deploy",
  desiredMode: "running",
  revisionSource: "saved-draft",
  requestedRevisionId: revision,
});
const capability = (stage = "legacy") => ({
  schemaVersion: 1,
  protocol: "lifecycle-control-v1",
  stage,
  capabilityVersion: 1,
  supportedConsumerVersions: {
    api: stage === "legacy" ? null : 1,
    worker: stage === "legacy" ? null : 1,
    maintenance: stage === "live" ? 1 : null,
    receiving: stage === "legacy" ? null : 1,
  },
});
const target = () => ({
  ...scope(),
  assignmentRef: { schemaVersion: 1, id: uuid(6) },
  revisionId: revision,
  component: "harness",
  lifecycleGeneration: 2,
  runtimeGeneration: 1,
  createEffectRef: uuid(7),
});
const effect = (n = 8) => ({
  schemaVersion: 1,
  target: target(),
  effectRef: uuid(n),
  effectKind: "materialize",
  responsibility: { responsibilityRef: uuid(9), responsibilityVersion: 1, kind: "preparation" },
  requestDigest: digest,
});
function fence() {
  const plan = {
    schemaVersion: 1,
    scope: scope(),
    planRef: "retained-plan",
    planVersion: 1,
    planDigest: digest,
    targets: [
      {
        target: {
          targetRef: "retained-deployment",
          clusterRef: "example-cluster",
          kubernetesNamespaceUid: "example-namespace",
          apiKind: "Deployment",
          name: "example-runtime",
          ownerAssignmentRef: target().assignmentRef,
          ownerCreateEffectRef: target().createEffectRef,
        },
        desiredSpecDigest: digest,
        allowedMutations: ["reserve-inert", "materialize", "seal"],
      },
    ],
    producerDomains: [
      {
        domainRef: "descendant-domain",
        kind: "deployment-descendants",
        targetRefs: ["retained-deployment"],
        requiredProducerRef: "deployment-observer",
        requiredCapabilityRef: "descendant-closure",
      },
      {
        domainRef: "execution-domain",
        kind: "node-start-restart",
        targetRefs: ["retained-deployment"],
        requiredProducerRef: "execution-observer",
        requiredCapabilityRef: "start-closure",
      },
    ],
    reservationRetention: "permanent",
    capacityPolicyRef: "bounded-profile",
  };
  return {
    schemaVersion: 1,
    fenceRef: uuid(10),
    requestDigest: digest,
    guard: {
      schemaVersion: 1,
      scope: scope(),
      intentRef: work().operationRef,
      mode: "stopped",
      lifecycleGeneration: 2,
      requestedFenceEpoch: 1,
      responsibility: {
        responsibilityRef: uuid(11),
        responsibilityVersion: 1,
        kind: "retained-stop",
      },
      gateVersion: 1,
      planRef: plan.planRef,
      planVersion: 1,
      planDigest: digest,
      admittedChildCutoff: 0,
    },
    plan,
    children: [],
  };
}
function unknown(kind = "effect-unknown") {
  const value = {
    schemaVersion: 1,
    kind,
    work: work(),
    step: "prepare",
    phase: "submission",
    selectedRequestStartedAt: time,
    selectedRequestDeadlineAt: later,
    recordedAt: later,
    reasonCode: "DEPENDENCY_UNAVAILABLE",
  };
  if (kind === "effect-unknown") value.effect = effect();
  if (kind === "authority-unknown")
    value.operation = {
      schemaVersion: 1,
      ...scope(),
      operationRef: uuid(12),
      operationKind: "bind",
      canonicalPayloadDigest: digest,
      requestRef: "original:authority-request",
    };
  if (kind === "fence-unknown") {
    value.fence = fence();
    value.step = "deny-predecessor";
  }
  if (kind === "cleanup-unknown") {
    value.operation = {
      schemaVersion: 1,
      scope: scope(),
      operationRef: uuid(13),
      operationKind: "fault-and-fence",
      requestDigest: digest,
    };
    value.step = "cleanup";
  }
  return value;
}
function invalid(kind, value, label) {
  assert.throws(
    () => parse(kind, value),
    {
      name: "LifecycleObservationErrorV1",
      code: "INVALID_REQUEST",
      message: "Invalid lifecycle observation data.",
    },
    label,
  );
  assert.deepEqual(decode(kind, value), { kind: "invalid" });
}
function mutated(value, change) {
  const output = structuredClone(value);
  change(output);
  return output;
}
function objects(value, path = []) {
  if (value === null || typeof value !== "object") return [];
  return [
    [path, value],
    ...Object.entries(value).flatMap(([key, child]) => objects(child, [...path, key])),
  ];
}
function at(value, path) {
  return path.reduce((parent, key) => parent[key], value);
}

test("registry and all schema nodes are immutable without freezing imported effect schemas", () => {
  assert.deepEqual(
    Object.keys(LifecycleObservationSchemasV1).sort(),
    [
      "observation",
      "condition",
      "status",
      "operationStatus",
      "pageRequest",
      "page",
      "capability",
      "handlerResult",
    ].sort(),
  );
  for (const [, node] of objects(LifecycleObservationSchemasV1)) assert.ok(Object.isFrozen(node));
  assert.notEqual(
    LifecycleObservationSchemasV1.handlerResult.anyOf[1].properties.effect,
    RuntimeEffectsSchemasV1.effectLocator,
  );
  assert.equal(Object.isFrozen(RuntimeEffectsSchemasV1.effectLocator), false);
  assert.ok(new LifecycleObservationErrorV1() instanceof Error);
});

test("canonical no-head status is data with no selected or observed runtime", () => {
  assert.deepEqual(plain(parse("status", status())), status());
  for (const change of [
    (v) => {
      v.serving = true;
    },
    (v) => {
      v.stopComplete = true;
    },
    (v) => {
      v.observedLifecycleGeneration = 1;
    },
    (v) => {
      v.requestedRevisionId = revision;
    },
    (v) => {
      v.phase = "converged";
      v.reasonCode = "NONE";
    },
  ])
    invalid("status", mutated(status(), change));
});

test("all nested public status objects are closed and required fields cannot be omitted", () => {
  const value = status("running");
  for (const [path, node] of objects(value)) {
    for (const key of Object.keys(node))
      invalid(
        "status",
        mutated(value, (v) => {
          delete at(v, path)[key];
        }),
      );
    invalid(
      "status",
      mutated(value, (v) => {
        at(v, path).authority = true;
      }),
    );
  }
});

test("all other envelopes and nested retained identities reject missing and external fields", () => {
  const entries = [
    ["observation", observation()],
    ["condition", condition()],
    ["operationStatus", { operation: operation(), observation: observation() }],
    [
      "pageRequest",
      { schemaVersion: 1, namespaceId: ns, agentId: agent, afterGeneration: null, limit: 20 },
    ],
    ["page", { operations: [], nextAfterGeneration: null }],
    ["capability", capability()],
    ...["effect-unknown", "authority-unknown", "fence-unknown", "cleanup-unknown"].map((kind) => [
      "handlerResult",
      unknown(kind),
    ]),
  ];
  for (const [kind, value] of entries) {
    assert.deepEqual(plain(parse(kind, value)), value);
    for (const [path, node] of objects(value)) {
      if (Array.isArray(node)) continue;
      for (const key of Object.keys(node))
        invalid(
          kind,
          mutated(value, (v) => {
            delete at(v, path)[key];
          }),
        );
      invalid(
        kind,
        mutated(value, (v) => {
          at(v, path).credential = "private";
        }),
        `${kind}:${path.join(".")}`,
      );
    }
  }
});

test("positive generations reject absent null zero negative unsafe and coercible values", () => {
  const values = [
    undefined,
    null,
    0,
    -0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    "2",
    true,
    {},
    [],
  ];
  for (const bad of values) {
    invalid(
      "status",
      mutated(status("running"), (v) => {
        v.head.lifecycleGeneration = bad;
      }),
    );
    invalid(
      "handlerResult",
      mutated(unknown(), (v) => {
        v.work.lifecycleGeneration = bad;
      }),
    );
  }
  invalid(
    "status",
    mutated(status("running"), (v) => {
      delete v.head.lifecycleGeneration;
    }),
  );
  assert.equal(
    parse(
      "status",
      mutated(status("running"), (v) => {
        v.head.lifecycleGeneration = Number.MAX_SAFE_INTEGER;
      }),
    ).head.lifecycleGeneration,
    Number.MAX_SAFE_INTEGER,
  );
});

test("nullable observation generation and initial protective revision use canonical admission rules", () => {
  for (const mode of ["disabled", "stopped"]) {
    const value = status(mode);
    value.head.lifecycleGeneration = 1;
    value.head.requestedRevisionId = null;
    value.requestedRevisionId = null;
    assert.equal(parse("status", value).head.requestedRevisionId, null);
    invalid(
      "status",
      mutated(value, (v) => {
        v.head.requestedRevisionId = revision;
        v.requestedRevisionId = revision;
      }),
    );
  }
  invalid(
    "status",
    mutated(status("running"), (v) => {
      v.head.requestedRevisionId = null;
      v.requestedRevisionId = null;
    }),
  );
  invalid(
    "status",
    mutated(status("running"), (v) => {
      v.observedLifecycleGeneration = 0;
    }),
  );
  invalid(
    "status",
    mutated(status("running"), (v) => {
      v.observedLifecycleGeneration = 3;
    }),
  );
  invalid(
    "status",
    mutated(status("running"), (v) => {
      v.requestedRevisionId = `rev_${uuid(99)}`;
    }),
  );
});

test("selected revision alone does not set serving and false preserves a historical serving ID", () => {
  const value = status("running");
  value.selectedRevisionId = revision;
  value.servingRevisionId = `rev_${uuid(99)}`;
  value.observedLifecycleGeneration = 1;
  assert.equal(parse("status", value).serving, false);
  assert.equal(parse("status", value).servingRevisionId, value.servingRevisionId);
  invalid(
    "status",
    mutated(value, (v) => {
      v.serving = true;
    }),
  );
});

test("current serving claims require correlated running head observed generation and all revision IDs", () => {
  assert.equal(parse("status", converged("running")).serving, true);
  for (const change of [
    (v) => {
      v.observedLifecycleGeneration = 1;
    },
    (v) => {
      v.observedLifecycleGeneration = null;
    },
    (v) => {
      v.head.desiredMode = "disabled";
    },
    (v) => {
      v.servingRevisionId = null;
    },
    (v) => {
      v.selectedRevisionId = `rev_${uuid(90)}`;
    },
    (v) => {
      v.servingRevisionId = `rev_${uuid(90)}`;
    },
    (v) => {
      v.conditions.accessDenied = condition("confirmed");
    },
    (v) => {
      v.conditions.routeRemoved = condition("confirmed");
    },
    (v) => {
      v.conditions.executionTerminated = condition("confirmed");
    },
  ])
    invalid("status", mutated(converged("running"), change));
});

test("disabled convergence leaves execution credential and retention outcomes independent", () => {
  const value = converged("disabled");
  assert.equal(parse("status", value).stopComplete, false);
  assert.equal(parse("status", value).conditions.executionTerminated.status, "unknown");
  for (const key of ["accessDenied", "routeRemoved"])
    invalid(
      "status",
      mutated(value, (v) => {
        v.conditions[key] = condition();
      }),
    );
  invalid(
    "status",
    mutated(value, (v) => {
      v.stopComplete = true;
    }),
  );
  // Affirmative aggregate declarations pass only necessary shape correlations;
  // the actual producer still owes durable cancellation and source verification.
});

test("stopped completion requires current stopped intent and all three physical conditions", () => {
  const value = converged("stopped");
  assert.equal(parse("status", value).stopComplete, true);
  assert.equal(parse("status", value).conditions.credentialRevocation.status, "not-requested");
  assert.equal(parse("status", value).retention, "verification-pending");
  for (const key of ["accessDenied", "routeRemoved", "executionTerminated"])
    for (const state of ["pending", "unknown", "not-requested"])
      invalid(
        "status",
        mutated(value, (v) => {
          v.conditions[key] = condition(state);
        }),
      );
  invalid(
    "status",
    mutated(value, (v) => {
      v.head.desiredMode = "disabled";
    }),
  );
  invalid(
    "status",
    mutated(value, (v) => {
      v.observedLifecycleGeneration = 1;
    }),
  );
  invalid(
    "status",
    mutated(value, (v) => {
      v.stopComplete = false;
    }),
  );
  invalid("status", { ...value, allCreatesResolved: true });
  invalid("status", { ...value, writers: [] });
});

test("retention has a closed independent aggregate without purge or store contents", () => {
  for (const retention of ["verification-pending", "unknown"])
    assert.equal(parse("status", { ...converged("stopped"), retention }).stopComplete, true);
  const value = converged("stopped");
  value.retention = "retained";
  value.conditions.stateRetention = condition("confirmed");
  assert.equal(parse("status", value).retention, "retained");
  invalid("status", { ...status("stopped"), retention: "retained" });
  for (const retention of ["purged", "purge-complete", { workspace: "retained" }])
    invalid("status", { ...value, retention });
});

test("stale superseded observations cannot promote the current head or retry terminal progress", () => {
  const value = status("stopped");
  Object.assign(value, {
    observedLifecycleGeneration: 1,
    phase: "superseded",
    reasonCode: "SUPERSEDED",
  });
  assert.equal(parse("status", value).observedLifecycleGeneration, 1);
  for (const change of [
    (v) => {
      v.observedLifecycleGeneration = 2;
    },
    (v) => {
      v.observedLifecycleGeneration = null;
    },
    (v) => {
      v.reasonCode = "NONE";
    },
    (v) => {
      v.retryAt = later;
    },
  ])
    invalid("status", mutated(value, change));
  invalid("status", { ...status("running"), reasonCode: "SUPERSEDED" });
});

test("source and receipt clocks are preserved independently with the accepted uncertainty", () => {
  const old = {
    ...condition("confirmed"),
    observedAt: "2020-01-01T00:00:00.000Z",
    recordedAt: time,
  };
  assert.deepEqual(plain(parse("condition", old)), old);
  const skewed = { ...old, observedAt: "2026-09-06T12:00:02.000Z" };
  assert.deepEqual(plain(parse("condition", skewed)), skewed);
  invalid("condition", { ...skewed, observedAt: "2026-09-06T12:00:02.001Z" });
  invalid("condition", { ...old, recordedAt: null });
  // A local denial can carry an actual OCC receipt without provider time.
  assert.equal(
    parse("condition", {
      status: "confirmed",
      observedAt: null,
      recordedAt: time,
      reasonCode: "AUTHORITY_DENIED",
    }).observedAt,
    null,
  );
  assert.equal(
    parse("condition", { ...condition("not-requested"), recordedAt: time }).recordedAt,
    time,
  );
});

test("timestamp formats calendar validity and lexical scalar types are strict", () => {
  for (const bad of [
    "2026-02-30T12:00:00.000Z",
    "2026-09-06T12:00:00Z",
    "2026-09-06T12:00:00.000+00:00",
    "2026-09-06T24:00:00.000Z",
    "2026-09-06T12:00:60.000Z",
    "2026-09-06T12:00:00.000z",
    0,
    new Date(time),
  ])
    invalid("observation", { ...observation(), recordedAt: bad });
  for (const bad of [-0, -1, 0.5, Infinity, NaN, "0", null])
    invalid("observation", { ...observation(), attempt: bad });
  assert.equal(
    parse("observation", { ...observation(), attempt: Number.MAX_SAFE_INTEGER }).attempt,
    Number.MAX_SAFE_INTEGER,
  );
});

test("phases seven steps and seventeen safe reasons are closed without raw error disclosure", () => {
  const steps = [
    "observe",
    "deny-predecessor",
    "terminate-predecessor",
    "prepare",
    "activate",
    "publish",
    "cleanup",
  ];
  for (const step of steps)
    assert.equal(parse("observation", { ...observation(), step }).step, step);
  const reasons = [
    "NONE",
    "LIFECYCLE_UNINITIALIZED",
    "NOT_OBSERVED",
    "AUTHORITY_DENIED",
    "DEPENDENCY_UNAVAILABLE",
    "PROFILE_UNAVAILABLE",
    "PREDECESSOR_UNRESOLVED",
    "CREATE_OUTCOME_UNKNOWN",
    "AMBIGUOUS_PROVIDER_INSTANCE",
    "ROUTE_OUTCOME_UNKNOWN",
    "TERMINATION_UNKNOWN",
    "CREDENTIAL_OUTCOME_UNKNOWN",
    "STATE_UNAVAILABLE",
    "RESTORE_OUTCOME_UNKNOWN",
    "RECONCILIATION_EXHAUSTED",
  ];
  for (const reasonCode of reasons)
    assert.equal(parse("observation", { ...observation(), reasonCode }).reasonCode, reasonCode);
  assert.equal(
    parse("observation", { ...observation(), phase: "superseded", reasonCode: "SUPERSEDED" }).phase,
    "superseded",
  );
  assert.equal(parse("condition", condition("not-requested")).reasonCode, "NOT_REQUESTED");
  for (const extra of [
    { error: "provider transcript" },
    { credential: "secret" },
    { actorId: "operator" },
    { sourceObservedAt: time },
    { runtimeUid: "pod" },
  ])
    invalid("observation", { ...observation(), ...extra });
  for (const patch of [
    { step: "retry" },
    { phase: "finished" },
    { reasonCode: "provider-error-with-secret" },
    { phase: "converged", reasonCode: "CREATE_OUTCOME_UNKNOWN" },
    { phase: "converged", reasonCode: "NONE", retryAt: later },
  ])
    invalid("observation", { ...observation(), ...patch });
});

test("operation read keeps historical observation times and exact requested revision lineage", () => {
  const value = {
    operation: operation(),
    observation: {
      ...observation(),
      phase: "converged",
      reasonCode: "NONE",
      observedAt: "2020-01-01T00:00:00.000Z",
      recordedAt: "2020-01-01T00:00:00.100Z",
    },
  };
  assert.deepEqual(plain(parse("operationStatus", value)), value);
  invalid(
    "operationStatus",
    mutated(value, (v) => {
      v.operation.requestedRevisionId = null;
    }),
  );
  invalid(
    "operationStatus",
    mutated(value, (v) => {
      v.operation.actorId = "private";
    }),
  );
  invalid(
    "operationStatus",
    mutated(value, (v) => {
      v.operation.kind = "stop";
      v.operation.desiredMode = "stopped";
      v.operation.revisionSource = null;
      v.operation.lifecycleGeneration = 1;
    }),
  );
});

test("pages contain only minimal admitted operations and normalized bounded requests", () => {
  const request = {
    schemaVersion: 1,
    namespaceId: ns,
    agentId: agent,
    afterGeneration: null,
    limit: 100,
  };
  assert.equal(parse("pageRequest", request).limit, 100);
  for (const bad of [0, -1, 101, 1.5, null, "20"])
    invalid("pageRequest", { ...request, limit: bad });
  for (const bad of [undefined, 0, -0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1])
    invalid("pageRequest", { ...request, afterGeneration: bad });
  const minimal = operation();
  delete minimal.requestedRevisionId;
  assert.equal(
    parse("page", { operations: [minimal], nextAfterGeneration: 2 }).operations.length,
    1,
  );
  invalid("page", { operations: [operation()], nextAfterGeneration: 2 });
  invalid("page", { operations: [], nextAfterGeneration: 1 });
  invalid("page", { operations: [minimal], nextAfterGeneration: 1 });
});

test("capability stages and all declared consumer versions are closed inert data", () => {
  for (const stage of ["legacy", "drain", "live"])
    assert.deepEqual(plain(parse("capability", capability(stage))), capability(stage));
  for (const stage of ["drain", "live"])
    for (const key of ["api", "worker", "receiving"])
      invalid(
        "capability",
        mutated(capability(stage), (v) => {
          v.supportedConsumerVersions[key] = null;
        }),
      );
  invalid(
    "capability",
    mutated(capability("live"), (v) => {
      v.supportedConsumerVersions.maintenance = null;
    }),
  );
  for (const bad of [0, 2, "1", true])
    invalid(
      "capability",
      mutated(capability(), (v) => {
        v.supportedConsumerVersions.api = bad;
      }),
    );
  for (const patch of [
    { protocol: "v2" },
    { stage: "ready" },
    { schemaVersion: 2 },
    { capabilityVersion: 0 },
    { oldWritersExcluded: true },
    { installationId: scope().installationId },
    { release: "invented" },
  ])
    invalid("capability", { ...capability(), ...patch });
});

test("four uncertain outcomes preserve exact original identities across cancellation and expiry", () => {
  for (const kind of ["effect-unknown", "authority-unknown", "fence-unknown", "cleanup-unknown"]) {
    const value = unknown(kind);
    assert.deepEqual(plain(parse("handlerResult", value)), value);
    const early = { ...value, recordedAt: "2026-09-06T12:00:01.000Z" };
    assert.deepEqual(plain(parse("handlerResult", early)), early);
    const historical = { ...value, recordedAt: "2026-09-07T12:00:00.000Z" };
    assert.deepEqual(plain(parse("handlerResult", historical)), historical);
    for (const extra of [
      { status: "absent" },
      { completed: true },
      { cancelled: true },
      { retryMutation: true },
      { operationRef: uuid(88) },
    ])
      invalid("handlerResult", { ...value, ...extra });
    invalid("handlerResult", { ...value, kind: "not-submitted" });
    invalid("handlerResult", { ...value, reasonCode: "NONE" });
  }
});

test("provider request ceiling is distinct from finite authority fence and cleanup intervals", () => {
  invalid("handlerResult", { ...unknown(), selectedRequestDeadlineAt: "2026-09-06T12:00:10.001Z" });
  for (const kind of ["authority-unknown", "fence-unknown", "cleanup-unknown"])
    assert.equal(
      parse("handlerResult", {
        ...unknown(kind),
        selectedRequestDeadlineAt: "2026-09-06T12:01:00.000Z",
      }).kind,
      kind,
    );
  for (const kind of ["effect-unknown", "authority-unknown", "fence-unknown", "cleanup-unknown"]) {
    for (const deadline of [time, "2026-09-06T11:59:59.999Z", "infinite"])
      invalid("handlerResult", { ...unknown(kind), selectedRequestDeadlineAt: deadline });
    invalid("handlerResult", { ...unknown(kind), recordedAt: "2026-09-06T11:59:59.999Z" });
  }
});

test("uncertain identities remain scoped and future generations or same-generation fence substitutions reject", () => {
  invalid(
    "handlerResult",
    mutated(unknown(), (v) => {
      v.effect.target.agentId = `agt_${uuid(90)}`;
    }),
  );
  invalid(
    "handlerResult",
    mutated(unknown(), (v) => {
      v.effect.target.lifecycleGeneration = 3;
    }),
  );
  invalid(
    "handlerResult",
    mutated(unknown("authority-unknown"), (v) => {
      v.operation.namespaceId = `ns_${uuid(90)}`;
    }),
  );
  invalid(
    "handlerResult",
    mutated(unknown("cleanup-unknown"), (v) => {
      v.operation.scope.agentId = `agt_${uuid(90)}`;
    }),
  );
  invalid(
    "handlerResult",
    mutated(unknown("fence-unknown"), (v) => {
      v.fence.guard.intentRef = uuid(90);
    }),
  );
  const old = unknown("fence-unknown");
  old.fence.guard.lifecycleGeneration = 1;
  old.fence.guard.intentRef = uuid(90);
  assert.equal(parse("handlerResult", old).fence.guard.lifecycleGeneration, 1);
  invalid(
    "handlerResult",
    mutated(old, (v) => {
      v.fence.guard.intentRef = v.work.operationRef;
    }),
  );
  invalid(
    "handlerResult",
    mutated(old, (v) => {
      v.fence.guard.lifecycleGeneration = 3;
    }),
  );
  invalid(
    "handlerResult",
    mutated(unknown("fence-unknown"), (v) => {
      v.fence.guard.planVersion = 2;
    }),
  );
});

test("a full canonical 256-child retained fence fits without narrowing the imported contract", () => {
  const value = unknown("fence-unknown");
  value.fence.children = Array.from({ length: 256 }, (_, index) => effect(100 + index));
  value.fence.guard.admittedChildCutoff = 256;
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 65_536);
  assert.equal(parseRuntimeEffectsV1("fenceRequest", value.fence).children.length, 256);
  assert.equal(parse("handlerResult", value).fence.children.length, 256);
  invalid(
    "handlerResult",
    mutated(value, (v) => {
      v.fence.children.push(effect(999));
    }),
  );
});

test("failure handler results remain closed non-authoritative classes", () => {
  for (const kind of ["unavailable", "conflict", "rejected"]) {
    const value = { schemaVersion: 1, kind, work: work(), reasonCode: "DEPENDENCY_UNAVAILABLE" };
    assert.equal(parse("handlerResult", value).kind, kind);
    for (const extra of [
      { actualGeneration: 3 },
      { authority: true },
      { currentActor: "private" },
      { receipt: operation() },
    ])
      invalid("handlerResult", { ...value, ...extra });
  }
});

test("parsed values are deeply frozen independent copies including nested arrays", () => {
  const value = unknown("fence-unknown");
  value.fence.children = [effect()];
  const result = parse("handlerResult", value);
  for (const [, node] of objects(result)) assert.ok(Object.isFrozen(node));
  value.work.workId = "changed";
  value.fence.children[0].effectRef = uuid(99);
  assert.equal(result.work.workId, work().workId);
  assert.equal(result.fence.children[0].effectRef, uuid(8));
  assert.throws(() => {
    result.fence.children.push(effect());
  }, TypeError);
  assert.ok(Object.isFrozen(decode("status", status())));
});

test("accessors proxies prototypes symbols cycles aliases sparse arrays and invalid Unicode run no caller code", () => {
  let calls = 0;
  const accessed = status();
  Object.defineProperty(accessed, "head", {
    enumerable: true,
    get() {
      calls++;
      throw Error("secret");
    },
  });
  invalid("status", accessed);
  const proxied = new Proxy(status(), {
    ownKeys() {
      calls++;
      throw Error("secret");
    },
    getPrototypeOf() {
      calls++;
      throw Error("secret");
    },
  });
  invalid("status", proxied);
  const revoked = Proxy.revocable(status(), {});
  revoked.revoke();
  invalid("status", revoked.proxy);
  assert.equal(calls, 0);
  invalid("status", Object.assign(Object.create({ hidden: true }), status()));
  invalid("status", { ...status(), [Symbol("private")]: "secret" });
  invalid("status", {
    ...status(),
    toJSON() {
      calls++;
      return status();
    },
  });
  const cycle = status();
  cycle.loop = cycle;
  invalid("status", cycle);
  const alias = status();
  alias.conditions.routeRemoved = alias.conditions.accessDenied;
  invalid("status", alias);
  invalid("page", { operations: new Array(1), nextAfterGeneration: null });
  for (const bad of ["bad\ud800", "bad\udfff", "bad\u0000", "bad\u0085"])
    invalid(
      "handlerResult",
      mutated(unknown(), (v) => {
        v.work.workId = bad;
      }),
    );
  assert.equal(
    parse(
      "handlerResult",
      mutated(unknown(), (v) => {
        v.work.workId = "valid:😀";
      }),
    ).work.workId,
    "valid:😀",
  );
  assert.equal(calls, 0);
});

test("resource bounds and wrong parser representations fail with one sanitized error", () => {
  for (const value of [null, true, 1, "{}", new Uint8Array([123, 125]), 1n])
    invalid("status", value);
  invalid("__proto__", {});
  invalid("status", {
    ...status(),
    extra: "x".repeat(LIFECYCLE_OBSERVATION_LIMITS_V1.maxJsonBytes + 1),
  });
  const deep = {};
  let current = deep;
  for (let i = 0; i < 50; i++) {
    current.child = {};
    current = current.child;
  }
  invalid("status", deep);
  const wide = {};
  for (let i = 0; i < 257; i++) wide[`key${i}`] = 0;
  invalid("status", wide);
});

test("one retained operation locator cannot identify two lifecycle generations", () => {
  for (const phase of ["converged", "superseded"]) {
    const current = status("stopped");
    current.head.lifecycleGeneration = 3;
    current.head.operationRef = uuid(90);
    const value = {
      schemaVersion: 1,
      kind: "observed",
      work: work(),
      observation: {
        ...observation(),
        phase,
        reasonCode: phase === "converged" ? "NONE" : "SUPERSEDED",
      },
      status: current,
    };
    assert.equal(parse("handlerResult", value).status.stopComplete, false);
    invalid(
      "handlerResult",
      mutated(value, (v) => {
        v.status.head.operationRef = v.work.operationRef;
      }),
    );
    invalid(
      "handlerResult",
      mutated(value, (v) => {
        v.status.head.lifecycleGeneration = v.work.lifecycleGeneration;
      }),
    );
  }
});
