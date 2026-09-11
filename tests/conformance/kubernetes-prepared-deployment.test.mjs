import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import {
  canonicalRuntimeEffectRequestV1,
  parseRuntimeEffectsV1,
} from "../../packages/contracts/src/runtime-effects-v1.ts";
import { createRequest, hash, preparedChild } from "../fixtures/runtime-effects-v1/vectors.mjs";
import {
  PREPARED_DEPLOYMENT_ANNOTATIONS as keys,
  prepareKubernetesDeploymentRequest,
} from "../../apps/controller/src/drivers/compute/kubernetes/prepared-deployment.ts";
const { KubeConfig, AppsV1Api } = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@kubernetes/client-node");
const { ObjectSerializer } = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@kubernetes/client-node/dist/gen/models/ObjectSerializer.js");

// Actual selected SDK over loopback HTTP; the server is controlled API evidence.
// These tests do not establish Kubernetes enforcement or admission/renderer authority.
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

async function api(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const config = new KubeConfig();
  config.loadFromOptions({
    clusters: [
      { name: "local", server: `http://127.0.0.1:${server.address().port}`, skipTLSVerify: true },
    ],
    users: [{ name: "fixture" }],
    contexts: [{ name: "fixture", cluster: "local", user: "fixture" }],
    currentContext: "fixture",
  });
  return config.makeApiClient(AppsV1Api);
}
for (const action of ["reserve-inert", "materialize"])
  test(`selected SDK ${action} preserves exact bytes and captures actual API identity`, async (t) => {
    const f = fixture(action);
    const owner = encoding(f);
    let calls = 0;
    const apps = await api(t, async (req, res) => {
      calls++;
      const chunks = [];
      for await (const part of req) chunks.push(part);
      assert.equal(Buffer.concat(chunks).toString("utf8"), f.wire);
      assert.equal(req.method, action === "reserve-inert" ? "POST" : "PATCH");
      assert.equal(
        req.headers["content-type"],
        action === "reserve-inert" ? "application/json" : "application/json-patch+json",
      );
      assert.equal(
        req.url,
        `/apis/apps/v1/namespaces/${f.namespace}/deployments${action === "reserve-inert" ? "" : `/${f.object.metadata.name}`}`,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...f.object,
          metadata: {
            ...f.object.metadata,
            uid: action === "reserve-inert" ? "actual-returned-uid" : f.child.predicate.uid,
            resourceVersion: "actual-rv/000008",
          },
        }),
      );
    });
    const result = await prepareKubernetesDeploymentRequest(f.child, f.wire, f.namespace).submit(
      apps,
      owner.input,
    );
    assert.equal(calls, 1);
    assert.equal(
      result.uid,
      action === "reserve-inert" ? "actual-returned-uid" : f.child.predicate.uid,
    );
    assert.equal(result.resourceVersion, "actual-rv/000008");
    assert.equal(new Date(result.receivedAt).toISOString(), result.receivedAt);
    assert.equal(owner.outcomes[0].response, result);
    assert.equal(owner.counts.release, 1);
  });

