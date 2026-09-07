import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { renderAdmittedGatewayLaunch } from "../../apps/controller/src/drivers/compute/kubernetes/admitted-launch-plan.ts";
import { deriveWorkloadProfileManifestV2 } from "@openclaw-enterprise/occ/workload-profiles/projections";
import { WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2 } from "../../packages/occ/src/workload-profiles/manifest.ts";
import { workloadProfileManifestFixture } from "../fixtures/workload-profile.mjs";
import { builderEnvelope } from "../fixtures/kubernetes-resource-plan/driver-values.mjs";
import {
  fixture as historicalFixture,
  deferred,
} from "../fixtures/kubernetes-installation-process/values.mjs";

// Controlled original owner/call/renderer peers only. The actual Driver,
// collaborator, canonical decoder and official SDK use the existing controlled
// transport; these cases supply no production enrollment or runtime evidence.
const clone = structuredClone;
const digest = (n) => `sha256:${n.repeat(64)}`;
const definition = (ref) => ({ ref, version: 1, contentDigest: digest("1") });
const recordRef = (recordRef) => ({ recordRef, recordVersion: 1 });
const turn = () => new Promise(setImmediate);
const options = JSON.parse(
  readFileSync(
    new URL("../fixtures/kubernetes-lifecycle-collaborators/inputs.json", import.meta.url),
  ),
).options;

