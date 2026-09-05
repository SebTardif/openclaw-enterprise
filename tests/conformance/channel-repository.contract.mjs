import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ScopeViolationError, ResourceConflictError } from "../../packages/occ/src/errors.ts";
import {
  channelAudit,
  channelRecords,
  seedChannelOwner,
} from "./channel-binding-store.contract.mjs";

export async function assertChannelRepositoryClosed(repository, records, writable = true) {
  const { app, human, route } = records;
  const reads = [
    () => repository.findChannelInstallation(app.id),
    () => repository.listChannelInstallations({ limit: 1 }),
    () => repository.findHumanBinding(app.id, human.id),
    () => repository.findHumanBindingBySubject(app.id, human.providerSubjectRef),
    () => repository.listHumanBindings(app.id, { limit: 1 }),
    () => repository.findAgentBinding(app.id, route.id),
    () => repository.findAgentBindingByChannel(app.id, route.channelRef),
    () => repository.listAgentBindings(app.id, { limit: 1 }),
  ];
  const writes = [
    () => repository.createChannelInstallation(app),
    () => repository.createHumanBinding(human),
    () => repository.createAgentBinding(route),
    () => repository.setChannelInstallationStatus(app.id, 1, "disabled", "admin", app.updatedAt),
    () => repository.setHumanBindingStatus(app.id, human.id, 1, "disabled", "admin", app.updatedAt),
    () => repository.setAgentBindingStatus(app.id, route.id, 1, "disabled", "admin", app.updatedAt),
  ];
  for (const operation of writable ? [...reads, ...writes] : reads)
    await assert.rejects(operation(), ScopeViolationError);
}

