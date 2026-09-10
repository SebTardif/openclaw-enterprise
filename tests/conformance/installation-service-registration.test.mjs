import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const ownerUrl = new URL("../../packages/occ/src/gateway-startup-v1/owner.ts", import.meta.url)
  .href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openclaw-enterprise/occ/gateway-startup-v1/owner")
      return { url: ownerUrl, shortCircuit: true };
    return next(specifier, context);
  },
});
const {
  canonicalGatewayStartupValueV1,
  gatewayStartupCommandDigestV1,
  gatewayStartupCommandDigestV2,
  GatewayStartupOwnerPhaseV1,
} = await import(ownerUrl);
const { RepositoryTransactionLifetime } =
  await import("../../packages/occ/src/ports/transaction.ts");
const {
  createInstallationServiceRegistrationReaderV1,
  createInstallationServiceRegistrationReaderV2,
  createInstallationServiceMaterialRegistrationReaderV1,
} = await import("../../apps/controller/src/admission/installation-service-registration.ts");

const ref = (recordRef) => ({ recordRef, recordVersion: 1 });
const object = (name) => ({ name, uid: name + "-uid", resourceVersion: "1" });
function fixture(options = {}) {
  // These are controlled reader participants, not an authenticated native source,
  // SPIRE registration, Compute observation or real transaction.
  const subject = {
    kind: "agent-gateway",
    installationId: "installation-one",
    namespaceRef: "namespace-one",
    agentRef: "agent-one",
  };
  const startup = {
    ...(options.version === 2
      ? { schemaVersion: 2, subject }
      : { installationId: "installation-one" }),
    processRef: "process-one",
    processGeneration: 1,
    operationRef: "accept-one",
    operationDigest: "a".repeat(64),
  };
  const binding = {
    ...(options.version === 2 ? { schemaVersion: 2 } : {}),
    startup,
    createEffectRef: "effect-one",
    selection: ref("selection-one"),
    configurationRef: "configuration-one",
    configurationVersion: 1,
    profileRef: "profile-one",
    profileVersion: 1,
    namespaceRef: "namespace-one",
    agentRef: "agent-one",
    admittedRevisionRef: "revision-one",
    gatewayAssignmentRef: "gateway-one",
    hostRuntimeGeneration: 1,
    nativeConfigRef: "native-one",
    configDigest: "b".repeat(64),
    stateOwnership: ref("state-one"),
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    protocolVersion: 1,
    modules: [
      { id: "identity", kind: "identity", profileRef: "identity-one", requiredCapabilities: [] },
    ],
    startupDeadlineMs: 3000,
    shutdownDeadlineMs: 3000,
  };
  const recipient = {
    recipient: ref("recipient-one"),
    process: ref("process-one"),
    incarnationRef: "local-recipient-one",
    observation: ref("observation-one"),
  };
  const startupCommand = {
    schemaVersion: options.version === 2 ? 2 : 1,
    ...(options.version === 2 ? { subject } : {}),
    kind: "consume-startup",
    operationRef: "consume-one",
    startup,
    expectedHead: { version: 2, startup, recordVersion: 2 },
    recipient,
  };
  const command = options.material
    ? {
        schemaVersion: 1,
        purpose: "read-selected-channel-material",
        use: "startup-slack-pair",
        startup,
        selection: binding.selection,
        recipient: recipient.recipient,
        consumedClaim: {
          operationRef: "consume-one",
          operationDigest: gatewayStartupCommandDigestV1(startupCommand),
          afterRecordVersion: 3,
        },
      }
    : startupCommand;
  const identity = {
    clusterRef: "cluster-one",
    namespaceUid: "namespace-uid",
    deploymentUid: "deployment-uid",
    replicaSetUid: "replicaset-uid",
    podUid: "pod-uid",
    nodeName: "node-one",
    runtimeClassName: null,
    containerName: "gateway",
    executionIncarnationRef: "actual-execution-one",
    recipientIncarnationRef: recipient.incarnationRef,
  };
  const entry = {
    entryId: "entry-one",
    spiffeId: "spiffe://example.test/gateway",
    parentId: "spiffe://example.test/agent-one",
    selectors: [
      { type: "k8s", value: "pod-uid:pod-uid" },
      { type: "k8s", value: "container-name:gateway" },
    ],
  };
  const nativeConfiguration = {
    sourceRef: "native-controller-source",
    configurationVersion: 11,
    sourceConfigurationDigest: "sha256:" + "d".repeat(64),
  };
  const selection = {
    binding,
    recipient,
    registration: ref("registration-one"),
    source: ref("source-one"),
    nativeConfiguration: structuredClone(nativeConfiguration),
    endpoints: {
      gateway: { serviceRef: "gateway-service-one", spiffeId: "spiffe://example.test/gateway" },
      controller: {
        serviceRef: "controller-service-one",
        spiffeId: "spiffe://example.test/controller",
      },
      transportRecipientRef: "controller-service-one",
    },
    entry,
    controllerSpiffeId: "spiffe://example.test/controller",
    process: identity,
    maximumObservationAgeMs: 10000,
    clockUncertaintyMs: 10,
  };
  if (options.material)
    selection.material = {
      purpose: command.purpose,
      use: command.use,
      consumedClaim: command.consumedClaim,
    };
  const now = Date.now(),
    timed = { observedAtMs: now, expiresAtMs: now + 5000 };
  const registration = {
    ...timed,
    registration: selection.registration,
    entries: [entry],
    coverage: "complete",
  };
  const originalObject = {
    binding,
    target: {
      clusterRef: "cluster-one",
      namespace: object("namespace"),
      deploymentName: "deployment",
    },
    deployment: object("deployment"),
    controllerGeneration: 1,
    correlation: ref("correlation-one"),
  };
  const observed = {
    ...timed,
    identity,
    executionObservation: { ...timed },
    observation: {
      kind: "observed",
      original: originalObject,
      chain: {
        namespace: object("namespace"),
        deployment: object("deployment"),
        replicaSet: object("replicaset"),
        pod: {
          ...object("pod"),
          nodeName: "node-one",
          runtimeClassName: null,
          containers: [
            {
              kind: "main",
              name: "gateway",
              containerId: "diagnostic-only",
              imageId: "image-one",
              restartCount: 0,
              startedAt: new Date(now).toISOString(),
            },
          ],
        },
      },
      evidence: ref("evidence-one"),
      observedAt: new Date(now).toISOString(),
    },
  };
  const sourceAbort = new AbortController(),
    requestAbort = new AbortController();
  const bounds = {
    requestRef: "request-one",
    deadline: new Date(now + 3000).toISOString(),
    signal: requestAbort.signal,
  };
  const original = {},
    originals = new WeakSet([original]),
    acquired = [],
    released = [];
  let active = true,
    current = true;
  const unit =
    options.unit ??
    (options.version === 2 ? { subject } : { installationId: startup.installationId });
  const io = options.io ?? {
    assertActive() {
      if (!active) throw new Error("controlled unit closed");
    },
  };
  const lease = (name, value) => ({
    value,
    assertCurrent() {
      if (!current) throw new Error("controlled revoked");
      return options.fence?.(name);
    },
    async release() {
      released.push(name);
      if (options.release) await options.release(name);
    },
  });
  let inspection;
  const participants = {
    native: {
      inspectOriginal(value, input, suppliedBounds) {
        if (!originals.has(value) || suppliedBounds !== bounds) return undefined;
        if (options.inspect) return options.inspect(value, input);
        inspection = {
          expectedSourceConfiguration: structuredClone(selection.source),
          nativeConfiguration: structuredClone(nativeConfiguration),
          gatewaySpiffeId: entry.spiffeId,
          controllerSpiffeId: selection.controllerSpiffeId,
          commandDigest: options.material
            ? ""
            : options.version === 2
              ? gatewayStartupCommandDigestV2(input)
              : gatewayStartupCommandDigestV1(input),
          operationProfile: "installation-gateway-startup-v1",
          transportProfile: "owned-child-stdio-installation-gateway-startup-v1",
          expiresAtMs: now + 10000,
          signal: sourceAbort.signal,
          assertCurrent() {
            if (sourceAbort.signal.aborted) throw new Error("controlled native loss");
          },
        };
        if (options.material) {
          delete inspection.commandDigest;
          inspection.requestDigest = createHash("sha256")
            .update(canonicalGatewayStartupValueV1(input))
            .digest("hex");
          inspection.operationProfile = "installation-channel-material-v1";
          inspection.transportProfile = "owned-child-stdio-installation-channel-material-v1";
        }
        inspection = options.native?.(inspection) ?? inspection;
        return inspection;
      },
    },
    registry: {
      async acquire(_native, _command, b, u, op) {
        assert.equal(b, bounds);
        assert.equal(u, unit);
        assert.equal(op, io);
        acquired.push("registry");
        return lease("registry", options.selection?.(structuredClone(selection)) ?? selection);
      },
    },
    registrar: {
      async acquire(_selection, b) {
        assert.equal(b, bounds);
        acquired.push("registrar");
        return lease(
          "registrar",
          options.registration?.(structuredClone(registration)) ?? registration,
        );
      },
    },
    process: {
      async acquire(_selection, _command, b, u, op) {
        assert.equal(b, bounds);
        assert.equal(u, unit);
        assert.equal(op, io);
        acquired.push("process");
        if (options.processWait) await options.processWait();
        return lease("process", options.process?.(structuredClone(observed)) ?? observed);
      },
    },
  };
  const association = {
    startup,
    createEffectRef: binding.createEffectRef,
    recipient,
    registration: selection.registration,
    sourceConfiguration: selection.source,
    endpoints: selection.endpoints,
  };
  const expectedAssociation = options.expectedAssociation
    ? options.expectedAssociation(structuredClone(association))
    : association;
  const reader = (
    options.material
      ? createInstallationServiceMaterialRegistrationReaderV1
      : options.version === 2
        ? createInstallationServiceRegistrationReaderV2
        : createInstallationServiceRegistrationReaderV1
  )(participants, expectedAssociation);
  return {
    reader,
    command,
    bounds,
    original,
    unit,
    io,
    selection,
    registration,
    observed,
    acquired,
    released,
    sourceAbort,
    requestAbort,
    nativeInspection: () => inspection,
    revoke() {
      current = false;
    },
    closeUnit() {
      active = false;
    },
    acquire(input = command, source = original) {
      return reader.acquire(source, input, bounds, unit, io);
    },
  };
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(1);
  }
  assert.fail("Controlled participant did not reach expected boundary");
}

