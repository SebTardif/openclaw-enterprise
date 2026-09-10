import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { RUNTIME_EFFECT_LIMITS_V1 } from "../../packages/contracts/src/index.ts";
import * as v from "../fixtures/runtime-effects-v1/vectors.mjs";

const { options: lifecycleOptions } = JSON.parse(
  readFileSync(
    new URL("../fixtures/kubernetes-lifecycle-collaborators/inputs.json", import.meta.url),
    "utf8",
  ),
);
const kinds = ["create-correlation", "execution", "profiles", "observation"];
const names = {
  "create-correlation": "correlation",
  execution: "execution",
  profiles: "profiles",
  observation: "observation",
};
const startedAt = "2026-01-01T00:00:00.000Z";
const harnessImage = `fixture/harness@${v.digest(1)}`;
const initImage = `fixture/initializer@${v.digest(51)}`;

// Canonical test record encoding only. This supplies protected-record digests;
// it does not implement correlation, authority, freshness, ancestry, or readiness.
function digestRecord(value) {
  return v.hash(
    JSON.stringify(value, (_key, entry) => {
      if (entry === null || Array.isArray(entry) || typeof entry !== "object") return entry;
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, entry[key]]),
      );
    }),
  );
}

function trust(recipient, identity) {
  return {
    schemaVersion: 1,
    installationId: v.scope.installationId,
    configurationVersion: 1,
    serviceIdentityRef: identity,
    serviceTrustProfileRef: "controlled-service-profile",
    serviceTrustProfileDigest: v.digest(50),
    trustRootsRef: "controlled-roots",
    verifierProfileRef: "controlled-verifier",
    permittedRecipientRef: recipient,
    role: "compute-observer",
    allowedScope: { kind: "agent", ...v.scope },
  };
}

/** Test-owned transport identities. A copied or structurally similar handle has
 * no entry, and each source registry is separate from the caller's registry.
 * These controlled records are not authentic transport or live runtime proof. */
function authority(requestRef, recipientRef, identity, deadline = "2026-01-01T00:00:05.000Z") {
  const context = Object.freeze({ schemaVersion: 1 });
  const transportBinding = Object.freeze({});
  const service = {
    configuration: trust(recipientRef, identity),
    authenticatedAt: startedAt,
    expiresAt: "2026-01-01T00:01:00.000Z",
    peerEvidenceRef: `controlled-peer/${identity}`,
    transportBinding,
  };
  const registrations = new WeakMap([[context, service]]);
  const inspections = [];
  const call = {
    requestRef,
    recipientRef,
    context,
    deadline,
    signal: new AbortController().signal,
  };
  return {
    call,
    service,
    registrations,
    inspections,
    contextFactory: {
      async inspect(handle, bounds) {
        inspections.push({
          handle,
          requestRef: bounds.requestRef,
          recipientRef: bounds.recipientRef,
        });
        if (
          bounds.signal.aborted ||
          bounds.requestRef !== requestRef ||
          bounds.recipientRef !== recipientRef ||
          bounds.deadline !== deadline
        )
          return undefined;
        return registrations.get(handle);
      },
    },
  };
}

