import assert from "node:assert/strict";
import test from "node:test";
import { workloadProfileDigest } from "../../packages/occ/src/workload-profiles/canonical.ts";
import { installedRendererContainerImageSet } from "../../apps/controller/src/drivers/compute/kubernetes/installed-renderer-revision-operands.ts";
import {
  fixture,
  deferred,
  digest,
  turn,
} from "../fixtures/installed-renderer-revision-operands/contract-fixture.mjs";

// These cases exercise the product supplier, original constructors, factory
// membership, dispatcher and lifecycle leases. Fixture State/material/artifact
// boundaries do not prove production custody, PostgreSQL or provider behavior.

test("fresh candidate produces actual immutable templates with zero launch/provider calls", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  assert.throws(() => f.driver.acquireCurrentLaunchOperands(f.revision));
  const lease = await f.supplier.acquireRevisionOperands(f.input());
  t.after(() => lease.release());
  assert.equal(f.hooks(), 0);
  assert.equal(f.driver.apiClients, undefined);
  assert.equal(lease.revision, f.revision);
  assert.equal(lease.harnessOperands, undefined);
  assert.equal(typeof lease.inputs.gateway[1], "string");
  assert.deepEqual(lease.outputs.gateway, f.construction.gatewayTemplate(...lease.inputs.gateway));
  assert.deepEqual(lease.outputs.harness, f.construction.harnessTemplate(lease.inputs.harness));
  assert.deepEqual(f.events, ["candidate-acquire", "static-material-acquire"]);
  const gateway = lease.outputs.gateway.spec.template.spec;
  const harness = lease.outputs.harness.spec.template.spec;
  assert.equal(gateway.containers.length, 1);
  assert.equal(harness.initContainers.length, 1);
  assert.equal(gateway.automountServiceAccountToken, false);
  assert.equal(harness.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(lease.inputs.gateway[0].environment, {
    GATEWAY_MATERIAL: "static-reference",
  });
  assert.equal(
    gateway.containers[0].env.some((item) => item.name === "GATEWAY_MATERIAL"),
    false,
  );
  assert.ok(
    harness.containers[0].env.some(
      (item) => item.name === "ORIGINAL_MATERIAL" && item.value === "opaque-owned-reference",
    ),
  );
  assert.equal(lease.outputs.gateway.metadata.uid, undefined);
  assert.equal(lease.outputs.gateway.metadata.resourceVersion, undefined);
  assert.ok(Object.isFrozen(lease.inputs.gateway[0].ownership));
  assert.ok(Object.isFrozen(lease.outputs.harness.spec.template.spec));
  assert.throws(() => {
    lease.inputs.harness.namespace = "other";
  }, TypeError);
});

test("retained currentness outlives acquisition IO and expires with original State", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const lease = await f.supplier.acquireRevisionOperands(f.input());
  t.after(() => lease.release());
  f.closeIO();
  assert.equal(lease.assertCurrent(), undefined);
  f.closeState();
  assert.throws(() => lease.assertCurrent(), /State scope expired/);
  assert.throws(() => lease.assertCurrent(), /State scope expired/);
});

test("same-valued copied unit and another operation cannot borrow the captured candidate", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  for (const operationRef of [f.unit.operationRef, "different-operation"]) {
    const input = f.input();
    const original = [...input.original];
    original[5] = { ...f.unit, operationRef };
    await assert.rejects(f.supplier.acquireRevisionOperands({ ...input, original }));
  }
  assert.equal(f.events.includes("static-material-acquire"), false);
  assert.equal(f.hooks(), 0);
});

test("candidate A with changed configuration ownership refuses before material acquisition", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.revision.configurationGeneration++;
  await assert.rejects(f.supplier.acquireRevisionOperands(f.input()));
  assert.deepEqual(f.events, ["candidate-acquire", "candidate-release"]);
});

