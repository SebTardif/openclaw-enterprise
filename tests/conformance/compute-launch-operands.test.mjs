import assert from "node:assert/strict";
import test from "node:test";
import { ComputeLifecycleDispatcher } from "../../apps/controller/src/drivers/compute/lifecycle-hooks.ts";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";

const revision = { id: "revision-one", namespaceId: "namespace-one", agentId: "agent-one" };
function dispatcher() {
  let calls = 0;
  const owner = new ComputeLifecycleDispatcher([
    {
      capability: "configuration",
      id: "configuration-one",
      computeLifecycleHooks: {
        async beforeWorkloadStart(_revision, launch) {
          calls++;
          launch.environment.TEST_REFERENCE = "opaque-actual";
        },
      },
    },
  ]);
  return { owner, calls: () => calls };
}
test("original launch operands require the actual completed dispatcher return", async () => {
  const { owner, calls } = dispatcher();
  const launch = await owner.beforeWorkloadStart(revision);
  const lease = owner.acquireLaunchOperands(revision, launch);
  assert.equal(calls(), 1);
  assert.deepEqual(lease.environment, { TEST_REFERENCE: "opaque-actual" });
  assert.throws(() => owner.acquireLaunchOperands(revision, structuredClone(launch)));
  assert.throws(() => owner.acquireLaunchOperands({ ...revision, agentId: "other" }, launch));
  assert.equal(lease.assertCurrent(), undefined);
  await lease.release();
  assert.throws(() => lease.assertCurrent());
});
test("original replacement and cleanup invalidate retained operands", async () => {
  const { owner } = dispatcher();
  const first = await owner.beforeWorkloadStart(revision);
  const old = owner.acquireLaunchOperands(revision, first);
  const second = await owner.beforeWorkloadStart(revision);
  assert.throws(() => old.assertCurrent());
  const active = owner.acquireLaunchOperands(revision, second);
  await owner.beforeWorkloadStop(revision);
  assert.throws(() => active.assertCurrent());
  const third = await owner.beforeWorkloadStart(revision);
  const next = owner.acquireLaunchOperands(revision, third);
  await owner.beforeNamespaceDelete({ id: revision.namespaceId });
  assert.throws(() => next.assertCurrent());
});
test("actual original launch cancellation invalidates its operand source", async () => {
  const { owner } = dispatcher();
  const abort = new AbortController();
  const launch = await withComputeAbortSignal(abort.signal, () =>
    owner.beforeWorkloadStart(revision),
  );
  const lease = owner.acquireLaunchOperands(revision, launch);
  abort.abort();
  assert.throws(() => lease.assertCurrent());
});
test("cleanup during a real pending hook cannot resurrect operand custody", async () => {
  let complete;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    complete = resolve;
  });
  const owner = new ComputeLifecycleDispatcher([
    {
      capability: "configuration",
      id: "held",
      computeLifecycleHooks: {
        async beforeWorkloadStart() {
          entered();
          await held;
        },
      },
    },
  ]);
  const launch = owner.beforeWorkloadStart(revision);
  const refused = assert.rejects(launch);
  await started;
  await owner.beforeWorkloadStop(revision);
  complete();
  await refused;
});
for (const phase of ["beforeWorkloadStop", "beforeNamespaceDelete"])
  test(`pending ${phase} prevents a new same-owner launch until cleanup settles`, async () => {
    let entered, complete;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const held = new Promise((resolve) => {
      complete = resolve;
    });
    const owner = new ComputeLifecycleDispatcher([
      {
        capability: "configuration",
        id: "held-cleanup",
        computeLifecycleHooks: {
          async [phase]() {
            entered();
            await held;
          },
        },
      },
    ]);
    const launch = await owner.beforeWorkloadStart(revision);
    const old = owner.acquireLaunchOperands(revision, launch);
    const cleanup =
      phase === "beforeWorkloadStop"
        ? owner.beforeWorkloadStop(revision)
        : owner.beforeNamespaceDelete({ id: revision.namespaceId });
    await started;
    assert.throws(() => old.assertCurrent());
    await assert.rejects(owner.beforeWorkloadStart(revision));
    complete();
    await cleanup;
    const next = await owner.beforeWorkloadStart(revision);
    assert.equal(owner.acquireLaunchOperands(revision, next).assertCurrent(), undefined);
  });
test("concurrent same-revision launch cannot supersede a pending original hook", async () => {
  let entered, complete;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    complete = resolve;
  });
  const owner = new ComputeLifecycleDispatcher([
    {
      capability: "configuration",
      id: "held-launch",
      computeLifecycleHooks: {
        async beforeWorkloadStart() {
          entered();
          await held;
        },
      },
    },
  ]);
  const pending = owner.beforeWorkloadStart(revision);
  await started;
  await assert.rejects(owner.beforeWorkloadStart(revision));
  complete();
  const launch = await pending;
  assert.equal(owner.acquireLaunchOperands(revision, launch).assertCurrent(), undefined);
});
test("failed namespace preparation cleanup uses the same full-lifetime operand barrier", async () => {
  let entered, complete;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    complete = resolve;
  });
  const owner = new ComputeLifecycleDispatcher([
    {
      capability: "configuration",
      id: "prepared",
      computeLifecycleHooks: {
        async afterNamespacePrepared() {},
        async beforeNamespaceDelete() {
          entered();
          await held;
        },
      },
    },
    {
      capability: "secret",
      id: "failing",
      computeLifecycleHooks: {
        async afterNamespacePrepared() {
          throw new Error("fixture preparation failure");
        },
      },
    },
  ]);
  const launch = await owner.beforeWorkloadStart(revision);
  const lease = owner.acquireLaunchOperands(revision, launch);
  const pending = owner.afterNamespacePrepared({ id: revision.namespaceId });
  const refused = assert.rejects(pending);
  await started;
  assert.throws(() => lease.assertCurrent());
  await assert.rejects(owner.beforeWorkloadStart(revision));
  complete();
  await refused;
  assert.throws(() => owner.acquireLaunchOperands(revision, launch));
});
