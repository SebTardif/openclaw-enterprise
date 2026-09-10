import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubMediationService } from "../../packages/occ/src/github-mediation-v2/service.ts";
import { trust } from "../fixtures/runtime-authority-v1/vectors.mjs";
import {
  RepositoryWorkOperationOwnerV2,
  repositoryWorkGitReadBindingV3,
  compareRepositoryWorkCurrentV2,
} from "../../packages/occ/src/lifecycle/repository-work-v2.ts";
import {
  githubMetadataDigest,
  githubGitReadDigest,
  encodeGitHubMediationMetadata,
} from "../../packages/occ/src/github-mediation-v2/wire.ts";

// Component tests of the actual Work owner. Internal State/native/custody peers
// below are explicitly synthetic: they exercise sequencing and refusal, not
// authenticated Work admission, database COMMIT or a complete production flow.
const copy = (value) => structuredClone(value);
const open = Object.freeze({
  version: 2,
  sequence: 1,
  method: "open-read",
  request_ref: "1".repeat(32),
  attachment_ref: "attachment/one",
  repository_owner: "example",
  repository_name: "project",
  request_sha256: githubMetadataDigest("example", "project"),
});

// Actual bytes used only to form the controlled request declaration. These tests
// do not establish native retention, upstream transmission, or Git object output.
const gitBody = Buffer.from("0014command=ls-refs\n00010009peel\n000csymrefs\n0000");
function gitOpen(operation = "upload-pack") {
  const body = operation === "discovery" ? Buffer.alloc(0) : gitBody;
  const bodySha = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  return Object.freeze({
    ...open,
    version: 3,
    git_operation: operation,
    git_protocol: "version=2",
    body_bytes: body.length,
    body_sha256: bodySha,
    request_sha256: githubGitReadDigest(
      open.repository_owner,
      open.repository_name,
      operation,
      body.length,
      bodySha,
    ),
  });
}
function gitBinding(request) {
  return {
    version: 3,
    operation: "git:read",
    gitOperation: request.git_operation,
    gitProtocol: request.git_protocol,
    bodyBytes: request.body_bytes,
    bodySha256: request.body_sha256,
    requestDigest: request.request_sha256,
  };
}
const metadataOpen = open;
const preparedRequests = new WeakMap();
const limits = {
  maximumPreparations: 4,
  maximumOperationMilliseconds: 10_000,
  maximumLeaseMilliseconds: 5_000,
  clockAllowanceMilliseconds: 0,
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

function fixture(t, overrides = {}, options = {}) {
  const selectedRequest = options.request ?? metadataOpen;
  const version = options.version ?? 2;
  const open = selectedRequest;
  const context = Object.freeze({ controlled: "context" });
  const transportBinding = Object.freeze({ controlled: "transport" });
  const origin = Object.freeze({ controlled: "origin" });
  const preparation = Object.freeze({ controlled: "State preparation" });
  const token = Object.freeze({ controlled: "token handle, no material" });
  const commit = Object.freeze({ controlled: "COMMIT receipt" });
  const end = new Date(Date.now() + 9_000).toISOString();
  const scope = {
    installationRef: "installation/one",
    namespaceRef: "namespace/one",
    agentRef: "agent/one",
    revisionRef: "revision/one",
  };
  const profile = { ref: "profile/one", revision: "1" };
  const work = { workRef: "work/one", revision: 1 };
  const service = {
    kind: "service_principal",
    id: "service/one",
    namespaceId: scope.namespaceRef,
    agentId: scope.agentRef,
  };
  const execution = {
    attempt: {
      installationRef: scope.installationRef,
      namespaceRef: scope.namespaceRef,
      agentRef: scope.agentRef,
      conversationRef: "conversation/one",
      turnRef: "turn/one",
      attemptRef: "attempt/one",
      reservationRef: "reservation/one",
    },
    assignmentRef: "assignment/one",
    assignmentVersion: "1",
    executionIncarnationRef: "incarnation/one",
    executionGeneration: "1",
    receiverRef: "receiver/one",
    protectedOriginRef: "origin/one",
    executionProfile: profile,
    predecessor: { kind: "none" },
  };
  const current = {
    original: {
      operationRef: "operation/one",
      requestDigest: open.request_sha256,
      invocationRef: "invocation/one",
      scope,
    },
    work,
    execution,
    lineage: {
      scope,
      own: { work, originalHorizon: end, state: "open", withdrawalRevision: 0 },
      membershipProfile: profile,
      kind: "root",
      rootWorkRef: work.workRef,
      parentWorkRef: null,
      ancestors: [],
    },
    withdrawals: [{ kind: "not-withdrawn-at-cut", revision: 0 }],
    service,
    originalHorizon: end,
    repository: { id: "repository/one", owner: "example", name: "project", profile },
    policy: {
      operation: "work.repository.use",
      service,
      repositoryId: "repository/one",
      profile,
      ...(version === 3
        ? {
            repositoryOperation: "git:read",
            requiredPermissions: ["contents:read", "metadata:read"],
          }
        : { permission: "metadata:read" }),
    },
    ...(version === 3 ? { repositoryRequest: gitBinding(open) } : {}),
    attachmentRef: open.attachment_ref,
    dnsBindingRef: "dns/one",
    upstreamIpv4: "140.82.114.5",
    validUntil: end,
  };
  const native = {
    context,
    transportBinding,
    receiverRef: execution.receiverRef,
    attachmentRef: open.attachment_ref,
    execution: copy(execution),
    service: copy(service),
  };
  const events = [],
    writes = [],
    observations = [];
  const hooks = {};
  const call = (abort = new AbortController()) => ({
    context,
    signal: abort.signal,
    requestRef: open.request_ref,
    recipientRef: execution.receiverRef,
    deadline: new Date(Date.now() + 8_000).toISOString(),
  });
  const recognize = (actual, expected) =>
    assert.equal(actual, expected, "controlled peer original object");
  const sources = {
    native: {
      async acquire(request, c) {
        events.push("acquire");
        recognize(c.context, context);
        await hooks.acquire?.(c);
        return origin;
      },
      async inspect(o, c) {
        recognize(o, origin);
        events.push("inspect");
        await hooks.inspect?.(c);
        return native;
      },
      assertCurrent(o, c) {
        recognize(o, origin);
        events.push("fence");
        return hooks.fence?.(c);
      },
      async release(o) {
        recognize(o, origin);
        events.push("release-origin");
        await hooks.release?.();
      },
    },
    state: {
      async prepare(o, request, c) {
        recognize(o, origin);
        events.push("prepare");
        await hooks.prepare?.(c);
        return preparation;
      },
      async readPreparationOriginal(p, o, c) {
        recognize(p, preparation);
        recognize(o, origin);
        const original = { ...copy(current.original), operationRef: "operation/preparation" };
        return hooks.preparationOriginal ? await hooks.preparationOriginal(original, c) : original;
      },
      async readCurrent(p, o, c) {
        recognize(p, preparation);
        recognize(o, origin);
        events.push("read");
        await hooks.read?.(c);
        return current;
      },
      async commitDispatch(p, o, tok, request, expected, c) {
        recognize(p, preparation);
        recognize(o, origin);
        recognize(tok, token);
        events.push("commit");
        const result = await hooks.commit?.(c, expected);
        return result ?? { kind: "committed", receipt: commit };
      },
      inspectCommitted(r, p, tok) {
        recognize(r, commit);
        recognize(p, preparation);
        recognize(tok, token);
        events.push("recognize-commit");
        return hooks.committed?.() ?? { releaseRef: "release/one" };
      },
      async settle(p, r, outcome) {
        recognize(p, preparation);
        if (r !== undefined) recognize(r, commit);
        events.push("settle");
        observations.push({ committed: r === commit, outcome });
        await hooks.settle?.();
        return "recorded";
      },
    },
    custody: {
      async prepareToken(p, o, c) {
        recognize(p, preparation);
        recognize(o, origin);
        events.push("mint");
        await hooks.mint?.(c);
        return token;
      },
      async writeCommitted(r, bytes, c) {
        recognize(r, commit);
        events.push("write");
        writes.push(new Uint8Array(bytes));
        await hooks.write?.(c);
      },
      async settleToken(tok) {
        recognize(tok, token);
        events.push("settle-token");
        await hooks.tokenRelease?.();
      },
    },
  };
  const owner = new RepositoryWorkOperationOwnerV2(
    sources,
    { ...limits, ...overrides },
    { protocolVersion: version },
  );
  t.after(() => owner.stop());
  return {
    owner,
    current,
    native,
    sources,
    context,
    call,
    hooks,
    events,
    writes,
    observations,
    open,
    version,
  };
}
async function prepared(f) {
  const p = await f.owner.prepare(f.open, f.call());
  assert.equal(p.kind, "prepared");
  preparedRequests.set(p, f.open);
  return p;
}
function dispatchRequest(p) {
  const open = preparedRequests.get(p) ?? metadataOpen;
  return {
    version: open.version,
    sequence: 2,
    method: "dispatch-read",
    request_ref: open.request_ref,
    session_ref: "2".repeat(32),
    effect_ref: p.original.operationRef,
    work_binding_sha256: p.workBindingSha256,
    request_sha256: open.request_sha256,
    dns_binding_ref: p.dnsBindingRef,
    upstream_ipv4: p.upstreamIpv4,
    peer_certificate_sha256: `sha256:${"3".repeat(64)}`,
  };
}
function metadata(p, r, d = dispatchRequest(p)) {
  return encodeGitHubMediationMetadata({
    version: d.version,
    request_ref: d.request_ref,
    session_ref: d.session_ref,
    effect_ref: d.effect_ref,
    work_binding_sha256: d.work_binding_sha256,
    request_sha256: d.request_sha256,
    sequence: 2,
    ...r.times,
    ok: true,
    phase: "dispatch-once",
    dns_binding_ref: d.dns_binding_ref,
    upstream_ipv4: d.upstream_ipv4,
    peer_certificate_sha256: d.peer_certificate_sha256,
    release_ref: r.releaseRef,
  });
}
async function released(f, p) {
  const r = await f.owner.dispatch(p.preparation, dispatchRequest(p), f.call());
  assert.equal(r.kind, "released");
  return r;
}

test("actual Work owner sequences private preparation, one committed release, currentness and joined cleanup with controlled peers", async (t) => {
  const f = fixture(t),
    p = await prepared(f),
    r = await released(f, p);
  await f.owner.writeRelease(r.release, metadata(p, r), f.call());
  assert.equal((await f.owner.check(p.preparation, r.release, f.call())).kind, "current");
  assert.equal(await f.owner.settle(p.preparation, r.release, "completed"), "recorded");
  assert.equal(f.events.filter((x) => x === "mint").length, 1);
  assert.equal(f.events.filter((x) => x === "commit").length, 1);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.observations, [{ committed: true, outcome: "completed" }]);
  assert.deepEqual(f.events.slice(-3), ["settle", "settle-token", "release-origin"]);
});

