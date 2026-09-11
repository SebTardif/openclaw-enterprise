import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ResourceConflictError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { namespaceRecord, namespaceChildren } from "./namespace-repository.contract.mjs";

export function configurationResources(overrides = {}) {
  const namespace = namespaceRecord({ status: "ready", ...overrides });
  return { namespace, ...namespaceChildren(namespace) };
}

export function configurationBindings(secret, destination = "SERVICE_TOKEN") {
  return {
    [destination]: {
      source: { kind: "secret", namespaceId: secret.namespaceId, id: secret.id },
      delivery: { type: "env" },
    },
  };
}

export async function seedConfigurationInstallation(store) {
  const existing = await store.read((s) => s.installations.getInstallation());
  if (existing) return existing;
  return store.transact((s) =>
    s.installations.createInstallation({
      id: `ins_${randomUUID()}`,
      name: `Configuration storage ${randomUUID()}`,
      createdAt: new Date().toISOString(),
    }),
  );
}

export async function assertConfigurationRepositoryClosed(
  repository,
  configuration,
  writable = true,
  closedMessage = "The platform transaction is closed.",
) {
  const { namespaceId, id, generation } = configuration;
  const operations = [() => repository.findConfiguration(namespaceId, id)];
  if (writable)
    operations.push(
      () => repository.createConfiguration(configuration),
      () => repository.lockConfiguration(namespaceId, id),
      () => repository.advanceConfigurationGeneration(namespaceId, id, generation),
      () => repository.deleteConfiguration(namespaceId, id),
    );
  for (const operation of operations)
    await assert.rejects(operation(), (error) => {
      assert.ok(error instanceof ScopeViolationError);
      assert.equal(error.message, closedMessage);
      return true;
    });
}