function fixture({
  method = "observe",
  dependencies = true,
  isolation = true,
  expectedEvidenceVersion = null,
  deadline,
  sourceDeadline,
  nodeNetworkObservation,
} = {}) {
  const input = method === "discover" ? v.exactCreate() : v.candidate();
  if (method === "observe") input.expectedEvidenceVersion = expectedEvidenceVersion;
  const exact = method === "discover" ? input : input.createEffect;
  const owner = new AbortController();
  const clock = { wall: Date.parse(v.now), monotonic: 100 };
  const caller = authority("controlled-caller-request", "compute-observations", "caller", deadline);
  caller.call.signal = owner.signal;
  const hooks = {};
  const apiCalls = [];
  const unexpectedCalls = [];
  const sourceReads = [];
  const currentReads = [];
  const authorizationReads = [];
  const namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "tenant", uid: "namespace-uid", resourceVersion: "namespace-rv" },
  };
  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "deployment-2",
      namespace: "tenant",
      uid: "deployment-2",
      resourceVersion: "rv-2",
    },
    spec: { replicas: 1 },
    status: { readyReplicas: 0 },
  };
  const replicaSet = {
    apiVersion: "apps/v1",
    kind: "ReplicaSet",
    metadata: {
      name: "replica-set-2",
      namespace: "tenant",
      uid: "replica-set-2",
      resourceVersion: "replica-rv",
      ownerReferences: [
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: "deployment-2",
          uid: "deployment-2",
          controller: true,
        },
      ],
    },
  };
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "pod-2",
      namespace: "tenant",
      uid: "pod-2",
      resourceVersion: "pod-rv",
      ownerReferences: [
        {
          apiVersion: "apps/v1",
          kind: "ReplicaSet",
          name: "replica-set-2",
          uid: "replica-set-2",
          controller: true,
        },
      ],
    },
    spec: {
      nodeName: "node-a",
      runtimeClassName: "oce-gvisor-systrap",
      initContainers: [{ name: "initialize", image: initImage }],
      containers: [{ name: "harness", image: harnessImage }],
    },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "False" }],
      initContainerStatuses: [
        {
          name: "initialize",
          image: initImage,
          imageID: initImage,
          containerID: "containerd://initializer",
          restartCount: 0,
          ready: false,
          state: { terminated: { startedAt, finishedAt: startedAt, exitCode: 0 } },
        },
      ],
      containerStatuses: [
        {
          name: "harness",
          image: harnessImage,
          imageID: harnessImage,
          containerID: "containerd://harness",
          restartCount: 0,
          ready: false,
          state: { running: { startedAt } },
        },
      ],
    },
  };
  const provider = {
    namespace,
    deployment,
    replicaSets: { items: [replicaSet] },
    pods: { items: [pod] },
  };
  // Independently authored expected producer query. It is not derived from the
  // client's reads: changing a Pod or ancestry therefore cannot rewrite evidence.
  const chain = {
    namespace: { name: "tenant", uid: "namespace-uid", resourceVersion: "namespace-rv" },
    deployment: { name: "deployment-2", uid: "deployment-2", resourceVersion: "rv-2" },
    replicaSet: { name: "replica-set-2", uid: "replica-set-2", resourceVersion: "replica-rv" },
    pod: {
      name: "pod-2",
      uid: "pod-2",
      resourceVersion: "pod-rv",
      nodeName: "node-a",
      runtimeClassName: "oce-gvisor-systrap",
      containers: [
        {
          kind: "init",
          name: "initialize",
          containerId: "containerd://initializer",
          imageId: initImage,
          restartCount: 0,
          startedAt,
        },
        {
          kind: "main",
          name: "harness",
          containerId: "containerd://harness",
          imageId: harnessImage,
          restartCount: 0,
          startedAt,
        },
      ],
    },
  };
  const query = { input: method === "observe" ? v.copy(input) : v.candidate(), chain };
  const records = {
    "create-correlation": {
      recordRef: "retained-correlation",
      recordVersion: 4,
      input: v.copy(exact),
      namespace: "tenant",
      object: v.providerObject(),
      evidence: v.evidence("correlation", 7),
    },
    execution: {
      recordRef: "retained-execution",
      recordVersion: 5,
      query: v.copy(query),
      binding: v.binding(),
      evidence: v.evidence("execution-chain", 8),
    },
    profiles: {
      recordRef: "retained-profiles",
      recordVersion: 6,
      query: v.copy(query),
      profile: v.completeObservation().profile,
      evidence: v.evidence("profiles", 9),
    },
    observation: {
      recordRef: "retained-observation",
      recordVersion: 7,
      query: {
        ...v.copy(query),
        correlation: { recordRef: "retained-correlation", recordVersion: 4 },
        execution: { recordRef: "retained-execution", recordVersion: 5 },
        profiles: { recordRef: "retained-profiles", recordVersion: 6 },
      },
      evidence: v.evidence("observation", 11),
      ownerChainEvidence: v.evidence("owner-chain", 10),
    },
  };
  const authorization = {
    configuration: v.copy(caller.service.configuration),
    method,
    inputDigest: digestRecord(input),
    requestRef: caller.call.requestRef,
    recipientRef: caller.call.recipientRef,
    transportBinding: caller.service.transportBinding,
  };
  const sourceAuthorities = {};
  const currentRecords = {};
  const readers = {};
  for (const kind of kinds) {
    const source = authority(
      `source-request/${kind}`,
      `source-port/${kind}`,
      `source/${kind}`,
      sourceDeadline,
    );
    sourceAuthorities[kind] = source;
    const evidence = v.evidence();
    currentRecords[kind] = {
      kind,
      recordRef: records[kind].recordRef,
      recordVersion: records[kind].recordVersion,
      recordDigest: digestRecord(records[kind]),
      configuration: v.copy(source.service.configuration),
      producer: {
        producerRef: evidence.producerRef,
        producerServiceVersion: evidence.producerServiceVersion,
        producerProfileRef: evidence.producerProfileRef,
        producerProfileDigest: evidence.producerProfileDigest,
        acceptedPortRef: evidence.acceptedPortRef,
      },
    };
    readers[names[kind]] = {
      contextFactory: source.contextFactory,
      async read(request, call) {
        sourceReads.push({ kind, query: request, call });
        if (hooks.read)
          return hooks.read(kind, request, call, () => ({
            status: "observed",
            record: records[kind],
            sourceCall: source.call,
          }));
        return { status: "observed", record: records[kind], sourceCall: source.call };
      },
      async readCurrent(reference, call) {
        currentReads.push({ kind, reference, call });
        if (hooks.current)
          return hooks.current(kind, reference, call, () => v.copy(currentRecords[kind]));
        return v.copy(currentRecords[kind]);
      },
    };
  }
  const dependenciesValue = {
    clusterRef: "cluster",
    clock: { now: () => new Date(clock.wall), monotonicMilliseconds: () => clock.monotonic },
    contextFactory: caller.contextFactory,
    async readAuthorization(requestedMethod, request, call) {
      authorizationReads.push({ method: requestedMethod, input: request, call });
      if (hooks.authorize)
        return hooks.authorize(requestedMethod, request, call, () => authorization);
      return authorization;
    },
    ...readers,
  };
  const clients = {};
  for (const [group, methods] of [
    ["core", { readNamespace: "namespace", listNamespacedPod: "pods" }],
    ["apps", { readNamespacedDeployment: "deployment", listNamespacedReplicaSet: "replicaSets" }],
  ]) {
    clients[group] = new Proxy(
      {},
      {
        get(_target, name) {
          return async (request) => {
            if (!(name in methods)) {
              unexpectedCalls.push({ group, name, request });
              throw new Error("Unexpected Kubernetes operation");
            }
            apiCalls.push({ method: name, request, signal: currentComputeAbortSignal() });
            if (hooks.provider)
              return hooks.provider(name, request, () => v.copy(provider[methods[name]]));
            return v.copy(provider[methods[name]]);
          };
        },
      },
    );
  }
  const driver = new KubernetesComputeDriver(
    { ...v.copy(lifecycleOptions), ...(isolation ? { isolationProfile: "gvisor-systrap" } : {}) },
    {
      ...(dependencies ? { runtimeObservationDependencies: dependenciesValue } : {}),
      ...(nodeNetworkObservation === undefined ? {} : { nodeNetworkObservation }),
    },
  );
  driver.apiClients = Promise.resolve(clients);
  return {
    input,
    exact,
    driver,
    owner,
    clock,
    caller,
    authorization,
    records,
    currentRecords,
    sourceAuthorities,
    dependencies: dependenciesValue,
    readers,
    hooks,
    provider,
    chain,
    apiCalls,
    unexpectedCalls,
    sourceReads,
    currentReads,
    authorizationReads,
    republish(kind) {
      currentRecords[kind].recordDigest = digestRecord(records[kind]);
    },
    async run() {
      const result = await driver[method](input, caller.call);
      assert.deepEqual(
        unexpectedCalls,
        [],
        "observation must issue only the allowed Kubernetes reads",
      );
      return result;
    },
  };
}

