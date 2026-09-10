import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createRepositoryWorkNativeExecutionSourceV2 } from "../../packages/occ/src/runtime-authority/repository-work-selected-execution-v2.ts";
import {
  decodeGitHubMediationRequest,
  githubMetadataDigest,
  githubGitReadDigest,
  EMPTY_BODY_SHA256,
} from "../../packages/occ/src/github-mediation-v2/wire.ts";

// Component tests use controlled native, registry and accepting-owner peers.
// They exercise the real Runtime consumer; they do not qualify a native child,
// journal COMMIT, first Work admission, PostgreSQL, custody or deployment.
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const digest = "a".repeat(64);
function fixture(version = 2, limits = {}) {
  const installationId = `ins_${randomUUID()}`;
  const namespaceId = `ns_${randomUUID()}`;
  const agentId = `agt_${randomUUID()}`;
  const revisionRef = `rev_${randomUUID()}`;
  const scope = {
    installationRef: installationId,
    namespaceRef: namespaceId,
    agentRef: agentId,
    revisionRef,
  };
  const now = Date.now();
  const until = new Date(now + 60000).toISOString();
  const context = Object.freeze({});
  const session = Object.freeze({});
  const originalH = Object.freeze({});
  const transportBinding = Object.freeze({});
  const lifetime = new AbortController();
  const opening = new AbortController();
  const call = {
    context,
    requestRef: "1".repeat(32),
    recipientRef: "repository/receiver",
    deadline: new Date(now + 5000).toISOString(),
    signal: opening.signal,
  };
  const request = {
    version,
    sequence: 1,
    request_ref: call.requestRef,
    method: "open-read",
    attachment_ref: "attachment/1",
    repository_owner: "octocat",
    repository_name: "example",
    request_sha256:
      version === 2
        ? githubMetadataDigest("octocat", "example")
        : githubGitReadDigest("octocat", "example", "discovery", 0, EMPTY_BODY_SHA256),
    ...(version === 3
      ? {
          git_operation: "discovery",
          git_protocol: "version=2",
          body_bytes: 0,
          body_sha256: EMPTY_BODY_SHA256,
        }
      : {}),
  };
  const expectedRequest = decodeGitHubMediationRequest(
    Buffer.from(JSON.stringify(request)),
    version,
  );
  assert.ok(expectedRequest);
  const attempt = {
    installationRef: installationId,
    namespaceRef: namespaceId,
    agentRef: agentId,
    conversationRef: "conversation/1",
    turnRef: "turn/1",
    attemptRef: "attempt/1",
    reservationRef: "reservation/1",
  };
  const selected = {
    attempt,
    dispatchOperationRef: "dispatch/1",
    executionRef: "execution/1",
    recipientRef: "harness/receiver",
    consumption: {
      schemaVersion: 1,
      attempt,
      operationRef: "consumption/1",
      claimantRef: "claimant/1",
      requestDigest: digest,
    },
  };
  const intent = {
    execution: selected,
    operationRef: "intent/1",
    operationDigest: digest,
    executionLimitRef: "limit/1",
    executionLimitVersion: 1,
    maximumExecutionMs: 60000,
    dispatchClock: {
      kind: "pre-commit-monotonic-v2",
      clockSourceRef: "clock/1",
      clockEpochRef: "epoch/1",
      anchorAtMs: now,
    },
  };
  const control = {
    kind: "host-stop-v2",
    intent,
    operationRef: "deadline/1",
    operationDigest: digest,
    nativeIncarnationRef: "native-incarnation/1",
    nativeConstructionRef: "construction/1",
    responsibilityRef: "responsibility/1",
    responsibilityVersion: 1,
    deadlineAtMs: now + 60000,
  };
  const original = Object.freeze({
    operationRef: "admission/1",
    requestDigest: request.request_sha256,
    invocationRef: "invocation/1",
    scope,
  });
  let data = {
    start: {
      kind: "host-controlled-v2",
      intent,
      operationRef: "start/1",
      operationDigest: digest,
      nativeExecutionRef: "native-execution/1",
      nativeIncarnationRef: "native-incarnation/1",
      nativeReservationRef: "native-reservation/1",
      nativeSessionRef: "hosted-session/1",
      nativeTurnRef: "native-turn/1",
      acceptanceEvidenceRef: "ready/1",
      deadlineControl: control,
    },
    execution: {
      attempt,
      assignmentRef: "assignment/1",
      assignmentVersion: "1",
      executionIncarnationRef: "incarnation/1",
      executionGeneration: "1",
      receiverRef: "harness/receiver",
      protectedOriginRef: "execution-origin/1",
      executionProfile: { ref: "execution-profile/1", revision: "1" },
      predecessor: { kind: "none" },
    },
    runtime: {
      target: {
        installationId,
        namespaceId,
        agentId,
        revisionId: revisionRef,
        component: "harness",
        assignmentRef: { id: "assignment/1", version: 1 },
        createEffectRef: "create/1",
        lifecycleGeneration: 1,
        runtimeProfileRef: "runtime/1",
      },
      preparationRef: "preparation/1",
      preparationVersion: 1,
      childEffectRef: "create/1",
    },
    service: { kind: "service_principal", id: "service/1", namespaceId, agentId },
    requesterPrincipalId: "principal/1",
    admission: {
      original,
      membershipProfile: { ref: "membership/1", revision: "1" },
      mode: { kind: "admit-root" },
      workBeganAt: new Date(now).toISOString(),
      originalHorizon: until,
      policyRef: "policy/1",
    },
    attachmentRef: request.attachment_ref,
    dnsBindingRef: "dns/1",
    upstreamIpv4: "192.0.2.10",
    validUntil: until,
  };
  const configuration = {
    installationId,
    serviceIdentityRef: "runtime-service/fixture",
    role: "repository-issuer",
    allowedScope: { kind: "agent", installationId, namespaceId, agentId },
    permittedRecipientRef: call.recipientRef,
  };
  let registry = {
    admission: {
      configuration,
      profile: {
        operationPolicy: version === 3 ? "github-git-read-rpc-v3" : "github-metadata-rpc-v2",
        transportProfileRef:
          version === 3
            ? "owned-child-stdio-github-git-read-v3"
            : "owned-child-stdio-github-metadata-v2",
      },
    },
  };
  let latest = call;
  let nativeCurrent = true;
  let acceptedCurrent = true;
  let acquireHook = async () => {};
  let inspectHook = async () => {};
  let assertHook = () => undefined;
  let prepareHook = async () => {};
  let retainHook = async () => {};
  const counts = {
    acquired: 0,
    released: 0,
    nativeReleased: 0,
    retained: 0,
    heldReleased: 0,
    registryReads: 0,
  };
  const native = {
    async acquire() {
      return session;
    },
    async inspect(n, c) {
      assert.equal(this, native);
      assert.equal(n, session);
      assert.equal(c.context, context);
      assert.equal(c.requestRef, call.requestRef);
      assert.equal(c.recipientRef, call.recipientRef);
      assert.ok(nativeCurrent && !lifetime.signal.aborted && !c.signal.aborted);
      await inspectHook(c);
      latest = c;
      return {
        context,
        verified: {
          configuration,
          transportBinding,
          authenticatedAt: new Date(now).toISOString(),
          expiresAt: until,
          peerEvidenceRef: "peer/1",
        },
        lifetime: lifetime.signal,
        sessionRef: "github-native/original",
      };
    },
    assertCurrent(n, c) {
      assert.equal(this, native);
      assert.equal(n, session);
      assert.equal(c, latest);
      assert.ok(nativeCurrent && !lifetime.signal.aborted && !c.signal.aborted);
    },
    async release() {
      counts.nativeReleased++;
    },
  };
  const accepted = {
    async acquire(n, r, c) {
      assert.equal(this, accepted);
      assert.equal(n, session);
      assert.deepEqual(r, expectedRequest);
      counts.acquired++;
      await acquireHook(c);
      return {
        original: originalH,
        inspect: () => data,
        assertCurrent(c) {
          assert.equal(c, latest);
          assert.ok(acceptedCurrent);
          return assertHook(c);
        },
        async release() {
          counts.released++;
        },
      };
    },
    async retain(unit, h, n, c) {
      assert.equal(this, accepted);
      assert.equal(h, originalH);
      assert.equal(n, session);
      counts.retained++;
      await retainHook(c);
      return {
        assertCurrent() {
          assert.ok(acceptedCurrent);
        },
        prepareCommit: () => prepareHook(),
        async release() {
          counts.heldReleased++;
        },
      };
    },
  };
  const trust = {
    async readCurrentRecord() {
      counts.registryReads++;
      return registry;
    },
  };
  const source = createRepositoryWorkNativeExecutionSourceV2({
    protocolVersion: version,
    native,
    accepted,
    trust,
    limits: {
      maximumBorrows: 2,
      maximumCallMilliseconds: 1000,
      clockAllowanceMilliseconds: 5,
      ...limits,
    },
  });
  const contexts = new WeakMap();
  const joined = new Set();
  const participant = {
    assertOriginal(unit, e, n, c) {
      const expected = contexts.get(unit);
      assert.ok(expected);
      assert.equal(expected.e, e);
      assert.equal(n, session);
      assert.equal(expected.call, c);
    },
  };
  source.bindState(participant);
  function stateContext(lease, c = call) {
    const unit = {
      installationId,
      assertActive() {
        assert.ok(contexts.has(unit));
      },
      retain() {},
      joinAccepted(promise) {
        assert.ok(contexts.has(unit));
        joined.add(promise);
        void promise.then(
          () => joined.delete(promise),
          () => joined.delete(promise),
        );
      },
    };
    contexts.set(unit, { e: lease.original, call: c });
    return unit;
  }
  return {
    source,
    native,
    accepted,
    session,
    call,
    request,
    original,
    originalH,
    counts,
    lifetime,
    opening,
    participant,
    stateContext,
    joined,
    get data() {
      return data;
    },
    set data(value) {
      data = value;
    },
    get registry() {
      return registry;
    },
    set registry(value) {
      registry = value;
    },
    set acquireHook(value) {
      acquireHook = value;
    },
    set inspectHook(value) {
      inspectHook = value;
    },
    set assertHook(value) {
      assertHook = value;
    },
    set prepareHook(value) {
      prepareHook = value;
    },
    set retainHook(value) {
      retainHook = value;
    },
    withdrawNative() {
      nativeCurrent = false;
    },
    withdrawAccepted() {
      acceptedCurrent = false;
    },
  };
}

