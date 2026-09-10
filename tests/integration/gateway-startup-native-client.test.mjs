import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  createGatewayStartupNativeClientV1,
  createGatewayStartupNativeClientV2,
} from "../../apps/gateway/src/startup-native-client.ts";
import { createGatewayStartupServiceSourceV1 } from "../../apps/gateway/src/startup-service-source.ts";
import { createGatewayStartupNativeServiceV1 } from "../../apps/controller/src/admission/gateway-startup-service-context.ts";
import { createGatewayStartupOwnerV1 } from "../../packages/occ/src/gateway-startup-v1/owner.ts";
import { createGatewayInstallationServiceAuthorityV1 } from "../../packages/occ/src/gateway-startup-v1/installation-service.ts";
import {
  availableLoopbackAddress,
  boundedCompletion,
  ownedNativeChildren,
  startFixture,
  testExecutables,
  until,
} from "../fixtures/runtime-authority-native.mjs";

// Actual checked-in TypeScript, Go child, Workload API and mutual TLS. Generated
// fixture identity authenticates transport only. Missing Controller account,
// registration and transaction owners always return unavailable; these cases
// never establish an admitted claim, hosted Gateway readiness or provider use.
async function nativeFixture(t) {
  const binaries = await testExecutables(t);
  const fixture = await startFixture(t, binaries.fixturePath);
  const address = await availableLoopbackAddress();
  const ref = (recordRef) => ({ recordRef, recordVersion: 1 });
  const startup = {
    installationId: `ins_${randomUUID()}`,
    processRef: "process-fixture",
    processGeneration: 1,
    operationRef: "startup-fixture",
    operationDigest: "1".repeat(64),
  };
  const recipient = {
    recipient: ref("recipient-fixture"),
    process: ref("process-fixture"),
    incarnationRef: "incarnation-fixture",
    observation: ref("observation-fixture"),
  };
  const association = {
    startup,
    createEffectRef: "create-fixture",
    recipient,
    registration: ref("registration-fixture"),
    sourceConfiguration: ref("source-fixture"),
    endpoints: {
      gateway: { serviceRef: "service/gateway", spiffeId: fixture.ready.peerSPIFFEId },
      controller: { serviceRef: "service/controller", spiffeId: fixture.ready.ownSPIFFEId },
      transportRecipientRef: "service/controller",
    },
  };
  const profile = {
    schemaVersion: 1,
    operationPolicy: "installation-gateway-startup-v1",
    sourceRef: "source-fixture",
    sourceConfigurationDigest: `sha256:${"1".repeat(64)}`,
    workloadApiSocketPath: fixture.ready.workloadApiSocketPath,
    ownSPIFFEId: fixture.ready.ownSPIFFEId,
    peerSPIFFEId: fixture.ready.peerSPIFFEId,
    recipientRef: "service/controller",
    recipientSPIFFEId: fixture.ready.ownSPIFFEId,
    trustDomain: fixture.ready.trustDomain,
    trustRootsRef: "roots-fixture",
    trustBundleSha256: fixture.ready.trustBundleSha256,
    verifierProfileRef: "verifier-fixture",
    nativeExecutableSha256: binaries.nativeExecutableSha256,
    transportProfileRef: "owned-child-stdio-installation-gateway-startup-v1",
    limits: {
      handshakeTimeoutMs: 3000,
      recheckIntervalMs: 1000,
      maxConnectionAgeMs: 30000,
      maxConnections: 1,
      requestTimeoutMs: 3000,
    },
  };
  const binding = {
    startup,
    createEffectRef: association.createEffectRef,
    selection: ref("selection-fixture"),
    configurationRef: "configuration-fixture",
    configurationVersion: 1,
    profileRef: "profile-fixture",
    profileVersion: 1,
    namespaceRef: `ns_${randomUUID()}`,
    agentRef: `agt_${randomUUID()}`,
    admittedRevisionRef: "revision-fixture",
    gatewayAssignmentRef: "assignment-fixture",
    hostRuntimeGeneration: 1,
    nativeConfigRef: "native-fixture",
    configDigest: `sha256:${"2".repeat(64)}`,
    stateOwnership: ref("state-fixture"),
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    protocolVersion: 1,
    modules: [
      {
        id: "identity",
        kind: "identity",
        profileRef: "identity-fixture",
        requiredCapabilities: [],
      },
    ],
    startupDeadlineMs: 3000,
    shutdownDeadlineMs: 3000,
  };
  const consumeCommand = {
    schemaVersion: 1,
    kind: "consume-startup",
    operationRef: "consume-fixture",
    startup,
    expectedHead: { version: 2, startup, recordVersion: 2 },
    recipient,
  };
  const receiver = createGatewayStartupNativeServiceV1({
    binaryPath: binaries.binaryPath,
    listenAddress: address,
    configurationVersion: 1,
    profile,
    association,
    compose(native) {
      return {
        service: createGatewayInstallationServiceAuthorityV1({
          native,
          account: {
            async consume() {
              throw new Error("Account owner not installed");
            },
          },
          currentness: {
            async consume() {
              throw new Error("Registration owner not installed");
            },
          },
        }),
        owner: createGatewayStartupOwnerV1({}),
      };
    },
  });
  await receiver.start();
  t.after(() => receiver.close());
  const clientOptions = {
    binaryPath: binaries.binaryPath,
    address,
    configurationVersion: 1,
    profile: { ...profile, ownSPIFFEId: profile.peerSPIFFEId, peerSPIFFEId: profile.ownSPIFFEId },
    association,
    binding,
    consumeCommand,
  };
  const producer = createGatewayStartupNativeClientV1(clientOptions);
  return { producer, fixture, receiver, binaries, binding, consumeCommand, clientOptions };
}

