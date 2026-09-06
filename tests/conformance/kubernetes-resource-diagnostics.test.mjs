import assert from "node:assert/strict";
import test from "node:test";
import { projectRuntimeResourceDiagnostics } from "../../apps/controller/src/drivers/compute/kubernetes/resource-diagnostics.ts";
import { consumeDiagnostics } from "../fixtures/kubernetes-resource-plan/diagnostic-consumer.ts";
import {
  diagnosticInput,
  candidateDiagnosticInput,
  unavailableDiagnosticInput,
} from "../fixtures/kubernetes-resource-plan/diagnostic-values.mjs";

test("canonical preallocated-candidate correspondence retains preparation ownership without identity authority", () => {
  const input = candidateDiagnosticInput();
  assert.equal(input.expected.kind, "preallocated-candidate");
  assert.equal(input.result.identityEvidence, null);
  const result = projectRuntimeResourceDiagnostics(input);
  assert.equal(result.status, "observed");
  assert.equal(result.reason, "profile-observation-only");
  assert.equal(result.authority, "none");
  assert.equal(result.effectiveResources, "unavailable");
  input.expected.createEffect.expectedObject = {
    ...structuredClone(input.result.object),
    uid: "different-deployment",
  };
  assert.equal(projectRuntimeResourceDiagnostics(input).status, "invalid");
});