test("editing captured candidate A after retention poisons its original lease", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const lease = await f.supplier.acquireRevisionOperands(f.input());
  t.after(() => lease.release());
  f.revision.configuration.changed = "candidate-B";
  assert.throws(() => lease.assertCurrent());
  assert.equal(lease.inputs.gateway[0].configuration.revisionId, f.request.revisionId);
});

test("copied selected Driver is refused even with matching public identity", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const input = f.input();
  const original = [...input.original];
  original[0] = { ...f.driver };
  await assert.rejects(f.supplier.acquireRevisionOperands({ ...input, original }));
  assert.equal(f.releases.candidate, 1);
  assert.equal(f.events.includes("static-material-acquire"), false);
});

test("source method replacement does not replace the once-captured original producer", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  let called = false;
  f.sources.acquireStaticMaterialPlacement = async () => {
    called = true;
    throw new Error("replacement");
  };
  await assert.rejects(f.supplier.acquireRevisionOperands(f.input()));
  assert.equal(called, false);
  assert.deepEqual(f.events, []);
});

test("later material mutation refuses while retained outputs remain unchanged", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const lease = await f.supplier.acquireRevisionOperands(f.input());
  t.after(() => lease.release());
  const before = structuredClone(lease.outputs);
  f.material.harness.environment.ORIGINAL_MATERIAL = "replacement-reference";
  assert.throws(() => lease.assertCurrent());
  assert.deepEqual(lease.outputs, before);
});

test("late material result after cancellation is owned and both releases join", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const entered = deferred();
  const waiting = deferred();
  f.controls.materialWait = async () => {
    entered.resolve();
    await waiting.promise;
  };
  const pending = f.supplier.acquireRevisionOperands(f.input());
  const result = assert.rejects(pending);
  await entered.promise;
  f.abort.abort();
  waiting.resolve();
  await result;
  assert.equal(f.releases.material, 1);
  assert.equal(f.releases.candidate, 1);
  assert.deepEqual(f.events.slice(-2), ["material-release", "candidate-release"]);
});

test("asynchronous State fence is refused and awaited before candidate cleanup", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const fence = deferred();
  const entered = deferred();
  f.controls.candidateCurrent = () => {
    entered.resolve();
    return fence.promise;
  };
  let settled = false;
  const rejected = assert.rejects(f.supplier.acquireRevisionOperands(f.input())).then(() => {
    settled = true;
  });
  await entered.promise;
  await turn();
  assert.equal(settled, false);
  assert.equal(f.releases.candidate, undefined);
  fence.resolve();
  await rejected;
  assert.equal(f.releases.candidate, 1);
  assert.equal(f.events.includes("static-material-acquire"), false);
});

test("release joins every disposer once and preserves material cleanup failure", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const lease = await f.supplier.acquireRevisionOperands(f.input());
  const failure = new Error("material cleanup remains responsible");
  f.controls.materialRelease = async () => {
    throw failure;
  };
  const closing = lease.release();
  assert.equal(lease.release(), closing);
  await assert.rejects(
    closing,
    (error) => error instanceof AggregateError && error.errors.includes(failure),
  );
  assert.equal(f.releases.material, 1);
  assert.equal(f.releases.candidate, 1);
  assert.throws(() => lease.assertCurrent());
});

test("prepared acquisition requires an already completed original launch", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  await assert.rejects(f.supplier.acquirePreparedRevisionOperands(f.input()), /launch operands/);
  assert.equal(f.hooks(), 0);
  assert.equal(f.events.includes("prepared-material-acquire"), false);
  assert.equal(f.releases.candidate, 1);
});