test(
  "actual native startup client rechecks and makes sequential unavailable service calls",
  { timeout: 150_000 },
  async (t) => {
    const f = await nativeFixture(t);
    const connection = await f.producer.open(new AbortController().signal);
    t.after(() => connection.close());
    assert.equal(f.producer.assertOriginal(connection), undefined);
    assert.throws(() => f.producer.assertOriginal({ ...connection }), /unavailable/);
    await connection.recheckCurrent();
    await connection.recheckCurrent();
    for (const command of [
      f.consumeCommand,
      {
        schemaVersion: 1,
        kind: "read-current",
        startup: f.binding.startup,
        expectedRecordVersion: 3,
        recipient: f.consumeCommand.recipient,
      },
    ]) {
      // Leave the original inspector active while a legitimate next service
      // call starts. The idle poll uses this same inspector path. Its own work
      // must not turn a sequential application call into terminal contention.
      const checking = connection.recheckCurrent();
      const bounds = {
        requestRef: "fixture-request",
        deadline: new Date(Date.now() + 2500).toISOString(),
        signal: new AbortController().signal,
      };
      const executing = connection.execute(command, bounds);
      // An actual second service call still has no queue or transport dispatch.
      await assert.rejects(connection.execute(command, bounds), /unavailable/);
      const [, result] = await Promise.all([checking, executing]);
      assert.deepEqual(result, { kind: "unavailable" });
      await connection.recheckCurrent();
    }
    await assert.rejects(f.producer.open(new AbortController().signal), /unavailable/);
    const close = connection.close();
    assert.equal(connection.close(), close);
    assert.equal(await close, "finished");
    assert.throws(() => connection.assertCurrent(), /unavailable/);
  },
);

test(
  "actual native client and service Source cannot turn authenticated TLS into a startup claim",
  { timeout: 150_000 },
  async (t) => {
    const f = await nativeFixture(t);
    const source = createGatewayStartupServiceSourceV1(f.producer);
    t.after(() => source.close());
    const original = await source.open();
    assert.ok(
      original,
      "actual native connection should be available before service authorization",
    );
    assert.deepEqual(await source.consume(original), { kind: "unavailable" });
    assert.throws(() => source.assertCurrent(original), /unavailable/);
    assert.equal(await source.open(), undefined);
    await source.close();
  },
);

test(
  "actual Workload API withdrawal ends the client and joins both owned native children",
  { timeout: 150_000 },
  async (t) => {
    const f = await nativeFixture(t);
    const connection = await f.producer.open(new AbortController().signal);
    t.after(() => connection.close());
    assert.equal((await ownedNativeChildren(f.binaries.binaryPath)).length, 2);
    await connection.recheckCurrent();
    // Withdraw generated fixture identity through the actual Workload API source;
    // a manually aborted JavaScript signal is not the revocation being exercised.
    await f.fixture.change("withdraw");
    await until(
      () => connection.signal.aborted,
      "native Source withdrawal did not invalidate client",
      4000,
    );
    assert.throws(() => f.producer.assertOriginal(connection), /unavailable/);
    await assert.rejects(connection.recheckCurrent(), /unavailable/);
    await boundedCompletion(
      Promise.all([connection.close(), f.receiver.close()]),
      5000,
      "native revocation cleanup did not join",
    );
    assert.equal((await ownedNativeChildren(f.binaries.binaryPath)).length, 0);
  },
);