for (const [name, alter] of [
  [
    "execution from another Agent",
    (f) => {
      f.current.execution.attempt.agentRef = "agent/other";
      f.native.execution.attempt.agentRef = "agent/other";
    },
  ],
  [
    "execution from another Installation",
    (f) => {
      f.current.execution.attempt.installationRef = "installation/other";
      f.native.execution.attempt.installationRef = "installation/other";
    },
  ],
  [
    "closed Work",
    (f) => {
      f.current.lineage.own.state = "closed";
    },
  ],
  [
    "withdrawn Work",
    (f) => {
      f.current.withdrawals[0] = {
        kind: "withdrawn",
        revision: 1,
        withdrawalRef: "withdrawal/one",
      };
    },
  ],
  [
    "zero Work revision",
    (f) => {
      f.current.work.revision = 0;
    },
  ],
  [
    "negative withdrawal revision",
    (f) => {
      f.current.lineage.own.withdrawalRevision = -1;
      f.current.withdrawals[0].revision = -1;
    },
  ],
  [
    "empty repository identity",
    (f) => {
      f.current.repository.id = "";
      f.current.policy.repositoryId = "";
    },
  ],
  [
    "repository issuance substituted for use",
    (f) => {
      f.current.policy.operation = "work.repository-token.issue";
    },
  ],
  [
    "missing ancestor",
    (f) => {
      f.current.lineage.kind = "attached-child";
      f.current.lineage.parentWorkRef = "work/parent";
    },
  ],
  [
    "receiver substitution",
    (f) => {
      f.current.execution.receiverRef = "receiver/other";
    },
  ],
  [
    "expired original horizon",
    (f) => {
      f.current.originalHorizon = new Date(Date.now() - 1).toISOString();
    },
  ],
])
  test(`current repository-use comparison refuses ${name}`, async (t) => {
    const f = fixture(t);
    alter(f);
    assert.equal((await f.owner.prepare(open, f.call())).kind, "refused");
    assert.ok(!f.events.includes("mint"));
    assert.ok(!f.events.includes("commit"));
  });

