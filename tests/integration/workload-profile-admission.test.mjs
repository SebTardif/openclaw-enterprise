import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { NativeIAMDriver, bindNativeIAMTransaction } from "../../packages/iam/src/index.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { createWorkloadProfileService } from "../../packages/occ/src/services/workload-profile/service.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import { inertProfileRequest } from "../fixtures/workload-profile.mjs";

// No positive account participant is invented. These are actual source denials,
// runtime custody checks and memory non-equivalence, without any database access.
test("profile service remains unavailable without the authentic account participant", async () => {
  const service = createWorkloadProfileService();
  const request = inertProfileRequest();
  for (const handle of [{}, Object.freeze({ principalId: "claimed", allowed: true }), null]) {
    const signal = new AbortController().signal;
    for (const [method, args] of [
      ["prepare", [handle, request, signal]],
      ["readOperation", [handle, request.operationRef, signal]],
      ["accept", [handle, request.operationRef, signal]],
      ["withdraw", [handle, request.operationRef, {}, signal]],
      ["readProfile", [handle, request.operationRef, signal]],
    ])
      await assert.rejects(service[method](...args), DependencyUnavailableError);
  }
});

test("memory storage cannot supply authenticated account transaction parity", async () => {
  const state = new InMemoryPlatformState();
  const selection = new DriverSelection();
  const service = createWorkloadProfileService({ state, selection });
  await assert.rejects(
    service.prepare({}, inertProfileRequest(), new AbortController().signal),
    DependencyUnavailableError,
  );
  assert.throws(
    () => createWorkloadProfileService({ state, selection, account: { consume() {} } }),
    DependencyUnavailableError,
  );
});

test("transactional native IAM requires real private instance and same-store correspondence", async (t) => {
  // Creating an unconnected pool does not probe or use a PostgreSQL resource.
  const pool = new pg.Pool({ connectionTimeoutMillis: 250, max: 1 });
  const otherPool = new pg.Pool({ connectionTimeoutMillis: 250, max: 1 });
  t.after(async () => {
    await pool.end();
    await otherPool.end();
  });
  const state = new PostgresPlatformState(pool);
  const other = new PostgresPlatformState(otherPool);
  const native = new NativeIAMDriver(state);
  const token = Object.freeze({});
  for (const driver of [null, {}, { ...native }, Object.create(NativeIAMDriver.prototype)])
    assert.throws(() => bindNativeIAMTransaction(driver, state, token), TypeError);
  assert.throws(() => bindNativeIAMTransaction(native, other, token), TypeError);
  const view = bindNativeIAMTransaction(native, state, token);
  await assert.rejects(
    view.lookupIdentity({ issuer: "fixture", subject: "fixture" }),
    DependencyUnavailableError,
  );
  await assert.rejects(
    view.authorize({
      principalId: "fixture",
      action: "read",
      resource: { kind: "installation", id: "fixture" },
    }),
    DependencyUnavailableError,
  );
  assert.equal(pool.totalCount, 0);
  native.id = "changed-after-binding";
  assert.throws(() => view.assertCurrent(), TypeError);
});

test("actual DriverSelection retains the exact native instance until its hold is released", async (t) => {
  const pool = new pg.Pool({ connectionTimeoutMillis: 250, max: 1 });
  t.after(() => pool.end());
  const state = new PostgresPlatformState(pool);
  const first = new NativeIAMDriver(state, { id: "profile-iam-first" });
  const second = new NativeIAMDriver(state, { id: "profile-iam-second" });
  const selection = new DriverSelection();
  selection.registerDriver(first);
  selection.registerDriver(second);
  selection.selectDriver("iam", first.id);
  const held = selection.acquireGuardedSelection("iam", first);
  assert.throws(() => selection.selectDriver("iam", second.id));
  held.assertCurrent();
  held.release();
  assert.equal(selection.selectDriver("iam", second.id), second);
  assert.throws(() => held.assertCurrent());
});
