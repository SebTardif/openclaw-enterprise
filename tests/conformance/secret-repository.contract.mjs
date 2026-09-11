import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/errors.ts";
import {
  configurationResources,
  configurationBindings,
  seedConfigurationInstallation,
} from "./configuration-repository.contract.mjs";
import { seedAuthority, writer } from "../fixtures/runtime-authority-state/seed.mjs";

export {
  configurationResources as secretResources,
  seedConfigurationInstallation as seedSecretInstallation,
};

export function secretRevision({ configuration, agent, secret }, revision = 1) {
  return {
    id: `rev_${randomUUID()}`,
    namespaceId: agent.namespaceId,
    agentId: agent.id,
    revision,
    configurationId: configuration.id,
    configurationKind: configuration.kind,
    configurationGeneration: configuration.generation,
    providerId: agent.providerId,
    configuration: { models: { providers: { openai: {} } } },
    harness: { id: "openclaw", version: "1.0.0", mode: agent.executionMode },
    maximumExecutionMs: null,
    compute: { id: "compute-test", implementation: "deterministic-test" },
    servicePrincipalId: agent.servicePrincipalId,
    ...(secret
      ? { secretDriverId: secret.driverId, secretBindings: configurationBindings(secret) }
      : {}),
    createdAt: new Date().toISOString(),
  };
}

export function secretRevisionWork(revision) {
  return {
    kind: "agent_revision",
    action: "reconcile",
    namespaceId: revision.namespaceId,
    resourceId: revision.id,
    actorId: "secret-repository-test",
  };
}

function secretAudit(installation, secret, action = "create") {
  return {
    id: `aud_${randomUUID()}`,
    installationId: installation.id,
    namespaceId: secret.namespaceId,
    occurredAt: new Date().toISOString(),
    kind: "mutation",
    actorId: "secret-repository-test",
    action,
    resource: { kind: "secret", id: secret.id, namespaceId: secret.namespaceId },
    outcome: "success",
  };
}

export async function assertSecretRepositoryClosed(
  repository,
  secret,
  writable = true,
  closedMessage = "The platform transaction is closed.",
) {
  const { namespaceId, id } = secret;
  const operations = [() => repository.findSecret(namespaceId, id)];
  if (writable)
    operations.push(
      () => repository.lockSecret(namespaceId, id),
      () => repository.createSecret(secret),
      () => repository.hasReferences(namespaceId, id),
      () => repository.deleteSecret(namespaceId, id),
    );
  for (const operation of operations)
    await assert.rejects(operation(), (error) => {
      assert.ok(error instanceof ScopeViolationError);
      assert.equal(error.message, closedMessage);
      return true;
    });
}

