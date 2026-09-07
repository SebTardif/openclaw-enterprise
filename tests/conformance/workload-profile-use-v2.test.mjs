import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeWorkloadProfileUseV1,
  decodeWorkloadProfileUseV2,
} from "@openclaw-enterprise/contracts/workload-profile-v1";
import { WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2 } from "../../packages/occ/src/workload-profiles/manifest.ts";
import { deriveWorkloadProfileManifestV2 } from "../../packages/occ/src/workload-profiles/projections.ts";
import { createAdmittedWorkloadProfileSelectorV2 } from "../../packages/occ/src/workload-profiles/selection.ts";
import { workloadProfileManifestFixture } from "../fixtures/workload-profile.mjs";
import { envelope } from "../fixtures/runtime-resource-accounting-v1/values.mjs";

// Same synthetic pair as the admitted-selection conformance suite. The real
// decoder and selector run here; supplied storage/capability seams establish
// data correspondence only, without an installed admission or SQL authority.
const copy = (value) => structuredClone(value);
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value));
const digest = (n) => `sha256:${n.repeat(64)}`;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ref = (name) => ({ ref: name, version: 1, contentDigest: digest("1") });
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
function fixture() {
  const derived = deriveWorkloadProfileManifestV2(bytes(manifest()));
  const request = {
    schemaVersion: 2,
    installationId: `ins_${uuid(3)}`,
    namespaceId: `ns_${uuid(4)}`,
    agentId: `agt_${uuid(5)}`,
    revisionId: `rev_${uuid(6)}`,
    configurationRef: `cfg_${uuid(7)}`,
    configurationVersion: 2,
    selection: {
      manifestRef: uuid(1),
      manifestDigest: derived.digests.manifestDigest,
      admissionRef: uuid(2),
      admissionVersion: 1,
    },
  };
  const use = {
    schemaVersion: 2,
    component: "gateway-harness-pair",
    installationId: request.installationId,
    namespaceId: request.namespaceId,
    ...request.selection,
    canonicalFormat: "oce.workload-profile.canonical-json.v1",
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
      admittedConfigurationDigest: use.admittedConfigurationDigest,
    },
  };
  const events = [];
  const unit = {
    subject: {
      kind: "agent-gateway",
      installationId: request.installationId,
      namespaceRef: request.namespaceId,
      agentRef: request.agentId,
    },
  };
  const io = {
    assertActive() {},
    poison() {
      events.push("poison");
    },
  };
  const selector = createAdmittedWorkloadProfileSelectorV2(
    {
      async enroll(actual, owner, operation) {
        assert.equal(owner, unit);
        assert.equal(operation, io);
        assert.deepEqual(copy(actual), request);
        return {
          assertCurrent() {},
          async release() {
            events.push("storage-release");
          },
          async lockNamespace() {
            return { namespaceId: request.namespaceId };
          },
          async lockAgent() {
            return { namespaceId: request.namespaceId, agentId: request.agentId };
          },
          async readAdmission() {
            return record;
          },
        };
      },
    },
    {
      async acquire(actual, content, admittedUse, owner, operation) {
        events.push("capability");
        assert.equal(owner, unit);
        assert.equal(operation, io);
        assert.equal(content.schemaVersion, 2);
        assert.deepEqual(copy(actual), request);
        assert.deepEqual(copy(admittedUse), record.use);
        return {
          assertCurrent() {},
          async release() {
            events.push("capability-release");
          },
        };
      },
    },
  );
  return { request, use, record, events, resolve: () => selector.resolveLocked(request, unit, io) };
}

function frozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) frozen(child);
}
function decode(value) {
  const result = decodeWorkloadProfileUseV2(value);
  assert.equal(result.kind, "valid");
  return result.value;
}

test("exported common decoder accepts actual selector use and preserves detached closed data", async () => {
  const f = fixture();
  const held = await f.resolve();
  try {
    // The original selector keeps its canonical null-prototype snapshot.
    assert.equal(Object.getPrototypeOf(held.use), null);
    assert.equal(Object.getPrototypeOf(held.use.profileRefs), null);
    const decoded = decode(held.use);
    assert.deepEqual(copy(decoded), copy(held.use));
    assert.notEqual(decoded, held.use);
    frozen(decoded);
    held.assertCurrent();
  } finally {
    await held.release();
  }
  assert.deepEqual(f.events, ["capability", "capability-release", "storage-release"]);
});

test("decode freezes a private copy without freezing or retaining the source graph", () => {
  const source = fixture().use;
  const result = decode(source);
  source.profileRefs.provider.version = 99;
  source.admissionVersion = 99;
  assert.equal(result.profileRefs.provider.version, 1);
  assert.equal(result.admissionVersion, 1);
  assert.equal(Object.isFrozen(source), false);
  frozen(result);
});