test("prepared output preserves exact dispatcher launch and original constructor outputs", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const { launch, preparedMaterial } = await f.prepare();
  const lease = await f.supplier.acquirePreparedRevisionOperands(f.input());
  t.after(() => lease.release());
  assert.equal(f.hooks(), 1);
  assert.equal(f.driver.apiClients, undefined);
  assert.equal(lease.harnessOperands.launch, launch);
  assert.equal(lease.harnessOperands.imageSetDigest, preparedMaterial.imageSetDigest);
  assert.deepEqual(
    lease.outputs.gateway,
    f.construction.gatewayDeployment(...lease.inputs.gateway),
  );
  assert.deepEqual(lease.outputs.harness, f.construction.harnessTemplate(lease.inputs.harness));
  assert.equal(lease.inputs.gateway[1].target.namespace.uid, "controlled-original-namespace-uid");
  assert.equal(installedRendererContainerImageSet(f.artifacts, lease.outputs).containers.length, 4);
  assert.deepEqual(f.events, ["candidate-acquire", "prepared-material-acquire"]);
});

test("prepared launch replacement poisons retained correspondence without invoking a read hook", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  await f.prepare();
  const lease = await f.supplier.acquirePreparedRevisionOperands(f.input());
  t.after(() => lease.release());
  await f.driver.lifecycle.beforeWorkloadStart(f.revision);
  assert.equal(f.hooks(), 2);
  assert.throws(() => lease.assertCurrent(), /launch operands/);
  assert.equal(f.hooks(), 2);
});

test("prepared material environment must correspond to the completed original launch", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  await f.prepare();
  f.material.harness.environment.ORIGINAL_MATERIAL = "copied-but-different";
  await assert.rejects(f.supplier.acquirePreparedRevisionOperands(f.input()));
  assert.equal(f.hooks(), 1);
  assert.equal(f.releases.material, 1);
  assert.equal(f.releases.candidate, 1);
});

test("same revision with a different physical target refuses constructor correspondence", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const { preparedMaterial } = await f.prepare();
  preparedMaterial.gatewayPlan.target.deploymentName = "other-gateway";
  await assert.rejects(f.supplier.acquirePreparedRevisionOperands(f.input()));
  assert.equal(f.hooks(), 1);
});

test("prepared image-set excludes neither init nor named helpers", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const { preparedMaterial } = await f.prepare();
  const imageSet = structuredClone(preparedMaterial.imageSet);
  imageSet.containers = imageSet.containers.filter((item) => item.phase !== "init");
  f.controls.preparedOverride = {
    imageSet,
    imageSetDigest: workloadProfileDigest("imageSetDigest", imageSet),
  };
  await assert.rejects(f.supplier.acquirePreparedRevisionOperands(f.input()));
  assert.equal(f.releases.material, 1);
});

test("image projection changes for a helper, rejects unknown init bytes, and binds definition", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const lease = await f.supplier.acquireRevisionOperands(f.input());
  t.after(() => lease.release());
  const baseline = installedRendererContainerImageSet(f.artifacts, lease.outputs);
  const baselineDigest = workloadProfileDigest("imageSetDigest", baseline);
  const outputs = structuredClone(lease.outputs);
  const pod = outputs.harness.spec.template.spec;
  pod.containers.push({ ...pod.containers[0], name: "actual-helper" });
  const withHelper = installedRendererContainerImageSet(f.artifacts, outputs);
  assert.equal(withHelper.containers.length, 5);
  assert.notEqual(workloadProfileDigest("imageSetDigest", withHelper), baselineDigest);
  pod.initContainers[0].image = `example.invalid/other@${digest("9")}`;
  assert.throws(() => installedRendererContainerImageSet(f.artifacts, outputs));
  const otherDefinition = {
    ...f.artifacts,
    definition: { ...f.artifacts.definition, digest: digest("8") },
  };
  assert.notEqual(
    workloadProfileDigest(
      "imageSetDigest",
      installedRendererContainerImageSet(otherDefinition, lease.outputs),
    ),
    baselineDigest,
  );
});

