import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  canonicalRuntimeEffectRequestV1,
  parseRuntimeEffectsV1,
} from "../../packages/contracts/src/runtime-effects-v1.ts";
import { createRequest, hash, preparedChild } from "../fixtures/runtime-effects-v1/vectors.mjs";
import { setup as guardSetup } from "../fixtures/lifecycle-worker-guard/peers.mjs";
import { unknownResult } from "../fixtures/lifecycle-worker-guard/vectors.mjs";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { PREPARED_DEPLOYMENT_ANNOTATIONS as keys } from "../../apps/controller/src/drivers/compute/kubernetes/prepared-deployment.ts";
const { ObjectSerializer } = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@kubernetes/client-node/dist/gen/models/ObjectSerializer.js");
const { options: lifecycleOptions } = JSON.parse(
  readFileSync(
    new URL("../fixtures/kubernetes-lifecycle-collaborators/inputs.json", import.meta.url),
    "utf8",
  ),
);

// This file composes the original Driver -> Hume submission -> actual guard ->
// fixed provider -> prepared submit. Only component-owned State, accepting
// invocation, renderer operand and SDK/observation peers are controlled fixtures.
// No actual State issuer, durable writer permission or live runtime is asserted.
function fixture(action = "reserve-inert") {
  const request = createRequest(action),
    child = preparedChild(),
    namespace = "prepared-test";
  if (action === "materialize") {
    request.predicate.fenceEpoch = request.gate.requestedFenceEpoch;
    request.effect.requestDigest = hash(canonicalRuntimeEffectRequestV1(request));
  }
  Object.assign(child, {
    request,
    effect: request.effect,
    guard: request.gate,
    providerTarget: request.providerTarget,
    predicate: request.predicate,
    canonicalRequestJson: canonicalRuntimeEffectRequestV1(request),
  });
  child.requestBytesDigest = hash(child.canonicalRequestJson);
  const annotations = {
    [keys.assignment]: request.providerTarget.ownerAssignmentRef.id,
    [keys.create]: request.providerTarget.ownerCreateEffectRef,
    [keys.fence]: String(request.gate.requestedFenceEpoch),
  };
  const spec = {
    replicas: action === "reserve-inert" ? 0 : 1,
    selector: { matchLabels: { app: "prepared" } },
    template: {
      metadata: { labels: { app: "prepared" } },
      spec: { containers: [{ name: "harness", image: "example.invalid/fixture" }] },
    },
  };
  const object = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { namespace, name: request.providerTarget.name, annotations },
    spec,
  };
  const pointer = (name) => `/metadata/annotations/${name.replaceAll("/", "~1")}`;
  const body =
    action === "reserve-inert"
      ? object
      : [
          { op: "test", path: "/metadata/uid", value: request.predicate.uid },
          {
            op: "test",
            path: "/metadata/resourceVersion",
            value: request.predicate.resourceVersion,
          },
          {
            op: "test",
            path: pointer(keys.assignment),
            value: request.predicate.ownerAssignmentRef.id,
          },
          { op: "test", path: pointer(keys.create), value: request.predicate.ownerCreateEffectRef },
          { op: "test", path: pointer(keys.fence), value: String(request.predicate.fenceEpoch) },
          { op: "replace", path: "/spec", value: spec },
        ];
  const bind = (value) => {
    const wire = JSON.stringify(
      action === "reserve-inert" ? ObjectSerializer.serialize(value, "V1Deployment", "") : value,
    );
    child.providerWire.bytesDigest = hash(wire);
    child.providerWire.byteLength = Buffer.byteLength(wire);
    return wire;
  };
  return { child, namespace, object, body, bind, wire: bind(body) };
}