test("rehashing an omitted or rebased predicate cannot reach the SDK", () => {
  for (const change of [
    (b) => b.shift(),
    (b) => {
      b[1].value = "replacement-rv";
    },
    (b) => {
      b[4].value = "999";
    },
    (b) => b.push({ op: "replace", path: "/metadata/annotations", value: {} }),
  ]) {
    const f = fixture("materialize");
    change(f.body);
    assert.throws(() => prepareKubernetesDeploymentRequest(f.child, f.bind(f.body), f.namespace));
  }
});
test("inert reservation rejects runnable replicas and unretained whitespace", () => {
  const f = fixture();
  f.body.spec.replicas = 1;
  assert.throws(() => prepareKubernetesDeploymentRequest(f.child, f.bind(f.body), f.namespace));
  const good = fixture();
  const wire = ` ${good.wire}`;
  good.child.providerWire.bytesDigest = hash(wire);
  good.child.providerWire.byteLength = Buffer.byteLength(wire);
  assert.throws(() => prepareKubernetesDeploymentRequest(good.child, wire, good.namespace));
});
test("actual conditional rejection is propagated without resubmission", async (t) => {
  const f = fixture("materialize");
  const owner = encoding(f);
  let calls = 0;
  const apps = await api(t, (_req, res) => {
    calls++;
    res.writeHead(422, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        kind: "Status",
        apiVersion: "v1",
        status: "Failure",
        code: 422,
        reason: "Invalid",
        message: "conditional mutation rejected",
      }),
    );
  });
  await assert.rejects(
    prepareKubernetesDeploymentRequest(f.child, f.wire, f.namespace).submit(apps, owner.input),
  );
  assert.equal(calls, 1);
  assert.equal(owner.outcomes[0].status, "unknown");
  assert.equal(owner.counts.release, 1);
});
test("response target mismatch cannot become an original receipt", async (t) => {
  const f = fixture();
  const owner = encoding(f);
  let calls = 0;
  const apps = await api(t, (_req, res) => {
    calls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ...f.object,
        metadata: {
          ...f.object.metadata,
          name: "another-target",
          uid: "actual",
          resourceVersion: "7",
        },
      }),
    );
  });
  await assert.rejects(
    prepareKubernetesDeploymentRequest(f.child, f.wire, f.namespace).submit(apps, owner.input),
  );
  assert.equal(calls, 1);
  assert.equal(owner.outcomes[0].status, "unknown");
  assert.equal(owner.counts.release, 1);
});

for (const action of ["reserve-inert", "materialize"])
  test(`full ${action} comparison rejects extra executable and mount behavior`, async () => {
    const { comparePreparedHarnessDeployment } =
      await import("../../apps/controller/src/drivers/compute/kubernetes/prepared-deployment-comparison.ts");
    const f = fixture(action);
    // Controlled renderer result for comparison semantics only, not installed
    // capability evidence. Every Pod field remains part of the equality boundary.
    comparePreparedHarnessDeployment(f.object, f.child, f.wire);
    for (const mutate of [
      (spec) => {
        spec.template.spec.initContainers = [{ name: "extra", image: "example.invalid/extra" }];
      },
      (spec) => {
        spec.template.spec.containers[0].command = ["changed"];
      },
      (spec) => {
        spec.template.spec.volumes = [{ name: "host", hostPath: { path: "/" } }];
      },
      (spec) => {
        spec.template.spec.containers[0].readinessProbe = { exec: { command: ["changed"] } };
      },
    ]) {
      const changed = structuredClone(f.object);
      mutate(changed.spec);
      assert.throws(() => comparePreparedHarnessDeployment(changed, f.child, f.wire));
    }
  });

test(
  "holding acquisition precedes actual SDK entry and retains the exact response",
  { timeout: 5_000 },
  async (t) => {
    const f = fixture(),
      permit = barrier();
    const owner = encoding(f, { onBegin: () => permit.promise });
    let calls = 0;
    const apps = await api(t, (_req, res) => {
      calls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(apiResponse(f)));
    });
    const prepared = prepareKubernetesDeploymentRequest(f.child, f.wire, f.namespace);
    const running = prepared.submit(apps, owner.input),
      settled = completion(running);
    t.after(async () => {
      permit.resolve();
      await Promise.allSettled([running]);
    });
    await owner.entered.promise;
    await nextTurn();
    assert.equal(calls, 0);
    assert.equal(settled(), false);
    permit.resolve();
    const result = await running;
    assert.equal(calls, 1);
    assert.equal(owner.inputs[0][0], owner.invocation);
    assert.equal(owner.inputs[0][1].committed, owner.committed);
    assert.deepEqual(owner.inputs[0][1].selection, owner.selection);
    assert.notEqual(owner.inputs[0][1].selection, owner.selection);
    assert.equal(owner.inputs[0][1].providerWireUtf8, f.wire);
    assert.equal(owner.outcomes[0].status, "response");
    assert.equal(owner.outcomes[0].response, result);
    assert.equal(owner.counts.beginGets, 1);
    assert.equal(owner.counts.retainGets, 1);
    assert.equal(owner.counts.releaseGets, 1);
    assert.equal(owner.counts.release, 1);
    assert.equal(owner.unresolved(), true);
    await assert.rejects(prepared.submit(apps, owner.input));
    assert.equal(calls, 1);
    assert.equal(owner.counts.begin, 1);
  },
);

