import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  RepositoryWorkOriginOwnerV2,
  compareRepositoryWorkOriginAssignmentV2,
} from "../../packages/occ/src/runtime-authority/repository-work-origin-v2.ts";
import { RuntimeServiceTrustService } from "../../packages/occ/src/runtime-authority/service-trust.ts";
import {
  githubMetadataDigest,
  githubGitReadDigest,
  EMPTY_BODY_SHA256,
} from "../../packages/occ/src/github-mediation-v2/wire.ts";

const limits = {
  maximumOrigins: 1,
  maximumCallMilliseconds: 20,
  maximumOperationMilliseconds: 200,
  maximumLeaseMilliseconds: 100,
  clockAllowanceMilliseconds: 5,
};
const request = () => ({
  version: 2,
  sequence: 1,
  request_ref: "1".repeat(32),
  method: "open-read",
  attachment_ref: "attachment/original",
  repository_owner: "octocat",
  repository_name: "example",
  request_sha256: githubMetadataDigest("octocat", "example"),
});
const call = (signal = new AbortController().signal) => ({
  context: Object.freeze({}),
  requestRef: "1".repeat(32),
  recipientRef: "recipient/occ",
  deadline: new Date(Date.now() + 1000).toISOString(),
  signal,
});
const denied = () => {
  throw new Error("No authentic supplier selected.");
};
const delayTimerDelivery = () => {
  // Block this test thread only, allowing the supplier's promise microtask to
  // resume after Runtime's 20ms cutoff but before its timer callback can run.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 45);
};

function refusingOwner(native = {}, assignments = {}, protocolVersion = undefined) {
  // No native/State admission or positive registry is simulated. These failing
  // acquisition boundaries exercise Runtime's own refusal and late-cleanup logic.
  const trust = new RuntimeServiceTrustService({
    installationId: `ins_${randomUUID()}`,
    state: { read: denied },
    iam: denied,
    sources: [],
    validateProfile: denied,
  });
  return new RepositoryWorkOriginOwnerV2({
    protocolVersion,
    trust,
    limits,
    native: {
      acquire: async () => undefined,
      inspect: denied,
      assertCurrent: denied,
      release: async () => {},
      ...native,
    },
    assignments: {
      bindOrigins: () => undefined,
      acquire: denied,
      inspect: denied,
      assertCurrent: denied,
      release: denied,
      ...assignments,
    },
  });
}

function comparisonVector() {
  const installationId = `ins_${randomUUID()}`;
  const namespaceId = `ns_${randomUUID()}`;
  const agentId = `agt_${randomUUID()}`;
  const scope = { installationRef: installationId, namespaceRef: namespaceId, agentRef: agentId };
  const value = {
    original: {
      operationRef: "operation/1",
      requestDigest: request().request_sha256,
      invocationRef: "invocation/1",
      scope: { ...scope, revisionRef: `rev_${randomUUID()}` },
    },
    work: { workRef: "work/1", revision: 1 },
    execution: {
      attempt: {
        ...scope,
        conversationRef: "conversation/1",
        turnRef: "turn/1",
        attemptRef: "attempt/1",
        reservationRef: "reservation/1",
      },
      assignmentRef: "assignment/1",
      assignmentVersion: "1",
      executionIncarnationRef: "incarnation/1",
      executionGeneration: "1",
      receiverRef: "receiver/1",
      protectedOriginRef: "origin/1",
      executionProfile: { ref: "profile/1", revision: "1" },
      predecessor: { kind: "none" },
    },
    service: { id: "service/1", kind: "service_principal", namespaceId, agentId },
    attachmentRef: request().attachment_ref,
    repository: {
      id: "repository/1",
      owner: "octocat",
      name: "example",
      profile: { ref: "repository-profile/1", revision: "1" },
    },
    purpose: "work.repository.use",
    permission: "metadata:read",
    operationUntil: new Date(Date.now() + 10000).toISOString(),
    validUntil: new Date(Date.now() + 1000).toISOString(),
  };
  const verified = {
    configuration: {
      role: "repository-issuer",
      allowedScope: { kind: "agent", installationId, namespaceId, agentId },
    },
  };
  return { value, verified };
}

