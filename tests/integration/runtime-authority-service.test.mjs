import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { RuntimeAuthorityService } from "../../packages/occ/src/runtime-authority/service.ts";
import { exactRuntimeAuthorityOperation } from "../../packages/occ/src/runtime-authority/repository.ts";
import { seedAuthority } from "../fixtures/runtime-authority-state/seed.mjs";

test("actual runtime service denies forged JSON and plain admitted callers without a producer", async () => {
  const state = new InMemoryPlatformState();
  const f = await seedAuthority(state);
  const service = new RuntimeAuthorityService({
    store: state,
    installationId: f.target.installationId,
    recipientRef: "recipient/occ",
    clock: { now: () => new Date(), monotonicMilliseconds: () => performance.now() },
  });
  const initial = await f.record();
  // These are deliberately invalid values, never casts or fixture-minted trusted handles.
  for (const context of [
    { schemaVersion: 1 },
    { actorId: "service/key", role: "lifecycle-authority" },
    {
      schemaVersion: 1,
      trusted: true,
      serviceIdentityRef: "service/test-observer",
      allowedScope: f.target,
    },
  ]) {
    const call = {
      context,
      requestRef: f.bind.requestRef,
      recipientRef: "recipient/occ",
      deadline: new Date(Date.now() + 3000).toISOString(),
      signal: new AbortController().signal,
    };
    for (const [method, input] of [
      ["bind", f.bind],
      ["recordEvidence", f.evidence],
      ["retire", f.retire],
    ]) {
      const result = await service[method](input, call);
      assert.equal(result.result, "rejected-before-effect");
      assert.ok(!("receipt" in result));
    }
    const request = {
      schemaVersion: 1,
      installationId: f.target.installationId,
      namespaceId: f.target.namespaceId,
      agentId: f.target.agentId,
      assignmentRef: f.target.assignmentRef,
      requestRef: call.requestRef,
      purpose: "runtime-peer",
    };
    const resolved = await service.resolve(request, call);
    assert.equal(resolved.result, "not-visible");
    assert.deepEqual(Object.keys(resolved).sort(), [
      "evaluatedAt",
      "reasonCode",
      "requestRef",
      "result",
      "schemaVersion",
    ]);
    assert.equal(
      (await service.readOperation(exactRuntimeAuthorityOperation(f.bind), call)).result,
      "not-visible",
    );
    assert.deepEqual(await f.record(), initial);
    assert.equal(await f.operation(f.bind.operationRef), undefined);
  }
});

test("expired and cancelled actual service calls cannot mutate or expose retained operations", async () => {
  const state = new InMemoryPlatformState();
  const f = await seedAuthority(state);
  await f.append(f.bind);
  const service = new RuntimeAuthorityService({
    store: state,
    installationId: f.target.installationId,
    recipientRef: "recipient/occ",
    clock: { now: () => new Date(), monotonicMilliseconds: () => performance.now() },
  });
  const aborted = new AbortController();
  aborted.abort();
  for (const [deadline, signal] of [
    ["2000-01-01T00:00:00.000Z", new AbortController().signal],
    [new Date(Date.now() + 3000).toISOString(), aborted.signal],
  ]) {
    const call = {
      context: { schemaVersion: 1 },
      requestRef: f.bind.requestRef,
      recipientRef: "recipient/occ",
      deadline,
      signal,
    };
    assert.equal((await service.bind(f.bind, call)).result, "rejected-before-effect");
    const result = await service.readOperation(exactRuntimeAuthorityOperation(f.bind), call);
    assert.ok(["not-visible", "unavailable"].includes(result.result));
    assert.ok(!("receipt" in result));
  }
  assert.equal((await f.record()).authority.assignmentRecordVersion, 2);
});

test("runtime readback awaits an asynchronous unavailable inspection before reporting not-visible", async () => {
  const state = new InMemoryPlatformState();
  const f = await seedAuthority(state);
  await f.append(f.bind);
  const initial = await f.record();
  const inspection = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let registryReads = 0;
  const service = new RuntimeAuthorityService({
    store: state,
    installationId: f.target.installationId,
    recipientRef: "recipient/occ",
    clock: { now: () => new Date(), monotonicMilliseconds: () => performance.now() },
    // This controlled unavailable dependency tests asynchronous custody only. It never
    // authenticates a caller or creates a trusted context; real TLS coverage is separate.
    contextFactory: {
      inspect() {
        entered.resolve();
        return inspection.promise;
      },
    },
    currentTrust: {
      async readCurrent() {
        registryReads += 1;
        return undefined;
      },
    },
  });
  let settled = false;
  const result = service
    .readOperation(exactRuntimeAuthorityOperation(f.bind), {
      context: { schemaVersion: 1 },
      requestRef: f.bind.requestRef,
      recipientRef: "recipient/occ",
      deadline: new Date(Date.now() + 3000).toISOString(),
      signal: new AbortController().signal,
    })
    .then((value) => {
      settled = true;
      return value;
    });
  await entered.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(registryReads, 0);
  inspection.resolve(undefined);
  assert.deepEqual(await result, {
    schemaVersion: 1,
    result: "not-visible",
    reasonCode: "scope-hidden",
  });
  assert.equal(registryReads, 0);
  assert.deepEqual(await f.record(), initial);
});

test("cancellation ends runtime readback while an unavailable inspection is pending", async () => {
  const state = new InMemoryPlatformState();
  const f = await seedAuthority(state);
  await f.append(f.bind);
  const initial = await f.record();
  const inspection = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const cancellation = new AbortController();
  let registryReads = 0;
  const service = new RuntimeAuthorityService({
    store: state,
    installationId: f.target.installationId,
    recipientRef: "recipient/occ",
    clock: { now: () => new Date(), monotonicMilliseconds: () => performance.now() },
    // A pending unavailable inspector exercises the real service's cancellation bound;
    // there is no fabricated successful verifier or role decision in this fixture.
    contextFactory: {
      inspect() {
        entered.resolve();
        return inspection.promise;
      },
    },
    currentTrust: {
      async readCurrent() {
        registryReads += 1;
        return undefined;
      },
    },
  });
  const result = service.readOperation(exactRuntimeAuthorityOperation(f.bind), {
    context: { schemaVersion: 1 },
    requestRef: f.bind.requestRef,
    recipientRef: "recipient/occ",
    deadline: new Date(Date.now() + 3000).toISOString(),
    signal: cancellation.signal,
  });
  await entered.promise;
  cancellation.abort();
  assert.deepEqual(await result, {
    schemaVersion: 1,
    result: "unavailable",
    nextAction: "exact-readback-only",
  });
  inspection.resolve(undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registryReads, 0);
  assert.deepEqual(await f.record(), initial);
});
