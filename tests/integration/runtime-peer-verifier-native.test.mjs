import assert from "node:assert/strict";
import test from "node:test";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createRuntimeWorkloadVerifierV1,
  getRuntimeWorkloadVerifierSettlementV1,
} from "../../packages/occ/src/runtime-identity/peer-verifier-v1.ts";
import {
  startNativePeerFixture,
  registrationFixture,
  expectationFixture,
  callFixture,
} from "../fixtures/runtime-identity-peer/fixture.mjs";

const binary = process.env.OCE_RUNTIME_PEER_FIXTURE_BINARY;
const skip = binary
  ? false
  : "requires separately built local Go fixture and explicit native execution allocation";
async function fixture(t, options) {
  assert.ok(isAbsolute(binary), "explicit fixture binary must be absolute");
  const fixture = await startNativePeerFixture(binary, options);
  t.after(() => fixture.close());
  return fixture;
}
async function proof(verifier, connection, expected) {
  const result = await verifier.verify(connection, expected, callFixture());
  assert.equal(result.kind, "verified", JSON.stringify(result));
  return result.proof;
}

test(
  "real local Source/servicepeer TLS plus owned Node pipe and canonical resolver produce exact isolated proofs",
  { skip, timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      registration = registrationFixture(),
      expected = expectationFixture(registration);
    const verifier = createRuntimeWorkloadVerifierV1({
      native: f.native,
      registration: f.registration(registration),
    });
    const a = await f.connect(),
      b = await f.connect();
    const [first, second] = await Promise.all([
      proof(verifier, a, expected),
      proof(verifier, b, expected),
    ]);
    assert.notEqual(first.transportBinding, second.transportBinding);
    assert.notEqual(first.connectionRef, second.connectionRef);
    assert.equal(first.spiffeId, expected.expectedPeerSPIFFEId);
    assert.equal(first.recipientRef, expected.recipientRef);
    const again = await verifier.inspect(first, callFixture());
    assert.equal(again.kind, "verified");
    assert.equal(again.proof, first);
    // The actual verifier must reject a copied diagnostic before any native lookup.
    assert.equal(
      (await verifier.inspect({ ...first }, callFixture())).reasonCode,
      "binding-mismatch",
    );
    assert.notEqual((await verifier.verify({}, expected, callFixture())).kind, "verified");
    assert.notEqual(
      (
        await verifier.verify(
          a,
          { ...expected, expectedPeerSPIFFEId: `${expected.expectedPeerSPIFFEId}/wrong` },
          callFixture(),
        )
      ).kind,
      "verified",
    );
    assert.notEqual(
      (
        await verifier.verify(
          b,
          { ...expected, recipientRef: "fixture/other" },
          callFixture(Date.now(), { recipientRef: "fixture/other" }),
        )
      ).kind,
      "verified",
    );
  },
);

test(
  "native reconnect has new incarnation; old owned proof cannot resume after disconnect",
  { skip, timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      registration = registrationFixture(),
      expected = expectationFixture(registration);
    const verifier = createRuntimeWorkloadVerifierV1({
      native: f.native,
      registration: f.registration(registration),
    });
    const original = await f.connect(),
      first = await proof(verifier, original, expected);
    await f.disconnect(original);
    assert.notEqual((await verifier.inspect(first, callFixture())).kind, "verified");
    const replacement = await f.connect(),
      next = await proof(verifier, replacement, expected);
    assert.notEqual(next.connectionRef, first.connectionRef);
    assert.notEqual(next.transportBinding, first.transportBinding);
    assert.notEqual((await verifier.inspect(first, callFixture())).kind, "verified");
  },
);

