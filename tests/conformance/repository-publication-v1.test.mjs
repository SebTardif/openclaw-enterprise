import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { GitObjectCustodyV1 } from "../../packages/occ/src/repository-publication-v1/git-object-custody.ts";
import { RepositoryPublicationOwnerV1 } from "../../packages/occ/src/repository-publication-v1/publication-owner.ts";
import {
  createPublicationCandidateV1,
  parsePublicationApproverPolicyV1,
  parsePublicationCandidateV1,
  parsePublicationGraphV1,
  parsePublicationRequestV1,
  parsePublicationWorkBindingV1,
  parsePublicationEffectOutcomeV1,
  parsePublicationStatusV1,
  publicationDigestV1,
  publicationOutcomeMatchesV1,
  publicationPolicyAllowsV1,
  publicationSnapshotV1,
  PublicationRefusalV1,
} from "../../packages/occ/src/repository-publication-v1/contract.ts";

// These tests exercise pure comparison-data decoders and the additional local
// policy predicate. The data below constructs no State/Work original, human
// approval, captured Git bytes, committed effect or permission to publish.
const oid = (digit) => digit.repeat(40);
const digest = (digit) => `sha256:${digit.repeat(64)}`;
function request() {
  return {
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
    targetBranch: "proposed/change",
    expectedTarget: { kind: "existing", oid: oid("b") },
    proposedOid: oid("c"),
    draftPullRequest: {
      title: "Review this exact change",
      body: "First line\nSecond line",
      draft: true,
    },
    actions: ["push", "create-draft-pr"],
  };
}
function work(req) {
  return {
    installationId: req.repository.installationId,
    namespaceId: "namespace/1",
    agentId: "agent/1",
    agentRevisionRef: "revision/1",
    workRef: "work/1",
    workRevision: 1,
    authorityRef: "authority/1",
    authorityRevision: "1",
    operationRef: "operation/1",
    invocationRef: "invocation/1",
    requestDigest: publicationDigestV1("request", req),
    executionBindingDigest: digest("d"),
    requesterPrincipalId: "principal/requester",
  };
}
function graph(req) {
  return {
    version: 1,
    objectFormat: "sha1",
    proposedOid: req.proposedOid,
    baseOid: req.baseOid,
    graphDigest: digest("e"),
    objectCount: 3,
    rawBytes: 200,
    packSha256: digest("f"),
    packBytes: 180,
  };
}
function candidate(req = request()) {
  return createPublicationCandidateV1(work(req), req, graph(req));
}
function policy() {
  const req = request();
  return {
    version: 1,
    policyRef: "policy/publish",
    revision: "1",
    approverPrincipalIds: ["principal/reviewer"],
    allowSelfApproval: false,
    approvalLifetimeMs: 60000,
    rules: [
      {
        repository: req.repository,
        baseBranch: req.baseBranch,
        targetBranches: [req.targetBranch],
        allowCreate: false,
      },
    ],
    actions: ["push", "create-draft-pr"],
  };
}
const refuses = (fn) => assert.throws(fn, PublicationRefusalV1);

test("publication request captures an immutable exact action bundle independent of input mutation", () => {
  const input = request();
  const captured = parsePublicationRequestV1(input);
  const before = publicationDigestV1("request", captured);
  input.targetBranch = "other";
  input.repository.repositoryId = "301";
  input.draftPullRequest.body = "changed";
  input.actions.reverse();
  assert.equal(publicationDigestV1("request", captured), before);
  assert.equal(captured.targetBranch, "proposed/change");
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.repository), true);
  assert.equal(Object.isFrozen(captured.draftPullRequest), true);
  assert.equal(Object.isFrozen(captured.actions), true);
  assert.throws(() => {
    captured.draftPullRequest.draft = false;
  }, TypeError);
});

function effect(kind, c) {
  return {
    version: 1,
    effectRef: kind === "push" ? "effect/push" : "effect/pr",
    kind,
    candidateRef: "candidate/1",
    approvalRef: "approval/1",
    actionDigest: c.actionDigest,
    confirmedPushEffectRef: kind === "push" ? null : "effect/push",
  };
}
function observedPR(c) {
  return {
    number: "17",
    url: "https://github.com/fixture/repository/pull/17",
    repositoryId: c.request.repository.repositoryId,
    baseBranch: c.request.baseBranch,
    baseOid: c.request.baseOid,
    headBranch: c.request.targetBranch,
    headOid: c.request.proposedOid,
    title: c.request.draftPullRequest.title,
    body: c.request.draftPullRequest.body,
    draft: true,
  };
}
function completedStatus(c) {
  return {
    version: 1,
    candidateRef: "candidate/1",
    actionDigest: c.actionDigest,
    state: "draft-pr-created",
    push: {
      effect: effect("push", c),
      outcome: {
        kind: "pushed",
        ref: `refs/heads/${c.request.targetBranch}`,
        oldOid: c.request.expectedTarget.oid,
        newOid: c.request.proposedOid,
      },
    },
    pullRequest: {
      effect: effect("create-draft-pr", c),
      outcome: { kind: "draft-pr-created", pullRequest: observedPR(c) },
    },
  };
}

