import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { canonicalGatewayStartupValueV1 } from "../../packages/occ/src/gateway-startup-v1/owner.ts";
import { createGatewayStartupNativeClientV2 } from "../../apps/gateway/src/startup-native-client.ts";
import {
  captureInstalledGatewayLaunchV1,
  captureInstalledGatewayLaunchV2,
  decodeInstalledGatewayLaunchV1,
  decodeInstalledGatewayLaunchV2,
} from "../../apps/gateway/src/installed-launch.ts";
import { binding, consumeCommand } from "../fixtures/gateway-startup-v1/values.mjs";

// These are descriptor grammar fixtures only. No parsed object is an original
// authenticated startup, material lease, installed image or physical process.
const digest = `sha256:${"4".repeat(64)}`;
function descriptor() {
  const selected = binding();
  const command = consumeCommand(
    { record: { binding: selected } },
    { event: { afterHeadVersion: 2 } },
  );
  const own = "spiffe://test.invalid/gateway",
    peer = "spiffe://test.invalid/controller";
  return {
    schemaVersion: 1,
    address: "127.0.0.1:43123",
    configurationVersion: 1,
    binding: selected,
    consumeCommand: command,
    association: {
      startup: selected.startup,
      createEffectRef: selected.createEffectRef,
      recipient: command.recipient,
      registration: { recordRef: "registration-fixture", recordVersion: 1 },
      sourceConfiguration: { recordRef: "source-fixture", recordVersion: 1 },
      endpoints: {
        gateway: { serviceRef: "gateway", spiffeId: own },
        controller: { serviceRef: "controller", spiffeId: peer },
        transportRecipientRef: "controller",
      },
    },
    profile: {
      schemaVersion: 1,
      operationPolicy: "installation-gateway-startup-v1",
      sourceRef: "source-fixture",
      sourceConfigurationDigest: `sha256:${"1".repeat(64)}`,
      workloadApiSocketPath: "/run/spire/workload.sock",
      ownSPIFFEId: own,
      peerSPIFFEId: peer,
      recipientRef: "controller",
      recipientSPIFFEId: peer,
      trustDomain: "test.invalid",
      trustRootsRef: "roots-fixture",
      trustBundleSha256: `sha256:${"2".repeat(64)}`,
      verifierProfileRef: "verifier-fixture",
      nativeExecutableSha256: digest,
      transportProfileRef: "owned-child-stdio-installation-gateway-startup-v1",
      limits: {
        handshakeTimeoutMs: 3000,
        recheckIntervalMs: 1000,
        maxConnectionAgeMs: 30000,
        maxConnections: 1,
        requestTimeoutMs: 3000,
      },
    },
  };
}
const decode = (value) =>
  decodeInstalledGatewayLaunchV1(Buffer.from(JSON.stringify(value)), digest);

test("installed descriptor decoder returns frozen expectations for only the fixed native child", () => {
  const input = descriptor();
  const value = decode(input);
  assert.equal(value.binaryPath, "/usr/local/bin/oce-runtime-authority");
  assert.equal(value.profile.nativeExecutableSha256, digest);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.consumeCommand.recipient));
  input.association.registration.recordRef = "later-caller-mutation";
  assert.equal(value.association.registration.recordRef, "registration-fixture");
  assert.equal(Object.hasOwn(value, "usePort"), false);
});

for (const [name, change] of [
  [
    "binary override",
    (value) => {
      value.binaryPath = "/tmp/caller-command";
    },
  ],
  [
    "module override",
    (value) => {
      value.materialFactory = "file:///tmp/caller.mjs";
    },
  ],
  [
    "different installed digest",
    (value) => {
      value.profile.nativeExecutableSha256 = `sha256:${"5".repeat(64)}`;
    },
  ],
  [
    "foreign startup",
    (value) => {
      value.association.startup = { ...value.binding.startup, processRef: "foreign" };
    },
  ],
  [
    "different recipient",
    (value) => {
      value.association.recipient = {
        ...value.consumeCommand.recipient,
        incarnationRef: "foreign",
      };
    },
  ],
  [
    "unbounded lifetime",
    (value) => {
      value.profile.limits.maxConnectionAgeMs = 60000;
    },
  ],
  [
    "unknown profile property",
    (value) => {
      value.profile.authorized = true;
    },
  ],
  [
    "unselected hostname",
    (value) => {
      value.address = "caller.invalid:43123";
    },
  ],
])
  test(`installed descriptor refuses ${name}`, () => {
    const value = descriptor();
    change(value);
    assert.throws(() => decode(value));
  });

