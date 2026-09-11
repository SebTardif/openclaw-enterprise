import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { clone, controlledClient } from "../fixtures/kubernetes-lifecycle-collaborators/client.mjs";
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

// These accessors consume actual completed hooks. No test supplies a replacement
// launch lease, renderer capability, provider authority or lifecycle dispatcher.
test("current launch lookup preserves exact identity and does not rerun hooks", async () => {
  const { owner, calls } = dispatcher();
  assert.throws(() => owner.acquireCurrentLaunchOperands(revision));
  assert.equal(calls(), 0);
  const launch = await owner.beforeWorkloadStart(revision);
  const first = owner.acquireCurrentLaunchOperands(revision);
  const second = owner.acquireCurrentLaunchOperands(revision);
  assert.equal(first.launch, launch);
  assert.equal(second.launch, launch);
  assert.equal(first.environment, launch.environment);
  assert.equal(second.environment, first.environment);
  assert.equal(first.assertCurrent(), undefined);
  assert.equal(calls(), 1);
  await first.release();
  await first.release();
  assert.throws(() => first.assertCurrent());
  assert.equal(second.assertCurrent(), undefined);
  assert.equal(owner.acquireCurrentLaunchOperands(revision).launch, launch);
  assert.equal(calls(), 1);
  await second.release();
});

test("current lookup refuses mismatched revisions, foreign dispatchers and wrong receivers", async () => {
  const { owner, calls } = dispatcher();
  const foreign = dispatcher();
  const launch = await owner.beforeWorkloadStart(revision);
  for (const changed of [
    { ...revision, id: "other" },
    { ...revision, namespaceId: "other" },
    { ...revision, agentId: "other" },
  ])
    assert.throws(() => owner.acquireCurrentLaunchOperands(changed));
  assert.throws(() => foreign.owner.acquireCurrentLaunchOperands(revision));
  const acquire = ComputeLifecycleDispatcher.prototype.acquireCurrentLaunchOperands;
  assert.throws(() => acquire.call({}, revision));
  assert.throws(() => acquire.call(Object.create(owner), revision));
  assert.throws(() => foreign.owner.acquireLaunchOperands(revision, launch));
  assert.equal(calls(), 1);
  assert.equal(foreign.calls(), 0);
  const foreignLaunch = await foreign.owner.beforeWorkloadStart(revision);
  assert.notEqual(foreignLaunch, launch);
  assert.equal(foreign.owner.acquireCurrentLaunchOperands(revision).launch, foreignLaunch);
  assert.equal(owner.acquireCurrentLaunchOperands(revision).launch, launch);
  assert.equal(calls(), 1);
  assert.equal(foreign.calls(), 1);
});

test("current lookup cannot use a pending hook or start a second hook", async () => {
  let entered;
  let complete;
  let calls = 0;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    complete = resolve;
  });
  const owner = new ComputeLifecycleDispatcher([
    {
      capability: "configuration",
      id: "pending-current-launch",
      computeLifecycleHooks: {
        async beforeWorkloadStart(_revision, launch) {
          calls++;
          launch.environment.TEST_REFERENCE = "opaque-pending";
          entered();
          await held;
        },
      },
    },
  ]);
  const pending = owner.beforeWorkloadStart(revision);
  await started;
  try {
    assert.throws(() => owner.acquireCurrentLaunchOperands(revision));
    assert.equal(calls, 1);
  } finally {
    complete();
  }
  const launch = await pending;
  const lease = owner.acquireCurrentLaunchOperands(revision);
  assert.equal(lease.launch, launch);
  assert.equal(lease.assertCurrent(), undefined);
  assert.equal(calls, 1);
  await lease.release();
});

test("current lookup invalidates replacement and original cancellation", async () => {
  const { owner, calls } = dispatcher();
  const first = await owner.beforeWorkloadStart(revision);
  const old = owner.acquireCurrentLaunchOperands(revision);
  const abort = new AbortController();
  const second = await withComputeAbortSignal(abort.signal, () =>
    owner.beforeWorkloadStart(revision),
  );
  assert.notEqual(second, first);
  assert.throws(() => old.assertCurrent());
  const active = owner.acquireCurrentLaunchOperands(revision);
  assert.equal(active.launch, second);
  abort.abort();
  assert.throws(() => active.assertCurrent());
  assert.throws(() => owner.acquireCurrentLaunchOperands(revision));
  assert.equal(calls(), 2);
  await old.release();
  await active.release();
});

