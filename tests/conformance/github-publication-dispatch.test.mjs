import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import test, { before, after } from "node:test";
import {
  createPublicationCandidateV1,
  publicationDigestV1,
  PublicationRefusalV1,
} from "../../packages/occ/src/repository-publication-v1/contract.ts";
import { GitObjectCustodyV1 } from "../../packages/occ/src/repository-publication-v1/git-object-custody.ts";
import { GitHubPublicationDispatcherV1 } from "../../packages/occ/src/github-mediation-v2/publication.ts";
import {
  GITHUB_PUBLICATION_ALPN,
  PUBLICATION_METADATA_BYTES,
  PUBLICATION_PACK_BYTES,
  decodeGitHubPublicationHeaderV1,
  decodeGitHubPublicationRequestV1,
  decodeGitHubPublicationReplyV1,
  encodeGitHubPublicationMetadataV1,
  githubPublicationRequestDigestV1,
  verifyGitHubPublicationPackV1,
} from "../../packages/occ/src/github-mediation-v2/publication-wire.ts";

// Pure wire cases and dispatcher COMPONENT mechanics only. State and native
// participants below are explicit controlled doubles; they supply no real Work,
// IAM, committed effect, authority, credential, TLS session or OCE integration.
// Lifecycle cases use the actual Git custodian (no replaced recognizer) but do
// not claim a positive push capture. They require a separately selected fixture.
const oid = (d) => d.repeat(40);
const digest = (d) => `sha256:${d.repeat(64)}`;
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const wire = (v) => Buffer.from(JSON.stringify(v));
function candidate() {
  const request = {
    version: 1,
    repository: {
      installationId: "installation/1",
      githubHost: "github.com",
      appId: "100",
      githubInstallationId: "200",
      repositoryId: "300",
    },
    baseBranch: "main",
    baseOid: oid("a"),
    targetBranch: "review/change",
    expectedTarget: { kind: "create" },
    proposedOid: oid("b"),
    draftPullRequest: { title: "Selected change", body: "Exact body\nSecond line", draft: true },
    actions: ["push", "create-draft-pr"],
  };
  return createPublicationCandidateV1(
    {
      installationId: "installation/1",
      namespaceId: "namespace/1",
      agentId: "agent/1",
      agentRevisionRef: "agent-revision/1",
      workRef: "work/1",
      workRevision: 1,
      authorityRef: "authority/1",
      authorityRevision: "1",
      operationRef: "operation/1",
      invocationRef: "invocation/1",
      requestDigest: publicationDigestV1("request", request),
      executionBindingDigest: digest("c"),
      requesterPrincipalId: "principal/1",
    },
    request,
    {
      version: 1,
      objectFormat: "sha1",
      proposedOid: request.proposedOid,
      baseOid: request.baseOid,
      graphDigest: digest("d"),
      objectCount: 3,
      rawBytes: 200,
      packSha256: digest("e"),
      packBytes: 180,
    },
  );
}
function effect(c, kind = "create-draft-pr", ref = "effect/1") {
  return {
    version: 1,
    effectRef: ref,
    kind,
    candidateRef: "candidate/1",
    approvalRef: "approval/1",
    actionDigest: c.actionDigest,
    confirmedPushEffectRef: kind === "push" ? null : "effect/push",
  };
}
function observation(c) {
  return {
    number: "42",
    url: "https://github.com/example/repository/pull/42",
    repositoryId: "300",
    baseBranch: c.request.baseBranch,
    baseOid: c.request.baseOid,
    headBranch: c.request.targetBranch,
    headOid: c.request.proposedOid,
    title: c.request.draftPullRequest.title,
    body: c.request.draftPullRequest.body,
    draft: true,
  };
}
const c = candidate(),
  e = effect(c);