for (const version of [2, 3]) {
  test(`Runtime native execution V${version} preserves original admission identity and privately binds N/H/E`, async () => {
    const f = fixture(version);
    const lease = await f.source.acquire(f.session, f.request, f.call);
    assert.ok(lease);
    assert.notEqual(lease.original, f.originalH);
    assert.equal(lease.inspect().admission.original, f.original);
    assert.ok(Object.isFrozen(lease.inspect().execution));
    lease.assertCurrent(f.call);
    const unit = f.stateContext(lease);
    const held = await f.source.retain(unit, lease.original, f.session, f.call);
    held.assertCurrent();
    await held.prepareCommit();
    await held.release();
    await lease.release();
    await f.source.close();
    assert.equal(f.counts.acquired, 1);
    assert.equal(f.counts.released, 1);
    assert.equal(f.counts.heldReleased, 1);
    assert.equal(f.counts.nativeReleased, 0);
  });
}

test("copied E, foreign Session and copied State context cannot borrow retained execution", async () => {
  const f = fixture();
  const lease = await f.source.acquire(f.session, f.request, f.call);
  const unit = f.stateContext(lease);
  await assert.rejects(f.source.retain(unit, { ...lease.original }, f.session, f.call));
  await assert.rejects(f.source.retain(unit, lease.original, {}, f.call));
  await assert.rejects(f.source.retain({ ...unit }, lease.original, f.session, f.call));
  assert.equal(f.counts.retained, 0);
  await lease.release();
  await f.source.close();
});