test("exact protected participant correspondence retains and releases original leases", async () => {
  const f = fixture(),
    lease = await f.acquire();
  assert.equal(lease.assertCurrent(), undefined);
  assert.deepEqual(f.acquired, ["registry", "registrar", "process"]);
  assert.deepEqual(f.released, []);
  await lease.release();
  await lease.release();
  assert.deepEqual(f.released, ["process", "registrar", "registry"]);
  assert.throws(() => lease.assertCurrent(), /unavailable/);
});

test("foreign native object denies before any registration or process provider", async () => {
  const f = fixture();
  await assert.rejects(f.acquire(f.command, { ...f.original }), /unavailable/);
  assert.deepEqual(f.acquired, []);
});

test("wrong purpose and accessor commands never reach providers", async () => {
  const f = fixture();
  await assert.rejects(f.acquire({ ...f.command, kind: "withdraw" }), /unavailable/);
  const bad = { ...f.command };
  Object.defineProperty(bad, "operationRef", {
    enumerable: true,
    get() {
      throw new Error("raw provider detail");
    },
  });
  await assert.rejects(
    f.acquire(bad),
    (e) => e.message === "Installation service registration unavailable",
  );
  assert.deepEqual(f.acquired, []);
});

test("wrong parent, duplicate entry and incomplete enumeration all refuse", async (t) => {
  for (const change of [
    (v) => {
      v.entries[0].parentId = "spiffe://example.test/other-parent";
      return v;
    },
    (v) => {
      v.entries.push(structuredClone(v.entries[0]));
      return v;
    },
    (v) => {
      v.coverage = "partial";
      return v;
    },
    (v) => {
      v.entries[0].selectors.push(v.entries[0].selectors[0]);
      return v;
    },
  ]) {
    await t.test("registration mismatch", async () => {
      const f = fixture({ registration: change });
      await assert.rejects(f.acquire(), /unavailable/);
      assert.deepEqual(f.acquired, ["registry", "registrar"]);
      assert.deepEqual(f.released, ["registrar", "registry"]);
    });
  }
});