test("complete root-to-parent lineage is compared and copied data is detached before final callbacks", async (t) => {
  const f = fixture(t),
    root = { ...copy(f.current.lineage.own), work: { workRef: "work/root", revision: 1 } };
  f.current.lineage = {
    ...f.current.lineage,
    kind: "attached-child",
    rootWorkRef: "work/root",
    parentWorkRef: "work/root",
    ancestors: [root],
  };
  f.current.withdrawals.push({ kind: "not-withdrawn-at-cut", revision: 0 });
  const observed = compareRepositoryWorkCurrentV2(f.current, open, f.native, Date.now());
  f.current.lineage.ancestors[0].state = "closed";
  assert.equal(observed.lineage.ancestors[0].state, "open");
  assert.ok(Object.isFrozen(observed));
  assert.throws(() => compareRepositoryWorkCurrentV2(f.current, open, f.native, Date.now()));
});

test("copied, foreign and replayed handles do not mint or dispatch", async (t) => {
  const f = fixture(t),
    other = fixture(t),
    p = await prepared(f);
  assert.equal(
    (await f.owner.dispatch({ ...p.preparation }, dispatchRequest(p), f.call())).kind,
    "not-released",
  );
  assert.equal(
    (await other.owner.dispatch(p.preparation, dispatchRequest(p), other.call())).kind,
    "not-released",
  );
  const r = await released(f, p);
  assert.equal(
    (await f.owner.dispatch(p.preparation, dispatchRequest(p), f.call())).kind,
    "not-released",
  );
  assert.equal((await f.owner.check(p.preparation, { ...r.release }, f.call())).kind, "refused");
  assert.equal(f.events.filter((x) => x === "mint").length, 1);
});