for (const phase of ["beforeWorkloadStop", "beforeNamespaceDelete"])
  test(`current lookup refuses throughout and after actual ${phase}`, async () => {
    let entered;
    let complete;
    let starts = 0;
    let stops = 0;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const held = new Promise((resolve) => {
      complete = resolve;
    });
    const owner = new ComputeLifecycleDispatcher([
      {
        capability: "configuration",
        id: "current-cleanup",
        computeLifecycleHooks: {
          async beforeWorkloadStart() {
            starts++;
          },
          async [phase]() {
            stops++;
            entered();
            await held;
          },
        },
      },
    ]);
    const launch = await owner.beforeWorkloadStart(revision);
    const lease = owner.acquireCurrentLaunchOperands(revision);
    assert.equal(lease.launch, launch);
    const cleanup =
      phase === "beforeWorkloadStop"
        ? owner.beforeWorkloadStop(revision)
        : owner.beforeNamespaceDelete({ id: revision.namespaceId });
    await started;
    try {
      assert.throws(() => lease.assertCurrent());
      assert.throws(() => owner.acquireCurrentLaunchOperands(revision));
      assert.equal(starts, 1);
      assert.equal(stops, 1);
    } finally {
      complete();
    }
    await cleanup;
    assert.throws(() => owner.acquireCurrentLaunchOperands(revision));
    assert.equal(starts, 1);
    assert.equal(stops, 1);
    await lease.release();
  });

const lifecycleInputs = JSON.parse(
  readFileSync(
    new URL("../fixtures/kubernetes-lifecycle-collaborators/inputs.json", import.meta.url),
    "utf8",
  ),
);
// Exercise launch custody with the actual current logging admission contract.
for (const selected of [lifecycleInputs.revision, lifecycleInputs.successor]) {
  selected.configuration = admitLoggingConfiguration(selected.configuration, "info");
}
const lifecycleObservations = JSON.parse(
  readFileSync(
    new URL("../fixtures/kubernetes-lifecycle-collaborators/observations.json", import.meta.url),
    "utf8",
  ),
);
// Match the current admitted document in the detached SDK observations as well.
for (const resources of [
  lifecycleObservations.resources,
  lifecycleObservations.successorResources,
]) {
  for (const resource of resources) {
    if (resource.kind !== "ConfigMap" || resource.data?.["openclaw.json"] === undefined) continue;
    resource.data["openclaw.json"] = JSON.stringify(
      admitLoggingConfiguration(JSON.parse(resource.data["openclaw.json"]), "info"),
    );
  }
}
function delegatedDriver() {
  let starts = 0;
  let stops = 0;
  const participant = {
    capability: "configuration",
    id: "actual-delegated-hook",
    computeLifecycleHooks: {
      async beforeWorkloadStart(_revision, launch) {
        starts++;
        launch.environment.TEST_REFERENCE = "opaque-delegated";
      },
      async beforeWorkloadStop() {
        stops++;
      },
    },
  };
  const client = controlledClient(
    lifecycleObservations.resources,
    lifecycleObservations.endpointSlices,
  );
  const driver = new KubernetesComputeDriver(clone(lifecycleInputs.options), {
    id: lifecycleInputs.revision.compute.id,
    lifecycleDrivers: [participant],
  });
  // Same existing fixture injection: only the external SDK clients are controlled.
  driver.apiClients = Promise.resolve(client.clients);
  return { driver, client, participant, starts: () => starts, stops: () => stops };
}

test("Kubernetes delegates to its original prepared launch without additional provider or hook calls", async () => {
  const fixture = delegatedDriver();
  const { driver, client } = fixture;
  const selected = clone(lifecycleInputs.revision);
  assert.throws(() => driver.acquireCurrentLaunchOperands(selected));
  assert.equal(fixture.starts(), 0);
  assert.equal(client.calls.length, 0);
  const prepared = await driver.prepareRevision(selected);
  assert.equal(prepared.ready, true);
  assert.equal(fixture.starts(), 1);
  const enteredProviderCalls = client.calls.length;
  assert.ok(enteredProviderCalls > 0);
  const first = driver.acquireCurrentLaunchOperands(selected);
  const second = driver.acquireCurrentLaunchOperands(selected);
  assert.equal(first.launch, second.launch);
  assert.equal(first.environment, first.launch.environment);
  assert.equal(first.environment.TEST_REFERENCE, "opaque-delegated");
  assert.equal(first.assertCurrent(), undefined);
  const foreign = delegatedDriver();
  assert.throws(() => foreign.driver.acquireCurrentLaunchOperands(selected));
  const acquire = KubernetesComputeDriver.prototype.acquireCurrentLaunchOperands;
  assert.throws(() => acquire.call({}, selected));
  assert.throws(() => acquire.call(Object.create(driver), selected));
  assert.throws(() => driver.acquireCurrentLaunchOperands({ ...selected, agentId: "other" }));
  assert.throws(() => driver.setLifecycleDrivers([]), /cannot change/);
  assert.equal(second.assertCurrent(), undefined);
  await first.release();
  assert.throws(() => first.assertCurrent());
  assert.equal(second.assertCurrent(), undefined);
  assert.equal(client.calls.length, enteredProviderCalls);
  assert.equal(fixture.starts(), 1);
  assert.equal(foreign.starts(), 0);
  assert.equal(foreign.client.calls.length, 0);
  await driver.retireRevision(selected);
  assert.throws(() => second.assertCurrent());
  assert.throws(() => driver.acquireCurrentLaunchOperands(selected));
  assert.equal(fixture.starts(), 1);
  assert.equal(fixture.stops(), 1);
  await second.release();
});

