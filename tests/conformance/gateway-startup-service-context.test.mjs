import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import {
  closeNativeChild,
  nativeChildExit,
} from "../../apps/controller/src/admission/native-child-lifetime.ts";
import {
  consumeNativeFrames,
  nativeDigest,
  writeNativeFrame,
} from "../../apps/controller/src/admission/runtime-authority-wire.ts";
import { createGatewayStartupNativeServiceV1 } from "../../apps/controller/src/admission/gateway-startup-service-context.ts";
import {
  createGatewayStartupOwnerV1,
  parseGatewayStartupCommandV1,
} from "../../packages/occ/src/gateway-startup-v1/owner.ts";
import { createGatewayInstallationServiceAuthorityV1 } from "../../packages/occ/src/gateway-startup-v1/installation-service.ts";

// This suite exercises closed construction and actual foreign-proof denials.
// Authentic native Source/TLS/pipe accepting paths use the separate Go fixture;
// these synthetic values never supply registration, a service grant or a claim.
function fixture() {
  const digest = `sha256:${"1".repeat(64)}`;
  const record = (recordRef) => ({ recordRef, recordVersion: 1 });
  const startup = {
    installationId: "ins_11111111-1111-4111-8111-111111111111",
    processRef: "process/gateway",
    processGeneration: 1,
    operationRef: "operation/startup",
    operationDigest: "1".repeat(64),
  };
  const recipient = {
    recipient: record("recipient/gateway"),
    process: record("process/gateway"),
    incarnationRef: "incarnation/gateway",
    observation: record("observation/gateway"),
  };
  const association = {
    startup,
    createEffectRef: "effect/create",
    recipient,
    registration: record("registration/gateway"),
    sourceConfiguration: record("source/gateway"),
    endpoints: {
      gateway: { serviceRef: "service/gateway", spiffeId: "spiffe://gateway.test/service/gateway" },
      controller: {
        serviceRef: "service/controller",
        spiffeId: "spiffe://gateway.test/service/controller",
      },
      transportRecipientRef: "service/controller",
    },
  };
  const profile = {
    schemaVersion: 1,
    operationPolicy: "installation-gateway-startup-v1",
    sourceRef: "source/gateway",
    sourceConfigurationDigest: digest,
    workloadApiSocketPath: "/nonexistent-gateway-fixture/api.sock",
    ownSPIFFEId: association.endpoints.controller.spiffeId,
    peerSPIFFEId: association.endpoints.gateway.spiffeId,
    recipientRef: "service/controller",
    recipientSPIFFEId: association.endpoints.controller.spiffeId,
    trustDomain: "gateway.test",
    trustRootsRef: "roots/gateway",
    trustBundleSha256: digest,
    verifierProfileRef: "verifier/gateway",
    nativeExecutableSha256: digest,
    transportProfileRef: "owned-child-stdio-installation-gateway-startup-v1",
    limits: {
      handshakeTimeoutMs: 3000,
      recheckIntervalMs: 1000,
      maxConnectionAgeMs: 30000,
      maxConnections: 1,
      requestTimeoutMs: 3000,
    },
  };
  const input = {
    schemaVersion: 1,
    kind: "read-current",
    startup,
    expectedRecordVersion: 1,
    recipient,
  };
  let native,
    registrationNative,
    service,
    compositionCount = 0,
    accountCalls = 0;
  const options = {
    binaryPath: "/nonexistent-gateway-fixture/oce-runtime-authority",
    listenAddress: "127.0.0.1:1",
    configurationVersion: 1,
    profile,
    association,
    compose(source, registration) {
      compositionCount++;
      native = source;
      registrationNative = registration;
      service = createGatewayInstallationServiceAuthorityV1({
        native: source,
        account: {
          async consume() {
            accountCalls++;
            throw new Error("No account participant selected");
          },
        },
        currentness: {
          async consume() {
            throw new Error("No registration/currentness producer selected");
          },
        },
      });
      return { service, owner: createGatewayStartupOwnerV1({}) };
    },
  };
  return {
    options,
    input,
    get native() {
      return native;
    },
    get registrationNative() {
      return registrationNative;
    },
    get service() {
      return service;
    },
    get compositionCount() {
      return compositionCount;
    },
    get accountCalls() {
      return accountCalls;
    },
  };
}

