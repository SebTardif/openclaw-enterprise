import assert from "node:assert/strict";
import test from "node:test";
import {
  RepositoryPublicationWorkOwnerV1,
  parsePublicationWorkPolicyV1,
  publicationWorkPolicyDigestV1,
  publicationWorkExecutionDigestV1,
  compareWorkAdmittedExecutionV2,
  comparePublicationWorkSelectionV1,
} from "../../packages/occ/src/lifecycle/repository-publication-work-v1.ts";
import { publicationDigestV1 } from "../../packages/occ/src/repository-publication-v1/contract.ts";

// Actual Work component; controlled private controller/native and State peers.
// These are not production IAM, SQL COMMIT, native exchange or GitHub evidence.
const clone = (value) => structuredClone(value);
const later = () => new Promise((resolve) => setImmediate(resolve));
function holdForMilliseconds(milliseconds) {
  // Real synchronous callback latency in Work's selected monotonic domain.
  const until = process.hrtime.bigint() + BigInt(milliseconds) * 1_000_000n;
  while (process.hrtime.bigint() < until) {
    /* bounded controlled-peer delay */
  }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(t, hooks = {}) {
  const now = Date.now(),
    iso = (n) => new Date(n).toISOString();
  const scope = {
    installationRef: "installation/one",
    namespaceRef: "namespace/one",
    agentRef: "agent/one",
    revisionRef: "revision/one",
  };
  const service = {
    kind: "service_principal",
    id: "service/one",
    namespaceId: scope.namespaceRef,
    agentId: scope.agentRef,
  };
  const profile = { ref: "profile/one", revision: "1" };
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
  const request = {
    version: 1,
    repository: {
      installationId: scope.installationRef,
      githubHost: "github.com",
      appId: "1",
      githubInstallationId: "2",
      repositoryId: "3",
    },
    baseBranch: "main",
    baseOid: "1".repeat(40),
    targetBranch: "work/result",
    expectedTarget: { kind: "create" },
    proposedOid: "2".repeat(40),
    draftPullRequest: { title: "Result", body: "Scoped change", draft: true },
    actions: ["push", "create-draft-pr"],
  };
  const controller = new AbortController();
  const call = { requestRef: "request/one", signal: controller.signal };
  const actor = Object.freeze({ controlledActor: true });
  const originalInvocation = Object.freeze({ controlledInvocation: true });
  const admission = Object.freeze({ controlledKnownAdmission: true });
  const originalUse = Object.freeze({ controlledHeldUse: true });
  const invocationRef = "invocation/one",
    digest = publicationDigestV1("request", request);
  const originalAdmission = Object.freeze({
    operationRef: "operation/admit",
    requestDigest: "sha256:" + "a".repeat(64),
    invocationRef,
    scope,
  });
  const originalOperation = Object.freeze({
    operationRef: "operation/publish",
    requestDigest: digest,
    invocationRef,
    scope,
  });
  const invocation = {
    scope,
    requesterPrincipalId: "principal/one",
    invocationRef,
    service,
    execution,
    requestDigest: digest,
    callDeadline: iso(now + 120_000),
    cancellationScopeRef: "cancel/one",
  };
  const policy = {
    version: 1,
    policyRef: "policy/one",
    revision: "1",
    status: "enabled",
    scope,
    servicePrincipalId: service.id,
    executionProfile: profile,
    operation: "work.repository.publish",
    permission: "repository:publish",
    actions: ["push", "create-draft-pr"],
    admitAttachedWork: false,
    repository: clone(request.repository),
    baseBranch: "main",
    targetBranches: ["work/result"],
    allowCreate: true,
    bounds: {
      notBefore: iso(now - 1000),
      notAfter: iso(now + 300_000),
      maximumWorkMilliseconds: 300_000,
      maximumCallMilliseconds: 180_000,
      maximumClockUncertaintyMilliseconds: 0,
    },
  };
  const work = { workRef: "work/one", revision: 1 };
  const admitted = {
    admissionOriginal: originalAdmission,
    work,
    owner: service,
    requesterPrincipalId: invocation.requesterPrincipalId,
    invocationRef,
    execution,
    lineage: {
      scope,
      own: { work, originalHorizon: iso(now + 180_000), state: "open", withdrawalRevision: 0 },
      membershipProfile: profile,
      kind: "root",
      rootWorkRef: work.workRef,
      parentWorkRef: null,
      ancestors: [],
    },
    workBeganAt: iso(now - 500),
    originalHorizon: iso(now + 180_000),
    cancellationScopeRef: invocation.cancellationScopeRef,
    authority: {
      ref: "authority/one",
      revision: "1",
      notBefore: iso(now - 500),
      notAfter: iso(now + 180_000),
    },
  };
  const rowScope = {
    installationId: scope.installationRef,
    namespaceId: scope.namespaceRef,
    agentId: scope.agentRef,
    revisionRef: scope.revisionRef,
  };
  const row = {
    scope: rowScope,
    workRef: work.workRef,
    revision: 1,
    withdrawalRevision: 0,
    parentWorkRef: null,
    rootWorkRef: work.workRef,
    originalHorizon: admitted.originalHorizon,
    state: "open",
    execution: clone(execution),
    policy: clone(policy),
    originalAdmission: clone(originalAdmission),
  };
  const data = {
    operation: originalOperation,
    admitted,
    readset: { scope: rowScope, lineage: [row] },
    policy,
    admittedPolicyDigest: publicationWorkPolicyDigestV1(policy),
  };
  const events = [],
    counts = { invocation: 0, admission: 0, use: 0 };
  const state = {
    live: true,
    committed: false,
    mode: "committed",
    operation: originalOperation,
    admissionOperation: originalAdmission,
    now,
    // Controlled qualification for this component fixture; no production clock
    // enrollment or real State/native supplier is established by these values.
    clock: { maxWallAdvancePpm: 1_000_000, validForMonotonicMs: 300_000 },
  };
  const originals = new WeakSet([
    actor,
    originalInvocation,
    admission,
    originalUse,
    originalOperation,
    originalAdmission,
  ]);
  function check(value) {
    assert.ok(originals.has(value), "controlled peer recognizes original identity");
  }
  function exact(i, r, c) {
    check(i);
    assert.equal(i, originalInvocation);
    assert.equal(r, request);
    assert.equal(c, call);
  }
  function current() {
    assert.equal(state.live, true, "held currentness");
  }
  function inspect() {
    const copied = clone(data);
    // Comparison values detach; both privately enrolled operation objects do not.
    copied.operation = state.operation;
    copied.admitted.admissionOriginal = state.admissionOperation;
    check(copied.operation);
    check(copied.admitted.admissionOriginal);
    return copied;
  }
  const invocationLease = {
    original: originalInvocation,
    inspect() {
      return clone(invocation);
    },
    assertNativeCurrent() {
      current();
      return hooks.nativeCurrent?.();
    },
    async prepareStateUse() {
      events.push("handoff");
      await hooks.handoff?.();
    },
    async release() {
      events.push("release-invocation");
      counts.invocation++;
      await hooks.releaseInvocation?.();
    },
  };
  const admissionLease = {
    inspect,
    assertCurrent() {
      current();
      return hooks.admissionCurrent?.();
    },
    async prepareCommit() {
      events.push("prepare-admission");
      await hooks.prepareAdmission?.();
    },
    async commitAdmission() {
      events.push("commit");
      await hooks.commit?.();
      if (state.mode !== "committed") return { kind: state.mode };
      state.committed = true;
      return { kind: "committed", original: admission };
    },
    async release() {
      events.push("release-admission");
      counts.admission++;
      await hooks.releaseAdmission?.();
    },
  };
  const useLease = {
    original: originalUse,
    inspect,
    assertCurrent() {
      current();
      return hooks.useCurrent?.();
    },
    async prepare() {
      events.push("prepare-use");
      await hooks.prepareUse?.();
    },
    async release() {
      events.push("release-use");
      counts.use++;
      await hooks.releaseUse?.();
    },
  };
  const sources = {
    invocation: {
      async acquire(a, r, c) {
        assert.equal(a, actor);
        assert.equal(r, request);
        assert.equal(c, call);
        check(a);
        events.push("acquire-invocation");
        await hooks.acquireInvocation?.();
        return invocationLease;
      },
      recognize(i, a, r, c) {
        exact(i, r, c);
        assert.equal(a, actor);
        current();
      },
    },
    state: {
      async acquireAdmission(i, r, c) {
        exact(i, r, c);
        assert.ok(events.includes("handoff"));
        events.push("acquire-admission");
        await hooks.acquireAdmission?.();
        return admissionLease;
      },
      recognizeAdmission(a, i, r, c) {
        exact(i, r, c);
        check(a);
        assert.equal(a, admission);
        assert.ok(state.committed);
        current();
      },
      async acquireUse(a, i, r, c) {
        exact(i, r, c);
        assert.equal(a, admission);
        assert.ok(state.committed);
        assert.ok(events.includes("release-admission"));
        events.push("acquire-use");
        await hooks.acquireUse?.();
        return useLease;
      },
      recognizeUse(u, a, i, r, c) {
        exact(i, r, c);
        check(u);
        assert.equal(u, originalUse);
        assert.equal(a, admission);
        current();
      },
    },
    clock: {
      read() {
        hooks.clock?.();
        return { wallMs: state.now, uncertaintyMs: 0, ...state.clock };
      },
    },
  };
  const owner = new RepositoryPublicationWorkOwnerV1(sources, { maximumActive: 2 });
  t.after(async () => {
    for (const key of Object.keys(hooks)) delete hooks[key];
    await owner.close();
  });
  return {
    owner,
    actor,
    request,
    call,
    controller,
    originalInvocation,
    admission,
    originalUse,
    invocationLease,
    admissionLease,
    useLease,
    invocation,
    data,
    policy,
    state,
    events,
    counts,
    sources,
    hooks,
    acquire: () => owner.acquire(actor, request, call),
    inspect,
    now,
  };
}

test("private Work requires known admission and held use, with exact original receipt", async (t) => {
  const f = fixture(t),
    work = await f.acquire();
  assert.ok(work);
  assert.equal(f.owner.assertCurrent(work, f.call), undefined);
  assert.equal(f.owner.recognize(work, f.call), f.admission);
  const binding = f.owner.inspect(work, f.call);
  assert.equal(binding.requestDigest, publicationDigestV1("request", f.request));
  assert.equal(
    binding.executionBindingDigest,
    publicationWorkExecutionDigestV1(f.invocation.execution),
  );
  assert.ok(Object.isFrozen(binding));
  assert.deepEqual(f.events.slice(0, 8), [
    "acquire-invocation",
    "handoff",
    "acquire-admission",
    "prepare-admission",
    "commit",
    "release-admission",
    "acquire-use",
    "prepare-use",
  ]);
  await f.owner.release(work);
  await f.owner.release(work);
  assert.deepEqual(f.counts, { invocation: 1, admission: 1, use: 1 });
  assert.throws(() => f.owner.inspect(work, f.call));
});
test("copied and foreign Work handles and copied calls refuse", async (t) => {
  const f = fixture(t),
    other = fixture(t),
    work = await f.acquire();
  assert.throws(() => f.owner.inspect({ ...work }, f.call));
  assert.throws(() => other.owner.inspect(work, f.call));
  assert.throws(() => f.owner.inspect(work, { ...f.call }));
  assert.equal(f.owner.assertCurrent(work, f.call), undefined);
});
for (const mode of ["unknown", "refused"])
  test(mode + " admission cannot create use", async (t) => {
    const f = fixture(t);
    f.state.mode = mode;
    assert.equal(await f.acquire(), undefined);
    assert.ok(!f.events.includes("acquire-use"));
    assert.deepEqual(f.counts, { invocation: 1, admission: 1, use: 0 });
  });
for (const [label, mutate] of [
  [
    "metadata V2",
    (p) => {
      p.operation = "work.repository.use";
      p.permission = "metadata:read";
    },
  ],
  [
    "Git V3",
    (p) => {
      p.operation = "work.repository.use";
      p.permission = "git:read";
      p.requiredPermissions = ["contents:read", "metadata:read"];
    },
  ],
  [
    "extra permissions",
    (p) => {
      p.permissions = ["repository:publish", "administration:write"];
    },
  ],
  [
    "action order",
    (p) => {
      p.actions.reverse();
    },
  ],
  [
    "attached Work",
    (p) => {
      p.admitAttachedWork = true;
    },
  ],
  [
    "repository",
    (p) => {
      p.repository.repositoryId = "4";
    },
  ],
  [
    "branch",
    (p) => {
      p.targetBranches = ["another/branch"];
    },
  ],
  [
    "create permission",
    (p) => {
      p.allowCreate = false;
    },
  ],
  [
    "disabled",
    (p) => {
      p.status = "disabled";
    },
  ],
])
  test("closed publication policy refuses " + label, async (t) => {
    const f = fixture(t);
    mutate(f.data.policy);
    assert.equal(await f.acquire(), undefined);
    assert.ok(!f.events.includes("commit"));
  });
for (const [label, mutate] of [
  [
    "requester",
    (f) => {
      f.data.admitted.requesterPrincipalId = "principal/other";
    },
  ],
  [
    "execution",
    (f) => {
      f.data.admitted.execution.receiverRef = "receiver/other";
    },
  ],
  [
    "scope",
    (f) => {
      f.data.readset.scope.revisionRef = "revision/other";
    },
  ],
  [
    "Work revision",
    (f) => {
      f.data.admitted.work.revision = 2;
    },
  ],
  [
    "withdrawal",
    (f) => {
      f.data.readset.lineage[0].withdrawalRevision = 1;
    },
  ],
  [
    "missing lineage",
    (f) => {
      f.data.readset.lineage = [];
    },
  ],
  [
    "closed Work",
    (f) => {
      f.data.readset.lineage[0].state = "closed";
    },
  ],
  [
    "horizon",
    (f) => {
      f.data.admitted.originalHorizon = new Date(f.now + 500_000).toISOString();
    },
  ],
  [
    "authority revision",
    (f) => {
      f.data.admitted.authority.revision = "";
    },
  ],
])
  test("admitted selection refuses " + label, async (t) => {
    const f = fixture(t);
    mutate(f);
    assert.equal(await f.acquire(), undefined);
  });
test("pure parser and comparison return immutable data without a Work handle", (t) => {
  const f = fixture(t),
    p = parsePublicationWorkPolicyV1(f.policy);
  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.bounds));
  compareWorkAdmittedExecutionV2(f.data.admitted, f.data.readset, f.invocation);
  const binding = comparePublicationWorkSelectionV1(f.inspect(), f.invocation, f.request, {
    wallMs: f.now,
    uncertaintyMs: 0,
  });
  assert.equal(binding.workRef, "work/one");
  assert.throws(() => f.owner.inspect(binding, f.call));
});
test("request mutation poisons currentness permanently", async (t) => {
  const f = fixture(t),
    work = await f.acquire();
  f.request.draftPullRequest.body = "different";
  assert.throws(() => f.owner.assertCurrent(work, f.call));
  f.request.draftPullRequest.body = "Scoped change";
  assert.throws(() => f.owner.assertCurrent(work, f.call));
});
test("policy changed inside currentness is detected", async (t) => {
  const f = fixture(t),
    work = await f.acquire();
  f.hooks.useCurrent = () => {
    f.data.policy.permission = "contents:read";
  };
  assert.throws(() => f.owner.assertCurrent(work, f.call));
});
test("clock callback runs before held-policy inspection", async (t) => {
  const f = fixture(t),
    work = await f.acquire();
  f.hooks.clock = () => {
    f.data.policy.status = "disabled";
  };
  assert.throws(() => f.owner.assertCurrent(work, f.call));
});
test("same call cannot reenter or renew its fixed deadline", async (t) => {
  const f = fixture(t),
    work = await f.acquire();
  assert.equal(await f.acquire(), undefined);
  f.invocation.callDeadline = new Date(f.now + 150_000).toISOString();
  assert.throws(() => f.owner.assertCurrent(work, f.call));
});
for (const field of ["operation", "admissionOperation"]) {
  test("copied " + field + " refuses at actual controlled private recognizer", async (t) => {
    const f = fixture(t);
    f.state[field] = { ...f.state[field] };
    assert.equal(await f.acquire(), undefined);
  });
}
test("release is captured before a throwing lease data getter", async (t) => {
  const f = fixture(t);
  Object.defineProperty(f.invocationLease, "original", {
    get() {
      throw Error("data getter");
    },
  });
  assert.equal(await f.acquire(), undefined);
  assert.equal(f.counts.invocation, 1);
});
for (const stage of [
  "acquireInvocation",
  "acquireAdmission",
  "commit",
  "acquireUse",
  "prepareUse",
]) {
  test(
    "abort joins entered " + stage + " and retires late custody",
    { timeout: 5000 },
    async (t) => {
      const gate = deferred(),
        started = deferred();
      const f = fixture(t, {
        [stage]: () => {
          started.resolve();
          return gate.promise;
        },
      });
      const acquiring = f.acquire();
      await started.promise;
      f.controller.abort();
      let settled = false;
      void acquiring.then(() => {
        settled = true;
      });
      await later();
      assert.equal(settled, false);
      gate.resolve();
      assert.equal(await acquiring, undefined);
      assert.equal(f.counts.invocation, 1);
      assert.ok(f.counts.admission <= 1 && f.counts.use <= 1);
    },
  );
}
for (const stage of ["nativeCurrent", "admissionCurrent", "useCurrent"]) {
  test(
    "nonvoid " + stage + " is latched before async assertion drains",
    { timeout: 5000 },
    async (t) => {
      const gate = deferred(),
        started = deferred();
      const f = fixture(t, {
        [stage]: () => {
          started.resolve();
          return gate.promise;
        },
      });
      const acquiring = f.acquire();
      await started.promise;
      let settled = false;
      void acquiring.then(() => {
        settled = true;
      });
      await later();
      assert.equal(settled, false);
      delete f.hooks[stage];
      gate.reject(Error("controlled late assertion rejection"));
      assert.equal(await acquiring, undefined);
      assert.equal(f.counts.invocation, 1);
    },
  );
}
test("concurrent release joins one original retirement", async (t) => {
  const gate = deferred(),
    started = deferred(),
    f = fixture(t),
    work = await f.acquire();
  f.hooks.releaseUse = () => {
    started.resolve();
    return gate.promise;
  };
  const first = f.owner.release(work),
    second = f.owner.release(work);
  assert.equal(first, second);
  await started.promise;
  assert.equal(f.counts.use, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(f.counts, { invocation: 1, admission: 1, use: 1 });
});
test("failed finalizer retries only incomplete original retirement", async (t) => {
  const f = fixture(t),
    work = await f.acquire();
  f.hooks.releaseUse = async () => {
    throw Error("controlled retirement failure");
  };
  await assert.rejects(f.owner.release(work));
  delete f.hooks.releaseUse;
  await f.owner.release(work);
  assert.deepEqual(f.counts, { invocation: 1, admission: 1, use: 2 });
});
test("constructor captures original methods once", async (t) => {
  const f = fixture(t);
  f.sources.state.acquireAdmission = async () => {
    throw Error("replacement");
  };
  assert.ok(await f.acquire());
});
test("non-original actor refuses before State", async (t) => {
  const f = fixture(t);
  assert.equal(await f.owner.acquire({ ...f.actor }, f.request, f.call), undefined);
  assert.ok(!f.events.includes("acquire-admission"));
});
test("expired original bounds refuse before COMMIT", async (t) => {
  const f = fixture(t);
  f.state.now += 400_000;
  assert.equal(await f.acquire(), undefined);
  assert.ok(!f.events.includes("commit"));
});

test("selection comparison refuses a different invocation request digest", (t) => {
  const f = fixture(t);
  f.invocation.requestDigest = "sha256:" + "b".repeat(64);
  assert.throws(() =>
    comparePublicationWorkSelectionV1(f.inspect(), f.invocation, f.request, {
      wallMs: f.now,
      uncertaintyMs: 0,
    }),
  );
});
test(
  "async inspection rejection remains joined after immediate refusal",
  { timeout: 5000 },
  async (t) => {
    const gate = deferred(),
      started = deferred(),
      f = fixture(t);
    f.invocationLease.inspect = () => {
      started.resolve();
      return gate.promise;
    };
    const acquiring = f.acquire();
    await started.promise;
    let settled = false;
    void acquiring.then(() => {
      settled = true;
    });
    await later();
    assert.equal(settled, false);
    gate.reject(Error("controlled asynchronous inspection"));
    assert.equal(await acquiring, undefined);
    assert.equal(f.counts.invocation, 1);
  },
);
test("failed use retirement retains its original invocation until retry", async (t) => {
  const f = fixture(t),
    work = await f.acquire();
  f.hooks.releaseUse = async () => {
    throw Error("controlled incomplete use drain");
  };
  await assert.rejects(f.owner.release(work));
  assert.equal(f.counts.invocation, 0);
  delete f.hooks.releaseUse;
  await f.owner.release(work);
  assert.equal(f.counts.invocation, 1);
});

for (const operation of ["assertCurrent", "inspect", "recognize"]) {
  test("RW-PUB-1 " + operation + " uses a fresh clock after held callbacks", async (t) => {
    const f = fixture(t),
      work = await f.acquire();
    f.hooks.useCurrent = () => {
      f.state.now = f.now + 400_000;
    };
    assert.throws(() => f.owner[operation](work, f.call));
    delete f.hooks.useCurrent;
    f.state.now = f.now;
    assert.throws(() => f.owner[operation](work, f.call));
  });
}
for (const phase of [1, 2])
  for (const callback of ["current", "inspect"]) {
    test(
      "RW-PUB-1 admission " + callback + " expiration at phase " + phase + " never commits",
      async (t) => {
        const f = fixture(t);
        let fired = false;
        const expire = () => {
          // Final authority checks may repeat within one phase. Preserve the
          // separate before-prepare and after-prepare expiration scenarios.
          const actualPhase = f.events.includes("prepare-admission") ? 2 : 1;
          if (!fired && actualPhase === phase) {
            fired = true;
            f.state.now = f.now + 400_000;
          }
        };
        if (callback === "current") f.hooks.admissionCurrent = expire;
        else {
          const original = f.admissionLease.inspect;
          f.admissionLease.inspect = () => {
            expire();
            return original();
          };
        }
        assert.equal(await f.acquire(), undefined);
        assert.equal(fired, true);
        assert.ok(!f.events.includes("commit"));
        assert.deepEqual(f.counts, { invocation: 1, admission: 1, use: 0 });
      },
    );
  }
test(
  "RW-PUB-1 initial clock callback latency is inside the original monotonic bound",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    f.invocation.callDeadline = new Date(f.now + 40).toISOString();
    let first = true;
    f.hooks.clock = () => {
      if (!first) return;
      first = false;
      // Controlled synchronous clock-source latency with a retained earlier wall
      // sample. Actual elapsed time must count; no clock/global method is patched.
      const until = performance.now() + 80;
      while (performance.now() < until) {
        /* bounded clock-source delay */
      }
    };
    assert.equal(await f.acquire(), undefined);
    assert.ok(!f.events.includes("commit"));
  },
);
test(
  "RW-PUB-1 entered invocation acquisition cannot restart the time anchor",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t, {
      acquireInvocation: () => new Promise((resolve) => setTimeout(resolve, 80)),
    });
    f.invocation.callDeadline = new Date(f.now + 40).toISOString();
    assert.equal(await f.acquire(), undefined);
    assert.ok(!f.events.includes("commit"));
    assert.equal(f.counts.invocation, 1);
  },
);

