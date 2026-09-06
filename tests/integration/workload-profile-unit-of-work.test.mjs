import { createMemoryWorkloadProfile } from "../../packages/occ/src/state/memory/workload-profile.ts";
import { WorkloadProfileTransactionGuard } from "../../packages/occ/src/workload-profiles/repository.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { PROFILE_ALLOCATION_KINDS } from "../../packages/occ/src/workload-profiles/types.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { InvalidProfileOperationError } from "../../packages/occ/src/workload-profiles/types.ts";
import {
  ProfileOperationConflictError,
  ProfileOperationCapacityError,
} from "../../packages/occ/src/workload-profiles/repository.ts";
import { workloadProfileDigest } from "../../packages/occ/src/workload-profiles/canonical.ts";
import { inertProfileRequest, profileActorFixture } from "../fixtures/workload-profile.mjs";

async function fixture(status = "ready") {
  const state = new InMemoryPlatformState();
  const installation = {
    id: `ins_${randomUUID()}`,
    name: "Profile unit",
    createdAt: new Date().toISOString(),
  };
  const namespace = {
    id: `ns_${randomUUID()}`,
    name: "Profile namespace",
    status,
    createdAt: new Date().toISOString(),
  };
  await state.transact(async (unit) => {
    await unit.installations.createInstallation(installation);
    await unit.namespaces.createNamespace(namespace);
  });
  const request = inertProfileRequest({ namespaceId: namespace.id });
  const actor = profileActorFixture();
  const locator = { installationId: installation.id, actor, operationRef: request.operationRef };
  return {
    state,
    installation,
    namespace,
    request,
    actor,
    locator,
    prepare: () => state.transact((unit) => unit.workloadProfiles.prepareOperation(request, actor)),
    read: () => state.read((view) => view.workloadProfiles.findOperation(locator)),
  };
}

test("public memory profile preparation retains exact immutable actor-bound history", async () => {
  const f = await fixture();
  const retained = await f.prepare();
  assert.deepEqual(await f.prepare(), retained);
  assert.deepEqual(await f.read(), retained);
  assert.ok(Object.isFrozen(retained));
  assert.ok(Object.isFrozen(retained.allocated));
  assert.equal(retained.kind, "inert-profile-preparation");
  for (const locator of [
    { ...f.locator, installationId: `ins_${randomUUID()}` },
    { ...f.locator, actor: { ...f.actor, accountRef: `other/${randomUUID()}` } },
    { ...f.locator, actor: profileActorFixture() },
  ])
    assert.equal(
      await f.state.read((view) => view.workloadProfiles.findOperation(locator)),
      undefined,
    );
  await assert.rejects(
    f.state.transact((unit) =>
      unit.workloadProfiles.prepareOperation(f.request, { ...f.actor, accountRef: "other" }),
    ),
    ProfileOperationConflictError,
  );
  assert.deepEqual(await f.read(), retained);
});