function barrier() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
function completion(promise) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}
// Component-only owner. Its private sentinel and hold membership test the
// consumer contract; neither is authenticated production invocation/SQL proof.
function encoding(f, options = {}) {
  const child = parseRuntimeEffectsV1("preparedChild", f.child);
  const target = child.effect.target;
  const invocation = Object.freeze({ componentFixture: true });
  const selection = Object.freeze({
    installationId: target.installationId,
    namespaceId: target.namespaceId,
    agentId: target.agentId,
    clusterRef: child.providerTarget.clusterRef,
    kubernetesNamespaceUid: child.providerTarget.kubernetesNamespaceUid,
    namespace: f.namespace,
    name: child.providerTarget.name,
  });
  const committed = {
    submissionRef: "00000000-0000-4000-8000-000000000901",
    submittedAt: "2026-01-01T00:00:01.000Z",
    claim: { idempotencyKey: "component-only", claimToken: "00000000-0000-4000-8000-000000000902" },
    request: {
      selection: {
        schemaVersion: 2,
        installationId: target.installationId,
        namespaceId: target.namespaceId,
        agentId: target.agentId,
        revisionId: target.revisionId,
        configurationRef: "00000000-0000-4000-8000-000000000904",
        configurationVersion: 1,
        selection: {
          manifestRef: "00000000-0000-4000-8000-000000000905",
          manifestDigest: hash("component manifest"),
          admissionRef: "00000000-0000-4000-8000-000000000906",
          admissionVersion: 1,
        },
      },
      preparationRef: child.request.preparation.preparationRef,
      preparationVersion: child.request.preparation.preparationVersion,
      effectRef: child.effect.effectRef,
      guard: child.guard,
    },
    preparation: Object.freeze({
      status: "retained",
      preparationRef: child.request.preparation.preparationRef,
      target: child.effect.target,
      localVersion: child.request.preparation.preparationVersion,
      retainedChildSequence: 1,
      localState: "open",
      guard: child.guard,
      plan: child.request.plan,
      preparation: child.request.preparation,
      children: [{ sequence: 1, child, providerWireUtf8: f.wire }],
      bindingProposals: [],
    }),
    child,
    providerWireUtf8: f.wire,
  };
  const possible = {
    schemaVersion: 1,
    kind: "possible-effect",
    operationRef: "00000000-0000-4000-8000-000000000903",
    submissionRef: committed.submissionRef,
    selection,
    childEffectRef: child.effect.effectRef,
    assignmentRef: child.providerTarget.ownerAssignmentRef.id,
    createEffectRef: child.providerTarget.ownerCreateEffectRef,
    expectedUid: child.predicate.kind === "expected-object" ? child.predicate.uid : null,
    expectedResourceVersion:
      child.predicate.kind === "expected-object" ? child.predicate.resourceVersion : null,
    requestedFenceEpoch: child.guard.requestedFenceEpoch,
    requestDigest: child.requestBytesDigest,
    providerWireDigest: child.providerWire.bytesDigest,
  };
  options.mutatePossible?.(possible);
  const counts = {
    begin: 0,
    beginGets: 0,
    retainGets: 0,
    current: 0,
    releaseGets: 0,
    release: 0,
    retain: 0,
  };
  const events = [],
    outcomes = [],
    inputs = [];
  const retainedPossibilities = new Set();
  const entered = barrier(),
    releaseEntered = barrier();
  let closed = false;
  const release = async function () {
    assert.equal(this, hold);
    counts.release++;
    closed = true;
    events.push("release");
    releaseEntered.resolve();
    await options.onRelease?.();
  };
  const hold = Object.defineProperties(
    {},
    {
      release: {
        get() {
          counts.releaseGets++;
          events.push("release-get");
          return release;
        },
      },
      assertCurrent: {
        value: function () {
          assert.equal(this, hold);
          counts.current++;
          events.push("current");
          if (closed) throw new Error("component hold closed");
          return options.onCurrent?.();
        },
      },
      possibleEffect: {
        get() {
          events.push("possible-get");
          if (options.possibleError) throw options.possibleError;
          return possible;
        },
      },
    },
  );
  const begin = async function (original, offered) {
    assert.equal(this, holding);
    counts.begin++;
    inputs.push([original, offered]);
    events.push("begin");
    entered.resolve();
    if (original !== invocation) throw new Error("unrecognized component invocation");
    retainedPossibilities.add(possible);
    events.push("possible-retained");
    await options.onBegin?.();
    return hold;
  };
  const retain = async function (original, outcome) {
    assert.equal(this, holding);
    counts.retain++;
    events.push("retain");
    outcomes.push(outcome);
    if (original !== hold) throw new Error("unrecognized component hold");
    await options.onRetain?.(outcome);
  };
  const holding = Object.defineProperties(
    {},
    {
      beginMutation: {
        configurable: true,
        get() {
          counts.beginGets++;
          return begin;
        },
      },
      retainOutcome: {
        configurable: true,
        get() {
          counts.retainGets++;
          return retain;
        },
      },
    },
  );
  return {
    input: {
      originalInvocation: invocation,
      holding,
      target: { committed, selection, child, providerWireUtf8: f.wire },
    },
    invocation,
    holding,
    hold,
    committed,
    selection,
    possible,
    counts,
    events,
    outcomes,
    inputs,
    entered,
    releaseEntered,
    unresolved: () => retainedPossibilities.has(possible),
  };
}
function apiResponse(f) {
  return {
    ...f.object,
    metadata: {
      ...f.object.metadata,
      uid:
        f.child.predicate.kind === "expected-object"
          ? f.child.predicate.uid
          : "actual-component-uid",
      resourceVersion: "actual-component-rv",
    },
  };
}