test("the actual unavailable State holding refuses before any SDK call", async () => {
  const { createUnavailableRuntimeCreateEncodingHoldingV1 } =
    await import("../../packages/occ/src/state/postgres/runtime-create-encoding-holding.ts");
  const f = fixture(),
    owner = encoding(f);
  let calls = 0;
  const apps = {
    async createNamespacedDeployment() {
      calls++;
      throw new Error("unexpected SDK");
    },
  };
  await assert.rejects(
    prepareKubernetesDeploymentRequest(f.child, f.wire, f.namespace).submit(apps, {
      ...owner.input,
      holding: createUnavailableRuntimeCreateEncodingHoldingV1(),
    }),
  );
  assert.equal(calls, 0);
});

test("changed conditional data and copied invocation cannot reach the SDK", async () => {
  for (const mutate of [
    (input) => {
      input.target = { ...input.target, providerWireUtf8: input.target.providerWireUtf8 + " " };
    },
    (input) => {
      input.target = {
        ...input.target,
        selection: { ...input.target.selection, namespace: "foreign" },
      };
    },
    (input) => {
      input.target = { ...input.target, child: { ...input.target.child, effect: {} } };
    },
    (input) => {
      input.originalInvocation = { ...input.originalInvocation };
    },
  ]) {
    const f = fixture(),
      owner = encoding(f);
    mutate(owner.input);
    let calls = 0;
    await assert.rejects(
      prepareKubernetesDeploymentRequest(f.child, f.wire, f.namespace).submit(
        {
          async createNamespacedDeployment() {
            calls++;
            return apiResponse(f);
          },
        },
        owner.input,
      ),
    );
    assert.equal(calls, 0);
    assert.equal(owner.counts.retain, 0);
    assert.equal(owner.counts.release, 0);
  }
});