/** Requires an empty store and leaves it empty, including the singleton Installation. */
export async function verifyChannelRepositoryBootstrap(store) {
  assert.equal(await store.read((s) => s.installations.getInstallation()), undefined);
  const installation = {
    id: `ins_${randomUUID()}`,
    name: "Channel repository bootstrap",
    createdAt: new Date().toISOString(),
  };
  const records = channelRecords({
    installation,
    namespace: { id: "unused" },
    agent: { id: "unused" },
  });
  const rollback = new Error("rollback channel bootstrap");
  let retained;
  await assert.rejects(
    store.transact(async (s) => {
      retained = s.channelBindings;
      // The repository exists before bootstrap; empty reads cannot require an Installation scope.
      assert.deepEqual(await retained.listChannelInstallations({ limit: 1 }), []);
      assert.equal(await retained.findChannelInstallation(records.app.id), undefined);
      await s.installations.createInstallation(installation);
      assert.deepEqual(await retained.createChannelInstallation(records.app), records.app);
      assert.deepEqual(await retained.findChannelInstallation(records.app.id), records.app);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  assert.equal(await store.read((s) => s.installations.getInstallation()), undefined);
  assert.deepEqual(
    await store.read((s) => s.channelBindings.listChannelInstallations({ limit: 1 })),
    [],
  );
  await assertChannelRepositoryClosed(retained, records);
}

export async function verifyChannelRepositoryLifetime(store) {
  const owner = await seedChannelOwner(store);
  const records = channelRecords(owner);
  let committed;
  let admitted;
  await store.transact(async (s) => {
    committed = s.channelBindings;
    // All three calls are admitted before callback return. Children wait behind
    // their parent's create in the real aggregate serializer and must still run.
    admitted = Promise.allSettled([
      committed.createChannelInstallation(records.app),
      committed.createHumanBinding(records.human),
      committed.createAgentBinding(records.route),
    ]);
  });
  const results = await admitted;
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "fulfilled", "fulfilled"],
  );
  let read;
  await store.read(async (s) => {
    read = s.channelBindings;
    assert.equal(Object.hasOwn(read, "createChannelInstallation"), false);
    assert.deepEqual(await read.findChannelInstallation(records.app.id), records.app);
    assert.deepEqual(await read.findHumanBinding(records.app.id, records.human.id), records.human);
    assert.deepEqual(await read.findAgentBinding(records.app.id, records.route.id), records.route);
  });
  await assertChannelRepositoryClosed(committed, records);
  await assertChannelRepositoryClosed(read, records, false);

  const rolled = channelRecords(owner);
  const rollback = new Error("rollback accepted channel operations");
  let rejected;
  let draining;
  await assert.rejects(
    store.transact(async (s) => {
      rejected = s.channelBindings;
      draining = Promise.allSettled([
        rejected.createChannelInstallation(rolled.app),
        rejected.createHumanBinding(rolled.human),
        rejected.createAgentBinding(rolled.route),
      ]);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  assert.deepEqual(
    (await draining).map((result) => result.status),
    ["fulfilled", "fulfilled", "fulfilled"],
  );
  await assertChannelRepositoryClosed(rejected, rolled);
  await store.read(async (s) => {
    assert.equal(await s.channelBindings.findChannelInstallation(rolled.app.id), undefined);
    assert.equal(
      await s.channelBindings.findHumanBinding(rolled.app.id, rolled.human.id),
      undefined,
    );
    assert.equal(
      await s.channelBindings.findAgentBinding(rolled.app.id, rolled.route.id),
      undefined,
    );
  });
}

export async function verifyChannelRepositoryAtomicity(store) {
  const owner = await seedChannelOwner(store);
  for (const outcome of ["commit", "callback failure", "audit failure"]) {
    const records = channelRecords(owner);
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `Channel atomicity ${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    const operation = {
      kind: "namespace",
      action: "reconcile",
      target: "ready",
      namespaceId: namespace.id,
      resourceId: namespace.id,
      actorId: "channel-test-admin",
    };
    const audit = channelAudit(owner);
    const rollback = new Error("rollback channel resource audit and work");
    let retained;
    const write = store.transact(async (s) => {
      retained = s.channelBindings;
      await s.namespaces.createNamespace(namespace);
      await s.channelBindings.createChannelInstallation(records.app);
      await s.channelBindings.createHumanBinding(records.human);
      await s.channelBindings.createAgentBinding(records.route);
      await s.operations.append(operation);
      await s.audit.append(audit);
      if (outcome === "audit failure")
        await s.audit.append({ ...channelAudit(owner), installationId: `ins_${randomUUID()}` });
      if (outcome === "callback failure") throw rollback;
    });
    if (outcome === "commit") await write;
    else if (outcome === "callback failure")
      await assert.rejects(write, (error) => error === rollback);
    else await assert.rejects(write);
    const committed = outcome === "commit";
    await store.read(async (s) => {
      assert.deepEqual(
        await s.namespaces.findNamespace(namespace.id),
        committed ? namespace : undefined,
      );
      assert.deepEqual(
        await s.channelBindings.findChannelInstallation(records.app.id),
        committed ? records.app : undefined,
      );
      assert.deepEqual(
        await s.channelBindings.findHumanBinding(records.app.id, records.human.id),
        committed ? records.human : undefined,
      );
      assert.deepEqual(
        await s.channelBindings.findAgentBinding(records.app.id, records.route.id),
        committed ? records.route : undefined,
      );
      assert.deepEqual(
        (await s.operations.list()).filter((item) => item.resourceId === namespace.id),
        committed ? [operation] : [],
      );
      assert.deepEqual(
        (await s.audit.list()).filter((item) => item.id === audit.id),
        committed ? [audit] : [],
      );
    });
    await assertChannelRepositoryClosed(retained, records);
  }
}

export async function verifyChannelRepositoryDeletingNamespaceTarget(store) {
  const owner = await seedChannelOwner(store);
  const { app, route } = channelRecords(owner);
  const deleting = {
    id: `ns_${randomUUID()}`,
    name: `Empty deleting channel target ${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  await store.transact(async (s) => {
    await s.channelBindings.createChannelInstallation(app);
    await s.namespaces.createNamespace(deleting);
    // Production deletion requires an empty Namespace. Keep the real Agent in
    // its ready owner and transition only this empty Namespace toward deletion.
    await s.namespaces.transitionNamespaceStatus(deleting.id, "ready", "deleting");
  });
  // The target is both deleting and missing the requested Agent, which belongs
  // to another Namespace. This proves fail-closed routing for those combined
  // conditions; it does not independently isolate the Namespace readiness guard.
  await assert.rejects(
    store.transact((s) =>
      s.channelBindings.createAgentBinding({ ...route, namespaceId: deleting.id }),
    ),
    ResourceConflictError,
  );
  await store.read(async (s) => {
    assert.equal((await s.namespaces.findNamespace(deleting.id)).status, "deleting");
    assert.equal((await s.namespaces.findNamespace(owner.namespace.id)).status, "ready");
    assert.equal(await s.channelBindings.findAgentBinding(app.id, route.id), undefined);
  });
}