function launchRecord(f) {
  const { envelope, mapping } = builderEnvelope();
  for (const component of ["gateway", "harness"])
    envelope.observations[component] = {
      status: "unavailable",
      ownerRef: "controlled-observer",
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
    environmentDefinition: definition(`${name}-environment`),
    runtimeClass: "selected-agent-runsc",
    protocolVersion: 1,
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    mounts: ["state", "home", "tmp"].map((kind) => ({
      name: `${name}-${kind}`,
      path: `/${kind}`,
      store: definition(`${name}-${kind}`),
      access: "read-write",
    })),
  });
  const manifest = {
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
        definition: definition(kind),
        artifactDigest: digest("4"),
      })),
      placement: { cluster: definition("cluster"), namespaceAllocation: definition("namespace") },
      runtime: {
        implementation: definition("fixed-renderer"),
        handler: "selected-agent-runsc",
        platform: "systrap",
      },
      resourceEnvelope: { podAndRuntimeAccounting: { status: "selected", envelope } },
      credentials: {
        deliveryMode: "installation-channel-material-v1",
        materialSelection: definition("materials"),
        pathCustody: definition("paths"),
        harnessPlatformCredentials: "forbidden",
      },
    },
    containment: {
      definition: definition("containment"),
      kvmRequired: false,
      privileged: false,
      gatewayPrivateStateInHarness: "forbidden",
      supportedRunnableTuple: "requires-current-owner-validation",
    },
    endpoints: {
      identity: definition("identity"),
      modelMediator: definition("model"),
      repositoryIssuer: definition("issuer"),
      harnessTransport: definition("transport"),
    },
    evidenceRequirements: {
      bootstrap: "independent-installation-service",
      physicalCreator: "original-compute-createOriginal",
      context: "initialize-new-or-resume-retained",
      replacement: "exact-replaced-and-retained-participants",
      capabilities: WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2.map((id) => ({
        id,
        implementation: definition(id),
      })),
    },
  };
  const derived = deriveWorkloadProfileManifestV2(
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  const selection = {
    manifestRef: "manifest",
    manifestDigest: derived.digests.manifestDigest,
    admissionRef: "admission",
    admissionVersion: 1,
  };
  const subject = {
    kind: "agent-gateway",
    installationId: "installation-fixture",
    namespaceRef: "attribution-namespace",
    agentRef: "attribution-agent",
  };
  const startup = {
    schemaVersion: 2,
    subject,
    processRef: "gateway-process",
    processGeneration: 7,
    operationRef: "original-startup-operation",
    operationDigest: digest("a"),
  };
  const request = {
    schemaVersion: 2,
    installationId: subject.installationId,
    namespaceId: subject.namespaceRef,
    agentId: subject.agentRef,
    revisionId: "admitted-revision",
    configurationRef: "configuration",
    configurationVersion: 2,
    selection,
  };
  const use = {
    schemaVersion: 2,
    component: "gateway-harness-pair",
    installationId: subject.installationId,
    namespaceId: subject.namespaceRef,
    canonicalFormat: "oce.workload-profile.canonical-json.v1",
    ...selection,
    profileRefs: Object.fromEntries(
      Object.entries(derived.roleDigests).map(([role, contentDigest]) => [
        role,
        { ref: `${role}-profile`, version: 1, contentDigest },
      ]),
    ),
    admittedConfigurationDigest: digest("5"),
  };
  const launch = derived.content.launchConfiguration;
  const modules = launch.modules.map((value) => ({
    definition: value,
    selection: {
      id: value.id,
      kind: value.kind,
      profileRef: `${value.id}-resolved-profile`,
      requiredCapabilities: [],
    },
  }));
  const input = {
    ...clone(f.createInput),
    binding: {
      ...clone(f.createInput.binding),
      schemaVersion: 2,
      startup,
      selection,
      profileRefs: use.profileRefs,
      admittedConfigurationDigest: use.admittedConfigurationDigest,
      modules: modules.map(({ selection }) => selection),
    },
  };
  return {
    input,
    request,
    use,
    canonicalManifest: new TextDecoder().decode(derived.canonicalBytes),
    placement: { ...clone(launch.placement), target: clone(input.target) },
    renderer: {
      definition: clone(launch.runtime.implementation),
      template: clone(f.template),
      applicationName: "gateway",
      privateStateInitName: "initialize",
      accounting: mapping,
    },
    environment: {
      definition: clone(launch.gateway.environmentDefinition),
      variables: [{ name: "SELECTED", value: "immutable" }],
    },
    modules,
    arguments: { "configuration-path": "/config/selected.json" },
    storage: {
      runtimeHome: { accountingId: "gateway/home", volumeName: "gateway-home" },
      temporary: { accountingId: "gateway/tmp", volumeName: "gateway-tmp" },
    },
    mounts: launch.gateway.mounts.map((value) => ({
      definition: value,
      volume: value.name.endsWith("-state")
        ? { name: value.name, persistentVolumeClaim: { claimName: "exact-private-claim" } }
        : {
            name: value.name,
            emptyDir: { sizeLimit: value.name.endsWith("-home") ? "50000" : "1000" },
          },
      mount: { name: value.name, mountPath: value.path },
    })),
  };
}

