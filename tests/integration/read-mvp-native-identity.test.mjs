import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
  assertRefused,
  deferred,
  inspectOriginal,
  nativeTestOptions,
  openRead,
  refusingNativeConsumer,
  selectedNativeAssembly,
  waitForAbort,
} from "../fixtures/read-mvp/native-session.mjs";
import { signal } from "../fixtures/runtime-service-trust.mjs";

// Real native/TLS and InMemory State/IAM identity boundaries. The operation
// consumer always refuses: these cases prove no clone, Work, custody or release.
test(
  "READ native V3 caller stream close retires its original Session and a fresh session rejects stale bindings",
  nativeTestOptions(3),
  async (t) => {
    const ready = deferred();
    const retired = deferred();
    let previous;
    let inspected = 0;
    const consumer = refusingNativeConsumer(async ({ source, request, call }) => {
      const current = await inspectOriginal(source, request, call);
      inspected++;
      if (!previous) {
        previous = current;
        ready.resolve(current);
        // A remote stream close must cancel original identity lifetime, not
        // merely a manually narrowed AbortSignal supplied by this consumer.
        await waitForAbort(current.held.signal);
        assert.equal(call.signal.aborted, true);
        assert.ok(Date.now() < Date.parse(call.deadline) - 250);
        retired.resolve();
        return;
      }
      assert.notEqual(current.held.context, previous.held.context);
      assert.notEqual(current.held.transportBinding, previous.held.transportBinding);
      assert.notEqual(current.observed.sessionRef, previous.observed.sessionRef);
      assert.throws(() => source.assertCurrent(previous.held, call));
      assert.throws(() =>
        source.assertCurrent(current.held, { ...call, context: previous.held.context }),
      );
      assert.throws(() =>
        source.assertCurrent(current.held, { ...call, recipientRef: "recipient/crossed" }),
      );
      source.assertCurrent(current.held, call);
      await source.release(current.held);
    });
    const assembly = await selectedNativeAssembly(t, consumer.factory, 3);
    const { external, trust, serviceIdentityRef } = assembly;
    assert.equal(
      (await external.command("connect", { session: "read-caller" }).wait("connected")).kind,
      "connected",
    );
    const pending = external.command("request", {
      session: "read-caller",
      metadata: openRead(3),
    });
    const original = await consumer.waitFor(ready.promise);
    assert.ok(Date.parse(original.call.deadline) - Date.now() > 1750);
    assert.equal(
      (await external.command("close", { session: "read-caller" }).wait("closed")).kind,
      "closed",
    );
    assert.equal((await pending.wait("response")).kind, "failed");
    await consumer.waitFor(retired.promise);
    assert.ok(await trust.readCurrentRecord(serviceIdentityRef, signal()));

    // The same accepting owner remains usable. A fresh real TLS connection
    // receives new opaque identities even with the same attachment and repo.
    assert.equal(
      (await external.command("connect", { session: "read-fresh" }).wait("connected")).kind,
      "connected",
    );
    const request = openRead(3);
    const response = await external
      .command("request", { session: "read-fresh", metadata: request })
      .wait("response");
    consumer.assertHealthy();
    assertRefused(response, request);
    assert.equal(inspected, 2);
    assert.equal(
      (await external.command("close", { session: "read-fresh" }).wait("closed")).kind,
      "closed",
    );
  },
);

