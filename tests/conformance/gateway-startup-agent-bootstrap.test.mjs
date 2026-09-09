import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { controlledAgentBootstrap } from "../fixtures/gateway-startup-v2/local-bootstrap.mjs";
import { deferred } from "../fixtures/gateway-startup-v1/values.mjs";

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(1);
  }
  assert.fail("The controlled original work did not reach its expected boundary");
}

async function enterOrSettle(entered, operation, label) {
  let timer;
  try {
    await Promise.race([
      entered.promise,
      operation.then(() => assert.fail(`${label} settled without entering its retained work`)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not enter within 2 seconds`)),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("V2 local startup consumes once, holds exact Agent configuration and joins every owner", async () => {
  const f = controlledAgentBootstrap();
  try {
    const enrollment = await f.bootstrap.enroll();
    assert.ok(enrollment);
    assert.equal(await f.bootstrap.enroll(), undefined);
    assert.equal(f.counts.starts, 0);
    assert.deepEqual(f.events.slice(0, 3), ["authenticate", "consume-startup", "bind-material"]);
    assert.deepEqual(f.service.binding(f.handle), f.binding);
    const started = await enrollment.usePort.start(enrollment.recipient, enrollment.startup);
    assert.equal(started.kind, "started");
    assert.equal(f.counts.starts, 1);
    assert.equal(f.events.filter((event) => event === "consume-startup").length, 1);
    assert.ok(f.events.indexOf("bind-material") < f.events.indexOf("borrow-material"));
    assert.ok(f.events.indexOf("borrow-material") < f.events.indexOf("prepare"));
    assert.equal(
      (await enrollment.usePort.start(enrollment.recipient, enrollment.startup)).kind,
      "denied",
    );
    await started.lifetime.recheckCurrent();
    assert.deepEqual(await started.lifetime.close(), {
      cleanup: "finished",
      termination: "unknown",
    });
    assert.equal(started.lifetime.signal.aborted, true);
    assert.deepEqual(f.counts, {
      nativeClose: 1,
      materialClose: 1,
      preparedClose: 1,
      boundClose: 1,
      starts: 1,
    });
  } finally {
    assert.equal(await f.bootstrap.close(), "finished");
  }
});

test("V2 local recipient/startup copies and cross-owner pairs cannot use original enrollment", async () => {
  const f = controlledAgentBootstrap();
  const other = controlledAgentBootstrap();
  try {
    const a = await f.bootstrap.enroll();
    const b = await other.bootstrap.enroll();
    assert.ok(a);
    assert.ok(b);
    for (const [recipient, startup] of [
      [{ ...a.recipient }, a.startup],
      [a.recipient, { ...a.startup }],
      [a.recipient, b.startup],
      [b.recipient, a.startup],
    ]) {
      assert.deepEqual(await a.usePort.start(recipient, startup), { kind: "denied" });
    }
    const started = await a.usePort.start(a.recipient, a.startup);
    assert.equal(started.kind, "started");
    await started.lifetime.close();
  } finally {
    await Promise.all([f.bootstrap.close(), other.bootstrap.close()]);
  }
});

for (const field of ["installationRef", "namespaceRef", "agentRef", "admittedRevisionRef"]) {
  test(`V2 local material ${field} mismatch retains full recovery subject and never starts`, async () => {
    const f = controlledAgentBootstrap({ configuration: { [field]: "different" } });
    try {
      const enrollment = await f.bootstrap.enroll();
      assert.ok(enrollment);
      const result = await enrollment.usePort.start(enrollment.recipient, enrollment.startup);
      assert.deepEqual(result, { kind: "recovery-required", operation: f.binding.startup });
      assert.equal(result.operation.schemaVersion, 2);
      assert.deepEqual(result.operation.subject, f.binding.startup.subject);
      assert.equal(f.counts.starts, 0);
      assert.equal(f.counts.preparedClose, 0);
      assert.equal(f.counts.materialClose, 1);
      assert.equal(f.counts.boundClose, 1);
      assert.equal(f.counts.nativeClose, 1);
    } finally {
      await f.bootstrap.close();
    }
  });
}

for (const [name, mutation] of [
  ["head subject", (record) => (record.head.subject.agentRef = "another-agent")],
  ["latest claim", (record) => (record.head.latestOperationRef = "another-claim")],
  ["claim subject", (record) => (record.claim.command.subject.namespaceRef = "another-namespace")],
  ["claim command", (record) => (record.claim.canonicalCommand = "{}")],
  ["missing submission", (record) => (record.submission = null)],
  ["submission chain", (record) => (record.claim.previousOperationRef = "another-submission")],
  [
    "submission binding",
    (record) => (record.submission.submissionInput.binding.configDigest = "another-config"),
  ],
]) {
  test(`V2 Source refuses ${name} mismatch before material`, async () => {
    const f = controlledAgentBootstrap({
      execute(_command, _bounds, original) {
        const record = structuredClone(original);
        mutation(record);
        return { kind: "consumed", record };
      },
    });
    try {
      assert.equal(await f.bootstrap.enroll(), undefined);
      assert.equal(await f.bootstrap.enroll(), undefined);
      assert.equal(f.events.includes("bind-material"), false);
      assert.equal(f.counts.starts, 0);
      assert.equal(f.counts.nativeClose, 1);
    } finally {
      await f.bootstrap.close();
    }
  });
}

test("unknown V2 consume cannot enroll from subsequent matching readback or retry", async () => {
  const f = controlledAgentBootstrap({
    execute(command, _bounds, record) {
      return command.kind === "consume-startup"
        ? { kind: "recovery-required", operation: record.claim.command }
        : { kind: "current", record };
    },
  });
  try {
    assert.equal(await f.bootstrap.enroll(), undefined);
    assert.equal(await f.bootstrap.enroll(), undefined);
    assert.deepEqual(f.events, ["authenticate", "consume-startup"]);
    assert.equal(f.counts.nativeClose, 1);
  } finally {
    await f.bootstrap.close();
  }
});

test("V2 source loss joins late original material binding before refusing enrollment", async () => {
  const entered = deferred();
  const release = deferred();
  const f = controlledAgentBootstrap({
    async bindWait() {
      entered.resolve();
      await release.promise;
    },
  });
  const enrolling = f.bootstrap.enroll();
  let settled = false;
  const observed = enrolling.finally(() => {
    settled = true;
  });
  try {
    await enterOrSettle(entered, enrolling, "Material binding");
    const closing = f.bootstrap.close();
    await until(() => f.nativeAbort.signal.aborted);
    assert.equal(settled, false);
    release.resolve();
    assert.equal(await observed, undefined);
    assert.equal(await closing, "finished");
    assert.equal(f.counts.boundClose, 1);
    assert.equal(f.counts.starts, 0);
  } finally {
    release.resolve();
    await observed;
    await f.bootstrap.close();
  }
});

test("V2 revocation retains and closes a late prepared adapter without starting it", async () => {
  const entered = deferred();
  const release = deferred();
  const f = controlledAgentBootstrap({
    async prepareWait() {
      entered.resolve();
      await release.promise;
    },
  });
  const enrollment = await f.bootstrap.enroll();
  assert.ok(enrollment);
  const starting = enrollment.usePort.start(enrollment.recipient, enrollment.startup);
  try {
    await enterOrSettle(entered, starting, "Host preparation");
    f.nativeAbort.abort();
    await until(() => f.counts.nativeClose === 1);
    release.resolve();
    assert.deepEqual(await starting, { kind: "recovery-required", operation: f.binding.startup });
    assert.equal(f.counts.starts, 0);
    assert.equal(f.counts.preparedClose, 1);
    assert.equal(f.counts.materialClose, 1);
    assert.equal(f.counts.boundClose, 1);
  } finally {
    release.resolve();
    await starting;
    await f.bootstrap.close();
  }
});

test("V2 material metadata preserves the exact selected admission and sole confirmed claim", async () => {
  const f = controlledAgentBootstrap();
  try {
    assert.ok(await f.bootstrap.enroll());
    const request = f.service.materialRequest(f.handle, "startup-slack-pair");
    assert.equal(request.schemaVersion, 2);
    assert.deepEqual(request.startup, f.binding.startup);
    assert.deepEqual(request.selection, f.binding.selection);
    assert.equal(Object.hasOwn(request.selection, "recordRef"), false);
    assert.equal(request.consumedClaim.operationDigest, f.record.claim.command.operationDigest);
    assert.ok(Object.isFrozen(request.startup.subject));
    assert.throws(() => f.service.materialRequest({ ...f.handle }, "startup-slack-pair"));
  } finally {
    await f.bootstrap.close();
  }
});

test("V2 material work is reserved once and shutdown joins its late settlement", async () => {
  const f = controlledAgentBootstrap();
  const entered = deferred();
  const release = deferred();
  assert.ok(await f.bootstrap.enroll());
  const borrowing = f.service.withMaterialCall(f.handle, "startup-slack-pair", async () => {
    entered.resolve();
    await release.promise;
    return "controlled-material-result";
  });
  const rejected = assert.rejects(borrowing, /unavailable/);
  try {
    await enterOrSettle(entered, borrowing, "Material borrow");
    await assert.rejects(
      f.service.withMaterialCall(f.handle, "startup-slack-pair", async () => "second"),
      /unavailable/,
    );
    const closing = f.bootstrap.close();
    release.resolve();
    await rejected;
    assert.equal(await closing, "finished");
    assert.equal(f.counts.nativeClose, 1);
  } finally {
    release.resolve();
    await rejected;
    await f.bootstrap.close();
  }
});

test("V2 original cleanup failures remain failures after a started local lifetime", async () => {
  const f = controlledAgentBootstrap({ materialCleanup: "failed" });
  try {
    const enrollment = await f.bootstrap.enroll();
    assert.ok(enrollment);
    const started = await enrollment.usePort.start(enrollment.recipient, enrollment.startup);
    assert.equal(started.kind, "started");
    assert.deepEqual(await started.lifetime.close(), { cleanup: "failed", termination: "unknown" });
    assert.equal(f.counts.materialClose, 1);
    assert.equal(f.counts.nativeClose, 1);
    assert.equal(f.counts.boundClose, 1);
    assert.equal(f.counts.preparedClose, 1);
  } finally {
    await f.bootstrap.close();
  }
});

test("V2 wrong host readiness generation returns original Agent recovery after joined close", async () => {
  const f = controlledAgentBootstrap({ ready: { runtimeGeneration: 100000 } });
  try {
    const enrollment = await f.bootstrap.enroll();
    assert.ok(enrollment);
    const result = await enrollment.usePort.start(enrollment.recipient, enrollment.startup);
    assert.deepEqual(result, { kind: "recovery-required", operation: f.binding.startup });
    assert.equal(f.counts.starts, 1);
    assert.equal(f.counts.preparedClose, 1);
    assert.equal(f.counts.materialClose, 1);
    assert.equal(f.counts.nativeClose, 1);
  } finally {
    await f.bootstrap.close();
  }
});

test("V2 invalid asynchronous original fence is refused and joined before enrollment settles", async () => {
  const fence = deferred();
  const f = controlledAgentBootstrap({ nativeFence: () => fence.promise });
  let settled = false;
  const enrollment = f.bootstrap.enroll().finally(() => {
    settled = true;
  });
  try {
    await until(() => f.counts.nativeClose === 1);
    assert.equal(settled, false);
    fence.reject(new Error("Controlled asynchronous fence failed"));
    assert.equal(await enrollment, undefined);
    assert.equal(f.events.includes("bind-material"), false);
    assert.equal(f.counts.starts, 0);
  } finally {
    fence.resolve();
    await enrollment;
    await f.bootstrap.close();
  }
});

test("changed current V2 claim revokes the started local lifetime and joins its owners", async () => {
  let changed = false;
  const f = controlledAgentBootstrap({
    execute(command, _bounds, original) {
      const record = structuredClone(original);
      if (changed) record.head.subject.agentRef = "another-agent";
      return { kind: command.kind === "consume-startup" ? "consumed" : "current", record };
    },
  });
  try {
    const enrollment = await f.bootstrap.enroll();
    assert.ok(enrollment);
    const started = await enrollment.usePort.start(enrollment.recipient, enrollment.startup);
    assert.equal(started.kind, "started");
    changed = true;
    await assert.rejects(started.lifetime.recheckCurrent(), /unavailable/);
    assert.equal(started.lifetime.signal.aborted, true);
    assert.deepEqual(await started.lifetime.closed, {
      cleanup: "finished",
      termination: "unknown",
    });
    assert.equal(f.counts.preparedClose, 1);
    assert.equal(f.counts.materialClose, 1);
    assert.equal(f.counts.boundClose, 1);
    assert.equal(f.counts.nativeClose, 1);
    assert.equal(f.events.filter((event) => event === "consume-startup").length, 1);
  } finally {
    await f.bootstrap.close();
  }
});

test("original V2 material parent fences an unused enrollment and publishes one consumer join", async () => {
  const f = controlledAgentBootstrap();
  try {
    const enrollment = await f.bootstrap.enroll();
    assert.ok(enrollment);
    const parent = f.materialParent;
    assert.equal(parent.assertCurrent(), undefined);
    const joining = parent.joinConsumers();
    assert.equal(parent.signal.aborted, true);
    assert.equal(parent.joinConsumers(), joining);
    assert.throws(() => parent.assertCurrent(), /unavailable/);
    assert.throws(() => parent.remainingStartupMs(), /unavailable/);
    assert.deepEqual(await enrollment.usePort.start(enrollment.recipient, enrollment.startup), {
      kind: "denied",
    });
    assert.equal(await joining, undefined);
    assert.equal(f.events.includes("prepare"), false);
    assert.equal(f.counts.starts, 0);
    assert.equal(f.counts.preparedClose, 0);
  } finally {
    assert.equal(await f.bootstrap.close(), "finished");
  }
});

test("original V2 consumer join waits for late preparation and its disposer before material release", async () => {
  const preparing = deferred();
  const prepared = deferred();
  const closingPrepared = deferred();
  const closedPrepared = deferred();
  const f = controlledAgentBootstrap({
    async prepareWait() {
      preparing.resolve();
      await prepared.promise;
    },
    async preparedCloseWait() {
      closingPrepared.resolve();
      await closedPrepared.promise;
    },
  });
  const enrollment = await f.bootstrap.enroll();
  assert.ok(enrollment);
  const starting = enrollment.usePort.start(enrollment.recipient, enrollment.startup);
  let joined = false;
  let joining;
  try {
    await enterOrSettle(preparing, starting, "Original preparation");
    joining = f.materialParent.joinConsumers();
    const observed = joining.then(() => {
      joined = true;
    });
    assert.equal(f.materialParent.joinConsumers(), joining);
    await delay(1);
    assert.equal(joined, false);
    assert.equal(f.counts.materialClose, 0);
    assert.equal(f.counts.boundClose, 0);
    prepared.resolve();
    await enterOrSettle(closingPrepared, starting, "Late prepared disposer");
    assert.equal(joined, false);
    assert.equal(f.counts.starts, 0);
    assert.equal(f.counts.materialClose, 0);
    assert.equal(f.counts.boundClose, 0);
    closedPrepared.resolve();
    await observed;
    assert.deepEqual(await starting, { kind: "recovery-required", operation: f.binding.startup });
    assert.equal(f.counts.preparedClose, 1);
    assert.equal(f.counts.materialClose, 1);
    assert.equal(f.counts.boundClose, 1);
  } finally {
    prepared.resolve();
    closedPrepared.resolve();
    await joining;
    await starting;
    await f.bootstrap.close();
  }
});

test("original V2 started consumer joins quiescence and prepared cleanup before releasing material", async () => {
  const entered = deferred();
  const release = deferred();
  const f = controlledAgentBootstrap({
    async preparedCloseWait() {
      entered.resolve();
      await release.promise;
    },
  });
  let started;
  try {
    const enrollment = await f.bootstrap.enroll();
    assert.ok(enrollment);
    started = await enrollment.usePort.start(enrollment.recipient, enrollment.startup);
    assert.equal(started.kind, "started");
    // The actual fixture material fence calls this same original parent. The
    // parent's currentness must not recursively invoke the material fence.
    assert.equal(f.materialParent.assertCurrent(), undefined);
    const joining = f.materialParent.joinConsumers();
    await enterOrSettle(entered, joining, "Started prepared disposer");
    assert.equal(started.lifetime.signal.aborted, true);
    assert.equal(f.events.filter((event) => event === "quiesce").length, 1);
    assert.equal(f.counts.materialClose, 0);
    assert.equal(f.counts.boundClose, 0);
    release.resolve();
    await joining;
    assert.deepEqual(await started.lifetime.closed, {
      cleanup: "finished",
      termination: "unknown",
    });
    assert.equal(f.counts.preparedClose, 1);
    assert.equal(f.counts.materialClose, 1);
    assert.equal(f.counts.boundClose, 1);
  } finally {
    release.resolve();
    if (started?.kind === "started") await started.lifetime.close();
    await f.bootstrap.close();
  }
});

test(
  "failed material acquisition can join original consumers without waiting on its own borrow",
  { timeout: 2500 },
  async () => {
    const f = controlledAgentBootstrap({ borrowFailure: true });
    try {
      const enrollment = await f.bootstrap.enroll();
      assert.ok(enrollment);
      const result = await enrollment.usePort.start(enrollment.recipient, enrollment.startup);
      assert.deepEqual(result, { kind: "recovery-required", operation: f.binding.startup });
      assert.equal(f.events.includes("prepare"), false);
      assert.equal(f.counts.starts, 0);
      assert.equal(f.counts.materialClose, 0);
      assert.equal(f.counts.boundClose, 1);
      assert.equal(await f.materialParent.joinConsumers(), undefined);
    } finally {
      await f.bootstrap.close();
    }
  },
);

for (const [name, options] of [
  ["failed", { preparedCleanup: "failed" }],
  ["unknown", { preparedCleanup: "unknown" }],
  ["rejected", { preparedCloseFailure: true }],
]) {
  test(`original ${name} prepared cleanup rejects the material join and retains its source`, async () => {
    const f = controlledAgentBootstrap(options);
    try {
      const enrollment = await f.bootstrap.enroll();
      assert.ok(enrollment);
      const started = await enrollment.usePort.start(enrollment.recipient, enrollment.startup);
      assert.equal(started.kind, "started");
      await assert.rejects(f.materialParent.joinConsumers(), /unavailable/);
      assert.deepEqual(await started.lifetime.closed, {
        cleanup: "unknown",
        termination: "unknown",
      });
      assert.equal(f.counts.preparedClose, 1);
      assert.equal(f.counts.materialClose, 0);
      assert.equal(f.counts.boundClose, 0);
    } finally {
      assert.equal(await f.bootstrap.close(), "unknown");
    }
  });
}

test("preparation rejection without its original disposer cannot release selected material", async () => {
  const f = controlledAgentBootstrap({ prepareFailure: true });
  try {
    const enrollment = await f.bootstrap.enroll();
    assert.ok(enrollment);
    assert.deepEqual(await enrollment.usePort.start(enrollment.recipient, enrollment.startup), {
      kind: "recovery-required",
      operation: f.binding.startup,
    });
    await assert.rejects(f.materialParent.joinConsumers(), /unavailable/);
    assert.equal(f.counts.starts, 0);
    assert.equal(f.counts.preparedClose, 0);
    assert.equal(f.counts.materialClose, 0);
    assert.equal(f.counts.boundClose, 0);
  } finally {
    assert.equal(await f.bootstrap.close(), "unknown");
  }
});

test("original material parent startup time never renews while its Source remains current", async (t) => {
  const f = controlledAgentBootstrap();
  try {
    assert.ok(await f.bootstrap.enroll());
    const sourceBefore = f.service.remainingSourceMs(f.handle);
    const before = f.materialParent.remainingStartupMs();
    assert.ok(before <= f.binding.startupDeadlineMs);
    assert.ok(before <= sourceBefore);
    const now = performance.now();
    t.mock.method(performance, "now", () => now + f.binding.startupDeadlineMs + 1);
    assert.equal(f.service.assertCurrent(f.handle), undefined);
    assert.throws(() => f.materialParent.remainingStartupMs(), /unavailable/);
  } finally {
    t.mock.restoreAll();
    await f.bootstrap.close();
  }
});