/** Requires an empty store; the same-unit bootstrap and its children roll back. */
export async function verifySecretBootstrap(store) {
  assert.equal(await store.read((s) => s.installations.getInstallation()), undefined);
  const { namespace, secret, configuration } = configurationResources();
  const installation = {
    id: `ins_${randomUUID()}`,
    name: "Secret repository bootstrap",
    createdAt: namespace.createdAt,
  };
  const rollback = new Error("rollback Secret bootstrap");
  let retained;
  await assert.rejects(
    store.transact(async (s) => {
      retained = s.secrets;
      assert.equal(await retained.findSecret(namespace.id, secret.id), undefined);
      assert.equal(await retained.lockSecret(namespace.id, secret.id), undefined);
      assert.equal(await retained.hasReferences(namespace.id, secret.id), false);
      assert.equal(await retained.deleteSecret(namespace.id, secret.id), false);
      await assert.rejects(retained.createSecret(secret), {
        name: "ScopeViolationError",
        message: "The server-owned Installation has not been initialized.",
      });
      // Retained repositories predate the singleton and must resolve its live scope.
      await s.installations.createInstallation(installation);
      await s.namespaces.createNamespace(namespace);
      assert.deepEqual(await retained.createSecret(secret), secret);
      await s.configurations.createConfiguration({
        ...configuration,
        secretBindings: configurationBindings(secret),
      });
      assert.equal(await retained.hasReferences(namespace.id, secret.id), true);
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
  await assertSecretRepositoryClosed(
    retained,
    secret,
    true,
    "The lifecycle transaction is closed.",
  );
}

export async function verifySecretMetadata(store) {
  await seedConfigurationInstallation(store);
  const owner = configurationResources();
  const foreign = configurationResources();
  const expected = structuredClone(owner.secret);
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(owner.namespace);
    await s.namespaces.createNamespace(foreign.namespace);
    const created = await s.secrets.createSecret(owner.secret);
    assert.deepEqual(created, expected);
    assert.deepEqual(Object.keys(created).sort(), [
      "backendRef",
      "createdAt",
      "driverId",
      "id",
      "name",
      "namespaceId",
    ]);
    assert.ok(Object.isFrozen(created));
    assert.ok(Object.isFrozen(created.backendRef));
    // Equal names in distinct Namespaces remain independent metadata identities.
    await s.secrets.createSecret({ ...foreign.secret, name: expected.name });
  });
  owner.secret.backendRef.uid = randomUUID();
  owner.secret.name = "changed caller object";
  assert.deepEqual(
    await store.read((s) => s.secrets.findSecret(owner.namespace.id, expected.id)),
    expected,
  );
  const write = (work) => store.transact((s) => work(s.secrets));
  assert.deepEqual(await write((r) => r.lockSecret(owner.namespace.id, expected.id)), expected);
  for (const candidate of [
    expected,
    { ...expected, namespaceId: foreign.namespace.id, name: `unique-${randomUUID()}` },
    { ...expected, id: `sec_${randomUUID()}` },
  ])
    await assert.rejects(
      write((r) => r.createSecret(candidate)),
      ResourceConflictError,
    );
  assert.equal(
    await store.read((s) => s.secrets.findSecret(foreign.namespace.id, expected.id)),
    undefined,
  );
  assert.equal(await write((r) => r.lockSecret(foreign.namespace.id, expected.id)), undefined);
  assert.equal(await write((r) => r.hasReferences(foreign.namespace.id, expected.id)), false);
  assert.equal(await write((r) => r.deleteSecret(foreign.namespace.id, expected.id)), false);
  assert.equal(await write((r) => r.hasReferences(owner.namespace.id, expected.id)), false);
  assert.equal(await write((r) => r.deleteSecret(owner.namespace.id, expected.id)), true);
  assert.equal(await write((r) => r.deleteSecret(owner.namespace.id, expected.id)), false);
  // Only this now-empty Namespace enters deletion; no live child is placed under a tombstone.
  await store.transact(async (s) => {
    await s.namespaces.transitionNamespaceStatus(owner.namespace.id, "ready", "deleting");
    await s.namespaces.markNamespaceDeleted(owner.namespace.id, new Date().toISOString());
    assert.equal(await s.secrets.findSecret(owner.namespace.id, expected.id), undefined);
  });
}

export async function verifySecretValidation(store) {
  await seedConfigurationInstallation(store);
  const { namespace, secret } = configurationResources();
  await store.transact((s) => s.namespaces.createNamespace(namespace));
  // Each shared negative changes one ASCII field; backend-specific extra-key,
  // Unicode length and validation-order behavior is not silently unified here.
  for (const invalid of [
    { id: "sec_invalid" },
    { name: " padded " },
    { driverId: "" },
    ...[
      { namespaceName: "Invalid_Name" },
      { name: "Invalid_Name" },
      { key: ".." },
      { uid: "invalid" },
    ].map((field) => ({ backendRef: { ...secret.backendRef, ...field } })),
  ])
    await assert.rejects(
      store.transact((s) => s.secrets.createSecret({ ...secret, ...invalid })),
      ScopeViolationError,
    );
  for (const status of ["failed", "deleting", "deleted", "missing"]) {
    const empty = configurationResources({ status: "provisioning" });
    if (status !== "missing")
      await store.transact(async (s) => {
        await s.namespaces.createNamespace(empty.namespace);
        await s.namespaces.transitionNamespaceStatus(
          empty.namespace.id,
          "provisioning",
          status === "failed" ? "failed" : "deleting",
        );
        if (status === "deleted")
          await s.namespaces.markNamespaceDeleted(empty.namespace.id, new Date().toISOString());
      });
    await assert.rejects(
      store.transact((s) => s.secrets.createSecret(empty.secret)),
      {
        name: "ScopeViolationError",
        message: "The Secret belongs to an unavailable Namespace.",
      },
    );
  }
}

export async function verifySecretConfigurationReferences(store) {
  await seedConfigurationInstallation(store);
  const { namespace, secret, configuration } = configurationResources();
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(namespace);
    await s.secrets.createSecret(secret);
    await s.configurations.createConfiguration({
      ...configuration,
      secretBindings: configurationBindings(secret),
    });
    assert.equal(await s.secrets.hasReferences(namespace.id, secret.id), true);
  });
  await assert.rejects(
    store.transact((s) => s.secrets.deleteSecret(namespace.id, secret.id)),
    {
      name: "ScopeViolationError",
      message: "The Secret is referenced by active platform state.",
    },
  );
  await store.transact(async (s) => {
    // No Agent or revision exists: the unassigned current Configuration is the sole blocker.
    await s.configurations.advanceConfigurationGeneration(namespace.id, configuration.id, 1, {});
    assert.equal(await s.secrets.hasReferences(namespace.id, secret.id), false);
    assert.equal(await s.secrets.deleteSecret(namespace.id, secret.id), true);
  });
}