test("correspondence-only vectors preserve complete original execution without issuing an origin", () => {
  const { value, verified } = comparisonVector();
  const result = compareRepositoryWorkOriginAssignmentV2(value, request(), verified);
  assert.equal(result.execution.attempt.reservationRef, value.execution.attempt.reservationRef);
  assert.equal(result.execution.executionIncarnationRef, value.execution.executionIncarnationRef);
  assert.ok(Object.isFrozen(result.execution.attempt));
  value.execution.executionGeneration = "changed";
  assert.equal(result.execution.executionGeneration, "1");
});

test("original State constructor captures recognition once and metadata cannot retrieve an assignment", async () => {
  let recognizer;
  let bindings = 0;
  const owner = refusingOwner(
    {},
    {
      bindOrigins(value) {
        bindings++;
        recognizer = value;
      },
    },
  );
  assert.equal(bindings, 1);
  assert.ok(Object.isFrozen(recognizer));
  assert.throws(() => recognizer.recognize({}, call()));
  await owner.close();
  assert.throws(() => recognizer.recognize({}, call()));
});

test("an asynchronous supplier assertion refuses and its accepted continuation joins before release", async () => {
  let completeAssertion;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = new Promise((resolve) => {
    completeAssertion = resolve;
  });
  let released = 0;
  const owner = refusingOwner({
    acquire: async () => Object.freeze({}),
    assertCurrent: () => {
      entered();
      return pending;
    },
    release: async () => {
      released++;
    },
  });
  const acquisition = owner.acquire(request(), call());
  await started;
  assert.equal(await acquisition, undefined);
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(released, 0);
  completeAssertion();
  await closing;
  assert.equal(released, 1);
});

test("overdue supplier continuation is rejected before native assertion even when the timer is undelivered", async () => {
  let assertions = 0;
  let released = 0;
  let timerWasUndelivered = false;
  const owner = refusingOwner({
    async acquire(_request, call) {
      delayTimerDelivery();
      timerWasUndelivered = !call.signal.aborted;
      return Object.freeze({});
    },
    assertCurrent() {
      assertions++;
      denied();
    },
    release: async () => {
      released++;
    },
  });
  assert.equal(await owner.acquire(request(), call()), undefined);
  await owner.close();
  assert.equal(timerWasUndelivered, true);
  assert.equal(assertions, 0);
  assert.equal(released, 1);
});

test("time consumed by a synchronous supplier fence is checked before any inspection", async () => {
  let inspections = 0;
  let assertions = 0;
  let released = 0;
  let timerWasUndelivered = false;
  const owner = refusingOwner({
    acquire: async () => Object.freeze({}),
    assertCurrent(_session, call) {
      assertions++;
      delayTimerDelivery();
      timerWasUndelivered = !call.signal.aborted;
    },
    inspect() {
      inspections++;
      denied();
    },
    release: async () => {
      released++;
    },
  });
  assert.equal(await owner.acquire(request(), call()), undefined);
  await owner.close();
  assert.equal(timerWasUndelivered, true);
  assert.equal(assertions, 1);
  assert.equal(inspections, 0);
  assert.equal(released, 1);
});

test("synchronous cleanup failure remains held and closes further origin acquisition", async () => {
  let acquisitions = 0;
  let releases = 0;
  const owner = refusingOwner({
    acquire: async () => {
      acquisitions++;
      return Object.freeze({});
    },
    release: () => {
      releases++;
      throw new Error("Release failed");
    },
  });
  assert.equal(await owner.acquire(request(), call()), undefined);
  await assert.rejects(owner.close());
  assert.equal(await owner.acquire(request(), call()), undefined);
  assert.equal(acquisitions, 1);
  assert.equal(releases, 1);
});