function notPositive(result) {
  assert.ok(
    ["incomplete", "ambiguous", "unknown", "conflict"].includes(result.status),
    JSON.stringify(result),
  );
  assert.equal("binding" in result, false);
  assert.equal("object" in result, false);
}

test("Kubernetes exact-create discovery preserves original retained correlation without reading descendants", async () => {
  const f = fixture({ method: "discover" });
  const result = await f.run();
  assert.deepEqual(v.copy(result), {
    schemaVersion: 1,
    status: "exact",
    input: f.input,
    object: f.records["create-correlation"].object,
    correlationEvidence: f.records["create-correlation"].evidence,
  });
  assert.deepEqual(
    f.apiCalls.map(({ method }) => method),
    ["readNamespace", "readNamespacedDeployment", "readNamespace", "readNamespacedDeployment"],
  );
  assert.equal(f.sourceReads.length, 1);
  assert.equal(f.currentReads.length, 2);
  assert.equal(f.authorizationReads.length, 2);
});

test("Kubernetes observation uses independent retained sources and exact ancestry without Ready or target identity", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, "complete");
  assert.equal(result.eligibility, "observation-only");
  assert.equal(result.identityEvidence, null);
  assert.deepEqual(v.copy(result.binding), v.binding());
  assert.deepEqual(v.copy(result.observation), f.records.observation.evidence);
  assert.deepEqual(v.copy(result.ownerChainEvidence), f.records.observation.ownerChainEvidence);
  assert.deepEqual(v.copy(result.executionCorrespondenceEvidence), f.records.execution.evidence);
  assert.deepEqual(v.copy(result.profile), f.records.profiles.profile);
  assert.deepEqual(
    f.sourceReads.map(({ kind }) => kind),
    kinds,
  );
  assert.deepEqual(f.sourceReads.find(({ kind }) => kind === "execution").query.chain, f.chain);
  assert.ok(f.sourceReads.every(({ query }) => Object.isFrozen(query)));
  assert.equal(f.apiCalls.length, 8);
  assert.equal(f.currentReads.length, 8);
  assert.equal(f.authorizationReads.length, 2);
  for (const { kind, reference, call } of f.currentReads) {
    assert.deepEqual(reference, {
      recordRef: f.records[kind].recordRef,
      recordVersion: f.records[kind].recordVersion,
    });
    assert.equal(call.context, f.sourceAuthorities[kind].call.context);
    assert.notEqual(call.context, f.caller.call.context);
  }
  for (const { method, request, signal } of f.apiCalls) {
    assert.ok(signal instanceof AbortSignal);
    if (method.startsWith("list"))
      assert.equal(request.limit, RUNTIME_EFFECT_LIMITS_V1.maxChildren + 1);
    if (method !== "readNamespace") assert.equal(request.namespace, "tenant");
  }
});

test("runtime observation producers cannot be supplied through ordinary Driver JSON configuration", () => {
  assert.throws(
    () =>
      new KubernetesComputeDriver({
        ...v.copy(lifecycleOptions),
        runtimeObservationDependencies: {},
      }),
    /unsupported option runtimeObservationDependencies/,
  );
});

test("Kubernetes typed descendant lists can omit item TypeMeta while preserving exact UID ancestry", async () => {
  const f = fixture();
  for (const item of [...f.provider.replicaSets.items, ...f.provider.pods.items]) {
    delete item.kind;
    delete item.apiVersion;
  }
  // Typed API list entries may omit TypeMeta. Owner references, namespace, UID,
  // resourceVersion and protected execution correspondence remain required.
  const result = await f.run();
  assert.equal(result.status, "complete");
  assert.deepEqual(v.copy(result.binding), v.binding());
  assert.equal(f.apiCalls.length, 8);
});

test("Kubernetes complete typed lists accept explicit zero remaining items and empty continuation metadata", async () => {
  const f = fixture();
  Object.assign(f.provider.replicaSets, {
    apiVersion: "apps/v1",
    kind: "ReplicaSetList",
    metadata: { continue: "", _continue: "", remainingItemCount: 0 },
  });
  Object.assign(f.provider.pods, {
    apiVersion: "v1",
    kind: "PodList",
    metadata: { continue: "", _continue: "", remainingItemCount: 0 },
  });
  assert.equal((await f.run()).status, "complete");
  assert.equal(f.apiCalls.length, 8);
});

test("source authentication retains its original later deadline under an earlier caller deadline", async () => {
  const f = fixture({
    deadline: "2026-01-01T00:00:02.000Z",
    sourceDeadline: "2026-01-01T00:00:05.000Z",
  });
  assert.equal((await f.run()).status, "complete");
  assert.ok(f.currentReads.every(({ call }) => call.deadline === "2026-01-01T00:00:05.000Z"));
  assert.ok(f.authorizationReads.every(({ call }) => call.deadline === "2026-01-01T00:00:02.000Z"));
});