// All State/accepting-owner/observation peers below are component contracts with
// privately retained object identities. They model no authenticated production
// owner, SQL COMMIT, native exchange, writer exclusion or provider provenance.
function composed(t, control = {}) {
  const f = fixture();
  let peer;
  const owner = encoding(f, {
    ...control.holding,
    onCurrent() {
      if (peer.abort.signal.aborted) throw new Error("component owning invocation canceled");
      return control.holding?.onCurrent?.();
    },
  });
  peer = guardSetup(f.child.request);
  owner.committed.claim = peer.context.work;
  peer.context.call.deadline = new Date(Date.now() + 60_000).toISOString();
  const counts = {
    factory: 0,
    marker: 0,
    execution: 0,
    invocation: 0,
    sdk: 0,
    observation: 0,
    response: 0,
    responseSource: 0,
    executionRelease: 0,
    executionReleaseAttempts: 0,
    observationRelease: 0,
    rendererRelease: 0,
    verify: 0,
    currentUse: 0,
    unused: 0,
  };
  const events = [],
    sdkEntered = barrier(),
    observationEntered = barrier();
  let sqlOpen = false,
    executionOpen = false,
    observedResponse,
    originalCall;
  let responseTransactionOpen = false;
  const freshCall = Object.freeze({
    context: Object.freeze({ componentObservation: true }),
    requestRef: "fresh-component-response",
    recipientRef: "component-state",
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  });
  const namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: f.namespace,
      uid: owner.selection.kubernetesNamespaceUid,
      labels: {
        "openclaw.dev/namespace": owner.selection.namespaceId,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: {
        "openclaw.dev/namespace-id": owner.selection.namespaceId,
        "openclaw.dev/namespace-lifecycle": "external",
      },
    },
    status: { phase: "Active" },
  };
  control.namespace?.(namespace);
  const apps = {
    async createNamespacedDeployment(input) {
      assert.equal(this, apps);
      counts.sdk++;
      events.push("sdk");
      sdkEntered.resolve();
      assert.equal(sqlOpen, false);
      assert.equal(executionOpen, true);
      assert.equal(owner.counts.begin, 1);
      assert.ok(owner.counts.current > 0);
      assert.equal(input.namespace, f.namespace);
      assert.equal(
        JSON.stringify(ObjectSerializer.serialize(input.body, "V1Deployment", "")),
        f.wire,
      );
      return control.sdk ? await control.sdk() : apiResponse(f);
    },
    async patchNamespacedDeployment() {
      counts.unused++;
      throw new Error("unexpected patch");
    },
  };
  const core = {
    async listNamespace() {
      return { items: [namespace] };
    },
    async readNamespace(input) {
      assert.equal(input.name, f.namespace);
      await control.namespaceRead?.();
      return namespace;
    },
  };
  const driver = new KubernetesComputeDriver(lifecycleOptions, {
    runtimeObservationDependencies: { clusterRef: owner.selection.clusterRef },
  });
  // Only API and renderer-operand peers are doubled. The selected Driver,
  // namespace resolver/ownership checks, dispatcher, guard, fixed provider and
  // conditional submit implementations are the actual production components.
  t.mock.method(driver, "clients", async () => ({ apps, core }));
  t.mock.method(driver, "verifyPreparedDeployment", async (lease) => {
    counts.verify++;
    assert.equal(sqlOpen, true);
    assert.equal(lease.child, owner.committed.child);
    await control.verify?.();
    let live = true;
    return {
      assertCurrent() {
        if (!live || !sqlOpen) throw new Error("expired renderer fixture");
      },
      async release() {
        live = false;
        counts.rendererRelease++;
      },
    };
  });
  const selection = new DriverSelection();
  selection.registerDriver(driver);
  selection.selectDriver("compute", driver.id);
  const unusedEffect = async () => {
    counts.unused++;
    throw new Error("unexpected non-create effect");
  };
  const effects = {
    create: undefined,
    readEffect: unusedEffect,
    setRoute: unusedEffect,
    stopRetainingState: unusedEffect,
    advanceFence: unusedEffect,
    readFence: unusedEffect,
    discover: unusedEffect,
    observe: unusedEffect,
  };
  peer.options.effects = effects;
  const responseSource = {
    async acquire(context, committed, response, call) {
      counts.responseSource++;
      assert.equal(this, responseSource);
      assert.equal(committed, owner.committed);
      assert.equal(response, observedResponse);
      assert.equal(call, freshCall);
      context.assertActive();
      return {
        assertCurrent() {
          context.assertActive();
        },
        async prepareCommit() {
          context.assertActive();
        },
        async release() {},
      };
    },
  };
  const state = {
    runtimePreparationSubmissionOwnerV1(selected, participant, source, capabilities) {
      assert.equal(this, state);
      counts.factory++;
      assert.equal(selected, selection);
      assert.equal(typeof capabilities.acquire, "function");
      return {
        async submit(claim, request) {
          assert.equal(claim, peer.context.work);
          assert.equal(request, owner.committed.request);
          if (control.markerUnavailable) return { status: "unknown", effectRef: request.effectRef };
          counts.marker++;
          events.push("component-definite-marker");
          let retained;
          await participant.invoke(owner.committed, async (response, call) => {
            counts.response++;
            assert.equal(response, observedResponse);
            assert.equal(call, freshCall);
            assert.notEqual(call, originalCall);
            assert.equal(call.signal.aborted, false);
            events.push("independent-response");
            responseTransactionOpen = true;
            const context = {
              installationId: owner.selection.installationId,
              query: async () => {
                counts.unused++;
                throw new Error("unexpected SQL");
              },
              assertActive() {
                if (!responseTransactionOpen) throw new Error("response transaction closed");
              },
              retain() {
                counts.unused++;
                throw new Error("unused retention callback");
              },
            };
            let held;
            try {
              held = await source.acquire(context, owner.committed, response, call);
              held.assertCurrent();
              await control.retainResponse?.();
              await held.prepareCommit();
              held.assertCurrent();
              retained = { status: "retained", effectRef: request.effectRef, response };
              return retained;
            } finally {
              if (held) await held.release();
              responseTransactionOpen = false;
            }
          });
          return retained ?? { status: "unknown", effectRef: request.effectRef };
        },
      };
    },
    async withRuntimePreparationWorkerCurrentUseV1(selected, claim, request, bounds, consume) {
      assert.equal(this, state);
      counts.currentUse++;
      assert.equal(selected, selection);
      assert.equal(claim, peer.context.work);
      assert.equal(request, owner.committed.request);
      const retained = [];
      const lease = {
        request,
        preparation: owner.committed.preparation,
        child: owner.committed.child,
        providerWireUtf8: f.wire,
        assertCurrent() {
          if (!sqlOpen) throw new Error("expired component current use");
        },
        retain(item) {
          this.assertCurrent();
          retained.push(item);
        },
        async release() {},
      };
      sqlOpen = true;
      events.push("current-use-open");
      try {
        return await consume(lease, Object.freeze({ componentIO: true }));
      } finally {
        for (const item of retained) await item.release();
        sqlOpen = false;
        events.push("current-use-closed");
      }
    },
  };
  const originals = {
    async acquireExecution(selected, committed, fixedProvider) {
      assert.equal(this, originals);
      counts.execution++;
      assert.equal(selected, driver);
      assert.equal(committed, owner.committed);
      assert.equal(counts.marker, 1);
      assert.equal(sqlOpen, false);
      executionOpen = true;
      events.push("execution");
      effects.create = async function (request, call) {
        assert.equal(this, effects);
        originalCall = call;
        try {
          await fixedProvider(request, call);
        } finally {
          await control.afterCreate?.(fixedProvider, request, call);
        }
        return unknownResult(request);
      };
      const lease = {
        context: peer.context,
        effects,
        guard: peer.guard,
        assertCurrent() {
          assert.equal(this, lease);
          if (!executionOpen || peer.abort.signal.aborted) throw new Error("old worker expired");
        },
        assertProviderEntry(request, call) {
          assert.equal(this, lease);
          assert.equal(call, originalCall);
          assert.deepEqual(request, owner.committed.child.request);
          if (!executionOpen || peer.abort.signal.aborted) throw new Error("old provider expired");
          control.providerCurrent?.(driver);
        },
        retainProviderInvocation(request, call) {
          assert.equal(this, lease);
          counts.invocation++;
          assert.equal(call, originalCall);
          assert.deepEqual(request, owner.committed.child.request);
          if (!executionOpen || peer.abort.signal.aborted) throw new Error("invocation expired");
          return control.invocation ? control.invocation(owner.invocation) : owner.invocation;
        },
        async release() {
          assert.equal(this, lease);
          counts.executionReleaseAttempts++;
          await control.executionRelease?.();
          executionOpen = false;
          counts.executionRelease++;
          events.push("execution-release");
        },
      };
      if (control.executionGetterError)
        Object.defineProperty(lease, "assertCurrent", {
          get() {
            throw control.executionGetterError;
          },
        });
      return lease;
    },
    async acquireObservation(selected, committed, response) {
      assert.equal(this, originals);
      counts.observation++;
      assert.equal(selected, driver);
      assert.equal(committed, owner.committed);
      assert.equal(response, owner.outcomes[0].response);
      observedResponse = response;
      observationEntered.resolve();
      await control.observation?.();
      let live = true;
      const lease = {
        call: freshCall,
        assertCurrent() {
          assert.equal(this, lease);
          if (!live) throw new Error("observation closed");
        },
        async release() {
          assert.equal(this, lease);
          await control.observationRelease?.();
          live = false;
          counts.observationRelease++;
          events.push("observation-release");
        },
      };
      return lease;
    },
  };
  const submission = driver.createRuntimePreparationSubmission({
    selection,
    state,
    encodingHolding: owner.holding,
    capabilities: {
      async acquire() {
        counts.unused++;
        throw new Error("unexpected capability acquisition");
      },
    },
    originals: control.missingOriginal ? undefined : originals,
    responseSource,
  });
  return {
    f,
    owner,
    peer,
    driver,
    selection,
    effects,
    counts,
    events,
    sdkEntered,
    observationEntered,
    start: () =>
      submission.submit(peer.context.work, owner.committed.request, {
        signal: peer.abort.signal,
        timeoutMs: 3_000,
      }),
    get originalCall() {
      return originalCall;
    },
    freshCall,
  };
}