test("actual consumer retains all five evidence clocks and distinct profile versions without authority", () => {
  const input = diagnosticInput();
  const result = consumeDiagnostics(input);
  assert.equal(result.status, "observed");
  assert.equal(result.reason, "profile-mismatch");
  assert.equal(result.component, "harness");
  assert.equal(result.ageMs, 1000);
  assert.equal(result.clocks.length, 5);
  assert.deepEqual(
    result.clocks.map((clock) => clock.kind),
    [
      "observation",
      "owner-chain",
      "execution-correspondence",
      "delivered-profile",
      "effective-profile",
    ],
  );
  for (const clock of result.clocks) {
    assert.equal(clock.evidenceVersion, 2);
    assert.equal(clock.sourceObservedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(clock.receivedAt, "2026-01-01T00:00:00.100Z");
    assert.equal(clock.validUntil, "2026-01-01T00:00:15.000Z");
    assert.equal(clock.uncertaintyMs, 100);
  }
  assert.deepEqual(
    [
      result.profiles.desired.version,
      result.profiles.delivered.version,
      result.profiles.effective.version,
    ],
    [3, 2, 1],
  );
  assert.equal(result.effectiveResources, "unavailable");
  assert.equal(result.authority, "none");
  input.result.profile.desired.version = 99;
  assert.equal(result.profiles.desired.version, 3);
  assert.throws(() => {
    result.clocks[0].ageMs = 0;
  }, TypeError);
  assert.throws(() => {
    result.profiles.desired.version = 0;
  }, TypeError);
});

test("matching profiles remain observation-only and mismatch is not silently rewritten", () => {
  const input = diagnosticInput();
  const desired = input.result.profile.desired;
  Object.assign(input.result.profile.delivered, desired);
  Object.assign(input.result.profile.effective, desired);
  const matched = projectRuntimeResourceDiagnostics(input);
  assert.equal(matched.status, "observed");
  assert.equal(matched.reason, "profile-observation-only");
  assert.equal(matched.profiles.match, true);
  assert.equal(matched.authority, "none");
  input.result.profile.effective.profileRef = "different-profile-reference";
  assert.equal(projectRuntimeResourceDiagnostics(input).profiles.match, false);
});

test("complete, incomplete, ambiguous, unknown and missing observations retain bounded distinctions", () => {
  for (const status of ["incomplete", "ambiguous", "unknown"]) {
    const result = projectRuntimeResourceDiagnostics(unavailableDiagnosticInput(status));
    assert.equal(result.status, "unavailable");
    assert.equal(result.phase, `observation-${status}`);
    assert.equal(result.observationStatus, status);
    assert.equal(result.reason, "evidence-incomplete");
    assert.equal(result.ageMs, null);
    assert.deepEqual(result.clocks, []);
  }
  const absent = diagnosticInput();
  absent.result = null;
  assert.equal(projectRuntimeResourceDiagnostics(absent).reason, "observation-unavailable");
});

test("exact IFC request/result correlation rejects wrong binding, component and expected version", () => {
  for (const mutate of [
    (input) => {
      input.expected.binding.podUid = "wrong-pod";
    },
    (input) => {
      input.expected.target.component = "gateway";
    },
    (input) => {
      input.expected.expectedEvidenceVersion = null;
    },
    (input) => {
      input.result.observation.evidenceVersion = 1;
    },
  ]) {
    const input = diagnosticInput();
    mutate(input);
    const result = projectRuntimeResourceDiagnostics(input);
    assert.equal(result.status, "invalid");
    assert.equal(result.reason, "invalid-diagnostic-input");
    assert.deepEqual(result.clocks, []);
  }
});

test("stale and out-of-order observations preserve their original clocks and uncertainty", () => {
  const stale = diagnosticInput();
  stale.now = "2026-01-01T00:00:15.000Z";
  const staleResult = projectRuntimeResourceDiagnostics(stale);
  assert.equal(staleResult.status, "stale");
  assert.equal(staleResult.reason, "evidence-stale");
  assert.equal(staleResult.ageMs, 15000);
  for (const prior of [2, 3]) {
    const input = diagnosticInput();
    input.previousEvidenceVersion = prior;
    const result = projectRuntimeResourceDiagnostics(input);
    assert.equal(result.status, "out-of-order");
    assert.equal(result.clocks[0].evidenceVersion, 2);
  }
  const stricter = diagnosticInput();
  stricter.maxAgeMs = 1099;
  assert.equal(projectRuntimeResourceDiagnostics(stricter).status, "stale");
  stricter.maxAgeMs = 1100;
  assert.equal(projectRuntimeResourceDiagnostics(stricter).status, "observed");
});

test("each supporting provenance independently expires and future clocks are never clamped", () => {
  for (const locate of [
    (result) => result.ownerChainEvidence,
    (result) => result.executionCorrespondenceEvidence,
    (result) => result.profile.delivered.evidence,
    (result) => result.profile.effective.evidence,
  ]) {
    const input = diagnosticInput();
    locate(input.result).clock.validUntil = "2026-01-01T00:00:00.900Z";
    assert.equal(projectRuntimeResourceDiagnostics(input).status, "stale");
  }
  const sourceFuture = diagnosticInput();
  sourceFuture.now = "2025-12-31T23:59:59.950Z";
  const future = projectRuntimeResourceDiagnostics(sourceFuture);
  assert.equal(future.status, "stale");
  assert.equal(future.reason, "clock-regression");
  assert.equal(future.ageMs, null);
  assert.equal(future.clocks[0].sourceObservedAt, "2026-01-01T00:00:00.000Z");
  const receivedFuture = diagnosticInput();
  receivedFuture.now = "2026-01-01T00:00:00.050Z";
  assert.equal(projectRuntimeResourceDiagnostics(receivedFuture).reason, "clock-regression");
});

test("invalid optional freshness values never widen the accepted ceiling", () => {
  for (const maxAgeMs of [null, -1, -0, 15001, 1.5, "1000", Infinity]) {
    const input = diagnosticInput();
    input.maxAgeMs = maxAgeMs;
    assert.equal(projectRuntimeResourceDiagnostics(input).status, "invalid");
  }
  for (const now of ["2026-01-01T00:00:01Z", "2026-02-30T00:00:01.000Z", "not-a-clock"]) {
    const input = diagnosticInput();
    input.now = now;
    assert.equal(projectRuntimeResourceDiagnostics(input).status, "invalid");
  }
  for (const previousEvidenceVersion of [undefined, 0, -1, 1.5, "1"]) {
    const input = diagnosticInput();
    input.previousEvidenceVersion = previousEvidenceVersion;
    assert.equal(projectRuntimeResourceDiagnostics(input).status, "invalid");
  }
});

test("deadline and cancellation outcome stays explicit for before-submission and unknown effects", () => {
  for (const status of ["none", "not-submitted", "unknown"]) {
    for (const input of [diagnosticInput(), unavailableDiagnosticInput("unknown")]) {
      input.operation.status = status;
      assert.equal(projectRuntimeResourceDiagnostics(input).effectOutcome, status);
    }
  }
  const forged = diagnosticInput();
  forged.operation.status = "stopped";
  assert.equal(projectRuntimeResourceDiagnostics(forged).effectOutcome, "unknown");
  assert.equal(projectRuntimeResourceDiagnostics(forged).status, "invalid");
});

test("bounded output excludes arbitrary producer references and rejects executable/surplus claims", () => {
  const input = diagnosticInput();
  input.result.observation.producerRef = "private-producer-reference";
  input.result.profile.desired.profileRef = "private-profile-reference";
  const text = JSON.stringify(projectRuntimeResourceDiagnostics(input));
  assert.equal(text.includes("private-"), false);
  assert.equal(text.includes("fixture-port"), false);
  assert.equal(text.includes("pod-2"), false);
  let invoked = false;
  const getter = diagnosticInput();
  Object.defineProperty(getter, "result", {
    enumerable: true,
    get() {
      invoked = true;
      throw Error("secret");
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        invoked = true;
        throw Error("secret");
      },
    },
  );
  const surplus = diagnosticInput();
  surplus.measuredResources = "secret";
  for (const value of [getter, proxy, surplus]) {
    const result = projectRuntimeResourceDiagnostics(value);
    assert.equal(result.status, "invalid");
    assert.ok(JSON.stringify(result).length < 400);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
  assert.equal(invoked, false);
});