test("correspondence rejects foreign scope, purpose, route, incomplete attempt and mutable accessors", () => {
  for (const alter of [
    (v) => {
      v.original.scope.agentRef = `agt_${randomUUID()}`;
    },
    (v) => {
      v.execution.attempt.installationRef = `ins_${randomUUID()}`;
    },
    (v) => {
      delete v.execution.attempt.reservationRef;
    },
    (v) => {
      v.attachmentRef = "attachment/foreign";
    },
    (v) => {
      v.repository.name = "foreign";
    },
    (v) => {
      v.purpose = "work.authority.renew";
    },
    (v) => {
      v.permission = "contents:read";
    },
    (v) => {
      v.service.kind = "principal";
    },
    (v) => {
      delete v.execution.receiverRef;
    },
    (v) => {
      v.execution.receiverRef += "\n";
    },
    (v) => {
      delete v.execution.predecessor;
    },
    (v) => {
      v.execution.predecessor = {
        kind: "terminated-original",
        attempt: v.execution.attempt,
        assignmentRef: "prior/1",
        executionIncarnationRef: "prior/1",
        terminationEvidenceRef: "prior/1",
      };
    },
    (v) => {
      v.validUntil = new Date(Date.parse(v.operationUntil) + 1).toISOString();
    },
  ]) {
    const { value, verified } = comparisonVector();
    alter(value);
    assert.throws(() => compareRepositoryWorkOriginAssignmentV2(value, request(), verified));
  }
  const { value, verified } = comparisonVector();
  let getterRan = false;
  Object.defineProperty(value, "attachmentRef", {
    enumerable: true,
    get() {
      getterRan = true;
      return request().attachment_ref;
    },
  });
  assert.throws(() => compareRepositoryWorkOriginAssignmentV2(value, request(), verified));
  assert.equal(getterRan, false);
});

test("bounded snapshots reject oversized data and accessors without entering suppliers", async () => {
  const { value, verified } = comparisonVector();
  value.repository.owner = "a".repeat(65537);
  assert.throws(() => compareRepositoryWorkOriginAssignmentV2(value, request(), verified));
  let called = false;
  const owner = refusingOwner({
    acquire: async () => {
      called = true;
      return undefined;
    },
  });
  for (const change of [
    (v) => {
      v.extra = "unexpected";
    },
    (v) => {
      v.attachment_ref += "\n";
    },
    (v) => {
      v.request_ref = "2".repeat(32);
    },
    (v) => {
      v.repository_owner = "a".repeat(65537);
    },
    (v) => {
      Object.defineProperty(v, "request_sha256", {
        enumerable: true,
        get() {
          throw new Error("getter invoked");
        },
      });
    },
  ]) {
    const v = request();
    change(v);
    assert.equal(await owner.acquire(v, call()), undefined);
  }
  assert.equal(called, false);
  await owner.close();
});

test("copied or fabricated origin objects cannot inspect, assert or release supplier custody", async () => {
  const owner = refusingOwner();
  for (const value of [{}, Object.freeze({ schemaVersion: 1 }), new Proxy({}, {})]) {
    await assert.rejects(owner.inspect(value, call()));
    assert.throws(() => owner.assertCurrent(value, call()));
    await assert.rejects(owner.release(value));
  }
  assert.equal(await owner.acquire(request(), call()), undefined);
  await owner.close();
});

test("cancelled acquisition retains and joins its late native lease before releasing it once", async () => {
  let finish;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const late = new Promise((resolve) => {
    finish = resolve;
  });
  const resource = Object.freeze({});
  const releases = [];
  const owner = refusingOwner({
    acquire: async () => {
      entered();
      return late;
    },
    release: async (value) => {
      releases.push(value);
    },
  });
  const cancelled = new AbortController();
  const result = owner.acquire(request(), call(cancelled.signal));
  await started;
  cancelled.abort();
  assert.equal(await result, undefined);
  let closed = false;
  const closure = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(await owner.acquire(request(), call()), undefined);
  finish(resource);
  await closure;
  assert.deepEqual(releases, [resource]);
  await owner.close();
  assert.deepEqual(releases, [resource]);
});

test("an already aborted call never enters a supplier acquisition", async () => {
  let acquisitions = 0;
  const owner = refusingOwner({
    acquire: async () => {
      acquisitions++;
      return undefined;
    },
  });
  const abort = new AbortController();
  abort.abort();
  assert.equal(await owner.acquire(request(), call(abort.signal)), undefined);
  assert.equal(acquisitions, 0);
  await owner.close();
});