for (const method of ["discover", "observe"]) {
  test(`Kubernetes ${method} without trusted dependencies makes zero provider calls`, async () => {
    const f = fixture({ method, dependencies: false });
    const result = await f.run();
    notPositive(result);
    assert.equal(result.reasonCode, "authority-unavailable");
    assert.deepEqual(f.apiCalls, []);
    assert.deepEqual(f.sourceReads, []);
  });
}

test("caller identity and protected authorization are required before provider access", async (t) => {
  for (const [name, change] of [
    [
      "copied opaque context",
      (f) => {
        f.caller.call.context = { ...f.caller.call.context };
      },
    ],
    [
      "revoked caller context",
      (f) => {
        f.caller.registrations.delete(f.caller.call.context);
      },
    ],
    [
      "rewritten authenticated caller deadline",
      (f) => {
        f.caller.call.deadline = "2026-01-01T00:00:04.000Z";
      },
    ],
    [
      "unavailable current authorization",
      (f) => {
        f.hooks.authorize = () => undefined;
      },
    ],
    [
      "authorization for another method",
      (f) => {
        f.authorization.method = "discover";
      },
    ],
    [
      "authorization for another input",
      (f) => {
        f.authorization.inputDigest = v.digest(99);
      },
    ],
    [
      "authorization for another request",
      (f) => {
        f.authorization.requestRef = "another-request";
      },
    ],
    [
      "authorization for another recipient",
      (f) => {
        f.authorization.recipientRef = "another-recipient";
      },
    ],
    [
      "copied transport binding",
      (f) => {
        f.authorization.transportBinding = { ...f.authorization.transportBinding };
      },
    ],
    [
      "foreign protected configuration",
      (f) => {
        f.authorization.configuration.configurationVersion = 2;
      },
    ],
    [
      "foreign caller scope",
      (f) => {
        f.caller.service.configuration.allowedScope.agentId = `agt_${v.uuid(99)}`;
      },
    ],
    [
      "expired caller service",
      (f) => {
        f.caller.service.expiresAt = startedAt;
      },
    ],
    [
      "caller not authenticated yet",
      (f) => {
        f.caller.service.authenticatedAt = "2026-01-01T00:00:02.000Z";
      },
    ],
  ]) {
    await t.test(name, async () => {
      const f = fixture();
      change(f);
      notPositive(await f.run());
      assert.deepEqual(f.apiCalls, []);
      assert.deepEqual(f.sourceReads, []);
    });
  }
});

test("every retained producer requires its own live source authority and protected current record", async (t) => {
  for (const kind of kinds) {
    for (const [name, change] of [
      [
        "missing producer",
        (f) => {
          f.hooks.read = (requested, _query, _call, next) =>
            requested === kind ? { status: "unavailable" } : next();
        },
      ],
      [
        "copied source handle",
        (f) => {
          const source = f.sourceAuthorities[kind];
          source.call.context = { ...source.call.context };
        },
      ],
      [
        "caller substituted for source",
        (f) => {
          f.sourceAuthorities[kind].call.context = f.caller.call.context;
        },
      ],
      [
        "rewritten authenticated source deadline",
        (f) => {
          f.sourceAuthorities[kind].call.deadline = "2026-01-01T00:00:04.000Z";
        },
      ],
      [
        "revoked source",
        (f) => {
          const source = f.sourceAuthorities[kind];
          source.registrations.delete(source.call.context);
        },
      ],
      [
        "missing current record",
        (f) => {
          delete f.currentRecords[kind];
        },
      ],
      [
        "current record digest mismatch",
        (f) => {
          f.currentRecords[kind].recordDigest = v.digest(99);
        },
      ],
      [
        "current record version mismatch",
        (f) => {
          f.currentRecords[kind].recordVersion += 1;
        },
      ],
      [
        "current record kind mismatch",
        (f) => {
          f.currentRecords[kind].kind = kind === "execution" ? "profiles" : "execution";
        },
      ],
      [
        "current source configuration mismatch",
        (f) => {
          f.currentRecords[kind].configuration.configurationVersion += 1;
        },
      ],
      [
        "current producer mismatch",
        (f) => {
          f.currentRecords[kind].producer.producerRef = "unrelated-producer";
        },
      ],
    ]) {
      await t.test(`${kind}: ${name}`, async () => {
        const f = fixture();
        change(f);
        notPositive(await f.run());
        assert.ok(
          f.sourceReads.some((read) => read.kind === kind),
          "the affected producer boundary must be reached",
        );
      });
    }
  }
});

test("producer records must correspond to the exact create effect and observed query", async (t) => {
  for (const [name, kind, change] of [
    [
      "different create effect",
      "create-correlation",
      (r) => {
        r.input.effect.effectRef = v.uuid(999);
      },
    ],
    [
      "different provider ownership",
      "create-correlation",
      (r) => {
        r.object.target.ownerCreateEffectRef = v.uuid(999);
      },
    ],
    [
      "different provider cluster",
      "create-correlation",
      (r) => {
        r.object.target.clusterRef = "another-cluster";
      },
    ],
    [
      "different correlated object UID",
      "create-correlation",
      (r) => {
        r.object.uid = "replacement-deployment";
      },
    ],
    [
      "different execution query",
      "execution",
      (r) => {
        r.query.chain.pod.containers[1].restartCount = 1;
      },
    ],
    [
      "different runtime Pod binding",
      "execution",
      (r) => {
        r.binding.podUid = "another-pod";
      },
    ],
    [
      "different runtime ReplicaSet binding",
      "execution",
      (r) => {
        r.binding.replicaSetUid = "another-replicaset";
      },
    ],
    [
      "different protected profile query",
      "profiles",
      (r) => {
        r.query.chain.pod.nodeName = "another-node";
      },
    ],
    [
      "summary of another retained record",
      "observation",
      (r) => {
        r.query.execution.recordVersion += 1;
      },
    ],
  ]) {
    await t.test(name, async () => {
      const f = fixture();
      change(f.records[kind]);
      f.republish(kind);
      // Even an independently current producer record must match this request
      // and the observed provider ancestry before the Driver returns authority data.
      notPositive(await f.run());
      assert.ok(f.sourceReads.some((read) => read.kind === kind));
    });
  }
});