test("same-Pod execution replacement cannot inherit recipient correspondence", async () => {
  const f = fixture({
    process(v) {
      v.identity.executionIncarnationRef = "replacement";
      return v;
    },
  });
  await assert.rejects(f.acquire(), /unavailable/);
  assert.deepEqual(f.released, ["process", "registrar", "registry"]);
});

test("original compute and execution observation clocks cannot be repainted", async (t) => {
  for (const change of [
    (v) => {
      v.observation.observedAt = new Date(Date.now() - 1000).toISOString();
      return v;
    },
    (v) => {
      v.executionObservation.observedAtMs -= 20000;
      v.executionObservation.expiresAtMs -= 20000;
      return v;
    },
    (v) => {
      v.observedAtMs += 20000;
      v.expiresAtMs += 20000;
      return v;
    },
  ]) {
    await t.test("wrong original observation time", async () => {
      const f = fixture({ process: change });
      await assert.rejects(f.acquire(), /unavailable/);
      assert.deepEqual(f.released, ["process", "registrar", "registry"]);
    });
  }
});

test("native revocation joins a late provider lease instead of dropping it", async () => {
  let settle;
  const gate = new Promise((resolve) => {
    settle = resolve;
  });
  const f = fixture({ processWait: () => gate });
  let done = false;
  const acquiring = f.acquire().then(
    () => {
      done = true;
    },
    (e) => {
      done = true;
      throw e;
    },
  );
  void acquiring.catch(() => undefined);
  await until(() => f.acquired.includes("process"));
  f.sourceAbort.abort();
  await delay(5);
  assert.equal(done, false);
  assert.deepEqual(f.released, []);
  settle();
  await assert.rejects(acquiring, /unavailable/);
  assert.deepEqual(f.released, ["process", "registrar", "registry"]);
});