const gitRequest = (operation = "upload-pack") => {
  const bodyBytes = operation === "discovery" ? 0 : 123;
  const bodySha256 = operation === "discovery" ? EMPTY_BODY_SHA256 : "sha256:" + "a".repeat(64);
  return {
    ...request(),
    version: 3,
    git_operation: operation,
    git_protocol: "version=2",
    body_bytes: bodyBytes,
    body_sha256: bodySha256,
    request_sha256: githubGitReadDigest("octocat", "example", operation, bodyBytes, bodySha256),
  };
};
function gitComparisonVector(declaration = gitRequest()) {
  const { value, verified } = comparisonVector();
  delete value.permission;
  value.operation = "git:read";
  value.requiredPermissions = ["contents:read", "metadata:read"];
  value.original.requestDigest = declaration.request_sha256;
  return { value, verified };
}

test("Git correspondence requires the original Git decision and both exact repository permissions", () => {
  for (const operation of ["discovery", "upload-pack"]) {
    const declaration = gitRequest(operation);
    const { value, verified } = gitComparisonVector(declaration);
    const result = compareRepositoryWorkOriginAssignmentV2(value, declaration, verified);
    assert.equal(result.operation, "git:read");
    assert.deepEqual([...result.requiredPermissions], ["contents:read", "metadata:read"]);
    assert.equal(result.original.requestDigest, declaration.request_sha256);
    assert.ok(Object.isFrozen(result.requiredPermissions));
  }
  for (const change of [
    (value) => {
      value.operation = "metadata:read";
    },
    (value) => {
      value.permission = "metadata:read";
    },
    (value) => {
      value.requiredPermissions = ["metadata:read"];
    },
    (value) => {
      value.requiredPermissions = ["contents:read"];
    },
    (value) => {
      value.requiredPermissions = ["contents:write", "metadata:read"];
    },
    (value) => {
      value.requiredPermissions.push("contents:read");
    },
    (value) => {
      value.repository.name = "different";
    },
    (value) => {
      value.original.requestDigest = request().request_sha256;
    },
  ]) {
    const { value, verified } = gitComparisonVector();
    change(value);
    assert.throws(() => compareRepositoryWorkOriginAssignmentV2(value, gitRequest(), verified));
  }
  const metadata = comparisonVector();
  metadata.value.original.requestDigest = gitRequest().request_sha256;
  assert.throws(() =>
    compareRepositoryWorkOriginAssignmentV2(metadata.value, gitRequest(), metadata.verified),
  );
  const git = gitComparisonVector(request());
  assert.throws(() => compareRepositoryWorkOriginAssignmentV2(git.value, request(), git.verified));
});

test("Git declaration and canonical digest retain the exact operation, protocol and outgoing body", async () => {
  let calls = 0;
  const owner = refusingOwner(
    {
      acquire: async () => {
        calls++;
        return undefined;
      },
    },
    {},
    3,
  );
  for (const change of [
    (value) => {
      value.body_bytes++;
    },
    (value) => {
      value.body_sha256 = "sha256:" + "b".repeat(64);
    },
    (value) => {
      value.git_operation = "discovery";
    },
    (value) => {
      value.git_protocol = "version=1";
    },
    (value) => {
      value.body_bytes = 4194305;
    },
    (value) => {
      value.version = 2;
    },
    (value) => {
      value.request_sha256 = request().request_sha256;
    },
    (value) => {
      value.method = "check-read";
    },
  ]) {
    const declaration = gitRequest();
    change(declaration);
    const { value, verified } = gitComparisonVector();
    assert.throws(() => compareRepositoryWorkOriginAssignmentV2(value, declaration, verified));
    assert.equal(await owner.acquire(declaration, call()), undefined);
  }
  assert.equal(calls, 0);
  const declaration = gitRequest("discovery");
  assert.equal(await owner.acquire(declaration, call()), undefined);
  assert.equal(calls, 1);
  await owner.close();
});

test("fixed original constructor selection cannot infer or switch versions from requests", async () => {
  for (const invalid of [null, 0, 4, "3"]) assert.throws(() => refusingOwner({}, {}, invalid));
  for (const version of [2, 3]) {
    let calls = 0;
    const owner = refusingOwner(
      {
        acquire: async () => {
          calls++;
          return undefined;
        },
      },
      {},
      version,
    );
    assert.equal(await owner.acquire(version === 2 ? gitRequest() : request(), call()), undefined);
    assert.equal(calls, 0);
    await owner.close();
  }
});

