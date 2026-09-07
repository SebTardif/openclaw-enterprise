import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayStartupLocalOwnerV1 } from "../../apps/gateway/src/startup-lifetime.ts";
import { controlledPeer, deferred } from "../fixtures/gateway-startup-v1/values.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(edit = () => {}) {
  const p = controlledPeer();
  edit(p);
  const owner = createGatewayStartupLocalOwnerV1(p.source, p.adapter);
  const e = await owner.enroll({});
  assert.ok(e);
  return { p, owner, e };
}

test("separate process/host generations start once and close joins the same outcome", async () => {
  const { p, e } = await fixture();
  p.ready();
  const r = await e.usePort.start(e.recipient, e.startup);
  assert.equal(r.kind, "started");
  assert.equal(p.binding.startup.processGeneration, 7);
  assert.equal(p.host.configuration.runtimeGeneration, 19);
  const again = await e.usePort.start(e.recipient, e.startup);
  assert.equal(again.kind, "denied");
  assert.equal(p.events.filter((x) => x === "start").length, 1);
  const [a, b, c] = await Promise.all([r.lifetime.close(), r.lifetime.close(), r.lifetime.closed]);
  assert.strictEqual(a, b);
  assert.strictEqual(a, c);
  assert.deepEqual(a, { cleanup: "finished", termination: "unknown" });
  assert.equal(p.events.filter((x) => x === "host-close").length, 1);
});
test("foreign/cloned handles deny before claim or factory", async () => {
  const { p, e } = await fixture();
  const other = await fixture();
  for (const [a, b] of [
    [{}, e.startup],
    [e.recipient, {}],
    [other.e.recipient, e.startup],
    [e.recipient, other.e.startup],
  ])
    assert.equal((await e.usePort.start(a, b)).kind, "denied");
  assert.ok(!p.events.includes("claim-read"));
  assert.ok(!p.events.includes("prepare"));
  p.revoke.abort();
  other.p.revoke.abort();
  await tick();
});
for (const outcome of ["unknown", "denied", "unavailable"]) {
  test(`fresh original claim read ${outcome} never prepares or starts`, async () => {
    const { p, e } = await fixture((p) => {
      p.grant.readClaim = async () => outcome;
    });
    const r = await e.usePort.start(e.recipient, e.startup);
    assert.equal(r.kind, outcome === "unknown" ? "recovery-required" : outcome);
    assert.ok(!p.events.includes("prepare"));
    assert.ok(!p.events.includes("start"));
    assert.ok(p.events.includes("grant-close"));
  });
}
test("revocation closes the registered host while readiness remains pending", async () => {
  const { p, e } = await fixture();
  const pending = e.usePort.start(e.recipient, e.startup);
  await tick();
  assert.ok(p.events.includes("start"));
  p.revoke.abort();
  const r = await pending;
  assert.equal(r.kind, "recovery-required");
  assert.ok(p.events.indexOf("quiesce") < p.events.indexOf("host-close"));
  assert.ok(p.events.includes("prepared-close"));
});
test("revocation during synchronous start cannot be lost before readiness await", async () => {
  const { p, e } = await fixture((p) => {
    const start = p.prepared.start;
    p.prepared.start = () => {
      const h = start();
      p.revoke.abort();
      return h;
    };
  });
  assert.equal((await e.usePort.start(e.recipient, e.startup)).kind, "recovery-required");
  assert.ok(p.events.includes("quiesce"));
  assert.ok(p.events.includes("host-close"));
});
test("late preparation is retained and closed before non-started return", async () => {
  const wait = deferred();
  const { p, e } = await fixture((p) => {
    p.adapter.prepare = async () => {
      p.events.push("prepare");
      return wait.promise;
    };
  });
  let returned = false;
  const pending = e.usePort.start(e.recipient, e.startup).then((x) => {
    returned = true;
    return x;
  });
  await tick();
  p.revoke.abort();
  await tick();
  assert.equal(returned, false);
  assert.ok(p.events.includes("grant-close"));
  wait.resolve(p.prepared);
  assert.equal((await pending).kind, "recovery-required");
  assert.ok(p.events.includes("prepared-close"));
  assert.ok(!p.events.includes("start"));
});
test("valid currentness withdrawal after preparation closes it without start", async () => {
  const { p, e } = await fixture((p) => {
    p.adapter.prepare = async () => {
      p.revoke.abort();
      return p.prepared;
    };
  });
  assert.equal((await e.usePort.start(e.recipient, e.startup)).kind, "recovery-required");
  assert.ok(p.events.includes("prepared-close"));
  assert.ok(!p.events.includes("start"));
});
test("configuration substitution refuses before fixed preparation", async () => {
  const { p, e } = await fixture((p) => {
    p.material.input.configuration.admittedRevisionRef = "foreign";
  });
  assert.equal((await e.usePort.start(e.recipient, e.startup)).kind, "recovery-required");
  assert.ok(!p.events.includes("prepare"));
  assert.ok(p.events.includes("material-close"));
});
test("invalid asynchronous final fence never becomes an accepting fence", async () => {
  const p = controlledPeer();
  p.grant.assertCurrent = async () => undefined;
  const owner = createGatewayStartupLocalOwnerV1(p.source, p.adapter);
  assert.equal(await owner.enroll({}), undefined);
  assert.ok(!p.events.includes("claim-read"));
  assert.ok(p.events.includes("grant-close"));
});
test("cleanup failure remains explicit and cannot prove physical termination", async () => {
  const { p, e } = await fixture((p) => {
    p.material.close = async () => {
      throw new Error("fixture private failure");
    };
  });
  p.ready();
  const r = await e.usePort.start(e.recipient, e.startup);
  assert.equal(r.kind, "started");
  assert.deepEqual(await r.lifetime.close(), { cleanup: "failed", termination: "unknown" });
});