test("actual source and service reject all foreign proof objects without a child", async () => {
  const f = fixture();
  const receiver = createGatewayStartupNativeServiceV1(f.options);
  assert.deepEqual(parseGatewayStartupCommandV1(f.input), f.input);
  const bounds = {
    requestRef: "request/foreign",
    deadline: new Date(Date.now() + 2000).toISOString(),
    signal: new AbortController().signal,
  };
  for (const proof of [
    {},
    Object.freeze({}),
    { schemaVersion: 1 },
    { ...f.options.association },
    {
      valid: true,
      ownSPIFFEId: f.options.profile.ownSPIFFEId,
      peerSPIFFEId: f.options.profile.peerSPIFFEId,
    },
  ]) {
    assert.equal(await f.native.inspect(proof, f.input, bounds), undefined);
    assert.equal(f.registrationNative.inspectOriginal(proof, f.input, bounds), undefined);
    assert.equal(f.registrationNative.originalFor(f.input, bounds), undefined);
    assert.equal(await f.service.enroll(proof, f.input, bounds), undefined);
  }
  assert.equal(f.accountCalls, 0);
  assert.equal(f.compositionCount, 1);
  await receiver.close();
  assert.equal(receiver.signal.aborted, true);
});

test("selected profile and endpoint mismatches fail before composition", () => {
  for (const change of [
    (f) => {
      f.options.profile.operationPolicy = "read-operation-only-v1";
    },
    (f) => {
      f.options.profile.operationPolicy = "initial-harness-bind-v1";
    },
    (f) => {
      f.options.profile.transportProfileRef = "owned-child-stdio-readback-v1";
    },
    (f) => {
      f.options.profile.recipientSPIFFEId = f.options.profile.peerSPIFFEId;
    },
    (f) => {
      f.options.profile.ownSPIFFEId = "spiffe://gateway.test/another";
    },
    (f) => {
      f.options.association.endpoints.transportRecipientRef = "recipient/gateway";
    },
    (f) => {
      f.options.profile.limits.maxConnectionAgeMs = 30001;
    },
    (f) => {
      f.options.profile.limits.maxConnections = 2;
    },
    (f) => {
      f.options.configurationVersion = 0;
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => createGatewayStartupNativeServiceV1(f.options));
    assert.equal(f.compositionCount, 0);
  }
});

test("closed or failed startup cannot retry or replace the startup composition", async () => {
  const f = fixture(),
    receiver = createGatewayStartupNativeServiceV1(f.options);
  f.options.compose = () => {
    throw new Error("replacement must not run");
  };
  await assert.rejects(receiver.start());
  assert.equal(receiver.signal.aborted, true);
  await assert.rejects(receiver.start());
  await receiver.close();
  assert.equal(f.compositionCount, 1);
});

test("close before start is synchronous terminal and keeps foreign proof denied", async () => {
  const f = fixture(),
    receiver = createGatewayStartupNativeServiceV1(f.options);
  const close = receiver.close();
  assert.equal(receiver.signal.aborted, true);
  assert.equal(receiver.close(), close);
  await close;
  await assert.rejects(receiver.start());
});

// Selecting this case requires separately allocated, actual maintained Go
// executables. It never builds a binary or substitutes a script for the child.
const selectedNative = Boolean(
  process.env.OCE_GATEWAY_NATIVE_BINARY || process.env.OCE_GATEWAY_NATIVE_FIXTURE,
);
function eventQueue(child, framed) {
  const values = [],
    waiters = [];
  let failure,
    pending = Buffer.alloc(0);
  function fail(error) {
    failure ??= error;
    for (const waiter of waiters.splice(0)) waiter.reject(failure);
  }
  function publish(value) {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value);
    else if (values.length < 16) values.push(value);
    else fail(new Error("owned fixture event queue exceeded its bound"));
  }
  let stop = () => {};
  if (framed)
    stop = consumeNativeFrames(
      child.stdout,
      (raw) => {
        try {
          publish(JSON.parse(raw.toString("utf8")));
        } catch (error) {
          fail(error);
        }
      },
      (reason) => fail(new Error(`native event stream ended: ${reason}`)),
    );
  else {
    const data = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 262144) return fail(new Error("fixture line exceeded its bound"));
      let end;
      while ((end = pending.indexOf(10)) >= 0) {
        const raw = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        try {
          const value = JSON.parse(raw.toString("utf8"));
          if (value.kind === "fatal") throw new Error("actual fixture initialization failed");
          publish(value);
        } catch (error) {
          fail(error);
        }
      }
    };
    child.stdout.on("data", data);
    stop = () => child.stdout.off("data", data);
  }
  child.on("error", fail);
  child.once("close", () => fail(new Error("owned process closed")));
  return {
    stop,
    next() {
      if (values.length) return Promise.resolve(values.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error("owned fixture event deadline"));
        }, 5000);
        waiters.push(waiter);
      });
    },
  };
}
async function allocatedProcess(t, path, args, env, framed) {
  assert.equal(typeof path, "string", "both allocated executable paths are required");
  assert.equal(await realpath(path), path, "allocated executable path is canonical");
  const metadata = await stat(path);
  assert.ok(metadata.isFile() && metadata.mode & 0o111 && !(metadata.mode & 0o022));
  const digest = `sha256:${createHash("sha256")
    .update(await readFile(path))
    .digest("hex")}`;
  t.diagnostic(`Actual maintained executable ${path}, ${digest}`);
  const child = spawn(path, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  const closed = nativeChildExit(child),
    events = eventQueue(child, framed);
  let stderr = Buffer.alloc(0);
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 65536) stderr = Buffer.concat([stderr, chunk]);
  });
  // Register ownership before waiting for readiness, including failed spawn.
  t.after(async () => {
    try {
      await closeNativeChild(child, closed);
    } finally {
      events.stop();
      child.stderr.destroy();
    }
    assert.equal(stderr.toString(), "", "actual native process diagnostics");
  });
  return { child, closed, events, digest };
}
async function vacantLoopbackAddress() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return `127.0.0.1:${address.port}`;
}