test("current-writer loss invalidates a retained lease and preserves reverse cleanup", async () => {
  const f = fixture(),
    lease = await f.acquire();
  f.revoke();
  assert.throws(() => lease.assertCurrent(), /unavailable/);
  await lease.release();
  assert.deepEqual(f.released, ["process", "registrar", "registry"]);
});

test("thenable provider fence is refused, observed and joined", async () => {
  const f = fixture({
    fence(name) {
      if (name === "registrar") return Promise.reject(new Error("unsafe detail"));
    },
  });
  await assert.rejects(
    f.acquire(),
    (e) => e.message === "Installation service registration unavailable",
  );
  assert.deepEqual(f.released, ["registrar", "registry"]);
});

test("release failure is sanitized while every original closer is attempted", async () => {
  const f = fixture({
    async release(name) {
      if (name === "process") throw new Error("unsafe close detail");
    },
  });
  const lease = await f.acquire();
  await assert.rejects(
    lease.release(),
    (e) => e.message === "Installation service registration unavailable",
  );
  assert.deepEqual(f.released, ["process", "registrar", "registry"]);
});

test("missing captured producers returns unavailable, without a synthetic positive", async () => {
  const reader = createInstallationServiceRegistrationReaderV1(undefined);
  await assert.rejects(reader.acquire({}, {}, {}, {}, {}), /unavailable/);
});

test("asynchronous native inspector is denied and its rejection is observed", async () => {
  const f = fixture({
    inspect() {
      return Promise.reject(new Error("unsafe native detail"));
    },
  });
  await assert.rejects(
    f.acquire(),
    (error) => error.message === "Installation service registration unavailable",
  );
  assert.deepEqual(f.acquired, []);
  assert.deepEqual(f.released, []);
});

function genuinePhase(query = async () => ({ rows: [], rowCount: 0 })) {
  const lifetime = new RepositoryTransactionLifetime();
  const phase = new GatewayStartupOwnerPhaseV1(lifetime, query);
  // The actual phase/lifetime is used; no backend is called by this consumer test.
  const unit = { installationId: "installation-one", phase, backend: {}, policy: {} };
  const completion = {
    kind: "commit",
    provisional: {
      kind: "not-observed",
      operation: {
        installationId: "installation-one",
        operationRef: "read-one",
        operationDigest: "c".repeat(64),
        startup: null,
      },
    },
  };
  return { lifetime, phase, unit, completion };
}

async function acquireInPhase(p, options = {}) {
  let fixtureValue, lease, originalIo;
  await p.phase.runOperation("registration", async (io) => {
    originalIo = io;
    fixtureValue = fixture({ ...options, unit: p.unit, io });
    lease = await fixtureValue.acquire();
    p.phase.retainCleanup(lease.release);
    p.phase.retainCurrentness(lease.assertCurrent);
  });
  return { f: fixtureValue, lease, originalIo };
}

