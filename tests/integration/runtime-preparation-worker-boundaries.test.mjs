import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { WorkClaimLostError } from "../../packages/occ/src/state/postgres-work-queue.ts";
import { parseRuntimeProfileWorkV1 } from "../../packages/occ/src/lifecycle/runtime-profile-work-v1.ts";
import {
  canonicalRuntimeEffectRequestV1,
  parseRuntimeEffectsV1,
} from "../../packages/contracts/src/runtime-effects-v1.ts";
import { WorkerFinalization } from "../../apps/controller/src/worker/finalization.ts";
import { RevisionReconciler } from "../../apps/controller/src/worker/revisions.ts";
import { RuntimeCleanupWorker } from "../../apps/controller/src/worker/cleanup.ts";
import { lifecycleEffectAfterClaimLoss } from "../../apps/controller/src/worker/lifecycle-effect-guard.ts";
import { KubernetesPreparedSubmission } from "../../apps/controller/src/drivers/compute/kubernetes/prepared-submission.ts";
import { PREPARED_DEPLOYMENT_ANNOTATIONS as annotations } from "../../apps/controller/src/drivers/compute/kubernetes/prepared-deployment.ts";
import {
  call,
  cleanupAuthority,
  deferred,
  gateObservation,
  setup as guardFixture,
} from "../fixtures/lifecycle-worker-guard/peers.mjs";
import {
  copy,
  createRequest,
  digest,
  hash,
  signRequest,
  stopRequest,
  unknownResult,
  uuid,
} from "../fixtures/lifecycle-worker-guard/vectors.mjs";
import { workloadProfileAdmissionFixture } from "../fixtures/workload-profile-admission-v2.mjs";

const { ObjectSerializer } = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@kubernetes/client-node/dist/gen/models/ObjectSerializer.js");

// Real reconciler, finalizer, submission bridge, wire codec and lifecycle guard.
// Explicitly controlled State, queue, original-owner and provider boundaries
// exercise ordering and refusal only. No database lease, authenticated authority,
// installed renderer, live Kubernetes, physical termination or production proof.
const testOptions = { timeout: 10_000 };
const unexpected = (name) => () => assert.fail(`Unexpected ${name}.`);

function selectedProfile(request) {
  const target = request.effect.target;
  const { head } = workloadProfileAdmissionFixture(target);
  const use = {
    schemaVersion: 2,
    installationId: target.installationId,
    namespaceId: target.namespaceId,
    component: "gateway-harness-pair",
    ...head.selection,
    canonicalFormat: head.canonicalFormat,
    profileRefs: head.profileRefs,
    admittedConfigurationDigest: request.admittedRuntime.configurationDigest,
  };
  return {
    use,
    selection: {
      schemaVersion: 2,
      installationId: target.installationId,
      namespaceId: target.namespaceId,
      agentId: target.agentId,
      revisionId: target.revisionId,
      configurationRef: `cfg_${uuid(120)}`,
      configurationVersion: 1,
      selection: head.selection,
    },
  };
}

