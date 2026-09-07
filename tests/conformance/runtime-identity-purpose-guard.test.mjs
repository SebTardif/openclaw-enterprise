import test from "node:test";
import assert from "node:assert/strict";
import { parseRuntimeAuthorityV1 } from "../../packages/contracts/src/runtime-authority-v1.ts";
import { createRuntimeIdentityPurposeGuardV1 } from "../../packages/occ/src/runtime-identity/purpose-guard-v1.ts";
import {
  controlledFixture,
  deferred,
  flush,
} from "../fixtures/runtime-identity-currentness/consumer.ts";
import * as v from "../fixtures/runtime-authority-v1/vectors.mjs";

const fixture = (limits) =>
  controlledFixture(Object.freeze({ controlledService: "original-context" }), limits);
const denied = (result) => assert.notEqual(result.kind, "resolved", JSON.stringify(result));
const current = (result) => {
  assert.equal(result.kind, "resolved", JSON.stringify(result));
  assert.equal(result.observation.result, "current");
};
const negative = (result, purpose = "model-call") => ({
  schemaVersion: 1,
  result,
  ...(result === "not-visible" || result === "unavailable" ? {} : { purpose }),
  reasonCode: {
    pending: "evidence-incomplete",
    "not-current": "assignment-replaced",
    "not-visible": "scope-hidden",
    unavailable: "lookup-unavailable",
  }[result],
  evaluatedAt: v.now,
  requestRef: "request/example",
});

test("warm original connection still performs fresh verifier and actual resolver calls per request", async () => {
  const f = await fixture();
  const before = f.nativeCalls.length;
  current(await f.guard.check(f.proof, f.request, f.call));
  current(await f.guard.check(f.proof, f.request, f.call));
  assert.equal(f.resolverCalls.length, 2);
  assert.equal(f.nativeCalls.length - before, 8); // Two bracketed native inspections per check.
  for (const { request, call } of f.resolverCalls) {
    assert.deepEqual(request, f.request);
    assert.equal(call.context, f.call.context);
    assert.equal(call.recipientRef, f.call.recipientRef);
    assert.equal(call.requestRef, f.call.requestRef);
    assert.ok(Object.isFrozen(request) && Object.isFrozen(request.assignmentRef));
  }
});

test("all seven original result outcomes survive the guard without readiness-to-serving conversion", async () => {
  const f = await fixture();
  const cases = [
    v.current(),
    v.candidate(),
    v.cleanup(),
    negative("pending"),
    negative("not-current"),
    negative("not-visible"),
    negative("unavailable"),
  ];
  const observed = [];
  for (const value of cases) {
    f.state.response = value;
    const request = parseRuntimeAuthorityV1(
      "resolveRequest",
      v.resolveRequest(value.purpose ?? "model-call"),
    );
    const result = await f.guard.check(f.proof, request, f.call);
    assert.equal(result.kind, "resolved", JSON.stringify(result));
    assert.deepEqual(result.observation, parseRuntimeAuthorityV1("resolveResult", value));
    observed.push(result.observation.result);
  }
  assert.equal(new Set(observed).size, 7);
});

test("all seven original purposes retain exact operation, suboperation and responsibility fields", async () => {
  const f = await fixture();
  for (const purpose of [
    "identity-registration",
    "readiness-probe",
    "runtime-peer",
    "model-call",
    "repository-issuance",
    "cleanup",
    "completed-context-restore",
  ]) {
    const request = parseRuntimeAuthorityV1("resolveRequest", v.resolveRequest(purpose));
    f.state.response = negative("pending", purpose);
    const result = await f.guard.check(f.proof, request, f.call);
    assert.equal(result.kind, "resolved", JSON.stringify(result));
    assert.deepEqual(f.resolverCalls.at(-1).request, request);
    assert.equal(result.observation.purpose, purpose);
  }
  f.state.response = v.restore();
  const restored = await f.guard.check(
    f.proof,
    parseRuntimeAuthorityV1("resolveRequest", v.resolveRequest("completed-context-restore")),
    f.call,
  );
  assert.equal(restored.kind, "resolved", JSON.stringify(restored));
  assert.equal(restored.observation.result, "candidate-eligible");
});

