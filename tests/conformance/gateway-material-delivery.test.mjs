import test from "node:test";
import assert from "node:assert/strict";
import {
  createGatewayMaterialDeliveryV1,
  parseGatewayMaterialDeliveryRequestV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/material-delivery";
import {
  controlledOwner,
  submissionCommand,
  consumeCommand,
  deferred,
} from "../fixtures/gateway-startup-v1/values.mjs";

// Real local startup owner commands produce the retained history. The material,
// native and current readers below are controlled peers, not TLS, SQL or Secret proof.
async function fixture(replacement = false) {
  const original = await controlledOwner();
  let accepted = await original.execute(original.accept);
  assert.equal(accepted.kind, "accepted");
  let submitted = await original.execute(submissionCommand(accepted));
  assert.equal(submitted.kind, "submitted");
  let consume = consumeCommand(accepted, submitted);
  let consumed = await original.execute(consume);
  assert.equal(consumed.kind, "consumed");
  if (replacement) {
    const oldStartup = accepted.record.binding.startup;
    const withdrawn = await original.execute({
      schemaVersion: 1,
      kind: "withdraw",
      operationRef: "withdraw-fixture",
      startup: oldStartup,
      expectedHead: {
        version: consumed.record.head.version,
        startup: oldStartup,
        recordVersion: consumed.record.head.recordVersion,
      },
      reason: "administrative",
    });
    assert.equal(withdrawn.kind, "withdrawn");
    accepted = await original.execute({
      ...original.accept,
      operationRef: "accept-second",
      expectedHead: {
        version: withdrawn.head.version,
        startup: oldStartup,
        recordVersion: withdrawn.head.recordVersion,
      },
    });
    assert.equal(accepted.kind, "accepted");
    submitted = await original.execute(submissionCommand(accepted, "submission-second"));
    assert.equal(submitted.kind, "submitted");
    consume = { ...consumeCommand(accepted, submitted), operationRef: "consume-second" };
    consumed = await original.execute(consume);
    assert.equal(consumed.kind, "consumed");
  }
  const request = {
    schemaVersion: 1,
    purpose: "read-selected-channel-material",
    use: "startup-slack-pair",
    startup: accepted.record.binding.startup,
    selection: accepted.record.binding.selection,
    consumedClaim: {
      operationRef: consumed.record.claim.command.operationRef,
      operationDigest: consumed.record.claim.command.operationDigest,
      afterRecordVersion: consumed.record.claim.afterRecordVersion,
    },
    recipient: consume.recipient.recipient,
  };
  const events = [],
    parent = new AbortController(),
    nativeAbort = new AbortController(),
    scopeAbort = new AbortController(),
    bundleAbort = new AbortController();
  const selected = Object.freeze({ controlledSelection: true });
  const bounds = { ...original.bounds, signal: parent.signal };
  let router;
  const native = {
    profile: "installation-channel-material-v1",
    transport: "owned-child-stdio-installation-channel-material-v1",
    association: {
      startup: request.startup,
      createEffectRef: accepted.record.binding.createEffectRef,
      recipient: consume.recipient,
      registration: { recordRef: "registration-fixture", recordVersion: 1 },
      sourceConfiguration: { recordRef: "source-record-fixture", recordVersion: 4 },
      endpoints: {
        gateway: { serviceRef: "gateway-service", spiffeId: "spiffe://fixture/gateway" },
        controller: { serviceRef: "controller-service", spiffeId: "spiffe://fixture/controller" },
        transportRecipientRef: "controller-service",
      },
    },
    signal: nativeAbort.signal,
    assertCurrent() {
      if (nativeAbort.signal.aborted) throw Error("controlled native revoked");
    },
    remainingMs() {
      return 5000;
    },
    async disclose(header, payload, permit) {
      const frame = new Uint8Array(payload.byteLength + 16);
      try {
        payload.encodeInto(frame.subarray(16));
        await router.confirmDisclosure(permit, native, header, payload);
        router.consumeDisclosure(permit, native, header, payload);
        events.push("write");
      } finally {
        frame.fill(0);
      }
    },
    async close() {
      events.push("native-close");
    },
  };
  const scope = {
    current: consumed.record,
    selected,
    signal: scopeAbort.signal,
    assertCurrent() {
      if (scopeAbort.signal.aborted) throw Error("controlled scope revoked");
    },
    remainingMs() {
      return 5000;
    },
    async recheckCurrent() {
      events.push("recheck");
    },
    async confirmDisclosure() {
      events.push("confirm");
    },
  };
  const bundle = {
    bytes: new Uint8Array([1, 2, 3]),
    signal: bundleAbort.signal,
    assertCurrent() {
      if (bundleAbort.signal.aborted) throw Error("controlled bundle revoked");
    },
    remainingMs() {
      return 5000;
    },
    async withEncodedPayload(work) {
      const bytes = bundle.bytes;
      return await work({
        byteLength: bytes.byteLength,
        backingByteLength: bytes.buffer.byteLength,
        encodeInto(target) {
          events.push("encode");
          target.set(bytes);
        },
      });
    },
    async release() {
      events.push("bundle-release");
    },
  };
  const options = {
    native: {
      async inspect(proof, value, actualBounds) {
        events.push("inspect");
        assert.deepEqual(value, request);
        assert.equal(actualBounds.deadline, bounds.deadline);
        assert.equal(actualBounds.signal, parent.signal);
        return native;
      },
    },
    current: {
      async withCurrent(value, actualNative, actualBounds, work) {
        events.push("current");
        assert.equal(actualNative, native);
        assert.equal(actualBounds.deadline, bounds.deadline);
        try {
          return await work(scope);
        } finally {
          events.push("current-release");
        }
      },
    },
    source: {
      async readSelected(actual, use) {
        assert.equal(actual, scope);
        assert.equal(actual.selected, selected);
        assert.equal(use, request.use);
        assert.equal(actual.signal, scopeAbort.signal);
        events.push("read");
        return bundle;
      },
    },
  };
  const api = {
    original,
    request,
    bounds,
    events,
    native,
    scope,
    bundle,
    options,
    parent,
    nativeAbort,
    scopeAbort,
    bundleAbort,
    selected,
    rebuild() {
      router = createGatewayMaterialDeliveryV1(options);
      api.router = router;
    },
    run(value = request, proof = {}) {
      return router.execute(value, proof, bounds);
    },
  };
  api.rebuild();
  return api;
}
async function finish(f) {
  await f.router.close();
}
function count(f, value) {
  return f.events.filter((event) => event === value).length;
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.fail("controlled operation did not reach its expected wait");
}
for (const use of ["startup-slack-pair", "teams-invocation-token"])
  test(`one ${use} disclosure retains original claim and joins all owners`, async () => {
    const f = await fixture();
    f.request.use = use;
    const before = structuredClone(f.original.retained());
    assert.deepEqual(await f.run(), { kind: "delivered" });
    await finish(f);
    assert.deepEqual(f.events, [
      "inspect",
      "current",
      "recheck",
      "read",
      "encode",
      "recheck",
      "confirm",
      "write",
      "bundle-release",
      "current-release",
      "native-close",
    ]);
    assert.deepEqual(f.original.retained(), before); // No second startup consume or new claim store.
  });
for (const missing of ["native", "current", "source"])
  test(`missing ${missing} refuses before any original read`, async () => {
    const f = await fixture();
    delete f.options[missing];
    f.rebuild();
    assert.equal((await f.run()).kind, "unavailable");
    assert.deepEqual(f.events, []);
    await finish(f);
  });
test("closed request grammar, accessors and oversized metadata are denied without acquisition", async () => {
  const f = await fixture();
  const getter = { ...f.request };
  Object.defineProperty(getter, "purpose", {
    enumerable: true,
    get() {
      assert.fail("getter must not execute");
    },
  });
  for (const value of [
    { ...f.request, materialRef: "caller-choice" },
    { ...f.request, use: "generic-secret" },
    getter,
    { ...f.request, recipient: { recordRef: "x".repeat(513), recordVersion: 1 } },
  ]) {
    assert.equal((await f.run(value)).kind, "denied");
  }
  assert.deepEqual(f.events, []);
  await finish(f);
});
test("parser captures immutable metadata without inventing startup authority", async () => {
  const f = await fixture();
  const parsed = parseGatewayMaterialDeliveryRequestV1(f.request);
  assert.ok(Object.isFrozen(parsed.consumedClaim));
  assert.ok(Object.isFrozen(parsed.startup));
  assert.notEqual(parsed, f.request);
  assert.deepEqual(parsed, f.request);
  await finish(f);
});
const requestChanges = {
  selection: (r) => r.selection.recordVersion++,
  claimOperation: (r) => (r.consumedClaim.operationRef = "other-operation"),
  claimDigest: (r) => (r.consumedClaim.operationDigest = "c".repeat(64)),
  claimVersion: (r) => r.consumedClaim.afterRecordVersion++,
  startup: (r) => r.startup.processGeneration++,
  recipient: (r) => r.recipient.recordVersion++,
};
for (const [name, change] of Object.entries(requestChanges))
  test(`exact ${name} mismatch denies material read`, async () => {
    const f = await fixture();
    const request = structuredClone(f.request);
    change(request);
    // The native peer authenticates its original tuple, independent of the changed request DTO.
    f.options.native.inspect = async () => {
      f.events.push("inspect");
      return f.native;
    };
    f.rebuild();
    assert.equal((await f.run(request)).kind, "unavailable");
    await finish(f);
    assert.equal(count(f, "read"), 0);
    assert.equal(count(f, "native-close"), 1);
  });
const historyChanges = {
  withdrawn: (c) => (c.head.state = "withdrawn"),
  missingClaim: (c) => (c.claim = null),
  oldHead: (c) => c.head.recordVersion--,
  latestOperation: (c) => (c.head.latestOperationRef = "other-operation"),
  submissionBinding: (c) => (c.submission.submissionInput.binding.configDigest = "f".repeat(64)),
  wrongRecipient: (c) => (c.claim.recipient.incarnationRef = "other-incarnation"),
};
for (const [name, change] of Object.entries(historyChanges))
  test(`current ${name} cannot advance to material read`, async () => {
    const f = await fixture();
    f.scope.current = structuredClone(f.scope.current);
    change(f.scope.current);
    assert.equal((await f.run()).kind, "unavailable");
    await finish(f);
    assert.equal(count(f, "read"), 0);
  });
for (const field of ["profile", "transport"])
  test(`old startup ${field} is not a material enrollment`, async () => {
    const f = await fixture();
    f.native[field] = "installation-startup-v1";
    assert.equal((await f.run()).kind, "unavailable");
    await finish(f);
    assert.equal(count(f, "read"), 0);
  });
test("acquired native close is retained before a throwing assertion getter", async () => {
  const f = await fixture();
  Object.defineProperty(f.native, "assertCurrent", {
    get() {
      throw Error("getter");
    },
  });
  assert.equal((await f.run()).kind, "unavailable");
  await finish(f);
  assert.equal(count(f, "native-close"), 1);
  assert.equal(count(f, "read"), 0);
});
test("an asynchronous synchronous fence poisons, observes and drains its pending work", async () => {
  const f = await fixture(),
    late = deferred();
  f.native.assertCurrent = () => late.promise;
  assert.equal((await f.run()).kind, "unavailable");
  let closed = false;
  const close = f.router.close().then(() => {
    closed = true;
  });
  await new Promise(setImmediate);
  assert.equal(closed, false);
  assert.equal(count(f, "native-close"), 0);
  late.reject(Error("late fence"));
  await close;
  assert.equal(count(f, "native-close"), 1);
});
test("acquired bundle release is retained before a throwing bytes getter", async () => {
  const f = await fixture();
  Object.defineProperty(f.bundle, "bytes", {
    get() {
      throw Error("getter");
    },
  });
  assert.equal((await f.run()).kind, "unavailable");
  await finish(f);
  assert.equal(count(f, "bundle-release"), 1);
  assert.equal(count(f, "write"), 0);
});
for (const owner of ["parent", "nativeAbort", "scopeAbort", "bundleAbort"])
  test(`${owner} loss during a pending read owns the late buffer`, async () => {
    const f = await fixture(),
      late = deferred();
    f.options.source.readSelected = async () => {
      f.events.push("read");
      return late.promise;
    };
    f.rebuild();
    const pending = f.run();
    await until(() => count(f, "read") === 1);
    f[owner].abort();
    // bundleAbort is watched once the actual late bundle is acquired.
    if (owner !== "bundleAbort") assert.equal((await pending).kind, "unavailable");
    late.resolve(f.bundle);
    assert.equal((await pending).kind, "unavailable");
    await finish(f);
    assert.equal(count(f, "write"), 0);
    assert.equal(count(f, "bundle-release"), 1);
    assert.equal(count(f, "native-close"), 1);
  });
test("a timed-out read retains its occupied slot and close joins subsequent cleanup", async () => {
  const f = await fixture(),
    late = deferred();
  f.bounds.deadline = new Date(Date.now() + 40).toISOString();
  f.options.source.readSelected = async () => {
    f.events.push("read");
    return late.promise;
  };
  f.rebuild();
  const first = f.run();
  await until(() => count(f, "read") === 1);
  assert.equal((await first).kind, "unavailable");
  // The monotonic timer can refuse before the wall deadline. Give this
  // separate retry an explicitly expired deadline to exercise input denial.
  f.bounds.deadline = "2000-01-01T00:00:00.000Z";
  assert.equal((await f.run()).kind, "denied");
  // A fresh deadline still cannot enter the occupied factory.
  f.bounds.deadline = "2099-01-01T00:00:00.000Z";
  assert.equal((await f.run()).kind, "unavailable");
  assert.equal(count(f, "inspect"), 1);
  const close = f.router.close();
  assert.equal(f.router.close(), close);
  late.resolve(f.bundle);
  await close;
  assert.equal(count(f, "bundle-release"), 1);
  assert.equal(count(f, "write"), 0);
});
for (const method of ["recheckCurrent", "confirmDisclosure"])
  test(`${method} failure cannot disclose`, async () => {
    const f = await fixture();
    f.scope[method] = async () => {
      throw Error("current/audit unavailable");
    };
    assert.equal(
      (await f.run()).kind,
      method === "confirmDisclosure" ? "recovery-required" : "unavailable",
    );
    await finish(f);
    assert.equal(count(f, "write"), 0);
  });
test("confirm returning an unexpected value refuses the write", async () => {
  const f = await fixture();
  f.scope.confirmDisclosure = async () => true;
  // Confirmation now occurs inside the native attempt, before its guarded write.
  assert.equal((await f.run()).kind, "recovery-required");
  await finish(f);
  assert.equal(count(f, "write"), 0);
});
for (const mode of ["skip", "wrong-header", "replay", "foreign"])
  test(`native ${mode} permit cannot yield a delivered response`, async () => {
    const f = await fixture();
    f.native.disclose = async (header, payload, permit) => {
      if (mode === "skip") return;
      if (mode === "wrong-header")
        f.router.consumeDisclosure(permit, f.native, { ...header }, payload);
      if (mode === "foreign") f.router.consumeDisclosure({}, f.native, header, payload);
      if (mode === "replay") {
        payload.encodeInto(new Uint8Array(payload.byteLength));
        await f.router.confirmDisclosure(permit, f.native, header, payload);
        f.router.consumeDisclosure(permit, f.native, header, payload);
        f.router.consumeDisclosure(permit, f.native, header, payload);
      }
      assert.fail("invalid disclosure should throw");
    };
    assert.equal((await f.run()).kind, "recovery-required");
    await finish(f);
    assert.equal(count(f, "write"), 0);
  });
test("a caught invalid permit attempt poisons its original disclosure", async () => {
  const f = await fixture();
  f.native.disclose = async (header, payload, permit) => {
    assert.throws(() => f.router.consumeDisclosure(permit, f.native, { ...header }, payload));
    assert.throws(() => f.router.consumeDisclosure(permit, f.native, header, payload));
  };
  assert.equal((await f.run()).kind, "recovery-required");
  await finish(f);
});
test("current owner cannot return a positive result without entering its held scope", async () => {
  const f = await fixture();
  f.options.current.withCurrent = async () => ({ kind: "delivered" });
  f.rebuild();
  assert.equal((await f.run()).kind, "unavailable");
  await finish(f);
  assert.equal(count(f, "read"), 0);
});
test("unawaited held-scope work is poisoned and drained before native cleanup", async () => {
  const f = await fixture(),
    late = deferred();
  f.options.source.readSelected = async () => {
    f.events.push("read");
    return late.promise;
  };
  f.options.current.withCurrent = async (_r, _n, _b, work) => {
    void work(f.scope);
    await until(() => count(f, "read") === 1);
    return { kind: "delivered" };
  };
  f.rebuild();
  assert.equal((await f.run()).kind, "unavailable");
  assert.equal(count(f, "native-close"), 0);
  late.resolve(f.bundle);
  await finish(f);
  assert.equal(count(f, "write"), 0);
  assert.equal(count(f, "bundle-release"), 1);
});
test("a stored callback is closed when its current owner returns", async () => {
  const f = await fixture();
  let saved;
  f.options.current.withCurrent = async (_r, _n, _b, work) => {
    saved = work;
    return { kind: "unavailable" };
  };
  f.rebuild();
  assert.equal((await f.run()).kind, "unavailable");
  await assert.rejects(saved(f.scope));
  await finish(f);
  assert.equal(count(f, "read"), 0);
  assert.equal(count(f, "native-close"), 1);
});
test("caught repeated scope entry still poisons the original command", async () => {
  const f = await fixture();
  f.options.current.withCurrent = async (_r, _n, _b, work) => {
    const result = await work(f.scope);
    await assert.rejects(work(f.scope));
    return result;
  };
  f.rebuild();
  assert.equal((await f.run()).kind, "recovery-required");
  await finish(f);
  assert.equal(count(f, "read"), 1);
});
test("normal release invalidations after a settled disclosure preserve delivered history", async () => {
  const f = await fixture();
  f.bundle.release = async () => {
    f.events.push("bundle-release");
    f.bundleAbort.abort();
  };
  f.native.close = async () => {
    f.events.push("native-close");
    f.nativeAbort.abort();
  };
  assert.equal((await f.run()).kind, "delivered");
  await finish(f);
});
for (const label of ["bundle", "native"])
  test(`${label} cleanup failure after disclosure retains recovery-required`, async () => {
    const f = await fixture();
    f[label][label === "bundle" ? "release" : "close"] = async () => {
      f.events.push(`${label}-failed`);
      throw Error("cleanup failed");
    };
    assert.equal((await f.run()).kind, "recovery-required");
    await finish(f);
    assert.equal(count(f, "write"), 1);
    assert.equal(count(f, `${label}-failed`), 1);
  });
for (const bytes of [
  new Uint8Array(0),
  new Uint8Array(28673),
  new Uint8Array(new ArrayBuffer(32769), 0, 1),
])
  test(`invalid bundle ${bytes.byteLength}/${bytes.buffer.byteLength}/${bytes.buffer.constructor.name} is released without write`, async () => {
    const f = await fixture();
    f.bundle.bytes = bytes;
    assert.equal((await f.run()).kind, "unavailable");
    await finish(f);
    assert.equal(count(f, "write"), 0);
    assert.equal(count(f, "bundle-release"), 1);
  });
test("maximum selected binary bundle encodes directly into the native-owned target", async () => {
  const f = await fixture();
  f.bundle.bytes = new Uint8Array(28672);
  let target;
  f.bundle.withEncodedPayload = async (work) =>
    work({
      byteLength: f.bundle.bytes.byteLength,
      backingByteLength: f.bundle.bytes.buffer.byteLength,
      encodeInto(value) {
        target = value;
        value.set(f.bundle.bytes);
      },
    });
  assert.equal((await f.run()).kind, "delivered");
  assert.notEqual(target.buffer, f.bundle.bytes.buffer);
  assert.equal(target.byteLength, 28672);
  await finish(f);
});
test("original proof cannot retry or remint disclosure after a completed call", async () => {
  const f = await fixture(),
    proof = {};
  assert.equal((await f.run(f.request, proof)).kind, "delivered");
  assert.equal((await f.run(f.request, proof)).kind, "denied");
  assert.equal(count(f, "read"), 1);
  await finish(f);
});
test("missing actual Teams token supplier refuses without alternate credentials", async () => {
  const f = await fixture();
  f.request.use = "teams-invocation-token";
  f.options.source.readSelected = async () => {
    f.events.push("read");
    throw Error("qualified Teams supplier unavailable");
  };
  f.rebuild();
  assert.equal((await f.run()).kind, "unavailable");
  await finish(f);
  assert.equal(count(f, "write"), 0);
});
test("zero remaining source lifetime denies before disclosure", async () => {
  const f = await fixture();
  f.bundle.remainingMs = () => 0;
  assert.equal((await f.run()).kind, "unavailable");
  await finish(f);
  assert.equal(count(f, "write"), 0);
});
test("expired original deadline refuses before native acquisition", async () => {
  const f = await fixture();
  f.bounds.deadline = "2000-01-01T00:00:00.000Z";
  assert.equal((await f.run()).kind, "denied");
  assert.deepEqual(f.events, []);
  await finish(f);
});
test("closed coordinator never reopens or acquires another participant", async () => {
  const f = await fixture();
  await finish(f);
  assert.equal((await f.run()).kind, "unavailable");
  assert.deepEqual(f.events, []);
});

for (const mode of [
  "no-encoding",
  "no-confirmation",
  "duplicate-encoding",
  "wrong-target-size",
  "shared-target",
  "oversized-frame",
])
  test(`native ${mode} cannot cross the disclosure boundary`, async () => {
    const f = await fixture();
    f.native.disclose = async (header, payload, permit) => {
      if (mode === "no-encoding") {
        await f.router.confirmDisclosure(permit, f.native, header, payload);
        return;
      }
      const target =
        mode === "wrong-target-size"
          ? new Uint8Array(payload.byteLength + 1)
          : mode === "shared-target"
            ? new Uint8Array(new SharedArrayBuffer(payload.byteLength))
            : mode === "oversized-frame"
              ? new Uint8Array(new ArrayBuffer(32769), 0, payload.byteLength)
              : new Uint8Array(payload.byteLength);
      payload.encodeInto(target);
      if (mode === "duplicate-encoding") payload.encodeInto(target);
      f.router.consumeDisclosure(permit, f.native, header, payload);
    };
    assert.equal((await f.run()).kind, "recovery-required");
    await finish(f);
    assert.equal(count(f, "write"), 0);
  });
test("the CRD borrowed callback rejects an uncertain native write rather than reporting fulfilled use", async () => {
  const f = await fixture();
  let rejection = false,
    fulfilled = false;
  const borrow = f.bundle.withEncodedPayload;
  f.bundle.withEncodedPayload = async (work) =>
    borrow(async (payload) => {
      try {
        await work(payload);
        fulfilled = true;
      } catch (error) {
        rejection = true;
        throw error;
      }
    });
  f.native.disclose = async () => {
    throw Error("write settlement unknown");
  };
  assert.equal((await f.run()).kind, "recovery-required");
  await finish(f);
  assert.equal(rejection, true);
  assert.equal(fulfilled, false);
});
test("borrow interval remains open through write and source/current cleanup", async () => {
  const f = await fixture(),
    written = deferred();
  let open = false;
  const borrow = f.bundle.withEncodedPayload,
    disclose = f.native.disclose;
  f.bundle.withEncodedPayload = async (work) => {
    open = true;
    try {
      return await borrow(work);
    } finally {
      open = false;
      f.events.push("borrow-closed");
    }
  };
  f.native.disclose = async (...args) => {
    assert.equal(open, true);
    await disclose(...args);
    await written.promise;
    assert.equal(open, true);
  };
  const pending = f.run();
  await until(() => count(f, "write") === 1);
  assert.equal(open, true);
  assert.equal(count(f, "bundle-release"), 0);
  written.resolve();
  assert.equal((await pending).kind, "delivered");
  await finish(f);
  assert.ok(f.events.indexOf("borrow-closed") < f.events.indexOf("bundle-release"));
});
test("unawaited disclosure confirmation is retained before the borrowed interval closes", async () => {
  const f = await fixture(),
    confirmation = deferred();
  let closed = false;
  f.scope.confirmDisclosure = async () => {
    f.events.push("confirm");
    await confirmation.promise;
  };
  const borrow = f.bundle.withEncodedPayload;
  f.bundle.withEncodedPayload = async (work) => {
    try {
      await borrow(work);
    } finally {
      closed = true;
    }
  };
  f.native.disclose = async (header, payload, permit) => {
    payload.encodeInto(new Uint8Array(payload.byteLength));
    void f.router.confirmDisclosure(permit, f.native, header, payload);
    await until(() => count(f, "confirm") === 1);
  };
  assert.equal((await f.run()).kind, "recovery-required");
  assert.equal(closed, false);
  assert.equal(count(f, "bundle-release"), 0);
  confirmation.resolve();
  await finish(f);
  assert.equal(closed, true);
  assert.equal(count(f, "write"), 0);
});
test("unawaited source borrow cannot release pending native work as known completion", async () => {
  const f = await fixture(),
    written = deferred();
  let saved;
  f.bundle.withEncodedPayload = async (work) => {
    saved = work({
      byteLength: 3,
      backingByteLength: 3,
      encodeInto(target) {
        target.set([1, 2, 3]);
      },
    });
    await until(() => count(f, "write") === 1);
  };
  const disclose = f.native.disclose;
  f.native.disclose = async (...args) => {
    await disclose(...args);
    await written.promise;
  };
  const pending = f.run();
  assert.equal((await pending).kind, "recovery-required");
  assert.equal(count(f, "bundle-release"), 0);
  written.resolve();
  await saved.catch(() => {});
  await finish(f);
  assert.equal(count(f, "bundle-release"), 1);
});
test("a captured encoder cannot be reused outside the original borrowed interval", async () => {
  const f = await fixture();
  let captured;
  const disclose = f.native.disclose;
  f.native.disclose = async (header, payload, permit) => {
    captured = payload;
    await disclose(header, payload, permit);
  };
  assert.equal((await f.run()).kind, "delivered");
  await finish(f);
  assert.throws(() => captured.encodeInto(new Uint8Array(captured.byteLength)));
});

const acceptanceChanges = {
  unrelatedAcceptance: (c) => {
    c.submission.previousOperationRef = "unrelated-acceptance";
  },
  malformedAudit: (c) => {
    c.acceptance.auditEventId = "";
  },
  extraPredecessorField: (c) => {
    c.acceptance.predecessor.unowned = "value";
  },
  missingSettlement: (c) => {
    c.acceptance.predecessor.settlement = null;
  },
  malformedDisposition: (c) => {
    c.acceptance.predecessor.disposition.recordVersion = 0;
  },
  wrongPreviousGeneration: (c) => {
    c.acceptance.predecessor.previousStartup = c.acceptance.binding.startup;
  },
};
for (const [name, change] of Object.entries(acceptanceChanges))
  test(`acceptance ${name} refuses before physical material acquisition`, async () => {
    const f = await fixture();
    f.scope.current = structuredClone(f.scope.current);
    change(f.scope.current);
    assert.equal((await f.run()).kind, "unavailable");
    await finish(f);
    assert.equal(count(f, "read"), 0);
    assert.equal(count(f, "native-close"), 1);
  });
test("resizable native frame is rejected before the original encoder or write", async () => {
  const f = await fixture();
  f.native.disclose = async (header, payload, permit) => {
    const target = new Uint8Array(new ArrayBuffer(payload.byteLength, { maxByteLength: 65536 }));
    payload.encodeInto(target);
    await f.router.confirmDisclosure(permit, f.native, header, payload);
    f.router.consumeDisclosure(permit, f.native, header, payload);
    f.events.push("write");
  };
  assert.equal((await f.run()).kind, "recovery-required");
  await finish(f);
  assert.equal(count(f, "encode"), 0);
  assert.equal(count(f, "write"), 0);
});

test("a real replacement generation retains its original predecessor and can disclose", async () => {
  const f = await fixture(true);
  assert.equal(f.request.startup.processGeneration, 2);
  assert.equal(f.scope.current.acceptance.predecessor.previousStartup.processGeneration, 1);
  assert.equal((await f.run()).kind, "delivered");
  await finish(f);
  assert.equal(count(f, "read"), 1);
  assert.equal(count(f, "write"), 1);
});
