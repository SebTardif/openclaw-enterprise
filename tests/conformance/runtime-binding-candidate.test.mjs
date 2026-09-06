import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeEffectsV1 } from "../../packages/contracts/src/index.ts";
import {
  prepareRuntimeBindingCandidate,
  submitRuntimeBindingCandidate,
  RuntimeBindingCandidateError,
} from "../../packages/occ/src/runtime-authority/binding-candidate.ts";
import { RuntimeAuthorityService } from "../../packages/occ/src/runtime-authority/service.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { exactRuntimeAuthorityOperation } from "../../packages/occ/src/runtime-authority/repository.ts";
import { seedAuthority } from "../fixtures/runtime-authority-state/seed.mjs";
import { bindingCandidateFixture } from "../fixtures/runtime-binding-candidate.mjs";
import { copy, uuid } from "../fixtures/runtime-effects-v1/vectors.mjs";

test("candidate consumer correlates existing port values and preserves binding/evidence identity", async () => {
  const f = bindingCandidateFixture();
  const proposal = await prepareRuntimeBindingCandidate(f.options);
  assert.deepEqual(f.events, ["gate", "discover", "observe", "gate"]);
  assert.deepEqual(copy(proposal.binding), copy(f.responses.observation.binding));
  assert.equal(proposal.observation.createEffectCorrelationRef, "create-correlation");
  assert.equal(proposal.observation.observationRef, "observation");
  assert.equal(proposal.observation.ownerChainEvidenceRef, "owner-chain");
  assert.equal(proposal.observation.instanceEvidenceRef, "execution-chain");
  for (const [key, value] of Object.entries(f.responses.observation.observation.clock))
    assert.equal(proposal.observation[key], value);
  assert.equal(proposal.responsibilityRef, f.options.child.effect.responsibility.responsibilityRef);
  assert.equal(proposal.expectedBindingVersion, null);
  assert.equal(Object.isFrozen(proposal), true);
});

test("candidate consumer permits different opaque read resourceVersions only for the same object", async () => {
  const f = bindingCandidateFixture();
  f.responses.observation.object.resourceVersion = "later-observed-version";
  await prepareRuntimeBindingCandidate(f.options);
  f.responses.observation.object.uid = "foreign-deployment";
  await assert.rejects(prepareRuntimeBindingCandidate(f.options), RuntimeBindingCandidateError);
});

test("candidate consumer rejects changed allocation, current gate and retained child before Compute", async () => {
  for (const change of [
    (f) => {
      f.options.assignment.allocation.agentId = `agt_${uuid(99)}`;
    },
    (f) => {
      f.options.assignment.authority.state = "retired";
    },
    (f) => {
      f.responses.state.authority = "lost";
    },
    (f) => {
      f.responses.state.ordinaryAdmission = "closed";
    },
    (f) => {
      f.responses.state = {
        ...f.responses.state,
        guard: { ...f.responses.state.guard, gateVersion: 5 },
      };
    },
    (f) => {
      f.responses.state.children = [];
    },
  ]) {
    const f = bindingCandidateFixture();
    change(f);
    await assert.rejects(prepareRuntimeBindingCandidate(f.options), RuntimeBindingCandidateError);
    assert.ok(!f.events.includes("discover"));
  }
});

test("candidate consumer rejects incomplete, ambiguous and unknown observations", async () => {
  for (const status of ["incomplete", "ambiguous", "unknown"]) {
    const f = bindingCandidateFixture();
    f.options.effects.observe = async (input) => ({
      schemaVersion: 1,
      status,
      input,
      reasonCode: "evidence-incomplete",
    });
    await assert.rejects(prepareRuntimeBindingCandidate(f.options), RuntimeBindingCandidateError);
  }
});

test("candidate consumer rejects a response for another exact effect or preparation", async () => {
  for (const method of ["discover", "observe"]) {
    const f = bindingCandidateFixture();
    const original = f.options.effects[method];
    f.options.effects[method] = async (input) => {
      const result = await original(input);
      if (method === "discover") result.input.effect.effectRef = uuid(99);
      else result.input.preparation.preparationVersion++;
      return result;
    };
    await assert.rejects(prepareRuntimeBindingCandidate(f.options), RuntimeBindingCandidateError);
  }
});

test("candidate consumer rejects policy drift and late gate change after observation", async () => {
  const drift = bindingCandidateFixture();
  drift.responses.observation.profile.effective.version++;
  await assert.rejects(prepareRuntimeBindingCandidate(drift.options), RuntimeBindingCandidateError);
  const late = bindingCandidateFixture();
  const original = late.options.effects.observe;
  late.options.effects.observe = async (input) => {
    const result = await original(input);
    late.responses.state.ordinaryAdmission = "closed";
    return result;
  };
  await assert.rejects(prepareRuntimeBindingCandidate(late.options), RuntimeBindingCandidateError);
});

test("candidate consumer checks every original evidence clock without receipt-time refresh", async () => {
  for (const field of [
    "correlation",
    "observation",
    "ownerChainEvidence",
    "executionCorrespondenceEvidence",
    "delivered",
    "effective",
  ]) {
    const f = bindingCandidateFixture();
    let value;
    if (field === "correlation") value = f.responses.correlation;
    else if (["delivered", "effective"].includes(field))
      value = f.responses.observation.profile[field].evidence;
    else value = f.responses.observation[field];
    value.clock.sourceObservedAt = "2025-12-31T23:59:40.000Z";
    value.clock.validUntil = "2025-12-31T23:59:55.000Z";
    value.clock.receivedAt = "2026-01-01T00:00:00.900Z";
    assert.doesNotThrow(() => parseRuntimeEffectsV1("provenance", value));
    await assert.rejects(prepareRuntimeBindingCandidate(f.options), RuntimeBindingCandidateError);
  }
});