export async function verifySecretRevisionReferences(store) {
  await seedConfigurationInstallation(store);
  const resources = configurationResources();
  const { namespace, secret, configuration, agent } = resources;
  const active = secretRevision(resources);
  const replacement = secretRevision({ configuration, agent }, 2);
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(namespace);
    await s.secrets.createSecret(secret);
    await s.configurations.createConfiguration(configuration);
    await s.agents.createAgent(agent);
    await s.revisions.createRevision(active);
    assert.equal(
      await s.secrets.hasReferences(namespace.id, secret.id),
      false,
      "historical revision alone is not a reference",
    );
    assert.ok(
      await s.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, active.id),
    );
    assert.equal(await s.secrets.hasReferences(namespace.id, secret.id), true);
  });
  await assert.rejects(
    store.transact((s) => s.secrets.deleteSecret(namespace.id, secret.id)),
    ScopeViolationError,
  );
  await store.transact(async (s) => {
    // No work was appended for this revision, so exact active-pointer cutover releases its Secret.
    await s.revisions.createRevision(replacement);
    assert.ok(
      await s.agents.compareAndSetActiveRevision(namespace.id, agent.id, active.id, replacement.id),
    );
    assert.deepEqual(await s.revisions.findRevision(namespace.id, agent.id, active.id), active);
    assert.equal(await s.secrets.hasReferences(namespace.id, secret.id), false);
    assert.equal(await s.secrets.deleteSecret(namespace.id, secret.id), true);
  });
}

export async function verifySecretPendingReferences(store) {
  await seedConfigurationInstallation(store);
  const resources = configurationResources();
  const { namespace, secret, configuration, agent } = resources;
  const revision = secretRevision(resources);
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(namespace);
    await s.secrets.createSecret(secret);
    await s.configurations.createConfiguration(configuration);
    await s.agents.createAgent(agent);
    await s.revisions.createRevision(revision);
    assert.equal(await s.secrets.hasReferences(namespace.id, secret.id), false);
    // Configuration is unbound and Agent has no active pointer: only the actual
    // appended operation (queued work in PostgreSQL) can make this reference true.
    await s.operations.append(secretRevisionWork(revision));
    assert.equal(await s.secrets.hasReferences(namespace.id, secret.id), true);
  });
  await assert.rejects(
    store.transact((s) => s.secrets.deleteSecret(namespace.id, secret.id)),
    ScopeViolationError,
  );
}