test("PR outcome comparison requires every observed candidate field and preserves mismatches as data", () => {
  const c = candidate(),
    prEffect = effect("create-draft-pr", c);
  const actual = parsePublicationEffectOutcomeV1({
    kind: "draft-pr-created",
    pullRequest: observedPR(c),
  });
  assert.equal(publicationOutcomeMatchesV1(c, prEffect, actual), true);
  for (const [field, value] of [
    ["repositoryId", "301"],
    ["baseBranch", "other-base"],
    ["baseOid", oid("d")],
    ["headBranch", "other-head"],
    ["headOid", oid("d")],
    ["title", "changed title"],
    ["body", "changed body"],
    ["draft", false],
  ]) {
    const observed = observedPR(c);
    observed[field] = value;
    const mismatch = parsePublicationEffectOutcomeV1({
      kind: "draft-pr-created",
      pullRequest: observed,
    });
    assert.equal(publicationOutcomeMatchesV1(c, prEffect, mismatch), false);
    const uncertain = parsePublicationEffectOutcomeV1({ kind: "unknown", pullRequest: observed });
    assert.equal(uncertain.pullRequest[field], value);
    assert.equal(publicationOutcomeMatchesV1(c, effect("push", c), uncertain), false);
  }
  refuses(() => parsePublicationEffectOutcomeV1({ kind: "unknown" }));
});

test("status decoder refuses inconsistent push/PR order, identity, approval and result combinations", () => {
  const c = candidate(),
    original = completedStatus(c);
  assert.equal(parsePublicationStatusV1(original).state, "draft-pr-created");
  for (const change of [
    (s) => {
      s.push = null;
    },
    (s) => {
      s.push.outcome = { kind: "unknown", pullRequest: null };
    },
    (s) => {
      s.pullRequest.effect.confirmedPushEffectRef = "effect/foreign";
    },
    (s) => {
      s.pullRequest.effect.effectRef = s.push.effect.effectRef;
    },
    (s) => {
      s.pullRequest.effect.approvalRef = "approval/foreign";
    },
    (s) => {
      s.pullRequest.effect.candidateRef = "candidate/foreign";
    },
    (s) => {
      s.pullRequest.effect.actionDigest = digest("0");
    },
    (s) => {
      s.pullRequest.outcome.pullRequest.headOid = oid("d");
    },
    (s) => {
      s.pullRequest.outcome.pullRequest.headBranch = "other-head";
    },
    (s) => {
      s.state = "awaiting-approval";
    },
    (s) => {
      s.state = "pushed";
    },
    (s) => {
      s.state = "publishing";
    },
    (s) => {
      s.state = "cancelled";
    },
  ]) {
    const input = structuredClone(original);
    change(input);
    refuses(() => parsePublicationStatusV1(input));
  }
});

// COMPONENT-ONLY lifecycle controls below. Actual Git custody is opened, but
// controlled authority operands are not production State/Work/DS originals.
// Refused-path cases capture no objects. The final retirement schedule captures
// actual Git bytes, then supplies private component controls solely to exercise
// application ordering. No control establishes real approval, COMMIT or effects;
// none of these cases is end-to-end publication integration evidence.
const lifecycleSelectionKeys = [
  "OCE_PUBLICATION_TEST_GIT_PATH",
  "OCE_PUBLICATION_TEST_GIT_SHA256",
  "OCE_PUBLICATION_TEST_GIT_OWNER_UID",
  "OCE_PUBLICATION_TEST_ARTIFACT_BUDGET_BYTES",
];
function lifecycleSelection() {
  const values = lifecycleSelectionKeys.map((key) => process.env[key]);
  if (values.every((value) => value === undefined)) return undefined;
  assert.ok(values.every((value) => typeof value === "string" && value.length > 0));
  const [path, sha256, uid, budget] = values;
  assert.ok(isAbsolute(path));
  assert.match(sha256, /^[0-9a-f]{64}(?![\s\S])/);
  assert.match(uid, /^(?:0|[1-9][0-9]*)(?![\s\S])/);
  assert.match(budget, /^[1-9][0-9]*(?![\s\S])/);
  const ownerUid = Number(uid),
    artifactBudget = Number(budget);
  assert.ok(Number.isSafeInteger(ownerUid) && ownerUid <= 0xffffffff);
  assert.ok(
    Number.isSafeInteger(artifactBudget) &&
      artifactBudget >= 1676 * 1024 &&
      artifactBudget <= 2 * 1024 * 1024,
  );
  return { path, sha256, ownerUid, artifactBudget };
}
const lifecycleGit = lifecycleSelection();
const componentTest = (name, body) =>
  test(
    `COMPONENT ONLY: ${name}`,
    {
      timeout: 10000,
      concurrency: false,
      skip:
        lifecycleGit === undefined
          ? `Actual custody construction unavailable: select ${lifecycleSelectionKeys.join(", ")}`
          : false,
    },
    body,
  );
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const immediate = () => new Promise((resolve) => setImmediate(resolve));
let lifecycleFixtures = 0,
  lifecycleApparentBytes = 0,
  lifecycleAllocatedBytes = 0;