test("Kubernetes observation rejects absent, ambiguous, malformed, or foreign ancestry", async (t) => {
  for (const [name, change] of [
    [
      "Namespace wrong kind",
      (p) => {
        p.namespace.kind = "Pod";
      },
    ],
    [
      "Namespace missing resource version",
      (p) => {
        delete p.namespace.metadata.resourceVersion;
      },
    ],
    [
      "Namespace wrong UID",
      (p) => {
        p.namespace.metadata.uid = "another-namespace";
      },
    ],
    [
      "Deployment wrong resource version",
      (p) => {
        p.deployment.metadata.resourceVersion = "rv-other";
      },
    ],
    [
      "Deployment wrong kind",
      (p) => {
        p.deployment.kind = "Pod";
      },
    ],
    [
      "Deployment wrong namespace",
      (p) => {
        p.deployment.metadata.namespace = "another-tenant";
      },
    ],
    [
      "Deployment deleting",
      (p) => {
        p.deployment.metadata.deletionTimestamp = startedAt;
      },
    ],
    [
      "no ReplicaSet",
      (p) => {
        p.replicaSets.items = [];
      },
    ],
    [
      "ReplicaSet wrong kind",
      (p) => {
        p.replicaSets.items[0].kind = "Deployment";
      },
    ],
    [
      "ReplicaSet wrong namespace",
      (p) => {
        p.replicaSets.items[0].metadata.namespace = "another-tenant";
      },
    ],
    [
      "ReplicaSet missing resource version",
      (p) => {
        delete p.replicaSets.items[0].metadata.resourceVersion;
      },
    ],
    [
      "ReplicaSet unrelated owner UID",
      (p) => {
        p.replicaSets.items[0].metadata.ownerReferences[0].uid = "another-deployment";
      },
    ],
    [
      "ReplicaSet mismatched owner name",
      (p) => {
        p.replicaSets.items[0].metadata.ownerReferences[0].name = "another-deployment";
      },
    ],
    [
      "ReplicaSet duplicate controllers",
      (p) => {
        p.replicaSets.items[0].metadata.ownerReferences.push({
          ...p.replicaSets.items[0].metadata.ownerReferences[0],
          uid: "another-owner",
        });
      },
    ],
    [
      "truncated ReplicaSet list",
      (p) => {
        p.replicaSets.metadata = { _continue: "more" };
      },
    ],
    [
      "raw ReplicaSet continuation",
      (p) => {
        p.replicaSets.metadata = { continue: "more" };
      },
    ],
    [
      "ReplicaSet items still remaining",
      (p) => {
        p.replicaSets.metadata = { remainingItemCount: 1 };
      },
    ],
    [
      "ReplicaSet list wrong kind",
      (p) => {
        p.replicaSets.kind = "PodList";
      },
    ],
    [
      "ReplicaSet list malformed metadata",
      (p) => {
        p.replicaSets.metadata = [];
      },
    ],
    [
      "no Pod",
      (p) => {
        p.pods.items = [];
      },
    ],
    [
      "Pod wrong kind",
      (p) => {
        p.pods.items[0].kind = "ReplicaSet";
      },
    ],
    [
      "Pod wrong namespace",
      (p) => {
        p.pods.items[0].metadata.namespace = "another-tenant";
      },
    ],
    [
      "Pod missing resource version",
      (p) => {
        delete p.pods.items[0].metadata.resourceVersion;
      },
    ],
    [
      "Pod unrelated owner UID",
      (p) => {
        p.pods.items[0].metadata.ownerReferences[0].uid = "another-replicaset";
      },
    ],
    [
      "Pod direct Deployment owner",
      (p) => {
        p.pods.items[0].metadata.ownerReferences[0] = {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: "deployment-2",
          uid: "deployment-2",
          controller: true,
        };
      },
    ],
    [
      "Pod not controller-owned",
      (p) => {
        p.pods.items[0].metadata.ownerReferences[0].controller = false;
      },
    ],
    [
      "Pod terminal",
      (p) => {
        p.pods.items[0].status.phase = "Succeeded";
      },
    ],
    [
      "Pod not placed",
      (p) => {
        delete p.pods.items[0].spec.nodeName;
      },
    ],
    [
      "Pod missing runtime class",
      (p) => {
        delete p.pods.items[0].spec.runtimeClassName;
      },
    ],
    [
      "Pod missing execution status",
      (p) => {
        p.pods.items[0].status.containerStatuses = [];
      },
    ],
    [
      "Pod missing image identity",
      (p) => {
        delete p.pods.items[0].status.containerStatuses[0].imageID;
      },
    ],
    [
      "Pod missing container identity",
      (p) => {
        delete p.pods.items[0].status.containerStatuses[0].containerID;
      },
    ],
    [
      "Pod duplicate container status",
      (p) => {
        p.pods.items[0].status.containerStatuses.push(
          v.copy(p.pods.items[0].status.containerStatuses[0]),
        );
      },
    ],
    [
      "Pod negative restart count",
      (p) => {
        p.pods.items[0].status.containerStatuses[0].restartCount = -1;
      },
    ],
    [
      "init execution unobserved",
      (p) => {
        p.pods.items[0].status.initContainerStatuses = [];
      },
    ],
    [
      "ephemeral workload outside producer coverage",
      (p) => {
        p.pods.items[0].spec.ephemeralContainers = [{ name: "debug", image: "debug:local" }];
      },
    ],
    [
      "uncovered ephemeral execution status",
      (p) => {
        p.pods.items[0].status.ephemeralContainerStatuses = [{ name: "debug" }];
      },
    ],
    [
      "truncated Pod list",
      (p) => {
        p.pods.metadata = { _continue: "more" };
      },
    ],
    [
      "raw Pod continuation",
      (p) => {
        p.pods.metadata = { continue: "more" };
      },
    ],
    [
      "Pod items still remaining",
      (p) => {
        p.pods.metadata = { remainingItemCount: 1 };
      },
    ],
    [
      "Pod list wrong kind",
      (p) => {
        p.pods.kind = "ReplicaSetList";
      },
    ],
    [
      "Pod list malformed metadata",
      (p) => {
        p.pods.metadata = null;
      },
    ],
    [
      "two live descendant Pods",
      (p) => {
        const other = v.copy(p.pods.items[0]);
        other.metadata.name = "pod-other";
        other.metadata.uid = "pod-other";
        p.pods.items.push(other);
      },
    ],
  ]) {
    await t.test(name, async () => {
      const f = fixture();
      change(f.provider);
      const result = await f.run();
      notPositive(result);
      assert.ok(f.apiCalls.some(({ method }) => method === "readNamespace"));
      if (name === "two live descendant Pods") assert.equal(result.status, "ambiguous");
    });
  }
});

