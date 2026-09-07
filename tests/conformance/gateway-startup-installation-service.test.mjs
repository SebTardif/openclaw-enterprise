import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayInstallationServiceAuthorityV1 } from "../../packages/occ/src/gateway-startup-v1/installation-service.ts";
import { createGatewayStartupOwnerV1 } from "../../packages/occ/src/gateway-startup-v1/owner.ts";
import {
  controlledOwner,
  submissionCommand,
  consumeCommand,
  deferred,
} from "../fixtures/gateway-startup-v1/values.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));
// The production router/registry/owner are real. Native authentication and the
// transaction-current producer are explicit controlled peers, not TLS or IAM proof.
async function fixture(edit = () => {}) {
  const f = await controlledOwner();
  const accepted = await f.execute(f.accept);
  assert.equal(accepted.kind, "accepted");
  const submitted = await f.execute(submissionCommand(accepted));
  assert.equal(submitted.kind, "submitted");
  const command = consumeCommand(accepted, submitted);
  const revocation = new AbortController();
  const proof = Object.freeze({});
  const events = [];
  const lease = {
    profile: "installation-gateway-startup-v1",
    transport: "owned-child-stdio-installation-gateway-startup-v1",
    association: {
      startup: structuredClone(accepted.record.binding.startup),
      createEffectRef: accepted.record.binding.createEffectRef,
      recipient: structuredClone(command.recipient),
      registration: { recordRef: "registration", recordVersion: 1 },
      sourceConfiguration: { recordRef: "source", recordVersion: 1 },
      endpoints: {
        gateway: { serviceRef: "gateway-service", spiffeId: "spiffe://fixture/gateway" },
        controller: { serviceRef: "controller-service", spiffeId: "spiffe://fixture/controller" },
        transportRecipientRef: "controller-service",
      },
    },
    signal: revocation.signal,
    assertCurrent() {
      events.push("native-fence");
      if (revocation.signal.aborted) throw Error("controlled native loss");
    },
    async close() {
      events.push("native-release");
    },
  };
  const current = {
    async consume(association, c, bounds, unit, io) {
      io.assertActive();
      events.push("transaction-current");
      assert.equal(association.startup.installationId, unit.installationId);
      return {
        attribution: {
          actorId: "registered-service-fixture",
          requestRef: bounds.requestRef,
          decisionRef: "service-decision",
        },
        assertCurrent() {
          events.push("transaction-fence");
        },
        async release() {
          events.push("current-release");
        },
      };
    },
  };
  const native = {
    async inspect(given) {
      events.push("inspect");
      return given === proof ? lease : undefined;
    },
  };
  const input = { f, accepted, command, revocation, proof, events, lease, current, native };
  edit(input);
  const router = createGatewayInstallationServiceAuthorityV1({
    account: f.participants.authority,
    native,
    currentness: current,
  });
  const owner = createGatewayStartupOwnerV1({
    transaction: f.transaction,
    participants: { ...f.participants, authority: router.authority },
  });
  return { ...input, router, owner, enroll: (c = command) => router.enroll(proof, c, f.bounds) };
}
test("missing authentic native/currentness ports never enroll a service invocation", async () => {
  const f = await controlledOwner();
  const router = createGatewayInstallationServiceAuthorityV1({ account: f.participants.authority });
  assert.equal(await router.enroll({}, f.accept, f.bounds), undefined);
});
test("confirmed service consume holds native and transaction leases through actual owner commit", async () => {
  const p = await fixture();
  const e = await p.enroll();
  assert.ok(e);
  const r = await p.owner.execute(p.command, e.invocation, p.f.bounds);
  assert.equal(r.kind, "consumed");
  assert.equal(p.f.retained().events.size, 3);
  assert.ok(p.events.indexOf("current-release") < p.events.indexOf("native-release"));
  await e.close();
  assert.equal(p.events.filter((v) => v === "native-release").length, 1);
});
test("registered service invocation cannot change method or fall back to account authority", async () => {
  const p = await fixture();
  const e = await p.enroll();
  assert.ok(e);
  const result = await p.owner.execute(
    { ...p.f.accept, operationRef: "unauthorized-accept" },
    e.invocation,
    p.f.bounds,
  );
  assert.notEqual(result.kind, "accepted");
  assert.equal(p.f.retained().events.size, 2);
  await e.close();
  assert.ok(p.events.includes("native-release"));
});
test("foreign proof and cloned invocation confer no service authority", async () => {
  const p = await fixture();
  assert.equal(await p.router.enroll({}, p.command, p.f.bounds), undefined);
  const e = await p.enroll();
  assert.ok(e);
  const result = await p.owner.execute(p.command, { ...e.invocation }, p.f.bounds);
  assert.notEqual(result.kind, "consumed");
  assert.equal(p.f.retained().events.size, 2);
  await e.close();
});
for (const change of [
  (p) => {
    p.lease.profile = "initial-harness-bind-v1";
  },
  (p) => {
    p.lease.transport = "owned-child-stdio-v1";
  },
  (p) => {
    p.lease.association.endpoints.transportRecipientRef = "gateway-service";
  },
  (p) => {
    p.lease.association.recipient.incarnationRef = "other";
  },
  (p) => {
    p.lease.association.startup.processGeneration++;
  },
])
  test("incompatible original profile/endpoint/recipient/target denies enrollment", async () => {
    const p = await fixture(change);
    assert.equal(await p.enroll(), undefined);
    assert.ok(p.events.includes("native-release"));
    assert.ok(!p.events.includes("transaction-current"));
  });