const C = { version: 1, sequence: 1, session_ref: "1".repeat(32) };
const B = { call_ref: "call/1", effect: e, action_digest: c.actionDigest };
const R = {
  repository_owner: "example",
  repository_name: "repository",
  dns_binding_ref: "dns/1",
  upstream_ipv4: "140.82.112.3",
};
const P = {
  request_sha256: digest("a"),
  body_sha256: digest("b"),
  body_bytes: 120,
  peer_certificate_sha256: digest("c"),
};
const T = { server_time_ms: 100, valid_until_ms: 200, operation_until_ms: 300 };
const opened = () => ({ ...C, ...B, ...R, ...T, ok: true, phase: "opened", candidate: c });

test("publication is isolated from the read protocols and round-trips each closed request", () => {
  assert.equal(GITHUB_PUBLICATION_ALPN, "oce-github-publication-v1");
  const requests = [
    { ...C, method: "open-publication" },
    { ...C, ...B, ...R, ...P, method: "prepared-publication" },
    { ...C, ...B, ...R, ...P, method: "check-publication", release_ref: "release/1" },
    {
      ...C,
      ...B,
      method: "result-publication",
      release_ref: null,
      outcome: { kind: "not-dispatched" },
    },
  ];
  for (const request of requests) {
    const bytes = encodeGitHubPublicationMetadataV1(request, "request");
    assert.equal(
      JSON.stringify(decodeGitHubPublicationRequestV1(bytes)),
      JSON.stringify(JSON.parse(bytes)),
    );
  }
  for (const method of ["open-read", "dispatch-read", "git-receive-pack", "create-pr"])
    assert.throws(
      () => decodeGitHubPublicationRequestV1(wire({ ...C, method })),
      PublicationRefusalV1,
    );
});
test("every reply phase has an exact suffix purpose and size", () => {
  const replies = [
    [opened(), 0],
    [{ ...C, ...B, ...R, ...P, ...T, ok: true, phase: "committed", release_ref: "release/1" }, 1],
    [{ ...C, ...B, ...R, ...P, ...T, ok: true, phase: "current", release_ref: "release/1" }, 0],
    [{ ...C, ...B, ok: true, phase: "recorded", release_ref: null }, 0],
    [{ ...C, ok: false, code: "denied" }, 0],
  ];
  for (const [reply, size] of replies) {
    assert.equal(decodeGitHubPublicationReplyV1(wire(reply), size).version, 1);
    assert.throws(
      () => decodeGitHubPublicationReplyV1(wire(reply), size === 0 ? 1 : 0),
      PublicationRefusalV1,
    );
  }
  assert.throws(
    () => decodeGitHubPublicationReplyV1(wire(replies[1][0]), 16385),
    PublicationRefusalV1,
  );
});
test("opened push requires exactly the selected original PACK length", () => {
  const push = { ...opened(), effect: effect(c, "push") };
  assert.equal(decodeGitHubPublicationReplyV1(wire(push), c.graph.packBytes).effect.kind, "push");
  for (const size of [0, 31, c.graph.packBytes - 1, c.graph.packBytes + 1])
    assert.throws(() => decodeGitHubPublicationReplyV1(wire(push), size), PublicationRefusalV1);
});
test("duplicate decoded keys including nested escaped aliases are refused", () => {
  const ordinary = { ...C, method: "open-publication" };
  assert.equal(decodeGitHubPublicationRequestV1(wire(ordinary)).method, ordinary.method);
  const root = wire(ordinary).toString().replace('"version":1', '"version":1,"version":1');
  assert.throws(() => decodeGitHubPublicationRequestV1(Buffer.from(root)), PublicationRefusalV1);
  const nested = JSON.stringify(opened()).replace(
    '"draft":true',
    '"draft":true,"dr\\u0061ft":true',
  );
  assert.throws(() => decodeGitHubPublicationReplyV1(Buffer.from(nested), 0), PublicationRefusalV1);
});
test("unknown fields, noninteger syntax, malformed UTF-8 and Unicode are refused", () => {
  const open = { ...C, method: "open-publication" };
  for (const bytes of [
    wire({ ...open, url: "https://example.invalid" }),
    wire(open).toString().replace('"sequence":1', '"sequence":1e0'),
    wire(open).toString() + " true",
    Buffer.from([0xff]),
    wire(open).toString().replace("open-publication", "open-publication\\ud800"),
  ])
    assert.throws(() => decodeGitHubPublicationRequestV1(Buffer.from(bytes)), PublicationRefusalV1);
});
test("header length checks precede body allocation", () => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(1);
  header.writeUInt32BE(PUBLICATION_PACK_BYTES, 4);
  assert.deepEqual(decodeGitHubPublicationHeaderV1(header), {
    metadataBytes: 1,
    payloadBytes: PUBLICATION_PACK_BYTES,
  });
  for (const [metadata, payload] of [
    [0, 0],
    [PUBLICATION_METADATA_BYTES + 1, 0],
    [1, PUBLICATION_PACK_BYTES + 1],
  ]) {
    header.writeUInt32BE(metadata);
    header.writeUInt32BE(payload, 4);
    assert.throws(() => decodeGitHubPublicationHeaderV1(header), PublicationRefusalV1);
  }
  assert.throws(() => decodeGitHubPublicationHeaderV1(Buffer.alloc(9)), PublicationRefusalV1);
});
test("binding and route restrictions cover action mismatch and special addresses", () => {
  for (const change of [
    { action_digest: digest("f") },
    { repository_owner: ".." },
    { repository_name: "repository/x" },
    ...["127.0.0.1", "192.88.99.1", "10.0.0.1", "198.18.0.1", "::1"].map((upstream_ipv4) => ({
      upstream_ipv4,
    })),
  ])
    assert.throws(
      () => decodeGitHubPublicationReplyV1(wire({ ...opened(), ...change }), 0),
      PublicationRefusalV1,
    );
});
test("time bounds and sequence are finite", () => {
  for (const change of [
    { sequence: 0 },
    { sequence: 0x100000000 },
    { server_time_ms: 200 },
    { valid_until_ms: 301 },
    { operation_until_ms: 253402300800000 },
  ])
    assert.throws(
      () => decodeGitHubPublicationReplyV1(wire({ ...opened(), ...change }), 0),
      PublicationRefusalV1,
    );
});
test("canonical request digest binds fixed draft body size/hash and exact route", () => {
  const body = Buffer.from(
    JSON.stringify({
      base: c.request.baseBranch,
      body: c.request.draftPullRequest.body,
      draft: true,
      head: c.request.targetBranch,
      title: c.request.draftPullRequest.title,
    }),
  );
  const expected = hash(
    [
      "oce.github.publication.v1",
      "create-draft-pr",
      "POST",
      "https",
      "api.github.com",
      "443",
      "/repos/example/repository/pulls",
      "accept:application/vnd.github+json",
      "accept-encoding:identity",
      "content-type:application/json",
      "x-github-api-version:2022-11-28",
      "user-agent:oce-github-publication",
      "connection:close",
      `body-bytes:${body.length}`,
      `body-sha256:${hash(body).slice(7)}`,
      "",
    ].join("\n"),
  );
  assert.equal(
    githubPublicationRequestDigestV1(c, e, "example", "repository", hash(body), body.length),
    expected,
  );
  assert.notEqual(
    githubPublicationRequestDigestV1(c, e, "example", "other", hash(body), body.length),
    expected,
  );
  assert.throws(
    () => githubPublicationRequestDigestV1(c, e, "example", "../other", hash(body), body.length),
    PublicationRefusalV1,
  );
});
test("PACK comparison validates the prefixed hash and bounded exact length without issuing capture authority", () => {
  const pack = Buffer.alloc(180, 1),
    selected = { ...c, graph: { ...c.graph, packSha256: hash(pack) } };
  verifyGitHubPublicationPackV1(selected, pack);
  assert.throws(() => verifyGitHubPublicationPackV1(c, pack), PublicationRefusalV1);
  assert.throws(
    () => verifyGitHubPublicationPackV1(selected, pack.subarray(1)),
    PublicationRefusalV1,
  );
});
test("known mismatched PR observation survives terminal comparison decoding", () => {
  const observed = { ...observation(c), headOid: oid("f") };
  const request = decodeGitHubPublicationRequestV1(
    wire({
      ...C,
      ...B,
      method: "result-publication",
      release_ref: "release/1",
      outcome: { kind: "unknown", pullRequest: observed },
    }),
  );
  assert.equal(request.outcome.pullRequest.headOid, observed.headOid);
});

