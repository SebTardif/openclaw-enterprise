import test from "node:test";
import assert from "node:assert/strict";
import {
  controlledFixture,
  deferred,
  flush,
} from "../fixtures/runtime-identity-currentness/consumer.ts";
import * as v from "../fixtures/runtime-authority-v1/vectors.mjs";

const fixture = (limits) =>
  controlledFixture(Object.freeze({ controlledService: "original-stream-context" }), limits);
async function open(f, call = f.call) {
  const result = await f.guard.openStream(f.proof, f.request, call, f.limits);
  assert.equal(result.kind, "opened", JSON.stringify(result));
  return result.stream;
}
const denied = (result) => assert.notEqual(result.kind, "resolved", JSON.stringify(result));

test("opening is independently checked and the first delivery needs another actual check", async () => {
  const f = await fixture();
  const stream = await open(f);
  assert.equal(f.resolverCalls.length, 1);
  assert.equal((await stream.check(f.call)).kind, "resolved");
  assert.equal(f.resolverCalls.length, 2);
  assert.equal(stream.signal.aborted, false);
  assert.deepEqual(await stream.close(), { kind: "closed" });
  assert.equal(f.clock.timerCount, 0);
});

test("simultaneous exact streams have independent authorization and terminal state", async () => {
  const f = await fixture();
  const first = await open(f);
  const second = await open(f);
  assert.equal(f.resolverCalls.length, 2);
  first.invalidate("authority-changed");
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  denied(await first.check(f.call));
  assert.equal((await second.check(f.call)).kind, "resolved");
  await Promise.all([first.close(), second.close()]);
});

test("polling invalidates retirement while the consumer never requests another item", async () => {
  const f = await fixture();
  const stream = await open(f);
  f.state.response = {
    schemaVersion: 1,
    result: "not-current",
    purpose: "model-call",
    reasonCode: "assignment-retired",
    evaluatedAt: v.now,
    requestRef: f.call.requestRef,
  };
  f.clock.advance(100);
  await flush();
  assert.equal(stream.signal.aborted, true);
  denied(await stream.check(f.call));
  await stream.close();
});

test("fresh periodic checks advance health without extending the original stream deadline", async () => {
  const f = await fixture();
  const call = { ...f.call, deadline: "2026-01-01T00:00:00.350Z" };
  const stream = await open(f, call);
  for (let i = 0; i < 3; i++) {
    f.clock.advance(100);
    await flush();
    assert.equal(stream.signal.aborted, false);
  }
  f.clock.advance(50);
  assert.equal(stream.signal.aborted, true);
  denied(await stream.check({ ...f.call, deadline: "2026-01-02T00:00:00.000Z" }));
  await stream.close();
});

test("paused polling dependency cannot postpone independent health invalidation", async () => {
  const f = await fixture();
  const stream = await open(f);
  const gate = deferred();
  f.state.resolveGate = gate.promise;
  f.clock.advance(100);
  await flush();
  assert.equal(f.resolverCalls.length, 2);
  f.clock.advance(400);
  assert.equal(stream.signal.aborted, true);
  assert.equal(stream.signal.reason, "watch-lost");
  gate.resolve();
  await flush();
  assert.equal(stream.signal.aborted, true);
  await stream.close();
});

test("original source expiry independently invalidates a blocked data consumer", async () => {
  const f = await fixture({
    identityHealthMaxAgeMs: 2000,
    identityHealthPollMs: 1000,
    streamRecheckMs: 1000,
    runtimeEvidenceMaxAgeMs: 200,
    policyEvidenceMaxAgeMs: 200,
    identityEvidenceMaxAgeMs: 200,
  });
  const stream = await open(f);
  f.clock.advance(200);
  assert.equal(stream.signal.aborted, true);
  assert.equal(stream.signal.reason, "evidence-stale");
  await stream.close();
});

test("external watch-gap and connection-closed invalidations are synchronous and terminal", async () => {
  for (const reason of [
    "watch-gap",
    "watch-lost",
    "connection-closed",
    "buffer-exhausted",
    "identity-changed",
  ]) {
    const f = await fixture();
    const stream = await open(f);
    stream.invalidate(reason);
    assert.equal(stream.signal.aborted, true);
    assert.equal(stream.signal.reason, reason);
    const before = f.resolverCalls.length;
    denied(await stream.check(f.call));
    assert.equal(f.resolverCalls.length, before);
    await stream.close();
  }
});

test("a buffered delivery cannot obtain a positive check after terminal invalidation", async () => {
  const f = await fixture();
  const stream = await open(f);
  const gate = deferred();
  f.state.resolveGate = gate.promise;
  const deliveryCheck = stream.check(f.call);
  await flush();
  stream.invalidate("authority-changed");
  denied(await deliveryCheck);
  gate.resolve();
  await flush();
  denied(await stream.check(f.call));
  await stream.close();
});