function fixture() {
  const f = historicalFixture();
  const historicalDriver = f.driver;
  f.record = launchRecord(f);
  f.createInput = clone(f.record.input);
  f.locator = f.createInput.binding.startup;
  f.original.binding = clone(f.createInput.binding);
  f.template = clone(renderAdmittedGatewayLaunch(f.createInput, f.record).deployment);
  f.deployment.spec = clone(f.template.spec);
  f.pod.spec = { ...clone(f.template.spec.template.spec), nodeName: "selected-node" };
  f.events = [];
  f.scopes = [];
  f.acceptHook = undefined;
  f.fenceHook = undefined;
  f.planHook = undefined;
  f.planFenceHook = undefined;
  const calls = new WeakMap();
  const enroll = f.enroll;
  f.enroll = (method, input, ms) => {
    const call = enroll(method, input, ms);
    calls.set(call.call, { method, input: clone(input) });
    return call;
  };
  const base = f.dependencies;
  const deps = {
    invocations: {
      enrollInvocation(method, input, call, drain) {
        const entry = calls.get(call);
        if (!entry || entry.method !== method || !isDeepStrictEqual(entry.input, input))
          return undefined;
        f.events.push("enrolled");
        const state = { settled: false, drain, close: undefined };
        f.scopes.push(state);
        return {
          settle() {
            f.events.push("settle");
            state.close ??= drain().then(() => {
              state.settled = true;
              f.events.push("drained");
            });
            return state.close;
          },
        };
      },
    },
    accepting: {
      ...base.accepting,
      async accept(method, input, call) {
        f.events.push("accept");
        assert.equal(f.events[0], "enrolled");
        if (f.acceptHook) await f.acceptHook();
        const accepted = await base.accepting.accept(method, input, call);
        if (!accepted) return undefined;
        return {
          ...accepted,
          assertCurrent() {
            accepted.assertCurrent();
            return f.fenceHook?.();
          },
        };
      },
    },
    submission: {
      ...base.submission,
      async claimOriginal(input, call) {
        assert.ok(f.scopes.length > 0, "claim shares the pre-acceptance invocation");
        const claimed = await base.submission.claimOriginal(input, call);
        f.events.push("commit-settled");
        return claimed;
      },
      consumeSubmission(...args) {
        f.events.push("consume");
        return base.submission.consumeSubmission(...args);
      },
    },
    launchPlans: {
      async read() {
        f.events.push("plan");
        if (f.planHook) await f.planHook();
        return {
          record: clone(f.record),
          async recheckCurrent() {
            if (!f.planCurrent) throw new Error("Revoked plan.");
          },
          assertCurrent() {
            if (!f.planCurrent) throw new Error("Revoked plan.");
            return f.planFenceHook?.();
          },
        };
      },
    },
    settlement: base.settlement,
  };
  f.dependencies = deps;
  f.driver = new KubernetesComputeDriver(clone(options), { agentGatewayDependencies: deps });
  f.driver.apiClients = historicalDriver.apiClients;
  f.participant = f.driver.getAgentGatewayProcessParticipant();
  f.call = (method, input) => f.participant[method](input, f.enroll(method, input).call);
  f.join = async () => {
    await turn();
    await Promise.all(f.scopes.map((scope) => scope.close));
  };
  return f;
}

test("selected Driver creates once from the complete admitted plan and exact call", async () => {
  const f = fixture();
  f.responseHook = (request) => {
    if (request.method === "POST") {
      f.events.push("sdk");
      assert.equal(f.events.at(-2), "consume");
    }
  };
  const created = await f.call("createOriginal", f.createInput);
  assert.equal(created.kind, "accepted-object");
  assert.equal(created.original.binding.startup.schemaVersion, 2);
  assert.equal(created.original.binding.hostRuntimeGeneration, 19);
  assert.equal(created.original.binding.startup.processGeneration, 7);
  assert.equal(f.consumeCount, 1);
  const sent = f.requests.find(({ method }) => method === "POST").body.spec.template.spec;
  assert.equal(sent.runtimeClassName, "selected-agent-runsc");
  assert.deepEqual(sent.containers[0].command, ["/app/gateway"]);
  assert.deepEqual(sent.containers[0].args, ["/config/selected.json"]);
  assert.equal(sent.containers[0].resources.limits.memory, "2000");
  assert.equal(
    sent.volumes.find(({ name }) => name === "gateway-home").emptyDir.sizeLimit,
    "50000",
  );
  assert.ok(f.events.indexOf("commit-settled") < f.events.indexOf("sdk"));
  await f.join();
  assert.equal(f.scopes[0].settled, true);
  const again = await f.call("createOriginal", f.createInput);
  assert.equal(again.kind, "unknown");
  assert.equal(f.requests.filter(({ method }) => method === "POST").length, 1);
  await f.join();
});

test("V2 selection has no second legacy prepare/activate creator", async () => {
  const f = fixture();
  await assert.rejects(f.driver.prepareRevision({}), /original process participant/);
  await assert.rejects(f.driver.activateRevision({}), /original process participant/);
  assert.equal(f.requests.length, 0);
});

