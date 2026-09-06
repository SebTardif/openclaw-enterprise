// Synthetic public data for pure projection tests, never an authorized source.
export const lifecycleFixtureIds = Object.freeze({
  namespaceId: "ns_11111111-1111-4111-8111-111111111111",
  agentId: "agt_22222222-2222-4222-8222-222222222222",
  operationRef: "33333333-3333-4333-8333-333333333333",
  laterOperationRef: "44444444-4444-4444-8444-444444444444",
  requestedRevisionId: "rev_55555555-5555-4555-8555-555555555555",
  selectedRevisionId: "rev_66666666-6666-4666-8666-666666666666",
  servingRevisionId: "rev_77777777-7777-4777-8777-777777777777",
});

export const lifecycleFixtureTimes = Object.freeze({
  acceptedAt: "2026-01-01T00:00:00.000Z",
  observedAt: "2026-01-01T00:00:01.000Z",
  recordedAt: "2026-01-01T00:10:00.000Z",
  retryAt: "2026-01-01T00:11:00.000Z",
});

export function lifecycleScopeFixture() {
  return {
    namespaceId: lifecycleFixtureIds.namespaceId,
    agentId: lifecycleFixtureIds.agentId,
  };
}

export function lifecycleConditionFixture(overrides = {}) {
  return {
    status: "unknown",
    observedAt: null,
    recordedAt: null,
    reasonCode: "NOT_OBSERVED",
    ...overrides,
  };
}

export function lifecycleObservationFixture(overrides = {}) {
  return {
    phase: "blocked",
    attempt: 2,
    step: "observe",
    reasonCode: "DEPENDENCY_UNAVAILABLE",
    retryAt: lifecycleFixtureTimes.retryAt,
    observedAt: lifecycleFixtureTimes.observedAt,
    recordedAt: lifecycleFixtureTimes.recordedAt,
    ...overrides,
  };
}

export function lifecycleOperationFixture(overrides = {}) {
  return {
    operationRef: lifecycleFixtureIds.operationRef,
    kind: "deploy",
    revisionSource: "saved-draft",
    lifecycleGeneration: 3,
    desiredMode: "running",
    acceptedAt: lifecycleFixtureTimes.acceptedAt,
    requestedRevisionId: lifecycleFixtureIds.selectedRevisionId,
    ...overrides,
  };
}

export function lifecycleMinimalOperationFixture(overrides = {}) {
  return {
    operationRef: lifecycleFixtureIds.operationRef,
    kind: "deploy",
    revisionSource: "saved-draft",
    lifecycleGeneration: 3,
    desiredMode: "running",
    acceptedAt: lifecycleFixtureTimes.acceptedAt,
    ...overrides,
  };
}

export function lifecycleStatusFixture(overrides = {}) {
  return {
    ...lifecycleScopeFixture(),
    head: {
      operationRef: lifecycleFixtureIds.laterOperationRef,
      lifecycleGeneration: 4,
      desiredMode: "running",
      requestedRevisionId: lifecycleFixtureIds.requestedRevisionId,
    },
    requestedRevisionId: lifecycleFixtureIds.requestedRevisionId,
    selectedRevisionId: lifecycleFixtureIds.selectedRevisionId,
    servingRevisionId: lifecycleFixtureIds.servingRevisionId,
    observedLifecycleGeneration: 3,
    phase: "blocked",
    attempt: 2,
    step: "observe",
    reasonCode: "PREDECESSOR_UNRESOLVED",
    retryAt: lifecycleFixtureTimes.retryAt,
    conditions: {
      accessDenied: lifecycleConditionFixture(),
      routeRemoved: lifecycleConditionFixture(),
      executionTerminated: lifecycleConditionFixture(),
      credentialRevocation: lifecycleConditionFixture({
        status: "not-requested",
        reasonCode: "NOT_REQUESTED",
      }),
      stateRetention: lifecycleConditionFixture(),
    },
    serving: false,
    stopComplete: false,
    retention: "unknown",
    ...overrides,
  };
}

export function lifecyclePageRequestFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    ...lifecycleScopeFixture(),
    afterGeneration: null,
    limit: 10,
    ...overrides,
  };
}

export function lifecycleCapabilityFixture(stage = "live") {
  return {
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
  };
}

function readCase(label, method, request, value) {
  return { label, method, request, result: { kind: "read", value } };
}

function confirmedCondition() {
  return lifecycleConditionFixture({
    status: "confirmed",
    observedAt: lifecycleFixtureTimes.observedAt,
    recordedAt: lifecycleFixtureTimes.recordedAt,
    reasonCode: "NONE",
  });
}