test("State binding and original constructor receivers are captured once", async () => {
  const f = fixture();
  assert.throws(() => f.source.bindState(f.participant));
  f.accepted.acquire = () => {
    throw new Error("replacement was called");
  };
  f.native.inspect = () => {
    throw new Error("replacement was called");
  };
  const lease = await f.source.acquire(f.session, f.request, f.call);
  assert.ok(lease);
  await lease.release();
  await f.source.close();
});

test("read profile/version mismatch and Git body digest mismatch refuse before accepting-owner acquisition", async () => {
  for (const change of [
    (f) => {
      f.registry.admission.profile.operationPolicy = "github-publication-rpc-v1";
    },
    (f) => {
      f.registry.admission.profile.transportProfileRef = "owned-child-stdio-github-metadata-v2";
    },
    (f) => {
      f.request.body_bytes = 1;
    },
    (f) => {
      f.request.body_sha256 = "sha256:" + "b".repeat(64);
    },
    (f) => {
      f.request.version = 2;
    },
  ]) {
    const f = fixture(3);
    change(f);
    await assert.rejects(f.source.acquire(f.session, f.request, f.call));
    assert.equal(f.counts.acquired, 0);
    await f.source.close();
  }
});

test("crossed original attempt, scope, attachment and Runtime assignment never create E", async () => {
  for (const change of [
    (d) => {
      d.execution = {
        ...d.execution,
        attempt: { ...d.execution.attempt, attemptRef: "attempt/other" },
      };
    },
    (d) => {
      d.runtime.target.assignmentRef.id = "assignment/other";
    },
    (d) => {
      d.attachmentRef = "attachment/other";
    },
    (d) => {
      d.service.agentId = "agt_" + randomUUID();
    },
  ]) {
    const f = fixture();
    change(f.data);
    await assert.rejects(f.source.acquire(f.session, f.request, f.call));
    assert.equal(f.counts.released, 1);
    await f.source.close();
  }
});