test("original selected Driver and real guard reach holding only after current-use release", async (t) => {
  const s = composed(t);
  const result = await s.start();
  assert.equal(result.status, "retained");
  assert.equal(result.response, s.owner.outcomes[0].response);
  assert.equal(s.counts.marker, 1);
  assert.equal(s.counts.execution, 1);
  assert.equal(s.counts.currentUse, 1);
  assert.equal(s.counts.verify, 1);
  assert.equal(s.counts.rendererRelease, 1);
  assert.equal(s.counts.invocation, 1);
  assert.equal(s.counts.sdk, 1);
  assert.equal(s.owner.inputs[0][0], s.owner.invocation);
  assert.equal(s.owner.inputs[0][1].committed, s.owner.committed);
  assert.deepEqual(s.owner.inputs[0][1].selection, s.owner.selection);
  assert.equal(s.counts.response, 1);
  assert.equal(s.counts.responseSource, 1);
  assert.equal(s.counts.observationRelease, 1);
  assert.equal(s.counts.executionRelease, 1);
  assert.equal(s.counts.unused, 0);
  assert.deepEqual(Object.keys(s.effects).sort(), [
    "advanceFence",
    "create",
    "discover",
    "observe",
    "readEffect",
    "readFence",
    "setRoute",
    "stopRetainingState",
  ]);
  assert.ok(s.events.indexOf("current-use-closed") < s.events.indexOf("sdk"));
  assert.ok(s.events.indexOf("observation-release") < s.events.indexOf("execution-release"));
});