function observeSettlement(promise) {
  const state = { settled: false };
  void promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

function selectedRevisionFixture({ ageMs = 0, attemptCount = 1, submit, defer } = {}) {
  const g = guardFixture();
  const profile = selectedProfile(g.request);
  const execution = {
    claim: {
      ...g.context.work,
      attemptCount,
      createdAt: new Date(Date.now() - ageMs),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
    signal: g.abort.signal,
  };
  const original = {
    ...g.context.original.intent,
    createdAt: execution.claim.createdAt.toISOString(),
  };
  const namespace = {
    id: original.namespaceId,
    name: "selected preparation",
    status: "ready",
    createdAt: original.createdAt,
  };
  const agent = {
    id: original.agentId,
    namespaceId: original.namespaceId,
    name: "selected preparation",
    configurationId: profile.selection.configurationRef,
    providerId: null,
    executionMode: "embedded",
    maximumExecutionMs: null,
    servicePrincipalId: "service-principal/selected-preparation",
    createdAt: original.createdAt,
  };
  const revision = {
    id: original.revisionId,
    namespaceId: namespace.id,
    agentId: agent.id,
    revision: 1,
    maximumExecutionMs: null,
    providerId: null,
    configuration: { models: { providers: { openai: {} } } },
    configurationId: agent.configurationId,
    configurationKind: "agent",
    configurationGeneration: 1,
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: "controlled-compute", implementation: "controlled-provider-boundary" },
    workloadProfileUse: profile.use,
    servicePrincipalId: agent.servicePrincipalId,
    createdAt: original.createdAt,
  };
  const admission = {
    namespaceId: original.namespaceId,
    agentId: original.agentId,
    revisionId: original.revisionId,
    runtimeTransitionRef: original.transitionRef,
    lifecycleGeneration: original.generation,
    auditEventId: g.context.original.auditEventId,
  };
  const view = {
    namespaces: { findNamespace: async () => namespace },
    agents: { findAgent: async () => agent },
    revisions: { findRevision: async () => revision },
    runtimeAdmissions: { findRevisionAdmission: async () => admission },
    runtimeAssignments: {
      findRuntimeIntent: async () => original,
      findRuntimeIntentHead: async () => original,
    },
  };
  const queueCalls = [];
  const events = [];
  const queue = Object.fromEntries(
    ["heartbeat", "complete", "retry", "fail", "enqueue"].map((name) => [
      name,
      async (...args) => {
        queueCalls.push({ name, args });
        return args[0];
      },
    ]),
  );
  queue.defer = async (...args) => {
    queueCalls.push({ name: "defer", args });
    await defer?.(...args);
  };
  let transactions = 0;
  const finalization = new WorkerFinalization({
    async transact(action) {
      transactions += 1;
      // Only scheduling should be reached: success publication and locked
      // currentness belong to other finalization paths and remain unavailable.
      return action({}, queue);
    },
    installation: () => ({ id: original.installationId }),
    readCurrentness: (action) => action(view),
    iamDriverId: "controlled-iam",
    computeDriverId: revision.compute.id,
    convergenceTimeoutMs: 60_000,
    maxAttempts: 5,
    maintenanceIntervalMs: undefined,
    cleanup: { afterActivation: unexpected("activation cleanup") },
    emit: (event) => events.push(event),
  });
  const currentUse = {
    selection: profile.selection,
    preparationRef: g.request.preparation.preparationRef,
    preparationVersion: 2,
    effectRef: g.request.effect.effectRef,
    guard: g.request.gate,
  };
  const response = {
    namespace: "selected-preparation",
    name: g.request.providerTarget.name,
    uid: "controlled-deployment-uid",
    resourceVersion: "000007/opaque",
    receivedAt: new Date().toISOString(),
  };
  const submissions = [];
  const reconciler = new RevisionReconciler({
    read: (action) => action(view),
    installation: () => ({ id: original.installationId }),
    compute: {
      ...revision.compute,
      bindAgent: unexpected("legacy binding"),
      prepareRevision: unexpected("legacy provider preparation"),
    },
    resolveApprovedHarness: () => revision.harness,
    mode: "production",
    inputs: {
      authorizeRevision: async () => undefined,
      resolveRevisionProvider: async () => undefined,
      resolveRevisionSecretContext: unexpected("legacy secret resolution"),
    },
    cleanup: {
      stage: unexpected("legacy activation"),
      reconcileActive: unexpected("legacy active reconciliation"),
    },
    finalization,
    effects: {
      runRevision: unexpected("legacy leased effect"),
      renewRevision: unexpected("legacy effect renewal"),
    },
    runtimePreparation: {
      source: {
        async currentUse(receivedExecution, receivedRevision) {
          assert.equal(receivedExecution, execution);
          assert.equal(receivedRevision, revision);
          return currentUse;
        },
        submission: {
          async submit(...args) {
            submissions.push(args);
            return submit
              ? submit(currentUse, response)
              : { status: "retained", effectRef: currentUse.effectRef, response };
          },
        },
      },
    },
  });
  return {
    execution,
    currentUse,
    reconciler,
    queueCalls,
    submissions,
    events,
    transactions: () => transactions,
  };
}

function assertDeferred(fixture, code) {
  assert.equal(fixture.submissions.length, 1);
  assert.equal(fixture.submissions[0][0], fixture.execution.claim);
  assert.equal(fixture.submissions[0][1], fixture.currentUse);
  assert.equal(fixture.submissions[0][2].signal, fixture.execution.signal);
  assert.equal(fixture.transactions(), 1);
  assert.equal(fixture.queueCalls.length, 1);
  assert.equal(fixture.queueCalls[0].name, "defer");
  assert.equal(fixture.queueCalls[0].args[0], fixture.execution.claim);
  assert.deepEqual(fixture.queueCalls[0].args[1], { code });
  assert.deepEqual(fixture.events, []);
}

for (const [description, ageMs, attemptCount] of [
  ["aged", 120_000, 1],
  ["exhausted", 0, 5],
  ["aged and exhausted", 120_000, 5],
]) {
  test(
    `selected retained response only defers ${description} revision work`,
    testOptions,
    async () => {
      const fixture = selectedRevisionFixture({ ageMs, attemptCount });
      await fixture.reconciler.reconcile(fixture.execution);
      assertDeferred(fixture, "RUNTIME_PREPARATION_RESPONSE_RETAINED");
    },
  );
}

for (const failure of ["foreign response", "submission rejection"]) {
  test(
    `selected preparation ${failure} stays unresolved without retry or provider replay`,
    testOptions,
    async () => {
      const fixture = selectedRevisionFixture({
        ageMs: 120_000,
        attemptCount: 5,
        submit(_request, response) {
          if (failure === "submission rejection") throw new Error("Controlled submission failure.");
          return { status: "retained", effectRef: uuid(121), response };
        },
      });
      await fixture.reconciler.reconcile(fixture.execution);
      assertDeferred(fixture, "RUNTIME_PREPARATION_UNRESOLVED");
    },
  );
}

test(
  "failed selected-response defer propagates the exact queue error without legacy retry",
  testOptions,
  async () => {
    const error = new Error("Controlled defer transaction failure.");
    const fixture = selectedRevisionFixture({
      ageMs: 120_000,
      attemptCount: 5,
      defer() {
        throw error;
      },
    });
    await assert.rejects(
      fixture.reconciler.reconcile(fixture.execution),
      (received) => received === error,
    );
    assertDeferred(fixture, "RUNTIME_PREPARATION_RESPONSE_RETAINED");
  },
);

function preparedSubmissionFixture(controls = {}) {
  const request = createRequest();
  const profile = selectedProfile(request);
  request.preparation.admittedProfileDigest = profile.use.manifestDigest;
  signRequest(request);
  const g = guardFixture(request);
  const namespace = "prepared-submission";
  const object = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      namespace,
      name: request.providerTarget.name,
      annotations: {
        [annotations.assignment]: request.providerTarget.ownerAssignmentRef.id,
        [annotations.create]: request.providerTarget.ownerCreateEffectRef,
        [annotations.fence]: String(request.gate.requestedFenceEpoch),
      },
    },
    spec: {
      replicas: 0,
      selector: { matchLabels: { app: "prepared-submission" } },
      template: {
        metadata: { labels: { app: "prepared-submission" } },
        spec: { containers: [{ name: "harness", image: "example.invalid/controlled" }] },
      },
    },
  };
  const wire = JSON.stringify(ObjectSerializer.serialize(object, "V1Deployment", ""));
  const canonicalRequestJson = canonicalRuntimeEffectRequestV1(request);
  const child = parseRuntimeEffectsV1("preparedChild", {
    schemaVersion: 1,
    effect: request.effect,
    guard: request.gate,
    providerTarget: request.providerTarget,
    predicate: request.predicate,
    request,
    canonicalRequestJson,
    requestBytesDigest: hash(canonicalRequestJson),
    providerWire: {
      requestRef: "retained-provider-wire",
      bytesDigest: hash(wire),
      byteLength: Buffer.byteLength(wire),
      rendererProfileRef: "controlled-renderer",
      rendererProfileDigest: digest(92),
    },
  });
  const currentUse = {
    selection: profile.selection,
    preparationRef: request.preparation.preparationRef,
    preparationVersion: 2,
    effectRef: request.effect.effectRef,
    guard: request.gate,
  };
  const committed = {
    submissionRef: uuid(122),
    submittedAt: g.state.time.toISOString(),
    claim: { idempotencyKey: g.context.work.idempotencyKey, claimToken: g.context.work.claimToken },
    request: currentUse,
    preparation: {
      status: "retained",
      preparationRef: currentUse.preparationRef,
      target: request.effect.target,
      localVersion: 2,
      retainedChildSequence: 1,
      localState: "open",
      guard: request.gate,
      plan: request.plan,
      preparation: request.preparation,
      children: [{ sequence: 1, child, providerWireUtf8: wire }],
      bindingProposals: [],
    },
    child,
    providerWireUtf8: wire,
  };
  const events = [];
  const driver = {
    capability: "compute",
    id: "controlled-compute",
    implementation: "controlled-provider-boundary",
    ensureNamespace: unexpected("namespace creation"),
    deleteNamespace: unexpected("namespace deletion"),
    prepareRevision: unexpected("legacy preparation"),
    retireRevision: unexpected("legacy retirement"),
  };
  const selection = new DriverSelection();
  selection.registerDriver(driver);
  selection.selectDriver("compute", driver.id);
  const replacement = { ...driver, id: "replacement-compute" };
  selection.registerDriver(replacement);
  const nativeResponse = {
    ...object,
    metadata: { ...object.metadata, uid: "controlled-api-uid", resourceVersion: "000008/opaque" },
  };
  const observationCall = call();
  const retained = [];
  const observed = [];
  let fixedProvider;
  let originalCall;
  let verified = false;
  const effects = g.options.effects;
  effects.create = async (input, bounded) => {
    events.push("original:create");
    originalCall = bounded;
    await fixedProvider(input, bounded);
    return unknownResult(input);
  };
  const capabilities = { acquire: unexpected("capability acquisition outside State") };
  const responseSource = { acquire: unexpected("response authority outside State") };
  const state = {
    runtimePreparationSubmissionOwnerV1(
      receivedSelection,
      participant,
      receivedSource,
      receivedCapabilities,
    ) {
      assert.equal(receivedSelection, selection);
      assert.equal(typeof receivedSource.acquire, "function");
      assert.equal(typeof receivedCapabilities.acquire, "function");
      return {
        async submit(claim, selected, bounds) {
          assert.equal(claim, committed.claim);
          assert.equal(selected, currentUse);
          assert.equal(bounds.signal, g.abort.signal);
          // Controlled post-commit participant delivery. The real bridge owns
          // its continuations; this peer does not implement SQL acceptance.
          events.push("participant:entered");
          await participant.invoke(committed, async (response, receivedCall) => {
            events.push("response:retain");
            assert.equal(receivedCall, observationCall);
            assert.equal(response, observed[0]);
            retained.push(response);
            await controls.retain?.();
            return { status: "retained", effectRef: currentUse.effectRef, response };
          });
          return retained.length
            ? { status: "retained", effectRef: currentUse.effectRef, response: retained[0] }
            : { status: "unknown", effectRef: currentUse.effectRef };
        },
      };
    },
    async withRuntimePreparationWorkerCurrentUseV1(
      receivedSelection,
      claim,
      selected,
      bounds,
      consume,
    ) {
      events.push("current-use");
      assert.equal(receivedSelection, selection);
      assert.equal(claim, committed.claim);
      assert.equal(selected, currentUse);
      assert.equal(bounds.signal, originalCall.signal);
      const lease = {
        child,
        providerWireUtf8: wire,
        assertCurrent() {},
        retain(renderer) {
          renderer.assertCurrent();
        },
      };
      return consume(lease, Object.freeze({ controlledStateOperation: true }));
    },
  };
  const originals = {
    async acquireExecution(receivedDriver, receivedCommitted, provider) {
      events.push("execution:acquire");
      assert.equal(receivedDriver, driver);
      assert.equal(receivedCommitted, committed);
      fixedProvider = provider;
      return {
        context: g.context,
        guard: g.guard,
        effects,
        assertCurrent() {},
        assertProviderEntry(input, receivedCall) {
          assert.deepEqual(input, child.request);
          assert.equal(receivedCall, originalCall);
          controls.assertProviderEntry?.({ driver, verified });
        },
        async release() {
          events.push("execution:release-entered");
          await controls.executionRelease?.();
          events.push("execution:released");
        },
      };
    },
    async acquireObservation(receivedDriver, receivedCommitted, response) {
      events.push("observation:acquire");
      assert.equal(receivedDriver, driver);
      assert.equal(receivedCommitted, committed);
      observed.push(response);
      return {
        call: observationCall,
        assertCurrent() {},
        async release() {
          events.push("observation:release-entered");
          await controls.observationRelease?.();
          events.push("observation:released");
        },
      };
    },
  };
  const bridge = new KubernetesPreparedSubmission({
    driver,
    selection,
    state,
    capabilities,
    originals,
    responseSource,
    async clients() {
      events.push("clients");
      return {
        apps: {
          async createNamespacedDeployment(input) {
            events.push("provider:create");
            assert.equal(input.namespace, namespace);
            assert.equal(JSON.stringify(input.body), wire);
            return controls.provider ? controls.provider(nativeResponse) : nativeResponse;
          },
          patchNamespacedDeployment: unexpected("materialization"),
        },
      };
    },
    async namespace(namespaceId) {
      assert.equal(namespaceId, currentUse.selection.namespaceId);
      return namespace;
    },
    async verify() {
      events.push("renderer:verify");
      verified = true;
      return { assertCurrent() {}, async prepareCommit() {}, async release() {} };
    },
    async request(operation, receivedCall) {
      assert.equal(receivedCall, originalCall);
      return operation();
    },
  });
  return {
    g,
    driver,
    selection,
    replacement,
    events,
    observed,
    retained,
    nativeResponse,
    committed,
    run: () =>
      bridge.submit(committed.claim, currentUse, { signal: g.abort.signal, timeoutMs: 3_000 }),
    lateProvider: () => fixedProvider(child.request, originalCall),
  };
}

