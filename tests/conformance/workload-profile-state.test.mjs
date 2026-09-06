import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  profileStorageFixture,
  inertProfileRequest,
  profileActorFixture,
} from "../fixtures/workload-profile.mjs";
import {
  PROFILE_ALLOCATION_KINDS,
  decodeStoredProfilePreparation,
  InvalidProfileOperationError,
  profileAllocatedIdentities,
  profileActor,
} from "../../packages/occ/src/workload-profiles/types.ts";
import {
  ProfileOperationConflictError,
  ProfileOperationCapacityError,
} from "../../packages/occ/src/workload-profiles/repository.ts";

test("inert preparation retains canonical request and stable identities without approval", async () => {
  const f = profileStorageFixture();
  const record = await f.transact((repo) => repo.prepareOperation(f.request, f.actor));
  assert.equal(record.kind, "inert-profile-preparation");
  assert.equal(record.scope.installationId, f.installationId);
  assert.equal(record.actor.accountRef, f.actor.accountRef);
  assert.deepEqual(JSON.parse(record.canonicalClientIntent), f.request);
  assert.notEqual(record.operationDigest, record.clientIntentDigest);
  assert.equal(f.allocations, PROFILE_ALLOCATION_KINDS.length);
  assert.equal(Object.hasOwn(record, "authority"), false);
  assert.equal(Object.hasOwn(record, "approved"), false);
  assert.ok(Object.isFrozen(record) && Object.isFrozen(record.allocated));
  const read = await f.transact((repo) => repo.findOperation(f.locator()));
  assert.deepEqual(read, record);
  assert.notEqual(read, record);
});
test("exact replay and reconstructed repository reuse allocations and original preparation time", async () => {
  const f = profileStorageFixture();
  const first = await f.transact((repo) => repo.prepareOperation(f.request, f.actor));
  const second = await f.transact((repo) =>
    repo.prepareOperation(structuredClone(f.request), structuredClone(f.actor)),
  );
  assert.deepEqual(second, first);
  assert.equal(f.allocations, PROFILE_ALLOCATION_KINDS.length);
  assert.equal(f.clockReads, 1);
  assert.equal(f.snapshot.operations.size, 1);
});
test("different bytes under an original actor operation conflict without reminting", async () => {
  const f = profileStorageFixture();
  await f.transact((repo) => repo.prepareOperation(f.request, f.actor));
  const changed = inertProfileRequest({
    ...f.request,
    action: "replace",
    expectedAdmission: {
      manifestRef: randomUUID(),
      admissionRef: randomUUID(),
      admissionVersion: 1,
      manifestDigest: f.request.manifest.manifestDigest,
    },
  });
  await assert.rejects(
    f.transact((repo) => repo.prepareOperation(changed, f.actor)),
    ProfileOperationConflictError,
  );
  assert.equal(f.allocations, PROFILE_ALLOCATION_KINDS.length);
  assert.equal(f.snapshot.operations.size, 1);
});
test("current readback key is exact Installation, original principal, account and operation", async () => {
  const f = profileStorageFixture();
  await f.transact((repo) => repo.prepareOperation(f.request, f.actor));
  for (const locator of [
    f.locator(randomUUID()),
    f.locator(undefined, profileActorFixture()),
    f.locator(undefined, { ...f.actor, accountRef: "different-account" }),
    f.locator(undefined, f.actor, `ins_${randomUUID()}`),
  ])
    assert.equal(await f.transact((repo) => repo.findOperation(locator)), undefined);
  assert.equal(f.allocations, PROFILE_ALLOCATION_KINDS.length);
});
test("another actor can use the same correlation UUID without adopting identities", async () => {
  const f = profileStorageFixture();
  const a = await f.transact((repo) => repo.prepareOperation(f.request, f.actor));
  const b = await f.transact((repo) => repo.prepareOperation(f.request, profileActorFixture()));
  assert.notDeepEqual(a.allocated, b.allocated);
  assert.equal(f.snapshot.operations.size, 2);
});
test("changed account on the same principal cannot replay or replace an original operation", async () => {
  const f = profileStorageFixture();
  await f.transact((repo) => repo.prepareOperation(f.request, f.actor));
  await assert.rejects(
    f.transact((repo) => repo.prepareOperation(f.request, { ...f.actor, accountRef: "other" })),
    ProfileOperationConflictError,
  );
  assert.equal(f.allocations, PROFILE_ALLOCATION_KINDS.length);
});
test("opaque attribution and allocated UUIDs reject trailing control characters", async () => {
  const f = profileStorageFixture();
  for (const actor of [
    { ...f.actor, accountRef: `${f.actor.accountRef}\n` },
    { ...f.actor, principalRef: `${f.actor.principalRef}\r` },
  ])
    await assert.rejects(
      f.transact((repo) => repo.prepareOperation(f.request, actor)),
      InvalidProfileOperationError,
    );
  assert.equal(f.allocations, 0);
  const record = await f.transact((repo) => repo.prepareOperation(f.request, f.actor));
  assert.throws(
    () =>
      profileAllocatedIdentities({
        ...record.allocated,
        manifestRef: `${record.allocated.manifestRef}\n`,
      }),
    InvalidProfileOperationError,
  );
});
test("exotic actor and allocated-identity inputs cannot lose fields during immutable copying", async () => {
  const f = profileStorageFixture();
  for (const exotic of [new Date("2026-01-01T00:00:00.000Z"), new Map()]) {
    Object.setPrototypeOf(exotic, Object.prototype);
    Object.assign(exotic, f.actor);
    assert.throws(() => profileActor(exotic), InvalidProfileOperationError);
    await assert.rejects(
      f.transact((repo) => repo.prepareOperation(f.request, exotic)),
      InvalidProfileOperationError,
    );
  }
  assert.equal(f.allocations, 0);
  assert.equal(f.snapshot.operations.size, 0);
  const stored = await f.transact((repo) => repo.prepareOperation(f.request, f.actor));
  for (const exotic of [new Date("2026-01-01T00:00:00.000Z"), new Map()]) {
    Object.setPrototypeOf(exotic, Object.prototype);
    Object.assign(exotic, stored.allocated);
    assert.throws(() => profileAllocatedIdentities(exotic), InvalidProfileOperationError);
  }
});
test("caught invalid second preparation poisons the complete adapter working unit", async () => {
  const f = profileStorageFixture();
  await assert.rejects(
    f.transact(async (repo) => {
      await repo.prepareOperation(f.request, f.actor);
      await assert.rejects(repo.prepareOperation({ ...f.request, operationRef: "bad" }, f.actor));
    }),
    InvalidProfileOperationError,
  );
  assert.equal(f.snapshot.operations.size, 0);
  assert.equal(f.snapshot.capacities.size, 0);
});
test("caught replay conflict prevents an earlier write in the same working unit from committing", async () => {
  const f = profileStorageFixture();
  await assert.rejects(
    f.transact(async (repo) => {
      await repo.prepareOperation(f.request, f.actor);
      const changed = { ...f.request, namespaceId: `ns_${randomUUID()}` };
      await assert.rejects(repo.prepareOperation(changed, f.actor), ProfileOperationConflictError);
    }),
    ProfileOperationConflictError,
  );
  assert.equal(f.snapshot.operations.size, 0);
});
test("concurrent same-unit replay is serialized before allocator execution", async () => {
  const f = profileStorageFixture();
  const results = await f.transact((repo) =>
    Promise.all(Array.from({ length: 20 }, () => repo.prepareOperation(f.request, f.actor))),
  );
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(f.allocations, PROFILE_ALLOCATION_KINDS.length);
  assert.equal(f.snapshot.operations.size, 1);
});
test("ordinary pending quota does not evict retained history or charge exact replay", async () => {
  const f = profileStorageFixture();
  for (let index = 0; index < 32; index++)
    await f.transact((repo) =>
      repo.prepareOperation(
        { ...f.request, operationRef: index === 0 ? f.request.operationRef : randomUUID() },
        f.actor,
      ),
    );
  const before = f.allocations;
  await f.transact((repo) => repo.prepareOperation(f.request, f.actor));
  await assert.rejects(
    f.transact((repo) =>
      repo.prepareOperation({ ...f.request, operationRef: randomUUID() }, f.actor),
    ),
    ProfileOperationCapacityError,
  );
  assert.equal(f.snapshot.operations.size, 32);
  assert.equal(f.allocations, before);
  assert.equal(f.snapshot.capacities.get(f.installationId).terminalSlots, 0);
});
test("unknown Namespace fails before ID allocation", async () => {
  const f = profileStorageFixture();
  await assert.rejects(
    f.transact((repo) =>
      repo.prepareOperation({ ...f.request, namespaceId: `ns_${randomUUID()}` }, f.actor),
    ),
    ProfileOperationConflictError,
  );
  assert.equal(f.allocations, 0);
});
test("retained Namespace lifecycle must be ready and nondeleted before allocation", async () => {
  for (const lifecycle of [
    { status: "provisioning" },
    { status: "failed" },
    { status: "deleting" },
    { status: "deleting", deletedAt: "2026-09-06T01:00:00.000Z" },
    { status: "ready", deletedAt: "2026-09-06T01:00:00.000Z" },
  ]) {
    const f = profileStorageFixture(lifecycle);
    await assert.rejects(
      f.transact((repo) => repo.prepareOperation(f.request, f.actor)),
      ProfileOperationConflictError,
    );
    assert.equal(f.allocations, 0);
    assert.equal(f.snapshot.operations.size, 0);
    assert.equal(f.snapshot.capacities.size, 0);
  }
});
for (const [name, change] of [
  ["caller account", (r) => ({ ...r, accountRef: "untrusted" })],
  ["caller Installation", (r) => ({ ...r, installationId: `ins_${randomUUID()}` })],
  [
    "wrong digest",
    (r) => ({ ...r, manifest: { ...r.manifest, manifestDigest: `sha256:${"0".repeat(64)}` } }),
  ],
  [
    "duplicate manifest key",
    (r) => ({ ...r, manifest: { ...r.manifest, canonicalUtf8: '{"candidate":1,"candidate":2}' } }),
  ],
  [
    "noncanonical bytes",
    (r) => ({ ...r, manifest: { ...r.manifest, canonicalUtf8: '{ "candidate":"unqualified"}' } }),
  ],
  ["manifest null", (r) => ({ ...r, manifest: { ...r.manifest, canonicalUtf8: "null" } })],
])
  test(`invalid ${name} is rejected before retention or allocation`, async () => {
    const f = profileStorageFixture();
    await assert.rejects(f.transact((repo) => repo.prepareOperation(change(f.request), f.actor)));
    assert.equal(f.allocations, 0);
    assert.equal(f.snapshot.operations.size, 0);
  });
