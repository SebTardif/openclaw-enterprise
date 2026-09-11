import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

const readFixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/kubernetes-lifecycle-collaborators/${name}`, import.meta.url),
      "utf8",
    ),
  );
const inputs = readFixture("inputs.json");
const observations = readFixture("observations.json");
const clone = (value) => structuredClone(value);
const revisionAnnotation = "openclaw.dev/agent-revision-id";
const apiError = (statusCode) =>
  Object.assign(new Error(`Controlled Kubernetes HTTP ${statusCode}`), { statusCode });
const key = (kind, namespace, name) => JSON.stringify([kind, namespace ?? "", name]);
const matchingLabels = (object, selector = "") =>
  selector
    .split(",")
    .filter(Boolean)
    .every((term) => {
      const separator = term.indexOf("=");
      assert.ok(separator > 0, "the peer only accepts the equality selectors used by these paths");
      return object.metadata.labels?.[term.slice(0, separator)] === term.slice(separator + 1);
    });

// Only the SDK boundary is controlled. Reads return detached supplied Kubernetes
// objects, apply returns an observed object, and delete enforces its UID predicate.
// Status is an independently supplied observation; this is not an API server or
// a simulation of scheduling, reconciliation, storage release or physical stop.
function kubernetesPeer(resources) {
  const objects = new Map(
    resources.map((object) => [
      key(object.kind, object.metadata.namespace, object.metadata.name),
      clone(object),
    ]),
  );
  const calls = [];
  let version = 100;
  let created = 0;
  const record = (method, request, extraArguments) => {
    const call = { method, request: clone(request) };
    if (extraArguments !== undefined) call.extraArguments = clone(extraArguments);
    calls.push(call);
    return call;
  };
  const read = (kind, request) => {
    const object = objects.get(key(kind, request.namespace, request.name));
    if (object === undefined) throw apiError(404);
    return clone(object);
  };
  const apply = (kind, request) => {
    assert.equal(request.body.kind, kind);
    assert.equal(request.body.metadata.name, request.name);
    assert.equal(request.body.metadata.namespace, request.namespace);
    assert.equal(request.fieldManager, "openclaw-enterprise-compute");
    assert.equal(request.force, false);
    const id = key(kind, request.namespace, request.name);
    const previous = objects.get(id);
    const body = clone(request.body);
    const object = {
      ...previous,
      ...body,
      metadata: {
        ...previous?.metadata,
        ...body.metadata,
        labels: { ...previous?.metadata.labels, ...body.metadata.labels },
        annotations: { ...previous?.metadata.annotations, ...body.metadata.annotations },
        uid: previous?.metadata.uid ?? `controlled-${kind}-${++created}`,
        resourceVersion: String(++version),
      },
    };
    objects.set(id, object);
    return clone(object);
  };
  const remove = (kind, request) => {
    const observed = read(kind, request);
    const uid = request.body?.preconditions?.uid;
    assert.equal(typeof uid, "string", "destructive requests must carry the observed UID");
    if (uid !== observed.metadata.uid) throw apiError(409);
    objects.delete(key(kind, request.namespace, request.name));
    return {
      apiVersion: "v1",
      kind: "Status",
      status: "Success",
      details: { name: request.name, uid: observed.metadata.uid },
    };
  };
  const clients = { core: {}, apps: {}, networking: {}, discovery: {}, objects: {} };
  for (const [group, kinds] of [
    ["core", ["Namespace", "Service", "ServiceAccount", "PersistentVolumeClaim"]],
    ["apps", ["Deployment"]],
    ["networking", ["NetworkPolicy"]],
  ]) {
    for (const kind of kinds) {
      const suffix = kind === "Namespace" ? kind : `Namespaced${kind}`;
      for (const [verb, operation] of [
        ["read", read],
        ["patch", apply],
        ["delete", remove],
      ]) {
        const method = `${verb}${suffix}`;
        clients[group][method] = async (request) => {
          const call = record(method, request);
          const result = operation(kind, request);
          if (verb === "read") call.observedUid = result.metadata.uid;
          return result;
        };
      }
    }
  }
  clients.core.listNamespace = async (request) => {
    record("listNamespace", request);
    return {
      apiVersion: "v1",
      kind: "NamespaceList",
      metadata: { resourceVersion: String(version) },
      items: [...objects.values()]
        .filter(
          (object) => object.kind === "Namespace" && matchingLabels(object, request.labelSelector),
        )
        .map(clone),
    };
  };
  clients.discovery.listNamespacedEndpointSlice = async (request) => {
    record("listNamespacedEndpointSlice", request);
    return {
      apiVersion: "discovery.k8s.io/v1",
      kind: "EndpointSliceList",
      metadata: { resourceVersion: String(version) },
      items: observations.endpointSlices.items
        .filter(
          (object) =>
            object.metadata.namespace === request.namespace &&
            matchingLabels(object, request.labelSelector),
        )
        .map(clone),
    };
  };
  clients.objects.read = async (spec) => {
    const call = record("readHTTPRoute", spec);
    assert.equal(spec.apiVersion, "gateway.networking.k8s.io/v1");
    assert.equal(spec.kind, "HTTPRoute");
    const result = read(spec.kind, spec.metadata);
    call.observedUid = result.metadata.uid;
    return result;
  };
  clients.objects.patch = async (body, pretty, dryRun, fieldManager, force, contentType) => {
    record("patchHTTPRoute", body, [pretty, dryRun, fieldManager, force, contentType]);
    assert.equal(contentType, "application/apply-patch+yaml");
    return apply("HTTPRoute", { ...body.metadata, body, fieldManager, force });
  };
  clients.objects.delete = async (spec, ...extraArguments) => {
    record("deleteHTTPRoute", spec, extraArguments);
    assert.equal(spec.apiVersion, "gateway.networking.k8s.io/v1");
    assert.equal(spec.kind, "HTTPRoute");
    assert.equal(extraArguments.length, 6);
    assert.deepEqual(extraArguments.slice(0, 5), [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    return remove("HTTPRoute", { ...spec.metadata, body: extraArguments[5] });
  };
  return {
    clients,
    calls,
    snapshot(kind, name, namespace) {
      const observed = objects.get(key(kind, namespace, name));
      return observed === undefined ? undefined : clone(observed);
    },
  };
}

function observed(resources, kind, prefix) {
  const found = resources.find(
    (object) => object.kind === kind && object.metadata.name.startsWith(prefix),
  );
  assert.ok(found, `required ${kind} observation ${prefix}`);
  return clone(found);
}
function fixture({ resources = observations.resources, routing = false } = {}) {
  const options = clone(inputs.options);
  if (!routing) {
    options.network.gatewayClients = [
      {
        namespace: "lifecycle-gateway-clients",
        podLabels: { "app.kubernetes.io/name": "lifecycle-gateway-client" },
      },
    ];
    delete options.gatewayRouting;
  }
  const selected = resources.filter((object) => routing || object.kind !== "HTTPRoute");
  const peer = kubernetesPeer(selected);
  const driver = new KubernetesComputeDriver(options, {
    id: inputs.revision.compute.id,
    implementation: inputs.revision.compute.implementation,
  });
  // Replace only the selected SDK clients; every lifecycle/ownership/readiness
  // decision below remains an actual public Driver path and its collaborators.
  driver.apiClients = Promise.resolve(peer.clients);
  const namespace = observed(selected, "Namespace", "oce-").metadata.name;
  return { driver, peer, namespace, options, revision: clone(inputs.revision) };
}
const mutations = (peer) => peer.calls.filter(({ method }) => /^(patch|delete)/.test(method));
const callsFor = (peer, method) => peer.calls.filter((call) => call.method === method);

test("public withdrawal inactivates the current Service and preserves its successor", async () => {
  const current = fixture();
  const service = observed(observations.resources, "Service", "agent-");
  await current.driver.deactivateRevision(current.revision);
  const patches = callsFor(current.peer, "patchNamespacedService");
  assert.equal(patches.length, 1);
  assert.equal(patches[0].request.name, service.metadata.name);
  assert.equal(patches[0].request.namespace, current.namespace);
  assert.deepEqual(patches[0].request.body.spec.selector, {
    "app.kubernetes.io/name": `${service.metadata.name}-inactive`,
  });
  const withdrawn = current.peer.snapshot("Service", service.metadata.name, current.namespace);
  assert.equal(withdrawn.metadata.uid, service.metadata.uid);
  assert.deepEqual(withdrawn.spec.selector, patches[0].request.body.spec.selector);

  const stale = fixture({ resources: observations.successorResources });
  const successor = observed(observations.successorResources, "Service", "agent-");
  assert.equal(successor.spec.selector["openclaw.dev/revision"], inputs.successor.id);
  await stale.driver.deactivateRevision(stale.revision);
  assert.deepEqual(mutations(stale.peer), []);
  assert.ok(
    callsFor(stale.peer, "readNamespacedService").some(
      (call) =>
        call.request.name === successor.metadata.name &&
        call.observedUid === successor.metadata.uid,
    ),
  );
  assert.deepEqual(
    stale.peer.snapshot("Service", successor.metadata.name, stale.namespace),
    successor,
  );
});

test("public runtime retirement uses the private PVC UID and preserves successors", async () => {
  const resources = clone(observations.resources);
  const privateClaim = resources.find(
    (object) =>
      object.kind === "PersistentVolumeClaim" && object.metadata.name.startsWith("gateway-state-"),
  );
  assert.ok(privateClaim);
  privateClaim.metadata.uid = "private-current-observed-uid";
  privateClaim.metadata.resourceVersion = "151";
  const current = fixture({ resources });
  assert.ok(current.options.runtime, "the private-state retirement branch must be enabled");
  await current.driver.retireRevision(current.revision);
  const deleted = callsFor(current.peer, "deleteNamespacedPersistentVolumeClaim").find(
    ({ request }) => request.name === privateClaim.metadata.name,
  );
  assert.ok(deleted);
  assert.deepEqual(deleted.request, {
    name: privateClaim.metadata.name,
    namespace: current.namespace,
    body: { preconditions: { uid: privateClaim.metadata.uid } },
  });
  const reads = callsFor(current.peer, "readNamespacedPersistentVolumeClaim").filter(
    ({ request }) => request.name === privateClaim.metadata.name,
  );
  assert.equal(reads.at(-1).observedUid, privateClaim.metadata.uid);
  assert.ok(current.peer.calls.indexOf(reads.at(-1)) < current.peer.calls.indexOf(deleted));
  assert.equal(
    current.peer.snapshot("PersistentVolumeClaim", privateClaim.metadata.name, current.namespace),
    undefined,
  );

  const successorResources = clone(observations.successorResources);
  const successorClaim = successorResources.find(
    (object) =>
      object.kind === "PersistentVolumeClaim" &&
      object.metadata.name === privateClaim.metadata.name,
  );
  assert.ok(successorClaim);
  successorClaim.metadata.uid = "private-successor-observed-uid";
  successorClaim.metadata.resourceVersion = "209";
  const stale = fixture({ resources: successorResources });
  const gateway = observed(successorResources, "Deployment", "gateway-");
  assert.equal(gateway.metadata.annotations[revisionAnnotation], inputs.successor.id);
  await stale.driver.retireRevision(stale.revision);
  assert.deepEqual(callsFor(stale.peer, "deleteNamespacedPersistentVolumeClaim"), []);
  assert.ok(
    callsFor(stale.peer, "readNamespacedDeployment").some(
      (call) =>
        call.request.name === gateway.metadata.name && call.observedUid === gateway.metadata.uid,
    ),
  );
  assert.deepEqual(
    stale.peer.snapshot("PersistentVolumeClaim", successorClaim.metadata.name, stale.namespace),
    successorClaim,
  );
  assert.deepEqual(
    stale.peer.snapshot("Deployment", gateway.metadata.name, stale.namespace),
    gateway,
  );
});

test("public activation and retirement use route UIDs and preserve successors", async () => {
  const current = fixture({
    resources: observations.resources.filter((object) => object.kind !== "HTTPRoute"),
    routing: true,
  });
  const gatewayService = observed(observations.resources, "Service", "gateway-");
  await current.driver.activateRevision(current.revision);
  const applied = callsFor(current.peer, "patchHTTPRoute");
  assert.equal(applied.length, 1);
  const desired = applied[0].request;
  assert.equal(desired.metadata.name, gatewayService.metadata.name);
  assert.equal(desired.metadata.annotations[revisionAnnotation], current.revision.id);
  assert.deepEqual(desired.spec.hostnames, [current.options.gatewayRouting.hostname]);
  assert.equal(desired.spec.parentRefs[0].name, current.options.gatewayRouting.gatewayName);
  assert.equal(
    desired.spec.parentRefs[0].namespace,
    current.options.gatewayRouting.gatewayNamespace,
  );
  assert.equal(desired.spec.rules[0].backendRefs[0].name, gatewayService.metadata.name);
  assert.equal(desired.metadata.ownerReferences[0].uid, gatewayService.metadata.uid);
  const route = current.peer.snapshot("HTTPRoute", desired.metadata.name, current.namespace);
  assert.ok(route);
  assert.notEqual(route.metadata.uid, gatewayService.metadata.uid);
  const agentService = observed(observations.resources, "Service", "agent-");
  const activeService = current.peer.snapshot(
    "Service",
    agentService.metadata.name,
    current.namespace,
  );
  assert.equal(activeService.spec.selector["openclaw.dev/revision"], current.revision.id);

  await current.driver.retireRevision(current.revision);
  const removed = callsFor(current.peer, "deleteHTTPRoute");
  assert.equal(removed.length, 1);
  assert.deepEqual(removed[0].request, {
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRoute",
    metadata: { name: route.metadata.name, namespace: current.namespace },
  });
  assert.deepEqual(removed[0].extraArguments, [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { preconditions: { uid: route.metadata.uid } },
  ]);
  const reads = callsFor(current.peer, "readHTTPRoute").filter(
    (call) => call.observedUid === route.metadata.uid,
  );
  assert.ok(reads.length > 0);
  assert.ok(current.peer.calls.indexOf(reads.at(-1)) < current.peer.calls.indexOf(removed[0]));
  assert.equal(
    current.peer.snapshot("HTTPRoute", route.metadata.name, current.namespace),
    undefined,
  );

  // Removing only the gateway observation reaches the route's own revision guard,
  // rather than stopping at the earlier Deployment successor check.
  const successorResources = observations.successorResources.filter(
    (object) => !(object.kind === "Deployment" && object.metadata.name.startsWith("gateway-")),
  );
  const stale = fixture({ resources: successorResources, routing: true });
  const successorRoute = observed(successorResources, "HTTPRoute", "gateway-");
  assert.equal(successorRoute.metadata.annotations[revisionAnnotation], inputs.successor.id);
  const successorClaim = observed(successorResources, "PersistentVolumeClaim", "gateway-state-");
  await stale.driver.retireRevision(stale.revision);
  assert.deepEqual(callsFor(stale.peer, "deleteHTTPRoute"), []);
  assert.deepEqual(callsFor(stale.peer, "deleteNamespacedPersistentVolumeClaim"), []);
  assert.ok(
    callsFor(stale.peer, "readHTTPRoute").some(
      (call) =>
        call.request.metadata.name === successorRoute.metadata.name &&
        call.observedUid === successorRoute.metadata.uid,
    ),
  );
  assert.deepEqual(
    stale.peer.snapshot("HTTPRoute", successorRoute.metadata.name, stale.namespace),
    successorRoute,
  );
  assert.deepEqual(
    stale.peer.snapshot("PersistentVolumeClaim", successorClaim.metadata.name, stale.namespace),
    successorClaim,
  );
});
