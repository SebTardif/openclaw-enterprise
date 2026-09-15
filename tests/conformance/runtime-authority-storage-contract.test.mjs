import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { seedAuthority } from "../fixtures/runtime-authority-state/seed.mjs";
import {
  parseRuntimeAuthorityV1,
  parseRuntimeAuthorityJsonV1,
  canonicalRuntimeAuthorityMutationV1,
} from "../../packages/contracts/src/runtime-authority-v1.ts";
import { bindRequest } from "../fixtures/runtime-authority-v1/vectors.mjs";

test("storage mutation decoding snapshots closed immutable data without invoking caller code", () => {
  for (const input of [bindRequest()]) {
    const decoded = parseRuntimeAuthorityV1("mutation", input);
    assert.deepEqual(JSON.parse(JSON.stringify(decoded)), input);
    assert.ok(Object.isFrozen(decoded.target));
    assert.throws(() => parseRuntimeAuthorityV1("mutation", { ...input, unexpected: true }));
    const accessor = { ...input };
    Object.defineProperty(accessor, "target", {
      enumerable: true,
      get() {
        assert.fail("getter invoked");
      },
    });
    assert.throws(() => parseRuntimeAuthorityV1("mutation", accessor), /Invalid runtime authority/);
    input.target.agentId = "changed";
    assert.notEqual(decoded.target.agentId, input.target.agentId);
  }
});

test("canonical operation identity excludes only request correlation and rejects ambiguous JSON", () => {
  const input = bindRequest();
  const canonical = canonicalRuntimeAuthorityMutationV1(input);
  assert.equal(
    canonicalRuntimeAuthorityMutationV1({ ...input, requestRef: "request/new" }),
    canonical,
  );
  assert.notEqual(
    canonicalRuntimeAuthorityMutationV1({ ...input, expectedAssignmentRecordVersion: 2 }),
    canonical,
  );
  const json = JSON.stringify(input);
  for (const invalid of [
    json.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    json.replace(
      '"expectedAssignmentRecordVersion":1',
      '"expectedAssignmentRecordVersion":1.00000000000000001',
    ),
    json.replace('"expectedAssignmentRecordVersion":1', '"expectedAssignmentRecordVersion":1e0'),
  ])
    assert.throws(() => parseRuntimeAuthorityJsonV1("mutation", invalid));
});

test("initial binding preserves finite observation windows and real calendar dates", () => {
  const original = bindRequest();
  for (const mutate of [
    (x) => {
      x.target.component = "gateway";
    },
    (x) => {
      x.expectedLifecycleGeneration = 2;
    },
    (x) => {
      x.observation.validUntil = "2026-01-01T00:00:16.000Z";
    },
    ...["sourceObservedAt", "receivedAt", "validUntil"].map((field) => (x) => {
      x.observation[field] = "2026-02-30T00:00:00.000Z";
    }),
  ]) {
    const input = structuredClone(original);
    mutate(input);
    assert.throws(() => parseRuntimeAuthorityV1("mutation", input));
  }
  for (const validUntil of [original.observation.sourceObservedAt, "2026-01-01T00:00:15.000Z"]) {
    assert.doesNotThrow(() =>
      parseRuntimeAuthorityV1("mutation", {
        ...original,
        observation: { ...original.observation, validUntil },
      }),
    );
  }
});

test("nested persisted bindings retain image and assignment consistency checks", async () => {
  const f = await seedAuthority(new InMemoryPlatformState());
  const result = await f.append(f.bind);
  // Exercise the readback contract envelope with a real stored receipt; no service route exists.
  const operation = {
    schemaVersion: 1,
    result: "committed",
    receipt: (await f.operation(f.bind.operationRef)).receipt,
  };
  const record = await f.record();
  for (const [kind, original, bindingOf] of [
    ["mutationResult", result, (x) => x.receipt.outcome.binding],
    ["operationState", operation, (x) => x.receipt.outcome.binding],
    ["assignmentRecord", record, (x) => x.binding.instance],
  ]) {
    assert.doesNotThrow(() => parseRuntimeAuthorityV1(kind, original));
    for (const names of [
      ["harness", "harness"],
      ["z-image", "a-image"],
    ]) {
      const invalid = structuredClone(original);
      const binding = bindingOf(invalid);
      binding.imageDigests = names.map((name) => ({ ...binding.imageDigests[0], name }));
      assert.throws(() => parseRuntimeAuthorityV1(kind, invalid), /binding image names must be/);
    }
  }
  for (const mutate of [
    (x) => {
      x.allocation.component = "gateway";
    },
    (x) => {
      x.authority.state = "allocated";
    },
    (x) => {
      x.binding = { status: "unbound" };
    },
  ]) {
    const invalid = structuredClone(record);
    mutate(invalid);
    assert.throws(() => parseRuntimeAuthorityV1("assignmentRecord", invalid));
  }
});

test("decoding errors explain the failed rule without echoing caller data", () => {
  const marker = "private-observation-reference";
  const malformed = bindRequest();
  malformed.binding.imageDigests = [
    { ...malformed.binding.imageDigests[0], name: marker },
    { ...malformed.binding.imageDigests[0], name: marker },
  ];
  for (const [input, reason] of [
    [malformed, /binding image names must be unique/],
    [{ ...bindRequest(), unexpected: marker }, /does not match the mutation schema/],
  ])
    assert.throws(
      () => parseRuntimeAuthorityV1("mutation", input),
      (error) => {
        assert.match(error.message, reason);
        assert.ok(!error.message.includes(marker));
        return true;
      },
    );
});