test(
  "actual V2 client preserves Agent command bytes and V1 receiver refuses that separate domain",
  { timeout: 150_000 },
  async (t) => {
    const f = await nativeFixture(t);
    const { installationId, ...locator } = f.binding.startup;
    const subject = {
      kind: "agent-gateway",
      installationId,
      namespaceRef: f.binding.namespaceRef,
      agentRef: f.binding.agentRef,
    };
    const startup = { schemaVersion: 2, subject, ...locator };
    const binding = {
      ...f.binding,
      schemaVersion: 2,
      startup,
      selection: {
        manifestRef: randomUUID(),
        manifestDigest: `sha256:${"1".repeat(64)}`,
        admissionRef: randomUUID(),
        admissionVersion: 1,
      },
      profileRefs: Object.fromEntries(
        ["provider", "runtime", "identity", "containment", "storage"].map((kind) => [
          kind,
          { ref: randomUUID(), version: 1, contentDigest: `sha256:${"2".repeat(64)}` },
        ]),
      ),
      admittedConfigurationDigest: `sha256:${"3".repeat(64)}`,
    };
    const consumeCommand = {
      ...f.consumeCommand,
      schemaVersion: 2,
      subject,
      startup,
      expectedHead: { ...f.consumeCommand.expectedHead, startup },
    };
    const producer = createGatewayStartupNativeClientV2({
      ...f.clientOptions,
      binding,
      consumeCommand,
      association: { ...f.clientOptions.association, startup },
    });
    const connection = await producer.open(new AbortController().signal);
    t.after(() => connection.close());
    assert.equal(producer.assertOriginal(connection), undefined);
    assert.deepEqual(connection.binding.startup.subject, subject);
    await connection.recheckCurrent();
    assert.equal(f.receiver.signal.aborted, false);
    // The real Go transport supports the unchanged closed outer method envelope;
    // it must carry the full inner V2 command to the V1 server, which refuses it.
    // TLS and Inspect success therefore confer no V2 service/account authority.
    await assert.rejects(
      connection.execute(consumeCommand, {
        requestRef: "v2-fixture-request",
        deadline: new Date(Date.now() + 2500).toISOString(),
        signal: new AbortController().signal,
      }),
      /unavailable/,
    );
    await until(
      () => f.receiver.signal.aborted,
      "V1 server did not refuse the V2 command domain",
      4000,
    );
    await boundedCompletion(
      Promise.all([connection.close(), f.receiver.close()]),
      5000,
      "V2 refusal did not join original children",
    );
    assert.equal((await ownedNativeChildren(f.binaries.binaryPath)).length, 0);
    await assert.rejects(producer.open(new AbortController().signal), /unavailable/);
  },
);

for (const loss of ["wall-deadline", "monotonic-deadline", "external-abort"]) {
  test(
    `actual native result copy checks original ${loss} immediately before disclosure`,
    { timeout: 150_000 },
    async (t) => {
      const f = await nativeFixture(t);
      const connection = await f.producer.open(new AbortController().signal);
      t.after(() => connection.close());
      await connection.recheckCurrent();
      const callAbort = new AbortController();
      const deadline = Date.now() + 500;
      const monotonicStart = performance.now();
      assert.ok(connection.expiresAtMs > deadline + 1000);
      const originalParse = JSON.parse;
      let observed = 0;
      let connectionCurrentObserved = false;
      // Observe only the final copy of the actual native service payload. The
      // original parser and real Go/TLS exchange remain in use; no result or
      // authority callback is substituted. Connection lifetime stays longer
      // than this call so its ordinary currentness gate cannot stand in for it.
      t.mock.method(JSON, "parse", function (...args) {
        const value = originalParse.apply(this, args);
        const stack = new Error().stack ?? "";
        if (
          args[0] === '{"kind":"unavailable"}' &&
          /\bat copy \(/u.test(stack) &&
          stack.includes("/apps/gateway/src/startup-native-client.ts")
        ) {
          observed++;
          if (loss === "wall-deadline") t.mock.method(Date, "now", () => deadline + 1);
          if (loss === "monotonic-deadline")
            t.mock.method(performance, "now", () => monotonicStart + 600);
          if (loss === "external-abort") callAbort.abort();
          else {
            assert.equal(connection.assertCurrent(), undefined);
            connectionCurrentObserved = true;
          }
        }
        return value;
      });
      try {
        await assert.rejects(
          connection.execute(f.consumeCommand, {
            requestRef: "final-native-result-fixture",
            deadline: new Date(deadline).toISOString(),
            signal: callAbort.signal,
          }),
          /unavailable/,
        );
        assert.equal(observed, 1, "the real final result-copy boundary must be exercised");
        if (loss !== "external-abort") assert.equal(connectionCurrentObserved, true);
      } finally {
        t.mock.restoreAll();
        await boundedCompletion(
          Promise.all([connection.close(), f.receiver.close()]),
          5000,
          "final-result refusal did not join original native children",
        );
      }
      assert.equal((await ownedNativeChildren(f.binaries.binaryPath)).length, 0);
      await assert.rejects(f.producer.open(new AbortController().signal), /unavailable/);
    },
  );
}