test(
  "actual owned native connection issues only exact per-call service contexts and terminates on Source loss",
  {
    skip: !selectedNative
      ? "requires separately allocated actual Go child and Source fixture"
      : false,
    timeout: 25000,
  },
  async (t) => {
    const fixtureChild = await allocatedProcess(
      t,
      process.env.OCE_GATEWAY_NATIVE_FIXTURE,
      [],
      { TMPDIR: tmpdir() },
      false,
    );
    const ready = await fixtureChild.events.next();
    assert.equal(ready.kind, "ready");
    const f = fixture(),
      seen = [];
    f.options.binaryPath = process.env.OCE_GATEWAY_NATIVE_BINARY;
    f.options.listenAddress = await vacantLoopbackAddress();
    // Native configuration and expected authority records are deliberately
    // distinct. Their current mapping belongs to the original selected producer.
    f.options.configurationVersion = 11;
    f.options.profile.sourceRef = "native/source-fixture";
    f.options.association.sourceConfiguration = {
      recordRef: "association/configuration",
      recordVersion: 7,
    };
    f.options.profile.nativeExecutableSha256 = `sha256:${createHash("sha256")
      .update(await readFile(f.options.binaryPath))
      .digest("hex")}`;
    Object.assign(f.options.profile, {
      workloadApiSocketPath: ready.workloadApiSocketPath,
      ownSPIFFEId: ready.ownSPIFFEId,
      peerSPIFFEId: ready.peerSPIFFEId,
      recipientSPIFFEId: ready.ownSPIFFEId,
      trustDomain: ready.trustDomain,
      trustBundleSha256: ready.trustBundleSha256,
    });
    f.options.association.endpoints.controller.spiffeId = ready.ownSPIFFEId;
    f.options.association.endpoints.gateway.spiffeId = ready.peerSPIFFEId;
    let native,
      registration,
      blockCleanup = false,
      beginCleanup,
      releaseCleanup;
    const cleanupStarted = new Promise((resolve) => {
      beginCleanup = resolve;
    });
    const cleanupGate = new Promise((resolve) => {
      releaseCleanup = resolve;
    });
    t.after(() => releaseCleanup());
    f.options.compose = (source, inspector) => {
      native = source;
      registration = inspector;
      const service = createGatewayInstallationServiceAuthorityV1({
        native: source,
        account: {
          async consume() {
            throw new Error("no account producer selected");
          },
        },
        currentness: {
          async consume() {
            throw new Error("no current registration/process producer selected");
          },
        },
      });
      return {
        owner: createGatewayStartupOwnerV1({}),
        service: {
          ...service,
          async enroll(proof, command, bounds) {
            // Genuine original proof is captured from the actual owned Go request.
            // Each changed value is rejected before the untouched positive control.
            assert.equal(
              await source.inspect(
                proof,
                { ...command, expectedRecordVersion: command.expectedRecordVersion + 1 },
                bounds,
              ),
              undefined,
            );
            assert.equal(
              await source.inspect(proof, command, { ...bounds, requestRef: "changed/request" }),
              undefined,
            );
            assert.equal(
              await source.inspect(proof, command, {
                ...bounds,
                signal: new AbortController().signal,
              }),
              undefined,
            );
            for (const old of seen)
              assert.equal(await source.inspect(old.proof, command, bounds), undefined);
            const enrollment = await service.enroll(proof, command, bounds);
            assert.ok(enrollment, "actual TLS/pipe provenance reaches original service enrollment");
            assert.equal(inspector.originalFor(command, bounds), proof);
            const observed = inspector.inspectOriginal(proof, command, bounds);
            assert.ok(observed);
            assert.equal(observed.gatewaySpiffeId, ready.peerSPIFFEId);
            assert.equal(observed.controllerSpiffeId, ready.ownSPIFFEId);
            assert.equal(observed.assertCurrent(), undefined);
            assert.equal(Object.hasOwn(observed, "source"), false);
            assert.deepEqual(
              observed.expectedSourceConfiguration,
              f.options.association.sourceConfiguration,
            );
            assert.deepEqual(observed.nativeConfiguration, {
              sourceRef: f.options.profile.sourceRef,
              configurationVersion: f.options.configurationVersion,
              sourceConfigurationDigest: f.options.profile.sourceConfigurationDigest,
            });
            assert.ok(Object.isFrozen(observed.nativeConfiguration));
            assert.equal(
              await service.enroll(proof, command, bounds),
              undefined,
              "original context cannot enroll twice",
            );
            seen.push({ proof, command, bounds });
            if (!blockCleanup) return enrollment;
            return {
              invocation: enrollment.invocation,
              async close() {
                beginCleanup();
                await cleanupGate;
                await enrollment.close();
              },
            };
          },
        },
      };
    };
    const receiver = createGatewayStartupNativeServiceV1(f.options);
    t.after(() => receiver.close());
    await receiver.start();
    const client = await allocatedProcess(
      t,
      process.env.OCE_GATEWAY_NATIVE_BINARY,
      ["gateway-startup-client"],
      {},
      true,
    );
    const profile = {
      ...f.options.profile,
      ownSPIFFEId: ready.peerSPIFFEId,
      peerSPIFFEId: ready.ownSPIFFEId,
    };
    const profileBytes = Buffer.from(JSON.stringify(profile)),
      incarnation = randomBytes(16).toString("hex");
    const profileDigest = nativeDigest(profileBytes);
    const signal = AbortSignal.timeout(20000);
    await writeNativeFrame(
      client.child.stdin,
      {
        schemaVersion: 1,
        kind: "bootstrap",
        incarnation,
        sequence: 1,
        profileBase64: profileBytes.toString("base64"),
        profileDigest,
        configurationVersion: f.options.configurationVersion,
        connectAddress: f.options.listenAddress,
      },
      signal,
    );
    const connected = await client.events.next();
    assert.equal(connected.kind, "ready");
    assert.equal(connected.incarnation, incarnation);
    assert.equal(connected.profileDigest, profileDigest);
    assert.match(connected.connectionId, /^[0-9a-f]{32}$/);
    for (let sequence = 2; sequence <= 3; sequence++) {
      const bytes = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          method: "read-current",
          deadline: new Date(Date.now() + 2500).toISOString(),
          operation: f.input,
        }),
      );
      const command = {
        schemaVersion: 1,
        kind: "call",
        incarnation,
        sequence,
        connectionId: connected.connectionId,
        exchangeId: randomBytes(16).toString("hex"),
        requestDigest: nativeDigest(bytes),
        challenge: randomBytes(16).toString("hex"),
        payloadBase64: bytes.toString("base64"),
      };
      await writeNativeFrame(client.child.stdin, command, signal);
      const response = await client.events.next();
      assert.equal(response.kind, "result");
      for (const key of ["incarnation", "connectionId", "exchangeId", "requestDigest", "challenge"])
        assert.equal(response[key], command[key]);
      const body = JSON.parse(Buffer.from(response.payloadBase64, "base64").toString("utf8"));
      assert.equal(
        body.kind,
        "unavailable",
        "missing real owner transaction/current participants cannot become authority",
      );
      assert.equal(seen.length, sequence - 1);
      const previous = seen.at(-1);
      assert.equal(
        await native.inspect(previous.proof, previous.command, previous.bounds),
        undefined,
      );
      assert.equal(
        registration.inspectOriginal(previous.proof, previous.command, previous.bounds),
        undefined,
      );
    }
    assert.notEqual(seen[0].proof, seen[1].proof);
    assert.notEqual(seen[0].bounds.signal, seen[1].bounds.signal);
    blockCleanup = true;
    const blockedBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        method: "read-current",
        deadline: new Date(Date.now() + 2500).toISOString(),
        operation: f.input,
      }),
    );
    await writeNativeFrame(
      client.child.stdin,
      {
        schemaVersion: 1,
        kind: "call",
        incarnation,
        sequence: 4,
        connectionId: connected.connectionId,
        exchangeId: randomBytes(16).toString("hex"),
        requestDigest: nativeDigest(blockedBytes),
        challenge: randomBytes(16).toString("hex"),
        payloadBase64: blockedBytes.toString("base64"),
      },
      signal,
    );
    let disclosed = false;
    const blockedResponse = client.events.next().then((value) => {
      disclosed = true;
      return value;
    });
    blockedResponse.catch(() => {});
    await cleanupStarted;
    assert.equal(seen.length, 3);
    fixtureChild.child.stdin.write(
      `${JSON.stringify({ kind: "withdraw", id: "terminal-source-withdrawal" })}\n`,
    );
    const changed = await fixtureChild.events.next();
    assert.equal(changed.kind, "changed");
    await new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(
        () => reject(new Error("Source withdrawal did not close original lifetime")),
        3000,
      );
      if (receiver.signal.aborted) done();
      else receiver.signal.addEventListener("abort", done, { once: true });
    });
    assert.equal(receiver.signal.aborted, true);
    for (const old of seen)
      assert.equal(await native.inspect(old.proof, old.command, old.bounds), undefined);
    let settled = false;
    const terminalClose = receiver.close().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      settled,
      false,
      "terminal close retains the unfinished original enrollment cleanup",
    );
    assert.equal(
      disclosed,
      false,
      "Source loss while cleanup is blocked cannot disclose the old response",
    );
    releaseCleanup();
    await terminalClose;
    await client.closed;
    await assert.rejects(blockedResponse);
  },
);