for (const [name, alter] of [
  [
    "Work revision",
    (c) => {
      c.work.revision++;
    },
  ],
  [
    "original ancestry closure",
    (c) => {
      c.lineage.own.state = "closed";
    },
  ],
  [
    "repository profile",
    (c) => {
      c.repository.profile = { ref: "profile/other", revision: "2" };
      c.policy.profile = c.repository.profile;
    },
  ],
  [
    "DNS binding",
    (c) => {
      c.dnsBindingRef = "dns/other";
    },
  ],
  [
    "assignment incarnation",
    (c) => {
      c.execution.executionIncarnationRef = "incarnation/other";
    },
  ],
])
  test(`change to ${name} while token preparation waits prevents COMMIT and joins token cleanup`, async (t) => {
    const f = fixture(t),
      p = await prepared(f);
    f.hooks.mint = async () => alter(f.current);
    assert.equal(
      (await f.owner.dispatch(p.preparation, dispatchRequest(p), f.call())).kind,
      "not-released",
    );
    await f.owner.settle(p.preparation, undefined, "not-dispatched");
    assert.ok(!f.events.includes("commit"));
    assert.equal(f.events.filter((x) => x === "settle-token").length, 1);
  });

test("broker temporary call cancellation does not revoke the independently held preparation", async (t) => {
  const f = fixture(t),
    first = new AbortController();
  const p = await f.owner.prepare(open, f.call(first));
  assert.equal(p.kind, "prepared");
  first.abort();
  const r = await released(f, p);
  await f.owner.writeRelease(r.release, metadata(p, r), f.call());
  assert.equal(f.writes.length, 1);
});

for (const [kind, expected] of [
  ["unknown", "unknown"],
  ["not-committed", "not-released"],
  ["unexpected", "unknown"],
])
  test(`State ${kind} result never creates a release`, async (t) => {
    const f = fixture(t),
      p = await prepared(f);
    f.hooks.commit = async () => ({ kind });
    assert.equal(
      (await f.owner.dispatch(p.preparation, dispatchRequest(p), f.call())).kind,
      expected,
    );
    await f.owner.settle(p.preparation, undefined, "not-dispatched");
    assert.equal(f.writes.length, 0);
    assert.equal(
      f.observations[0].outcome,
      kind === "not-committed" ? "not-dispatched" : "unknown",
    );
  });

test("known COMMIT is retained when the call cancels before R can be returned", async (t) => {
  const f = fixture(t),
    p = await prepared(f),
    abort = new AbortController();
  f.hooks.commit = async () => {
    abort.abort();
  };
  assert.equal(
    (await f.owner.dispatch(p.preparation, dispatchRequest(p), f.call(abort))).kind,
    "unknown",
  );
  await f.owner.settle(p.preparation, undefined, "unknown");
  assert.deepEqual(f.observations, [{ committed: true, outcome: "unknown" }]);
  assert.equal(f.writes.length, 0);
});

for (const key of [
  "session_ref",
  "effect_ref",
  "release_ref",
  "dns_binding_ref",
  "peer_certificate_sha256",
  "valid_until_ms",
])
  test(`fixed release refuses changed ${key} before custody entry`, async (t) => {
    const f = fixture(t),
      p = await prepared(f),
      r = await released(f, p);
    const altered = JSON.parse(Buffer.from(metadata(p, r)).toString());
    altered[key] = typeof altered[key] === "number" ? altered[key] - 1 : altered[key] + "x";
    await assert.rejects(
      f.owner.writeRelease(r.release, Buffer.from(JSON.stringify(altered)), f.call()),
    );
    await assert.rejects(f.owner.writeRelease(r.release, metadata(p, r), f.call()));
    assert.equal(f.writes.length, 0);
  });

test("metadata and call are captured before currentness waits", async (t) => {
  const f = fixture(t),
    p = await prepared(f),
    r = await released(f, p),
    bytes = metadata(p, r),
    expected = new Uint8Array(bytes),
    call = f.call();
  f.hooks.read = async () => {
    bytes.fill(0);
    call.context = {};
    call.recipientRef = "changed";
  };
  await f.owner.writeRelease(r.release, bytes, call);
  assert.deepEqual(f.writes[0], expected);
});

test("final synchronous currentness abort refuses before confidential writer", async (t) => {
  const f = fixture(t),
    p = await prepared(f),
    r = await released(f, p),
    abort = new AbortController();
  let fences = 0;
  f.hooks.fence = () => {
    if (++fences === 2) abort.abort();
  };
  await assert.rejects(f.owner.writeRelease(r.release, metadata(p, r), f.call(abort)));
  assert.equal(f.writes.length, 0);
});

test("an asynchronous final fence is refused and its continuation is joined", async (t) => {
  const f = fixture(t),
    gate = deferred();
  let settled = false;
  f.hooks.fence = () =>
    gate.promise.then(() => {
      settled = true;
      throw new Error("controlled late failure");
    });
  const p = f.owner.prepare(open, f.call());
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  gate.resolve();
  assert.equal((await p).kind, "refused");
  assert.equal(settled, true);
  assert.equal(f.events.filter((x) => x === "release-origin").length, 1);
});