test("cleanup is captured before possible-effect getters and mismatched history refuses", async () => {
  for (const kind of ["mismatch", "getter"]) {
    const f = fixture(),
      failure = new Error("history getter failed");
    const owner = encoding(
      f,
      kind === "getter"
        ? { possibleError: failure }
        : {
            mutatePossible(value) {
              value.expectedUid = "foreign-uid";
            },
          },
    );
    let calls = 0,
      caught;
    try {
      await prepareKubernetesDeploymentRequest(f.child, f.wire, f.namespace).submit(
        {
          async createNamespacedDeployment() {
            calls++;
            return apiResponse(f);
          },
        },
        owner.input,
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught);
    if (kind === "getter") assert.equal(caught, failure);
    assert.equal(calls, 0);
    assert.ok(owner.events.indexOf("release-get") < owner.events.indexOf("possible-get"));
    assert.equal(owner.outcomes.length, 1);
    assert.equal(owner.outcomes[0].status, "unknown");
    assert.equal(owner.counts.release, 1);
    assert.equal(owner.unresolved(), true);
  }
});

test(
  "a non-synchronous currentness result is refused and its actual work joined before release",
  { timeout: 5_000 },
  async (t) => {
    const f = fixture(),
      pending = barrier(),
      currentEntered = barrier();
    const owner = encoding(f, {
      onCurrent() {
        currentEntered.resolve();
        return pending.promise;
      },
    });
    let calls = 0;
    const running = prepareKubernetesDeploymentRequest(f.child, f.wire, f.namespace).submit(
      {
        async createNamespacedDeployment() {
          calls++;
          return apiResponse(f);
        },
      },
      owner.input,
    );
    const refused = assert.rejects(running),
      settled = completion(running);
    t.after(async () => {
      pending.resolve();
      await refused;
    });
    await currentEntered.promise;
    await nextTurn();
    assert.equal(calls, 0);
    assert.equal(settled(), false);
    assert.equal(owner.counts.release, 0);
    pending.reject(new Error("late currentness refusal"));
    await refused;
    assert.equal(owner.outcomes[0].status, "unknown");
    assert.equal(owner.counts.release, 1);
  },
);

test("caught reentry irreversibly poisons the original prepared submission", async () => {
  const f = fixture();
  let prepared,
    owner,
    nested,
    calls = 0,
    nestedRefused = 0;
  const apps = {
    async createNamespacedDeployment() {
      calls++;
      return apiResponse(f);
    },
  };
  owner = encoding(f, {
    onCurrent() {
      nested = prepared.submit(apps, owner.input).catch(() => {
        nestedRefused++;
      });
    },
  });
  prepared = prepareKubernetesDeploymentRequest(f.child, f.wire, f.namespace);
  await assert.rejects(prepared.submit(apps, owner.input));
  await nested;
  assert.equal(nestedRefused, 1);
  assert.equal(calls, 0);
  assert.equal(owner.counts.begin, 1);
  assert.equal(owner.counts.release, 1);
  await assert.rejects(prepared.submit(apps, owner.input));
  assert.equal(owner.counts.begin, 1);
});

for (const outcome of ["response", "unknown"])
  test(
    "late SDK " + outcome + " remains joined with outcome and release",
    { timeout: 5_000 },
    async (t) => {
      const f = fixture(),
        sdk = barrier(),
        sdkEntered = barrier(),
        release = barrier();
      const failure = new Error("late SDK rejected");
      const owner = encoding(f, { onRelease: () => release.promise });
      const running = prepareKubernetesDeploymentRequest(f.child, f.wire, f.namespace).submit(
        {
          async createNamespacedDeployment() {
            sdkEntered.resolve();
            return sdk.promise;
          },
        },
        owner.input,
      );
      const settled = completion(running);
      let caught, response;
      const observed = running.then(
        (value) => {
          response = value;
        },
        (error) => {
          caught = error;
        },
      );
      t.after(async () => {
        sdk.resolve(apiResponse(f));
        release.resolve();
        await observed;
      });
      await sdkEntered.promise;
      await nextTurn();
      assert.equal(settled(), false);
      assert.equal(owner.outcomes.length, 0);
      assert.equal(owner.counts.release, 0);
      if (outcome === "response") sdk.resolve(apiResponse(f));
      else sdk.reject(failure);
      await owner.releaseEntered.promise;
      assert.equal(settled(), false);
      assert.equal(owner.outcomes[0].status, outcome);
      release.resolve();
      await observed;
      if (outcome === "response") {
        assert.equal(caught, undefined);
        assert.equal(owner.outcomes[0].response, response);
      } else {
        assert.equal(caught, failure);
      }
      assert.equal(owner.counts.release, 1);
      assert.equal(owner.unresolved(), true);
    },
  );

test("outcome and release failures remain failures and retain original causes", async () => {
  for (const which of ["outcome", "release", "both"]) {
    const f = fixture(),
      outcomeError = new Error("outcome commit unknown");
    const releaseError = new Error("release not confirmed");
    const owner = encoding(f, {
      onRetain() {
        if (which !== "release") throw outcomeError;
      },
      onRelease() {
        if (which !== "outcome") throw releaseError;
      },
    });
    let caught;
    try {
      await prepareKubernetesDeploymentRequest(f.child, f.wire, f.namespace).submit(
        {
          async createNamespacedDeployment() {
            return apiResponse(f);
          },
        },
        owner.input,
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught);
    if (which === "both") {
      assert.ok(caught instanceof AggregateError);
      assert.equal(caught.cause, outcomeError);
      assert.deepEqual(caught.errors, [outcomeError, releaseError]);
    } else assert.equal(caught, which === "outcome" ? outcomeError : releaseError);
    assert.equal(owner.counts.release, 1);
    assert.equal(owner.outcomes[0].status, "response");
    assert.equal(owner.unresolved(), true);
  }
});