test("missing original owner and preexisting-marker contract never enter a provider", async (t) => {
  for (const missingOriginal of [true, false]) {
    const s = composed(t, { missingOriginal, markerUnavailable: !missingOriginal });
    const result = await s.start();
    assert.equal(result.status, missingOriginal ? "unavailable" : "unknown");
    assert.equal(s.counts.factory, missingOriginal ? 0 : 1);
    assert.equal(s.counts.execution, 0);
    assert.equal(s.counts.invocation, 0);
    assert.equal(s.owner.counts.begin, 0);
    assert.equal(s.counts.sdk, 0);
    assert.equal(s.counts.unused, 0);
  }
});

test("physical namespace selection refuses missing UID, foreign ownership and deletion before holding", async (t) => {
  for (const mutate of [
    (namespace) => {
      delete namespace.metadata.uid;
    },
    (namespace) => {
      namespace.metadata.annotations["openclaw.dev/namespace-id"] = "foreign";
    },
    (namespace) => {
      namespace.metadata.deletionTimestamp = "2026-01-01T00:00:02.000Z";
    },
    (namespace) => {
      namespace.apiVersion = "wrong/v1";
    },
  ]) {
    const s = composed(t, { namespace: mutate });
    await assert.rejects(s.start());
    assert.equal(s.owner.counts.begin, 0);
    assert.equal(s.counts.sdk, 0);
    assert.equal(s.counts.invocation, 0);
    assert.equal(s.counts.executionRelease, 1);
  }
});