test("a partial writer failure spends transmission and cannot produce completed evidence", async (t) => {
  const f = fixture(t),
    p = await prepared(f),
    r = await released(f, p);
  f.hooks.write = async () => {
    throw new Error("controlled partial write");
  };
  await assert.rejects(f.owner.writeRelease(r.release, metadata(p, r), f.call()));
  await assert.rejects(f.owner.writeRelease(r.release, metadata(p, r), f.call()));
  assert.equal(await f.owner.settle(p.preparation, r.release, "completed"), "unavailable");
  assert.equal(await f.owner.settle(p.preparation, r.release, "unknown"), "recorded");
  assert.equal(f.writes.length, 1);
});

test("stop aborts a pending acquisition and an existing read before joining either", async (t) => {
  const f = fixture(t),
    p = await prepared(f),
    r = await released(f, p),
    enteredAcquire = deferred(),
    enteredRead = deferred();
  const abortWait = (c, entered) =>
    new Promise((resolve) => {
      entered.resolve();
      if (c.signal.aborted) resolve();
      else c.signal.addEventListener("abort", resolve, { once: true });
    });
  f.hooks.acquire = (c) => abortWait(c, enteredAcquire);
  f.hooks.read = (c) => abortWait(c, enteredRead);
  const acquire = f.owner.prepare(open, f.call());
  const check = f.owner.check(p.preparation, r.release, f.call());
  await Promise.all([enteredAcquire.promise, enteredRead.promise]);
  await f.owner.stop();
  assert.equal((await acquire).kind, "refused");
  assert.equal((await check).kind, "refused");
  assert.equal(f.events.filter((x) => x === "release-origin").length, 2);
});

test("reentrant stop observes acquisition and duplicate settlement uses one published join", async (t) => {
  const f = fixture(t);
  let stopping;
  f.hooks.acquire = () => {
    stopping = f.owner.stop();
  };
  assert.equal((await f.owner.prepare(open, f.call())).kind, "refused");
  await stopping;
  assert.equal(f.events.filter((x) => x === "release-origin").length, 1);
  const other = fixture(t),
    p = await prepared(other);
  let nested;
  other.hooks.settle = () => {
    nested = other.owner.settle(p.preparation, undefined, "not-dispatched");
  };
  const original = other.owner.settle(p.preparation, undefined, "not-dispatched");
  await original;
  assert.equal(nested, original);
  assert.equal(other.events.filter((x) => x === "settle").length, 1);
});

test("concurrent check blocks a second check and confidential write", async (t) => {
  const f = fixture(t),
    p = await prepared(f),
    r = await released(f, p),
    gate = deferred(),
    entered = deferred();
  f.hooks.read = async () => {
    entered.resolve();
    await gate.promise;
  };
  const pending = f.owner.check(p.preparation, r.release, f.call());
  await entered.promise;
  assert.equal((await f.owner.check(p.preparation, r.release, f.call())).kind, "refused");
  await assert.rejects(f.owner.writeRelease(r.release, metadata(p, r), f.call()));
  gate.resolve();
  assert.equal((await pending).kind, "current");
});

test("abort-listener settlement reentry shares one join and waits for the entered read", async (t) => {
  const f = fixture(t),
    p = await prepared(f),
    r = await released(f, p);
  const gate = deferred(),
    entered = deferred();
  let nested,
    done = false;
  f.hooks.read = async (c) => {
    c.signal.addEventListener(
      "abort",
      () => {
        nested = f.owner.settle(p.preparation, r.release, "unknown");
      },
      { once: true },
    );
    entered.resolve();
    await gate.promise;
  };
  const checking = f.owner.check(p.preparation, r.release, f.call());
  await entered.promise;
  const original = f.owner.settle(p.preparation, r.release, "unknown");
  assert.equal(nested, original);
  void original.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  assert.equal(f.events.includes("release-origin"), false);
  gate.resolve();
  assert.equal((await checking).kind, "refused");
  assert.equal(await original, "recorded");
  for (const event of ["settle", "settle-token", "release-origin"])
    assert.equal(f.events.filter((value) => value === event).length, 1);
});

for (const stage of ["dispatch", "writeRelease"]) {
  test(`asynchronous committed inspection during ${stage} is refused and joined before cleanup`, async (t) => {
    const f = fixture(t),
      p = await prepared(f),
      gate = deferred();
    const r = stage === "writeRelease" ? await released(f, p) : undefined;
    let continued = false,
      settled = false;
    f.hooks.committed = () =>
      gate.promise.then(() => {
        continued = true;
        throw new Error("controlled late committed-inspection failure");
      });
    if (stage === "dispatch")
      assert.equal(
        (await f.owner.dispatch(p.preparation, dispatchRequest(p), f.call())).kind,
        "unknown",
      );
    else await assert.rejects(f.owner.writeRelease(r.release, metadata(p, r), f.call()));
    const join = f.owner.settle(p.preparation, r?.release, "unknown");
    void join.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(continued, false);
    assert.equal(settled, false);
    assert.equal(f.events.includes("settle"), false);
    assert.equal(f.events.includes("release-origin"), false);
    assert.equal(f.writes.length, 0);
    gate.resolve();
    assert.equal(await join, "recorded");
    assert.equal(continued, true);
    assert.deepEqual(f.observations, [{ committed: true, outcome: "unknown" }]);
    assert.equal(f.events.filter((x) => x === "release-origin").length, 1);
  });
}