test("prepared target mutation and original claim cancellation invalidate returned lease", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const { preparedMaterial } = await f.prepare();
  const lease = await f.supplier.acquirePreparedRevisionOperands(f.input());
  t.after(() => lease.release());
  preparedMaterial.gatewayPlan.target.namespace.resourceVersion = "2";
  assert.throws(() => lease.assertCurrent());
  f.abort.abort();
  assert.throws(() => lease.assertCurrent());
});

// Keep this original method callable unchanged. The getter is initially inert;
// the material fence arms it only after upstream checks, selecting the final
// callback-bearing local pass of the next public supplier check.
function finalMethodGetter(f, fire) {
  const original = f.sources.acquireStaticMaterialPlacement;
  const counts = { reads: 0, finalReads: 0, materialFences: 0 };
  let enabled = false;
  let armed = false;
  Object.defineProperty(f.sources, "acquireStaticMaterialPlacement", {
    configurable: true,
    get() {
      counts.reads++;
      if (armed) {
        armed = false;
        counts.finalReads++;
        fire();
      }
      return original;
    },
  });
  f.controls.materialCurrent = () => {
    if (enabled) {
      counts.materialFences++;
      armed = true;
    }
  };
  return {
    counts,
    arm() {
      enabled = true;
    },
  };
}

test("final method getter reentry refuses nested, outer and later checks with one cleanup", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  let lease;
  let nestedCalls = 0;
  let nestedRefusals = 0;
  let nestedError;
  const final = finalMethodGetter(f, () => {
    nestedCalls++;
    try {
      lease.assertCurrent();
    } catch (error) {
      nestedRefusals++;
      nestedError = error;
    }
  });
  lease = await f.supplier.acquireRevisionOperands(f.input());
  t.after(() => lease.release());
  assert.ok(final.counts.reads > 0);
  assert.equal(final.counts.finalReads, 0);
  final.arm();
  let outerCalls = 0;
  let outerRefusals = 0;
  let outerError;
  try {
    outerCalls++;
    lease.assertCurrent();
  } catch (error) {
    outerRefusals++;
    outerError = error;
  }
  let laterCalls = 0;
  let laterRefusals = 0;
  let laterError;
  try {
    laterCalls++;
    lease.assertCurrent();
  } catch (error) {
    laterRefusals++;
    laterError = error;
  }
  // All counts are checked outside the refusal catches, including the nested
  // callback's result. A swallowed outer success cannot satisfy this regression.
  assert.deepEqual(
    { nestedCalls, nestedRefusals, outerCalls, outerRefusals, laterCalls, laterRefusals },
    {
      nestedCalls: 1,
      nestedRefusals: 1,
      outerCalls: 1,
      outerRefusals: 1,
      laterCalls: 1,
      laterRefusals: 1,
    },
  );
  assert.match(nestedError.message, /currentness reentered/);
  assert.equal(outerError, nestedError);
  assert.equal(laterError, nestedError);
  assert.equal(final.counts.finalReads, 1);
  assert.equal(final.counts.materialFences, 1);
  const closing = lease.release();
  assert.equal(lease.release(), closing);
  await closing;
  assert.deepEqual(f.releases, { material: 1, candidate: 1 });
});

test("release initiated by the final method getter refuses that same outer check", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  let lease;
  let closing;
  let closeCalls = 0;
  const final = finalMethodGetter(f, () => {
    closeCalls++;
    closing = lease.release();
  });
  lease = await f.supplier.acquireRevisionOperands(f.input());
  t.after(() => lease.release());
  final.arm();
  let outerRefusals = 0;
  try {
    lease.assertCurrent();
  } catch {
    outerRefusals++;
  }
  let laterRefusals = 0;
  try {
    lease.assertCurrent();
  } catch {
    laterRefusals++;
  }
  assert.equal(closeCalls, 1);
  assert.equal(outerRefusals, 1);
  assert.equal(laterRefusals, 1);
  assert.equal(final.counts.finalReads, 1);
  assert.equal(final.counts.materialFences, 1);
  assert.equal(lease.release(), closing);
  await closing;
  assert.deepEqual(f.releases, { material: 1, candidate: 1 });
});