test("unrelated Pods do not replace the exact Deployment descendant", async () => {
  const f = fixture();
  const unrelated = v.copy(f.provider.pods.items[0]);
  unrelated.metadata.name = "unrelated";
  unrelated.metadata.uid = "unrelated";
  unrelated.metadata.ownerReferences[0].uid = "unrelated-controller";
  f.provider.pods.items.unshift(unrelated);
  assert.equal((await f.run()).status, "complete");
});

test("invalid direct-Pod create requests fail intrinsic validation before authority or Kubernetes reads", async () => {
  const f = fixture({ method: "discover" });
  f.input.providerTarget.apiKind = "Pod";
  await assert.rejects(f.run());
  assert.deepEqual(f.authorizationReads, []);
  assert.deepEqual(f.apiCalls, []);
});

test("a harness observation requires the selected gVisor implementation", async () => {
  const f = fixture({ isolation: false });
  const result = await f.run();
  notPositive(result);
  assert.equal(result.reasonCode, "capability-unsupported");
  assert.deepEqual(f.sourceReads, []);
  assert.deepEqual(f.apiCalls, []);
});

test("provider rereads reject changed namespace, object, and protected Pod incarnation", async (t) => {
  for (const [name, method, change] of [
    [
      "namespace resource version",
      "readNamespace",
      (p) => {
        p.namespace.metadata.resourceVersion = "namespace-next";
      },
    ],
    [
      "Deployment resource version",
      "readNamespacedDeployment",
      (p) => {
        p.deployment.metadata.resourceVersion = "deployment-next";
      },
    ],
    [
      "ReplicaSet resource version",
      "listNamespacedReplicaSet",
      (p) => {
        p.replicaSets.items[0].metadata.resourceVersion = "replica-next";
      },
    ],
    [
      "Pod resource version",
      "listNamespacedPod",
      (p) => {
        p.pods.items[0].metadata.resourceVersion = "pod-next";
      },
    ],
    [
      "same-Pod restart",
      "listNamespacedPod",
      (p) => {
        p.pods.items[0].status.containerStatuses[0].restartCount += 1;
      },
    ],
    [
      "same-Pod container replacement",
      "listNamespacedPod",
      (p) => {
        p.pods.items[0].status.containerStatuses[0].containerID = "containerd://replacement";
      },
    ],
    [
      "same-Pod image replacement",
      "listNamespacedPod",
      (p) => {
        p.pods.items[0].status.containerStatuses[0].imageID = "sha256:replacement";
      },
    ],
    [
      "same-Pod init restart",
      "listNamespacedPod",
      (p) => {
        p.pods.items[0].status.initContainerStatuses[0].restartCount += 1;
      },
    ],
    [
      "same-Pod changed start time",
      "listNamespacedPod",
      (p) => {
        p.pods.items[0].status.containerStatuses[0].state.running.startedAt =
          "2026-01-01T00:00:00.500Z";
      },
    ],
  ]) {
    await t.test(name, async () => {
      const f = fixture();
      let reads = 0;
      f.hooks.provider = (requested, _request, next) => {
        if (requested === method && ++reads === 2) change(f.provider);
        return next();
      };
      notPositive(await f.run());
      assert.equal(reads, 2, "the changed second provider observation must actually be read");
    });
  }
});