async function activatedEmbeddedDriver() {
  const fixture = delegatedDriver();
  const selected = clone(lifecycleInputs.successor);
  selected.harness.id = "openclaw";
  selected.harness.mode = "embedded";
  // The original activation path replaces the prior gateway and completes the
  // original launch. It does not set lifecycleStarted; replacement is allowed.
  await fixture.driver.activateRevision(selected);
  assert.equal(fixture.starts(), 1);
  return { ...fixture, selected };
}

test("allowed Kubernetes dispatcher replacement invalidates the captured delegated lease", async () => {
  const { driver, client, selected, starts, stops } = await activatedEmbeddedDriver();
  const old = driver.acquireCurrentLaunchOperands(selected);
  assert.equal(old.assertCurrent(), undefined);
  const providerCalls = client.calls.length;
  driver.setLifecycleDrivers([]);
  assert.throws(() => old.assertCurrent(), /dispatcher was replaced/);
  assert.throws(() => old.assertCurrent());
  assert.throws(() => driver.acquireCurrentLaunchOperands(selected));
  assert.equal(starts(), 1);
  assert.equal(stops(), 0);
  assert.equal(client.calls.length, providerCalls);
  await old.release();
});

test("Kubernetes rechecks the captured dispatcher after revision currentness access", async () => {
  const { driver, client, selected, starts } = await activatedEmbeddedDriver();
  const providerCalls = client.calls.length;
  let replace = false;
  let replacements = 0;
  const observedRevision = { ...selected };
  Object.defineProperty(observedRevision, "agentId", {
    enumerable: true,
    get() {
      if (replace) {
        replace = false;
        replacements++;
        driver.setLifecycleDrivers([]);
      }
      return selected.agentId;
    },
  });
  const held = driver.acquireCurrentLaunchOperands(observedRevision);
  assert.equal(held.assertCurrent(), undefined);
  replace = true;
  assert.throws(() => held.assertCurrent(), /dispatcher was replaced/);
  assert.equal(replacements, 1);
  assert.throws(() => held.assertCurrent());
  assert.throws(() => driver.acquireCurrentLaunchOperands(selected));
  assert.equal(starts(), 1);
  assert.equal(client.calls.length, providerCalls);
  await held.release();
});

test("Kubernetes retains a nested current-launch refusal after the outer revision getter recovers", async () => {
  const { driver, client, selected, starts, stops } = await activatedEmbeddedDriver();
  const providerCalls = client.calls.length;
  let armed = false;
  let nestedMode = false;
  let nestedEntries = 0;
  let nestedRefusals = 0;
  let nestedError;
  let held;
  const observedRevision = { ...selected };
  Object.defineProperty(observedRevision, "agentId", {
    enumerable: true,
    get() {
      if (nestedMode) return "wrong-nested-agent";
      if (armed) {
        armed = false;
        nestedEntries++;
        nestedMode = true;
        try {
          held.assertCurrent();
        } catch (error) {
          nestedRefusals++;
          nestedError = error;
        } finally {
          nestedMode = false;
        }
      }
      return selected.agentId;
    },
  });
  held = driver.acquireCurrentLaunchOperands(observedRevision);
  try {
    assert.equal(held.assertCurrent(), undefined);
    assert.equal(nestedEntries, 0);
    armed = true;
    assert.throws(() => held.assertCurrent(), /launch operands are unavailable/);
    assert.equal(nestedEntries, 1);
    assert.equal(nestedRefusals, 1);
    assert.ok(nestedError instanceof Error);
    assert.throws(() => held.assertCurrent(), /launch operands are unavailable/);
    assert.equal(nestedEntries, 1);
    assert.equal(nestedRefusals, 1);
    assert.equal(starts(), 1);
    assert.equal(stops(), 0);
    assert.equal(client.calls.length, providerCalls);
  } finally {
    await held.release();
  }
});
