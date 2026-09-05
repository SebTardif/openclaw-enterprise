import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ResourceConflictError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import {
  channelAudit,
  channelRecords,
  seedChannelOwner,
} from "./channel-binding-store.contract.mjs";

export const namespaceRecord = (overrides = {}) => ({
  id: `ns_${randomUUID()}`,
  name: `Namespace É ${randomUUID()}`,
  status: "provisioning",
  createdAt: new Date().toISOString(),
  ...overrides,
});

export function namespaceChildren(namespace) {
  const configuration = {
    id: `cfg_${randomUUID()}`,
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt: namespace.createdAt,
  };
  return {
    configuration,
    agent: {
      id: `agt_${randomUUID()}`,
      namespaceId: namespace.id,
      name: `Namespace owner ${randomUUID()}`,
      configurationId: configuration.id,
      providerId: null,
      executionMode: "embedded",
      servicePrincipalId: randomUUID(),
      createdAt: namespace.createdAt,
    },
    account: {
      id: `sa_${randomUUID()}`,
      namespaceId: namespace.id,
      name: `Account ${randomUUID()}`,
    },
    secret: {
      id: `sec_${randomUUID()}`,
      namespaceId: namespace.id,
      name: `key-${randomUUID()}`,
      driverId: "kubernetes-secret",
      backendRef: {
        namespaceName: `ns-${randomUUID()}`,
        name: "model.credentials",
        key: "value",
        uid: randomUUID(),
      },
      createdAt: namespace.createdAt,
    },
  };
}

export async function assertNamespaceRepositoryClosed(repository, namespace, writable = true) {
  const reads = [() => repository.findNamespace(namespace.id), () => repository.listNamespaces()];
  const writes = [
    () => repository.createNamespace(namespace),
    () => repository.lockNamespace(namespace.id),
    () => repository.lockNamespace(namespace.id, { includeDeleted: true }),
    ...["hasAgents", "hasConfigurations", "hasServiceAccounts", "hasSecrets"].map(
      (method) => () => repository[method](namespace.id),
    ),
    () => repository.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
    () => repository.markNamespaceDeleted(namespace.id, namespace.createdAt),
  ];
  for (const operation of writable ? [...reads, ...writes] : reads)
    await assert.rejects(operation(), ScopeViolationError);
}