test("missing actual enrollment remains unavailable before accepting", async () => {
  const f = fixture();
  assert.deepEqual(await f.participant.createOriginal(f.createInput, { authorityCall: {} }), {
    kind: "unavailable",
  });
  assert.equal(f.events.length, 0);
  assert.equal(f.requests.length, 0);
});

for (const [bundle, name] of [
  ["accepting", "retainCreate"],
  ["accepting", "retainDescendants"],
  ["accepting", "retainObservation"],
  ["submission", "consumeSubmission"],
  ["settlement", "readCurrent"],
  ["invocations", "enrollInvocation"],
])
  test(`missing mandatory ${bundle}.${name} never reaches acceptance or SDK`, async () => {
    const f = fixture();
    delete f.dependencies[bundle][name];
    assert.equal((await f.call("createOriginal", f.createInput)).kind, "unavailable");
    assert.equal(f.events.length, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.claimCount, 0);
  });

for (const mutate of [
  (v) => {
    v.binding.startup.subject.agentRef = "another-agent";
  },
  (v) => {
    v.binding.startup.schemaVersion = 1;
  },
  (v) => {
    v.binding.startup.subject.kind = "installation-service";
  },
])
  test("cross-Agent/version/subject input cannot reuse an original enrolled call", async () => {
    const f = fixture();
    const { call } = f.enroll("createOriginal", f.createInput);
    const changed = clone(f.createInput);
    mutate(changed);
    assert.equal((await f.participant.createOriginal(changed, call)).kind, "unavailable");
    assert.equal(f.requests.length, 0);
  });

test("historical Installation V1 remains a separate existing protocol", async () => {
  const f = historicalFixture();
  const original = await f.participant.discoverOriginal(
    f.locator,
    f.enroll("discoverOriginal", f.locator).call,
  );
  assert.equal(original.kind, "found");
  assert.equal(original.original.binding.startup.schemaVersion, undefined);
  assert.deepEqual(
    await f.driver.getAgentGatewayProcessParticipant().discoverOriginal(f.locator, {}),
    { kind: "unavailable" },
  );
});

for (const [name, mutate] of [
  [
    "admitted revision",
    (r) => {
      r.request.revisionId = "other";
    },
  ],
  [
    "configuration digest",
    (r) => {
      r.use.admittedConfigurationDigest = digest("9");
    },
  ],
  [
    "manifest bytes",
    (r) => {
      r.canonicalManifest += " ";
    },
  ],
  [
    "role digest",
    (r) => {
      r.use.profileRefs.runtime.contentDigest = digest("9");
    },
  ],
  [
    "physical target",
    (r) => {
      r.placement.target.namespace.uid = "successor";
    },
  ],
  [
    "logical allocation",
    (r) => {
      r.placement.namespaceAllocation.version++;
    },
  ],
  [
    "resolved module",
    (r) => {
      r.modules[0].selection.profileRef = "other";
    },
  ],
  [
    "renderer definition",
    (r) => {
      r.renderer.definition.version++;
    },
  ],
  [
    "unselected argument",
    (r) => {
      r.arguments["state-path"] = "/other";
    },
  ],
  [
    "home capacity",
    (r) => {
      r.mounts.find((m) => m.volume.name === "gateway-home").volume.emptyDir.sizeLimit = "50001";
    },
  ],
  [
    "missing temp capacity",
    (r) => {
      delete r.mounts.find((m) => m.volume.name === "gateway-tmp").volume.emptyDir.sizeLimit;
    },
  ],
  [
    "wrong storage medium",
    (r) => {
      r.mounts.find((m) => m.volume.name === "gateway-tmp").volume.emptyDir.medium = "Memory";
    },
  ],
  [
    "unbound storage map",
    (r) => {
      r.storage.runtimeHome.accountingId = "other";
    },
  ],
  [
    "dropped init volume",
    (r) => {
      r.renderer.template.spec.template.spec.initContainers[0].volumeMounts = [
        { name: "missing", mountPath: "/private" },
      ];
    },
  ],
])
  test(`admitted ${name} mismatch is refused before clients`, async () => {
    const f = fixture();
    mutate(f.record);
    assert.equal((await f.call("createOriginal", f.createInput)).kind, "unavailable");
    assert.equal(f.requests.length, 0);
    assert.equal(f.claimCount, 0);
    await f.join();
  });