/** Requires an independently migrated empty store; this bootstrap is rolled back. */
export async function verifyConfigurationRepositoryBootstrap(store) {
  assert.equal(await store.read((s) => s.installations.getInstallation()), undefined);
  const { namespace, configuration, secret } = configurationResources({ status: "provisioning" });
  const installation = {
    id: `ins_${randomUUID()}`,
    name: "Configuration same-unit bootstrap",
    createdAt: namespace.createdAt,
  };
  const bound = { ...configuration, secretBindings: configurationBindings(secret) };
  const rollback = new Error("rollback Configuration bootstrap");
  let retained;
  await assert.rejects(
    store.transact(async (s) => {
      retained = s.configurations;
      assert.equal(await retained.findConfiguration(namespace.id, configuration.id), undefined);
      assert.equal(await retained.lockConfiguration(namespace.id, configuration.id), undefined);
      assert.equal(
        await retained.advanceConfigurationGeneration(namespace.id, configuration.id, 1),
        undefined,
      );
      assert.equal(await retained.deleteConfiguration(namespace.id, configuration.id), false);
      await assert.rejects(retained.createConfiguration(bound), {
        name: "ScopeViolationError",
        message: "The server-owned Installation has not been initialized.",
      });
      // The repository was assembled before the singleton existed. Its owner
      // supplies live scope and the Secret created in this exact unit of work.
      await s.installations.createInstallation(installation);
      await s.namespaces.createNamespace(namespace);
      await s.secrets.createSecret(secret);
      assert.deepEqual(await retained.createConfiguration(bound), bound);
      assert.deepEqual(await retained.lockConfiguration(namespace.id, configuration.id), bound);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  await store.read(async (s) => {
    assert.equal(await s.installations.getInstallation(), undefined);
    assert.equal(await s.namespaces.findNamespace(namespace.id), undefined);
    assert.equal(await s.secrets.findSecret(namespace.id, secret.id), undefined);
    assert.equal(
      await s.configurations.findConfiguration(namespace.id, configuration.id),
      undefined,
    );
  });
  // Aggregate mutations close at the outer lifecycle admission boundary.
  await assertConfigurationRepositoryClosed(
    retained,
    configuration,
    true,
    "The lifecycle transaction is closed.",
  );
}

export async function verifyConfigurationRepositoryOwnership(store) {
  await seedConfigurationInstallation(store);
  const owner = configurationResources();
  const foreign = configurationResources({ status: "provisioning" });
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(owner.namespace);
    await s.namespaces.createNamespace(foreign.namespace);
    assert.deepEqual(
      await s.configurations.createConfiguration(owner.configuration),
      owner.configuration,
    );
    await s.configurations.createConfiguration(foreign.configuration);
  });
  const { namespaceId, id } = owner.configuration;
  const write = (work) => store.transact((s) => work(s.configurations));
  for (const namespace of [foreign.namespace, configurationResources().namespace]) {
    await store.read(async (s) => {
      assert.equal(await s.configurations.findConfiguration(namespace.id, id), undefined);
    });
    assert.equal(await write((r) => r.lockConfiguration(namespace.id, id)), undefined);
    assert.equal(
      await write((r) => r.advanceConfigurationGeneration(namespace.id, id, 1)),
      undefined,
    );
    assert.equal(await write((r) => r.deleteConfiguration(namespace.id, id)), false);
  }
  // Configuration identity is global even though every access requires exact Namespace ownership.
  for (const candidate of [
    owner.configuration,
    { ...owner.configuration, namespaceId: foreign.namespace.id },
  ])
    await assert.rejects(
      write((r) => r.createConfiguration(candidate)),
      ResourceConflictError,
    );
  for (const invalid of [
    { kind: "gateway" },
    { generation: 0 },
    { generation: -1 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
  ])
    await assert.rejects(
      write((r) =>
        r.createConfiguration({ ...owner.configuration, id: `cfg_${randomUUID()}`, ...invalid }),
      ),
      ScopeViolationError,
    );
  for (const status of ["failed", "deleting", "deleted", "missing"]) {
    const resources = configurationResources({ status: "provisioning" });
    if (status !== "missing")
      await store.transact(async (s) => {
        await s.namespaces.createNamespace(resources.namespace);
        await s.namespaces.transitionNamespaceStatus(
          resources.namespace.id,
          "provisioning",
          status === "failed" ? "failed" : "deleting",
        );
        if (status === "deleted")
          await s.namespaces.markNamespaceDeleted(resources.namespace.id, new Date().toISOString());
      });
    await assert.rejects(
      write((r) => r.createConfiguration(resources.configuration)),
      {
        name: "ScopeViolationError",
        message: "The Configuration belongs to an unavailable Namespace.",
      },
    );
  }
  // Deletion of an assigned Configuration is guarded by the actual Agent reference.
  await store.transact((s) => s.agents.createAgent(owner.agent));
  await assert.rejects(
    write((r) => r.deleteConfiguration(namespaceId, id)),
    ScopeViolationError,
  );
  const replacement = { ...owner.configuration, id: `cfg_${randomUUID()}` };
  await store.transact(async (s) => {
    await s.configurations.createConfiguration(replacement);
    await s.agents.updateConfiguration(namespaceId, owner.agent.id, replacement.id);
    assert.equal(await s.configurations.deleteConfiguration(namespaceId, id), true);
    assert.equal(await s.configurations.deleteConfiguration(namespaceId, id), false);
  });
  // Namespace deletion begins only after its unassigned Configuration is removed.
  // The tombstone fixture therefore follows the supported empty-Namespace lifecycle.
  await store.transact(async (s) => {
    assert.equal(
      await s.configurations.deleteConfiguration(foreign.namespace.id, foreign.configuration.id),
      true,
    );
    await s.namespaces.transitionNamespaceStatus(foreign.namespace.id, "provisioning", "deleting");
    await s.namespaces.markNamespaceDeleted(foreign.namespace.id, new Date().toISOString());
    assert.equal(
      await s.configurations.findConfiguration(foreign.namespace.id, foreign.configuration.id),
      undefined,
    );
  });
}

export async function verifyConfigurationRepositoryBindings(store) {
  await seedConfigurationInstallation(store);
  const owner = configurationResources();
  const foreign = configurationResources();
  await store.transact(async (s) => {
    for (const resources of [owner, foreign]) {
      await s.namespaces.createNamespace(resources.namespace);
      await s.secrets.createSecret(resources.secret);
    }
  });
  const expectedBindings = {
    ...configurationBindings(owner.secret),
    ...configurationBindings(owner.secret, "OPENAI_API_KEY"),
  };
  const providedBindings = structuredClone(expectedBindings);
  delete providedBindings.SERVICE_TOKEN.delivery;
  const input = { ...owner.configuration, secretBindings: providedBindings };
  const created = await store.transact((s) => s.configurations.createConfiguration(input));
  const expected = { ...owner.configuration, secretBindings: expectedBindings };
  assert.deepEqual(created, expected);
  for (const value of [
    created,
    created.secretBindings,
    created.secretBindings.SERVICE_TOKEN,
    created.secretBindings.SERVICE_TOKEN.source,
    created.secretBindings.SERVICE_TOKEN.delivery,
  ])
    assert.ok(Object.isFrozen(value));
  providedBindings.SERVICE_TOKEN.source.id = `sec_${randomUUID()}`;
  assert.deepEqual(
    await store.read((s) =>
      s.configurations.findConfiguration(owner.namespace.id, owner.configuration.id),
    ),
    expected,
  );
  const unavailable = { ...owner.secret, id: `sec_${randomUUID()}` };
  const invalidBindings = [
    configurationBindings(unavailable),
    configurationBindings(foreign.secret),
    configurationBindings(owner.secret, "PATH"),
    configurationBindings(owner.secret, "CODEX_TOKEN"),
    { SERVICE_TOKEN: { source: { ...expectedBindings.SERVICE_TOKEN.source, kind: "agent" } } },
  ];
  for (const secretBindings of invalidBindings) {
    await assert.rejects(
      store.transact((s) =>
        s.configurations.createConfiguration({
          ...owner.configuration,
          id: `cfg_${randomUUID()}`,
          secretBindings,
        }),
      ),
      ScopeViolationError,
    );
    await assert.rejects(
      store.transact((s) =>
        s.configurations.advanceConfigurationGeneration(
          owner.namespace.id,
          owner.configuration.id,
          1,
          secretBindings,
        ),
      ),
      ScopeViolationError,
    );
    assert.deepEqual(
      await store.read((s) =>
        s.configurations.findConfiguration(owner.namespace.id, owner.configuration.id),
      ),
      expected,
    );
  }
  await store.transact(async (s) => {
    assert.equal(await s.secrets.hasReferences(owner.namespace.id, owner.secret.id), true);
    assert.deepEqual(
      await s.configurations.advanceConfigurationGeneration(
        owner.namespace.id,
        owner.configuration.id,
        0,
        invalidBindings[0],
      ),
      undefined,
    );
    const preserved = await s.configurations.advanceConfigurationGeneration(
      owner.namespace.id,
      owner.configuration.id,
      1,
    );
    assert.deepEqual(preserved, { ...expected, generation: 2 });
  });
  await assert.rejects(
    store.transact((s) => s.secrets.deleteSecret(owner.namespace.id, owner.secret.id)),
    ScopeViolationError,
  );
  await store.transact(async (s) => {
    const cleared = await s.configurations.advanceConfigurationGeneration(
      owner.namespace.id,
      owner.configuration.id,
      2,
      {},
    );
    assert.deepEqual(cleared, { ...owner.configuration, generation: 3 });
    assert.equal(Object.hasOwn(cleared, "secretBindings"), false);
    assert.equal(await s.secrets.hasReferences(owner.namespace.id, owner.secret.id), false);
    assert.equal(await s.secrets.deleteSecret(owner.namespace.id, owner.secret.id), true);
    const empty = await s.configurations.createConfiguration({
      ...owner.configuration,
      id: `cfg_${randomUUID()}`,
      secretBindings: {},
    });
    assert.equal(Object.hasOwn(empty, "secretBindings"), false);
  });
  await assert.rejects(
    store.transact((s) =>
      s.configurations.advanceConfigurationGeneration(
        owner.namespace.id,
        owner.configuration.id,
        3,
        expectedBindings,
      ),
    ),
    {
      name: "ScopeViolationError",
      message: "Secret bindings reference unavailable Secret metadata.",
    },
  );
}

export async function verifyConfigurationRepositoryGenerations(store) {
  await seedConfigurationInstallation(store);
  const { namespace, configuration } = configurationResources();
  const maximum = {
    ...configuration,
    id: `cfg_${randomUUID()}`,
    generation: Number.MAX_SAFE_INTEGER,
  };
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(namespace);
    await s.configurations.createConfiguration(configuration);
    await s.configurations.createConfiguration(maximum);
  });
  // Separate transactions exercise the memory writer gate and PostgreSQL row lock.
  // A second operation in one callback would not prove inter-transaction CAS.
  const results = await Promise.all([
    store.transact((s) =>
      s.configurations.advanceConfigurationGeneration(namespace.id, configuration.id, 1),
    ),
    store.transact((s) =>
      s.configurations.advanceConfigurationGeneration(namespace.id, configuration.id, 1),
    ),
  ]);
  assert.deepEqual(results.filter(Boolean), [{ ...configuration, generation: 2 }]);
  assert.equal(results.filter((value) => value === undefined).length, 1);
  const rollback = new Error("rollback Configuration generation");
  await assert.rejects(
    store.transact(async (s) => {
      assert.equal(
        (await s.configurations.advanceConfigurationGeneration(namespace.id, configuration.id, 2))
          .generation,
        3,
      );
      throw rollback;
    }),
    (error) => error === rollback,
  );
  await assert.rejects(
    store.transact((s) =>
      s.configurations.advanceConfigurationGeneration(namespace.id, maximum.id, maximum.generation),
    ),
    ScopeViolationError,
  );
  await store.read(async (s) => {
    assert.deepEqual(await s.configurations.findConfiguration(namespace.id, configuration.id), {
      ...configuration,
      generation: 2,
    });
    assert.deepEqual(await s.configurations.findConfiguration(namespace.id, maximum.id), maximum);
  });
}