/** An independently migrated empty store is required; the bootstrap is rolled back. */
export async function verifyNamespaceRepositoryBootstrap(store) {
  assert.equal(await store.read((s) => s.installations.getInstallation()), undefined);
  const namespace = namespaceRecord();
  const installation = {
    id: `ins_${randomUUID()}`,
    name: "Namespace bootstrap",
    createdAt: namespace.createdAt,
  };
  const rollback = new Error("rollback Namespace bootstrap");
  let retained;
  await assert.rejects(
    store.transact(async (s) => {
      retained = s.namespaces;
      assert.deepEqual(await retained.listNamespaces(), []);
      assert.equal(await retained.findNamespace(namespace.id), undefined);
      assert.equal(await retained.lockNamespace(namespace.id), undefined);
      for (const method of ["hasAgents", "hasConfigurations", "hasServiceAccounts", "hasSecrets"])
        assert.equal(await retained[method](namespace.id), false);
      await assert.rejects(retained.createNamespace(namespace), ScopeViolationError);
      await s.installations.createInstallation(installation);
      assert.deepEqual(await retained.createNamespace(namespace), namespace);
      assert.deepEqual(await retained.findNamespace(namespace.id), namespace);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  assert.equal(await store.read((s) => s.installations.getInstallation()), undefined);
  assert.deepEqual(await store.read((s) => s.namespaces.listNamespaces()), []);
  await assertNamespaceRepositoryClosed(retained, namespace);
}

export async function verifyNamespaceRepositoryLifecycle(store) {
  await seedChannelOwner(store);
  const namespace = namespaceRecord({ existingNamespace: `external-${randomUUID()}` });
  const write = (fn) => store.transact((s) => fn(s.namespaces));
  const created = await write((r) => r.createNamespace(namespace));
  assert.deepEqual(created, namespace);
  assert.ok(Object.isFrozen(created));
  for (const duplicate of [
    namespace,
    { ...namespace, id: `ns_${randomUUID()}` },
    namespaceRecord({ existingNamespace: namespace.existingNamespace }),
  ])
    await assert.rejects(
      write((r) => r.createNamespace(duplicate)),
      ResourceConflictError,
    );
  await assert.rejects(
    write((r) => r.createNamespace(namespaceRecord({ existingNamespace: "Invalid_Name" }))),
    ScopeViolationError,
  );
  assert.equal(
    await write((r) => r.transitionNamespaceStatus(namespace.id, "failed", "deleting")),
    undefined,
  );
  assert.equal(
    await write((r) => r.markNamespaceDeleted(namespace.id, namespace.createdAt)),
    undefined,
  );
  assert.equal(
    (
      await write((r) =>
        r.transitionNamespaceStatus(namespace.id, ["provisioning", "failed"], "ready"),
      )
    ).status,
    "ready",
  );
  await assert.rejects(
    write((r) => r.transitionNamespaceStatus(namespace.id, "ready", "provisioning")),
    ScopeViolationError,
  );
  // Only this empty Namespace enters deletion. No Agent deletion API is assumed.
  await write((r) => r.transitionNamespaceStatus(namespace.id, "ready", "deleting"));
  await assert.rejects(
    write((r) => r.markNamespaceDeleted(namespace.id, "2000-01-01T00:00:00.000Z")),
    ScopeViolationError,
  );
  const deletedAt = new Date().toISOString();
  const tombstone = await write((r) => r.markNamespaceDeleted(namespace.id, deletedAt));
  assert.deepEqual(tombstone, { ...namespace, status: "deleting", deletedAt });
  assert.ok(Object.isFrozen(tombstone));
  assert.deepEqual(
    await write((r) =>
      r.markNamespaceDeleted(namespace.id, new Date(Date.now() + 1000).toISOString()),
    ),
    tombstone,
  );
  assert.equal(await write((r) => r.lockNamespace(namespace.id)), undefined);
  assert.deepEqual(
    await write((r) => r.lockNamespace(namespace.id, { includeDeleted: true })),
    tombstone,
  );
  assert.equal(
    await write((r) => r.transitionNamespaceStatus(namespace.id, "deleting", "ready")),
    undefined,
  );
  await store.read(async (s) => {
    assert.equal(await s.namespaces.findNamespace(namespace.id), undefined);
    const listed = await s.namespaces.listNamespaces();
    assert.ok(Object.isFrozen(listed));
    assert.equal(
      listed.some((item) => item.id === namespace.id),
      false,
    );
  });
  // Names remain reserved, while external placement is available after teardown.
  await assert.rejects(
    write((r) => r.createNamespace(namespaceRecord({ name: namespace.name }))),
    ResourceConflictError,
  );
  const replacement = namespaceRecord({ existingNamespace: namespace.existingNamespace });
  assert.deepEqual(await write((r) => r.createNamespace(replacement)), replacement);
  const failed = namespaceRecord();
  await write((r) => r.createNamespace(failed));
  await write((r) => r.transitionNamespaceStatus(failed.id, "provisioning", "failed"));
  await write((r) => r.transitionNamespaceStatus(failed.id, ["ready", "failed"], "deleting"));
  assert.equal(
    (await write((r) => r.markNamespaceDeleted(failed.id, new Date().toISOString()))).status,
    "deleting",
  );
}

export async function verifyNamespaceRepositoryChildren(store) {
  await seedChannelOwner(store);
  const namespace = namespaceRecord({ status: "ready" });
  const empty = namespaceRecord();
  const children = namespaceChildren(namespace);
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(namespace);
    await s.namespaces.createNamespace(empty);
    for (const method of ["hasAgents", "hasConfigurations", "hasServiceAccounts", "hasSecrets"])
      assert.equal(await s.namespaces[method](namespace.id), false);
    await s.configurations.createConfiguration(children.configuration);
    assert.equal(await s.namespaces.hasConfigurations(namespace.id), true);
    await s.agents.createAgent(children.agent);
    assert.equal(await s.namespaces.hasAgents(namespace.id), true);
    await s.serviceAccounts.createServiceAccount(children.account);
    assert.equal(await s.namespaces.hasServiceAccounts(namespace.id), true);
    await s.secrets.createSecret(children.secret);
    assert.equal(await s.namespaces.hasSecrets(namespace.id), true);
    for (const method of ["hasAgents", "hasConfigurations", "hasServiceAccounts", "hasSecrets"])
      assert.equal(await s.namespaces[method](empty.id), false);
  });
  await store.transact(async (s) => {
    for (const method of ["hasAgents", "hasConfigurations", "hasServiceAccounts", "hasSecrets"])
      assert.equal(await s.namespaces[method](namespace.id), true);
  });
}

export async function verifyNamespaceRepositoryLifetime(store) {
  await seedChannelOwner(store);
  for (const commit of [true, false]) {
    const namespace = namespaceRecord({ status: "ready" });
    const { configuration } = namespaceChildren(namespace);
    let retained;
    let accepted;
    const rollback = new Error("rollback admitted Configuration creation");
    const result = store.transact(async (s) => {
      retained = s.namespaces;
      await retained.createNamespace(namespace);
      // Configuration creation awaits an internal Namespace lock. Callback return
      // closes outward admissions, but must not revoke that accepted operation.
      accepted = Promise.allSettled([s.configurations.createConfiguration(configuration)]);
      if (!commit) throw rollback;
    });
    if (commit) await result;
    else await assert.rejects(result, (error) => error === rollback);
    assert.deepEqual(await accepted, [{ status: "fulfilled", value: configuration }]);
    await assertNamespaceRepositoryClosed(retained, namespace);
    let read;
    await store.read(async (s) => {
      read = s.namespaces;
      assert.deepEqual(Object.keys(read).sort(), ["findNamespace", "listNamespaces"]);
      assert.deepEqual(await read.findNamespace(namespace.id), commit ? namespace : undefined);
      assert.deepEqual(
        await s.configurations.findConfiguration(namespace.id, configuration.id),
        commit ? configuration : undefined,
      );
    });
    await assertNamespaceRepositoryClosed(read, namespace, false);
  }
}

export async function verifyNamespaceRepositoryAtomicity(store) {
  const owner = await seedChannelOwner(store);
  for (const outcome of ["commit", "callback failure", "audit failure"]) {
    const namespace = namespaceRecord({ status: "ready" });
    const children = namespaceChildren(namespace);
    const records = channelRecords({ ...owner, namespace, agent: children.agent });
    const audit = {
      ...channelAudit(owner),
      namespaceId: namespace.id,
      action: "create",
      resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
    };
    const operation = {
      kind: "namespace",
      action: "reconcile",
      target: "ready",
      namespaceId: namespace.id,
      resourceId: namespace.id,
      actorId: audit.actorId,
    };
    const rollback = new Error("rollback Namespace resource audit work and channel");
    const result = store.transact(async (s) => {
      await s.namespaces.createNamespace(namespace);
      await s.configurations.createConfiguration(children.configuration);
      await s.agents.createAgent(children.agent);
      await s.channelBindings.createChannelInstallation(records.app);
      await s.channelBindings.createAgentBinding(records.route);
      await s.operations.append(operation);
      await s.audit.append(audit);
      if (outcome === "audit failure")
        await s.audit.append({ ...channelAudit(owner), installationId: `ins_${randomUUID()}` });
      if (outcome === "callback failure") throw rollback;
    });
    if (outcome === "commit") await result;
    else if (outcome === "callback failure")
      await assert.rejects(result, (error) => error === rollback);
    else await assert.rejects(result, ScopeViolationError);
    const commit = outcome === "commit";
    await store.read(async (s) => {
      assert.deepEqual(
        await s.namespaces.findNamespace(namespace.id),
        commit ? namespace : undefined,
      );
      assert.deepEqual(
        await s.configurations.findConfiguration(namespace.id, children.configuration.id),
        commit ? children.configuration : undefined,
      );
      assert.deepEqual(
        await s.agents.findAgent(namespace.id, children.agent.id),
        commit ? children.agent : undefined,
      );
      assert.deepEqual(
        await s.channelBindings.findChannelInstallation(records.app.id),
        commit ? records.app : undefined,
      );
      assert.deepEqual(
        await s.channelBindings.findAgentBinding(records.app.id, records.route.id),
        commit ? records.route : undefined,
      );
      assert.deepEqual(
        (await s.audit.list()).filter((item) => item.id === audit.id),
        commit ? [audit] : [],
      );
      assert.deepEqual(
        (await s.operations.list()).filter((item) => item.resourceId === namespace.id),
        commit ? [operation] : [],
      );
    });
  }
}