async function componentFixture(t, overrides = {}, maxPending = 1, controls = {}) {
  assert.ok(lifecycleGit);
  // Seven empty fixtures and six two-object captures fit the 96 KiB partition.
  assert.ok(++lifecycleFixtures <= 13, "A new fixture requires an updated forecast");
  const directory = await mkdtemp(join(homedir(), ".publication-controls-"));
  const unblock = [];
  let custody, application;
  t.after(async () => {
    try {
      for (const release of unblock) release();
      await application?.close();
      await custody?.close();
    } finally {
      try {
        if (!controls.capture)
          assert.deepEqual(readdirSync(directory), [], "Refusal controls must retain no objects");
        const pending = [directory];
        let apparentBytes = 0,
          allocatedBytes = 0,
          entries = 0;
        while (pending.length) {
          const path = pending.pop(),
            stat = lstatSync(path);
          assert.ok(++entries <= 8, "A larger component fixture requires a new forecast");
          apparentBytes += stat.size;
          allocatedBytes += stat.blocks * 512;
          if (stat.isDirectory())
            for (const name of readdirSync(path)) pending.push(join(path, name));
        }
        lifecycleApparentBytes += apparentBytes;
        lifecycleAllocatedBytes += allocatedBytes;
        assert.ok(
          lifecycleApparentBytes <= 96 * 1024 && lifecycleAllocatedBytes <= 96 * 1024,
          "Component fixtures exceeded their prospective 96 KiB partition",
        );
        t.diagnostic(
          `component-fixture-accounting ${JSON.stringify({
            fixtures: lifecycleFixtures,
            cumulativeApparentBytes: lifecycleApparentBytes,
            cumulativeAllocatedBytes: lifecycleAllocatedBytes,
            selectedRunBudgetBytes: lifecycleGit.artifactBudget,
          })}`,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  custody = await GitObjectCustodyV1.open({
    directory,
    ownerUid: process.getuid(),
    durability: "persistent-posix",
    gitExecutable: {
      path: lifecycleGit.path,
      sha256: lifecycleGit.sha256,
      ownerUid: lifecycleGit.ownerUid,
    },
    limits: {
      maxObjects: controls.capture ? 2 : 1,
      maxObjectBytes: 1024,
      maxRawBytes: 1024,
      maxPackBytes: 2048,
      maxTreeDepth: 1,
      maxPathBytes: 64,
      maxExpandedPaths: 2,
      captureTimeoutMs: 1000,
    },
  });
  const forbidden = [];
  const refuse = (name) => () => {
    forbidden.push(name);
    throw new Error(`Unexpected controlled supplier call: ${name}`);
  };
  const workSource = {
    acquire: async () => undefined,
    inspect: refuse("work.inspect"),
    assertCurrent: refuse("work.assertCurrent"),
    release: refuse("work.release"),
    ...overrides,
  };
  const state = Object.fromEntries(
    [
      "prepareCandidate",
      "inspectCandidate",
      "acquireApproval",
      "inspectApproval",
      "claimEffect",
      "inspectEffect",
      "acquireUse",
      "recordOutcome",
      "recordNotSubmitted",
      "recordUncertain",
      "statusForEffect",
      "readStatus",
      "releaseEffect",
    ].map((name) => [name, refuse(`state.${name}`)]),
  );
  const dispatcher = Object.fromEntries(
    [
      "preparePush",
      "prepareDraftPullRequest",
      "inspectPrepared",
      "submit",
      "inspectOutcome",
      "releasePrepared",
    ].map((name) => [name, refuse(`ds.${name}`)]),
  );
  application = new RepositoryPublicationOwnerV1({
    policy: controls.policy ?? policy(),
    clock: { read: () => ({ wallMs: 1000, uncertaintyMs: 0 }) },
    custody,
    work: workSource,
    state: { ...state, ...controls.state },
    dispatcher: { ...dispatcher, ...controls.dispatcher },
    maxPending,
  });
  return { application, custody, unblock, forbidden };
}
const componentCall = () => ({
  requestRef: "request/component",
  signal: new AbortController().signal,
});

test("COMPONENT ONLY: missing policy refuses before accessing any authority supplier", () => {
  let reads = 0;
  for (const invalid of [undefined, {}, { ...policy(), approverPrincipalIds: [] }]) {
    const input = { policy: invalid };
    for (const key of ["custody", "work", "state", "dispatcher", "clock", "maxPending"])
      Object.defineProperty(input, key, {
        get() {
          reads++;
          throw new Error("Supplier must not be read");
        },
      });
    refuses(() => new RepositoryPublicationOwnerV1(input));
  }
  assert.equal(reads, 0);
});

componentTest(
  "refused acquisition preserves the exact call object and never reaches State or DS",
  async (t) => {
    const call = componentCall(),
      actor = Object.freeze({});
    let calls = 0;
    const f = await componentFixture(t, {
      async acquire(actualActor, fixed, actualCall) {
        calls++;
        assert.equal(actualActor, actor);
        assert.equal(actualCall, call);
        assert.equal(fixed.targetBranch, request().targetBranch);
        return undefined;
      },
    });
    assert.deepEqual(await f.application.prepare(actor, request(), [], call), { kind: "refused" });
    assert.equal(calls, 1);
    assert.deepEqual(f.forbidden, []);
  },
);

componentTest(
  "reentrant acquisition cannot occupy a second slot before the first is tracked",
  async (t) => {
    const call = componentCall();
    let application,
      nested,
      calls = 0;
    const f = await componentFixture(t, {
      acquire() {
        calls++;
        nested = assert.rejects(async () =>
          application.prepare({}, request(), [], componentCall()),
        );
        return Promise.resolve(undefined);
      },
    });
    application = f.application;
    assert.deepEqual(await application.prepare({}, request(), [], call), { kind: "refused" });
    await nested;
    assert.equal(calls, 1);
    assert.deepEqual(f.forbidden, []);
  },
);

componentTest("close is idempotent and joins an in-flight refused acquisition", async (t) => {
  const entered = deferred(),
    gate = deferred();
  const f = await componentFixture(t, {
    acquire() {
      entered.resolve();
      return gate.promise;
    },
  });
  f.unblock.push(gate.resolve);
  const pending = f.application.prepare({}, request(), [], componentCall());
  await entered.promise;
  const closed = f.application.close();
  assert.equal(f.application.close(), closed);
  let finished = false;
  void closed.then(() => {
    finished = true;
  });
  await immediate();
  assert.equal(finished, false);
  await assert.rejects(async () => f.application.prepare({}, request(), [], componentCall()));
  gate.resolve();
  assert.deepEqual(await pending, { kind: "refused" });
  await closed;
  assert.deepEqual(f.forbidden, []);
});

componentTest(
  "inspection denial retains the acquired operand until its original finalizer settles",
  async (t) => {
    const held = Object.freeze({}),
      releasing = deferred(),
      gate = deferred(),
      denied = new Error("Controlled inspection refusal");
    let releases = 0;
    const f = await componentFixture(t, {
      acquire: async () => held,
      assertCurrent() {},
      inspect() {
        throw denied;
      },
      release(actual) {
        assert.equal(actual, held);
        releases++;
        releasing.resolve();
        return gate.promise;
      },
    });
    f.unblock.push(gate.resolve);
    const pending = assert.rejects(
      f.application.prepare({}, request(), [], componentCall()),
      (error) => error === denied,
    );
    await releasing.promise;
    const closed = f.application.close();
    let finished = false;
    void closed.then(() => {
      finished = true;
    });
    await immediate();
    assert.equal(finished, false);
    assert.equal(releases, 1);
    gate.resolve();
    await pending;
    await closed;
    assert.deepEqual(f.forbidden, []);
  },
);

componentTest(
  "changed original call fields refuse after acquisition and still release the operand",
  async (t) => {
    for (const mutate of [
      (call) => {
        call.requestRef = "request/changed";
      },
      (call) => {
        call.signal = new AbortController().signal;
      },
    ]) {
      const held = Object.freeze({}),
        entered = deferred(),
        gate = deferred(),
        call = componentCall();
      let releases = 0;
      const f = await componentFixture(t, {
        acquire() {
          entered.resolve();
          return gate.promise;
        },
        async release(actual) {
          assert.equal(actual, held);
          releases++;
        },
      });
      f.unblock.push(() => gate.resolve(held));
      const rejected = assert.rejects(
        f.application.prepare({}, request(), [], call),
        PublicationRefusalV1,
      );
      await entered.promise;
      mutate(call);
      gate.resolve(held);
      await rejected;
      assert.equal(releases, 1);
      assert.deepEqual(f.forbidden, []);
    }
  },
);

componentTest(
  "unexpected asynchronous currentness refuses and drains before original release",
  async (t) => {
    const held = Object.freeze({}),
      entered = deferred(),
      assertion = deferred();
    let releases = 0;
    const f = await componentFixture(t, {
      acquire: async () => held,
      assertCurrent() {
        entered.resolve();
        return assertion.promise;
      },
      async release(actual) {
        assert.equal(actual, held);
        releases++;
      },
    });
    f.unblock.push(assertion.resolve);
    const rejected = assert.rejects(
      f.application.prepare({}, request(), [], componentCall()),
      PublicationRefusalV1,
    );
    await entered.promise;
    const closed = f.application.close();
    let finished = false;
    void closed.then(() => {
      finished = true;
    });
    await immediate();
    assert.equal(finished, false);
    assert.equal(releases, 0);
    assert.deepEqual(f.forbidden, []);
    assertion.resolve();
    await rejected;
    await closed;
    assert.equal(releases, 1);
  },
);

componentTest(
  "delayed or failed outcome acknowledgement retains the exact operand through durable retirement without resubmit",
  async (t) => {
    // These opaque objects and supplier methods are controlled component inputs,
    // not genuine State approval/COMMIT, Work grants or DS-issued authority.
    // The production owner and Git custody execute their actual implementations.
    for (const acknowledgement of ["delayed", "failed"]) {
      const originalCandidate = Object.freeze({}),
        originalApproval = Object.freeze({}),
        originalEffect = Object.freeze({}),
        originalPrepared = Object.freeze({}),
        originalUse = Object.freeze({}),
        originalOutcome = Object.freeze({}),
        publisher = Object.freeze({}),
        call = componentCall(),
        offered = deferred(),
        acknowledgementGate = deferred(),
        retiring = deferred(),
        retirementGate = deferred(),
        transferring = deferred(),
        transferGate = deferred();
      const selectedPolicy = policy();
      selectedPolicy.rules[0].allowCreate = true;
      let capturedCandidate,
        capturedEffect,
        claimed = 0,
        submitted = 0,
        begun = 0,
        useReleased = 0,
        publicationFinished = false,
        closeFinished = false;
      const offeredOutcomes = [],
        uncertainOutcomes = [],
        releasedPrepared = [],
        releasedEffects = [];
      const f = await componentFixture(t, {}, 1, {
        capture: true,
        policy: selectedPolicy,
        state: {
          async claimEffect(
            actualPublisher,
            candidateRef,
            approvalRef,
            kind,
            actualPolicy,
            actualCall,
          ) {
            assert.equal(actualPublisher, publisher);
            assert.equal(candidateRef, "candidate/1");
            assert.equal(approvalRef, "approval/1");
            assert.equal(kind, "push");
            assert.equal(actualCall, call);
            assert.equal(
              publicationDigestV1("approver-policy", actualPolicy),
              publicationDigestV1("approver-policy", selectedPolicy),
            );
            claimed++;
            return { kind: "committed", original: originalEffect };
          },
          inspectEffect(actual) {
            assert.equal(actual, originalEffect);
            return {
              effect: capturedEffect,
              candidate: originalCandidate,
              approval: originalApproval,
            };
          },
          inspectCandidate(actual) {
            assert.equal(actual, originalCandidate);
            return { candidateRef: "candidate/1", candidate: capturedCandidate };
          },
          inspectApproval(actual) {
            assert.equal(actual, originalApproval);
            return {
              version: 1,
              approvalRef: "approval/1",
              candidateRef: "candidate/1",
              actionDigest: capturedCandidate.actionDigest,
              approverPrincipalId: "principal/reviewer",
              policyRef: selectedPolicy.policyRef,
              policyRevision: selectedPolicy.revision,
              policyDigest: publicationDigestV1("approver-policy", selectedPolicy),
              approvedAtMs: 1000,
              expiresAtMs: 2000,
            };
          },
          async acquireUse(actualEffect, actualPrepared, actualCall) {
            assert.equal(actualEffect, originalEffect);
            assert.equal(actualPrepared, originalPrepared);
            assert.equal(actualCall, call);
            return {
              original: originalUse,
              candidate: originalCandidate,
              approval: originalApproval,
              effect: originalEffect,
              assertCurrent() {},
              beginSubmittedUse() {
                begun++;
              },
              async release() {
                useReleased++;
              },
            };
          },
          recordOutcome(actualEffect, actualOutcome) {
            assert.equal(actualEffect, originalEffect);
            offeredOutcomes.push(actualOutcome);
            offered.resolve();
            // Enrollment precedes either delayed or failed acknowledgement.
            return acknowledgement === "delayed"
              ? acknowledgementGate.promise
              : Promise.reject(new Error("Controlled persistence acknowledgement failure"));
          },
          async recordUncertain(actualEffect, actualOutcome) {
            assert.equal(actualEffect, originalEffect);
            uncertainOutcomes.push(actualOutcome);
            return "unknown";
          },
          async statusForEffect(actual) {
            assert.equal(actual, originalEffect);
            return {
              version: 1,
              candidateRef: "candidate/1",
              actionDigest: capturedCandidate.actionDigest,
              state: "unknown",
              push: { effect: capturedEffect, outcome: { kind: "unknown", pullRequest: null } },
              pullRequest: null,
            };
          },
          releaseEffect(actual) {
            releasedEffects.push(actual);
            transferring.resolve();
            // The controlled supplier retains durable-transfer ownership even
            // when its earlier persistence acknowledgement rejected.
            return transferGate.promise;
          },
        },
        dispatcher: {
          async preparePush(actualPublisher, actualEffect, actualCandidate, capture, actualCall) {
            assert.equal(actualPublisher, publisher);
            assert.equal(actualEffect, originalEffect);
            assert.equal(actualCandidate.actionDigest, capturedCandidate.actionDigest);
            assert.equal(actualCall, call);
            assert.equal(
              f.custody.inspect(capture).graphDigest,
              capturedCandidate.graph.graphDigest,
            );
            return originalPrepared;
          },
          inspectPrepared(actual) {
            assert.equal(actual, originalPrepared);
            return {
              effectRef: capturedEffect.effectRef,
              actionDigest: capturedCandidate.actionDigest,
              kind: "push",
            };
          },
          submit(actualPrepared, actualUse) {
            assert.equal(actualPrepared, originalPrepared);
            assert.equal(actualUse, originalUse);
            submitted++;
            return { result: Promise.resolve(originalOutcome), drained: Promise.resolve() };
          },
          inspectOutcome(actual) {
            assert.equal(actual, originalOutcome);
            return {
              effectRef: capturedEffect.effectRef,
              actionDigest: capturedCandidate.actionDigest,
              outcome: { kind: "unknown", pullRequest: null },
            };
          },
          releasePrepared(actual) {
            releasedPrepared.push(actual);
            retiring.resolve();
            return retirementGate.promise;
          },
        },
      });
      f.unblock.push(
        () => acknowledgementGate.resolve("committed"),
        retirementGate.resolve,
        transferGate.resolve,
      );
      const object = (type, bytes) => ({
        type,
        bytes,
        oid: createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex"),
      });
      const tree = object("tree", Buffer.alloc(0));
      const commit = object(
        "commit",
        Buffer.from(
          `tree ${tree.oid}\nauthor Component Fixture <component@example.invalid> 946684800 +0000\n` +
            "committer Component Fixture <component@example.invalid> 946684800 +0000\n\nComponent fixture\n",
        ),
      );
      const req = {
        ...request(),
        baseOid: commit.oid,
        proposedOid: commit.oid,
        expectedTarget: { kind: "create" },
      };
      const capture = await f.custody.capture(req, [tree, commit], call.signal);
      capturedCandidate = createPublicationCandidateV1(work(req), req, f.custody.inspect(capture));
      capturedEffect = effect("push", capturedCandidate);
      const publication = f.application.publish(publisher, "candidate/1", "approval/1", call);
      void publication.then(
        () => {
          publicationFinished = true;
        },
        () => {
          publicationFinished = true;
        },
      );
      await offered.promise;
      const closed = f.application.close();
      void closed.then(() => {
        closeFinished = true;
      });
      assert.deepEqual(offeredOutcomes, [originalOutcome]);
      assert.equal(offeredOutcomes[0], originalOutcome);
      if (acknowledgement === "delayed") {
        await immediate();
        assert.equal(publicationFinished, false);
        assert.equal(closeFinished, false);
        assert.deepEqual(releasedPrepared, []);
        acknowledgementGate.resolve("committed");
      }
      await retiring.promise;
      await immediate();
      assert.equal(publicationFinished, false);
      assert.equal(closeFinished, false);
      assert.equal(useReleased, 0);
      assert.deepEqual(releasedEffects, []);
      retirementGate.resolve();
      await transferring.promise;
      await immediate();
      assert.equal(publicationFinished, false);
      assert.equal(closeFinished, false);
      assert.equal(useReleased, 1);
      assert.equal(submitted, 1);
      assert.equal(uncertainOutcomes.length, acknowledgement === "failed" ? 1 : 0);
      if (acknowledgement === "failed") assert.equal(uncertainOutcomes[0], originalOutcome);
      assert.equal(releasedPrepared.length, 1);
      assert.equal(releasedPrepared[0], originalPrepared);
      assert.equal(releasedEffects.length, 1);
      assert.equal(releasedEffects[0], originalEffect);
      transferGate.resolve();
      const result = await publication;
      await closed;
      assert.equal(result.kind, "complete");
      assert.equal(result.value.state, "unknown");
      assert.equal(result.value.pullRequest, null);
      assert.equal(claimed, 1);
      assert.equal(begun, 1);
      assert.equal(submitted, 1);
      assert.deepEqual(f.forbidden, []);
    }
  },
);

for (const drainShape of ["missing", "throwing"])
  for (const resultKind of ["fulfilled", "rejected"])
    componentTest(
      `${drainShape} drain retains the ${resultKind} native result through original retirement`,
      async (t) => {
        // These controlled peers expose the application's cleanup schedule only.
        // Candidate restore and Git validation use the actual protected custodian.
        const originalCandidate = Object.freeze({}),
          originalApproval = Object.freeze({}),
          originalEffect = Object.freeze({}),
          originalPrepared = Object.freeze({}),
          originalUse = Object.freeze({}),
          originalOutcome = Object.freeze({}),
          selectedPolicy = policy(),
          retiring = deferred(),
          retirementGate = deferred(),
          offered = deferred(),
          transferGate = deferred();
        selectedPolicy.rules[0].allowCreate = true;
        const resultGate = Promise.withResolvers();
        let capturedCandidate,
          capturedEffect,
          submissions = 0,
          useReleased = 0,
          effectReleased = 0,
          finished = false;
        const observations = [];
        const f = await componentFixture(t, {}, 1, {
          capture: true,
          policy: selectedPolicy,
          state: {
            async claimEffect() {
              return { kind: "committed", original: originalEffect };
            },
            inspectEffect(actual) {
              assert.equal(actual, originalEffect);
              return {
                effect: capturedEffect,
                candidate: originalCandidate,
                approval: originalApproval,
              };
            },
            inspectCandidate(actual) {
              assert.equal(actual, originalCandidate);
              return { candidateRef: "candidate/1", candidate: capturedCandidate };
            },
            inspectApproval(actual) {
              assert.equal(actual, originalApproval);
              return {
                version: 1,
                approvalRef: "approval/1",
                candidateRef: "candidate/1",
                actionDigest: capturedCandidate.actionDigest,
                approverPrincipalId: "principal/reviewer",
                policyRef: selectedPolicy.policyRef,
                policyRevision: selectedPolicy.revision,
                policyDigest: publicationDigestV1("approver-policy", selectedPolicy),
                approvedAtMs: 1000,
                expiresAtMs: 2000,
              };
            },
            async acquireUse(actualEffect, actualPrepared) {
              assert.equal(actualEffect, originalEffect);
              assert.equal(actualPrepared, originalPrepared);
              return {
                original: originalUse,
                candidate: originalCandidate,
                approval: originalApproval,
                effect: originalEffect,
                assertCurrent() {},
                beginSubmittedUse() {},
                async release() {
                  useReleased++;
                },
              };
            },
            async recordUncertain(actualEffect, outcome) {
              assert.equal(actualEffect, originalEffect);
              observations.push(outcome);
              offered.resolve();
              return "unknown";
            },
            async statusForEffect(actual) {
              assert.equal(actual, originalEffect);
              return {
                version: 1,
                candidateRef: "candidate/1",
                actionDigest: capturedCandidate.actionDigest,
                state: "unknown",
                push: { effect: capturedEffect, outcome: { kind: "unknown", pullRequest: null } },
                pullRequest: null,
              };
            },
            releaseEffect(actual) {
              assert.equal(actual, originalEffect);
              effectReleased++;
              return transferGate.promise;
            },
          },
          dispatcher: {
            async preparePush() {
              return originalPrepared;
            },
            inspectPrepared(actual) {
              assert.equal(actual, originalPrepared);
              return {
                effectRef: capturedEffect.effectRef,
                actionDigest: capturedCandidate.actionDigest,
                kind: "push",
              };
            },
            submit(actualPrepared, actualUse) {
              assert.equal(actualPrepared, originalPrepared);
              assert.equal(actualUse, originalUse);
              submissions++;
              const ticket = { result: resultGate.promise };
              if (drainShape === "throwing")
                Object.defineProperty(ticket, "drained", {
                  get() {
                    throw new Error("Controlled drain getter failure");
                  },
                });
              return ticket;
            },
            releasePrepared(actual) {
              assert.equal(actual, originalPrepared);
              retiring.resolve();
              return retirementGate.promise;
            },
          },
        });
        f.unblock.push(
          () => resultGate.resolve(originalOutcome),
          retirementGate.resolve,
          transferGate.resolve,
        );
        const object = (type, bytes) => ({
          type,
          bytes,
          oid: createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex"),
        });
        const tree = object("tree", Buffer.alloc(0));
        const commit = object(
          "commit",
          Buffer.from(
            `tree ${tree.oid}\nauthor Component Fixture <component@example.invalid> 946684800 +0000\n` +
              "committer Component Fixture <component@example.invalid> 946684800 +0000\n\nComponent fixture\n",
          ),
        );
        const req = {
          ...request(),
          baseOid: commit.oid,
          proposedOid: commit.oid,
          expectedTarget: { kind: "create" },
        };
        const call = componentCall();
        const capture = await f.custody.capture(req, [tree, commit], call.signal);
        capturedCandidate = createPublicationCandidateV1(
          work(req),
          req,
          f.custody.inspect(capture),
        );
        capturedEffect = effect("push", capturedCandidate);
        const publication = f.application.publish({}, "candidate/1", "approval/1", call);
        await retiring.promise;
        const closed = f.application.close();
        void closed.then(() => {
          finished = true;
        });
        if (resultKind === "rejected") {
          // Node's test runner fails on an unhandled rejection. Reject while
          // physical retirement is still pending, before cleanup can await it.
          resultGate.reject(new Error("Controlled native result failure"));
          await immediate();
        }
        assert.equal(finished, false);
        assert.equal(useReleased, 0);
        assert.deepEqual(observations, []);
        retirementGate.resolve();
        if (resultKind === "fulfilled") {
          // Even after prepared retirement the result may arrive later. Its
          // original observer and use lease must remain held until it settles.
          await immediate();
          assert.equal(useReleased, 0);
          assert.equal(effectReleased, 0);
          assert.deepEqual(observations, []);
          resultGate.resolve(originalOutcome);
        }
        await offered.promise;
        await immediate();
        assert.deepEqual(observations, [resultKind === "fulfilled" ? originalOutcome : null]);
        assert.equal(useReleased, 1);
        assert.equal(effectReleased, 1);
        assert.equal(finished, false);
        transferGate.resolve();
        const result = await publication;
        await closed;
        assert.equal(result.kind, "complete");
        assert.equal(result.value.state, "unknown");
        assert.equal(submissions, 1);
        assert.deepEqual(f.forbidden, []);
      },
    );

test("closed request decoder refuses extra effects, unsupported targets and changed draft semantics", () => {
  for (const change of [
    (r) => {
      r.actions.push("delete-ref");
    },
    (r) => {
      r.actions.reverse();
    },
    (r) => {
      r.force = true;
    },
    (r) => {
      r.repository.url = "https://elsewhere.invalid";
    },
    (r) => {
      r.repository.githubHost = "elsewhere.invalid";
    },
    (r) => {
      r.repository.repositoryId = "0300";
    },
    (r) => {
      r.expectedTarget = { kind: "create", oid: oid("b") };
    },
    (r) => {
      r.expectedTarget = { kind: "existing", oid: r.proposedOid };
    },
    (r) => {
      r.draftPullRequest.draft = false;
    },
    (r) => {
      r.draftPullRequest.title = "title\nheader";
    },
    (r) => {
      r.draftPullRequest.body = "body\0hidden";
    },
    (r) => {
      r.targetBranch = r.baseBranch;
    },
  ]) {
    const input = request();
    change(input);
    refuses(() => parsePublicationRequestV1(input));
  }
});

test("branch and object identifiers consume the entire string, including final newlines", () => {
  for (const branch of [
    "topic\n",
    "../topic",
    "topic//child",
    "topic.lock",
    "topic/.child",
    "topic..child",
    "topic/",
    "/topic",
    "topic\\child",
    "topic@{1}",
  ]) {
    const input = request();
    input.targetBranch = branch;
    refuses(() => parsePublicationRequestV1(input));
  }
  for (const field of ["baseOid", "proposedOid"]) {
    const input = request();
    input[field] += "\n";
    refuses(() => parsePublicationRequestV1(input));
  }
  for (const field of ["installationId", "appId", "githubInstallationId", "repositoryId"]) {
    const input = request();
    input.repository[field] += "\n";
    refuses(() => parsePublicationRequestV1(input));
  }
  const req = request();
  const binding = work(req);
  binding.executionBindingDigest += "\n";
  refuses(() => parsePublicationWorkBindingV1(binding));
  const projected = graph(req);
  projected.packSha256 += "\n";
  refuses(() => parsePublicationGraphV1(projected));
});

test("snapshot rejects executable object structure without invoking its accessors or proxy traps", () => {
  let invoked = 0;
  const accessor = Object.defineProperty({}, "field", {
    enumerable: true,
    get() {
      invoked++;
      return "value";
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        invoked++;
        throw Error("must not execute");
      },
      getPrototypeOf() {
        invoked++;
        throw Error("must not execute");
      },
    },
  );
  const withJSON = {
    toJSON() {
      invoked++;
      return {};
    },
  };
  for (const value of [
    accessor,
    proxy,
    withJSON,
    new Date(),
    new Uint8Array([1]),
    Object.create({ inherited: true }),
  ]) {
    refuses(() => publicationSnapshotV1(value));
  }
  assert.equal(invoked, 0);
  const sparse = [];
  sparse.length = 2;
  refuses(() => publicationSnapshotV1(sparse));
  const cyclic = {};
  cyclic.self = cyclic;
  refuses(() => publicationSnapshotV1(cyclic));
  const symbols = { [Symbol("hidden")]: "hidden" };
  refuses(() => publicationSnapshotV1(symbols));
});

test("snapshot bounds escaped encoded bytes and aggregate shape before accepting data", () => {
  assert.equal(publicationSnapshotV1("a".repeat(131072)).length, 131072);
  refuses(() => publicationSnapshotV1("a".repeat(131073)));
  // The raw string fits the per-string limit but JSON escape expansion exceeds
  // the aggregate budget; testing only its unescaped length would miss this.
  refuses(() => publicationSnapshotV1("\0".repeat(44000)));
  refuses(() => publicationSnapshotV1(Array.from({ length: 7 }, () => "a".repeat(40000))));
  let deep = null;
  for (let i = 0; i < 34; i++) deep = { child: deep };
  refuses(() => publicationSnapshotV1(deep));
});

test("candidate digest binds exact request, graph and Work comparison records", () => {
  const original = candidate();
  assert.equal(parsePublicationCandidateV1(original).actionDigest, original.actionDigest);
  for (const change of [
    (c) => {
      c.request.draftPullRequest.body += "edited";
    },
    (c) => {
      c.request.expectedTarget.oid = oid("d");
    },
    (c) => {
      c.graph.graphDigest = digest("a");
    },
    (c) => {
      c.graph.packSha256 = digest("b");
    },
    (c) => {
      c.work.workRevision++;
    },
    (c) => {
      c.work.authorityRevision = "2";
    },
    (c) => {
      c.work.requesterPrincipalId = "principal/other";
    },
    (c) => {
      c.actionDigest = digest("0");
    },
    (c) => {
      c.extra = "unbound";
    },
  ]) {
    const changed = structuredClone(original);
    change(changed);
    refuses(() => parsePublicationCandidateV1(changed));
  }
  const reordered = Object.fromEntries(Object.entries(request()).reverse());
  assert.equal(candidate(reordered).actionDigest, original.actionDigest);
});

test("candidate construction refuses mismatched repository, root, base or request digest", () => {
  const req = request();
  for (const change of [
    (w, g) => {
      w.installationId = "installation/other";
    },
    (w, g) => {
      w.requestDigest = digest("a");
    },
    (w, g) => {
      g.proposedOid = oid("d");
    },
    (w, g) => {
      g.baseOid = oid("d");
    },
  ]) {
    const binding = work(req),
      projected = graph(req);
    change(binding, projected);
    refuses(() => createPublicationCandidateV1(binding, req, projected));
  }
});

test("policy decoding requires explicit approvers, lifetime and an exact action bundle", () => {
  for (const change of [
    (p) => {
      p.approverPrincipalIds = [];
    },
    (p) => {
      p.approverPrincipalIds.push(p.approverPrincipalIds[0]);
    },
    (p) => {
      delete p.allowSelfApproval;
    },
    (p) => {
      p.approvalLifetimeMs = 0;
    },
    (p) => {
      p.approvalLifetimeMs = 86400001;
    },
    (p) => {
      p.rules = [];
    },
    (p) => {
      p.rules[0].targetBranches.push(p.rules[0].targetBranches[0]);
    },
    (p) => {
      p.actions = ["push"];
    },
    (p) => {
      p.allowAny = true;
    },
  ]) {
    const input = policy();
    change(input);
    refuses(() => parsePublicationApproverPolicyV1(input));
  }
});

test("local policy predicate checks self-approval, exact repository/branches and creation separately", () => {
  const c = candidate();
  assert.equal(
    publicationPolicyAllowsV1(parsePublicationApproverPolicyV1(policy()), c, "principal/reviewer"),
    true,
  );
  assert.equal(
    publicationPolicyAllowsV1(parsePublicationApproverPolicyV1(policy()), c, "principal/other"),
    false,
  );
  const self = policy();
  self.approverPrincipalIds = [c.work.requesterPrincipalId];
  assert.equal(
    publicationPolicyAllowsV1(
      parsePublicationApproverPolicyV1(self),
      c,
      c.work.requesterPrincipalId,
    ),
    false,
  );
  self.allowSelfApproval = true;
  assert.equal(
    publicationPolicyAllowsV1(
      parsePublicationApproverPolicyV1(self),
      c,
      c.work.requesterPrincipalId,
    ),
    true,
  );
  for (const change of [
    (p) => {
      p.rules[0].repository.repositoryId = "301";
    },
    (p) => {
      p.rules[0].repository.githubInstallationId = "201";
    },
    (p) => {
      p.rules[0].baseBranch = "other-base";
    },
    (p) => {
      p.rules[0].targetBranches = ["other-target"];
    },
  ]) {
    const input = policy();
    change(input);
    assert.equal(
      publicationPolicyAllowsV1(parsePublicationApproverPolicyV1(input), c, "principal/reviewer"),
      false,
    );
  }
  const createRequest = request();
  createRequest.expectedTarget = { kind: "create" };
  const creation = candidate(createRequest),
    input = policy();
  assert.equal(
    publicationPolicyAllowsV1(
      parsePublicationApproverPolicyV1(input),
      creation,
      "principal/reviewer",
    ),
    false,
  );
  input.rules[0].allowCreate = true;
  assert.equal(
    publicationPolicyAllowsV1(
      parsePublicationApproverPolicyV1(input),
      creation,
      "principal/reviewer",
    ),
    true,
  );
});