export async function verifyConfigurationRepositoryLifetime(store) {
  await seedConfigurationInstallation(store);
  for (const commit of [true, false]) {
    const { namespace, configuration, secret, agent } = configurationResources();
    const bound = { ...configuration, secretBindings: configurationBindings(secret) };
    let retained;
    let accepted;
    const rollback = new Error("rollback accepted cross-domain Configuration operations");
    const result = store.transact(async (s) => {
      retained = s.configurations;
      await s.namespaces.createNamespace(namespace);
      await s.secrets.createSecret(secret);
      await retained.createConfiguration(bound);
      // Callback return closes outward admission while these accepted operations
      // still await their raw Configuration and Secret collaborators.
      accepted = Promise.allSettled([
        retained.advanceConfigurationGeneration(namespace.id, configuration.id, 1),
        s.agents.createAgent(agent),
      ]);
      if (!commit) throw rollback;
    });
    if (commit) await result;
    else await assert.rejects(result, (error) => error === rollback);
    assert.deepEqual(await accepted, [
      { status: "fulfilled", value: { ...bound, generation: 2 } },
      { status: "fulfilled", value: agent },
    ]);
    // Aggregate mutations close at the outer lifecycle admission boundary.
    await assertConfigurationRepositoryClosed(
      retained,
      configuration,
      true,
      "The lifecycle transaction is closed.",
    );
    let read;
    await store.read(async (s) => {
      read = s.configurations;
      assert.deepEqual(Object.keys(read), ["findConfiguration"]);
      assert.deepEqual(
        await read.findConfiguration(namespace.id, configuration.id),
        commit ? { ...bound, generation: 2 } : undefined,
      );
      assert.deepEqual(
        await s.agents.findAgent(namespace.id, agent.id),
        commit ? agent : undefined,
      );
      assert.deepEqual(
        await s.secrets.findSecret(namespace.id, secret.id),
        commit ? secret : undefined,
      );
    });
    await assertConfigurationRepositoryClosed(read, configuration, false);
  }
}