test("genuine Runtime finalization uses retained leases after acquisition scope closes", async () => {
  const p = genuinePhase();
  let value;
  try {
    await p.phase.runCommand(async () => {
      value = await acquireInPhase(p);
      return p.completion;
    });
    await p.phase.drainAccepted();
    // runOperation has really ended; retained currentness must still be valid.
    assert.equal(value.lease.assertCurrent(), undefined);
    assert.deepEqual(p.phase.finalize(), p.completion);
    p.phase.markCommitDispatched();
    p.phase.observeCommitAcknowledgement("COMMIT");
    assert.deepEqual(value.f.released, []);
    await p.phase.finishTerminal("committed");
    assert.deepEqual(value.f.released, ["process", "registrar", "registry"]);
    await value.lease.release();
    assert.deepEqual(value.f.released, ["process", "registrar", "registry"]);
    assert.throws(() => value.lease.assertCurrent(), /unavailable/);
  } finally {
    await p.phase.finishTerminal("rolled-back").catch(() => undefined);
    await p.lifetime.finish();
  }
});

test("genuine Runtime retains invalidated participant leases through pending outer query", async () => {
  let settle,
    queryStarted = false;
  const queryResult = new Promise((resolve) => {
    settle = resolve;
  });
  const p = genuinePhase(async () => {
    queryStarted = true;
    return queryResult;
  });
  let value;
  const command = p.phase.runCommand(async () => {
    value = await acquireInPhase(p);
    await p.phase.runOperation("later original operation", async (io) => {
      await io.query("controlled original query");
    });
    return p.completion;
  });
  void command.catch(() => undefined);
  try {
    await until(() => queryStarted);
    value.f.sourceAbort.abort();
    assert.throws(() => value.lease.assertCurrent(), /unavailable/);
    await delay(5);
    assert.deepEqual(value.f.released, []);
    settle({ rows: [], rowCount: 0 });
    await command;
    await p.phase.drainAccepted();
    assert.throws(() => p.phase.finalize(), /unavailable/);
    assert.deepEqual(value.f.released, []);
    await assert.rejects(p.phase.finishTerminal("rolled-back"), /unavailable/);
    assert.deepEqual(value.f.released, ["process", "registrar", "registry"]);
  } finally {
    settle({ rows: [], rowCount: 0 });
    await command.catch(() => undefined);
    await p.phase.finishTerminal("rolled-back").catch(() => undefined);
    await p.lifetime.finish();
  }
});

test("genuine Runtime commit-unknown cleanup retains failed currentness and attempts every closer", async () => {
  const p = genuinePhase();
  let value;
  try {
    await p.phase.runCommand(async () => {
      value = await acquireInPhase(p, {
        async release(name) {
          if (name === "process") throw new Error("controlled private close failure");
        },
      });
      return p.completion;
    });
    await p.phase.drainAccepted();
    assert.deepEqual(p.phase.finalize(), p.completion);
    p.phase.markCommitDispatched();
    // Original COMMIT may be pending; no acknowledgement or terminal cleanup yet.
    value.f.revoke();
    assert.throws(() => value.lease.assertCurrent(), /unavailable/);
    await delay(5);
    assert.deepEqual(value.f.released, []);
    await assert.rejects(
      p.phase.finishTerminal("commit-unknown"),
      (error) => error.message === "Installation service registration unavailable",
    );
    assert.deepEqual(value.f.released, ["process", "registrar", "registry"]);
    await assert.rejects(value.lease.release(), /unavailable/);
    assert.deepEqual(value.f.released, ["process", "registrar", "registry"]);
  } finally {
    await p.phase.finishTerminal("commit-unknown").catch(() => undefined);
    await p.lifetime.finish();
  }
});