test("later original admission substitution and changed current registry irreversibly refuse", async () => {
  const f = fixture();
  const lease = await f.source.acquire(f.session, f.request, f.call);
  f.data = { ...f.data, admission: { ...f.data.admission, original: { ...f.original } } };
  assert.throws(() => lease.assertCurrent(f.call));
  await lease.release();
  await f.source.close();
  const g = fixture();
  const next = await g.source.acquire(g.session, g.request, g.call);
  g.registry = { ...g.registry, revision: 2 };
  await assert.rejects(g.source.retain(g.stateContext(next), next.original, g.session, g.call));
  await next.release();
  await g.source.close();
});

test("successful opening call abort does not replace the independent native execution lifetime", async () => {
  const f = fixture();
  const lease = await f.source.acquire(f.session, f.request, f.call);
  f.opening.abort();
  const next = {
    ...f.call,
    deadline: new Date(Date.now() + 4500).toISOString(),
    signal: new AbortController().signal,
  };
  // State's original native inspector authenticates the fresh Exchange first.
  await f.native.inspect(f.session, next);
  lease.assertCurrent(next);
  const held = await f.source.retain(f.stateContext(lease, next), lease.original, f.session, next);
  await held.release();
  await lease.release();
  await f.source.close();
  assert.equal(f.counts.nativeReleased, 0);
});