test("installed descriptor refuses duplicate fields and numeric aliases before selecting JSON members", () => {
  const bytes = JSON.stringify(descriptor());
  assert.throws(() =>
    decodeInstalledGatewayLaunchV1(
      Buffer.from(bytes.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
      digest,
    ),
  );
  assert.throws(() =>
    decodeInstalledGatewayLaunchV1(
      Buffer.from(bytes.replace('"schemaVersion":1', '"schemaVersion":1e0')),
      digest,
    ),
  );
});

test("source checkout cannot assert an installed binary or capture caller-supplied startup data", async () => {
  await assert.rejects(
    captureInstalledGatewayLaunchV1(new AbortController().signal),
    /unavailable/,
  );
  await assert.rejects(
    captureInstalledGatewayLaunchV1(new AbortController().signal),
    /unavailable/,
  );
});

function agentDescriptor() {
  const old = descriptor();
  const { installationId: _installation, ...locator } = old.binding.startup;
  const installationId = `ins_${randomUUID()}`;
  const subject = {
    kind: "agent-gateway",
    installationId,
    namespaceRef: `ns_${randomUUID()}`,
    agentRef: `agt_${randomUUID()}`,
  };
  const startup = { schemaVersion: 2, subject, ...locator };
  const binding = {
    ...old.binding,
    schemaVersion: 2,
    startup,
    namespaceRef: subject.namespaceRef,
    agentRef: subject.agentRef,
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
  return {
    ...old,
    schemaVersion: 2,
    binding,
    association: { ...old.association, startup },
    consumeCommand: {
      ...old.consumeCommand,
      schemaVersion: 2,
      subject,
      startup,
      expectedHead: { ...old.consumeCommand.expectedHead, startup },
    },
    harness: {
      schemaVersion: 1,
      transportProfile: "kubernetes-capability-token-websocket-v1",
      assignment: {
        installationRef: installationId,
        namespaceRef: binding.namespaceRef,
        agentRef: binding.agentRef,
        revisionRef: binding.admittedRevisionRef,
        assignmentRef: "harness-fixture",
        gatewayAssignmentRef: binding.gatewayAssignmentRef,
        lifecycleGeneration: 1,
        runtimeGeneration: binding.hostRuntimeGeneration,
        peerIdentity: "peer-fixture",
        transportRef: "transport-fixture",
      },
      endpoint: "ws://harness.fixture.svc:18790/",
      service: {
        namespace: "fixture",
        name: "harness",
        uid: "service-fixture",
        resourceVersion: "1",
        clusterIP: "10.42.0.1",
      },
      secret: {
        namespace: "fixture",
        name: "harness-token",
        uid: "secret-fixture",
        resourceVersion: "1",
        key: "app-server-token",
        sha256: "a".repeat(64),
      },
    },
  };
}
const decodeAgent = (value) =>
  decodeInstalledGatewayLaunchV2(Buffer.from(canonicalGatewayStartupValueV1(value)), digest);

test("installed V2 selection retains exact Agent locator and original Harness metadata", () => {
  const input = agentDescriptor();
  const decoded = decodeAgent(input);
  assert.deepEqual(decoded.binding.startup, input.binding.startup);
  assert.equal(decoded.binding.startup.schemaVersion, 2);
  assert.equal(Object.hasOwn(decoded.binding.startup, "installationId"), false);
  assert.equal(decoded.harness.assignment.agentRef, decoded.binding.agentRef);
  assert.ok(Object.isFrozen(decoded.harness.secret));
  assert.ok(Object.isFrozen(decoded.association.startup.subject));
  assert.equal(Object.hasOwn(decoded, "usePort"), false);
  assert.doesNotThrow(() => createGatewayStartupNativeClientV2(decoded));
  assert.equal(decodeAgent({ ...input, harness: null }).harness, null);
  assert.throws(() =>
    createGatewayStartupNativeClientV2({ ...decoded, consumeCommand: descriptor().consumeCommand }),
  );
  assert.throws(() =>
    decodeInstalledGatewayLaunchV1(Buffer.from(canonicalGatewayStartupValueV1(input)), digest),
  );
  assert.throws(() => decodeAgent(descriptor()));
});

for (const [name, change] of [
  [
    "foreign Agent",
    (value) => {
      value.consumeCommand.subject = { ...value.consumeCommand.subject, agentRef: "foreign" };
    },
  ],
  [
    "foreign namespace association",
    (value) => {
      value.association.startup = {
        ...value.association.startup,
        subject: { ...value.association.startup.subject, namespaceRef: "foreign" },
      };
    },
  ],
  [
    "foreign Harness revision",
    (value) => {
      value.harness.assignment.revisionRef = "foreign";
    },
  ],
  [
    "foreign Harness generation",
    (value) => {
      value.harness.assignment.runtimeGeneration++;
    },
  ],
  [
    "unowned token bytes",
    (value) => {
      value.harness.secret.token = "caller-token";
    },
  ],
  [
    "different image binary",
    (value) => {
      value.profile.nativeExecutableSha256 = `sha256:${"f".repeat(64)}`;
    },
  ],
  [
    "missing explicit Harness slot",
    (value) => {
      delete value.harness;
    },
  ],
])
  test(`installed V2 selection refuses ${name}`, () => {
    const input = agentDescriptor();
    change(input);
    assert.throws(() => decodeAgent(input));
  });

test("V2 allocation bytes must stay canonical and cannot renew the one-shot mounted capture", async () => {
  const input = agentDescriptor();
  assert.throws(() => decodeInstalledGatewayLaunchV2(Buffer.from(JSON.stringify(input)), digest));
  assert.throws(() =>
    decodeInstalledGatewayLaunchV2(
      Buffer.from(canonicalGatewayStartupValueV1(input) + "\n"),
      digest,
    ),
  );
  await assert.rejects(
    captureInstalledGatewayLaunchV2(new AbortController().signal),
    /unavailable/,
  );
});