const lastClockMutations = [
  [
    "policy",
    (f) => {
      f.data.policy.status = "disabled";
    },
    (f) => {
      f.data.policy.status = "enabled";
    },
  ],
  [
    "held lifetime",
    (f) => {
      f.state.live = false;
    },
    (f) => {
      f.state.live = true;
    },
  ],
];
for (const operation of ["assertCurrent", "inspect", "recognize"]) {
  for (const [label, invalidate, restore] of lastClockMutations) {
    test(
      "RW-PUB-2 " + operation + " refuses " + label + " invalidated by its last clock",
      async (t) => {
        const f = fixture(t),
          work = await f.acquire();
        assert.ok(work);
        let reads = 0;
        // The first clock leaves authority valid. Only the final original clock
        // invalidates it, after the first held selection was already inspected.
        f.hooks.clock = () => {
          if (++reads === 2) invalidate(f);
        };
        assert.throws(() => f.owner[operation](work, f.call));
        assert.equal(reads, 2);
        delete f.hooks.clock;
        restore(f);
        assert.throws(() => f.owner[operation](work, f.call));
        await f.owner.release(work);
        assert.deepEqual(f.counts, { invocation: 1, admission: 1, use: 1 });
      },
    );
  }
}
for (const phase of [1, 2]) {
  for (const [label, invalidate] of lastClockMutations) {
    test(
      "RW-PUB-2 admission phase " + phase + " last clock invalidates " + label + " before commit",
      async (t) => {
        const f = fixture(t);
        let reads = 0,
          fired = false;
        // One acquisition anchor, then two samples per admission decision.
        const finalRead = phase === 1 ? 3 : 5;
        f.hooks.clock = () => {
          if (++reads === finalRead) {
            fired = true;
            invalidate(f);
          }
        };
        assert.equal(await f.acquire(), undefined);
        assert.equal(fired, true);
        if (phase === 1) assert.ok(!f.events.includes("prepare-admission"));
        else assert.ok(f.events.includes("prepare-admission"));
        assert.ok(!f.events.includes("commit"));
        assert.ok(!f.events.includes("acquire-use"));
        assert.deepEqual(f.counts, { invocation: 1, admission: 1, use: 0 });
      },
    );
  }
}
test(
  "RW-PUB-2 latest qualified sample includes final held callback latency",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t),
      work = await f.acquire();
    assert.ok(work);
    // The first fixed anchor is still far from the original deadline. Only the
    // latest reading has 40 ms left, so its own projection must count this delay.
    f.state.now = Date.parse(f.invocation.callDeadline) - 40;
    let calls = 0,
      delayed = false;
    f.hooks.useCurrent = () => {
      if (++calls === 2) {
        delayed = true;
        holdForMilliseconds(80);
      }
    };
    assert.throws(() => f.owner.assertCurrent(work, f.call));
    assert.equal(delayed, true);
    delete f.hooks.useCurrent;
    f.state.now = f.now;
    assert.throws(() => f.owner.assertCurrent(work, f.call));
    await f.owner.release(work);
    assert.deepEqual(f.counts, { invocation: 1, admission: 1, use: 1 });
  },
);
test(
  "RW-PUB-2 latest sample anchor precedes its own clock callback",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t),
      work = await f.acquire();
    assert.ok(work);
    f.state.now = Date.parse(f.invocation.callDeadline) - 40;
    let reads = 0,
      delayed = false;
    f.hooks.clock = () => {
      if (++reads === 2) {
        delayed = true;
        holdForMilliseconds(80);
      }
    };
    assert.throws(() => f.owner.assertCurrent(work, f.call));
    assert.equal(delayed, true);
    delete f.hooks.clock;
    f.state.now = f.now;
    assert.throws(() => f.owner.assertCurrent(work, f.call));
    await f.owner.release(work);
    assert.deepEqual(f.counts, { invocation: 1, admission: 1, use: 1 });
  },
);
for (const field of ["maxWallAdvancePpm", "validForMonotonicMs"]) {
  for (const [label, value] of [
    ["missing", undefined],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", NaN],
    ["infinite", Infinity],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["string", "1"],
    ["bigint", 1n],
  ]) {
    test("RW-PUB-2 clock qualification refuses " + label + " " + field, async (t) => {
      const f = fixture(t);
      if (label === "missing") delete f.state.clock[field];
      else f.state.clock[field] = value;
      assert.equal(await f.acquire(), undefined);
      assert.ok(!f.events.includes("acquire-invocation"));
      assert.deepEqual(f.counts, { invocation: 0, admission: 0, use: 0 });
    });
  }
}
test(
  "RW-PUB-2 later samples cannot refresh the first clock validity",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    f.state.clock.validForMonotonicMs = 40;
    f.hooks.acquireInvocation = async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      f.state.clock.validForMonotonicMs = 300_000;
    };
    // The original first qualification has expired even though later samples
    // offer a longer window and every publication horizon remains in bounds.
    assert.equal(await f.acquire(), undefined);
    assert.equal(f.state.clock.validForMonotonicMs, 300_000);
    assert.ok(!f.events.includes("commit"));
    assert.ok(!f.events.includes("acquire-use"));
    assert.equal(f.counts.invocation, 1);
  },
);
test(
  "RW-PUB-2 qualified wall rate scales actual final callback latency",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t),
      work = await f.acquire();
    assert.ok(work);
    f.state.now = Date.parse(f.invocation.callDeadline) - 1000;
    f.state.clock.maxWallAdvancePpm = 4_000_000;
    let calls = 0,
      delayed = false;
    f.hooks.useCurrent = () => {
      if (++calls === 2) {
        delayed = true;
        holdForMilliseconds(300);
      }
    };
    // 300 ms remains below the 1000 ms wall margin at an invented 1:1 rate,
    // but the selected 4:1 conservative bound must refuse the final decision.
    assert.throws(() => f.owner.assertCurrent(work, f.call));
    assert.equal(delayed, true);
    delete f.hooks.useCurrent;
    f.state.now = f.now;
    assert.throws(() => f.owner.assertCurrent(work, f.call));
    await f.owner.release(work);
    assert.deepEqual(f.counts, { invocation: 1, admission: 1, use: 1 });
  },
);
