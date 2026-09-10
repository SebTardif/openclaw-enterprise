import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createNodeExecutionClient } from "../../apps/controller/src/drivers/compute/kubernetes/node-execution-client.ts";

const binaryPath = process.env.OCC_NODE_OBSERVER_TEST_BINARY;

// These explicit absent paths cannot qualify a node or issue a positive source
// record. The selected actual native executable must refuse before CRI/API work.
function configuration(binaryDigest) {
  return {
    binaryPath,
    binaryDigest,
    clientConfiguration: {
      enrollment: {
        schemaVersion: 1,
        sourceRef: "source/node-test",
        version: 1,
        clusterRef: "cluster/test",
        nodeName: "test-node",
        nodeUID: "node-uid",
        namespace: "test",
        workloadSocket: "/unavailable-node-observer/workload.sock",
        ownSPIFFEID: "spiffe://test.example/node-observer",
        peerSPIFFEID: "spiffe://test.example/controller",
        trustBundleDigest: `sha256:${"1".repeat(64)}`,
        address: "127.0.0.1:1",
        criPath: "/unavailable-node-observer/cri.sock",
        runtimeRoot: "/unavailable-node-observer/runtime",
        runscPath: "/unavailable-node-observer/runsc",
        runscDigest: `sha256:${"2".repeat(64)}`,
        sentryDigest: `sha256:${"3".repeat(64)}`,
        kubernetesURL: "https://127.0.0.1:1",
        kubernetesCAPath: "/unavailable-node-observer/ca",
        kubernetesTokenPath: "/unavailable-node-observer/token",
      },
      workloadSocket: "/unavailable-node-observer/client.sock",
      enrollmentDigest: `sha256:${"4".repeat(64)}`,
    },
  };
}

test(
  "actual node client refuses missing source and joins its native child",
  { skip: binaryPath ? false : "Select the actual protected oce-node-observer executable." },
  async () => {
    const binaryDigest = `sha256:${createHash("sha256")
      .update(await readFile(binaryPath))
      .digest("hex")}`;
    const client = createNodeExecutionClient(configuration(binaryDigest));
    await assert.rejects(
      client.capture({
        requestRef: "request/physical",
        podName: "harness",
        podUID: "pod-uid",
        deadline: new Date(Date.now() + 4000).toISOString(),
        signal: new AbortController().signal,
      }),
    );
    // A physical-record-shaped value does not possess the original child/TLS
    // handle, even after a real invocation has failed and finished cleanup.
    assert.throws(() => client.inspect(Object.freeze({ kind: "node-physical-execution" })));
    await assert.rejects(client.close(Object.freeze({ kind: "node-physical-execution" })));
  },
);

test("physical client refuses cancellation and excessive lifetime before native startup", async () => {
  const client = createNodeExecutionClient(configuration(`sha256:${"0".repeat(64)}`));
  const input = {
    requestRef: "request/physical",
    podName: "harness",
    podUID: "pod-uid",
    deadline: new Date(Date.now() + 1000).toISOString(),
    signal: AbortSignal.abort(),
  };
  await assert.rejects(client.capture(input));
  await assert.rejects(
    client.capture({
      ...input,
      deadline: new Date(Date.now() + 60_000).toISOString(),
      signal: new AbortController().signal,
    }),
  );
});

test(
  "actual native invocation snapshots caller-owned executable and request inputs",
  { skip: binaryPath ? false : "Select the actual protected oce-node-observer executable." },
  async () => {
    const binaryDigest = `sha256:${createHash("sha256")
      .update(await readFile(binaryPath))
      .digest("hex")}`;
    const options = configuration(binaryDigest);
    const reads = new Map();
    const snapshotOnce = (object, key) => {
      const value = object[key];
      Object.defineProperty(object, key, {
        get() {
          const count = (reads.get(key) ?? 0) + 1;
          reads.set(key, count);
          // Mutating a caller's input after its first synchronous read must
          // never change the executable/request subsequently used across await.
          return count === 1 ? value : undefined;
        },
      });
    };
    for (const key of ["binaryPath", "binaryDigest"]) snapshotOnce(options, key);
    const client = createNodeExecutionClient(options);
    const input = {
      requestRef: "request/snapshot",
      podName: "harness",
      podUID: "pod-uid",
      deadline: new Date(Date.now() + 4000).toISOString(),
      signal: new AbortController().signal,
    };
    for (const key of Object.keys(input)) snapshotOnce(input, key);
    await assert.rejects(client.capture(input));
    for (const [key, count] of reads) assert.equal(count, 1, `${key} was read again`);
  },
);