test("Git per-call cutoff still rejects overdue native acquisition and joins its original lease", async () => {
  let released = 0;
  let inspected = 0;
  const owner = refusingOwner(
    {
      async acquire() {
        delayTimerDelivery();
        return Object.freeze({});
      },
      inspect() {
        inspected++;
        denied();
      },
      release: async () => {
        released++;
      },
    },
    {},
    3,
  );
  assert.equal(await owner.acquire(gitRequest(), call()), undefined);
  await owner.close();
  assert.equal(inspected, 0);
  assert.equal(released, 1);
});

// Controlled internal peers exercise Runtime's own private origin-to-native
// association. They supply no real native authentication or State assignment.
async function controlledCustodyOrigin(version = 2, changes = {}) {
  const declaration = version === 3 ? gitRequest() : request();
  const { value, verified } = version === 3 ? gitComparisonVector(declaration) : comparisonVector();
  const context = Object.freeze({});
  const lifetime = new AbortController();
  const opening = new AbortController();
  const initial = { ...call(opening.signal), context };
  const session = Object.freeze({ fixture: "native-session" });
  const assignment = Object.freeze({ fixture: "state-assignment" });
  verified.configuration.permittedRecipientRef = initial.recipientRef;
  verified.configuration.serviceIdentityRef = "runtime-service/fixture";
  verified.transportBinding = Object.freeze({ fixture: "native-transport" });
  verified.expiresAt = new Date(Date.now() + 10000).toISOString();
  const record = {
    admission: {
      configuration: verified.configuration,
      profile: {
        operationPolicy: version === 3 ? "github-git-read-rpc-v3" : "github-metadata-rpc-v2",
        transportProfileRef:
          version === 3
            ? "owned-child-stdio-github-git-read-v3"
            : "owned-child-stdio-github-metadata-v2",
      },
    },
  };
  let bindings = 0;
  let recognizer;
  let nativeCurrent = true;
  let stateCurrent = true;
  let stateFence = () => undefined;
  let nativeFence = () => undefined;
  let nativeReleases = 0;
  let assignmentReleases = 0;
  const custody = {
    bindOrigins(value) {
      assert.equal(this, custody);
      bindings++;
      recognizer = value;
    },
  };
  const owner = new RepositoryWorkOriginOwnerV2({
    protocolVersion: version,
    trust: { readCurrentRecord: async () => record },
    limits: {
      ...limits,
      maximumCallMilliseconds: 500,
      maximumOperationMilliseconds: 3000,
      maximumLeaseMilliseconds: 900,
      ...changes,
    },
    nativeCustody: custody,
    native: {
      async acquire(selected) {
        assert.deepEqual({ ...selected }, declaration);
        return session;
      },
      async inspect(original) {
        assert.equal(original, session);
        return {
          context,
          verified,
          lifetime: lifetime.signal,
          sessionRef: "fixture/native-session",
        };
      },
      assertCurrent(original, actualCall) {
        assert.equal(original, session);
        assert.equal(actualCall.context, context);
        if (!nativeCurrent) denied();
        return nativeFence();
      },
      async release(original) {
        assert.equal(original, session);
        nativeCurrent = false;
        nativeReleases++;
      },
    },
    assignments: {
      bindOrigins: () => undefined,
      async acquire(selected, original) {
        assert.deepEqual({ ...selected }, declaration);
        assert.equal(original, session);
        return assignment;
      },
      async inspect(original) {
        assert.equal(original, assignment);
        return value;
      },
      assertCurrent(original) {
        assert.equal(original, assignment);
        if (!stateCurrent) denied();
        return stateFence();
      },
      async release(original) {
        assert.equal(original, assignment);
        assignmentReleases++;
      },
    },
  });
  const origin = await owner.acquire(declaration, initial);
  assert.ok(origin, "controlled Runtime component must create its own private origin");
  return {
    owner,
    origin,
    initial,
    session,
    lifetime,
    opening,
    custody,
    recognizer,
    bindings,
    get nativeReleases() {
      return nativeReleases;
    },
    get assignmentReleases() {
      return assignmentReleases;
    },
    invalidateNative() {
      nativeCurrent = false;
    },
    invalidateState() {
      stateCurrent = false;
    },
    setStateFence(value) {
      stateFence = value;
    },
    setNativeFence(value) {
      nativeFence = value;
    },
  };
}