test("accessor and proxy data are rejected without invoking hostile getters", async (t) => {
  const f = fixture(t);
  let getters = 0;
  const request = { ...open };
  Object.defineProperty(request, "repository_name", {
    enumerable: true,
    get() {
      getters++;
      return "project";
    },
  });
  assert.equal((await f.owner.prepare(request, f.call())).kind, "refused");
  assert.equal(
    (
      await f.owner.prepare(
        new Proxy(open, {
          ownKeys() {
            throw new Error("must not enter");
          },
        }),
        f.call(),
      )
    ).kind,
    "refused",
  );
  assert.equal(getters, 0);
  assert.equal(f.events.length, 0);
});

test("actual broker and Work owner preserve the terminal reply with explicitly controlled internal suppliers", async (t) => {
  const f = fixture(t),
    replies = [],
    events = [];
  const observation = {
    configuration: { ...trust(), permittedRecipientRef: "receiver/one" },
    authenticatedAt: new Date(Date.now() - 100).toISOString(),
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
    peerEvidenceRef: "evidence/controlled",
    transportBinding: f.native.transportBinding,
  };
  const broker = new GitHubMediationService({
    operations: f.owner,
    limits: { maximumSessions: 4, maximumCallMilliseconds: 2_000, ...limits },
    transport: {
      async inspect(call) {
        assert.equal(call.context, f.context);
        return observation;
      },
      async writeMetadata(bytes) {
        const reply = JSON.parse(Buffer.from(bytes).toString());
        replies.push(reply);
        events.push(reply.phase ?? reply.code);
      },
      async close() {
        events.push("transport-close");
      },
    },
  });
  t.after(() => broker.join());
  const send = (request) => broker.handle(Buffer.from(JSON.stringify(request)), f.call());
  await send(open);
  const opened = replies.at(-1);
  assert.equal(opened.phase, "opened");
  const binding = {
    version: 2,
    request_ref: open.request_ref,
    session_ref: opened.session_ref,
    effect_ref: opened.effect_ref,
    work_binding_sha256: opened.work_binding_sha256,
    request_sha256: open.request_sha256,
  };
  await send({
    ...binding,
    sequence: 2,
    method: "dispatch-read",
    dns_binding_ref: opened.dns_binding_ref,
    upstream_ipv4: opened.upstream_ipv4,
    peer_certificate_sha256: `sha256:${"3".repeat(64)}`,
  });
  assert.equal(f.writes.length, 1);
  const dispatched = JSON.parse(Buffer.from(f.writes[0]).toString());
  assert.equal(dispatched.phase, "dispatch-once");
  await send({
    ...binding,
    sequence: 3,
    method: "check-read",
    release_ref: dispatched.release_ref,
  });
  assert.equal(replies.at(-1).phase, "current");
  await send({
    ...binding,
    sequence: 4,
    method: "complete-read",
    release_ref: dispatched.release_ref,
    outcome: "not-dispatched",
  });
  assert.equal(replies.at(-1).phase, "recorded");
  assert.deepEqual(f.observations, [{ committed: true, outcome: "not-dispatched" }]);
  assert.equal(f.events.filter((e) => e === "release-origin").length, 1);
  await broker.join();
  assert.ok(events.indexOf("recorded") < events.indexOf("transport-close"));
});

test("wall-clock discontinuity during a currentness wait refuses without extending the original lease", async (t) => {
  const f = fixture(t),
    p = await prepared(f),
    r = await released(f, p),
    now = Date.now;
  f.hooks.read = async () => {
    Date.now = () => now() + 100;
  };
  try {
    assert.equal((await f.owner.check(p.preparation, r.release, f.call())).kind, "refused");
  } finally {
    Date.now = now;
  }
});

test("expired call and shared confidential metadata cannot enter a source effect", async (t) => {
  const f = fixture(t),
    p = await prepared(f),
    expired = { ...f.call(), deadline: new Date(Date.now() - 1).toISOString() };
  assert.equal(
    (await f.owner.dispatch(p.preparation, dispatchRequest(p), expired)).kind,
    "not-released",
  );
  assert.ok(!f.events.includes("mint"));
  const other = fixture(t),
    second = await prepared(other),
    r = await released(other, second),
    bytes = metadata(second, r);
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
  shared.set(bytes);
  await assert.rejects(other.owner.writeRelease(r.release, shared, other.call()));
  assert.equal(other.writes.length, 0);
});