test("constructor captures the exact holding methods before later getter replacement", async (t) => {
  const s = composed(t);
  assert.equal(s.owner.counts.beginGets, 1);
  assert.equal(s.owner.counts.retainGets, 1);
  let replacedReads = 0;
  for (const key of ["beginMutation", "retainOutcome"])
    Object.defineProperty(s.owner.holding, key, {
      get() {
        replacedReads++;
        throw new Error("replaced original method read");
      },
    });
  await s.start();
  assert.equal(replacedReads, 0);
  // The prepared consumer reads the captured wrapper; no second read of original
  // holding getters is permitted, even across asynchronous current-use work.
  assert.equal(s.owner.counts.beginGets, 1);
  assert.equal(s.owner.counts.retainGets, 1);
  assert.equal(s.owner.counts.begin, 1);
  assert.equal(s.owner.counts.retain, 1);
});

test("a copied accepting invocation is rejected by holding after original current-use ends", async (t) => {
  const s = composed(t, { invocation: (original) => ({ ...original }) });
  await assert.rejects(s.start());
  assert.equal(s.counts.invocation, 1);
  assert.equal(s.owner.counts.begin, 1);
  assert.equal(s.owner.counts.release, 0);
  assert.equal(s.counts.sdk, 0);
  assert.equal(s.counts.executionRelease, 1);
});

test("original execution cleanup is captured before a throwing currentness getter", async (t) => {
  const failure = new Error("execution getter failed");
  const s = composed(t, { executionGetterError: failure });
  await assert.rejects(s.start(), (error) => error === failure);
  assert.equal(s.counts.executionRelease, 1);
  assert.equal(s.counts.currentUse, 0);
  assert.equal(s.counts.sdk, 0);
});

test(
  "a deferred invocation supplier is refused and joined before execution cleanup",
  { timeout: 5_000 },
  async (t) => {
    const entered = barrier(),
      pending = barrier();
    const s = composed(t, {
      invocation() {
        entered.resolve();
        return pending.promise;
      },
    });
    const running = s.start(),
      settled = completion(running),
      refused = assert.rejects(running);
    t.after(async () => {
      pending.resolve(s.owner.invocation);
      await refused;
    });
    await entered.promise;
    await nextTurn();
    assert.equal(settled(), false);
    assert.equal(s.counts.sdk, 0);
    assert.equal(s.owner.counts.begin, 0);
    assert.equal(s.counts.executionRelease, 0);
    pending.resolve(s.owner.invocation);
    await refused;
    assert.equal(s.counts.executionRelease, 1);
  },
);

test("the final held Driver fence catches identity changes inside an original callback", async (t) => {
  let entered = 0;
  const s = composed(t, {
    providerCurrent(driver) {
      entered++;
      driver.id = "changed-component-driver";
    },
  });
  await assert.rejects(s.start());
  assert.equal(entered, 1);
  assert.equal(s.counts.invocation, 0);
  assert.equal(s.owner.counts.begin, 0);
  assert.equal(s.counts.sdk, 0);
  assert.equal(s.counts.executionRelease, 1);
});