test("construction custody receiver gets only its original retained Session for either version", async () => {
  for (const version of [2, 3]) {
    const f = await controlledCustodyOrigin(version);
    try {
      assert.equal(f.bindings, 1);
      assert.ok(Object.isFrozen(f.recognizer));
      assert.equal(f.owner.recognize, undefined);
      assert.equal(f.owner.bindOrigins, undefined);
      f.custody.bindOrigins = denied;
      assert.equal(f.recognizer.recognize(f.origin, f.initial), f.session);
      assert.throws(() => f.recognizer.recognize({ ...f.origin }, f.initial));
      assert.equal(f.recognizer.recognize(f.origin, f.initial), f.session);
      f.opening.abort();
      assert.equal(f.lifetime.signal.aborted, false);
      const next = {
        ...f.initial,
        signal: new AbortController().signal,
        deadline: new Date(Date.now() + 1000).toISOString(),
      };
      await f.owner.inspect(f.origin, next);
      assert.equal(f.recognizer.recognize(f.origin, next), f.session);
      await f.owner.release(f.origin);
      assert.throws(() => f.recognizer.recognize(f.origin, f.initial));
      assert.equal(f.nativeReleases, 1);
      assert.equal(f.assignmentReleases, 1);
    } finally {
      await f.owner.close();
    }
  }
});

test("custody recognizer preserves owner, call, native, State and lifetime currentness", async () => {
  for (const change of [
    (f, actual) => {
      actual.context = Object.freeze({});
    },
    (f, actual) => {
      actual.requestRef = "2".repeat(32);
    },
    (f, actual) => {
      actual.recipientRef = "recipient/foreign";
    },
    (f, actual) => {
      actual.signal = AbortSignal.abort();
    },
    (f, actual) => {
      actual.deadline = new Date(Date.now() + 10000).toISOString();
    },
    (f) => {
      f.invalidateNative();
    },
    (f) => {
      f.invalidateState();
    },
    (f) => {
      f.lifetime.abort();
    },
  ]) {
    const f = await controlledCustodyOrigin(3);
    try {
      const actual = { ...f.initial };
      change(f, actual);
      assert.throws(() => f.recognizer.recognize(f.origin, actual));
    } finally {
      await f.owner.close();
    }
    assert.equal(f.nativeReleases, 1);
  }
  const a = await controlledCustodyOrigin(2);
  const b = await controlledCustodyOrigin(2);
  try {
    assert.throws(() => a.recognizer.recognize(b.origin, a.initial));
    assert.equal(b.recognizer.recognize(b.origin, b.initial), b.session);
  } finally {
    await Promise.all([a.owner.close(), b.owner.close()]);
  }
});

test("custody recognition cannot reset an expired per-call cutoff before timer delivery", async () => {
  const f = await controlledCustodyOrigin(3, { maximumCallMilliseconds: 20 });
  try {
    delayTimerDelivery();
    assert.equal(f.initial.signal.aborted, false);
    assert.throws(() => f.recognizer.recognize(f.origin, f.initial));
  } finally {
    await f.owner.close();
  }
  assert.equal(f.nativeReleases, 1);
});

test("custody failed synchronous fence joins accepted continuation before borrowed Session release", async () => {
  const f = await controlledCustodyOrigin(3);
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  f.setStateFence(() => pending);
  assert.throws(() => f.recognizer.recognize(f.origin, f.initial));
  const closed = f.owner.close();
  await Promise.resolve();
  assert.equal(f.nativeReleases, 0);
  assert.equal(f.assignmentReleases, 0);
  finish();
  await closed;
  assert.equal(f.nativeReleases, 1);
  assert.equal(f.assignmentReleases, 1);
});