export async function verifySecretLifetime(store) {
  await seedConfigurationInstallation(store);
  for (const scenario of ["create", "downstream", "delete"])
    for (const commit of [true, false]) {
      const { namespace, secret, configuration, agent } = configurationResources();
      const bound = { ...configuration, secretBindings: configurationBindings(secret) };
      const rollback = new Error("rollback admitted Secret work");
      let retained;
      let admitted;
      if (scenario === "delete")
        await store.transact(async (s) => {
          await s.namespaces.createNamespace(namespace);
          await s.secrets.createSecret(secret);
        });
      const result = store.transact(async (s) => {
        retained = s.secrets;
        if (scenario !== "delete") await s.namespaces.createNamespace(namespace);
        if (scenario === "create") admitted = Promise.allSettled([retained.createSecret(secret)]);
        else if (scenario === "delete") {
          // Deletion must finish its awaited raw find/reference checks after the
          // callback closes outward admissions, for both commit and rollback.
          admitted = Promise.allSettled([retained.deleteSecret(namespace.id, secret.id)]);
        } else {
          await retained.createSecret(secret);
          await s.configurations.createConfiguration(bound);
          // Prerequisites are established before these accepted calls outlive the
          // callback and await their raw Secret/Configuration/Namespace collaborators.
          admitted = Promise.allSettled([
            s.configurations.advanceConfigurationGeneration(namespace.id, configuration.id, 1),
            s.agents.createAgent(agent),
          ]);
        }
        if (!commit) throw rollback;
      });
      if (commit) await result;
      else await assert.rejects(result, (error) => error === rollback);
      assert.deepEqual(
        await admitted,
        { create: [secret], downstream: [{ ...bound, generation: 2 }, agent], delete: [true] }[
          scenario
        ].map((value) => ({
          status: "fulfilled",
          value,
        })),
      );
      // Aggregate mutations close at the outer lifecycle admission boundary.
      await assertSecretRepositoryClosed(
        retained,
        secret,
        true,
        "The lifecycle transaction is closed.",
      );
      let read;
      const secretRemains = scenario === "delete" ? !commit : commit;
      await store.read(async (s) => {
        read = s.secrets;
        assert.deepEqual(Object.keys(read), ["findSecret"]);
        assert.deepEqual(
          await read.findSecret(namespace.id, secret.id),
          secretRemains ? secret : undefined,
        );
        assert.deepEqual(
          await s.agents.findAgent(namespace.id, agent.id),
          commit && scenario === "downstream" ? agent : undefined,
        );
        assert.deepEqual(
          await s.configurations.findConfiguration(namespace.id, configuration.id),
          commit && scenario === "downstream" ? { ...bound, generation: 2 } : undefined,
        );
      });
      await assertSecretRepositoryClosed(read, secret, false);
    }

  const { namespace, secret } = configurationResources();
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(namespace);
    await s.secrets.createSecret(secret);
  });
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let retained;
  const reading = store.read(
    async (s) => {
      retained = s.secrets;
      assert.deepEqual(await retained.findSecret(namespace.id, secret.id), secret);
      entered.resolve();
      await release.promise;
    },
    { signal: controller.signal, timeoutMs: 3000 },
  );
  reading.catch((error) => entered.reject(error));
  try {
    await entered.promise;
    // Actual owner cancellation revokes the read while its callback is still
    // waiting. This is caller cancellation, not a simulated database lease loss.
    controller.abort();
    await assert.rejects(reading, DependencyUnavailableError);
    await assertSecretRepositoryClosed(retained, secret, false);
    assert.deepEqual(
      await store.read((s) => s.secrets.findSecret(namespace.id, secret.id)),
      secret,
    );
  } finally {
    release.resolve();
    await Promise.allSettled([reading]);
  }
}

async function writeBundle(s, resources, audit, revision) {
  await s.namespaces.createNamespace(resources.namespace);
  await s.secrets.createSecret(resources.secret);
  await s.configurations.createConfiguration({
    ...resources.configuration,
    secretBindings: configurationBindings(resources.secret),
  });
  await s.agents.createAgent(resources.agent);
  await s.revisions.createRevision(revision);
  await s.operations.append(secretRevisionWork(revision));
  await s.audit.append(audit);
}

async function assertBundle(store, resources, audit, revision, committed) {
  const { namespace, secret, configuration, agent } = resources;
  await store.read(async (s) => {
    assert.deepEqual(
      await s.namespaces.findNamespace(namespace.id),
      committed ? namespace : undefined,
    );
    assert.deepEqual(
      await s.secrets.findSecret(namespace.id, secret.id),
      committed ? secret : undefined,
    );
    assert.deepEqual(
      await s.configurations.findConfiguration(namespace.id, configuration.id),
      committed ? { ...configuration, secretBindings: configurationBindings(secret) } : undefined,
    );
    assert.deepEqual(
      await s.agents.findAgent(namespace.id, agent.id),
      committed ? agent : undefined,
    );
    assert.deepEqual(
      await s.revisions.findRevision(namespace.id, agent.id, revision.id),
      committed ? revision : undefined,
    );
    assert.deepEqual(
      (await s.audit.list()).filter((event) => event.id === audit.id),
      committed ? [audit] : [],
    );
    assert.deepEqual(
      (await s.operations.list()).filter((operation) => operation.resourceId === revision.id),
      committed ? [secretRevisionWork(revision)] : [],
    );
  });
}