test("public memory competing transactions retain one exact preparation", async () => {
  const f = await fixture();
  const results = await Promise.all([f.prepare(), f.prepare(), f.prepare()]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
});

test("owner drains an unawaited accepted preparation before publication", async () => {
  const f = await fixture();
  let started;
  await f.state.transact(async (unit) => {
    started = unit.workloadProfiles.prepareOperation(f.request, f.actor);
  });
  assert.deepEqual(await f.read(), await started);
});

test("caught and unawaited invalid preparation poisons the actual owner", async () => {
  for (const caught of [true, false]) {
    const f = await fixture();
    let operation;
    await assert.rejects(
      f.state.transact(async (unit) => {
        operation = unit.workloadProfiles.prepareOperation({ ...f.request, extra: true }, f.actor);
        if (caught) await assert.rejects(operation, InvalidProfileOperationError);
        else void operation.catch(() => {});
      }),
      InvalidProfileOperationError,
    );
    await assert.rejects(operation, InvalidProfileOperationError);
    assert.equal(await f.read(), undefined);
    assert.ok(await f.prepare(), "later fresh transaction remains usable");
  }
});

test("outer callback failure discards a completed preparation", async () => {
  const f = await fixture();
  const failure = new Error("outer callback failure");
  await assert.rejects(
    f.state.transact(async (unit) => {
      await unit.workloadProfiles.prepareOperation(f.request, f.actor);
      throw failure;
    }),
    (e) => e === failure,
  );
  assert.equal(await f.read(), undefined);
});

test("escaped methods and read projections cannot mutate after owner completion", async () => {
  const f = await fixture();
  let repository;
  await f.state.transact(async (unit) => {
    repository = unit.workloadProfiles;
  });
  await assert.rejects(repository.prepareOperation(f.request, f.actor), ScopeViolationError);
  await assert.rejects(repository.findOperation(f.locator), ScopeViolationError);
  await f.state.read(async (view) => {
    assert.equal(view.workloadProfiles.prepareOperation, undefined);
    repository = view.workloadProfiles;
  });
  await assert.rejects(repository.findOperation(f.locator), ScopeViolationError);
  assert.equal(await f.read(), undefined);
});

test("chained late preparation cannot escape the draining owner", async () => {
  const f = await fixture();
  let next;
  let first;
  await assert.rejects(
    f.state.transact(async (unit) => {
      first = unit.workloadProfiles.prepareOperation(f.request, f.actor);
      next = first.then(() =>
        unit.workloadProfiles.prepareOperation(
          inertProfileRequest({ namespaceId: f.namespace.id }),
          f.actor,
        ),
      );
      void next.catch(() => {});
    }),
    ScopeViolationError,
  );
  await first;
  await assert.rejects(next, ScopeViolationError);
  assert.equal(await f.read(), undefined);
});

test("prior unrelated repository work prohibits preparation and rolls back the whole unit", async () => {
  const f = await fixture();
  const namespace = { ...f.namespace, id: `ns_${randomUUID()}`, name: "Rollback namespace" };
  await assert.rejects(
    f.state.transact(async (unit) => {
      await unit.namespaces.createNamespace(namespace);
      await assert.rejects(
        unit.workloadProfiles.prepareOperation(f.request, f.actor),
        ScopeViolationError,
      );
    }),
    ScopeViolationError,
  );
  assert.equal(
    await f.state.read((view) => view.namespaces.findNamespace(namespace.id)),
    undefined,
  );
  assert.equal(await f.read(), undefined);
});

test("subsequent unrelated work and second preparation poison an otherwise completed unit", async () => {
  for (const operation of [
    (unit) => unit.namespaces.lockNamespace("missing"),
    (unit) => unit.workloadProfiles.prepareOperation({}, profileActorFixture()),
  ]) {
    const f = await fixture();
    await assert.rejects(
      f.state.transact(async (unit) => {
        await unit.workloadProfiles.prepareOperation(f.request, f.actor);
        await assert.rejects(operation(unit), ScopeViolationError);
      }),
      ScopeViolationError,
    );
    assert.equal(await f.read(), undefined);
  }
});

test("Installation lookup and exact history lookup remain usable in the preparation unit", async () => {
  const f = await fixture();
  const retained = await f.state.transact(async (unit) => {
    assert.equal((await unit.installations.getInstallation()).id, f.installation.id);
    const retained = await unit.workloadProfiles.prepareOperation(f.request, f.actor);
    assert.deepEqual(await unit.workloadProfiles.findOperation(f.locator), retained);
    assert.equal((await unit.installations.getInstallation()).id, f.installation.id);
    return retained;
  });
  assert.deepEqual(await f.read(), retained);
});

test("actual Namespace lifecycle controls preparation, not fixture eligibility flags", async () => {
  for (const status of ["provisioning", "failed", "deleting"]) {
    const f = await fixture(status);
    await assert.rejects(f.prepare(), ProfileOperationConflictError);
    assert.equal(await f.read(), undefined);
  }
});

test("uninitialized public state cannot prepare and caught rejection is rollback-only", async () => {
  const state = new InMemoryPlatformState();
  await assert.rejects(
    state.transact(async (unit) => {
      await assert.rejects(
        unit.workloadProfiles.prepareOperation(inertProfileRequest(), profileActorFixture()),
        ScopeViolationError,
      );
    }),
    ScopeViolationError,
  );
});

test("semantically invalid manifest poisons actual public preparation without a retained result", async () => {
  const f = await fixture();
  const input = {
    ...f.request,
    manifest: {
      format: "oce.workload-profile.canonical-json.v1",
      canonicalUtf8: '{"candidate":"unqualified"}',
      manifestDigest: workloadProfileDigest("manifestDigest", { candidate: "unqualified" }),
    },
  };
  await assert.rejects(
    f.state.transact(async (unit) => {
      await assert.rejects(unit.workloadProfiles.prepareOperation(input, f.actor));
    }),
  );
  assert.equal(await f.read(), undefined);
  assert.ok(await f.prepare(), "a failed candidate never occupies its preknown locator");
});

test("actual memory capacity permits exact replay at exhaustion and retains no overflow operation", async () => {
  const f = await fixture();
  const original = await f.prepare();
  for (let count = 1; count < 32; count++)
    await f.state.transact((unit) =>
      unit.workloadProfiles.prepareOperation(
        inertProfileRequest({ namespaceId: f.namespace.id }),
        f.actor,
      ),
    );
  const overflow = inertProfileRequest({ namespaceId: f.namespace.id });
  await assert.rejects(
    f.state.transact((unit) => unit.workloadProfiles.prepareOperation(overflow, f.actor)),
    ProfileOperationCapacityError,
  );
  assert.equal(
    await f.state.read((view) =>
      view.workloadProfiles.findOperation({ ...f.locator, operationRef: overflow.operationRef }),
    ),
    undefined,
  );
  assert.deepEqual(await f.prepare(), original);
});

test("actual memory adapter rejects each same-kind reservation collision before changing its snapshot", async (t) => {
  const f = await fixture();
  // Fault injection is limited to the adapter's existing allocator dependency.
  // The real repository, manifest decoder and snapshot adapter perform every check.
  const snapshot = {
    operations: new Map(),
    capacities: new Map(),
    namespaces: new Map([[f.namespace.id, f.namespace]]),
  };
  const open = (allocator) => {
    const lifetime = new RepositoryTransactionLifetime();
    const guard = new WorkloadProfileTransactionGuard();
    const repository = createMemoryWorkloadProfile(
      { scope: { installationId: f.installation.id }, transaction: lifetime, snapshot },
      guard,
      allocator,
    );
    return { repository, guard, lifetime };
  };
  const initial = open();
  const original = await initial.repository.prepareOperation(f.request, f.actor);
  await initial.guard.finish();
  await initial.lifetime.finish();
  const before = structuredClone(snapshot);
  for (const collisionKind of PROFILE_ALLOCATION_KINDS)
    await t.test(collisionKind, async () => {
      const unit = open({
        allocate: (kind) => (kind === collisionKind ? original.allocated[kind] : randomUUID()),
      });
      const request = inertProfileRequest({ namespaceId: f.namespace.id });
      try {
        await assert.rejects(
          unit.repository.prepareOperation(request, profileActorFixture()),
          ProfileOperationConflictError,
        );
        await assert.rejects(unit.guard.finish(), ProfileOperationConflictError);
        assert.deepEqual(snapshot, before);
      } finally {
        await unit.lifetime.finish();
      }
    });
  const replay = open({
    allocate: () => {
      throw new Error("replay must not allocate");
    },
  });
  assert.deepEqual(await replay.repository.prepareOperation(f.request, f.actor), original);
  await replay.guard.finish();
  await replay.lifetime.finish();
});