test("captured native-only fence crosses the SQL handoff without asserting State authority", async () => {
  for (const version of [2, 3]) {
    const f = await controlledCustodyOrigin(version);
    let stateAssertions = 0;
    const nativeOnly = f.owner.assertNativeCurrent.bind(f.owner);
    const full = f.owner.assertCurrent.bind(f.owner);
    f.owner.assertNativeCurrent = denied;
    f.setStateFence(() => {
      stateAssertions++;
      throw new Error("Initial SQL readset has retired.");
    });
    try {
      assert.equal(nativeOnly(f.origin, f.initial), undefined);
      assert.equal(stateAssertions, 0);
      assert.throws(() => full(f.origin, f.initial));
      assert.equal(stateAssertions, 1);
    } finally {
      await f.owner.close();
    }
  }
});

test("native-only handoff preserves the same origin for the separately reacquired State readset", async () => {
  const f = await controlledCustodyOrigin(3);
  let stateAssertions = 0;
  f.setStateFence(() => {
    stateAssertions++;
    throw new Error("SQL handoff gap.");
  });
  try {
    f.owner.assertNativeCurrent(f.origin, f.initial);
    assert.equal(stateAssertions, 0);
    // Controlled State peer models its own new same-operation readset. Runtime
    // does not acquire or authorize this transition through the native fence.
    f.setStateFence(() => {
      stateAssertions++;
    });
    f.owner.assertCurrent(f.origin, f.initial);
    assert.equal(stateAssertions, 1);
    assert.equal(f.recognizer.recognize(f.origin, f.initial), f.session);
  } finally {
    await f.owner.close();
  }
});

test("native-only handoff still refuses foreign origin, call, receiver and native lifetime", async () => {
  for (const change of [
    (f, actual) => {
      actual.context = Object.freeze({});
    },
    (f, actual) => {
      actual.requestRef = "2".repeat(32);
    },
    (f, actual) => {
      actual.recipientRef = "recipient/foreign";
    },
    (f, actual) => {
      actual.signal = AbortSignal.abort();
    },
    (f, actual) => {
      actual.deadline = new Date(Date.now() + 10000).toISOString();
    },
    (f) => {
      f.invalidateNative();
    },
    (f) => {
      f.lifetime.abort();
    },
  ]) {
    const f = await controlledCustodyOrigin(3);
    let stateAssertions = 0;
    f.setStateFence(() => {
      stateAssertions++;
      denied();
    });
    try {
      const actual = { ...f.initial };
      change(f, actual);
      assert.throws(() => f.owner.assertNativeCurrent(f.origin, actual));
      assert.equal(stateAssertions, 0);
    } finally {
      await f.owner.close();
    }
  }
  const a = await controlledCustodyOrigin(2);
  const b = await controlledCustodyOrigin(2);
  try {
    assert.throws(() => a.owner.assertNativeCurrent(b.origin, a.initial));
    assert.throws(() => a.owner.assertNativeCurrent({ ...a.origin }, a.initial));
    b.owner.assertNativeCurrent(b.origin, b.initial);
    await b.owner.release(b.origin);
    assert.throws(() => b.owner.assertNativeCurrent(b.origin, b.initial));
  } finally {
    await Promise.all([a.owner.close(), b.owner.close()]);
  }
});

test("native-only synchronous fence retains its monotonic cutoff without timer delivery", async () => {
  const f = await controlledCustodyOrigin(3, { maximumCallMilliseconds: 20 });
  f.setNativeFence(delayTimerDelivery);
  try {
    assert.throws(() => f.owner.assertNativeCurrent(f.origin, f.initial));
    assert.equal(f.initial.signal.aborted, false);
  } finally {
    await f.owner.close();
  }
  assert.equal(f.nativeReleases, 1);
});

test("native-only invalid asynchronous fence remains joined before original release", async () => {
  const f = await controlledCustodyOrigin(3);
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  f.setNativeFence(() => pending);
  assert.throws(() => f.owner.assertNativeCurrent(f.origin, f.initial));
  const closed = f.owner.close();
  await Promise.resolve();
  assert.equal(f.nativeReleases, 0);
  assert.equal(f.assignmentReleases, 0);
  finish();
  await closed;
  assert.equal(f.nativeReleases, 1);
  assert.equal(f.assignmentReleases, 1);
});