export async function verifyConfigurationRepositoryAtomicity(store) {
  const installation = await seedConfigurationInstallation(store);
  for (const outcome of ["commit", "callback failure", "audit failure"]) {
    const { namespace, configuration, secret, agent } = configurationResources();
    const bound = { ...configuration, secretBindings: configurationBindings(secret) };
    const audit = {
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: namespace.id,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: "configuration-storage-test",
      action: "create",
      resource: { kind: "configuration", id: configuration.id, namespaceId: namespace.id },
      outcome: "success",
    };
    const operation = {
      kind: "namespace",
      action: "reconcile",
      target: "ready",
      namespaceId: namespace.id,
      resourceId: namespace.id,
      actorId: audit.actorId,
    };
    const rollback = new Error("rollback Configuration Secret Agent audit and work");
    const result = store.transact(async (s) => {
      await s.namespaces.createNamespace(namespace);
      await s.secrets.createSecret(secret);
      await s.configurations.createConfiguration(bound);
      await s.agents.createAgent(agent);
      await s.operations.append(operation);
      await s.audit.append(audit);
      if (outcome === "audit failure")
        await s.audit.append({
          ...audit,
          id: `aud_${randomUUID()}`,
          installationId: `ins_${randomUUID()}`,
        });
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
        await s.secrets.findSecret(namespace.id, secret.id),
        commit ? secret : undefined,
      );
      assert.deepEqual(
        await s.configurations.findConfiguration(namespace.id, configuration.id),
        commit ? bound : undefined,
      );
      assert.deepEqual(
        await s.agents.findAgent(namespace.id, agent.id),
        commit ? agent : undefined,
      );
      assert.deepEqual(
        (await s.audit.list()).filter((event) => event.id === audit.id),
        commit ? [audit] : [],
      );
      assert.deepEqual(
        (await s.operations.list()).filter((item) => item.resourceId === namespace.id),
        commit ? [operation] : [],
      );
    });
  }
}