test("cancelled candidate reads stop before invoking any port", async () => {
  const f = bindingCandidateFixture();
  f.abort.abort();
  await assert.rejects(prepareRuntimeBindingCandidate(f.options), RuntimeBindingCandidateError);
  assert.deepEqual(f.events, []);
});

test("cancellation reaches a pending Compute read and prevents observation", async () => {
  const f = bindingCandidateFixture();
  let receivedSignal;
  f.options.effects.discover = (_input, call) => {
    receivedSignal = call.signal;
    f.abort.abort();
    return new Promise(() => {});
  };
  await assert.rejects(prepareRuntimeBindingCandidate(f.options), RuntimeBindingCandidateError);
  assert.equal(receivedSignal.aborted, true);
  assert.ok(!f.events.includes("observe"));
});

test("submission propagates the real service's missing-producer denial without changing memory state", async () => {
  const store = new InMemoryPlatformState();
  const persisted = await seedAuthority(store);
  const before = await persisted.record();
  const f = bindingCandidateFixture();
  const synthetic = await prepareRuntimeBindingCandidate(f.options);
  const request = { ...synthetic, target: persisted.target, expectedLifecycleGeneration: 1 };
  const service = new RuntimeAuthorityService({
    store,
    installationId: persisted.target.installationId,
    recipientRef: f.options.authorityCall.recipientRef,
    clock: f.clock,
  });
  const result = await submitRuntimeBindingCandidate(
    request,
    service,
    f.options.authorityCall,
    f.clock,
  );
  assert.equal(result.result, "rejected-before-effect");
  assert.deepEqual(await persisted.record(), before);
  assert.equal(await persisted.operation(request.operationRef), undefined);
});

test("potential submission failure preserves the exact locator and makes only one bind call", async () => {
  const f = bindingCandidateFixture();
  const request = await prepareRuntimeBindingCandidate(f.options);
  const events = copy(f.events);
  let calls = 0;
  const result = await submitRuntimeBindingCandidate(
    request,
    {
      async bind(actual) {
        calls++;
        assert.deepEqual(actual, request);
        throw new Error("response lost");
      },
    },
    f.options.authorityCall,
    f.clock,
  );
  assert.equal(calls, 1);
  assert.equal(result.result, "commit-unknown");
  assert.deepEqual(copy(result.operation), copy(exactRuntimeAuthorityOperation(request)));
  assert.deepEqual(f.events, events);
});

test("submission rejects a foreign receipt or unknown locator without trusting its shape", async () => {
  const f = bindingCandidateFixture();
  const request = await prepareRuntimeBindingCandidate(f.options);
  const operation = exactRuntimeAuthorityOperation(request);
  const foreign = { ...operation, operationRef: uuid(99) };
  const result = await submitRuntimeBindingCandidate(
    request,
    {
      async bind() {
        return {
          schemaVersion: 1,
          result: "commit-unknown",
          operation: foreign,
          nextAction: "exact-readback-only",
        };
      },
    },
    f.options.authorityCall,
    f.clock,
  );
  assert.equal(result.result, "commit-unknown");
  assert.deepEqual(copy(result.operation), copy(operation));
});

test("submission validates each applied receipt's immutable operation and binding fields", async () => {
  const f = bindingCandidateFixture();
  const request = await prepareRuntimeBindingCandidate(f.options);
  const { requestRef: _requestRef, ...key } = exactRuntimeAuthorityOperation(request);
  // Receipt representation only; no fixture authorizes or writes a binding.
  const receipt = {
    ...key,
    assignmentRef: request.target.assignmentRef,
    acceptedServiceIdentityRef: "service/observer",
    committedAt: f.clock.now().toISOString(),
    assignmentRecordVersion: 2,
    outcome: { kind: "bind", binding: request.binding },
  };
  for (const kind of ["applied", "exact-replay"]) {
    const result = await submitRuntimeBindingCandidate(
      request,
      {
        async bind() {
          return { schemaVersion: 1, result: kind, receipt };
        },
      },
      f.options.authorityCall,
      f.clock,
    );
    assert.equal(result.result, kind);
  }
  for (const change of [
    (r) => {
      r.operationRef = uuid(99);
    },
    (r) => {
      r.assignmentRef.id = uuid(99);
    },
    (r) => {
      r.canonicalPayloadDigest = `sha256:${"f".repeat(64)}`;
    },
    (r) => {
      r.assignmentRecordVersion = 999;
    },
    (r) => {
      r.outcome.binding.protectedRestartDiscriminator = "different-execution";
    },
  ]) {
    const altered = copy(receipt);
    change(altered);
    for (const kind of ["applied", "exact-replay"]) {
      const result = await submitRuntimeBindingCandidate(
        request,
        {
          async bind() {
            return { schemaVersion: 1, result: kind, receipt: altered };
          },
        },
        f.options.authorityCall,
        f.clock,
      );
      assert.equal(result.result, "commit-unknown");
      assert.deepEqual(copy(result.operation), copy(exactRuntimeAuthorityOperation(request)));
    }
  }
});

test("submission refuses a mismatched request or pre-submission abort without invoking authority", async () => {
  const f = bindingCandidateFixture();
  const request = await prepareRuntimeBindingCandidate(f.options);
  const authority = {
    bind() {
      assert.fail("authority must not be invoked");
    },
  };
  for (const call of [
    { ...f.options.authorityCall, requestRef: "request/other" },
    { ...f.options.authorityCall, signal: AbortSignal.abort() },
  ]) {
    const result = await submitRuntimeBindingCandidate(request, authority, call, f.clock);
    assert.equal(result.result, "rejected-before-effect");
  }
});