test("broker effect identifies recorded preparation while State retains the distinct dispatch original", async (t) => {
  const f = fixture(t),
    p = await prepared(f);
  assert.equal(p.original.operationRef, "operation/preparation");
  assert.notEqual(p.original.operationRef, f.current.original.operationRef);
  const wire = dispatchRequest(p);
  f.hooks.commit = (_call, expected) => {
    assert.equal(expected.original.operationRef, f.current.original.operationRef);
  };
  const r = await f.owner.dispatch(p.preparation, wire, f.call());
  assert.equal(r.kind, "released");
  await f.owner.writeRelease(r.release, metadata(p, r, wire), f.call());
  const response = JSON.parse(new TextDecoder().decode(f.writes[0]));
  assert.equal(response.effect_ref, p.original.operationRef);
  assert.equal(response.session_ref, wire.session_ref);
});
test("the later dispatch operation cannot replace the broker preparation effect", async (t) => {
  const f = fixture(t),
    p = await prepared(f);
  const wire = { ...dispatchRequest(p), effect_ref: f.current.original.operationRef };
  assert.equal((await f.owner.dispatch(p.preparation, wire, f.call())).kind, "not-released");
  assert.equal(f.events.includes("mint"), false);
  assert.equal(f.events.includes("commit"), false);
});
test("recorded preparation association cannot change after broker preparation", async (t) => {
  const f = fixture(t),
    p = await prepared(f);
  f.hooks.preparationOriginal = (original) => ({ ...original, operationRef: "operation/other" });
  assert.equal(
    (await f.owner.dispatch(p.preparation, dispatchRequest(p), f.call())).kind,
    "not-released",
  );
  assert.equal(f.events.includes("mint"), false);
});
for (const field of ["scope", "invocationRef", "requestDigest", "operationRef"])
  test(`preparation original ${field} mismatch refuses before a broker preparation`, async (t) => {
    const f = fixture(t);
    f.hooks.preparationOriginal = (original) => ({
      ...original,
      [field]:
        field === "scope"
          ? { ...original.scope, revisionRef: "other" }
          : field === "operationRef"
            ? f.current.original.operationRef
            : "other",
    });
    assert.equal((await f.owner.prepare(open, f.call())).kind, "refused");
    assert.equal(f.events.includes("mint"), false);
  });

for (const operation of ["discovery", "upload-pack"])
  test(`explicit V3 ${operation} retains original declaration through one committed use`, async (t) => {
    const f = fixture(t, {}, { version: 3, request: gitOpen(operation) });
    const p = await prepared(f),
      r = await released(f, p);
    assert.deepEqual(f.current.repositoryRequest, gitBinding(f.open));
    await f.owner.writeRelease(r.release, metadata(p, r), f.call());
    assert.equal(JSON.parse(Buffer.from(f.writes[0]).toString()).version, 3);
    assert.equal((await f.owner.check(p.preparation, r.release, f.call())).kind, "current");
    assert.equal(await f.owner.settle(p.preparation, r.release, "completed"), "recorded");
    assert.equal(f.events.filter((e) => e === "commit").length, 1);
  });
for (const version of [2, 3])
  test(`owner constructor ${version} refuses the other incoming protocol before native acquisition`, async (t) => {
    const request = version === 2 ? gitOpen() : open;
    const f = fixture(t, {}, { version, request: version === 3 ? gitOpen() : open });
    assert.equal((await f.owner.prepare(request, f.call())).kind, "refused");
    assert.equal(f.events.includes("acquire"), false);
    assert.equal(f.events.includes("mint"), false);
  });
for (const [name, change] of [
  ["missing contents", (p) => (p.requiredPermissions = ["metadata:read"])],
  ["missing metadata", (p) => (p.requiredPermissions = ["contents:read"])],
  ["reversed tuple", (p) => p.requiredPermissions.reverse()],
  ["duplicate", (p) => p.requiredPermissions.push("metadata:read")],
  ["extra write", (p) => p.requiredPermissions.push("contents:write")],
  [
    "metadata arm",
    (p) => {
      delete p.repositoryOperation;
      delete p.requiredPermissions;
      p.permission = "metadata:read";
    },
  ],
])
  test(`V3 current policy refuses ${name} before mint`, async (t) => {
    const f = fixture(t, {}, { version: 3, request: gitOpen() });
    change(f.current.policy);
    assert.equal((await f.owner.prepare(f.open, f.call())).kind, "refused");
    assert.equal(f.events.includes("mint"), false);
    assert.equal(f.events.includes("commit"), false);
  });
for (const [name, change] of [
  ["metadata semantic digest", (r) => (r.request_sha256 = open.request_sha256)],
  ["discovery digest on upload", (r) => (r.request_sha256 = gitOpen("discovery").request_sha256)],
  ["body length", (r) => r.body_bytes++],
  ["body hash", (r) => (r.body_sha256 = `sha256:${"8".repeat(64)}`)],
  ["Git operation", (r) => (r.git_operation = "discovery")],
  ["Git protocol", (r) => (r.git_protocol = "version=1")],
  [
    "self-consistent replacement",
    (r) => {
      r.body_sha256 = `sha256:${"8".repeat(64)}`;
      r.request_sha256 = githubGitReadDigest(
        r.repository_owner,
        r.repository_name,
        r.git_operation,
        r.body_bytes,
        r.body_sha256,
      );
    },
  ],
])
  test(`V3 refuses ${name} against its original State/native request`, async (t) => {
    const f = fixture(t, {}, { version: 3, request: gitOpen() });
    const changed = copy(f.open);
    change(changed);
    assert.equal((await f.owner.prepare(changed, f.call())).kind, "refused");
    assert.equal(f.events.includes("mint"), false);
    assert.equal(f.writes.length, 0);
  });