test("V1 remains Harness-only and V2 remains pair-only", () => {
  const pair = fixture().use;
  const legacy = { ...pair, schemaVersion: 1, component: "harness" };
  assert.equal(decodeWorkloadProfileUseV1(legacy).kind, "valid");
  assert.equal(decodeWorkloadProfileUseV2(legacy).kind, "invalid");
  assert.equal(decodeWorkloadProfileUseV1(pair).kind, "invalid");
  assert.equal(decodeWorkloadProfileUseV2(pair).kind, "valid");
});

const malformed = [
  [
    "legacy version with pair component",
    (u) => {
      u.schemaVersion = 1;
    },
  ],
  [
    "Harness component with V2 version",
    (u) => {
      u.component = "harness";
    },
  ],
  [
    "missing admitted configuration",
    (u) => {
      delete u.admittedConfigurationDigest;
    },
  ],
  [
    "extra root authority flag",
    (u) => {
      u.current = true;
    },
  ],
  [
    "extra role member",
    (u) => {
      u.profileRefs.extra = copy(u.profileRefs.provider);
    },
  ],
  [
    "missing role",
    (u) => {
      delete u.profileRefs.storage;
    },
  ],
  [
    "duplicate role identities",
    (u) => {
      u.profileRefs.runtime.ref = u.profileRefs.provider.ref;
    },
  ],
  [
    "extra nested role field",
    (u) => {
      u.profileRefs.storage.current = true;
    },
  ],
  [
    "invalid Installation",
    (u) => {
      u.installationId = "ins_unknown";
    },
  ],
  [
    "invalid Namespace",
    (u) => {
      u.namespaceId = "ns_unknown";
    },
  ],
  [
    "invalid digest",
    (u) => {
      u.manifestDigest = "sha256:bad";
    },
  ],
  [
    "unknown canonical format",
    (u) => {
      u.canonicalFormat = "json";
    },
  ],
  [
    "zero admission version",
    (u) => {
      u.admissionVersion = 0;
    },
  ],
  [
    "fractional version",
    (u) => {
      u.admissionVersion = 1.5;
    },
    "invalid-number",
  ],
  [
    "unsafe role version",
    (u) => {
      u.profileRefs.identity.version = Number.MAX_SAFE_INTEGER + 1;
    },
    "invalid-number",
  ],
  [
    "negative zero role version",
    (u) => {
      u.profileRefs.identity.version = -0;
    },
    "invalid-number",
  ],
];
for (const [name, change, selectorCode = "invalid-record"] of malformed) {
  test(`common decoder and actual selector reject ${name}`, async () => {
    const f = fixture();
    change(f.record.use);
    assert.deepEqual(decodeWorkloadProfileUseV2(f.record.use), { kind: "invalid" });
    // Canonical numeric rejection precedes record validation in the original selector.
    await assert.rejects(f.resolve(), { code: selectorCode });
    assert.equal(f.events.includes("capability"), false);
    assert.equal(f.events.filter((e) => e === "storage-release").length, 1);
  });
}

test("decoder refuses accessor and proxy input without invoking data hooks", () => {
  const source = fixture().use;
  let calls = 0;
  Object.defineProperty(source, "admissionVersion", {
    enumerable: true,
    get() {
      calls++;
      throw new Error("must not read");
    },
  });
  assert.deepEqual(decodeWorkloadProfileUseV2(source), { kind: "invalid" });
  const proxy = new Proxy(fixture().use, {
    ownKeys() {
      calls++;
      throw new Error("must not inspect");
    },
  });
  assert.deepEqual(decodeWorkloadProfileUseV2(proxy), { kind: "invalid" });
  assert.equal(calls, 0);
});

for (const field of ["admissionVersion", "admittedConfigurationDigest"]) {
  test(`valid decoded ${field} still needs original revision correspondence`, async () => {
    const f = fixture();
    f.record.use[field] = field === "admissionVersion" ? 2 : digest("6");
    decode(f.record.use);
    await assert.rejects(f.resolve(), { code: "selection-mismatch" });
    assert.equal(f.events.includes("capability"), false);
  });
}

test("valid use data does not replace unavailable original participants", async () => {
  const f = fixture();
  decode(f.use);
  await assert.rejects(
    createAdmittedWorkloadProfileSelectorV2().resolveLocked(
      f.request,
      { installationId: f.request.installationId },
      { assertActive() {}, poison() {} },
    ),
    { code: "unavailable" },
  );
});
