import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  decodeRuntimeFaultWorkV1,
  encodeRuntimeFaultWorkV1,
  parseRuntimeFaultWorkV1,
} from "../../packages/occ/src/lifecycle/runtime-fault-work-v1.ts";

const work = () => ({
  schemaVersion: 2,
  handler: "ReconcileRuntimeFaultV1",
  installationId: `ins_${randomUUID()}`,
  namespaceId: `ns_${randomUUID()}`,
  agentId: `agt_${randomUUID()}`,
  intentRef: randomUUID(),
  lifecycleGeneration: 1,
  operationRef: randomUUID(),
  requestDigest: `sha256:${"a".repeat(64)}`,
  responsibilityRef: randomUUID(),
  responsibilityVersion: 1,
  requestedFenceEpoch: 2,
  gateVersion: 2,
  workId: `runtime-fault:${randomUUID()}`,
});

test("runtime fault work retains independent fault, intent, responsibility and exact digest", () => {
  const value = work();
  assert.deepEqual(decodeRuntimeFaultWorkV1(encodeRuntimeFaultWorkV1(value)), value);
  assert.notEqual(value.operationRef, value.intentRef);
  assert.throws(() => parseRuntimeFaultWorkV1({ ...value, handler: "ReconcileAgentLifecycleV1" }));
  assert.throws(() => parseRuntimeFaultWorkV1({ ...value, actorId: "historical-human" }));
});

test("runtime fault work rejects ambiguous wire and active property access", () => {
  const value = work();
  const encoded = encodeRuntimeFaultWorkV1(value);
  assert.throws(() =>
    decodeRuntimeFaultWorkV1(
      encoded.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2'),
    ),
  );
  assert.throws(() =>
    decodeRuntimeFaultWorkV1(
      encoded.replace('"lifecycleGeneration":1', '"lifecycleGeneration":1.00000000000000001'),
    ),
  );
  assert.throws(() => parseRuntimeFaultWorkV1({ ...value, agentId: `${value.agentId}\n` }));
  let touched = false;
  const getter = { ...value };
  Object.defineProperty(getter, "operationRef", {
    enumerable: true,
    get() {
      touched = true;
      throw new Error();
    },
  });
  assert.throws(() => parseRuntimeFaultWorkV1(getter));
  assert.equal(touched, false);
  assert.throws(() => parseRuntimeFaultWorkV1(new Proxy(value, {})));
});