test("original cancellation on the final pass refuses without reading an own aborted getter", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  let ownAbortedReads = 0;
  Object.defineProperty(f.abort.signal, "aborted", {
    configurable: true,
    get() {
      ownAbortedReads++;
      return false;
    },
  });
  let cancellations = 0;
  const final = finalMethodGetter(f, () => {
    cancellations++;
    f.abort.abort();
  });
  const lease = await f.supplier.acquireRevisionOperands(f.input());
  t.after(() => lease.release());
  final.arm();
  let outerRefusals = 0;
  try {
    lease.assertCurrent();
  } catch {
    outerRefusals++;
  }
  let laterRefusals = 0;
  try {
    lease.assertCurrent();
  } catch {
    laterRefusals++;
  }
  assert.equal(cancellations, 1);
  assert.equal(ownAbortedReads, 0);
  assert.equal(outerRefusals, 1);
  assert.equal(laterRefusals, 1);
  assert.equal(final.counts.finalReads, 1);
  assert.equal(final.counts.materialFences, 1);
  const closing = lease.release();
  assert.equal(lease.release(), closing);
  await closing;
  assert.deepEqual(f.releases, { material: 1, candidate: 1 });
});

test("material retains the upstream candidate fence without depending on its own currentness", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const lease = await f.supplier.acquireRevisionOperands(f.input());
  t.after(() => lease.release());
  assert.ok(f.controls.materialCandidateChecks > 0);
  const before = f.controls.materialCandidateChecks;
  f.closeIO();
  assert.equal(f.controls.borrowedCandidate.assertCurrent(), undefined);
  assert.equal(f.controls.materialCandidateChecks, before);
  assert.equal(lease.assertCurrent(), undefined);
  assert.equal(f.controls.materialCandidateChecks, before + 1);
  assert.equal(f.controls.materialLease.assertCurrent(), undefined);
  assert.equal(f.controls.materialCandidateChecks, before + 2);
  f.closeState();
  assert.throws(() => f.controls.materialLease.assertCurrent(), /State scope expired/);
  assert.equal(f.controls.materialCandidateChecks, before + 3);
  assert.throws(() => lease.assertCurrent(), /State scope expired/);
  assert.equal(f.controls.materialCandidateChecks, before + 3);
  await lease.release();
  assert.deepEqual(f.releases, { material: 1, candidate: 1 });
});

test("upstream candidate reentry is independently guarded and poisons the full supplier", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const lease = await f.supplier.acquireRevisionOperands(f.input());
  t.after(() => lease.release());
  const before = f.controls.materialCandidateChecks;
  let nestedCalls = 0;
  let nestedRefusals = 0;
  let nestedError;
  f.controls.candidateCurrent = () => {
    nestedCalls++;
    try {
      f.controls.borrowedCandidate.assertCurrent();
    } catch (error) {
      nestedRefusals++;
      nestedError = error;
    }
  };
  let outerRefusals = 0;
  let outerError;
  try {
    f.controls.borrowedCandidate.assertCurrent();
  } catch (error) {
    outerRefusals++;
    outerError = error;
  }
  let supplierRefusals = 0;
  let supplierError;
  try {
    lease.assertCurrent();
  } catch (error) {
    supplierRefusals++;
    supplierError = error;
  }
  assert.equal(nestedCalls, 1);
  assert.equal(nestedRefusals, 1);
  assert.equal(outerRefusals, 1);
  assert.equal(supplierRefusals, 1);
  assert.match(nestedError.message, /Captured revision currentness reentered/);
  assert.equal(outerError, nestedError);
  assert.equal(supplierError, nestedError);
  assert.equal(f.controls.materialCandidateChecks, before);
  await lease.release();
  assert.deepEqual(f.releases, { material: 1, candidate: 1 });
});