test("authority and protected original source records are rechecked before completion", async (t) => {
  for (const [name, change] of [
    [
      "caller authorization withdrawn",
      (f) => {
        f.hooks.authorize = (_method, _input, _call, next) =>
          f.authorizationReads.length > 1 ? undefined : next();
      },
    ],
    [
      "caller configuration replaced",
      (f) => {
        f.hooks.read = (kind, _query, _call, next) => {
          if (kind === "observation") {
            f.caller.service.configuration.configurationVersion += 1;
            f.authorization.configuration.configurationVersion += 1;
          }
          return next();
        };
      },
    ],
    [
      "source authority revoked",
      (f) => {
        f.hooks.current = (kind, _ref, _call, next) => {
          if (
            kind === "execution" &&
            f.currentReads.filter((read) => read.kind === kind).length === 2
          )
            f.sourceAuthorities.execution.registrations.delete(
              f.sourceAuthorities.execution.call.context,
            );
          return next();
        };
      },
    ],
    [
      "source connection replaced",
      (f) => {
        f.hooks.read = (kind, _query, _call, next) => {
          if (kind === "observation")
            f.sourceAuthorities.execution.service.transportBinding = Object.freeze({});
          return next();
        };
      },
    ],
    [
      "protected source record superseded",
      (f) => {
        f.hooks.current = (kind, _ref, _call, next) => {
          if (
            kind === "execution" &&
            f.currentReads.filter((read) => read.kind === kind).length === 2
          )
            f.currentRecords.execution.recordVersion += 1;
          return next();
        };
      },
    ],
    [
      "protected source record withdrawn",
      (f) => {
        f.hooks.current = (kind, _ref, _call, next) =>
          kind === "profiles" && f.currentReads.filter((read) => read.kind === kind).length === 2
            ? undefined
            : next();
      },
    ],
  ]) {
    await t.test(name, async () => {
      const f = fixture();
      change(f);
      notPositive(await f.run());
      assert.equal(f.sourceReads.length, 4);
    });
  }
});

test("stale original producer evidence cannot be refreshed by later receipt or observation", async (t) => {
  for (const [kind, path] of [
    ["create-correlation", ["evidence"]],
    ["execution", ["evidence"]],
    ["profiles", ["evidence"]],
    ["profiles", ["profile", "delivered", "evidence"]],
    ["profiles", ["profile", "effective", "evidence"]],
    ["observation", ["evidence"]],
    ["observation", ["ownerChainEvidence"]],
  ]) {
    await t.test(`${kind}/${path.join("/")}`, async () => {
      const f = fixture();
      const evidence = path.reduce((value, key) => value[key], f.records[kind]);
      evidence.clock.validUntil = "2026-01-01T00:00:00.500Z";
      f.republish(kind);
      const result = await f.run();
      notPositive(result);
      assert.equal(result.reasonCode, "evidence-stale");
      assert.ok(f.sourceReads.some((read) => read.kind === kind));
    });
  }
});

test("observation versions remain producer-owned across repeated reads and expected-version gates", async () => {
  const f = fixture({ expectedEvidenceVersion: 10 });
  const first = await f.run();
  assert.equal(first.status, "complete");
  f.clock.wall += 100;
  f.clock.monotonic += 100;
  const second = await f.run();
  assert.deepEqual(second, first);
  assert.equal(second.observation.evidenceVersion, 11);
  assert.equal(second.observation.clock.sourceObservedAt, startedAt);
  assert.equal(second.observation.clock.receivedAt, "2026-01-01T00:00:00.100Z");
  assert.equal(f.sourceReads.length, 8);
  for (const expectedEvidenceVersion of [11, 12])
    notPositive(await fixture({ expectedEvidenceVersion }).run());
});

test("retained producer snapshots cannot be relabeled by later mutation of a returned object", async () => {
  const f = fixture();
  f.hooks.read = (kind, _query, _call, next) => {
    if (kind === "profiles") f.records.execution.binding.runtimeInstanceRef = "later-mutated-alias";
    return next();
  };
  const result = await f.run();
  assert.equal(result.status, "complete");
  assert.equal(result.binding.runtimeInstanceRef, "execution-2");
});

test("cancellation and deadlines bound caller, provider, and source reads without mutations", async (t) => {
  await t.test("already aborted call has no producer or provider reads", async () => {
    const f = fixture();
    f.owner.abort(new Error("controlled owner cancelled"));
    const result = await f.run();
    assert.equal(result.status, "unknown");
    assert.equal(result.reasonCode, "cancelled");
    assert.deepEqual(f.apiCalls, []);
    assert.deepEqual(f.sourceReads, []);
  });
  await t.test("expired request has no producer or provider reads", async () => {
    const f = fixture();
    f.caller.call.deadline = startedAt;
    const result = await f.run();
    notPositive(result);
    assert.equal(result.reasonCode, "deadline-exceeded");
    assert.deepEqual(f.apiCalls, []);
    assert.deepEqual(f.sourceReads, []);
  });
  await t.test("abort during provider read reaches the SDK request signal", async () => {
    const f = fixture();
    let observedSignal;
    f.hooks.provider = (_method, _request, next) => {
      observedSignal = currentComputeAbortSignal();
      f.owner.abort(new Error("controlled owner cancelled"));
      return next();
    };
    const result = await f.run();
    assert.equal(result.status, "unknown");
    assert.equal(result.reasonCode, "cancelled");
    assert.equal(observedSignal.aborted, true);
    assert.equal(f.apiCalls.length, 1);
  });
  for (const boundary of ["caller", "provider", "producer", "source-current"]) {
    await t.test(
      `${boundary} ignores cancellation but cannot outlive the request deadline`,
      async () => {
        const f = fixture({
          deadline: "2026-01-01T00:00:01.050Z",
          sourceDeadline: "2026-01-01T00:00:05.000Z",
        });
        let reached = false;
        const never = () => {
          reached = true;
          return new Promise(() => {});
        };
        if (boundary === "caller") f.hooks.authorize = never;
        if (boundary === "provider") f.hooks.provider = never;
        if (boundary === "producer") f.hooks.read = never;
        if (boundary === "source-current") f.hooks.current = never;
        const result = await f.run();
        assert.equal(result.status, "unknown");
        assert.equal(result.reasonCode, "deadline-exceeded");
        assert.equal(reached, true);
        if (boundary !== "provider") assert.deepEqual(f.apiCalls, []);
      },
    );
  }
  await t.test("monotonic overrun rejects a late successful callback", async () => {
    const f = fixture();
    f.hooks.provider = (_method, _request, next) => {
      f.clock.monotonic += 11_000;
      return next();
    };
    const result = await f.run();
    notPositive(result);
    assert.equal(result.reasonCode, "deadline-exceeded");
  });
  await t.test(
    "independent source cancellation cannot borrow the caller's live context",
    async () => {
      const f = fixture();
      const sourceOwner = new AbortController();
      sourceOwner.abort();
      f.sourceAuthorities.execution.call.signal = sourceOwner.signal;
      notPositive(await f.run());
      assert.equal(f.owner.signal.aborted, false);
    },
  );
});

