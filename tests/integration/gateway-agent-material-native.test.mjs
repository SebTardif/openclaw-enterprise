import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayChannelMaterialClientV2 } from "../../apps/gateway/src/channel-material-client.ts";
import { createChannelMaterialNativeServiceV2 } from "../../apps/controller/src/admission/channel-material-service-context.ts";
import { createGatewayMaterialDeliveryV2 } from "../../packages/occ/src/gateway-startup-v1/material-delivery.ts";
import { controlledAgentBootstrap } from "../fixtures/gateway-startup-v2/local-bootstrap.mjs";
import {
  availableLoopbackAddress,
  boundedCompletion,
  ownedNativeChildren,
  startFixture,
  testExecutables,
} from "../fixtures/runtime-authority-native.mjs";

// Actual checked-in TypeScript endpoints, Go child, Workload API and mutual TLS.
// Startup/registration/account/current selection and selected payload are controlled
// peers. A successful byte exchange qualifies transport only, never live material,
// accepted workload capabilities, a real account gate or hosted readiness.
for (const [deliver, expireAtResult, outcome] of [
  [false, false, "retains missing-owner refusal"],
  [true, false, "joins a controlled disclosure"],
  [false, "freeze", "refuses expiry at the final result boundary"],
  [false, "parent", "refuses expiry during the final parent observation"],
])
  test(
    `actual Agent material TLS carries the exact V2 request and ${outcome}`,
    { timeout: 150000 },
    async (t) => {
      const binaries = await testExecutables(t);
      const identity = await startFixture(t, binaries.fixturePath);
      const address = await availableLoopbackAddress();
      let expireDuringParent;
      const f = controlledAgentBootstrap(
        expireAtResult === "parent"
          ? {
              nativeFence() {
                expireDuringParent?.();
              },
            }
          : {},
      );
      t.after(() => f.bootstrap.close());
      assert.ok(await f.bootstrap.enroll());
      const request = f.service.materialRequest(f.handle, "startup-slack-pair");
      const ref = (recordRef) => ({ recordRef, recordVersion: 1 });
      const association = {
        startup: f.binding.startup,
        createEffectRef: f.binding.createEffectRef,
        recipient: f.record.claim.recipient,
        registration: ref("registration"),
        sourceConfiguration: ref("source"),
        endpoints: {
          gateway: { serviceRef: "service/gateway", spiffeId: identity.ready.peerSPIFFEId },
          controller: { serviceRef: "service/controller", spiffeId: identity.ready.ownSPIFFEId },
          transportRecipientRef: "service/controller",
        },
      };
      const profile = {
        schemaVersion: 1,
        operationPolicy: "installation-channel-material-v1",
        sourceRef: "source",
        sourceConfigurationDigest: `sha256:${"1".repeat(64)}`,
        workloadApiSocketPath: identity.ready.workloadApiSocketPath,
        ownSPIFFEId: identity.ready.ownSPIFFEId,
        peerSPIFFEId: identity.ready.peerSPIFFEId,
        recipientRef: "service/controller",
        recipientSPIFFEId: identity.ready.ownSPIFFEId,
        trustDomain: identity.ready.trustDomain,
        trustRootsRef: "roots",
        trustBundleSha256: identity.ready.trustBundleSha256,
        verifierProfileRef: "verifier",
        nativeExecutableSha256: binaries.nativeExecutableSha256,
        transportProfileRef: "owned-child-stdio-installation-channel-material-v1",
        limits: {
          handshakeTimeoutMs: 3000,
          recheckIntervalMs: 1000,
          maxConnectionAgeMs: 5000,
          maxConnections: 1,
          requestTimeoutMs: 5000,
        },
      };
      const abort = new AbortController();
      const events = [];
      let native, registration;
      const receiver = createChannelMaterialNativeServiceV2({
        binaryPath: binaries.binaryPath,
        listenAddress: address,
        configurationVersion: 1,
        profile,
        association,
        deadline: new Date(Date.now() + 4900).toISOString(),
        signal: abort.signal,
        compose(source, original) {
          native = source;
          registration = original;
          return createGatewayMaterialDeliveryV2({
            native: source,
            current: {
              async withCurrent(value, actualNative, bounds, work) {
                assert.deepEqual(value, request);
                const proof = original.originalFor(value, bounds);
                assert.ok(proof);
                const inspected = original.inspectOriginal(proof, value, bounds);
                assert.ok(inspected);
                assert.equal(inspected.assertCurrent(), undefined);
                assert.equal(inspected.operationProfile, "installation-channel-material-v1");
                assert.equal(inspected.gatewaySpiffeId, identity.ready.peerSPIFFEId);
                assert.equal(actualNative.assertCurrent(), undefined);
                events.push("current");
                if (!deliver)
                  throw new Error("No original account/material-purpose owner installed");
                return await work({
                  current: f.record,
                  selected: Object.freeze({ fixture: true }),
                  signal: bounds.signal,
                  assertCurrent: () => actualNative.assertCurrent(),
                  remainingMs: () => actualNative.remainingMs(),
                  async recheckCurrent() {
                    actualNative.assertCurrent();
                  },
                  async confirmDisclosure() {
                    actualNative.assertCurrent();
                    events.push("confirm");
                  },
                });
              },
            },
            source: {
              async readSelected(scope) {
                scope.assertCurrent();
                events.push("read");
                return {
                  signal: scope.signal,
                  assertCurrent: () => scope.assertCurrent(),
                  remainingMs: () => scope.remainingMs(),
                  async withEncodedPayload(work) {
                    return await work({
                      byteLength: 3,
                      backingByteLength: 3,
                      encodeInto(target) {
                        scope.assertCurrent();
                        events.push("encode");
                        target.set([1, 2, 3]);
                      },
                    });
                  },
                  async release() {
                    events.push("release");
                  },
                };
              },
            },
          });
        },
      });
      t.after(() => receiver.close());
      await receiver.start();
      const producer = createGatewayChannelMaterialClientV2(f.service, {
        binaryPath: binaries.binaryPath,
        address,
        configurationVersion: 1,
        association,
        profile: {
          ...profile,
          ownSPIFFEId: profile.peerSPIFFEId,
          peerSPIFFEId: profile.ownSPIFFEId,
        },
      });
      const bounds = {
        requestRef: "material",
        deadline: new Date(Date.now() + 3000).toISOString(),
        signal: abort.signal,
      };
      assert.equal(await native.inspect({}, request, bounds), undefined);
      assert.equal(registration.originalFor(request, bounds), undefined);
      const connection = await producer.open(f.handle, request, bounds);
      t.after(() => connection.close());
      assert.deepEqual(connection.request, request);
      assert.throws(() => producer.assertOriginal({ ...connection }));
      let received = 0;
      let frozen = 0;
      let parentObservations = 0;
      const originalFreeze = Object.freeze;
      const now = Date.now;
      if (expireAtResult)
        t.mock.method(Object, "freeze", (value) => {
          const result = Reflect.apply(originalFreeze, Object, [value]);
          if (
            value &&
            typeof value === "object" &&
            Object.keys(value).join() === "kind" &&
            value.kind === "unavailable" &&
            new Error().stack?.includes("/apps/gateway/src/channel-material-client.ts")
          ) {
            frozen++;
            const expire = () => {
              t.mock.method(Date, "now", () => Date.parse(bounds.deadline) + 1);
            };
            if (expireAtResult === "parent") {
              // The local gate must pass before the original parent callback
              // expires this shorter material call. The startup Source remains
              // current; its successful observation cannot extend the call.
              expireDuringParent = () => {
                expireDuringParent = undefined;
                parentObservations++;
                assert.equal(Date.now, now);
                assert.ok(Date.now() < Date.parse(bounds.deadline));
                assert.ok(Date.parse(bounds.deadline) + 1 < f.connection.expiresAtMs);
                expire();
              };
            } else expire();
          }
          return result;
        });
      const work = connection.withPayload(async (header, bytes) => {
        received++;
        assert.equal(deliver, true);
        assert.equal(header.schemaVersion, 1); // Independent unchanged binary response header.
        assert.equal(header.kind, "selected-bundle");
        assert.deepEqual([...bytes], [1, 2, 3]);
        assert.equal(connection.assertCurrent(), undefined);
        events.push("consume");
        return undefined;
      });
      try {
        if (expireAtResult) {
          await assert.rejects(work, /unavailable/);
          assert.equal(frozen, 1);
          assert.equal(parentObservations, expireAtResult === "parent" ? 1 : 0);
          assert.notEqual(Date.now, now);
          assert.equal(Date.now(), Date.parse(bounds.deadline) + 1);
          if (expireAtResult === "parent")
            assert.equal(f.service.assertCurrent(f.handle), undefined);
        } else assert.deepEqual(await work, { kind: deliver ? "delivered" : "unavailable" });
      } finally {
        t.mock.restoreAll();
      }
      assert.equal(Date.now, now);
      assert.equal(received, deliver ? 1 : 0);
      if (!expireAtResult) assert.equal(connection.assertCurrent(), undefined);
      await boundedCompletion(
        Promise.all([connection.close(), receiver.close()]),
        5000,
        "Original material children did not join",
      );
      assert.equal((await ownedNativeChildren(binaries.binaryPath)).length, 0);
      assert.deepEqual(
        events,
        deliver ? ["current", "read", "encode", "confirm", "consume", "release"] : ["current"],
      );
    },
  );