test("malformed binding closes acquired grant and never issues a local pair", async () => {
  const p = controlledPeer();
  delete p.binding.admittedRevisionRef;
  const owner = createGatewayStartupLocalOwnerV1(p.source, p.adapter);
  assert.equal(await owner.enroll({}), undefined);
  assert.ok(p.events.includes("grant-close"));
  assert.ok(!p.events.includes("prepare"));
});
test("invalid asynchronous fence settlement is joined before the refused enrollment returns", async () => {
  const p = controlledPeer();
  const wait = deferred();
  p.grant.assertCurrent = () => wait.promise;
  const owner = createGatewayStartupLocalOwnerV1(p.source, p.adapter);
  let returned = false;
  const result = owner.enroll({}).then((x) => {
    returned = true;
    return x;
  });
  await tick();
  assert.equal(returned, false);
  assert.ok(p.events.includes("grant-close"));
  wait.resolve();
  assert.equal(await result, undefined);
});
test("semantically identical ordered module fields ignore object insertion order", async () => {
  const { p, e } = await fixture((p) => {
    p.material.input.configuration.modules = p.binding.modules.map((m) => ({
      requiredCapabilities: m.requiredCapabilities,
      profileRef: m.profileRef,
      kind: m.kind,
      id: m.id,
    }));
  });
  p.ready();
  const result = await e.usePort.start(e.recipient, e.startup);
  assert.equal(result.kind, "started");
  await result.lifetime.close();
});

for (const field of ["assertCurrent", "recheckCurrent", "readClaim", "borrowMaterial"]) {
  test(`acquired local grant joins captured close when ${field} access throws`, async () => {
    const p = controlledPeer();
    const wait = deferred();
    let closes = 0;
    let closeReads = 0;
    Object.defineProperty(p.grant, "close", {
      get() {
        closeReads++;
        if (closeReads > 1) throw Error("second close access");
        return async () => {
          closes++;
          await wait.promise;
          return "finished";
        };
      },
    });
    Object.defineProperty(p.grant, field, {
      get() {
        throw Error("controlled grant access failure");
      },
    });
    const owner = createGatewayStartupLocalOwnerV1(p.source, p.adapter);
    let returned = false;
    const pending = owner.enroll({}).then((result) => {
      returned = true;
      return result;
    });
    await tick();
    assert.equal(returned, false);
    assert.equal(closes, 1);
    wait.resolve();
    assert.equal(await pending, undefined);
    assert.equal(closeReads, 1);
    assert.equal(closes, 1);
    assert.ok(!p.events.includes("prepare"));
  });
}
test("local grant methods and source signal are captured once before enrollment waits", async () => {
  const p = controlledPeer();
  const counts = new Map();
  for (const field of [
    "close",
    "signal",
    "assertCurrent",
    "recheckCurrent",
    "readClaim",
    "borrowMaterial",
  ]) {
    const value = p.grant[field];
    Object.defineProperty(p.grant, field, {
      get() {
        const count = (counts.get(field) ?? 0) + 1;
        counts.set(field, count);
        if (count > 1) throw Error(`repeated ${field} access`);
        return value;
      },
    });
  }
  const owner = createGatewayStartupLocalOwnerV1(p.source, p.adapter);
  const e = await owner.enroll({});
  assert.ok(e);
  p.ready();
  const result = await e.usePort.start(e.recipient, e.startup);
  assert.equal(result.kind, "started");
  assert.equal((await result.lifetime.close()).cleanup, "finished");
  for (const count of counts.values()) assert.equal(count, 1);
  assert.equal(p.events.filter((event) => event === "grant-close").length, 1);
});