function selectedNodeNetwork(clusterRef = "cluster") {
  return {
    client: {
      binaryPath: "/unavailable-node-observer/oce-node-observer",
      binaryDigest: v.digest(90),
      clientConfiguration: {
        enrollment: { clusterRef, namespace: "tenant", nodeName: "node", nodeUID: "node-uid" },
        workloadSocket: "/unavailable-node-observer/workload.sock",
        enrollmentDigest: v.digest(91),
      },
    },
    networkName: "pods",
    interfaceName: "eth0",
  };
}

test("selected node network source requires the original Compute cluster and gVisor constructor", () => {
  assert.throws(() => fixture({ nodeNetworkObservation: selectedNodeNetwork("another-cluster") }));
  assert.throws(() => fixture({ isolation: false, nodeNetworkObservation: selectedNodeNetwork() }));
  assert.throws(() =>
    fixture({ dependencies: false, nodeNetworkObservation: selectedNodeNetwork() }),
  );
  assert.throws(() =>
    fixture({ nodeNetworkObservation: { ...selectedNodeNetwork(), interfaceName: "eth0/other" } }),
  );
});

test("selected network configuration cannot supply missing original observation admission", async () => {
  const f = fixture({ nodeNetworkObservation: selectedNodeNetwork() });
  f.caller.registrations.delete(f.caller.call.context);
  const result = await f.run();
  notPositive(result);
  assert.deepEqual(f.apiCalls, []);
  assert.deepEqual(f.sourceReads, []);
  // The actual original admission boundary refuses before any Node client,
  // Kubernetes chain, profile producer, or summary producer can be selected.
});

test("selected network observation cannot invent the first retained creator-to-ADD association", async () => {
  const f = fixture({ nodeNetworkObservation: selectedNodeNetwork() });
  const result = await f.run();
  notPositive(result);
  assert.equal(result.reasonCode, "evidence-incomplete");
  assert.ok(f.sourceReads.some(({ kind }) => kind === "execution"));
  assert.equal(
    f.sourceReads.some(({ kind }) => kind === "profiles" || kind === "observation"),
    false,
  );
  // The original execution record is valid but intentionally has no retained
  // CNI association. The configured node endpoint must not mint that ownership.
});

for (const outcome of ["late success", "late rejection"]) {
  test(
    `selected CNI observation joins entered supplier ${outcome} and cleanup after cancellation`,
    { timeout: 5000 },
    async (t) => {
      for (const stage of ["read", "readCurrent", "inspect"]) {
        await t.test(stage, async () => {
          const f = fixture({ nodeNetworkObservation: selectedNodeNetwork() });
          let entered;
          let release;
          let cleanupEntered;
          let closeCleanup;
          const entry = new Promise((resolve) => {
            entered = resolve;
          });
          const continuation = new Promise((resolve) => {
            release = resolve;
          });
          const cleanupEntry = new Promise((resolve) => {
            cleanupEntered = resolve;
          });
          const cleanup = new Promise((resolve) => {
            closeCleanup = resolve;
          });
          let supplierClosed = false;
          let settled = false;
          const lateError = new Error("controlled late supplier rejection");
          const delayed = async (next) => {
            // Capture the existing controlled source's real return before abort;
            // no native handle, source registration or positive result is added.
            const original = await next();
            entered();
            try {
              await continuation;
              if (outcome === "late rejection") throw lateError;
              return original;
            } finally {
              cleanupEntered();
              await cleanup;
              supplierClosed = true;
            }
          };
          if (stage === "read") {
            f.hooks.read = (kind, _query, _call, next) =>
              kind === "execution" ? delayed(next) : next();
          } else if (stage === "readCurrent") {
            f.hooks.current = (kind, _reference, _call, next) =>
              kind === "execution" ? delayed(next) : next();
          } else {
            const factory = f.sourceAuthorities.execution.contextFactory;
            const inspect = factory.inspect.bind(factory);
            factory.inspect = (handle, call) => delayed(() => inspect(handle, call));
          }
          const running = f.run();
          void running.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          t.after(async () => {
            f.owner.abort();
            release();
            closeCleanup();
            await running;
          });
          try {
            await entry;
            assert.ok(f.sourceReads.some(({ kind }) => kind === "execution"));
            f.owner.abort(new Error("controlled original observation cancellation"));
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(settled, false, "entered callback still belongs to observation");
            assert.equal(supplierClosed, false);
            release();
            await cleanupEntry;
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(settled, false, "supplier cleanup must join too");
            assert.equal(supplierClosed, false);
            closeCleanup();
            const result = await running;
            assert.equal(supplierClosed, true);
            notPositive(result);
            assert.equal(result.status, "unknown");
            assert.equal(result.reasonCode, "cancelled");
            assert.equal(
              f.sourceReads.some(({ kind }) => kind === "profiles" || kind === "observation"),
              false,
            );
            // The authentic execution record still lacks its first retained ADD
            // association. No native process is entered or replaced by this case.
          } finally {
            f.owner.abort();
            release();
            closeCleanup();
            await running;
          }
        });
      }
    },
  );
}