export async function verifySecretAtomicity(store) {
  const installation = await seedConfigurationInstallation(store);
  for (const outcome of ["commit", "callback failure", "audit rejection"]) {
    const resources = configurationResources();
    const revision = secretRevision(resources);
    const audit = secretAudit(installation, resources.secret);
    const rollback = new Error("rollback Secret and sibling state");
    const result = store.transact(async (s) => {
      await writeBundle(s, resources, audit, revision);
      // The real audit ownership check rejects before INSERT; its uncaught
      // validation failure must roll back all earlier writes in this unit.
      if (outcome === "audit rejection")
        await s.audit.append({
          ...audit,
          id: `aud_${randomUUID()}`,
          installationId: `ins_${randomUUID()}`,
        });
      if (outcome === "callback failure") throw rollback;
    });
    if (outcome === "commit") await result;
    else
      await assert.rejects(
        result,
        outcome === "callback failure" ? (error) => error === rollback : ScopeViolationError,
      );
    await assertBundle(store, resources, audit, revision, outcome === "commit");
  }
  const { namespace, secret } = configurationResources();
  const audit = secretAudit(installation, secret, "delete");
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(namespace);
    await s.secrets.createSecret(secret);
  });
  const rollback = new Error("rollback Secret deletion and audit");
  await assert.rejects(
    store.transact(async (s) => {
      assert.equal(await s.secrets.deleteSecret(namespace.id, secret.id), true);
      await s.audit.append(audit);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  await store.read(async (s) => {
    assert.deepEqual(await s.secrets.findSecret(namespace.id, secret.id), secret);
    assert.equal(
      (await s.audit.list()).some((event) => event.id === audit.id),
      false,
    );
  });
}

export async function verifySecretPoisonRollback(store) {
  // This established fixture exercises persistence authority only, not service
  // authentication, provider observation, runtime execution or a synthetic poison flag.
  const owner = await seedAuthority(store);
  const before = await owner.record();
  const resources = configurationResources();
  const revision = secretRevision(resources);
  const audit = secretAudit(owner.installation, resources.secret);
  const invalidRevision = `rev_${randomUUID()}`;
  let callbackReturned = false;
  await assert.rejects(
    store.transact(async (s) => {
      await writeBundle(s, resources, audit, revision);
      await s.runtimeAuthority.appendMutation(owner.bind, writer);
      await assert.rejects(
        s.runtimeAuthority.appendMutation(
          {
            ...owner.evidence,
            target: { ...owner.target, revisionId: invalidRevision },
            evidence: {
              ...owner.evidence.evidence,
              target: { ...owner.target, revisionId: invalidRevision },
            },
          },
          writer,
        ),
        { name: "ScopeViolationError", message: "The runtime authority target is unavailable." },
      );
      // Callback returns normally after handling the authority error. The actual
      // authority guard must still reject the entire enclosing commit.
      callbackReturned = true;
    }),
    { name: "ScopeViolationError", message: "The runtime authority target is unavailable." },
  );
  assert.equal(
    callbackReturned,
    true,
    "ordinary callback failure must not stand in for authority poison",
  );
  await assertBundle(store, resources, audit, revision, false);
  assert.deepEqual(await owner.record(), before);
  assert.equal(await owner.operation(owner.bind.operationRef), undefined);
}

export const secretStoreCases = [
  ["round-trips immutable metadata and exact Namespace identity", verifySecretMetadata],
  ["preserves metadata constraints and empty Namespace lifecycle", verifySecretValidation],
  [
    "blocks current Configuration references and releases cleared bindings",
    verifySecretConfigurationReferences,
  ],
  [
    "distinguishes active revisions from retained historical revisions",
    verifySecretRevisionReferences,
  ],
  ["retains appended revision-work references", verifySecretPendingReferences],
  [
    "drains accepted create/delete and cross-domain calls and revokes cancelled reads",
    verifySecretLifetime,
  ],
  [
    "commits and rolls back Secret, Configuration, Agent, revision, audit and work together",
    verifySecretAtomicity,
  ],
  [
    "rolls back Secret and sibling writes after a caught authority failure",
    verifySecretPoisonRollback,
  ],
];