test("fixed complete association is rechecked against protected current selection", async (t) => {
  for (const [field, change] of [
    [
      "gateway service",
      (v) => {
        v.endpoints.gateway.serviceRef = "other-gateway-service";
      },
    ],
    [
      "controller service",
      (v) => {
        v.endpoints.controller.serviceRef = "other-controller";
        v.endpoints.transportRecipientRef = "other-controller";
      },
    ],
    [
      "transport recipient",
      (v) => {
        v.endpoints.transportRecipientRef = "other-recipient";
      },
    ],
    [
      "Source configuration version",
      (v) => {
        v.source.recordVersion++;
      },
    ],
    [
      "registration version",
      (v) => {
        v.registration.recordVersion++;
      },
    ],
    [
      "canonical create effect",
      (v) => {
        v.binding.createEffectRef = "other-effect";
      },
    ],
    [
      "missing endpoint references",
      (v) => {
        delete v.endpoints;
      },
    ],
    [
      "extra endpoint field",
      (v) => {
        v.endpoints.gateway.extra = "not-in-association";
      },
    ],
  ]) {
    await t.test(field, async () => {
      const f = fixture({
        selection(value) {
          change(value);
          return value;
        },
      });
      await assert.rejects(f.acquire(), /unavailable/);
      assert.deepEqual(f.released, ["registry"]);
      assert.deepEqual(f.acquired, ["registry"]);
    });
  }
});

test("expected association is closed fixed configuration and missing selection is unavailable", async () => {
  assert.throws(
    () =>
      fixture({
        expectedAssociation(value) {
          value.extra = "not-allowed";
          return value;
        },
      }),
    /unavailable/,
  );
  const f = fixture({
    expectedAssociation() {
      return undefined;
    },
  });
  await assert.rejects(f.acquire(), /unavailable/);
  assert.deepEqual(f.acquired, []);
});

test("native tuple and selected source record are independently mapped with distinct versions", async () => {
  const f = fixture();
  assert.notEqual(f.selection.source.recordRef, f.selection.nativeConfiguration.sourceRef);
  assert.notEqual(
    f.selection.source.recordVersion,
    f.selection.nativeConfiguration.configurationVersion,
  );
  const lease = await f.acquire();
  lease.assertCurrent();
  await lease.release();
  assert.deepEqual(f.acquired, ["registry", "registrar", "process"]);
});

test("selected native configuration requires every exact original tuple operand", async (t) => {
  const mutations = [
    [
      "missing tuple",
      (v) => {
        delete v.nativeConfiguration;
      },
    ],
    [
      "source identifier",
      (v) => {
        v.nativeConfiguration.sourceRef = "different-native-source";
      },
    ],
    [
      "bootstrap version",
      (v) => {
        v.nativeConfiguration.configurationVersion++;
      },
    ],
    [
      "source configuration digest",
      (v) => {
        v.nativeConfiguration.sourceConfigurationDigest = "sha256:" + "e".repeat(64);
      },
    ],
    [
      "record reference is not native source",
      (v) => {
        v.nativeConfiguration.sourceRef = v.source.recordRef;
      },
    ],
    [
      "record version is not native version",
      (v) => {
        v.nativeConfiguration.configurationVersion = v.source.recordVersion;
      },
    ],
    [
      "extra tuple field",
      (v) => {
        v.nativeConfiguration.claimedCurrent = true;
      },
    ],
    [
      "malformed digest",
      (v) => {
        v.nativeConfiguration.sourceConfigurationDigest = "d".repeat(64);
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const f = fixture({
        selection(value) {
          mutate(value);
          return value;
        },
      });
      await assert.rejects(f.acquire(), /Installation service registration unavailable/);
      assert.deepEqual(f.acquired, ["registry"]);
      assert.deepEqual(f.released, ["registry"]);
    });
  }
});

test("native original inspection rejects legacy reference-only and malformed configuration", async (t) => {
  const mutations = [
    [
      "legacy source only",
      (v) => {
        v.source = v.expectedSourceConfiguration;
        delete v.expectedSourceConfiguration;
        delete v.nativeConfiguration;
      },
    ],
    [
      "missing expected association record",
      (v) => {
        delete v.expectedSourceConfiguration;
      },
    ],
    [
      "missing actual child tuple",
      (v) => {
        delete v.nativeConfiguration;
      },
    ],
    [
      "unbounded source ref",
      (v) => {
        v.nativeConfiguration.sourceRef = "s".repeat(513);
      },
    ],
    [
      "source ref control",
      (v) => {
        v.nativeConfiguration.sourceRef = "native\nsource";
      },
    ],
    [
      "invalid original version",
      (v) => {
        v.nativeConfiguration.configurationVersion = 0;
      },
    ],
    [
      "invalid original digest",
      (v) => {
        v.nativeConfiguration.sourceConfigurationDigest = "claimed";
      },
    ],
    [
      "extra tuple authority flag",
      (v) => {
        v.nativeConfiguration.verified = true;
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const f = fixture({
        native(value) {
          mutate(value);
          return value;
        },
      });
      await assert.rejects(f.acquire(), /Installation service registration unavailable/);
      assert.deepEqual(f.acquired, []);
    });
  }
});

