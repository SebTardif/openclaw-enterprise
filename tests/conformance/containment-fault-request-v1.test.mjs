import assert from "node:assert/strict";
import test from "node:test";
import { ContainmentFaultRequestAdapterV1 } from "@openclaw-enterprise/occ/containment/fault-request-adapter-v1";
import {
  canonicalRuntimeFaultRequestV1,
  parseRuntimeEffectsResponseV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import { sha256Hex } from "@openclaw-enterprise/utils";
import * as v from "../fixtures/containment-evidence-v1/fault-values.mjs";
import { evidence as runtimeEvidence } from "../fixtures/runtime-authority-v1/vectors.mjs";

// Exercise the actual adapter using original contract values and a controlled
// port. These are source conformance tests, not provider/database/runtime proof.
function setup(behavior = {}) {
  const clock = new v.Clock();
  const calls = [];
  const sink = {
    recordFaultAndRequestStop(input, call) {
      calls.push({ method: "submit", input, call });
      return behavior.submit?.(input, call) ?? Promise.resolve(v.receipt(input));
    },
    readRequest(input, call) {
      calls.push({ method: "readback", input, call });
      return (
        behavior.readback?.(input, call) ?? Promise.resolve(v.unresolved({ operation: input }))
      );
    },
  };
  const adapter = new ContainmentFaultRequestAdapterV1({ sink, clock: clock.port });
  const fault = v.fault();
  const preparation = adapter.prepare(fault, v.expected(fault));
  assert.equal(preparation.status, "prepared");
  return { adapter, clock, calls, sink, fault, continuation: preparation.continuation };
}
function denied(result) {
  assert.equal(result.scope, "fault-request-adapter-only");
  assert.equal(result.admission, "denied");
  assert.equal(result.downstreamStop, "not-proved");
  assert(Object.isFrozen(result));
}
function resign(fault) {
  fault.operation.requestDigest = `sha256:${sha256Hex(canonicalRuntimeFaultRequestV1(fault))}`;
  return fault;
}

test("accepted original durable closure preserves denial and never proves physical stop", async () => {
  const s = setup();
  const result = await s.adapter.submit(s.continuation, v.call(s.clock));
  denied(result);
  assert.equal(result.status, "accepted");
  assert.equal(result.result.receipt.admission, "durably-closed");
  assert.equal(result.result.receipt.downstreamStop, "not-proved");
  assert.equal(result.continuation.phase, "resolved");
  assert.equal(s.calls.length, 1);
  assert.equal(s.clock.timers.size, 0);
  assert.equal(
    (await s.adapter.submit(result.continuation, v.call(s.clock))).reason,
    "already-resolved",
  );
  assert.equal(s.calls.length, 1);
});

test("missing original fault reports unavailable without creating an obligation", () => {
  const s = setup();
  for (const absent of [null, undefined]) {
    const result = s.adapter.prepare(absent, v.expected(s.fault));
    denied(result);
    assert.equal(result.reason, "fault-input-unavailable");
    assert.equal("continuation" in result, false);
  }
  assert.equal(s.calls.length, 0);
});

for (const field of ["target", "guard", "cleanupResponsibility", "cause"]) {
  test(`original owner ${field} mismatch is rejected before any sink call`, () => {
    const s = setup();
    const expected = v.clone(v.expected(s.fault));
    if (field === "target")
      expected.target.createEffectRef = "00000000-0000-4000-8000-000000000999";
    if (field === "guard") expected.guard.gateVersion++;
    if (field === "cleanupResponsibility") expected.cleanupResponsibility.responsibilityVersion++;
    if (field === "cause") expected.cause.currentVersion++;
    assert.equal(s.adapter.prepare(s.fault, expected).status, "rejected");
    assert.equal(s.calls.length, 0);
  });
}

test("canonical digest mismatch and malformed fault never reach the sink", () => {
  const s = setup();
  const changed = v.clone(s.fault);
  changed.reasonCode = "evidence-stale";
  assert.equal(s.adapter.prepare(changed, v.expected(changed)).status, "rejected");
  changed.operation.requestDigest = "malformed";
  assert.equal(s.adapter.prepare(changed, v.expected(changed)).status, "rejected");
  const fake = { ...s.fault, verified: true };
  assert.equal(s.adapter.prepare(fake, v.expected(s.fault)).status, "rejected");
  assert.equal(s.calls.length, 0);
});

test("original runtime evidence retains exact execution and rejects a different expected binding", () => {
  const s = setup();
  const fault = v.clone(s.fault);
  const evidence = runtimeEvidence();
  evidence.target = v.clone(fault.target);
  fault.cause = { kind: "runtime-evidence", evidence };
  resign(fault);
  assert.equal(s.adapter.prepare(fault, v.expected(fault)).status, "prepared");
  const expected = v.clone(v.expected(fault));
  expected.cause.evidence.binding.podUid = "other-pod";
  assert.equal(s.adapter.prepare(fault, expected).status, "rejected");
  assert.equal(s.calls.length, 0);
});

test("forward original context, request, recipient and deadline with linked finite signal", async () => {
  const pending = v.deferred();
  const s = setup({ submit: () => pending.promise });
  const controller = new AbortController();
  const original = v.call(s.clock, controller);
  const outcome = s.adapter.submit(s.continuation, original);
  await v.settle();
  const forwarded = s.calls[0].call;
  for (const field of ["context", "requestRef", "recipientRef", "deadline"])
    assert.strictEqual(forwarded[field], original[field]);
  assert.notStrictEqual(forwarded.signal, original.signal);
  assert.equal(forwarded.signal.aborted, false);
  controller.abort();
  const result = await outcome;
  assert.equal(result.status, "commit-unknown");
  assert.equal(result.reason, "cancelled");
  assert.equal(forwarded.signal.aborted, true);
  assert.equal(result.continuation.phase, "readback-only");
  denied(result);
});

test("preabort performs zero calls and only same exact continuation remains submit-allowed", async () => {
  const s = setup();
  const controller = new AbortController();
  controller.abort();
  const result = await s.adapter.submit(s.continuation, v.call(s.clock, controller));
  denied(result);
  assert.equal(result.status, "not-invoked");
  assert.equal(result.reason, "cancelled");
  assert.equal(result.continuation.phase, "submit-allowed");
  assert.equal(s.calls.length, 0);
  assert.equal(result.continuation.canonicalRequestJson, s.continuation.canonicalRequestJson);
  const retry = await s.adapter.submit(result.continuation, v.call(s.clock));
  assert.equal(retry.status, "accepted");
  assert.equal(s.calls.length, 1);
  assert.equal(
    canonicalRuntimeFaultRequestV1(s.calls[0].input),
    s.continuation.canonicalRequestJson,
  );
});

test("cancellation in the scheduling gap remains conclusively not-invoked", async () => {
  const s = setup();
  const controller = new AbortController();
  const promise = s.adapter.submit(s.continuation, v.call(s.clock, controller));
  controller.abort();
  const result = await promise;
  assert.equal(result.status, "not-invoked");
  assert.equal(s.calls.length, 0);
});

for (const remaining of [0, -1]) {
  test(`expired original deadline (${remaining}) prevents invocation`, async () => {
    const s = setup();
    const result = await s.adapter.submit(s.continuation, v.call(s.clock, undefined, remaining));
    assert.equal(result.status, "not-invoked");
    assert.equal(result.reason, "deadline-exceeded");
    assert.equal(s.calls.length, 0);
  });
}

test("lost ACK permits only exact readback with fresh separately supplied original call", async () => {
  let retained;
  const s = setup({
    submit(input) {
      retained = input;
      throw new Error("synthetic acknowledgement loss");
    },
    readback() {
      return Promise.resolve(v.receipt(retained, "exact-replay"));
    },
  });
  const initial = await s.adapter.submit(s.continuation, v.call(s.clock));
  assert.equal(initial.status, "commit-unknown");
  assert.equal(initial.continuation.phase, "readback-only");
  assert.equal(
    (await s.adapter.submit(initial.continuation, v.call(s.clock))).reason,
    "readback-required",
  );
  assert.equal(s.calls.length, 1);
  const fresh = { ...v.call(s.clock), requestRef: "new-authorized-read" };
  const result = await s.adapter.readback(initial.continuation, fresh);
  denied(result);
  assert.equal(result.status, "exact-replay");
  assert.equal(result.continuation.canonicalRequestJson, s.continuation.canonicalRequestJson);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].method, "readback");
  assert.deepEqual(s.calls[1].input, retained.operation);
  assert.equal(s.calls[1].call.requestRef, fresh.requestRef);
});