test("request and call mutation during the actual verifier await cannot change captured custody", async () => {
  const f = await fixture();
  f.state.response = v.cleanup();
  const request = v.resolveRequest("cleanup");
  const call = { ...f.call };
  const gate = deferred();
  f.state.nativeGate = gate.promise;
  const result = f.guard.check(f.proof, request, call);
  await flush();
  request.operationRef = v.id(90);
  request.requestedOperation = "retire-registration";
  call.context = {};
  call.requestRef = "request/different";
  call.recipientRef = "recipient/different";
  call.deadline = "2026-01-02T00:00:00.000Z";
  gate.resolve();
  assert.equal((await result).kind, "resolved");
  assert.deepEqual(
    f.resolverCalls[0].request,
    parseRuntimeAuthorityV1("resolveRequest", v.resolveRequest("cleanup")),
  );
  assert.equal(f.resolverCalls[0].call.context, f.call.context);
  assert.equal(f.resolverCalls[0].call.requestRef, f.call.requestRef);
});

test("constructor captures actual methods and required immutable profile", async () => {
  const f = await fixture();
  assert.throws(() => {
    f.verifier.inspect = () => {
      throw new Error("replacement inspector");
    };
  });
  f.authority.resolve = () => {
    throw new Error("replacement resolver");
  };
  f.limits.assignmentDeadlineMs = 2;
  current(await f.guard.check(f.proof, f.request, f.call));
  assert.throws(
    () =>
      createRuntimeIdentityPurposeGuardV1({
        verifier: f.verifier,
        authority: f.authority,
        limits: { ...f.limits, maxPendingChecks: Infinity },
      }),
    /limits/,
  );
  assert.throws(
    () =>
      createRuntimeIdentityPurposeGuardV1({
        verifier: { inspect() {}, verify() {} },
        authority: f.authority,
        limits: { ...f.limits, maxPendingChecks: 1 },
      }),
    /settlement/,
  );
});

test("foreign/copied/diagnostic proofs never reach current-purpose lookup", async () => {
  const f = await fixture();
  const other = await fixture();
  for (const proof of [
    { ...f.proof },
    other.proof,
    { assignmentRef: f.proof.assignmentRef },
    null,
  ]) {
    denied(await f.guard.check(proof, f.request, f.call));
  }
  assert.equal(f.resolverCalls.length, 0);
});

test("changed recipient or assignment is denied before purpose resolution", async () => {
  const f = await fixture();
  denied(await f.guard.check(f.proof, f.request, { ...f.call, recipientRef: "recipient/other" }));
  denied(
    await f.guard.check(
      f.proof,
      { ...f.request, assignmentRef: { schemaVersion: 1, id: v.id(90) } },
      f.call,
    ),
  );
  assert.equal(f.resolverCalls.length, 0);
});

test("reply correspondence checks scope, purpose, operation, profile and registration", async () => {
  for (const mutate of [
    (r) => {
      r.requestRef = "request/other";
    },
    (r) => {
      r.purpose = "runtime-peer";
    },
    (r) => {
      r.snapshot.target.agentId = `agt_${v.id(90)}`;
    },
    (r) => {
      r.snapshot.target.assignmentRef.id = v.id(90);
    },
    (r) => {
      r.identityEvidence.registrationVersion = 2;
    },
    (r) => {
      r.snapshot.identityProfileRef = "identity/other";
    },
    (r) => {
      r.snapshot.binding.protectedRestartDiscriminator = "restart/different-attempt";
    },
    (r) => {
      r.snapshot.binding.podUid = v.id(90);
    },
    (r) => {
      r.snapshot.target.runtimeGeneration = 2;
    },
    (r) => {
      r.snapshot.target.createEffectRef = v.id(90);
    },
  ]) {
    const f = await fixture();
    mutate(f.state.response);
    denied(await f.guard.check(f.proof, f.request, f.call));
  }
  const f = await fixture();
  f.state.response = { ...v.cleanup(), operationRef: v.id(90) };
  denied(await f.guard.check(f.proof, v.resolveRequest("cleanup"), f.call));
  f.state.response = { ...v.restore(), allowedSuboperation: "readImportedContext" };
  denied(await f.guard.check(f.proof, v.resolveRequest("completed-context-restore"), f.call));
});

test("original finite lookup budget survives delayed replies and wall-clock rollback", async () => {
  const f = await fixture({ assignmentDeadlineMs: 50, policyDeadlineMs: 50 });
  const gate = deferred();
  f.state.resolveGate = gate.promise;
  const result = f.guard.check(f.proof, f.request, f.call);
  await flush();
  assert.equal(f.resolverCalls.length, 1);
  assert.equal(f.resolverCalls[0].call.deadline, "2026-01-01T00:00:00.050Z");
  f.clock.advance(51, -1000);
  const failure = await result;
  assert.equal(failure.reasonCode, "deadline-exceeded");
  gate.resolve();
  await flush();
  assert.equal(failure.reasonCode, "deadline-exceeded");
});