test("native tuple change during a pending original provider invalidates and joins its lease", async () => {
  let resume;
  const wait = new Promise((resolve) => {
    resume = resolve;
  });
  const f = fixture({ processWait: () => wait });
  const result = f.acquire();
  await until(() => f.acquired.includes("process"));
  f.nativeInspection().nativeConfiguration.configurationVersion++;
  resume();
  await assert.rejects(result, /Installation service registration unavailable/);
  assert.deepEqual(f.released, ["process", "registrar", "registry"]);
});

test("retained tuple invalidation denies without releasing before owner terminal cleanup", async () => {
  const f = fixture();
  const lease = await f.acquire();
  f.closeUnit();
  lease.assertCurrent();
  f.nativeInspection().nativeConfiguration.sourceConfigurationDigest = "sha256:" + "e".repeat(64);
  assert.throws(() => lease.assertCurrent(), /Installation service registration unavailable/);
  assert.deepEqual(f.released, []);
  await lease.release();
  assert.deepEqual(f.released, ["process", "registrar", "registry"]);
});

test("separate material reader uses the same current registration/process leases", async () => {
  const f = fixture({ material: true });
  const lease = await f.acquire();
  assert.equal(lease.assertCurrent(), undefined);
  assert.deepEqual(f.acquired, ["registry", "registrar", "process"]);
  f.closeUnit();
  assert.equal(lease.assertCurrent(), undefined);
  f.sourceAbort.abort();
  assert.throws(() => lease.assertCurrent(), /unavailable/);
  assert.deepEqual(f.released, []);
  await lease.release();
  assert.deepEqual(f.released, ["process", "registrar", "registry"]);
});
for (const [name, change] of [
  [
    "missing selected material purpose",
    (v) => {
      delete v.material;
    },
  ],
  [
    "wrong purpose",
    (v) => {
      v.material.purpose = "read-current";
    },
  ],
  [
    "wrong selected use",
    (v) => {
      v.material.use = "teams-invocation-token";
    },
  ],
  [
    "wrong consumed operation",
    (v) => {
      v.material.consumedClaim.operationRef = "other";
    },
  ],
  [
    "wrong consumed digest",
    (v) => {
      v.material.consumedClaim.operationDigest = "e".repeat(64);
    },
  ],
  [
    "wrong consumed record",
    (v) => {
      v.material.consumedClaim.afterRecordVersion++;
    },
  ],
  [
    "extra selected flag",
    (v) => {
      v.material.verified = true;
    },
  ],
  [
    "wrong native source tuple",
    (v) => {
      v.nativeConfiguration.configurationVersion++;
    },
  ],
])
  test("material " + name + " denies before external registrar/process reads", async () => {
    const f = fixture({
      material: true,
      selection(value) {
        change(value);
        return value;
      },
    });
    await assert.rejects(f.acquire(), /unavailable/);
    assert.deepEqual(f.acquired, ["registry"]);
    assert.deepEqual(f.released, ["registry"]);
  });
for (const [name, change] of [
  [
    "old startup profile",
    (v) => {
      v.operationProfile = "installation-gateway-startup-v1";
    },
  ],
  [
    "old startup transport",
    (v) => {
      v.transportProfile = "owned-child-stdio-installation-gateway-startup-v1";
    },
  ],
  [
    "wrong original request digest",
    (v) => {
      v.requestDigest = "d".repeat(64);
    },
  ],
  [
    "legacy expected source",
    (v) => {
      v.source = v.expectedSourceConfiguration;
      delete v.nativeConfiguration;
    },
  ],
])
  test("material native " + name + " denies before current registry", async () => {
    const f = fixture({
      material: true,
      native(v) {
        change(v);
        return v;
      },
    });
    await assert.rejects(f.acquire(), /unavailable/);
    assert.deepEqual(f.acquired, []);
  });