test("API observation uses current UID-chain resource versions, retains original creation RV", async () => {
  const f = fixture();
  f.deployment.metadata.resourceVersion = "fresh-deployment-rv";
  f.namespace.metadata.resourceVersion = "fresh-namespace-rv";
  const value = await f.call("observeExact", { original: f.original });
  assert.equal(value.kind, "observed");
  assert.equal(value.chain.deployment.resourceVersion, "fresh-deployment-rv");
  assert.equal(value.original.deployment.resourceVersion, "1");
  assert.equal(value.chain.pod.runtimeClassName, "selected-agent-runsc");
  const retained = f.descendants.at(-1);
  assert.deepEqual(retained.complete, { replicaSets: true, pods: true });
  assert.equal(retained.root.deployment.uid, "deployment-uid");
  assert.deepEqual(
    retained.replicaSets.map(({ uid }) => uid),
    ["replicaset-uid"],
  );
  assert.deepEqual(
    retained.pods.map(({ identity, replicaSetUid }) => [identity.uid, replicaSetUid]),
    [["pod-uid", "replicaset-uid"]],
  );
  await f.join();
});

test("API absent observation and acknowledged conditional retirement never prove termination", async () => {
  const f = fixture();
  f.missingObject = "deployment";
  assert.equal((await f.call("observeExact", { original: f.original })).kind, "absent");
  f.missingObject = undefined;
  f.deployment.metadata.resourceVersion = "current-rv";
  const retired = await f.call("requestRetirement", f.retirementInput());
  assert.equal(retired.kind, "requested");
  assert.equal(retired.termination, "unknown");
  assert.deepEqual(f.requests.find(({ method }) => method === "DELETE").body.preconditions, {
    uid: "deployment-uid",
    resourceVersion: "current-rv",
  });
  assert.equal((await f.call("readReplacementDisposition", f.locator)).kind, "unavailable");
  await f.join();
});

test("successor Deployment UID cannot be retired", async () => {
  const f = fixture();
  f.deployment.metadata.uid = "successor";
  assert.equal((await f.call("requestRetirement", f.retirementInput())).kind, "unavailable");
  assert.equal(
    f.requests.some(({ method }) => method === "DELETE"),
    false,
  );
  await f.join();
});

test("SDK create failure retains original uncertainty and prohibits replay", async () => {
  const f = fixture();
  f.responseHook = (r) => {
    if (r.method === "POST") throw new Error("Unknown SDK response.");
  };
  const result = await f.call("createOriginal", f.createInput);
  assert.deepEqual(result, { kind: "unknown", operation: f.locator });
  assert.deepEqual(f.outcomes, [{ kind: "unknown" }]);
  await f.join();
  assert.equal((await f.call("createOriginal", f.createInput)).kind, "unknown");
  assert.equal(f.consumeCount, 1);
  await f.join();
});

test("whole invocation joins late SDK and durable retention after inner COMMIT and caller abort", async () => {
  const f = fixture();
  const entered = deferred();
  const sdk = deferred();
  const retained = deferred();
  f.responseHook = async (r) => {
    if (r.method === "POST") {
      entered.resolve();
      await sdk.promise;
    }
  };
  f.retainHook = () => retained.promise;
  const { call, abort } = f.enroll("createOriginal", f.createInput);
  const pending = f.participant.createOriginal(f.createInput, call);
  await entered.promise;
  assert.ok(f.events.includes("commit-settled"));
  assert.equal(f.scopes[0].settled, false);
  abort.abort();
  assert.equal((await pending).kind, "unknown");
  await turn();
  assert.equal(f.scopes[0].settled, false);
  sdk.resolve();
  await turn();
  assert.equal(f.scopes[0].settled, false);
  assert.equal(f.outcomes.length, 1);
  retained.resolve();
  await f.join();
  assert.equal(f.scopes[0].settled, true);
});