/** Every invocation returns fresh mutable inputs for the real pure projector. */
export function lifecycleStatusReadCases() {
  const noHead = lifecycleStatusFixture({
    head: null,
    requestedRevisionId: null,
    selectedRevisionId: null,
    servingRevisionId: null,
    observedLifecycleGeneration: null,
    phase: "pending",
    attempt: 0,
    reasonCode: "LIFECYCLE_UNINITIALIZED",
    retryAt: null,
  });
  const protective = lifecycleStatusFixture({
    head: {
      operationRef: lifecycleFixtureIds.laterOperationRef,
      lifecycleGeneration: 1,
      desiredMode: "stopped",
      requestedRevisionId: null,
    },
    requestedRevisionId: null,
    selectedRevisionId: null,
    servingRevisionId: null,
    observedLifecycleGeneration: null,
    phase: "pending",
    attempt: 0,
    reasonCode: "NOT_OBSERVED",
    retryAt: null,
  });
  const denied = lifecycleStatusFixture();
  denied.head.desiredMode = "stopped";
  denied.observedLifecycleGeneration = 4;
  denied.step = "terminate-predecessor";
  denied.reasonCode = "TERMINATION_UNKNOWN";
  denied.conditions.accessDenied = confirmedCondition();
  denied.conditions.accessDenied.observedAt = null;
  denied.conditions.routeRemoved = confirmedCondition();
  denied.conditions.executionTerminated = lifecycleConditionFixture({
    recordedAt: lifecycleFixtureTimes.recordedAt,
    reasonCode: "TERMINATION_UNKNOWN",
  });
  denied.conditions.credentialRevocation = lifecycleConditionFixture({
    recordedAt: lifecycleFixtureTimes.recordedAt,
    reasonCode: "CREDENTIAL_OUTCOME_UNKNOWN",
  });
  const unresolved = structuredClone(denied);
  unresolved.reasonCode = "CREATE_OUTCOME_UNKNOWN";
  unresolved.conditions.executionTerminated.reasonCode = "CREATE_OUTCOME_UNKNOWN";
  const complete = structuredClone(denied);
  complete.phase = "converged";
  complete.reasonCode = "NONE";
  complete.retryAt = null;
  complete.stopComplete = true;
  complete.conditions.executionTerminated = confirmedCondition();
  // Correlated public data only: this does not supply exhaustive runtime proof.
  complete.conditions.stateRetention = lifecycleConditionFixture({
    status: "pending",
    recordedAt: lifecycleFixtureTimes.recordedAt,
    reasonCode: "STATE_UNAVAILABLE",
  });
  complete.retention = "verification-pending";
  const retained = structuredClone(denied);
  retained.conditions.stateRetention = confirmedCondition();
  retained.retention = "retained";
  const stale = lifecycleStatusFixture();
  stale.conditions.routeRemoved = lifecycleConditionFixture({
    status: "pending",
    observedAt: lifecycleFixtureTimes.observedAt,
    recordedAt: lifecycleFixtureTimes.recordedAt,
    reasonCode: "ROUTE_OUTCOME_UNKNOWN",
  });
  const historical = {
    operation: lifecycleOperationFixture(),
    observation: lifecycleObservationFixture({
      phase: "converged",
      reasonCode: "NONE",
      retryAt: null,
      step: "publish",
    }),
  };
  const operationRequest = {
    schemaVersion: 1,
    ...lifecycleScopeFixture(),
    operationRef: lifecycleFixtureIds.operationRef,
  };
  const laterOperation = lifecycleMinimalOperationFixture({
    operationRef: lifecycleFixtureIds.laterOperationRef,
    lifecycleGeneration: 4,
    acceptedAt: "2026-01-01T00:05:00.000Z",
  });
  return [
    readCase("no-head", "readStatus", lifecycleScopeFixture(), noHead),
    readCase("initial-protective-null-revision", "readStatus", lifecycleScopeFixture(), protective),
    readCase(
      "distinct-requested-selected-serving",
      "readStatus",
      lifecycleScopeFixture(),
      lifecycleStatusFixture(),
    ),
    readCase("stale-source-later-receipt", "readStatus", lifecycleScopeFixture(), stale),
    readCase("access-denied-termination-unknown", "readStatus", lifecycleScopeFixture(), denied),
    readCase("unresolved-possible-create", "readStatus", lifecycleScopeFixture(), unresolved),
    readCase("stop-complete-credential-unknown", "readStatus", lifecycleScopeFixture(), complete),
    readCase("retained-state-termination-unknown", "readStatus", lifecycleScopeFixture(), retained),
    readCase(
      "historical-accepted-operation-after-later-head",
      "readOperation",
      operationRequest,
      historical,
    ),
    readCase(
      "operation-with-stale-observation",
      "readOperation",
      structuredClone(operationRequest),
      {
        operation: lifecycleOperationFixture(),
        observation: lifecycleObservationFixture(),
      },
    ),
    readCase(
      "bounded-partial-page-with-cursor",
      "listOperations",
      lifecyclePageRequestFixture({ afterGeneration: 2 }),
      {
        operations: [lifecycleMinimalOperationFixture()],
        nextAfterGeneration: 3,
      },
    ),
    readCase(
      "ambiguous-discovery-without-accepted-locator",
      "listOperations",
      lifecyclePageRequestFixture(),
      {
        operations: [lifecycleMinimalOperationFixture(), laterOperation],
        nextAfterGeneration: null,
      },
    ),
    readCase(
      "empty-discovery-does-not-prove-rollback",
      "listOperations",
      lifecyclePageRequestFixture({ afterGeneration: 4 }),
      {
        operations: [],
        nextAfterGeneration: null,
      },
    ),
    ...["legacy", "drain", "live"].map((stage) =>
      readCase(
        `capability-${stage}`,
        "readCapability",
        lifecycleScopeFixture(),
        lifecycleCapabilityFixture(stage),
      ),
    ),
    {
      label: "not-found",
      method: "readStatus",
      request: lifecycleScopeFixture(),
      result: { kind: "rejected", code: "NOT_FOUND" },
    },
    {
      label: "unavailable",
      method: "readStatus",
      request: lifecycleScopeFixture(),
      result: { kind: "unavailable" },
    },
  ];
}