test("wrong call identity and withdrawn accepting owner both refuse currentness", async () => {
  for (const change of [
    (f) => ({ ...f.call, context: {} }),
    (f) => ({ ...f.call, requestRef: "2".repeat(32) }),
    (f) => ({ ...f.call, recipientRef: "receiver/other" }),
    (f) => {
      f.withdrawAccepted();
      return f.call;
    },
    (f) => {
      f.withdrawNative();
      return f.call;
    },
  ]) {
    const f = fixture();
    const lease = await f.source.acquire(f.session, f.request, f.call);
    assert.throws(() => lease.assertCurrent(change(f)));
    await lease.release();
    await f.source.close();
  }
});

test("late accepting acquisition cleanup is captured and joined after cancellation", async () => {
  const f = fixture();
  const entered = deferred();
  const gate = deferred();
  f.acquireHook = async () => {
    entered.resolve();
    await gate.promise;
  };
  const acquiring = f.source.acquire(f.session, f.request, f.call);
  await entered.promise;
  f.opening.abort();
  let closed = false;
  const closing = f.source.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(f.counts.released, 0);
  gate.resolve();
  await assert.rejects(acquiring);
  await closing;
  assert.equal(f.counts.released, 1);
});

test("monotonic call cutoff refuses an overdue supplier before delayed timer delivery", async () => {
  const f = fixture(2, { maximumCallMilliseconds: 40, clockAllowanceMilliseconds: 0 });
  f.acquireHook = async () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 85);
  };
  await assert.rejects(f.source.acquire(f.session, f.request, f.call));
  assert.equal(f.counts.released, 1);
  await f.source.close();
});

test("accepted State preparation drains before held and execution borrow release", async () => {
  const f = fixture();
  const lease = await f.source.acquire(f.session, f.request, f.call);
  const held = await f.source.retain(f.stateContext(lease), lease.original, f.session, f.call);
  const entered = deferred();
  const gate = deferred();
  f.prepareHook = async () => {
    entered.resolve();
    await gate.promise;
  };
  const preparing = held.prepareCommit();
  await entered.promise;
  const releasing = held.release();
  const retiring = lease.release();
  await Promise.resolve();
  assert.equal(f.counts.heldReleased, 0);
  assert.equal(f.counts.released, 0);
  gate.resolve();
  await assert.rejects(preparing);
  await releasing;
  await retiring;
  await f.source.close();
  assert.equal(f.counts.heldReleased, 1);
  assert.equal(f.counts.released, 1);
});

test("unexpected asynchronous E assertion joins the active original State context before refusal", async () => {
  const f = fixture();
  const lease = await f.source.acquire(f.session, f.request, f.call);
  const held = await f.source.retain(f.stateContext(lease), lease.original, f.session, f.call);
  const gate = deferred();
  f.assertHook = () => gate.promise;
  assert.throws(() => lease.assertCurrent(f.call));
  assert.ok(f.joined.has(gate.promise));
  const heldClosing = held.release();
  const closing = lease.release();
  await Promise.resolve();
  assert.equal(f.counts.heldReleased, 0);
  assert.equal(f.counts.released, 0);
  gate.resolve();
  await heldClosing;
  await closing;
  await f.source.close();
  assert.equal(f.counts.released, 1);
});

test("native lifetime loss invalidates E immediately but retains a pending original State borrow", async () => {
  const f = fixture();
  const lease = await f.source.acquire(f.session, f.request, f.call);
  const entered = deferred();
  const gate = deferred();
  f.retainHook = async () => {
    entered.resolve();
    await gate.promise;
  };
  const retaining = f.source.retain(f.stateContext(lease), lease.original, f.session, f.call);
  await entered.promise;
  f.lifetime.abort();
  assert.throws(() => lease.assertCurrent(f.call));
  let closed = false;
  const closing = f.source.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(f.counts.released, 0);
  gate.resolve();
  await assert.rejects(retaining);
  await closing;
  assert.equal(f.counts.heldReleased, 1);
  assert.equal(f.counts.released, 1);
});