for (const stage of ["accept", "plan"])
  test(`aborted deferred ${stage} stays in the original drain`, async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    f[`${stage}Hook`] = () => {
      entered.resolve();
      return release.promise;
    };
    const { call, abort } = f.enroll("createOriginal", f.createInput);
    const pending = f.participant.createOriginal(f.createInput, call);
    await entered.promise;
    abort.abort();
    assert.equal((await pending).kind, "unavailable");
    await turn();
    assert.equal(f.scopes[0].settled, false);
    release.resolve();
    await f.join();
    assert.equal(f.scopes[0].settled, true);
    assert.equal(f.requests.length, 0);
  });

test("deferred accidental enrollment never upgrades to accepted authority", async () => {
  const f = fixture();
  const late = deferred();
  let joined = false;
  f.dependencies.invocations.enrollInvocation = () => late.promise;
  assert.equal((await f.call("createOriginal", f.createInput)).kind, "unavailable");
  late.resolve({
    async settle() {
      joined = true;
    },
  });
  await turn();
  assert.equal(joined, true);
  assert.equal(f.events.length, 0);
  assert.equal(f.requests.length, 0);
});

test("deferred invalid final assertion is retained until settlement", async () => {
  const f = fixture();
  const late = deferred();
  f.fenceHook = () => late.promise;
  assert.equal((await f.call("discoverOriginal", f.locator)).kind, "unavailable");
  await turn();
  assert.equal(f.scopes[0].settled, false);
  late.reject(new Error("Deferred invalid fence."));
  await f.join();
  assert.equal(f.scopes[0].settled, true);
  assert.equal(f.requests.length, 0);
});

test("post-callback signal check refuses a positive discovery", async () => {
  const f = fixture();
  const enrolled = f.enroll("discoverOriginal", f.locator);
  f.dependencies.accepting.readOriginal = async () => {
    f.fenceHook = () => {
      enrolled.abort.abort();
    };
    return clone(f.original);
  };
  assert.equal(
    (await f.participant.discoverOriginal(f.locator, enrolled.call)).kind,
    "unavailable",
  );
  await f.join();
});

test("post-consumption local check catches synchronous cancellation before SDK", async () => {
  const f = fixture();
  const enrolled = f.enroll("createOriginal", f.createInput);
  const consume = f.dependencies.submission.consumeSubmission;
  f.dependencies.submission.consumeSubmission = (...args) => {
    consume(...args);
    enrolled.abort.abort();
  };
  assert.equal((await f.participant.createOriginal(f.createInput, enrolled.call)).kind, "unknown");
  assert.equal(f.consumeCount, 1);
  assert.equal(
    f.requests.some(({ method }) => method === "POST"),
    false,
  );
  await f.join();
});

test("synchronous final-plan deadline overrun cannot dispatch", async () => {
  const f = fixture();
  const enrolled = f.enroll("createOriginal", f.createInput, 1000);
  f.claimHook = () => {
    f.planFenceHook = () => {
      while (Date.now() <= Date.parse(enrolled.call.authorityCall.deadline)) {}
    };
  };
  assert.equal((await f.participant.createOriginal(f.createInput, enrolled.call)).kind, "unknown");
  assert.equal(
    f.requests.some(({ method }) => method === "POST"),
    false,
  );
  assert.equal(f.consumeCount, 0);
  await f.join();
});

test("protected physical disposition callback cannot abort and still return positive", async () => {
  const f = fixture();
  const enrolled = f.enroll("readReplacementDisposition", f.locator);
  f.settlement = {
    operation: clone(f.locator),
    disposition: "retired",
    receipt: recordRef("physical-receipt"),
    async recheckCurrent() {},
    assertCurrent() {
      enrolled.abort.abort();
    },
  };
  assert.equal(
    (await f.participant.readReplacementDisposition(f.locator, enrolled.call)).kind,
    "unavailable",
  );
  await f.join();
});