test("readback requires full retained fault despite an exactly matching operation locator", async () => {
  let retained;
  const s = setup({
    submit(input) {
      retained = input;
      return Promise.resolve(v.unresolved(input));
    },
    readback() {
      const other = v.clone(retained);
      other.reasonCode = "evidence-stale";
      const wrong = v.receipt(other, "exact-replay");
      // The original readRequest parser deliberately correlates only its locator.
      parseRuntimeEffectsResponseV1("readRequest", retained.operation, wrong);
      return Promise.resolve(wrong);
    },
  });
  const initial = await s.adapter.submit(s.continuation, v.call(s.clock));
  const result = await s.adapter.readback(initial.continuation, v.call(s.clock));
  assert.equal(result.status, "commit-unknown");
  assert.equal(result.reason, "response-mismatch");
  assert.equal(result.continuation.phase, "readback-only");
  assert.equal(result.continuation.canonicalRequestJson, s.continuation.canonicalRequestJson);
});

for (const status of ["not-found", "unavailable", "commit-unknown", "conflict"]) {
  test(`original ${status} remains distinct and never authorizes resubmission`, async () => {
    const s = setup({
      submit(input) {
        return Promise.resolve(v.unresolved(input));
      },
      readback(operation) {
        return Promise.resolve(v.unresolved({ operation }, status));
      },
    });
    const initial = await s.adapter.submit(s.continuation, v.call(s.clock));
    const result = await s.adapter.readback(initial.continuation, v.call(s.clock));
    denied(result);
    assert.equal(result.status, status);
    assert.equal(result.continuation.phase, status === "conflict" ? "resolved" : "readback-only");
    assert.equal((await s.adapter.submit(result.continuation, v.call(s.clock))).status, "rejected");
    assert.equal(s.calls.length, 2);
  });
}

