import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeWorkloadProfileManifest,
  decodeWorkloadProfileManifestV2,
  WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2,
} from "../../packages/occ/src/workload-profiles/manifest.ts";
import { deriveWorkloadProfileManifestV2 } from "../../packages/occ/src/workload-profiles/projections.ts";
import {
  createAdmittedWorkloadProfileSelectorV2,
  WorkloadProfileSelectionError,
} from "../../packages/occ/src/workload-profiles/selection.ts";
import { workloadProfileDigest } from "../../packages/occ/src/workload-profiles/canonical.ts";
import { GatewayStartupOwnerPhaseV1 } from "../../packages/occ/src/gateway-startup-v1/owner.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { workloadProfileManifestFixture } from "../fixtures/workload-profile.mjs";
import { envelope } from "../fixtures/runtime-resource-accounting-v1/values.mjs";

// Controlled original-owner seams and synthetic supplied accounting only. These
// cases establish selector correspondence, not genuine admission, locks or source
// qualification. Production participants and SQL composition are separate.
const copy = (value) => structuredClone(value);
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value));
const digest = (n) => `sha256:${n.repeat(64)}`;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ref = (name) => ({ ref: name, version: 1, contentDigest: digest("1") });
const nextTurn = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function manifest() {
  const accounting = envelope();
  for (const component of ["gateway", "harness"])
    accounting.observations[component] = {
      status: "unavailable",
      ownerRef: "synthetic-observer",
      reason: "producer-port-unavailable",
    };
  const image = (name) => ({
    reference: `example.invalid/${name}@${digest("2")}`,
    platformDigest: digest("2"),
    executable: { path: `/app/${name}`, contentDigest: digest("3") },
  });
  const process = (name) => ({
    argv: [
      { kind: "literal", value: `/app/${name}` },
      { kind: "binding", name: "configuration-path" },
    ],
    environmentDefinition: ref(`${name}-environment`),
    runtimeClass: "selected-runsc",
    protocolVersion: 1,
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    mounts: [
      {
        name: `${name}-state`,
        path: `/state/${name}`,
        store: ref(`${name}-store`),
        access: "read-write",
      },
    ],
  });
  return {
    schemaVersion: 2,
    target: {
      component: "gateway-harness-pair",
      provider: "occ/kubernetes-gvisor",
      architecture: "linux/amd64",
      placement: "dedicated",
      fallback: "none",
      subject: "installation-namespace-agent",
    },
    profileRefs: workloadProfileManifestFixture().profileRefs,
    artifactSet: { gateway: image("gateway"), harness: image("harness") },
    launchConfiguration: {
      gateway: process("gateway"),
      harness: process("harness"),
      modules: ["identity", "channel", "harness", "persistence"].map((kind) => ({
        id: kind,
        kind,
        definition: ref(kind),
        artifactDigest: digest("4"),
      })),
      placement: { cluster: ref("cluster"), namespaceAllocation: ref("allocation") },
      runtime: { implementation: ref("runsc"), handler: "selected-runsc", platform: "systrap" },
      resourceEnvelope: { podAndRuntimeAccounting: { status: "selected", envelope: accounting } },
      credentials: {
        deliveryMode: "installation-channel-material-v1",
        materialSelection: ref("materials"),
        pathCustody: ref("paths"),
        harnessPlatformCredentials: "forbidden",
      },
    },
    containment: {
      definition: ref("containment"),
      kvmRequired: false,
      privileged: false,
      gatewayPrivateStateInHarness: "forbidden",
      supportedRunnableTuple: "requires-current-owner-validation",
    },
    endpoints: {
      identity: ref("identity"),
      modelMediator: ref("mediator"),
      repositoryIssuer: ref("issuer"),
      harnessTransport: ref("transport"),
    },
    evidenceRequirements: {
      bootstrap: "independent-installation-service",
      physicalCreator: "original-compute-createOriginal",
      context: "initialize-new-or-resume-retained",
      replacement: "exact-replaced-and-retained-participants",
      capabilities: WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2.map((id) => ({
        id,
        implementation: ref(id),
      })),
    },
  };
}
function setup() {
  const value = manifest();
  const derived = deriveWorkloadProfileManifestV2(bytes(value));
  const selection = {
    manifestRef: uuid(1),
    manifestDigest: derived.digests.manifestDigest,
    admissionRef: uuid(2),
    admissionVersion: 1,
  };
  const request = {
    schemaVersion: 2,
    installationId: `ins_${uuid(3)}`,
    namespaceId: `ns_${uuid(4)}`,
    agentId: `agt_${uuid(5)}`,
    revisionId: `rev_${uuid(6)}`,
    configurationRef: `cfg_${uuid(7)}`,
    configurationVersion: 2,
    selection,
  };
  const use = {
    schemaVersion: 2,
    component: "gateway-harness-pair",
    installationId: request.installationId,
    namespaceId: request.namespaceId,
    canonicalFormat: "oce.workload-profile.canonical-json.v1",
    ...selection,
    profileRefs: Object.fromEntries(
      Object.entries(derived.roleDigests).map(([name, contentDigest], index) => [
        name,
        { ref: uuid(20 + index), version: 1, contentDigest },
      ]),
    ),
    admittedConfigurationDigest: digest("5"),
  };
  const record = {
    schemaVersion: 2,
    state: "admitted",
    use,
    canonicalManifest: new TextDecoder().decode(derived.canonicalBytes),
    revision: {
      id: request.revisionId,
      agentId: request.agentId,
      namespaceId: request.namespaceId,
      workloadProfileUse: copy(use),
      configurationRef: request.configurationRef,
      configurationVersion: request.configurationVersion,
    },
    configuration: {
      ref: request.configurationRef,
      version: request.configurationVersion,
      admittedConfigurationDigest: digest("5"),
    },
  };
  const events = [];
  let current = true;
  const io = {
    assertActive() {
      if (!current) throw new Error("revoked");
    },
    poison() {
      events.push("poison");
    },
  };
  const unit = { installationId: request.installationId };
  const lease = {
    assertCurrent() {
      if (!current) throw new Error("revoked");
    },
    async release() {
      events.push("storage-release");
    },
    async lockNamespace() {
      events.push("namespace");
      return { namespaceId: request.namespaceId };
    },
    async lockAgent() {
      events.push("agent");
      return { namespaceId: request.namespaceId, agentId: request.agentId };
    },
    async readAdmission() {
      events.push("admission");
      return record;
    },
  };
  const storage = {
    async enroll(actual, actualUnit, actualIo) {
      assert.deepEqual(copy(actual), request);
      assert.equal(actualUnit, unit);
      assert.equal(actualIo, io);
      events.push("enroll");
      return lease;
    },
  };
  const capabilities = {
    async acquire(actual, content, admittedUse, actualUnit, actualIo) {
      assert.equal(content.schemaVersion, 2);
      assert.deepEqual(copy(admittedUse), record.use);
      assert.equal(actualUnit, unit);
      assert.equal(actualIo, io);
      events.push("capabilities");
      return {
        assertCurrent() {
          if (!current) throw new Error("revoked");
        },
        async release() {
          events.push("capability-release");
        },
      };
    },
  };
  return {
    value,
    derived,
    request,
    record,
    events,
    io,
    unit,
    storage,
    capabilities,
    lease,
    revoke() {
      current = false;
    },
    resolve() {
      return createAdmittedWorkloadProfileSelectorV2(storage, capabilities).resolveLocked(
        request,
        unit,
        io,
      );
    },
  };
}
test("versioned pair preserves historical Harness definition and original digest domains", () => {
  assert.equal(
    decodeWorkloadProfileManifest(bytes(workloadProfileManifestFixture())).content.containment
      .supportedRunnableTuple,
    false,
  );
  const f = setup();
  assert.throws(() => decodeWorkloadProfileManifest(bytes(f.value)));
  assert.throws(() => decodeWorkloadProfileManifestV2(bytes(workloadProfileManifestFixture())));
  assert.equal(
    f.derived.digests.resourceEnvelopeDigest,
    workloadProfileDigest("resourceEnvelopeDigest", f.value.launchConfiguration.resourceEnvelope),
  );
  assert.equal(
    f.derived.digests.manifestDigest,
    workloadProfileDigest("manifestDigest", f.derived.content),
  );
  assert.equal(Object.hasOwn(f.derived.digests, "imageSetDigest"), false);
  assert.equal(
    f.derived.unavailableDigests.imageSetDigest,
    "renderer-container-projection-required",
  );
  const changed = copy(f.value);
  changed.launchConfiguration.gateway.runtimeClass = "another-selected-class";
  assert.notEqual(
    deriveWorkloadProfileManifestV2(bytes(changed)).digests.manifestDigest,
    f.derived.digests.manifestDigest,
  );
});
test("selected capability references are data and missing producer refuses before work", async () => {
  const f = setup();
  for (const selector of [
    createAdmittedWorkloadProfileSelectorV2(),
    createAdmittedWorkloadProfileSelectorV2(f.storage),
  ])
    await assert.rejects(selector.resolveLocked(f.request, f.unit, f.io), { code: "unavailable" });
  assert.deepEqual(f.events, []);
});
test("actual selector orders locks, correlates immutable bytes and holds both leases to release", async () => {
  const f = setup();
  const result = await f.resolve();
  assert.deepEqual(f.events, ["enroll", "namespace", "agent", "admission", "capabilities"]);
  assert.deepEqual(copy(result.use), f.record.use);
  assert.equal(Object.isFrozen(result.manifest.launchConfiguration), true);
  f.record.use.admissionVersion = 9;
  assert.equal(result.use.admissionVersion, 1);
  result.assertCurrent();
  const a = result.release();
  const b = result.release();
  assert.equal(a, b);
  await a;
  assert.deepEqual(f.events.slice(-2), ["capability-release", "storage-release"]);
  assert.throws(result.assertCurrent);
});
const mutations = {
  "inert preparation": (r) => {
    r.state = "inert-profile-preparation";
  },
  "wrong admission": (r) => {
    r.use.admissionRef = uuid(90);
  },
  "wrong revision": (r) => {
    r.revision.id = "rev-other";
  },
  "sibling Agent": (r) => {
    r.revision.agentId = "agent-other";
  },
  "wrong Namespace": (r) => {
    r.revision.namespaceId = "ns-other";
  },
  "configuration generation": (r) => {
    r.configuration.version++;
  },
  "configuration identity": (r) => {
    r.revision.configurationRef = "cfg-other";
  },
  "configuration digest": (r) => {
    r.configuration.admittedConfigurationDigest = digest("6");
  },
  "frozen use mismatch": (r) => {
    r.revision.workloadProfileUse.admissionVersion++;
  },
  "role digest": (r) => {
    r.use.profileRefs.provider.contentDigest = digest("6");
    r.revision.workloadProfileUse = copy(r.use);
  },
  "role alias": (r) => {
    r.use.profileRefs.runtime.ref = r.use.profileRefs.provider.ref;
  },
  "noncanonical bytes": (r) => {
    r.canonicalManifest += " ";
  },
  "manifest mismatch": (r) => {
    const v = JSON.parse(r.canonicalManifest);
    v.launchConfiguration.gateway.runtimeClass = "other";
    r.canonicalManifest = JSON.stringify(v);
  },
  "unknown admission field": (r) => {
    r.permission = true;
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`refuse ${name} before capability use`, async () => {
    const f = setup();
    mutate(f.record);
    await assert.rejects(f.resolve());
    assert.equal(f.events.includes("capabilities"), false);
    assert.equal(f.events.filter((v) => v === "storage-release").length, 1);
  });
for (const method of ["lockNamespace", "lockAgent", "readAdmission"])
  test(`revocation after ${method} joins cleanup`, async () => {
    const f = setup();
    const original = f.lease[method];
    f.lease[method] = async () => {
      const v = await original();
      f.revoke();
      return v;
    };
    await assert.rejects(f.resolve());
    assert.equal(f.events.at(-1), "storage-release");
    assert.equal(f.events.includes("capabilities"), false);
  });
test("unsupported actual capability refuses before returning a selected lease", async () => {
  const f = setup();
  f.capabilities.acquire = async () => {
    throw new WorkloadProfileSelectionError("unsupported-capability");
  };
  await assert.rejects(f.resolve(), { code: "unsupported-capability" });
  assert.equal(f.events.at(-1), "storage-release");
});
test("throwing acquired assertion is released once and poison remains", async () => {
  const f = setup();
  Object.defineProperty(f.lease, "assertCurrent", {
    get() {
      throw new Error("bad assertion");
    },
  });
  await assert.rejects(f.resolve());
  assert.deepEqual(f.events, ["enroll", "poison", "storage-release"]);
});
test("async assertion cannot substitute for final synchronous fence", async () => {
  const f = setup();
  f.lease.assertCurrent = async () => {};
  await assert.rejects(f.resolve(), { code: "unavailable" });
  assert.equal(f.events.at(-1), "storage-release");
});
for (const settlement of ["resolve", "reject"])
  test(`invalid acquisition async fence holds cleanup through ${settlement}`, async () => {
    const f = setup();
    const pending = deferred();
    f.lease.assertCurrent = () => pending.promise;
    const outcome = assert.rejects(f.resolve(), { code: "unavailable" });
    await nextTurn();
    assert.deepEqual(f.events, ["enroll", "poison"]);
    pending[settlement](undefined);
    await outcome;
    assert.deepEqual(f.events, ["enroll", "poison", "storage-release"]);
  });
test("invalid retained async fence joins its exact work before both original releases", async () => {
  const f = setup();
  const pending = deferred();
  let invalid = false;
  let invocations = 0;
  f.capabilities.acquire = async () => ({
    assertCurrent() {
      if (invalid) {
        invocations++;
        return pending.promise;
      }
    },
    async release() {
      f.events.push("capability-release");
    },
  });
  const result = await f.resolve();
  invalid = true;
  assert.throws(result.assertCurrent, { code: "unavailable" });
  assert.throws(result.assertCurrent, { code: "unavailable" });
  assert.equal(invocations, 1);
  const releasing = result.release();
  assert.equal(releasing, result.release());
  await nextTurn();
  assert.equal(
    f.events.some((event) => event.endsWith("release")),
    false,
  );
  pending.reject(undefined);
  await releasing;
  assert.deepEqual(f.events.slice(-2), ["capability-release", "storage-release"]);
});
test("retained selector survives its real original phase operation and fences through finalization", async () => {
  const f = setup();
  const lifetime = new RepositoryTransactionLifetime();
  const phase = new GatewayStartupOwnerPhaseV1(lifetime, async () => {
    assert.fail("this controlled selector does not submit SQL");
  });
  const unit = { installationId: f.request.installationId, phase };
  let selected;
  let originalIo;
  let ownerCurrent = true;
  const ownerFence = () => {
    if (!ownerCurrent) throw Error("original owner ended");
  };
  const selector = createAdmittedWorkloadProfileSelectorV2(
    {
      async enroll(request, actualUnit, io) {
        assert.equal(actualUnit, unit);
        assert.deepEqual(copy(request), f.request);
        originalIo = io;
        io.assertActive();
        return { ...f.lease, assertCurrent: ownerFence };
      },
    },
    {
      async acquire(request, content, use, actualUnit, io) {
        assert.equal(actualUnit, unit);
        assert.equal(io, originalIo);
        io.assertActive();
        return {
          assertCurrent: ownerFence,
          async release() {
            f.events.push("capability-release");
          },
        };
      },
    },
  );
  const completion = { kind: "rollback", response: { kind: "unavailable" } };
  await phase.runCommand(async () => {
    selected = await phase.runOperation("selection", (io) =>
      selector.resolveLocked(f.request, unit, io),
    );
    phase.retainCleanup(selected.release);
    phase.retainCurrentness(selected.assertCurrent);
    await phase.runOperation("later-head-operation", async (io) => {
      io.assertActive();
      selected.assertCurrent();
    });
    return completion;
  });
  await phase.drainAccepted();
  await lifetime.finish();
  assert.equal(phase.finalize(), completion);
  await phase.finishTerminal("rolled-back");
  ownerCurrent = false;
  assert.throws(originalIo.assertActive);
  assert.throws(selected.assertCurrent);
  assert.deepEqual(f.events.slice(-2), ["capability-release", "storage-release"]);
});
test("post-selection currentness loss refuses the original owner's final fence", async () => {
  const f = setup();
  const result = await f.resolve();
  f.revoke();
  assert.throws(result.assertCurrent);
  await result.release();
});
test("incomplete original accounting refuses despite coherent admission hashes", async () => {
  const f = setup();
  f.value.launchConfiguration.resourceEnvelope.podAndRuntimeAccounting.envelope.nodeBudget = {
    status: "unavailable",
    ownerRef: "synthetic-budget-owner",
    reason: "owner-input-missing",
  };
  const derived = deriveWorkloadProfileManifestV2(bytes(f.value));
  f.request.selection.manifestDigest = derived.digests.manifestDigest;
  f.record.use.manifestDigest = derived.digests.manifestDigest;
  for (const [role, contentDigest] of Object.entries(derived.roleDigests))
    f.record.use.profileRefs[role].contentDigest = contentDigest;
  f.record.revision.workloadProfileUse = copy(f.record.use);
  f.record.canonicalManifest = new TextDecoder().decode(derived.canonicalBytes);
  await assert.rejects(f.resolve(), { code: "incomplete-accounting" });
  assert.equal(f.events.includes("capabilities"), false);
  assert.equal(f.events.at(-1), "storage-release");
});
test("wrong locked Agent refuses before reading the admission", async () => {
  const f = setup();
  f.lease.lockAgent = async () => ({
    namespaceId: f.request.namespaceId,
    agentId: "other-agent",
  });
  await assert.rejects(f.resolve(), { code: "selection-mismatch" });
  assert.equal(f.events.includes("admission"), false);
  assert.equal(f.events.at(-1), "storage-release");
});
test("capability cleanup ownership precedes a throwing assertion getter", async () => {
  const f = setup();
  f.capabilities.acquire = async () => ({
    get assertCurrent() {
      throw new Error("missing source assertion");
    },
    async release() {
      f.events.push("capability-release");
    },
  });
  await assert.rejects(f.resolve());
  assert.deepEqual(f.events.slice(-3), ["poison", "capability-release", "storage-release"]);
});
test("one cleanup failure still joins the other acquired lease", async () => {
  const f = setup();
  f.capabilities.acquire = async () => ({
    assertCurrent() {},
    async release() {
      f.events.push("capability-release");
      throw new Error("cleanup failed");
    },
  });
  const result = await f.resolve();
  await assert.rejects(result.release(), /cleanup failed/);
  assert.deepEqual(f.events.slice(-2), ["capability-release", "storage-release"]);
});
test("deferred undefined cleanup rejection remains failure and joins the remaining release", async () => {
  const f = setup();
  const pending = deferred();
  f.capabilities.acquire = async () => ({
    assertCurrent() {},
    async release() {
      f.events.push("capability-release");
      await pending.promise;
    },
  });
  const result = await f.resolve();
  const releasing = result.release();
  const outcome = releasing.then(
    () => ({ kind: "fulfilled" }),
    (error) => ({ kind: "rejected", error }),
  );
  await nextTurn();
  assert.equal(f.events.at(-1), "capability-release");
  assert.equal(f.events.includes("storage-release"), false);
  pending.reject(undefined);
  assert.deepEqual(await outcome, { kind: "rejected", error: undefined });
  assert.equal(result.release(), releasing);
  assert.deepEqual(f.events.slice(-2), ["capability-release", "storage-release"]);
});
const malformed = {
  "omitted capability": (v) => v.evidenceRequirements.capabilities.pop(),
  "repeated capability": (v) => {
    v.evidenceRequirements.capabilities[1] = copy(v.evidenceRequirements.capabilities[0]);
  },
  "caller positive flag": (v) => {
    v.containment.supportedRunnableTuple = true;
  },
  "image digest mismatch": (v) => {
    v.artifactSet.gateway.platformDigest = digest("9");
  },
  "wrong executable": (v) => {
    v.launchConfiguration.gateway.argv[0].value = "/bin/sh";
  },
  "unknown binding": (v) => {
    v.launchConfiguration.harness.argv[1].name = "caller-command";
  },
  "missing module": (v) => v.launchConfiguration.modules.pop(),
  "path traversal": (v) => {
    v.launchConfiguration.gateway.mounts[0].path = "/state/../other";
  },
  "fresh observation in static manifest": (v) => {
    v.launchConfiguration.resourceEnvelope.podAndRuntimeAccounting.envelope.observations.gateway.reason =
      "owner-input-missing";
  },
  "unknown top field": (v) => {
    v.other = true;
  },
};
for (const [name, mutate] of Object.entries(malformed))
  test(`closed pair rejects ${name}`, () => {
    const value = manifest();
    mutate(value);
    assert.throws(() => decodeWorkloadProfileManifestV2(bytes(value)));
  });