test("closed transaction rejects escaped repository use", async () => {
  const f = profileStorageFixture();
  let escaped;
  await f.transact(async (repo) => {
    escaped = repo;
  });
  await assert.rejects(escaped.prepareOperation(f.request, f.actor), /closed/);
  await assert.rejects(escaped.findOperation(f.locator()), /closed/);
  assert.equal(f.allocations, 0);
});
test("retained decoder recomputes exact operation and client-intent bindings", async () => {
  const f = profileStorageFixture();
  const stored = await f.transact((repo) => repo.prepareOperation(f.request, f.actor));
  assert.deepEqual(decodeStoredProfilePreparation(structuredClone(stored)), stored);
  for (const change of [
    { action: "replace" },
    { operationRef: randomUUID() },
    { preparedAt: "2026-09-07T00:00:00.000Z" },
    { clientIntentDigest: `sha256:${"0".repeat(64)}` },
    { operationDigest: stored.clientIntentDigest },
    { actor: { ...stored.actor, accountRef: "other-account" } },
    { scope: { ...stored.scope, namespaceId: `ns_${randomUUID()}` } },
    { allocated: { ...stored.allocated, manifestRef: randomUUID() } },
    { authority: true },
  ])
    assert.throws(() => decodeStoredProfilePreparation({ ...stored, ...change }));
  let invoked = 0;
  const accessor = { ...stored };
  Object.defineProperty(accessor, "scope", {
    enumerable: true,
    get() {
      invoked++;
      return stored.scope;
    },
  });
  assert.throws(() => decodeStoredProfilePreparation(accessor));
  assert.equal(invoked, 0);
});