test("close denies synchronously before cleanup and joins still-running resolver work", async () => {
  const f = await fixture();
  const stream = await open(f);
  const gate = deferred();
  f.state.resolveGate = gate.promise;
  const checked = stream.check(f.call);
  await flush();
  const closing = stream.close();
  assert.equal(stream.signal.aborted, true);
  assert.equal(stream.close(), closing);
  denied(await checked);
  gate.resolve();
  assert.deepEqual(await closing, { kind: "closed" });
  assert.equal(f.clock.timerCount, 0);
});

test("close timeout retains stream slot and resolver ownership until actual late settlement", async () => {
  const f = await fixture({ maxStreamsPerConnection: 1 });
  const stream = await open(f);
  const gate = deferred();
  f.state.resolveGate = gate.promise;
  const checked = stream.check(f.call);
  await flush();
  const closing = stream.close();
  f.clock.advance(30);
  assert.equal((await closing).reasonCode, "cleanup-unsettled");
  denied(await checked);
  f.state.resolveGate = undefined;
  const blocked = await f.guard.openStream(f.proof, f.request, f.call, f.limits);
  assert.equal(blocked.reasonCode, "buffer-exhausted");
  gate.resolve();
  await flush();
  const successor = await open(f);
  assert.equal(stream.signal.aborted, true);
  await successor.close();
});

test("close retains nested genuine verifier native work after the public inspect cancellation", async () => {
  const f = await fixture({ maxStreamsPerConnection: 1 });
  const stream = await open(f);
  const gate = deferred();
  f.state.nativeGate = gate.promise;
  const checked = stream.check(f.call);
  await flush();
  const closing = stream.close();
  denied(await checked);
  f.clock.advance(30);
  assert.equal((await closing).reasonCode, "cleanup-unsettled");
  f.state.nativeGate = undefined;
  assert.equal(
    (await f.guard.openStream(f.proof, f.request, f.call, f.limits)).reasonCode,
    "buffer-exhausted",
  );
  gate.resolve();
  await flush();
  // Cancelled inspection makes that proof terminal; a fresh authentic proof may
  // reuse the same actual connection only after its original operation settles.
  const verified = await f.verifier.verify(f.connection, f.expected, f.call);
  assert.equal(verified.kind, "verified", JSON.stringify(verified));
  f.proof = verified.proof;
  const successor = await open(f);
  await successor.close();
});

test("new proofs on the same original connection cannot bypass per-connection stream bounds", async () => {
  const f = await fixture({ maxStreamsPerConnection: 1 });
  const stream = await open(f);
  const verified = await f.verifier.verify(f.connection, f.expected, f.call);
  assert.equal(verified.kind, "verified");
  assert.equal(verified.proof.transportBinding, f.proof.transportBinding);
  assert.equal(
    (await f.guard.openStream(verified.proof, f.request, f.call, f.limits)).reasonCode,
    "buffer-exhausted",
  );
  await stream.close();
});

test("original cancellation persists when check supplies a different signal", async () => {
  const f = await fixture();
  const stream = await open(f);
  const gate = deferred();
  f.state.resolveGate = gate.promise;
  const checked = stream.check({ ...f.call, signal: new AbortController().signal });
  await flush();
  f.abort.abort();
  assert.equal(stream.signal.aborted, true);
  denied(await checked);
  gate.resolve();
  await stream.close();
});

test("another request/context/recipient cannot borrow the original stream's authorization", async () => {
  for (const patch of [
    { context: {} },
    { requestRef: "request/other" },
    { recipientRef: "recipient/other" },
  ]) {
    const f = await fixture();
    const stream = await open(f);
    const before = f.resolverCalls.length;
    assert.equal((await stream.check({ ...f.call, ...patch })).reasonCode, "protocol-invalid");
    assert.equal(stream.signal.aborted, true);
    assert.equal(f.resolverCalls.length, before);
    await stream.close();
  }
});

test("opening refuses missing producer, nonpositive results and a different limits profile", async () => {
  const f = await fixture();
  for (const [result, reasonCode] of [
    ["unavailable", "lookup-unavailable"],
    ["not-visible", "scope-hidden"],
  ]) {
    f.state.response = {
      schemaVersion: 1,
      result,
      reasonCode,
      evaluatedAt: v.now,
      requestRef: f.request.requestRef,
    };
    const opened = await f.guard.openStream(f.proof, f.request, f.call, f.limits);
    assert.equal(opened.kind, "not-opened");
    assert.equal(opened.observation.result, result);
  }
  assert.equal(
    (
      await f.guard.openStream(f.proof, f.request, f.call, {
        ...f.limits,
        streamCloseDeadlineMs: f.limits.streamCloseDeadlineMs + 1,
      })
    ).reasonCode,
    "profile-invalid",
  );
});

test("connection replacement detected by independent polling never revives the predecessor", async () => {
  const f = await fixture();
  const stream = await open(f);
  f.state.incarnation = Object.freeze({ attempt: 2 });
  f.clock.advance(100);
  await flush();
  assert.equal(stream.signal.aborted, true);
  denied(await stream.check(f.call));
  await stream.close();
});