test("caught duplicate fixed-provider entry cannot dispatch a second SDK operation", async (t) => {
  let duplicate = 0,
    refused = 0;
  const s = composed(t, {
    async afterCreate(provider, request, call) {
      duplicate++;
      await provider(request, call).then(
        () => assert.fail("duplicate provider unexpectedly succeeded"),
        () => {
          refused++;
        },
      );
    },
  });
  await assert.rejects(s.start());
  assert.equal(duplicate, 1);
  assert.equal(refused, 1);
  assert.equal(s.counts.invocation, 1);
  assert.equal(s.counts.sdk, 1);
  assert.equal(s.owner.counts.release, 1);
  assert.equal(s.counts.executionRelease, 1);
});

for (const resultKind of ["response", "rejection"])
  test(
    "actual late SDK " + resultKind + " stays owned after original worker cancellation",
    { timeout: 5_000 },
    async (t) => {
      const sdk = barrier(),
        observation = barrier(),
        release = barrier();
      const s = composed(t, {
        sdk: () => sdk.promise,
        observation: () => observation.promise,
        observationRelease: () => release.promise,
      });
      const running = s.start(),
        settled = completion(running),
        refused = assert.rejects(running);
      t.after(async () => {
        sdk.resolve(apiResponse(s.f));
        observation.resolve();
        release.resolve();
        await refused;
      });
      await s.sdkEntered.promise;
      s.peer.abort.abort(new Error("original worker canceled"));
      await nextTurn();
      assert.equal(settled(), false);
      assert.equal(s.owner.counts.release, 0);
      assert.equal(s.counts.executionRelease, 0);
      if (resultKind === "response") {
        sdk.resolve(apiResponse(s.f));
        await s.observationEntered.promise;
        assert.equal(settled(), false);
        assert.equal(s.counts.executionRelease, 0);
        observation.resolve();
        await nextTurn();
        assert.equal(settled(), false);
        assert.equal(s.counts.response, 1);
        assert.equal(s.counts.responseSource, 1);
        assert.equal(s.freshCall.signal.aborted, false);
        assert.equal(s.originalCall.signal.aborted, true);
        release.resolve();
      } else {
        sdk.reject(new Error("late actual SDK rejection"));
        observation.resolve();
        release.resolve();
      }
      await refused;
      assert.equal(s.owner.counts.release, 1);
      assert.equal(s.owner.unresolved(), true);
      assert.equal(s.counts.executionRelease, 1);
      assert.equal(s.counts.observation, resultKind === "response" ? 1 : 0);
      assert.equal(s.owner.outcomes[0].status, resultKind === "response" ? "response" : "unknown");
    },
  );

test("independent response commit and execution release failures cannot become retained success", async (t) => {
  for (const kind of ["response", "release"]) {
    const failure = new Error(kind + " failed");
    const s = composed(t, {
      retainResponse() {
        if (kind === "response") throw failure;
      },
      executionRelease() {
        if (kind === "release") throw failure;
      },
    });
    await assert.rejects(s.start(), (error) => error === failure);
    assert.equal(s.counts.sdk, 1);
    assert.equal(s.owner.outcomes[0].status, "response");
    assert.equal(s.counts.observationRelease, 1);
    assert.equal(s.counts.executionReleaseAttempts, 1);
    assert.equal(s.counts.executionRelease, kind === "release" ? 0 : 1);
    assert.equal(s.owner.unresolved(), true);
  }
});

test(
  "cancel during real composed hold acquisition joins the hold then refuses before SDK",
  { timeout: 5_000 },
  async (t) => {
    const acquired = barrier();
    const s = composed(t, { holding: { onBegin: () => acquired.promise } });
    const running = s.start(),
      settled = completion(running),
      refused = assert.rejects(running);
    t.after(async () => {
      acquired.resolve();
      await refused;
    });
    await s.owner.entered.promise;
    assert.equal(s.counts.invocation, 1);
    assert.equal(s.counts.sdk, 0);
    s.peer.abort.abort(new Error("original invocation canceled during hold acquisition"));
    await nextTurn();
    assert.equal(settled(), false);
    assert.equal(s.counts.executionReleaseAttempts, 0);
    acquired.resolve();
    await refused;
    assert.equal(s.owner.counts.current, 1);
    assert.equal(s.owner.outcomes[0].status, "unknown");
    assert.equal(s.owner.counts.release, 1);
    assert.equal(s.owner.unresolved(), true);
    assert.equal(s.counts.sdk, 0);
    assert.equal(s.counts.executionReleaseAttempts, 1);
  },
);