test("network client rejects copied handles and invalid selectors before native entry", async () => {
  const client = createNodeExecutionClient(configuration(`sha256:${"0".repeat(64)}`));
  const input = {
    requestRef: "network-request",
    podName: "harness",
    podUID: "pod-uid",
    deadline: new Date(Date.now() + 1000).toISOString(),
    signal: new AbortController().signal,
    networkName: "../other",
    interfaceName: "eth0",
  };
  await assert.rejects(client.captureNetwork(input));
  await assert.rejects(
    client.captureNetwork({ ...input, networkName: "pods", interfaceName: "eth0/../other" }),
  );
  await assert.rejects(
    client.captureNetwork({ ...input, networkName: "pods", signal: AbortSignal.abort() }),
  );
  assert.throws(() => client.inspectNetwork(Object.freeze({ kind: "node-physical-network" })));
  assert.throws(() => client.inspect(Object.freeze({ kind: "node-physical-network" })));
  await assert.rejects(client.close(Object.freeze({ kind: "node-physical-network" })));
});

test(
  "actual network invocation refuses absent enrollment and joins its native child",
  { skip: binaryPath ? false : "Select the actual protected oce-node-observer executable." },
  async () => {
    const binaryDigest = `sha256:${createHash("sha256")
      .update(await readFile(binaryPath))
      .digest("hex")}`;
    const client = createNodeExecutionClient(configuration(binaryDigest));
    await assert.rejects(
      client.captureNetwork({
        requestRef: "network-absent-source",
        podName: "harness",
        podUID: "pod-uid",
        deadline: new Date(Date.now() + 4000).toISOString(),
        signal: new AbortController().signal,
        networkName: "pods",
        interfaceName: "eth0",
      }),
    );
  },
);

const networkInput = process.env.OCC_NODE_OBSERVER_NETWORK_INPUT;
test(
  "actual retained CNI attachment stays bound to its node capture and closes joined inspections",
  {
    skip:
      binaryPath && networkInput
        ? false
        : "Select an actual node observer and disposable original CNI ADD/CRI/SPIRE fixture.",
  },
  async () => {
    // This external fixture supplies deployment configuration and expected CRI
    // facts, not a substitute OCE observer, attachment daemon, record, or grant.
    const fixture = JSON.parse(await readFile(networkInput, "utf8"));
    const binaryDigest = `sha256:${createHash("sha256")
      .update(await readFile(binaryPath))
      .digest("hex")}`;
    const client = createNodeExecutionClient({
      binaryPath,
      binaryDigest,
      clientConfiguration: fixture.clientConfiguration,
    });
    const lifetime = new AbortController();
    const input = {
      requestRef: "network-composed-original",
      podName: fixture.podName,
      podUID: fixture.podUID,
      networkName: fixture.networkName,
      interfaceName: fixture.interfaceName,
      deadline: new Date(Date.now() + 9000).toISOString(),
      signal: lifetime.signal,
    };
    const handle = await client.captureNetwork(input);
    try {
      const first = await client.inspectNetwork(handle);
      const again = await client.inspectNetwork(handle);
      assert.deepEqual(again, first);
      assert.equal(first.execution.physical.sandboxID, fixture.sandboxID);
      assert.equal(first.execution.physical.sandboxCreatedAt, fixture.sandboxCreatedAt);
      assert.equal(first.execution.physical.sandboxAttempt, fixture.sandboxAttempt);
      assert.equal(first.execution.physical.podUID, fixture.podUID);
      assert.equal(first.execution.physical.nodeUID, fixture.nodeUID);
      assert.equal(first.execution.physical.bootID, fixture.bootID);
      assert.equal(first.attachment.serviceInstance, fixture.serviceInstance);
      assert.equal(first.attachment.operationRef, fixture.operationRef);
      assert.equal(
        first.attachment.recordDigest,
        `sha256:${createHash("sha256").update(first.attachment.recordJSON).digest("hex")}`,
      );
      assert.throws(() => client.inspectNetwork({ ...handle }));
      assert.throws(() => client.inspect(handle));
      const pending = client.inspectNetwork(handle);
      lifetime.abort();
      await assert.rejects(pending);
      await client.close(handle);
      await assert.rejects(client.inspectNetwork(handle));
    } finally {
      lifetime.abort();
      await client.close(handle);
    }
    // Closing a read is not CNI DEL. A fresh authenticated read may see that
    // same original ADD, but cannot adopt an unrelated Pod as its execution.
    await assert.rejects(
      client.captureNetwork({
        ...input,
        podUID: `${fixture.podUID}-other`,
        deadline: new Date(Date.now() + 4000).toISOString(),
        signal: new AbortController().signal,
      }),
    );
  },
);