test(
  "original provider callback cannot invalidate selected Driver facts immediately before entry",
  testOptions,
  async () => {
    const fixture = preparedSubmissionFixture({
      assertProviderEntry({ driver, verified }) {
        if (verified) driver.implementation = "changed-during-original-callback";
      },
    });
    await assert.rejects(fixture.run());
    assert.equal(fixture.events.filter((event) => event === "original:create").length, 1);
    assert.equal(fixture.events.filter((event) => event === "renderer:verify").length, 1);
    assert.equal(fixture.events.includes("provider:create"), false);
    assert.deepEqual(fixture.retained, []);
    assert.equal(fixture.events.at(-1), "execution:released");
  },
);

test(
  "submission joins late provider response and both original releases after guard claim loss",
  testOptions,
  async () => {
    const providerEntered = deferred();
    const providerResult = deferred();
    const retentionEntered = deferred();
    const retentionDone = deferred();
    const observationReleaseEntered = deferred();
    const observationReleaseDone = deferred();
    const executionReleaseEntered = deferred();
    const executionReleaseDone = deferred();
    const fixture = preparedSubmissionFixture({
      provider() {
        providerEntered.resolve();
        return providerResult.promise;
      },
      retain() {
        retentionEntered.resolve();
        return retentionDone.promise;
      },
      observationRelease() {
        observationReleaseEntered.resolve();
        return observationReleaseDone.promise;
      },
      executionRelease() {
        executionReleaseEntered.resolve();
        return executionReleaseDone.promise;
      },
    });
    const running = fixture.run();
    const settlement = observeSettlement(running);
    const rejected = assert.rejects(running, WorkClaimLostError);
    try {
      await providerEntered.promise;
      // Manual signal loss exercises cancellation propagation, not a real lost
      // database lease. The already entered provider promise remains independent.
      fixture.g.abort.abort();
      await nextTurn();
      assert.equal(settlement.settled, false);
      assert.equal(fixture.events.includes("execution:release-entered"), false);
      assert.throws(() => fixture.selection.selectDriver("compute", fixture.replacement.id));
      providerResult.resolve(fixture.nativeResponse);
      await retentionEntered.promise;
      assert.equal(settlement.settled, false);
      assert.equal(fixture.retained[0], fixture.observed[0]);
      assert.equal(fixture.retained[0].uid, fixture.nativeResponse.metadata.uid);
      assert.equal(
        fixture.retained[0].resourceVersion,
        fixture.nativeResponse.metadata.resourceVersion,
      );
      retentionDone.resolve();
      await observationReleaseEntered.promise;
      assert.equal(settlement.settled, false);
      assert.equal(fixture.events.includes("execution:release-entered"), false);
      observationReleaseDone.resolve();
      await executionReleaseEntered.promise;
      assert.equal(settlement.settled, false);
      assert.throws(() => fixture.selection.selectDriver("compute", fixture.replacement.id));
      executionReleaseDone.resolve();
      await rejected;
      assert.equal(fixture.events.filter((event) => event === "provider:create").length, 1);
      assert.ok(
        fixture.events.indexOf("observation:released") <
          fixture.events.indexOf("execution:release-entered"),
      );
      const beforeLateCall = [...fixture.events];
      await assert.rejects(fixture.lateProvider());
      assert.deepEqual(fixture.events, beforeLateCall);
      assert.equal(
        fixture.selection.selectDriver("compute", fixture.replacement.id),
        fixture.replacement,
      );
    } finally {
      providerResult.resolve(fixture.nativeResponse);
      retentionDone.resolve();
      observationReleaseDone.resolve();
      executionReleaseDone.resolve();
      await rejected;
    }
  },
);

