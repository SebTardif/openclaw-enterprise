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