for (const remaining of [20_000, 750]) {
  test(`submit ceiling is min(10000, remaining ${remaining}) and ignores a late success`, async () => {
    const pending = v.deferred();
    const s = setup({ submit: () => pending.promise });
    const promise = s.adapter.submit(s.continuation, v.call(s.clock, undefined, remaining));
    await v.settle();
    const duration = Math.min(10_000, remaining);
    s.clock.advance(duration - 1);
    assert.equal(s.calls[0].call.signal.aborted, false);
    s.clock.advance(1);
    const result = await promise;
    assert.equal(result.status, "commit-unknown");
    assert.equal(result.reason, "deadline-exceeded");
    pending.resolve(v.receipt(s.calls[0].input));
    await v.settle();
    assert.equal(result.status, "commit-unknown");
    assert.equal(result.continuation.phase, "readback-only");
    assert.equal(s.clock.timers.size, 0);
    assert.equal(s.calls.length, 1);
  });
}

test("readback times out at original three-second ceiling and remains unresolved", async () => {
  const pending = v.deferred();
  const s = setup({
    submit: (input) => Promise.resolve(v.unresolved(input)),
    readback: () => pending.promise,
  });
  const initial = await s.adapter.submit(s.continuation, v.call(s.clock));
  const promise = s.adapter.readback(initial.continuation, v.call(s.clock));
  await v.settle();
  s.clock.advance(3_000);
  const result = await promise;
  assert.equal(result.status, "commit-unknown");
  assert.equal(result.continuation.phase, "readback-only");
  assert.equal(s.calls.length, 2);
});