function profileCleanupFixture({ earlyError, effectRef = uuid(140) } = {}) {
  let request = stopRequest();
  // A profile invalidation closes the current generation with a new protective
  // responsibility, no admitted children, and incremented gate/fence versions.
  // Preserve that supported closure representation when using the data vectors.
  request.gate.lifecycleGeneration = request.effect.target.lifecycleGeneration;
  request.gate.admittedChildCutoff = 0;
  request.gate.responsibility = {
    kind: "protective-fence",
    responsibilityRef: uuid(141),
    responsibilityVersion: 1,
  };
  request.effect.responsibility = request.gate.responsibility;
  request.effect.effectRef = effectRef;
  signRequest(request);
  request = parseRuntimeEffectsV1("stopRetainingState", request);
  const g = guardFixture(request);
  const authority = cleanupAuthority(request);
  const abort = new AbortController();
  const error = earlyError ?? new WorkClaimLostError();
  let authorityCalls = 0;
  let providerCalls = 0;
  g.options.assignments = {
    async resolve(input) {
      assert.deepEqual(input, authority.input);
      authorityCalls += 1;
      if (earlyError !== undefined || authorityCalls === 2) {
        abort.abort();
        throw error;
      }
      return authority.value;
    },
  };
  g.options.admission.readGate = async () => ({
    ...gateObservation(request),
    ordinaryAdmission: "closed",
  });
  g.options.effects.stopRetainingState = async (input) => {
    providerCalls += 1;
    assert.deepEqual(input, request);
    return unknownResult(input);
  };
  const closedGuard = copy(request.gate);
  const priorGuard = {
    ...copy(closedGuard),
    gateVersion: closedGuard.gateVersion - 1,
    requestedFenceEpoch: closedGuard.requestedFenceEpoch - 1,
    responsibility: {
      kind: "preparation",
      responsibilityRef: uuid(31),
      responsibilityVersion: 1,
    },
  };
  const operationRef = uuid(142);
  const work = parseRuntimeProfileWorkV1({
    schemaVersion: 3,
    handler: "ReconcileRuntimeProfileV1",
    installationId: request.effect.target.installationId,
    namespaceId: request.effect.target.namespaceId,
    agentId: request.effect.target.agentId,
    intentRef: closedGuard.intentRef,
    lifecycleGeneration: closedGuard.lifecycleGeneration,
    operationRef,
    invalidationRef: uuid(143),
    admissionRef: uuid(144),
    previousVersion: 1,
    currentVersion: 2,
    responsibilityRef: closedGuard.responsibility.responsibilityRef,
    responsibilityVersion: 1,
    requestedFenceEpoch: closedGuard.requestedFenceEpoch,
    gateVersion: closedGuard.gateVersion,
    workId: `runtime-profile:${operationRef}`,
  });
  const input = {
    kind: "profile",
    claimed: {
      work,
      claim: { idempotencyKey: work.workId, claimToken: uuid(145) },
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
    retained: {
      invalidationRef: work.invalidationRef,
      priorGuard,
      closedGuard,
      work,
      recordedAt: g.state.time.toISOString(),
    },
    signal: abort.signal,
  };
  const receivedErrors = [];
  const worker = new RuntimeCleanupWorker({
    guard: g.guard,
    source: {
      async withCleanup(receivedInput, consume) {
        assert.equal(receivedInput, input);
        try {
          await consume({
            mode: "stop-original",
            original: g.context.original,
            request,
            authority: authority.input,
            call: call(),
          });
        } catch (received) {
          receivedErrors.push(received);
          throw received;
        }
      },
    },
  });
  return {
    request,
    g,
    input,
    error,
    receivedErrors,
    run: () => worker.run(input),
    providerCalls: () => providerCalls,
    authorityCalls: () => authorityCalls,
  };
}

test(
  "cleanup preserves the actual guard receipt after authority claim loss following provider response",
  testOptions,
  async () => {
    const fixture = profileCleanupFixture();
    const result = await fixture.run();
    const receipt = lifecycleEffectAfterClaimLoss(fixture.error);
    assert.deepEqual(fixture.receivedErrors, [fixture.error]);
    assert.equal(fixture.input.signal.aborted, true);
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(receipt.kind, "unresolved");
    assert.equal(receipt.reason, "claim-lost");
    assert.deepEqual(receipt.effect, fixture.request.effect);
    assert.equal(result.kind, "unresolved");
    assert.equal(result.reason, "claim-lost");
    assert.deepEqual(result.effect, fixture.request.effect);
    assert.equal(result.observation, receipt.observation);
    assert.deepEqual(
      result.observation,
      parseRuntimeEffectsV1("effectResult", unknownResult(fixture.request)),
    );
    assert.equal(fixture.providerCalls(), 1);
    assert.equal(fixture.authorityCalls(), 2);
    assert.deepEqual(fixture.g.events, []);
  },
);

test(
  "cleanup refuses an unrecognized claim-loss error before any provider submission",
  testOptions,
  async () => {
    const error = new WorkClaimLostError();
    const fixture = profileCleanupFixture({ earlyError: error });
    const result = await fixture.run();
    assert.deepEqual(fixture.receivedErrors, [error]);
    assert.equal(lifecycleEffectAfterClaimLoss(error), undefined);
    assert.equal(result.kind, "unresolved");
    assert.equal(result.reason, "dependency-unavailable");
    assert.deepEqual(result.effect, fixture.request.effect);
    assert.equal(Object.hasOwn(result, "observation"), false);
    assert.equal(fixture.providerCalls(), 0);
    assert.equal(fixture.authorityCalls(), 1);
  },
);

test(
  "cleanup refuses a genuine retained receipt belonging to another exact effect",
  testOptions,
  async () => {
    const original = profileCleanupFixture();
    await original.run();
    const originalReceipt = lifecycleEffectAfterClaimLoss(original.error);
    assert.equal(original.providerCalls(), 1);
    assert.ok(originalReceipt.observation);
    const fixture = profileCleanupFixture({ earlyError: original.error, effectRef: uuid(146) });
    const result = await fixture.run();
    assert.deepEqual(fixture.receivedErrors, [original.error]);
    assert.equal(lifecycleEffectAfterClaimLoss(original.error), originalReceipt);
    assert.equal(result.kind, "unresolved");
    assert.equal(result.reason, "dependency-unavailable");
    assert.deepEqual(result.effect, fixture.request.effect);
    assert.notDeepEqual(result.effect, originalReceipt.effect);
    assert.equal(Object.hasOwn(result, "observation"), false);
    assert.equal(fixture.providerCalls(), 0);
    assert.equal(fixture.authorityCalls(), 1);
  },
);