export function lifecyclePortableFixtures() {
  return {
    format: "lifecycle-status-fixtures-v1",
    description: "Synthetic canonical test values; grouping metadata is not an API response.",
    mutationResults: [
      {
        label: "accepted-minimal",
        value: {
          kind: "accepted",
          receipt: { disposition: "accepted", operation: lifecycleMinimalOperationFixture() },
        },
      },
      {
        label: "unchanged-minimal",
        value: {
          kind: "unchanged",
          receipt: { disposition: "unchanged", lifecycleGeneration: 4, desiredMode: "stopped" },
        },
      },
      { label: "conflict", value: { kind: "conflict" } },
      { label: "commit-unknown", value: { kind: "commit-unknown" } },
    ],
    readCases: lifecycleStatusReadCases(),
    historicalContext: {
      historicalCase: "historical-accepted-operation-after-later-head",
      laterStatusCase: "distinct-requested-selected-serving",
      meaning:
        "The exact historical operation remains readable; it does not establish the later head's outcome.",
    },
    discoveryContext: {
      case: "ambiguous-discovery-without-accepted-locator",
      acceptedOperationRef: null,
      meaning:
        "Multiple accepted operations do not identify a lost mutation response. Do not choose a row or retry a mutation automatically.",
    },
  };
}

/** Private extras exercise omission, including values that cannot be traversed.
 * Expected public output is independently retained before adding descriptors.
 */
export function richLifecycleStatusReadCase(method = "readStatus") {
  const selected = lifecycleStatusReadCases().find(
    (entry) => entry.method === method && entry.result.kind === "read",
  );
  if (!selected) throw new Error("Unknown fixture method.");
  const request = structuredClone(selected.request);
  const result = structuredClone(selected.result);
  const expected = structuredClone(selected.result);
  let reads = 0;
  const privateReads = () => reads;
  const cycle = {};
  cycle.self = cycle;
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        reads++;
        throw new Error("synthetic private trap");
      },
      getPrototypeOf() {
        reads++;
        throw new Error("synthetic private trap");
      },
      getOwnPropertyDescriptor() {
        reads++;
        throw new Error("synthetic private trap");
      },
      get() {
        reads++;
        throw new Error("synthetic private trap");
      },
    },
  );
  const enrich = (value) => {
    if (value === null || typeof value !== "object") return;
    for (const child of Object.values(value)) enrich(child);
    if (Array.isArray(value)) return;
    Object.assign(value, {
      actorId: "synthetic-private-actor",
      accountId: "synthetic-private-account",
      auditEventId: "synthetic-private-audit",
      conversation: cycle,
      credential: hostile,
      localPath: "/synthetic/private/value",
      backendError: "synthetic-private-error",
    });
    Object.defineProperty(value, "privateDetail", {
      enumerable: true,
      get() {
        reads++;
        throw new Error("synthetic private accessor");
      },
    });
    Object.defineProperty(value, "toJSON", {
      enumerable: false,
      get() {
        reads++;
        throw new Error("synthetic private serialization");
      },
    });
  };
  enrich(result);
  return { request, result, expected, privateReads };
}