test("already revoked native registration cannot return a local invocation", async () => {
  const p = await fixture((p) => p.revocation.abort());
  assert.equal(await p.enroll(), undefined);
  assert.ok(p.events.includes("native-release"));
});
test("explicit close before use is terminal and releases the acquired native lease", async () => {
  const p = await fixture();
  const e = await p.enroll();
  await e.close();
  const r = await p.owner.execute(p.command, e.invocation, p.f.bounds);
  assert.notEqual(r.kind, "consumed");
  assert.equal(p.events.filter((v) => v === "native-release").length, 1);
});
test("native loss during pending currentness poisons owner and joins the late lease before release", async () => {
  const wait = deferred();
  const p = await fixture((p) => {
    const consume = p.current.consume;
    p.current.consume = async (...args) => {
      const lease = await consume(...args);
      await wait.promise;
      return lease;
    };
  });
  const e = await p.enroll();
  const pending = p.owner.execute(p.command, e.invocation, p.f.bounds);
  await tick();
  p.revocation.abort();
  let closed = false;
  const join = e.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  assert.ok(!p.events.includes("native-release"));
  wait.resolve();
  const r = await pending;
  assert.notEqual(r.kind, "consumed");
  await join;
  assert.equal(p.f.retained().events.size, 2);
  assert.ok(p.events.includes("current-release"));
  assert.ok(p.events.includes("native-release"));
});
test("currentness failure caught by a peer still poisons final command", async () => {
  const p = await fixture((p) => {
    p.current.consume = async (_a, _c, b, unit) => {
      unit.phase.poison(Error("caught producer failure"));
      return {
        attribution: { actorId: "service", requestRef: b.requestRef, decisionRef: "decision" },
        assertCurrent() {},
        async release() {},
      };
    };
  });
  const e = await p.enroll();
  const r = await p.owner.execute(p.command, e.invocation, p.f.bounds);
  assert.notEqual(r.kind, "consumed");
  assert.equal(p.f.retained().events.size, 2);
  await e.close();
});
test("invalid asynchronous native fence is joined while enrollment remains refused", async () => {
  const wait = deferred();
  const p = await fixture((p) => {
    p.lease.assertCurrent = () => wait.promise;
  });
  let returned = false;
  const pending = p.enroll().then((x) => {
    returned = true;
    return x;
  });
  await tick();
  assert.equal(returned, false);
  wait.resolve();
  assert.equal(await pending, undefined);
  assert.ok(p.events.includes("native-release"));
});
test("historical original acceptance read is independent and cannot create a consume", async () => {
  const p = await fixture();
  const operation = [...p.f.retained().events.values()].find(
    (e) => e.kind === "accept-startup",
  ).command;
  const command = { schemaVersion: 1, kind: "read-operation", operation };
  const e = await p.enroll(command);
  assert.ok(e);
  const result = await p.owner.execute(command, e.invocation, p.f.bounds);
  assert.equal(result.kind, "observed");
  assert.equal(p.f.retained().events.size, 2);
  await e.close();
});
test("same private invocation cannot be consumed again or revived after native loss", async () => {
  const p = await fixture();
  const e = await p.enroll();
  assert.equal((await p.owner.execute(p.command, e.invocation, p.f.bounds)).kind, "consumed");
  p.revocation.abort();
  const again = await p.owner.execute(p.command, e.invocation, p.f.bounds);
  assert.notEqual(again.kind, "consumed");
  assert.equal(p.f.retained().events.size, 3);
  await e.close();
});

for (const [name, change] of [
  [
    "missing registration",
    (p) => {
      delete p.lease.association.registration;
    },
  ],
  [
    "invalid source version",
    (p) => {
      p.lease.association.sourceConfiguration.recordVersion = 0;
    },
  ],
  [
    "unknown association field",
    (p) => {
      p.lease.association.authorized = true;
    },
  ],
  [
    "missing original create effect",
    (p) => {
      p.lease.association.createEffectRef = "";
    },
  ],
  [
    "invalid controller identity",
    (p) => {
      p.lease.association.endpoints.controller.spiffeId = "";
    },
  ],
])
  test(`closed native association refuses ${name} before currentness`, async () => {
    const p = await fixture(change);
    assert.equal(await p.enroll(), undefined);
    assert.ok(p.events.includes("native-release"));
    assert.ok(!p.events.includes("transaction-current"));
  });
test("invalid ingress bounds refuse before native inspection", async () => {
  const p = await fixture();
  for (const patch of [{ requestRef: "" }, { deadline: "invalid" }])
    assert.equal(await p.router.enroll(p.proof, p.command, { ...p.f.bounds, ...patch }), undefined);
  assert.ok(!p.events.includes("inspect"));
});
test("bounds are captured before pending native inspection", async () => {
  const wait = deferred();
  let received;
  const p = await fixture((p) => {
    p.native.inspect = async (proof, _command, bounds) => {
      received = bounds;
      await wait.promise;
      return proof === p.proof ? p.lease : undefined;
    };
  });
  const bounds = { ...p.f.bounds };
  const original = { ...bounds };
  const pending = p.router.enroll(p.proof, p.command, bounds);
  await tick();
  bounds.requestRef = "substituted";
  bounds.deadline = "2100-01-01T00:00:00Z";
  assert.equal(received.requestRef, original.requestRef);
  wait.resolve();
  const e = await pending;
  assert.ok(e);
  const r = await p.owner.execute(p.command, e.invocation, original);
  assert.equal(r.kind, "consumed");
  await e.close();
});