for (const [name, change] of [
  ["permissions", (c) => (c.policy.requiredPermissions = ["metadata:read"])],
  ["repository profile", (c) => (c.policy.profile.revision = "2")],
  ["retained body", (c) => (c.repositoryRequest.bodySha256 = `sha256:${"8".repeat(64)}`)],
])
  test(`V3 ${name} change across token wait refuses COMMIT and joins custody`, async (t) => {
    const f = fixture(t, {}, { version: 3, request: gitOpen() });
    const p = await prepared(f);
    const entered = deferred(),
      gate = deferred();
    f.hooks.mint = async () => {
      entered.resolve();
      await gate.promise;
    };
    const pending = f.owner.dispatch(p.preparation, dispatchRequest(p), f.call());
    await entered.promise;
    change(f.current);
    gate.resolve();
    assert.equal((await pending).kind, "not-released");
    assert.equal(f.events.includes("commit"), false);
    await f.owner.settle(p.preparation, undefined, "not-dispatched");
    assert.equal(f.events.filter((e) => e === "settle-token").length, 1);
  });
for (const method of ["check", "writeRelease"])
  test(`V3 ${method} refuses changed permissions after known COMMIT`, async (t) => {
    const f = fixture(t, {}, { version: 3, request: gitOpen() }),
      p = await prepared(f),
      r = await released(f, p);
    f.current.policy.requiredPermissions = ["metadata:read"];
    if (method === "check")
      assert.equal((await f.owner.check(p.preparation, r.release, f.call())).kind, "refused");
    else await assert.rejects(f.owner.writeRelease(r.release, metadata(p, r), f.call()));
    assert.equal(f.writes.length, 0);
    await f.owner.settle(p.preparation, r.release, "unknown");
  });
test("V3 copied handles and unknown COMMIT retain original settlement without retry", async (t) => {
  const f = fixture(t, {}, { version: 3, request: gitOpen() }),
    p = await prepared(f);
  assert.equal(
    (await f.owner.dispatch({ ...p.preparation }, dispatchRequest(p), f.call())).kind,
    "not-released",
  );
  f.hooks.commit = () => ({ kind: "unknown" });
  assert.equal(
    (await f.owner.dispatch(p.preparation, dispatchRequest(p), f.call())).kind,
    "unknown",
  );
  assert.equal(
    (await f.owner.dispatch(p.preparation, dispatchRequest(p), f.call())).kind,
    "not-released",
  );
  assert.equal(f.writes.length, 0);
  await f.owner.settle(p.preparation, undefined, "unknown");
  assert.equal(f.observations.at(-1).outcome, "unknown");
});
test("V3 stop joins late original acquisition and preparation outlives temporary RPC abort", async (t) => {
  const f = fixture(t, {}, { version: 3, request: gitOpen() }),
    temporary = new AbortController();
  const p = await f.owner.prepare(f.open, f.call(temporary));
  assert.equal(p.kind, "prepared");
  temporary.abort();
  preparedRequests.set(p, f.open);
  const r = await released(f, p);
  await f.owner.settle(p.preparation, r.release, "unknown");
  const g = fixture(t, {}, { version: 3, request: gitOpen() }),
    entered = deferred(),
    gate = deferred();
  g.hooks.acquire = async () => {
    entered.resolve();
    await gate.promise;
  };
  const acquisition = g.owner.prepare(g.open, g.call());
  await entered.promise;
  let stopped = false;
  const stop = g.owner.stop().then(() => (stopped = true));
  await Promise.resolve();
  assert.equal(stopped, false);
  gate.resolve();
  await acquisition;
  await stop;
  assert.equal(g.events.filter((e) => e === "release-origin").length, 1);
});

test("Git declaration capture rejects changing getters without invoking them", () => {
  const request = copy(gitOpen());
  let reads = 0;
  Object.defineProperty(request, "body_sha256", {
    enumerable: true,
    get() {
      reads++;
      return `sha256:${"8".repeat(64)}`;
    },
  });
  assert.throws(() => repositoryWorkGitReadBindingV3(request));
  assert.equal(reads, 0);
});
test("retained Git declaration is detached and immutable", () => {
  const request = copy(gitOpen()),
    before = gitBinding(request),
    captured = repositoryWorkGitReadBindingV3(request);
  request.body_sha256 = `sha256:${"8".repeat(64)}`;
  assert.deepEqual(copy(captured), before);
  assert.equal(Object.isFrozen(captured), true);
});