test(
  "actual native connection still requires exact authenticated registration and rejects delayed or stale resolution",
  { skip, timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      registration = registrationFixture(),
      expected = expectationFixture(registration);
    const connection = await f.connect();
    const wrong = structuredClone(registration);
    wrong.assignment.allocation.assignmentRef = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const wrongVerifier = createRuntimeWorkloadVerifierV1({
      native: f.native,
      registration: f.registration(wrong),
    });
    assert.equal(
      (await wrongVerifier.verify(connection, expected, callFixture())).reasonCode,
      "binding-mismatch",
    );
    const trusted = f.registration(registration);
    const staleVerifier = createRuntimeWorkloadVerifierV1({
      native: f.native,
      registration: {
        async resolve(...args) {
          const result = await trusted.resolve(...args);
          assert.equal(result.kind, "observed");
          return {
            kind: "observed",
            observation: { ...result.observation, observedAt: "2020-01-01T00:00:00.000Z" },
          };
        },
      },
    });
    assert.equal(
      (await staleVerifier.verify(connection, expected, callFixture())).reasonCode,
      "evidence-stale",
    );
    const lateVerifier = createRuntimeWorkloadVerifierV1({
      native: f.native,
      registration: {
        async resolve(...args) {
          const result = await trusted.resolve(...args);
          await delay(80);
          return result;
        },
      },
    });
    const limits = { ...expected.limits, assignmentDeadlineMs: 30 };
    assert.equal(
      (await lateVerifier.verify(connection, { ...expected, limits }, callFixture())).reasonCode,
      "deadline-exceeded",
    );
    await delay(100);
  },
);

test(
  "real certificate expiry and original call cancellation deny the actual verifier",
  { skip, timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { lifetimeMs: 2500 }),
      registration = registrationFixture(),
      expected = expectationFixture(registration);
    const verifier = createRuntimeWorkloadVerifierV1({
      native: f.native,
      registration: f.registration(registration),
    });
    const connection = await f.connect(),
      first = await proof(verifier, connection, expected);
    const cancelled = new AbortController();
    cancelled.abort();
    assert.equal(
      (
        await verifier.verify(
          connection,
          expected,
          callFixture(Date.now(), { signal: cancelled.signal }),
        )
      ).reasonCode,
      "cancelled",
    );
    // A controlled delay surrounds an actual authenticated native-backed read.
    // Cancellation must deny before that original dependency settles.
    let enter, release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const reader = f.registration(registration);
    const heldVerifier = createRuntimeWorkloadVerifierV1({
      native: f.native,
      registration: {
        async resolve(...args) {
          const result = await reader.resolve(...args);
          enter();
          await gate;
          return result;
        },
      },
    });
    const inFlight = new AbortController();
    const operation = heldVerifier.verify(
      connection,
      expected,
      callFixture(Date.now(), { signal: inFlight.signal }),
    );
    await entered;
    inFlight.abort();
    assert.equal((await operation).reasonCode, "cancelled");
    release();
    await getRuntimeWorkloadVerifierSettlementV1(heldVerifier, inFlight.signal);
    await delay(2600);
    // Direct native inspection establishes certificate/connection expiration;
    // the verifier additionally preserves its own earlier registration expiry.
    assert.notEqual((await f.native.inspect(connection, callFixture())).kind, "inspected");
    assert.notEqual((await verifier.inspect(first, callFixture())).kind, "verified");
  },
);

test(
  "native fixture failed startup and startup abort retain ownership through close",
  { skip, timeout: 15000 },
  async () => {
    // A failed spawn emits error/close without requiring an exit event. The
    // original owner must finish its bounded close join before rejecting startup.
    await assert.rejects(
      startNativePeerFixture(`${binary}.missing-runtime-peer-fixture`),
      /native fixture unavailable/,
    );
    // The actual helper rejects this test-only invalid lifetime before ready.
    await assert.rejects(
      startNativePeerFixture(binary, { lifetimeMs: 0 }),
      /native fixture unavailable/,
    );
    const controller = new AbortController();
    const startup = startNativePeerFixture(binary, { signal: controller.signal });
    controller.abort();
    await assert.rejects(startup, /native fixture unavailable/);
  },
);

test(
  "native fixture cancellation interrupts a partial input and joins child stdio close",
  { skip, timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    let closed = false;
    void f.settlement.then(() => {
      closed = true;
    });
    // The real Go helper has announced ready and is reading its original pipe.
    // An incomplete command must not keep its Scanner or borrowed sources alive
    // when this original parent cancels and joins the owned child.
    await f.interruptPartialInput();
    assert.equal(closed, true);
    await f.close();
  },
);
