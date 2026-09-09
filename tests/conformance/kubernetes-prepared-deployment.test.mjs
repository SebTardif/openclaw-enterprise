import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { canonicalRuntimeEffectRequestV1 } from "../../packages/contracts/src/runtime-effects-v1.ts";
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
    );
    assert.equal(calls, 1);
    assert.equal(
      result.uid,
      action === "reserve-inert" ? "actual-returned-uid" : f.child.predicate.uid,
    );
    assert.equal(result.resourceVersion, "actual-rv/000008");
    assert.equal(new Date(result.receivedAt).toISOString(), result.receivedAt);
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
    prepareKubernetesDeploymentRequest(f.child, f.wire, f.namespace).submit(apps),
  );
  assert.equal(calls, 1);
});
test("response target mismatch cannot become an original receipt", async (t) => {
  const f = fixture();
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
    prepareKubernetesDeploymentRequest(f.child, f.wire, f.namespace).submit(apps),
  );
  assert.equal(calls, 1);
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