// A real custodian is opened only when this separate bounded fixture is selected.
// No Git binary is executed, no PACK captured, and no external provider called.
// One retained empty directory and original FD custody are enough for draft and
// wrong-capture mechanics. The fixture's conservative whole hold is 64 KiB.
const keys = [
  "OCE_PUBLICATION_TEST_GIT_PATH",
  "OCE_PUBLICATION_TEST_GIT_SHA256",
  "OCE_PUBLICATION_TEST_GIT_OWNER_UID",
  "OCE_PUBLICATION_DISPATCH_TEST_BUDGET_BYTES",
];
const selection = keys.map((key) => process.env[key]);
let custody, directory;
const selected = selection.some((value) => value !== undefined);
before(async () => {
  if (!selected) return;
  assert.ok(
    selection.every((value) => typeof value === "string" && value.length > 0),
    "Partial dispatcher fixture selection",
  );
  const [path, sha256, uid, budget] = selection;
  assert.ok(isAbsolute(path));
  assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.match(uid, /^(?:0|[1-9][0-9]*)$/);
  assert.match(budget, /^[1-9][0-9]*$/);
  assert.ok(Number.isSafeInteger(Number(uid)) && Number(uid) <= 0xffffffff);
  assert.ok(Number(budget) >= 65536 && Number(budget) <= 262144);
  directory = await mkdtemp(join(homedir(), ".publication-dispatch-"));
  custody = await GitObjectCustodyV1.open({
    directory,
    ownerUid: process.getuid(),
    durability: "persistent-posix",
    gitExecutable: { path, sha256, ownerUid: Number(uid) },
    limits: {
      maxObjects: 16,
      maxObjectBytes: 8192,
      maxRawBytes: 65536,
      maxPackBytes: 65536,
      maxTreeDepth: 8,
      maxPathBytes: 1024,
      maxExpandedPaths: 64,
      captureTimeoutMs: 1000,
    },
  });
});
after(async () => {
  await custody?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const mechanics = (name, body) =>
  test(
    name,
    {
      concurrency: false,
      skip: selected ? false : `Genuine custody fixture unavailable: select ${keys.join(", ")}`,
    },
    body,
  );
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function harness(options = {}) {
  const publisher = Object.freeze({}),
    originalEffect = Object.freeze({}),
    originalCandidate = Object.freeze({}),
    approval = Object.freeze({}),
    controller = new AbortController(),
    call = { requestRef: "call/1", signal: controller.signal };
  const candidateValue = candidate(),
    effectValue = effect(candidateValue, options.kind ?? "create-draft-pr");
  const events = [],
    sessions = new WeakMap(),
    outcomes = new WeakMap(),
    uses = new WeakMap();
  let held,
    nativeCalls = 0,
    retirementCalls = 0,
    submitted = 0,
    inspections = 0;
  const effects = new WeakMap([
    [originalEffect, { effect: effectValue, candidate: originalCandidate, approval }],
  ]);
  const native = {
    async prepareDraftPullRequest(p, effect, candidate, comparison, passedCall) {
      nativeCalls++;
      if (p !== publisher || !effects.has(effect) || passedCall !== call)
        throw new Error("component original mismatch");
      const session = Object.freeze({}),
        result = deferred(),
        drained = deferred();
      held = {
        session,
        result,
        drained,
        p,
        effect,
        candidate,
        comparison,
        passedCall,
        sent: false,
      };
      sessions.set(session, held);
      if (options.prepareWait) await options.prepareWait.promise;
      return session;
    },
    async preparePush() {
      nativeCalls++;
      throw new Error("No positive capture fixture is supplied");
    },
    inspectPrepared(session) {
      const h = sessions.get(session);
      assert.ok(h);
      return {
        publisher: h.p,
        originalEffect: h.effect,
        call: options.wrongCall ? { ...h.passedCall } : h.passedCall,
        effect: h.comparison,
        actionDigest: h.candidate.actionDigest,
      };
    },
    retainSubmission(session) {
      const h = sessions.get(session);
      assert.ok(h);
      return options.malformedTicket
        ? { result: h.result.promise, drained: {} }
        : { result: h.result.promise, drained: h.drained.promise };
    },
    assertPrepared(session, passedCall) {
      events.push("native-current");
      const h = sessions.get(session);
      assert.ok(h);
      assert.equal(passedCall, call);
      assert.equal(call.signal.aborted, false);
    },
    submit(session) {
      const h = sessions.get(session);
      assert.ok(h);
      assert.equal(h.sent, false);
      events.push("send");
      submitted++;
      h.sent = true;
      if (options.throwAfterSend) throw new Error("component send acknowledgement lost");
    },
    inspectOutcome(session, original) {
      assert.ok(sessions.has(session));
      const o = outcomes.get(original);
      assert.ok(o);
      if ((options.inspectionFailures ?? 0) > 0) {
        options.inspectionFailures--;
        throw new Error("component inspection temporarily unavailable");
      }
      return o;
    },
    async retire(session) {
      retirementCalls++;
      const h = sessions.get(session);
      assert.ok(h);
      if ((options.retirementFailures ?? 0) > 0) {
        options.retirementFailures--;
        throw new Error("component retirement temporarily unavailable");
      }
      if (!h.sent) finish({ kind: "not-dispatched" });
      await Promise.allSettled([h.result.promise, h.drained.promise]);
    },
  };
  const dispatcher = new GitHubPublicationDispatcherV1({
    custody,
    native,
    maximumEntries: options.maximumEntries ?? 2,
    maximumPreparedMilliseconds: options.lifetime ?? 60000,
  });
  const state = {
    inspectEffect(original) {
      assert.equal(this, state);
      const entry = effects.get(original);
      assert.ok(entry);
      inspections++;
      return entry;
    },
    assertUse(use, prepared, passedCall) {
      assert.equal(this, state);
      const u = uses.get(use);
      assert.ok(u);
      assert.equal(u.prepared, prepared);
      assert.equal(passedCall, call);
      events.push("state-current");
    },
    consumeUse(use, prepared, passedCall) {
      assert.equal(this, state);
      state.assertUse(use, prepared, passedCall);
      const u = uses.get(use);
      assert.equal(u.consumed, false);
      u.consumed = true;
      events.push("consume");
      if (options.asyncConsume) return Promise.resolve();
    },
  };
  dispatcher.bindState(state);
  function finish(
    value = { kind: "draft-pr-created", pullRequest: observation(candidateValue) },
    drain = true,
  ) {
    const original = Object.freeze({});
    outcomes.set(original, value);
    held.result.resolve(original);
    if (drain) held.drained.resolve();
    return original;
  }
  return {
    dispatcher,
    native,
    state,
    publisher,
    originalEffect,
    controller,
    call,
    c: candidateValue,
    e: effectValue,
    events,
    prepare: () =>
      dispatcher.prepareDraftPullRequest(publisher, originalEffect, candidateValue, call),
    use: (prepared) => {
      const original = Object.freeze({});
      uses.set(original, { prepared, consumed: false });
      return original;
    },
    finish,
    drain: () => held.drained.resolve(),
    held: () => held,
    inspections: () => inspections,
    another: () => {
      const original = Object.freeze({}),
        next = candidate();
      effects.set(original, {
        effect: { ...effect(next), effectRef: "effect/2", candidateRef: "candidate/2" },
        candidate: Object.freeze({}),
        approval: Object.freeze({}),
      });
      return () => dispatcher.prepareDraftPullRequest(publisher, original, next, call);
    },
    counts: () => ({ nativeCalls, retirementCalls, submitted }),
  };
}
async function pending(promise) {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
}
mechanics("private prepared and outcome copies cannot be inspected or released", async () => {
  const h = harness(),
    prepared = await h.prepare();
  assert.ok(prepared);
  assert.throws(() => h.dispatcher.inspectPrepared({ ...prepared }), PublicationRefusalV1);
  assert.throws(() => h.dispatcher.inspectOutcome({}), PublicationRefusalV1);
  assert.throws(() => h.dispatcher.releasePrepared({}), PublicationRefusalV1);
  await h.dispatcher.releasePrepared(prepared);
});
mechanics(
  "State pairs once and captured native methods retain their original receiver",
  async () => {
    const h = harness();
    assert.throws(() => h.dispatcher.bindState(h.state), PublicationRefusalV1);
    h.native.prepareDraftPullRequest = () => {
      throw new Error("replacement must not run");
    };
    const prepared = await h.prepare();
    assert.ok(prepared);
    await h.dispatcher.releasePrepared(prepared);
  },
);
mechanics("wrong effect and changed candidate fail before native preparation", async () => {
  const h = harness();
  await assert.rejects(h.dispatcher.prepareDraftPullRequest(h.publisher, {}, h.c, h.call));
  await assert.rejects(
    h.dispatcher.prepareDraftPullRequest(
      h.publisher,
      h.originalEffect,
      { ...h.c, actionDigest: digest("f") },
      h.call,
    ),
  );
  assert.equal(h.counts().nativeCalls, 0);
});
mechanics("genuine custodian rejects copied capture before any push preparation", async () => {
  const h = harness({ kind: "push" });
  await assert.rejects(h.dispatcher.preparePush(h.publisher, h.originalEffect, h.c, {}, h.call));
  assert.equal(h.counts().nativeCalls, 0);
});
mechanics("native original publisher mismatch cannot become prepared", async () => {
  const h = harness();
  assert.equal(
    await h.dispatcher.prepareDraftPullRequest({}, h.originalEffect, h.c, h.call),
    undefined,
  );
  assert.equal(h.counts().submitted, 0);
});
mechanics(
  "native copied-call binding and malformed preinstalled ticket retire before refusal",
  async () => {
    for (const options of [{ wrongCall: true }, { malformedTicket: true }]) {
      const h = harness(options);
      assert.equal(await h.prepare(), undefined);
      assert.equal(h.counts().retirementCalls, 1);
      assert.equal(h.counts().submitted, 0);
    }
  },
);
mechanics(
  "mutating original call after preparation prevents State consumption and send",
  async () => {
    const h = harness(),
      prepared = await h.prepare();
    h.call.requestRef = "replacement/call";
    assert.throws(() => h.dispatcher.submit(prepared, h.use(prepared)), PublicationRefusalV1);
    assert.equal(h.counts().submitted, 0);
    await h.dispatcher.releasePrepared(prepared);
  },
);
mechanics(
  "consume is immediately followed by one fixed native send, duplicate submit refuses",
  async () => {
    const h = harness(),
      prepared = await h.prepare(),
      use = h.use(prepared);
    const ticket = h.dispatcher.submit(prepared, use);
    assert.deepEqual(h.events.slice(-2), ["consume", "send"]);
    assert.throws(() => h.dispatcher.submit(prepared, use), PublicationRefusalV1);
    h.finish();
    const result = await ticket.result;
    await ticket.drained;
    assert.equal(h.dispatcher.inspectOutcome(result).outcome.kind, "draft-pr-created");
    await h.dispatcher.releasePrepared(prepared);
    assert.equal(h.counts().submitted, 1);
  },
);
mechanics(
  "wrong original use never sends and still returns retained retirement ticket",
  async () => {
    const h = harness(),
      prepared = await h.prepare(),
      ticket = h.dispatcher.submit(prepared, {});
    const outcome = await ticket.result;
    await assert.rejects(ticket.drained);
    assert.equal(h.dispatcher.inspectOutcome(outcome).outcome.kind, "not-dispatched");
    assert.equal(h.counts().submitted, 0);
    await h.dispatcher.releasePrepared(prepared);
  },
);
mechanics(
  "throw after possible send retains known result and waits for physical drain",
  async () => {
    const h = harness({ throwAfterSend: true }),
      prepared = await h.prepare();
    const ticket = h.dispatcher.submit(prepared, h.use(prepared));
    const release = h.dispatcher.releasePrepared(prepared);
    await pending(release);
    h.finish(undefined, false);
    const result = await ticket.result;
    assert.equal(h.dispatcher.inspectOutcome(result).outcome.pullRequest.number, "42");
    await pending(release);
    h.drain();
    await assert.rejects(ticket.drained);
    await release;
    assert.equal(h.dispatcher.inspectOutcome(result).outcome.pullRequest.number, "42");
  },
);
mechanics(
  "physical drain before delayed observation cannot retire outcome custody early",
  async () => {
    const h = harness(),
      prepared = await h.prepare(),
      ticket = h.dispatcher.submit(prepared, h.use(prepared));
    h.drain();
    const release = h.dispatcher.releasePrepared(prepared);
    await pending(release);
    h.finish();
    const outcome = await ticket.result;
    await release;
    assert.equal(h.dispatcher.inspectOutcome(outcome).outcome.kind, "draft-pr-created");
  },
);
mechanics("cancellation after send preserves non-null mismatched PR observation", async () => {
  const h = harness(),
    prepared = await h.prepare(),
    ticket = h.dispatcher.submit(prepared, h.use(prepared));
  h.controller.abort();
  const release = h.dispatcher.releasePrepared(prepared);
  await pending(release);
  const observed = { ...observation(h.c), headOid: oid("f") };
  h.finish({ kind: "unknown", pullRequest: observed });
  const result = await ticket.result;
  await release;
  assert.equal(h.dispatcher.inspectOutcome(result).outcome.pullRequest.headOid, observed.headOid);
});
mechanics(
  "cancellation while prepare is pending keeps ownership until returned session retires",
  async () => {
    const prepareWait = deferred(),
      h = harness({ prepareWait }),
      preparing = h.prepare();
    await Promise.resolve();
    h.controller.abort();
    await pending(preparing);
    prepareWait.resolve();
    assert.equal(await preparing, undefined);
    assert.equal(h.counts().submitted, 0);
    assert.equal(h.counts().retirementCalls, 1);
  },
);
mechanics("expired preparation withdraws and retains the same original cleanup", async () => {
  const prepareWait = deferred(),
    h = harness({ prepareWait, lifetime: 1 }),
    preparing = h.prepare();
  await new Promise((resolve) => setTimeout(resolve, 5));
  prepareWait.resolve();
  assert.equal(await preparing, undefined);
  assert.equal(h.counts().submitted, 0);
});
mechanics("same effect cannot prepare again after original physical retirement", async () => {
  const h = harness(),
    prepared = await h.prepare();
  await h.dispatcher.releasePrepared(prepared);
  await assert.rejects(h.prepare(), PublicationRefusalV1);
  assert.equal(h.counts().nativeCalls, 1);
});

mechanics(
  "failed native inspection preserves offered receipt through retirement and later recovery",
  async () => {
    const h = harness({ inspectionFailures: 1 }),
      prepared = await h.prepare();
    const ticket = h.dispatcher.submit(prepared, h.use(prepared));
    h.finish();
    const offered = await ticket.result;
    assert.throws(() => h.dispatcher.inspectOutcome(offered));
    await h.dispatcher.releasePrepared(prepared);
    assert.equal(h.dispatcher.inspectOutcome(offered).outcome.pullRequest.number, "42");
  },
);
mechanics(
  "failed retirement remains retryable on the same original without another send",
  async () => {
    const h = harness({ retirementFailures: 1 }),
      prepared = await h.prepare();
    await assert.rejects(h.dispatcher.releasePrepared(prepared));
    await h.dispatcher.releasePrepared(prepared);
    assert.deepEqual(h.counts(), { nativeCalls: 1, retirementCalls: 2, submitted: 0 });
  },
);
mechanics("entry capacity includes a prepared original until its physical retirement", async () => {
  const h = harness({ maximumEntries: 1 }),
    first = await h.prepare(),
    second = h.another();
  const ticket = h.dispatcher.submit(first, h.use(first));
  const retiring = h.dispatcher.releasePrepared(first);
  await pending(retiring);
  const inspected = h.inspections();
  await assert.rejects(second(), PublicationRefusalV1);
  assert.equal(h.inspections(), inspected);
  assert.equal(h.counts().nativeCalls, 1);
  h.finish();
  await ticket.result;
  await ticket.drained;
  await retiring;
  const next = await second();
  assert.ok(next);
  assert.notEqual(next, first);
  assert.equal(h.counts().nativeCalls, 2);
  await h.dispatcher.releasePrepared(next);
});

mechanics("a substituted asynchronous State fence cannot reach the fixed native send", async () => {
  const h = harness({ asyncConsume: true }),
    prepared = await h.prepare();
  const ticket = h.dispatcher.submit(prepared, h.use(prepared));
  const observed = await ticket.result;
  await assert.rejects(ticket.drained);
  assert.equal(h.counts().submitted, 0);
  assert.equal(h.dispatcher.inspectOutcome(observed).outcome.kind, "not-dispatched");
  await h.dispatcher.releasePrepared(prepared);
});

test("native DNS/release grammar is narrow while publication originals retain 256 characters", () => {
  const request = { ...C, ...B, ...R, ...P, method: "check-publication", release_ref: "release/1" };
  const reply = {
    ...C,
    ...B,
    ...R,
    ...P,
    ...T,
    ok: true,
    phase: "current",
    release_ref: "release/1",
  };
  for (const field of ["dns_binding_ref", "release_ref"]) {
    for (const value of ["a", "a".repeat(200), "A0._:/-"]) {
      assert.equal(
        decodeGitHubPublicationRequestV1(wire({ ...request, [field]: value }))[field],
        value,
      );
      assert.equal(
        decodeGitHubPublicationReplyV1(wire({ ...reply, [field]: value }), 0)[field],
        value,
      );
    }
    for (const value of ["", "a".repeat(201), "a@b", "a+b", "aé", "a\n", ..."._:/-"].map(String)) {
      assert.throws(
        () => decodeGitHubPublicationRequestV1(wire({ ...request, [field]: value })),
        PublicationRefusalV1,
      );
      assert.throws(
        () => decodeGitHubPublicationReplyV1(wire({ ...reply, [field]: value }), 0),
        PublicationRefusalV1,
      );
    }
  }
  const reference = "a" + "@+".repeat(127) + "a";
  const selected = createPublicationCandidateV1(
    { ...c.work, workRef: reference },
    c.request,
    c.graph,
  );
  const response = {
    ...opened(),
    candidate: selected,
    call_ref: reference,
    action_digest: selected.actionDigest,
    effect: { ...e, effectRef: reference, actionDigest: selected.actionDigest },
  };
  assert.equal(decodeGitHubPublicationReplyV1(wire(response), 0).call_ref, reference);
});