for (const clockField of ["wall", "monotonic"]) {
  test(`${clockField} rollback after possible submission preserves unknown commit`, async () => {
    const pending = v.deferred();
    const s = setup({ submit: () => pending.promise });
    s.clock.monotonic = 10;
    const promise = s.adapter.submit(s.continuation, v.call(s.clock));
    await v.settle();
    s.clock[clockField]--;
    pending.resolve(v.receipt(s.calls[0].input));
    const result = await promise;
    assert.equal(result.status, "commit-unknown");
    assert.equal(result.reason, "clock-unavailable");
  });
}

test("mutable caller and sink values cannot rewrite the retained request or result", async () => {
  let response;
  const s = setup({
    submit(input) {
      assert(Object.isFrozen(input));
      assert(Object.isFrozen(input.cause));
      assert.throws(() => {
        input.reasonCode = "mutated";
      }, TypeError);
      response = v.receipt(v.clone(input));
      return Promise.resolve(response);
    },
  });
  const bytes = s.continuation.canonicalRequestJson;
  s.fault.reasonCode = "caller-mutated";
  const result = await s.adapter.submit(s.continuation, v.call(s.clock));
  assert.equal(result.status, "accepted");
  response.receipt.fault.reasonCode = "sink-mutated-after-return";
  assert.equal(result.continuation.canonicalRequestJson, bytes);
  assert.equal(canonicalRuntimeFaultRequestV1(result.result.receipt.fault), bytes);
  assert(Object.isFrozen(result.result.receipt.fault));
});

test("malformed response and wrong same-ID payload cannot become accepted", async () => {
  for (const response of [
    () => ({ status: "accepted" }),
    (input) => {
      const changed = v.clone(input);
      changed.reasonCode = "evidence-stale";
      return v.receipt(resign(changed));
    },
  ]) {
    const s = setup({ submit: (input) => Promise.resolve(response(input)) });
    const result = await s.adapter.submit(s.continuation, v.call(s.clock));
    assert.equal(result.status, "commit-unknown");
    assert.equal(result.reason, "response-mismatch");
    assert.equal(result.continuation.canonicalRequestJson, s.continuation.canonicalRequestJson);
  }
});

test("clock and scheduler failures before invocation preserve same-request retry only", async () => {
  for (const change of [
    (clock) => {
      clock.wallNowMs = () => NaN;
    },
    (clock) => {
      clock.schedule = () => {
        throw new Error("scheduler unavailable");
      };
    },
  ]) {
    const s = setup();
    const clock = { ...s.clock.port };
    change(clock);
    const adapter = new ContainmentFaultRequestAdapterV1({ sink: s.sink, clock });
    const result = await adapter.submit(s.continuation, v.call(s.clock));
    assert.equal(result.status, "not-invoked");
    assert.equal(result.continuation.phase, "submit-allowed");
    assert.equal(s.calls.length, 0);
  }
});

test("caller may tighten waits but cannot broaden original ceilings", async () => {
  const s = setup({ submit: () => v.deferred().promise });
  for (const invalid of [0, -1, 10_001, NaN, Infinity, 1.5])
    assert.throws(
      () =>
        new ContainmentFaultRequestAdapterV1({
          sink: s.sink,
          clock: s.clock.port,
          maxSubmitMs: invalid,
        }),
      TypeError,
    );
  assert.throws(
    () =>
      new ContainmentFaultRequestAdapterV1({
        sink: s.sink,
        clock: s.clock.port,
        maxReadbackMs: 3_001,
      }),
    TypeError,
  );
  const adapter = new ContainmentFaultRequestAdapterV1({
    sink: s.sink,
    clock: s.clock.port,
    maxSubmitMs: 1,
  });
  const promise = adapter.submit(s.continuation, v.call(s.clock));
  await v.settle();
  s.clock.advance(1);
  assert.equal((await promise).status, "commit-unknown");
});
