import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  decodeRuntimeProfileWorkV1,
  encodeRuntimeProfileWorkV1,
  parseRuntimeProfileWorkV1,
} from "../../packages/occ/src/lifecycle/runtime-profile-work-v1.ts";

const work = () => ({
  schemaVersion: 3,
  handler: "ReconcileRuntimeProfileV1",
  installationId: `ins_${randomUUID()}`,
  namespaceId: `ns_${randomUUID()}`,
  agentId: `agt_${randomUUID()}`,
  intentRef: randomUUID(),
  lifecycleGeneration: 1,
  operationRef: randomUUID(),
  invalidationRef: randomUUID(),
  admissionRef: randomUUID(),
  previousVersion: 1,
  currentVersion: 2,
  responsibilityRef: randomUUID(),
  responsibilityVersion: 1,
  requestedFenceEpoch: 2,
  gateVersion: 2,
  workId: `runtime-profile:${randomUUID()}`,
});

test("runtime profile work retains original invalidation, intent and responsibility", () => {
  const value = work();
  assert.deepEqual(decodeRuntimeProfileWorkV1(encodeRuntimeProfileWorkV1(value)), value);
  assert.notEqual(value.operationRef, value.intentRef);
  assert.throws(() =>
    parseRuntimeProfileWorkV1({ ...value, handler: "ReconcileAgentLifecycleV1" }),
  );
  assert.throws(() => parseRuntimeProfileWorkV1({ ...value, actorId: "historical-human" }));
});

test("runtime profile work rejects ambiguous wire and active property access", () => {
  const value = work();
  const encoded = encodeRuntimeProfileWorkV1(value);
  assert.throws(() =>
    decodeRuntimeProfileWorkV1(
      encoded.replace('"schemaVersion":3', '"schemaVersion":3,"schemaVersion":3'),
    ),
  );
  assert.throws(() =>
    decodeRuntimeProfileWorkV1(
      encoded.replace('"lifecycleGeneration":1', '"lifecycleGeneration":1.00000000000000001'),
    ),
  );
  assert.throws(() => parseRuntimeProfileWorkV1({ ...value, agentId: `${value.agentId}\n` }));
  let touched = false;
  const getter = { ...value };
  Object.defineProperty(getter, "operationRef", {
    enumerable: true,
    get() {
      touched = true;
      throw new Error();
    },
  });
  assert.throws(() => parseRuntimeProfileWorkV1(getter));
  assert.equal(touched, false);
  assert.throws(() => parseRuntimeProfileWorkV1(new Proxy(value, {})));
});