test("time consumed by the verifier does not renew the resolver deadline", async () => {
  const f = await fixture({ assignmentDeadlineMs: 50, policyDeadlineMs: 50 });
  const native = deferred();
  f.state.nativeGate = native.promise;
  const pending = f.guard.check(f.proof, f.request, f.call);
  await flush();
  f.clock.advance(30);
  native.resolve();
  await flush();
  current(await pending);
  assert.equal(f.resolverCalls[0].call.deadline, "2026-01-01T00:00:00.050Z");
});

test("reconnect during actual authority await is denied by the second verifier inspection", async () => {
  const f = await fixture();
  const gate = deferred();
  f.state.resolveGate = gate.promise;
  const pending = f.guard.check(f.proof, f.request, f.call);
  await flush();
  f.state.incarnation = Object.freeze({ attempt: 2 });
  gate.resolve();
  denied(await pending);
});

test("stale source evidence and missing currentness producer never become positive cached outcomes", async () => {
  const f = await fixture();
  current(await f.guard.check(f.proof, f.request, f.call));
  f.state.response = negative("unavailable");
  const unavailable = await f.guard.check(f.proof, f.request, f.call);
  assert.equal(unavailable.kind, "resolved");
  assert.deepEqual(
    unavailable.observation,
    parseRuntimeAuthorityV1("resolveResult", negative("unavailable")),
  );
  f.state.response = v.current();
  f.state.freshSourceTimes = false;
  f.clock.advance(1000);
  denied(await f.guard.check(f.proof, f.request, f.call));
});

test("public request timeout retains outstanding resolver capacity until actual settlement", async () => {
  const f = await fixture({ maxPendingChecks: 1, assignmentDeadlineMs: 50, policyDeadlineMs: 50 });
  const gate = deferred();
  f.state.resolveGate = gate.promise;
  const pending = f.guard.check(f.proof, f.request, f.call);
  await flush();
  f.clock.advance(50);
  assert.equal((await pending).reasonCode, "deadline-exceeded");
  assert.equal((await f.guard.check(f.proof, f.request, f.call)).reasonCode, "buffer-exhausted");
  gate.resolve();
  f.state.resolveGate = undefined;
  await flush();
  current(await f.guard.check(f.proof, f.request, f.call));
});

test("malformed request and original cancellation start no dependency work", async () => {
  const f = await fixture();
  const before = f.nativeCalls.length;
  denied(await f.guard.check(f.proof, { ...f.request, attempt: "injected" }, f.call));
  f.abort.abort();
  assert.equal((await f.guard.check(f.proof, f.request, f.call)).reasonCode, "cancelled");
  assert.equal(f.nativeCalls.length, before);
  assert.equal(f.resolverCalls.length, 0);
});

test("owned-provider-object cleanup preserves original profiles, digests and record-version floor", async () => {
  const f = await fixture();
  const request = parseRuntimeAuthorityV1("resolveRequest", {
    ...v.resolveRequest("cleanup"),
    requestedOperation: "remove-provider-object",
  });
  const expected = parseRuntimeAuthorityV1("resolveResult", v.unboundCleanup());
  f.state.response = expected;
  const accepted = await f.guard.check(f.proof, request, f.call);
  assert.equal(accepted.kind, "resolved", JSON.stringify(accepted));
  assert.deepEqual(accepted.observation, expected);
  assert.equal(f.resolverCalls.at(-1).call.context, f.call.context);
  for (const change of [
    (value) => {
      value.identityProfileRef = "identity/different";
    },
    (value) => {
      value.runtimeProfileRef = "runtime/different";
    },
    (value) => {
      value.providerProfileRef = "provider/different";
    },
    (value) => {
      value.assignmentRecordVersion = 1;
    },
    (value) => {
      value.profileDigests.identity = `sha256:${"b".repeat(64)}`;
    },
    (value) => {
      value.profileDigests.runtime = `sha256:${"b".repeat(64)}`;
    },
    (value) => {
      value.profileDigests.provider = `sha256:${"b".repeat(64)}`;
    },
  ]) {
    const response = v.unboundCleanup();
    change(response);
    // Each negative remains a valid canonical cleanup variant; the actual guard
    // must reject its correspondence with the same genuine proof and context.
    f.state.response = parseRuntimeAuthorityV1("resolveResult", response);
    denied(await f.guard.check(f.proof, request, f.call));
  }
  f.state.response = expected;
  const stillEligible = await f.guard.check(f.proof, request, f.call);
  assert.equal(stillEligible.kind, "resolved", JSON.stringify(stillEligible));
  assert.deepEqual(stillEligible.observation, expected);
});