test("original current physical receipt remains a separate protected input", async () => {
  const f = fixture();
  f.settlement = {
    operation: clone(f.locator),
    disposition: "retired",
    receipt: recordRef("physical-receipt"),
    async recheckCurrent() {},
    assertCurrent() {},
  };
  const value = await f.call("readReplacementDisposition", f.locator);
  assert.equal(value.kind, "verified-disposition");
  assert.equal(f.requests.length, 0);
  await f.join();
});

test("accounted ordinary init cannot silently become a permanent sidecar", async () => {
  const f = fixture();
  f.record.renderer.template.spec.template.spec.initContainers[0].restartPolicy = "Always";
  assert.equal((await f.call("createOriginal", f.createInput)).kind, "unavailable");
  assert.equal(f.requests.length, 0);
  await f.join();
});

test("qualified init image must retain an immutable artifact digest", async () => {
  const f = fixture();
  f.record.renderer.template.spec.template.spec.initContainers[0].image =
    "example.invalid/init:latest";
  assert.equal((await f.call("createOriginal", f.createInput)).kind, "unavailable");
  assert.equal(f.requests.length, 0);
  await f.join();
});

test("deferred cleanup recheck remains owned after requesting caller abort", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  const readCleanup = f.dependencies.accepting.readCleanup;
  f.dependencies.accepting.readCleanup = async (...args) => {
    const cleanup = await readCleanup(...args);
    return {
      ...cleanup,
      async recheckCurrent() {
        entered.resolve();
        await release.promise;
      },
    };
  };
  const input = f.retirementInput();
  const enrolled = f.enroll("requestRetirement", input);
  const pending = f.participant.requestRetirement(input, enrolled.call);
  await entered.promise;
  enrolled.abort.abort();
  assert.equal((await pending).kind, "unknown");
  await turn();
  assert.equal(f.scopes[0].settled, false);
  release.resolve();
  await f.join();
  assert.equal(f.scopes[0].settled, true);
  assert.equal(
    f.requests.some(({ method }) => method === "DELETE"),
    false,
  );
});

test("input mutation during protected plan wait cannot retarget the original effect", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.planHook = () => {
    entered.resolve();
    return release.promise;
  };
  const input = clone(f.createInput);
  const enrolled = f.enroll("createOriginal", input);
  const pending = f.participant.createOriginal(input, enrolled.call);
  await entered.promise;
  input.target.deploymentName = "unrelated-successor";
  input.binding.startup.subject.agentRef = "unrelated-agent";
  release.resolve();
  const result = await pending;
  assert.equal(result.kind, "accepted-object");
  assert.equal(result.original.target.deploymentName, "installation-gateway");
  assert.equal(result.original.binding.startup.subject.agentRef, "attribution-agent");
  await f.join();
});

test("unknown original claim cannot be converted into a local submission", async () => {
  const f = fixture();
  f.claimUnknown = true;
  assert.deepEqual(await f.call("createOriginal", f.createInput), {
    kind: "unknown",
    operation: f.locator,
  });
  assert.equal(f.consumeCount, 0);
  assert.equal(
    f.requests.some(({ method }) => method === "POST"),
    false,
  );
  await f.join();
});

test("invalid deferred consumption is denied and retained without SDK dispatch", async () => {
  const f = fixture();
  const late = deferred();
  f.dependencies.submission.consumeSubmission = () => late.promise;
  assert.equal((await f.call("createOriginal", f.createInput)).kind, "unknown");
  await turn();
  assert.equal(f.scopes[0].settled, false);
  assert.equal(
    f.requests.some(({ method }) => method === "POST"),
    false,
  );
  late.reject(new Error("Deferred consumption rejected."));
  await f.join();
  assert.equal(f.scopes[0].settled, true);
});