test("material closed request cannot be cast into an old startup reader", async () => {
  const startup = fixture(),
    material = fixture({ material: true });
  await assert.rejects(startup.acquire(material.command), /unavailable/);
  await assert.rejects(material.acquire(startup.command), /unavailable/);
  assert.deepEqual(startup.acquired, []);
  assert.deepEqual(material.acquired, []);
});
test("material lease survives genuine phase acquisition and waits for terminal cleanup", async () => {
  const p = genuinePhase();
  let value;
  try {
    await p.phase.runCommand(async () => {
      value = await acquireInPhase(p, { material: true });
      return p.completion;
    });
    await p.phase.drainAccepted();
    assert.equal(value.lease.assertCurrent(), undefined);
    assert.deepEqual(p.phase.finalize(), p.completion);
    p.phase.markCommitDispatched();
    value.f.revoke();
    assert.throws(() => value.lease.assertCurrent(), /unavailable/);
    assert.deepEqual(value.f.released, []);
    // Currentness is revoked, but successful owned cleanup is not itself a failed close.
    await p.phase.finishTerminal("commit-unknown");
    assert.deepEqual(value.f.released, ["process", "registrar", "registry"]);
  } finally {
    await p.phase.finishTerminal("commit-unknown").catch(() => undefined);
    await p.lifetime.finish();
  }
});

test("material reader refuses a new deadline beyond the five-second call ceiling", async () => {
  const f = fixture({ material: true });
  const bounds = { ...f.bounds, deadline: new Date(Date.now() + 10000).toISOString() };
  await assert.rejects(
    f.reader.acquire(f.original, f.command, bounds, f.unit, f.io),
    /unavailable/,
  );
  assert.deepEqual(f.acquired, []);
});
test("material native proof correspondence cannot mutate after lease acquisition", async () => {
  const f = fixture({ material: true });
  const lease = await f.acquire();
  f.nativeInspection().requestDigest = "e".repeat(64);
  assert.throws(() => lease.assertCurrent(), /unavailable/);
  assert.deepEqual(f.released, []);
  await lease.release();
  assert.deepEqual(f.released, ["process", "registrar", "registry"]);
});

test("V2 registration retains the exact Agent unit and independent original process observation", async () => {
  const f = fixture({ version: 2 });
  const lease = await f.acquire();
  assert.equal(lease.assertCurrent(), undefined);
  assert.deepEqual(f.acquired, ["registry", "registrar", "process"]);
  f.closeUnit();
  assert.equal(
    lease.assertCurrent(),
    undefined,
    "held provider leases outlive acquisition IO only",
  );
  await lease.release();
  assert.deepEqual(f.released, ["process", "registrar", "registry"]);
  assert.throws(() => lease.assertCurrent());
});
for (const [name, change] of [
  [
    "foreign Agent",
    (selection) => {
      selection.binding.startup.subject.agentRef = "another-agent";
      return selection;
    },
  ],
  [
    "foreign namespace",
    (selection) => {
      selection.binding.startup.subject.namespaceRef = "another-namespace";
      return selection;
    },
  ],
  [
    "V1 locator projection",
    (selection) => {
      selection.binding.startup.installationId = selection.binding.startup.subject.installationId;
      delete selection.binding.startup.subject;
      delete selection.binding.startup.schemaVersion;
      return selection;
    },
  ],
])
  test(`V2 registration refuses ${name} without invoking physical observation`, async () => {
    const f = fixture({ version: 2, selection: change });
    await assert.rejects(f.acquire());
    assert.deepEqual(f.acquired, ["registry"]);
    assert.deepEqual(f.released, ["registry"]);
  });
test("V2 registration does not substitute a matching Pod label for execution identity", async () => {
  const f = fixture({
    version: 2,
    process(value) {
      value.identity.executionIncarnationRef = "foreign-execution";
      return value;
    },
  });
  await assert.rejects(f.acquire());
  assert.deepEqual(f.released, ["process", "registrar", "registry"]);
});
test("V2 registration keeps complete SPIRE-entry coverage and native lifetime required", async () => {
  const ambiguous = fixture({
    version: 2,
    registration(value) {
      value.entries.push(structuredClone(value.entries[0]));
      return value;
    },
  });
  await assert.rejects(ambiguous.acquire());
  assert.deepEqual(ambiguous.released, ["registrar", "registry"]);
  const f = fixture({ version: 2 });
  const lease = await f.acquire();
  f.sourceAbort.abort();
  assert.throws(() => lease.assertCurrent());
  await lease.release();
  assert.deepEqual(f.released, ["process", "registrar", "registry"]);
});
