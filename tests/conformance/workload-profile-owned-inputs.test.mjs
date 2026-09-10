import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { WorkloadProfileSelectionError } from "../../packages/occ/src/workload-profiles/selection.ts";
import { createWorkloadProfileCapabilityAggregatorV2 } from "../../packages/occ/src/workload-profiles/admitted-use.ts";
import { createWorkloadProfileOwnedInputsV2 } from "../../apps/controller/src/composition/workload-profile-owned-inputs.ts";
import {
  createComputeDriver,
  composeSelectedComputeRendererContribution,
  selectedComputeRendererOwner,
  selectedComputeWorkloadProfileCapability,
} from "../../apps/controller/src/composition/driver-factories/compute.ts";
import {
  GVISOR_IMPLEMENTATION,
  KubernetesComputeDriver,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

const { options: originalOptions } = JSON.parse(
  readFileSync(
    new URL("../fixtures/kubernetes-lifecycle-collaborators/inputs.json", import.meta.url),
    "utf8",
  ),
);
const unavailable = () => new WorkloadProfileSelectionError("unavailable");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const failure = { code: "unavailable" };

// Real Compute factory/constructor/DriverSelection, original aggregator and
// account qualifier. Domain constructors, units and leases below are explicit
// controls for composition only. They provide no accepted profile, original
// State enrollment, WIF policy, immutable image supplier or provider authority.
function fixture() {
  const options = structuredClone(originalOptions);
  delete options.runtime;
  options.isolationProfile = "gvisor-systrap";
  options.servicePrincipalCredentials = { mode: "disabled" };
  options.images = {
    gateway: `example.invalid/gateway@sha256:${"1".repeat(64)}`,
    agent: `example.invalid/harness@sha256:${"2".repeat(64)}`,
    requireImmutableDigest: true,
  };
  const configuration = {
    id: "configuration",
    capability: "configuration",
    implementation: "controlled",
  };
  const driver = createComputeDriver(
    { id: "owned-compute", implementation: GVISOR_IMPLEMENTATION, configuration: options },
    configuration,
  );
  const selection = new DriverSelection();
  selection.registerDriver(driver);
  selection.selectDriver("compute", driver.id);
  const replacement = new KubernetesComputeDriver(options, { id: "other-compute" });
  selection.registerDriver(replacement);
  const trace = [];
  const calls = [];
  const constructed = [];
  const context = Object.freeze({
    selection,
    state: Object.freeze({ marker: "controlled-state" }),
  });
  const originals = Object.freeze({
    sourceEnrollment: Object.freeze({
      definition() {
        assert.fail("construction must not enroll a definition");
      },
      revision() {
        assert.fail("construction must not enroll a revision");
      },
    }),
    candidateRecords: Object.freeze({
      readLocked() {
        assert.fail("construction must not read candidate records");
      },
    }),
    consumeCapturedCredentialV1() {
      assert.fail("construction must not borrow credential facts");
    },
  });
  function lease(name) {
    let closed = false;
    return Object.freeze({
      assertCurrent() {
        if (closed) throw unavailable();
      },
      async release() {
        assert.equal(closed, false, `one release: ${name}`);
        closed = true;
        trace.push(`release:${name}`);
      },
    });
  }
  function contribution(name) {
    const value = {
      verifyDefinitionLocked(...args) {
        assert.equal(this, value);
        calls.push({ name: `${name}.definition`, args });
        trace.push(`acquire:${name}`);
        const result = Promise.resolve(lease(name));
        value.last = result;
        return result;
      },
      acquire(...args) {
        assert.equal(this, value);
        calls.push({ name: `${name}.revision`, args });
        const result = Promise.resolve(lease(`${name}.revision`));
        value.last = result;
        return result;
      },
    };
    return value;
  }
  function qualifier(name, method) {
    const value = {
      [method](...args) {
        assert.equal(this, value);
        calls.push({ name, args });
        const result = Promise.resolve(lease(name));
        value.last = result;
        return result;
      },
    };
    return value;
  }
  const contributions = Object.fromEntries(
    ["runtime", "identity", "credentials", "storage"].map((name) => [name, contribution(name)]),
  );
  const native = qualifier("native", "qualifyLocked");
  const roles = qualifier("roles", "resolveLocked");
  const storageQualifier = qualifier("storage-qualifier", "resolveLocked");
  function owner(name, result) {
    const value = {
      create(actualContext, actualOriginals) {
        assert.equal(this, value);
        assert.equal(actualContext, context);
        assert.equal(actualOriginals, originals);
        constructed.push(name);
        return result;
      },
    };
    return value;
  }
  const installedRenderer = {
    acquireDefinition(...args) {
      assert.equal(this, installedRenderer);
      calls.push({ name: "installed.definition", args });
      const result = Promise.resolve(lease("installed.definition"));
      installedRenderer.last = result;
      return result;
    },
    acquireRevision(...args) {
      assert.equal(this, installedRenderer);
      calls.push({ name: "installed.revision", args });
      const result = Promise.resolve(lease("installed.revision"));
      installedRenderer.last = result;
      return result;
    },
  };
  const source = {
    acquireCapturedLocked(...args) {
      assert.equal(this, source);
      calls.push({ name: "credential.capture", args });
      const result = Promise.resolve(lease("credential.capture"));
      source.last = result;
      return result;
    },
  };
  const policy = {
    assertCandidate() {
      assert.fail("no production credential policy in this fixture");
    },
  };
  const credentials = Object.assign(owner("credentials", contributions.credentials), {
    source,
    policy,
  });
  const input = {
    installedRenderer,
    runtime: owner("runtime", { contribution: contributions.runtime, native }),
    identity: owner("identity", { contribution: contributions.identity, roles }),
    credentials,
    storage: owner("storage", { contribution: contributions.storage, storage: storageQualifier }),
  };
  return {
    input,
    context,
    originals,
    driver,
    selection,
    replacement,
    options,
    constructed,
    trace,
    calls,
    lease,
    contributions,
    native,
    roles,
    storageQualifier,
    source,
    policy,
    installedRenderer,
  };
}

test("owned inputs construct once from exact original ports without acquiring or rebinding Compute", () => {
  const f = fixture();
  const renderer = selectedComputeWorkloadProfileCapability(f.driver);
  const assembly = createWorkloadProfileOwnedInputsV2(f.input);
  assert.deepEqual(f.constructed, []);
  assert.deepEqual(f.calls, []);
  const owners = assembly.create(f.context, f.originals);
  assert.deepEqual(f.constructed, ["runtime", "identity", "credentials", "storage"]);
  assert.deepEqual(Object.keys(owners.contributors), [
    "runtime",
    "identity",
    "credentials",
    "storage",
  ]);
  assert.deepEqual(Object.keys(owners.candidateQualifiers), [
    "native",
    "credentials",
    "storage",
    "roles",
  ]);
  assert.deepEqual(f.calls, []);
  assert.equal(Object.isFrozen(assembly), true);
  assert.equal(Object.isFrozen(owners), true);
  assert.throws(() => assembly.create(f.context, f.originals), failure);
  // The original production receiving action is still the first binder.
  assert.equal(
    composeSelectedComputeRendererContribution(
      f.driver,
      f.selection,
      f.originals.sourceEnrollment,
      owners.installedRenderer,
    ),
    renderer,
  );
  assert.equal(selectedComputeWorkloadProfileCapability(f.driver), renderer);
  assert.equal(f.driver.getWorkloadProfileCapability(), renderer);
  assert.throws(
    () =>
      composeSelectedComputeRendererContribution(
        f.driver,
        f.selection,
        f.originals.sourceEnrollment,
        owners.installedRenderer,
      ),
    failure,
  );
  assert.deepEqual(f.calls, []);
});

test("missing complete input refuses before invoking any subset of constructors", () => {
  for (const name of ["runtime", "identity", "credentials", "storage", "installedRenderer"]) {
    const f = fixture();
    delete f.input[name];
    assert.throws(() => createWorkloadProfileOwnedInputsV2(f.input), failure);
    assert.deepEqual(f.constructed, []);
    assert.deepEqual(f.calls, []);
  }
  for (const name of ["source", "policy"]) {
    const f = fixture();
    delete f.input.credentials[name];
    assert.throws(() => createWorkloadProfileOwnedInputsV2(f.input), failure);
    assert.deepEqual(f.constructed, []);
  }
  const f = fixture();
  const assembly = createWorkloadProfileOwnedInputsV2(f.input);
  assert.throws(
    () => assembly.create(f.context, { ...f.originals, consumeCapturedCredentialV1: undefined }),
    failure,
  );
  assert.deepEqual(f.constructed, []);
  assert.throws(() => assembly.create(f.context, f.originals), failure);
});

test("the original factory association and real selected Driver are required", () => {
  const f = fixture();
  const assembly = createWorkloadProfileOwnedInputsV2(f.input);
  // A real but separately constructed Driver has no original factory entry.
  f.selection.selectDriver("compute", f.replacement.id);
  assert.throws(() => assembly.create(f.context, f.originals), failure);
  assert.deepEqual(f.constructed, []);
  for (const copiedSelection of [
    { selectedDriver: () => f.driver },
    Object.create(DriverSelection.prototype),
  ]) {
    const g = fixture();
    const copied = createWorkloadProfileOwnedInputsV2(g.input);
    assert.throws(
      () => copied.create({ ...g.context, selection: copiedSelection }, g.originals),
      failure,
    );
    assert.deepEqual(g.constructed, []);
  }
  const h = fixture();
  // The captured prototype method ignores a later replaceable public getter.
  h.selection.selectedDriver = () => h.replacement;
  const original = createWorkloadProfileOwnedInputsV2(h.input);
  original.create(h.context, h.originals);
  assert.deepEqual(h.constructed, ["runtime", "identity", "credentials", "storage"]);
});

test("asynchronous, thenable and failed domain construction cannot be retried", async () => {
  const f = fixture();
  f.input.runtime.create = () => Promise.reject(new Error("controlled constructor refusal"));
  const assembly = createWorkloadProfileOwnedInputsV2(f.input);
  assert.throws(() => assembly.create(f.context, f.originals), failure);
  assert.throws(() => assembly.create(f.context, f.originals), failure);
  await Promise.resolve();
  const g = fixture();
  let thenReads = 0;
  g.input.runtime.create = () => ({
    get then() {
      thenReads += 1;
      assert.fail("thenable invoked");
    },
  });
  const thenable = createWorkloadProfileOwnedInputsV2(g.input);
  assert.throws(() => thenable.create(g.context, g.originals), failure);
  assert.equal(thenReads, 0);
  assert.deepEqual(g.constructed, []);
  const h = fixture();
  const sentinel = new Error("controlled original failure");
  h.input.runtime.create = () => {
    throw sentinel;
  };
  const failed = createWorkloadProfileOwnedInputsV2(h.input);
  assert.throws(
    () => failed.create(h.context, h.originals),
    (error) => error === sentinel,
  );
  assert.throws(() => failed.create(h.context, h.originals), failure);
});

test("captured original receivers forward exact arguments, promises and leases after property replacement", async () => {
  const f = fixture();
  const assembly = createWorkloadProfileOwnedInputsV2(f.input);
  for (const name of ["runtime", "identity", "credentials", "storage"])
    f.input[name].create = () => assert.fail("late constructor replacement");
  f.source.acquireCapturedLocked = () => assert.fail("late source replacement");
  f.policy.assertCandidate = () => assert.fail("late policy replacement");
  const owners = assembly.create(f.context, f.originals);
  const args = [
    Object.freeze({ kind: "input" }),
    Object.freeze({ kind: "unit" }),
    Object.freeze({ kind: "io" }),
  ];
  for (const name of ["runtime", "identity", "credentials", "storage"]) {
    f.contributions[name].verifyDefinitionLocked = () => assert.fail("late definition replacement");
    f.contributions[name].acquire = () => assert.fail("late revision replacement");
    for (const method of ["verifyDefinitionLocked", "acquire"]) {
      const result = owners.contributors[name][method](...args);
      assert.equal(result, f.contributions[name].last);
      assert.equal(f.calls.at(-1).args[0], args[0]);
      assert.equal(f.calls.at(-1).args[1], args[1]);
      assert.equal(f.calls.at(-1).args[2], args[2]);
      await (await result).release();
    }
  }
  for (const [name, original, method] of [
    ["native", f.native, "qualifyLocked"],
    ["storage", f.storageQualifier, "resolveLocked"],
    ["roles", f.roles, "resolveLocked"],
  ]) {
    original[method] = () => assert.fail("late qualifier replacement");
    const result = owners.candidateQualifiers[name][method](...args);
    assert.equal(result, original.last);
    assert.equal(f.calls.at(-1).args[0], args[0]);
    await (await result).release();
  }
  const capture = assembly.credentialSource.acquireCapturedLocked(...args);
  assert.equal(capture, f.source.last);
  await (await capture).release();
  f.installedRenderer.acquireDefinition = () => assert.fail("late installed replacement");
  const installed = owners.installedRenderer.acquireDefinition(...args);
  assert.equal(installed, f.installedRenderer.last);
  await (await installed).release();
  f.selection.selectDriver("compute", f.replacement.id);
  const prior = f.calls.length;
  assert.throws(() => owners.contributors.runtime.verifyDefinitionLocked(...args), failure);
  assert.throws(() => owners.candidateQualifiers.native.qualifyLocked(...args), failure);
  assert.equal(f.calls.length, prior);
});

test("the real credential qualifier refuses unavailable borrowed custody without facts or borrowed release", async () => {
  const f = fixture();
  const sourceIdentity = Object.freeze({});
  const records = Object.freeze({ marker: "controlled observations" });
  const view = Object.freeze({ sourceIdentity, records, assertCurrent() {} });
  const request = { installationId: "i", namespaceId: "n", agentId: "a" };
  const unit = { kind: "deployment", ...request, signal: new AbortController().signal };
  let borrowed = 0;
  let factsReads = 0;
  let borrowedReleaseAttempts = 0;
  let policyCalls = 0;
  f.policy.assertCandidate = () => {
    policyCalls += 1;
    assert.fail("no production credential policy in this fixture");
  };
  const io = { assertActive() {}, poison() {} };
  const originals = Object.freeze({
    ...f.originals,
    async consumeCapturedCredentialV1(actualRequest, actualView, actualUnit, actualIo) {
      assert.equal(this, originals);
      assert.deepEqual(actualRequest, request);
      assert.equal(actualView, view);
      assert.equal(actualUnit, unit);
      assert.equal(actualIo, io);
      borrowed += 1;
      return Object.freeze({
        get facts() {
          factsReads += 1;
          assert.fail("unavailable borrowed facts disclosed");
        },
        assertCurrent() {
          throw unavailable();
        },
        release() {
          borrowedReleaseAttempts += 1;
          assert.fail("borrower attempted original source cleanup");
        },
      });
    },
  });
  // These controlled constructors check original operand identity; the change
  // here is only which immutable originals container is supplied by this case.
  for (const [name, result] of [
    ["runtime", { contribution: f.contributions.runtime, native: f.native }],
    ["identity", { contribution: f.contributions.identity, roles: f.roles }],
    ["credentials", f.contributions.credentials],
    ["storage", { contribution: f.contributions.storage, storage: f.storageQualifier }],
  ])
    f.input[name].create = (context, received) => {
      assert.equal(context, f.context);
      assert.equal(received, originals);
      return result;
    };
  // Construct once, after this case's fixed original receiver is selected.
  // No accepting State or Controller is constructed by this controlled case.
  const scoped = createWorkloadProfileOwnedInputsV2(f.input);
  const owners = scoped.create(f.context, originals);
  await assert.rejects(
    owners.candidateQualifiers.credentials.resolveLocked(
      { request, candidate: {}, manifest: {}, records },
      view,
      unit,
      io,
    ),
    failure,
  );
  assert.equal(borrowed, 1);
  assert.equal(factsReads, 0);
  assert.equal(borrowedReleaseAttempts, 0);
  assert.equal(policyCalls, 0);
  assert.deepEqual(f.calls, []);
});

function orderedAggregator(f, owners) {
  // This test renderer only delegates to the real renderer's process-local
  // Driver hold. It does not claim full renderer/source qualification.
  const renderer = {
    async verifyRendererDefinitionLocked() {
      f.trace.push("acquire:renderer");
      const held = selectedComputeRendererOwner(f.driver).acquire(f.selection);
      return Object.freeze({
        assertCurrent: held.assertCurrent,
        async release() {
          f.trace.push("release:renderer");
          held.release();
        },
      });
    },
    verifyRevisionRendererLocked() {
      assert.fail("definition case must not acquire revision");
    },
  };
  return createWorkloadProfileCapabilityAggregatorV2({ renderer, ...owners.contributors });
}
function operation() {
  let accepting = true;
  return {
    io: {
      assertActive() {
        if (!accepting) throw unavailable();
      },
      poison() {},
    },
    stop() {
      accepting = false;
    },
    request: { scope: { installationId: "i", namespaceId: "n" } },
    unit: {
      kind: "profile-definition",
      installationId: "i",
      namespaceId: "n",
      signal: new AbortController().signal,
    },
  };
}

test("the original aggregator retains domain order and real selected Driver through terminal cleanup", async () => {
  const f = fixture();
  const owners = createWorkloadProfileOwnedInputsV2(f.input).create(f.context, f.originals);
  const op = operation();
  const held = await orderedAggregator(f, owners).verifyDefinitionLocked(
    op.request,
    op.unit,
    op.io,
  );
  assert.deepEqual(f.trace, [
    "acquire:renderer",
    "acquire:runtime",
    "acquire:identity",
    "acquire:credentials",
    "acquire:storage",
  ]);
  op.stop();
  held.assertCurrent();
  assert.throws(() => f.selection.selectDriver("compute", f.replacement.id));
  const first = held.release();
  assert.equal(first, held.release());
  await first;
  assert.deepEqual(f.trace.slice(5), [
    "release:storage",
    "release:credentials",
    "release:identity",
    "release:runtime",
    "release:renderer",
  ]);
  assert.throws(() => held.assertCurrent(), failure);
  assert.equal(f.selection.selectDriver("compute", f.replacement.id), f.replacement);
});

test("a late original lease stays owned and is released when acquisition IO closes", async () => {
  const f = fixture();
  const entered = deferred();
  const completion = deferred();
  f.contributions.storage.verifyDefinitionLocked = function () {
    assert.equal(this, f.contributions.storage);
    f.trace.push("acquire:storage");
    entered.resolve();
    return completion.promise;
  };
  const owners = createWorkloadProfileOwnedInputsV2(f.input).create(f.context, f.originals);
  const op = operation();
  const pending = orderedAggregator(f, owners).verifyDefinitionLocked(op.request, op.unit, op.io);
  await entered.promise;
  op.stop();
  assert.throws(() => f.selection.selectDriver("compute", f.replacement.id));
  completion.resolve(f.lease("storage"));
  await assert.rejects(pending, failure);
  assert.deepEqual(f.trace.slice(5), [
    "release:storage",
    "release:credentials",
    "release:identity",
    "release:runtime",
    "release:renderer",
  ]);
  assert.equal(f.selection.selectDriver("compute", f.replacement.id), f.replacement);
});