test(
  "READ native V3 Workload API loss cancels a held Session while service admission remains current",
  nativeTestOptions(3),
  async (t) => {
    const ready = deferred();
    const retired = deferred();
    let inspected = 0;
    const consumer = refusingNativeConsumer(async ({ source, request, call }) => {
      const original = await inspectOriginal(source, request, call);
      inspected++;
      ready.resolve(original);
      await waitForAbort(original.held.signal);
      assert.equal(call.signal.aborted, true);
      assert.ok(Date.now() < Date.parse(call.deadline) - 250);
      assert.throws(() => source.assertCurrent(original.held, call));
      retired.resolve();
    });
    const { external, trust, serviceIdentityRef } = await selectedNativeAssembly(
      t,
      consumer.factory,
      3,
    );
    assert.equal(
      (await external.command("connect", { session: "read-identity-loss" }).wait("connected")).kind,
      "connected",
    );
    const pending = external.command("request", {
      session: "read-identity-loss",
      metadata: openRead(3),
    });
    const original = await consumer.waitFor(ready.promise);
    assert.ok(Date.parse(original.call.deadline) - Date.now() > 1750);
    // This command stops the real external Workload API watch; it does not
    // synthesize a signal or withdraw the original registry's admission.
    assert.equal((await external.command("withdraw").wait("withdrawn")).kind, "withdrawn");
    await consumer.waitFor(retired.promise);
    assert.equal((await pending.wait("response")).kind, "failed");
    assert.ok(await trust.readCurrentRecord(serviceIdentityRef, signal()));
    assert.equal(inspected, 1);
    consumer.assertHealthy();
    assert.equal(
      (await external.command("close", { session: "read-identity-loss" }).wait("closed")).kind,
      "closed",
    );
    assert.equal(
      (await external.command("connect", { session: "read-after-loss" }).wait("connected")).kind,
      "failed",
    );
  },
);

test(
  "READ native V3 joined close waits for active consumer cleanup and actual native retirement",
  nativeTestOptions(3),
  async (t) => {
    const ready = deferred();
    const cancelled = deferred();
    const cleanup = deferred();
    let finished = false;
    const consumer = refusingNativeConsumer(async ({ source, request, call }) => {
      const original = await inspectOriginal(source, request, call);
      ready.resolve(original);
      await waitForAbort(call.signal);
      assert.equal(original.held.signal.aborted, true);
      cancelled.resolve();
      // A contract consumer deliberately retains cleanup after cancellation.
      // The actual endpoint's joined close must wait for that original work.
      await cleanup.promise;
      await source.release(original.held);
      finished = true;
    });
    const { external, endpoint } = await selectedNativeAssembly(t, consumer.factory, 3);
    assert.equal(
      (await external.command("connect", { session: "read-joined" }).wait("connected")).kind,
      "connected",
    );
    const pending = external.command("request", { session: "read-joined", metadata: openRead(3) });
    await consumer.waitFor(ready.promise);
    let settled = false;
    const stopping = endpoint.close();
    stopping.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      assert.equal(endpoint.close(), stopping);
      await consumer.waitFor(cancelled.promise);
      await setImmediate();
      assert.equal(finished, false);
      assert.equal(settled, false, "close must join the still-held consumer cleanup");
    } finally {
      cleanup.resolve();
      await stopping;
    }
    consumer.assertHealthy();
    assert.equal(finished, true);
    assert.equal((await pending.wait("response")).kind, "failed");
    const peer = await external
      .command("peer-state", { session: "read-joined" })
      .wait("peer-state");
    assert.equal(peer.kind, "peer-state");
    assert.equal(peer.state, "exited");
    assert.equal(
      (await external.command("close", { session: "read-joined" }).wait("closed")).kind,
      "closed",
    );
  },
);

test(
  "READ native V2 rejects a V3 request before its consumer and accepts a fresh V2 refusal",
  nativeTestOptions(2),
  async (t) => {
    let inspected = 0;
    const consumer = refusingNativeConsumer(async ({ source, request, call }) => {
      assert.equal(request.version, 2);
      const original = await inspectOriginal(source, request, call);
      await source.release(original.held);
      inspected++;
    });
    const { external } = await selectedNativeAssembly(t, consumer.factory, 2);
    assert.equal(
      (await external.command("connect", { session: "read-crossed-v2" }).wait("connected")).kind,
      "connected",
    );
    assert.equal(
      (
        await external
          .command("request", { session: "read-crossed-v2", metadata: openRead(3) })
          .wait("response")
      ).kind,
      "failed",
    );
    assert.equal(inspected, 0);
    assert.equal(
      (await external.command("close", { session: "read-crossed-v2" }).wait("closed")).kind,
      "closed",
    );
    assert.equal(
      (await external.command("connect", { session: "read-original-v2" }).wait("connected")).kind,
      "connected",
    );
    const request = openRead(2);
    const response = await external
      .command("request", { session: "read-original-v2", metadata: request })
      .wait("response");
    consumer.assertHealthy();
    assertRefused(response, request);
    assert.equal(inspected, 1);
    assert.equal(
      (await external.command("close", { session: "read-original-v2" }).wait("closed")).kind,
      "closed",
    );
  },
);
